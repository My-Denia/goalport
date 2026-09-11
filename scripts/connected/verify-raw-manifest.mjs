import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const argv = process.argv.slice(2);
const value = (name, fallback) => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : fallback; };
const outputPath = resolve(ROOT, value("--out", "goal-runs/goalport-stable-v1-closure/evidence/raw-validation/manifest.json"));
function walk(directory, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = resolve(directory, entry.name);
    if (entry.isDirectory() && !["node_modules", "target", "dist", ".git", "goal-runs", ".goal-runs"].includes(entry.name) && !entry.name.startsWith("target-")) walk(full, files);
    else if (entry.isFile() && !/\.tsbuildinfo$|\.sqlite$|\.db$/.test(entry.name)) files.push(full);
  }
  return files;
}
const files = walk(ROOT).sort();
const digest = createHash("sha256");
const entries = files.map((file) => {
  const data = readFileSync(file);
  const path = relative(ROOT, file).split("\\").join("/");
  digest.update(path); digest.update("\0"); digest.update(data); digest.update("\0");
  return { path, bytes: data.byteLength, sha256: createHash("sha256").update(data).digest("hex") };
});
const artifactPaths = ["target/release/goalport-core.exe", "target/release/goalport-core-launcher.exe", "goal-runs/goalport-stable-v1-closure/evidence/electron-package/GoalPort-win32-x64/GoalPort.exe"];
const artifacts = artifactPaths.map((path) => {
  const file = resolve(ROOT, path);
  return { path, exists: statSync(file, { throwIfNoEntry: false }) !== undefined, sha256: statSync(file, { throwIfNoEntry: false }) ? createHash("sha256").update(readFileSync(file)).digest("hex") : null };
});
const report = { schemaVersion: 1, kind: "goalport-raw-validation-manifest", argv: process.argv.slice(2), cwd: ROOT, startedAtUtc: new Date().toISOString(), sourceListSha256: digest.digest("hex"), files: entries, artifacts, lockfileSha256: createHash("sha256").update(readFileSync(resolve(ROOT, "pnpm-lock.yaml"))).digest("hex"), completedAtUtc: new Date().toISOString(), exit: 0, nonZeroExecution: { files: entries.length, artifacts: artifacts.filter((artifact) => artifact.exists).length } };
mkdirSync(resolve(outputPath, ".."), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
