// Turns a verified `pnpm electron:package` output into the first downloadable
// GoalPort Windows RC candidate: a portable ZIP plus its release-manifest.json
// and SHA256SUMS.txt. See docs/releasing.md for the full contract.
//
// This never touches the package directory's own package-manifest.json
// inventory: legal files are added at an outer wrapper level, sibling to an
// untouched copy of the package, so the package's own manifest stays exactly
// verifiable and the release-manifest independently accounts for everything
// the ZIP actually contains.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { argsFor, claimOutput, fileHash, ROOT, sha256, sourceIdentity } from "../desktop/package.mjs";
import { verifyPackage } from "../desktop/verify-package.mjs";
import { authenticodeInventory } from "./authenticode-inventory.mjs";

const EXPECTED_CHANNEL = "Stable V1 RC";
const VERSION_PATTERN = /^\d+\.\d+\.\d+-rc\.\d+$/;

function readmeReleaseText(version, assetName) {
  return `GoalPort ${version} (${EXPECTED_CHANNEL}) - Windows x64 portable ZIP
=======================================================

Run:
  ${assetName}\\GoalPort-win32-x64\\GoalPort.exe

This is a portable, self-contained folder. There is no installer, and
nothing is written outside the folder except the normal per-user GoalPort
data directory the app creates on first run (see docs/local-data.md in the
source repository).

License material in this outer folder:
  GOALPORT-LICENSE.txt      - GoalPort's own Apache-2.0 license
  THIRD_PARTY_NOTICES.txt   - third-party components GoalPort ships

Electron's own upstream license material ships unmodified one level in, at
GoalPort-win32-x64\\LICENSE and GoalPort-win32-x64\\LICENSES.chromium.html.

Verify integrity with the SHA256SUMS.txt shipped alongside this ZIP as a
separate release asset, e.g. in PowerShell:
  Get-FileHash '${assetName}.zip' -Algorithm SHA256
`;
}

function powershell(script) {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true
  });
  if (result.status !== 0) throw new Error(`PowerShell step failed: ${result.stderr || result.error}`);
  return result.stdout;
}

function signingSummary(packageRoot) {
  const inventory = authenticodeInventory(packageRoot);
  const goalportOwned = inventory.filter((entry) => entry.category === "goalport-owned");
  const status = goalportOwned.every((entry) => !entry.signed) ? "unsigned"
    : goalportOwned.every((entry) => entry.signed) ? "signed" : "partially-signed";
  return { status, inventory };
}

export async function buildReleaseBundle({ packageDir, outDir, root = ROOT }) {
  // Cheap, fixture-independent gates first: never spend a package verify or
  // a copy on a request that was always going to be refused.
  const out = claimOutput(outDir, root);
  const packageRoot = resolve(packageDir);
  // verifyPackage() already enforces channel === "Stable V1 RC" and the RC
  // version pattern on the package's own manifest; only the repo-vs-package
  // cross-checks below are this script's job.
  const packageIdentity = verifyPackage(packageRoot);
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  if (!VERSION_PATTERN.test(pkg.version)) throw new Error("Repository package.json version must identify an RC");
  if (packageIdentity.version !== pkg.version) throw new Error(`Package version ${packageIdentity.version} does not match repository version ${pkg.version}`);
  const source = sourceIdentity(root);
  if (source.dirty) throw new Error("Refusing to bundle a release candidate from a dirty source tree");
  if (source.revision !== packageIdentity.sourceRevision) throw new Error("Live source revision does not match the package's recorded source revision; rebuild the package from current HEAD");
  if (source.treeSha256 !== packageIdentity.sourceTreeSha256) throw new Error("Live source tree digest does not match the package's recorded digest; rebuild the package from current HEAD");

  const assetName = `GoalPort-${pkg.version}-windows-x64`;
  const stageRoot = resolve(out, "stage", assetName);
  mkdirSync(stageRoot, { recursive: true });
  const stagedPackage = resolve(stageRoot, "GoalPort-win32-x64");
  cpSync(packageRoot, stagedPackage, { recursive: true, errorOnExist: true });
  // Re-verify the staged copy so a mid-copy corruption cannot slip into the ZIP unnoticed.
  const stagedIdentity = verifyPackage(stagedPackage);
  if (stagedIdentity.sourceTreeSha256 !== packageIdentity.sourceTreeSha256) throw new Error("Staged package copy does not match the original package identity");

  writeFileSync(resolve(stageRoot, "GOALPORT-LICENSE.txt"), readFileSync(resolve(root, "LICENSE")));
  const thirdPartyNotices = readFileSync(resolve(root, "release/THIRD_PARTY_NOTICES.txt"));
  writeFileSync(resolve(stageRoot, "THIRD_PARTY_NOTICES.txt"), thirdPartyNotices);
  writeFileSync(resolve(stageRoot, "README-RELEASE.txt"), readmeReleaseText(pkg.version, assetName));

  const zipPath = resolve(out, `${assetName}.zip`);
  const escaped = (value) => value.replace(/'/g, "''");
  powershell(`Compress-Archive -Path '${escaped(stageRoot)}' -DestinationPath '${escaped(zipPath)}' -CompressionLevel Optimal`);
  if (!existsSync(zipPath)) throw new Error("Compress-Archive did not produce the expected ZIP");
  const zipBytes = statSync(zipPath).size;
  const zipSha256 = fileHash(zipPath);

  const signing = signingSummary(stagedPackage);

  const manifest = {
    schemaVersion: 1,
    product: "GoalPort",
    version: pkg.version,
    channel: EXPECTED_CHANNEL,
    candidateTag: `v${pkg.version}`,
    source: { revision: source.revision, dirty: source.dirty, treeSha256: source.treeSha256 },
    packageManifest: {
      path: "GoalPort-win32-x64/package-manifest.json",
      sourceTreeSha256: packageIdentity.sourceTreeSha256,
      artifactCount: packageIdentity.artifacts.length
    },
    zip: { filename: `${assetName}.zip`, sha256: zipSha256, bytes: zipBytes },
    signing: { status: signing.status, inventory: signing.inventory },
    generatedAtUtc: new Date().toISOString(),
    generator: { script: "scripts/release/build-release-bundle.mjs", node: process.version }
  };
  const manifestPath = resolve(out, "release-manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const manifestSha256 = fileHash(manifestPath);

  const sumsLines = [
    `${zipSha256}  ${assetName}.zip`,
    `${manifestSha256}  release-manifest.json`
  ];
  writeFileSync(resolve(out, "SHA256SUMS.txt"), `${sumsLines.join("\n")}\n`);

  return { out, zipPath, manifestPath, version: pkg.version, sourceRevision: source.revision, zipSha256, signing: signing.status };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = argsFor(process.argv.slice(2), ["--package", "--out"]);
  if (args.help || !args["--package"] || !args["--out"]) {
    console.log("Usage: pnpm release:bundle --package <verified GoalPort-win32-x64 directory> --out <new-directory>\nBuilds the portable ZIP release candidate, release-manifest.json and SHA256SUMS.txt from an already-packaged and -verified RC.");
  } else {
    try {
      const result = await buildReleaseBundle({ packageDir: args["--package"], outDir: args["--out"] });
      console.log(JSON.stringify({ status: "PASS", ...result }, null, 2));
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
