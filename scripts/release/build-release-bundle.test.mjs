import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { artifactPaths, asarApi, COMPONENTS, fileHash, sourceIdentity } from "../desktop/package.mjs";
import { buildReleaseBundle } from "./build-release-bundle.mjs";

function fixtureGitEnv(root) {
  return { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: resolve(root, "missing-global-config"), GIT_TERMINAL_PROMPT: "0" };
}

function fixtureGit(root, args) {
  const result = spawnSync("git", args, { cwd: root, env: fixtureGitEnv(root), encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`Fixture Git command failed: git ${args.join(" ")}\n${result.stderr || result.error || ""}`);
  return result.stdout;
}

function isolatedSourceIdentity(root) {
  const previous = { GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_TERMINAL_PROMPT: process.env.GIT_TERMINAL_PROMPT };
  Object.assign(process.env, fixtureGitEnv(root));
  try { return sourceIdentity(root); } finally {
    for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
}

function repoFixture(t, version = "1.0.0-rc.1") {
  const temp = mkdtempSync(resolve(tmpdir(), "goalport-release-bundle-repo-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const root = resolve(temp, "source");
  mkdirSync(root, { recursive: true });
  writeFileSync(resolve(root, "Cargo.lock"), "# fixture lock\n");
  writeFileSync(resolve(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeFileSync(resolve(root, "package.json"), JSON.stringify({ name: "goalport", version, license: "Apache-2.0" }));
  writeFileSync(resolve(root, "LICENSE"), "fixture Apache-2.0 text\n");
  mkdirSync(resolve(root, "release"), { recursive: true });
  writeFileSync(resolve(root, "release/THIRD_PARTY_NOTICES.txt"), "fixture notices\n");
  fixtureGit(root, ["init", "--initial-branch", "main"]);
  fixtureGit(root, ["add", "--all"]);
  fixtureGit(root, ["-c", "user.name=GoalPort Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--no-gpg-sign", "-m", "fixture"]);
  return { root, identity: isolatedSourceIdentity(root) };
}

async function packageFixture(t, { version = "1.0.0-rc.1", source }) {
  const temp = mkdtempSync(resolve(tmpdir(), "goalport-release-bundle-pkg-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const root = resolve(temp, "package");
  const stage = resolve(temp, "stage");
  mkdirSync(resolve(root, "resources"), { recursive: true });
  mkdirSync(resolve(stage, "dist"), { recursive: true });
  for (const name of COMPONENTS) writeFileSync(resolve(root, "resources", name), `test-only ${name}`);
  writeFileSync(resolve(root, "GoalPort.exe"), "test-only executable");
  writeFileSync(resolve(root, "LICENSE"), "fixture Electron MIT text\n");
  writeFileSync(resolve(root, "LICENSES.chromium.html"), "<html>fixture chromium notices</html>\n");
  for (const name of ["main.cjs", "preload.cjs", "launch-config.cjs", "core-client.cjs", "profile-manager.cjs", "window-state.cjs", "dist/index.html"]) writeFileSync(resolve(stage, name), "test-only app content");
  writeFileSync(resolve(stage, "package.json"), JSON.stringify({ name: "goalport-electron-rc", version, main: "main.cjs" }));
  const buildInfo = { schemaVersion: 1, product: "GoalPort", version, channel: "Stable V1 RC", electronVersion: "44.0.0", source, components: Object.fromEntries(COMPONENTS.map((name) => [name, fileHash(resolve(root, "resources", name))])) };
  writeFileSync(resolve(stage, "build-info.json"), JSON.stringify(buildInfo));
  await asarApi().createPackage(stage, resolve(root, "resources/app.asar"));
  const manifest = { ...buildInfo, artifacts: [] };
  manifest.artifacts = artifactPaths(root).map((name) => ({ path: name, bytes: statSync(resolve(root, name)).size, sha256: fileHash(resolve(root, name)) }));
  writeFileSync(resolve(root, "package-manifest.json"), JSON.stringify(manifest));
  return root;
}

test("refuses an already-existing bundle destination before doing any work", async (t) => {
  const { root: repoRoot, identity } = repoFixture(t);
  const packageRoot = await packageFixture(t, { source: identity });
  const outDir = resolve(mkdtempSync(resolve(tmpdir(), "goalport-release-bundle-out-")), "candidate");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, "keep.txt"), "existing");
  await assert.rejects(buildReleaseBundle({ packageDir: packageRoot, outDir, root: repoRoot }), /already exists/);
  assert.deepEqual(artifactPaths(outDir), ["keep.txt"]);
});

test("refuses a dirty source tree", async (t) => {
  const { root: repoRoot, identity } = repoFixture(t);
  const packageRoot = await packageFixture(t, { source: identity });
  writeFileSync(resolve(repoRoot, "package.json"), JSON.stringify({ name: "goalport", version: "1.0.0-rc.1", license: "Apache-2.0", touched: true }));
  const outDir = resolve(mkdtempSync(resolve(tmpdir(), "goalport-release-bundle-out-")), "candidate");
  await assert.rejects(buildReleaseBundle({ packageDir: packageRoot, outDir, root: repoRoot }), /dirty source/);
});

test("refuses a package built from a different source revision", async (t) => {
  const { root: repoRoot, identity } = repoFixture(t);
  const staleSource = { ...identity, revision: "b".repeat(40) };
  const packageRoot = await packageFixture(t, { source: staleSource });
  const outDir = resolve(mkdtempSync(resolve(tmpdir(), "goalport-release-bundle-out-")), "candidate");
  await assert.rejects(buildReleaseBundle({ packageDir: packageRoot, outDir, root: repoRoot }), /does not match the package's recorded source revision/);
});

test("refuses a package version that does not match the repository version", async (t) => {
  const { root: repoRoot, identity } = repoFixture(t, "1.0.0-rc.2");
  const packageRoot = await packageFixture(t, { version: "1.0.0-rc.1", source: identity });
  const outDir = resolve(mkdtempSync(resolve(tmpdir(), "goalport-release-bundle-out-")), "candidate");
  await assert.rejects(buildReleaseBundle({ packageDir: packageRoot, outDir, root: repoRoot }), /does not match repository version/);
});

test("a clean matching source and package produce a verifiable ZIP, manifest and checksums", async (t) => {
  const { root: repoRoot, identity } = repoFixture(t);
  const packageRoot = await packageFixture(t, { source: identity });
  const outDir = resolve(mkdtempSync(resolve(tmpdir(), "goalport-release-bundle-out-")), "candidate");
  const result = await buildReleaseBundle({ packageDir: packageRoot, outDir, root: repoRoot });
  assert.equal(result.version, "1.0.0-rc.1");
  assert.equal(result.signing, "unsigned");
  assert.equal(fileHash(result.zipPath), result.zipSha256);
  const manifest = JSON.parse(readFileSync(result.manifestPath, "utf8"));
  assert.equal(manifest.product, "GoalPort");
  assert.equal(manifest.channel, "Stable V1 RC");
  assert.equal(manifest.candidateTag, "v1.0.0-rc.1");
  assert.equal(manifest.zip.sha256, result.zipSha256);
  const sums = readFileSync(resolve(outDir, "SHA256SUMS.txt"), "utf8");
  assert.match(sums, new RegExp(`${result.zipSha256}  GoalPort-1\\.0\\.0-rc\\.1-windows-x64\\.zip`));

  await assert.rejects(buildReleaseBundle({ packageDir: packageRoot, outDir, root: repoRoot }), /already exists/);
});
