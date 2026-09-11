import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const argv = process.argv.slice(2);
const value = (name, fallback) => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : fallback; };
const candidates = (value("--candidates", "claude,grok")).split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
const reportPath = resolve(ROOT, value("--report", "goal-runs/goalport-stable-v1-closure/evidence/second-runtime-selection.json"));
const evidencePath = value("--qualification-evidence", undefined);
const live = argv.includes("--live");
const syntheticRoot = resolve(ROOT, value("--synthetic-root", process.env.GOALPORT_SYNTHETIC_ROOT || "goal-runs/goalport-stable-v1-closure/fixtures/synthetic-workspace"));

const executable = { claude: "claude", grok: "grok", codex: "codex" };
const removedApiKeyNames = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "XAI_API_KEY", "GROK_API_KEY", "CODEX_API_KEY"];
const inheritedBehaviorKeys = ["NO_COLOR", "TERM", "CODEX_CI", "CI"].filter((key) => process.env[key] !== undefined);
const results = [];
for (const candidate of candidates) {
  if (live && results.some((item) => item.qualified)) {
    results.push({ candidate, status: "not-attempted-preferred-qualified", qualified: false, selection: "preferred-candidate-qualified" });
    continue;
  }
  const command = executable[candidate];
  if (!command) { results.push({ candidate, status: "unsupported-candidate", qualified: false }); continue; }
  try {
    const output = await run(process.platform === "win32" ? `${command}.exe` : command, ["--version"], { cwd: ROOT, timeout: 10_000, windowsHide: true, maxBuffer: 32 * 1024 });
    const version = String(output.stdout || output.stderr || "").trim().split(/\r?\n/)[0].slice(0, 160);
    const result = { candidate, status: "version-observed", version, qualified: false, capability: { events: "unverified", permission: "unverified", cancel: "unverified", resume: "unverified", nativeConfig: "unverified" } };
    if (live) {
      const prompt = "Reply exactly GOALPORT_SECOND_RUNTIME_OK. Do not use tools, modify files, access the network, or perform external actions.";
      const liveArgs = candidate === "claude"
        ? ["-p", prompt, "--output-format", "stream-json", "--max-turns", "1", "--verbose"]
        : ["-p", prompt, "--output-format", "streaming-json", "--max-turns", "1", "--no-subagents", "--disable-web-search"];
      try {
        const liveOutput = await run(process.platform === "win32" ? `${command}.exe` : command, liveArgs, {
          cwd: syntheticRoot,
          timeout: 180_000,
          windowsHide: true,
          maxBuffer: 2 * 1024 * 1024,
          env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "XAI_API_KEY", "GROK_API_KEY", "CODEX_API_KEY"].includes(key)))
        });
        const stdout = String(liveOutput.stdout || "");
        const sessionId = stdout.match(/"(?:session_id|sessionId|thread_id|threadId)"\s*:\s*"([^"]+)"/)?.[1] || null;
        result.live = { exit: 0, responseObserved: /GOALPORT_SECOND_RUNTIME_OK|assistant|result|turn\.completed|message/i.test(stdout), distinctNativeSession: Boolean(sessionId), sessionIdentityObserved: Boolean(sessionId), stdoutSha256: (await import("node:crypto")).createHash("sha256").update(stdout).digest("hex"), stdoutBytes: Buffer.byteLength(stdout), argv: [command, ...liveArgs.map((item) => item === prompt ? "<synthetic-prompt>" : item)], cwd: "<synthetic-workspace>", authType: "native CLI subscription", apiKeyInjected: false, removedApiKeyNames, inheritedBehaviorKeys };
        result.qualified = result.live.responseObserved && result.live.distinctNativeSession;
        result.capability.events = result.live.responseObserved ? "observed" : "unmet";
      } catch (liveError) {
        result.live = { exit: typeof liveError.status === "number" ? liveError.status : 1, responseObserved: false, distinctNativeSession: false, error: String(liveError.message || liveError).slice(0, 240) };
      }
    }
    results.push(result);
  } catch (error) {
    results.push({ candidate, status: "unavailable", error: String(error.message || error).replace(/[A-Za-z]:[\\/][^\s]*/g, "<workspace>"), qualified: false });
  }
}
if (evidencePath) {
  try {
    const evidence = JSON.parse(await (await import("node:fs/promises")).readFile(resolve(ROOT, evidencePath), "utf8"));
    const qualified = evidence?.status === "PASS" && evidence?.nativeResponse === true && evidence?.distinctNativeSession === true;
    if (qualified && evidence.provider) {
      const selected = results.find((item) => item.candidate === String(evidence.provider).toLowerCase());
      if (selected) { selected.qualified = true; selected.qualificationEvidence = evidencePath; }
    }
  } catch (error) {
    results.push({ candidate: "qualification-evidence", status: "invalid", error: String(error.message || error) });
  }
}
// Claude is the preferred second path; once one candidate has a real native
// response, later candidates remain observed alternatives and are not silently
// promoted into a second handoff owner.
const firstQualified = results.find((item) => item.qualified);
if (firstQualified) {
  for (const item of results) {
    if (item !== firstQualified && item.qualified) {
      item.qualified = false;
      item.selection = "observed-alternative-not-selected";
    }
  }
}
const qualified = results.filter((item) => item.qualified);
const report = { schemaVersion: 1, kind: "second-runtime-selection", candidates: results, qualifiedRuntime: qualified.length === 1 ? qualified[0].candidate : null, status: qualified.length === 1 ? "PASS" : "NONE_QUALIFIED", rule: "A version alone never qualifies a handoff Runtime; a qualifying candidate needs a real native response and a distinct native session/thread identity. First Runtime permission, safe stop and resume gates are reported separately." };
mkdirSync(resolve(reportPath, ".."), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.status === "PASS" ? 0 : 1;
