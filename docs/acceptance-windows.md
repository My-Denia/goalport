# Windows packaged zero-quota acceptance

**Driver source is checked on Linux; actual Windows operation is not-run until
an owner runs this command on Windows x64.** A source/unit-test PASS is not
Windows acceptance or completion of the Execute → Verify slice.

## Prerequisites (already available; the driver installs nothing)

Run from a Windows-native checkout root, on an interactive Windows x64 desktop.
Do not run from WSL, through `.exe` interop, a Linux shell, or a headless session.
Use Node >=22.19 (or >=24) and the checkout's existing dependencies, pnpm 11.22.0,
Git, Rust 1.96.1 MSVC, and Visual Studio C++ build tools/Windows SDK, as in
[building](building.md). PowerShell **7** (`pwsh.exe`) must already be on the
Windows PATH and allowed to execute the checked-in helpers under existing host
policy. The driver checks its actual `--version`; it does not use Windows
PowerShell 5.1, install/login, elevate, change PATH/config, or bypass policy.

Keep the checkout stable during packaging. Paths must be normalized absolute
Windows drive paths (spaces are supported; `%`, quotes and newlines are refused
where cmd expansion would be unsafe). The empty synthetic workspace is
`goal-runs/goalport-execute-and-native-acceptance/fixtures/synthetic-workspace`.
Existing nonempty content or symlink/reparse ancestors are refused, not removed.
Do not point this driver at a user workspace/profile. Close prior blocked runs
through the app's own close control and inspect preserved evidence before a
new run; the driver does not broadly kill apps by name/title.

## One owner command

From the checkout root, in an ordinary Windows terminal:

```powershell
pnpm acceptance:windows
```

This invokes `node scripts/acceptance/windows-run.mjs` with no required flags:

1. Refuse non-Windows/non-x64 **before any side effect**, validate paths and
   existing tools. Resolve the same existing PowerShell7 executable for both
   lifecycle and native-window helpers, without persistent environment changes.
2. Call the existing `scripts/desktop/package.mjs` `main(['--out', buildOut])`
   with a fresh `artifacts/electron-rc/<run-slug>-win-<timestamp-random>` directory.
   Packaging builds frontend/Core/launcher and creates the portable
   `GoalPort-win32-x64` folder. It does not return a package object: the driver
   explicitly verifies that exact directory with `verifyPackage(packageRoot)`.
   Package output is **outside goal-runs**; prior output is never overwritten.
   Version stays unchanged. No installer, release bundle, signing, tag, push or
   publication is performed (see [releasing](releasing.md)).
3. Prepare the empty throwaway fixture and per-case state; generate **both**
   `codex.cmd` and `claude.cmd` offline wrappers using the absolute parent Node
   executable, checked-in stub program and per-case sentinel. Verify source,
   sentinel and **production launchSpec** shadowing before every launch. Provider
   unavailability is a stub probe response; wrappers are never removed. No real
   CLI is probed, even with `--help` or authentication commands.
4. Launch the explicitly re-verified packaged `GoalPort.exe` (not dev Electron)
   and bundled Core, with fresh run-owned named pipe/DB/userData/CLI homes/temp,
   canonical stub-first PATH/.CMD, no inherited provider/backend credentials.
5. Drive the **same shared SCENARIOS and a1–a5 functions** used by `run-local`:
   success/authorization/revocation/history; one environment-blocked turn and
   honest pre-takeover stop/Use again; fewer-than-two refusal with zero turns;
   no-text terminal stop; real close and same-state health-memory relaunch/Use
   again. a5 retains the original immutable env object, same state and verified
   absent pipe, but uses a fresh `relaunch/` log subdirectory. Any unclean close
   blocks relaunch and subsequent scenarios.
6. Capture actual owned Win32 HWND identity/ancestry/DPI/pre/target/observed bounds
   at 860/1020/1440 CSS widths where the shared matrix requires them. Re-read
   actual CDP viewport/DPR/root/grid/titlebar after native resize. Native or CDP
   mismatch blocks; no emulation, CSS patch, alternative OS helper or silent
   fake width evidence is accepted. UI input is **CDP**, not native OS input.
7. Request official app close; independently observe app exit, exact bundled
   Core executable+pipe+DB+PID+creation identity and named-pipe absence. Unknown
   identity, denied permissions, live app/Core, nonzero exit or remaining pipe
   blocks readiness. Only proven owned Core is stopped; only fresh owned temp is
   removed. Preserve logs, DB, grants/ledger/claims/health/records and PNGs.

Optional arguments to the same entry can supply `--out <fresh this-run evidence
path>` or `--pwsh <existing absolute PowerShell7 path>` (no install or bypass).
`--package <absolute portable folder>` skips rebuilding but **still verifies**
the supplied package and re-verifies it at each launch. Its manifest revision,
dirty flag and source digest remain distinct from driver HEAD/current source;
an older supplied package is not relabeled as a fresh build. The no-flag owner
command above always builds fresh.

## Evidence and disposition

Evidence is a new directory:
`goal-runs/goalport-execute-and-native-acceptance/evidence/windows-<timestamp-random>/`.
The command prints the exact `report.json` path. Preserve the entire directory
and the separate package build output, including `build-commands.json` and any
`build-failure.json`/`verification.json`; copy the evidence back to the run owner.

- `report.json`: host/distribution, driver/source and verified package identity,
  initial/final fixture file observations versus hashes, actual launch commands
  and CWD/PIDs, preflights, shared assertions, file snapshots/hashes, probe counts
  separate from ledger-backed turns, zero-quota proof, cleanup and failure/status.
- `screenshot-manifest.json`: each PNG's hash/dimensions, native measured bounds,
  CDP viewport/root/grid/DPI and geometry; inspect **every PNG** yourself.
- `walkthrough.md`: shared per-step notes and the honesty ledger.
- `a1`–`a5`: run-owned stub invocation JSONL, state/logs/screenshots and actual
  durable records. `a5/relaunch/` preserves independent second-launch logs.

Exit **0** means the full packaged stub-driven matrix and owned cleanup validated
on this Windows host. Exit **1** means a launched/build attempt was blocked with
preserved report/evidence. Exit **2** means early host/tool/path refusal (or an
unhandled infrastructure error); it never means ready. Missing PowerShell,
policy/permissions, ambiguous ownership or bounds are blockers, not runtime
source-ready success. A blocked report can contain earlier ready scenarios;
only the aggregate exit/report disposition determines acceptance.

Not proved: native OS keyboard/mouse, real CLI flags/wire/login/models/quota,
real model judgment, actual replacement takeover with only two providers, owner
human visual review, or write-enabled product/M6 acceptance. Do not substitute
Linux source tests or Linux dev screenshots for this Windows operation. This
run does not authorize real model use, install/security changes or publishing.
