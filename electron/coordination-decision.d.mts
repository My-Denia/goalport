export type DecisionKind = 'automatic-off' | 'limit-reached' | 'not-enough-turns' | 'window-refused' | 'unstaffed' | 'revise';
export type DecisionStage = 'plan' | 'changes';
export interface CoordinationDecision {
  readonly kind: DecisionKind;
  readonly stage: DecisionStage;
}
export const DECISION_KINDS: readonly DecisionKind[];
export const DECISION_STAGES: readonly DecisionStage[];
export function readDecision(value: unknown): CoordinationDecision | undefined;
