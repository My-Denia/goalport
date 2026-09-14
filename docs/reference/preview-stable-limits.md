# Preview and Stable V1 limits

> **Reference record.** Written for the earlier Preview and kept unchanged for audit; some limits below no longer describe the current RC. Current limits: [limitations](../limitations.md).

The current repository is a Preview until direct evidence says otherwise.
Creating a package, passing a TypeScript test, passing a deterministic
Scenario, or seeing a Runtime executable does not make Stable V1.

## Preview may claim

Preview may expose the pure conversation UI, local Campaign/Task/Attempt
projection, synthetic Scenario contracts, native Runtime preflight, and any
specific live capability whose report contains the current build ID, a
non-zero execution range, and its actual limitation. It may show a Provider
as unknown or unsupported and continue independent synthetic work.

Preview must state when Runtime subscription use, permissions, cancellation,
resume, process cleanup, native skills/hooks/MCP behavior, or reconnect has not
been directly observed. It must not claim a stronger recovery level because a
UI reopened or an Adapter process restarted.

## Stable V1 requires

Stable V1 requires all three Runtime paths to meet their declared core
capabilities, all required R/D rows in the product scenario matrix, durable
Campaign state across ordinary UI loss, current evidence freshness, revocation
and lease invariants, accurate unknown external effects, diagnostics
redaction, migration/restore, resource limits, and actual Windows Desktop
operation. The 23 S rows are necessary but cannot replace R or D. A virtual
clock, an exit-zero command with no tests, a Mock Core, a text-only CLI
transcript, or a document assertion cannot prove Stable.

The unmodified Claude Code CLI is assessed as a distinct native path on the
persistent stream-json control channel (`--permission-prompts host`,
`--permission-mode manual`, `--permission-prompt-tool stdio`). The Claude Agent
SDK is a separate API/SDK surface and is excluded from native subscription
routing in this product. GoalPort does not handle login, credentials, or paid
API fallback, does not pass `--bare` or `--dangerously-skip-permissions`, and
does not write `~/.claude`. Native `--resume` is unsupported until proven.
See the [support matrix](runtime-support-matrix.md) and [ADR-0001](../adr/adr-0001-runtime-host.md).

## Known limits

- The Windows Named Pipe accepts the Desktop snapshot wire shape and returns a
  versioned Core response, but the response currently contains Store counts,
  not the full Campaign/Task/Attempt UI projection. The actual Desktop therefore
  stays disconnected and reports `Core connection remains unavailable`; this
  transport result is not claimed as durable Desktop recovery.
- Runtime versions and protocol capabilities can change; preflight is repeated
  on first use, version change, and recovery.
- A missing receipt after an external effect is UNKNOWN; Outbox identifiers
  prevent duplicate App decisions but cannot create exactly-once semantics for
  arbitrary Runtime tools.
- READ_ONLY is a declaration, not an OS sandbox. Unknown access is treated as
  mutating, and an active or uncertain lease blocks a new writer.
- A frozen evidence Bundle is tied to its target snapshot. External edits make
  current evidence stale; history is retained for audit context.
- A finite buffer, disk-full condition, or output truncation is a visible
  limitation. GoalPort does not promise infinite transcript fidelity.
- Grok permissions are Runtime-owned. GoalPort never passes `--always-approve` and never reads
  or writes `~/.grok`; it turns native prompting ON for its own session by sending the
  ACP-advertised `/always-approve off` command, and records `native-default` when the Runtime
  does not advertise that command. Every Core Decision maps to exactly one native action:
  only `allow_once` and `reject_once` are ever selected, never `allow_always` or
  `reject_always`. A declined permission ends the Grok turn with `stopReason: cancelled`, so
  the Attempt becomes terminal and the next message is refused rather than silently retried.
- Resource and performance numbers are measured on a specified build and
  machine. They are not inferred from Tauri or Rust alone.

Official candidate references are the
[Codex app-server tag](https://github.com/openai/codex/blob/rust-v0.151.0/codex-rs/app-server/README.md),
[Claude headless CLI](https://code.claude.com/docs/en/headless),
[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview),
[Claude legal/compliance](https://code.claude.com/docs/en/legal-and-compliance),
and [Grok headless/ACP](https://docs.x.ai/build/cli/headless-scripting), accessed
2026-08-31.
