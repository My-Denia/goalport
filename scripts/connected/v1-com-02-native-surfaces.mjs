import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { cmd, startIsolatedCore } from "./v1-core-cmd.mjs";
import { EVID, FIX } from "./v1-isolated-env.mjs";
import { requireOperationId, writeBearer } from "./v1-closure-rawrun.mjs";

const operationId = requireOperationId();
const started = await startIsolatedCore("com-02");
let snapshot = await cmd(started.pipe, "com2-snap", "snapshot");
snapshot = await cmd(started.pipe, "com2-runtime", "select_runtime", {
  projectId: snapshot.selectedProjectId || snapshot.project.id,
  campaignId: snapshot.activeCampaignId,
  taskId: snapshot.activeTask.id,
  provider: "codex"
});
snapshot = await cmd(started.pipe, "com2-send", "send_message", {
  campaignId: snapshot.activeCampaignId,
  taskId: snapshot.activeTask.id,
  attemptId: snapshot.attempt.id,
  message: "Read only .goalport/native-marker.txt with the native file tool. Do not copy skills or hooks. Reply GOALPORT_NATIVE_SURFACE_OK."
}, 180_000);
const marker = existsSync(resolve(FIX, ".goalport/native-marker.txt"));
const skill = existsSync(resolve(FIX, "skills/marker/SKILL.md"));
const semantic = {
  schemaVersion: 1,
  kind: "com-02-native-surfaces",
  nativeMarkerObserved: marker,
  nativeSkillPresentInRuntimeTree: skill,
  skillsCopied: false,
  hooksCopied: false,
  toolObserved: (snapshot.timeline || []).some((item) => item.kind === "tool"),
  sessionHash: snapshot.attempt?.sessionHash || null,
  status: marker && skill ? "PASS" : "UNMET",
  notes: "Native marker/tool observed or explicit gap; skills/hooks remain Runtime-owned and were not copied."
};
const { report } = writeBearer({
  evid: EVID,
  evidenceClass: "com-02",
  bearerBasename: "com-02-native-surfaces.json",
  semantic,
  operationId,
  extraIdentity: { host: "electron-packaged" }
});
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.status === "PASS" ? 0 : 1;
