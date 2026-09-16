// Computes the set of third-party npm packages whose code actually ends up
// in the bundled renderer (resources/app.asar via the Vite build output).
// This walks the runtime `dependencies` in package.json (not devDependencies,
// which are build/test tooling never bundled by Vite) and their own runtime
// dependency closures as installed under node_modules.
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(import.meta.dirname, "../..");
const require = createRequire(resolve(ROOT, "package.json"));

function readPackageJson(name) {
  const path = require.resolve(`${name}/package.json`);
  return { path, json: JSON.parse(readFileSync(path, "utf8")) };
}

export function npmShippedClosure(root = ROOT) {
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const roots = Object.keys(pkg.dependencies || {});
  const seen = new Map();
  const queue = [...roots];
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    const { path, json } = readPackageJson(name);
    const licenseFilePath = ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENSE-MIT", "License"]
      .map((candidate) => resolve(path, "..", candidate))
      .find((candidate) => existsSync(candidate)) || null;
    seen.set(name, { name, version: json.version, license: json.license || null, licenseFilePath, manifestPath: path });
    for (const dep of Object.keys(json.dependencies || {})) queue.push(dep);
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(npmShippedClosure(), null, 2));
}
