import fs from 'node:fs';
import path from 'node:path';
import { FEEDBACK_SCENARIOS, WIDTHS, hash } from './feedback-scenarios.mjs';
import { collectArtifacts } from './scenarios.mjs';
export const BACKGROUND_SCENARIOS = Object.freeze(Object.fromEntries(['BG1', 'BG2', 'BG3'].map(id => [id, {
  preset: 'c1-feedback-repair', behavior: { probes: FEEDBACK_SCENARIOS.c1.behavior.probes,
    turns: { codex: [...FEEDBACK_SCENARIOS.c1.behavior.turns.codex], claude: ['claude-carry-out-delayed', ...FEEDBACK_SCENARIOS.c1.behavior.turns.claude.slice(1)] } },
}])));

export function observeOwnedRenderers(electronPid) {
  const identities = fs.readdirSync('/proc').filter(n => /^\d+$/.test(n)).flatMap(n => {
    try {
      const stat = fs.readFileSync(`/proc/${n}/stat`, 'utf8').split(') ')[1].split(' ');
      const argv = fs.readFileSync(`/proc/${n}/cmdline`, 'utf8').split('\0');
      if (!argv.some(arg => /(?:^|\s)--type=renderer(?:\s|$)/.test(arg))) return [];
      let parent = Number(stat[1]);
      const seen = new Set();
      while (parent > 1 && !seen.has(parent)) {
        if (parent === electronPid) return [{ pid: Number(n), startTicks: stat[19] }];
        seen.add(parent);
        parent = Number(fs.readFileSync(`/proc/${parent}/stat`, 'utf8').split(') ')[1].split(' ')[1]);
      }
      return [];
    } catch { return []; }
  });
  if (!identities.length) throw Error('No acceptance-owned renderer identity observed');
  let endedAt = null;
  const timer = setInterval(() => {
    if (endedAt) return;
    const allEnded = identities.every(identity => {
      try {
        const stat = fs.readFileSync(`/proc/${identity.pid}/stat`, 'utf8').split(') ')[1].split(' ');
        return stat[19] !== identity.startTicks || stat[0] === 'Z';
      } catch (error) { return error.code === 'ENOENT'; }
    });
    if (allEnded) endedAt = new Date().toISOString();
  }, 20);
  return () => { clearInterval(timer); return { identities, endedAt }; };
}

export async function shots(app, root, result, state) {
  for (const width of WIDTHS) {
    const shot = await app.screenshot(root, `${state}-${width}`, width);
    const jobGeometry = await app.evaluate(`(() => { const e = document.querySelector('[aria-label="Background job progress"]'); return e ? { horizontalOverflow: e.scrollWidth > e.clientWidth + 1 } : { horizontalOverflow: false }; })()`);
    result.screenshots.push({ ...shot, jobGeometry, state });
  }
}
export async function closeThroughMenu(app) {
  await app.click('button[aria-label="Application menu"]');
  await app.until('!!document.querySelector(\'[role="menu"] [aria-label="Close window"]\')');
  try { await app.click('[role="menu"] [aria-label="Close window"]'); }
  catch (error) { if (error.message !== 'CDP WebSocket closed' && error.message !== 'CDP command timed out: Input.dispatchMouseEvent') throw error; }
}
export async function prepareBackground(app, fixture, root, result) {
  await app.until("window.goalportCore && window.goalportCore.bootstrapCurrent().then(s => s.phase === 'done')", 30000);
  result.coreSnapshot = await app.evaluate('window.goalportCore.snapshot()', true);
  await app.click('button[aria-label="New goal"]');
  await app.until('!!document.querySelector(\'input[aria-label="Select Codex"]:not(:disabled)\')');
  await app.input('#draft-workspace', fixture.root);
  await app.input('#draft-message', 'Repair add(a,b) in this disposable offline fixture and check the unchanged original tests.');
  result.freshDefaults = await app.evaluate(`({ backgroundOff: !document.querySelector('input[aria-label="Keep working after closing"]').checked, writeOff: Array.from(document.querySelectorAll('.authorization-write-section input[type=checkbox]')).every(e => !e.checked), reads: document.querySelector('#authorization-turns').value })`);
  for (const name of ['Codex', 'Claude']) {
    const selector = `input[aria-label="Select ${name}"]`;
    if (!await app.evaluate(`document.querySelector(${JSON.stringify(selector)}).checked`)) await app.click(selector);
    await app.click(`input[aria-label="Allow changes through ${name}"]`);
  }
  await app.input('#authorization-turns', '6');
  await app.click('input[aria-label="Keep working after closing"]');
  await shots(app, root, result, 'consent');
  await app.resize(1020);
  await app.click('button[aria-label="Send message"]');
  result.sendClicks = 1;
  await app.until("window.goalportCore.backgroundStatus().then(j => j?.live && j.pendingCommand?.commandId.startsWith('coordinate-review-'))", 30000);
  result.beforeClose = await app.evaluate('window.goalportCore.backgroundStatus()', true);
  result.mainScopeBeforeClose = await app.evaluate('window.goalportCore.coordinationScope()', true);
  result.walkthrough.push('Fresh goal: background OFF and writes OFF; independently select both consents and six read/two write turns. One Send starts one independent owner; the main scope stays null.');
}
export function backgroundAssertions(id, r) {
  const a = r.artifactsFinal;
  const turns = a.invocations.filter(i => i.invocationType === 'turn');
  const ids = Object.keys(a.ledger);
  const before = Object.fromEntries(r.before.files.map(f => [f.relative, f.sha256]));
  const after = Object.fromEntries(r.after.files.map(f => [f.relative, f.sha256]));
  const common = {
    explicitFreshConsents: r.freshDefaults.backgroundOff && r.freshDefaults.writeOff && r.freshDefaults.reads === '4',
    oneSendOneOwner: r.sendClicks === 1 && r.beforeClose.jobId === r.returned.jobId && r.beforeClose.workerPid === r.returned.workerPid && r.mainScopeBeforeClose === null && r.returnedMainScope === null && r.admissions.length === 1 && r.claims.length === 1,
    actualNormalDesktopExit: !!r.rendererExit?.endedAt && r.close.electronExit.code === 0 && !r.close.electronExit.signal && !r.close.forcedElectron && r.close.tempRetained && r.close.corePids.length === 1 && r.launch.pid !== r.reopen.pid,
    noSentinelEscape: a.invocations.every(i => !['sentinel-refused', 'turn-queue-exhausted'].includes(i.behaviorId)),
    noReplay: new Set(ids).size === ids.length && (id === 'BG3' ? a.claims.length >= ids.length : a.claims.length === ids.length) && ids.every(commandId => a.claims.includes(`claim-${commandId}`)),
    originalTestsUnchanged: before['test/add.test.mjs'] === after['test/add.test.mjs'],
    markerUnchanged: before['.goalport-offline-fixture.json'] === after['.goalport-offline-fixture.json'],
    actualNativeWidths: ['consent', id === 'BG3' ? 'interrupted' : 'live-return', id === 'BG1' ? 'verified' : id === 'BG2' ? 'revoked' : 'interrupted'].every(state => WIDTHS.every(width => r.screenshots.some(s => s.state === state && s.viewport.width === width && s.pngWidth === width && s.pngHeight === 900 && !s.geometry.horizontalOverflow && !s.jobGeometry?.horizontalOverflow))),
    jobFactsRetained: !!r.finalJob && r.finalJob.requestId === r.beforeClose.requestId,
    historyPermissionFree: a.records.every(record => !('authorizedTurnsLeft' in record) && !('authorizedWriteTurnsLeft' in record)),
  };
  if (id === 'BG1') return { ...common,
    writerAfterDesktopExit: turns.filter(t => t.behaviorId.includes('writer')).length === 2 && turns.filter(t => t.behaviorId.includes('writer')).every(t => Date.parse(t.ts) > Math.max(Date.parse(r.close.electronExit.observedAt), Date.parse(r.rendererExit.endedAt))),
    sameLiveOwnerOnReturn: r.returned.live === true && r.returned.active === true,
    boundedTwoChains: turns.length === 8 && ids.length === 8 && r.finalJob.counters.readTurnsLeft === 0 && r.finalJob.counters.writeTurnsLeft === 0,
    failedThenPassingUnchangedChecks: r.operations.some(o => o.operation === 'critique-checker' && o.evidence.observedFailure === true) && r.operations.some(o => o.operation === 'auditor' && o.verified === true),
    firstPassPreserved: a.records[0]?.verdict === 'verified' && a.records[0]?.feedbackHistory?.length === 1 && a.records[0].feedbackHistory[0].auditText.includes('VERDICT: revise'),
    completedReleased: r.finalJob.state === 'completed' && !r.finalJob.active,
  };
  if (id === 'BG2') return { ...common,
    sameLiveOwnerOnReturn: r.returned.live === true,
    revokedNoLaterWriter: r.revoked.revoked === true && r.finalJob.revoked === true && r.finalJob.state === 'stopped' && turns.filter(t => t.behaviorId.includes('writer')).length === 1 && turns.length === r.expectedSettledTurns && r.settledTurnCount === turns.length,
    retainedCurrentTurn: r.finalJob.completedCommands.length === turns.length && a.records[0]?.messageDispatched === true,
    noBudgetReplacement: r.finalJob.readMaxTurns === 6 && r.finalJob.writeMaxTurns === 2 && r.finalJob.counters.writeTurnsLeft === 1,
  };
  return { ...common,
    interruptedHonest: r.returned.live === false && r.returned.state === 'unconfirmed' && r.finalJob.active && r.finalJob.pendingCommand?.commandId === r.beforeClose.pendingCommand.commandId,
    noReplacementOrReplay: r.settledTurnCount === turns.length && r.finalJob.workerPid === r.beforeClose.workerPid && r.claims.length === 1,
    startupClaimAndTurnClaimRetained: a.claims.includes(`claim-${r.finalJob.pendingCommand?.commandId}`),
  };
}
export function retainJobFacts(root, result) {
  const store = path.join(root, 'electron-userData/coordination-jobs');
  const jobs = fs.readdirSync(path.join(store, 'jobs'));
  result.admissions = jobs.map(id => JSON.parse(fs.readFileSync(path.join(store, 'jobs', id, 'admission.json'))));
  result.claims = jobs.map(id => JSON.parse(fs.readFileSync(path.join(store, 'jobs', id, 'startup-claim.json')))).map(({ ownerToken, ...facts }) => facts);
  // Keep exact durable command/progress/admission bytes but not control secrets.
  const target = path.join(root, 'retained-jobs'); fs.mkdirSync(target);
  for (const id of jobs) {
    fs.mkdirSync(path.join(target, id));
    for (const leaf of ['admission.json', 'progress.json']) fs.copyFileSync(path.join(store, 'jobs', id, leaf), path.join(target, id, leaf));
    fs.writeFileSync(path.join(target, id, 'startup-claim.json'), JSON.stringify(result.claims[jobs.indexOf(id)], null, 2));
  }
}
export function validateBackgroundReport(report) {
  if (report.kind !== 'c2-real-app-offline-background' || report.status !== 'ready') throw Error('Background acceptance is blocked');
  for (const id of Object.keys(BACKGROUND_SCENARIOS)) {
    const r = report.scenarios[id];
    if (!r || Object.values(backgroundAssertions(id, r)).some(v => v !== true)) throw Error(`Incomplete ${id} evidence`);
    if (!r.cleanup.coreStopped || !r.cleanup.socketAbsent || r.cleanup.forcedElectron || r.cleanup.electronExit.code !== 0 || !r.cleanup.ownedTempRemoved) throw Error(`Incomplete ${id} cleanup`);
    for (const shot of r.screenshots) if (hash(fs.readFileSync(shot.path)) !== shot.sha256) throw Error('Screenshot changed');
  }
}
