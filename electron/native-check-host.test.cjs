const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createNativeCheckHost } = require("./native-check-host.cjs");
const { STALE } = require("./native-workspace-check.cjs");
const engine = require("../dist/coordination-engine.cjs");

const pair = { provider: "Fixture", model: "alpha", useExistingCapacity: true };
const ids = { campaignId: "campaign", attemptId: "attempt", turnRequestId: "turn" };

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-check-host-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "work"), directory = path.join(root, "profile");
  fs.mkdirSync(workspace);
  fs.mkdirSync(directory);
  const git = (...args) => execFileSync("git", args, { cwd: workspace, encoding: "utf8" });
  git("init");
  git("config", "user.name", "Synthetic Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(workspace, "note.txt"), "old\n");
  git("add", ".");
  git("commit", "-m", "fixture only");
  fs.writeFileSync(path.join(workspace, "note.txt"), "new\n");
  const snapshot = { bounds: { projectionUnavailable: false, truncated: false }, activeCampaignId: "campaign", attempt: { id: "attempt", taskId: "task", provider: "codex", state: "waiting" }, activeTask: { id: "task", title: "Fixture goal" }, project: { workspaceRoot: workspace }, decisions: [], productConversation: { runtime: { provider: "codex" }, turn: { state: "completed", canStop: false } }, turnResults: [{ requestId: "turn", replyState: "completed", replyText: "Reported reply", commands: [] }] };
  const core = { exchangeVerified: async request => ({ ok: true, requestId: request.requestId, payload: { requestId: request.requestId, accepted: true, ...(request.messageType === "goal_overview" ? { overview: { truncated: false, goals: [{ campaignId: "campaign", attention: "completed" }], pending: [] } } : { snapshot }) } }) };
  const started = [];
  const host = createNativeCheckHost({
    directory: () => directory, core, snapshot: async () => snapshot, engine: () => engine,
    discover: async cwd => ({ ok: true, providers: [{ instanceId: "pi", auth: { status: "authenticated" }, piCapacity: { offer: pair, catalog: [pair], workspacePath: cwd } }] }),
    consent: () => ({ allowed: true }), grant: () => ({ allowed: true }), stop: async jobId => ({ jobId }),
    start: async input => { started.push(input); return { jobId: "job", requestId: input.requestId }; },
    ...overrides,
  });
  return { host, started, snapshot, workspace, directory };
}

test("the first read offers Pi and consent without collecting or holding any material", async t => {
  const { host, workspace } = fixture(t);
  const reply = await host.prepare({ requestId: "one", ...ids });
  assert.equal(reply.offer.instanceId, "pi");
  assert.equal(reply.backgroundSendConsent, true);
  assert.equal(reply.workspacePath, require("./coordination-job.cjs").workspaceIdentity(workspace));
  assert.equal("nativeCheckMaterial" in reply, false);
  await assert.rejects(host.start({ requestId: "one", ...ids, piCapacity: pair, backgroundConsent: true }), error => error.previewAgain === true);
});

test("start admits exactly the previewed bytes once, read-only, Pi only, with nothing from the renderer", async t => {
  const { host, started } = fixture(t);
  const preview = await host.prepare({ requestId: "one", ...ids, piCapacity: pair });
  assert.match(preview.nativeCheckMaterial.exactPrompt, /\+new/);
  const reply = await host.start({ requestId: "one", ...ids, piCapacity: pair, backgroundConsent: true });
  assert.equal(reply.job.jobId, "job");
  assert.equal(started.length, 1);
  assert.deepEqual(started[0].nativeCheckMaterial, preview.nativeCheckMaterial);
  assert.deepEqual(started[0].readInstances, ["pi"]);
  assert.equal(started[0].readMaxTurns, 2);
  assert.equal("write" in started[0], false);
  await assert.rejects(host.start({ requestId: "one", ...ids, piCapacity: pair, backgroundConsent: true }), /Preview again/);
  assert.equal(started.length, 1);
});

test("a renderer cannot supply material, and unknown fields are refused before any read", async t => {
  const { host, started } = fixture(t);
  await host.prepare({ requestId: "one", ...ids, piCapacity: pair });
  const reply = await host.handle("native_workspace_check_start", { requestId: "one", ...ids, piCapacity: pair, backgroundConsent: true, nativeCheckMaterial: { exactPrompt: "forged" } });
  assert.equal(reply.ok, false);
  assert.equal(started.length, 0);
});

test("a changed workspace, target, pair or expired preview must be previewed again and is never admitted", async t => {
  let time = Date.now();
  const { host, started, workspace } = fixture(t, { now: () => time });
  const start = (extra = {}) => host.handle("native_workspace_check_start", { requestId: "one", ...ids, piCapacity: pair, backgroundConsent: true, ...extra });
  await host.prepare({ requestId: "one", ...ids, piCapacity: pair });
  fs.writeFileSync(path.join(workspace, "note.txt"), "later\n");
  assert.deepEqual(await start(), { ok: false, error: STALE, previewAgain: true });
  await host.prepare({ requestId: "one", ...ids, piCapacity: pair });
  assert.equal((await start({ turnRequestId: "other" })).previewAgain, true);
  await host.prepare({ requestId: "one", ...ids, piCapacity: pair });
  time += 300001;
  assert.equal((await start()).previewAgain, true);
  assert.equal(started.length, 0);
});

test("no tracked change reports plainly, holds nothing and calls nobody", async t => {
  const { host, started, workspace } = fixture(t);
  fs.writeFileSync(path.join(workspace, "note.txt"), "old\n");
  const reply = await host.prepare({ requestId: "one", ...ids, piCapacity: pair });
  assert.equal(reply.empty, true);
  assert.match(reply.message, /Pi was not called/);
  assert.equal((await host.handle("native_workspace_check_start", { requestId: "one", ...ids, piCapacity: pair, backgroundConsent: true })).previewAgain, true);
  assert.equal(started.length, 0);
});

test("an unconfirmed admission failure keeps the request instead of offering a second send", async t => {
  const { host } = fixture(t, { start: async () => { throw Error("worker reply lost"); } });
  await host.prepare({ requestId: "one", ...ids, piCapacity: pair });
  const reply = await host.handle("native_workspace_check_start", { requestId: "one", ...ids, piCapacity: pair, backgroundConsent: true });
  assert.deepEqual(reply, { ok: false, error: "worker reply lost", previewAgain: false });
});

test("leaving a dead check goes only to the host leave path", async t => {
  const left = [];
  const { host, started } = fixture(t, { leave: async jobId => { left.push(jobId); return { jobId }; } });
  assert.deepEqual(await host.handle("coordination_acknowledge", { jobId: "job" }), { ok: true, payload: { job: { jobId: "job" } } });
  assert.deepEqual(left, ["job"]);
  assert.equal(started.length, 0);
});

test("the saved list ignores unbound records and refuses an unusable goal id", async t => {
  const { host, directory } = fixture(t);
  fs.writeFileSync(path.join(directory, "coordination-records.json"), JSON.stringify([{ requestId: "lonely", recordKind: "native-workspace-check", nativeCheckTarget: ids }]));
  assert.deepEqual((await host.handle("coordination_list", { nativeCampaignId: "campaign" })).payload, { checks: [] });
  assert.equal((await host.handle("coordination_list", { nativeCampaignId: "../x" })).ok, false);
});

test("saved failed checks retain their reason through the desktop host after reopening", async t => {
  const { host, directory, workspace } = fixture(t);
  const preview = await host.prepare({ requestId: "failed-check", ...ids, piCapacity: pair });
  const { createCoordinationJobStore, workspaceIdentity } = require("./coordination-job.cjs");
  const store = createCoordinationJobStore(directory, { bootstrapReady: true });
  const workspacePath = workspaceIdentity(workspace);
  store.startAdmission({
    requestId: "failed-check", goal: "Review changes", workspacePath,
    allowedInstances: ["pi"], maxTurns: 2, writeAuthorization: null,
    backgroundConsent: true, piCapacity: pair,
    nativeCheckTarget: ids, nativeCheckMaterial: preview.nativeCheckMaterial,
  });
  const stopReason = "401 authentication_error: sign in to Pi again";
  require("./coordination-record.cjs").saveRecord(directory, {
    requestId: "failed-check", recordKind: "native-workspace-check",
    workspacePath, goal: "Review changes", piCapacity: pair,
    nativeCheckTarget: ids, nativeCheckMaterial: preview.nativeCheckMaterial,
    verdict: "failed", stopReason, auditText: "",
    planningHarness: null, reviewHarness: null, planText: null, reviewText: null,
    result: null, planningQuota: "unknown", reviewQuota: "unknown",
  });
  const reopened = createNativeCheckHost({ directory: () => directory });
  const response = await reopened.handle("coordination_list", { nativeCampaignId: "campaign" });
  assert.equal(response.ok, true);
  assert.equal(response.payload.checks.length, 1);
  assert.equal(response.payload.checks[0].nativeAssociation, true);
  assert.equal(response.payload.checks[0].stopReason, stopReason);
});
