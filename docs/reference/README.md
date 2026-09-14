# Reference records

These documents record admission decisions, acceptance tables and measurements for specific historical builds. Each names its own build identities and dates. They are preserved unchanged, apart from a status banner and relative link fixes, so later audits can trace what was claimed and on what evidence.

Current behavior is described in the [documentation index](../README.md). If a record here disagrees with a current page, the current page and the code win.

| Record | Content |
| --- | --- |
| [Runtime support matrix](runtime-support-matrix.md) | Per-Runtime admission status (Codex, Claude Code, Grok, Scenario), Claude Stop contracts, evidence index |
| [S/R/D acceptance](acceptance-srd.md) | The 23 product scenarios with Scenario (S), real Runtime (R) and Desktop (D) results, plus later admission notes |
| [Residual risks](connected-preview-risks.md) | Open risks recorded at the Electron Stable V1 RC freeze and later hardening rounds |
| [Desktop host comparison](desktop-host-comparison.md) | Electron vs Tauri measurement that made Electron the release line |
| [Verification gates](verification-gates.md) | The original fail-closed M0–M5 verification entry point (`scripts/verify.mjs`) |
| [Validation matrix](validation-matrix.md) | Commands and minimum evidence for each original gate |
| [Preview and Stable limits](preview-stable-limits.md) | Limits written for the earlier Preview |
| [Privacy and trust design](privacy-trust-design.md) | The Preview-era privacy design, including features not implemented in the RC |

`scripts/connected/verify-docs.mjs` and the M4 gate in `scripts/verify.mjs` read some of these files by default.
