import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { EVID } from "./v1-isolated-env.mjs";
import { requireOperationId } from "./v1-closure-rawrun.mjs";

const operationId = requireOperationId();
mkdirSync(EVID, { recursive: true });

function queryToasts() {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
\$aumid = 'GoalPort.Desktop'
\$xml = Get-WinEvent -LogName 'Microsoft-Windows-PushNotification-Platform/Operational' -MaxEvents 50 | Where-Object { \$_.Message -match 'GoalPort' -or \$_.Message -match \$aumid }
\$center = \$null
try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  \$hist = [Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory(\$aumid)
  \$center = @(\$hist | ForEach-Object { \$_.Content.GetXml() })
} catch {}
[pscustomobject]@{
  eventCount = @(\$xml).Count
  historyCount = @(\$center).Count
  sample = @(\$center | Select-Object -First 2)
} | ConvertTo-Json -Compress -Depth 4
`;
  try {
    return JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 15000, windowsHide: true }) || "{}");
  } catch (error) {
    return { error: String(error.message || error), eventCount: 0, historyCount: 0 };
  }
}

const observed = queryToasts();
const pixels = Number(observed.historyCount || 0) > 0 || Number(observed.eventCount || 0) > 0;
const report = {
  schemaVersion: 1,
  kind: "electron-notifications",
  operationId,
  aumid: "GoalPort.Desktop",
  startMenuShortcutCreated: false,
  pixelsCaptured: Boolean(pixels),
  blockingDecisionToast: false,
  taskCompletionToast: false,
  observed,
  status: pixels ? "PASS" : "UNMET",
  blockerClass: pixels ? null : "os-notification",
  reason: pixels
    ? "Toast history or PushNotification events observed for AUMID GoalPort.Desktop"
    : "AUMID GoalPort.Desktop is set on the packaged-folder identity. Visible Windows toast pixels were not captured without a Start Menu or user-profile shortcut, which this run forbids."
};
writeFileSync(resolve(EVID, "electron-notifications.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.status === "PASS" ? 0 : 1;
