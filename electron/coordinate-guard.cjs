"use strict";

// Zero-import leaf: the four audited checks for a coordinate turn live here so
// both the service and the CLI can require them without a dependency cycle.
// The checks themselves are a byte-identical relocation from
// coordinate-service.cjs and must not be loosened in place.
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

module.exports = { guardCoordinateCommand };
