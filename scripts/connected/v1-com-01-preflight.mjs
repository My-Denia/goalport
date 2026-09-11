import { execFileSync } from "node:child_process";
import { requireOperationId, writeBearer } from "./v1-closure-rawrun.mjs";
import { assertIsolatedEnv, EVID } from "./v1-isolated-env.mjs";

assertIsolatedEnv();
const operationId = requireOperationId();

function version(commands) {
  for (const command of commands) {
    try {
      return execFileSync(command, ["--version"], { encoding: "utf8", timeout: 10000, windowsHide: true, shell: false }).trim().split(/\r?\n/)[0];
    } catch {
      try {
        return execFileSync(command, ["--version"], { encoding: "utf8", timeout: 10000, windowsHide: true, shell: true }).trim().split(/\r?\n/)[0];
      } catch {
        continue;
      }
    }
  }
  return "unresolved";
}

const codex = version(["codex.cmd", "codex", "codex.exe"]);
const claude = version(["claude.exe", "claude"]);
const semantic = {
  schemaVersion: 1,
  kind: "com-01-preflight",
  historical: { codex: "0.151.0", claude: "2.1.251" },
  live: { codex, claude },
  changed: !codex.includes("0.151.0") || !claude.includes("2.1.251"),
  status: /0\.152\.0/.test(codex) && /2\.1\.252/.test(claude) ? "PASS" : "UNMET"
};
const { report } = writeBearer({
  evid: EVID,
  evidenceClass: "com-01",
  bearerBasename: "com-01-preflight.json",
  semantic,
  operationId,
  extraIdentity: { host: "electron-packaged" }
});
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.status === "PASS" ? 0 : 1;
