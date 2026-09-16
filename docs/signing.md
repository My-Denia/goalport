# Signing, SmartScreen, and the native-evidence gate

This page is read-only research and a decision packet for the owner. It does
not purchase a certificate, apply to a signing service, import a private
key, or configure a repository secret. See [releasing](releasing.md) for how
a signed build would flow through packaging.

## Default gate

**Trusted signing = required.** A Windows x64 RC ZIP is not published to the
public without a trusted Authenticode signature on GoalPort-owned binaries,
unless the owner separately and explicitly approves publishing an unsigned
RC. Nothing in this round changes that default.

## Current Authenticode inventory (read-only, from a real build)

Produced by `pnpm release:authenticode -- <package-directory>`
(`scripts/release/authenticode-inventory.mjs`, which only calls
PowerShell's `Get-AuthenticodeSignature`; it signs nothing) against the
`GoalPort-win32-x64` package built from commit `29ccf2291c28dc037374c89cc47b214c3403bb90`.

Release-maintainer tooling depends explicitly on **PowerShell 7 (`pwsh`)**
for this check, not Windows PowerShell 5.1. Windows PowerShell's
`powershell.exe` was tried first and disproven on a real GitHub-hosted
`windows-latest` runner: `Get-AuthenticodeSignature` failed to autoload on
one run ("CouldNotAutoloadMatchingModule"), and an explicit `Import-Module`
added to work around that instead threw a terminating
`FormatXmlUpdateException` ("member already present") on a later run,
because that runner's session had already registered the module's
format/type data. PowerShell 7 ships `Microsoft.PowerShell.Security`
(the module `Get-AuthenticodeSignature` lives in) as a built-in part of the
engine rather than a lazily autoloaded snap-in, and reproduced neither
failure — verified directly against both a local Windows dev machine and a
cold GitHub Actions `windows-latest` checkout, not assumed from either
alone. `pwsh` ships preinstalled on GitHub's `windows-latest` runner image;
a local maintainer machine needs it installed separately from Windows
PowerShell.

| File | Category | Status | Signer |
| --- | --- | --- | --- |
| `GoalPort.exe` | GoalPort-owned | **NotSigned** | — |
| `resources/goalport-core.exe` | GoalPort-owned | **NotSigned** | — |
| `resources/goalport-core-launcher.exe` | GoalPort-owned | **NotSigned** | — |
| `resources/goalport-claude-stop-broker.exe` | GoalPort-owned | **NotSigned** | — |
| `d3dcompiler_47.dll` | Electron-upstream | Valid | Microsoft Windows |
| `dxil.dll` | Electron-upstream | Valid | Microsoft Windows |
| `dxcompiler.dll` | Electron-upstream | NotSigned | — |
| `ffmpeg.dll` | Electron-upstream | NotSigned | — |
| `vk_swiftshader.dll` | Electron-upstream | NotSigned | — |
| `vulkan-1.dll` | Electron-upstream | NotSigned | — |

Two things worth being explicit about, because both are easy to get wrong
by assumption instead of measurement:

- **`GoalPort.exe` is not signed**, even though it started life as
  Electron's own executable. `electron-packager` rewrites its resources
  (icon, version info, product name) to produce `GoalPort.exe`, which
  invalidates any signature the upstream binary carried. Do not describe
  GoalPort as "signed" because it descends from Electron's binary — measure
  it, as above.
- **Not every Electron-upstream DLL is signed either.** Only 2 of the 6
  upstream DLLs in this package carry a valid Microsoft signature; the
  rest (`dxcompiler.dll`, `ffmpeg.dll`, `vk_swiftshader.dll`,
  `vulkan-1.dll`) ship unsigned exactly as Electron distributes them. This
  is outside GoalPort's control and is not a GoalPort signing gap.

Running locally without warnings is not evidence about the public-download
experience: Windows' Mark-of-the-Web (MOTW) and SmartScreen reputation
checks apply to files carrying the zone-identifier stream a browser or
`Invoke-WebRequest` attaches on download from the internet, which a locally
built package never has. Real MOTW/SmartScreen behavior for a downloaded
ZIP is part of release smoke on an actual GitHub Release download, not this
round.

## Signing route comparison

| Route | Fits GoalPort now? | Cost | Notes |
| --- | --- | --- | --- |
| **Azure Trusted Signing** (Microsoft's current non-Store route, successor to the retired individual EV token program) | Plausible | Monthly Azure subscription + per-signature usage; requires a Microsoft Entra tenant and an approved signing identity (individual identity validation is available, but Microsoft has tightened eligibility over time — verify current requirements before relying on this) | Cloud HSM-backed, integrates with `signtool`/`azuresigntool` in CI, includes RFC 3161 timestamping. Newly-signed publishers still start with no SmartScreen reputation. |
| **Ordinary OV code-signing certificate** (DigiCert, SSL.com, etc.) | Plausible | Recurring annual cost (typically USD 100-400/yr depending on issuer and token requirements); OV certs are commonly issued on a hardware token, which complicates headless CI signing | Long-established route; some CAs now require hardware-backed keys per CA/Browser Forum rules, which can force a signing step onto a physical machine rather than a GitHub-hosted runner. |
| **SignPath Foundation** (free signing for qualifying OSS projects) | Worth applying for | Free if accepted | GoalPort is public and Apache-2.0, which is the right shape for this program, but acceptance is Foundation's discretion (project maturity, community signals) and is not guaranteed. Signing happens through SignPath's CI integration with a reviewed, reproducible build step — would need packaging changes to fit their model. Do not assume acceptance; this is a route to evaluate, not a plan to rely on. |
| **Self-signed certificate** | Not a public-distribution solution | Free | A self-signed cert satisfies "is this binary the same bytes it was when signed" but not "does Windows or any other user trust the publisher." It does not reduce or remove SmartScreen warnings for a public download. Only useful for internal/dev-only signing verification of the seam itself, never presented to end users as "signed". |

None of these are purchased, applied for, or configured in this round.
Recommended next owner action, in order: evaluate SignPath Foundation
eligibility first (it is free and fits a public Apache-2.0 project), and
independently price Azure Trusted Signing / an OV certificate as the fallback
if SignPath does not accept the project or its CI model does not fit.

Recurring considerations regardless of route:

- **Credential/identity requirements**: most non-self-signed routes require
  real identity verification (individual or organization) before issuing a
  usable signing identity — budget calendar time, not just money.
- **CI integration**: a signing step that needs a hardware token or an
  interactive login cannot run unattended on a GitHub-hosted runner without
  extra infrastructure (a self-hosted signing host, or a cloud HSM API like
  Trusted Signing/SignPath that supports headless calls).
- **Timestamping**: any signature should be RFC 3161 timestamped so it
  remains valid after the signing certificate itself expires.
- **Publisher display**: the "Verified publisher" name Windows shows comes
  from the certificate's subject; decide what legal/display name GoalPort
  should present before requesting a certificate, since reissuing to change
  it is not free with paid CAs.
- **SmartScreen limitations**: signing does not grant instant trust. A
  newly-signed, low-download-volume publisher can still see SmartScreen
  warnings until enough reputation accumulates from real downloads. Do not
  promise "signed means no more SmartScreen warning" in release notes or to
  users.

## SmartScreen / Mark-of-the-Web

- The current unsigned candidate has no Authenticode signature on any
  GoalPort-owned binary (see inventory above), so a public download is
  expected to trigger a SmartScreen "Windows protected your PC" prompt.
- Signing reduces but does not eliminate this: a signed-but-new publisher
  still commonly sees a warning until Microsoft's reputation service has
  seen enough clean downloads and executions of that specific certificate.
- Self-signed certificates do not affect public SmartScreen trust at all.
- **Smart App Control** (Windows 11) and enterprise application-control
  policies can be stricter than consumer SmartScreen and may block an
  unsigned or low-reputation binary outright rather than just warning.
  Users under such policies may not be able to run this RC at all without
  an administrator exception, signed or not, until reputation is
  established.
- None of this is verified against a real internet download in this round;
  running the local package without a warning proves nothing about the
  public-download experience, because MOTW is only attached by the
  download itself.

## Signing order contract (for whenever real signing is wired in)

Audited from the current `scripts/desktop/package.mjs` build order. Today,
with no signing step, the order is: build Rust binaries → hash them into
`build-info.json`/`package-manifest.json` → package → verify. Introducing
real signing must preserve one invariant end to end: **every hash recorded
anywhere is a hash of the final, already-signed bytes** — never hash first
and sign after, which would leave the manifest silently stale.

**GoalPort-owned Rust PE** (`goalport-core.exe`, `goalport-core-launcher.exe`,
`goalport-claude-stop-broker.exe`):

```
cargo build --release
  -> sign each binary
  -> compute the embedded component hash (buildInfo.components[name])
  -> embed build-info.json into the staged app
  -> package with electron-packager
```

**Final Electron executable / other GoalPort-owned package PE**
(`GoalPort.exe`; today nothing else in the package root is GoalPort-owned):

```
electron-packager produces the package
  -> sign GoalPort.exe
  -> compute the final package-manifest.json artifact inventory/hashes
  -> write package-manifest.json
  -> electron:verify
```

The exact mechanics of the second step depend on how signing is invoked
(electron-packager has no built-in Windows signing hook in this project's
current setup; a real integration would most likely sign as a manifest-free
post-packaging step before manifest generation, not through
electron-packager's own signing option, unless that option is adopted
deliberately later). Whatever the mechanism, the result must guarantee:

- embedded component hashes in `build-info.json`/`resources/app.asar`
  correspond to the signed bytes of each Rust binary;
- `package-manifest.json` artifact hashes correspond to the final signed
  `GoalPort.exe` and to the (already-hashed-when-signed) Rust binaries;
- `electron:verify` still passes after signing, with no code changes to
  `verify-package.mjs`'s expectations;
- there is no path where a hash is computed, the file is signed afterward,
  and the stale pre-signing hash ships in the manifest.

This round adds no signing credential and produces no real signature. It
records this seam so that when a credential exists, the packaging change is
mechanical rather than a redesign.

## Native runtime exact-build gate

Historical native-Runtime admission records (Codex, Claude Code, Grok) are
tied to specific past builds, not to "GoalPort" in the abstract. The current
source-built package in this round has **not** been re-admitted against any
native Runtime, and this round does not call a real Codex/Claude/Grok model
or spend subscription quota to do so — that would just consume real API
usage for a readiness rehearsal, not produce useful admission evidence.

**Default: no exact-build native evidence -> binary release not ready.**
Synthetic Scenario Runtime checks (used throughout this round's smoke
tests) are not a substitute for native evidence and never upgrade this
package's status to "admitted."

Before the first public binary release, one of these must happen, against
the exact commit and exact packaged bytes being published:

1. re-run the existing native admission/support contracts
   ([runtime support matrix](reference/runtime-support-matrix.md)) against
   this exact build for each Runtime intended to ship as admitted at
   launch, or
2. the owner explicitly and separately waives native re-validation for a
   named Runtime for this specific release, accepting the consequence that
   its admission label is carried over rather than freshly proven.

If the source or packaged bytes change after native validation runs (any
new commit, any repackage), that evidence is stale for the new bytes and
the question must be re-asked — evidence does not follow the product name
across a rebuild.
