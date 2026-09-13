import { closeSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";

export const TAIL_BYTES = 4096;
export const TAIL_LINES = 40;
export const SUMMARY_FIELD_BYTES = 4096;
export const SUMMARY_MAX_BYTES = 65536;
const SUMMARY_DROP_ORDER = ["stack", "diagnostics", "rescue", "cleanup", "observationAttempts", "steps"];

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

// Cut on a UTF-8 character boundary. The result fits the limit whenever the limit is at
// least the marker length; the summary writer checks its final rendered size separately.
export function truncateUtf8(text, limit) {
  const bytes = Buffer.from(String(text), "utf8");
  if (bytes.length <= limit) return String(text);
  const marker = `…[truncated ${bytes.length} bytes]`;
  let keep = Math.max(0, limit - Buffer.byteLength(marker));
  while (keep > 0 && (bytes[keep] & 0xc0) === 0x80) keep -= 1;
  return `${bytes.subarray(0, keep).toString("utf8")}${marker}`;
}

// Every string is redacted before it is cut, so truncation can never expose part of a
// private path; the rendered file is then held under a fixed byte budget.
export function boundedFailureSummary(summary, privatePaths = [], { fieldBytes = SUMMARY_FIELD_BYTES, maxBytes = SUMMARY_MAX_BYTES } = {}) {
  const limit = (value) => typeof value === "string" ? truncateUtf8(sanitizeDiagnostic(value, privatePaths), fieldBytes)
    : Array.isArray(value) ? value.map(limit)
      : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, limit(item)])) : value;
  const render = (value) => `${JSON.stringify(value, null, 2)}\n`;
  const fits = (value) => Buffer.byteLength(render(value)) <= maxBytes;
  let bounded = limit(summary);
  for (const field of SUMMARY_DROP_ORDER) {
    if (fits(bounded)) break;
    if (field in bounded) bounded = { ...bounded, [field]: `[omitted: summary exceeded ${maxBytes} bytes]`, truncated: true };
  }
  // JSON escaping can grow a string, so shrink the essential fields until the rendering fits.
  const essential = { schemaVersion: bounded.schemaVersion, status: bounded.status, mode: bounded.mode, stage: bounded.stage, error: bounded.error, truncated: true };
  for (let budget = fieldBytes; !fits(bounded); budget = Math.floor(budget / 2)) {
    bounded = Object.fromEntries(Object.entries(essential).map(([key, value]) => [key, typeof value === "string" ? truncateUtf8(value, budget) : value]));
    if (budget === 0) break;
  }
  const rendered = render(bounded);
  if (Buffer.byteLength(rendered) > maxBytes) throw new Error(`failure summary cannot fit ${maxBytes} bytes`);
  return rendered;
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
