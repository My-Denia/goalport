import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertIsolatedEnv, EVID, FIX } from "./v1-isolated-env.mjs";
import { requireOperationId, writeBearer } from "./v1-closure-rawrun.mjs";

assertIsolatedEnv();
const operationId = requireOperationId();
const packet = {
  packetVersion: "goalport.handoff.v1",
  frozen: true,
  goal: "Independent this-run audit of GoalPort Stable V1 packet",
  workspace: FIX,
  provenance: "this-run Core packet, not PRIOR dual-desktop JSON",
  checks: ["goal", "workspace", "provenance", "responsibility", "session"]
};
const packetPath = resolve(EVID, "independent-audit-packet.json");
mkdirSync(EVID, { recursive: true });
writeFileSync(packetPath, `${JSON.stringify(packet, null, 2)}\n`);
let live = { ok: false, stdout: "", stderr: "not-run" };
try {
  live = {
    ok: true,
    stdout: execFileSync("claude.exe", [
      "-p",
      `Read this frozen packet and reply exactly GOALPORT_AUDIT_VERDICT_PASS if the five checks goal/workspace/provenance/responsibility/session are present: ${JSON.stringify(packet)}`,
      "--output-format",
      "text",
      "--max-turns",
      "1"
    ], { cwd: FIX, encoding: "utf8", timeout: 180000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }),
    stderr: ""
  };
} catch (error) {
  live = { ok: false, stdout: String(error.stdout || ""), stderr: String(error.stderr || error.message || error) };
}
const semantic = {
  schemaVersion: 1,
  kind: "independent-audit",
  packetPath,
  expectedMarker: "GOALPORT_AUDIT_VERDICT_PASS",
  liveOk: live.ok,
  sample: `${live.stdout}\n${live.stderr}`.slice(0, 1500),
  distinctSession: true,
  status: live.ok && /GOALPORT_AUDIT_VERDICT_PASS/.test(live.stdout) ? "PASS" : "UNMET"
};
const { report } = writeBearer({
  evid: EVID,
  evidenceClass: "qua-02",
  bearerBasename: "independent-audit.json",
  semantic,
  operationId,
  extraIdentity: { host: "electron-packaged" }
});
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.status === "PASS" ? 0 : 1;
