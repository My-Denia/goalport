import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { collectFailureDiagnostics, sanitizeDiagnostic, TAIL_BYTES, TAIL_LINES } from "./diagnostics.mjs";

test("JSON-escaped private paths in component diagnostics are redacted", () => {
  const root = resolve(tmpdir(), "goalport-diagnostic-owned-profile");
  const text = JSON.stringify({ path: root, error: `Cannot open ${root}` });
  const sanitized = sanitizeDiagnostic(text, [root]);
  assert.ok(!sanitized.includes(JSON.stringify(root).slice(1, -1)));
  assert.match(sanitized, /<private-path>/);
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
