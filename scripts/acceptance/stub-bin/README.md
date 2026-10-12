# Generated acceptance stub binaries

The `codex` / `claude` wrappers in this directory are generated at runtime by
`scripts/acceptance/lib/stubbin.mjs`; they are intentionally not checked in as
provider-named executables. A generated Linux directory contains executable
POSIX wrappers named `codex` and `claude`; a Windows directory contains
`codex.cmd` and `claude.cmd`. Both provider identities are always present, even
when a scenario makes one unavailable: change its probe response in
`behavior.json` instead of removing its wrapper.

Each wrapper invokes the absolute Node executable and the checked-in
`scripts/acceptance/stub-harness.mjs`. The harness reloads `behavior.json` for
every process invocation and requires the exact `GOALPORT_STUB_SENTINEL`
provided when the bin directory was materialized. Missing or mismatched
sentinels refuse with exit code 42. Turn queues are separate per provider from
probe responses and ordered per behavior-file revision; queue exhaustion fails
closed with exit code 43.

The harness appends `invocations.jsonl` entries with timestamp, identity,
probe/turn type, sanitized argv, cwd, behavior id, and queue accounting. The
last (user-authored prompt) argument is always replaced with `[redacted prompt]`;
credential-shaped argument substrings are redacted; environment values,
including the sentinel, are never logged. The fixture responses are offline
copies of the discovery and turn shapes pinned in
`electron/cli-coordinate.test.cjs`; they do not invoke or emulate vendor network
services.

The generated directory, logs, behavior file, and test HOME belong under a
run-owned temporary/evidence root. Never put these files under a real profile
or use the stubs to change a real CLI login. These are acceptance test shims,
not general provider mocks or a security boundary for arbitrary untrusted code.
