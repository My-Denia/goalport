import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { discoverNodeTests } from './run-node-tests.mjs';

test('discovers new offline tests without admitting live drivers or duplicate groups', () => {
  const root = mkdtempSync(join(tmpdir(), 'goalport-test-discovery-'));
  try {
    for (const name of [
      'scripts/new.test.mjs', 'scripts/connected/new.test.cjs',
      'electron/new.test.cjs', 'scripts/desktop/new.test.mjs',
      'scripts/acceptance/new.test.mjs', 'scripts/preview/new.test.cjs',
      'scripts/release/new.test.mjs', 'scripts/desktop/docs-ci.test.mjs',
      'scripts/acceptance/live-driver.mjs', 'scripts/connected/provider.live.test.mjs',
      'scripts/connected/pipe.windows.test.mjs', 'scripts/connected/archive.historical.test.mjs', 'scripts/fixtures/fake.test.mjs',
      'scripts/node_modules/fake.test.cjs', 'scripts/artifacts/fake.test.mjs',
      'scripts/connected/component.test.tsx',
    ]) {
      const file = join(root, name); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, '');
    }
    assert.deepEqual(discoverNodeTests(root, 'unit'), ['scripts/connected/new.test.cjs', 'scripts/new.test.mjs']);
    assert.deepEqual(discoverNodeTests(root, 'desktop'), ['electron/new.test.cjs', 'scripts/acceptance/new.test.mjs', 'scripts/desktop/new.test.mjs', 'scripts/preview/new.test.cjs']);
    assert.deepEqual(discoverNodeTests(root, 'release'), ['scripts/release/new.test.mjs']);
    assert.throws(() => discoverNodeTests(root, 'missing'), /Unknown test group/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
