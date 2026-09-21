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
  ok: true, exists: true, openable: true, needsRecovery: false, schemaVersion: 8, currentSchemaVersion: 8,
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
  // Journal resume: copying + database already in place, or finalized
  assert.equal(decideOwnProfile({
    markerState: null, dirContentState: { emptyish: false, databasePresent: true }, inspection: { exists: true },
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
