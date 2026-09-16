# Security policy

## Supported versions

GoalPort is a release candidate built from source. There are no maintained release branches; please report issues against the current `main` branch.

## Reporting a vulnerability

Please **do not open a public issue** for a vulnerability, and do not include technical details, credentials, tokens, transcripts or private paths in any public issue.

GitHub private vulnerability reporting (Security tab → Report a vulnerability) is a feature of public repositories after the owner enables it. It is not available while this repository is private.

While the repository is private, or if that option is not shown, open a short issue asking the maintainers for a private contact and include no technical details in it.

After the repository is public and private vulnerability reporting is enabled, use **Security** → **Report a vulnerability**.

A useful report includes:

- the GoalPort version or commit, and how you built it;
- which Runtime was involved (Codex, Claude Code, Grok or Scenario), if any;
- steps to reproduce, using a throwaway workspace and synthetic content;
- the impact you observed or expect.

Never include real credentials, tokens, account identifiers, private transcripts or native Runtime configuration. Redact paths that contain your user name.

## Scope

Relevant reports include, for example:

- a way for GoalPort to resend, replay or duplicate a command it reported as unknown;
- bypassing a held workspace responsibility, a lease, or a permission Decision;
- GoalPort reading or writing native Runtime configuration or credentials, or forwarding API keys to a Runtime;
- the Core pipe being reachable over the network or by another Windows account. The pipe is meant to be open to only the Windows user account that runs Core, and remote named-pipe clients are rejected. Administrator and SYSTEM privileges are outside what this control can prevent; see [limitations](docs/limitations.md#local-pipe-security);
- private data leaking into diagnostics, receipts or test artifacts.

Out of scope:

- vulnerabilities in the native Runtime CLIs themselves; report those to their vendors;
- attacks that require a process already running as the same Windows user. GoalPort's threat model is the current-user local process, and it does not sandbox Runtimes. See [privacy and trust](docs/privacy.md) and [safety](docs/safety.md#not-a-sandbox).
