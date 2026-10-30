const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let cachedCanCreate = null;

function canCreateDirSymlink() {
  if (process.platform !== "win32") {
    return true;
  }
  if (cachedCanCreate !== null) {
    return cachedCanCreate;
  }
  let probeDir = null;
  try {
    probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "symlink-probe-"));
    const target = path.join(probeDir, "target");
    const link = path.join(probeDir, "link");
    fs.mkdirSync(target);
    fs.symlinkSync(target, link, "dir");
    cachedCanCreate = true;
  } catch (error) {
    if (error && (error.code === "EPERM" || error.code === "EACCES")) {
      cachedCanCreate = false;
    } else {
      // Any other unexpected error does not assume unprivileged; run the test
      cachedCanCreate = true;
    }
  } finally {
    if (probeDir) {
      try {
        fs.rmSync(probeDir, { recursive: true, force: true });
      } catch {
        // swallow cleanup errors
      }
    }
  }
  return cachedCanCreate;
}

function skipAliasKind(kind) {
  if (kind === "junction") {
    return process.platform === "win32" ? false : "junction aliases are win32-only";
  }
  if (kind === "symlink") {
    if (process.platform !== "win32") {
      return false;
    }
    return canCreateDirSymlink() ? false : "unprivileged Windows dir symlinks unavailable";
  }
  return false;
}

module.exports = {
  canCreateDirSymlink,
  skipAliasKind,
};
