# Validation matrix

> **Reference record.** Dated contracts and evidence for specific historical builds, kept unchanged for audit. It is not a current guide; start at the [documentation index](../README.md).

All gates are fail-closed. A command that exits zero with zero tests, all
required tests skipped, no structured event range, a stale build ID, or an
unreported timeout is a failed gate. Scenario evidence is S only. Runtime and
Desktop obligations stay R and D.

| gate | command | minimum evidence | output |
| --- | --- | --- | --- |
| build identity | pnpm build:id -- --out goal-runs/goalport-v1/evidence/build-id.json | current hash of product files plus tool versions | build-id.json |
| Scenario S | pnpm scenario -- --id <ID> --timeout 60 --report <file> | exactly one declared ID, executed=1, positive assertions, no skipped required assertions, no forbidden effects | scenarios/<ID>.json |
| Runtime preflight | pnpm verify:runtime -- --provider <id> | native executable/help/auth status only; no model turn | m0-<id>.json |
| Runtime live | pnpm verify:runtime -- --live --provider <id> --synthetic-root <run fixture> | explicit live flag, synthetic root marker, case timeout, structured event range, redacted output | provider report |
| IPC | pnpm verify:ipc -- --timeout 120 | real ipc_lifecycle target, non-zero test count, no skipped/failed tests | m0-ipc.json |
| M0 | pnpm verify:m0 -- --timeout 1200 | IPC plus at least two live provider candidates satisfying declared cases | m0-selection.json |
| M1 baseline | pnpm baseline:m1 -- --events 10000 --history 1000 --reconnects 20 --timeout 300 | real baseline target prints measured event/history/reconnect ranges | m1-baseline.json |
| M1 | pnpm verify:m1 -- --runtime-selection <M0 report> | Rust/UI non-zero tests, build, direct R and D reports | m1.json |
| M2 | pnpm verify:m2 -- --runtime-selection <M0 report> --provider-ranks primary,secondary --runtime-evidence <R1,R2> --desktop-evidence <D> | two selected providers, contract tests, required S cases, two direct R reports, and one direct D report | m2.json |
| M3 | pnpm verify:m3 -- --scenario-manifest tests/scenarios/manifest.json --traces 1000 | exactly 23 S scenarios and a non-zero state-machine test range | m3.json |
| M4 | pnpm verify:m4 -- --providers codex,grok,claude | 23 matrix rows and eight attempted cases per Provider; unsupported stays Preview | m4.json |
| M5 | pnpm verify:m5 -- --events 10000 --history 1000 --output-bytes 16777216 --soak-seconds 600 | migration/restore, secret scan, malicious inputs, measured real wall-clock soak | m5.json |

Each gate binds input reports to the current build ID. A report from an older
source tree is stale even when its old command passed. The --live Runtime path
is never selected implicitly; preflight results cannot be promoted into a live
capability. unsupported, unmet, unknown, and waived remain visible states and
do not satisfy a stronger layer.

The protocol admission assumptions use the
[Codex pinned app-server protocol](https://github.com/openai/codex/blob/rust-v0.151.0/codex-rs/app-server/README.md),
[Codex SDK docs](https://developers.openai.com/codex/codex-sdk),
[Claude headless docs](https://code.claude.com/docs/en/headless),
[Claude Agent SDK docs](https://code.claude.com/docs/en/agent-sdk/overview),
[Claude legal/compliance docs](https://code.claude.com/docs/en/legal-and-compliance),
and [Grok headless/ACP docs](https://docs.x.ai/build/cli/headless-scripting).
The references were accessed on 2026-08-31. They support candidate protocol
descriptions; they do not substitute for local Runtime or Desktop evidence.
