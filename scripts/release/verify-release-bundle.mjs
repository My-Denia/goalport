// Proves a release bundle end to end: SHA256SUMS.txt matches the files on
// disk, release-manifest.json matches SHA256SUMS.txt, the ZIP extracts
// cleanly into a brand-new directory, and the extracted package independently
// passes the same verify/smoke/early-cleanup gates as a freshly built one.
// This is what stands in for "the ZIP file merely exists".
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { argsFor, fileHash, ROOT } from "../desktop/package.mjs";
import { verifyPackage } from "../desktop/verify-package.mjs";

function extractZipApi() {
  const require = createRequire(import.meta.url);
  const packagerRequire = createRequire(require.resolve("electron-packager"));
  return packagerRequire("extract-zip");
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) throw new Error(`Command failed (${result.status ?? "spawn error"}): ${command} ${args.join(" ")}`);
}

function verifySha256Sums(bundleDir) {
  const text = readFileSync(resolve(bundleDir, "SHA256SUMS.txt"), "utf8").trim();
  const entries = text.split("\n").map((line) => {
    const match = line.match(/^([0-9a-f]{64})\s{2}(.+)$/);
    if (!match) throw new Error(`Malformed SHA256SUMS.txt line: ${line}`);
    return { sha256: match[1], name: match[2] };
  });
  for (const entry of entries) {
    const path = resolve(bundleDir, entry.name);
    if (!existsSync(path)) throw new Error(`SHA256SUMS.txt references a missing file: ${entry.name}`);
    if (fileHash(path) !== entry.sha256) throw new Error(`Checksum mismatch for ${entry.name}`);
  }
  return entries;
}

export async function verifyReleaseBundle({ bundleDir, workDir, root = ROOT }) {
  const bundle = resolve(bundleDir);
  const sums = verifySha256Sums(bundle);
  const manifest = JSON.parse(readFileSync(resolve(bundle, "release-manifest.json"), "utf8"));
  if (manifest.product !== "GoalPort" || manifest.channel !== "Stable V1 RC") throw new Error("release-manifest.json missing RC identity");
  const zipPath = resolve(bundle, manifest.zip.filename);
  if (!sums.some((entry) => entry.name === manifest.zip.filename)) throw new Error("ZIP filename not covered by SHA256SUMS.txt");
  if (fileHash(zipPath) !== manifest.zip.sha256) throw new Error("ZIP sha256 does not match release-manifest.json");
  if (statSync(zipPath).size !== manifest.zip.bytes) throw new Error("ZIP byte count does not match release-manifest.json");

  const work = resolve(workDir);
  if (existsSync(work)) throw new Error(`Work directory already exists: ${work}`);
  mkdirSync(work, { recursive: true });
  const extractedRoot = resolve(work, "extracted");
  const extract = extractZipApi();
  await extract(zipPath, { dir: extractedRoot });

  const assetName = manifest.zip.filename.replace(/\.zip$/, "");
  const outerRoot = resolve(extractedRoot, assetName);
  const legalFiles = ["GOALPORT-LICENSE.txt", "THIRD_PARTY_NOTICES.txt", "README-RELEASE.txt"];
  for (const name of legalFiles) {
    const path = resolve(outerRoot, name);
    if (!existsSync(path) || statSync(path).size === 0) throw new Error(`Missing or empty legal file after extraction: ${name}`);
  }
  const extractedPackage = resolve(outerRoot, "GoalPort-win32-x64");
  for (const name of ["LICENSE", "LICENSES.chromium.html"]) {
    if (!existsSync(resolve(extractedPackage, name))) throw new Error(`Missing upstream Electron legal file after extraction: ${name}`);
  }

  const packageVerify = verifyPackage(extractedPackage);
  if (packageVerify.sourceTreeSha256 !== manifest.source.treeSha256) throw new Error("Extracted package source identity does not match release-manifest.json");

  const normalSmokeOut = resolve(work, "normal-smoke");
  const syntheticSmokeOut = resolve(work, "synthetic-smoke");
  const earlyCleanupOut = resolve(work, "early-cleanup");
  run(process.execPath, [resolve(root, "scripts/desktop/smoke.mjs"), "--package", extractedPackage, "--normal", "--out", normalSmokeOut]);
  run(process.execPath, [resolve(root, "scripts/desktop/smoke.mjs"), "--package", extractedPackage, "--out", syntheticSmokeOut]);
  run(process.execPath, [resolve(root, "scripts/desktop/verify-early-cleanup.mjs"), "--package", extractedPackage, "--out", earlyCleanupOut]);

  return {
    status: "PASS", bundle, zipPath, extractedPackage,
    sourceRevision: manifest.source.revision, sourceTreeSha256: manifest.source.treeSha256,
    packageVerify: packageVerify.status,
    evidence: { normalSmokeOut, syntheticSmokeOut, earlyCleanupOut }
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = argsFor(process.argv.slice(2), ["--bundle", "--work"]);
  if (args.help || !args["--bundle"] || !args["--work"]) {
    console.log("Usage: pnpm release:verify-bundle --bundle <release bundle directory> --work <new work directory>\nVerifies SHA256SUMS.txt and release-manifest.json, extracts the ZIP fresh, and re-runs package verify + normal smoke + synthetic smoke + early-cleanup against the extracted copy.");
  } else {
    try {
      const result = await verifyReleaseBundle({ bundleDir: args["--bundle"], workDir: args["--work"] });
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
