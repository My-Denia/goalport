import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
const require = createRequire(import.meta.url);
const { launchArguments, prepareProfile, assertCoreIdentity, childEnvironment } = require("../../electron/launch-config.cjs");
const { invokeCoreRequest, acknowledgedStopSnapshot } = require("../../electron/core-client.cjs");

const hash = "a".repeat(64);
function fixture(t) {
  const root = mkdtempSync(resolve(tmpdir(), "goalport-launch-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
const settings = (root, args = {}) => ({ appData: root, version: "1.0.0-rc.1", coreSha256: hash, args });

test("normal RC starts in product data and test profile has a different pipe", (t) => {
  const root = fixture(t);
  const normal = prepareProfile(settings(root));
  const synthetic = prepareProfile(settings(root, { "--test-profile": resolve(root, "isolated") }));
  assert.equal(normal.directory, resolve(root, "GoalPort/rc"));
  assert.equal(normal.testMode, false);
  assert.equal(synthetic.testMode, true);
  assert.notEqual(normal.pipe, synthetic.pipe);
  assert.notEqual(normal.pipe, "\\\\.\\pipe\\goalport-core-v1");
  assert.deepEqual(prepareProfile(settings(root)), normal);
});

test("legacy DB, mode change and changed build refuse without touching preimages", (t) => {
  const root = fixture(t);
  const db = resolve(root, "goalport.sqlite");
  writeFileSync(db, "historic database");
  assert.throws(() => prepareProfile(settings(root, { "--data-dir": root })), /legacy databases/);
  assert.equal(readFileSync(db, "utf8"), "historic database");
  const profile = prepareProfile(settings(root));
  const marker = readFileSync(resolve(profile.directory, "goalport-profile.json"), "utf8");
  assert.throws(() => prepareProfile(settings(root, { "--test-profile": profile.directory })), /different profile/);
  assert.throws(() => prepareProfile({ ...settings(root), coreSha256: "b".repeat(64) }), /another RC build/);
  assert.equal(readFileSync(resolve(profile.directory, "goalport-profile.json"), "utf8"), marker);
});

test("attachment requires committed startup receipt, matching database, pipe and Core hash", (t) => {
  const root = fixture(t);
  const profile = prepareProfile(settings(root));
  const receipt = { startupState: "READY_COMMITTED", core: { executableSha256: hash }, databaseIdentity: profile.database, pipeIdentity: profile.pipe };
  assert.doesNotThrow(() => assertCoreIdentity(receipt, profile));
  for (const wrong of [
    { ...receipt, startupState: "STARTUP_PENDING" }, { ...receipt, core: { executableSha256: "b".repeat(64) } },
    { ...receipt, databaseIdentity: resolve(root, "old.sqlite") }, { ...receipt, pipeIdentity: "\\\\.\\pipe\\goalport-core-v1" }
  ]) assert.throws(() => assertCoreIdentity(wrong, profile), /attachment refused/);
});

test("normal environment ignores historical test identity while native configuration remains owned", (t) => {
  const profile = prepareProfile(settings(fixture(t)));
  const env = { GOALPORT_REQUIRE_ISOLATED: "1", GOALPORT_CORE_DB: "old.sqlite", GOALPORT_CORE_PIPE: "old", GOALPORT_SYNTHETIC_ROOT: "old", GOALPORT_CLAUDE_FIXTURE_INTERPRETER: "old.exe", GOALPORT_TEST_SYNTHETIC_ONLY: "1", GOALPORT_CODEX_APPROVAL_POLICY: "on-request", USERPROFILE: "native-owned" };
  const clean = childEnvironment(env, profile);
  assert.equal(clean.GOALPORT_REQUIRE_ISOLATED, undefined);
  assert.equal(clean.GOALPORT_CORE_DB, undefined);
  assert.equal(clean.GOALPORT_SYNTHETIC_ROOT, undefined);
  assert.equal(clean.GOALPORT_TEST_SYNTHETIC_ONLY, undefined);
  assert.equal(clean.GOALPORT_CLAUDE_FIXTURE_INTERPRETER, undefined);
  assert.equal(clean.GOALPORT_CODEX_APPROVAL_POLICY, "on-request");
  assert.equal(clean.USERPROFILE, "native-owned");
  const testEnv = childEnvironment(env, { ...profile, testMode: true });
  assert.equal(testEnv.GOALPORT_REQUIRE_ISOLATED, "1");
  assert.equal(testEnv.GOALPORT_TEST_SYNTHETIC_ONLY, "1");
  assert.equal(testEnv.GOALPORT_SYNTHETIC_ROOT, undefined);
});

test("profile arguments require explicit absolute paths and cannot mix modes", () => {
  assert.throws(() => launchArguments(["--data-dir", "relative"]), /absolute/);
  assert.throws(() => launchArguments(["--test-profile"]), /Missing/);
  assert.throws(() => launchArguments(["--data-dir", resolve("a"), "--test-profile", resolve("b")]), /cannot be combined/);
});

test("a lost mutation acknowledgement does not retry or launch another Core", async () => {
  for (const messageType of ["send_message", "select_runtime", "create_campaign", "continue_in_isolated_workspace"]) {
    let exchanges = 0;
    await assert.rejects(invokeCoreRequest({ messageType, requestId: "same-request" }, {
      exchange: async () => { exchanges += 1; throw new Error("connection closed"); },
      ensureCore: () => assert.fail("must not restart/retry a mutation"), delay: () => assert.fail("must not retry")
    }), /connection closed/);
    assert.equal(exchanges, 1);
  }
});

test("Core rejection stays a refusal and an accepted command retains request/duplicate identity", async () => {
  const request = { messageType: "send_message", requestId: "send-1" };
  const rejected = await invokeCoreRequest(request, { exchange: async () => ({ ok: false, requestId: request.requestId, error: "held" }) });
  assert.deepEqual(rejected, { goalportRejected: true, requestId: "send-1", error: "held" });
  const accepted = { requestId: "send-1", accepted: true, duplicate: true, snapshot: { cursor: 2 } };
  assert.deepEqual(await invokeCoreRequest(request, { exchange: async () => ({ ok: true, requestId: request.requestId, payload: accepted }) }), accepted);
  await assert.rejects(invokeCoreRequest(request, { exchange: async () => ({ ok: true, requestId: request.requestId, payload: { ...accepted, requestId: "other" } }) }), /matching command acknowledgement/);
  for (const staleId of [undefined, "another-request"]) {
    await assert.rejects(invokeCoreRequest(request, { exchange: async () => ({ ok: false, requestId: staleId, error: "held" }) }), /response identity/);
    await assert.rejects(invokeCoreRequest(request, { exchange: async () => ({ ok: true, requestId: staleId, payload: accepted }) }), /response identity/);
  }
});

test("snapshot retry rechecks attachment once and never retries a tagged refusal", async () => {
  let calls = 0, checks = 0;
  const result = await invokeCoreRequest({ messageType: "snapshot", requestId: "read-1" }, {
    exchange: async () => { if (++calls === 1) throw new Error("closed"); return { ok: false, requestId: "read-1", error: "wrong state" }; },
    ensureCore: async () => { checks += 1; }, delay: async () => {}
  });
  assert.equal(calls, 2);
  assert.equal(checks, 1);
  assert.equal(result.goalportRejected, true);
});

test("close Stop consumes the acknowledged snapshot and requires the existing durable hold", async () => {
  const snapshot = { attempt: { id: "held-attempt" }, stopResponsibility: { attemptId: "held-attempt", writeResponsibility: "held" } };
  const ack = { requestId: "stop-1", accepted: true, duplicate: false, snapshot };
  assert.equal(acknowledgedStopSnapshot(ack, "stop-1", true), snapshot);
  assert.throws(() => acknowledgedStopSnapshot({ ...ack, snapshot: { attempt: snapshot.attempt } }, "stop-1", true), /durable-stop-hold-missing/);
  assert.throws(() => acknowledgedStopSnapshot({ ...ack, requestId: "other" }, "stop-1", true), /acknowledgement identity/);
  assert.throws(() => acknowledgedStopSnapshot({ goalportRejected: true, error: "denied" }, "stop-1", true), /denied/);
  assert.doesNotThrow(() => acknowledgedStopSnapshot({ ...ack, snapshot: { attempt: { state: "failed" } } }, "stop-1", false));
});
