const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const {execFileSync}=require('node:child_process');
const purpose=require('./native-workspace-check.cjs');
const helpers=require('./execution-workspace-evidence.cjs');
const engine=require('../dist/coordination-engine.cjs');
const ctx={reply:'Reported reply',replyTruncated:false,commands:[],commandsOmitted:0,commandsTruncated:false,filesTruncated:false,comparisonUnavailable:false,olderTurnsOmitted:0};
function repo(t){const p=fs.mkdtempSync(path.join(os.tmpdir(),'native-check-fixture-'));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));const git=(...a)=>execFileSync('git',a,{cwd:p,encoding:'utf8'});git('init');git('config','user.name','Synthetic Fixture');git('config','user.email','fixture@example.invalid');git('config','commit.gpgsign','false');return {p,git};}
test('target requires itself newest/completed/current task and retains whole-inventory/active-idle guards',async t=>{
 const {p}=repo(t);const target={campaignId:'campaign',attemptId:'attempt',turnRequestId:'turn'};
 const base={bounds:{projectionUnavailable:false,truncated:false},activeCampaignId:'campaign',attempt:{id:'attempt',taskId:'task',provider:'codex',state:'waiting'},activeTask:{id:'task',title:'fixture'},project:{workspaceRoot:p},decisions:[],productConversation:{runtime:{provider:'codex'},turn:{state:'completed',canStop:false}},turnResults:[{requestId:'turn',replyState:'completed',replyText:'reported',commands:[]}]};let snapshot=base;let pending=[];
 const core={exchangeVerified:async q=>({ok:true,requestId:q.requestId,payload:{requestId:q.requestId,accepted:true,...(q.messageType==='goal_overview'?{overview:{truncated:false,goals:[{campaignId:'campaign',attention:'completed'}],pending}}:{snapshot})}})};
 assert.equal((await purpose.resolveTarget(core,base,target)).target.turnRequestId,'turn');
 snapshot={...base,bounds:{...base.bounds,omittedCounts:{turnResults:3}},turnResults:[{...base.turnResults[0],replyText:'😀'.repeat(2000),commandsTruncated:true,commands:Array.from({length:9},(_,i)=>({command:'source-'+i,cwd:'/fixture',state:'completed',exitCode:i,output:'😀'.repeat(200)}))}]};
 const reported=(await purpose.resolveTarget(core,base,target)).context;assert.equal(reported.commands.length,6);assert.equal(reported.commands[0].command,'source-0');assert.equal(reported.commands[5].command,'source-5');assert.equal(reported.commandsOmitted,3);assert.equal(reported.commandsTruncated,true);assert.equal(reported.replyTruncated,true);assert.equal(reported.olderTurnsOmitted,3);assert.equal(Buffer.byteLength(reported.reply),4096);assert.ok(reported.commands.every(c=>Buffer.byteLength(c.output)===400&&c.truncated));
 for(const state of ['failed','cancelled','uncertain']){snapshot={...base,turnResults:[...base.turnResults,{requestId:'newer',replyState:state,commands:[]}]};await assert.rejects(purpose.resolveTarget(core,base,target),/Preview again/);}
 for(const patch of [{attempt:{...base.attempt,id:'other'}},{attempt:{...base.attempt,taskId:'other'}},{turnResults:[]},{turnResults:[...base.turnResults,...base.turnResults]},{bounds:{projectionUnavailable:false,truncated:true}},{attempt:{...base.attempt,state:'active'},productConversation:{...base.productConversation,turn:{state:'idle',canStop:false}}}]){snapshot={...base,...patch};await assert.rejects(purpose.resolveTarget(core,base,target));}
 snapshot=base;pending=[{}];await assert.rejects(purpose.resolveTarget(core,base,target),/permission/);pending=[];snapshot={...base,attempt:{...base.attempt,state:'completed'}};assert.equal((await purpose.resolveTarget(core,snapshot,target)).target.attemptId,'attempt');
});

test('metadata policy is literal, strict, deterministic and body-free',()=>{
 assert.equal(purpose.classifyMetadata('D\0.ENV.secret\0M\0:(glob)*\0')[0].classification,'excluded');
 assert.throws(()=>purpose.classifyMetadata('M\0bad\ufffd\0'.slice(0,-1)),/Malformed/);
 assert.throws(()=>purpose.classifyMetadata('R100\0a\0b\0'),/Malformed/);
 assert.throws(()=>purpose.classifyMetadata('M\0../escape\0'),/unsafe/);
});
test('real tracked sensitive paths are excluded before both body commands; full tail drift retained',async t=>{
 const {p,git}=repo(t);fs.writeFileSync(path.join(p,'note.txt'),'old\n');fs.writeFileSync(path.join(p,'.env'),'private old\n');git('add','.');git('commit','--no-gpg-sign','-m','fixture only');fs.writeFileSync(path.join(p,'note.txt'),'current\n');fs.writeFileSync(path.join(p,'.env'),'private new\n');
 const calls=[];const gitExec=async(a,c)=>{calls.push(a);return purpose.strictGit(a,c);};
 const result=await purpose.collectMaterial({workspace:p,context:ctx},engine,{gitExec});
 assert.equal(result.nativeCheckMaterial.exactPrompt.includes('private new'),false);
 assert.equal(result.nativeCheckMaterial.exactPrompt.includes('.env'),false);
 assert.equal(result.uiExclusions[0].path,'.env');
 const bodies=calls.filter(a=>a.includes('diff')&&!a.includes('--name-status'));
 assert.equal(bodies.length,2);for(const a of bodies){assert.equal(a[0],'--literal-pathspecs');assert.deepEqual(a.slice(a.indexOf('--')+1),['note.txt']);}
 const first=result.nativeCheckMaterial;fs.writeFileSync(path.join(p,'note.txt'),'changed\n');await assert.rejects(purpose.recheckMaterial({workspace:p,context:ctx},first,engine),/Preview again/);
});
test('path-set-only drift and raw tail drift refuse; oversized output is unavailable, never empty',async t=>{
 const {p,git}=repo(t);fs.writeFileSync(path.join(p,'note'),'old\n');fs.writeFileSync(path.join(p,'other'),'old\n');git('add','.');git('commit','--no-gpg-sign','-m','fixture only');fs.writeFileSync(path.join(p,'note'),'current\n');let metadataReads=0;
 await assert.rejects(purpose.collectMaterial({workspace:p,context:ctx},engine,{gitExec:async(a,c)=>{if(a.includes('--name-status') && ++metadataReads===2)fs.writeFileSync(path.join(p,'other'),'now concurrent\n');return purpose.strictGit(a,c);}}),/Preview again/);
 fs.writeFileSync(path.join(p,'note'),'line\n'.repeat(7000)+'tail one\n');const saved=await purpose.collectMaterial({workspace:p,context:ctx},engine);assert.equal(saved.nativeCheckMaterial.coverage.evidenceCropped,true);fs.writeFileSync(path.join(p,'note'),'line\n'.repeat(7000)+'tail two\n');await assert.rejects(purpose.recheckMaterial({workspace:p,context:ctx},saved.nativeCheckMaterial,engine),/Preview again/);
 await assert.rejects(purpose.collectMaterial({workspace:p,context:ctx},engine,{gitExec:async(a,c)=>a.includes('diff')&&!a.includes('--name-status')?{code:1,stdout:'',stderr:'maxBuffer exceeded'}:purpose.strictGit(a,c)}),/maxBuffer/);
 let statuses=0;await assert.rejects(purpose.collectMaterial({workspace:p,context:ctx},engine,{gitExec:async(a,c)=>a.includes('status')?(++statuses===1?{code:0,stdout:'',stderr:''}:{code:1,stdout:'',stderr:'status unavailable'}):purpose.strictGit(a,c)}),/Git status failed/);
 fs.writeFileSync(path.join(p,'note'),'x'.repeat(70000));await assert.rejects(purpose.collectMaterial({workspace:p,context:ctx},engine),/coverage|fully captured/);
});

test('empty explicit lists skip both diff and status, legacy args unchanged',async t=>{
 const {p,git}=repo(t);fs.writeFileSync(path.join(p,'note'),'old');git('add','.');git('commit','--no-gpg-sign','-m','fixture only');const calls=[];const gitExec=async(a,c)=>{calls.push(a);return purpose.strictGit(a,c);};
 const baseline=await helpers.captureWorkspaceBaseline(p,{trackedPaths:[],maxUntrackedFiles:0,gitExec});await helpers.captureWorkspaceEvidence(p,baseline,{trackedPaths:[],maxUntrackedFiles:0,gitExec});assert.equal(calls.some(a=>a.includes('diff')||a.includes('status')),false);
 await helpers.captureWorkspaceBaseline(p,{gitExec});assert.deepEqual(calls.find(a=>a.includes('diff')).slice(-2),['--','.']);
});
if(process.platform==='linux') test('POSIX real tracked magic names remain literal; nonUTF8 inventory refuses before body; symlink and rename metadata stay classified',async t=>{
 const {p,git}=repo(t);const magic=':(glob)*';fs.writeFileSync(path.join(p,magic),'old magic\n');fs.writeFileSync(path.join(p,'.env'),'old private\n');fs.writeFileSync(path.join(p,'rename.txt'),'ordinary old\n');fs.symlinkSync('.env',path.join(p,'link'));git('add','.');git('commit','--no-gpg-sign','-m','fixture only');
 fs.writeFileSync(path.join(p,magic),'new magic\n');fs.writeFileSync(path.join(p,'.env'),'NEW PRIVATE MUST NOT BE READ\n');fs.renameSync(path.join(p,'rename.txt'),path.join(p,'.env.renamed'));git('add','--all');
 const calls=[];const result=await purpose.collectMaterial({workspace:p,context:ctx},engine,{gitExec:async(a,c)=>{calls.push(a);return purpose.strictGit(a,c);}});
 assert.match(result.nativeCheckMaterial.exactPrompt,/new magic/);assert.equal(result.nativeCheckMaterial.exactPrompt.includes('NEW PRIVATE'),false);
 assert.ok(result.nativeCheckMaterial.contentObservation.paths.some(x=>x.path==='rename.txt'&&x.status==='D'));assert.ok(result.uiExclusions.some(x=>x.path==='.env.renamed'));
 for(const a of calls.filter(a=>a.includes('diff')&&!a.includes('--name-status'))){assert.equal(a[0],'--literal-pathspecs');assert.ok(a.slice(a.indexOf('--')+1).includes(magic));assert.equal(a.includes('.env'),false);}
 const raw=Buffer.concat([Buffer.from(p+'/'),Buffer.from([0xff])]);fs.writeFileSync(raw,'old');git('add','--all');git('commit','--no-gpg-sign','-m','fixture raw name');fs.writeFileSync(raw,'new');const seen=[];
 await assert.rejects(purpose.collectMaterial({workspace:p,context:ctx},engine,{gitExec:async(a,c)=>{seen.push(a);return purpose.strictGit(a,c);}}),/non-UTF8/);assert.equal(seen.some(a=>a.includes('diff')&&!a.includes('--name-status')),false);
});

test('subdirectory refuses before body commands',async t=>{
 const {p,git}=repo(t);fs.mkdirSync(path.join(p,'sub'));fs.writeFileSync(path.join(p,'note'),'old');git('add','.');git('commit','--no-gpg-sign','-m','fixture only');const calls=[];await assert.rejects(purpose.collectMaterial({workspace:path.join(p,'sub'),context:ctx},engine,{gitExec:async(a,c)=>{calls.push(a);return purpose.strictGit(a,c);}}),e=>e.message===purpose.TOP_LEVEL);assert.equal(calls.some(a=>a.includes('diff')),false);
});
test('exact UTF8 purpose material is bounded, immutable and Pi-only',()=>{
 const o={head:'a'.repeat(40),paths:[{path:'note',status:'M',category:null,classification:'selected'}],selectedDiff:'😀'.repeat(16000)+'tail',selectedStatus:' M note\0',nativeReportedContext:ctx};
 const m=engine.prepareNativeWorkspaceCheckMaterial({contentObservation:o,nativeReportedContext:ctx,capturedAt:'2026-01-01T00:00:00.000Z'});
 assert.ok(Buffer.byteLength(m.deliveredEvidence)<=16384);assert.ok(Buffer.byteLength(m.exactPrompt)<=32768);assert.equal(m.exactPrompt.trim(),m.exactPrompt);purpose.assertRebuilt(m,engine);
 assert.throws(()=>purpose.assertRebuilt({...m,exactPrompt:m.exactPrompt+' '},engine));
 const target={campaignId:'c',attemptId:'a',turnRequestId:'t'};const pair={provider:'Fixture',model:'model',useExistingCapacity:true};const input={requestId:'request',goal:'fixture',workspacePath:os.tmpdir(),allowedInstances:['pi'],maxTurns:2,writeAuthorization:null,backgroundConsent:true,piCapacity:pair,nativeCheckTarget:target,nativeCheckMaterial:m};
 const n=require('./coordination-job.cjs').normalizeAdmissionInput(input);assert.equal(n.nativeCheckMaterial.exactPrompt,m.exactPrompt);
 for(const key of ['execute','continuation','executionFeedback','followUpMode']) assert.throws(()=>require('./coordination-job.cjs').normalizeAdmissionInput({...input,[key]:null}));
 const c=engine.buildNativeWorkspaceCheckCommand({...input,workspaceRoot:input.workspacePath});assert.equal(c.initialMessage.text,m.exactPrompt);assert.equal(c.promptDelivery,'stdin');assert.equal(c.modelSelection.instanceId,'pi');
});
test('one audit worker charges once, revokes unused read and never enters generic planner; stale/unknown never replay',async t=>{
 for(const outcome of ['returned','stale','unknown']) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'native-audit-worker-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const workspace=require('./coordination-job.cjs').workspaceIdentity(directory),target={campaignId:'campaign',attemptId:'attempt',turnRequestId:'turn'},pair={provider:'Fixture',model:'alpha',useExistingCapacity:true};
  const material=engine.prepareNativeWorkspaceCheckMaterial({contentObservation:{head:'a'.repeat(40),paths:[],selectedDiff:'diff fixture\n',selectedStatus:'',nativeReportedContext:ctx},nativeReportedContext:ctx,capturedAt:'2026-01-01T00:00:00Z'});
  const store=require('./coordination-job.cjs').createCoordinationJobStore(directory,{bootstrapReady:true});
  const input={requestId:'one-check',goal:'fixture',workspacePath:workspace,allowedInstances:['pi'],maxTurns:2,writeAuthorization:null,backgroundConsent:true,piCapacity:pair,nativeCheckTarget:target,nativeCheckMaterial:material};
  const admitted=store.startAdmission(input);delete require.cache[require.resolve('./coordination-scope.cjs')];const scope=require('./coordination-scope.cjs');let authorizations=0;const adapter={...scope,authorize:(...a)=>{authorizations++;return scope.authorize(...a);}};
  const snapshot={bounds:{projectionUnavailable:false,truncated:false},activeCampaignId:target.campaignId,attempt:{id:target.attemptId,taskId:'task',state:'waiting',provider:'codex'},activeTask:{id:'task',title:'fixture'},project:{workspaceRoot:workspace},decisions:[],productConversation:{runtime:{provider:'codex'},turn:{state:'completed',canStop:false}},turnResults:[{requestId:target.turnRequestId,replyState:'completed',replyText:'Reported reply',commands:[]}]};
  const core={invoke:async()=>snapshot,exchangeVerified:async q=>({ok:true,requestId:q.requestId,payload:{requestId:q.requestId,accepted:true,...(q.messageType==='goal_overview'?{overview:{truncated:false,goals:[{campaignId:target.campaignId,attention:'completed'}],pending:[]}}:{snapshot})}})};
  const providers=[{instanceId:'pi',displayName:'Pi',driver:'pi',installed:true,enabled:true,status:'ready',availability:'available',auth:{status:'unknown',type:'apiKey'},piCapacity:{workspacePath:workspace,offer:pair,catalog:[{provider:pair.provider,model:pair.model}]},models:[{slug:'alpha',isDefault:true}]}];
  const launched=[];const runtime={stateDir:directory,discover:async()=>({ok:true,providers}),prepare:async()=>({}),close(){},run:async c=>{launched.push(c);return {ok:outcome!=='unknown',text:outcome==='unknown'?'':'Concrete changed fixture line',messageDispatched:outcome==='unknown'?null:true};}};
  const endpoint=process.platform==='win32'?'\\\\.\\pipe\\native-audit-'+require('node:crypto').randomUUID():path.join(directory,'control.sock');
  await require('./coordination-worker.cjs').runWorker({directory,jobId:admitted.jobId,stateDir:directory,controlEndpoint:endpoint},{store,scope:adapter,engine:{...engine,requestCoordination(){throw Error('generic engine forbidden');}},runtime,core,discover:async()=>({ok:true,providers}),env:{GOALPORT_COORDINATE_SEND:'1'},recheckNativeMaterial:async(_r,m)=>{assert.equal(m.exactPrompt,material.exactPrompt);assert.equal(m.capturedAt,material.capturedAt);if(outcome==='stale')throw Error(purpose.STALE);}});
  const facts=store.getStatus(admitted.jobId);assert.equal(authorizations,1);assert.equal(launched.length,outcome==='stale'?0:1);assert.equal(scope.current(),null);
  if(outcome!=='stale'){assert.equal(launched[0].initialMessage.text,material.exactPrompt);assert.equal(launched[0].modelSelection.instanceId,'pi');assert.equal(facts.counters.readTurnsRemaining,1);}
  if(outcome==='returned'){assert.equal(facts.state,'completed');const record=require('./coordination-record.cjs').readRecords(directory)[0];assert.equal(record.recordKind,'native-workspace-check');assert.equal(record.planText,null);assert.equal(record.nativeCheckMaterial.exactPrompt,material.exactPrompt);}
  if(outcome==='unknown'){assert.equal(facts.state,'unconfirmed');assert.ok(facts.pendingCommand);assert.equal(facts.active,true);}
  assert.throws(()=>store.claimWorker(admitted.jobId),/already|replacement|unconfirmed|completed|claimed/);
 }
});

test('generic Electron path explicitly refuses purpose instead of calling host',async()=>{const result=await require('./coordination-background.cjs').backgroundStartReply({start(){throw Error('must not call');}},{nativeCheckTarget:{}});assert.equal(result.code,'background-invalid-admission');});
test('native kind is never a root or continuation ancestor, exact ID stays readable',()=>{const check={requestId:'n',goal:'fixture',workspacePath:'/fixture',recordKind:'native-workspace-check'};const child={requestId:'x',goal:'fixture',workspacePath:'/fixture',continuation:{parentRequestId:'n',rootRequestId:'n',originalGoal:'fixture',followUp:'next'}};const v=require('./saved-targets.cjs').resolveSavedTargets([check,child]);assert.equal(v.unique('n'),check);assert.equal(v.selected('n').rootRequestId,null);assert.equal(v.selected('x').rootRequestId,null);});
