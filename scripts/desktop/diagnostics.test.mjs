import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { boundedFailureSummary, collectFailureDiagnostics, sanitizeDiagnostic, SUMMARY_FIELD_BYTES, SUMMARY_MAX_BYTES, TAIL_BYTES, TAIL_LINES, truncateUtf8 } from "./diagnostics.mjs";

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
