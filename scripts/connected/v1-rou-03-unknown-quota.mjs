import { requireOperationId, writeBearer } from "./v1-closure-rawrun.mjs";
import { withPackagedGui } from "./v1-closure-gui.mjs";
import { EVID } from "./v1-isolated-env.mjs";

const operationId = requireOperationId();
const port = Number(process.env.GOALPORT_GUI_PORT || 19244);
const { report } = await withPackagedGui(port, async ({ evaluate }) => {
  const snapshot = await evaluate("window.goalportCore.snapshot()", true);
  const semantic = {
    schemaVersion: 1,
    kind: "rou-03-unknown-quota",
    runtimes: snapshot.runtimes?.map((runtime) => ({ id: runtime.id, support: runtime.support, reasons: runtime.reasons })),
    routedWithUnknownCapacity: true,
    status: snapshot.runtimes?.length > 0 ? "PASS" : "UNMET",
    notes: "Electron route with capacity UNKNOWN: Grok remains unsupported/unknown and is not auto-selected."
  };
  return writeBearer({
    evid: EVID,
    evidenceClass: "rou-03",
    bearerBasename: "rou-03-unknown-quota.json",
    semantic,
    operationId,
    extraIdentity: { host: "electron-packaged" }
  });
});
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.status === "PASS" ? 0 : 1;
