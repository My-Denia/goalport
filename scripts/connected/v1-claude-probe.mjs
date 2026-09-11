import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { isolatedDefaults } from "./v1-core-cmd.mjs";
import { freezeShas, requireOperationId } from "./v1-closure-rawrun.mjs";

const { evid, fix } = isolatedDefaults("claude-probe");
const operationId = requireOperationId();
const shas = freezeShas(evid);
const reportPath = resolve(evid, "claude-capability-probe.json");
const controlPath = resolve(evid, "claude-control.json");

function run(args, cwd = fix, timeout = 120_000) {
  try {
    const result = execFileSync("claude.exe", args, {
      cwd,
      encoding: "utf8",
      timeout,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024
    });
    return { ok: true, stdout: result, stderr: "", exit: 0 };
  } catch (error) {
    return {
      ok: false,
      stdout: String(error.stdout || ""),
      stderr: String(error.stderr || error.message || error),
      exit: typeof error.status === "number" ? error.status : 1
    };
  }
}

const help = run(["--help"], process.cwd(), 15_000);
const helpText = `${help.stdout}\n${help.stderr}`;
const surfaces = {
  printStreamJson: helpText.includes("-p") && helpText.includes("stream-json"),
  inputFormatStreamJson: helpText.includes("--input-format"),
  resume: helpText.includes("--resume") || /\s-r\s/.test(helpText),
  permissionMode: helpText.includes("--permission-mode"),
  bgAttachStop: /--bg|\battach\b|\bstop\b/.test(helpText)
};

const livePrint = run([
  "-p",
  "Reply exactly GOALPORT_CLAUDE_PROBE_OK. Do not use tools, modify files, or access the network.",
  "--output-format",
  "stream-json",
  "--verbose",
  "--max-turns",
  "1"
]);

const permissionProbe = run([
  "-p",
  "Reply exactly GOALPORT_CLAUDE_PERMISSION_PROBE. Do not modify files.",
  "--output-format",
  "stream-json",
  "--permission-mode",
  "dontAsk",
  "--max-turns",
  "1"
]);

const resumeProbe = run(["-p", "ping", "--resume", "nonexistent-session-id", "--output-format", "text", "--max-turns", "1"]);

const labels = {
  permissionCallback: surfaces.permissionMode && livePrint.ok
    ? (permissionProbe.ok ? "implemented-probe-only" : "unverified")
    : "unimplemented",
  cancel: surfaces.bgAttachStop ? "unverified" : "interface-unsupported",
  resume: surfaces.resume ? (resumeProbe.ok ? "unverified" : "unverified") : "interface-unsupported",
  skipPermissions: "forbidden"
};

const probe = {
  schemaVersion: 1,
  kind: "claude-capability-probe",
  capturedAtUtc: new Date().toISOString(),
  version: (run(["--version"], process.cwd(), 10_000).stdout || "").trim(),
  helpObserved: surfaces,
  livePrint: { ok: livePrint.ok, exit: livePrint.exit, sample: livePrint.stdout.slice(0, 1200) },
  permissionProbe: { ok: permissionProbe.ok, exit: permissionProbe.exit, sample: permissionProbe.stdout.slice(0, 800) },
  resumeProbe: { ok: resumeProbe.ok, exit: resumeProbe.exit, sample: `${resumeProbe.stdout}\n${resumeProbe.stderr}`.slice(0, 800) },
  labels,
  skippedDangerousFlags: true,
  status: livePrint.ok ? "PASS" : "UNMET"
};

const control = {
  schemaVersion: 1,
  kind: "claude-control",
  implemented: [],
  unverified: Object.entries(labels).filter(([, value]) => value === "unverified").map(([key]) => key),
  interfaceUnsupported: Object.entries(labels).filter(([, value]) => value === "interface-unsupported").map(([key]) => key),
  notes: "Claude remains one-shot stream-json unless a live probe proves a permission callback, cancel channel, or native resume. This run does not skip native permissions.",
  status: probe.status,
  operationId,
  runLabel: "goalport-stable-v1-closure",
  coreSha256: shas.coreSha256,
  exeSha256: shas.exeSha256
};

mkdirSync(evid, { recursive: true });
writeFileSync(reportPath, `${JSON.stringify({ ...probe, operationId, runLabel: "goalport-stable-v1-closure", coreSha256: shas.coreSha256, exeSha256: shas.exeSha256 }, null, 2)}\n`);
writeFileSync(controlPath, `${JSON.stringify(control, null, 2)}\n`);
console.log(JSON.stringify({ probe: reportPath, control: controlPath, status: probe.status }, null, 2));
process.exitCode = probe.status === "PASS" ? 0 : 1;
