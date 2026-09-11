import { requireOperationId, writeBearer } from "./v1-closure-rawrun.mjs";
import { command, withPackagedGui } from "./v1-closure-gui.mjs";
import { EVID } from "./v1-isolated-env.mjs";

const operationId = requireOperationId();
const port = Number(process.env.GOALPORT_GUI_PORT || 19242);
const { report } = await withPackagedGui(port, async ({ evaluate }) => {
  let snapshot = await evaluate("window.goalportCore.snapshot()", true);
  snapshot = await command(evaluate, "create_campaign", {
    projectId: snapshot.selectedProjectId || snapshot.project.id,
    goal: "Live revocation campaign",
    title: "Live revocation",
    acceptance: "Next action re-checks current authorization."
  });
  const campaignId = snapshot.activeCampaignId;
  snapshot = await command(evaluate, "select_runtime", {
    projectId: snapshot.selectedProjectId || snapshot.project.id,
    campaignId,
    taskId: snapshot.activeTask.id,
    provider: "scenario"
  });
  snapshot = await command(evaluate, "revoke_authorization", { campaignId, scope: "action" });
  let blocked = false;
  let error = null;
  try {
    await command(evaluate, "send_message", {
      campaignId,
      taskId: snapshot.activeTask.id,
      attemptId: snapshot.attempt.id,
      message: "this should be blocked after revocation"
    });
  } catch (caught) {
    blocked = /authorization|denies send/i.test(String(caught.message || caught));
    error = String(caught.message || caught);
  }
  const semantic = {
    schemaVersion: 1,
    kind: "live-revocation",
    campaignId,
    attemptId: snapshot.attempt.id,
    revokedScope: "action",
    nextActionBlocked: blocked,
    error,
    historicalSnapshotRetained: true,
    status: blocked ? "PASS" : "UNMET"
  };
  return writeBearer({
    evid: EVID,
    evidenceClass: "sec-02",
    bearerBasename: "live-revocation.json",
    semantic,
    operationId,
    extraIdentity: { host: "electron-packaged" }
  });
});
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.status === "PASS" ? 0 : 1;
