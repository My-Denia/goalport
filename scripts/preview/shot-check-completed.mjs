import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { startPreview } from './harness.mjs';
import { build } from 'vite';

const dist = resolve('goal-runs/audit-check-completed-build');
const out = resolve(process.argv[2] || 'goal-runs/audit-check-completed-evidence');

if (existsSync(out)) {
  // Clear or reuse
} else {
  mkdirSync(out, { recursive: true });
}

function findBrowser() {
  if (process.env.GOALPORT_PREVIEW_CHROME && existsSync(process.env.GOALPORT_PREVIEW_CHROME)) {
    return process.env.GOALPORT_PREVIEW_CHROME;
  }
  for (const candidate of [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

const chrome = findBrowser();

await build({
  build: {
    outDir: dist,
    rollupOptions: { input: 'scripts/preview/audit-check-completed.html' },
  },
});

writeFileSync(resolve(dist, 'index.html'), '<title>GoalPort acceptance</title><div class="goalport-shell"></div>');
const p = await startPreview({ dist, chrome });
const evidence = [];

try {
  for (const width of [860, 1020, 1440]) {
    await p.viewport(width, 900);
    await p.page.cdp('Page.navigate', {
      url: new URL('/scripts/preview/audit-check-completed.html', p.url).href,
    });
    await p.until("Boolean(document.querySelector('.native-workspace-check'))");
    await p.until("Boolean(document.querySelector('.native-check-panel'))");
    await p.until("document.body.innerText.includes(\"Pi's review\")");

    const shotPath = resolve(out, `completed-review-${width}.png`);
    await p.screenshot(shotPath);

    const result = await p.evaluate(`({
      width: innerWidth,
      overflow: document.documentElement.scrollWidth > innerWidth,
      hasReview: Boolean(document.querySelector('.native-check-panel')),
      heading: document.querySelector('.native-check-panel h3')?.innerText,
      hasAskCodex: Boolean(document.querySelector('.native-check-actions button')),
      hasSavedEarlier: Boolean(document.querySelector('.native-workspace-check details summary')),
    })`);

    evidence.push({ width, shotPath, ...result });
    console.log(`Captured screenshot for width ${width}:`, result);
  }

  writeFileSync(
    resolve(out, 'observations.json'),
    JSON.stringify({ description: 'Multi-width visual acceptance for completed Pi review (F2 fix)', evidence }, null, 2)
  );
} finally {
  await p.stop();
}
