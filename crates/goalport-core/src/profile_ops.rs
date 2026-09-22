//! Profile-level storage operations for startup continuity.
//!
//! Scope: READ-ONLY compatibility inspection, verified consistency backup, and
//! staged import of a foreign-channel profile copy. These operations never run
//! `Store::migrate`. A recovery probe copies a stable main+WAL family and lets
//! SQLite recover only that detached copy; the source is never write-opened.
//!
//! Output contract (like `pipe-peer`): exactly one JSON line on stdout;
//! success exits 0, every failure exits 3 with `{ok:false, stage, error}`.

use crate::product_receipts;
use crate::store;
use rusqlite::backup::Backup;
use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const PROFILE_OPS_SCHEMA: &str = "goalport.profile-ops.v1";
pub const PROFILE_OPS_FAILURE_EXIT: u8 = 3;
pub const IMPORT_PROOF_SCHEMA: &str = "goalport.import-proof.v1";
pub const POSITIVELY_IDENTIFIED_RECOVERABLE: &str = "POSITIVELY_IDENTIFIED_RECOVERABLE";
pub const DETACHED_WAL_COPY_PROBE_V1: &str = "DETACHED_WAL_COPY_PROBE_V1";

const IMPORT_PROOF_FILE: &str = "import-proof.json";

fn sha256_bytes(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file =
        File::open(path).map_err(|error| format!("cannot read {}: {error}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 128 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("cannot read {}: {error}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn canonical_string(path: &Path) -> Result<String, String> {
    path.canonicalize()
        .map(|value| value.to_string_lossy().replace('\\', "/"))
        .map_err(|error| format!("cannot resolve {}: {error}", path.display()))
}

fn validate_hex_digest(label: &str, value: &str) -> Result<(), String> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(format!(
            "{label} must be a 64-character hexadecimal SHA-256"
        ));
    }
    Ok(())
}

fn validate_operation_id(value: &str) -> Result<(), String> {
    if value.len() < 8
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err(
            "operation id must be 8-128 ASCII letters, digits, hyphens or underscores".into(),
        );
    }
    Ok(())
}

fn atomic_write_json(path: &Path, value: &Value) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("{} has no parent directory", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("cannot create {}: {error}", parent.display()))?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temp = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name().unwrap_or_default().to_string_lossy(),
        nonce
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|error| format!("cannot create {}: {error}", temp.display()))?;
        let bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
        file.write_all(&bytes)
            .map_err(|error| format!("cannot write {}: {error}", temp.display()))?;
        file.write_all(b"\n")
            .map_err(|error| format!("cannot write {}: {error}", temp.display()))?;
        file.sync_all()
            .map_err(|error| format!("cannot sync {}: {error}", temp.display()))?;
        drop(file);
        fs::rename(&temp, path)
            .map_err(|error| format!("cannot publish {}: {error}", path.display()))?;
        sync_parent_best_effort(path);
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn sync_parent_best_effort(path: &Path) {
    if let Some(parent) = path.parent() {
        if let Ok(directory) = File::open(parent) {
            let _ = directory.sync_all();
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct SourceSnapshot {
    canonical_database: String,
    main_bytes: u64,
    main_sha256: String,
    wal_bytes: u64,
    wal_sha256: String,
}

impl SourceSnapshot {
    fn token(&self) -> String {
        sha256_bytes(
            format!(
                "goalport.source-snapshot.v1\n{}\n{}\n{}\n{}\n{}\nshm=absent\n",
                self.canonical_database,
                self.main_bytes,
                self.main_sha256,
                self.wal_bytes,
                self.wal_sha256
            )
            .as_bytes(),
        )
    }

    fn json(&self) -> Value {
        json!({
            "canonicalDatabase": self.canonical_database,
            "main": { "bytes": self.main_bytes, "sha256": self.main_sha256 },
            "wal": { "bytes": self.wal_bytes, "sha256": self.wal_sha256 },
            "shmPresent": false,
            "token": self.token(),
        })
    }
}

fn source_snapshot(db: &Path) -> Result<SourceSnapshot, String> {
    let wal = PathBuf::from(format!("{}-wal", db.display()));
    let shm = PathBuf::from(format!("{}-shm", db.display()));
    require_regular_file(db, "source database")?;
    require_regular_file(&wal, "source WAL")?;
    let main_meta =
        fs::metadata(db).map_err(|error| format!("source database is unavailable: {error}"))?;
    let wal_meta =
        fs::metadata(&wal).map_err(|error| format!("source WAL is unavailable: {error}"))?;
    if wal_meta.len() == 0 {
        return Err("recovery probe requires a nonempty source WAL".into());
    }
    if shm.exists() {
        return Err("recovery probe requires the source SHM to be absent; generic read-only failures are not recovery evidence".into());
    }
    Ok(SourceSnapshot {
        canonical_database: canonical_string(db)?,
        main_bytes: main_meta.len(),
        main_sha256: sha256_file(db)?,
        wal_bytes: wal_meta.len(),
        wal_sha256: sha256_file(&wal)?,
    })
}

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
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
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

fn require_goalport_schema(connection: &Connection, version: i64) -> Result<(), String> {
    if version < 1 || version > store::SCHEMA_VERSION {
        return Err(format!(
            "GoalPort schema version {version} is outside the supported import range 1..={}",
            store::SCHEMA_VERSION
        ));
    }
    let required = [
        ("schema_migrations", &["version", "applied_at"][..]),
        ("projects", &["id", "workspace_root"][..]),
        ("campaigns", &["id", "goal", "root_task_id", "state"][..]),
        (
            "tasks",
            &["id", "campaign_id", "title", "acceptance", "state"][..],
        ),
        ("attempts", &["id", "task_id", "provider", "state"][..]),
        ("events", &["id", "attempt_id", "seq", "kind"][..]),
    ];
    let tables = table_names(connection)?;
    for (table, columns) in required {
        if !tables.iter().any(|candidate| candidate == table) {
            return Err(format!(
                "GoalPort schema is missing required import table {table}"
            ));
        }
        let mut statement = connection
            .prepare(&format!("PRAGMA table_info({table})"))
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|error| error.to_string())?;
        let mut actual = Vec::new();
        for row in rows {
            actual.push(row.map_err(|error| error.to_string())?);
        }
        for column in columns {
            if !actual.iter().any(|candidate| candidate == column) {
                return Err(format!(
                    "GoalPort import table {table} is missing required column {column}"
                ));
            }
        }
    }
    Ok(())
}

fn require_regular_file(path: &Path, label: &str) -> Result<(), String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|error| format!("{label} is unavailable: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
        return Err(format!("{label} must be a regular non-redirected file"));
    }
    Ok(())
}

fn business_counts(connection: &Connection) -> Result<Value, String> {
    let tables = table_names(connection)?;
    let mut counts = json!({});
    for table in [
        "campaigns",
        "tasks",
        "attempts",
        "events",
        "decisions",
        "outbox",
        "stop_responsibilities",
    ] {
        if tables.iter().any(|name| name == table) {
            let count: i64 = connection
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
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
                String::new(),
                String::new(),
                0,
                String::new(),
                String::new(),
                String::new(),
                String::new(),
                None,
            )),
            other => Err(other),
        })
        .map_err(|error: rusqlite::Error| error.to_string())?;
    let (
        epoch_id,
        launch_nonce,
        core_pid,
        core_creation_date,
        core_executable_path,
        core_executable_sha256,
        state,
        active_slot,
    ) = row;
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
            product_receipts::PriorCoreStatus::NoPrior
            | product_receipts::PriorCoreStatus::Ended => "ended",
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
        result["needsRecovery"] = json!(false);
        result["schemaVersion"] = json!(null);
        result["access"] = json!({ "disposition": "MISSING" });
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
    // SQLite may create -shm while opening a WAL database even when the
    // database handle itself is read-only. Missing SHM plus a nonempty WAL is
    // therefore only a detached-probe candidate. Do not ask SQLite to touch
    // the source and do not claim compatibility or recoverability yet.
    if result["walBytes"].as_u64().unwrap_or(0) > 0 && result["shmPresent"] == json!(false) {
        result["openable"] = json!(false);
        result["needsRecovery"] = json!(true); // legacy diagnostic only
        result["schemaVersion"] = json!(null);
        result["access"] = json!({
            "disposition": "RECOVERY_PROBE_REQUIRED",
            "reason": "WAL_PRESENT_SHM_MISSING"
        });
        return Ok(result);
    }
    let connection = match open_readonly(db) {
        Ok(connection) => connection,
        error @ Err(_) => {
            result["openable"] = json!(false);
            result["needsRecovery"] = json!(true); // legacy diagnostic only
            result["schemaVersion"] = json!(null);
            result["access"] = json!({ "disposition": "UNOPENABLE_UNCLASSIFIED" });
            if let Err(message) = error {
                result["error"] = json!(message);
            }
            return Ok(result);
        }
    };
    result["openable"] = json!(true);
    result["needsRecovery"] = json!(false);
    result["access"] = json!({ "disposition": "OPENABLE_READ_ONLY" });
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

struct PartialFileGuard {
    path: PathBuf,
    armed: bool,
}

impl PartialFileGuard {
    fn new(path: PathBuf) -> Self {
        Self { path, armed: true }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }

    fn cleanup(&self) {
        for candidate in [
            self.path.clone(),
            PathBuf::from(format!("{}-wal", self.path.display())),
            PathBuf::from(format!("{}-shm", self.path.display())),
        ] {
            if let Ok(metadata) = fs::symlink_metadata(&candidate) {
                if metadata.file_type().is_file() && !metadata.file_type().is_symlink() {
                    let _ = fs::remove_file(candidate);
                }
            }
        }
    }
}

impl Drop for PartialFileGuard {
    fn drop(&mut self) {
        if self.armed {
            self.cleanup();
        }
    }
}

fn partial_backup_path(out: &Path) -> Result<PathBuf, String> {
    let parent = out
        .parent()
        .ok_or_else(|| format!("{} has no backup directory", out.display()))?;
    let leaf = out
        .file_name()
        .ok_or_else(|| format!("{} has no backup filename", out.display()))?
        .to_string_lossy();
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    Ok(parent.join(format!(".{leaf}.{}-{nonce}.partial", std::process::id())))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BackupFault {
    None,
    AfterCopy,
    BeforePublish,
}

fn maybe_backup_fault(fault: BackupFault, point: BackupFault) -> Result<(), String> {
    if fault == point {
        return Err(format!("injected backup failure at {point:?}"));
    }
    Ok(())
}

/// `profile backup --db P --out Q [--allow-write-open]`: SQLite Online Backup
/// API copy with post-copy verification (quick_check + schema version + core
/// table row-count parity). `out` must not exist; the source is opened
/// read-only unless `--allow-write-open` is set (consented WAL recovery).
pub fn backup(db: &Path, out: &Path, allow_write_open: bool) -> Result<Value, String> {
    backup_impl(db, out, allow_write_open, BackupFault::None)
}

fn backup_impl(
    db: &Path,
    out: &Path,
    allow_write_open: bool,
    fault: BackupFault,
) -> Result<Value, String> {
    if !db.exists() {
        return Err(format!("source database does not exist: {}", db.display()));
    }
    if out.exists() {
        return Err(format!(
            "refusing to overwrite existing backup: {}",
            out.display()
        ));
    }
    if let Some(parent) = out.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("cannot create backup directory: {error}"))?;
    }
    let partial = partial_backup_path(out)?;
    if partial.exists() {
        return Err(format!(
            "refusing existing partial backup: {}",
            partial.display()
        ));
    }
    let mut guard = PartialFileGuard::new(partial.clone());
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
    let source_version = schema_version(&source)?.ok_or_else(|| {
        "source has no schema_migrations table; refusing to back up a non-GoalPort database"
            .to_string()
    })?;
    let source_counts = business_counts(&source)?;
    let mut destination = open_readwrite(&partial)?;
    backup_inner(&source, &mut destination)?;
    maybe_backup_fault(fault, BackupFault::AfterCopy)?;
    // Verify the backup BEFORE the caller may rely on it.
    let verified = open_readonly(&partial)?;
    let check = quick_check(&verified)?;
    if check != "ok" {
        return Err(format!("backup verification failed quick_check: {check}"));
    }
    let out_version = schema_version(&verified)?
        .ok_or_else(|| "backup lost its schema_migrations table".to_string())?;
    if out_version != source_version {
        return Err(format!(
            "backup schema version {out_version} differs from source {source_version}"
        ));
    }
    let out_counts = business_counts(&verified)?;
    if out_counts != source_counts {
        return Err("backup row counts differ from source".to_string());
    }
    // Durability: flush the verified file to disk. The destination connection
    // may have created WAL side files during the copy/verify — checkpoint the
    // backup so a restore that copies only the main file loses nothing, then
    // remove the side files.
    drop(verified);
    drop(destination);
    {
        let checkpoint = open_readwrite(&partial)?;
        let (busy, remaining, checkpointed): (i64, i64, i64) = checkpoint
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .map_err(|error| error.to_string())?;
        if busy != 0 || remaining != checkpointed {
            return Err(format!(
                "backup checkpoint did not complete (busy={busy}, remaining={remaining}, checkpointed={checkpointed})"
            ));
        }
        let journal_mode: String = checkpoint
            .query_row("PRAGMA journal_mode=DELETE", [], |row| row.get(0))
            .map_err(|error| error.to_string())?;
        if !journal_mode.eq_ignore_ascii_case("delete") {
            return Err(format!(
                "backup copy did not enter single-file journal mode: {journal_mode}"
            ));
        }
        drop(checkpoint);
    }
    for suffix in ["-wal", "-shm"] {
        let side = PathBuf::from(format!("{}{suffix}", partial.display()));
        if side.exists() {
            fs::remove_file(&side)
                .map_err(|error| format!("cannot remove backup {suffix}: {error}"))?;
        }
    }
    let file = fs::OpenOptions::new()
        .write(true)
        .open(&partial)
        .map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    drop(file);
    maybe_backup_fault(fault, BackupFault::BeforePublish)?;
    // hard_link is same-filesystem, atomic and no-clobber. Unsupported
    // filesystems fail closed; never fall back to an overwriting rename.
    fs::hard_link(&partial, out).map_err(|error| {
        format!("cannot atomically publish verified backup without overwrite: {error}")
    })?;
    sync_parent_best_effort(out);
    let _ = fs::remove_file(&partial);
    guard.cleanup();
    guard.disarm();
    result["schemaVersion"] = json!(source_version);
    result["counts"] = source_counts;
    result["quickCheck"] = json!("ok");
    result["bytes"] = json!(fs::metadata(out).map(|meta| meta.len()).unwrap_or(0));
    result["published"] = json!(true);
    result["publication"] = json!("hard-link-no-clobber");
    Ok(result)
}

fn source_binding_sha256(
    db: &Path,
    source_marker_sha256: &str,
    provenance_sha256: &str,
) -> Result<String, String> {
    validate_hex_digest("source marker digest", source_marker_sha256)?;
    validate_hex_digest("provenance digest", provenance_sha256)?;
    Ok(sha256_bytes(
        format!(
            "goalport.source-binding.v1\n{}\n{}\n{}\n",
            canonical_string(db)?,
            source_marker_sha256.to_ascii_lowercase(),
            provenance_sha256.to_ascii_lowercase()
        )
        .as_bytes(),
    ))
}

fn counts_digest(counts: &Value) -> Result<String, String> {
    serde_json::to_vec(counts)
        .map(|bytes| sha256_bytes(&bytes))
        .map_err(|error| error.to_string())
}

fn proof_token(proof: &Value) -> Result<String, String> {
    let mut canonical = proof.clone();
    if let Some(object) = canonical.as_object_mut() {
        object.remove("recoveryProofToken");
    }
    serde_json::to_vec(&canonical)
        .map(|bytes| sha256_bytes(&bytes))
        .map_err(|error| error.to_string())
}

fn mark_imported_snapshot(
    staging: &mut Connection,
    provenance: &Value,
) -> Result<Option<String>, String> {
    let tables = table_names(staging)?;
    if !tables.iter().any(|name| name == "core_launch_epochs") {
        return Ok(None);
    }
    let mut columns = Vec::new();
    {
        let mut statement = staging
            .prepare("PRAGMA table_info(core_launch_epochs)")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|error| error.to_string())?;
        for row in rows {
            columns.push(row.map_err(|error| error.to_string())?);
        }
    }
    for required in ["epoch_id", "state", "active_slot", "reconciliation_json"] {
        if !columns.iter().any(|column| column == required) {
            return Err(format!(
                "core_launch_epochs is missing required import column {required}"
            ));
        }
    }
    let transaction = staging
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let latest: Option<(String, Option<String>)> = transaction
        .query_row(
            "SELECT epoch_id, reconciliation_json FROM core_launch_epochs ORDER BY rowid DESC LIMIT 1",
            [],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .map(Some)
        .or_else(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })
        .map_err(|error: rusqlite::Error| error.to_string())?;
    let mut marked = None;
    if let Some((epoch_id, raw)) = latest {
        let mut reconciliation: Value = raw
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_else(|| json!({}));
        let object = reconciliation
            .as_object_mut()
            .ok_or("latest epoch reconciliation_json is not an object")?;
        object.insert("importedSnapshot".into(), json!(true));
        object.insert(
            "importedFrom".into(),
            json!(provenance.get("source").cloned().unwrap_or(Value::Null)),
        );
        object.insert("importedAtUtc".into(), json!(store::utc_now_iso()));
        object.insert("importProvenance".into(), provenance.clone());
        transaction
            .execute(
                "UPDATE core_launch_epochs SET state='IMPORTED_SNAPSHOT', active_slot=NULL, reconciliation_json=?2 WHERE epoch_id=?1",
                rusqlite::params![epoch_id, reconciliation.to_string()],
            )
            .map_err(|error| error.to_string())?;
        marked = Some(epoch_id);
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(marked)
}

fn checkpoint_single_file(db: &Path) -> Result<(), String> {
    let checkpoint = open_readwrite(db)?;
    let (busy, remaining, checkpointed): (i64, i64, i64) = checkpoint
        .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .map_err(|error| error.to_string())?;
    if busy != 0 || remaining != checkpointed {
        return Err(format!(
            "staged checkpoint did not complete (busy={busy}, remaining={remaining}, checkpointed={checkpointed})"
        ));
    }
    let journal_mode: String = checkpoint
        .query_row("PRAGMA journal_mode=DELETE", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if !journal_mode.eq_ignore_ascii_case("delete") {
        return Err(format!(
            "staged copy did not enter single-file journal mode: {journal_mode}"
        ));
    }
    drop(checkpoint);
    for suffix in ["-wal", "-shm"] {
        let side = PathBuf::from(format!("{}{suffix}", db.display()));
        if side.exists() {
            fs::remove_file(&side)
                .map_err(|error| format!("cannot remove staged database {suffix}: {error}"))?;
        }
    }
    let file = OpenOptions::new()
        .write(true)
        .open(db)
        .map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())
}

fn build_import_proof(
    operation_id: &str,
    method: &str,
    source_binding_sha256: &str,
    source_snapshot_token: &str,
    source_marker_sha256: &str,
    provenance_sha256: &str,
    staged_db: &Path,
    schema_version: i64,
    counts: &Value,
    marked_epoch: Option<&str>,
) -> Result<Value, String> {
    let bytes = fs::metadata(staged_db)
        .map_err(|error| error.to_string())?
        .len();
    let staged_sha256 = sha256_file(staged_db)?;
    let mut proof = json!({
        "schema": IMPORT_PROOF_SCHEMA,
        "operationId": operation_id,
        "method": method,
        "sourceMutation": "NONE",
        "sourceBindingSha256": source_binding_sha256,
        "sourceSnapshotToken": source_snapshot_token,
        "sourceMarkerSha256": source_marker_sha256.to_ascii_lowercase(),
        "provenanceSha256": provenance_sha256.to_ascii_lowercase(),
        "stagedDatabase": {
            "sha256": staged_sha256,
            "bytes": bytes,
            "schemaVersion": schema_version,
            "quickCheck": "ok",
            "counts": counts,
            "countsSha256": counts_digest(counts)?,
        },
        "markedEpoch": marked_epoch,
    });
    let token = proof_token(&proof)?;
    proof["recoveryProofToken"] = json!(token);
    Ok(proof)
}

/// `profile import --source-db P --staging-dir D --provenance JSON`: verified
/// ordinary read-only Online Backup copy. Recovery is never enabled by this
/// operation; a WAL/SHM recovery candidate must use `recovery-probe`.
pub fn import(
    source_db: &Path,
    staging_dir: &Path,
    provenance: &Value,
    allow_source_recovery: bool,
) -> Result<Value, String> {
    if allow_source_recovery {
        return Err("--allow-source-recovery is deprecated and cannot authorize a source write-open; use detached recovery-probe".into());
    }
    let provenance_bytes = serde_json::to_vec(provenance).map_err(|error| error.to_string())?;
    import_bound(
        source_db,
        staging_dir,
        provenance,
        "legacy-import",
        &"0".repeat(64),
        &sha256_bytes(&provenance_bytes),
    )
}

pub fn import_bound(
    source_db: &Path,
    staging_dir: &Path,
    provenance: &Value,
    operation_id: &str,
    source_marker_sha256: &str,
    provenance_sha256: &str,
) -> Result<Value, String> {
    validate_operation_id(operation_id)?;
    let wal = PathBuf::from(format!("{}-wal", source_db.display()));
    let shm = PathBuf::from(format!("{}-shm", source_db.display()));
    if fs::metadata(&wal)
        .map(|metadata| metadata.len() > 0)
        .unwrap_or(false)
        && !shm.exists()
    {
        return Err(
            "source requires detached WAL-copy recovery proof; ordinary import will not open it"
                .into(),
        );
    }
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
    let mut report = backup(source_db, &staging_db, false)?;
    report["stage"] = json!("import");
    let mut staging = open_readwrite(&staging_db)?;
    let marked_epoch = mark_imported_snapshot(&mut staging, provenance)?;
    drop(staging);
    checkpoint_single_file(&staging_db)?;
    let verified = open_readonly(&staging_db)?;
    let schema = schema_version(&verified)?.ok_or("imported database lost schema_migrations")?;
    require_goalport_schema(&verified, schema)?;
    let counts = business_counts(&verified)?;
    if quick_check(&verified)? != "ok" {
        return Err("imported database failed final quick_check".into());
    }
    drop(verified);
    let source_binding = source_binding_sha256(source_db, source_marker_sha256, provenance_sha256)?;
    let source_snapshot_token = sha256_bytes(
        format!(
            "goalport.online-backup.v1\n{source_binding}\n{}\n",
            sha256_file(&staging_db)?
        )
        .as_bytes(),
    );
    let proof = build_import_proof(
        operation_id,
        "SQLITE_ONLINE_BACKUP_V1",
        &source_binding,
        &source_snapshot_token,
        source_marker_sha256,
        provenance_sha256,
        &staging_db,
        schema,
        &counts,
        marked_epoch.as_deref(),
    )?;
    atomic_write_json(&staging_dir.join(IMPORT_PROOF_FILE), &proof)?;
    report["stagingDb"] = json!(staging_db.display().to_string());
    report["markedEpoch"] = json!(marked_epoch);
    report["sourceBindingSha256"] = proof["sourceBindingSha256"].clone();
    report["sourceSnapshotToken"] = proof["sourceSnapshotToken"].clone();
    report["recoveryProofToken"] = proof["recoveryProofToken"].clone();
    report["proof"] = proof;
    Ok(report)
}

pub fn recovery_probe(
    source_db: &Path,
    staging_dir: &Path,
    operation_id: &str,
    source_marker_sha256: &str,
    provenance_sha256: &str,
) -> Result<Value, String> {
    validate_operation_id(operation_id)?;
    let source_binding = source_binding_sha256(source_db, source_marker_sha256, provenance_sha256)?;
    let before = source_snapshot(source_db)?;
    fs::create_dir_all(staging_dir)
        .map_err(|error| format!("cannot create staging directory: {error}"))?;
    let staged_db = staging_dir.join("goalport.sqlite");
    let proof_path = staging_dir.join(IMPORT_PROOF_FILE);
    if staged_db.exists() || proof_path.exists() {
        return Err("recovery staging already contains database or proof".into());
    }
    fs::copy(source_db, &staged_db)
        .map_err(|error| format!("cannot copy source database: {error}"))?;
    let source_wal = PathBuf::from(format!("{}-wal", source_db.display()));
    let staged_wal = PathBuf::from(format!("{}-wal", staged_db.display()));
    fs::copy(&source_wal, &staged_wal)
        .map_err(|error| format!("cannot copy source WAL: {error}"))?;
    let after = source_snapshot(source_db)?;
    if before != after {
        let _ = fs::remove_file(&staged_db);
        let _ = fs::remove_file(&staged_wal);
        return Err(
            "source database family changed while creating the detached recovery copy".into(),
        );
    }
    if fs::metadata(&staged_db)
        .map_err(|error| error.to_string())?
        .len()
        != before.main_bytes
        || sha256_file(&staged_db)? != before.main_sha256
        || fs::metadata(&staged_wal)
            .map_err(|error| error.to_string())?
            .len()
            != before.wal_bytes
        || sha256_file(&staged_wal)? != before.wal_sha256
    {
        return Err("detached recovery copy does not match the stable source snapshot".into());
    }
    let mut recovered = open_readwrite(&staged_db)?;
    let schema = schema_version(&recovered)?
        .ok_or("recovered copy has no schema_migrations table; refusing non-GoalPort data")?;
    if schema > store::SCHEMA_VERSION {
        return Err(format!(
            "recovered source schema {schema} is newer than this build ({})",
            store::SCHEMA_VERSION
        ));
    }
    require_goalport_schema(&recovered, schema)?;
    let check = quick_check(&recovered)?;
    if check != "ok" {
        return Err(format!("recovered copy failed quick_check: {check}"));
    }
    let counts = business_counts(&recovered)?;
    let provenance = json!({
        "source": { "bindingSha256": source_binding.clone(), "snapshotToken": before.token() },
        "recoveryMethod": DETACHED_WAL_COPY_PROBE_V1,
        "sourceMutation": "NONE"
    });
    let marked_epoch = mark_imported_snapshot(&mut recovered, &provenance)?;
    drop(recovered);
    checkpoint_single_file(&staged_db)?;
    let verify = open_readonly(&staged_db)?;
    if quick_check(&verify)? != "ok"
        || schema_version(&verify)? != Some(schema)
        || business_counts(&verify)? != counts
    {
        return Err("detached recovered copy failed final verification".into());
    }
    drop(verify);
    let proof = build_import_proof(
        operation_id,
        DETACHED_WAL_COPY_PROBE_V1,
        &source_binding,
        &before.token(),
        source_marker_sha256,
        provenance_sha256,
        &staged_db,
        schema,
        &counts,
        marked_epoch.as_deref(),
    )?;
    atomic_write_json(&proof_path, &proof)?;
    Ok(json!({
        "schema": PROFILE_OPS_SCHEMA,
        "stage": "recovery-probe",
        "recoveryDisposition": POSITIVELY_IDENTIFIED_RECOVERABLE,
        "recoveryMethod": DETACHED_WAL_COPY_PROBE_V1,
        "sourceMutation": "NONE",
        "sourceSnapshot": before.json(),
        "sourceSnapshotToken": before.token(),
        "sourceBindingSha256": source_binding,
        "recoveryProofToken": proof["recoveryProofToken"],
        "stagedDatabase": proof["stagedDatabase"],
        "proof": proof,
    }))
}

pub fn verify_source(
    source_db: &Path,
    expected_source_snapshot_token: &str,
) -> Result<Value, String> {
    validate_hex_digest(
        "expected source snapshot token",
        expected_source_snapshot_token,
    )?;
    let snapshot = source_snapshot(source_db)?;
    if snapshot.token() != expected_source_snapshot_token.to_ascii_lowercase() {
        return Err("source database family changed after the recovery offer was prepared".into());
    }
    Ok(json!({
        "schema": PROFILE_OPS_SCHEMA,
        "stage": "verify-source",
        "sourceMutation": "NONE",
        "sourceSnapshotToken": snapshot.token(),
        "sourceSnapshot": snapshot.json(),
    }))
}

pub fn verify_staging(
    staging_dir: &Path,
    expected_operation_id: &str,
    expected_proof_token: &str,
    expected_source_binding_sha256: &str,
) -> Result<Value, String> {
    validate_operation_id(expected_operation_id)?;
    validate_hex_digest("expected proof token", expected_proof_token)?;
    validate_hex_digest("expected source binding", expected_source_binding_sha256)?;
    let proof_path = staging_dir.join(IMPORT_PROOF_FILE);
    require_regular_file(&proof_path, "import proof")?;
    let proof: Value = serde_json::from_slice(
        &fs::read(&proof_path).map_err(|error| format!("cannot read import proof: {error}"))?,
    )
    .map_err(|error| format!("invalid import proof: {error}"))?;
    if proof["schema"] != IMPORT_PROOF_SCHEMA
        || proof["operationId"] != expected_operation_id
        || proof["sourceBindingSha256"] != expected_source_binding_sha256.to_ascii_lowercase()
        || proof["recoveryProofToken"] != expected_proof_token.to_ascii_lowercase()
        || proof_token(&proof)? != expected_proof_token.to_ascii_lowercase()
    {
        return Err(
            "import proof does not match the expected operation, source binding or token".into(),
        );
    }
    let staged_db = staging_dir.join("goalport.sqlite");
    require_regular_file(&staged_db, "staged database")?;
    let expected_sha = proof["stagedDatabase"]["sha256"]
        .as_str()
        .ok_or("import proof lacks staged database sha256")?;
    let expected_bytes = proof["stagedDatabase"]["bytes"]
        .as_u64()
        .ok_or("import proof lacks staged database byte count")?;
    if fs::metadata(&staged_db)
        .map_err(|error| format!("staged database is unavailable: {error}"))?
        .len()
        != expected_bytes
        || sha256_file(&staged_db)? != expected_sha
    {
        return Err("staged database bytes do not match the bound import proof".into());
    }
    let connection = open_readonly(&staged_db)?;
    let schema =
        schema_version(&connection)?.ok_or("staged database has no schema_migrations table")?;
    require_goalport_schema(&connection, schema)?;
    let counts = business_counts(&connection)?;
    if quick_check(&connection)? != "ok"
        || proof["stagedDatabase"]["schemaVersion"] != schema
        || proof["stagedDatabase"]["countsSha256"] != counts_digest(&counts)?
    {
        return Err(
            "staged database compatibility or integrity facts do not match the import proof".into(),
        );
    }
    Ok(json!({
        "schema": PROFILE_OPS_SCHEMA,
        "stage": "verify-staging",
        "verified": true,
        "operationId": expected_operation_id,
        "sourceBindingSha256": expected_source_binding_sha256.to_ascii_lowercase(),
        "recoveryProofToken": expected_proof_token.to_ascii_lowercase(),
        "sourceSnapshotToken": proof["sourceSnapshotToken"],
        "recoveryMethod": proof["method"],
        "sourceMutation": "NONE",
        "stagedDatabase": proof["stagedDatabase"],
        "proof": proof,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "goalport-profile-ops-{name}-{}",
            std::process::id()
        ));
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
            store
                .insert_project(&crate::domain::Project {
                    id: "p1".into(),
                    workspace_root: "ws1".into(),
                })
                .unwrap();
            store
                .create_campaign_with_task(
                    "p1",
                    &crate::domain::Campaign {
                        id: "c1".into(),
                        goal: "goal one".into(),
                        root_task_id: "t1".into(),
                        state: Default::default(),
                    },
                    &crate::domain::Task {
                        id: "t1".into(),
                        campaign_id: "c1".into(),
                        title: "do it".into(),
                        acceptance: "done".into(),
                        state: Default::default(),
                    },
                )
                .unwrap();
            // Connection stays in WAL mode; committed rows may live in the
            // WAL only — exactly the owner-profile shape we must back up.
        }
        assert!(
            dir.join("goalport.sqlite-wal").exists() || fs::metadata(&db).unwrap().len() > 4096
        );
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
        let report = import(
            &source,
            &staging,
            &json!({"source": {"path": source.display().to_string()}}),
            false,
        )
        .unwrap();
        assert!(report["markedEpoch"].is_string());
        let staged = staging.join("goalport.sqlite");
        assert!(staged.exists());
        assert!(!staging.join("goalport.sqlite-wal").exists());
        let connection = open_readonly(&staged).unwrap();
        let state: String = connection
            .query_row(
                "SELECT state FROM core_launch_epochs ORDER BY rowid DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(state, "IMPORTED_SNAPSHOT");
        let slot: Option<i64> = connection
            .query_row(
                "SELECT active_slot FROM core_launch_epochs ORDER BY rowid DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(slot.is_none());
    }

    #[test]
    fn inspect_nonempty_wal_without_shm_requires_detached_probe_without_sqlite_open() {
        let dir = temp_dir("inspect-probe-required");
        let db = dir.join("goalport.sqlite");
        fs::write(&db, b"not opened by sqlite").unwrap();
        fs::write(
            PathBuf::from(format!("{}-wal", db.display())),
            b"nonempty wal candidate",
        )
        .unwrap();
        let value = inspect(&db, true).unwrap();
        assert_eq!(
            value["access"]["disposition"],
            json!("RECOVERY_PROBE_REQUIRED")
        );
        assert_eq!(value["access"]["reason"], json!("WAL_PRESENT_SHM_MISSING"));
        assert_eq!(value["openable"], json!(false));
        assert!(!PathBuf::from(format!("{}-shm", db.display())).exists());
    }

    #[test]
    fn backup_faults_after_destination_creation_leave_no_final_or_partial_slot() {
        let dir = temp_dir("backup-partial-cleanup");
        let db = dir.join("goalport.sqlite");
        let _store = Store::open(&db).unwrap();
        for (name, fault) in [
            ("after-copy", BackupFault::AfterCopy),
            ("before-publish", BackupFault::BeforePublish),
        ] {
            let out = dir.join(format!("goalport-2026-09-22T00-00-00-000Z-{name}.sqlite"));
            assert!(backup_impl(&db, &out, false, fault).is_err());
            assert!(!out.exists(), "{name}: final name must not be published");
            assert!(
                fs::read_dir(&dir).unwrap().all(|entry| !entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .ends_with(".partial")),
                "{name}: partial must be removed"
            );
        }
    }

    #[test]
    fn backup_publication_is_verified_and_no_clobber() {
        let dir = temp_dir("backup-no-clobber");
        let db = dir.join("goalport.sqlite");
        let _store = Store::open(&db).unwrap();
        let out = dir.join("goalport-2026-09-22T00-00-00-000Z-12345678.sqlite");
        let report = backup(&db, &out, false).unwrap();
        assert_eq!(report["published"], json!(true));
        assert_eq!(report["publication"], json!("hard-link-no-clobber"));
        let digest = sha256_file(&out).unwrap();
        assert!(backup(&db, &out, false).is_err());
        assert_eq!(
            sha256_file(&out).unwrap(),
            digest,
            "existing verified backup is untouched"
        );
    }

    #[test]
    fn manual_source_recovery_flag_fails_closed() {
        let dir = temp_dir("deprecated-source-recovery");
        let source = dir.join("source.sqlite");
        let _store = Store::open(&source).unwrap();
        let error = import(&source, &dir.join("staging"), &json!({}), true).unwrap_err();
        assert!(error.contains("deprecated") && error.contains("detached recovery-probe"));
    }

    #[test]
    fn busy_checkpoint_refuses_before_wal_removal() {
        let dir = temp_dir("checkpoint-busy");
        let db = dir.join("busy.sqlite");
        let writer = open_readwrite(&db).unwrap();
        writer
            .execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE t(v INTEGER); INSERT INTO t VALUES (1); PRAGMA wal_checkpoint(TRUNCATE);")
            .unwrap();
        let reader = open_readonly(&db).unwrap();
        reader.execute_batch("BEGIN").unwrap();
        let mut statement = reader.prepare("SELECT v FROM t").unwrap();
        let mut rows = statement.query([]).unwrap();
        assert!(rows.next().unwrap().is_some());
        writer.execute("INSERT INTO t VALUES (2)", []).unwrap();
        let error = checkpoint_single_file(&db).unwrap_err();
        assert!(error.contains("checkpoint did not complete"));
        assert!(
            PathBuf::from(format!("{}-wal", db.display())).exists(),
            "busy WAL must be retained"
        );
        drop(rows);
        drop(statement);
        reader.execute_batch("ROLLBACK").unwrap();
    }
}
