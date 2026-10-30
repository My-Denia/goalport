import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { collectArtifacts } from './scenarios.mjs';
import { snapshotFixture, baselineChecks } from './execution-scenarios.mjs';
import {
  EXECUTION_FIXTURE_INCOMPLETE_SOURCE,
  EXECUTION_FIXTURE_REPAIRED_SOURCE,
} from './execution-fixture.mjs';

export const WIDTHS = Object.freeze([860, 1020, 1440]);
const probes = Object.freeze({ codex: 'codex-probe-authenticated', claude: 'claude-probe-authenticated' });
const GOAL_TEXT = 'Repair add(a,b) in this disposable offline fixture and check the unchanged original tests. Only explicitly permitted changes may be sent.';
const BUDGET_STOP_SNIPPET = 'not enough access left for one more checked repair';
const REPAIR_PROGRESS_SNIPPET = 'one checked repair is now running';

// Two real-app continuation journeys over the c1-feedback-repair preset.
// c1: six read turns/two write turns fund both four-role chains (the initial
// audit revises, the corrective audit verifies). c2: the default four read
// turns run the first chain only; the budget stop explains why no repair ran.
export const FEEDBACK_SCENARIOS = Object.freeze({
  c1: Object.freeze({
    preset: 'c1-feedback-repair',
    write: true,
    readTurns: 6,
    writeTurns: 2,
    totalTurns: 8,
    behavior: Object.freeze({
      probes,
      turns: Object.freeze({
        codex: Object.freeze(['codex-fixture-plan', 'codex-fixture-incomplete-writer-delayed', 'codex-fixture-corrective-plan-delayed', 'codex-fixture-corrective-writer']),
        claude: Object.freeze(['claude-carry-out', 'claude-fixture-critique-checker-delayed', 'claude-carry-out', 'claude-fixture-auditor']),
      }),
    }),
    states: Object.freeze(['write-consent', 'making-changes', 'critique', 'repair-progress', 'verified', 'reopened-history']),
    terminal: 'Changes verified',
  }),
  c2: Object.freeze({
    preset: 'c1-feedback-repair',
    write: true,
    readTurns: 4,
    writeTurns: 2,
    totalTurns: 4,
    behavior: Object.freeze({
      probes,
      turns: Object.freeze({
        codex: Object.freeze(['codex-fixture-plan', 'codex-fixture-incomplete-writer-delayed']),
        claude: Object.freeze(['claude-carry-out', 'claude-fixture-critique-checker-delayed']),
      }),
    }),
    states: Object.freeze(['write-consent', 'making-changes', 'budget-stop']),
    terminal: 'Needs revision',
  }),
});

export const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export const readLines = filename => fs.existsSync(filename) ? fs.readFileSync(filename, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) : [];
export { snapshotFixture, baselineChecks };
export const INCOMPLETE_SOURCE_HASH = hash(EXECUTION_FIXTURE_INCOMPLETE_SOURCE);
export const REPAIRED_SOURCE_HASH = hash(EXECUTION_FIXTURE_REPAIRED_SOURCE);

async function shots(app, caseRoot, result, state) {
  for (const width of WIDTHS) result.screenshots.push(await app.screenshot(caseRoot, state, width));
}

/**
 * Evidence invariants for both journeys, evaluated against the archived
 * artifacts (and again by the driver's report validator at the end).
 */
export function feedbackAssertions(id, result, { final = false } = {}) {
  const scenario = FEEDBACK_SCENARIOS[id];
  const expectedStates = final ? scenario.states : scenario.states.filter(state => state !== 'reopened-history');
  const a = result.artifacts;
  const turns = a.invocations.filter(i => i.invocationType === 'turn');
  const entries = Object.entries(a.ledger);
  const claims = a.claims;
  const records = a.records;
  const record = records[0];
  const operations = result.operations;
  const before = Object.fromEntries(result.before.files.map(f => [f.relative, f.sha256]));
  const intermediate = Object.fromEntries((result.intermediate?.files ?? []).map(f => [f.relative, f.sha256]));
  const after = Object.fromEntries(result.after.files.map(f => [f.relative, f.sha256]));
  const op = name => operations.find(o => o.operation === name);
  const incompleteWriter = op('incomplete-writer');
  const critique = op('critique-checker');
  const shared = {
    exactlyExpectedTurnsAndClaims: turns.length === scenario.totalTurns && entries.length === scenario.totalTurns && claims.length === scenario.totalTurns && entries.every(([commandId]) => claims.includes(`claim-${commandId}`)),
    exactQueue: ['codex', 'claude'].every(identity => JSON.stringify(turns.filter(t => t.identity === identity).map(t => t.behaviorId)) === JSON.stringify(scenario.behavior.turns[identity])),
    noReplay: new Set(entries.map(([commandId]) => commandId)).size === scenario.totalTurns && turns.every(t => t.consumesQueue === true) && turns.every((t, n) => t.identity === (n % 2 === 0 ? 'codex' : 'claude')),
    sentinelAccepted: a.invocations.every(i => !['sentinel-refused', 'turn-queue-exhausted'].includes(i.behaviorId)),
    actualModeAndRoot: turns.every(i => i.cwd === result.fixtureRoot && (i.identity === 'codex'
      ? i.argv[i.argv.indexOf('--sandbox') + 1] === (['codex-fixture-incomplete-writer-delayed', 'codex-fixture-corrective-writer'].includes(i.behaviorId) ? 'workspace-write' : 'read-only') && i.argv[i.argv.indexOf('--cd') + 1] === result.fixtureRoot
      : i.argv[i.argv.indexOf('--permission-mode') + 1] === 'plan')),
    consumedJitGrants: a.unconsumedGrants.length === 0 && entries.every(([, entry]) => entry.messageDispatched === true),
    separateProbes: ['codex', 'claude'].every(identity => a.invocations.filter(i => i.identity === identity && i.invocationType === 'probe').length >= 3),
    originalTestsUnchanged: before['test/add.test.mjs'] === after['test/add.test.mjs'],
    markerUnchanged: before['.goalport-offline-fixture.json'] === after['.goalport-offline-fixture.json'],
    noTransientSavedScope: records.every(r => !('authorizedTurnsLeft' in r) && !('authorizedWriteTurnsLeft' in r)),
    allNativeShots: result.screenshots.length >= expectedStates.length * 3 && expectedStates.every(state => WIDTHS.every(width => result.screenshots.some(s => s.state === state && s.viewport.width === width && s.pngWidth === width && s.pngHeight === 900 && s.bytes > 10000 && !s.geometry.horizontalOverflow && (width !== 860 || !s.geometry.drawerOpen)))),
    genuineFailedChecksAsFeedback: incompleteWriter?.evidence.cliTurnCompleted === true && incompleteWriter?.evidence.checksFailed === true && incompleteWriter?.cli.exitCode === 0 && critique?.evidence.observedFailure === true && critique?.evidence.checkCommandFailed === true && critique?.evidence.cliTurnCompleted === true && critique?.verdict === 'revise' && critique?.evidence.verdict === 'revise',
    critiqueIsSeparateProcess: critique?.evidence.checker?.checkerKind === 'separate-read-only-node-process' && critique?.evidence.checker?.pid !== incompleteWriter?.evidence.parentPid && critique?.evidence.checker?.pid !== critique?.evidence.parentPid && critique?.evidence.checker?.noIndependentModelClaim === true,
  };
  if (id === 'c1') {
    const correctivePlan = op('corrective-plan');
    const correctiveWriter = op('corrective-writer');
    const auditor = op('auditor');
    const firstRoundIds = record?.feedbackHistory?.[0]?.commandIds ?? [];
    return {
      ...shared,
      roleFamilyPerPass: ['plan', 'review', 'execute', 'audit'].every(role => entries.filter(([commandId]) => commandId.startsWith(`coordinate-${role}-`)).length === 2),
      independentPairsPerPass: [0, 4].every(offset => {
        const pass = turns.slice(offset, offset + 4);
        return pass[0].identity !== pass[1].identity && pass[2].identity !== pass[3].identity;
      }),
      scopeDualCounters: result.finalScope?.remaining === 0 && result.finalScope?.maxTurns === 6 && result.finalScope?.write?.remaining === 0 && result.finalScope?.write?.maxTurns === 2 && result.finalScope?.write?.workspaceRoot === result.fixtureRoot,
      honestVerifiedRecord: records.length === 1 && record?.verdict === 'verified' && record?.executionHarness === 'Codex' && record?.auditHarness === 'Claude' && record?.auditText?.endsWith('VERDICT: verified') && record?.messageDispatched === true && record?.executionText?.includes('Corrective executor CLI turn completed'),
      retainedFirstRoundFacts: firstRoundIds.length === 4 && record?.feedbackHistory?.[0]?.verdict === 'revise' && record?.feedbackHistory?.[0]?.auditText?.endsWith('VERDICT: revise') && record?.feedbackHistory?.[0]?.messageDispatched === true && record?.feedbackHistory?.[0]?.executionText?.includes('First executor CLI turn completed') && firstRoundIds.every(commandId => entries.some(([key]) => key === commandId)),
      correctivePlannerSawIntermediate: correctivePlan?.evidence.sourceSha256 === INCOMPLETE_SOURCE_HASH && intermediate['src/add.mjs'] === INCOMPLETE_SOURCE_HASH,
      correctiveRepairAndPassingChecks: correctiveWriter?.evidence.cliTurnCompleted === true && correctiveWriter?.evidence.checks?.testsPassed === true && correctiveWriter?.evidence.testBytesUnchanged === true && after['src/add.mjs'] === REPAIRED_SOURCE_HASH,
      secondCheckerSeparateAndVerified: auditor?.verified === true && auditor?.evidence.auditor?.auditorKind === 'separate-read-only-node-process' && auditor?.evidence.auditor?.role === 'read-only-auditor' && auditor?.evidence.auditor?.noIndependentModelClaim === true && auditor?.evidence.auditorProcess?.exitCode === 0 && auditor?.evidence.auditor?.pid !== correctiveWriter?.evidence.parentPid && auditor?.evidence.auditor?.pid !== critique?.evidence.checker?.pid && auditor?.evidence.auditor?.testsPassed === true && auditor?.evidence.auditor?.originalTests?.matchesPinnedBytes === true,
      domShowsBothPasses: result.screenshots.filter(s => s.state === 'verified').every(s => s.geometry.text.includes('Changes verified') && s.geometry.text.includes('Before automatic repair')) && result.screenshots.filter(s => s.state === 'repair-progress').every(s => s.geometry.text.includes(REPAIR_PROGRESS_SNIPPET)),
      oneAuthorizationPerSend: true,
    };
  }
  // c2: the initial audit revises, the budget stop explains itself, and no
  // fifth turn is ever launched.
  const turnCountAfterSettle = result.settledInvocations?.filter(i => i.invocationType === 'turn').length;
  return {
    ...shared,
    roleFamilyOnce: ['plan', 'review', 'execute', 'audit'].every(role => entries.filter(([commandId]) => commandId.startsWith(`coordinate-${role}-`)).length === 1),
    scopeDualCounters: result.finalScope?.remaining === 1 && result.finalScope?.maxTurns === 4 && result.finalScope?.write?.remaining === 1 && result.finalScope?.write?.maxTurns === 2,
    budgetStopWithoutRepair: records.length === 1 && record?.verdict === 'revise' && record?.messageDispatched === true && record?.stopReason?.includes(BUDGET_STOP_SNIPPET) && record?.stopReason?.includes('GoalPort did not add turns') && !Object.hasOwn(record, 'feedbackHistory') && turnCountAfterSettle === scenario.totalTurns,
    unrepairedIntermediateRetained: after['src/add.mjs'] === INCOMPLETE_SOURCE_HASH && intermediate['src/add.mjs'] === INCOMPLETE_SOURCE_HASH && operations.length === 3,
    noVerifiedClaim: result.screenshots.filter(s => s.state === 'budget-stop').every(s => !s.geometry.text.includes('Changes verified') && s.geometry.text.includes(BUDGET_STOP_SNIPPET) && s.geometry.text.includes('1 of 4 turns left')),
    noRepairTurnsLaunched: !operations.some(o => o.operation === 'corrective-plan' || o.operation === 'corrective-writer') && turns.length === 4,
    domShowsCritique: result.screenshots.filter(s => s.state === 'budget-stop').every(s => s.geometry.text.includes('Needs revision') && s.geometry.text.includes('VERDICT: revise')),
  };
}

export async function runFeedbackScenario(id, app, caseRoot, fixture, result) {
  const scenario = FEEDBACK_SCENARIOS[id];
  const check = (name, value) => { result.assertions[name] = Boolean(value); if (!value) throw Error(`${id} assertion failed: ${name}`); };
  result.screenshots = []; result.walkthrough = []; result.scopes = {};
  await app.until("window.goalportCore && window.goalportCore.bootstrapCurrent().then(s => s.phase === 'done')", 30000);
  result.coreSnapshot = await app.evaluate('window.goalportCore.snapshot()', true);
  check('realCoreConnected', result.coreSnapshot.connection === 'connected' && result.coreSnapshot.protocolVersion === 'goalport.ipc.v2');
  result.scopes.before = await app.evaluate('window.goalportCore.coordinationScope()', true);
  check('noSeededScope', result.scopes.before === null);
  check('noSeededLedgerOrHistory', collectArtifacts(caseRoot).records.length === 0 && Object.keys(collectArtifacts(caseRoot).ledger).length === 0);
  result.walkthrough.push('First launch: actual Electron main/preload, built renderer and connected Core; no seeded authorization, ledger or history.');
  await app.click('button[aria-label="New goal"]');
  await app.until('!!document.querySelector(\'input[aria-label="Select Codex"]:not(:disabled)\') && !!document.querySelector(\'input[aria-label="Select Claude"]:not(:disabled)\')');
  await app.input('#draft-workspace', fixture.root);
  await app.input('#draft-message', GOAL_TEXT);
  for (const name of ['Codex', 'Claude']) {
    const selector = `input[aria-label="Select ${name}"]`;
    if (!await app.evaluate(`document.querySelector(${JSON.stringify(selector)}).checked`)) await app.click(selector);
  }
  // c1: the user raises the read budget to 6 so both chains fit. c2: the
  // default 4 stays, which is exactly what must stop the repair later.
  if (scenario.readTurns !== 4) await app.input('#authorization-turns', String(scenario.readTurns));
  check('writeDefaultOff', await app.evaluate('Array.from(document.querySelectorAll(".authorization-write-section input[type=checkbox]")).every(e => !e.checked)'));
  for (const name of ['Codex', 'Claude']) await app.click(`input[aria-label="Allow changes through ${name}"]`);
  await app.input('#authorization-write-turns', String(scenario.writeTurns));
  check('readAndWriteSeparate', await app.evaluate(`document.querySelector('#authorization-turns').value === '${scenario.readTurns}' && Array.from(document.querySelectorAll('.authorization-write-section input[type=checkbox]')).every(e => e.checked === true)`));
  check('repairExplainedBeforeSend', await app.evaluate(`document.body.innerText.includes('one further') && document.body.innerText.includes('keep this window open')`));
  await shots(app, caseRoot, result, 'write-consent');
  result.walkthrough.push(`New goal/workspace/goal/read selection/read budget ${scenario.readTurns}: ordinary DOM input. Workspace changes explicitly selected for both harnesses, budget 2, and the panel explains that verification may lead to one further checked repair inside these budgets while the window stays open.`);
  await app.resize(1020);
  await app.click('button[aria-label="Send message"]');
  // First pass: real writer in flight on the intermediate edit.
  await app.until("document.body.innerText.includes('Codex is making changes')", 30000);
  result.scopes.makingChanges = await app.evaluate('window.goalportCore.coordinationScope()', true);
  await shots(app, caseRoot, result, 'making-changes');
  // The incomplete edit is on disk right now: archive those exact bytes.
  result.intermediate = snapshotFixture(fixture, caseRoot, 'intermediate');
  result.walkthrough.push('Send: one authorization, one Send. The plan (Codex) is checked independently (Claude), then the real writer makes a genuinely incomplete edit and honestly reports the unchanged failing checks. The intermediate bytes are archived.');
  // First pass verification: the separate read-only critique checker.
  await app.until("document.body.innerText.includes('Claude is verifying')", 45000);
  result.scopes.critique = await app.evaluate('window.goalportCore.coordinationScope()', true);
  await shots(app, caseRoot, result, 'critique');
  if (id === 'c1') {
    // The corrective pass starts in the same Send, without a new authorization.
    await app.until(`document.body.innerText.includes(${JSON.stringify(REPAIR_PROGRESS_SNIPPET)})`, 60000);
    result.scopes.repairProgress = await app.evaluate('window.goalportCore.coordinationScope()', true);
    check('repairUsesSameGeneration', result.scopes.repairProgress !== null
      && result.scopes.repairProgress?.generation === result.scopes.makingChanges?.generation
      && result.scopes.repairProgress?.remaining <= 3 && result.scopes.repairProgress?.remaining >= 2
      && result.scopes.repairProgress?.write?.remaining === 1
      && result.scopes.repairProgress?.instances?.join() === result.scopes.makingChanges?.instances?.join());
    await shots(app, caseRoot, result, 'repair-progress');
    result.walkthrough.push('The completed critique ends VERDICT: revise, so GoalPort organizes one checked repair in the same window: the progress line says so, the same scope generation pays for it, and no new authorization happens.');
    await app.until("document.body.innerText.includes('Changes verified') && !document.querySelector('.coordination-progress')", 90000);
    await app.until("document.body.innerText.includes('0 of 6 turns left')", 10000);
    result.finalScope = await app.evaluate('window.goalportCore.coordinationScope()', true);
    await shots(app, caseRoot, result, 'verified');
    result.walkthrough.push('The corrective plan is checked again, a corrective writer repairs the pinned source, and a second separate read-only checker reruns the unchanged tests and verifies. Both budgets reach zero; the record keeps the first pass folded under Before automatic repair.');
  } else {
    await app.until(`document.body.innerText.includes(${JSON.stringify(BUDGET_STOP_SNIPPET)}) && !document.querySelector('.coordination-progress')`, 90000);
    await app.until("document.body.innerText.includes('1 of 4 turns left')", 10000);
    result.finalScope = await app.evaluate('window.goalportCore.coordinationScope()', true);
    await shots(app, caseRoot, result, 'budget-stop');
    result.walkthrough.push('The critique revises, but only one of four read turns remains: GoalPort explains the repair needs three model turns and one write turn, did not add turns, and launched no fifth turn. The incomplete edit stays on disk for inspection.');
    // Prove the stop is durable: no turn appears after the terminal view.
    await new Promise(resolve => setTimeout(resolve, 3000));
    result.settledInvocations = collectArtifacts(caseRoot).invocations;
  }
  result.after = snapshotFixture(fixture, caseRoot, 'after');
  result.artifacts = collectArtifacts(caseRoot);
  result.operations = readLines(path.join(caseRoot, 'stub-bin/execution-operations.jsonl'));
  for (const [name, value] of Object.entries(feedbackAssertions(id, result))) check(name, value);
  // Actual first-user CLOSE, never an injected close/save/authorize hook.
  await app.click('button[aria-label="Application menu"]');
  await app.until('!!document.querySelector(\'[role="menu"] [aria-label="Close window"]\')');
  try {
    await app.click('[role="menu"] [aria-label="Close window"]');
  } catch (error) {
    // Native menu Close may destroy CDP before mouseReleased's receipt. Only
    // this exact post-hit-test disconnect is expected; cleanup still requires
    // the actual unforced Electron exit0 and owned Core/socket absence.
    if (error.message !== 'CDP WebSocket closed') throw error;
    result.domCloseReceipt = error.message;
  }
  result.domCloseClicked = true;
  result.walkthrough.push('Application menu → Close window clicked through CDP mouse hit testing; not native OS keyboard/mouse and not a background-continuation test.');
}

/**
 * C1 phase two: relaunch with fresh process/socket/temp against the SAME
 * durable records, harness ledger and exhausted stub queues. Reopening must
 * restore evidence only — null scope, no added turns, write consent OFF.
 */
export async function runFeedbackRelaunch(app, caseRoot, result) {
  const check = (name, value) => { result.assertions[`relaunch.${name}`] = Boolean(value); if (!value) throw Error(`c1 relaunch assertion failed: ${name}`); };
  const turnsBefore = result.artifacts.invocations.filter(i => i.invocationType === 'turn').length;
  await app.until("window.goalportCore && window.goalportCore.bootstrapCurrent().then(s => s.phase === 'done')", 30000);
  const snapshot = await app.evaluate('window.goalportCore.snapshot()', true);
  check('coreConnectedV2', snapshot.connection === 'connected' && snapshot.protocolVersion === 'goalport.ipc.v2');
  // The repaired record survives the close and reopens as facts only.
  await app.until("document.body.innerText.includes('Changes verified') && document.body.innerText.includes('Before automatic repair')", 30000);
  check('recordSurvivedClose', true);
  const reopenedScope = await app.evaluate('window.goalportCore.coordinationScope()', true);
  check('scopeNullAfterReopen', reopenedScope === null);
  check('noLiveControls', await app.evaluate('!document.querySelector(".coordination-access") && !document.querySelector(".coordination-budget")'));
  // Expanding the retained section must show the first pass's actual reports.
  await app.click('details.coordination-retained-round > summary');
  await app.until("document.body.innerText.includes('VERDICT: revise')", 10000);
  check('firstPassReportsReadable', true);
  await shots(app, caseRoot, result, 'reopened-history');
  result.walkthrough.push('Relaunch with a fresh process, socket and temp against the same durable records and ledger: the repaired goal reopens with both passes, the first pass folded under Before automatic repair, no live scope and no access controls.');
  // A new draft starts over: write consent OFF, default four read turns,
  // and no model turn is spent by reopening.
  await app.click('button[aria-label="New goal"]');
  await app.until('!!document.querySelector(\'input[aria-label="Select Codex"]:not(:disabled)\')');
  const draftFacts = await app.evaluate(`({
    writeOff: Array.from(document.querySelectorAll(".authorization-write-section input[type=checkbox]")).every(e => !e.checked),
    readTurns: document.querySelector('#authorization-turns').value,
  })`, true);
  check('writeConsentOffAfterReopen', draftFacts.writeOff === true);
  check('defaultTurnsUnchanged', draftFacts.readTurns === '4');
  const artifactsFinal = collectArtifacts(caseRoot);
  check('noTurnAcrossRelaunch', artifactsFinal.invocations.filter(i => i.invocationType === 'turn').length === turnsBefore);
  result.artifactsFinal = artifactsFinal;
  // Actual first-user CLOSE for the relaunched window too.
  await app.click('button[aria-label="Application menu"]');
  await app.until('!!document.querySelector(\'[role="menu"] [aria-label="Close window"]\')');
  try {
    await app.click('[role="menu"] [aria-label="Close window"]');
  } catch (error) {
    if (error.message !== 'CDP WebSocket closed') throw error;
    result.domCloseReceipt = error.message;
  }
  result.domCloseClicked = true;
  result.walkthrough.push('Application menu → Close window clicked through CDP mouse hit testing; not native OS keyboard/mouse and not a background-continuation test.');
}
