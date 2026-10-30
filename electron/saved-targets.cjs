"use strict";
// Read-only relationship view over ONE raw profile snapshot. No persistence/authority.
const path = require("node:path");
const { isValidContinuationDescriptor } = require("./coordination-continuation.cjs");
const idValid = id => typeof id === "string" && /^[A-Za-z0-9._-]{1,256}$/.test(id);
const workspaceKey = value => typeof value !== "string" || !value.trim() ? null
  : /^[A-Za-z]:[\\/]/.test(value.trim()) ? path.win32.normalize(value.trim()).toLowerCase()
  : path.posix.normalize(value.trim()).replace(/\/$/, "") || "/";
function resolveSavedTargets(raw) {
  const records = Array.isArray(raw) ? raw.filter(x => x && typeof x === "object" && !Array.isArray(x)) : [];
  const index = new Map();
  for (const record of records) {
    const id = record.requestId;
    if (!index.has(id)) index.set(id, []);
    index.get(id).push(record);
  }
  const unique = id => idValid(id) && index.get(id)?.length === 1 ? index.get(id)[0] : null;
  function relation(record) {
    const invalid = reason => ({ relationStatus: "invalid", relationUnavailableReason: reason, rootRequestId: null });
    if (!idValid(record.requestId)) return invalid("The saved result has no usable identity.");
    if (index.get(record.requestId).length !== 1) return { ...invalid("This saved result cannot be identified uniquely."), relationStatus: "ambiguous" };
    if (typeof record.goal !== "string" || !record.goal.trim() || !workspaceKey(record.workspacePath)) return invalid("The saved goal or folder is unavailable.");
    if (record.recordKind === 'native-workspace-check') return invalid('Workspace checks belong to a native goal, not a coordinated root.');
    if (!Object.hasOwn(record, "continuation")) return { relationStatus: "legacy-root", rootRequestId: record.requestId, relationUnavailableReason: null };
    const descriptor = record.continuation;
    if (!isValidContinuationDescriptor(descriptor)) return invalid("The saved goal relationship is unavailable.");
    const root = unique(descriptor.rootRequestId);
    if (!root || root.recordKind === 'native-workspace-check' || Object.hasOwn(root, "continuation") || typeof root.goal !== "string" || !root.goal.trim() || !workspaceKey(root.workspacePath)) return invalid("The original saved goal cannot be identified.");
    const workspace = workspaceKey(record.workspacePath);
    if (descriptor.originalGoal !== root.goal?.trim() || record.goal.trim() !== descriptor.originalGoal || workspaceKey(root.workspacePath) !== workspace) return invalid("The original goal or folder does not match.");
    const visited = new Set();
    let cursor = record;
    for (let step = 0; step <= records.length; step++) {
      if (visited.has(cursor.requestId)) return invalid("The saved goal relationship contains a cycle.");
      visited.add(cursor.requestId);
      if (cursor === root) return { relationStatus: "valid", rootRequestId: root.requestId, continuation: { ...descriptor }, relationUnavailableReason: null };
      const d = cursor.continuation;
      if (cursor.recordKind === 'native-workspace-check' || !Object.hasOwn(cursor, "continuation") || !isValidContinuationDescriptor(d) || d.rootRequestId !== root.requestId || d.originalGoal !== descriptor.originalGoal || (typeof cursor.goal !== "string" || cursor.goal.trim() !== descriptor.originalGoal) || workspaceKey(cursor.workspacePath) !== workspace) return invalid("An earlier result belongs to a different goal or folder.");
      cursor = unique(d.parentRequestId);
      if (!cursor) return invalid("An earlier saved result cannot be identified.");
    }
    return invalid("The saved goal relationship could not be followed.");
  }
  const entries = records.map(record => ({ record, ...relation(record) }));
  function head(rootId) {
    const members = entries.filter(x => x.rootRequestId === rootId);
    if (!members.length) return null;
    const dated = members.filter(x => typeof x.record.savedAt === "string" && x.record.savedAt);
    if (!dated.length) return members.length === 1 ? members[0].record.requestId : null;
    const stamp = dated.map(x => x.record.savedAt).sort().at(-1);
    const latest = dated.filter(x => x.record.savedAt === stamp);
    return latest.length === 1 ? latest[0].record.requestId : null;
  }
  return { entries, unique, head, selected(id) { return entries.find(x => x.record === unique(id)) ?? null; } };
}
module.exports = { resolveSavedTargets, workspaceKey };
