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

// The one canonical role rule for the coordination turn family: the commandId
// prefix names the role against a closed set. plan and review are the audited
// read roles; execute and audit extend the family for explicitly authorized
// write rounds (execute writes, audit reads). Anything else classifies as
// null and is refused everywhere a role matters.
const ROLE_PREFIX = /^coordinate-(plan|review|execute|audit)-/;

function roleOfCommandId(commandId) {
  const match = ROLE_PREFIX.exec(typeof commandId === "string" ? commandId : "");
  return match ? match[1] : null;
}

// Absolute-path shape without node:path (this leaf stays zero-import so both
// the service and the CLI can require it): a leading separator, or a Windows
// drive or UNC prefix. This is a shape check for refusable authorization, not
// resolution or confinement — the pinned-root resolve-equality lives at the
// scope's budget authority, and the harness CLI's own sandbox does the
// confining. Root shape validation binds the launch; it does not fence the
// subprocess.
function isAbsoluteWorktreePath(text) {
  return /^[/\\]/.test(text) || /^[A-Za-z]:[/\\]/.test(text);
}

// The write-side twin of guardCoordinateCommand, for explicitly authorized
// write rounds only: the same type/runtimeMode/approvalPolicy literals, the
// sandbox literal flipped to workspaceWrite, and an existing worktree with a
// non-empty absolute path. Never reaches a write turn through the legacy
// hand-written grant path alone — the guard selection picks it by execute
// role, and the scoped launch requirement lives with the scope authority.
function guardCoordinateWriteCommand(command) {
  if (!command || command.type !== "goalport.coordinateTurn") return "The command is not a coordinate turn.";
  if (command.runtimeMode !== "approval-required") return "runtimeMode must be approval-required.";
  if (command.approvalPolicy !== "never") {
    return "approvalPolicy must be never. approval-required alone asks for every read.";
  }
  if (!command.sandboxPolicy || command.sandboxPolicy.type !== "workspaceWrite") {
    return "sandboxPolicy.type must be workspaceWrite.";
  }
  const strategy = command.workspaceStrategy;
  const worktreePath = strategy && typeof strategy.worktreePath === "string" ? strategy.worktreePath.trim() : "";
  if (!strategy || strategy.type !== "existing_worktree" || worktreePath.length === 0) {
    return "A write turn must run in an existing worktree.";
  }
  if (!isAbsoluteWorktreePath(worktreePath)) {
    return "A write turn needs an absolute worktree path.";
  }
  return null;
}

module.exports = { guardCoordinateCommand, roleOfCommandId, guardCoordinateWriteCommand };
