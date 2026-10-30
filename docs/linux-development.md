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

Open `http://127.0.0.1:4173`. The bridge accepts that host only. A browser POST must use `application/json` and the page's own origin; another site cannot use a simple `text/plain` POST to reach Core. New goal defaults to **Coordinated work**. Its Send stays off until Keep working after closing and its harness choices are ready. A qualified Core also offers **Codex conversation**, described below; that mode does not require Pi or Background Send consent. Switching goals and reading another goal from `detail` are independent.

Every operation goes through the production v2 protocol and Core's existing
permission and delivery rules. A timeout after sending a mutation means its
delivery is unknown. The client prints the request ID and never retries it
automatically. Read diagnostics and reconcile before deciding what to do next.
`watch` echoes Core's opaque revision; unchanged polls return a small response without retransmitting the conversation. `--timeout` sets a whole-exchange deadline. `command TYPE --payload-file file.json`
is available for the same production commands, without bypassing validation.

## Native Codex conversations in the workbench

New goal offers exactly two modes when Core advertises the configured Codex
app-server adapter: Coordinated work (the default) and Codex conversation.
Older Core builds, exec configuration or unknown transport do not offer a new
Codex conversation; existing goals remain readable. This advertisement confirms
an adapter kind, not sign-in, quota, billing, an effective model or verified
provider capabilities.

Choosing Codex is local draft intent (`/#codex/new`), not a session start.
Enter an existing absolute folder such as `/path/to/project`. Empty, relative,
`~` and `~/project` paths are refused before native dispatch with:
`Codex conversations need an absolute folder path, for example /path/to/project.`
Coordinated work keeps its existing home-folder expansion.

The native first send uses the existing Core `start_conversation` with literal
`requireNativeSession:true`. Core freezes the complete Runtime binding once,
before new rows/reservations/session creation, and consumes it in the factory.
A constrained start cannot fall back to one-shot exec. Absent constraint retains
legacy hashing and behavior; false, null and nonboolean constraints are invalid.
The same recorded request is not sent again. An ambiguous response keeps the
draft's stable request for explicit result reconciliation, not automatic replay.

### A refused send is not an unknown send

For `start_conversation` and `conversation_send` only, a workbench refusal
**before entering the mutating Core call** returns a correlated v2 HTTP200
failure with `refusalSource:"workbench-native-preflight"`. Both request IDs and
the method must match; its raw rejection is
`FAILED / NOT_STARTED / NEW_REQUEST / reservation:null`. The Linux client
validates this shape before normalization. Text saying “Nothing was sent”,
HTTP200 alone, malformed/missing metadata and old-server responses are not proof.
The response makes no connection claim and invents no Core snapshot. Real Core
connection state still comes from independent snapshot reads.

A first, previously unretained submission then says **Nothing was sent.** with
one folder, target or workspace-check explanation. The message/folder stay in
an ordinary editable draft; mode choice and Discard work without sending
anything. Correcting the draft does not submit it: only a later explicit Send
uses a fresh request ID. Technical details, when supplied, stay folded and are
control-clean and at most 2048 UTF-8 bytes; helper output is not a headline.

A later refusal proves only that *this invocation* did not forward. Any earlier
unknown request or same-request reservation keeps its original identity,
message, target and reservation, with the existing Check result/Retry behavior.
Repeated Submit while awaiting a result does not send or classify again. A
retained `sending` state without an in-flight call moves to same-ID
reconciliation without a network request. Authoritative Core outcomes retain
their existing settlement semantics, including clearing an unreserved,
confirmed-not-started rejection. Other native commands retain their previous
preflight and Core-refused notice behavior. No automatic retry, permission,
held-folder release, new session or budget is implied.

This fixes the false unknown state after a first local refusal, not the full
genuine-unknown escape flow or stricter cross-folder gating. Existing
conversation drafting-ahead behavior is unchanged. A preliminary `goal_detail`
lookup can fail before the mutation; after the mutation call is entered, any
transport error remains the old unknown/error path regardless of its prose.

Real UI acceptance requires a connected, app-server-advertising Core and no
busy/held/unknown/current-work/capacity blocker. Synthetic tests do not establish
that eligibility or three-width usability. If the same unchanged Core is merely
down, its owner may use the existing supported launcher on the same
DB/socket/profile after checking idle ownership. Normal startup generates fresh
per-process identity/nonce/READY; never copy an old nonce, reset history, replace
Core bytes or restart a healthy process for this UI change. If eligibility cannot
be established safely, actual acceptance remains missing. Testing an invalid
absolute folder needs no valid native send, provider/title prompt or new goal.

The resulting `/goals/campaign-…` address is a Core conversation, not a
coordinated result. Its title, folder, permissions, Stop and details belong to
that goal even when another coordinated job is current. Session details and the
timeline show actual registered app-server / one-shot exec / unconfirmed
transport. Stored or synthetic session IDs alone do not prove continuity.

Native chat stays primary: saved file/command details are retained under the
collapsed **Workspace results** disclosure. Opening it uses a bounded scroll
area rather than pushing the conversation and input out of the viewport.

Closing the page does not close the Core session. On return, an attached session
can accept an explicit new message. A detached, known nonterminal session can use
the existing **Resume session** action only when Core offers it; that attaches
the stored native handle without replaying a message. A refused or unavailable
Resume remains blocked, not replaced with a new conversation. Closed Codex is
not resumable; a cancelled-turn successor is a new Attempt/session. Native Stop
interrupts the displayed turn; idle Close Runtime session is a separate guarded
action. A single Codex conversation has no **automatic** independent Pi
verification. The optional separate check below inspects a current workspace
snapshot; it does not verify who authored it or certify the native turn.

### Optional current-workspace check with Pi

After the newest Codex turn completes, **Check workspace with Pi** keeps the
conversation in place. The user can inspect exactly what will be shared before
allowing one independent readonly response. The native draft and session remain
untouched; there is no second Codex planner, writer or repair round.

1. Open the secondary check action on the native goal. The configured Pi
   capacity checkbox starts off. It uses the same exact requested pair and
   **Billing not confirmed** control as coordinated work; no free-text model or
   default capacity is substituted. Existing profile Background Send consent is
   reused, or explicitly granted with the existing action.
2. Choose **Preview shared material**. The complete external-provider prompt is
   shown, not a summary of it. It includes current tracked HEAD→worktree changes,
   the Native **reported** reply, observed command-entry counts and their
   omission/truncation flags, and every crop/omission notice. Command text,
   working directory and output are not shared.
   Preexisting or concurrent edits can be included. Known private paths are
   excluded before diff bodies are collected; this is not a credential scanner.
   Allowed content and Native text can still contain sensitive data. To remove
   it, cancel, change the workspace and explicitly preview again. The renderer
   cannot edit the prompt or provide files to the server.
3. **Check this snapshot** admits one Pi-only audit (two-read minimum scope,
   no writes; one charged audit and unused read revoked). Stop check targets
   that Node job, never native Interrupt or Close session. A running readonly
   turn may finish after Stop; unknown delivery is retained without replay or
   refund. Empty or unavailable material produces no model call or checked
   result.
4. Return to the exact Core goal to find its saved independent response and
   original shared material. It is a dated snapshot, not a persistent verified
   badge, a new coordinated product root or exclusive Codex delta. Newer native
   turns and subsequent workspace edits are not covered by that response.

This first purpose requires the canonical native workspace to equal Git's
physical top-level directory. Subdirectory targets refuse before body collection:
“This check currently needs the repository's top-level folder.” Existing native
and ordinary coordinated subdirectory behavior is unchanged. The target is the
current Codex Attempt and the **last** turn-result entry in producer order; it
must itself be completed. An older completed entry is not a fallback after a
newer failure/cancellation. Ordinary whole-inventory Core guards remain in force,
including other native work, pending decisions, incomplete views and holds.

The Linux bridge adds `native_workspace_check_prepare` and
`native_workspace_check_start` message types on the existing guarded
`POST /goalport/ipc`, through Node `native-check-prepare/start` and the existing
background host/worker/store. Prepare without a pair only returns its configured
offer. A single server-owned preview payload expires after five minutes
(maximum 256 KiB); restart loses it. Final start and worker recheck HEAD, bounded
path classification, the complete selected raw diff/status and Native context.
Drift or expiry says **Preview again**, without silently refreshing provider
input. Repeating an admitted final request resolves that exact job before buffer
lookup, even after expiry; a different target/pair conflicts. The page retains
only the submitted caller ID/target/pair across reload, never prompt material,
consent or budget. An unknown reply keeps that original request. A typed
pre-admission refusal discards the preview and offers an explicit new preview;
provider text is not interpreted as permission to retry. Generic Electron
background-start explicitly refuses renderer check fields: this is not a Windows
check button or Windows runtime proof.

Known-path exclusions are case-insensitive: `.git`, `.ssh`, `.gnupg`, `.aws` or
`.azure` components; `.env`/`.env.*`; `auth.json`, `models.json`, `credentials`,
`credentials.json`, `id_rsa`, `id_ed25519`; `.pem`, `.key`, `.p12`, `.pfx` suffixes.
Local excluded names are not provider input. Git metadata is NUL-framed and
strict UTF-8 before body reads; explicit literal tracked pathspecs select at
most 80 paths (1024 bytes each, 16384 path bytes total), never untracked bodies.
The complete selected raw diff must fit 65536 UTF-8 bytes for comparison. The
provider crop is at most 16384 bytes, the whole displayed/admitted/stdin prompt
at most 32768 bytes. The Native reported reply is at most 4096 bytes. Native
command details (text, working directory and output) are not shared; only the
observed-entry count and existing omission/truncation flags are included.
Limited coverage is named; no universal race, secret-free-content or
test-execution claim is made.

A real Native documentation improvement followed by a concrete Pi critique of
that actual diff is still a **future acceptance task**, not an example this
source writer has run. Source tests/build output do not establish provider use,
capacity, Linux workspace qualification or three-width GUI acceptance.

### Competing-work preflight

Only explicit native admission/send ingress runs the read-only
`native-preflight` operation in the existing Node host. The Python bridge uses
the same bounded capture as status reads (3 seconds, 4 MiB stdout, 16 KiB private
stderr), with a separate single-line `native preflight:` parser. No helper is
started by passive saved-result/Core reads.

- `native-preflight --workspace ABS`: validate/canonicalize an existing folder;
  require `outstanding(root) === false`, a complete held-workspace inventory,
  no global/candidate block and an exact candidate echo.
- `native-preflight --global`: require no outstanding work, complete inventory,
  no global block and zero remaining holds, including acknowledged-left holds.
  Exactly one mode is required. Missing profile, malformed facts or timeout
  refuses before the native Core mutation.
- Start checks its explicit folder; send checks the explicit campaign and exact
  fresh active Attempt/task via `goal_detail`. Runtime selection preserves
  Core's new-Attempt policy when no Attempt was supplied.
- Resume and handoff/reassign use workbench-only
  `nativeTarget:{campaignId:<pinned view>}`. The bridge strips this lookup key
  before Core; supplied payload and wrapper campaigns must agree. Historical
  Attempt sources are refused here, not guessed from shared selection.
- Isolated Continue checks its explicit **target** folder; source lineage and
  source heldness remain Core-owned. Legacy campaign creation, queue override
  and owner-action commands use conservative global preflight.
- Read/history/receipt, Stop/cancel, permission responses (allow or deny), idle
  close, recheck and authorization revoke stay reachable under original Core
  guards. This is a closed product ingress table, not a claim that arbitrary
  native Core commands or external CLI clients are guarded.

Preflight is a fresh observation, not a permission certificate or a
cross-process transaction. Node/Core lease, outbox, unknown-delivery,
authorization and held-responsibility checks remain final. Session lifetime,
turn responsibility, native campaign permissions and coordinated worker budget
remain separate; none revives another's authorization.

For bounded native-turn diagnostics, the existing pinned snapshot timeline
projects provider-supplied native thread/turn hashes and the session hash for
the expected Attempt. A completed turn's nested `turn.id` uses the same parser
as `turnId`. Missing provider references remain missing. Existing paged
history is available; no new journal or session store is introduced. Source and
synthetic tests are not evidence of installed-binary consumption, real provider
context recall, restart recovery, billing or three-width GUI acceptance.

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
# Ready live allowance: ONE stable caller child ID (the UI supplies this).
$CLI $GLOBAL continue --from REQUEST_ID --live-request-id FOLLOWUP_ID --goal 'Revise the plan' --background
# For a settled result/new allowance, omit --live-request-id.
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
  3. Scope vs. consent reuse: ordinary settled/legacy/write continuations create
     a fresh allowance. The bounded live-read-once path below instead retains one
     worker-local readonly scope. Crash/restart and write-scope recovery remain
     follow-ups; saved counters never restore access.

## One follow-up on an open readonly allowance

New explicit Codex→Pi, background, four-read admissions with a recorded Pi
capacity and no file-change authorization can keep the original worker and RAM
scope after a saved **Plan checked** result. Saved content appears first; the
current work row says **Checking** until a matching host/worker status is received.
Only that acknowledgement can show **Ready**, not a model running or remaining
access recovered from disk. Closing/returning or reading status sends no model
turn and never extends the worker's original 15-minute idle deadline. A previously
received Ready observation survives a refresh only for the same job, request,
root and selected view, with all passive base/slot observations unchanged and
nonnegative. Pending work, revocation, a gone/unknown owner, changed slot, local
action, status failure, navigation or that original expiry clears it immediately. The saved-result composer
is the single Continue action: empty Enter sends nothing, explicit Continue may
have no additional instruction. Other saved goals remain readable, not spendable.

Continue must match that same initial/latest result, folder, root and requested
pair. It rechecks Core coverage, background capability and original membership,
but does not authorize another scope, admit another job or spawn another worker.
The full saved initial plan/check accompanies it. The new result has a stable
caller child ID and the initial job as parent. The original runtime cancellation
key and numeric RAM scope generation remain separate and unchanged. There is one
follow-up, not a queue or an automatic third round.

The complete live control JSON frame—including schema, internal credential, IDs,
UTF-8, escaping and newline—is limited to 8192 bytes in each direction. The browser
receives no control credential. Oversize text is refused unchanged, never cropped
or silently sent through a fresh admission. Fresh continuations retain their
separate 100,000-character/assembled-byte bounds. Live checks have a 10-second
worker budget, 12-second control timeout and 15-second CLI/HTTP operation budget.
Unknown delivery keeps the draft and original child ID. Reconcile that ID through
status; do not invent a retry ID or replay a turn.

Stop wakes the idle worker immediately. New goal uses the existing idle-only
guarded revoke, then waits within one fixed five-second transaction for strict
status of the captured job/request/root: terminal stopped/completed, matching
outcome, inactive, no pending command or contradictory live state. It also reads
a fresh passive global slot: only empty, with no unconfirmed/leftover-held
negative observation, permits the local safe draft. A foreign occupied slot
blocks; a stale pointer to this same job is still ending, not free. Unknown slot
data is not empty. If active work wins the guarded revoke race, New goal does
not stop it and keeps the current view.

An invalidated status helper may need its original three-second budget to drain;
a fresh read can need another three seconds. Both must fit in the same five-second
UI attempt, never an extended deadline or a second simultaneous helper. Failure
keeps the view and draft and explicitly offers another New goal click to check
again. That explicit retry first confirms the captured identity, without revoking
an already ended worker again. A prior revoke receipt alone is not settlement.
New goal never sends a model turn or clears a hold. An explicit idle Stop keeps
its captured job/request/root for the same later confirmation: its receipt and
passive done label do not let the next New goal skip strict status and the fresh
slot check. The stopped/expired
unused allowance is separate from its checked result; no child report is invented.
A later intentional Continue is labeled as a **new allowance**, not recovered
remaining access. Inspecting another goal never ends the current allowance.

Mode metadata lives outside immutable normalized input; waiting uses existing
`running` state with `awaiting-followup` phase. Accepted-child context is validated
locally: malformed context disables that continuation without repairing data or
creating a profile-wide malformed admission. Genuine malformed base progress,
prior admissions and unknown owners keep their existing refusal rules. Rollback
means disabling new emission in a compatible build while retaining readers and
live workers through settlement—not an old-binary checkout, kill or reset. Old
structural reader compatibility does not promise old UI support.

Current-source independent review and bounded real product acceptance remain
required. This is not native provider-session reuse, billing/quota measurement,
restart recovery, general API coverage or overall-goal completion.

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

Passive `coordination_latest`, `coordination_list` and exact `coordination_detail`
read only the local saved projection: record, roots/history, remembered labels,
descriptive `currentBase`, `savedAllowanceView` and `globalSlot`. They do not run
Node, Core, control, discovery or models. Saved labels cannot supply a live ACK,
counters, acceptance confirmation or permission.

Separate `coordination_status` requires an exact UUID-v4 **job** ID (not a saved
request ID), with no latest/current fallback or caller-supplied profile/executable.
It returns either `source: host-status` with a validated matching host job or
`source: unavailable`, `job: null` and a fixed plain reason. Existing Node status
and its 800 ms RAM acknowledgement remain unchanged. Only active current-mode
work, a matching unresolved action or explicit New goal confirmation needs this
read; settled history and blank New goal do not fan out status calls.

The HTTP leader owns the childless status process and two short-lived binary pipe
readers. It retains at most 4 MiB stdout and 16 KiB stderr, concurrently draining
both; overflow fails the whole read. Execution cuts off at 2.5 seconds with the
remaining 0.5 seconds reserved for direct-helper kill/reap/pipe/thread cleanup.
Exactly one UTF-8 job-projection line is accepted. Same-job waiters share the
original three-second deadline; a different job while busy is unavailable.
Mutations invalidate pending display results before effects, then let that helper
drain. There is no TTL/last-good status cache or replacement before confirmed
cleanup. If OS cleanup is still unconfirmed, owned references remain on the entry
until a later explicit read can confirm it; there is no autonomous reaper. These
are bounded ordinary-child checks, not a hard real-time OS guarantee.

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
retain text and choices; HTTP success alone does not count as admission. New
Linux Start/new-allowance actions hold one caller request ID from the first
explicit send and forward it unchanged through HTTP to the existing CLI
`--request-id`; a live child retains its separate `liveRequestId`. An uncertain
send locks its original text/ID rather than creating another send.

A passive unique `submissionCandidate` is only an exact-job lookup key. Resolving
an uncertain admission requires strict matching host status for the submitted ID,
canonical absolute folder, goal/root and coherent active/live or terminal facts.
Same text, a foreign ID, aliases, pending/unconfirmed status, ambiguous/missing
candidates or timeouts keep the uncertainty. Live-child association requires the
exact accepted child ID or matching closed child ACK, never its parent's ID or a
disk observation. Old clients/reloaded pages without a recoverable submitted ID
may view matching existing work read-only, but cannot prove that THIS lost Start
was admitted by text alone. They keep the not-confirmed sentence and draft; no
automatic resend, new ID, generic latest-status adoption or new intent store.

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
