"use strict";
// Purpose data and collection only. No scope, launcher, ownership or replay authority.
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { workspaceIdentity } = require('./coordination-job.cjs');
const { captureWorkspaceBaseline, captureWorkspaceEvidence, truncateUtf8 } = require('./execution-workspace-evidence.cjs');
const { guardCoreCoverage } = require('./coordination-core-guard.cjs');
const STALE = 'Workspace or target changed. Preview again.';
const TOP_LEVEL = "This check currently needs the repository's top-level folder.";
const plain = x => !!x && typeof x === 'object' && !Array.isArray(x);
function closed(x, keys) { if (!plain(x) || Object.keys(x).some(k => !keys.includes(k))) throw Error('Malformed workspace check material.'); }
function exact(x, max, empty = true) { if (typeof x !== 'string' || (!empty && !x) || Buffer.byteLength(x) > max || Buffer.from(x).toString('utf8') !== x) throw Error('Workspace check text exceeds its UTF-8 bound.'); return x; }
function targetOf(x) {
  closed(x, ['campaignId','attemptId','turnRequestId']);
  const result = {};
  for (const key of ['campaignId','attemptId','turnRequestId']) { const v = exact(x[key],256,false); if (!/^[A-Za-z0-9._-]+$/.test(v)) throw Error('Invalid workspace check target.'); result[key]=v; }
  return result;
}
function materialOf(x) {
  closed(x, ['exactPrompt','deliveredEvidence','coverage','contentObservation','nativeReportedContext','capturedAt','disclosureVersion']);
  if (x.disclosureVersion !== 1 || !Number.isFinite(Date.parse(x.capturedAt))) throw Error('Malformed workspace check disclosure.');
  const o=x.contentObservation,c=x.nativeReportedContext,v=x.coverage;
  closed(o,['head','paths','selectedDiff','selectedStatus','nativeReportedContext']);
  if(!/^[a-f0-9]{40,64}$/.test(o.head) || !Array.isArray(o.paths) || o.paths.length>512) throw Error('Malformed workspace path observation.');
  exact(o.selectedDiff,65536,false);exact(o.selectedStatus,65536);
  for(const p of o.paths){closed(p,['path','status','category','classification']);exact(p.path,1024,false);if(!/^[ACDMTUXB]$/.test(p.status) || !['selected','excluded','omitted'].includes(p.classification) || ![null,'private-directory','environment','credentials','key-file'].includes(p.category))throw Error('Malformed workspace path classification.');}
  closed(c,['reply','replyTruncated','commands','commandsOmitted','commandsTruncated','filesTruncated','comparisonUnavailable','olderTurnsOmitted']);exact(c.reply,4096);
  if(!Array.isArray(c.commands)||c.commands.length>6||!['replyTruncated','commandsTruncated','filesTruncated','comparisonUnavailable'].every(k=>typeof c[k]==='boolean')||!['commandsOmitted','olderTurnsOmitted'].every(k=>Number.isSafeInteger(c[k])&&c[k]>=0))throw Error('Malformed Native context.');
  for(const command of c.commands){closed(command,['command','cwd','state','exitCode','output','truncated']);for(const k of ['command','cwd','output'])exact(command[k],400);if(!['started','completed','failed'].includes(command.state)||typeof command.truncated!=='boolean'||!(command.exitCode===null||Number.isSafeInteger(command.exitCode)))throw Error('Malformed reported Native command.');}
  if(JSON.stringify(o.nativeReportedContext)!==JSON.stringify(c))throw Error('Native context does not match the observation.');
  closed(v,['limited','excluded','omitted','selected','evidenceCropped','excludedCategories']);
  if(typeof v.limited!=='boolean'||typeof v.evidenceCropped!=='boolean'||!['excluded','omitted','selected'].every(k=>Number.isInteger(v[k])&&v[k]>=0&&v[k]<=512)||!Array.isArray(v.excludedCategories)||v.excludedCategories.some(k=>!['private-directory','environment','credentials','key-file'].includes(k)))throw Error('Malformed workspace coverage.');
  const result = {exactPrompt:exact(x.exactPrompt,32768,false),deliveredEvidence:exact(x.deliveredEvidence,16384,false),coverage:x.coverage,contentObservation:x.contentObservation,nativeReportedContext:x.nativeReportedContext,capturedAt:x.capturedAt,disclosureVersion:1};
  // Structured material is JSON-only, bounded and canonicalized without trimming text.
  for (const key of ['coverage','contentObservation','nativeReportedContext']) { if (!plain(x[key])) throw Error('Malformed workspace check observation.'); exact(JSON.stringify(x[key]), key === 'contentObservation' ? 180000 : 20000); }
  if (Buffer.byteLength(JSON.stringify(result)) > 256*1024) throw Error('Workspace check packet is too large.');
  return JSON.parse(JSON.stringify(result));
}
function purposeOf(input) {
  if (!Object.hasOwn(input,'nativeCheckTarget') && !Object.hasOwn(input,'nativeCheckMaterial')) return {};
  closed(input,['requestId','goal','workspacePath','allowedInstances','maxTurns','writeAuthorization','backgroundConsent','piCapacity','nativeCheckTarget','nativeCheckMaterial','priorPlan','priorReview','avoidInstances']);
  if(input.avoidInstances !== undefined && JSON.stringify(input.avoidInstances)!=='[]') throw Error('Workspace checks cannot change the selected Pi role.');
  for (const key of ['continuation','executionFeedback','followUpMode','execute']) if (Object.hasOwn(input,key)) throw Error('Workspace checks cannot continue or execute work.');
  if (input.writeAuthorization !== null || input.backgroundConsent !== true || JSON.stringify(input.allowedInstances) !== '["pi"]' || input.maxTurns !== 2 || !input.piCapacity || input.priorPlan != null || input.priorReview != null) throw Error('Workspace checks require only Pi, two reads and no writes.');
  return {nativeCheckTarget:targetOf(input.nativeCheckTarget),nativeCheckMaterial:materialOf(input.nativeCheckMaterial)};
}
function strictGit(args,cwd) {
  return new Promise(resolve => execFile('git',args,{cwd,windowsHide:true,maxBuffer:4*1024*1024,encoding:'buffer'},(error,stdout,stderr)=>{
    try { const decode=b=>new TextDecoder('utf-8',{fatal:true}).decode(b); resolve({code:error ? 1 : 0,stdout:decode(stdout ?? Buffer.alloc(0)),stderr:decode(stderr ?? Buffer.alloc(0))}); }
    catch { resolve({code:1,stdout:'',stderr:'Malformed or non-UTF8 Git metadata/content.'}); }
  }));
}
function excludedCategory(name) {
  const parts=name.toLowerCase().split('/'), base=parts.at(-1);
  if(parts.some(p=>['.git','.ssh','.gnupg','.aws','.azure'].includes(p))) return 'private-directory';
  if(base === '.env' || base.startsWith('.env.')) return 'environment';
  if(['auth.json','models.json','credentials','credentials.json','id_rsa','id_ed25519'].includes(base)) return 'credentials';
  if(/\.(pem|key|p12|pfx)$/.test(base)) return 'key-file';
  return null;
}
function classifyMetadata(raw) {
  exact(raw,65536);
  if(raw && !raw.endsWith('\0')) throw Error('Malformed Git path metadata.');
  const fields=raw ? raw.slice(0,-1).split('\0') : [];
  if(fields.length%2 || fields.length>1024) throw Error('Malformed Git path metadata or bounded inventory exceeded.');
  const paths=[],seen=new Set();
  for(let i=0;i<fields.length;i+=2) {
    const status=fields[i], name=fields[i+1];
    if(!/^[ACDMTUXB]$/.test(status) || !name || name.includes('\\') || name.startsWith('/') || name.split('/').some(p=>!p || p==='.' || p==='..') || Buffer.byteLength(name)>1024 || seen.has(name)) throw Error('Malformed or unsafe Git path metadata.');
    seen.add(name); paths.push({path:name,status,category:excludedCategory(name)});
  }
  paths.sort((a,b)=>Buffer.compare(Buffer.from(a.path),Buffer.from(b.path)));
  let bytes=0,count=0;
  return paths.map(row=>{ const size=Buffer.byteLength(row.path)+1; const selected=!row.category && count<80 && bytes+size<=16384; if(selected){count++;bytes+=size;} return {...row,classification:row.category?'excluded':selected?'selected':'omitted'}; });
}
async function metadata(workspace,git) {
  const root=await git(['-C',workspace,'rev-parse','--show-toplevel'],workspace);
  if(root.code!==0) throw Error('Workspace Git inspection is unavailable.');
  if(workspaceIdentity(root.stdout.trim())!==workspaceIdentity(workspace) || !workspaceIdentity(workspace)) throw Error(TOP_LEVEL);
  const head=await git(['-C',workspace,'rev-parse','HEAD'],workspace);
  if(head.code!==0 || !/^[a-f0-9]{40,64}$/.test(head.stdout.trim())) throw Error('Workspace HEAD is unavailable.');
  const names=await git(['--literal-pathspecs','-C',workspace,'diff','--no-ext-diff','--no-textconv','--no-renames','--name-status','-z','HEAD','--','.'],workspace);
  if(names.code!==0) throw Error(names.stderr || 'Workspace path inventory is unavailable.');
  return {head:head.stdout.trim(),paths:classifyMetadata(names.stdout)};
}
function nativeContext(snapshot,turn) {
  const crop=(s,n)=>truncateUtf8(typeof s==='string'?s:'',n);
  const reply=crop(turn.replyText,4096);
  if(!Array.isArray(turn.commands)) throw Error('Native command context is unavailable.');
  const commands=turn.commands.slice(0,6).map(c=>{
    if(!plain(c) || typeof c.command!=='string' || !['started','completed','failed'].includes(c.state)) throw Error('Malformed Native reported command.');
    const command=crop(c.command,400),cwd=crop(c.cwd,400),output=crop(c.output,400);
    return {command:command.text,cwd:cwd.text,state:c.state,exitCode:Number.isInteger(c.exitCode)?c.exitCode:null,output:output.text,truncated:command.truncated||cwd.truncated||output.truncated};
  });
  return {reply:reply.text,replyTruncated:reply.truncated||turn.replyTruncated===true,commands,commandsOmitted:Math.max(0,turn.commands.length-6),commandsTruncated:turn.commandsTruncated===true,filesTruncated:turn.filesTruncated===true,comparisonUnavailable:turn.comparisonUnavailable===true,olderTurnsOmitted:snapshot.bounds?.omittedCounts?.turnResults ?? 0};
}
async function resolveTarget(core,selected,target) {
  target=targetOf(target);
  await guardCoreCoverage(core,selected);
  const requestId=`native-check-detail-${require('node:crypto').randomUUID()}`;
  const response=await core.exchangeVerified({protocolVersion:'goalport.ipc.v2',requestId,entityVersion:0,messageType:'goal_detail',payload:{campaignId:target.campaignId}});
  const s=response?.payload?.snapshot;
  if(response?.ok===false || response?.requestId!==requestId || response?.payload?.requestId!==requestId || response?.payload?.accepted!==true || !s) throw Error(STALE);
  const turns=s.turnResults, turn=Array.isArray(turns)?turns.at(-1):null;
  if(s.activeCampaignId!==target.campaignId || s.attempt?.id!==target.attemptId || s.attempt?.provider!=='codex' || !['waiting','completed'].includes(s.attempt?.state) || s.productConversation?.runtime?.provider!=='codex' || s.productConversation?.turn?.state!=='completed' || s.productConversation?.turn?.canStop!==false || !s.activeTask?.id || s.attempt.taskId!==s.activeTask.id || !turn || turn.requestId!==target.turnRequestId || turn.replyState!=='completed' || turns.filter(t=>t.requestId===target.turnRequestId).length!==1 || s.decisions?.length) throw Error(STALE);
  // Do not substitute target detail for the whole-inventory guard above.
  const problem=require('./coordination-core-guard.cjs').coreRefusal(s); if(problem) throw Error(problem);
  const workspace=workspaceIdentity(s.project?.workspaceRoot);
  if(!workspace || !fs.statSync(workspace).isDirectory()) throw Error('Native workspace is unavailable.');
  return {workspace,goal:s.activeTask.title || 'Native workspace check',taskId:s.activeTask.id,target,context:nativeContext(s,turn)};
}
async function collectMaterial(resolved,engine,{gitExec=strictGit,capturedAt}={}) {
  const {workspace,context}=resolved;
  const before=await metadata(workspace,gitExec);
  const trackedPaths=before.paths.filter(p=>p.classification==='selected').map(p=>p.path);
  const options={gitExec,trackedPaths,maxUntrackedFiles:0,maxDiffBytes:65536};
  const baseline=await captureWorkspaceBaseline(workspace,options);
  const evidence=await captureWorkspaceEvidence(workspace,baseline,options);
  const after=await metadata(workspace,gitExec);
  if(baseline.status==='unavailable' || evidence.status==='unavailable' || baseline.truncated || evidence.truncated || typeof baseline.beforeDiff!=='string' || typeof evidence.afterDiff!=='string' || typeof baseline.selectedStatus!=='string' || typeof evidence.selectedStatus!=='string') throw Error(baseline.reason || evidence.reason || 'Selected diff could not be fully captured.');
  const observation={...before,selectedDiff:baseline.beforeDiff,selectedStatus:baseline.selectedStatus,nativeReportedContext:context};
  const endObservation={...after,selectedDiff:evidence.afterDiff,selectedStatus:evidence.selectedStatus,nativeReportedContext:context};
  if(JSON.stringify(observation)!==JSON.stringify(endObservation)) throw Error(STALE);
  const uiExclusions=before.paths.filter(p=>p.classification!=='selected');
  if(!observation.selectedDiff) return {empty:true,message:uiExclusions.length?`No shareable tracked changes; ${uiExclusions.length} paths excluded/omitted; Pi was not called.`:'No tracked changes to check; Pi was not called.',uiExclusions};
  const material=engine.prepareNativeWorkspaceCheckMaterial({contentObservation:observation,nativeReportedContext:context,capturedAt:capturedAt ?? new Date().toISOString()});
  return {nativeCheckMaterial:materialOf(material),uiExclusions};
}
function assertRebuilt(material,engine) {
  const canonical=materialOf(material);
  const rebuilt=engine.prepareNativeWorkspaceCheckMaterial({contentObservation:canonical.contentObservation,nativeReportedContext:canonical.nativeReportedContext,capturedAt:canonical.capturedAt});
  if(JSON.stringify(materialOf(rebuilt))!==JSON.stringify(canonical)) throw Error('Workspace check material does not match its exact preview.');
}
async function recheckMaterial(resolved,material,engine,options) {
  assertRebuilt(material,engine);
  const fresh=await collectMaterial(resolved,engine,{...options,capturedAt:material.capturedAt});
  if(fresh.empty || JSON.stringify(fresh.nativeCheckMaterial)!==JSON.stringify(material)) throw Error(STALE);
}
module.exports={STALE,TOP_LEVEL,targetOf,materialOf,purposeOf,strictGit,classifyMetadata,excludedCategory,resolveTarget,collectMaterial,assertRebuilt,recheckMaterial};
