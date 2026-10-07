"use strict";

const UNAUTHORIZED = "No model turn was sent, because this session is not authorized to spend subscription quota.";
const DISCONNECTED_DISCOVER = "The coordination server is not connected, so no harness was assigned.";
const DISCONNECTED_LAUNCH = "The coordination server is not connected, so no model turn was sent.";
const PREPARE_FAILED = "The read-only session was not prepared, so nothing was sent.";

function guardCoordinateCommand(command) {
  if (!command || command.type !== "goalport.coordinateTurn") return "The command is not a coordinate turn.";
  if (command.runtimeMode !== "approval-required") return "runtimeMode must be approval-required.";
  if (command.approvalPolicy !== "never") {
    return "approvalPolicy must be never. approval-required alone asks for every read.";
  }
  if (!command.sandboxPolicy || command.sandboxPolicy.type !== "readOnly") {
    return "sandboxPolicy.type must be readOnly.";
  }
  return null;
}

function runtimeReady(runtime) {
  return Boolean(runtime && typeof runtime.discover === "function" && typeof runtime.prepare === "function");
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
    const stopReason = typeof discovered?.stopReason === "string" && discovered.stopReason.trim()
      ? discovered.stopReason
      : "The harness list could not be read, so no harness was assigned.";
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

function prepareHeld(result) {
  return Boolean(
    result
    && result.ok === true
    && result.messageDispatched === false
    && result.disposition === "deny"
    && result.sandbox === "readOnly"
    && result.approval === "never",
  );
}

async function launchOne(env, runtime, command, generation) {
  const problem = guardCoordinateCommand(command);
  if (problem) return { launched: false, prepared: false, text: "", errorText: problem };
  if (!runtimeReady(runtime)) {
    return { launched: false, prepared: false, text: "", errorText: DISCONNECTED_LAUNCH };
  }
  let prepared;
  try {
    prepared = await runtime.prepare(command, generation);
  } catch {
    return { launched: false, prepared: false, text: "", errorText: PREPARE_FAILED };
  }
  if (!prepareHeld(prepared)) {
    const errorText = typeof prepared?.errorText === "string" && prepared.errorText.trim()
      ? prepared.errorText
      : PREPARE_FAILED;
    return { launched: false, prepared: false, text: "", errorText };
  }
  if (env.GOALPORT_COORDINATE_SEND !== "1") {
    return { launched: false, prepared: true, text: "", errorText: UNAUTHORIZED };
  }
  let ran = null;
  try {
    if (typeof runtime.run === "function") ran = await runtime.run(generation);
  } catch {
    ran = null;
  }
  const errorText = typeof ran?.errorText === "string" && ran.errorText.trim() ? ran.errorText : UNAUTHORIZED;
  return { launched: false, prepared: true, text: "", errorText };
}

module.exports = { guardCoordinateCommand, discoverCoordination, launchOne };
