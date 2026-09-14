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
      assert.deepEqual(args, ["pipe-peer", "--pipe", profile.pipe]);
      assert.equal(options.timeout, 5000);
      log.push("peer");
      setImmediate(() => callback(null, okPeer(peerPid), ""));
    }
  };
  const windows = [], handlers = new Map(), dialogs = [];
  class FakeWindow {
    constructor() { this.webContents = { send: () => {}, executeJavaScript: async () => {} }; windows.push(this); }
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
  profile = prepareProfile({ args: launchArguments(args), appData: root, version: "1.0.0-rc.1", coreSha256, isPackaged: true });
  main(fakeRequire, { exports: {} }, {}, resolve("electron"), { argv: args, resourcesPath: resources, env: {}, pid: 1234, platform: "win32", execPath: process.execPath }, { error: (...values) => dialogs.push(values.join(" ")) });
  const until = async (condition) => {
    const deadline = Date.now() + 5000;
    while (!condition()) { assert.ok(Date.now() < deadline, `timed out; log=${log.join(",")}`); await new Promise((done) => setTimeout(done, 5)); }
  };
  await until(() => windows.length === 1 && log.includes("snapshot"));
  assert.deepEqual(log, ["peer", "get_startup_receipt", "snapshot"], "startup attachment verifies before the first snapshot");

  const request = (messageType, requestId) => ({ protocolVersion: "goalport.ipc.v2", requestId, entityVersion: 0, messageType, payload: {} });
  log.length = 0;
  await handlers.get("goalport:core-command")(null, request("send_message", "send-1"));
  assert.deepEqual(log, ["peer", "get_startup_receipt", "send_message"]);

  log.length = 0;
  await handlers.get("goalport:core-snapshot")(null, request("snapshot", "poll-1"));
  assert.deepEqual(log, ["snapshot"], "a snapshot poll with no prior failure is not re-verified");

  log.length = 0;
  failSnapshot = true;
  await handlers.get("goalport:core-snapshot")(null, request("snapshot", "poll-2"));
  assert.deepEqual(log, ["snapshot", "peer", "get_startup_receipt", "snapshot"], "a failed snapshot re-verifies before its retry");

  log.length = 0;
  peerPid = 9999;
  await assert.rejects(handlers.get("goalport:core-command")(null, request("safe_stop", "stop-1")), /could not be verified/);
  assert.deepEqual(log, ["peer", "get_startup_receipt"], "a server whose PID is not the receipt Core receives no mutation");
  peerPid = 4242;

  log.length = 0;
  const closed = await handlers.get("goalport:confirm-close-choice")({ sender: {} }, { choice: "continue", requestId: "close-1" });
  assert.equal(closed.ok, true, JSON.stringify(closed));
  assert.deepEqual(log, ["peer", "get_startup_receipt", "snapshot", "peer", "get_startup_receipt", "record_close_choice"]);
});
