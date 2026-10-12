// Renderer-interaction acceptance driver for the background-coordination
// closeout (GAH runs goalport-pr27-bg-closeout -> goalport-pr27-driver-verifiable).
//
// User intent for the continuous journey below:
//   "I revise checked work, correct a refused send, avoid duplicating an
//    uncertain send, stop further access, and return to the same job with
//    honest retained facts."
//
// Like scripts/preview/shot-review-fixes.mjs this drives the REAL built
// renderer (dist/shot-bg.html gets the Electron preload port
// `window.goalportCore` injected BEFORE head scripts run) in electron mode.
// It is renderer interaction acceptance against a scripted preload bridge:
// every user action is real CDP mouse/keyboard input against the live DOM,
// while the page-side goalportCore port mirrors the bridge CONTRACT
// (snapshot/command/coordinate*/background* shapes and refusal codes), not
// real worker execution. The native-acceptance limitation is retained:
// nothing here proves native background execution, real permission requests,
// OS window lifecycle, or process survival.
//
// This harness accepts CDP expression strings ONLY (scripts/preview/harness.mjs
// forwards to Runtime.evaluate {expression}); every evaluate() below is an
// expression string, never a function/argument call.
//
// The driver drives ONE preview session sequentially (one first-use empty
// profile load, then one navigate to the saved-record page) and executes the
// continuous journey J1-J8 with NO scripted reset between journey steps. The
// supplemental competing-guard scenario runs AFTER J8, outside the journey.
// It FAILS (exit 1) if any state's assertion is not visible in the real DOM,
// so the shots cannot be evidence of a state that never rendered.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { startPreview } from "../preview/harness.mjs";

const runDir = resolve("goal-runs/goalport-pr27-driver-verifiable");
const outDir = resolve(process.argv[2] ?? resolve(runDir, "evidence/shots"));
const distRoot = resolve("dist");
const sourceSha = process.env.GOALPORT_EVIDENCE_SHA ?? null;
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
const NO_REPLAY_SENTENCE = "GoalPort did not restart this job and will not replay it";
// The revoked state's sentence would CLAIM a stopped turn; while the job is
// unconfirmed the uncertainty wording wins, so these must stay ABSENT.
const REVOKED_CLAIM_PREFIX = "Access stopped";
const STOP_CAPTION_TAIL = "does not prove a turn already in flight stopped";
const REVISE_CONTINUATION = "Continuing from a completed execution round";
const AUDIT_LEAD = "The independent audit said:";
const AUDIT_TEXT =
  "The subtraction is still wrong for negative values; the helper needs the signed branch before this round can be trusted.";
const EXECUTION_TEXT =
  "Repaired helper.ts with the sign check; the three example tests now pass.";
const INITIAL_MESSAGE = "Fold the audit findings in and keep the round bounded.";
const ADJUSTED_MESSAGE = "Send the revised round once admission is confirmed.";

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

// The admitted-but-unconfirmed job SHAPE: an active backing job whose control
// is unreachable, so Stop allowing must stay reachable while the outcome does
// not. The JOURNEY job is built from the second start's ACTUAL requestId and
// goal; this fixture's unrelated request/goal is only for legacy scenarios.
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
  var journey = null;
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function admittedStatus(requestId) {
    return Object.assign(clone(CONFIG.unconfirmedJob), { requestId: requestId || CONFIG.unconfirmedJob.requestId });
  }
  function jTrace(event, fields) {
    journey.trace.push(Object.assign({ seq: journey.trace.length + 1, at: new Date().toISOString(), event: event }, fields || {}));
  }
  // Journey mode is initialized EXACTLY ONCE, before the Revise flow; the
  // token doubles as the page-instance proof (a reload would drop it).
  window.__shotJourney = function () {
    if (journey) return { token: journey.token, alreadyInitialized: true };
    journey = {
      token: "journey-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10),
      phase: "armed",
      starts: [], revocations: [], revokeMismatch: false,
      authorizations: 0, launches: 0, saves: 0,
      statusAvailable: false, statusPolls: 0, job: null,
      unexpectedStarts: 0, thirdStartError: null,
      trace: []
    };
    jTrace("journey-initialized", { note: "journey mode armed once, before the Revise flow" });
    return { token: journey.token, alreadyInitialized: false };
  };
  // Host-fixture orchestration, NOT a user action: publishes the already
  // pending job through backgroundStatus. It never calls Start, never
  // replaces request identity, and never touches React state.
  window.__shotReleaseJourneyStatus = function () {
    if (!journey) return { released: false, reason: "journey-not-initialized" };
    if (journey.phase !== "unknown-admission" || !journey.job) {
      return { released: false, reason: "unexpected-phase", phase: journey.phase };
    }
    journey.statusAvailable = true;
    journey.phase = "released";
    jTrace("__shotReleaseJourneyStatus", { note: "host-fixture orchestration, not a user action", jobId: journey.job.jobId });
    return { released: true, jobId: journey.job.jobId, requestId: journey.job.requestId };
  };
  // Scripted scenario reset (supplemental coverage only): leaves journey mode.
  window.__shotScenario = function (name) {
    journey = null;
    state.scenario = name; state.job = null; state.startCalls = 0; state.revokes = 0; return name;
  };
  window.__shotState = function () {
    var j = null;
    if (journey) {
      j = {
        token: journey.token, phase: journey.phase,
        startsCount: journey.starts.length, revokesCount: journey.revocations.length,
        revocationJobIds: journey.revocations.slice(), revokeMismatch: journey.revokeMismatch,
        authorizations: journey.authorizations, launches: journey.launches, saves: journey.saves,
        statusAvailable: journey.statusAvailable, statusPolls: journey.statusPolls,
        unexpectedStarts: journey.unexpectedStarts,
        requestId1: journey.starts[0] ? journey.starts[0].requestId : null,
        requestId2: journey.starts[1] ? journey.starts[1].requestId : null,
        goal1: journey.starts[0] ? journey.starts[0].goal : null,
        goal2: journey.starts[1] ? journey.starts[1].goal : null,
        consent1: journey.starts[0] ? journey.starts[0].backgroundConsent === true : null,
        consent2: journey.starts[1] ? journey.starts[1].backgroundConsent === true : null,
        feedback1: journey.starts[0] && journey.starts[0].executionFeedback ? journey.starts[0].executionFeedback : null,
        feedback2: journey.starts[1] && journey.starts[1].executionFeedback ? journey.starts[1].executionFeedback : null,
        priorPlan1: journey.starts[0] ? journey.starts[0].priorPlan : null,
        priorReview1: journey.starts[0] ? journey.starts[0].priorReview : null,
        jobId: journey.job ? journey.job.jobId : null,
        jobRequestId: journey.job ? journey.job.requestId : null,
        jobGoal: journey.job ? journey.job.goal : null,
        jobRevoked: journey.job ? journey.job.revoked : null,
        jobState: journey.job ? journey.job.state : null
      };
    }
    return { scenario: state.scenario, startCalls: state.startCalls, revokes: state.revokes,
      lastRequestId: state.lastRequestId, jobId: state.job ? state.job.jobId : null,
      jobState: state.job ? state.job.state : null, jobRevoked: state.job ? state.job.revoked : null,
      journey: j };
  };
  window.__shotJourneyDump = function () {
    if (!journey) return null;
    return {
      token: journey.token, phase: journey.phase,
      statusAvailable: journey.statusAvailable, statusPolls: journey.statusPolls,
      startsCount: journey.starts.length, revocations: journey.revocations.slice(),
      revokeMismatch: journey.revokeMismatch,
      authorizations: journey.authorizations, launches: journey.launches, saves: journey.saves,
      unexpectedStarts: journey.unexpectedStarts, thirdStartError: journey.thirdStartError,
      starts: clone(journey.starts),
      jobId: journey.job ? journey.job.jobId : null,
      jobRequestId: journey.job ? journey.job.requestId : null,
      jobGoal: journey.job ? journey.job.goal : null,
      jobRevoked: journey.job ? journey.job.revoked : null,
      trace: clone(journey.trace)
    };
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
    coordinateLaunch: async function () {
      if (journey) { journey.launches += 1; jTrace("coordinateLaunch", {}); }
      return { text: "", errorText: "" };
    },
    coordinationAuthorize: async function (scope) {
      if (journey) { journey.authorizations += 1; jTrace("coordinationAuthorize", {}); }
      state.scope = { generation: 1, instances: (scope && scope.instances) || [], maxTurns: (scope && scope.maxTurns) || 4,
        remaining: 8, write: null };
      return { ok: true, generation: 1, remaining: 8 };
    },
    coordinationScope: async function () { return state.scope; },
    coordinationRevoke: async function () { state.scope = null; return { ok: true }; },
    coordinationUnblock: async function () { return { ok: true }; },
    coordinationSave: async function (record) {
      if (journey) { journey.saves += 1; jTrace("coordinationSave", { requestId: record && record.requestId }); }
      return Object.assign({}, record, { recorded: true });
    },
    coordinationRecords: async function () {
      // The first-use load asks for the genuinely empty profile (no saved plan
      // yet), so the New goal composer is the startup surface.
      if (new URLSearchParams(location.search).get("shot") === "first-use") return [];
      return CONFIG.records;
    },
    backgroundStart: async function (input) {
      if (journey) {
        if (journey.starts.length === 0) {
          // First journey start: definite refusal, nothing admitted, no job.
          journey.starts.push(clone(input || {}));
          journey.phase = "definite-refused";
          jTrace("backgroundStart", { call: 1, requestId: journey.starts[0].requestId, goal: journey.starts[0].goal, result: "background-unavailable" });
          return { backgroundStartRefused: true, code: "background-unavailable", message: CONFIG.refusedSentence };
        }
        if (journey.starts.length === 1) {
          // Second journey start: pending admitted-but-unconfirmed job built
          // from THIS input's actual requestId and goal; the return is the
          // pinned plain unknown marker, never a status object.
          journey.starts.push(clone(input || {}));
          var second = journey.starts[1];
          journey.job = Object.assign(clone(CONFIG.unconfirmedJob), {
            jobId: "job-j-" + String(second.requestId || "unknown"),
            requestId: second.requestId,
            goal: second.goal
          });
          journey.phase = "unknown-admission";
          jTrace("backgroundStart", { call: 2, requestId: second.requestId, goal: second.goal, result: "background-admission-unknown", pendingJobId: journey.job.jobId });
          return { backgroundStartRefused: true, code: "background-admission-unknown", message: CONFIG.unknownMessage };
        }
        // Any third journey start is an unexpected resend: throw, mutate counts only.
        journey.unexpectedStarts += 1;
        journey.thirdStartError = "unexpected-resend: the journey already admitted this request; a third backgroundStart is never legitimate";
        jTrace("backgroundStart", { result: "unexpected-resend-thrown" });
        throw new Error(journey.thirdStartError);
      }
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
    backgroundStatus: async function () {
      if (journey) {
        journey.statusPolls += 1;
        // Status-availability gate: until released, every read (including the
        // renderer's immediate reconciliation probe) sees NO job at all.
        if (!journey.statusAvailable) {
          if (journey.statusPolls === 1) jTrace("backgroundStatus", { poll: 1, returned: null, note: "gate closed: status unavailable to the renderer" });
          return null;
        }
        jTrace("backgroundStatus", { poll: journey.statusPolls, returned: journey.job ? journey.job.jobId : null });
        return journey.job;
      }
      return state.job;
    },
    backgroundRevoke: async function (jobId) {
      if (journey) {
        journey.revocations.push(jobId === undefined ? null : jobId);
        if (journey.job && jobId === journey.job.jobId) {
          // One revoke preserves every job fact and only sets revoked: true.
          journey.job = Object.assign({}, journey.job, { revoked: true });
        } else {
          journey.revokeMismatch = true;
        }
        jTrace("backgroundRevoke", { jobId: jobId === undefined ? null : jobId, mismatch: journey.revokeMismatch });
        return journey.job;
      }
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
let preview = null;
let driverError = null;
let page = null;
let evaluate = null;
let until = null;
let viewport = null;
let click = null;
let fill = null;
let screenshot = null;
const results = [];
const failures = [];
const journeySteps = [];
let journeyToken = null;
let lastBridgeState = null;
let journeySnapshotWritten = false;
let journeyFailures = 0;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

try {
  preview = await startPreview({ dist: distRoot, fixture: "empty" });
  ({ page, evaluate, until, viewport, click, fill, screenshot } = preview);
  const port = new URL(preview.url).port;

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

  const readBridge = async () => {
    lastBridgeState = await evaluate("window.__shotState()");
    return lastBridgeState;
  };

  /** Everything the sidecar/assertions read out of the real DOM. */
  const readDom = () => evaluate(`(() => {
    const send = document.querySelector('.draft-composer-form button[type="submit"]');
    const consent = document.querySelector('input[aria-label="Keep working after closing"]');
    const alert = document.querySelector('.dialog-note');
    const job = document.querySelector('.background-job');
    const jobStatus = job ? job.querySelector('[role="status"]') : null;
    const revision = document.querySelector('.revision-note');
    const message = document.querySelector('#draft-message');
    const returnControl = document.querySelector('.background-return button');
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
      jobId: job ? job.getAttribute("data-job-id") : null,
      jobGoal: job && job.querySelector("h2") ? job.querySelector("h2").innerText : null,
      jobSentence: jobStatus ? jobStatus.innerText : null,
      returnControl: returnControl ? returnControl.innerText.trim() : null,
      stopAllowing: Array.from(document.querySelectorAll('button'))
        .filter((node) => (node.innerText || "").trim() === 'Stop allowing').length,
    };
  })()`);

  function recordJourneyStep(step, dom, bridge, checks, extra = {}) {
    const failed = checks.filter((check) => !check.ok);
    journeySteps.push({
      step: step.step,
      label: step.label,
      action: step.action,
      width: extra.width ?? null,
      ok: failed.length === 0,
      checks: checks.map((check) => ({ name: check.name, ok: check.ok, detail: check.detail })),
      dom: dom ? {
        jobId: dom.jobId, jobGoal: dom.jobGoal, jobVisible: dom.jobVisible, jobSentence: dom.jobSentence,
        sendDisabled: dom.sendDisabled, consentChecked: dom.consentChecked, message: dom.message,
        returnControl: dom.returnControl, errorText: dom.errorText, stopAllowing: dom.stopAllowing,
      } : null,
      bridge: bridge ?? lastBridgeState,
      ...extra,
    });
    journeyFailures += failed.length;
    return failed;
  }

  /** viewport -> pause -> assert -> screenshot, one state at one width. */
  async function capture({ state, width, needles = [], absentNeedles = [], errorNeedles = [], messageNeedle,
    sendDisabled, stopAllowing, consentChecked, jobVisible, expectJobId, returnControl, draftVisible,
    scrollTo = null, extraChecks = [], journeyStep = null, supplemental = false }) {
    await viewport(width, 900);
    if (scrollTo) {
      // This harness accepts CDP expression strings, not function/argument calls.
      // CodeQL posture for this JSON-literal embedding is documented in the run.
      await evaluate(`(() => {
        const e = document.querySelector(${JSON.stringify(scrollTo)});
        if (e) e.scrollIntoView({ block: "center" });
        return true;
      })()`);
    }
    await sleep(300);
    const dom = await readDom();
    const bridge = journeyStep ? await readBridge() : null;
    const checks = [];
    const missing = needles.filter((needle) => !dom.body.includes(needle));
    checks.push({
      name: `text:${needles.join(" | ") || "(none)"}`,
      ok: missing.length === 0,
      detail: missing.length ? `missing: ${missing.join(" | ")}` : "all visible",
    });
    if (absentNeedles.length) {
      const present = absentNeedles.filter((needle) => dom.body.includes(needle));
      checks.push({
        name: `absent:${absentNeedles.join(" | ")}`,
        ok: present.length === 0,
        detail: present.length ? `unexpectedly visible: ${present.join(" | ")}` : "none present",
      });
    }
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
    if (jobVisible !== undefined) {
      checks.push({ name: `jobVisible=${jobVisible}`, ok: dom.jobVisible === jobVisible, detail: `actual ${dom.jobVisible}` });
    }
    if (expectJobId !== undefined) {
      checks.push({ name: `jobId=${expectJobId ?? "(absent)"}`, ok: dom.jobId === expectJobId, detail: `actual ${JSON.stringify(dom.jobId)}` });
    }
    if (returnControl !== undefined) {
      checks.push({ name: `returnControl="${returnControl}"`, ok: dom.returnControl === returnControl, detail: `actual ${JSON.stringify(dom.returnControl)}` });
    }
    if (draftVisible !== undefined) {
      checks.push({ name: `draftVisible=${draftVisible}`, ok: dom.draftVisible === draftVisible, detail: `actual ${dom.draftVisible}` });
    }
    checks.push(...extraChecks);
    const failed = checks.filter((check) => !check.ok);
    results.push({
      state,
      width,
      supplemental,
      journeyStep: journeyStep ? `${journeyStep.step} ${journeyStep.label}` : null,
      assertionTextfound: missing.length === 0,
      sendDisabled: dom.sendDisabled,
      checks: checks.map((check) => ({ name: check.name, ok: check.ok, detail: check.detail })),
      errorArea: dom.errorText,
      jobSentence: dom.jobSentence,
      jobId: dom.jobId,
      jobGoal: dom.jobGoal,
      returnControl: dom.returnControl,
      draftMessage: dom.message,
      consentChecked: dom.consentChecked,
      stopAllowing: dom.stopAllowing,
    });
    if (width !== null) await screenshot(resolve(outDir, `${state}-${width}.png`));
    if (journeyStep) {
      const stepFailed = recordJourneyStep(journeyStep, dom, bridge, checks, { width });
      if (stepFailed.length) {
        failures.push({ state: `${journeyStep.step} ${state}`, width, failed: stepFailed, body: dom.body.slice(0, 2000), errorArea: dom.errorText });
      }
    }
    if (failed.length && !journeyStep) {
      failures.push({ state, width, failed, body: dom.body.slice(0, 2000), errorArea: dom.errorText });
    }
  }

  // -----------------------------------------------------------------------
  // 0. First-use path: an empty profile's startup surface (New goal
  //    composer), captured at all three widths.
  // -----------------------------------------------------------------------
  await goto("shot-bg.html?preview=empty&shot=first-use");
  await until("Boolean(document.querySelector('.draft-composer-form'))");
  for (const width of [860, 1020, 1440]) {
    await capture({
      state: "startup-newgoal",
      width,
      needles: ["Start a goal", "What would you like to work on?", "No goals yet"],
      sendDisabled: true,
      scrollTo: ".draft-composer-form",
    });
  }

  // -----------------------------------------------------------------------
  // ONE session for the whole continuous journey: the saved revise record
  // auto-selects on load. NOTE: the nav plan button is deliberately NOT
  // clicked — onSelectPlan permanently sets the app's backgroundAttached ref,
  // which would keep the J5 poll from ever opening the job view.
  // -----------------------------------------------------------------------
  await goto("shot-bg.html?preview=empty");
  await until("Boolean(document.querySelector('.timeline-scroll[aria-label=\"Saved plan\"]'))");
  await viewport(1440, 900);
  await until("Array.from(document.querySelectorAll('button')).some((node) => (node.innerText || '').trim() === 'Revise')");

  // Journey mode initialized ONCE, immediately before the Revise flow.
  const journeyInit = await evaluate("window.__shotJourney()");
  journeyToken = journeyInit.token;
  await clickText("Revise");
  await until(`document.body.innerText.includes(${JSON.stringify(REVISE_CONTINUATION)})`);
  await until("Boolean(document.querySelector('input[aria-label=\"Keep working after closing\"]'))");

  // J1 revise-draft — open the revise draft from the saved record.
  const bridgeJ1 = await readBridge();
  const j1Checks = [
    { name: "journey: initialized once (fresh token)", ok: journeyInit.alreadyInitialized === false, detail: `alreadyInitialized=${journeyInit.alreadyInitialized}` },
    { name: "journey: page-instance token stable", ok: Boolean(bridgeJ1.journey) && bridgeJ1.journey.token === journeyToken, detail: `token ${bridgeJ1.journey ? bridgeJ1.journey.token : "(journey gone)"}` },
    { name: "journey: phase armed", ok: Boolean(bridgeJ1.journey) && bridgeJ1.journey.phase === "armed", detail: `phase ${bridgeJ1.journey ? bridgeJ1.journey.phase : "(none)"}` },
    { name: "journey: zero background starts", ok: Boolean(bridgeJ1.journey) && bridgeJ1.journey.startsCount === 0, detail: `starts ${bridgeJ1.journey ? bridgeJ1.journey.startsCount : "?"}` },
  ];
  for (const width of [1440, 1020, 860]) {
    await capture({
      state: "revise-draft",
      width,
      needles: [REVISE_CONTINUATION, AUDIT_LEAD, AUDIT_TEXT, "The earlier plan, changes and independent audit are below"],
      sendDisabled: false,
      consentChecked: false,
      jobVisible: false,
      scrollTo: ".revision-note",
      extraChecks: j1Checks,
      journeyStep: { step: "J1", label: "revise-draft", action: "click Revise (open the saved plan's revision draft)" },
    });
  }

  // J2 definite-refusal — first Send with background consent: exactly one
  // start, definite background-unavailable refusal, draft released intact.
  await viewport(1440, 900);
  await fill("#draft-message", INITIAL_MESSAGE);
  await clickCheckbox("Keep working after closing");
  await until("Boolean(document.querySelector('input[aria-label=\"Keep working after closing\"]').checked)");
  await click('.draft-composer-form button[type="submit"]');
  await until(`document.body.innerText.includes(${JSON.stringify(REFUSED_SENTENCE)})`);
  const bridgeJ2 = await readBridge();
  const j2Checks = [
    { name: "journey: exactly one start", ok: Boolean(bridgeJ2.journey) && bridgeJ2.journey.startsCount === 1, detail: `starts ${bridgeJ2.journey ? bridgeJ2.journey.startsCount : "?"}` },
    { name: "journey: phase definite-refused", ok: Boolean(bridgeJ2.journey) && bridgeJ2.journey.phase === "definite-refused", detail: `phase ${bridgeJ2.journey ? bridgeJ2.journey.phase : "(none)"}` },
    { name: "journey: first start captured with consent", ok: Boolean(bridgeJ2.journey) && bridgeJ2.journey.consent1 === true, detail: `consent1 ${bridgeJ2.journey ? bridgeJ2.journey.consent1 : "?"}` },
    { name: "journey: first start goal is the initial edit", ok: Boolean(bridgeJ2.journey) && bridgeJ2.journey.goal1 === INITIAL_MESSAGE, detail: `goal1 ${JSON.stringify(bridgeJ2.journey ? bridgeJ2.journey.goal1 : null)}` },
    { name: "journey: no job admitted", ok: Boolean(bridgeJ2.journey) && bridgeJ2.journey.jobId === null, detail: `jobId ${JSON.stringify(bridgeJ2.journey ? bridgeJ2.journey.jobId : null)}` },
  ];
  for (const width of [1440, 1020, 860]) {
    await capture({
      state: "definite-refusal",
      width,
      needles: [REFUSED_SENTENCE, REFUSED_SUFFIX],
      errorNeedles: [REFUSED_SENTENCE, REFUSED_SUFFIX],
      messageNeedle: INITIAL_MESSAGE,
      sendDisabled: false,
      consentChecked: false,
      jobVisible: false,
      scrollTo: ".dialog-note",
      extraChecks: j2Checks,
      journeyStep: { step: "J2", label: "definite-refusal", action: "type initial revision request, opt into background, click Send (first start)" },
    });
  }

  // J3 adjusted-draft — materially different correction, re-opt into background.
  await viewport(1440, 900);
  await fill("#draft-message", ADJUSTED_MESSAGE);
  await clickCheckbox("Keep working after closing");
  await until("Boolean(document.querySelector('input[aria-label=\"Keep working after closing\"]').checked)");
  const bridgeJ3 = await readBridge();
  const j3Checks = [
    { name: "journey: still exactly one start", ok: Boolean(bridgeJ3.journey) && bridgeJ3.journey.startsCount === 1, detail: `starts ${bridgeJ3.journey ? bridgeJ3.journey.startsCount : "?"}` },
    { name: "journey: request id unchanged by the edit", ok: Boolean(bridgeJ3.journey) && typeof bridgeJ3.journey.requestId1 === "string" && bridgeJ3.journey.requestId1.length > 0, detail: `requestId1 ${JSON.stringify(bridgeJ3.journey ? bridgeJ3.journey.requestId1 : null)}` },
  ];
  for (const width of [1440, 1020, 860]) {
    await capture({
      state: "adjusted-draft",
      width,
      // The adjusted goal lives in the textarea VALUE (not innerText); the
      // value check is the messageNeedle below.
      needles: [],
      messageNeedle: ADJUSTED_MESSAGE,
      sendDisabled: false,
      consentChecked: true,
      jobVisible: false,
      scrollTo: ".draft-composer-form",
      extraChecks: j3Checks,
      journeyStep: { step: "J3", label: "adjusted-draft", action: "replace the message with a different correction and opt into background again" },
    });
  }

  // J4 unknown-admission — second Send: exactly two starts total, the pinned
  // unknown marker keeps the draft blocked with the no-resend sentence, and
  // the pending job stays invisible while the status gate is closed.
  await viewport(1440, 900);
  await click('.draft-composer-form button[type="submit"]');
  await until(`document.body.innerText.includes(${JSON.stringify(NO_RESEND_SENTENCE)})`);
  const bridgeJ4 = await readBridge();
  const feedbackOk = (feedback) => Boolean(feedback)
    && feedback.previousExecutionReport === EXECUTION_TEXT
    && feedback.previousExecutionAudit === AUDIT_TEXT;
  const j4Checks = [
    { name: "journey: exactly two total starts", ok: Boolean(bridgeJ4.journey) && bridgeJ4.journey.startsCount === 2, detail: `starts ${bridgeJ4.journey ? bridgeJ4.journey.startsCount : "?"}` },
    { name: "journey: phase unknown-admission", ok: Boolean(bridgeJ4.journey) && bridgeJ4.journey.phase === "unknown-admission", detail: `phase ${bridgeJ4.journey ? bridgeJ4.journey.phase : "(none)"}` },
    { name: "journey: status gate still closed", ok: Boolean(bridgeJ4.journey) && bridgeJ4.journey.statusAvailable === false, detail: `statusAvailable ${bridgeJ4.journey ? bridgeJ4.journey.statusAvailable : "?"}` },
    { name: "journey: pending job invisible to status", ok: Boolean(bridgeJ4.journey) && bridgeJ4.journey.jobId !== null, detail: `pending jobId ${JSON.stringify(bridgeJ4.journey ? bridgeJ4.journey.jobId : null)}` },
    { name: "journey: same draft requestId across both starts", ok: Boolean(bridgeJ4.journey) && typeof bridgeJ4.journey.requestId1 === "string" && bridgeJ4.journey.requestId1 === bridgeJ4.journey.requestId2, detail: `${JSON.stringify(bridgeJ4.journey ? [bridgeJ4.journey.requestId1, bridgeJ4.journey.requestId2] : null)}` },
    { name: "journey: two different goals match the two edits", ok: Boolean(bridgeJ4.journey) && bridgeJ4.journey.goal1 === INITIAL_MESSAGE && bridgeJ4.journey.goal2 === ADJUSTED_MESSAGE && bridgeJ4.journey.goal1 !== bridgeJ4.journey.goal2, detail: `goals ${JSON.stringify(bridgeJ4.journey ? [bridgeJ4.journey.goal1, bridgeJ4.journey.goal2] : null)}` },
    { name: "journey: second start captured with consent", ok: Boolean(bridgeJ4.journey) && bridgeJ4.journey.consent2 === true, detail: `consent2 ${bridgeJ4.journey ? bridgeJ4.journey.consent2 : "?"}` },
    { name: "journey: first start carries execution feedback (report)", ok: feedbackOk(bridgeJ4.journey ? bridgeJ4.journey.feedback1 : null), detail: `feedback1 ${JSON.stringify(bridgeJ4.journey ? (bridgeJ4.journey.feedback1 ? { report: bridgeJ4.journey.feedback1.previousExecutionReport, audit: bridgeJ4.journey.feedback1.previousExecutionAudit } : null) : null)}` },
    { name: "journey: second start carries execution feedback (audit)", ok: feedbackOk(bridgeJ4.journey ? bridgeJ4.journey.feedback2 : null), detail: `feedback2 ${JSON.stringify(bridgeJ4.journey ? (bridgeJ4.journey.feedback2 ? { report: bridgeJ4.journey.feedback2.previousExecutionReport, audit: bridgeJ4.journey.feedback2.previousExecutionAudit } : null) : null)}` },
    { name: "journey: priorPlan/priorReview null when feedback used", ok: Boolean(bridgeJ4.journey) && bridgeJ4.journey.priorPlan1 === null && bridgeJ4.journey.priorReview1 === null, detail: `prior ${JSON.stringify(bridgeJ4.journey ? [bridgeJ4.journey.priorPlan1, bridgeJ4.journey.priorReview1] : null)}` },
  ];
  for (const width of [1440, 1020, 860]) {
    await capture({
      state: "unknown-admission",
      width,
      needles: [NO_RESEND_SENTENCE],
      errorNeedles: [NO_RESEND_SENTENCE],
      messageNeedle: ADJUSTED_MESSAGE,
      sendDisabled: true,
      consentChecked: false,
      jobVisible: false,
      scrollTo: ".dialog-note",
      extraChecks: j4Checks,
      journeyStep: { step: "J4", label: "unknown-admission", action: "click Send once (second start returns the pinned unknown marker)" },
    });
  }

  // J4b no-resend — real mouse click attempt on the DISABLED Send. Neither
  // harness click() nor clickFound() is used (both reject disabled controls):
  // expression-string geometry first, topmost-hit requirement, then CDP mouse.
  await viewport(1440, 900);
  const disabledPoint = await evaluate(`(() => {
    const e = document.querySelector('.draft-composer-form button[type="submit"]');
    if (!e) return null;
    const r = e.getBoundingClientRect();
    const x = r.x + r.width / 2, y = r.y + r.height / 2;
    if (!r.width || !r.height || x < 0 || x >= innerWidth || y < 0 || y >= innerHeight) return null;
    const top = document.elementFromPoint(x, y);
    if (!top || !(top === e || e.contains(top))) return null;
    return { x: x, y: y, disabled: e.disabled === true };
  })()`);
  if (disabledPoint && disabledPoint.disabled) {
    await clickPoint({ x: disabledPoint.x, y: disabledPoint.y });
  }
  // Wait through at least two of the app's 700ms status poll intervals.
  await sleep(1600);
  const domJ4b = await readDom();
  const bridgeJ4b = await readBridge();
  const j4bChecks = [
    { name: "J4b: disabled Send present and topmost hit target", ok: Boolean(disabledPoint) && disabledPoint.disabled === true, detail: `geometry ${JSON.stringify(disabledPoint)}` },
    { name: "J4b: starts remain two", ok: Boolean(bridgeJ4b.journey) && bridgeJ4b.journey.startsCount === 2, detail: `starts ${bridgeJ4b.journey ? bridgeJ4b.journey.startsCount : "?"}` },
    { name: "J4b: no unexpected (third) start", ok: Boolean(bridgeJ4b.journey) && bridgeJ4b.journey.unexpectedStarts === 0, detail: `unexpectedStarts ${bridgeJ4b.journey ? bridgeJ4b.journey.unexpectedStarts : "?"}` },
    { name: "J4b: no ordinary authorization, launch, or save", ok: Boolean(bridgeJ4b.journey) && bridgeJ4b.journey.authorizations === 0 && bridgeJ4b.journey.launches === 0 && bridgeJ4b.journey.saves === 0, detail: `counts ${JSON.stringify(bridgeJ4b.journey ? [bridgeJ4b.journey.authorizations, bridgeJ4b.journey.launches, bridgeJ4b.journey.saves] : null)}` },
    { name: "J4b: request unchanged", ok: Boolean(bridgeJ4b.journey) && bridgeJ4b.journey.requestId1 === bridgeJ4b.journey.requestId2 && bridgeJ4b.journey.goal2 === ADJUSTED_MESSAGE, detail: `second start ${JSON.stringify(bridgeJ4b.journey ? [bridgeJ4b.journey.requestId2, bridgeJ4b.journey.goal2] : null)}` },
    { name: "J4b: message unchanged", ok: domJ4b.message === ADJUSTED_MESSAGE, detail: `message ${JSON.stringify(domJ4b.message)}` },
    { name: "J4b: draft still blocked with the no-resend sentence", ok: domJ4b.sendDisabled === true && (domJ4b.errorText ?? "").includes(NO_RESEND_SENTENCE), detail: `sendDisabled ${domJ4b.sendDisabled}, error ${JSON.stringify((domJ4b.errorText ?? "").slice(0, 120))}` },
    { name: "J4b: still no visible job", ok: domJ4b.jobVisible === false, detail: `jobVisible ${domJ4b.jobVisible}` },
    { name: "J4b: phase unchanged", ok: Boolean(bridgeJ4b.journey) && bridgeJ4b.journey.phase === "unknown-admission", detail: `phase ${bridgeJ4b.journey ? bridgeJ4b.journey.phase : "(none)"}` },
  ];
  results.push({
    state: "attempted-resend-disabled-send",
    width: null,
    supplemental: false,
    journeyStep: "J4b attempted-resend",
    assertionTextfound: true,
    sendDisabled: domJ4b.sendDisabled,
    checks: j4bChecks.map((check) => ({ name: check.name, ok: check.ok, detail: check.detail })),
    errorArea: domJ4b.errorText,
    jobSentence: domJ4b.jobSentence,
    jobId: domJ4b.jobId,
    jobGoal: domJ4b.jobGoal,
    returnControl: domJ4b.returnControl,
    draftMessage: domJ4b.message,
    consentChecked: domJ4b.consentChecked,
    stopAllowing: domJ4b.stopAllowing,
  });
  {
    const stepFailed = recordJourneyStep({ step: "J4b", label: "attempted-resend", action: "real mouse click on the disabled Send, then wait through two poll intervals" }, domJ4b, bridgeJ4b, j4bChecks);
    if (stepFailed.length) failures.push({ state: "J4b attempted-resend", width: null, failed: stepFailed, body: domJ4b.body.slice(0, 2000), errorArea: domJ4b.errorText });
  }

  // J5 attach — release fixture status availability (host orchestration) and
  // let the app's EXISTING 700ms poll attach the pending job. No third Send.
  await viewport(1440, 900);
  const release = await evaluate("window.__shotReleaseJourneyStatus()");
  if (!release || release.released !== true) {
    throw new Error(`__shotReleaseJourneyStatus did not publish the pending job: ${JSON.stringify(release)}`);
  }
  const releaseChecks = [
    { name: "J5: release helper published the pending job", ok: Boolean(release) && release.released === true, detail: `release ${JSON.stringify(release)}` },
    { name: "J5: release kept the second start's request identity", ok: Boolean(release) && release.released === true && release.requestId === bridgeJ4b.journey.requestId2, detail: `requestId ${JSON.stringify(release ? release.requestId : null)}` },
  ];
  await until("Boolean(document.querySelector('.background-job'))");
  await until(`Boolean(document.querySelector('.background-job')) && document.querySelector('.background-job').getAttribute('data-job-id') === ${JSON.stringify(release && release.jobId ? release.jobId : "")}`);
  const stopReachable = await evaluate(`(() => {
    const target = Array.from(document.querySelectorAll('.background-job button')).find((node) => (node.innerText || '').trim() === 'Stop allowing');
    if (!target || target.disabled) return false;
    const r = target.getBoundingClientRect();
    const x = r.x + r.width / 2, y = r.y + r.height / 2;
    if (!r.width || !r.height || x < 0 || x >= innerWidth || y < 0 || y >= innerHeight) return false;
    const top = document.elementFromPoint(x, y);
    return top === target || target.contains(top);
  })()`);
  const bridgeJ5 = await readBridge();
  const j5Checks = [
    ...releaseChecks,
    { name: "J5: attached without another Send (starts still two)", ok: Boolean(bridgeJ5.journey) && bridgeJ5.journey.startsCount === 2, detail: `starts ${bridgeJ5.journey ? bridgeJ5.journey.startsCount : "?"}` },
    { name: "J5: DOM data-job-id matches the pending job", ok: Boolean(release) && release.released === true, detail: `release ${JSON.stringify(release)} (DOM check in capture: jobId=${release && release.jobId ? release.jobId : null})` },
    { name: "J5: attached job request matches the second start", ok: Boolean(bridgeJ5.journey) && bridgeJ5.journey.jobRequestId === bridgeJ5.journey.requestId2, detail: `${JSON.stringify(bridgeJ5.journey ? [bridgeJ5.journey.jobRequestId, bridgeJ5.journey.requestId2] : null)}` },
    { name: "J5: adjusted goal retained on the job", ok: Boolean(bridgeJ5.journey) && bridgeJ5.journey.jobGoal === ADJUSTED_MESSAGE, detail: `jobGoal ${JSON.stringify(bridgeJ5.journey ? bridgeJ5.journey.jobGoal : null)}` },
    { name: "J5: Stop allowing reachable (topmost at center)", ok: stopReachable === true, detail: `stopReachable ${stopReachable}` },
  ];
  for (const width of [1440, 1020, 860]) {
    await capture({
      state: "job-unconfirmed",
      width,
      needles: [UNCONFIRMED_SENTENCE, NO_REPLAY_SENTENCE, ADJUSTED_MESSAGE],
      sendDisabled: null,
      stopAllowing: true,
      draftVisible: false,
      expectJobId: release && release.jobId ? release.jobId : undefined,
      scrollTo: ".background-job",
      extraChecks: j5Checks,
      journeyStep: { step: "J5", label: "job-unconfirmed", action: "release fixture status availability; existing app poll attaches the job" },
    });
  }

  // J6 revoke — Stop allowing: exactly one revoke for THAT job, uncertainty
  // wording retained, no claim that processes or tools stopped.
  await viewport(1440, 900);
  await clickText("Stop allowing");
  await until("Array.from(document.querySelectorAll('button')).every((node) => (node.innerText || '').trim() !== 'Stop allowing')");
  const bridgeJ6 = await readBridge();
  const j6Checks = [
    { name: "J6: exactly one revoke for that job", ok: Boolean(bridgeJ6.journey) && bridgeJ6.journey.revokesCount === 1 && bridgeJ6.journey.revocationJobIds[0] === (release && release.jobId), detail: `revocations ${JSON.stringify(bridgeJ6.journey ? bridgeJ6.journey.revocationJobIds : null)}` },
    { name: "J6: revoke matched the job id (no mismatch)", ok: Boolean(bridgeJ6.journey) && bridgeJ6.journey.revokeMismatch === false, detail: `revokeMismatch ${bridgeJ6.journey ? bridgeJ6.journey.revokeMismatch : "?"}` },
    { name: "J6: job revoked with facts preserved", ok: Boolean(bridgeJ6.journey) && bridgeJ6.journey.jobRevoked === true && bridgeJ6.journey.jobRequestId === bridgeJ6.journey.requestId2 && bridgeJ6.journey.jobGoal === ADJUSTED_MESSAGE && bridgeJ6.journey.jobState === "unconfirmed", detail: `job ${JSON.stringify(bridgeJ6.journey ? { requestId: bridgeJ6.journey.jobRequestId, goal: bridgeJ6.journey.jobGoal, state: bridgeJ6.journey.jobState, revoked: bridgeJ6.journey.jobRevoked } : null)}` },
    { name: "J6: no additional start", ok: Boolean(bridgeJ6.journey) && bridgeJ6.journey.startsCount === 2, detail: `starts ${bridgeJ6.journey ? bridgeJ6.journey.startsCount : "?"}` },
  ];
  for (const width of [1440, 1020, 860]) {
    await capture({
      state: "job-revoked-unconfirmed",
      width,
      needles: [UNCONFIRMED_SENTENCE, NO_REPLAY_SENTENCE, ADJUSTED_MESSAGE],
      absentNeedles: [REVOKED_CLAIM_PREFIX, STOP_CAPTION_TAIL],
      sendDisabled: null,
      stopAllowing: false,
      draftVisible: false,
      expectJobId: release && release.jobId ? release.jobId : undefined,
      scrollTo: ".background-job",
      extraChecks: j6Checks,
      journeyStep: { step: "J6", label: "job-revoked-unconfirmed", action: "click Stop allowing" },
    });
  }

  // J7 leave — Leave job view: job region absent, return control visible, the
  // adjusted blocked draft and its no-resend sentence remain.
  await viewport(1440, 900);
  await clickText("Leave job view");
  await until("Boolean(document.querySelector('.background-return button')) && document.querySelector('.background-return button').innerText.trim() === 'Return to background goal'");
  await until("!Boolean(document.querySelector('.background-job'))");
  const bridgeJ7 = await readBridge();
  const j7Checks = [
    { name: "J7: job still retained by the bridge", ok: Boolean(bridgeJ7.journey) && bridgeJ7.journey.jobId === (release && release.jobId) && bridgeJ7.journey.jobRevoked === true, detail: `job ${JSON.stringify(bridgeJ7.journey ? { jobId: bridgeJ7.journey.jobId, revoked: bridgeJ7.journey.jobRevoked } : null)}` },
    { name: "J7: no additional start or revoke", ok: Boolean(bridgeJ7.journey) && bridgeJ7.journey.startsCount === 2 && bridgeJ7.journey.revokesCount === 1, detail: `counts ${JSON.stringify(bridgeJ7.journey ? [bridgeJ7.journey.startsCount, bridgeJ7.journey.revokesCount] : null)}` },
  ];
  for (const width of [1440, 1020, 860]) {
    await capture({
      state: "left-job-view",
      width,
      // The retained draft goal lives in the textarea VALUE (messageNeedle);
      // the no-resend sentence stays in .dialog-note.
      needles: [NO_RESEND_SENTENCE],
      errorNeedles: [NO_RESEND_SENTENCE],
      messageNeedle: ADJUSTED_MESSAGE,
      sendDisabled: true,
      consentChecked: false,
      jobVisible: false,
      returnControl: "Return to background goal",
      draftVisible: true,
      scrollTo: ".draft-composer-form",
      extraChecks: j7Checks,
      journeyStep: { step: "J7", label: "left-job-view", action: "click Leave job view" },
    });
  }

  // J8 return — Return to background goal: the SAME job id, goal, revoked
  // flag and retained facts; counts unchanged; no Stop allowing, no Send.
  await viewport(1440, 900);
  await clickText("Return to background goal");
  await until("Boolean(document.querySelector('.background-job'))");
  const bridgeJ8 = await readBridge();
  const j8Checks = [
    ...j7Checks,
    { name: "J8: same job id, goal and revoked flag", ok: Boolean(bridgeJ8.journey) && bridgeJ8.journey.jobId === (release && release.jobId) && bridgeJ8.journey.jobGoal === ADJUSTED_MESSAGE && bridgeJ8.journey.jobRevoked === true, detail: `job ${JSON.stringify(bridgeJ8.journey ? { jobId: bridgeJ8.journey.jobId, goal: bridgeJ8.journey.jobGoal, revoked: bridgeJ8.journey.jobRevoked } : null)}` },
    { name: "J8: counters unchanged (auth/launch/save zero)", ok: Boolean(bridgeJ8.journey) && bridgeJ8.journey.authorizations === 0 && bridgeJ8.journey.launches === 0 && bridgeJ8.journey.saves === 0, detail: `counts ${JSON.stringify(bridgeJ8.journey ? [bridgeJ8.journey.authorizations, bridgeJ8.journey.launches, bridgeJ8.journey.saves] : null)}` },
  ];
  for (const width of [1440, 1020, 860]) {
    await capture({
      state: "returned-job-view",
      width,
      needles: [UNCONFIRMED_SENTENCE, NO_REPLAY_SENTENCE, ADJUSTED_MESSAGE],
      absentNeedles: [REVOKED_CLAIM_PREFIX],
      sendDisabled: null,
      stopAllowing: false,
      draftVisible: false,
      expectJobId: release && release.jobId ? release.jobId : undefined,
      scrollTo: ".background-job",
      extraChecks: j8Checks,
      journeyStep: { step: "J8", label: "returned-job-view", action: "click Return to background goal" },
    });
  }

  // Third journey Start must throw unexpected-resend (fixture guard probe —
  // a driver-initiated bridge check, not a user action; throws before any
  // state mutation, so the journey record stays intact).
  const thirdProbe = await evaluate(`window.goalportCore.backgroundStart({ requestId: "driver-probe-third-start", goal: "third-start guard probe" }).then(function (value) { return "no-throw: " + JSON.stringify(value); }, function (error) { return "threw: " + (error && error.message ? error.message : String(error)); })`);
  const bridgeG1 = await readBridge();
  const g1Checks = [
    { name: "G1: third journey start threw unexpected-resend", ok: typeof thirdProbe === "string" && thirdProbe.startsWith("threw: ") && thirdProbe.includes("unexpected-resend"), detail: String(thirdProbe) },
    { name: "G1: start count still two", ok: Boolean(bridgeG1.journey) && bridgeG1.journey.startsCount === 2, detail: `starts ${bridgeG1.journey ? bridgeG1.journey.startsCount : "?"}` },
    { name: "G1: probe recorded as unexpected", ok: Boolean(bridgeG1.journey) && bridgeG1.journey.unexpectedStarts === 1, detail: `unexpectedStarts ${bridgeG1.journey ? bridgeG1.journey.unexpectedStarts : "?"}` },
    { name: "G1: revoke count still one", ok: Boolean(bridgeG1.journey) && bridgeG1.journey.revokesCount === 1, detail: `revokes ${bridgeG1.journey ? bridgeG1.journey.revokesCount : "?"}` },
  ];
  results.push({
    state: "journey-third-start-guard",
    width: null,
    supplemental: false,
    journeyStep: "G1 third-start-guard",
    assertionTextfound: true,
    sendDisabled: null,
    checks: g1Checks.map((check) => ({ name: check.name, ok: check.ok, detail: check.detail })),
    errorArea: null,
    jobSentence: null,
    jobId: bridgeG1.journey ? bridgeG1.journey.jobId : null,
    jobGoal: bridgeG1.journey ? bridgeG1.journey.jobGoal : null,
    returnControl: null,
    draftMessage: null,
    consentChecked: null,
    stopAllowing: 0,
    probe: thirdProbe,
  });
  {
    const stepFailed = recordJourneyStep({ step: "G1", label: "third-start-guard", action: "fixture guard probe: a third journey backgroundStart must throw unexpected-resend" }, null, bridgeG1, g1Checks, { probe: thirdProbe });
    if (stepFailed.length) failures.push({ state: "G1 third-start-guard", width: null, failed: stepFailed, body: "", errorArea: null });
  }

  // Snapshot journey.json BEFORE the supplemental scenario reset (Amendment
  // r1 A1): the artifact must preserve the full journey state even though a
  // supplemental scenario runs afterward.
  const dump = await evaluate("window.__shotJourneyDump()");
  const tokenUnchanged = Boolean(dump) && dump.token === journeyToken;
  const journeyPass = tokenUnchanged
    && journeyFailures === 0
    && Boolean(dump)
    && dump.startsCount === 2
    && dump.revocations.length === 1
    && dump.revocations[0] === dump.jobId
    && dump.revokeMismatch === false
    && dump.authorizations === 0 && dump.launches === 0 && dump.saves === 0
    && dump.jobRevoked === true
    && typeof thirdProbe === "string" && thirdProbe.startsWith("threw: ");
  const journeyDoc = {
    sourceSha,
    generatedAt: new Date().toISOString(),
    pageInstanceToken: journeyToken,
    pageInstanceTokenUnchanged: tokenUnchanged,
    snapshotStage: "after J8 + third-start guard, BEFORE the post-J8 supplemental scenario reset (Amendment r1 A1)",
    steps: journeySteps,
    bridge: dump ? {
      phase: dump.phase,
      statusAvailable: dump.statusAvailable,
      statusPolls: dump.statusPolls,
      starts: dump.startsCount,
      revokes: dump.revocations.length,
      requestIds: { first: dump.starts[0] ? dump.starts[0].requestId : null, second: dump.starts[1] ? dump.starts[1].requestId : null },
      goals: { first: dump.starts[0] ? dump.starts[0].goal : null, second: dump.starts[1] ? dump.starts[1].goal : null },
      jobId: dump.jobId,
      jobRequestId: dump.jobRequestId,
      jobGoal: dump.jobGoal,
      jobRevoked: dump.jobRevoked,
      counts: { authorizations: dump.authorizations, launches: dump.launches, saves: dump.saves },
      revokeMismatch: dump.revokeMismatch,
      unexpectedStarts: dump.unexpectedStarts,
      thirdStartError: dump.thirdStartError,
    } : null,
    capturedStarts: dump ? dump.starts : [],
    trace: dump ? dump.trace : [],
    thirdStartGuard: { probe: thirdProbe },
    pass: journeyPass,
  };
  writeFileSync(resolve(outDir, "journey.json"), `${JSON.stringify(journeyDoc, null, 2)}\n`);
  journeySnapshotWritten = true;
  if (!journeyPass) {
    failures.push({ state: "journey-summary", width: null, failed: [{ name: "journey overall pass", ok: false, detail: `tokenUnchanged=${tokenUnchanged} journeyFailures=${journeyFailures}` }], body: "", errorArea: null });
  }

  // -----------------------------------------------------------------------
  // Supplemental (outside the journey, after its snapshot): the
  // competing-runtime guard scenario with its real picker/click assertions.
  // -----------------------------------------------------------------------
  await viewport(1440, 900);
  await evaluate(`window.__shotScenario("conflict")`);
  await click('button[aria-label="New goal"]');
  await until("Boolean(document.querySelector('.draft-composer-form'))");
  await until("Boolean(document.querySelector('input[aria-label=\"Keep working after closing\"]'))");
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
    supplemental: true,
  });
} catch (error) {
  driverError = error;
} finally {
  // Amendment r1 A1: journey.json was snapshotted before the supplemental
  // reset; on an earlier failure this preserves whatever journey evidence
  // exists so unexpected timeouts also produce a usable failure record.
  if (!journeySnapshotWritten) {
    let dump = null;
    try { dump = evaluate ? await evaluate("window.__shotJourneyDump()") : null; } catch { dump = null; }
    try {
      writeFileSync(resolve(outDir, "journey.json"), `${JSON.stringify({
        sourceSha,
        generatedAt: new Date().toISOString(),
        pageInstanceToken: journeyToken,
        pageInstanceTokenUnchanged: Boolean(dump) && dump.token === journeyToken,
        snapshotStage: "incomplete — written from the failure path before the post-J8 snapshot",
        steps: journeySteps,
        bridge: lastBridgeState,
        dump,
        pass: false,
      }, null, 2)}\n`);
    } catch { /* outDir unwritable: nothing more to do here */ }
  }
  try {
    writeFileSync(resolve(outDir, "assertions.json"), `${JSON.stringify(results, null, 2)}\n`);
  } catch { /* outDir unwritable: the run summary below still reports */ }
  if (preview) await preview.stop();
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
const columns = ["state", "width", "text", "send", "stop", "consent", "job", "result"];
const rows = results.map((entry) => [
  entry.state,
  entry.width === null ? "-" : String(entry.width),
  entry.assertionTextfound ? "found" : "MISSING",
  entry.sendDisabled === null ? "-" : entry.sendDisabled ? "disabled" : "enabled",
  entry.stopAllowing > 0 ? "visible" : "hidden",
  entry.consentChecked === null ? "-" : entry.consentChecked ? "on" : "off",
  entry.jobId ? "attached" : entry.state === "unknown-admission" || entry.state.startsWith("attempted") ? "gated" : "-",
  entry.checks.every((check) => check.ok) ? "pass" : "FAIL",
]);
const widths = columns.map((column, index) => Math.max(column.length, ...rows.map((row) => row[index].length)));
console.log(columns.map((column, index) => column.padEnd(widths[index])).join("  "));
console.log(widths.map((width) => "-".repeat(width)).join("  "));
for (const row of rows) console.log(row.map((cell, index) => cell.padEnd(widths[index])).join("  "));
const journeyStepRows = journeySteps.filter((step) => !step.ok).map((step) => `${step.step} ${step.label}`);
console.log(`\njourney: token=${journeyToken} steps=${journeySteps.length} failedSteps=${journeyStepRows.length ? journeyStepRows.join(", ") : "none"}`);
console.log(`bridge: ${JSON.stringify(lastBridgeState)}`);
console.log(`screenshots: ${results.filter((entry) => entry.width !== null).length} -> ${outDir}`);
console.log(`artifacts: ${resolve(outDir, "assertions.json")}, ${resolve(outDir, "journey.json")}`);
if (driverError) {
  console.error(`\nDRIVER ERROR: ${driverError && driverError.stack ? driverError.stack : driverError}`);
}
if (failures.length) {
  console.error(`\nFAILED ${failures.length} check group(s):`);
  for (const failure of failures) {
    console.error(`- ${failure.state}${failure.width === null ? "" : `-${failure.width}`}: ${failure.failed.map((check) => `${check.name} (${check.detail})`).join("; ")}`);
    console.error(`  error area: ${JSON.stringify(failure.errorArea)}`);
    console.error(`  body: ${JSON.stringify(failure.body.slice(0, 600))}`);
  }
  process.exit(1);
}
if (driverError) process.exit(1);
console.log("all state assertions green; journey pass");
