import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EVID_REL } from "./v1-isolated-env.mjs";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const argv = process.argv.slice(2);
const value = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
};
const reportPath = resolve(ROOT, value("--report", `${EVID_REL}/desktop-compare-skipped.json`));
const report = {
  schemaVersion: 2,
  kind: "desktop-compare-skipped",
  reason: "This run is Electron-only. Dual-host compare is not a gate and this command does not hash PRIOR Electron EXE.",
  status: "SKIPPED"
};
mkdirSync(resolve(reportPath, ".."), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
process.exitCode = 0;
