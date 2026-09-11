//! Product-side Core launch epochs and close-choice receipts.

use crate::{
    process_identity::{
        self, ProcessIdentity, ProcessObservation, env_string, env_u32, identity_from_env,
    },
    store::{self, CoreLaunchEpoch, Store},
};
use serde_json::{Value, json};
use std::{
    env, fs,
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone)]
pub struct StartupEpochClaim {
    pub epoch_id: String,
    pub launch_nonce: String,
    pub previous_epoch_id: Option<String>,
    pub core: ProcessIdentity,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PriorCoreStatus {
    NoPrior,
    Ended,
    LiveExact,
    Unknown,
}

pub fn launch_ready_path(db: &Path) -> PathBuf {
    let mut path = db.as_os_str().to_os_string();
    path.push(".launch-ready");
    PathBuf::from(path)
}

fn failure_stage(name: &str) -> bool {
    env::var("GOALPORT_REQUIRE_ISOLATED").ok().as_deref() == Some("1")
        && env::var("GOALPORT_TEST_STARTUP_FAILURE").ok().as_deref() == Some(name)
}

fn write_synced(
    path: &Path,
    bytes: &[u8],
    fail_write: bool,
    fail_sync: bool,
) -> Result<(), String> {
    if fail_write {
        return Err("injected launch-ready write failure".into());
    }
    let mut file = fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(path)
        .map_err(|error| format!("unable to open launch-ready acknowledgement: {error}"))?;
    file.write_all(bytes)
        .map_err(|error| format!("unable to write launch-ready acknowledgement: {error}"))?;
    if fail_sync {
        return Err("injected launch-ready sync failure".into());
    }
    file.sync_all()
        .map_err(|error| format!("unable to sync launch-ready acknowledgement: {error}"))
}

fn replace_with_synced(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temp = PathBuf::from(format!("{}.commit-{}", path.display(), std::process::id()));
    let result = (|| {
        write_synced(
            &temp,
            bytes,
            failure_stage("ready-confirm-write"),
            failure_stage("ready-confirm-sync"),
        )?;
        if failure_stage("ready-confirm-read") {
            return Err("injected launch-ready read-back confirmation failure".into());
        }
        let confirmed = fs::read(&temp)
            .map_err(|error| format!("unable to confirm staged launch-ready: {error}"))?;
        if confirmed != bytes {
            return Err("staged launch-ready read-back did not match committed receipt".into());
        }
        if failure_stage("ready-confirm-rename") {
            return Err("injected launch-ready confirm rename failure".into());
        }
        if path.exists() {
            fs::remove_file(path)
                .map_err(|error| format!("unable to replace pending launch-ready: {error}"))?;
        }
        fs::rename(&temp, path)
            .map_err(|error| format!("unable to commit launch-ready acknowledgement: {error}"))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn ready_file_matches(path: &Path, epoch_id: &str, nonce: &str) -> bool {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .is_some_and(|value| {
            value.get("readyState").and_then(Value::as_str) == Some("READY_COMMITTED")
                && value.get("coreEpochId").and_then(Value::as_str) == Some(epoch_id)
                && value.get("launchNonce").and_then(Value::as_str) == Some(nonce)
        })
}

fn normalized_path(value: &str) -> String {
    value
        .strip_prefix(r"\\?\")
        .unwrap_or(value)
        .replace('/', "\\")
        .to_ascii_lowercase()
}

fn recorded_status(
    recorded_pid: u32,
    recorded_creation_date: &str,
    recorded_path: &str,
    observation: ProcessObservation,
) -> PriorCoreStatus {
    match observation {
        ProcessObservation::NotRunning => PriorCoreStatus::Ended,
        ProcessObservation::Unknown(_) => PriorCoreStatus::Unknown,
        ProcessObservation::Live(live) => {
            let creation_matches = live.creation_date() == recorded_creation_date;
            let path_matches =
                normalized_path(&live.executable_path) == normalized_path(recorded_path);
            if live.pid == recorded_pid && creation_matches && path_matches {
                PriorCoreStatus::LiveExact
            } else {
                PriorCoreStatus::Ended
            }
        }
    }
}

pub fn classify_recorded_process(
    recorded_pid: u32,
    recorded_creation_date: &str,
    recorded_path: &str,
) -> PriorCoreStatus {
    if recorded_pid == 0 || recorded_creation_date.is_empty() || recorded_path.is_empty() {
        return PriorCoreStatus::Unknown;
    }
    recorded_status(
        recorded_pid,
        recorded_creation_date,
        recorded_path,
        process_identity::observe_process(recorded_pid),
    )
}

fn require_prior_ended(status: PriorCoreStatus, label: &str) -> Result<(), String> {
    match status {
        PriorCoreStatus::NoPrior | PriorCoreStatus::Ended => Ok(()),
        PriorCoreStatus::LiveExact => Err(format!(
            "refusing Core startup: prior Core epoch is still live ({label})"
        )),
        PriorCoreStatus::Unknown => Err(format!(
            "refusing Core startup: prior Core identity is unknown ({label})"
        )),
    }
}

fn epoch_status(epoch: &CoreLaunchEpoch) -> PriorCoreStatus {
    classify_recorded_process(
        u32::try_from(epoch.core_pid).unwrap_or(0),
        &epoch.core_creation_date,
        &epoch.core_executable_path,
    )
}

fn legacy_status(receipt: &Value) -> PriorCoreStatus {
    let core = receipt.get("core").unwrap_or(&Value::Null);
    classify_recorded_process(
        core.get("pid")
            .and_then(Value::as_u64)
            .and_then(|pid| u32::try_from(pid).ok())
            .unwrap_or(0),
        core.get("creationDate")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        core.get("executablePath")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    )
}

/// Atomically claim a new launch epoch. The claim is durable but is not a
/// startup receipt; completion is forbidden until restart reconciliation ends.
pub fn begin_startup_epoch(
    store: &Store,
    _pipe: &str,
    _db: &Path,
) -> Result<StartupEpochClaim, String> {
    let isolated = env::var("GOALPORT_REQUIRE_ISOLATED").ok().as_deref() == Some("1");
    let nonce = env_string("GOALPORT_LAUNCH_NONCE").trim().to_string();
    if nonce.is_empty() {
        if isolated {
            return Err(
                "GOALPORT_LAUNCH_NONCE is required when GOALPORT_REQUIRE_ISOLATED=1".into(),
            );
        }
        return Err("Core launch epoch requires GOALPORT_LAUNCH_NONCE".into());
    }
    let core = process_identity::current_identity();
    if core.pid == 0
        || core.created_ms == 0
        || core.executable_path.is_empty()
        || core.executable_sha256.is_empty()
    {
        return Err("current Core identity is incomplete".into());
    }
    let epoch_id = format!("core-epoch:{nonce}");

    for _ in 0..4 {
        let latest_epoch = store
            .latest_core_launch_epoch()
            .map_err(|error| error.to_string())?;
        if let Some(previous) = latest_epoch.as_ref() {
            if previous.launch_nonce == nonce {
                return Err(format!(
                    "duplicate or replayed Core launch epoch nonce {nonce}"
                ));
            }
            let status = epoch_status(previous);
            require_prior_ended(status, &previous.epoch_id)?;
            if status == PriorCoreStatus::Ended
                && (matches!(previous.state.as_str(), "RECONCILING" | "STARTUP_PENDING")
                    || (previous.state == "READY_COMMITTED"
                        && !ready_file_matches(
                            &launch_ready_path(_db),
                            &previous.epoch_id,
                            &previous.launch_nonce,
                        )))
            {
                let reason = json!({
                    "status":"aborted",
                    "reason":"prior Core ended before READY_COMMITTED file was confirmed",
                    "atUtc":store::utc_now_iso()
                });
                let startup = store
                    .get_product_receipt_by_id(&format!("startup:{}", previous.launch_nonce))
                    .map_err(|error| error.to_string())?
                    .map(|mut value| {
                        value["startupState"] = json!("ABORTED");
                        value["epochState"] = json!("ABORTED");
                        value["abort"] = reason.clone();
                        value
                    });
                let ready = store
                    .get_product_receipt_by_id(&format!("launch-ready:{}", previous.launch_nonce))
                    .map_err(|error| error.to_string())?
                    .map(|mut value| {
                        value["readyState"] = json!("ABORTED");
                        value["abort"] = reason.clone();
                        value
                    });
                store
                    .abort_core_launch_epoch(
                        &previous.epoch_id,
                        &previous.launch_nonce,
                        &reason,
                        startup.as_ref(),
                        ready.as_ref(),
                    )
                    .map_err(|error| error.to_string())?;
            }
        }
        let legacy = if latest_epoch.is_none() {
            store
                .latest_product_receipt("startup")
                .map_err(|error| error.to_string())?
        } else {
            None
        };
        if let Some(previous) = legacy.as_ref() {
            let previous_nonce = previous
                .get("launchNonce")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if previous_nonce.is_empty() {
                return Err(
                    "refusing Core startup: legacy startup receipt has no launch nonce".into(),
                );
            }
            if previous_nonce == nonce {
                return Err(format!(
                    "duplicate or replayed legacy Core launch nonce {nonce}"
                ));
            }
            require_prior_ended(legacy_status(previous), &format!("legacy:{previous_nonce}"))?;
        }

        let previous_epoch_id = latest_epoch
            .as_ref()
            .map(|previous| previous.epoch_id.clone())
            .or_else(|| {
                legacy.as_ref().and_then(|previous| {
                    previous
                        .get("launchNonce")
                        .and_then(Value::as_str)
                        .filter(|value| !value.is_empty())
                        .map(|value| format!("legacy:{value}"))
                })
            });
        let record = CoreLaunchEpoch {
            epoch_id: epoch_id.clone(),
            launch_nonce: nonce.clone(),
            core_pid: i64::from(core.pid),
            core_creation_date: core.creation_date(),
            core_executable_path: core.executable_path.clone(),
            core_executable_sha256: core.executable_sha256.clone(),
            previous_epoch_id: previous_epoch_id.clone(),
            state: "RECONCILING".into(),
            reconciliation: None,
            created_at: store::utc_now_iso(),
            activated_at: None,
        };
        let expected_legacy_nonce = legacy
            .as_ref()
            .and_then(|previous| previous.get("launchNonce"))
            .and_then(Value::as_str);
        if store
            .claim_core_launch_epoch(
                &record,
                latest_epoch
                    .as_ref()
                    .map(|previous| previous.epoch_id.as_str()),
                expected_legacy_nonce,
            )
            .map_err(|error| error.to_string())?
        {
            return Ok(StartupEpochClaim {
                epoch_id,
                launch_nonce: nonce,
                previous_epoch_id,
                core,
            });
        }
    }
    Err("Core launch epoch compare-and-swap lost repeatedly".into())
}

pub fn complete_startup_epoch(
    store: &Store,
    pipe: &str,
    db: &Path,
    claim: &StartupEpochClaim,
    reconciliation: &Value,
) -> Result<Value, String> {
    let startup_persisted_at = store::utc_now_iso();
    let mut electron = identity_from_env("GOALPORT_ELECTRON");
    if let Some(object) = electron.as_object_mut() {
        object.insert(
            "observedByLauncherParentPid".into(),
            json!(env_u32("GOALPORT_LAUNCHER_PARENT_PID")),
        );
    }
    let mut launcher = identity_from_env("GOALPORT_LAUNCHER");
    if let Some(object) = launcher.as_object_mut() {
        object.insert(
            "observedParentPid".into(),
            json!(env_u32("GOALPORT_LAUNCHER_PARENT_PID")),
        );
        if object.get("parentPid").and_then(Value::as_u64).unwrap_or(0) == 0 {
            object.insert(
                "parentPid".into(),
                json!(env_u32("GOALPORT_LAUNCHER_PARENT_PID")),
            );
        }
    }
    let mut core_json = claim.core.to_json();
    if let Some(object) = core_json.as_object_mut() {
        object.insert("observedParentPid".into(), json!(claim.core.parent_pid));
        object.insert("observedLauncherPid".into(), json!(claim.core.parent_pid));
    }
    let startup_receipt_id = format!("startup:{}", claim.launch_nonce);
    let ready_receipt_id = format!("ready:{}", claim.epoch_id);
    let mut startup = json!({
        "kind": "startup",
        "startupReceiptId": startup_receipt_id,
        "launchReadyReceiptId": ready_receipt_id,
        "launchNonce": claim.launch_nonce,
        "coreEpochId": claim.epoch_id,
        "previousCoreEpochId": claim.previous_epoch_id,
        "startupState": "STARTUP_PENDING",
        "epochState": "STARTUP_PENDING",
        "reconciliation": reconciliation,
        "runSlug": env_string("GOALPORT_RUN_SLUG"),
        "pipe": pipe,
        "pipeIdentity": pipe,
        "database": db.display().to_string(),
        "databaseIdentity": db.display().to_string(),
        "electron": electron,
        "launcher": launcher.clone(),
        "core": core_json.clone(),
        "timestamps": {
            "launchRequestedAtUtc": env_string("GOALPORT_LAUNCH_REQUESTED_AT"),
            "launcherStartedAtUtc": env_string("GOALPORT_LAUNCHER_STARTED_AT"),
            "coreSpawnedAtUtc": env_string("GOALPORT_CORE_SPAWNED_AT"),
            "coreReadyAtUtc": startup_persisted_at,
            "receiptPersistedAtUtc": startup_persisted_at,
            "launchReadyAtUtc": null,
        }
    });
    if failure_stage("before-startup") {
        return Err("injected failure before startup receipt".into());
    }
    store
        .stage_core_launch_startup(
            &claim.epoch_id,
            &claim.launch_nonce,
            reconciliation,
            &startup,
            &startup_receipt_id,
        )
        .map_err(|error| error.to_string())?;
    if failure_stage("after-startup-before-ready") {
        return Err("injected failure after startup receipt before launch-ready".into());
    }
    let run_slug = env_string("GOALPORT_RUN_SLUG");
    let mut ready = json!({
        "kind": "launch-ready",
        "readyReceiptId": ready_receipt_id,
        "startupReceiptId": startup_receipt_id,
        "readyState": "STARTUP_PENDING",
        "launchNonce": claim.launch_nonce,
        "coreEpochId": claim.epoch_id,
        "runSlug": run_slug,
        "pipeIdentity": pipe,
        "databaseIdentity": db.display().to_string(),
        "launcher": launcher,
        "core": core_json,
        "timestamps": {
            "coreCreatedAt": claim.core.creation_date(),
            "launchRequestedAtUtc": env_string("GOALPORT_LAUNCH_REQUESTED_AT"),
            "launcherStartedAtUtc": env_string("GOALPORT_LAUNCHER_STARTED_AT"),
            "coreSpawnedAtUtc": env_string("GOALPORT_CORE_SPAWNED_AT"),
            "startupReceiptPersistedAtUtc": startup_persisted_at,
            "readyAtUtc": null,
        }
    });
    let pending_bytes = serde_json::to_vec_pretty(&ready).map_err(|error| error.to_string())?;
    write_synced(
        &launch_ready_path(db),
        &pending_bytes,
        failure_stage("ready-write"),
        failure_stage("ready-sync"),
    )?;
    if failure_stage("after-ready-before-confirm") {
        return Err("injected failure after pending ready before confirmation".into());
    }
    let ready_at = store::utc_now_iso();
    startup["startupState"] = json!("READY_COMMITTED");
    startup["epochState"] = json!("READY_COMMITTED");
    startup["timestamps"]["launchReadyAtUtc"] = json!(ready_at);
    ready["readyState"] = json!("READY_COMMITTED");
    ready["timestamps"]["readyAtUtc"] = json!(ready_at);
    store
        .commit_core_launch_ready(
            &claim.epoch_id,
            &claim.launch_nonce,
            &startup,
            &ready,
            &ready_receipt_id,
            &ready_at,
        )
        .map_err(|error| error.to_string())?;
    if failure_stage("after-confirm-before-ready") {
        return Err("injected failure after DB confirmation before committed ready file".into());
    }
    let committed_bytes = serde_json::to_vec_pretty(&ready).map_err(|error| error.to_string())?;
    let ready_path = launch_ready_path(db);
    replace_with_synced(&ready_path, &committed_bytes)?;
    Ok(startup)
}

pub fn fail_startup_epoch(
    store: &Store,
    claim: &StartupEpochClaim,
    reason: &str,
) -> Result<(), String> {
    let abort = json!({"status":"aborted","reason":reason,"atUtc":store::utc_now_iso()});
    let startup = store
        .get_product_receipt_by_id(&format!("startup:{}", claim.launch_nonce))
        .map_err(|error| error.to_string())?
        .map(|mut value| {
            value["startupState"] = json!("ABORTED");
            value["epochState"] = json!("ABORTED");
            value["abort"] = abort.clone();
            value
        });
    let ready = store
        .get_product_receipt_by_id(&format!("launch-ready:{}", claim.launch_nonce))
        .map_err(|error| error.to_string())?
        .map(|mut value| {
            value["readyState"] = json!("ABORTED");
            value["abort"] = abort.clone();
            value
        });
    store
        .abort_core_launch_epoch(
            &claim.epoch_id,
            &claim.launch_nonce,
            &abort,
            startup.as_ref(),
            ready.as_ref(),
        )
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recorded_process_status_is_fail_closed() {
        let live = ProcessIdentity {
            pid: 10,
            parent_pid: 1,
            executable_path: r"C:\pkg\goalport-core.exe".into(),
            executable_sha256: "aa".into(),
            created_ms: 1000,
        };
        assert_eq!(
            recorded_status(
                10,
                "/Date(1000)/",
                r"C:\pkg\goalport-core.exe",
                ProcessObservation::Live(live.clone())
            ),
            PriorCoreStatus::LiveExact
        );
        assert_eq!(
            recorded_status(
                10,
                "/Date(999)/",
                r"C:\pkg\goalport-core.exe",
                ProcessObservation::Live(live)
            ),
            PriorCoreStatus::Ended
        );
        assert_eq!(
            recorded_status(
                10,
                "/Date(1000)/",
                r"C:\pkg\goalport-core.exe",
                ProcessObservation::Unknown("denied".into())
            ),
            PriorCoreStatus::Unknown
        );
        assert_eq!(
            recorded_status(
                10,
                "/Date(1000)/",
                r"C:\pkg\goalport-core.exe",
                ProcessObservation::NotRunning
            ),
            PriorCoreStatus::Ended
        );
    }
}
