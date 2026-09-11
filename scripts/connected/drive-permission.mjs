import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureCore, exchange, pipeNameFor, uiRequest, unwrap } from "./ipc-client.mjs";
import { assertIsolatedEnv } from "./v1-isolated-env.mjs";
assertIsolatedEnv();

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const argv = process.argv.slice(2);
const value = (name, fallback) => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : fallback; };
const has = (name) => argv.includes(name);
const provider = value("--runtime", "codex");
const pipe = value("--pipe", pipeNameFor("permission"));
const db = value("--db", process.env.GOALPORT_CORE_DB || `goal-runs/goalport-stable-v1-closure/evidence/permission-${process.pid}.sqlite`);
const core = value("--core", "target/release/goalport-core.exe");
const launcher = value("--launcher", "target/release/goalport-core-launcher.exe");
const reportPath = resolve(ROOT, value("--report", "goal-runs/goalport-stable-v1-closure/evidence/native-permission-loop.json"));
const keepAlive = setInterval(() => {}, 1_000);

async function send(id, type, payload) {
  return unwrap(await exchange(pipe, uiRequest(id, type, payload), 120_000));
}

try {
  if (!has("--live")) throw new Error("permission loop requires --live");
  await ensureCore({ core, launcher, pipe, db, cwd: ROOT, timeoutMs: 10_000 });
  let snapshot = await send(`permission-snapshot-${process.pid}`, "snapshot", {});
  const projectId = snapshot.selectedProjectId || snapshot.project.id;
  snapshot = await send(`permission-runtime-${process.pid}`, "select_runtime", { projectId, campaignId: snapshot.activeCampaignId, taskId: snapshot.activeTask.id, provider });
  const campaignId = snapshot.activeCampaignId;
  const taskId = snapshot.activeTask.id;
  const attemptId = snapshot.attempt.id;
  const beforeTurnCursor = snapshot.cursor;
  await send(`permission-send-${process.pid}`, "send_message", { campaignId, taskId, attemptId, message: "In the synthetic workspace run cmd /c echo GOALPORT_PERMISSION_OK. Ask for native approval before each command and report the result." });
  const decisions = [];
  const observations = [];
  for (let poll = 0; poll < 240; poll += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    snapshot = await send(`permission-poll-${process.pid}-${poll}`, "snapshot", {});
    observations.push({ atUtc: new Date().toISOString(), cursor: snapshot.cursor, state: snapshot.attempt.state, pending: snapshot.decisions.filter((decision) => decision.state === "pending").length, eventKinds: [...new Set(snapshot.timeline.map((event) => event.kind))] });
    const pending = snapshot.decisions.filter((decision) => decision.state === "pending");
    for (const decision of pending) {
      if (decisions.some((item) => item.id === decision.id)) continue;
      snapshot = await send(`permission-decision-${process.pid}-${decision.id}`, "permission_response", { decisionId: decision.id, allow: false });
      decisions.push({ id: decision.id, decision: "decline", atUtc: new Date().toISOString() });
    }
    const terminal = snapshot.timeline.some((event) => event.cursor > beforeTurnCursor && event.title === "Attempt state updated" && (event.status === "COMMITTED" || event.status === "FAILED"));
    if (decisions.length > 0 && terminal && !snapshot.decisions.some((decision) => decision.state === "pending")) break;
  }
  const terminal = snapshot.timeline.some((event) => event.cursor > beforeTurnCursor && event.title === "Attempt state updated" && (event.status === "COMMITTED" || event.status === "FAILED"));
  const corePath = resolve(ROOT, core);
  const report = { schemaVersion: 1, kind: "native-permission-loop", provider, approvalPolicy: process.env.GOALPORT_CODEX_APPROVAL_POLICY || "unspecified", coreArtifact: core.replaceAll("\\", "/"), coreSha256: createHash("sha256").update(readFileSync(corePath)).digest("hex"), coreBuildId: snapshot.buildId, campaignId, taskId, attemptId, decisions, final: { cursor: snapshot.cursor, attemptState: snapshot.attempt.state, pending: snapshot.decisions.filter((decision) => decision.state === "pending").length, terminal }, observations, status: decisions.length > 0 && snapshot.decisions.every((decision) => decision.state === "resolved") && terminal ? "PASS_CORE_PERMISSION_LOOP" : "UNMET", limitation: "This is explicit Core-driven deny for each observed request; packaged GUI evidence is still required for D/C2." };
  mkdirSync(resolve(reportPath, ".."), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.status === "PASS_CORE_PERMISSION_LOOP" ? 0 : 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  clearInterval(keepAlive);
}
