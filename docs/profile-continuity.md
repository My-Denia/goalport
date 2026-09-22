# Profile continuity & startup model (dev candidate redesign)

Status: development-candidate documentation for the startup-continuity redesign.
This does not describe the previously shipped rc.1 build.

## The problem this replaces

rc.1-era startup bound every data profile to the BUILDING binary: the profile
marker stored `version` + `coreSha256` and any differently-built executable
refused to start with "This data profile belongs to another RC build". Data
format compatibility and builder identity were one check. Every rebuild meant a
new empty profile or a `--data-dir` incantation.

## The four boundaries

1. **Profile identity** (the marker, `goalport-profile.json`). Marker v2 keeps
   product + path-derived `profileKey` + mode + owning channel. `createdBy` /
   `lastOpenedBy` / `importedFrom` are provenance, never reopen conditions.
   Marker v1 (rc.1-era) is read as provenance and adopted in place only through
   an explicit, backed-up upgrade of an explicit `--data-dir`.
2. **Data format compatibility**. Single authority: the `schema_migrations`
   table, inspected by `goalport-core profile inspect` through a READ-ONLY
   connection (never a migrating open). Compatible ⇔ openable and
   `max(version) <= SCHEMA_VERSION`. Newer formats are refused honestly.
   `marker.schema*` and `PRAGMA user_version` are not compatibility authorities.
3. **Current instance identity** (unchanged in strength). Startup receipts,
   pipe-peer verification, `assertCoreIdentity`, the epoch CAS chain, nonce
   replay refusal all remain. New: an imported snapshot's copied epoch is
   marked `IMPORTED_SNAPSHOT` with in-row provenance, and the startup CAS
   treats that latest epoch as prior-Ended — the recorded pid belongs to the
   source directory's server.
4. **Distribution channels.** `release` (CI default) keeps `GoalPort/rc`;
   packaged dev candidates and unpackaged development share `GoalPort/dev`
   (stable across builds — no per-hash forks). `--test-profile` stays
   synthetic-test. `--user-data-dir` (the standard Chromium switch) relocates
   the application-data root; the full default selection still runs inside
   the relocated root. Inside every application-data root, the
   **Electron/Chromium browser-state namespace** (`GoalPort/electron/
   <profileKey>`) is a separate directory from the durable profile root; the
   browser-state path is bound to the canonical durable `profileKey` only —
   never to the Core hash — so a differently-built candidate reuses the same
   browser identity. A synthetic `--test-profile` keeps its browser state in
   a test-owned sibling (`<parent>/electron/<profileKey>`), never in the real
   application-data root.

## Startup flow

Path resolution verifies physical separation after canonicalizing existing
ancestors, including Windows junctions and short names. Equal roots and either
direction of nesting are refused before browser-state creation. Browser state
must stay inside its relocated app-data or test-owned parent. An impossible
explicit layout is refused with an explanation, never silently relocated.
The check runs again around directory creation before the writable probe and
Electron session binding.

Development Core and launcher paths are resolved once before launch-variable
sanitization. Inspection, hashing, launch and peer verification reuse those
paths; sanitization cannot change the selected executable halfway through startup.

The storage-boundary startup sequence, in order:

1. Argument validation (`--data-dir` / `--test-profile` exclusivity,
   absolute paths).
2. Canonical durable path resolution (channel directory, explicit
   `--data-dir`, or the relocated root of `--user-data-dir`).
3. `profileKey` derivation from the canonical durable identity alone.
4. Derivation of the separate `browserStateDirectory`
   (`GoalPort/electron/<profileKey>`, or the test-owned sibling for
   `--test-profile`).
5. Creation and writability probe of the **browser-state** directory only —
   the durable root is never created or written pre-ready.
6. `app.setPath(userData, browserStateDirectory)` — Chromium can from now on
   only ever write inside the browser-state namespace.
7. Free Electron/Chromium initialization.
8. BrowserWindow creation.
9. ProfileManager inspects **only the durable root** (marker, journal,
   directory content, read-only `profile inspect`).
10. The compatibility decision: fresh / reopen / import offer / refusal /
    coordination — fail-closed first.
11. On fresh, only the ProfileManager creates the durable marker and profile
    state; `beginFresh` is the single writer.
12. `profileReady` becomes true only after a valid disposition.
13. Core start/attach (launcher, receipt, pipe-peer verification).
14. Core opens the durable SQLite path.
    A separate read-only post-open inspection verifies the actual schema and
    integrity before the marker records the successful open. The original
    classification trace remains labelled `classification`; the subsequent
    check is labelled `post-core-open`. Neither is the post-failure re-probe.
    Missing, failed or unrecordable facts prevent `done`. A previously opened
    profile whose database is lost is refused, including older markers whose
    schema field was left null.
15. The renderer begins snapshot polling only after the bootstrap reaches
    `done` (`coreReady` positive signal; hosts without a bootstrap channel
    are ready immediately). The profile-less legacy isolated branch also
    pushes `done` after its Core attach, so a gating renderer never waits on
    a permanent `checking`.

The durable root's writability is classified honestly by the bootstrap
(`readonly-dir` / `disk-full` error screens with a window on screen) instead
of a pre-ready probe; a read-only or full durable location therefore never
produces a pre-ready death.

Post-ready bootstrap (`profile-manager.cjs` + boot-shell screens): fresh init →
marker v2; compatible reopen (any build of the channel) → silent, with a
verified consistency Backup-API snapshot before the first open by a new build
(rotation keeps 3, never prunes the newest, checkpointed to a single file);
discovered foreign-channel profile (rc) → one-time import offer with real
facts (source path, created-by, content counts, live-source disclosure) →
verified copy into the channel's own directory with a crash-safe journal
(copying → finalized → marker-last); live prior Core of another build →
coordination screen (retry / show folder / exit; never kills, never preempts);
same-build live Core → normal attach (continue-background resume); newer
schema / legacy surface / corrupt marker / missing database → distinct error
screens that preserve the data and offer an explicit fresh-directory choice.

## Storage operations (`goalport-core profile …`)

- `inspect --db P [--quick-check]` — read-only facts incl. epoch liveness.
- `backup --db P --out Q [--allow-write-open]` — Online Backup API copy,
  verified (quick_check + schema version + row-count parity), checkpointed.
- `import --source-db P --staging-dir D [--allow-source-recovery]` — verified
  copy + `IMPORTED_SNAPSHOT` epoch marking + provenance; source untouched.

Import journal finalization checks the staging path before writing the marker
or deleting anything: it must be a direct `.import-staging-*` child of this
durable root and cannot be a redirected directory. Invalid recovery records are
retained with an import refusal, rather than used as cleanup authority.

Exit contract: one JSON line; success 0, failure 3 with `{ok:false, error}`.
