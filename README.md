# GoalPort

GoalPort is a Windows local-first control plane for native Coding Agent runtimes. Shared React/TypeScript UI, a lifecycle-independent Rust Core, SQLite event persistence, versioned Named Pipe IPC, and native Runtime adapters remain one implementation. Electron is the sole main release line. Tauri is a bounded regression candidate after shared Core/protocol change, not a second product.

Historical closure freeze (unchanged pointer):

- Core SHA-256 `1f9321dfde8b0974f79ad5e38f4bc7ff62092a15bc9b17ead05cc4eb65d7d8da`
- EXE SHA-256 `cb32e182da8efdd56444a7dbc96a038624734a9fd1eda098ce2e11797505dae6`
- asar SHA-256 `f5b6e82c6962be8f52b57614c7ac5244631a02f1f6ba4ed76a4da2a76eab4155`

Historical resume-chain freeze (unchanged pointer):

- Core SHA-256 `1f9321dfde8b0974f79ad5e38f4bc7ff62092a15bc9b17ead05cc4eb65d7d8da`
- EXE SHA-256 `cb32e182da8efdd56444a7dbc96a038624734a9fd1eda098ce2e11797505dae6`
- asar SHA-256 `11dcc2dc6c6b6c807e80467f3b4086a9326a2ac5725a7d8f746a3656b1d147ed`

Evidence-verifier/Core-restart hardening freeze:

- Core SHA-256 `93b5ddbd265c2b755f645c2cf279c610081de24771d734286d5965bd2bb0e7ea`
- launcher SHA-256 `c791f4aa9ea21facb1dd7dcdc1dd55938bb168d33674e3d55550776249c925d5`
- EXE SHA-256 `cb32e182da8efdd56444a7dbc96a038624734a9fd1eda098ce2e11797505dae6`
- asar SHA-256 `9589cf5e04856629fa8d3b099a15b5383dd04afedd8ca1a933e1d530399d043c`

Grok native-admission freeze (historical pointer, unchanged):

- Core SHA-256 `9b6722eaa7327c042afa6866e939013b2b814ea4043379693248d70b25c7bf3e`
- launcher SHA-256 `c791f4aa9ea21facb1dd7dcdc1dd55938bb168d33674e3d55550776249c925d5`
- EXE SHA-256 `cb32e182da8efdd56444a7dbc96a038624734a9fd1eda098ce2e11797505dae6` (unmodified Electron 44.0.0 binary; it hashes identically to the historical package by construction)
- asar SHA-256 `813f062379166487b7a51e2056f263b06c96fbf7753f67c47089e7a7bafc7d49`

Claude native-control admission freeze (historical, `NOT_ADMITTED`):

- Core SHA-256 `5f5e78be37422605b81293c41c76abc2927f61056bd593fbb1ed9d8894c82f7c`
- launcher SHA-256 `c791f4aa9ea21facb1dd7dcdc1dd55938bb168d33674e3d55550776249c925d5`
- EXE SHA-256 `cb32e182da8efdd56444a7dbc96a038624734a9fd1eda098ce2e11797505dae6`
- asar SHA-256 `f724ec09e41ad4b37a62e488fe7b9bb1eb11fe2e959ad15b7d0a25a6e757fe1e`

Claude deny/fail-open admission freeze (historical, `PARTIALLY_ADMITTED`, unchanged):

- Core SHA-256 `4c435cfe59f0068221e8963070f7a98ce8ba1033d3ea0d78c8868ab857c7dd82`
- launcher SHA-256 `c791f4aa9ea21facb1dd7dcdc1dd55938bb168d33674e3d55550776249c925d5`
- EXE SHA-256 `cb32e182da8efdd56444a7dbc96a038624734a9fd1eda098ce2e11797505dae6`
- asar SHA-256 `ef19dcfbf15276e9be47218616018b3d7ab01fef2930a0fca172b07aaabef6e3`

Claude live deny admission freeze (historical, `PARTIALLY_ADMITTED`, copy of `4c435cfe`, not rebuilt):

- Core SHA-256 `4c435cfe59f0068221e8963070f7a98ce8ba1033d3ea0d78c8868ab857c7dd82`
- launcher SHA-256 `c791f4aa9ea21facb1dd7dcdc1dd55938bb168d33674e3d55550776249c925d5`
- EXE SHA-256 `cb32e182da8efdd56444a7dbc96a038624734a9fd1eda098ce2e11797505dae6`
- asar SHA-256 `ef19dcfbf15276e9be47218616018b3d7ab01fef2930a0fca172b07aaabef6e3`

Claude notice/stop/dup admission freeze (historical, `PARTIALLY_ADMITTED`, rebuilt, Core `649ee756`):

- Core SHA-256 `649ee756403321823e21f2168d581d8b15e9c37ec4b6965c3e3962e92fbec1c4`
- launcher SHA-256 `c791f4aa9ea21facb1dd7dcdc1dd55938bb168d33674e3d55550776249c925d5`
- EXE SHA-256 `cb32e182da8efdd56444a7dbc96a038624734a9fd1eda098ce2e11797505dae6`
- asar SHA-256 `9fba59d52fad95e4f587039c7c9013884f7b020ed39ec0d83abeac5f5e93d936`

Claude AC6c stop admission freeze (this run, rebuilt, owner B-fix):

- Core SHA-256 `8bd5fd60210a9b49a4d28b431cabae4df2d890e81cc7948895db615e2300cb49`
- launcher SHA-256 `c791f4aa9ea21facb1dd7dcdc1dd55938bb168d33674e3d55550776249c925d5`
- EXE SHA-256 `cb32e182da8efdd56444a7dbc96a038624734a9fd1eda098ce2e11797505dae6`
- asar SHA-256 `133212f8f94e3a6618ed8bdb94db14b475ccc1ffda1823a491dc92fcd42b3299`

The Core differs from the superseded gen3 Core `6c8ac7ae`. The launcher, EXE and asar are byte-identical to gen3 because the owner-bounded fix touched only `crates/goalport-core/src/runtime_manager.rs`; nothing was changed to manufacture a different asar hash.

The product remains **Stable V1 RC**. Claude native-control admission is a Runtime-level ruling on the persistent stream-json path (`-p --output-format stream-json --input-format stream-json --permission-prompts host --permission-mode manual --permission-prompt-tool stdio`) using the installed claude.ai Max subscription. It does not make Stable V1. This-run freeze is Core `8bd5fd60` / asar `133212f8` (`rebuilt=true`). This-run ruling is `PARTIALLY_ADMITTED` with AC6c as the sole blocker. The Stop request now has its own state: a terminal result may truthfully clear `turn_in_flight`, but the unresolved Stop survives until exactly one disposition. Live packaged Safe stop (`ac6c-stop-owner-b-fix`) proved that path — the ambiguous `error_during_execution` result arrived 15 ms after the interrupt and the Stop was still disposed only 5,194 ms later, at the bounded fallback, against the exact managed child (bound pid, CreationDate, executable SHA-256, process epoch, Attempt, session, turn epoch), with exactly one signal attempt. The blocker is now the signal itself: `GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT)` was rejected with win32 error 6 because `hide_native_console` spawns every native Runtime with `CREATE_NO_WINDOW`, so the child has no console to receive a console control event. GoalPort recorded neither A nor B and failed the Stop closed as `stopKind=unverified`. Official Agent SDK this hour still quotes no unique this-turn cancel field, so bare EDE is not A and M1 remains **implement-B**. Freeze `bce967ce` is not an admission bearer. Driver `status=PASS` is not AC6c, and the driver's own cancel status is now `UNMET` whenever the product payload is unresolved. Sealed notice-stop-dup remains `PARTIALLY_ADMITTED` on `649ee756`. Sealed freeze `5f5e78be` remains `NOT_ADMITTED`. Completed live-deny and fail-open runs remain `PARTIALLY_ADMITTED` on `4c435cfe`/`ef19dcfb`. Evidence lives under `goal-runs/goalport-claude-ac6c-stop-admission/evidence`. Grok remains `ADMITTED` on its own freeze; that ruling is not Claude proof.

## Launch (Electron mainline)

```powershell
& '.\goal-runs\goalport-evidence-verifier-core-restart\evidence\electron-package\GoalPort-win32-x64\GoalPort.exe'
```

Claude AC6c stop admission candidate (this run, owner B-fix freeze `8bd5fd60`):

```powershell
& '.\goal-runs\goalport-claude-ac6c-stop-admission\evidence\electron-package-owner-b-fix\GoalPort-win32-x64\GoalPort.exe'
```

Claude notice/stop/dup admission package (historical, `PARTIALLY_ADMITTED`):

```powershell
& '.\goal-runs\goalport-claude-notice-stop-dup-admission\evidence\electron-package\GoalPort-win32-x64\GoalPort.exe'
```

Claude live deny admission package (historical, `PARTIALLY_ADMITTED`):

```powershell
& '.\goal-runs\goalport-claude-live-deny-admission\evidence\electron-package\GoalPort-win32-x64\GoalPort.exe'
```

Claude deny/fail-open admission package (historical, `PARTIALLY_ADMITTED`):

```powershell
& '.\goal-runs\goalport-claude-deny-fail-open-admission\evidence\electron-package\GoalPort-win32-x64\GoalPort.exe'
```

Claude native-control admission package (historical, `NOT_ADMITTED`):

```powershell
& '.\goal-runs\goalport-claude-native-control-admission\evidence\electron-package\GoalPort-win32-x64\GoalPort.exe'
```

Grok native-admission package (historical):

```powershell
& '.\goal-runs\goalport-grok-native-admission\evidence\electron-package\GoalPort-win32-x64\GoalPort.exe'
```

Closure package (historical):

```powershell
& '.\goal-runs\goalport-stable-v1-closure\evidence\electron-package\GoalPort-win32-x64\GoalPort.exe'
```

Claude post-Stop continuation candidate (this run, `claude-stop-continuation`):

```powershell
pwsh -NoProfile -File .\goal-runs\claude-stop-continuation\launch-candidate.ps1
```

Each launch verifies the packaged artifact hashes against this run's manifest, then creates a
new isolated workspace and database under that run folder. There is deliberately no
`-EvidenceView` switch: the prior run's equivalent points Core at that run's accepted
acceptance database, and Core startup writes to it. Inspect a protected database by copying it
and opening the copy read-only.

This candidate adds a re-check and an isolated continuation. It does **not** release a held
workspace, and cannot; see `goal-runs/claude-stop-continuation/owner-decision-package.md`.

Build:

```powershell
pnpm build
pnpm electron:package
```

Isolated verification must set `GOALPORT_CORE_PIPE`, `GOALPORT_CORE_DB`, `GOALPORT_SYNTHETIC_ROOT`, and `GOALPORT_REQUIRE_ISOLATED=1`. Native authentication stays with the installed Runtime CLI. This run never opens the default userData SQLite.

AUMID is `GoalPort.Desktop`. No Start Menu shortcut is created.

## Current verification

PR CI is `.github/workflows/ci.yml` on Windows: `pnpm lint` / `pnpm test:unit`, Core in-memory contract tests, and the Tauri bridge unit tests. It does not run packaged Desktop, live Runtime admission, or isolated `GOALPORT_REQUIRE_ISOLATED` product launches.

```text
node --test scripts/connected/v1-isolated-env.test.mjs scripts/connected/v1-resume-chain.test.mjs scripts/connected/v1-core-restart.test.mjs
cargo test -p goalport-core --test core_restart_epoch --offline -- --test-threads=1
```

Claude AC6c stop admission bearers: `goal-runs/goalport-claude-ac6c-stop-admission/evidence` (`claude-admission.json`, `claude-gui-multiturn.json`, `claude-permission.json`, `claude-cancel.json`, `claude-resume.json`, `claude-multiruntime.json`, `handoff-core-report.json`, `native-ownership.json`, `claude-dup-cards.json`, `freeze-owner-b-fix.json`, `tests-owner-b-fix/`). The superseded gen3 bearers are preserved under `_backups/owner-b-fix-gen3-evidence-20260904T164206Z/` and the gen3 package and GUI database stay at `evidence/electron-package/` and `evidence/gui-gen3/`. Reproduce the Core contract layer with `cargo test -p goalport-core --test claude_stream --offline -- --test-threads=1`. Historical notice/stop/dup admission remains under `goal-runs/goalport-claude-notice-stop-dup-admission/evidence`. Historical live-deny admission remains under `goal-runs/goalport-claude-live-deny-admission/evidence`. Historical fail-open admission remains under `goal-runs/goalport-claude-deny-fail-open-admission/evidence`. Sealed historical Claude admission remain under `goal-runs/goalport-claude-native-control-admission/evidence`.

Grok native-admission bearers: `goal-runs/goalport-grok-native-admission/evidence/{grok-admission.json,grok-gui-multiturn.json,grok-fail-closed.json,native-ownership.json,handoff.json,freeze.json}` plus `goal-runs/goalport-grok-native-admission/evidence/tests/`. Reproduce the Core contract layer with `cargo test -p goalport-core --test grok_acp --offline`.

Current hardening bearers: `goal-runs/goalport-evidence-verifier-core-restart/evidence/{freeze.json,core-restart.json,resume-chain-graceful.json,resume-chain-kill.json}`. The immutable old obs-b10 reports are now UNMET under the hardened live-identity/schema predicates and remain unchanged. Closure historical table remains `goal-runs/goalport-stable-v1-closure/evidence/acceptance.json`. The 1800-second soak was not rerun.
