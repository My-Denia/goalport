"use strict";

const { guardCoordinateCommand } = require("./coordinate-guard.cjs");

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
function remainingAfter(scopeModule) {
  const snapshot = typeof scopeModule.current === "function" ? scopeModule.current() : null;
  return snapshot ? snapshot.remaining : null;
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
  const problem = guardCoordinateCommand(command);
  if (problem) return { launched: false, prepared: false, text: "", errorText: problem };
  if (!runtimeReady(runtime)) {
    return { launched: false, prepared: false, text: "", errorText: DISCONNECTED_LAUNCH };
  }
  if (env.GOALPORT_COORDINATE_SEND !== "1") {
    return { launched: false, prepared: true, text: "", errorText: UNAUTHORIZED };
  }
  if (typeof runtime.run !== "function") {
    return { launched: false, prepared: false, text: "", errorText: DISCONNECTED_LAUNCH };
  }
  // A scoped launch reserves first: the scope module validates in its
  // load-bearing order, writes the JIT grant line and charges one turn BEFORE
  // runtime.run, then settles the reservation against the decision table.
  const scopeModule = scopedLaunch(scopeCtx);
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
      ...(scopeModule ? { turnsRemaining: remainingAfter(scopeModule) } : {}),
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
    ...(scopeModule ? { turnsRemaining: remainingAfter(scopeModule) } : {}),
  };
}

// Authorize-time membership: every requested harness must appear in a FRESH
// zero-quota discovery right now, and an apiKey-typed login never enters a
// scope (the budget authority would otherwise front a pay-per-call
// credential). A discovery that fails at all refuses everything (fail-closed).
// Returns null when the request is admissible, or the human refusal sentence.
function authorizeMembershipError(discovered, requested) {
  const providers = Array.isArray(discovered?.providers) ? discovered.providers : [];
  const discoveredById = new Map(providers.map((provider) => [provider.instanceId, provider]));
  for (const instance of requested) {
    const provider = typeof instance === "string" ? discoveredById.get(instance) : undefined;
    if (!provider || provider?.auth?.type === "apiKey") {
      return "Only harnesses signed in with their own subscription can be authorized.";
    }
  }
  return null;
}

module.exports = { guardCoordinateCommand, discoverCoordination, launchOne, authorizeMembershipError };
