import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ACCEPTANCE_WIDTHS = new Set([860, 1020, 1440]);
const MAX_PID = 0x7fffffff;
const MAX_DIMENSION = 32768;
const METHOD = 'Win32 SetWindowPos; temporary per-thread per-monitor-v2 DPI context';
const HELPER_PATH = fileURLToPath(new URL('./native-window.ps1', import.meta.url));

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function positiveFinite(value, max) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= max;
}

/** Validate the integration contract without touching the platform or starting a process. */
export function validateResizeRequest(input) {
  if (!isRecord(input)) throw new TypeError('native window request must be an object');
  const { electronPid, width, height, currentViewport, devicePixelRatio } = input;
  if (!Number.isInteger(electronPid) || electronPid <= 1 || electronPid > MAX_PID) {
    throw new RangeError('electronPid must be an owned Windows process id greater than 1');
  }
  if (!ACCEPTANCE_WIDTHS.has(width) || height !== 900) {
    throw new RangeError('requested viewport must be 860, 1020, or 1440 by 900 CSS pixels');
  }
  if (!isRecord(currentViewport)
      || !Number.isInteger(currentViewport.width) || !positiveFinite(currentViewport.width, MAX_DIMENSION)
      || !Number.isInteger(currentViewport.height) || !positiveFinite(currentViewport.height, MAX_DIMENSION)) {
    throw new RangeError('currentViewport must contain positive, finite integer CSS width and height');
  }
  if (!positiveFinite(devicePixelRatio, 8) || devicePixelRatio < 0.5) {
    throw new RangeError('devicePixelRatio must be finite and between 0.5 and 8');
  }
  return {
    electronPid,
    width,
    height,
    currentViewport: { width: currentViewport.width, height: currentViewport.height },
    devicePixelRatio,
  };
}

/** Pure, bounded parent-chain check shared by unit fixtures and the helper's policy. */
export function isOwnedProcess(pid, electronPid, parentOf) {
  if (!Number.isInteger(pid) || pid <= 1 || pid > MAX_PID
      || !Number.isInteger(electronPid) || electronPid <= 1 || electronPid > MAX_PID
      || typeof parentOf !== 'function') return false;
  const visited = new Set();
  let current = pid;
  for (let depth = 0; depth < 128; depth += 1) {
    if (current === electronPid) return true;
    if (!Number.isInteger(current) || current <= 1 || visited.has(current)) return false;
    visited.add(current);
    let parent;
    try { parent = parentOf(current); } catch { return false; }
    if (!Number.isInteger(parent) || parent <= 1 || parent > MAX_PID) return false;
    current = parent;
  }
  return false;
}

/** GoalPort title AND Electron window class; callers must establish PID ownership first. */
export function isGoalPortWindowIdentity(identity) {
  if (!isRecord(identity) || typeof identity.title !== 'string' || typeof identity.className !== 'string') return false;
  const titleMatches = identity.title === 'GoalPort' || identity.title.startsWith('GoalPort ');
  const classMatches = /^(?:Chrome_WidgetWin_[0-9]+|Electron|GoalPort)$/i.test(identity.className);
  return titleMatches && classMatches;
}

/** Select exactly one matching window from already-enumerated candidates; unrelated PIDs are ignored. */
export function selectOwnedGoalPortWindow(candidates, electronPid, parentOf) {
  if (!Array.isArray(candidates)) throw new TypeError('window candidates must be an array');
  const matches = [];
  for (const candidate of candidates) {
    if (!isRecord(candidate) || !isOwnedProcess(candidate.pid, electronPid, parentOf)) continue;
    // Title/class identity is considered only after the candidate PID reaches the owned Electron PID.
    if (isGoalPortWindowIdentity(candidate)) matches.push(candidate);
  }
  if (matches.length !== 1) {
    throw new Error(`owned GoalPort window absent or ambiguous (${matches.length} PID-owned matches); unrelated windows excluded`);
  }
  return matches[0];
}

/** JSON is written to a short-lived request file; no shell quoting or command-string interpolation. */
export function serializeResizeRequest(input) {
  return JSON.stringify(validateResizeRequest(input));
}

/** Build argv separately so paths containing spaces remain single, literal arguments. */
export function buildPowerShellInvocation(requestPath, responsePath, helperPath = HELPER_PATH) {
  for (const [label, value] of [['requestPath', requestPath], ['responsePath', responsePath], ['helperPath', helperPath]]) {
    if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty path`);
  }
  return {
    command: 'pwsh',
    args: ['-NoProfile', '-NonInteractive', '-File', helperPath, '-RequestPath', requestPath, '-ResponsePath', responsePath],
  };
}

function finiteInt(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

function validateRect(rect, label, { position = false } = {}) {
  if (!isRecord(rect)
      || (position && (!Number.isInteger(rect.x) || Math.abs(rect.x) > 100000
        || !Number.isInteger(rect.y) || Math.abs(rect.y) > 100000))
      || !finiteInt(rect.width, 1, MAX_DIMENSION)
      || !finiteInt(rect.height, 1, MAX_DIMENSION)) {
    throw new TypeError(`helper returned invalid ${label}`);
  }
  return rect;
}

function validateInsets(insets) {
  if (!isRecord(insets) || !['left', 'top', 'right', 'bottom'].every(key => finiteInt(insets[key], 0, 512))) {
    throw new TypeError('helper returned invalid native frame insets');
  }
  return insets;
}

function sameRequest(received, expected) {
  return isRecord(received)
    && received.electronPid === expected.electronPid
    && received.width === expected.width
    && received.height === expected.height
    && isRecord(received.currentViewport)
    && received.currentViewport.width === expected.currentViewport.width
    && received.currentViewport.height === expected.currentViewport.height
    && received.devicePixelRatio === expected.devicePixelRatio;
}

function validateOwnership(response, request) {
  const ownership = response.ownership;
  if (!isRecord(ownership) || ownership.rootPid !== request.electronPid
      || ownership.windowPid !== response.windowPid || !Array.isArray(ownership.processChain)
      || ownership.processChain.length < 1 || ownership.processChain.length > 128
      || ownership.processChain.some(pid => !finiteInt(pid, 2, MAX_PID))
      || new Set(ownership.processChain).size !== ownership.processChain.length
      || ownership.processChain[0] !== response.windowPid
      || ownership.processChain.at(-1) !== request.electronPid) {
    throw new Error('helper response does not prove a bounded owned-process chain to electronPid');
  }
}

/** Validate the helper's structured result and refuse target, identity, DPI, or geometry mismatches. */
export function validateNativeWindowResponse(response, rawRequest) {
  const request = validateResizeRequest(rawRequest);
  if (!isRecord(response) || response.schemaVersion !== 1 || response.status !== 'resized') {
    throw new Error('native window helper returned an unsupported or unsuccessful response');
  }
  if (response.method !== METHOD || !sameRequest(response.request, request)) {
    throw new Error('native window helper response does not match the requested method or viewport');
  }
  if (typeof response.windowId !== 'string' || !/^0x[0-9a-f]+$/i.test(response.windowId) || /^0x0+$/i.test(response.windowId)
      || !finiteInt(response.windowPid, 2, MAX_PID)) {
    throw new Error('native window helper returned an invalid window identity');
  }
  validateOwnership(response, request);
  if (!isGoalPortWindowIdentity(response.identity)) throw new Error('native window helper returned a non-GoalPort window identity');

  const before = response.before;
  const target = response.target;
  const observed = response.observed;
  if (!isRecord(before) || !isRecord(target) || !isRecord(observed)) throw new Error('native window helper omitted bounds diagnostics');
  validateRect(before.windowRect, 'pre-resize outer bounds', { position: true });
  validateRect(target.windowRect, 'target outer bounds', { position: true });
  validateRect(observed.windowRect, 'observed outer bounds', { position: true });
  validateRect(before.clientRect, 'pre-resize client bounds');
  validateRect(target.clientRect, 'target client bounds');
  validateRect(observed.clientRect, 'observed client bounds');
  const beforeInsets = validateInsets(before.frameInsets);
  const targetInsets = validateInsets(target.frameInsets);
  const observedInsets = validateInsets(observed.frameInsets);
  const sameInsets = (left, right) => ['left', 'top', 'right', 'bottom'].every(key => left[key] === right[key]);
  if (!sameInsets(beforeInsets, targetInsets) || !sameInsets(beforeInsets, observedInsets)
      || before.windowRect.width !== before.clientRect.width + beforeInsets.left + beforeInsets.right
      || before.windowRect.height !== before.clientRect.height + beforeInsets.top + beforeInsets.bottom) {
    throw new Error('native helper returned inconsistent pre-resize or frame-inset geometry');
  }

  const dpi = response.dpi;
  if (!isRecord(dpi) || !finiteInt(dpi.before, 48, 768) || !finiteInt(dpi.after, 48, 768) || dpi.before !== dpi.after) {
    throw new Error('native window DPI was unavailable or changed during resize');
  }
  const scale = dpi.before / 96;
  if (Math.abs(scale - request.devicePixelRatio) > Math.max(0.015, scale * 0.01)) {
    throw new Error('measured Windows DPI does not agree with the supplied devicePixelRatio');
  }
  const expectedCurrentWidth = Math.round(request.currentViewport.width * request.devicePixelRatio);
  const expectedCurrentHeight = Math.round(request.currentViewport.height * request.devicePixelRatio);
  if (Math.abs(before.clientRect.width - expectedCurrentWidth) > 2
      || Math.abs(before.clientRect.height - expectedCurrentHeight) > 2) {
    throw new Error('native client bounds do not agree with the supplied current CSS viewport and devicePixelRatio');
  }
  const expectedClientWidth = Math.round(before.clientRect.width + (request.width - request.currentViewport.width) * request.devicePixelRatio);
  const expectedClientHeight = Math.round(before.clientRect.height + (request.height - request.currentViewport.height) * request.devicePixelRatio);
  if (target.clientRect.width !== expectedClientWidth || target.clientRect.height !== expectedClientHeight
      || observed.clientRect.width !== expectedClientWidth || observed.clientRect.height !== expectedClientHeight) {
    throw new Error('native helper did not attain the DPI-adjusted requested client bounds');
  }
  if (target.windowRect.x !== before.windowRect.x || target.windowRect.y !== before.windowRect.y
      || observed.windowRect.x !== before.windowRect.x || observed.windowRect.y !== before.windowRect.y) {
    throw new Error('native helper changed the owned window position');
  }
  const insetWidth = beforeInsets.left + beforeInsets.right;
  const insetHeight = beforeInsets.top + beforeInsets.bottom;
  if (target.windowRect.width !== target.clientRect.width + insetWidth
      || target.windowRect.height !== target.clientRect.height + insetHeight
      || observed.windowRect.width !== observed.clientRect.width + observedInsets.left + observedInsets.right
      || observed.windowRect.height !== observed.clientRect.height + observedInsets.top + observedInsets.bottom) {
    throw new Error('native helper returned inconsistent client/frame geometry');
  }
  if (!finiteInt(response.attempts, 1, 3)) throw new Error('native helper exceeded its bounded resize attempts');

  return response;
}

/**
 * Synchronously resize the one verified GoalPort HWND to the requested CSS viewport's native client size.
 * The caller must read back innerWidth/innerHeight via CDP; native bounds alone do not prove CSS viewport acceptance.
 */
export function resizeOwnedWindowsWindow(input) {
  const request = validateResizeRequest(input);
  // This check deliberately precedes temp-file creation and any spawn; WSL/Linux never invokes pwsh.
  if (process.platform !== 'win32') throw new Error('owned Windows native sizing is available only on win32; no helper was invoked');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goalport-window-'));
  const requestPath = path.join(tempDir, 'request.json');
  const responsePath = path.join(tempDir, 'response.json');
  try {
    fs.writeFileSync(requestPath, serializeResizeRequest(request), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    const invocation = buildPowerShellInvocation(requestPath, responsePath);
    const child = spawnSync(invocation.command, invocation.args, {
      encoding: 'utf8',
      timeout: 20000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
      shell: false,
    });
    if (child.error) throw new Error(`owned Windows resize helper could not run: ${child.error.message}`);
    if (child.status !== 0) {
      const detail = (child.stderr || child.stdout || '').trim().slice(0, 2000);
      throw new Error(`owned Windows resize helper failed (exit ${child.status ?? 'unknown'}): ${detail || 'no diagnostic'}`);
    }
    if (!fs.existsSync(responsePath)) throw new Error('owned Windows resize helper exited without a response file');
    let response;
    try { response = JSON.parse(fs.readFileSync(responsePath, 'utf8')); }
    catch (error) { throw new Error(`owned Windows resize helper returned invalid JSON: ${error.message}`); }
    return validateNativeWindowResponse(response, request);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export const WINDOWS_WINDOW_METHOD = METHOD;
