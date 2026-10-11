"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { backgroundStartReply } = require("./coordination-background.cjs");

const mainSource = fs.readFileSync(require.resolve("./main.cjs"), "utf8");
const preloadSource = fs.readFileSync(require.resolve("./preload.cjs"), "utf8");
const outstandingMessage = "This profile has an outstanding background goal. Return to that job or stop allowing its access; no competing work was admitted.";
const refusalCodes = [
  "background-unavailable",
  "background-consent-required",
  "background-start-in-progress",
  "background-scope-conflict",
  "background-core-refused",
  "background-preflight-failed",
  "background-invalid-admission",
  "background-job-conflict",
  "background-admission-unknown",
];

function loadPreload(marker) {
  const exposed = {};
  const invocations = [];
  const href = "file:///trusted/goalport/index.html";
  const context = {
    require: name => {
      assert.equal(name, "electron");
      return {
        contextBridge: { exposeInMainWorld: (name, value) => { exposed[name] = value; } },
        ipcRenderer: {
          invoke: (channel, ...args) => {
            invocations.push({ channel, args });
            return channel === "goalport:background-start" ? Promise.resolve(marker) : Promise.resolve(null);
          },
          on() {},
          removeListener() {},
        },
      };
    },
    process: { argv: ["electron", `--goalport-app-document=${encodeURIComponent(href)}`], isMainFrame: true },
    globalThis: { location: { href } },
    URL,
    console: { error() {} },
    Math,
    Date,
    Error: new Proxy(Error, { construct() { throw new Error("preload must not construct an Error for a refusal marker"); } }),
  };
  vm.runInNewContext(preloadSource, context, { filename: "preload.cjs" });
  return { exposed, invocations };
}

function extractMainFunction(name) {
  const start = mainSource.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} exists in main.cjs`);
  const open = mainSource.indexOf("{", start);
  assert.notEqual(open, -1);
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = open; index < mainSource.length; index += 1) {
    const character = mainSource[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "\"" || character === "'" || character === "`") { quote = character; continue; }
    if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return mainSource.slice(start, index + 1);
  }
  throw new Error(`Could not extract ${name} from main.cjs`);
}
function loadCoreCommandCallback(backgroundHost, invokeCore) {
  const registration = /handleTrusted\("goalport:core-command",\s*(\(_, request\) => guardedCoreCommand\(request\))\);/.exec(mainSource);
  assert.ok(registration, "main core-command handler delegates to guardedCoreCommand");
  const guardedCoreCommand = vm.runInNewContext(`(${extractMainFunction("guardedCoreCommand")})`, { backgroundHost, invokeCore });
  return vm.runInNewContext(`(${registration[1]})`, { guardedCoreCommand });
}

test("backgroundStartReply passes success through and serializes every classified refusal code", async () => {
  const status = { jobId: "job", active: true, live: false };
  assert.equal(await backgroundStartReply({ start: async () => status }, {}), status);
  for (const code of refusalCodes) {
    const reply = await backgroundStartReply({ start: async () => { throw Object.assign(new Error(`message:${code}`), { code }); } }, { requestId: "one-send" });
    assert.deepEqual(JSON.parse(JSON.stringify(reply)), { backgroundStartRefused: true, code, message: `message:${code}` });
  }
  const unclassified = await backgroundStartReply({ start: async () => { throw Object.assign(new Error("disk failure"), { code: "EIO" }); } }, {});
  assert.deepEqual(JSON.parse(JSON.stringify(unclassified)), {
    backgroundStartRefused: true,
    code: "background-admission-unknown",
    message: "disk failure",
  });
  const malformedThrownValue = new Proxy({}, { get(_target, property) { if (property === "code" || property === "message") throw new Error("unreadable property"); return undefined; } });
  const malformed = await backgroundStartReply({ start: async () => { throw malformedThrownValue; } }, {});
  assert.deepEqual(JSON.parse(JSON.stringify(malformed)), {
    backgroundStartRefused: true,
    code: "background-admission-unknown",
    message: "GoalPort could not confirm this background start.",
  });
});

test("the actual main background-start callback returns the adapter value", async () => {
  const registration = /handleTrusted\("goalport:background-start",\s*(\(_, input\) => backgroundStartReply\(backgroundHost, input\))\);/.exec(mainSource);
  assert.ok(registration, "main background-start handler delegates to backgroundStartReply");
  const marker = { backgroundStartRefused: true, code: "background-preflight-failed", message: "nothing admitted" };
  const backgroundHost = { start: async () => { throw Object.assign(new Error(marker.message), { code: marker.code }); } };
  const callback = vm.runInNewContext(`(${registration[1]})`, { backgroundStartReply, backgroundHost });
  assert.deepEqual(JSON.parse(JSON.stringify(await callback({}, { requestId: "one-send" }))), marker);
});

test("preload forwards the resolved refusal marker unchanged without throwing or constructing Error", async () => {
  const marker = { backgroundStartRefused: true, code: "background-job-conflict", message: "No replacement was started." };
  const { exposed, invocations } = loadPreload(marker);
  const input = { requestId: "one-send", executionFeedback: { previousCommandIds: [] } };
  const reply = await exposed.goalportCore.backgroundStart(input);
  assert.equal(reply, marker);
  assert.deepEqual(invocations.at(-1), { channel: "goalport:background-start", args: [input] });
});

test("main core-command handler returns the exact guard envelope and never invokes Core while busy", async () => {
  let coreCalls = 0;
  const backgroundHost = { outstanding: () => true };
  const invokeCore = request => { coreCalls += 1; return { accepted: true, requestId: request.requestId }; };
  const guardedCoreCommand = loadCoreCommandCallback(backgroundHost, invokeCore);
  const request = { protocolVersion: "goalport.ipc.v2", requestId: "same-request", messageType: "start_conversation", payload: {} };
  const envelope = guardedCoreCommand({}, request);
  assert.deepEqual(JSON.parse(JSON.stringify(envelope)), {
    goalportRejected: true,
    requestId: "same-request",
    error: outstandingMessage,
    rejection: {
      code: "background-job-outstanding",
      message: outstandingMessage,
      deliveryState: "FAILED",
      nativeDispatchState: "NOT_STARTED",
      retryMode: "NEW_REQUEST",
      reservation: null,
    },
  });
  assert.equal(coreCalls, 0);
  assert.equal(request.requestId, "same-request");
});

test("main core-command guard invokes Core when clear and leaves guard exceptions uncoded and unrelabeled", async () => {
  let coreCalls = 0;
  const request = { requestId: "same-request", messageType: "conversation_send", payload: {} };
  const backgroundHost = { outstanding: () => false };
  const invokeCore = value => { coreCalls += 1; return { accepted: true, requestId: value.requestId }; };
  const guardedCoreCommand = loadCoreCommandCallback(backgroundHost, invokeCore);
  assert.deepEqual(JSON.parse(JSON.stringify(guardedCoreCommand({}, request))), { accepted: true, requestId: "same-request" });
  assert.equal(coreCalls, 1);

  const guardError = Object.assign(new Error("outstanding state unavailable"), { code: "EIO" });
  const throwingHost = { outstanding: () => { throw guardError; } };
  const throwingGuard = loadCoreCommandCallback(throwingHost, invokeCore);
  assert.throws(() => throwingGuard({}, request), error => error === guardError && error.code === "EIO");
  assert.equal(request.requestId, "same-request");
  assert.equal(coreCalls, 1);

  const coreError = Object.assign(new Error("Core transport failed"), { code: "transport-error" });
  const coreFailureGuard = loadCoreCommandCallback({ outstanding: () => false }, () => Promise.reject(coreError));
  await assert.rejects(coreFailureGuard({}, request), error => error === coreError && error.code === "transport-error");
});
