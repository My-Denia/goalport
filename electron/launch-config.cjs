const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const hash = (value) => createHash("sha256").update(value).digest("hex");
function canonicalPath(value) {
  const absolute = path.resolve(value);
  let ancestor = absolute;
  while (true) {
    try {
      // The native Windows API expands 8.3 aliases; the JS realpath fallback
      // can leave them intact. The database itself may not exist yet.
      return path.join(fs.realpathSync.native(ancestor), path.relative(ancestor, absolute));
    } catch {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) return absolute;
      ancestor = parent;
    }
  }
}
const normalizedPath = (value) => canonicalPath(value).replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "").replaceAll("/", "\\");

function validateProfileMarker(marker, { mode, coreSha256, version, profileKey }) {
  const deadline = Date.now() + 1000;
  let existing;
  while (true) {
    try {
      existing = JSON.parse(fs.readFileSync(marker, "utf8"));
      break;
    } catch (error) {
      // An exclusive creator may have opened the file but not finished its
      // first write. Never overwrite it; wait briefly for a complete marker.
      if (!(error instanceof SyntaxError || error.code === "ENOENT") || Date.now() >= deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  if (existing?.product !== "GoalPort" || existing.schemaVersion !== 1 || existing.mode !== mode) throw new Error("This data directory belongs to a different profile; choose a new directory");
  if (existing.coreSha256 !== coreSha256 || existing.version !== version) throw new Error("This data profile belongs to another RC build. Choose a new --data-dir; automatic migration is not supported");
  if (existing.identityVersion !== 2 || existing.profileKey !== profileKey) throw new Error("This data profile uses an older or different path identity. Choose a new --data-dir; automatic migration is not supported");
}

function launchArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!["--data-dir", "--test-profile"].includes(key)) continue;
    if (result[key] || !argv[index + 1] || argv[index + 1].startsWith("--")) throw new Error(`Missing or repeated ${key}`);
    result[key] = argv[++index];
    if (!path.isAbsolute(result[key])) throw new Error(`${key} must be an absolute path`);
  }
  if (result["--data-dir"] && result["--test-profile"]) throw new Error("Normal data and a synthetic test profile cannot be combined");
  return result;
}

// Normal RC state has a new product-owned location. Existing arbitrary/legacy
// SQLite files are never adopted or migrated just because they are nearby.
function prepareProfile({ args, appData, version, coreSha256, isPackaged = true }) {
  if (!/^[a-f0-9]{64}$/.test(coreSha256)) throw new Error("Packaged Core identity is unavailable");
  const mode = args["--test-profile"] ? "synthetic-test" : "normal";
  const directory = path.resolve(args["--test-profile"] || args["--data-dir"] || path.join(appData, "GoalPort", isPackaged ? "rc" : "dev"));
  const marker = path.join(directory, "goalport-profile.json");
  if (fs.existsSync(directory) && !fs.existsSync(marker) && fs.readdirSync(directory).length && !fs.existsSync(marker)) {
    throw new Error("Data directory is not an empty or existing GoalPort RC profile; legacy databases are not imported");
  }
  fs.mkdirSync(directory, { recursive: true });
  const canonical = fs.realpathSync.native(directory);
  const key = hash(normalizedPath(canonical)).slice(0, 20);
  try {
    fs.writeFileSync(marker, `${JSON.stringify({ schemaVersion: 1, identityVersion: 2, profileKey: key, product: "GoalPort", version, coreSha256, mode }, null, 2)}\n`, { flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    validateProfileMarker(marker, { mode, coreSha256, version, profileKey: key });
  }
  const slug = `goalport-rc-${key}`;
  return {
    mode, directory: canonical, database: path.join(canonical, "goalport.sqlite"),
    pipe: `\\\\.\\pipe\\${slug}-${coreSha256.slice(0, 20)}`, slug,
    coreSha256, version, testMode: mode === "synthetic-test"
  };
}

function assertCoreIdentity(receipt, profile) {
  if (!receipt || receipt.startupState !== "READY_COMMITTED" || receipt.core?.executableSha256 !== profile.coreSha256 ||
      !receipt.databaseIdentity || normalizedPath(receipt.databaseIdentity) !== normalizedPath(profile.database) ||
      String(receipt.pipeIdentity).toLowerCase() !== profile.pipe.toLowerCase()) {
    throw new Error("Core identity does not match this RC package and data profile; attachment refused");
  }
}

const PIPE_PEER_SCHEMA = "goalport.pipe-peer.v1";
const PIPE_PEER_REFUSAL = "Core pipe server identity could not be verified; attachment refused";

// Parses the single stdout line of `goalport-core pipe-peer`; anything else is null.
function parsePipePeer(stdout) {
  if (typeof stdout !== "string") return null;
  const line = stdout.endsWith("\r\n") ? stdout.slice(0, -2) : stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
  if (!line || /[\r\n]/.test(line)) return null;
  let value;
  try { value = JSON.parse(line); } catch { return null; }
  return value && typeof value === "object" && value.schema === PIPE_PEER_SCHEMA ? value : null;
}

function pipePeerBusy(stdout) {
  const peer = parsePipePeer(stdout);
  return peer?.ok === false && peer.stage === "busy";
}

// The pipe server must be proven to run as this user (pipe-peer ok) and be the
// Core process that committed the startup receipt.
function assertPipePeer(peerStdout, receipt) {
  const peer = parsePipePeer(peerStdout);
  if (!peer || peer.ok !== true || !Number.isSafeInteger(peer.serverPid) || peer.serverPid <= 0 ||
      receipt?.core?.pid !== peer.serverPid) {
    throw new Error(PIPE_PEER_REFUSAL);
  }
  return peer;
}

function childEnvironment(env, profile) {
  if (!profile) return { ...env }; // Explicit legacy isolated tooling keeps its original contract.
  const result = { ...env };
  // These are launch/test identities, never native account configuration.
  for (const key of Object.keys(result)) {
    if (/^GOALPORT_(CORE_|RUN_SLUG$|SYNTHETIC_|REQUIRE_ISOLATED$|TEST_|CDP_|ALLOW_MULTI_INSTANCE$|LAUNCH_|ELECTRON_|LAUNCHER_|CLAUDE_FIXTURE_)/i.test(key)) delete result[key];
  }
  if (profile.testMode) {
    // In-process Scenario only. Also remove optional native transport knobs so
    // isolated test behavior cannot depend on a user's private CLI setup.
    for (const key of Object.keys(result)) if (/^GOALPORT_/i.test(key)) delete result[key];
    result.GOALPORT_REQUIRE_ISOLATED = "1";
    result.GOALPORT_TEST_SYNTHETIC_ONLY = "1";
    result.GOALPORT_TEST_PROFILE = profile.directory;
  }
  return result;
}

module.exports = {
  launchArguments, prepareProfile, assertCoreIdentity, childEnvironment, normalizedPath,
  assertPipePeer, pipePeerBusy, PIPE_PEER_SCHEMA, PIPE_PEER_REFUSAL
};
