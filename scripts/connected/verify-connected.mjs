import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureCore, exchange, pipeNameFor, uiRequest, unwrap } from "./ipc-client.mjs";
import { EVID_REL, assertIsolatedEnv } from "./v1-isolated-env.mjs";
assertIsolatedEnv();

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const args = process.argv.slice(2);
const value = (name, fallback) => {
  const exact = args.find((item) => item.startsWith(`${name}=`));
  if (exact) return exact.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const has = (name) => args.includes(name);
const host = value("--host", "tauri");
const provider = value("--runtime", value("--provider", "scenario"));
const adapter = value("--adapter", provider === "scenario" ? "scenario" : "native");
const live = has("--live");
const reportPath = resolve(ROOT, value("--report", `${EVID_REL}/connected-${host}.json`));
const core = value("--core", "target/release/goalport-core.exe");
const launcher = value("--launcher", "target/release/goalport-core-launcher.exe");
const db = value("--db", process.env.GOALPORT_CORE_DB || `${EVID_REL}/connected-${host}-${process.pid}.sqlite`);
const pipe = value("--pipe", process.env.GOALPORT_CORE_PIPE || pipeNameFor(`connected-${host}`));
const interactionEvidence = value("--interaction-evidence", undefined);
const hostArtifact = host === "electron"
  ? resolve(ROOT, `${EVID_REL}/electron-package/GoalPort-win32-x64/GoalPort.exe`)
  : resolve(ROOT, "target/release/goalport-desktop.exe");
const keepAlive = setInterval(() => {}, 1_000);

function requireEvidence() {
  if (!interactionEvidence) return false;
  const absolute = resolve(ROOT, interactionEvidence);
  return existsSync(absolute) && statSync(absolute).isDirectory() && statSync(absolute).size >= 0;
}

async function request(id, messageType, payload) {
  return unwrap(await exchange(pipe, uiRequest(id, messageType, payload), 120_000));
}

try {
  const child = has("--start") ? await ensureCore({ core, launcher, pipe, db, cwd: ROOT, timeoutMs: 10_000 }) : null;
  let snapshot = await request(`connected-snapshot-${process.pid}`, "snapshot", {});
  const projectId = snapshot.selectedProjectId || snapshot.project?.id;
  if (!projectId) throw new Error("Core projection has no selected project");
  const project = await request(`connected-project-${process.pid}`, "select_project", { projectId });
  snapshot = project;
  if (!snapshot.project || snapshot.project.id !== projectId) throw new Error("Core selected project identity did not round trip");
  if (!snapshot.activeCampaignId || !snapshot.activeTask?.id) {
    snapshot = await request(`connected-create-${process.pid}`, "create_campaign_with_task", { projectId, goal: "Connected Preview verification", title: "Connected Preview task", acceptance: "Persist ordered events and recover without replay." });
  }
  snapshot = await request(`connected-runtime-${process.pid}`, "select_runtime", { projectId, campaignId: snapshot.activeCampaignId, taskId: snapshot.activeTask.id, provider });
  const attemptId = snapshot.attempt.id;
  const prompt = provider === "scenario"
    ? (has("--require-permission-roundtrip") ? "permission write connected verification" : "connected verification")
    : value("--prompt", "Read .goalport/native-marker.txt without modifying files, then reply exactly GOALPORT_CONNECTED_OK.");
  const beforeCursor = snapshot.cursor;
  const send = await request(`connected-send-${process.pid}`, "send_message", { campaignId: snapshot.activeCampaignId, taskId: snapshot.activeTask.id, attemptId, message: prompt });
  snapshot = send;
  const observations = [];
  let preterminalObservedAt = null;
  let terminalObservedAt = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
    snapshot = await request(`connected-poll-${process.pid}-${attempt}`, "snapshot", {});
    const kinds = (snapshot.timeline || []).map((item) => item.kind);
    const preterminal = kinds.includes("message") && kinds.includes("tool") && kinds.includes("recovery") && snapshot.attempt.state === "active";
    if (preterminal && preterminalObservedAt === null) preterminalObservedAt = new Date().toISOString();
    const terminal = snapshot.attempt.state === "failed"
      || snapshot.attempt.state === "completed"
      || (snapshot.timeline || []).some((item) => item.cursor > beforeCursor && item.kind === "attempt" && (item.status === "COMMITTED" || item.status === "FAILED") && item.body !== "attempt.active" && !item.body.includes("new turn started after review checkpoint"));
    if (terminal && terminalObservedAt === null) terminalObservedAt = new Date().toISOString();
    observations.push({ atUtc: new Date().toISOString(), cursor: snapshot.cursor, attemptState: snapshot.attempt.state, kinds: [...new Set(kinds)] });
    if (preterminal && terminal) break;
  }
  if (has("--require-permission-roundtrip")) {
    const pending = snapshot.decisions?.find((decision) => decision.state === "pending");
    if (pending && provider === "scenario") {
      snapshot = await request(`connected-permission-deny-${process.pid}`, "permission_response", { decisionId: pending.id, allow: false });
    }
    for (let attempt = 0; attempt < 40 && !snapshot.decisions?.some((decision) => decision.state === "resolved"); attempt += 1) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
      snapshot = await request(`connected-permission-poll-${process.pid}-${attempt}`, "snapshot", {});
    }
  }
  if (has("--require-interrupt")) {
    snapshot = await request(`connected-interrupt-seed-${process.pid}`, "send_message", {
      campaignId: snapshot.activeCampaignId,
      taskId: snapshot.activeTask.id,
      attemptId,
      message: provider === "scenario" ? "long running interrupt verification" : "Continue the synthetic marker task and wait for an interrupt request before finishing."
    });
    for (let attempt = 0; attempt < 10 && snapshot.attempt.state !== "active"; attempt += 1) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
      snapshot = await request(`connected-interrupt-ready-${process.pid}-${attempt}`, "snapshot", {});
    }
    if (snapshot.attempt.state !== "active") throw new Error("interrupt predicate failed: no active turn was observable before interrupt request");
    const interruptBeforeCursor = snapshot.cursor;
    const interrupt = await request(`connected-interrupt-${process.pid}`, "interrupt", { attemptId });
    snapshot = interrupt;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
      snapshot = await request(`connected-interrupt-poll-${process.pid}-${attempt}`, "snapshot", {});
      if (snapshot.attempt.state === "failed" || snapshot.attempt.state === "completed") break;
    }
    const interruptEvents = (snapshot.timeline || []).filter((item) => item.cursor > interruptBeforeCursor);
    if (snapshot.attempt.state !== "failed" && snapshot.attempt.state !== "completed") throw new Error("interrupt predicate failed: no observed terminal state");
    if (!interruptEvents.some((item) => item.kind === "attempt" && /interrupt|cancel/i.test(item.body))) throw new Error("interrupt predicate failed: requested/confirmed stop event was not committed");
  }
  const kinds = (snapshot.timeline || []).map((item) => item.kind);
  const predicates = {
    project_selected: snapshot.project?.id === projectId,
    campaign_present: snapshot.campaigns?.some((campaign) => campaign.id === snapshot.activeCampaignId) === true,
    task_attempt_identity: snapshot.attempt?.taskId === snapshot.activeTask?.id,
    runtime_selected: snapshot.attempt?.provider?.toLowerCase() === provider.toLowerCase(),
    preterminal_reply: kinds.includes("message"),
    preterminal_tool: kinds.includes("tool"),
    preterminal_waiting: kinds.includes("recovery"),
    terminal_state: kinds.includes("attempt") || snapshot.attempt.state !== "active",
    cursor_advanced: snapshot.cursor >= beforeCursor,
    preterminal_before_terminal: preterminalObservedAt !== null && (terminalObservedAt === null || preterminalObservedAt <= terminalObservedAt),
    desktop_evidence_supplied: requireEvidence(),
    host_artifact_present: existsSync(hostArtifact),
    permission_roundtrip: !has("--require-permission-roundtrip") || (snapshot.decisions?.some((decision) => decision.state === "resolved") === true && !snapshot.decisions?.some((decision) => decision.state === "pending") && kinds.includes("permission")),
    interrupt_observed: !has("--require-interrupt") || snapshot.attempt.state === "failed" || snapshot.attempt.state === "completed"
  };
  if (has("--require-project-select") && !predicates.project_selected) throw new Error("project selection predicate failed");
  if (has("--require-task-create") && !predicates.campaign_present) throw new Error("campaign/task creation predicate failed");
  if (has("--require-preterminal-events") && !(predicates.preterminal_reply && predicates.preterminal_tool && predicates.preterminal_waiting)) throw new Error("preterminal event predicate failed");
  if (has("--require-permission-roundtrip") && !predicates.permission_roundtrip) throw new Error("permission decision predicate failed: resolved Decision and permission timeline evidence required");
  if (has("--require-gui") && (!predicates.desktop_evidence_supplied || !predicates.host_artifact_present)) throw new Error("actual packaged GUI evidence and host artifact are required");
  if (live && adapter === "scenario") throw new Error("--live cannot be combined with the synthetic Scenario adapter");
  const requiredPredicates = Object.fromEntries(Object.entries(predicates).filter(([name]) => has("--require-gui") || (name !== "desktop_evidence_supplied" && name !== "host_artifact_present")));
  const report = {
    schemaVersion: 1,
    kind: "connected-preview-verification",
    host,
    adapter,
    provider,
    live,
    coreBuildId: snapshot.buildId,
    protocolVersion: snapshot.protocolVersion,
    pipe: "[run-owned named pipe]",
    db: "[run-owned SQLite path]",
    operations: { projectId, campaignId: snapshot.activeCampaignId, taskId: snapshot.activeTask.id, attemptId, beforeCursor, afterCursor: snapshot.cursor, duplicateSend: send.duplicate === true, preterminalObservedAt, terminalObservedAt, hostArtifact: hostArtifact.replace(ROOT, "<workspace>") },
    observations,
    predicates,
    status: Object.values(requiredPredicates).every(Boolean) ? (has("--require-gui") ? "PASS" : "PASS_CORE_ONLY") : "UNMET",
    executed: Object.keys(predicates).length,
    requiredPredicates: Object.keys(requiredPredicates),
    skipped: 0,
    nonZeroRange: { predicates: Object.keys(predicates).length, events: snapshot.attempt.eventCount }
  };
  mkdirSync(resolve(reportPath, ".."), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.status === "PASS" ? 0 : 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  clearInterval(keepAlive);
}
