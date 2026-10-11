import fs from 'node:fs';
import path from 'node:path';
import { collectArtifacts } from './scenarios.mjs';
import { snapshotFixture, baselineChecks, WIDTHS, hash } from './feedback-scenarios.mjs';
import { closeThroughMenu, observeOwnedRenderers, retainJobFacts, shots as backgroundShots } from './background-scenarios.mjs';
import {
  EXECUTION_FIXTURE_FLAWED_PLAN,
  EXECUTION_FIXTURE_REVISED_PLAN,
} from './execution-fixture.mjs';

// C4 offline acceptance: one pre-write plan revision through the real app.
// PR1 proves the healthy revised path end to end (one Send/authorization,
// five read turns, one write turn, six fresh commands, actual fixture repair,
// separate read-only checkers). PR2 proves the four-read-turn default cannot
// fund it and stops explained. PR3 proves a second rejection is terminal.
// PR4 proves the explicitly admitted background job runs the same revision
// after the desktop closes, without a second Send or authorization.

export const PLAN_REVISION_GOAL = 'Plan the add(a,b) repair in this disposable offline fixture and only make changes the independent checks approve.';
const probes = Object.freeze({ codex: 'codex-probe-authenticated', claude: 'claude-probe-authenticated' });
export const PLAN_BUDGET_STOP_SNIPPET = 'not enough access left for one more checked plan revision';
export const PLAN_REVISION_CEILING_SNIPPET = 'This send already used its one automatic plan revision';
export const PLAN_REVISION_PROGRESS_SNIPPET = 'one revised plan is now being written and checked';
const SECOND_CRITIQUE = 'Needs a smaller step.\nVERDICT: revise';

export const PLAN_REVISION_SCENARIOS = Object.freeze({
  pr1: Object.freeze({
    preset: 'c4-plan-revision',
    background: false,
    write: true,
    readTurns: 5,
    writeTurns: 1,
    totalTurns: 6,
    behavior: Object.freeze({
      probes,
      turns: Object.freeze({
        codex: Object.freeze(['codex-fixture-flawed-plan', 'codex-fixture-revised-plan-delayed', 'codex-fixture-writer']),
        claude: Object.freeze(['claude-fixture-plan-critique-checker-delayed', 'claude-carry-out', 'claude-fixture-auditor']),
      }),
    }),
    states: Object.freeze(['write-consent', 'critique', 'revision-progress', 'verified', 'reopened-history']),
    terminal: 'Changes verified',
  }),
  pr2: Object.freeze({
    preset: 'c4-plan-revision',
    background: false,
    write: true,
    readTurns: 4,
    writeTurns: 1,
    totalTurns: 2,
    behavior: Object.freeze({
      probes,
      turns: Object.freeze({
        codex: Object.freeze(['codex-fixture-flawed-plan']),
        claude: Object.freeze(['claude-fixture-plan-critique-checker-delayed']),
      }),
    }),
    states: Object.freeze(['write-consent', 'critique', 'budget-stop']),
    terminal: 'Needs revision',
  }),
  pr3: Object.freeze({
    preset: 'c4-plan-revision',
    background: false,
    write: true,
    readTurns: 5,
    writeTurns: 1,
    totalTurns: 4,
    behavior: Object.freeze({
      probes,
      turns: Object.freeze({
        codex: Object.freeze(['codex-fixture-flawed-plan', 'codex-fixture-revised-plan-delayed']),
        claude: Object.freeze(['claude-fixture-plan-critique-checker-delayed', 'claude-review-success']),
      }),
    }),
    states: Object.freeze(['write-consent', 'critique', 'revision-progress', 'second-rejection']),
    terminal: 'Needs revision',
  }),
  pr4: Object.freeze({
    preset: 'c4-plan-revision',
    background: true,
    write: true,
    readTurns: 5,
    writeTurns: 1,
    totalTurns: 6,
    behavior: Object.freeze({
      probes,
      turns: Object.freeze({
        codex: Object.freeze(['codex-fixture-flawed-plan', 'codex-fixture-revised-plan-delayed', 'codex-fixture-writer']),
        claude: Object.freeze(['claude-fixture-plan-critique-checker-delayed', 'claude-carry-out', 'claude-fixture-auditor']),
      }),
    }),
    states: Object.freeze(['consent', 'live-return', 'verified']),
    terminal: 'Changes verified',
  }),
});

export { snapshotFixture, baselineChecks, WIDTHS, hash };

export const FLAWED_PLAN_HASH = hash(EXECUTION_FIXTURE_FLAWED_PLAN);
export const REVISED_PLAN_HASH = hash(EXECUTION_FIXTURE_REVISED_PLAN);

export const readLines = filename => fs.existsSync(filename) ? fs.readFileSync(filename, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) : [];

async function shots(app, caseRoot, result, state) {
  for (const width of WIDTHS) result.screenshots.push(await app.screenshot(caseRoot, state, width));
}

/**
 * Evidence invariants per journey, evaluated against the archived artifacts
 * (and again by the driver's report validator at the end).
 */
export function planRevisionAssertions(id, result, { final = false } = {}) {
  const scenario = PLAN_REVISION_SCENARIOS[id];
  const expectedStates = final ? scenario.states : scenario.states.filter(state => state !== 'reopened-history');
  const artifacts = result.artifactsFinal ?? result.artifacts;
  const turns = artifacts.invocations.filter(i => i.invocationType === 'turn');
  const entries = Object.entries(artifacts.ledger);
  const claims = artifacts.claims;
  const records = artifacts.records;
  const record = records[0];
  const operations = result.operations ?? [];
  const before = Object.fromEntries(result.before.files.map(f => [f.relative, f.sha256]));
  const after = Object.fromEntries(result.after.files.map(f => [f.relative, f.sha256]));
  const op = name => operations.find(o => o.operation === name);
  const flawedPlan = op('flawed-plan');
  const planCritique = op('plan-critique-checker');
  const shared = {
    exactlyExpectedTurnsAndClaims: turns.length === scenario.totalTurns && entries.length === scenario.totalTurns && claims.length === scenario.totalTurns && entries.every(([commandId]) => claims.includes(`claim-${commandId}`)),
    exactQueue: ['codex', 'claude'].every(identity => JSON.stringify(turns.filter(t => t.identity === identity).map(t => t.behaviorId)) === JSON.stringify(scenario.behavior.turns[identity])),
    noReplay: new Set(entries.map(([commandId]) => commandId)).size === scenario.totalTurns && turns.every(t => t.consumesQueue === true) && turns.every((t, n) => t.identity === (n % 2 === 0 ? 'codex' : 'claude')),
    sentinelAccepted: artifacts.invocations.every(i => !['sentinel-refused', 'turn-queue-exhausted'].includes(i.behaviorId)),
    actualModeAndRoot: turns.every(i => i.cwd === result.fixtureRoot && (i.identity === 'codex'
      ? i.argv[i.argv.indexOf('--sandbox') + 1] === (i.behaviorId === 'codex-fixture-writer' ? 'workspace-write' : 'read-only') && i.argv[i.argv.indexOf('--cd') + 1] === result.fixtureRoot
      : i.argv[i.argv.indexOf('--permission-mode') + 1] === 'plan')),
    consumedJitGrants: artifacts.unconsumedGrants.length === 0 && entries.every(([, entry]) => entry.messageDispatched === true),
    separateProbes: ['codex', 'claude'].every(identity => artifacts.invocations.filter(i => i.identity === identity && i.invocationType === 'probe').length >= 3),
    originalTestsUnchanged: before['test/add.test.mjs'] === after['test/add.test.mjs'],
    markerUnchanged: before['.goalport-offline-fixture.json'] === after['.goalport-offline-fixture.json'],
    noTransientSavedScope: records.every(r => !('authorizedTurnsLeft' in r) && !('authorizedWriteTurnsLeft' in r)),
    allNativeShots: result.screenshots.length >= expectedStates.length * 3 && expectedStates.every(state => WIDTHS.every(width => result.screenshots.some(s => s.state === state && s.viewport.width === width && s.pngWidth === width && s.pngHeight === 900 && s.bytes > 10000 && !s.geometry.horizontalOverflow && (width !== 860 || !s.geometry.drawerOpen)))),
    flawedPlanCompletesHonestly: flawedPlan?.evidence.sourceSha256 === before['src/add.mjs'] && flawedPlan?.evidence.changed === false && flawedPlan?.report === EXECUTION_FIXTURE_FLAWED_PLAN && flawedPlan?.evidence.missingRequirement === 'negative-case-coverage-and-named-checks' && flawedPlan?.exitCode === 0,
    critiqueIsSeparateCompletedProcess: planCritique?.verdict === 'revise' && planCritique?.evidence.cliTurnCompleted === true && planCritique?.evidence.checker?.checkerKind === 'separate-read-only-node-process' && planCritique?.evidence.negativeCasePresent === true && planCritique?.evidence.observedRequirement === true && planCritique?.evidence.checker?.pid !== planCritique?.evidence.parentPid && planCritique?.evidence.checker?.noIndependentModelClaim === true && planCritique?.evidence.testSha256 === before['test/add.test.mjs'],
    oneAuthorizationPerSend: true,
  };
  if (id === 'pr1' || id === 'pr4') {
    const revisedPlan = op('revised-plan');
    const writer = op('writer');
    const auditor = op('auditor');
    const revisionIds = record?.planRevisionHistory?.[0]?.commandIds ?? [];
    return {
      ...shared,
      freshRoleFamilies: ['plan', 'review'].every(role => entries.filter(([commandId]) => commandId.startsWith(`coordinate-${role}-`)).length === 2) && entries.filter(([commandId]) => commandId.startsWith('coordinate-execute-')).length === 1 && entries.filter(([commandId]) => commandId.startsWith('coordinate-audit-')).length === 1,
      independentPairsPerPass: [0, 2, 4].every(offset => turns[offset].identity !== turns[offset + 1].identity),
      oneWriteTurnOnly: turns.filter(t => t.behaviorId === 'codex-fixture-writer').length === 1,
      scopeDualCounters: result.finalScope?.remaining === 0 && result.finalScope?.maxTurns === 5 && result.finalScope?.write?.remaining === 0 && result.finalScope?.write?.maxTurns === 1 && result.finalScope?.write?.workspaceRoot === result.fixtureRoot,
      retainedRejectedPassFacts: records.length === 1 && record?.planRevisionHistory?.length === 1 && record?.planRevisionHistory?.[0]?.verdict === 'revise' && record?.planRevisionHistory?.[0]?.reviewText?.endsWith('VERDICT: revise') && record?.planRevisionHistory?.[0]?.executionText === null && record?.planRevisionHistory?.[0]?.executionHarness === null && revisionIds.length === 2 && revisionIds.every(commandId => entries.some(([key]) => key === commandId)) && !Object.hasOwn(record, 'feedbackHistory'),
      honestVerifiedRecord: record?.verdict === 'verified' && record?.messageDispatched === true && record?.auditText?.endsWith('VERDICT: verified') && record?.executionHarness === 'Codex' && record?.auditHarness === 'Claude',
      revisedPlanAnsweredBeforeAnyWriter: revisedPlan?.evidence.sourceSha256 === before['src/add.mjs'] && revisedPlan?.evidence.changed === false && revisedPlan?.report === EXECUTION_FIXTURE_REVISED_PLAN && revisedPlan?.evidence.answersCritique === 'negative-case-coverage-and-named-checks' && turns.findIndex(t => t.behaviorId === 'codex-fixture-writer') > turns.findIndex(t => t.behaviorId === 'codex-fixture-revised-plan-delayed'),
      actualRepairAndPassingUnchangedChecks: writer?.status === 'completed' && writer?.verified === false && writer?.evidence.edit?.actualFileChanged === true && writer?.evidence.checks?.testsPassed === true && writer?.evidence.testBytesUnchanged === true && after['src/add.mjs'] === writer?.evidence.edit?.afterSha256,
      secondCheckerSeparateAndVerified: auditor?.verified === true && auditor?.evidence.auditor?.auditorKind === 'separate-read-only-node-process' && auditor?.evidence.auditor?.noIndependentModelClaim === true && auditor?.evidence.auditorProcess?.exitCode === 0 && auditor?.evidence.auditor?.pid !== writer?.evidence.parentPid && auditor?.evidence.auditor?.pid !== planCritique?.evidence.checker?.pid && auditor?.evidence.auditor?.testsPassed === true && auditor?.evidence.auditor?.originalTests?.matchesPinnedBytes === true,
      domShowsBothPasses: result.screenshots.filter(s => s.state === 'verified').every(s => s.geometry.text.includes('Changes verified') && s.geometry.text.includes('Before plan revision') && s.geometry.text.includes('wrote one revised plan')) && result.screenshots.filter(s => s.state === 'revision-progress').every(s => s.geometry.text.includes(PLAN_REVISION_PROGRESS_SNIPPET)),
      consentExplainsBothContinuations: result.screenshots.filter(s => s.state === 'write-consent' || s.state === 'consent').every(s => s.geometry.text.includes('rejects the plan itself') && s.geometry.text.includes('write one revised plan') && s.geometry.text.includes('finds unfinished work')),
    };
  }
  if (id === 'pr2') {
    const turnCountAfterSettle = result.settledInvocations?.filter(i => i.invocationType === 'turn').length;
    return {
      ...shared,
      roleFamilyOnce: entries.every(([commandId]) => commandId.startsWith('coordinate-plan-') || commandId.startsWith('coordinate-review-')),
      scopeDualCounters: result.finalScope?.remaining === 2 && result.finalScope?.maxTurns === 4 && result.finalScope?.write?.remaining === 1 && result.finalScope?.write?.maxTurns === 1,
      budgetStopWithoutRevision: records.length === 1 && record?.verdict === 'revise' && record?.messageDispatched === true && record?.stopReason?.includes(PLAN_BUDGET_STOP_SNIPPET) && record?.stopReason?.includes('GoalPort did not add turns') && !Object.hasOwn(record, 'planRevisionHistory') && turnCountAfterSettle === scenario.totalTurns,
      fixtureBytesUnchanged: after['src/add.mjs'] === before['src/add.mjs'] && operations.length === 2,
      noVerifiedClaim: result.screenshots.filter(s => s.state === 'budget-stop').every(s => !s.geometry.text.includes('Changes verified') && s.geometry.text.includes(PLAN_BUDGET_STOP_SNIPPET) && s.geometry.text.includes('2 of 4 authorized model turns left')),
      noRevisionTurnsLaunched: !operations.some(o => o.operation === 'revised-plan' || o.operation === 'writer') && turns.length === 2,
      domShowsCritique: result.screenshots.filter(s => s.state === 'budget-stop').every(s => s.geometry.text.includes('Needs revision') && s.geometry.text.includes('VERDICT: revise')),
    };
  }
  // pr3: the revised reviewer again requests revision; four read turns, zero
  // writes, no third planning pass, and the rejected pass stays retained.
  const turnCountAfterSettle = result.settledInvocations?.filter(i => i.invocationType === 'turn').length;
  return {
    ...shared,
    zeroWrites: turns.every(t => t.behaviorId !== 'codex-fixture-writer') && entries.every(([commandId]) => !commandId.startsWith('coordinate-execute-') && !commandId.startsWith('coordinate-audit-')),
    scopeDualCounters: result.finalScope?.remaining === 1 && result.finalScope?.maxTurns === 5 && result.finalScope?.write?.remaining === 1 && result.finalScope?.write?.maxTurns === 1,
    secondRejectionTerminal: records.length === 1 && record?.verdict === 'revise' && record?.messageDispatched === true && record?.stopReason?.includes(PLAN_REVISION_CEILING_SNIPPET) && record?.planRevisionHistory?.length === 1 && record?.planRevisionHistory?.[0]?.reviewText?.endsWith('VERDICT: revise') && turnCountAfterSettle === scenario.totalTurns,
    fixtureBytesUnchanged: after['src/add.mjs'] === before['src/add.mjs'] && !operations.some(o => o.operation === 'writer'),
    noThirdPlanningPass: !operations.some(o => o.operation === 'corrective-plan') && turns.filter(t => t.behaviorId === 'codex-fixture-flawed-plan').length === 1 && turns.filter(t => t.behaviorId === 'codex-fixture-revised-plan-delayed').length === 1,
    domShowsSecondRejection: result.screenshots.filter(s => s.state === 'second-rejection').every(s => s.geometry.text.includes('Needs revision') && s.geometry.text.includes(PLAN_REVISION_CEILING_SNIPPET) && s.geometry.text.includes('Before plan revision') && !s.geometry.text.includes('Changes verified')),
  };
}

async function openDraft(app) {
  await app.click('button[aria-label="New goal"]');
  await app.until('!!document.querySelector(\'input[aria-label="Select Codex"]:not(:disabled)\') && !!document.querySelector(\'input[aria-label="Select Claude"]:not(:disabled)\') && !!document.querySelector(\'input[aria-label="Keep working after closing"]\')');
}

async function consentAndSend(app, fixture, scenario, hooks = {}) {
  if (!hooks.draftAlreadyOpen) await openDraft(app);
  await app.input('#draft-workspace', fixture.root);
  await app.input('#draft-message', PLAN_REVISION_GOAL);
  for (const name of ['Codex', 'Claude']) {
    const selector = `input[aria-label="Select ${name}"]`;
    if (!await app.evaluate(`document.querySelector(${JSON.stringify(selector)}).checked`)) await app.click(selector);
  }
  await app.input('#authorization-turns', String(scenario.readTurns));
  if (hooks.beforeWriteConsent) await hooks.beforeWriteConsent();
  for (const name of ['Codex', 'Claude']) await app.click(`input[aria-label="Allow changes through ${name}"]`);
  await app.input('#authorization-write-turns', String(scenario.writeTurns));
  if (scenario.background) await app.click('input[aria-label="Keep working after closing"]');
}

export async function runPlanRevisionScenario(id, app, caseRoot, fixture, result) {
  const scenario = PLAN_REVISION_SCENARIOS[id];
  const check = (name, value) => { result.assertions[name] = Boolean(value); if (!value) throw Error(`${id} assertion failed: ${name}`); };
  result.screenshots = []; result.walkthrough = []; result.scopes = {};
  await app.until("window.goalportCore && window.goalportCore.bootstrapCurrent().then(s => s.phase === 'done')", 30000);
  result.coreSnapshot = await app.evaluate('window.goalportCore.snapshot()', true);
  check('realCoreConnected', result.coreSnapshot.connection === 'connected' && result.coreSnapshot.protocolVersion === 'goalport.ipc.v2');
  result.scopes.before = await app.evaluate('window.goalportCore.coordinationScope()', true);
  check('noSeededScope', result.scopes.before === null);
  check('noSeededLedgerOrHistory', collectArtifacts(caseRoot).records.length === 0 && Object.keys(collectArtifacts(caseRoot).ledger).length === 0);
  result.walkthrough.push('First launch: actual Electron main/preload, built renderer and connected Core; no seeded authorization, ledger or history.');
  await consentAndSend(app, fixture, scenario, {
    beforeWriteConsent: async () => {
      check('writeDefaultOff', await app.evaluate('Array.from(document.querySelectorAll(".authorization-write-section input[type=checkbox]")).every(e => !e.checked)'));
    },
  });
  check('revisionExplainedBeforeSend', await app.evaluate(`document.body.innerText.includes('rejects the plan itself') && document.body.innerText.includes('write one revised plan')`));
  await shots(app, caseRoot, result, 'write-consent');
  result.walkthrough.push(`New goal/workspace/goal/read selection/read budget ${scenario.readTurns}: ordinary DOM input. Workspace changes explicitly selected for both harnesses, budget ${scenario.writeTurns}, background ${scenario.background ? 'ON through its own explicit consent' : 'off'}, and the panel explains both the one plan revision and the one later repair.`);
  await app.resize(1020);
  await app.click('button[aria-label="Send message"]');
  result.sendClicks = 1;
  // The separate read-only plan critique is really in flight on Claude.
  await app.until("document.body.innerText.includes('Claude is checking')", 30000);
  result.scopes.critique = await app.evaluate('window.goalportCore.coordinationScope()', true);
  await shots(app, caseRoot, result, 'critique');
  result.walkthrough.push('Send: one authorization, one Send. The genuinely flawed first plan (Codex) is critiqued by a separate read-only checker process (Claude) that actually read the unchanged pinned tests and named the missing negative-case requirement.');
  if (id === 'pr2') {
    await app.until(`document.body.innerText.includes(${JSON.stringify(PLAN_BUDGET_STOP_SNIPPET)}) && !document.querySelector('.coordination-progress')`, 90000);
    await app.until("document.body.innerText.includes('2 of 4 authorized model turns left')", 10000);
    result.finalScope = await app.evaluate('window.goalportCore.coordinationScope()', true);
    await shots(app, caseRoot, result, 'budget-stop');
    result.walkthrough.push('The critique revises the plan, but only two of four read turns remain: GoalPort explains the revised chain needs three model turns and one write turn, did not add turns, and launched no third turn. The fixture bytes stay untouched.');
    await new Promise(resolve => setTimeout(resolve, 3000));
    result.settledInvocations = collectArtifacts(caseRoot).invocations;
  } else {
    // The one revised chain starts in the same Send, without a new authorization.
    await app.until(`document.body.innerText.includes(${JSON.stringify(PLAN_REVISION_PROGRESS_SNIPPET)})`, 60000);
    result.scopes.revisionProgress = await app.evaluate('window.goalportCore.coordinationScope()', true);
    check('revisionUsesSameGeneration', result.scopes.revisionProgress !== null
      && result.scopes.revisionProgress?.generation === result.scopes.critique?.generation
      && result.scopes.revisionProgress?.remaining <= 3 && result.scopes.revisionProgress?.remaining >= 2
      && result.scopes.revisionProgress?.write?.remaining === 1
      && result.scopes.revisionProgress?.instances?.join() === result.scopes.critique?.instances?.join());
    await shots(app, caseRoot, result, 'revision-progress');
    result.walkthrough.push('The completed critique ends VERDICT: revise, so GoalPort writes one revised plan and has it checked again in the same window: the progress line says so, the same scope generation pays for it, and no new authorization happens.');
    if (id === 'pr3') {
      await app.until(`document.body.innerText.includes(${JSON.stringify(PLAN_REVISION_CEILING_SNIPPET)}) && !document.querySelector('.coordination-progress')`, 90000);
      await app.until("document.body.innerText.includes('1 of 5 authorized model turns left')", 10000);
      result.finalScope = await app.evaluate('window.goalportCore.coordinationScope()', true);
      await shots(app, caseRoot, result, 'second-rejection');
      result.walkthrough.push('The revised plan is checked again and the reviewer still says revise: exactly four read turns ran, no writer launched, and the send stops at its one-revision ceiling with the rejected pass folded under Before plan revision.');
      await new Promise(resolve => setTimeout(resolve, 3000));
      result.settledInvocations = collectArtifacts(caseRoot).invocations;
    } else {
      await app.until("document.body.innerText.includes('Changes verified') && !document.querySelector('.coordination-progress')", 90000);
      await app.until("document.body.innerText.includes('0 of 5 authorized model turns left')", 10000);
      result.finalScope = await app.evaluate('window.goalportCore.coordinationScope()', true);
      await shots(app, caseRoot, result, 'verified');
      result.walkthrough.push('The revised plan answers the critique, a fresh independent check approves it, only then does the real writer repair the pinned source, and a second separate read-only checker reruns the unchanged tests and verifies. Both budgets reach zero; the record keeps the rejected pass folded under Before plan revision.');
    }
  }
  result.after = snapshotFixture(fixture, caseRoot, 'after');
  result.artifacts = collectArtifacts(caseRoot);
  result.operations = readLines(path.join(caseRoot, 'stub-bin/execution-operations.jsonl'));
  for (const [name, value] of Object.entries(planRevisionAssertions(id, result))) check(name, value);
  // Actual first-user CLOSE, never an injected close/save/authorize hook.
  await app.click('button[aria-label="Application menu"]');
  await app.until('!!document.querySelector(\'[role="menu"] [aria-label="Close window"]\')');
  try {
    await app.click('[role="menu"] [aria-label="Close window"]');
  } catch (error) {
    if (error.message !== 'CDP WebSocket closed') throw error;
    result.domCloseReceipt = error.message;
  }
  result.domCloseClicked = true;
  result.walkthrough.push('Application menu → Close window clicked through CDP mouse hit testing; not native OS keyboard/mouse.');
}

/**
 * PR1 phase two: relaunch against the same durable records/ledger/queues.
 * Reopening restores evidence only — null scope, no live controls, no
 * authority, and the retained rejected pass stays readable as facts.
 */
export async function runPlanRevisionReopen(app, caseRoot, result) {
  const check = (name, value) => { result.assertions[`reopen.${name}`] = Boolean(value); if (!value) throw Error(`pr1 reopen assertion failed: ${name}`); };
  const turnsBefore = result.artifacts.invocations.filter(i => i.invocationType === 'turn').length;
  await app.until("window.goalportCore && window.goalportCore.bootstrapCurrent().then(s => s.phase === 'done')", 30000);
  const snapshot = await app.evaluate('window.goalportCore.snapshot()', true);
  check('coreConnectedV2', snapshot.connection === 'connected' && snapshot.protocolVersion === 'goalport.ipc.v2');
  await app.until("document.body.innerText.includes('Changes verified') && document.body.innerText.includes('Before plan revision')", 30000);
  check('recordSurvivedClose', true);
  const reopenedScope = await app.evaluate('window.goalportCore.coordinationScope()', true);
  check('scopeNullAfterReopen', reopenedScope === null);
  check('noLiveControls', await app.evaluate('!document.querySelector(".coordination-access") && !document.querySelector(".coordination-budget")'));
  await app.click('details.coordination-retained-round > summary');
  await app.until("document.body.innerText.includes('Completed plan critique from a separate read-only Node checker process')", 10000);
  check('rejectedPassReportsReadable', true);
  await shots(app, caseRoot, result, 'reopened-history');
  result.walkthrough.push('Relaunch with a fresh process, socket and temp against the same durable records and ledger: the verified goal reopens with both passes, the rejected plan folded under Before plan revision, no live scope and no access controls.');
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
  await app.click('button[aria-label="Application menu"]');
  await app.until('!!document.querySelector(\'[role="menu"] [aria-label="Close window"]\')');
  try {
    await app.click('[role="menu"] [aria-label="Close window"]');
  } catch (error) {
    if (error.message !== 'CDP WebSocket closed') throw error;
    result.domCloseReceipt = error.message;
  }
  result.domCloseClicked = true;
  result.walkthrough.push('Application menu → Close window clicked through CDP mouse hit testing; not native OS keyboard/mouse.');
}

/**
 * PR4: the explicitly admitted background job. The desktop closes while the
 * initial plan critique is still in flight — before the revised planner
 * launched — and the same worker continues the revision, repair and
 * verification on its own; returning shows the retained result without
 * another Send or authorization.
 */
export async function runPlanRevisionBackground(app, root, fixture, scenario, result) {
  const check = (name, value) => { result.assertions[name] = Boolean(value); if (!value) throw Error(`pr4 assertion failed: ${name}`); };
  result.screenshots = []; result.walkthrough = []; result.scopes = {};
  await app.until("window.goalportCore && window.goalportCore.bootstrapCurrent().then(s => s.phase === 'done')", 30000);
  result.coreSnapshot = await app.evaluate('window.goalportCore.snapshot()', true);
  check('realCoreConnected', result.coreSnapshot.connection === 'connected' && result.coreSnapshot.protocolVersion === 'goalport.ipc.v2');
  await openDraft(app);
  result.freshDefaults = await app.evaluate(`({ backgroundOff: !document.querySelector('input[aria-label="Keep working after closing"]').checked, writeOff: Array.from(document.querySelectorAll('.authorization-write-section input[type=checkbox]')).every(e => !e.checked), reads: document.querySelector('#authorization-turns').value })`, true);
  check('freshConsentsDefaultOff', result.freshDefaults.backgroundOff && result.freshDefaults.writeOff && result.freshDefaults.reads === '4');
  await consentAndSend(app, fixture, scenario, { draftAlreadyOpen: true });
  await backgroundShots(app, root, result, 'consent');
  await app.resize(1020);
  await app.click('button[aria-label="Send message"]');
  result.sendClicks = 1;
  // Wait until the initial critique (turn 2) is admitted and in flight: the
  // revised planner has NOT launched yet at this moment.
  await app.until("window.goalportCore.backgroundStatus().then(j => j?.live && j.pendingCommand?.commandId.startsWith('coordinate-review-'))", 30000);
  result.beforeClose = await app.evaluate('window.goalportCore.backgroundStatus()', true);
  result.mainScopeBeforeClose = await app.evaluate('window.goalportCore.coordinationScope()', true);
  check('mainScopeStaysNull', result.mainScopeBeforeClose === null);
  result.walkthrough.push('One explicit background admission: background and write consents are separate decisions, five read turns and one write turn, one Send. The desktop main scope stays null; the job owns its scope.');
  return check;
}

export { closeThroughMenu, observeOwnedRenderers, retainJobFacts };
