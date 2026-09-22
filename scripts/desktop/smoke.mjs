import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { argsFor, fileHash } from "./package.mjs";
import { verifyPackage } from "./verify-package.mjs";
import { attachGoalPort } from "../connected/v1-cdp.mjs";
import launchConfig from "../../electron/launch-config.cjs";
import { boundedFailureSummary, collectFailureDiagnostics, collectStartupDiagnostics, sanitizeDiagnostic } from "./diagnostics.mjs";
import { connectedUiExpression } from "./connect-probe.mjs";
import { clickPointFor } from "./click-target.mjs";
import { cleanupOwnedCore } from "./owned-core-cleanup.mjs";
import { observeProcess } from "./process-observer.mjs";

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const normalize = launchConfig.normalizedPath;
const WORKSPACE_PRIVATE_PATHS = [process.cwd(), process.env.USERPROFILE, process.env.HOME, tmpdir()];
const argv = process.argv.slice(2);
const normal = argv.includes("--normal");
const failBeforeReceipt = argv.includes("--fail-before-receipt");
const args = argsFor(argv.filter((arg) => !["--normal", "--fail-before-receipt"].includes(arg)), ["--package", "--out", "--test-profile"]);

// ---------------------------------------------------------------------------
// This packaged regression driver exercises the
// conversation-first UI of f372c50 ("make desktop conversations primary"):
// draft-first goal creation (start_conversation), inline Runtime picker,
// quiet successful sends, Session details, Scenario-only synthetic safety.
// The previous driver asserted the superseded naming-dialog flow, permanent
// details Runtime rows, the removed "Message recorded for task" banner and
// creation-before-send assumptions. Every one of those assertions is mapped to
// the equivalent current contract in `assertionMap` below; safety coverage is
// retained, never deleted. UI steps are driven through CDP synthesized input
// (mouse/keyboard events, NOT a physical-pointer test) and labelled `ui-cdp`;
// direct `window.goalportCore.command` probes are labelled `api`; SQLite reads
// are labelled `db`. No native provider subscription/end-to-end is claimed:
// the native search path is empty and Scenario is the only admitted Runtime.
// ---------------------------------------------------------------------------
const ASSERTION_MAP = [
  { superseded: "no goal means no composer in the DOM at all; empty state owns the start-goal CTA", current: "draft-first composer (#draft-workspace/#draft-message) is present with ZERO durable rows; first Send is the only creation path" },
  { superseded: "#project-folder + #campaign-goal inside .first-run-dialog create form", current: ".draft-composer-form; workspace + inline draft Runtime picker + message; no naming step; title is deterministic from the first prompt" },
  { superseded: "create campaign first, then select Runtime in permanent details rows (.runtime-row summary / Select X)", current: "Runtime chosen inline in the draft/composer .runtime-picker; Session details keeps a Change Runtime affordance" },
  { superseded: "workspace-selection creates only Campaign and task (commands=0, attempts=0)", current: "first Send (start_conversation) atomically creates one project/campaign/task/attempt/reserved first message + succeeded conversation_request; no automatic second send" },
  { superseded: "\"Message recorded for task\" success banner wait", current: "quiet success: draft cleared, no success banner, exact-once durable message/reply, rendered product conversation" },
  { retained: "UI attempt.state labels remain lowercase", current: "waiting|active|completed|failed from attempt_to_ui; durable attempt states and refusal labels are separate contracts" },
  { superseded: "terminal cross-provider race via two UI Select buttons clicked in one renderer task", current: "UI picker serializes (list closes on select); Core race proof retained through two concurrent raw select_runtime commands (labelled api)" },
  { superseded: "explicit replay of send_message answers duplicate from any selected conversation", current: "replay of the exact UI conversation_send command/requestId: answered duplicate when its conversation is selected; refused fail-closed (\"not selected by Core\") while another conversation is displayed — recorded, not weakened" },
  { superseded: "refusal text matched in page body (\"Core refused: ...\")", current: "visible readable refusal sentence in the notice banner plus the exact Core reason read from its collapsed technical disclosure and from durable rows" },
  { superseded: "responsive check of .context-rail/.runtime-row summary", current: "responsive check of .campaign-nav, the composer .runtime-picker and the Session details drawer" }
];
const SELECTOR_MAP = {
  draftComposer: ".draft-composer-form",
  draftWorkspace: "#draft-workspace",
  draftMessage: "#draft-message",
  draftSubmit: ".draft-composer-form button[type='submit']",
  draftRuntimePicker: ".draft-runtime-picker button[aria-label='Select Runtime']",
  conversationComposer: ".composer textarea[aria-label='Message composer']",
  sendButton: ".composer button[aria-label='Send message']",
  composerRuntimePicker: ".composer-dock .runtime-picker button[aria-label='Select Runtime']",
  runtimeOption: ".runtime-picker-item",
  noticeBanner: ".status-banners .banner-notice",
  technicalDetails: ".banner-notice .technical-details-pre",
  newGoal: "button[aria-label='New goal']",
  campaignItem: ".campaign-item",
  sessionDetails: ".inspector[data-open='true']",
  openDetails: "button[aria-label='Open details panel']",
  closeDetails: "button[aria-label='Close details panel']",
  changeRuntime: ".session-details-actions button",
  renderedConversation: "[data-product-conversation='true']"
};
const PROTOCOL_MAP = {
  transport: "window.goalportCore.command({protocolVersion:'goalport.ipc.v2', requestId, entityVersion:0, messageType, payload}) over the Electron preload IPC bridge",
  firstSend: "DraftGoalComposer submit -> start_conversation {workspaceRoot, provider, message} with a caller-stable requestId (one command, at-most-once claim machine in Core)",
  continuationSend: "Composer submit -> conversation_send {message, campaignId, attemptId} (send_message remains the Core-internal/native ledger command)",
  runtimeChoice: "runtime-picker -> select_runtime {provider, campaignId, taskId, attemptId?} (draft picker is local state only; no Core command before first Send)",
  responses: "accepted envelope {requestId, accepted:true, duplicate, snapshot} | refusal {goalportRejected:true, requestId, error}",
  attemptStates: "UI: waiting|active|completed|failed; database state casing is checked separately"
};

// Initialize all driver contracts before entering the async smoke runner.
if (args.help) {
  console.log("Usage: node scripts/desktop/smoke.mjs --package <package-directory> --out <new-evidence-directory> [--normal | --test-profile <new-absolute-profile>]\nCopies the complete RC outside source; verifies real GUI, IPC and Core with Scenario only. Node >=22.19 required.\nNormal mode uses ordinary data handling and inert markers, with empty native configuration/PATH. Default mode is explicitly synthetic-only.");
} else {
  await smoke().catch((error) => { console.error(sanitizeDiagnostic(error.stack || error, WORKSPACE_PRIVATE_PATHS)); process.exitCode = 1; });
}

async function smoke() {
  if (process.platform !== "win32") throw new Error("Packaged RC smoke requires Windows");
  if (!args["--package"] || !args["--out"]) throw new Error("--package and --out are required");
  if (normal && args["--test-profile"]) throw new Error("--normal and --test-profile cannot be combined");
  if (normal && failBeforeReceipt) throw new Error("--fail-before-receipt requires the synthetic test mode");
  const originalPackage = resolve(args["--package"]);
  const identity = verifyPackage(originalPackage);
  const out = resolve(args["--out"]);
  if (existsSync(out)) throw new Error(`Evidence directory already exists: ${out}`);
  mkdirSync(out, { recursive: true });
  const scratch = mkdtempSync(resolve(tmpdir(), "goalport-rc-smoke-"));
  const packageRoot = resolve(scratch, "application");
  const profile = args["--test-profile"] ? resolve(args["--test-profile"]) : resolve(scratch, "profile");
  if (existsSync(profile)) throw new Error("Smoke requires an absent test/data profile");
  const workspaceA = resolve(scratch, "workspace-a");
  const workspaceB = resolve(scratch, "workspace-b");
  const nativeHome = resolve(scratch, "empty-native-home");
  // Browser-state namespace isolation: Windows known-folder resolution IGNORES
  // the APPDATA environment variable, so the only supported way to keep the
  // Electron/Chromium namespace out of the real %APPDATA% is the --user-data-dir
  // switch (the documented application-root relocation, rule E). Both the
  // durable root and the electron namespace then live inside this root but
  // stay physically separate.
  const appDataRoot = resolve(scratch, "appdata-root");
  // The durable/browser path split is computed by the SAME central path model
  // the app uses — the driver never assembles these paths itself.
  const coreSha = identity.artifacts.find((entry) => entry.path === "resources/goalport-core.exe").sha256;
  const launchPaths = launchConfig.resolveProfilePaths({
    args: launchConfig.launchArguments([normal ? "--data-dir" : "--test-profile", profile, "--user-data-dir", appDataRoot]),
    appData: appDataRoot,
    channel: normal ? "release" : "release",
    coreSha256: coreSha
  });
  const browserStateDirectory = launchPaths.browserStateDirectory;
  // Pre-launch snapshot of the REAL %APPDATA% GoalPort folder (this driver
  // process's own APPDATA, not the spawned app's redirected one): the smoke
  // must leave it byte-identical.
  const realAppData = process.env.APPDATA || null;
  const realGoalPortEntries = () => {
    if (!realAppData) return null;
    try { return readdirSync(resolve(realAppData, "GoalPort")).sort(); } catch { return null; }
  };
  const realGoalPortPre = realGoalPortEntries();
  const report = {
    schemaVersion: 1, status: "RUNNING", mode: normal ? "normal" : "synthetic-test",
    driverRevision: "conversation-first-v1",
    startedAt: new Date().toISOString(), identity,
    originalPackage, packageRoot, scratch, profile, workspaceA, workspaceB,
    appDataRoot, browserStateDirectory,
    boundaryStates: ["first-run", "concurrent", "error-path", "interrupted"],
    assertionMap: ASSERTION_MAP, selectorMap: SELECTOR_MAP, protocolMap: PROTOCOL_MAP,
    probeKinds: {
      uiInput: "CDP Input.dispatchMouseEvent/Input.insertText synthesized renderer input (not a physical-pointer test)",
      apiProbes: "direct window.goalportCore.command IPC calls",
      durableChecks: "read-only SQLite inspection of the profile database",
      nativeEndToEnd: false,
      nativeSubscriptionAdmission: false
    },
    steps: [], cleanup: [], realSubscriptionAdmission: false
  };
  const save = () => writeFileSync(resolve(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  save(); // Ownership and absent profile are recorded before the first app launch.
  cpSync(originalPackage, packageRoot, { recursive: true, errorOnExist: true });
  assert.equal(verifyPackage(packageRoot).sourceTreeSha256, identity.sourceTreeSha256);
  for (const dir of [workspaceA, workspaceB, nativeHome]) mkdirSync(dir, { recursive: true });
  let child, page, coreIdentity, logFd;
  let stage = "prepare-launch";
  const zeroCounts = () => ({ projects: 0, campaigns: 0, tasks: 0, attempts: 0, commands: 0, outbox: 0, conversation_requests: 0, conversation_preferences: 0 });
  const marker = (name, evidence = {}) => {
    report.steps.push({ name, at: new Date().toISOString(), ...evidence }); save();
    console.log(`PASS ${name}`);
  };
  const until = async (description, predicate, timeout = 20000) => {
    stage = description;
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
      try { last = await predicate(); if (last) return last; } catch (error) { last = error.message; }
      await sleep(100);
    }
    throw new Error(`Timed out: ${description}; last=${JSON.stringify(last)}`);
  };
  const dbRows = (sql, ...params) => {
    const db = new DatabaseSync(resolve(profile, "goalport.sqlite"), { readOnly: true });
    try { return db.prepare(sql).all(...params); } finally { db.close(); }
  };
  const counts = () => Object.fromEntries(["projects", "campaigns", "tasks", "attempts", "commands", "outbox", "conversation_requests", "conversation_preferences"].map((name) => [name, dbRows(`SELECT COUNT(*) AS n FROM ${name}`)[0].n]));
  const events = (attempt) => dbRows("SELECT seq,kind,payload_json FROM events WHERE attempt_id = ? ORDER BY seq", attempt).map((row) => ({ ...row, payload: row.payload_json ? JSON.parse(row.payload_json) : null }));
  const read = (expression) => page.evaluate(expression, true);
  const snapshot = () => read("window.goalportCore.snapshot()");
  const command = (messageType, payload, requestId = randomUUID()) => read(`window.goalportCore.command(${JSON.stringify({ protocolVersion: "goalport.ipc.v2", requestId, entityVersion: 0, messageType, payload })})`);
  const body = () => read("document.body.innerText");
  // Connect wait contract: the app's PUBLISHED state (data-connection on
  // .goalport-shell) decides; the visible "Core connected" text is only a
  // fallback — CSS hides it below 1020px-wide viewports (the GitHub runner
  // virtual display), where innerText never carries it. Never a bare
  // text wait again.
  const connectedUi = async () => {
    try { return Boolean(await read(connectedUiExpression())); } catch { return false; }
  };
  const uiAttempt = () => read("document.querySelector('[data-attempt-id]')?.dataset.attemptId");
  const desktopViewport = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };
  const viewport = () => read("(() => { const nav = document.querySelector('.campaign-nav'); const picker = document.querySelector('.runtime-picker-button'); const rect = picker?.getBoundingClientRect(); return { width: innerWidth, height: innerHeight, devicePixelRatio, navDisplay: nav ? getComputedStyle(nav).display : null, runtimePicker: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null }; })()");
  const screen = async (name) => {
    const image = await page.cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    writeFileSync(resolve(out, `${name}.png`), Buffer.from(image.data, "base64"));
    writeFileSync(resolve(out, `${name}.txt`), await body());
  };
  const clickFound = async (finderJs) => {
    await read(`(() => { const el = ${finderJs}; if (!el) throw Error('control missing'); if (el.disabled) throw Error('control disabled'); el.scrollIntoView({block:'center',inline:'center'}); return true; })()`);
    await sleep(50);
    const point = await read(`(${clickPointFor.toString()})(${finderJs})`);
    await page.cdp("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
    await page.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
  };
  const click = (selector, exactText) => clickFound(`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(e => ${exactText ? `e.textContent.trim() === ${JSON.stringify(exactText)}` : "true"})`);
  const fill = async (selector, text) => {
    await click(selector);
    await page.cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
    await page.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
    await page.cdp("Input.insertText", { text });
  };
  const pickRuntime = async (name, scope = "composer") => {
    const root = scope === "draft" ? ".draft-runtime-picker" : ".composer-dock .runtime-picker";
    await click(`${root} button[aria-label='Select Runtime']`);
    const finder = `Array.from(document.querySelectorAll('${root} .runtime-picker-item')).find(e => e.querySelector('strong')?.textContent.trim() === ${JSON.stringify(name)})`;
    await until(`${name} runtime option visible`, () => read(`Boolean(${finder})`));
    await clickFound(finder);
  };
  const notice = () => read("(() => { const banner = document.querySelector('.status-banners .banner-notice'); return banner ? { sentence: banner.innerText.split('\\n')[0], technical: banner.querySelector('.technical-details-pre')?.textContent ?? null } : null; })()");
  const dismissNotice = async () => {
    if (await read("Boolean(document.querySelector('.status-banners .banner-notice'))")) {
      await click("button[aria-label='Dismiss notification']");
      await until("notice dismissed", () => read("Boolean(!document.querySelector('.status-banners .banner-notice'))"));
    }
  };
  const openNoticeDetails = async () => {
    const summary = ".status-banners .banner-notice .technical-details > summary";
    if (await read(`Boolean(document.querySelector(${JSON.stringify(summary)}))`)) {
      await click(summary);
      await until("technical disclosure open", () => read("Boolean(document.querySelector('.status-banners .banner-notice .technical-details[open]'))"));
    }
  };
  const openInspector = async () => {
    if (!(await read("Boolean(document.querySelector('.inspector[data-open=\"true\"]'))"))) await click("button[aria-label='Open details panel']");
    await until("session details open", () => read("Boolean(document.querySelector('.inspector[data-open=\"true\"]'))"));
  };
  const closeInspector = async () => {
    await click("button[aria-label='Close details panel']");
    await until("session details closed", () => read("Boolean(!document.querySelector('.inspector[data-open=\"true\"]'))"));
  };
  const composerProbe = "(() => { const button = document.querySelector('.composer button[aria-label=\"Send message\"]'); const area = document.querySelector('.composer textarea[aria-label=\"Message composer\"]'); return { disabled: button ? button.disabled : null, busy: button ? button.textContent.includes('Sending') : null, draft: area ? area.value : null, banner: Boolean(document.querySelector('.status-banners .banner-notice')) }; })()";
  // First-send: the draft is local; one start_conversation command creates the
  // whole conversation and delivers the first message exactly once.
  const startGoal = async (workspace, message, first = false) => {
    if (!first) {
      await click("button[aria-label='New goal']");
      await until("new goal draft opened", () => read("Boolean(document.querySelector('#draft-workspace'))"));
    } else {
      await until("first draft composer", () => read("Boolean(document.querySelector('#draft-workspace'))"));
    }
    await fill("#draft-workspace", workspace);
    await pickRuntime("Scenario Runtime", "draft");
    await fill("#draft-message", message);
    await until("draft ready to send", () => read("(() => { const button = document.querySelector('.draft-composer-form button[type=\"submit\"]'); return Boolean(button && !button.disabled); })()"));
    await click(".draft-composer-form button[type='submit']");
    await until(`conversation ${message}`, async () => {
      if (await read("Boolean(document.querySelector('#draft-message'))")) return false;
      const state = await snapshot();
      return state.activeCampaignId !== ""
        && state.attempt.provider === "scenario"
        && (state.productConversation?.items ?? []).some((item) => item.kind === "user-message" && item.body === message);
    });
    const state = await snapshot();
    assert.equal(normalize(state.project.workspaceRoot), normalize(workspace));
    assert.ok(state.attempt.id !== "attempt-unassigned");
    const campaign = state.campaigns.find((row) => row.id === state.activeCampaignId);
    assert.equal(campaign?.title, message, "deterministic title is the normalized first prompt");
    return state;
  };
  // Explicit Send on an existing conversation (conversation_send). Success is
  // quiet: cleared draft plus durable exact-once rows and a rendered reply —
  // the removed success banner is never waited for.
  const send = async (text, { fail = false, turnFailure = false, timeout = 20000 } = {}) => {
    const beforeAttempt = (await snapshot()).attempt.id;
    const beforeSeq = events(beforeAttempt).at(-1)?.seq ?? 0;
    await dismissNotice();
    await fill(".composer textarea[aria-label='Message composer']", text);
    await click(".composer button[aria-label='Send message']");
    await until("send disposition", async () => {
      const form = await read(composerProbe);
      return !form.busy && (fail ? form.banner === true && form.draft === text : form.draft === "");
    }, timeout);
    const draft = await read("document.querySelector('.composer textarea[aria-label=\"Message composer\"]').value");
    assert.equal(draft, fail ? text : "");
    if (!fail) assert.ok((await body()).includes(text.split("\n")[0]), "message visible in the rendered conversation");
    const state = await snapshot();
    if (!fail) {
      // A conversation already contains its first-send turn. Assert this
      // explicit turn's events, not the entire attempt's historical totals.
      const rows = events(state.attempt.id).filter((event) => state.attempt.id !== beforeAttempt || event.seq > beforeSeq);
      const user = rows.filter((event) => event.kind === "message.user" && (event.payload?.text ?? event.payload?.message) === text);
      const reply = rows.filter((event) => event.kind === "runtime.reply.delta" && event.payload?.text === text);
      assert.equal(user.length, 1, "one exact user message");
      assert.ok((state.productConversation?.items ?? []).some((item) => item.kind === "user-message" && item.body === text), "user message rendered in the product conversation");
      if (turnFailure) {
        assert.equal(reply.length, 0, "failed synthetic turn cannot fabricate a reply");
        assert.equal(rows.filter((event) => event.kind === "runtime.turn.failed").length, 1);
        assert.equal(rows.filter((event) => event.kind === "runtime.tool.activity").length, 0);
        assert.equal(rows.filter((event) => event.kind === "runtime.waiting").length, 0);
        assert.equal(rows.filter((event) => event.kind === "runtime.turn.completed").length, 0);
        await until("terminal failed attempt", async () => (await snapshot()).attempt.state === "failed", timeout);
        assert.equal((await snapshot()).attempt.state, "failed");
      } else {
        assert.equal(reply.length, 1, "one exact synthetic reply");
        assert.ok((state.productConversation?.items ?? []).some((item) => item.kind === "assistant-message" && item.body === text), "reply rendered in the product conversation");
      }
    }
    return state;
  };
  const assertNoNativeChildren = () => {
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `@(Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${Number(coreIdentity.pid)}' | Where-Object { $_.Name -notmatch '^(powershell|conhost)\\.exe$' } | Select-Object ProcessId,Name,ExecutablePath) | ConvertTo-Json -Compress`], { encoding: "utf8", windowsHide: true });
    if (result.status !== 0) throw new Error(`Process preflight failed: ${result.stderr}`);
    const children = result.stdout.trim() ? JSON.parse(result.stdout) : [];
    assert.equal(Array.isArray(children) ? children.length : 1, 0, `no native provider children: ${result.stdout}`);
  };
  const start = async () => {
    const port = await new Promise((done, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(() => done(port)); });
    });
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^(GOALPORT_|OPENAI_|ANTHROPIC_|XAI_|CODEX_|CLAUDE_|GROK_)/i.test(key)) delete env[key];
    delete env.ELECTRON_RUN_AS_NODE;
    // This is ordinary app mode with empty native configuration for the normal
    // check, not the user's subscription environment. Only system tools remain.
    env.USERPROFILE = nativeHome; env.HOME = nativeHome;
    env.APPDATA = resolve(nativeHome, "AppData/Roaming"); env.LOCALAPPDATA = resolve(nativeHome, "AppData/Local");
    env.PATH = [resolve(env.SystemRoot || "C:/Windows", "System32"), resolve(env.SystemRoot || "C:/Windows", "System32/WindowsPowerShell/v1.0")].join(";");
    for (const dir of [env.APPDATA, env.LOCALAPPDATA, appDataRoot]) mkdirSync(dir, { recursive: true });
    for (const folder of [packageRoot, ...env.PATH.split(";"), env.SystemRoot || "C:/Windows"]) {
      for (const provider of ["codex", "claude", "grok"]) for (const ext of [".exe", ".cmd", ".bat"]) assert.equal(existsSync(resolve(folder, provider + ext)), false, "native executable absent from smoke search path");
    }
    logFd = openSync(resolve(out, "electron.log"), "a");
    stage = "spawn-electron";
    child = spawn(resolve(packageRoot, "GoalPort.exe"), [normal ? "--data-dir" : "--test-profile", profile, "--user-data-dir", appDataRoot, `--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1"], { cwd: packageRoot, env, stdio: ["ignore", logFd, logFd], windowsHide: true });
    child.once("error", (error) => { report.launchError = error.message; save(); });
    stage = "attach-cdp";
    page = await attachGoalPort(port);
    // --- Phase-aware bootstrap observation ---------------------------------
    // A startup classification bug must surface as the structured bootstrap
    // refusal it is (phase/kind/headline/original inspect trace), never be
    // compressed into a "Timed out: connected packaged UI". The observation
    // watches the bootstrap state, the process state and the Core-connected
    // signal in parallel: an error phase fails IMMEDIATELY with its facts, a
    // process exit fails with the last observed state, and only after
    // bootstrap done does the driver go on waiting for Core connected.
    stage = "bootstrap-observe";
    const bootstrapStartedAt = Date.now();
    let lastBootstrapState = null;
    let bootstrapExit = "timeout"; // "done" | "connected" | "timeout"
    const bootstrapDeadline = bootstrapStartedAt + 30000;
    while (Date.now() < bootstrapDeadline) {
      if (child.exitCode !== null) {
        const exited = new Error(`packaged app exited with code ${child.exitCode} during profile bootstrap`);
        exited.bootstrapFailure = { phase: "exited", exitCode: child.exitCode, waitedMs: Date.now() - bootstrapStartedAt, lastBootstrapState: lastBootstrapState };
        throw exited;
      }
      let state = null;
      try { state = await read("window.goalportCore.bootstrapCurrent()"); } catch { /* renderer page not attached yet */ }
      if (state) lastBootstrapState = state;
      if (state?.phase === "error") {
        const facts = {
          phase: "error",
          kind: state.kind ?? null,
          headline: state.headline ?? null,
          message: sanitizeDiagnostic(String(state.message ?? ""), [scratch, profile, out, ...WORKSPACE_PRIVATE_PATHS]),
          waitedMs: Date.now() - bootstrapStartedAt,
          originalProfileInspect: state.diagnostics?.originalProfileInspect ?? null
        };
        const refused = new Error(`bootstrap refused: ${facts.kind ?? "unknown"} — ${facts.headline ?? ""} (${facts.waitedMs} ms after spawn)`);
        refused.bootstrapFailure = facts;
        throw refused;
      }
      if (state?.phase === "done") { bootstrapExit = "done"; break; }
      // A build without a bootstrap channel still reports connected honestly;
      // connected renderer work implies the profile was settled.
      if (await connectedUi()) { bootstrapExit = "connected"; break; }
      await sleep(100);
    }
    if (bootstrapExit === "timeout") {
      const waitedMs = Date.now() - bootstrapStartedAt;
      const failure = new Error(
        lastBootstrapState
          ? `Timed out waiting for the profile bootstrap; phase=${lastBootstrapState.phase} after ${waitedMs} ms`
          : "Timed out waiting for the profile bootstrap; no bootstrap state was ever observable"
      );
      // Still checking (or unobservable) after the window: report the elapsed
      // time and the ORIGINAL startup inspection trace — the fact that matters.
      failure.bootstrapFailure = {
        phase: lastBootstrapState?.phase ?? "unobservable",
        waitedMs,
        lastBootstrapState,
        originalProfileInspect: lastBootstrapState?.diagnostics?.originalProfileInspect ?? null
      };
      throw failure;
    }
    report.bootstrapObservation = { phase: bootstrapExit === "done" ? "done" : (lastBootstrapState?.phase ?? "connected"), waitedMs: Date.now() - bootstrapStartedAt };
    // Structural renderer observation at the moment the bootstrap finished —
    // available whether the connect wait succeeds or not.
    try {
      report.bootstrapObservation.renderer = await read("(() => ({ readyState: document.readyState, rootChildren: document.getElementById('root')?.childElementCount ?? null, electronFlag: window.__GOALPORT_ELECTRON__ === true, bootstrapChannel: typeof window.goalportCore?.onBootstrapState === 'function', bootShell: Boolean(document.querySelector('.boot-shell')), shellConnection: document.querySelector('.goalport-shell')?.dataset.connection ?? null, titleBar: document.querySelector('.titlebar')?.innerText?.slice(0, 160) ?? null }))()");
    } catch { /* an early observation is best-effort */ }
    stage = "connected packaged UI";
    try {
      await until("connected packaged UI", connectedUi);
    } catch (error) {
      // A bare timeout is exactly how a renderer-side runner difference got
      // compressed away before. Attach the page's actual state so the next
      // look sees WHERE the renderer is stuck instead of guessing.
      const observation = {};
      try { observation.bodyPreview = sanitizeDiagnostic(((await body()) || "").slice(0, 500), [scratch, profile, out, ...WORKSPACE_PRIVATE_PATHS]); } catch (observationError) { observation.bodyPreview = `unavailable: ${String(observationError.message || observationError).slice(0, 120)}`; }
      try { observation.bootstrapCurrent = await read("window.goalportCore.bootstrapCurrent()"); } catch (observationError) { observation.bootstrapCurrent = `unavailable: ${String(observationError.message || observationError).slice(0, 120)}`; }
      try { observation.directSnapshot = await read("(async () => { const s = await window.goalportCore.snapshot(); return { connection: s?.connection ?? null, notice: s?.notices?.[0] ?? null }; })()"); } catch (observationError) { observation.directSnapshot = `unavailable: ${String(observationError.message || observationError).slice(0, 120)}`; }
      try { observation.renderer = await read("(() => ({ readyState: document.readyState, rootChildren: document.getElementById('root')?.childElementCount ?? null, electronFlag: window.__GOALPORT_ELECTRON__ === true, bootstrapChannel: typeof window.goalportCore?.onBootstrapState === 'function', bootShell: Boolean(document.querySelector('.boot-shell')), bootstrapScreen: Boolean(document.querySelector('.bootstrap-screen')), shellConnection: document.querySelector('.goalport-shell')?.dataset.connection ?? null, titleBar: document.querySelector('.titlebar')?.innerText?.slice(0, 160) ?? null }))()"); } catch (observationError) { observation.renderer = `unavailable: ${String(observationError.message || observationError).slice(0, 120)}`; }
      const structured = new Error(`${error.message}; renderer observation: ${JSON.stringify(observation).slice(0, 2000)}`);
      structured.bootstrapFailure = { phase: "connected-timeout", waitedMs: Date.now() - bootstrapStartedAt, rendererObservation: observation };
      throw structured;
    }
    // --- Storage-boundary assertions (after connect) -----------------------
    // The durable profile root carries ONLY durable storage-contract names; a
    // Chromium entry of ANY name (known or brand new) here is a boundary
    // violation. The allowed set is GoalPort-owned durable files only: the
    // marker, the SQLite database and its sidecars, the Core-side logs and
    // the launch-ready receipt (`goalport.sqlite.launch-ready`, the product
    // receipt Core commits next to the database — product_receipts.rs
    // `launch_ready_path`), plus the import journal/staging/backups. The
    // browser-state namespace exists separately, inside the relocated app
    // root (normal) or the test-owned scratch (synthetic), and the real
    // %APPDATA% GoalPort folder is untouched.
    stage = "storage-boundary";
    const durableAllowed = (name) => name === "goalport-profile.json" || name === "goalport.sqlite" || name === "goalport.sqlite-wal" || name === "goalport.sqlite-shm"
      || name === "goalport.sqlite.launcher.log" || name === "goalport.sqlite.core.log" || name === "goalport.sqlite.launch-ready"
      || name === "import-journal.json" || name === "backups" || name.startsWith(".import-staging-");
    const durableNames = readdirSync(profile).sort();
    const durableUnexpected = durableNames.filter((name) => !durableAllowed(name));
    assert.deepEqual(durableUnexpected, [], `durable profile root must contain only durable storage-contract entries; unexpected: ${JSON.stringify(durableUnexpected)}`);
    assert.notEqual(normalize(profile), normalize(browserStateDirectory), "durable and browser-state roots must be distinct paths");
    const browserNames = readdirSync(browserStateDirectory).sort();
    assert.ok(browserNames.length > 0, "browser-state namespace exists and is non-empty");
    assert.ok(
      normal ? browserStateDirectory.toLowerCase().startsWith(appDataRoot.toLowerCase()) : browserStateDirectory.toLowerCase().startsWith(dirname(profile).toLowerCase()),
      normal ? "normal browser state stays inside the relocated app-data root" : "synthetic browser state stays inside the test-owned scratch"
    );
    const realGoalPortPost = realGoalPortEntries();
    assert.deepEqual(realGoalPortPost, realGoalPortPre, "the real %APPDATA% GoalPort folder must be untouched by this smoke");
    if (!report.storageBoundary) {
      report.storageBoundary = { durableRoot: profile, browserStateRoot: browserStateDirectory, durableEntries: durableNames, browserEntries: browserNames, realAppDataTouched: false };
      marker("storage-boundary/durable-only-and-browser-state-separated", {
        durableEntries: durableNames.length, browserEntries: browserNames.length,
        browserNamespace: normal ? "app-data-root" : "test-owned-scratch", realAppDataUntouched: true
      });
    }
    const initialViewport = await viewport();
    await page.cdp("Emulation.setDeviceMetricsOverride", desktopViewport);
    await until("desktop Runtime controls visible", async () => {
      const current = await viewport();
      return current.width === desktopViewport.width && current.navDisplay !== "none" && current.runtimePicker?.width > 0;
    });
    const actualViewport = await viewport();
    (report.viewportStarts ??= []).push({ initial: initialViewport, actual: actualViewport });
    console.log(`PASS desktop viewport ${JSON.stringify({ initial: initialViewport, actual: actualViewport })}`);
    if (failBeforeReceipt) {
      stage = "forced-before-startup-receipt";
      throw new Error("intentional smoke failure before assigning the renderer startup receipt");
    }
    const info = await read("window.goalportCore.appInfo()");
    assert.equal(info.version, identity.version);
    assert.equal(info.testMode, !normal);
    assert.equal(normalize(info.dataPath), normalize(profile));
    assert.equal(normalize(info.browserStatePath), normalize(browserStateDirectory), "app-info reports the separate browser-state namespace (proves --user-data-dir relocation took effect)");
    const receipt = await command("get_startup_receipt", {});
    assert.equal(receipt.accepted, true);
    coreIdentity = receipt.receipt.core;
    assert.equal(coreIdentity.executableSha256, identity.artifacts.find((entry) => entry.path === "resources/goalport-core.exe").sha256);
    assert.equal(normalize(coreIdentity.executablePath), normalize(resolve(packageRoot, "resources/goalport-core.exe")));
    assert.equal(normalize(receipt.receipt.databaseIdentity), normalize(resolve(profile, "goalport.sqlite")));
    const launchMode = await until("launcher creation mode", () => {
      const launchModes = [...readFileSync(resolve(profile, "goalport.sqlite.launcher.log"), "utf8").matchAll(/Core launch mode: (breakaway-requested|inherited-job-fallback); pid=(\d+)/g)];
      return launchModes.findLast((match) => Number(match[2]) === coreIdentity.pid)?.[1];
    });
    assert.ok(launchMode, "launcher creation mode is bound to this ready Core PID");
    report.launcherCreationMode = launchMode;
    console.log(`PASS launcher creation mode ${launchMode} is bound to current Core`);
    assertNoNativeChildren();
    report.appInfo = info; report.coreIdentity = coreIdentity; report.startupReceipt = receipt.receipt; save();
  };
  const closeWindow = async () => {
    // The app close entry lives in the title-bar application menu; the native
    // overlay X is the other close path and requestClose shares the controlled flow.
    await click("button[aria-label='Application menu']");
    await click("div[role='menu'] button[aria-label='Close window']");
    await sleep(150);
    if (child.exitCode === null) {
      const text = await body().catch(() => "");
      if (text.includes("Continue running in the background?")) await click(".close-choice-dialog button", "Continue in background");
    }
    await until("Electron close", () => child.exitCode !== null, 15000);
    page?.close(); page = null;
    closeSync(logFd); logFd = undefined;
  };

  try {
    await start();
    // --- First-run boundary: a draft exists, nothing durable does. ----------
    const empty = await snapshot();
    assert.equal(empty.preview, false);
    assert.deepEqual(counts(), zeroCounts());
    assert.equal(empty.attempt.id, "attempt-unassigned");
    const emptyState = await read("(() => ({ draft: Boolean(document.querySelector('.draft-composer-form')), workspace: Boolean(document.querySelector('#draft-workspace')), message: Boolean(document.querySelector('#draft-message')), picker: Boolean(document.querySelector('.draft-runtime-picker button[aria-label=\"Select Runtime\"]')), sendDisabled: document.querySelector('.draft-composer-form button[type=\"submit\"]')?.disabled ?? null, navEmpty: document.body.innerText.includes('No goals yet') }))()");
    assert.equal(emptyState.draft, true, "draft-first composer is present before any goal");
    assert.equal(emptyState.workspace, true, "draft workspace field present");
    assert.equal(emptyState.message, true, "draft message field present");
    assert.equal(emptyState.sendDisabled, true, "draft Send disabled until workspace+Runtime+message are ready");
    assert.equal(emptyState.navEmpty, true, "navigation shows no goals yet");
    await screen("01-empty-draft");
    marker("ui-cdp+db/empty-draft-zero-durable-rows", { draftControls: emptyState, counts: counts(), superseded: "old no-composer/no-goal assertion" });

    // --- Synthetic firewall BEFORE any row exists: a native first-send must
    // --- refuse before campaign/task/attempt/input and start no process.
    if (!normal) {
      const refused = [];
      for (const provider of ["codex", "claude", "grok"]) {
        const denied = await command("start_conversation", { workspaceRoot: workspaceA, provider, message: `RC ${provider} refused native first-send` });
        assert.equal(denied.goalportRejected, true);
        assert.match(denied.error, /test profile permits only the in-process Scenario Runtime/i);
        refused.push({ provider, error: denied.error });
      }
      assert.deepEqual(counts(), zeroCounts());
      assertNoNativeChildren();
      marker("api/synthetic-start-conversation-firewall-before-any-rows", { refused, counts: counts(), nativeChildren: 0 });
    }

    // --- Invalid workspace refusal preserves the draft and writes nothing. --
    await fill("#draft-workspace", resolve(scratch, "does-not-exist"));
    await pickRuntime("Scenario Runtime", "draft");
    await fill("#draft-message", "Keep this failed draft");
    await click(".draft-composer-form button[type='submit']");
    await until("invalid workspace refusal", () => read("Boolean(document.querySelector('.draft-composer-form .dialog-note[role=\"alert\"]'))"));
    assert.equal(await read("document.querySelector('#draft-message').value"), "Keep this failed draft");
    assert.equal(await read("document.querySelector('#draft-workspace').value"), resolve(scratch, "does-not-exist"));
    const draftRefusal = {
      visible: await read("document.querySelector('.draft-composer-form .dialog-note[role=\"alert\"]').innerText"),
      technical: await read("document.querySelector('.draft-composer-form .dialog-note[role=\"alert\"] .technical-details-pre')?.textContent ?? null")
    };
    assert.match(draftRefusal.technical ?? "", /workspaceRoot must name an existing directory/);
    assert.deepEqual(counts(), zeroCounts());
    await screen("02-invalid-workspace-refusal");
    marker("ui-cdp+db/invalid-workspace-refusal-preserves-draft", { refusal: draftRefusal, counts: counts() });

    // --- FIRST-SEND: one command creates exactly one conversation. ---------
    const goalA = `RC ${report.mode} Campaign A first goal`;
    await fill("#draft-workspace", workspaceA);
    await fill("#draft-message", goalA);
    await click(".draft-composer-form button[type='submit']");
    await until(`conversation ${goalA} created by first send`, async () => {
      if (await read("Boolean(document.querySelector('#draft-message'))")) return false;
      const state = await snapshot();
      return state.activeCampaignId !== "" && (state.productConversation?.items ?? []).some((item) => item.kind === "user-message" && item.body === goalA);
    });
    const first = await snapshot();
    const afterFirst = counts();
    assert.equal(afterFirst.projects, 1, "one project");
    assert.equal(afterFirst.campaigns, 1, "one campaign");
    assert.equal(afterFirst.tasks, 1, "one root task");
    assert.equal(afterFirst.attempts, 1, "one attempt");
    assert.equal(afterFirst.conversation_requests, 1, "one orchestration request");
    assert.equal(first.attempt.provider, "scenario");
    assert.equal(normalize(first.project.workspaceRoot), normalize(workspaceA));
    const requestA = dbRows("SELECT request_id,campaign_id,task_id,attempt_id,phase FROM conversation_requests")[0];
    assert.equal(requestA.phase, "succeeded");
    assert.equal(requestA.campaign_id, first.activeCampaignId);
    assert.equal(requestA.task_id, first.activeTask.id);
    assert.equal(requestA.attempt_id, first.attempt.id);
    const firstAttempt = first.attempt.id;
    const rowsA = events(firstAttempt);
    assert.equal(rowsA.filter((event) => event.kind === "message.user" && event.payload?.text === goalA).length, 1, "reserved first message recorded exactly once");
    assert.equal(rowsA.filter((event) => event.kind === "runtime.reply.delta" && event.payload?.text === goalA).length, 1, "one synthetic reply to the first message");
    assert.equal((await read("document.querySelectorAll('.campaign-item').length")), 1, "one goal in navigation");
    await screen("03-first-send-created");
    marker("ui-cdp+db/first-send-creates-one-conversation-atomically", { campaignId: first.activeCampaignId, taskId: first.activeTask.id, attemptId: firstAttempt, conversationRequest: requestA, counts: afterFirst, superseded: "old create-then-select two-step assertions" });

    // --- Same-binding reselect is idempotent (no second attempt). ----------
    const beforeReselect = counts();
    await pickRuntime("Scenario Runtime");
    await until("Scenario selection reused", async () => {
      const state = await snapshot();
      return state.attempt.id === firstAttempt && state.attempt.provider === "scenario" && (await uiAttempt()) === firstAttempt;
    });
    await sleep(300);
    assert.equal((await snapshot()).attempt.id, firstAttempt);
    assert.equal(counts().attempts, beforeReselect.attempts);
    marker("ui-cdp/same-binding-reselect-keeps-attempt", { attemptId: firstAttempt });

    // --- Runtime conflict through the inline picker: existing binding kept. -
    await pickRuntime("Codex");
    await until("visible binding conflict notice", () => read("Boolean(document.querySelector('.status-banners .banner-notice'))"));
    const conflict = await notice();
    assert.match(conflict.sentence, /GoalPort could not complete that action\./);
    assert.match(conflict.technical ?? "", /already bound to a different Runtime binding/);
    await openNoticeDetails();
    assert.match(await body(), /already bound to a different Runtime binding/);
    assert.equal((await snapshot()).attempt.id, firstAttempt);
    assert.equal(counts().attempts, beforeReselect.attempts);
    await screen("04-runtime-conflict");
    await pickRuntime("Scenario Runtime");
    await until("successful reselect clears refusal", () => read("Boolean(!document.querySelector('.status-banners .banner-notice'))"));
    marker("ui-cdp/provider-conflict-retains-runtime-and-reselect-clears-error", { conflict, attemptId: firstAttempt, attempts: counts().attempts });

    // --- Quiet success: exact Unicode message/reply once, draft cleared. ---
    const messageA = `RC ${report.mode} exact message · 中文 "quotes"\nsecond line <&>`;
    const beforeQuiet = counts();
    await send(messageA);
    assert.equal(counts().commands, beforeQuiet.commands + 1, "one send command for the quiet send");
    assert.equal(await read("Boolean(document.querySelector('.status-banners .banner-notice'))"), false, "quiet success raises no banner");
    await screen("05-message-fidelity");
    marker("ui-cdp+db/quiet-exact-unicode-message-once", { attemptId: firstAttempt, commands: counts().commands, superseded: "old Message-recorded-for-task banner wait" });

    if (normal) {
      const started = Date.now();
      await send("RC-MARKER-FORCE-FAIL RC-MARKER-HOLD RC-MARKER-TURN-FAIL normal literal");
      assert.ok(Date.now() - started < 7000, "normal HOLD marker must be inert");
      marker("ui-cdp/normal-failure-hold-markers-are-ordinary-text", { elapsedMs: Date.now() - started });
    } else {
      // Failed send keeps the draft; the exact refusal is visible and durable.
      await send("RC-MARKER-FORCE-FAIL isolated failure", { fail: true });
      const failedNotice = await notice();
      assert.match(failedNotice.technical ?? "", /RC-MARKER-FORCE-FAIL/);
      await openNoticeDetails();
      assert.match(await body(), /RC-MARKER-FORCE-FAIL/);
      const failRows = events(firstAttempt);
      assert.ok(failRows.filter((event) => event.kind === "runtime.send.failed" && String(event.payload?.error).includes("RC-MARKER-FORCE-FAIL")).length >= 1, "durable failure reason recorded");
      assert.ok(dbRows("SELECT * FROM commands WHERE attempt_id=? AND state IN ('Failed','FAILED')", firstAttempt).length > 0);
      assert.equal((await snapshot()).attempt.id, firstAttempt, "failed send keeps the same attempt");
      await screen("06-failed-send-retained");
      await send("RC successful manual continuation after failure");
      assert.equal((await snapshot()).attempt.id, firstAttempt);
      marker("ui-cdp+db/failed-send-keeps-input-next-explicit-send-succeeds", { refusal: failedNotice, attemptId: firstAttempt });
    }

    // --- Independent second goal, including its own first message. ---------
    const goalB = `RC ${report.mode} Campaign B first goal`;
    const second = await startGoal(workspaceB, goalB);
    assert.notEqual(second.activeCampaignId, first.activeCampaignId);
    assert.notEqual(second.activeTask.id, first.activeTask.id);
    assert.notEqual(second.attempt.id, firstAttempt);
    const secondAttempt = second.attempt.id;
    assert.equal(events(secondAttempt).filter((event) => event.kind === "message.user" && event.payload?.text === goalB).length, 1, "independent goal carries its own initial message");
    assert.equal(events(firstAttempt).filter((event) => event.kind === "message.user" && event.payload?.text === goalB).length, 0);
    marker("ui-cdp+db/independent-campaign-own-runtime-and-first-message", { campaignId: second.activeCampaignId, taskId: second.activeTask.id, attemptId: secondAttempt });

    if (!normal) {
      // Terminal rollover through the UI as implemented (picker), plus the
      // change-runtime native admission firewall on the terminal attempt.
      await send("RC-MARKER-TURN-FAIL isolated terminal Attempt", { turnFailure: true });
      const bTerminal = (await snapshot()).attempt.id;
      assert.equal(bTerminal, secondAttempt);
      const beforeFirewall = counts();
      const firewallRefusals = [];
      for (const provider of ["codex", "claude", "grok"]) {
        const denied = await command("select_runtime", { provider, campaignId: second.activeCampaignId, taskId: second.activeTask.id, attemptId: bTerminal });
        assert.equal(denied.goalportRejected, true);
        assert.match(denied.error, /test profile permits only the in-process Scenario Runtime/i);
        const explicit = await command("select_runtime", { provider, campaignId: second.activeCampaignId, taskId: second.activeTask.id, attemptId: bTerminal, executable: resolve(scratch, "never-start.exe") });
        assert.equal(explicit.goalportRejected, true);
        assert.match(explicit.error, /test profile permits only the in-process Scenario Runtime/i);
        firewallRefusals.push({ provider, error: denied.error });
      }
      assert.deepEqual(counts(), beforeFirewall, "refused change-runtime admissions write nothing");
      assertNoNativeChildren();
      marker("api/select-runtime-native-admission-firewall-on-terminal-attempt", { refusals: firewallRefusals, counts: counts(), nativeChildren: 0, superseded: "old Scenario-only probes against a runtime-less campaign" });

      await pickRuntime("Scenario Runtime");
      await until("rollover replacement selected", async () => {
        const state = await snapshot();
        return state.attempt.id !== bTerminal && state.attempt.provider === "scenario";
      });
      const bReplacement = (await snapshot()).attempt.id;
      assert.equal(events(bReplacement).filter((event) => event.kind === "attempt.created" && event.payload?.rolledFrom === bTerminal).length, 1, "replacement records rolledFrom lineage");
      assert.equal(dbRows("SELECT COUNT(*) AS n FROM attempts WHERE task_id=?", second.activeTask.id)[0].n, 2, "terminal source plus one replacement");
      marker("ui-cdp+db/terminal-rollover-via-runtime-picker", { terminal: bTerminal, replacement: bReplacement });
      await send("RC new Attempt after terminal rollover");
    } else {
      await send("RC independent Campaign B first message");
    }

    if (!normal) {
      // Third goal; its terminal attempt carries the concurrent cross-provider
      // race proof. The current picker serializes selections (the list closes
      // on choose), so the Core race is exercised with two concurrent raw
      // select_runtime commands, explicitly labelled as an API probe.
      const goalC = "RC synthetic Campaign C first goal";
      const third = await startGoal(workspaceB, goalC);
      const thirdTaskId = third.activeTask.id;
      await send("RC-MARKER-TURN-FAIL isolated terminal Attempt C", { turnFailure: true });
      const terminal = (await snapshot()).attempt.id;
      const race = await read(`(async () => {
        const request = (provider) => window.goalportCore.command({ protocolVersion: "goalport.ipc.v2", requestId: crypto.randomUUID(), entityVersion: 0, messageType: "select_runtime", payload: { provider, campaignId: ${JSON.stringify(third.activeCampaignId)}, taskId: ${JSON.stringify(thirdTaskId)}, attemptId: ${JSON.stringify(terminal)} } });
        const scenario = request("scenario");
        const codex = request("codex");
        return { scenario: await scenario, codex: await codex };
      })()`);
      assert.equal(race.scenario.goalportRejected ?? false, false, "same-provider rollover is admitted");
      assert.equal(race.scenario.accepted, true);
      assert.equal(race.codex.goalportRejected, true, "cross-provider race request is refused");
      assert.match(race.codex.error, /already bound to a different Runtime binding/);
      const live = dbRows("SELECT * FROM attempts WHERE task_id=? AND state IN ('ACTIVE','AWAITING_REVIEW','Active','AwaitingReview')", thirdTaskId);
      assert.equal(live.length, 1, "only one live replacement");
      const replacement = live[0].id;
      assert.notEqual(replacement, terminal);
      assert.equal(live[0].provider, "scenario");
      assert.equal(events(replacement).filter((event) => event.kind === "attempt.created" && event.payload?.rolledFrom === terminal).length, 1, "race replacement records lineage");
      assert.equal(dbRows("SELECT COUNT(*) AS n FROM attempts WHERE task_id=?", thirdTaskId)[0].n, 2, "terminal source plus exactly one replacement");
      assertNoNativeChildren();
      await screen("07-cross-provider-race");
      marker("api+db/concurrent-cross-provider-race-one-replacement-exact-refusal", {
        terminal, replacement, scenarioAccepted: race.scenario.accepted === true, codexRefusal: race.codex.error, attemptsForTask: 2, nativeChildren: 0,
        probe: "two concurrent raw select_runtime commands; the UI picker serializes and cannot issue two selections in one task",
        superseded: "old two-button one-task UI race"
      });
      await until("race replacement visible in UI", async () => (await snapshot()).attempt.id === replacement);
      await send("RC new Attempt after terminal race");

      // --- Delayed duplicate send, current-goal switch and exact replay. ---
      const campaignButton = (title) => read(`Array.from(document.querySelectorAll('.campaign-item')).find(e => e.querySelector('strong')?.textContent.trim() === ${JSON.stringify(title)})?.textContent.trim()`);
      const cAttemptBeforeHold = (await snapshot()).attempt.id;
      const cBaseline = {
        counts: counts(),
        cUserMessages: events(cAttemptBeforeHold).filter((event) => event.kind === "message.user").length
      };
      await click(".campaign-item", await campaignButton(goalB));
      await until("return to Campaign B", async () => (await snapshot()).activeCampaignId === second.activeCampaignId);
      const heldTarget = await snapshot();
      const heldText = "RC-MARKER-HOLD delayed message for Campaign B";
      await fill(".composer textarea[aria-label='Message composer']", heldText);
      await read("window.__goalportCommandTrace = []");
      await click(".composer button[aria-label='Send message']");
      // A duplicate activation while the send is executing must not issue a
      // second command (disabled primary action + in-flight guard).
      await read("document.querySelector('.composer button[aria-label=\"Send message\"]').click()");
      await until("send still pending with one issued command", async () => {
        const pending = await read(composerProbe);
        const trace = await read("window.__goalportCommandTrace.filter(x => x.messageType === 'conversation_send')");
        return pending.disabled === true && trace.filter((entry) => entry.phase === "issued").length === 1;
      });
      await click(".campaign-item", await campaignButton(goalC));
      await until("latest Campaign C choice wins", async () => (await snapshot()).activeCampaignId === third.activeCampaignId && (await read("document.querySelector('[data-campaign-id]')?.dataset.campaignId")) === third.activeCampaignId);
      const trace = await read("window.__goalportCommandTrace");
      const sends = trace.filter((entry) => entry.phase === "issued" && entry.messageType === "conversation_send");
      assert.equal(sends.length, 1, "duplicate click issues only one send");
      assert.equal(sends[0].campaignId, second.activeCampaignId);
      assert.equal(sends[0].attemptId, heldTarget.attempt.id);
      await until("held message delivered once to its own conversation", () => {
        const held = events(heldTarget.attempt.id);
        return held.filter((event) => event.kind === "message.user" && event.payload?.text === heldText).length === 1
          && held.filter((event) => event.kind === "runtime.reply.delta" && event.payload?.text === heldText).length === 1;
      }, 30000);
      // Replay of the exact UI command (type, payload, requestId) while another
      // conversation is displayed is refused fail-closed by the current Core
      // (the old global duplicate acknowledgement is a superseded contract).
      const beforeReplay = counts();
      const replayRefused = await command("conversation_send", { message: heldText, campaignId: second.activeCampaignId, attemptId: heldTarget.attempt.id }, sends[0].requestId);
      assert.equal(replayRefused.goalportRejected, true, "replay while another conversation is selected must not re-deliver");
      assert.match(replayRefused.error, /is not selected by Core/);
      assert.deepEqual(counts(), beforeReplay, "refused replay writes nothing");
      // With its own conversation selected again, the identical request is
      // answered from the recorded outcome: duplicate, nothing re-delivered.
      await click(".campaign-item", await campaignButton(goalB));
      await until("Campaign B selected again", async () => (await snapshot()).activeCampaignId === second.activeCampaignId);
      const replay = await command("conversation_send", { message: heldText, campaignId: second.activeCampaignId, attemptId: heldTarget.attempt.id }, sends[0].requestId);
      assert.equal(replay.accepted, true);
      assert.equal(replay.duplicate, true, "exact replay answers the recorded outcome");
      assert.deepEqual(counts(), beforeReplay);
      const heldAfterReplay = events(heldTarget.attempt.id);
      assert.equal(heldAfterReplay.filter((event) => event.kind === "message.user" && event.payload?.text === heldText).length, 1, "still exactly one delivery after replay");
      assert.equal(heldAfterReplay.filter((event) => event.kind === "runtime.reply.delta" && event.payload?.text === heldText).length, 1);
      const currentDraft = await read("document.querySelector('.composer textarea[aria-label=\"Message composer\"]').value");
      assert.equal(currentDraft, "", "already-sent Campaign B input must not appear in another conversation");
      // Only the held send may add rows: one command, nothing else durable.
      const afterDelayed = counts();
      assert.equal(afterDelayed.commands - cBaseline.counts.commands, 1, "exactly one new command row for the held send");
      for (const key of ["projects", "campaigns", "tasks", "attempts", "conversation_requests", "conversation_preferences"]) {
        assert.equal(afterDelayed[key], cBaseline.counts[key], `${key} unchanged by delayed send and replays`);
      }
      assert.equal(events(cAttemptBeforeHold).filter((event) => event.kind === "message.user").length, cBaseline.cUserMessages, "Campaign C baseline unchanged");
      assert.equal(events(cAttemptBeforeHold).filter((event) => event.kind === "message.user" && event.payload?.text === heldText).length, 0);
      await screen("08-delayed-send-new-campaign");
      marker("ui-cdp+api+db/delayed-send-goal-switch-and-exact-replay", {
        sourceCampaign: second.activeCampaignId, selectedCampaign: third.activeCampaignId,
        issued: sends, replayWhileOtherSelected: { refused: replayRefused.error }, replayAnswer: { accepted: replay.accepted, duplicate: replay.duplicate },
        counts: afterDelayed, superseded: "old send_message replay acknowledged from any selection"
      });
      await click(".campaign-item", await campaignButton(goalC));
      await until("back to Campaign C", async () => (await snapshot()).activeCampaignId === third.activeCampaignId);
      await send("RC explicit independent Campaign C input");
    }

    // --- Close/reopen: same Core, same selection, same history, no resend. --
    const beforeClose = counts();
    const beforeReopen = await snapshot();
    const oldCorePid = coreIdentity.pid;
    await screen("09-before-close");
    await closeWindow();
    await start();
    const reopened = await snapshot();
    assert.equal(coreIdentity.pid, oldCorePid);
    assert.equal(reopened.activeCampaignId, beforeReopen.activeCampaignId);
    assert.equal(reopened.attempt.id, beforeReopen.attempt.id);
    assert.deepEqual(counts(), beforeClose);
    assert.ok(reopened.timeline.some((item) => item.body?.includes("RC ")));
    assert.ok((reopened.productConversation?.items ?? []).some((item) => item.body.includes("RC ")), "product conversation survives reopen");
    await screen("10-reopened");
    await send("RC explicit message after closing and reopening");
    marker("ui-cdp+db/close-reopen-keeps-core-task-history-without-resend", { corePid: oldCorePid, countsBefore: beforeClose, countsAfterManualSend: counts() });

    // --- Responsive Session details at a narrow desktop width. -------------
    await page.cdp("Emulation.setDeviceMetricsOverride", { width: 1000, height: 800, deviceScaleFactor: 1, mobile: false });
    await until("narrow viewport applied", async () => (await viewport()).width === 1000);
    await screen("11-narrow-window");
    report.narrowLayout = { ...(await viewport()), coverage: "at 1000 CSS px the Session details drawer and composer Runtime picker stay reachable" };
    await openInspector();
    await until("runtime change affordance reachable at narrow width", () => read(`Boolean((${clickPointFor.toString()})(Array.from(document.querySelectorAll('.session-details-actions button')).find(e => e.textContent.trim() === 'Change Runtime')))`));
    await until("composer runtime picker reachable at narrow width", () => read(`Boolean((${clickPointFor.toString()})(document.querySelector('.composer-dock .runtime-picker-button')))`));
    await closeInspector();
    await page.cdp("Emulation.setDeviceMetricsOverride", desktopViewport);
    await until("desktop viewport restored", async () => (await viewport()).width === desktopViewport.width);
    assertNoNativeChildren();
    report.finalCounts = counts();
    report.attempts = dbRows("SELECT id,task_id,provider,state FROM attempts ORDER BY rowid");
    report.commands = dbRows("SELECT id,attempt_id,kind,state,payload_hash FROM commands ORDER BY rowid");
    report.events = dbRows("SELECT attempt_id,seq,kind,payload_json FROM events ORDER BY rowid");
    report.conversationRequests = dbRows("SELECT request_id,campaign_id,task_id,attempt_id,phase,source_attempt_id FROM conversation_requests ORDER BY rowid");
    report.status = "PASS";
  } catch (error) {
    report.status = "FAIL";
    report.error = sanitizeDiagnostic(error.stack || error.message, [scratch, profile, out, ...WORKSPACE_PRIVATE_PATHS]);
    if (error.bootstrapFailure) report.bootstrapFailure = error.bootstrapFailure;
    report.diagnostics = collectFailureDiagnostics({
      stage, child,
      files: { electron: resolve(out, "electron.log"), launcher: resolve(profile, "goalport.sqlite.launcher.log"), core: resolve(profile, "goalport.sqlite.core.log") },
      privatePaths: [scratch, profile, out, ...WORKSPACE_PRIVATE_PATHS]
    });
    // Bounded read-only startup-failure profile
    // diagnostics, added to (never replacing) the original failure above.
    // Each leg records its own unavailability or timeout; collection itself is
    // additionally guarded so diagnostics can never mask the real error.
    try {
      report.diagnostics.startup = await collectStartupDiagnostics({
        profileDirectory: profile,
        browserStateDirectory,
        packageRoot,
        coreExecutable: resolve(packageRoot, "resources/goalport-core.exe"),
        privatePaths: [scratch, profile, out, ...WORKSPACE_PRIVATE_PATHS],
        queryBootstrap: page ? () => page.evaluate("window.goalportCore.bootstrapCurrent()", true) : undefined
      });
    } catch (startupError) {
      report.diagnostics.startup = { available: false, error: sanitizeDiagnostic(startupError?.stack || startupError?.message || String(startupError), [scratch, profile, out, ...WORKSPACE_PRIVATE_PATHS]) };
    }
    console.error(JSON.stringify({ diagnostics: report.diagnostics }, null, 2));
    if (page) { try { await screen("failure"); } catch {} }
    throw error;
  } finally {
    if (page) {
      try { await closeWindow(); } catch { page?.close(); child?.kill(); }
    } else if (child?.exitCode === null) child.kill();
    if (logFd !== undefined) { try { closeSync(logFd); } catch {} }
    const privatePaths = [scratch, profile, out, ...WORKSPACE_PRIVATE_PATHS];
    stage = "owned-core-cleanup";
    try {
      report.cleanup.push(await cleanupOwnedCore({
        profileDirectory: profile, packageRoot,
        coreSha256: identity.artifacts.find((item) => item.path === "resources/goalport-core.exe").sha256,
        version: identity.version, mode: normal ? "normal" : "synthetic-test", startedAt: report.startedAt,
        observe: (pid) => observeProcess(pid), stop: (pid) => process.kill(pid)
      }));
    } catch (error) {
      const phase = error.phase || "cleanup";
      const detail = sanitizeDiagnostic(error.message || String(error), privatePaths);
      report.cleanup.push({ phase, error: detail, code: error.code, attempts: error.attempts, action: `retained; cleanup phase ${phase} failed` });
      report.status = "FAIL"; report.error ||= detail; process.exitCode = 1;
    }
    report.completedAt = new Date().toISOString();
    report.cleanup.push({ path: scratch, action: "retained for local inspection; contains only this smoke's package/profile/workspaces" });
    save();
    const publicPath = (value) => sanitizeDiagnostic(value, WORKSPACE_PRIVATE_PATHS);
    const summary = { status: report.status, mode: report.mode, report: publicPath(resolve(out, "report.json")), scratch: publicPath(scratch) };
    if (report.status !== "PASS") {
      // CI keeps only this bounded, redacted summary; report.json stays local.
      // A body failure has diagnostics; otherwise the run failed only in owned-Core cleanup.
      const failedStage = report.diagnostics?.stage ?? "owned-core-cleanup";
      const cleanup = report.cleanup.filter((entry) => entry.phase || entry.process).map(({ phase, error, code, attempts, action, verifiedCoreStopped }) => ({ phase, error, code, attempts, action, verifiedCoreStopped }));
      const error = String(report.error || "").split("\n")[0];
      try {
        writeFileSync(resolve(out, "failure-summary.json"), boundedFailureSummary({
          schemaVersion: 1, status: report.status, mode: report.mode, stage: failedStage, error, cleanup, stack: report.error, diagnostics: report.diagnostics,
          startup: report.diagnostics?.startup,
          steps: report.steps.map(({ name, at }) => ({ name, at })), launcherCreationMode: report.launcherCreationMode,
          version: identity.version, sourceRevision: identity.sourceRevision
        }, privatePaths));
      } catch (writeError) {
        // Report the lost summary without replacing the failure it was describing.
        console.error(`failure-summary.json could not be written: ${sanitizeDiagnostic(writeError.message, privatePaths)}`);
      }
      const brief = cleanup.map(({ attempts = [], ...entry }) => ({ ...entry, attempts: attempts.length, lastAttempt: attempts.at(-1) }));
      try {
        Object.assign(summary, JSON.parse(boundedFailureSummary({ stage: failedStage, error, cleanup: brief }, privatePaths)));
      } catch (summaryError) {
        console.error(`failure summary could not be bounded: ${sanitizeDiagnostic(summaryError.message, privatePaths)}`);
      }
    }
    console.log(JSON.stringify(summary, null, 2));
  }
}
