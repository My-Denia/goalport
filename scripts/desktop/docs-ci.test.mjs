import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
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
  const current = readme.split("[Historical Desktop admission notes]")[0];
  assert.match(current, new RegExp(pkg.version.replaceAll(".", "\\.")));
  assert.match(current, /Stable V1 RC/);
  assert.match(current, /%APPDATA%\\GoalPort\\rc/);
  assert.doesNotMatch(current, /goal-runs\//);
  for (const [, script] of current.matchAll(/^pnpm ([\w:-]+)/gm)) {
    if (script !== "install") assert.equal(typeof pkg.scripts[script], "string", `documented script ${script} must exist`);
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

test("Windows Desktop CI builds locked source and runs normal plus synthetic package smoke", () => {
  const { body, commands } = desktopJob(workflow);
  assert.match(body, /runs-on: windows-latest/);
  assert.match(body, /node-version: 22\.19\.0/);
  assert.match(body, /version: 11\.22\.0/);
  assert.match(body, /dtolnay\/rust-toolchain@1\.96\.1/);
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
  for (const command of commands) assert.doesNotMatch(command, /verify:runtime|--live|goal-runs\/|\b(?:push|publish|release|deploy)\b/);
  assert.ok(commands.includes("node scripts/desktop/verify-early-cleanup.mjs --package artifacts/electron-rc/ci/GoalPort-win32-x64 --out artifacts/electron-rc/ci-early-cleanup"));
});

test("Desktop CI retains only redacted failure summaries and never tolerates a failed step", () => {
  const { body } = desktopJob(workflow);
  assert.doesNotMatch(workflow, /continue-on-error/);
  const steps = body.split(/\r?\n(?=      - )/);
  const last = steps.at(-1);
  assert.match(last, /^\s+- name: .+\r?\n\s+if: failure\(\)\r?\n\s+uses: actions\/upload-artifact@v4\r?\n/);
  assert.match(last, /\n\s+retention-days: 7\s*$/);
  assert.match(last, /\n\s+if-no-files-found: ignore\r?\n/);
  const paths = [...last.matchAll(/^ {12}(\S+)\s*$/gm)].map((match) => match[1]);
  assert.deepEqual(paths, ["normal-smoke", "synthetic-smoke", "early-cleanup"].map((name) => `artifacts/electron-rc/ci-${name}/failure-summary.json`));
  assert.equal(steps.filter((step) => /upload-artifact/.test(step)).length, 1);
});
