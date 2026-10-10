"use strict";

const path = require("node:path");
const { guardCoordinateCommand, guardCoordinateWriteCommand, roleOfCommandId } = require("./coordinate-guard.cjs");

const UNAUTHORIZED = "No model turn was sent, because this session is not authorized to spend subscription quota.";
const DISCONNECTED_DISCOVER = "The coordination server is not connected, so no harness was assigned.";
const DISCONNECTED_LAUNCH = "The coordination server is not connected, so no model turn was sent.";

// guardCoordinateCommand lives in the zero-import leaf coordinate-guard.cjs
// and is re-exported unchanged, so every existing require path stays green.

function runtimeReady(runtime) {
  return Boolean(runtime && typeof runtime.discover === "function" && typeof runtime.prepare === "function");
}

function scopeReady(scopeCtx) {
  return Boolean(scopeCtx && scopeCtx.scope && typeof scopeCtx.scope.reserve === "function" && typeof scopeCtx.scope.settle === "function");
}

function scopedLaunch(scopeCtx) {
  return scopeReady(scopeCtx) ? scopeCtx.scope : null;
}

// Reported after settle, so a refunded reservation shows the budget it actually
// has left, and a scope revoked mid-run reports null instead of a stale number.
function remainingAfter(scopeModule, hadWrite = false) {
  const snapshot = typeof scopeModule.current === "function" ? scopeModule.current() : null;
  return {
    turnsRemaining: snapshot ? snapshot.remaining : null,
    ...(snapshot?.write || hadWrite ? { writeTurnsRemaining: snapshot?.write?.remaining ?? null } : {}),
  };
}

function discoveryFailureText(discovered) {
  const stopReason = typeof discovered?.stopReason === "string" ? discovered.stopReason.trim() : "";
  if (stopReason) return stopReason;
  const errorText = typeof discovered?.errorText === "string" ? discovered.errorText.trim() : "";
  if (errorText) return errorText;
  return "The harness list could not be read, so no harness was assigned.";
}

async function discoverCoordination(env, runtime, generation) {
  if (!runtimeReady(runtime)) {
    return {
      connected: false,
      sendAuthorized: false,
      providers: [],
      stopReason: DISCONNECTED_DISCOVER,
    };
  }
  let discovered;
  try {
    discovered = await runtime.discover(generation);
  } catch {
    return {
      connected: false,
      sendAuthorized: false,
      providers: [],
      stopReason: "The harness list could not be read, so no harness was assigned.",
    };
  }
  if (!discovered || discovered.ok === false) {
    const stopReason = discoveryFailureText(discovered);
    return {
      connected: false,
      sendAuthorized: false,
      providers: [],
      stopReason,
    };
  }
  return {
    connected: true,
    sendAuthorized: env.GOALPORT_COORDINATE_SEND === "1",
    providers: Array.isArray(discovered.providers) ? discovered.providers : [],
    stopReason: null,
  };
}

async function launchOne(env, runtime, command, generation, scopeCtx) {
  const scopeModule = scopedLaunch(scopeCtx);
  const hadWrite = Boolean(scopeModule?.current?.()?.write);
  const metadata = () => scopeModule ? remainingAfter(scopeModule, hadWrite) : {};
  // Read-only pre-reservation refusals keep their historic response shape.
  const refusalMetadata = () => hadWrite ? metadata() : {};
  const execute = roleOfCommandId(command?.commandId) === "execute";
  const problem = execute ? guardCoordinateWriteCommand(command) : guardCoordinateCommand(command);
  if (problem) return { launched: false, prepared: false, text: "", errorText: problem, ...refusalMetadata() };
  if (execute && !scopeModule) {
    return { launched: false, prepared: false, text: "", errorText: "This execution turn needs an explicit workspace-change authorization, so nothing was sent.", dispatched: false };
  }
  if (!runtimeReady(runtime)) {
    return { launched: false, prepared: false, text: "", errorText: DISCONNECTED_LAUNCH, ...refusalMetadata() };
  }
  if (env.GOALPORT_COORDINATE_SEND !== "1") {
    return { launched: false, prepared: true, text: "", errorText: UNAUTHORIZED, ...refusalMetadata() };
  }
  if (typeof runtime.run !== "function") {
    return { launched: false, prepared: false, text: "", errorText: DISCONNECTED_LAUNCH, ...refusalMetadata() };
  }
  // A scoped launch reserves first: the scope module validates in its
  // load-bearing order, writes the JIT grant line and charges one turn BEFORE
  // runtime.run, then settles the reservation against the decision table.
  let reserved = null;
  let reservation = null;
  if (scopeModule) {
    reserved = scopeModule.reserve(command, scopeCtx.scopeGeneration, typeof runtime.stateDir === "string" ? runtime.stateDir : "");
    if (!reserved.ok) {
      return {
        launched: false,
        prepared: true,
        text: "",
        errorText: reserved.errorText,
        dispatched: false,
        ...(reserved.stopCode ? { stopCode: reserved.stopCode } : {}),
        ...(reserved.scopeExhausted ? { scopeExhausted: true } : {}),
        turnsRemaining: typeof reserved.turnsRemaining === "number" ? reserved.turnsRemaining : null,
        ...(hadWrite ? { writeTurnsRemaining: typeof reserved.writeTurnsRemaining === "number" ? reserved.writeTurnsRemaining : null } : {}),
      };
    }
    reservation = reserved.existing ? null : reserved.reservation;
  }
  // The call is split so a synchronous throw is distinguishable from a
  // mid-turn transport death: a run that throws before producing any promise
  // cannot have claimed or spawned, which the scope's cleanup is allowed to
  // treat as proven-not-sent.
  let pending;
  let neverStarted = false;
  try {
    pending = runtime.run(command, generation);
  } catch {
    neverStarted = true;
  }
  let ran = null;
  if (!neverStarted) {
    try {
      ran = await pending;
    } catch {
      ran = null;
    }
  }
  const text = typeof ran?.text === "string" ? ran.text.trim() : "";
  if (ran?.ok === true && text.length > 0 && !(typeof ran.errorText === "string" && ran.errorText.trim())) {
    if (scopeModule) scopeModule.settle(reservation, { dispatched: true }, runtime.stateDir);
    return {
      launched: true,
      prepared: true,
      text,
      errorText: "",
      dispatched: true,
      ...metadata(),
    };
  }
  // A turn that produced text and then failed keeps that text: the partial
  // plan or check is real model output the saved Plan can still show.
  const errorText = typeof ran?.errorText === "string" && ran.errorText.trim() ? ran.errorText : UNAUTHORIZED;
  const environmentBlocked = ran?.environmentBlocked === true;
  // The failure-path dispatch mapping is literal (plan R2-2): a literal true
  // or false survives; everything else — absent, null, undefined, or a thrown
  // transport — is unknown (null). Absence must never be flattened into
  // "proven not sent", because an unknown dispatch may already have spent
  // quota; only a literal false may be treated as not sent.
  const dispatched = ran == null
    ? null
    : ran.messageDispatched === true
      ? true
      : ran.messageDispatched === false
        ? false
        : null;
  if (scopeModule) scopeModule.settle(reservation, { dispatched, neverStarted }, runtime.stateDir);
  return {
    launched: false,
    prepared: true,
    text,
    errorText,
    dispatched,
    environmentBlocked,
    environmentDetail: environmentBlocked && typeof ran?.environmentDetail === "string" ? ran.environmentDetail : null,
    ...(typeof ran?.stopCode === "string" ? { stopCode: ran.stopCode } : {}),
    ...metadata(),
  };
}

// Authorize-time membership: every requested harness must appear in a FRESH
// zero-quota discovery right now, and an apiKey-typed login never enters a
// scope (the budget authority would otherwise front a pay-per-call
// credential). A discovery that fails at all refuses everything (fail-closed).
// Returns null when the request is admissible, or the human refusal sentence.
function authorizeMembershipError(discovered, requested) {
  const providers = discovered?.ok !== false && Array.isArray(discovered?.providers) ? discovered.providers : [];
  const discoveredById = new Map(providers.map((provider) => [provider.instanceId, provider]));
  for (const instance of requested) {
    const provider = typeof instance === "string" ? discoveredById.get(instance) : undefined;
    if (!provider || provider?.auth?.type === "apiKey") {
      return "Only harnesses signed in with their own subscription can be authorized.";
    }
  }
  return null;
}

// One tested bridge owns request validation and the fresh discovery for BOTH
// lists. The scope remains the only authority for clamping budgets/minting.
async function authorizeCoordination(payload, scopeModule, discover) {
  const refusal = (errorText) => ({ ok: false, generation: 0, remaining: 0, errorText });
  const members = (value) => Array.isArray(value) && value.every((id) => typeof id === "string")
    ? [...new Set(value.map((id) => id.trim()).filter(Boolean))] : [];
  const requested = members(payload?.instances);
  if (!requested.length) return refusal("No harness was chosen, so nothing was authorized.");
  const write = payload?.write;
  let writeMembers = [];
  if (write !== undefined) {
    writeMembers = members(write?.instances);
    if (!write || typeof write !== "object" || Array.isArray(write) || !writeMembers.length ||
        typeof write.maxTurns !== "number" || !Number.isFinite(write.maxTurns) ||
        typeof write.workspaceRoot !== "string" || !write.workspaceRoot.trim() || !path.isAbsolute(write.workspaceRoot)) {
      return refusal("The workspace-change authorization is invalid, so nothing was authorized.");
    }
  }
  let discovered = null;
  try { discovered = await discover(); } catch { /* No fresh membership means no authorization. */ }
  const membership = authorizeMembershipError(discovered, requested) ||
    (write !== undefined ? authorizeMembershipError(discovered, writeMembers) : null);
  if (membership) return refusal(membership);
  return scopeModule.authorize(requested, payload?.maxTurns, write);
}

module.exports = { guardCoordinateCommand, discoverCoordination, launchOne, authorizeMembershipError, authorizeCoordination };
