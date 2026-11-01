import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('retired proof entrypoints reject before executing or writing a PASS report', () => {
  const dir = mkdtempSync(join(tmpdir(), 'goalport-retired-'));
  try {
    for (const [script, args] of [
      ...['m0','m1','m2','m3','m4','m5','scenario','baseline-m1'].map(command => ['scripts/verify.mjs', [command]]),
      ['scripts/connected/verify-acceptance.mjs', []],
      ['scripts/connected/verify-docs.mjs', []],
      ['scripts/connected/v1-sec-01-exclusion.mjs', []],
    ]) {
      const output = join(dir, 'report.json');
      const result = spawnSync(process.execPath, [resolve(script), ...args, '--report', output], {cwd:dir,encoding:'utf8',timeout:5000});
      assert.equal(result.status, 2, `${script} ${args}: ${result.stderr}`);
      assert.match(result.stderr, /retired/i);
      assert.doesNotMatch(result.stdout, /PASS/);
      assert.equal(existsSync(output), false);
    }
  } finally { rmSync(dir, {recursive:true,force:true}); }
});
