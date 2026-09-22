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

// Rebuilds a relaunch argv whose EXCLUSIVE profile location is newDataDir:
// strips any existing mutually-exclusive --data-dir/--test-profile pair (both
// the two-token and --flag=value spellings, including their values) and
// appends the new --data-dir. Every other argument — the --user-data-dir
// application-root relocation, Chromium/CDP switches, positional arguments —
// survives untouched, so a relaunch after "choose a fresh directory" can never
// drop a relocation or debugging flag, and a synthetic --test-profile refusal
// screen can relaunch into a normal --data-dir without a dead repeat.
function relaunchArguments(argv, newDataDir) {
  const kept = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index]);
    if (arg === "--data-dir" || arg === "--test-profile") {
      const value = argv[index + 1];
      if (value !== undefined && !String(value).startsWith("--")) index += 1; // drop the consumed value too
      continue;
    }
    if (arg.startsWith("--data-dir=") || arg.startsWith("--test-profile=")) continue;
    if (arg === "--") continue; // argument separator has no meaning in a rebuilt argv
    kept.push(arg);
  }
  kept.push("--data-dir", newDataDir);
  return kept;
}

// Channel namespaces own separate profile directories under the product root.
// `release` keeps the historical `rc` directory; every development build
// (packaged dev candidates and unpackaged dev) shares `dev`, so development
// data stays stable across builds instead of forking per Core hash.
// A synthetic test profile is an explicit per-test directory and never
// participates in channel discovery.
const CHANNEL_DIRECTORIES = Object.freeze({ release: "rc", "dev-candidate": "dev", dev: "dev" });

function profileDirectoryFor({ args, appData, channel }) {
  if (args["--test-profile"] || args["--data-dir"]) return path.resolve(args["--test-profile"] || args["--data-dir"]);
  const leaf = CHANNEL_DIRECTORIES[channel] || "dev";
  return path.join(appData, "GoalPort", leaf);
}

// The Electron/Chromium browser-state namespace (caches, Local State,
// Preferences, Network, session storage…) is DERIVED from the canonical
// durable identity and is PHYSICALLY SEPARATE from the durable profile root:
//   * normal profiles (default channel directory or an explicit --data-dir)
//     use <appData>/GoalPort/electron/<profileKey> — inside the same
//     application-data root (so a --user-data-dir relocation keeps both
//     namespaces inside the relocated boundary) but never inside the durable
//     directory, not even for --data-dir;
//   * a synthetic --test-profile uses a test-owned sibling
//     dirname(<test-profile>)/electron/<profileKey>, so packaged tests never
//     write into the real application-data root.
// The browser identity deliberately does NOT include the Core hash: a
// differently-built candidate reuses the same durable AND browser identity
// (only the runtime pipe stays per-build).
function browserStateDirectoryFor({ args, appData, canonical, key }) {
  if (args["--test-profile"]) return path.join(path.dirname(canonical), "electron", key);
  return path.join(appData, "GoalPort", "electron", key);
}

// Pure path/identity computation for one profile. It never reads or writes
// the marker, never validates builder identity, and never refuses on build
// hash: those decisions belong to the profile manager's compatibility flow
// (data-format authority is the schema_migrations table, inspected read-only
// by the Core binary). `directory` and `durableDirectory` are the same
// durable profile root (the user's backup/migration unit: marker, SQLite
// database, backups, import journal); `browserStateDirectory` is the separate
// Electron/Chromium userData root — the two are never the same path.
function resolveProfilePaths({ args, appData, channel, coreSha256 }) {
  if (!/^[a-f0-9]{64}$/.test(coreSha256)) throw new Error("Packaged Core identity is unavailable");
  const mode = args["--test-profile"] ? "synthetic-test" : "normal";
  const directory = profileDirectoryFor({ args, appData, channel });
  const canonical = canonicalPath(directory);
  const key = hash(normalizedPath(canonical)).slice(0, 20);
  const slug = `goalport-rc-${key}`;
  return {
    mode,
    channel: args["--test-profile"] || args["--data-dir"] ? null : channel,
    directory: canonical,
    durableDirectory: canonical,
    browserStateDirectory: browserStateDirectoryFor({ args, appData, canonical, key }),
    marker: path.join(canonical, "goalport-profile.json"),
    database: path.join(canonical, "goalport.sqlite"),
    profileKey: key,
    pipe: `\\\\.\\pipe\\${slug}-${coreSha256.slice(0, 20)}`,
    slug,
    coreSha256,
    testMode: mode === "synthetic-test"
  };
}

// Marker identity (NOT data-format compatibility): the marker proves this
// directory belongs to this product/mode/path identity. Builder version and
// Core hash in the marker are provenance metadata (`createdBy`,
// `lastOpenedBy`), never reopen conditions.
function validateProfileIdentity(marker, { mode, profileKey }) {
  if (!marker || marker.product !== "GoalPort") throw new Error("This data directory belongs to a different product; choose a new directory");
  const schema = marker.markerSchemaVersion ?? marker.schemaVersion;
  if (schema !== 1 && schema !== 2) throw new Error("This data profile uses an unknown profile-record format; choose a new directory");
  if (marker.mode !== mode) throw new Error("This data directory belongs to a different profile mode; choose a new directory");
  if (marker.identityVersion !== 2 || marker.profileKey !== profileKey) throw new Error("This data profile uses an older or different path identity. Choose a new --data-dir; automatic migration is not supported");
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
  launchArguments, relaunchArguments, resolveProfilePaths, validateProfileIdentity, assertCoreIdentity,
  childEnvironment, normalizedPath, assertPipePeer, pipePeerBusy, PIPE_PEER_SCHEMA, PIPE_PEER_REFUSAL,
  CHANNEL_DIRECTORIES
};
