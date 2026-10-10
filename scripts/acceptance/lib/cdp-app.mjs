import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { attachGoalPort, createCdpClient, waitForWebSocketOpen } from '../../connected/v1-cdp.mjs';
import { sleep } from './launch.mjs';

export function nativeResize(electronPid, width, height, insets = { width: 0, height: 0 }) {
  if (!Number.isInteger(electronPid) || electronPid <= 1 || ![860,1020,1440].includes(width) || height !== 900 || ![insets.width,insets.height].every(n => Number.isInteger(n) && n >= 0 && n <= 32)) throw new Error('invalid owned native resize request');
  const command = ['/usr/bin/python3', '-B', fileURLToPath(new URL('./native-window.py', import.meta.url)), '--pid', String(electronPid), '--width', String(width), '--height', String(height), '--inset-width', String(insets.width), '--inset-height', String(insets.height)];
  const result = spawnSync(command[0], command.slice(1), { encoding: 'utf8', timeout: 5000, env: { PATH: '/usr/bin:/bin', DISPLAY: process.env.DISPLAY || '', PYTHONDONTWRITEBYTECODE: '1' } });
  if (result.status !== 0) throw new Error(`owned native resize failed (exit ${result.status}): ${result.stderr.trim() || result.error?.message || 'no diagnostic'}`);
  return { ...JSON.parse(result.stdout), command, exit: result.status };
}

export async function attachApp(port, { electronPid } = {}) {
  const page = await attachGoalPort(port, { requestTimeoutMs: 15000 });
  let browser;
  try {
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) })).json();
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await waitForWebSocketOpen(ws);
    browser = createCdpClient(ws, { requestTimeoutMs: 10000 });
    await page.cdp('Page.enable');
    return {
      ...page,
      async until(expression, timeout = 20000) {
        const deadline = Date.now() + timeout;
        let last;
        while (Date.now() < deadline) {
          try { if (await page.evaluate(expression, true)) return; } catch (error) { last = error.message; }
          await sleep(100);
        }
        throw new Error(`DOM/read-only condition timed out: ${expression}${last ? ` (${last})` : ''}`);
      },
      async click(selector) {
        const point = await page.evaluate(`(() => {
          const e = document.querySelector(${JSON.stringify(selector)});
          if (!e || e.disabled) throw Error('control absent or disabled');
          e.scrollIntoView({block:'center'});
          const r = e.getBoundingClientRect(), x = r.x+r.width/2, y = r.y+r.height/2;
          const top = document.elementFromPoint(x,y);
          if (!r.width || !r.height || !(top === e || e.contains(top))) throw Error('control not hit-testable');
          return {x,y};
        })()`);
        await page.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
        await page.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
        await sleep(100);
      },
      async input(selector, value) {
        await page.evaluate(`(() => {
          const e = document.querySelector(${JSON.stringify(selector)});
          if (!e || e.disabled) throw Error('input absent or disabled');
          const proto = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, ${JSON.stringify(value)});
          e.dispatchEvent(new Event('input', {bubbles:true}));
          e.dispatchEvent(new Event('change', {bubbles:true}));
        })()`);
        await sleep(100);
      },
      async resize(width, height = 900) {
        let bounds, primaryError, native;
        await page.cdp('Emulation.clearDeviceMetricsOverride');
        try {
          const { windowId } = await browser.cdp('Browser.getWindowForTarget', { targetId: page.page.id });
          await browser.cdp('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
          await browser.cdp('Browser.setWindowBounds', { windowId, bounds: { width, height } });
          await sleep(350);
          bounds = (await browser.cdp('Browser.getWindowBounds', { windowId })).bounds;
        } catch (error) {
          primaryError = error.message;
          bounds = await page.evaluate('({width:outerWidth,height:outerHeight,source:"renderer outer dimensions; Browser domain unavailable"})');
        }
        let viewport = await page.evaluate('({width:innerWidth,height:innerHeight,devicePixelRatio})');
        let method = 'Browser.setWindowBounds';
        if (primaryError || bounds.width !== width || viewport.width !== width) {
          if (process.platform !== 'linux' || !electronPid) throw new Error('native ownership required after Browser bounds refusal');
          const insets = await page.evaluate('({width:outerWidth-innerWidth,height:outerHeight-innerHeight})');
          native = nativeResize(electronPid, width, height, insets);
          method = native.method;
          const deadline = Date.now() + 5000;
          while (Date.now() < deadline) {
            viewport = await page.evaluate('({width:innerWidth,height:innerHeight,devicePixelRatio})');
            if (viewport.width === width && viewport.height === height) break;
            await sleep(100);
          }
          if (viewport.width !== width || viewport.height !== height) throw new Error(`native bounds did not reach requested viewport: ${JSON.stringify({native,viewport})}`);
          bounds = await page.evaluate('({width:outerWidth,height:outerHeight,source:"actual native window renderer outer dimensions"})');
        }
        await sleep(250);
        const layout = await page.evaluate(`({root:document.querySelector('#root').getBoundingClientRect().width, grid:document.querySelector('.workspace-grid').getBoundingClientRect().width, titlebar:document.querySelector('.titlebar-inner').getBoundingClientRect().width})`);
        if (Math.abs(layout.root-width) > 1 || layout.grid > width+1 || layout.titlebar > width+1) throw new Error(`native responsive layout clipped: ${JSON.stringify(layout)}`);
        return { requested: { width, height }, bounds, viewport, layout, method, native: native || null, primaryError: primaryError || null };
      },
      async screenshot(out, state, width) {
        const dimensions = await this.resize(width);
        // Close the actual drawer via its existing user control, never hide it.
        if (width === 860) {
          const selector = await page.evaluate(`(() => {
            const backdrop = document.querySelector('.mobile-nav-backdrop');
            if (backdrop && backdrop.getBoundingClientRect().width) return 'button[aria-label="Close navigation"]';
            const button = document.querySelector('button[aria-label="Collapse navigation"]');
            return button ? 'button[aria-label="Collapse navigation"]' : null;
          })()`);
          if (selector) await this.click(selector);
        }
        const geometry = await page.evaluate(`(() => {
          const rect = selector => { const e=document.querySelector(selector); if(!e) return null; const r=e.getBoundingClientRect(); const x=r.x+r.width/2,y=r.y+r.height/2,top=document.elementFromPoint(x,y); return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom,inside:r.x>=0&&r.right<=innerWidth&&r.y>=0&&r.bottom<=innerHeight,hit:top===e||e.contains(top)}; };
          return {horizontalOverflow:document.documentElement.scrollWidth>innerWidth,text:document.body.innerText,drawerOpen:innerWidth<=860&&!!document.querySelector('.workspace-grid:not(.nav-collapsed)'),send:rect('button[aria-label="Send message"]'),newGoal:rect('button[aria-label="New goal"]'),stop:rect('button[aria-label="Stop allowing"]')};
        })()`);
        const result = await page.cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        const png = Buffer.from(result.data, 'base64');
        const filename = path.join(out, `${state}-${width}.png`);
        fs.writeFileSync(filename, png, { flag: 'wx' });
        return { path: filename, state, ...dimensions, geometry, bytes: png.length, sha256: crypto.createHash('sha256').update(png).digest('hex'), pngWidth: png.readUInt32BE(16), pngHeight: png.readUInt32BE(20) };
      },
      close() { browser.close(); page.close(); },
    };
  } catch (error) { browser?.close(); page.close(); throw error; }
}
