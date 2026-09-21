import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { artifactPaths, asarApi, COMPONENTS, fileHash, ROOT, sha256, sourceIdentity } from "./package.mjs";
import { verifyPackage } from "./verify-package.mjs";

function fixtureGitEnv(root) {
  return {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: resolve(root, "missing-global-config"),
    GIT_TERMINAL_PROMPT: "0"
  };
}

function fixtureGit(root, args) {
  const result = spawnSync("git", args, { cwd: root, env: fixtureGitEnv(root), encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`Fixture Git command failed: git ${args.join(" ")}\n${result.stderr || result.error || ""}`);
  return result.stdout;
}

function isolatedSourceIdentity(root) {
  const previous = {
    GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    GIT_TERMINAL_PROMPT: process.env.GIT_TERMINAL_PROMPT
  };
  Object.assign(process.env, fixtureGitEnv(root));
  try {
    return sourceIdentity(root);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function sourceIdentityFixture(t) {
  const temp = mkdtempSync(resolve(tmpdir(), "goalport-source-identity-test-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const root = resolve(temp, "source");
  mkdirSync(root, { recursive: true });
  writeFileSync(resolve(root, ".gitignore"), ".cargo/config.toml\n");
  writeFileSync(resolve(root, "Cargo.lock"), "# fixture lock\n");
  writeFileSync(resolve(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeFileSync(resolve(root, "package.json"), JSON.stringify({ name: "source-identity-fixture", private: true }));
  fixtureGit(root, ["init", "--initial-branch", "main"]);
  fixtureGit(root, ["add", "--all"]);
  fixtureGit(root, ["-c", "user.name=GoalPort Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--no-gpg-sign", "-m", "fixture"]);
  return root;
}

async function fixture(t) {
  const temp = mkdtempSync(resolve(tmpdir(), "goalport-package-test-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const root = resolve(temp, "package");
  const stage = resolve(temp, "stage");
  mkdirSync(resolve(root, "resources"), { recursive: true });
  mkdirSync(resolve(stage, "dist"), { recursive: true });
  for (const name of COMPONENTS) writeFileSync(resolve(root, "resources", name), `test-only ${name}`);
  writeFileSync(resolve(root, "GoalPort.exe"), "test-only executable");
  writeFileSync(resolve(root, "icudtl.dat"), "test-only runtime data");
  for (const name of ["main.cjs", "preload.cjs", "launch-config.cjs", "core-client.cjs", "profile-manager.cjs", "window-state.cjs", "dist/index.html"]) writeFileSync(resolve(stage, name), "test-only app content");
  writeFileSync(resolve(stage, "package.json"), JSON.stringify({ name: "goalport-electron-rc", version: "1.0.0-rc.1", main: "main.cjs" }));
  const files = [{ path: "package.json", sha256: "a".repeat(64) }];
  const source = { revision: "b".repeat(40), dirty: true, files, treeSha256: sha256(files.map(({ path, sha256: hash }) => `${path}\0${hash}\n`).join("")) };
  const manifest = { schemaVersion: 1, product: "GoalPort", version: "1.0.0-rc.1", channel: "Stable V1 RC", electronVersion: "44.0.0", source, components: Object.fromEntries(COMPONENTS.map((name) => [name, fileHash(resolve(root, "resources", name))])) };
  writeFileSync(resolve(stage, "build-info.json"), JSON.stringify(manifest));
  await asarApi().createPackage(stage, resolve(root, "resources/app.asar"));
  manifest.artifacts = artifactPaths(root).map((name) => ({ path: name, bytes: statSync(resolve(root, name)).size, sha256: fileHash(resolve(root, name)) }));
  const save = () => writeFileSync(resolve(root, "package-manifest.json"), JSON.stringify(manifest));
  save();
  return { root, manifest, save };
}

test("an existing package destination is refused before any build or overwrite", (t) => {
  const destination = mkdtempSync(resolve(tmpdir(), "goalport-collision-test-"));
  t.after(() => rmSync(destination, { recursive: true, force: true }));
  const sentinel = resolve(destination, "keep.txt");
  writeFileSync(sentinel, "existing candidate");
  const result = spawnSync(process.execPath, [resolve(ROOT, "scripts/connected/package-electron.mjs"), "--out", destination], { encoding: "utf8", windowsHide: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Output already exists/);
  assert.equal(readFileSync(sentinel, "utf8"), "existing candidate");
  assert.deepEqual(artifactPaths(destination), ["keep.txt"]);
});

test("a complete fixture inventory verifies, then missing launcher is refused", async (t) => {
  const { root } = await fixture(t);
  assert.equal(verifyPackage(root).status, "PASS");
  rmSync(resolve(root, "resources/goalport-core-launcher.exe"));
  assert.throws(() => verifyPackage(root), /ENOENT|launcher/);
});

test("changed Core and changed Electron runtime data are detected", async (t) => {
  for (const target of ["resources/goalport-core.exe", "icudtl.dat"]) {
    const { root } = await fixture(t);
    writeFileSync(resolve(root, target), "changed");
    assert.throws(() => verifyPackage(root), /identity mismatch/);
  }
});

test("outside manifest cannot substitute another source identity or Stable version", async (t) => {
  const { root, manifest, save } = await fixture(t);
  manifest.source.revision = "c".repeat(40);
  save();
  assert.throws(() => verifyPackage(root), /Embedded source/);
  manifest.version = "1.0.0";
  save();
  assert.throws(() => verifyPackage(root), /RC identity/);
});

test("manifest cannot read outside the package and unlisted files are detected", async (t) => {
  const { root, manifest, save } = await fixture(t);
  writeFileSync(resolve(root, "unexpected.txt"), "extra");
  assert.throws(() => verifyPackage(root), /inventory differs/);
  manifest.artifacts.push({ path: "../outside", bytes: 1, sha256: "d".repeat(64) });
  save();
  assert.throws(() => verifyPackage(root), /Unsafe artifact path/);
});

test("new root build inputs change the declared source identity and dirty state", (t) => {
  const root = sourceIdentityFixture(t);
  const baseline = isolatedSourceIdentity(root);
  const added = {
    "index.html": "<!doctype html>\n",
    "rust-toolchain.toml": "channel = 'fixture'\n",
    "tsconfig.app.json": "{\"extends\":\"./tsconfig.json\"}\n",
    "tsconfig.extra.json": "{\"extends\":\"./tsconfig.json\"}\n",
    "tsconfig.json": "{\"files\":[] }\n",
    "tsconfig.node.json": "{\"include\":[\"vite.config.ts\"]}\n",
    "vite.config.mjs": "export default {};\n",
    "vite.config.ts": "export default {};\n"
  };
  for (const [name, contents] of Object.entries(added)) writeFileSync(resolve(root, name), contents);

  const withRootInputs = isolatedSourceIdentity(root);
  const paths = new Set(withRootInputs.files.map(({ path }) => path));
  for (const name of Object.keys(added)) assert.ok(paths.has(name), `${name} must be declared source`);
  assert.equal(withRootInputs.dirty, true);
  assert.notEqual(withRootInputs.treeSha256, baseline.treeSha256);

  writeFileSync(resolve(root, "vite.config.ts"), "export default { base: './' };\n");
  const changedRootInput = isolatedSourceIdentity(root);
  assert.notEqual(changedRootInput.treeSha256, withRootInputs.treeSha256);
  assert.equal(changedRootInput.files.find(({ path }) => path === "vite.config.ts").sha256, fileHash(resolve(root, "vite.config.ts")));
});

test("untracked or ignored Cargo config is refused while tracked safe config is declared and private config stays excluded", (t) => {
  const root = sourceIdentityFixture(t);
  mkdirSync(resolve(root, ".cargo"));
  writeFileSync(resolve(root, ".cargo/config"), "[net]\noffline = true\n");
  assert.throws(() => isolatedSourceIdentity(root), /Untracked or ignored Cargo configuration.*\.cargo[\\/]config/);
  rmSync(resolve(root, ".cargo/config"));

  writeFileSync(resolve(root, ".cargo/config.toml"), "[net]\noffline = true\n");
  assert.throws(() => isolatedSourceIdentity(root), /Untracked or ignored Cargo configuration.*\.cargo[\\/]config\.toml/);
  fixtureGit(root, ["add", "-f", ".cargo/config.toml"]);
  fixtureGit(root, ["-c", "user.name=GoalPort Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--no-gpg-sign", "-m", "track safe Cargo config"]);

  const trackedConfig = isolatedSourceIdentity(root);
  assert.equal(trackedConfig.dirty, false);
  assert.ok(trackedConfig.files.some(({ path }) => path === ".cargo/config.toml"));

  writeFileSync(resolve(root, ".npmrc"), "registry=https://registry.example.invalid\n");
  writeFileSync(resolve(root, ".env.local"), "VITE_FIXTURE=value\n");
  const privateConfig = isolatedSourceIdentity(root);
  assert.equal(privateConfig.treeSha256, trackedConfig.treeSha256);
  assert.equal(privateConfig.dirty, false);
  assert.ok(!privateConfig.files.some(({ path }) => path === ".npmrc" || path === ".env.local"));
});
