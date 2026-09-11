import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { EVID_REL } from "./v1-isolated-env.mjs";

const root = resolve(import.meta.dirname, "../..");
const out = resolve(root, `${EVID_REL}/raw-validation/package-builds`);
mkdirSync(out, { recursive: true });
const commands = [
  { id: "electron-package", argv: ["cmd.exe", "/d", "/s", "/c", "pnpm electron:package"] }
];
const results = [];
for (const item of commands) {
  const startedAtUtc = new Date().toISOString();
  const r = spawnSync(item.argv[0], item.argv.slice(1), {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024
  });
  const completedAtUtc = new Date().toISOString();
  const stdout = r.stdout || "";
  const stderr = r.stderr || "";
  writeFileSync(resolve(out, `${item.id}.stdout.log`), stdout);
  writeFileSync(resolve(out, `${item.id}.stderr.log`), stderr);
  results.push({
    id: item.id,
    argv: item.argv,
    cwd: root,
    startedAtUtc,
    completedAtUtc,
    exit: r.status ?? 1,
    spawnError: r.error ? String(r.error.message || r.error) : null,
    stdoutSha256: createHash("sha256").update(stdout).digest("hex"),
    stderrSha256: createHash("sha256").update(stderr).digest("hex"),
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: Buffer.byteLength(stderr)
  });
}
const paths = [
  "target/release/goalport-core.exe",
  "target/release/goalport-core-launcher.exe",
  `${EVID_REL}/electron-package/GoalPort-win32-x64/GoalPort.exe`,
  `${EVID_REL}/electron-package/GoalPort-win32-x64/resources/goalport-core.exe`,
  `${EVID_REL}/electron-package/GoalPort-win32-x64/resources/app.asar`
];
const artifacts = paths.map((path) => {
  const file = resolve(root, path);
  if (!existsSync(file)) return { path, exists: false, bytes: 0, sha256: null };
  return {
    path,
    exists: true,
    bytes: statSync(file).size,
    sha256: createHash("sha256").update(readFileSync(file)).digest("hex")
  };
});
const report = {
  schemaVersion: 2,
  kind: "final-package-builds",
  results,
  artifacts,
  status: results.every((item) => item.exit === 0) && artifacts.every((item) => item.exists) ? "PASS" : "UNMET"
};
writeFileSync(resolve(out, "package-builds.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.status === "PASS" ? 0 : 1;
