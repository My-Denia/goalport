#!/usr/bin/env node
// Offline acceptance shim for issue #70. The generated codex/claude wrapper runs
// this instead of stub-harness.mjs directly. It runs the real stub harness
// unchanged, then appends ONE line per call to issue70-calls.jsonl with the
// identity, queue index, behavior and two booleans about the prompt. It never
// writes prompt text: the prompt is reduced to booleans before logging.
//
// Why two booleans: `plan-revise-1` is only part of a hashed command identity,
// so it never reaches argv. The revision chain's own prompts do carry fixed
// sentences (see coordinateGoal.ts), which is what `revisionPrompt` detects.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const [identity, ...argv] = process.argv.slice(2);
const stubDir = process.env.GOALPORT_STUB_DIR;
const harness = fileURLToPath(new URL("../stub-harness.mjs", import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(stubDir, "behavior.json"), "utf8"));
// The data-dir launch path forwards no stub env of its own, so the offline
// sentinel is taken from the stub directory the wrapper itself lives in.
const env = { ...process.env, GOALPORT_STUB_SENTINEL: config.sentinel };
const logFile = path.join(stubDir, "invocations.jsonl");
const before = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").split(/\r?\n/).filter(Boolean).length : 0;

const joined = argv.join("\n");
const result = spawnSync(process.execPath, [harness, identity, ...argv], { env, stdio: "inherit" });

const lines = fs.readFileSync(logFile, "utf8").split(/\r?\n/).filter(Boolean);
let entry = null;
try { entry = JSON.parse(lines[lines.length - 1]); } catch { /* keep null */ }
fs.appendFileSync(path.join(stubDir, "issue70-calls.jsonl"), `${JSON.stringify({
  ts: new Date().toISOString(),
  identity,
  invocationType: entry?.invocationType ?? null,
  queueIndex: entry?.queueIndex ?? null,
  behaviorId: entry?.behaviorId ?? null,
  exitCode: result.status,
  newHarnessLines: lines.length - before,
  mentionsPlanRevise1: joined.includes("plan-revise-1"),
  revisionPrompt: joined.includes("This is a revision of a saved plan") || joined.includes("The previous independent check is below"),
})}\n`, "utf8");
process.exitCode = result.status ?? 1;
