const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { discoverCoordination, launchOne } = require("./coordinate-service.cjs");
const coordinationScope = require("./coordination-scope.cjs");
const { runCliTurn } = require("./cli-coordinate.cjs");

const command = {
  type: "goalport.coordinateTurn",
  modelSelection: { instanceId: "codex", model: "gpt-6-astra" },
  runtimeMode: "approval-required",
  approvalPolicy: "never",
  sandboxPolicy: { type: "readOnly" },
  workspaceStrategy: { type: "existing_worktree", worktreePath: "/work/selected-goal" },
  initialMessage: { text: "Plan only." },
};

const held = {
  ok: true,
  disposition: "deny",
  sandbox: "readOnly",
  approval: "never",
  messageDispatched: false,
  errorText: "",
};

test("discovery asks the runtime and does not authorize a send", async () => {
  let discovered = 0;
  const result = await discoverCoordination({}, {
    async discover() {
      discovered += 1;
      return { ok: true, providers: [{ instanceId: "codex", displayName: "Codex" }] };
    },
    async prepare() {
      throw new Error("prepare is not part of discovery");
    },
  });
  assert.equal(discovered, 1);
  assert.equal(result.connected, true);
  assert.equal(result.sendAuthorized, false);
  assert.equal(result.providers[0].instanceId, "codex");
});

test("a missing runtime does not invent a harness", async () => {
  const result = await discoverCoordination({ GOALPORT_COORDINATE_SEND: "1" }, null);
  assert.equal(result.connected, false);
  assert.equal(result.providers.length, 0);
  assert.match(result.stopReason, /not connected/);
});

test("an unconfigured runtime keeps its own discovery sentence", async () => {
  const result = await discoverCoordination({}, {
    async discover() {
      return { ok: false, errorText: "The pinned checkout is not configured, so no harness was assigned." };
    },
    async prepare() {
      return held;
    },
  });
  assert.equal(result.connected, false);
  assert.equal(result.providers.length, 0);
  assert.equal(result.stopReason, "The pinned checkout is not configured, so no harness was assigned.");
});

test("a pinned checkout mismatch fails discovery", async () => {
  const result = await discoverCoordination({}, {
    async discover() {
      return { ok: false, providers: [], stopReason: "The pinned checkout does not match, so no harness was assigned." };
    },
    async prepare() {
      return held;
    },
  });
  assert.equal(result.connected, false);
  assert.equal(result.providers.length, 0);
  assert.match(result.stopReason, /pinned checkout does not match/);
});

test("an unauthorized launch does not prepare or run", async () => {
  let prepared = 0;
  let ran = 0;
  const result = await launchOne({}, {
    async discover() {
      return { ok: true, providers: [] };
    },
    async prepare() {
      prepared += 1;
      return held;
    },
    async run() {
      ran += 1;
      return { ok: false, errorText: "sent" };
    },
  }, command);
  assert.equal(prepared, 0);
  assert.equal(ran, 0);
  assert.equal(result.launched, false);
  assert.equal(result.prepared, true);
  assert.match(result.errorText, /not authorized/);
});

test("a missing sandbox does not call the runtime", async () => {
  let prepared = 0;
  let ran = 0;
  const result = await launchOne({ GOALPORT_COORDINATE_SEND: "1" }, {
    async discover() {
      return { ok: true, providers: [] };
    },
    async prepare() {
      prepared += 1;
      return held;
    },
    async run() {
      ran += 1;
      return { ok: true, errorText: "" };
    },
  }, { ...command, sandboxPolicy: undefined });
  assert.equal(prepared, 0);
  assert.equal(ran, 0);
  assert.match(result.errorText, /readOnly/);
});

test("approval-required without never is refused before prepare", async () => {
  let prepared = 0;
  const result = await launchOne({ GOALPORT_COORDINATE_SEND: "1" }, {
    async discover() {
      return { ok: true, providers: [] };
    },
    async prepare() {
      prepared += 1;
      return held;
    },
  }, { ...command, approvalPolicy: "untrusted" });
  assert.equal(prepared, 0);
  assert.match(result.errorText, /approvalPolicy must be never/);
});

test("an authorized runtime result is the turn text", async () => {
  let prepared = 0;
  let ran = 0;
  const result = await launchOne({ GOALPORT_COORDINATE_SEND: "1" }, {
    async discover() {
      return { ok: true, providers: [] };
    },
    async prepare() {
      prepared += 1;
      return held;
    },
    async run(received) {
      ran += 1;
      assert.equal(received.initialMessage.text, "Plan only.");
      // The success stub carries the literal dispatched flag of a completed
      // turn, matching the success branch's literal true (plan R2-2/R3).
      return { ok: true, text: "Bounded plan.", errorText: "", messageDispatched: true };
    },
  }, command);
  assert.equal(prepared, 0);
  assert.equal(ran, 1);
  assert.equal(result.launched, true);
  assert.equal(result.prepared, true);
  assert.equal(result.text, "Bounded plan.");
  assert.equal(result.errorText, "");
  assert.equal(result.dispatched, true);
});

test("the authorization flag still does not send a model turn", async () => {
  let prepared = 0;
  let ran = 0;
  const result = await launchOne({ GOALPORT_COORDINATE_SEND: "1" }, {
    async discover() {
      return { ok: true, providers: [] };
    },
    async prepare(received) {
      prepared += 1;
      assert.equal(received.initialMessage.text, "Plan only.");
      return held;
    },
    async run() {
      ran += 1;
      return { ok: false, errorText: "No model turn was sent, because this session is not authorized to spend subscription quota." };
    },
  }, command);
  assert.equal(prepared, 0);
  assert.equal(ran, 1);
  assert.equal(result.launched, false);
  assert.equal(result.prepared, true);
  assert.equal(result.text, "");
});

test("a failed turn keeps the partial text the harness did produce", async () => {
  const result = await launchOne({ GOALPORT_COORDINATE_SEND: "1" }, {
    async discover() {
      return { ok: true, providers: [] };
    },
    async prepare() {
      return held;
    },
    async run() {
      return { ok: false, text: "Half a plan before the harness died.", errorText: "The harness did not finish, so this stopped." };
    },
  }, command);
  assert.equal(result.launched, false);
  assert.equal(result.prepared, true);
  assert.equal(result.text, "Half a plan before the harness died.");
  assert.equal(result.errorText, "The harness did not finish, so this stopped.");
});

test("a refused launch and a dispatched failure report their dispatched state", async () => {
  const runtime = (run) => ({
    async discover() {
      return { ok: true, providers: [] };
    },
    async prepare() {
      return held;
    },
    run,
  });
  const refused = await launchOne({ GOALPORT_COORDINATE_SEND: "1" }, runtime(async () => ({
    ok: false,
    text: "",
    errorText: "No model turn was sent, because this session is not authorized to spend subscription quota.",
    messageDispatched: false,
  })), command);
  assert.equal(refused.dispatched, false);

  const dispatched = await launchOne({ GOALPORT_COORDINATE_SEND: "1" }, runtime(async () => ({
    ok: false,
    text: "Half a plan.",
    errorText: "The harness did not finish, so this stopped.",
    messageDispatched: true,
  })), command);
  assert.equal(dispatched.dispatched, true);
  assert.equal(dispatched.text, "Half a plan.");

  const unknown = await launchOne({ GOALPORT_COORDINATE_SEND: "1" }, runtime(async () => ({
    ok: false,
    text: "",
    errorText: "The harness did not finish, so this stopped.",
  })), command);
  // Plan R2-2 (intentional correction of the old absence→false flattening):
  // an absent messageDispatched is NOT proven-not-sent. Only a literal false
  // maps to false; absence, null and thrown transports are unknown (null),
  // because an unknown dispatch may already have spent quota.
  assert.equal(unknown.dispatched, null);
});

test("a runtime that throws mid-turn reports an unknown dispatch state", async () => {
  const result = await launchOne({ GOALPORT_COORDINATE_SEND: "1" }, {
    async discover() {
      return { ok: true, providers: [] };
    },
    async prepare() {
      return held;
    },
    async run() {
      throw new Error("transport died");
    },
  }, command);
  assert.equal(result.launched, false);
  assert.equal(result.dispatched, null);
});

test("an environment-blocked turn passes its typed fields through", async () => {
  const result = await launchOne({ GOALPORT_COORDINATE_SEND: "1" }, {
    async discover() {
      return { ok: true, providers: [] };
    },
    async prepare() {
      return held;
    },
    async run() {
      return {
        ok: false,
        text: "I couldn't read the file because the sandbox failed to initialize.",
        errorText: "This harness cannot run its tools on this machine, so this stopped.",
        messageDispatched: true,
        environmentBlocked: true,
        environmentDetail: "Failed to create unified exec process: helper_unknown_error: setup refresh had errors",
      };
    },
  }, command);
  assert.equal(result.launched, false);
  assert.equal(result.text, "I couldn't read the file because the sandbox failed to initialize.");
  assert.equal(result.environmentBlocked, true);
  assert.equal(result.environmentDetail, "Failed to create unified exec process: helper_unknown_error: setup refresh had errors");
});

test("a normal failure reports no environment fields", async () => {
  const result = await launchOne({ GOALPORT_COORDINATE_SEND: "1" }, {
    async discover() {
      return { ok: true, providers: [] };
    },
    async prepare() {
      return held;
    },
    async run() {
      return { ok: false, text: "", errorText: "The harness did not finish, so this stopped.", messageDispatched: true };
    },
  }, command);
  assert.equal(result.environmentBlocked, false);
  assert.equal(result.environmentDetail, null);
});

// --- M2: scoped launches (JIT grant + budget authority in the main process) ---

function scopedCommand(commandId, instanceId = "codex") {
  return {
    commandId,
    type: "goalport.coordinateTurn",
    modelSelection: { instanceId, model: instanceId === "codex" ? "gpt-6.1-sol" : "opus" },
    runtimeMode: "approval-required",
    approvalPolicy: "never",
    sandboxPolicy: { type: "readOnly" },
    workspaceStrategy: { type: "existing_worktree", worktreePath: "/work/goal" },
    initialMessage: { text: "Plan only." },
  };
}

function scopedRuntime(directory, run) {
  return {
    stateDir: directory,
    async discover() {
      return { ok: true, providers: [] };
    },
    async prepare() {
      return held;
    },
    run,
  };
}

function scopeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "goalport-service-scope-"));
}

function scopeCleanup(directory) {
  coordinationScope.revoke();
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

const CODEX_REPLY = '{"type":"item.completed","item":{"type":"agent_message","text":"Bounded plan."}}\n';

test("a scoped launch writes the same-format grant line and the claimed turn consumes it", async () => {
  const directory = scopeTempDir();
  try {
    coordinationScope.revoke();
    const granted = coordinationScope.authorize(["codex"], 4);
    let spawns = 0;
    const runtime = scopedRuntime(directory, (received) => runCliTurn(received, {
      stateDir: directory,
      spawnTurn: async () => {
        spawns += 1;
        return { code: 0, stdout: CODEX_REPLY };
      },
    }));
    const result = await launchOne({ GOALPORT_COORDINATE_SEND: "1" }, runtime, scopedCommand("coordinate-plan-codex"), "g", { scope: coordinationScope, scopeGeneration: granted.generation });
    assert.equal(spawns, 1);
    assert.equal(result.launched, true);
    assert.equal(result.text, "Bounded plan.");
    assert.equal(result.dispatched, true);
    assert.equal(result.turnsRemaining, 3);
    assert.equal(coordinationScope.current().remaining, 3);
    // The scope wrote the identical grant file format, and runCliTurn's
    // takeGrant consumed the line when the turn claimed.
    assert.equal(fs.existsSync(path.join(directory, "claim-coordinate-plan-codex")), true);
    assert.equal(fs.existsSync(path.join(directory, "send-authorization")), false);
  } finally {
    scopeCleanup(directory);
  }
});

test("a launch without a scope keeps today's semantics except the named passthrough fields", async () => {
  const result = await launchOne({ GOALPORT_COORDINATE_SEND: "1" }, {
    async discover() {
      return { ok: true, providers: [] };
    },
    async prepare() {
      return held;
    },
    async run() {
      return { ok: false, text: "", errorText: "The harness finished without any text, so this stopped.", messageDispatched: true, stopCode: "no-text" };
    },
  }, command);
  // stopCode is the named passthrough; the scope fields never appear.
  assert.equal(result.stopCode, "no-text");
  assert.equal("turnsRemaining" in result, false);
  assert.equal("scopeExhausted" in result, false);
  assert.equal(result.dispatched, true);
});

test("a proven-not-sent spawn failure refunds the budget and deletes the scope's own line (decision row 3)", async () => {
  const directory = scopeTempDir();
  try {
    coordinationScope.revoke();
    const granted = coordinationScope.authorize(["codex"], 4);
    const runtime = scopedRuntime(directory, (received) => runCliTurn(received, {
      stateDir: directory,
      spawnTurn: async () => ({ spawnError: true }),
    }));
    const result = await launchOne({ GOALPORT_COORDINATE_SEND: "1" }, runtime, scopedCommand("coordinate-plan-codex"), "g", { scope: coordinationScope, scopeGeneration: granted.generation });
    assert.match(result.errorText, /not installed/);
    assert.equal(result.stopCode, "not-installed");
    assert.equal(result.dispatched, false);
    // The refund is unconditional, and the line runCliTurn restored is still
    // scope-owned, so the cleanup takes it back out.
    assert.equal(coordinationScope.current().remaining, 4);
    assert.equal(fs.existsSync(path.join(directory, "send-authorization")), false);
    assert.equal(fs.existsSync(path.join(directory, "claim-coordinate-plan-codex")), false);
  } finally {
    scopeCleanup(directory);
  }
});

test("a manual grant line survives a refunded spawn failure while the budget still refunds (rows 3 and 6)", async () => {
  const directory = scopeTempDir();
  try {
    coordinationScope.revoke();
    const granted = coordinationScope.authorize(["codex"], 4);
    fs.writeFileSync(path.join(directory, "send-authorization"), "coordinate-plan-codex\n");
    const runtime = scopedRuntime(directory, (received) => runCliTurn(received, {
      stateDir: directory,
      spawnTurn: async () => ({ spawnError: true }),
    }));
    const result = await launchOne({ GOALPORT_COORDINATE_SEND: "1" }, runtime, scopedCommand("coordinate-plan-codex"), "g", { scope: coordinationScope, scopeGeneration: granted.generation });
    assert.match(result.errorText, /not installed/);
    // Refund is unconditional even though the line was hand-written; the
    // owner's line is never deleted by cleanup.
    assert.equal(coordinationScope.current().remaining, 4);
    assert.equal(fs.readFileSync(path.join(directory, "send-authorization"), "utf8"), "coordinate-plan-codex\n");
  } finally {
    scopeCleanup(directory);
  }
});

test("an unknown dispatch keeps its charge but removes an unconsumed scope line (decision row 4)", async () => {
  const directory = scopeTempDir();
  try {
    coordinationScope.revoke();
    const granted = coordinationScope.authorize(["codex"], 4);
    const runtime = scopedRuntime(directory, async () => {
      throw new Error("transport died mid-turn");
    });
    const result = await launchOne({ GOALPORT_COORDINATE_SEND: "1" }, runtime, scopedCommand("coordinate-plan-codex"), "g", { scope: coordinationScope, scopeGeneration: granted.generation });
    assert.equal(result.dispatched, null);
    // No refund: the unknown dispatch may already have spent quota. The
    // provably unconsumed scope-inserted line still goes away.
    assert.equal(coordinationScope.current().remaining, 3);
    assert.equal(fs.existsSync(path.join(directory, "send-authorization")), false);
  } finally {
    scopeCleanup(directory);
  }
});

test("a stale generation is refused as revoked and a late completion never credits a replacement scope (decision row 5)", async () => {
  const directory = scopeTempDir();
  try {
    coordinationScope.revoke();
    const first = coordinationScope.authorize(["codex"], 4);
    let runs = 0;
    const rejected = await launchOne({ GOALPORT_COORDINATE_SEND: "1" }, scopedRuntime(directory, async () => {
      runs += 1;
      return { ok: true, text: "never", errorText: "" };
    }), scopedCommand("coordinate-plan-codex"), "g", { scope: coordinationScope, scopeGeneration: first.generation + 41 });
    assert.equal(runs, 0);
    assert.equal(rejected.stopCode, "scope-revoked");
    assert.equal(coordinationScope.current().remaining, 4);
    assert.equal(fs.existsSync(path.join(directory, "send-authorization")), false);

    // A launch reserved under the first generation completes after the owner
    // replaced the scope: it settles under its own generation, so the
    // replacement's budget is never credited.
    let release;
    const runtime = scopedRuntime(directory, () => new Promise((resolve) => { release = resolve; }));
    const pending = launchOne({ GOALPORT_COORDINATE_SEND: "1" }, runtime, scopedCommand("coordinate-review-codex"), "g", { scope: coordinationScope, scopeGeneration: first.generation });
    assert.equal(coordinationScope.current().remaining, 3);
    assert.equal(fs.readFileSync(path.join(directory, "send-authorization"), "utf8"), "coordinate-review-codex\n");
    coordinationScope.authorize(["codex"], 4);
    assert.equal(coordinationScope.current().generation, first.generation + 1);
    release({ ok: false, text: "", errorText: "The harness did not finish, so this stopped.", messageDispatched: false });
    const result = await pending;
    assert.equal(result.dispatched, false);
    assert.equal(coordinationScope.current().remaining, 4);
    assert.equal(fs.existsSync(path.join(directory, "send-authorization")), false);
  } finally {
    scopeCleanup(directory);
  }
});

test("a claimed command passes free at a zero budget (claim hit before any budget check)", async () => {
  const directory = scopeTempDir();
  try {
    coordinationScope.revoke();
    const granted = coordinationScope.authorize(["codex"], 2);
    const ctx = { scope: coordinationScope, scopeGeneration: granted.generation };
    const runtime = scopedRuntime(directory, async () => {
      return { ok: false, text: "", errorText: "The harness did not finish, so this stopped.", messageDispatched: true };
    });
    await launchOne({ GOALPORT_COORDINATE_SEND: "1" }, runtime, scopedCommand("coordinate-plan-a"), "g", ctx);
    await launchOne({ GOALPORT_COORDINATE_SEND: "1" }, runtime, scopedCommand("coordinate-review-b"), "g", ctx);
    assert.equal(coordinationScope.current().remaining, 0);
    // The claim file exists, so the stored-result semantics apply: no budget
    // check, no write, no deduction, even at zero.
    fs.writeFileSync(path.join(directory, "claim-coordinate-plan-codex"), "");
    const before = fs.readdirSync(directory).sort();
    const stored = await launchOne({ GOALPORT_COORDINATE_SEND: "1" }, scopedRuntime(directory, async () => {
      return { ok: true, text: "Stored plan.", errorText: "", messageDispatched: true };
    }), scopedCommand("coordinate-plan-codex"), "g", ctx);
    assert.equal(stored.launched, true);
    assert.equal(stored.text, "Stored plan.");
    assert.equal(stored.turnsRemaining, 0);
    assert.equal(coordinationScope.current().remaining, 0);
    assert.deepEqual(fs.readdirSync(directory).sort(), before);
  } finally {
    scopeCleanup(directory);
  }
});
