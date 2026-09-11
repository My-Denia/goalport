import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { cmd, startIsolatedCore } from "./v1-core-cmd.mjs";
import { EVID } from "./v1-isolated-env.mjs";
import { freezeShas, requireOperationId } from "./v1-closure-rawrun.mjs";
const operationId = requireOperationId();
const shas = freezeShas(EVID);

function findCorePid(pipe) {
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'goalport-core.exe' -and $_.CommandLine -match '${String(pipe).replaceAll("\\", "\\\\")}' } | Select-Object -ExpandProperty ProcessId`;
  try {
    return Number(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 8000, windowsHide: true }).trim().split(/\s+/)[0]);
  } catch {
    return null;
  }
}

const started = await startIsolatedCore("codex-resume");
let snapshot = await cmd(started.pipe, "rs-snap", "snapshot");
snapshot = await cmd(started.pipe, "rs-runtime", "select_runtime", {
  projectId: snapshot.selectedProjectId || snapshot.project.id,
  campaignId: snapshot.activeCampaignId,
  taskId: snapshot.activeTask.id,
  provider: "codex"
});
const attemptId = snapshot.attempt.id;
const beforeHash = snapshot.attempt.sessionHash;
snapshot = await cmd(started.pipe, "rs-send", "send_message", {
  campaignId: snapshot.activeCampaignId,
  taskId: snapshot.activeTask.id,
  attemptId,
  message: "Reply GOALPORT_RESUME_SETUP without modifying files."
}, 180_000);
const sessionHashBefore = snapshot.attempt.sessionHash || beforeHash;
const corePidBefore = findCorePid(started.pipe);
if (corePidBefore) {
  execFileSync("taskkill.exe", ["/PID", String(corePidBefore), "/F"], { encoding: "utf8", timeout: 10000, windowsHide: true });
}
const restarted = await startIsolatedCore("resume-restart");
let resumed;
try {
  resumed = await cmd(restarted.pipe, `rs-resume-${Date.now()}`, "resume_native_session", { attemptId });
} catch (error) {
  resumed = { attempt: snapshot.attempt, timeline: [], notices: [String(error.message || error)] };
}
const resumedEvent = (resumed.timeline || []).find((item) => item.body === "runtime.session.resumed");
const report = {
  schemaVersion: 1,
  kind: "codex-native-resume",
  attemptId,
  sessionHashBefore,
  sessionHashAfter: resumed.attempt?.sessionHash || null,
  resumed: Boolean(resumedEvent),
  unsupported: (resumed.timeline || []).some((item) => /unsupported/i.test(item.body) || (item.details || []).some((detail) => /unsupported/i.test(String(detail)))),
  nativeSubmissionCount: 1,
  status: Boolean(resumedEvent) || (resumed.timeline || []).some((item) => /unsupported/i.test(item.body) || (item.details || []).some((detail) => /unsupported/i.test(String(detail)))) ? "PASS" : "UNMET",
  notes: "PASS requires observed runtime.session.resumed or an explicit unsupported payload. Hidden new Attempt is forbidden.",
  operationId,
  runLabel: "goalport-stable-v1-closure",
  coreSha256: shas.coreSha256,
  exeSha256: shas.exeSha256,
  host: "electron-packaged"
};
mkdirSync(EVID, { recursive: true });
writeFileSync(resolve(EVID, "codex-native-resume.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.status === "PASS" ? 0 : 1;
