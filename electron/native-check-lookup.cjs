"use strict";
const fs=require('node:fs');
const path=require('node:path');
const {createCoordinationJobStore}=require('./coordination-job.cjs');
// Read only. A malformed/ambiguous admission is not proof of absence.
function statusForRequest(directory,requestId) {
  const root=path.join(directory,'coordination-jobs','jobs');
  if(!fs.existsSync(root)) return null;
  const store=createCoordinationJobStore(directory,{bootstrapReady:true});
  const matches=[];
  for(const entry of fs.readdirSync(root,{withFileTypes:true})) {
    if(!entry.isDirectory() || !/^[0-9a-f-]{36}$/i.test(entry.name)) throw Error('Prior admission inventory is unavailable.');
    const facts=store.getStatus(entry.name);
    if(facts.requestId===requestId) matches.push(facts);
  }
  if(matches.length>1) throw Error('The check identity is ambiguous; nothing was replayed.');
  return matches[0] ?? null;
}
function requireSameTargetPair(facts,target,pair) {
  if(JSON.stringify(facts.admission.nativeCheckTarget)!==JSON.stringify(target) || JSON.stringify(facts.admission.piCapacity)!==JSON.stringify(pair)) throw Error('This request already belongs to a different target or Pi capacity.');
}
module.exports={statusForRequest,requireSameTargetPair};
