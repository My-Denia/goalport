# GoalPort

GoalPort is a Windows desktop control plane for local Coding Agent runtimes. Electron is the release line, backed by a Rust Core and SQLite. The repository builds **1.0.0-rc.1**; the product remains **Stable V1 RC**.

## Build and launch

From a fresh clone on Windows x64:

```powershell
pnpm install --frozen-lockfile
pnpm electron:package --out artifacts/electron-rc/rc1
pnpm electron:verify --package artifacts/electron-rc/rc1/GoalPort-win32-x64
pnpm electron:start --package artifacts/electron-rc/rc1/GoalPort-win32-x64
```

The build compiles the frontend, Core and launcher, then packages Electron. It also includes the existing optional Claude broker component; packaging does not enable it. No previous `target`, `dist`, local EXE, asar, acceptance database or historical run folder is needed. Choose a new output name for each build. Omitting `--out` creates a timestamped directory under `artifacts/electron-rc`; an existing destination is always refused.

You can move the complete `GoalPort-win32-x64` folder outside the checkout and open `GoalPort.exe` directly. Keep its `resources`, DLLs, locales and other files together. Node, pnpm, Rust and the source checkout are build tools, not requirements for running the packaged app. The local package is unsigned.

Prerequisites are Git, Node **22.19 or newer on the 22.x line, or 24+**, pnpm **11.22.0**, Rust **1.96.1** with the Windows MSVC target, and Visual Studio C++ Build Tools with a Windows SDK. `rust-toolchain.toml` selects Rust. `pnpm-lock.yaml` and `Cargo.lock` lock dependencies; Electron is **44.0.0**, React **19.2.8**, TypeScript **7.0.2** and Vite **8.2.2**. Dependency downloads need registry access. No account login or model call is part of the build.

`package-manifest.json` records the RC version, source revision, whether source changes were uncommitted, the source inventory digest and packaged file hashes. `resources/app.asar` contains the matching build identity. A source revision plus a dirty source digest identifies a local candidate; it does not claim those changes have been committed.

## First use and data

A normal first launch starts with no projects, Campaigns or Runtime sessions. Choose an existing workspace folder and enter a Campaign goal. Creating a Campaign saves local metadata. Select a Runtime, then send a message explicitly to start its work. Native subscriptions, credentials, skills, hooks, MCP and permissions stay with the installed native CLI. GoalPort does not create accounts or rewrite CLI configuration.

Normal data is in `%APPDATA%\GoalPort\rc`: `goalport.sqlite`, the Core launch log/receipts and Electron profile data. It is separate from the old generic GoalPort profile and historical acceptance databases. For a separate normal profile, use:

```powershell
pnpm electron:start --package artifacts/electron-rc/rc1/GoalPort-win32-x64 --data-dir C:\GoalPortData\rc1
```

A profile is bound to its mode, RC version and Core binary identity. An unrelated database or a profile from another build is refused before automatic migration. Use a new directory when changing builds; database migration/import is not provided in this RC.

Closing the window while a task is active offers the existing background/stop choices. Reopening the same package/profile reconnects to its matching Core. A lost command acknowledgement is reported without automatic resend. After a terminal Attempt, choosing a Runtime starts the next Attempt; repeated or stale conflicting choices cannot create competing replacements. Independent Campaigns retain separate identities. Held or unknown workspace responsibility remains enforced.

Windows terminals and CI runners can place processes in a supervised job. If that job refuses a breakaway request, the launcher can start Core under the existing job constraints. Core survives the GoalPort window and launcher closing, but the external supervisor can still terminate it when its job ends. The launcher records its creation mode beside the database. See [Windows job lifetimes](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects).

Runtime selection currently requires a content viewport wider than 1020 CSS pixels: the existing narrow layout hides the Runtime sidebar. Widen the window to use those controls. Packaged workflow checks use a fixed 1440×900 viewport; the separate 1000-pixel screenshot checks layout only.

## Synthetic checks and limits

**Scenario Runtime is an in-process synthetic test runtime**, not a real Agent or subscription admission. An explicit test profile allows Scenario only and rejects native Codex, Claude and Grok process starts:

```powershell
pnpm electron:start --package artifacts/electron-rc/rc1/GoalPort-win32-x64 --test-profile C:\GoalPortData\synthetic-rc1
```

Normal and test profiles cannot share a data directory. Scenario failure/hold markers are active only under explicit isolation; in a normal profile they are ordinary text. The native Runtime integrations retain their existing limitations. Synthetic checks do not admit a new native version, prove safe interruption of every native tool, release a held workspace, or establish Stable V1 closure. Tauri remains a bounded shared-contract regression target.

Run the local code checks with:

```powershell
pnpm lint
pnpm test:unit
pnpm test:desktop
cargo test --locked -p goalport-core --lib
cargo test --locked -p goalport-core --test electron_rc_core --test selection_preservation --test registration_boundary
cargo test --locked -p goalport-core-launcher
```

The packaged smoke driver copies the verified application into a fresh directory outside the source tree and exercises its real renderer, IPC and Core. It creates its own profiles and synthetic workspaces, writes screenshots/results to the new `--out` directory, and stops only its own processes. It never calls real subscriptions:

```powershell
node scripts/desktop/smoke.mjs --package artifacts/electron-rc/rc1/GoalPort-win32-x64 --normal --out artifacts/electron-rc/normal-smoke
node scripts/desktop/smoke.mjs --package artifacts/electron-rc/rc1/GoalPort-win32-x64 --out artifacts/electron-rc/synthetic-smoke
```

The Windows workflow in `.github/workflows/ci.yml` covers UI/Core regressions and a fresh Electron build with packaged smoke. A local run is not a remote CI result. Existing live-admission or broad soak scripts are separate, explicit workflows and are not invoked by these commands.

[Historical Desktop admission notes](docs/history/desktop-admission-notes.md) retain the old freezes and launch references for context. They are not the current package or startup instructions.
