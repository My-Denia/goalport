"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const STOPPED = "The coordination service stopped, so nothing was sent.";
const UNCONFIGURED = "The pinned checkout is not configured, so no harness was assigned.";

function configuredPath(value) {
  return typeof value === "string" && value.length > 0 ? value : "";
}

function chosenPath(options, key, envName) {
  if (Object.prototype.hasOwnProperty.call(options, key)) return configuredPath(options[key]);
  return configuredPath(process.env[envName]);
}

function createHarnessRuntime(options = {}) {
  const childPath = options.childPath ?? path.join(__dirname, "pinned-harness-child.ts");
  const nodeBin = options.nodeBin ?? "node";
  const checkout = chosenPath(options, "checkout", "GOALPORT_HARNESS_CHECKOUT");
  const stateDir = chosenPath(options, "stateDir", "GOALPORT_HARNESS_STATE_DIR");
  const serverCwd = chosenPath(options, "serverCwd", "GOALPORT_HARNESS_SERVER_CWD") || (checkout ? path.join(checkout, "apps", "server") : "");
  let child = null;
  let buffer = "";
  let sequence = 0;
  const pending = new Map();
  let chain = Promise.resolve();

  function failPending(errorText) {
    for (const waiter of pending.values()) waiter({ ok: false, errorText });
    pending.clear();
  }

  function start() {
    if (!stateDir || !serverCwd) return null;
    if (child && child.exitCode === null && !child.killed) return child;
    fs.mkdirSync(stateDir, { recursive: true });
    const env = { ...process.env };
    delete env.GOALPORT_COORDINATE_SEND;
    env.GOALPORT_HARNESS_STATE_DIR = stateDir;
    if (checkout) env.GOALPORT_HARNESS_CHECKOUT = checkout;
    buffer = "";
    child = spawn(nodeBin, ["--experimental-strip-types", childPath], {
      cwd: serverCwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
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
        pending.delete(message.id);
        waiter(message);
      }
    });
    const lost = () => {
      child = null;
      failPending(STOPPED);
    };
    child.on("exit", lost);
    child.on("error", lost);
    return child;
  }

  function request(method, extra, timeoutMs, timeoutText) {
    const id = `goalport-${++sequence}`;
    const run = () => new Promise((resolve) => {
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
      if (!proc?.stdin || proc.stdin.destroyed || proc.exitCode !== null) {
        resolve({ ok: false, errorText: STOPPED });
        return;
      }
      const timer = setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        resolve({ ok: false, errorText: timeoutText });
        try { proc.kill("SIGKILL"); } catch { /* already gone */ }
        child = null;
      }, timeoutMs);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      try {
        proc.stdin.write(`${JSON.stringify({ id, method, ...extra })}\n`);
      } catch {
        clearTimeout(timer);
        pending.delete(id);
        resolve({ ok: false, errorText: STOPPED });
      }
    });
    const queued = chain.then(run, run);
    chain = queued.then(() => undefined, () => undefined);
    return queued;
  }

  return {
    discover() {
      return request("discover", {}, 120000, "The harness list could not be read, so no harness was assigned.");
    },
    prepare(command) {
      const safe = command && typeof command === "object" ? { ...command } : {};
      delete safe.initialMessage;
      return request("prepare", { command: safe }, 90000, "The read-only session was not prepared, so nothing was sent.");
    },
    run() {
      return request("run", {}, 15000, "No model turn was sent, because this session is not authorized to spend subscription quota.");
    },
    close() {
      const proc = child;
      child = null;
      failPending(STOPPED);
      if (!proc || proc.exitCode !== null) return;
      try {
        proc.stdin.write(`${JSON.stringify({ id: "shutdown", method: "shutdown" })}\n`);
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
  };
}

module.exports = { createHarnessRuntime };
