"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { guardCoordinateCommand } = require("./coordinate-service.cjs");

const API_KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "XAI_API_KEY"];
const UNAUTHORIZED = "No model turn was sent, because this session is not authorized to spend subscription quota.";
const STARTED = "A model turn was started, so this stopped.";
const REPLACED = "The coordination request was replaced, so nothing was sent.";
const NO_TEXT = "The harness finished without any text, so this stopped.";
const NOT_FINISHED = "The harness did not finish, so this stopped.";
const NOT_INSTALLED = "This harness is not installed, so nothing was sent.";
const CREDITS = "This model requires extra usage credits. It was not used.";

function creditGated(model) {
  return typeof model === "string" && /fable/i.test(model);
}

function codexModel(configText) {
  const match = /^[ \t]*model[ \t]*=[ \t]*"([^"\n]+)"[ \t]*$/m.exec(String(configText));
  return match ? match[1].trim() : "";
}

function scrub(env) {
  const next = { ...env };
  for (const key of API_KEYS) delete next[key];
  return next;
}

function outputText(result) {
  return `${result?.stdout ?? ""}\n${result?.stderr ?? ""}`;
}

// The last thing a CLI printed before dying is usually the actual reason.
// One line, bounded, so a failing turn can show it instead of a generic stop.
function stderrDetail(stderr) {
  const lines = String(stderr ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? "";
  return last.slice(0, 300);
}

// Canonical cmd.exe quoting for .cmd/.bat launch, adapted from cross-spawn
// (MIT, Copyright (c) 2018 Made With MOXY Lda). With /d /s /c, cmd strips the
// payload's first and last quote; quoting each element alone makes a resolved
// path with a space split apart and lets prompt text run as commands or
// redirections (reproduced against real cmd.exe, 2026-10-08). The carets keep
// every cmd metacharacter inert across the .cmd shim's own %* re-parse, and
// the outer quote pair is what /s strips.
const CMD_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

function cmdEscapeCommand(text) {
  return String(text).replace(CMD_META_CHARS, "^$1");
}

function cmdEscapeArgument(value) {
  let arg = String(value)
    .replace(/(?=(\\+?)?)\1"/g, "$1$1\\\"")
    .replace(/(?=(\\+?)?)\1$/, "$1$1");
  arg = `"${arg}"`;
  arg = arg.replace(CMD_META_CHARS, "^$1");
  return arg.replace(CMD_META_CHARS, "^$1");
}

function resolveCommand(file, env = process.env, platform = process.platform) {
  if (platform !== "win32") return file;
  if (path.isAbsolute(file) && fs.existsSync(file)) return file;
  const dirs = String(env.PATH || env.Path || "").split(path.delimiter).filter(Boolean);
  const extensions = String(env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").map((item) => item.trim()).filter(Boolean);
  const suffixes = path.extname(file) ? [""] : extensions;
  for (const dir of dirs) {
    for (const ext of suffixes) {
      const candidate = path.join(dir, ext ? `${file}${ext}` : file);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        /* the next candidate */
      }
    }
  }
  return file;
}

function launchSpec(file, args, env = process.env, platform = process.platform) {
  const resolved = resolveCommand(file, env, platform);
  if (platform === "win32" && /\.(cmd|bat)$/i.test(resolved)) {
    const payload = [cmdEscapeCommand(resolved), ...args.map(cmdEscapeArgument)].join(" ");
    return {
      file: env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", `"${payload}"`],
      verbatim: true,
    };
  }
  return { file: resolved, args, verbatim: false };
}

// TerminateProcess reaches only the child it is handed. When the CLI resolved
// to a .cmd/.bat shim the child is cmd.exe and the real CLI is its grandchild,
// so a plain kill leaves the model turn running and spending quota. taskkill
// /T is the Windows tree terminator; the child's own close event still settles
// whoever is waiting on it.
function killProcessTree(child, options = {}) {
  const platform = options.platform ?? process.platform;
  const spawnFn = options.spawnFn ?? spawn;
  if (platform === "win32" && child && typeof child.pid === "number") {
    try {
      const killer = spawnFn("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore" });
      killer?.on?.("error", () => {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
      });
      return;
    } catch { /* fall through to a direct kill */ }
  }
  try { child.kill("SIGKILL"); } catch { /* already gone */ }
}

function defaultExec(file, args, options = {}) {
  const spec = launchSpec(file, args);
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(spec.file, spec.args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: scrub(options.env ?? process.env),
        windowsVerbatimArguments: spec.verbatim,
      });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    let settled = false;
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle(value);
    };
    const timer = setTimeout(() => {
      killProcessTree(child);
      finish(reject, Object.assign(new Error("Timed out"), { code: "ETIMEDOUT" }));
    }, options.timeoutMs ?? 8000);
    child.on("error", (error) => finish(reject, error));
    // A nonzero exit still hands back the output: the login-status text is
    // parsed downstream regardless of the exit code, as the old synchronous
    // probe did.
    child.on("close", () => finish(resolve, { stdout, stderr }));
  });
}

function provider(input) {
  return {
    instanceId: input.instanceId,
    displayName: input.displayName,
    driver: input.driver,
    enabled: true,
    installed: true,
    availability: "available",
    status: "ready",
    auth: input.auth,
    models: input.models,
  };
}

async function codexProvider(io) {
  let status = "";
  try {
    status = outputText(await io.execFile("codex", ["login", "status"]));
  } catch {
    return null;
  }
  const api = /api key/i.test(status);
  const chatgpt = /logged in using chatgpt/i.test(status);
  if (!api && !chatgpt) return null;
  let model = "";
  try {
    model = codexModel(io.readFile(path.join(io.home, ".codex", "config.toml")));
  } catch {
    model = "";
  }
  return provider({
    instanceId: "codex",
    displayName: "Codex",
    driver: "codex",
    auth: {
      status: "authenticated",
      type: api ? "apiKey" : "chatgpt",
      label: api ? "API key" : "ChatGPT",
    },
    models: !api && model
      ? [{ slug: model, name: model, isDefault: true, isLegacy: false }]
      : [],
  });
}

async function claudeProvider(io) {
  let raw = "";
  try {
    const text = outputText(await io.execFile("claude", ["auth", "status", "--json"]));
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    raw = start >= 0 && end > start ? text.slice(start, end + 1) : text;
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || parsed.loggedIn !== true) return null;
  const method = typeof parsed.authMethod === "string" ? parsed.authMethod : "";
  const api = /api[_-]?key/i.test(method);
  const subscription = !api && (method === "claude.ai" || typeof parsed.subscriptionType === "string");
  if (!api && !subscription) return null;
  return provider({
    instanceId: "claude",
    displayName: "Claude",
    driver: "claude",
    auth: {
      status: "authenticated",
      type: api ? "apiKey" : "subscription",
      label: api ? "API key" : "subscription",
    },
    // The CLI's own default can be the credit model. Subscription logins use
    // the documented opus alias. An API-key login is not given a model.
    models: subscription
      ? [{ slug: "opus", name: "opus", isDefault: true, isLegacy: false }]
      : [],
  });
}

async function discoverCliProviders(io = {}) {
  const probe = {
    execFile: io.execFile ?? ((file, args) => defaultExec(file, args, { timeoutMs: io.timeoutMs, env: io.env })),
    readFile: io.readFile ?? ((file) => fs.readFileSync(file, "utf8")),
    home: io.home ?? os.homedir(),
  };
  return {
    ok: true,
    providers: (await Promise.all([codexProvider(probe), claudeProvider(probe)])).filter(Boolean),
    stopReason: null,
  };
}

function commandIdOf(command) {
  const commandId = typeof command?.commandId === "string" ? command.commandId.trim() : "";
  return /^[a-zA-Z0-9._-]+$/.test(commandId) ? commandId : "";
}

function worktreeOf(command) {
  const strategy = command?.workspaceStrategy;
  const worktree = strategy && typeof strategy.worktreePath === "string" ? strategy.worktreePath.trim() : "";
  return worktree;
}

function promptOf(command) {
  const text = command?.initialMessage?.text;
  return typeof text === "string" ? text : "";
}

function modelOf(command) {
  const model = command?.modelSelection?.model;
  return typeof model === "string" ? model.trim() : "";
}

function instanceOf(command) {
  const instanceId = command?.modelSelection?.instanceId;
  return typeof instanceId === "string" ? instanceId : "";
}

function turnSpec(command) {
  const model = modelOf(command);
  const worktree = worktreeOf(command);
  const prompt = promptOf(command);
  if (!worktree || !prompt.trim() || !model) {
    return { errorText: "The read-only session was not prepared, so nothing was sent." };
  }
  if (creditGated(model)) return { errorText: CREDITS };
  if (instanceOf(command) === "codex") {
    return {
      file: "codex",
      cwd: worktree,
      args: ["exec", "--json", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check", "--cd", worktree, prompt],
    };
  }
  if (instanceOf(command) === "claude") {
    return {
      file: "claude",
      cwd: worktree,
      args: ["-p", "--output-format", "json", "--permission-mode", "plan", "--permission-prompts", "none", "--model", model, prompt],
    };
  }
  return { errorText: NOT_INSTALLED };
}

function codexReply(stdout) {
  let text = "";
  for (const line of String(stdout).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const item = event?.item ?? event?.params?.item;
    const kind = typeof item?.type === "string" ? item.type : "";
    if (/^agent[_ ]?message$/i.test(kind) && typeof item.text === "string" && item.text.trim()) {
      text = item.text.trim();
    }
  }
  return text;
}

function claudeReply(stdout) {
  try {
    const parsed = JSON.parse(String(stdout));
    if (typeof parsed?.result === "string") {
      return { text: parsed.result.trim(), failed: parsed.is_error === true };
    }
  } catch {
    /* a plain print is the reply */
  }
  return { text: String(stdout).trim(), failed: false };
}

function replyFrom(instanceId, stdout) {
  if (instanceId === "codex") return { text: codexReply(stdout), failed: false };
  if (instanceId === "claude") return claudeReply(stdout);
  return { text: "", failed: true };
}

function ledgerFile(stateDir) {
  return path.join(stateDir, "sent-turns.json");
}

function readLedger(stateDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(ledgerFile(stateDir), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeLedger(stateDir, ledger) {
  fs.mkdirSync(stateDir, { recursive: true });
  const tmp = path.join(stateDir, `.sent-turns.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(ledger));
  fs.renameSync(tmp, ledgerFile(stateDir));
}

function claimFile(stateDir, commandId) {
  return path.join(stateDir, `claim-${commandId}`);
}

function storedResult(stateDir, commandId) {
  const stored = readLedger(stateDir)[commandId];
  if (stored && typeof stored === "object") return stored;
  return { ok: false, text: "", errorText: STARTED, messageDispatched: true };
}

function claimTurn(stateDir, commandId) {
  fs.mkdirSync(stateDir, { recursive: true });
  try {
    const fd = fs.openSync(claimFile(stateDir, commandId), "wx");
    fs.closeSync(fd);
  } catch (error) {
    if (error && error.code === "EEXIST") return { fresh: false, result: storedResult(stateDir, commandId) };
    throw error;
  }
  const ledger = readLedger(stateDir);
  ledger[commandId] = { ok: false, text: "", errorText: STARTED, messageDispatched: true };
  writeLedger(stateDir, ledger);
  return { fresh: true };
}

function finishTurn(stateDir, commandId, result) {
  const ledger = readLedger(stateDir);
  ledger[commandId] = result;
  writeLedger(stateDir, ledger);
}

function releaseTurn(stateDir, commandId) {
  const ledger = readLedger(stateDir);
  delete ledger[commandId];
  writeLedger(stateDir, ledger);
  fs.rmSync(claimFile(stateDir, commandId), { force: true });
}

function grantFile(stateDir) {
  return path.join(stateDir, "send-authorization");
}

function grantLines(stateDir) {
  const file = grantFile(stateDir);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
}

function takeGrant(stateDir, commandId) {
  const lines = grantLines(stateDir);
  if (!lines.includes(commandId)) return false;
  const next = lines.filter((line) => line !== commandId);
  if (next.length === 0) fs.rmSync(grantFile(stateDir), { force: true });
  else fs.writeFileSync(grantFile(stateDir), `${next.join("\n")}\n`);
  return true;
}

function restoreGrant(stateDir, commandId) {
  const lines = grantLines(stateDir);
  if (lines.includes(commandId)) return;
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(grantFile(stateDir), `${[...lines, commandId].join("\n")}\n`);
}

function defaultSpawn(spec) {
  return new Promise((resolve) => {
    let child;
    try {
      const launched = launchSpec(spec.file, spec.args, spec.env);
      child = spawn(launched.file, launched.args, {
        cwd: spec.cwd,
        env: spec.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsVerbatimArguments: launched.verbatim,
      });
    } catch {
      resolve({ code: null, stdout: "", spawnError: true });
      return;
    }
    spec.register?.(child);
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = (stdout + chunk).slice(-200000);
    });
    // The reply is stdout, but a nonzero exit often carries the real reason
    // (authentication, quota, provider errors) on stderr only.
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-4096);
    });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      killProcessTree(child);
      finish({ code: null, stdout, stderr, timedOut: true });
    }, spec.timeoutMs ?? 660000);
    child.on("error", () => finish({ code: null, stdout, stderr, spawnError: true }));
    child.on("close", (code) => finish({ code, stdout, stderr, timedOut: false }));
  });
}

async function runCliTurn(command, options = {}) {
  const refused = { ok: false, text: "", errorText: UNAUTHORIZED, messageDispatched: false };
  const stateDir = typeof options.stateDir === "string" ? options.stateDir : "";
  const commandId = commandIdOf(command);
  if (!stateDir || !commandId) return refused;
  if (fs.existsSync(claimFile(stateDir, commandId))) return storedResult(stateDir, commandId);
  if (!grantLines(stateDir).includes(commandId)) return refused;
  const problem = guardCoordinateCommand(command);
  if (problem) return { ok: false, text: "", errorText: problem, messageDispatched: false };
  const spec = turnSpec(command);
  if (spec.errorText) return { ok: false, text: "", errorText: spec.errorText, messageDispatched: false };
  const claimed = claimTurn(stateDir, commandId);
  if (!claimed.fresh) return claimed.result;
  if (!takeGrant(stateDir, commandId)) {
    releaseTurn(stateDir, commandId);
    return refused;
  }
  if (options.cancelled?.()) {
    const replaced = { ok: false, text: "", errorText: REPLACED, messageDispatched: false };
    finishTurn(stateDir, commandId, replaced);
    return replaced;
  }
  const spawnTurn = options.spawnTurn ?? defaultSpawn;
  let spawned;
  try {
    spawned = await spawnTurn({
      file: spec.file,
      args: spec.args,
      cwd: spec.cwd,
      env: scrub(options.env ?? process.env),
      register: options.register,
    });
  } catch {
    spawned = { code: null, stdout: "", spawnError: true };
  }
  if (spawned?.spawnError) {
    releaseTurn(stateDir, commandId);
    restoreGrant(stateDir, commandId);
    return { ok: false, text: "", errorText: NOT_INSTALLED, messageDispatched: false };
  }
  if (options.cancelled?.()) {
    const replaced = { ok: false, text: "", errorText: REPLACED, messageDispatched: true };
    finishTurn(stateDir, commandId, replaced);
    return replaced;
  }
  const reply = replyFrom(instanceOf(command), spawned?.stdout ?? "");
  if (spawned?.code === 0 && reply.text && !reply.failed) {
    const done = { ok: true, text: reply.text, errorText: "", messageDispatched: true };
    finishTurn(stateDir, commandId, done);
    return done;
  }
  // The stderr tail rides along on the stop sentence (never into `text`) so
  // the typed provider-error mapping can see the real reason and the user is
  // not left with a generic "finished without any text".
  const detail = stderrDetail(spawned?.stderr);
  const stopSentence = !reply.text ? NO_TEXT : (reply.failed ? reply.text : NOT_FINISHED);
  const failed = {
    ok: false,
    text: reply.text,
    errorText: detail ? `${stopSentence} ${detail}` : stopSentence,
    messageDispatched: true,
  };
  finishTurn(stateDir, commandId, failed);
  return failed;
}

module.exports = {
  discoverCliProviders,
  runCliTurn,
  codexModel,
  codexReply,
  claudeReply,
  turnSpec,
  launchSpec,
  killProcessTree,
  defaultExec,
};
