# Privacy and trust boundary

GoalPort is local-first, but local-first does not mean that a Runtime cannot
read the workspace that the user authorizes. The application has three
ownership domains:

1. the user's workspace and its existing files;
2. GoalPort's own local database, event journal, evidence references, and
   diagnostic manifests;
3. each Provider Runtime's own login, configuration, native session, and
   service-side data.

Deleting an App Campaign does not delete a Provider session or rewrite a
workspace. App-data deletion is scoped to App-owned paths and produces a
manifest before the user performs it. GoalPort does not stash, reset, clean,
commit, push, publish, deploy, release, or delete a user workspace as part of
verification.

## Capture and transfer

The Scenario manifest and fixtures use synthetic roots, synthetic marker names,
and synthetic effect targets. They contain no real account, prompt, project,
credential, token, or personal path. A live Runtime probe is disabled unless
the caller supplies --live and a run-owned synthetic fixture marker. Reports
store command classes, timestamps, exit and timeout status, byte counts,
content hashes, event types, and short redacted previews. They do not store a
full prompt, transcript, environment, credential, account identifier, or
native configuration snapshot.

Cross-Provider transfer is a user policy decision. The handoff describes the
goal, acceptance, current plan, workspace baseline, changed-file manifest,
commands, evidence references, risks, and pending decisions. It does not imply
that the next Runtime cannot perform its own authorized Workspace reads.
Provider allowlists and current revocation are checked at action time; an old
policy snapshot cannot keep a revoked transfer alive.

## Diagnostics and telemetry

Diagnostics are generated locally and previewed before export. The default
telemetry policy is disabled. Diagnostic output must exclude synthetic secrets,
credentials, private keys, bearer values, full source, and full Runtime output.
The verification script scans product scripts, tests, docs, and source for
common credential patterns before the M5 gate.

The application does not claim Runtime sandboxing. A narrowed working
directory, displayed permission, or prompt instruction is not an OS isolation
boundary. Security statements are limited to the current-user local-process
threat model; a process already controlling the user's session may read
secrets or inject into another process.

## Source boundary

The Runtime keeps its own authentication and native configuration. This is
consistent with the [Claude headless CLI
documentation](https://code.claude.com/docs/en/headless), while the
[Claude Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)
is recorded as a separate integration surface. GoalPort does not intermediate
claude.ai login or use Agent SDK/API keys as an unannounced subscription
fallback. Codex and Grok candidate protocol links are listed in the
[support matrix](runtime-support-matrix.md).
