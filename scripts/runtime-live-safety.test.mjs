import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(path.join(root, "scripts", "verify.mjs"), "utf8");

test("Codex live probe permits a synthetic non-Git root but remains read-only and ephemeral", () => {
  assert.match(
    source,
    /args:\s*\["exec",\s*"--json",\s*"--skip-git-repo-check",\s*"--ephemeral",\s*"--sandbox",\s*"read-only"/
  );
});

test("Grok live probe uses bounded headless structured output instead of unopened ACP stdio", () => {
  assert.match(source, /args:\s*\["-p",\s*"GOALPORT_SYNTHETIC_TASK",\s*"--output-format",\s*"streaming-json"/);
  assert.doesNotMatch(source, /args:\s*\["agent",\s*"stdio",\s*"--cwd",\s*"<synthetic-root>"\]/);
});

test("Claude live probe relies on process cwd and caps the turn without API fallback", () => {
  assert.match(source, /args:\s*\["-p",\s*"GOALPORT_SYNTHETIC_TASK",\s*"--output-format",\s*"stream-json",\s*"--max-turns",\s*"1"/);
  assert.doesNotMatch(source, /"--cwd",\s*"<synthetic-root>"/);
});

test("all live probes replace the placeholder with a text-only bounded task", () => {
  assert.match(source, /const SYNTHETIC_TASK = "Reply exactly GOALPORT_RUNTIME_OK\. Do not use tools/);
  assert.match(source, /value === "GOALPORT_SYNTHETIC_TASK" \? SYNTHETIC_TASK/);
});
