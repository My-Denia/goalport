import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { canonicalSemanticHashFromParsed, soakCompanionIdentityMatch, strip } from "./v1-closure-identity.mjs";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const EVID_THIS = resolve(ROOT, "goal-runs/goalport-stable-v1-closure/evidence");
// preserved RC folder goalport-electron-stable-v1
const RC_EVID = resolve(ROOT, "goal-runs", ["goalport", "electron", "stable", "v1"].join("-"), "evidence");
const identity = resolve(fileURLToPath(new URL("./v1-closure-identity.mjs", import.meta.url)));
const L6_ID = "closure-4242-1700000000000";
const FREEZE = {
  coreSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  exeSha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  asarSha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  freezeNonce: "test-nonce"
};

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function seedEvid(label) {
  const evid = resolve(tmpdir(), `goalport-id-${label}-${process.pid}-${Date.now()}`);
  mkdirSync(evid, { recursive: true });
  copyFileSync(resolve(EVID_THIS, "historical-canonical-hashes.json"), resolve(evid, "historical-canonical-hashes.json"));
  copyFileSync(resolve(EVID_THIS, "historical-exact-hashes.json"), resolve(evid, "historical-exact-hashes.json"));
  writeFileSync(resolve(evid, "historical-census-skip.log"), "");
  writeFileSync(resolve(evid, "soak-heartbeat.log"), `--operation-id ${L6_ID}\n`);
  writeFileSync(resolve(evid, "freeze-identity.json"), `${JSON.stringify(FREEZE)}\n`);
  writeFileSync(resolve(evid, "electron-artifact.json"), `${JSON.stringify({
    schemaVersion: 1,
    kind: "electron-artifact",
    coreSha256: FREEZE.coreSha256,
    exeSha256: FREEZE.exeSha256,
    asarSha256: FREEZE.asarSha256,
    status: "UNMET"
  })}\n`);
  return evid;
}

function runGate(evid) {
  return spawnSync(process.execPath, [
    identity,
    "--artifact", resolve(evid, "electron-artifact.json"),
    "--evidence-root", evid
  ], { cwd: ROOT, encoding: "utf8", windowsHide: true });
}

function writeSoakStub(evid) {
  writeFileSync(resolve(evid, "soak-1800s.json"), `${JSON.stringify({
    schemaVersion: 1,
    kind: "real-active-runtime-soak",
    status: "UNMET",
    runLabel: `fixture-${basename(evid)}`,
    coreSha256: FREEZE.coreSha256,
    exeSha256: FREEZE.exeSha256,
    host: "electron-packaged",
    evidenceValidation: { lifecycle: false, reopen: false, process: false }
  })}\n`);
}

function restamp(srcName, destPath, extra = {}) {
  const src = JSON.parse(readFileSync(resolve(RC_EVID, srcName), "utf8"));
  const out = {
    ...src,
    coreSha256: FREEZE.coreSha256,
    exeSha256: FREEZE.exeSha256,
    host: "electron-packaged",
    emittedBy: "restamp-test",
    freezeNonce: "restamp",
    ...extra
  };
  writeFileSync(destPath, `${JSON.stringify(out, null, 2)}\n`);
  return out;
}

test("soak companion identity matcher accepts same ids and rejects mismatch", () => {
  const parent = { operationId: L6_ID, coreBuildId: "b", coreSha256: "c", pipeHash: "p", dbHash: "d", attemptId: "a" };
  const ok = { ...parent, kind: "lifecycle" };
  const bad = { ...parent, attemptId: "other" };
  assert.equal(soakCompanionIdentityMatch(parent, ok), true);
  assert.equal(soakCompanionIdentityMatch(parent, bad), false);
  assert.equal(soakCompanionIdentityMatch(parent, null), false);
});

function writeSaf02P1(evid) {
  const historical = JSON.parse(readFileSync(resolve(RC_EVID, "saf-02-owner-only.json"), "utf8"));
  const stdoutPath = resolve(evid, "raw-run/saf-02/stdout.json");
  mkdirSync(dirname(stdoutPath), { recursive: true });
  const stdoutBody = `${JSON.stringify(historical)}\n`;
  writeFileSync(stdoutPath, stdoutBody);
  const argv = [
    process.execPath,
    resolve(ROOT, "scripts/connected/v1-saf-02-owner-only.mjs"),
    "--operation-id",
    L6_ID
  ];
  const sidecar = {
    evidenceClass: "saf-02",
    operationId: L6_ID,
    argv,
    stdoutPath,
    stdoutSha256: sha256(readFileSync(stdoutPath)),
    closedAtUtc: "2026-09-01T00:00:00.000Z",
    sidecarClosed: true,
    cimCapture: {
      ProcessId: 4242,
      ExecutablePath: process.execPath,
      CommandLine: `${process.execPath} ${resolve(ROOT, "scripts/connected/v1-saf-02-owner-only.mjs")} --operation-id ${L6_ID}`
    }
  };
  const sidecarPath = resolve(evid, "raw-run/saf-02", `${L6_ID}.json`);
  writeFileSync(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);
  const sidecarSha256 = sha256(readFileSync(sidecarPath));
  const later = new Date(Date.now() + 2000);
  const f = {
    ...historical,
    operationId: L6_ID,
    sidecarSha256,
    coreSha256: FREEZE.coreSha256,
    exeSha256: FREEZE.exeSha256,
    host: "electron-packaged"
  };
  const fPath = resolve(evid, "saf-02-owner-only.json");
  writeFileSync(fPath, `${JSON.stringify(f, null, 2)}\n`);
  utimesSync(fPath, later, later);
  assert.equal(JSON.stringify(strip(JSON.parse(stdoutBody))), JSON.stringify(strip(f)));
  return { fPath, sidecarPath, sidecarSha256 };
}

test("identity N1 restamp historical JSON is rejected", () => {
  const cases = ["saf-02-owner-only.json", "sec-01-exclusion.json", "core-crash-final.json"];
  for (const name of cases) {
    const evid = seedEvid(`n1-${name}`);
    restamp(name, resolve(evid, name));
    const result = runGate(evid);
    assert.notEqual(result.status, 0, name);
  }
});

test("identity N2 restamp plus soak sidecar is rejected", () => {
  const evid = seedEvid("n2");
  mkdirSync(resolve(evid, "raw-run/soak"), { recursive: true });
  const soakSidecar = resolve(evid, "raw-run/soak", `${L6_ID}.json`);
  writeFileSync(soakSidecar, `${JSON.stringify({
    evidenceClass: "soak",
    operationId: L6_ID,
    argv: ["node", "scripts/connected/verify-soak.mjs", "--operation-id", L6_ID],
    stdoutPath: resolve(evid, "raw-run/soak/stdout.json"),
    stdoutSha256: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    closedAtUtc: "2026-09-01T00:00:00.000Z",
    sidecarClosed: true,
    cimCapture: { ProcessId: 4242, ExecutablePath: "GoalPort.exe", CommandLine: "GoalPort.exe goalport-stable-v1-closure" },
    heartbeatPath: resolve(evid, "soak-heartbeat.log"),
    heartbeatSha256: sha256(readFileSync(resolve(evid, "soak-heartbeat.log"))),
    firstHostPid: 4242,
    unixMs: 1700000000000
  })}\n`);
  const soakHash = sha256(readFileSync(soakSidecar));
  for (const name of ["saf-02-owner-only.json", "sec-01-exclusion.json", "core-crash-final.json"]) {
    restamp(name, resolve(evid, name), { operationId: L6_ID, sidecarSha256: soakHash });
  }
  const result = runGate(evid);
  assert.notEqual(result.status, 0);
});

test("identity N3 omitted operationId hash-in-H is rejected", () => {
  const evid = seedEvid("n3");
  restamp("saf-02-owner-only.json", resolve(evid, "saf-02-owner-only.json"));
  const result = runGate(evid);
  assert.notEqual(result.status, 0);
});

test("identity N4 D/crash binding soak sidecar is rejected", () => {
  const evid = seedEvid("n4");
  mkdirSync(resolve(evid, "raw-run/soak"), { recursive: true });
  const soakSidecar = resolve(evid, "raw-run/soak", `${L6_ID}.json`);
  writeFileSync(soakSidecar, `${JSON.stringify({
    evidenceClass: "soak",
    operationId: L6_ID,
    argv: ["node", "scripts/connected/verify-soak.mjs", "--operation-id", L6_ID],
    stdoutPath: resolve(evid, "x.json"),
    stdoutSha256: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    closedAtUtc: "2026-09-01T00:00:00.000Z",
    sidecarClosed: true,
    cimCapture: { ProcessId: 1, ExecutablePath: "x", CommandLine: "x --operation-id " + L6_ID },
    heartbeatPath: resolve(evid, "soak-heartbeat.log"),
    heartbeatSha256: sha256(readFileSync(resolve(evid, "soak-heartbeat.log"))),
    firstHostPid: 1,
    unixMs: 1700000000000
  })}\n`);
  restamp("saf-02-owner-only.json", resolve(evid, "saf-02-owner-only.json"), {
    operationId: L6_ID,
    sidecarSha256: sha256(readFileSync(soakSidecar))
  });
  const result = runGate(evid);
  assert.notEqual(result.status, 0);
});

test("identity N5 touch sidecar after F is rejected", () => {
  const evid = seedEvid("n5");
  const { sidecarPath } = writeSaf02P1(evid);
  const body = readFileSync(sidecarPath);
  writeFileSync(sidecarPath, Buffer.concat([body, Buffer.from("\n")]));
  const later = new Date(Date.now() + 4000);
  utimesSync(sidecarPath, later, later);
  const result = runGate(evid);
  assert.notEqual(result.status, 0, result.stderr + result.stdout);
});

test("identity P1 class-local saf-02 is allowed", () => {
  const evid = seedEvid("p1");
  writeSaf02P1(evid);
  writeSoakStub(evid);
  const result = runGate(evid);
  assert.equal(result.status, 0, result.stderr + result.stdout);
});

test("identity P1 allow and N1-N5 reject in the same run", () => {
  const evid = seedEvid("combo");
  writeSaf02P1(evid);
  writeSoakStub(evid);
  restamp("sec-01-exclusion.json", resolve(evid, "sec-01-exclusion.json"));
  restamp("core-crash-final.json", resolve(evid, "core-crash-final.json"));
  const result = runGate(evid);
  assert.notEqual(result.status, 0);
  const parsed = JSON.parse(result.stdout || "{}");
  const failedNames = (parsed.failed || []).map((item) => String(item.file || "").replaceAll("\\", "/"));
  assert.equal(failedNames.some((name) => name.endsWith("saf-02-owner-only.json")), false);
  assert.equal(failedNames.some((name) => name.endsWith("sec-01-exclusion.json")), true);
  assert.equal(failedNames.some((name) => name.endsWith("core-crash-final.json")), true);
});

test("identity empty candidate set is rejected", () => {
  const evid = seedEvid("empty");
  const result = runGate(evid);
  assert.notEqual(result.status, 0, result.stderr + result.stdout);
  const parsed = JSON.parse(result.stdout || "{}");
  const reasons = (parsed.failed || []).map((item) => item.reason);
  assert.equal(reasons.includes("empty-candidate-set") || reasons.includes("soak-1800s-missing"), true);
});

test("identity soak L6 pid mismatch is rejected", () => {
  const evid = seedEvid("l6pid");
  const historical = JSON.parse(readFileSync(resolve(RC_EVID, "soak-1800s.json"), "utf8"));
  mkdirSync(resolve(evid, "raw-run/soak"), { recursive: true });
  const stdoutPath = resolve(evid, "raw-run/soak/stdout.json");
  writeFileSync(stdoutPath, `${JSON.stringify(historical)}\n`);
  const sidecar = {
    evidenceClass: "soak",
    operationId: L6_ID,
    argv: [process.execPath, resolve(ROOT, "scripts/connected/verify-soak.mjs"), "--operation-id", L6_ID],
    stdoutPath,
    stdoutSha256: sha256(readFileSync(stdoutPath)),
    closedAtUtc: "2026-09-01T00:00:00.000Z",
    sidecarClosed: true,
    cimCapture: {
      ProcessId: 9999,
      ExecutablePath: resolve(ROOT, "goal-runs/goalport-stable-v1-closure/evidence/electron-package/GoalPort-win32-x64/GoalPort.exe"),
      CommandLine: `${resolve(ROOT, "goal-runs/goalport-stable-v1-closure/evidence/electron-package/GoalPort-win32-x64/GoalPort.exe")} goalport-stable-v1-closure`
    },
    heartbeatPath: resolve(evid, "soak-heartbeat.log"),
    heartbeatSha256: sha256(readFileSync(resolve(evid, "soak-heartbeat.log"))),
    firstHostPid: 9999,
    unixMs: 1700000000000,
    artifacts: { "soak-1800s.json": stdoutPath }
  };
  const sidecarPath = resolve(evid, "raw-run/soak", `${L6_ID}.json`);
  writeFileSync(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);
  const f = {
    ...historical,
    operationId: L6_ID,
    sidecarSha256: sha256(readFileSync(sidecarPath)),
    coreSha256: FREEZE.coreSha256,
    exeSha256: FREEZE.exeSha256,
    host: "electron-packaged"
  };
  const fPath = resolve(evid, "soak-1800s.json");
  writeFileSync(fPath, `${JSON.stringify(f, null, 2)}\n`);
  utimesSync(fPath, new Date(Date.now() + 2000), new Date(Date.now() + 2000));
  const result = runGate(evid);
  assert.notEqual(result.status, 0, result.stderr + result.stdout);
  const parsed = JSON.parse(result.stdout || "{}");
  const reasons = (parsed.failed || []).map((item) => item.reason);
  assert.equal(reasons.some((reason) => /C4-sidecar-pid-l6|C4-l6-heartbeat-bind|C4-soak-pid/.test(reason)), true);
});

