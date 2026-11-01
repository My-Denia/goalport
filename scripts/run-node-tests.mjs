import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const groups = {
  unit: ['scripts'],
  desktop: ['electron', 'scripts/desktop', 'scripts/acceptance', 'scripts/preview'],
  release: ['scripts/release'],
};
const desktopRoots = groups.desktop.slice(1);
const excludedDirectories = new Set(['node_modules', 'fixtures', '__fixtures__', 'goal-runs', 'dist', 'target', 'artifacts']);
export function discoverNodeTests(root, group) {
  if (!groups[group]) throw new Error(`Unknown test group: ${group}`);
  const files = [];
  function walk(folder) {
    for (const entry of readdirSync(resolve(root, folder), { withFileTypes: true })) {
      const name = `${folder}/${entry.name}`;
      if (entry.isDirectory()) {
        if (excludedDirectories.has(entry.name)) continue;
        if (group === 'unit' && [...desktopRoots, 'scripts/release'].includes(name)) continue;
        walk(name);
      } else if (entry.isFile() && /\.test\.(mjs|cjs)$/.test(name)) {
        // Real environment tests require explicit invocation, never discovery.
        if (/\.(live|historical|windows|linux|macos)\.test\./.test(name)) continue;
        // The changes job runs documentation checks once.
        if (name === 'scripts/desktop/docs-ci.test.mjs') continue;
        files.push(name);
      }
    }
  }
  for (const folder of groups[group]) walk(folder);
  return [...new Set(files)].sort();
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const [group = 'unit', option] = process.argv.slice(2);
  const files = discoverNodeTests(root, group);
  if (!files.length) throw new Error(`No tests found for ${group}`);
  if (option === '--list') console.log(JSON.stringify(files, null, 2));
  else {
    if (option) throw new Error(`Unknown option: ${option}`);
    const result = spawnSync(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit' });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  }
}
