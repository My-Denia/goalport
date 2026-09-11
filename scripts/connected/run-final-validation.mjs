import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { EVID_REL } from "./v1-isolated-env.mjs";

const root = resolve(import.meta.dirname, "../..");
const out = resolve(root, `${EVID_REL}/raw-validation/final`);
mkdirSync(out, { recursive: true });
const commands = [
  { id: "cargo-fmt", command: "cargo.exe", args: ["fmt", "--all", "--", "--check"] },
  { id: "cargo-clippy", command: "cargo.exe", args: ["clippy", "--workspace", "--all-targets", "--", "-D", "warnings"] },
  { id: "cargo-test", command: "cargo.exe", args: ["test", "--workspace", "--all-targets", "--", "--nocapture"] },
  { id: "cargo-test-live-runtime", command: "cargo.exe", args: ["test", "-p", "goalport-core", "--test", "native_runtime", "--", "--ignored", "--nocapture"] },
  { id: "cargo-test-live-spawn", command: "cargo.exe", args: ["test", "-p", "goalport-core", "--test", "native_spawn", "--", "--ignored", "--nocapture"] },
  { id: "pnpm-test", command: "cmd.exe", args: ["/d", "/s", "/c", "pnpm test"] },
  { id: "pnpm-lint", command: "cmd.exe", args: ["/d", "/s", "/c", "pnpm lint"] },
  { id: "pnpm-build", command: "cmd.exe", args: ["/d", "/s", "/c", "pnpm build"] },
  { id: "connected-predicates", command: "node.exe", args: ["--test", "scripts/connected/ipc-client.test.mjs", "scripts/connected/strict-predicates.test.mjs", "scripts/connected/v1-isolated-env.test.mjs"] }
];
const results = [];
for (const item of commands) {
  const startedAtUtc = new Date().toISOString();
  const result = spawnSync(item.command, item.args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024
  });
  const completedAtUtc = new Date().toISOString();
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  const stdoutPath = resolve(out, `${item.id}.stdout.log`);
  const stderrPath = resolve(out, `${item.id}.stderr.log`);
  writeFileSync(stdoutPath, stdout, "utf8");
  writeFileSync(stderrPath, stderr, "utf8");
  const combined = `${stdout}\n${stderr}`;
  const counts = [...combined.matchAll(/(\d+) passed; (\d+) failed; (\d+) ignored/g)].map((match) => ({
    passed: Number(match[1]),
    failed: Number(match[2]),
    ignored: Number(match[3])
  }));
  results.push({
    id: item.id,
    argv: [item.command, ...item.args],
    cwd: root,
    startedAtUtc,
    completedAtUtc,
    exit: result.status ?? 1,
    spawnError: result.error ? String(result.error.message || result.error) : null,
    stdout: { path: stdoutPath.replace(root, "<workspace>"), bytes: Buffer.byteLength(stdout), sha256: createHash("sha256").update(stdout).digest("hex") },
    stderr: { path: stderrPath.replace(root, "<workspace>"), bytes: Buffer.byteLength(stderr), sha256: createHash("sha256").update(stderr).digest("hex") },
    nonZeroExecution: counts.length > 0 ? counts : { outputBytes: Buffer.byteLength(combined) }
  });
}
const artifactPaths = [
  "target/release/goalport-core.exe",
  "target/release/goalport-core-launcher.exe",
  `${EVID_REL}/electron-package/GoalPort-win32-x64/GoalPort.exe`,
  `${EVID_REL}/electron-package/GoalPort-win32-x64/resources/goalport-core.exe`,
  `${EVID_REL}/electron-package/GoalPort-win32-x64/resources/app.asar`
];
const artifacts = artifactPaths.map((path) => {
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
  kind: "final-raw-validation",
  results,
  artifacts,
  status: results.every((item) => item.exit === 0) ? "PASS" : "UNMET"
};
writeFileSync(resolve(out, "commands.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  status: report.status,
  commands: results.map((item) => ({ id: item.id, exit: item.exit, nonZeroExecution: item.nonZeroExecution })),
  artifacts
}, null, 2));
process.exitCode = report.status === "PASS" ? 0 : 1;
