# Safety and recovery

Coding agents run tools that change files. GoalPort's safety model is simple to state: when Core cannot prove what happened, it says so, keeps conflicting work blocked, and never repeats an action on its own. This page describes what that means in practice. [Privacy and trust](privacy.md) covers the threat model.

## No silent resend

Messages and other mutating commands are sent once, under a stable command identity.

- The window's Core client never retries a mutating command. If the acknowledgement is lost, the result is shown as unknown and nothing is resent automatically (`electron/core-client.cjs`).
- If the same request identity reaches Core twice, the recorded result is returned and no work is repeated. A replayed message is answered as "not sent again".
- After a restart, commands that were executing and outbound effects that were dispatching become `UNKNOWN`. They are not replayed.
- Reconnecting the window records a cursor only: "No prompt was replayed."

Outbox identifiers prevent duplicate GoalPort decisions, but they cannot make arbitrary Runtime tools exactly-once. A missing receipt after an external effect stays unknown.

## Permissions and decisions

Native permission requests become Decisions in the window's Decision Inbox. You answer each one with **Allow once**, **Decline permission** or **Keep waiting**. An unanswered request keeps the work blocked and is not retried automatically. Runtime-specific mappings are listed in [runtime integration](runtimes.md).

Commit, push, release and delete have their own explicit request buttons in the window. A Runtime's progress never implies them.

## Workspace leases

A Runtime that may write to a workspace holds a lease. A lease that is `Active` or `Uncertain` blocks a second writer. After a Core restart, active leases become `Uncertain`, because Core can no longer observe the Runtime that held them.

`READ_ONLY` is a declaration, not an operating-system sandbox. Unknown access is treated as mutating.

## Stop and held responsibility

Stopping a native turn and knowing that everything it started has finished are different facts. GoalPort records them separately.

For **Codex and Grok**, Stop asks the Runtime to interrupt. If the Runtime confirms, the Attempt becomes `Cancelled`. If it does not confirm, the request is recorded as unconfirmed. No held responsibility is created.

When a **Claude Code** turn is stopped, Core records three independent states: the native turn, **residual execution** (`unknown` or `active`) and **write responsibility** (`held`). Tools the turn already started, and their descendants, may still be running. Core has no proof that they are quiescent, and its schema cannot store a "quiescent" verdict at all.

While responsibility is held for a workspace, Core refuses conflicting work there, including after a restart:

- new messages and starting a Runtime
- permission Allow
- handoff and native resume
- lease release

The window shows this as **Blocked work**. From there you can:

- **Re-check now.** A read-only observation of the bound Runtime, leases and pending outbox. It can report that the Runtime is live, not running, or that no observation was possible. It never concludes that residual work stopped.
- **Continue in a new isolated workspace.** Starts a new Campaign, Task and Attempt with a new native session, in a workspace proven not to overlap the held one. It carries over the goal and acceptance text.

Releasing the original workspace is **not implemented** in this RC. Held responsibility stays held. See the [runtime support matrix](reference/runtime-support-matrix.md) for the contract and its evidence.

## Core restart

On startup, Core reconciles before it serves:

| Record | After restart |
| --- | --- |
| Executing commands | `UNKNOWN` |
| Dispatching outbox effects | `UNKNOWN` |
| Active leases | `UNCERTAIN` |
| Prior Runtime process attachment | unknown or unsupported (a restarted Core does not claim it re-attached) |
| Pending permission requests | still pending |
| Prompts | never replayed |

Each Core launch is a numbered epoch. Only a committed ready receipt counts as a valid start. A prior Core that is still alive, or whose state cannot be known, prevents a second Core from starting on the same database.

## Closing the window

Core, not the window, owns task state. When you close the window while a Runtime is working, or while responsibility is held, GoalPort asks what to do:

- **Keep window open.**
- **Continue in background.** Only this window closes. Core and the authorized Runtime keep running, and no new work starts.
- **Stop … and quit.** Core ends the active Attempt, or for Claude Code interrupts the turn and records residual responsibility. The window quits only after Core's durable response.

The window stays open if Core does not confirm the choice. Reopening the same package and profile reconnects to the same Core. UI reconnection is not recovery of native execution.

Windows terminals and CI runners may run GoalPort inside a job object that refuses breakaway. Core then runs inside that job, and the supervisor can end it when the job ends (see [architecture](architecture.md#processes)).

## Not a sandbox

GoalPort does not sandbox Runtimes. A narrowed working directory, a displayed permission or a prompt instruction is not an isolation boundary. Security statements are limited to the current-user local-process threat model: a process that already controls your session can read secrets or inject into other processes.
