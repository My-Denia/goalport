// Which agents can open workspace files, and how a plan check cites its requirement.
// Pure rules shared by the engine and the native host.
export const RECOMMENDED_V1 = Object.freeze({
  id: 'recommended', version: 1,
  checks: Object.freeze({
    reviewerNeeds: Object.freeze({ readWorkspace: 'preferred' }),
    requirementCitation: 'quote-when-reviewer-cannot-read',
  }),
});
// codex runs read-only, claude runs in plan mode; pi is launched with --no-tools.
export function readsWorkspace(instanceId) { return instanceId === 'codex' || instanceId === 'claude'; }
export function citationMode(reviewerId, checks) {
  return !readsWorkspace(reviewerId) && checks.requirementCitation === 'quote-when-reviewer-cannot-read' ? 'quote' : 'read';
}
export function reviewerCouldJudge(reviewerId, checks) {
  return readsWorkspace(reviewerId)
    || (checks.reviewerNeeds.readWorkspace !== 'required' && checks.requirementCitation === 'quote-when-reviewer-cannot-read');
}
export function chooseRoles(ids, checks) {
  const planner = ids.find(readsWorkspace) ?? ids[0];
  if (planner === undefined) return null;
  const others = ids.filter(id => id !== planner);
  const reviewer = others.find(readsWorkspace) ?? others.find(id => reviewerCouldJudge(id, checks));
  return reviewer === undefined ? null : { planner, reviewer };
}
