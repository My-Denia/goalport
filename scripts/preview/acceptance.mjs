import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { startPreview } from "./harness.mjs";

const flag = process.argv.indexOf("--out");
if (flag < 0 || !process.argv[flag + 1]) throw new Error("Usage: node scripts/preview/acceptance.mjs --out <evidence-directory>");
const out = resolve(process.argv[flag + 1]);
mkdirSync(out, { recursive: true });
const preview = await startPreview();
const report = { kind: "synthetic-browser-preview", widths: [], checks: [] };
const record = (name, result) => { report.checks.push({ name, ...result }); };

try {
  for (const width of [560, 1024, 1440]) {
    await preview.viewport(width);
    await preview.navigate("empty");
    const layout = await preview.evaluate(`(() => {
      const selectors = ['#draft-workspace', '.draft-runtime-picker .runtime-picker-button', '#draft-message', '.draft-composer-form button[type="submit"]'];
      return { width: innerWidth, navCollapsed: document.querySelector('.workspace-grid')?.classList.contains('nav-collapsed'),
        fields: selectors.map(selector => { const e=document.querySelector(selector); const r=e?.getBoundingClientRect();
          if (!e || !r) return {selector,missing:true};
          const top=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
          return {selector,x:r.x,y:r.y,width:r.width,height:r.height,disabled:e.disabled,unoccluded:top===e || e.contains(top),inViewport:r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight};
        }) };
    })()`);
    assert.equal(layout.width, width);
    assert.equal(layout.fields.length, 4);
    for (const field of layout.fields) {
      assert.equal(field.missing, undefined, `Missing ${field.selector} at ${width}px`);
      assert.ok(field.inViewport && field.unoccluded, `${field.selector} clipped or occluded at ${width}px: ${JSON.stringify(field)}`);
    }
    if (width <= 860) assert.equal(layout.navCollapsed, true, "Narrow first-use navigation must start closed");
    await preview.screenshot(resolve(out, `first-use-${width}.png`));
    record(`first-use-${width}`, layout);

    await preview.click('.draft-runtime-picker .runtime-picker-button');
    await preview.until("Boolean(document.querySelector('.runtime-picker-list .runtime-picker-item'))");
    await preview.screenshot(resolve(out, `picker-${width}.png`));
    await preview.key("ArrowDown", "ArrowDown");
    await preview.until("document.activeElement?.getAttribute('role') === 'option'");
    await preview.key("Home", "Home");
    await preview.key("ArrowDown", "ArrowDown");
    assert.equal(await preview.evaluate("document.activeElement?.querySelector('strong')?.textContent"), "Codex");
    await preview.key("End", "End");
    assert.equal(await preview.evaluate("document.activeElement?.querySelector('strong')?.textContent"), "Grok");
    await preview.key("Home", "Home");
    assert.equal(await preview.evaluate("document.activeElement?.querySelector('strong')?.textContent"), "Claude Code");
    await preview.key("Escape", "Escape");
    await preview.until("!document.querySelector('.runtime-picker-list:not([data-closed])')");
    await preview.until("document.activeElement?.getAttribute('aria-label') === 'Select Runtime'");
    await preview.click('.draft-runtime-picker .runtime-picker-button');
    await preview.until("Boolean(document.querySelector('.runtime-picker-list .runtime-picker-item'))");
    await preview.click('.runtime-picker-list .runtime-picker-item:nth-of-type(2)');
    await preview.fill('#draft-message', `Fix the sample bug at ${width}px`);
    const draftReady = await preview.evaluate("!document.querySelector('.draft-composer-form button[type=submit]').disabled");
    assert.equal(draftReady, true);
    await preview.click('.draft-composer-form button[type="submit"]');
    await preview.until("Boolean(document.querySelector('[data-kind=\"user-message\"]'))");
    await preview.screenshot(resolve(out, `sent-${width}.png`));
    record(`send-${width}`, await preview.snapshot());

    await preview.navigate("demo");
    await preview.until("Boolean(document.querySelector('.decision-request'))");
    await preview.screenshot(resolve(out, `permission-${width}.png`));
    await preview.click('.composer-dock .runtime-picker-button');
    await preview.key("ArrowDown", "ArrowDown");
    await preview.until("document.activeElement?.getAttribute('role') === 'option'");
    await preview.key("End", "End");
    await preview.key("Enter", "Enter");
    await preview.until("document.querySelector('.composer-dock .runtime-picker-button strong')?.textContent === 'Grok'");
    record(`keyboard-picker-${width}`, { draftArrowsHomeEndAndEscape: true, conversationKeyboardSelection: true });
    const decision = await preview.evaluate("(() => {const e=document.querySelector('.decision-request'); const r=e.getBoundingClientRect(); return {visible:r.width>0 && r.height>0,allow:!!e.querySelector('.decision-actions button')};})()");
    assert.ok(decision.visible && decision.allow);
    const selectGoal = async (index, id) => {
      if (width <= 860) await preview.click('.titlebar button[aria-label="Expand navigation"]');
      await preview.click(`.campaign-item-wrap:nth-child(${index}) .campaign-item`);
      await preview.until(`document.querySelector('.goalport-shell')?.dataset.campaignId === ${JSON.stringify(id)}`);
      if (width <= 860) await preview.until("document.querySelector('.campaign-nav')?.getBoundingClientRect().right <= 0");
    };
    await preview.fill('.composer textarea', 'draft A survives a refresh');
    await selectGoal(2, 'campaign-evidence-loop');
    await preview.fill('.composer textarea', 'draft B survives a refresh');
    await preview.key('Home', 'Home');
    await new Promise((done) => setTimeout(done, 850));
    const afterPoll = await preview.evaluate(`(() => { const e=document.querySelector('.composer textarea'); return {value:e.value,caret:e.selectionStart,focused:document.activeElement===e}; })()`);
    assert.deepEqual(afterPoll, { value: 'draft B survives a refresh', caret: 0, focused: true });
    await selectGoal(1, 'campaign-durable-preview');
    assert.equal(await preview.evaluate("document.querySelector('.composer textarea').value"), 'draft A survives a refresh');
    await selectGoal(2, 'campaign-evidence-loop');
    assert.equal(await preview.evaluate("document.querySelector('.composer textarea').value"), 'draft B survives a refresh');
    await preview.screenshot(resolve(out, `drafts-${width}.png`));
    record(`draft-poll-${width}`, afterPoll);
    await selectGoal(1, 'campaign-durable-preview');
    await preview.until("Boolean(document.querySelector('.decision-request'))");
    await preview.click('.decision-actions button:first-child');
    await preview.until("!document.querySelector('.decision-request')");
    await preview.click('.app-menu button[aria-label="Application menu"]');
    await preview.click('.app-menu-pop button[aria-label="Close window"]');
    await preview.until("Boolean(document.querySelector('[role=dialog][aria-label=\"Continue running in the background?\"]'))");
    await preview.screenshot(resolve(out, `close-${width}.png`));
    await preview.click('.close-choice-dialog .dialog-actions button:first-child');
    await preview.until("!document.querySelector('.close-choice-dialog')");
    record(`permission-close-${width}`, { decision, dismissedWithoutStopping: true });
    await preview.navigate("completed");
    await preview.click('.titlebar button[aria-label="Open details panel"]');
    await preview.until("Boolean(document.querySelector('#last-result-title'))");
    assert.match(await preview.evaluate("document.querySelector('.result-excerpt').textContent"), /Synthetic example: corrected addition/);
    await preview.screenshot(resolve(out, `result-${width}.png`));
    record(`last-result-${width}`, { suppliedExcerptVisible: true });
    await preview.navigate("quota");
    await preview.until("Boolean(document.querySelector('[data-kind=\"actionable-error\"]'))");
    assert.equal(await preview.evaluate("document.querySelector('[data-kind=\"actionable-error\"] details').open"), false);
    await preview.screenshot(resolve(out, `quota-${width}.png`));
    record(`quota-${width}`, { reasonAndActionVisible: true, technicalDetailsCollapsed: true });
    await preview.navigate("recovery");
    assert.match(await preview.evaluate("document.querySelector('.composer-hint').textContent"), /Resume this session to continue/);
    await preview.click('.titlebar button[aria-label="Open details panel"]');
    await preview.until("Array.from(document.querySelectorAll('.session-details-actions button')).some(e => e.textContent === 'Resume session')");
    await preview.screenshot(resolve(out, `recovery-${width}.png`));
    record(`recovery-${width}`, { explicitResumeActionVisible: true });
    await preview.navigate("starting");
    await preview.until("Boolean(document.querySelector('.composer-stop'))");
    assert.match(await preview.evaluate("document.querySelector('.composer-dock .runtime-picker-button').textContent"), /starting/);
    assert.equal(await preview.evaluate("document.body.innerText.includes('Conversation view unavailable')"), false);
    await preview.screenshot(resolve(out, `starting-${width}.png`));
    await preview.click('.titlebar button[aria-label="Open details panel"]');
    await preview.until("Array.from(document.querySelectorAll('.detail-facts > div')).some(e => e.querySelector('span')?.textContent === 'Runtime session' && e.querySelector('strong')?.textContent === 'Starting')");
    await preview.screenshot(resolve(out, `starting-details-${width}.png`));
    record(`starting-${width}`, { startupVisible: true, cancellationVisible: true, sessionStartingVisible: true });
    report.widths.push(width);
  }
  writeFileSync(resolve(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, widths: report.widths, screenshots: report.widths.length * 11, out }));
} catch (error) {
  writeFileSync(resolve(out, "report.json"), `${JSON.stringify({ ...report, error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`);
  throw error;
} finally {
  await preview.stop();
}
