import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { argsFor, artifactPaths, asarApi, COMPONENTS, fileHash, sha256 } from "./package.mjs";

export function verifyPackage(directory) {
  const root = resolve(directory);
  const manifest = JSON.parse(readFileSync(resolve(root, "package-manifest.json"), "utf8"));
  if (manifest.product !== "GoalPort" || manifest.channel !== "Stable V1 RC" || !/^\d+\.\d+\.\d+-rc\.\d+$/.test(manifest.version)) throw new Error("Missing RC identity");
  const expected = ["GoalPort.exe", "resources/app.asar", ...COMPONENTS.map((name) => `resources/${name}`)];
  if (!Array.isArray(manifest.artifacts) || new Set(manifest.artifacts.map((entry) => entry.path)).size !== manifest.artifacts.length) throw new Error("Invalid or duplicate artifact inventory");
  for (const entry of manifest.artifacts) {
    if (typeof entry.path !== "string" || isAbsolute(entry.path) || entry.path.split(/[\\/]/).some((part) => part === ".." || part === "." || !part)) throw new Error("Unsafe artifact path");
    const actual = resolve(root, entry.path);
    if (entry.bytes <= 0 || statSync(actual).size !== entry.bytes || fileHash(actual) !== entry.sha256) throw new Error(`Component identity mismatch: ${entry.path}`);
  }
  const actualPaths = artifactPaths(root).filter((name) => name !== "package-manifest.json");
  if (JSON.stringify(actualPaths) !== JSON.stringify(manifest.artifacts.map((entry) => entry.path).sort())) throw new Error("Package file inventory differs from manifest");
  for (const path of expected) {
    const matches = manifest.artifacts?.filter((entry) => entry.path === path) || [];
    if (matches.length !== 1) throw new Error(`Manifest must contain exactly one ${path}`);
    const entry = matches[0];
    const actual = resolve(root, path);
    if (entry.bytes <= 0 || statSync(actual).size !== entry.bytes || fileHash(actual) !== entry.sha256) throw new Error(`Component identity mismatch: ${path}`);
  }
  const archive = resolve(root, "resources/app.asar");
  const asar = asarApi();
  const app = JSON.parse(asar.extractFile(archive, "package.json").toString());
  const embedded = JSON.parse(asar.extractFile(archive, "build-info.json").toString());
  if (app.version !== manifest.version || app.name !== "goalport-electron-rc" || app.main !== "main.cjs") throw new Error("Embedded Electron package identity mismatch");
  for (const name of ["version", "channel", "electronVersion", "source", "components"]) {
    if (JSON.stringify(embedded[name]) !== JSON.stringify(manifest[name])) throw new Error(`Embedded ${name} identity mismatch`);
  }
  if (!/^[0-9a-f]{40}$/.test(manifest.source?.revision || "") || !manifest.source.files?.length) throw new Error("Missing source revision or inventory");
  const digest = sha256(manifest.source.files.map(({ path, sha256: hash }) => `${path}\0${hash}\n`).join(""));
  if (digest !== manifest.source.treeSha256) throw new Error("Source inventory digest mismatch");
  for (const name of COMPONENTS) {
    if (fileHash(resolve(root, "resources", name)) !== manifest.components[name]) throw new Error(`Embedded component mismatch: ${name}`);
  }
  for (const name of ["main.cjs", "preload.cjs", "launch-config.cjs", "core-client.cjs", "dist/index.html"]) {
    if (!asar.extractFile(archive, name).length) throw new Error(`Missing app content: ${name}`);
  }
  return { status: "PASS", version: manifest.version, channel: manifest.channel, sourceRevision: manifest.source.revision, sourceDirty: manifest.source.dirty, sourceTreeSha256: digest, artifacts: manifest.artifacts };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = argsFor(process.argv.slice(2), ["--package"]);
    if (args.help) console.log("Usage: pnpm electron:verify --package <GoalPort-win32-x64-directory>");
    else {
      if (!args["--package"]) throw new Error("--package is required");
      const result = verifyPackage(args["--package"]);
      console.log(JSON.stringify({ ...result, artifacts: undefined, filesVerified: result.artifacts.length }, null, 2));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
