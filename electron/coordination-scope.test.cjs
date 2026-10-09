const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const coordinationScope = require("./coordination-scope.cjs");
const { launchOne } = require("./coordinate-service.cjs");
const { runCliTurn } = require("./cli-coordinate.cjs");

const { authorize, current, reserve, revoke, settle } = coordinationScope;

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

function freshScope(instances = ["codex"], maxTurns = 4) {
  revoke();
  const granted = authorize(instances, maxTurns);
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

test("a command id outside the plan/review roles is refused with zero side effects", () => {
  const directory = tempDir();
  try {
    const granted = freshScope(["codex"], 4);
    const before = snapshotDir(directory);
    const rejected = reserve(command("codex", "coordinate-execute-codex"), granted.generation, directory);
    assert.equal(rejected.ok, false);
    assert.match(rejected.errorText, /plan or check turn/);
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
