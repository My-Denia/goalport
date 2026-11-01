import {mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {startPreview} from './harness.mjs';
import {build} from 'vite';
const dist=resolve('goal-runs/audit-model-choice-build'),out=resolve(process.argv[2] || 'goal-runs/audit-model-choice-evidence');
if(existsSync(out))throw Error('Choose a fresh evidence directory.');
await build({build:{outDir:dist,rollupOptions:{input:'scripts/preview/audit-model-choice.html'}}});
mkdirSync(out,{recursive:true});
writeFileSync(resolve(dist,'index.html'),'<title>GoalPort acceptance</title><div class="goalport-shell"></div>');
const p=await startPreview({dist});
const evidence=[];
try {
  for(const width of [820,1020,1440]) {
    await p.viewport(width,900);
    await p.page.cdp('Page.navigate',{url:new URL('/scripts/preview/audit-model-choice.html',p.url).href});
    await p.until("Boolean(document.querySelector('.native-workspace-check button'))");
    await p.click('.native-workspace-check button');
    await p.until("Boolean(document.querySelector('[role=combobox]'))");
    await p.until("document.body.innerText.includes('The default model is unavailable')");
    await p.screenshot(resolve(out,`missing-default-${width}.png`));
    await p.click('[role=combobox]');
    await p.until("Boolean(document.querySelector('[role=option]'))");
    await p.screenshot(resolve(out,`model-menu-${width}.png`));
    await p.click('[role=option]');
    await p.until(`Boolean(document.querySelector('[aria-label="Complete Pi payload"]'))`);
    const result=await p.evaluate(`({width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,sendEnabled:Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Send to Pi'&&!b.disabled),body:document.body.innerText})`);
    if(result.overflow||!result.sendEnabled)throw Error(JSON.stringify(result));
    evidence.push(result);
    await p.screenshot(resolve(out,`prepared-${width}.png`));
  }
  writeFileSync(resolve(out,'observations.json'),JSON.stringify({scope:'Built component with synthetic host; no Windows/runtime/send acceptance',evidence},null,2));
}finally{await p.stop();}
