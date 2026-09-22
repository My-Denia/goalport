use goalport_core::{profile_ops, store::Store};
use rusqlite::{Connection, OpenFlags};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

fn sha256_file(path: &Path) -> String {
    let bytes = fs::read(path).unwrap();
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn wal(path: &Path) -> PathBuf {
    PathBuf::from(format!("{}-wal", path.display()))
}

fn shm(path: &Path) -> PathBuf {
    PathBuf::from(format!("{}-shm", path.display()))
}

/// Build a genuine SQLite WAL snapshot whose sentinel is committed in WAL,
/// copy the stable main+WAL family while the producer is idle, and deliberately
/// omit SHM. The returned source is never opened by SQLite before the probe.
fn wal_only_source(root: &Path) -> PathBuf {
    let producer = root.join("producer.sqlite");
    {
        let _store = Store::open(&producer).unwrap();
    }
    let connection = Connection::open_with_flags(
        &producer,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .unwrap();
    connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
    connection.execute("INSERT INTO projects(id, workspace_root, version) VALUES ('wal-only-sentinel','wal-only-workspace',1)", []).unwrap();
    let producer_wal = wal(&producer);
    assert!(
        fs::metadata(&producer_wal).unwrap().len() > 0,
        "fixture must retain committed WAL frames"
    );

    let source = root.join("source.sqlite");
    fs::copy(&producer, &source).unwrap();
    fs::copy(&producer_wal, wal(&source)).unwrap();
    assert!(!shm(&source).exists(), "fixture intentionally omits SHM");
    drop(connection);
    source
}

#[test]
fn detached_wal_probe_recovers_sentinel_without_touching_source_family() {
    let root = tempfile::tempdir().unwrap();
    let source = wal_only_source(root.path());
    let source_main_before = sha256_file(&source);
    let source_wal_before = sha256_file(&wal(&source));
    let staging = root.path().join("staging");
    let marker = "a".repeat(64);
    let provenance = "b".repeat(64);

    let report = profile_ops::recovery_probe(
        &source,
        &staging,
        "recovery-operation-0001",
        &marker,
        &provenance,
    )
    .unwrap();
    assert_eq!(
        report["recoveryDisposition"],
        json!(profile_ops::POSITIVELY_IDENTIFIED_RECOVERABLE)
    );
    assert_eq!(
        report["recoveryMethod"],
        json!(profile_ops::DETACHED_WAL_COPY_PROBE_V1)
    );
    assert_eq!(report["sourceMutation"], json!("NONE"));
    assert_eq!(sha256_file(&source), source_main_before);
    assert_eq!(sha256_file(&wal(&source)), source_wal_before);
    assert!(!shm(&source).exists(), "probe must not create source SHM");

    let staged = staging.join("goalport.sqlite");
    let recovered = Connection::open_with_flags(&staged, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let workspace: String = recovered
        .query_row(
            "SELECT workspace_root FROM projects WHERE id='wal-only-sentinel'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(workspace, "wal-only-workspace");
    drop(recovered);

    let token = report["sourceSnapshotToken"].as_str().unwrap();
    assert_eq!(
        profile_ops::verify_source(&source, token).unwrap()["sourceMutation"],
        json!("NONE")
    );
    let verified = profile_ops::verify_staging(
        &staging,
        "recovery-operation-0001",
        report["recoveryProofToken"].as_str().unwrap(),
        report["sourceBindingSha256"].as_str().unwrap(),
    )
    .unwrap();
    assert_eq!(verified["verified"], json!(true));
    assert!(
        !wal(&staged).exists() && !shm(&staged).exists(),
        "verification keeps the staged artifact single-file"
    );
    let verified_again = profile_ops::verify_staging(
        &staging,
        "recovery-operation-0001",
        report["recoveryProofToken"].as_str().unwrap(),
        report["sourceBindingSha256"].as_str().unwrap(),
    )
    .unwrap();
    assert_eq!(verified_again["verified"], json!(true));
    assert!(
        !wal(&staged).exists() && !shm(&staged).exists(),
        "repeated verification creates no sidecars"
    );
}

#[test]
fn changed_source_and_wrong_proof_never_validate() {
    let root = tempfile::tempdir().unwrap();
    let source = wal_only_source(root.path());
    let staging = root.path().join("staging");
    let report = profile_ops::recovery_probe(
        &source,
        &staging,
        "recovery-operation-0002",
        &"c".repeat(64),
        &"d".repeat(64),
    )
    .unwrap();
    assert!(
        profile_ops::verify_staging(
            &staging,
            "recovery-operation-0002",
            &"e".repeat(64),
            report["sourceBindingSha256"].as_str().unwrap(),
        )
        .is_err()
    );

    let mut wal_bytes = fs::read(wal(&source)).unwrap();
    wal_bytes.push(0);
    fs::write(wal(&source), wal_bytes).unwrap();
    assert!(
        profile_ops::verify_source(&source, report["sourceSnapshotToken"].as_str().unwrap())
            .is_err()
    );
    assert!(!shm(&source).exists());
}

#[test]
fn healthy_sqlite_without_bound_proof_is_not_resumable_staging() {
    let root = tempfile::tempdir().unwrap();
    let staging = root.path().join("staging");
    fs::create_dir_all(&staging).unwrap();
    let _store = Store::open(staging.join("goalport.sqlite")).unwrap();
    let error = profile_ops::verify_staging(
        &staging,
        "recovery-operation-0003",
        &"f".repeat(64),
        &"1".repeat(64),
    )
    .unwrap_err();
    assert!(error.contains("import proof"));
}

#[test]
fn recovery_probe_refuses_newer_or_non_goalport_schema() {
    let root = tempfile::tempdir().unwrap();
    let producer = root.path().join("non-goalport.sqlite");
    let connection = Connection::open(&producer).unwrap();
    connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE foreign_data(value TEXT); PRAGMA wal_checkpoint(TRUNCATE); INSERT INTO foreign_data VALUES ('sentinel');").unwrap();
    let source = root.path().join("source.sqlite");
    fs::copy(&producer, &source).unwrap();
    fs::copy(wal(&producer), wal(&source)).unwrap();
    drop(connection);
    let error = profile_ops::recovery_probe(
        &source,
        &root.path().join("staging"),
        "recovery-operation-0004",
        &"2".repeat(64),
        &"3".repeat(64),
    )
    .unwrap_err();
    assert!(error.contains("schema_migrations") || error.contains("non-GoalPort"));
    assert!(!shm(&source).exists());

    let forged_producer = root.path().join("forged-producer.sqlite");
    let forged_connection = Connection::open(&forged_producer).unwrap();
    forged_connection
        .execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL); INSERT INTO schema_migrations VALUES (1,'fake'); PRAGMA wal_checkpoint(TRUNCATE); CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES ('sentinel');")
        .unwrap();
    let forged = root.path().join("forged.sqlite");
    fs::copy(&forged_producer, &forged).unwrap();
    fs::copy(wal(&forged_producer), wal(&forged)).unwrap();
    drop(forged_connection);
    let forged_error = profile_ops::recovery_probe(
        &forged,
        &root.path().join("forged-staging"),
        "recovery-operation-forged",
        &"a".repeat(64),
        &"b".repeat(64),
    )
    .unwrap_err();
    assert!(forged_error.contains("missing required import table"));
    assert!(!shm(&forged).exists());

    let newer_producer = root.path().join("newer-producer.sqlite");
    {
        let _store = Store::open(&newer_producer).unwrap();
    }
    let newer_connection = Connection::open_with_flags(
        &newer_producer,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .unwrap();
    newer_connection
        .execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA wal_checkpoint(TRUNCATE); INSERT INTO schema_migrations(version, applied_at) VALUES (999,'future');")
        .unwrap();
    let newer = root.path().join("newer.sqlite");
    fs::copy(&newer_producer, &newer).unwrap();
    fs::copy(wal(&newer_producer), wal(&newer)).unwrap();
    drop(newer_connection);
    let newer_error = profile_ops::recovery_probe(
        &newer,
        &root.path().join("newer-staging"),
        "recovery-operation-0005",
        &"6".repeat(64),
        &"7".repeat(64),
    )
    .unwrap_err();
    assert!(newer_error.contains("newer than this build"));
    assert!(!shm(&newer).exists());
}

#[test]
fn profile_cli_routes_probe_source_and_staging_verification() {
    let root = tempfile::tempdir().unwrap();
    let source = wal_only_source(root.path());
    let staging = root.path().join("cli-staging");
    let executable = env!("CARGO_BIN_EXE_goalport-core");
    let marker = "4".repeat(64);
    let provenance = "5".repeat(64);
    let probe = Command::new(executable)
        .args([
            "profile",
            "recovery-probe",
            "--source-db",
            source.to_str().unwrap(),
            "--staging-dir",
            staging.to_str().unwrap(),
            "--operation-id",
            "recovery-operation-cli",
            "--source-marker-sha256",
            &marker,
            "--provenance-sha256",
            &provenance,
        ])
        .output()
        .unwrap();
    assert!(
        probe.status.success(),
        "{}",
        String::from_utf8_lossy(&probe.stdout)
    );
    let report: serde_json::Value = serde_json::from_slice(&probe.stdout).unwrap();
    assert_eq!(report["ok"], json!(true));
    assert_eq!(
        report["recoveryDisposition"],
        json!(profile_ops::POSITIVELY_IDENTIFIED_RECOVERABLE)
    );

    let source_verified = Command::new(executable)
        .args([
            "profile",
            "verify-source",
            "--source-db",
            source.to_str().unwrap(),
            "--expected-source-snapshot-token",
            report["sourceSnapshotToken"].as_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(
        source_verified.status.success(),
        "{}",
        String::from_utf8_lossy(&source_verified.stdout)
    );

    let staging_verified = Command::new(executable)
        .args([
            "profile",
            "verify-staging",
            "--staging-dir",
            staging.to_str().unwrap(),
            "--expected-operation-id",
            "recovery-operation-cli",
            "--expected-proof-token",
            report["recoveryProofToken"].as_str().unwrap(),
            "--expected-source-binding-sha256",
            report["sourceBindingSha256"].as_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(
        staging_verified.status.success(),
        "{}",
        String::from_utf8_lossy(&staging_verified.stdout)
    );
    let verified: serde_json::Value = serde_json::from_slice(&staging_verified.stdout).unwrap();
    assert_eq!(verified["verified"], json!(true));
}

#[test]
fn verified_older_schema_copy_is_migrated_only_by_normal_store_open() {
    let root = tempfile::tempdir().unwrap();
    let producer = root.path().join("older-producer.sqlite");
    {
        let _store = Store::open(&producer).unwrap();
    }
    let connection = Connection::open_with_flags(
        &producer,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .unwrap();
    connection
        .execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA wal_checkpoint(TRUNCATE); DELETE FROM schema_migrations WHERE version > 1; INSERT INTO projects(id, workspace_root, version) VALUES ('older-sentinel','older-workspace',1);")
        .unwrap();
    let source = root.path().join("older.sqlite");
    fs::copy(&producer, &source).unwrap();
    fs::copy(wal(&producer), wal(&source)).unwrap();
    drop(connection);
    let staging = root.path().join("older-staging");
    let report = profile_ops::recovery_probe(
        &source,
        &staging,
        "recovery-operation-older",
        &"8".repeat(64),
        &"9".repeat(64),
    )
    .unwrap();
    assert_eq!(report["stagedDatabase"]["schemaVersion"], json!(1));
    let store = Store::open(staging.join("goalport.sqlite")).unwrap();
    assert_eq!(
        store.schema_version().unwrap(),
        goalport_core::store::SCHEMA_VERSION
    );
    let connection = Connection::open(staging.join("goalport.sqlite")).unwrap();
    let workspace: String = connection
        .query_row(
            "SELECT workspace_root FROM projects WHERE id='older-sentinel'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(workspace, "older-workspace");
}
