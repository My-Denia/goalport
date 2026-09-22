import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, writeFileSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { browserStateContainedIn, durableStorageEntryAllowed } from "./storage-boundary.mjs";
import vm from "node:vm";
import { pathToFileURL } from "node:url";
function securityContents(extra = {}) {
  const frame = { processId: 1, routingId: 1, detached: false, url: pathToFileURL(resolve("dist/index.html")).href };
  return { mainFrame: frame, getURL: () => frame.url, isDestroyed: () => false, on: () => {}, setWindowOpenHandler: () => {}, ...extra };
}
const trustedEvent = (win) => ({ sender: win.webContents, senderFrame: win.webContents.mainFrame });
const require = createRequire(import.meta.url);
const { launchArguments, relaunchArguments, resolveProfilePaths, assertProfileStorageBoundary, storagePathRelationship, assertCoreIdentity, childEnvironment, normalizedPath } = require("../../electron/launch-config.cjs");
const { invokeCoreRequest, acknowledgedStopSnapshot } = require("../../electron/core-client.cjs");

const hash = "a".repeat(64);
const otherHash = "b".repeat(64);

test("transport preserves reserved rejection and does not confuse a history page with snapshot", async () => {
  const snapshots = [];
  const deps = { ensureCore: () => assert.fail("no automatic retry"), delay: () => assert.fail("no automatic retry"), onResult: (value) => snapshots.push(value) };
  const rejection = { requestId: "intent", accepted: false, snapshot: { activeCampaignId: "reserved" },
    rejection: { deliveryState: "FAILED", nativeDispatchState: "NOT_STARTED", retryMode: "SAME_REQUEST", reservation: { campaignId: "reserved" } } };
  const result = await invokeCoreRequest({ requestId: "intent", messageType: "start_conversation" },
    { ...deps, exchange: async () => ({ requestId: "intent", ok: false, error: "admission refused", payload: rejection }) });
  assert.equal(result.goalportRejected, true);
  assert.deepEqual(result.rejection, rejection.rejection);
  assert.deepEqual(snapshots, [rejection.snapshot]);
  const page = { requestId: "history", accepted: true, historyPage: { ownerId: "reserved", conversationItems: [], pageInfo: {} } };
  assert.deepEqual(await invokeCoreRequest({ requestId: "history", messageType: "history_page" },
    { ...deps, exchange: async () => ({ requestId: "history", ok: true, payload: page }) }), page);
  assert.equal(snapshots.length, 1, "history result must not replace attempt/hold cache");
  await assert.rejects(invokeCoreRequest({ requestId: "intent", messageType: "start_conversation" },
    { ...deps, exchange: async () => ({ requestId: "intent", ok: false, payload: { ...rejection, requestId: "foreign" } }) }), /identity/);
});
function fixture(t) {
  const root = mkdtempSync(resolve(tmpdir(), "goalport-launch-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
const settings = (root, args = {}) => ({ appData: root, coreSha256: hash, args });

test("storage boundary refuses explicit ancestors and real junction overlap or owner escape without writes", (t) => {
  const root = fixture(t);
  const home = resolve(root, "home");
  for (const durable of [home, resolve(home, "GoalPort"), resolve(home, "GoalPort/electron")]) {
    assert.throws(() => resolveProfilePaths(settings(home, { "--data-dir": durable })), /non-overlapping/);
    assert.equal(existsSync(home), false, "refusal precedes mkdir and writable probe");
  }
  const durable = resolve(root, "durable");
  mkdirSync(durable);
  mkdirSync(resolve(home, "GoalPort"), { recursive: true });
  const redirected = resolve(home, "GoalPort/electron");
  symlinkSync(durable, redirected, "junction");
  assert.throws(() => resolveProfilePaths(settings(home, { "--data-dir": durable })), /non-overlapping/);
  assert.deepEqual(readdirSync(durable), []);
  unlinkSync(redirected);
  const outside = resolve(root, "outside");
  mkdirSync(outside);
  symlinkSync(outside, redirected, "junction");
  assert.throws(() => resolveProfilePaths(settings(home, { "--data-dir": durable })), /escapes/);
  assert.equal(browserStateContainedIn({ ownerRoot: home, directory: redirected }), false, "smoke rejects a lexical child junction escaping its physical owner");
  assert.deepEqual(readdirSync(outside), []);
  assert.equal(storagePathRelationship(durable, durable).samePath, true);
  assert.equal(storagePathRelationship(resolve(durable, "child"), durable).durableInsideBrowser, true);
});

test("storage boundary recheck refuses an aliased browser root before session binding", (t) => {
  const root = fixture(t);
  const profile = resolveProfilePaths(settings(root, { "--test-profile": resolve(root, "profile") }));
  mkdirSync(profile.durableDirectory);
  mkdirSync(dirname(profile.browserStateDirectory), { recursive: true });
  symlinkSync(profile.durableDirectory, profile.browserStateDirectory, "junction");
  assert.throws(() => assertProfileStorageBoundary(profile), /non-overlapping/);
  assert.deepEqual(readdirSync(profile.durableDirectory), []);
});

test("synthetic durable junction cannot redefine the test-owned scratch boundary", (t) => {
  const root = fixture(t), scratch = resolve(root, "scratch"), outside = resolve(root, "outside");
  mkdirSync(scratch); mkdirSync(resolve(outside, "profile"), { recursive: true });
  symlinkSync(resolve(outside, "profile"), resolve(scratch, "profile"), "junction");
  assert.throws(() => resolveProfilePaths(settings(root, { "--test-profile": resolve(scratch, "profile") })), /escapes/);
  assert.deepEqual(readdirSync(outside), ["profile"]);
});

test("channel namespaces map to stable directories and never write during path resolution", (t) => {
  const root = fixture(t);
  const release = resolveProfilePaths({ ...settings(root), channel: "release" });
  const devCandidate = resolveProfilePaths({ ...settings(root), channel: "dev-candidate" });
  const dev = resolveProfilePaths({ ...settings(root), channel: "dev" });
  const realRoot = realpathSync.native(root);
  assert.equal(release.directory, resolve(realRoot, "GoalPort/rc"));
  assert.equal(devCandidate.directory, resolve(realRoot, "GoalPort/dev"));
  assert.equal(dev.directory, resolve(realRoot, "GoalPort/dev"));
  assert.equal(release.channel, "release");
  assert.equal(devCandidate.channel, "dev-candidate");
  // Path resolution is pure: nothing exists yet, no marker, no directory.
  assert.equal(existsSync(resolve(root, "GoalPort")), false);
});

test("a differently-built candidate shares the dev namespace instead of refusing it", (t) => {
  const root = fixture(t);
  const first = resolveProfilePaths({ ...settings(root), channel: "dev-candidate" });
  const second = resolveProfilePaths({ ...settings(root), channel: "dev-candidate", coreSha256: otherHash });
  assert.equal(second.directory, first.directory);
  assert.equal(second.profileKey, first.profileKey);
  assert.notEqual(second.pipe, first.pipe, "per-build pipe keeps runtime identity distinct");
  assert.equal(second.testMode, false);
});

// ---------- Storage-boundary path model ----------

test("path model: the default release profile splits the durable root from the browser-state namespace", (t) => {
  const root = fixture(t);
  // CI runners hand out 8.3-short-name temp paths (C:\Users\RUNNER~1\...):
  // canonicalPath expands them, so every expectation is built on the
  // expanded root — the same pattern as the channel test above.
  const realRoot = realpathSync.native(root);
  const release = resolveProfilePaths({ ...settings(realRoot), channel: "release" });
  assert.equal(release.durableDirectory, resolve(realRoot, "GoalPort", "rc"));
  assert.equal(release.browserStateDirectory, resolve(realRoot, "GoalPort", "electron", release.profileKey));
  assert.notEqual(normalizedPath(release.durableDirectory), normalizedPath(release.browserStateDirectory), "durable and browser roots are distinct paths");
  assert.equal(release.browserStateDirectory.endsWith(release.profileKey), true, "the browser identity is keyed by the durable profileKey");
  assert.equal(existsSync(release.browserStateDirectory), false, "path resolution stays pure: no directory is created");
});

test("path model: the default dev profile splits durable and browser roots, distinguished by profileKey", (t) => {
  const root = fixture(t);
  const realRoot = realpathSync.native(root);
  const dev = resolveProfilePaths({ ...settings(realRoot), channel: "dev" });
  const devCandidate = resolveProfilePaths({ ...settings(realRoot), channel: "dev-candidate" });
  const release = resolveProfilePaths({ ...settings(realRoot), channel: "release" });
  assert.equal(dev.durableDirectory, resolve(realRoot, "GoalPort", "dev"));
  assert.equal(devCandidate.durableDirectory, resolve(realRoot, "GoalPort", "dev"));
  for (const paths of [dev, devCandidate, release]) {
    assert.notEqual(normalizedPath(paths.durableDirectory), normalizedPath(paths.browserStateDirectory), "durable and browser roots are distinct paths");
    assert.equal(paths.browserStateDirectory, resolve(realRoot, "GoalPort", "electron", paths.profileKey));
  }
  // dev and dev-candidate deliberately share the dev namespace (same durable
  // root, same browser identity); release is a different durable root and
  // therefore a different browser identity.
  assert.equal(devCandidate.browserStateDirectory, dev.browserStateDirectory, "dev candidates reuse the dev browser identity");
  assert.notEqual(release.browserStateDirectory, dev.browserStateDirectory, "browser identities follow their durable profileKeys");
  assert.notEqual(release.profileKey, dev.profileKey);
});

test("path model: a differently-built candidate keeps the SAME browser-state identity across Core hashes", (t) => {
  const root = fixture(t);
  const first = resolveProfilePaths({ ...settings(root), channel: "dev-candidate" });
  const second = resolveProfilePaths({ ...settings(root), channel: "dev-candidate", coreSha256: otherHash });
  assert.equal(second.durableDirectory, first.durableDirectory);
  assert.equal(second.profileKey, first.profileKey);
  assert.equal(second.browserStateDirectory, first.browserStateDirectory, "a Core hash change must not fork the browser profile identity");
  assert.notEqual(second.pipe, first.pipe, "the runtime pipe stays per-build");
});

test("path model: --data-dir owns ONLY the durable location; the browser namespace never lands inside it", (t) => {
  const root = fixture(t);
  const explicit = resolve(root, "explicit-data");
  const paths = resolveProfilePaths({ ...settings(root, { "--data-dir": explicit }), channel: "release" });
  assert.equal(paths.durableDirectory, resolve(realpathSync.native(root), "explicit-data"), "the durable root is exactly the user's explicit path");
  assert.notEqual(normalizedPath(paths.durableDirectory), normalizedPath(paths.browserStateDirectory));
  assert.equal(paths.browserStateDirectory, resolve(realpathSync.native(root), "GoalPort", "electron", paths.profileKey));
  const rel = relative(paths.durableDirectory, paths.browserStateDirectory);
  assert.ok(rel.startsWith("..") || isAbsolute(rel), "backing up the --data-dir can never capture Chromium state");
});

test("path model: a synthetic --test-profile keeps browser state inside the test-owned scratch", (t) => {
  const root = fixture(t);
  const realRoot = realpathSync.native(root); // CI temp roots may be 8.3 short names; canonicalPath expands them
  const first = resolveProfilePaths({ ...settings(realRoot, { "--test-profile": resolve(realRoot, "t1", "profile") }) });
  assert.equal(first.browserStateDirectory, resolve(realRoot, "t1", "electron", first.profileKey), "browser state is a sibling of the synthetic durable root");
  assert.notEqual(normalizedPath(first.browserStateDirectory), normalizedPath(first.durableDirectory));
  const firstRel = relative(resolve(realRoot, "t1"), first.browserStateDirectory);
  assert.ok(!firstRel.startsWith("..") && !isAbsolute(firstRel), "browser state stays inside the test-owned root");
  const elsewhere = resolveProfilePaths({ ...settings(resolve(realRoot, "elsewhere"), { "--test-profile": resolve(realRoot, "t1", "profile") }) });
  assert.equal(elsewhere.browserStateDirectory, first.browserStateDirectory, "the synthetic browser root ignores the appData location entirely");
  const second = resolveProfilePaths({ ...settings(realRoot, { "--test-profile": resolve(realRoot, "t2", "profile") }) });
  assert.notEqual(first.browserStateDirectory, second.browserStateDirectory, "concurrent tests get distinct browser identities");
});

test("relaunchArguments replaces the exclusive profile location and keeps every other switch", () => {
  assert.deepEqual(relaunchArguments(["--data-dir", "C:/old", "--user-data-dir=D:/p"], "C:/new"), ["--user-data-dir=D:/p", "--data-dir", "C:/new"]);
  assert.deepEqual(relaunchArguments(["--test-profile", "C:/t", "--remote-debugging-port=9222"], "C:/new"), ["--remote-debugging-port=9222", "--data-dir", "C:/new"]);
  assert.deepEqual(relaunchArguments(["--user-data-dir=D:/p"], "C:/new"), ["--user-data-dir=D:/p", "--data-dir", "C:/new"]);
  assert.deepEqual(relaunchArguments(["--data-dir=C:/eqold", "--", "positional"], "C:/new"), ["positional", "--data-dir", "C:/new"]);
});

test("explicit normal and synthetic profile paths keep precedence over channels", (t) => {
  const root = fixture(t);
  const args = { "--data-dir": resolve(root, "explicit") };
  assert.deepEqual(resolveProfilePaths({ ...settings(root, args), channel: "release" }), resolveProfilePaths({ ...settings(root, args), channel: "dev-candidate" }));
  const synthetic = resolveProfilePaths({ ...settings(root, { "--test-profile": resolve(root, "synthetic") }), channel: "dev-candidate" });
  assert.equal(synthetic.testMode, true);
  assert.equal(synthetic.channel, null);
  assert.notEqual(resolveProfilePaths({ ...settings(root, args), channel: "release" }).pipe, synthetic.pipe);
});

test("real Electron entrypoint no longer dies pre-ready on an existing foreign-build marker", (t) => {
  const root = fixture(t);
  const mainFile = resolve("electron/main.cjs");
  const mainRequire = createRequire(mainFile);
  const main = vm.runInThisContext(`(function(require,module,exports,__dirname,process,console){${readFileSync(mainFile, "utf8")}\n})`, { filename: mainFile });
  const data = resolve(root, "profile");
  // The application-data root must be a SEPARATE directory from the durable
  // profile: under the storage-boundary split the browser-state namespace
  // (<appData>/GoalPort/electron/<key>) is created pre-ready, and the durable
  // root must stay byte-identical through it.
  const appData = resolve(root, "appdata");
  mkdirSync(data, { recursive: true });
  writeFileSync(resolve(data, "goalport-profile.json"), JSON.stringify({ schemaVersion: 1, product: "GoalPort", mode: "normal", identityVersion: 2, profileKey: "x".repeat(20), version: "1.0.0-rc.1", coreSha256: otherHash }));
  const preimage = readdirSync(data).map((name) => [name, readFileSync(resolve(data, name), "utf8")]);
  const resources = resolve(root, "resources");
  mkdirSync(resources, { recursive: true });
  writeFileSync(resolve(resources, "goalport-core.exe"), "test-only Core identity; never executed");
  const dialogs = [], exits = [], logs = [];
  let readySubscribers = [];
  const electron = {
    app: {
      isPackaged: true, getVersion: () => "1.0.0-rc.1", getPath: () => appData, exit: (code) => exits.push(code),
      setPath: () => {}, setAppUserModelId: () => {}, requestSingleInstanceLock: () => true, on: () => {},
      whenReady: () => new Promise(() => { /* fixture keeps the ready boundary pending forever */ })
    },
    dialog: { showErrorBox: (title, message) => dialogs.push({ title, message }) }
  };
  main((name) => name === "electron" ? electron : mainRequire(name), { exports: {} }, {}, resolve("electron"), {
    argv: ["GoalPort.exe", "--data-dir", data], resourcesPath: resources, env: { GOALPORT_CORE_BIN: resolve(resources, "goalport-core.exe") }
  }, { error: (...args) => logs.push(args.map(String).join(" ")) });
  assert.deepEqual(exits, [], "the historical 'another RC build' pre-ready death is gone");
  assert.equal(dialogs.length, 0);
  assert.deepEqual(readdirSync(data).map((name) => [name, readFileSync(resolve(data, name), "utf8")]), preimage);
  assert.equal(existsSync(resolve(appData, "GoalPort", "electron")), true, "the pre-ready write-probe targets the browser-state namespace");
});

test("real Electron entrypoint still refuses truly invalid launch input pre-ready", (t) => {
  const root = fixture(t);
  const mainFile = resolve("electron/main.cjs");
  const mainRequire = createRequire(mainFile);
  const main = vm.runInThisContext(`(function(require,module,exports,__dirname,process,console){${readFileSync(mainFile, "utf8")}\n})`, { filename: mainFile });
  const resources = resolve(root, "resources");
  mkdirSync(resources, { recursive: true });
  writeFileSync(resolve(resources, "goalport-core.exe"), "test-only Core identity; never executed");
  const dialogs = [], exits = [];
  const electron = {
    app: { isPackaged: true, getVersion: () => "1.0.0-rc.1", getPath: () => root, exit: (code) => exits.push(code), whenReady: () => assert.fail("refusal cannot start the ready path") },
    dialog: { showErrorBox: (title, message) => dialogs.push({ title, message }) }
  };
  main((name) => name === "electron" ? electron : mainRequire(name), { exports: {} }, {}, resolve("electron"), {
    argv: ["GoalPort.exe", "--data-dir", "relative"], resourcesPath: resources, env: {}
  }, { error: () => {} });
  assert.deepEqual(exits, [1]);
  assert.match(dialogs[0].message, /absolute path/);
  // Explicit durable root containing the browser namespace must fail before
  // mkdir, session binding, readiness, profile inspection or a Core launch.
  main((name) => name === "electron" ? electron : mainRequire(name), { exports: {} }, {}, resolve("electron"), {
    argv: ["GoalPort.exe", "--data-dir", root], resourcesPath: resources, env: {}
  }, { error: () => {} });
  assert.deepEqual(exits, [1, 1]);
  assert.match(dialogs[1].message, /non-overlapping/);
  assert.equal(existsSync(resolve(root, "GoalPort")), false);
});

test("the actual Electron entrypoint passes its packaged state to channel selection", (t) => {
  const root = fixture(t);
  const mainFile = resolve("electron/main.cjs");
  const mainRequire = createRequire(mainFile);
  const main = vm.runInThisContext(`(function(require,module,exports,__dirname,process,console){${readFileSync(mainFile, "utf8")}\n})`, { filename: mainFile });
  writeFileSync(resolve(root, "goalport-core.exe"), "inert identity fixture, never executed");
  for (const isPackaged of [false, true]) {
    let seen;
    const electron = { app: { isPackaged, getVersion: () => "1.0.0-rc.1", getPath: () => root, exit: () => {}, whenReady: () => assert.fail("fixture stops before readiness") }, dialog: { showErrorBox: () => {} } };
    main((name) => name === "electron" ? electron : name === "./launch-config.cjs" ? {
      ...mainRequire(name), resolveProfilePaths: (options) => { seen = options; throw new Error("fixture stops after path capture"); }
    } : mainRequire(name), { exports: {} }, {}, resolve("electron"), { argv: ["Electron.exe"], resourcesPath: root, env: { GOALPORT_CORE_BIN: resolve(root, "goalport-core.exe") } }, { error: () => {} });
    assert.equal(seen?.coreSha256.length, 64);
  }
});

test("the --user-data-dir switch relocates the application-data root before profile selection", (t) => {
  const root = fixture(t);
  // CI temp roots can be 8.3 short names; canonicalPath expands them, so the
  // expectations below are built on the expanded spelling.
  const home = resolve(realpathSync.native(root), "relocated-home");
  const mainFile = resolve("electron/main.cjs");
  const mainRequire = createRequire(mainFile);
  const main = vm.runInThisContext(`(function(require,module,exports,__dirname,process,console){${readFileSync(mainFile, "utf8")}
})`, { filename: mainFile });
  mkdirSync(resolve(root, "resources"), { recursive: true });
  writeFileSync(resolve(root, "resources", "goalport-core.exe"), "inert identity fixture, never executed");
  let seenPath;
  const setPathCalls = [];
  const dialogs = [];
  const electron = {
    app: {
      isPackaged: true, getVersion: () => "1.0.0-rc.1",
      getPath: (name) => { seenPath = name; return resolve(root, "real-appData"); },
      setPath: (name, value) => {
        setPathCalls.push([name, value]);
        if (name === "userData") throw new Error("fixture stops after userData setPath");
      },
      exit: () => {}, whenReady: () => assert.fail("fixture stops before readiness"),
      commandLine: { appendSwitch: () => {} }, setAppUserModelId: () => {}, requestSingleInstanceLock: () => true, on: () => {}
    },
    dialog: { showErrorBox: (title, message) => dialogs.push(String(message)) }
  };
  const realResolveProfilePaths = mainRequire("./launch-config.cjs").resolveProfilePaths;
  let captured;
  const fakeRequire = (name) => name === "electron" ? electron : name === "./launch-config.cjs" ? {
    ...mainRequire(name), resolveProfilePaths: (options) => { captured = options; return realResolveProfilePaths(options); }
  } : mainRequire(name);
  main(fakeRequire, { exports: {} }, {}, resolve("electron"), {
    argv: ["GoalPort.exe", `--user-data-dir=${home}`], resourcesPath: resolve(root, "resources"),
    env: { GOALPORT_CORE_BIN: resolve(root, "resources", "goalport-core.exe") }
  }, { error: () => {} });
  assert.equal(captured.appData, home, "profile selection runs inside the relocated root");
  assert.equal(seenPath, "appData");
  // Storage boundary inside the relocation: the durable root stays the channel
  // directory inside the relocated root, and app.setPath(userData) targets the
  // SEPARATE electron namespace — overriding whatever the native Chromium
  // switch would have picked on its own. (The fixture sentinel stops the entry
  // point right after the userData setPath, inside the pre-ready try block.)
  const model = realResolveProfilePaths({ args: {}, appData: home, channel: "release", coreSha256: "a".repeat(64) });
  assert.equal(model.durableDirectory, resolve(home, "GoalPort", "rc"));
  const userDataSet = setPathCalls.filter(([name]) => name === "userData");
  assert.equal(userDataSet.length, 1, `exactly one userData setPath; saw ${JSON.stringify(setPathCalls)}`);
  assert.equal(userDataSet[0][1], resolve(home, "GoalPort", "electron", model.profileKey));
  assert.notEqual(normalizedPath(userDataSet[0][1]), normalizedPath(model.durableDirectory));
  assert.match(dialogs.join(" "), /fixture stops after userData setPath/);
});

test("distinct canonical profile identities cannot share a pipe or accept another database", () => {
  const root = resolve("canonical-profile-fixture");
  const a = resolveProfilePaths({ ...settings(root, { "--data-dir": resolve(root, "Foo") }) });
  const b = resolveProfilePaths({ ...settings(root, { "--data-dir": resolve(root, "foo") }) });
  assert.notEqual(a.pipe, b.pipe);
  assert.notEqual(a.profileKey, b.profileKey);
  assert.doesNotThrow(() => assertCoreIdentity({ startupState: "READY_COMMITTED", core: { executableSha256: hash }, databaseIdentity: a.database, pipeIdentity: a.pipe }, a));
  assert.throws(() => assertCoreIdentity({ startupState: "READY_COMMITTED", core: { executableSha256: hash }, databaseIdentity: a.database, pipeIdentity: b.pipe }, b), /attachment refused/);
});

test("attachment requires committed startup receipt, matching database, pipe and Core hash", (t) => {
  const root = fixture(t);
  const profile = resolveProfilePaths({ ...settings(root), channel: "release" });
  const receipt = { startupState: "READY_COMMITTED", core: { executableSha256: hash }, databaseIdentity: profile.database, pipeIdentity: profile.pipe };
  assert.doesNotThrow(() => assertCoreIdentity(receipt, profile));
  for (const wrong of [
    { ...receipt, startupState: "STARTUP_PENDING" }, { ...receipt, core: { executableSha256: otherHash } },
    { ...receipt, databaseIdentity: resolve(root, "old.sqlite") }, { ...receipt, pipeIdentity: "\\\\.\\pipe\\goalport-core-v1" }
  ]) assert.throws(() => assertCoreIdentity(wrong, profile), /attachment refused/);
});

test("normal environment ignores historical test identity while native configuration remains owned", (t) => {
  const profile = resolveProfilePaths({ ...settings(fixture(t)), channel: "release" });
  const env = { GOALPORT_REQUIRE_ISOLATED: "1", GOALPORT_CORE_DB: "old.sqlite", GOALPORT_CORE_PIPE: "old", GOALPORT_SYNTHETIC_ROOT: "old", GOALPORT_CLAUDE_FIXTURE_INTERPRETER: "old.exe", GOALPORT_TEST_SYNTHETIC_ONLY: "1", GOALPORT_CODEX_APPROVAL_POLICY: "on-request", USERPROFILE: "native-owned" };
  const clean = childEnvironment(env, profile);
  assert.equal(clean.GOALPORT_REQUIRE_ISOLATED, undefined);
  assert.equal(clean.GOALPORT_CORE_DB, undefined);
  assert.equal(clean.GOALPORT_SYNTHETIC_ROOT, undefined);
  assert.equal(clean.GOALPORT_TEST_SYNTHETIC_ONLY, undefined);
  assert.equal(clean.GOALPORT_CLAUDE_FIXTURE_INTERPRETER, undefined);
  assert.equal(clean.GOALPORT_CODEX_APPROVAL_POLICY, "on-request");
  assert.equal(clean.USERPROFILE, "native-owned");
  const testEnv = childEnvironment(env, { ...profile, testMode: true });
  assert.equal(testEnv.GOALPORT_REQUIRE_ISOLATED, "1");
  assert.equal(testEnv.GOALPORT_TEST_SYNTHETIC_ONLY, "1");
  assert.equal(testEnv.GOALPORT_SYNTHETIC_ROOT, undefined);
});

test("profile arguments require explicit absolute paths and cannot mix modes", () => {
  assert.throws(() => launchArguments(["--data-dir", "relative"]), /absolute/);
  assert.throws(() => launchArguments(["--test-profile"]), /Missing/);
  assert.throws(() => launchArguments(["--data-dir", resolve("a"), "--test-profile", resolve("b")]), /cannot be combined/);
});

test("Windows aliases share identity even for an absent database descendant", { skip: process.platform !== "win32" }, () => {
  const alias = "C:/PROGRA~1";
  assert.ok(existsSync(alias), "Windows short-name fixture must exist; never create files there");
  const canonical = realpathSync.native(alias);
  const child = `goalport-no-write-${process.pid}-${Date.now()}/goalport.sqlite`;
  const database = resolve(alias, child);
  assert.equal(existsSync(database), false);
  assert.equal(normalizedPath(alias), normalizedPath(canonical));
  assert.equal(normalizedPath(database), normalizedPath(resolve(canonical, child)));
  const profile = { database, coreSha256: hash, pipe: "test-pipe" };
  assert.doesNotThrow(() => assertCoreIdentity({ startupState: "READY_COMMITTED", core: { executableSha256: hash }, databaseIdentity: resolve(canonical, child), pipeIdentity: profile.pipe }, profile));
  assert.throws(() => assertCoreIdentity({ startupState: "READY_COMMITTED", core: { executableSha256: hash }, databaseIdentity: resolve(canonical, child + "-other"), pipeIdentity: profile.pipe }, profile), /attachment refused/);
  assert.equal(existsSync(database), false);
  // Path-model identity: two spellings of the SAME durable directory (8.3
  // alias vs canonical) export the identical durable canonical path,
  // profileKey and browser-state identity. Pure path computation; nothing is
  // created under the read-only alias location.
  const appData = resolve(tmpdir(), `goalport-alias-appdata-${process.pid}-${Date.now()}`);
  const aliased = resolveProfilePaths({ appData, coreSha256: hash, args: { "--data-dir": resolve(alias, child).replace(/goalport\.sqlite$/, "") } });
  const spelled = resolveProfilePaths({ appData, coreSha256: hash, args: { "--data-dir": resolve(canonical, child).replace(/goalport\.sqlite$/, "") } });
  assert.equal(aliased.durableDirectory, spelled.durableDirectory);
  assert.equal(aliased.profileKey, spelled.profileKey);
  assert.equal(aliased.browserStateDirectory, spelled.browserStateDirectory);
  assert.equal(aliased.pipe, spelled.pipe);
  // App-data itself can also arrive through an 8.3 alias (CI's RUNNER~1).
  // Browser paths, like durable paths, are now canonical physical paths.
  const shortAppData = resolve(alias, `goalport-no-write-appdata-${process.pid}-${Date.now()}`);
  const normal = resolveProfilePaths({ appData: shortAppData, coreSha256: hash, args: { "--data-dir": appData } });
  assert.equal(normal.browserStateDirectory, resolve(realpathSync.native(alias), shortAppData.slice(resolve(alias).length + 1), "GoalPort", "electron", normal.profileKey));
  assert.notEqual(normal.browserStateDirectory, resolve(shortAppData, "GoalPort", "electron", normal.profileKey), "literal short-name expectation reproduces the CI60 assertion bug");
  assert.equal(browserStateContainedIn({ ownerRoot: shortAppData, directory: normal.browserStateDirectory }), true, "normal smoke accepts an 8.3 app-data owner and canonical browser path (CI61)");
  assert.equal(browserStateContainedIn({ ownerRoot: normal.browserStateOwnerDirectory, directory: normal.browserStateDirectory }), true);
  assert.equal(existsSync(shortAppData), false, "pure alias check never creates app-data");
  // Synthetic browser-state containment is derived from the CANONICAL durable
  // parent, never from the literal spelling. On a machine whose temp root is
  // an 8.3 alias (the GitHub runner's RUNNER~1 TEMP), a literal prefix
  // comparison would fail even though the browser root is exactly where the
  // central path model puts it (the run-57 synthetic smoke failure).
  const aliasedSynthetic = resolveProfilePaths({ appData, coreSha256: hash, args: { "--test-profile": resolve(alias, child).replace(/goalport\.sqlite$/, "") } });
  const canonicalParent = dirname(aliasedSynthetic.durableDirectory);
  assert.ok(canonicalParent.toLowerCase().startsWith(canonical.toLowerCase()), "the synthetic browser owner root is the canonical durable parent");
  const browserRel = relative(canonicalParent, aliasedSynthetic.browserStateDirectory);
  assert.ok(browserRel !== "" && !browserRel.startsWith("..") && !isAbsolute(browserRel), `browser state stays inside the canonical scratch root (relative=${browserRel})`);
  const literalRel = relative(dirname(resolve(alias, child).replace(/goalport\.sqlite$/, "")), aliasedSynthetic.browserStateDirectory);
  assert.ok(literalRel.startsWith("..") || isAbsolute(literalRel) || literalRel === "", "the LITERAL alias spelling does NOT match the canonical browser root on an aliased machine");
});

test("a lost mutation acknowledgement does not retry or launch another Core", async () => {
  for (const messageType of ["send_message", "select_runtime", "create_campaign", "continue_in_isolated_workspace"]) {
    let exchanges = 0;
    await assert.rejects(invokeCoreRequest({ messageType, requestId: "same-request" }, {
      exchange: async () => { exchanges += 1; throw new Error("connection closed"); },
      ensureCore: () => assert.fail("must not restart/retry a mutation"), delay: () => assert.fail("must not retry")
    }), /connection closed/);
    assert.equal(exchanges, 1);
  }
});

test("Core rejection stays a refusal and an accepted command retains request/duplicate identity", async () => {
  const request = { messageType: "send_message", requestId: "send-1" };
  const rejected = await invokeCoreRequest(request, { exchange: async () => ({ ok: false, requestId: request.requestId, error: "held" }) });
  assert.deepEqual(rejected, { goalportRejected: true, requestId: "send-1", error: "held" });
  const accepted = { requestId: "send-1", accepted: true, duplicate: true, snapshot: { cursor: 2 } };
  assert.deepEqual(await invokeCoreRequest(request, { exchange: async () => ({ ok: true, requestId: request.requestId, payload: accepted }) }), accepted);
  await assert.rejects(invokeCoreRequest(request, { exchange: async () => ({ ok: true, requestId: request.requestId, payload: { ...accepted, requestId: "other" } }) }), /matching command acknowledgement/);
  for (const staleId of [undefined, "another-request"]) {
    await assert.rejects(invokeCoreRequest(request, { exchange: async () => ({ ok: false, requestId: staleId, error: "held" }) }), /response identity/);
    await assert.rejects(invokeCoreRequest(request, { exchange: async () => ({ ok: true, requestId: staleId, payload: accepted }) }), /response identity/);
  }
});

test("snapshot retry rechecks attachment once and never retries a tagged refusal", async () => {
  let calls = 0, checks = 0;
  await assert.rejects(invokeCoreRequest({ messageType: "snapshot", requestId: "read-1" }, {
    exchange: async () => { if (++calls === 1) throw new Error("closed"); return { ok: false, requestId: "read-1", error: "wrong state" }; },
    ensureCore: async () => { checks += 1; }, delay: async () => {}
  }), /wrong state/);
  assert.equal(calls, 2);
  assert.equal(checks, 1);
});

test("a refused snapshot keeps the active held cache and never retries or notifies", async () => {
  const previous = { attempt: { id: "held-attempt", state: "active" }, stopResponsibility: { writeResponsibility: "held", attemptId: "held-attempt" } };
  let cache = previous, calls = 0;
  await assert.rejects((async () => {
    const snapshot = await invokeCoreRequest({ messageType: "snapshot", requestId: "read-refused" }, {
      exchange: async () => { calls += 1; return { ok: false, requestId: "read-refused", error: "snapshot refused" }; },
      ensureCore: () => assert.fail("a definite refusal must not retry attachment"),
      delay: () => assert.fail("a definite refusal must not retry"),
      onResult: () => assert.fail("refused data must not update the cache or notifications")
    });
    cache = snapshot;
  })(), /snapshot refused/);
  assert.equal(calls, 1);
  assert.equal(cache, previous);
});

test("close Stop consumes the acknowledged snapshot and requires the existing durable hold", async () => {
  const snapshot = { attempt: { id: "held-attempt" }, stopResponsibility: { attemptId: "held-attempt", writeResponsibility: "held" } };
  const ack = { requestId: "stop-1", accepted: true, duplicate: false, snapshot };
  assert.equal(acknowledgedStopSnapshot(ack, "stop-1", true), snapshot);
  assert.throws(() => acknowledgedStopSnapshot({ ...ack, snapshot: { attempt: snapshot.attempt } }, "stop-1", true), /durable-stop-hold-missing/);
  assert.throws(() => acknowledgedStopSnapshot({ ...ack, requestId: "other" }, "stop-1", true), /acknowledgement identity/);
  assert.throws(() => acknowledgedStopSnapshot({ goalportRejected: true, error: "denied" }, "stop-1", true), /denied/);
  assert.doesNotThrow(() => acknowledgedStopSnapshot({ ...ack, snapshot: { attempt: { state: "failed" } } }, "stop-1", false));
});

const { assertPipePeer, pipePeerBusy, PIPE_PEER_REFUSAL } = require("../../electron/launch-config.cjs");
const { verifyCoreServer, createCoreGate, VERIFY_DEADLINE_MS, SERVER_REFUSAL } = require("../../electron/core-client.cjs");
const peerLine = (value) => `${JSON.stringify(value)}\n`;
const okPeer = (pid) => peerLine({ schema: "goalport.pipe-peer.v1", ok: true, serverPid: pid });
const busyPeer = peerLine({ schema: "goalport.pipe-peer.v1", ok: false, stage: "busy", code: 231 });

test("pipe-peer assertion requires the exact single-line contract and the receipt Core PID", () => {
  assert.equal(PIPE_PEER_REFUSAL, SERVER_REFUSAL);
  const receipt = { core: { pid: 4242 } };
  assert.deepEqual(assertPipePeer(okPeer(4242), receipt), { schema: "goalport.pipe-peer.v1", ok: true, serverPid: 4242 });
  assert.doesNotThrow(() => assertPipePeer(okPeer(4242).replace("\n", "\r\n"), receipt));
  for (const stdout of [
    peerLine({ schema: "goalport.pipe-peer.v1", ok: false, stage: "dacl", code: 1338 }),
    undefined, "", "not json\n",
    peerLine({ schema: "goalport.pipe-peer.v2", ok: true, serverPid: 4242 }),
    okPeer(4243),
    okPeer(4242) + okPeer(4242),
    `noise\n${okPeer(4242)}`,
    peerLine({ schema: "goalport.pipe-peer.v1", ok: true, serverPid: "4242" })
  ]) {
    assert.throws(() => assertPipePeer(stdout, receipt), (error) => error.message === PIPE_PEER_REFUSAL, String(stdout));
  }
  assert.throws(() => assertPipePeer(okPeer(4242), {}), /could not be verified/);
  assert.equal(pipePeerBusy(busyPeer), true);
  assert.equal(pipePeerBusy(okPeer(1)), false);
});

function gateFixture({ peers = [], failNext = new Set(), receiptPid = 4242 } = {}) {
  const log = [];
  let clock = 0;
  const now = () => clock;
  const delay = async (ms) => { clock += ms; };
  const runPeer = async () => {
    log.push("peer");
    const next = peers.length ? peers.shift() : { code: 0, stdout: okPeer(receiptPid) };
    clock += next.elapsed ?? 30;
    return next;
  };
  const exchange = async (request, options) => {
    log.push(request.messageType);
    if (failNext.has(request.messageType)) {
      failNext.delete(request.messageType);
      throw new Error(request.failWith || "Core connection closed before acknowledgement");
    }
    if (request.messageType === "get_startup_receipt") {
      assert.ok(options.timeoutMs > 0 && options.timeoutMs <= VERIFY_DEADLINE_MS);
      return { receipt: { core: { pid: receiptPid } } };
    }
    return { ok: true, requestId: request.requestId };
  };
  const verify = () => verifyCoreServer({
    runPeer, isBusy: pipePeerBusy, now, delay,
    requestReceipt: async (timeoutMs) => (await exchange({ messageType: "get_startup_receipt" }, { timeoutMs })).receipt,
    assertPeer: (stdout, receipt) => assertPipePeer(stdout, receipt)
  });
  const gate = createCoreGate({ verify });
  return { log, gate, send: (request) => gate.send(request, exchange), now, failNext };
}

test("the request gate verifies every non-snapshot request before sending it", async () => {
  for (const messageType of ["send_message", "record_close_choice", "safe_stop"]) {
    const fixture = gateFixture();
    await fixture.send({ messageType, requestId: messageType });
    assert.deepEqual(fixture.log, ["peer", "get_startup_receipt", messageType]);
  }
});

test("a snapshot is re-verified only after a transport failure, a timeout or a refused verification", async () => {
  const fixture = gateFixture();
  await fixture.send({ messageType: "snapshot", requestId: "s1" });
  assert.deepEqual(fixture.log, ["snapshot"], "no prior failure: no peer run");
  for (const failWith of ["Core connection closed before acknowledgement", "Core IPC response timed out after 120 seconds"]) {
    fixture.log.length = 0;
    fixture.failNext.add("snapshot");
    await assert.rejects(fixture.send({ messageType: "snapshot", requestId: "s2", failWith }), new RegExp(failWith));
    await fixture.send({ messageType: "snapshot", requestId: "s3" });
    await fixture.send({ messageType: "snapshot", requestId: "s4" });
    assert.deepEqual(fixture.log, ["snapshot", "peer", "get_startup_receipt", "snapshot", "snapshot"]);
  }
  const refused = gateFixture({ peers: [{ code: 3, stdout: peerLine({ schema: "goalport.pipe-peer.v1", ok: false, stage: "server-user", code: 5 }) }] });
  await assert.rejects(refused.send({ messageType: "send_message", requestId: "m1" }), /could not be verified/);
  await refused.send({ messageType: "snapshot", requestId: "s5" });
  assert.deepEqual(refused.log, ["peer", "peer", "get_startup_receipt", "snapshot"]);
});

test("a request waiting on a verification re-verifies when a transport failure happened while it was in flight", async () => {
  const log = [];
  const pending = [];
  const tick = () => new Promise((done) => setImmediate(done));
  const gate = createCoreGate({
    verify: () => new Promise((resolveVerify) => { log.push(`verify${pending.length + 1}`); pending.push(resolveVerify); })
  });
  const transport = async (request) => {
    log.push(`transport:${request.messageType}`);
    if (request.fail) throw new Error("Core connection closed before acknowledgement");
    return { ok: true };
  };
  const mutation = gate.send({ messageType: "send_message", requestId: "m" }, transport);
  await tick();
  assert.deepEqual(log, ["verify1"], "verification #1 is in flight");
  await assert.rejects(gate.send({ messageType: "snapshot", requestId: "s", fail: true }, transport), /closed before acknowledgement/);
  assert.deepEqual(log, ["verify1", "transport:snapshot"]);
  pending[0]();
  for (let index = 0; index < 5 && pending.length < 2; index += 1) await tick();
  assert.deepEqual(log, ["verify1", "transport:snapshot", "verify2"], "the waiting request must not reach transport on verification #1");
  pending[1]();
  await mutation;
  assert.deepEqual(log, ["verify1", "transport:snapshot", "verify2", "transport:send_message"]);
  assert.equal(gate.needsVerification(), false);
});

// Virtual clock with injectable timers for the request gate deadline.
function virtualGate() {
  let clock = 0, nextId = 1;
  const timers = new Map(), verifications = [], transports = [], unhandled = [];
  const flush = async () => { for (let index = 0; index < 20; index += 1) await new Promise((done) => setImmediate(done)); };
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  const gate = createCoreGate({
    verify: () => new Promise((resolveVerify, rejectVerify) => verifications.push({ resolve: resolveVerify, reject: rejectVerify, startedAt: clock })),
    now: () => clock,
    setTimer: (callback, ms) => { const id = nextId++; timers.set(id, { at: clock + Math.max(0, ms), callback }); return id; },
    clearTimer: (id) => { timers.delete(id); }
  });
  const transport = async (request) => {
    transports.push({ messageType: request.messageType, at: clock });
    if (request.fail) throw new Error("Core IPC response timed out after 120 seconds");
    return { ok: true, requestId: request.requestId };
  };
  const issue = (messageType, extra = {}) => {
    const outcome = { enteredAt: clock };
    outcome.promise = gate.send({ messageType, requestId: messageType, ...extra }, transport).then(
      () => { outcome.sentAt = clock; },
      (error) => { outcome.refusedAt = clock; outcome.error = error.message; }
    );
    return outcome;
  };
  const advanceTo = async (target) => {
    await flush();
    while (true) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((left, right) => left[1].at - right[1].at)[0];
      if (!due) break;
      clock = due[1].at;
      timers.delete(due[0]);
      due[1].callback();
      await flush();
    }
    clock = target;
    await flush();
  };
  const dispose = () => process.off("unhandledRejection", onUnhandled);
  return { gate, issue, advanceTo, flush, verifications, transports, timers, unhandled, dispose, now: () => clock };
}

test("a failure during check 1 and a long check 2 refuse the waiting command within 120 s of its entry", async () => {
  const v = virtualGate();
  try {
    const stop = v.issue("safe_stop");
    await v.advanceTo(10);
    assert.equal(v.verifications.length, 1, "check 1 in flight");
    const poll = v.issue("snapshot", { fail: true });
    await v.advanceTo(20);
    assert.equal(poll.error, "Core IPC response timed out after 120 seconds");
    await v.advanceTo(100_000);
    v.verifications[0].resolve();
    await v.advanceTo(100_010);
    assert.equal(v.verifications.length, 2, "the failure during check 1 requires check 2");
    await v.advanceTo(120_000);
    assert.equal(stop.error, SERVER_REFUSAL, `command must be refused by 120 000 ms; outcome=${JSON.stringify(stop)}`);
    assert.ok(stop.refusedAt - stop.enteredAt <= VERIFY_DEADLINE_MS, `refused at ${stop.refusedAt}`);
    assert.deepEqual(v.transports.map((entry) => entry.messageType), ["snapshot"], "the refused command never reaches transport");
    assert.equal(v.timers.size, 0, "no pending gate timer after refusal");
    v.verifications[1].reject(new Error("late check 2 failure"));
    await v.flush();
    assert.deepEqual(v.unhandled, [], "a late underlying verification outcome is not an unhandled rejection");
    assert.equal(v.gate.needsVerification(), true, "local expiry did not mark a verification as successful");
  } finally {
    for (const pending of v.verifications) pending.resolve();
    await v.flush();
    v.dispose();
  }
});

test("a command queued behind earlier checks is refused within 120 s of its own entry", async () => {
  const v = virtualGate();
  try {
    const first = v.issue("send_message");
    await v.advanceTo(50_000);
    const poll = v.issue("snapshot", { fail: true });
    await v.advanceTo(50_010);
    assert.ok(poll.error);
    await v.advanceTo(60_000);
    const second = v.issue("record_close_choice");
    await v.advanceTo(120_000);
    assert.equal(first.error, SERVER_REFUSAL, `first command refused at its deadline; ${JSON.stringify(first)}`);
    assert.ok(first.refusedAt - first.enteredAt <= VERIFY_DEADLINE_MS);
    await v.advanceTo(170_000);
    v.verifications[0].resolve();
    await v.advanceTo(170_010);
    assert.equal(v.verifications.length, 2, "the queued check starts only after check 1");
    await v.advanceTo(180_000);
    assert.equal(second.error, SERVER_REFUSAL, `queued command refused at its own deadline; ${JSON.stringify(second)}`);
    assert.ok(second.refusedAt - second.enteredAt <= VERIFY_DEADLINE_MS, `refused ${second.refusedAt - second.enteredAt} ms after entry`);
    assert.deepEqual(v.transports.map((entry) => entry.messageType), ["snapshot"]);
    assert.equal(v.timers.size, 0);
    v.verifications[1].resolve();
    await v.flush();
    assert.deepEqual(v.unhandled, []);
  } finally {
    for (const pending of v.verifications) pending.resolve();
    await v.flush();
    v.dispose();
  }
});

test("a check that succeeds within the window sends the command before the deadline", async () => {
  const v = virtualGate();
  try {
    const command = v.issue("send_message");
    await v.advanceTo(90_000);
    assert.equal(command.sentAt, undefined);
    v.verifications[0].resolve();
    await v.advanceTo(90_010);
    assert.equal(command.sentAt, 90_000, "sent as soon as the check succeeds");
    assert.equal(command.error, undefined);
    assert.deepEqual(v.transports, [{ messageType: "send_message", at: 90_000 }]);
    assert.equal(v.timers.size, 0, "the deadline timer is cleared after success");
    assert.deepEqual(v.unhandled, []);
  } finally {
    for (const pending of v.verifications) pending.resolve();
    await v.flush();
    v.dispose();
  }
});

test("a busy pipe peer is retried until it succeeds within the verification deadline", async () => {
  const fixture = gateFixture({ peers: [{ code: 3, stdout: busyPeer, elapsed: 3000 }, { code: 3, stdout: busyPeer, elapsed: 3000 }] });
  await fixture.send({ messageType: "safe_stop", requestId: "stop" });
  assert.deepEqual(fixture.log, ["peer", "peer", "peer", "get_startup_receipt", "safe_stop"]);
});

test("a peer that stays busy until the 120 s deadline refuses, and other failures refuse without retry", async () => {
  const always = gateFixture({ peers: Array.from({ length: 1000 }, () => ({ code: 3, stdout: busyPeer, elapsed: 3000 })) });
  await assert.rejects(always.send({ messageType: "send_message", requestId: "m" }), (error) => error.message === SERVER_REFUSAL);
  assert.ok(always.now() >= VERIFY_DEADLINE_MS - 3100 && always.now() <= VERIFY_DEADLINE_MS + 3000, `stopped at ${always.now()}`);
  assert.ok(!always.log.includes("send_message") && !always.log.includes("get_startup_receipt"));
  const peerRuns = always.log.filter((entry) => entry === "peer").length;
  assert.ok(peerRuns > 30 && peerRuns < 40, `busy retries ${peerRuns}`);
  for (const peer of [
    { code: 3, stdout: peerLine({ schema: "goalport.pipe-peer.v1", ok: false, stage: "dacl", code: 1338 }) },
    { code: 3, stdout: peerLine({ schema: "goalport.pipe-peer.v1", ok: false, stage: "open", code: 2 }) },
    { code: null, stdout: "" },
    { code: 0, stdout: okPeer(1) },
    { code: 1, stdout: busyPeer }
  ]) {
    const fixture = gateFixture({ peers: [peer] });
    await assert.rejects(fixture.send({ messageType: "record_close_choice", requestId: "c" }), /could not be verified/);
    assert.equal(fixture.log.filter((entry) => entry === "peer").length, 1, JSON.stringify(peer));
    assert.ok(!fixture.log.includes("record_close_choice"));
  }
});

test("the real Electron entrypoint routes Core requests and close choices through the verified gate", async (t) => {
  const { EventEmitter } = await import("node:events");
  const { createHash } = await import("node:crypto");
  const root = fixture(t);
  const resources = resolve(root, "resources");
  const data = resolve(root, "profile");
  mkdirSync(resources, { recursive: true });
  const coreBytes = "inert Core identity fixture; pipe-peer and the pipe are simulated";
  writeFileSync(resolve(resources, "goalport-core.exe"), coreBytes);
  const coreSha256 = createHash("sha256").update(coreBytes).digest("hex");
  const log = [];
  let peerPid = 4242, failSnapshot = false;
  let profile;
  const snapshot = { attempt: { id: "attempt-1", state: "active", provider: "scenario" } };
  const respond = (request) => {
    switch (request.messageType) {
      case "get_startup_receipt":
        return { ok: true, requestId: request.requestId, payload: { receipt: { startupState: "READY_COMMITTED", core: { executableSha256: coreSha256, pid: 4242 }, databaseIdentity: profile.database, pipeIdentity: profile.pipe } } };
      case "snapshot":
        return { ok: true, requestId: request.requestId, payload: { snapshot } };
      case "record_close_choice":
        return { ok: true, requestId: request.requestId, payload: { receipt: { receiptId: "receipt-1", choice: "continue-background" }, snapshot } };
      default:
        return { ok: true, requestId: request.requestId, payload: { requestId: request.requestId, accepted: true, snapshot } };
    }
  };
  const net = {
    createConnection: () => {
      const socket = new EventEmitter();
      socket.setTimeout = () => {};
      socket.destroy = () => {};
      socket.end = () => {};
      socket.write = (frame) => {
        const request = JSON.parse(frame.subarray(4).toString("utf8"));
        log.push(request.messageType);
        setImmediate(() => {
          if (request.messageType === "snapshot" && failSnapshot) { failSnapshot = false; socket.emit("error", new Error("pipe closed")); return; }
          const payload = Buffer.from(JSON.stringify(respond(request)));
          const reply = Buffer.alloc(4 + payload.length);
          reply.writeUInt32LE(payload.length, 0);
          payload.copy(reply, 4);
          socket.emit("data", reply);
        });
      };
      setImmediate(() => socket.emit("connect"));
      return socket;
    }
  };
  const childProcess = {
    spawn: () => assert.fail("an attached Core must not be launched"),
    execFile: (file, args, options, callback) => {
      assert.equal(file, resolve(resources, "goalport-core.exe"));
      if (args[0] === "profile") {
        const payload = args[1] === "inspect"
          ? { schema: "goalport.profile-ops.v1", ok: true, stage: "inspect", exists: true, openable: true, needsRecovery: false,
              schemaVersion: 8, currentSchemaVersion: 8, quickCheck: "ok",
              counts: { campaigns: 1 }, latestEpoch: { epochId: "e1", priorCore: "ended", state: "ENDED" } }
          : { ok: true, stage: "backup", quickCheck: "ok", schemaVersion: 8, counts: {} };
        setImmediate(() => callback(null, `${JSON.stringify(payload)}\n`, ""));
        return;
      }
      assert.deepEqual(args, ["pipe-peer", "--pipe", profile.pipe]);
      assert.equal(options.timeout, 5000);
      log.push("peer");
      setImmediate(() => callback(null, okPeer(peerPid), ""));
    }
  };
  const windows = [], handlers = new Map(), dialogs = [];
  class FakeWindow {
    constructor() { this.webContents = securityContents({ send: () => {}, executeJavaScript: async () => {} }); windows.push(this); }
    static fromWebContents() { return windows[0]; }
    loadFile() { return Promise.resolve(); }
    on() {}
    isDestroyed() { return false; }
    destroy() {}
  }
  const electron = {
    app: {
      isPackaged: true, getVersion: () => "1.0.0-rc.1", getPath: (name) => name === "exe" ? resolve(root, "GoalPort.exe") : root,
      setPath: () => {}, exit: (code) => assert.fail(`unexpected exit ${code}: ${dialogs.join(" ")}`), whenReady: () => Promise.resolve(),
      commandLine: { appendSwitch: () => {} }, setAppUserModelId: () => {}, requestSingleInstanceLock: () => true, on: () => {}, quit: () => {}
    },
    BrowserWindow: FakeWindow, ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    Notification: { isSupported: () => false }, shell: {}, dialog: { showErrorBox: (title, message) => dialogs.push(message) }
  };
  const mainFile = resolve("electron/main.cjs");
  const mainRequire = createRequire(mainFile);
  const main = vm.runInThisContext(`(function(require,module,exports,__dirname,process,console){${readFileSync(mainFile, "utf8")}\n})`, { filename: mainFile });
  const fakeRequire = (name) => name === "electron" ? electron : name === "node:net" ? net : name === "node:child_process" ? childProcess : mainRequire(name);
  const args = ["GoalPort.exe", "--data-dir", data];
  profile = resolveProfilePaths({ args: launchArguments(args), appData: root, channel: "release", coreSha256 });
  mkdirSync(data, { recursive: true });
  writeFileSync(resolve(data, "goalport-profile.json"), JSON.stringify({
    markerSchemaVersion: 2, product: "GoalPort", identityVersion: 2, profileKey: profile.profileKey,
    mode: "normal", channel: null, createdBy: { version: "1.0.0-rc.1", coreSha256, distribution: "release" },
    lastOpenedBy: { version: "1.0.0-rc.1", coreSha256, distribution: "release", at: "2026-09-19T00:00:00.000Z" },
    importedFrom: null, format: { authority: "schema_migrations", version: 8 }
  }, null, 2));
  main(fakeRequire, { exports: {} }, {}, resolve("electron"), { argv: args, resourcesPath: resources, env: {}, pid: 1234, platform: "win32", execPath: process.execPath }, { error: (...values) => dialogs.push(values.join(" ")) });
  const until = async (condition) => {
    const deadline = Date.now() + 5000;
    while (!condition()) { assert.ok(Date.now() < deadline, `timed out; log=${log.join(",")}; dialogs=${JSON.stringify(dialogs).slice(0, 500)}; windows=${windows.length}`); await new Promise((done) => setTimeout(done, 5)); }
  };
  await until(() => windows.length === 1 && log.includes("snapshot"));
  assert.deepEqual(log, ["peer", "get_startup_receipt", "snapshot"], "startup attachment verifies before the first snapshot");

  const request = (messageType, requestId) => ({ protocolVersion: "goalport.ipc.v2", requestId, entityVersion: 0, messageType, payload: {} });
  log.length = 0;
  await handlers.get("goalport:core-command")(trustedEvent(windows[0]), request("send_message", "send-1"));
  assert.deepEqual(log, ["peer", "get_startup_receipt", "send_message"]);

  log.length = 0;
  await handlers.get("goalport:core-snapshot")(trustedEvent(windows[0]), request("snapshot", "poll-1"));
  assert.deepEqual(log, ["snapshot"], "a snapshot poll with no prior failure is not re-verified");

  log.length = 0;
  failSnapshot = true;
  await handlers.get("goalport:core-snapshot")(trustedEvent(windows[0]), request("snapshot", "poll-2"));
  assert.deepEqual(log, ["snapshot", "peer", "get_startup_receipt", "snapshot"], "a failed snapshot re-verifies before its retry");

  log.length = 0;
  peerPid = 9999;
  await assert.rejects(handlers.get("goalport:core-command")(trustedEvent(windows[0]), request("safe_stop", "stop-1")), /could not be verified/);
  assert.deepEqual(log, ["peer", "get_startup_receipt"], "a server whose PID is not the receipt Core receives no mutation");
  peerPid = 4242;

  log.length = 0;
  const closed = await handlers.get("goalport:confirm-close-choice")(trustedEvent(windows[0]), { choice: "continue", requestId: "close-1" });
  assert.equal(closed.ok, true, JSON.stringify(closed));
  assert.deepEqual(log, ["peer", "get_startup_receipt", "snapshot", "peer", "get_startup_receipt", "record_close_choice"]);
});

// ---- Profile safety: fail-closed integration through the real entrypoint ----
// These exercise the ACTUAL electron/main.cjs in a vm: on refusal, no Core may
// be spawned (serve/Store::open), no pipe may be probed, no backup/import may
// run, the IPC start-core route stays gated, and the profile directory bytes
// stay unchanged. Positive controls prove fresh/reopen synthetic launches and
// the normal-mode reopen above keep working.

const { EventEmitter: HarnessEventEmitter } = require("node:events");
const { createHash: HarnessHash } = require("node:crypto");
const profileOpsLine = (facts) => `${JSON.stringify({ schema: "goalport.profile-ops.v1", ok: true, stage: "inspect", ...facts })}\n`;
const inspectMissingDb = (callback) => setImmediate(() => callback(null, profileOpsLine({ exists: false, openable: false, schemaVersion: null })));
const inspectCompatible = (callback) => setImmediate(() => callback(null, profileOpsLine({
  exists: true, openable: true, needsRecovery: false, schemaVersion: 8, currentSchemaVersion: 8, quickCheck: "ok",
  counts: { campaigns: 1 }, latestEpoch: { epochId: "e1", priorCore: "ended", state: "ENDED" }
})));
const inspectNewerSchema = (callback) => setImmediate(() => callback(null, profileOpsLine({
  exists: true, openable: true, needsRecovery: false, schemaVersion: 9, currentSchemaVersion: 8, quickCheck: "ok",
  counts: {}, latestEpoch: null
})));

test("real entrypoint: recovery consent is bound, unknown actions never mean fresh, and exit preserves staged import", async (t) => {
  for (const choice of ["accept", "stale", "exit", "fresh"]) {
    const effects = [];
    const journal = { operationId: "recovery-op", proofToken: "proof" };
    class RecoveryManager {
      async resolve() { return { kind: "import-recovery-offer", discovery: { path: "known-source", inspection: { counts: { campaigns: 1 } } }, journal,
        recovery: { recoveryDisposition: "POSITIVELY_IDENTIFIED_RECOVERABLE", recoveryMethod: "DETACHED_WAL_COPY_PROBE_V1", recoveryProofToken: "proof", operationId: "recovery-op", sourceMutationOnAccept: "NONE" } }; }
      async acceptRecovery(received, action) {
        effects.push(["consent", received, action]);
        if (action.operationId !== "recovery-op" || action.recoveryProofToken !== "proof") throw new Error("stale recovery consent");
      }
      declineRecovery(received) { assert.equal(received, journal); effects.push(["decline"]); }
      beginFresh() { effects.push(["fresh"]); }
      async recordOpenedDatabase() { effects.push(["opened"]); }
    }
    const harness = mainEntryHarness(t, { mode: "normal", pipeInitiallyUp: true, profileManagerClass: RecoveryManager });
    harness.run();
    await harness.until(() => harness.states.some((entry) => entry.state.phase === "import-offer"), "recovery offer");
    const state = (await bootstrapCurrent(harness));
    assert.equal(state.facts.recoveryDisposition, "POSITIVELY_IDENTIFIED_RECOVERABLE");
    const act = (payload) => harness.handlers.get("goalport:bootstrap-action")(trustedEvent(harness.windows[0]), payload);
    await act({ type: "unrecognized" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(effects, []);
    assert.equal(harness.pipeProbes, 0);
    await act(choice === "accept" || choice === "stale" ? { type: "import-accept", operationId: "recovery-op", recoveryProofToken: choice === "accept" ? "proof" : "wrong" } : { type: choice });
    if (choice === "exit") {
      await harness.until(() => harness.exits.length > 0, "recovery exit");
      assert.deepEqual(effects, []);
    } else if (choice === "stale") {
      await harness.until(() => harness.states.some((entry) => entry.state.phase === "error"), "stale consent refusal");
      assert.deepEqual(effects.map((effect) => effect[0]), ["consent"]);
      assert.equal(harness.pipeProbes, 0);
      await act({ type: "exit" });
    } else {
      await harness.until(() => harness.states.some((entry) => entry.state.phase === "done"), "accepted recovery or explicit fresh");
      assert.deepEqual(effects.map((effect) => effect[0]), choice === "accept" ? ["consent", "opened"] : ["decline", "fresh", "opened"]);
    }
  }
});

test("real entrypoint: capacity acknowledgement cannot clear held/active close responsibility", async (t) => {
  class ReadyManager {
    async resolve() { return { kind: "reopen", needsBackup: false }; }
    async recordOpenedDatabase() {}
  }
  const projection = { bounds: { projectionUnavailable: true }, attempt: { id: "attempt-1", state: "completed", provider: "scenario" } };
  const harness = mainEntryHarness(t, { mode: "normal", pipeInitiallyUp: true, profileManagerClass: ReadyManager, snapshotValue: projection });
  harness.run();
  await harness.until(() => harness.log.includes("snapshot"), "capacity acknowledgement cached");
  await new Promise((resolve) => setImmediate(resolve));
  const event = trustedEvent(harness.windows[0]);
  const close = await harness.handlers.get("goalport:request-close")(event);
  assert.equal(close.prompted, true);
  assert.equal(harness.destroyed.length, 0);
  const choice = await harness.handlers.get("goalport:confirm-close-choice")(event, { choice: "continue", requestId: "close-capacity" });
  assert.equal(choice.ok, false);
  assert.match(choice.error, /projection is unavailable/);
  assert.equal(harness.log.includes("record_close_choice"), false);
  projection.bounds.projectionUnavailable = false;
  const recovered = await harness.handlers.get("goalport:request-close")(event);
  assert.equal(recovered.allowQuitLatch, true);
  assert.equal(harness.destroyed.length, 1);
});

function mainEntryHarness(t, { mode = "synthetic", inspect = inspectCompatible, pipeInitiallyUp = false, spawnOpensPipe = false, launcherPresent = false, unpackagedOverrides = false, profileManagerClass = null, snapshotValue = null }) {
  const root = fixture(t);
  const resources = resolve(root, "resources");
  mkdirSync(resources, { recursive: true });
  const coreBytes = "inert Core identity fixture; never a real provider";
  writeFileSync(resolve(resources, "goalport-core.exe"), coreBytes);
  if (launcherPresent) writeFileSync(resolve(resources, "goalport-core-launcher.exe"), "inert launcher fixture; never executed");
  const selectedResources = unpackagedOverrides ? resolve(root, "configured") : resources;
  if (unpackagedOverrides) {
    mkdirSync(selectedResources);
    writeFileSync(resolve(selectedResources, "goalport-core.exe"), coreBytes);
    writeFileSync(resolve(resources, "goalport-core.exe"), "different fallback identity");
    if (launcherPresent) writeFileSync(resolve(selectedResources, "goalport-core-launcher.exe"), "configured launcher identity");
  }
  const launchEnv = unpackagedOverrides ? {
    GOALPORT_CORE_BIN: resolve(selectedResources, "goalport-core.exe"),
    ...(launcherPresent ? { GOALPORT_CORE_LAUNCHER_BIN: resolve(selectedResources, "goalport-core-launcher.exe") } : {})
  } : {};
  const coreSha256 = HarnessHash("sha256").update(coreBytes).digest("hex");
  const argv = ["GoalPort.exe", mode === "synthetic" ? "--test-profile" : "--data-dir", resolve(root, "profile")];
  const profile = resolveProfilePaths({ args: launchArguments(argv), appData: root, channel: "release", coreSha256 });
  const log = [], spawns = [], profileCommands = [], states = [], exits = [], dialogs = [], destroyed = [];
  const handlers = new Map();
  const windows = [];
  const pipeState = { up: pipeInitiallyUp, probes: 0 };
  const respond = (request) => {
    if (request.messageType === "get_startup_receipt") {
      return { ok: true, requestId: request.requestId, payload: { receipt: { startupState: "READY_COMMITTED", core: { executableSha256: coreSha256, pid: 4242 }, databaseIdentity: profile.database, pipeIdentity: profile.pipe } } };
    }
    return { ok: true, requestId: request.requestId, payload: { snapshot: snapshotValue ?? { attempt: { id: "attempt-1", state: "active", provider: "scenario" } } } };
  };
  const net = {
    createConnection: () => {
      pipeState.probes += 1;
      const socket = new HarnessEventEmitter();
      socket.setTimeout = () => {};
      socket.destroy = () => {};
      socket.end = () => socket.emit("close");
      socket.write = (frame) => {
        const request = JSON.parse(frame.subarray(4).toString("utf8"));
        log.push(request.messageType);
        setImmediate(() => {
          const payload = Buffer.from(JSON.stringify(respond(request)));
          const reply = Buffer.alloc(4 + payload.length);
          reply.writeUInt32LE(payload.length, 0);
          payload.copy(reply, 4);
          socket.emit("data", reply);
        });
      };
      setImmediate(() => (pipeState.up ? socket.emit("connect") : socket.emit("error", new Error("pipe does not exist"))));
      return socket;
    }
  };
  const childProcess = {
    spawn: (command, args) => {
      spawns.push([command, args]);
      if (spawnOpensPipe) pipeState.up = true;
      return { once: () => {}, unref: () => {} };
    },
    execFile: (file, args, options, callback) => {
      assert.equal(file, resolve(selectedResources, "goalport-core.exe"), "only the originally selected Core identity may be executed");
      if (args[0] === "profile") {
        profileCommands.push(args.slice(0, 2).join(" "));
        if (args[1] === "inspect") { setImmediate(() => inspect(callback)); return; }
        setImmediate(() => callback(new Error(`unexpected profile command ${args[1]}`), ""));
        return;
      }
      assert.deepEqual(args, ["pipe-peer", "--pipe", profile.pipe]);
      assert.equal(options.timeout, 5000);
      log.push("peer");
      setImmediate(() => callback(null, okPeer(4242), ""));
    }
  };
  class HarnessWindow {
    constructor() {
      this.webContents = securityContents({ send: (channel, state) => states.push({ channel, state }), executeJavaScript: async () => {} });
      windows.push(this);
    }
    static fromWebContents() { return windows[0]; }
    loadFile() { return Promise.resolve(); }
    on() {}
    isDestroyed() { return false; }
    destroy() { destroyed.push(this); }
  }
  const electron = {
    app: {
      isPackaged: !unpackagedOverrides, getVersion: () => "1.0.0-rc.1",
      getPath: (name) => (name === "exe" ? resolve(root, "GoalPort.exe") : root),
      setPath: () => {}, exit: (code) => exits.push(code), whenReady: () => Promise.resolve(),
      commandLine: { appendSwitch: () => {} }, setAppUserModelId: () => {}, requestSingleInstanceLock: () => true, on: () => {}, quit: () => {}
    },
    BrowserWindow: HarnessWindow, ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    Notification: { isSupported: () => false }, shell: {}, dialog: { showErrorBox: (title, message) => dialogs.push(message) }
  };
  const mainFile = resolve("electron/main.cjs");
  const mainRequire = createRequire(mainFile);
  const main = vm.runInThisContext(`(function(require,module,exports,__dirname,process,console){${readFileSync(mainFile, "utf8")}\n})`, { filename: mainFile });
  const fakeRequire = (name) => name === "./profile-manager.cjs" && profileManagerClass ? { ProfileManager: profileManagerClass } : name === "electron" ? electron : name === "node:net" ? net : name === "node:child_process" ? childProcess : mainRequire(name);
  const run = () => main(fakeRequire, { exports: {} }, {}, resolve("electron"), {
    argv, resourcesPath: resources, env: launchEnv, pid: process.pid, platform: "win32", execPath: process.execPath
  }, { error: (...values) => dialogs.push(values.join(" ")) });
  const until = async (condition, label) => {
    const deadline = Date.now() + 15000;
    while (!condition()) {
      assert.ok(Date.now() < deadline, `timed out waiting for ${label}; states=${JSON.stringify(states.map((entry) => entry.state))}; log=${log.join(",")}; spawns=${spawns.length}; commands=${profileCommands.join(",")}; dialogs=${dialogs.join(" | ").slice(0, 400)}`);
      await new Promise((done) => setTimeout(done, 5));
    }
  };
  const directorySnapshot = () => existsSync(profile.directory)
    ? readdirSync(profile.directory).sort().map((name) => [name, readFileSync(resolve(profile.directory, name)).toString("latin1")])
    : null;
  return {
    root, profile, run, until, directorySnapshot,
    get log() { return log; }, get spawns() { return spawns; }, get profileCommands() { return profileCommands; },
    get states() { return states; }, get exits() { return exits; }, get dialogs() { return dialogs; },
    get handlers() { return handlers; }, get windows() { return windows; }, get destroyed() { return destroyed; },
    get pipeProbes() { return pipeState.probes; }, coreSha256, launchEnv
  };
}

function assertRefusedWithoutSideEffects(harness, kind) {
  const errorState = harness.states.map((entry) => entry.state).find((state) => state.phase === "error");
  assert.ok(errorState, `bootstrap must reach an error refusal; states=${JSON.stringify(harness.states.map((entry) => entry.state))}`);
  assert.equal(errorState.kind, kind);
  assert.deepEqual(harness.spawns, [], "no Core process may be spawned (no serve, no Store::open)");
  assert.equal(harness.pipeProbes, 0, "ensureCore must never be invoked");
  assert.deepEqual(harness.log, [], "no pipe traffic may occur");
  assert.deepEqual(harness.profileCommands, ["profile inspect"], "inspection is read-only; no backup write-open, no import");
  assert.deepEqual(harness.dialogs, [], "no crash dialogs; the refusal is a structured screen");
}

const normalMarkerFixture = (profile) => ({
  markerSchemaVersion: 2, product: "GoalPort", identityVersion: 2, profileKey: profile.profileKey, mode: "normal",
  channel: "release", createdAt: "2026-09-01T00:00:00.000Z",
  createdBy: { version: "1.0.0-rc.1", coreSha256: "b".repeat(64), distribution: "release" },
  lastOpenedBy: { version: "1.0.0-rc.1", coreSha256: "b".repeat(64), distribution: "release", at: "2026-09-19T00:00:00.000Z" },
  importedFrom: null, format: { authority: "schema_migrations", version: 8 }
});
const syntheticMarkerFixture = (profile, lastOpenedSha) => ({
  markerSchemaVersion: 2, product: "GoalPort", identityVersion: 2, profileKey: profile.profileKey, mode: "synthetic-test",
  channel: null, createdAt: "2026-09-01T00:00:00.000Z",
  createdBy: { version: "1.0.0-rc.1", coreSha256: lastOpenedSha, distribution: "dev" },
  lastOpenedBy: { version: "1.0.0-rc.1", coreSha256: lastOpenedSha, distribution: "dev", at: "2026-09-19T00:00:00.000Z" },
  importedFrom: null, format: { authority: "schema_migrations", version: 8 }
});
function writeProfileMarker(directory, marker) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, "goalport-profile.json"), `${JSON.stringify(marker, null, 2)}\n`);
}
async function refuseThroughErrorScreen(harness, kind, preimage) {
  await harness.until(() => harness.states.some((entry) => entry.state.phase === "error"), `${kind} error screen`);
  assertRefusedWithoutSideEffects(harness, kind);
  assert.deepEqual(harness.directorySnapshot(), preimage, "the refusal must leave the profile directory bytes unchanged");
  await assert.rejects(harness.handlers.get("goalport:start-core")(trustedEvent(harness.windows[0])), /still preparing/, "the IPC start-core route must stay gated");
  await harness.handlers.get("goalport:bootstrap-action")(trustedEvent(harness.windows[0]), { type: "exit" });
  await harness.until(() => harness.exits.length === 1, "exit after refusal");
  assert.deepEqual(harness.exits, [0]);
  assert.equal(harness.destroyed.length, 1);
}

test("real entrypoint: failed profile inspection refuses before backup write-open, marker writes or Core launch", async (t) => {
  const harness = mainEntryHarness(t, { mode: "normal", inspect: (callback) => setImmediate(() => callback(Object.assign(new Error("inspect crashed"), { code: 3 }), "")) });
  writeProfileMarker(harness.profile.directory, normalMarkerFixture(harness.profile));
  writeFileSync(resolve(harness.profile.directory, "goalport.sqlite"), "owner-like database bytes");
  harness.run();
  const preimage = harness.directorySnapshot();
  await refuseThroughErrorScreen(harness, "inspection-failed", preimage);
});

test("real entrypoint: malformed inspection output refuses instead of reopening unknown data", async (t) => {
  const harness = mainEntryHarness(t, { mode: "normal", inspect: (callback) => setImmediate(() => callback(null, "certainly not json\n")) });
  writeProfileMarker(harness.profile.directory, normalMarkerFixture(harness.profile));
  writeFileSync(resolve(harness.profile.directory, "goalport.sqlite"), "owner-like database bytes");
  harness.run();
  const preimage = harness.directorySnapshot();
  await refuseThroughErrorScreen(harness, "inspection-failed", preimage);
});

test("real entrypoint: --test-profile cannot target a normal data profile", async (t) => {
  // The inspection SUCCEEDS and is compatible: the refusal must come from the
  // marker mode identity check, proving no synthetic shortcut exists.
  const harness = mainEntryHarness(t, { mode: "synthetic", inspect: inspectCompatible });
  writeProfileMarker(harness.profile.directory, normalMarkerFixture(harness.profile));
  writeFileSync(resolve(harness.profile.directory, "goalport.sqlite"), "owner-like database bytes");
  harness.run();
  const preimage = harness.directorySnapshot();
  await refuseThroughErrorScreen(harness, "identity-mismatch", preimage);
  const marker = JSON.parse(readFileSync(resolve(harness.profile.directory, "goalport-profile.json"), "utf8"));
  assert.equal(marker.mode, "normal", "the normal-profile marker must never be rewritten or adopted");
});

test("real entrypoint: --test-profile refuses a foreign unmarked directory", async (t) => {
  const harness = mainEntryHarness(t, { mode: "synthetic", inspect: inspectMissingDb });
  mkdirSync(harness.profile.directory, { recursive: true });
  writeFileSync(resolve(harness.profile.directory, "notes.txt"), "someone else's files");
  harness.run();
  const preimage = harness.directorySnapshot();
  await refuseThroughErrorScreen(harness, "not-a-profile", preimage);
});

test("real entrypoint: --test-profile refuses a newer database schema before Core launch", async (t) => {
  const harness = mainEntryHarness(t, { mode: "synthetic", inspect: inspectNewerSchema });
  writeProfileMarker(harness.profile.directory, syntheticMarkerFixture(harness.profile, "c".repeat(64)));
  writeFileSync(resolve(harness.profile.directory, "goalport.sqlite"), "newer-format database bytes");
  harness.run();
  const preimage = harness.directorySnapshot();
  await refuseThroughErrorScreen(harness, "newer-schema", preimage);
});

test("real entrypoint: a fresh synthetic --test-profile bootstraps its marker and may launch Core", async (t) => {
  let inspections = 0;
  const harness = mainEntryHarness(t, { mode: "synthetic", inspect: (callback) => (++inspections === 1 ? inspectMissingDb(callback) : inspectCompatible(callback)), spawnOpensPipe: true, launcherPresent: true });
  assert.equal(harness.directorySnapshot(), null, "the test profile directory starts absent");
  harness.run();
  await harness.until(() => harness.states.some((entry) => entry.state.phase === "done") && harness.log.includes("snapshot"), "synthetic bootstrap completion");
  assert.equal(harness.spawns.length, 1, "the permitted synthetic launch spawns the Core server exactly once");
  const [command, spawnArgs] = harness.spawns[0];
  assert.equal(command, resolve(harness.root, "resources", "goalport-core-launcher.exe"));
  assert.equal(spawnArgs[0], resolve(harness.root, "resources", "goalport-core.exe"));
  assert.equal(spawnArgs[1], "serve");
  assert.ok(spawnArgs.includes(harness.profile.database), "serve targets the synthetic profile database");
  assert.ok(spawnArgs.includes(harness.profile.pipe));
  assert.deepEqual(harness.profileCommands, ["profile inspect", "profile inspect"]);
  const marker = JSON.parse(readFileSync(resolve(harness.profile.directory, "goalport-profile.json"), "utf8"));
  assert.equal(marker.product, "GoalPort");
  assert.equal(marker.mode, "synthetic-test");
  assert.equal(marker.profileKey, harness.profile.profileKey);
  assert.equal(marker.lastOpenedBy.coreSha256, harness.coreSha256);
  assert.equal(marker.format.version, 8, "fresh open persists the post-Core schema fact");
  assert.equal((await bootstrapCurrent(harness)).diagnostics.profileDisposition, "fresh");
  assert.deepEqual(harness.dialogs, []);
  assert.ok(harness.log.includes("peer") && harness.log.includes("get_startup_receipt"), "attachment is verified after the permitted launch");
});

test("real entrypoint: dev keeps its selected Core and launcher after launch environment scrub", async (t) => {
  let inspections = 0;
  const harness = mainEntryHarness(t, { mode: "normal", unpackagedOverrides: true, launcherPresent: true, spawnOpensPipe: true,
    inspect: (callback) => (++inspections === 1 ? inspectMissingDb(callback) : inspectCompatible(callback)) });
  harness.run();
  await harness.until(() => harness.states.some((entry) => entry.state.phase === "done"), "dev startup");
  assert.equal(harness.launchEnv.GOALPORT_CORE_BIN, undefined);
  assert.equal(harness.launchEnv.GOALPORT_CORE_LAUNCHER_BIN, undefined);
  assert.equal(harness.spawns[0][0], resolve(harness.root, "configured/goalport-core-launcher.exe"));
  assert.equal(harness.spawns[0][1][0], resolve(harness.root, "configured/goalport-core.exe"));
  assert.deepEqual(harness.dialogs, []);
});

test("real entrypoint: failed post-open facts prevent done and preserve the fresh marker", async (t) => {
  let inspections = 0;
  const harness = mainEntryHarness(t, { mode: "synthetic", launcherPresent: true, spawnOpensPipe: true,
    inspect: (callback) => (++inspections === 1 ? inspectMissingDb(callback) : setImmediate(() => callback(null, "malformed"))) });
  harness.run();
  await harness.until(() => harness.states.some((entry) => entry.state.phase === "error"), "post-open refusal");
  assert.equal(harness.states.some((entry) => entry.state.phase === "done"), false);
  const marker = JSON.parse(readFileSync(harness.profile.marker, "utf8"));
  assert.equal(marker.lastOpenedBy, null);
  assert.equal(marker.format.version, null);
  const trace = (await bootstrapCurrent(harness)).diagnostics.originalProfileInspect;
  assert.equal(trace.records[0].facts.exists, false);
  assert.equal(trace.records[1].purpose, "post-core-open");
  assert.equal(trace.records[1].malformed, true);
});

test("real entrypoint: a compatible synthetic reopen still attaches without any write-open", async (t) => {
  const harness = mainEntryHarness(t, { mode: "synthetic", inspect: inspectCompatible, pipeInitiallyUp: true });
  writeProfileMarker(harness.profile.directory, syntheticMarkerFixture(harness.profile, "c".repeat(64)));
  writeFileSync(resolve(harness.profile.directory, "goalport.sqlite"), "synthetic database bytes");
  harness.run();
  await harness.until(() => harness.states.some((entry) => entry.state.phase === "done") && harness.log.includes("snapshot"), "synthetic reopen completion");
  assert.deepEqual(harness.spawns, [], "an attached Core needs no second launch");
  assert.deepEqual(harness.profileCommands, ["profile inspect", "profile inspect"], "classification and post-open are read-only; no backup write-open runs for synthetic data");
  assert.deepEqual(harness.log, ["peer", "get_startup_receipt", "snapshot"]);
  assert.deepEqual(harness.dialogs, []);
  const marker = JSON.parse(readFileSync(resolve(harness.profile.directory, "goalport-profile.json"), "utf8"));
  assert.equal(marker.mode, "synthetic-test", "the synthetic identity is preserved");
  assert.equal(marker.lastOpenedBy.coreSha256, harness.coreSha256, "the resolved reopen records this build");
});

// ---- Inspection contract validation through the real entrypoint ----
// These cases exercise normal-mode startup through the VM harness above.
//
// An inspection whose "successful existing openable" output omits required
// compatibility/integrity facts (currentSchemaVersion, quickCheck) must
// refuse BEFORE any mutable launch/profile write — no Core spawn
// (serve/Store::open), no pipe probe, no backup write-open, no import, no
// marker write — and the profile directory bytes must stay unchanged. The
// journal-corrupt case proves the resume path can no longer finalize a marker
// over data that failed quick_check. A positive control proves a
// fully-factored compatible inspection still completes a normal attach.

// Full real-contract facts for an existing openable compatible schema-9
// database (same shape as inspectCompatible above, at this build's schema 9).
const inspectCompatible9 = (callback) => setImmediate(() => callback(null, profileOpsLine({
  exists: true, openable: true, needsRecovery: false, schemaVersion: 9, currentSchemaVersion: 9, quickCheck: "ok",
  counts: { campaigns: 1 }, latestEpoch: { epochId: "e1", priorCore: "ended", state: "ENDED" }
})));
// The reviewed repro shape: exists/openable facts present, currentSchemaVersion absent.
const inspectMissingCurrentSchema = (callback) => setImmediate(() => callback(null, profileOpsLine({
  exists: true, openable: true, needsRecovery: false, schemaVersion: 9, quickCheck: "ok",
  counts: { campaigns: 1 }, latestEpoch: { epochId: "e1", priorCore: "ended", state: "ENDED" }
})));
// Integrity fact absent: quickCheck never reported.
const inspectMissingQuickCheck = (callback) => setImmediate(() => callback(null, profileOpsLine({
  exists: true, openable: true, needsRecovery: false, schemaVersion: 9, currentSchemaVersion: 9,
  counts: { campaigns: 1 }, latestEpoch: { epochId: "e1", priorCore: "ended", state: "ENDED" }
})));
// Honest corruption: facts complete, quick_check failed.
const inspectCorrupt = (callback) => setImmediate(() => callback(null, profileOpsLine({
  exists: true, openable: true, needsRecovery: false, schemaVersion: 9, currentSchemaVersion: 9, quickCheck: "row 3 missing",
  counts: { campaigns: 1 }, latestEpoch: { epochId: "e1", priorCore: "ended", state: "ENDED" }
})));
// schema-9 fixtures commit marker format version 9 (matching the schema-9 database).
const normalMarkerV9 = (profile) => ({ ...normalMarkerFixture(profile), format: { authority: "schema_migrations", version: 9 } });

test("real entrypoint: openable inspection missing currentSchemaVersion refuses before any launch/profile write", async (t) => {
  const harness = mainEntryHarness(t, { mode: "normal", inspect: inspectMissingCurrentSchema });
  const dir = harness.profile.directory;
  writeProfileMarker(dir, normalMarkerV9(harness.profile));
  writeFileSync(resolve(dir, "goalport.sqlite"), "owner-like database bytes");
  harness.run();
  const preimage = harness.directorySnapshot();
  await refuseThroughErrorScreen(harness, "inspection-failed", preimage);
});

test("real entrypoint: openable inspection missing quickCheck refuses instead of reopening unverified data", async (t) => {
  const harness = mainEntryHarness(t, { mode: "normal", inspect: inspectMissingQuickCheck });
  const dir = harness.profile.directory;
  writeProfileMarker(dir, normalMarkerV9(harness.profile));
  writeFileSync(resolve(dir, "goalport.sqlite"), "owner-like database bytes");
  harness.run();
  const preimage = harness.directorySnapshot();
  await refuseThroughErrorScreen(harness, "inspection-failed", preimage);
});

test("real entrypoint: corrupt journal database refuses before the resume path finalizes a marker", async (t) => {
  // Crash window: journal finalized, database present, marker not yet written —
  // and the staged database actually fails quick_check. Pre-fix the fast path
  // resumed (marker write) without ever consulting quickCheck.
  const harness = mainEntryHarness(t, { mode: "normal", inspect: inspectCorrupt });
  const dir = harness.profile.directory;
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "goalport.sqlite"), "corrupt imported bytes");
  const journal = { phase: "finalized", source: "C:/d/rc", sourceCreatedBy: null, stagingDir: resolve(harness.root, "staging-x") };
  writeFileSync(resolve(dir, "import-journal.json"), `${JSON.stringify(journal, null, 2)}\n`);
  harness.run();
  const preimage = harness.directorySnapshot();
  await refuseThroughErrorScreen(harness, "corrupt", preimage);
  assert.ok(!existsSync(resolve(dir, "goalport-profile.json")), "finalizeImport must never run: no marker over corrupt data");
});

test("real entrypoint: a fully-factored compatible inspection still completes a normal attach (positive control)", async (t) => {
  const harness = mainEntryHarness(t, { mode: "normal", inspect: inspectCompatible9, pipeInitiallyUp: true });
  const dir = harness.profile.directory;
  const marker = normalMarkerV9(harness.profile);
  marker.lastOpenedBy = { version: "1.0.0-rc.1", coreSha256: harness.coreSha256, distribution: "release", at: "2026-09-19T00:00:00.000Z" };
  writeProfileMarker(dir, marker);
  writeFileSync(resolve(dir, "goalport.sqlite"), "owner-like database bytes");
  harness.run();
  await harness.until(() => harness.states.some((entry) => entry.state.phase === "done") && harness.log.includes("snapshot"), "compatible reopen completion");
  assert.deepEqual(harness.spawns, [], "an attached Core needs no second launch");
  assert.deepEqual(harness.profileCommands, ["profile inspect", "profile inspect"], "no backup write-open may run when lastOpenedBy matches this build");
  assert.deepEqual(harness.log.slice(0, 3), ["peer", "get_startup_receipt", "snapshot"]);
  assert.deepEqual(harness.dialogs, []);
  const after = JSON.parse(readFileSync(resolve(dir, "goalport-profile.json"), "utf8"));
  assert.equal(after.mode, "normal");
  assert.equal(after.lastOpenedBy.coreSha256, harness.coreSha256, "the resolved reopen records this build");
});

// ---- Original startup inspection trace through the real entrypoint ----
// The trace is exercised through the ACTUAL electron/main.cjs in the vm
// harness: runTracedCoreProfileCommand wraps the real runCoreProfileCommand,
// which reaches this harness's execFile stub. The trace is exposed ONLY as
// the optional `diagnostics` child of the goalport:bootstrap-current result;
// goalport:bootstrap-state events and the phase/kind contract stay untouched.

const traceRecordKeys = ["target", "purpose", "status", "startedAt", "endedAt", "elapsedMs", "exitCode", "execError", "malformed", "parseNote", "facts"].sort();

function bootstrapCurrent(harness) {
  return harness.handlers.get("goalport:bootstrap-current")(trustedEvent(harness.windows[0]));
}

test("real entrypoint: a hung original inspect reports pending in bootstrap-current while phase stays checking", async (t) => {
  const harness = mainEntryHarness(t, { mode: "normal", inspect: () => { /* the inspect never completes: original hang shape */ } });
  writeProfileMarker(harness.profile.directory, normalMarkerV9(harness.profile));
  writeFileSync(resolve(harness.profile.directory, "goalport.sqlite"), "owner-like database bytes");
  harness.run();
  await harness.until(() => harness.profileCommands.includes("profile inspect"), "original inspect issued");
  const queriedAt = Date.now();
  const state = await bootstrapCurrent(harness);
  assert.ok(Date.now() - queriedAt < 1000, "bootstrap-current must not wait on the hung inspect");
  assert.equal(state.phase, "checking");
  const trace = state.diagnostics.originalProfileInspect;
  assert.equal(trace.kind, "original-startup-inspect-trace");
  assert.equal(trace.totalInspections, 1);
  assert.equal(trace.droppedRecords, 0);
  const record = trace.records[0];
  assert.deepEqual(Object.keys(record).sort(), traceRecordKeys, "only selected bounded fields are exposed; no stdout field exists");
  assert.equal(record.status, "pending");
  assert.equal(record.target, "own-database");
  assert.match(record.startedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(Number.isFinite(record.elapsedMs) && record.elapsedMs >= 0, "a pending record reports its elapsed-so-far");
  assert.equal(record.endedAt, null);
  assert.equal(record.exitCode, null);
  assert.equal(record.execError, null);
  assert.equal(record.facts, null);
  assert.equal(record.malformed, null);
  // The hung bootstrap must not have produced side effects, and the trace
  // must not mask, advance or replace the still-running startup.
  assert.deepEqual(harness.spawns, []);
  assert.equal(harness.pipeProbes, 0);
  assert.deepEqual(harness.log, []);
  assert.deepEqual(harness.states.map((entry) => entry.state.phase), ["checking"]);
  assert.ok(harness.states.every((entry) => entry.state.diagnostics === undefined), "bootstrap-state events stay unchanged");
});

test("real entrypoint: a completed original inspect exposes selected facts; state events and profile behavior stay unchanged", async (t) => {
  const harness = mainEntryHarness(t, { mode: "normal", inspect: inspectCompatible9, pipeInitiallyUp: true });
  const dir = harness.profile.directory;
  const marker = normalMarkerV9(harness.profile);
  marker.lastOpenedBy = { version: "1.0.0-rc.1", coreSha256: harness.coreSha256, distribution: "release", at: "2026-09-19T00:00:00.000Z" };
  writeProfileMarker(dir, marker);
  writeFileSync(resolve(dir, "goalport.sqlite"), "owner-like database bytes");
  harness.run();
  await harness.until(() => harness.states.some((entry) => entry.state.phase === "done") && harness.log.includes("snapshot"), "compatible reopen completion");
  const state = await bootstrapCurrent(harness);
  assert.equal(state.phase, "done");
  const { diagnostics, ...stateOnly } = state;
  assert.deepEqual(stateOnly, harness.states[harness.states.length - 1].state, "only an additive diagnostics child differs from the last pushed state");
  assert.ok(harness.states.every((entry) => entry.state.diagnostics === undefined), "no diagnostics child ever enters bootstrap-state events");
  const trace = diagnostics.originalProfileInspect;
  assert.equal(trace.totalInspections, 2);
  assert.equal(trace.droppedRecords, 0);
  const record = trace.records[0];
  assert.deepEqual(Object.keys(record).sort(), traceRecordKeys);
  assert.equal(record.status, "completed");
  assert.equal(record.target, "own-database");
  assert.equal(record.exitCode, 0);
  assert.equal(record.malformed, false);
  assert.equal(record.parseNote, null);
  assert.ok(Number.isFinite(record.elapsedMs) && record.elapsedMs >= 0);
  assert.match(record.endedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(record.facts, {
    ok: true, exists: true, openable: true, needsRecovery: false, empty: null,
    schemaVersion: 9, currentSchemaVersion: 9, quickCheck: "ok", errorReason: null
  });
  assert.deepEqual(trace.records.map((entry) => entry.purpose), ["classification", "post-core-open"]);
  assert.deepEqual(harness.profileCommands, ["profile inspect", "profile inspect"]);
  assert.deepEqual(harness.spawns, []);
  assert.deepEqual(harness.dialogs, []);
});

test("real entrypoint: refused and malformed original inspects record honest exit/parse facts without private paths", async (t) => {
  const userHome = process.env.USERPROFILE || process.env.HOME || "";
  // Synthetic private paths exercise the same contract on either host; the
  // actual disposable /tmp fixture is not itself a private home.
  const privateExecutable = "/home/fixture-private/resources/goalport-core.exe";
  const privateDatabase = "/home/fixture-private/profile/goalport.sqlite";
  // (a) nonzero-exit refusal whose exec error carries a private executable path
  {
    let harnessRef = null;
    const harness = mainEntryHarness(t, {
      mode: "normal",
      inspect: (callback) => setImmediate(() => callback(Object.assign(new Error(`profile inspect failed: ${privateExecutable} could not run`), { code: 3 }), ""))
    });
    harnessRef = harness;
    writeProfileMarker(harness.profile.directory, normalMarkerV9(harness.profile));
    writeFileSync(resolve(harness.profile.directory, "goalport.sqlite"), "owner-like database bytes");
    harness.run();
    const preimage = harness.directorySnapshot();
    await refuseThroughErrorScreen(harness, "inspection-failed", preimage);
    const record = (await bootstrapCurrent(harness)).diagnostics.originalProfileInspect.records[0];
    assert.equal(record.status, "completed");
    assert.equal(record.exitCode, 3);
    assert.ok(record.execError && record.execError.length <= 200, "exec error is capped");
    if (userHome) assert.ok(!record.execError.includes(userHome), "exec error is path-redacted");
    assert.match(record.execError, /<user-profile>/);
    assert.equal(record.malformed, true, "empty stdout is recorded as malformed, not invented");
    assert.equal(record.parseNote, "no parsable output line");
    assert.equal(record.facts, null);
  }
  // (b) malformed inspection output
  {
    const harness = mainEntryHarness(t, { mode: "normal", inspect: (callback) => setImmediate(() => callback(null, "certainly not json\n")) });
    writeProfileMarker(harness.profile.directory, normalMarkerV9(harness.profile));
    writeFileSync(resolve(harness.profile.directory, "goalport.sqlite"), "owner-like database bytes");
    harness.run();
    const preimage = harness.directorySnapshot();
    await refuseThroughErrorScreen(harness, "inspection-failed", preimage);
    const record = (await bootstrapCurrent(harness)).diagnostics.originalProfileInspect.records[0];
    assert.equal(record.status, "completed");
    assert.equal(record.exitCode, 0);
    assert.equal(record.malformed, true);
    assert.match(record.parseNote, /JSON|parsable/);
    assert.equal(record.facts, null);
  }
  // (c) ok:false refusal report: selected facts recorded, stdout extras and private paths dropped
  {
    const secret = "TRACE-MAIN-SECRET-field";
    let harnessRef = null;
    const harness = mainEntryHarness(t, {
      mode: "normal",
      inspect: (callback) => setImmediate(() => callback(null, `${JSON.stringify({
        schema: "goalport.profile-ops.v1", ok: false, extraField: secret,
        error: `locked: ${privateDatabase}`
      })}\n`))
    });
    harnessRef = harness;
    writeProfileMarker(harness.profile.directory, normalMarkerV9(harness.profile));
    writeFileSync(resolve(harness.profile.directory, "goalport.sqlite"), "owner-like database bytes");
    harness.run();
    const preimage = harness.directorySnapshot();
    await refuseThroughErrorScreen(harness, "inspection-failed", preimage);
    const record = (await bootstrapCurrent(harness)).diagnostics.originalProfileInspect.records[0];
    assert.equal(record.status, "completed");
    assert.equal(record.exitCode, 0);
    assert.equal(record.malformed, false);
    assert.equal(record.facts.ok, false);
    assert.match(record.facts.errorReason, /locked:/);
    if (userHome) assert.ok(!record.facts.errorReason.includes(userHome), "refusal reason is path-redacted");
    const serialized = JSON.stringify(record);
    const rawDb = privateDatabase;
    assert.ok(!serialized.includes(secret), "non-selected stdout fields never ride along");
    assert.ok(!serialized.includes(rawDb) && !serialized.includes(JSON.stringify(rawDb).slice(1, -1)), "the raw private database path does not ride along");
  }
});

// ---- B1: the profile-less legacy isolated branch emits bootstrap done ----
// Legacy isolated tooling (GOALPORT_REQUIRE_ISOLATED with an env-bound Core
// contract and no profile flags) is an ACTIVE admission contract, not a
// leftover. Its renderer subscribes to bootstrap states like any other; before
// the storage-boundary work nothing ever pushed a state there, so a gating
// renderer would wait on "checking" forever. The done signal must arrive after
// the Core attach, and goalport:bootstrap-current must answer done (not a
// permanently stale "checking").

test("real entrypoint: a profile-less legacy isolated run receives bootstrap done and attaches its Core", async (t) => {
  const root = fixture(t);
  const slug = `goalport-isolated-done-${process.pid}`;
  const runRoot = resolve(root, "goal-runs", slug);
  const db = resolve(runRoot, "run", "goalport.sqlite");
  mkdirSync(dirname(db), { recursive: true });
  const resources = resolve(root, "resources");
  mkdirSync(resources, { recursive: true });
  writeFileSync(resolve(resources, "goalport-core.exe"), "inert Core identity fixture; never executed");
  const log = [], states = [], setPathCalls = [];
  const handlers = new Map();
  const windows = [];
  const pipeUp = { probes: 0 };
  const net = {
    createConnection: () => {
      pipeUp.probes += 1;
      const socket = new HarnessEventEmitter();
      socket.setTimeout = () => {};
      socket.destroy = () => {};
      socket.end = () => socket.emit("close");
      socket.write = (frame) => {
        const request = JSON.parse(frame.subarray(4).toString("utf8"));
        log.push(request.messageType);
        setImmediate(() => {
          const payload = Buffer.from(JSON.stringify({ ok: true, requestId: request.requestId, payload: { snapshot: { attempt: { id: "attempt-1", state: "active", provider: "scenario" } } } }));
          const reply = Buffer.alloc(4 + payload.length);
          reply.writeUInt32LE(payload.length, 0);
          payload.copy(reply, 4);
          socket.emit("data", reply);
        });
      };
      setImmediate(() => socket.emit("connect"));
      return socket;
    }
  };
  const childProcess = {
    spawn: () => assert.fail("an attached Core must not be launched"),
    execFile: () => assert.fail("no profile command or pipe-peer runs in the profile-less branch")
  };
  class IsolatedWindow {
    constructor() {
      this.webContents = securityContents({ send: (channel, state) => states.push({ channel, state }), executeJavaScript: async () => {} });
      windows.push(this);
    }
    static fromWebContents() { return windows[0]; }
    loadFile() { return Promise.resolve(); }
    on() {}
    isDestroyed() { return false; }
    destroy() {}
  }
  const electron = {
    app: {
      isPackaged: true, getVersion: () => "1.0.0-rc.1",
      getPath: (name) => (name === "exe" ? resolve(root, "GoalPort.exe") : root),
      setPath: (name, value) => setPathCalls.push([name, value]), exit: (code) => log.push(`exit:${code}`), whenReady: () => Promise.resolve(),
      commandLine: { appendSwitch: () => {} }, setAppUserModelId: () => {}, requestSingleInstanceLock: () => true, on: () => {}, quit: () => {}
    },
    BrowserWindow: IsolatedWindow, ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    Notification: { isSupported: () => false }, shell: {}, dialog: { showErrorBox: () => log.push("dialog") }
  };
  const mainFile = resolve("electron/main.cjs");
  const mainRequire = createRequire(mainFile);
  const main = vm.runInThisContext(`(function(require,module,exports,__dirname,process,console){${readFileSync(mainFile, "utf8")}\n})`, { filename: mainFile });
  const fakeRequire = (name) => name === "electron" ? electron : name === "node:net" ? net : name === "node:child_process" ? childProcess : mainRequire(name);
  main(fakeRequire, { exports: {} }, {}, resolve("electron"), {
    argv: ["GoalPort.exe"], resourcesPath: resources,
    env: {
      GOALPORT_REQUIRE_ISOLATED: "1",
      GOALPORT_RUN_SLUG: slug,
      GOALPORT_CORE_DB: db,
      GOALPORT_CORE_PIPE: `goalport-${slug}-core`,
      GOALPORT_SYNTHETIC_ROOT: resolve(runRoot, "synthetic")
    },
    pid: process.pid, platform: "win32", execPath: process.execPath
  }, { error: (...values) => log.push(`error:${values.join(" ")}`) });
  const deadline = Date.now() + 15000;
  while (!(states.some((entry) => entry.state.phase === "done") && log.includes("snapshot"))) {
    assert.ok(Date.now() < deadline, `timed out; states=${JSON.stringify(states.map((entry) => entry.state))}; log=${log.join(",")}`);
    await new Promise((done) => setTimeout(done, 5));
  }
  assert.ok(states.some((entry) => entry.state.phase === "done"), "the profile-less branch pushes the bootstrap done signal");
  const current = await handlers.get("goalport:bootstrap-current")(trustedEvent(windows[0]));
  assert.equal(current.phase, "done", "bootstrap-current answers done, not a permanent checking");
  assert.equal(current.diagnostics, undefined, "the profile-less branch has no profile-inspect diagnostics child");
  assert.ok(log.includes("snapshot"), "the Core attach serves snapshots as usual");
  const userData = setPathCalls.filter(([name]) => name === "userData");
  assert.deepEqual(userData, [["userData", resolve(dirname(db), "electron-userData")]], "isolated userData stays the run-owned electron-userData directory");
});

// ---- Regression pin: the smoke driver's storage-boundary judgements are
// EXECUTED here against real file layouts. The 76ea6cd CI failure
// (ReferenceError: relative is not defined inside the smoke's
// storage-boundary stage) escaped every local check because the driver is a
// top-level script that node --check/--help/unit suites never actually run
// past argument parsing. The judgements now live in an importable module and
// these tests drive the exact containment branch the packaged smoke uses.

test("smoke storage-boundary: browser containment judged from the canonical owner root on a real layout", (t) => {
  const root = fixture(t);
  // Normal shape: the browser namespace inside the relocated app-data root.
  const appDataRoot = resolve(root, "appdata-root");
  const normalBrowser = resolve(appDataRoot, "GoalPort", "electron", "a".repeat(20));
  mkdirSync(normalBrowser, { recursive: true });
  assert.equal(browserStateContainedIn({ ownerRoot: appDataRoot, directory: normalBrowser }), true, "normal browser state is inside the app-data root");
  // Synthetic shape: the owner is the CANONICAL durable parent the path model
  // derived the browser namespace from, and the browser directory really
  // exists under it.
  const synthetic = resolveProfilePaths({ appData: appDataRoot, coreSha256: hash, args: { "--test-profile": resolve(root, "scratch", "profile") } });
  mkdirSync(synthetic.browserStateDirectory, { recursive: true });
  const canonicalOwner = realpathSync.native(dirname(synthetic.durableDirectory));
  assert.equal(browserStateContainedIn({ ownerRoot: canonicalOwner, directory: synthetic.browserStateDirectory }), true, "synthetic browser state is inside the canonical scratch root");
  assert.equal(browserStateContainedIn({ ownerRoot: canonicalOwner, directory: synthetic.durableDirectory }), true, "the synthetic durable root itself is inside the same scratch");
  // Refusals: outside the owner, and the owner directory itself.
  const outside = resolve(root, "elsewhere", "electron", "b".repeat(20));
  mkdirSync(outside, { recursive: true });
  assert.equal(browserStateContainedIn({ ownerRoot: canonicalOwner, directory: outside }), false, "a browser root outside the owner is refused");
  assert.equal(browserStateContainedIn({ ownerRoot: canonicalOwner, directory: canonicalOwner }), false, "the owner directory itself is not containment");
  // An alternate 8.3-style spelling of the owner must not change the verdict.
  assert.equal(browserStateContainedIn({ ownerRoot: dirname(synthetic.durableDirectory), directory: synthetic.browserStateDirectory }), true, "the literal (non-canonical) owner spelling gives the same verdict");
});

test("smoke storage-boundary: the durable allowlist accepts exactly the durable contract entries", () => {
  for (const allowed of [
    "goalport-profile.json", "goalport.sqlite", "goalport.sqlite-wal", "goalport.sqlite-shm",
    "goalport.sqlite.launcher.log", "goalport.sqlite.core.log", "goalport.sqlite.launch-ready",
    "import-journal.json", "backups", ".import-staging-2026-09-22T00-00-00-000Z"
  ]) assert.equal(durableStorageEntryAllowed(allowed), true, allowed);
  for (const refused of [
    "Cache", "Code Cache", "GPUCache", "Local State", "Preferences", "Network", "blob_storage",
    "DevToolsActivePort", "DIPS", "DIPS-wal", "window-state.json", "SomeEntirelyNewBrowserStateFile", "userfile.txt"
  ]) assert.equal(durableStorageEntryAllowed(refused), false, refused);
});
