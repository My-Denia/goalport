import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  FREEZE_SHA,
  LIVE_REQUIRED_KEYS,
  attributeHostChain,
  continueBackgroundFromProductPayload,
  continueReceiptValid,
  evaluateReport as evaluateLiveReport,
  evaluateReportAgainstEvidence,
  hostChainFromSights,
  judgeFollowUp,
  judgePromptReplay,
  pinUniqueCodexChild,
  selectKillTargets,
  sha256Text,
  sameProcessIdentity,
  spawnFreezeCore,
  startupReceiptValid,
  taskkillArgsForPid,
  validateKillTargets,
  verifierEvidenceWitness
} from "./v1-resume-chain.mjs";
import { EVID, FIX_REL, ROOT, RUN_SLUG } from "./v1-isolated-env.mjs";

const helper = resolve(fileURLToPath(new URL("./v1-resume-chain.mjs", import.meta.url)));

function validReport(overrides = {}) {
  const providerSession = "provider-session-1";
  const processEpoch = "runtime-epoch-valid";
  const coreCreated = "/Date(1788307200100)/";
  const runtimeCreated = "/Date(1788307200800)/";
  const followUpTextSha = "9".repeat(64);
  const reconnectWhileActive = {
    atUtc: "2026-09-02T00:00:10.000Z",
    attempt: { id: "a1", state: "active" },
    campaignId: "c1",
    taskId: "t1",
    connection: "connected"
  };
  const originalStepTerminal = { atUtc: "2026-09-02T00:05:00.000Z", attempt: { id: "a1", state: "waiting" } };
  return {
    host: "electron-packaged",
    exeSha256: FREEZE_SHA.exe,
    coreSha256: FREEZE_SHA.core,
    asarSha256: FREEZE_SHA.asar,
    campaignId: "c1",
    taskId: "t1",
    attemptId: "a1",
    providerSessionHash: sha256Text(providerSession),
    runtimeProcessEpoch: processEpoch,
    runtimeBinding: {
      attemptId: "a1",
      campaignId: "c1",
      taskId: "t1",
      provider: "codex",
      sessionHash: sha256Text(providerSession),
      processEpoch,
      runtimePid: 60,
      runtimeCreationDate: runtimeCreated,
      runtimeExecutablePath: "C:\\codex.exe",
      runtimeExecutableSha256: "8".repeat(64),
      coreEpochId: "core-epoch:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
    },
    originalPromptSha256: "d".repeat(64),
    userEntry: "gui-cdp",
    closeOrKill: "graceful",
    attemptStateAtAction: "active",
    hostExited: true,
    coreAlive: true,
    nativeAlive: true,
    uiExitUtc: "2026-09-02T00:00:05.000Z",
    absenceEvents: [{ atUtc: "2026-09-02T00:00:08.000Z", kind: "runtime.tool.activity", id: "e1", attemptId: "a1" }],
    reopenAttemptId: "a1",
    originalPromptUserMessageCount: 1,
    promptReplay: false,
    promptReplayObserved: true,
    continueClick: true,
    dialogGone: true,
    allowQuitLatch: true,
    closeSurface: "renderer-dialog",
    reconnectWhileActive,
    originalStepTerminal,
    followUp: {
      status: "PASS",
      sent: true,
      nativeTurnHash: "n1",
      originalTurnHash: "n0",
      followUpUser: true,
      sameAttemptTurn: true,
      nonce: "N1",
      guiSendAtUtc: "2026-09-02T00:06:00.000Z",
      userAtUtc: "2026-09-02T00:06:00.100Z",
      turnStartedAtUtc: "2026-09-02T00:06:00.200Z",
      replyAtUtc: "2026-09-02T00:06:00.300Z",
      textSha256: followUpTextSha,
      followUpUserId: "follow-user",
      nativeTurnId: "follow-turn",
      replyId: "follow-reply"
      ,processEpoch
    },
    corePrespawn: false,
    coreRespawn: false,
    coreBefore: { pid: 50, parentPid: 20, name: "goalport-core.exe", executablePath: "C:\\\\pkg\\\\resources\\\\goalport-core.exe", commandLine: '"C:\\\\pkg\\\\resources\\\\goalport-core.exe" serve --pipe goalport-resume-chain-collect-b-obs-graceful --db C:\\\\evid\\\\obs-b-graceful.sqlite', creationDate: coreCreated },
    coreAfter: { pid: 50, parentPid: 20, name: "goalport-core.exe", executablePath: "C:\\\\pkg\\\\resources\\\\goalport-core.exe", commandLine: '"C:\\\\pkg\\\\resources\\\\goalport-core.exe" serve --pipe goalport-resume-chain-collect-b-obs-graceful --db C:\\\\evid\\\\obs-b-graceful.sqlite', creationDate: coreCreated },
    coreAtReopen: { pid: 50, parentPid: 20, name: "goalport-core.exe", executablePath: "C:\\\\pkg\\\\resources\\\\goalport-core.exe", commandLine: '"C:\\\\pkg\\\\resources\\\\goalport-core.exe" serve --pipe goalport-resume-chain-collect-b-obs-graceful --db C:\\\\evid\\\\obs-b-graceful.sqlite', creationDate: coreCreated },
    runtimeBefore: { pid: 60, parentPid: 50, name: "codex.exe", executablePath: "C:\\codex.exe", executableSha256: "8".repeat(64), creationDate: runtimeCreated },
    runtimeAfter: { pid: 60, parentPid: 50, name: "codex.exe", executablePath: "C:\\codex.exe", executableSha256: "8".repeat(64), creationDate: runtimeCreated },
    launchedGoalPortPids: [10],
    closeMainWindowPids: [],
    spawnFreezeCoreCalled: false,
    pipePreexisting: false,
    attemptCountAtSubmit: 1,
    attemptCountAtUiExit: 1,
    attemptCountAtReopen: 1,
    attemptCountAfterFollowUp: 1,
    attemptIdAtSubmit: "a1",
    attemptIdAtUiExit: "a1",
    attemptIdAtReopen: "a1",
    attemptIdAfterFollowUp: "a1",
    attemptCountUnchanged: true,
    closeDialogShownAtUtc: "2026-09-02T00:00:04.000Z",
    continueClickIssuedAtUtc: "2026-09-02T00:00:04.100Z",
    continueReceiptAtUtc: "2026-09-02T00:00:04.200Z",
    continueReceiptPayload: "continue-background",
    continueReceiptRaw: {
      ok: true,
      requestId: "req-1",
      receiptId: "rcpt-1",
      choice: "continue",
      allowQuitLatch: true,
      coreAcknowledged: true
    },
    continueReceiptCore: {
      kind: "close-choice",
      requestId: "req-1",
      receiptId: "rcpt-1",
      choice: "continue-background",
      attemptId: "a1",
      uiPid: 10,
      mainReceivedAtUtc: "2026-09-02T00:00:04.150Z",
      coreReceiptPersistedAtUtc: "2026-09-02T00:00:04.180Z",
      recordedAtUtc: "2026-09-02T00:00:04.180Z"
    },
    continueReceiptId: "rcpt-1",
    launchNonce: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    runSlug: "goalport-resume-chain-collect-b",
    pipeBare: "goalport-resume-chain-collect-b-obs-graceful",
    dbPath: "C:\\\\evid\\\\obs-b-graceful.sqlite",
    startupReceipts: [{
      kind: "startup",
      launchNonce: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      runSlug: "goalport-resume-chain-collect-b",
      pipe: "goalport-resume-chain-collect-b-obs-graceful",
      database: "C:\\\\evid\\\\obs-b-graceful.sqlite",
      electron: {
        pid: 10,
        createdMs: 1000,
        creationDate: "g1",
        executablePath: "C:\\\\pkg\\\\GoalPort.exe",
        executableSha256: "e".repeat(64)
      },
      launcher: {
        pid: 20,
        parentPid: 10,
        observedParentPid: 10,
        createdMs: 1100,
        creationDate: "l1",
        executablePath: "C:\\\\pkg\\\\resources\\\\goalport-core-launcher.exe",
        executableSha256: "f".repeat(64)
      },
      core: {
        pid: 50,
        parentPid: 20,
        observedParentPid: 20,
        createdMs: 1788307200100,
        creationDate: coreCreated,
        executablePath: "C:\\\\pkg\\\\resources\\\\goalport-core.exe",
        executableSha256: FREEZE_SHA.core
      },
      coreEpochId: "core-epoch:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      startupReceiptId: "startup:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      launchReadyReceiptId: "ready:core-epoch:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      startupState: "READY_COMMITTED",
      epochState: "READY_COMMITTED",
      reconciliation: { status: "completed", runtimeAttachment: "UNKNOWN_OR_UNSUPPORTED", promptReplay: false },
      timestamps: {
        launchRequestedAtUtc: "2026-09-02T00:00:00.000Z",
        launcherStartedAtUtc: "2026-09-02T00:00:00.010Z",
        coreSpawnedAtUtc: "2026-09-02T00:00:00.020Z",
        coreReadyAtUtc: "2026-09-02T00:00:00.300Z",
        receiptPersistedAtUtc: "2026-09-02T00:00:00.400Z",
        launchReadyAtUtc: "2026-09-02T00:00:00.500Z"
      }
    }],
    startupReceipt: {
      kind: "startup",
      launchNonce: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      runSlug: "goalport-resume-chain-collect-b",
      pipe: "goalport-resume-chain-collect-b-obs-graceful",
      database: "C:\\\\evid\\\\obs-b-graceful.sqlite",
      electron: {
        pid: 10,
        createdMs: 1000,
        creationDate: "g1",
        executablePath: "C:\\\\pkg\\\\GoalPort.exe",
        executableSha256: "e".repeat(64)
      },
      launcher: {
        pid: 20,
        parentPid: 10,
        observedParentPid: 10,
        createdMs: 1100,
        creationDate: "l1",
        executablePath: "C:\\\\pkg\\\\resources\\\\goalport-core-launcher.exe",
        executableSha256: "f".repeat(64)
      },
      core: {
        pid: 50,
        parentPid: 20,
        observedParentPid: 20,
        createdMs: 1788307200100,
        creationDate: coreCreated,
        executablePath: "C:\\\\pkg\\\\resources\\\\goalport-core.exe",
        executableSha256: FREEZE_SHA.core
      },
      coreEpochId: "core-epoch:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      startupReceiptId: "startup:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      launchReadyReceiptId: "ready:core-epoch:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      startupState: "READY_COMMITTED",
      epochState: "READY_COMMITTED",
      reconciliation: { status: "completed", runtimeAttachment: "UNKNOWN_OR_UNSUPPORTED", promptReplay: false },
      timestamps: {
        launchRequestedAtUtc: "2026-09-02T00:00:00.000Z",
        launcherStartedAtUtc: "2026-09-02T00:00:00.010Z",
        coreSpawnedAtUtc: "2026-09-02T00:00:00.020Z",
        coreReadyAtUtc: "2026-09-02T00:00:00.300Z",
        receiptPersistedAtUtc: "2026-09-02T00:00:00.400Z",
        launchReadyAtUtc: "2026-09-02T00:00:00.500Z"
      }
    },
    targetUiPid: 10,
    hostExitedAtUtc: "2026-09-02T00:00:05.000Z",
    dialogPresented: true,
    hostChain: {
      unattributable: false,
      inferredLauncher: false,
      goalPort: {
        pid: 10,
        parentPid: 1,
        creationDate: "g1",
        firstSeenAtUtc: "2026-09-02T00:00:00.000Z",
        firstSightLive: true,
        executablePath: "C:\\\\pkg\\\\GoalPort.exe"
      },
      launcher: {
        pid: 20,
        parentPid: 10,
        creationDate: "l1",
        firstSeenAtUtc: "2026-09-02T00:00:00.050Z",
        firstSightLive: true,
        inferred: false,
        name: "goalport-core-launcher.exe",
        executablePath: "C:\\\\pkg\\\\resources\\\\goalport-core-launcher.exe"
      },
      core: {
        pid: 50,
        parentPid: 20,
        creationDate: "/Date(1200)/",
        firstSeenAtUtc: "2026-09-02T00:00:00.100Z",
        executablePath: "C:\\\\pkg\\\\resources\\\\goalport-core.exe"
      }
    },
    steps: [{ message: "follow-up-send", nonce: "N1", atUtc: "2026-09-02T00:06:00.000Z", guiSendAtUtc: "2026-09-02T00:06:00.000Z" }],
    launchReadyReceipt: {
      kind: "launch-ready",
      readyReceiptId: "ready:core-epoch:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      startupReceiptId: "startup:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      readyState: "READY_COMMITTED",
      launchNonce: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      coreEpochId: "core-epoch:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      runSlug: "goalport-resume-chain-collect-b",
      pipeIdentity: "goalport-resume-chain-collect-b-obs-graceful",
      databaseIdentity: "C:\\\\evid\\\\obs-b-graceful.sqlite",
      launcher: {
        pid: 20, creationDate: "l1", executablePath: "C:\\\\pkg\\\\resources\\\\goalport-core-launcher.exe", executableSha256: FREEZE_SHA.launcher
      },
      core: {
        pid: 50, creationDate: coreCreated, executablePath: "C:\\\\pkg\\\\resources\\\\goalport-core.exe", executableSha256: FREEZE_SHA.core
      },
      timestamps: {
        coreCreatedAt: coreCreated,
        launchRequestedAtUtc: "2026-09-02T00:00:00.000Z",
        launcherStartedAtUtc: "2026-09-02T00:00:00.010Z",
        coreSpawnedAtUtc: "2026-09-02T00:00:00.020Z",
        startupReceiptPersistedAtUtc: "2026-09-02T00:00:00.400Z",
        readyAtUtc: "2026-09-02T00:00:00.500Z"
      }
    },
    runStartedAtUtc: "2026-09-02T00:00:00.000Z",
    runFinishedAtUtc: "2026-09-02T00:07:00.000Z",
    taskSubmittedAtUtc: "2026-09-02T00:00:01.000Z",
    driverOutcome: { status: "completed", finishedAtUtc: "2026-09-02T00:07:00.000Z", errorType: null },
    ...overrides
  };
}

function validVerifierEvidence(overrides = {}) {
  const report = validReport();
  const boundPayload = (atUtc, extra = {}) => JSON.stringify({
    ...extra,
    goalportRuntime: {
      campaignId: report.runtimeBinding.campaignId,
      taskId: report.runtimeBinding.taskId,
      attemptId: report.runtimeBinding.attemptId,
      provider: report.runtimeBinding.provider,
      providerSessionHash: report.runtimeBinding.sessionHash,
      processEpoch: report.runtimeBinding.processEpoch,
      runtimePid: report.runtimeBinding.runtimePid,
      runtimeCreationDate: report.runtimeBinding.runtimeCreationDate,
      runtimeExecutablePath: report.runtimeBinding.runtimeExecutablePath,
      runtimeExecutableSha256: report.runtimeBinding.runtimeExecutableSha256,
      coreEpochId: report.runtimeBinding.coreEpochId,
      occurredAtEpochMs: atUtc,
      receivedAtEpochMs: atUtc
    }
  });
  const events = [
    { id: "original-user", kind: "message.user", atUtc: "2026-09-02T00:00:01.000Z", atMs: Date.parse("2026-09-02T00:00:01.000Z"), payload_ref: report.originalPromptSha256, payload_json: boundPayload("2026-09-02T00:00:01.000Z"), attemptId: "a1", attempt_id: "a1", seq: 1 },
    { id: "runtime-session", kind: "runtime.session.created", atUtc: "2026-09-02T00:00:02.000Z", atMs: Date.parse("2026-09-02T00:00:02.000Z"), payload_json: boundPayload("2026-09-02T00:00:02.000Z"), attemptId: "a1", attempt_id: "a1", seq: 2 },
    { id: "e1", kind: "runtime.tool.activity", atUtc: "2026-09-02T00:00:08.000Z", atMs: Date.parse("2026-09-02T00:00:08.000Z"), payload_json: boundPayload("2026-09-02T00:00:08.000Z"), attemptId: "a1", attempt_id: "a1", seq: 3 },
    { id: "reconnect", kind: "ui.reconnected", atUtc: "2026-09-02T00:00:09.000Z", atMs: Date.parse("2026-09-02T00:00:09.000Z"), payload_json: JSON.stringify({ promptReplay: false }), attemptId: "a1", attempt_id: "a1", seq: 4 },
    { id: "original-terminal", kind: "runtime.turn.completed", atUtc: "2026-09-02T00:04:59.000Z", atMs: Date.parse("2026-09-02T00:04:59.000Z"), payload_json: boundPayload("2026-09-02T00:04:59.000Z"), stateAfter: "AWAITING_REVIEW", attemptId: "a1", attempt_id: "a1", seq: 5 },
    { id: "follow-user", kind: "message.user", atUtc: "2026-09-02T00:06:00.100Z", atMs: Date.parse("2026-09-02T00:06:00.100Z"), payload_ref: report.followUp.textSha256, payload_json: boundPayload("2026-09-02T00:06:00.100Z"), attemptId: "a1", attempt_id: "a1", seq: 6 },
    { id: "follow-turn", kind: "runtime.turn.started", atUtc: "2026-09-02T00:06:00.200Z", atMs: Date.parse("2026-09-02T00:06:00.200Z"), payload_json: boundPayload("2026-09-02T00:06:00.200Z"), attemptId: "a1", attempt_id: "a1", seq: 7 },
    { id: "follow-reply", kind: "runtime.reply.delta", atUtc: "2026-09-02T00:06:00.300Z", atMs: Date.parse("2026-09-02T00:06:00.300Z"), payload_json: boundPayload("2026-09-02T00:06:00.300Z"), attemptId: "a1", attempt_id: "a1", seq: 8 }
  ];
  return {
    source: "live-os-and-sqlite",
    collectedAtUtc: "2026-09-02T00:07:00.000Z",
    errors: [],
    core: { ...report.coreBefore, name: "goalport-core.exe" },
    coreFileSha256: FREEZE_SHA.core,
    launcherFileSha256: FREEZE_SHA.launcher,
    runtimes: [{ ...report.runtimeBefore }],
    launchReadyFile: {
      path: `${report.dbPath}.launch-ready`,
      bytes: 1024,
      modifiedAtUtc: "2026-09-02T00:00:00.600Z",
      value: structuredClone(report.launchReadyReceipt)
    },
    database: {
      dbPath: report.dbPath,
      attempts: [{ id: "a1", taskId: "t1", campaignId: "c1", provider: "codex", providerSession: "provider-session-1", state: "ACTIVE" }],
      recovery: [{ attemptId: "a1", provider: "codex", sessionHash: report.providerSessionHash, processEpoch: report.runtimeProcessEpoch, pid: 60, promptReplay: 0 }],
      runtimeBindings: [structuredClone(report.runtimeBinding)],
      events,
      startupReceipts: [{ id: "startup:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", launchNonce: report.launchNonce, payload: structuredClone(report.startupReceipt) }],
      launchReadyReceipts: [{ id: "launch-ready:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", launchNonce: report.launchNonce, receiptId: report.launchReadyReceipt.readyReceiptId, payload: structuredClone(report.launchReadyReceipt) }],
      coreEpochs: [{
        epochId: report.startupReceipt.coreEpochId,
        launchNonce: report.launchNonce,
        corePid: 50,
        coreCreationDate: report.coreBefore.creationDate,
        coreExecutablePath: report.coreBefore.executablePath,
        coreExecutableSha256: FREEZE_SHA.core,
        state: "READY_COMMITTED",
        activatedAt: "2026-09-02T00:00:00.500Z",
        reconciliationJson: JSON.stringify({ status: "completed" })
      }]
    },
    ...overrides
  };
}

function evaluateReport(report, options = {}) {
  const { evidence = validVerifierEvidence(), ...rest } = options;
  return evaluateReportAgainstEvidence(report, { ...rest, evidence });
}

test("schema rejects pipe send_message user-entry as UNMET", () => {
  const judged = evaluateReport(validReport({ userEntry: "core-ipc" }));
  assert.equal(judged.status, "UNMET");
  assert.ok(judged.reasons.some((reason) => /userEntry/i.test(reason)));
});

test("missing required live key is UNMET never PASS", () => {
  const report = validReport();
  delete report.absenceEvents;
  const judged = evaluateReport(report);
  assert.equal(judged.status, "UNMET");
  assert.ok(judged.reasons.some((reason) => /absenceEvents/.test(reason)));
  for (const key of LIVE_REQUIRED_KEYS) {
    const missing = validReport();
    delete missing[key];
    assert.equal(evaluateReport(missing).status, "UNMET", key);
  }
});

test("complete gui-cdp report can PASS", () => {
  const report = validReport();
  const evidence = validVerifierEvidence();
  const judged = evaluateReport(report, { evidence });
  assert.equal(judged.status, "PASS", judged.reasons.join(","));
});

test("heartbeat kind is not absence proof", () => {
  const judged = evaluateReport(validReport({
    absenceEvents: [{ atUtc: "2026-09-02T00:00:08.000Z", kind: "runtime.heartbeat", id: "h1" }]
  }));
  assert.equal(judged.status, "UNMET");
});

test("missing exe exits 2", () => {
  const missing = resolve(EVID, "missing-package/GoalPort.exe");
  const result = spawnSync(process.execPath, [helper, "--mode", "graceful", "--exe", missing], {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      GOALPORT_REQUIRE_ISOLATED: "1",
      GOALPORT_CORE_PIPE: `\\\\.\\pipe\\${RUN_SLUG}-missing-exe`,
      GOALPORT_CORE_DB: resolve(EVID, "missing-exe.sqlite"),
      GOALPORT_SYNTHETIC_ROOT: resolve(ROOT, FIX_REL)
    }
  });
  assert.equal(result.status, 2);
  assert.match(`${result.stderr}${result.stdout}`, /missing|packaged Electron missing/i);
});

test("kill list refuses core and requires GoalPort.exe at package path", () => {
  const exe = "C:\\\\pkg\\\\GoalPort.exe";
  const errors = validateKillTargets([
    { ProcessId: 1, Name: "goalport-core.exe", ExecutablePath: "C:\\\\pkg\\\\resources\\\\goalport-core.exe", CommandLine: "serve" }
  ], exe);
  assert.ok(errors.length > 0);
  const ok = validateKillTargets([
    { ProcessId: 2, Name: "GoalPort.exe", ExecutablePath: exe, CommandLine: exe }
  ], exe);
  assert.deepEqual(ok, []);
});

test("taskkill args never include /T", () => {
  const args = taskkillArgsForPid(1234);
  assert.deepEqual(args, ["/F", "/PID", "1234"]);
  assert.ok(!args.includes("/T"));
});

test("issued confirmCloseChoice without returned payload is fabricated UNMET", () => {
  const judged = evaluateReport(validReport({
    continueClick: false,
    dialogGone: false,
    confirmCloseChoice: null,
    confirmCloseChoiceIssued: true,
    dialogPresented: true,
    allowQuitLatch: true,
    hostExited: true,
    continueReceiptPayload: null,
    continueReceiptRaw: null,
    continueReceiptAtUtc: null
  }));
  assert.equal(judged.status, "UNMET");
  assert.ok(judged.reasons.some((reason) => /fabricated-latch|continue-receipt/i.test(reason)));
});

test("confirmCloseChoice returned allowQuitLatch payload is observed", () => {
  const judged = evaluateReport(validReport({
    continueClick: false,
    dialogGone: false,
    confirmCloseChoice: {
      ok: true,
      requestId: "req-1",
      receiptId: "rcpt-1",
      choice: "continue",
      allowQuitLatch: true,
      coreAcknowledged: true
    },
    allowQuitLatch: true,
    hostExited: true
  }));
  assert.equal(judged.status, "PASS", judged.reasons.join(","));
});

test("Continue mouse then host exit without product receipt is UNMET", () => {
  const judged = evaluateReport(validReport({
    continueClick: false,
    dialogGone: false,
    confirmCloseChoice: null,
    allowQuitLatch: true,
    hostExited: true,
    dialogPresented: true,
    continueMouse: { label: "Continue in background", x: 1, y: 1 },
    continueReceiptPayload: null,
    continueReceiptRaw: null,
    continueReceiptAtUtc: null,
    continueClickIssuedAtUtc: null
  }));
  assert.equal(judged.status, "UNMET");
  assert.ok(judged.reasons.some((reason) => /continue-receipt/.test(reason)));
});

test("fabricated allowQuitLatch without observed continue is UNMET", () => {
  const judged = evaluateReport(validReport({
    continueClick: undefined,
    dialogGone: undefined,
    confirmCloseChoice: undefined,
    allowQuitLatch: true,
    continueReceiptPayload: null,
    continueReceiptRaw: null,
    continueReceiptAtUtc: null,
    continueClickIssuedAtUtc: null
  }));
  assert.equal(judged.status, "UNMET");
  assert.ok(judged.reasons.some((reason) => /fabricated-latch|continue-receipt/i.test(reason)));
});

test("missing ui.reconnected makes promptReplay unobserved UNMET", () => {
  const judged = evaluateReport(validReport({ promptReplay: false, promptReplayObserved: false }));
  assert.equal(judged.status, "UNMET");
  assert.ok(judged.reasons.some((reason) => /promptReplay-unobserved/i.test(reason)));
  const replay = judgePromptReplay([], "a1");
  assert.equal(replay.promptReplayObserved, false);
  assert.equal(replay.promptReplay, null);
});

test("absence events from another attempt are UNMET", () => {
  const judged = evaluateReport(validReport({
    absenceEvents: [{ atUtc: "2026-09-02T00:00:08.000Z", kind: "runtime.tool.activity", id: "e1", attemptId: "other-attempt" }]
  }));
  assert.equal(judged.status, "UNMET");
  assert.ok(judged.reasons.some((reason) => /absenceEvents/.test(reason)));
});

test("absence without uiExitUtc is UNMET", () => {
  const judged = evaluateReport(validReport({ uiExitUtc: undefined }));
  assert.equal(judged.status, "UNMET");
  assert.ok(judged.reasons.some((reason) => /uiExitUtc|absenceEvents/.test(reason)));
});

test("originalTurnHash must not be sha256 of the attempt id", () => {
  const judged = evaluateReport(validReport({
    followUp: {
      status: "PASS",
      sent: true,
      nativeTurnHash: "n1",
      originalTurnHash: sha256Text("a1"),
      followUpUser: true,
      sameAttemptTurn: true
    }
  }));
  assert.equal(judged.status, "UNMET");
  assert.ok(judged.reasons.some((reason) => /originalTurnHash-is-attempt-id/.test(reason)));
});

test("follow-up requires same-attempt turn after follow-up user", () => {
  const judged = evaluateReport(validReport({
    followUp: { status: "PASS", sent: true, nativeTurnHash: "n1", originalTurnHash: sha256Text("a1"), followUpUser: false, sameAttemptTurn: false }
  }));
  assert.equal(judged.status, "UNMET");
  const events = [
    { id: "u1", kind: "message.user", attempt_id: "a1", atUtc: "2026-09-02T00:06:00.000Z", payload_json: JSON.stringify({ text: "follow" }) },
    { id: "t-old", kind: "runtime.turn.started", attempt_id: "a1", atUtc: "2026-09-02T00:00:01.000Z" },
    { id: "t-other", kind: "runtime.turn.started", attempt_id: "other", atUtc: "2026-09-02T00:06:01.000Z" }
  ];
  const miss = judgeFollowUp({ events, attemptId: "a1", followUpTextSha: sha256Text("follow"), beforeTurnIds: ["t-old"] });
  assert.equal(miss.status, "UNMET");
  const ok = judgeFollowUp({
    events: [
      ...events,
      { id: "t-new", kind: "runtime.turn.started", attempt_id: "a1", atUtc: "2026-09-02T00:06:02.000Z" },
      { id: "r-new", kind: "runtime.reply.delta", attempt_id: "a1", atUtc: "2026-09-02T00:06:03.000Z" }
    ],
    attemptId: "a1",
    followUpTextSha: sha256Text("follow"),
    beforeTurnIds: ["t-old"]
  });
  assert.equal(ok.status, "PASS");
  assert.equal(ok.sameAttemptTurn, true);
  assert.equal(ok.nativeTurnId, "t-new");
  assert.equal(ok.replyId, "r-new");
});

test("kill selector ignores GoalPort at same path outside launched tree", () => {
  const exe = "C:\\\\pkg\\\\GoalPort.exe";
  const processes = [
    { ProcessId: 10, ParentProcessId: 1, Name: "GoalPort.exe", ExecutablePath: exe },
    { ProcessId: 11, ParentProcessId: 10, Name: "GoalPort.exe", ExecutablePath: exe },
    { ProcessId: 99, ParentProcessId: 2, Name: "GoalPort.exe", ExecutablePath: exe }
  ];
  const targets = selectKillTargets({ launchedPids: [10], processes, exePath: exe });
  assert.deepEqual(targets.map((row) => Number(row.ProcessId)).sort(), [10, 11]);
  const errors = validateKillTargets([
    { ProcessId: 99, Name: "GoalPort.exe", ExecutablePath: exe, ParentProcessId: 2 }
  ], exe, { launchedPids: [10], allProcesses: processes });
  assert.ok(errors.some((item) => /unlaunched:99/.test(item)));
});

test("omitted corePrespawn is UNMET not PASS", () => {
  const report = validReport();
  delete report.corePrespawn;
  const judged = evaluateReport(report);
  assert.equal(judged.status, "UNMET");
  assert.ok(judged.reasons.some((reason) => /corePrespawn|missing key corePrespawn/.test(reason)));
});

test("corePrespawn true is UNMET", () => {
  const judged = evaluateReport(validReport({ corePrespawn: true }));
  assert.equal(judged.status, "UNMET");
  assert.ok(judged.reasons.includes("corePrespawn"));
});

test("core respawn pid or creationDate change is UNMET", () => {
  const judged = evaluateReport(validReport({
    coreAfter: { pid: 51, parentPid: 10, executablePath: "C:\\\\pkg\\\\goalport-core.exe", creationDate: "c1" }
  }));
  assert.equal(judged.status, "UNMET");
  assert.ok(judged.reasons.includes("core-identity"));
});

test("runtime parent must be recorded Core", () => {
  const judged = evaluateReport(validReport({
    runtimeBefore: { pid: 60, parentPid: 99, name: "codex.exe", executablePath: "C:\\\\codex.exe", creationDate: "r1" }
  }));
  assert.equal(judged.status, "UNMET");
  assert.ok(judged.reasons.includes("runtime-parent-not-core"));
});

test("pinUniqueCodexChild is unique-or-fail", () => {
  const processes = [
    { ProcessId: 60, ParentProcessId: 50, Name: "codex.exe" },
    { ProcessId: 61, ParentProcessId: 1, Name: "codex.exe" }
  ];
  assert.equal(pinUniqueCodexChild(processes, 50).count, 1);
  assert.equal(pinUniqueCodexChild(processes, 2).count, 0);
  assert.equal(pinUniqueCodexChild([
    { ProcessId: 60, ParentProcessId: 50, Name: "codex.exe" },
    { ProcessId: 61, ParentProcessId: 50, Name: "codex.exe" }
  ], 50).count, 2);
});

test("follow-up user before guiSendAtUtc is UNMET", () => {
  const judged = evaluateReport(validReport({
    followUp: {
      status: "PASS",
      sent: true,
      nativeTurnHash: "n1",
      originalTurnHash: "n0",
      followUpUser: true,
      sameAttemptTurn: true,
      nonce: "N1",
      guiSendAtUtc: "2026-09-02T00:06:00.000Z",
      userAtUtc: "2026-09-02T00:05:59.000Z",
      turnStartedAtUtc: "2026-09-02T00:06:01.000Z"
    }
  }));
  assert.equal(judged.status, "UNMET");
  assert.ok(judged.reasons.includes("followUp.user-before-send"));
});

test("CloseMainWindow unlaunched pid is UNMET", () => {
  const judged = evaluateReport(validReport({
    closeOrKill: "graceful",
    closeMainWindowPids: [99]
  }));
  assert.equal(judged.status, "UNMET");
  assert.ok(judged.reasons.some((reason) => /close-unlaunched:99/.test(reason)));
});

test("sameProcessIdentity requires pid and creationDate", () => {
  assert.equal(sameProcessIdentity({ pid: 1, creationDate: "a" }, { pid: 1, creationDate: "a" }), true);
  assert.equal(sameProcessIdentity({ pid: 1, creationDate: "a" }, { pid: 1, creationDate: "b" }), false);
  assert.equal(sameProcessIdentity({ pid: 1 }, { pid: 1, creationDate: "a" }), false);
});

test("absence without attemptId does not count", () => {
  const judged = evaluateReport(validReport({
    absenceEvents: [{ atUtc: "2026-09-02T00:00:08.000Z", kind: "runtime.reply.delta", id: "e1" }]
  }));
  assert.equal(judged.status, "UNMET");
});

test("omitted hostChain unattributable is UNMET not PASS", () => {
  const report = validReport();
  delete report.hostChain;
  const judged = evaluateReport(report);
  assert.equal(judged.status, "UNMET");
  assert.ok(judged.reasons.some((reason) => /hostChain|core-unattributable/.test(reason)));
});

test("product Continue receipt chain can PASS", () => {
  const judged = evaluateReport(validReport({
    continueClick: true,
    dialogGone: false,
    confirmCloseChoice: {
      ok: true,
      requestId: "req-1",
      receiptId: "rcpt-1",
      choice: "continue",
      allowQuitLatch: true,
      coreAcknowledged: true
    },
    allowQuitLatch: true,
    hostExited: true,
    dialogPresented: true,
    continueMouse: null
  }));
  assert.equal(judged.status, "PASS", judged.reasons.join(","));
});

test("requireFreeze live report uses product startup receipt not WMI launcher", () => {
  const judged = evaluateReport(validReport({
    exeSha256: FREEZE_SHA.exe,
    coreSha256: FREEZE_SHA.core,
    asarSha256: FREEZE_SHA.asar,
    hostChain: {
      unattributable: false,
      inferredLauncher: false,
      reason: "product-startup-receipt",
      goalPort: { pid: 10, creationDate: "g1", firstSightLive: true, firstSeenAtUtc: "t", executablePath: "C:\\\\pkg\\\\GoalPort.exe" },
      launcher: null,
      core: { pid: 50, creationDate: "c1", parentPid: 20, executablePath: "C:\\\\pkg\\\\resources\\\\goalport-core.exe" }
    }
  }), { requireFreeze: true });
  assert.equal(judged.status, "PASS", judged.reasons.join(","));
  const noReceipt = evaluateReport(validReport({
    exeSha256: FREEZE_SHA.exe,
    coreSha256: FREEZE_SHA.core,
    asarSha256: FREEZE_SHA.asar,
    startupReceipt: null
  }), { requireFreeze: true });
  assert.equal(noReceipt.status, "UNMET");
  assert.ok(noReceipt.reasons.some((reason) => /startup-receipt/.test(reason)));
});

test("attributeHostChain does not infer a dead launcher parent", () => {
  const exe = "C:\\\\pkg\\\\GoalPort.exe";
  const corePath = "C:\\\\pkg\\\\resources\\\\goalport-core.exe";
  const launcherPath = "C:\\\\pkg\\\\resources\\\\goalport-core-launcher.exe";
  const pipe = "goalport-electron-rc-resume-chain-collect-b-graceful";
  const db = "C:\\\\evid\\\\collect-b-graceful.sqlite";
  const processes = [
    {
      ProcessId: 10,
      ParentProcessId: 1,
      Name: "GoalPort.exe",
      ExecutablePath: exe,
      CommandLine: exe,
      CreationDate: "/Date(1000)/"
    },
    {
      ProcessId: 50,
      ParentProcessId: 40,
      Name: "goalport-core.exe",
      ExecutablePath: corePath,
      CommandLine: `"${corePath}" serve --pipe \\\\.\\pipe\\${pipe} --db ${db}`,
      CreationDate: "/Date(1100)/"
    }
  ];
  const result = attributeHostChain({
    processes,
    launchedRootPids: [10],
    exePath: exe,
    freezeCorePath: corePath,
    freezeLauncherPath: launcherPath,
    pipeBare: pipe,
    dbPath: db
  });
  assert.equal(result.unattributable, true);
  assert.notEqual(result.reason, "inferred-exited-launcher");
});

test("attributeHostChain rejects live node parent", () => {
  const exe = "C:\\\\pkg\\\\GoalPort.exe";
  const corePath = "C:\\\\pkg\\\\resources\\\\goalport-core.exe";
  const pipe = "goalport-electron-rc-resume-chain-collect-b-graceful";
  const db = "C:\\\\evid\\\\collect-b-graceful.sqlite";
  const processes = [
    {
      ProcessId: 10,
      ParentProcessId: 1,
      Name: "GoalPort.exe",
      ExecutablePath: exe,
      CommandLine: exe,
      CreationDate: "/Date(1000)/"
    },
    {
      ProcessId: 2,
      ParentProcessId: 0,
      Name: "node.exe",
      ExecutablePath: "C:\\\\node.exe",
      CommandLine: "node",
      CreationDate: "/Date(1)/"
    },
    {
      ProcessId: 50,
      ParentProcessId: 2,
      Name: "goalport-core.exe",
      ExecutablePath: corePath,
      CommandLine: `"${corePath}" serve --pipe \\\\.\\pipe\\${pipe} --db ${db}`,
      CreationDate: "/Date(1100)/"
    }
  ];
  const result = attributeHostChain({
    processes,
    launchedRootPids: [10],
    exePath: exe,
    freezeCorePath: corePath,
    freezeLauncherPath: "C:\\\\pkg\\\\resources\\\\goalport-core-launcher.exe",
    pipeBare: pipe,
    dbPath: db
  });
  assert.equal(result.unattributable, true);
  assert.ok(/launcher-not-live|harness-parent/.test(result.reason));
});

test("attributeHostChain rejects Core sibling of GoalPort", () => {
  const exe = "C:\\\\pkg\\\\GoalPort.exe";
  const corePath = "C:\\\\pkg\\\\resources\\\\goalport-core.exe";
  const pipe = "goalport-electron-rc-resume-chain-collect-b-graceful";
  const db = "C:\\\\evid\\\\collect-b-graceful.sqlite";
  const processes = [
    {
      ProcessId: 10,
      ParentProcessId: 1,
      Name: "GoalPort.exe",
      ExecutablePath: exe,
      CommandLine: exe,
      CreationDate: "/Date(1000)/"
    },
    {
      ProcessId: 50,
      ParentProcessId: 1,
      Name: "goalport-core.exe",
      ExecutablePath: corePath,
      CommandLine: `"${corePath}" serve --pipe \\\\.\\pipe\\${pipe} --db ${db}`,
      CreationDate: "/Date(1100)/"
    }
  ];
  const result = attributeHostChain({
    processes,
    launchedRootPids: [10],
    exePath: exe,
    freezeCorePath: corePath,
    freezeLauncherPath: "C:\\\\pkg\\\\resources\\\\goalport-core-launcher.exe",
    pipeBare: pipe,
    dbPath: db
  });
  assert.equal(result.unattributable, true);
  assert.ok(/launcher-not-live|core-sibling/.test(result.reason));
});

test("spawnFreezeCore is forbidden", () => {
  assert.throws(() => spawnFreezeCore(), /forbidden/);
});

test("inferred launcher in report is UNMET", () => {
  const judged = evaluateReport(validReport({
    hostChain: {
      unattributable: false,
      inferredLauncher: true,
      goalPort: validReport().hostChain.goalPort,
      launcher: { ...validReport().hostChain.launcher, inferred: true, firstSightLive: false },
      core: validReport().hostChain.core
    }
  }));
  assert.equal(judged.status, "UNMET");
  assert.ok(judged.reasons.some((reason) => /launcher-inferred|launcher-not-live/.test(reason)));
});

test("attemptCount not 1 is UNMET", () => {
  const judged = evaluateReport(validReport({ attemptCountAfterFollowUp: 2 }));
  assert.equal(judged.status, "UNMET");
  assert.ok(judged.reasons.includes("attemptCount"));
});

test("attemptId change is UNMET", () => {
  const judged = evaluateReport(validReport({ attemptIdAfterFollowUp: "a2" }));
  assert.equal(judged.status, "UNMET");
  assert.ok(judged.reasons.includes("attemptId-continuity"));
});

test("omitted attemptCountAtUiExit is UNMET", () => {
  const report = validReport();
  delete report.attemptCountAtUiExit;
  assert.equal(evaluateReport(report).status, "UNMET");
});

test("continueReceiptPayload without product raw choice continue is UNMET", () => {
  const judged = evaluateReport(validReport({
    continueReceiptPayload: "continue-background",
    continueReceiptRaw: { ok: true, allowQuitLatch: true, choice: "stop", coreAcknowledged: true, receiptId: "rcpt-1", requestId: "req-1" }
  }));
  assert.equal(judged.status, "UNMET");
  assert.ok(judged.reasons.some((reason) => /continue-receipt/.test(reason)));
});

test("hostExitedAtUtc before continueReceiptAtUtc is UNMET", () => {
  const judged = evaluateReport(validReport({
    continueReceiptAtUtc: "2026-09-02T00:00:05.000Z",
    hostExitedAtUtc: "2026-09-02T00:00:04.900Z"
  }));
  assert.equal(judged.status, "UNMET");
  assert.ok(judged.reasons.some((reason) => /continue-receipt/.test(reason)));
});

test("spawnFreezeCoreCalled omitted is UNMET", () => {
  const report = validReport();
  delete report.spawnFreezeCoreCalled;
  assert.equal(evaluateReport(report).status, "UNMET");
});

test("live launcher chain is attributable", () => {
  const judged = hostChainFromSights({
    goalPort: {
      pid: 10,
      parentPid: 1,
      creationDate: "/Date(1000)/",
      firstSeenAtUtc: "t0",
      firstSightLive: true,
      executablePath: "C:\\\\pkg\\\\GoalPort.exe"
    },
    launcher: {
      pid: 20,
      parentPid: 10,
      creationDate: "/Date(1100)/",
      firstSeenAtUtc: "t1",
      firstSightLive: true,
      inferred: false,
      name: "goalport-core-launcher.exe",
      executablePath: "C:\\\\pkg\\\\resources\\\\goalport-core-launcher.exe"
    },
    core: {
      pid: 50,
      parentPid: 20,
      creationDate: "/Date(1200)/",
      executablePath: "C:\\\\pkg\\\\resources\\\\goalport-core.exe"
    }
  }, {
    exePath: "C:\\\\pkg\\\\GoalPort.exe",
    freezeLauncherPath: "C:\\\\pkg\\\\resources\\\\goalport-core-launcher.exe",
    freezeCorePath: "C:\\\\pkg\\\\resources\\\\goalport-core.exe"
  });
  assert.equal(judged.unattributable, false, judged.reason);
  assert.equal(judged.inferredLauncher, false);
});

test("continueBackgroundFromProductPayload requires choice continue", () => {
  assert.equal(continueBackgroundFromProductPayload({
    ok: true, allowQuitLatch: true, coreAcknowledged: true, choice: "continue", receiptId: "r1", requestId: "q1"
  }), true);
  assert.equal(continueBackgroundFromProductPayload({
    ok: true, allowQuitLatch: true, coreAcknowledged: true, choice: "stop", receiptId: "r1", requestId: "q1"
  }), false);
  assert.equal(continueBackgroundFromProductPayload({ allowQuitLatch: true, choice: "continue" }), false);
});

test("missing Core continue receipt is UNMET even if latch is set", () => {
  const judged = evaluateReport(validReport({
    continueReceiptCore: null,
    allowQuitLatch: true
  }));
  assert.equal(judged.status, "UNMET");
  assert.ok(judged.reasons.some((reason) => /continue-receipt/.test(reason)));
});

test("CDP-missing renderer return can PASS when Core receipt is present", () => {
  const judged = evaluateReport(validReport({
    continueReceiptRaw: null,
    continueReceiptAtUtc: null
  }));
  assert.equal(judged.status, "PASS", judged.reasons.join(","));
});

test("startup receipt nonce mismatch is UNMET", () => {
  const judged = evaluateReport(validReport({ launchNonce: "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee" }));
  assert.equal(judged.status, "UNMET");
  assert.ok(judged.reasons.some((reason) => /startup-receipt/.test(reason)));
});

test("second startup receipt is UNMET", () => {
  const extra = {
    ...validReport().startupReceipt,
    launchNonce: "cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    core: { ...validReport().startupReceipt.core, pid: 99 }
  };
  const judged = evaluateReport(validReport({
    startupReceipts: [validReport().startupReceipt, extra]
  }));
  assert.equal(judged.status, "UNMET");
  assert.ok(judged.reasons.some((reason) => /startup-receipt-second/.test(reason)));
});

test("startupReceiptValid and continueReceiptValid helpers fail closed", () => {
  assert.equal(startupReceiptValid(validReport()).ok, true);
  assert.equal(startupReceiptValid(validReport({ startupReceipt: null })).ok, false);
  assert.equal(continueReceiptValid(validReport()).ok, true);
  assert.equal(continueReceiptValid(validReport({ continueReceiptCore: null })).ok, false);
});

test("finish error, timeout, abort, and incomplete outcomes are always UNMET", () => {
  for (const report of [
    validReport({ error: "late exception" }),
    validReport({ timedOut: true }),
    validReport({ aborted: true }),
    validReport({ incomplete: true }),
    validReport({ driverOutcome: { status: "error", finishedAtUtc: "2026-09-02T00:07:00.000Z" } })
  ]) {
    const judged = evaluateReport(report);
    assert.equal(judged.status, "UNMET");
    assert.ok(judged.reasons.some((reason) => /driver-|sqlite-error/.test(reason)));
  }
});

test("reconnect and terminal values, identities, and order are semantic gates", () => {
  const invalid = [
    validReport({ reconnectWhileActive: { ...validReport().reconnectWhileActive, attempt: { id: "a1", state: "waiting" } } }),
    validReport({ reconnectWhileActive: { ...validReport().reconnectWhileActive, campaignId: "other" } }),
    validReport({ reconnectWhileActive: { ...validReport().reconnectWhileActive, connection: "disconnected" } }),
    validReport({ originalStepTerminal: { atUtc: "2026-09-02T00:05:00.000Z", attempt: { id: "a1", state: "active" } } }),
    validReport({ originalStepTerminal: { atUtc: "2026-09-01T23:00:00.000Z", attempt: { id: "a1", state: "waiting" } } })
  ];
  for (const report of invalid) assert.equal(evaluateReport(report).status, "UNMET");
});

test("live Core identity and exact observed executable hash cannot be replaced by report claims", () => {
  const changedPath = validReport();
  changedPath.coreBefore.executablePath = "C:\\Windows\\System32\\notepad.exe";
  changedPath.coreAfter.executablePath = changedPath.coreBefore.executablePath;
  changedPath.coreAtReopen.executablePath = changedPath.coreBefore.executablePath;
  assert.equal(evaluateReport(changedPath).status, "UNMET");

  assert.equal(evaluateReport(validReport(), {
    requireFreeze: true,
    evidence: validVerifierEvidence({ coreFileSha256: "0".repeat(64) })
  }).status, "UNMET");
  assert.equal(evaluateReport(validReport(), {
    evidence: validVerifierEvidence({ core: { ...validReport().coreBefore, creationDate: "/Date(999)/" } })
  }).status, "UNMET");
  assert.equal(evaluateReport(validReport(), {
    evidence: validVerifierEvidence({ core: null, errors: ["live Core PID observation count=0"] })
  }).status, "UNMET");
});

test("Runtime, provider session, process epoch, and Attempt are bound to SQLite", () => {
  assert.equal(evaluateReport(validReport({ providerSessionHash: "f".repeat(64) })).status, "UNMET");
  const noEpoch = validVerifierEvidence();
  noEpoch.database.recovery[0].processEpoch = "";
  assert.equal(evaluateReport(validReport(), { evidence: noEpoch }).status, "UNMET");
  const wrongPid = validVerifierEvidence();
  wrongPid.database.recovery[0].pid = 61;
  assert.equal(evaluateReport(validReport(), { evidence: wrongPid }).status, "UNMET");
  const extraAttempt = validVerifierEvidence();
  extraAttempt.database.attempts.push({ ...extraAttempt.database.attempts[0], id: "a2" });
  assert.equal(evaluateReport(validReport(), { evidence: extraAttempt }).status, "UNMET");
});

test("random, old-run, and another-Attempt runtime epochs are rejected", () => {
  for (const badEpoch of ["random-nonempty", "runtime-epoch-from-old-run"]) {
    const report = validReport({ runtimeProcessEpoch: badEpoch });
    report.runtimeBinding.processEpoch = badEpoch;
    report.followUp.processEpoch = badEpoch;
    assert.equal(evaluateReport(report).status, "UNMET");
  }

  const anotherAttempt = validVerifierEvidence();
  anotherAttempt.database.runtimeBindings.push({
    ...structuredClone(anotherAttempt.database.runtimeBindings[0]),
    attemptId: "a2",
    processEpoch: "runtime-epoch-other-attempt"
  });
  assert.equal(evaluateReport(validReport(), { evidence: anotherAttempt }).status, "UNMET");

  const changedAfterExit = validVerifierEvidence();
  const absence = changedAfterExit.database.events.find((row) => row.id === "e1");
  const payload = JSON.parse(absence.payload_json);
  payload.goalportRuntime.processEpoch = "runtime-epoch-old-or-other";
  absence.payload_json = JSON.stringify(payload);
  assert.equal(evaluateReport(validReport(), { evidence: changedAfterExit }).status, "UNMET");
});

test("causal timestamps fail closed on invalid, zero, out-of-run, and reversed values", () => {
  const reports = [
    validReport({ uiExitUtc: "not-a-timestamp" }),
    validReport({ runStartedAtUtc: "0" }),
    validReport({ taskSubmittedAtUtc: "2026-09-01T23:59:59.999Z" }),
    validReport({ followUp: { ...validReport().followUp, turnStartedAtUtc: "2026-09-02T00:05:59.900Z" } }),
    validReport({ runFinishedAtUtc: "NaN", driverOutcome: { status: "completed", finishedAtUtc: "NaN", errorType: null } })
  ];
  for (const report of reports) assert.equal(evaluateReport(report).status, "UNMET");

  const invalidEvent = validVerifierEvidence();
  invalidEvent.database.events.find((row) => row.id === "e1").atUtc = "2026-09-02 00:00:08Z";
  assert.equal(evaluateReport(validReport(), { evidence: invalidEvent }).status, "UNMET");

  const invalidRuntimeCreation = validVerifierEvidence();
  invalidRuntimeCreation.database.runtimeBindings[0].runtimeCreationDate = "/Date(0)/";
  assert.equal(evaluateReport(validReport(), { evidence: invalidRuntimeCreation }).status, "UNMET");
});

test("launch-ready rejects stale identity, epoch replay, duplicates, and incomplete state", () => {
  const cases = [];
  const staleNonce = validVerifierEvidence();
  staleNonce.launchReadyFile.value.launchNonce = "stale-nonce";
  cases.push(staleNonce);
  const stalePid = validVerifierEvidence();
  stalePid.database.launchReadyReceipts[0].payload.core.pid = 99999;
  cases.push(stalePid);
  const stalePath = validVerifierEvidence();
  stalePath.launchReadyFile.value.core.executablePath = "C:\\stale\\goalport-core.exe";
  cases.push(stalePath);
  const staleHash = validVerifierEvidence();
  staleHash.launchReadyFile.value.core.executableSha256 = "0".repeat(64);
  cases.push(staleHash);
  const oldEpoch = validVerifierEvidence();
  oldEpoch.database.launchReadyReceipts[0].payload.coreEpochId = "core-epoch:old";
  cases.push(oldEpoch);
  const pending = validVerifierEvidence();
  pending.launchReadyFile.value.readyState = "STARTUP_PENDING";
  cases.push(pending);
  const duplicate = validVerifierEvidence();
  duplicate.database.launchReadyReceipts.push(structuredClone(duplicate.database.launchReadyReceipts[0]));
  cases.push(duplicate);
  const lateReady = validVerifierEvidence();
  lateReady.launchReadyFile.value.timestamps.readyAtUtc = "2026-09-02T00:08:00.000Z";
  cases.push(lateReady);
  for (const evidence of cases) assert.equal(evaluateReport(validReport(), { evidence }).status, "UNMET");
});

test("follow-up requires persisted GUI send, user, turn, and reply in order", () => {
  const noReply = validVerifierEvidence();
  noReply.database.events = noReply.database.events.filter((row) => row.kind !== "runtime.reply.delta");
  assert.equal(evaluateReport(validReport(), { evidence: noReply }).status, "UNMET");
  assert.equal(evaluateReport(validReport({ steps: [] })).status, "UNMET");
  assert.equal(evaluateReport(validReport({
    followUp: { ...validReport().followUp, replyAtUtc: "2026-09-02T00:05:59.000Z" }
  })).status, "UNMET");
});

test("persisted prompt replay and unobserved replay values are UNMET", () => {
  const replay = validVerifierEvidence();
  replay.database.events.find((row) => row.kind === "ui.reconnected").payload_json = JSON.stringify({ promptReplay: true });
  assert.equal(evaluateReport(validReport(), { evidence: replay }).status, "UNMET");
  const absent = validVerifierEvidence();
  absent.database.events.find((row) => row.kind === "ui.reconnected").payload_json = "{}";
  assert.equal(evaluateReport(validReport(), { evidence: absent }).status, "UNMET");
});

test("persisted verifier witness redacts the raw provider session", () => {
  const witness = verifierEvidenceWitness(validVerifierEvidence());
  const text = JSON.stringify(witness);
  assert.doesNotMatch(text, /provider-session-1/);
  assert.equal(
    witness.database.attempts[0].providerSessionHash,
    sha256Text("provider-session-1")
  );
  assert.equal(witness.coreFileSha256, FREEZE_SHA.core);
});
