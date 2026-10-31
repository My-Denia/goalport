"use strict";
const fs = require('node:fs');
const path = require('node:path');
const { normalizePiCapacity, samePiPair, selectedPiEligible } = require('./pi-capacity.mjs');
const { createCoordinationJobStore, workspaceIdentity } = require('./coordination-job.cjs');
const { resolveSavedTargets } = require('./saved-targets.cjs');
function ownAdmissionForRequest(directory, requestId, platform=process.platform) {
  const jobsRoot=path.join(directory,'coordination-jobs','jobs');
  if(!fs.existsSync(jobsRoot)) return null;
  const store=createCoordinationJobStore(directory,{bootstrapReady:true,platform});
  const recordsFile=path.join(directory,'coordination-records.json');
  let records;
  try { records=fs.existsSync(recordsFile)?JSON.parse(fs.readFileSync(recordsFile,'utf8')):[]; }
  catch { records=null; } // Exact immutable-admission lookup does not depend on optional child context.
  const matches=[];
  for(const jobId of fs.readdirSync(jobsRoot).filter(id=>/^[0-9a-f-]{36}$/i.test(id))) {
    const status=store.getStatus(jobId), a=status.admission;
    if(a.requestId===requestId) { matches.push(a); continue; }
    const child=store.readOwnedLiveFollowUpContext(jobId,records);
    if(!child || child.requestId!==requestId || !Array.isArray(records) || records.filter(r=>r.requestId===requestId).length!==1) continue;
    const contextual = { ...a, requestId:child.requestId, goal:child.originalGoal, priorPlan:child.initialPlan, priorReview:child.initialReview,
      continuation:{parentRequestId:a.requestId,rootRequestId:child.rootRequestId,originalGoal:child.originalGoal,followUp:child.followUp} };
    delete contextual.executionFeedback;
    matches.push(contextual);
  }
  return matches.length===1 ? matches[0] : null;
}
// Resolves the existing parent/admission, never a caller-supplied legacy flag.
// No new permission, record, migration or budget is introduced.
function piAdmissionContext(input, directory, discovered, platform=process.platform) {
  const selected=(input.allowedInstances??input.readInstances??[]).includes('pi');
  if(!selected && !Object.hasOwn(input,'piCapacity')) return {};
  let selection=Object.hasOwn(input,'piCapacity')?normalizePiCapacity(input.piCapacity):undefined;
  if(Object.hasOwn(input,'piCapacity')&&!selection) throw new Error('The requested Pi capacity is malformed.');
  let legacy=false, existingRequest=false;
  if(!input.continuation && selection) {
    const own=ownAdmissionForRequest(directory,input.requestId,platform);
    if(own) {
      if(!samePiPair(own.piCapacity,selection)) throw new Error('This request conflicts with its immutable Pi route.');
      existingRequest=true;
    }
  }
  if(input.continuation) {
    const targets=resolveSavedTargets(JSON.parse(fs.readFileSync(path.join(directory,'coordination-records.json'),'utf8')));
    const c=input.continuation, parent=targets.selected(c.parentRequestId);
    if(!parent?.rootRequestId || parent.rootRequestId!==c.rootRequestId || targets.head(parent.rootRequestId)!==c.parentRequestId
       || targets.unique(parent.rootRequestId)?.goal?.trim()!==c.originalGoal?.trim()
       || workspaceIdentity(parent.record.workspacePath,platform)!==workspaceIdentity(input.workspacePath??input.workspaceRoot,platform)) throw new Error('The selected saved Pi goal is missing, ambiguous or changed.');
    const own=ownAdmissionForRequest(directory,c.parentRequestId,platform);
    if(!own || !own.allowedInstances.includes('pi') || own.goal.trim()!==parent.record.goal?.trim()
       || workspaceIdentity(own.workspacePath,platform)!==workspaceIdentity(parent.record.workspacePath,platform)) throw new Error("This saved goal's own Pi admission could not be confirmed.");
    if(Object.hasOwn(own,'piCapacity')) {
      const saved=normalizePiCapacity(parent.record.piCapacity);
      if(!saved || !samePiPair(saved,own.piCapacity) || (selection&&!samePiPair(selection,own.piCapacity))) throw new Error("Continue must retain this goal's recorded Pi route.");
      selection=own.piCapacity;
    } else {
      if(selection || Object.hasOwn(parent.record,'piCapacity')) throw new Error('This legacy Pi goal has no recorded requested route.');
      legacy=true;
    }
  } else if(!selection) throw new Error("Choose Use Pi's configured capacity for this new goal; nothing was admitted.");
  const pi=discovered?.ok === false ? undefined : discovered?.providers?.find(p=>p.instanceId==='pi');
  if(!selectedPiEligible(pi,selection,legacy)) throw new Error("This goal's requested Pi route is unavailable; nothing was admitted.");
  // A workspace review may name any catalog model; a goal keeps its configured route.
  const anyCatalogModel=Boolean(input.nativeCheckTarget);
  if(!input.continuation && !existingRequest && ((!anyCatalogModel && !samePiPair(selection,pi.piCapacity?.offer)) || pi.piCapacity?.provisional
      || workspaceIdentity(pi.piCapacity?.workspacePath,platform)!==workspaceIdentity(input.workspacePath??input.workspaceRoot,platform))) throw new Error('The configured Pi choice changed or belongs to another folder. Recheck this folder; nothing was admitted.');
  return { ...(selection?{piCapacity:{...selection}}:{}), legacyPiContinuation:legacy };
}
module.exports={piAdmissionContext,ownAdmissionForRequest};
