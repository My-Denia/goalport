export interface WorkflowChecks {
  readonly planReview: 'on' | 'off';
  readonly reviewerNeeds: { readonly readWorkspace: 'required' | 'preferred' };
  readonly requirementCitation: 'path' | 'quote-when-reviewer-cannot-read';
}
export interface WorkflowDefinition {
  readonly schema: 1;
  readonly id: string;
  readonly version: number;
  /** Required for user workflows; Recommended's name is fixed by the app. */
  readonly name?: string;
  /** e.g. "recommended@1" for a copy of Recommended v1. */
  readonly parent?: string;
  readonly modules: { readonly checks: WorkflowChecks };
}
export interface CompiledWorkflow {
  readonly workflow: { readonly id: string; readonly version: number };
  readonly name: string;
  readonly checks: WorkflowChecks;
  readonly definition: WorkflowDefinition;
}
export const RECOMMENDED_V1: WorkflowDefinition;
export const RECOMMENDED_PARENT: string;
export const WORKFLOW_ID: RegExp;
export const MAX_WORKFLOW_NAME: number;
export function compileWorkflow(definition: WorkflowDefinition): CompiledWorkflow;
export function planReviewRuns(checks: WorkflowChecks, writing: boolean): boolean;
export function readsWorkspace(instanceId: string): boolean;
export function citationMode(reviewerId: string, checks: WorkflowChecks): 'read' | 'quote';
export function reviewerCouldJudge(reviewerId: string, checks: WorkflowChecks): boolean;
export function choosePlanner(ids: readonly string[]): string | null;
export function chooseRoles(ids: readonly string[], checks: WorkflowChecks): { planner: string; reviewer: string } | null;
