import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("package.json test script does not pass TypeScript files to node --test", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const script = pkg.scripts?.test;
  assert.equal(typeof script, "string", "package.json scripts.test must be a string");
  const marker = "node --test";
  const at = script.indexOf(marker);
  assert.notEqual(at, -1, "scripts.test must invoke node --test");
  const nodeArgs = script.slice(at + marker.length).trim().split(/\s+/).filter(Boolean);
  const typescript = nodeArgs.filter((arg) => arg.endsWith(".ts") || arg.endsWith(".tsx"));
  assert.deepEqual(
    typescript,
    [],
    `node --test must receive only .mjs files, got TypeScript: ${typescript.join(" ")}`
  );
  assert.ok(
    nodeArgs.every((arg) => arg.endsWith(".mjs")),
    `node --test arguments must be .mjs files: ${nodeArgs.join(" ")}`
  );
});
