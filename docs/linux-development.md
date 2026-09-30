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

Every operation goes through the production v2 protocol and Core's existing
permission and delivery rules. A timeout after sending a mutation means its
delivery is unknown. The client prints the request ID and never retries it
automatically. Read diagnostics and reconcile before deciding what to do next.
`watch` echoes Core's opaque revision; unchanged polls return a small response without retransmitting the conversation. `--timeout` sets a whole-exchange deadline. `command TYPE --payload-file file.json`
is available for the same production commands, without bypassing validation.

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
