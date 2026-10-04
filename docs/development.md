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
| `scripts/connected/` | Packaging entry point, the maintained `ui-debug` driver (see below), plus historical live-admission and GUI evidence drivers |
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

`pnpm dev` starts the Vite dev server alone. Without Electron or the Linux workbench flag, the renderer shows a built-in synthetic browser preview with sample data. It is useful for layout work, but it is not connected to Core. The Linux workbench in `docs/linux-development.md` is the browser path that talks to a real Core.

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

## UI debug tools

`scripts/connected/ui-debug.mjs` is the same idea as the preview driver above, pointed at the **real connected app**: the built renderer served by the Linux workbench ([Linux development](linux-development.md#workbench)) and driven through the Chrome DevTools Protocol. Agents and CI scripts get `preview_snapshot`, `click`, `evaluate` and `screenshot` as first-class tools without shipping a browser runtime of their own. It is a developer tool that lives entirely in `scripts/`; the shipped app contains no debug hooks, test IDs or production-path instrumentation.

Start Core and the workbench, then either attach to a Chromium that already shows the page (`--cdp-port`), or let the tool start an isolated headless Chromium at `--url`:

```sh
pnpm build
python3 scripts/connected/linux-workbench.py --endpoint /tmp/goalport-dev/core.sock --port 4186
node scripts/connected/ui-debug.mjs --url http://127.0.0.1:4186/
```

The default `--url` is `http://127.0.0.1:4186/`; pass the port your workbench actually uses (the workbench's own default is 4173). After a one-line `{"ready":true,...}` announcement, each stdin JSON line gets one stdout JSON line:

- `{"method":"preview_snapshot"}` — the same semantic shape as the preview harness (`scripts/preview/harness.mjs`): `mode`, `width`, `height`, `title`, `connection`, `campaignId`, `heading`, `runtimeLabel`, `composer` (`characters`, `disabled`, `placeholder`, `sendDisabled`, `stopVisible`, `reason`), `pendingDecisions`, `activeElement`, `body`. `connection` and `campaignId` come from the live shell, so a disconnected or not-yet-booted page reports that honestly instead of pretending.
- `{"method":"click","selector":"..."}` — scrolls the control into view, then refuses it (`Control missing, blocked or outside viewport`) unless it has visible area, its center is inside the viewport, and `elementFromPoint` at that center hits the control or a descendant. Only then does it dispatch real CDP mouse events.
- `{"method":"evaluate","expression":"..."}` — evaluates in the page (awaits promises) and returns the JSON value.
- `{"method":"screenshot","path":"..."}` — writes a viewport PNG.
- `{"method":"quit"}` — closes the page (and the owned Chromium) and exits.

One workbench session, driven end to end:

```sh
printf '%s\n' \
  '{"method":"preview_snapshot"}' \
  '{"method":"click","selector":".runtime-picker .runtime-picker-button"}' \
  '{"method":"evaluate","expression":"document.querySelector(\".goalport-shell\")?.dataset.connection"}' \
  '{"method":"screenshot","path":"goal-runs/ui-debug/connected.png"}' \
  '{"method":"quit"}' \
  | node scripts/connected/ui-debug.mjs --url http://127.0.0.1:4186/
```

Safety boundary: the tool refuses any `--url` whose host is not `127.0.0.1` or `localhost` (the workbench itself binds loopback only and checks Host and Origin the same way), and CDP attach only ever talks to `127.0.0.1`. Nothing in `scripts/connected/ui-debug.mjs` is imported by app code. `node scripts/connected/ui-debug.mjs --selftest` verifies the protocol wiring against a fake page with no network and no browser; `node --test scripts/connected/ui-debug.test.mjs` covers the snapshot derivation, the click hit test and the loopback refusal rules.
