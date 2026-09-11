import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { requireOperationId, writeBearer } from "./v1-closure-rawrun.mjs";
import { command, withPackagedGui } from "./v1-closure-gui.mjs";
import { EVID, FIX } from "./v1-isolated-env.mjs";

const operationId = requireOperationId();
const port = Number(process.env.GOALPORT_GUI_PORT || 19243);
const target = resolve(FIX, "AGENTS.md");
const { report } = await withPackagedGui(port, async ({ evaluate }) => {
  let snapshot = await evaluate("window.goalportCore.snapshot()", true);
  snapshot = await command(evaluate, "select_runtime", {
    projectId: snapshot.selectedProjectId || snapshot.project.id,
    campaignId: snapshot.activeCampaignId,
    taskId: snapshot.activeTask.id,
    provider: "scenario"
  });
  appendFileSync(target, `\n# external edit ${new Date().toISOString()}\n`);
  snapshot = await command(evaluate, "observe_workspace_edit", {
    attemptId: snapshot.attempt.id,
    path: target
  });
  const stale = (snapshot.evidence || []).some((item) => item.state === "stale")
    || (snapshot.timeline || []).some((item) => item.body === "evidence.stale" || item.evidenceState === "stale");
  const semantic = {
    schemaVersion: 1,
    kind: "qua-01-stale-evidence",
    guiStale: stale,
    desktop: stale ? "PASS" : "UNMET",
    path: target,
    status: stale ? "PASS" : "UNMET"
  };
  return writeBearer({
    evid: EVID,
    evidenceClass: "qua-01",
    bearerBasename: "qua-01-stale-evidence.json",
    semantic,
    operationId,
    extraIdentity: { host: "electron-packaged" }
  });
});
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.status === "PASS" ? 0 : 1;
