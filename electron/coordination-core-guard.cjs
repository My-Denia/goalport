"use strict";
const { randomUUID } = require("node:crypto");
function coreRefusal(snapshot) {
  if (!snapshot || !snapshot.bounds || snapshot.bounds.projectionUnavailable === true || snapshot.bounds.projection_unavailable === true || snapshot.bounds.truncated === true) return "Core control progress is unavailable or incomplete; no new turn was sent.";
  const holds = [snapshot.stopResponsibility ?? snapshot.stop_responsibility, ...(snapshot.relatedHolds ?? snapshot.related_holds ?? [])].filter(Boolean);
  if (holds.some(hold => String(hold.writeResponsibility ?? hold.write_responsibility).toLowerCase() === "held")) return "Native work still holds responsibility; no new turn was sent.";
  if (["active", "uncertain"].includes(String(snapshot.attempt?.state).toLowerCase()) || ["starting", "active", "running", "stopping", "uncertain"].includes(String(snapshot.productConversation?.turn?.state).toLowerCase())) return "Native work is active or unconfirmed; no new turn was sent.";
  return null;
}
async function readProjection(core, messageType, payload, field) {
  const requestId = `background-coverage-${randomUUID()}`;
  const response = await core.exchangeVerified({ protocolVersion: "goalport.ipc.v2", requestId, entityVersion: 0, messageType, payload });
  if (!response || response.ok === false || response.requestId !== requestId || response.payload?.requestId !== requestId || response.payload?.accepted !== true || !response.payload[field]) throw new Error("Core coverage could not be confirmed; no new turn was sent.");
  return response.payload[field];
}
// The selected snapshot is NOT a profile inventory. Existing read-only shell
// and scoped-detail projections establish coverage without changing selection.
// No Core start/recovery, launch or responsibility-changing command is sent.
async function guardCoreCoverage(core, selectedSnapshot) {
  const problem = coreRefusal(selectedSnapshot);
  if (problem) throw new Error(problem);
  const overview = await readProjection(core, "goal_overview", {}, "overview");
  if (overview.truncated !== false || !Array.isArray(overview.goals) || !Array.isArray(overview.pending)) throw new Error("Core goal inventory is incomplete; no new turn was sent.");
  const seen = new Set();
  for (const goal of overview.goals) {
    if (!goal || typeof goal.campaignId !== "string" || !goal.campaignId || seen.has(goal.campaignId)) throw new Error("Core goal inventory could not be confirmed; no new turn was sent.");
    seen.add(goal.campaignId);
    if (["running", "awaiting_approval", "needs_recovery"].includes(goal.attention)) throw new Error("Other native work is active or needs recovery; no new turn was sent.");
    const detail = await readProjection(core, "goal_detail", { campaignId: goal.campaignId }, "snapshot");
    if (detail.activeCampaignId !== goal.campaignId) throw new Error("Core goal detail identity could not be confirmed; no new turn was sent.");
    const refusal = coreRefusal(detail);
    if (refusal) throw new Error(refusal);
  }
  if (overview.pending.length) throw new Error("Native permission work remains outstanding; no new turn was sent.");
}
module.exports = { coreRefusal, guardCoreCoverage };
