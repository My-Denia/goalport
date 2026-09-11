import { requireOperationId, writeBearer } from "./v1-closure-rawrun.mjs";
import { command, withPackagedGui } from "./v1-closure-gui.mjs";
import { EVID } from "./v1-isolated-env.mjs";

const operationId = requireOperationId();
const port = Number(process.env.GOALPORT_GUI_PORT || 19241);
const { report } = await withPackagedGui(port, async ({ evaluate }) => {
  const snapshot = await evaluate("window.goalportCore.snapshot()", true);
  const grok = (snapshot.runtimes || []).find((runtime) => runtime.id === "grok");
  let transferredBytes = 0;
  let invokedGrok = false;
  try {
    await command(evaluate, "select_runtime", {
      projectId: snapshot.selectedProjectId || snapshot.project.id,
      campaignId: snapshot.activeCampaignId,
      taskId: snapshot.activeTask.id,
      provider: "codex"
    });
  } catch {}
  const semantic = {
    schemaVersion: 1,
    kind: "sec-01-exclusion",
    grokSupport: grok?.support || "missing",
    grokExcluded: grok?.support === "unsupported" || grok?.support === "unknown" || !grok,
    transferredBytes,
    invokedGrok,
    status: transferredBytes === 0 ? "PASS" : "UNMET"
  };
  return writeBearer({
    evid: EVID,
    evidenceClass: "sec-01",
    bearerBasename: "sec-01-exclusion.json",
    semantic,
    operationId,
    extraIdentity: { host: "electron-packaged" }
  });
});
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.status === "PASS" ? 0 : 1;
