// Screenshot acceptance driver for the background-coordination closeout
// (GAH run goalport-pr27-bg-closeout): the definite Start refusal, the unknown
// admission, the unconfirmed/revoked background job, the competing-guard
// sentence, the carried-over revise draft and the first-use New goal composer.
//
// Like scripts/preview/shot-review-fixes.mjs this is screenshot-only: it
// generates dist/shot-bg.html from the built index.html and injects the
// Electron preload port (`window.goalportCore`) BEFORE head scripts run, so the
// real renderer runs in electron mode against a page-side stub. The stub is a
// page-side port of the jsdom scopedBridge in src/interaction.test.tsx
// (snapshot/command/startCore/coordinate*/background*); it mirrors the bridge
// SEMANTICS, not the test scaffolding.
//
// The driver drives ONE preview session sequentially (one navigate per page
// shape, plus one first-use load) and FAILS (exit 1) if any state's assertion
// is not visible in the real DOM, so the shots cannot be evidence of a state
// that never rendered.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { startPreview } from "../preview/harness.mjs";

const runDir = resolve("goal-runs/goalport-pr27-bg-closeout");
const outDir = resolve(process.argv[2] ?? resolve(runDir, "evidence/shots"));
const distRoot = resolve("dist");
mkdirSync(outDir, { recursive: true });

// ---------------------------------------------------------------------------
// Sentences asserted below. The two host gates carry the exact copy this
// round fixed; the record/audit copy is the revise-draft material.
// ---------------------------------------------------------------------------
const GUARD_SENTENCE =
  "This profile has an outstanding background goal. Return to that job or stop allowing its access; no competing work was admitted.";
const REFUSED_SENTENCE =
  "Background Send is not ready in this GoalPort window yet.";
const REFUSED_SUFFIX = "Nothing was started";
const UNKNOWN_MARKER_MESSAGE = "GoalPort could not confirm this background start";
const NO_RESEND_SENTENCE =
  "GoalPort could not confirm this background start. Do not resend this goal; return to its job status.";
const UNCONFIRMED_SENTENCE = "Progress unavailable or interrupted";
const REVISE_CONTINUATION = "Continuing from a completed execution round";
const AUDIT_LEAD = "The independent audit said:";
const AUDIT_TEXT =
  "The subtraction is still wrong for negative values; the helper needs the signed branch before this round can be trusted.";
const EXECUTION_TEXT =
  "Repaired helper.ts with the sign check; the three example tests now pass.";

// ---------------------------------------------------------------------------
// Page-side stub data. Shapes follow src/interaction.test.tsx repairProviders()
// (usableHarness) and the normalized coordination record written by
// electron/coordination-record.cjs normalize() (the "budget-stopped" record).
// ---------------------------------------------------------------------------
const usableHarness = (instanceId, displayName) => ({
  instanceId,
  displayName,
  driver: instanceId,
  enabled: true,
  installed: true,
  availability: "available",
  status: "ready",
  auth: { status: "authenticated", type: "subscription" },
  models: [{ slug: `${instanceId}-model`, name: `${instanceId}-model`, isDefault: true }],
  usageLimits: { windows: [{ id: "five_hour", usedPercent: 1 }] },
});
const providers = [usableHarness("codex", "Codex"), usableHarness("claude", "Claude")];

// A minimal but valid full projection: empty profile, connected transport, two
// selectable runtimes (the Runtime picker needs them for the conflict state).
const emptySnapshot = {
  protocolVersion: "goalport.ipc.v2",
  buildId: "shot-bg-closeout",
  connection: "connected",
  projects: [],
  selectedProjectId: "project-goal",
  project: { id: "project-goal", name: "GoalPort", workspaceRoot: "/work/goal", color: "slate" },
  campaigns: [],
  activeCampaignId: "",
  activeTask: { id: "", title: "No task selected", acceptance: "", state: "waiting" },
  attempt: { id: "attempt-unassigned", taskId: "", provider: "unassigned", role: "executor", state: "waiting", eventCount: 0 },
  timeline: [],
  cursor: 0,
  runtimes: [
    {
      id: "claude", name: "Claude Code", version: "2.1.252", support: "partial", mode: "Planner",
      subtitle: "Native CLI · Preview path",
      reasons: ["Structured planning events observed", "Resume and native config still need desktop evidence"],
      capabilities: { events: "needs-review", resume: "needs-review", permissions: "needs-review", cancel: "unsupported" },
    },
    {
      id: "codex", name: "Codex", version: "0.152.0", support: "partial", mode: "Executor",
      subtitle: "App-server candidate · Preview path",
      reasons: ["Current role matches workspace execution", "Approval and reconnect remain capability-gated"],
      capabilities: { events: "needs-review", resume: "needs-review", permissions: "needs-review", cancel: "unsupported" },
    },
  ],
  decisions: [],
  evidence: [],
  stopResponsibility: null,
  relatedHolds: [],
  preview: false,
  notices: [],
  productConversation: null,
};

const reviseRecord = {
  requestId: "shot-bg-revise",
  workspacePath: "/work/goal",
  goal: "Fix the helper.",
  planningHarness: "Codex",
  reviewHarness: "Claude",
  planText: "Replace the subtraction with a signed branch in helper.ts.",
  reviewText: "The plan can be carried out.\nVERDICT: carry-out",
  result: "The independent verification says the changes need revision, so this stopped.",
  executionText: EXECUTION_TEXT,
  auditText: AUDIT_TEXT,
  executionHarness: "Codex",
  auditHarness: "Claude",
  verdict: "revise",
  stopReason:
    "The independent verification says the changes need revision, so this stopped. There is not enough access left for one more checked repair, which needs three model turns and one write turn. GoalPort did not add turns.",
  planningQuota: "available",
  reviewQuota: "available",
  messageDispatched: true,
  savedAt: "2026-10-11T17:40:00.000Z",
};

// The admitted-but-unconfirmed job: an active backing job whose control is
// unreachable, so Stop allowing must stay reachable while the outcome does not.
const unconfirmedJob = {
  jobId: "job-u",
  requestId: "shot-request",
  goal: "Fix the helper.",
  state: "unconfirmed",
  live: false,
  active: true,
  revoked: false,
  workerPid: null,
  readMaxTurns: 4,
  writeMaxTurns: null,
  counters: null,
  pendingCommand: null,
  completedCommands: [],
  progress: null,
  outcome: null,
};

const pageConfig = {
  emptySnapshot,
  providers,
  records: [reviseRecord],
  unconfirmedJob,
  appInfo: { version: "shot", channel: "test", testMode: false, dataPath: "profile", coordinationConfigured: true },
  guardSentence: GUARD_SENTENCE,
  refusedSentence: REFUSED_SENTENCE,
  unknownMessage: UNKNOWN_MARKER_MESSAGE,
};
// Embedding JSON inside a <script> tag requires escaping "<" (a literal
// "</script>" inside a string would close the tag early) and the two JS line
// separators; this is the sanitization CodeQL expects for this construction.
const configJson = JSON.stringify(pageConfig)
  .replace(/</g, "\\u003c")
  .replace(/\u2028/g, "\\u2028")
  .replace(/\u2029/g, "\\u2029");

const pageScript = `    <script>
window.__GOALPORT_ELECTRON__ = true;
(function () {
  var CONFIG = ${configJson};
  var state = { scenario: "idle", job: null, startCalls: 0, revokes: 0, lastRequestId: null, scope: null };
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function admittedStatus(requestId) {
    return Object.assign(clone(CONFIG.unconfirmedJob), { requestId: requestId || CONFIG.unconfirmedJob.requestId });
  }
  window.__shotScenario = function (name) {
    state.scenario = name; state.job = null; state.startCalls = 0; state.revokes = 0; return name;
  };
  window.__shotState = function () {
    return { scenario: state.scenario, startCalls: state.startCalls, revokes: state.revokes,
      lastRequestId: state.lastRequestId, jobId: state.job ? state.job.jobId : null,
      jobState: state.job ? state.job.state : null, jobRevoked: state.job ? state.job.revoked : null };
  };
  window.goalportCore = {
    snapshot: async function () { return CONFIG.emptySnapshot; },
    startCore: async function () { return CONFIG.emptySnapshot; },
    command: async function (request) {
      var messageType = request && request.messageType;
      if (messageType === "start_conversation" && state.scenario === "conflict") {
        // The main-process competing guard: one goalportRejected envelope,
        // returned BEFORE Core is invoked (electron/main.cjs shape).
        return {
          goalportRejected: true,
          requestId: request.requestId,
          error: CONFIG.guardSentence,
          rejection: {
            code: "background-job-outstanding",
            message: CONFIG.guardSentence,
            deliveryState: "FAILED",
            nativeDispatchState: "NOT_STARTED",
            retryMode: "NEW_REQUEST",
            reservation: null
          }
        };
      }
      return { requestId: request && request.requestId, accepted: true, duplicate: false, snapshot: CONFIG.emptySnapshot };
    },
    openInVsCode: async function () { return undefined; },
    appInfo: async function () { return CONFIG.appInfo; },
    coordinateDiscover: async function () {
      return { connected: true, sendAuthorized: true, stopReason: null, providers: CONFIG.providers };
    },
    coordinateLaunch: async function () { return { text: "", errorText: "" }; },
    coordinationAuthorize: async function (scope) {
      state.scope = { generation: 1, instances: (scope && scope.instances) || [], maxTurns: (scope && scope.maxTurns) || 4,
        remaining: 8, write: null };
      return { ok: true, generation: 1, remaining: 8 };
    },
    coordinationScope: async function () { return state.scope; },
    coordinationRevoke: async function () { state.scope = null; return { ok: true }; },
    coordinationUnblock: async function () { return { ok: true }; },
    coordinationSave: async function (record) { return Object.assign({}, record, { recorded: true }); },
    coordinationRecords: async function () {
      // The first-use load asks for the genuinely empty profile (no saved plan
      // yet), so the New goal composer is the startup surface.
      if (new URLSearchParams(location.search).get("shot") === "first-use") return [];
      return CONFIG.records;
    },
    backgroundStart: async function (input) {
      state.startCalls += 1;
      state.lastRequestId = input && input.requestId ? input.requestId : null;
      if (state.scenario === "definite-refusal") {
        return { backgroundStartRefused: true, code: "background-unavailable", message: CONFIG.refusedSentence };
      }
      if (state.scenario === "unknown-admission") {
        return { backgroundStartRefused: true, code: "background-admission-unknown", message: CONFIG.unknownMessage };
      }
      if (state.scenario === "job-unconfirmed" || state.scenario === "job-revoked-unconfirmed") {
        state.job = admittedStatus(state.lastRequestId);
        return state.job;
      }
      return { backgroundStartRefused: true, code: "background-unavailable", message: CONFIG.refusedSentence };
    },
    backgroundStatus: async function () { return state.job; },
    backgroundRevoke: async function () {
      state.revokes += 1;
      if (state.job) state.job = Object.assign({}, state.job, { revoked: true });
      return state.job;
    }
  };
})();
</script>
`;
const index = readFileSync(resolve(distRoot, "index.html"), "utf8");
writeFileSync(resolve(distRoot, "shot-bg.html"), index.replace("  </head>", `${pageScript}  </head>`));

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------
const preview = await startPreview({ dist: distRoot, fixture: "empty" });
const { page, evaluate, until, viewport, click, fill, screenshot } = preview;
const port = new URL(preview.url).port;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function goto(path) {
  await page.cdp("Page.navigate", { url: `http://127.0.0.1:${port}/${path}` });
  await until("Boolean(document.querySelector('.goalport-shell'))");
}

async function clickPoint(point) {
  await page.cdp("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
  await page.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
}

/** Real-DOM click by a predicate over the live tree (text/markup, not test ids). */
async function clickFound(finder, description) {
  const point = await evaluate(`(() => {
    const target = (${finder});
    if (!target || target.disabled) return null;
    target.scrollIntoView({ block: "center" });
    const r = target.getBoundingClientRect();
    const x = r.x + r.width / 2, y = r.y + r.height / 2;
    const top = document.elementFromPoint(x, y);
    return r.width && r.height && x >= 0 && x < innerWidth && y >= 0 && y < innerHeight
      && (top === target || target.contains(top)) ? { x, y } : null;
  })()`);
  if (!point) throw new Error(`Control missing, blocked or outside viewport: ${description}`);
  await clickPoint(point);
}

const clickText = (text, selector = "button") =>
  clickFound(`Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
    .find((node) => (node.innerText || node.textContent || "").trim() === ${JSON.stringify(text)})`,
    `${selector} with text "${text}"`);

const clickCheckbox = (label) =>
  clickFound(`document.querySelector('input[aria-label=' + JSON.stringify(${JSON.stringify(label)}) + ']')`,
    `checkbox "${label}"`);

/** Everything the sidecar/assertions read out of the real DOM. */
const readDom = () => evaluate(`(() => {
  const send = document.querySelector('.draft-composer-form button[type="submit"]');
  const consent = document.querySelector('input[aria-label="Keep working after closing"]');
  const alert = document.querySelector('.dialog-note');
  const job = document.querySelector('.background-job');
  const jobStatus = job ? job.querySelector('[role="status"]') : null;
  const revision = document.querySelector('.revision-note');
  const message = document.querySelector('#draft-message');
  return {
    path: location.pathname,
    body: document.body.innerText,
    draftVisible: Boolean(document.querySelector('.draft-composer-form')),
    sendDisabled: send ? send.disabled === true : null,
    sendLabel: send ? send.innerText.trim() : null,
    errorText: alert ? alert.innerText : null,
    consentChecked: consent ? consent.checked : null,
    message: message ? message.value : null,
    revisionText: revision ? revision.innerText : null,
    jobVisible: Boolean(job),
    jobSentence: jobStatus ? jobStatus.innerText : null,
    stopAllowing: Array.from(document.querySelectorAll('button'))
      .filter((node) => (node.innerText || "").trim() === 'Stop allowing').length,
  };
})()`);

const results = [];
const failures = [];

/** viewport -> pause -> assert -> screenshot, one state at one width. */
async function capture({ state, width, needles = [], errorNeedles = [], messageNeedle, sendDisabled, stopAllowing, consentChecked, scrollTo = null }) {
  await viewport(width, 900);
  if (scrollTo) {
    await evaluate((selector) => {
      const e = document.querySelector(selector);
      if (e) e.scrollIntoView({ block: "center" });
      return true;
    }, scrollTo);
  }
  await sleep(300);
  const dom = await readDom();
  const checks = [];
  const missing = needles.filter((needle) => !dom.body.includes(needle));
  checks.push({
    name: `text:${needles.join(" | ") || "(none)"}`,
    ok: missing.length === 0,
    detail: missing.length ? `missing: ${missing.join(" | ")}` : "all visible",
  });
  if (errorNeedles.length) {
    const missingError = errorNeedles.filter((needle) => !(dom.errorText ?? "").includes(needle));
    checks.push({
      name: `error-area:${errorNeedles.join(" | ")}`,
      ok: missingError.length === 0,
      detail: missingError.length ? `missing in error area: ${missingError.join(" | ")}` : "all in .dialog-note",
    });
  }
  if (sendDisabled !== undefined) {
    checks.push({ name: `sendDisabled=${sendDisabled}`, ok: dom.sendDisabled === sendDisabled, detail: `actual ${dom.sendDisabled}` });
  }
  if (messageNeedle !== undefined) {
    const draftText = dom.message ?? "";
    checks.push({
      name: `draftMessage contains "${messageNeedle}"`,
      ok: draftText.includes(messageNeedle),
      detail: `actual ${JSON.stringify(draftText)}`,
    });
  }
  if (stopAllowing !== undefined) {
    checks.push({ name: `stopAllowing=${stopAllowing}`, ok: (dom.stopAllowing > 0) === stopAllowing, detail: `count ${dom.stopAllowing}` });
  }
  if (consentChecked !== undefined) {
    checks.push({ name: `consentChecked=${consentChecked}`, ok: dom.consentChecked === consentChecked, detail: `actual ${dom.consentChecked}` });
  }
  const failed = checks.filter((check) => !check.ok);
  results.push({
    state,
    width,
    assertionTextfound: missing.length === 0,
    sendDisabled: dom.sendDisabled,
    checks: checks.map((check) => ({ name: check.name, ok: check.ok, detail: check.detail })),
    errorArea: dom.errorText,
    jobSentence: dom.jobSentence,
    draftMessage: dom.message,
    consentChecked: dom.consentChecked,
    stopAllowing: dom.stopAllowing,
  });
  await screenshot(resolve(outDir, `${state}-${width}.png`));
  if (failed.length) {
    failures.push({ state, width, failed, body: dom.body.slice(0, 2000), errorArea: dom.errorText });
  }
}

// ---------------------------------------------------------------------------
// 0. First-use path: an empty profile's startup surface (New goal composer).
// ---------------------------------------------------------------------------
await goto("shot-bg.html?preview=empty&shot=first-use");
await until("Boolean(document.querySelector('.draft-composer-form'))");
await capture({
  state: "startup-newgoal",
  width: 860,
  needles: ["Start a goal", "What would you like to work on?", "No goals yet"],
  sendDisabled: true,
  scrollTo: ".draft-composer-form",
});

// ---------------------------------------------------------------------------
// ONE session for every remaining state: the saved revise record loads as the
// selected plan; the draft, job and guard states are driven from here.
// ---------------------------------------------------------------------------
await goto("shot-bg.html?preview=empty");
await until("Boolean(document.querySelector('.timeline-scroll[aria-label=\"Saved plan\"]'))");
await viewport(1440, 900);

// 1. revise-draft — open the revise draft from the saved record.
await click('button[aria-label^="Plan:"]');
await until("Boolean(document.querySelector('.timeline-scroll[aria-label=\"Saved plan\"]'))");
await until("Array.from(document.querySelectorAll('button')).some((node) => (node.innerText || '').trim() === 'Revise')");
await clickText("Revise");
await until(`document.body.innerText.includes(${JSON.stringify(REVISE_CONTINUATION)})`);
await until("Boolean(document.querySelector('input[aria-label=\"Keep working after closing\"]'))");
for (const width of [1440, 1020, 860]) {
  await capture({
    state: "revise-draft",
    width,
    needles: [REVISE_CONTINUATION, AUDIT_LEAD, AUDIT_TEXT, "The earlier plan, changes and independent audit are below"],
    sendDisabled: false,
    consentChecked: false,
    scrollTo: ".revision-note",
  });
}

// 2. definite-refusal — a host-classified pre-admission refusal releases the
// draft: its sentence is shown and Send is usable again.
await viewport(1440, 900);
await evaluate(`window.__shotScenario("definite-refusal")`);
await clickCheckbox("Keep working after closing");
await until("Boolean(document.querySelector('input[aria-label=\"Keep working after closing\"]').checked)");
await fill("#draft-message", "Fold the audit findings in and keep the round bounded.");
await click('.draft-composer-form button[type="submit"]');
await until(`document.body.innerText.includes(${JSON.stringify(REFUSED_SENTENCE)})`);
await until("Boolean(document.querySelector('.dialog-note'))");
for (const width of [1440, 1020, 860]) {
  await capture({
    state: "definite-refusal",
    width,
    needles: [REFUSED_SENTENCE, REFUSED_SUFFIX],
    errorNeedles: [REFUSED_SENTENCE, REFUSED_SUFFIX],
    messageNeedle: "Fold the audit findings in",
    sendDisabled: false,
    consentChecked: false,
    scrollTo: ".dialog-note",
  });
}

// 3. unknown-admission — an unconfirmable admission keeps the draft blocked
// with the exact no-resend sentence; Send stays disabled.
await viewport(1440, 900);
await evaluate(`window.__shotScenario("unknown-admission")`);
await clickCheckbox("Keep working after closing");
await until("Boolean(document.querySelector('input[aria-label=\"Keep working after closing\"]').checked)");
await fill("#draft-message", "Send the revised round once admission is confirmed.");
await click('.draft-composer-form button[type="submit"]');
await until(`document.body.innerText.includes(${JSON.stringify(NO_RESEND_SENTENCE)})`);
for (const width of [1020, 1440]) {
  await capture({
    state: "unknown-admission",
    width,
    needles: [NO_RESEND_SENTENCE],
    errorNeedles: [NO_RESEND_SENTENCE],
    messageNeedle: "Send the revised round once admission is confirmed.",
    sendDisabled: true,
    scrollTo: ".dialog-note",
  });
}

// 6. conflict-sentence — a fresh New goal draft with a Runtime selected: the
// competing-background guard refuses the ordinary start_conversation.
await viewport(1440, 900);
await click('button[aria-label="New goal"]');
await until("Boolean(document.querySelector('.draft-composer-form'))");
await until("Boolean(document.querySelector('input[aria-label=\"Keep working after closing\"]'))");
await evaluate(`window.__shotScenario("conflict")`);
await clickFound(`document.querySelector('[aria-label="Select Runtime"]')`, "Runtime picker");
await until(`document.querySelectorAll('[role="option"]').length > 0`);
await clickFound(`Array.from(document.querySelectorAll('[role="option"]')).find((node) => (node.textContent || "").includes("Codex"))`, "Codex runtime option");
await until(`Boolean(document.querySelector('.draft-composer-form .runtime-picker-button strong').textContent.includes("Codex"))`);
await fill("#draft-message", "Inspect the helper before the next round.");
await click('.draft-composer-form button[type="submit"]');
await until(`document.body.innerText.includes(${JSON.stringify(GUARD_SENTENCE)})`);
await capture({
  state: "conflict-sentence",
  width: 1020,
  needles: [GUARD_SENTENCE],
  errorNeedles: [GUARD_SENTENCE],
  messageNeedle: "Inspect the helper before the next round.",
  sendDisabled: false,
  scrollTo: ".dialog-note",
});

// 4. job-unconfirmed — backgroundStart admits an unconfirmed job: the job view
// states the uncertainty and keeps Stop allowing reachable.
await viewport(1440, 900);
await click('button[aria-label="New goal"]');
await until("Boolean(document.querySelector('.draft-composer-form'))");
await until("Boolean(document.querySelector('input[aria-label=\"Keep working after closing\"]'))");
await evaluate(`window.__shotScenario("job-unconfirmed")`);
await clickCheckbox("Keep working after closing");
await until("Boolean(document.querySelector('input[aria-label=\"Keep working after closing\"]').checked)");
await fill("#draft-message", "Keep this round going after I close the window.");
await click('.draft-composer-form button[type="submit"]');
await until("Boolean(document.querySelector('.background-job'))");
await until(`document.querySelector('.background-job [role="status"]').innerText.includes(${JSON.stringify(UNCONFIRMED_SENTENCE)})`);
for (const width of [1440, 1020, 860]) {
  await capture({
    state: "job-unconfirmed",
    width,
    needles: [UNCONFIRMED_SENTENCE, "GoalPort did not restart this job and will not replay it"],
    // The job view replaces the draft: no Send button exists to be disabled.
    sendDisabled: null,
    stopAllowing: true,
    scrollTo: ".background-job",
  });
}

// 5. job-revoked-unconfirmed — the user stops allowing: Stop allowing is gone,
// the uncertainty wording stays.
await viewport(1440, 900);
await clickText("Stop allowing");
await until("Boolean(document.querySelector('.background-job'))");
await until("Array.from(document.querySelectorAll('button')).every((node) => (node.innerText || '').trim() !== 'Stop allowing')");
await capture({
  state: "job-revoked-unconfirmed",
  width: 1440,
  needles: [UNCONFIRMED_SENTENCE, "GoalPort did not restart this job and will not replay it"],
  sendDisabled: null,
  stopAllowing: false,
  scrollTo: ".background-job",
});

writeFileSync(resolve(outDir, "assertions.json"), `${JSON.stringify(results, null, 2)}\n`);
const pageState = await evaluate("window.__shotState()");
await preview.stop();

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
const columns = ["state", "width", "text", "send", "stop", "consent", "result"];
const rows = results.map((entry) => [
  entry.state,
  String(entry.width),
  entry.assertionTextfound ? "found" : "MISSING",
  entry.sendDisabled === null ? "-" : entry.sendDisabled ? "disabled" : "enabled",
  entry.stopAllowing > 0 ? "visible" : "hidden",
  entry.consentChecked === null ? "-" : entry.consentChecked ? "on" : "off",
  entry.checks.every((check) => check.ok) ? "pass" : "FAIL",
]);
const widths = columns.map((column, index) => Math.max(column.length, ...rows.map((row) => row[index].length)));
console.log(columns.map((column, index) => column.padEnd(widths[index])).join("  "));
console.log(widths.map((width) => "-".repeat(width)).join("  "));
for (const row of rows) console.log(row.map((cell, index) => cell.padEnd(widths[index])).join("  "));
console.log(`\nbridge: ${JSON.stringify(pageState)}`);
console.log(`screenshots: ${results.length} -> ${outDir}`);
console.log(`assertions: ${resolve(outDir, "assertions.json")}`);
if (failures.length) {
  console.error(`\nFAILED ${failures.length} capture(s):`);
  for (const failure of failures) {
    console.error(`- ${failure.state}-${failure.width}: ${failure.failed.map((check) => `${check.name} (${check.detail})`).join("; ")}`);
    console.error(`  error area: ${JSON.stringify(failure.errorArea)}`);
    console.error(`  body: ${JSON.stringify(failure.body.slice(0, 600))}`);
  }
  process.exit(1);
}
console.log("all state assertions green");
