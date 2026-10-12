import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STUB_BEHAVIORS } from "../stub-harness.mjs";
import { normalizeExecutionFixture } from "./execution-fixture.mjs";

const IDENTITIES = Object.freeze(["codex", "claude"]);
const DEFAULT_BEHAVIOR = Object.freeze({
  probes: Object.freeze({ codex: "codex-probe-authenticated", claude: "claude-probe-authenticated" }),
  turns: Object.freeze({ codex: Object.freeze([]), claude: Object.freeze([]) }),
});
const BEHAVIOR_FILE = "behavior.json";
const LOG_FILE = "invocations.jsonl";
const HARNESS_PATH = fileURLToPath(new URL("../stub-harness.mjs", import.meta.url));

function normalizeBehavior(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("stub behavior must be an object");
  const probes = {};
  const turns = {};
  for (const identity of IDENTITIES) {
    const probeId = input.probes?.[identity];
    if (typeof probeId !== "string" || !probeId.startsWith(`${identity}-probe-`) || STUB_BEHAVIORS[probeId]?.kind !== "probe") {
      throw new TypeError(`probes.${identity} must name a known ${identity} probe response`);
    }
    probes[identity] = probeId;
    const queue = input.turns?.[identity];
    if (!Array.isArray(queue) || queue.some((behaviorId) => typeof behaviorId !== "string" || !behaviorId.startsWith(`${identity}-`) || STUB_BEHAVIORS[behaviorId]?.kind !== "turn")) {
      throw new TypeError(`turns.${identity} must be an ordered queue of known turn responses`);
    }
    turns[identity] = [...queue];
  }
  return {
    probes,
    turns,
    ...(input.executionFixture === undefined ? {} : { executionFixture: normalizeExecutionFixture(input.executionFixture) }),
  };
}

function writeJsonAtomically(filename, value) {
  const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    fs.renameSync(temporary, filename);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function validateExecutable(platform, executable) {
  if (typeof executable !== "string" || executable.length === 0) throw new TypeError("an absolute Node executable path is required");
  const absolute = platform === "win32" ? path.win32.isAbsolute(executable) : path.posix.isAbsolute(executable);
  if (!absolute || /[\r\n"]/u.test(executable) || (platform === "win32" && executable.includes("%"))) {
    throw new TypeError("Node executable must be an absolute path safe for a generated wrapper");
  }
  return executable;
}

function validateScriptPath(platform, scriptPath) {
  if (typeof scriptPath !== "string" || scriptPath.length === 0) throw new TypeError("an absolute stub program path is required");
  const absolute = platform === "win32" ? path.win32.isAbsolute(scriptPath) : path.posix.isAbsolute(scriptPath);
  if (!absolute || /[\r\n"]/u.test(scriptPath) || (platform === "win32" && scriptPath.includes("%"))) {
    throw new TypeError("stub program must use an absolute path safe for a generated wrapper");
  }
  return scriptPath;
}

function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function renderPosixWrapper(identity, nodeExecutable, scriptPath, stubDir) {
  return [
    "#!/bin/sh",
    `GOALPORT_STUB_DIR=${shellQuote(stubDir)}`,
    "export GOALPORT_STUB_DIR",
    `exec ${shellQuote(nodeExecutable)} ${shellQuote(scriptPath)} ${identity} "$@"`,
    "",
  ].join("\n");
}

function renderWindowsWrapper(identity, nodeExecutable, scriptPath) {
  // `%~dp0` makes the generated stub directory independent of the checkout
  // path. Paths are quoted so Node and the harness still resolve under spaces.
  return [
    "@echo off",
    "setlocal DisableDelayedExpansion",
    'set "GOALPORT_STUB_DIR=%~dp0"',
    `"${nodeExecutable}" "${scriptPath}" ${identity} %*`,
    "exit /b %errorlevel%",
    "",
  ].join("\r\n");
}

function configPath(stubDir) {
  return path.join(stubDir, BEHAVIOR_FILE);
}

function writeConfig(stubDir, sentinel, input, executionFixture = undefined) {
  const normalized = normalizeBehavior({ ...input, ...(executionFixture === undefined ? {} : { executionFixture }) });
  const config = {
    schemaVersion: 1,
    sentinel,
    queueEpoch: crypto.randomUUID(),
    probes: normalized.probes,
    turns: normalized.turns,
    ...(normalized.executionFixture === undefined ? {} : { executionFixture: normalized.executionFixture }),
  };
  writeJsonAtomically(configPath(stubDir), config);
  return config;
}

/**
 * Materialize both provider stubs for the selected runtime platform. On Unix,
 * PATH receives executable `codex` and `claude` shims; on Windows, it receives
 * `codex.cmd` and `claude.cmd` shims. Both always launch the absolute Node
 * executable and the same checked-in harness program.
 */
export function materializeStubBin(stubDir, options = {}) {
  if (typeof stubDir !== "string" || !path.isAbsolute(stubDir)) throw new TypeError("stub directory must be an absolute path");
  const platform = options.platform ?? process.platform;
  if (platform !== "win32" && platform !== "linux" && platform !== "darwin") throw new TypeError(`unsupported stub platform: ${platform}`);
  const nodeExecutable = validateExecutable(platform, options.nodeExecutable ?? process.execPath);
  const scriptPath = validateScriptPath(platform, options.scriptPath ?? HARNESS_PATH);
  fs.mkdirSync(stubDir, { recursive: true });
  const sentinel = options.sentinel ?? crypto.randomBytes(32).toString("hex");
  if (typeof sentinel !== "string" || sentinel.length < 16 || /[\r\n]/u.test(sentinel)) throw new TypeError("stub sentinel must be a non-empty opaque token");
  const initialBehavior = options.behavior ?? DEFAULT_BEHAVIOR;
  writeConfig(stubDir, sentinel, initialBehavior, options.executionFixture);

  const wrappers = {};
  for (const identity of IDENTITIES) {
    const extension = platform === "win32" ? ".cmd" : "";
    const wrapperPath = path.join(stubDir, `${identity}${extension}`);
    const content = platform === "win32"
      ? renderWindowsWrapper(identity, nodeExecutable, scriptPath)
      : renderPosixWrapper(identity, nodeExecutable, scriptPath, stubDir);
    fs.writeFileSync(wrapperPath, content, { encoding: "utf8", mode: 0o700 });
    if (platform !== "win32") fs.chmodSync(wrapperPath, 0o700);
    wrappers[identity] = wrapperPath;
  }
  // Keep a pre-existing invocation log if a caller intentionally rematerializes
  // wrappers, but never seed it with fake evidence.
  if (!fs.existsSync(path.join(stubDir, LOG_FILE))) fs.writeFileSync(path.join(stubDir, LOG_FILE), "", { mode: 0o600 });
  return { stubDir, wrappers, sentinel };
}

/**
 * Replace the per-run response map. Every rewrite starts a fresh queue epoch;
 * the append-only invocation log retains earlier probe/turn evidence.
 */
export function writeStubBehavior(stubDir, behavior) {
  const existing = JSON.parse(fs.readFileSync(configPath(stubDir), "utf8"));
  if (existing?.schemaVersion !== 1 || typeof existing.sentinel !== "string" || !existing.sentinel) {
    throw new Error("cannot update stub behavior before materializeStubBin has created the sentinel");
  }
  writeConfig(stubDir, existing.sentinel, behavior, existing.executionFixture);
}

/** Pure wrapper renderer exports make the Windows quoting contract testable on non-Windows hosts. */
export const stubWrapperSource = Object.freeze({
  posix: renderPosixWrapper,
  windows: renderWindowsWrapper,
});
