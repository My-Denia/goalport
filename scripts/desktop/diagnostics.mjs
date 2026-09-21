import { spawn } from "node:child_process";
import { closeSync, fstatSync, openSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import profileManagerModule from "../../electron/profile-manager.cjs";

export const TAIL_BYTES = 4096;
export const TAIL_LINES = 40;
export const SUMMARY_FIELD_BYTES = 4096;
export const SUMMARY_MAX_BYTES = 65536;
const SUMMARY_DROP_ORDER = ["stack", "diagnostics", "startup", "rescue", "cleanup", "observationAttempts", "steps"];

const { MARKER_FILE, JOURNAL_FILE, BACKUP_DIR, STAGING_PREFIX, dirContentState } = profileManagerModule;

export function sanitizeDiagnostic(text, privatePaths = []) {
  let result = String(text);
  const paths = privatePaths.filter(Boolean).flatMap((name) => {
    try { return [name, realpathSync.native(name)]; } catch { return [name]; }
  }).sort((a, b) => b.length - a.length);
  for (const name of paths) {
    for (const variant of [name, name.replaceAll("\\", "/"), JSON.stringify(name).slice(1, -1)]) {
      result = result.replace(new RegExp(variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "<private-path>");
    }
  }
  return result
    .replace(/[A-Z]:[\\/]+Users[\\/]+[^\\/\s"']+/gi, "<user-profile>")
    .replace(/\/(?:home|Users)\/[^/\s"']+/g, "<user-profile>")
    .replace(/\bBearer\s+[^\s"']+/gi, "Bearer <redacted>")
    .replace(/\b((?:api[_-]?key|token|password)\s*[=:]\s*)[^\s,;"']+/gi, "$1<redacted>")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,})\b/g, "<redacted>");
}

// Cut on a UTF-8 character boundary. The result fits the limit whenever the limit is at
// least the marker length; the summary writer checks its final rendered size separately.
export function truncateUtf8(text, limit) {
  const bytes = Buffer.from(String(text), "utf8");
  if (bytes.length <= limit) return String(text);
  const marker = `…[truncated ${bytes.length} bytes]`;
  let keep = Math.max(0, limit - Buffer.byteLength(marker));
  while (keep > 0 && (bytes[keep] & 0xc0) === 0x80) keep -= 1;
  return `${bytes.subarray(0, keep).toString("utf8")}${marker}`;
}

// Every string is redacted before it is cut, so truncation can never expose part of a
// private path; the rendered file is then held under a fixed byte budget.
export function boundedFailureSummary(summary, privatePaths = [], { fieldBytes = SUMMARY_FIELD_BYTES, maxBytes = SUMMARY_MAX_BYTES } = {}) {
  const limit = (value) => typeof value === "string" ? truncateUtf8(sanitizeDiagnostic(value, privatePaths), fieldBytes)
    : Array.isArray(value) ? value.map(limit)
      : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, limit(item)])) : value;
  const render = (value) => `${JSON.stringify(value, null, 2)}\n`;
  const fits = (value) => Buffer.byteLength(render(value)) <= maxBytes;
  let bounded = limit(summary);
  for (const field of SUMMARY_DROP_ORDER) {
    if (fits(bounded)) break;
    if (field in bounded) bounded = { ...bounded, [field]: `[omitted: summary exceeded ${maxBytes} bytes]`, truncated: true };
  }
  // JSON escaping can grow a string, so shrink the essential fields until the rendering fits.
  const essential = { schemaVersion: bounded.schemaVersion, status: bounded.status, mode: bounded.mode, stage: bounded.stage, error: bounded.error, truncated: true };
  for (let budget = fieldBytes; !fits(bounded); budget = Math.floor(budget / 2)) {
    bounded = Object.fromEntries(Object.entries(essential).map(([key, value]) => [key, typeof value === "string" ? truncateUtf8(value, budget) : value]));
    if (budget === 0) break;
  }
  const rendered = render(bounded);
  if (Buffer.byteLength(rendered) > maxBytes) throw new Error(`failure summary cannot fit ${maxBytes} bytes`);
  return rendered;
}

function tail(file, privatePaths, close) {
  let fd;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    const bytes = Buffer.alloc(Math.min(size, TAIL_BYTES));
    const read = readSync(fd, bytes, 0, bytes.length, Math.max(0, size - bytes.length));
    const text = bytes.subarray(0, read).toString("utf8").split(/\r?\n/).slice(-TAIL_LINES).join("\n");
    return { available: true, truncated: size > read, text: sanitizeDiagnostic(text, privatePaths).slice(-TAIL_BYTES) };
  } catch (error) {
    return { available: false, code: error.code || "UNAVAILABLE" };
  } finally {
    // A failed close must not replace the failure these diagnostics describe.
    if (fd !== undefined) { try { close(fd); } catch {} }
  }
}

export function collectFailureDiagnostics({ stage, child, files, privatePaths, close = closeSync }) {
  return {
    stage,
    process: { pid: child?.pid ?? null, exitCode: child?.exitCode ?? null, signalCode: child?.signalCode ?? null, killed: Boolean(child?.killed) },
    tails: Object.fromEntries(Object.entries(files).map(([name, file]) => [name, tail(file, privatePaths, close)]))
  };
}

// ---------- Startup-failure profile diagnostics ----------

export const BOOTSTRAP_QUERY_TIMEOUT_MS = 5000;
export const CORE_INSPECT_TIMEOUT_MS = 60000; // diagnostic re-probe stays below the original inspection timeout
export const CORE_INSPECT_STDOUT_BYTES = 16384;
export const CORE_INSPECT_STDERR_BYTES = 2048;
// After a timeout the kill request gets only TERMINATION_GRACE_MS to produce
// an exit/close/error event; if none arrives the probe settles anyway with an
// explicitly UNCONFIRMED termination fact instead of awaiting close forever.
// The total bounded wait is CORE_INSPECT_TIMEOUT_MS + TERMINATION_GRACE_MS
// (60s + 10s), below the original inspection's 120s timeout.
export const TERMINATION_GRACE_MS = 10000;
export const PROFILE_ROOT_MAX_ENTRIES = 512;

// MIRROR of the frozen compatibility-only Electron/Chromium exclusion set in
// electron/profile-manager.cjs @ f372c50 (ELECTRON_SESSION_ARTIFACTS plus its
// two regexes). The product does not export that set; this copy exists only
// to NAME which captured profile-root entries the product's frozen list and
// regexes do not accept. The authoritative empty-ish verdict recorded next to
// the names always comes from the product's own exported dirContentState(); a
// disagreement between the mirror and that verdict is recorded as a
// divergence instead of being trusted.
const FROZEN_ELECTRON_SESSION_ARTIFACTS = new Set([
  "blob_storage", "Cache", "Code Cache", "DawnGraphiteCache", "DawnWebGPUCache", "Dictionaries",
  "GPUCache", "Local Storage", "Network", "Session Storage", "Shared Dictionary", "SharedDic",
  "Storage", "Trusted Types", "WebStorage", "Local State", "Preferences", "Secure Preferences",
  "lockfile", "window-state.json", "DevToolsActivePort", "DEBUG.log", "chrome_debug.log",
  "declarative_performance_observer.db", "declarative_performance_observer.db-journal"
]);
function isFrozenElectronArtifact(name) {
  if (FROZEN_ELECTRON_SESSION_ARTIFACTS.has(name)) return true;
  return /^DIPS(-wal|-shm)?$/.test(name) || /^declarative_performance_observer\.db(-wal|-shm)?$/.test(name);
}

// Sanitizes every string inside a captured structure so no raw private path,
// credential or oversized payload can ride along inside a diagnostic record.
function sanitizeDeep(value, privatePaths) {
  if (typeof value === "string") return sanitizeDiagnostic(value, privatePaths);
  if (Array.isArray(value)) return value.map((item) => sanitizeDeep(item, privatePaths));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeDeep(item, privatePaths)]));
  return value;
}

// Byte-accurate bounded output accumulator: chunks are Buffers, the budget
// counts real UTF-8 bytes (not JS characters, which a single oversized chunk
// could otherwise overshoot), and an incomplete multi-byte sequence at the cut
// is withheld by the decoder instead of being fabricated into U+FFFD.
function createBoundedOutputAccumulator(maxBytes) {
  const decoder = new StringDecoder("utf8");
  let bytes = 0;
  let text = "";
  let truncated = false;
  return {
    push(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
      const room = maxBytes - bytes;
      if (room <= 0) { truncated = true; return; }
      const piece = buffer.length > room ? buffer.subarray(0, room) : buffer;
      if (piece.length < buffer.length) truncated = true;
      bytes += piece.length;
      text += decoder.write(piece); // a partial trailing sequence stays held back, never mangled
    },
    truncated: () => truncated,
    bytes: () => bytes,
    snapshot: () => text
  };
}

// Runs a process under a hard wall-clock bound. The timer (not signal
// reporting, which is unreliable on Windows) decides whether the probe timed
// out; stdout/stderr are capped in memory by real UTF-8 bytes. On timeout a
// single kill is attempted against THIS spawned child only (never a PID scan
// or any other process) and gets only a bounded termination grace: if no
// exit/close/error event arrives within that grace — including when kill
// throws or returns false — the probe settles deterministically with an
// explicitly UNCONFIRMED termination fact, and only this spawn's own handles
// (its piped stdio streams and the child handle) are detached so an abandoned
// child cannot keep the surrounding Node process alive. Close/error listeners
// stay attached after settling, so later child events are harmless no-ops
// rather than unhandled crashes.
export function runBoundedProcess({
  exe,
  args,
  timeoutMs,
  maxStdoutBytes = CORE_INSPECT_STDOUT_BYTES,
  maxStderrBytes = CORE_INSPECT_STDERR_BYTES,
  terminationGraceMs = TERMINATION_GRACE_MS,
  spawnImplementation = spawn
} = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let child;
    try {
      child = spawnImplementation(exe, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      return resolve({ elapsedMs: Date.now() - startedAt, timedOut: false, termination: null, exitCode: null, signal: null, stdout: "", stderr: "", spawnError: String(error?.message || error) });
    }
    const stdout = createBoundedOutputAccumulator(maxStdoutBytes);
    const stderr = createBoundedOutputAccumulator(maxStderrBytes);
    let settled = false;
    let timedOut = false;
    let exitObserved = false;
    let closeObserved = false;
    let killIssued = false;
    let killError = null;
    let graceTimer = null;
    const abandonChildHandles = () => {
      try { child.stdout?.destroy?.(); } catch {}
      try { child.stderr?.destroy?.(); } catch {}
      try { child.unref?.(); } catch {}
    };
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer !== null) clearTimeout(graceTimer);
      if (timedOut && !closeObserved) abandonChildHandles();
      const termination = timedOut
        ? {
            requested: true,
            issued: killIssued,
            killError,
            confirmed: exitObserved,
            note: exitObserved
              ? "child exit was observed after the termination request"
              : "termination unconfirmed: child exit was not observed; the child may still be running and is NOT claimed stopped"
          }
        : null;
      resolve({ elapsedMs: Date.now() - startedAt, timedOut, termination, stdout: stdout.snapshot(), stderr: stderr.snapshot(), ...value });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        killIssued = child.kill("SIGKILL") !== false;
      } catch (error) {
        killIssued = false;
        killError = String(error?.message || error);
      }
      // Bounded termination grace: kill threw, returned false, or simply has
      // not produced a close yet — either way, settle at this wall and never
      // wait past it.
      if (!settled) {
        graceTimer = setTimeout(() => {
          settle({ exitCode: child.exitCode ?? null, signal: child.signalCode ?? null });
        }, terminationGraceMs);
      }
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => stdout.push(chunk));
    child.stderr?.on("data", (chunk) => stderr.push(chunk));
    child.once("exit", () => { exitObserved = true; });
    child.once("error", (error) => settle({ exitCode: null, signal: null, spawnError: String(error?.message || error) }));
    child.once("close", (exitCode, signal) => {
      closeObserved = true;
      settle({ exitCode, signal: signal ?? null });
    });
  });
}

function defaultReadProfileRoot(directory) {
  return readdirSync(directory, { withFileTypes: true }).map((entry) => ({
    name: entry.name,
    kind: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "symlink" : "other"
  }));
}

function entryPresence(directory) {
  const stat = (name) => {
    try { const info = statSync(join(directory, name)); return { present: true, bytes: info.size }; }
    catch (error) { return { present: false, bytes: null, code: error.code || "UNAVAILABLE" }; }
  };
  return { marker: stat(MARKER_FILE), database: stat("goalport.sqlite"), journal: stat(JOURNAL_FILE), backupsDirectory: stat(BACKUP_DIR) };
}

// Bounded query of the renderer's bootstrap state through the existing
// goalport:bootstrap-current IPC. A hung query resolves as an UNAVAILABLE
// record after bootstrapTimeoutMs; it can never hang diagnostic collection.
async function boundedBootstrapQuery(queryBootstrap, timeoutMs) {
  if (!queryBootstrap) return { available: false, reason: "no renderer page was attached for this run" };
  let timer;
  const query = Promise.resolve().then(queryBootstrap);
  query.catch(() => {}); // a late rejection of an already-timed-out leg must stay handled
  try {
    const state = await Promise.race([
      query,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`bootstrap-current query timed out after ${timeoutMs}ms`)), timeoutMs); })
    ]);
    return { available: true, state: state ?? null };
  } catch (error) {
    return { available: false, error: String(error?.message || error) };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Original startup inspection trace extraction ----------

export const ORIGINAL_TRACE_MAX_RECORDS = 8;
export const ORIGINAL_TRACE_STRING_CAP = 240;

// Extracts the SELECTED original-startup-inspect fields from the optional
// `diagnostics` child a newer build attaches to its goalport:bootstrap-current
// result. The untouched f372c50 baseline package exposes no such child, so it
// stays explicitly UNAVAILABLE — for that build the only inspection facts are
// the separately-labelled coreInspectReProbe post-failure re-probes, which
// never substitute for an original trace. Every field is re-validated,
// re-sanitized and re-capped here; nothing from the child rides along
// unbounded or unredacted, and a malformed child degrades to honest
// null/"unknown" facts instead of throwing.
export function extractOriginalInspectTrace(bootstrapState, privatePaths = []) {
  const child = bootstrapState && typeof bootstrapState === "object" ? bootstrapState.diagnostics : undefined;
  const trace = child && typeof child === "object" ? child.originalProfileInspect : undefined;
  if (!trace || typeof trace !== "object") {
    return {
      available: false,
      source: "goalport:bootstrap-current diagnostics.originalProfileInspect",
      reason: "unavailable: this build exposes no original startup inspection trace (baseline package); every inspection fact in coreInspectReProbe is a post-failure diagnostic re-probe, never the original startup inspection"
    };
  }
  const boundedText = (value) => truncateUtf8(sanitizeDiagnostic(String(value ?? ""), privatePaths), ORIGINAL_TRACE_STRING_CAP);
  const boundedCount = (value) => (Number.isSafeInteger(value) && value >= 0 && value <= 2147483647 ? value : null);
  const boundedFactCount = (value) => (Number.isSafeInteger(value) ? value : null);
  const rawRecords = Array.isArray(trace.records) ? trace.records : [];
  const records = rawRecords.slice(0, ORIGINAL_TRACE_MAX_RECORDS).map((entry) => {
    const record = entry && typeof entry === "object" ? entry : {};
    const input = record.facts && typeof record.facts === "object" ? record.facts : null;
    const facts = input ? {
      ok: typeof input.ok === "boolean" ? input.ok : null,
      exists: typeof input.exists === "boolean" ? input.exists : null,
      openable: typeof input.openable === "boolean" ? input.openable : null,
      needsRecovery: typeof input.needsRecovery === "boolean" ? input.needsRecovery : null,
      empty: typeof input.empty === "boolean" ? input.empty : null,
      schemaVersion: boundedFactCount(input.schemaVersion),
      currentSchemaVersion: boundedFactCount(input.currentSchemaVersion),
      quickCheck: typeof input.quickCheck === "string" ? boundedText(input.quickCheck) : null,
      errorReason: typeof input.errorReason === "string" ? boundedText(input.errorReason) : null
    } : null;
    return {
      target: ["own-database", "other-database", "unknown"].includes(record.target) ? record.target : "unknown",
      status: record.status === "pending" || record.status === "completed" ? record.status : "unknown",
      startedAt: typeof record.startedAt === "string" ? boundedText(record.startedAt) : null,
      endedAt: typeof record.endedAt === "string" ? boundedText(record.endedAt) : null,
      elapsedMs: boundedCount(record.elapsedMs),
      exitCode: Number.isInteger(record.exitCode) ? record.exitCode : null,
      execError: typeof record.execError === "string" ? boundedText(record.execError) : null,
      malformed: typeof record.malformed === "boolean" ? record.malformed : null,
      parseNote: typeof record.parseNote === "string" ? boundedText(record.parseNote) : null,
      facts
    };
  });
  return {
    available: true,
    source: "goalport:bootstrap-current diagnostics.originalProfileInspect (in-memory trace this build recorded during startup)",
    kind: "original-startup-inspect-trace",
    totalInspections: boundedCount(trace.totalInspections),
    droppedRecords: boundedCount(trace.droppedRecords),
    truncated: rawRecords.length > ORIGINAL_TRACE_MAX_RECORDS,
    records
  };
}

// Read-only, bounded startup-failure diagnostics for a packaged smoke run.
// A NEWER build records the ORIGINAL startup inspection as a bounded trace in
// the optional diagnostics child of its bootstrap-current result; it is
// extracted above and reported separately. The untouched baseline package
// exposes no such child and stays explicitly unavailable. Independently of
// that, every inspection fact in coreInspectReProbe below is a NEW post-
// failure probe and is labeled as one; nothing here is or pretends to be the
// original startup inspection. Each leg records its own unavailability,
// timeout or parse failure, so a broken diagnostic can never mask the smoke
// failure that triggered collection.
export async function collectStartupDiagnostics({
  profileDirectory,
  packageRoot,
  privatePaths = [],
  coreExecutable,
  queryBootstrap,
  bootstrapTimeoutMs = BOOTSTRAP_QUERY_TIMEOUT_MS,
  inspectTimeoutMs = CORE_INSPECT_TIMEOUT_MS,
  runProcess = runBoundedProcess,
  readProfileRoot = defaultReadProfileRoot,
  productDirContentState = dirContentState,
  now = () => new Date()
} = {}) {
  if (!profileDirectory) throw new Error("profileDirectory is required for startup diagnostics");
  const bootstrap = await boundedBootstrapQuery(queryBootstrap, bootstrapTimeoutMs);

  let profileRoot;
  try {
    const all = readProfileRoot(profileDirectory);
    profileRoot = {
      available: true,
      entryCount: all.length,
      truncated: all.length > PROFILE_ROOT_MAX_ENTRIES,
      entries: all.slice(0, PROFILE_ROOT_MAX_ENTRIES).map((entry) => ({ ...entry, name: sanitizeDiagnostic(entry.name, privatePaths) }))
    };
  } catch (error) {
    profileRoot = { available: false, code: error?.code || "UNAVAILABLE", error: String(error?.message || error) };
  }
  const presence = entryPresence(profileDirectory);

  let frozenAllowlist = { available: false, reason: "profile root could not be read" };
  if (profileRoot.available) {
    let productEmptyish = null;
    let productError = null;
    try { productEmptyish = productDirContentState(profileDirectory).emptyish; }
    catch (error) { productError = String(error?.message || error); }
    const unmatched = profileRoot.entries
      .filter(({ name }) => !isFrozenElectronArtifact(name) && !name.startsWith(STAGING_PREFIX) && name !== JOURNAL_FILE && name !== BACKUP_DIR && name !== MARKER_FILE)
      .map(({ name }) => name);
    frozenAllowlist = {
      available: productError === null,
      ...(productError ? { error: productError } : { productEmptyish }),
      unmatchedNames: unmatched,
      note: "names the product's frozen compatibility-only Chromium exclusion list (electron/profile-manager.cjs @ f372c50 mirror) does not accept; the product's own dirContentState().emptyish is authoritative",
      consistent: productError === null ? unmatched.length === 0 === (productEmptyish === true) : null
    };
  }

  const database = join(profileDirectory, "goalport.sqlite");
  const executable = coreExecutable || (packageRoot ? join(packageRoot, "resources", "goalport-core.exe") : null);
  let executablePresent = false;
  if (executable) {
    try { executablePresent = statSync(executable).isFile(); } catch { executablePresent = false; }
  }
  let inspection;
  if (!executable || !executablePresent) {
    inspection = { attempted: false, executablePresent, note: "packaged Core executable unavailable; no probe ran" };
  } else {
    const result = await runProcess({ exe: executable, args: ["profile", "inspect", "--db", database, "--quick-check"], timeoutMs: inspectTimeoutMs });
    // Termination honesty: when a probe times out, the record states whether
    // the kill was issued and whether the child's exit was actually observed;
    // an unconfirmed termination never claims the child was stopped.
    const termination = result.termination
      ? {
          requested: Boolean(result.termination.requested),
          issued: Boolean(result.termination.issued),
          killError: result.termination.killError ? sanitizeDiagnostic(String(result.termination.killError), privatePaths) : null,
          confirmed: Boolean(result.termination.confirmed),
          note: sanitizeDiagnostic(String(result.termination.note ?? ""), privatePaths)
        }
      : (result.timedOut
        ? { requested: true, issued: null, killError: null, confirmed: null, note: "probe reported a timeout but no termination fact; the child is NOT claimed stopped" }
        : null);
    let parsed = null;
    let parseError = null;
    try {
      const line = String(result.stdout || "").split(/\r?\n/).find((candidate) => candidate.trim());
      if (line) parsed = JSON.parse(line);
      else parseError = "inspect produced no parsable output line";
    } catch (error) {
      parseError = String(error?.message || error);
    }
    inspection = {
      attempted: true,
      kind: "diagnostic-re-probe",
      note: "independent bounded read-only re-inspection issued after the failure; it is NOT the original startup inspection — see originalStartupInspection for the trace a newer build recorded at startup (the baseline build exposes none)",
      executablePresent,
      command: "profile inspect --db <profile>/goalport.sqlite --quick-check",
      elapsedMs: result.elapsedMs ?? null,
      timedOut: Boolean(result.timedOut),
      termination,
      exitCode: result.exitCode ?? null,
      signal: result.signal ?? null,
      spawnError: result.spawnError ? String(result.spawnError) : null,
      stdoutPreview: sanitizeDiagnostic(String(result.stdout || "").slice(0, 2048), privatePaths),
      stderrPreview: sanitizeDiagnostic(String(result.stderr || "").slice(0, 512), privatePaths),
      parsed: parsed === null ? null : sanitizeDeep(parsed, privatePaths),
      parseError
    };
  }

  return {
    schemaVersion: 1,
    kind: "startup-profile-diagnostics",
    collectedAt: now().toISOString(),
    originalStartupInspection: extractOriginalInspectTrace(bootstrap.state, privatePaths),
    bootstrap: { ...bootstrap, state: bootstrap.state === undefined ? bootstrap.state : sanitizeDeep(bootstrap.state, privatePaths) },
    profileRoot: { ...profileRoot, presence },
    frozenChromiumAllowlist: frozenAllowlist,
    coreInspectReProbe: inspection
  };
}
