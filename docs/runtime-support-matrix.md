# Runtime and scenario support matrix

## Independent Claude Stop contract (2026-09-05 candidate)

The new local Electron candidate splits native turn interruption from residual execution quiescence. Its run of record is `goal-runs/claude-native-stop-product`; final candidate identity and current acceptance must be read from that run's manifest and GUI evidence. Implementation alone is not admission.

| Capability | Candidate contract | Evidence status |
| --- | --- | --- |
| Current Claude native turn interrupt | Explicit input UUID, native session/process/turn binding, durable GUI operation, successful matching interrupt receipt and input-bound abort result; denial/normal/error/foreign results cannot confirm | New scope only: final verdict and exact build binding in `claude-native-stop-product/evidence/gui-acceptance.json`; no support claim unless that verdict is PASS for the selected manifest |
| Residual tools/descendants | Independently persisted `unknown` and write responsibility `held`; interrupted turn does not imply quiescence | Quiescence UNMET; no global-stop claim |
| Conflicting writes or provider takeover | Held workspace blocks new input/admission/resume/handoff/permission Allow and lease release, including restart | Required deterministic and packaged verification in new run |
| Buffer/effect distinction | Raw structured receive and delivery metadata retained; known buffered receipts distinguished from unknown generation time; actual file effects are separate evidence | Historical active/tree post-result writes preserved; no fixed settling delay |

The current adapter reads native stream-json directly. It retains the raw input correlation at that boundary rather than adding a Python SDK or relying on typed projections that discard UUID fields. Stop never enables the rejected broker or treats process exit, no output, elapsed time, or Job-empty as quiescence. This local candidate offers no residual-release/reconciliation control; unresolved responsibility remains held. Existing native authentication stays in the installed runtime; this is not a third-party subscription login offering or public distribution.

The original AC6c global-stop requirements, frozen failed runs, `PARTIALLY_ADMITTED`, and Stable V1 RC disposition below remain historical and unchanged. Passing this new independent native capability does not grant `CLAUDE_CONTROL_ADMITTED` or Stable V1 closure.

Status: Electron Stable V1 RC. Last reviewed: 2026-09-04. Closure and earlier resume-chain freezes remain historical. The verifier/Core-restart needs-fix freeze is Core `93b5ddbd265c2b755f645c2cf279c610081de24771d734286d5965bd2bb0e7ea`, launcher `c791f4aa9ea21facb1dd7dcdc1dd55938bb168d33674e3d55550776249c925d5`, EXE `cb32e182da8efdd56444a7dbc96a038624734a9fd1eda098ce2e11797505dae6`, asar `9589cf5e04856629fa8d3b099a15b5383dd04afedd8ca1a933e1d530399d043c`. A passing deterministic Scenario predicate does not promote a native Runtime or packaged Desktop result.

Machine identifiers remain lowercase in reports (`codex`, `claude`, `grok`, `scenario`); display names below are editorial only.

## Post-Stop continuation (2026-09-07 `claude-stop-continuation` candidate)

| Capability | Candidate contract | Evidence status |
| --- | --- | --- |
| Re-check of a held responsibility | Read-only observation of current facts: the bound runtime identity as recorded at Stop, live leases, pending outbox intents and attempt state. It can return `live`, `not-running` or `unavailable`, and **has no quiescence verdict to return** | New scope only; verdict and build binding in `claude-stop-continuation/evidence/continuation-acceptance.json` |
| Isolated continuation | Starts a new Campaign/Task/Attempt in a workspace proven not to overlap any held responsibility, carrying `title`, `acceptance` and `goal` plus source linkage, with a new native session. Grants provider, action and transfer authorization for the **new** campaign only | Required packaged GUI verification in this run |
| Original-workspace release | **Not implemented.** Releasing the source workspace would expose a silent force-kill of the residual process (`admit_runtime` derives a colliding attempt id; `select_runtime`'s `attempts.insert` drops the old `ClaudeStreamProcess`, whose `Drop` calls `child.kill()`), and the original attempt could not send afterwards regardless (`send_prompt` returns before its own `pending_stop` clear) | UNMET by design this round; see `goal-runs/claude-stop-continuation/owner-decision-package.md` |
| Residual quiescence / descendants | Unchanged: **UNMET**, no global-stop claim | Unchanged from the prior candidate |

The 2026-09-05 section above belongs to the prior candidate and is not edited by this run.

## Runtime admission

| Provider | Verified path | Current direct result | Remaining gap | Status |
| --- | --- | --- | --- | --- |
| Codex 0.152.0 | Core-owned app-server JSON-RPC using installed ChatGPT authentication | live version preflight; native session/tool path retained; resume classified this-run | DUR-02 second acquire not blocked; soak process companion incomplete | THIS RUN / PARTIAL |
| Claude Code 2.1.259/2.1.260 | Core-owned persistent stream-json (`-p --input-format stream-json --permission-prompts host --permission-mode manual --permission-prompt-tool stdio`) using the installed claude.ai Max subscription | this-run owner B-fix freeze Core `8bd5fd60` asar `133212f8` rebuilt (Core differs from gen3 `6c8ac7ae`; asar/EXE/launcher unchanged because only `runtime_manager.rs` changed); classifier `claude_stream` 24 passed and the whole `goalport-core` suite passed; live Allow + two independent GUI Declines with Core `snapshot.notices` bound to decision id B; live AC6c: the unresolved Stop survived the ambiguous EDE result (arrived 15 ms after the interrupt) and was disposed 5,194 ms later at the bounded fallback against the exact managed child, with `exact_child_alive_at_deadline=true`, `signal_attempted=true`, `signal_count=1`, `signal_sent=false`, `stopKind=unverified`, `ac6cClosedPredicate.met=false`; AC-DUP one timeline message card; resume unsupported + Codex handoff; CLI 2.1.260 / GUI 2.1.259 | AC6c blocker is now the signal itself: `GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT)` rejected with win32 error 6 because `hide_native_console` spawns with `CREATE_NO_WINDOW`, so the child has no console; that flag is shared by the Codex, Grok and Claude spawns and changing it is an owner-level process-supervisor decision; no official unique A field this hour (implement-B); native `--resume` unsupported; residual follow-up after reopen unmet (not AC10); historical `bce967ce` is not an admission bearer; sealed notice-stop-dup remains PARTIALLY_ADMITTED on `649ee756`; sealed freeze `5f5e78be` remains NOT_ADMITTED; live-deny and fail-open remain PARTIALLY_ADMITTED on `4c435cfe`; ruling `goal-runs/goalport-claude-ac6c-stop-admission/evidence/claude-admission.json` | THIS RUN / PARTIALLY_ADMITTED |
| Grok 1.0.13 | Core-owned ACP stdio (`grok agent stdio`) using the installed native OIDC subscription | packaged-GUI multi-turn tool task on one Attempt; native permission prompts answered live (allow_once and reject_once); decline, cancel and refused follow-up all fail closed; Core-generated Grok -> Codex handoff reached a terminal Codex Attempt | limit semantics proven only at contract-test level with a fake ACP agent; `session/load` resume implemented but not exercised in the GUI; Codex handoff can stall and self-cancel (observed twice, preserved as round-4 and round-6 attempt 1); cancel-while-permission-pending windows have contract-level + Named-Pipe evidence only | ADMITTED THIS RUN |
| Scenario | Core-owned deterministic adapter | executable S-layer contracts | never counts as native Runtime evidence | TEST ONLY |

GoalPort removes API-key variables from child Runtime environments and does not copy native plugins/skills/hooks/MCP configuration. The Claude Stop candidate additionally retains local structured message/tool/result correlation frames (including raw input/session/result IDs) with receive/delivery metadata. Private initialization and command-catalog diagnostics are excluded; raw IDs are not credentials and remain in local evidence. This revises the previous normalized-only persistence description for this specific boundary.

## Evidence index

| Capability | Evidence | Result |
| --- | --- | --- |
| Electron packaged GUI | `goal-runs/goalport-stable-v1-closure/evidence/electron-connected.json` | PASS host=electron-packaged |
| Permission / owner-only | `saf-02-owner-only.json` | PASS host=electron-packaged |
| Independent audit | `independent-audit.json` | UNMET OAuth expired |
| UI loss / 1800s continuity | `soak-1800s.json` | UNMET evidenceValidation.process=false |
| Resume-chain GUI (this run) | `goal-runs/goalport-electron-rc-resume-chain/evidence/resume-chain-kill.json` | reconnectWhileActive ACTIVE; absence runtime events; follow-up native turn |
| Hardened resume-chain GUI | `goal-runs/goalport-evidence-verifier-core-restart/evidence/resume-chain-{graceful,kill}.json` | PASS on live Core identity + SQLite Attempt/session/event binding; original obs-b10 is separately UNMET |
| Legitimate Core restart | `goal-runs/goalport-evidence-verifier-core-restart/evidence/core-restart.json` | PASS: duplicate/live/race reject; ended+reconciled new epoch accept; receipt history retained; uncertainty preserved |
| Native resume | `codex-native-resume.json` | this-run classified |
| Notifications | AUMID `GoalPort.Desktop` | UNMET/os-notification; no Start Menu shortcut |
| Grok | `goal-runs/goalport-grok-native-admission/evidence/grok-admission.json` | ADMITTED; AC1-AC7 all true, `blockingCriteria` empty |
| Grok -> Codex handoff (ROU-02) | `goal-runs/goalport-grok-native-admission/evidence/handoff.json` | PASS read-only verification, all eight core predicates true, `guiEvidence.valid` |
| Grok packaged GUI multi-turn | `goal-runs/goalport-grok-native-admission/evidence/grok-gui-multiturn.json` | PASS host=electron-packaged, 4 turns, one Attempt, native permission prompts answered in the GUI |
| Grok fail-closed | `goal-runs/goalport-grok-native-admission/evidence/grok-fail-closed.json` | PASS permission-denied, interrupted, error-path |
| Grok native ownership | `goal-runs/goalport-grok-native-admission/evidence/native-ownership.json` | PASS config.toml and auth.json byte size unchanged; argv ends `agent stdio` |

Evidence layer: limit semantics (`max_turn_requests` / `max_tokens` / `refusal` / RPC error / stream EOF) are proven at contract-test level with a fake ACP agent, not against the live subscription. The packaged GUI proves decline -> file untouched, cancel during a running `run_terminal_command` -> CANCELLED, and a refused follow-up on the terminal Attempt. Native permission prompts are enabled per session through the ACP-advertised `always-approve off` command (the Runtime owner's `~/.grok/config.toml` is never read or written); `allow_once` and `reject_once` were both answered live in the GUI and `allow_always` is never sent.

Grok admission was ruled against the FINAL frozen build of this run: Core `9b6722eaa7327c042afa6866e939013b2b814ea4043379693248d70b25c7bf3e`, launcher `c791f4aa9ea21facb1dd7dcdc1dd55938bb168d33674e3d55550776249c925d5`, EXE `cb32e182da8efdd56444a7dbc96a038624734a9fd1eda098ce2e11797505dae6`, asar `813f062379166487b7a51e2056f263b06c96fbf7753f67c47089e7a7bafc7d49` (`goal-runs/goalport-grok-native-admission/evidence/freeze.json`). An earlier build of the same run was vetoed by a cross-family critic for four control-flow defects; its artifacts are kept as `*.round1.json` and were NOT used for the ruling.

ROU-02 disclosure: `distinctNativeSession` is taken from the Core-persisted `handoff.completed` packet (old/new session hashes, `nativeSessionBound`, provider identities); the historical `Provider session hash` timeline proxy is unsatisfiable for an app-server/ACP second Runtime and was not observed. The eight core predicates were computed by the packaged-GUI driver `scripts/connected/v1-grok-gui-multiturn.mjs` during the round-6 run on the FINAL frozen build, from the run-of-record SQLite `evidence/grok-gui-r6.sqlite` (sha256 `7bc6498dcff9e1f574b4421da28416ce9216393a65e503f3331fdc48c17539fe`), and re-checked read-only by `scripts/connected/verify-handoff.mjs`. Superseded bearers are preserved and were not used for this ruling: `handoff.rev41-unmet.json` / `handoff-core-report.rev41.json` and the `*.round1.json` … `*.round5.json` sets.

The canonical 23 Scenario declarations remain in `tests/scenarios/manifest.json`; the current per-layer table is in [acceptance-srd.md](acceptance-srd.md).
