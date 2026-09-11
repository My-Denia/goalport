import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { EVID, FIX, ROOT, RUN_SLUG } from "./v1-isolated-env.mjs";

const label = process.argv[2];
const script = process.argv[3];
if (!label || !script) {
  console.error("usage: v1-run-isolated.mjs <label> <script> [args...]");
  process.exit(2);
}
mkdirSync(EVID, { recursive: true });
const env = {
  ...process.env,
  GOALPORT_REQUIRE_ISOLATED: "1",
  GOALPORT_CORE_PIPE: `\\\\.\\pipe\\${RUN_SLUG}-${label}-${process.pid}`,
  GOALPORT_CORE_DB: resolve(EVID, `${label}.sqlite`),
  GOALPORT_SYNTHETIC_ROOT: FIX
};
const result = spawnSync(process.execPath, [resolve(ROOT, script), ...process.argv.slice(4)], {
  cwd: ROOT,
  env,
  encoding: "utf8",
  windowsHide: true,
  maxBuffer: 16 * 1024 * 1024
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.status ?? 1);
