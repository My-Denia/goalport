import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { CLAUDE_DENY_FAIL_OPEN_ADMISSION_SLUG, CLAUDE_LIVE_DENY_ADMISSION_SLUG, CLAUDE_NATIVE_CONTROL_ADMISSION_SLUG, CLAUDE_NOTICE_STOP_DUP_ADMISSION_SLUG, CLOSURE_SLUG, EVID, EVID_REL, FIX_REL, PRIOR_SLUG, ROOT, RUN_SLUG, isolatedChildEnv, underDir } from "./v1-isolated-env.mjs";

const helper = resolve(fileURLToPath(new URL("./v1-isolated-env.mjs", import.meta.url)));
const thisPipe = `\\\\.\\pipe\\${RUN_SLUG}-helper-test`;
// preserved RC folder goalport-electron-stable-v1
const RC_PRESERVE_SLUG = ["goalport", "electron", "stable", "v1"].join("-");

function run(env, extraArgs = []) {
  return spawnSync(process.execPath, [helper, ...extraArgs], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: "utf8",
    windowsHide: true
  });
}

test("isolated helper fails closed without env", () => {
  const result = run({
    GOALPORT_CORE_PIPE: "",
    GOALPORT_CORE_DB: "",
    GOALPORT_SYNTHETIC_ROOT: "",
    GOALPORT_REQUIRE_ISOLATED: ""
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr || "", /isolated env missing/);
});

test("isolated helper fails closed on PRIOR report path", () => {
  const evidDb = resolve(ROOT, EVID_REL, "helper-test.sqlite");
  const result = run({
    GOALPORT_CORE_PIPE: thisPipe,
    GOALPORT_CORE_DB: evidDb,
    GOALPORT_SYNTHETIC_ROOT: resolve(ROOT, FIX_REL),
    GOALPORT_REQUIRE_ISOLATED: "1"
  }, ["--report", `goal-runs/${PRIOR_SLUG}/evidence/should-not-write.json`]);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /PRIOR|preserved|must be under this-run/i);
});

test("isolated helper fails closed on RC report path", () => {
  const evidDb = resolve(ROOT, EVID_REL, "helper-test.sqlite");
  const result = run({
    GOALPORT_CORE_PIPE: thisPipe,
    GOALPORT_CORE_DB: evidDb,
    GOALPORT_SYNTHETIC_ROOT: resolve(ROOT, FIX_REL),
    GOALPORT_REQUIRE_ISOLATED: "1"
  }, ["--report", `goal-runs/${RC_PRESERVE_SLUG}/evidence/should-not-write.json`]);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /PRIOR|preserved|RC|must be under this-run/i);
});

test("isolated helper fails closed on closure report path even when RUN_SLUG is this-run", () => {
  const evidDb = resolve(ROOT, EVID_REL, "helper-test.sqlite");
  const result = run({
    GOALPORT_CORE_PIPE: thisPipe,
    GOALPORT_CORE_DB: evidDb,
    GOALPORT_SYNTHETIC_ROOT: resolve(ROOT, FIX_REL),
    GOALPORT_REQUIRE_ISOLATED: "1",
    GOALPORT_RUN_SLUG: RUN_SLUG
  }, ["--report", `goal-runs/${CLOSURE_SLUG}/evidence/should-not-write.json`]);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /PRIOR|preserved|closure|must be under this-run/i);
});

test("isolated helper fails closed on sealed Claude admission report path", () => {
  const evidDb = resolve(ROOT, EVID_REL, "helper-test.sqlite");
  const result = run({
    GOALPORT_CORE_PIPE: thisPipe,
    GOALPORT_CORE_DB: evidDb,
    GOALPORT_SYNTHETIC_ROOT: resolve(ROOT, FIX_REL),
    GOALPORT_REQUIRE_ISOLATED: "1"
  }, ["--report", `goal-runs/${CLAUDE_NATIVE_CONTROL_ADMISSION_SLUG}/evidence/should-not-write.json`]);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /PRIOR|preserved|must be under this-run/i);
});

test("isolated helper fails closed on completed Claude fail-open admission report path", () => {
  const evidDb = resolve(ROOT, EVID_REL, "helper-test.sqlite");
  const result = run({
    GOALPORT_CORE_PIPE: thisPipe,
    GOALPORT_CORE_DB: evidDb,
    GOALPORT_SYNTHETIC_ROOT: resolve(ROOT, FIX_REL),
    GOALPORT_REQUIRE_ISOLATED: "1"
  }, ["--report", `goal-runs/${CLAUDE_DENY_FAIL_OPEN_ADMISSION_SLUG}/evidence/should-not-write.json`]);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /PRIOR|preserved|must be under this-run/i);
});

test("isolated helper fails closed on completed Claude notice-stop-dup admission report path", () => {
  const evidDb = resolve(ROOT, EVID_REL, "helper-test.sqlite");
  const result = run({
    GOALPORT_CORE_PIPE: thisPipe,
    GOALPORT_CORE_DB: evidDb,
    GOALPORT_SYNTHETIC_ROOT: resolve(ROOT, FIX_REL),
    GOALPORT_REQUIRE_ISOLATED: "1"
  }, ["--report", `goal-runs/${CLAUDE_NOTICE_STOP_DUP_ADMISSION_SLUG}/evidence/should-not-write.json`]);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /PRIOR|preserved|must be under this-run/i);
});

test("isolated helper fails closed on completed Claude live-deny admission report path", () => {
  const evidDb = resolve(ROOT, EVID_REL, "helper-test.sqlite");
  const result = run({
    GOALPORT_CORE_PIPE: thisPipe,
    GOALPORT_CORE_DB: evidDb,
    GOALPORT_SYNTHETIC_ROOT: resolve(ROOT, FIX_REL),
    GOALPORT_REQUIRE_ISOLATED: "1"
  }, ["--report", `goal-runs/${CLAUDE_LIVE_DENY_ADMISSION_SLUG}/evidence/should-not-write.json`]);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /PRIOR|preserved|must be under this-run/i);
});

test("isolated helper fails closed on completed Claude live-deny db path", () => {
  const result = run({
    GOALPORT_CORE_PIPE: thisPipe,
    GOALPORT_CORE_DB: resolve(ROOT, `goal-runs/${CLAUDE_LIVE_DENY_ADMISSION_SLUG}/evidence/stolen.sqlite`),
    GOALPORT_SYNTHETIC_ROOT: resolve(ROOT, FIX_REL),
    GOALPORT_REQUIRE_ISOLATED: "1"
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /PRIOR|preserved|GOALPORT_CORE_DB must be under/i);
});

test("isolated helper fails closed on closure db path even when RUN_SLUG is this-run", () => {
  const result = run({
    GOALPORT_CORE_PIPE: thisPipe,
    GOALPORT_CORE_DB: resolve(ROOT, `goal-runs/${CLOSURE_SLUG}/evidence/stolen.sqlite`),
    GOALPORT_SYNTHETIC_ROOT: resolve(ROOT, FIX_REL),
    GOALPORT_REQUIRE_ISOLATED: "1",
    GOALPORT_RUN_SLUG: RUN_SLUG
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /PRIOR|preserved|closure|GOALPORT_CORE_DB must be under/i);
});

test("isolated helper fails closed when db is outside this-run folder", () => {
  const outside = resolve(mkdtempSync(resolve(tmpdir(), "goalport-iso-")), "outside.sqlite");
  writeFileSync(outside, "");
  const result = run({
    GOALPORT_CORE_PIPE: thisPipe,
    GOALPORT_CORE_DB: outside,
    GOALPORT_SYNTHETIC_ROOT: resolve(ROOT, FIX_REL),
    GOALPORT_REQUIRE_ISOLATED: "1"
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr || "", /GOALPORT_CORE_DB must be under/);
});

test("isolatedChildEnv ignores overrides that disable isolation or retarget DB", () => {
  const previous = {
    GOALPORT_REQUIRE_ISOLATED: process.env.GOALPORT_REQUIRE_ISOLATED,
    GOALPORT_CORE_PIPE: process.env.GOALPORT_CORE_PIPE,
    GOALPORT_CORE_DB: process.env.GOALPORT_CORE_DB,
    GOALPORT_SYNTHETIC_ROOT: process.env.GOALPORT_SYNTHETIC_ROOT
  };
  process.env.GOALPORT_REQUIRE_ISOLATED = "1";
  process.env.GOALPORT_CORE_PIPE = thisPipe;
  process.env.GOALPORT_CORE_DB = resolve(ROOT, EVID_REL, "helper-test.sqlite");
  process.env.GOALPORT_SYNTHETIC_ROOT = resolve(ROOT, FIX_REL);
  try {
    const env = isolatedChildEnv({
      GOALPORT_REQUIRE_ISOLATED: "0",
      GOALPORT_CORE_DB: `goal-runs/${PRIOR_SLUG}/evidence/stolen.sqlite`
    });
    assert.equal(env.GOALPORT_REQUIRE_ISOLATED, "1");
    assert.equal(env.GOALPORT_CORE_DB, process.env.GOALPORT_CORE_DB);
    assert.equal(env.GOALPORT_CORE_PIPE, process.env.GOALPORT_CORE_PIPE);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("underDir rejects parent directory and any .. segment", () => {
  const parentEscape = resolve(EVID, "..");
  assert.equal(underDir(parentEscape, EVID), false);
  const grandparent = resolve(EVID, "..", "..");
  assert.equal(underDir(grandparent, EVID), false);
  assert.equal(underDir(EVID, EVID), true);
  assert.equal(underDir(resolve(EVID, "child.json"), EVID), true);
});
