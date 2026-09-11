import { existsSync, mkdirSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_RUN_SLUG = "goalport-electron-rc-resume-chain";
export const RUN_SLUG = process.env.GOALPORT_RUN_SLUG || DEFAULT_RUN_SLUG;
export const PRIOR_SLUG = "goalport-connected-dual-desktop";
// preserved RC folder goalport-electron-stable-v1 is refuse-only for db/report/out
const RC_PRESERVE_SLUG = ["goalport", "electron", "stable", "v1"].join("-");
export const CLOSURE_SLUG = "goalport-stable-v1-closure";
export const EVIDENCE_VERIFIER_CORE_RESTART_SLUG = "goalport-evidence-verifier-core-restart";
export const GROK_NATIVE_ADMISSION_SLUG = "goalport-grok-native-admission";
export const RESUME_CHAIN_COLLECT_B_SLUG = "goalport-resume-chain-collect-b";
export const CLAUDE_NATIVE_CONTROL_ADMISSION_SLUG = "goalport-claude-native-control-admission";
export const CLAUDE_DENY_FAIL_OPEN_ADMISSION_SLUG = "goalport-claude-deny-fail-open-admission";
export const CLAUDE_LIVE_DENY_ADMISSION_SLUG = "goalport-claude-live-deny-admission";
export const CLAUDE_NOTICE_STOP_DUP_ADMISSION_SLUG = "goalport-claude-notice-stop-dup-admission";
export const PRESERVE_SLUGS = [
  PRIOR_SLUG,
  RC_PRESERVE_SLUG,
  CLOSURE_SLUG,
  EVIDENCE_VERIFIER_CORE_RESTART_SLUG,
  GROK_NATIVE_ADMISSION_SLUG,
  RESUME_CHAIN_COLLECT_B_SLUG,
  CLAUDE_NATIVE_CONTROL_ADMISSION_SLUG,
  CLAUDE_DENY_FAIL_OPEN_ADMISSION_SLUG,
  CLAUDE_LIVE_DENY_ADMISSION_SLUG,
  CLAUDE_NOTICE_STOP_DUP_ADMISSION_SLUG
];
export const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const EVID_REL = `goal-runs/${RUN_SLUG}/evidence`;
export const FIX_REL = `goal-runs/${RUN_SLUG}/fixtures/synthetic-workspace`;
export const EVID = resolve(ROOT, EVID_REL);
export const FIX = resolve(ROOT, FIX_REL);
export const RUN_ROOT = resolve(ROOT, "goal-runs", RUN_SLUG);

const PATH_FLAGS = ["--report", "--db", "--out", "--selection-report", "--evidence-root"];

function normalize(value) {
  return String(value || "").replaceAll("/", "\\").toLowerCase();
}

function containsPreserveSlug(value) {
  const n = normalize(value);
  return PRESERVE_SLUGS.some((slug) => n.includes(normalize(slug)));
}

export function underDir(candidate, parent) {
  const rel = relative(resolve(parent), resolve(candidate));
  if (rel === "") return true;
  if (isAbsolute(rel)) return false;
  return !rel.split(/[\\/]/).some((segment) => segment === "..");
}

export function flagValue(argv, name, fallback) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
}

export function resolveMaybe(root, value) {
  if (!value) return null;
  return isAbsolute(value) ? value : resolve(root, value);
}

export function assertPathAllowed(label, resolvedPath) {
  if (!resolvedPath) return;
  if (containsPreserveSlug(resolvedPath)) {
    throw new Error(`${label} resolves under a preserved PRIOR/RC/closure run: ${resolvedPath}`);
  }
  if (!underDir(resolvedPath, EVID) && !underDir(resolvedPath, FIX)) {
    throw new Error(`${label} must be under this-run EVID or FIX: ${resolvedPath}`);
  }
}

export function isolationEnvMissing() {
  const missing = [];
  if (!process.env.GOALPORT_CORE_PIPE) missing.push("GOALPORT_CORE_PIPE");
  if (!process.env.GOALPORT_CORE_DB) missing.push("GOALPORT_CORE_DB");
  if (!process.env.GOALPORT_SYNTHETIC_ROOT) missing.push("GOALPORT_SYNTHETIC_ROOT");
  if (process.env.GOALPORT_REQUIRE_ISOLATED !== "1") missing.push("GOALPORT_REQUIRE_ISOLATED=1");
  return missing;
}

export function assertIsolatedEnv({ argv = process.argv.slice(2), root = ROOT } = {}) {
  const missing = isolationEnvMissing();
  if (missing.length > 0) {
    throw new Error(`isolated env missing: ${missing.join(", ")}`);
  }
  const db = resolveMaybe(root, process.env.GOALPORT_CORE_DB);
  if (!db || containsPreserveSlug(db) || !underDir(db, RUN_ROOT)) {
    throw new Error(`GOALPORT_CORE_DB must be under goal-runs/${RUN_SLUG}: ${process.env.GOALPORT_CORE_DB}`);
  }
  const synthetic = resolveMaybe(root, process.env.GOALPORT_SYNTHETIC_ROOT);
  if (!synthetic || containsPreserveSlug(synthetic) || !underDir(synthetic, FIX) && synthetic !== FIX) {
    throw new Error(`GOALPORT_SYNTHETIC_ROOT must be this-run FIX: ${process.env.GOALPORT_SYNTHETIC_ROOT}`);
  }
  const pipe = String(process.env.GOALPORT_CORE_PIPE || "");
  if (!pipe.includes(RUN_SLUG)) {
    throw new Error(`GOALPORT_CORE_PIPE must contain ${RUN_SLUG}: ${pipe}`);
  }
  if (containsPreserveSlug(pipe)) {
    throw new Error(`GOALPORT_CORE_PIPE resolves under a preserved PRIOR/RC/closure run: ${pipe}`);
  }
  for (const flag of PATH_FLAGS) {
    const value = flagValue(argv, flag);
    if (value === undefined) continue;
    assertPathAllowed(flag, resolveMaybe(root, value));
  }
  mkdirSync(EVID, { recursive: true });
  return { evid: EVID, fix: FIX, db, synthetic };
}

export function isolatedChildEnv(overrides = {}) {
  const missing = isolationEnvMissing();
  if (missing.length > 0) {
    throw new Error(`isolated env missing: ${missing.join(", ")}`);
  }
  const env = {
    ...process.env,
    ...overrides,
    GOALPORT_REQUIRE_ISOLATED: "1",
    GOALPORT_CORE_PIPE: process.env.GOALPORT_CORE_PIPE,
    GOALPORT_CORE_DB: process.env.GOALPORT_CORE_DB,
    GOALPORT_SYNTHETIC_ROOT: process.env.GOALPORT_SYNTHETIC_ROOT
  };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

export function refusePriorMutation(targetPath) {
  if (containsPreserveSlug(targetPath)) {
    throw new Error(`refusing to mutate preserved PRIOR/RC/closure path: ${targetPath}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assertIsolatedEnv();
    console.log(JSON.stringify({ status: "PASS", evid: EVID, fix: FIX }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
