# Privacy and trust

GoalPort is local-first, but local-first does not mean a Runtime cannot read your workspace. Whatever folder you choose, the Runtime you select works in it with that Runtime's own permissions.

## Three ownership domains

| Domain | Owner | Examples |
| --- | --- | --- |
| Your workspace | You | The project folder and its files |
| GoalPort's local records | GoalPort | The profile database and logs ([local data](local-data.md)) |
| Each Runtime's own data | The Runtime and its vendor | Login, configuration, native sessions, and anything the vendor's service stores |

GoalPort writes only its own profile directory. It does not stash, reset, clean, commit, push, publish, release or delete anything in your workspace on its own behalf. Changes in the workspace are made by the Runtime you selected, subject to its permission prompts.

## What GoalPort stores

The profile database holds:

- the Campaigns, Tasks and Attempts you create, and the messages you send;
- the ordered events each Runtime reports (replies, tool activity, permission requests and results) and your Decisions;
- command, outbox, lease, receipt and process-identity records used for [safety and recovery](safety.md);
- for Claude Code Stop handling, the structured message, tool and result correlation frames, including raw input, session and result identifiers. These identifiers are not credentials.

It does not store Runtime credentials or copy native configuration. Everything stays in the profile directory on your machine.

## What leaves your machine

GoalPort has no account, no server and no telemetry code. Network traffic comes from the Runtime CLIs, which talk to their vendors under their own terms, exactly as they do when you run them directly.

A **handoff** to another Runtime records a packet in both Attempts: goal, task, workspace and session hashes, lease and outbox states, and evidence references. The next Runtime can still read the workspace on its own authority. Handing work to another vendor's Runtime is your decision.

## Tests, fixtures and reports

Tests and fixtures in this repository use synthetic workspaces, synthetic text and synthetic markers only. Live Runtime probes are separate, explicit tools. They require `--live` and a synthetic fixture folder, and they store only redacted summaries: command classes, timestamps, exit status, counts, hashes and short previews. Full prompts, transcripts, environments, credentials and account identifiers are never stored.

## Limits of the trust model

- GoalPort does not sandbox Runtimes. A narrowed working directory, a displayed permission or a prompt instruction is not an isolation boundary.
- Security statements cover the current-user local-process threat model. A process that already controls your Windows session can read secrets or inject into other processes.
- Revoking an authorization is checked when an action is attempted. One historical packaged-GUI check found the next send was not blocked after a revoke; see SEC-02 in [S/R/D acceptance](reference/acceptance-srd.md).

The original Preview-era design of this page is kept as a [reference record](reference/privacy-trust-design.md).
