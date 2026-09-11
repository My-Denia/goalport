import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CLOSURE_SLUG, PRIOR_SLUG, ROOT, RUN_SLUG } from "./v1-isolated-env.mjs";

const helper = resolve(fileURLToPath(new URL("./verify-acceptance.mjs", import.meta.url)));
const RC_PRESERVE_SLUG = ["goalport", "electron", "stable", "v1"].join("-");

function run(args) {
  return spawnSync(process.execPath, [helper, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      GOALPORT_RUN_SLUG: RUN_SLUG
    }
  });
}

test("verify-acceptance refuses closure evidence-root even when RUN_SLUG is this-run", () => {
  const report = `goal-runs/${CLOSURE_SLUG}/evidence/should-not-write-acceptance.json`;
  const result = run(["--evidence-root", `goal-runs/${CLOSURE_SLUG}/evidence`, "--report", report]);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /refusing|preserved/i);
  assert.equal(existsSync(resolve(ROOT, report)), false);
});

test("verify-acceptance refuses PRIOR report path", () => {
  const report = `goal-runs/${PRIOR_SLUG}/evidence/should-not-write-acceptance.json`;
  const result = run(["--evidence-root", `goal-runs/${RUN_SLUG}/evidence`, "--report", report]);
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(resolve(ROOT, report)), false);
});

test("verify-acceptance refuses RC evidence-root", () => {
  const report = `goal-runs/${RC_PRESERVE_SLUG}/evidence/should-not-write-acceptance.json`;
  const result = run(["--evidence-root", `goal-runs/${RC_PRESERVE_SLUG}/evidence`, "--report", report]);
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(resolve(ROOT, report)), false);
});
