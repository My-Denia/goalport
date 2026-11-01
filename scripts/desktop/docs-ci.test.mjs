import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { brokenLinks, markdownFiles, markdownLinks } from "./doc-links.mjs";
import { ROOT } from "./package.mjs";

const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
const readme = readFileSync(resolve(ROOT, "README.md"), "utf8");
test("README current entry points resolve and RC versions agree", () => {
  assert.match(readme, new RegExp(pkg.version.replaceAll(".", "\\.")));
  assert.match(readme, /release candidate/i);
  assert.match(readme, /%APPDATA%\\GoalPort\\rc/);
  assert.doesNotMatch(readme, /goal-runs\//);
  // Screenshots come from the synthetic Scenario runtime and must say so.
  assert.match(readme, /synthetic Scenario/);
  const screenshots = markdownLinks(readme).filter((link) => /^docs\/assets\/screenshots\/[\w-]+\.png$/.test(link));
  assert.ok(screenshots.length > 0, "README shows at least one product screenshot");
  // Current guides only; reference and history records keep their original commands.
  const current = markdownFiles(ROOT, "docs").filter((file) => !/^docs\/(reference|history|adr)\//.test(file));
  for (const docs of ["README.md", "CONTRIBUTING.md", ...current]) {
    for (const [, script] of readFileSync(resolve(ROOT, docs), "utf8").matchAll(/^pnpm ([\w:-]+)/gm)) {
      if (script !== "install") assert.equal(typeof pkg.scripts[script], "string", `${docs}: documented script ${script} must exist`);
    }
  }
  const electron = JSON.parse(readFileSync(resolve(ROOT, "electron/package.json"), "utf8"));
  assert.equal(electron.version, pkg.version);
  assert.match(readFileSync(resolve(ROOT, "Cargo.toml"), "utf8"), new RegExp(`version = "${pkg.version.replaceAll(".", "\\.")}"`));
  for (const script of ["scripts/connected/package-electron.mjs", "scripts/desktop/start.mjs", "scripts/desktop/verify-package.mjs", "scripts/desktop/smoke.mjs"]) {
    assert.ok(existsSync(resolve(ROOT, script)), `${script} exists`);
    const result = spawnSync(process.execPath, [resolve(ROOT, script), "--help"], { cwd: ROOT, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, `${script}: ${result.stderr}`);
    assert.match(result.stdout, /Usage:|pnpm electron:package/);
  }
});

// Historical records are kept unchanged; their one dangling target predates the move.
const HISTORICAL_BROKEN = { "docs/history/v1-design/2026-08-31-goalport-v1-r2-changes.md": ["2026-08-31-goalport-v1-r2-validation.json"] };

test("Apache-2.0 LICENSE and package metadata stay consistent", () => {
  assert.ok(existsSync(resolve(ROOT, "LICENSE")), "LICENSE file exists");
  assert.match(readFileSync(resolve(ROOT, "Cargo.toml"), "utf8"), /^license = "Apache-2.0"$/m);
  assert.equal(pkg.license, "Apache-2.0");
  const electron = JSON.parse(readFileSync(resolve(ROOT, "electron/package.json"), "utf8"));
  assert.equal(electron.license, "Apache-2.0");
  assert.match(readme, /\[[^\]]*Apache License 2\.0[^\]]*\]\(LICENSE\)|\[[^\]]*LICENSE[^\]]*\]\(LICENSE\)/);
  assert.doesNotMatch(readme, /No license has been chosen yet|UNLICENSED/);
});

test("SECURITY.md does not present private vulnerability reporting as available on a private repository", () => {
  const security = readFileSync(resolve(ROOT, "SECURITY.md"), "utf8");
  assert.match(security, /do not open a public issue/i);
  assert.match(security, /repository is private/i);
  assert.match(security, /public repositories/i);
  assert.doesNotMatch(security, /Use GitHub private vulnerability reporting for this repository/);
});

test("public documentation links and images resolve with exact case", () => {
  const files = ["README.md", "CONTRIBUTING.md", "SECURITY.md", ...markdownFiles(ROOT, "docs")];
  assert.deepEqual(brokenLinks(ROOT, files, { allow: HISTORICAL_BROKEN }), []);
});

test("documentation link check reports missing and wrong-case targets but ignores code", () => {
  const parent = mkdtempSync(resolve(tmpdir(), "goalport-doc-links-"));
  const root = resolve(parent, "repo");
  try {
    // The outside target exists, so only the repository boundary can reject it.
    writeFileSync(resolve(parent, "outside.md"), "# Outside\n");
    mkdirSync(resolve(root, "docs"), { recursive: true });
    writeFileSync(resolve(root, "docs", "Guide.md"), "# Guide\n");
    writeFileSync(resolve(root, "README.md"), [
      "[ok](docs/Guide.md#top) [web](https://example.com) [anchor](#here)",
      "[missing](docs/missing.md)",
      "![case](docs/guide.md)",
      "[outside](../outside.md)",
      "`[inline](docs/inline-code.md)`",
      "```text",
      "[fenced](docs/fenced.md)",
      "```"
    ].join("\n"));
    assert.deepEqual(brokenLinks(root, ["README.md"]), [
      { file: "README.md", link: "docs/missing.md" },
      { file: "README.md", link: "docs/guide.md" },
      { file: "README.md", link: "../outside.md" }
    ]);
    assert.deepEqual(brokenLinks(root, ["README.md"], { allow: { "README.md": ["docs/missing.md", "docs/guide.md", "../outside.md"] } }), []);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
