import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureCore, exchange, pipeNameFor, uiRequest, unwrap } from "./ipc-client.mjs";
import { handoffCorePass, packagedHandoffGuiPass } from "./strict-predicates.mjs";
import { EVID, EVID_REL, assertIsolatedEnv } from "./v1-isolated-env.mjs";
import { writeBearer } from "./v1-closure-rawrun.mjs";
assertIsolatedEnv();

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const argv = process.argv.slice(2);
const value = (name, fallback) => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : fallback; };
const selectionPath = resolve(ROOT, value("--selection-report", `${EVID_REL}/second-runtime-selection.json`));
const reportPath = resolve(ROOT, value("--report", `${EVID_REL}/handoff.json`));
const guiEvidencePathArg = value("--gui-evidence", undefined);
const guiEvidencePath = guiEvidencePathArg ? resolve(ROOT, guiEvidencePathArg) : null;
const existingCoreReportPathArg = value("--core-report", undefined);
const existingCoreReportPath = existingCoreReportPathArg ? resolve(ROOT, existingCoreReportPathArg) : null;
const primary = value("--primary", "codex");
const hosts = value("--hosts", "electron").split(",").map((host) => host.trim()).filter(Boolean);
const pipe = value("--pipe", process.env.GOALPORT_CORE_PIPE || pipeNameFor("handoff"));
const db = value("--db", process.env.GOALPORT_CORE_DB || `${EVID_REL}/handoff-${process.pid}.sqlite`);
const core = value("--core", "target/release/goalport-core.exe");
const launcher = value("--launcher", "target/release/goalport-core-launcher.exe");
const timeoutMs = Number(value("--timeout", "1200")) * 1000;
const _op = value("--operation-id", ""); if (!_op || _op.startsWith("-")) { console.error("missing --operation-id"); process.exit(2); } const operationId = _op;
const expectedMarker = value("--expected-marker", "GOALPORT_HANDOFF_OK");
const instructionFile = value("--instruction-file", undefined);
const handoffInstruction = instructionFile
  ? readFileSync(resolve(ROOT, instructionFile), "utf8").trim()
  : "Read the Core generated handoff packet and reply exactly GOALPORT_HANDOFF_OK without modifying files.";
const keepAlive = setInterval(() => {}, 1_000);

function sha256File(path) {
  try { return createHash("sha256").update(readFileSync(path)).digest("hex"); } catch { return null; }
}

function readJson(path) {
  if (!path) return null;
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function guiEvidenceValidation(guiEvidence, oldAttemptId, newAttemptId, secondSessionHash) {
  const expectedHosts = new Set(hosts);
  const valid = packagedHandoffGuiPass({ evidence: guiEvidence, hosts: [...expectedHosts], operationId, oldAttemptId, newAttemptId, newSessionHash: secondSessionHash });
  return {
    supplied: Boolean(guiEvidencePath),
    path: guiEvidencePathArg || null,
    sha256: guiEvidencePath ? sha256File(guiEvidencePath) : null,
    valid,
    requiredFields: ["operationId", "oldAttemptId", "newAttemptId", "newSessionHash", "screenshotSha256", "operationSha256", "connected", "nativeResponseObserved", "terminalObserved"]
  };
}

let selection;
try { selection = JSON.parse(readFileSync(selectionPath, "utf8")); } catch (error) { selection = { status: "MISSING", error: String(error.message || error) }; }
const qualified = typeof selection.qualifiedRuntime === "string" ? selection.qualifiedRuntime : null;
let report;

const existingCoreReport = readJson(existingCoreReportPath);
if (qualified && existingCoreReport) {
  const guiEvidence = guiEvidenceValidation(
    readJson(guiEvidencePath),
    existingCoreReport.oldAttemptId,
    existingCoreReport.newAttemptId,
    existingCoreReport.newSessionHash
  );
  const corePredicatesPass = existingCoreReport.operationId === operationId
    && existingCoreReport.qualifiedRuntime === qualified
    && existingCoreReport.coreSha256 === sha256File(resolve(ROOT, core))
    && existingCoreReport.corePredicates
    && Object.values(existingCoreReport.corePredicates).every(Boolean);
  report = {
    ...existingCoreReport,
    status: corePredicatesPass && guiEvidence.valid ? "PASS" : "UNMET",
    guiEvidence,
    coreReport: existingCoreReportPathArg,
    readOnlyVerification: true,
    limitation: corePredicatesPass && guiEvidence.valid
      ? "Core/native and packaged Electron/Tauri GUI evidence are bound to this operation; this does not qualify unsupported second-Runtime permission or resume features."
      : "Existing Core/native or packaged GUI evidence did not satisfy the full handoff predicate."
  };
} else if (qualified) {
  try {
    await ensureCore({ core, launcher, pipe, db, cwd: ROOT, timeoutMs: 10_000 });
    const send = async (id, messageType, payload) => unwrap(await exchange(pipe, uiRequest(id, messageType, payload), Math.max(120_000, timeoutMs)));
    const pollUntilTerminal = async (snapshot, prefix, marker = null, baselineCursor = snapshot.cursor) => {
      const beforeCursor = baselineCursor;
      let current = snapshot;
      const started = performance.now();
      while (performance.now() - started < timeoutMs) {
        const events = current.timeline || [];
        const terminal = events.some((item) => item.cursor > beforeCursor && item.title === "Attempt state updated" && (item.status === "COMMITTED" || item.status === "FAILED"));
        const visibleMarker = marker ? events.some((item) => item.cursor > beforeCursor && item.actor === "Native Runtime" && item.kind === "message" && item.body.includes(marker)) : true;
        if (terminal && visibleMarker) return { snapshot: current, beforeCursor, terminalObserved: terminal, visibleMarker };
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
        current = await send(`${prefix}-poll-${Math.floor(performance.now())}`, "snapshot", {});
      }
      const events = current.timeline || [];
      return {
        snapshot: current,
        beforeCursor,
        terminalObserved: events.some((item) => item.cursor > beforeCursor && item.title === "Attempt state updated" && (item.status === "COMMITTED" || item.status === "FAILED")),
        visibleMarker: marker ? events.some((item) => item.cursor > beforeCursor && item.actor === "Native Runtime" && item.kind === "message" && item.body.includes(marker)) : true
      };
    };

    let snapshot = await send(`${operationId}-snapshot`, "snapshot", {});
    const projectId = snapshot.selectedProjectId || snapshot.project.id;
    snapshot = await send(`${operationId}-primary`, "select_runtime", { projectId, campaignId: snapshot.activeCampaignId, taskId: snapshot.activeTask.id, provider: primary });
    const oldAttemptId = snapshot.attempt.id;
    const oldSessionHash = snapshot.attempt.sessionHash || null;
    snapshot = await send(`${operationId}-primary-send`, "send_message", {
      campaignId: snapshot.activeCampaignId,
      taskId: snapshot.activeTask.id,
      attemptId: oldAttemptId,
      message: "Read .goalport/native-marker.txt without modifying files, then reply exactly GOALPORT_PRIMARY_OK."
    });
    const primaryResult = await pollUntilTerminal(snapshot, `${operationId}-primary`);
    snapshot = primaryResult.snapshot;
    if (!primaryResult.terminalObserved) throw new Error("primary Runtime did not reach a terminal state before handoff");

    snapshot = await send(`${operationId}-handoff`, "handoff", {
      oldAttemptId,
      provider: qualified,
      authorization: "goalport-stable-v1-closure:handoff",
      authorizationManifest: `${EVID_REL}/locks/shared-interface-freeze.json`,
      handoffInstruction
    });
    const newAttemptId = snapshot.attempt.id;
    // Attempt cursors are scoped to the newly created Attempt.  The handoff
    // command may synchronously complete a one-shot Runtime before returning,
    // so start the second poll at cursor zero rather than dropping events that
    // were already committed in the handoff response.
    const handoffCursor = 0;
    const packetObserved = (snapshot.timeline || []).some((item) => item.kind === "handoff" && item.body === "Core handoff packet committed");
    const instructionObserved = (snapshot.timeline || []).some((item) => item.kind === "message" && item.body.includes("Handoff instruction"));
    const secondResult = await pollUntilTerminal(snapshot, `${operationId}-second`, expectedMarker, 0);
    snapshot = secondResult.snapshot;
    const secondTimeline = snapshot.timeline || [];
    const newSessionHash = snapshot.attempt.id === newAttemptId ? snapshot.attempt.sessionHash || null : null;
    const sessionBound = secondTimeline.some((item) => item.cursor > handoffCursor && item.details?.some((detail) => detail.startsWith("Provider session hash ")));
    const distinctNativeSession = Boolean(oldSessionHash && newSessionHash && oldSessionHash !== newSessionHash && sessionBound);
    const distinctAttempt = newAttemptId !== oldAttemptId && snapshot.attempt.id === newAttemptId;
    const nativeResponseObserved = secondResult.visibleMarker;
    const terminalObserved = secondResult.terminalObserved;
    const corePredicates = { distinctAttempt, distinctNativeSession, nativeResponseObserved, terminalObserved, packetObserved, instructionObserved, primaryTerminalObserved: primaryResult.terminalObserved, noManualCopy: true };
    const guiEvidence = guiEvidenceValidation(readJson(guiEvidencePath), oldAttemptId, newAttemptId, newSessionHash);
    const corePass = handoffCorePass(corePredicates);
    report = {
      schemaVersion: 2,
      kind: "core-constructed-runtime-handoff",
      operationId,
      status: corePass && guiEvidence.valid ? "PASS" : corePass ? "REQUIRES_PACKAGED_GUI_EVIDENCE" : "UNMET",
      qualifiedRuntime: qualified,
      primaryRuntime: primary,
      hosts,
      pipe: "[run-owned named pipe]",
      db: "[run-owned sqlite]",
      coreArtifact: core.replaceAll("\\", "/"),
      coreSha256: sha256File(resolve(ROOT, core)),
      oldAttemptId,
      newAttemptId,
      oldSessionHash,
      newSessionHash,
      distinctNativeAttempt: distinctAttempt,
      distinctNativeSession,
      nativeResponseObserved,
      terminalObserved,
      handoffCursor,
      corePredicates,
      expectedMarker,
      handoffInstructionSha256: createHash("sha256").update(handoffInstruction).digest("hex"),
      guiEvidence,
      manualCopy: false,
      oldResponsibility: "reconciled by Core before new Attempt",
      limitation: guiEvidence.valid ? "Packaged GUI evidence supplied for the listed hosts; independent audit remains a separate acceptance concern." : "Core/native evidence is present, but packaged Electron/Tauri GUI operation and independent-context audit hashes are still required for PASS."
    };
  } catch (error) {
    report = { schemaVersion: 2, kind: "core-constructed-runtime-handoff", operationId, status: "UNMET", qualifiedRuntime: qualified, manualCopy: false, guiEvidence: { supplied: Boolean(guiEvidencePath), path: guiEvidencePathArg || null, valid: false }, error: String(error.message || error) };
  }
} else {
  report = {
    schemaVersion: 2,
    kind: "core-constructed-runtime-handoff",
    operationId,
    status: "BLOCKED_NO_QUALIFIED_SECOND_RUNTIME",
    qualifiedRuntime: null,
    selectionStatus: selection.status,
    manualCopy: false,
    guiEvidence: { supplied: Boolean(guiEvidencePath), path: guiEvidencePathArg || null, valid: false },
    limitation: "No second Runtime is promoted from version or bounded text response."
  };
}

const written = writeBearer({
  evid: EVID,
  evidenceClass: "rou-02",
  bearerBasename: "handoff.json",
  semantic: report,
  operationId,
  extraIdentity: { host: "electron-packaged" }
});
console.log(JSON.stringify(written.report, null, 2));
clearInterval(keepAlive);
process.exitCode = written.report.status === "PASS" ? 0 : 1;
