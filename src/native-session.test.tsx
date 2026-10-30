// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import App from "./App";
import { getCoreClient, resetCoreClientForTests } from "./ipc";
import { DEMO_SNAPSHOT, resolveCoreSnapshot, normalizeProductConversation, type CoreSnapshot } from "./types";
import { DraftGoalComposer } from "./conversation/DraftGoalComposer";
import { SessionDetails } from "./panels/SessionDetails";
import { isNativeDraftRoute, replaceGoalRoute } from "./lib/goalRoute";
import * as intentHelpers from "./lib/sendIntent";
import {prepareNativeWorkspaceCheckMaterial} from './coordination/nativeWorkspaceCheck';

afterEach(() => { cleanup(); vi.restoreAllMocks(); resetCoreClientForTests(); delete window.__GOALPORT_LINUX_CORE__; delete window.goalportCore; sessionStorage.clear(); vi.unstubAllGlobals(); window.history.replaceState(null, "", "/"); });
const reply = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const packet = (active = false): CoreSnapshot => ({ ...DEMO_SNAPSHOT, preview: false, connection: "connected", activeCampaignId: active ? "campaign-native" : "", campaigns: active ? [{ ...DEMO_SNAPSHOT.campaigns[0], id:"campaign-native", title:"Native goal" }] : [],
  project: { ...DEMO_SNAPSHOT.project, workspaceRoot: "/fixture/native" }, activeTask: { ...DEMO_SNAPSHOT.activeTask, id:"task-native", title:"Native goal" },
  attempt: { ...DEMO_SNAPSHOT.attempt, id: "attempt-native", provider:"codex", state:"active" }, decisions:[], notices:[],
  runtimes: DEMO_SNAPSHOT.runtimes.map(item => ({ ...item, nativeSessionTransport: item.id === "codex" ? "app-server" : "unknown" })),
  productConversation: { ...DEMO_SNAPSHOT.productConversation!, title:"Native goal", items:[], runtime:{ state:"selected", provider:"codex", name:"Codex" }, session:{ state:"attached", nativeIdKnown:true, transport:"app-server" }, turn:{ state:"completed", canSend:true, canStop:false, actions:["close-session"] } }
});
function server(options: { latest?: unknown; status?: unknown; completed?: boolean; unknownStart?: boolean; delayedStart?: Promise<Response>; active?: boolean; results?: CoreSnapshot["turnResults"]; sendResponse?: (command: { requestId: string; messageType: string }) => Response | Promise<Response> } = {}) {
  const calls: Array<{messageType:string; payload:Record<string,unknown>; requestId:string; nativeTarget?:unknown}> = [];
  let current = { ...packet(options.active), ...(options.results ? { turnResults: options.results } : {}) };
  if (options.completed) current = {...current,attempt:{...current.attempt,state:'waiting'}};
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); calls.push(body);
    if (body.messageType === "coordination_latest") return reply({ ok:true, payload:options.latest ?? { record:null, roots:[], profileUnconfirmed:false, leftoverHeld:false, line:null, currentBase:null, globalSlot:{kind:"empty"} } });
    if (body.messageType === 'coordination_status' && options.status) return reply({ok:true,payload:options.status});
    if (body.messageType === "coordination_discover") return reply({ ok:true, payload:{ consentMissing:true, harnesses:[], sentence:"Pi unavailable" } });
    if (body.messageType === "goal_overview") return reply({ ok:true, payload:{ overview:{ revision:"fixture", truncated:false, goals:[], pending:[] } } });
    if (["start_conversation", "conversation_send"].includes(body.messageType) && options.sendResponse) return options.sendResponse(body);
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

it("keeps native chat primary by folding saved workspace results without discarding them", async () => {
  window.__GOALPORT_LINUX_CORE__ = true; window.history.replaceState(null,"","/goals/campaign-native");
  server({active:true, results:[{requestId:"synthetic",replyState:"completed",replyText:"Saved native turn reply",baselineRecorded:true,before:[],during:[],unattributed:[],commands:[]}]});
  render(<App />);
  const summary = await screen.findByText("Files changed");
  const disclosure = summary.closest("details")!;
  expect(disclosure.open).toBe(false);
  expect(disclosure.querySelector('[aria-label="Results"]')).not.toBeNull();
  expect(screen.getByRole("textbox", {name:"Message composer"})).toBeTruthy();
  fireEvent.click(summary); expect(disclosure.open).toBe(true);
  expect(screen.getByText("Saved native turn reply")).toBeTruthy();
});

it('keeps one native composer, draft node/focus and IME/Enter behavior through the optional check dialog',async()=>{
 window.__GOALPORT_LINUX_CORE__=true;window.history.replaceState(null,'','/goals/campaign-native');
 const f=server({active:true,completed:true,results:[{requestId:'turn-check',replyState:'completed',replyText:'Synthetic result',baselineRecorded:true,before:[],during:[],unattributed:[],commands:[]}]});
 render(<App/>);const check=await screen.findByRole('button',{name:'Ask Pi to review'});const composer=screen.getByRole('textbox',{name:'Message composer'});fireEvent.change(composer,{target:{value:'Retain this native draft'}});composer.focus();
 await waitFor(()=>expect((check as HTMLButtonElement).disabled).toBe(false));fireEvent.click(check);await screen.findByRole('dialog',{name:'Ask Pi to review'});expect(document.querySelectorAll('textarea[aria-label="Message composer"]')).toHaveLength(1);expect(document.querySelector('textarea[aria-label="Message composer"]')).toBe(composer);fireEvent.click(screen.getByRole('button',{name:'Cancel'}));await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());await waitFor(()=>expect(screen.getByRole('textbox',{name:'Message composer'})).toBe(composer));expect((composer as HTMLTextAreaElement).value).toBe('Retain this native draft');
 composer.focus();fireEvent.compositionStart(composer);fireEvent.keyDown(composer,{key:'Enter',code:'Enter',isComposing:true});fireEvent.compositionEnd(composer);expect(f.calls.filter(c=>c.messageType==='conversation_send')).toHaveLength(0);expect(window.location.pathname).toBe('/goals/campaign-native');
});

it('keeps native goal A pinned while the one current-work strip names check B, with no adopted native actions',async()=>{
 window.__GOALPORT_LINUX_CORE__=true;window.history.replaceState(null,'','/goals/campaign-native');
 const nativeCheckTarget={campaignId:'campaign-b',attemptId:'attempt-b',turnRequestId:'turn-b'};const piCapacity={provider:'Fixture',model:'alpha',useExistingCapacity:true as const};
 const context={reply:'reported',replyTruncated:false,commands:[],commandsOmitted:0,commandsTruncated:false,filesTruncated:false,comparisonUnavailable:false,olderTurnsOmitted:0};
 const nativeCheckMaterial=prepareNativeWorkspaceCheckMaterial({contentObservation:{head:'a'.repeat(40),paths:[],selectedDiff:'diff B',selectedStatus:'',nativeReportedContext:context},nativeReportedContext:context,capturedAt:'2026-01-01T00:00:00Z'});
 const job={jobId:'00000000-0000-4000-8000-000000000002',requestId:'check-b',goal:'Native B',workspacePath:'/fixture/b',recordKind:'native-workspace-check',nativeCheckTarget,nativeCheckMaterial,piCapacity,state:'running',active:true,live:true,revoked:false,workerPid:123,readMaxTurns:2,writeMaxTurns:null,counters:{readTurnsLeft:1},pendingCommand:null,completedCommands:[],progress:{activity:'Pi is checking B'},outcome:null};
 const base={kind:'saved-current-base',jobId:job.jobId,admittedRequestId:job.requestId,rootRequestId:null,goal:job.goal,workspacePath:job.workspacePath,identityConfirmed:true,nativeCheckTarget,followUpMode:null,state:'running',phase:'running',pending:'none',revoked:false,workerGone:false,unconfirmed:false,active:true,allowanceEnd:null,observedAcceptedChildId:null,globalSlot:{kind:'occupied',jobId:job.jobId,admittedRequestId:job.requestId},profileUnconfirmed:false,leftoverHeld:false};
 const f=server({active:true,completed:true,results:[{requestId:'turn-a',replyState:'completed',baselineRecorded:true,before:[],during:[],unattributed:[],commands:[]}],latest:{record:null,roots:[],line:'Pi is checking B',jobId:job.jobId,currentBase:base,globalSlot:base.globalSlot},status:{source:'host-status',jobId:job.jobId,job}});
 render(<App/>);await screen.findByText('Current work — Native B');await waitFor(()=>expect(f.calls.some(c=>c.messageType==='coordination_status')).toBe(true));expect(window.location.pathname).toBe('/goals/campaign-native');expect(screen.getByRole('textbox',{name:'Message composer'})).toBeTruthy();expect(screen.queryByRole('region',{name:'Pi review'})).toBeNull();expect(screen.getAllByLabelText('Current work')).toHaveLength(1);expect(f.calls.some(c=>['select_campaign','conversation_send','resume_session','close_session'].includes(c.messageType))).toBe(false);
});

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
  expect(screen.queryByText(/app-server/)).toBeNull();
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
  expect(screen.getByText("Codex can't continue this conversation after this turn.")).toBeTruthy();
  view.rerender(<SessionDetails {...props} product={{...props.product!,session:{state:"detached",nativeIdKnown:true,transport:"unknown"}}} />);
  expect(screen.queryByText("Transport not confirmed")).toBeNull();
  view.rerender(<SessionDetails {...props} product={{...props.product!,runtime:{state:"selected",provider:"claude",name:"Claude"},session:{state:"attached",nativeIdKnown:true,transport:"unknown"}}} />);
  expect(screen.queryByText(/can't continue this conversation/)).toBeNull();
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

function refusedSend(command: { requestId: string; messageType: string }): Response {
  const reason = "The conversation folder could not be confirmed. Choose an existing accessible absolute folder.";
  return reply({ protocolVersion: "goalport.ipc.v2", requestId: command.requestId, ok: false, error: reason,
    payload: { requestId: command.requestId, accepted: false, messageType: command.messageType,
      refusalSource: "workbench-native-preflight", rejection: { code: "native-preflight-refused", message: reason,
        deliveryState: "FAILED", nativeDispatchState: "NOT_STARTED", retryMode: "NEW_REQUEST", reservation: null },
      technical: "Synthetic preflight diagnostic" } });
}

it("first validated refusal stays an editable draft, with one plain reason, folded details and no automatic send", async () => {
  window.__GOALPORT_LINUX_CORE__ = true; window.history.replaceState(null, "", "/#codex/new");
  const f = server({ sendResponse: refusedSend }); render(<App />);
  const input = await screen.findByRole("textbox", { name: "Message composer" });
  const folder = screen.getByLabelText("Project folder");
  fireEvent.change(folder, { target: { value: "/fixture/missing" } });
  fireEvent.change(input, { target: { value: "Keep this draft" } });
  fireEvent.submit(input.closest("form")!);
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("Nothing was sent. The conversation folder could not be confirmed.");
  expect(alert.textContent?.match(/The conversation folder/g)).toHaveLength(1);
  expect(alert.textContent).not.toMatch(/Core refused|Check result|GoalPort could not complete/);
  expect(alert.querySelector("details")?.open).toBe(false);
  expect(screen.queryByRole("button", { name: "Check result" })).toBeNull();
  expect(input).toHaveProperty("disabled", false); expect(input).toHaveProperty("value", "Keep this draft");
  expect(folder).toHaveProperty("disabled", false);
  expect(screen.getByRole("button", { name: "Discard draft" })).toHaveProperty("disabled", false);
  input.focus();
  fireEvent.change(folder, { target: { value: "/fixture/corrected" } });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(document.activeElement).toBe(input);
  fireEvent.change(input, { target: { value: "Corrected draft" } });
  fireEvent.compositionStart(input); fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  expect(f.calls.filter(c => c.messageType === "start_conversation")).toHaveLength(1);
  fireEvent.compositionEnd(input);
  // Explicitly submit a later draft: it alone gets a fresh ID and changed payload.
  fireEvent.submit(input.closest("form")!);
  await screen.findByRole("alert");
  const starts = f.calls.filter(c => c.messageType === "start_conversation");
  expect(starts).toHaveLength(2); expect(starts[1].requestId).not.toBe(starts[0].requestId);
  expect(starts[1].payload.message).toBe("Corrected draft");
  expect(starts[1].payload.workspaceRoot).toBe("/fixture/corrected");
  expect(f.calls.some(c => ["coordination_start", "coordination_continue", "resume_native_session"].includes(c.messageType))).toBe(false);
});

it("mode change clears the native refusal before opening coordinated work; New goal cannot resurrect its intent", async () => {
  window.__GOALPORT_LINUX_CORE__ = true; window.history.replaceState(null, "", "/#codex/new");
  const f = server({ sendResponse: refusedSend }); render(<App />);
  const input = await screen.findByRole("textbox", { name: "Message composer" });
  fireEvent.change(screen.getByLabelText("Project folder"), { target: { value: "/fixture/missing" } });
  fireEvent.change(input, { target: { value: "Still my draft" } }); fireEvent.submit(input.closest("form")!);
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("combobox", { name: "Choose goal mode" }));
  fireEvent.keyDown(await screen.findByRole("option", { name: /Coordinated work/ }), { key: "Enter" });
  await waitFor(() => expect(window.location.hash).toBe("#coordinated/new"));
  expect(screen.queryByText(/Nothing was sent/)).toBeNull();
  expect(screen.queryByText("Synthetic preflight diagnostic")).toBeNull();
  expect(screen.getByRole("textbox", { name: "Message composer" })).toHaveProperty("value", "Still my draft");
  fireEvent.click(screen.getByRole("button", { name: "New goal" }));
  await waitFor(() => expect(window.location.hash).toBe("#coordinated/new"));
  expect(screen.queryByRole("button", { name: "Check result" })).toBeNull();
  await chooseNative();
  expect(screen.getByRole("textbox", { name: "Message composer" })).toHaveProperty("disabled", false);
  fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
  expect(f.calls.filter(c => c.messageType === "start_conversation")).toHaveLength(1);
});

it("later host refusal keeps a prior unknown start's identity, copy, text and locks", async () => {
  window.__GOALPORT_LINUX_CORE__ = true; window.history.replaceState(null, "", "/#codex/new");
  let first = true;
  const f = server({ sendResponse: command => { if (first) { first = false; throw Error("synthetic unknown"); } return refusedSend(command); } });
  render(<App />);
  const input = await screen.findByRole("textbox", { name: "Message composer" });
  fireEvent.change(screen.getByLabelText("Project folder"), { target: { value: "/fixture/native" } });
  fireEvent.change(input, { target: { value: "Original uncertain request" } }); fireEvent.submit(input.closest("form")!);
  const check = await screen.findByRole("button", { name: "Check result" });
  await waitFor(() => expect(check).toHaveProperty("disabled", false)); fireEvent.click(check);
  await screen.findByText("This attempt was not forwarded, but the earlier send is still not confirmed. Your original request is kept.");
  expect(input).toHaveProperty("disabled", true); expect(input).toHaveProperty("value", "Original uncertain request");
  expect(screen.getByLabelText("Project folder")).toHaveProperty("disabled", true);
  expect(screen.getByRole("button", { name: "Discard draft" })).toHaveProperty("disabled", true);
  const calls = f.calls.filter(c => c.messageType === "start_conversation");
  expect(calls).toHaveLength(2); expect(calls[1]).toEqual(calls[0]);
});

it.each([false, true])("synchronous guard blocks a second submit while %s native send is awaiting", async active => {
  window.__GOALPORT_LINUX_CORE__ = true; window.history.replaceState(null, "", active ? "/goals/campaign-native" : "/#codex/new");
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const f = server({ active, sendResponse: async command => { await pending; return refusedSend(command); } });
  const classify = vi.spyOn(intentHelpers, "settleNativeSendIntent");
  render(<App />);
  if (active) await screen.findByRole("textbox", { name: "Message composer" });
  const input = await screen.findByRole("textbox", { name: "Message composer" });
  if (!active) fireEvent.change(screen.getByLabelText("Project folder"), { target: { value: "/fixture/missing" } });
  fireEvent.change(input, { target: { value: "One invocation" } });
  fireEvent.submit(input.closest("form")!); fireEvent.submit(input.closest("form")!);
  const method = active ? "conversation_send" : "start_conversation";
  await waitFor(() => expect(f.calls.filter(c => c.messageType === method)).toHaveLength(1));
  expect(classify).not.toHaveBeenCalled();
  release();
  await screen.findByText(/Nothing was sent\./);
  expect(f.calls.filter(c => c.messageType === method)).toHaveLength(1);
  expect(classify).toHaveBeenCalledTimes(1);
  expect(input).toHaveProperty("disabled", false); expect(input).toHaveProperty("value", "One invocation");
});

it("a later conversation host refusal retains earlier unknown send and original request", async () => {
  window.__GOALPORT_LINUX_CORE__ = true; window.history.replaceState(null, "", "/goals/campaign-native");
  let first = true;
  const f = server({ active: true, sendResponse: command => { if (first) { first = false; throw Error("synthetic unknown"); } return refusedSend(command); } });
  render(<App />);
  await screen.findByRole("textbox", { name: "Message composer" });
  const input = await screen.findByRole("textbox", { name: "Message composer" });
  fireEvent.change(input, { target: { value: "Original follow-up" } }); fireEvent.submit(input.closest("form")!);
  const check = await screen.findByRole("button", { name: "Check result" });
  const priorDisabled = (input as HTMLTextAreaElement).disabled;
  await waitFor(() => expect(check).toHaveProperty("disabled", false)); fireEvent.click(check);
  await screen.findByText("This attempt was not forwarded, but the earlier send is still not confirmed. Your original request is kept.");
  // Existing conversation Composer permits drafting ahead; this invocation
  // must not change that policy or replace the earlier Check result intent.
  expect(input).toHaveProperty("disabled", priorDisabled);
  expect(input).toHaveProperty("value", "Original follow-up");
  expect(screen.getByRole("button", { name: "Check result" })).toBeTruthy();
  const sends = f.calls.filter(c => c.messageType === "conversation_send");
  expect(sends).toHaveLength(2); expect(sends[1]).toEqual(sends[0]);
});

it.each([false, true])("defensive stale sending in %s native composer reconciles locally without another call/classification", async active => {
  window.__GOALPORT_LINUX_CORE__ = true; window.history.replaceState(null, "", active ? "/goals/campaign-native" : "/#codex/new");
  // Fault injection models retained presentation after an interrupted UI callback,
  // not a different transport/proof or a production test hook.
  const classify = vi.spyOn(intentHelpers, "settleNativeSendIntent").mockImplementationOnce(intent => ({ ...intent, state: "sending" }));
  const f = server({ active, sendResponse: () => reply({ ok: false, error: "synthetic interrupted presentation" }) });
  render(<App />);
  if (active) await screen.findByRole("textbox", { name: "Message composer" });
  const input = await screen.findByRole("textbox", { name: "Message composer" });
  if (!active) fireEvent.change(screen.getByLabelText("Project folder"), { target: { value: "/fixture/original" } });
  fireEvent.change(input, { target: { value: "Keep original identity" } });
  fireEvent.submit(input.closest("form")!);
  await waitFor(() => expect(classify).toHaveBeenCalledTimes(1));
  const original = classify.mock.calls[0][0];
  fireEvent.submit(input.closest("form")!);
  await screen.findByText("The earlier send is still not confirmed. Your original request is kept.");
  expect(screen.getByRole("button", { name: "Check result" })).toBeTruthy();
  expect(classify).toHaveBeenCalledTimes(1);
  const calls = f.calls.filter(c => c.messageType === (active ? "conversation_send" : "start_conversation"));
  expect(calls).toHaveLength(1); expect(calls[0].requestId).toBe(original.requestId);
  expect(input).toHaveProperty("value", original.message);
});

it("later host refusal restores the exact same-request reservation captured before cloning", async () => {
  window.__GOALPORT_LINUX_CORE__ = true; window.history.replaceState(null, "", "/#codex/new");
  let prior!: intentHelpers.SendIntent;
  const classify = vi.spyOn(intentHelpers, "settleNativeSendIntent").mockImplementationOnce(intent => {
    prior = Object.freeze({ ...intent, state: "same-request", reservation: {
      kind: "first-send" as const, requestId: intent.requestId, campaignId: "synthetic-reserved", taskId: "synthetic-task", attemptId: "synthetic-attempt", messageReserved: true
    } });
    return prior;
  });
  let first = true;
  const f = server({ sendResponse: command => {
    if (first) { first = false; return reply({ ok: false, error: "synthetic prior Core reservation" }); }
    return refusedSend(command);
  } });
  render(<App />);
  const input = await screen.findByRole("textbox", { name: "Message composer" });
  fireEvent.change(screen.getByLabelText("Project folder"), { target: { value: "/fixture/original" } });
  fireEvent.change(input, { target: { value: "Reserved original" } }); fireEvent.submit(input.closest("form")!);
  const retry = await screen.findByRole("button", { name: "Retry" });
  await waitFor(() => expect(retry).toHaveProperty("disabled", false)); fireEvent.click(retry);
  await screen.findByText("This attempt was not forwarded. Your existing conversation request is kept.");
  expect(classify.mock.calls[1][0]).toEqual({ ...prior, state: "sending" });
  expect(classify.mock.calls[1][2]).toBe(prior);
  expect(classify.mock.results[1].value).toBe(prior);
  expect(prior.state).toBe("same-request");
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Check result" })).toBeNull();
  const starts = f.calls.filter(c => c.messageType === "start_conversation");
  expect(starts).toHaveLength(2); expect(starts[1]).toEqual(starts[0]);
});

it("late host refusal cannot reinsert native error or steal focus after deliberate view navigation", async () => {
  window.__GOALPORT_LINUX_CORE__ = true; window.history.replaceState(null, "", "/#codex/new");
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const f = server({ sendResponse: async command => { await pending; return refusedSend(command); } });
  render(<App />);
  const input = await screen.findByRole("textbox", { name: "Message composer" });
  fireEvent.change(screen.getByLabelText("Project folder"), { target: { value: "/fixture/original" } });
  fireEvent.change(input, { target: { value: "Old draft" } }); fireEvent.submit(input.closest("form")!);
  await waitFor(() => expect(f.calls.filter(c => c.messageType === "start_conversation")).toHaveLength(1));
  window.history.replaceState(null, "", "/#coordinated/new"); fireEvent(window, new PopStateEvent("popstate"));
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Choose goal mode" }).textContent).toContain("Coordinated work"));
  const coordinated = screen.getByRole("textbox", { name: "Message composer" }); coordinated.focus();
  await act(async () => { release(); await pending; });
  await waitFor(() => expect(screen.queryByText(/Nothing was sent\./)).toBeNull());
  expect(window.location.hash).toBe("#coordinated/new"); expect(document.activeElement).toBe(coordinated);
  expect(screen.queryByText("Synthetic preflight diagnostic")).toBeNull();
  expect(f.calls.filter(c => c.messageType === "start_conversation")).toHaveLength(1);
});

it("native draft route is local intent and cannot be overwritten by passive Core selection", () => {
  window.history.replaceState(null,"","/#codex/new"); expect(isNativeDraftRoute()).toBe(true);
  replaceGoalRoute("campaign-other"); expect(window.location.hash).toBe("#codex/new");
});
