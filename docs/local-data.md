# Local data

All GoalPort state stays on your machine. There is no GoalPort account, no GoalPort server and no telemetry. Native Runtimes keep their own local and service-side data; see [privacy and trust](privacy.md).

## Where data lives

The layout below describes the current development candidate. Previously
published rc.1 assets retain their original storage behavior.

| How GoalPort was started | Durable profile directory | Electron/Chromium browser state |
| --- | --- | --- |
| Packaged RC (`GoalPort.exe`) | `%APPDATA%\GoalPort\rc` | `%APPDATA%\GoalPort\electron\<profile key>` |
| Unpackaged development (`pnpm electron:dev`) | `%APPDATA%\GoalPort\dev` | `%APPDATA%\GoalPort\electron\<profile key>` |
| `--data-dir <absolute path>` | that directory | the separate `electron\<profile key>` namespace next to the app-data root, never inside the `--data-dir` |
| `--test-profile <absolute path>` | that directory, synthetic Scenario only (see [testing](testing.md)) | `<parent of the test directory>\electron\<profile key>` (test-owned scratch) |

A durable profile directory contains only data you would back up, migrate or restore:

| File | Purpose |
| --- | --- |
| `goalport-profile.json` | Profile identity marker (see below) |
| `goalport.sqlite` (plus WAL files) | All Campaign, Task, Attempt, event, decision and receipt records |
| `goalport.sqlite.launcher.log` | How Core was launched, including breakaway or inherited-job mode |
| `goalport.sqlite.core.log` | Core diagnostics |
| `backups/`, `import-journal.json`, `.import-staging-*` | Consistency backups and crash-safe import staging |

The Electron/Chromium browser state (caches, `Local State`, `Preferences`, `Network`, session storage, `window-state.json`) lives in its own namespace keyed by the durable profile identity. It is never written into the durable profile directory, so backing up a `--data-dir` gives you pure GoalPort data, and a fresh profile decision can never race Chromium session files. Browser-state identity follows the canonical durable profile path (not the Core build), and deleting it only resets window geometry and caches. A `--user-data-dir <absolute path>` (the standard Chromium switch) relocates the application-data root: both the durable channel directories and the `electron` namespace move inside the relocated root and stay physically separate; combined with `--data-dir`, the `--data-dir` keeps owning the durable location. Historical Chromium files left in an older profile directory are ignored, never deleted, and no longer used.

The RC profile is separate from data folders used by earlier GoalPort development builds and from historical acceptance databases. Explicit `--data-dir` and `--test-profile` paths take precedence over the defaults. A normal profile and a test profile cannot share a directory, and the two flags cannot be combined.

To keep a separate normal profile:

```powershell
pnpm electron:start --package artifacts/electron-rc/rc1/GoalPort-win32-x64 --data-dir C:\GoalPortData\rc1
```

## Profile identity and compatibility

The marker identifies the canonical durable path and normal or synthetic mode.
Build hashes record provenance; compatible builds can reopen the same data.
GoalPort refuses unknown files in an unmarked directory, incompatible or corrupt
data, a mismatched marker identity, and a missing database after a recorded open.
Known Chromium leftovers from the former shared directory remain compatible and
are preserved. See [profile continuity](profile-continuity.md) for backup and import behavior.

Durable and browser paths must be physically disjoint, including junction and
short-name aliases. Neither may contain the other. For example, combining
`--user-data-dir R` with `--data-dir R\GoalPort` is refused before browser setup;
choose a separate durable directory. Redirecting the browser namespace outside
the relocated app-data root or synthetic scratch root is also refused.

The Core pipe name is derived from the same profile key and Core hash. Two different builds therefore cannot attach to each other's Core.

The previously published rc.1 package remains build-bound; these candidate
changes do not alter its files or its behavior.

## Workspaces

A Project is a canonical existing folder. Workspace comparison is conservative. Two distinct canonical folders that collapse to the same comparison key are refused rather than routed through the other Project.

## Deleting data

GoalPort data and native Runtime data are separate. Removing GoalPort data does not delete a native Runtime session or change files in your workspace. To remove GoalPort data entirely, quit GoalPort, make sure its `goalport-core.exe` for that profile is no longer running (Core can keep running after the window closes), then delete the profile directory.
