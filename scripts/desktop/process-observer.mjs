import { spawnSync } from "node:child_process";

const STDERR_LIMIT = 500;

export function creationTime(value) {
  const match = String(value).match(/Date\((\d+)\)/);
  return match ? Number(match[1]) : Date.parse(value);
}

// CIM failures must stay distinguishable from "no such process": errors exit 3,
// and absence is an explicit marker rather than empty output.
export function observerCommand(pid) {
  return `$ErrorActionPreference='Stop'; try { $p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${Number(pid)}'; if ($p) { $p | Select-Object ProcessId,ParentProcessId,ExecutablePath,CreationDate | ConvertTo-Json -Compress } else { 'ABSENT' } } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 3 }`;
}

// Returns live, absent or unknown. Unknown is never proof that a process ended.
export function observeProcess(pid, { spawn = spawnSync, timeoutMs = 5000 } = {}) {
  const target = Number(pid);
  if (!Number.isSafeInteger(target) || target <= 0) throw new Error("valid process id required");
  const started = Date.now();
  const result = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", observerCommand(target)], { encoding: "utf8", windowsHide: true, timeout: timeoutMs });
  const elapsedMs = Date.now() - started;
  const unknown = (reason) => ({ state: "unknown", reason, status: result.status ?? null, signal: result.signal ?? null, errorCode: result.error?.code ?? null, elapsedMs, stderr: String(result.stderr ?? "").trim().slice(0, STDERR_LIMIT) });
  if (result.error) return unknown(`process observer did not complete: ${result.error.code || result.error.message}`);
  if (result.status !== 0) return unknown(`process observer exited with status ${result.status}`);
  const stdout = String(result.stdout ?? "").trim();
  if (stdout === "ABSENT") return { state: "absent", elapsedMs };
  let value;
  try { value = JSON.parse(stdout); } catch { return unknown("process observer output is not JSON"); }
  if (!value || typeof value !== "object" || Number(value.ProcessId) !== target) return unknown("process observer returned a different process");
  if (typeof value.ExecutablePath !== "string" || !value.ExecutablePath) return unknown("process observer returned no executable path");
  if (value.CreationDate == null || !Number.isFinite(creationTime(value.CreationDate))) return unknown("process observer returned no creation time");
  return { state: "live", ProcessId: target, ParentProcessId: value.ParentProcessId, ExecutablePath: value.ExecutablePath, CreationDate: value.CreationDate, elapsedMs };
}
