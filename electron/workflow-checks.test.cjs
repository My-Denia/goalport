"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { RECOMMENDED_V1, compileWorkflow, chooseRoles, citationMode, reviewerCouldJudge } = require("./workflow-checks.mjs");
const checks = compileWorkflow(RECOMMENDED_V1).checks;
test("roles never demote the reading planner and prefer a reading reviewer", () => {
  assert.deepEqual(chooseRoles(["pi", "codex"], checks), { planner: "codex", reviewer: "pi" });
  assert.deepEqual(chooseRoles(["codex", "pi", "claude"], checks), { planner: "codex", reviewer: "claude" });
  assert.equal(chooseRoles(["codex"], checks), null);
  const strict = { ...checks, reviewerNeeds: { readWorkspace: "required" } };
  assert.equal(chooseRoles(["codex", "pi"], strict), null);
  assert.equal(reviewerCouldJudge("pi", strict), false);
});
test("a reviewer that cannot read gets a quote", () => {
  assert.equal(citationMode("pi", checks), "quote");
  assert.equal(citationMode("claude", checks), "read");
  assert.equal(citationMode("pi", { ...checks, requirementCitation: "path" }), "read");
});
test("compileWorkflow names the workflow and rejects what it cannot interpret", () => {
  const compiled = compileWorkflow(RECOMMENDED_V1);
  assert.deepEqual(compiled.workflow, { id: "recommended", version: 1 });
  assert.equal(compiled.checks, RECOMMENDED_V1.modules.checks);
  assert.throws(() => compileWorkflow({ ...RECOMMENDED_V1, schema: 2 }));
  assert.throws(() => compileWorkflow({ ...RECOMMENDED_V1, modules: {} }));
});
test("a definition without resources compiles to the default, and a present module is validated strictly", () => {
  const { DEFAULT_RESOURCES, RESOURCE_LAUNCH } = require("./workflow-checks.mjs");
  const compiled = compileWorkflow(RECOMMENDED_V1);
  assert.equal(compiled.resources, DEFAULT_RESOURCES);
  assert.deepEqual(DEFAULT_RESOURCES, { roles: { plan: "default", review: "default", execute: "default", audit: "default" }, budget: { readTurns: 4, writeTurns: 2 } });
  assert.equal("resources" in RECOMMENDED_V1.modules, false);
  const withResources = (resources) => ({ ...RECOMMENDED_V1, id: "my-1", name: "Mine", modules: { ...RECOMMENDED_V1.modules, resources } });
  const roles = { plan: "faster", review: "stronger", execute: "default", audit: "faster" };
  assert.deepEqual(compileWorkflow(withResources({ roles, budget: { readTurns: 8, writeTurns: 3 } })).resources, { roles, budget: { readTurns: 8, writeTurns: 3 } });
  for (const bad of [
    { roles: { ...roles, plan: "turbo" }, budget: { readTurns: 4, writeTurns: 2 } },
    { roles: { ...roles, extra: "faster" }, budget: { readTurns: 4, writeTurns: 2 } },
    { roles, budget: { readTurns: 1, writeTurns: 2 } },
    { roles, budget: { readTurns: 4, writeTurns: 9 } },
    { roles, budget: { readTurns: 4.5, writeTurns: 2 } },
    { roles },
    "faster",
  ]) assert.throws(() => compileWorkflow(withResources(bad)), { message: "Unsupported workflow definition." });
  assert.deepEqual(RESOURCE_LAUNCH.claude, { faster: { model: "sonnet" }, stronger: { model: "opus", effort: "high" } });
});

test("a definition without feedback compiles to automatic, and a present module is validated strictly", () => {
  const { DEFAULT_FEEDBACK } = require("./workflow-checks.mjs");
  assert.equal(compileWorkflow(RECOMMENDED_V1).feedback, DEFAULT_FEEDBACK);
  assert.deepEqual(DEFAULT_FEEDBACK, { planRevision: "automatic", repair: "automatic" });
  assert.equal("feedback" in RECOMMENDED_V1.modules, false);
  const withFeedback = (feedback) => ({ ...RECOMMENDED_V1, id: "my-1", name: "Mine", modules: { ...RECOMMENDED_V1.modules, feedback } });
  for (const planRevision of ["automatic", "ask"]) for (const repair of ["automatic", "ask"]) {
    assert.deepEqual(compileWorkflow(withFeedback({ planRevision, repair })).feedback, { planRevision, repair });
  }
  for (const bad of [
    { planRevision: "ask", repair: "automatic", extra: "ask" },
    { planRevision: "ask" },
    { repair: "ask" },
    {},
    { planRevision: "never", repair: "ask" },
    { planRevision: "ask", repair: true },
    { planRevision: "ask", repair: null },
    "ask",
    null,
  ]) assert.throws(() => compileWorkflow(withFeedback(bad)), { message: "Unsupported workflow definition." });
});
