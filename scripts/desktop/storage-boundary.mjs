// Storage-boundary judgements shared by the packaged smoke driver and its
// tests. Extracted into an importable module (the smoke driver itself is a
// top-level script and cannot be imported by tests) so the containment and
// durable-allowlist decisions are EXECUTED by unit tests against real file
// layouts — a missing import or broken judgement must fail in `pnpm
// test:desktop`, not only on a packaged CI runner.
import launchConfig from "../../electron/launch-config.cjs";

// The durable profile root may carry ONLY GoalPort-owned durable
// storage-contract entries: the identity marker, the SQLite database and its
// sidecars, the Core-side logs and the launch-ready receipt
// (`goalport.sqlite.launch-ready`, the product receipt Core commits next to
// the database — product_receipts.rs `launch_ready_path`), plus the import
// journal / staging / backups. A Chromium entry of ANY name — known or brand
// new — is NOT allowed here: after the storage-boundary split Chromium writes
// only to the separate browser-state namespace.
export function durableStorageEntryAllowed(name) {
  return name === "goalport-profile.json"
    || name === "goalport.sqlite"
    || name === "goalport.sqlite-wal"
    || name === "goalport.sqlite-shm"
    || name === "goalport.sqlite.launcher.log"
    || name === "goalport.sqlite.core.log"
    || name === "goalport.sqlite.launch-ready"
    || name === "import-journal.json"
    || name === "backups"
    || name.startsWith(".import-staging-");
}

// True when `directory` is strictly INSIDE `ownerRoot` (never equal to it,
// never escaping upwards, never on another drive). Reuse the central physical
// path comparison so a caller's 8.3 spelling or a junction cannot disguise
// containment. The caller supplies the path model's browser owner root.
export function browserStateContainedIn({ ownerRoot, directory }) {
  const relation = launchConfig.storagePathRelationship(ownerRoot, directory);
  return relation.browserInsideDurable && !relation.samePath;
}
