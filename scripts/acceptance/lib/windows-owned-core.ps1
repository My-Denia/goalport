# Windows-only acceptance helper. Called ONLY by pwsh -NoProfile -NonInteractive
# -File. No environment/process inventory is emitted, and no title/tree kills.
param(
  [Parameter(Mandatory)][ValidateSet('scan','observe','stop','pipe')][string]$Action,
  [Parameter(Mandatory)][string]$Executable,
  [Parameter(Mandatory)][string]$Pipe,
  [Parameter(Mandatory)][string]$Database,
  [Parameter(Mandatory)][string]$StartedAt,
  [int]$OwnedPid = 0,
  [string]$CreationIdentity = ''
)
$ErrorActionPreference = 'Stop'
function Emit($value) { $value | ConvertTo-Json -Compress -Depth 5 }
function Unknown([string]$reason) { Emit @{ state = 'unknown'; reason = $reason.Substring(0, [Math]::Min(300, $reason.Length)) } }
try {
  if (-not $IsWindows -or -not [Environment]::Is64BitOperatingSystem) { throw 'Windows x64 only; no interop' }
  if (-not $Pipe.StartsWith('\\.\pipe\goalport-execute-and-native-acceptance-', [StringComparison]::Ordinal)) { throw 'not a this-run pipe' }
  $expectedExe = [IO.Path]::GetFullPath($Executable)
  $expectedDb = [IO.Path]::GetFullPath($Database)
  if (-not [IO.File]::Exists($expectedExe)) { throw 'bundled executable unavailable' }
  $started = [DateTimeOffset]::Parse($StartedAt).UtcDateTime
  if ($Action -eq 'pipe') {
    # Enumerate locally, emit only the exact owned name's presence. A failure is
    # unknown, not absence. Nothing is connected to a preexisting server.
    $present = @([IO.Directory]::GetFiles('\\.\pipe\') | Where-Object { [string]::Equals($_, $Pipe, [StringComparison]::OrdinalIgnoreCase) }).Count -gt 0
    Emit @{ state = $(if ($present) { 'live' } else { 'absent' }) }
    exit 0
  }
  # CommandLineToArgvW, not regex/substring matching, handles spaces and quotes.
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class GoalPortOwnedArgv {
  [DllImport("shell32.dll", EntryPoint="CommandLineToArgvW", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)] static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string command, out int count);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  public static string[] Parse(string command) {
    int count; IntPtr argv = CommandLineToArgvW(command, out count);
    if (argv == IntPtr.Zero) throw new InvalidOperationException("command line unavailable");
    try {
      string[] result = new string[count];
      for (int i=0; i<count; i++) result[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(argv, i * IntPtr.Size));
      return result;
    } finally { LocalFree(argv); }
  }
}
'@
  function OwnedRow($process) {
    if (-not $process.ExecutablePath -or -not $process.CommandLine -or -not $process.CreationDate) { throw 'potential Core identity unavailable/permission blocked' }
    if (-not [string]::Equals([IO.Path]::GetFullPath($process.ExecutablePath), $expectedExe, [StringComparison]::OrdinalIgnoreCase)) { return $null }
    $argv = [GoalPortOwnedArgv]::Parse($process.CommandLine)
    # Exact serve grammar, executable + fresh pipe + DB. Reject unknown extras.
    if ($argv.Count -ne 6 -or $argv[1] -cne 'serve' -or $argv[2] -cne '--pipe' -or $argv[4] -cne '--db') { return $null }
    if ($argv[3] -cne $Pipe -or -not [string]::Equals([IO.Path]::GetFullPath($argv[5]), $expectedDb, [StringComparison]::OrdinalIgnoreCase)) { return $null }
    $creation = ([datetime]$process.CreationDate).ToUniversalTime()
    if ($creation -lt $started) { throw 'matching Core predates run; ownership refused' }
    return @{
      state = 'live'; ProcessId = [int]$process.ProcessId;
      ExecutablePath = $expectedExe; Pipe = $Pipe; Database = $expectedDb;
      # CIM's DMTF precision is microseconds, not the handle's 100ns.
      # Canonicalize both observations to that same precision (no ms tolerance).
      CreationDate = $creation.ToString('o'); CreationIdentity = ($creation.Ticks - ($creation.Ticks % 10)).ToString()
    }
  }
  if ($Action -eq 'scan') {
    $owned = @()
    # Only candidate Core name rows are examined, never output unowned rows.
    foreach ($candidate in @(Get-CimInstance Win32_Process -Filter "Name = 'goalport-core.exe'" -ErrorAction Stop)) {
      $row = OwnedRow $candidate
      if ($null -ne $row) { $owned += $row }
      if ($owned.Count -gt 1) { throw 'ambiguous owned Core' }
    }
    Emit @{ state = 'known'; rows = @($owned) }
    exit 0
  }
  if ($OwnedPid -le 0 -or $CreationIdentity -notmatch '^\d{15,20}$') { throw 'PID and observed creation identity required' }
  $current = Get-CimInstance Win32_Process -Filter "ProcessId = $OwnedPid" -ErrorAction Stop
  if ($null -eq $current) { Emit @{ state = 'absent' }; exit 0 }
  $row = OwnedRow $current
  if ($null -eq $row -or $row.CreationIdentity -cne $CreationIdentity) { throw 'PID/start or ownership mismatch; stop refused' }
  if ($Action -eq 'observe') { Emit $row; exit 0 }
  # Open the specific process object/handle, compare its own start time again,
  # then kill that handle only. No Stop-Process by name/PID or taskkill tree.
  $handle = [Diagnostics.Process]::GetProcessById($OwnedPid)
  try {
    $handleTicks = $handle.StartTime.ToUniversalTime().Ticks
    if (($handleTicks - ($handleTicks % 10)).ToString() -cne $CreationIdentity) { throw 'process handle start mismatch; stop refused' }
    if (-not [string]::Equals([IO.Path]::GetFullPath($handle.MainModule.FileName), $expectedExe, [StringComparison]::OrdinalIgnoreCase)) { throw 'process handle executable mismatch; stop refused' }
    $handle.Kill()
    if (-not $handle.WaitForExit(5000)) { throw 'owned Core termination unconfirmed' }
    Emit @{ state = 'known'; stopped = $true; ProcessId = $OwnedPid; CreationIdentity = $CreationIdentity }
  } finally { $handle.Dispose() }
} catch { Unknown $_.Exception.Message; exit 3 }
