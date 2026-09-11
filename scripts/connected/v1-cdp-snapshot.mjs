import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { EVID } from "./v1-isolated-env.mjs";
import { attachGoalPort, waitFor } from "./v1-cdp.mjs";

const port = Number(process.env.GOALPORT_GUI_PORT || 19222);
const { evaluate, close } = await attachGoalPort(port);
const connectedDom = await waitFor(evaluate, `document.body.innerText.includes('Core connected') || document.body.innerText.includes('GoalPort')`, 10000);
let snapshot = null;
try {
  snapshot = await evaluate("window.goalportCore ? window.goalportCore.snapshot() : null", true);
} catch (error) {
  snapshot = { error: String(error.message || error) };
}
const body = await evaluate("document.body.innerText.slice(0, 1500)");
const report = {
  schemaVersion: 1,
  kind: "electron-connected",
  host: "electron",
  port,
  connectedDom,
  connection: snapshot?.connection,
  reasons: (snapshot?.runtimes || []).flatMap((runtime) => runtime.reasons || []),
  provider: snapshot?.attempt?.provider,
  campaignId: snapshot?.activeCampaignId,
  attemptId: snapshot?.attempt?.id,
  bodyPreview: body,
  status: snapshot?.connection === "connected" ? "PASS" : "UNMET"
};
mkdirSync(EVID, { recursive: true });
writeFileSync(resolve(EVID, "electron-connected.json"), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(resolve(EVID, "electron-clean-start.json"), `${JSON.stringify({
  schemaVersion: 1,
  kind: "electron-clean-start",
  launch: { injectedBuildId: false, port },
  status: report.status
}, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
close();
process.exit(report.status === "PASS" ? 0 : 1);
