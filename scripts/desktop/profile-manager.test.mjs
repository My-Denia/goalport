import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  parseMarkerText, buildMarkerV2, decideOwnProfile, importableDiscovery, incompatibilityReason,
  backupsToPrune, dirContentState, ProfileManager, ELECTRON_SESSION_ARTIFACTS, isElectronArtifact,
  JOURNAL_SCHEMA, RECOVERY_DISPOSITION, RECOVERY_METHOD, recoveryProbeCandidate
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

function mockProof({ operationId, markerSha256, provenanceSha256, method = "SQLITE_ONLINE_BACKUP_V1", schemaVersion = 8 }) {
  return {
    schema: "goalport.import-proof.v1",
    operationId,
    method,
    sourceMutation: "NONE",
    sourceBindingSha256: "c".repeat(64),
    sourceSnapshotToken: "d".repeat(64),
    sourceMarkerSha256: markerSha256,
    provenanceSha256,
    recoveryProofToken: "e".repeat(64),
    stagedDatabase: { sha256: "f".repeat(64), bytes: 23, schemaVersion, quickCheck: "ok", counts: { campaigns: 2 }, countsSha256: "1".repeat(64) },
    markedEpoch: "e1"
  };
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

test("post-open schema commits fresh/imported/migrated facts and later database loss refuses", async (t) => {
  for (const kind of ["fresh", "imported", "migrated"]) {
    const root = fixture(t), dir = resolve(root, "profile");
    let facts = inspect8({ schemaVersion: 9, currentSchemaVersion: 9 });
    const contexts = [];
    const manager = new ProfileManager({ directory: dir, appData: root, build: { ...currentBuild, channel: null },
      deps: { execCore: async (_args, context) => { contexts.push(context); return { code: 0, stdout: JSON.stringify(facts) }; } } });
    if (kind === "fresh") manager.beginFresh();
    else manager.writeMarker(markerV2({ formatVersion: kind === "migrated" ? 8 : null,
      importedFrom: kind === "imported" ? { path: "synthetic-source" } : null }));
    const marker = await manager.recordOpenedDatabase();
    assert.equal(marker.format.version, 9);
    assert.equal(contexts[0].purpose, "post-core-open");
    facts = inspect8({ exists: false, openable: false, schemaVersion: null });
    assert.equal((await manager.resolve()).kind, "missing-database", kind);
  }
});

test("post-open missing/malformed/newer/corrupt facts never advance marker", async (t) => {
  const root = fixture(t), dir = resolve(root, "profile");
  let facts;
  const manager = new ProfileManager({ directory: dir, appData: root, build: currentBuild,
    deps: { execCore: async () => ({ code: 0, stdout: JSON.stringify(facts) }) } });
  manager.beginFresh();
  const before = readFileSync(manager.markerPath(), "utf8");
  for (const rejected of [inspect8({ exists: false, openable: false, schemaVersion: null }), {},
    inspect8({ schemaVersion: 10, currentSchemaVersion: 9 }), inspect8({ quickCheck: "corrupt" }), inspect8({ openable: false })]) {
    facts = rejected;
    await assert.rejects(manager.recordOpenedDatabase(), /could not be verified/);
    assert.equal(readFileSync(manager.markerPath(), "utf8"), before);
  }
  facts = inspect8();
  manager.writeMarker = () => { throw new Error("read-only marker"); };
  await assert.rejects(manager.recordOpenedDatabase(), /read-only marker/);
});

test("legacy opened markers with null schema cannot treat a lost DB as never-opened fresh", () => {
  const marker = parseMarkerText(JSON.stringify(markerV2({ formatVersion: null })));
  assert.equal(decideOwnProfile({ markerState: marker, dirContentState: { emptyish: false, databasePresent: false },
    inspection: inspect8({ exists: false }), currentBuild }).kind, "missing-database");
});

test("journal staging outside/root/traversal/wrong-name/junction refuses before any finalize write or deletion", async (t) => {
  const root = fixture(t), dir = resolve(root, "profile"), outside = resolve(root, "outside");
  mkdirSync(dir); mkdirSync(outside);
  writeFileSync(resolve(outside, "keep.txt"), "unrelated data");
  writeFileSync(resolve(dir, "goalport.sqlite"), "synthetic database bytes");
  const redirected = resolve(dir, ".import-staging-link");
  symlinkSync(outside, redirected, "junction");
  const manager = new ProfileManager({ directory: dir, appData: root, build: currentBuild,
    deps: { execCore: async () => ({ code: 0, stdout: JSON.stringify(inspect8()) }) } });
  for (const stagingDir of [outside, dir, `${dir}/../outside`, resolve(dir, "wrong-name"), redirected, ".import-staging-relative"]) {
    const journal = { phase: "finalized", source: "synthetic", stagingDir };
    const bytes = JSON.stringify(journal);
    writeFileSync(manager.journalPath(), bytes);
    assert.equal((await manager.resolve()).kind, "import-failed");
    assert.throws(() => manager.finalizeImport(journal), /staging/);
    assert.equal(existsSync(manager.markerPath()), false);
    assert.equal(readFileSync(manager.journalPath(), "utf8"), bytes);
    assert.equal(readFileSync(resolve(outside, "keep.txt"), "utf8"), "unrelated data");
  }
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
  }).kind, "missing-database");
  // A legacy copying journal without a promoted database has no bound proof;
  // it blocks fresh classification.
  assert.equal(decideOwnProfile({
    markerState: null, dirContentState: { emptyish: true, databasePresent: false }, inspection: { exists: false },
    currentBuild, discovery: null, journal: { phase: "copying", source: "s", stagingDir: "d" }
  }).kind, "import-failed");
});

test("backup rotation never prunes the newest and staging content is not profile content", (t) => {
  const names = [
    "goalport-2026-09-20T00-00-00-000Z.sqlite",
    "goalport-2026-09-21T00-00-00-000Z-1234abcd-1111-2222-3333-123456789abc.sqlite",
    "goalport-2026-09-22T00-00-00-000Z-2234abcd-1111-2222-3333-123456789abc.sqlite",
    "goalport-2026-09-23T00-00-00-000Z-3234abcd-1111-2222-3333-123456789abc.sqlite",
    "goalport-2026-09-24T00-00-00-000Z-4234abcd-1111-2222-3333-123456789abc.sqlite",
    ".goalport-2026-09-25T00-00-00-000Z.partial",
    "unrelated.sqlite"
  ];
  assert.deepEqual(backupsToPrune(names), names.slice(0, 2));
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

// ---------- Storage boundary: fresh correctness without the Chromium allowlist ----------

test("legacy: a durable root with only historical Chromium artifacts and no marker/database is fresh-compatible", async (t) => {
  // The CI53 residue shape: a durable root left over from the pre-split era
  // where Electron userData WAS the profile directory. Every entry below is a
  // frozen historical Chromium name or regex shape; there is no marker and no
  // database. This is the known legacy case and stays fresh-compatible.
  const root = fixture(t);
  for (const name of ["Cache", "Code Cache", "GPUCache", "Local State", "Preferences", "DIPS", "DIPS-wal", "blob_storage", "declarative_performance_observer.db", "declarative_performance_observer.db-journal", "lockfile", "window-state.json"]) {
    const target = resolve(root, name);
    if (name.includes("/")) mkdirSync(target, { recursive: true });
    else writeFileSync(target, "x");
  }
  const state = dirContentState(root);
  assert.equal(state.emptyish, true, "historical electron-owned files are not durable profile content");
  const manager = new ProfileManager({
    directory: root, appData: resolve(root, ".."), build: { ...currentBuild, channel: null },
    deps: { execCore: async () => ({ code: 0, stdout: `${JSON.stringify(inspect8({ exists: false, openable: false }))}\n` }) }
  });
  const outcome = await manager.resolve();
  assert.equal(outcome.kind, "fresh", "the legacy Chromium-contaminated root resolves as fresh-compatible");
  assert.equal(existsSync(resolve(root, "goalport-profile.json")), false, "resolve itself never writes the marker");
});

test("legacy: any unknown user file in the durable root keeps the honest not-a-profile refusal", async (t) => {
  const root = fixture(t);
  for (const name of ["Cache", "Local State"]) writeFileSync(resolve(root, name), "x");
  writeFileSync(resolve(root, "userfile.txt"), "x");
  assert.equal(dirContentState(root).emptyish, false, "unknown user content is meaningful");
  const manager = new ProfileManager({
    directory: root, appData: resolve(root, ".."), build: { ...currentBuild, channel: null },
    deps: { execCore: async () => ({ code: 0, stdout: `${JSON.stringify(inspect8({ exists: false, openable: false }))}\n` }) }
  });
  assert.equal((await manager.resolve()).kind, "not-a-profile");
});

test("fresh: an absent durable path classifies fresh even with a fully populated browser-state namespace", async (t) => {
  const root = fixture(t);
  const durable = resolve(root, "profile");
  const browser = resolve(root, "electron", "k".repeat(20));
  mkdirSync(browser, { recursive: true });
  // Real Chromium shapes, INCLUDING a name no frozen list knows: after the
  // storage-boundary split Chromium writes only here, so none of this can
  // affect the durable classification.
  for (const name of ["Cache", "Code Cache", "GPUCache", "Local State", "Preferences", "DIPS", "DIPS-wal", "blob_storage", "Network", "DevToolsActivePort", "SomeEntirelyNewBrowserStateFile"]) {
    const target = resolve(browser, name);
    if (name === "Cache" || name === "Network" || name === "blob_storage") mkdirSync(target, { recursive: true });
    else writeFileSync(target, "x");
  }
  const manager = new ProfileManager({
    directory: durable, appData: root, build: { ...currentBuild, channel: null },
    deps: { execCore: async () => ({ code: 0, stdout: `${JSON.stringify(inspect8({ exists: false, openable: false }))}\n` }) }
  });
  const outcome = await manager.resolve();
  assert.equal(outcome.kind, "fresh");
  assert.equal(existsSync(durable), false, "resolve never creates or writes the durable root");
});

test("fresh: unknown Chromium filenames appearing DURING resolve have zero effect on the durable classification", async (t) => {
  // The key anti-TOCTOU test. While the (mocked) Core inspection is in
  // flight, a hypothetical next Chromium version writes brand-new userData
  // files into the BROWSER namespace. Every filename is generated at RUN time
  // and asserted NOT to be recognized by the product's frozen legacy set —
  // the test cannot pass by growing an allowlist, because the names are
  // different on every run and the durable root is never even looked at for
  // them.
  const root = fixture(t);
  const durable = resolve(root, "profile");
  const browser = resolve(root, "electron", "k".repeat(20));
  mkdirSync(browser, { recursive: true });
  const created = [];
  let releaseInspection;
  const inspectionGate = new Promise((resolveGate) => { releaseInspection = resolveGate; });
  const manager = new ProfileManager({
    directory: durable, appData: root, build: { ...currentBuild, channel: null },
    deps: {
      execCore: async () => {
        for (let index = 0; index < 5; index += 1) {
          const name = `SomeEntirelyNewBrowserStateFile-${index}-${randomUUID()}`;
          assert.equal(ELECTRON_SESSION_ARTIFACTS.has(name), false, "fixture name must be outside the frozen legacy set");
          assert.equal(isElectronArtifact(name), false, "fixture name must match neither the set nor the regexes");
          writeFileSync(resolve(browser, name), "transient");
          created.push(name);
        }
        await inspectionGate;
        return { code: 0, stdout: `${JSON.stringify(inspect8({ exists: false, openable: false }))}\n` };
      }
    }
  });
  const resolving = manager.resolve();
  assert.equal(created.length, 5, "the transient browser-state files exist while the inspection is in flight");
  releaseInspection();
  const outcome = await resolving;
  assert.equal(outcome.kind, "fresh");
  assert.equal(existsSync(durable), false, "the durable root is never created or written");
  assert.ok(created.every((name) => existsSync(resolve(browser, name))), "the browser namespace keeps its transient files; nothing was deleted");
});

test("a foreign unmarked goalport.sqlite in the durable root refuses as not-a-profile (filesystem level)", async (t) => {
  const root = fixture(t);
  const dir = resolve(root, "foreign");
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "goalport.sqlite"), "foreign database bytes");
  const commands = [];
  const manager = new ProfileManager({
    directory: dir, appData: root, build: { ...currentBuild, channel: null },
    deps: { execCore: async (args) => { commands.push(args[1]); return { code: 0, stdout: `${JSON.stringify(inspect8())}\n` }; } }
  });
  assert.equal((await manager.resolve()).kind, "not-a-profile");
  assert.equal(existsSync(resolve(dir, "goalport-profile.json")), false, "no marker may be written over a foreign database");
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
  assert.equal(outcome.formatVersion, 8, "a reopen outcome carries the inspection's proven schema version (P1)");
  manager.recordOpen(outcome.formatVersion);
  const reopened = parseMarkerText(readFileSync(resolve(dir, "goalport-profile.json"), "utf8"));
  assert.equal(reopened.lastOpenedBy.coreSha256, hash);
  assert.equal(reopened.format.version, 8, "recordOpen commits the proven format version");
  // v1 in-place adoption
  const explicit = resolve(root, "explicit");
  mkdirSync(explicit, { recursive: true });
  writeFileSync(resolve(explicit, "goalport-profile.json"), markerV1());
  const adopter = new ProfileManager({
    directory: explicit, appData: root, build: { ...currentBuild, channel: null },
    deps: { execCore: async () => ({ code: 0, stdout: `${JSON.stringify(inspect8())}\n` }) }
  });
  const adoption = await adopter.resolve();
  assert.equal(adoption.kind, "adopt-v1");
  assert.equal(adoption.formatVersion, 8, "an adopt outcome carries the inspection's proven schema version (P1)");
  const backedUp = adopter.backupOwnDatabase; // backup happens in main before adopt; marker upgrade itself:
  const upgraded = adopter.readMarker();
  assert.equal(upgraded.markerSchemaVersion, 1);
  adopter.adoptV1Marker(upgraded);
  const after = parseMarkerText(readFileSync(resolve(explicit, "goalport-profile.json"), "utf8"));
  assert.equal(after.markerSchemaVersion, 2);
  assert.equal(after.createdBy.coreSha256, otherHash, "v1 provenance is preserved, not rewritten");
  // P1: one open with a proven schema commits it (main's recordOpen(outcome.formatVersion)).
  adopter.recordOpen(adoption.formatVersion);
  const adoptedOpen = parseMarkerText(readFileSync(resolve(explicit, "goalport-profile.json"), "utf8"));
  assert.equal(adoptedOpen.markerSchemaVersion, 2);
  assert.equal(adoptedOpen.format.version, 8, "the adopted marker commits the proven format version after one open");
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
          const operationId = args[args.indexOf("--operation-id") + 1];
          const markerSha256 = args[args.indexOf("--source-marker-sha256") + 1];
          const provenanceSha256 = args[args.indexOf("--provenance-sha256") + 1];
          mkdirSync(staging, { recursive: true });
          writeFileSync(resolve(staging, "goalport.sqlite"), "imported database bytes");
          const proof = mockProof({ operationId, markerSha256, provenanceSha256 });
          writeFileSync(resolve(staging, "import-proof.json"), JSON.stringify(proof));
          order.push("db-in-staging");
          return { code: 0, stdout: `${JSON.stringify({ schema: "goalport.profile-ops.v1", ok: true, stage: "import", proof })}\n` };
        }
        if (args[1] === "verify-staging") {
          const proofToken = args[args.indexOf("--expected-proof-token") + 1];
          return { code: 0, stdout: `${JSON.stringify({ schema: "goalport.profile-ops.v1", ok: true, stage: "verify-staging", verified: true, recoveryProofToken: proofToken })}\n` };
        }
        return { code: 0, stdout: `${JSON.stringify({ schema: "goalport.profile-ops.v1", ok: true, quickCheck: "ok" })}\n` };
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
  writeFileSync(resolve(source, "goalport-profile.json"), markerV1());
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
    markerState: parseMarkerText(JSON.stringify(markerV2({ formatVersion: null, lastOpenedBy: null }))), inspection: noDb
  }).kind, "reopen");
  assert.equal(decideOwnProfile({
    ...base, dirContentState: { emptyish: false, databasePresent: false }, markerState: v2, inspection: noDb
  }).kind, "missing-database");
  // Finalized is written after rename, so absence is lost import data.
  assert.equal(decideOwnProfile({
    markerState: null, dirContentState: { emptyish: false, databasePresent: false }, inspection: noDb,
    currentBuild, discovery: null, journal: { phase: "finalized", source: "s", stagingDir: "d" }
  }).kind, "missing-database");
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
  const healthyDir = ownProfileDir(healthyRoot, { marker: null, journal: { phase: "finalized", source: "s", stagingDir: resolve(healthyRoot, "dev", ".import-staging-valid") } });
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
  const uncommittedDir = ownProfileDir(uncommittedRoot, { marker: JSON.stringify(markerV2Format9({ formatVersion: null, lastOpenedBy: null })) });
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

const recoveryInspection = () => ({
  schema: "goalport.profile-ops.v1", ok: true, stage: "inspect",
  exists: true, openable: false, needsRecovery: true, schemaVersion: null,
  walBytes: 8192, shmPresent: false,
  access: { disposition: "RECOVERY_PROBE_REQUIRED", reason: "WAL_PRESENT_SHM_MISSING" }
});

test("recovery offer requires a bound detached-copy proof and exact current consent", async (t) => {
  const root = fixture(t);
  const rc = resolve(root, "GoalPort", "rc");
  const dev = resolve(root, "GoalPort", "dev");
  mkdirSync(rc, { recursive: true });
  writeFileSync(resolve(rc, "goalport-profile.json"), markerV1());
  writeFileSync(resolve(rc, "goalport.sqlite"), "source-main");
  writeFileSync(resolve(rc, "goalport.sqlite-wal"), "source-wal");
  const sourcePreimage = [readFileSync(resolve(rc, "goalport.sqlite")), readFileSync(resolve(rc, "goalport.sqlite-wal"))];
  const calls = [];
  const manager = new ProfileManager({
    directory: dev, appData: root, build: currentBuild,
    deps: { execCore: async (args) => {
      calls.push(args[1]);
      if (args[1] === "inspect") {
        const database = args[args.indexOf("--db") + 1];
        return { code: 0, stdout: `${JSON.stringify(database.startsWith(rc) ? recoveryInspection() : inspect8({ exists: false, openable: false, schemaVersion: null }))}\n` };
      }
      if (args[1] === "recovery-probe") {
        const staging = args[args.indexOf("--staging-dir") + 1];
        const operationId = args[args.indexOf("--operation-id") + 1];
        const markerSha256 = args[args.indexOf("--source-marker-sha256") + 1];
        const provenanceSha256 = args[args.indexOf("--provenance-sha256") + 1];
        writeFileSync(resolve(staging, "goalport.sqlite"), "verified recovered copy");
        const proof = mockProof({ operationId, markerSha256, provenanceSha256, method: RECOVERY_METHOD });
        writeFileSync(resolve(staging, "import-proof.json"), JSON.stringify(proof));
        return { code: 0, stdout: `${JSON.stringify({
          schema: "goalport.profile-ops.v1", ok: true, stage: "recovery-probe",
          recoveryDisposition: RECOVERY_DISPOSITION, recoveryMethod: RECOVERY_METHOD, sourceMutation: "NONE",
          sourceBindingSha256: proof.sourceBindingSha256, sourceSnapshotToken: proof.sourceSnapshotToken,
          recoveryProofToken: proof.recoveryProofToken, stagedDatabase: proof.stagedDatabase
        })}\n` };
      }
      if (args[1] === "verify-staging") {
        const proofToken = args[args.indexOf("--expected-proof-token") + 1];
        return { code: 0, stdout: `${JSON.stringify({ schema: "goalport.profile-ops.v1", ok: true, verified: true, recoveryProofToken: proofToken })}\n` };
      }
      if (args[1] === "verify-source") {
        return { code: 0, stdout: `${JSON.stringify({ schema: "goalport.profile-ops.v1", ok: true, sourceMutation: "NONE" })}\n` };
      }
      throw new Error(`unexpected ${args.join(" ")}`);
    } }
  });
  const outcome = await manager.resolve();
  assert.equal(outcome.kind, "import-recovery-offer");
  assert.equal(outcome.recovery.recoveryDisposition, RECOVERY_DISPOSITION);
  assert.equal(outcome.recovery.sourceMutationOnAccept, "NONE");
  assert.equal(existsSync(resolve(rc, "goalport.sqlite-shm")), false, "Electron never writes source SHM");
  assert.deepEqual(readFileSync(resolve(rc, "goalport.sqlite")), sourcePreimage[0]);
  assert.deepEqual(readFileSync(resolve(rc, "goalport.sqlite-wal")), sourcePreimage[1]);

  await assert.rejects(
    manager.acceptRecovery(outcome.journal, { operationId: outcome.recovery.operationId, recoveryProofToken: "0".repeat(64) }),
    /does not match/
  );
  assert.equal(manager.readJournal().phase, "AWAITING_RECOVERY_CONSENT", "wrong token persists no consent");
  assert.equal(existsSync(resolve(dev, "goalport.sqlite")), false);

  const markerText = readFileSync(resolve(rc, "goalport-profile.json"), "utf8");
  writeFileSync(resolve(rc, "goalport-profile.json"), `${markerText} `);
  await assert.rejects(
    manager.acceptRecovery(outcome.journal, {
      operationId: outcome.recovery.operationId,
      recoveryProofToken: outcome.recovery.recoveryProofToken
    }),
    /source marker changed/
  );
  assert.equal(manager.readJournal().consent, null, "changed source persists no consent");
  writeFileSync(resolve(rc, "goalport-profile.json"), markerText);

  const marker = await manager.acceptRecovery(outcome.journal, {
    operationId: outcome.recovery.operationId,
    recoveryProofToken: outcome.recovery.recoveryProofToken
  });
  assert.equal(marker.format.version, 8);
  assert.equal(marker.importedFrom.createdBy.coreSha256, otherHash, "recovery keeps source build provenance");
  assert.equal(marker.importedFrom.verification.method, RECOVERY_METHOD);
  assert.equal(marker.importedFrom.verification.sourceMutation, "NONE");
  assert.equal(marker.importedFrom.verification.proofToken, outcome.recovery.recoveryProofToken);
  assert.equal(readFileSync(resolve(dev, "goalport.sqlite"), "utf8"), "verified recovered copy");
  assert.equal(existsSync(resolve(dev, "import-journal.json")), false);
  assert.equal(calls.filter((entry) => entry === "verify-source").length, 1, "source is reverified only for valid consent");
});

test("generic unopenable discovery is never recovery-eligible", () => {
  const discovery = { path: "C:/source", marker: parseMarkerText(markerV1()), inspection: inspectUnopenable() };
  assert.equal(recoveryProbeCandidate(discovery), false);
  assert.equal(recoveryProbeCandidate({ ...discovery, inspection: recoveryInspection() }), true);
});

test("explicit recovery decline cleans only the owned probe before fresh init", async (t) => {
  const root = fixture(t), dir = resolve(root, "dev"), staging = resolve(dir, ".import-staging-decline");
  mkdirSync(staging, { recursive: true });
  writeFileSync(resolve(staging, "goalport.sqlite"), "copy");
  const journal = {
    schema: JOURNAL_SCHEMA, operationId: "decline-operation", mode: "DETACHED_WAL_RECOVERY",
    phase: "AWAITING_RECOVERY_CONSENT", source: { directory: resolve(root, "source"), markerSha256: "a".repeat(64), bindingSha256: "c".repeat(64), snapshotToken: "d".repeat(64) },
    stagingDir: staging, proofToken: "e".repeat(64), provenanceSha256: "b".repeat(64), consent: null
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "import-journal.json"), JSON.stringify(journal));
  const manager = new ProfileManager({ directory: dir, appData: root, build: currentBuild, deps: { execCore: async () => { throw new Error("unused"); } } });
  manager.declineRecovery(journal);
  assert.equal(existsSync(staging), false);
  assert.equal(existsSync(manager.journalPath()), false);
  manager.beginFresh();
  assert.equal(existsSync(manager.markerPath()), true);
});

test("COPYING crash resumes only a matching bound proof; arbitrary SQLite never becomes fresh", async (t) => {
  const root = fixture(t), dir = resolve(root, "dev"), staging = resolve(dir, ".import-staging-crash");
  mkdirSync(staging, { recursive: true });
  writeFileSync(resolve(staging, "goalport.sqlite"), "verified staged bytes");
  const journal = {
    schema: JOURNAL_SCHEMA, operationId: "copying-operation", mode: "ORDINARY_COPY", phase: "COPYING",
    source: { directory: resolve(root, "source"), markerSha256: "a".repeat(64), bindingSha256: null, snapshotToken: null },
    sourceCreatedBy: null, stagingDir: staging, proofToken: null, provenanceSha256: "b".repeat(64),
    consent: { kind: "ORDINARY_IMPORT", acceptedAt: "2026-09-22T00:00:00.000Z", operationId: "copying-operation" }
  };
  const proof = mockProof({ operationId: journal.operationId, markerSha256: journal.source.markerSha256, provenanceSha256: journal.provenanceSha256 });
  writeFileSync(resolve(staging, "import-proof.json"), JSON.stringify(proof));
  writeFileSync(resolve(dir, "import-journal.json"), JSON.stringify(journal));
  const manager = new ProfileManager({
    directory: dir, appData: root, build: currentBuild,
    deps: { execCore: async (args) => ({ code: 0, stdout: `${JSON.stringify({
      schema: "goalport.profile-ops.v1", ok: true, verified: true,
      recoveryProofToken: args[args.indexOf("--expected-proof-token") + 1]
    })}\n` }) }
  });
  const outcome = await manager.resolve();
  assert.equal(outcome.kind, "resume-import");
  assert.equal(outcome.journal.phase, "PROMOTED");
  manager.finalizeImport(outcome.journal);
  assert.equal(readFileSync(resolve(dir, "goalport.sqlite"), "utf8"), "verified staged bytes");

  const badRoot = fixture(t), badDir = resolve(badRoot, "dev"), badStaging = resolve(badDir, ".import-staging-arbitrary");
  mkdirSync(badStaging, { recursive: true });
  writeFileSync(resolve(badStaging, "goalport.sqlite"), "healthy-looking but unbound");
  writeFileSync(resolve(badDir, "import-journal.json"), JSON.stringify({ ...journal, stagingDir: badStaging }));
  const refusing = new ProfileManager({ directory: badDir, appData: badRoot, build: currentBuild, deps: { execCore: async () => { throw new Error("must not reach Core without proof"); } } });
  assert.equal((await refusing.resolve()).kind, "import-failed");
  assert.equal(existsSync(resolve(badDir, "goalport-profile.json")), false);
  assert.equal(existsSync(resolve(badDir, "import-journal.json")), true, "bad proof state is preserved, not freshened");
});

test("hardlink-before-journal crash heals only the same proof-bound file; foreign destination refuses", async (t) => {
  const makeCase = (label) => {
    const root = fixture(t), dir = resolve(root, label), staging = resolve(dir, `.import-staging-${label}`);
    mkdirSync(staging, { recursive: true });
    writeFileSync(resolve(staging, "goalport.sqlite"), `verified-${label}`);
    const journal = {
      schema: JOURNAL_SCHEMA, operationId: `${label}-operation`, mode: "ORDINARY_COPY", phase: "STAGED_VERIFIED",
      source: { directory: resolve(root, "source"), markerSha256: "a".repeat(64), bindingSha256: "c".repeat(64), snapshotToken: "d".repeat(64) },
      sourceCreatedBy: null, stagingDir: staging, proofToken: "e".repeat(64), provenanceSha256: "b".repeat(64), verifiedSchemaVersion: 8,
      consent: { kind: "ORDINARY_IMPORT", acceptedAt: "2026-09-22T00:00:00.000Z", operationId: `${label}-operation`, proofToken: "e".repeat(64) }
    };
    const proof = mockProof({ operationId: journal.operationId, markerSha256: journal.source.markerSha256, provenanceSha256: journal.provenanceSha256 });
    writeFileSync(resolve(staging, "import-proof.json"), JSON.stringify(proof));
    writeFileSync(resolve(dir, "import-journal.json"), JSON.stringify(journal));
    const manager = new ProfileManager({ directory: dir, appData: root, build: currentBuild,
      deps: { execCore: async (args) => ({ code: 0, stdout: `${JSON.stringify({ schema: "goalport.profile-ops.v1", ok: true, verified: true, recoveryProofToken: args[args.indexOf("--expected-proof-token") + 1] })}\n` }) } });
    return { root, dir, staging, journal, manager };
  };

  const crashed = makeCase("hardlink-crash");
  const realWriteJournal = crashed.manager.writeJournal.bind(crashed.manager);
  crashed.manager.writeJournal = (journal) => {
    if (journal.phase === "PROMOTED") throw new Error("injected journal publish failure");
    return realWriteJournal(journal);
  };
  assert.throws(() => crashed.manager.promoteStaged(crashed.journal), /injected/);
  assert.equal(existsSync(resolve(crashed.dir, "goalport.sqlite")), true, "hard link crossed before journal failure");
  assert.equal(JSON.parse(readFileSync(resolve(crashed.dir, "import-journal.json"), "utf8")).phase, "STAGED_VERIFIED");
  const healed = new ProfileManager({ directory: crashed.dir, appData: crashed.root, build: currentBuild,
    deps: crashed.manager.execCore ? { execCore: crashed.manager.execCore } : {} });
  const resumed = await healed.resolve();
  assert.equal(resumed.kind, "resume-import");
  assert.equal(resumed.journal.phase, "PROMOTED");
  healed.finalizeImport(resumed.journal);

  const foreign = makeCase("foreign-root");
  writeFileSync(resolve(foreign.dir, "goalport.sqlite"), "unrelated destination");
  const refused = await foreign.manager.resolve();
  assert.equal(refused.kind, "import-failed");
  assert.match(refused.reason, /not the proof-bound staged file/);
  assert.equal(readFileSync(resolve(foreign.dir, "goalport.sqlite"), "utf8"), "unrelated destination");
  assert.equal(existsSync(resolve(foreign.dir, "import-journal.json")), true);
});

test("PROMOTED without exact consent and replaced staging symlink both fail closed", async (t) => {
  const root = fixture(t), dir = resolve(root, "promoted"), staging = resolve(dir, ".import-staging-promoted");
  mkdirSync(staging, { recursive: true });
  writeFileSync(resolve(staging, "goalport.sqlite"), "verified-promoted");
  const journal = {
    schema: JOURNAL_SCHEMA, operationId: "promoted-operation", mode: "ORDINARY_COPY", phase: "STAGED_VERIFIED",
    source: { directory: resolve(root, "source"), markerSha256: "a".repeat(64), bindingSha256: "c".repeat(64), snapshotToken: "d".repeat(64) },
    stagingDir: staging, proofToken: "e".repeat(64), provenanceSha256: "b".repeat(64), verifiedSchemaVersion: 8,
    consent: { kind: "ORDINARY_IMPORT", operationId: "promoted-operation", proofToken: "e".repeat(64) }
  };
  const proof = mockProof({ operationId: journal.operationId, markerSha256: journal.source.markerSha256, provenanceSha256: journal.provenanceSha256 });
  writeFileSync(resolve(staging, "import-proof.json"), JSON.stringify(proof));
  writeFileSync(resolve(dir, "import-journal.json"), JSON.stringify(journal));
  const execCore = async (args) => ({ code: 0, stdout: `${JSON.stringify({ schema: "goalport.profile-ops.v1", ok: true, verified: true, recoveryProofToken: args[args.indexOf("--expected-proof-token") + 1] })}\n` });
  const manager = new ProfileManager({ directory: dir, appData: root, build: currentBuild, deps: { execCore } });
  manager.promoteStaged(journal);
  journal.consent = null;
  manager.writeJournal(journal);
  assert.equal((await manager.resolve()).kind, "import-failed", "PROMOTED requires exact durable consent");

  const linkRoot = fixture(t), linkDir = resolve(linkRoot, "profile"), outside = resolve(linkRoot, "outside");
  mkdirSync(linkDir, { recursive: true }); mkdirSync(outside);
  writeFileSync(resolve(outside, "goalport.sqlite"), "outside sentinel");
  writeFileSync(resolve(outside, "import-proof.json"), JSON.stringify(proof));
  const redirected = resolve(linkDir, ".import-staging-replaced");
  symlinkSync(outside, redirected, "junction");
  const linkJournal = { ...journal, phase: "STAGED_VERIFIED", consent: { kind: "ORDINARY_IMPORT", operationId: journal.operationId, proofToken: journal.proofToken }, stagingDir: redirected };
  writeFileSync(resolve(linkDir, "import-journal.json"), JSON.stringify(linkJournal));
  const linkManager = new ProfileManager({ directory: linkDir, appData: linkRoot, build: currentBuild, deps: { execCore } });
  assert.equal((await linkManager.resolve()).kind, "import-failed");
  assert.equal(readFileSync(resolve(outside, "goalport.sqlite"), "utf8"), "outside sentinel");
  assert.equal(existsSync(resolve(linkDir, "goalport.sqlite")), false);
});

test("nonzero/lost import response preserves valid proof, while replaced staging is never cleanup authority", async (t) => {
  const root = fixture(t), source = resolve(root, "source"), dir = resolve(root, "dev");
  mkdirSync(source, { recursive: true });
  writeFileSync(resolve(source, "goalport-profile.json"), markerV1());
  writeFileSync(resolve(source, "goalport.sqlite"), "source");
  const execCore = async (args) => {
    if (args[1] === "import") {
      const staging = args[args.indexOf("--staging-dir") + 1];
      const proof = mockProof({
        operationId: args[args.indexOf("--operation-id") + 1],
        markerSha256: args[args.indexOf("--source-marker-sha256") + 1],
        provenanceSha256: args[args.indexOf("--provenance-sha256") + 1]
      });
      writeFileSync(resolve(staging, "goalport.sqlite"), "verified despite lost response");
      writeFileSync(resolve(staging, "import-proof.json"), JSON.stringify(proof));
      return { code: 3, stdout: `${JSON.stringify({ schema: "goalport.profile-ops.v1", ok: false, error: "response lost" })}\n` };
    }
    const proofToken = args[args.indexOf("--expected-proof-token") + 1];
    return { code: 0, stdout: `${JSON.stringify({ schema: "goalport.profile-ops.v1", ok: true, verified: true, recoveryProofToken: proofToken })}\n` };
  };
  const manager = new ProfileManager({ directory: dir, appData: root, build: currentBuild, deps: { execCore } });
  const discovery = { path: source, marker: parseMarkerText(markerV1()), inspection: inspect8() };
  await assert.rejects(manager.runImport(discovery), /journal preserved for resume/);
  const persisted = manager.readJournal();
  assert.equal(persisted.phase, "COPYING");
  assert.equal(existsSync(persisted.stagingDir), true);
  const resumed = await manager.resolve();
  assert.equal(resumed.kind, "resume-import");
  manager.finalizeImport(resumed.journal);
  assert.equal(readFileSync(resolve(dir, "goalport.sqlite"), "utf8"), "verified despite lost response");

  const unsafeRoot = fixture(t), unsafeSource = resolve(unsafeRoot, "source"), unsafeDir = resolve(unsafeRoot, "dev"), outside = resolve(unsafeRoot, "outside");
  mkdirSync(unsafeSource, { recursive: true }); mkdirSync(outside);
  writeFileSync(resolve(unsafeSource, "goalport-profile.json"), markerV1());
  writeFileSync(resolve(unsafeSource, "goalport.sqlite"), "source");
  writeFileSync(resolve(outside, "sentinel.txt"), "keep");
  const unsafeManager = new ProfileManager({ directory: unsafeDir, appData: unsafeRoot, build: currentBuild, deps: { execCore: async (args) => {
    if (args[1] !== "import") throw new Error("unexpected");
    const staging = args[args.indexOf("--staging-dir") + 1];
    rmSync(staging, { recursive: true, force: true });
    symlinkSync(outside, staging, "junction");
    return { code: 3, stdout: `${JSON.stringify({ ok: false, error: "failed" })}\n` };
  } } });
  await assert.rejects(
    unsafeManager.runImport({ path: unsafeSource, marker: parseMarkerText(markerV1()), inspection: inspect8() }),
    /staging/
  );
  assert.equal(readFileSync(resolve(outside, "sentinel.txt"), "utf8"), "keep");
  assert.equal(existsSync(resolve(unsafeDir, "import-journal.json")), true, "unsafe journal is retained for refusal");
});
