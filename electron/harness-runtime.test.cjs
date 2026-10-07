const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createHarnessRuntime } = require("./harness-runtime.cjs");

const SENTINEL = "goalport-sentinel-do-not-send-9c2e";

function directoryHas(directory, needle) {
  if (!fs.existsSync(directory)) return false;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (directoryHas(full, needle)) return true;
      continue;
    }
    if (!entry.isFile() || entry.name.endsWith(".png")) continue;
    try {
      if (fs.readFileSync(full).includes(Buffer.from(needle))) return true;
    } catch {
      /* unreadable files are not the goal text */
    }
  }
  return false;
}
test("the runtime starts the child with this process", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-harness-node-"));
  const seen = path.join(directory, "seen.txt");
  const childPath = path.join(directory, "stub-child.cjs");
  fs.writeFileSync(childPath, `
    const fs = require("node:fs");
    fs.writeFileSync(${JSON.stringify(seen)}, process.execPath + "\\n" + (process.env.ELECTRON_RUN_AS_NODE || ""));
    let buffer = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\\n");
      if (newline < 0) return;
      const message = JSON.parse(buffer.slice(0, newline));
      process.stdout.write(JSON.stringify({ id: message.id, ok: false, providers: [], stopReason: "seen" }) + "\\n");
    });
  `);
  const runtime = createHarnessRuntime({
    childPath,
    stateDir: path.join(directory, "state"),
    serverCwd: directory,
  });
  try {
    await runtime.discover();
    const [bin, flag] = fs.readFileSync(seen, "utf8").split("\n");
    assert.equal(bin, process.execPath);
    assert.equal(flag, "1");
  } finally {
    runtime.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("an unconfigured runtime does not spawn a child", async () => {
  const runtime = createHarnessRuntime({
    childPath: path.join(os.tmpdir(), "goalport-harness-missing-child.cjs"),
    checkout: "",
    stateDir: "",
    serverCwd: "",
  });
  const discovered = await runtime.discover();
  assert.equal(discovered.ok, false);
  assert.match(discovered.errorText, /pinned checkout is not configured/);
  runtime.close();
});

function writeStub(directory) {
  const childPath = path.join(directory, "stub-child.cjs");
  fs.writeFileSync(childPath, `
    let buffer = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf("\\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\\n");
        if (!line) continue;
        const message = JSON.parse(line);
        if (message.method === "shutdown") process.exit(0);
        if (message.method === "discover") {
          process.stdout.write(JSON.stringify({ id: message.id, ok: false, providers: [], stopReason: "The pinned checkout does not match, so no harness was assigned." }) + "\\n");
          continue;
        }
        if (message.method === "prepare") {
          const leaked = JSON.stringify(message).includes(${JSON.stringify(SENTINEL)});
          process.stdout.write(JSON.stringify({ id: message.id, ok: !leaked, leaked, messageDispatched: false, disposition: "deny", sandbox: "readOnly", approval: "never", errorText: leaked ? "leaked" : "" }) + "\\n");
          continue;
        }
        if (message.method === "run") {
          process.stdout.write(JSON.stringify({ id: message.id, ok: false, errorText: "No model turn was sent, because this session is not authorized to spend subscription quota." }) + "\\n");
        }
      }
    });
  `);
  return childPath;
}

test("the runtime strips the goal text before it reaches the child", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-harness-"));
  const runtime = createHarnessRuntime({
    childPath: writeStub(directory),
    stateDir: path.join(directory, "state"),
    serverCwd: directory,
  });
  try {
    const discovered = await runtime.discover();
    assert.equal(discovered.ok, false);
    assert.match(discovered.stopReason, /pinned checkout does not match/);
    const prepared = await runtime.prepare({
      type: "goalport.coordinateTurn",
      initialMessage: { text: SENTINEL },
      sandboxPolicy: { type: "readOnly" },
    });
    assert.equal(prepared.leaked, false);
    assert.equal(prepared.messageDispatched, false);
  } finally {
    runtime.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("the pinned child prepares a read-only session without sending the goal", { skip: process.env.GOALPORT_HARNESS_CHILD_INTEGRATION !== "1", timeout: 180000 }, async () => {
  const checkout = process.env.GOALPORT_HARNESS_CHECKOUT;
  assert.equal(typeof checkout, "string");
  assert.ok(checkout.length > 0);
  assert.notEqual(process.env.GOALPORT_COORDINATE_SEND, "1");
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-harness-state-"));
  const authFile = path.join(stateDir, "send-authorization");
  assert.equal(fs.existsSync(authFile), false);
  const childPath = path.join(__dirname, "pinned-harness-child.ts");
  const child = spawn("node", ["--experimental-strip-types", childPath], {
    cwd: path.join(checkout, "apps/server"),
    env: {
      ...process.env,
      GOALPORT_COORDINATE_SEND: "",
      GOALPORT_HARNESS_CHECKOUT: checkout,
      GOALPORT_HARNESS_STATE_DIR: stateDir,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const pending = new Map();
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line) continue;
      const message = JSON.parse(line);
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      waiter(message);
    }
  });
  function ask(message) {
    const id = message.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${message.method} timed out`)), 120000);
      pending.set(id, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
      child.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }
  try {
    const discovered = await ask({ id: "discover", method: "discover" });
    assert.equal(discovered.ok, true);
    assert.ok(Array.isArray(discovered.providers));
    assert.ok(discovered.providers.some((provider) => typeof provider.instanceId === "string" && provider.instanceId.length > 0));
    const provider = discovered.providers.find((item) => typeof item.instanceId === "string" && item.instanceId.length > 0);
    const model = provider.models?.find((item) => typeof item.slug === "string" && item.slug.length > 0)?.slug ?? "model";
    const prepared = await ask({
      id: "prepare",
      method: "prepare",
      command: {
        type: "goalport.coordinateTurn",
        modelSelection: { instanceId: provider.instanceId, model },
        runtimeMode: "approval-required",
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly" },
        workspaceStrategy: { type: "existing_worktree", worktreePath: process.cwd() },
        initialMessage: { text: SENTINEL },
      },
    });
    const detail = `${prepared.errorText || "prepare failed"}\n${stderr.replace(/\/home\/[^/\s]+/g, "/home/<user>").slice(-2500)}`;
    assert.equal(prepared.messageDispatched, false, detail);
    assert.equal(prepared.disposition, "deny", detail);
    assert.equal(prepared.sandbox, "readOnly", detail);
    assert.equal(prepared.ok, true, detail);
    assert.equal(fs.existsSync(authFile), false);
    const combined = `${stdout}\n${stderr}\n${JSON.stringify(prepared)}`;
    assert.equal(combined.includes(SENTINEL), false);
    assert.equal(combined.includes("turn/start"), false);
    assert.equal(directoryHas(stateDir, SENTINEL), false);
  } finally {
    child.stdin.end();
    child.kill("SIGTERM");
  }
});
