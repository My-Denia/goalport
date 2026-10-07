"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const STOPPED = "The coordination service stopped, so nothing was sent.";
const UNCONFIGURED = "The pinned checkout is not configured, so no harness was assigned.";
const CANCELLED = "The coordination request was replaced, so nothing was sent.";

function configuredPath(value) {
  return typeof value === "string" && value.length > 0 ? value : "";
}

function chosenPath(options, key, envName) {
  if (Object.prototype.hasOwnProperty.call(options, key)) return configuredPath(options[key]);
  return configuredPath(process.env[envName]);
}

function harnessLaunchConfigured(env = process.env) {
  const checkout = configuredPath(env.GOALPORT_HARNESS_CHECKOUT);
  const stateDir = configuredPath(env.GOALPORT_HARNESS_STATE_DIR);
  const serverCwd = configuredPath(env.GOALPORT_HARNESS_SERVER_CWD) || checkout;
  return Boolean(stateDir && serverCwd);
}

function defaultChildPath() {
  const alongside = path.join(__dirname, "pinned-harness-child.ts");
  const unpacked = alongside.replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
  if (unpacked !== alongside && fs.existsSync(unpacked)) return unpacked;
  return alongside;
}

function createHarnessRuntime(options = {}) {
  const childPath = options.childPath ?? defaultChildPath();
  const nodeBin = options.nodeBin ?? process.execPath;
  const useBundledNode = options.nodeBin == null || options.nodeBin === process.execPath;
  const checkout = chosenPath(options, "checkout", "GOALPORT_HARNESS_CHECKOUT");
  const stateDir = chosenPath(options, "stateDir", "GOALPORT_HARNESS_STATE_DIR");
  const serverCwd = chosenPath(options, "serverCwd", "GOALPORT_HARNESS_SERVER_CWD") || (checkout ? path.join(checkout, "apps", "server") : "");
  let child = null;
  let buffer = "";
  let stderrTail = "";
  let sequence = 0;
  const pending = new Map();
  const cancelledGenerations = new Set();
  const cancelledOrder = [];
  let chain = Promise.resolve();

  function generationOf(value) {
    return typeof value === "string" && value.length > 0 ? value : "";
  }

  function markCancelled(generation) {
    if (!generation || cancelledGenerations.has(generation)) return;
    cancelledGenerations.add(generation);
    cancelledOrder.push(generation);
    while (cancelledOrder.length > 64) cancelledGenerations.delete(cancelledOrder.shift());
  }

  function failPending(errorText) {
    for (const waiter of [...pending.values()]) waiter.finish({ ok: false, errorText });
  }

  function start() {
    if (!stateDir || !serverCwd) return null;
    if (child && child.exitCode === null && !child.killed) return child;
    fs.mkdirSync(stateDir, { recursive: true });
    const env = { ...process.env };
    delete env.GOALPORT_COORDINATE_SEND;
    if (useBundledNode) env.ELECTRON_RUN_AS_NODE = "1";
    env.GOALPORT_HARNESS_STATE_DIR = stateDir;
    if (checkout) env.GOALPORT_HARNESS_CHECKOUT = checkout;
    buffer = "";
    stderrTail = "";
    const proc = spawn(nodeBin, ["--experimental-strip-types", childPath], {
      cwd: serverCwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child = proc;
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk) => {
      stderrTail = (stderrTail + chunk).slice(-8192);
    });
    proc.stderr.on("error", () => { /* drained; a dead pipe must not take down the window */ });
    proc.stdin.on("error", () => {
      if (child !== proc) return;
      failPending(STOPPED);
    });
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        const waiter = pending.get(message.id);
        if (!waiter) continue;
        waiter.finish(message);
      }
    });
    const lost = () => {
      if (child !== proc) return;
      child = null;
      failPending(STOPPED);
    };
    proc.on("exit", lost);
    proc.on("error", lost);
    return proc;
  }

  function cancel(generation) {
    const token = generationOf(generation);
    if (!token) return;
    markCancelled(token);
    let heldChild = false;
    for (const waiter of [...pending.values()]) {
      if (waiter.generation !== token) continue;
      heldChild = true;
      waiter.finish({ ok: false, errorText: CANCELLED });
    }
    if (!heldChild) return;
    const proc = child;
    if (!proc || proc.exitCode !== null) return;
    child = null;
    try { proc.kill("SIGKILL"); } catch { /* already gone */ }
  }

  function request(method, extra, timeoutMs, timeoutText, generation) {
    const token = generationOf(generation);
    const id = `goalport-${++sequence}`;
    const run = () => new Promise((resolve) => {
      if (token && cancelledGenerations.has(token)) {
        resolve({ ok: false, errorText: CANCELLED });
        return;
      }
      let proc;
      try {
        proc = start();
      } catch {
        resolve({ ok: false, errorText: STOPPED });
        return;
      }
      if (!proc) {
        resolve({ ok: false, errorText: UNCONFIGURED });
        return;
      }
      if (!proc.stdin || proc.stdin.destroyed || proc.exitCode !== null) {
        resolve({ ok: false, errorText: STOPPED });
        return;
      }
      let settled = false;
      const finish = (message) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pending.delete(id);
        resolve(message);
      };
      const timer = setTimeout(() => {
        finish({ ok: false, errorText: timeoutText });
        if (child === proc) {
          child = null;
          try { proc.kill("SIGKILL"); } catch { /* already gone */ }
        }
      }, timeoutMs);
      pending.set(id, { generation: token, finish });
      try {
        proc.stdin.write(`${JSON.stringify({ id, method, ...extra })}\n`, (error) => {
          if (!error || child !== proc) return;
          finish({ ok: false, errorText: STOPPED });
        });
      } catch {
        finish({ ok: false, errorText: STOPPED });
      }
    });
    const queued = chain.then(run, run);
    chain = queued.then(() => undefined, () => undefined);
    return queued;
  }

  return {
    discover(generation) {
      return request("discover", {}, 120000, "The harness list could not be read, so no harness was assigned.", generation);
    },
    prepare(command, generation) {
      const safe = command && typeof command === "object" ? { ...command } : {};
      delete safe.initialMessage;
      return request("prepare", { command: safe }, 90000, "The read-only session was not prepared, so nothing was sent.", generation);
    },
    run(generation) {
      return request("run", {}, 15000, "No model turn was sent, because this session is not authorized to spend subscription quota.", generation);
    },
    cancel,
    close() {
      const proc = child;
      child = null;
      failPending(STOPPED);
      if (!proc || proc.exitCode !== null) return;
      try {
        proc.stdin.write(`${JSON.stringify({ id: "shutdown", method: "shutdown" })}\n`, () => { /* async EPIPE is handled on the stream */ });
      } catch { /* pipe already closed */ }
      try { proc.kill("SIGTERM"); } catch { /* already gone */ }
      const killer = setTimeout(() => {
        if (proc.exitCode === null) {
          try { proc.kill("SIGKILL"); } catch { /* already gone */ }
        }
      }, 800);
      if (typeof killer.unref === "function") killer.unref();
    },
    checkout,
    stateDir,
    stderrTail() {
      return stderrTail;
    },
  };
}

module.exports = { createHarnessRuntime, harnessLaunchConfigured };
