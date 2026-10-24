#!/usr/bin/env node
/**
 * Linux coordinated-goal operator CLI (MY-14 Linux code line).
 *
 * This wires the SAME Electron-free coordination stack the desktop window uses
 * (electron/coordination-background.cjs -> coordination-job.cjs store ->
 * dist/coordination-engine.cjs worker) to the unix-socket Core. It is not a
 * second scheduler and it is not a budget authority: the detached worker keeps
 * owning discovery, authorization and the turn scope. The CLI only admits,
 * reads back and controls one goal.
 *
 * Honesty rules this file must keep:
 * - `--background` is required for `run`/`continue`, never defaulted, and maps
 *   1:1 to the host's `backgroundConsent` literal.
 * - The durable consent store is the ONLY grant. Ambient
 *   GOALPORT_COORDINATE_SEND / GOALPORT_HARNESS_CHECKOUT /
 *   GOALPORT_HARNESS_SERVER_CWD are stripped before the host or worker sees an
 *   environment (harness-runtime.cjs treats them as launch/test identities).
 * - Only subscription-authenticated harnesses can be authorized; the apiKey
 *   refusal comes from coordinate-service.cjs's authorizeMembershipError.
 * - Stop states are printed verbatim. A durable revoke whose live control is
 *   unreachable stays `unconfirmed`, never `stopped`, and is not replayed.
 * - The CLI never starts or recovers Core.
 *
 * Stdlib only (node:util parseArgs, node:crypto, node:fs, node:path); the
 * project's .cjs modules are loaded through createRequire.
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const require = createRequire(import.meta.url);
const { createBackgroundHost } = require("../../electron/coordination-background.cjs");
const { createBackgroundSendConsentStore } = require("../../electron/background-send-consent.cjs");
const { controlEndpointFor } = require("../../electron/coordination-job.cjs");
const { createCoreConnection } = require("../../electron/core-client.cjs");
const { assertPipePeer, assertCoreIdentity, pipePeerBusy, resolveUnixSocket } = require("../../electron/launch-config.cjs");
const { harnessLaunchConfigured } = require("../../electron/harness-runtime.cjs");
const { authorizeMembershipError } = require("../../electron/coordinate-service.cjs");
const { readRecords } = require("../../electron/coordination-record.cjs");
const { discoverCliProviders } = require("../../electron/cli-coordinate.cjs");

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const DEFAULT_WORKER_PATH = path.join(PROJECT_ROOT, "electron", "coordination-worker.cjs");
export const DEFAULT_ENGINE_PATH = path.join(PROJECT_ROOT, "dist", "coordination-engine.cjs");

// These two sentences are restated from coordination-background.cjs:128-132,
// not reworded: one refusal per gate, and each gate keeps its own sentence.
// `--background` is the per-goal literal -> background-consent-required.
const BACKGROUND_FLAG_SENTENCE = "Keep working after closing must be explicitly selected.";
// The durable consent store is the profile capability -> background-unavailable.
const DURABLE_CONSENT_SENTENCE = "Background Send is not ready in this GoalPort window yet.";
const ENGINE_BUNDLE_SENTENCE = "The coordination engine bundle is missing; build it with `pnpm build` (or `vite build --config vite.coordination.config.ts`) before starting a coordinated goal.";
const NO_JOB_SENTENCE = "No background goal was found on this profile.";
const UNCONFIRMED_SENTENCE = "The job's exit is unconfirmed; it is not replayed.";
const STRIPPED_ENV = Object.freeze(["GOALPORT_COORDINATE_SEND", "GOALPORT_HARNESS_CHECKOUT", "GOALPORT_HARNESS_SERVER_CWD"]);

const USAGE = [
  "Linux coordinated-goal operator client for the unix-socket Core.",
  "",
  "Usage: node scripts/connected/linux-coordinate.mjs <command> [options]",
  "",
  "Commands:",
  "  discover                 Installed/authenticated harnesses, auth type and health.",
  "  grant-access             Save the durable Background Send consent.",
  "  revoke-access            Remove the durable Background Send consent.",
  "  run                      Admit one coordinated goal. Writes only with both write flags.",
  "  status [--job ID]        Print the live projection exactly as stored.",
  "  stop [--job ID]          Durably revoke access and print the real state.",
  "  result [--request-id ID] Print the saved verdict, plan and review.",
  "  continue --from ID       Admit a new goal carrying the saved plan/review.",
  "  acknowledge [--job ID]   Leave an interrupted job without replaying it.",
  "  release [--job ID]       Free the profile slot after a confirmed terminal job.",
  "",
  "Options:",
  "  --goal TEXT              The goal text (run/continue).",
  "  --workspace PATH         Absolute workspace (run; continue defaults to the saved one).",
  "  --instances a,b          Read harnesses; defaults to every subscription harness discovered.",
  "  --turns N                Read turn cap, 2..32 (default 4).",
  "  --write-instances a,b    Opt-in write harnesses. Never inferred. Requires --write-turns.",
  "  --write-turns N          Write turn cap, 1..8. Requires --write-instances.",
  "  --background             Explicit keep-working-after-closing consent (required for run/continue).",
  "  --request-id ID          Caller-stable request id for a retry of the same admission.",
  "  --from ID                Saved request id that continue revises.",
  "  --job ID                 Job id (defaults to the active/newest job).",
  "  --core-binary PATH       Absolute goalport-core executable (run/continue).",
  "  --database PATH          Absolute Core database (default <data-dir>/core.sqlite).",
  "  --pipe NAME|PATH         Operator Core endpoint, ideally the absolute --pipe given to serve.",
  "  --data-dir PATH          Absolute profile directory (default $HOME/.goalport/linux-coordinate).",
  "  --help                   This help.",
  "",
  "Consent: --background is never defaulted and is not write consent. The durable",
  "consent store is the only grant. Unknown and apiKey logins are never authorized.",
  "A job whose exit could not be confirmed stays unconfirmed and is never replayed.",
].join("\n");

const OPTIONS = {
  goal: { type: "string" },
  workspace: { type: "string" },
  instances: { type: "string" },
  turns: { type: "string" },
  "write-instances": { type: "string" },
  "write-turns": { type: "string" },
  background: { type: "boolean" },
  job: { type: "string" },
  "request-id": { type: "string" },
  from: { type: "string" },
  "data-dir": { type: "string" },
  pipe: { type: "string" },
  "core-binary": { type: "string" },
  database: { type: "string" },
  help: { type: "boolean" },
};

function write(io, line) {
  (io.stdout ?? ((text) => process.stdout.write(text)))(`${line}\n`);
}

function writeError(io, line) {
  (io.stderr ?? ((text) => process.stderr.write(text)))(`${line}\n`);
}

function refuse(io, message) {
  writeError(io, message);
  return 1;
}

function homeDirectory(env) {
  return typeof env.HOME === "string" && env.HOME.length > 0 ? env.HOME : homedir();
}

// The worker inherits exactly the environment the host is given
// (coordination-background.cjs:196). These three are launch/test identities,
// never account configuration (harness-runtime.cjs:21-24, 222): stripping them
// is what makes the durable consent store the only grant and keeps a pinned
// checkout from being silently used by the detached worker.
export function workerEnvironment(env) {
  const next = { ...env };
  const stripped = [];
  for (const key of STRIPPED_ENV) {
    if (Object.hasOwn(next, key)) stripped.push(key);
    delete next[key];
  }
  return { env: next, stripped };
}

function fileSha256(target) {
  try {
    return createHash("sha256").update(readFileSync(target)).digest("hex");
  } catch {
    return "";
  }
}

function memoize(operation) {
  let pending = null;
  return () => {
    if (pending === null) pending = Promise.resolve().then(() => operation());
    return pending;
  };
}

// The Core endpoint is the operator's unix-socket path. `servePipe` stays the
// operator spelling (what Core was started with); `connectPath` and
// identity.pipe are the resolved socket path, exactly like main.cjs's
// coreConnectPath(); identity.pipe === connectPath is the admission contract.
function resolveEndpoint(env, rawPipe) {
  try {
    const connectPath = resolveUnixSocket(rawPipe, env);
    return {
      ok: true,
      servePipe: rawPipe,
      connectPath,
      controlEndpoint: controlEndpointFor(connectPath, { platform: "linux", env }),
    };
  } catch (error) {
    const message = typeof error?.message === "string" && error.message ? error.message : "The Core socket endpoint is invalid.";
    return { ok: false, message };
  }
}

// The CLI's only Core access is the read-only admission snapshot. It never
// starts, recovers or commands Core: allowedMessageTypes refuses anything but
// a snapshot before a socket exists, and ensureCore throws by design. The full
// verification (pipe-peer, startup receipt, assertPipePeer + assertCoreIdentity)
// runs first so an identity mismatch keeps its own message instead of being
// flattened into a lost-attachment fallback.
function createAdmissionSnapshot({ connectPath, servePipe, coreBinary, identity }) {
  const core = createCoreConnection({
    connectPath: () => connectPath,
    connect: (target) => createConnection(target),
    runPeer: () => new Promise((resolve) => {
      execFile(coreBinary, ["pipe-peer", "--pipe", servePipe], { timeout: 5000, windowsHide: true }, (error, stdout) => {
        resolve({ code: error ? (typeof error.code === "number" ? error.code : null) : 0, stdout: String(stdout ?? "") });
      });
    }),
    isBusy: pipePeerBusy,
    assertPeer: (stdout, receipt) => {
      assertPipePeer(stdout, receipt);
      assertCoreIdentity(receipt, identity);
    },
    allowedMessageTypes: ["snapshot"],
    ensureCore: async () => { throw new Error("The Linux coordinate CLI cannot start or recover Core."); },
  });
  return async () => {
    await core.verify();
    return core.invoke({
      protocolVersion: "goalport.ipc.v2",
      requestId: `linux-coordinate-admission-${randomUUID()}`,
      entityVersion: 0,
      messageType: "snapshot",
      payload: {},
    });
  };
}

function createContext(parsed, io) {
  const env = io.env ?? process.env;
  const { env: workerEnv, stripped } = workerEnvironment(env);
  const dataDirFlag = parsed.values["data-dir"];
  const dataDir = typeof dataDirFlag === "string" && dataDirFlag.length > 0
    ? dataDirFlag
    : path.join(homeDirectory(env), ".goalport", "linux-coordinate");
  const dataDirProblem = path.isAbsolute(dataDir) ? null : "--data-dir must be an absolute path.";
  const rawPipe = typeof parsed.values.pipe === "string" && parsed.values.pipe.length > 0 ? parsed.values.pipe : "goalport-core-v1";
  const coreBinaryFlag = parsed.values["core-binary"];
  const databaseFlag = parsed.values.database;
  return {
    env,
    workerEnv,
    strippedKeys: stripped,
    dataDir,
    dataDirProblem,
    rawPipe,
    discover: io.discover ?? ((options) => discoverCliProviders(options)),
    enginePath: io.enginePath ?? DEFAULT_ENGINE_PATH,
    workerPath: io.workerPath ?? DEFAULT_WORKER_PATH,
    coreBinary: typeof coreBinaryFlag === "string" ? coreBinaryFlag.trim() : "",
    database: typeof databaseFlag === "string" && databaseFlag.trim().length > 0
      ? databaseFlag.trim()
      : (dataDirProblem ? "" : path.join(dataDir, "core.sqlite")),
  };
}

// The host reads consent through the store on every start; it is never a
// constant true here (coordination-background.cjs takes a reader).
function createHost(options, io) {
  const hostOptions = {
    directory: () => options.dataDir,
    ready: () => true,
    consent: () => createBackgroundSendConsentStore(options.dataDir).read(),
    env: options.workerEnv,
    ordinaryScope: () => null,
    endpoint: () => options.controlEndpoint,
    workerPath: options.workerPath,
    snapshot: options.snapshot,
    config: () => ({
      connectPath: options.connectPath,
      servePipe: options.servePipe,
      coreBinary: options.coreBinary,
      identity: { coreSha256: options.coreSha256, database: options.database, pipe: options.connectPath },
      stateDir: path.join(options.dataDir, "harness-state"),
      enginePath: options.enginePath,
    }),
  };
  if (Number.isInteger(io.startTimeoutMs)) hostOptions.startTimeoutMs = io.startTimeoutMs;
  if (typeof io.spawn === "function") hostOptions.spawn = io.spawn;
  return createBackgroundHost(hostOptions);
}

function readHost(context, io) {
  const endpoint = resolveEndpoint(context.env, context.rawPipe);
  if (!endpoint.ok) return { ok: false, message: endpoint.message };
  const options = {
    ...context,
    ...endpoint,
    snapshot: async () => ({}),
    coreBinary: "",
    database: "",
    coreSha256: "",
  };
  return { ok: true, host: createHost(options, io) };
}

function discoveryProblemText(discovered) {
  const stopReason = typeof discovered?.stopReason === "string" ? discovered.stopReason.trim() : "";
  if (stopReason) return stopReason;
  const errorText = typeof discovered?.errorText === "string" ? discovered.errorText.trim() : "";
  if (errorText) return errorText;
  return "The harness list could not be read, so no harness was assigned.";
}

async function readDiscovery(io, context) {
  let discovered;
  try {
    discovered = await context.discover({ stateDir: path.join(context.dataDir, "harness-state") });
  } catch (error) {
    return { ok: false, message: discoveryProblemText({ errorText: error?.message }) };
  }
  if (!discovered || discovered.ok === false) return { ok: false, message: discoveryProblemText(discovered) };
  return { ok: true, providers: Array.isArray(discovered.providers) ? discovered.providers : [] };
}

function instanceList(text, providers) {
  if (typeof text === "string" && text.trim().length > 0) {
    return [...new Set(text.split(",").map((item) => item.trim()).filter(Boolean))];
  }
  // Capability matching: with no explicit list, only a harness whose auth
  // type is a confirmed subscription is offered. apiKey and unknown types
  // are never auto-authorized.
  return [...new Set(providers
    .filter((provider) => {
      const type = provider?.auth?.type;
      return (type === "chatgpt" || type === "subscription") && typeof provider.instanceId === "string";
    })
    .map((provider) => provider.instanceId))];
}

function writeSelection(parsed, workspace) {
  const instancesText = parsed.values["write-instances"];
  const turnsText = parsed.values["write-turns"];
  const hasInstances = typeof instancesText === "string";
  const hasTurns = typeof turnsText === "string";
  if (!hasInstances && !hasTurns) return { ok: true, write: null };
  if (!hasInstances || !hasTurns) {
    return { ok: false, message: "Workspace writes need both --write-instances and --write-turns, so nothing was admitted." };
  }
  const instances = [...new Set(instancesText.split(",").map((item) => item.trim()).filter(Boolean))];
  if (instances.length === 0 || !instances.every((instance) => /^[A-Za-z0-9._-]+$/.test(instance))) {
    return { ok: false, message: "A write harness id is invalid, so nothing was admitted." };
  }
  if (!/^[0-9]+$/.test(String(turnsText).trim())) {
    return { ok: false, message: "The write turn cap must be a whole number from 1 through 8, so nothing was admitted." };
  }
  const maxTurns = Number(String(turnsText).trim());
  if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 8) {
    return { ok: false, message: "The write turn cap must be a whole number from 1 through 8, so nothing was admitted." };
  }
  if (typeof workspace !== "string" || !path.isAbsolute(workspace)) {
    return { ok: false, message: "The workspace must be an absolute path, so nothing was admitted." };
  }
  return { ok: true, write: { instances, workspaceRoot: workspace, maxTurns } };
}

function turnCap(value) {
  if (value === undefined) return 4;
  const text = String(value).trim();
  if (!/^[0-9]+$/.test(text)) return null;
  const turns = Number(text);
  return Number.isInteger(turns) && turns >= 2 && turns <= 32 ? turns : null;
}

function requestIdFor(value) {
  if (value === undefined) return `coordinate-${randomUUID()}`;
  const text = String(value).trim();
  return /^[A-Za-z0-9._-]{1,256}$/.test(text) ? text : null;
}

function consentStoreOf(context) {
  return createBackgroundSendConsentStore(context.dataDir);
}

// The durable consent store is the profile capability; --background is the
// explicit per-goal decision. Each gate keeps the host's own sentence, in the
// host's own order (coordination-background.cjs:126-132).
function admissionConsentGate(parsed, io, context) {
  if (!harnessLaunchConfigured(context.workerEnv, () => consentStoreOf(context).read())) return refuse(io, DURABLE_CONSENT_SENTENCE);
  if (parsed.values.background !== true) return refuse(io, BACKGROUND_FLAG_SENTENCE);
  return null;
}

// Everything that must be true BEFORE any admission write: the engine bundle,
// the unix-socket endpoint, the Core executable and database identity. A
// refusal here creates no coordination-jobs directory and spawns nothing.
function prepareAdmission(io, context) {
  if (!existsSync(context.enginePath)) return { ok: false, message: ENGINE_BUNDLE_SENTENCE };
  const endpoint = resolveEndpoint(context.env, context.rawPipe);
  if (!endpoint.ok) return { ok: false, message: endpoint.message };
  if (!context.coreBinary || !path.isAbsolute(context.coreBinary)) {
    return { ok: false, message: "The Core executable is required: pass --core-binary with an absolute path, so nothing was admitted." };
  }
  if (!existsSync(context.coreBinary)) return { ok: false, message: "The Core executable was not found at --core-binary, so nothing was admitted." };
  if (!context.database || !path.isAbsolute(context.database)) return { ok: false, message: "The Core database must be an absolute path, so nothing was admitted." };
  const identity = { coreSha256: fileSha256(context.coreBinary), database: context.database, pipe: endpoint.connectPath };
  const snapshot = memoize(io.snapshot ?? createAdmissionSnapshot({ ...endpoint, coreBinary: context.coreBinary, identity }));
  return {
    ok: true,
    enginePath: context.enginePath,
    connectPath: endpoint.connectPath,
    servePipe: endpoint.servePipe,
    controlEndpoint: endpoint.controlEndpoint,
    coreBinary: context.coreBinary,
    database: context.database,
    coreSha256: identity.coreSha256,
    snapshot,
  };
}

function projectionLines(projection) {
  const counters = projection.counters;
  const pending = projection.pendingCommand;
  const lines = [
    `job: ${projection.jobId}`,
    `request: ${projection.requestId}`,
    `state: ${projection.state}`,
    `live: ${projection.live === true}`,
    `active: ${projection.active === true}`,
    `revoked: ${projection.revoked === true}`,
    `pending command: ${pending ? `${pending.commandId} (${pending.state})` : "none"}`,
    `read turns left: ${counters && counters.readTurnsLeft != null ? counters.readTurnsLeft : "unknown"}`,
    `write turns left: ${counters && counters.writeTurnsLeft != null ? counters.writeTurnsLeft : "unknown"}`,
    `read turn cap: ${projection.readMaxTurns ?? "unknown"}`,
    `workspace: ${projection.workspacePath}`,
  ];
  if (projection.progress && typeof projection.progress.activity === "string") lines.push(`activity: ${projection.progress.activity}`);
  if (projection.outcome) {
    lines.push(`outcome: ${projection.outcome.status}`);
    if (typeof projection.outcome.error === "string" && projection.outcome.error) lines.push(`outcome detail: ${projection.outcome.error}`);
  }
  if (typeof projection.acknowledgedStuckAt === "string") lines.push(`acknowledged stuck at: ${projection.acknowledgedStuckAt}`);
  if (projection.live === true && projection.workerPid != null) lines.push(`worker pid: ${projection.workerPid}`);
  return lines;
}

function writeProjection(io, projection, { note = true } = {}) {
  if (!projection) {
    write(io, NO_JOB_SENTENCE);
    return;
  }
  for (const line of projectionLines(projection)) write(io, line);
  if (note && projection.state === "unconfirmed") write(io, UNCONFIRMED_SENTENCE);
}

function writeText(io, label, text) {
  write(io, `${label}:`);
  for (const line of String(text).split(/\r?\n/)) write(io, line);
}

async function currentJob(host, jobId, io) {
  try {
    return await host.status(typeof jobId === "string" && jobId.trim().length > 0 ? jobId.trim() : undefined);
  } catch (error) {
    writeError(io, error?.message || "The job status could not be read.");
    return undefined;
  }
}

async function commandDiscover(parsed, io, context) {
  const consent = consentStoreOf(context).read();
  // Consent and capability are separate facts, printed on separate lines.
  write(io, `consent: ${consent.allowed ? `granted (${consent.grantedAt})` : "not granted"}`);
  write(io, `capability: ${harnessLaunchConfigured(context.workerEnv, () => consent) ? "available" : "unavailable"}`);
  if (context.strippedKeys.length > 0) {
    write(io, `note: ignored ${context.strippedKeys.join(", ")}; the durable consent store is the only grant.`);
  }
  const discovered = await readDiscovery(io, context);
  if (!discovered.ok) return refuse(io, discovered.message);
  if (!discovered.providers.length) {
    write(io, "No installed and authenticated harness was found on this machine.");
    return 0;
  }
  for (const provider of discovered.providers) {
    const status = typeof provider?.auth?.status === "string" ? provider.auth.status : "unknown";
    const type = typeof provider?.auth?.type === "string" ? provider.auth.type : "unknown";
    write(io, `provider ${provider.instanceId}: ${status} (${type})`);
    if (Array.isArray(provider.models) && provider.models.length > 0) {
      const models = provider.models.map((model) => model?.slug ?? model?.name).filter((model) => typeof model === "string" && model);
      if (models.length > 0) write(io, `  models: ${models.join(", ")}`);
    }
    if (provider.environmentHealth) {
      write(io, `  environment blocked since ${provider.environmentHealth.since}: ${provider.environmentHealth.detail}`);
    }
  }
  return 0;
}

function commandGrant(parsed, io, context) {
  try {
    const consent = consentStoreOf(context).grant();
    write(io, `consent: granted (${consent.grantedAt})`);
  } catch (error) {
    return refuse(io, error?.message || "Background Send consent could not be saved.");
  }
  if (context.strippedKeys.length > 0) {
    write(io, `note: ignored ${context.strippedKeys.join(", ")}; the durable consent store is the only grant.`);
  }
  return 0;
}

function commandRevoke(parsed, io, context) {
  try {
    consentStoreOf(context).revoke();
  } catch (error) {
    return refuse(io, error?.message || "Background Send consent could not be removed.");
  }
  write(io, "consent: not granted");
  write(io, "note: this revokes future starts; an already admitted goal keeps its own stop control.");
  return 0;
}

async function startAdmission(parsed, io, context, selection) {
  const consentRefusal = admissionConsentGate(parsed, io, context);
  if (consentRefusal !== null) return consentRefusal;
  const prepared = prepareAdmission(io, context);
  if (!prepared.ok) return refuse(io, prepared.message);

  const goal = typeof selection.goal === "string" ? selection.goal.trim() : "";
  if (!goal) return refuse(io, "The goal text is required, so nothing was admitted.");
  if (goal.length > 100_000) return refuse(io, "The goal text is too long, so nothing was admitted.");
  if (typeof selection.workspace !== "string" || !path.isAbsolute(selection.workspace)) {
    return refuse(io, "The workspace must be an absolute path, so nothing was admitted.");
  }
  const turns = turnCap(parsed.values.turns);
  if (turns === null) return refuse(io, "The turn cap must be a whole number from 2 through 32, so nothing was admitted.");
  const requestId = requestIdFor(parsed.values["request-id"]);
  if (requestId === null) return refuse(io, "The request id must use letters, digits, dots, underscores or hyphens, so nothing was admitted.");
  const selectedWrite = writeSelection(parsed, selection.workspace);
  if (!selectedWrite.ok) return refuse(io, selectedWrite.message);

  const discovered = await readDiscovery(io, context);
  if (!discovered.ok) return refuse(io, discovered.message);
  const instances = instanceList(selection.instancesText, discovered.providers);
  if (instances.length === 0) return refuse(io, "No installed subscription harness was found on this machine, so nothing was admitted.");
  if (!instances.every((instance) => /^[A-Za-z0-9._-]+$/.test(instance))) {
    return refuse(io, "A harness id is invalid, so nothing was admitted.");
  }
  // The authorization bridge owns the subscription-only rule; apiKey and
  // unknown logins are refused with its existing sentence before any admission.
  const discoveredMembership = { ok: true, providers: discovered.providers };
  if (selectedWrite.write?.instances.includes("pi")) {
    return refuse(io, "Pi runs read-only turns in this build; workspace changes need a harness with a write sandbox.");
  }
  const membership = authorizeMembershipError(discoveredMembership, instances)
    || (selectedWrite.write ? authorizeMembershipError(discoveredMembership, selectedWrite.write.instances) : null);
  if (membership) return refuse(io, membership);
  if (instances.length < 2) {
    return refuse(io, "An independent check needs a second logged-in harness, so nothing was admitted.");
  }

  try {
    await prepared.snapshot();
  } catch (error) {
    return refuse(io, typeof error?.message === "string" && error.message ? error.message : "Core could not confirm this profile, so nothing was admitted.");
  }

  const host = createHost({ ...context, ...prepared, snapshot: prepared.snapshot }, io);
  let projection;
  try {
    projection = await host.start({
      requestId,
      goal,
      workspaceRoot: selection.workspace,
      readInstances: instances,
      readMaxTurns: turns,
      backgroundConsent: true,
      ...(selectedWrite.write ? { write: selectedWrite.write } : {}),
      ...(selection.executionFeedback ? { executionFeedback: selection.executionFeedback } : {}),
    });
  } catch (error) {
    return refuse(io, typeof error?.message === "string" && error.message ? error.message : "GoalPort could not confirm this background start.");
  }
  writeProjection(io, projection);
  if (projection?.state === "unconfirmed") {
    write(io, `The goal was admitted with request id ${requestId}, but the worker's exit is unconfirmed; read it with \`status\` — nothing is replayed.`);
  } else {
    write(io, `The goal was admitted with request id ${requestId}; its worker runs detached and is read with \`status\`.`);
  }
  return 0;
}

async function commandRun(parsed, io, context) {
  return startAdmission(parsed, io, context, {
    goal: parsed.values.goal,
    workspace: parsed.values.workspace,
    instancesText: parsed.values.instances,
  });
}

async function commandContinue(parsed, io, context) {
  const from = typeof parsed.values.from === "string" ? parsed.values.from.trim() : "";
  if (!from) return refuse(io, "continue needs --from with the request id of a saved record, so nothing was admitted.");
  const record = readRecords(context.dataDir).find((item) => item.requestId === from);
  if (!record) return refuse(io, `No saved coordinated-goal record has request id ${from} on this profile, so nothing was admitted.`);
  const workspace = typeof parsed.values.workspace === "string" ? parsed.values.workspace : record.workspacePath;
  // The saved texts travel as execution feedback. They are references, never
  // commands to relaunch: previousCommandIds stays empty, and the new admission
  // gets a fresh request id so the old job is never spawned a second time.
  const executionFeedback = {
    previousPlan: record.planText,
    previousPlanReview: record.reviewText,
    previousExecutionReport: record.executionText ?? null,
    previousExecutionAudit: record.auditText ?? null,
    previousCommandIds: [],
  };
  const code = await startAdmission(parsed, io, context, {
    goal: parsed.values.goal,
    workspace,
    instancesText: parsed.values.instances,
    executionFeedback,
  });
  // Only a real admission earns the note: a refused start replays nothing.
  if (code === 0 && record.verdict === "unconfirmed") {
    write(io, `note: the saved record ${from} is unconfirmed; this new goal did not replay it.`);
  }
  return code;
}

async function commandStatus(parsed, io, context) {
  const resolved = readHost(context, io);
  if (!resolved.ok) return refuse(io, resolved.message);
  const projection = await currentJob(resolved.host, parsed.values.job, io);
  if (projection === undefined) return 1;
  if (projection === null) return refuse(io, NO_JOB_SENTENCE);
  writeProjection(io, projection);
  return 0;
}

async function commandStop(parsed, io, context) {
  const resolved = readHost(context, io);
  if (!resolved.ok) return refuse(io, resolved.message);
  const current = await currentJob(resolved.host, parsed.values.job, io);
  if (current === undefined) return 1;
  if (current === null) return refuse(io, NO_JOB_SENTENCE);
  let projection;
  try {
    projection = await resolved.host.revoke(current.jobId);
  } catch (error) {
    return refuse(io, typeof error?.message === "string" && error.message ? error.message : "The stop could not be recorded.");
  }
  writeProjection(io, projection, { note: false });
  if (projection.live !== true && projection.state === "unconfirmed") {
    // Verbatim honesty: the durable revoke is real, the exit is not known, and
    // the turn is not replayed. The word "stopped" is never substituted.
    write(io, "The stop is durably recorded; the job's exit remains unconfirmed and its turn is not replayed.");
  }
  return 0;
}

async function commandAcknowledge(parsed, io, context) {
  const resolved = readHost(context, io);
  if (!resolved.ok) return refuse(io, resolved.message);
  const current = await currentJob(resolved.host, parsed.values.job, io);
  if (current === undefined) return 1;
  if (current === null) return refuse(io, NO_JOB_SENTENCE);
  let projection;
  try {
    projection = await resolved.host.acknowledge(current.jobId);
  } catch (error) {
    return refuse(io, typeof error?.message === "string" && error.message ? error.message : "The job could not be acknowledged.");
  }
  writeProjection(io, projection);
  if (typeof projection.acknowledgedStuckAt === "string") {
    write(io, "The interrupted job stays unreplayed; the same request id cannot be admitted again.");
  }
  return 0;
}

async function commandRelease(parsed, io, context) {
  const resolved = readHost(context, io);
  if (!resolved.ok) return refuse(io, resolved.message);
  const current = await currentJob(resolved.host, parsed.values.job, io);
  if (current === undefined) return 1;
  if (current === null) return refuse(io, NO_JOB_SENTENCE);
  let projection;
  try {
    projection = await resolved.host.releaseConfirmedTerminal(current.jobId);
  } catch (error) {
    return refuse(io, typeof error?.message === "string" && error.message ? error.message : "The profile slot could not be released.");
  }
  writeProjection(io, projection);
  if (projection.active !== true) write(io, "The profile admission slot is not held by this job.");
  return 0;
}

function commandResult(parsed, io, context) {
  const records = readRecords(context.dataDir);
  const requestId = typeof parsed.values["request-id"] === "string" ? parsed.values["request-id"].trim() : "";
  const record = requestId ? records.find((item) => item.requestId === requestId) : records[0];
  if (!record) {
    return refuse(io, requestId
      ? `No saved coordinated-goal record has request id ${requestId} on this profile.`
      : "No coordinated-goal record was saved on this profile.");
  }
  write(io, `request: ${record.requestId}`);
  write(io, `workspace: ${record.workspacePath}`);
  write(io, `goal: ${record.goal}`);
  write(io, `verdict: ${record.verdict}`);
  write(io, `stop reason: ${record.stopReason}`);
  write(io, `planning harness: ${record.planningHarness ?? "unknown"}`);
  write(io, `review harness: ${record.reviewHarness ?? "unknown"}`);
  // Quotas are printed exactly as observed; an unknown quota is never shown as
  // a subscription guarantee.
  write(io, `planning quota: ${record.planningQuota ?? "unknown"}`);
  write(io, `review quota: ${record.reviewQuota ?? "unknown"}`);
  write(io, `dispatched: ${record.messageDispatched === true ? "true" : record.messageDispatched === false ? "false" : "unknown"}`);
  write(io, `saved: ${record.savedAt ?? "unknown"}`);
  if (typeof record.planText === "string" && record.planText) writeText(io, "plan", record.planText);
  if (typeof record.reviewText === "string" && record.reviewText) writeText(io, "review", record.reviewText);
  if (typeof record.result === "string" && record.result) writeText(io, "result", record.result);
  if (typeof record.executionText === "string" && record.executionText) writeText(io, "execution", record.executionText);
  if (typeof record.auditText === "string" && record.auditText) writeText(io, "audit", record.auditText);
  return 0;
}

const HANDLERS = {
  discover: commandDiscover,
  "grant-access": commandGrant,
  "revoke-access": commandRevoke,
  run: commandRun,
  status: commandStatus,
  stop: commandStop,
  result: commandResult,
  continue: commandContinue,
  acknowledge: commandAcknowledge,
  release: commandRelease,
};

/**
 * One CLI invocation. `io` is the test/integration seam: env, stdout/stderr
 * writers, discovery, the Core snapshot, spawn, startTimeoutMs and the
 * worker/engine paths. Production calls use the real defaults.
 */
export async function main(argv, io = {}) {
  let parsed;
  try {
    parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    writeError(io, typeof error?.message === "string" ? error.message : "The arguments could not be read.");
    writeError(io, USAGE);
    return 1;
  }
  const command = parsed.positionals[0] ?? "";
  if (parsed.values.help || command === "help") {
    write(io, USAGE);
    return 0;
  }
  if (!command) {
    writeError(io, "A subcommand is required.");
    writeError(io, USAGE);
    return 1;
  }
  if (parsed.positionals.length > 1) {
    writeError(io, "Only one subcommand can be given at a time.");
    return 1;
  }
  const handler = HANDLERS[command];
  if (!handler) {
    writeError(io, `Unknown subcommand ${command}; use --help.`);
    return 1;
  }
  const context = createContext(parsed, io);
  if (context.dataDirProblem) return refuse(io, context.dataDirProblem);
  return handler(parsed, io, context);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath && import.meta.url === invokedPath) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error) => {
      process.stderr.write(`${typeof error?.message === "string" ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
