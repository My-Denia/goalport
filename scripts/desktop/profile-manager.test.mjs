import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  parseMarkerText, buildMarkerV2, decideOwnProfile, importableDiscovery, incompatibilityReason,
  backupsToPrune, dirContentState, ProfileManager
} from "../../electron/profile-manager.cjs";
import { resolveProfilePaths } from "../../electron/launch-config.cjs";

const hash = "a".repeat(64);
const otherHash = "b".repeat(64);
const currentBuild = { version: "1.0.0-rc.1", distribution: "dev-candidate", channel: "dev-candidate", coreSha256: hash, mode: "normal", profileKey: "k".repeat(20) };
const inspect8 = (extra = {}) => ({
  schema: "goalport.profile-ops.v1", ok: true, exists: true, openable: true, needsRecovery: false, schemaVersion: 8, currentSchemaVersion: 8,
  quickCheck: "ok", counts: { campaigns: 2, tasks: 3 }, latestEpoch: { epochId: "e1", priorCore: "ended", state: "ENDED" }, ...extra
});
const markerV2 = (extra = {}) => buildMarkerV2({
  profileKey: currentBuild.profileKey, mode: "normal", channel: "dev-candidate",
  createdBy: { version: "1.0.0-rc.1", coreSha256: otherHash, distribution: "release" },
  lastOpenedBy: { version: "1.0.0-rc.1", coreSha256: otherHash, distribution: "release", at: "2026-09-19T00:00:00.000Z" },
  formatVersion: 8, ...extra
});
const markerV1 = () => JSON.stringify({
  schemaVersion: 1, identityVersion: 2, profileKey: currentBuild.profileKey, product: "GoalPort",
  version: "1.0.0-rc.1", coreSha256: otherHash, mode: "normal"
});

function fixture(t) {
  const root = mkdtempSync(resolve(tmpdir(), "goalport-profile-mgr-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("marker parsing: v1 is provenance, v2 is structured, junk is a problem", () => {
  const v1 = parseMarkerText(markerV1());
  assert.equal(v1.markerSchemaVersion, 1);
  assert.equal(v1.createdBy.coreSha256, otherHash);
  assert.equal(v1.channel, "release");
  const v2 = parseMarkerText(JSON.stringify(markerV2()));
  assert.equal(v2.markerSchemaVersion, 2);
  assert.equal(v2.format.authority, "schema_migrations");
  assert.equal(parseMarkerText("{").problem, "marker is not valid JSON");
  assert.equal(parseMarkerText('{"schemaVersion":9}').problem, "unknown marker schema version 9");
});

test("decision matrix: fresh, discovery, reopen, v1 adopt", () => {
  assert.equal(decideOwnProfile({
    markerState: null, dirContentState: { emptyish: true, databasePresent: false }, inspection: { exists: false },
    currentBuild, discovery: null, journal: null
  }).kind, "fresh");

  const discovery = { path: "C:/d/rc", marker: parseMarkerText(markerV1()), inspection: inspect8() };
  assert.equal(decideOwnProfile({
    markerState: null, dirContentState: { emptyish: true, databasePresent: false }, inspection: { exists: false },
    currentBuild, discovery, journal: null
  }).kind, "import-offer");

  const reopenSame = decideOwnProfile({
    markerState: parseMarkerText(JSON.stringify(markerV2({ lastOpenedBy: { version: "1.0.0-rc.1", coreSha256: hash, distribution: "dev-candidate", at: "x" } }))),
    dirContentState: { emptyish: false, databasePresent: true }, inspection: inspect8(), currentBuild, discovery: null, journal: null
  });
  assert.equal(reopenSame.kind, "reopen");
  assert.equal(reopenSame.needsBackup, false);

  const reopenOtherBuild = decideOwnProfile({
    markerState: parseMarkerText(JSON.stringify(markerV2())), dirContentState: { emptyish: false, databasePresent: true },
    inspection: inspect8(), currentBuild, discovery: null, journal: null
  });
  assert.equal(reopenOtherBuild.kind, "reopen");
  assert.equal(reopenOtherBuild.needsBackup, true, "first open by a new build backs up first");

  assert.equal(decideOwnProfile({
    markerState: parseMarkerText(markerV1()), dirContentState: { emptyish: false, databasePresent: true },
    inspection: inspect8(), currentBuild, discovery: null, journal: null
  }).kind, "adopt-v1");
});

test("a live prior Core of THIS build attaches instead of coordinating", () => {
  const base = { dirContentState: { emptyish: false, databasePresent: true }, currentBuild, discovery: null, journal: null };
  const epoch = { epochId: "e1", priorCore: "live-exact", coreExecutableSha256: hash };
  assert.equal(decideOwnProfile({ ...base, markerState: parseMarkerText(JSON.stringify(markerV2())), inspection: inspect8({ latestEpoch: epoch }) }).kind, "reopen");
  const foreignEpoch = { epochId: "e1", priorCore: "live-exact", coreExecutableSha256: otherHash };
  assert.equal(decideOwnProfile({ ...base, markerState: parseMarkerText(JSON.stringify(markerV2())), inspection: inspect8({ latestEpoch: foreignEpoch }) }).kind, "live-core");
});

test("explicit --data-dir profiles never discover foreign data", async (t) => {
  const root = fixture(t);
  const rc = resolve(root, "GoalPort", "rc");
  mkdirSync(rc, { recursive: true });
  writeFileSync(resolve(rc, "goalport-profile.json"), markerV1());
  writeFileSync(resolve(rc, "goalport.sqlite"), "db");
  const explicit = resolve(root, "explicit");
  mkdirSync(explicit, { recursive: true });
  const manager = new ProfileManager({
    directory: explicit, appData: root, build: { ...currentBuild, channel: null },
    deps: { execCore: async () => ({ code: 0, stdout: `${JSON.stringify(inspect8({ exists: false }))}
` }) }
  });
  const outcome = await manager.resolve();
  assert.equal(outcome.kind, "fresh", "explicit dir with a foreign rc present must not offer import");
});

test("decision matrix: coordination and honest refusals", () => {
  const base = { dirContentState: { emptyish: false, databasePresent: true }, currentBuild, discovery: null, journal: null };
  assert.equal(decideOwnProfile({ ...base, markerState: parseMarkerText(JSON.stringify(markerV2())), inspection: inspect8({ latestEpoch: { epochId: "e1", priorCore: "live-exact" } }) }).kind, "live-core");
  assert.equal(decideOwnProfile({ ...base, markerState: parseMarkerText(JSON.stringify(markerV2())), inspection: inspect8({ latestEpoch: { epochId: "e1", priorCore: "unknown" } }) }).kind, "unknown-core");
  assert.equal(decideOwnProfile({ ...base, markerState: parseMarkerText(JSON.stringify(markerV2())), inspection: inspect8({ schemaVersion: 9 }) }).kind, "newer-schema");
  assert.equal(decideOwnProfile({ ...base, markerState: parseMarkerText(JSON.stringify(markerV2())), inspection: inspect8({ schemaVersion: null, openable: true, foreignTables: 5 }) }).kind, "unsupported-legacy");
  assert.equal(decideOwnProfile({ ...base, markerState: parseMarkerText(JSON.stringify(markerV2())), inspection: inspect8({ quickCheck: "row 3 missing" }) }).kind, "corrupt");
  assert.equal(decideOwnProfile({ ...base, markerState: parseMarkerText(JSON.stringify(markerV2())), inspection: { exists: false } }).kind, "missing-database");
  assert.equal(decideOwnProfile({ ...base, markerState: { problem: "marker is not valid JSON" }, inspection: { exists: true } }).kind, "corrupt-marker");
  assert.equal(decideOwnProfile({ ...base, markerState: null, inspection: { exists: true } }).kind, "not-a-profile");
  const moved = parseMarkerText(JSON.stringify(markerV2()));
  moved.profileKey = "0".repeat(20);
  assert.equal(decideOwnProfile({ ...base, markerState: moved, inspection: inspect8() }).kind, "identity-mismatch");
});

test("decision matrix: import incompatibility reasons and journal resume", () => {
  const foreign = (inspection) => ({ path: "C:/d/rc", marker: parseMarkerText(markerV1()), inspection });
  assert.equal(importableDiscovery(foreign(inspect8()), currentBuild), true);
  assert.equal(importableDiscovery(foreign(inspect8({ schemaVersion: 9 })), currentBuild), false);
  assert.match(incompatibilityReason(foreign(inspect8({ schemaVersion: 9 }))), /newer than this build/);
  assert.match(incompatibilityReason(foreign(inspect8({ schemaVersion: null, openable: true, foreignTables: 2 }))), /unsupported legacy/);
  const outcome = decideOwnProfile({
    markerState: null, dirContentState: { emptyish: true, databasePresent: false }, inspection: { exists: false },
    currentBuild, discovery: foreign(inspect8({ schemaVersion: 9 })), journal: null
  });
  assert.equal(outcome.kind, "import-incompatible");
  assert.match(outcome.reason, /newer/);
  // Journal resume: copying + database already in place, or finalized.
  // The real manager always supplies the full inspection facts; the journal
  // fast path must only resume on PROVEN compatible data (see the
  // fail-closed tests below).
  assert.equal(decideOwnProfile({
    markerState: null, dirContentState: { emptyish: false, databasePresent: true }, inspection: inspect8(),
    currentBuild, discovery: null, journal: { phase: "copying", source: "s", stagingDir: "d" }
  }).kind, "resume-import");
  assert.equal(decideOwnProfile({
    markerState: null, dirContentState: { emptyish: false, databasePresent: false }, inspection: { exists: false },
    currentBuild, discovery: null, journal: { phase: "finalized", source: "s", stagingDir: "d" }
  }).kind, "resume-import");
  // Journal copying WITHOUT the database in place is not a resume (re-offer)
  assert.equal(decideOwnProfile({
    markerState: null, dirContentState: { emptyish: true, databasePresent: false }, inspection: { exists: false },
    currentBuild, discovery: null, journal: { phase: "copying", source: "s", stagingDir: "d" }
  }).kind, "fresh");
});

test("backup rotation never prunes the newest and staging content is not profile content", (t) => {
  assert.deepEqual(backupsToPrune(["a", "b", "c"]), []);
  assert.deepEqual(backupsToPrune(["a", "b", "c", "d", "e"]), ["a", "b"]);
  const root = fixture(t);
  mkdirSync(root, { recursive: true });
  writeFileSync(resolve(root, "goalport.sqlite"), "db");
  mkdirSync(resolve(root, ".import-staging-1"));
  mkdirSync(resolve(root, "backups"));
  writeFileSync(resolve(root, "import-journal.json"), "{}");
  const state = dirContentState(root);
  assert.equal(state.emptyish, false, "staging/journal/backups alone do not make a dir non-empty");
  assert.equal(state.databasePresent, true);
});

test("electron session artifacts do not turn a fresh profile into not-a-profile", (t) => {
  const root = fixture(t);
  for (const name of ["Cache", "Code Cache", "GPUCache", "Local State", "Preferences", "DIPS", "DIPS-wal", "blob_storage", "declarative_performance_observer.db", "lockfile", "window-state.json"]) {
    const target = resolve(root, name);
    if (name.includes("/")) mkdirSync(target, { recursive: true });
    else writeFileSync(target, "x");
  }
  const state = dirContentState(root);
  assert.equal(state.emptyish, true, "electron-owned files are not profile content");
  writeFileSync(resolve(root, "userfile.txt"), "x");
  assert.equal(dirContentState(root).emptyish, false, "unknown user content keeps the honest not-a-profile refusal");
});

test("ProfileManager: fresh, adopt, recordOpen against the real filesystem", async (t) => {
  const root = fixture(t);
  const dir = resolve(root, "dev");
  const calls = [];
  const manager = new ProfileManager({
    directory: dir, appData: root, build: currentBuild,
    deps: { execCore: async (args) => { calls.push(args); return { code: 0, stdout: `${JSON.stringify(inspect8())}\n` }; } }
  });
  assert.equal((await manager.resolve()).kind, "fresh");
  const marker = manager.beginFresh();
  assert.equal(marker.markerSchemaVersion, 2);
  assert.equal(marker.channel, "dev-candidate");
  assert.equal(parseMarkerText(readFileSync(resolve(dir, "goalport-profile.json"), "utf8")).markerSchemaVersion, 2);
  const outcome = await manager.resolve();
  assert.equal(outcome.kind, "reopen");
  manager.recordOpen(8);
  const reopened = parseMarkerText(readFileSync(resolve(dir, "goalport-profile.json"), "utf8"));
  assert.equal(reopened.lastOpenedBy.coreSha256, hash);
  assert.equal(reopened.format.version, 8);
  // v1 in-place adoption
  const explicit = resolve(root, "explicit");
  mkdirSync(explicit, { recursive: true });
  writeFileSync(resolve(explicit, "goalport-profile.json"), markerV1());
  const adopter = new ProfileManager({
    directory: explicit, appData: root, build: { ...currentBuild, channel: null },
    deps: { execCore: async () => ({ code: 0, stdout: `${JSON.stringify(inspect8())}\n` }) }
  });
  assert.equal((await adopter.resolve()).kind, "adopt-v1");
  const backedUp = adopter.backupOwnDatabase; // backup happens in main before adopt; marker upgrade itself:
  const upgraded = adopter.readMarker();
  assert.equal(upgraded.markerSchemaVersion, 1);
  adopter.adoptV1Marker(upgraded);
  const after = parseMarkerText(readFileSync(resolve(explicit, "goalport-profile.json"), "utf8"));
  assert.equal(after.markerSchemaVersion, 2);
  assert.equal(after.createdBy.coreSha256, otherHash, "v1 provenance is preserved, not rewritten");
});

test("ProfileManager: runImport stages, journals, and writes the marker last", async (t) => {
  const root = fixture(t);
  const source = resolve(root, "rc");
  mkdirSync(source, { recursive: true });
  writeFileSync(resolve(source, "goalport-profile.json"), markerV1());
  writeFileSync(resolve(source, "goalport.sqlite"), "source database bytes");
  const dir = resolve(root, "dev");
  const order = [];
  const manager = new ProfileManager({
    directory: dir, appData: root, build: currentBuild,
    deps: {
      execCore: async (args) => {
        order.push(args[1]);
        if (args[1] === "inspect") return { code: 0, stdout: `${JSON.stringify(inspect8())}\n` };
        if (args[1] === "import") {
          const staging = args[args.indexOf("--staging-dir") + 1];
          mkdirSync(staging, { recursive: true });
          writeFileSync(resolve(staging, "goalport.sqlite"), "imported database bytes");
          order.push("db-in-staging");
          return { code: 0, stdout: `${JSON.stringify({ ok: true, stage: "import", markedEpoch: "e1" })}\n` };
        }
        return { code: 0, stdout: `${JSON.stringify({ ok: true, quickCheck: "ok" })}\n` };
      },
      log: (line) => order.push(line)
    }
  });
  const discovery = { path: source, marker: parseMarkerText(markerV1()), inspection: inspect8() };
  const marker = await manager.runImport(discovery, { allowSourceRecovery: false });
  assert.equal(marker.importedFrom.path, source);
  assert.equal(marker.importedFrom.createdBy.coreSha256, otherHash);
  assert.equal(readFileSync(resolve(dir, "goalport.sqlite"), "utf8"), "imported database bytes");
  assert.equal(existsSync(resolve(dir, "import-journal.json")), false, "journal removed after marker commit");
  assert.equal(readdirSync(dir).filter((name) => name.startsWith(".import-staging-")).length, 0, "staging cleaned");
  assert.equal(readFileSync(resolve(source, "goalport.sqlite"), "utf8"), "source database bytes", "source untouched");
  assert.equal(readFileSync(resolve(source, "goalport-profile.json"), "utf8"), markerV1(), "source marker untouched");
  // The source stays inspectable and the imported profile reopens in-channel.
  assert.equal((await manager.resolve()).kind, "reopen");
});

test("ProfileManager: a failed import discards staging and re-offers; a finalized journal resumes", async (t) => {
  const root = fixture(t);
  const source = resolve(root, "rc");
  mkdirSync(source, { recursive: true });
  writeFileSync(resolve(source, "goalport.sqlite"), "source database bytes");
  const dir = resolve(root, "dev");
  const failing = new ProfileManager({
    directory: dir, appData: root, build: currentBuild,
    deps: { execCore: async () => ({ code: 3, stdout: `${JSON.stringify({ ok: false, error: "disk full" })}\n` }) }
  });
  await assert.rejects(failing.runImport({ path: source, marker: parseMarkerText(markerV1()), inspection: inspect8() }), /disk full/);
  assert.equal(existsSync(resolve(dir, "import-journal.json")), false);
  assert.equal(dirContentState(dir).emptyish, true, "no half-import residue");

  // Crash window: journal finalized, marker not yet written.
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "goalport.sqlite"), "imported bytes");
  const staging = resolve(dir, ".import-staging-x");
  mkdirSync(staging, { recursive: true });
  writeFileSync(resolve(dir, "import-journal.json"), JSON.stringify({ phase: "finalized", source, sourceCreatedBy: null, stagingDir: staging }));
  const resumer = new ProfileManager({
    directory: dir, appData: root, build: currentBuild,
    deps: { execCore: async (args) => ({ code: 0, stdout: `${JSON.stringify(args[1] === "inspect" ? inspect8() : { ok: true, quickCheck: "ok" })}\n` }) }
  });
  const outcome = await resumer.resolve();
  assert.equal(outcome.kind, "resume-import");
  resumer.finalizeImport(outcome.journal);
  const marker = parseMarkerText(readFileSync(resolve(dir, "goalport-profile.json"), "utf8"));
  assert.equal(marker.markerSchemaVersion, 2);
  assert.equal(marker.importedFrom.path, source);
  assert.equal(existsSync(staging), false);
});

test("ProfileManager: discovery finds the release rc profile and skips non-GoalPort directories", async (t) => {
  const root = fixture(t);
  const rc = resolve(root, "GoalPort", "rc");
  mkdirSync(rc, { recursive: true });
  writeFileSync(resolve(rc, "goalport-profile.json"), markerV1());
  writeFileSync(resolve(rc, "goalport.sqlite"), "db");
  const junk = resolve(root, "GoalPort", "misc");
  mkdirSync(junk, { recursive: true });
  writeFileSync(resolve(junk, "goalport-profile.json"), JSON.stringify({ product: "Other" }));
  const manager = new ProfileManager({
    directory: resolve(root, "GoalPort", "dev"), appData: root, build: currentBuild,
    deps: { execCore: async () => ({ code: 0, stdout: `${JSON.stringify(inspect8())}\n` }) }
  });
  const discovery = await manager.discoverForeignProfiles();
  assert.equal(discovery.path, rc);
  assert.equal(discovery.marker.product, "GoalPort");
  assert.equal(importableDiscovery(discovery, currentBuild), true);
});

test("resolveProfilePaths and ProfileManager agree on identity for the same directory", async (t) => {
  const root = fixture(t);
  const paths = resolveProfilePaths({ args: {}, appData: root, channel: "dev-candidate", coreSha256: hash });
  const manager = new ProfileManager({
    directory: paths.directory, appData: root,
    build: { ...currentBuild, profileKey: paths.profileKey, channel: paths.channel },
    deps: { execCore: async () => ({ code: 0, stdout: `${JSON.stringify(inspect8())}\n` }) }
  });
  manager.beginFresh();
  const outcome = await manager.resolve();
  assert.equal(outcome.kind, "reopen");
  assert.equal(outcome.needsBackup, true, "marker lastOpenedBy is null on a fresh marker");
});

// ---------- Fail closed on unknown inspection facts ----------

// The shape ProfileManager synthesizes when `profile inspect` itself failed
// (process error, nonzero exit, malformed/unreadable output, ok:false).
const inspectFailed = (extra = {}) => ({
  ok: false, failed: true, exists: true, openable: false, needsRecovery: true, schemaVersion: null,
  error: "core profile inspect exited 3", ...extra
});
// A SUCCESSFUL inspect that honestly reports a database which cannot be
// opened read-only (e.g. WAL shared memory missing): facts exist, but
// compatibility is UNKNOWN.
const inspectUnopenable = (extra = {}) => ({
  schema: "goalport.profile-ops.v1", ok: true, stage: "inspect", exists: true, openable: false, needsRecovery: true, schemaVersion: null,
  error: "unable to open database file", ...extra
});

test("failed inspections fail closed: no reopen, v1 adopt or journal resume on missing facts", () => {
  const base = { dirContentState: { emptyish: false, databasePresent: true }, currentBuild, discovery: null, journal: null };
  const v2 = parseMarkerText(JSON.stringify(markerV2()));
  const v1 = parseMarkerText(markerV1());
  for (const failed of [inspectFailed(), inspectFailed({ error: "quick_check failed" }), inspectFailed({ exists: false })]) {
    assert.equal(decideOwnProfile({ ...base, markerState: v2, inspection: failed }).kind, "inspection-failed");
    assert.equal(decideOwnProfile({ ...base, markerState: v1, inspection: failed }).kind, "inspection-failed",
      "a v1 marker must not be adopted (marker write) without any inspection facts");
  }
  // The journal fast path is gated too: finalizing an import (marker write)
  // on missing or unproven facts is forbidden.
  const journalBase = { markerState: null, currentBuild, discovery: null };
  assert.equal(decideOwnProfile({
    ...journalBase, dirContentState: { emptyish: false, databasePresent: true }, inspection: inspectFailed(),
    journal: { phase: "copying", source: "s", stagingDir: "d" }
  }).kind, "inspection-failed");
  assert.equal(decideOwnProfile({
    ...journalBase, dirContentState: { emptyish: false, databasePresent: false }, inspection: inspectFailed({ exists: false }),
    journal: { phase: "finalized", source: "s", stagingDir: "d" }
  }).kind, "inspection-failed");
  // openable:false = unknown compatibility (including WAL recovery): refuse
  // instead of reopening, write-opening a backup or resuming a journal.
  assert.equal(decideOwnProfile({ ...base, markerState: v2, inspection: inspectUnopenable() }).kind, "needs-recovery");
  assert.equal(decideOwnProfile({
    ...journalBase, dirContentState: { emptyish: false, databasePresent: true }, inspection: inspectUnopenable(),
    journal: { phase: "finalized", source: "s", stagingDir: "d" }
  }).kind, "needs-recovery");
  // Journal resume on PROVEN incompatible data refuses with the honest kind.
  assert.equal(decideOwnProfile({
    ...journalBase, dirContentState: { emptyish: false, databasePresent: true }, inspection: inspect8({ schemaVersion: 9 }),
    journal: { phase: "copying", source: "s", stagingDir: "d" }
  }).kind, "newer-schema");
  assert.equal(decideOwnProfile({
    ...journalBase, dirContentState: { emptyish: false, databasePresent: true },
    inspection: inspect8({ schemaVersion: null, foreignTables: 3 }),
    journal: { phase: "copying", source: "s", stagingDir: "d" }
  }).kind, "unsupported-legacy");
});

test("successful inspections stay authoritative: WAL-tolerant reopen and missing-db decisions are not failures", () => {
  const base = { dirContentState: { emptyish: false, databasePresent: true }, currentBuild, discovery: null, journal: null };
  const v2 = parseMarkerText(JSON.stringify(markerV2()));
  // ok:true + openable:true + needsRecovery:true is a proven-compatible read
  // (quick_check passed); open-time WAL recovery is standard SQLite, NOT a
  // failed inspection. Reopen must keep working for it.
  const walTolerant = decideOwnProfile({ ...base, markerState: v2, inspection: inspect8({ needsRecovery: true }) });
  assert.equal(walTolerant.kind, "reopen");
  assert.equal(walTolerant.note, "readonly-open-needs-recovery");
  // A successful ok:true report of a missing database keeps the honest
  // missing-db decisions (fresh-marker empty reopen; format-committed refusal).
  const noDb = { ok: true, stage: "inspect", exists: false, openable: false, schemaVersion: null };
  assert.equal(decideOwnProfile({
    ...base, dirContentState: { emptyish: false, databasePresent: false },
    markerState: parseMarkerText(JSON.stringify(markerV2({ formatVersion: null }))), inspection: noDb
  }).kind, "reopen");
  assert.equal(decideOwnProfile({
    ...base, dirContentState: { emptyish: false, databasePresent: false }, markerState: v2, inspection: noDb
  }).kind, "missing-database");
  // Journal resume on a genuinely successful missing-db report still resumes
  // (finalized crash window with the database not yet renamed in place).
  assert.equal(decideOwnProfile({
    markerState: null, dirContentState: { emptyish: false, databasePresent: false }, inspection: noDb,
    currentBuild, discovery: null, journal: { phase: "finalized", source: "s", stagingDir: "d" }
  }).kind, "resume-import");
});

test("ProfileManager.resolve fails closed with zero side effects on failed or unopenable inspection", async (t) => {
  const scenarios = [
    { name: "nonzero-exit", stdout: `${JSON.stringify({ schema: "goalport.profile-ops.v1", ok: false, stage: "inspect", error: "quick_check failed" })}\n`, code: 3, expected: "inspection-failed" },
    { name: "ok-false-json", stdout: `${JSON.stringify({ ok: false, stage: "inspect", error: "boom" })}\n`, code: 3, expected: "inspection-failed" },
    { name: "malformed-stdout", stdout: "certainly not json\n", code: 0, expected: "inspection-failed" },
    { name: "empty-stdout", stdout: "", code: 0, expected: "inspection-failed" },
    { name: "exec-core-throws", stdout: "", code: 0, throws: "core binary vanished", expected: "inspection-failed" },
    { name: "unknown-output-schema", stdout: `${JSON.stringify({ schema: "goalport.profile-ops.v2", ok: true, exists: true, openable: true })}\n`, code: 0, expected: "inspection-failed" },
    { name: "missing-fact-fields", stdout: `${JSON.stringify({ schema: "goalport.profile-ops.v1", ok: true })}\n`, code: 0, expected: "inspection-failed" },
    { name: "genuine-wal-unopenable", stdout: `${JSON.stringify(inspectUnopenable())}\n`, code: 0, expected: "needs-recovery" }
  ];
  for (const scenario of scenarios) {
    const root = fixture(t);
    const dir = resolve(root, "dev");
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, "goalport-profile.json"), `${JSON.stringify(markerV2(), null, 2)}\n`);
    writeFileSync(resolve(dir, "goalport.sqlite"), "fixture database bytes");
    const preimage = readdirSync(dir).sort().map((name) => [name, readFileSync(resolve(dir, name)).toString("latin1")]);
    const commands = [];
    const manager = new ProfileManager({
      directory: dir, appData: root, build: currentBuild,
      deps: {
        execCore: async (args) => {
          commands.push(args[1]);
          if (scenario.throws) throw new Error(scenario.throws);
          return { code: scenario.code, stdout: scenario.stdout };
        }
      }
    });
    const outcome = await manager.resolve();
    assert.equal(outcome.kind, scenario.expected, scenario.name);
    assert.ok(typeof outcome.reason === "string" && outcome.reason.length > 0, `${scenario.name}: honest reason`);
    assert.deepEqual(commands, ["inspect"], `${scenario.name}: inspection is read-only; no backup or import ever runs`);
    assert.deepEqual(
      readdirSync(dir).sort().map((name) => [name, readFileSync(resolve(dir, name)).toString("latin1")]),
      preimage,
      `${scenario.name}: the refusal leaves every fixture byte untouched`
    );
  }
});

test("synthetic test profiles validate marker identity and database compatibility through the ProfileManager", async (t) => {
  const syntheticBuild = { ...currentBuild, mode: "synthetic-test", channel: null };
  const syntheticMarker = (extra = {}) => markerV2({ mode: "synthetic-test", channel: null, formatVersion: null, ...extra });
  const okLine = `${JSON.stringify(inspect8())}\n`;
  const missingDbLine = `${JSON.stringify(inspect8({ exists: false, openable: false }))}\n`;
  const root = fixture(t);
  const manager = (dir, stdout) => new ProfileManager({
    directory: dir, appData: root, build: syntheticBuild,
    deps: { execCore: async () => ({ code: 0, stdout }) }
  });
  // Empty directory: fresh, and beginFresh records the synthetic-test identity.
  const dir = resolve(root, "synthetic");
  mkdirSync(dir, { recursive: true });
  assert.equal((await manager(dir, missingDbLine).resolve()).kind, "fresh");
  const marker = manager(dir, okLine).beginFresh();
  assert.equal(marker.mode, "synthetic-test");
  assert.equal(parseMarkerText(readFileSync(resolve(dir, "goalport-profile.json"), "utf8")).mode, "synthetic-test");
  // Compatible synthetic reopen still works (database present, schema current).
  writeFileSync(resolve(dir, "goalport.sqlite"), "synthetic database bytes");
  assert.equal((await manager(dir, okLine).resolve()).kind, "reopen");

  // Refusals: every case must leave the directory bytes untouched and run
  // only the read-only inspection.
  const cases = [
    { name: "normal-mode marker of a real profile", marker: JSON.stringify(markerV2({ mode: "normal", channel: "release" })), db: true, stdout: okLine, expected: "identity-mismatch" },
    { name: "marker of a different directory (profileKey)", marker: JSON.stringify(syntheticMarker({ profileKey: "0".repeat(20) })), db: true, stdout: okLine, expected: "identity-mismatch" },
    { name: "v1 release-era marker", marker: markerV1(), db: true, stdout: okLine, expected: "identity-mismatch" },
    { name: "corrupt marker", marker: "{ not json", db: true, stdout: okLine, expected: "corrupt-marker" },
    { name: "newer database schema", marker: JSON.stringify(syntheticMarker()), db: true, stdout: `${JSON.stringify(inspect8({ schemaVersion: 9 }))}\n`, expected: "newer-schema" },
    { name: "failed inspection", marker: JSON.stringify(syntheticMarker()), db: true, stdout: "garbage\n", expected: "inspection-failed" },
    { name: "unopenable database", marker: JSON.stringify(syntheticMarker()), db: true, stdout: `${JSON.stringify(inspectUnopenable())}\n`, expected: "needs-recovery" },
    { name: "foreign unmarked directory", marker: null, foreignFile: "notes.txt", db: false, stdout: missingDbLine, expected: "not-a-profile" }
  ];
  for (const item of cases) {
    const caseDir = resolve(root, item.name.replace(/[^a-z0-9]+/gi, "-"));
    mkdirSync(caseDir, { recursive: true });
    if (item.marker !== null) writeFileSync(resolve(caseDir, "goalport-profile.json"), item.marker);
    if (item.foreignFile) writeFileSync(resolve(caseDir, item.foreignFile), "user content");
    if (item.db) writeFileSync(resolve(caseDir, "goalport.sqlite"), "fixture database bytes");
    const preimage = readdirSync(caseDir).sort().map((name) => [name, readFileSync(resolve(caseDir, name)).toString("latin1")]);
    const commands = [];
    const caseManager = new ProfileManager({
      directory: caseDir, appData: root, build: syntheticBuild,
      deps: { execCore: async (args) => { commands.push(args[1]); return { code: 0, stdout: item.stdout }; } }
    });
    assert.equal((await caseManager.resolve()).kind, item.expected, item.name);
    assert.deepEqual(commands, ["inspect"], `${item.name}: read-only inspection only`);
    assert.deepEqual(
      readdirSync(caseDir).sort().map((name) => [name, readFileSync(resolve(caseDir, name)).toString("latin1")]),
      preimage,
      `${item.name}: refusal leaves every fixture byte untouched`
    );
  }
});

// ---------- Inspection contract completeness ----------
// Failed and unopenable inspections must refuse, as must a
// "successful existing openable" inspection that omits the
// compatibility/integrity facts `profile_ops::inspect --quick-check` ALWAYS
// emits for that shape still authorized decisions:
//   - missing currentSchemaVersion made the newer-schema comparison read
//     `9 > undefined` → false → REOPEN of data whose format authority was
//     never read (the reviewed repro);
//   - a missing quickCheck reopened data whose integrity was never checked;
//   - the journal fast path never consulted quickCheck at all (a corrupt
//     staged database resumed → marker write);
//   - importableDiscovery imported a corrupt or never-proven-openable source
//     merely because two version numbers compared.
//
// Every refusal test asserts ZERO side effects (read-only `inspect` only,
// directory/journal bytes byte-identical, no marker file appears), not just
// the result kind. Positive controls prove genuine openable/missing-db/
// unopenable/empty/legacy shapes keep their honest decisions.

// Mirrors the real `goalport-core profile inspect --quick-check` output for an
// EXISTING OPENABLE database (profile_ops.rs): schemaVersion from
// schema_migrations, currentSchemaVersion = this build's SCHEMA_VERSION, the
// empty/foreignTables distinction when no migrations table exists, and the
// quickCheck PRAGMA string. These markers commit format version 9 (the schema
// of these fixtures).
const inspectOpenable = (extra = {}) => ({
  schema: "goalport.profile-ops.v1", ok: true, stage: "inspect",
  exists: true, openable: true, needsRecovery: false,
  schemaVersion: 9, currentSchemaVersion: 9, quickCheck: "ok",
  counts: { campaigns: 1 }, latestEpoch: { epochId: "e1", priorCore: "ended", state: "ENDED" },
  ...extra
});
const markerV2Format9 = (extra = {}) => markerV2({ formatVersion: 9, ...extra });
const snapshot = (dir) => readdirSync(dir).sort().map((name) => [name, readFileSync(resolve(dir, name)).toString("latin1")]);

// A profile directory that looks like real user data: marker + database.
function ownProfileDir(root, { marker = JSON.stringify(markerV2Format9()), journal = null } = {}) {
  const dir = resolve(root, "dev");
  mkdirSync(dir, { recursive: true });
  if (marker !== null) writeFileSync(resolve(dir, "goalport-profile.json"), `${marker}\n`);
  writeFileSync(resolve(dir, "goalport.sqlite"), "owner-like database bytes");
  if (journal) writeFileSync(resolve(dir, "import-journal.json"), `${JSON.stringify(journal, null, 2)}\n`);
  return dir;
}
function refusingManager(dir, root, inspection, { build = currentBuild } = {}) {
  const commands = [];
  return {
    commands,
    manager: new ProfileManager({
      directory: dir, appData: root, build,
      deps: { execCore: async (args) => { commands.push(args[1]); return { code: 0, stdout: `${JSON.stringify(inspection)}\n` }; } }
    })
  };
}

test("openable inspection missing currentSchemaVersion or quickCheck must not reopen", async (t) => {
  const cases = [
    // The exact reviewed repro: schema correct, ok:true, exists/openable true,
    // schemaVersion present — currentSchemaVersion absent. Pre-fix:
    // `9 > undefined` → false → reopen (and `10 > undefined` → false let even
    // a NEWER schema reopen).
    { name: "missing currentSchemaVersion", inspection: { schema: "goalport.profile-ops.v1", ok: true, stage: "inspect", exists: true, openable: true, schemaVersion: 9 } },
    { name: "missing currentSchemaVersion with newer schema", inspection: { schema: "goalport.profile-ops.v1", ok: true, stage: "inspect", exists: true, openable: true, schemaVersion: 10 } },
    // Integrity never proven: quickCheck absent must not read as "checked".
    { name: "missing quickCheck", inspection: { schema: "goalport.profile-ops.v1", ok: true, stage: "inspect", exists: true, openable: true, needsRecovery: false, schemaVersion: 9, currentSchemaVersion: 9 } },
    { name: "missing quickCheck on legacy null schema", inspection: { schema: "goalport.profile-ops.v1", ok: true, stage: "inspect", exists: true, openable: true, needsRecovery: false, schemaVersion: null, currentSchemaVersion: 9, foreignTables: 4 } }
  ];
  for (const item of cases) {
    const root = fixture(t);
    const dir = ownProfileDir(root);
    const preimage = snapshot(dir);
    const { commands, manager } = refusingManager(dir, root, item.inspection);
    const outcome = await manager.resolve();
    assert.equal(outcome.kind, "inspection-failed", item.name);
    assert.ok(typeof outcome.reason === "string" && outcome.reason.length > 0, `${item.name}: honest reason`);
    assert.match(outcome.reason, /currentSchemaVersion|quickCheck|empty|schemaVersion|facts/, `${item.name}: reason names the missing fact`);
    assert.deepEqual(commands, ["inspect"], `${item.name}: inspection is read-only; no backup or import ever runs`);
    assert.deepEqual(snapshot(dir), preimage, `${item.name}: the refusal leaves every fixture byte untouched`);
  }
});

test("malformed compatibility/integrity facts fail closed with zero side effects", async (t) => {
  const cases = [
    { name: "schemaVersion string", patch: { schemaVersion: "9" } },
    { name: "schemaVersion negative", patch: { schemaVersion: -1 } },
    { name: "schemaVersion fractional", patch: { schemaVersion: 1.5 } },
    { name: "schemaVersion beyond safe integer", patch: { schemaVersion: 2 ** 53 } },
    { name: "schemaVersion boolean", patch: { schemaVersion: true } },
    { name: "currentSchemaVersion missing", patch: { currentSchemaVersion: undefined } },
    { name: "currentSchemaVersion null", patch: { currentSchemaVersion: null } },
    { name: "currentSchemaVersion string", patch: { currentSchemaVersion: "9" } },
    { name: "currentSchemaVersion negative", patch: { currentSchemaVersion: -3 } },
    { name: "currentSchemaVersion beyond safe integer", patch: { currentSchemaVersion: 2 ** 53 } },
    { name: "null schema without empty indicator", patch: { schemaVersion: null, foreignTables: 3 } },
    { name: "null schema with non-boolean empty", patch: { schemaVersion: null, empty: 1 } },
    { name: "quickCheck numeric", patch: { quickCheck: 0 } },
    { name: "quickCheck object", patch: { quickCheck: { result: "ok" } } }
  ];
  for (const item of cases) {
    const root = fixture(t);
    const dir = ownProfileDir(root);
    const preimage = snapshot(dir);
    const inspection = { ...inspectOpenable() };
    for (const [key, value] of Object.entries(item.patch)) {
      if (value === undefined) delete inspection[key]; else inspection[key] = value;
    }
    const { commands, manager } = refusingManager(dir, root, inspection);
    const outcome = await manager.resolve();
    assert.equal(outcome.kind, "inspection-failed", item.name);
    assert.match(outcome.reason, /compatibility\/integrity|facts/, `${item.name}: reason states the contract failure`);
    assert.deepEqual(commands, ["inspect"], `${item.name}: read-only inspection only`);
    assert.deepEqual(snapshot(dir), preimage, `${item.name}: every fixture byte untouched`);
  }
});

test("a present non-ok quickCheck is honest corruption, never a reopen", async (t) => {
  const root = fixture(t);
  const dir = ownProfileDir(root);
  const preimage = snapshot(dir);
  const { commands, manager } = refusingManager(dir, root, inspectOpenable({ quickCheck: "row 3 missing from campaigns" }));
  const outcome = await manager.resolve();
  assert.equal(outcome.kind, "corrupt");
  assert.equal(outcome.reason, "row 3 missing from campaigns");
  assert.deepEqual(commands, ["inspect"]);
  assert.deepEqual(snapshot(dir), preimage, "corrupt data must not be backed up write-open, migrated or reopened");
});

test("journal fast path cannot bypass quickCheck: corrupt staged data refuses instead of resuming", async (t) => {
  // Decision level (pre-fix repro): corrupt openable database + finalized
  // journal resumed — finalizeImport would write the marker over corrupt data.
  const base = { markerState: null, currentBuild, discovery: null };
  const corrupt = decideOwnProfile({
    ...base, dirContentState: { emptyish: false, databasePresent: true },
    inspection: inspectOpenable({ quickCheck: "row 3 missing" }),
    journal: { phase: "finalized", source: "s", stagingDir: "d" }
  });
  assert.equal(corrupt.kind, "corrupt", "corrupt journal data must refuse, not resume");
  assert.equal(corrupt.reason, "row 3 missing");
  // A journal database of UNPROVEN integrity (quickCheck never reported) is
  // not resumable data either — through the real manager the contract
  // validation refuses it as an inspection failure.
  const unprovenRoot = fixture(t);
  const unprovenJournal = { phase: "copying", source: "s", stagingDir: "d" };
  const unprovenDir = ownProfileDir(unprovenRoot, { marker: null, journal: unprovenJournal });
  const unprovenPreimage = snapshot(unprovenDir);
  const { manager: unprovenManager } = refusingManager(unprovenDir, unprovenRoot, {
    schema: "goalport.profile-ops.v1", ok: true, stage: "inspect", exists: true, openable: true, schemaVersion: 9, currentSchemaVersion: 9
  });
  const unproven = await unprovenManager.resolve();
  assert.equal(unproven.kind, "inspection-failed", "a journal database of unknown integrity is not resumable data");
  assert.deepEqual(snapshot(unprovenDir), unprovenPreimage, "the journal must survive the refusal untouched");
  // Manager level with zero side effects: the journal must survive untouched
  // and no marker may appear.
  const root = fixture(t);
  const journal = { phase: "finalized", source: "C:/d/rc", sourceCreatedBy: null, stagingDir: resolve(root, "staging-x") };
  const dir = ownProfileDir(root, { marker: null, journal });
  const preimage = snapshot(dir);
  const { commands, manager } = refusingManager(dir, root, inspectOpenable({ quickCheck: "row 3 missing" }));
  const outcome = await manager.resolve();
  assert.equal(outcome.kind, "corrupt");
  assert.deepEqual(commands, ["inspect"]);
  assert.deepEqual(snapshot(dir), preimage, "the corrupt refusal must not finalize the journal (no marker write, journal bytes unchanged)");
  // Positive control within the same scope: a genuinely healthy journal
  // database still resumes.
  const healthyRoot = fixture(t);
  const healthyDir = ownProfileDir(healthyRoot, { marker: null, journal: { phase: "finalized", source: "s", stagingDir: "d" } });
  const { manager: healthyManager } = refusingManager(healthyDir, healthyRoot, inspectOpenable());
  assert.equal((await healthyManager.resolve()).kind, "resume-import");
});

test("importableDiscovery requires proven-openable, integrity-verified compatible facts", () => {
  const discovery = (inspection) => ({ path: "C:/d/rc", marker: { markerSchemaVersion: 1, product: "GoalPort", mode: "normal" }, inspection });
  // Positive: the full real-contract shape of an openable compatible source.
  assert.equal(importableDiscovery(discovery(inspectOpenable()), currentBuild), true);
  // Corrupt source (pre-fix repro): numbers compared fine, integrity failed.
  assert.equal(importableDiscovery(discovery(inspectOpenable({ quickCheck: "row 3 missing" })), currentBuild), false);
  assert.match(incompatibilityReason(discovery(inspectOpenable({ quickCheck: "row 3 missing" }))), /integrity/);
  // Never proven openable (failed inspection, or contract-violating shapes).
  assert.equal(importableDiscovery(discovery({ ok: false, failed: true, exists: true, openable: false, needsRecovery: true, schemaVersion: null, error: "exited 3" }), currentBuild), false);
  assert.equal(importableDiscovery(discovery(inspectOpenable({ openable: false })), currentBuild), false);
  assert.equal(importableDiscovery(discovery({ ...inspectOpenable(), openable: undefined }), currentBuild), false);
  // Missing/malformed format authority or integrity fact.
  const { quickCheck, currentSchemaVersion, ...noFacts } = inspectOpenable();
  assert.equal(importableDiscovery(discovery(noFacts), currentBuild), false);
  assert.equal(importableDiscovery(discovery(inspectOpenable({ currentSchemaVersion: "9" })), currentBuild), false);
  assert.equal(importableDiscovery(discovery(inspectOpenable({ quickCheck: undefined })), currentBuild), false);
  // Legacy (null schema) and newer sources stay unimportable.
  assert.equal(importableDiscovery(discovery(inspectOpenable({ schemaVersion: null, empty: false, foreignTables: 2 })), currentBuild), false);
  assert.equal(importableDiscovery(discovery(inspectOpenable({ schemaVersion: 10 })), currentBuild), false);
  // Through the decision: a corrupt discovery is an honest import-incompatible
  // (pre-fix this offered the import).
  const outcome = decideOwnProfile({
    markerState: null, dirContentState: { emptyish: true, databasePresent: false }, inspection: { exists: false },
    currentBuild, discovery: discovery(inspectOpenable({ quickCheck: "row 3 missing" })), journal: null
  });
  assert.equal(outcome.kind, "import-incompatible");
  assert.match(outcome.reason, /integrity/);
});

test("positive controls: genuine inspection shapes keep their honest decisions", async (t) => {
  // A fully-factored compatible inspection reopens (the WAL-tolerant
  // ok:true/openable:true/needsRecovery:true shape included — proven
  // compatibility is not a contract violation).
  for (const [name, inspection, expected] of [
    ["compatible openable", inspectOpenable(), "reopen"],
    ["wal-tolerant openable", inspectOpenable({ needsRecovery: true }), "reopen"],
    ["empty database with valid indicator", inspectOpenable({ schemaVersion: null, empty: true, foreignTables: 0 }), "reopen"],
    ["legacy tables with valid indicator", inspectOpenable({ schemaVersion: null, empty: false, foreignTables: 5 }), "unsupported-legacy"],
    ["newer schema with full facts", inspectOpenable({ schemaVersion: 10 }), "newer-schema"]
  ]) {
    const root = fixture(t);
    const dir = ownProfileDir(root);
    const preimage = snapshot(dir);
    const { commands, manager } = refusingManager(dir, root, inspection);
    const outcome = await manager.resolve();
    assert.equal(outcome.kind, expected, name);
    assert.deepEqual(commands, ["inspect"], name);
    assert.deepEqual(snapshot(dir), preimage, `${name}: resolve itself is read-only; refusals and successes alike must not write`);
  }
  // needsRecovery:true keeps the reopen note for a compatible openable database.
  const walRoot = fixture(t);
  const walDir = ownProfileDir(walRoot);
  const { manager: walManager } = refusingManager(walDir, walRoot, inspectOpenable({ needsRecovery: true }));
  assert.equal((await walManager.resolve()).note, "readonly-open-needs-recovery");
  // The genuine missing-db shape stays a VALID inspection (not failed):
  // format-committed marker → missing-database; format-uncommitted → empty reopen.
  const missing = { schema: "goalport.profile-ops.v1", ok: true, stage: "inspect", exists: false, openable: false, schemaVersion: null };
  const missingRoot = fixture(t);
  const committedDir = ownProfileDir(missingRoot);
  rmSync(resolve(committedDir, "goalport.sqlite"));
  const { commands: c1, manager: committed } = refusingManager(committedDir, missingRoot, missing);
  assert.equal((await committed.resolve()).kind, "missing-database");
  assert.deepEqual(c1, ["inspect"]);
  const uncommittedRoot = fixture(t);
  const uncommittedDir = ownProfileDir(uncommittedRoot, { marker: JSON.stringify(markerV2Format9({ formatVersion: null })) });
  rmSync(resolve(uncommittedDir, "goalport.sqlite"));
  const { manager: uncommitted } = refusingManager(uncommittedDir, uncommittedRoot, missing);
  assert.equal((await uncommitted.resolve()).kind, "reopen");
  // The genuine ok:true/openable:false WAL shape stays needs-recovery.
  const unopenableRoot = fixture(t);
  const unopenableDir = ownProfileDir(unopenableRoot);
  const { commands: c2, manager: unopenable } = refusingManager(unopenableDir, unopenableRoot, {
    schema: "goalport.profile-ops.v1", ok: true, stage: "inspect", exists: true, openable: false, needsRecovery: true, schemaVersion: null,
    error: "unable to open database file"
  });
  assert.equal((await unopenable.resolve()).kind, "needs-recovery");
  assert.deepEqual(c2, ["inspect"]);
  assert.ok(!existsSync(resolve(unopenableRoot, "dev", "backups")), "no write-open backup may appear on a needs-recovery refusal");
});
