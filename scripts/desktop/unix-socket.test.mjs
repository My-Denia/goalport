import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { coreConnectEndpoint, coreServePipe, windowsPipeName, resolveUnixSocket } = require("../../electron/launch-config.cjs");

const home = { HOME: "/home/user" };

test("an absolute Linux socket stays the configured path", () => {
  assert.equal(coreConnectEndpoint("linux", "/tmp/goalport.sock", home), "/tmp/goalport.sock");
  assert.equal(coreServePipe("linux", "/tmp/goalport.sock"), "/tmp/goalport.sock");
  const prefixed = windowsPipeName("/tmp/goalport.sock");
  assert.notEqual(resolveUnixSocket(prefixed, home), "/tmp/goalport.sock");
});

test("a named Linux endpoint is hashed from the original name", () => {
  const connected = coreConnectEndpoint("linux", "goalport-core-v1", home);
  assert.equal(connected.startsWith("/home/user/.goalport/runtime/"), true);
  assert.equal(connected.includes("goalport-core-v1"), true);
  assert.equal(coreServePipe("linux", "goalport-core-v1"), "goalport-core-v1");
  assert.notEqual(connected, coreConnectEndpoint("linux", windowsPipeName("goalport-core-v1"), home));
});

test("Windows keeps the named-pipe prefix", () => {
  assert.equal(coreConnectEndpoint("win32", "goalport-core-v1"), "\\\\.\\pipe\\goalport-core-v1");
  assert.equal(coreServePipe("win32", "\\\\.\\pipe\\goalport-core-v1"), "\\\\.\\pipe\\goalport-core-v1");
});
