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
  --coordination-data "$HOME/.goalport/linux-coordinate" \
  --database /tmp/goalport-dev/core.sqlite
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

$CLI $GLOBAL discover --workspace "$PWD"
# Copy the exact configured offer from discovery; these are example identifiers.
PI_CAPACITY='{"provider":"your-configured-provider","model":"your-exact-model","useExistingCapacity":true}'
$CLI $GLOBAL grant-access      # durable background harness access, not billing proof
$CLI $GLOBAL revoke-access     # withdraw that consent; existing jobs keep their honesty state
$CLI $GLOBAL run --goal 'Plan the failing check' --workspace "$PWD" \
  --instances codex,pi --pi-capacity "$PI_CAPACITY" --turns 4 --background
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

Pi offers one bounded configured requested pair: the first raw enabled-model
entry must match the offline catalog exactly (literal colon model IDs win before
stripping one recognized reasoning suffix). An unresolved/wildcard/unqualified
first entry is unavailable, not skipped. With no scope, an exact saved pair may
be offered; native automatic/auth-dependent fallback is not reproduced.
Reasoning remains managed by Pi, not pinned by this descriptor. Discovery before
a folder is provisional; changing folders rechecks it without a model prompt.
Discovery and each fresh bound Pi turn use the same install/CWD/environment and
`--offline --no-extensions --no-mcp --no-skills --no-context-files -na --list-models`.
The six-column table is strictly parsed, case-exact and bounded (256 KiB stdout,
16 KiB private stderr, 8 seconds). Each fresh turn adds one offline metadata
process before its claim, then requests exact `--provider`/`--model`; a valid
stored claim performs no subprocess or replay. Requested identity is not
wire/server identity, authentication, billing, quota or a native session handle.
External configuration changes between the check and native resolution remain
an explicit limitation; no config locks, auth checks or fallback model calls
are added. Malformed saved route metadata keeps the result visible but disables
its Continue; a malformed prior admission still refuses all new jobs in the
profile under the existing strict policy, without migration or repair.

Honesty rules the client keeps:

- `--background` is required for `run` and `continue` and is never defaulted;
  the durable grant (`grant-access`) is a separate profile capability. Without
  the flag the client prints `Keep working after closing must be explicitly
  selected.`; without the grant it prints `Background Send is not ready in this
  GoalPort window yet.` Ambient `GOALPORT_COORDINATE_SEND`,
  `GOALPORT_HARNESS_CHECKOUT` and `GOALPORT_HARNESS_SERVER_CWD` are ignored and
  stripped before the host or the detached worker sees an environment.
- Linux Pi is deliberately not auto-selected, including OAuth or mixed installs.
  Its billing is **not confirmed**; credential kind is not a billing mode. A new
  Pi goal requires the exact configured `--pi-capacity` descriptor and literal
  `useExistingCapacity:true`. This expresses use of existing authorized capacity,
  not a purchase, dollar ceiling, quota measurement or write permission. Other
  harness membership rules are unchanged. Continue derives Pi's route from the
  unique selected result's own admission, not from today's default; route edits
  refuse. A server-verified legacy Continue remains explicitly unpinned (known
  API-key-only legacy eligibility is still refused, using the existing type-only
  credential classifier summary, not an inferred billing mode). No renderer legacy flag can
  enable a fresh route-less Pi goal.
- A request that was left unreplayed cannot be continued or started again
  with the same request id. The CLI and the workbench refuse with
  `The interrupted job stays unreplayed; the same request id cannot be admitted again.`
  If that job still holds the admission slot, a direct CLI run says to
  acknowledge it first: `A left job still holds the admission slot. Run acknowledge before starting another, so nothing was admitted.`
  The workbench keeps New goal and Continue disabled while that slot is held.
  Its existing Leave it unreplayed action applies to the current job, not to
  a different saved result being read. The page does not ask the user to run
  a shell command.
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
  write turn. Pi stays read-only with `--no-tools`, `--no-mcp`, `--no-skills`,
  `--no-context-files`, and `--no-session`. It inspects the approved plan,
  executor report, and captured workspace diff read-only; it does not run machine
  test commands. Without that write opt-in, the round is planning and review only.
- Workspace changes vs. Executor report: GoalPort captures bounded read-only Git
  evidence before and after write turns (`git diff --no-ext-diff --no-textconv HEAD -- .`).
  NUL-framed status paths are converted from the real Git root to the authorized
  workspace, including subdirectory and ordinary Unicode names. Before/after
  untracked text is retained as well as tracked diffs; the UI shows that content.
  Untracked reads reject linked path components, use `O_NOFOLLOW` where Node
  supports it, and validate the opened descriptor against the ordinary in-bound
  object before reading. Binary, skipped, truncated, omitted or failed reads are
  incomplete/unknown coverage, never proof of unchanged bytes. Capture limits
  remain 64 KiB per tracked diff, 32 retained untracked paths and 8 KiB per text
  file; excess paths are counted rather than emitted without bound. What the
  model outputs is an "Executor report" (not an independently captured diff).
- Audit input: on Linux, a background-worker final read-only Pi audit uses piped stdin, with a
  32768-byte COMPLETE UTF-8 prompt budget and 16384-byte evidence reservation.
  That includes goal, plan, review, reports, prior feedback/metadata and evidence.
  Material that fits is preserved in full; overflow uses labeled crop notices.
  The worker derives this capability in memory; there is no transport setting
  or admission/grant field. Every replacement derives its own transport: other
  audit harnesses, Windows Pi and callers without the capability keep the legacy
  4096-byte complete prompt / 2048-byte evidence reservation and conservative
  Windows `.cmd` limit (six times prompt bytes plus 4096 fixed-argv characters).
  Plan/review/execute have not acquired a new 4096-byte cap.
- The Linux Pi runtime independently requires the canonical audit command ID,
  Pi instance, actual Linux platform, readOnly sandbox, explicit stdin selector
  and at most 32768 UTF-8 bytes before claiming a turn. Isolation flags remain
  `-p --no-session --no-context-files --no-extensions --no-mcp --no-skills -na
  --no-tools --mode text`. The body is written once with EOF, never copied into
  argv, an `@file`, a shell or a temporary prompt file. An input failure after
  child creation is unknown: charge/claim remain, there is no replay, refund,
  restored grant or argv/provider fallback. Only a proven no-child spawn failure
  remains not-sent. Existing Stop and timeout still own the registered child.
- `coverage.promptBytes` counts the actual COMPLETE assembled prompt, not just
  evidence. Optional `coverage.promptDelivery` describes the selected transport;
  stdin coverage omits hypothetical Windows command size. Optional runtime
  `auditInputTransport` in completed-command (or unconfirmed pending) facts records
  Pi/stdin, actual host input bytes and successful stream end. Stream end is not
  proof of model consumption: Pi 1.4's piped reader trims edge whitespace before
  building the initial message. These are not billed-token counts or a full
  provider-wire capture. GoalPort retains the full bounded capture separately
  from its exact host-delivered evidence subset. The existing details show both,
  including incomplete/binary/skipped material. Uncropped transport does not
  turn an incomplete capture into full workspace coverage. Older records omit
  transport fields and remain readable. This does not claim Pi ran machine tests.
- Stopping a goal: `stop` durably revokes further turns for the admission. It
  does not undo or rollback workspace modifications already written (existing
  workspace edits remain).
- Retained product follow-ups (not completed, not owner restrictions):
  1. Commercial API billing and usage remain unmeasured. Pi's explicit configured
     route is a bounded requested-capacity integration, not all-API completion;
     other harnesses retain their existing membership rules.
  2. Coordinated-goal native session recovery: coordination turns currently run
     with Codex `--ephemeral` and Pi `--no-session`; association with Core native
     session recovery remains a retained follow-up.
  3. Scope vs. consent reuse: continuing a goal reuses durable profile consent,
     while each continuation turn mints a fresh request ID and scope generation;
     live cross-continue budget/generation reuse remains a follow-up.

## Returning to a coordinated goal

The workbench lists one entry per validated coordinated goal, with its original
title, folder and outcome. Clicking an entry opens that goal's latest saved
result; Earlier results selects an exact older result in the same compact area.
Legacy records without a continuation descriptor remain independent entries,
even when their titles and folders match. Invalid relationships remain readable
but cannot Continue; duplicate identities and tied latest results are not guessed.
No record migration or historical relinking is performed.

The exact selected result lives in `#coordinated/result/<requestId>`; a fresh draft
uses `#coordinated/new`. Refresh, back and forward keep this selection, not the
profile's newest result. A missing, malformed or ambiguous address stays
unavailable instead of falling back to another goal or a new Start. Core campaign
addresses remain separate; explicitly opening a Core goal leaves the coordinated
fragment.

The workbench keeps the saved result visible and presents a compact follow-up
composer with one **Continue** action. A non-empty follow-up can be sent with
Enter; an empty follow-up continues the existing goal only when Continue is
explicitly clicked. **New goal** opens a fresh draft with background and file
changes off.

A newer result from another window does not replace a pinned result: the page
shows Newer result available and disables Continue until you explicitly open
that result and click again. The CLI rechecks the exact selected ID and latest
result within its validated goal before admission; it never substitutes the
profile latest. `continue --from ID --goal TEXT` treats TEXT as the follow-up,
not a new original goal. Omit `--goal` for an empty follow-up. The selected
record supplies the folder; a different `--workspace` override is refused.
The derived original goal, follow-up and previous plan/check/report/audit are
actual planning input. New children store the original goal plus a separate
closed continuation descriptor. Continuations refuse combined goal/follow-up
over 100,000 JS string characters or an actually assembled role prompt over
100,000 UTF-8 bytes before sending that role; earlier sent results remain.
The audit's separate transport limit (32768 bytes for eligible Linux Pi stdin,
4096 bytes for legacy argv) and visible crop notices still apply.
These are product transport limits, not claims about all OS argv limits.

For a settled goal, the page initializes background/file-change options from
that viewed request's own saved admission when its choices are not dirty. These are remembered choices,
not a new spending grant, remaining quota or a restored live turn budget. A
read-only stopped follow-up does not inherit a parent round's write choice,
even when it displays that parent's saved diff. While work is running or its
exit is unknown, historical options are hidden rather than presented as current
permissions. Existing consent, available-agent, workspace and live-scope checks
still apply when Continue is clicked. Unsent follow-up text and dirty choices
survive A→B→A navigation in the resident page and are shared by earlier results
within A. The URL preserves selection across reload; unsent text is not promised
across a browser/process restart. Refused, lost or unconfirmed admission replies
retain text and choices; HTTP success alone does not count as admission.

Current work is separate from the selected saved result. While B is running,
revoked-but-current, unknown or held, A remains readable and labeled Saved result;
New goal and Continue are disabled with the current-work reason. The compact
current-work strip names B when its admission identity is known. Its Stop/Leave
actions target B's actual job, never A. With no provable identity the strip says
Current work — not confirmed and does not invent a named Stop target. Viewing
B's root shows Previous result alongside the current-work strip. B finishing
never selects B over A or overwrites A's draft/options. Only a locally confirmed
admission can advance its own selected view when its new saved result arrives.

Stopping prevents later turns; a current turn may still finish. Saved changes
and their check material remain visible after returning, including through
repeated stopped follow-ups. This does not undo files or prove every Linux
child process has exited.

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
