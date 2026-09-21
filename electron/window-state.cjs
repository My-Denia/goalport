// Window bounds persistence for the integrated title bar shell.
//
// Scope: remembers the last normal (non-maximized) window rectangle plus the
// maximized flag in the app's own userData domain. Nothing else is persisted.
// Restored bounds are clamped so the window never opens off-screen: the
// rectangle must fit at least 100x100 DIP inside a known display work area,
// otherwise the stored geometry is discarded and the workArea default applies.

const fs = require("node:fs");
const path = require("node:path");

const STATE_FILE = "window-state.json";
const SCHEMA_VERSION = 1;
const MIN_RESTORED_WIDTH = 480;
const MIN_RESTORED_HEIGHT = 420;

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function rectangleFitsDisplay(bounds, display) {
  const area = display.workArea;
  const visibleWidth = Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x);
  const visibleHeight = Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y);
  return visibleWidth >= 100 && visibleHeight >= 100;
}

/** Returns the default window rectangle adapted to a display work area. */
function defaultBounds(display) {
  const area = display?.workArea ?? { x: 0, y: 0, width: 1440, height: 920 };
  // Leave room for the taskbar and neighbouring windows; never exceed the work
  // area, and keep a sensible default on very small displays.
  const width = Math.max(MIN_RESTORED_WIDTH, Math.min(1440, area.width - 48));
  const height = Math.max(MIN_RESTORED_HEIGHT, Math.min(920, area.height - 48));
  return {
    x: Math.round(area.x + Math.max(0, (area.width - width) / 2)),
    y: Math.round(area.y + Math.max(0, (area.height - height) / 2)),
    width: Math.round(width),
    height: Math.round(height)
  };
}

function loadWindowState({ statePath, displays, primaryDisplay }) {
  let stored = null;
  try {
    stored = JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    stored = null; // Missing or unreadable state is not an error; defaults apply.
  }
  if (
    !stored
    || stored.schemaVersion !== SCHEMA_VERSION
    || !isFiniteNumber(stored.x) || !isFiniteNumber(stored.y)
    || !isFiniteNumber(stored.width) || !isFiniteNumber(stored.height)
    || stored.width < MIN_RESTORED_WIDTH
    || stored.height < MIN_RESTORED_HEIGHT
  ) {
    return { bounds: defaultBounds(primaryDisplay), maximized: false };
  }
  const bounds = {
    x: Math.round(stored.x), y: Math.round(stored.y),
    width: Math.round(stored.width), height: Math.round(stored.height)
  };
  const visibleSomewhere = displays.some((display) => rectangleFitsDisplay(bounds, display));
  return {
    bounds: visibleSomewhere ? bounds : defaultBounds(primaryDisplay),
    maximized: stored.maximized === true
  };
}

function saveWindowState({ statePath, win }) {
  if (!win || win.isDestroyed()) return;
  try {
    const maximized = win.isMaximized();
    const bounds = maximized ? win.getNormalBounds() : win.getBounds();
    if (!isFiniteNumber(bounds.x) || !isFiniteNumber(bounds.y)) return;
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, `${JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
      maximized
    }, null, 2)}\n`);
  } catch {
    // Window geometry persistence is best-effort; never block the close path.
  }
}

module.exports = { defaultBounds, loadWindowState, saveWindowState, STATE_FILE };
