import {useEffect,useRef,useState} from 'react';
import {renderMarkdownBody} from '../lib/markdown';
import {normalizePiCapacity, selectedPiEligible, type PiCapacitySelection} from '../../electron/pi-capacity.mjs';
import {GoalLayer} from '../ui/GoalLayer';
import {BackgroundCoordinationStatus,PiReview} from './CoordinationStatus';
import {parseAllowanceStatus} from '../coordination/allowanceStatus';
import {parseNativeCheckMaterial,parseNativeCheckTarget,type NativeCheckMaterial,type NativeCheckTarget} from '../coordination/nativeWorkspaceCheck';
import type {BackgroundStatus} from '../coordination/backgroundStatus';
import type {ProviderSnapshot} from '../coordination/catalogFromProviders';

class CheckError extends Error {constructor(message:string,readonly previewAgain=false){super(message);}}
async function ipc(messageType:string,payload:unknown) {
  const desktop=window.goalportCore?.nativeCheck;
  const response=desktop?null:await fetch('/goalport/ipc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({messageType,payload})});
  const body=desktop?await desktop(messageType,payload):await response!.json();
  if((response && !response.ok) || body?.ok!==true) throw new CheckError(body?.error || 'Workspace check is unavailable.',body?.previewAgain===true);
  return body.payload;
}
interface SavedCheck {requestId:string;nativeCheckTarget:NativeCheckTarget;nativeCheckMaterial:NativeCheckMaterial;nativeAssociation:boolean;auditText?:string;savedAt?:string;statusLabel?:string}
interface PendingCheck {requestId:string;target:NativeCheckTarget;piCapacity:PiCapacitySelection}
const PENDING_KEY='goalport.nativeCheckCallerIntent';
// Caller identity only, like the existing send intent. Never material, Ready,
// authentication, consent or remaining budget; the server/store decides all of those.
function pendingCheck():PendingCheck|null {
  try {const x=JSON.parse(sessionStorage.getItem(PENDING_KEY)||'null');const t=parseNativeCheckTarget(x?.target),p=normalizePiCapacity(x?.piCapacity);return x && Object.keys(x).sort().join(',')==='piCapacity,requestId,target' && typeof x.requestId==='string' && /^[A-Za-z0-9._-]{1,256}$/.test(x.requestId) && t && p ? {requestId:x.requestId,target:t,piCapacity:p}:null;}catch{return null;}
}
function retainPending(value:PendingCheck){try{sessionStorage.setItem(PENDING_KEY,JSON.stringify(value));}catch{/* Keep the same caller in memory if storage is unavailable. */}}
function clearPending(requestId:string){try{if(pendingCheck()?.requestId===requestId)sessionStorage.removeItem(PENDING_KEY);}catch{/* No permission is stored here. */}}
function CheckMessage({text,pending}:{text:string;pending:boolean}) {
  const plain=text==='Workspace or target changed. Preview again.' || text==="This check currently needs the repository's top-level folder." || text.startsWith('No tracked changes to check;') || text.startsWith('No shareable tracked changes;');
  return <div role="alert"><p>{plain?text:pending?"We couldn't confirm Pi got this. Check on it and it won't be sent twice.":"Pi can't review this right now. Your conversation is safe."}</p>{!plain?<details><summary>Technical details</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:160,overflow:'auto'}}>{text}</pre></details>:null}</div>;
}
/** User sees every shared byte before choosing one separate readonly check. */
export function NativeWorkspaceCheck({campaignId,target,eligible,job,onJob,onBusy,onAskCodex}:{campaignId?:string;target:NativeCheckTarget|null;eligible:boolean;job:BackgroundStatus|null;onJob:(job:BackgroundStatus)=>void;onBusy:(busy:boolean)=>void;onAskCodex?:(text:string)=>void}) {
  const campaign=target?.campaignId ?? campaignId ?? '';
  const [pending,setPending]=useState<PendingCheck|null>(pendingCheck);
  const [workspace,setWorkspace]=useState<string|null>(null);
  const [capacityReason,setCapacityReason]=useState<string|null>(null);
  const [open,setOpen]=useState(false),[offer,setOffer]=useState<PiCapacitySelection|null>(pending?.piCapacity??null),[consent,setConsent]=useState(false),[material,setMaterial]=useState<NativeCheckMaterial|null>(null),[exclusions,setExclusions]=useState<string[]>([]),[error,setError]=useState<string|null>(null),[busy,setBusy]=useState(false),[unknown,setUnknown]=useState(Boolean(pending)),[saved,setSaved]=useState<SavedCheck[]>([]);
  const request=useRef(pending?.requestId??'native-check-'+crypto.randomUUID()),revision=useRef(0),current=useRef(target),panel=useRef<HTMLElement|null>(null);current.current=target;
  const targetKey=JSON.stringify(target);
  const changeOpen=(next:boolean)=>{setOpen(next);if(!next && !unknown)setMaterial(null);};
  useEffect(()=>{revision.current++;setOpen(false);setMaterial(null);setWorkspace(null);setCapacityReason(null);setError(null);setBusy(false);const prior=pendingCheck()??pending;setPending(prior);setUnknown(Boolean(prior));setOffer(prior?.piCapacity??null);request.current=prior?.requestId??'native-check-'+crypto.randomUUID();},[targetKey]);
  useEffect(()=>{onBusy(Boolean(pending));},[pending,onBusy]);
  useEffect(()=>{if(pending && job?.requestId===pending.requestId && JSON.stringify(job.nativeCheckTarget)===JSON.stringify(pending.target) && JSON.stringify(normalizePiCapacity(job.piCapacity))===JSON.stringify(pending.piCapacity)){clearPending(pending.requestId);setPending(null);setUnknown(false);setOpen(false);setMaterial(null);}},[job,pending]);
  useEffect(()=>{let cancelled=false;void ipc('coordination_list',{nativeCampaignId:campaign}).then(value=>{
    if(cancelled)return;
    const checks=Array.isArray(value?.checks)?value.checks:[];
    setSaved(checks.filter((c:SavedCheck)=>c?.nativeAssociation===true && parseNativeCheckTarget(c.nativeCheckTarget)?.campaignId===campaign && parseNativeCheckMaterial(c.nativeCheckMaterial)));
  }).catch(()=>{if(!cancelled)setSaved([]);});return()=>{cancelled=true;};},[campaign,job?.state,job?.requestId]);
  async function prepare() {
    if(!target)return;
    const generation=++revision.current, frozen=target;
    setBusy(true);setError(null);setMaterial(null);
    try {
      const first=await ipc('native_workspace_check_prepare',{requestId:request.current,...frozen});
      if(generation!==revision.current || JSON.stringify(current.current)!==JSON.stringify(frozen))return;
      if(typeof first?.workspacePath!=='string' || !/^(\/|[A-Za-z]:[\\/])/.test(first.workspacePath) || first.workspacePath.includes('\0'))throw Error('The native goal folder could not be confirmed.');
      const provider=first?.offer as ProviderSnapshot|undefined;const pair=normalizePiCapacity(provider?.piCapacity?.offer);
      setOffer(pair);setConsent(first?.backgroundSendConsent===true);
      if(!pair || !selectedPiEligible(provider,pair)){setCapacityReason(provider?.piCapacity?.reason || 'Pi isn’t set up for this goal yet.');return;}
      setCapacityReason(null);
      const reply=await ipc('native_workspace_check_prepare',{requestId:request.current,...frozen,piCapacity:pair});
      if(generation!==revision.current || JSON.stringify(current.current)!==JSON.stringify(frozen))return;
      if(reply?.empty){setError(reply.message || 'No tracked changes to check; Pi was not called.');return;}
      const parsed=parseNativeCheckMaterial(reply?.nativeCheckMaterial);
      if(!parsed || JSON.stringify(parseNativeCheckTarget(reply?.nativeCheckTarget))!==JSON.stringify(frozen) || reply.requestId!==request.current || JSON.stringify(normalizePiCapacity(reply.piCapacity))!==JSON.stringify(pair))throw Error('The exact preview is unavailable. Preview again.');
      setMaterial(parsed);setExclusions(Array.isArray(reply.uiExclusions)?reply.uiExclusions.map((x:{path?:unknown})=>String(x.path ?? '')):[]);
    }catch(e){if(generation===revision.current)setError(e instanceof Error?e.message:'Workspace check is unavailable.');}
    finally{if(generation===revision.current)setBusy(false);}
  }
  async function start(){
    if(busy || (!pending && (!target || !offer || !material)))return;
    const frozen=pending?.target??target,frozenPair=pending?.piCapacity??offer,frozenRequest=pending?.requestId??request.current,generation=revision.current;
    if(!frozen || !frozenPair)return;
    if(!consent && !pending){setBusy(true);try{await ipc('coordination_grant',{});setConsent(true);}catch(e){setBusy(false);setError(e instanceof Error?e.message:'Workspace check is unavailable.');return;}if(generation!==revision.current){setBusy(false);return;}}
    const intent={requestId:frozenRequest,target:frozen,piCapacity:frozenPair};retainPending(intent);setPending(intent);
    let holdPending=true;
    setBusy(true);onBusy(true);setError(null);
    try {
      const reply=await ipc('native_workspace_check_start',{requestId:frozenRequest,...frozen,piCapacity:frozenPair,backgroundConsent:true});
      const parsed=parseAllowanceStatus({source:'host-status',jobId:reply?.job?.jobId,job:reply?.job},reply?.job?.jobId);
      if(parsed?.source!=='host-status' || parsed.job.requestId!==frozenRequest || JSON.stringify(normalizePiCapacity(parsed.job.piCapacity))!==JSON.stringify(frozenPair) || JSON.stringify(parsed.job.nativeCheckTarget)!==JSON.stringify(frozen))throw Error('The check start is not confirmed. Keep this request and check its result.');
      holdPending=false;clearPending(frozenRequest);setPending(p=>p?.requestId===frozenRequest?null:p);onJob(parsed.job);
      if(generation===revision.current){setOpen(false);setMaterial(null);setUnknown(false);}
    }catch(e){const message=e instanceof Error?e.message:'The check start is not confirmed.';const stale=e instanceof CheckError && e.previewAgain;if(stale){holdPending=false;clearPending(frozenRequest);setPending(p=>p?.requestId===frozenRequest?null:p);}if(generation===revision.current){setUnknown(!stale);if(stale)setMaterial(null);setError(message);}}
    finally{setBusy(false);onBusy(holdPending);}
  }
  async function stop(){if(!job)return;setError(null);try{await ipc('coordination_stop',{jobId:job.jobId});onJob({...job,revoked:true});}catch(e){setError(e instanceof Error?e.message:'Stop check is not confirmed.');}}
  async function leave(){if(!job)return;setError(null);try{const reply=await ipc('coordination_acknowledge',{jobId:job.jobId});onJob(reply?.job?.jobId===job.jobId?reply.job:{...job,acknowledgedStuckAt:new Date().toISOString()});}catch(e){setError(e instanceof Error?e.message:'Leaving the check is not confirmed.');}}
  const owns=job?.nativeCheckTarget?.campaignId===campaign;
  const holding=Boolean(job?.active&&!job.acknowledgedStuckAt);
  // The first start waits on the host for a minute or more; only a reply lost after that is an earlier request.
  const starting=Boolean(pending)&&busy&&!unknown;
  const shared=material?.contentObservation.paths.filter(p=>p.classification==='selected').map(p=>p.path)??[];
  useEffect(()=>{if(owns&&job&&typeof panel.current?.scrollIntoView==='function')panel.current.scrollIntoView({block:'nearest'});},[owns,job?.requestId,job?.active]);
  return <section ref={panel} className="native-workspace-check">
    <GoalLayer variant="dialog" modalCard label="Ask Pi to review" open={open} onOpenChange={changeOpen} trigger={undefined}>
      <h2>Ask Pi to review Codex's changes</h2>
      {pending&&!starting?<p role="status">Your earlier request may still be running. Check on it here; it won't be sent twice.</p>:<p>Pi reads what changed and replies beside this goal. It can't edit your files, and it keeps going if you close the window.</p>}
      {material&&offer?<ul className="check-summary"><li><strong>Changes:</strong> {shared.slice(0,3).join(', ')}{shared.length>3?` and ${shared.length-3} more`:''}</li><li><strong>Also shared:</strong> Codex's last reply</li><li><strong>Sent to:</strong> {offer.provider}/{offer.model}</li>{exclusions.length?<li><strong>Left out:</strong> {exclusions.length} private {exclusions.length===1?'file':'files'}</li>:null}</ul>:null}
      {material?<p>Check it first if these changes might contain secrets.{consent?'':' Sending also lets future reviews keep going after you close the window.'}</p>:null}
      {material?<details><summary>See exactly what's sent</summary><pre aria-label="Complete Pi payload" style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:320,overflow:'auto'}}>{material.exactPrompt}</pre>{exclusions.length?<ul>{exclusions.map(p=><li key={p}>{p}</li>)}</ul>:null}</details>:null}
      {busy&&!material&&!pending?<p role="status">Reading your changes…</p>:null}
      {capacityReason?<p role="status">{capacityReason}</p>:null}
      {error?<CheckMessage text={error} pending={Boolean(pending)}/>:null}
      {starting?<p role="status">Sending to Pi. This can take a minute.</p>:null}
      <div className="dialog-actions"><button type="button" className="button button-outline" disabled={busy||unknown} onClick={()=>changeOpen(false)}>Cancel</button><button type="button" className="button button-primary" disabled={busy||(!pending&&!material)} onClick={()=>{void start();}}>{starting?'Sending…':unknown?'Check on it':'Send to Pi'}</button></div>
    </GoalLayer>
    {owns && job?<BackgroundCoordinationStatus job={job} onStopAllowing={()=>{void stop();}} onLeave={()=>{void leave();}} onAskCodex={onAskCodex}/>:null}
    {(owns&&holding)||(!eligible&&!pending)?null:<button type="button" className="button button-small button-outline" disabled={busy||(!pending&&(!target||!eligible||holding))} onClick={()=>{setOpen(true);if(!pending){request.current='native-check-'+crypto.randomUUID();void prepare();}}}>{starting?'Sending to Pi…':pending?'Check on your earlier request':'Ask Pi to review'}</button>}
    {!open && error?<CheckMessage text={error} pending={Boolean(pending)}/>:null}
    {saved.filter(s=>s.requestId!==job?.requestId).map(s=><details key={s.requestId}><summary>Pi's review · {s.savedAt?new Date(s.savedAt).toLocaleString():'Saved'}{s.nativeCheckTarget.turnRequestId!==target?.turnRequestId?' · earlier turn':''}</summary><PiReview text={s.auditText ?? ''} id={s.requestId}/><details><summary>What Pi was sent</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:320,overflow:'auto'}}>{s.nativeCheckMaterial.exactPrompt}</pre></details></details>)}
  </section>;
}
