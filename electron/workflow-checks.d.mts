export interface WorkflowChecks {
  readonly reviewerNeeds: { readonly readWorkspace: 'required' | 'preferred' };
  readonly requirementCitation: 'path' | 'quote-when-reviewer-cannot-read';
}
export interface WorkflowPreset { readonly id: string; readonly version: number; readonly checks: WorkflowChecks }
export const RECOMMENDED_V1: WorkflowPreset;
export function readsWorkspace(instanceId: string): boolean;
export function citationMode(reviewerId: string, checks: WorkflowChecks): 'read' | 'quote';
export function reviewerCouldJudge(reviewerId: string, checks: WorkflowChecks): boolean;
export function chooseRoles(ids: readonly string[], checks: WorkflowChecks): { planner: string; reviewer: string } | null;
