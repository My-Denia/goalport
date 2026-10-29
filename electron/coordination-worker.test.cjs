const { test } = require("node:test");
const { randomUUID } = require("node:crypto");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createCoordinationJobStore } = require("./coordination-job.cjs");
const { launchOne } = require("./coordinate-service.cjs");
const { runWorker, coreRefusal } = require("./coordination-worker.cjs");
const { readRecords } = require("./coordination-record.cjs");
const engine = require("../dist/coordination-engine.cjs");
const providers = [
  { instanceId: "codex", displayName: "Codex", driver: "codex", enabled: true, installed: true, availability: "available", status: "ready", auth: { status: "authenticated", type: "chatgpt" }, models: [{ slug: "gpt-6-astra", isDefault: true }] },
  { instanceId: "claude", displayName: "Claude", driver: "claudeAgent", enabled: true, installed: true, availability: "available", status: "ready", auth: { status: "authenticated", type: "subscription" }, models: [{ slug: "claude-opus-5-5", isDefault: true }] },
];
async function scenario(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-worker-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  delete require.cache[require.resolve("./coordination-scope.cjs")];
  const scope = require("./coordination-scope.cjs");
  let authorizations = 0;
  const scopeAdapter = { ...scope, authorize: (...args) => { authorizations++; return scope.authorize(...args); } };
  const store = createCoordinationJobStore(directory, { bootstrapReady: true });
  const roster = options.providers ?? providers;
  const start = store.startAdmission({ requestId: "one-send", goal: "Repair this fixture", workspacePath: directory, allowedInstances: options.allowedInstances ?? ["codex", "claude"], maxTurns: options.reads ?? 6, ...(options.readOnly ? {} : { writeAuthorization: { instances: options.writeInstances ?? ["codex"], workspaceRoot: directory, maxTurns: 2 } }), ...(options.executionFeedback ? { executionFeedback: options.executionFeedback } : {}), ...(options.continuation ? { continuation: options.continuation } : {}), backgroundConsent: true });
  if (options.storeDecorator) {
    options.store = options.storeDecorator(options.store ?? store, start);
  }
  const launches = [];
  const runtime = { stateDir: path.join(directory, "harness-state"), discover: async () => ({ ok: true, providers: roster }), prepare: async () => ({}), close() {}, run: async command => {
    launches.push(command);
    if (options.onLaunch) options.onLaunch(command, launches.length);
    if (options.revokeAt === launches.length) store.revoke(start.jobId);
    if (options.runtimeRun) return options.runtimeRun(command, runtime.stateDir);
    const n = launches.length;
    const role = command.commandId.split("-")[1];
    const text = role === "review" ? (options.reviewAt?.[n] ?? "Execute this plan.\nVERDICT: carry-out") : role === "audit" ? `Tests checked.\nVERDICT: ${options.secondRevise || n === 4 ? "revise" : "verified"}` : role === "execute" ? "Changed fixture." : "A bounded plan.";
    return options.resultAt === n ? options.result : { ok: true, text, messageDispatched: true };
  } };
  if (options.storageFailure) {
    const complete = store.completeCommand;
    // Frozen store adapter: failure after first known turn leaves durable pending.
    options.store = { ...store, completeCommand: (...args) => { if (launches.length === 1) throw Error("disk full"); return complete(...args); } };
  }
  if (options.preLaunchFailure) options.store = { ...store, updateProgress: (...args) => { if (store.getStatus(start.jobId).pendingCommand) throw Error("pre-launch disk full"); return store.updateProgress(...args); } };
  if (options.stopWinsAdmissionRace) {
    // The durable stop lands between the admission read and its write: the
    // store settles the command as never sent and refuses the launch.
    options.store = { ...store, recordPendingCommand: (jobId) => {
      store.revoke(jobId);
      const error = new Error("Access was stopped; the recorded command was settled as never sent and was not launched.");
      error.code = "access-revoked";
      throw error;
    } };
  }
  let backgroundEngineInputValue;
  let requestCoordinationInputValue;
  const workerEngine = options.captureExecutionFeedback || options.captureRequest ? {
    ...engine,
    backgroundEngineInput: input => { backgroundEngineInputValue = input; return engine.backgroundEngineInput(input); },
    requestCoordination: (...args) => { requestCoordinationInputValue = args[0]; return engine.requestCoordination(...args); },
  } : engine;
  const controlEndpoint = process.platform === "win32" ? String.raw`\\.\pipe\goalport-worker-test-` + randomUUID() : path.join(directory, "control.sock");
  if (options.consentGranted) fs.writeFileSync(path.join(directory, "background-send-consent.json"), JSON.stringify({ allowed: true, grantedAt: new Date().toISOString() }) + "\n");
  if (typeof options.sentinel === "string") fs.writeFileSync(path.join(directory, "sentinel.txt"), options.sentinel);
  const result = await runWorker({ directory, stateDir: runtime.stateDir, jobId: start.jobId, controlEndpoint }, { store: options.store ?? store, engine: workerEngine, scope: scopeAdapter, runtime, core: {
    invoke: async () => options.snapshot ?? ({ bounds: { projectionUnavailable: false }, attempt: { state: "completed" } }),
    exchangeVerified: async request => ({ requestId: request.requestId, ok: true, payload: { requestId: request.requestId, accepted: true,
      ...(request.messageType === "goal_overview" ? { overview: options.overview ?? { truncated: false, goals: [], pending: [] } } : { snapshot: (typeof options.detail === "function" ? options.detail(launches.length, request) : options.detail) ?? { bounds: { projectionUnavailable: false }, activeCampaignId: request.payload.campaignId } }) } }),
  }, discover: async () => ({ ok: true, providers: roster }), env: options.env ?? { GOALPORT_COORDINATE_SEND: "1" }, ...(options.saveFailure ? { saveRecord: () => { throw Error("record failed"); } } : {}) });
  return { result, launches, status: store.getStatus(start.jobId), authorizations, records: readRecords(directory), scope, store, jobId: start.jobId, directory, backgroundEngineInputValue, requestCoordinationInputValue };
}
test("Linux worker derives capability after the closed builder; real stdin facts survive completed or pending command", { skip: process.platform !== "linux" }, async t => {
  const { runCliTurn, defaultSpawn } = require("./cli-coordinate.cjs");
  const pi = { ...providers[1], instanceId: "pi", displayName: "Pi", driver: "pi" };
  for (const unknown of [false, true]) {
    let auditChild;
    let childClosed;
    let actualInput;
    const ran = await scenario(t, {
      providers: [providers[0], pi], allowedInstances: ["codex", "pi"], captureRequest: true,
      runtimeRun: async (command, stateDir) => {
        const role = command.commandId.split("-")[1];
        if (role !== "audit") return { ok: true, messageDispatched: true, text: role === "review" ? "VERDICT: carry-out" : "Bounded plan and report", ...(role === "execute" ? { executionEvidence: { status: "available", complete: true, changed: true, beforeDiff: "before", afterDiff: "+real captured change\n".repeat(420) } } : {}) };
        actualInput = command.initialMessage.text;
        return runCliTurn(command, { stateDir, spawnTurn: spec => defaultSpawn({ ...spec, file: process.execPath,
          args: ["-e", unknown ? "setInterval(()=>{},1000)" : "const b=[];process.stdin.on('data',x=>b.push(x));process.stdin.on('end',()=>process.stdout.write('Read '+Buffer.concat(b).length+' host bytes.\\nVERDICT: verified'))"],
          register(child) {
            auditChild = child;
            childClosed = new Promise(resolve => child.once("close", resolve));
            if (unknown) throw Error("registered real child, then setup failed");
          },
        }) });
      },
    });
    try {
      assert.equal(ran.requestCoordinationInputValue.auditPromptTransport, "linux-pi-stdin");
      assert.equal(Object.hasOwn(ran.backgroundEngineInputValue, "auditPromptTransport"), false);
      assert.equal(Object.hasOwn(engine.backgroundEngineInput(ran.backgroundEngineInputValue), "auditPromptTransport"), false);
      assert.equal(ran.launches.length, 4);
      const inputBytes = Buffer.byteLength(actualInput);
      assert.ok(inputBytes > 8192 && inputBytes <= 32768);
      const facts = unknown ? ran.status.progress.partialResult : ran.status.completedCommands.at(-1).facts;
      assert.deepEqual(facts.auditInputTransport, { instanceId: "pi", promptDelivery: "stdin", inputBytes, inputEnded: !unknown });
      assert.equal(facts.dispatched, unknown ? null : true);
      assert.equal(fs.existsSync(path.join(ran.directory, "harness-state", `claim-${ran.launches[3].commandId}`)), true);
      const grantsFile = path.join(ran.directory, "harness-state", "send-authorization");
      assert.equal(fs.existsSync(grantsFile) && fs.readFileSync(grantsFile, "utf8").includes(ran.launches[3].commandId), false);
      assert.equal(ran.status.counters.readTurnsRemaining, 3);
      if (unknown) {
        assert.equal(ran.status.pendingCommand.commandId, ran.launches[3].commandId);
        assert.equal(ran.status.completedCommands.length, 3);
        assert.throws(() => ran.store.claimWorker(ran.jobId), /no replacement|already|unconfirmed/);
      } else {
        assert.equal(ran.status.pendingCommand, null);
        assert.match(facts.text, new RegExp(`Read ${inputBytes} host bytes`));
        assert.equal(ran.records[0].auditInputEvidenceCoverage.promptDelivery, "stdin");
        assert.equal(ran.records[0].auditInputEvidenceCoverage.cropped, false);
      }
    } finally {
      if (auditChild.exitCode === null && auditChild.signalCode === null) auditChild.kill("SIGKILL");
      await childClosed;
    }
  }
});

test("one confirmed harness with write authorization stops before any workspace write and cannot be replayed", async t => {
  const ran = await scenario(t, {
    providers: [providers[0]],
    allowedInstances: ["codex"],
    writeInstances: ["codex"],
    sentinel: "do-not-touch\n",
  });
  assert.equal(ran.launches.length, 0);
  assert.equal(ran.launches.some((command) => command.sandboxPolicy?.type === "workspaceWrite"), false);
  assert.equal(ran.records[0]?.stopReason, "Stopped. An independent check needs a second logged-in harness, so no second role was assigned.");
  assert.equal(ran.records[0]?.messageDispatched, false);
  assert.equal(ran.status.pendingCommand, null);
  assert.equal(fs.readFileSync(path.join(ran.directory, "sentinel.txt"), "utf8"), "do-not-touch\n");
  assert.throws(() => ran.store.claimWorker(ran.jobId), /no replacement was started/);
});

test("a revocation before the worker claim settles stopped without contacting anything", async t => {
  // Windows-safe: the settlement path returns before the control endpoint,
  // Core, scopes or harnesses are ever touched, so no Unix socket is needed.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-worker-preclaim-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = createCoordinationJobStore(directory, { bootstrapReady: true });
  const admitted = store.startAdmission({ requestId: "pre-claim-stop", goal: "Stopped before starting", workspacePath: directory,
    allowedInstances: ["codex"], maxTurns: 4, backgroundConsent: true });
  store.revoke(admitted.jobId);
  const touched = [];
  const result = await runWorker({ directory, stateDir: path.join(directory, "unused-state"), jobId: admitted.jobId,
    controlEndpoint: path.join(directory, "never-bound.sock") }, {
    store,
    engine: { backgroundEngineInput: input => input, requestCoordination: async () => { touched.push("engine"); throw Error("must not run"); } },
    scope: { revoke: () => touched.push("scope"), current: () => ({ remaining: 4 }) },
    runtime: { stateDir: directory, discover: async () => { touched.push("runtime"); throw Error("must not run"); }, prepare: async () => { touched.push("runtime"); }, run: async () => { touched.push("launch"); throw Error("must not launch"); }, close() { touched.push("runtime-close"); } },
    core: { invoke: async () => { touched.push("core"); throw Error("must not call core"); }, exchangeVerified: async () => { touched.push("core"); throw Error("must not call core"); } },
    discover: async () => { touched.push("discover"); throw Error("must not discover"); },
    env: { GOALPORT_COORDINATE_SEND: "1" },
    saveRecord: () => { touched.push("save"); throw Error("must not save"); },
  });
  assert.deepEqual(touched, []);
  assert.equal(result.status, "stopped");
  assert.equal(result.settledPreStartRevocation, true);
  const status = store.getStatus(admitted.jobId);
  assert.equal(status.state, "stopped");
  assert.equal(status.active, false);
  assert.equal(status.revoked, true);
  assert.equal(status.outcome.reason, "revoked-before-start");
  assert.equal(fs.existsSync(path.join(directory, "coordination-jobs", "active-admission.json")), false);
  assert.deepEqual(readRecords(directory), []);
});
test("same engine completes two chains with one authorization, dual budgets and first pass", async t => {
  const r = await scenario(t);
  assert.equal(r.result.status, "completed"); assert.equal(r.launches.length, 8); assert.equal(r.authorizations, 1);
  assert.equal(new Set(r.launches.map(c => c.commandId)).size, 8);
  assert.deepEqual(r.status.counters, { readTurnsRemaining: 0, writeTurnsRemaining: 0 });
  assert.equal(r.records[0].verdict, "verified"); assert.equal(r.records[0].feedbackHistory.length, 1);
  assert.equal(r.status.active, false); assert.equal(r.scope.current(), null);
  assert.equal("authorizedTurnsLeft" in r.records[0], false);
});
test("second revise never runs a third chain", async t => { const r = await scenario(t, { secondRevise: true }); assert.equal(r.launches.length, 8); assert.match(r.result.report.stopReason, /one automatic repair/); });
test("default four reads do not reconstruct repair budget", async t => { const r = await scenario(t, { reads: 4 }); assert.equal(r.launches.length, 4); assert.equal(r.status.counters.readTurnsRemaining, 1); assert.match(r.result.report.stopReason, /not enough access/); });
test("read-only consent never admits a writer", async t => { const r = await scenario(t, { readOnly: true }); assert.equal(r.launches.length, 2); assert.ok(r.launches.every(c => c.sandboxPolicy.type === "readOnly")); });
test("revocation settles current turn but refuses every subsequent launch", async t => { const r = await scenario(t, { revokeAt: 2 }); assert.equal(r.launches.length, 2); assert.equal(r.status.revoked, true); assert.equal(r.status.completedCommands.length, 2); assert.equal(r.records[0].messageDispatched, true); });
test("a stop winning the admission race never launches and settles a releasable outcome", async t => {
  const r = await scenario(t, { stopWinsAdmissionRace: true });
  assert.equal(r.launches.length, 0);
  // The refusal is clean, not a storage failure: the run settles an honest
  // terminal outcome and releases the slot instead of retaining an
  // unconfirmed admission forever. (On the success-path return the field is
  // simply absent; the pre-fix code set it to true.)
  assert.ok(!r.result.storageFailed);
  assert.equal(r.status.revoked, true);
  assert.equal(r.status.pendingCommand, null);
  assert.ok(["stopped", "failed"].includes(r.status.state));
  assert.equal(r.status.active, false);
});
test("literal unknown dispatch retains pending claim and slot, no replay", async t => { const r = await scenario(t, { resultAt: 3, result: { ok: false, text: "partial writer", errorText: "lost", messageDispatched: null } }); assert.equal(r.launches.length, 3); assert.equal(r.status.state, "unconfirmed"); assert.equal(r.status.active, true); assert.ok(r.status.pendingCommand); assert.throws(() => r.store.claimWorker(r.jobId)); });
test("known-not-sent writer stays terminal without repair", async t => { const r = await scenario(t, { resultAt: 3, result: { ok: false, text: "", errorText: "never sent", messageDispatched: false } }); assert.equal(r.launches.length, 3); assert.equal(r.status.pendingCommand, null); assert.equal(r.records[0].messageDispatched, true); });
test("post-turn persistence failure retains durable uncertainty and known live result", async t => { const r = await scenario(t, { storageFailure: true }); assert.equal(r.launches.length, 1); assert.equal(r.status.active, true); assert.ok(r.status.pendingCommand); assert.equal(r.result.storageFailed, true); });
test("terminal ordinary record failure does not continue or replenish access", async t => { const r = await scenario(t, { saveFailure: true }); assert.equal(r.launches.length, 8); assert.equal(r.authorizations, 1); assert.equal(r.scope.current(), null); });
test("a record-save failure still settles the job terminal and releases the slot", async t => {
  // The plan record and the job outcome are separate durable facts: a
  // history write failure must not wedge the profile in a running job
  // forever (the defect: no later goal could start).
  const r = await scenario(t, { saveFailure: true });
  assert.equal(r.result.recordSaveFailed, true);
  assert.equal(r.status.state, "completed");
  assert.equal(r.status.active, false);
  assert.equal(typeof r.status.outcome?.error, "string");
  // The concrete user harm: a NEW goal is admissible in the same profile.
  const second = r.store.startAdmission({ requestId: "after-save-failure", goal: "Next goal", workspacePath: path.resolve("/tmp/gp-savefail"), allowedInstances: ["codex", "claude"], maxTurns: 4, backgroundConsent: true });
  assert.equal(second.ok, true);
});
test("blank selected workspace cannot clear governing hold", async t => { const r = await scenario(t, { snapshot: { bounds: { projectionUnavailable: false }, project: { workspaceRoot: "" }, stopResponsibility: { writeResponsibility: "held" } } }); assert.equal(r.launches.length, 0); assert.equal(r.authorizations, 0); });
test("Core unavailable/active projections refuse", () => { assert.ok(coreRefusal(null)); assert.ok(coreRefusal({ bounds: { projectionUnavailable: true } })); assert.ok(coreRefusal({ bounds: {}, attempt: { state: "ACTIVE" } })); });

test("a held goal outside the blank selected view refuses before first dispatch", async t => {
  const r = await scenario(t, { snapshot: { bounds: {}, project: { workspaceRoot: "" } }, overview: { truncated: false, pending: [], goals: [{ campaignId: "elsewhere", attention: "idle" }] }, detail: { bounds: {}, activeCampaignId: "elsewhere", project: { workspaceRoot: "/held/workspace" }, stopResponsibility: { writeResponsibility: "held" } } });
  assert.equal(r.launches.length, 0); assert.equal(r.authorizations, 0);
});
test("outside-selected native work and truncated inventory cannot become clearance", async t => {
  for (const overview of [{ truncated: true, pending: [], goals: [] }, { truncated: false, pending: [], goals: [{ campaignId: "elsewhere", attention: "running" }] }]) {
    const r = await scenario(t, { snapshot: { bounds: {}, project: { workspaceRoot: "" } }, overview });
    assert.equal(r.launches.length, 0); assert.equal(r.authorizations, 0);
  }
});

test("fresh global coverage refuses repair after the first completed audit without erasing its reports", async t => {
  const r = await scenario(t, { overview: { truncated: false, pending: [], goals: [{ campaignId: "elsewhere", attention: "idle" }] }, detail: (count, request) => ({ bounds: {}, activeCampaignId: request.payload.campaignId, ...(count >= 4 ? { stopResponsibility: { writeResponsibility: "held" } } : {}) }) });
  assert.equal(r.launches.length, 4); assert.equal(r.records[0].auditText.includes("VERDICT: revise"), true);
  assert.match(r.records[0].stopReason, /background job.*repair/); assert.equal(r.records[0].messageDispatched, true);
});

test("storage failure after reservation but before runtime invocation sends nothing", async t => {
  const r = await scenario(t, { preLaunchFailure: true }); assert.equal(r.launches.length, 0); assert.equal(r.status.active, true); assert.ok(r.status.pendingCommand); assert.equal(r.result.storageFailed, true);
});

// C4: the same worker runs the ONE pre-write plan revision when the initial
// chain's independent plan review rejects the plan, with the job-owned gate
// (live Core coverage + original scope) before the first revised turn.
test("worker completes a rejected plan and its revised chain with one authorization and retained facts", async t => {
  const r = await scenario(t, { reads: 5, reviewAt: { 2: "The plan ignores a required case.\nVERDICT: revise" } });
  assert.equal(r.result.status, "completed");
  assert.equal(r.launches.length, 6);
  assert.equal(r.authorizations, 1);
  assert.equal(new Set(r.launches.map(c => c.commandId)).size, 6);
  assert.deepEqual(r.status.counters, { readTurnsRemaining: 0, writeTurnsRemaining: 1 });
  assert.equal(r.records[0].verdict, "verified");
  assert.equal(r.records[0].planRevisionHistory.length, 1);
  assert.equal(r.records[0].planRevisionHistory[0].verdict, "revise");
  assert.equal(r.records[0].planRevisionHistory[0].commandIds.length, 2);
  assert.equal("feedbackHistory" in r.records[0], false);
  assert.equal("authorizedTurnsLeft" in r.records[0], false);
  assert.equal(r.status.active, false);
});

test("worker stops after a second plan rejection without a third planning pass", async t => {
  const r = await scenario(t, { reviewAt: { 2: "The plan ignores a required case.\nVERDICT: revise", 4: "The revision is still incomplete.\nVERDICT: revise" } });
  assert.equal(r.launches.length, 4);
  assert.ok(r.launches.every(c => c.sandboxPolicy.type === "readOnly"));
  assert.equal(r.result.report.verdict, "revise");
  assert.match(r.result.report.stopReason, /one automatic plan revision/);
  assert.equal(r.records[0].planRevisionHistory.length, 1);
  assert.equal(r.records[0].messageDispatched, true);
});

test("worker default four reads cannot fund the revised chain", async t => {
  const r = await scenario(t, { reads: 4, reviewAt: { 2: "The plan ignores a required case.\nVERDICT: revise" } });
  assert.equal(r.launches.length, 2);
  assert.equal(r.status.counters.readTurnsRemaining, 2);
  assert.match(r.result.report.stopReason, /not enough access left for one more checked plan revision/);
  assert.match(r.result.report.stopReason, /GoalPort did not add turns/);
  assert.equal("planRevisionHistory" in r.records[0], false);
});

test("worker refuses the revision when fresh Core coverage is held and retains the rejected round", async t => {
  const r = await scenario(t, {
    reviewAt: { 2: "The plan ignores a required case.\nVERDICT: revise" },
    overview: { truncated: false, pending: [], goals: [{ campaignId: "elsewhere", attention: "idle" }] },
    detail: (count, request) => ({ bounds: {}, activeCampaignId: request.payload.campaignId, ...(count >= 2 ? { stopResponsibility: { writeResponsibility: "held" } } : {}) }),
  });
  assert.equal(r.launches.length, 2);
  assert.equal(r.records[0].reviewText.includes("VERDICT: revise"), true);
  assert.match(r.records[0].stopReason, /background job.*automatic plan revision/);
  assert.equal(r.records[0].messageDispatched, true);
});

test("worker reconstruction passes all five historical feedback fields to backgroundEngineInput", async t => {
  const feedback = {
    previousPlan: "prior plan",
    previousPlanReview: "prior plan review",
    previousExecutionReport: "prior execution report",
    previousExecutionAudit: "prior execution audit",
    previousCommandIds: ["historical-command-1", "historical-command-2"],
  };
  const r = await scenario(t, { executionFeedback: feedback, captureExecutionFeedback: true });
  assert.deepEqual(r.backgroundEngineInputValue.executionFeedback, feedback);
  assert.deepEqual(Object.keys(r.backgroundEngineInputValue.executionFeedback), Object.keys(feedback));
  assert.equal(r.launches.some(command => feedback.previousCommandIds.includes(command.commandId)), false);
});

test("worker passes exact continuation descriptor to backgroundEngineInput and saves it in coordination record", async t => {
  const continuation = {
    parentRequestId: "parent-req-001",
    rootRequestId: "root-req-001",
    originalGoal: "Root original goal",
    followUp: "Follow-up coordination text",
  };
  const r = await scenario(t, { continuation, captureExecutionFeedback: true });
  assert.deepEqual(r.backgroundEngineInputValue.continuation, continuation);
  assert.equal(r.records.length, 1);
  assert.deepEqual(r.records[0].continuation, continuation);
});

// The packaged app has no GOALPORT_COORDINATE_SEND override. The worker must
// use the durable profile consent the user granted; without it, nothing runs.
test("worker runs with the durable profile consent when the env override is absent", async t => {
  const r = await scenario(t, { env: {}, consentGranted: true });
  assert.equal(r.result.status, "completed");
  assert.equal(r.launches.length, 8);
});
test("worker dispatches nothing without durable consent and without the env override", async t => {
  const r = await scenario(t, { env: {} });
  assert.equal(r.launches.length, 0);
  assert.notEqual(r.result.status, "completed");
  assert.match(String(r.result.error || r.result.report?.stopReason || ""), /not enabled|consent/i);
});
test("a launch re-checks consent and refuses after it is revoked", async () => {
  let ran = 0;
  const runtime = { discover: async () => ({ ok: true, providers }), prepare: async () => ({}), run: async () => { ran += 1; return { ok: true, text: "plan", messageDispatched: true }; }, close() {} };
  const command = () => ({ commandId: "coordinate-plan-codex", type: "goalport.coordinateTurn",
    modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" }, runtimeMode: "approval-required",
    approvalPolicy: "never", sandboxPolicy: { type: "readOnly" },
    workspaceStrategy: { type: "existing_worktree", worktreePath: "C:\\work\\goal" }, initialMessage: { text: "Plan only." } });
  const refused = await launchOne({}, runtime, command(), "generation", undefined, () => ({ allowed: false }));
  assert.equal(refused.launched, false);
  assert.equal(ran, 0);
  assert.match(String(refused.errorText), /not authorized|allowed|consent/i);
  const allowed = await launchOne({}, runtime, command(), "generation", undefined, () => ({ allowed: true }));
  assert.equal(allowed.launched, true);
  assert.equal(ran, 1);
});

test("a worker encountering stuck-acknowledged between turns settles stopped and releases workspace hold", async (t) => {
  let ackAt = 2; // acknowledge before the second command (review) is recorded
  let calls = 0;
  let acknowledgedCalled = false;
  const r = await scenario(t, {
    reads: 4,
    readOnly: false,
    storeDecorator: (st, start) => {
      const orig = st.recordPendingCommand;
      return {
        ...st,
        recordPendingCommand: (jobId, ...args) => {
          calls++;
          if (calls === ackAt) {
            acknowledgedCalled = true;
            st.acknowledgeStuck(jobId);
          }
          return orig.call(st, jobId, ...args);
        }
      };
    },
  });
  assert.equal(calls, 2);
  assert.equal(acknowledgedCalled, true);
  assert.equal(r.result.status, "stopped");
  assert.equal(r.result.storageFailed, undefined);
  assert.equal(r.launches.length, 1);

  // Terminal state persisted
  assert.equal(r.status.state, "stopped");
  assert.equal(r.status.outcome?.status, "stopped");

  // Same workspace hold is freed!
  const nextSameFolder = r.store.startAdmission({
    requestId: "second-send",
    goal: "New attempt",
    workspacePath: r.status.admission.workspacePath,
    allowedInstances: ["codex"],
    maxTurns: 2,
    backgroundConsent: true,
  });
  assert.equal(nextSameFolder.ok, true);
  assert.equal(nextSameFolder.created, true);
});
