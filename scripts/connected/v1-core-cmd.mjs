import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ensureCore, exchange, pipeNameFor, uiRequest, unwrap } from "./ipc-client.mjs";
import { assertIsolatedEnv, EVID, FIX } from "./v1-isolated-env.mjs";

export function isolatedDefaults(label) {
  assertIsolatedEnv();
  mkdirSync(EVID, { recursive: true });
  return {
    pipe: process.env.GOALPORT_CORE_PIPE || pipeNameFor(label),
    db: process.env.GOALPORT_CORE_DB,
    synthetic: process.env.GOALPORT_SYNTHETIC_ROOT || FIX,
    core: "target/release/goalport-core.exe",
    launcher: "target/release/goalport-core-launcher.exe",
    evid: EVID,
    fix: FIX
  };
}

export async function startIsolatedCore(label) {
  const cfg = isolatedDefaults(label);
  mkdirSync(dirname(resolve(cfg.db)), { recursive: true });
  const child = await ensureCore({
    core: cfg.core,
    launcher: cfg.launcher,
    pipe: cfg.pipe,
    db: cfg.db,
    cwd: resolve(import.meta.dirname, "../.."),
    timeoutMs: 15_000
  });
  return { ...cfg, child };
}

export async function cmd(pipe, id, type, payload = {}, timeoutMs = 120_000) {
  return unwrap(await exchange(pipe, uiRequest(id, type, payload), timeoutMs));
}
