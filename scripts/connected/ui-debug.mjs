// Agent-observable debug surface for the REAL connected app (AGENTS.md §3 prerequisite 5).
// The preview harness (scripts/preview/harness.mjs) defines the semantics; this CLI
// promotes them to a maintained, tested tool that drives the workbench-served dist
// over CDP. It lives in scripts/ only: the shipped app carries no debug hooks.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import readline from "node:readline";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { attachGoalPort } from "./v1-cdp.mjs";

export const METHODS = ["preview_snapshot", "click", "evaluate", "screenshot", "quit"];
export const DEFAULT_URL = "http://127.0.0.1:4186/";
const SNAPSHOT_PREFIX = "/*gp-ui-debug:snapshot*/";
const CLICK_PROBE_PREFIX = "/*gp-ui-debug:click-probe*/";
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// Page-side gather expression: reads the same controls the preview harness reads
// (scripts/preview/harness.mjs:103-115) and returns raw values only. Every semantic
// decision (nulls, bounds, trimming, labels) happens in deriveSnapshotFromBody below,
// where it is unit-tested.
export const snapshotExpression = `${SNAPSHOT_PREFIX}(() => {
  const composer = document.querySelector('#draft-message, .composer textarea');
  const send = document.querySelector('.draft-composer-form button[type="submit"], .composer button[type="submit"]');
  const stop = document.querySelector('.composer-stop');
  const shell = document.querySelector('.goalport-shell');
  return {
    width: innerWidth, height: innerHeight, title: document.title,
    shell: shell ? { connection: shell.dataset.connection ?? null, campaignId: shell.dataset.campaignId ?? null } : null,
    heading: document.querySelector('.conversation-heading-main h2')?.textContent ?? null,
    runtimeLabel: document.querySelector('.runtime-picker-button strong')?.textContent ?? null,
    composer: composer
      ? { present: true, characters: composer.value.length, disabled: composer.disabled, placeholder: composer.placeholder,
          sendDisabled: send ? send.disabled : null, stopPresent: Boolean(stop),
          reason: document.querySelector('.composer-hint')?.textContent ?? null }
      : { present: false },
    pendingDecisions: Array.from(document.querySelectorAll('.decision-request')).map((e) => e.textContent.trim()),
    activeElement: document.activeElement?.outerHTML ?? null,
    body: document.body?.innerText ?? "" };
})()`;

// Page-side click probe, adapted from scripts/preview/harness.mjs:81-91: scroll the
// control into view, then report geometry, viewport and coverage so node-side
// hitTest() can decide the point.
export function clickProbeExpression(selector) {
  return `${CLICK_PROBE_PREFIX}(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e || e.disabled) return null;
    e.scrollIntoView({ block: 'center' });
    const r = e.getBoundingClientRect();
    const x = r.x + r.width / 2, y = r.y + r.height / 2;
    const top = document.elementFromPoint(x, y);
    return { present: true, rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      viewport: { width: innerWidth, height: innerHeight }, covered: top === e || e.contains(top) };
  })()`;
}

// Derive the semantic snapshot from the raw page body info. Field names match
// scripts/preview/harness.mjs:103-115 exactly; `mode` and `connection` carry the
// connected app's own values instead of the preview literals.
export function deriveSnapshotFromBody(raw, { mode = "connected-app" } = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const shell = source.shell && typeof source.shell === "object" ? source.shell : null;
  const composerInfo = source.composer && typeof source.composer === "object" ? source.composer : null;
  const composer = composerInfo && composerInfo.present
    ? {
        characters: composerInfo.characters ?? 0,
        disabled: Boolean(composerInfo.disabled),
        placeholder: composerInfo.placeholder ?? null,
        sendDisabled: composerInfo.sendDisabled ?? null,
        stopVisible: Boolean(composerInfo.stopPresent),
        reason: composerInfo.reason ?? null
      }
    : null;
  return {
    mode,
    width: source.width ?? null,
    height: source.height ?? null,
    title: source.title ?? null,
    connection: shell ? (shell.connection ?? "unknown") : null,
    campaignId: shell ? (shell.campaignId ?? null) : null,
    heading: source.heading ?? null,
    runtimeLabel: source.runtimeLabel ?? null,
    composer,
    pendingDecisions: Array.isArray(source.pendingDecisions) ? source.pendingDecisions.map((text) => String(text).trim()) : [],
    activeElement: typeof source.activeElement === "string" ? source.activeElement.slice(0, 250) : null,
    body: typeof source.body === "string" ? source.body.slice(0, 8000) : ""
  };
}

// Decide the click point for one control (visibility / viewport / coverage), the
// node-side half of scripts/preview/harness.mjs:81-91.
//   rects  { element: { x, y, width, height }, viewport: { width, height } }
//   target { covered: boolean } — elementFromPoint at the center hit the control or a descendant
// Returns the element center, or null when the control has no visible area, sits
// outside the viewport, or is covered by another element.
export function hitTest(rects, target = {}) {
  const rect = rects && typeof rects === "object" ? rects.element : null;
  const viewport = rects && typeof rects === "object" ? rects.viewport : null;
  if (!rect || !viewport || typeof rect !== "object" || typeof viewport !== "object") return null;
  if (!(rect.width > 0) || !(rect.height > 0)) return null;
  const x = rect.x + rect.width / 2;
  const y = rect.y + rect.height / 2;
  if (x < 0 || x >= viewport.width || y < 0 || y >= viewport.height) return null;
  if (target && target.covered === false) return null;
  return { x, y };
}

// ui-debug drives loopback pages only. The workbench itself binds 127.0.0.1 and
// checks Host/Origin the same way (scripts/connected/linux-workbench.py).
export function parseLocalUrl(raw) {
  if (typeof raw !== "string" || raw.trim() === "") throw new Error("--url must be a URL string");
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`--url is not a valid URL: ${raw}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`ui-debug only drives http(s) pages; refused ${parsed.protocol}//`);
  }
  if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
    throw new Error(`ui-debug only drives 127.0.0.1 or localhost; refused ${parsed.hostname}`);
  }
  return parsed;
}

export function parseArgs(argv) {
  const options = {
    cdpPort: null,
    url: DEFAULT_URL,
    chrome: process.env.GOALPORT_PREVIEW_CHROME || "",
    selftest: false,
    help: false,
    requestTimeoutMs: 30_000,
    readyTimeoutMs: 20_000
  };
  const value = (flag, index) => {
    const next = argv[index + 1];
    if (next === undefined) throw new Error(`${flag} needs a value`);
    return next;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--cdp-port") { options.cdpPort = Number(value(arg, index)); index += 1; }
    else if (arg === "--url") { options.url = value(arg, index); index += 1; }
    else if (arg === "--chrome") { options.chrome = value(arg, index); index += 1; }
    else if (arg === "--selftest") options.selftest = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown ui-debug option: ${arg}`);
  }
  if (options.cdpPort !== null && (!Number.isInteger(options.cdpPort) || options.cdpPort <= 0 || options.cdpPort > 65535)) {
    throw new Error("--cdp-port must be a TCP port number");
  }
  parseLocalUrl(options.url);
  return options;
}

const USAGE = `ui-debug — drive the real connected GoalPort UI over CDP (localhost only)

Usage:
  node scripts/connected/ui-debug.mjs [--url http://127.0.0.1:4186/]
  node scripts/connected/ui-debug.mjs --cdp-port 9222
  node scripts/connected/ui-debug.mjs --selftest

Options:
  --url <url>        page to open in an isolated headless Chromium (default ${DEFAULT_URL})
  --cdp-port <port>  attach to a Chromium/Electron GoalPort page already exposing CDP
  --chrome <path>    Chromium executable; defaults to GOALPORT_PREVIEW_CHROME or the Playwright cache
  --selftest         verify the JSON-line protocol wiring with a fake page (no network)
  --help             this text

stdin/stdout protocol (one JSON request per line, one JSON response per line):
  {"method":"preview_snapshot"}
  {"method":"click","selector":".composer textarea"}
  {"method":"evaluate","expression":"location.href"}
  {"method":"screenshot","path":"/tmp/goalport.png"}
  {"method":"quit"}`;

function discoverChrome(explicit) {
  if (explicit) return existsSync(explicit) ? explicit : "";
  const root = resolve(homedir(), ".cache/ms-playwright");
  if (!existsSync(root)) return "";
  for (const name of readdirSync(root).filter((entry) => entry.startsWith("chromium-")).sort().reverse()) {
    const path = resolve(root, name, "chrome-linux64/chrome");
    if (existsSync(path)) return path;
  }
  return "";
}

export function createDebugSession(page, { mode = "connected-app", clickAttempts = 50, clickRetryDelayMs = 30 } = {}) {
  const evaluate = async (expression) => {
    if (typeof expression !== "string" || expression === "") throw new Error("evaluate needs an expression");
    return await page.evaluate(expression, true);
  };
  const previewSnapshot = async () => deriveSnapshotFromBody(await page.evaluate(snapshotExpression, true), { mode });
  const click = async (selector) => {
    if (typeof selector !== "string" || selector.trim() === "") throw new Error("click needs a selector");
    let probe = null;
    for (let attempt = 0; attempt < clickAttempts && !probe; attempt += 1) {
      probe = await page.evaluate(clickProbeExpression(selector), true);
      if (!probe) await sleep(clickRetryDelayMs);
    }
    const point = probe && probe.present !== false
      ? hitTest({ element: probe.rect, viewport: probe.viewport }, { covered: probe.covered })
      : null;
    if (!point) throw new Error(`Control missing, blocked or outside viewport: ${selector}`);
    await page.cdp("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, x: point.x, y: point.y });
    await page.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, x: point.x, y: point.y });
    return { selector, x: point.x, y: point.y };
  };
  const screenshot = async (path) => {
    if (typeof path !== "string" || path.trim() === "") throw new Error("screenshot needs a path");
    const image = await page.cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    if (!image || typeof image.data !== "string") throw new Error("screenshot capture returned no image");
    const target = resolve(path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(image.data, "base64"));
    return target;
  };
  return { previewSnapshot, click, evaluate, screenshot };
}

export async function dispatch(session, request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("ui-debug request must be a JSON object");
  }
  switch (request.method) {
    case "preview_snapshot": return { ok: true, result: await session.previewSnapshot() };
    case "click": return { ok: true, result: await session.click(request.selector) };
    case "evaluate": return { ok: true, result: (await session.evaluate(request.expression)) ?? null };
    case "screenshot": return { ok: true, result: await session.screenshot(request.path) };
    case "quit": return { ok: true, result: "closing", quit: true };
    default: throw new Error(`Unknown ui-debug method: ${JSON.stringify(request.method ?? null)}`);
  }
}

export async function runProtocol(session, { input = process.stdin, output = process.stdout, ready = null, onStop = null } = {}) {
  const write = (value) => output.write(`${JSON.stringify(value)}\n`);
  if (ready) write(ready);
  const lines = readline.createInterface({ input });
  try {
    for await (const line of lines) {
      const text = line.trim();
      if (!text) continue;
      let response;
      try {
        response = await dispatch(session, JSON.parse(text));
      } catch (error) {
        response = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      write(response);
      if (response.quit) break;
    }
  } finally {
    lines.close();
    try { input.pause(); } catch {}
    if (onStop) onStop();
  }
}

async function waitUntilShell(evaluate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate("Boolean(document.querySelector('.goalport-shell, .boot-shell'))")) return true;
    await sleep(100);
  }
  return false;
}

// Attach by CDP port, or launch an isolated headless Chromium at a loopback URL.
export async function startUiDebug({ cdpPort = null, url = DEFAULT_URL, chrome = process.env.GOALPORT_PREVIEW_CHROME || "", requestTimeoutMs = 30_000, readyTimeoutMs = 20_000 } = {}) {
  if (cdpPort) {
    const page = await attachGoalPort(cdpPort, { requestTimeoutMs });
    await page.cdp("Page.enable");
    await page.cdp("Runtime.enable");
    const pageReady = await waitUntilShell((expression) => page.evaluate(expression, true), readyTimeoutMs);
    let href = "";
    try { href = await page.evaluate("location.href", true); } catch {}
    let stopped = false;
    return {
      page, url: href, attached: true, pageReady,
      stop: async () => { if (stopped) return; stopped = true; try { page.close(); } catch {} },
      ...createDebugSession(page)
    };
  }
  const target = parseLocalUrl(url);
  const executable = discoverChrome(chrome);
  if (!executable) throw new Error("Headless Chromium unavailable; pass --chrome or set GOALPORT_PREVIEW_CHROME (the Playwright cache is searched automatically)");
  const profile = mkdtempSync(resolve(tmpdir(), "goalport-ui-debug-"));
  const child = spawn(executable, ["--headless=new", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", target.href], { stdio: "ignore", detached: true });
  let page = null;
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    try { page?.close(); } catch {}
    const exited = child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve(true) : new Promise((done) => child.once("exit", () => done(true)));
    try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill(); }
    if (await Promise.race([exited, sleep(2000).then(() => false)]) === false) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      await Promise.race([exited, sleep(1000)]);
    }
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
  try {
    const deadline = Date.now() + 15_000;
    let port;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Headless Chromium exited ${child.exitCode}`);
      const portFile = resolve(profile, "DevToolsActivePort");
      if (existsSync(portFile)) { port = Number(readFileSync(portFile, "utf8").split("\n")[0]); break; }
      await sleep(100);
    }
    if (!port) throw new Error("Headless Chromium did not expose CDP");
    page = await attachGoalPort(port, { requestTimeoutMs });
    await page.cdp("Page.enable");
    await page.cdp("Runtime.enable");
    const pageReady = await waitUntilShell((expression) => page.evaluate(expression, true), readyTimeoutMs);
    if (!pageReady) throw new Error(`GoalPort page did not mount at ${target.href}; is the workbench serving a current dist?`);
    return { page, url: target.href, attached: false, pageReady: true, stop, ...createDebugSession(page) };
  } catch (error) {
    await stop();
    throw error;
  }
}

// A page double for wiring tests: answers the two gather expressions plus exact
// evaluate strings from a table, and records every CDP command. No network.
export class FakePage {
  constructor({ snapshot = null, controls = {}, evaluateResults = {}, screenshotPng = "png" } = {}) {
    this.snapshot = snapshot ?? {
      width: 1024, height: 768, title: "GoalPort",
      shell: { connection: "connected", campaignId: "campaign-selftest" },
      heading: "Start a goal",
      runtimeLabel: "Codex",
      composer: { present: true, characters: 0, disabled: false, placeholder: "Describe the work", sendDisabled: true, stopPresent: false, reason: "Enter to send" },
      pendingDecisions: [],
      activeElement: null,
      body: "selftest body"
    };
    this.controls = {
      ".composer button[type=\"submit\"]": { present: true, rect: { x: 100, y: 100, width: 100, height: 30 }, viewport: { width: 1024, height: 768 }, covered: true },
      ...controls
    };
    this.evaluateResults = { "selftest-expression": "selftest-value", ...evaluateResults };
    this.screenshotPng = screenshotPng;
    this.cdpCalls = [];
  }

  evaluate(expression, awaitPromise) {
    if (expression === snapshotExpression) return structuredClone(this.snapshot);
    if (typeof expression === "string" && expression.startsWith(CLICK_PROBE_PREFIX)) {
      const match = expression.match(/document\.querySelector\(("(?:[^"\\]|\\.)*")\)/);
      const selector = match ? JSON.parse(match[1]) : null;
      const control = selector !== null && Object.prototype.hasOwnProperty.call(this.controls, selector) ? this.controls[selector] : null;
      return control ? structuredClone(control) : null;
    }
    if (Object.prototype.hasOwnProperty.call(this.evaluateResults, expression)) return this.evaluateResults[expression];
    throw new Error(`FakePage: unexpected expression ${JSON.stringify(String(expression).slice(0, 60))} (awaitPromise=${awaitPromise})`);
  }

  cdp(method, params) {
    this.cdpCalls.push({ method, params });
    if (method === "Page.captureScreenshot") return { data: Buffer.from(this.screenshotPng).toString("base64") };
    return {};
  }
}

// --selftest: exercise the protocol wiring end to end with the fake page.
export async function runSelfTest({ log = (line) => console.log(line) } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const responses = [];
  output.on("data", (chunk) => {
    for (const line of String(chunk).split("\n")) if (line) responses.push(JSON.parse(line));
  });
  const page = new FakePage({
    controls: { ".covered-control": { present: true, rect: { x: 0, y: 0, width: 200, height: 40 }, viewport: { width: 1024, height: 768 }, covered: false } }
  });
  let stopped = false;
  const session = createDebugSession(page, { clickAttempts: 2, clickRetryDelayMs: 1 });
  const protocol = runProtocol(session, {
    input, output,
    ready: { ready: true, mode: "connected-app", methods: METHODS },
    onStop: () => { stopped = true; }
  });
  const send = (request) => new Promise((done) => setImmediate(() => { input.write(`${typeof request === "string" ? request : JSON.stringify(request)}\n`); done(); }));
  const settle = () => new Promise((done) => setTimeout(done, 10));
  const last = () => responses[responses.length - 1];
  const passed = [];
  const check = (name, condition) => {
    if (!condition) throw new Error(`selftest failed: ${name}`);
    passed.push(name);
  };

  await settle();
  check("ready line", responses.shift()?.ready === true);

  await send({ method: "preview_snapshot" });
  await settle();
  const snapshot = last();
  check("preview_snapshot shape", snapshot?.ok === true && snapshot.result?.mode === "connected-app"
    && snapshot.result?.connection === "connected" && snapshot.result?.campaignId === "campaign-selftest"
    && snapshot.result?.composer?.sendDisabled === true && Array.isArray(snapshot.result?.pendingDecisions));

  await send({ method: "click", selector: ".composer button[type=\"submit\"]" });
  await settle();
  const click = last();
  const pressed = page.cdpCalls.find((call) => call.method === "Input.dispatchMouseEvent" && call.params.type === "mousePressed");
  const released = page.cdpCalls.find((call) => call.method === "Input.dispatchMouseEvent" && call.params.type === "mouseReleased");
  check("click ok", click?.ok === true && click.result?.x === 150 && click.result?.y === 115);
  check("click dispatches real mouse events at the hit point", Boolean(pressed && released)
    && pressed.params.x === 150 && pressed.params.y === 115
    && released.params.x === pressed.params.x && released.params.y === pressed.params.y
    && pressed.params.button === "left" && pressed.params.clickCount === 1);

  await send({ method: "click", selector: ".missing-control" });
  await settle();
  check("missing control refused", last()?.ok === false && /Control missing, blocked or outside viewport: \.missing-control$/.test(last().error));

  const dispatchCount = page.cdpCalls.length;
  await send({ method: "click", selector: ".covered-control" });
  await settle();
  check("covered control refused without dispatch", last()?.ok === false && /Control missing, blocked or outside viewport: \.covered-control$/.test(last().error)
    && page.cdpCalls.length === dispatchCount);

  await send({ method: "evaluate", expression: "selftest-expression" });
  await settle();
  check("evaluate passthrough", last()?.ok === true && last().result === "selftest-value");

  const shotPath = resolve(tmpdir(), `goalport-ui-debug-selftest-${process.pid}.png`);
  await send({ method: "screenshot", path: shotPath });
  await settle();
  check("screenshot written", last()?.ok === true && last().result === shotPath
    && existsSync(shotPath) && readFileSync(shotPath).toString() === page.screenshotPng);
  rmSync(shotPath, { force: true });

  await send({ method: "detonate" });
  await settle();
  check("unknown method refused", last()?.ok === false && /Unknown ui-debug method/.test(last().error));

  await send("{ not json");
  await settle();
  check("malformed line refused", last()?.ok === false);

  await send({ method: "quit" });
  await protocol;
  check("quit answered, stopped and loop ended", last()?.ok === true && last().result === "closing" && stopped);

  await send({ method: "evaluate", expression: "selftest-expression" });
  await settle();
  check("no processing after quit", last().result === "closing");

  for (const name of passed) log(`selftest ok: ${name}`);
  return passed.length;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  if (options.selftest) {
    const count = await runSelfTest();
    console.log(`ui-debug selftest passed (${count} checks)`);
    return 0;
  }
  const session = await startUiDebug(options);
  try {
    await runProtocol(session, {
      input: process.stdin,
      output: process.stdout,
      ready: { ready: true, mode: "connected-app", url: session.url, attached: session.attached, pageReady: session.pageReady, methods: METHODS },
      onStop: session.stop
    });
  } finally {
    await session.stop();
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then((code) => process.exit(code), (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
