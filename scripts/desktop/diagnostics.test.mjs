import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { boundedFailureSummary, collectFailureDiagnostics, collectStartupDiagnostics, extractOriginalInspectTrace, runBoundedProcess, sanitizeDiagnostic, BOOTSTRAP_QUERY_TIMEOUT_MS, CORE_INSPECT_TIMEOUT_MS, CORE_INSPECT_STDOUT_BYTES, ORIGINAL_TRACE_MAX_RECORDS, ORIGINAL_TRACE_STRING_CAP, PROFILE_ROOT_MAX_ENTRIES, SUMMARY_FIELD_BYTES, SUMMARY_MAX_BYTES, TAIL_BYTES, TAIL_LINES, truncateUtf8 } from "./diagnostics.mjs";

test("JSON-escaped private paths in component diagnostics are redacted", () => {
  const root = resolve(tmpdir(), "goalport-diagnostic-owned-profile");
  const text = JSON.stringify({ path: root, error: `Cannot open ${root}` });
  const sanitized = sanitizeDiagnostic(text, [root]);
  assert.ok(!sanitized.includes(JSON.stringify(root).slice(1, -1)));
  assert.match(sanitized, /<private-path>/);
});

test("failure summaries redact before truncating and never exceed their UTF-8 byte budget", () => {
  const root = resolve(tmpdir(), "goalport-diagnostic-bounded-summary-owner");
  const parse = (text) => JSON.parse(text);
  const huge = `${"中".repeat(30000)} ${root}\\profile ${"x".repeat(50000)}`;
  const text = boundedFailureSummary({ schemaVersion: 1, status: "FAIL", stage: "owned-core-cleanup", error: `boom at ${root}`, stack: huge, cleanup: [{ phase: "observe-before-stop", error: huge }] }, [root]);
  const summary = parse(text);
  assert.ok(Buffer.byteLength(text) <= SUMMARY_MAX_BYTES);
  assert.ok(Buffer.byteLength(summary.stack) <= SUMMARY_FIELD_BYTES && /…\[truncated \d+ bytes\]$/.test(summary.stack));
  assert.ok(!summary.stack.includes("�"), "truncation keeps whole UTF-8 characters");
  assert.equal(summary.error, "boom at <private-path>");
  assert.ok(!text.includes(root) && !text.includes(JSON.stringify(root).slice(1, -1)));
  // A path that would straddle the cut is redacted first, so no fragment of it can survive.
  const keptBytes = SUMMARY_FIELD_BYTES - Buffer.byteLength("…[truncated 9999 bytes]");
  const straddle = `${"a".repeat(keptBytes - Buffer.byteLength(tmpdir()) - 1 - "goalport-diagnostic-".length)}${root}${"z".repeat(64)}`;
  const edge = JSON.parse(boundedFailureSummary({ error: straddle }, [root])).error;
  assert.ok(Buffer.byteLength(edge) <= SUMMARY_FIELD_BYTES && edge.includes("<private-path>"));
  assert.ok(!edge.includes("goalport-diagnostic-"));
});

test("an oversized summary drops bulky fields, then shrinks essential fields, and stays valid JSON", () => {
  const cleanup = Array.from({ length: 40 }, (_, index) => ({ phase: "observe-after-stop", error: `${index}`.padEnd(4000, "e") }));
  const dropped = boundedFailureSummary({ schemaVersion: 1, status: "FAIL", mode: "normal", stage: "s", error: "short", stack: "k".repeat(4000), cleanup, steps: [] }, [], { maxBytes: 8192 });
  const parsed = JSON.parse(dropped);
  assert.ok(Buffer.byteLength(dropped) <= 8192); assert.equal(parsed.truncated, true);
  assert.equal(parsed.error, "short"); assert.match(parsed.cleanup, /omitted/);
  const escapes = boundedFailureSummary({ schemaVersion: 1, status: "FAIL", stage: "".repeat(4096), error: "\"\\".repeat(2048) }, [], { maxBytes: 2048 });
  assert.ok(Buffer.byteLength(escapes) <= 2048); assert.equal(JSON.parse(escapes).truncated, true);
  assert.equal(truncateUtf8("中".repeat(10), 16).includes("�"), false);
});

test("a failing log close cannot replace the diagnostics it collected", (t) => {
  const root = mkdtempSync(resolve(tmpdir(), "goalport-diagnostic-close-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = resolve(root, "core.log");
  writeFileSync(file, "stage=core-close\n");
  const opened = [];
  const report = collectFailureDiagnostics({ stage: "owned-core-cleanup", files: { core: file }, privatePaths: [root], close: (fd) => { opened.push(fd); closeSync(fd); throw Object.assign(new Error("close failed"), { code: "EIO" }); } });
  assert.equal(opened.length, 1);
  assert.equal(report.tails.core.available, true);
  assert.match(report.tails.core.text, /stage=core-close/);
});

test("failed child exposes stage and bounded sanitized component logs", async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), "goalport-diagnostic-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = Object.fromEntries(["electron", "launcher", "core"].map((name) => [name, resolve(root, name + ".log")]));
  const fd = openSync(files.electron, "w");
  const child = spawn(process.execPath, ["-e", "console.log('stage=fixture-start'); console.error('fixture failed'); process.exit(23)"], { stdio: ["ignore", fd, fd], windowsHide: true });
  await once(child, "exit");
  closeSync(fd);
  writeFileSync(files.launcher, "old line\n".repeat(2000) + `stage=launcher\n${root}\ntoken=unit-test-placeholder\n`);
  writeFileSync(files.core, "stage=core\nBearer unit-test-placeholder\n");
  const report = collectFailureDiagnostics({ stage: "attach-cdp", child, files: { ...files, absent: resolve(root, "absent.log") }, privatePaths: [root] });
  assert.equal(report.stage, "attach-cdp");
  assert.equal(report.process.pid, child.pid);
  assert.equal(report.process.exitCode, 23);
  assert.equal(report.process.signalCode, null);
  assert.equal(report.process.killed, false);
  assert.match(report.tails.electron.text, /stage=fixture-start[\s\S]*fixture failed/);
  assert.match(report.tails.launcher.text, /stage=launcher/);
  assert.match(report.tails.core.text, /stage=core/);
  assert.equal(report.tails.launcher.truncated, true);
  assert.equal(report.tails.absent.available, false);
  assert.equal(report.tails.absent.code, "ENOENT");
  const serialized = JSON.stringify(report);
  assert.ok(!serialized.includes(root.replaceAll("\\", "\\\\")));
  assert.ok(!serialized.includes("unit-test-placeholder"));
  assert.match(serialized, /<redacted>/);
  for (const entry of Object.values(report.tails).filter((entry) => entry.available)) {
    assert.ok(entry.text.length <= TAIL_BYTES);
    assert.ok(entry.text.split("\n").length <= TAIL_LINES);
  }
});

// ---------- Startup-failure profile diagnostics ----------

test("startup diagnostics capture bootstrap kind, unmatched frozen-allowlist entries and a parsed inspect re-probe", async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), "goalport-diagnostic-startup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(resolve(root, "Cache"));
  writeFileSync(resolve(root, "Local State"), "{}\n");
  writeFileSync(resolve(root, "Unlisted Chromium Artifact"), "x");
  writeFileSync(resolve(root, "Cache", "cache-core.exe"), "MZ");
  const record = await collectStartupDiagnostics({
    profileDirectory: root,
    packageRoot: root,
    coreExecutable: resolve(root, "Cache", "cache-core.exe"),
    privatePaths: [root],
    queryBootstrap: async () => ({ phase: "error", kind: "not-a-profile", headline: "This data directory is not an empty or existing GoalPort profile.", dataPath: resolve(root, "profile") }),
    runProcess: async () => ({ elapsedMs: 12, timedOut: false, exitCode: 0, signal: null, stdout: `${JSON.stringify({ schema: "goalport.profile-ops.v1", ok: true, exists: false })}\n`, stderr: "" })
  });
  assert.equal(record.kind, "startup-profile-diagnostics");
  assert.equal(record.originalStartupInspection.available, false, "no diagnostics child supplied: baseline stays honestly unavailable");
  assert.match(record.originalStartupInspection.reason, /unavailable/);
  assert.equal(record.bootstrap.available, true);
  assert.equal(record.bootstrap.state.kind, "not-a-profile");
  assert.ok(!JSON.stringify(record.bootstrap.state).includes(root), "bootstrap state private path redacted");
  assert.equal(record.profileRoot.available, true);
  assert.deepEqual(record.profileRoot.entries.map((entry) => entry.name).sort(), ["Cache", "Local State", "Unlisted Chromium Artifact"]);
  assert.equal(record.profileRoot.presence.marker.present, false);
  assert.equal(record.profileRoot.presence.database.present, false);
  assert.equal(record.frozenChromiumAllowlist.available, true);
  assert.equal(record.frozenChromiumAllowlist.productEmptyish, false);
  assert.deepEqual(record.frozenChromiumAllowlist.unmatchedNames, ["Unlisted Chromium Artifact"]);
  assert.equal(record.frozenChromiumAllowlist.consistent, true);
  const probe = record.coreInspectReProbe;
  assert.equal(probe.attempted, true);
  assert.equal(probe.kind, "diagnostic-re-probe");
  assert.match(probe.note, /NOT the original startup inspection/);
  assert.equal(probe.timedOut, false);
  assert.equal(probe.exitCode, 0);
  assert.equal(probe.elapsedMs, 12);
  assert.equal(probe.parsed.ok, true);
  assert.equal(probe.parseError, null);
});

test("unavailable bootstrap, absent directories and a missing Core executable are recorded, never thrown", async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), "goalport-diagnostic-absent-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const absent = resolve(root, "does-not-exist");
  const record = await collectStartupDiagnostics({
    profileDirectory: absent,
    packageRoot: root,
    coreExecutable: resolve(root, "missing-core.exe"),
    privatePaths: [root],
    queryBootstrap: async () => { throw new Error("CDP WebSocket closed"); },
    runProcess: async () => ({ elapsedMs: 0, timedOut: false, exitCode: null, signal: null, stdout: "", stderr: "", spawnError: "spawn missing-core.exe ENOENT" })
  });
  assert.equal(record.bootstrap.available, false);
  assert.match(record.bootstrap.error, /CDP WebSocket closed/);
  assert.equal(record.profileRoot.available, false);
  assert.equal(record.profileRoot.code, "ENOENT");
  assert.equal(record.profileRoot.presence.marker.present, false);
  assert.equal(record.frozenChromiumAllowlist.available, false);
  assert.equal(record.coreInspectReProbe.attempted, false);
  assert.equal(record.coreInspectReProbe.executablePresent, false);
  assert.match(record.coreInspectReProbe.note, /no probe ran/);
});

test("a hung bootstrap-current query resolves as unavailable within its bound", async (t) => {
  // Test-owned scratch profile, NOT the real tmpdir root: the collector
  // enumerates profileDirectory, so the fixture must not enumerate (or imply
  // ownership of) the shared OS temp directory.
  const owned = mkdtempSync(resolve(tmpdir(), "goalport-diagnostic-hung-"));
  t.after(() => rmSync(owned, { recursive: true, force: true }));
  const startedAt = Date.now();
  const record = await collectStartupDiagnostics({
    profileDirectory: owned,
    coreExecutable: undefined,
    packageRoot: undefined,
    queryBootstrap: () => new Promise(() => {}),
    bootstrapTimeoutMs: 120
  });
  assert.ok(Date.now() - startedAt < 5000, "timeout bound holds");
  assert.equal(record.bootstrap.available, false);
  assert.match(record.bootstrap.error, /timed out after 120ms/);
  assert.equal(record.coreInspectReProbe.attempted, false);
});

test("runBoundedProcess kills a hung probe and reports elapsed time, exit codes, output and confirmed termination", async () => {
  const hung = await runBoundedProcess({ exe: process.execPath, args: ["-e", "setTimeout(() => {}, 60000)"], timeoutMs: 250 });
  assert.equal(hung.timedOut, true);
  assert.equal(hung.exitCode, null);
  assert.equal(hung.termination.requested, true);
  assert.equal(hung.termination.issued, true, "the kill call was issued against this child");
  assert.equal(hung.termination.killError, null);
  assert.equal(hung.termination.confirmed, true, "the child's exit was actually observed");
  assert.ok(hung.elapsedMs < 10000, `probe was killed quickly, took ${hung.elapsedMs}ms`);
  const nonzero = await runBoundedProcess({ exe: process.execPath, args: ["-e", "process.exit(7)"], timeoutMs: 10000 });
  assert.equal(nonzero.timedOut, false);
  assert.equal(nonzero.termination, null, "no termination fact exists without a timeout");
  assert.equal(nonzero.exitCode, 7);
  const missing = await runBoundedProcess({ exe: resolve(tmpdir(), "definitely-absent-core.exe"), args: ["profile", "inspect"], timeoutMs: 10000 });
  assert.equal(missing.exitCode, null);
  assert.match(String(missing.spawnError), /ENOENT/);
});

// ---------- runBoundedProcess termination hard bound (fixture fault injection) ----------

class FakeChildStream extends EventEmitter {
  constructor() {
    super();
    this.destroyCalls = 0;
  }
  destroy() {
    this.destroyCalls += 1;
    this.emit("close");
    return this;
  }
}

class FakeChild extends EventEmitter {
  constructor({ kill = () => true } = {}) {
    super();
    this.pid = 4242;
    this.exitCode = null;
    this.signalCode = null;
    this.killed = false;
    this.stdout = new FakeChildStream();
    this.stderr = new FakeChildStream();
    this.killCalls = [];
    this.unrefCalls = 0;
    this.kill = (signal) => {
      this.killCalls.push(signal);
      return kill(signal);
    };
  }
  unref() {
    this.unrefCalls += 1;
  }
}

test("a kill that throws and never closes settles deterministically at the grace bound, unconfirmed, and detaches only child-owned handles", async () => {
  const child = new FakeChild({ kill: () => { throw new Error("kill refused by fixture"); } });
  const spawnCalls = [];
  const startedAt = Date.now();
  const result = await runBoundedProcess({
    exe: "C:\\definitely\\absent\\core.exe",
    args: ["profile", "inspect"],
    timeoutMs: 40,
    terminationGraceMs: 60,
    spawnImplementation: (exe, args, options) => { spawnCalls.push({ exe, args, options }); return child; }
  });
  assert.deepEqual(spawnCalls, [{ exe: "C:\\definitely\\absent\\core.exe", args: ["profile", "inspect"], options: { stdio: ["ignore", "pipe", "pipe"], windowsHide: true } }]);
  assert.equal(result.timedOut, true);
  assert.equal(result.termination.requested, true);
  assert.equal(result.termination.issued, false);
  assert.match(result.termination.killError, /kill refused by fixture/);
  assert.equal(result.termination.confirmed, false);
  assert.match(result.termination.note, /NOT claimed stopped/);
  assert.equal(result.exitCode, null);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "");
  assert.ok(result.elapsedMs >= 100 && result.elapsedMs < 5000, `settled at the grace wall (${result.elapsedMs}ms), not by a close event`);
  assert.deepEqual(child.killCalls, ["SIGKILL"], "exactly one kill attempt, against the spawned child only — no retries, no PID scans");
  assert.equal(child.stdout.destroyCalls, 1, "the child's own piped stdout is detached so it cannot keep Node alive");
  assert.equal(child.stderr.destroyCalls, 1);
  assert.equal(child.unrefCalls, 1);
  // Listeners stay attached: late events after settling are harmless no-ops.
  child.stdout.emit("data", Buffer.from("late"));
  child.emit("exit", 3, null);
  child.emit("close", 3, null);
  child.emit("error", new Error("late fixture error"));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(result.exitCode, null, "already-settled result is immutable");
});

test("a kill that returns false and never closes also settles unconfirmed within the bound", async () => {
  const child = new FakeChild({ kill: () => false });
  const result = await runBoundedProcess({ exe: "fixture.exe", args: [], timeoutMs: 30, terminationGraceMs: 50, spawnImplementation: () => child });
  assert.equal(result.timedOut, true);
  assert.equal(result.termination.requested, true);
  assert.equal(result.termination.issued, false);
  assert.equal(result.termination.killError, null);
  assert.equal(result.termination.confirmed, false);
  assert.ok(result.elapsedMs < 5000);
  assert.deepEqual(child.killCalls, ["SIGKILL"]);
  assert.equal(child.stdout.destroyCalls, 1);
  assert.equal(child.unrefCalls, 1);
});

test("synchronous close during a kill attempt leaves no termination-grace timer", async () => {
  const timersBefore = process.getActiveResourcesInfo().filter((kind) => kind === "Timeout").length;
  const child = new FakeChild();
  child.kill = (signal) => {
    child.killCalls.push(signal);
    child.emit("exit", null, signal);
    child.emit("close", null, signal);
    return true;
  };
  const result = await runBoundedProcess({ exe: "fixture.exe", args: [], timeoutMs: 10, terminationGraceMs: 2000, spawnImplementation: () => child });
  assert.equal(result.timedOut, true);
  assert.equal(result.termination.confirmed, true);
  assert.deepEqual(child.killCalls, ["SIGKILL"]);
  assert.ok(process.getActiveResourcesInfo().filter((kind) => kind === "Timeout").length <= timersBefore, "settled timeout must not create a new live grace timer");
});

test("a close observed inside the termination grace settles with the real exit and confirmed termination, no detach", async () => {
  const child = new FakeChild();
  child.kill = (signal) => {
    child.killCalls.push(signal);
    setTimeout(() => { child.exitCode = null; child.signalCode = signal; child.emit("exit", null, signal); }, 5);
    setTimeout(() => child.emit("close", null, signal), 15);
    return true;
  };
  const result = await runBoundedProcess({ exe: "fixture.exe", args: [], timeoutMs: 30, terminationGraceMs: 2000, spawnImplementation: () => child });
  assert.equal(result.timedOut, true);
  assert.equal(result.termination.issued, true);
  assert.equal(result.termination.killError, null);
  assert.equal(result.termination.confirmed, true);
  assert.equal(result.exitCode, null);
  assert.equal(result.signal, "SIGKILL");
  assert.deepEqual(child.killCalls, ["SIGKILL"]);
  assert.equal(child.stdout.destroyCalls, 0, "the child verifiably ended: its own handles are left alone");
  assert.equal(child.unrefCalls, 0);
});

test("an error event after the timeout settles with spawnError and unconfirmed termination, then detaches", async () => {
  const child = new FakeChild();
  child.kill = (signal) => {
    child.killCalls.push(signal);
    setTimeout(() => child.emit("error", Object.assign(new Error("EPERM killing fixture child"), { code: "EPERM" })), 5);
    return false;
  };
  const result = await runBoundedProcess({ exe: "fixture.exe", args: [], timeoutMs: 30, terminationGraceMs: 2000, spawnImplementation: () => child });
  assert.equal(result.timedOut, true);
  assert.match(String(result.spawnError), /EPERM killing fixture child/);
  assert.equal(result.termination.issued, false);
  assert.equal(result.termination.confirmed, false);
  assert.match(result.termination.note, /NOT claimed stopped/);
  assert.equal(child.stdout.destroyCalls, 1);
  assert.equal(child.unrefCalls, 1);
});

test("an observed exit whose close never arrives (pipe held open) settles at the grace wall, confirmed, with the observed exit code", async () => {
  const child = new FakeChild();
  child.kill = (signal) => {
    child.killCalls.push(signal);
    setTimeout(() => { child.exitCode = 1; child.signalCode = null; child.emit("exit", 1, null); }, 5); // close deliberately never fires
    return true;
  };
  const result = await runBoundedProcess({ exe: "fixture.exe", args: [], timeoutMs: 30, terminationGraceMs: 60, spawnImplementation: () => child });
  assert.equal(result.timedOut, true);
  assert.equal(result.termination.confirmed, true, "the process exit itself was observed");
  assert.equal(result.exitCode, 1);
  assert.ok(result.elapsedMs < 5000);
  assert.equal(child.stdout.destroyCalls, 1, "close never arrived, so the pipes are still detached");
  assert.equal(child.unrefCalls, 1);
});

test("output budgets cap real UTF-8 bytes, not JS characters, and never split a multi-byte character", async () => {
  const child = new FakeChild();
  setTimeout(() => {
    child.stdout.emit("data", Buffer.from("中".repeat(2000))); // 6000 bytes in ONE chunk > 1000-byte budget
    child.stdout.emit("data", Buffer.from("中".repeat(2000))); // past the budget: dropped
    child.stderr.emit("data", Buffer.from("e".repeat(5000)));
    child.exitCode = 0;
    child.signalCode = null;
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
  }, 5);
  const result = await runBoundedProcess({ exe: "fixture.exe", args: [], timeoutMs: 2000, maxStdoutBytes: 1000, maxStderrBytes: 300, spawnImplementation: () => child });
  assert.equal(result.exitCode, 0);
  assert.ok(Buffer.byteLength(result.stdout) <= 1000, `stdout is byte-capped, got ${Buffer.byteLength(result.stdout)} bytes`);
  assert.ok(result.stdout.length >= 300 && result.stdout.length <= 334, `kept whole characters (${result.stdout.length}), not an overshot chunk`);
  assert.ok(!result.stdout.includes("\uFFFD"), "a byte cut never fabricates replacement characters");
  assert.ok(Buffer.byteLength(result.stderr) <= 300);
});

test("a real probe writing far past its byte budgets is cut under budget without corrupting output", async () => {
  const result = await runBoundedProcess({
    exe: process.execPath,
    args: ["-e", "process.stdout.write('中'.repeat(20000)); process.stderr.write('e'.repeat(8000)); process.exit(0)"],
    timeoutMs: 20000,
    maxStdoutBytes: 4096,
    maxStderrBytes: 2048
  });
  assert.equal(result.timedOut, false);
  assert.equal(result.exitCode, 0);
  assert.equal(result.termination, null);
  assert.ok(Buffer.byteLength(result.stdout) <= 4096, `real stdout is byte-capped, got ${Buffer.byteLength(result.stdout)} bytes`);
  assert.ok(result.stdout.length > 1000);
  assert.ok(!result.stdout.includes("\uFFFD"));
  assert.ok(Buffer.byteLength(result.stderr) <= 2048);
});

test("collectStartupDiagnostics surfaces redacted termination facts for a timed-out re-probe and stays honest without them", async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), "goalport-diagnostic-termination-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(resolve(root, "core.exe"), "MZ");
  const common = { profileDirectory: root, packageRoot: root, coreExecutable: resolve(root, "core.exe"), privatePaths: [root] };
  const record = await collectStartupDiagnostics({
    ...common,
    runProcess: async () => ({
      elapsedMs: 65000, timedOut: true, exitCode: null, signal: null, stdout: "", stderr: "",
      termination: { requested: true, issued: false, killError: `kill EPERM for ${resolve(root, "core.exe")}`, confirmed: false, note: "termination unconfirmed: NOT claimed stopped" }
    })
  });
  const termination = record.coreInspectReProbe.termination;
  assert.equal(termination.requested, true);
  assert.equal(termination.issued, false);
  assert.match(termination.killError, /<private-path>/);
  assert.ok(!termination.killError.includes(root), "killError is redacted");
  assert.equal(termination.confirmed, false);
  assert.match(termination.note, /NOT claimed stopped/);
  const legacy = await collectStartupDiagnostics({
    ...common,
    runProcess: async () => ({ elapsedMs: 5, timedOut: true, exitCode: null, signal: null, stdout: "", stderr: "" })
  });
  assert.equal(legacy.coreInspectReProbe.termination.confirmed, null, "a probe result without termination facts never implies a stop");
  assert.match(legacy.coreInspectReProbe.termination.note, /NOT claimed stopped/);
});

test("malformed or refusing inspect output is recorded as a parse fact, not invented", async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), "goalport-diagnostic-malformed-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const common = { profileDirectory: root, coreExecutable: resolve(root, "core.exe"), privatePaths: [root], packageRoot: root };
  writeFileSync(resolve(root, "core.exe"), "MZ");
  const malformed = await collectStartupDiagnostics({ ...common, runProcess: async () => ({ elapsedMs: 3, timedOut: false, exitCode: 0, stdout: "this is not json at all\n", stderr: "" }) });
  assert.equal(malformed.coreInspectReProbe.parsed, null);
  assert.match(malformed.coreInspectReProbe.parseError, /JSON/);
  const refusing = await collectStartupDiagnostics({ ...common, runProcess: async () => ({ elapsedMs: 4, timedOut: false, exitCode: 3, stdout: `${JSON.stringify({ schema: "goalport.profile-ops.v1", ok: false, error: `locked: ${resolve(root, "goalport.sqlite")}` })}\n`, stderr: "detail\n" }) });
  assert.equal(refusing.coreInspectReProbe.exitCode, 3);
  assert.equal(refusing.coreInspectReProbe.parsed.ok, false);
  assert.ok(!JSON.stringify(refusing.coreInspectReProbe.parsed).includes(root), "refusal detail redacted");
  const timedOut = await collectStartupDiagnostics({ ...common, inspectTimeoutMs: 5, runProcess: async () => ({ elapsedMs: 5, timedOut: true, exitCode: null, signal: null, stdout: "", stderr: "" }) });
  assert.equal(timedOut.coreInspectReProbe.timedOut, true);
  assert.equal(timedOut.coreInspectReProbe.parsed, null);
  assert.match(timedOut.coreInspectReProbe.parseError, /no parsable output/);
});

test("startup diagnostics stay redacted and bounded inside failure summaries", async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), "goalport-diagnostic-summary-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(resolve(root, "Cache"));
  writeFileSync(resolve(root, "core.exe"), "MZ");
  for (let index = 0; index < PROFILE_ROOT_MAX_ENTRIES + 80; index += 1) writeFileSync(resolve(root, `unlisted-artifact-${index}`), "x");
  const record = await collectStartupDiagnostics({
    profileDirectory: root,
    packageRoot: root,
    coreExecutable: resolve(root, "core.exe"),
    privatePaths: [root],
    queryBootstrap: async () => ({ phase: "error", kind: "not-a-profile", message: `dir ${resolve(root, "goalport.sqlite")} rejected` }),
    runProcess: async () => ({ elapsedMs: 9, timedOut: false, exitCode: 0, stdout: `${JSON.stringify({ schema: "goalport.profile-ops.v1", ok: true, exists: false })}\n`, stderr: "" })
  });
  assert.equal(record.profileRoot.entryCount, PROFILE_ROOT_MAX_ENTRIES + 82); // Cache + core.exe + 592 artifacts
  assert.equal(record.profileRoot.truncated, true);
  assert.equal(record.profileRoot.entries.length, PROFILE_ROOT_MAX_ENTRIES);
  const rendered = boundedFailureSummary({
    schemaVersion: 1, status: "FAIL", mode: "normal", stage: "connected packaged UI", error: "Timed out: connected packaged UI",
    diagnostics: { stage: "connected packaged UI" }, startup: record, cleanup: [], steps: []
  }, [root, tmpdir()]);
  const summary = JSON.parse(rendered);
  assert.ok(Buffer.byteLength(rendered) <= SUMMARY_MAX_BYTES);
  assert.equal(summary.startup.bootstrap.state.kind, "not-a-profile");
  assert.equal(summary.startup.profileRoot.truncated, true);
  assert.ok(!rendered.includes(root.replaceAll("\\", "\\\\")) && !rendered.includes(root), "no private path survives");
  assert.ok(!summary.startup.frozenChromiumAllowlist.unmatchedNames.includes("Cache"), "frozen-listed entry is not reported unmatched");
  assert.ok(summary.startup.frozenChromiumAllowlist.unmatchedNames.includes("core.exe"), "unlisted entry is reported unmatched");
  assert.ok(summary.startup.frozenChromiumAllowlist.unmatchedNames.length > 0 && summary.startup.frozenChromiumAllowlist.unmatchedNames.length <= PROFILE_ROOT_MAX_ENTRIES);
});

// ---------- Original startup inspection trace extraction ----------

test("collector extracts the selected original inspect trace a newer build supplies, capped and redacted", async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), "goalport-diagnostic-original-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(resolve(root, "core.exe"), "MZ");
  const secret = "TRACE-STDOUT-SECRET-marker";
  const profileDb = resolve(root, "profile", "goalport.sqlite");
  const records = [
    {
      target: "own-database", status: "completed", startedAt: "2026-09-21T22:00:00.000Z", endedAt: "2026-09-21T22:00:09.500Z",
      elapsedMs: 9500, exitCode: 3, execError: `Command failed: ${resolve(root, "core.exe")} ENOENT`, malformed: false, parseNote: null,
      facts: {
        ok: false, exists: true, openable: true, needsRecovery: false, empty: null, schemaVersion: 9, currentSchemaVersion: 9,
        quickCheck: "ok", errorReason: `locked: ${profileDb} ${"x".repeat(5000)}`
      }
    },
    { target: "own-database", status: "pending", startedAt: "2026-09-21T22:00:00.000Z", endedAt: null, elapsedMs: null, exitCode: null, execError: null, malformed: null, parseNote: null, facts: null },
    { junk: true, stdout: `{"secret":"${secret}","ok":true}`, facts: { ok: true, exists: false, unexpected: secret } },
    ...Array.from({ length: 7 }, (_, index) => ({
      target: "other-database", status: "completed", startedAt: `2026-09-21T22:0${index}:00.000Z`, endedAt: `2026-09-21T22:0${index}:01.000Z`,
      elapsedMs: 1000 + index, exitCode: 0, execError: null, malformed: false, parseNote: null,
      facts: { ok: true, exists: false, openable: false, needsRecovery: false, empty: null, schemaVersion: null, currentSchemaVersion: 9, quickCheck: null, errorReason: null }
    }))
  ];
  const record = await collectStartupDiagnostics({
    profileDirectory: root,
    packageRoot: root,
    coreExecutable: resolve(root, "core.exe"),
    privatePaths: [root],
    queryBootstrap: async () => ({
      phase: "error", kind: "not-a-profile",
      diagnostics: { originalProfileInspect: { kind: "original-startup-inspect-trace", totalInspections: 11, droppedRecords: 1, records } }
    }),
    runProcess: async () => ({ elapsedMs: 1, timedOut: false, exitCode: 0, signal: null, stdout: `${JSON.stringify({ schema: "goalport.profile-ops.v1", ok: true, exists: false })}\n`, stderr: "" })
  });
  const original = record.originalStartupInspection;
  assert.equal(original.available, true);
  assert.equal(original.kind, "original-startup-inspect-trace");
  assert.equal(original.totalInspections, 11);
  assert.equal(original.droppedRecords, 1);
  assert.equal(original.truncated, true, "10 supplied records are capped to the extraction bound");
  assert.equal(original.records.length, ORIGINAL_TRACE_MAX_RECORDS);
  const completed = original.records[0];
  assert.equal(completed.status, "completed");
  assert.equal(completed.target, "own-database");
  assert.equal(completed.exitCode, 3);
  assert.equal(completed.malformed, false);
  assert.match(completed.execError, /<private-path>/);
  assert.ok(!completed.execError.includes(root), "execError is redacted");
  assert.equal(completed.facts.ok, false);
  assert.match(completed.facts.errorReason, /<private-path>/);
  assert.ok(!completed.facts.errorReason.includes(root), "refusal reason is redacted");
  assert.ok(Buffer.byteLength(completed.facts.errorReason) <= ORIGINAL_TRACE_STRING_CAP + 64, "reason stays capped");
  const pending = original.records[1];
  assert.equal(pending.status, "pending");
  assert.equal(pending.facts, null);
  assert.equal(pending.endedAt, null);
  const junk = original.records[2];
  assert.equal(junk.status, "unknown");
  assert.equal(junk.target, "unknown");
  assert.equal(junk.facts.ok, true);
  assert.equal("unexpected" in junk.facts, false, "non-selected fact fields are dropped");
  const serialized = JSON.stringify(original);
  assert.ok(!serialized.includes(secret), "stdout content never rides along");
  assert.ok(!serialized.includes(root.replaceAll("\\", "\\\\")) && !serialized.includes(root), "no private path survives extraction");
  // The separate post-failure re-probe stays present and independently labelled.
  assert.equal(record.coreInspectReProbe.attempted, true);
  assert.equal(record.coreInspectReProbe.kind, "diagnostic-re-probe");
  assert.match(record.coreInspectReProbe.note, /NOT the original startup inspection/);
  // The extracted trace stays bounded inside a rendered failure summary.
  const rendered = boundedFailureSummary({ schemaVersion: 1, status: "FAIL", mode: "normal", stage: "s", error: "e", startup: record, cleanup: [], steps: [] }, [root, tmpdir()]);
  assert.ok(Buffer.byteLength(rendered) <= SUMMARY_MAX_BYTES);
  assert.ok(!rendered.includes(root), "summary keeps the trace redacted");
  assert.equal(JSON.parse(rendered).startup.originalStartupInspection.available, true);
});

test("a missing, empty or malformed diagnostics child degrades to honest unavailable/empty facts, never a throw", async () => {
  const unavailable = extractOriginalInspectTrace({ phase: "checking" });
  assert.equal(unavailable.available, false);
  assert.match(unavailable.reason, /unavailable/);
  assert.equal(extractOriginalInspectTrace(undefined).available, false);
  assert.equal(extractOriginalInspectTrace({ phase: "done", diagnostics: {} }).available, false);
  const empty = extractOriginalInspectTrace({ phase: "done", diagnostics: { originalProfileInspect: { records: [] } } });
  assert.equal(empty.available, true);
  assert.deepEqual(empty.records, []);
  const malformed = extractOriginalInspectTrace({ phase: "done", diagnostics: { originalProfileInspect: { records: "not-an-array", totalInspections: "many" } } });
  assert.equal(malformed.available, true);
  assert.deepEqual(malformed.records, []);
  assert.equal(malformed.totalInspections, null);
  const overshoot = extractOriginalInspectTrace({ phase: "error", diagnostics: { originalProfileInspect: { records: [{ status: "completed", elapsedMs: Number.MAX_SAFE_INTEGER + 5, exitCode: 2.5, malformed: "yes" }] } } });
  assert.deepEqual(overshoot.records, [{
    target: "unknown", status: "completed", startedAt: null, endedAt: null, elapsedMs: null, exitCode: null,
    execError: null, malformed: null, parseNote: null, facts: null
  }]);
});
