import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import {
  DEFAULT_URL, FakePage, clickProbeExpression, createDebugSession, deriveSnapshotFromBody,
  hitTest, parseArgs, parseLocalUrl, runProtocol, snapshotExpression
} from "./ui-debug.mjs";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "ui-debug.mjs");

const connectedBody = {
  width: 1440, height: 900, title: "GoalPort",
  shell: { connection: "connected", campaignId: "campaign-7" },
  heading: "Fix the failing test",
  runtimeLabel: "Codex",
  composer: { present: true, characters: 12, disabled: false, placeholder: "Describe the next step", sendDisabled: false, stopPresent: true, reason: "Enter to send" },
  pendingDecisions: ["  Allow bash(command)  "],
  activeElement: "<textarea id=\"draft-message\"></textarea>",
  body: "conversation body"
};

test("deriveSnapshotFromBody keeps the preview-harness field names and shapes", () => {
  assert.deepEqual(deriveSnapshotFromBody(connectedBody), {
    mode: "connected-app", width: 1440, height: 900, title: "GoalPort",
    connection: "connected", campaignId: "campaign-7",
    heading: "Fix the failing test", runtimeLabel: "Codex",
    composer: { characters: 12, disabled: false, placeholder: "Describe the next step", sendDisabled: false, stopVisible: true, reason: "Enter to send" },
    pendingDecisions: ["Allow bash(command)"],
    activeElement: "<textarea id=\"draft-message\"></textarea>",
    body: "conversation body"
  });
});

test("absent shell and composer stay explicit nulls, decisions stay an empty array", () => {
  const snapshot = deriveSnapshotFromBody({ width: 860, height: 700, title: "GoalPort", body: "starting" });
  assert.equal(snapshot.connection, null);
  assert.equal(snapshot.campaignId, null);
  assert.equal(snapshot.composer, null);
  assert.deepEqual(snapshot.pendingDecisions, []);
  assert.equal(snapshot.heading, null);
  assert.equal(snapshot.runtimeLabel, null);
});

test("a shell without a connection attribute reports unknown instead of a guess", () => {
  assert.equal(deriveSnapshotFromBody({ shell: { campaignId: "c" }, body: "x" }).connection, "unknown");
});

test("activeElement is bounded to 250 chars and body to 8000", () => {
  const snapshot = deriveSnapshotFromBody({ activeElement: "a".repeat(300), body: "b".repeat(9000) });
  assert.equal(snapshot.activeElement.length, 250);
  assert.equal(snapshot.body.length, 8000);
});

test("sendDisabled distinguishes absent (null) from enabled (false), stopPresent maps to stopVisible", () => {
  const snapshot = deriveSnapshotFromBody({ composer: { present: true } });
  assert.equal(snapshot.composer.sendDisabled, null);
  assert.equal(snapshot.composer.stopVisible, false);
  assert.equal(snapshot.composer.disabled, false);
  assert.equal(snapshot.composer.characters, 0);
});

test("garbage body info degrades to a complete all-null snapshot", () => {
  assert.deepEqual(deriveSnapshotFromBody(null), {
    mode: "connected-app", width: null, height: null, title: null,
    connection: null, campaignId: null, heading: null, runtimeLabel: null,
    composer: null, pendingDecisions: [], activeElement: null, body: ""
  });
});

test("hitTest returns the element center for a visible control", () => {
  const rects = { element: { x: 100, y: 100, width: 100, height: 30 }, viewport: { width: 1024, height: 768 } };
  assert.deepEqual(hitTest(rects, { covered: true }), { x: 150, y: 115 });
  assert.deepEqual(hitTest(rects, {}), { x: 150, y: 115 });
});

test("hitTest refuses zero-area, off-viewport and covered controls", () => {
  const viewport = { width: 1024, height: 768 };
  assert.equal(hitTest({ element: { x: 0, y: 0, width: 0, height: 30 }, viewport }, { covered: true }), null);
  assert.equal(hitTest({ element: { x: 0, y: 0, width: 100, height: 0 }, viewport }, { covered: true }), null);
  assert.equal(hitTest({ element: { x: 1020, y: 0, width: 40, height: 30 }, viewport }, { covered: true }), null);
  assert.equal(hitTest({ element: { x: -60, y: 0, width: 100, height: 30 }, viewport }, { covered: true }), null);
  assert.equal(hitTest({ element: { x: 0, y: 0, width: 100, height: 30 }, viewport }, { covered: false }), null);
});

test("hitTest tolerates a partially offscreen control whose center is still in the viewport", () => {
  const point = hitTest({ element: { x: -40, y: 700, width: 100, height: 60 }, viewport: { width: 1024, height: 768 } }, { covered: true });
  assert.deepEqual(point, { x: 10, y: 730 });
});

test("hitTest refuses probes without rect or viewport", () => {
  assert.equal(hitTest(null), null);
  assert.equal(hitTest({ element: { x: 1, y: 1, width: 10, height: 10 } }), null);
  assert.equal(hitTest({ viewport: { width: 100, height: 100 } }), null);
});

test("the loopback URL boundary accepts only 127.0.0.1 and localhost http(s)", () => {
  assert.equal(parseLocalUrl("http://127.0.0.1:4186/").hostname, "127.0.0.1");
  assert.equal(parseLocalUrl("http://localhost:4173/goals/campaign-7").hostname, "localhost");
  assert.equal(parseLocalUrl("https://127.0.0.1:9443/").protocol, "https:");
  for (const refused of ["http://example.com/", "http://0.0.0.0:4186/", "file:///some-user/dist/index.html", "http://[::1]:4186/", "goalport", "", undefined, null]) {
    assert.throws(() => parseLocalUrl(refused), /ui-debug only drives|--url/, String(refused));
  }
});

test("parseArgs defaults to the workbench URL, parses flags and refuses non-loopback targets up front", () => {
  const options = parseArgs([]);
  assert.equal(options.url, DEFAULT_URL);
  assert.equal(options.cdpPort, null);
  assert.equal(options.selftest, false);
  assert.equal(parseArgs(["--cdp-port", "9222", "--url", "http://localhost:4173/"]).cdpPort, 9222);
  assert.equal(parseArgs(["--selftest"]).selftest, true);
  assert.throws(() => parseArgs(["--url", "http://example.com/"]), /refused example\.com/);
  assert.throws(() => parseArgs(["--cdp-port", "nope"]), /TCP port/);
  assert.throws(() => parseArgs(["--url"]), /needs a value/);
  assert.throws(() => parseArgs(["--wat"]), /Unknown ui-debug option/);
});

test("the gather expressions read the same controls as the preview harness", () => {
  for (const selector of [
    "#draft-message, .composer textarea",
    ".draft-composer-form button[type=\"submit\"], .composer button[type=\"submit\"]",
    ".composer-stop", ".goalport-shell", ".conversation-heading-main h2",
    ".runtime-picker-button strong", ".decision-request", ".composer-hint"
  ]) {
    assert.ok(snapshotExpression.includes(selector), selector);
  }
  const probe = clickProbeExpression(".runtime-picker-button");
  assert.ok(probe.includes(JSON.stringify(".runtime-picker-button")));
  assert.ok(probe.includes("scrollIntoView"));
  assert.ok(probe.includes("elementFromPoint"));
});

async function drive(requests, { snapshot, controls = {}, evaluateResults = {} } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = [];
  output.on("data", (chunk) => {
    for (const line of String(chunk).split("\n")) if (line) lines.push(JSON.parse(line));
  });
  const page = new FakePage({ ...(snapshot === undefined ? {} : { snapshot }), controls, evaluateResults });
  let stopped = false;
  const protocol = runProtocol(createDebugSession(page, { clickAttempts: 2, clickRetryDelayMs: 1 }), {
    input, output, ready: { ready: true, methods: ["preview_snapshot", "click", "evaluate", "screenshot", "quit"] },
    onStop: () => { stopped = true; }
  });
  input.end(`${requests.map((request) => (typeof request === "string" ? request : JSON.stringify(request))).join("\n")}\n`);
  await protocol;
  return { page, lines: lines.slice(1), stopped };
}

test("the protocol answers preview_snapshot with the derived snapshot", async () => {
  const { lines } = await drive([{ method: "preview_snapshot" }, { method: "quit" }], { snapshot: connectedBody });
  assert.deepEqual(lines[0], { ok: true, result: deriveSnapshotFromBody(connectedBody) });
});

test("click hit-tests first, then dispatches one real CDP mouse pair at the center", async () => {
  const { page, lines } = await drive([{ method: "click", selector: ".composer button[type=\"submit\"]" }, { method: "quit" }]);
  assert.equal(lines[0].ok, true);
  assert.deepEqual(lines[0].result, { selector: ".composer button[type=\"submit\"]", x: 150, y: 115 });
  assert.deepEqual(page.cdpCalls.map((call) => [call.method, call.params.type]), [
    ["Input.dispatchMouseEvent", "mousePressed"],
    ["Input.dispatchMouseEvent", "mouseReleased"]
  ]);
  assert.equal(page.cdpCalls[0].params.x, 150);
  assert.equal(page.cdpCalls[0].params.y, 115);
  assert.equal(page.cdpCalls[0].params.button, "left");
  assert.equal(page.cdpCalls[0].params.clickCount, 1);
});

test("click refuses missing and covered controls without dispatching anything", async () => {
  const { page, lines } = await drive([
    { method: "click", selector: ".not-there" },
    { method: "click", selector: ".overlay-covered" },
    { method: "quit" }
  ], { controls: { ".overlay-covered": { present: true, rect: { x: 0, y: 0, width: 200, height: 40 }, viewport: { width: 1024, height: 768 }, covered: false } } });
  assert.equal(lines[0].ok, false);
  assert.equal(lines[0].error, "Control missing, blocked or outside viewport: .not-there");
  assert.equal(lines[1].ok, false);
  assert.equal(lines[1].error, "Control missing, blocked or outside viewport: .overlay-covered");
  assert.deepEqual(page.cdpCalls, []);
});

test("evaluate and screenshot round-trip; unknown methods and malformed lines answer and survive", async (t) => {
  const dir = mkdtempSync(resolve(tmpdir(), "goalport-ui-debug-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const shot = resolve(dir, "nested", "page.png");
  const { lines } = await drive([
    { method: "evaluate", expression: "location.href" },
    { method: "screenshot", path: shot },
    { method: "detonate" },
    "{ not json",
    "[1, 2]",
    { method: "quit" }
  ], { evaluateResults: { "location.href": "http://127.0.0.1:4186/" } });
  assert.deepEqual(lines[0], { ok: true, result: "http://127.0.0.1:4186/" });
  assert.equal(lines[1].ok, true);
  assert.equal(lines[1].result, shot);
  assert.equal(existsSync(shot), true);
  assert.equal(readFileSync(shot).toString(), "png");
  assert.equal(lines[2].ok, false);
  assert.match(lines[2].error, /Unknown ui-debug method/);
  assert.equal(lines[3].ok, false);
  assert.equal(lines[4].ok, false);
  assert.match(lines[4].error, /must be a JSON object/);
});

test("quit answers, stops the session and no later line is processed", async () => {
  const { stopped, lines } = await drive([{ method: "quit" }, { method: "evaluate", expression: "location.href" }]);
  assert.deepEqual(lines, [{ ok: true, result: "closing", quit: true }]);
  assert.equal(stopped, true);
});

test("ui-debug --selftest verifies the wiring with a fake page and exits 0", () => {
  const run = spawnSync(process.execPath, [CLI, "--selftest"], { encoding: "utf8", timeout: 60_000 });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /selftest ok: preview_snapshot shape/);
  assert.match(run.stdout, /selftest ok: click dispatches real mouse events at the hit point/);
  assert.match(run.stdout, /ui-debug selftest passed/);
});

test("the CLI refuses a non-loopback --url before starting anything", () => {
  const run = spawnSync(process.execPath, [CLI, "--url", "http://example.com/"], { encoding: "utf8", timeout: 60_000 });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /refused example\.com/);
});

test("the CLI prints usage for --help and exits 0", () => {
  const run = spawnSync(process.execPath, [CLI, "--help"], { encoding: "utf8", timeout: 60_000 });
  assert.equal(run.status, 0);
  assert.match(run.stdout, /--cdp-port/);
  assert.match(run.stdout, /preview_snapshot/);
});
