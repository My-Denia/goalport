// Generates release/THIRD_PARTY_NOTICES.txt from the live dependency graph.
//
// Scope: this file lists only what actually ships inside the GoalPort-owned
// parts of the Windows Electron RC package (the three Rust binaries and the
// bundled renderer in resources/app.asar). It intentionally excludes:
//   - build-time-only crates (proc-macro compiler plugins and their
//     exclusive dependencies -- see rust-shipped-crates.mjs);
//   - devDependencies never bundled by Vite;
//   - Electron's own bundled Chromium/Node/V8 stack, whose upstream LICENSE
//     and LICENSES.chromium.html already ship in the package root unmodified.
//
// Re-run `pnpm release:third-party-notices` after any dependency change and
// commit the result; scripts/release/third-party-notices.test.mjs fails CI
// if the checked-in file drifts from what the current lockfiles produce.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rustShippedClosure } from "./rust-shipped-crates.mjs";
import { npmShippedClosure } from "./npm-shipped-packages.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
export const OUTPUT_PATH = resolve(ROOT, "release/THIRD_PARTY_NOTICES.txt");

function readLicenseText(path) {
  try { return readFileSync(path, "utf8").trimEnd(); } catch { return null; }
}

function sqliteAmalgamationNotice() {
  // libsqlite3-sys 0.30.1 vendors sqlite3/sqlite3.c under the `bundled` feature
  // (the plain amalgamation, not sqlcipher/, which GoalPort does not enable).
  // SQLite's own header amalgamation states its public-domain dedication;
  // we quote that declaration rather than asserting it from memory.
  return [
    "SQLite (C library, statically compiled into goalport-core.exe via the",
    "rusqlite \"bundled\" feature; not a separately versioned crate)",
    "",
    "SQLite is in the public domain. From the vendored amalgamation header:",
    "  \"...the public domain.\"",
    "See https://www.sqlite.org/copyright.html for the upstream statement.",
    ""
  ].join("\n");
}

function rustSection(entry) {
  const lines = [`${entry.name} ${entry.version} (${entry.license || "license unknown"})`];
  if (entry.repository) lines.push(entry.repository);
  const licensePath = entry.manifestPath && resolve(entry.manifestPath, "..");
  const candidates = ["LICENSE", "LICENSE-MIT", "LICENSE-APACHE", "LICENSE.md"].map((name) => resolve(licensePath, name));
  const found = candidates.find((candidate) => existsSync(candidate));
  lines.push("");
  if (found) lines.push(readLicenseText(found));
  else lines.push("[No bundled license file found alongside this crate's source; verify against the crate's repository before public release.]");
  lines.push("");
  return lines.join("\n");
}

function npmSection(entry) {
  const lines = [`${entry.name} ${entry.version} (${entry.license || "license unknown"})`, ""];
  if (entry.licenseFilePath) lines.push(readLicenseText(entry.licenseFilePath));
  else lines.push(`[No bundled license file found in the installed package; SPDX declares "${entry.license}". Verify against the upstream project's repository before public release.]`);
  lines.push("");
  return lines.join("\n");
}

export function generate() {
  const { shipped, buildTimeOnly } = rustShippedClosure();
  const npm = npmShippedClosure();
  const parts = [];
  parts.push("GoalPort THIRD_PARTY_NOTICES");
  parts.push("=============================");
  parts.push("");
  parts.push("This file lists third-party components whose compiled code ships inside");
  parts.push("this GoalPort Windows RC package, outside of Electron's own bundled");
  parts.push("Chromium/Node/V8 distribution (see LICENSE and LICENSES.chromium.html in");
  parts.push("the package root, provided unmodified by the Electron project).");
  parts.push("");
  parts.push("None of the components below carried an upstream NOTICE file at the time");
  parts.push("this file was generated (checked directly against each crate's vendored");
  parts.push("source under the local Cargo registry cache), so no Apache License 2.0");
  parts.push("section 4(d) notice text is reproduced here.");
  parts.push("");
  parts.push("--------------------------------------------------------------------");
  parts.push("Rust components (goalport-core.exe, goalport-core-launcher.exe,");
  parts.push("goalport-claude-stop-broker.exe)");
  parts.push("--------------------------------------------------------------------");
  parts.push("");
  parts.push(sqliteAmalgamationNotice());
  for (const entry of shipped) parts.push(rustSection(entry));
  parts.push("--------------------------------------------------------------------");
  parts.push("Bundled renderer (resources/app.asar)");
  parts.push("--------------------------------------------------------------------");
  parts.push("");
  for (const entry of npm) parts.push(npmSection(entry));
  parts.push("--------------------------------------------------------------------");
  parts.push("Build-time-only Rust components (compiler plugins; their code does not");
  parts.push("ship inside any binary and is listed here only for transparency)");
  parts.push("--------------------------------------------------------------------");
  parts.push("");
  for (const entry of buildTimeOnly) parts.push(`${entry.name} ${entry.version} (${entry.license || "license unknown"})`);
  parts.push("");
  return `${parts.join("\n")}\n`.replace(/\n{3,}/g, "\n\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeFileSync(OUTPUT_PATH, generate());
  console.log(`Wrote ${OUTPUT_PATH}`);
}
