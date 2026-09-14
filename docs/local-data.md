# Local data

All GoalPort state stays on your machine. There is no GoalPort account, no GoalPort server and no telemetry. Native Runtimes keep their own local and service-side data; see [privacy and trust](privacy.md).

## Where data lives

| How GoalPort was started | Profile directory |
| --- | --- |
| Packaged RC (`GoalPort.exe`) | `%APPDATA%\GoalPort\rc` |
| Unpackaged development (`pnpm electron:dev`) | `%APPDATA%\GoalPort\dev` |
| `--data-dir <absolute path>` | that directory |
| `--test-profile <absolute path>` | that directory, synthetic Scenario only (see [testing](testing.md)) |

A profile directory contains:

| File | Purpose |
| --- | --- |
| `goalport-profile.json` | Profile identity marker (see below) |
| `goalport.sqlite` (plus WAL files) | All Campaign, Task, Attempt, event, decision and receipt records |
| `goalport.sqlite.launcher.log` | How Core was launched, including breakaway or inherited-job mode |
| `goalport.sqlite.core.log` | Core diagnostics |
| Electron profile data | Window/browser state for this profile |

The RC profile is separate from data folders used by earlier GoalPort development builds and from historical acceptance databases. Explicit `--data-dir` and `--test-profile` paths take precedence over the defaults. A normal profile and a test profile cannot share a directory, and the two flags cannot be combined.

To keep a separate normal profile:

```powershell
pnpm electron:start --package artifacts/electron-rc/rc1/GoalPort-win32-x64 --data-dir C:\GoalPortData\rc1
```

## Profiles are bound to a build

The first launch writes `goalport-profile.json` with the mode (normal or synthetic test), the RC version, the Core binary SHA-256 and a key derived from the canonical directory path. On later launches GoalPort refuses the profile, without rewriting anything, when:

- the directory is not empty and has no marker. Legacy databases are never adopted or imported;
- the marker belongs to a different mode;
- the marker belongs to another RC version or Core build;
- the marker uses the earlier case-folded path identity format, or the directory was moved so its canonical key no longer matches.

The Core pipe name is derived from the same profile key and Core hash. Two different builds therefore cannot attach to each other's Core.

**Database migration and import are not provided in this RC.** When you change builds, use a new data directory. Development runs do not import or migrate RC data.

## Workspaces

A Project is a canonical existing folder. Workspace comparison is conservative. Two distinct canonical folders that collapse to the same comparison key are refused rather than routed through the other Project.

## Deleting data

GoalPort data and native Runtime data are separate. Removing GoalPort data does not delete a native Runtime session or change files in your workspace. To remove GoalPort data entirely, quit GoalPort, make sure its `goalport-core.exe` for that profile is no longer running (Core can keep running after the window closes), then delete the profile directory.
