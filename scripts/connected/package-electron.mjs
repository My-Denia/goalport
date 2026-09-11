import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { EVID, EVID_REL, refusePriorMutation } from "./v1-isolated-env.mjs";

const root = resolve(import.meta.dirname, "../..");
const core = resolve(root, "target/release/goalport-core.exe");
const launcher = resolve(root, "target/release/goalport-core-launcher.exe");
if (!existsSync(core)) {
  console.error(`Missing release Core binary: ${core}`);
  process.exit(2);
}
if (!existsSync(launcher)) {
  console.error(`Missing release Core launcher: ${launcher}`);
  process.exit(2);
}

const stage = resolve(EVID, process.env.GOALPORT_ELECTRON_STAGE_DIR || "electron-stage-obs-b");
const packageDirName = process.env.GOALPORT_ELECTRON_PACKAGE_DIR || "electron-package-obs-b";
const outRel = `${EVID_REL}/${packageDirName}`;
const out = resolve(root, outRel);
refusePriorMutation(stage);
refusePriorMutation(out);
mkdirSync(EVID, { recursive: true });
rmSync(stage, { recursive: true, force: true });
mkdirSync(resolve(stage, "dist"), { recursive: true });
cpSync(resolve(root, "electron/main.cjs"), resolve(stage, "main.cjs"));
cpSync(resolve(root, "electron/preload.cjs"), resolve(stage, "preload.cjs"));
cpSync(resolve(root, "dist"), resolve(stage, "dist"), { recursive: true });
writeFileSync(resolve(stage, "package.json"), JSON.stringify({
  name: "goalport-electron-stable",
  version: "1.0.0",
  main: "main.cjs"
}, null, 2));

const args = [
  stage,
  "GoalPort",
  "--platform", "win32",
  "--arch", "x64",
  "--out", outRel,
  "--overwrite",
  "--asar",
  "--extra-resource", core,
  "--extra-resource", launcher
];
const packager = resolve(root, "node_modules/electron-packager/bin/electron-packager.js");
const result = spawnSync(process.execPath, [packager, ...args], {
  cwd: root,
  stdio: "inherit"
});
if ((result.status ?? 1) !== 0) {
  process.exit(result.status ?? 1);
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const exe = resolve(out, "GoalPort-win32-x64/GoalPort.exe");
const bundledCore = resolve(out, "GoalPort-win32-x64/resources/goalport-core.exe");
const bundledLauncher = resolve(out, "GoalPort-win32-x64/resources/goalport-core-launcher.exe");
const asar = resolve(out, "GoalPort-win32-x64/resources/app.asar");
const artifacts = [core, launcher, exe, bundledCore, bundledLauncher, asar].filter((path) => existsSync(path)).map((path) => ({
  path: path.replace(`${root}\\`, "").replaceAll("\\", "/"),
  bytes: statSync(path).size,
  sha256: sha256(path)
}));
const report = {
  schemaVersion: 1,
  kind: "electron-artifact",
  packagedAtUtc: new Date().toISOString(),
  out: outRel,
  artifacts,
  coreSha256: existsSync(bundledCore) ? sha256(bundledCore) : sha256(core),
  launcherSha256: existsSync(bundledLauncher) ? sha256(bundledLauncher) : sha256(launcher),
  exeSha256: existsSync(exe) ? sha256(exe) : null,
  asarSha256: existsSync(asar) ? sha256(asar) : null,
  status: existsSync(exe) && existsSync(bundledCore) && existsSync(asar) ? "PASS" : "UNMET"
};
writeFileSync(resolve(EVID, "electron-artifact.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
process.exit(report.status === "PASS" ? 0 : 1);
