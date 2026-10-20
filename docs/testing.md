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
cargo test --locked -p goalport-core --test goal_scope --test grok_acp --test ipc_lifecycle --test claude_stop_broker
cargo test --locked -p goalport-core-launcher
```

| Command | Covers |
| --- | --- |
| `pnpm lint` | TypeScript project build (`tsc -b`) |
| `pnpm test:unit` | Renderer and IPC client tests (Vitest) |
| `pnpm test:desktop` | Packaging, launch configuration, diagnostics, owned-Core cleanup, CDP helpers, the offline driver units (`background-native`, `feedback-native`, `plan-revision-native`), and the documentation contract (`scripts/desktop/docs-ci.test.mjs`) |
| `cargo test -p goalport-core` | Core library tests and the integration tests CI runs (`crates/goalport-core/tests/`; CI also runs selected `registration_generation` cases) |
| `cargo test -p goalport-core --test goal_scope --test grok_acp --test ipc_lifecycle --test claude_stop_broker` | The deterministic Core contract tranche added to the ordinary `core` job (see [deterministic coverage](#deterministic-contract-coverage)) |
| `cargo test -p goalport-core-launcher` | Launcher behavior |

`docs-ci.test.mjs` also checks this documentation. The README must show the `package.json` version and the Stable V1 RC status, every documented `pnpm` script must exist, and every relative link and image in the README and `docs/` must resolve with exact file-name case. It also pins the CI coverage contract below: the ordinary `core` whitelist must keep the deterministic tranche and its `$LASTEXITCODE` guard, must not whitelist the excluded red suites, and `test:desktop` must keep the offline driver unit files while never running a driver (the Linux `background-native.mjs` included).

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
| `core` | Core library and contract tests (Stop, recovery, handoff, workspace identity and more), the deterministic `goal_scope`/`grok_acp`/`ipc_lifecycle`/`claude_stop_broker` tranche, selected registration cases, launcher tests, Tauri host tests |
| `desktop` | `pnpm test:desktop` (which includes the `background-native`, `feedback-native` and `plan-revision-native` driver units), a fresh Electron package build and verify, normal and synthetic packaged smoke, early-failure cleanup; failure summaries are redacted and kept for 7 days |

A local run is not a remote CI result.

## Deterministic contract coverage

Ordinary CI runs only suites that pass locally with real executed tests. A red suite is never added, and no assertion inside one is skipped, filtered or relaxed to make it green. The `core` step scrubs inherited `GOALPORT_*` before the first `cargo` command and exits on the first nonzero `$LASTEXITCODE`.

The Node pin matters for the JavaScript suites: several offline fixture checks compare the summary text a child `node --test` prints, and that format changed after Node 22 (`# fail 2` became `ℹ fail 2`). The checks in the ordinary-CI tranche accept both prefixes while still asserting the failure count; CI pins Node 22.19.0.

| Suite | Command | Runs in | Why |
| --- | --- | --- | --- |
| `goal_scope` | `cargo test --locked -p goalport-core --test goal_scope` | ordinary CI (`core` job) and local | 3 hermetic tests |
| `grok_acp` | `cargo test --locked -p goalport-core --test grok_acp` | ordinary CI (`core` job) and local | 23 hermetic tests over the offline ACP peer |
| `ipc_lifecycle` | `cargo test --locked -p goalport-core --test ipc_lifecycle` | ordinary CI (`core` job) and local | 10 hermetic tests |
| `claude_stop_broker` | `cargo test --locked -p goalport-core --test claude_stop_broker` | ordinary CI (`core` job) and local | 8 hermetic tests; own child cleanup |
| `claude_stream` | `cargo test --locked -p goalport-core --test claude_stream` | opt-in local only | Excluded: one real product assertion fails (`native_stop_exact_input_and_reordered_receipt_keep_residual_held`). It is a defect to fix, not a test to weaken |
| `admission_failure` | `cargo test --locked -p goalport-core --test admission_failure` | opt-in local only | Excluded: `m3_a_codex_registration_that_never_started_is_withdrawable` looks for an external `app-server` binary, so it is not hermetic |
| `recovery_classification` | `cargo test --locked -p goalport-core --test recovery_classification` | opt-in local only | Excluded: four tests, then a live-server probe times out after 60 s. Not deterministic |
| `background-native` units | `node --test scripts/acceptance/background-native.test.mjs` (part of `pnpm test:desktop`) | ordinary CI (`desktop` job) and local | 3 tests over the driver, validator and report predicates. They assert driver behavior and never parse a child `node --test` summary, so the CI Node version cannot change their result. The Linux-only driver `scripts/acceptance/background-native.mjs` is never run in CI |
| `feedback-native` units | `node --test scripts/acceptance/feedback-native.test.mjs` (part of `pnpm test:desktop`) | ordinary CI (`desktop` job) and local | 6 tests. The fixture check accepts `#`, `ℹ` or `info` in the child summary and still asserts exactly 2 failures, so the same assertions pass on Node 22 and 25 |
| `plan-revision-native` units | `node --test scripts/acceptance/plan-revision-native.test.mjs` (part of `pnpm test:desktop`) | ordinary CI (`desktop` job) and local | 7 tests, run in ordinary CI as part of `pnpm test:desktop`; the fixture check accepts `#`, `ℹ` or `info` runner-format text |
| `windows-packaged-journey` and `windows-stalled-peer` units | `node --test scripts/acceptance/windows-packaged-journey.test.mjs scripts/acceptance/windows-stalled-peer.test.mjs` (part of `pnpm test:desktop`) | ordinary CI (`desktop` job) and local | 19 journey decision/CLI tests and 13 stalled-peer verdict/wiring tests; no package or Core is launched |
| `execute-native` and `execution-fixture` units | `node --test scripts/acceptance/execute-native.test.mjs scripts/acceptance/lib/execution-fixture.test.mjs` | ordinary CI (`desktop` job) and local | Already accept both reporter formats (`#`, `ℹ` or `info`) in the same check |

Nothing above establishes native Runtime admission, Windows IME, real CLI confinement or Stable V1. Package-building, driver and synthetic checks are separate evidence from a live or packaged journey.

## Live and historical verification

Live Runtime admission, long soak runs and GUI evidence drivers (`pnpm verify:*`, `scripts/connected/v1-*.mjs`) are separate, explicit workflows. They are not part of the checks above or of CI. A live Runtime probe needs `--live` plus a synthetic fixture folder created for that probe, and it redacts its output. The original fail-closed gate design is documented in [verification gates](reference/verification-gates.md) and the [validation matrix](reference/validation-matrix.md).

## Linux and interactive preview checks

The Linux CI job runs subprocess protocol peers for provider errors, approvals,
session close, stalled initialization, concurrent clients and independent titles.
It also exercises the Unix client and verifier cleanup without accessing a vendor
account:

```sh
cargo test --locked -p goalport-core -p goalport-core-launcher
python3 -B -m unittest discover -s scripts/connected -p 'test_*.py'
pnpm build
node scripts/preview/acceptance.mjs --out goal-runs/ui-check
```

The preview walk captures first use, both Runtime picker entries, keyboard
selection, drafts during refresh, permission decisions, the close dialog, a
completed-result excerpt and a quota failure at 560, 1024 and 1440px. Inspect the
PNG files as well as the machine checks. The preview does not establish Windows
IME, native system notifications, packaging, or real Runtime execution.

Use the opt-in [native Linux task driver](linux-development.md#native-acceptance)
for actual Codex acceptance. Windows ZIP packaging tests must run on Windows;
PowerShell cannot consume the Linux temporary paths used by a Linux test process.

## Continuation (one in-window repair) acceptance

The offline real-app continuation driver proves the C1 boundary — one Send may
run a second four-role chain after a completed `VERDICT: revise` audit — without
any real vendor CLI or model:

```sh
pnpm build && cargo build -p goalport-core
pnpm test:acceptance-feedback
pnpm acceptance:feedback-native --out goal-runs/<run>/evidence/continuation-c1-r1
```

The driver launches the real Electron main/preload, built renderer and Core with
both sentinel-controlled offline stub processes, then:

- **C1** — the user authorizes six read turns and two write turns and sends once;
  the first writer leaves a genuinely incomplete edit while its CLI turn completes
  honestly, a separate read-only Node checker observes the failing unchanged tests
  and returns `VERDICT: revise`, and the app runs the corrective chain (fresh
  command IDs, same scope generation) until a second separate checker verifies.
  It then closes and relaunches with a fresh process/socket/temp against the same
  durable records and ledger: reopened evidence only, null scope, no added turns,
  write consent OFF.
- **C2** — the unchanged default of four read turns runs the first chain and stops
  with the explained budget refusal; no fifth turn is launched and the intermediate
  edit stays on disk.

Screenshots are captured at 860, 1020 and 1440 px for consent, corrective
progress, verified, budget-stop and reopened-history states; inspect the PNGs and
`walkthrough.md` yourself. Failed subprocess checks are feedback in these fixtures;
a failed CLI turn stays terminal. This does not establish Windows behavior, real
CLI confinement or independent-model judgment.

## C2 background close-and-return acceptance

Build with `pnpm build` (renderer plus the same engine as `dist/coordination-engine.cjs`) and `cargo build -p goalport-core`. Run `pnpm test:acceptance-background` for job/worker/host/driver checks and `pnpm test:unit` for renderer interactions. Offline package staging explicitly includes the worker, job store, background bridge, read-only Core coverage guard, verified Core client and engine bundle; no Windows packaging is needed to check completeness.

Use `pnpm acceptance:background-native --out goal-runs/goalport-execute-and-native-acceptance/evidence/continuation-c2-<fresh-id>` on Linux with a display. The isolated sentinel-shadowed driver closes the actual desktop before a writer, keeps its identity-matched live Core/temporary fixture, and reopens only the UI against those same identities. BG1 completes the failed-check critique and one repair (six read/two write turns), BG2 revokes after return before a later writer, and BG3 terminates only the owned worker during an admitted turn. Process/main/renderer exit times, job and pending identities, command claims, ledger/grants, immutable test/source bytes, separate checker evidence, DOM facts and native-size screenshots at 860/1020/1440 px are retained. Driver cleanup is not a product tool-stop claim.

Ordinary Sends remain window-bound and the existing C1 driver is unchanged: protect it with `pnpm test:acceptance-feedback` and `pnpm acceptance:feedback-native --out <fresh continuation-c2-c1-regression directory>`. History restores reports, never permission. A background job is one live admission, not a restart/resume service; unreachable control stays unconfirmed and non-retryable. No real model/vendor CLI, Windows, paid API, login, push or full-GAH claim is part of this run.

The worker checks the current selected snapshot and the existing `goal_overview`/`goal_detail` read projections before every turn and before repair. Detail reads restore the shared selection; they issue no selection/authority command. Truncated overview, failed detail, hidden held responsibility or native conflict refuses the launch. Negative worker fixtures include a hold/native conflict outside a blank selected view and a new hold appearing at the repair boundary.

## C4 plan-revision (one pre-write revision) acceptance

The offline real-app plan-revision driver proves the C4 boundary — one Send may
run one revised chain after its independent **plan check** returned
`VERDICT: revise`, before any writer launched — without any real vendor CLI or
model:

```sh
pnpm build && cargo build -p goalport-core
pnpm test:acceptance-plan-revision
pnpm acceptance:plan-revision-native --out goal-runs/<run>/evidence/continuation-c4-<fresh-id>
```

The driver launches the real Electron main/preload, built renderer and Core with
both sentinel-controlled offline stub processes, then:

- **PR1** — the user authorizes five read turns and one write turn and sends once;
  the first plan is genuinely flawed in one named way (it covers only positive
  inputs and names no check), a separate read-only Node plan checker reads the
  unchanged pinned tests, names that exact missing requirement and returns
  `VERDICT: revise`; the app writes one revised plan that answers it, a fresh
  independent check approves, only then does the real writer repair the fixture,
  and a second separate read-only checker verifies. Six fresh command IDs, one
  authorization, and the rejected pass folded under **Before plan revision**. It
  then closes and relaunches against the same durable records: reopened evidence
  only, null scope, write consent OFF.
- **PR2** — the unchanged default of four read turns runs the rejected pass and
  stops with the explained budget refusal (the revised chain needs three more
  model turns and one write turn); no third turn launches and the fixture bytes
  stay unchanged.
- **PR3** — the revised reviewer again returns `VERDICT: revise`: exactly four
  read turns, zero writes, no third planning pass, and the one-revision ceiling
  sentence with the rejected pass retained.
- **PR4** — the same journey as an explicitly admitted background job: the desktop
  closes while the initial critique is still in flight (before the revised planner
  launched), the same worker continues the revision, repair and verification on its
  own, and returning shows the retained verified result without another Send or
  authorization.

Screenshots are captured at 860, 1020 and 1440 px for consent (which explains the
plan revision distinctly from the later repair), critique, revision progress,
verified, budget-stop, second-rejection and reopened-history states; inspect the
PNGs and `walkthrough.md` yourself. The plan critique, the revised-review approval
and the final auditor are closed offline fixture behaviors and separate read-only
Node processes over a disposable fixture: real filesystem/subprocess evidence,
**not independent-model judgment**. This does not establish Windows behavior,
real CLI confinement or a general revision loop; full GAH is not claimed.
