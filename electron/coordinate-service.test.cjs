const { test } = require("node:test");
const assert = require("node:assert/strict");
const { discoverCoordination, launchOne } = require("./coordinate-service.cjs");

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
      return { ok: true, text: "Bounded plan.", errorText: "" };
    },
  }, command);
  assert.equal(prepared, 0);
  assert.equal(ran, 1);
  assert.equal(result.launched, true);
  assert.equal(result.prepared, true);
  assert.equal(result.text, "Bounded plan.");
  assert.equal(result.errorText, "");
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
