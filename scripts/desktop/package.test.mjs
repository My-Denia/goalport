import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { artifactPaths, asarApi, COMPONENTS, fileHash, ROOT, sha256 } from "./package.mjs";
import { verifyPackage } from "./verify-package.mjs";

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
  for (const name of ["main.cjs", "preload.cjs", "launch-config.cjs", "core-client.cjs", "dist/index.html"]) writeFileSync(resolve(stage, name), "test-only app content");
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
