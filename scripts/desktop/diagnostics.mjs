import { closeSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";

export const TAIL_BYTES = 4096;
export const TAIL_LINES = 40;

export function sanitizeDiagnostic(text, privatePaths = []) {
  let result = String(text);
  const paths = privatePaths.filter(Boolean).flatMap((name) => {
    try { return [name, realpathSync.native(name)]; } catch { return [name]; }
  }).sort((a, b) => b.length - a.length);
  for (const name of paths) {
    for (const variant of [name, name.replaceAll("\\", "/"), JSON.stringify(name).slice(1, -1)]) {
      result = result.replace(new RegExp(variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "<private-path>");
    }
  }
  return result
    .replace(/[A-Z]:[\\/]+Users[\\/]+[^\\/\s"']+/gi, "<user-profile>")
    .replace(/\/(?:home|Users)\/[^/\s"']+/g, "<user-profile>")
    .replace(/\bBearer\s+[^\s"']+/gi, "Bearer <redacted>")
    .replace(/\b((?:api[_-]?key|token|password)\s*[=:]\s*)[^\s,;"']+/gi, "$1<redacted>")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,})\b/g, "<redacted>");
}

function tail(file, privatePaths, close) {
  let fd;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    const bytes = Buffer.alloc(Math.min(size, TAIL_BYTES));
    const read = readSync(fd, bytes, 0, bytes.length, Math.max(0, size - bytes.length));
    const text = bytes.subarray(0, read).toString("utf8").split(/\r?\n/).slice(-TAIL_LINES).join("\n");
    return { available: true, truncated: size > read, text: sanitizeDiagnostic(text, privatePaths).slice(-TAIL_BYTES) };
  } catch (error) {
    return { available: false, code: error.code || "UNAVAILABLE" };
  } finally {
    // A failed close must not replace the failure these diagnostics describe.
    if (fd !== undefined) { try { close(fd); } catch {} }
  }
}

export function collectFailureDiagnostics({ stage, child, files, privatePaths, close = closeSync }) {
  return {
    stage,
    process: { pid: child?.pid ?? null, exitCode: child?.exitCode ?? null, signalCode: child?.signalCode ?? null, killed: Boolean(child?.killed) },
    tails: Object.fromEntries(Object.entries(files).map(([name, file]) => [name, tail(file, privatePaths, close)]))
  };
}
