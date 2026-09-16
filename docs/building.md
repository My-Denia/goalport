# Building and running

GoalPort has no downloadable release yet. You build the Windows x64 RC package from source, and the result is a self-contained folder you can run and move. See [releasing](releasing.md) for how a verified package becomes a downloadable release candidate.

## Prerequisites

- Windows x64
- Git
- Node.js 22.19 or newer on the 22.x line, or 24+
- pnpm 11.22.0 (`corepack enable` uses the version pinned in `package.json`)
- Rust 1.96.1 (pinned by `rust-toolchain.toml`) with the `x86_64-pc-windows-msvc` target
- Visual Studio C++ Build Tools with a Windows SDK

Dependencies are locked by `pnpm-lock.yaml` and `Cargo.lock`. Key versions are Electron 44.0.0, React 19.2.8, TypeScript 7.0.2 and Vite 8.2.2. Downloading dependencies needs registry access. The build itself needs no account login and makes no model call.

## Build, verify, start

From a fresh clone:

```powershell
pnpm install --frozen-lockfile
pnpm electron:package --out artifacts/electron-rc/rc1
pnpm electron:verify --package artifacts/electron-rc/rc1/GoalPort-win32-x64
pnpm electron:start --package artifacts/electron-rc/rc1/GoalPort-win32-x64
```

`electron:package` builds the frontend, Core and launcher, then packages Electron. It needs no previous `target`, `dist`, local EXE, asar, acceptance database or historical run folder.

The package also contains the optional Claude Stop broker component. Packaging does not enable it.

- Choose a new output name for each build. An existing destination is always refused.
- If you omit `--out`, the build goes to a timestamped directory under `artifacts/electron-rc`.

`electron:verify` checks the package against its manifest. `electron:start` verifies the package again before it launches `GoalPort.exe`.

Options for `electron:start`:

| Option | Effect |
| --- | --- |
| *(none)* | Normal data in `%APPDATA%\GoalPort\rc` |
| `--data-dir <absolute path>` | A separate normal profile |
| `--test-profile <absolute path>` | A synthetic test profile that allows only the Scenario Runtime |

See [local data](local-data.md) for how profiles work.

## Running the package elsewhere

You can move the complete `GoalPort-win32-x64` folder outside the checkout and open `GoalPort.exe` directly. Keep `resources`, the DLLs, `locales` and the other files together. Node, pnpm, Rust and the source checkout are build tools; the packaged app does not need them.

The local package is **unsigned**. Windows may warn before running it.

To use a Runtime, install its CLI and sign in with that CLI first. GoalPort does not install or sign in to Runtimes. See [runtime integration](runtimes.md).

## Build identity

`package-manifest.json` in the package records:

- the RC version;
- the source revision, and whether the source had uncommitted changes;
- a source inventory digest;
- the hash of every packaged file.

`resources/app.asar` contains the matching build identity.

A source revision plus a dirty source digest identifies a local candidate build. It does not claim that those changes were ever committed.

A profile is bound to the Core binary hash of the build that created it, so a different build refuses an existing profile. Use a new `--data-dir` when you switch builds.
