import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EVID, EVID_REL } from "./v1-isolated-env.mjs";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const argv = process.argv.slice(2);
const value = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
};
const hosts = value("--hosts", "electron").split(",").map((host) => host.trim().toLowerCase()).filter(Boolean);
const reportPath = resolve(ROOT, value("--report", `${EVID_REL}/launch-verification.json`));
const electronExe = resolve(ROOT, `${EVID_REL}/electron-package/GoalPort-win32-x64/GoalPort.exe`);
const bundledCore = resolve(ROOT, `${EVID_REL}/electron-package/GoalPort-win32-x64/resources/goalport-core.exe`);
const artifactJson = resolve(EVID, "electron-artifact.json");

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const thisRunCoreSha256 = existsSync(bundledCore) ? sha256(bundledCore) : null;
let artifactCoreSha256 = null;
try {
  artifactCoreSha256 = JSON.parse(readFileSync(artifactJson, "utf8")).coreSha256 || null;
} catch {
  artifactCoreSha256 = null;
}

const results = hosts.map((host) => {
  if (host !== "electron") {
    return {
      host,
      mode: value("--mode", "packaged"),
      artifact: null,
      artifactPresent: false,
      skipped: true,
      reason: "Electron is the only Desktop host for this run"
    };
  }
  return {
    host,
    mode: value("--mode", "packaged"),
    artifact: electronExe,
    artifactPresent: existsSync(electronExe),
    thisRunCoreSha256,
    bundledCore
  };
});

const electronOnly = hosts.length === 1 && hosts[0] === "electron";
const shaOk = typeof thisRunCoreSha256 === "string" && /^[0-9a-f]{64}$/i.test(thisRunCoreSha256);
const matchesArtifact = !artifactCoreSha256 || artifactCoreSha256 === thisRunCoreSha256;
const pass = electronOnly
  && results.length === 1
  && results[0].artifactPresent === true
  && shaOk
  && matchesArtifact;

const report = {
  schemaVersion: 4,
  kind: "packaged-host-launch-verification",
  results,
  thisRunCoreSha256,
  artifactCoreSha256,
  status: pass ? "PASS" : "UNMET",
  limitation: "PASS is artifact-presence plus this-run bundled Core SHA-256 only. GUI connected and clean-start are separate M7 bearers."
};
mkdirSync(resolve(reportPath, ".."), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.status === "PASS" ? 0 : 1;
