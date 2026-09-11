import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { EVID } from "./v1-isolated-env.mjs";

export function requireOperationId(argv = process.argv.slice(2)) {
  const index = argv.indexOf("--operation-id");
  const value = index >= 0 ? argv[index + 1] : "";
  if (!value || value.startsWith("-")) {
    console.error("missing --operation-id");
    process.exit(2);
  }
  return value;
}

export function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function freezeShas(evid = EVID) {
  const artifactPath = resolve(evid, "electron-artifact.json");
  if (!existsSync(artifactPath)) return { coreSha256: null, exeSha256: null, asarSha256: null };
  try {
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
    return {
      coreSha256: artifact.coreSha256 || null,
      exeSha256: artifact.exeSha256 || null,
      asarSha256: artifact.asarSha256 || null
    };
  } catch {
    return { coreSha256: null, exeSha256: null, asarSha256: null };
  }
}

export function captureCim(pid = process.pid) {
  const script = `Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}" | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress`;
  try {
    const parsed = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      timeout: 8000,
      windowsHide: true
    }) || "{}");
    const row = Array.isArray(parsed) ? parsed[0] : parsed;
    return {
      ProcessId: Number(row?.ProcessId || pid),
      ExecutablePath: String(row?.ExecutablePath || process.execPath),
      CommandLine: String(row?.CommandLine || `${process.execPath} ${process.argv.slice(1).join(" ")}`)
    };
  } catch {
    return {
      ProcessId: Number(pid),
      ExecutablePath: process.execPath,
      CommandLine: `${process.execPath} ${process.argv.slice(1).join(" ")}`
    };
  }
}

export function writeBearer({
  evid = EVID,
  evidenceClass,
  bearerBasename,
  semantic,
  operationId,
  extraIdentity = {},
  argv = process.argv.slice(1)
}) {
  const dir = resolve(evid, "raw-run", evidenceClass);
  mkdirSync(dir, { recursive: true });
  const stdoutPath = resolve(dir, `${operationId}.stdout.json`);
  writeFileSync(stdoutPath, `${JSON.stringify(semantic)}\n`);
  const stdoutSha256 = sha256Bytes(readFileSync(stdoutPath));
  const sidecar = {
    evidenceClass,
    operationId,
    argv: argv.map(String),
    stdoutPath,
    stdoutSha256,
    closedAtUtc: new Date().toISOString(),
    sidecarClosed: true,
    cimCapture: captureCim()
  };
  const sidecarPath = resolve(dir, `${operationId}.json`);
  writeFileSync(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);
  const sidecarSha256 = sha256Bytes(readFileSync(sidecarPath));
  const shas = freezeShas(evid);
  const report = {
    ...semantic,
    ...extraIdentity,
    operationId,
    sidecarSha256,
    coreSha256: extraIdentity.coreSha256 || shas.coreSha256,
    exeSha256: extraIdentity.exeSha256 || shas.exeSha256
  };
  const bearerPath = resolve(evid, bearerBasename);
  mkdirSync(dirname(bearerPath), { recursive: true });
  const sidecarMtime = statSync(sidecarPath).mtimeMs;
  writeFileSync(bearerPath, `${JSON.stringify(report, null, 2)}\n`);
  const later = new Date(sidecarMtime + 1000);
  utimesSync(bearerPath, later, later);
  return { stdoutPath, sidecarPath, sidecarSha256, bearerPath, report };
}
