# Testing and CI

GoalPort's tests are executable contracts. They check GoalPort's own behavior: state machine, IPC, recovery, profile identity, packaging, and the packaged GUI. They use only synthetic data and never call a real subscription.

## Synthetic vs native evidence

The **Scenario Runtime** is an in-process synthetic test Runtime. It is not a real agent, and passing Scenario checks does not:

- admit a native Runtime or a new CLI version;
- prove safe interruption of every native tool;
- release a held workspace;
- establish Stable V1.

A **test profile** (`--test-profile <absolute path>`) allows only the Scenario Runtime. Core rejects native Codex, Claude Code and Grok process starts in that profile. Scenario failure and hold markers (`RC-MARKER-*`) take effect only under this explicit isolation; in a normal profile they are ordinary text.

Native Runtime admission was decided separately, on recorded live evidence for specific builds; see the [runtime support matrix](reference/runtime-support-matrix.md).

## Local checks

```powershell
pnpm lint
pnpm test:unit
pnpm test:desktop
cargo test --locked -p goalport-core --lib
cargo test --locked -p goalport-core --test workspace_aliases --test workspace_identity --test electron_rc_core --test handoff_lineage --test product_receipts --test scenario_turn_failure --test selection_preservation --test registration_boundary --test core_contract --test connected_projection --test connected_flow --test scenario_predicates --test state_machine --test hardening --test recovery --test stop_responsibility --test stop_continuation --test pipe_security --test core_restart_epoch
cargo test --locked -p goalport-core-launcher
```

| Command | Covers |
| --- | --- |
| `pnpm lint` | TypeScript project build (`tsc -b`) |
| `pnpm test:unit` | Renderer and IPC client tests (Vitest) |
| `pnpm test:desktop` | Packaging, launch configuration, diagnostics, owned-Core cleanup, CDP helpers, and the documentation contract (`scripts/desktop/docs-ci.test.mjs`) |
| `cargo test -p goalport-core` | Core library tests and the integration tests CI runs (`crates/goalport-core/tests/`; CI also runs selected `registration_generation` cases) |
| `cargo test -p goalport-core-launcher` | Launcher behavior |

`docs-ci.test.mjs` also checks this documentation. The README must show the `package.json` version and the Stable V1 RC status, every documented `pnpm` script must exist, and every relative link and image in the README and `docs/` must resolve with exact file-name case.

## Packaged smoke tests

The smoke driver tests a real package end to end:

- It copies the verified package to a fresh directory outside the source tree.
- It exercises the real renderer, IPC and Core over the Chrome DevTools Protocol at a fixed 1440×900 viewport.
- It creates its own profiles and synthetic workspaces, with an empty native home and a `PATH` limited to System32.
- It writes screenshots and results to the new `--out` directory.
- It stops only its own processes.

```powershell
node scripts/desktop/smoke.mjs --package artifacts/electron-rc/rc1/GoalPort-win32-x64 --normal --out artifacts/electron-rc/normal-smoke
node scripts/desktop/smoke.mjs --package artifacts/electron-rc/rc1/GoalPort-win32-x64 --out artifacts/electron-rc/synthetic-smoke
node scripts/desktop/verify-early-cleanup.mjs --package artifacts/electron-rc/rc1/GoalPort-win32-x64 --out artifacts/electron-rc/early-cleanup
```

| Run | What it checks |
| --- | --- |
| `--normal` | Ordinary first use: empty start, Campaign creation without an Attempt, Runtime selection and binding conflicts, exact message fidelity, inert markers, a second independent Campaign, and closing then reopening the window on the same Core with unchanged records and no resend |
| synthetic (default) | The above under a test profile, plus the native-start firewall, a failed send that keeps its input, a terminal Attempt with a cross-provider selection race producing one replacement, and a delayed send that stays bound to its original Campaign |
| `verify-early-cleanup` | Injects a failure before the renderer startup receipt. The verifier requires that failure and confirms the owned Core was cleaned up using its committed launch identity. An unknown identity is retained and reported, never terminated by process name |

The normal run also captures a 1000-pixel-wide screenshot. It checks layout only: at that width the Runtime controls are hidden (see [limitations](limitations.md)).

## CI

`.github/workflows/ci.yml` runs on pull requests and on pushes to `main`, all on `windows-latest`:

| Job | Steps |
| --- | --- |
| `frontend` | Locked install, `pnpm lint`, `pnpm test:unit`, runtime-safety and IPC client node tests |
| `core` | Core library and contract tests (Stop, recovery, handoff, workspace identity and more), selected registration cases, launcher tests, Tauri host tests |
| `desktop` | `pnpm test:desktop`, a fresh Electron package build and verify, normal and synthetic packaged smoke, early-failure cleanup; failure summaries are redacted and kept for 7 days |

A local run is not a remote CI result.

## Live and historical verification

Live Runtime admission, long soak runs and GUI evidence drivers (`pnpm verify:*`, `scripts/connected/v1-*.mjs`) are separate, explicit workflows. They are not part of the checks above or of CI. A live Runtime probe needs `--live` plus a synthetic fixture folder created for that probe, and it redacts its output. The original fail-closed gate design is documented in [verification gates](reference/verification-gates.md) and the [validation matrix](reference/validation-matrix.md).
