// Read-only Authenticode inspection of every PE file in a packaged RC
// directory. Never signs, never touches certificates or secrets -- it only
// reports what Get-AuthenticodeSignature already sees on disk.
//
// Classification is by fixed, explicit path list, not by observed signature
// state: a GoalPort-owned binary that happens to carry a leftover or
// invalidated upstream signature (electron-packager rewrites GoalPort.exe's
// resources, which normally invalidates any prior Electron signature) must
// never be reported as "signed by GoalPort" on that basis.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { COMPONENTS } from "../desktop/package.mjs";

const GOALPORT_OWNED = new Set(["GoalPort.exe", ...COMPONENTS.map((name) => `resources/${name}`)]);

function findPeFiles(root, prefix = "") {
  return readdirSync(resolve(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return findPeFiles(root, name);
    return /\.(exe|dll)$/i.test(entry.name) ? [name] : [];
  }).sort();
}

function classify(path) {
  if (GOALPORT_OWNED.has(path)) return "goalport-owned";
  if (path === "resources/app.asar") return "n/a";
  return "electron-upstream";
}

export function authenticodeInventory(packageRoot) {
  const root = resolve(packageRoot);
  const relPaths = findPeFiles(root);
  if (!relPaths.length) throw new Error(`No PE files found under ${root}`);
  const script = `
$ErrorActionPreference = 'Stop'
Import-Module Microsoft.PowerShell.Security -ErrorAction Stop
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$paths = @(${relPaths.map((p) => `'${resolve(root, p).replace(/'/g, "''")}'`).join(",")})
$results = foreach ($path in $paths) {
  $sig = Get-AuthenticodeSignature -FilePath $path
  [PSCustomObject]@{
    Path = $path
    Status = $sig.Status.ToString()
    StatusMessage = $sig.StatusMessage
    SignerSubject = if ($sig.SignerCertificate) { $sig.SignerCertificate.Subject } else { $null }
    SignerThumbprint = if ($sig.SignerCertificate) { $sig.SignerCertificate.Thumbprint } else { $null }
    HasTimestamp = [bool]$sig.TimeStamperCertificate
  }
}
$results | ConvertTo-Json -Depth 4
`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8", maxBuffer: 32 * 1024 * 1024, windowsHide: true
  });
  if (result.status !== 0) throw new Error(`Authenticode inspection failed: ${result.stderr || result.error}`);
  const raw = JSON.parse(result.stdout);
  const rows = Array.isArray(raw) ? raw : [raw];
  const byAbsolute = new Map(rows.map((row) => [resolve(row.Path), row]));
  return relPaths.map((relPath) => {
    const row = byAbsolute.get(resolve(root, relPath));
    if (!row) throw new Error(`Missing Authenticode result for ${relPath}`);
    return {
      path: relPath,
      category: classify(relPath),
      signed: row.Status === "Valid",
      status: row.Status,
      statusMessage: row.StatusMessage,
      signerSubject: row.SignerSubject,
      signerThumbprint: row.SignerThumbprint,
      hasTimestamp: row.HasTimestamp
    };
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const packageDir = process.argv[2];
  if (!packageDir || packageDir === "--help" || packageDir === "-h") {
    console.log("Usage: node scripts/release/authenticode-inventory.mjs <package-directory>\nRead-only Get-AuthenticodeSignature inventory of every .exe/.dll in the package. Signs nothing.");
  } else {
    try {
      console.log(JSON.stringify(authenticodeInventory(packageDir), null, 2));
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
