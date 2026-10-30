import {useEffect,useRef,useState} from 'react';
import {renderMarkdownBody} from '../lib/markdown';
import {normalizePiCapacity, selectedPiEligible, type PiCapacitySelection} from '../../electron/pi-capacity.mjs';
import {GoalLayer} from '../ui/GoalLayer';
import {PiCapacityControl} from './PiCapacityControl';
import {BackgroundCoordinationStatus} from './CoordinationStatus';
import {parseAllowanceStatus} from '../coordination/allowanceStatus';
import {parseNativeCheckMaterial,parseNativeCheckTarget,type NativeCheckMaterial,type NativeCheckTarget} from '../coordination/nativeWorkspaceCheck';
import type {BackgroundStatus} from '../coordination/backgroundStatus';
import type {ProviderSnapshot} from '../coordination/catalogFromProviders';

class CheckError extends Error {constructor(message:string,readonly previewAgain=false){super(message);}}
async function ipc(messageType:string,payload:unknown) {
  const response=await fetch('/goalport/ipc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({messageType,payload})});
  const body=await response.json();
  if(!response.ok || body?.ok!==true) throw new CheckError(body?.error || 'Workspace check is unavailable.',body?.previewAgain===true);
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
  return <div role="alert"><p>{plain?text:pending?'The check is not confirmed. Check its result using the same request.':'Workspace check is unavailable. Your native conversation is kept.'}</p>{!plain?<details><summary>Technical details</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:160,overflow:'auto'}}>{text}</pre></details>:null}</div>;
}
/** User sees every shared byte before choosing one separate readonly check. */
export function NativeWorkspaceCheck({campaignId,target,eligible,job,onJob,onBusy}:{campaignId?:string;target:NativeCheckTarget|null;eligible:boolean;job:BackgroundStatus|null;onJob:(job:BackgroundStatus)=>void;onBusy:(busy:boolean)=>void}) {
  const campaign=target?.campaignId ?? campaignId ?? '';
  const [pending,setPending]=useState<PendingCheck|null>(pendingCheck);
  const [workspace,setWorkspace]=useState<string|null>(null);
  const [capacityReason,setCapacityReason]=useState<string|null>(null);
  const [open,setOpen]=useState(false),[offer,setOffer]=useState<PiCapacitySelection|null>(pending?.piCapacity??null),[checked,setChecked]=useState(Boolean(pending)),[consent,setConsent]=useState(false),[material,setMaterial]=useState<NativeCheckMaterial|null>(null),[exclusions,setExclusions]=useState<string[]>([]),[error,setError]=useState<string|null>(null),[busy,setBusy]=useState(false),[unknown,setUnknown]=useState(Boolean(pending)),[saved,setSaved]=useState<SavedCheck[]>([]);
  const request=useRef(pending?.requestId??'native-check-'+crypto.randomUUID()),revision=useRef(0),current=useRef(target);current.current=target;
  const targetKey=JSON.stringify(target);
  const changeOpen=(next:boolean)=>{setOpen(next);if(!next && !unknown){setMaterial(null);setChecked(false);}};
  useEffect(()=>{revision.current++;setOpen(false);setMaterial(null);setWorkspace(null);setCapacityReason(null);setError(null);setBusy(false);const prior=pendingCheck()??pending;setPending(prior);setChecked(Boolean(prior));setUnknown(Boolean(prior));setOffer(prior?.piCapacity??null);request.current=prior?.requestId??'native-check-'+crypto.randomUUID();},[targetKey]);
  useEffect(()=>{onBusy(Boolean(pending));},[pending,onBusy]);
  useEffect(()=>{if(pending && job?.requestId===pending.requestId && JSON.stringify(job.nativeCheckTarget)===JSON.stringify(pending.target) && JSON.stringify(normalizePiCapacity(job.piCapacity))===JSON.stringify(pending.piCapacity)){clearPending(pending.requestId);setPending(null);setUnknown(false);setOpen(false);setMaterial(null);setChecked(false);}},[job,pending]);
  useEffect(()=>{let cancelled=false;void ipc('coordination_list',{nativeCampaignId:campaign}).then(value=>{
    if(cancelled)return;
    const checks=Array.isArray(value?.checks)?value.checks:[];
    setSaved(checks.filter((c:SavedCheck)=>c?.nativeAssociation===true && parseNativeCheckTarget(c.nativeCheckTarget)?.campaignId===campaign && parseNativeCheckMaterial(c.nativeCheckMaterial)));
  }).catch(()=>{if(!cancelled)setSaved([]);});return()=>{cancelled=true;};},[campaign,job?.state,job?.requestId]);
  async function prepare(withPair:boolean) {
    if(!target)return;
    const generation=++revision.current, frozen=target;
    setBusy(true);setError(null);setMaterial(null);
    try {
      const reply=await ipc('native_workspace_check_prepare',{requestId:request.current,...frozen,...(withPair && offer?{piCapacity:offer}:{})});
      if(generation!==revision.current || JSON.stringify(current.current)!==JSON.stringify(frozen))return;
      if(typeof reply?.workspacePath!=='string' || !reply.workspacePath.startsWith('/') || reply.workspacePath.includes('\0'))throw Error('The native goal folder could not be confirmed.');
      setWorkspace(reply.workspacePath);
      if(!withPair){const provider=reply?.offer as ProviderSnapshot|undefined;const pair=normalizePiCapacity(provider?.piCapacity?.offer);setOffer(pair);setConsent(reply?.backgroundSendConsent===true);setCapacityReason(pair && selectedPiEligible(provider,pair)?null:provider?.piCapacity?.reason || 'Pi’s configured capacity is unavailable for this goal.');}
      else if(reply?.empty){setError(reply.message || 'No tracked changes to check; Pi was not called.');}
      else {const parsed=parseNativeCheckMaterial(reply?.nativeCheckMaterial);if(!parsed || JSON.stringify(parseNativeCheckTarget(reply?.nativeCheckTarget))!==JSON.stringify(frozen) || reply.requestId!==request.current || JSON.stringify(normalizePiCapacity(reply.piCapacity))!==JSON.stringify(offer))throw Error('The exact preview is unavailable. Preview again.');setMaterial(parsed);setExclusions(Array.isArray(reply.uiExclusions)?reply.uiExclusions.map((x:{path?:unknown})=>String(x.path ?? '')):[]);}
    }catch(e){if(generation===revision.current)setError(e instanceof Error?e.message:'Workspace check is unavailable.');}
    finally{if(generation===revision.current)setBusy(false);}
  }
  async function start(){
    if(busy || (!pending && (!target || !offer || !checked || !consent || !material)))return;
    const frozen=pending?.target??target,frozenPair=pending?.piCapacity??offer,frozenRequest=pending?.requestId??request.current,generation=revision.current;
    if(!frozen || !frozenPair)return;
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
  const owns=job?.nativeCheckTarget?.campaignId===campaign;
  // The first start waits on the host for a minute or more; only a reply lost after that is an earlier request.
  const starting=Boolean(pending)&&busy&&!unknown;
  return <section className="native-workspace-check" style={{minWidth:0,maxWidth:960,marginInline:'auto'}}>
    <GoalLayer variant="dialog" modalCard label="Check workspace with Pi" open={open} onOpenChange={changeOpen} trigger={undefined}>
      <h2>Check workspace with Pi</h2>
      {!pending && workspace?<p aria-label="Check folder" style={{overflowWrap:'anywhere'}}>Folder: {workspace}</p>:null}
      {pending&&!starting?<p role="status">This is an existing submitted check request, not a new check. Check result keeps its original target and Pi pair; it never selects the goal currently on screen.</p>:null}
      <p>One independent response to the current tracked changes, kept beside this goal. It may include preexisting or concurrent edits, not only Codex’s work.</p>
      {offer?<PiCapacityControl capacity={offer} checked={checked} disabled={busy||unknown||Boolean(capacityReason)} onChange={enabled=>{revision.current++;setChecked(enabled);setMaterial(null);setError(null);}}/>:null}
      {capacityReason?<p role="status">{capacityReason}</p>:null}
      {!pending && !consent?<p>Background Send is not allowed for this profile. <button type="button" className="button button-small button-outline" disabled={busy} onClick={()=>{setMaterial(null);void ipc('coordination_grant',{}).then(()=>{setConsent(true);setError(null);}).catch(e=>setError(e.message));}}>Allow Background Send</button></p>:!pending?<p>Background Send is allowed for this profile. This check can finish after closing the window.</p>:null}
      <p>Everything below goes to the selected external Pi provider. Host command details are not shared; only observed-entry counts and omission flags are included. Known private paths are excluded, but allowed files and the Native reply may still contain secrets. If the preview contains sensitive content, cancel. Remove it from the workspace where possible and preview again; otherwise do not send it.</p>
      {material?<><p>{material.coverage.limited?'Limited snapshot':'Selected tracked changes'} · {new TextEncoder().encode(material.exactPrompt).length} UTF-8 bytes</p><pre aria-label="Complete Pi payload" style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:320,overflow:'auto'}}>{material.exactPrompt}</pre>{exclusions.length?<details><summary>Local exclusions and omissions · {exclusions.length}</summary><ul>{exclusions.map(p=><li key={p}>{p}</li>)}</ul><p>Excluded names are local only; the prompt contains counts and categories.</p></details>:null}</>:null}
      {error?<CheckMessage text={error} pending={Boolean(pending)}/>:null}
      {starting?<p role="status">Starting the check. This can take a minute or two; Pi receives this snapshot only once.</p>:null}
      <div className="dialog-actions"><button type="button" className="button button-outline" disabled={busy||unknown} onClick={()=>changeOpen(false)}>Cancel</button><button type="button" className="button button-outline" disabled={busy||!offer||!checked||!consent||unknown||Boolean(capacityReason)} onClick={()=>{void prepare(true);}}>Preview shared material</button><button type="button" className="button button-primary" disabled={busy||(!pending&&(!checked||!consent||!material))} onClick={()=>{void start();}}>{starting?'Starting…':unknown?'Check result':'Check this snapshot'}</button></div>
    </GoalLayer>
    {owns&&job?.active?null:<button type="button" className="button button-small button-outline" disabled={busy||(!pending&&(!target||!eligible||Boolean(job?.active)))} onClick={()=>{setOpen(true);if(!pending){setChecked(false);setMaterial(null);request.current='native-check-'+crypto.randomUUID();void prepare(false);}}}>{starting?'Starting check…':pending?'Check previous request':'Check workspace with Pi'}</button>}
    {owns && job?<BackgroundCoordinationStatus job={job} onStopAllowing={()=>{void stop();}}/>:null}
    {!open && error?<CheckMessage text={error} pending={Boolean(pending)}/>:null}
    {saved.filter(s=>s.requestId!==job?.requestId).map(s=><details key={s.requestId}><summary>{s.statusLabel || 'Independent workspace check'} · {s.savedAt?new Date(s.savedAt).toLocaleString():'Saved snapshot'}{s.nativeCheckTarget.turnRequestId!==target?.turnRequestId?' · Earlier turn snapshot':''}</summary><p>This is a dated workspace snapshot, not automatic verification of Codex or later edits.</p><div className="tl-agent-body" style={{fontSize:14,lineHeight:1.55}}>{renderMarkdownBody(s.auditText ?? '', `saved-native-check-${s.requestId}`)}</div><details><summary>Shared material · {s.nativeCheckMaterial.coverage.limited?'Limited':'Selected tracked changes'}</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:320,overflow:'auto'}}>{s.nativeCheckMaterial.exactPrompt}</pre></details></details>)}
  </section>;
}
