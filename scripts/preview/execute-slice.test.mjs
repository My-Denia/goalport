// Pure pins for the execute-slice preview fixture. No browser, no dist, no
// network: proves the shared fixture is import-safe (no side effects at
// import time), keeps the seven-state x three-width matrix, injects an
// honestly-labeled synthetic bridge into a built page with the tag-escaping
// discipline, and never lets evidence helpers overwrite old outputs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const fixtureUrl = new URL("./execute-slice-fixture.mjs", import.meta.url);

test("importing the fixture module has no side effects (no files created or changed)", async () => {
  const before = readdirSync(resolve("scripts/preview")).sort();
  const fixture = await import(fixtureUrl.href);
  const after = readdirSync(resolve("scripts/preview")).sort();
  assert.deepEqual(after, before);
  assert.equal(typeof fixture.executeSlicePageHtml, "function");
});

test("fixture keeps the 21-image matrix: 7 states x 3 widths", async () => {
  const { EXECUTE_SCENARIOS, EXECUTE_WIDTHS } = await import(fixtureUrl.href);
  assert.deepEqual(EXECUTE_WIDTHS, [860, 1020, 1440]);
  assert.deepEqual(
    [...EXECUTE_SCENARIOS].sort(),
    ["consent", "making-changes", "no-write-stop", "partial-write-failure", "read-budget2-stop", "verified", "verifying"],
  );
  assert.equal(EXECUTE_SCENARIOS.length * EXECUTE_WIDTHS.length, 21);
});

test("scenario plan separates write consent from read-only rounds and pins the chains", async () => {
  const { EXECUTE_SCENARIOS, executeScenarioPlan } = await import(fixtureUrl.href);
  for (const scenario of EXECUTE_SCENARIOS) {
    const plan = executeScenarioPlan(scenario);
    assert.equal(plan.writeConsent, scenario !== "consent" && scenario !== "no-write-stop", scenario);
    assert.equal(plan.goal.length > 0, true, scenario);
  }
  assert.deepEqual(executeScenarioPlan("consent").expectedLaunches, []);
  assert.deepEqual(executeScenarioPlan("no-write-stop").expectedLaunches, ["plan", "review"]);
  assert.deepEqual(executeScenarioPlan("read-budget2-stop").expectedLaunches, ["plan", "review"]);
  assert.deepEqual(executeScenarioPlan("verified").expectedLaunches, ["plan", "review", "execute", "audit"]);
  assert.equal(executeScenarioPlan("read-budget2-stop").readTurns, 2);
  assert.equal(executeScenarioPlan("making-changes").hold, "execute");
  assert.equal(executeScenarioPlan("verifying").hold, "audit");
  assert.equal(executeScenarioPlan("partial-write-failure").partialFailure, true);
});

test("page injection embeds the labeled synthetic bridge before </head>, deterministically", async () => {
  const { executeSlicePageHtml, SYNTHETIC_LABEL } = await import(fixtureUrl.href);
  const indexHtml = "<!doctype html><html><head>  </head><body><div id=root></div></body></html>";
  const page = executeSlicePageHtml(indexHtml);
  assert.notEqual(page, indexHtml);
  assert.ok(page.indexOf(SYNTHETIC_LABEL) < page.indexOf("</head>"), "label must be injected in the head");
  for (const marker of ["window.goalportCore", "coordinationAuthorize", "writeTurnsRemaining", "requestClose", "window.__ex", "window.__GOALPORT_ELECTRON__"]) {
    assert.ok(page.includes(marker), `bridge must contain ${marker}`);
  }
  assert.deepEqual(executeSlicePageHtml(indexHtml), page, "injection must be deterministic");
  assert.throws(() => executeSlicePageHtml("<html><body></body></html>"), /<\/head>/);
});

test("bridge is browser-only: no host/process access and JSON values cannot close the script tag", async () => {
  const { executeSliceBridgeScript, jsonValueForScript } = await import(fixtureUrl.href);
  const bridge = executeSliceBridgeScript();
  for (const forbidden of ["node:", "require(", "process.", "child_process", "exec(", "spawn("]) {
    assert.ok(!bridge.includes(forbidden), `bridge must not contain ${forbidden}`);
  }
  assert.equal(jsonValueForScript("<script>"), '"\\u003cscript>"');
  assert.ok(!jsonValueForScript("</script>").includes("</script>"));
  assert.ok(jsonValueForScript("\u2028\u2029").includes("\\u2028"));
});

test("prepareFreshEvidenceDir creates fresh dirs and refuses to touch existing evidence", async () => {
  const { prepareFreshEvidenceDir } = await import(fixtureUrl.href);
  const root = mkdtempSync(join(tmpdir(), "execute-slice-test-"));
  try {
    const fresh = prepareFreshEvidenceDir(join(root, "new-dir"));
    assert.equal(statSync(fresh).isDirectory(), true);
    assert.equal(prepareFreshEvidenceDir(join(root, "new-dir")), fresh, "empty existing dir is reusable");
    const full = join(root, "full");
    mkdirSync(full);
    writeFileSync(join(full, "old-evidence.png"), "old evidence");
    const listingBefore = readdirSync(full);
    assert.throws(() => prepareFreshEvidenceDir(full), /not empty/);
    assert.deepEqual(readdirSync(full), listingBefore, "refusal must not write into the dir");
    const plainFile = join(root, "plain-file");
    writeFileSync(plainFile, "not a dir");
    assert.throws(() => prepareFreshEvidenceDir(plainFile), /not a directory/);
    assert.throws(() => prepareFreshEvidenceDir(join(plainFile, "deeper")), /ENOTDIR|not a directory/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sha256File hashes exactly the bytes the injected reader returns", async () => {
  const { sha256File } = await import(fixtureUrl.href);
  const digest = sha256File("ignored-path", { readFile: () => "abc" });
  assert.equal(digest, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
