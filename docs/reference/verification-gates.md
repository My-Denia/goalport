# GoalPort verification and evidence

> **Reference record.** The original M0–M5 verification gates, kept unchanged for audit. Day-to-day checks: [testing](../testing.md).

GoalPort is a local control plane for the native Claude Code, Codex, and Grok
Runtime programs already installed by the user. The Runtime owns its login,
plugins, skills, hooks, MCP servers, tools, and native sessions. GoalPort owns
only its Campaign, Task, Attempt, policy, evidence, and recovery records.
VS Code remains the editor.

The verification entry point is scripts/verify.mjs. It is intentionally
fail-closed:

- pnpm build:id -- --out goal-runs/goalport-v1/evidence/build-id.json hashes
  product files, manifests, lockfiles, and tool versions.
- pnpm scenario -- --id DUR-01 --timeout 60 validates one declared Scenario
  through the Core scenario CLI. The manifest is
  tests/scenarios/manifest.json and contains exactly 23 IDs.
- pnpm verify:runtime -- --provider codex performs native executable,
  structured-help, and authentication preflight only.
- A Runtime task is never started by default. --live is required, and then
  --synthetic-root must point to a run-owned fixture carrying a
  .goalport-synthetic.json marker. Live output is summarized and redacted;
  prompts, account identifiers, credentials, and full transcripts are not
  stored.
- pnpm verify:ipc, pnpm baseline:m1, and pnpm verify:m0 through
  pnpm verify:m5 invoke real test or Runtime commands and reject missing
  targets, zero tests, skipped required tests, stale build IDs, forbidden
  effects, and timeouts.

Every generated report carries the current build ID, UTC start and end times,
the command class, exit status, and a non-zero execution range. A Scenario
report settles only S (deterministic Scenario evidence). R (real Runtime) and
D (actual Desktop) are separate obligations. A Scenario report therefore
cannot promote a Preview build to Stable V1.

The native Runtime sources used for the admission assumptions are the
[Codex app-server protocol at the pinned 0.151.0 tag](https://github.com/openai/codex/blob/rust-v0.151.0/codex-rs/app-server/README.md),
[Codex SDK documentation](https://developers.openai.com/codex/codex-sdk),
[Claude headless CLI documentation](https://code.claude.com/docs/en/headless),
[Claude Agent SDK documentation](https://code.claude.com/docs/en/agent-sdk/overview),
[Claude legal and compliance terms](https://code.claude.com/docs/en/legal-and-compliance),
and [Grok headless/ACP documentation](https://docs.x.ai/build/cli/headless-scripting).
The sources were read on 2026-08-31. Documentation and help output establish
candidate paths; they do not establish live subscription, permission,
cancellation, reconnect, or native configuration equivalence.

## Claude boundary

The unmodified Claude Code CLI with an end user signing in through Claude's
native flow is an independent candidate path. GoalPort does not handle
credentials or intermediate a claude.ai login. The Claude Agent SDK is a
different integration surface; it is not treated as a way to route a native
subscription and is excluded from the Stable support claim unless its
commercial and authentication conditions are separately approved. No provider
may be silently replaced by an API key or paid API fallback.

See [runtime support](runtime-support-matrix.md), [ADR-0001](../adr/adr-0001-runtime-host.md),
[privacy and trust](privacy-trust-design.md), [validation matrix](validation-matrix.md), and
[Preview and Stable limits](preview-stable-limits.md).
