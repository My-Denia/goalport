// Computes the set of third-party Rust crates whose compiled bytes actually
// ship inside the GoalPort-owned release binaries (goalport-core.exe,
// goalport-core-launcher.exe, goalport-claude-stop-broker.exe).
//
// This is deliberately narrower than the full Cargo.lock: it walks only
// normal (non-dev, non-build) dependency edges reachable from those crates'
// own binary targets, and it stops at proc-macro crates. A proc-macro crate
// runs on the host at compile time to generate code; neither it nor its own
// exclusive dependencies (e.g. syn/quote/proc-macro2/unicode-ident, reached
// only through serde_derive/thiserror-impl here) contribute bytes to the
// final binary, so they are reported separately as build-time-only.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(import.meta.dirname, "../..");
const ROOT_PACKAGES = ["goalport-core", "goalport-core-launcher"];

const RELEASE_TARGET = "x86_64-pc-windows-msvc";

function cargoMetadata(root) {
  // --filter-platform resolves target-cfg-gated deps (e.g. winapi's separate
  // GNU-ABI import-lib crates) exactly as cargo would for a real build of
  // this target, instead of us re-implementing cfg-expression evaluation.
  const result = spawnSync("cargo", ["metadata", "--offline", "--locked", "--format-version", "1", "--filter-platform", RELEASE_TARGET], {
    cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true
  });
  if (result.status !== 0) throw new Error(`cargo metadata failed: ${result.stderr || result.error}`);
  return JSON.parse(result.stdout);
}

export function rustShippedClosure(root = ROOT) {
  const meta = cargoMetadata(root);
  const packagesById = new Map(meta.packages.map((pkg) => [pkg.id, pkg]));
  const nodesById = new Map(meta.resolve.nodes.map((node) => [node.id, node]));
  const rootIds = ROOT_PACKAGES.map((name) => {
    const pkg = meta.packages.find((candidate) => candidate.name === name && candidate.source == null);
    if (!pkg) throw new Error(`Workspace crate not found in cargo metadata: ${name}`);
    return pkg.id;
  });

  const shipped = new Map();
  const buildTimeOnly = new Map();
  const visited = new Set();

  function isProcMacro(pkg) {
    return pkg.targets.some((target) => target.kind.includes("proc-macro"));
  }

  function walk(id, throughProcMacro) {
    const key = `${id}\0${throughProcMacro}`;
    if (visited.has(key)) return;
    visited.add(key);
    const pkg = packagesById.get(id);
    const node = nodesById.get(id);
    if (!pkg || !node) throw new Error(`Unresolved dependency node: ${id}`);
    const isRoot = ROOT_PACKAGES.includes(pkg.name) && pkg.source == null;
    const procMacro = isProcMacro(pkg);
    if (!isRoot) {
      const entry = { name: pkg.name, version: pkg.version, license: pkg.license || null, licenseFile: pkg.license_file || null, repository: pkg.repository || null, manifestPath: pkg.manifest_path };
      if (throughProcMacro || procMacro) buildTimeOnly.set(`${pkg.name}@${pkg.version}`, entry);
      else shipped.set(`${pkg.name}@${pkg.version}`, entry);
    }
    // A proc-macro crate's own dependencies only serve to build that host-side
    // compiler plugin; mark everything reached beyond it as build-time-only.
    const nextThroughProcMacro = throughProcMacro || procMacro;
    for (const dep of node.deps) {
      const normalEdge = dep.dep_kinds.some((k) => k.kind === null);
      if (!normalEdge) continue;
      walk(dep.pkg, nextThroughProcMacro);
    }
  }

  for (const id of rootIds) walk(id, false);
  // A crate might be reachable both as a genuinely shipped dependency and,
  // separately, only through a proc-macro elsewhere; shipped wins.
  for (const key of shipped.keys()) buildTimeOnly.delete(key);

  return {
    shipped: [...shipped.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version)),
    buildTimeOnly: [...buildTimeOnly.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { shipped, buildTimeOnly } = rustShippedClosure();
  console.log(JSON.stringify({ shipped, buildTimeOnly }, null, 2));
}
