# Development

## Setup

Install the [build prerequisites](building.md#prerequisites), then:

```powershell
pnpm install --frozen-lockfile
```

## Repository layout

| Path | Contents |
| --- | --- |
| `src/` | React renderer (`App.tsx`), IPC client (`ipc.ts`), shared types, renderer tests |
| `electron/` | Electron main process, preload bridge, Core client, profile and launch configuration |
| `crates/goalport-core/` | Rust Core: store, command processing, projection, Runtime adapters, Named Pipe and Unix socket servers; integration tests in `tests/` |
| `crates/goalport-launcher/` | Launcher that starts Core detached from the window |
| `src-tauri/` | Tauri host, kept as a regression target for shared Core and protocol changes |
| `scripts/desktop/` | Packaging helpers, package verification, start, packaged smoke tests |
| `scripts/connected/` | Packaging entry point plus historical live-admission and GUI evidence drivers |
| `scripts/verify.mjs` | Original fail-closed M0–M5 verification gates (see [reference](reference/verification-gates.md)) |
| `tests/scenarios/` | The 23 declared synthetic Scenario contracts (`manifest.json`) |
| `docs/` | This documentation |

## Running from source

```powershell
cargo build --locked --release -p goalport-core -p goalport-core-launcher
pnpm build
pnpm electron:dev
```

- `cargo build` places Core and the launcher in `target/release`. An unpackaged run looks for them there, then in `target/debug`, and refuses to start without Core.
- `pnpm build` type-checks the renderer and builds it into `dist/`.
- `electron:dev` runs Electron against that bundle. It uses the profile `%APPDATA%\GoalPort\dev` and never touches RC data. Compatible builds can reopen existing profiles; unsupported data needs the explicit recovery or import flow described in [profile continuity](profile-continuity.md).

To exercise the product as users run it, build and start a package instead; see [building](building.md).

`pnpm dev` starts the Vite dev server alone. Without Electron, the renderer shows a built-in synthetic browser preview with sample data. It is useful for layout work, but it is not connected to Core.

## Working rules

- **Fixtures are synthetic.** Tests, scenarios and screenshots use throwaway workspaces and synthetic text. Real accounts, prompts, transcripts, credentials, tokens, workspace paths and native configuration must never enter source, fixtures or logs.
- **Keep the ownership boundary.** GoalPort must not write native Runtime configuration, pass permission-bypass flags, or fall back to API keys; see [runtime integration](runtimes.md).
- **Unknown stays unknown.** Do not add automatic resend, or infer quiescence from elapsed time or process exit; see [safety](safety.md).

For the Linux backend and its operator client, see [Linux development](linux-development.md).

The local preview driver exposes `preview_snapshot`, `click`, `evaluate`, `fill`, `key`, `viewport` and `screenshot` over JSON lines:

```sh
pnpm build
node scripts/preview/cli.mjs
# stdin examples:
# {"method":"preview_snapshot"}
# {"method":"click","selector":".draft-runtime-picker .runtime-picker-button"}
# {"method":"evaluate","expression":"document.activeElement?.tagName"}
# {"method":"quit"}
```

It starts an isolated headless Chromium profile and a local static server. Set `GOALPORT_PREVIEW_CHROME` to a local Chromium executable if discovery cannot find one. `node scripts/preview/acceptance.mjs --out goal-runs/ui-check` walks first use, input persistence, permissions and closing at 560, 1024 and 1440 pixels, saving screenshots and a JSON report. These are synthetic browser-preview checks; native task acceptance is separate.

Before opening a pull request, run the checks in [testing](testing.md#local-checks).
