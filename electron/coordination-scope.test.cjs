const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const coordinationScope = require("./coordination-scope.cjs");
const { launchOne } = require("./coordinate-service.cjs");
const { runCliTurn } = require("./cli-coordinate.cjs");

const { authorize, current, reserve, revoke, settle } = coordinationScope;

const WRITE_ROOT = path.resolve(os.tmpdir(), "goalport-authorized-workspace");

function command(instanceId, commandId = `coordinate-plan-${instanceId}`) {
  return {
    commandId,
    type: "goalport.coordinateTurn",
    modelSelection: { instanceId, model: "gpt-6.1-sol" },
    runtimeMode: "approval-required",
    approvalPolicy: "never",
    sandboxPolicy: { type: "readOnly" },
    workspaceStrategy: { type: "existing_worktree", worktreePath: "/work/goal" },
    initialMessage: { text: "Plan only." },
  };
}

function writeCommand(instanceId, commandId = `coordinate-execute-${instanceId}`, worktreePath = WRITE_ROOT) {
  return {
    ...command(instanceId, commandId),
    sandboxPolicy: { type: "workspaceWrite" },
    workspaceStrategy: { type: "existing_worktree", worktreePath },
  };
}

function writeAuthorization(instances = ["codex"], maxTurns = 2, workspaceRoot = WRITE_ROOT) {
  return { instances, maxTurns, workspaceRoot };
}

function freshScope(instances = ["codex"], maxTurns = 4, write) {
  revoke();
  const granted = authorize(instances, maxTurns, write);
  assert.equal(granted.ok, true);
  return granted;
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "goalport-scope-"));
}

function snapshotDir(directory) {
  const out = {};
  const visit = (prefix) => {
    for (const entry of fs.readdirSync(prefix, { withFileTypes: true })) {
      const full = path.join(prefix, entry.name);
      if (entry.isDirectory()) visit(full);
      else out[path.relative(directory, full)] = fs.readFileSync(full, "utf8");
    }
  };
  if (fs.existsSync(directory)) visit(directory);
  return out;
}

function scopedRuntime(directory, run) {
  return {
    stateDir: directory,
    async discover() {
      return { ok: true, providers: [] };
    },
    async prepare() {
      return { ok: true, disposition: "deny", messageDispatched: false, errorText: "" };
    },
    run,
  };
}

const CODEX_REPLY = '{"type":"item.completed","item":{"type":"agent_message","text":"Bounded plan."}}\n';

test("authorize starts at generation 1 with the full budget remaining", () => {
  try {
    const granted = authorize(["codex", "claude"], 4);
    assert.equal(granted.ok, true);
    assert.equal(granted.generation, 1);
    assert.equal(granted.remaining, 4);
    assert.deepEqual(granted, { ok: true, generation: 1, remaining: 4 });
    assert.deepEqual(current(), { generation: 1, instances: ["codex", "claude"], maxTurns: 4, remaining: 4 });
  } finally {
    revoke();
  }
});

test("authorize refuses an empty or malformed instance list", () => {
  try {
    for (const bad of [[], ["  "], ["codex", 42], "codex", undefined]) {
      const refused = authorize(bad, 4);
      assert.equal(refused.ok, false, JSON.stringify(bad));
      assert.match(refused.errorText, /No harness was chosen/);
    }
    assert.equal(current(), null);
    const deduped = authorize(["codex", "codex", " claude "], 4);
    assert.equal(deduped.ok, true);
    assert.deepEqual(current().instances, ["codex", "claude"]);
  } finally {
    revoke();
  }
});

test("each fresh reservation deducts one turn, writes the grant line, and records ownership", () => {
  const directory = tempDir();
  try {
    const granted = freshScope(["codex"], 3);
    const first = reserve(command("codex"), granted.generation, directory);
    assert.equal(first.ok, true);
    assert.equal(first.existing, false);
    assert.equal(first.turnsRemaining, 2);
    assert.deepEqual(first.reservation, {
      commandId: "coordinate-plan-codex",
      instanceId: "codex",
      scopeGeneration: granted.generation,
      insertedByScope: true,
    });
    assert.equal(fs.readFileSync(path.join(directory, "send-authorization"), "utf8"), "coordinate-plan-codex\n");
    const second = reserve(command("codex", "coordinate-review-codex"), granted.generation, directory);
    assert.equal(second.turnsRemaining, 1);
    assert.equal(second.reservation.commandId, "coordinate-review-codex");
    assert.equal(current().remaining, 1);
  } finally {
    revoke();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("an exhausted scope refuses a fresh reservation with zero side effects", () => {
  const directory = tempDir();
  try {
    const granted = freshScope(["codex"], 2);
    assert.equal(reserve(command("codex", "coordinate-plan-a"), granted.generation, directory).ok, true);
    assert.equal(reserve(command("codex", "coordinate-review-b"), granted.generation, directory).ok, true);
    assert.equal(current().remaining, 0);
    const before = snapshotDir(directory);
    const rejected = reserve(command("codex", "coordinate-plan-c"), granted.generation, directory);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.stopCode, "scope-exhausted");
    assert.equal(rejected.scopeExhausted, true);
    assert.equal(rejected.turnsRemaining, 0);
    assert.match(rejected.errorText, /authorized model turns were used/);
    assert.deepEqual(snapshotDir(directory), before);
    assert.equal(current().remaining, 0);
  } finally {
    revoke();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("an invalid command id is rejected before any side effect, including through a launch", async () => {
  const directory = tempDir();
  try {
    const granted = freshScope(["codex"], 4);
    for (const bad of [
      "coordinate-plan-a\ncoordinate-review-b",
      "coordinate-plan codex",
      "",
      "coordinate/plan-x",
    ]) {
      const before = snapshotDir(directory);
      const rejected = reserve(command("codex", bad), 1, directory);
      assert.equal(rejected.ok, false, JSON.stringify(bad));
      assert.match(rejected.errorText, /not valid/, JSON.stringify(bad));
      assert.deepEqual(snapshotDir(directory), before, JSON.stringify(bad));
      assert.equal(current().remaining, 4, JSON.stringify(bad));
    }
    let runs = 0;
    const result = await launchOne({ GOALPORT_COORDINATE_SEND: "1" }, scopedRuntime(directory, async () => {
      runs += 1;
      return { ok: true, text: "never", errorText: "", messageDispatched: true };
    }), command("codex", "coordinate-plan-a\ncoordinate-review-b"), "g", { scope: coordinationScope, scopeGeneration: granted.generation });
    assert.equal(runs, 0);
    assert.equal(result.launched, false);
    assert.match(result.errorText, /not valid/);
    assert.deepEqual(snapshotDir(directory), {});
    assert.equal(current().remaining, 4);
  } finally {
    revoke();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("an unknown coordination role is refused with zero side effects", () => {
  const directory = tempDir();
  try {
    const granted = freshScope(["codex"], 4);
    const before = snapshotDir(directory);
    const rejected = reserve(command("codex", "coordinate-admin-codex"), granted.generation, directory);
    assert.equal(rejected.ok, false);
    assert.match(rejected.errorText, /not an authorized coordination turn/);
    assert.deepEqual(snapshotDir(directory), before);
    assert.equal(current().remaining, 4);
  } finally {
    revoke();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("an instance outside the authorized scope is refused with zero side effects", () => {
  const directory = tempDir();
  try {
    const granted = freshScope(["codex"], 4);
    const before = snapshotDir(directory);
    const rejected = reserve(command("claude", "coordinate-plan-claude"), granted.generation, directory);
    assert.equal(rejected.ok, false);
    assert.match(rejected.errorText, /not in the authorized scope/);
    assert.deepEqual(snapshotDir(directory), before);
    assert.equal(current().remaining, 4);
  } finally {
    revoke();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("a ledger entry without a claim takes the fresh-reservation path and the turn runs (decision row 2)", async () => {
  const directory = tempDir();
  try {
    const granted = freshScope(["codex"], 4);
    fs.writeFileSync(path.join(directory, "sent-turns.json"), JSON.stringify({ "coordinate-plan-codex": { ok: true, text: "stale" } }));
    let spawns = 0;
    const runtime = scopedRuntime(directory, (received) => runCliTurn(received, {
      stateDir: directory,
      spawnTurn: async () => {
        spawns += 1;
        return { code: 0, stdout: CODEX_REPLY };
      },
    }));
    const result = await launchOne({ GOALPORT_COORDINATE_SEND: "1" }, runtime, command("codex"), "g", { scope: coordinationScope, scopeGeneration: granted.generation });
    // No invented replay rule: the stale ledger entry does not stop a fresh turn.
    assert.equal(spawns, 1);
    assert.equal(result.launched, true);
    assert.equal(result.text, "Bounded plan.");
    assert.equal(result.turnsRemaining, 3);
    assert.equal(current().remaining, 3);
    // The scope wrote the grant line and the claimed turn consumed it.
    assert.equal(fs.existsSync(path.join(directory, "send-authorization")), false);
    assert.equal(fs.existsSync(path.join(directory, "claim-coordinate-plan-codex")), true);
  } finally {
    revoke();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("a claim hit costs nothing: no budget check, no write, no deduction (decision row 1)", () => {
  const directory = tempDir();
  try {
    const granted = freshScope(["codex"], 2);
    // Drain the budget completely with two charged reservations.
    assert.equal(reserve(command("codex", "coordinate-plan-a"), granted.generation, directory).ok, true);
    assert.equal(reserve(command("codex", "coordinate-review-b"), granted.generation, directory).ok, true);
    assert.equal(current().remaining, 0);
    fs.writeFileSync(path.join(directory, "claim-coordinate-plan-codex"), "");
    const before = snapshotDir(directory);
    const free = reserve(command("codex"), granted.generation, directory);
    assert.equal(free.ok, true);
    assert.equal(free.existing, true);
    assert.equal(free.reservation, undefined);
    assert.equal(current().remaining, 0);
    assert.deepEqual(snapshotDir(directory), before);
  } finally {
    revoke();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("a synchronous throw between write and run deletes the owned line and refunds (decision row 3)", async () => {
  const directory = tempDir();
  try {
    const granted = freshScope(["codex"], 4);
    const result = await launchOne({ GOALPORT_COORDINATE_SEND: "1" }, scopedRuntime(directory, () => {
      // A synchronous throw cannot have claimed or spawned: proven not sent.
      throw new Error("synchronous boom before the turn started");
    }), command("codex"), "g", { scope: coordinationScope, scopeGeneration: granted.generation });
    assert.equal(result.launched, false);
    assert.equal(result.dispatched, null);
    assert.equal(current().remaining, 4);
    assert.equal(fs.existsSync(path.join(directory, "send-authorization")), false);
  } finally {
    revoke();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("settle leaves a manual line alone and still refunds it (decision rows 3 and 6)", () => {
  const directory = tempDir();
  try {
    const granted = freshScope(["codex"], 4);
    fs.writeFileSync(path.join(directory, "send-authorization"), "coordinate-plan-codex\n");
    const reserved = reserve(command("codex"), granted.generation, directory);
    assert.equal(reserved.reservation.insertedByScope, false);
    assert.equal(current().remaining, 3);
    settle(reserved.reservation, { dispatched: false }, directory);
    assert.equal(current().remaining, 4);
    assert.equal(fs.readFileSync(path.join(directory, "send-authorization"), "utf8"), "coordinate-plan-codex\n");
  } finally {
    revoke();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("revoke clears the scope; a stale-generation launch is refused as revoked (decision row 5)", async () => {
  const directory = tempDir();
  try {
    const granted = freshScope(["codex"], 4);
    revoke();
    assert.equal(current(), null);
    const after = reserve(command("codex"), granted.generation, directory);
    assert.equal(after.ok, false);
    assert.equal(after.stopCode, "scope-revoked");
    assert.deepEqual(snapshotDir(directory), {});
    // A launch carrying a stale generation never degrades into a legacy launch.
    const live = freshScope(["codex"], 4);
    let runs = 0;
    const result = await launchOne({ GOALPORT_COORDINATE_SEND: "1" }, scopedRuntime(directory, async () => {
      runs += 1;
      return { ok: true, text: "never", errorText: "" };
    }), command("codex"), "g", { scope: coordinationScope, scopeGeneration: granted.generation });
    assert.equal(runs, 0);
    assert.equal(live.generation, granted.generation + 1);
    assert.equal(result.stopCode, "scope-revoked");
    assert.match(result.errorText, /revoked or replaced/);
    assert.equal(result.dispatched, false);
    assert.equal(current().remaining, 4);
    assert.deepEqual(snapshotDir(directory), {});
  } finally {
    revoke();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("re-authorizing mints the next generation and never resurrects the old one", () => {
  try {
    // Generations are monotonic per process: each authorize mints the next
    // one, and a scope captured under the previous generation is never
    // resurrected. (The very first generation of a fresh process is pinned
    // to 1 by the authorize test above.)
    const first = authorize(["codex"], 4);
    const second = authorize(["codex", "claude"], 6);
    assert.equal(second.generation, first.generation + 1);
    assert.deepEqual(current(), { generation: second.generation, instances: ["codex", "claude"], maxTurns: 6, remaining: 6 });
    const stale = reserve(command("codex"), first.generation, "/nonexistent-goalport-scope");
    assert.equal(stale.ok, false);
    assert.equal(stale.stopCode, "scope-revoked");
  } finally {
    revoke();
  }
});

test("maxTurns is clamped into [2, 32]", () => {
  try {
    assert.equal(authorize(["codex"], 1).remaining, 2);
    assert.equal(current().maxTurns, 2);
    assert.equal(authorize(["codex"], 99).remaining, 32);
    assert.equal(current().maxTurns, 32);
    assert.equal(authorize(["codex"], 4).remaining, 4);
    assert.equal(authorize(["codex"], Number.NaN).remaining, 2);
  } finally {
    revoke();
  }
});

test("the guard leaf loads in both fresh-require orders and keeps its four checks", () => {
  const moduleNames = ["coordinate-service.cjs", "cli-coordinate.cjs", "coordinate-guard.cjs", "coordination-scope.cjs"];
  const dropCache = () => {
    for (const name of moduleNames) delete require.cache[require.resolve(`./${name}`)];
  };
  try {
    for (const order of [["cli-coordinate.cjs", "coordinate-service.cjs"], ["coordinate-service.cjs", "cli-coordinate.cjs"]]) {
      dropCache();
      // The fresh-require order alternates; after both requires the graph is
      // fully loaded with no cycle and the leaf guard is intact.
      require(`./${order[0]}`);
      require(`./${order[1]}`);
      const service = require("./coordinate-service.cjs");
      const cli = require("./cli-coordinate.cjs");
      assert.equal(typeof require("./coordinate-guard.cjs").guardCoordinateCommand, "function");
      assert.equal(typeof service.guardCoordinateCommand, "function");
      assert.equal(typeof cli.runCliTurn, "function");
      const good = command("codex");
      assert.equal(service.guardCoordinateCommand(good), null);
      for (const [broken, expected] of [
        [{ ...good, type: "message.dispatch" }, /not a coordinate turn/],
        [{ ...good, runtimeMode: "auto" }, /runtimeMode must be approval-required/],
        [{ ...good, approvalPolicy: "on-failure" }, /approvalPolicy must be never/],
        [{ ...good, sandboxPolicy: { type: "workspace-write" } }, /readOnly/],
      ]) {
        assert.match(service.guardCoordinateCommand(broken), expected);
      }
      // The shared command-id rule stayed one rule in both orders.
      assert.equal(cli.isValidCommandId("coordinate-plan-codex"), "coordinate-plan-codex");
      assert.equal(cli.isValidCommandId("coordinate-plan-a\ncoordinate-review-b"), "");
    }
  } finally {
    dropCache();
  }
});

test("explicit write authorization has its own canonical members, root, and clamped [1, 8] budget", () => {
  try {
    const root = path.join(os.tmpdir(), "goalport-write-root");
    const granted = authorize([" reader ", "reader"], 2, writeAuthorization([" writer ", "writer"], 0, root));
    assert.equal(granted.ok, true);
    assert.equal(granted.remaining, 2);
    assert.equal(granted.writeTurnsRemaining, 1);
    assert.deepEqual(current(), {
      generation: granted.generation,
      instances: ["reader"],
      maxTurns: 2,
      remaining: 2,
      write: { instances: ["writer"], maxTurns: 1, remaining: 1, workspaceRoot: root },
    });
    const mirror = current();
    mirror.instances.push("mutated-read");
    mirror.write.instances.push("mutated-write");
    assert.deepEqual(current().instances, ["reader"]);
    assert.deepEqual(current().write.instances, ["writer"]);

    const upper = authorize(["reader"], 2, writeAuthorization(["writer"], 99, root));
    assert.equal(upper.writeTurnsRemaining, 8);
    assert.equal(current().write.maxTurns, 8);
  } finally {
    revoke();
  }
});

test("malformed explicit write authorization leaves the live generation unchanged", () => {
  try {
    const root = path.join(os.tmpdir(), "goalport-write-root");
    const first = authorize(["reader"], 2, writeAuthorization(["writer"], 3, root));
    const before = current();
    for (const bad of [
      null,
      {},
      writeAuthorization([], 2, root),
      writeAuthorization(["writer", 42], 2, root),
      writeAuthorization(["  "], 2, root),
      writeAuthorization(["writer"], Number.POSITIVE_INFINITY, root),
      writeAuthorization(["writer"], "2", root),
      writeAuthorization(["writer"], 2, "relative/workspace"),
      writeAuthorization(["writer"], 2, ""),
    ]) {
      const refused = authorize(["replacement"], 8, bad);
      assert.equal(refused.ok, false);
      assert.match(refused.errorText, /workspace-change authorization is invalid/);
      assert.deepEqual(current(), before);
    }
    const next = authorize(["replacement"], 8, writeAuthorization(["writer-2"], 1, root));
    assert.equal(next.generation, first.generation + 1);
  } finally {
    revoke();
  }
});

test("a no-write scope cannot reserve execution and keeps the legacy read-only response shape", () => {
  const directory = tempDir();
  try {
    const granted = freshScope(["codex"], 4);
    assert.deepEqual(granted, { ok: true, generation: granted.generation, remaining: 4 });
    const before = snapshotDir(directory);
    const rejected = reserve(writeCommand("codex"), granted.generation, directory);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.errorText, "This execution turn needs an explicit workspace-change authorization, so nothing was sent.");
    assert.equal(rejected.turnsRemaining, 4);
    assert.equal("writeTurnsRemaining" in rejected, false);
    assert.deepEqual(current(), { generation: granted.generation, instances: ["codex"], maxTurns: 4, remaining: 4 });
    assert.deepEqual(snapshotDir(directory), before);
  } finally {
    revoke();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("role/sandbox pairing, pinned root, and per-dimension membership refuse before grant effects", () => {
  const directory = tempDir();
  try {
    const granted = freshScope(["reader"], 2, writeAuthorization(["writer"], 2));
    const before = snapshotDir(directory);
    const noWriteSandbox = reserve(command("writer", "coordinate-execute-writer"), granted.generation, directory);
    assert.equal(noWriteSandbox.errorText, "An execution turn must use the workspaceWrite sandbox, so nothing was sent.");
    const wrongRoot = reserve(writeCommand("reader", "coordinate-execute-reader", `${WRITE_ROOT}-other`), granted.generation, directory);
    assert.equal(wrongRoot.errorText, "An execution turn must use the authorized workspace, so nothing was sent.");
    const wrongReadSandbox = reserve(writeCommand("reader", "coordinate-plan-reader"), granted.generation, directory);
    assert.equal(wrongReadSandbox.errorText, "A planning, checking, or verification turn must use the readOnly sandbox, so nothing was sent.");
    const wrongWriteMember = reserve(writeCommand("reader", "coordinate-execute-not-a-member"), granted.generation, directory);
    assert.equal(wrongWriteMember.errorText, "The harness is not in the authorized scope, so no model turn was sent.");
    const wrongReadMember = reserve(command("writer", "coordinate-review-writer"), granted.generation, directory);
    assert.equal(wrongReadMember.errorText, "The harness is not in the authorized scope, so no model turn was sent.");
    assert.equal(current().remaining, 2);
    assert.equal(current().write.remaining, 2);
    assert.deepEqual(snapshotDir(directory), before);
  } finally {
    revoke();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("write-reservation validation keeps canonical-id and generation checks ahead of role checks", () => {
  const directory = tempDir();
  try {
    const granted = freshScope(["reader"], 2, writeAuthorization(["writer"], 2));
    const before = snapshotDir(directory);
    const invalidId = reserve(writeCommand("writer", "coordinate-execute-writer\ncoordinate-audit-writer"), granted.generation + 1, directory);
    assert.equal(invalidId.errorText, "The command id is not valid, so nothing was sent.");
    const stale = reserve(command("reader", "coordinate-admin-reader"), granted.generation + 1, directory);
    assert.equal(stale.stopCode, "scope-revoked");
    assert.equal(stale.errorText, "The authorized harness scope was revoked or replaced, so no model turn was sent.");
    assert.deepEqual(snapshotDir(directory), before);
    assert.equal(current().write.remaining, 2);
  } finally {
    revoke();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("read and write reservations spend independent budgets; read budget two remains valid", () => {
  const directory = tempDir();
  try {
    const granted = freshScope(["reader"], 2, writeAuthorization(["writer"], 1));
    const plan = reserve(command("reader", "coordinate-plan-reader"), granted.generation, directory);
    assert.equal(plan.turnsRemaining, 1);
    assert.equal(plan.writeTurnsRemaining, 1);
    assert.equal("dimension" in plan.reservation, false);
    const review = reserve(command("reader", "coordinate-review-reader"), granted.generation, directory);
    assert.equal(review.turnsRemaining, 0);
    assert.equal(review.writeTurnsRemaining, 1);
    const execution = reserve(writeCommand("writer"), granted.generation, directory);
    assert.equal(execution.ok, true);
    assert.equal(execution.turnsRemaining, 0);
    assert.equal(execution.writeTurnsRemaining, 0);
    assert.equal(execution.reservation.dimension, "write");
    assert.equal(current().remaining, 0);
    assert.equal(current().write.remaining, 0);

    const readExhausted = reserve(command("reader", "coordinate-plan-after-read-exhaustion"), granted.generation, directory);
    assert.equal(readExhausted.errorText, "All authorized model turns were used, so this stopped.");
    assert.equal(readExhausted.turnsRemaining, 0);
    assert.equal(readExhausted.writeTurnsRemaining, 0);
    const writeExhausted = reserve(writeCommand("writer", "coordinate-execute-after-write-exhaustion"), granted.generation, directory);
    assert.equal(writeExhausted.errorText, "All authorized workspace-change turns were used, so this stopped.");
    assert.equal(writeExhausted.turnsRemaining, 0);
    assert.equal(writeExhausted.writeTurnsRemaining, 0);
    assert.equal(writeExhausted.stopCode, "scope-exhausted");
  } finally {
    revoke();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("a write claim hit remains free and is checked before the exhausted write budget", () => {
  const directory = tempDir();
  try {
    const granted = freshScope(["reader"], 2, writeAuthorization(["writer"], 1));
    const charged = reserve(writeCommand("writer", "coordinate-execute-charged"), granted.generation, directory);
    assert.equal(charged.writeTurnsRemaining, 0);
    fs.writeFileSync(path.join(directory, "claim-coordinate-execute-claimed"), "");
    const before = snapshotDir(directory);
    const free = reserve(writeCommand("writer", "coordinate-execute-claimed"), granted.generation, directory);
    assert.equal(free.ok, true);
    assert.equal(free.existing, true);
    assert.equal(free.turnsRemaining, 2);
    assert.equal(free.writeTurnsRemaining, 0);
    assert.equal(free.reservation, undefined);
    assert.deepEqual(snapshotDir(directory), before);
    assert.equal(current().write.remaining, 0);
  } finally {
    revoke();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("a write ledger entry without a claim still makes a fresh charged reservation", () => {
  const directory = tempDir();
  try {
    const granted = freshScope(["reader"], 2, writeAuthorization(["writer"], 2));
    fs.writeFileSync(path.join(directory, "sent-turns.json"), JSON.stringify({ "coordinate-execute-ledger": { ok: true, text: "old" } }));
    const result = reserve(writeCommand("writer", "coordinate-execute-ledger"), granted.generation, directory);
    assert.equal(result.ok, true);
    assert.equal(result.existing, false);
    assert.equal(result.reservation.dimension, "write");
    assert.equal(result.writeTurnsRemaining, 1);
    assert.equal(current().remaining, 2);
    assert.equal(fs.existsSync(path.join(directory, "claim-coordinate-execute-ledger")), false);
  } finally {
    revoke();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("settling a claimed write reservation keeps its charge", () => {
  const directory = tempDir();
  try {
    const granted = freshScope(["reader"], 2, writeAuthorization(["writer"], 2));
    const result = reserve(writeCommand("writer", "coordinate-execute-claimed"), granted.generation, directory);
    fs.writeFileSync(path.join(directory, "claim-coordinate-execute-claimed"), "");
    settle(result.reservation, { dispatched: false }, directory);
    assert.equal(current().write.remaining, 1);
    assert.equal(current().remaining, 2);
    assert.equal(fs.existsSync(path.join(directory, "send-authorization")), true);
  } finally {
    revoke();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("proven-not-sent write settles refund even for a hand-written grant and never delete it", () => {
  const directory = tempDir();
  try {
    const granted = freshScope(["reader"], 2, writeAuthorization(["writer"], 2));
    const line = "coordinate-execute-manual\n";
    fs.writeFileSync(path.join(directory, "send-authorization"), line);
    const result = reserve(writeCommand("writer", "coordinate-execute-manual"), granted.generation, directory);
    assert.equal(result.reservation.insertedByScope, false);
    assert.equal(current().write.remaining, 1);
    settle(result.reservation, { dispatched: false }, directory);
    assert.equal(current().write.remaining, 2);
    assert.equal(fs.readFileSync(path.join(directory, "send-authorization"), "utf8"), line);
  } finally {
    revoke();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("unknown write dispatch keeps its charge and removes only the scope-inserted unclaimed grant", () => {
  const directory = tempDir();
  try {
    const granted = freshScope(["reader"], 2, writeAuthorization(["writer"], 2));
    const result = reserve(writeCommand("writer", "coordinate-execute-unknown"), granted.generation, directory);
    assert.equal(result.reservation.insertedByScope, true);
    settle(result.reservation, { dispatched: null }, directory);
    assert.equal(current().write.remaining, 1);
    assert.equal(current().remaining, 2);
    assert.equal(fs.existsSync(path.join(directory, "send-authorization")), false);
  } finally {
    revoke();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("late write settlements never credit a replacement or re-authorized generation", () => {
  const directory = tempDir();
  try {
    const first = authorize(["reader"], 2, writeAuthorization(["writer"], 1));
    const old = reserve(writeCommand("writer", "coordinate-execute-old"), first.generation, directory);
    assert.equal(old.writeTurnsRemaining, 0);
    const second = authorize(["reader-2"], 2, writeAuthorization(["writer-2"], 2));
    settle(old.reservation, { dispatched: false }, directory);
    assert.equal(current().generation, second.generation);
    assert.equal(current().write.remaining, 2);

    const pending = reserve(writeCommand("writer-2", "coordinate-execute-pending"), second.generation, directory);
    assert.equal(current().write.remaining, 1);
    revoke();
    assert.equal(current(), null);
    const third = authorize(["reader-3"], 2, writeAuthorization(["writer-3"], 3));
    settle(pending.reservation, { dispatched: false }, directory);
    assert.equal(current().generation, third.generation);
    assert.equal(current().write.remaining, 3);
  } finally {
    revoke();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
