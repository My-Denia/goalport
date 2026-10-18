import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { classifyChange, docsOnlyRaw } from "./change-impact.mjs";

const SCRIPT = fileURLToPath(new URL("./change-impact.mjs", import.meta.url));

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), "goalport-ci-impact-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  git(cwd, "init", "-q", "-b", "main");
  git(cwd, "config", "user.name", "CI Test");
  git(cwd, "config", "user.email", "ci@example.invalid");
  for (const name of ["README.md", "AGENTS.md", "CONTRIBUTING.md", "SECURITY.md"]) {
    writeFileSync(join(cwd, name), `# ${name}\n`);
  }
  mkdirSync(join(cwd, "docs"));
  writeFileSync(join(cwd, "docs", "guide.md"), "# Guide\n");
  writeFileSync(join(cwd, "app.js"), "export const value = 1;\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "base");
  return { cwd, base: git(cwd, "rev-parse", "HEAD") };
}

function commit(cwd, mutate) {
  const afterAdd = mutate(cwd);
  git(cwd, "add", "-A");
  if (typeof afterAdd === "function") afterAdd(cwd);
  git(cwd, "commit", "-qm", "change");
  return git(cwd, "rev-parse", "HEAD");
}

function pushResult(cwd, base, head = git(cwd, "rev-parse", "HEAD")) {
  return classifyChange({ cwd, eventName: "push", event: { before: base, after: head }, githubSha: head });
}

function prResult(cwd, base, head, merge) {
  return classifyChange({
    cwd,
    eventName: "pull_request",
    event: { pull_request: { base: { sha: base }, head: { sha: head } } },
    githubSha: merge,
  });
}

test("only content edits to the four existing ordinary root docs are light", (t) => {
  const { cwd, base } = fixture(t);
  const head = commit(cwd, () => {
    for (const name of ["README.md", "AGENTS.md", "CONTRIBUTING.md", "SECURITY.md"]) {
      writeFileSync(join(cwd, name), `# Updated ${name}\n`);
    }
  });
  assert.equal(pushResult(cwd, base, head).full, false);
});

test("PR light result binds both event parents and the actual merge tree", (t) => {
  const { cwd, base } = fixture(t);
  git(cwd, "checkout", "-qb", "docs-update");
  const head = commit(cwd, () => writeFileSync(join(cwd, "README.md"), "# Updated\n"));
  git(cwd, "checkout", "-q", "main");
  git(cwd, "merge", "--no-ff", "-qm", "merge docs", "docs-update");
  const merge = git(cwd, "rev-parse", "HEAD");
  assert.equal(prResult(cwd, base, head, merge).full, false);
  assert.equal(prResult(cwd, head, base, merge).full, true);
  assert.throws(() => prResult(cwd, base, head, base), /GITHUB_SHA/);
});

test("nested docs, code, additions, deletions, modes and renames all require full", (t) => {
  const changes = [
    (cwd) => writeFileSync(join(cwd, "docs", "guide.md"), "# Changed\n"),
    (cwd) => writeFileSync(join(cwd, "app.js"), "export const value = 2;\n"),
    (cwd) => writeFileSync(join(cwd, "NEW.md"), "# New\n"),
    (cwd) => rmSync(join(cwd, "README.md")),
    () => (cwd) => git(cwd, "update-index", "--chmod=+x", "README.md"),
    (cwd) => git(cwd, "mv", "README.md", "RENAMED.md"),
    (cwd) => git(cwd, "mv", "app.js", "app.md"),
    (cwd) => git(cwd, "mv", "docs/guide.md", "docs/guide.js"),
    (cwd) => {
      writeFileSync(join(cwd, "README.md"), "# Changed\n");
      writeFileSync(join(cwd, "app.js"), "export const value = 2;\n");
    },
  ];
  for (const change of changes) {
    const { cwd, base } = fixture(t);
    const head = commit(cwd, change);
    assert.equal(pushResult(cwd, base, head).full, true);
  }
});

test("empty, unknown and unavailable differences require full", (t) => {
  const { cwd, base } = fixture(t);
  assert.equal(pushResult(cwd, base, base).full, true);
  assert.equal(pushResult(cwd, "0".repeat(40), base).full, true);
  assert.equal(pushResult(cwd, "f".repeat(40), base).full, true);
  assert.equal(classifyChange({ cwd, eventName: "push", event: { before: base, after: base }, githubSha: undefined }).full, true);
  assert.equal(classifyChange({ cwd, eventName: "workflow_dispatch", event: {}, githubSha: base }).full, true);
  assert.throws(() => classifyChange({ cwd, eventName: "push", event: { before: base, after: "f".repeat(40) }, githubSha: base }), /push event/);
});

test("unrelated push history cannot qualify for light even with a docs-only tree diff", (t) => {
  const { cwd, base } = fixture(t);
  git(cwd, "checkout", "-q", "--orphan", "unrelated");
  const head = commit(cwd, () => writeFileSync(join(cwd, "README.md"), "# Updated\n"));
  const raw = spawnSync("git", ["diff", "--raw", "-z", "--no-renames", base, head, "--"], { cwd });
  assert.equal(raw.status, 0);
  assert.equal(docsOnlyRaw(raw.stdout), true, "the unrelated trees differ only in a root doc");
  assert.equal(pushResult(cwd, base, head).full, true);
});

test("raw parser refuses incomplete or malformed Git output", () => {
  assert.equal(docsOnlyRaw(Buffer.alloc(0)), false);
  assert.equal(docsOnlyRaw(Buffer.from(":100644 100644 a b M\0README.md")), false);
  assert.equal(docsOnlyRaw(Buffer.from(":100644 100644 a b M\0README.md\0")), true);
  assert.equal(docsOnlyRaw(Buffer.from(":100644 100644 a b M\0README.md\0:100644 100644 a b M\0docs/guide.md\0")), false);
  assert.equal(docsOnlyRaw(Buffer.from(":100644 100755 a b M\0README.md\0")), false);
});

test("CLI writes an exact Boolean output, and a detector error writes none", (t) => {
  const { cwd, base } = fixture(t);
  const head = commit(cwd, () => writeFileSync(join(cwd, "README.md"), "# Updated\n"));
  const eventPath = join(cwd, "event.json");
  const outputPath = join(cwd, "output.txt");
  writeFileSync(eventPath, JSON.stringify({ before: base, after: head }));
  writeFileSync(outputPath, "");
  const env = {
    ...process.env,
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_EVENT_NAME: "push",
    GITHUB_SHA: head,
    GITHUB_OUTPUT: outputPath,
  };
  const success = spawnSync(process.execPath, [SCRIPT], { cwd, env, encoding: "utf8" });
  assert.equal(success.status, 0, success.stderr);
  assert.equal(readFileSync(outputPath, "utf8"), "full=false\n");
  writeFileSync(outputPath, "");
  const failure = spawnSync(process.execPath, [SCRIPT], { cwd, env: { ...env, GITHUB_SHA: base }, encoding: "utf8" });
  assert.notEqual(failure.status, 0);
  assert.equal(readFileSync(outputPath, "utf8"), "");
});
