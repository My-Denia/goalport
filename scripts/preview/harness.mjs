import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { extname, resolve, sep } from "node:path";
import { attachGoalPort } from "../connected/v1-cdp.mjs";

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
function cachedChrome() {
  const root = resolve(homedir(), ".cache/ms-playwright");
  if (!existsSync(root)) return "";
  for (const name of readdirSync(root).filter((entry) => entry.startsWith("chromium-")).sort().reverse()) {
    const path = resolve(root, name, "chrome-linux64/chrome");
    if (existsSync(path)) return path;
  }
  return "";
}

function staticServer(root) {
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
  return createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
    const path = resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!path.startsWith(`${root}${sep}`) || !existsSync(path)) { response.writeHead(404).end(); return; }
    response.writeHead(200, { "content-type": types[extname(path)] || "application/octet-stream", "cache-control": "no-store" });
    response.end(readFileSync(path));
  });
}

export async function startPreview({ dist = resolve("dist"), fixture = "empty", chrome = process.env.GOALPORT_PREVIEW_CHROME || cachedChrome() } = {}) {
  const root = resolve(dist);
  if (!existsSync(resolve(root, "index.html"))) throw new Error("Build GoalPort first: dist/index.html is missing");
  if (!chrome || !existsSync(chrome)) throw new Error("Headless Chromium unavailable; set GOALPORT_PREVIEW_CHROME or install a Playwright Chromium cache");
  const server = staticServer(root);
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const webPort = server.address().port;
  const profile = mkdtempSync(resolve(tmpdir(), "goalport-preview-"));
  const url = `http://127.0.0.1:${webPort}/?preview=${encodeURIComponent(fixture)}`;
  const child = spawn(chrome, ["--headless=new", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", url], { stdio: "ignore", detached: true });
  const killOwnedChrome = () => { try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill(); } };
  const cleanup = async (page) => {
    page?.close();
    const exited = child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve(true) : new Promise((done) => child.once("exit", () => done(true)));
    killOwnedChrome();
    if (await Promise.race([exited, sleep(2000).then(() => false)]) === false) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      await Promise.race([exited, sleep(1000)]);
    }
    server.closeAllConnections();
    await Promise.race([new Promise((done) => server.close(done)), sleep(1000)]);
    await sleep(100);
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
  try {
    const deadline = Date.now() + 15_000;
    let cdpPort;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Headless Chromium exited ${child.exitCode}`);
      const portFile = resolve(profile, "DevToolsActivePort");
      if (existsSync(portFile)) { cdpPort = Number(readFileSync(portFile, "utf8").split("\n")[0]); break; }
      await sleep(100);
    }
    if (!cdpPort) throw new Error("Headless Chromium did not expose CDP");
    const page = await attachGoalPort(cdpPort);
    await page.cdp("Page.enable");
    await page.cdp("Runtime.enable");
    const evaluate = (expression) => page.evaluate(expression, true);
    const until = async (expression, timeoutMs = 10_000) => {
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        if (await evaluate(expression)) return;
        await sleep(80);
      }
      throw new Error(`Preview condition timed out: ${expression}`);
    };
    const viewport = async (width, height = 900) => {
      await page.cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
      await sleep(90);
    };
    const click = async (selector) => {
      let point;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        point = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e || e.disabled) return null; e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); const x=r.x+r.width/2,y=r.y+r.height/2; const top=document.elementFromPoint(x,y); return r.width && r.height && x>=0 && x<innerWidth && y>=0 && y<innerHeight && (top===e || e.contains(top)) ? {x,y} : null; })()`);
        if (point) break;
        await sleep(30);
      }
      if (!point) throw new Error(`Control missing, blocked or outside viewport: ${selector}`);
      await page.cdp("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
      await page.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
    };
    const fill = async (selector, value) => {
      await click(selector);
      await page.cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
      await page.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
      await page.cdp("Input.insertText", { text: value });
    };
    const key = async (key, code = key) => {
      const windowsVirtualKeyCode = { End: 35, Home: 36, Escape: 27, Enter: 13, Tab: 9, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, " ": 32 }[key] || 0;
      await page.cdp("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode });
      await page.cdp("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode });
    };
    const snapshot = () => evaluate(`(() => {
      const composer = document.querySelector('#draft-message, .composer textarea');
      const send = document.querySelector('.draft-composer-form button[type="submit"], .composer button[type="submit"]');
      const stop = document.querySelector('.composer-stop');
      return {mode:'browser-preview',width:innerWidth,height:innerHeight,title:document.title,connection:'browser-preview',
        campaignId:document.querySelector('.goalport-shell')?.dataset.campaignId,
        heading:document.querySelector('.conversation-heading-main h2')?.textContent ?? null,
        runtimeLabel:document.querySelector('.runtime-picker-button strong')?.textContent,
        composer:composer ? {characters:composer.value.length,disabled:composer.disabled,placeholder:composer.placeholder,
          sendDisabled:send?.disabled ?? null,stopVisible:Boolean(stop),reason:document.querySelector('.composer-hint')?.textContent} : null,
        pendingDecisions:Array.from(document.querySelectorAll('.decision-request')).map(e=>e.textContent.trim()),
        activeElement:document.activeElement?.outerHTML?.slice(0,250),body:document.body.innerText.slice(0,8000)};
    })()`);
    const screenshot = async (path) => {
      const image = await page.cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      mkdirSync(resolve(path, ".."), { recursive: true });
      writeFileSync(path, Buffer.from(image.data, "base64"));
      return path;
    };
    const navigate = async (nextFixture = fixture) => {
      await page.cdp("Page.navigate", { url: `http://127.0.0.1:${webPort}/?preview=${encodeURIComponent(nextFixture)}` });
      await until("Boolean(document.querySelector('.goalport-shell'))");
    };
    await until("Boolean(document.querySelector('.goalport-shell'))");
    return { page, evaluate, until, viewport, click, fill, key, snapshot, screenshot, navigate, url,
      stop: () => cleanup(page) };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
