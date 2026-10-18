param(
  [Parameter(Mandatory = $true)][string]$RequestPath,
  [Parameter(Mandatory = $true)][string]$ResponsePath
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$NativeSource = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

[StructLayout(LayoutKind.Sequential)]
public struct GoalPortRect
{
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
}

[StructLayout(LayoutKind.Sequential)]
public struct GoalPortPoint
{
    public int X;
    public int Y;
}

public sealed class GoalPortWindowRef
{
    public IntPtr Handle;
    public uint ProcessId;
}

public static class GoalPortNativeWindow
{
    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    private delegate bool EnumWindowsProc(IntPtr handle, IntPtr state);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr state);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);

    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr handle);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr handle);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr handle);

    [DllImport("user32.dll")]
    public static extern bool IsZoomed(IntPtr handle);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern int GetWindowText(IntPtr handle, StringBuilder text, int maxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern int GetClassName(IntPtr handle, StringBuilder className, int maxCount);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool GetWindowRect(IntPtr handle, out GoalPortRect rect);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool GetClientRect(IntPtr handle, out GoalPortRect rect);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool ClientToScreen(IntPtr handle, ref GoalPortPoint point);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetWindowPos(IntPtr handle, IntPtr insertAfter, int x, int y, int width, int height, uint flags);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint GetDpiForWindow(IntPtr handle);

    [DllImport("user32.dll", EntryPoint = "SetThreadDpiAwarenessContext", SetLastError = true)]
    public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr dpiContext);

    public static List<GoalPortWindowRef> GetVisibleTopLevelWindows()
    {
        var windows = new List<GoalPortWindowRef>();
        EnumWindows((handle, state) => {
            if (!IsWindowVisible(handle)) return true;
            uint processId;
            GetWindowThreadProcessId(handle, out processId);
            if (processId > 1) windows.Add(new GoalPortWindowRef { Handle = handle, ProcessId = processId });
            return true;
        }, IntPtr.Zero);
        return windows;
    }
}
'@

function Assert-IntegerInRange([object]$Value, [long]$Minimum, [long]$Maximum, [string]$Name) {
  if ($null -eq $Value -or $Value -is [bool]) { throw "$Name must be an integer in range" }
  $number = [double]$Value
  if ([double]::IsNaN($number) -or [double]::IsInfinity($number) -or [Math]::Truncate($number) -ne $number -or $number -lt $Minimum -or $number -gt $Maximum) {
    throw "$Name must be an integer in range"
  }
}

function Get-ProcessSnapshot {
  $snapshot = [System.Collections.Generic.Dictionary[long, object]]::new()
  $processes = Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId, CreationDate -ErrorAction Stop
  foreach ($process in $processes) {
    $processId = [long]$process.ProcessId
    $parentProcessId = [long]$process.ParentProcessId
    try { $creationTicks = ([datetime]$process.CreationDate).ToUniversalTime().Ticks }
    catch { continue }
    if ($processId -gt 1 -and $creationTicks -gt 0) {
      $snapshot[$processId] = [pscustomobject]@{ ParentProcessId = $parentProcessId; CreationTicks = [long]$creationTicks }
    }
  }
  return ,$snapshot
}

function Get-OwnerChain([long]$ProcessId, [long]$RootPid, $Snapshot) {
  $visited = [System.Collections.Generic.HashSet[long]]::new()
  $chain = [System.Collections.Generic.List[long]]::new()
  $current = $ProcessId
  for ($depth = 0; $depth -lt 128; $depth += 1) {
    if ($current -le 1 -or -not $visited.Add($current)) { return $null }
    $chain.Add($current)
    if ($current -eq $RootPid) { return ,$chain.ToArray() }
    if (-not $Snapshot.ContainsKey($current)) { return $null }
    $child = $Snapshot[$current]
    $parentProcessId = [long]$child.ParentProcessId
    if (-not $Snapshot.ContainsKey($parentProcessId) -or
        $Snapshot[$parentProcessId].CreationTicks -gt $child.CreationTicks) { return $null }
    $current = $parentProcessId
  }
  return $null
}

function Get-WindowIdentity([IntPtr]$Handle) {
  $titleBuffer = [System.Text.StringBuilder]::new(1024)
  $classBuffer = [System.Text.StringBuilder]::new(256)
  [void][GoalPortNativeWindow]::GetWindowText($Handle, $titleBuffer, $titleBuffer.Capacity)
  [void][GoalPortNativeWindow]::GetClassName($Handle, $classBuffer, $classBuffer.Capacity)
  return [pscustomobject]@{ title = $titleBuffer.ToString(); className = $classBuffer.ToString() }
}

function Test-GoalPortIdentity($Identity) {
  $titleMatches = ($Identity.title -ceq 'GoalPort') -or $Identity.title.StartsWith('GoalPort ', [StringComparison]::Ordinal)
  $classMatches = $Identity.className -match '^(Chrome_WidgetWin_[0-9]+|Electron|GoalPort)$'
  return $titleMatches -and $classMatches
}

function Get-NativeBounds([IntPtr]$Handle) {
  $outer = [GoalPortRect]::new()
  $client = [GoalPortRect]::new()
  $clientOrigin = [GoalPortPoint]::new()
  if (-not [GoalPortNativeWindow]::GetWindowRect($Handle, [ref]$outer)) {
    $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    throw "GetWindowRect failed for the owned GoalPort window (Win32 error $errorCode)"
  }
  if (-not [GoalPortNativeWindow]::GetClientRect($Handle, [ref]$client)) {
    $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    throw "GetClientRect failed for the owned GoalPort window (Win32 error $errorCode)"
  }
  if (-not [GoalPortNativeWindow]::ClientToScreen($Handle, [ref]$clientOrigin)) {
    $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    throw "ClientToScreen failed for the owned GoalPort window (Win32 error $errorCode)"
  }
  $outerWidth = [int]($outer.Right - $outer.Left)
  $outerHeight = [int]($outer.Bottom - $outer.Top)
  $clientWidth = [int]($client.Right - $client.Left)
  $clientHeight = [int]($client.Bottom - $client.Top)
  if ($outerWidth -le 0 -or $outerHeight -le 0 -or $clientWidth -le 0 -or $clientHeight -le 0 -or $outerWidth -gt 32768 -or $outerHeight -gt 32768 -or $clientWidth -gt 32768 -or $clientHeight -gt 32768) {
    throw 'owned GoalPort window returned invalid native bounds'
  }
  $insets = [ordered]@{
    left = [int]($clientOrigin.X - $outer.Left)
    top = [int]($clientOrigin.Y - $outer.Top)
    right = [int]($outer.Right - ($clientOrigin.X + $clientWidth))
    bottom = [int]($outer.Bottom - ($clientOrigin.Y + $clientHeight))
  }
  if (@($insets.Values | Where-Object { $_ -lt 0 -or $_ -gt 512 }).Count -gt 0) {
    throw 'owned GoalPort window returned invalid native frame insets'
  }
  return [ordered]@{
    windowRect = [ordered]@{ x = [int]$outer.Left; y = [int]$outer.Top; width = $outerWidth; height = $outerHeight }
    clientRect = [ordered]@{ width = $clientWidth; height = $clientHeight }
    frameInsets = $insets
  }
}

function Assert-WindowStillOwned($Window, [long]$RootPid, $InitialSnapshot, [long[]]$InitialChain) {
  if (-not [GoalPortNativeWindow]::IsWindow($Window.Handle) -or -not [GoalPortNativeWindow]::IsWindowVisible($Window.Handle)) {
    throw 'owned GoalPort window disappeared or became hidden before resize'
  }
  $fresh = Get-ProcessSnapshot
  $currentPid = [uint32]0
  [void][GoalPortNativeWindow]::GetWindowThreadProcessId($Window.Handle, [ref]$currentPid)
  if ([long]$currentPid -ne [long]$Window.ProcessId) { throw 'owned GoalPort window identity changed before resize' }
  $chain = Get-OwnerChain -ProcessId ([long]$currentPid) -RootPid $RootPid -Snapshot $fresh
  if ($null -eq $chain -or ($chain -join ',') -cne ($InitialChain -join ',')) {
    throw 'owned GoalPort window process ancestry changed before resize'
  }
  foreach ($processId in $InitialChain) {
    if (-not $fresh.ContainsKey([long]$processId) -or
        -not $InitialSnapshot.ContainsKey([long]$processId) -or
        $fresh[[long]$processId].CreationTicks -ne $InitialSnapshot[[long]$processId].CreationTicks) {
      throw 'owned GoalPort process identity was reused before resize'
    }
  }
  $identity = Get-WindowIdentity $Window.Handle
  if (-not (Test-GoalPortIdentity $identity) -or $identity.title -cne $Window.Identity.title -or $identity.className -cne $Window.Identity.className) {
    throw 'owned GoalPort window title/class identity changed before resize'
  }
  return $fresh
}

function Invoke-OwnedWindowResize($Request) {
  $requestPid = [long]$Request.electronPid
  Assert-IntegerInRange $Request.electronPid 2 2147483647 'electronPid'
  Assert-IntegerInRange $Request.width 1 1440 'width'
  Assert-IntegerInRange $Request.height 900 900 'height'
  if (@(860, 1020, 1440) -cnotcontains [int]$Request.width) { throw 'requested viewport width is unsupported' }
  Assert-IntegerInRange $Request.currentViewport.width 1 16384 'currentViewport.width'
  Assert-IntegerInRange $Request.currentViewport.height 1 16384 'currentViewport.height'
  $dpr = [double]$Request.devicePixelRatio
  if ([double]::IsNaN($dpr) -or [double]::IsInfinity($dpr) -or $dpr -lt 0.5 -or $dpr -gt 8) { throw 'devicePixelRatio is outside the supported finite range' }

  $initialSnapshot = Get-ProcessSnapshot
  if (-not $initialSnapshot.ContainsKey($requestPid)) { throw 'owned Electron process is absent' }
  $ownedWindows = [System.Collections.Generic.List[object]]::new()
  foreach ($window in [GoalPortNativeWindow]::GetVisibleTopLevelWindows()) {
    # Do not fetch a title or class until its process has a verified parent chain to electronPid.
    $chain = Get-OwnerChain -ProcessId ([long]$window.ProcessId) -RootPid $requestPid -Snapshot $initialSnapshot
    if ($null -eq $chain) { continue }
    $identity = Get-WindowIdentity $window.Handle
    if (Test-GoalPortIdentity $identity) {
      $ownedWindows.Add([pscustomobject]@{
        Handle = $window.Handle
        ProcessId = [long]$window.ProcessId
        ProcessChain = [long[]]$chain
        Identity = $identity
      })
    }
  }
  if ($ownedWindows.Count -ne 1) {
    throw "owned GoalPort window absent or ambiguous ($($ownedWindows.Count) PID-owned matches); unrelated windows excluded"
  }
  $selected = $ownedWindows[0]
  if ([GoalPortNativeWindow]::IsIconic($selected.Handle) -or [GoalPortNativeWindow]::IsZoomed($selected.Handle)) {
    throw 'owned GoalPort window must be in its normal state; sizing will not change minimize/maximize state'
  }

  $dpiBefore = [GoalPortNativeWindow]::GetDpiForWindow($selected.Handle)
  if ($dpiBefore -lt 48 -or $dpiBefore -gt 768) { throw 'owned GoalPort window DPI is unavailable or outside bounds' }
  $scale = [double]$dpiBefore / 96.0
  if ([Math]::Abs($scale - $dpr) -gt [Math]::Max(0.015, $scale * 0.01)) {
    throw 'measured Windows DPI does not agree with the supplied devicePixelRatio'
  }
  $before = Get-NativeBounds $selected.Handle
  $expectedCurrentWidth = [int][Math]::Round([double]$Request.currentViewport.width * $dpr, 0, [MidpointRounding]::AwayFromZero)
  $expectedCurrentHeight = [int][Math]::Round([double]$Request.currentViewport.height * $dpr, 0, [MidpointRounding]::AwayFromZero)
  if ([Math]::Abs($before.clientRect.width - $expectedCurrentWidth) -gt 2 -or [Math]::Abs($before.clientRect.height - $expectedCurrentHeight) -gt 2) {
    throw 'native client bounds do not agree with the supplied current CSS viewport and devicePixelRatio'
  }

  $targetClientWidth = [int][Math]::Round($before.clientRect.width + (([double]$Request.width - [double]$Request.currentViewport.width) * $dpr), 0, [MidpointRounding]::AwayFromZero)
  $targetClientHeight = [int][Math]::Round($before.clientRect.height + (([double]$Request.height - [double]$Request.currentViewport.height) * $dpr), 0, [MidpointRounding]::AwayFromZero)
  if ($targetClientWidth -le 0 -or $targetClientHeight -le 0 -or $targetClientWidth -gt 32768 -or $targetClientHeight -gt 32768) {
    throw 'DPI-adjusted target client bounds are outside supported limits'
  }
  $frame = $before.frameInsets
  $target = [ordered]@{
    windowRect = [ordered]@{
      x = $before.windowRect.x
      y = $before.windowRect.y
      width = [int]($targetClientWidth + $frame.left + $frame.right)
      height = [int]($targetClientHeight + $frame.top + $frame.bottom)
    }
    clientRect = [ordered]@{ width = $targetClientWidth; height = $targetClientHeight }
    frameInsets = $frame
  }
  if ($target.windowRect.width -gt 32768 -or $target.windowRect.height -gt 32768) { throw 'DPI-adjusted target outer bounds are outside supported limits' }

  $fresh = Assert-WindowStillOwned $selected $requestPid $initialSnapshot $selected.ProcessChain
  $stillOwnedPid = [uint32]0
  [void][GoalPortNativeWindow]::GetWindowThreadProcessId($selected.Handle, [ref]$stillOwnedPid)
  if ([long]$stillOwnedPid -ne $selected.ProcessId) { throw 'owned GoalPort HWND was reused before native mutation' }
  $identityImmediatelyBefore = Get-WindowIdentity $selected.Handle
  if (-not (Test-GoalPortIdentity $identityImmediatelyBefore) -or
      $identityImmediatelyBefore.title -cne $selected.Identity.title -or
      $identityImmediatelyBefore.className -cne $selected.Identity.className) {
    throw 'owned GoalPort HWND identity changed before native mutation'
  }
  if ([GoalPortNativeWindow]::IsIconic($selected.Handle) -or [GoalPortNativeWindow]::IsZoomed($selected.Handle)) {
    throw 'owned GoalPort window changed minimize/maximize state before resize'
  }
  $currentBounds = Get-NativeBounds $selected.Handle
  if (($currentBounds.frameInsets | ConvertTo-Json -Compress) -cne ($before.frameInsets | ConvertTo-Json -Compress)) {
    throw 'owned GoalPort native frame changed before resize'
  }

  $attempts = 0
  $observed = $null
  $flags = [uint32](0x0002 -bor 0x0004 -bor 0x0010 -bor 0x0200) # NOMOVE | NOZORDER | NOACTIVATE | NOOWNERZORDER
  while ($attempts -lt 3) {
    $attempts += 1
    if (-not [GoalPortNativeWindow]::SetWindowPos($selected.Handle, [IntPtr]::Zero, 0, 0, [int]$target.windowRect.width, [int]$target.windowRect.height, $flags)) {
      $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      throw "SetWindowPos failed for the owned GoalPort window (Win32 error $errorCode)"
    }
    Start-Sleep -Milliseconds 75
    $observed = Get-NativeBounds $selected.Handle
    if ($observed.clientRect.width -eq $targetClientWidth -and $observed.clientRect.height -eq $targetClientHeight) { break }
    if ($attempts -lt 3) {
      $null = Assert-WindowStillOwned $selected $requestPid $initialSnapshot $selected.ProcessChain
      $retryFrame = Get-NativeBounds $selected.Handle
      if (($retryFrame.frameInsets | ConvertTo-Json -Compress) -cne ($before.frameInsets | ConvertTo-Json -Compress)) {
        throw 'owned GoalPort native frame changed during bounded resize'
      }
    }
  }
  if ($null -eq $observed -or $observed.clientRect.width -ne $targetClientWidth -or $observed.clientRect.height -ne $targetClientHeight) {
    throw 'bounded native resize did not attain the requested DPI-adjusted client bounds'
  }
  if ($observed.windowRect.x -ne $before.windowRect.x -or $observed.windowRect.y -ne $before.windowRect.y) {
    throw 'native resize changed the owned window position'
  }
  if (($observed.frameInsets | ConvertTo-Json -Compress) -cne ($before.frameInsets | ConvertTo-Json -Compress)) {
    throw 'owned GoalPort native frame changed during resize'
  }

  $null = Assert-WindowStillOwned $selected $requestPid $initialSnapshot $selected.ProcessChain
  $dpiAfter = [GoalPortNativeWindow]::GetDpiForWindow($selected.Handle)
  if ($dpiAfter -ne $dpiBefore) { throw 'owned GoalPort window DPI changed during resize' }
  return [ordered]@{
    schemaVersion = 1
    status = 'resized'
    method = 'Win32 SetWindowPos; temporary per-thread per-monitor-v2 DPI context'
    windowId = ('0x{0:X}' -f $selected.Handle.ToInt64())
    windowPid = [int]$selected.ProcessId
    ownership = [ordered]@{ rootPid = [int]$requestPid; windowPid = [int]$selected.ProcessId; processChain = @($selected.ProcessChain) }
    identity = [ordered]@{ title = $selected.Identity.title; className = $selected.Identity.className }
    request = [ordered]@{
      electronPid = [int]$requestPid
      width = [int]$Request.width
      height = [int]$Request.height
      currentViewport = [ordered]@{ width = [int]$Request.currentViewport.width; height = [int]$Request.currentViewport.height }
      devicePixelRatio = $dpr
    }
    dpi = [ordered]@{ before = [int]$dpiBefore; after = [int]$dpiAfter }
    before = $before
    target = $target
    observed = $observed
    attempts = $attempts
  }
}

try {
  $requestFull = [System.IO.Path]::GetFullPath($RequestPath)
  $responseFull = [System.IO.Path]::GetFullPath($ResponsePath)
  if ([System.IO.Path]::GetDirectoryName($requestFull) -cne [System.IO.Path]::GetDirectoryName($responseFull)) {
    throw 'request and response files must be in the same private temporary directory'
  }
  if (-not (Test-Path -LiteralPath $requestFull -PathType Leaf)) { throw 'request file is absent' }
  $request = Get-Content -LiteralPath $requestFull -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable -ErrorAction Stop
  if ($null -eq $request -or $request -isnot [System.Collections.IDictionary]) { throw 'request JSON must be an object' }
  if ($null -eq $request.currentViewport -or $request.currentViewport -isnot [System.Collections.IDictionary]) { throw 'currentViewport must be an object' }
  Add-Type -TypeDefinition $NativeSource -Language CSharp -ErrorAction Stop

  $previousDpiContext = [GoalPortNativeWindow]::SetThreadDpiAwarenessContext([IntPtr](-4))
  if ($previousDpiContext -eq [IntPtr]::Zero) {
    $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    throw "thread-local per-monitor-v2 DPI context is unavailable (Win32 error $errorCode)"
  }
  try {
    $response = Invoke-OwnedWindowResize $request
  } finally {
    $restoredContext = [GoalPortNativeWindow]::SetThreadDpiAwarenessContext($previousDpiContext)
    if ($restoredContext -eq [IntPtr]::Zero) { throw 'failed to restore the helper thread DPI awareness context' }
  }
  $json = ConvertTo-Json -InputObject $response -Depth 16 -Compress
  [System.IO.File]::WriteAllText($responseFull, $json, [System.Text.UTF8Encoding]::new($false))
} catch {
  [Console]::Error.WriteLine("Owned Windows native sizing refused: $($_.Exception.Message)")
  exit 2
}
