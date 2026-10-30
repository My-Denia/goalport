import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { collectArtifacts } from './scenarios.mjs';
import { EXECUTION_FIXTURE_REPAIRED_SOURCE, EXECUTION_FIXTURE_PARTIAL_SOURCE } from './execution-fixture.mjs';

export const WIDTHS = Object.freeze([860, 1020, 1440]);
const probes = Object.freeze({ codex: 'codex-probe-authenticated', claude: 'claude-probe-authenticated' });
// The peer component's presets are direct-operation fixtures, not app rounds.
// App rounds MUST have an independent REVIEW before execution or a no-write stop.
export const EXECUTION_SCENARIOS = Object.freeze({
  b1: Object.freeze({ preset: 'b1-full-chain', write: true, turns: 4,
    behavior: { probes, turns: { codex: ['codex-fixture-plan', 'codex-fixture-writer-delayed'], claude: ['claude-carry-out', 'claude-fixture-auditor-delayed'] } },
    terminal: 'Changes verified', states: ['write-consent', 'making-changes', 'verifying', 'verified'] }),
  b2: Object.freeze({ preset: 'b2-no-write', write: false, turns: 2,
    behavior: { probes, turns: { codex: ['codex-fixture-plan'], claude: ['claude-carry-out'] } },
    terminal: 'The plan passed its check. No harness is allowed to change files, so this stopped here.', states: ['read-only-consent', 'no-write'] }),
  b3: Object.freeze({ preset: 'b3-partial-failure', write: true, turns: 3,
    behavior: { probes, turns: { codex: ['codex-fixture-plan', 'codex-fixture-partial-writer-delayed'], claude: ['claude-carry-out'] } },
    terminal: 'Partial edit retained', states: ['write-consent', 'partial-failure'] }),
});
export const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export const readLines = filename => fs.existsSync(filename) ? fs.readFileSync(filename, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) : [];
export function snapshotFixture(fixture, caseRoot, name) {
  const out = path.join(caseRoot, `fixture-${name}`);
  fs.mkdirSync(out);
  const files = [fixture.markerPath, fixture.sourcePath, fixture.testPath].map(source => {
    const relative = path.relative(fixture.root, source).split(path.sep).join("/");
    const retained = path.join(out, relative);
    fs.mkdirSync(path.dirname(retained), { recursive: true });
    fs.copyFileSync(source, retained, fs.constants.COPYFILE_EXCL);
    return { source, retained, relative, sha256: hash(fs.readFileSync(retained)), bytes: fs.statSync(retained).size };
  });
  return { root: fixture.root, files };
}
export function baselineChecks(fixture, caseRoot) {
  const command = [process.execPath, '--test', 'test/add.test.mjs'];
  const ran = spawnSync(command[0], command.slice(1), { cwd: fixture.root, env: { PATH: '/usr/bin:/bin', HOME: fixture.root, TMPDIR: path.dirname(fixture.root) }, encoding: 'utf8', timeout: 15000, maxBuffer: 100000, shell: false });
  const result = { command, cwd: fixture.root, exitCode: ran.status, signal: ran.signal, error: ran.error?.message ?? null, stdout: ran.stdout, stderr: ran.stderr };
  fs.writeFileSync(path.join(caseRoot, 'baseline-check.json'), JSON.stringify(result, null, 2));
  if (ran.status !== 1 || !/ERR_ASSERTION|AssertionError/.test(ran.stdout + ran.stderr)) throw Error('Original fixture checks did not actually fail before Send');
  return result;
}
export function executionAssertions(id, result) {
  const scenario = EXECUTION_SCENARIOS[id];
  const a = result.artifacts;
  const turns = a.invocations.filter(i => i.invocationType === 'turn');
  const entries = Object.entries(a.ledger);
  const records = a.records;
  const record = records[0];
  const roles = id === 'b1' ? ['plan', 'review', 'execute', 'audit'] : id === 'b2' ? ['plan', 'review'] : ['plan', 'review', 'execute'];
  const operations = result.operations;
  const writer = operations.find(o => ['writer', 'partial-writer'].includes(o.operation));
  const auditor = operations.find(o => o.operation === 'auditor');
  const before = Object.fromEntries(result.before.files.map(f => [f.relative, f.sha256]));
  const after = Object.fromEntries(result.after.files.map(f => [f.relative, f.sha256]));
  return {
    exactlyExpectedTurnsAndClaims: turns.length === scenario.turns && entries.length === scenario.turns && a.claims.length === scenario.turns && entries.every(([id]) => a.claims.includes(`claim-${id}`)),
    exactRoleFamily: roles.every(role => entries.filter(([key]) => key.startsWith(`coordinate-${role}-`)).length === 1),
    noReplay: new Set(entries.map(([key]) => key)).size === scenario.turns && turns.every(i => i.consumesQueue === true) && turns.every((i, n) => i.identity === (n % 2 === 0 ? 'codex' : 'claude')),
    exactQueue: ['codex', 'claude'].every(identity => JSON.stringify(turns.filter(t => t.identity === identity).map(t => t.behaviorId)) === JSON.stringify(scenario.behavior.turns[identity])),
    sentinelAccepted: a.invocations.every(i => !['sentinel-refused', 'turn-queue-exhausted'].includes(i.behaviorId)),
    actualModeAndRoot: turns.every(i => i.cwd === result.fixtureRoot && (i.identity === 'codex' ? i.argv[i.argv.indexOf('--sandbox') + 1] === (i.fixtureOperation?.includes('writer') ? 'workspace-write' : 'read-only') && i.argv[i.argv.indexOf('--cd') + 1] === result.fixtureRoot : i.argv[i.argv.indexOf('--permission-mode') + 1] === 'plan')),
    consumedJitGrants: a.unconsumedGrants.length === 0 && entries.every(([,v]) => v.messageDispatched === true),
    separateProbes: ['codex', 'claude'].every(identity => a.invocations.filter(i => i.identity === identity && i.invocationType === 'probe').length >= 3),
    originalTestsUnchanged: before['test/add.test.mjs'] === after['test/add.test.mjs'],
    markerUnchanged: before['.goalport-offline-fixture.json'] === after['.goalport-offline-fixture.json'],
    scopeDualCounters: result.finalScope?.remaining === 6 - (id === 'b1' ? 3 : 2) && result.finalScope?.maxTurns === 6 && (id === 'b2' ? !('write' in result.finalScope) : result.finalScope?.write?.remaining === 1 && result.finalScope?.write?.maxTurns === 2 && result.finalScope?.write?.workspaceRoot === result.fixtureRoot),
    actualSavedIndependentPlanCheck: records.length === 1 && record?.planningHarness === 'Codex' && record?.reviewHarness === 'Claude' && record?.reviewText?.endsWith('VERDICT: carry-out') && record?.messageDispatched === true,
    honestResult: id === 'b1' ? record?.verdict === 'verified' && record?.executionHarness === 'Codex' && record?.auditHarness === 'Claude' && record?.auditText?.endsWith('VERDICT: verified') : id === 'b2' ? record?.verdict === 'checked' && record?.stopReason === 'The independent check finished, so this stopped.' && result.screenshots.filter(s => s.state === 'no-write').every(s => s.geometry.text.includes(scenario.terminal)) && !record?.executionText && !record?.auditText : record?.verdict === 'failed' && record?.executionText?.includes('Partial edit retained') && !record?.auditText && record?.stopReason?.includes('not retried'),
    actualFixtureResult: id === 'b2' ? before['src/add.mjs'] === after['src/add.mjs'] && operations.length === 1 : after['src/add.mjs'] === hash(id === 'b1' ? EXECUTION_FIXTURE_REPAIRED_SOURCE : EXECUTION_FIXTURE_PARTIAL_SOURCE) && writer?.evidence.baseline.command.exitCode === 1 && writer?.evidence.testBytesUnchanged === true && writer?.evidence.checks.command.exitCode === (id === 'b1' ? 0 : 1),
    auditOrHonestAbsence: id === 'b1' ? auditor?.verified === true && auditor?.evidence.auditorProcess.exitCode === 0 && auditor?.evidence.auditor.testCommand.exitCode === 0 && auditor?.evidence.auditor.pid !== writer?.evidence.parentPid && auditor?.evidence.auditor.pid !== auditor?.evidence.parentPid && auditor?.evidence.auditor.originalTests.matchesPinnedBytes === true : !auditor && !entries.some(([key]) => key.startsWith('coordinate-audit-')),
    noTransientSavedScope: records.every(r => !('authorizedTurnsLeft' in r) && !('authorizedWriteTurnsLeft' in r)),
    allNativeShots: result.screenshots.length === scenario.states.length * 3 && scenario.states.every(state => WIDTHS.every(width => result.screenshots.some(s => s.state === state && s.viewport.width === width && s.pngWidth === width && s.pngHeight === 900 && s.bytes > 10000 && !s.geometry.horizontalOverflow && (width !== 860 || !s.geometry.drawerOpen)))),
  };
}
async function shots(app, caseRoot, result, state) {
  for (const width of WIDTHS) result.screenshots.push(await app.screenshot(caseRoot, state, width));
}
export async function runExecutionScenario(id, app, caseRoot, fixture, result) {
  const scenario = EXECUTION_SCENARIOS[id];
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
  await app.input('#draft-message', 'Repair add(a,b) in this disposable offline fixture and check the unchanged original tests. Only explicitly permitted changes may be sent.');
  for (const name of ['Codex', 'Claude']) {
    const selector = `input[aria-label="Select ${name}"]`;
    if (!await app.evaluate(`document.querySelector(${JSON.stringify(selector)}).checked`)) await app.click(selector);
  }
  await app.input('#authorization-turns', '6');
  check('writeDefaultOff', await app.evaluate('Array.from(document.querySelectorAll(".authorization-write-section input[type=checkbox]")).every(e => !e.checked)'));
  if (scenario.write) {
    for (const name of ['Codex', 'Claude']) await app.click(`input[aria-label="Allow changes through ${name}"]`);
    await app.input('#authorization-write-turns', '2');
  }
  check('readAndWriteSeparate', await app.evaluate(`document.querySelector('#authorization-turns').value === '6' && Array.from(document.querySelectorAll('.authorization-write-section input[type=checkbox]')).every(e => e.checked === ${scenario.write})`));
  await shots(app, caseRoot, result, scenario.write ? 'write-consent' : 'read-only-consent');
  result.walkthrough.push(`New goal/workspace/goal/read selection/read budget6: ordinary DOM input. Separate root-bound workspace changes ${scenario.write ? 'explicitly selected for both harnesses, budget2' : 'left OFF; no write payload'}. Nothing launched before Send.`);
  await app.resize(1020);
  await app.click('button[aria-label="Send message"]');
  if (id === 'b1') {
    await app.until("document.body.innerText.includes('Codex is making changes')", 30000);
    result.scopes.makingChanges = await app.evaluate('window.goalportCore.coordinationScope()', true);
    await shots(app, caseRoot, result, 'making-changes');
    await app.until("document.body.innerText.includes('Claude is verifying')", 45000);
    result.scopes.verifying = await app.evaluate('window.goalportCore.coordinationScope()', true);
    await shots(app, caseRoot, result, 'verifying');
    result.walkthrough.push('Send: plan Codex, independent review Claude, actual writer Codex making changes, different read-only Claude auditor verifying; progress screenshots show the real in-flight launches, with fixed offline reply delays only.');
  }
  await app.until(`document.body.innerText.includes(${JSON.stringify(scenario.terminal)}) && !document.querySelector('.coordination-progress')`, 60000);
  await app.until(`document.body.innerText.includes('${id === 'b1' ? '3' : '4'} of 6 turns left')`, 10000);
  result.finalScope = await app.evaluate('window.goalportCore.coordinationScope()', true);
  await shots(app, caseRoot, result, id === 'b1' ? 'verified' : id === 'b2' ? 'no-write' : 'partial-failure');
  result.after = snapshotFixture(fixture, caseRoot, 'after');
  result.artifacts = collectArtifacts(caseRoot);
  result.operations = readLines(path.join(caseRoot, 'stub-bin/execution-operations.jsonl'));
  for (const [name, value] of Object.entries(executionAssertions(id, result))) check(name, value);
  result.walkthrough.push(`Result saved through the normal app path: ${id === 'b1' ? 'Changes verified; original tests pass and a separate read-only Node auditor reruns them. This is not model judgment.' : id === 'b2' ? 'Plan checked, no files changed and exactly two read-only turns.' : 'Failed with actual partial edit and unchanged failing tests; exactly three turns, no audit, takeover or retry.'}`);
  if (id === 'b1') {
    // Selecting the still-current record correctly retains live scope overlays.
    // End permission through the user control before testing historical facts.
    await app.click('button[aria-label="Stop allowing"]');
    await app.until('!document.querySelector(".coordination-budget")');
    result.scopes.afterRevoke = await app.evaluate('window.goalportCore.coordinationScope()', true);
    check('domRevokeClearsBothScopes', result.scopes.afterRevoke === null);
    if (await app.evaluate('!!document.querySelector(\'button[aria-label="Expand navigation"]\')')) await app.click('button[aria-label="Expand navigation"]');
    await app.click('button[aria-label^="Plan: "]');
    await app.until("document.body.innerText.includes('Changes verified') && !document.querySelector('.coordination-budget')");
    result.history = await app.evaluate(`({verified:document.body.innerText.includes('Changes verified'),execution:!!document.querySelector('article[aria-label="Workspace changes result"]'),audit:!!document.querySelector('article[aria-label="Independent verification result"]'),liveControls:!!document.querySelector('.coordination-access')})`);
    check('actualHistoryKeepsEvidenceNotPermissions', result.history.verified && result.history.execution && result.history.audit && !result.history.liveControls);
  }
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
