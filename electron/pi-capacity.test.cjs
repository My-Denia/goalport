const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizePiCapacity, parsePiCatalog, configuredPiOffer, selectedPiEligible } = require('./pi-capacity.mjs');
const { discoverCliProviders, readPiMetadata, PI_RESOURCE_ARGS, runCliTurn, writeGrant, defaultExec, hasClaim } = require('./cli-coordinate.cjs');
const { normalizeAdmissionInput, createCoordinationJobStore } = require('./coordination-job.cjs');
const { normalizeRecord, saveRecord } = require('./coordination-record.cjs');
const { authorizeMembershipError } = require('./coordinate-service.cjs');
const { createHarnessRuntime } = require('./harness-runtime.cjs');
const { piAdmissionContext } = require('./pi-capacity-admission.cjs');
const engine = require('../dist/coordination-engine.cjs');
const table='provider model context max-out thinking images\nFixture alpha 128K 16K yes yes\nFixture beta:high 1M 128K yes no\nOther omega 1000 200 no no\n';
const pair={provider:'Fixture',model:'alpha',useExistingCapacity:true};
const catalog=parsePiCatalog(table);
function temp(t) { const d=fs.mkdtempSync(path.join(os.tmpdir(),'gp-capacity-')); t.after(()=>fs.promises.rm(d,{recursive:true,force:true,maxRetries:10,retryDelay:100})); return d; }
function snapshot(root,kind='apiKey-only') { return {instanceId:'pi',displayName:'Pi',enabled:true,installed:true,availability:'available',status:'ready',auth:{status:'unknown',type:kind==='apiKey-only'?'apiKey':'unknown',credentialKind:kind},models:[{slug:'default',isDefault:true}],piCapacity:{catalog,offer:pair,workspacePath:root,provisional:false}}; }
function command(root,id='coordinate-review-capacity') { return {type:'goalport.coordinateTurn',commandId:id,modelSelection:{instanceId:'pi',provider:pair.provider,model:pair.model},runtimeMode:'approval-required',approvalPolicy:'never',sandboxPolicy:{type:'readOnly'},workspaceStrategy:{type:'existing_worktree',worktreePath:root},initialMessage:{text:'Read only.'}}; }
function admission(root,extra={}) { return {requestId:'request-fixture',goal:'Inspect fixture',workspacePath:root,allowedInstances:['codex','pi'],maxTurns:4,backgroundConsent:true,...extra}; }
function record(root,extra={}) { return {requestId:'request-fixture',goal:'Inspect fixture',workspacePath:root,planningHarness:'Codex',reviewHarness:'Pi',planText:'Plan',reviewText:'Checked',result:'Checked',stopReason:'Checked',verdict:'checked',planningQuota:'unknown',reviewQuota:'unknown',...extra}; }

test('closed selection rejects null, arrays, partial, extra, controls, overlength and nonliteral IDs; absence stays absent',t=>{
 const root=temp(t);
 for(const bad of [null,[],{}, {...pair,useExistingCapacity:false},{...pair,thinking:'high'},{...pair,provider:' Fixture'},{...pair,model:'-x'},{...pair,model:'x\u001b[0m'},{...pair,provider:'p'.repeat(129)},{...pair,model:'m'.repeat(257)}]) {
   assert.equal(normalizePiCapacity(bad),null); assert.throws(()=>normalizeAdmissionInput(admission(root,{piCapacity:bad})),/Pi capacity/);
 }
 assert.deepEqual(normalizePiCapacity(pair),pair);
 assert.equal(Object.hasOwn(normalizeAdmissionInput(admission(root)),'piCapacity'),false);
 assert.deepEqual(normalizeAdmissionInput(admission(root,{piCapacity:pair})).piCapacity,pair);
});
test('six-column grammar rejects duplicates, case collisions, wrapped/extra/malformed/ANSI and invalid counts',()=>{
 assert.equal(catalog.length,3);
 for(const bad of ['',table.replace('provider model','model provider'),table+table.split('\n')[1]+'\n',table+'fixture ALPHA 1K 2K yes no\n',table+'wrapped\n',table.replace('128K','0K'),table.replace('16K','-16'),table.replace('yes yes','true yes'),table.replace('Fixture alpha','Fixture alpha extra'),table.replace('Fixture alpha','\u001b[0mFixture alpha'),'x'.repeat(262145)]) assert.equal(parsePiCatalog(bad),null,bad.slice(0,80));
});
test('scope-first exact selection, one suffix, literal colon wins, empty/default unknown auth, no fallback',()=>{
 assert.deepEqual(configuredPiOffer({enabledModels:['Fixture/alpha:high','Other/omega'],defaultProvider:'Other',defaultModel:'omega'},catalog).offer,pair);
 assert.equal(configuredPiOffer({enabledModels:['Fixture/beta:high']},catalog).offer.model,'beta:high');
 assert.equal(configuredPiOffer({enabledModels:['Fixture/beta:high:low']},catalog).offer.model,'beta:high');
 for(const raw of ['alpha','Fixture/*','Fixture/alpha,Other/omega','fixture/alpha','Fixture/missing','Fixture/alpha:high:max','']) assert.equal(configuredPiOffer({enabledModels:[raw,'Fixture/alpha'],defaultProvider:'Fixture',defaultModel:'alpha'},catalog).offer,undefined);
 assert.deepEqual(configuredPiOffer({enabledModels:[],defaultProvider:'Fixture',defaultModel:'alpha'},catalog).offer,pair);
 assert.deepEqual(configuredPiOffer({defaultProvider:'Fixture',defaultModel:'alpha'},catalog).offer,pair);
 assert.equal(configuredPiOffer({defaultProvider:'Fixture',defaultModel:'absent'},catalog).offer,undefined);
});
test('metadata reads only allowlisted settings at selected HOME/agent dir and CWD, and never leaks raw stderr',async t=>{
 const root=temp(t), calls=[], reads=[];
 const meta=await readPiMetadata({env:{HOME:root,PI_CODING_AGENT_DIR:path.join(root,'agent'),PATH:''},cwd:root,execFile:async(file,args,options)=>{calls.push({file,args,options});return {code:0,stdout:table,stderr:'private example never projected'};},readFile:file=>{reads.push(file);return file===path.join(root,'agent','settings.json')?JSON.stringify({enabledModels:['Fixture/alpha:high','Other/omega'],defaultProvider:'Other',defaultModel:'omega',defaultThinkingLevel:'max',privateThing:'never exposed'}):'{}';}});
 assert.deepEqual(meta.offer,pair); assert.equal(meta.scopeCount,2);
 assert.equal(calls.length,1); assert.deepEqual(calls[0].args,[...PI_RESOURCE_ARGS,'--list-models']); assert.equal(calls[0].options.cwd,root); assert.equal(calls[0].options.env.NO_COLOR,'1');
 assert.deepEqual(reads,[path.join(root,'agent','settings.json'),path.join(root,'.pi','settings.json')]);
 assert.doesNotMatch(JSON.stringify(meta),/private|never exposed/);
 for(const result of [{code:1,stdout:table},{code:0,stdout:table,truncated:true},{code:0,stdout:table,timedOut:true},{code:0,stdout:table,stderr:'x'.repeat(16385)}]) assert.equal((await readPiMetadata({cwd:root,readSettings:false,execFile:async()=>result})).catalog.length,0);
});
test('bounded actual benign Node metadata subprocess obeys nonzero, output limits and timeout',async t=>{
 const root=temp(t), file=path.join(root,'fake-metadata.cjs');
 fs.writeFileSync(file,'process.stdout.write("x".repeat(262145));');
 await assert.rejects(defaultExec(process.execPath,[file],{cwd:root,bounded:true,timeoutMs:5000}),/limit/);
 fs.writeFileSync(file,'setInterval(()=>{},1000);');
 await assert.rejects(defaultExec(process.execPath,[file],{cwd:root,bounded:true,timeoutMs:30}),/Timed out/);
 fs.writeFileSync(file,'process.exitCode=7;');
 assert.equal((await defaultExec(process.execPath,[file],{cwd:root,bounded:true})).code,7);
});
test('ONE credential-kind/billing-independent selected predicate and legacy table across host',t=>{
 const root=temp(t);
 for(const kind of ['oauth-only','apiKey-only','mixed','unreported']) {
   const pi=snapshot(root,kind), discovered={ok:true,providers:[pi]};
   assert.equal(selectedPiEligible(pi,pair),true,kind);
   assert.equal(selectedPiEligible(pi,undefined,true),kind!=='apiKey-only',kind);
   assert.equal(authorizeMembershipError(discovered,['pi'],{piCapacity:pair}),null);
   assert.equal(authorizeMembershipError(discovered,['pi'],{legacyPiContinuation:true})===null,kind!=='apiKey-only');
   for(const changed of [{installed:false},{availability:'unavailable'},{auth:{status:'unauthenticated'}},{quota:'exhausted'}]) assert.equal(selectedPiEligible({...pi,...changed},pair),false);
 }
 assert.equal(selectedPiEligible({...snapshot(root),instanceId:'other'},pair),false);
});
test('production route-aware discovery reuses legacy credential-kind summary without treating it as billing',async t=>{
 const root=temp(t), authPath=path.join(root,'.pi','agent','auth.json');
 for(const [kind,records] of [
   ['apiKey-only',{fixture:{type:'api_key',key:'fixture-not-a-real-key'}}],
   ['oauth-only',{fixture:{type:'oauth',access:'fixture-not-a-real-token'}}],
   ['mixed',{one:{type:'oauth'},two:{type:'api_key',key:'fixture-not-a-real-key'}}],
   ['unreported',{}],
 ]) {
   const reads=[];
   const discovered=await discoverCliProviders({routeAwarePi:true,home:root,cwd:root,env:{HOME:root,PATH:''},
     execFile:async(_file,args)=>{if(args.includes('--list-models'))return {code:0,stdout:table,stderr:''};throw Error('No other fixture process');},
     readFile:file=>{reads.push(file);if(file===authPath)return JSON.stringify(records);if(file===path.join(root,'.pi','agent','settings.json'))return JSON.stringify({enabledModels:['Fixture/alpha']});throw Error('No fixture file');}});
   const pi=discovered.providers.find(provider=>provider.instanceId==='pi');
   assert.equal(pi.auth.credentialKind??'unreported',kind);
   assert.equal(pi.auth.status,kind==='unreported'?'unknown':'authenticated');
   assert.ok(reads.includes(authPath));
   assert.equal(authorizeMembershipError(discovered,['pi'],{legacyPiContinuation:true})===null,kind!=='apiKey-only');
   assert.equal(authorizeMembershipError(discovered,['pi'],{piCapacity:pair}),null);
   assert.doesNotMatch(JSON.stringify(pi),/fixture-not-a-real|access|api_key/);
 }
});
test('route-aware credential summary follows the selected native agent directory, not another install',async t=>{
 const root=temp(t),agent=path.join(root,'native-agent'),reads=[];
 const discovered=await discoverCliProviders({routeAwarePi:true,home:root,cwd:root,env:{HOME:root,PI_CODING_AGENT_DIR:agent,PATH:''},
   execFile:async(_file,args)=>{if(args.includes('--list-models'))return {code:0,stdout:table,stderr:''};throw Error('No locator or vendor process');},
   readFile:file=>{reads.push(file);if(file===path.join(agent,'auth.json'))return JSON.stringify({fixture:{type:'api_key',key:'fake-private-marker'}});if(file===path.join(agent,'settings.json'))return JSON.stringify({enabledModels:['Fixture/alpha']});throw Error('No fixture file');}});
 const pi=discovered.providers.find(provider=>provider.instanceId==='pi');
 assert.equal(pi.auth.credentialKind,'apiKey-only');
 assert.ok(reads.includes(path.join(agent,'auth.json')));
 assert.equal(reads.includes(path.join(root,'.pi','agent','auth.json')),false);
 assert.notEqual(authorizeMembershipError(discovered,['pi'],{legacyPiContinuation:true}),null);
 assert.equal(authorizeMembershipError(discovered,['pi'],{piCapacity:pair}),null);
 assert.doesNotMatch(JSON.stringify(pi),/fake-private-marker/);
});
test('fresh bound turn checks metadata once; immutable context BEFORE stored claim; no replay subprocess/grant consumption',async t=>{
 const root=temp(t), cmd=command(root); let meta=0,spawn=0;
 const options={stateDir:root,piCapacity:pair,metadataExec:async(file,args,opts)=>{meta++;assert.deepEqual(args,[...PI_RESOURCE_ARGS,'--list-models']);assert.equal(opts.cwd,root);return {code:0,stdout:table};},spawnTurn:async spec=>{spawn++;assert.equal(spec.env.NO_COLOR,'1');assert.deepEqual(spec.args.slice(-5),['--provider','Fixture','--model','alpha','Read only.']);assert.ok(spec.args.includes('--offline'));assert.ok(spec.args.includes('--no-tools'));assert.ok(!spec.args.includes('--thinking'));assert.ok(!spec.args.includes('--api-key'));return {code:0,stdout:'Checked'};}};
 writeGrant(root,cmd.commandId);
 const first=await runCliTurn(cmd,options); assert.equal(first.ok,true);assert.deepEqual(first.requestedPiCapacity,{provider:'Fixture',model:'alpha'});
 const grantFile=path.join(root,'send-authorization'), before=fs.existsSync(grantFile)?fs.readFileSync(grantFile,'utf8'):null;
 const wrong=await runCliTurn({...cmd,modelSelection:{instanceId:'pi',model:'alpha'}},options);assert.equal(wrong.messageDispatched,false);assert.match(wrong.errorText,/admitted/);
 assert.deepEqual(await runCliTurn(cmd,options),first);assert.equal(meta,1);assert.equal(spawn,1);assert.equal(fs.existsSync(grantFile)?fs.readFileSync(grantFile,'utf8'):null,before);
});
test('missing exact fresh pair refuses before claim/grant; native custom fallback warning is not accepted',async t=>{
 const root=temp(t),cmd=command(root);writeGrant(root,cmd.commandId);let spawn=0;
 const refused=await runCliTurn(cmd,{stateDir:root,piCapacity:pair,metadataExec:async()=>({code:0,stdout:table.replace('Fixture alpha','Fixture absent')}),spawnTurn:async()=>{spawn++;}});
 assert.equal(refused.messageDispatched,false);assert.equal(hasClaim(root,cmd.commandId),false);assert.equal(spawn,0);assert.match(fs.readFileSync(path.join(root,'send-authorization'),'utf8'),/coordinate-review-capacity/);
 const warning=await runCliTurn(cmd,{stateDir:root,piCapacity:pair,metadataExec:async()=>({code:0,stdout:table}),spawnTurn:async()=>({code:0,stdout:'Looks done',stderr:'Using custom model fallback model'})});assert.equal(warning.ok,false);assert.equal(warning.messageDispatched,true);
});
test('bound resolver warnings never override proven no-child or unknown stdin delivery',async t=>{
 const root=temp(t),cmd=command(root,'coordinate-review-nochild'); writeGrant(root,cmd.commandId);
 const nochild=await runCliTurn(cmd,{stateDir:root,piCapacity:pair,metadataExec:async()=>({code:0,stdout:table}),spawnTurn:async()=>({spawnError:true,childStarted:false,stdout:'',stderr:'Using custom model id'})});
 assert.equal(nochild.messageDispatched,false);assert.equal(hasClaim(root,cmd.commandId),false);
 assert.match(fs.readFileSync(path.join(root,'send-authorization'),'utf8'),/coordinate-review-nochild/);
 if(process.platform==='linux') {
   const audit={...command(root,'coordinate-audit-unknown'),promptDelivery:'stdin'};writeGrant(root,audit.commandId);
   const unknown=await runCliTurn(audit,{stateDir:root,piCapacity:pair,metadataExec:async()=>({code:0,stdout:table}),spawnTurn:async()=>({spawnError:true,childStarted:true,inputEnded:false,stdout:'',stderr:'Using custom model id'})});
   assert.equal(unknown.messageDispatched,null);assert.equal(hasClaim(root,audit.commandId),true);
 }
});

test('unsupported pinned runtime refuses BEFORE RPC/prepare and never falls back',async()=>{
 const runtime=createHarnessRuntime({checkout:'/fixture/nonexistent',serverCwd:'/fixture/nonexistent',stateDir:'/fixture/unused',piCapacity:pair});
 assert.equal((await runtime.prepare(command('/fixture'))).messageDispatched,false);
 assert.equal((await runtime.run(command('/fixture'))).messageDispatched,false);
 runtime.close();
});
test('canonical optional field / same-request conflict / malformed prior profile-wide refusal while result stays visible',t=>{
 const root=temp(t),store=createCoordinationJobStore(root,{bootstrapReady:true});
 const input=admission(root,{piCapacity:pair});const first=store.startAdmission(input);
 assert.equal(store.startAdmission(input).created,false);
 assert.equal(store.startAdmission({...input,piCapacity:{...pair,model:'beta:high'}}).reason,'request-conflict');
 assert.deepEqual(store.getStatus(first.jobId).admission.piCapacity,pair);
 const file=path.join(root,'coordination-jobs','jobs',first.jobId,'admission.json'),raw=JSON.parse(fs.readFileSync(file,'utf8'));raw.input.piCapacity.extra=true;fs.writeFileSync(file,JSON.stringify(raw));
 assert.throws(()=>store.startAdmission(admission(root,{requestId:'another'})),error=>error.code==='malformed-admission');
 const bad=record(root,{piCapacity:{...pair,extra:true}});assert.equal(normalizeRecord(bad).result,'Checked');assert.throws(()=>saveRecord(root,bad),/malformed/);
});
test('fresh Start requires intent and exact current offer; Continue uses UNIQUE OWN admission pair, not changed defaults',t=>{
 const root=temp(t),pi=snapshot(root),d={providers:[pi]};
 assert.throws(()=>piAdmissionContext(admission(root),root,d),/Choose Use Pi/);
 assert.deepEqual(piAdmissionContext(admission(root,{piCapacity:pair}),root,d).piCapacity,pair);
 const store=createCoordinationJobStore(root,{bootstrapReady:true});store.startAdmission(admission(root,{piCapacity:pair}));saveRecord(root,record(root,{piCapacity:pair}));
 const c={parentRequestId:'request-fixture',rootRequestId:'request-fixture',originalGoal:'Inspect fixture',followUp:'Next'};
 pi.piCapacity.offer={...pair,model:'beta:high'};
 assert.deepEqual(piAdmissionContext(admission(root,{requestId:'child',continuation:c}),root,d).piCapacity,pair);
 assert.throws(()=>piAdmissionContext(admission(root,{continuation:c,piCapacity:{...pair,model:'beta:high'}}),root,d),/retain/);
});
test('legacy Continue requires the unique own route-less admission; a caller legacy flag never enables fresh Start',t=>{
 const root=temp(t),store=createCoordinationJobStore(root,{bootstrapReady:true}),pi=snapshot(root,'unreported');
 store.startAdmission(admission(root)); saveRecord(root,record(root));
 const continuation={parentRequestId:'request-fixture',rootRequestId:'request-fixture',originalGoal:'Inspect fixture',followUp:''};
 const context=piAdmissionContext(admission(root,{continuation}),root,{providers:[pi]});
 assert.equal(context.legacyPiContinuation,true);assert.equal(Object.hasOwn(context,'piCapacity'),false);
 assert.throws(()=>piAdmissionContext(admission(root,{legacyPiContinuation:true}),root,{providers:[pi]}),/Choose Use Pi/);
 pi.auth={type:'apiKey',credentialKind:'apiKey-only',status:'unknown'};
 assert.throws(()=>piAdmissionContext(admission(root,{continuation}),root,{providers:[pi]}),/unavailable/);
});
test('runtime captures a closed copy of admitted route rather than mutable defaults/options',async t=>{
 const root=temp(t),options={stateDir:root,piCapacity:{...pair},metadataExec:async()=>({code:0,stdout:table}),spawnTurn:async spec=>{assert.equal(spec.args[spec.args.indexOf('--model')+1],'alpha');return {code:0,stdout:'Checked'};}};
 const runtime=createHarnessRuntime(options),cmd=command(root); options.piCapacity.model='beta:high';writeGrant(root,cmd.commandId);
 assert.equal((await runtime.run(cmd)).ok,true);runtime.close();
});

test('built engine freezes b0c literal legacy Pi ID; admitted pair changes only Pi identity; all commands derive own pair',async()=>{
 const providers=[{instanceId:'codex',displayName:'codex',auth:{status:'authenticated',type:'subscription'},models:[{slug:'default',isDefault:true}]},{instanceId:'pi',displayName:'pi',auth:{status:'authenticated',type:'subscription'},models:[{slug:'default',isDefault:true}]}];
 async function capture(selection,routeAware=false){const commands=[];await engine.requestCoordination({goal:'Inspect the fixture only.',workspacePath:'/fixture/workspace',sendKey:'golden-pi-capacity',allowedInstances:['codex','pi'],...(selection?{piCapacity:selection}:{})},{connected:true,sendAuthorized:true,providers:routeAware?[providers[0],snapshot('/fixture/workspace')]:providers,stopReason:null},{launch:async c=>{commands.push(c);return {launched:true,dispatched:true,text:c.commandId.includes('plan')?'Fixture plan.':'VERDICT: carry-out',errorText:''};}},()=>true);return commands;}
 const old=await capture();assert.equal(old[1].commandId,'coordinate-review-2211be4a');assert.equal(old[0].commandId,'coordinate-plan-66d2898a');
 const selected=await capture(pair,true),changed=await capture({...pair,model:'beta:high'},true);
 assert.equal(selected[0].commandId,old[0].commandId);assert.notEqual(selected[1].commandId,old[1].commandId);assert.notEqual(changed[1].commandId,selected[1].commandId);
 assert.deepEqual(selected[1].modelSelection,{instanceId:'pi',provider:'Fixture',model:'alpha'});
 assert.equal((await capture(undefined,true)).length,0);
});
