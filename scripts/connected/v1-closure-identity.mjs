import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const IDENTITY_KEYS = new Set([
  "operationId", "operation_id", "emittedBy", "emitter", "freezeNonce", "runNonce", "nonce",
  "sidecarSha256", "capturedAtUtc", "captured_utc", "capturedAt", "createdAtUtc", "createdAt",
  "startedAtUtc", "startedAt", "endedAtUtc", "endedAt", "packagedAtUtc", "frozenAtUtc",
  "coreSha256", "exeSha256", "asarSha256", "artifactCoreSha256", "artifactExeSha256", "artifactAsarSha256",
  "coreBuildId", "buildIdentity", "freezeIdentity", "host", "hostPid", "hostPids", "corePid",
  "corePids", "corePidsBefore", "runtimePids", "pid", "pids", "pipeHash", "dbHash", "pipeName",
  "dbPath", "pipe", "db", "evidenceRoot", "reportPath", "pinsPath", "slug", "runSlug", "runId",
  "runFolder", "evidenceClass", "rawRunClass"
]);

export const CLASS_TABLE = {
  "soak-1800s.json": { evidenceClass: "soak", driverSuffix: "scripts/connected/verify-soak.mjs" },
  "lifecycle.json": { evidenceClass: "soak", driverSuffix: "scripts/connected/verify-soak.mjs" },
  "reopen.json": { evidenceClass: "soak", driverSuffix: "scripts/connected/verify-soak.mjs" },
  "process.json": { evidenceClass: "soak", driverSuffix: "scripts/connected/verify-soak.mjs" },
  "core-crash-final.json": { evidenceClass: "dur-03", driverSuffix: "scripts/connected/v1-crash-final-gui.mjs" },
  "saf-02-owner-only.json": { evidenceClass: "saf-02", driverSuffix: "scripts/connected/v1-saf-02-owner-only.mjs" },
  "sec-01-exclusion.json": { evidenceClass: "sec-01", driverSuffix: "scripts/connected/v1-sec-01-exclusion.mjs" },
  "live-revocation.json": { evidenceClass: "sec-02", driverSuffix: "scripts/connected/v1-live-revocation.mjs" },
  "qua-01-stale-evidence.json": { evidenceClass: "qua-01", driverSuffix: "scripts/connected/v1-qua-01-stale.mjs" },
  "rou-03-unknown-quota.json": { evidenceClass: "rou-03", driverSuffix: "scripts/connected/v1-rou-03-unknown-quota.mjs" },
  "resource-queue.json": { evidenceClass: "res-01", driverSuffix: "scripts/connected/v1-resource-queue.mjs" },
  "dur-02-runtime-exit.json": { evidenceClass: "dur-02", driverSuffix: "scripts/connected/v1-dur-02-runtime-exit.mjs" },
  "handoff.json": { evidenceClass: "rou-02", driverSuffix: "scripts/connected/verify-handoff.mjs" },
  "electron-connected.json": { evidenceClass: "rou-01", driverSuffix: "scripts/connected/v1-gui-connected.mjs" },
  "com-01-preflight.json": { evidenceClass: "com-01", driverSuffix: "scripts/connected/v1-com-01-preflight.mjs" },
  "com-02-native-surfaces.json": { evidenceClass: "com-02", driverSuffix: "scripts/connected/v1-com-02-native-surfaces.mjs" },
  "independent-audit.json": { evidenceClass: "qua-02", driverSuffix: "scripts/connected/v1-independent-audit.mjs" },
  "privacy.json": { evidenceClass: "dat-01", driverSuffix: "scripts/connected/verify_db_redaction.py" }
};

export const SOAK_ALLOWLIST = new Set(["soak-1800s.json", "lifecycle.json", "reopen.json", "process.json"]);
export const BEARER_BASENAMES = new Set([
  ...Object.keys(CLASS_TABLE),
  "dur-02-runtime-exit.json"
]);
export const D_HOST_BASENAMES = new Set([
  "soak-1800s.json",
  "qua-01-stale-evidence.json",
  "electron-connected.json",
  "handoff.json",
  "rou-03-unknown-quota.json",
  "sec-01-exclusion.json",
  "live-revocation.json",
  "saf-02-owner-only.json",
  "resource-queue.json",
  "privacy.json"
]);
const SKIP_DIRS = new Set(["electron-package", "electron-stage", "node_modules", ".git", "raw-run"]);
const EXCLUDE_BASENAMES = new Set([
  "historical-canonical-hashes.json",
  "historical-exact-hashes.json",
  "historical-census-skip.log"
]);
const L6_RE = /^closure-([0-9]+)-([0-9]+)$/;
const HEX64 = /^[0-9a-f]{64}$/;

export function utf8KeyCmp(a, b) {
  const A = Buffer.from(String(a), "utf8");
  const B = Buffer.from(String(b), "utf8");
  const n = Math.min(A.length, B.length);
  for (let i = 0; i < n; i += 1) {
    if (A[i] !== B[i]) return A[i] - B[i];
  }
  return A.length - B.length;
}

export function strip(value) {
  if (value === null) return value;
  const t = typeof value;
  if (t === "boolean" || t === "number" || t === "string") return value;
  if (Array.isArray(value)) return value.map(strip);
  if (t === "object") {
    if (value instanceof Date || Buffer.isBuffer(value)) throw new Error("identity-unhashable");
    const keys = Object.keys(value).filter((k) => !IDENTITY_KEYS.has(k));
    keys.sort(utf8KeyCmp);
    const out = {};
    for (const k of keys) out[k] = strip(value[k]);
    return out;
  }
  throw new Error("identity-unhashable");
}

export function decodeUtf8NoBom(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return bytes.subarray(3).toString("utf8");
  }
  return bytes.toString("utf8");
}

export function exactByteHash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function canonicalSemanticHashFromParsed(parsed) {
  return createHash("sha256").update(JSON.stringify(strip(parsed)), "utf8").digest("hex");
}

export function canonicalSemanticHash(utf8Bytes) {
  const parsed = JSON.parse(decodeUtf8NoBom(utf8Bytes));
  return canonicalSemanticHashFromParsed(parsed);
}

export function classOf(fileBasename) {
  return CLASS_TABLE[fileBasename] || null;
}

export function soakCompanionIdentityMatch(parent, companion) {
  return Boolean(
    parent
    && companion
    && companion.operationId === parent.operationId
    && companion.coreBuildId === parent.coreBuildId
    && companion.coreSha256 === parent.coreSha256
    && companion.pipeHash === parent.pipeHash
    && companion.dbHash === parent.dbHash
    && companion.attemptId === parent.attemptId
  );
}

function underDir(candidate, parent) {
  const rel = relative(resolve(parent), resolve(candidate));
  if (rel === "") return true;
  if (rel.startsWith("..")) return false;
  return !rel.split(/[\\/]/).some((segment) => segment === "..");
}

function walkJsonFiles(root) {
  const out = [];
  function rec(dir) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = join(dir, ent.name);
      let st;
      try { st = lstatSync(full); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        rec(full);
        continue;
      }
      if (!st.isFile()) continue;
      if (!ent.name.toLowerCase().endsWith(".json")) continue;
      if (EXCLUDE_BASENAMES.has(ent.name)) continue;
      out.push(full);
    }
  }
  rec(root);
  return out;
}

function argvContainsSuffix(argv, suffix) {
  const norm = (value) => String(value).replaceAll("\\", "/");
  const want = norm(suffix);
  return (argv || []).some((item) => {
    const got = norm(item);
    return got === want || got.endsWith(want);
  });
}

function argvHasOperationId(argv, operationId) {
  const list = argv || [];
  for (let i = 0; i < list.length; i += 1) {
    if (list[i] === "--operation-id" && list[i + 1] === operationId) return true;
  }
  return false;
}

function loadJsonBytes(path) {
  const bytes = readFileSync(path);
  return { bytes, parsed: JSON.parse(decodeUtf8NoBom(bytes)) };
}

function sidecarPathFor(evid, evidenceClass, operationId) {
  return resolve(evid, "raw-run", evidenceClass, `${operationId}.json`);
}

function reject(file, reason) {
  return { ok: false, file, reason };
}

export function gateFile({
  file,
  evid,
  H,
  X,
  L6_ID,
  freeze,
  firstHostPid,
  unixMs
}) {
  const resolved = resolve(file);
  if (!underDir(resolved, evid)) return reject(resolved, "not-under-this-run-evid");
  const bytes = readFileSync(resolved);
  const exact = exactByteHash(bytes);
  if (X.has(exact)) return reject(resolved, "exact-byte-historical");
  let parsed;
  try {
    parsed = JSON.parse(decodeUtf8NoBom(bytes));
  } catch {
    return reject(resolved, "parse-fail-this-run");
  }
  let semantic;
  try {
    semantic = canonicalSemanticHashFromParsed(parsed);
  } catch (error) {
    return reject(resolved, `unhashable:${error instanceof Error ? error.message : String(error)}`);
  }
  const inH = H.has(semantic);
  const name = basename(resolved);
  const klass = classOf(name);
  if (inH) {
    if (!klass) return reject(resolved, "unknown-basename-in-H");
    const collision = reconstructCollision({
      file: resolved,
      parsed,
      evid,
      X,
      L6_ID,
      freeze,
      firstHostPid,
      unixMs,
      klass,
      name
    });
    if (!collision.ok) return collision;
  }
  if (parsed.coreSha256 !== freeze.coreSha256 || parsed.exeSha256 !== freeze.exeSha256) {
    return reject(resolved, "freeze-sha-mismatch");
  }
  if (D_HOST_BASENAMES.has(name) && parsed.host !== "electron-packaged") {
    return reject(resolved, "d-host-not-electron-packaged");
  }
  if (name === "soak-1800s.json") {
    const ev = parsed.evidenceValidation || {};
    if (parsed.status === "PASS" && !(ev.lifecycle === true && ev.reopen === true && ev.process === true)) {
      return reject(resolved, "soak-evidenceValidation-incomplete");
    }
  }
  return {
    ok: true,
    file: resolved,
    exact,
    semantic,
    inH,
    collision: inH
  };
}

function reconstructCollision({ file, parsed, evid, X, L6_ID, freeze, firstHostPid, unixMs, klass, name }) {
  const evidenceClass = klass.evidenceClass;
  if (typeof parsed.operationId !== "string" || parsed.operationId.length < 1) {
    return reject(file, "C1-missing-operationId");
  }
  if (parsed.operationId !== L6_ID || !L6_RE.test(parsed.operationId)) {
    return reject(file, "C1-operationId-not-L6");
  }
  if (evidenceClass === "soak" && !SOAK_ALLOWLIST.has(name)) {
    return reject(file, "C2-soak-non-allowlist");
  }
  const sidecarFile = sidecarPathFor(evid, evidenceClass, L6_ID);
  const soakSidecar = sidecarPathFor(evid, "soak", L6_ID);
  if (evidenceClass !== "soak") {
    if (resolve(sidecarFile) === resolve(soakSidecar)) return reject(file, "C2-used-soak-sidecar-path");
    if (existsSync(soakSidecar)) {
      const soakHash = exactByteHash(readFileSync(soakSidecar));
      if (parsed.sidecarSha256 === soakHash) return reject(file, "C2-sidecarSha-equals-soak");
    }
  }
  if (!existsSync(sidecarFile)) return reject(file, "C2-sidecar-missing");
  let sidecar;
  try { sidecar = JSON.parse(decodeUtf8NoBom(readFileSync(sidecarFile))); } catch {
    return reject(file, "C3-sidecar-parse");
  }
  const required = ["evidenceClass", "operationId", "argv", "stdoutPath", "stdoutSha256", "closedAtUtc", "sidecarClosed", "cimCapture"];
  for (const key of required) {
    if (!(key in sidecar)) return reject(file, `C3-missing-${key}`);
  }
  if (sidecar.evidenceClass !== evidenceClass) return reject(file, "C3-evidenceClass");
  if (sidecar.operationId !== L6_ID) return reject(file, "C3-operationId");
  if (!Array.isArray(sidecar.argv) || !sidecar.argv.every((item) => typeof item === "string")) {
    return reject(file, "C3-argv");
  }
  if (typeof sidecar.stdoutPath !== "string" || typeof sidecar.stdoutSha256 !== "string") {
    return reject(file, "C3-stdout");
  }
  if (typeof sidecar.closedAtUtc !== "string") return reject(file, "C3-closedAtUtc");
  if (sidecar.sidecarClosed !== true) return reject(file, "C3-sidecarClosed");
  const cim = sidecar.cimCapture;
  if (!cim || typeof cim !== "object" || cim.ProcessId == null || cim.ExecutablePath == null || cim.CommandLine == null) {
    return reject(file, "C3-cimCapture");
  }
  if (evidenceClass === "soak") {
    for (const key of ["heartbeatPath", "heartbeatSha256", "firstHostPid", "unixMs"]) {
      if (!(key in sidecar)) return reject(file, `C3-missing-${key}`);
    }
  }
  if (!argvContainsSuffix(sidecar.argv, klass.driverSuffix) || !argvHasOperationId(sidecar.argv, L6_ID)) {
    return reject(file, "C4-argv-driver");
  }
  const cmd = String(cim.CommandLine || "");
  if (evidenceClass === "soak") {
    const idMatch = String(L6_ID).match(L6_RE);
    if (!idMatch) return reject(file, "C4-l6-regex");
    const idPid = Number(idMatch[1]);
    const idMs = Number(idMatch[2]);
    if (idPid !== Number(firstHostPid) || idMs !== Number(unixMs)) return reject(file, "C4-l6-heartbeat-bind");
    if (Number(sidecar.firstHostPid) !== Number(firstHostPid)) return reject(file, "C4-sidecar-pid-l6");
    if (Number(sidecar.unixMs) !== Number(unixMs)) return reject(file, "C4-sidecar-unixms-l6");
    if (Number(sidecar.firstHostPid) !== Number(cim.ProcessId)) return reject(file, "C4-soak-pid");
    const exeCmd = `${cim.ExecutablePath || ""} ${cmd}`;
    if (!exeCmd.includes("goalport-stable-v1-closure")) return reject(file, "C4-soak-slug");
  } else {
    const cmdNorm = cmd.replaceAll("\\", "/");
    if (!cmdNorm.includes(klass.driverSuffix.replaceAll("\\", "/")) || !cmd.includes(`--operation-id ${L6_ID}`)) {
      return reject(file, "C4-cim-driver");
    }
  }
  let stdoutPath = sidecar.stdoutPath;
  if (evidenceClass === "soak") {
    if (sidecar.artifacts && typeof sidecar.artifacts === "object") {
      if (!sidecar.artifacts[name]) return reject(file, "C5-artifact-missing");
      stdoutPath = sidecar.artifacts[name];
    } else if (name !== "soak-1800s.json") {
      return reject(file, "C5-artifact-missing");
    }
  }
  if (!existsSync(stdoutPath)) return reject(file, "C5-stdout-missing");
  const stdoutBytes = readFileSync(stdoutPath);
  const stdoutHash = exactByteHash(stdoutBytes);
  if (X.has(stdoutHash)) return reject(file, "C5-stdout-in-X");
  const perArtifactHash = sidecar.artifactSha256 && sidecar.artifactSha256[name];
  if (typeof perArtifactHash === "string") {
    if (stdoutHash !== perArtifactHash) return reject(file, "C5-artifact-hash");
  } else if (name === "soak-1800s.json" || evidenceClass !== "soak") {
    if (stdoutHash !== sidecar.stdoutSha256) return reject(file, "C5-stdout-hash");
  }
  if (evidenceClass === "soak") {
    if (!existsSync(sidecar.heartbeatPath)) return reject(file, "C5-heartbeat-missing");
    const hbBytes = readFileSync(sidecar.heartbeatPath);
    if (exactByteHash(hbBytes) !== sidecar.heartbeatSha256) return reject(file, "C5-heartbeat-hash");
    if (X.has(exactByteHash(hbBytes))) return reject(file, "C5-heartbeat-in-X");
    const firstLine = decodeUtf8NoBom(hbBytes).split("\n")[0];
    if (firstLine !== `--operation-id ${L6_ID}`) return reject(file, "C5-heartbeat-line1");
  }
  let reconstructed;
  try {
    reconstructed = JSON.parse(decodeUtf8NoBom(readFileSync(stdoutPath)));
  } catch {
    return reject(file, "C6-stdout-parse");
  }
  const left = JSON.stringify(strip(reconstructed));
  const right = JSON.stringify(strip(parsed));
  if (left !== right) return reject(file, "C6-strip-mismatch");
  const sidecarStat = statSync(sidecarFile);
  const fileStat = statSync(file);
  if (!(sidecarStat.mtimeMs < fileStat.mtimeMs)) return reject(file, "C7-mtime-order");
  if (typeof parsed.sidecarSha256 !== "string" || !HEX64.test(parsed.sidecarSha256)) {
    return reject(file, "C7-sidecarSha-format");
  }
  const liveSidecarHash = exactByteHash(readFileSync(sidecarFile));
  if (parsed.sidecarSha256 !== liveSidecarHash) return reject(file, "C7-sidecar-rewritten");
  if (sidecar.sidecarClosed !== true) return reject(file, "C7-not-closed");
  if (parsed.coreSha256 !== freeze.coreSha256 || parsed.exeSha256 !== freeze.exeSha256) {
    return reject(file, "C8-freeze-sha");
  }
  if (D_HOST_BASENAMES.has(name) && parsed.host !== "electron-packaged") {
    return reject(file, "C8-d-host");
  }
  return { ok: true, file, collision: true };
}

export function readL6FromHeartbeat(evid) {
  const heartbeat = resolve(evid, "soak-heartbeat.log");
  if (!existsSync(heartbeat)) throw new Error("heartbeat missing");
  const text = decodeUtf8NoBom(readFileSync(heartbeat));
  if (text.charCodeAt(0) === 0xfeff) throw new Error("heartbeat BOM");
  const first = text.split("\n")[0];
  if (!first.startsWith("--operation-id ")) throw new Error("heartbeat first line format");
  const token = first.slice("--operation-id ".length);
  if (first !== `--operation-id ${token}`) throw new Error("heartbeat first line format");
  const match = token.match(L6_RE);
  if (!match) throw new Error("heartbeat id regex");
  return {
    L6_ID: token,
    firstHostPid: Number(match[1]),
    unixMs: Number(match[2]),
    heartbeatPath: heartbeat
  };
}

export function collectCandidates(evid) {
  const files = new Set();
  for (const name of BEARER_BASENAMES) {
    const p = resolve(evid, name);
    if (existsSync(p) && lstatSync(p).isFile()) files.add(p);
  }
  for (const name of ["lifecycle.json", "reopen.json", "process.json"]) {
    const p = resolve(evid, name);
    if (existsSync(p) && lstatSync(p).isFile()) files.add(p);
  }
  for (const p of walkJsonFiles(evid)) {
    if (EXCLUDE_BASENAMES.has(basename(p))) continue;
    const rel = relative(evid, p).replaceAll("\\", "/");
    if (rel.startsWith("raw-run/")) continue;
    try {
      const parsed = JSON.parse(decodeUtf8NoBom(readFileSync(p)));
      if (parsed && parsed.status === "PASS") files.add(p);
    } catch {
      // not a candidate
    }
  }
  return [...files];
}

export function runIdentityGate({ evid, artifactPath, freezePath }) {
  const H = new Set(JSON.parse(readFileSync(resolve(evid, "historical-canonical-hashes.json"), "utf8")));
  const X = new Set(JSON.parse(readFileSync(resolve(evid, "historical-exact-hashes.json"), "utf8")));
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
  const freeze = existsSync(freezePath)
    ? JSON.parse(readFileSync(freezePath, "utf8"))
    : { coreSha256: artifact.coreSha256, exeSha256: artifact.exeSha256, asarSha256: artifact.asarSha256 };
  const { L6_ID, firstHostPid, unixMs } = readL6FromHeartbeat(evid);
  const candidates = collectCandidates(evid);
  const results = candidates.map((file) => gateFile({
    file, evid, H, X, L6_ID, freeze, firstHostPid, unixMs
  }));
  const failed = results.filter((item) => !item.ok);
  if (results.length < 1) {
    failed.push({ ok: false, file: evid, reason: "empty-candidate-set" });
  }
  const hasSoak = candidates.some((file) => basename(file) === "soak-1800s.json");
  if (!hasSoak) {
    failed.push({ ok: false, file: resolve(evid, "soak-1800s.json"), reason: "soak-1800s-missing" });
  }
  return {
    ok: failed.length === 0 && results.length >= 1 && hasSoak,
    L6_ID,
    candidateCount: results.length,
    failed,
    results
  };
}

function flag(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const evid = resolve(flag(argv, "--evidence-root") || "");
  const artifact = resolve(flag(argv, "--artifact") || "");
  if (!evid || !artifact) {
    console.error("usage: v1-closure-identity.mjs --artifact <electron-artifact.json> --evidence-root <EVID>");
    process.exit(2);
  }
  try {
    const report = runIdentityGate({
      evid,
      artifactPath: artifact,
      freezePath: resolve(evid, "freeze-identity.json")
    });
    const out = {
      schemaVersion: 1,
      kind: "closure-identity-gate",
      L6_ID: report.L6_ID,
      candidateCount: report.candidateCount,
      failed: report.failed,
      status: report.ok && report.failed.length === 0 ? "PASS" : "FAIL"
    };
    console.log(JSON.stringify(out, null, 2));
    process.exit(out.status === "PASS" ? 0 : 1);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
