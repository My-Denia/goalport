// Screenshot acceptance driver for the resource-recovery (harness access +
// automatic takeover) slice. Drives the real send flow through an injected
// electron-style bridge with the FULL scope surface (coordinateDiscover with
// environmentHealth, coordinateLaunch with per-scenario scripted results and
// deferred holds, coordinationAuthorize/Scope/Revoke/Unblock), so the nine
// named subfixture categories of plan §4E render end to end against
// vite-built dist. Screenshot-only; nothing here ships in the product.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { startPreview } from "../preview/harness.mjs";

const outDir = resolve(process.argv[2] ?? "goal-runs/goalport-resource-recovery/evidence/shots");
const distRoot = resolve("dist");
mkdirSync(outDir, { recursive: true });

// Minimal connected CoreSnapshot (the shape of EMPTY_SNAPSHOT with a live
// connection) so the electron stub boots into the first-run state.
const emptySnapshot = {
  protocolVersion: "goalport.ipc.v2",
  buildId: "shot-stub",
  connection: "connected",
  projects: [],
  selectedProjectId: "",
  project: { id: "", name: "No project", workspaceRoot: "C:\\workspace\\goalport", color: "slate" },
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

const ENV_DETAIL = "Failed to create unified exec process: helper_unknown_error: setup refresh had errors";
const PLAN_OK = { text: "1. Open the contract the plan relies on and cite its path.\n2. Change only the plan state and its test.\n3. Hand back a bounded plan without claiming the check passed.", errorText: "" };
const REVIEW_OK = { text: "The plan can be carried out.\nVERDICT: carry-out", errorText: "" };
const ENV_BLOCKED = {
  text: "I couldn't read the file because the sandbox failed to initialize.",
  errorText: "This agent cannot run its tools on this machine, so this stopped.",
  dispatched: true,
  environmentBlocked: true,
  environmentDetail: ENV_DETAIL,
};

const NAME_OF = { codex: "Codex", claude: "Claude", grok: "Grok" };

// The panel rows the matrix needs: one usable subscription harness, one
// blocked on this machine (evidence-stamped), one paid-api.
function provider(id, overrides = {}) {
  return {
    instanceId: id,
    displayName: NAME_OF[id] ?? id,
    driver: id,
    enabled: true,
    installed: true,
    availability: "available",
    status: "ready",
    auth: { status: "authenticated", type: "subscription" },
    models: [{ slug: `${id}-model`, name: `${id}-model`, isDefault: true }],
    usageLimits: { windows: [{ id: "five_hour", usedPercent: 1 }] },
    ...overrides,
  };
}

const blockedCodex = () => provider("codex", {
  environmentHealth: { since: "2026-10-08T18:32:00.000Z", detail: ENV_DETAIL },
});
const healthy = (id) => provider(id);
const paidGrok = () => provider("grok", { auth: { status: "authenticated", type: "apiKey" } });

function bridgeScript({ providers, seedScope = null, fromWindowName = false }) {
  const bridge = {
    snapshot: emptySnapshot,
    appInfo: { version: "shot", channel: "shot", testMode: false, dataPath: "profile", coordinationConfigured: true },
    providers,
    seedScope,
    fromWindowName,
  };
  const json = JSON.stringify(bridge)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return `    <script>
window.__GOALPORT_ELECTRON__ = true;
(() => {
  const stub = ${json};
  // Historical records ride window.name across the simulated restart: the
  // saved round survives (disk semantics) while the in-memory authorization
  // scope does not (session-bound main-process memory).
  let records = [];
  if (stub.fromWindowName) {
    try {
      const ferried = JSON.parse(window.name).__rrRecords;
      if (Array.isArray(ferried)) records = ferried;
    } catch { records = []; }
    window.name = "";
  }
  let scopeState = stub.seedScope ? { ...stub.seedScope } : null;
  let generationCounter = stub.seedScope ? stub.seedScope.generation : 0;
  let closePrompt = null;
  const PLAN = ${JSON.stringify(PLAN_OK).replace(/</g, "\\u003c")};
  const REVIEW = ${JSON.stringify(REVIEW_OK).replace(/</g, "\\u003c")};
  window.__rr = {
    log: [],
    behaviors: [],
    held: [],
    records,
    release: (behavior) => {
      const held = window.__rr.held.splice(0);
      const list = Array.isArray(behavior) ? behavior : [behavior];
      held.forEach((entry, index) => {
        const chosen = list[Math.min(index, list.length - 1)];
        const result = { turnsRemaining: entry.remainingAfter, ...(chosen ?? {}) };
        entry.resolve(result);
      });
    },
  };
  window.goalportCore = {
    snapshot: async () => stub.snapshot,
    command: async () => stub.snapshot,
    startCore: async () => stub.snapshot,
    openInVsCode: async () => undefined,
    appInfo: async () => stub.appInfo,
    coordinateCancel: async () => undefined,
    coordinateDiscover: async () => ({ connected: true, sendAuthorized: true, providers: stub.providers, stopReason: null }),
    coordinateLaunch: (command, generation, scopeGeneration) => {
      const entry = {
        commandId: command.commandId,
        instanceId: command.modelSelection.instanceId,
        role: /coordinate-review-/.test(command.commandId) ? "review" : "planning",
        generation, scopeGeneration,
      };
      window.__rr.log.push(entry);
      if (scopeState) {
        if (scopeState.remaining <= 0) {
          return Promise.resolve({ text: "", errorText: "All authorized model turns were used, so this stopped.", dispatched: false, stopCode: "scope-exhausted", scopeExhausted: true, turnsRemaining: 0 });
        }
        scopeState.remaining -= 1;
      }
      const remainingAfter = scopeState ? scopeState.remaining : null;
      const behavior = window.__rr.behaviors.length > 0 ? window.__rr.behaviors.shift() : null;
      if (behavior === "hold") {
        return new Promise((resolve) => { window.__rr.held.push({ resolve, remainingAfter, entry }); });
      }
      if (behavior && typeof behavior === "object") {
        return Promise.resolve({ turnsRemaining: remainingAfter, ...behavior });
      }
      const fallback = entry.role === "planning" ? PLAN : REVIEW;
      return Promise.resolve({ turnsRemaining: remainingAfter, ...fallback });
    },
    coordinationAuthorize: async ({ instances, maxTurns }) => {
      generationCounter += 1;
      scopeState = { instances: [...instances], maxTurns, remaining: maxTurns, generation: generationCounter };
      return { ok: true, generation: generationCounter, remaining: maxTurns };
    },
    coordinationScope: async () => (scopeState ? { ...scopeState } : null),
    coordinationRevoke: async () => { scopeState = null; return { ok: true }; },
    coordinationUnblock: async (instanceId) => {
      const found = stub.providers.find((item) => item.instanceId === instanceId);
      if (found) delete found.environmentHealth;
      return { ok: true };
    },
    coordinationSave: async (record) => {
      const index = records.findIndex((item) => item.requestId === record.requestId);
      if (index >= 0) records[index] = record; else records.unshift(record);
      return record;
    },
    coordinationRecords: async () => records,
    requestClose: async () => { closePrompt?.(); },
    onClosePrompt: (callback) => { closePrompt = callback; return () => { closePrompt = null; }; },
    confirmCloseChoice: async () => ({ ok: true, receiptId: "shot-receipt", coreAcknowledged: true, allowQuitLatch: true }),
  };
})();
</script>
`;
}

const fixtures = {
  "rr-panel": { providers: [blockedCodex(), healthy("claude"), paidGrok()] },
  "rr-panel-active": {
    providers: [blockedCodex(), healthy("claude"), paidGrok()],
    // A real scope can never contain the paid-api login (authorize refuses
    // it); codex being in a scope that later turned blocked IS reachable —
    // authorized while healthy, blocked by a later turn.
    seedScope: { instances: ["codex", "claude"], maxTurns: 6, remaining: 3, generation: 2 },
  },
  "rr-progress": { providers: [healthy("codex"), healthy("claude"), healthy("grok")] },
  "rr-terminal": { providers: [healthy("codex"), healthy("claude"), healthy("grok")] },
  "rr-two": { providers: [healthy("codex"), healthy("claude")] },
  "rr-exhausted": { providers: [healthy("codex"), healthy("claude"), healthy("grok")] },
  "rr-history": { providers: [healthy("codex"), healthy("claude"), healthy("grok")], fromWindowName: true },
  "rr-walk": { providers: [healthy("codex"), healthy("claude"), healthy("grok")] },
};

const index = readFileSync(resolve(distRoot, "index.html"), "utf8");
for (const [name, config] of Object.entries(fixtures)) {
  writeFileSync(resolve(distRoot, `${name}.html`), index.replace("  </head>", `${bridgeScript(config)}  </head>`));
}

const preview = await startPreview({ dist: distRoot, fixture: "empty" });
const { page, evaluate, until, viewport, click, fill, screenshot } = preview;
const port = new URL(preview.url).port;

async function goto(path, { keepWindowName = false } = {}) {
  if (!keepWindowName) await evaluate("window.name = \"\"");
  await page.cdp("Page.navigate", { url: `http://127.0.0.1:${port}/${path}` });
  await until("Boolean(document.querySelector('.goalport-shell'))");
}

async function setNavCollapsed(collapsed) {
  const isCollapsed = await evaluate("Boolean(document.querySelector('.campaign-nav.nav-collapsed'))");
  if (isCollapsed !== collapsed) {
    await click(collapsed ? 'button[aria-label="Collapse navigation"]' : 'button[aria-label="Expand navigation"]');
    await until(`document.querySelector('.campaign-nav')?.classList.contains('nav-collapsed') === ${collapsed}`);
  }
}

async function openDraft() {
  await click('button[aria-label="New goal"]');
  await until("Boolean(document.querySelector('#draft-message'))");
}

async function waitPanel() {
  await until("Boolean(document.querySelector('.authorization-panel'))");
}

async function setBehaviors(behaviors) {
  await evaluate(`window.__rr.behaviors = ${JSON.stringify(behaviors)}`);
}

async function sendMessage(text) {
  await fill("#draft-message", text);
  await click('.draft-composer-form button[type="submit"]');
}

async function progressActivity() {
  return evaluate("document.querySelector('.coordination-progress-activity')?.textContent ?? null");
}

async function release(behavior) {
  await evaluate(`window.__rr.release(${JSON.stringify(behavior)})`);
}

const GOAL = "Tighten the plan handoff and leave a bounded plan.";
const widths = [[860, "860"], [1020, "1020"], [1440, "1440"]];

// Width sweep helper: content shots at 860 keep the drawer collapsed; wider
// shots open it, the natural desktop layout.
async function sweep(name, capture) {
  for (const [w, label] of widths) {
    await viewport(w, 900);
    await setNavCollapsed(w === 860);
    await capture(label);
  }
}

// ①a + ①b + ⑦ — the panel with all three row states, the fewer-than-two
// rejection, and Use again making the blocked row selectable again.
await goto("rr-panel.html");
await viewport(860, 900);
await openDraft();
await waitPanel();
await setNavCollapsed(true);
await sweep("panel-3rows", async (label) => {
  await screenshot(resolve(outDir, `rr-panel-3rows-${label}.png`));
});
// Fresh panel (no active scope line) — the other half of ①c.
await viewport(860, 900);
await setNavCollapsed(true);
await screenshot(resolve(outDir, "rr-panel-fresh-860.png"));
// ①b — only Claude is selectable, so Send is rejected in one sentence.
await sendMessage(GOAL);
await until("Boolean(document.body.innerText.includes('An independent check needs two agents'))");
await screenshot(resolve(outDir, "rr-panel-fewer-than-two-860.png"));
// ⑦ — Use again clears the health memory; the row becomes a checked checkbox.
// Fresh page: the ①b rejection banner above belongs to that shot's state.
await goto("rr-panel.html");
await viewport(860, 900);
await openDraft();
await waitPanel();
await setNavCollapsed(true);
await click('button[aria-label="Use again Codex"]');
await until("Boolean(document.querySelector('input[aria-label=\"Select Codex\"]'))");
await until("Boolean(document.querySelector('input[aria-label=\"Select Codex\"]').checked)");
await screenshot(resolve(outDir, "rr-use-again-after-860.png"));

// ①c — the active-scope panel: remaining-turns sentence + Change/Stop allowing.
await goto("rr-panel-active.html");
await viewport(860, 900);
await openDraft();
await waitPanel();
await setNavCollapsed(true);
await until("Boolean(document.body.innerText.includes('3 of 6 turns left.'))");
await screenshot(resolve(outDir, "rr-panel-active-scope-860.png"));

// ② — in-flight states via deferred launches: planning…, checking…, and a
// takeover in progress (failure sentence + the replacement planning).
await goto("rr-progress.html");
await viewport(860, 900);
await setBehaviors(["hold"]);
await openDraft();
await waitPanel();
await sendMessage(GOAL);
await until("(document.querySelector('.coordination-progress-activity')?.textContent ?? '').includes('Codex is planning')");
await sweep("progress-planning", async (label) => {
  await screenshot(resolve(outDir, `rr-progress-planning-${label}.png`));
});

await goto("rr-progress.html");
await viewport(860, 900);
await setBehaviors([PLAN_OK, "hold"]);
await openDraft();
await waitPanel();
await sendMessage(GOAL);
await until("(document.querySelector('.coordination-progress-activity')?.textContent ?? '').includes('Claude is checking')");
await sweep("progress-checking", async (label) => {
  await screenshot(resolve(outDir, `rr-progress-checking-${label}.png`));
});

await goto("rr-progress.html");
await viewport(860, 900);
await setBehaviors([ENV_BLOCKED, "hold"]);
await openDraft();
await waitPanel();
await sendMessage(GOAL);
await until("Boolean(document.querySelector('.coordination-progress-failure'))");
await until("(document.querySelector('.coordination-progress-activity')?.textContent ?? '').includes('Claude is planning')");
await sweep("progress-takeover", async (label) => {
  await screenshot(resolve(outDir, `rr-progress-takeover-${label}.png`));
});

// ③ — failure + takeover terminal: red failed card with collapsed details,
// took-over cards, the top summary line, and the budget line.
await goto("rr-terminal.html");
await viewport(860, 900);
await setBehaviors([PLAN_OK, ENV_BLOCKED, REVIEW_OK]);
await openDraft();
await waitPanel();
await sendMessage(GOAL);
await until("Boolean(document.querySelector('.tl-event[data-kind=\"round-failed\"]'))");
await until("Boolean(document.querySelector('.tl-event[data-kind=\"round-continued\"]'))");
await until("Boolean(document.body.innerText.includes('1 of 4 turns left.'))");
await sweep("terminal-takeover", async (label) => {
  await screenshot(resolve(outDir, `rr-terminal-takeover-${label}.png`));
});
// ⑧ — the current round re-selected from Plans keeps the live overlay.
// (Re-select at 1020 with the drawer open: the collapsed rail hides the row
// hit target at 860.)
await viewport(1020, 900);
await setNavCollapsed(false);
await click('button[aria-label^="Plan:"]');
await until("Boolean(document.body.innerText.includes('1 of 4 turns left.'))");
await viewport(860, 900);
await setNavCollapsed(true);
await screenshot(resolve(outDir, "rr-current-round-overlay-860.png"));

// ④ — two-harness terminal stop: the named sentence, the env card with the
// stays-unused line, and Use again.
await goto("rr-two.html");
await viewport(860, 900);
await setBehaviors([ENV_BLOCKED]);
await openDraft();
await waitPanel();
await sendMessage(GOAL);
await until("Boolean(document.body.innerText.includes('Stopped. Codex cannot run on this machine right now'))");
await until("Boolean(document.body.innerText.includes('It stays unused until you choose Use again.'))");
await sweep("terminal-two-harness", async (label) => {
  await screenshot(resolve(outDir, `rr-terminal-two-harness-${label}.png`));
});

// ⑤ — scope-exhausted terminal, then Allow more turns and the changed panel.
await goto("rr-exhausted.html");
await viewport(860, 900);
await openDraft();
await waitPanel();
await fill("#authorization-turns", "2");
await setBehaviors([ENV_BLOCKED, PLAN_OK]);
await sendMessage(GOAL);
await until("Boolean(document.body.innerText.includes('All authorized model turns were used, so this stopped.'))");
await until("Boolean(document.querySelector('button[aria-label=\"Allow more turns\"]'))");
await sweep("terminal-exhausted", async (label) => {
  await screenshot(resolve(outDir, `rr-terminal-exhausted-${label}.png`));
});
await viewport(1020, 900);
await setNavCollapsed(false);
// Re-select the round in Plans first: the send flow leaves the draft mounted
// (its view yields to the saved-plan timeline), and a lingering draft would
// swallow the Change click into the hidden panel. Selecting the plan closes
// the draft, which is also the natural user path.
await click('button[aria-label^="Plan:"]');
await viewport(860, 900);
await setNavCollapsed(true);
// ⑥ — Change (via Allow more turns): the panel in change mode with Save.
await click('button[aria-label="Allow more turns"]');
await until("Boolean(document.querySelector('button[aria-label=\"Save agent access\"]'))");
await screenshot(resolve(outDir, "rr-change-mode-860.png"));
await fill("#authorization-turns", "6");
await click('button[aria-label="Save agent access"]');
await until("Boolean(document.body.innerText.includes('6 of 6 turns left.'))");
await screenshot(resolve(outDir, "rr-exhausted-after-allow-860.png"));
// ⑥ — Stop allowing: the finished round stays, its budget state is gone.
await click('button[aria-label="Discard draft"]');
await until("!document.querySelector('#draft-message')");
await click('button[aria-label="Stop allowing"]');
await until("!document.querySelector('.coordination-access')");
await screenshot(resolve(outDir, "rr-stop-allowing-860.png"));

// ⑨ — reloaded historical terminal: records survive the restart, the
// authorization state does not (no budget line, no authorization controls).
await goto("rr-terminal.html");
await viewport(860, 900);
await setBehaviors([PLAN_OK, ENV_BLOCKED, REVIEW_OK]);
await openDraft();
await waitPanel();
await sendMessage(GOAL);
await until("Boolean(document.querySelector('.tl-event[data-kind=\"round-continued\"]'))");
await evaluate("window.name = JSON.stringify({ __rrRecords: window.__rr.records })");
await goto("rr-history.html", { keepWindowName: true });
await until("Boolean(document.querySelector('.coordination-status'))");
await until("Boolean(document.querySelector('.tl-event[data-kind=\"round-failed\"]'))");
await setNavCollapsed(true);
await screenshot(resolve(outDir, "rr-history-terminal-860.png"));

// Walkthrough — every step a first-time user sees, in order, at 860.
await goto("rr-walk.html");
await viewport(860, 900);
await setBehaviors(["hold", "hold", "hold"]);
await openDraft();
await waitPanel();
await setNavCollapsed(true);
await screenshot(resolve(outDir, "walkthrough-1-draft-open.png"));
await fill("#authorization-turns", "6");
await screenshot(resolve(outDir, "walkthrough-2-read-panel.png"));
await sendMessage(GOAL);
await until("(document.querySelector('.coordination-progress-activity')?.textContent ?? '').includes('Codex is planning')");
await screenshot(resolve(outDir, "walkthrough-3-sent-planning.png"));
await release([ENV_BLOCKED]);
await until("Boolean(document.querySelector('.coordination-progress-failure'))");
await until("(document.querySelector('.coordination-progress-activity')?.textContent ?? '').includes('Claude is planning')");
await screenshot(resolve(outDir, "walkthrough-4-takeover-visible.png"));
await release([PLAN_OK]);
await until("(document.querySelector('.coordination-progress-activity')?.textContent ?? '').includes('Grok is checking')");
await release([REVIEW_OK]);
await until("Boolean(document.querySelector('.tl-event[data-kind=\"round-continued\"]'))");
await until("Boolean(document.body.innerText.includes('3 of 6 turns left.'))");
await screenshot(resolve(outDir, "walkthrough-5-terminal.png"));
// Re-select the round in Plans so the mounted send draft closes (see ⑥).
await viewport(1020, 900);
await setNavCollapsed(false);
await click('button[aria-label^="Plan:"]');
await viewport(860, 900);
await setNavCollapsed(true);
await click('.coordination-access button[aria-label="Change"]');
await until("Boolean(document.querySelector('button[aria-label=\"Save agent access\"]'))");
await screenshot(resolve(outDir, "walkthrough-6-change-panel.png"));
await click('button[aria-label="Discard draft"]');
await until("!document.querySelector('#draft-message')");
await click('.coordination-access button[aria-label="Stop allowing"]');
await until("!document.querySelector('.coordination-access')");
await screenshot(resolve(outDir, "walkthrough-7-stopped-allowing.png"));
await click('button[aria-label="Application menu"]');
await click('button[aria-label="Close window"]');
await until("Boolean(document.querySelector('.close-choice-dialog'))");
await screenshot(resolve(outDir, "walkthrough-8-close-choice.png"));

const launchLog = await evaluate("JSON.stringify(window.__rr.log)");
console.log("walkthrough launch log:", launchLog);

await preview.stop();
console.log(`wrote screenshots to ${outDir}`);
