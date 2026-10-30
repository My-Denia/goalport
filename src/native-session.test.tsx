// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import App from "./App";
import { getCoreClient, resetCoreClientForTests } from "./ipc";
import { DEMO_SNAPSHOT, resolveCoreSnapshot, normalizeProductConversation, type CoreSnapshot } from "./types";
import { DraftGoalComposer } from "./conversation/DraftGoalComposer";
import { SessionDetails } from "./panels/SessionDetails";
import { isNativeDraftRoute, replaceGoalRoute } from "./lib/goalRoute";

afterEach(() => { cleanup(); resetCoreClientForTests(); delete window.__GOALPORT_LINUX_CORE__; delete window.goalportCore; sessionStorage.clear(); vi.unstubAllGlobals(); window.history.replaceState(null, "", "/"); });
const reply = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const packet = (active = false): CoreSnapshot => ({ ...DEMO_SNAPSHOT, preview: false, connection: "connected", activeCampaignId: active ? "campaign-native" : "", campaigns: active ? [{ ...DEMO_SNAPSHOT.campaigns[0], id:"campaign-native", title:"Native goal" }] : [],
  project: { ...DEMO_SNAPSHOT.project, workspaceRoot: "/fixture/native" }, activeTask: { ...DEMO_SNAPSHOT.activeTask, id:"task-native", title:"Native goal" },
  attempt: { ...DEMO_SNAPSHOT.attempt, id: "attempt-native", provider:"codex", state:"active" }, decisions:[], notices:[],
  runtimes: DEMO_SNAPSHOT.runtimes.map(item => ({ ...item, nativeSessionTransport: item.id === "codex" ? "app-server" : "unknown" })),
  productConversation: { ...DEMO_SNAPSHOT.productConversation!, title:"Native goal", items:[], runtime:{ state:"selected", provider:"codex", name:"Codex" }, session:{ state:"attached", nativeIdKnown:true, transport:"app-server" }, turn:{ state:"completed", canSend:true, canStop:false, actions:["close-session"] } }
});
function server(options: { unknownStart?: boolean; delayedStart?: Promise<Response> } = {}) {
  const calls: Array<{messageType:string; payload:Record<string,unknown>; requestId:string; nativeTarget?:unknown}> = [];
  let current = packet();
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); calls.push(body);
    if (body.messageType === "coordination_latest") return reply({ ok:true, payload:{ record:null, roots:[], profileUnconfirmed:false, leftoverHeld:false, line:null, currentBase:null, globalSlot:{kind:"empty"} } });
    if (body.messageType === "coordination_discover") return reply({ ok:true, payload:{ consentMissing:true, harnesses:[], sentence:"Pi unavailable" } });
    if (body.messageType === "goal_overview") return reply({ ok:true, payload:{ overview:{ revision:"fixture", truncated:false, goals:[], pending:[] } } });
    if (body.messageType === "start_conversation") {
      if (options.delayedStart) return options.delayedStart;
      if (options.unknownStart) throw Error("synthetic lost reply");
      current = packet(true);
    }
    return reply({ protocolVersion:"goalport.ipc.v2", requestId:body.requestId, ok:true, payload:{ requestId:body.requestId, accepted:true, unchanged:false, revision:"s", snapshot:current } });
  }));
  return { calls };
}
async function chooseNative() {
  const picker = await screen.findByRole("combobox", { name:"Choose goal mode" }); fireEvent.click(picker);
  const native = await screen.findByRole("option", { name:/Codex conversation/ });
  fireEvent.keyDown(native, {key:"Enter"});
  await waitFor(() => expect(window.location.hash).toBe("#codex/new"));
}

it("normalizes missing/null/unrecognized configured and actual transport to unknown, never guesses from a native id", () => {
  for (const value of [undefined, null, "unrecognized", false, 1, "exec", "app-server"]) {
    const expected = value === "exec" || value === "app-server" ? value : "unknown";
    const raw = packet(true); const runtime = { ...raw.runtimes[0], id:"codex", nativeSessionTransport:value };
    const normalized = resolveCoreSnapshot({ ...raw, runtimes:[runtime] })!;
    expect(normalized.runtimes[0].nativeSessionTransport).toBe(expected);
    expect(normalizeProductConversation({ ...raw.productConversation, session:{state:"detached", nativeIdKnown:true, transport:value} })?.session?.transport).toBe(expected);
  }
});

it("Linux entry exposes exactly coordinated work + qualified Codex, and old Core never exposes Claude/Grok or native starts", async () => {
  const base = packet();
  const props = { draft:{workspace:"/fixture", provider:"", message:""}, runtimes:base.runtimes, connected:true, busy:false, blockedFromSending:false, waitingOn:null, error:null, canBrowse:false, coordinationAvailable:false, linuxCanStartCoordination:true, linuxEntry:true, onBrowse:vi.fn(), onChange:vi.fn(), onSubmit:vi.fn(), onDiscard:vi.fn() };
  const view = render(<DraftGoalComposer {...props} />);
  fireEvent.click(screen.getByRole("combobox", { name:"Choose goal mode" }));
  expect((await screen.findAllByRole("option")).map(el => el.textContent)).toEqual([expect.stringContaining("Coordinated work"), expect.stringContaining("Codex conversation")]);
  view.unmount();
  render(<DraftGoalComposer {...props} runtimes={base.runtimes.map(item => ({...item, nativeSessionTransport:undefined}))} />);
  fireEvent.click(screen.getByRole("combobox", { name:"Choose goal mode" }));
  expect((await screen.findAllByRole("option")).length).toBe(1);
  expect(screen.queryByRole("option", {name:/Claude|Grok|Codex/})).toBeNull();
});

it("native draft uses no Pi/background gate, refuses ~ locally, preserves input focus/IME, and starts exactly once with the literal constraint", async () => {
  window.__GOALPORT_LINUX_CORE__ = true; window.history.replaceState(null,"","/#coordinated/new");
  const f = server(); render(<App />); await chooseNative();
  const input = screen.getByRole("textbox", {name:"Message composer"}); const folder = screen.getByLabelText("Project folder");
  fireEvent.change(folder, {target:{value:"~/project"}}); fireEvent.change(input, {target:{value:"Synthetic native goal"}});
  fireEvent.submit(input.closest("form")!);
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("Codex conversations need an absolute folder path"));
  expect(f.calls.filter(c => c.messageType === "start_conversation")).toHaveLength(0);
  expect(input).toHaveProperty("value", "Synthetic native goal");
  fireEvent.change(folder, {target:{value:"/fixture/native"}});
  fireEvent.compositionStart(input); fireEvent.keyDown(input, {key:"Enter", isComposing:true});
  expect(f.calls.filter(c => c.messageType === "start_conversation")).toHaveLength(0);
  fireEvent.compositionEnd(input);
  fireEvent.submit(input.closest("form")!);
  await waitFor(() => expect(window.location.pathname).toBe("/goals/campaign-native"));
  expect(window.location.hash).toBe("");
  const starts = f.calls.filter(c => c.messageType === "start_conversation"); expect(starts).toHaveLength(1);
  expect(starts[0].payload).toEqual({workspaceRoot:"/fixture/native", provider:"codex", message:"Synthetic native goal", requireNativeSession:true});
  expect(screen.getByRole("textbox", {name:"Message composer"})).toBeTruthy();
  expect(screen.getByText("Codex app-server · native conversation context")).toBeTruthy();
  expect(f.calls.filter(c => ["coordination_start", "coordination_grant", "coordination_continue", "resume_native_session"].includes(c.messageType))).toHaveLength(0);
});

it("native #codex/new survives polling and an ambiguous start keeps one stable id without automatic replay or edited replacement", async () => {
  window.__GOALPORT_LINUX_CORE__ = true; window.history.replaceState(null,"","/#codex/new");
  const f = server({unknownStart:true}); render(<App />);
  const input = await screen.findByRole("textbox", {name:"Message composer"});
  fireEvent.change(screen.getByLabelText("Project folder"), {target:{value:"/fixture/native"}});
  fireEvent.change(input, {target:{value:"Send once"}}); fireEvent.submit(input.closest("form")!);
  const check = await screen.findByRole("button", {name:"Check result"});
  expect(f.calls.filter(c => c.messageType === "start_conversation")).toHaveLength(1);
  expect(input).toHaveProperty("disabled", true); expect(window.location.hash).toBe("#codex/new");
  expect(f.calls.filter(c => c.messageType === "coordination_discover")).toHaveLength(0);
  await waitFor(() => expect(check).toHaveProperty("disabled", false));
  fireEvent.click(check);
  await waitFor(() => expect(f.calls.filter(c => c.messageType === "start_conversation")).toHaveLength(2));
  const starts = f.calls.filter(c => c.messageType === "start_conversation");
  expect(starts[1].requestId).toBe(starts[0].requestId);
  expect(starts[1].payload).toEqual(starts[0].payload);
});

it("pinned native client sends only new text and explicit campaign/attempt, keeps private handles out of inputs, and Resume uses a stripped workbench lookup key", async () => {
  window.__GOALPORT_LINUX_CORE__ = true; server(); const client = getCoreClient(); client.pinView?.("campaign-native");
  const sent: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_u, init) => { const command = JSON.parse(String(init.body)); sent.push(command); return reply({ok:true,payload:{snapshot:packet(true), overview:{goals:[],pending:[]}}}); }));
  await client.conversationSend!("Only new text", "campaign-native", "attempt-native", "one-stable");
  await client.resumeSession!("attempt-native");
  const send = (sent as Record<string,unknown>[]).find(c => c.messageType === "conversation_send")!;
  expect(send.payload).toEqual({message:"Only new text",campaignId:"campaign-native",attemptId:"attempt-native"});
  const resume = (sent as Record<string,unknown>[]).find(c => c.messageType === "resume_native_session")!;
  expect(resume.payload).toEqual({attemptId:"attempt-native"}); expect(resume.nativeTarget).toEqual({campaignId:"campaign-native"});
  expect(JSON.stringify(sent)).not.toMatch(/sessionId|providerSession|nativeThread/);
});

it("details distinguish actual exec/unknown/app-server without labeling other providers Codex exec", () => {
  const snapshot = packet(true); const props = {open:true,onClose:vi.fn(),snapshot,product:snapshot.productConversation,onChangeRuntime:vi.fn(),onOpenHandoff:vi.fn(),onCloseSession:vi.fn(),onResumeSession:vi.fn(),onOpenWorkspaceFolder:vi.fn()};
  const view = render(<SessionDetails {...props} product={{...props.product!,session:{state:"attached",nativeIdKnown:true,transport:"exec"}}} />);
  expect(screen.getByText("One-shot Codex; native session continuation is unavailable")).toBeTruthy();
  view.rerender(<SessionDetails {...props} product={{...props.product!,session:{state:"detached",nativeIdKnown:true,transport:"unknown"}}} />);
  expect(screen.getByText("Transport not confirmed")).toBeTruthy();
  view.rerender(<SessionDetails {...props} product={{...props.product!,runtime:{state:"selected",provider:"claude",name:"Claude"},session:{state:"attached",nativeIdKnown:true,transport:"unknown"}}} />);
  expect(screen.queryByText(/One-shot Codex/)).toBeNull();
});

it("a late native start cannot adopt the client view after explicit navigation", async () => {
  window.__GOALPORT_LINUX_CORE__ = true;
  let release: (response: Response) => void = () => undefined;
  const delayed = new Promise<Response>(resolve => { release = resolve; });
  server({delayedStart:delayed});
  const client = getCoreClient();
  client.pinView?.("campaign-existing");
  const pending = client.startConversation!("/fixture/native", "codex", "once", "stable-late", true);
  client.pinView?.("campaign-other");
  release(reply({ok:true,payload:{snapshot:packet(true)}}));
  await pending;
  const calls: Array<Record<string,unknown>> = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    const body = JSON.parse(String(init.body)); calls.push(body);
    return reply({ok:true,payload:body.messageType === "goal_overview" ? {overview:{goals:[],pending:[]}} : {snapshot:packet(true)}});
  }));
  await client.snapshot();
  expect(calls.find(call => call.messageType === "snapshot_if_changed")?.payload).toEqual({campaignId:"campaign-other"});
});

it("native draft route is local intent and cannot be overwritten by passive Core selection", () => {
  window.history.replaceState(null,"","/#codex/new"); expect(isNativeDraftRoute()).toBe(true);
  replaceGoalRoute("campaign-other"); expect(window.location.hash).toBe("#codex/new");
});
