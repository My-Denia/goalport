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
const workflow = readFileSync(resolve(ROOT, ".github/workflows/ci.yml"), "utf8");

// Read the flat step entries of our desktop job. Reject block/flow command
// shapes rather than silently claiming to validate YAML syntax we do not parse.
function desktopJob(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line === "  desktop:");
  assert.ok(start >= 0, "desktop job is required");
  const following = lines.slice(start + 1);
  const end = following.findIndex((line) => /^  \S+:/.test(line));
  const body = (end < 0 ? following : following.slice(0, end));
  const commands = body.flatMap((line) => {
    const match = line.match(/^\s+(?:- )?run: (.+)$/);
    if (!match) return [];
    assert.ok(!/^[>|{]/.test(match[1]), "desktop CI command format needs an updated contract parser");
    return [match[1]];
  });
  return { body: body.join("\n"), commands };
}

test("README current entry points resolve and RC versions agree", () => {
  assert.match(readme, new RegExp(pkg.version.replaceAll(".", "\\.")));
  assert.match(readme, /Stable V1 RC/);
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

test("Windows Desktop CI builds locked source and runs normal plus synthetic package smoke", () => {
  const { body, commands } = desktopJob(workflow);
  assert.match(body, /runs-on: windows-latest/);
  assert.match(body, /node-version: 22\.19\.0/);
  assert.match(body, /version: 11\.22\.0/);
  assert.match(body, /dtolnay\/rust-toolchain@[0-9a-f]{40} # master[^\n]*\r?\n\s+with:\r?\n\s+toolchain: 1\.96\.1/);
  assert.equal(pkg.packageManager, "pnpm@11.22.0");
  assert.match(readFileSync(resolve(ROOT, "rust-toolchain.toml"), "utf8"), /channel = "1\.96\.1"/);
  const install = commands.indexOf("pnpm install --frozen-lockfile");
  const build = commands.findIndex((command) => command.startsWith("pnpm electron:package --out "));
  const verify = commands.findIndex((command) => command.startsWith("pnpm electron:verify --package "));
  const smoke = commands.filter((command) => command.startsWith("node scripts/desktop/smoke.mjs --package "));
  assert.ok(install >= 0 && build > install && verify > build);
  assert.ok(commands.includes("pnpm test:desktop"));
  assert.equal(smoke.length, 2);
  assert.equal(smoke.filter((command) => command.includes(" --normal ")).length, 1);
  assert.ok(commands.includes("pnpm test:release"));
  for (const command of commands) {
    if (command === "pnpm test:release") continue;
    assert.doesNotMatch(command, /verify:runtime|--live|goal-runs\/|\b(?:push|publish|release|deploy)\b/);
  }
  assert.ok(commands.includes("node scripts/desktop/verify-early-cleanup.mjs --package artifacts/electron-rc/ci/GoalPort-win32-x64 --out artifacts/electron-rc/ci-early-cleanup"));
});

test("Desktop CI retains only redacted failure summaries and never tolerates a failed step", () => {
  const { body } = desktopJob(workflow);
  assert.doesNotMatch(body, /continue-on-error/);
  const steps = body.split(/\r?\n(?=      - )/);
  const last = steps.at(-1);
  assert.match(last, /^\s+- name: .+\r?\n\s+if: failure\(\)\r?\n\s+uses: actions\/upload-artifact@[0-9a-f]{40} # v4\.\d+\.\d+\r?\n/);
  assert.match(last, /\n\s+retention-days: 7\s*$/);
  assert.match(last, /\n\s+if-no-files-found: ignore\r?\n/);
  const paths = [...last.matchAll(/^ {12}(\S+)\s*$/gm)].map((match) => match[1]);
  assert.deepEqual(paths, ["normal-smoke", "synthetic-smoke", "early-cleanup"].map((name) => `artifacts/electron-rc/ci-${name}/failure-summary.json`));
  assert.equal(steps.filter((step) => /upload-artifact/.test(step)).length, 1);
});
