import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const argv = process.argv.slice(2);
const pinsFlag = argv.indexOf("--pins");
if (pinsFlag < 0) {
  console.error("missing --pins");
  process.exit(2);
}
const pinsArg = argv[pinsFlag + 1];
if (!pinsArg || pinsArg.startsWith("-")) {
  console.error("missing --pins path");
  process.exit(2);
}

// preserved RC folder goalport-electron-stable-v1
const RC_PRESERVE_SLUG = ["goalport", "electron", "stable", "v1"].join("-");
const REQUIRED_PATHS = [
  `goal-runs/${RC_PRESERVE_SLUG}/evidence/electron-package/GoalPort-win32-x64/GoalPort.exe`,
  "goal-runs/goalport-connected-dual-desktop/execution-summary.md",
  "goal-runs/goalport-connected-dual-desktop/evidence/electron-package/GoalPort-win32-x64/GoalPort.exe",
  "goal-runs/goalport-connected-dual-desktop/evidence/soak-600s-v4.json"
];

const PIN_LINE = /^\|\s*([0-9a-f]{64})\s*\|\s*(\d+)\s*\|\s*(goal-runs\/\S+)\s*\|$/i;

function parsePins(markdown) {
  const pins = [];
  for (const line of String(markdown).split(/\r?\n/)) {
    const match = line.match(PIN_LINE);
    if (!match) continue;
    pins.push({ sha256: match[1].toLowerCase(), bytes: Number(match[2]), path: match[3] });
  }
  return pins;
}

const pinsPath = resolve(pinsArg);
if (!existsSync(pinsPath)) {
  console.error(`pins file missing: ${pinsPath}`);
  process.exit(2);
}
let markdown;
try {
  markdown = readFileSync(pinsPath, "utf8");
} catch (error) {
  console.error(`pins file unreadable: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

const pins = parsePins(markdown);
if (pins.length !== 4) {
  console.error(`expected 4 preserve pins, found ${pins.length}`);
  process.exit(2);
}
const seen = new Set();
for (const pin of pins) {
  if (seen.has(pin.path)) {
    console.error(`duplicate pin path: ${pin.path}`);
    process.exit(2);
  }
  seen.add(pin.path);
  if (!REQUIRED_PATHS.includes(pin.path)) {
    console.error(`unknown pin path: ${pin.path}`);
    process.exit(2);
  }
  if (!/^[0-9a-f]{64}$/.test(pin.sha256)) {
    console.error(`pin sha length invalid: ${pin.sha256}`);
    process.exit(2);
  }
  if (!Number.isInteger(pin.bytes) || pin.bytes <= 0) {
    console.error(`pin bytes must be a positive integer: ${pin.path}`);
    process.exit(2);
  }
}
for (const required of REQUIRED_PATHS) {
  if (!seen.has(required)) {
    console.error(`missing required pin path: ${required}`);
    process.exit(2);
  }
}

const results = pins.map((pin) => {
  const file = resolve(ROOT, pin.path);
  if (!existsSync(file)) {
    return { ...pin, ok: false, error: "missing" };
  }
  const bytes = statSync(file).size;
  const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
  return {
    ...pin,
    actualBytes: bytes,
    actualSha256: sha256,
    ok: bytes === pin.bytes && sha256 === pin.sha256
  };
});

if (results.length !== 4) {
  console.error(`results.length !== 4 (${results.length})`);
  process.exit(2);
}

const report = {
  schemaVersion: 1,
  kind: "prior-intact-pins",
  pinsPath,
  results,
  status: results.every((item) => item.ok) ? "PASS" : "FAIL"
};
console.log(JSON.stringify(report, null, 2));
if (report.status !== "PASS" || results.length !== 4 || results.some((item) => item.ok !== true)) {
  process.exit(1);
}
process.exit(0);
