import { requireOperationId, writeBearer } from "./v1-closure-rawrun.mjs";
import { command, withPackagedGui } from "./v1-closure-gui.mjs";
import { EVID } from "./v1-isolated-env.mjs";

const operationId = requireOperationId();
const port = Number(process.env.GOALPORT_GUI_PORT || 19240);
const { report } = await withPackagedGui(port, async ({ evaluate }) => {
  let snapshot = await evaluate("window.goalportCore.snapshot()", true);
  snapshot = await command(evaluate, "select_runtime", {
    projectId: snapshot.selectedProjectId || snapshot.project.id,
    campaignId: snapshot.activeCampaignId,
    taskId: snapshot.activeTask.id,
    provider: "scenario"
  });
  const actions = ["commit", "push", "release", "delete"];
  const results = [];
  for (const action of actions) {
    const next = await command(evaluate, "request_owner_action", { action, planApproved: true, auditPassed: true });
    results.push({
      action,
      blocked: (next.notices || []).some((notice) => notice.includes(action) && /blocked/i.test(notice)),
      notices: next.notices?.slice(0, 2)
    });
  }
  const semantic = {
    schemaVersion: 1,
    kind: "saf-02-owner-only",
    results,
    status: results.every((item) => item.blocked) ? "PASS" : "UNMET"
  };
  return writeBearer({
    evid: EVID,
    evidenceClass: "saf-02",
    bearerBasename: "saf-02-owner-only.json",
    semantic,
    operationId,
    extraIdentity: { host: "electron-packaged" }
  });
});
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.status === "PASS" ? 0 : 1;
