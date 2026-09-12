import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import { spawn } from "node:child_process";
const require = createRequire(import.meta.url);
const { launchArguments, prepareProfile, assertCoreIdentity, childEnvironment, normalizedPath } = require("../../electron/launch-config.cjs");
const { invokeCoreRequest, acknowledgedStopSnapshot } = require("../../electron/core-client.cjs");

const hash = "a".repeat(64);
function fixture(t) {
  const root = mkdtempSync(resolve(tmpdir(), "goalport-launch-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
const settings = (root, args = {}) => ({ appData: root, version: "1.0.0-rc.1", coreSha256: hash, args });

test("real Electron entrypoint presents startup refusals before readiness or profile adoption", (t) => {
  const root = fixture(t);
  const mainFile = resolve("electron/main.cjs");
  const mainRequire = createRequire(mainFile);
  const main = vm.runInThisContext(`(function(require,module,exports,__dirname,process,console){${readFileSync(mainFile, "utf8")}\n})`, { filename: mainFile });
  for (const kind of ["missing-core", "invalid-argument", "wrong-profile"]) {
    const resources = resolve(root, kind, "resources");
    const data = resolve(root, kind, "profile");
    mkdirSync(resources, { recursive: true });
    mkdirSync(data, { recursive: true });
    if (kind === "wrong-profile") {
      writeFileSync(resolve(resources, "goalport-core.exe"), "test-only Core identity; never executed");
      writeFileSync(resolve(data, "goalport-profile.json"), JSON.stringify({ schemaVersion: 1, product: "GoalPort", mode: "normal", version: "1.0.0-rc.1", coreSha256: "b".repeat(64) }));
    }
    const preimage = readdirSync(data).map((name) => [name, readFileSync(resolve(data, name), "utf8")]);
    const dialogs = [], exits = [], logs = [];
    const electron = {
      app: { isPackaged: true, getVersion: () => "1.0.0-rc.1", getPath: () => data, exit: (code) => exits.push(code), whenReady: () => assert.fail("refusal cannot start the ready path") },
      dialog: { showErrorBox: (title, message) => dialogs.push({ title, message }) }
    };
    main((name) => name === "electron" ? electron : mainRequire(name), { exports: {} }, {}, resolve("electron"), {
      argv: ["GoalPort.exe", "--data-dir", kind === "invalid-argument" ? "relative" : data], resourcesPath: resources, env: {}
    }, { error: (...args) => logs.push(args.map(String).join(" ")) });
    assert.deepEqual(exits, [1]);
    assert.equal(dialogs.length, 1);
    assert.equal(dialogs[0].title, "GoalPort could not start");
    assert.match(dialogs[0].message, kind === "missing-core" ? /Core identity is unavailable/ : kind === "invalid-argument" ? /absolute path/ : /another RC build/);
    assert.match(logs.join("\n"), /GoalPort startup refused/);
    assert.deepEqual(readdirSync(data).map((name) => [name, readFileSync(resolve(data, name), "utf8")]), preimage);
  }
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
});

test("normal RC starts in product data and test profile has a different pipe", (t) => {
  const root = fixture(t);
  const normal = prepareProfile(settings(root));
  const synthetic = prepareProfile(settings(root, { "--test-profile": resolve(root, "isolated") }));
  assert.equal(normal.directory, realpathSync.native(resolve(root, "GoalPort/rc")));
  assert.equal(normal.testMode, false);
  assert.equal(synthetic.testMode, true);
  assert.notEqual(normal.pipe, synthetic.pipe);
  assert.notEqual(normal.pipe, "\\\\.\\pipe\\goalport-core-v1");
  assert.deepEqual(prepareProfile(settings(root)), normal);
  assert.deepEqual(prepareProfile(settings(realpathSync.native(root))), normal);
});

test("development and packaged defaults coexist with different Core identities", (t) => {
  for (const order of [[true, false], [false, true]]) {
    const root = fixture(t);
    const profiles = new Map();
    for (const isPackaged of order) {
      profiles.set(isPackaged, prepareProfile({ ...settings(root), isPackaged, coreSha256: (isPackaged ? "a" : "b").repeat(64) }));
    }
    const rc = profiles.get(true), dev = profiles.get(false);
    assert.equal(rc.directory, realpathSync.native(resolve(root, "GoalPort/rc")));
    assert.equal(dev.directory, realpathSync.native(resolve(root, "GoalPort/dev")));
    assert.notEqual(rc.pipe, dev.pipe);
    assert.equal(dev.testMode, false, "development is not synthetic mode");
    writeFileSync(rc.database, "preserve packaged RC database bytes");
    const before = readdirSync(rc.directory).map((name) => [name, readFileSync(resolve(rc.directory, name), "utf8")]);
    assert.deepEqual(prepareProfile({ ...settings(root), isPackaged: false, coreSha256: "b".repeat(64) }), dev);
    assert.deepEqual(prepareProfile({ ...settings(root), isPackaged: true }), rc);
    assert.deepEqual(readdirSync(rc.directory).map((name) => [name, readFileSync(resolve(rc.directory, name), "utf8")]), before);
    assert.throws(() => prepareProfile({ ...settings(root, { "--data-dir": rc.directory }), isPackaged: false, coreSha256: "b".repeat(64) }), /another RC build/);
    assert.deepEqual(readdirSync(rc.directory).map((name) => [name, readFileSync(resolve(rc.directory, name), "utf8")]), before);
  }
});

test("explicit normal and synthetic profile paths keep precedence in development", (t) => {
  const root = fixture(t);
  const args = { "--data-dir": resolve(root, "explicit") };
  assert.deepEqual(prepareProfile({ ...settings(root, args), isPackaged: false }), prepareProfile({ ...settings(root, args), isPackaged: true }));
  const syntheticArgs = { "--test-profile": resolve(root, "synthetic") };
  const devTest = prepareProfile({ ...settings(root, syntheticArgs), isPackaged: false });
  assert.equal(devTest.testMode, true);
  assert.deepEqual(devTest, prepareProfile({ ...settings(root, syntheticArgs), isPackaged: true }));
});

test("the actual Electron entrypoint passes its packaged state to profile selection", (t) => {
  const root = fixture(t);
  const mainFile = resolve("electron/main.cjs");
  const mainRequire = createRequire(mainFile);
  const main = vm.runInThisContext(`(function(require,module,exports,__dirname,process,console){${readFileSync(mainFile, "utf8")}\n})`, { filename: mainFile });
  writeFileSync(resolve(root, "goalport-core.exe"), "inert identity fixture, never executed");
  for (const isPackaged of [false, true]) {
    let seen;
    const electron = { app: { isPackaged, getVersion: () => "1.0.0-rc.1", getPath: () => root, exit: () => {}, whenReady: () => assert.fail("fixture stops before readiness") }, dialog: { showErrorBox: () => {} } };
    main((name) => name === "electron" ? electron : name === "./launch-config.cjs" ? {
      ...mainRequire(name), prepareProfile: (options) => { seen = options; throw new Error("fixture stops after profile option capture"); }
    } : mainRequire(name), { exports: {} }, {}, resolve("electron"), { argv: ["Electron.exe"], resourcesPath: root, env: { GOALPORT_CORE_BIN: resolve(root, "goalport-core.exe") } }, { error: () => {} });
    assert.equal(seen?.isPackaged, isPackaged);
  }
});

function virtualProfiles(onWrite, onRead) {
  const directories = new Set(), files = new Map();
  const missing = () => Object.assign(new Error("missing fixture path"), { code: "ENOENT" });
  const fs = {
    existsSync: (name) => directories.has(name) || files.has(name),
    mkdirSync: (name) => directories.add(name),
    realpathSync: { native: (name) => { if (!fs.existsSync(name)) throw missing(); return name; } },
    readdirSync: (name) => [...files.keys()].filter((file) => resolve(file, "..") === name).map((file) => file.slice(name.length + 1)),
    readFileSync: (name) => { if (!files.has(name)) throw missing(); return onRead ? onRead(name, files) : files.get(name); },
    writeFileSync: (name, text, options) => {
      onWrite?.(name, text, files);
      if (options?.flag === "wx" && files.has(name)) throw Object.assign(new Error("fixture marker race"), { code: "EEXIST" });
      files.set(name, String(text));
    }
  };
  const module = { exports: {} };
  vm.runInNewContext(readFileSync(resolve("electron/launch-config.cjs"), "utf8"), { module, exports: module.exports, require: (name) => name === "node:fs" ? fs : require(name) });
  return { ...module.exports, files };
}

test("distinct canonical profile identities cannot share a pipe or accept another database", () => {
  // A case-sensitive filesystem model; real ordinary/8.3 aliases are tested separately.
  const api = virtualProfiles();
  const root = resolve("canonical-profile-fixture");
  const a = api.prepareProfile(settings(root, { "--data-dir": resolve(root, "Foo") }));
  const b = api.prepareProfile(settings(root, { "--data-dir": resolve(root, "foo") }));
  api.files.set(a.database, "database A"); api.files.set(b.database, "database B");
  assert.notEqual(a.pipe, b.pipe);
  assert.doesNotThrow(() => api.assertCoreIdentity({ startupState: "READY_COMMITTED", core: { executableSha256: hash }, databaseIdentity: a.database, pipeIdentity: a.pipe }, a));
  assert.throws(() => api.assertCoreIdentity({ startupState: "READY_COMMITTED", core: { executableSha256: hash }, databaseIdentity: a.database, pipeIdentity: b.pipe }, b), /attachment refused/);
});

test("a marker creation loser validates the complete winning profile without overwriting it", () => {
  for (const winner of ["same", "other-build", "other-mode"]) {
    let winningText;
    const api = virtualProfiles((name, text, files) => {
      const marker = JSON.parse(text);
      if (winner === "other-build") marker.coreSha256 = "b".repeat(64);
      if (winner === "other-mode") marker.mode = "synthetic-test";
      winningText = JSON.stringify(marker); files.set(name, winningText);
    });
    const options = settings(resolve("profile-race-" + winner));
    if (winner === "same") assert.doesNotThrow(() => api.prepareProfile(options));
    else assert.throws(() => api.prepareProfile(options), winner === "other-build" ? /another RC build/ : /different profile/);
    assert.equal([...api.files.values()][0], winningText);
  }
});

test("incomplete winner writes are bounded, and old or invalid identity metadata is never adopted", () => {
  let reads = 0;
  const partial = virtualProfiles((name, text, files) => files.set(name, text), (name, files) => ++reads < 3 ? "{" : files.get(name));
  assert.doesNotThrow(() => partial.prepareProfile(settings(resolve("partial-marker-fixture"))));
  assert.equal(reads, 3);
  for (const kind of ["old-identity", "moved-identity", "invalid-json"]) {
    let winner;
    const api = virtualProfiles((name, text, files) => {
      const data = JSON.parse(text);
      if (kind === "old-identity") { delete data.identityVersion; delete data.profileKey; }
      if (kind === "moved-identity") data.profileKey = "other-directory";
      winner = kind === "invalid-json" ? "{" : JSON.stringify(data); files.set(name, winner);
    });
    assert.throws(() => api.prepareProfile(settings(resolve("invalid-marker-" + kind))), kind === "invalid-json" ? (error) => error.name === "SyntaxError" : /older or different path identity/);
    assert.equal([...api.files.values()][0], winner);
  }
});

test("real concurrent first-profile writers converge on one matching marker", { timeout: 20_000 }, async (t) => {
  const root = fixture(t), profile = resolve(root, "profile"), marker = resolve(profile, "goalport-profile.json"), gate = resolve(root, "write.gate");
  const moduleFile = resolve("electron/launch-config.cjs");
  const children = [];
  const code = `const fs=require('node:fs');const marker=${JSON.stringify(marker)},gate=${JSON.stringify(gate)};const write=fs.writeFileSync;fs.writeFileSync=function(name,text,options){if(name===marker&&options?.flag==='wx'){process.stdout.write('ready\\n');const end=Date.now()+10000;while(!fs.existsSync(gate)){if(Date.now()>end)throw Error('gate timed out');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);}}return write.apply(this,arguments);};try{const p=require(${JSON.stringify(moduleFile)}).prepareProfile(${JSON.stringify(settings(root, { "--data-dir": profile }))});process.stdout.write(JSON.stringify(p)+'\\n');}catch(e){process.stderr.write(String(e.stack));process.exitCode=1;}`;
  try {
    const records = Array.from({ length: 4 }, () => {
      const child = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); children.push(child);
      let stdout = "", stderr = "", readyResolve, readyReject;
      const ready = new Promise((resolveReady, rejectReady) => { readyResolve = resolveReady; readyReject = rejectReady; });
      child.stdout.on("data", (data) => { stdout += data; if (stdout.includes("ready" + String.fromCharCode(10))) readyResolve(); });
      child.stderr.on("data", (data) => { stderr += data; });
      const completed = new Promise((resolveDone, rejectDone) => {
        child.once("error", (error) => { readyReject(error); rejectDone(error); });
        child.once("exit", (code) => { if (!stdout.includes("ready" + String.fromCharCode(10))) readyReject(new Error(stderr || "child exited before barrier")); resolveDone({ code, stdout, stderr }); });
      });
      return { ready, completed };
    });
    await Promise.all(records.map((record) => record.ready));
    writeFileSync(gate, "release all matching writers");
    const results = await Promise.all(records.map((record) => record.completed));
    for (const result of results) assert.equal(result.code, 0, result.stderr);
    const profiles = results.map((result) => JSON.parse(result.stdout.split(String.fromCharCode(10)).filter(Boolean).at(-1)));
    for (const value of profiles) assert.deepEqual(value, profiles[0]);
    assert.equal(JSON.parse(readFileSync(marker, "utf8")).coreSha256, hash);
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
  }
});

test("legacy DB, mode change and changed build refuse without touching preimages", (t) => {
  const root = fixture(t);
  const db = resolve(root, "goalport.sqlite");
  writeFileSync(db, "historic database");
  assert.throws(() => prepareProfile(settings(root, { "--data-dir": root })), /legacy databases/);
  assert.equal(readFileSync(db, "utf8"), "historic database");
  const profile = prepareProfile(settings(root));
  const marker = readFileSync(resolve(profile.directory, "goalport-profile.json"), "utf8");
  assert.throws(() => prepareProfile(settings(root, { "--test-profile": profile.directory })), /different profile/);
  assert.throws(() => prepareProfile({ ...settings(root), coreSha256: "b".repeat(64) }), /another RC build/);
  assert.equal(readFileSync(resolve(profile.directory, "goalport-profile.json"), "utf8"), marker);
});

test("attachment requires committed startup receipt, matching database, pipe and Core hash", (t) => {
  const root = fixture(t);
  const profile = prepareProfile(settings(root));
  const receipt = { startupState: "READY_COMMITTED", core: { executableSha256: hash }, databaseIdentity: profile.database, pipeIdentity: profile.pipe };
  assert.doesNotThrow(() => assertCoreIdentity(receipt, profile));
  for (const wrong of [
    { ...receipt, startupState: "STARTUP_PENDING" }, { ...receipt, core: { executableSha256: "b".repeat(64) } },
    { ...receipt, databaseIdentity: resolve(root, "old.sqlite") }, { ...receipt, pipeIdentity: "\\\\.\\pipe\\goalport-core-v1" }
  ]) assert.throws(() => assertCoreIdentity(wrong, profile), /attachment refused/);
});

test("normal environment ignores historical test identity while native configuration remains owned", (t) => {
  const profile = prepareProfile(settings(fixture(t)));
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
