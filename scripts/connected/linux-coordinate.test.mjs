import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { DEFAULT_ENGINE_PATH, DEFAULT_WORKER_PATH, main } from "./linux-coordinate.mjs";

const require = createRequire(import.meta.url);
const { createCoordinationJobStore, controlEndpointFor, jobControlEndpoint } = require("../../electron/coordination-job.cjs");
const { createBackgroundSendConsentStore } = require("../../electron/background-send-consent.cjs");
const { saveRecord } = require("../../electron/coordination-record.cjs");
const { authorizeMembershipError, authorizeCoordination } = require("../../electron/coordinate-service.cjs");

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const WORKER_PATH = path.join(PROJECT_ROOT, "electron", "coordination-worker.cjs");
const ENGINE_PATH = path.join(PROJECT_ROOT, "dist", "coordination-engine.cjs");

// The two gate sentences and the subscription rule the CLI must print
// verbatim. Literals on purpose: a reworded constant must fail this test.
const BACKGROUND_FLAG_SENTENCE = "Keep working after closing must be explicitly selected.";
const DURABLE_CONSENT_SENTENCE = "Background Send is not ready in this GoalPort window yet.";
const APIKEY_SENTENCE = "Only harnesses signed in with their own subscription can be authorized.";

const SUBSCRIPTION_PROVIDERS = [
  { instanceId: "codex", displayName: "Codex", auth: { status: "authenticated", type: "subscription" }, models: [{ slug: "default", isDefault: true }] },
  { instanceId: "claude", displayName: "Claude", auth: { status: "authenticated", type: "subscription" }, models: [{ slug: "opus", isDefault: true }] },
];

let sequence = 0;

function writeFixtureFile(root, name, text) {
  const file = path.join(root, name);
  fs.writeFileSync(file, text);
  return file;
}

// Every fixture owns its temp profile, workspace, engine bundle and fake Core
// executable. Discovery, the Core snapshot and spawn are injected: no vendor
// CLI is ever executed and no Core socket is contacted by these tests.
function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-lc-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "profile");
  const workspace = Object.hasOwn(overrides, "workspace") ? overrides.workspace : fs.mkdtempSync(path.join(root, "workspace-"));
  const enginePath = Object.hasOwn(overrides, "enginePath")
    ? overrides.enginePath
    : writeFixtureFile(root, "coordination-engine.cjs", "// fixture coordination engine\n");
  const coreBinary = Object.hasOwn(overrides, "coreBinary")
    ? overrides.coreBinary
    : writeFixtureFile(root, "goalport-core", "fixture core executable\n");
  const database = path.join(root, "core.sqlite");
  // A Linux unix-socket path: short enough for the 107-byte sun_path limit and
  // never bound, because no test opens it.
  const pipe = overrides.pipe ?? path.posix.join("/tmp", `gplc-${process.pid}-${++sequence}`, `${randomBytes(4).toString("hex")}.sock`);
  const providers = overrides.providers ?? SUBSCRIPTION_PROVIDERS;
  const stdout = [];
  const stderr = [];
  const launches = [];
  const snapshotCalls = [];
  const env = {
    HOME: "/home/goalport-fixture",
    PATH: process.env.PATH ?? "",
    ...(overrides.env ?? {}),
  };
  const io = {
    env,
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    discover: overrides.discover ?? (async () => ({ ok: true, providers, stopReason: null })),
    snapshot: overrides.snapshot ?? (async () => {
      snapshotCalls.push(true);
      return { bounds: { projectionUnavailable: false }, attempt: { state: "completed" } };
    }),
    spawn: overrides.spawn ?? ((...args) => {
      launches.push(args);
      return { on() {}, unref() {} };
    }),
    startTimeoutMs: 0,
    enginePath,
    workerPath: WORKER_PATH,
  };
  return { root, dataDir, workspace, enginePath, coreBinary, database, pipe, providers, env, io, stdout, stderr, launches, snapshotCalls };
}

function drain(f) {
  const out = { stdout: f.stdout.join(""), stderr: f.stderr.join(""), lines: [...f.stdout] };
  f.stdout.length = 0;
  f.stderr.length = 0;
  return out;
}

function baseArgs(f, { withCore = true } = {}) {
  const args = ["--data-dir", f.dataDir, "--pipe", f.pipe];
  if (withCore) args.push("--core-binary", f.coreBinary, "--database", f.database);
  return args;
}

async function invoke(f, argv, options = {}) {
  const code = await main([...argv, ...baseArgs(f, options)], f.io);
  return { code, ...drain(f) };
}

function runArgs(f, overrides = {}) {
  const args = [
    "run",
    "--goal", overrides.goal ?? "Plan the fixture change",
    "--workspace", overrides.workspace ?? f.workspace,
    "--turns", String(overrides.turns ?? "4"),
  ];
  if (overrides.instances !== null) args.push("--instances", overrides.instances ?? "codex,claude");
  if (overrides.writeInstances) args.push("--write-instances", overrides.writeInstances);
  if (overrides.writeTurns) args.push("--write-turns", String(overrides.writeTurns));
  if (overrides.background !== false) args.push("--background");
  if (overrides.requestId) args.push("--request-id", overrides.requestId);
  return args;
}

function storeOf(f) {
  return createCoordinationJobStore(f.dataDir, { bootstrapReady: true });
}

function jobsDirectory(f) {
  return path.join(f.dataDir, "coordination-jobs");
}

function jobIdOf(out) {
  const match = /^job: (\S+)$/m.exec(out.stdout);
  assert.ok(match, `expected a job line in:\n${out.stdout}${out.stderr}`);
  return match[1];
}

test("run refuses without --background and without durable consent, each with its own sentence", async (t) => {
  const f = fixture(t);

  // The durable store was never granted. An ambient GOALPORT_COORDINATE_SEND=1
  // is stripped, so it is not a grant either.
  f.io.env.GOALPORT_COORDINATE_SEND = "1";
  const noConsent = await invoke(f, runArgs(f));
  assert.equal(noConsent.code, 1);
  assert.equal(noConsent.stderr.trim(), DURABLE_CONSENT_SENTENCE);
  assert.equal(f.launches.length, 0);
  assert.equal(fs.existsSync(jobsDirectory(f)), false);

  const granted = await invoke(f, ["grant-access"]);
  assert.equal(granted.code, 0);
  assert.match(granted.stdout, /^consent: granted \(/m);
  assert.equal(fs.existsSync(jobsDirectory(f)), false);

  // Consent is granted now, so the only remaining gate is the explicit flag.
  delete f.io.env.GOALPORT_COORDINATE_SEND;
  const noFlag = await invoke(f, runArgs(f, { background: false }));
  assert.equal(noFlag.code, 1);
  assert.equal(noFlag.stderr.trim(), BACKGROUND_FLAG_SENTENCE);
  assert.equal(f.launches.length, 0);
  assert.equal(fs.existsSync(jobsDirectory(f)), false);
});

test("apiKey membership is refused by the authorization bridge and by run", async (t) => {
  const apiKeyProviders = [{ instanceId: "codex", auth: { status: "authenticated", type: "apiKey" } }];
  assert.equal(authorizeMembershipError({ ok: true, providers: apiKeyProviders }, ["codex"]), APIKEY_SENTENCE);
  assert.equal(authorizeMembershipError({ ok: true, providers: [{ instanceId: "pi", auth: { status: "authenticated", type: "unknown" } }] }, ["pi"]), null);
  assert.equal(authorizeMembershipError({ ok: true, providers: SUBSCRIPTION_PROVIDERS }, ["codex"]), null);
  assert.equal(authorizeMembershipError({ ok: false, providers: [] }, ["codex"]), APIKEY_SENTENCE);

  const calls = [];
  const scope = {
    authorize: (instances, maxTurns, write) => {
      calls.push({ instances, maxTurns, write });
      return { ok: true, generation: 1, remaining: maxTurns, maxTurns };
    },
  };
  const refused = await authorizeCoordination({ instances: ["codex"], maxTurns: 4 }, scope, async () => ({ ok: true, providers: apiKeyProviders }));
  assert.equal(refused.ok, false);
  assert.equal(refused.errorText, APIKEY_SENTENCE);
  assert.equal(calls.length, 0);
  const accepted = await authorizeCoordination({ instances: ["codex"], maxTurns: 4 }, scope, async () => ({ ok: true, providers: SUBSCRIPTION_PROVIDERS }));
  assert.equal(accepted.ok, true);
  assert.equal(calls.length, 1);

  const f = fixture(t, { providers: apiKeyProviders });
  await invoke(f, ["grant-access"]);
  const run = await invoke(f, runArgs(f, { instances: "codex" }));
  assert.equal(run.code, 1);
  assert.equal(run.stderr.trim(), APIKEY_SENTENCE);
  assert.equal(f.launches.length, 0);
  assert.equal(fs.existsSync(jobsDirectory(f)), false);
});

test("write flags are opt-in, subscription-only, and never inferred", async (t) => {
  const plain = fixture(t);
  await invoke(plain, ["grant-access"]);
  const readOnly = await invoke(plain, runArgs(plain, { requestId: "read-default" }));
  assert.equal(readOnly.code, 0, readOnly.stderr);
  assert.equal(storeOf(plain).getActiveStatus().admission.writeAuthorization, null);

  const partial = fixture(t);
  await invoke(partial, ["grant-access"]);
  const missingTurns = await invoke(partial, runArgs(partial, { requestId: "write-partial", writeInstances: "codex" }));
  assert.equal(missingTurns.code, 1);
  assert.match(missingTurns.stderr, /both --write-instances and --write-turns/);
  assert.equal(partial.launches.length, 0);
  assert.equal(fs.existsSync(jobsDirectory(partial)), false);

  const unknownWriter = fixture(t, {
    providers: [
      ...SUBSCRIPTION_PROVIDERS,
      { instanceId: "pi", displayName: "Pi", auth: { status: "authenticated", type: "unknown" }, models: [{ slug: "default", isDefault: true }] },
    ],
  });
  await invoke(unknownWriter, ["grant-access"]);
  const named = await invoke(unknownWriter, runArgs(unknownWriter, {
    instances: "codex,pi",
    requestId: "use-pi",
  }));
  assert.equal(named.code, 0, named.stderr);
  assert.deepEqual(storeOf(unknownWriter).getActiveStatus().admission.allowedInstances, ["codex", "pi"]);
  const refused = await invoke(unknownWriter, runArgs(unknownWriter, {
    instances: "codex,pi",
    requestId: "write-pi",
    writeInstances: "pi",
    writeTurns: "1",
  }));
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /Pi runs read-only turns/);
  assert.equal(unknownWriter.launches.length, 1);

  const admitted = fixture(t);
  await invoke(admitted, ["grant-access"]);
  const wrote = await invoke(admitted, runArgs(admitted, { requestId: "write-codex", writeInstances: "codex", writeTurns: "1" }));
  assert.equal(wrote.code, 0, wrote.stderr);
  assert.deepEqual(storeOf(admitted).getActiveStatus().admission.writeAuthorization, {
    instances: ["codex"],
    workspaceRoot: admitted.workspace,
    maxTurns: 1,
  });
  assert.deepEqual(storeOf(admitted).getActiveStatus().admission.allowedInstances, ["codex", "claude"]);
});

test("omitted --instances selects only confirmed subscription logins", async (t) => {
  const f = fixture(t, {
    providers: [
      ...SUBSCRIPTION_PROVIDERS.filter((provider) => provider.instanceId === "codex"),
      { instanceId: "pi", displayName: "Pi", auth: { status: "authenticated", type: "unknown" }, models: [{ slug: "default", isDefault: true }] },
    ],
  });
  await invoke(f, ["grant-access"]);
  drain(f);
  const run = await invoke(f, runArgs(f, { instances: null, requestId: "unknown-not-default" }));
  assert.equal(run.code, 1);
  assert.match(run.stderr, /second logged-in harness/);
  assert.equal(f.launches.length, 0);
});

test("run spawns the detached worker with the main-process config contract and a stripped environment", async (t) => {
  const f = fixture(t, {
    env: {
      GOALPORT_COORDINATE_SEND: "1",
      GOALPORT_HARNESS_CHECKOUT: "/pinned/checkout",
      GOALPORT_HARNESS_SERVER_CWD: "/pinned/checkout/apps/server",
    },
  });
  await invoke(f, ["grant-access"]);
  drain(f);

  const run = await invoke(f, runArgs(f, { requestId: "contract-one" }));
  assert.equal(run.code, 0, run.stderr);
  assert.equal(f.launches.length, 1);
  assert.equal(f.snapshotCalls.length, 1);

  const [file, argv, spawnOptions] = f.launches[0];
  assert.equal(file, process.execPath);
  assert.equal(argv.length, 2);
  assert.equal(argv[0], WORKER_PATH);
  const config = JSON.parse(argv[1]);
  const jobId = jobIdOf(run);

  assert.equal(config.jobId, jobId);
  assert.equal(config.directory, f.dataDir);
  assert.equal(config.connectPath, f.pipe);
  assert.equal(config.identity.pipe, config.connectPath);
  assert.equal(config.servePipe, f.pipe);
  assert.equal(config.identity.coreSha256, createHash("sha256").update(fs.readFileSync(f.coreBinary)).digest("hex"));
  assert.equal(config.identity.database, f.database);
  assert.equal(config.stateDir, path.join(f.dataDir, "harness-state"));
  assert.equal(config.enginePath, f.enginePath);

  const expectedControl = jobControlEndpoint(controlEndpointFor(f.pipe, { platform: "linux", env: f.env }), config.jobId);
  assert.equal(config.controlEndpoint, expectedControl);
  assert.notEqual(config.controlEndpoint, config.connectPath);

  assert.equal(spawnOptions.detached, true);
  assert.equal(spawnOptions.stdio, "ignore");
  assert.equal(spawnOptions.env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(spawnOptions.env.PATH, f.env.PATH);
  assert.equal(Object.hasOwn(spawnOptions.env, "GOALPORT_COORDINATE_SEND"), false);
  assert.equal(Object.hasOwn(spawnOptions.env, "GOALPORT_HARNESS_CHECKOUT"), false);
  assert.equal(Object.hasOwn(spawnOptions.env, "GOALPORT_HARNESS_SERVER_CWD"), false);

  assert.match(run.stdout, /^state: unconfirmed$/m);
  assert.match(run.stdout, /^revoked: false$/m);

  // The defaults the CLI wires without an override are the desktop's paths.
  assert.equal(DEFAULT_WORKER_PATH, WORKER_PATH);
  assert.equal(DEFAULT_ENGINE_PATH, ENGINE_PATH);
});

test("a lost start reply stays unconfirmed and is never re-admitted", async (t) => {
  const f = fixture(t);
  await invoke(f, ["grant-access"]);
  drain(f);

  const first = await invoke(f, runArgs(f, { requestId: "lost-reply-one" }));
  assert.equal(first.code, 0, first.stderr);
  const jobId = jobIdOf(first);
  assert.match(first.stdout, /^state: unconfirmed$/m);
  assert.match(first.stdout, /^live: false$/m);
  assert.doesNotMatch(first.stdout, /^state: (running|completed)$/m);
  assert.match(first.stdout, /The job's exit is unconfirmed; it is not replayed\./);
  assert.equal(f.launches.length, 1);

  // The worker never claimed the job, so nothing is running and nothing may be
  // re-admitted by the same durable request id.
  const store = storeOf(f);
  assert.equal(store.getActiveStatus().jobId, jobId);
  assert.equal(store.getStatus(jobId).state, "admitted");
  assert.equal(f.launches.length, 1);

  const retry = await invoke(f, runArgs(f, { requestId: "lost-reply-one" }));
  assert.equal(retry.code, 0, retry.stderr);
  assert.equal(jobIdOf(retry), jobId);
  assert.equal(f.launches.length, 1);

  const status = await invoke(f, ["status", "--job", jobId]);
  assert.equal(status.code, 0);
  assert.equal(jobIdOf(status), jobId);
  assert.match(status.stdout, /^state: unconfirmed$/m);
});

test("stop with unreachable control revokes durably and prints unconfirmed, never stopped", async (t) => {
  const f = fixture(t);
  await invoke(f, ["grant-access"]);
  const run = await invoke(f, runArgs(f, { requestId: "stop-unreachable-one" }));
  const jobId = jobIdOf(run);
  assert.equal(f.launches.length, 1);

  const stopped = await invoke(f, ["stop", "--job", jobId]);
  assert.equal(stopped.code, 0, stopped.stderr);
  assert.match(stopped.stdout, /^state: unconfirmed$/m);
  assert.match(stopped.stdout, /^revoked: true$/m);
  assert.match(stopped.stdout, /^live: false$/m);
  assert.doesNotMatch(`${stopped.stdout}${stopped.stderr}`, /stopped/i);
  assert.match(stopped.stdout, /The stop is durably recorded; the job's exit remains unconfirmed and its turn is not replayed\./);

  const status = storeOf(f).getStatus(jobId);
  assert.equal(status.revoked, true);
  assert.equal(["completed", "failed", "stopped"].includes(status.state), false);
  // Missing live control is not proof that tools stopped: the slot stays held.
  assert.equal(storeOf(f).getActiveStatus().jobId, jobId);
});

test("continue carries the saved plan and review as execution feedback with a fresh request id", async (t) => {
  const f = fixture(t);
  const saved = saveRecord(f.dataDir, {
    requestId: "first-pass",
    workspacePath: f.workspace,
    goal: "First goal",
    planningHarness: "codex",
    reviewHarness: "claude",
    planText: "PLAN FROM THE SAVED RECORD",
    reviewText: "REVIEW FROM THE SAVED RECORD",
    result: "RESULT FROM THE SAVED RECORD",
    verdict: "checked",
    stopReason: "The plan and its review were checked.",
    planningQuota: "unknown",
    reviewQuota: "unknown",
  });
  assert.equal(saved.requestId, "first-pass");
  await invoke(f, ["grant-access"]);

  const result = await invoke(f, ["result", "--request-id", "first-pass"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^verdict: checked$/m);
  assert.match(result.stdout, /^stop reason: The plan and its review were checked\.$/m);
  assert.match(result.stdout, /^planning quota: unknown$/m);
  assert.match(result.stdout, /^review quota: unknown$/m);
  assert.match(result.stdout, /PLAN FROM THE SAVED RECORD/);
  assert.match(result.stdout, /REVIEW FROM THE SAVED RECORD/);
  drain(f);

  const next = await invoke(f, ["continue", "--from", "first-pass", "--goal", "Revise the failing check", "--background"]);
  assert.equal(next.code, 0, next.stderr);
  assert.equal(f.launches.length, 1);
  const jobId = jobIdOf(next);
  assert.equal(JSON.parse(f.launches[0][1][1]).jobId, jobId);

  const admission = storeOf(f).getActiveStatus();
  assert.equal(admission.jobId, jobId);
  assert.equal(admission.admission.goal, "Revise the failing check");
  assert.equal(admission.admission.workspacePath, f.workspace);
  assert.deepEqual(admission.admission.allowedInstances, ["codex", "claude"]);
  assert.notEqual(admission.requestId, "first-pass");
  assert.match(admission.requestId, /^[A-Za-z0-9._-]+$/);
  assert.deepEqual(admission.admission.executionFeedback, {
    previousPlan: "PLAN FROM THE SAVED RECORD",
    previousPlanReview: "REVIEW FROM THE SAVED RECORD",
    previousExecutionReport: null,
    previousExecutionAudit: null,
    previousCommandIds: [],
  });
  // The old request id is never spawned again.
  assert.equal(f.launches.length, 1);

  const missing = await invoke(f, ["continue", "--from", "no-such-record", "--goal", "Second goal", "--background"]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /No saved coordinated-goal record has request id no-such-record/);
  assert.equal(f.launches.length, 1);
});

test("a left job holding the admission slot blocks a new run until it is acknowledged", async (t) => {
  const f = fixture(t);
  await invoke(f, ["grant-access"]);
  const jobDir = path.join(f.dataDir, "coordination-jobs", "jobs", "job-left");
  fs.mkdirSync(jobDir, { recursive: true });
  fs.writeFileSync(path.join(jobDir, "stuck-ack.json"), "{}");
  fs.writeFileSync(path.join(jobDir, "admission.json"), JSON.stringify({ input: { requestId: "left-pass" } }));
  fs.mkdirSync(path.join(f.dataDir, "coordination-jobs"), { recursive: true });
  fs.writeFileSync(path.join(f.dataDir, "coordination-jobs", "active-admission.json"), JSON.stringify({ jobId: "job-left" }));
  const refused = await invoke(f, runArgs(f));
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /A left job still holds the admission slot. Run acknowledge before starting another/);
  assert.equal(f.launches.length, 0);
});

test("a left request does not block a new run", async (t) => {
  const f = fixture(t);
  await invoke(f, ["grant-access"]);
  const jobDir = path.join(f.dataDir, "coordination-jobs", "jobs", "job-left");
  fs.mkdirSync(jobDir, { recursive: true });
  fs.writeFileSync(path.join(jobDir, "stuck-ack.json"), "{}");
  fs.writeFileSync(path.join(jobDir, "admission.json"), JSON.stringify({ input: { requestId: "left-pass" } }));
  const run = await invoke(f, runArgs(f));
  assert.equal(run.code, 0, run.stderr);
  assert.equal(f.launches.length, 1);
  assert.notEqual(storeOf(f).getActiveStatus().requestId, "left-pass");
});

test("run refuses a request id that was left unreplayed", async (t) => {
  const f = fixture(t);
  await invoke(f, ["grant-access"]);
  const jobDir = path.join(f.dataDir, "coordination-jobs", "jobs", "job-left");
  fs.mkdirSync(jobDir, { recursive: true });
  fs.writeFileSync(path.join(jobDir, "stuck-ack.json"), "{}");
  fs.writeFileSync(path.join(jobDir, "admission.json"), JSON.stringify({ input: { requestId: "left-pass" } }));
  const refused = await invoke(f, runArgs(f, { requestId: "left-pass" }));
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /The interrupted job stays unreplayed; the same request id cannot be admitted again/);
  assert.equal(f.launches.length, 0);
});

test("continue refuses a request that was left unreplayed", async (t) => {
  const f = fixture(t);
  saveRecord(f.dataDir, {
    requestId: "left-pass",
    workspacePath: f.workspace,
    goal: "Left goal",
    planningHarness: "codex",
    reviewHarness: "claude",
    planText: "PLAN",
    reviewText: "REVIEW",
    result: "RESULT",
    verdict: "checked",
    stopReason: "Checked.",
    planningQuota: "unknown",
    reviewQuota: "unknown",
  });
  const jobDir = path.join(f.dataDir, "coordination-jobs", "jobs", "job-left");
  fs.mkdirSync(jobDir, { recursive: true });
  fs.writeFileSync(path.join(jobDir, "stuck-ack.json"), "{}");
  fs.writeFileSync(path.join(jobDir, "admission.json"), JSON.stringify({ input: { requestId: "left-pass" } }));
  const refused = await invoke(f, ["continue", "--from", "left-pass", "--goal", "Again", "--background"]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /The interrupted job stays unreplayed; the same request id cannot be admitted again/);
  assert.equal(f.launches.length, 0);
});

function assertNoAdmission(f, out) {
  assert.equal(f.launches.length, 0);
  assert.equal(fs.existsSync(jobsDirectory(f)), false);
  assert.equal(out.stdout.includes("state:"), false);
}

test("endpoint, engine, identity and data-dir preflight refuses before any admission", async (t) => {
  // A socket path over the Linux sun_path capacity is refused before the store
  // is touched; the data dir exists only because consent was granted.
  const longPipe = fixture(t);
  await invoke(longPipe, ["grant-access"]);
  longPipe.pipe = `/tmp/${"a".repeat(120)}.sock`;
  const endpoint = await invoke(longPipe, runArgs(longPipe));
  assert.equal(endpoint.code, 1);
  assert.match(endpoint.stderr, /sun_path capacity is 107 bytes/);
  assertNoAdmission(longPipe, endpoint);

  const relativeWorkspace = fixture(t);
  await invoke(relativeWorkspace, ["grant-access"]);
  const workspaceRun = await invoke(relativeWorkspace, runArgs(relativeWorkspace, { workspace: "relative/place" }));
  assert.equal(workspaceRun.code, 1);
  assert.equal(workspaceRun.stderr.trim(), "The workspace must be an absolute path, so nothing was admitted.");
  assertNoAdmission(relativeWorkspace, workspaceRun);

  const missingEngine = fixture(t);
  await invoke(missingEngine, ["grant-access"]);
  missingEngine.io.enginePath = path.join(missingEngine.root, "missing-engine.cjs");
  const engineRun = await invoke(missingEngine, runArgs(missingEngine));
  assert.equal(engineRun.code, 1);
  assert.match(engineRun.stderr, /The coordination engine bundle is missing; build it with `pnpm build`/);
  assertNoAdmission(missingEngine, engineRun);

  const missingCore = fixture(t);
  await invoke(missingCore, ["grant-access"]);
  const coreRun = await invoke(missingCore, runArgs(missingCore), { withCore: false });
  assert.equal(coreRun.code, 1);
  assert.match(coreRun.stderr, /The Core executable is required: pass --core-binary with an absolute path/);
  assertNoAdmission(missingCore, coreRun);

  const relativeData = fixture(t);
  await createBackgroundSendConsentStore(relativeData.dataDir).grant();
  const relativeDataFlag = `goalport-relative-${process.pid}-${++sequence}`;
  const code = await main([
    ...runArgs(relativeData),
    "--data-dir", relativeDataFlag,
    "--pipe", relativeData.pipe,
    "--core-binary", relativeData.coreBinary,
    "--database", relativeData.database,
  ], relativeData.io);
  const out = drain(relativeData);
  assert.equal(code, 1);
  assert.equal(out.stderr.trim(), "--data-dir must be an absolute path.");
  assert.equal(relativeData.launches.length, 0);
  assert.equal(fs.existsSync(path.join(path.resolve(relativeDataFlag), "coordination-jobs")), false);
});

test("acknowledge leaves an interrupted job unreplayed and release keeps the slot honest", async (t) => {
  const f = fixture(t);
  await invoke(f, ["grant-access"]);
  const run = await invoke(f, runArgs(f, { requestId: "interrupted-one" }));
  const jobId = jobIdOf(run);
  assert.equal(f.launches.length, 1);

  const acknowledged = await invoke(f, ["acknowledge", "--job", jobId]);
  assert.equal(acknowledged.code, 0, acknowledged.stderr);
  assert.match(acknowledged.stdout, /^acknowledged stuck at: \d{4}-/m);
  assert.match(acknowledged.stdout, /The interrupted job stays unreplayed; the same request id cannot be admitted again\./);

  const store = storeOf(f);
  assert.equal(store.getActiveStatus(), null);
  const facts = store.getStatus(jobId);
  assert.equal(typeof facts.acknowledgedStuckAt, "string");
  assert.equal(facts.revoked, false);
  assert.equal(["completed", "failed", "stopped"].includes(facts.state), false);

  // The same durable request id is never admitted again, and nothing respawns.
  const replay = await invoke(f, runArgs(f, { requestId: "interrupted-one" }));
  assert.equal(replay.code, 1);
  assert.match(replay.stderr, /This interrupted send stays unreplayed\. Start a new send; the old turn is not repeated\./);
  assert.equal(f.launches.length, 1);

  const released = await invoke(f, ["release", "--job", jobId]);
  assert.equal(released.code, 0, released.stderr);
  assert.match(released.stdout, /^active: false$/m);
  assert.match(released.stdout, /The profile admission slot is not held by this job\./);
});

test("discover prints consent, capability and apiKey auth type as separate facts", async (t) => {
  const providers = [
    SUBSCRIPTION_PROVIDERS[0],
    { instanceId: "claude", auth: { status: "authenticated", type: "apiKey" }, environmentHealth: { since: "2026-10-23T00:00:00.000Z", detail: "sandbox helper failed" } },
  ];
  const f = fixture(t, { providers });
  const first = await invoke(f, ["discover"]);
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /^consent: not granted$/m);
  assert.match(first.stdout, /^capability: unavailable$/m);
  assert.match(first.stdout, /^provider codex: authenticated \(subscription\)$/m);
  assert.match(first.stdout, /^provider claude: authenticated \(apiKey\)$/m);
  assert.match(first.stdout, /^ {2}environment blocked since 2026-10-23T00:00:00\.000Z: sandbox helper failed$/m);
  assert.equal(f.launches.length, 0);

  await invoke(f, ["grant-access"]);
  const second = await invoke(f, ["discover"]);
  assert.equal(second.code, 0);
  assert.match(second.stdout, /^consent: granted \(/m);
  assert.match(second.stdout, /^capability: available$/m);
});
