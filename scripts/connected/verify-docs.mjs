import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EVID_REL } from "./v1-isolated-env.mjs";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const argv = process.argv.slice(2);
const value = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
};
const paths = {
  readme: resolve(ROOT, value("--readme", "README.md")),
  runtimeMatrix: resolve(ROOT, value("--runtime-matrix", "docs/runtime-support-matrix.md")),
  srd: resolve(ROOT, value("--srd", "docs/acceptance-srd.md")),
  comparison: resolve(ROOT, value("--comparison", "docs/desktop-host-comparison.md")),
  risks: resolve(ROOT, value("--risks", "docs/connected-preview-risks.md"))
};
const text = Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, existsSync(path) ? readFileSync(path, "utf8") : ""]));
const checks = {
  readmeNamesElectronMainline: /Electron/i.test(text.readme) && /electron:package/.test(text.readme) && text.readme.includes(EVID_REL.replaceAll("\\", "/")),
  runtimeMatrixPresent: text.runtimeMatrix.includes("codex") && text.runtimeMatrix.includes("scenario"),
  srdHas23Rows: (text.srd.match(/^\| [A-Z]{3}-\d{2} \|/gm) || []).length === 23,
  comparisonDescribesElectron: text.comparison.includes("Electron") && text.comparison.includes("process"),
  risksMention1800AndResidual: /1800-second|1800 second|1800s/i.test(text.risks) && /unmet|residual/i.test(text.risks)
};
const reportPath = resolve(ROOT, value("--report", `${EVID_REL}/docs-verification.json`));
const report = {
  schemaVersion: 2,
  kind: "stable-v1-doc-verification",
  paths,
  checks,
  status: Object.values(checks).every(Boolean) ? "PASS" : "UNMET",
  limitation: "Document presence and wording do not replace functional S/R/D evidence."
};
mkdirSync(resolve(reportPath, ".."), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.status === "PASS" ? 0 : 1;
