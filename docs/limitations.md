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

## Local pipe security

The Core pipe accepts only the Windows user account that runs Core and rejects remote clients ([architecture](architecture.md#processes)). What that does not cover:

- **Processes of the same user are trusted.** Any process running as that user can open the pipe, including lower-integrity processes (the pipe has no integrity label). Such a process can also hold Core's single serving connection and stall the window's requests.
- **Administrators and SYSTEM keep access.** Their privileges reach the pipe regardless of its access list.
- **A pipe name taken while Core is down blocks Core.** Core refuses to start on a name another process created, and at startup the window refuses to attach to it, so launching GoalPort fails (a denial of service). A name taken while the window is already attached is covered by the snapshot-poll limitation below.
- **Snapshot polls are not re-verified on every poll.** The window checks the pipe server with `goalport-core pipe-peer` before attaching, before every other request and after any connection failure. If Core stops and another process takes its pipe name between two polls, the window can show that process's data until the next command or connection failure triggers a check, which then refuses. The check and the connection are separate steps.
- **A busy Core delays commands.** A command that needs a check waits at most 120 seconds from when it is issued for a successful check, including checks queued ahead of it and a repeated check after a connection failure. It is then refused rather than sent unchecked. The command's own response limit is another 120 seconds, so a command can wait about 240 seconds in total.
- **The window's pipe client does not limit impersonation.** Node's named-pipe client connects without a security quality-of-service setting. A process holding `SeImpersonatePrivilege` that took over the pipe name in the gap above could impersonate the window's user on that connection. Core's Rust client does set identification-only impersonation; that flag is checked statically, not by a live test.
- **An open connection keeps a crashed Core's process object referenced, but a confirmed exit no longer blocks restart.** A same-user client can still hold a handle to a Core that has already terminated. Core now treats that confirmed-exited process as ended, so a new Core may start on the same database and pipe name. A prior Core that is still executing, or whose identity cannot be confirmed, still refuses the second start. The open connection does not prove that Runtime tools or descendants have finished, and it does not release held or uncertain responsibility.
- **Denial is tested with a restricted token, not a second Windows account.** The different-account squatting case is covered by the Windows API's first-instance rule and by `pipe-peer`'s access-list check.
- **Remote rejection was tested only through local SMB loopback.** The tests open the pipe as `\\127.0.0.1\pipe\...` on the same machine. Clients on other machines rely on the documented `PIPE_REJECT_REMOTE_CLIENTS` behavior and were not tested from another host.
- **Other clients do not check the server.** The `src-tauri` host and the developer tools in `scripts/connected` do not run `pipe-peer`. Neither does Electron started in the legacy isolated test mode without a data profile (`GOALPORT_REQUIRE_ISOLATED` without `--data-dir` or `--test-profile`); there the window performs no `pipe-peer` check. Process scans that match `goalport-core.exe` and the pipe name on the command line can also match a short-lived `pipe-peer` process.

## Window and UI

- **The right rail needs a wide window.** At a viewport of 1020 CSS pixels or narrower (more physical pixels under display scaling), the right rail is hidden. The rail holds the Decision Inbox, Runtime selection, Stop, handoff and Blocked work actions, so a pending permission request can be out of sight. Widen the window.
- **Timeline timestamps are raw epoch milliseconds.**
- **Desktop notifications are not verified.** They use AUMID `GoalPort.Desktop` without a Start Menu shortcut, and visible toasts were not captured as evidence.

## Where the full record is

Open gaps, with their evidence and build identities, are recorded in the [runtime support matrix](reference/runtime-support-matrix.md), [S/R/D acceptance](reference/acceptance-srd.md) and [residual risks](reference/connected-preview-risks.md).
