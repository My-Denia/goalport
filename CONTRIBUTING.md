# Contributing to GoalPort

Thanks for your interest in GoalPort. This guide covers how to report problems and propose changes.

## Before you start

- Read the [README](README.md) and [limitations](docs/limitations.md). Many rough edges are already known.
- For anything larger than a small fix, open an issue first so the approach can be agreed before you write code.
- Security problems: do not open a public issue; follow [SECURITY.md](SECURITY.md).

## Development setup

[Development](docs/development.md) covers prerequisites, repository layout and running from source. [Building](docs/building.md) covers creating a package.

## Ground rules

These rules protect users' agents, accounts and workspaces. Pull requests that break them will not be merged.

1. **Synthetic data only.** Tests, fixtures, screenshots, logs and issue reports must never contain real accounts, prompts, transcripts, credentials, tokens, private paths or native Runtime configuration.
2. **Native Runtimes stay native.** Do not write Runtime configuration, pass permission-bypass flags, handle logins, or fall back to API keys. See [runtime integration](docs/runtimes.md).
3. **Unknown stays unknown.** Do not add automatic resend, and do not infer that work stopped from elapsed time, silence or process exit. See [safety](docs/safety.md).
4. **Evidence matches its layer.** Synthetic Scenario tests prove GoalPort's contracts. They must not be described as native Runtime support.
5. **Status stays accurate.** Do not describe the product as stable or a Runtime as supported beyond what the [reference records](docs/reference/README.md) show.

## Pull requests

- Keep each pull request focused on one change, and explain the user-visible effect.
- Add or update tests for behavior changes. Core changes need Rust tests; renderer and IPC changes need Vitest tests; packaging and launch changes need `scripts/desktop` tests.
- Run the [local checks](docs/testing.md#local-checks) and mention in the description which ones you ran.
- Update the docs when behavior, commands or limits change. `pnpm test:desktop` checks README facts and documentation links.
- CI must pass on Windows.

Releases, version changes and status changes (for example, moving beyond Stable V1 RC) are decided by the maintainers.
