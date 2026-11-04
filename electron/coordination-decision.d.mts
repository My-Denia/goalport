export type DecisionKind = 'automatic-off' | 'limit-reached' | 'repair-plan-revise' | 'not-enough-turns' | 'window-refused' | 'unstaffed' | 'revise';
export type DecisionStage = 'plan' | 'changes';
export interface CoordinationDecision {
  readonly kind: DecisionKind;
  readonly stage: DecisionStage;
  /** Only on window-refused, when the refusal came from a background job's worker gate rather than a window. */
  readonly where?: 'background';
}
export const DECISION_KINDS: readonly DecisionKind[];
export const DECISION_STAGES: readonly DecisionStage[];
export function readDecision(value: unknown): CoordinationDecision | undefined;
