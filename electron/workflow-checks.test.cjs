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
