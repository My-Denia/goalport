// Profile lifecycle manager for startup continuity.
//
// Owns: marker v2 read/write (v1 read-compatible), channel discovery, the
// compatibility decision (data-format authority = schema_migrations, read
// through `goalport-core profile inspect` — NEVER a migrating open), backup
// rotation, staged import with crash-safe journal, and lastOpenedBy updates.
//
// It does NOT own: runtime identity (assertCoreIdentity / pipe-peer / epochs
// stay in launch-config.cjs and the Core binary), and it never kills a
// running Core.

const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { canonicalPath, normalizedPath } = require("./launch-config.cjs");

const MARKER_FILE = "goalport-profile.json";
const JOURNAL_FILE = "import-journal.json";
const BACKUP_DIR = "backups";
const STAGING_PREFIX = ".import-staging-";
const KEEP_BACKUPS = 3;
const JOURNAL_SCHEMA = "goalport.import-journal.v2";
const PROOF_SCHEMA = "goalport.import-proof.v1";
const PROOF_FILE = "import-proof.json";
const RECOVERY_DISPOSITION = "POSITIVELY_IDENTIFIED_RECOVERABLE";
const RECOVERY_METHOD = "DETACHED_WAL_COPY_PROBE_V1";
// Output contract of `goalport-core profile …` (profile_ops.rs). An inspection
// whose output does not carry this schema cannot be interpreted: treating it
// as facts would authorize writes on missing facts.
const PROFILE_OPS_SCHEMA = "goalport.profile-ops.v1";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function parseCoreResult(result, operation) {
  let value = null;
  try {
    const line = String(result?.stdout || "").split(/\r?\n/).find((candidate) => candidate.trim());
    value = line ? JSON.parse(line) : null;
  } catch { value = null; }
  if (result?.code !== 0 || !value || value.ok !== true || value.schema !== PROFILE_OPS_SCHEMA) {
    throw new Error(`${operation} failed: ${value?.error || result?.error || result?.code || "invalid Core output"}`);
  }
  return value;
}

// ---------- marker ----------

// v1 (rc.1-era) markers carry {schemaVersion:1, identityVersion, profileKey,
// product, version, coreSha256, mode}: version/coreSha256 are BUILDER
// provenance, not compatibility. v2 records that explicitly.
function parseMarkerText(raw) {
  let value;
  try { value = JSON.parse(raw); } catch { return { problem: "marker is not valid JSON" }; }
  if (!value || typeof value !== "object") return { problem: "marker is not an object" };
  const schema = value.markerSchemaVersion ?? value.schemaVersion;
  if (schema === 2) {
    return {
      markerSchemaVersion: 2,
      product: value.product,
      identityVersion: value.identityVersion,
      profileKey: value.profileKey,
      mode: value.mode,
      channel: value.channel ?? null,
      createdAt: value.createdAt ?? null,
      createdBy: value.createdBy ?? null,
      lastOpenedBy: value.lastOpenedBy ?? null,
      importedFrom: value.importedFrom ?? null,
      format: value.format ?? null
    };
  }
  if (schema === 1) {
    return {
      markerSchemaVersion: 1,
      product: value.product,
      identityVersion: value.identityVersion,
      profileKey: value.profileKey,
      mode: value.mode,
      channel: "release", // v1 markers only ever shipped in the release `rc` namespace
      createdAt: null,
      createdBy: value.version || value.coreSha256
        ? { version: value.version ?? null, coreSha256: value.coreSha256 ?? null, distribution: "release" }
        : null,
      lastOpenedBy: null,
      importedFrom: null,
      format: null
    };
  }
  return { problem: `unknown marker schema version ${JSON.stringify(schema)}` };
}

function buildMarkerV2({ profileKey, mode, channel, createdBy, lastOpenedBy, importedFrom, formatVersion, createdAt }) {
  return {
    markerSchemaVersion: 2,
    product: "GoalPort",
    identityVersion: 2,
    profileKey,
    mode,
    channel: channel ?? null,
    createdAt: createdAt ?? new Date().toISOString(),
    createdBy: createdBy ?? null,
    lastOpenedBy: lastOpenedBy ?? null,
    importedFrom: importedFrom ?? null,
    format: { authority: "schema_migrations", version: formatVersion ?? null }
  };
}

// ---------- pure decisions ----------

// `inspection` is the JSON of `goalport-core profile inspect` (read-only).
// `discovery` is {path, marker, inspection} of a foreign-channel profile or
// null. Returns a structured outcome; no error-string matching anywhere.
// Continuation outcomes (resume-import / reopen / adopt-v1) carry
// `formatVersion`: the database schema fact the decision actually PROVED
// (inspection.schemaVersion), so the caller's recordOpen commits it to the
// marker instead of recording null over data whose format was just verified.
function decideOwnProfile({ markerState, dirContentState, inspection, currentBuild, discovery, journal }) {
  // Fail closed FIRST: an inspection that itself failed (process error,
  // nonzero exit, malformed/unreadable output, ok:false) supplies no facts at
  // all. Nothing downstream — marker write, v1 adoption, backup write-open,
  // journal-finalizing import-resume, Core launch — may be derived from it.
  if (!inspection || inspection.failed || inspection.ok === false) {
    return { kind: "inspection-failed", reason: inspection?.error || "profile inspection failed" };
  }
  if (journal?.phase === "copying" && !dirContentState.databasePresent) {
    return { kind: "import-failed", reason: "Legacy copying journal has no bound staged proof; refusing fresh classification" };
  }
  const marker = markerState && !markerState.problem ? markerState : null;
  if (journal && (journal.phase === "finalized" || (journal.phase === "copying" && dirContentState.databasePresent))) {
    // finalized is written only AFTER the verified database rename. A missing
    // database is lost import data, not permission to create an empty profile.
    if (!inspection.exists && !dirContentState.databasePresent) return { kind: "missing-database" };
    // The journal fast path still requires provable facts about a database
    // that is present: `profile import` checkpoints its verified copy, so a
    // present database that is not openable read-only — or whose format is
    // unknown, legacy or newer — is not resumable data. Refusing here blocks
    // the marker write finalizeImport would perform.
    if (dirContentState.databasePresent || inspection.exists) {
      if (!inspection.exists) return { kind: "inspection-failed", reason: "journal database is not visible to inspection" };
      if (inspection.openable === false) return { kind: "needs-recovery", reason: inspection.error || "journal database cannot be opened read-only" };
      if (inspection.schemaVersion == null) return { kind: "unsupported-legacy", foreignTables: inspection.foreignTables };
      if (inspection.schemaVersion > inspection.currentSchemaVersion) return { kind: "newer-schema", version: inspection.schemaVersion };
      // The journal fast path must not bypass the integrity fact either:
      // resuming would finalize the marker over data that failed quick_check.
      if (inspection.quickCheck && inspection.quickCheck !== "ok") return { kind: "corrupt", reason: inspection.quickCheck };
    }
    return { kind: "resume-import", journal, formatVersion: inspection.schemaVersion ?? null };
  }
  if (!marker) {
    if (markerState && markerState.problem) return { kind: "corrupt-marker", reason: markerState.problem };
    if (!dirContentState.emptyish) return { kind: "not-a-profile" };
    if (discovery) {
      if (importableDiscovery(discovery, currentBuild)) return { kind: "import-offer", discovery };
      return { kind: "import-incompatible", discovery, reason: incompatibilityReason(discovery, currentBuild) };
    }
    return { kind: "fresh" };
  }
  // Marker present: identity first (product/mode/path), then data format.
  if (marker.product !== "GoalPort") return { kind: "not-a-profile" };
  if (marker.mode !== "normal" && marker.mode !== "synthetic-test") return { kind: "not-a-profile" };
  if (marker.mode !== (currentBuild.mode === "synthetic-test" ? "synthetic-test" : "normal")) {
    return { kind: "identity-mismatch", reason: `marker mode ${marker.mode} does not match launch mode` };
  }
  if (marker.identityVersion !== 2 || marker.profileKey !== currentBuild.profileKey) {
    return { kind: "identity-mismatch", reason: "marker path identity does not match this directory" };
  }
  if (!inspection.exists) {
    return marker.markerSchemaVersion === 2 && marker.format?.version == null && !marker.lastOpenedBy && !marker.importedFrom
      ? { kind: "reopen", needsBackup: false, note: "empty-database", formatVersion: inspection.schemaVersion ?? null }
      : { kind: "missing-database" };
  }
  // A database that exists but cannot be opened read-only (missing WAL
  // shared memory, unreadable file) has UNKNOWN compatibility — the format
  // authority (schema_migrations) could not be read. Refuse instead of
  // reopening, backing up with a write-open, or letting Core open it.
  if (inspection.openable === false) {
    return { kind: "needs-recovery", reason: inspection.error || "database cannot be opened read-only for a compatibility check" };
  }
  if (inspection.schemaVersion == null && inspection.openable) {
    return inspection.empty
      ? { kind: "reopen", needsBackup: false, note: "empty-database", formatVersion: inspection.schemaVersion ?? null }
      : { kind: "unsupported-legacy", foreignTables: inspection.foreignTables };
  }
  if (inspection.schemaVersion > inspection.currentSchemaVersion) {
    return { kind: "newer-schema", version: inspection.schemaVersion };
  }
  if (inspection.quickCheck && inspection.quickCheck !== "ok") {
    return { kind: "corrupt", reason: inspection.quickCheck };
  }
  const needsBackup = marker.lastOpenedBy?.coreSha256 !== currentBuild.coreSha256;
  const prior = inspection.latestEpoch?.priorCore;
  // A live prior Core of THIS build owns the same pipe identity: the normal
  // attach path (continue-background resume) applies, not coordination.
  // Coordination is for a live Core of a DIFFERENT build or unknown state.
  if (prior === "live-exact") {
    const epochSha = String(inspection.latestEpoch?.coreExecutableSha256 || "").toLowerCase();
    if (epochSha && epochSha === String(currentBuild.coreSha256).toLowerCase()) {
      return { kind: "reopen", needsBackup, note: "attach-to-living-core", formatVersion: inspection.schemaVersion };
    }
    return { kind: "live-core", epoch: inspection.latestEpoch };
  }
  if (prior === "unknown") return { kind: "unknown-core", epoch: inspection.latestEpoch };
  return {
    kind: marker.markerSchemaVersion === 1 ? "adopt-v1" : "reopen",
    needsBackup,
    note: inspection.needsRecovery ? "readonly-open-needs-recovery" : undefined,
    formatVersion: inspection.schemaVersion
  };
}

function importableDiscovery(discovery, currentBuild) {
  const { marker, inspection } = discovery;
  if (!marker || marker.product !== "GoalPort" || (marker.mode !== "normal")) return false;
  // Same fail-closed rule as the own-profile decision: an import offer copies
  // data into this channel and writes a marker, so it needs PROVEN facts — a
  // failed inspection, a database never proven openable read-only, an
  // unreadable format authority or a failed quick_check is not importable
  // merely because two version numbers compare.
  if (!inspection || inspection.failed || inspection.ok === false) return false;
  if (inspection.exists !== true || inspection.openable !== true) return false;
  if (!isNonnegativeSafeInteger(inspection.schemaVersion)) return false;
  if (!isNonnegativeSafeInteger(inspection.currentSchemaVersion)) return false;
  if (inspection.quickCheck !== "ok") return false;
  return inspection.schemaVersion <= inspection.currentSchemaVersion;
}

function incompatibilityReason(discovery) {
  const { marker, inspection } = discovery;
  if (!marker || marker.product !== "GoalPort") return "not a GoalPort profile";
  if (!inspection.exists) return "database file is missing";
  if (inspection.failed) return "the source database could not be examined";
  if (inspection.quickCheck && inspection.quickCheck !== "ok") return "source database failed an integrity check (quick_check)";
  if (inspection.schemaVersion == null && inspection.openable) return "unsupported legacy database format";
  if (inspection.schemaVersion > inspection.currentSchemaVersion) return `data format v${inspection.schemaVersion} is newer than this build (v${inspection.currentSchemaVersion})`;
  if (inspection.needsRecovery) return "database journal needs recovery before it can be read";
  return "database could not be inspected";
}

// Only names that Core can have published after full verification consume a
// retention slot. Partials and arbitrary .sqlite files are never candidates.
const FINAL_BACKUP_NAME = /^goalport-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(?:-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\.sqlite$/;
function backupsToPrune(names, keep = KEEP_BACKUPS) {
  const sorted = [...names].filter((name) => FINAL_BACKUP_NAME.test(name)).sort();
  return sorted.length <= keep ? [] : sorted.slice(0, sorted.length - keep);
}

function recoveryProbeCandidate(discovery) {
  const { marker, inspection } = discovery || {};
  return Boolean(
    marker && marker.product === "GoalPort" && marker.mode === "normal" &&
    inspection && inspection.ok === true && inspection.exists === true &&
    inspection.openable === false && inspection.access?.disposition === "RECOVERY_PROBE_REQUIRED" &&
    inspection.access?.reason === "WAL_PRESENT_SHM_MISSING" &&
    Number.isSafeInteger(inspection.walBytes) && inspection.walBytes > 0 && inspection.shmPresent === false
  );
}

// LEGACY-CONTAMINATED-ROOT COMPATIBILITY LAYER — not a mechanism of fresh
// profile correctness. Before the storage-boundary split, Electron's userData
// WAS the profile directory, so real user machines carry durable roots filled
// with the Chromium session files of that era. This frozen set recognizes
// exactly those HISTORICAL leftovers so a legacy-contaminated root without a
// marker/database still reads as a fresh-compatible directory instead of
// not-a-profile. It must NEVER grow a new Chromium file name: since the split,
// Chromium writes only to the separate browser-state namespace and cannot put
// anything into a durable profile root, so fresh correctness no longer depends
// on this list at all. When pre-split durable roots are no longer supported,
// this set (and its use in dirContentState) can be deleted without affecting
// new-profile correctness. Unknown user files, foreign databases, corrupt
// markers and newer schemas are still refused exactly as before.
const ELECTRON_SESSION_ARTIFACTS = new Set([
  "blob_storage", "Cache", "Code Cache", "DawnGraphiteCache", "DawnWebGPUCache", "Dictionaries",
  "GPUCache", "Local Storage", "Network", "Session Storage", "Shared Dictionary", "SharedDic",
  "Storage", "Trusted Types", "WebStorage", "Local State", "Preferences", "Secure Preferences",
  "lockfile", "window-state.json", "DevToolsActivePort", "DEBUG.log", "chrome_debug.log",
  "declarative_performance_observer.db", "declarative_performance_observer.db-journal"
]);
function isElectronArtifact(name) {
  if (ELECTRON_SESSION_ARTIFACTS.has(name)) return true;
  return /^DIPS(-wal|-shm)?$/.test(name) || /^declarative_performance_observer\.db(-wal|-shm)?$/.test(name);
}

function dirContentState(directory, fsApi = fs) {
  const database = path.join(directory, "goalport.sqlite");
  let entries = [];
  try { entries = fsApi.readdirSync(directory); } catch { return { emptyish: true, databasePresent: false, entries: [] }; }
  const meaningful = entries.filter((name) =>
    !name.startsWith(STAGING_PREFIX) && name !== JOURNAL_FILE && name !== BACKUP_DIR && name !== MARKER_FILE && !isElectronArtifact(name));
  return { emptyish: meaningful.length === 0, databasePresent: fsApi.existsSync(database), entries };
}

// ---------- orchestrating manager ----------

// A schema/data-format version as profile_ops emits it (JSON i64): a
// nonnegative safe integer. Anything else is not a version fact.
function isNonnegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

// Required facts of a SUCCESSFUL `profile inspect --quick-check` report of an
// EXISTING OPENABLE database (profile_ops.rs inspect): `schemaVersion` is
// null (no schema_migrations table) or the max applied migration,
// `currentSchemaVersion` is this build's SCHEMA_VERSION, a null schemaVersion
// comes with the `empty`/`foreignTables` distinction, and `quickCheck` is the
// PRAGMA result string (we always pass --quick-check). Returns the name of
// the first missing/malformed fact, or null when the report is interpretable.
// Without this check a half-fact report reads as compatible: e.g. missing
// currentSchemaVersion makes the newer-schema comparison `9 > undefined`
// → false → reopen of data whose format authority was never read.
function missingOpenableFact(value) {
  if (!(value.schemaVersion === null || isNonnegativeSafeInteger(value.schemaVersion))) return "schemaVersion";
  if (!isNonnegativeSafeInteger(value.currentSchemaVersion)) return "currentSchemaVersion";
  if (value.schemaVersion === null && typeof value.empty !== "boolean") return "empty";
  if (typeof value.quickCheck !== "string") return "quickCheck";
  return null;
}

// Dependencies are injected so the decision+bookkeeping logic runs headless
// in unit tests: `deps = { fsApi, execCore, now }` where
// execCore(argsArray) -> {code, stdout} (synchronous, like execFileSync of
// the packaged core).
class ProfileManager {
  constructor({ directory, appData, build, deps = {} }) {
    this.directory = directory;
    this.appData = appData;
    this.build = build; // {version, distribution, channel, coreSha256, mode, profileKey}
    this.fsApi = deps.fsApi || fs;
    this.execCore = deps.execCore;
    this.now = deps.now || (() => new Date());
    this.log = deps.log || (() => {});
  }

  markerPath() { return path.join(this.directory, MARKER_FILE); }
  databasePath() { return path.join(this.directory, "goalport.sqlite"); }
  journalPath() { return path.join(this.directory, JOURNAL_FILE); }
  backupsDir() { return path.join(this.directory, BACKUP_DIR); }

  readMarker(at = this.markerPath()) {
    let raw;
    try { raw = this.fsApi.readFileSync(at, "utf8"); } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    return parseMarkerText(raw);
  }

  async inspectDatabase(database = this.databasePath(), context) {
    if (!this.execCore) throw new Error("execCore dependency is required for inspection");
    let result;
    try {
      result = await this.execCore(["profile", "inspect", "--db", database, "--quick-check"], context);
    } catch (error) {
      // A thrown exec (missing binary, timeout) is still a FAILED inspection,
      // never a fact set: report it in the fail-closed envelope.
      result = { code: -1, stdout: "", error: String(error?.message || error) };
    }
    let value = null;
    try {
      const line = String(result.stdout || "").split(/\r?\n/).find((candidate) => candidate.trim());
      value = line ? JSON.parse(line) : null;
    } catch { value = null; }
    if (result.code !== 0 || !value || value.ok !== true) {
      return this.failedInspection(database, value?.error || `core profile inspect exited ${result.code}`);
    }
    // Fail closed on an inspection output we cannot interpret (unknown
    // profile-ops schema or missing fact fields): half-understood output must
    // not authorize fresh/reopen/adopt/import decisions.
    if (value.schema !== PROFILE_OPS_SCHEMA || typeof value.exists !== "boolean" ||
        (value.exists === true && typeof value.openable !== "boolean")) {
      return this.failedInspection(database, `core profile inspect reported an unreadable output contract (schema ${JSON.stringify(value.schema)})`);
    }
    // A successful report of an EXISTING OPENABLE database must additionally
    // carry the compatibility/integrity facts that shape always carries:
    // treating a missing currentSchemaVersion or quickCheck as "compatible"
    // would reopen (or resume an import over, or offer an import of) data
    // whose format authority or integrity was never actually read.
    if (value.exists === true && value.openable === true) {
      const missingFact = missingOpenableFact(value);
      if (missingFact) {
        return this.failedInspection(database, `core profile inspect omitted required compatibility/integrity facts for an openable database (${missingFact})`);
      }
    }
    return value;
  }

  // The fail-closed inspection envelope: `failed: true` distinguishes "the
  // inspection itself failed" from a SUCCESSFUL inspection honestly
  // reporting openable:false (WAL recovery) — decideOwnProfile refuses both,
  // but with the honest kind and reason.
  failedInspection(database, error) {
    return {
      ok: false, failed: true,
      exists: this.fsApi.existsSync(database), openable: false, needsRecovery: true,
      schemaVersion: null, error
    };
  }

  writeMarker(marker) {
    const target = this.markerPath();
    const temp = `${target}.tmp-${randomUUID().slice(0, 8)}`;
    this.fsApi.mkdirSync(this.directory, { recursive: true });
    this.fsApi.writeFileSync(temp, `${JSON.stringify(marker, null, 2)}\n`, { flag: "wx" });
    this.fsApi.renameSync(temp, target);
  }

  async discoverForeignProfiles() {
    const productRoot = path.join(this.appData, "GoalPort");
    let channels;
    try { channels = this.fsApi.readdirSync(productRoot); } catch { return null; }
    for (const name of channels) {
      if (!["rc", "release"].includes(name)) continue;
      const candidate = path.join(productRoot, name);
      if (!this.fsApi.statSync(candidate).isDirectory()) continue;
      if (path.resolve(candidate) === path.resolve(this.directory)) continue;
      const markerState = this.readMarker(path.join(candidate, MARKER_FILE));
      if (!markerState || markerState.problem || markerState.product !== "GoalPort") continue;
      if (markerState.mode !== "normal") continue;
      const inspection = await this.inspectDatabase(path.join(candidate, "goalport.sqlite"));
      return { path: candidate, marker: markerState, inspection };
    }
    return null;
  }

  readJournal() {
    let raw;
    try { raw = this.fsApi.readFileSync(this.journalPath(), "utf8"); } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    try { return JSON.parse(raw); } catch { return { phase: "corrupt", raw: String(raw).slice(0, 200) }; }
  }

  writeJournal(journal) {
    const target = this.journalPath();
    const temp = `${target}.tmp-${randomUUID().slice(0, 8)}`;
    this.fsApi.mkdirSync(this.directory, { recursive: true });
    let descriptor = null;
    try {
      this.fsApi.writeFileSync(temp, `${JSON.stringify(journal, null, 2)}\n`, { flag: "wx" });
      if (typeof this.fsApi.openSync === "function" && typeof this.fsApi.fsyncSync === "function") {
        descriptor = this.fsApi.openSync(temp, "r+");
        this.fsApi.fsyncSync(descriptor);
      }
      if (descriptor !== null && typeof this.fsApi.closeSync === "function") this.fsApi.closeSync(descriptor);
      descriptor = null;
      this.fsApi.renameSync(temp, target);
      // Best-effort directory durability. Windows may reject opening a
      // directory handle through Node; the atomic rename remains authoritative.
      if (typeof this.fsApi.openSync === "function" && typeof this.fsApi.fsyncSync === "function") {
        try {
          const directoryDescriptor = this.fsApi.openSync(this.directory, "r");
          try { this.fsApi.fsyncSync(directoryDescriptor); } finally { this.fsApi.closeSync(directoryDescriptor); }
        } catch { /* unsupported directory fsync */ }
      }
    } catch (error) {
      if (descriptor !== null && typeof this.fsApi.closeSync === "function") {
        try { this.fsApi.closeSync(descriptor); } catch { /* best effort */ }
      }
      try { this.fsApi.rmSync(temp, { force: true }); } catch { /* exact temp only */ }
      throw error;
    }
    return journal;
  }

  readStagingProof(journal) {
    this.assertOwnedStaging(journal);
    for (const leaf of [PROOF_FILE, "goalport.sqlite"]) {
      const candidate = path.join(journal.stagingDir, leaf);
      let stat;
      try { stat = this.fsApi.lstatSync(candidate); }
      catch (error) { throw new Error(`Import staging ${leaf} is unavailable: ${error.message}`); }
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Import staging ${leaf} must be a regular non-redirected file`);
    }
    let proof;
    try { proof = JSON.parse(this.fsApi.readFileSync(path.join(journal.stagingDir, PROOF_FILE), "utf8")); }
    catch (error) { throw new Error(`Import staging proof is unavailable or invalid: ${error.message}`); }
    if (!proof || proof.schema !== PROOF_SCHEMA || typeof proof.recoveryProofToken !== "string" ||
        proof.operationId !== journal.operationId ||
        (typeof journal.source?.bindingSha256 === "string" && proof.sourceBindingSha256 !== journal.source.bindingSha256)) {
      throw new Error("Import staging proof does not match this journal operation and source");
    }
    return proof;
  }

  async verifyStaging(journal) {
    const proof = this.readStagingProof(journal);
    const result = await this.execCore([
      "profile", "verify-staging", "--staging-dir", journal.stagingDir,
      "--expected-operation-id", journal.operationId,
      "--expected-proof-token", proof.recoveryProofToken,
      "--expected-source-binding-sha256", journal.source.bindingSha256
    ]);
    const verified = parseCoreResult(result, "profile verify-staging");
    if (verified.verified !== true || verified.recoveryProofToken !== proof.recoveryProofToken) {
      throw new Error("Core did not verify the staged import proof");
    }
    return verified;
  }

  promotedMatchesStaging(journal) {
    this.assertOwnedStaging(journal);
    const staged = path.join(journal.stagingDir, "goalport.sqlite");
    const destination = this.databasePath();
    for (const candidate of [staged, destination]) {
      const leaf = this.fsApi.lstatSync(candidate);
      if (leaf.isSymbolicLink() || !leaf.isFile()) return false;
    }
    const stagedStat = this.fsApi.statSync(staged, { bigint: true });
    const destinationStat = this.fsApi.statSync(destination, { bigint: true });
    return stagedStat.dev === destinationStat.dev && stagedStat.ino !== 0n && stagedStat.ino === destinationStat.ino;
  }

  hasMatchingConsent(journal) {
    const consent = journal?.consent;
    if (!consent || consent.operationId !== journal.operationId || consent.proofToken !== journal.proofToken) return false;
    return consent.kind === "ORDINARY_IMPORT" || consent.kind === "DETACHED_WAL_RECOVERY";
  }

  promoteStaged(journal) {
    this.assertOwnedStaging(journal);
    const staged = path.join(journal.stagingDir, "goalport.sqlite");
    const destination = this.databasePath();
    if (this.fsApi.existsSync(destination)) {
      if (!this.promotedMatchesStaging(journal)) {
        throw new Error("Refusing to overwrite or adopt an existing profile database that is not the proof-bound staged file");
      }
      journal.phase = "PROMOTED";
      this.writeJournal(journal);
      return journal;
    }
    // Same-filesystem hard-link publication is atomic and no-clobber. Keep the
    // staging link until marker finalization so crash recovery can re-verify it.
    this.fsApi.linkSync(staged, destination);
    journal.phase = "PROMOTED";
    this.writeJournal(journal);
    return journal;
  }

  assertOwnedStaging(journal) {
    const staging = journal?.stagingDir;
    const refused = () => { throw new Error("Import journal staging must be a direct, non-redirected .import-staging-* directory inside this profile"); };
    if (typeof staging !== "string" || !path.isAbsolute(staging)) refused();
    const leaf = path.basename(staging);
    if (!leaf.startsWith(STAGING_PREFIX) || leaf.length === STAGING_PREFIX.length) refused();
    const root = normalizedPath(this.directory).toLowerCase();
    if (normalizedPath(path.dirname(staging)).toLowerCase() !== root) refused();
    // Resolve both existing staging and its nearest existing parent. A junction
    // to another location (even another child) is never owned staging cleanup.
    const physical = canonicalPath(staging);
    if (normalizedPath(path.dirname(physical)).toLowerCase() !== root ||
        path.basename(physical).toLowerCase() !== leaf.toLowerCase()) refused();
    try {
      const stat = this.fsApi.lstatSync(staging);
      if (stat.isSymbolicLink() || !stat.isDirectory()) refused();
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    return staging;
  }

  // One consistency backup of OUR channel database (opened read-write when
  // needed: it is this channel's own data; WAL recovery is standard SQLite
  // behavior, and the copy is verified before anything irreversible).
  async backupOwnDatabase() {
    const database = this.databasePath();
    if (!this.fsApi.existsSync(database)) return null;
    this.fsApi.mkdirSync(this.backupsDir(), { recursive: true });
    const stamp = this.now().toISOString().replace(/[:.]/g, "-");
    const out = path.join(this.backupsDir(), `goalport-${stamp}-${randomUUID()}.sqlite`);
    const result = await this.execCore(["profile", "backup", "--db", database, "--out", out, "--allow-write-open"]);
    const report = parseCoreResult(result, "profile backup");
    if (report.published !== true) throw new Error("profile backup did not publish a verified final file");
    const names = this.fsApi.readdirSync(this.backupsDir());
    for (const stale of backupsToPrune(names)) {
      try { this.fsApi.rmSync(path.join(this.backupsDir(), stale), { force: true }); } catch { /* pruning is best-effort */ }
    }
    return out;
  }

  bindJournalFromProof(journal) {
    const proof = this.readStagingProof(journal);
    if (proof.sourceMarkerSha256 !== journal.source?.markerSha256 || proof.provenanceSha256 !== journal.provenanceSha256) {
      throw new Error("Import proof source marker or provenance does not match the journal");
    }
    journal.source.bindingSha256 = proof.sourceBindingSha256;
    journal.source.snapshotToken = proof.sourceSnapshotToken;
    journal.proofToken = proof.recoveryProofToken;
    journal.verifiedSchemaVersion = proof.stagedDatabase?.schemaVersion;
    return proof;
  }

  recoveryOffer(journal, discovery = null) {
    return {
      kind: "import-recovery-offer",
      discovery: discovery || {
        path: journal.source.directory,
        marker: journal.source.marker ?? null,
        inspection: { exists: true, openable: false, access: { disposition: "RECOVERY_PROBE_REQUIRED" } }
      },
      journal,
      recovery: {
        recoveryDisposition: RECOVERY_DISPOSITION,
        recoveryMethod: RECOVERY_METHOD,
        recoveryProofToken: journal.proofToken,
        operationId: journal.operationId,
        sourceMutationOnAccept: "NONE"
      }
    };
  }

  async resumeV2Journal(journal) {
    try { this.assertOwnedStaging(journal); }
    catch (error) { return { kind: "import-failed", reason: error.message }; }
    try {
      switch (journal.phase) {
        case "PROBING": {
          this.bindJournalFromProof(journal);
          await this.verifyStaging(journal);
          journal.phase = "AWAITING_RECOVERY_CONSENT";
          this.writeJournal(journal);
          return this.recoveryOffer(journal);
        }
        case "AWAITING_RECOVERY_CONSENT":
          this.bindJournalFromProof(journal);
          await this.verifyStaging(journal);
          return this.recoveryOffer(journal);
        case "COPYING":
          this.bindJournalFromProof(journal);
          await this.verifyStaging(journal);
          if (!journal.consent || journal.consent.kind !== "ORDINARY_IMPORT" || journal.consent.operationId !== journal.operationId) {
            return { kind: "import-failed", reason: "Ordinary import staging has no durable import consent" };
          }
          journal.consent.proofToken = journal.proofToken;
          journal.phase = "STAGED_VERIFIED";
          this.writeJournal(journal);
          this.promoteStaged(journal);
          return { kind: "resume-import", journal, formatVersion: journal.verifiedSchemaVersion ?? null };
        case "STAGED_VERIFIED":
          this.bindJournalFromProof(journal);
          await this.verifyStaging(journal);
          if (!this.hasMatchingConsent(journal)) {
            return { kind: "import-failed", reason: "Verified recovery staging has no matching durable consent" };
          }
          this.promoteStaged(journal);
          return { kind: "resume-import", journal, formatVersion: journal.verifiedSchemaVersion ?? null };
        case "PROMOTED":
          this.bindJournalFromProof(journal);
          await this.verifyStaging(journal);
          if (!this.hasMatchingConsent(journal)) {
            return { kind: "import-failed", reason: "Promoted import journal has no matching durable consent" };
          }
          if (!this.fsApi.existsSync(this.databasePath()) || !this.promotedMatchesStaging(journal)) {
            return { kind: "import-failed", reason: "Promoted profile database does not match the proof-bound staged file" };
          }
          return { kind: "resume-import", journal, formatVersion: journal.verifiedSchemaVersion ?? null };
        default:
          return { kind: "import-failed", reason: `Unknown import journal phase ${JSON.stringify(journal.phase)}` };
      }
    } catch (error) {
      return { kind: "import-failed", reason: error.message };
    }
  }

  async prepareRecoveryOffer(discovery) {
    if (!recoveryProbeCandidate(discovery)) {
      return { kind: "import-incompatible", discovery, reason: incompatibilityReason(discovery, this.build) };
    }
    const operationId = randomUUID();
    const stagingDir = path.join(this.directory, `${STAGING_PREFIX}${operationId}`);
    this.assertOwnedStaging({ stagingDir });
    this.fsApi.mkdirSync(stagingDir, { recursive: true });
    this.assertOwnedStaging({ stagingDir });
    const markerBytes = this.fsApi.readFileSync(path.join(discovery.path, MARKER_FILE));
    const provenance = { source: { path: discovery.path, createdBy: discovery.marker?.createdBy ?? null } };
    const provenanceText = JSON.stringify(provenance);
    const journal = {
      schema: JOURNAL_SCHEMA,
      operationId,
      mode: "DETACHED_WAL_RECOVERY",
      phase: "PROBING",
      source: {
        directory: discovery.path,
        marker: discovery.marker,
        markerSha256: sha256(markerBytes),
        bindingSha256: null,
        snapshotToken: null
      },
      stagingDir,
      proofToken: null,
      provenanceSha256: sha256(provenanceText),
      consent: null
    };
    this.writeJournal(journal);
    let result;
    try {
      result = await this.execCore([
        "profile", "recovery-probe", "--source-db", path.join(discovery.path, "goalport.sqlite"),
        "--staging-dir", stagingDir, "--operation-id", operationId,
        "--source-marker-sha256", journal.source.markerSha256,
        "--provenance-sha256", journal.provenanceSha256
      ]);
      const report = parseCoreResult(result, "profile recovery-probe");
      if (report.recoveryDisposition !== RECOVERY_DISPOSITION || report.recoveryMethod !== RECOVERY_METHOD || report.sourceMutation !== "NONE") {
        throw new Error("Core did not return a positively identified detached recovery proof");
      }
      journal.source.bindingSha256 = report.sourceBindingSha256;
      journal.source.snapshotToken = report.sourceSnapshotToken;
      journal.proofToken = report.recoveryProofToken;
      journal.verifiedSchemaVersion = report.stagedDatabase?.schemaVersion ?? null;
      journal.phase = "AWAITING_RECOVERY_CONSENT";
      this.writeJournal(journal);
      await this.verifyStaging(journal);
      return this.recoveryOffer(journal, discovery);
    } catch (error) {
      return { kind: "import-failed", reason: error.message, journal };
    }
  }

  async resolve() {
    const journal = this.readJournal();
    if (journal?.phase === "corrupt") return { kind: "import-failed", reason: "Import journal is corrupt and was preserved" };
    if (journal?.schema === JOURNAL_SCHEMA) return await this.resumeV2Journal(journal);
    if (journal && !["copying", "finalized"].includes(journal.phase)) {
      return { kind: "import-failed", reason: "Import journal has an unrecognized schema or phase and was preserved" };
    }
    const content = dirContentState(this.directory, this.fsApi);
    const markerState = this.readMarker();
    const inspection = await this.inspectDatabase();
    let discovery = null;
    // Discovery is a channel-namespace behavior: an explicit --data-dir is a
    // deliberate location choice and never scans other homes for data.
    if (this.build.channel && !markerState && content.emptyish && journal?.phase !== "finalized") {
      discovery = await this.discoverForeignProfiles();
    }
    if (!markerState && content.emptyish && discovery && recoveryProbeCandidate(discovery)) {
      return await this.prepareRecoveryOffer(discovery);
    }
    const outcome = decideOwnProfile({
      markerState,
      dirContentState: content,
      inspection,
      currentBuild: this.build,
      discovery,
      journal: journal && journal.phase !== "corrupt" ? journal : null
    });
    if (outcome.kind === "resume-import") {
      try { this.assertOwnedStaging(journal); }
      catch (error) { return { kind: "import-failed", reason: error.message }; }
    }
    if (journal?.phase === "copying" && !content.databasePresent) {
      return { kind: "import-failed", reason: "Legacy copying journal has no bound proof and cannot be promoted or treated as fresh" };
    }
    return outcome;
  }

  beginFresh() {
    const marker = buildMarkerV2({
      profileKey: this.build.profileKey,
      mode: this.build.mode,
      channel: this.build.channel,
      createdBy: { version: this.build.version, coreSha256: this.build.coreSha256, distribution: this.build.distribution },
      lastOpenedBy: null,
      formatVersion: null
    });
    this.writeMarker(marker);
    return marker;
  }

  adoptV1Marker(v1) {
    const marker = buildMarkerV2({
      profileKey: this.build.profileKey,
      mode: this.build.mode,
      channel: this.build.channel,
      createdAt: null,
      createdBy: v1.createdBy,
      lastOpenedBy: { version: this.build.version, coreSha256: this.build.coreSha256, distribution: this.build.distribution, at: this.now().toISOString() },
      formatVersion: null
    });
    this.writeMarker(marker);
    return marker;
  }

  async runImport(source, { allowSourceRecovery, provenance } = {}) {
    if (allowSourceRecovery) {
      throw new Error("Generic allowSourceRecovery is not recovery authority; use the detached recovery proof and acceptRecovery");
    }
    const operationId = randomUUID();
    const stagingDir = path.join(this.directory, `${STAGING_PREFIX}${operationId}`);
    this.assertOwnedStaging({ stagingDir });
    this.fsApi.mkdirSync(stagingDir, { recursive: true });
    this.assertOwnedStaging({ stagingDir });
    const markerBytes = this.fsApi.readFileSync(path.join(source.path, MARKER_FILE));
    const provenanceValue = provenance || { source: { path: source.path } };
    const provenanceText = JSON.stringify(provenanceValue);
    const journal = {
      schema: JOURNAL_SCHEMA,
      operationId,
      mode: "ORDINARY_COPY",
      phase: "COPYING",
      source: {
        directory: source.path,
        marker: source.marker,
        markerSha256: sha256(markerBytes),
        bindingSha256: null,
        snapshotToken: null
      },
      sourceCreatedBy: source.marker?.createdBy ?? null,
      stagingDir,
      proofToken: null,
      provenanceSha256: sha256(provenanceText),
      consent: { kind: "ORDINARY_IMPORT", acceptedAt: this.now().toISOString(), operationId }
    };
    this.writeJournal(journal);
    const args = ["profile", "import", "--source-db", path.join(source.path, "goalport.sqlite"),
      "--staging-dir", stagingDir, "--provenance", provenanceText,
      "--operation-id", operationId, "--source-marker-sha256", journal.source.markerSha256,
      "--provenance-sha256", journal.provenanceSha256];
    let result;
    try { result = await this.execCore(args); }
    catch (error) { throw new Error(`profile import execution became ambiguous; journal preserved: ${error.message}`); }
    // Core execution cannot redefine cleanup ownership. Re-check the physical
    // staging leaf immediately after the external call and before any rm/link.
    this.assertOwnedStaging(journal);
    if (result.code !== 0) {
      // A process can lose its result after Core durably writes a valid proof.
      // Preserve such staging for deterministic resume; only a definite
      // failure without a valid proof is discarded.
      try {
        this.bindJournalFromProof(journal);
        await this.verifyStaging(journal);
        throw new Error("profile import returned failure after writing a verified staging proof; journal preserved for resume");
      } catch (proofError) {
        if (/journal preserved for resume/.test(proofError.message)) throw proofError;
      }
      this.fsApi.rmSync(stagingDir, { recursive: true, force: true });
      this.fsApi.rmSync(this.journalPath(), { force: true });
      throw new Error(`profile import failed: ${result.stdout || result.code}`);
    }
    try { parseCoreResult(result, "profile import"); }
    catch (outputError) {
      try {
        this.bindJournalFromProof(journal);
        await this.verifyStaging(journal);
        throw new Error(`profile import response was invalid after verified staging; journal preserved for resume: ${outputError.message}`);
      } catch (proofError) {
        if (/journal preserved for resume/.test(proofError.message)) throw proofError;
        throw outputError;
      }
    }
    this.bindJournalFromProof(journal);
    await this.verifyStaging(journal);
    journal.phase = "STAGED_VERIFIED";
    journal.consent.proofToken = journal.proofToken;
    this.writeJournal(journal);
    this.promoteStaged(journal);
    return this.finalizeImport(journal);
  }

  async acceptRecovery(journal, { operationId, recoveryProofToken } = {}) {
    if (!journal || journal.schema !== JOURNAL_SCHEMA || journal.phase !== "AWAITING_RECOVERY_CONSENT") {
      throw new Error("Recovery consent is not attached to the current pending offer");
    }
    if (operationId !== journal.operationId || recoveryProofToken !== journal.proofToken) {
      throw new Error("Recovery consent does not match the current operation and proof token");
    }
    this.assertOwnedStaging(journal);
    const currentMarker = this.fsApi.readFileSync(path.join(journal.source.directory, MARKER_FILE));
    if (sha256(currentMarker) !== journal.source.markerSha256) {
      throw new Error("Recovery source marker changed after the offer was prepared");
    }
    const sourceVerification = await this.execCore([
      "profile", "verify-source", "--source-db", path.join(journal.source.directory, "goalport.sqlite"),
      "--expected-source-snapshot-token", journal.source.snapshotToken
    ]);
    parseCoreResult(sourceVerification, "profile verify-source");
    await this.verifyStaging(journal);
    journal.consent = {
      kind: "DETACHED_WAL_RECOVERY",
      acceptedAt: this.now().toISOString(),
      operationId,
      proofToken: recoveryProofToken
    };
    journal.phase = "STAGED_VERIFIED";
    this.writeJournal(journal);
    this.promoteStaged(journal);
    return this.finalizeImport(journal);
  }

  declineRecovery(journal) {
    if (!journal || journal.schema !== JOURNAL_SCHEMA || journal.phase !== "AWAITING_RECOVERY_CONSENT" || journal.consent) {
      throw new Error("Only the current unconsented recovery offer may be declined");
    }
    this.assertOwnedStaging(journal);
    this.fsApi.rmSync(journal.stagingDir, { recursive: true, force: true });
    this.fsApi.rmSync(this.journalPath(), { force: true });
  }

  finalizeImport(journal) {
    this.assertOwnedStaging(journal);
    if (journal.schema === JOURNAL_SCHEMA && journal.phase !== "PROMOTED") {
      throw new Error("Versioned import journal is not promoted and cannot be finalized");
    }
    const v2 = journal.schema === JOURNAL_SCHEMA;
    const sourceDirectory = v2 ? journal.source.directory : journal.source;
    const marker = buildMarkerV2({
      profileKey: this.build.profileKey,
      mode: this.build.mode,
      channel: this.build.channel,
      createdBy: { version: this.build.version, coreSha256: this.build.coreSha256, distribution: this.build.distribution },
      importedFrom: {
        path: sourceDirectory,
        createdBy: v2 ? journal.source?.marker?.createdBy ?? journal.sourceCreatedBy ?? null : journal.sourceCreatedBy,
        importedAt: this.now().toISOString(),
        verification: v2 ? {
          operationId: journal.operationId,
          proofToken: journal.proofToken,
          method: journal.mode === "DETACHED_WAL_RECOVERY" ? RECOVERY_METHOD : "SQLITE_ONLINE_BACKUP_V1",
          sourceMutation: "NONE"
        } : undefined
      },
      formatVersion: v2 ? journal.verifiedSchemaVersion ?? null : null
    });
    this.writeMarker(marker);
    this.fsApi.rmSync(this.journalPath(), { force: true });
    const stagingRoot = journal.stagingDir ? path.dirname(journal.stagingDir) : this.directory;
    if (journal.stagingDir && this.fsApi.existsSync(journal.stagingDir)) {
      this.fsApi.rmSync(journal.stagingDir, { recursive: true, force: true });
    }
    this.log(`import finalized from ${sourceDirectory} (staging root ${stagingRoot})`);
    return marker;
  }

  recordOpen(formatVersion) {
    const state = this.readMarker();
    if (!state || state.problem) return null;
    const source = state.markerSchemaVersion === 2 ? state : null;
    const marker = buildMarkerV2({
      profileKey: this.build.profileKey,
      mode: this.build.mode,
      channel: this.build.channel ?? source?.channel ?? null,
      createdAt: source?.createdAt,
      createdBy: source?.createdBy,
      lastOpenedBy: { version: this.build.version, coreSha256: this.build.coreSha256, distribution: this.build.distribution, at: this.now().toISOString() },
      importedFrom: source?.importedFrom ?? null,
      formatVersion: formatVersion ?? source?.format?.version ?? null
    });
    this.writeMarker(marker);
    return marker;
  }

  async recordOpenedDatabase() {
    // Classification happens before Core can migrate/create the DB. This is a
    // separate post-open fact, never a substitute for that original inspection.
    const facts = await this.inspectDatabase(this.databasePath(), { purpose: "post-core-open" });
    if (facts.failed || facts.ok !== true || facts.exists !== true || facts.openable !== true ||
        !Number.isSafeInteger(facts.schemaVersion) || facts.schemaVersion < 0 ||
        !Number.isSafeInteger(facts.currentSchemaVersion) || facts.currentSchemaVersion < facts.schemaVersion ||
        facts.quickCheck !== "ok") {
      throw new Error("The opened GoalPort database could not be verified; its profile record was not advanced");
    }
    const marker = this.recordOpen(facts.schemaVersion);
    if (!marker) throw new Error("The opened GoalPort profile record is missing or invalid");
    return marker;
  }
}

module.exports = {
  MARKER_FILE, JOURNAL_FILE, BACKUP_DIR, STAGING_PREFIX, KEEP_BACKUPS, JOURNAL_SCHEMA,
  RECOVERY_DISPOSITION, RECOVERY_METHOD,
  parseMarkerText, buildMarkerV2, decideOwnProfile, importableDiscovery, recoveryProbeCandidate, incompatibilityReason,
  backupsToPrune, dirContentState, ProfileManager,
  // Exported ONLY so tests can prove a dynamically generated Chromium-style
  // filename is NOT recognized by the frozen legacy set (anti-self-certification
  // for the storage-boundary tests); product code never imports these.
  ELECTRON_SESSION_ARTIFACTS, isElectronArtifact
};
