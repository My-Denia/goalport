# GoalPort documentation

Start with the [project README](../README.md) for what GoalPort is and how to run it.

## Using GoalPort

| Page | What it covers |
| --- | --- |
| [Building and running](building.md) | Build the Windows RC package, verify it, start it, move it |
| [Local data](local-data.md) | Where data lives, profiles, build identity, what is refused |
| [Limitations](limitations.md) | What the current RC does not do yet |
| [Privacy and trust](privacy.md) | Ownership domains, capture rules, threat model |

## How it works

| Page | What it covers |
| --- | --- |
| [Architecture](architecture.md) | Processes, IPC, SQLite, and the Campaign → Task → Attempt model |
| [Runtime integration](runtimes.md) | How Codex, Claude Code and Grok are driven, and what GoalPort never touches |
| [Safety and recovery](safety.md) | Delivery uncertainty, stop, held workspace responsibility, restart, closing the window |

## Contributing

| Page | What it covers |
| --- | --- |
| [Development](development.md) | Prerequisites, repository layout, dev mode |
| [Testing and CI](testing.md) | Local checks, packaged smoke tests, the CI workflow |
| [Releasing](releasing.md) | Turning a verified package into a downloadable release candidate |
| [Signing](signing.md) | Authenticode inventory, signing route comparison, SmartScreen, native-evidence gate |
| [Contributing guide](../CONTRIBUTING.md) | How to propose changes |

## Reference and history

These records are kept for audit, unchanged apart from a status banner and link fixes. They describe specific historical builds and admission decisions, not the current guide.

| Page | What it covers |
| --- | --- |
| [Reference records](reference/README.md) | Runtime admission matrix, S/R/D acceptance, residual risks, host comparison, original verification gates |
| [ADR-0001: Runtime host](adr/adr-0001-runtime-host.md) | The ownership-boundary decision made before implementation |
| [History](history/README.md) | Earlier admission notes and the original V1 design documents |
