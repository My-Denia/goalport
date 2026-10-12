"use strict";

const fs = require("node:fs");
const path = require("node:path");

// A harness that provably could not run its tools stays out of automatic
// selection until the evidence is cleared: either the user chooses to use it
// again, or a later turn proves the tools ran. The record is a sidecar next to
// sent-turns.json; every reader and writer fails open, because a damaged
// health note must never change a turn result or break discovery.
const MAX_DETAIL = 300;

function healthFile(stateDir) {
  return path.join(stateDir, "harness-health.json");
}

// Bad JSON or bad entries degrade away; only well-formed records survive.
function normalize(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const instances = parsed.instances;
  if (!instances || typeof instances !== "object" || Array.isArray(instances)) return {};
  const health = {};
  for (const [instanceId, record] of Object.entries(instances)) {
    if (!instanceId || !record || typeof record !== "object") continue;
    const blockedAt = typeof record.blockedAt === "string" ? record.blockedAt : "";
    const detail = typeof record.detail === "string" ? record.detail.slice(0, MAX_DETAIL) : "";
    if (!blockedAt || !detail) continue;
    health[instanceId] = {
      blockedAt,
      detail,
      commandId: typeof record.commandId === "string" ? record.commandId : "",
    };
  }
  return health;
}

function readHealth(stateDir) {
  try {
    return normalize(JSON.parse(fs.readFileSync(healthFile(stateDir), "utf8")));
  } catch {
    return {};
  }
}

// Same tmp-plus-rename pattern as writeLedger: a partial file is never the
// visible one.
function writeHealth(stateDir, instances) {
  fs.mkdirSync(stateDir, { recursive: true });
  const tmp = path.join(stateDir, `.harness-health.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, instances }));
  fs.renameSync(tmp, healthFile(stateDir));
}

function markBlocked(stateDir, instanceId, detail, commandId = "", clock = () => new Date().toISOString()) {
  try {
    if (!stateDir || typeof instanceId !== "string" || !instanceId) return;
    const instances = readHealth(stateDir);
    instances[instanceId] = {
      blockedAt: clock(),
      detail: String(detail ?? "").slice(0, MAX_DETAIL),
      commandId: typeof commandId === "string" ? commandId : "",
    };
    writeHealth(stateDir, instances);
  } catch {
    // A failed health note is a lost note, never a failed turn.
  }
}

function clearBlocked(stateDir, instanceId) {
  try {
    if (!stateDir || typeof instanceId !== "string" || !instanceId) return;
    const instances = readHealth(stateDir);
    if (!(instanceId in instances)) return;
    delete instances[instanceId];
    writeHealth(stateDir, instances);
  } catch {
    // Same isolation: a failed clear never reaches the caller.
  }
}

module.exports = { readHealth, markBlocked, clearBlocked };
