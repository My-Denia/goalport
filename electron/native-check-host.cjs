"use strict";
// Desktop twin of the Linux workbench's workspace check. The main process keeps
// the exact previewed bytes; the renderer never sends them. No scope or replay
// authority: a start re-reads the target, rechecks the material and admits once.
const purpose = require("./native-workspace-check.cjs");
const lookup = require("./native-check-lookup.cjs");
const { projection } = require("./coordination-background.cjs");
const { piAdmissionContext } = require("./pi-capacity-admission.cjs");
const { authorizeMembershipError } = require("./coordinate-service.cjs");
const { normalizePiCapacity } = require("./pi-capacity.mjs");
const { readRecords } = require("./coordination-record.cjs");

const TTL_MS = 300000;
const ID = /^[A-Za-z0-9._-]{1,256}$/;
// Admission never happened for these, so the same preview can be taken again.
const BEFORE_ADMISSION = new Set(["background-unavailable", "background-consent-required", "background-start-in-progress", "background-scope-conflict", "background-core-refused", "background-preflight-failed", "background-invalid-admission", "background-job-conflict"]);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function checkedPayload(payload, start) {
  const required = ["requestId", "campaignId", "attemptId", "turnRequestId"];
  const allowed = [...required, "piCapacity", ...(start ? ["backgroundConsent"] : [])];
  if (!payload || typeof payload !== "object" || Object.keys(payload).some(key => !allowed.includes(key)) || !required.every(key => ID.test(payload[key] ?? ""))) {
    throw Error("Malformed workspace check request.");
  }
  const pair = payload.piCapacity === undefined ? undefined : normalizePiCapacity(payload.piCapacity);
  if (payload.piCapacity !== undefined && !pair) throw Error("The requested Pi capacity is malformed.");
  if (start && (!pair || payload.backgroundConsent !== true)) throw Error("Select Pi capacity and keep-working consent explicitly.");
  return { requestId: payload.requestId, pair, target: purpose.targetOf({ campaignId: payload.campaignId, attemptId: payload.attemptId, turnRequestId: payload.turnRequestId }) };
}

function createNativeCheckHost(options) {
  let packet = null;
  let expires = 0;
  const now = options.now ?? Date.now;
  const resolve = async target => purpose.resolveTarget(options.core, await options.snapshot(), target);
  const sameTarget = (a, b) => a.workspace === b.workspace && a.taskId === b.taskId && a.goal === b.goal && same(a.context, b.context);
  async function providers(workspace) {
    const discovered = await options.discover(workspace);
    if (!discovered || discovered.ok === false) throw Error("The signed-in harnesses could not be checked.");
    return Array.isArray(discovered.providers) ? discovered.providers : [];
  }
  function requirePi(requestId, workspacePath, pair, list) {
    const context = piAdmissionContext({ requestId, allowedInstances: ["pi"], workspacePath, piCapacity: pair }, options.directory(), { ok: true, providers: list });
    const problem = authorizeMembershipError({ ok: true, providers: list }, ["pi"], context);
    if (problem) throw Error(problem);
  }
  async function prepare(payload) {
    const { requestId, target, pair } = checkedPayload(payload, false);
    packet = null;
    const resolved = await resolve(target);
    const list = await providers(resolved.workspace);
    if (!pair) {
      return { offer: list.find(provider => provider.instanceId === "pi") ?? null, workspacePath: resolved.workspace, goal: resolved.goal, backgroundSendConsent: options.consent().allowed === true };
    }
    requirePi(requestId, resolved.workspace, pair, list);
    const engine = options.engine();
    const material = await purpose.collectMaterial(resolved, engine);
    if (!sameTarget(await resolve(target), resolved)) throw Error(purpose.STALE);
    const prepared = { requestId, nativeCheckTarget: target, workspacePath: resolved.workspace, goal: resolved.goal, taskId: resolved.taskId, piCapacity: pair, ...material };
    if (Buffer.byteLength(JSON.stringify(prepared)) > 256 * 1024) throw Error("Workspace check packet is too large.");
    if (material.nativeCheckMaterial) { packet = prepared; expires = now() + TTL_MS; }
    return prepared;
  }
  async function start(payload) {
    const { requestId, target, pair } = checkedPayload(payload, true);
    // A lost final reply resolves to the same job before anything else runs.
    const prior = lookup.statusForRequest(options.directory(), requestId);
    if (prior) {
      lookup.requireSameTargetPair(prior, target, pair);
      return { job: projection(prior) };
    }
    let admissionAttempted = false;
    try {
      const held = packet;
      if (!held || now() >= expires || held.requestId !== requestId || !same(held.nativeCheckTarget, target) || !same(held.piCapacity, pair)) throw Error(purpose.STALE);
      const material = purpose.materialOf(held.nativeCheckMaterial);
      const captured = Date.parse(material.capturedAt);
      if (now() - captured > TTL_MS || captured > now()) throw Error(purpose.STALE);
      const resolved = await resolve(target);
      if (resolved.workspace !== held.workspacePath || resolved.goal !== held.goal || resolved.taskId !== held.taskId) throw Error(purpose.STALE);
      requirePi(requestId, resolved.workspace, pair, await providers(resolved.workspace));
      await purpose.recheckMaterial(resolved, material, options.engine());
      if (!sameTarget(await resolve(target), resolved)) throw Error(purpose.STALE);
      admissionAttempted = true;
      const job = await options.start({ requestId, goal: resolved.goal, workspaceRoot: resolved.workspace, readInstances: ["pi"], readMaxTurns: 2, backgroundConsent: true, piCapacity: pair, nativeCheckTarget: target, nativeCheckMaterial: material });
      packet = null;
      return { job };
    } catch (error) {
      if (!admissionAttempted || BEFORE_ADMISSION.has(error?.code)) {
        packet = null;
        throw Object.assign(Error(error?.message || purpose.STALE), { previewAgain: true });
      }
      throw error;
    }
  }
  function list(campaignId) {
    if (!ID.test(campaignId ?? "")) throw Error("Choose an exact native goal.");
    const records = readRecords(options.directory());
    const checks = [];
    for (const record of records) {
      if (record?.recordKind !== "native-workspace-check") continue;
      try {
        const target = purpose.targetOf(record.nativeCheckTarget);
        const material = purpose.materialOf(record.nativeCheckMaterial);
        const own = lookup.statusForRequest(options.directory(), record.requestId);
        const bound = !!own && target.campaignId === campaignId && records.filter(r => r?.requestId === record.requestId).length === 1
          && same(own.admission.nativeCheckTarget, target) && same(own.admission.nativeCheckMaterial, material) && same(own.admission.piCapacity, record.piCapacity)
          && own.admission.workspacePath === record.workspacePath && same(own.admission.allowedInstances, ["pi"]) && own.admission.maxTurns === 2 && own.admission.writeAuthorization === null;
        if (bound) checks.push({ recordKind: record.recordKind, requestId: record.requestId, nativeCheckTarget: target, nativeCheckMaterial: material, nativeAssociation: true, jobId: own.jobId, workspacePath: record.workspacePath, savedAt: record.savedAt, auditText: record.auditText, verdict: record.verdict, statusLabel: record.verdict === "checked" ? "Independent workspace check returned" : "Workspace check did not complete" });
      } catch { /* Descriptive damage never repairs or retargets. */ }
    }
    return { checks };
  }
  async function handle(messageType, payload) {
    try {
      if (messageType === "native_workspace_check_prepare") return { ok: true, payload: await prepare(payload) };
      if (messageType === "native_workspace_check_start") return { ok: true, payload: await start(payload) };
      if (messageType === "coordination_list") return { ok: true, payload: list(payload?.nativeCampaignId) };
      if (messageType === "coordination_grant") return { ok: true, payload: options.grant() };
      if (messageType === "coordination_stop") return { ok: true, payload: await options.stop(payload?.jobId) };
      if (messageType === "coordination_acknowledge") return { ok: true, payload: { job: await options.leave(payload?.jobId) } };
      return { ok: false, error: "Workspace check is unavailable." };
    } catch (error) {
      return { ok: false, error: error?.message || "Workspace check is unavailable.", previewAgain: error?.previewAgain === true };
    }
  }
  return { prepare, start, list, handle };
}

module.exports = { createNativeCheckHost };
