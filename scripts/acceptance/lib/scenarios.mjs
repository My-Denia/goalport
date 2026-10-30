import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SYNTHETIC, sleep } from './launch.mjs';

const A2_BEHAVIOR = Object.freeze({ probes: { codex: 'codex-probe-authenticated', claude: 'claude-probe-authenticated' }, turns: { codex: ['codex-environment-blocked'], claude: [] } });
export const SCENARIOS = Object.freeze({
  a1: Object.freeze({ id: 'a1', budget: 4, widths: Object.freeze([860, 1020, 1440]), goal: 'Produce a bounded offline acceptance plan and independently check it. Do not change files.',
    behavior: Object.freeze({ probes: { codex: 'codex-probe-authenticated', claude: 'claude-probe-authenticated' }, turns: { codex: ['codex-tool-success'], claude: ['claude-carry-out-delayed'] } }) }),
  // a2/a5 share the env-blocked corpus; a5 owns a fresh state dir and its own
  // relaunch (plan r2 finding 9: a2's Use again clears its health entry, so a5
  // must never reuse a2's state). The empty claude queues are tripwires: any
  // replacement launch would log turn-queue-exhausted and fail the run.
  a2: Object.freeze({ id: 'a2', budget: 4, widths: Object.freeze([860, 1020, 1440]), timeoutMs: 150000, phases: 1, goal: 'Produce a bounded offline acceptance plan and independently check it. Do not change files.',
    behavior: A2_BEHAVIOR, requiredShots: Object.freeze([Object.freeze(['terminal', 860]), Object.freeze(['terminal', 1020]), Object.freeze(['terminal', 1440]), Object.freeze(['use-again', 1020])]) }),
  a3: Object.freeze({ id: 'a3', budget: 4, widths: Object.freeze([1020]), timeoutMs: 90000, phases: 1, goal: 'Produce a bounded offline acceptance plan and independently check it. Do not change files.',
    behavior: Object.freeze({ probes: { codex: 'codex-probe-authenticated', claude: 'claude-probe-unavailable' }, turns: { codex: [], claude: [] } }),
    requiredShots: Object.freeze([Object.freeze(['refusal', 1020])]) }),
  a4: Object.freeze({ id: 'a4', budget: 4, widths: Object.freeze([860, 1020, 1440]), timeoutMs: 150000, phases: 1, goal: 'Produce a bounded offline acceptance plan and independently check it. Do not change files.',
    behavior: Object.freeze({ probes: { codex: 'codex-probe-authenticated', claude: 'claude-probe-authenticated' }, turns: { codex: ['codex-tool-success'], claude: ['claude-no-text'] } }),
    requiredShots: Object.freeze([Object.freeze(['terminal', 860]), Object.freeze(['terminal', 1020]), Object.freeze(['terminal', 1440])]) }),
  a5: Object.freeze({ id: 'a5', budget: 4, widths: Object.freeze([1020]), timeoutMs: 300000, phases: 2, goal: 'Produce a bounded offline acceptance plan and independently check it. Do not change files.',
    behavior: A2_BEHAVIOR, requiredShots: Object.freeze([Object.freeze(['blocked-panel', 1020])]) }),
});
export function validateScenario(config) {
  const pinned = config && SCENARIOS[config.id];
  if (!pinned || JSON.stringify(config) !== JSON.stringify(pinned)) throw new Error(`scenario config does not match the pinned definition (${config?.id ?? 'unknown'})`);
  return config;
}
const readJson = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
const fileEvidence = filename => ({ path: filename, bytes: fs.statSync(filename).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex') });

// ---- R2 (independent execution audit r1): the Harness access panel renders
// the workspace-changes decision as a SECOND list. Two discovered harnesses now
// produce four checkboxes (two read members plus two default-OFF write members)
// and one harness produces two rows. Track A may only count and select READ
// members: read controls are the ones labelled `Select <name>` and read rows
// are the rows that carry data-instance (the write list's rows carry none).
// Write controls are observed only to prove the write dimension stays OFF —
// never clicked to satisfy an old all-checked predicate.
export const AUTHORIZATION = Object.freeze({
  panel: '.authorization-panel',
  readControl: '.authorization-panel input[aria-label^="Select "]',
  writeControl: '.authorization-panel input[aria-label^="Allow changes through "]',
  readRow: '.authorization-row[data-instance]',
  writeSection: '.authorization-write-section',
  noWriteSentence: 'No file changes are allowed unless you check a harness here and press Send.',
});
export const readSelectLabel = name => `Select ${name}`;

// One renderer read that keeps read members, write members and the budget
// input apart. `closest('.authorization-row')` ties every read control to the
// row that owns it, so a read member can never be counted from the write list.
export function authorizationFactsExpression() {
  return `(() => {
    const panel = document.querySelector(${JSON.stringify(AUTHORIZATION.panel)});
    const read = Array.from(document.querySelectorAll(${JSON.stringify(AUTHORIZATION.readControl)}));
    const write = Array.from(document.querySelectorAll(${JSON.stringify(AUTHORIZATION.writeControl)}));
    const rows = Array.from(document.querySelectorAll(${JSON.stringify(AUTHORIZATION.readRow)}));
    return {
      readSelects: read.map(e => ({ label: e.getAttribute('aria-label'), instance: e.closest('.authorization-row')?.dataset.instance ?? null, checked: e.checked === true })),
      writeSelects: write.map(e => ({ label: e.getAttribute('aria-label'), checked: e.checked === true })),
      readRows: rows.map(e => ({ instance: e.dataset.instance, state: e.className })),
      readTurnsValue: panel?.querySelector('#authorization-turns')?.value ?? null,
      writeSectionPresent: !!panel?.querySelector(${JSON.stringify(AUTHORIZATION.writeSection)}),
      noWriteSentenceShown: (panel?.querySelector(${JSON.stringify(AUTHORIZATION.writeSection)})?.textContent ?? '').includes(${JSON.stringify(AUTHORIZATION.noWriteSentence)}),
    };
  })()`;
}

// The write dimension is off when every discovered read row has its own
// unchecked write control. Blocked harnesses are static read rows without a
// Select checkbox, so selectable checkboxes are not the membership boundary.
export function writeConsentOff(facts) {
  const rows = Array.isArray(facts?.readRows) ? facts.readRows : [];
  const write = Array.isArray(facts?.writeSelects) ? facts.writeSelects : [];
  return rows.length > 0 && write.length === rows.length && facts?.writeSectionPresent === true && facts?.noWriteSentenceShown === true
    && write.every(member => member.checked === false && typeof member.label === 'string' && member.label.startsWith('Allow changes through '));
}

// Read-member truth for one draft panel. `names` are the displayed harness
// names; `budget` is the allowed read turns. Write consent must stay OFF in
// every Track A case, so it is asserted, never clicked into place.
export function readAuthorizationAssertions(facts, { names, budget }) {
  const read = Array.isArray(facts?.readSelects) ? facts.readSelects : [];
  const rows = Array.isArray(facts?.readRows) ? facts.readRows : [];
  const labels = names.map(readSelectLabel);
  return {
    readControlMembers: read.length === names.length && labels.every(label => read.some(member => member.label === label)),
    readMemberRows: rows.length === names.length && names.every(name => rows.some(row => row.instance === name.toLowerCase())),
    readMembersChecked: read.length === names.length && read.every(member => member.checked === true),
    writeConsentStaysOff: writeConsentOff(facts),
    readTurnsBudget: facts?.readTurnsValue === String(budget),
  };
}

export function collectArtifacts(caseRoot) {
  const state = path.join(caseRoot, 'harness-state');
  const ledgerFile = path.join(state, 'sent-turns.json');
  const recordsFile = path.join(caseRoot, 'electron-userData/coordination-records.json');
  const invocationFile = path.join(caseRoot, 'stub-bin/invocations.jsonl');
  const healthFile = path.join(state, 'harness-health.json');
  const grantFile = path.join(state, 'send-authorization');
  const claims = fs.readdirSync(state).filter(n => n.startsWith('claim-'));
  // a3 refuses before any send, so its ledger/records files never exist;
  // missing files read as empty, existing ones read exactly as before.
  return {
    ledger: fs.existsSync(ledgerFile) ? readJson(ledgerFile) : {},
    records: fs.existsSync(recordsFile) ? readJson(recordsFile) : [],
    invocations: fs.readFileSync(invocationFile, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)),
    health: fs.existsSync(healthFile) ? readJson(healthFile) : null,
    unconsumedGrants: fs.existsSync(grantFile) ? fs.readFileSync(grantFile, 'utf8').trim().split(/\r?\n/).filter(Boolean) : [], claims,
    files: [ledgerFile, recordsFile, invocationFile, ...claims.map(n => path.join(state, n)), ...(fs.existsSync(healthFile) ? [healthFile] : [])].filter(f => fs.existsSync(f)).map(fileEvidence),
  };
}
export function artifactAssertions(artifacts) {
  const ledger = Object.entries(artifacts.ledger);
  const turns = artifacts.invocations.filter(e => e.invocationType === 'turn');
  const probes = artifacts.invocations.filter(e => e.invocationType === 'probe');
  const records = Array.isArray(artifacts.records) ? artifacts.records : [];
  const record = records[0];
  return {
    exactlyTwoSuccessfulLedgerTurns: ledger.length === 2 && ledger.every(([, r]) => r.ok === true && r.messageDispatched === true),
    planAndReviewCommands: ledger.some(([id]) => id.startsWith('coordinate-plan-')) && ledger.some(([id]) => id.startsWith('coordinate-review-')),
    ledgerTurnBijection: turns.length === 2 && turns.filter(t => t.identity === 'codex' && t.behaviorId === 'codex-tool-success').length === 1 && turns.filter(t => t.identity === 'claude' && t.behaviorId === 'claude-carry-out-delayed').length === 1 && ledger.every(([,r]) => turns.filter(t => r.text === (t.identity === 'codex' ? 'Bounded plan.' : 'The plan can be carried out.\nVERDICT: carry-out')).length === 1),
    probesSeparateAndAtLeastSix: probes.length >= 6 && ['codex', 'claude'].every(id => probes.filter(p => p.identity === id).length >= 3),
    sentinelAndQueueAccepted: artifacts.invocations.every(i => !['sentinel-refused','turn-queue-exhausted'].includes(i.behaviorId)),
    twoClaimsAndConsumedGrants: artifacts.claims.length === 2 && ledger.every(([id]) => artifacts.claims.includes(`claim-${id}`)) && artifacts.unconsumedGrants.length === 0,
    noBlockedHealth: artifacts.health === null || Object.keys(artifacts.health).length === 0,
    // R2: with write consent left OFF the round may only issue read roles and
    // the saved record may carry no execution/audit facts (no write launch).
    readRolesOnly: ledger.length === 2 && ledger.every(([id]) => id.startsWith('coordinate-plan-') || id.startsWith('coordinate-review-')),
    noWriteFactsInRecord: records.length === 1 && !record?.executionText && !record?.auditText && !record?.executionHarness && !record?.auditHarness,
    actualCheckedRecord: records.length === 1 && record?.verdict === 'checked' && record?.planText === 'Bounded plan.' && record?.reviewText?.endsWith('VERDICT: carry-out'),
    independentHarnesses: !!record?.planningHarness && !!record?.reviewHarness && record.planningHarness !== record.reviewHarness,
  };
}

export async function runA1(app, caseRoot, result) {
  validateScenario(SCENARIOS.a1);
  result.screenshots = []; result.walkthrough = [];
  const check = (id, value) => { result.assertions[id] = !!value; if (!value) throw new Error(`a1 assertion failed: ${id}`); };
  await app.until("window.goalportCore && window.goalportCore.bootstrapCurrent().then(s => s.phase === 'done')", 30000);
  check('isolatedMarker', await app.evaluate('window.__GOALPORT_ISOLATED === 1'));
  result.appInfo = await app.evaluate('window.goalportCore.appInfo()', true);
  check('dataPathRunOwned', result.appInfo.dataPath.startsWith(caseRoot + path.sep));
  const snapshot = await app.evaluate('window.goalportCore.snapshot()', true);
  result.coreSnapshot = { connection: snapshot.connection, protocolVersion: snapshot.protocolVersion, buildId: snapshot.buildId };
  check('coreConnected', snapshot.connection === 'connected' && snapshot.protocolVersion === 'goalport.ipc.v2');
  await app.click('button[aria-label="New goal"]');
  // R2: wait for the two READ controls only. This same panel also renders the
  // separate workspace-changes list (two default-OFF write boxes here), so an
  // all-checkbox wait would never settle.
  await app.until(`document.querySelectorAll(${JSON.stringify(AUTHORIZATION.readControl)}).length === 2`);
  result.authorization = await app.evaluate(authorizationFactsExpression(), true);
  result.discoveryRows = result.authorization.readRows;
  check('twoSelectableHarnesses', result.discoveryRows.length === 2 && result.discoveryRows.every(r => r.state.includes('selectable')));
  await app.input('#draft-workspace', SYNTHETIC);
  await app.input('#draft-message', SCENARIOS.a1.goal);
  for (const name of ['Codex', 'Claude']) {
    const selector = `input[aria-label="${readSelectLabel(name)}"]`;
    if (!await app.evaluate(`document.querySelector(${JSON.stringify(selector)}).checked`)) await app.click(selector);
  }
  await app.input('#authorization-turns', '4');
  result.authorization = await app.evaluate(authorizationFactsExpression(), true);
  result.discoveryRows = result.authorization.readRows;
  for (const [id, value] of Object.entries(readAuthorizationAssertions(result.authorization, { names: ['Codex', 'Claude'], budget: 4 }))) check(id, value);
  for (const width of SCENARIOS.a1.widths) result.screenshots.push(await app.screenshot(caseRoot, 'authorization', width));
  result.walkthrough.push('New goal: two read-member rows show the real discovered subscription-backed stub harnesses; their boxes plus budget four explicitly permit plan/check turns. The separate workspace-changes list stays unchecked, so no file change is allowed. Nothing has been sent.');
  await app.resize(1020);
  await app.click('button[aria-label="Send message"]');
  await app.until("document.body.innerText.includes('Claude is checking')", 15000);
  result.screenshots.push(await app.screenshot(caseRoot, 'progress', 1020));
  result.progressScope = await app.evaluate('window.goalportCore.coordinationScope()', true);
  check('progressScopeHasNoWriteDimension', !!result.progressScope && result.progressScope.write === undefined);
  result.walkthrough.push('Send: Codex produced the plan; Claude is visibly checking it while the bounded offline delay holds its reply. The live scope carries read turns only — no write dimension was authorized.');
  await app.until("document.body.innerText.includes('Can be carried out')", 20000);
  await app.until("document.body.innerText.includes('2 of 4 authorized model turns left')");
  result.scopeBeforeRevoke = await app.evaluate('window.goalportCore.coordinationScope()', true);
  check('scopeBudgetTwoOfFour', result.scopeBeforeRevoke?.remaining === 2 && result.scopeBeforeRevoke?.maxTurns === 4);
  check('authorizedScopeHasNoWriteDimension', !!result.scopeBeforeRevoke && result.scopeBeforeRevoke.write === undefined);
  for (const width of SCENARIOS.a1.widths) result.screenshots.push(await app.screenshot(caseRoot, 'terminal', width));
  check('allShotsNontrivial', result.screenshots.length === 7 && result.screenshots.every(s => s.bytes > 10000 && s.pngWidth === Math.round(s.requested.width * (s.viewport?.devicePixelRatio || 1))));
  check('shotMarkers', result.screenshots.every(s => s.geometry.text.includes(s.state === 'authorization' ? 'Nothing is sent until you press Send' : s.state === 'progress' ? 'Claude is checking' : 'Can be carried out')));
  check('drawerClosedAt860', result.screenshots.filter(s => s.requested.width === 860).every(s => !s.geometry.drawerOpen));
  check('nativeLayoutAndControlsFit', result.screenshots.every(s => !s.geometry.horizontalOverflow && s.layout.grid <= s.viewport.width + 1 && s.geometry.newGoal?.inside && s.geometry.newGoal?.hit && (s.state !== 'authorization' || (s.geometry.send?.inside && s.geometry.send?.hit)) && (s.state !== 'terminal' || (s.geometry.stop?.inside && s.geometry.stop?.hit))));
  await app.click('button[aria-label="Stop allowing"]');
  await app.until('!document.querySelector(".coordination-access") && !document.querySelector(".coordination-budget")');
  result.scopeAfterRevoke = await app.evaluate('window.goalportCore.coordinationScope()', true);
  check('stopActuallyRevoked', result.scopeAfterRevoke === null);
  result.screenshots.push(await app.screenshot(caseRoot, 'revoked', 1020));
  result.walkthrough.push('Terminal: Can be carried out, distinct planner/reviewer and two of four turns left. Stop allowing removes the live authorization controls and the read-only official scope API returns null.');
  await sleep(300);
  result.artifacts = collectArtifacts(caseRoot);
  for (const [id, value] of Object.entries(artifactAssertions(result.artifacts))) check(id, value);
  result.grantProof = 'Two real claim files and successful ledger entries, matching sentinel-accepted subprocess invocations, plus no remaining send-authorization lines. Production runCliTurn requires and consumes a grant before spawning; contents of ephemeral grant lines are inferred from this guarded path, not fabricated or claimed as directly sampled.';
  // Historical navigation is the actual existing sidebar item, not a save call.
  if (await app.evaluate('!!document.querySelector(\'button[aria-label="Expand navigation"]\')')) await app.click('button[aria-label="Expand navigation"]');
  await app.until('!!document.querySelector(\'button[aria-label^="Plan: "]\')');
  await app.click('button[aria-label^="Plan: "]');
  await app.until("document.body.innerText.includes('Can be carried out')");
  result.history = await app.evaluate(`({checkedText:document.body.innerText.includes('Can be carried out'), budget:!!document.querySelector('.coordination-budget'), controls:!!document.querySelector('.coordination-access'), plan:document.body.innerText.includes('Bounded plan.')})`);
  check('historyKeepsFactsWithoutLiveScope', result.history.checkedText && result.history.plan && !result.history.budget && !result.history.controls);
  result.screenshots.push(await app.screenshot(caseRoot, 'history', 1020));
}

// ---- M3 Track A scenario matrix (a2–a5). Two-instance product truth per plan
// D-A6: with codex+claude stubs a planning failure must stop honestly BEFORE
// any replacement launch (chain-completeness pre-check); takeover is never
// claimed here. Both wrapper names are shadowed in every scenario (D-A5);
// unavailability is expressed through the stub's own probe response only.

const M3_STOP_ENV = 'cannot run on this machine right now, and an independent check needs two harnesses that can run';
const M3_SEND_REFUSAL = 'An independent check needs two harnesses that can run, so select at least two.';
const M3_BOOTSTRAP = "window.goalportCore && window.goalportCore.bootstrapCurrent().then(s => s.phase === 'done')";

function m3Check(scenarioId, result) {
  return (id, value) => { result.assertions[id] = !!value; if (!value) throw new Error(`${scenarioId} assertion failed: ${id}`); };
}

async function m3OpenDraft(app, result, scenario, names, check) {
  await app.until(M3_BOOTSTRAP, 30000);
  check('isolatedMarker', await app.evaluate('window.__GOALPORT_ISOLATED === 1'));
  const snapshot = await app.evaluate('window.goalportCore.snapshot()', true);
  result.coreSnapshot = { connection: snapshot.connection, protocolVersion: snapshot.protocolVersion };
  check('coreConnectedV2', snapshot.connection === 'connected' && snapshot.protocolVersion === 'goalport.ipc.v2');
  await app.click('button[aria-label="New goal"]');
  // R2: read-list boundary only — the panel's second (workspace-changes) list
  // reuses the row class, so a bare `.authorization-row` count sees write rows.
  await app.until(`!!document.querySelector(${JSON.stringify(AUTHORIZATION.readRow)})`);
  result.authorization = await app.evaluate(authorizationFactsExpression(), true);
  result.discoveryRows = result.authorization.readRows;
  await app.input('#draft-workspace', SYNTHETIC);
  await app.input('#draft-message', scenario.goal);
  for (const name of names) {
    const selector = `input[aria-label="${readSelectLabel(name)}"]`;
    if (!await app.evaluate(`document.querySelector(${JSON.stringify(selector)})?.checked === true`)) await app.click(selector);
  }
  await app.input('#authorization-turns', String(scenario.budget));
  result.authorization = await app.evaluate(authorizationFactsExpression(), true);
  result.discoveryRows = result.authorization.readRows;
  for (const [id, value] of Object.entries(readAuthorizationAssertions(result.authorization, { names, budget: scenario.budget }))) check(id, value);
}

async function m3TerminalDom(app) {
  return app.evaluate(`({
    envCard: !!document.querySelector('[data-kind="environment-blocked"]'),
    failedCards: document.querySelectorAll('.tl-event[data-kind="round-failed"]').length,
    continuedCards: document.querySelectorAll('.tl-event[data-kind="round-continued"]').length,
    failedCardSentence: document.body.innerText.includes('could not run its tools on this machine, so this stopped for it'),
    noTextCardSentence: document.body.innerText.includes('finished without any text, so this stopped for it'),
    envCardSentence: document.body.innerText.includes('cannot run its tools on this machine right now, so the plan was not completed'),
    envUseAgain: !!document.querySelector('[data-kind="environment-blocked"] button[aria-label="Use again Codex"]'),
    oneAlternativeStated: document.body.innerText.includes('Only 1 other usable harness is signed in'),
    outcomeFailed: Array.from(document.querySelectorAll('.coordination-status dd')).some(e => e.innerText.trim() === 'Failed'),
    roundEvents: Array.from(document.querySelectorAll('.tl-event[data-kind="round-failed"], .tl-event[data-kind="round-continued"]')).map(e => e.dataset.kind),
  })`);
}

// Assertions on the real on-disk artifacts right after an env-blocked planning
// stop: exactly one stub turn, no claude launch, persisted health + record.
export function envBlockedStopAssertions(artifacts) {
  const ledger = Object.entries(artifacts.ledger);
  const turns = artifacts.invocations.filter(e => e.invocationType === 'turn');
  const probes = artifacts.invocations.filter(e => e.invocationType === 'probe');
  const records = Array.isArray(artifacts.records) ? artifacts.records : [];
  const record = records[0];
  const entry = ledger[0];
  // collectArtifacts reads the raw health sidecar: {version, instances:{id}}.
  const blockedRecord = artifacts.health?.instances?.codex ?? artifacts.health?.codex ?? null;
  return {
    exactlyOneTurnInvocation: turns.length === 1 && turns[0].identity === 'codex' && turns[0].behaviorId === 'codex-environment-blocked' && turns[0].queueIndex === 0,
    noClaudeTurnEverLaunched: artifacts.invocations.every(i => !(i.identity === 'claude' && i.invocationType === 'turn')),
    ledgerSingleEnvBlockedEntry: ledger.length === 1 && entry?.[0].startsWith('coordinate-plan-') && entry?.[1].ok === false && entry?.[1].environmentBlocked === true && entry?.[1].messageDispatched === true && typeof entry?.[1].text === 'string' && entry[1].text.length > 0,
    healthRecordedWithBoundedDetail: !!blockedRecord && blockedRecord.detail.includes('helper_unknown_error') && blockedRecord.detail.length <= 300 && blockedRecord.commandId === entry?.[0] && !Number.isNaN(Date.parse(blockedRecord.blockedAt || '')),
    probesSeparateAndAtLeastSix: probes.length >= 6 && ['codex', 'claude'].every(id => probes.filter(p => p.identity === id).length >= 3),
    sentinelAndQueueAccepted: artifacts.invocations.every(i => !['sentinel-refused', 'turn-queue-exhausted'].includes(i.behaviorId)),
    oneClaimConsumedGrant: artifacts.claims.length === 1 && artifacts.claims[0] === `claim-${entry?.[0]}` && artifacts.unconsumedGrants.length === 0,
    recordFailedWithStopAndEnv: records.length === 1 && record?.verdict === 'failed' && typeof record?.stopReason === 'string' && record.stopReason.includes(M3_STOP_ENV) && record?.environmentBlocked?.instanceId === 'codex' && record?.environmentBlocked?.role === 'planning',
    roundEventsSingleFailed: Array.isArray(record?.roundEvents) && record.roundEvents.length === 1 && record.roundEvents[0].kind === 'failed' && record.roundEvents[0].instanceId === 'codex' && record.roundEvents[0].harness === 'Codex',
  };
}

// a2 act three / a5 phase two on-disk facts after the user chooses Use again.
export function useAgainAssertions(artifactsAfter, artifactsFinal) {
  const turns = artifactsFinal.invocations.filter(e => e.invocationType === 'turn').length;
  const blockedAfter = artifactsAfter.health?.instances?.codex ?? artifactsAfter.health?.codex ?? null;
  const blockedFinal = artifactsFinal.health?.instances?.codex ?? artifactsFinal.health?.codex ?? null;
  return {
    useAgainClearedHealthFile: !!blockedAfter && !blockedFinal,
    useAgainLaunchedNoTurn: turns === artifactsAfter.invocations.filter(e => e.invocationType === 'turn').length,
    sentinelStillAccepted: artifactsFinal.invocations.every(i => !['sentinel-refused', 'turn-queue-exhausted'].includes(i.behaviorId)),
  };
}

// a2: env-blocked Codex planning turn → typed block → honest pre-takeover stop
// → Use again clears health. EXACTLY one turn; the failed round-event is the
// only round card; no replacement or continued card may exist.
export async function runA2(app, caseRoot, result) {
  const scenario = validateScenario(SCENARIOS.a2);
  result.screenshots = []; result.walkthrough = [];
  const check = m3Check('a2', result);
  await m3OpenDraft(app, result, scenario, ['Codex', 'Claude'], check);
  result.walkthrough.push('New goal: two real discovered stub harness rows are selectable; checking both and allowing four turns permits one plan and one check. Nothing is sent until Send.');
  await app.click('button[aria-label="Send message"]');
  await app.until(`document.body.innerText.includes(${JSON.stringify(M3_STOP_ENV)})`, 20000);
  const dom = await m3TerminalDom(app);
  check('envCardVisible', dom.envCard && dom.envCardSentence);
  check('singleFailedCardNoContinuedNoReplacement', dom.failedCards === 1 && dom.continuedCards === 0 && dom.roundEvents.join(',') === 'round-failed');
  check('honestStaffingStopNamedCodex', dom.failedCardSentence);
  check('envCardOffersUseAgain', dom.envUseAgain);
  check('oneAlternativeStated', dom.oneAlternativeStated);
  check('verdictFailed', dom.outcomeFailed);
  result.walkthrough.push('Send: Codex stopped because its tools cannot run on this machine. The window names Codex, shows one failed-round card, states only one other harness is signed in, and stops honestly instead of pretending an independent check ran. It stays unused until Use again.');
  for (const width of scenario.widths) result.screenshots.push(await app.screenshot(caseRoot, 'terminal', width));
  result.artifacts = collectArtifacts(caseRoot);
  for (const [id, value] of Object.entries(envBlockedStopAssertions(result.artifacts))) check(id, value);
  await app.click('[data-kind="environment-blocked"] button[aria-label="Use again Codex"]');
  // The finished round auto-selects its saved plan, so the panel is not the
  // visible surface here; the user-visible proof of re-discovery is a fresh
  // New goal draft, exactly what a real user would open next.
  result.artifactsFinal = collectArtifacts(caseRoot);
  for (const [id, value] of Object.entries(useAgainAssertions(result.artifacts, result.artifactsFinal))) check(id, value);
  await app.click('button[aria-label="New goal"]');
  await app.until('!!document.querySelector(\'.authorization-row[data-instance="codex"].authorization-row-selectable\')');
  const after = await app.evaluate(`({
    codexSelectable: !!document.querySelector('.authorization-row[data-instance="codex"].authorization-row-selectable'),
    claudeSelectable: !!document.querySelector('.authorization-row[data-instance="claude"].authorization-row-selectable'),
    noBlockedRows: !document.querySelector('.authorization-row-blocked'),
    noBlockedText: !document.body.innerText.includes('Blocked on this machine'),
    freshRoundNotReplayed: !document.querySelector('[data-kind="environment-blocked"]'),
  })`);
  check('useAgainRediscoveredSelectable', after.codexSelectable && after.claudeSelectable && after.noBlockedRows && after.noBlockedText && after.freshRoundNotReplayed);
  result.screenshots.push(await app.screenshot(caseRoot, 'use-again', 1020));
  result.walkthrough.push('Use again: GoalPort forgets the machine-wide block. The finished round stays in Plans as failed; a fresh New goal shows Codex selectable again, with no hidden retry and no replay of the failed round.');
  check('allShotsNontrivial', result.screenshots.length === 4 && result.screenshots.every(s => s.bytes > 10000 && s.pngWidth === Math.round(s.requested.width * (s.viewport?.devicePixelRatio || 1))));
}

// a3: both wrapper names stay shadowed (D-A5); the Claude stub's probe answers
// logged-out, so discovery finds exactly one provider and a send is refused —
// zero turns, nothing authorized, nothing written.
export async function runA3(app, caseRoot, result) {
  const scenario = validateScenario(SCENARIOS.a3);
  result.screenshots = []; result.walkthrough = [];
  const check = m3Check('a3', result);
  await m3OpenDraft(app, result, scenario, ['Codex'], check);
  check('exactlyOneSelectableProvider', result.discoveryRows.length === 1 && result.discoveryRows[0].instance === 'codex' && result.discoveryRows[0].state.includes('selectable'));
  result.walkthrough.push('New goal: the read-member list shows only Codex as selectable. Claude answered its sign-in probe as logged out through its own stub response, so GoalPort shows one harness (and its separate workspace-changes row) and cannot offer an independent check. No file-change consent is checked.');
  await app.click('button[aria-label="Send message"]');
  await app.until(`document.body.innerText.includes(${JSON.stringify(M3_SEND_REFUSAL)})`, 15000);
  result.scopeAfterRefusal = await app.evaluate('window.goalportCore.coordinationScope()', true);
  check('sendRefusedWithMissingIndependentHarness', true);
  result.screenshots.push(await app.screenshot(caseRoot, 'refusal', 1020));
  result.walkthrough.push('Send: refused in place with the fewer-than-two sentence. Nothing was authorized, nothing was sent, and the composer stays open for the user to fix access first.');
  result.artifacts = collectArtifacts(caseRoot);
  const probes = result.artifacts.invocations.filter(e => e.invocationType === 'probe');
  const turns = result.artifacts.invocations.filter(e => e.invocationType === 'turn');
  check('claudeUnavailableViaStubProbeResponse', probes.some(p => p.identity === 'claude' && p.behaviorId === 'claude-probe-unavailable'));
  check('codexProbedAuthenticated', probes.some(p => p.identity === 'codex' && p.behaviorId === 'codex-probe-authenticated'));
  check('zeroTurnInvocations', turns.length === 0);
  check('probesCountedBothNames', probes.length >= 2);
  check('sentinelAndQueueAccepted', result.artifacts.invocations.every(i => !['sentinel-refused', 'turn-queue-exhausted'].includes(i.behaviorId)));
  check('nothingAuthorizedOrWritten', result.scopeAfterRefusal === null && Object.keys(result.artifacts.ledger).length === 0 && result.artifacts.claims.length === 0 && result.artifacts.unconsumedGrants.length === 0 && (Array.isArray(result.artifacts.records) ? result.artifacts.records.length === 0 : true) && (result.artifacts.health === null || Object.keys(result.artifacts.health).length === 0));
  // Nothing is written after the refusal, so the final snapshot is the same one.
  result.artifactsFinal = result.artifacts;
  check('allShotsNontrivial', result.screenshots.length === 1 && result.screenshots.every(s => s.bytes > 10000 && s.pngWidth === Math.round(s.requested.width * (s.viewport?.devicePixelRatio || 1))));
}

// a4: Codex plans, Claude's review returns an empty stdout exit 0 → stopCode
// no-text, dispatched true → continuable, but the re-selection pool is empty,
// so the round stops honestly. Exactly two turn invocations.
export async function runA4(app, caseRoot, result) {
  const scenario = validateScenario(SCENARIOS.a4);
  result.screenshots = []; result.walkthrough = [];
  const check = m3Check('a4', result);
  await m3OpenDraft(app, result, scenario, ['Codex', 'Claude'], check);
  await app.click('button[aria-label="Send message"]');
  await app.until("document.body.innerText.includes('finished without any text')", 20000);
  const dom = await m3TerminalDom(app);
  check('noEnvCardForNoText', !dom.envCard);
  check('singleFailedCardNoContinued', dom.failedCards === 1 && dom.continuedCards === 0 && dom.roundEvents.join(',') === 'round-failed');
  check('honestNoTextStop', dom.noTextCardSentence && !dom.failedCardSentence);
  check('verdictFailed', dom.outcomeFailed);
  result.walkthrough.push('Send: Codex produced the plan; Claude finished its check without any text, so the round stops and says exactly that instead of showing a verdict.');
  for (const width of scenario.widths) result.screenshots.push(await app.screenshot(caseRoot, 'terminal', width));
  result.artifacts = collectArtifacts(caseRoot);
  for (const [id, value] of Object.entries(noTextStopAssertions(result.artifacts))) check(id, value);
  result.artifactsFinal = result.artifacts;
  check('allShotsNontrivial', result.screenshots.length === 3 && result.screenshots.every(s => s.bytes > 10000 && s.pngWidth === Math.round(s.requested.width * (s.viewport?.devicePixelRatio || 1))));
}

export function noTextStopAssertions(artifacts) {
  const ledger = Object.entries(artifacts.ledger);
  const turns = artifacts.invocations.filter(e => e.invocationType === 'turn');
  const probes = artifacts.invocations.filter(e => e.invocationType === 'probe');
  const records = Array.isArray(artifacts.records) ? artifacts.records : [];
  const record = records[0];
  const planEntry = ledger.find(([id]) => id.startsWith('coordinate-plan-'));
  const reviewEntry = ledger.find(([id]) => id.startsWith('coordinate-review-'));
  return {
    exactlyTwoTurnInvocations: turns.length === 2 && turns.some(t => t.identity === 'codex' && t.behaviorId === 'codex-tool-success') && turns.some(t => t.identity === 'claude' && t.behaviorId === 'claude-no-text'),
    planOkReviewNoTextDispatched: ledger.length === 2 && planEntry?.[1].ok === true && planEntry?.[1].text === 'Bounded plan.' && planEntry?.[1].messageDispatched === true && reviewEntry?.[1].ok === false && reviewEntry?.[1].stopCode === 'no-text' && reviewEntry?.[1].messageDispatched === true && reviewEntry?.[1].text === '',
    noBlockedHealth: artifacts.health === null || Object.keys(artifacts.health).length === 0,
    probesSeparateAndAtLeastSix: probes.length >= 6 && ['codex', 'claude'].every(id => probes.filter(p => p.identity === id).length >= 3),
    sentinelAndQueueAccepted: artifacts.invocations.every(i => !['sentinel-refused', 'turn-queue-exhausted'].includes(i.behaviorId)),
    twoClaimsConsumedGrants: artifacts.claims.length === 2 && artifacts.unconsumedGrants.length === 0 && ledger.every(([id]) => artifacts.claims.includes(`claim-${id}`)),
    recordFailedNoText: records.length === 1 && record?.verdict === 'failed' && record?.planText === 'Bounded plan.' && typeof record?.stopReason === 'string' && record.stopReason.includes('finished without any text') && Array.isArray(record?.roundEvents) && record.roundEvents.length === 1 && record.roundEvents[0].kind === 'failed' && record.roundEvents[0].instanceId === 'claude' && record.roundEvents[0].harness === 'Claude',
  };
}

// a5 phase one: own fresh state dir, same env-blocked round as a2, but the
// user closes GoalPort BEFORE choosing Use again — the health record must
// survive the close (fabricating it by hand is banned; the real failure path
// produced it).
export async function runA5Round(app, caseRoot, result) {
  const scenario = validateScenario(SCENARIOS.a5);
  result.screenshots = []; result.walkthrough = [];
  const check = m3Check('a5', result);
  await m3OpenDraft(app, result, scenario, ['Codex', 'Claude'], check);
  await app.click('button[aria-label="Send message"]');
  await app.until(`document.body.innerText.includes(${JSON.stringify(M3_STOP_ENV)})`, 20000);
  const dom = await m3TerminalDom(app);
  check('round.envCardVisible', dom.envCard);
  check('round.singleFailedCardNoContinued', dom.failedCards === 1 && dom.continuedCards === 0);
  check('round.honestStaffingStopNamedCodex', dom.failedCardSentence);
  check('round.verdictFailed', dom.outcomeFailed);
  result.walkthrough.push('Round one: Codex cannot run its tools on this machine; the window names Codex, shows the failed-round card, and stops honestly. This time the user closes GoalPort without choosing Use again.');
  result.screenshots.push(await app.screenshot(caseRoot, 'terminal', 1020));
  result.artifacts = collectArtifacts(caseRoot);
  for (const [id, value] of Object.entries(envBlockedStopAssertions(result.artifacts))) check(`round.${id}`, value);
}

// a5 phase two: relaunch against the SAME state dir. The remembered health
// must show in the panel BEFORE any send (zero new turns), then Use again from
// the panel row clears it and the row becomes selectable.
export async function runA5Relaunch(app, caseRoot, result) {
  const scenario = validateScenario(SCENARIOS.a5);
  const check = m3Check('a5', result);
  const turnsBefore = result.artifacts.invocations.filter(e => e.invocationType === 'turn').length;
  await app.until(M3_BOOTSTRAP, 30000);
  check('relaunch.isolatedMarker', await app.evaluate('window.__GOALPORT_ISOLATED === 1'));
  const snapshot = await app.evaluate('window.goalportCore.snapshot()', true);
  check('relaunch.coreConnectedV2', snapshot.connection === 'connected' && snapshot.protocolVersion === 'goalport.ipc.v2');
  // The failed round's record survived the close: the relaunched window shows
  // it before the user does anything (state continuity, not a re-send).
  await app.until("document.body.innerText.includes('could not run its tools on this machine')", 20000);
  check('relaunch.failedRoundSurvivedClose', true);
  await app.click('button[aria-label="New goal"]');
  await app.until('!!document.querySelector(\'.authorization-row[data-instance="codex"]\')');
  // R2: rows and write members come from the shared read-list expression, so a
  // remembered blocked row can never be counted from the write list.
  const panelFacts = await app.evaluate(authorizationFactsExpression(), true);
  const panel = { rows: panelFacts.readRows, ...await app.evaluate(`({
    blockedText: document.body.innerText.includes('Blocked on this machine since') && document.body.innerText.includes('its tools could not run'),
    rowDetails: !!document.querySelector('.authorization-row[data-instance="codex"] details.technical-details'),
    rowUseAgain: !!document.querySelector('.authorization-row[data-instance="codex"] button[aria-label="Use again Codex"]'),
  })`) };
  check('relaunch.blockedRowShownBeforeSend', panel.rows.some(r => r.instance === 'codex' && r.state.includes('authorization-row-blocked')) && panel.blockedText && panel.rowDetails && panel.rowUseAgain);
  check('relaunch.claudeStillSelectable', panel.rows.some(r => r.instance === 'claude' && r.state.includes('authorization-row-selectable')));
  check('relaunch.writeConsentStaysOff', panelFacts.readRows.length === 2 && panelFacts.readSelects.length === 1 && writeConsentOff(panelFacts));
  result.screenshots.push(await app.screenshot(caseRoot, 'blocked-panel', 1020));
  result.walkthrough.push('Relaunch: before anything is sent, the panel already says Codex is blocked on this machine since the earlier failure, with the technical detail folded away and a Use again control. The memory survived the close.');
  await app.click('.authorization-row[data-instance="codex"] button[aria-label="Use again Codex"]');
  await app.until('!!document.querySelector(\'.authorization-row[data-instance="codex"].authorization-row-selectable\')');
  const after = await app.evaluate(`({ selectable: !!document.querySelector('.authorization-row[data-instance="codex"].authorization-row-selectable'), checked: document.querySelector('input[aria-label="Select Codex"]')?.checked === true })`);
  check('relaunch.useAgainClearedAndReselected', after.selectable && after.checked);
  result.artifactsFinal = collectArtifacts(caseRoot);
  for (const [id, value] of Object.entries(useAgainAssertions(result.artifacts, result.artifactsFinal))) check(`relaunch.${id}`, value);
  const turnsNow = result.artifactsFinal.invocations.filter(e => e.invocationType === 'turn').length;
  check('relaunch.noTurnAcrossRelaunch', turnsNow === turnsBefore);
  result.screenshots.push(await app.screenshot(caseRoot, 'unblocked-panel', 1020));
  result.walkthrough.push('Use again: the row becomes selectable in place; health memory is gone on disk. A later send would be a fresh round, not a replay of the failed one.');
}

export function validateReport(report) {
  if (report.schemaVersion !== 1 || report.kind !== 'goalport-m2-real-app' || typeof report.head !== 'string' || !report.caseRoot || !report.a1 || !report.cleanup || !['ready','blocked'].includes(report.status)) throw new Error('invalid report envelope');
  if (report.status === 'ready' && (Object.keys(report.a1.assertions).length < 21 || !Object.values(report.a1.assertions).every(Boolean) || !report.a1.artifacts || report.a1.screenshots.length < 7 || !report.a1.assertions.nativeLayoutAndControlsFit || !report.cleanup.coreStopped || !report.cleanup.socketAbsent || report.cleanup.electronExit?.code !== 0)) throw new Error('ready report lacks actual assertions/artifacts/cleanup');
  return report;
}
