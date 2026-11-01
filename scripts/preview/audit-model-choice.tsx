// Acceptance-only fixture. Never imported by the production entry.
import React from 'react';
import {createRoot} from 'react-dom/client';
import {NativeWorkspaceCheck} from '../../src/conversation/NativeWorkspaceCheck';
import {prepareNativeWorkspaceCheckMaterial} from '../../src/coordination/nativeWorkspaceCheck';
import '../../src/styles.css';

const target={campaignId:'campaign',attemptId:'attempt',turnRequestId:'turn'};
const pair={provider:'Fixture',model:'available-model',useExistingCapacity:true as const};
const context={reply:'Updated the greeting.',replyTruncated:false,commands:[],commandsOmitted:0,commandsTruncated:false,filesTruncated:false,comparisonUnavailable:false,olderTurnsOmitted:0};
const material=prepareNativeWorkspaceCheckMaterial({contentObservation:{head:'a'.repeat(40),paths:[{path:'hello.txt',status:'M',category:null,classification:'selected'}],selectedDiff:'diff --git a/hello.txt b/hello.txt\n+Hello world\n',selectedStatus:' M hello.txt\0',nativeReportedContext:context},nativeReportedContext:context,capturedAt:'2026-11-01T00:00:00Z'});
window.goalportCore={nativeCheck:async(type:string,payload:any)=>({ok:true,payload:
  type==='coordination_list'?{checks:[]}:
  payload.piCapacity?{requestId:payload.requestId,nativeCheckTarget:target,piCapacity:payload.piCapacity,nativeCheckMaterial:material,uiExclusions:[]}:
  {workspacePath:'/fixture',backgroundSendConsent:true,offer:{instanceId:'pi',piCapacity:{offer:null,catalog:[pair],reason:'The default model is unavailable. Choose another model.'}}}
})} as never;
createRoot(document.getElementById('root')!).render(<main style={{padding:24,maxWidth:1000,margin:'auto'}}>
  <h1>Review changes</h1><p>Synthetic acceptance fixture — no model requests are sent.</p>
  <NativeWorkspaceCheck target={target} eligible job={null} onJob={()=>{}} onBusy={()=>{}}/>
</main>);
