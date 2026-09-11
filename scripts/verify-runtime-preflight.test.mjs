import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Windows Runtime preflight starts the installed native entrypoints without a shell", () => {
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, "scripts", "verify.mjs"),
      "runtime",
      "--provider",
      "codex,grok,claude",
      "--timeout",
      "30"
    ],
    {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      timeout: 120_000
    }
  );

  assert.equal(
    result.status,
    0,
    `preflight failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );
  const finalLine = result.stdout.trim().split(/\r?\n/).at(-1);
  assert.equal(JSON.parse(finalLine).status, "PASS");
});

test("Runtime reports redact UUIDs and nonessential account fields", () => {
  const relativeReport = path.join(
    "goal-runs",
    "goalport-v1",
    "evidence",
    `runtime-redaction-test-${process.pid}.json`
  );
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, "scripts", "verify.mjs"),
      "runtime",
      "--provider",
      "claude",
      "--timeout",
      "30",
      "--report",
      relativeReport
    ],
    { cwd: root, encoding: "utf8", windowsHide: true, timeout: 120_000 }
  );
  assert.equal(result.status, 0, result.stderr);
  const report = readFileSync(path.join(root, relativeReport), "utf8");
  assert.doesNotMatch(
    report,
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i
  );
  assert.doesNotMatch(report, /"subscriptionType"\s*:\s*"(?!<redacted>)/i);
});
