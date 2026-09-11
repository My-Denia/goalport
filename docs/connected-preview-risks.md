# Residual risks (Electron Stable V1 RC)

Freeze: Core `1f9321dfde8b0974f79ad5e38f4bc7ff62092a15bc9b17ead05cc4eb65d7d8da`, EXE `cb32e182da8efdd56444a7dbc96a038624734a9fd1eda098ce2e11797505dae6`, asar `f5b6e82c6962be8f52b57614c7ac5244631a02f1f6ba4ed76a4da2a76eab4155`.

- Soak 1800.006s / 6 turns on the frozen package is UNMET because `evidenceValidation.process=false`. DUR-01/04, EFF-01/03, RES-02 follow soak UNMET. Do not stamp PASS.
- DUR-02 observed a real `.goalport/dur-02-write.txt` and Runtime PID gone with Core alive and lease UNCERTAIN, but the second mutating acquire was not blocked.
- SEC-02 packaged GUI revoke did not block the next send (`connect ENOENT` on the isolated pipe after revoke).
- ROU-02 has no qualified second Runtime selection report this run.
- QUA-02 independent audit failed: Claude OAuth session expired.
- Grok 1.0.13 `-p --output-format streaming-json --max-turns 1` exited 1 (`max turns reached`). NOT_ADMITTED class `protocol`. Cannot claim three-runtime Stable V1.
- Folder-packaged Electron toasts use AUMID `GoalPort.Desktop` without a Start Menu shortcut. Visible pixels were not captured (`os-notification` UNMET).
- UI reconnect is not native execution recovery. Crash recapture recorded `R1_UNSUPPORTED`.
- Isolated verification uses `GOALPORT_REQUIRE_ISOLATED=1` and never opens userData SQLite.
- Resource-pressure queueing is a bounded test hook (`GOALPORT_RESOURCE_PRESSURE=1`), not machine-wide stress.
- Prior RC and Connected Preview pins remain intact; they are not this-run PASS proof.

## Evidence verifier and Core restart hardening (2026-09-02)

- Current bounded freeze: Core `93b5ddbd…`, launcher `c791f4aa…`, EXE `cb32e182…`, asar `9589cf5e…`; release/package Core and launcher identities match.
- `evaluateReport` now requires a fresh live OS Core observation (PID, CreationDate, ExecutablePath and hash of that exact path), reads the isolated SQLite itself, and fail-closes error/incomplete outcomes and semantic reconnect/terminal/follow-up/runtime/session mismatches.
- Immutable obs-b10 graceful/kill are UNMET under the new predicate because their Core/Runtime processes have ended and they predate the new epoch/outcome fields. The old respawn false-positive remains preserved and is also UNMET (including two startup receipts in its SQLite).
- A Core launch epoch is claimed and reconciled, then advances `STARTUP_PENDING -> READY_COMMITTED`. Failed startup/ready windows become `ABORTED`; only a committed ready receipt is valid evidence. A live or unknowable prior Core rejects; a decisively ended prior Core permits a distinct epoch on the same DB. Old receipts remain.
- Restarted Core does not claim R1 attachment: prior Runtime PID/process epoch become unknown, historical provider-session hash remains, executing command/outbox become UNKNOWN, active lease becomes UNCERTAIN, and pending permission remains pending.
- Current packaged graceful and kill paths both passed with canonical Runtime process-epoch and strict causal-time binding; the 1800-second soak was not rerun. Product status remains Stable V1 RC. The run cannot strictly close while the historical pre-write `recovery.rs` rollback baseline remains unprovable.

## Resume-chain this-run notes (2026-09-02)

- This-run freeze asar `11dcc2dc…`. Closure asar `f5b6e82c…` is unchanged.
- DUR-01 R/D uses kill-path `reconnectWhileActive=active`. Graceful reopen snapshot was already `waiting` (partial).
- EFF-01 uses `originalStepTerminal=waiting` plus sqlite `runtime.*` events after UI exit. Not 1800s.
- Claude preflight `loggedIn: false` remains; this run did not expand Claude.
- Renderer Continue must not await `confirmCloseChoice` (destroy deadlock). CDP `element.click()` can hang; fire-and-forget plus mouse events were required for host exit.
