"use strict";
const fs = require("node:fs");
const path = require("node:path");
const CONSENT_FILE = "background-send-consent.json";

// Profile capability to spend subscription quota on coordinated harness turns,
// in this window or after closing. Every background goal still needs its own
// backgroundConsent; scoped access and write permissions remain separate.
// Grant is an exclusive durable fact; deleting the file revokes future starts,
// not an already admitted goal (which has its own revoke control).
function createBackgroundSendConsentStore(directory, options = {}) {
  const fsApi = options.fs ?? fs;
  const file = path.join(directory, CONSENT_FILE);
  function syncDirectory() {
    let descriptor;
    try { descriptor = fsApi.openSync(directory, "r"); fsApi.fsyncSync(descriptor); }
    catch { /* Directory fsync is unavailable on some supported filesystems. */ }
    finally { if (descriptor !== undefined) { try { fsApi.closeSync(descriptor); } catch { /* best effort */ } } }
  }
  function read() {
    try {
      const value = JSON.parse(fsApi.readFileSync(file, "utf8"));
      if (value?.allowed === true && typeof value.grantedAt === "string" && Number.isFinite(Date.parse(value.grantedAt))) {
        return { allowed: true, grantedAt: value.grantedAt };
      }
    } catch { /* Missing, unreadable or incomplete consent is never permission. */ }
    return { allowed: false };
  }
  function grant() {
    fsApi.mkdirSync(directory, { recursive: true, mode: 0o700 });
    let descriptor;
    try {
      descriptor = fsApi.openSync(file, "wx", 0o600);
      fsApi.writeFileSync(descriptor, `${JSON.stringify({ allowed: true, grantedAt: (options.now ?? (() => new Date().toISOString()))() }, null, 2)}\n`);
      fsApi.fsyncSync(descriptor);
      fsApi.closeSync(descriptor);
      descriptor = undefined;
      syncDirectory();
    } catch (error) {
      if (descriptor !== undefined) { try { fsApi.closeSync(descriptor); } catch { /* retain original failure */ } }
      if (error?.code !== "EEXIST") throw error;
      // Do not overwrite an existing or interrupted grant; revoke first.
    }
    const consent = read();
    if (!consent.allowed) throw new Error("Background Send consent could not be saved. Revoke the incomplete grant before trying again.");
    return consent;
  }
  function revoke() {
    try { fsApi.unlinkSync(file); syncDirectory(); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    return read();
  }
  function act(action) {
    if (action === "read") return read();
    if (action === "grant") return grant();
    if (action === "revoke") return revoke();
    throw new Error("Unknown background Send consent action.");
  }
  return { read, grant, revoke, act };
}
module.exports = { CONSENT_FILE, createBackgroundSendConsentStore };
