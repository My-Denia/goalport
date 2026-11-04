// Why a coordinated run stopped where the user has to decide. The engine sets
// it on every stop of the plan-revision and repair gates and the record keeps
// it as data, so the result page never parses sentences. Absent on records
// from before it existed: those render exactly as before.
//
// Kinds:
//   automatic-off     the workflow says stop and ask instead of revising automatically
//   limit-reached     the one automatic round already ran and the check asked again
//   not-enough-turns  not enough authorized turns were left for the automatic round
//   window-refused    this window could not be confirmed, so the round did not start
//                     (where: 'background' when a background job's worker gate said no)
//   unstaffed         the agents you allowed could not staff the automatic round
//   revise            a plain first-round revise with no automatic round available
// Stages: plan (the plan check before any write), changes (verification after writes).
export const DECISION_KINDS = Object.freeze([
  'automatic-off', 'limit-reached', 'not-enough-turns', 'window-refused', 'unstaffed', 'revise',
]);
export const DECISION_STAGES = Object.freeze(['plan', 'changes']);

// Strict reader for stored values: anything else is treated as absent.
export function readDecision(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const { kind, stage, where } = value;
  if (!DECISION_KINDS.includes(kind) || !DECISION_STAGES.includes(stage)) return undefined;
  // `where` only qualifies a window refusal; anywhere else it is dropped.
  return kind === 'window-refused' && where === 'background' ? { kind, stage, where } : { kind, stage };
}
