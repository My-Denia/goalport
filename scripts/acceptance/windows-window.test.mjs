import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  WINDOWS_WINDOW_METHOD,
  buildPowerShellInvocation,
  isGoalPortWindowIdentity,
  isOwnedProcess,
  resizeOwnedWindowsWindow,
  selectOwnedGoalPortWindow,
  serializeResizeRequest,
  validateNativeWindowResponse,
  validateResizeRequest,
} from './lib/windows-window.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'lib/native-window.ps1');
const REQUEST = Object.freeze({
  electronPid: 4100,
  width: 1020,
  height: 900,
  currentViewport: { width: 860, height: 900 },
  devicePixelRatio: 1.25,
});

function nativeResponse(overrides = {}) {
  const frameInsets = { left: 8, top: 30, right: 8, bottom: 8 };
  const before = {
    windowRect: { x: 45, y: 70, width: 1091, height: 1163 },
    clientRect: { width: 1075, height: 1125 },
    frameInsets,
  };
  const target = {
    windowRect: { x: 45, y: 70, width: 1291, height: 1163 },
    clientRect: { width: 1275, height: 1125 },
    frameInsets,
  };
  const observed = structuredClone(target);
  return {
    schemaVersion: 1,
    status: 'resized',
    method: WINDOWS_WINDOW_METHOD,
    windowId: '0x00000000000004A1',
    windowPid: 4101,
    ownership: { rootPid: 4100, windowPid: 4101, processChain: [4101, 4100] },
    identity: { title: 'GoalPort 0.1.0 · RC', className: 'Chrome_WidgetWin_1' },
    request: structuredClone(REQUEST),
    dpi: { before: 120, after: 120 },
    before,
    target,
    observed,
    attempts: 1,
    ...overrides,
  };
}

test('request validation pins accepted widths, height, PID, current viewport and finite DPI', () => {
  assert.deepEqual(validateResizeRequest(REQUEST), REQUEST);
  for (const bad of [
    null,
    [],
    { ...REQUEST, electronPid: 0 },
    { ...REQUEST, electronPid: 1 },
    { ...REQUEST, electronPid: 1.5 },
    { ...REQUEST, electronPid: true },
    { ...REQUEST, electronPid: 0x80000000 },
    { ...REQUEST, width: 859 },
    { ...REQUEST, width: 1441 },
    { ...REQUEST, height: 899 },
    { ...REQUEST, currentViewport: null },
    { ...REQUEST, currentViewport: { width: 0, height: 900 } },
    { ...REQUEST, currentViewport: { width: 860.5, height: 900 } },
    { ...REQUEST, currentViewport: { width: 860, height: Infinity } },
    { ...REQUEST, devicePixelRatio: NaN },
    { ...REQUEST, devicePixelRatio: Infinity },
    { ...REQUEST, devicePixelRatio: 0 },
    { ...REQUEST, devicePixelRatio: 8.1 },
  ]) assert.throws(() => validateResizeRequest(bad));
});

test('owned process selection follows only bounded verified parent chains', () => {
  const parents = new Map([[4100, 3000], [4101, 4100], [4102, 4101], [99, 1], [98, 97], [97, 98]]);
  const parentOf = pid => parents.get(pid) ?? 0;
  assert.equal(isOwnedProcess(4100, 4100, parentOf), true);
  assert.equal(isOwnedProcess(4102, 4100, parentOf), true);
  assert.equal(isOwnedProcess(99, 4100, parentOf), false);
  assert.equal(isOwnedProcess(98, 4100, parentOf), false);
  assert.equal(isOwnedProcess(4102, 4100, () => { throw new Error('parent lookup failed'); }), false);

  const owned = { pid: 4102, title: 'GoalPort 1.0 · RC', className: 'Chrome_WidgetWin_1', hwnd: '0x45' };
  const unrelated = { pid: 99, title: 'GoalPort 1.0 · RC', className: 'Chrome_WidgetWin_1', hwnd: '0x99' };
  assert.equal(selectOwnedGoalPortWindow([unrelated, owned], 4100, parentOf), owned);
  assert.throws(() => selectOwnedGoalPortWindow([], 4100, parentOf), /absent or ambiguous/);
  assert.throws(() => selectOwnedGoalPortWindow([unrelated], 4100, parentOf), /absent or ambiguous/);
  assert.throws(() => selectOwnedGoalPortWindow([owned, { ...owned, hwnd: '0x46' }], 4100, parentOf), /2 PID-owned matches/);
  assert.throws(() => selectOwnedGoalPortWindow([{ ...owned, title: 'Unrelated' }], 4100, parentOf), /absent or ambiguous/);
  assert.throws(() => selectOwnedGoalPortWindow([{ ...owned, className: 'UnrelatedWindow' }], 4100, parentOf), /absent or ambiguous/);
});

test('identity requires both GoalPort title and recognized Electron window class', () => {
  assert.equal(isGoalPortWindowIdentity({ title: 'GoalPort', className: 'Chrome_WidgetWin_1' }), true);
  assert.equal(isGoalPortWindowIdentity({ title: 'GoalPort 0.1 · RC', className: 'Electron' }), true);
  assert.equal(isGoalPortWindowIdentity({ title: 'Another GoalPort', className: 'Chrome_WidgetWin_1' }), false);
  assert.equal(isGoalPortWindowIdentity({ title: 'GoalPort', className: 'UnrelatedWindow' }), false);
  assert.equal(isGoalPortWindowIdentity({ title: 'GoalPort', className: '' }), false);
});

test('request-file transport keeps paths with spaces as literal argv entries', () => {
  const encoded = serializeResizeRequest(REQUEST);
  assert.deepEqual(JSON.parse(encoded), REQUEST);
  const invocation = buildPowerShellInvocation(
    'C:\\Users\\Test User\\AppData\\Local\\Temp\\goalport window\\request.json',
    'C:\\Users\\Test User\\AppData\\Local\\Temp\\goalport window\\response.json',
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  );
  assert.equal(invocation.command, 'pwsh');
  assert.deepEqual(invocation.args, [
    '-NoProfile', '-NonInteractive', '-File', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    '-RequestPath', 'C:\\Users\\Test User\\AppData\\Local\\Temp\\goalport window\\request.json',
    '-ResponsePath', 'C:\\Users\\Test User\\AppData\\Local\\Temp\\goalport window\\response.json',
  ]);
  assert.equal(invocation.args.some(value => value.includes('"')), false, 'no shell-quoted command string is assembled');
  assert.throws(() => buildPowerShellInvocation('', 'response'), /non-empty path/);
});

test('structured helper response accepts owned native geometry and rejects identity, ancestry, DPI and bounds mismatch', () => {
  assert.equal(validateNativeWindowResponse(nativeResponse(), REQUEST).status, 'resized');
  const badResponses = [
    nativeResponse({ windowPid: 99 }),
    nativeResponse({ ownership: { rootPid: 4100, windowPid: 4101, processChain: [4101, 99] } }),
    nativeResponse({ identity: { title: 'Unrelated', className: 'Chrome_WidgetWin_1' } }),
    nativeResponse({ identity: { title: 'GoalPort', className: 'UnrelatedWindow' } }),
    nativeResponse({ dpi: { before: 144, after: 144 } }),
    nativeResponse({ dpi: { before: 120, after: 144 } }),
    nativeResponse({ before: { ...nativeResponse().before, clientRect: { width: 1000, height: 1125 } } }),
    nativeResponse({ target: { ...nativeResponse().target, clientRect: { width: 1274, height: 1125 } } }),
    nativeResponse({ observed: { ...nativeResponse().observed, windowRect: { ...nativeResponse().observed.windowRect, x: 46 } } }),
    nativeResponse({ attempts: 4 }),
    nativeResponse({ request: { ...REQUEST, width: 860 } }),
  ];
  for (const response of badResponses) assert.throws(() => validateNativeWindowResponse(response, REQUEST));
});

test('non-win32 calls fail before temporary-file creation and never invoke pwsh', (t) => {
  if (process.platform === 'win32') {
    t.skip('this refusal is the non-Windows path; the Windows job still pins the PowerShell helper source');
    return;
  }
  assert.throws(() => resizeOwnedWindowsWindow(REQUEST), /only on win32; no helper was invoked/);
});

test('PowerShell helper source pins ownership-before-identity, bounded native resize and local DPI scope', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  const ownershipGate = source.indexOf('$chain = Get-OwnerChain -ProcessId ([long]$window.ProcessId)');
  const identityRead = source.indexOf('$identity = Get-WindowIdentity $window.Handle', ownershipGate);
  assert.ok(ownershipGate >= 0 && identityRead > ownershipGate, 'title/class lookup follows verified PID ancestry');
  assert.match(source, /GetWindowThreadProcessId/);
  assert.match(source, /CreationDate/);
  assert.match(source, /CreationTicks -gt \$child\.CreationTicks/);
  assert.match(source, /SetWindowPos\(/);
  assert.match(source, /while \(\$attempts -lt 3\)/);
  assert.match(source, /SWP|NOMOVE \| NOZORDER \| NOACTIVATE \| NOOWNERZORDER/);
  assert.match(source, /SetThreadDpiAwarenessContext/);
  assert.match(source, /SetThreadDpiAwarenessContext\(\$previousDpiContext\)/);
  assert.doesNotMatch(source, /SetProcessDpiAwareness|SetProcessDPIAware|ChangeDisplaySettings|CurrentVersion\\Run/i);
  assert.match(source, /unrelated windows excluded/);
});
