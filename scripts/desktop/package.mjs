import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(import.meta.dirname, "../..");
export const COMPONENTS = ["goalport-core.exe", "goalport-core-launcher.exe", "goalport-claude-stop-broker.exe"];
export const ROOT_BUILD_INPUTS = Object.freeze([
  "Cargo.lock", "Cargo.toml", "index.html", "package.json", "pnpm-lock.yaml", "rust-toolchain.toml",
  "tsconfig.app.json", "tsconfig.json", "tsconfig.node.json", "vite.config.ts"
]);
const ROOT_BUILD_INPUT_SET = new Set(ROOT_BUILD_INPUTS);
const ROOT_BUILD_INPUT_PATTERNS = [
  /^tsconfig(?:\.[A-Za-z0-9_-]+)?\.json$/,
  /^vite\.config\.(?:cjs|cts|js|mjs|mts|ts)$/
];
const CARGO_CONFIG_PATHS = [".cargo/config", ".cargo/config.toml"];
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const fileHash = (file) => sha256(readFileSync(file));

export function artifactPaths(root, prefix = "") {
  return readdirSync(resolve(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Unexpected package link: ${name}`);
    return entry.isDirectory() ? artifactPaths(root, name) : [name];
  }).sort();
}

export function argsFor(argv, names) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--help" || name === "-h") { values.help = true; continue; }
    if (!names.includes(name) || !argv[index + 1] || argv[index + 1].startsWith("--")) {
      throw new Error(`Unknown or incomplete argument: ${name}`);
    }
    if (values[name]) throw new Error(`Repeated argument: ${name}`);
    values[name] = argv[++index];
  }
  return values;
}

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`Git source identity unavailable: ${result.stderr || result.error || args.join(" ")}`);
  return result.stdout;
}

function pathExists(root, name) {
  try {
    lstatSync(resolve(root, name));
    return true;
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
    throw error;
  }
}

function rejectUntrackedCargoConfig(root, tracked) {
  for (const name of CARGO_CONFIG_PATHS) {
    if (pathExists(root, name) && !tracked.has(name)) {
      throw new Error(`Untracked or ignored Cargo configuration is not allowed in source identity: ${name}`);
    }
  }
}

function isAllowedNewSource(name) {
  return ROOT_BUILD_INPUT_SET.has(name)
    || ROOT_BUILD_INPUT_PATTERNS.some((pattern) => pattern.test(name))
    || /^(src|crates|electron|scripts|tests|docs|\.github)\//.test(name);
}

// Include tracked files and deliberate new source files, never private run data,
// user config or build output. The list is recorded so an export is reviewable.
export function sourceIdentity(root = ROOT) {
  const revision = git(root, ["rev-parse", "HEAD"]).trim();
  const tracked = git(root, ["ls-files", "-z"]).split("\0").filter(Boolean);
  const trackedSet = new Set(tracked);
  rejectUntrackedCargoConfig(root, trackedSet);
  const newFiles = git(root, ["ls-files", "--others", "--exclude-standard", "-z"])
    .split("\0").filter((name) => isAllowedNewSource(name));
  const files = [...new Set([...tracked, ...newFiles])].sort()
    .filter((name) => !/(^|\/)(goal-runs|\.goal-runs|node_modules|target|dist|artifacts|\.git)(\/|$)/.test(name))
    .filter((name) => !/(\.tsbuildinfo|\.db(?:-shm|-wal)?|\.sqlite(?:-shm|-wal)?|\.log|\.exe|\.dll)$/.test(name))
    .filter((name) => !/(^|\/)(\.env(?:\..*)?|\.npmrc|\.outbound-manifest.*)$/.test(name))
    .filter((name) => existsSync(resolve(root, name)))
    .map((name) => ({ path: name, sha256: fileHash(resolve(root, name)) }));
  if (!files.some((file) => file.path === "Cargo.lock") || !files.some((file) => file.path === "pnpm-lock.yaml")) {
    throw new Error("Both committed dependency lockfiles must be present");
  }
  return {
    revision,
    dirty: git(root, ["status", "--porcelain", "--untracked-files=no"]).trim().length > 0 || newFiles.length > 0,
    treeSha256: sha256(files.map(({ path, sha256: hash }) => `${path}\0${hash}\n`).join("")),
    files
  };
}

export function claimOutput(out, root = ROOT) {
  const absolute = resolve(out);
  const relativePath = relative(root, absolute);
  if (absolute === resolve(root) || /(^|[\\/])(goal-runs|\.goal-runs)([\\/]|$)/i.test(absolute)) {
    throw new Error("Build output must be a new delivery directory, outside historical goal-runs");
  }
  // No overwrite mode. A failed build remains inspectable and the next build
  // gets another directory; packaging never removes a historical candidate.
  if (existsSync(absolute)) throw new Error(`Output already exists; choose a new directory: ${absolute}`);
  if (relativePath.startsWith("..") && !isAbsolute(out)) throw new Error("External output must be an explicit absolute path");
  mkdirSync(absolute, { recursive: true });
  return absolute;
}

export function asarApi() {
  const require = createRequire(import.meta.url);
  const packagerRequire = createRequire(require.resolve("electron-packager"));
  return packagerRequire("@electron/asar");
}

function run(command, args, root, env, log) {
  const startedAt = new Date().toISOString();
  console.log(`> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd: root, env, encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  log.push({ command, args, cwd: ".", startedAt, exitCode: result.status, error: result.error?.message });
  if (result.status !== 0) throw new Error(`Build command failed (${result.status ?? "spawn error"}): ${command}: ${result.error?.message || "see output"}`);
  return result.stdout.trim();
}

export async function main(argv = process.argv.slice(2)) {
  const args = argsFor(argv, ["--out"]);
  if (args.help) {
    console.log("Build the Windows Electron RC from current source:\n  pnpm electron:package [--out <new-directory>]\nRequires Git, Node >=22.19, pnpm 11.22.0, Rust 1.96.1 MSVC and Visual Studio C++ build tools.\nBuilds frontend, Core, launcher and optional broker; never reuses target/dist or overwrites outputs.");
    return;
  }
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("This RC build supports Windows x64 only");
  const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
  if (!/^\d+\.\d+\.\d+-rc\.[0-9]+$/.test(pkg.version)) throw new Error("Package version must explicitly identify an RC");
  const out = claimOutput(args["--out"] || resolve(ROOT, "artifacts/electron-rc", `${pkg.version}-${new Date().toISOString().replace(/[:.]/g, "-")}`));
  const log = [];
  try {
    const source = sourceIdentity();
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GOALPORT_/i.test(key)));
    // Explicit target/output paths override inherited caches and stale artifacts.
    env.CARGO_TARGET_DIR = resolve(out, "cargo-target");
    delete env.RUSTC_WRAPPER;
    delete env.RUSTC_WORKSPACE_WRAPPER;
    const cargoVersion = run("cargo", ["--version"], ROOT, env, log);
    const rustVersion = run("rustc", ["--version"], ROOT, env, log);
    if (!rustVersion.startsWith("rustc 1.96.1 ")) throw new Error(`rust-toolchain.toml requires Rust 1.96.1, got ${rustVersion}`);
    const frontend = resolve(out, "frontend");
    run(process.execPath, [resolve(ROOT, "node_modules/typescript/bin/tsc"), "-b", "--force"], ROOT, env, log);
    run(process.execPath, [resolve(ROOT, "node_modules/vite/bin/vite.js"), "build", "--outDir", frontend], ROOT, env, log);
    run("cargo", ["build", "--locked", "--release", "--target-dir", env.CARGO_TARGET_DIR, "-p", "goalport-core", "-p", "goalport-core-launcher"], ROOT, env, log);
    const binaries = COMPONENTS.map((name) => resolve(env.CARGO_TARGET_DIR, "release", name));
    for (const binary of binaries) if (!existsSync(binary) || !statSync(binary).size) throw new Error(`Missing freshly built component: ${binary}`);
    for (const name of COMPONENTS.slice(0, 2)) {
      const version = run(resolve(env.CARGO_TARGET_DIR, "release", name), ["--version"], ROOT, env, log);
      if (!version.endsWith(` ${pkg.version}`)) throw new Error(`Component version mismatch: ${name}: ${version}`);
    }
    const buildInfo = {
      schemaVersion: 1, product: "GoalPort", version: pkg.version, channel: "Stable V1 RC",
      electronVersion: pkg.devDependencies.electron,
      source, builtAtUtc: new Date().toISOString(),
      tools: { node: process.version, pnpm: pkg.packageManager, cargo: cargoVersion, rust: rustVersion },
      components: Object.fromEntries(COMPONENTS.map((name, index) => [name, fileHash(binaries[index])]))
    };
    const stage = resolve(out, "stage");
    mkdirSync(stage);
    for (const name of ["main.cjs", "preload.cjs", "launch-config.cjs", "core-client.cjs"]) cpSync(resolve(ROOT, "electron", name), resolve(stage, name));
    cpSync(frontend, resolve(stage, "dist"), { recursive: true });
    writeFileSync(resolve(stage, "package.json"), JSON.stringify({ name: "goalport-electron-rc", productName: "GoalPort", version: pkg.version, main: "main.cjs" }, null, 2));
    writeFileSync(resolve(stage, "build-info.json"), `${JSON.stringify(buildInfo, null, 2)}\n`);
    const { default: packager } = await import("electron-packager");
    const packages = await packager({
      dir: stage, name: "GoalPort", platform: "win32", arch: "x64", out,
      overwrite: false, asar: true, prune: false,
      electronVersion: pkg.devDependencies.electron, appVersion: pkg.version,
      buildVersion: pkg.version, extraResource: binaries,
      win32metadata: { ProductName: "GoalPort", FileDescription: `GoalPort ${pkg.version} (RC)`, CompanyName: "GoalPort" }
    });
    if (packages.length !== 1) throw new Error("Expected exactly one Windows x64 package");
    const packageRoot = packages[0];
    const artifacts = artifactPaths(packageRoot).map((name) => ({
      path: name, bytes: statSync(resolve(packageRoot, name)).size, sha256: fileHash(resolve(packageRoot, name))
    }));
    if (sourceIdentity().treeSha256 !== source.treeSha256) throw new Error("Source changed during the build; keep this failed output and rebuild stable inputs");
    const manifest = { ...buildInfo, artifacts };
    writeFileSync(resolve(packageRoot, "package-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(resolve(out, "build-commands.json"), `${JSON.stringify(log, null, 2)}\n`);
    const { verifyPackage } = await import("./verify-package.mjs");
    const verified = verifyPackage(packageRoot);
    writeFileSync(resolve(out, "verification.json"), `${JSON.stringify(verified, null, 2)}\n`);
    console.log(JSON.stringify({ status: "PASS", version: pkg.version, package: packageRoot, sourceRevision: source.revision, sourceDirty: source.dirty, sourceTreeSha256: source.treeSha256 }, null, 2));
  } catch (error) {
    writeFileSync(resolve(out, "build-failure.json"), JSON.stringify({ error: error.message, commands: log }, null, 2));
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
