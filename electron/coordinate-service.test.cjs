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

test("ordinary capability truth table accepts env or consent and preserves pinned paths", async () => {
  for (const envSet of [false, true]) for (const allowed of [false, true]) {
    for (const checkout of [false, true]) for (const serverCwd of [false, true]) {
      const env = { GOALPORT_COORDINATE_SEND: envSet ? "1" : "0",
        ...(checkout ? { GOALPORT_HARNESS_CHECKOUT: "/pinned" } : {}),
        ...(serverCwd ? { GOALPORT_HARNESS_SERVER_CWD: "/pinned/server" } : {}) };
      let runs = 0;
      const runtime = {
        discover: async () => ({ ok: true, providers: [] }),
        prepare: async () => held,
        run: async () => { runs++; return { ok: true, text: "Bounded plan.", messageDispatched: true }; },
      };
      const consent = () => ({ allowed });
      const discovered = await discoverCoordination(env, runtime, undefined, consent);
      assert.equal(discovered.sendAuthorized, envSet || allowed);
      const result = await launchOne(env, runtime, command, undefined, undefined, consent);
      assert.equal(result.launched, envSet || allowed);
      assert.equal(runs, envSet || allowed ? 1 : 0);
      if (!envSet && !allowed) assert.match(result.errorText, /not authorized/);
    }
  }
  const runtime = { discover: async () => ({ ok: true, providers: [] }), prepare: async () => held,
    run: async () => { throw new Error("must not run"); } };
  assert.equal((await launchOne({}, runtime, command, undefined, undefined, () => { throw new Error("unreadable"); })).launched, false);
});
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
      return { ok: false, text: "Half a plan before the harness died.", errorText: "The agent did not finish, so this stopped." };
    },
  }, command);
  assert.equal(result.launched, false);
  assert.equal(result.prepared, true);
  assert.equal(result.text, "Half a plan before the harness died.");
  assert.equal(result.errorText, "The agent did not finish, so this stopped.");
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
    errorText: "The agent did not finish, so this stopped.",
    messageDispatched: true,
  })), command);
  assert.equal(dispatched.dispatched, true);
  assert.equal(dispatched.text, "Half a plan.");

  const unknown = await launchOne({ GOALPORT_COORDINATE_SEND: "1" }, runtime(async () => ({
    ok: false,
    text: "",
    errorText: "The agent did not finish, so this stopped.",
  })), command);
  // Plan R2-2 (intentional correction of the old absence→false flattening):
  // an absent messageDispatched is NOT proven-not-sent. Only a literal false
  // maps to false; absence, null and thrown transports are unknown (null),
  // because an unknown dispatch may already have spent quota.
  assert.equal(unknown.dispatched, null);
});

test("Linux stdin no-child refunds, but a real post-child setup error keeps charge/claim and actual facts", { skip: process.platform !== "linux" }, async () => {
  const { defaultSpawn } = require("./cli-coordinate.cjs");
  for (const nochild of [true, false]) {
    const directory = scopeTempDir();
    let child, closed;
    try {
      coordinationScope.revoke();
      const granted = coordinationScope.authorize(["pi"], 2);
      const input = { ...command, commandId: `coordinate-audit-stdin-${nochild}`, modelSelection: { instanceId: "pi", model: "default" }, promptDelivery: "stdin", initialMessage: { text: "中文😀 exact input\n" } };
      const runtime = { stateDir: directory, discover: async () => ({}), prepare: async () => held,
        run: command => runCliTurn(command, { stateDir: directory, spawnTurn: spec => defaultSpawn({ ...spec, cwd: directory,
          file: nochild ? path.join(directory, "does-not-exist") : process.execPath,
          args: nochild ? [] : ["-e", "setInterval(()=>{},1000)"],
          register(proc) {
            child = proc;
            closed = new Promise(resolve => proc.once("close", resolve));
            if (!nochild) throw Error("real child registration failed after pid");
          },
        }) }),
      };
      const result = await launchOne({ GOALPORT_COORDINATE_SEND: "1" }, runtime, input, "stdin-service", { scope: coordinationScope, scopeGeneration: granted.generation });
      assert.equal(result.dispatched, nochild ? false : null);
      assert.equal(result.turnsRemaining, nochild ? 2 : 1);
      assert.equal(fs.existsSync(path.join(directory, `claim-${input.commandId}`)), !nochild);
      assert.deepEqual(result.auditInputTransport, { instanceId: "pi", promptDelivery: "stdin", inputBytes: Buffer.byteLength(input.initialMessage.text), inputEnded: false });
      if (!nochild) {
        const again = await launchOne({ GOALPORT_COORDINATE_SEND: "1" }, runtime, input, "stdin-service", { scope: coordinationScope, scopeGeneration: granted.generation });
        assert.equal(again.dispatched, null);
        assert.equal(again.turnsRemaining, 1);
        assert.equal(child.exitCode, null);
      }
    } finally {
      if (child?.pid && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
      scopeCleanup(directory);
    }
  }
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
        errorText: "This agent cannot run its tools on this machine, so this stopped.",
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
      return { ok: false, text: "", errorText: "The agent did not finish, so this stopped.", messageDispatched: true };
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
      return { ok: false, text: "", errorText: "The agent finished without any text, so this stopped.", messageDispatched: true, stopCode: "no-text" };
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
    release({ ok: false, text: "", errorText: "The agent did not finish, so this stopped.", messageDispatched: false });
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
      return { ok: false, text: "", errorText: "The agent did not finish, so this stopped.", messageDispatched: true };
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

test("authorize membership refuses an apiKey login even when it is discovered", () => {
  const { authorizeMembershipError } = require("./coordinate-service.cjs");
  const discovered = {
    ok: true,
    providers: [
      { instanceId: "codex", auth: { status: "authenticated", type: "chatgpt" } },
      { instanceId: "claude", auth: { status: "authenticated", type: "apiKey" } },
    ],
    stopReason: null,
  };
  // Plan M2: "apiKey authorize 拒" — the refusal the main-process handler
  // enforces before any scope is minted; the budget authority must never
  // front a pay-per-call credential.
  assert.equal(
    authorizeMembershipError(discovered, ["codex", "claude"]),
    "Only harnesses signed in with their own subscription can be authorized.",
  );
  assert.equal(authorizeMembershipError(discovered, ["codex"]), null);
});

test("authorize membership allows an explicitly named unknown harness and still refuses a missing auth type", () => {
  const { authorizeMembershipError } = require("./coordinate-service.cjs");
  const sentence = "Only harnesses signed in with their own subscription can be authorized.";
  const discovered = {
    ok: true,
    providers: [
      { instanceId: "codex", auth: { status: "authenticated", type: "chatgpt" } },
      { instanceId: "pi", auth: { status: "authenticated", type: "unknown" } },
      { instanceId: "bare", auth: { status: "authenticated" } },
    ],
  };
  assert.equal(authorizeMembershipError(discovered, ["pi"]), null);
  assert.equal(authorizeMembershipError(discovered, ["bare"]), sentence);
  assert.equal(authorizeMembershipError(discovered, ["codex"]), null);
});

test("authorize membership refuses an instance the fresh discovery does not know", () => {
  const { authorizeMembershipError } = require("./coordinate-service.cjs");
  const discovered = {
    ok: true,
    providers: [{ instanceId: "codex", auth: { status: "authenticated", type: "chatgpt" } }],
    stopReason: null,
  };
  // Plan M2: "未知实例拒" — a name that is not a discovered harness right
  // now never enters a scope.
  assert.equal(
    authorizeMembershipError(discovered, ["codex", "grok"]),
    "Only harnesses signed in with their own subscription can be authorized.",
  );
});

test("authorize membership fails closed when discovery cannot run", () => {
  const { authorizeMembershipError } = require("./coordinate-service.cjs");
  // A discovery that failed at all (or returned nothing) refuses everything:
  // membership cannot be verified, so nothing is authorized.
  assert.equal(
    authorizeMembershipError({ ok: false, providers: [] }, ["codex"]),
    "Only harnesses signed in with their own subscription can be authorized.",
  );
  assert.equal(
    authorizeMembershipError(null, ["codex"]),
    "Only harnesses signed in with their own subscription can be authorized.",
  );
});

// M6b: injected discovery and turns only; never execute a vendor CLI.
const { authorizeCoordination } = require("./coordinate-service.cjs");
const writeAuthorization = { instances: ["codex"], maxTurns: 2, workspaceRoot: "/work/goal" };
const freshProviders = {
  ok: true,
  providers: [
    { instanceId: "codex", auth: { status: "authenticated", type: "chatgpt" } },
    { instanceId: "claude", auth: { status: "authenticated", type: "subscription" } },
  ],
};
function writeCommand(id = "coordinate-execute-codex") {
  return { ...scopedCommand(id), sandboxPolicy: { type: "workspaceWrite" } };
}

test("bridge uses one fresh discovery for both lists before minting; legacy shape and scope clamps remain", async () => {
  coordinationScope.revoke();
  try {
    let discoveries = 0;
    const discover = async () => { discoveries += 1; return freshProviders; };
    const read = await authorizeCoordination({ instances: ["codex", "claude"], maxTurns: 4 }, coordinationScope, discover);
    assert.deepEqual(read, { ok: true, generation: read.generation, remaining: 4 });
    assert.deepEqual(coordinationScope.current(), { instances: ["codex", "claude"], maxTurns: 4, remaining: 4, generation: read.generation });
    const original = coordinationScope.authorize;
    const injectedScope = { authorize(...args) {
      assert.equal(discoveries, 2);
      assert.deepEqual(args, [["codex"], 99, { ...writeAuthorization, maxTurns: 99 }]);
      return original(...args);
    } };
    const both = await authorizeCoordination({ instances: ["codex"], maxTurns: 99, write: { ...writeAuthorization, maxTurns: 99 } }, injectedScope, discover);
    assert.deepEqual(both, { ok: true, generation: read.generation + 1, remaining: 32, writeTurnsRemaining: 8 });
    assert.equal(discoveries, 2);
  } finally { coordinationScope.revoke(); }
});

test("fresh membership/API-key refusal checks either list and never replaces prior authorization", async () => {
  coordinationScope.revoke();
  try {
    const first = coordinationScope.authorize(["codex"], 4, writeAuthorization);
    const before = coordinationScope.current();
    for (const [read, write, discovered] of [
      [["codex"], ["missing"], freshProviders],
      [["missing"], ["codex"], freshProviders],
      [["codex"], ["claude"], { ...freshProviders, providers: [freshProviders.providers[0], { instanceId: "claude", auth: { type: "apiKey" } }] }],
      [["claude"], ["codex"], { ...freshProviders, providers: [freshProviders.providers[0], { instanceId: "claude", auth: { type: "apiKey" } }] }],
      [["codex"], ["codex"], { ...freshProviders, ok: false }],
      [["codex"], ["codex"], null],
    ]) {
      let discoveries = 0;
      const result = await authorizeCoordination({ instances: read, maxTurns: 4, write: { ...writeAuthorization, instances: write } }, coordinationScope, async () => { discoveries += 1; return discovered; });
      assert.equal(discoveries, 1);
      assert.deepEqual(result, { ok: false, generation: 0, remaining: 0, errorText: "Only harnesses signed in with their own subscription can be authorized." });
      assert.deepEqual(coordinationScope.current(), before);
    }
    const thrown = await authorizeCoordination({ instances: ["codex"], maxTurns: 4, write: writeAuthorization }, coordinationScope, async () => { throw new Error("discovery unavailable"); });
    assert.equal(thrown.ok, false);
    assert.deepEqual(coordinationScope.current(), before);
    const next = await authorizeCoordination({ instances: ["codex"], maxTurns: 4, write: writeAuthorization }, coordinationScope, async () => freshProviders);
    assert.equal(next.generation, first.generation + 1);
  } finally { coordinationScope.revoke(); }
});

test("malformed read/write shapes refuse before discovery and mint no generation", async () => {
  coordinationScope.revoke();
  try {
    const first = coordinationScope.authorize(["codex"], 4, writeAuthorization);
    const before = coordinationScope.current();
    let discoveries = 0;
    for (const write of [null, [], {}, { ...writeAuthorization, instances: [] }, { ...writeAuthorization, instances: [1] }, { ...writeAuthorization, maxTurns: NaN }, { ...writeAuthorization, maxTurns: Infinity }, { ...writeAuthorization, maxTurns: "2" }, { ...writeAuthorization, workspaceRoot: "" }, { ...writeAuthorization, workspaceRoot: "   " }, { ...writeAuthorization, workspaceRoot: "relative" }]) {
      const result = await authorizeCoordination({ instances: ["codex"], maxTurns: 4, write }, coordinationScope, async () => { discoveries += 1; return freshProviders; });
      assert.equal(result.ok, false);
      assert.match(result.errorText, /workspace-change authorization is invalid/);
      assert.deepEqual(coordinationScope.current(), before);
    }
    for (const instances of [undefined, [], [1], [" "]]) {
      assert.equal((await authorizeCoordination({ instances, maxTurns: 4 }, coordinationScope, async () => { discoveries += 1; return freshProviders; })).ok, false);
      assert.deepEqual(coordinationScope.current(), before);
    }
    assert.equal(discoveries, 0);
    assert.equal(coordinationScope.authorize(["codex"], 4).generation, first.generation + 1);
  } finally { coordinationScope.revoke(); }
});

test("execute cannot use legacy hand-written grants or malformed scoped contexts", async () => {
  const directory = scopeTempDir();
  try {
    coordinationScope.revoke();
    const granted = coordinationScope.authorize(["codex"], 4, writeAuthorization);
    const before = coordinationScope.current();
    fs.writeFileSync(path.join(directory, "send-authorization"), "coordinate-execute-codex\n");
    let runs = 0;
    const runtime = scopedRuntime(directory, () => { runs += 1; return { ok: true, text: "never" }; });
    for (const ctx of [undefined, {}, { scopeGeneration: granted.generation }, { scope: {}, scopeGeneration: granted.generation }]) {
      const result = await launchOne({ GOALPORT_COORDINATE_SEND: "1" }, runtime, writeCommand(), "g", ctx);
      assert.match(result.errorText, /explicit workspace-change authorization/);
      assert.equal(result.dispatched, false);
    }
    assert.equal(runs, 0);
    assert.deepEqual(coordinationScope.current(), before);
    assert.equal(fs.readFileSync(path.join(directory, "send-authorization"), "utf8"), "coordinate-execute-codex\n");
    assert.equal(fs.existsSync(path.join(directory, "claim-coordinate-execute-codex")), false);
  } finally { scopeCleanup(directory); }
});

test("scoped execute rejects read-only scope, root drift, wrong member, stale generation and guard pairing before run/charge", async () => {
  const directory = scopeTempDir();
  try {
    coordinationScope.revoke();
    let runs = 0;
    const runtime = scopedRuntime(directory, async () => { runs += 1; return { ok: true, text: "never" }; });
    const read = coordinationScope.authorize(["codex"], 4);
    const deniedRead = await launchOne({ GOALPORT_COORDINATE_SEND: "1" }, runtime, writeCommand(), "g", { scope: coordinationScope, scopeGeneration: read.generation });
    assert.match(deniedRead.errorText, /explicit workspace-change authorization/);
    assert.equal(deniedRead.turnsRemaining, 4);
    assert.equal("writeTurnsRemaining" in deniedRead, false);
    const both = coordinationScope.authorize(["codex", "claude"], 4, writeAuthorization);
    const ctx = { scope: coordinationScope, scopeGeneration: both.generation };
    const before = coordinationScope.current();
    for (const [cmd, error] of [
      [{ ...writeCommand(), workspaceStrategy: { type: "existing_worktree", worktreePath: "/other" } }, /authorized workspace/],
      [{ ...writeCommand(), modelSelection: { instanceId: "claude" } }, /not in the authorized scope/],
      [{ ...writeCommand(), sandboxPolicy: { type: "readOnly" } }, /workspaceWrite/],
      [{ ...writeCommand(), workspaceStrategy: { type: "existing_worktree", worktreePath: "relative" } }, /absolute/],
      [{ ...scopedCommand("coordinate-audit-codex"), sandboxPolicy: { type: "workspaceWrite" } }, /readOnly/],
    ]) {
      const result = await launchOne({ GOALPORT_COORDINATE_SEND: "1" }, runtime, cmd, "g", ctx);
      assert.match(result.errorText, error);
      assert.equal(result.turnsRemaining, 4);
      assert.equal(result.writeTurnsRemaining, 2);
      assert.deepEqual(coordinationScope.current(), before);
    }
    const stale = await launchOne({ GOALPORT_COORDINATE_SEND: "1" }, runtime, writeCommand(), "g", { ...ctx, scopeGeneration: read.generation });
    assert.equal(stale.stopCode, "scope-revoked");
    assert.equal(runs, 0);
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally { scopeCleanup(directory); }
});

test("scoped execute uses actual CLI write shape, charges only write, and claim replay is free at exhaustion", async () => {
  const directory = scopeTempDir();
  try {
    coordinationScope.revoke();
    const granted = coordinationScope.authorize(["codex"], 4, { ...writeAuthorization, maxTurns: 1 });
    const ctx = { scope: coordinationScope, scopeGeneration: granted.generation };
    let spawns = 0;
    const runtime = scopedRuntime(directory, (received) => runCliTurn(received, { stateDir: directory, spawnTurn: async (spec) => {
      spawns += 1;
      assert.equal(coordinationScope.current().remaining, 4);
      assert.equal(coordinationScope.current().write.remaining, 0);
      assert.equal(spec.cwd, "/work/goal");
      assert.deepEqual(spec.args, ["exec", "--json", "--ephemeral", "--sandbox", "workspace-write", "--skip-git-repo-check", "--cd", "/work/goal", "Plan only."]);
      return { code: 0, stdout: CODEX_REPLY };
    } }));
    for (let i = 0; i < 2; i += 1) {
      const result = await launchOne({ GOALPORT_COORDINATE_SEND: "1" }, runtime, writeCommand(), "g", ctx);
      assert.equal(result.launched, true);
      assert.equal(result.turnsRemaining, 4);
      assert.equal(result.writeTurnsRemaining, 0);
    }
    assert.equal(spawns, 1);
    const denied = await launchOne({ GOALPORT_COORDINATE_SEND: "1" }, runtime, writeCommand("coordinate-execute-next"), "g", ctx);
    assert.equal(denied.scopeExhausted, true);
    assert.equal(denied.turnsRemaining, 4);
    assert.equal(denied.writeTurnsRemaining, 0);
  } finally { scopeCleanup(directory); }
});

test("write settle preserves literal tri-state and synchronous-throw versus rejected-promise refunds", async () => {
  const directory = scopeTempDir();
  try {
    for (const [dispatch, expected] of [[true, true], [false, false], [null, null], [undefined, null], [0, null], ["false", null]]) {
      const granted = coordinationScope.authorize(["codex"], 4, writeAuthorization);
      const result = await launchOne({ GOALPORT_COORDINATE_SEND: "1" }, scopedRuntime(directory, async () => ({ ok: false, text: "Partial changes.", errorText: "Stopped.", messageDispatched: dispatch })), writeCommand(), "g", { scope: coordinationScope, scopeGeneration: granted.generation });
      assert.equal(result.dispatched, expected);
      assert.equal(result.text, "Partial changes.");
      assert.equal(result.turnsRemaining, 4);
      assert.equal(result.writeTurnsRemaining, dispatch === false ? 2 : 1);
      assert.equal(fs.existsSync(path.join(directory, "send-authorization")), false);
    }
    for (const [run, remaining] of [[() => { throw new Error("before promise"); }, 2], [async () => { throw new Error("mid-promise"); }, 1]]) {
      const granted = coordinationScope.authorize(["codex"], 4, writeAuthorization);
      const result = await launchOne({ GOALPORT_COORDINATE_SEND: "1" }, scopedRuntime(directory, run), writeCommand(), "g", { scope: coordinationScope, scopeGeneration: granted.generation });
      assert.equal(result.dispatched, null);
      assert.equal(result.turnsRemaining, 4);
      assert.equal(result.writeTurnsRemaining, remaining);
    }
  } finally { scopeCleanup(directory); }
});

test("write spawn proven-false refunds write only and retains an owner's grant", async () => {
  const directory = scopeTempDir();
  try {
    const granted = coordinationScope.authorize(["codex"], 4, writeAuthorization);
    fs.writeFileSync(path.join(directory, "send-authorization"), "coordinate-execute-codex\n");
    const runtime = scopedRuntime(directory, (received) => runCliTurn(received, { stateDir: directory, spawnTurn: async () => ({ spawnError: true }) }));
    const result = await launchOne({ GOALPORT_COORDINATE_SEND: "1" }, runtime, writeCommand(), "g", { scope: coordinationScope, scopeGeneration: granted.generation });
    assert.equal(result.dispatched, false);
    assert.equal(result.turnsRemaining, 4);
    assert.equal(result.writeTurnsRemaining, 2);
    assert.equal(fs.readFileSync(path.join(directory, "send-authorization"), "utf8"), "coordinate-execute-codex\n");
  } finally { scopeCleanup(directory); }
});

test("read and write metadata stay independent after settle; revoke in-flight clears both", async () => {
  const directory = scopeTempDir();
  try {
    const granted = coordinationScope.authorize(["codex"], 4, writeAuthorization);
    const ctx = { scope: coordinationScope, scopeGeneration: granted.generation };
    // R1: on the write chain the literal dispatched flag completes the turn;
    // the positive text alone no longer counts as a successful settle.
    const runtime = scopedRuntime(directory, async () => ({ ok: true, text: "Done.", errorText: "", messageDispatched: true }));
    const read = await launchOne({ GOALPORT_COORDINATE_SEND: "1" }, runtime, scopedCommand("coordinate-audit-codex"), "g", ctx);
    assert.equal(read.launched, true);
    assert.equal(read.dispatched, true);
    assert.equal(read.turnsRemaining, 3);
    assert.equal(read.writeTurnsRemaining, 2);
    const write = await launchOne({ GOALPORT_COORDINATE_SEND: "1" }, runtime, writeCommand(), "g", ctx);
    assert.equal(write.launched, true);
    assert.equal(write.dispatched, true);
    assert.equal(write.turnsRemaining, 3);
    assert.equal(write.writeTurnsRemaining, 1);
    for (const ok of [true, false]) {
      const next = coordinationScope.authorize(["codex"], 4, writeAuthorization);
      let release;
      const pending = launchOne({ GOALPORT_COORDINATE_SEND: "1" }, scopedRuntime(directory, () => new Promise((resolve) => { release = resolve; })), writeCommand(), "g", { scope: coordinationScope, scopeGeneration: next.generation });
      coordinationScope.revoke();
      release({ ok, text: "Real output.", errorText: ok ? "" : "Stopped.", messageDispatched: false });
      const result = await pending;
      // A positive reply with a literal false never becomes a success, even
      // when the scope was revoked mid-run.
      assert.equal(result.launched, false);
      assert.equal(result.dispatched, false);
      assert.equal(result.text, "Real output.");
      assert.equal(result.turnsRemaining, null);
      assert.equal(result.writeTurnsRemaining, null);
      assert.equal(coordinationScope.current(), null);
    }
  } finally { scopeCleanup(directory); }
});

test("write launch retains the original literal env gate and runtime-readiness checks without charge", async () => {
  const directory = scopeTempDir();
  try {
    const granted = coordinationScope.authorize(["codex"], 4, writeAuthorization);
    const ctx = { scope: coordinationScope, scopeGeneration: granted.generation };
    let runs = 0;
    const runtime = scopedRuntime(directory, () => { runs += 1; });
    for (const value of [undefined, "true", "0", 1]) {
      const result = await launchOne({ GOALPORT_COORDINATE_SEND: value }, runtime, writeCommand(), "g", ctx);
      assert.match(result.errorText, /not authorized/);
      assert.equal(result.turnsRemaining, 4);
      assert.equal(result.writeTurnsRemaining, 2);
    }
    for (const unavailable of [null, { ...runtime, discover: undefined }, { ...runtime, prepare: undefined }, { ...runtime, run: undefined }]) {
      const result = await launchOne({ GOALPORT_COORDINATE_SEND: "1" }, unavailable, writeCommand(), "g", ctx);
      assert.match(result.errorText, /not connected/);
      assert.equal(result.writeTurnsRemaining, 2);
    }
    assert.equal(runs, 0);
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally { scopeCleanup(directory); }
});

test("read-only scoped pre-reservation refusals retain the legacy exact field shape", async () => {
  const directory = scopeTempDir();
  try {
    const granted = coordinationScope.authorize(["codex"], 4);
    const ctx = { scope: coordinationScope, scopeGeneration: granted.generation };
    const result = await launchOne({}, scopedRuntime(directory, () => assert.fail("no run")), scopedCommand("coordinate-plan-codex"), "g", ctx);
    assert.deepEqual(result, {
      launched: false, prepared: true, text: "",
      errorText: "No model turn was sent, because this session is not authorized to spend subscription quota.",
    });
    assert.equal(coordinationScope.current().remaining, 4);
  } finally { scopeCleanup(directory); }
});

// --- R1: literal dispatch gates the success boundary on the new write chain ---

test("a write-scope positive reply is only a success with a literal dispatched true (read roles)", async () => {
  const directory = scopeTempDir();
  try {
    for (const [flag, expected] of [[true, true], [false, false], [null, null], [undefined, null], [0, null], ["false", null]]) {
      for (const commandId of ["coordinate-plan-codex", "coordinate-review-codex", "coordinate-audit-codex"]) {
        coordinationScope.revoke();
        const granted = coordinationScope.authorize(["codex"], 4, writeAuthorization);
        const result = await launchOne({ GOALPORT_COORDINATE_SEND: "1" }, scopedRuntime(directory, async () => ({ ok: true, text: "The plan looks workable.", errorText: "", messageDispatched: flag })), scopedCommand(commandId), "g", { scope: coordinationScope, scopeGeneration: granted.generation });
        assert.equal(result.launched, flag === true, `${commandId} ${String(flag)} launched`);
        assert.equal(result.dispatched, expected, `${commandId} ${String(flag)} dispatched`);
        assert.equal(result.text, "The plan looks workable.", `${commandId} ${String(flag)} text`);
        assert.equal(result.writeTurnsRemaining, 2, `${commandId} ${String(flag)} write budget`);
        if (flag === true) {
          assert.equal(result.errorText, "", `${commandId} ${String(flag)} errorText`);
          assert.equal(result.turnsRemaining, 3, `${commandId} ${String(flag)} read charge`);
        } else {
          // The useful reply text survives as evidence; the completion itself
          // stays a non-success with a friendly, honest error sentence.
          assert.notEqual(result.errorText, "", `${commandId} ${String(flag)} errorText`);
          assert.equal(result.environmentBlocked, false, `${commandId} ${String(flag)} environmentBlocked`);
          assert.equal(result.environmentDetail, null, `${commandId} ${String(flag)} environmentDetail`);
          if (flag === false) assert.match(result.errorText, /was not sent/, `${commandId} ${String(flag)} literal sentence`);
          else assert.doesNotMatch(result.errorText, /was not sent/, `${commandId} ${String(flag)} unknown never claims not-sent`);
          // A literal false refunds the read dimension; unknown keeps its
          // charge; the write dimension never moves for a read role.
          assert.equal(result.turnsRemaining, flag === false ? 4 : 3, `${commandId} ${String(flag)} read settle`);
        }
      }
    }
  } finally { scopeCleanup(directory); }
});

test("a write-scope execute reply follows the same literal truth and settles the write dimension", async () => {
  const directory = scopeTempDir();
  try {
    for (const [flag, expectedWrite] of [[true, 1], [false, 2], [null, 1], [undefined, 1], [0, 1], ["false", 1]]) {
      coordinationScope.revoke();
      const granted = coordinationScope.authorize(["codex"], 4, writeAuthorization);
      const result = await launchOne({ GOALPORT_COORDINATE_SEND: "1" }, scopedRuntime(directory, async () => ({ ok: true, text: "Applied the fix.", errorText: "", messageDispatched: flag })), writeCommand(), "g", { scope: coordinationScope, scopeGeneration: granted.generation });
      assert.equal(result.launched, flag === true, String(flag));
      assert.equal(result.dispatched, flag === true ? true : flag === false ? false : null, String(flag));
      assert.equal(result.turnsRemaining, 4, `${String(flag)} read budget untouched`);
      assert.equal(result.writeTurnsRemaining, expectedWrite, `${String(flag)} write settle`);
      if (flag !== true) {
        assert.equal(result.text, "Applied the fix.", String(flag));
        assert.notEqual(result.errorText, "", String(flag));
      }
    }
  } finally { scopeCleanup(directory); }
});

test("the non-true positive-reply outcomes follow the actual settlement table", async () => {
  const directory = scopeTempDir();
  try {
    // A literal false refunds and removes only the scope-inserted line.
    coordinationScope.revoke();
    let granted = coordinationScope.authorize(["codex"], 4, writeAuthorization);
    await launchOne({ GOALPORT_COORDINATE_SEND: "1" }, scopedRuntime(directory, async () => ({ ok: true, text: "Half done.", errorText: "", messageDispatched: false })), writeCommand("coordinate-execute-refunded"), "g", { scope: coordinationScope, scopeGeneration: granted.generation });
    assert.equal(coordinationScope.current().write.remaining, 2);
    assert.equal(fs.existsSync(path.join(directory, "send-authorization")), false);

    // An owner's hand-written line survives the refund while the budget
    // still refunds (the historic rows 3+6 pairing).
    fs.writeFileSync(path.join(directory, "send-authorization"), "coordinate-execute-manual\n");
    granted = coordinationScope.authorize(["codex"], 4, writeAuthorization);
    await launchOne({ GOALPORT_COORDINATE_SEND: "1" }, scopedRuntime(directory, async () => ({ ok: true, text: "Half done.", errorText: "", messageDispatched: false })), writeCommand("coordinate-execute-manual"), "g", { scope: coordinationScope, scopeGeneration: granted.generation });
    assert.equal(coordinationScope.current().write.remaining, 2);
    assert.equal(fs.readFileSync(path.join(directory, "send-authorization"), "utf8"), "coordinate-execute-manual\n");

    // A claim that appears during the run keeps the charge whatever the
    // reply says (row 1): the turn reached its claim, so it stands.
    granted = coordinationScope.authorize(["codex"], 4, writeAuthorization);
    await launchOne({ GOALPORT_COORDINATE_SEND: "1" }, scopedRuntime(directory, async () => {
      fs.writeFileSync(path.join(directory, "claim-coordinate-execute-claimed"), "");
      return { ok: true, text: "Applied the fix.", errorText: "", messageDispatched: false };
    }), writeCommand("coordinate-execute-claimed"), "g", { scope: coordinationScope, scopeGeneration: granted.generation });
    assert.equal(coordinationScope.current().write.remaining, 1);
    assert.equal(fs.existsSync(path.join(directory, "claim-coordinate-execute-claimed")), true);
    assert.match(fs.readFileSync(path.join(directory, "send-authorization"), "utf8"), /coordinate-execute-claimed/);
  } finally { scopeCleanup(directory); }
});

test("the true four-role happy chain still completes every role on the write scope", async () => {
  const directory = scopeTempDir();
  try {
    coordinationScope.revoke();
    const granted = coordinationScope.authorize(["codex"], 4, writeAuthorization);
    const ctx = { scope: coordinationScope, scopeGeneration: granted.generation };
    const runtime = scopedRuntime(directory, async () => ({ ok: true, text: "Role output.", errorText: "", messageDispatched: true }));
    const plan = await launchOne({ GOALPORT_COORDINATE_SEND: "1" }, runtime, scopedCommand("coordinate-plan-codex"), "g", ctx);
    const review = await launchOne({ GOALPORT_COORDINATE_SEND: "1" }, runtime, scopedCommand("coordinate-review-codex"), "g", ctx);
    const execute = await launchOne({ GOALPORT_COORDINATE_SEND: "1" }, runtime, writeCommand(), "g", ctx);
    const audit = await launchOne({ GOALPORT_COORDINATE_SEND: "1" }, runtime, scopedCommand("coordinate-audit-codex"), "g", ctx);
    for (const [role, result] of [["plan", plan], ["review", review], ["execute", execute], ["audit", audit]]) {
      assert.equal(result.launched, true, role);
      assert.equal(result.dispatched, true, role);
      assert.equal(result.text, "Role output.", role);
      assert.equal(result.errorText, "", role);
    }
    // Three read turns and one write turn: the dual counters agree.
    assert.equal(coordinationScope.current().remaining, 1);
    assert.equal(coordinationScope.current().write.remaining, 1);
    assert.equal(audit.turnsRemaining, 1);
    assert.equal(audit.writeTurnsRemaining, 1);
  } finally { scopeCleanup(directory); }
});

test("legacy read-only and no-write positive replies keep the pre-existing success behavior", async () => {
  const directory = scopeTempDir();
  try {
    // No scope at all: the historic positive coercion is unchanged.
    const legacy = await launchOne({ GOALPORT_COORDINATE_SEND: "1" }, scopedRuntime(directory, async () => ({ ok: true, text: "Bounded plan.", errorText: "" })), command);
    assert.equal(legacy.launched, true);
    assert.equal(legacy.dispatched, true);
    assert.equal("turnsRemaining" in legacy, false);

    // A read-only scope's plan turn keeps the same positive behavior.
    coordinationScope.revoke();
    const granted = coordinationScope.authorize(["codex"], 4);
    const readOnly = await launchOne({ GOALPORT_COORDINATE_SEND: "1" }, scopedRuntime(directory, async () => ({ ok: true, text: "Bounded plan.", errorText: "" })), scopedCommand("coordinate-plan-codex"), "g", { scope: coordinationScope, scopeGeneration: granted.generation });
    assert.equal(readOnly.launched, true);
    assert.equal(readOnly.dispatched, true);
    assert.equal(readOnly.turnsRemaining, 3);
    assert.equal("writeTurnsRemaining" in readOnly, false);

    // The new audit role is never promoted without a literal true, even on
    // a read-only scope: unknown stays unknown and the charge stands.
    const audit = await launchOne({ GOALPORT_COORDINATE_SEND: "1" }, scopedRuntime(directory, async () => ({ ok: true, text: "Audit notes.", errorText: "" })), scopedCommand("coordinate-audit-codex"), "g", { scope: coordinationScope, scopeGeneration: granted.generation });
    assert.equal(audit.launched, false);
    assert.equal(audit.dispatched, null);
    assert.equal(audit.text, "Audit notes.");
    assert.equal(audit.turnsRemaining, 2);
  } finally { scopeCleanup(directory); }
});
