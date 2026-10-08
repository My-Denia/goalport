"use strict";

const UNAUTHORIZED = "No model turn was sent, because this session is not authorized to spend subscription quota.";
const DISCONNECTED_DISCOVER = "The coordination server is not connected, so no harness was assigned.";
const DISCONNECTED_LAUNCH = "The coordination server is not connected, so no model turn was sent.";

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

async function launchOne(env, runtime, command, generation) {
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
  let ran = null;
  try {
    ran = await runtime.run(command, generation);
  } catch {
    ran = null;
  }
  const text = typeof ran?.text === "string" ? ran.text.trim() : "";
  if (ran?.ok === true && text.length > 0 && !(typeof ran.errorText === "string" && ran.errorText.trim())) {
    return { launched: true, prepared: true, text, errorText: "" };
  }
  const errorText = typeof ran?.errorText === "string" && ran.errorText.trim() ? ran.errorText : UNAUTHORIZED;
  return { launched: false, prepared: true, text: "", errorText };
}

module.exports = { guardCoordinateCommand, discoverCoordination, launchOne };
