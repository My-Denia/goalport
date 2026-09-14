# Runtime integration

GoalPort drives the coding-agent CLIs you already installed and signed in to. It does not reimplement an agent, proxy a model API, or manage a Runtime's configuration. Each Runtime keeps its own login, subscription, plugins, skills, hooks, MCP servers, tools, permission rules and native sessions. GoalPort does start each session in a prompting mode, so permission requests reach its Decision Inbox; the per-Runtime table below lists how.

## Ownership boundary

GoalPort owns its Campaign, Task, Attempt, policy, evidence and recovery records. The Runtime owns everything native.

What GoalPort does when it starts a Runtime (`crates/goalport-core/src/runtime_manager.rs`, `adapters.rs`):

- It starts the installed executable in the Project workspace with a structured protocol on stdio.
- It removes `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` and `XAI_API_KEY` from the child environment, so GoalPort never introduces API-key authentication. (If a CLI itself is configured to log in with an API key, that remains the CLI's choice.)
- It maps native events into ordered Attempt events, and native permission requests into Decisions that you answer in the GoalPort window.

What GoalPort does not do:

- Handle logins or credentials, or create accounts.
- Read, write or copy native configuration. It does not write `~/.claude` and never reads or writes Grok's configuration in `~/.grok`.
- Pass permission-bypass flags. There is no `--always-approve` for Grok, and no `--bare` or `--dangerously-skip-permissions` for Claude.
- Treat the Claude Agent SDK as a substitute for the unmodified Claude Code CLI.

## Per Runtime

| Runtime | How it is driven | Notes |
| --- | --- | --- |
| Codex | `codex app-server --listen stdio://` (JSON-RPC: `initialize`, `thread/start`, `turn/start`, `turn/interrupt`) | Uses the installed ChatGPT-authenticated CLI. Threads start with `approvalPolicy: on-request` (or `untrusted` via `GOALPORT_CODEX_APPROVAL_POLICY`) |
| Claude Code | One persistent `claude -p` process per Attempt with stream-json input and output; key flags `--permission-prompts host --permission-mode manual --permission-prompt-tool stdio` | Native `--resume` is reported as unsupported. The optional Stop broker component ships in the package but is off unless explicitly enabled |
| Grok | `grok agent stdio` (ACP: `initialize`, `session/new`, `session/prompt`) | Turns native permission prompting on per session with `/always-approve off` when the CLI advertises that command; otherwise Grok's own default applies. Only `allow_once` or `reject_once` is ever answered. A declined permission ends the turn, and the next message is refused rather than retried |
| Scenario | In-process deterministic adapter; no external process | Synthetic test Runtime. Labelled "Synthetic Scenario" in the UI and never counted as native Runtime evidence |

GoalPort looks for each CLI in its usual install location first, then on `PATH`:

| Runtime | Checked first |
| --- | --- |
| Codex | the npm global install under `%APPDATA%\npm\node_modules\@openai\codex\…` |
| Claude Code | `%USERPROFILE%\.local\bin\claude.exe` |
| Grok | `%USERPROFILE%\.grok\bin\grok.exe` |

The admission records were made against Codex 0.152.0, Claude Code 2.1.259/2.1.260 and Grok 1.0.13. GoalPort does not detect or gate CLI version changes while running. Newer CLI versions may behave differently, and the separate `goalport-core preflight` command is a diagnostic, not an admission.

## Support status

The window labels every native Runtime **Preview**.

"Admission" is this project's term for a recorded decision that a Runtime path meets its declared core capabilities on live evidence. **Admitted** means it met them. **Partial** or **partially admitted** means some capabilities were shown and named gaps remain. Each decision applies to the specific build it was recorded against. A package you build from current source has not been re-admitted.

| Runtime | Recorded status | Main open gaps |
| --- | --- | --- |
| Codex | Partial | In one historical durability run, a second mutating acquire was not blocked after the Runtime exited and its lease became uncertain; soak process evidence incomplete |
| Claude Code | Partially admitted | Native interrupt vs residual execution: quiescence is unproven, so responsibility stays held after Stop; `--resume` unsupported |
| Grok | Admitted | Limit semantics proven only against a fake ACP agent; `session/load` resume not exercised in the GUI; a Grok → Codex handoff was observed to stall and self-cancel |
| Scenario | Test only | Never native evidence |

Passing synthetic Scenario checks does not admit a native Runtime or a new CLI version. The full record, with build hashes and dates, is in the [runtime support matrix](reference/runtime-support-matrix.md) and [S/R/D acceptance](reference/acceptance-srd.md). Those records name evidence files from local development runs; the evidence bundles themselves are not published in this repository.

## Official references

Install and sign in to each CLI using its vendor's documentation.

- [Codex](https://github.com/openai/codex) and its [app-server protocol](https://github.com/openai/codex/blob/rust-v0.151.0/codex-rs/app-server/README.md) (tag used for the original admission assumptions)
- [Claude Code headless / CLI](https://code.claude.com/docs/en/headless) and [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)
- [Grok headless and ACP](https://docs.x.ai/build/cli/headless-scripting)
