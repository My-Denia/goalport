// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {NativeWorkspaceCheck} from './NativeWorkspaceCheck';
import {BackgroundCoordinationStatus} from './CoordinationStatus';
import {prepareNativeWorkspaceCheckMaterial,buildNativeWorkspaceCheckCommand,parseNativeCheckMaterial,parseNativeCheckTarget} from '../coordination/nativeWorkspaceCheck';
import {continuationUnavailable} from '../coordination/savedTargetView';
const target={campaignId:'campaign',attemptId:'attempt',turnRequestId:'turn'};
const pair={provider:'Fixture',model:'alpha',useExistingCapacity:true as const};
const context={reply:'reported 😀',replyTruncated:false,commands:[],commandsOmitted:0,commandsTruncated:false,filesTruncated:false,comparisonUnavailable:false,olderTurnsOmitted:0};
const material=prepareNativeWorkspaceCheckMaterial({contentObservation:{head:'a'.repeat(40),paths:[{path:'note.txt',status:'M',category:null,classification:'selected'}],selectedDiff:'diff --git a/note.txt b/note.txt\n+actual changed example\n',selectedStatus:' M note.txt\0',nativeReportedContext:context},nativeReportedContext:context,capturedAt:'2026-10-30T10:00:00Z'});
const job={jobId:'00000000-0000-4000-8000-000000000001',requestId:'',goal:'Native goal',workspacePath:'/fixture',recordKind:'native-workspace-check',nativeCheckTarget:target,nativeCheckMaterial:material,piCapacity:pair,state:'running',active:true,live:true,revoked:false,workerPid:123,readMaxTurns:2,writeMaxTurns:null,counters:{readTurnsLeft:1,writeTurnsLeft:null},pendingCommand:null,completedCommands:[],progress:{activity:'Pi is checking'},outcome:null};
afterEach(()=>{cleanup();sessionStorage.clear();vi.restoreAllMocks();vi.unstubAllGlobals();});
function server(consent=true){const calls:{messageType:string;payload:Record<string,unknown>}[]=[];vi.stubGlobal('fetch',vi.fn(async(_u,init)=>{const q=JSON.parse(init.body);calls.push(q);const payload=q.messageType==='coordination_list'?{checks:[]}:q.messageType==='coordination_grant'?{}:q.messageType==='native_workspace_check_start'?{job:{...job,requestId:q.payload.requestId}}:q.payload.piCapacity?{requestId:q.payload.requestId,nativeCheckTarget:target,piCapacity:pair,nativeCheckMaterial:material,uiExclusions:[{path:'.env'}]}:{offer:{instanceId:'pi',piCapacity:{offer:pair,catalog:[pair]}},backgroundSendConsent:consent};return new Response(JSON.stringify({ok:true,payload:{...payload,...(q.messageType==='native_workspace_check_prepare'?{workspacePath:'/fixture'}:{})}}));}));return calls;}
it('pure purpose exports preserve exact UTF8 bytes and no plan/execution promise; readers refuse check continuation',()=>{
 expect(parseNativeCheckMaterial(material)).toEqual(material);expect(parseNativeCheckMaterial({...material,exactPrompt:material.exactPrompt+' '})).toBeNull();expect(parseNativeCheckTarget({...target,workspacePath:'/forged'})).toBeNull();
 const command=buildNativeWorkspaceCheckCommand({requestId:'one',workspaceRoot:'/fixture',nativeCheckTarget:target,nativeCheckMaterial:material,piCapacity:pair});expect(command.initialMessage.text).toBe(material.exactPrompt);expect(command.promptDelivery).toBe('stdin');expect(command.sandboxPolicy.type).toBe('readOnly');expect(material.exactPrompt).not.toMatch(/VERDICT: verified|approved plan/);
 expect(continuationUnavailable({recordKind:'native-workspace-check'} as never)).toMatch(/do not continue/);
});
const sendReady=async()=>{fireEvent.click(screen.getByRole('button',{name:'Ask Pi to review'}));return await screen.findByRole('button',{name:'Send to Pi'});};
it('one step: opening reads the changes, says what goes where in plain words, and sends once with no renderer bytes',async()=>{
 const calls=server(),onJob=vi.fn(),onBusy=vi.fn();const props={target,eligible:true,job:null,onJob,onBusy};const view=render(<NativeWorkspaceCheck {...props}/>);
 const send=await sendReady();await waitFor(()=>expect((send as HTMLButtonElement).disabled).toBe(false));
 expect(screen.getByText('Changes:').closest('li')?.textContent).toContain('note.txt');expect(screen.getByText(/Fixture\/alpha/)).toBeTruthy();expect(screen.getByText(/1 private file/)).toBeTruthy();
 expect(screen.queryByRole('checkbox')).toBeNull();const visible=screen.getByRole('dialog').textContent!.replace(material.exactPrompt,'');expect(visible).not.toMatch(/Background Send|Limited snapshot|UTF-8|Native/);
 expect(screen.getByLabelText('Complete Pi payload',{selector:'pre'}).textContent).toBe(material.exactPrompt);expect(material.exactPrompt).not.toContain('.env');
 fireEvent.click(send);await waitFor(()=>expect(onJob).toHaveBeenCalledTimes(1));const starts=calls.filter(c=>c.messageType==='native_workspace_check_start');expect(starts).toHaveLength(1);expect(Object.keys(starts[0].payload).sort()).toEqual(['attemptId','backgroundConsent','campaignId','piCapacity','requestId','turnRequestId']);expect(starts[0].payload.piCapacity).toEqual(pair);
 view.rerender(<NativeWorkspaceCheck {...props} job={onJob.mock.calls[0][0]}/>);expect(screen.getAllByRole('region',{name:'Pi review'})).toHaveLength(1);fireEvent.click(screen.getByRole('button',{name:'Stop review'}));await waitFor(()=>expect(calls.some(c=>c.messageType==='coordination_stop')).toBe(true));expect(calls.find(c=>c.messageType==='coordination_stop')?.payload).toEqual({jobId:job.jobId});expect(calls.some(c=>c.messageType==='conversation_interrupt'||c.messageType==='close_session')).toBe(false);
});
it('Pi that is not set up says so and offers no send',async()=>{
 const calls:string[]=[];vi.stubGlobal('fetch',vi.fn(async(_u,init)=>{const q=JSON.parse(init.body);calls.push(q.messageType);return new Response(JSON.stringify({ok:true,payload:q.messageType==='coordination_list'?{checks:[]}:{workspacePath:'/fixture',backgroundSendConsent:true,offer:{instanceId:'pi',auth:{status:'unauthenticated'},piCapacity:{offer:pair,catalog:[pair]}}}}));}));
 render(<NativeWorkspaceCheck target={target} eligible job={null} onJob={vi.fn()} onBusy={vi.fn()}/>);const send=await sendReady();await screen.findByText(/Pi isn’t set up/);expect((send as HTMLButtonElement).disabled).toBe(true);expect(calls.filter(c=>c==='native_workspace_check_prepare')).toHaveLength(1);
});
it('pressing Send is the consent: it grants once, then starts, and a failed grant sends nothing',async()=>{
 const calls=server(false);render(<NativeWorkspaceCheck target={target} eligible job={null} onJob={vi.fn()} onBusy={vi.fn()}/>);const send=await sendReady();await waitFor(()=>expect((send as HTMLButtonElement).disabled).toBe(false));fireEvent.click(send);
 await waitFor(()=>expect(calls.some(c=>c.messageType==='native_workspace_check_start')).toBe(true));expect(calls.filter(c=>c.messageType==='coordination_grant')).toHaveLength(1);expect(calls.findIndex(c=>c.messageType==='coordination_grant')).toBeLessThan(calls.findIndex(c=>c.messageType==='native_workspace_check_start'));
});
it('a typed pre-admission refusal discards the preview and caller intent instead of trapping a changed route as unknown',async()=>{
 server();const original=fetch;vi.stubGlobal('fetch',vi.fn(async(u,init)=>{const q=JSON.parse(String(init?.body));if(q.messageType==='native_workspace_check_start')return new Response(JSON.stringify({ok:false,error:'The configured Pi choice changed. Preview again.',previewAgain:true}));return original(u,init);}));
 const onJob=vi.fn();render(<NativeWorkspaceCheck target={target} eligible job={null} onJob={onJob} onBusy={vi.fn()}/>);const send=await sendReady();await waitFor(()=>expect((send as HTMLButtonElement).disabled).toBe(false));fireEvent.click(send);await screen.findByText('Technical details');expect(sessionStorage.getItem('goalport.nativeCheckCallerIntent')).toBeNull();expect(screen.queryByRole('button',{name:'Check on it'})).toBeNull();expect(onJob).not.toHaveBeenCalled();
});

it('lost final reply retains only caller identity across return, resolves the same job and never repins another goal',async()=>{
 server();const original=fetch;const starts:Record<string,unknown>[]=[];let lose=true;
 vi.stubGlobal('fetch',vi.fn(async(u,init)=>{const q=JSON.parse(String(init?.body));if(q.messageType==='native_workspace_check_start'){starts.push(q.payload);if(lose){lose=false;throw Error('synthetic lost reply');}}return original(u,init);}));
 const onJob=vi.fn(),onBusy=vi.fn();const first=render(<NativeWorkspaceCheck target={target} eligible job={null} onJob={onJob} onBusy={onBusy}/>);const send=await sendReady();await waitFor(()=>expect((send as HTMLButtonElement).disabled).toBe(false));fireEvent.click(send);await screen.findByText('synthetic lost reply');expect(starts).toHaveLength(1);const stored=JSON.parse(sessionStorage.getItem('goalport.nativeCheckCallerIntent')!);expect(Object.keys(stored).sort()).toEqual(['piCapacity','requestId','target']);expect(JSON.stringify(stored)).not.toContain(material.exactPrompt);
 first.unmount();render(<NativeWorkspaceCheck target={{...target,campaignId:'other-view'}} eligible job={null} onJob={onJob} onBusy={onBusy}/>);fireEvent.click(screen.getByRole('button',{name:'Check on your earlier request'}));fireEvent.click(screen.getByRole('button',{name:'Check on it'}));await waitFor(()=>expect(onJob).toHaveBeenCalledTimes(1));expect(starts).toHaveLength(2);expect(starts[1]).toEqual(starts[0]);expect(onJob.mock.calls[0][0].nativeCheckTarget).toEqual(target);expect(sessionStorage.getItem('goalport.nativeCheckCallerIntent')).toBeNull();
});

it('return keeps the own dated review when the current Attempt has no completed turn yet',async()=>{
 const calls:string[]=[];vi.stubGlobal('fetch',vi.fn(async(_u,init)=>{const q=JSON.parse(init.body);calls.push(q.messageType);return new Response(JSON.stringify({ok:true,payload:{checks:[{requestId:'saved-check',nativeAssociation:true,nativeCheckTarget:target,nativeCheckMaterial:material,statusLabel:'x',auditText:'Concrete saved critique',savedAt:'2026-01-01T00:00:00Z'}]}}));}));
 render(<NativeWorkspaceCheck campaignId={target.campaignId} target={null} eligible={false} job={null} onJob={vi.fn()} onBusy={vi.fn()}/>);await screen.findByText('Concrete saved critique');expect((screen.getByRole('button',{name:'Ask Pi to review'}) as HTMLButtonElement).disabled).toBe(true);expect(screen.getByText(/earlier turn/)).toBeTruthy();expect(calls).toEqual(['coordination_list']);
});

it('target change fences a late preview and cannot adopt or repin the other goal',async()=>{
 const calls=server();const props={target,eligible:true,job:null,onJob:vi.fn(),onBusy:vi.fn()};const view=render(<NativeWorkspaceCheck {...props}/>);await sendReady();view.rerender(<NativeWorkspaceCheck {...props} target={{...target,campaignId:'other'}}/>);await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());expect(calls.some(c=>c.messageType==='native_workspace_check_start')).toBe(false);expect(props.onJob).not.toHaveBeenCalled();
});

it('a first send still waiting on the host reads as sending, never as an earlier request',async()=>{
 server();const original=fetch;let release=()=>{};const held=new Promise<void>(done=>{release=done;});
 vi.stubGlobal('fetch',vi.fn(async(u,init)=>{const q=JSON.parse(String(init?.body));if(q.messageType==='native_workspace_check_start')await held;return original(u,init);}));
 const onJob=vi.fn();render(<NativeWorkspaceCheck target={target} eligible job={null} onJob={onJob} onBusy={vi.fn()}/>);const send=await sendReady();await waitFor(()=>expect((send as HTMLButtonElement).disabled).toBe(false));fireEvent.click(send);
 expect(await screen.findByText(/Sending to Pi\. This can take/)).toBeTruthy();expect(screen.queryByText(/earlier request/)).toBeNull();expect((screen.getByRole('button',{name:'Sending…'}) as HTMLButtonElement).disabled).toBe(true);
 release();await waitFor(()=>expect(onJob).toHaveBeenCalledTimes(1));
});

it('a running review says so once and offers only Stop, not a dead start button',()=>{
 render(<NativeWorkspaceCheck target={target} eligible job={{...job,requestId:'r',progress:{activity:'Pi is checking the shared workspace snapshot…'}} as never} onJob={vi.fn()} onBusy={vi.fn()}/>);
 expect(screen.getAllByText(/Pi is reviewing/)).toHaveLength(1);expect(screen.getByRole('button',{name:'Stop review'})).toBeTruthy();expect(screen.queryByRole('button',{name:'Ask Pi to review'})).toBeNull();
});

it('on the desktop it talks only to the preload bridge and accepts a Windows folder',async()=>{
 const seen:string[]=[];const fetchSpy=vi.fn();vi.stubGlobal('fetch',fetchSpy);
 window.goalportCore={nativeCheck:async(type:string,payload:{piCapacity?:unknown})=>{seen.push(type);return {ok:true,payload:type==='coordination_list'?{checks:[]}:payload.piCapacity?{requestId:(payload as {requestId:string}).requestId,nativeCheckTarget:target,piCapacity:pair,nativeCheckMaterial:material,uiExclusions:[]}:{workspacePath:'C:\\work\\project',backgroundSendConsent:true,offer:{instanceId:'pi',piCapacity:{offer:pair,catalog:[pair]}}}};}} as never;
 try{render(<NativeWorkspaceCheck target={target} eligible job={null} onJob={vi.fn()} onBusy={vi.fn()}/>);const send=await sendReady();await waitFor(()=>expect((send as HTMLButtonElement).disabled).toBe(false));expect(seen).toContain('native_workspace_check_prepare');expect(fetchSpy).not.toHaveBeenCalled();}
 finally{delete window.goalportCore;}
});

it('a review that stopped running says the files are safe and can be dismissed without sending anything',async()=>{
 const calls=server();const dead={...job,requestId:'r',live:false,active:true,state:'unconfirmed'};const onJob=vi.fn();
 render(<NativeWorkspaceCheck target={target} eligible job={dead as never} onJob={onJob} onBusy={vi.fn()}/>);
 expect(screen.getByText(/didn't finish/)).toBeTruthy();expect(screen.getByText(/weren't changed/)).toBeTruthy();expect(screen.queryByRole('button',{name:'Stop review'})).toBeNull();fireEvent.click(screen.getByRole('button',{name:'Dismiss'}));await waitFor(()=>expect(onJob).toHaveBeenCalledTimes(1));
 expect(calls.find(c=>c.messageType==='coordination_acknowledge')?.payload).toEqual({jobId:job.jobId});expect(onJob.mock.calls[0][0].acknowledgedStuckAt).toBeTruthy();expect(calls.some(c=>c.messageType==='native_workspace_check_start')).toBe(false);
});

it('a review saved before the prompt changed still reads, and new requests lead with the answer',()=>{
 const old=prepareNativeWorkspaceCheckMaterial({contentObservation:material.contentObservation,nativeReportedContext:context,capturedAt:material.capturedAt,disclosureVersion:1});
 expect(old.exactPrompt).not.toContain('Start with exactly one of');expect(material.exactPrompt).toContain('Start with exactly one of');expect(parseNativeCheckMaterial(old)).toEqual(old);
});

it('a review can go straight to Codex as an editable draft, with nothing sent',()=>{
 const onAskCodex=vi.fn();render(<BackgroundCoordinationStatus job={{...job,state:'completed',active:false,live:false,outcome:{status:'completed',report:{auditText:'One claim is not shown.'}}} as never} onStopAllowing={()=>{}} onAskCodex={onAskCodex}/>);
 fireEvent.click(screen.getByRole('button',{name:'Ask Codex to fix this'}));expect(onAskCodex).toHaveBeenCalledTimes(1);expect(onAskCodex.mock.calls[0][0]).toContain('One claim is not shown.');
});

it('a verdict shows at a glance and a clean review asks for nothing more',()=>{
 render(<BackgroundCoordinationStatus job={{...job,state:'completed',active:false,live:false,outcome:{status:'completed',report:{auditText:'Looks right: the guide gained the section Codex described.'}}} as never} onStopAllowing={()=>{}} onAskCodex={vi.fn()}/>);
 expect(screen.getByText('Looks right').className).toContain('review-verdict-good');expect(screen.getByText(/the guide gained/).textContent).not.toContain('Looks right');expect(screen.queryByRole('button',{name:'Ask Codex to fix this'})).toBeNull();
});

it('a running review invites the user to keep working',()=>{
 render(<BackgroundCoordinationStatus job={{...job,requestId:'r'} as never} onStopAllowing={()=>{}}/>);expect(screen.getByText(/Keep working or close this window/)).toBeTruthy();
});

it('a returned review leads with its first sentence and folds the rest',()=>{
 render(<BackgroundCoordinationStatus job={{...job,state:'completed',active:false,live:false,outcome:{status:'completed',report:{auditText:'The changes match what Codex reported.\n\n## Detail\n\nLong working.'}}} as never} onStopAllowing={()=>{}}/>);
 const lead=screen.getByText('The changes match what Codex reported.');expect(lead.closest('details')).toBeNull();expect(screen.getByText('Long working.').closest('details')).toBeTruthy();expect(screen.getByRole('heading',{name:"Pi's review"})).toBeTruthy();expect(screen.queryByText(/\/fixture/)).toBeNull();
});

it('renders a markdown table from Pi as a table, keeping inline code and inert text',()=>{
 const text='Intro\n\n| Claim | Shown |\n|---|---|\n| `git diff` passed | Not shown |\n| <b>x</b> | Yes |\n\nAfter';
 render(<BackgroundCoordinationStatus job={{...job,state:'completed',active:false,live:false,outcome:{status:'completed',report:{auditText:text}}} as never} onStopAllowing={()=>{}}/>);
 expect(screen.getByRole('columnheader',{name:'Claim'})).toBeTruthy();expect(screen.getAllByRole('row')).toHaveLength(3);expect(screen.getByRole('cell',{name:'Not shown'})).toBeTruthy();expect(screen.getByText('git diff').tagName).toBe('CODE');expect(screen.getByText('<b>x</b>').tagName).toBe('TD');expect(screen.getByText('After').tagName).toBe('P');
});

it('renders a returned Pi response as readable safe markdown, not a raw command log',()=>{
 const text='### Specific findings\n\n- A **concrete** doc issue with `Stop check`.\n\n<script>not executable</script>';
 render(<BackgroundCoordinationStatus job={{...job,state:'completed',active:false,live:false,outcome:{status:'completed',report:{auditText:text}}} as never} onStopAllowing={()=>{}}/>);
 expect(screen.getByRole('heading',{name:'Specific findings'})).toBeTruthy();
 expect(screen.getByText('concrete').tagName).toBe('STRONG');
 expect(screen.getByRole('list')).toBeTruthy();expect(document.querySelector('script')).toBeNull();
 expect(screen.getByText('<script>not executable</script>')).toBeTruthy();
 expect(document.querySelector('.tl-agent-body')?.tagName).toBe('DIV');
});
