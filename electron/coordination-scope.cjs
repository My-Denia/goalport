"use strict";

// In-memory authorization scope for the main process. The renderer keeps only
// a mirror; this module is the single budget authority for scoped launches.
// The state is deliberately session-bound: it is never persisted, it dies with
// the app, and a generation id pins every launch to the exact authorization
// that produced it.
const { hasClaim, isValidCommandId, takeGrant, writeGrant } = require("./cli-coordinate.cjs");

const MIN_TURNS = 2;
const MAX_TURNS = 32;
const EXHAUSTED = "All authorized model turns were used, so this stopped.";
const REVOKED = "The authorized harness scope was revoked or replaced, so no model turn was sent.";
const NOT_A_ROLE_TURN = "The command is not an authorized plan or check turn, so nothing was sent.";
const NOT_IN_SCOPE = "The harness is not in the authorized scope, so no model turn was sent.";
const INVALID_ID = "The command id is not valid, so nothing was sent.";
const NO_STATE_DIR = "The harness state directory is unavailable, so nothing was sent.";
const ROLE_PREFIX = /^coordinate-(plan|review)-/;

let scope = null;
let lastGeneration = 0;

function clampTurns(value) {
  const parsed = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : Number.NaN;
  if (Number.isNaN(parsed)) return MIN_TURNS;
  return Math.min(MAX_TURNS, Math.max(MIN_TURNS, parsed));
}

// Authorize one scope: membership is a closed list of instance ids, the model
// turn budget is clamped to [2, 32], and every authorize mints a new
// generation. Callers must have refused apiKey-typed or unknown instances
// against a fresh discovery first — this module only enforces shape.
function authorize(instances, maxTurns) {
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
  const turns = clampTurns(maxTurns);
  scope = { generation: ++lastGeneration, instances: chosen, maxTurns: turns, remaining: turns };
  return { ok: true, generation: scope.generation, remaining: scope.remaining };
}

function current() {
  if (!scope) return null;
  return { generation: scope.generation, instances: [...scope.instances], maxTurns: scope.maxTurns, remaining: scope.remaining };
}

// "Stop allowing": the scope clears immediately. In-flight reservations keep
// settling under their original generation; nothing is retroactively revived.
function revoke() {
  scope = null;
}

function stateDirOf(stateDir) {
  return typeof stateDir === "string" && stateDir ? stateDir : "";
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
  // Step 2: only plan and check turns exist in the authorized action set.
  if (!ROLE_PREFIX.test(commandId)) {
    return { ok: false, errorText: NOT_A_ROLE_TURN, turnsRemaining: scope.remaining };
  }
  // Step 3: the instance must be a member of the authorized scope.
  const instanceId = typeof command?.modelSelection?.instanceId === "string" ? command.modelSelection.instanceId : "";
  if (!scope.instances.includes(instanceId)) {
    return { ok: false, errorText: NOT_IN_SCOPE, turnsRemaining: scope.remaining };
  }
  // Step 4: an existing claim means the stored-result semantics apply — no
  // grant write, no budget check, no deduction.
  if (hasClaim(dir, commandId)) {
    return { ok: true, existing: true, turnsRemaining: scope.remaining };
  }
  // Step 5: only fresh reservations spend the budget.
  if (scope.remaining <= 0) {
    return { ok: false, errorText: EXHAUSTED, stopCode: "scope-exhausted", scopeExhausted: true, turnsRemaining: 0 };
  }
  // Step 6: write the grant line and record whether the scope owns it. A
  // pre-existing (hand-written) line is charged but never owned.
  const insertedByScope = writeGrant(dir, commandId);
  scope.remaining -= 1;
  return {
    ok: true,
    existing: false,
    turnsRemaining: scope.remaining,
    reservation: { commandId, instanceId, scopeGeneration, insertedByScope },
  };
}

// A refund never credits a scope that was replaced or revoked: a late
// completion settles under its own reservation generation or not at all.
function refund(reservation) {
  if (!scope || scope.generation !== reservation.scopeGeneration) return;
  scope.remaining = Math.min(scope.maxTurns, scope.remaining + 1);
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
