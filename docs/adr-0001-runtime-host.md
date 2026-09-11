# ADR-0001: Runtime host and connection ownership

Status: proposed for the Preview implementation. It is not a claim that a
specific host topology or recovery level has passed live validation.

Date: 2026-08-31

## Decision

GoalPort keeps the Desktop UI, Local Core, Adapter, and native Runtime as
separate ownership boundaries. The Core is the only writer of App state. An
Adapter may probe, negotiate, create or resume a native session, send a
prompt, map structured events, return native permission responses, cancel when
the Runtime documents that capability, and report faults. It does not plan,
route, retry business work, execute tools, or manage the Runtime's skills,
hooks, plugins, MCP servers, or private session state.

The verification harness does not freeze a number of hosts, a process group
shape, or an unconditional reconnect guarantee. M0/M1 evidence must first
prove the connection owner, request identity, protocol version, UI-client
loss, Core restart, duplicate or unknown event behavior, and cleanup behavior.
Until then, the supported recovery level is recorded as unknown or blocked.
An Adapter restart is not treated as attachment to an old stdio process.

The preferred Windows transport is a user-scoped local IPC endpoint with a
handshake, request ID, entity version, and explicit protocol version. The Core
does not require administrator privileges and does not listen on remote TCP.
The process and transport choice remains capability-gated by direct tests.

## Evidence required before freezing a capability

Each Runtime report records the executable identity, adapter and protocol
versions, preflight result, live flag, synthetic root class, command exit,
timeout, structured event count, and limitations. A timeout or a missing
structured result is a failure or unsupported capability. A passing help
command is admission evidence only.

The Core scenario runner must return one structured result for one manifest ID,
with the current build ID, executed=1, positive assertions, no skipped
required assertion, and an explicit forbidden-effects array. Results from a
Mock, fake, stub, or zero-test runner are rejected. The Runtime probe defaults
to preflight; live execution requires --live and a run-owned synthetic
fixture.

## Provider-specific boundary

Codex app-server is evaluated as a pinned 0.151.0 JSON-RPC/JSONL candidate,
using the [tagged protocol README](https://github.com/openai/codex/blob/rust-v0.151.0/codex-rs/app-server/README.md).
Grok is evaluated as an ACP candidate using the
[official headless documentation](https://docs.x.ai/build/cli/headless-scripting).
Claude is evaluated separately as an unmodified CLI using the
[headless CLI documentation](https://code.claude.com/docs/en/headless).

The [Claude Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)
and [legal/compliance guidance](https://code.claude.com/docs/en/legal-and-compliance)
describe a different surface from invoking the installed CLI. Agent SDK use is
not a native-subscription fallback in this product. Acceptance of new
commercial terms, preinstallation, branding, distribution, or public release
remains an owner decision.

## Consequences

This keeps Runtime-native behavior and credentials under their existing owner,
while making unsupported cancellation, approval, resume, or native-config
behavior visible. It also means the Preview can ship a useful deterministic
Scenario and UI surface before every live capability is known. Stable V1
requires direct R and D evidence; this ADR and a protocol name cannot supply
that evidence.
