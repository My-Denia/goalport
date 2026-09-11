import { requireOperationId, writeBearer } from "./v1-closure-rawrun.mjs";
import { withPackagedGui } from "./v1-closure-gui.mjs";
import { EVID } from "./v1-isolated-env.mjs";
import { waitFor } from "./v1-cdp.mjs";

const operationId = requireOperationId();
const port = Number(process.env.GOALPORT_GUI_PORT || 19245);
const { report } = await withPackagedGui(port, async ({ evaluate }, child) => {
  const connected = await waitFor(evaluate, `document.body.innerText.includes('Core connected')`, 20000);
  const snapshot = await evaluate("window.goalportCore.snapshot()", true);
  const semantic = {
    schemaVersion: 1,
    kind: "electron-connected",
    reasons: (snapshot?.runtimes || []).flatMap((runtime) => runtime.reasons || []),
    provider: snapshot?.attempt?.provider,
    campaignId: snapshot?.activeCampaignId,
    attemptId: snapshot?.attempt?.id,
    injectedBuildId: false,
    connected,
    status: connected && snapshot?.connection === "connected" && ((snapshot?.runtimes || []).flatMap((runtime) => runtime.reasons || []).length > 0) ? "PASS" : "UNMET"
  };
  const written = writeBearer({
    evid: EVID,
    evidenceClass: "rou-01",
    bearerBasename: "electron-connected.json",
    semantic,
    operationId,
    extraIdentity: { host: "electron-packaged", pid: child.pid, port }
  });
  return written;
});
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.status === "PASS" ? 0 : 1;
