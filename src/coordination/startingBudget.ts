/**
 * A new goal's turn limits start from the workflow it will use. Once access is granted the limits
 * belong to that grant, and a number the user typed is theirs; neither is ever replaced, and choosing
 * a workflow never grants anything.
 */
export interface StartingBudgetInput {
  readonly workflow: { readonly readTurns: number; readonly writeTurns: number };
  readonly current: { readonly readTurns: number; readonly writeTurns: number };
  readonly accessGranted: boolean;
  readonly typed: { readonly read: boolean; readonly write: boolean };
}

export function startingBudget(input: StartingBudgetInput): { readTurns: number; writeTurns: number } {
  if (input.accessGranted) return { ...input.current };
  return {
    readTurns: input.typed.read ? input.current.readTurns : input.workflow.readTurns,
    writeTurns: input.typed.write ? input.current.writeTurns : input.workflow.writeTurns,
  };
}
