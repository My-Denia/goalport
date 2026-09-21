//! Profile-level storage operations for startup continuity.
//!
//! Scope: READ-ONLY compatibility inspection, verified consistency backup, and
//! staged import of a foreign-channel profile copy. These operations never run
//! `Store::migrate` and never touch the source profile in place (the only
//! physical source interaction is the SQLite Online Backup API — and a
//! consented write-open when the caller explicitly passes
//! `--allow-source-recovery` for a WAL database whose shared-memory file is
//! missing).
//!
//! Output contract (like `pipe-peer`): exactly one JSON line on stdout;
//! success exits 0, every failure exits 3 with `{ok:false, stage, error}`.

use crate::product_receipts;
use crate::store;
use rusqlite::backup::Backup;
use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};

pub const PROFILE_OPS_SCHEMA: &str = "goalport.profile-ops.v1";
pub const PROFILE_OPS_FAILURE_EXIT: u8 = 3;

fn open_readonly(db: &Path) -> Result<Connection, String> {
    Connection::open_with_flags(
        db,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| error.to_string())
}

fn open_readwrite(db: &Path) -> Result<Connection, String> {
    Connection::open_with_flags(
        db,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| error.to_string())
}

fn table_names(connection: &Connection) -> Result<Vec<String>, String> {
    let mut statement = connection
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    let mut names = Vec::new();
    for row in rows {
        names.push(row.map_err(|error| error.to_string())?);
    }
    Ok(names)
}

fn schema_version(connection: &Connection) -> Result<Option<i64>, String> {
    let tables = table_names(connection)?;
    if !tables.iter().any(|name| name == "schema_migrations") {
        return Ok(None);
    }
    let version: i64 = connection
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
            [],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    Ok(Some(version))
}

fn business_counts(connection: &Connection) -> Result<Value, String> {
    let tables = table_names(connection)?;
    let mut counts = json!({});
    for table in ["campaigns", "tasks", "attempts", "events", "decisions", "outbox", "stop_responsibilities"] {
        if tables.iter().any(|name| name == table) {
            let count: i64 = connection
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get(0))
                .map_err(|error| error.to_string())?;
            counts[table] = json!(count);
        }
    }
    Ok(counts)
}

fn quick_check(connection: &Connection) -> Result<String, String> {
    let result: String = connection
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    Ok(result)
}

fn latest_epoch_summary(connection: &Connection) -> Result<Value, String> {
    let tables = table_names(connection)?;
    if !tables.iter().any(|name| name == "core_launch_epochs") {
        return Ok(Value::Null);
    }
    let row = connection
        .query_row(
            "SELECT epoch_id, launch_nonce, core_pid, core_creation_date,
                    core_executable_path, core_executable_sha256, state, active_slot
             FROM core_launch_epochs ORDER BY rowid DESC LIMIT 1",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, Option<i64>>(7)?,
                ))
            },
        )
        .map(|row| row)
        .or_else(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => Ok((
                String::new(), String::new(), 0, String::new(), String::new(),
                String::new(), String::new(), None,
            )),
            other => Err(other),
        })
        .map_err(|error: rusqlite::Error| error.to_string())?;
    let (epoch_id, launch_nonce, core_pid, core_creation_date, core_executable_path, core_executable_sha256, state, active_slot) = row;
    if epoch_id.is_empty() {
        return Ok(Value::Null);
    }
    // Same liveness classification the startup epoch CAS uses: pid +
    // creation date + executable path. "live" means the recorded Core process
    // of THIS directory's history is still running.
    let prior_core = if state == "IMPORTED_SNAPSHOT" {
        "imported-snapshot".to_string()
    } else {
        match product_receipts::classify_recorded_process(
            u32::try_from(core_pid).unwrap_or(0),
            &core_creation_date,
            &core_executable_path,
        ) {
            product_receipts::PriorCoreStatus::NoPrior | product_receipts::PriorCoreStatus::Ended => "ended",
            product_receipts::PriorCoreStatus::LiveExact => "live-exact",
            product_receipts::PriorCoreStatus::Unknown => "unknown",
        }
        .to_string()
    };
    Ok(json!({
        "epochId": epoch_id,
        "launchNonce": launch_nonce,
        "state": state,
        "activeSlot": active_slot,
        "priorCore": prior_core,
        "coreExecutableSha256": core_executable_sha256,
    }))
}

/// `profile inspect --db P [--quick-check]`: read-only compatibility facts.
/// NEVER migrates, never writes (a read-only connection cannot).
pub fn inspect(db: &Path, want_quick_check: bool) -> Result<Value, String> {
    let mut result = json!({
        "schema": PROFILE_OPS_SCHEMA,
        "ok": true,
        "stage": "inspect",
        "database": db.display().to_string(),
    });
    let metadata = fs::metadata(db);
    let Some(meta) = metadata.ok() else {
        result["exists"] = json!(false);
        result["openable"] = json!(false);
        result["schemaVersion"] = json!(null);
        return Ok(result);
    };
    result["exists"] = json!(true);
    result["bytes"] = json!(meta.len());
    for suffix in ["-wal", "-shm"] {
        let side = fs::metadata(PathBuf::from(format!("{}{suffix}", db.display()))).ok();
        if suffix == "-wal" {
            result["walBytes"] = json!(side.map(|meta| meta.len()).unwrap_or(0));
        } else {
            result["shmPresent"] = json!(side.is_some());
        }
    }
    let connection = match open_readonly(db) {
        Ok(connection) => connection,
        error @ Err(_) => {
            // A WAL database whose -shm is missing/stale cannot be opened
            // read-only; report that honestly instead of guessing. The caller
            // decides whether a consented recovering open may happen.
            result["openable"] = json!(false);
            result["needsRecovery"] = json!(true);
            result["schemaVersion"] = json!(null);
            if let Err(message) = error {
                result["error"] = json!(message);
            }
            return Ok(result);
        }
    };
    result["openable"] = json!(true);
    result["needsRecovery"] = json!(false);
    let version = schema_version(&connection)?;
    result["schemaVersion"] = match version {
        Some(version) => json!(version),
        None => {
            // No migrations table: either a brand-new empty file or a foreign
            // legacy database we must not adopt silently.
            let tables = table_names(&connection)?;
            let internal_only = tables.iter().all(|name| name.starts_with("sqlite_"));
            result["empty"] = json!(internal_only && tables.is_empty());
            result["foreignTables"] = json!(tables.len());
            json!(null)
        }
    };
    result["currentSchemaVersion"] = json!(store::SCHEMA_VERSION);
    result["counts"] = business_counts(&connection)?;
    result["latestEpoch"] = latest_epoch_summary(&connection)?;
    if want_quick_check {
        result["quickCheck"] = json!(quick_check(&connection)?);
    }
    Ok(result)
}

fn backup_inner(source: &Connection, destination: &mut Connection) -> Result<(), String> {
    let backup = Backup::new(source, destination).map_err(|error| error.to_string())?;
    backup
        .run_to_completion(200, std::time::Duration::from_millis(5), None)
        .map_err(|error| error.to_string())
}

/// `profile backup --db P --out Q [--allow-write-open]`: SQLite Online Backup
/// API copy with post-copy verification (quick_check + schema version + core
/// table row-count parity). `out` must not exist; the source is opened
/// read-only unless `--allow-write-open` is set (consented WAL recovery).
pub fn backup(db: &Path, out: &Path, allow_write_open: bool) -> Result<Value, String> {
    if !db.exists() {
        return Err(format!("source database does not exist: {}", db.display()));
    }
    if out.exists() {
        return Err(format!("refusing to overwrite existing backup: {}", out.display()));
    }
    if let Some(parent) = out.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("cannot create backup directory: {error}"))?;
    }
    let mut result = json!({
        "schema": PROFILE_OPS_SCHEMA,
        "ok": true,
        "stage": "backup",
        "source": db.display().to_string(),
        "out": out.display().to_string(),
    });
    let source = match open_readonly(db) {
        Ok(connection) => {
            result["sourceOpenMode"] = json!("read-only");
            connection
        }
        Err(error) => {
            if !allow_write_open {
                return Err(format!(
                    "source cannot be opened read-only (WAL recovery needed) and --allow-write-open was not set: {error}"
                ));
            }
            result["sourceOpenMode"] = json!("read-write-recovery");
            open_readwrite(db)?
        }
    };
    let source_version = schema_version(&source)?
        .ok_or_else(|| "source has no schema_migrations table; refusing to back up a non-GoalPort database".to_string())?;
    let source_counts = business_counts(&source)?;
    let mut destination = open_readwrite(out)?;
    backup_inner(&source, &mut destination)?;
    // Verify the backup BEFORE the caller may rely on it.
    let verified = open_readonly(out)?;
    let check = quick_check(&verified)?;
    if check != "ok" {
        let _ = fs::remove_file(out);
        return Err(format!("backup verification failed quick_check: {check}"));
    }
    let out_version = schema_version(&verified)?
        .ok_or_else(|| "backup lost its schema_migrations table".to_string())?;
    if out_version != source_version {
        let _ = fs::remove_file(out);
        return Err(format!(
            "backup schema version {out_version} differs from source {source_version}"
        ));
    }
    let out_counts = business_counts(&verified)?;
    if out_counts != source_counts {
        let _ = fs::remove_file(out);
        return Err("backup row counts differ from source".to_string());
    }
    // Durability: flush the verified file to disk. The destination connection
    // may have created WAL side files during the copy/verify — checkpoint the
    // backup so a restore that copies only the main file loses nothing, then
    // remove the side files.
    drop(verified);
    {
        let checkpoint = open_readwrite(out)?;
        checkpoint
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| row.get::<_, i64>(2))
            .map_err(|error| error.to_string())?;
        drop(checkpoint);
    }
    drop(destination);
    for suffix in ["-wal", "-shm"] {
        let side = PathBuf::from(format!("{}{suffix}", out.display()));
        if side.exists() {
            fs::remove_file(&side).map_err(|error| format!("cannot remove backup {suffix}: {error}"))?;
        }
    }
    let file = fs::OpenOptions::new()
        .write(true)
        .open(out)
        .map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    drop(file);
    result["schemaVersion"] = json!(source_version);
    result["counts"] = source_counts;
    result["quickCheck"] = json!("ok");
    result["bytes"] = json!(fs::metadata(out).map(|meta| meta.len()).unwrap_or(0));
    Ok(result)
}

/// `profile import --source-db P --staging-dir D --provenance JSON
/// [--allow-source-recovery]`: verified backup into `D/goalport.sqlite`, then
/// mark the copied epoch chain with the recorded import provenance and
/// checkpoint the staging file so it ships as a single consistent database.
/// The SOURCE is never modified (read-only open unless recovery is consented).
pub fn import(
    source_db: &Path,
    staging_dir: &Path,
    provenance: &Value,
    allow_source_recovery: bool,
) -> Result<Value, String> {
    if !staging_dir.exists() {
        fs::create_dir_all(staging_dir)
            .map_err(|error| format!("cannot create staging directory: {error}"))?;
    }
    let staging_db = staging_dir.join("goalport.sqlite");
    if staging_db.exists() {
        return Err(format!(
            "staging database already exists (unfinished import?): {}",
            staging_db.display()
        ));
    }
    let mut report = backup(source_db, &staging_db, allow_source_recovery)?;
    report["stage"] = json!("import");
    // Mark the copied epoch chain: only the LATEST row (the one the startup
    // CAS looks at). History below it stays untouched and immutable.
    let mut staging = open_readwrite(&staging_db)?;
    let mut marked_epoch: Option<String> = None;
    {
        let transaction = staging
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|error| error.to_string())?;
        let latest: Option<(String, Option<String>)> = transaction
            .query_row(
                "SELECT epoch_id, reconciliation_json FROM core_launch_epochs ORDER BY rowid DESC LIMIT 1",
                [],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .map(|row| Some(row))
            .or_else(|error| match error {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(other),
            })
            .map_err(|error: rusqlite::Error| error.to_string())?;
        if let Some((epoch_id, raw)) = latest {
            let mut reconciliation: Value = raw
                .and_then(|raw| serde_json::from_str(&raw).ok())
                .unwrap_or_else(|| json!({}));
            let object = reconciliation
                .as_object_mut()
                .ok_or("latest epoch reconciliation_json is not an object")?;
            object.insert("importedSnapshot".into(), json!(true));
            object.insert("importedFrom".into(), json!(provenance.get("source").cloned().unwrap_or(Value::Null)));
            object.insert("importedAtUtc".into(), json!(store::utc_now_iso()));
            object.insert("importProvenance".into(), provenance.clone());
            transaction
                .execute(
                    "UPDATE core_launch_epochs
                     SET state='IMPORTED_SNAPSHOT', active_slot=NULL, reconciliation_json=?2
                     WHERE epoch_id=?1",
                    rusqlite::params![epoch_id, reconciliation.to_string()],
                )
                .map_err(|error| error.to_string())?;
            marked_epoch = Some(epoch_id);
        }
        transaction
            .commit()
            .map_err(|error| error.to_string())?;
    }
    // Ship as one file: checkpoint WAL into the main database and truncate.
    staging
        .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| row.get::<_, i64>(2))
        .map_err(|error| error.to_string())?;
    drop(staging);
    for suffix in ["-wal", "-shm"] {
        let side = PathBuf::from(format!("{}{suffix}", staging_db.display()));
        if side.exists() {
            fs::remove_file(&side).map_err(|error| format!("cannot remove staging {suffix}: {error}"))?;
        }
    }
    let file = fs::OpenOptions::new()
        .write(true)
        .open(&staging_db)
        .map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    drop(file);
    report["stagingDb"] = json!(staging_db.display().to_string());
    report["markedEpoch"] = match marked_epoch {
        Some(id) => json!(id),
        None => json!(null),
    };
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("goalport-profile-ops-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn inspect_reports_missing_database() {
        let dir = temp_dir("inspect-missing");
        let value = inspect(&dir.join("none.sqlite"), false).unwrap();
        assert_eq!(value["exists"], json!(false));
        assert_eq!(value["ok"], json!(true));
    }

    #[test]
    fn inspect_reports_schema_version_and_epoch() {
        let dir = temp_dir("inspect-basic");
        let db = dir.join("goalport.sqlite");
        {
            let _store = Store::open(&db).unwrap();
            // Synthetic epoch row (test fixture): a recorded pid that does not
            // exist on this machine, path pointing nowhere.
            open_readwrite(&db)
                .unwrap()
                .execute(
                    "INSERT INTO core_launch_epochs(epoch_id, launch_nonce, core_pid, core_creation_date,
                         core_executable_path, core_executable_sha256, previous_epoch_id, state, active_slot,
                         reconciliation_json, created_at, activated_at)
                     VALUES ('e1','n1',4194303,'/Date(1)/','Z:/nowhere/core.exe','aa',NULL,'READY_COMMITTED',1,NULL,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')",
                    [],
                )
                .unwrap();
        }
        let value = inspect(&db, true).unwrap();
        assert_eq!(value["exists"], json!(true));
        assert_eq!(value["openable"], json!(true));
        assert_eq!(value["schemaVersion"], json!(store::SCHEMA_VERSION));
        assert_eq!(value["quickCheck"], json!("ok"));
        // A recorded pid that does not exist on this machine reads as ended or
        // unknown — both are honest; what must NEVER appear is live-exact.
        let prior = value["latestEpoch"]["priorCore"].as_str().unwrap();
        assert!(prior == "ended" || prior == "unknown", "priorCore={prior}");
    }

    #[test]
    fn backup_copies_wal_committed_data_verifiably() {
        let dir = temp_dir("backup-wal");
        let db = dir.join("goalport.sqlite");
        {
            let store = Store::open(&db).unwrap();
            store.insert_project(&crate::domain::Project { id: "p1".into(), workspace_root: "ws1".into() }).unwrap();
            store.create_campaign_with_task(
                "p1",
                &crate::domain::Campaign { id: "c1".into(), goal: "goal one".into(), root_task_id: "t1".into(), state: Default::default() },
                &crate::domain::Task { id: "t1".into(), campaign_id: "c1".into(), title: "do it".into(), acceptance: "done".into(), state: Default::default() },
            )
            .unwrap();
            // Connection stays in WAL mode; committed rows may live in the
            // WAL only — exactly the owner-profile shape we must back up.
        }
        assert!(dir.join("goalport.sqlite-wal").exists() || fs::metadata(&db).unwrap().len() > 4096);
        let out = dir.join("backup.sqlite");
        let report = backup(&db, &out, false).unwrap();
        assert_eq!(report["quickCheck"], json!("ok"));
        assert_eq!(report["schemaVersion"], json!(store::SCHEMA_VERSION));
        assert_eq!(report["counts"]["campaigns"], json!(1));
        assert_eq!(report["counts"]["tasks"], json!(1));
        let verify = open_readonly(&out).unwrap();
        let goal: String = verify
            .query_row("SELECT goal FROM campaigns LIMIT 1", [], |row| row.get(0))
            .unwrap();
        assert_eq!(goal, "goal one");
    }

    #[test]
    fn import_marks_latest_epoch_and_serves_new_directory() {
        let dir = temp_dir("import-epoch");
        let source = dir.join("source.sqlite");
        {
            let _store = Store::open(&source).unwrap();
            open_readwrite(&source)
                .unwrap()
                .execute(
                    "INSERT INTO core_launch_epochs(epoch_id, launch_nonce, core_pid, core_creation_date,
                         core_executable_path, core_executable_sha256, previous_epoch_id, state, active_slot,
                         reconciliation_json, created_at, activated_at)
                     VALUES ('e2','n2',4194303,'/Date(2)/','Z:/nowhere/core.exe','bb',NULL,'READY_COMMITTED',1,NULL,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')",
                    [],
                )
                .unwrap();
        }
        let staging = dir.join("staging");
        let report = import(&source, &staging, &json!({"source": {"path": source.display().to_string()}}), false).unwrap();
        assert!(report["markedEpoch"].is_string());
        let staged = staging.join("goalport.sqlite");
        assert!(staged.exists());
        assert!(!staging.join("goalport.sqlite-wal").exists());
        let connection = open_readonly(&staged).unwrap();
        let state: String = connection
            .query_row("SELECT state FROM core_launch_epochs ORDER BY rowid DESC LIMIT 1", [], |row| row.get(0))
            .unwrap();
        assert_eq!(state, "IMPORTED_SNAPSHOT");
        let slot: Option<i64> = connection
            .query_row("SELECT active_slot FROM core_launch_epochs ORDER BY rowid DESC LIMIT 1", [], |row| row.get(0))
            .unwrap();
        assert!(slot.is_none());
    }
}
