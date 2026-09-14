# Limitations

GoalPort **1.0.0-rc.1** is a **Stable V1 RC** (release candidate). It has not closed Stable V1. This page lists what the current RC does not do, or does only with conditions.

## Distribution and platform

- **Windows x64 only.**
- **No downloadable release.** You build the package from source ([building](building.md)).
- **Unsigned package.** Windows may warn before running it.
- **Tauri** is a bounded regression target, not a second product.

## Data

- **No database migration or import.** A profile is bound to the RC version and Core build that created it. Use a new data directory when you change builds ([local data](local-data.md)).
- **Moved profiles are refused.** So are profiles from the earlier path identity format. Nothing is rewritten.
- **Workspace matching is conservative.** Distinct folders that collapse to the same comparison key are refused.

## Runtimes

- **Admission status differs per Runtime.** Native Runtimes are labelled Preview in the window. Codex is partial, Claude Code is partially admitted and Grok is admitted. Each ruling applies to a specific recorded build; a package built from current source has not been re-admitted ([runtime integration](runtimes.md#support-status)).
- **Claude Code has no native `--resume`.**
- **CLI version changes are not detected.** Newer Runtime CLI versions may behave differently from the recorded ones.
- **The Scenario Runtime is synthetic.** Its checks never count as native Runtime evidence.

## Safety and recovery

- **Residual execution after a Claude Code Stop is not proven quiescent.** Write responsibility stays held.
- **A held workspace cannot be released in this RC.** You can re-check it or continue in a new isolated workspace ([safety](safety.md#stop-and-held-responsibility)).
- **Revocation was not blocking in one historical check.** A packaged-GUI check found the next send was not blocked after a revoke (SEC-02 in [S/R/D acceptance](reference/acceptance-srd.md)).
- **Outbound effects are not exactly-once.** A missing receipt after an external effect stays unknown.
- **Reconnecting the window is not recovery of native execution.** A restarted Core does not re-attach to earlier Runtime processes.
- **No sandbox.** `READ_ONLY` is a declaration, not an operating-system sandbox.
- **Supervised launches may lose Core.** When GoalPort starts inside a job object that refuses breakaway (some terminals and CI runners), the supervisor can end Core when the job ends.

## Window and UI

- **The right rail needs a wide window.** At a viewport of 1020 CSS pixels or narrower (more physical pixels under display scaling), the right rail is hidden. The rail holds the Decision Inbox, Runtime selection, Stop, handoff and Blocked work actions, so a pending permission request can be out of sight. Widen the window.
- **Timeline timestamps are raw epoch milliseconds.**
- **Desktop notifications are not verified.** They use AUMID `GoalPort.Desktop` without a Start Menu shortcut, and visible toasts were not captured as evidence.

## Where the full record is

Open gaps, with their evidence and build identities, are recorded in the [runtime support matrix](reference/runtime-support-matrix.md), [S/R/D acceptance](reference/acceptance-srd.md) and [residual risks](reference/connected-preview-risks.md).
