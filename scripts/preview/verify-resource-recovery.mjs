// DOM-geometry acceptance for the resource-recovery slice. The visual gate is
// expressed as binary geometry/interaction checks driven through the same
// preview harness that took the screenshots: no horizontal overflow at three
// widths, the 860 drawer closable and not covering content, hit-test
// clickable controls, event-card column fit, takeover-terminal planner !=
// reviewer, the current-round budget overlay vs the history record without
// it, and aria-labels on the new controls. The PNG artifacts remain for owner
// eyeball verification on the real machine.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { startPreview } from "../preview/harness.mjs";

const outDir = resolve(process.argv[2] ?? "goal-runs/goalport-resource-recovery/evidence/shots");
const distRoot = resolve("dist");

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
  errorText: "This harness cannot run its tools on this machine, so this stopped.",
  dispatched: true,
  environmentBlocked: true,
  environmentDetail: ENV_DETAIL,
};

function provider(id, overrides = {}) {
  return {
    instanceId: id,
    displayName: id === "codex" ? "Codex" : id === "claude" ? "Claude" : "Grok",
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

// Same stub shape as shot-resource-recovery.mjs: the full scope bridge with
// per-launch scripted behaviors ("hold" = never resolves, keeping the round
// in flight) and session-bound scope state.
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
  const PLAN = ${JSON.stringify(PLAN_OK).replace(/</g, "\\u003c")};
  const REVIEW = ${JSON.stringify(REVIEW_OK).replace(/</g, "\\u003c")};
  window.__rr = { log: [], behaviors: [], held: [], records,
    release: (behavior) => {
      const held = window.__rr.held.splice(0);
      const list = Array.isArray(behavior) ? behavior : [behavior];
      held.forEach((entry, index) => {
        const chosen = list[Math.min(index, list.length - 1)];
        entry.resolve({ turnsRemaining: entry.remainingAfter, ...(chosen ?? {}) });
      });
    } };
  window.goalportCore = {
    snapshot: async () => stub.snapshot,
    command: async () => stub.snapshot,
    startCore: async () => stub.snapshot,
    openInVsCode: async () => undefined,
    appInfo: async () => stub.appInfo,
    coordinateCancel: async () => undefined,
    coordinateDiscover: async () => ({ connected: true, sendAuthorized: true, providers: stub.providers, stopReason: null }),
    coordinateLaunch: (command, generation, scopeGeneration) => {
      const entry = { commandId: command.commandId, instanceId: command.modelSelection.instanceId,
        role: /coordinate-review-/.test(command.commandId) ? "review" : "planning", generation, scopeGeneration };
      window.__rr.log.push(entry);
      if (scopeState) {
        if (scopeState.remaining <= 0) {
          return Promise.resolve({ text: "", errorText: "All authorized model turns were used, so this stopped.", dispatched: false, stopCode: "scope-exhausted", scopeExhausted: true, turnsRemaining: 0 });
        }
        scopeState.remaining -= 1;
      }
      const remainingAfter = scopeState ? scopeState.remaining : null;
      const behavior = window.__rr.behaviors.length > 0 ? window.__rr.behaviors.shift() : null;
      if (behavior === "hold") return new Promise((resolve) => { window.__rr.held.push({ resolve, remainingAfter, entry }); });
      if (behavior && typeof behavior === "object") return Promise.resolve({ turnsRemaining: remainingAfter, ...behavior });
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
  };
})();
</script>
`;
}

const fixtures = {
  "verify-rr-panel": { providers: [blockedCodex(), healthy("claude"), paidGrok()] },
  "verify-rr-terminal": { providers: [healthy("codex"), healthy("claude"), healthy("grok")] },
  "verify-rr-exhausted": { providers: [healthy("codex"), healthy("claude"), healthy("grok")] },
  "verify-rr-history": { providers: [healthy("codex"), healthy("claude"), healthy("grok")], fromWindowName: true },
};

const index = readFileSync(resolve(distRoot, "index.html"), "utf8");
for (const [name, config] of Object.entries(fixtures)) {
  writeFileSync(resolve(distRoot, `${name}.html`), index.replace("  </head>", `${bridgeScript(config)}  </head>`));
}

const preview = await startPreview({ dist: distRoot, fixture: "empty" });
const { page, evaluate, until, viewport, click, fill } = preview;
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
  await until("Boolean(document.querySelector('.authorization-panel'))");
}

async function setBehaviors(behaviors) {
  await evaluate(`window.__rr.behaviors = ${JSON.stringify(behaviors)}`);
}

async function sendMessage(text) {
  await fill("#draft-message", text);
  await click('.draft-composer-form button[type="submit"]');
}

const failures = [];
function check(name, ok, detail = "") {
  if (!ok) failures.push(`${name}${detail ? `: ${detail}` : ""}`);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
}

// Geometry probe: an element is visible when it has area, sits inside the
// viewport, and the point at its center is not covered by another element.
const visibleProbe = `(selector) => (() => {
  const e = document.querySelector(selector);
  if (!e) return { missing: true };
  const r = e.getBoundingClientRect();
  const x = r.x + r.width / 2, y = r.y + r.height / 2;
  const top = document.elementFromPoint(x, y);
  return { missing: false, w: r.width, h: r.height,
    inside: r.x >= 0 && r.right <= innerWidth && r.y >= 0 && r.bottom <= innerHeight,
    centered: top === e || e.contains(top) };
})()`;

const coveredProbe = `(selector) => (() => {
  const e = document.querySelector(selector);
  if (!e) return { missing: true };
  const r = e.getBoundingClientRect();
  const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
  return { missing: false, covered: Boolean(top && !e.contains(top)), by: top ? top.className?.toString().slice(0, 40) : "" };
})()`;

const GOAL = "Tighten the plan handoff and leave a bounded plan.";
const widths = [[1440, "1440"], [1020, "1020"], [860, "860"]];

// A — takeover terminal geometry at every width, then the 860 drawer checks.
await goto("verify-rr-terminal.html");
await viewport(860, 900);
await setBehaviors([PLAN_OK, ENV_BLOCKED, REVIEW_OK]);
await openDraft();
// Send hit-test happens on the live draft (before the round starts).
const sendButton = await evaluate(`(${visibleProbe})('.draft-composer-form button[type="submit"]')`);
check("send button hit-test clickable on draft", !sendButton.missing && sendButton.centered, JSON.stringify(sendButton));
await sendMessage(GOAL);
await until("Boolean(document.querySelector('.tl-event[data-kind=\"round-failed\"]'))");
await until("Boolean(document.querySelector('.tl-event[data-kind=\"round-continued\"]'))");
await until("Boolean(document.body.innerText.includes('1 of 4 authorized model turns left.'))");

for (const [w, label] of widths) {
  await viewport(w, 900);
  await setNavCollapsed(w === 860);
  const overflow = await evaluate("document.documentElement.scrollWidth - innerWidth");
  check(`no horizontal overflow @${label}`, overflow <= 1, `scrollWidth delta ${overflow}px`);
}
await viewport(860, 900);
await setNavCollapsed(true);
const failedCard = await evaluate(`(${visibleProbe})('.tl-event[data-kind="round-failed"]')`);
check("failed event card visible, drawer collapsed @860", !failedCard.missing && failedCard.inside && failedCard.centered, JSON.stringify(failedCard));
const tookCard = await evaluate(`(${visibleProbe})('.tl-event[data-kind="round-continued"]')`);
check("took-over card visible, drawer collapsed @860", !tookCard.missing && tookCard.inside && tookCard.centered, JSON.stringify(tookCard));
const cardFit = await evaluate(`(() => {
  const card = document.querySelector('.tl-event[data-kind="round-failed"]');
  const column = document.querySelector('.conversation-column');
  const cr = card.getBoundingClientRect(), kr = column.getBoundingClientRect();
  return { cardRight: cr.right, columnRight: kr.right, ok: cr.right <= kr.right + 1 };
})()`);
check("event cards fit the conversation column @860", cardFit.ok, JSON.stringify(cardFit));
// The 860 drawer occlusion item: open drawer covers the card, closing it
// (always possible) uncovers it.
await setNavCollapsed(false);
const coveredOpen = await evaluate(`(${coveredProbe})('.tl-event[data-kind="round-failed"]')`);
check("860 open drawer covers terminal card (overlay state)", !coveredOpen.missing && coveredOpen.covered, JSON.stringify(coveredOpen));
await setNavCollapsed(true);
const coveredClosed = await evaluate(`(${coveredProbe})('.tl-event[data-kind="round-failed"]')`);
const collapseControl = await evaluate("Boolean(document.querySelector('button[aria-label=\"Collapse navigation\"]') || document.querySelector('button[aria-label=\"Expand navigation\"]'))");
check("860 drawer closable, terminal card uncovered in content state", collapseControl && !coveredClosed.missing && !coveredClosed.covered, JSON.stringify(coveredClosed));

const planner = await evaluate("Array.from(document.querySelectorAll('.coordination-status dt')).find((d) => d.textContent === 'Planning harness')?.nextElementSibling?.textContent");
const reviewer = await evaluate("Array.from(document.querySelectorAll('.coordination-status dt')).find((d) => d.textContent === 'Review harness')?.nextElementSibling?.textContent");
check("takeover terminal planner != reviewer", planner === "Codex" && reviewer === "Grok" && planner !== reviewer, `planner=${planner} reviewer=${reviewer}`);
check("current round shows budget line", Boolean(await evaluate("document.querySelector('.coordination-budget')?.textContent.includes('1 of 4')")));
const useAgainTerminal = await evaluate(`(${visibleProbe})('.tl-event[data-kind="environment-blocked"] button[aria-label="Use again Claude"]')`);
check("Use again hit-test clickable on terminal env card", !useAgainTerminal.missing && useAgainTerminal.centered, JSON.stringify(useAgainTerminal));
const stopAllowing = await evaluate(`(${visibleProbe})('.coordination-access button[aria-label="Stop allowing"]')`);
check("Stop allowing hit-test clickable on terminal", !stopAllowing.missing && stopAllowing.centered, JSON.stringify(stopAllowing));
const changeButton = await evaluate(`(${visibleProbe})('.coordination-access button[aria-label="Change"]')`);
check("Change hit-test clickable on terminal", !changeButton.missing && changeButton.centered, JSON.stringify(changeButton));

// B — panel rows, aria-labels, fewer-than-two rejection, 860 occlusion.
await goto("verify-rr-panel.html");
await viewport(860, 900);
await openDraft();
await setNavCollapsed(true);
const rowStates = await evaluate(`(() => ({
  blocked: document.body.innerText.includes('Blocked on this machine since'),
  useAgain: Boolean(document.querySelector('button[aria-label="Use again Codex"]')),
  details: Boolean(document.querySelector('.authorization-row-blocked details.technical-details')),
  paid: document.body.innerText.includes('bills through its own API key'),
}))()`);
check("panel shows usable/blocked/paid-api row states", rowStates.blocked && rowStates.useAgain && rowStates.details && rowStates.paid, JSON.stringify(rowStates));
const aria = await evaluate(`(() => ({
  select: Boolean(document.querySelector('input[aria-label="Select Claude"]')),
  turns: Boolean(document.querySelector('input[aria-label="Model turns to allow"]')),
  useAgain: Boolean(document.querySelector('button[aria-label="Use again Codex"]')),
}))()`);
check("aria-labels present on new panel controls", aria.select && aria.turns && aria.useAgain, JSON.stringify(aria));
await setNavCollapsed(false);
const panelCoveredOpen = await evaluate(`(${coveredProbe})('.authorization-panel')`);
check("860 open drawer covers panel (overlay state)", !panelCoveredOpen.missing && panelCoveredOpen.covered, JSON.stringify(panelCoveredOpen));
await setNavCollapsed(true);
const panelCoveredClosed = await evaluate(`(${coveredProbe})('.authorization-panel')`);
check("860 drawer closable, panel uncovered in content state", !panelCoveredClosed.missing && !panelCoveredClosed.covered, JSON.stringify(panelCoveredClosed));
await sendMessage(GOAL);
const rejection = await evaluate("Boolean(document.body.innerText.includes('An independent check needs two harnesses that can run, so select at least two.'))");
check("fewer-than-two selection rejected with sentence", rejection);
// Use again clears the row back to a selectable checkbox (interaction result).
await click('button[aria-label="Use again Codex"]');
await until("Boolean(document.querySelector('input[aria-label=\"Select Codex\"]'))");
check("Use again makes blocked row selectable again", true);

// C — scope exhaustion, Allow more turns, Save harness access, Stop allowing.
await goto("verify-rr-exhausted.html");
await viewport(860, 900);
await openDraft();
await fill("#authorization-turns", "2");
await setBehaviors([ENV_BLOCKED, PLAN_OK]);
await sendMessage(GOAL);
await until("Boolean(document.body.innerText.includes('All authorized model turns were used, so this stopped.'))");
const exhaustedSentence = await evaluate("Boolean(Array.from(document.querySelectorAll('.coordination-status dd')).some((d) => d.textContent === 'All authorized model turns were used, so this stopped.'))");
check("scope-exhausted terminal shows the fixed stop sentence", exhaustedSentence);
const allowMore = await evaluate(`(${visibleProbe})('button[aria-label="Allow more turns"]')`);
check("Allow more turns hit-test clickable", !allowMore.missing && allowMore.centered, JSON.stringify(allowMore));
const noBudgetWhenExhausted = await evaluate("!document.querySelector('.coordination-budget')?.textContent.includes('model turns left')");
check("exhausted terminal shows no plain budget line", noBudgetWhenExhausted);
// Change/Allow-more land on the panel; re-select the round first so the
// mounted send draft closes (the natural user path, same as the shot driver).
await viewport(1020, 900);
await setNavCollapsed(false);
await click('button[aria-label^="Plan:"]');
await viewport(860, 900);
await setNavCollapsed(true);
await click('button[aria-label="Allow more turns"]');
await until("Boolean(document.querySelector('button[aria-label=\"Save harness access\"]'))");
const saveAccess = await evaluate(`(${visibleProbe})('button[aria-label="Save harness access"]')`);
check("Save harness access hit-test clickable in change mode", !saveAccess.missing && saveAccess.centered, JSON.stringify(saveAccess));
await fill("#authorization-turns", "6");
await click('button[aria-label="Save harness access"]');
await until("Boolean(document.body.innerText.includes('6 of 6 authorized model turns left.'))");
check("after Allow more: panel shows the re-authorized budget", true);
await click('button[aria-label="Discard draft"]');
await until("!document.querySelector('#draft-message')");
await click('button[aria-label="Stop allowing"]');
await until("!document.querySelector('.coordination-access')");
const stoppedClean = await evaluate("(!document.querySelector('.coordination-access') && !Array.from(document.querySelectorAll('.coordination-budget')).length)");
check("after Stop allowing: budget and authorization controls gone", stoppedClean);

// D — reloaded historical terminal: records survive, authorization does not.
await goto("verify-rr-terminal.html");
await viewport(860, 900);
await setBehaviors([PLAN_OK, ENV_BLOCKED, REVIEW_OK]);
await openDraft();
await sendMessage(GOAL);
await until("Boolean(document.querySelector('.tl-event[data-kind=\"round-continued\"]'))");
await evaluate("window.name = JSON.stringify({ __rrRecords: window.__rr.records })");
await goto("verify-rr-history.html", { keepWindowName: true });
await until("Boolean(document.querySelector('.tl-event[data-kind=\"round-failed\"]'))");
const history = await evaluate(`(() => ({
  budgetLine: Boolean(document.querySelector('.coordination-budget')),
  budgetText: document.body.innerText.includes('authorized model turns left'),
  allowMore: Boolean(document.querySelector('button[aria-label="Allow more turns"]')),
  change: Boolean(document.querySelector('.coordination-access button[aria-label="Change"]')),
  stop: Boolean(document.querySelector('.coordination-access button[aria-label="Stop allowing"]')),
  envCard: Boolean(document.querySelector('.tl-event[data-kind="environment-blocked"]')),
  failedCard: Boolean(document.querySelector('.tl-event[data-kind="round-failed"]')),
  tookCard: Boolean(document.querySelector('.tl-event[data-kind="round-continued"]')),
}))()`);
check("historical record shows NO budget line", !history.budgetLine && !history.budgetText, JSON.stringify(history));
check("historical record shows NO authorization controls", !history.allowMore && !history.change && !history.stop, JSON.stringify(history));
check("historical record keeps its persisted round facts", history.envCard && history.failedCard && history.tookCard, JSON.stringify(history));

await preview.stop();
if (failures.length > 0) {
  console.error(`\n${failures.length} FAILURES:\n${failures.join("\n")}`);
  process.exit(1);
}
console.log(`\nall geometry/interaction checks passed (artifacts dir: ${outDir})`);
