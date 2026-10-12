"use strict";

// In-memory authorization scope for the main process. The renderer keeps only
// a mirror; this module is the single budget authority for scoped launches.
// The state is deliberately session-bound: it is never persisted, it dies with
// the app, and a generation id pins every launch to the exact authorization
// that produced it.
const path = require("node:path");
const { hasClaim, isValidCommandId, takeGrant, writeGrant } = require("./cli-coordinate.cjs");
const { roleOfCommandId } = require("./coordinate-guard.cjs");

const MIN_TURNS = 2;
const MAX_TURNS = 32;
const MIN_WRITE_TURNS = 1;
const MAX_WRITE_TURNS = 8;
const EXHAUSTED = "All authorized model turns were used, so this stopped.";
const WRITE_EXHAUSTED = "All authorized workspace-change turns were used, so this stopped.";
const REVOKED = "The authorized harness scope was revoked or replaced, so no model turn was sent.";
const NOT_A_ROLE_TURN = "The command is not an authorized coordination turn, so nothing was sent.";
const WRITE_SCOPE_REQUIRED = "This execution turn needs an explicit workspace-change authorization, so nothing was sent.";
const WRITE_SANDBOX_REQUIRED = "An execution turn must use the workspaceWrite sandbox, so nothing was sent.";
const WRITE_ROOT_REQUIRED = "An execution turn must use the authorized workspace, so nothing was sent.";
const READ_SANDBOX_REQUIRED = "A planning, checking, or verification turn must use the readOnly sandbox, so nothing was sent.";
const INVALID_WRITE_AUTHORIZATION = "The workspace-change authorization is invalid, so nothing was authorized.";
const NOT_IN_SCOPE = "The harness is not in the authorized scope, so no model turn was sent.";
const INVALID_ID = "The command id is not valid, so nothing was sent.";
const NO_STATE_DIR = "The harness state directory is unavailable, so nothing was sent.";

let scope = null;
let lastGeneration = 0;

function clampTurns(value) {
  const parsed = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : Number.NaN;
  if (Number.isNaN(parsed)) return MIN_TURNS;
  return Math.min(MAX_TURNS, Math.max(MIN_TURNS, parsed));
}

function clampWriteTurns(value) {
  const parsed = Math.floor(value);
  return Math.min(MAX_WRITE_TURNS, Math.max(MIN_WRITE_TURNS, parsed));
}

function canonicalWriteInstances(instances) {
  if (!Array.isArray(instances)) return null;
  const chosen = [];
  const seen = new Set();
  for (const instance of instances) {
    if (typeof instance !== "string") return null;
    const trimmed = instance.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    chosen.push(trimmed);
  }
  return chosen.length > 0 ? chosen : null;
}

function normalizeWriteAuthorization(write) {
  if (!write || typeof write !== "object" || Array.isArray(write)) return null;
  const instances = canonicalWriteInstances(write.instances);
  if (!instances || typeof write.maxTurns !== "number" || !Number.isFinite(write.maxTurns)) return null;
  if (typeof write.workspaceRoot !== "string" || !path.isAbsolute(write.workspaceRoot)) return null;
  const maxTurns = clampWriteTurns(write.maxTurns);
  return { instances, maxTurns, remaining: maxTurns, workspaceRoot: write.workspaceRoot };
}

// Authorize one scope: read membership remains a closed list with its historic
// [2, 32] budget. An explicit write dimension has an independent closed list,
// root binding and [1, 8] finite budget. Membership still requires the caller
// to check fresh discovery and subscription/api-key eligibility; this pure
// module only enforces request shape. A malformed write request never replaces
// the active generation.
function authorize(instances, maxTurns, write) {
  const chosen = [];
  const seen = new Set();
  if (Array.isArray(instances)) {
    for (const instance of instances) {
      // A non-string entry is a malformed scope request, not an id to skip.
      if (typeof instance !== "string") {
        return { ok: false, generation: 0, remaining: 0, errorText: "No harness was chosen, so nothing was authorized." };
      }
      const trimmed = instance.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      chosen.push(trimmed);
    }
  }
  if (chosen.length === 0) {
    return { ok: false, generation: 0, remaining: 0, errorText: "No harness was chosen, so nothing was authorized." };
  }

  // undefined is the legacy no-write call shape. Every explicitly supplied
  // value (including null) must be a complete, valid write authorization.
  const writeScope = write === undefined ? null : normalizeWriteAuthorization(write);
  if (write !== undefined && !writeScope) {
    return { ok: false, generation: 0, remaining: 0, errorText: INVALID_WRITE_AUTHORIZATION };
  }

  const turns = clampTurns(maxTurns);
  const nextScope = { generation: lastGeneration + 1, instances: chosen, maxTurns: turns, remaining: turns };
  if (writeScope) nextScope.write = writeScope;
  lastGeneration = nextScope.generation;
  scope = nextScope;
  return {
    ok: true,
    generation: scope.generation,
    remaining: scope.remaining,
    ...(scope.write ? { writeTurnsRemaining: scope.write.remaining } : {}),
  };
}

function current() {
  if (!scope) return null;
  return {
    generation: scope.generation,
    instances: [...scope.instances],
    maxTurns: scope.maxTurns,
    remaining: scope.remaining,
    ...(scope.write ? { write: { ...scope.write, instances: [...scope.write.instances] } } : {}),
  };
}

// "Stop allowing": the scope clears immediately. In-flight reservations keep
// settling under their original generation; nothing is retroactively revived.
function revoke() {
  scope = null;
}

function stateDirOf(stateDir) {
  return typeof stateDir === "string" && stateDir ? stateDir : "";
}

function remainingFields(readRemaining) {
  return {
    turnsRemaining: readRemaining,
    ...(scope?.write ? { writeTurnsRemaining: scope.write.remaining } : {}),
  };
}

function roleDimensionError(role, command) {
  if (role === "execute") {
    if (!scope.write) return WRITE_SCOPE_REQUIRED;
    if (command?.sandboxPolicy?.type !== "workspaceWrite") return WRITE_SANDBOX_REQUIRED;
    const strategy = command?.workspaceStrategy;
    const worktreePath = typeof strategy?.worktreePath === "string" ? strategy.worktreePath.trim() : "";
    if (
      strategy?.type !== "existing_worktree" ||
      !worktreePath ||
      !path.isAbsolute(worktreePath) ||
      path.resolve(worktreePath) !== path.resolve(scope.write.workspaceRoot)
    ) {
      return WRITE_ROOT_REQUIRED;
    }
    return null;
  }
  if (command?.sandboxPolicy?.type !== "readOnly") return READ_SANDBOX_REQUIRED;
  return null;
}

// The reservation path, in the load-bearing validation order. Every rejection
// before step 6 has zero side effects: no ledger peek effect, no claim query
// effect, no grant write, no budget change.
function reserve(command, scopeGeneration, stateDir) {
  // Step 0: the canonical command-id rule, before anything else. An id with a
  // newline or a space never reaches the grant file, the ledger or the budget.
  const commandId = isValidCommandId(command?.commandId);
  if (!commandId) {
    return { ok: false, errorText: INVALID_ID, turnsRemaining: null };
  }
  const dir = stateDirOf(stateDir);
  if (!dir) {
    return { ok: false, errorText: NO_STATE_DIR, turnsRemaining: null };
  }
  // Step 1: the launch carries the generation captured at authorize. A stale
  // or revoked generation is refused as scope-revoked — a scoped launch never
  // degrades into a legacy launch.
  if (!scope || scope.generation !== scopeGeneration) {
    return { ok: false, errorText: REVOKED, stopCode: "scope-revoked", turnsRemaining: null };
  }
  // Step 2: only the canonical plan/review/execute/audit role family is
  // reserved by this authority.
  const role = roleOfCommandId(commandId);
  if (!role) {
    return { ok: false, errorText: NOT_A_ROLE_TURN, ...remainingFields(scope.remaining) };
  }
  // Step 2.5: independently enforce role/sandbox pairing and explicit write
  // consent/root binding before membership, claim lookup, or budget access.
  const pairingError = roleDimensionError(role, command);
  if (pairingError) {
    return { ok: false, errorText: pairingError, ...remainingFields(scope.remaining) };
  }
  const dimension = role === "execute" ? "write" : "read";
  const budget = dimension === "write" ? scope.write : scope;
  // Step 3: the instance must belong to the matching authorization dimension.
  const instanceId = typeof command?.modelSelection?.instanceId === "string" ? command.modelSelection.instanceId : "";
  const members = dimension === "write" ? scope.write.instances : scope.instances;
  if (!members.includes(instanceId)) {
    return { ok: false, errorText: NOT_IN_SCOPE, ...remainingFields(scope.remaining) };
  }
  // Step 4: an existing claim means the stored-result semantics apply — no
  // grant write, no budget check, no deduction.
  if (hasClaim(dir, commandId)) {
    return { ok: true, existing: true, ...remainingFields(scope.remaining) };
  }
  // Step 5: only fresh reservations spend their own dimension's budget.
  if (budget.remaining <= 0) {
    return {
      ok: false,
      errorText: dimension === "write" ? WRITE_EXHAUSTED : EXHAUSTED,
      stopCode: "scope-exhausted",
      scopeExhausted: true,
      ...remainingFields(scope.remaining),
    };
  }
  // Step 6: write the grant line and decrement only the selected dimension.
  // A pre-existing (hand-written) line is charged but never owned.
  const insertedByScope = writeGrant(dir, commandId);
  budget.remaining -= 1;
  return {
    ok: true,
    existing: false,
    ...remainingFields(scope.remaining),
    reservation: {
      commandId,
      instanceId,
      scopeGeneration,
      insertedByScope,
      ...(dimension === "write" ? { dimension } : {}),
    },
  };
}

// A refund never credits a scope that was replaced or revoked: a late
// completion settles under its original generation or not at all. Old
// reservations without a dimension remain read reservations by definition.
function refund(reservation) {
  if (!scope || scope.generation !== reservation.scopeGeneration) return;
  const budget = reservation.dimension === "write" ? scope.write : scope;
  if (!budget) return;
  budget.remaining = Math.min(budget.maxTurns, budget.remaining + 1);
}

// The reservation/cleanup decision table. Called for every completion of a
// fresh reservation (claim hits never reserve, so they never settle):
//  - a claim file (whatever the ledger says) means the turn reached its claim:
//    the charge stands and claim/ledger own everything else;
//  - proven-not-sent and no claim refunds the budget unconditionally — the
//    line's ownership governs deletion, not the refund;
//  - unknown dispatch keeps its charge; in both rows only a scope-inserted
//    line is removed, and only while it is provably unconsumed.
function settle(reservation, outcome, stateDir) {
  if (!reservation) return;
  const dir = stateDirOf(stateDir);
  if (hasClaim(dir, reservation.commandId)) return;
  if (outcome?.dispatched === false || outcome?.neverStarted === true) {
    refund(reservation);
  }
  if (reservation.insertedByScope) takeGrant(dir, reservation.commandId);
}

module.exports = { authorize, current, revoke, reserve, settle };
