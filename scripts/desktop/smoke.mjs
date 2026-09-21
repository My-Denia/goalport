import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { argsFor, fileHash } from "./package.mjs";
import { verifyPackage } from "./verify-package.mjs";
import { attachGoalPort } from "../connected/v1-cdp.mjs";
import launchConfig from "../../electron/launch-config.cjs";
import { boundedFailureSummary, collectFailureDiagnostics, sanitizeDiagnostic } from "./diagnostics.mjs";
import { clickPointFor } from "./click-target.mjs";
import { cleanupOwnedCore } from "./owned-core-cleanup.mjs";
import { observeProcess } from "./process-observer.mjs";

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const normalize = launchConfig.normalizedPath;
const argv = process.argv.slice(2);
const normal = argv.includes("--normal");
const failBeforeReceipt = argv.includes("--fail-before-receipt");
const args = argsFor(argv.filter((arg) => !["--normal", "--fail-before-receipt"].includes(arg)), ["--package", "--out", "--test-profile"]);

if (args.help) {
  console.log("Usage: node scripts/desktop/smoke.mjs --package <package-directory> --out <new-evidence-directory> [--normal | --test-profile <new-absolute-profile>]\nCopies the complete RC outside source; verifies real GUI, IPC and Core with Scenario only. Node >=22.19 required.\nNormal mode uses ordinary data handling and inert markers, with empty native configuration/PATH. Default mode is explicitly synthetic-only.");
} else {
  await smoke().catch((error) => { console.error(sanitizeDiagnostic(error.stack || error, [process.env.USERPROFILE, process.env.HOME, tmpdir()])); process.exitCode = 1; });
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
  const report = {
    schemaVersion: 1, status: "RUNNING", mode: normal ? "normal" : "synthetic-test",
    startedAt: new Date().toISOString(), identity,
    originalPackage, packageRoot, scratch, profile, workspaceA, workspaceB,
    boundaryStates: ["first-run", "concurrent", "error-path", "interrupted"],
    steps: [], cleanup: [], realSubscriptionAdmission: false
  };
  const save = () => writeFileSync(resolve(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  save(); // Ownership and absent profile are recorded before the first app launch.
  cpSync(originalPackage, packageRoot, { recursive: true, errorOnExist: true });
  assert.equal(verifyPackage(packageRoot).sourceTreeSha256, identity.sourceTreeSha256);
  for (const dir of [workspaceA, workspaceB, nativeHome]) mkdirSync(dir, { recursive: true });
  let child, page, coreIdentity, logFd;
  let stage = "prepare-launch";
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
  const counts = () => Object.fromEntries(["projects", "campaigns", "tasks", "attempts", "commands", "outbox"].map((name) => [name, dbRows(`SELECT COUNT(*) AS n FROM ${name}`)[0].n]));
  const events = (attempt) => dbRows("SELECT seq,kind,payload_json FROM events WHERE attempt_id = ? ORDER BY seq", attempt).map((row) => ({ ...row, payload: row.payload_json ? JSON.parse(row.payload_json) : null }));
  const read = (expression) => page.evaluate(expression, true);
  const snapshot = () => read("window.goalportCore.snapshot()");
  const command = (messageType, payload, requestId = randomUUID()) => read(`window.goalportCore.command(${JSON.stringify({ protocolVersion: "goalport.ipc.v2", requestId, entityVersion: 0, messageType, payload })})`);
  const body = () => read("document.body.innerText");
  const uiAttempt = () => read("document.querySelector('[data-attempt-id]')?.dataset.attemptId");
  const desktopViewport = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };
  const viewport = () => read("(() => { const rail = document.querySelector('.context-rail'); const rect = document.querySelector('.runtime-row summary')?.getBoundingClientRect(); return { width: innerWidth, height: innerHeight, devicePixelRatio, railDisplay: rail ? getComputedStyle(rail).display : null, runtimeSummary: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null }; })()");
  const screen = async (name) => {
    const image = await page.cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    writeFileSync(resolve(out, `${name}.png`), Buffer.from(image.data, "base64"));
    writeFileSync(resolve(out, `${name}.txt`), await body());
  };
  const click = async (selector, exactText) => {
    const expression = `(() => { const el = Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(e => ${exactText ? `e.textContent.trim() === ${JSON.stringify(exactText)}` : "true"}); if (!el) throw Error('control missing'); if (el.disabled) throw Error('control disabled'); el.scrollIntoView({block:'center',inline:'center'}); return true; })()`;
    await read(expression);
    await sleep(50);
    const point = await read(`(${clickPointFor.toString()})(Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(e => ${exactText ? `e.textContent.trim() === ${JSON.stringify(exactText)}` : "true"}))`);
    await page.cdp("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
    await page.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
  };
  const fill = async (selector, text) => {
    await click(selector);
    await page.cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
    await page.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
    await page.cdp("Input.insertText", { text });
  };
  const openInspector = async () => {
    const state = await read("Boolean(document.querySelector('.inspector[data-open='true']'))");
    if (!state) await click("button[aria-label='Open details panel']");
    await until("inspector open", () => read("Boolean(document.querySelector('.inspector[data-open='true']'))"));
  };
  const choose = async (name) => {
    await openInspector();
    const selector = ".runtime-row summary";
    const summary = await read(`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(e=>e.querySelector('strong')?.textContent===${JSON.stringify(name)})?.textContent.trim()`);
    const open = await read(`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(e=>e.querySelector('strong')?.textContent===${JSON.stringify(name)})?.parentElement.open`);
    if (!open) await click(selector, summary);
    await click(".runtime-row button", `Select ${name}`);
  };
  const create = async (workspace, goal, first = false) => {
    if (!first) await click("button[aria-label='New goal']");
    await until("campaign form", () => read("Boolean(document.querySelector('#campaign-goal'))"));
    await fill("#project-folder", workspace);
    await fill("#campaign-goal", goal);
    await click(".first-run-dialog button[type='submit']");
    await until(`campaign ${goal}`, async () => {
      const state = await snapshot();
      return state.campaigns.some((campaign) => campaign.title === goal) && !(await read("Boolean(document.querySelector('#campaign-goal'))"));
    });
    const state = await snapshot();
    assert.equal(normalize(state.project.workspaceRoot), normalize(workspace));
    assert.equal(state.attempt.id, "attempt-unassigned");
    return state;
  };
  const send = async (text, { fail = false, turnFailure = false, timeout = 20000 } = {}) => {
    await fill("textarea[aria-label='Message composer']", text);
    await click("button[aria-label='Send message']");
    await until("send disposition", async () => {
      const content = await body();
      const form = await read("({busy:document.querySelector('button[aria-label=\"Send message\"]')?.textContent.includes('Sending'),draft:document.querySelector('textarea[aria-label=\"Message composer\"]')?.value})");
      return !form.busy && (fail ? content.includes("Core refused:") && form.draft === text : content.includes("Message recorded for task") && form.draft === "");
    }, timeout);
    const draft = await read("document.querySelector('textarea[aria-label=\"Message composer\"]').value");
    assert.equal(draft, fail ? text : "");
    const state = await snapshot();
    if (!fail) {
      const rows = events(state.attempt.id);
      const user = rows.filter((event) => event.kind === "message.user" && (event.payload?.text ?? event.payload?.message) === text);
      const reply = rows.filter((event) => event.kind === "runtime.reply.delta" && event.payload?.text === text);
      assert.equal(user.length, 1, "one exact user message");
      if (turnFailure) {
        assert.equal(reply.length, 0, "failed synthetic turn cannot fabricate a reply");
        assert.equal(rows.filter((event) => event.kind === "runtime.turn.failed").length, 1);
        assert.equal(rows.filter((event) => ["runtime.tool.activity", "runtime.waiting", "runtime.turn.completed"].includes(event.kind)).length, 0);
        assert.equal(state.attempt.state, "failed");
      } else assert.equal(reply.length, 1, "one exact synthetic reply");
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
    for (const dir of [env.APPDATA, env.LOCALAPPDATA]) mkdirSync(dir, { recursive: true });
    for (const folder of [packageRoot, ...env.PATH.split(";"), env.SystemRoot || "C:/Windows"]) {
      for (const provider of ["codex", "claude", "grok"]) for (const ext of [".exe", ".cmd", ".bat"]) assert.equal(existsSync(resolve(folder, provider + ext)), false, "native executable absent from smoke search path");
    }
    logFd = openSync(resolve(out, "electron.log"), "a");
    stage = "spawn-electron";
    child = spawn(resolve(packageRoot, "GoalPort.exe"), [normal ? "--data-dir" : "--test-profile", profile, `--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1"], { cwd: packageRoot, env, stdio: ["ignore", logFd, logFd], windowsHide: true });
    child.once("error", (error) => { report.launchError = error.message; save(); });
    stage = "attach-cdp";
    page = await attachGoalPort(port);
    await until("connected packaged UI", async () => (await body()).includes("Core connected"));
    const initialViewport = await viewport();
    await page.cdp("Emulation.setDeviceMetricsOverride", desktopViewport);
    await until("desktop Runtime controls visible", async () => {
      const current = await viewport();
      return current.width === desktopViewport.width && current.railDisplay !== "none" && current.runtimeSummary?.width > 0;
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
    const empty = await snapshot();
    assert.equal(empty.preview, false);
    assert.deepEqual(counts(), { projects: 0, campaigns: 0, tasks: 0, attempts: 0, commands: 0, outbox: 0 });
    assert.equal(empty.attempt.id, "attempt-unassigned");
    const emptyState = await read("({composer: Boolean(document.querySelector('textarea[aria-label=\"Message composer\"]')), cta: Boolean(Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim().startsWith('Start a goal')))})");
    assert.equal(emptyState.composer, false, "no goal means no composer in the DOM at all");
    assert.equal(emptyState.cta, true, "empty state owns the start-goal CTA");
    await screen("01-first-run");
    marker("empty ordinary product projection and no automatic input", { counts: counts() });

    await click("button[aria-label='New goal']");
    await until("first goal form opened by user", () => read("Boolean(document.querySelector('#project-folder'))"));
    await fill("#project-folder", resolve(scratch, "does-not-exist"));
    await fill("#campaign-goal", "Keep this failed form");
    await click(".first-run-dialog button[type='submit']");
    await until("invalid workspace refusal", () => read("Boolean(document.querySelector('.first-run-dialog [role=alert]'))"));
    assert.equal(await read("document.querySelector('#campaign-goal').value"), "Keep this failed form");
    assert.equal(counts().projects, 0);
    marker("failed first-use form preserves input and leaves no project");

    const first = await create(workspaceA, `RC ${report.mode} Campaign A`, true);
    assert.equal(counts().commands, 0);
    assert.equal(counts().attempts, 0);
    await screen("02-created-no-runtime");
    marker("workspace selection creates only Campaign and task", { campaignId: first.activeCampaignId, taskId: first.activeTask.id });

    if (!normal) {
      for (const provider of ["codex", "claude", "grok"]) {
        const denied = await command("select_runtime", { provider, campaignId: first.activeCampaignId, taskId: first.activeTask.id });
        assert.equal(denied.goalportRejected, true);
        assert.match(denied.error, /test profile permits only.*Scenario Runtime/i);
        const explicit = await command("select_runtime", { provider, campaignId: first.activeCampaignId, taskId: first.activeTask.id, executable: resolve(scratch, "never-start.exe") });
        assert.equal(explicit.goalportRejected, true);
        assert.match(explicit.error, /test profile permits only.*Scenario Runtime/i);
      }
      assert.equal(counts().attempts, 0);
      assertNoNativeChildren();
      marker("synthetic-only native admission firewall", { attemptedProviders: ["codex", "claude", "grok"], nativeChildren: 0, attempts: 0 });
    }
    await choose("Scenario Runtime");
    await until("Scenario selection", async () => (await snapshot()).attempt.provider === "scenario" && (await uiAttempt()) !== "attempt-unassigned");
    const selected = await snapshot();
    const firstAttempt = selected.attempt.id;
    const beforeReselect = counts();
    await choose("Scenario Runtime");
    await sleep(200);
    assert.equal((await snapshot()).attempt.id, firstAttempt);
    assert.equal(counts().attempts, beforeReselect.attempts);
    marker("first Runtime selection and same-binding reselect", { attemptId: firstAttempt });

    // Existing-binding conflict is safe even in normal mode; the native search
    // path is empty, and synthetic mode adds the Core-level firewall.
    await choose("Codex");
    await until("visible binding conflict", async () => /Core refused:.*different Runtime binding/s.test(await body()));
    assert.equal((await snapshot()).attempt.id, firstAttempt);
    assert.equal(counts().attempts, beforeReselect.attempts);
    await screen("03-runtime-conflict");
    await choose("Scenario Runtime");
    await until("successful reselect clears refusal", async () => !(await body()).includes("Core refused:"));
    marker("provider conflict retains existing Runtime and later reselect clears error");

    const messageA = `RC ${report.mode} exact message · 中文 "quotes"\nsecond line <&>`;
    await send(messageA);
    await screen("04-message-fidelity");
    marker("exact multiline Unicode message and reply delivered once", { attemptId: firstAttempt, commands: counts().commands });
    if (normal) {
      const started = Date.now();
      await send("RC-MARKER-FORCE-FAIL RC-MARKER-HOLD RC-MARKER-TURN-FAIL normal literal");
      assert.ok(Date.now() - started < 7000, "normal HOLD marker must be inert");
      marker("normal profile failure/hold markers are ordinary text", { elapsedMs: Date.now() - started });
    } else {
      await send("RC-MARKER-FORCE-FAIL isolated failure", { fail: true });
      assert.match(await body(), /RC-MARKER-FORCE-FAIL/);
      assert.ok(dbRows("SELECT * FROM commands WHERE attempt_id=? AND state='Failed'", firstAttempt).length > 0 || dbRows("SELECT * FROM commands WHERE attempt_id=? AND state='FAILED'", firstAttempt).length > 0);
      await screen("05-failed-send-retained");
      await send("RC successful manual continuation after failure");
      assert.equal((await snapshot()).attempt.id, firstAttempt);
      marker("failed send keeps input; next explicit send succeeds on same Attempt");
    }

    const second = await create(workspaceB, `RC ${report.mode} Campaign B`);
    assert.notEqual(second.activeCampaignId, first.activeCampaignId);
    assert.notEqual(second.activeTask.id, first.activeTask.id);
    await choose("Scenario Runtime");
    await until("second Scenario choice", async () => (await snapshot()).attempt.provider === "scenario" && (await snapshot()).attempt.id !== firstAttempt);
    const secondAttempt = (await snapshot()).attempt.id;
    marker("independent Campaign selects its own Runtime", { campaignId: second.activeCampaignId, taskId: second.activeTask.id, attemptId: secondAttempt });

    if (!normal) {
      await send("RC-MARKER-TURN-FAIL isolated terminal Attempt", { turnFailure: true });
      const terminal = (await snapshot()).attempt.id;
      assert.equal(terminal, secondAttempt);
      marker("isolated Scenario produces a true failed Attempt", { terminal, events: events(terminal).map((event) => event.kind) });
      // Open both actual Runtime sections, then issue two real button click
      // events in one renderer task so neither response can update the view.
      await openInspector();
      for (const name of ["Scenario Runtime", "Codex"]) {
        const summary = await read(`Array.from(document.querySelectorAll('.runtime-row summary')).find(e=>e.querySelector('strong')?.textContent===${JSON.stringify(name)})?.textContent.trim()`);
        const open = await read(`Array.from(document.querySelectorAll('.runtime-row summary')).find(e=>e.querySelector('strong')?.textContent===${JSON.stringify(name)})?.parentElement.open`);
        if (!open) await click(".runtime-row summary", summary);
      }
      await read("window.__goalportCommandTrace = []");
      await read("(() => { const buttons=Array.from(document.querySelectorAll('.runtime-row button')); const first=buttons.find(b=>b.textContent.trim()==='Select Scenario Runtime'); const second=buttons.find(b=>b.textContent.trim()==='Select Codex'); if(!first||!second||first.disabled||second.disabled) throw Error('race controls unavailable'); first.click(); second.click(); })()");
      await until("race conflict", async () => /Core refused:.*different Runtime binding/s.test(await body()));
      const trace = await read("window.__goalportCommandTrace.filter(x=>x.messageType==='select_runtime')");
      const issued = trace.filter((entry) => entry.phase === "issued");
      assert.equal(issued.length, 2);
      assert.deepEqual(issued.map((entry) => entry.provider), ["scenario", "codex"]);
      assert.ok(issued.every((entry) => entry.attemptId === terminal));
      assert.deepEqual(trace.slice(0, 2).map((entry) => entry.phase), ["issued", "issued"]);
      const live = dbRows("SELECT * FROM attempts WHERE task_id=? AND state IN ('Active','AwaitingReview','ACTIVE','AWAITING_REVIEW')", second.activeTask.id);
      assert.equal(live.length, 1, "only one live replacement");
      const replacement = (await snapshot()).attempt.id;
      assert.notEqual(replacement, terminal);
      assert.equal(live[0].id, replacement);
      assert.equal(live[0].provider, "scenario");
      const lineage = events(replacement).filter((entry) => entry.kind === "attempt.created" && entry.payload?.rolledFrom === terminal);
      assert.equal(lineage.length, 1);
      assert.equal(dbRows("SELECT * FROM attempts WHERE task_id=?", second.activeTask.id).length, 2);
      assertNoNativeChildren();
      await screen("06-terminal-cross-provider-race");
      marker("terminal cross-provider race has one replacement and exact conflict refusal", { terminal, replacement, trace, nativeChildren: 0 });
      await choose("Scenario Runtime");
      await until("race refusal cleared", async () => !(await body()).includes("Core refused:"));
      await send("RC new Attempt after terminal race");
    } else {
      await send("RC independent Campaign B first message");
    }

    if (!normal) {
      const third = await create(workspaceB, "RC synthetic Campaign C");
      await choose("Scenario Runtime");
      await until("third Scenario selected", async () => (await snapshot()).attempt.provider === "scenario" && (await snapshot()).activeCampaignId === third.activeCampaignId);
      const thirdAttempt = (await snapshot()).attempt.id;
      const campaignButton = async (title) => read(`Array.from(document.querySelectorAll('.campaign-item')).find(e=>e.querySelector('strong')?.textContent===${JSON.stringify(title)})?.textContent.trim()`);
      await click(".campaign-item", await campaignButton(`RC ${report.mode} Campaign B`));
      await until("return to Campaign B", async () => (await snapshot()).activeCampaignId === second.activeCampaignId);
      const heldTarget = await snapshot();
      const heldText = "RC-MARKER-HOLD delayed message for Campaign B";
      await fill("textarea[aria-label='Message composer']", heldText);
      await read("window.__goalportCommandTrace = []");
      await click("button[aria-label='Send message']");
      await read("document.querySelector('button[aria-label=\"Send message\"]').click()");
      await until("send still pending", () => read("document.querySelector('button[aria-label=\"Send message\"]').textContent.includes('Sending')"));
      await click(".campaign-item", await campaignButton("RC synthetic Campaign C"));
      await until("latest Campaign C choice wins", async () => (await snapshot()).activeCampaignId === third.activeCampaignId && (await read("document.querySelector('[data-campaign-id]')?.dataset.campaignId")) === third.activeCampaignId);
      const trace = await read("window.__goalportCommandTrace");
      const sends = trace.filter((entry) => entry.phase === "issued" && entry.messageType === "send_message");
      assert.equal(sends.length, 1, "duplicate click issues only one send");
      assert.equal(sends[0].campaignId, second.activeCampaignId);
      assert.equal(sends[0].attemptId, heldTarget.attempt.id);
      const heldEvents = events(heldTarget.attempt.id);
      assert.equal(heldEvents.filter((event) => event.kind === "message.user" && event.payload?.text === heldText).length, 1);
      assert.equal(heldEvents.filter((event) => event.kind === "runtime.reply.delta" && event.payload?.text === heldText).length, 1);
      const beforeReplay = counts();
      const replay = await command("send_message", { message: heldText, campaignId: second.activeCampaignId, taskId: heldTarget.activeTask.id, attemptId: heldTarget.attempt.id }, sends[0].requestId);
      assert.equal(replay.accepted, true);
      assert.equal(replay.duplicate, true);
      assert.deepEqual(counts(), beforeReplay);
      const currentDraft = await read("document.querySelector('textarea[aria-label=\"Message composer\"]').value");
      marker("delayed send and explicit replay retain original target and one delivery", { sourceCampaign: second.activeCampaignId, selectedCampaign: third.activeCampaignId, currentDraft, trace, counts: counts() });
      assert.equal(currentDraft, "", "already-sent Campaign B input must not appear in Campaign C");
      assert.equal(events(thirdAttempt).filter((event) => event.kind === "message.user").length, 0);
      await screen("07-delayed-send-new-campaign");
      await send("RC explicit independent Campaign C input");
    }

    const beforeClose = counts();
    const beforeReopen = await snapshot();
    const oldCorePid = coreIdentity.pid;
    await screen("07-before-close");
    await closeWindow();
    await start();
    const reopened = await snapshot();
    assert.equal(coreIdentity.pid, oldCorePid);
    assert.equal(reopened.activeCampaignId, beforeReopen.activeCampaignId);
    assert.equal(reopened.attempt.id, beforeReopen.attempt.id);
    assert.deepEqual(counts(), beforeClose);
    assert.ok(reopened.timeline.some((item) => item.body?.includes("RC ")));
    await screen("08-reopened");
    await send("RC explicit message after closing and reopening");
    marker("close/reopen keeps current Core, task and history without resend", { corePid: oldCorePid, countsBefore: beforeClose, countsAfterManualSend: counts() });
    await page.cdp("Emulation.setDeviceMetricsOverride", { width: 1000, height: 800, deviceScaleFactor: 1, mobile: false });
    await screen("09-narrow-window");
    report.narrowLayout = { ...(await viewport()), coverage: "at 1000 CSS px the inspector drawer stays reachable (fixed rc.1 gap)" };
    await openInspector();
    await until("runtime controls reachable at narrow width", () => read(`Boolean((${clickPointFor.toString()})(document.querySelector('.runtime-row summary')))`));
    await click("button[aria-label='Close details panel']");
    await page.cdp("Emulation.setDeviceMetricsOverride", desktopViewport);
    await until("desktop viewport restored", async () => (await viewport()).width === desktopViewport.width);
    assertNoNativeChildren();
    report.finalCounts = counts();
    report.attempts = dbRows("SELECT id,task_id,provider,state FROM attempts ORDER BY rowid");
    report.commands = dbRows("SELECT id,attempt_id,kind,state,payload_hash FROM commands ORDER BY rowid");
    report.events = dbRows("SELECT attempt_id,seq,kind,payload_json FROM events ORDER BY rowid");
    report.status = "PASS";
  } catch (error) {
    report.status = "FAIL";
    report.error = sanitizeDiagnostic(error.stack || error.message, [scratch, profile, out, process.env.USERPROFILE, process.env.HOME, tmpdir()]);
    report.diagnostics = collectFailureDiagnostics({
      stage, child,
      files: { electron: resolve(out, "electron.log"), launcher: resolve(profile, "goalport.sqlite.launcher.log"), core: resolve(profile, "goalport.sqlite.core.log") },
      privatePaths: [scratch, profile, out, process.env.USERPROFILE, process.env.HOME, tmpdir()]
    });
    console.error(JSON.stringify({ diagnostics: report.diagnostics }, null, 2));
    if (page) { try { await screen("failure"); } catch {} }
    throw error;
  } finally {
    if (page) {
      try { await closeWindow(); } catch { page?.close(); child?.kill(); }
    } else if (child?.exitCode === null) child.kill();
    if (logFd !== undefined) { try { closeSync(logFd); } catch {} }
    const privatePaths = [scratch, profile, out, process.env.USERPROFILE, process.env.HOME, tmpdir()];
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
    const publicPath = (value) => sanitizeDiagnostic(value, [process.env.USERPROFILE, process.env.HOME, tmpdir()]);
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
