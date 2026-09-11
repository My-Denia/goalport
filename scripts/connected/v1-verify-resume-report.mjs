import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateReport } from "./v1-resume-chain.mjs";

function flag(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

export function verifyStoredReport({ reportPath, dbPath, mode }) {
  const source = JSON.parse(readFileSync(reportPath, "utf8"));
  const expectedDb = resolve(dbPath);
  const declaredDb = resolve(String(source.dbPath || source.database || ""));
  if (declaredDb !== expectedDb) {
    return { status: "UNMET", reasons: ["report database path does not match --db"] };
  }
  return evaluateReport(source, { mode, requireFreeze: true });
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const argv = process.argv.slice(2);
    const reportPath = resolve(flag(argv, "--report") || "");
    const dbPath = resolve(flag(argv, "--db") || "");
    const outputPath = resolve(flag(argv, "--output") || "");
    const mode = flag(argv, "--mode") || "graceful";
    if (!flag(argv, "--report") || !flag(argv, "--db") || !flag(argv, "--output")) {
      throw new Error("--report, --db, and --output are required");
    }
    if (outputPath === reportPath || outputPath === dbPath) {
      throw new Error("--output must not overwrite the source report or SQLite");
    }
    const verdict = verifyStoredReport({ reportPath, dbPath, mode });
    const result = {
      schemaVersion: 1,
      kind: "resume-chain-adjudication",
      sourceReport: reportPath,
      sourceDatabase: dbPath,
      evaluatedAtUtc: new Date().toISOString(),
      status: verdict.status,
      reasons: verdict.reasons
    };
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = verdict.status === "PASS" ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 2;
  }
}
