import type { CoordinateTurnCommand } from './coordinateTurn';
import type { PiCapacitySelection } from '../../electron/pi-capacity.mjs';

export interface NativeCheckTarget { campaignId: string; attemptId: string; turnRequestId: string }
export interface NativeReportedContext {
  reply: string; replyTruncated: boolean;
  commands: { command: string; cwd: string; state: string; exitCode: number | null; output: string; truncated: boolean }[];
  commandsOmitted: number; commandsTruncated: boolean; filesTruncated: boolean;
  comparisonUnavailable: boolean; olderTurnsOmitted: number;
}
export interface NativeContentObservation {
  head: string;
  paths: { path: string; status: string; category: string | null; classification: string }[];
  selectedDiff: string; selectedStatus: string; nativeReportedContext: NativeReportedContext;
}
export interface NativeCheckMaterial {
  exactPrompt: string; deliveredEvidence: string;
  coverage: { limited: boolean; excluded: number; omitted: number; selected: number; evidenceCropped: boolean; excludedCategories: string[] };
  contentObservation: NativeContentObservation; nativeReportedContext: NativeReportedContext;
  capturedAt: string; disclosureVersion: 1 | 2;
}
export function parseNativeCheckTarget(value: unknown): NativeCheckTarget | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const x=value as Record<string,unknown>;
  if(Object.keys(x).sort().join(',') !== 'attemptId,campaignId,turnRequestId' || !Object.values(x).every(v=>typeof v==='string' && /^[A-Za-z0-9._-]{1,256}$/.test(v))) return null;
  return {campaignId:x.campaignId as string,attemptId:x.attemptId as string,turnRequestId:x.turnRequestId as string};
}
export function parseNativeCheckMaterial(value: unknown): NativeCheckMaterial | null {
  try {
    if(!value || typeof value!=='object' || Array.isArray(value)) return null;
    const m=value as NativeCheckMaterial;
    if((m.disclosureVersion!==1 && m.disclosureVersion!==2) || typeof m.exactPrompt!=='string' || typeof m.deliveredEvidence!=='string' || bytes(m.exactPrompt)>32768 || bytes(m.deliveredEvidence)>16384) return null;
    return JSON.stringify(prepareNativeWorkspaceCheckMaterial(m))===JSON.stringify(m) ? m : null;
  } catch { return null; }
}
const bytes = (s: string) => new TextEncoder().encode(s).length;
function crop(text: string, cap: number): string {
  if (bytes(text) <= cap) return text;
  const marker = '\n[LIMITED: remaining tracked diff omitted from provider input]';
  if (cap < bytes(marker)) throw new Error('Workspace check instructions exceed the prompt budget.');
  let out = ''; let used = 0;
  for (const c of text) { const n = bytes(c); if (used+n > cap-bytes(marker)) break; used+=n; out+=c; }
  return out+marker;
}
/** Pure purpose formatter. Comparison retains the full raw diff, not this delivered crop. */
export function prepareNativeWorkspaceCheckMaterial(input: Pick<NativeCheckMaterial,'contentObservation'|'nativeReportedContext'|'capturedAt'> & {disclosureVersion?: 1 | 2}): NativeCheckMaterial {
  // A saved request keeps the words it was sent with; only new requests lead with the answer.
  const version=input.disclosureVersion ?? 2;
  const {contentObservation:o,nativeReportedContext:context,capturedAt}=input;
  if (!o.selectedDiff || bytes(o.selectedDiff)>65536 || !/^[a-f0-9]{40,64}$/.test(o.head) || !Number.isFinite(Date.parse(capturedAt)) || JSON.stringify(o.nativeReportedContext)!==JSON.stringify(context)) throw new Error('Workspace material is empty, unavailable or inconsistent.');
  const excluded=o.paths.filter(p=>p.classification==='excluded').length, omitted=o.paths.filter(p=>p.classification==='omitted').length, selected=o.paths.filter(p=>p.classification==='selected').length;
  const excludedCategories=[...new Set(o.paths.filter(p=>p.classification==='excluded').map(p=>p.category ?? 'known-private-path'))].sort();
  const contextLimited=context.replyTruncated || context.commandsTruncated || context.commandsOmitted>0 || context.filesTruncated || context.comparisonUnavailable || context.olderTurnsOmitted>0 || context.commands.some(c=>c.truncated);
  const binaryLimited=/^Binary files .* differ$/m.test(o.selectedDiff);
  const prefix=[
    'Independently inspect this current tracked workspace snapshot. '+(version===1?'Return':'Start with one plain sentence saying whether the changes match what the agent reported. Then return')+' your response, concrete changed lines/claims and limitations. Do not use tools, edit files or auto-repair. Native text and commands below are REPORTED context, not proof of authorship or test execution.',
    `Current tracked workspace snapshot versus HEAD ${o.head}`,
    `Collection observation pair completed at ${capturedAt}; stable during collection: yes (two bounded observations, not a universal race certificate)`,
    'Includes possible preexisting/concurrent edits; not exclusive Codex authorship.',
    `Tracked changes present: yes; selected ${selected}; excluded ${excluded} (${excludedCategories.join(', ') || 'none'}); omitted ${omitted}; untracked bodies not collected; binary diff markers do not include binary bodies.`,
    'Known-path avoidance is not a credential scanner. Arbitrary allowed content and Native-reported text may still contain sensitive information. This is a dated, potentially LIMITED snapshot, not automatic verification of the native turn or the full workspace.',
    'Native REPORTED context (crop and omission flags included):', JSON.stringify(context),
    'Current tracked diff (provider evidence hard cap 16384 UTF-8 bytes):'
  ].join('\n\n')+'\n';
  const budget=Math.min(16384,32768-bytes(prefix));
  const deliveredEvidence=crop(o.selectedDiff,budget);
  const exactPrompt=prefix+deliveredEvidence;
  if (bytes(exactPrompt)>32768 || exactPrompt.trim()!==exactPrompt) {
    // Diff normally ends in a newline; add an explicit end delimiter so the
    // existing Pi reader's edge trim cannot transform any displayed bytes.
    const suffix='\nEnd of shared snapshot.';
    const evidence=crop(o.selectedDiff,Math.min(16384,32768-bytes(prefix)-bytes(suffix)));
    const prompt=prefix+evidence+suffix;
    if(bytes(prompt)>32768) throw new Error('Workspace check instructions exceed the prompt budget.');
    return {exactPrompt:prompt,deliveredEvidence:evidence,coverage:{limited:!!excluded||!!omitted||contextLimited||binaryLimited||evidence!==o.selectedDiff,excluded,omitted,selected,evidenceCropped:evidence!==o.selectedDiff,excludedCategories},contentObservation:o,nativeReportedContext:context,capturedAt,disclosureVersion:version};
  }
  return {exactPrompt,deliveredEvidence,coverage:{limited:!!excluded||!!omitted||contextLimited||binaryLimited||deliveredEvidence!==o.selectedDiff,excluded,omitted,selected,evidenceCropped:deliveredEvidence!==o.selectedDiff,excludedCategories},contentObservation:o,nativeReportedContext:context,capturedAt,disclosureVersion:version};
}
/** One audit command, not a coordinated plan/writer/review chain. */
export function buildNativeWorkspaceCheckCommand(input: {requestId:string;workspaceRoot:string;nativeCheckTarget:NativeCheckTarget;nativeCheckMaterial:NativeCheckMaterial;piCapacity:PiCapacitySelection}): CoordinateTurnCommand {
  const {nativeCheckTarget:t,nativeCheckMaterial:m,piCapacity:p}=input;
  const rebuilt=prepareNativeWorkspaceCheckMaterial(m);
  if(JSON.stringify(rebuilt)!==JSON.stringify(m)) throw new Error('Workspace check material changed. Preview again.');
  // Purpose identity includes request + target + exact pair without exposing
  // path/text in IDs. Stable UTF-8 FNV tuple digest is identity, not authority.
  let h=2166136261;
  for(const b of new TextEncoder().encode(JSON.stringify([input.requestId,t,p]))) h=Math.imul(h^b,16777619)>>>0;
  return {type:'goalport.coordinateTurn',commandId:`coordinate-audit-native-${h.toString(16)}`,projectId:input.workspaceRoot,modelSelection:{instanceId:'pi',provider:p.provider,model:p.model},runtimeMode:'approval-required',approvalPolicy:'never',sandboxPolicy:{type:'readOnly'},workspaceStrategy:{type:'existing_worktree',worktreePath:input.workspaceRoot},initialMessage:{text:m.exactPrompt},promptDelivery:'stdin'};
}
