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
import fs, { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const require = createRequire(import.meta.url);
const { createBackgroundHost } = require("../../electron/coordination-background.cjs");
const { createBackgroundSendConsentStore } = require("../../electron/background-send-consent.cjs");
const { controlEndpointFor, createCoordinationJobStore } = require("../../electron/coordination-job.cjs");
const { createCoreConnection } = require("../../electron/core-client.cjs");
const { assertPipePeer, assertCoreIdentity, pipePeerBusy, resolveUnixSocket } = require("../../electron/launch-config.cjs");
const { harnessLaunchConfigured } = require("../../electron/harness-runtime.cjs");
const { authorizeMembershipError } = require("../../electron/coordinate-service.cjs");
const { normalizePiCapacity } = require("../../electron/pi-capacity.mjs");
const { piAdmissionContext, ownAdmissionForRequest } = require("../../electron/pi-capacity-admission.cjs");
const { readRecords, normalizeRecord } = require("../../electron/coordination-record.cjs");
const { resolveSavedTargets, workspaceKey } = require("./saved-targets.cjs");

function savedTargets(directory) {
  try { return resolveSavedTargets(JSON.parse(readFileSync(path.join(directory, "coordination-records.json"), "utf8"))); }
  catch { return resolveSavedTargets([]); }
}
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
  "  native-preflight         Read-only --workspace ABS or --global competing-work check.",
  "  grant-access             Save the durable Background Send consent.",
  "  revoke-access            Remove the durable Background Send consent.",
  "  run                      Admit one coordinated goal. Writes only with both write flags.",
  "  status [--job ID]        Print the live projection exactly as stored.",
  "  stop [--job ID]          Durably revoke access and print the real state.",
  "  result [--request-id ID] Print the saved verdict, plan and review.",
  "  continue --from ID       Continue the selected result (Ready reuses its live allowance)." ,
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
  "  --pi-capacity JSON        Exact configured {provider,model,useExistingCapacity:true}; required for fresh Pi goals.",
  "  --request-id ID          Caller-stable request id for a retry of the same admission.",
  "  --from ID                Saved request id that continue revises.",
  "  --live-request-id ID     Stable caller child ID, required for a Ready live allowance.",
  "  --only-if-ready-from ID  Stop only the matching idle allowance (New goal)." ,
  "  --job ID                 Job id (defaults to the active/newest job).",
  "  --core-binary PATH       Absolute goalport-core executable (run/continue).",
  "  --database PATH          Absolute Core database (default <data-dir>/core.sqlite).",
  "  --pipe NAME|PATH         Operator Core endpoint, ideally the absolute --pipe given to serve.",
  "  --data-dir PATH          Absolute profile directory (default $HOME/.goalport/linux-coordinate).",
  "  --help                   This help.",
  "",
  "Consent: --background is never defaulted and is not write consent. The durable",
  "consent store is the only grant. Pi's explicit configured choice does not confirm billing.",
  "A job whose exit could not be confirmed stays unconfirmed and is never replayed.",
].join("\n");

const OPTIONS = {
  goal: { type: "string" },
  'campaign-id': { type: 'string' },
  'attempt-id': { type: 'string' },
  'turn-request-id': { type: 'string' },
  'material-file': { type: 'string' },
  workspace: { type: "string" },
  global: { type: "boolean" },
  instances: { type: "string" },
  turns: { type: "string" },
  "write-instances": { type: "string" },
  "write-turns": { type: "string" },
  background: { type: "boolean" },
  "pi-capacity": { type: "string" },
  job: { type: "string" },
  "request-id": { type: "string" },
  "live-request-id": { type: "string" },
  "only-if-ready-from": { type: "string" },
  "json-status": { type: "boolean" },
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
    discover: options.discover,
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
    discovered = await context.discover({ stateDir: path.join(context.dataDir, "harness-state"), cwd: context.workspace || process.cwd(), provisional: !context.workspace, routeAwarePi: true });
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
      return !(provider.instanceId === "pi" && provider.piCapacity) && (type === "chatgpt" || type === "subscription") && typeof provider.instanceId === "string";
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
  const discovered = await readDiscovery(io, { ...context, workspace: parsed.values.workspace });
  if (!discovered.ok) return refuse(io, discovered.message);
  if (!discovered.providers.length) {
    write(io, "No signed-in subscription harness was found on this machine.");
    return 0;
  }
  for (const provider of discovered.providers) {
    const status = typeof provider?.auth?.status === "string" ? provider.auth.status : "unknown";
    const type = typeof provider?.auth?.type === "string" ? provider.auth.type : "unknown";
    write(io, `provider ${provider.instanceId}: ${status} (${type})`);
    if (provider.instanceId === "pi" && provider.piCapacity) write(io, `pi capacity: ${JSON.stringify(provider)}`);
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
  if (activeLeftJob(context.dataDir)) {
    return refuse(io, "A left job still holds the admission slot. Run acknowledge before starting another, so nothing was admitted.");
  }
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
  if (parsed.values["request-id"] !== undefined && requestWasLeft(context.dataDir, requestId)) {
    return refuse(io, "The interrupted job stays unreplayed; the same request id cannot be admitted again.");
  }
  const selectedWrite = writeSelection(parsed, selection.workspace);
  if (!selectedWrite.ok) return refuse(io, selectedWrite.message);

  const discovered = await readDiscovery(io, { ...context, workspace: selection.workspace });
  if (!discovered.ok) return refuse(io, discovered.message);
  const instances = instanceList(selection.instancesText, discovered.providers);
  if (instances.length === 0) return refuse(io, "No signed-in subscription harness was found on this machine, so nothing was admitted.");
  if (!instances.every((instance) => /^[A-Za-z0-9._-]+$/.test(instance))) {
    return refuse(io, "A harness id is invalid, so nothing was admitted.");
  }
  // The authorization bridge owns the subscription-only rule; apiKey and
  // unknown logins are refused with its existing sentence before any admission.
  const discoveredMembership = { ok: true, providers: discovered.providers };
  if (selectedWrite.write?.instances.includes("pi")) {
    return refuse(io, "Pi runs read-only turns in this build; workspace changes need a harness with a write sandbox.");
  }
  let piContext;
  let requestedPi = selection.piCapacity;
  if (parsed.values["pi-capacity"] !== undefined) {
    try { requestedPi = JSON.parse(parsed.values["pi-capacity"]); } catch { return refuse(io, "The requested Pi capacity is malformed."); }
    if (!normalizePiCapacity(requestedPi)) return refuse(io, "The requested Pi capacity is malformed.");
  }
  if (instances.includes("pi")) {
    try { piContext = piAdmissionContext({ allowedInstances: instances, workspacePath: selection.workspace, ...(selection.continuation ? { continuation: selection.continuation } : {}), ...(requestedPi !== undefined ? { piCapacity: requestedPi } : {}) }, context.dataDir, discoveredMembership); }
    catch (error) { return refuse(io, error.message); }
  } else if (requestedPi !== undefined) return refuse(io, "Pi capacity needs Pi selected for this goal.");
  const membership = authorizeMembershipError(discoveredMembership, instances, piContext)
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

  if (selection.continuation) {
    const fresh = savedTargets(context.dataDir);
    const selected = fresh.selected(selection.continuation.parentRequestId);
    if (!selected?.rootRequestId || selected.rootRequestId !== selection.continuation.rootRequestId || fresh.head(selected.rootRequestId) !== selection.continuation.parentRequestId || fresh.unique(selected.rootRequestId)?.goal?.trim() !== goal || workspaceKey(selected.record.workspacePath) !== workspaceKey(selection.workspace)) {
      return refuse(io, "The selected saved result changed. Open its latest result and choose Continue again; nothing was admitted.");
    }
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
      ...(selection.continuation ? { continuation: selection.continuation } : {}),
      ...(piContext?.piCapacity ? { piCapacity: piContext.piCapacity } : {}),
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

function activeLeftJob(dataDir) {
  const fs = require("node:fs");
  const path = require("node:path");
  try {
    const active = JSON.parse(fs.readFileSync(path.join(dataDir, "coordination-jobs", "active-admission.json"), "utf8"));
    const jobId = active?.jobId;
    if (typeof jobId !== "string" || !jobId) return null;
    fs.accessSync(path.join(dataDir, "coordination-jobs", "jobs", jobId, "stuck-ack.json"));
    return jobId;
  } catch {
    return null;
  }
}

function requestWasLeft(dataDir, requestId) {
  const fs = require("node:fs");
  const path = require("node:path");
  let names;
  try {
    names = fs.readdirSync(path.join(dataDir, "coordination-jobs", "jobs"));
  } catch {
    return false;
  }
  for (const name of names) {
    const jobDir = path.join(dataDir, "coordination-jobs", "jobs", name);
    try {
      fs.accessSync(path.join(jobDir, "stuck-ack.json"));
      const admission = JSON.parse(fs.readFileSync(path.join(jobDir, "admission.json"), "utf8"));
      if (admission?.input?.requestId === requestId) return true;
    } catch {
      // A job without a readable stuck acknowledgement is not a left request.
    }
  }
  return false;
}

async function commandContinue(parsed, io, context) {
  const from = typeof parsed.values.from === "string" ? parsed.values.from.trim() : "";
  if (!from) return refuse(io, "continue needs --from with the request id of a saved record, so nothing was admitted.");
  // Live branches terminate here on EVERY refusal/unknown. They never reach
  // the fresh-admission path (and never generate a child UUID).
  const liveId = parsed.values["live-request-id"];
  const liveStore = createCoordinationJobStore(context.dataDir, { bootstrapReady: true });
  const active = liveStore.getActiveStatus();
  if (active?.followUpMode === "live-read-once" || liveId !== undefined) {
    const resolved = readHost(context, io);
    if (!resolved.ok) return refuse(io, resolved.message);
    if (typeof liveId !== "string" || !/^[A-Za-z0-9._-]{1,256}$/.test(liveId) || liveId === from) return refuse(io, "Live Continue needs its original caller request id; nothing was sent.");
    if (parsed.values.background !== true || parsed.values["write-instances"] !== undefined || parsed.values["write-turns"] !== undefined || parsed.values["pi-capacity"] !== undefined || parsed.values.turns !== undefined || parsed.values["request-id"] !== undefined) return refuse(io, "Live Continue cannot change the original allowance.");
    const followUp = typeof parsed.values.goal === "string" ? parsed.values.goal.trim() : "";
    const own = ownAdmissionForRequest(context.dataDir, from);
    if (!own || (parsed.values.workspace !== undefined && workspaceKey(parsed.values.workspace) !== workspaceKey(own.workspacePath)) || (parsed.values.instances !== undefined && parsed.values.instances !== own.allowedInstances.join(","))) return refuse(io, "Continue must keep the original folder and harnesses.");
    const jobsRoot = path.join(context.dataDir, "coordination-jobs", "jobs");
    const acceptedOwners = fs.existsSync(jobsRoot) ? fs.readdirSync(jobsRoot).filter(id => /^[0-9a-f-]{36}$/i.test(id)).flatMap(id => {
      const status = liveStore.getStatus(id);
      if (status.requestId !== from) return [];
      const child = liveStore.readOwnedLiveFollowUpContext(id);
      return child ? [{ jobId: id, child }] : [];
    }) : [];
    if (acceptedOwners.length) {
      if (acceptedOwners.length !== 1 || acceptedOwners[0].child.requestId !== liveId || acceptedOwners[0].child.followUp !== followUp) return refuse(io, "The allowance already accepted a different follow-up.");
      const projection = await resolved.host.continueLive(acceptedOwners[0].jobId, { requestId: liveId, fromRequestId: from, followUp });
      writeProjection(io, projection); write(io, `live accepted request: ${liveId}`); return 0;
    }
    if (!active || active.requestId !== from || active.followUpMode !== "live-read-once") return refuse(io, "The original live worker is unavailable; nothing was sent.");
    const targets = savedTargets(context.dataDir), selected = targets.selected(from);
    if (!selected?.rootRequestId || targets.head(selected.rootRequestId) !== from) return refuse(io, "Open the latest initial result; nothing was sent.");
    try {
      const projection = await resolved.host.continueLive(active.jobId, { requestId: liveId, fromRequestId: from, followUp });
      if ((projection?.acceptedRequestId ?? projection?.liveRead?.childRequestId) !== liveId) return refuse(io, "The follow-up acceptance is not confirmed. Keep this request id and check status.");
      writeProjection(io, projection);
      write(io, `live accepted request: ${liveId}`);
      return 0;
    } catch (error) { return refuse(io, error?.message || "The follow-up acceptance is not confirmed; do not resend with a new id."); }
  }
  const targets = savedTargets(context.dataDir);
  const selected = targets.selected(from);
  if (!selected) return refuse(io, "That saved result is missing or ambiguous, so nothing was admitted.");
  if (!selected.rootRequestId) return refuse(io, `${selected.relationUnavailableReason} Nothing was admitted.`);
  const head = targets.head(selected.rootRequestId);
  if (!head) return refuse(io, "The latest result for this goal cannot be identified, so nothing was admitted.");
  if (head !== from) return refuse(io, "A newer result is available. Open the latest result and choose Continue again; nothing was admitted.");
  const record = normalizeRecord(selected.record);
  if (!record) return refuse(io, "That saved result could not be read, so nothing was admitted.");
  const root = targets.unique(selected.rootRequestId);
  const followUp = typeof parsed.values.goal === "string" ? parsed.values.goal.trim() : "";
  const originalGoal = root.goal.trim();
  if (originalGoal.length + followUp.length > 100_000) return refuse(io, "The original goal and follow-up exceed 100,000 characters, so nothing was admitted.");
  if (parsed.values.workspace !== undefined && workspaceKey(parsed.values.workspace) !== workspaceKey(record.workspacePath)) return refuse(io, "Continue must use the saved goal's folder, so nothing was admitted.");
  if (requestWasLeft(context.dataDir, from)) {
    return refuse(io, "The interrupted job stays unreplayed; the same request id cannot be admitted again.");
  }
  const workspace = record.workspacePath;
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
  let own;
  try { own = ownAdmissionForRequest(context.dataDir, from); } catch { /* The strict host still refuses malformed prior admissions. */ }
  const code = await startAdmission(parsed, io, context, {
    goal: originalGoal,
    continuation: { parentRequestId: from, rootRequestId: root.requestId, originalGoal, followUp },
    workspace,
    instancesText: parsed.values.instances ?? (own?.allowedInstances?.includes("pi") ? own.allowedInstances.join(",") : undefined),
    executionFeedback,
    ...(Object.hasOwn(record, "piCapacity") ? { piCapacity: record.piCapacity } : {}),
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
  if (parsed.values["json-status"]) write(io, `job projection: ${JSON.stringify(projection)}`);
  else writeProjection(io, projection);
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
    projection = await resolved.host.revoke(current.jobId, parsed.values["only-if-ready-from"] === undefined ? undefined : { onlyIfReadyFromRequestId: parsed.values["only-if-ready-from"] });
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
  if (parsed.values["request-id"] !== undefined && !/^[A-Za-z0-9._-]{1,256}$/.test(requestId)) return refuse(io, "Choose an exact saved result before opening it.");
  const targets = savedTargets(context.dataDir);
  const selected = requestId ? targets.selected(requestId) : targets.selected(records.find(r=>r.recordKind!=='native-workspace-check')?.requestId);
  const record = selected ? normalizeRecord(selected.record) : null;
  if (!record) {
    return refuse(io, requestId
      ? `The saved result ${requestId} is missing, ambiguous, or unreadable on this profile.`
      : "No coordinated-goal record was saved on this profile.");
  }
  if(record.recordKind === 'native-workspace-check') {
    let bound=false;
    try { const own=require('../../electron/native-check-lookup.cjs').statusForRequest(context.dataDir,record.requestId); bound=!!own && JSON.stringify(own.admission.nativeCheckTarget)===JSON.stringify(require('../../electron/native-workspace-check.cjs').targetOf(record.nativeCheckTarget)) && JSON.stringify(own.admission.nativeCheckMaterial)===JSON.stringify(require('../../electron/native-workspace-check.cjs').materialOf(record.nativeCheckMaterial)) && JSON.stringify(own.admission.piCapacity)===JSON.stringify(record.piCapacity) && own.admission.workspacePath===record.workspacePath; } catch { /* Descriptive damage never repairs or retargets. */ }
    write(io, `Independent workspace check ${record.verdict==='checked'?'returned':'did not complete'}; native association: ${bound?'own target':'unbound'}`);
    write(io,JSON.stringify({requestId:record.requestId,workspacePath:record.workspacePath,nativeCheckTarget:record.nativeCheckTarget,nativeCheckMaterial:record.nativeCheckMaterial,auditText:record.auditText,savedAt:record.savedAt}));
    return 0;
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
  if (record.executionEvidence) {
    const ev = record.executionEvidence;
    const changedLabel = ev.changed === true ? "yes" : ev.changed === false ? "none" : "unknown";
    write(io, `workspace changes: ${changedLabel} (status: ${ev.status})`);
    if (ev.reason) write(io, `workspace evidence note: ${ev.reason}`);
    if (typeof ev.afterDiff === "string" && ev.afterDiff) writeText(io, "workspace diff", ev.afterDiff);
  }
  return 0;
}

async function commandNativePreflight(parsed, io, context) {
  const flags = parsed.values;
  const hasWorkspace = Object.hasOwn(flags, "workspace");
  const global = flags.global === true;
  const allowed = new Set(["workspace", "global", "data-dir", "pipe", "core-binary", "database"]);
  if (hasWorkspace === global || Object.keys(flags).some(key => !allowed.has(key))) {
    return refuse(io, "native-preflight requires exactly one of --workspace ABS or --global.");
  }
  let candidate;
  try {
    if (!fs.statSync(context.dataDir).isDirectory()) throw new Error("profile unavailable");
    // Confirm absence from readable directories, not existsSync(EACCES) == false.
    const profileEntries = fs.readdirSync(context.dataDir);
    if (profileEntries.includes("coordination-jobs")) {
      const storeRoot = path.join(context.dataDir, "coordination-jobs");
      const storeEntries = fs.readdirSync(storeRoot);
      if (storeEntries.includes("jobs")) fs.readdirSync(path.join(storeRoot, "jobs"));
    }
    if (hasWorkspace) {
      if (typeof flags.workspace !== "string" || !path.isAbsolute(flags.workspace)) throw new Error("absolute folder required");
      candidate = fs.realpathSync(flags.workspace);
      if (!path.isAbsolute(candidate) || !fs.statSync(candidate).isDirectory()) throw new Error("folder unavailable");
    }
    const read = readHost(context, io);
    if (!read.ok) return refuse(io, read.message);
    const outstanding = read.host.outstanding(candidate);
    const inventory = read.host.heldWorkspaces(candidate);
    const clear = outstanding === false && inventory?.complete === true && inventory.globalBlock === false
      && Array.isArray(inventory.holds) && (global ? inventory.holds.length === 0
        : inventory.candidate === candidate && inventory.candidateBlocked === false);
    if (!clear) return refuse(io, "Competing work or workspace reservations could not be cleared. Nothing was sent.");
    write(io, `native preflight: ${JSON.stringify({ mode: global ? "global" : "workspace", ...(global ? {} : { workspace: candidate }), outstanding, inventory })}`);
    return 0;
  } catch {
    return refuse(io, "Competing work or workspace reservations could not be checked. Nothing was sent.");
  }
}

async function commandNativeCheck(parsed, io, context) {
  const purpose = require('../../electron/native-workspace-check.cjs');
  const lookup = require('../../electron/native-check-lookup.cjs');
  const start = parsed.positionals[0] === 'native-check-start';
  let absenceConfirmed=false, admissionAttempted=false;
  try {
    const allowed = ['campaign-id','attempt-id','turn-request-id','request-id','pi-capacity','material-file','background','data-dir','pipe','core-binary','database'];
    if (Object.keys(parsed.values).some(k => !allowed.includes(k))) throw Error('Unexpected workspace check option.');
    const target = purpose.targetOf({campaignId:parsed.values['campaign-id'],attemptId:parsed.values['attempt-id'],turnRequestId:parsed.values['turn-request-id']});
    const requestId = requestIdFor(parsed.values['request-id']);
    if (!parsed.values['request-id'] || !requestId) throw Error('A stable workspace check request id is required.');
    const pair = parsed.values['pi-capacity'] === undefined ? undefined : normalizePiCapacity(JSON.parse(parsed.values['pi-capacity']));
    if (parsed.values['pi-capacity'] !== undefined && !pair) throw Error('The requested Pi capacity is malformed.');
    // Resolve a lost final reply BEFORE buffer/capture/auth/preflight/start.
    if (start) {
      const prior = (io.statusForRequest ?? lookup.statusForRequest)(context.dataDir,requestId);
      if (prior) {
        lookup.requireSameTargetPair(prior,target,pair);
        write(io, JSON.stringify({ok:true,job:require('../../electron/coordination-background.cjs').projection(prior)}));
        return 0;
      }
      absenceConfirmed=true;
    }
    if (start && !parsed.values['material-file']) throw Error(purpose.STALE);
    const prepared=prepareAdmission(io,context);
    if (!prepared.ok) throw Error(prepared.message);
    const core=io.nativeCore ?? require('../../electron/coordination-worker.cjs').workerCore({...prepared,identity:{coreSha256:prepared.coreSha256,database:prepared.database,pipe:prepared.connectPath}});
    const freshSnapshot=io.snapshot ?? createAdmissionSnapshot({...prepared,identity:{coreSha256:prepared.coreSha256,database:prepared.database,pipe:prepared.connectPath}});
    const resolved=await purpose.resolveTarget(core,await freshSnapshot(),target);
    const confirmResolved=async()=>{
      const current=await purpose.resolveTarget(core,await freshSnapshot(),target);
      if(current.workspace!==resolved.workspace || current.taskId!==resolved.taskId || current.goal!==resolved.goal || JSON.stringify(current.context)!==JSON.stringify(resolved.context)) throw Error(purpose.STALE);
    };
    const discovered=await readDiscovery(io,{...context,workspace:resolved.workspace});
    if(!discovered.ok) throw Error(discovered.message);
    const offer=discovered.providers.find(p=>p.instanceId==='pi') ?? null;
    if(!pair && !start) { write(io,JSON.stringify({ok:true,offer,workspacePath:resolved.workspace,goal:resolved.goal,backgroundSendConsent:consentStoreOf(context).read().allowed===true}));return 0; }
    if(!pair) throw Error('Select Pi’s exact configured capacity first.');
    const piContext=piAdmissionContext({allowedInstances:['pi'],workspacePath:resolved.workspace,piCapacity:pair},context.dataDir,{ok:true,providers:discovered.providers});
    const membership=authorizeMembershipError({ok:true,providers:discovered.providers},['pi'],piContext);
    if(membership) throw Error(membership);
    const engine=io.engine ?? require(context.enginePath);
    if(!start) {
      const material=await (io.collectNativeMaterial ?? purpose.collectMaterial)(resolved,engine);
      await confirmResolved();
      const packet={requestId,nativeCheckTarget:target,workspacePath:resolved.workspace,goal:resolved.goal,taskId:resolved.taskId,piCapacity:pair,...material};
      if(Buffer.byteLength(JSON.stringify(packet))>256*1024) throw Error('Workspace check packet is too large.');
      write(io,JSON.stringify({ok:true,...packet}));return 0;
    }
    const consent=admissionConsentGate(parsed,io,context);if(consent!==null)return consent;
    const filename=parsed.values['material-file'];
    if(!filename || !path.isAbsolute(filename)) throw Error(purpose.STALE);
    const stat=fs.lstatSync(filename);
    if(!stat.isFile() || stat.isSymbolicLink() || stat.size>256*1024 || (process.platform==='linux' && (stat.mode & 0o077))) throw Error('Workspace preview transport is unavailable.');
    const packet=JSON.parse(readFileSync(filename,'utf8'));
    if(Object.keys(packet).some(k=>!['ok','requestId','nativeCheckTarget','workspacePath','goal','taskId','piCapacity','nativeCheckMaterial','uiExclusions'].includes(k))) throw Error('Malformed workspace check packet.');
    const material=purpose.materialOf(packet.nativeCheckMaterial);
    if(packet.requestId!==requestId || JSON.stringify(purpose.targetOf(packet.nativeCheckTarget))!==JSON.stringify(target) || JSON.stringify(normalizePiCapacity(packet.piCapacity))!==JSON.stringify(pair) || packet.workspacePath!==resolved.workspace || packet.goal!==resolved.goal || packet.taskId!==resolved.taskId || Date.now()-Date.parse(material.capturedAt)>300000 || Date.parse(material.capturedAt)>Date.now()) throw Error(purpose.STALE);
    await (io.recheckNativeMaterial ?? purpose.recheckMaterial)(resolved,material,engine);
    await confirmResolved();
    const host=createHost({...context,...prepared,snapshot:freshSnapshot},io);
    admissionAttempted=true;
    const job=await host.start({requestId,goal:resolved.goal,workspaceRoot:resolved.workspace,readInstances:['pi'],readMaxTurns:2,backgroundConsent:true,piCapacity:pair,nativeCheckTarget:target,nativeCheckMaterial:material});
    write(io,JSON.stringify({ok:true,job}));return 0;
  } catch(error) {
    // Presentation-only disposition. Never a grant/refund: the exact lookup
    // proved this request absent, and these paths never created an admission.
    const knownBeforeAdmission=['background-unavailable','background-consent-required','background-start-in-progress','background-scope-conflict','background-core-refused','background-preflight-failed','background-invalid-admission','background-job-conflict'].includes(error?.code);
    if(start && absenceConfirmed && (!admissionAttempted || knownBeforeAdmission)) write(io,JSON.stringify({nativeCheckRefused:true,previewAgain:true}));
    return refuse(io,error.message);
  }
}

const HANDLERS = {
  'native-check-prepare': commandNativeCheck,
  'native-check-start': commandNativeCheck,
  "native-preflight": commandNativePreflight,
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
