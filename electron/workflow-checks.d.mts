export interface WorkflowChecks {
  readonly planReview: 'on' | 'off';
  readonly reviewerNeeds: { readonly readWorkspace: 'required' | 'preferred' };
  readonly requirementCitation: 'path' | 'quote-when-reviewer-cannot-read';
}
export type ResourceRole = 'plan' | 'review' | 'execute' | 'audit';
export type ResourcePreference = 'default' | 'faster' | 'stronger';
export interface WorkflowResources {
  readonly roles: { readonly [role in ResourceRole]: ResourcePreference };
  readonly budget: { readonly readTurns: number; readonly writeTurns: number };
}
export interface WorkflowDefinition {
  readonly schema: 1;
  readonly id: string;
  readonly version: number;
  /** Required for user workflows; Recommended's name is fixed by the app. */
  readonly name?: string;
  /** e.g. "recommended@1" for a copy of Recommended v1. */
  readonly parent?: string;
  readonly modules: { readonly checks: WorkflowChecks; readonly resources?: WorkflowResources };
}
export interface CompiledWorkflow {
  readonly workflow: { readonly id: string; readonly version: number };
  readonly name: string;
  readonly checks: WorkflowChecks;
  readonly resources: WorkflowResources;
  readonly definition: WorkflowDefinition;
}
export const RECOMMENDED_V1: WorkflowDefinition;
export const RESOURCE_ROLES: readonly ResourceRole[];
export const RESOURCE_PREFERENCES: readonly ResourcePreference[];
export const RESOURCE_BOUNDS: { readonly readTurns: { readonly min: number; readonly max: number }; readonly writeTurns: { readonly min: number; readonly max: number } };
export const DEFAULT_RESOURCES: WorkflowResources;
export const RESOURCE_LAUNCH: {
  readonly codex: { readonly faster: { readonly effort: string }; readonly stronger: { readonly effort: string } };
  readonly claude: { readonly faster: { readonly model: string }; readonly stronger: { readonly model: string; readonly effort: string } };
  readonly pi: { readonly faster: { readonly thinking: string }; readonly stronger: { readonly thinking: string } };
};
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
