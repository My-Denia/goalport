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
   the application-data root; the full default selection still runs inside the
   relocated root.

## Startup flow

Module init (pre-ready): argument validation, channel/dir resolution, mkdir,
writability probe, `app.setPath(userData)`. Nothing else refuses there.

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

Exit contract: one JSON line; success 0, failure 3 with `{ok:false, error}`.
