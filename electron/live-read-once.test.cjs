const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createCoordinationJobStore, requestControl } = require('./coordination-job.cjs');
const { runWorker } = require('./coordination-worker.cjs');
const { readRecords, saveRecord } = require('./coordination-record.cjs');
const codec = require('./live-read-once.cjs');
const engine = require('../dist/coordination-engine.cjs');
const pair = { provider: 'Fixture', model: 'alpha', useExistingCapacity: true };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function clock() {
 let mono = 0, wall = Date.parse('2026-01-01T00:00:00Z'), next = 0;
 const scheduled = new Map();
 return { nowMs: () => mono, wallNowMs: () => wall, schedule: (fn, ms) => { const id = ++next; scheduled.set(id, { fn, at: mono + ms }); return id; }, cancelScheduled: id => scheduled.delete(id),
  jumpWall(ms) { wall += ms; },
  advance(ms) { mono += ms; wall += ms; for (const [id, item] of [...scheduled]) if (item.at <= mono) { scheduled.delete(id); item.fn(); } }, scheduled };
}
function temp(t) { const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-live-unit-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true })); return directory; }
function admission(directory, requestId = 'initial') { return { requestId, goal: 'Explain the fixture boundary', workspacePath: directory, allowedInstances: ['codex', 'pi'], maxTurns: 4, piCapacity: pair, backgroundConsent: true }; }
async function fixture(t, options = {}) {
 const directory = temp(t), store = createCoordinationJobStore(directory, { bootstrapReady: true });
 if(options.seedOld) for(let n=0;n<11;n++) saveRecord(directory,{requestId:`old-${n}`,goal:`Synthetic old goal ${n}`,workspacePath:directory,verdict:'checked',stopReason:'Old independent check completed.',planningHarness:'Codex',reviewHarness:'Pi',result:'Old checked result',planningQuota:null,reviewQuota:null,planText:'Old plan',reviewText:'Old check'});
 const seededRecords=readRecords(directory);
 if(options.admission?.continuation) {
  const historic=options.admission.continuation.rootRequestId;
  const prior=store.startAdmission({...admission(directory,historic),goal:options.admission.continuation.originalGoal});
  const owner=store.claimWorker(prior.jobId).ownerToken;
  saveRecord(directory, {requestId:historic,goal:options.admission.continuation.originalGoal,workspacePath:directory,verdict:'checked',stopReason:'Historic independent check completed.',planningHarness:'Codex',reviewHarness:'Pi',result:'Historic check',planningQuota:null,reviewQuota:null,planText:'Historic plan',reviewText:'Historic check',piCapacity:pair});
  store.recordOutcome(prior.jobId,{status:'completed'},owner);store.releaseAdmission(prior.jobId,owner);
 }
 const start = store.startAdmission({ ...admission(directory), ...options.admission }, { followUpMode: codec.MODE });
 delete require.cache[require.resolve('./coordination-scope.cjs')];
 const scope = require('./coordination-scope.cjs'), fakeClock = clock(), ready = deferred(), capture = {};
 let authorize = 0, closed = 0, rounds = 0, discoveryCount = 0, saveAttempts = 0;
 const generations = [], launches = [], inputs = [], reservations = [];
 const roster = [
  { instanceId: 'codex', displayName: 'Codex', driver: 'codex', enabled: true, installed: true, availability: 'available', status: 'ready', auth: { status: 'authenticated', type: 'chatgpt' }, models: [{ slug: 'gpt-6-astra', isDefault: true }] },
  { instanceId: 'pi', displayName: 'Pi', driver: 'pi', enabled: true, installed: true, availability: 'available', status: 'ready', auth: { status: 'unknown', type: 'apiKey' }, models: [], piCapacity: { offer: pair, catalog: [{provider:'Fixture',model:'alpha'}], workspacePath: directory } },
 ];
 const adapter = { ...store, updateProgress: (...args) => { const result = store.updateProgress(...args); if (args[1].phase === 'awaiting-followup') ready.resolve(); return result; },
  startControlServer: async callbacks => { Object.assign(capture, callbacks); return { close: async () => { capture.closed = (capture.closed ?? 0) + 1; } }; },
  recordLiveFollowUpAccepted: (...args) => { if(options.storageFail) throw Error('fixture disk full'); const result=store.recordLiveFollowUpAccepted(...args); if(options.stopAfterSave) {store.revoke(start.jobId);capture.onRevoke({storageError:false});} return result; },
  recordPendingCommand: (...args) => { if(options.stopBeforeChildReserve && launches.length===2) store.revoke(start.jobId); return store.recordPendingCommand(...args); } }; 
 const worker = runWorker({ directory, stateDir: path.join(directory, 'runtime'), jobId: start.jobId }, {
  ...fakeClock, store: adapter, scope: { ...scope, authorize: (...args) => { authorize++; return scope.authorize(...args); }, reserve: (...args) => { reservations.push(args[1]); return scope.reserve(...args); } },
  engine: { ...engine, requestCoordination: (...args) => { inputs.push(args[0]); rounds++; return engine.requestCoordination(...args); } },
  runtime: { stateDir: path.join(directory, 'runtime'), discover: async () => ({ok:true,providers:roster}), prepare: async () => ({}), close() { closed++; },
   run: async (command, generation) => { launches.push(command); generations.push(generation); if (options.blockChild && launches.length === 3) await options.blockChild.promise;
    if(options.unknownChild && launches.length===3) return {ok:false,messageDispatched:null,text:'Unconfirmed fixture output',errorText:'fixture delivery unknown'};
    const text=command.commandId.includes('review') ? (options.revise ? 'VERDICT: revise' : 'Independent fixture check.\nVERDICT: carry-out') : 'The full fixture plan.';
    return {ok:true,messageDispatched:true,text:options.whitespace ? `\n${text}\n` : text}; } },
  core: { invoke: async () => ({ bounds:{projectionUnavailable:false}, attempt:{state:'completed'} }), exchangeVerified: async request => ({ requestId:request.requestId, ok:true,payload:{requestId:request.requestId,accepted:true,overview:{truncated:false,goals:[],pending:[]}} }) },
  discover: async () => { discoveryCount++; if(discoveryCount > 1 && options.checkBarrier) await options.checkBarrier.promise; return {ok:true,providers:roster}; },
  env: {GOALPORT_COORDINATE_SEND:'1'},
  ...(options.saveFailure ? {saveRecord:()=>{saveAttempts++;throw Error('fixture initial record unavailable');}} : {}),
 });
 if(options.expectTerminal) await worker; else await ready.promise;
 const status = () => capture.getLiveReadStatus(store.getStatus(start.jobId));
 const stop = () => { store.revoke(start.jobId); capture.onRevoke({storageError:false}); };
 t.after(async () => { if (!capture.closed) { stop(); options.checkBarrier?.resolve(); options.blockChild?.resolve(); await worker; } });
 return { directory, store, start, scope, fakeClock, capture, status, stop, worker, launches, generations, inputs, reservations, roster, seededRecords, counts: () => ({authorize,closed,rounds,discoveryCount}), saveAttempts:()=>saveAttempts };
}
test('single actual runWorker keeps original RAM scope: 4→2→0, one job/authorize, two immutable result identities and command chains', async t => {
 const r = await fixture(t,{seedOld:true,whitespace:true});
 const first = readRecords(r.directory).find(record=>record.requestId==='initial');
 assert.equal(r.status().ready, true); assert.equal(r.status().remainingReads, 2);
 assert.equal(r.store.getStatus(r.start.jobId).state, 'running'); assert.equal(r.store.getStatus(r.start.jobId).phase, 'awaiting-followup');
 const generation = r.scope.current().generation;
 await r.capture.onContinue({requestId:'child',fromRequestId:'initial',followUp:'Preserve the original boundary'});
 const result = await r.worker;
 assert.equal(result.status,'completed');
 assert.deepEqual(r.counts(), {authorize:1,closed:1,rounds:2,discoveryCount:2});
 assert.equal(r.launches.length,4); assert.equal(new Set(r.launches.map(c=>c.commandId)).size,4);
 assert.deepEqual(r.generations, ['initial','initial','initial','initial']);
 assert.deepEqual(r.reservations, [generation,generation,generation,generation]);
 assert.equal(r.store.getStatus(r.start.jobId).counters.readTurnsRemaining,0);
 assert.equal(r.store.getStatus(r.start.jobId).active,false); assert.equal(r.scope.current(),null);
 const records=readRecords(r.directory); assert.equal(records.length,13);assert.deepEqual(records.filter(record=>record.requestId.startsWith('old-')),r.seededRecords);
 assert.equal(fs.readdirSync(path.join(r.directory,'coordination-jobs','jobs')).length,1); assert.deepEqual(records.find(record=>record.requestId==='initial'),first);
 const child=records.find(record=>record.requestId==='child'); assert.ok(child); assert.equal(child.continuation.parentRequestId,'initial'); assert.equal(child.goal,first.goal);
 assert.equal(r.inputs[1].priorPlan,first.planText); assert.equal(r.inputs[1].priorReview,first.reviewText); assert.equal(r.inputs[1].executionFeedback,undefined);
 const own=require('./pi-capacity-admission.cjs').ownAdmissionForRequest(r.directory,'child'); assert.equal(own.requestId,'child'); assert.equal(own.writeAuthorization,null);
 assert.equal(require('./saved-targets.cjs').resolveSavedTargets(records).head('initial'),'child');
 const later=require('./pi-capacity-admission.cjs').piAdmissionContext({requestId:'later',goal:first.goal,workspacePath:r.directory,allowedInstances:['codex','pi'],piCapacity:pair,continuation:{parentRequestId:'child',rootRequestId:'initial',originalGoal:first.goal,followUp:'Later fresh allowance'}},r.directory,{ok:true,providers:r.roster});assert.deepEqual(later.piCapacity,pair);assert.equal(r.scope.current(),null);assert.equal(r.counts().authorize,1);
});
test('idle Stop wakes immediately, retains checked initial without fabricated child; expiry is fixed monotonic and polls do not extend it', async t => {
 for(const expiry of [false,true]) {
  const r=await fixture(t); const expiryStamp=r.status().expiresAt;
  r.fakeClock.jumpWall(86400000);assert.equal(r.status().ready,true);assert.equal(r.status().expiresAt,expiryStamp);
  r.fakeClock.advance(899999); assert.equal(r.status().ready,true); assert.equal(r.status().expiresAt,expiryStamp);
  if(expiry) r.fakeClock.advance(1); else { r.store.revoke(r.start.jobId); r.stop(); }
  const result=await r.worker;
  const status=r.store.getStatus(r.start.jobId);
  assert.equal(result.status,expiry?'completed':'stopped'); assert.equal(status.outcome.allowanceEnd,expiry?'expired':'idle-stopped');
  assert.equal(status.pendingCommand,null); assert.equal(status.active,false); assert.equal(r.launches.length,2);
  assert.equal(readRecords(r.directory).length,1); assert.equal(readRecords(r.directory)[0].verdict,'checked');
  assert.equal(r.fakeClock.scheduled.size,0); assert.equal(r.capture.closed,1);
 }
});
test('validating expiry/Stop/operation-timeout win over late heavy checks; guarded New goal never marks active/validating', async t => {
 for(const winner of ['expiry','stop','operation']) {
  const barrier=deferred(),r=await fixture(t,{checkBarrier:barrier});
  const operation=r.capture.onContinue({requestId:'child',fromRequestId:'initial',followUp:''});
  await assert.rejects(r.capture.onContinue({requestId:'simultaneous',fromRequestId:'initial',followUp:''}));
  assert.throws(()=>r.capture.beforeGuardedRevoke({onlyIfReadyFromRequestId:'initial'}));
  assert.equal(r.store.getStatus(r.start.jobId).revoked,false);
  if(winner==='expiry') r.fakeClock.advance(900000); else if(winner==='stop') r.stop(); else r.fakeClock.advance(10000);
  barrier.resolve(); await assert.rejects(operation);
  if(winner==='operation') { assert.equal(r.status().ready,true); r.stop(); }
  await r.worker;
  assert.equal(r.launches.length,2); assert.equal(r.store.getStatus(r.start.jobId).liveFollowUp,undefined);
 }
});
test('accepted child identity is idempotent; payload conflicts and queued idle timer cannot expire active/pending work', async t => {
 const block=deferred(), r=await fixture(t,{blockChild:block});
 const oldTimer=[...r.fakeClock.scheduled.values()][0].fn;
 const payload={requestId:'child',fromRequestId:'initial',followUp:''};
 await r.capture.onContinue(payload); await r.capture.onContinue(payload);
 await assert.rejects(r.capture.onContinue({...payload,followUp:'different'}));
 await assert.rejects(r.capture.onContinue({...payload,requestId:'second'}));
 r.fakeClock.advance(900000); oldTimer();
 assert.equal(r.store.getStatus(r.start.jobId).outcome,null);
 block.resolve(); await r.worker; assert.equal(r.launches.length,4);
});
test('accepted-input storage failure holds honestly without launching child, and disk counters cannot make a missing scope ready', async t => {
 const r=await fixture(t,{storageFail:true});
 await assert.rejects(r.capture.onContinue({requestId:'child',fromRequestId:'initial',followUp:''}));
 const result=await r.worker; assert.equal(result.storageFailed,true); assert.equal(r.store.getStatus(r.start.jobId).active,true); assert.equal(r.launches.length,2);
 const r2=await fixture(t); r2.scope.revoke(); assert.equal(r2.status().ready,false); assert.equal(r2.status().remainingReads,null); r2.stop(); await r2.worker;
});
test('idle marker storage error and loss of the original claim owner stay unconfirmed, never become a confirmed Stop or disk-ready budget', async t => {
 const r=await fixture(t);r.capture.onRevoke({storageError:true});const result=await r.worker;
 assert.equal(result.storageFailed,true);assert.equal(r.store.getStatus(r.start.jobId).active,true);assert.equal(r.store.getStatus(r.start.jobId).outcome,null);assert.equal(r.launches.length,2);
 const r2=await fixture(t),file=path.join(r2.directory,'coordination-jobs','jobs',r2.start.jobId,'startup-claim.json');
 const claim=JSON.parse(fs.readFileSync(file,'utf8'));claim.ownerToken='c'.repeat(64);fs.writeFileSync(file,JSON.stringify(claim));
 assert.equal(r2.status().ready,false);assert.equal(r2.status().reason,'unconfirmed');r2.stop();await r2.worker;assert.equal(r2.store.getStatus(r2.start.jobId).active,true);
});
test('full control JSON UTF8/schema/credential/IDs/escaping/newline is 8192 max before connection', async () => {
 const payload={requestId:'child',fromRequestId:'initial',followUp:''},token='a'.repeat(64);
 const overhead=Buffer.byteLength(codec.controlFrame(token,'continue',payload));
 const max={...payload,followUp:'x'.repeat(8192-overhead)};
 assert.equal(Buffer.byteLength(codec.controlFrame(token,'continue',max)),8192);
 assert.throws(()=>codec.controlFrame(token,'continue',{...max,followUp:max.followUp+'x'}),/too long/);
 for(const text of ['😀'.repeat(2100),'"\\\n'.repeat(2000)]) assert.throws(()=>codec.controlFrame(token,'continue',{...payload,followUp:text}),/too long/);
 await assert.rejects(requestControl('nonexistent-fixture',token,'continue',{payload:{...max,followUp:max.followUp+'x'}}),/too long/);
 assert.equal(Object.keys(JSON.parse(codec.controlFrame(token,'status'))).length,3);
});
test('additive mode stays outside canonical input; legacy duplicate never upgrades, changed stored mode conflicts; bad optional context stays local', t => {
 const directory=temp(t),s=createCoordinationJobStore(directory,{bootstrapReady:true});
 const a=admission(directory),start=s.startAdmission(a),claim=s.claimWorker(start.jobId);
 assert.equal(s.startAdmission(a,{followUpMode:codec.MODE}).status.followUpMode,undefined);
 s.recordOutcome(start.jobId,{status:'completed'},claim.ownerToken);s.releaseAdmission(start.jobId,claim.ownerToken);
 const b=s.startAdmission({...a,requestId:'new'},{followUpMode:codec.MODE});
 assert.equal(b.status.followUpMode,codec.MODE); assert.equal(Object.hasOwn(b.status.admission,'followUpMode'),false);
 assert.equal(s.startAdmission({...a,requestId:'new'}).reason,'request-conflict');
 const owner=s.claimWorker(b.jobId).ownerToken;
 s.updateProgress(b.jobId,{phase:'awaiting-followup'},owner);
 const file=path.join(directory,'coordination-jobs','jobs',b.jobId,'progress.json');
 const progress=JSON.parse(fs.readFileSync(file,'utf8')); progress.liveFollowUp={bad:true}; fs.writeFileSync(file,JSON.stringify(progress));
 assert.deepEqual(s.getStatus(b.jobId).liveFollowUp,{bad:true});assert.equal(s.readOwnedLiveFollowUpContext(b.jobId),null);
 assert.throws(()=>s.recordLiveFollowUpAccepted(b.jobId,{bad:true},owner));
 s.recordOutcome(b.jobId,{status:'completed'},owner);s.releaseAdmission(b.jobId,owner);
 assert.equal(s.startAdmission({...a,requestId:'unrelated',workspacePath:path.join(directory,'other')}).ok,true);
});
test('new-mode initial revise or record-save failure never enters Ready and never retries the failed record save', async t => {
 for(const option of [{revise:true},{saveFailure:true}]) {
  const r=await fixture(t,{...option,expectTerminal:true});const result=await r.worker;
  assert.equal(r.launches.length,2);assert.equal(r.counts().rounds,1);assert.equal(r.store.getStatus(r.start.jobId).active,false);assert.equal(r.fakeClock.scheduled.size,0);
  assert.equal(r.status().ready,false);if(option.saveFailure){assert.equal(result.recordSaveFailed,true);assert.equal(r.saveAttempts(),1);}
 }
});
test('accepted-save Stop race and Stop before child reserve preserve initial and send no child role; after-dispatch unknown stays charged and held', async t => {
 for(const option of [{stopAfterSave:true},{stopBeforeChildReserve:true},{unknownChild:true}]) {
  const r=await fixture(t,option),first=readRecords(r.directory)[0];
  await r.capture.onContinue({requestId:'child',fromRequestId:'initial',followUp:''});
  const result=await r.worker,status=r.store.getStatus(r.start.jobId);
  assert.deepEqual(readRecords(r.directory).find(x=>x.requestId==='initial'),first);
  assert.equal(r.launches.length,option.unknownChild?3:2);
  assert.equal(result.status,option.unknownChild?'unconfirmed':'stopped');
  assert.equal(status.active,!!option.unknownChild);
  if(option.unknownChild) { assert.ok(status.pendingCommand);assert.equal(status.counters.readTurnsRemaining,1); }
  else { assert.equal(status.pendingCommand,null);assert.equal(status.outcome.allowanceEnd,undefined); }
 }
});
test('historical initial keeps its historic root, but live child parent is the initial JOB; vanished Pi membership refuses without another authorize', async t => {
 const r=await fixture(t,{admission:{continuation:{parentRequestId:'historic',rootRequestId:'historic',originalGoal:'Explain the fixture boundary',followUp:'Initial follow'}}});
 await r.capture.onContinue({requestId:'child',fromRequestId:'initial',followUp:'One more'}); await r.worker;
 const child=readRecords(r.directory).find(x=>x.requestId==='child');assert.equal(child.continuation.parentRequestId,'initial');assert.equal(child.continuation.rootRequestId,'historic');
 const r2=await fixture(t);r2.roster[1].piCapacity.catalog=[];
 await assert.rejects(r2.capture.onContinue({requestId:'child',fromRequestId:'initial',followUp:''}));
 assert.equal(r2.counts().authorize,1);assert.equal(r2.store.getStatus(r2.start.jobId).liveFollowUp,undefined);assert.equal(r2.launches.length,2);r2.stop();await r2.worker;
});
test('frozen 1db structural reader contract accepts TOP mode + running phase + opaque extras, while canonical INPUT keys remain unchanged', t => {
 const directory=temp(t),s=createCoordinationJobStore(directory,{bootstrapReady:true});
 const start=s.startAdmission(admission(directory),{followUpMode:codec.MODE}),owner=s.claimWorker(start.jobId).ownerToken;s.updateProgress(start.jobId,{phase:'awaiting-followup'},owner);
 const root=path.join(directory,'coordination-jobs','jobs',start.jobId);
 const a=JSON.parse(fs.readFileSync(path.join(root,'admission.json'),'utf8')),p=JSON.parse(fs.readFileSync(path.join(root,'progress.json'),'utf8'));
 // Frozen 1db readAdmission canonical comparison and readProgress's base
 // structural whitelist. It deliberately has NO new-field validation.
 const oldStateWhitelist=['admitted','running','revoked','completed','failed','stopped','unconfirmed'];
 const oldCanonicalKeys=['requestId','goal','workspacePath','priorPlan','priorReview','avoidInstances','allowedInstances','maxTurns','writeAuthorization','backgroundConsent','piCapacity'];
 assert.deepEqual(Object.keys(a.input),oldCanonicalKeys);
 assert.equal(JSON.stringify(require('./coordination-job.cjs').normalizeAdmissionInput(a.input)),JSON.stringify(a.input));
 assert.ok(oldStateWhitelist.includes(p.state));assert.ok(Array.isArray(p.completedCommands));assert.equal(p.pendingCommand,null);assert.equal(typeof p.revoked,'boolean');
 p.liveFollowUp={opaque:['not validated by old reader']};assert.doesNotThrow(()=>JSON.parse(JSON.stringify(p)));
 assert.equal(a.followUpMode,codec.MODE);assert.equal(p.phase,'awaiting-followup');
});
test('pure continuation preflight includes full initial plan/check without silently cropping into an accepted role', t => {
 const directory=temp(t),start={requestId:'child',goal:'Original',workspaceRoot:directory,readInstances:['codex','pi'],readMaxTurns:4,backgroundConsent:true,piCapacity:pair,priorPlan:'p'.repeat(70000),priorReview:'r'.repeat(40000),continuation:{parentRequestId:'initial',rootRequestId:'initial',originalGoal:'Original',followUp:''}};
 const providers=[{instanceId:'codex',auth:{status:'authenticated',type:'subscription'},models:[{slug:'default',isDefault:true}]},{instanceId:'pi',auth:{status:'unknown',type:'apiKey'},piCapacity:{offer:pair,catalog:[{provider:'Fixture',model:'alpha'}]}}];
 assert.throws(()=>engine.preflightBackgroundContinuation(start,providers),/100,000-byte/);assert.equal(start.priorPlan.length,70000);assert.equal(start.priorReview.length,40000);
});
test('actual control endpoint retains legacy status/revoke, invokes revoke wake even existing marker and guards New goal before marker', async t => {
 const directory=temp(t),s=createCoordinationJobStore(directory,{bootstrapReady:true}),start=s.startAdmission(admission(directory),{followUpMode:codec.MODE});s.claimWorker(start.jobId);
 const endpoint=process.platform==='win32'?String.raw`\\.\pipe\gp-live-test-`+randomUUID():path.join(directory,'c.sock');let wakes=0; const frames=[];
 const server=await s.startControlServer({jobId:start.jobId,endpoint,beforeGuardedRevoke:()=>{throw Error('not idle');},onRevoke:()=>wakes++,onContinue:payload=>frames.push(payload)});t.after(()=>server.close());
 const token=s.readControlCredential(start.jobId);
 await assert.rejects(requestControl(endpoint,token,'revoke',{payload:{onlyIfReadyFromRequestId:'initial'}}));assert.equal(s.getStatus(start.jobId).revoked,false);
 assert.equal((await requestControl(endpoint,token,'status')).requestId,'initial');
 const payload={requestId:'child',fromRequestId:'initial',followUp:''};
 const overhead=Buffer.byteLength(codec.controlFrame(token,'continue',payload));
 const exact={...payload,followUp:'x'.repeat(8192-overhead)};
 assert.equal((await requestControl(endpoint,token,'continue',{payload:exact})).requestId,'initial');assert.equal(frames.length,1);
 await assert.rejects(requestControl(endpoint,token,'continue',{payload:{...exact,followUp:exact.followUp+'x'}}));assert.equal(frames.length,1);
 await requestControl(endpoint,token,'revoke');await requestControl(endpoint,token,'revoke');assert.equal(wakes,2);
 await assert.rejects(requestControl(endpoint,token,'unknown'));
});
