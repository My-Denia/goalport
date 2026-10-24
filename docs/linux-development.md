# Linux Core development

The Linux entry runs the same Core and provider protocol used by the desktop.
It includes a thin operator client; it is not a separate terminal application or
a packaged Linux desktop. The Electron distribution remains Windows x64.

Build Core and its launcher, then choose a fresh directory for development data:

```sh
cargo build --locked -p goalport-core -p goalport-core-launcher
mkdir -p /tmp/goalport-dev
target/debug/goalport-core-launcher "$PWD/target/debug/goalport-core" serve \
  --pipe /tmp/goalport-dev/core.sock --db /tmp/goalport-dev/core.sqlite
python3 scripts/connected/unix-client.py --endpoint /tmp/goalport-dev/core.sock diagnose
```

The launcher verifies that Core is ready and exits; Core keeps running. Existing
endpoints and databases are checked before reuse. Use an existing workspace and
an installed, signed-in Runtime. The client's global options go before its
command:

```sh
python3 scripts/connected/unix-client.py --endpoint /tmp/goalport-dev/core.sock \
  new --workspace /path/to/workspace --runtime codex --message 'Fix the failing test'
python3 scripts/connected/unix-client.py --endpoint /tmp/goalport-dev/core.sock diagnose
python3 scripts/connected/unix-client.py --endpoint /tmp/goalport-dev/core.sock watch
```

Responses include the goal's `campaignId` and the current `attemptId`. Diagnostics
show the selected Runtime, session and turn state, whether Send and Stop are
available, reasons, possible actions, pending permissions, and recent messages.
Use those returned identities in subsequent commands:

```sh
python3 scripts/connected/unix-client.py --endpoint /tmp/goalport-dev/core.sock \
  send --campaign CAMPAIGN_ID --message 'Explain what changed'
python3 scripts/connected/unix-client.py --endpoint /tmp/goalport-dev/core.sock \
  decision --decision DECISION_ID --allow
python3 scripts/connected/unix-client.py --endpoint /tmp/goalport-dev/core.sock \
  stop --attempt ATTEMPT_ID
python3 scripts/connected/unix-client.py --endpoint /tmp/goalport-dev/core.sock \
  close-session --attempt ATTEMPT_ID
python3 scripts/connected/unix-client.py --endpoint /tmp/goalport-dev/core.sock \
  resume --attempt ATTEMPT_ID
```

`decision --deny` explicitly declines. `stop` interrupts the current turn;
`close-session` asks Core to end an idle Runtime session when its current facts
permit that action. Closing the client does neither. `resume` is an explicit
request against an existing session and may be refused when recovery is not
supported. After Core restarts, a settled Codex session offers this action;
sending is disabled until the saved session is attached. Failed or unknown
delivery is not replayed. `select`, `runtime`, and `rename` have help via `COMMAND --help`.

`overview` lists every goal's status and pending approvals. `detail --campaign CAMPAIGN_ID` reads that goal. Neither command changes which goal another client is viewing. `select` still updates the shared single-window selection; use it only when one client owns the screen.

## Workbench

The same renderer can talk to this Core through a local bridge. The bridge is a development entry, not a Linux package: no installer, tray, or remote listener. It serves the built page on `127.0.0.1` and forwards each POST to the Unix socket. It does not keep a session or a database. If the socket is down, the page shows disconnected and does not fall back to sample data.

```sh
pnpm build
python3 scripts/connected/linux-workbench.py --endpoint /tmp/goalport-dev/core.sock \
  --core-binary "$PWD/target/debug/goalport-core" \
  --coordination-data "$HOME/.goalport/linux-coordinate"
```

Open `http://127.0.0.1:4173`. The bridge accepts that host only. A browser POST must use `application/json` and the page's own origin; another site cannot use a simple `text/plain` POST to reach Core. Type a workspace path in the new-goal form. Send stays off until Keep working after closing is selected. Switching goals and reading another goal from `detail` are independent.

Every operation goes through the production v2 protocol and Core's existing
permission and delivery rules. A timeout after sending a mutation means its
delivery is unknown. The client prints the request ID and never retries it
automatically. Read diagnostics and reconcile before deciding what to do next.
`watch` echoes Core's opaque revision; unchanged polls return a small response without retransmitting the conversation. `--timeout` sets a whole-exchange deadline. `command TYPE --payload-file file.json`
is available for the same production commands, without bypassing validation.

## Coordinated goals

The operator client `scripts/connected/linux-coordinate.mjs` runs the same
coordination stack as the desktop window: the detached worker is
`electron/coordination-worker.cjs` and the plan/review scheduler is
`dist/coordination-engine.cjs`, built from the renderer's own
`src/coordination/requestCoordination.ts`. It is not a second scheduler or a
budget authority, and it never starts or recovers Core. Build the engine bundle
before admitting a goal; the client refuses before writing anything when it is
missing:

```sh
pnpm install --frozen-lockfile
pnpm build   # or: vite build --config vite.coordination.config.ts
```

Start Core with the launcher, keeping the absolute socket and database paths.
The admission check compares the Core startup receipt against the resolved
socket path, the executable hash and the database path, so pass the same
absolute `--pipe`/`--db` here:

```sh
target/debug/goalport-core-launcher "$PWD/target/debug/goalport-core" serve \
  --pipe /tmp/goalport-dev/core.sock --db /tmp/goalport-dev/core.sqlite
```

Then, from the repository root:

```sh
CLI="node scripts/connected/linux-coordinate.mjs"
GLOBAL="--data-dir /tmp/goalport-dev --pipe /tmp/goalport-dev/core.sock --core-binary $PWD/target/debug/goalport-core"

$CLI $GLOBAL discover
$CLI $GLOBAL grant-access      # durable consent to spend subscription quota
$CLI $GLOBAL revoke-access     # withdraw that consent; existing jobs keep their honesty state
$CLI $GLOBAL run --goal 'Plan the failing check' --workspace "$PWD" \
  --instances codex,claude --turns 4 --background
$CLI $GLOBAL status --job JOB_ID
$CLI $GLOBAL result --request-id REQUEST_ID
$CLI $GLOBAL continue --from REQUEST_ID --goal 'Revise the plan' --background
$CLI $GLOBAL stop --job JOB_ID
$CLI $GLOBAL acknowledge --job JOB_ID   # leave an interrupted job, never replayed
$CLI $GLOBAL release --job JOB_ID       # free the profile slot after a confirmed finish
```

`--database` defaults to `<data-dir>/core.sqlite`, and `status`/`stop`/
`acknowledge`/`release` default `--job` to the active or newest job. `discover`
prints installed and authenticated harnesses with their auth type, model list
and recorded environment health. An empty list says no signed-in subscription
harness was found; it does not say nothing is installed. Consent and capability are separate lines:
granting access never claims a harness is signed in, and a signed-in harness
never grants access to spend quota.

Honesty rules the client keeps:

- `--background` is required for `run` and `continue` and is never defaulted;
  the durable grant (`grant-access`) is a separate profile capability. Without
  the flag the client prints `Keep working after closing must be explicitly
  selected.`; without the grant it prints `Background Send is not ready in this
  GoalPort window yet.` Ambient `GOALPORT_COORDINATE_SEND`,
  `GOALPORT_HARNESS_CHECKOUT` and `GOALPORT_HARNESS_SERVER_CWD` are ignored and
  stripped before the host or the detached worker sees an environment.
- Only harnesses signed in with their own subscription can be authorized. An
  apiKey login, or a sign-in whose type is missing or unknown, is refused with
  `Only harnesses signed in with their own subscription can be authorized.`
  and is not auto-selected. Naming it with `--instances` still uses it; that
  does not make the sign-in a confirmed subscription. Omitting `--instances`
  selects only confirmed subscription logins.
- A request that was left unreplayed cannot be continued or started again
  with the same request id. The CLI and the workbench refuse with
  `The interrupted job stays unreplayed; the same request id cannot be admitted again.`
  If that job still holds the admission slot, a direct CLI run says to
  acknowledge it first: `A left job still holds the admission slot. Run acknowledge before starting another, so nothing was admitted.`
  The workbench page releases that pointer before a new send, so the page does
  not ask the user to run the command.
- File changes are not implied by `--background` or by a read goal. Pass both
  `--write-instances` and `--write-turns` to opt into the existing write
  authorization. One confirmed subscription harness still cannot review itself:
  the goal stops with `Stopped. An independent check needs a second logged-in
  harness, so no second role was assigned.` and no workspace write is sent.
- A lost start reply stays `unconfirmed`. The admitted job keeps its durable
  slot and is not spawned again; `status` keeps printing `unconfirmed`.
  `acknowledge` is how you leave that job without replaying it, and its request
  id can then never be admitted again. An unknown quota is printed as `unknown`,
  never as a subscription guarantee.
- `stop` prints the stored projection verbatim. When the live control socket is
  unreachable it records the durable revoke and prints `state: unconfirmed`
  with `revoked: true`; it never prints `stopped` for those, and the turn is
  not replayed. A worker that is still alive settles its own terminal outcome
  later.
- This stack has no process-group kill on Linux. A forced timeout kills only
  the direct harness CLI child (SIGKILL), so tools that child already started,
  and its grandchildren, are not proven quiescent. The workbench checkbox and
  the CLI flags `--write-instances codex --write-turns 1` opt into one Codex
  write turn. Pi stays read-only. Without that opt-in, the round is planning
  and review only.

## Native acceptance

The opt-in driver creates a disposable repository with a broken addition
function. It starts Core through the launcher, asks the installed Codex to fix
the implementation and run tests, verifies the original tests independently,
and requests a second turn. It uses the existing CLI login and normal allowance:

```sh
python3 -B scripts/connected/verify-linux-native.py \
  --out goal-runs/native-check --allow-live
```

Add `--resume-check` to restart Core after the completed second turn, explicitly resume the saved native session, and send a third read-only follow-up. The driver checks that restart/resume did not replay the old task.

Use a new output directory for each run. If a permission is requested, inspect
the printed decision and use the operator client's `decision` command; the
driver does not auto-approve. It saves the implementation diff, test output,
protocol exchanges and diagnostics, then stops its own process group. It keeps
the scratch files for inspection. Login, quota or transport failures remain
failed acceptance; the driver never substitutes Scenario output.

Ordinary automated tests use local subprocess protocol peers and make no vendor
calls. Native acceptance proves the installed Runtime and tested workload, not
all providers, CLI versions or Windows desktop behavior.
