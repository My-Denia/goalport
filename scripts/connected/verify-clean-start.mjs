import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const argv = process.argv.slice(2);
const value = (name) => { const i = argv.indexOf(name); if (i < 0) throw new Error(`${name} is required`); return argv[i + 1]; };
const host = value("--host");
const hostPid = Number(value("--host-pid"));
const corePid = Number(value("--core-pid"));
const artifact = resolve(root, value("--artifact"));
const core = resolve(root, value("--core"));
const db = resolve(root, value("--db"));
const connectedReport = resolve(root, value("--connected-report"));
const reportPath = resolve(root, value("--report"));
const pipe = value("--pipe");
const startedAtUtc = value("--started-at-utc");
const cdpPort = Number(value("--cdp-port"));
const stderrPath = argv.includes("--stderr") ? resolve(root, value("--stderr")) : null;
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const connected = JSON.parse(readFileSync(connectedReport, "utf8"));
let cdpPage = false;
try {
  const pages = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
  cdpPage = (Array.isArray(pages) ? pages : [pages]).some((page) => page.title === "GoalPort");
} catch {}
const coreSha256 = sha256(core);
const report = {
  schemaVersion: 1,
  kind: "packaged-clean-standalone-start",
  host,
  startedAtUtc,
  verifiedAtUtc: new Date().toISOString(),
  launch: { pipe: "[run-owned named pipe]", db: "[run-owned SQLite]", cdpPort, injectedBuildId: false },
  processes: { hostPid, hostAlive: alive(hostPid), corePid, coreAlive: alive(corePid) },
  artifacts: {
    host: { path: artifact.replaceAll("\\", "/").replace(root.replaceAll("\\", "/") + "/", ""), bytes: statSync(artifact).size, sha256: sha256(artifact) },
    core: { path: core.replaceAll("\\", "/").replace(root.replaceAll("\\", "/") + "/", ""), bytes: statSync(core).size, sha256: coreSha256 }
  },
  database: { present: statSync(db).isFile(), bytes: statSync(db).size },
  connectedOperation: { ref: connectedReport.replaceAll("\\", "/").replace(root.replaceAll("\\", "/") + "/", ""), status: connected.status, coreBuildId: connected.coreBuildId, provider: connected.provider },
  cdpPage,
  stderrSha256: stderrPath ? sha256(stderrPath) : null,
  status: alive(hostPid) && alive(corePid) && cdpPage && connected.status === "PASS" && connected.provider === "codex" && connected.coreBuildId === coreSha256 ? "PASS" : "UNMET"
};
mkdirSync(resolve(reportPath, ".."), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.status === "PASS" ? 0 : 1;
