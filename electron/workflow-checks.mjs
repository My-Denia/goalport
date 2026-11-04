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
// Resources module: which way each role leans on speed and depth, plus how many
// model turns a run may spend. Absent in a saved definition means "default":
// every harness launches exactly as it did before this module existed.
export const RESOURCE_ROLES = Object.freeze(['plan', 'review', 'execute', 'audit']);
export const RESOURCE_PREFERENCES = Object.freeze(['default', 'faster', 'stronger']);
export const RESOURCE_BOUNDS = Object.freeze({
  readTurns: Object.freeze({ min: 2, max: 32 }),
  writeTurns: Object.freeze({ min: 1, max: 8 }),
});
export const DEFAULT_RESOURCES = Object.freeze({
  roles: Object.freeze({ plan: 'default', review: 'default', execute: 'default', audit: 'default' }),
  budget: Object.freeze({ readTurns: 4, writeTurns: 2 }),
});
// What faster / stronger mean per harness, as data. The launch layer only ever
// emits these fixed literals; a definition string is never spliced into argv.
// Claude faster is `--model sonnet` alone, with no `--effort low`: the check
// must still read carefully, so the model swap is the speed lever. Claude
// stronger is opus at high effort. Codex and Pi keep their own model and move
// only the reasoning effort / thinking level.
export const RESOURCE_LAUNCH = Object.freeze({
  codex: Object.freeze({
    faster: Object.freeze({ effort: 'low' }),
    stronger: Object.freeze({ effort: 'high' }),
  }),
  claude: Object.freeze({
    faster: Object.freeze({ model: 'sonnet' }),
    stronger: Object.freeze({ model: 'opus', effort: 'high' }),
  }),
  pi: Object.freeze({
    faster: Object.freeze({ thinking: 'low' }),
    stronger: Object.freeze({ thinking: 'high' }),
  }),
});
// Feedback module: for goals that change files, whether a check that asks for
// changes starts the one automatic round, or the run stops and asks the user.
// Absent in a saved definition means Recommended: both stay automatic.
export const FEEDBACK_STAGES = Object.freeze(['planRevision', 'repair']);
export const FEEDBACK_CHOICES = Object.freeze(['automatic', 'ask']);
export const DEFAULT_FEEDBACK = Object.freeze({ planRevision: 'automatic', repair: 'automatic' });
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

const ROLE_KEYS = new Set(RESOURCE_ROLES);
const PREFERENCES = new Set(RESOURCE_PREFERENCES);
const plainObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);
const inBounds = (value, bounds) => Number.isInteger(value) && value >= bounds.min && value <= bounds.max;

// A present module is validated strictly; an absent one is the default.
function compileResources(module) {
  if (module === undefined) return DEFAULT_RESOURCES;
  if (!plainObject(module) || !plainObject(module.roles) || !plainObject(module.budget)
    || Object.keys(module).some(key => key !== 'roles' && key !== 'budget')
    || Object.keys(module.roles).length !== RESOURCE_ROLES.length
    || Object.keys(module.roles).some(key => !ROLE_KEYS.has(key))
    || !RESOURCE_ROLES.every(role => PREFERENCES.has(module.roles[role]))
    || Object.keys(module.budget).some(key => key !== 'readTurns' && key !== 'writeTurns')
    || !inBounds(module.budget.readTurns, RESOURCE_BOUNDS.readTurns)
    || !inBounds(module.budget.writeTurns, RESOURCE_BOUNDS.writeTurns)) {
    throw new Error('Unsupported workflow definition.');
  }
  return Object.freeze({
    roles: Object.freeze(Object.fromEntries(RESOURCE_ROLES.map(role => [role, module.roles[role]]))),
    budget: Object.freeze({ readTurns: module.budget.readTurns, writeTurns: module.budget.writeTurns }),
  });
}

const FEEDBACK_KEYS = new Set(FEEDBACK_STAGES);
const FEEDBACK_VALUES = new Set(FEEDBACK_CHOICES);
// A present module is validated strictly; an absent one is Recommended's.
function compileFeedback(module) {
  if (module === undefined) return DEFAULT_FEEDBACK;
  if (!plainObject(module) || Object.keys(module).length !== FEEDBACK_STAGES.length
    || Object.keys(module).some(key => !FEEDBACK_KEYS.has(key))
    || !FEEDBACK_STAGES.every(stage => FEEDBACK_VALUES.has(module[stage]))) {
    throw new Error('Unsupported workflow definition.');
  }
  return Object.freeze({ planRevision: module.planRevision, repair: module.repair });
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
  const resources = compileResources(definition.modules.resources);
  const feedback = compileFeedback(definition.modules.feedback);
  return Object.freeze({
    workflow: Object.freeze({ id: definition.id, version: definition.version }),
    name,
    checks,
    resources,
    feedback,
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
