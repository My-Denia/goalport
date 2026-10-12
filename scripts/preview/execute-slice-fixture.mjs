// Shared fixture for the execute-slice preview drivers
// (shot-execute-slice.mjs / verify-execute-slice.mjs).
//
// This is a synthetic, zero-quota preview boundary: the bridge below replaces
// the desktop bridge inside a COPY of the BUILT dist HTML. It exists only in
// generated preview pages — never in the shipped app — and it launches no
// real vendor CLI, model call, or file mutation. One fixture/state set drives
// all seven execute-slice states at all three widths, so the shot and verify
// drivers exercise the same states instead of maintaining a second state
// system.
//
// Importing this module is side-effect free: it reads nothing from disk and
// writes nothing. Only the driver entrypoints touch the filesystem or start
// the preview harness. `scripts/preview/execute-slice.test.mjs` pins that.
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

export const EXECUTE_SCENARIOS = [
  "consent",
  "making-changes",
  "verifying",
  "verified",
  "partial-write-failure",
  "no-write-stop",
  "read-budget2-stop",
];

export const EXECUTE_WIDTHS = [860, 1020, 1440];

export const SYNTHETIC_LABEL = "SYNTHETIC BUILT UI PREVIEW · zero model quota · no file mutation";

export const EXECUTE_GOAL = "Handle empty input in helper.ts and independently verify the changes.";
export const EXECUTE_WORKSPACE = "/work/goal";
export const EXECUTE_READ_TURNS = 4;
export const EXECUTE_WRITE_TURNS = 2;

// Per-scenario driving facts, shared by both drivers and pinned by the pure
// test: which consents to give, which launches the synthetic bridge should
// therefore observe, and what each state must show.
export function executeScenarioPlan(scenario) {
  const write = scenario !== "consent" && scenario !== "no-write-stop";
  return {
    scenario,
    goal: EXECUTE_GOAL,
    workspaceRoot: EXECUTE_WORKSPACE,
    writeConsent: write,
    readTurns: scenario === "read-budget2-stop" ? 2 : EXECUTE_READ_TURNS,
    writeTurns: EXECUTE_WRITE_TURNS,
    // Roles the bridge must see launched once the send resolves the chain.
    expectedLaunches: scenario === "consent" ? []
      : scenario === "no-write-stop" || scenario === "read-budget2-stop" ? ["plan", "review"]
      : ["plan", "review", "execute", "audit"],
    // Role whose launch result the bridge holds open for the in-flight states.
    hold: scenario === "making-changes" ? "execute" : scenario === "verifying" ? "audit" : null,
    partialFailure: scenario === "partial-write-failure",
  };
}

export function emptyExecuteSnapshot() {
  return {
    protocolVersion: "goalport.ipc.v2",
    buildId: "execute-slice-synthetic-preview",
    connection: "connected",
    projects: [],
    selectedProjectId: "",
    project: { id: "", name: "No project", workspaceRoot: EXECUTE_WORKSPACE, color: "slate" },
    campaigns: [],
    activeCampaignId: "",
    activeTask: { id: "", title: "No task selected", acceptance: "", state: "waiting" },
    attempt: { id: "attempt-unassigned", taskId: "", provider: "unassigned", role: "executor", state: "waiting", sessionLabel: "No Runtime selected", eventCount: 0 },
    timeline: [],
    cursor: 0,
    runtimes: [],
    decisions: [],
    evidence: [],
    stopResponsibility: null,
    relatedHolds: [],
    preview: false,
    notices: [],
    productConversation: null,
  };
}

export function executeProviders() {
  const provider = (id, name) => ({
    instanceId: id,
    displayName: name,
    driver: id,
    enabled: true,
    installed: true,
    availability: "available",
    status: "ready",
    auth: { status: "authenticated", type: "subscription" },
    models: [{ slug: `${id}-model`, name: `${id}-model`, isDefault: true }],
    usageLimits: { windows: [{ id: "five_hour", usedPercent: 1 }] },
  });
  return [provider("codex", "Codex"), provider("claude", "Claude")];
}

const RESULT_TEXTS = {
  plan: "1. Inspect helper.ts and its existing tests.\n2. Update the helper and check the behavior.",
  review: "The bounded plan can be carried out.\nVERDICT: carry-out",
  execute: "Updated helper.ts and helper.test.ts. The helper now handles an empty input.",
  audit: "Independently inspected both changed files and the reported test output. The behavior matches the goal.\nVERDICT: verified",
};

const PARTIAL_TEXTS = {
  text: "Updated helper.ts, but the test update did not finish.",
  errorText: "The changes stopped midway. Files may already have changed.",
};

const SAVE_FAILURE_NOTICE = "The result is on screen, but it could not be saved for the next time you open GoalPort. Any changes already made are not undone; inspect the workspace before a new send.";

// The same JSON-escaping discipline as the other preview drivers: "<"
// becomes "\u003c" so no value can close the <script> tag early, and the JS
// line separators are escaped too.
export function jsonValueForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function executeSliceBridgeScript() {
  const snapshot = jsonValueForScript(emptyExecuteSnapshot());
  const providers = jsonValueForScript(executeProviders());
  const texts = jsonValueForScript(RESULT_TEXTS);
  const partial = jsonValueForScript(PARTIAL_TEXTS);
  const notice = jsonValueForScript(SAVE_FAILURE_NOTICE);
  const label = jsonValueForScript(SYNTHETIC_LABEL);
  return `    <script>
window.__GOALPORT_ELECTRON__ = true;
(() => {
  const snapshot = ${snapshot};
  const providers = ${providers};
  const texts = ${texts};
  const partial = ${partial};
  const saveFailureNotice = ${notice};
  const scenario = new URLSearchParams(location.search).get("scenario") ?? "";
  const saveFailureMode = new URLSearchParams(location.search).get("mode") === "save-failure";
  let scope = null;
  let generation = 0;
  let records = [];
  if (!saveFailureMode) {
    // Reloaded-history mode: a prior page ferries its saved records through
    // window.name so this page boots like a restarted app, then clears it.
    try {
      const ferried = JSON.parse(window.name).__exRecords;
      if (Array.isArray(ferried)) records = ferried;
    } catch { /* no ferried records: a fresh app boot */ }
    window.name = "";
  }
  window.__ex = { scenario, saveFailureMode, log: [], saves: [], saveFailures: [], closed: false, held: null, release: () => window.__ex.held?.(), records: () => JSON.parse(JSON.stringify(records)) };
  const resultFor = (role) => ({
    text: texts[role],
    errorText: "",
    dispatched: true,
    turnsRemaining: scope?.remaining ?? null,
    writeTurnsRemaining: scope?.write?.remaining ?? null,
  });
  window.goalportCore = {
    snapshot: async () => snapshot,
    command: async () => snapshot,
    startCore: async () => snapshot,
    openInVsCode: async () => undefined,
    appInfo: async () => ({ version: "Synthetic preview", channel: "zero-quota", testMode: false, dataPath: "synthetic preview memory", coordinationConfigured: true }),
    coordinateCancel: async () => undefined,
    coordinateDiscover: async () => ({ connected: true, sendAuthorized: true, providers, stopReason: null }),
    coordinationAuthorize: async (payload) => {
      generation += 1;
      scope = {
        instances: [...payload.instances],
        maxTurns: payload.maxTurns,
        remaining: payload.maxTurns,
        generation,
        ...(payload.write ? { write: { ...payload.write, instances: [...payload.write.instances], remaining: payload.write.maxTurns } } : {}),
      };
      window.__ex.log.push({ authorize: payload, generation });
      return { ok: true, generation, remaining: scope.remaining, ...(scope.write ? { writeTurnsRemaining: scope.write.remaining } : {}) };
    },
    coordinationScope: async () => (scope ? JSON.parse(JSON.stringify(scope)) : null),
    coordinationRevoke: async () => { scope = null; return { ok: true }; },
    coordinationUnblock: async () => ({ ok: true }),
    coordinateLaunch: (command, requestGeneration, scopeGeneration) => {
      const role = command.commandId.split("-")[1];
      window.__ex.log.push({
        role,
        commandId: command.commandId,
        instance: command.modelSelection.instanceId,
        workspace: command.workspaceStrategy?.worktreePath,
        sandbox: command.sandboxPolicy?.type,
        requestGeneration,
        scopeGeneration,
      });
      if (scopeGeneration !== scope?.generation) {
        return Promise.resolve({ text: "", errorText: "Synthetic scope revoked.", dispatched: false, stopCode: "scope-revoked", turnsRemaining: null, writeTurnsRemaining: null });
      }
      if (role === "execute") scope.write.remaining -= 1; else scope.remaining -= 1;
      const result = resultFor(role);
      if (scenario === "partial-write-failure" && role === "execute") {
        return Promise.resolve({ ...result, text: partial.text, errorText: partial.errorText, dispatched: true });
      }
      if ((scenario === "making-changes" && role === "execute") || (scenario === "verifying" && role === "audit")) {
        return new Promise((resolve) => { window.__ex.held = () => { window.__ex.held = null; resolve(result); }; });
      }
      return Promise.resolve(result);
    },
    coordinationSave: async (record) => {
      if (saveFailureMode && record.verdict !== "unconfirmed") {
        window.__ex.saveFailures.push({ verdict: record.verdict });
        throw new Error("Synthetic preview: final save failed.");
      }
      const saved = { ...record, savedAt: new Date().toISOString() };
      records = [saved, ...records.filter((item) => item.requestId !== saved.requestId)];
      window.__ex.saves.push(saved);
      return saved;
    },
    coordinationRecords: async () => records,
    requestClose: async () => { window.__ex.closed = true; },
  };
  addEventListener("DOMContentLoaded", () => {
    const note = document.createElement("div");
    note.textContent = ${label};
    Object.assign(note.style, { position: "fixed", bottom: "0", right: "0", zIndex: "10000", background: "#162533", color: "#eaf0f6", font: "11px sans-serif", padding: "5px 10px", pointerEvents: "none" });
    document.body.append(note);
  });
})();
</script>
`;
}

// Build the full preview page from the BUILT dist index.html: identical app,
// identical assets, bridge injected before </head>. Throws if the injection
// did not happen so a changed build shape fails loudly instead of silently
// previewing the real (bridge-less) page.
export function executeSlicePageHtml(indexHtml) {
  if (typeof indexHtml !== "string" || !indexHtml.includes("</head>")) {
    throw new Error("execute-slice fixture: dist/index.html has no </head> to inject before");
  }
  const page = indexHtml.replace("</head>", `${executeSliceBridgeScript()}</head>`);
  if (page === indexHtml) throw new Error("execute-slice fixture: bridge injection did not change the page");
  if (!page.includes(SYNTHETIC_LABEL)) throw new Error("execute-slice fixture: synthetic label missing from preview page");
  return page;
}

// Explicit fresh evidence directory for driver outputs. Refuses to touch an
// existing non-empty directory so old evidence is never overwritten or mixed.
export function prepareFreshEvidenceDir(outPath, label = "evidence") {
  if (typeof outPath !== "string" || !outPath.trim()) throw new Error(`${label} requires an explicit fresh output path`);
  const dir = resolve(outPath);
  if (existsSync(dir)) {
    if (!statSync(dir).isDirectory()) throw new Error(`${label} path exists and is not a directory: ${dir}`);
    if (readdirSync(dir).length > 0) throw new Error(`${label} path already exists and is not empty; pass a fresh path: ${dir}`);
  } else {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function sha256File(path, { readFile }) {
  return createHash("sha256").update(readFile(path)).digest("hex");
}
