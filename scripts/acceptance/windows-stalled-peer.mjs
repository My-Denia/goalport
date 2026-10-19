// MY-116 — measure whether the WINDOWS Core control plane still answers `snapshot` and `safe_stop`
// while a Codex `initialize` handshake is deliberately withheld by the synthetic app-server.
//
// This file replaces the previous 188-line probe, which wrote `.fake-codex-scenario` but never made
// Core launch the fixture, issued a create-only `create_campaign_with_task` "concurrency" phase,
// never sent Stop, and hardcoded `reproductionVerdict = 'confirmed_source_architecture'` regardless
// of measurements. Nothing here is taken from source reading: every claim in `my116-report.json`
// comes from a response (or its absence) measured on a real Core process.
//
// WIRING (S4.2–S4.3)
//   * The node executable running this probe is copied byte-for-byte to `<shim>/codex.exe`.
//   * Core runs with a CHILD-ONLY PATH (`<shim>` first) and a CHILD-ONLY isolated APPDATA that
//     contains no `@openai/codex` candidate. `resolve_native_executable("codex")` therefore falls
//     through its APPDATA x64/arm64 candidates to the PATH `codex`, which must be that copy.
//   * Before spawn this file resolves Core's exact order itself (APPDATA x64, APPDATA arm64, PATH).
//     If the resolved file is not the copied node — for example a real installed Codex — the probe
//     aborts instead of measuring a real CLI.
//   * The workspace holds a cwd-local ESM loader named `app-server` importing the existing fixture,
//     so Core's `codex app-server --listen stdio://` runs the fixture under node.
//
// STALL WINDOW (S4.5–S4.7)
//   * A baseline first-send (`start_conversation` with `{workspaceRoot, provider:"codex", message}`)
//     proves the fake peer is actually launched and a real attempt/turn runs. A create-only request
//     is not a baseline.
//   * A second, fresh DB/workspace sends `start_conversation` with scenario `stall_initialize`. The
//     fixture records receipt of `initialize` and withholds its (unchanged) reply until
//     `.fake-codex-release` appears.
//   * While that start request is still outstanding, `snapshot` and `safe_stop` are issued
//     CONCURRENTLY over SEPARATE pipe connections. `safe_stop` names
//     `attemptId = "attempt-" + sha256(raw start requestId UTF-8, lowercase hex)`.
//   * Only responses that arrive while the reply is withheld, inside the stated 2 s OBSERVATION
//     BOUND (not a product SLA), count as timely. A response after the release marker is late.
//   * A `safe_stop` body saying "no proven cancellable live turn" is not a successful Stop. It
//     counts as responsive only if it arrived inside the window; Stop effectiveness is recorded
//     separately from responsiveness.
//
// VERDICT (S4.8, no hardcoded reproduction claim)
//   baseline invalid or stall unproved                     -> `inconclusive`
//   both control requests blocked during a proven stall    -> `reproduced`
//   both control requests timely with valid responses      -> `not_reproduced` (this scenario only)
//   any other mix (partial block, invalid control sample)  -> `inconclusive`
//
// Usage (native Windows x64):
//   node scripts/acceptance/windows-stalled-peer.mjs \
//     --core <package>/resources/goalport-core.exe --out <fresh evidence directory>
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..', '..');
const FIXTURE_PATH = path.join(
  REPO_ROOT,
  'crates/goalport-core/tests/fixtures/fake-codex-app-server/fake-codex-app-server.mjs',
);

export const PROBE_NAME = 'MY-116 Windows stalled-peer probe';
export const PROBE_SCHEMA = 'goalport.my116.stalled-peer.v2';
export const UI_PROTOCOL_VERSION = 'goalport.ipc.v2';
/** Observation bound for the quiet control window. Explicitly NOT a product SLA. */
export const OBSERVATION_WINDOW_MS = 2000;
export const BASELINE_SCENARIO = 'linger';
export const STALL_SCENARIO = 'stall_initialize';
/** The fixture sees `node app-server --listen stdio://`: argv[0..] is the script's tail. */
export const EXPECTED_FIXTURE_ARGV = Object.freeze(['--listen', 'stdio://']);
/**
 * Core's `resolve_native_executable("codex")` candidates, in order, relative to %APPDATA%.
 * Copied verbatim from crates/goalport-core/src/runtime_manager.rs so the pre-spawn resolution
 * below matches the binary being measured.
 */
export const APPDATA_CODEX_CANDIDATES = Object.freeze([
  'npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe',
  'npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-arm64/vendor/aarch64-pc-windows-msvc/bin/codex.exe',
]);
export const INITIALIZED_MARKER = '.fake-codex-initialized.marker';
export const RELEASE_MARKER = '.fake-codex-release';
export const STOP_MARKER = '.fake-codex-stop.marker';

const USAGE =
  'usage: node scripts/acceptance/windows-stalled-peer.mjs --core <goalport-core.exe> --out <fresh evidence directory> [--expect-responsive]';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const now = () => performance.now();

/** Monotonic ms clock (floats). Every timing in the report has this single origin per process. */
function roundMs(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

export function sha256Bytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export function sha256File(file) {
  return sha256Bytes(fs.readFileSync(file));
}

export function attemptIdForStartRequest(requestId) {
  if (typeof requestId !== 'string' || requestId.length === 0) {
    throw new Error('a raw start_conversation requestId is required to derive the stop target');
  }
  return `attempt-${sha256Bytes(Buffer.from(requestId, 'utf8'))}`;
}

/**
 * Normalize a Windows path for comparison: strip the extended-length prefix Rust's
 * `fs::canonicalize` adds, resolve, drop trailing separators and case-fold. Both Core's
 * `operational_workspace_path` and node's `process.cwd()` produce spellings this reconciles.
 */
export function normalizeWindowsPath(value) {
  if (typeof value !== 'string' || value.trim() === '') return '';
  let text = value.trim();
  if (text.toLowerCase().startsWith('\\\\?\\unc\\')) text = `\\\\${text.slice(8)}`;
  else if (text.startsWith('\\\\?\\')) text = text.slice(4);
  return path.win32.resolve(text).replace(/[\\/]+$/, '').toLowerCase();
}

export function samePath(left, right) {
  const a = normalizeWindowsPath(left);
  const b = normalizeWindowsPath(right);
  return a !== '' && a === b;
}

export function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function parseArgs(argv) {
  const result = { core: null, out: null };
  if (!Array.isArray(argv)) throw new Error(USAGE);
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (flag === '--expect-responsive') {
      if (result.expectResponsive) throw new Error('--expect-responsive was provided more than once');
      result.expectResponsive = true;
      index -= 1;
      continue;
    }
    const value = argv[index + 1];
    if (!['--core', '--out'].includes(flag)) throw new Error(`unknown argument ${flag}; ${USAGE}`);
    if (typeof value !== 'string' || value === '' || value.startsWith('--')) {
      throw new Error(`${flag} requires a value; ${USAGE}`);
    }
    const key = flag.slice(2);
    if (result[key] !== null) throw new Error(`${flag} was provided more than once; ${USAGE}`);
    result[key] = value;
  }
  if (!result.core || !result.out) throw new Error(USAGE);
  return result;
}

export function assertWindowsHost(platform = process.platform, arch = process.arch) {
  if (platform !== 'win32' || arch !== 'x64') {
    throw new Error(`native Windows x64 required for MY-116; got ${platform}/${arch}`);
  }
}

/** Fresh pipe, DB, workspace, APPDATA, shim and raw dirs under the probe's own output directory. */
export function planProbe(outDir, { token = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}` } = {}) {
  const root = path.resolve(String(outDir));
  const phase = name => {
    const dir = path.join(root, name);
    return {
      name,
      dir,
      db: path.join(dir, 'goalport.sqlite'),
      workspace: path.join(dir, 'workspace'),
      appData: path.join(dir, 'appdata'),
      shim: path.join(dir, 'shim'),
      raw: path.join(dir, 'raw'),
      stdoutLog: path.join(dir, 'core.stdout.log'),
      stderrLog: path.join(dir, 'core.stderr.log'),
      pipe: `\\\\.\\pipe\\goalport-my116-${name}-${token}`,
    };
  };
  return {
    root,
    token,
    reportPath: path.join(root, 'my116-report.json'),
    baseline: phase('baseline'),
    stall: phase('stall'),
  };
}

export function appDataCandidates(appData) {
  return APPDATA_CODEX_CANDIDATES.map(relative =>
    path.win32.join(appData, ...relative.split('/')),
  );
}

/** The isolated APPDATA must not contain a real `@openai/codex` candidate at any checked path. */
export function isolatedAppDataProblems({ appData, exists = fs.existsSync }) {
  const problems = [];
  for (const candidate of appDataCandidates(appData)) {
    if (exists(candidate)) problems.push(`isolated APPDATA contains a Codex candidate: ${candidate}`);
  }
  return problems;
}

/**
 * Resolve `codex` exactly as `resolve_native_executable` will inside Core: APPDATA x64, APPDATA
 * arm64, then the PATH entry. `isFile` is injectable for unit tests.
 */
export function resolveCoreCodex({
  appData,
  pathValue,
  isFile = value => {
    try {
      return fs.statSync(value).isFile();
    } catch {
      return false;
    }
  },
  pathApi = path.win32,
}) {
  const candidates = appData ? appDataCandidates(appData) : [];
  for (let index = 0; index < candidates.length; index += 1) {
    if (isFile(candidates[index])) {
      return { source: index === 0 ? 'appdata-x64' : 'appdata-arm64', resolvedPath: candidates[index], candidates };
    }
  }
  const directories = String(pathValue ?? '')
    .split(';')
    .filter(Boolean);
  for (const directory of directories) {
    const clean = directory.replace(/^"|"$/g, '');
    for (const name of ['codex.exe', 'codex']) {
      const candidate = pathApi.join(clean, name);
      if (isFile(candidate)) return { source: 'path', resolvedPath: candidate, candidates, pathDirectory: clean };
    }
  }
  return { source: 'unresolved', resolvedPath: null, candidates, pathDirectory: null };
}

/**
 * Pre-spawn guard: the file Core will execute must be the copied node. A real installed Codex, a
 * missing PATH entry or a byte mismatch aborts the probe before any native launch.
 */
export function assertFakeCodexResolution({
  resolution,
  expectedPath,
  expectedSha256,
  resolvedSha256,
  shimDir,
}) {
  const problems = [];
  if (!resolution || !resolution.resolvedPath) {
    problems.push(
      `codex was not resolvable through Core's order (source ${resolution?.source ?? 'unknown'}); refusing to fall through to a real installation`,
    );
    return { ok: false, problems };
  }
  if (!samePath(resolution.resolvedPath, expectedPath)) {
    problems.push(
      `Core's resolution (${resolution.source}) selected ${resolution.resolvedPath}, not the copied node at ${expectedPath}`,
    );
  }
  if (resolvedSha256 !== expectedSha256) {
    problems.push(
      `resolved codex bytes do not match the copied node.exe (${resolvedSha256} != ${expectedSha256})`,
    );
  }
  if (!isInside(shimDir, resolution.resolvedPath)) {
    problems.push(`resolved codex is outside the test shim directory: ${resolution.resolvedPath}`);
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Child-only environment for Core. Inherited `GOALPORT_*` switches are removed (an inherited
 * `GOALPORT_CODEX_TRANSPORT=exec` would silently change the measured path); PATH is shim-first and
 * APPDATA is the isolated directory.
 */
export function buildCoreEnv({ baseEnv = process.env, shimDir, appData, nonce }) {
  const env = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (upper === 'PATH' || upper.startsWith('GOALPORT_')) continue;
    env[key] = value;
  }
  const inheritedPath = baseEnv.PATH ?? baseEnv.Path ?? '';
  env.PATH = inheritedPath ? `${shimDir};${inheritedPath}` : shimDir;
  env.APPDATA = appData;
  env.GOALPORT_LAUNCH_NONCE = nonce;
  env.GOALPORT_REQUIRE_ISOLATED = '1';
  return env;
}

/** The wire envelope the Core UI server expects (goalport.ipc.v2). */
export function encodeUiRequest({ requestId, messageType, payload = {}, entityVersion = 0 }) {
  const body = Buffer.from(
    JSON.stringify({ protocolVersion: UI_PROTOCOL_VERSION, requestId, entityVersion, messageType, payload }),
    'utf8',
  );
  const frame = Buffer.allocUnsafe(4 + body.length);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

function takeFrame(state) {
  if (state.buffer.length < 4) return { done: false };
  const length = state.buffer.readUInt32LE(0);
  if (length > 16 * 1024 * 1024) return { done: true, parseError: `frame length ${length} exceeds bound` };
  if (state.buffer.length < 4 + length) return { done: false };
  const payload = state.buffer.subarray(4, 4 + length);
  state.buffer = state.buffer.subarray(4 + length);
  try {
    return { done: true, value: JSON.parse(payload.toString('utf8')) };
  } catch (error) {
    return { done: true, parseError: `response is not JSON: ${error.message}` };
  }
}

/**
 * One measured request/response on its own pipe connection. All timestamps are absolute monotonic
 * milliseconds; the caller derives deltas. `timedOut` means the window elapsed without a frame.
 */
export function issueControlSample(
  pipeName,
  request,
  { windowMs = OBSERVATION_WINDOW_MS, clock = now, connect = net.connect } = {},
) {
  const measurement = {
    messageType: request.messageType,
    requestId: request.requestId,
    payload: request.payload ?? {},
    issuedAt: clock(),
    connectedAt: null,
    writtenAt: null,
    flushedAt: null,
    respondedAt: null,
    connectError: null,
    writeError: null,
    connectionClosed: false,
    timedOut: false,
    parseError: null,
    response: null,
  };
  return new Promise(resolve => {
    let socket = null;
    let settled = false;
    let timer = null;
    const state = { buffer: Buffer.alloc(0) };
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (socket) {
        socket.removeAllListeners();
        try {
          socket.destroy();
        } catch {
          // already gone
        }
      }
      resolve(measurement);
    };
    timer = setTimeout(() => {
      measurement.timedOut = true;
      finish();
    }, Math.max(1, windowMs));
    try {
      socket = connect(pipeName);
    } catch (error) {
      measurement.connectError = `${error.code ?? 'error'}: ${error.message}`;
      finish();
      return;
    }
    socket.once('connect', () => {
      measurement.connectedAt = clock();
      try {
        socket.write(encodeUiRequest(request), error => {
          if (error) {
            measurement.writeError = error.message;
            finish();
            return;
          }
          measurement.flushedAt = clock();
        });
        // The call was accepted by the transport; the flush callback is recorded separately.
        measurement.writtenAt = clock();
      } catch (error) {
        measurement.writeError = error.message;
        finish();
      }
    });
    socket.on('data', chunk => {
      state.buffer = Buffer.concat([state.buffer, chunk]);
      const frame = takeFrame(state);
      if (frame.done) {
        measurement.respondedAt = clock();
        measurement.response = frame.value ?? null;
        if (frame.parseError) measurement.parseError = frame.parseError;
        finish();
      }
    });
    socket.on('error', error => {
      if (measurement.connectedAt == null) measurement.connectError = `${error.code ?? 'error'}: ${error.message}`;
      else measurement.writeError = `${error.code ?? 'error'}: ${error.message}`;
      finish();
    });
    socket.on('close', () => {
      if (settled) return;
      if (measurement.respondedAt == null) measurement.connectionClosed = true;
      finish();
    });
  });
}

function responseLooksValid(messageType, response) {
  if (response == null || typeof response !== 'object' || Array.isArray(response)) return false;
  if (messageType === 'snapshot') {
    return response.ok === true && response.payload != null && typeof response.payload.snapshot === 'object';
  }
  if (messageType === 'safe_stop') {
    // Any well-formed answer is responsive; whether it was an effective Stop is scored separately.
    return typeof response.ok === 'boolean';
  }
  return false;
}

/**
 * Score one measured sample against the observation bound and the release marker. A late response
 * (after the window or after the release marker) is NOT timely; it is recorded as late rather than
 * silently upgrading the verdict.
 */
export function scoreControlSample(sample, { windowMs = OBSERVATION_WINDOW_MS, releaseAt = null } = {}) {
  if (!sample || typeof sample !== 'object') {
    return {
      present: false,
      timely: false,
      blocked: false,
      lateResponse: false,
      afterRelease: false,
      responseValid: false,
      respondedAfterMs: null,
      invalid: ['sample_missing'],
      reasons: ['sample_missing'],
    };
  }
  const invalid = [];
  if (sample.connectError) invalid.push('connect_error');
  if (sample.writeError) invalid.push('write_error');
  if (sample.connectedAt != null && sample.writtenAt == null) invalid.push('request_not_written');
  if (sample.connectionClosed && sample.respondedAt == null) invalid.push('connection_closed_without_response');
  if (sample.parseError) invalid.push('response_unparsed');
  if (sample.respondedAt != null && sample.response == null) invalid.push('response_unparsed');

  const respondedAfterMs =
    sample.respondedAt != null && sample.issuedAt != null ? sample.respondedAt - sample.issuedAt : null;
  const withinWindow = respondedAfterMs != null && respondedAfterMs <= windowMs;
  const afterRelease =
    sample.respondedAt != null && releaseAt != null && sample.respondedAt > releaseAt;
  const timely = withinWindow && !afterRelease && invalid.length === 0;
  const lateResponse = respondedAfterMs != null && !timely && invalid.length === 0;
  const blocked = !timely && invalid.length === 0;
  const connectTimedOut = sample.connectedAt == null && sample.timedOut === true && !sample.connectError;
  const responseValid = timely && responseLooksValid(sample.messageType, sample.response);

  const reasons = [];
  if (invalid.length > 0) reasons.push(...invalid);
  else if (timely) reasons.push('timely_response');
  else if (lateResponse) reasons.push(afterRelease ? 'response_after_release' : 'response_after_window');
  else reasons.push('no_response_within_window');

  return {
    present: true,
    timely,
    blocked,
    connectTimedOut,
    lateResponse,
    afterRelease,
    responseValid,
    respondedAfterMs,
    invalid,
    reasons,
  };
}

export function classifyStopEffectiveness(score) {
  if (!score || !score.timely) {
    return {
      responsiveInWindow: false,
      effective: false,
      classification: score?.lateResponse ? 'late_response' : score?.invalid?.length ? 'invalid_sample' : 'blocked',
      detail: score?.reasons ?? [],
    };
  }
  const response = score.sample?.response ?? null;
  const receipt = response?.payload?.receipt ?? null;
  const errorText =
    (typeof response?.error === 'string' && response.error) ||
    (typeof response?.payload?.rejection?.message === 'string' && response.payload.rejection.message) ||
    '';
  if (response?.ok === true && receipt && (receipt.confirmed === true ||
      (receipt.startupCancel === 'confirmed' && receipt.nativePromptSent === false &&
       receipt.attemptId === score.sample?.payload?.attemptId))) {
    return { responsiveInWindow: true, effective: true, classification: 'confirmed', detail: receipt };
  }
  if (/no proven cancellable live turn/i.test(errorText)) {
    return {
      responsiveInWindow: true,
      effective: false,
      classification: 'no_proven_cancellable_live_turn',
      detail: errorText,
    };
  }
  if (response?.ok === true) {
    return { responsiveInWindow: true, effective: false, classification: 'unconfirmed', detail: receipt };
  }
  return { responsiveInWindow: true, effective: false, classification: 'refused', detail: errorText };
}

export function summarizeControlSample(sample) {
  if (sample == null) return null;
  return {
    messageType: sample.messageType ?? null,
    requestId: sample.requestId ?? null,
    payload: sample.payload ?? null,
    issuedAt: roundMs(sample.issuedAt),
    connectedAt: roundMs(sample.connectedAt),
    writtenAt: roundMs(sample.writtenAt),
    flushedAt: roundMs(sample.flushedAt),
    respondedAt: roundMs(sample.respondedAt),
    connectAfterMs: sample.connectedAt != null ? roundMs(sample.connectedAt - sample.issuedAt) : null,
    responseAfterMs: sample.respondedAt != null ? roundMs(sample.respondedAt - sample.issuedAt) : null,
    connectError: sample.connectError ?? null,
    writeError: sample.writeError ?? null,
    connectionClosed: sample.connectionClosed === true,
    connectTimedOut: sample.connectedAt == null && sample.timedOut === true && !sample.connectError,
    timedOut: sample.timedOut === true,
    parseError: sample.parseError ?? null,
    response: summarizeUiResponse(sample.response),
  };
}

function summarizeUiResponse(response) {
  if (response == null || typeof response !== 'object') return null;
  const payload = response.payload;
  return {
    ok: typeof response.ok === 'boolean' ? response.ok : null,
    requestId: response.requestId ?? null,
    error: response.error ?? null,
    payloadKeys:
      payload != null && typeof payload === 'object' && !Array.isArray(payload) ? Object.keys(payload) : [],
    attemptId: payload?.snapshot?.attempt?.id ?? payload?.attemptId ?? null,
    attemptState: payload?.snapshot?.attempt?.state ?? null,
    stopReceipt: payload?.receipt ?? null,
    rejection: payload?.rejection ?? null,
  };
}

/** The report keeps timings and summaries; the raw response bodies live in `<phase>/raw/*.json`. */
function sanitizePhaseResult(result) {
  if (!result) return null;
  const sanitized = { ...result };
  if (sanitized.start && 'response' in sanitized.start) {
    sanitized.start = { ...sanitized.start, response: summarizeUiResponse(sanitized.start.response) };
  }
  if (sanitized.control) {
    sanitized.control = {
      ...sanitized.control,
      snapshot: summarizeControlSample(sanitized.control.snapshot),
      safeStop: summarizeControlSample(sanitized.control.safeStop),
    };
  }
  return sanitized;
}

/**
 * The only place a verdict is produced. No source-reading or hardcoded conclusion is accepted:
 * every branch depends on the baseline, the stall proof and the two measured samples.
 */
export function computeVerdict({
  baseline,
  stall,
  snapshot,
  safeStop,
  releaseAt = null,
  windowMs = OBSERVATION_WINDOW_MS,
}) {
  const snapshotScore = scoreControlSample(snapshot, { windowMs, releaseAt });
  const safeStopScore = scoreControlSample(safeStop, { windowMs, releaseAt });
  const reasons = [];
  if (!baseline?.valid) reasons.push('baseline_invalid');
  if (!stall?.proven) reasons.push('stall_unproven');
  if (snapshotScore.invalid.length > 0 || safeStopScore.invalid.length > 0) {
    reasons.push('control_sample_invalid');
  }
  const evaluated = reasons.length === 0;
  let verdict = 'inconclusive';
  if (evaluated) {
    const allBlocked = snapshotScore.blocked && safeStopScore.blocked;
    const allTimelyValid =
      snapshotScore.timely &&
      safeStopScore.timely &&
      snapshotScore.responseValid &&
      safeStopScore.responseValid;
    if (allBlocked) verdict = 'reproduced';
    else if (allTimelyValid) verdict = 'not_reproduced';
    else reasons.push('mixed_control_responses');
  }
  return {
    verdict,
    reasons,
    evaluated,
    scope: 'MY-116 stall_initialize scenario only; not a general Windows stop verdict',
    snapshot: snapshotScore,
    safeStop: safeStopScore,
  };
}

/** Fix acceptance is intentionally stricter than the historical reproduction
 * verdict. Every field below is captured before fixture cleanup/recovery. */
export function responsiveAcceptanceProblems(stall) {
  const problems = [];
  const pre = stall?.preControl;
  const target = stall?.start?.expectedAttemptId;
  if (!pre?.timely || pre.runtimeState !== 'starting' || pre.attemptId !== target ||
      !pre.startOutstanding || !pre.fixtureAlive || !pre.replyWithheld) problems.push('no_live_starting_snapshot_before_stop');
  const window = stall?.controlWindow;
  if (!window?.startOutstandingWhenIssued || !window.fixtureAliveAtIssue || !window.coreAliveAtIssue)
    problems.push('stall_not_live_before_controls');
  if (window?.startOutstandingAtWindowEnd !== false || window?.fixtureAliveAtWindowEnd !== false ||
      window?.coreAliveAtWindowEnd !== true) problems.push('invalid_fix_window_end');
  if (window?.releaseObserved !== false || window?.releaseWrittenAt != null ||
      window?.initializeReplyStillWithheld !== true) problems.push('initialize_released_before_cancel');
  if (window?.noPromptAtWindowEnd !== true) problems.push('prompt_written_in_stall_window');
  const stop = stall?.control?.safeStop;
  const score = scoreControlSample(stop);
  const receipt = stop?.response?.payload?.receipt;
  if (!score.timely || !score.responseValid || stop?.response?.ok !== true ||
      stop?.response?.requestId !== stall?.control?.requests?.safeStop?.requestId ||
      receipt?.attemptId !== target || receipt?.startupCancel !== 'confirmed' || receipt?.nativePromptSent !== false)
    problems.push('missing_matching_startup_cancellation_receipt');
  const snapshot = scoreControlSample(stall?.control?.snapshot);
  if (!snapshot.timely || !snapshot.responseValid) problems.push('snapshot_not_responsive');
  if (stall?.start?.response?.ok !== false || stall.start.response.requestId !== stall.start.requestId ||
      stall.start.error || stall.start.timedOut) problems.push('startup_did_not_return_cancelled');
  const terminal = stall?.terminal;
  if (!terminal?.ok || terminal.attemptId !== target || !terminal.noLongerStarting ||
      !terminal.cancelledEvent || !terminal.noPrompt) problems.push('missing_terminal_projection');
  const next = stall?.explicitRecovery;
  if (!next?.ok || !next.newAttempt || next.requestId === stall?.start?.requestId ||
      next.responseRequestId !== next.requestId || next.promptPid === stall?.fixture?.initializePid ||
      !next.matchingPrompt || !next.originalPeerNoPrompt || !next.releaseStillAbsent)
    problems.push('explicit_recovery_not_proven');
  return problems;
}

function readJsonIfPresent(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readFixtureInstances(workspace) {
  let entries = [];
  try {
    entries = fs.readdirSync(workspace);
  } catch {
    return [];
  }
  const instances = [];
  for (const name of entries) {
    if (!/^\.fake-codex-app-server\.\d+\.json$/.test(name)) continue;
    const markerFile = path.join(workspace, name);
    const data = readJsonIfPresent(markerFile);
    if (!data || typeof data !== 'object') continue;
    instances.push({ ...data, markerFile });
  }
  return instances;
}

export function validateFixtureInstances(instances, { workspace, codexExe, scenario }) {
  const problems = [];
  if (!Array.isArray(instances) || instances.length === 0) {
    problems.push('no .fake-codex-app-server.<pid>.json marker found in the probe workspace');
    return { valid: false, problems, instances: [] };
  }
  for (const instance of instances) {
    if (!Number.isInteger(instance.pid)) problems.push(`fixture marker ${instance.markerFile} has no integer pid`);
    if (!samePath(instance.cwd, workspace)) {
      problems.push(`fixture pid ${instance.pid} cwd ${instance.cwd} is not the probe workspace ${workspace}`);
    }
    if (!samePath(instance.execPath, codexExe)) {
      problems.push(`fixture pid ${instance.pid} execPath ${instance.execPath} is not the copied codex.exe ${codexExe}`);
    }
    if (instance.scenario !== scenario) {
      problems.push(`fixture pid ${instance.pid} scenario ${instance.scenario} is not ${scenario}`);
    }
    if (JSON.stringify(instance.argv) !== JSON.stringify(EXPECTED_FIXTURE_ARGV)) {
      problems.push(
        `fixture pid ${instance.pid} argv ${JSON.stringify(instance.argv)} is not ${JSON.stringify(EXPECTED_FIXTURE_ARGV)}`,
      );
    }
  }
  return { valid: problems.length === 0, problems, instances };
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function writeRaw(rawDir, name, value) {
  fs.mkdirSync(rawDir, { recursive: true });
  const file = path.join(rawDir, `${name}.json`);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

function stageLogs(proc, plan) {
  fs.writeFileSync(plan.stdoutLog, '');
  fs.writeFileSync(plan.stderrLog, '');
  proc.stdout.on('data', chunk => fs.appendFileSync(plan.stdoutLog, chunk));
  proc.stderr.on('data', chunk => fs.appendFileSync(plan.stderrLog, chunk));
}

function prepareFakePhase(plan, scenario) {
  for (const dir of [plan.dir, plan.workspace, plan.appData, plan.shim, plan.raw]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(FIXTURE_PATH)) throw new Error(`fixture module is missing: ${FIXTURE_PATH}`);
  const nodeExe = process.execPath;
  if (!fs.statSync(nodeExe).isFile()) throw new Error(`node executable is not a file: ${nodeExe}`);
  const codexExe = path.join(plan.shim, 'codex.exe');
  fs.copyFileSync(nodeExe, codexExe);
  const nodeSha = sha256File(nodeExe);
  const codexSha = sha256File(codexExe);
  if (nodeSha !== codexSha) throw new Error('copied codex.exe bytes differ from the node executable');

  const appDataProblems = isolatedAppDataProblems({ appData: plan.appData });
  if (appDataProblems.length > 0) throw new Error(appDataProblems.join('; '));

  fs.writeFileSync(path.join(plan.workspace, '.fake-codex-scenario'), `${scenario}\n`);
  const fixtureUrl = pathToFileURL(FIXTURE_PATH).href;
  fs.writeFileSync(path.join(plan.workspace, 'app-server'), `import("${fixtureUrl}");\n`);
  for (const marker of [
    INITIALIZED_MARKER,
    RELEASE_MARKER,
    STOP_MARKER,
    '.fake-codex-exited.marker',
    '.fake-codex-initialize-released.marker',
    '.fake-codex-app-server.json',
  ]) {
    fs.rmSync(path.join(plan.workspace, marker), { force: true });
  }
  return { nodeExe, nodeSha, codexExe, codexSha, fixturePath: FIXTURE_PATH, fixtureUrl, fixtureSha256: sha256File(FIXTURE_PATH) };
}

async function launchPhase({ plan, coreExe, scenario }) {
  const prep = prepareFakePhase(plan, scenario);
  const nonce = crypto.randomUUID();
  const env = buildCoreEnv({ baseEnv: process.env, shimDir: plan.shim, appData: plan.appData, nonce });
  const resolution = resolveCoreCodex({ appData: plan.appData, pathValue: env.PATH });
  const resolvedSha256 = resolution.resolvedPath ? sha256File(resolution.resolvedPath) : null;
  const checks = assertFakeCodexResolution({
    resolution,
    expectedPath: prep.codexExe,
    expectedSha256: prep.codexSha,
    resolvedSha256,
    shimDir: plan.shim,
  });
  const launchFacts = {
    scenario,
    workspace: plan.workspace,
    appData: plan.appData,
    shim: plan.shim,
    pipe: plan.pipe,
    db: plan.db,
    nodeExe: prep.nodeExe,
    nodeSha256: prep.nodeSha,
    codexExe: prep.codexExe,
    codexSha256: prep.codexSha,
    fixturePath: prep.fixturePath,
    fixtureSha256: prep.fixtureSha256,
    nonce,
    pathFirstEntry: env.PATH.split(';')[0],
    resolution: {
      source: resolution.source,
      resolvedPath: resolution.resolvedPath,
      resolvedSha256,
      candidates: resolution.candidates,
    },
    fakeResolutionOk: checks.ok,
    fakeResolutionProblems: checks.problems,
    env: {
      APPDATA: env.APPDATA,
      GOALPORT_LAUNCH_NONCE: env.GOALPORT_LAUNCH_NONCE,
      GOALPORT_REQUIRE_ISOLATED: env.GOALPORT_REQUIRE_ISOLATED,
      GOALPORT_CODEX_TRANSPORT: env.GOALPORT_CODEX_TRANSPORT ?? null,
      PATH: env.PATH,
    },
  };
  if (!checks.ok) throw new Error(`fake Codex launch refused: ${checks.problems.join('; ')}`);

  const proc = spawn(coreExe, ['serve', '--pipe', plan.pipe, '--db', plan.db], {
    cwd: plan.dir,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  stageLogs(proc, plan);
  const session = {
    plan,
    coreExe,
    proc,
    launchFacts,
    readyMs: null,
    exited: false,
    exitFacts: null,
    exitPromise: null,
  };
  session.exitPromise = new Promise(resolve => {
    proc.once('exit', (code, signal) => {
      session.exited = true;
      session.exitFacts = { code, signal };
      resolve({ code, signal });
    });
    proc.once('error', error => {
      session.exited = true;
      session.exitFacts = { error: error.message };
      resolve({ error: error.message });
    });
  });
  return session;
}

async function waitReady(session, { timeoutMs = 20000 } = {}) {
  const { plan } = session;
  const started = now();
  let attempt = 0;
  while (now() - started < timeoutMs) {
    attempt += 1;
    if (session.exited) {
      throw new Error(`Core exited before its pipe was ready: ${JSON.stringify(session.exitFacts)}`);
    }
    const probe = await issueControlSample(
      plan.pipe,
      { requestId: `my116-ready-${session.launchFacts.nonce}-${attempt}`, messageType: 'snapshot', payload: {} },
      { windowMs: 500 },
    );
    if (probe.response?.ok === true) {
      session.readyMs = roundMs(now() - started);
      return;
    }
    await sleep(100);
  }
  throw new Error(`Core named pipe did not answer snapshot within ${timeoutMs} ms`);
}

/**
 * Stop only processes this probe owns: the Core it spawned and fixture instances proven by their
 * own marker (pid + execPath = the copied codex.exe). Then verify every one is gone.
 */
async function cleanupSession(session) {
  const { plan } = session;
  const facts = {
    releaseMarkerWritten: false,
    stopMarkerWritten: false,
    fixtures: [],
    core: { pid: session.proc.pid },
    failures: [],
    verified: false,
  };
  try {
    if (!fs.existsSync(path.join(plan.workspace, RELEASE_MARKER))) {
      fs.writeFileSync(path.join(plan.workspace, RELEASE_MARKER), `${new Date().toISOString()}\n`);
    }
    facts.releaseMarkerWritten = true;
  } catch (error) {
    facts.failures.push(`could not write release marker: ${error.message}`);
  }
  try {
    fs.writeFileSync(path.join(plan.workspace, STOP_MARKER), `${new Date().toISOString()}\n`);
    facts.stopMarkerWritten = true;
  } catch (error) {
    facts.failures.push(`could not write stop marker: ${error.message}`);
  }

  // Give the fixture its own 100 ms poll a chance to exit before force-terminating anything.
  let instances = [];
  const waitStarted = now();
  while (now() - waitStarted < 8000) {
    instances = readFixtureInstances(plan.workspace);
    if (instances.length > 0 && instances.every(instance => !isProcessAlive(instance.pid))) break;
    if (instances.length === 0 && now() - waitStarted > 1000) break;
    await sleep(100);
  }
  instances = readFixtureInstances(plan.workspace);

  for (const instance of instances) {
    const owned = Number.isInteger(instance.pid) && samePath(instance.execPath, session.launchFacts.codexExe);
    const aliveBefore = isProcessAlive(instance.pid);
    const record = {
      pid: instance.pid,
      owned,
      execPath: instance.execPath,
      aliveBefore,
      forced: false,
      aliveAfter: aliveBefore,
      exitedMarker: fs.existsSync(path.join(plan.workspace, `.fake-codex-exited.${instance.pid}.marker`)),
    };
    if (aliveBefore && owned) {
      try {
        process.kill(instance.pid);
        record.forced = true;
      } catch (error) {
        facts.failures.push(`could not terminate owned fixture pid ${instance.pid}: ${error.message}`);
      }
      const deadline = now() + 3000;
      while (now() < deadline && isProcessAlive(instance.pid)) await sleep(50);
    } else if (aliveBefore && !owned) {
      facts.failures.push(`fixture pid ${instance.pid} is not verifiably owned; not terminated`);
    }
    record.aliveAfter = isProcessAlive(instance.pid);
    record.exitedMarker = record.exitedMarker || fs.existsSync(path.join(plan.workspace, `.fake-codex-exited.${instance.pid}.marker`));
    if (record.aliveAfter) facts.failures.push(`owned fixture pid ${instance.pid} survived cleanup`);
    facts.fixtures.push(record);
  }

  facts.core.terminatedByProbe = false;
  if (!session.exited) {
    try {
      facts.core.terminatedByProbe = session.proc.kill();
    } catch (error) {
      facts.failures.push(`could not terminate owned Core pid ${session.proc.pid}: ${error.message}`);
    }
  }
  const coreExit = await Promise.race([session.exitPromise, sleep(5000).then(() => ({ timeout: true }))]);
  if (coreExit.timeout) {
    try {
      session.proc.kill('SIGKILL');
    } catch {
      // already gone
    }
    const second = await Promise.race([session.exitPromise, sleep(3000).then(() => ({ timeout: true }))]);
    if (second.timeout) facts.failures.push(`owned Core pid ${session.proc.pid} did not exit`);
    facts.core.forcedAfterTimeout = true;
  }
  facts.core.exitFacts = session.exitFacts;
  facts.core.exitObserved = session.exitFacts != null;
  facts.core.aliveAfter = isProcessAlive(session.proc.pid);
  if (facts.core.aliveAfter) facts.failures.push(`owned Core pid ${session.proc.pid} is still alive`);

  // The stop marker is already present, so any fixture spawned during teardown still exits on its
  // own; give it that chance, then fail honestly if any owned pid is still alive.
  const finalDeadline = now() + 3000;
  let finalInstances = readFixtureInstances(plan.workspace);
  while (now() < finalDeadline && finalInstances.some(instance => isProcessAlive(instance.pid))) {
    await sleep(100);
    finalInstances = readFixtureInstances(plan.workspace);
  }
  facts.finalFixturePids = finalInstances.map(instance => instance.pid);
  facts.finalFixturePidsAlive = finalInstances.filter(instance => isProcessAlive(instance.pid)).map(instance => instance.pid);
  for (const pid of facts.finalFixturePidsAlive) {
    facts.failures.push(`fixture pid ${pid} is still alive at cleanup verification`);
  }
  facts.verified =
    facts.failures.length === 0 &&
    facts.core.exitObserved &&
    !facts.core.aliveAfter &&
    facts.finalFixturePidsAlive.length === 0;
  return facts;
}

async function runBaselinePhase({ plan, coreExe, token }) {
  const result = {
    phase: 'baseline',
    scenario: BASELINE_SCENARIO,
    reasons: [],
    valid: false,
  };
  let session = null;
  try {
    session = await launchPhase({ plan, coreExe, scenario: BASELINE_SCENARIO });
    result.launch = session.launchFacts;
    await waitReady(session);
    result.readyMs = session.readyMs;

    const requestId = `my116-baseline-${token}-start`;
    const expectedAttemptId = attemptIdForStartRequest(requestId);
    const request = {
      requestId,
      messageType: 'start_conversation',
      payload: {
        workspaceRoot: plan.workspace,
        provider: 'codex',
        message: `MY-116 baseline fake-peer turn ${token}`,
      },
    };
    const sample = await issueControlSample(plan.pipe, request, { windowMs: 30000 });
    writeRaw(plan.raw, 'baseline-start', { request, sample, expectedAttemptId });
    const snapshot = sample.response?.payload?.snapshot ?? null;
    const attempt = snapshot?.attempt ?? null;
    const fixture = validateFixtureInstances(readFixtureInstances(plan.workspace), {
      workspace: plan.workspace,
      codexExe: session.launchFacts.codexExe,
      scenario: BASELINE_SCENARIO,
    });
    const fixturePidsAlive = fixture.instances.filter(instance => isProcessAlive(instance.pid)).map(instance => instance.pid);
    const echoObserved = snapshot != null && JSON.stringify(snapshot).includes('echo:');
    result.start = {
      requestId,
      request,
      expectedAttemptId,
      responseOk: sample.response?.ok === true,
      error: sample.response?.error ?? sample.connectError ?? sample.writeError ?? null,
      respondedAfterMs: sample.respondedAt != null ? roundMs(sample.respondedAt - sample.issuedAt) : null,
      attemptId: attempt?.id ?? null,
      provider: attempt?.provider ?? null,
      state: attempt?.state ?? null,
      sessionHash: attempt?.sessionHash ?? null,
      eventCount: attempt?.eventCount ?? null,
      echoObserved,
    };
    result.fixture = {
      valid: fixture.valid,
      problems: fixture.problems,
      instanceCount: fixture.instances.length,
      instancePids: fixture.instances.map(instance => instance.pid),
      instancePidsAlive: fixturePidsAlive,
      instances: fixture.instances.map(instance => ({
        pid: instance.pid,
        cwd: instance.cwd,
        argv: instance.argv,
        scenario: instance.scenario,
        execPath: instance.execPath,
        markerFile: instance.markerFile,
      })),
      fixedMarker: readJsonIfPresent(path.join(plan.workspace, '.fake-codex-app-server.json')),
    };

    const promptDeadline = now() + OBSERVATION_WINDOW_MS;
    while (!fs.existsSync(path.join(plan.workspace, '.fake-codex-turn.marker')) && now() < promptDeadline) await sleep(20);
    const prompt = readJsonIfPresent(path.join(plan.workspace, '.fake-codex-turn.marker'));
    result.prompt = prompt;
    if (!prompt || !fixture.instances.some(instance => instance.pid === prompt.pid) ||
        !prompt.params?.input?.some(item => item.text === request.payload.message)) {
      result.reasons.push('baseline_no_proven_turn');
    }
    if (!result.start.responseOk) result.reasons.push('baseline_start_not_ok');
    if (result.start.attemptId !== expectedAttemptId) result.reasons.push('baseline_attempt_identity_mismatch');
    if (result.start.provider !== 'codex') result.reasons.push('baseline_attempt_provider_not_codex');
    if (!result.start.sessionHash) result.reasons.push('baseline_native_session_not_established');
    if (!fixture.valid) result.reasons.push('baseline_fixture_invalid');
    if (fixturePidsAlive.length === 0) result.reasons.push('baseline_fixture_not_alive');
    result.valid = result.reasons.length === 0;
  } catch (error) {
    result.error = error.message;
    result.reasons.push('baseline_phase_error');
  } finally {
    if (session) result.cleanup = await cleanupSession(session);
  }
  writeRaw(plan.raw, 'baseline-result', result);
  return result;
}

async function runStallPhase({ plan, coreExe, token, expectResponsive = false }) {
  const result = {
    phase: 'stall',
    scenario: STALL_SCENARIO,
    reasons: [],
    proven: false,
  };
  let session = null;
  let startClient = null;
  try {
    session = await launchPhase({ plan, coreExe, scenario: STALL_SCENARIO });
    result.launch = session.launchFacts;
    await waitReady(session);
    result.readyMs = session.readyMs;

    const requestId = `my116-stall-${token}-start`;
    const expectedAttemptId = attemptIdForStartRequest(requestId);
    const startRequest = {
      requestId,
      messageType: 'start_conversation',
      payload: {
        workspaceRoot: plan.workspace,
        provider: 'codex',
        message: `MY-116 stalled-initialize fake-peer turn ${token}`,
      },
    };
    result.start = { requestId, request: startRequest, expectedAttemptId, sentAt: null, settledAt: null };
    startClient = net.connect(plan.pipe);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('could not connect to the Core pipe for the start request')), 10000);
      startClient.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      startClient.once('error', error => {
        clearTimeout(timer);
        reject(new Error(`start connection failed: ${error.message}`));
      });
    });
    const frameState = { buffer: Buffer.alloc(0) };
    let startFrame = null;
    let startFailure = null;
    const frameWaiters = [];
    startClient.on('data', chunk => {
      frameState.buffer = Buffer.concat([frameState.buffer, chunk]);
      const frame = takeFrame(frameState);
      if (frame.done) {
        startFrame = frame;
        for (const waiter of frameWaiters.splice(0)) waiter(frame);
      }
    });
    startClient.on('error', error => {
      startFailure = `${error.code ?? 'error'}: ${error.message}`;
      for (const waiter of frameWaiters.splice(0)) waiter({ done: true, error: startFailure });
    });
    startClient.on('close', () => {
      if (startFrame == null && startFailure == null) {
        startFailure = 'start connection closed without a response';
        for (const waiter of frameWaiters.splice(0)) waiter({ done: true, error: startFailure });
      }
    });
    const nextStartFrame = timeoutMs =>
      new Promise(resolve => {
        if (startFrame != null) {
          resolve(startFrame);
          return;
        }
        if (startFailure != null) {
          resolve({ done: true, error: startFailure });
          return;
        }
        const timer = setTimeout(() => resolve({ done: false, timedOut: true }), timeoutMs);
        frameWaiters.push(frame => {
          clearTimeout(timer);
          resolve(frame);
        });
      });

    result.start.sentAt = roundMs(now());
    await new Promise((resolve, reject) => {
      startClient.write(encodeUiRequest(startRequest), error => (error ? reject(error) : resolve()));
    });
    result.start.writtenAt = roundMs(now());

    const initializedFile = path.join(plan.workspace, INITIALIZED_MARKER);
    const initializeDeadline = now() + 20000;
    const initializeStarted = now();
    let initialized = { found: false, waitedMs: null };
    while (now() < initializeDeadline) {
      if (fs.existsSync(initializedFile)) {
        const raw = fs.readFileSync(initializedFile, 'utf8');
        initialized = { found: true, waitedMs: roundMs(now() - initializeStarted), raw };
        try {
          initialized.data = JSON.parse(raw);
        } catch (error) {
          initialized.parseError = error.message;
        }
        break;
      }
      // Fail fast instead of waiting 20 s when the request already answered or failed.
      if (startFrame != null || startFailure != null || session.exited) break;
      await sleep(20);
    }
    result.initialize = {
      marker: initializedFile,
      found: initialized.found,
      waitedMs: initialized.waitedMs,
      data: initialized.data ?? null,
      parseError: initialized.parseError ?? null,
      startOutstandingWhenObserved: startFrame == null,
      releaseMarkerAbsentWhenObserved: !fs.existsSync(path.join(plan.workspace, RELEASE_MARKER)),
    };
    writeRaw(plan.raw, 'stall-initialize-marker', result.initialize);

    const initializePid = Number.isInteger(initialized.data?.pid) ? initialized.data.pid : null;
    const initializeInstance = initializePid
      ? readFixtureInstances(plan.workspace).find(instance => instance.pid === initializePid) ?? null
      : null;
    const fixtureProblems = [];
    if (!initialized.found) fixtureProblems.push(`no ${INITIALIZED_MARKER} appeared while the start request was outstanding`);
    if (initialized.parseError) fixtureProblems.push(`initialize marker is not JSON: ${initialized.parseError}`);
    if (initialized.data && initialized.data.kind !== 'initialize.received') {
      fixtureProblems.push(`initialize marker kind ${initialized.data.kind} is not initialize.received`);
    }
    if (initialized.data && initialized.data.scenario !== STALL_SCENARIO) {
      fixtureProblems.push(`initialize marker scenario ${initialized.data.scenario} is not ${STALL_SCENARIO}`);
    }
    if (initializePid == null) fixtureProblems.push('initialize marker has no integer pid');
    else if (!isProcessAlive(initializePid)) fixtureProblems.push(`initialize fixture pid ${initializePid} is not alive`);
    if (initializeInstance == null) {
      fixtureProblems.push(`no .fake-codex-app-server.<pid>.json marker for initialize pid ${initializePid}`);
    } else {
      const validated = validateFixtureInstances([initializeInstance], {
        workspace: plan.workspace,
        codexExe: session.launchFacts.codexExe,
        scenario: STALL_SCENARIO,
      });
      fixtureProblems.push(...validated.problems);
    }
    result.fixture = {
      problems: fixtureProblems,
      initializePid,
      instance: initializeInstance,
      instances: readFixtureInstances(plan.workspace),
    };
    if (!result.initialize.startOutstandingWhenObserved) {
      result.reasons.push('start_request_settled_before_initialize_receipt');
    }
    if (!result.initialize.releaseMarkerAbsentWhenObserved) {
      result.reasons.push('release_marker_present_before_control_window');
    }
    if (fixtureProblems.length > 0) result.reasons.push('stall_fixture_unproved');

    const outstandingBeforeControls = startFrame == null;
    result.controlWindow = {
      observationWindowMs: OBSERVATION_WINDOW_MS,
      boundIsProductSla: false,
      issuedAt: null,
      releaseWrittenAt: null,
      startOutstandingWhenIssued: outstandingBeforeControls,
      fixtureAliveAtIssue: initializePid != null && isProcessAlive(initializePid),
      coreAliveAtIssue: !session.exited,
    };
    if (!outstandingBeforeControls) result.reasons.push('start_answered_before_control_window');

    if (expectResponsive) {
      // A snapshot must answer while the peer is STILL alive and withheld,
      // before Stop is even issued; post-cancel responsiveness is not status proof.
      const pre = await issueControlSample(plan.pipe, {
        requestId: `my116-stall-${token}-pre-control`, messageType: 'snapshot', payload: {},
      }, { windowMs: OBSERVATION_WINDOW_MS });
      writeRaw(plan.raw, 'stall-pre-control-snapshot', pre);
      result.preControl = {
        timely: scoreControlSample(pre).timely,
        runtimeState: pre.response?.payload?.snapshot?.productConversation?.runtime?.state ?? null,
        attemptId: pre.response?.payload?.snapshot?.attempt?.id ?? null,
        startOutstanding: startFrame == null && startFailure == null,
        fixtureAlive: initializePid != null && isProcessAlive(initializePid),
        replyWithheld: !fs.existsSync(path.join(plan.workspace, '.fake-codex-initialize-released.marker')),
      };
    }
    const controlIssuedAt = now();
    result.controlWindow.issuedAt = roundMs(controlIssuedAt);
    const snapshotRequest = {
      requestId: `my116-stall-${token}-snapshot`,
      messageType: 'snapshot',
      payload: {},
    };
    const stopRequest = {
      requestId: `my116-stall-${token}-stop`,
      messageType: 'safe_stop',
      payload: { attemptId: expectedAttemptId },
    };
    result.control = { snapshot: null, safeStop: null, requests: { snapshot: snapshotRequest, safeStop: stopRequest } };
    const [snapshotSample, stopSample] = await Promise.all([
      issueControlSample(plan.pipe, snapshotRequest, { windowMs: OBSERVATION_WINDOW_MS }),
      issueControlSample(plan.pipe, stopRequest, { windowMs: OBSERVATION_WINDOW_MS }),
    ]);
    if (expectResponsive) await sleep(Math.max(0, OBSERVATION_WINDOW_MS - (now() - controlIssuedAt)));
    result.controlWindow.startOutstandingAtWindowEnd = startFrame == null;
    result.controlWindow.fixtureAliveAtWindowEnd = initializePid != null && isProcessAlive(initializePid);
    result.controlWindow.coreAliveAtWindowEnd = !session.exited;
    result.controlWindow.initializeReplyStillWithheld =
      !fs.existsSync(path.join(plan.workspace, '.fake-codex-initialize-released.marker'));
    if (expectResponsive) {
      // Keep end-of-window assertions: early settlement/exit is valid ONLY
      // with a matching confirmed pre-dispatch cancellation receipt.
      const receipt = stopSample.response?.payload?.receipt;
      const matched = stopSample.response?.ok === true &&
        stopSample.response?.requestId === stopRequest.requestId &&
        receipt?.attemptId === expectedAttemptId && receipt?.startupCancel === 'confirmed' &&
        receipt?.nativePromptSent === false;
      if (!matched) result.reasons.push('missing_matching_startup_cancellation_receipt');
      if (result.controlWindow.startOutstandingAtWindowEnd) result.reasons.push('start_still_outstanding_at_window_end');
      if (result.controlWindow.fixtureAliveAtWindowEnd) result.reasons.push('owned_fixture_alive_at_window_end');
      if (!result.controlWindow.coreAliveAtWindowEnd) result.reasons.push('core_exited_at_window_end');
    } else {
      if (!result.controlWindow.startOutstandingAtWindowEnd) {
        result.reasons.push('start_request_settled_inside_control_window');
      }
      if (!result.controlWindow.fixtureAliveAtWindowEnd) {
        result.reasons.push('fixture_not_alive_at_window_end');
      }
    }
    if (!result.controlWindow.initializeReplyStillWithheld) {
      result.reasons.push('initialize_reply_was_not_withheld');
    }
    if (!expectResponsive) {
      const releaseAt = now();
      result.controlWindow.releaseWrittenAt = roundMs(releaseAt);
      result.controlWindow.releaseWrittenAtMono = releaseAt;
      fs.writeFileSync(path.join(plan.workspace, RELEASE_MARKER), `${new Date().toISOString()}\n`);
      result.controlWindow.releaseObserved = true;
    } else {
      result.controlWindow.releaseObserved = fs.existsSync(path.join(plan.workspace, RELEASE_MARKER));
      result.controlWindow.noPromptAtWindowEnd = !fs.existsSync(path.join(plan.workspace, '.fake-codex-turn.marker'));
    }

    result.control.snapshot = snapshotSample;
    result.control.safeStop = stopSample;
    writeRaw(plan.raw, 'stall-snapshot', { request: snapshotRequest, sample: snapshotSample, expectedAttemptId });
    writeRaw(plan.raw, 'stall-safe-stop', { request: stopRequest, sample: stopSample, expectedAttemptId });

    const startOutcome = await nextStartFrame(30000);
    result.start.settledAt = roundMs(now());
    result.start.response = startOutcome.value ?? null;
    result.start.error = startOutcome.error ?? null;
    result.start.timedOut = startOutcome.timedOut === true;
    writeRaw(plan.raw, 'stall-start-response', {
      request: startRequest,
      response: result.start.response,
      error: result.start.error,
      timedOut: result.start.timedOut,
    });
    if (startClient) {
      startClient.removeAllListeners();
      startClient.destroy();
      startClient = null;
    }

    if (result.start.response != null) {
      const postSnapshotRequest = {
        requestId: `my116-stall-${token}-post`,
        messageType: 'snapshot',
        payload: {},
      };
      const post = await issueControlSample(plan.pipe, postSnapshotRequest, { windowMs: 15000 });
      writeRaw(plan.raw, 'stall-post-release-snapshot', { request: postSnapshotRequest, sample: post });
      const snapshot = post.response?.payload?.snapshot ?? null;
      result.recovery = {
        snapshotOk: post.response?.ok === true,
        attemptId: snapshot?.attempt?.id ?? null,
        attemptState: snapshot?.attempt?.state ?? null,
        echoObserved: snapshot != null && JSON.stringify(snapshot).includes('echo:'),
        respondedAfterMs: post.respondedAt != null ? roundMs(post.respondedAt - post.issuedAt) : null,
        timedOut: post.timedOut === true,
      };
    } else {
      result.recovery = { snapshotOk: false, skipped: 'start_conversation did not settle after release' };
    }
    if (!result.start.response) result.reasons.push('start_conversation_did_not_settle_after_release');
    if (expectResponsive) {
      const post = await issueControlSample(plan.pipe, {
        requestId: `my116-stall-${token}-terminal`, messageType: 'snapshot', payload: {},
      }, { windowMs: OBSERVATION_WINDOW_MS });
      writeRaw(plan.raw, 'stall-terminal-snapshot', post);
      const view = post.response?.payload?.snapshot;
      result.terminal = {
        ok: post.response?.ok === true,
        attemptId: view?.attempt?.id ?? null,
        noLongerStarting: view?.productConversation?.runtime?.state !== 'starting',
        cancelledEvent: view?.timeline?.some(event => event.eventKind === 'attempt.start.cancelled') === true,
        noPrompt: !fs.existsSync(path.join(plan.workspace, '.fake-codex-turn.marker')),
      };
      // Preserve the original peer's no-prompt evidence after explicit recovery
      // creates new processes and a separate, new-request-id prompt.
      fs.writeFileSync(path.join(plan.workspace, '.fake-codex-scenario'), BASELINE_SCENARIO);
      const recoveryId = `my116-stall-${token}-explicit-next`;
      const recoveryText = `Explicit recovery only ${token}`;
      const next = await issueControlSample(plan.pipe, {
        requestId: recoveryId, messageType: 'conversation_send',
        payload: { campaignId: `campaign-${sha256Bytes(Buffer.from(requestId, 'utf8'))}`, attemptId: expectedAttemptId, message: recoveryText },
      }, { windowMs: 30000 });
      writeRaw(plan.raw, 'stall-explicit-recovery', next);
      const prompt = readJsonIfPresent(path.join(plan.workspace, '.fake-codex-turn.marker'));
      result.explicitRecovery = {
        requestId: recoveryId, responseRequestId: next.response?.requestId ?? null,
        ok: next.response?.ok === true,
        newAttempt: next.response?.payload?.snapshot?.attempt?.id !== expectedAttemptId,
        promptPid: prompt?.pid ?? null,
        matchingPrompt: prompt?.params?.input?.some(item => item.text === recoveryText) === true,
        originalPeerNoPrompt: !fs.existsSync(path.join(plan.workspace, `.fake-codex-turn.${initializePid}.marker`)),
        releaseStillAbsent: !fs.existsSync(path.join(plan.workspace, RELEASE_MARKER)) &&
          !fs.existsSync(path.join(plan.workspace, '.fake-codex-initialize-released.marker')),
      };
      result.reasons.push(...responsiveAcceptanceProblems(result));
    }
    result.proven = result.reasons.length === 0;
  } catch (error) {
    result.error = error.message;
    result.reasons.push('stall_phase_error');
  } finally {
    if (startClient) {
      startClient.removeAllListeners();
      startClient.destroy();
    }
    if (session) result.cleanup = await cleanupSession(session);
  }
  writeRaw(plan.raw, 'stall-result', result);
  return result;
}

function assertFreshOutDir(outDir) {
  if (!fs.existsSync(outDir)) return;
  if (!fs.statSync(outDir).isDirectory()) throw new Error(`--out is not a directory: ${outDir}`);
  const entries = fs.readdirSync(outDir);
  if (entries.length > 0) {
    throw new Error(`--out must be fresh or empty; ${outDir} already contains ${entries.length} entries`);
  }
}

function probeRevision() {
  return sha256File(SCRIPT_PATH);
}

export async function runStalledPeerProbe({ coreExe, outDir, expectResponsive = false }) {
  const startedAt = new Date().toISOString();
  const outRoot = path.resolve(outDir);
  assertFreshOutDir(outRoot);
  const plan = planProbe(outRoot);
  fs.mkdirSync(outRoot, { recursive: true });
  const corePath = path.resolve(coreExe);
  const report = {
    probe: PROBE_NAME,
    mode: expectResponsive ? 'fix-acceptance' : 'negative-reproduction',
    schema: PROBE_SCHEMA,
    probeRevision: probeRevision(),
    startedAt,
    finishedAt: null,
    host: { platform: process.platform, arch: process.arch, node: process.version },
    core: { path: corePath, bytes: fs.statSync(corePath).size, sha256: sha256File(corePath) },
    fixture: { path: FIXTURE_PATH, sha256: sha256File(FIXTURE_PATH) },
    paths: {
      outDir: plan.root,
      report: plan.reportPath,
      baseline: {
        dir: plan.baseline.dir,
        db: plan.baseline.db,
        workspace: plan.baseline.workspace,
        appData: plan.baseline.appData,
        shim: plan.baseline.shim,
        raw: plan.baseline.raw,
        pipe: plan.baseline.pipe,
      },
      stall: {
        dir: plan.stall.dir,
        db: plan.stall.db,
        workspace: plan.stall.workspace,
        appData: plan.stall.appData,
        shim: plan.stall.shim,
        raw: plan.stall.raw,
        pipe: plan.stall.pipe,
      },
    },
    observationWindowMs: OBSERVATION_WINDOW_MS,
    observationBoundNote: '2 s is an observation threshold for this probe, not a product SLA',
    baseline: null,
    stall: null,
    verdict: 'inconclusive',
    verdictReasons: ['probe_incomplete'],
    stopEffectiveness: null,
    cleanup: { baseline: null, stall: null, verified: false },
    errors: [],
    exitCode: 1,
  };

  let baseline = { valid: false, reasons: ['baseline_not_run'] };
  let stall = { proven: false, reasons: ['stall_not_run'] };
  let snapshotSample = null;
  let stopSample = null;
  let releaseAt = null;
  try {
    baseline = await runBaselinePhase({ plan: plan.baseline, coreExe: corePath, token: plan.token });
    stall = await runStallPhase({ plan: plan.stall, coreExe: corePath, token: plan.token, expectResponsive });
    snapshotSample = stall?.control?.snapshot ?? null;
    stopSample = stall?.control?.safeStop ?? null;
    releaseAt = stall?.controlWindow?.releaseWrittenAtMono ?? null;
  } catch (error) {
    report.errors.push({ message: error.message, stack: error.stack ?? null });
  } finally {
    const verdict = computeVerdict({ baseline, stall, snapshot: snapshotSample, safeStop: stopSample, releaseAt });
    report.baseline = sanitizePhaseResult(baseline);
    report.stall = sanitizePhaseResult(stall);
    report.verdict = verdict.verdict;
    report.verdictReasons = [...new Set([...(baseline.reasons ?? []), ...(stall.reasons ?? []), ...verdict.reasons])];
    report.verdictDetail = verdict;
    const stopScore = verdict.safeStop;
    report.stopEffectiveness = classifyStopEffectiveness({ ...stopScore, sample: stopSample });
    report.cleanup = {
      baseline: baseline.cleanup ?? null,
      stall: stall.cleanup ?? null,
      verified: Boolean(baseline.cleanup?.verified && stall.cleanup?.verified),
    };
    const measurementValid =
      baseline.valid === true &&
      stall.proven === true &&
      verdict.evaluated === true &&
      verdict.snapshot.invalid.length === 0 &&
      verdict.safeStop.invalid.length === 0;
    report.measurementValid = measurementValid;
    report.fixAccepted = expectResponsive && measurementValid && report.cleanup.verified &&
      verdict.verdict === 'not_reproduced' && responsiveAcceptanceProblems(stall).length === 0;
    report.exitCode = expectResponsive ? (report.fixAccepted ? 0 : 1) :
      (measurementValid && report.cleanup.verified && verdict.verdict !== 'inconclusive' ? 0 : 1);
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(plan.reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  assertWindowsHost();
  const coreExe = path.resolve(args.core);
  const outDir = path.resolve(args.out);
  if (!fs.existsSync(coreExe) || !fs.statSync(coreExe).isFile()) {
    throw new Error(`--core must name an existing goalport-core.exe: ${coreExe}`);
  }
  const report = await runStalledPeerProbe({ coreExe, outDir, expectResponsive: args.expectResponsive === true });
  console.log(
    `[MY-116] verdict=${report.verdict} reasons=${report.verdictReasons.join(',') || 'none'} measurementValid=${report.measurementValid} cleanupVerified=${report.cleanup.verified}`,
  );
  console.log(`[MY-116] report: ${report.paths.report}`);
  return report.exitCode;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath !== '' && path.resolve(SCRIPT_PATH) === invokedPath) {
  main()
    .then(code => {
      process.exitCode = code;
    })
    .catch(error => {
      console.error(`[MY-116] ${error.message}`);
      process.exitCode = 1;
    });
}
