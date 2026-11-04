// Which agents can open workspace files, and how a plan check cites its requirement.
// Pure rules shared by the engine and the native host.
// Recommended workflow v1 as data. Only modules whose fields the engine reads
// belong here; a definition never grants anything (scope and consent still do).
export const RECOMMENDED_V1 = Object.freeze({
  schema: 1, id: 'recommended', version: 1,
  modules: Object.freeze({
    checks: Object.freeze({
      reviewerNeeds: Object.freeze({ readWorkspace: 'preferred' }),
      requirementCitation: 'quote-when-reviewer-cannot-read',
    }),
  }),
});
// Pure: the inputs the one engine runs for a definition. The goal does not
// change them yet; later modules (turn budget, rounds) will read it here.
export function compileWorkflow(definition) {
  if (definition?.schema !== 1 || typeof definition.id !== 'string' || !Number.isInteger(definition.version) || !definition.modules?.checks) {
    throw new Error('Unsupported workflow definition.');
  }
  return Object.freeze({
    workflow: Object.freeze({ id: definition.id, version: definition.version }),
    checks: definition.modules.checks,
  });
}
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
