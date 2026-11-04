// Which agents can open workspace files, and how a plan check cites its requirement.
// Pure rules shared by the engine and the native host.
// Recommended workflow v1 as data. Only modules whose fields the engine reads
// belong here; a definition never grants anything (scope and consent still do).
export const RECOMMENDED_V1 = Object.freeze({
  schema: 1, id: 'recommended', version: 1, name: 'Recommended workflow',
  modules: Object.freeze({
    checks: Object.freeze({
      planReview: 'on',
      reviewerNeeds: Object.freeze({ readWorkspace: 'preferred' }),
      requirementCitation: 'quote-when-reviewer-cannot-read',
    }),
  }),
});
export const RECOMMENDED_PARENT = 'recommended@1';
export const WORKFLOW_ID = /^[A-Za-z0-9._-]{1,64}$/;
export const MAX_WORKFLOW_NAME = 60;
const PLAN_REVIEW = new Set(['on', 'off']);
const READ_WORKSPACE = new Set(['preferred', 'required']);
const CITATION = new Set(['path', 'quote-when-reviewer-cannot-read']);
const PARENT = /^recommended@[1-9]\d{0,5}$/;

function plainName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return name.length > 0 && name.length <= MAX_WORKFLOW_NAME && !/[\u0000-\u001f\u007f]/.test(name) ? name : null;
}

// Pure: the inputs the one engine runs for a definition. Throws on anything it
// cannot interpret, so a damaged snapshot never runs as something else.
export function compileWorkflow(definition) {
  const checks = definition?.modules?.checks;
  if (definition?.schema !== 1 || typeof definition.id !== 'string' || !WORKFLOW_ID.test(definition.id)
    || !Number.isInteger(definition.version) || definition.version < 1 || !checks
    || !PLAN_REVIEW.has(checks.planReview) || !READ_WORKSPACE.has(checks.reviewerNeeds?.readWorkspace)
    || !CITATION.has(checks.requirementCitation)) {
    throw new Error('Unsupported workflow definition.');
  }
  const name = definition.id === RECOMMENDED_V1.id ? RECOMMENDED_V1.name : plainName(definition.name);
  if (name === null) throw new Error('Unsupported workflow definition.');
  if (definition.parent !== undefined && (typeof definition.parent !== 'string' || !PARENT.test(definition.parent))) {
    throw new Error('Unsupported workflow definition.');
  }
  return Object.freeze({
    workflow: Object.freeze({ id: definition.id, version: definition.version }),
    name,
    checks,
    definition,
  });
}
// The one rule for when the independent plan review runs: always for goals
// that may change files, otherwise as the definition says.
export function planReviewRuns(checks, writing) {
  return writing === true || checks.planReview !== 'off';
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
export function choosePlanner(ids) {
  return ids.find(readsWorkspace) ?? ids[0] ?? null;
}
export function chooseRoles(ids, checks) {
  const planner = choosePlanner(ids);
  if (planner === null) return null;
  const others = ids.filter(id => id !== planner);
  const reviewer = others.find(readsWorkspace) ?? others.find(id => reviewerCouldJudge(id, checks));
  return reviewer === undefined ? null : { planner, reviewer };
}
