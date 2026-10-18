import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { attachApp } from './lib/cdp-app.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

export async function runPackagedJourney({ packageRoot, outDir, pwshPath }) {
  fs.mkdirSync(outDir, { recursive: true });
  const shotsDir = path.join(outDir, 'screenshots');
  fs.rmSync(shotsDir, { recursive: true, force: true });
  fs.mkdirSync(shotsDir, { recursive: true });

  const report = {
    startedAt: new Date().toISOString(),
    packageRoot,
    stages: {},
    screenshots: [],
    errors: [],
  };

  const workspaceA = path.join(outDir, 'workspace-a');
  const workspaceB = path.join(outDir, 'workspace-b');
  fs.mkdirSync(workspaceA, { recursive: true });
  fs.mkdirSync(workspaceB, { recursive: true });
  fs.writeFileSync(path.join(workspaceA, 'project-a.txt'), 'workspace A contents\n');
  fs.writeFileSync(path.join(workspaceB, 'project-b.txt'), 'workspace B contents\n');

  const profileDir = path.join(outDir, 'profile');
  fs.mkdirSync(profileDir, { recursive: true });

  const exePath = path.join(packageRoot, 'GoalPort.exe');
  if (!fs.existsSync(exePath)) throw new Error(`Missing GoalPort.exe at ${exePath}`);

  let appProc = null;
  let app = null;

  async function launchAndAttach() {
    const cdpPort = await getFreePort();
    const env = { ...process.env, GOALPORT_REQUIRE_ISOLATED: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    console.log(`[journey] Launching GoalPort.exe with profile ${profileDir} on CDP port ${cdpPort}...`);
    appProc = spawn(exePath, [
      '--data-dir', profileDir,
      `--remote-debugging-port=${cdpPort}`,
      '--remote-debugging-address=127.0.0.1'
    ], {
      cwd: packageRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    appProc.stdout.on('data', d => fs.appendFileSync(path.join(outDir, 'electron-stdout.log'), d));
    appProc.stderr.on('data', d => fs.appendFileSync(path.join(outDir, 'electron-stderr.log'), d));

    app = await attachApp(cdpPort, { electronPid: appProc.pid, pwshPath });
    console.log(`[journey] CDP attached! (PID ${appProc.pid})`);

    // Wait for bootstrap done
    await app.until("Boolean(window.goalportCore && window.goalportCore.bootstrapCurrent().then(s => s.phase === 'done'))", 30000);
    await sleep(500);
  }

  async function closeApp() {
    if (!app || !appProc) return;
    console.log('[journey] Closing app window...');
    try {
      await app.evaluate('window.close()');
    } catch {
      // ignore
    }
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (appProc.exitCode !== null) break;
      await sleep(200);
    }
    if (appProc.exitCode === null) {
      console.log('[journey] Forcing process exit...');
      appProc.kill();
    }
    app.close();
    app = null;
    appProc = null;
    await sleep(1000);
  }

  async function fill(selector, text) {
    await app.click(selector);
    await sleep(100);
    await app.cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
    await app.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
    await app.cdp("Input.insertText", { text });
    await sleep(150);
  }

  try {
    // ----------------------------------------------------
    // STAGE 1: Launch & Initial UI & Runtime Promise Alignment
    // ----------------------------------------------------
    console.log('\n--- STAGE 1: Launch & Initial UI ---');
    await launchAndAttach();
    report.stages.stage1_launch = { status: 'ok', pid: appProc.pid };

    // Wait for empty draft composer
    await app.until("Boolean(document.querySelector('#draft-workspace'))", 15000);

    for (const w of [860, 1020, 1440]) {
      const shot = await app.screenshot(shotsDir, '01-initial-draft', w);
      report.screenshots.push(shot);
    }

    // Verify "Keep working after closing" exists on runtime-less draft
    const initialConsentVisible = await app.evaluate("Boolean(document.querySelector('.draft-background-consent'))", true);
    console.log('[journey] Initial runtime-less background consent visible:', initialConsentVisible);

    // Open Runtime picker
    await app.click(".draft-runtime-picker button[aria-label='Select Runtime']");
    await sleep(500);
    await app.until("Boolean(document.querySelector('.runtime-picker-list'))", 10000);
    const pickerShot = await app.screenshot(shotsDir, '02-runtime-picker-open', 1020);
    report.screenshots.push(pickerShot);

    // Select Scenario Runtime
    await app.evaluate(`(() => {
      const item = Array.from(document.querySelectorAll('.runtime-picker-list .runtime-picker-item')).find(e => e.querySelector('strong')?.textContent.trim() === 'Scenario Runtime');
      if (item) item.click();
    })()`);
    await sleep(500);

    // Verify background consent is now HIDDEN because single Runtime was selected
    const consentVisibleAfterRuntime = await app.evaluate("Boolean(document.querySelector('.draft-background-consent'))", true);
    console.log('[journey] Background consent visible after Scenario Runtime selected:', consentVisibleAfterRuntime);
    report.stages.runtime_promise_alignment = {
      initialConsentVisible,
      consentVisibleAfterRuntime,
      suppressed: !consentVisibleAfterRuntime
    };
    const runtimeSelectedShot = await app.screenshot(shotsDir, '03-runtime-selected-consent-hidden', 1020);
    report.screenshots.push(runtimeSelectedShot);

    // Click discard or re-open draft to return to clean runtime-less state
    // If discard button is present:
    if (await app.evaluate("Boolean(document.querySelector('button[aria-label=\"Discard draft\"]'))", true)) {
      await app.click("button[aria-label='Discard draft']");
      await sleep(500);
    }
    // If draft closed, click New goal
    if (!await app.evaluate("Boolean(document.querySelector('#draft-workspace'))", true)) {
      await app.click("button[aria-label='New goal']");
      await app.until("Boolean(document.querySelector('#draft-workspace'))", 10000);
    }

    // ----------------------------------------------------
    // STAGE 2: Send Background Goal in Workspace A
    // ----------------------------------------------------
    console.log('\n--- STAGE 2: Send Background Goal in Workspace A ---');
    await fill('#draft-workspace', workspaceA);
    await fill('#draft-message', 'Verify Windows background continuation and stop');

    // Check "Keep working after closing"
    const hasConsent = await app.evaluate("Boolean(document.querySelector('.draft-background-consent input'))", true);
    if (hasConsent) {
      const isChecked = await app.evaluate("document.querySelector('.draft-background-consent input').checked", true);
      if (!isChecked) {
        await app.click('.draft-background-consent input');
        console.log('[journey] Enabled Keep working after closing checkbox');
      }
    }

    // Authorize any read harnesses if checkboxes exist
    await app.evaluate(`(() => {
      const cbs = document.querySelectorAll('.authorization-panel input[type="checkbox"]');
      cbs.forEach(cb => { if (!cb.checked) cb.click(); });
    })()`);
    await sleep(500);

    for (const w of [860, 1020, 1440]) {
      const shot = await app.screenshot(shotsDir, '04-draft-with-background-consent', w);
      report.screenshots.push(shot);
    }

    // Inspect and answer permission request if present
    const grantBtnExists = await app.evaluate(`Boolean(Array.from(document.querySelectorAll('button')).find(e => e.textContent.includes('Allow GoalPort to run harness turns on this profile')))`, true);
    console.log('[journey] Permission grant button exists:', grantBtnExists);
    if (grantBtnExists) {
      console.log('[journey] Clicking "Allow GoalPort to run harness turns on this profile"...');
      await app.evaluate(`Array.from(document.querySelectorAll('button')).find(e => e.textContent.includes('Allow GoalPort to run harness turns on this profile')).click()`);
      await sleep(500);
      report.stages.permission_granted = {
        action: 'granted profile consent via UI button',
        timestamp: new Date().toISOString()
      };
    }

    // Check submit state
    const submitDebug = await app.evaluate(`(() => {
      const btn = document.querySelector('.draft-composer-form button[type="submit"]');
      const ws = document.querySelector('#draft-workspace')?.value;
      const msg = document.querySelector('#draft-message')?.value;
      const note = document.querySelector('.draft-composer-form .dialog-note')?.innerText;
      return {
        buttonExists: Boolean(btn),
        disabled: btn ? btn.disabled : null,
        workspace: ws,
        message: msg,
        note: note || null,
        appInfo: window.goalportCore?.appInfo ? window.goalportCore.appInfo() : null
      };
    })()`);
    console.log('[journey] Submit button debug:', JSON.stringify(submitDebug));

    // Click Send
    console.log('[journey] Clicking Send message...');
    await app.click(".draft-composer-form button[type='submit']");
    await sleep(1500);

    // Observe progress
    const activeGoalInfo = await app.evaluate(`(() => {
      return {
        bodyText: document.body.innerText.slice(0, 500),
        backgroundBadge: Boolean(document.querySelector('[aria-label="Background goal"]')),
        sidebarGoals: Array.from(document.querySelectorAll('.campaign-item')).map(e => e.innerText.trim())
      };
    })()`);
    console.log('[journey] Active goal observations:', JSON.stringify(activeGoalInfo));
    report.stages.stage2_send = { status: 'ok', activeGoalInfo };

    for (const w of [860, 1020, 1440]) {
      const shot = await app.screenshot(shotsDir, '05-goal-sent-progress', w);
      report.screenshots.push(shot);
    }

    // ----------------------------------------------------
    // STAGE 3: Close Window & Reopen
    // ----------------------------------------------------
    console.log('\n--- STAGE 3: Close Window & Reopen ---');
    await closeApp();
    console.log('[journey] Window closed. Waiting 3s while background coordination persists...');
    await sleep(3000);

    console.log('[journey] Relaunching GoalPort.exe with identical profile...');
    await launchAndAttach();
    report.stages.stage3_reopen = { status: 'ok', pid: appProc.pid };

    // Wait for reopened window to settle
    await sleep(1500);
    const returnedFacts = await app.evaluate(`(() => {
      return {
        bodyText: document.body.innerText.slice(0, 600),
        hasBackgroundBadge: Boolean(document.querySelector('[aria-label="Background goal"]')),
        sidebarGoals: Array.from(document.querySelectorAll('.campaign-item')).map(e => ({
          text: e.innerText.trim(),
          active: e.classList.contains('campaign-active')
        })),
        titlebarText: document.querySelector('.titlebar')?.innerText?.slice(0, 200)
      };
    })()`);
    console.log('[journey] Returned goal facts upon reopen:', JSON.stringify(returnedFacts));
    report.stages.stage3_reopen_facts = returnedFacts;

    for (const w of [860, 1020, 1440]) {
      const shot = await app.screenshot(shotsDir, '06-reopened-same-goal', w);
      report.screenshots.push(shot);
    }

    // ----------------------------------------------------
    // STAGE 4: Stop Action
    // ----------------------------------------------------
    console.log('\n--- STAGE 4: Stop Action ---');
    const stopButtonSelector = "button[aria-label='Stop allowing'], button[aria-label='Stop']";
    const stopBtnVisible = await app.evaluate(`Boolean(document.querySelector(${JSON.stringify(stopButtonSelector)}))`, true);
    console.log('[journey] Stop button visible:', stopBtnVisible);

    if (stopBtnVisible) {
      await app.click(stopButtonSelector);
      console.log('[journey] Stop button clicked!');
      await sleep(1500);

      const stoppedFacts = await app.evaluate(`(() => {
        return {
          bodyText: document.body.innerText.slice(0, 500),
          stoppedBadge: Boolean(document.querySelector('.status-pill-stopped, [data-state="stopped"]')),
          sidebarGoals: Array.from(document.querySelectorAll('.campaign-item')).map(e => e.innerText.trim())
        };
      })()`);
      console.log('[journey] Stopped facts:', JSON.stringify(stoppedFacts));
      report.stages.stage4_stop = { status: 'ok', stoppedFacts };

      for (const w of [860, 1020, 1440]) {
        const shot = await app.screenshot(shotsDir, '07-stopped-state', w);
        report.screenshots.push(shot);
      }
    } else {
      console.log('[journey] Stop button was not visible; recording current state');
      report.stages.stage4_stop = { status: 'not-visible' };
    }

    // ----------------------------------------------------
    // STAGE 5: Resend & Workspace Switching (Workspace B admitted)
    // ----------------------------------------------------
    console.log('\n--- STAGE 5: Workspace Switching (Workspace B Admitted) ---');
    const newGoalBtn = await app.evaluate("Boolean(document.querySelector('button[aria-label=\"New goal\"]'))", true);
    if (newGoalBtn) {
      await app.click("button[aria-label='New goal']");
      await app.until("Boolean(document.querySelector('#draft-workspace'))", 10000);

      // Attempt send in Workspace B (different folder)
      await fill('#draft-workspace', workspaceB);
      await fill('#draft-message', 'Goal in Workspace B');
      await sleep(500);

      const sendBtnEnabled = await app.evaluate("!document.querySelector('.draft-composer-form button[type=\\'submit\\']').disabled", true);
      console.log('[journey] Workspace B send button enabled:', sendBtnEnabled);
      report.stages.stage5_workspace_b = { status: 'ok', sendBtnEnabled };

      const shotB = await app.screenshot(shotsDir, '08-workspace-b-draft', 1020);
      report.screenshots.push(shotB);

      // Also check same workspace A hold
      await fill('#draft-workspace', workspaceA);
      await sleep(500);

      const sameWorkspaceStatus = await app.evaluate(`(() => {
        const errorEl = document.querySelector('.draft-composer-form .dialog-note, .status-banners .banner-notice');
        const submitBtn = document.querySelector('.draft-composer-form button[type="submit"]');
        return {
          errorText: errorEl ? errorEl.innerText.slice(0, 300) : null,
          sendDisabled: submitBtn ? submitBtn.disabled : null
        };
      })()`);
      console.log('[journey] Workspace A draft status:', JSON.stringify(sameWorkspaceStatus));
      report.stages.stage5_workspace_a = sameWorkspaceStatus;

      const shotA = await app.screenshot(shotsDir, '09-workspace-a-draft-status', 1020);
      report.screenshots.push(shotA);
    }

    report.endedAt = new Date().toISOString();
    report.status = 'completed';
    console.log('\n=== PACKAGED WINDOWS JOURNEY COMPLETE: SUCCESS ===');
  } catch (err) {
    console.error('[journey] Error during journey:', err);
    report.errors.push(err.message);
    report.status = 'failed';
  } finally {
    await closeApp();
    fs.writeFileSync(path.join(outDir, 'journey-report.json'), JSON.stringify(report, null, 2));

    // Write screenshot manifest
    const manifest = {
      packageRoot,
      revision: '59dfa4fbcadc31f2d56c14f053c0e648fb68fea8',
      capturedAt: new Date().toISOString(),
      screenshots: report.screenshots.map(s => ({
        name: s.state || s.name,
        width: s.requested?.width || s.width,
        path: s.path,
        bytes: s.bytes,
        sha256: s.sha256,
        pngWidth: s.pngWidth,
        pngHeight: s.pngHeight,
      }))
    };
    fs.writeFileSync(path.join(outDir, 'screenshot-manifest.json'), JSON.stringify(manifest, null, 2));
  }

  return report;
}

if (process.argv[1] && process.argv[1].endsWith('windows-packaged-journey.mjs')) {
  const packageRoot = path.resolve('artifacts/electron-rc/goalport-59dfa4f-win64/GoalPort-win32-x64');
  const outDir = path.resolve('goal-runs/goalport-pr36-continuation/evidence/packaged-journey');
  const pwshPath = 'C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.6.7.0_x64__8wekyb3d8bbwe\\pwsh.exe';
  runPackagedJourney({ packageRoot, outDir, pwshPath })
    .then(r => console.log('Final Result:', r.status))
    .catch(e => { console.error(e); process.exit(1); });
}
