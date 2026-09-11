import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EVID_REL, PRESERVE_SLUGS } from "./v1-isolated-env.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const argv = process.argv.slice(2);
const value = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
};

function containsPreserveSlug(candidate) {
  const n = String(candidate || "").replaceAll("/", "\\").toLowerCase();
  return PRESERVE_SLUGS.some((slug) => n.includes(String(slug).toLowerCase()));
}

const matrixPath = resolve(root, value("--matrix", "tests/scenarios/manifest.json"));
const evidenceRootRel = value("--evidence-root", EVID_REL);
const evidenceRoot = resolve(root, evidenceRootRel);
const reportFlag = value("--report", "");
const reportPath = resolve(root, reportFlag || `${evidenceRootRel}/acceptance.json`);
for (const [label, candidate] of [
  ["--evidence-root", evidenceRootRel],
  ["--evidence-root", evidenceRoot],
  ["--report", reportFlag],
  ["--report", reportPath]
]) {
  if (!candidate) continue;
  if (containsPreserveSlug(candidate)) {
    console.error(`verify-acceptance refusing ${label} under preserved run: ${candidate}`);
    process.exit(2);
  }
}
const manifest = JSON.parse(readFileSync(matrixPath, "utf8"));
const artifactPath = resolve(evidenceRoot, "electron-artifact.json");

function readJson(name) {
  const path = resolve(evidenceRoot, name);
  if (!existsSync(path)) return { missing: true, path, status: "UNMET" };
  try {
    return { ...JSON.parse(readFileSync(path, "utf8")), missing: false, path };
  } catch {
    return { missing: true, path, status: "UNMET", parseError: true };
  }
}

function filePass(file, predicate = (doc) => doc?.status === "PASS") {
  if (!file || file.missing) return false;
  try {
    return predicate(file) === true;
  } catch {
    return false;
  }
}

const soak = readJson("soak-1800s.json");
const dur02 = readJson("dur-02-runtime-exit.json");
const crashFinal = readJson("core-crash-final.json");
const qua01 = readJson("qua-01-stale-evidence.json");
const independentAudit = readJson("independent-audit.json");
const connected = readJson("electron-connected.json");
const handoff = readJson("handoff.json");
const rou03 = readJson("rou-03-unknown-quota.json");
const sec01 = readJson("sec-01-exclusion.json");
const liveRevocation = readJson("live-revocation.json");
const saf02 = readJson("saf-02-owner-only.json");
const com01 = readJson("com-01-preflight.json");
const com02 = readJson("com-02-native-surfaces.json");
const resourceQueue = readJson("resource-queue.json");
const privacy = readJson("privacy.json");
let artifact = readJson("electron-artifact.json");
if (artifact.missing && existsSync(artifactPath)) {
  artifact = { ...JSON.parse(readFileSync(artifactPath, "utf8")), missing: false, path: artifactPath };
}

let output = "";
let exit = 1;
try {
  output = execFileSync("cargo.exe", ["test", "-p", "goalport-core", "--test", "scenario_predicates", "--", "--nocapture"], {
    cwd: root,
    encoding: "utf8",
    timeout: 180_000,
    windowsHide: true
  });
  exit = 0;
} catch (error) {
  output = `${error.stdout || ""}\n${error.stderr || ""}`;
  exit = typeof error.status === "number" ? error.status : 1;
}

const sPass = exit === 0;
const P = (ok) => (ok ? "PASS" : "UNMET");
const layer = (required, ok) => (required ? P(ok) : "n/a");

const soakPass = filePass(soak, (doc) => doc.status === "PASS" && Number(doc.measuredWallClockSeconds) >= 1800);
const crashPass = filePass(crashFinal, (doc) => doc.status === "PASS" && doc.host === "electron-packaged" && /^[0-9a-f]{64}$/i.test(doc.coreSha256 || "") && (!artifact.coreSha256 || doc.coreSha256 === artifact.coreSha256));
const transportPass = filePass(soak, (doc) => doc.status === "PASS" && (doc.transportInterrupt?.status === "PASS" || doc.transportInterrupt === true || doc.transportInterrupt?.promptReplay === false && doc.transportInterrupt?.injected === true));

const graceful = readJson("resume-chain-graceful.json");
const killChain = readJson("resume-chain-kill.json");

function kindAllowed(kind) {
  const value = String(kind || "");
  if (/heartbeat/i.test(value)) return false;
  return value.startsWith("message.") || value.startsWith("runtime.");
}

function absenceOk(doc) {
  const uiExit = doc.uiExitUtc;
  if (!uiExit) return false;
  const absence = Array.isArray(doc.absenceEvents) ? doc.absenceEvents : [];
  const attemptId = doc.attemptId;
  const reconnectAt = doc.reconnectWhileActive?.atUtc;
  return absence.some((row) => {
    if (!kindAllowed(row?.kind) || !row?.atUtc || !row?.id) return false;
    if (String(row.atUtc) < String(uiExit)) return false;
    if (reconnectAt && String(row.atUtc) > String(reconnectAt)) return false;
    if (attemptId && row.attemptId && row.attemptId !== attemptId) return false;
    return true;
  });
}

function resumeDur01(doc) {
  if (!doc || doc.missing) return false;
  const state = String(doc.reconnectWhileActive?.attempt?.state || "");
  return /^(active|ACTIVE)$/.test(state)
    && doc.originalPromptUserMessageCount === 1
    && doc.promptReplay === false
    && doc.promptReplayObserved === true
    && doc.attemptCountUnchanged === true
    && absenceOk(doc);
}

function resumeEff01(doc) {
  if (!doc || doc.missing) return false;
  const state = String(doc.originalStepTerminal?.attempt?.state || "");
  if (/^(failed|FAILED|Cancelled|cancelled)$/i.test(state)) return false;
  return /^(waiting|AwaitingReview|completed|Closed)$/i.test(state) && absenceOk(doc);
}

const dur01Resume = resumeDur01(graceful) || resumeDur01(killChain);
const eff01Resume = resumeEff01(graceful) || resumeEff01(killChain);
const dur01Note = dur01Resume
  ? "this-run resume-chain reconnectWhileActive ACTIVE + no-replay + absence event (not 1800s soak)"
  : "EVID/soak-1800s.json on final Electron (UI kill, no replay); resume-chain DUR-01 named snapshots unmet or partial";
const eff01Note = eff01Resume
  ? "this-run resume-chain originalStepTerminal completed/waiting + absence work (failed/Cancelled UNMET; not 1800s soak)"
  : "soak UI-absent continuation; resume-chain originalStepTerminal unmet or failed/Cancelled";

const bearers = {
  "DUR-01": { R: soakPass || dur01Resume, D: soakPass || dur01Resume, evidence: dur01Note },
  "DUR-02": { R: filePass(dur02, (doc) => doc.status === "PASS" && doc.coreAlive === true && doc.runtimePidGone === true && String(doc.lease || "").toUpperCase() === "UNCERTAIN"), D: null, evidence: "EVID/dur-02-runtime-exit.json Runtime PID exit after synthetic write" },
  "DUR-03": { R: crashPass, D: null, evidence: "EVID/core-crash-final.json on final package SHA-256" },
  "DUR-04": { R: transportPass, D: null, evidence: "soak transportInterrupt on final package" },
  "QUA-01": { R: filePass(qua01), D: filePass(qua01, (doc) => doc.status === "PASS" && doc.host === "electron-packaged" && (doc.guiStale === true || doc.desktop === "PASS")), evidence: "EVID/qua-01-stale-evidence.json + Electron GUI STALE" },
  "QUA-02": { R: filePass(independentAudit), D: null, evidence: "EVID/independent-audit.json this-run frozen packet" },
  "QUA-03": { R: null, D: null, evidence: "scenario_predicates nonzero execution" },
  "QUA-04": { R: null, D: null, evidence: "scenario_predicates" },
  "ROU-01": { R: null, D: filePass(connected, (doc) => doc.status === "PASS" && Array.isArray(doc.reasons) && doc.reasons.length > 0), evidence: "EVID/electron-connected.json reasons + manual Runtime select" },
  "ROU-02": { R: filePass(handoff, (doc) => doc.corePredicates?.distinctAttempt === true && doc.corePredicates?.distinctNativeSession === true && doc.corePredicates?.packetObserved === true), D: filePass(handoff, (doc) => doc.status === "PASS" && doc.guiEvidence?.valid === true), evidence: "EVID/handoff.json this-run Core packet" },
  "ROU-03": { R: null, D: filePass(rou03, (doc) => doc.status === "PASS" && doc.host === "electron-packaged"), evidence: "EVID/rou-03-unknown-quota.json" },
  "EFF-01": { R: soakPass || eff01Resume, D: soakPass || eff01Resume, evidence: eff01Note },
  "EFF-02": { R: filePass(connected), D: filePass(connected), evidence: "EVID/electron-connected.json ordinary question" },
  "EFF-03": { R: soakPass, D: soakPass, evidence: "soak same Attempt/session across turns" },
  "SEC-01": { R: null, D: filePass(sec01, (doc) => doc.status === "PASS" && doc.host === "electron-packaged" && doc.transferredBytes === 0), evidence: "EVID/sec-01-exclusion.json Grok excluded" },
  "SEC-02": { R: null, D: filePass(liveRevocation, (doc) => doc.status === "PASS" && doc.host === "electron-packaged"), evidence: "EVID/live-revocation.json after Campaign start" },
  "SAF-01": { R: null, D: null, evidence: "scenario_predicates" },
  "SAF-02": { R: null, D: filePass(saf02), evidence: "EVID/saf-02-owner-only.json commit/push/release/delete blocked" },
  "COM-01": { R: filePass(com01), D: null, evidence: "EVID/com-01-preflight.json live 0.152.0 / 2.1.252" },
  "COM-02": { R: filePass(com02), D: null, evidence: "EVID/com-02-native-surfaces.json" },
  "RES-01": { R: null, D: filePass(resourceQueue), evidence: "EVID/resource-queue.json" },
  "RES-02": { R: soakPass, D: soakPass, evidence: "soak history/output bounds on final Electron" },
  "DAT-01": { R: null, D: filePass(privacy), evidence: "EVID/privacy.json over this-run SQLite only" }
};

const requiredById = Object.fromEntries((manifest.scenarios || []).map((scenario) => [scenario.id, scenario.requiredLevels || []]));
const buildIdentity = artifact.coreSha256 || "unbound";
const rows = (manifest.scenarios || []).map((scenario) => {
  const required = new Set(scenario.requiredLevels || []);
  const bearer = bearers[scenario.id] || {};
  return {
    id: scenario.id,
    S: required.has("S") ? P(sPass) : "n/a",
    R: layer(required.has("R"), bearer.R === true),
    D: layer(required.has("D"), bearer.D === true),
    evidence: bearer.evidence || "no this-run bearer",
    buildIdentity
  };
});

const requiredUnmet = rows.some((row) => {
  const required = new Set(requiredById[row.id] || []);
  return (required.has("S") && row.S !== "PASS")
    || (required.has("R") && row.R !== "PASS")
    || (required.has("D") && row.D !== "PASS");
});

const report = {
  schemaVersion: 3,
  kind: "acceptance-srd-matrix",
  matrix: matrixPath,
  evidenceRoot: evidenceRootRel,
  host: "electron",
  rows,
  status: sPass && rows.length === 23 && !requiredUnmet ? "PASS" : "UNMET",
  limitation: "Each required layer is PASS only when the named this-run bearer exists and its own predicate is PASS. Missing artifact is UNMET. Electron is the only Desktop host."
};
mkdirSync(resolve(reportPath, ".."), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.status === "PASS" ? 0 : 1;
