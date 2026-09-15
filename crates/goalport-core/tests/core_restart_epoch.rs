#![cfg(windows)]

use goalport_core::{
    AccessMode, Attempt, AttemptRecovery, Command, CommandState, Decision, DecisionState,
    LeaseState, OutboxIntent, OutboxState, Store, WorkspaceLease,
    ipc::{NamedPipeClient, decode_frame, read_frame, write_frame},
    process_identity::{ProcessObservation, observe_process},
    product_receipts::{
        PriorCoreStatus, begin_startup_epoch, classify_recorded_process, fail_startup_epoch,
    },
};
use serde_json::json;
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::{Child, Command as ProcessCommand, Stdio},
    sync::{Arc, Barrier},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const CORE: &str = env!("CARGO_BIN_EXE_goalport-core");

fn unique(label: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    format!("{label}-{}-{nanos}", std::process::id())
}

fn ready_path(db: &Path) -> PathBuf {
    let mut value = db.as_os_str().to_os_string();
    value.push(".launch-ready");
    PathBuf::from(value)
}

fn core_command(db: &Path, pipe: &str, nonce: &str) -> ProcessCommand {
    let mut command = ProcessCommand::new(CORE);
    command
        .args(["serve", "--pipe", pipe, "--db"])
        .arg(db)
        .env("GOALPORT_REQUIRE_ISOLATED", "1")
        .env("GOALPORT_LAUNCH_NONCE", nonce)
        .env(
            "GOALPORT_RUN_SLUG",
            "goalport-evidence-verifier-core-restart-test",
        )
        .env("GOALPORT_ELECTRON_PID", std::process::id().to_string())
        .env("GOALPORT_ELECTRON_CREATED_MS", "1")
        .env("GOALPORT_ELECTRON_EXE", "core-restart-epoch-test.exe")
        .env("GOALPORT_ELECTRON_SHA256", "test-only")
        .env("GOALPORT_LAUNCHER_PID", std::process::id().to_string())
        .env("GOALPORT_LAUNCHER_CREATED_MS", "1")
        .env("GOALPORT_LAUNCHER_EXE", "core-restart-epoch-test.exe")
        .env("GOALPORT_LAUNCHER_SHA256", "test-only")
        .env(
            "GOALPORT_LAUNCHER_PARENT_PID",
            std::process::id().to_string(),
        )
        .env("GOALPORT_LAUNCH_REQUESTED_AT", "2026-09-02T00:00:00.000Z")
        .env("GOALPORT_LAUNCHER_STARTED_AT", "2026-09-02T00:00:00.001Z")
        .env("GOALPORT_CORE_SPAWNED_AT", "2026-09-02T00:00:00.002Z");
    command
}

fn spawn_core(db: &Path, pipe: &str, nonce: &str) -> Child {
    core_command(db, pipe, nonce)
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap()
}

fn wait_ready(db: &Path, nonce: &str) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        if let Ok(text) = fs::read_to_string(ready_path(db)) {
            if text.contains(nonce)
                && text.contains("coreEpochId")
                && text.contains("READY_COMMITTED")
            {
                return;
            }
        }
        thread::sleep(Duration::from_millis(20));
    }
    panic!("Core did not write launch-ready for {nonce}");
}

fn wait_rejected(child: &mut Child) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if let Some(status) = child.try_wait().unwrap() {
            assert!(!status.success(), "competing Core unexpectedly succeeded");
            return;
        }
        thread::sleep(Duration::from_millis(20));
    }
    let _ = child.kill();
    let _ = child.wait();
    panic!("competing Core did not reject promptly");
}

fn connect_client(pipe: &str) -> NamedPipeClient {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match NamedPipeClient::connect(pipe) {
            Ok(client) => return client,
            Err(_) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
            Err(error) => panic!("Core pipe did not accept a client: {error}"),
        }
    }
}

fn snapshot_ok(pipe: &str, request_id: &str) {
    let mut client = connect_client(pipe);
    write_frame(
        &mut client,
        &json!({
            "protocolVersion": "goalport.ipc.v1",
            "requestId": request_id,
            "entityVersion": 0,
            "messageType": "snapshot",
            "payload": {}
        }),
    )
    .unwrap();
    let frame = read_frame(&mut client)
        .unwrap()
        .expect("Core returned no snapshot");
    let response: serde_json::Value = decode_frame(&frame).unwrap();
    assert_eq!(response["ok"], true, "snapshot {request_id}: {response}");
}

fn independent_process_signaled(pid: u32) -> bool {
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const SYNCHRONIZE: u32 = 0x0010_0000;
    const WAIT_OBJECT_0: u32 = 0;
    unsafe {
        unsafe extern "system" {
            fn OpenProcess(
                desired_access: u32,
                inherit_handle: i32,
                process_id: u32,
            ) -> *mut std::ffi::c_void;
            fn WaitForSingleObject(handle: *mut std::ffi::c_void, milliseconds: u32) -> u32;
            fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
        }
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, 0, pid);
        if handle.is_null() {
            return false;
        }
        let wait = WaitForSingleObject(handle, 10_000);
        CloseHandle(handle);
        wait == WAIT_OBJECT_0
    }
}

fn wait_prior_ended(store: &Store) {
    let prior = store.latest_core_launch_epoch().unwrap().unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if classify_recorded_process(
            u32::try_from(prior.core_pid).unwrap(),
            &prior.core_creation_date,
            &prior.core_executable_path,
        ) == PriorCoreStatus::Ended
        {
            return;
        }
        thread::sleep(Duration::from_millis(20));
    }
    panic!("prior Core identity did not become decisively ended");
}

fn assert_recorded_ended_while_retained(store: &Store, retained_pid: u32) {
    assert!(
        independent_process_signaled(retained_pid),
        "OS must confirm pid {retained_pid} terminated on a test-owned handle"
    );
    let prior = store.latest_core_launch_epoch().unwrap().unwrap();
    let pid = u32::try_from(prior.core_pid).unwrap();
    assert_eq!(pid, retained_pid);
    assert!(
        matches!(observe_process(pid), ProcessObservation::NotRunning),
        "terminated Core with a retained object must not be Live: {:?}",
        observe_process(pid)
    );
    assert_eq!(
        classify_recorded_process(pid, &prior.core_creation_date, &prior.core_executable_path),
        PriorCoreStatus::Ended
    );
}

#[test]
fn real_process_restart_preserves_history_and_uncertainty() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("restart.sqlite");
    let pipe = unique("goalport-core-restart");
    let nonce_one = "11111111-1111-4111-8111-111111111111";
    let nonce_two = "22222222-2222-4222-8222-222222222222";
    let mut first = spawn_core(&db, &pipe, nonce_one);
    wait_ready(&db, nonce_one);
    snapshot_ok(&pipe, "restart-live");
    let lingering = connect_client(&pipe);

    let mut duplicate = spawn_core(&db, &pipe, nonce_one);
    wait_rejected(&mut duplicate);
    let mut while_live = spawn_core(&db, &pipe, nonce_two);
    wait_rejected(&mut while_live);

    let store = Store::open(&db).unwrap();
    store
        .insert_attempt(&Attempt::new(
            "attempt-restart",
            "task-restart",
            "scenario",
            "cap-v1",
        ))
        .unwrap();
    store
        .record_command(&Command {
            id: "command-restart".into(),
            attempt_id: "attempt-restart".into(),
            kind: "external-write".into(),
            payload_hash: "payload".into(),
            state: CommandState::Pending,
        })
        .unwrap();
    store
        .update_command_state("command-restart", CommandState::Executing)
        .unwrap();
    store
        .insert_outbox(&OutboxIntent {
            id: "outbox-restart".into(),
            command_id: "command-restart".into(),
            effect_kind: "external-write".into(),
            target: "synthetic".into(),
            state: OutboxState::Pending,
        })
        .unwrap();
    store
        .update_outbox_state("outbox-restart", OutboxState::Dispatching, None)
        .unwrap();
    store
        .acquire_lease(&WorkspaceLease::new(
            dir.path().join("workspace"),
            "attempt-restart",
            AccessMode::Mutating,
        ))
        .unwrap();
    store
        .insert_decision(&Decision {
            id: "permission-restart".into(),
            attempt_id: "attempt-restart".into(),
            kind: "permission".into(),
            state: DecisionState::Pending,
        })
        .unwrap();
    store
        .upsert_attempt_recovery(&AttemptRecovery {
            attempt_id: "attempt-restart".into(),
            provider: "scenario".into(),
            session_hash: Some("old-session-hash".into()),
            process_epoch: Some("old-runtime-epoch".into()),
            pid: Some(9999),
            last_seq: 0,
            pending_permission_ids: "[\"permission-restart\"]".into(),
            outbox_ids: "[\"outbox-restart\"]".into(),
            lease_workspace_key: Some("synthetic".into()),
            recovery_class: Some("R1".into()),
            prompt_replay: false,
        })
        .unwrap();
    let attempt_count_before = store.counts().unwrap().attempts;
    let event_count_before = store.list_events("attempt-restart").unwrap().len();

    let first_pid = first.id();
    first.kill().unwrap();
    first.wait().unwrap();
    drop(first);
    assert_recorded_ended_while_retained(&store, first_pid);
    let mut second = spawn_core(&db, &pipe, nonce_two);
    wait_ready(&db, nonce_two);
    snapshot_ok(&pipe, "restart-after-exit");
    drop(lingering);

    let store = Store::open(&db).unwrap();
    let epochs = store.list_core_launch_epochs().unwrap();
    assert_eq!(epochs.len(), 2);
    assert_eq!(epochs[0].state, "ENDED");
    assert_eq!(epochs[1].state, "READY_COMMITTED");
    assert_ne!(epochs[0].epoch_id, epochs[1].epoch_id);
    assert_ne!(epochs[0].core_pid, epochs[1].core_pid);
    assert_ne!(epochs[0].core_creation_date, epochs[1].core_creation_date);
    assert!(
        store
            .get_product_receipt_by_nonce("startup", nonce_one)
            .unwrap()
            .is_some()
    );
    assert!(
        store
            .get_product_receipt_by_nonce("startup", nonce_two)
            .unwrap()
            .is_some()
    );
    assert_eq!(
        store.get_command("command-restart").unwrap().state,
        CommandState::Unknown
    );
    assert_eq!(
        store.get_outbox("outbox-restart").unwrap().state,
        OutboxState::Unknown
    );
    assert_eq!(store.leases().unwrap()[0].state, LeaseState::Uncertain);
    assert_eq!(
        store
            .list_decisions()
            .unwrap()
            .iter()
            .find(|row| row.id == "permission-restart")
            .unwrap()
            .state,
        DecisionState::Pending
    );
    assert_eq!(store.counts().unwrap().attempts, attempt_count_before);
    assert_eq!(
        store.list_events("attempt-restart").unwrap().len(),
        event_count_before
    );
    let recovery = store
        .get_attempt_recovery("attempt-restart")
        .unwrap()
        .unwrap();
    assert_eq!(recovery.recovery_class.as_deref(), Some("R1_UNSUPPORTED"));
    assert_eq!(recovery.pid, None);
    assert_eq!(recovery.process_epoch, None);
    assert_eq!(recovery.session_hash.as_deref(), Some("old-session-hash"));
    assert_eq!(recovery.pending_permission_ids, "[\"permission-restart\"]");
    assert_eq!(recovery.outbox_ids, "[\"outbox-restart\"]");
    assert!(!recovery.prompt_replay);
    assert_eq!(
        store
            .latest_core_launch_epoch()
            .unwrap()
            .unwrap()
            .reconciliation
            .unwrap()["runtimeAttachment"],
        "UNKNOWN_OR_UNSUPPORTED"
    );

    second.kill().unwrap();
    second.wait().unwrap();
}

#[test]
fn separate_process_race_accepts_only_one_epoch() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("race.sqlite");
    let pipe = unique("goalport-core-race");
    let barrier = Arc::new(Barrier::new(3));
    let mut handles = Vec::new();
    for nonce in [
        "33333333-3333-4333-8333-333333333333",
        "44444444-4444-4444-8444-444444444444",
    ] {
        let barrier = barrier.clone();
        let db = db.clone();
        let pipe = pipe.clone();
        handles.push(thread::spawn(move || {
            barrier.wait();
            spawn_core(&db, &pipe, nonce)
        }));
    }
    barrier.wait();
    let mut children = handles
        .into_iter()
        .map(|handle| handle.join().unwrap())
        .collect::<Vec<_>>();
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        if ready_path(&db).is_file() {
            break;
        }
        thread::sleep(Duration::from_millis(20));
    }
    assert!(ready_path(&db).is_file());
    thread::sleep(Duration::from_millis(200));
    let mut exited = 0;
    for child in &mut children {
        if child.try_wait().unwrap().is_some() {
            exited += 1;
        }
    }
    assert_eq!(exited, 1, "exactly one racing Core must be rejected");
    let store = Store::open(&db).unwrap();
    assert_eq!(store.list_core_launch_epochs().unwrap().len(), 1);
    for child in &mut children {
        if child.try_wait().unwrap().is_none() {
            child.kill().unwrap();
            child.wait().unwrap();
        }
    }
}

#[test]
fn failed_claim_has_no_startup_receipt() {
    let _guard = crate_env_lock();
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("failed.sqlite");
    let store = Store::open(&db).unwrap();
    unsafe {
        env::set_var("GOALPORT_REQUIRE_ISOLATED", "1");
        env::set_var(
            "GOALPORT_LAUNCH_NONCE",
            "55555555-5555-4555-8555-555555555555",
        );
    }
    let claim = begin_startup_epoch(&store, "failed-claim", &db).unwrap();
    fail_startup_epoch(&store, &claim, "synthetic reconciliation failure").unwrap();
    assert!(
        store
            .get_product_receipt_by_nonce("startup", &claim.launch_nonce)
            .unwrap()
            .is_none()
    );
    assert_eq!(
        store.latest_core_launch_epoch().unwrap().unwrap().state,
        "ABORTED"
    );
}

#[test]
fn startup_ready_failure_windows_abort_and_allow_reconciled_restart() {
    for (index, stage) in [
        "before-startup",
        "after-startup-before-ready",
        "ready-write",
        "ready-sync",
        "after-ready-before-confirm",
        "after-confirm-before-ready",
        "ready-confirm-write",
        "ready-confirm-sync",
        "ready-confirm-rename",
        "ready-confirm-read",
    ]
    .into_iter()
    .enumerate()
    {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join(format!("failure-{index}.sqlite"));
        let pipe = unique(&format!("goalport-core-failure-{index}"));
        let failed_nonce = format!("failed-{index}");
        let mut failed = core_command(&db, &pipe, &failed_nonce)
            .env("GOALPORT_TEST_STARTUP_FAILURE", stage)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let status = failed.wait().unwrap();
        assert!(
            !status.success(),
            "fault stage {stage} unexpectedly succeeded"
        );
        drop(failed);

        let store = Store::open(&db).unwrap();
        let failed_epoch = store
            .list_core_launch_epochs()
            .unwrap()
            .into_iter()
            .find(|epoch| epoch.launch_nonce == failed_nonce)
            .unwrap();
        assert_eq!(failed_epoch.state, "ABORTED", "stage {stage}");
        if let Some(startup) = store
            .get_product_receipt_by_nonce("startup", &failed_nonce)
            .unwrap()
        {
            assert_eq!(startup["startupState"], "ABORTED", "stage {stage}");
        }
        if let Some(ready) = store
            .get_product_receipt_by_nonce("launch-ready", &failed_nonce)
            .unwrap()
        {
            assert_eq!(ready["readyState"], "ABORTED", "stage {stage}");
        }
        wait_prior_ended(&store);
        drop(store);

        let next_nonce = format!("recovered-{index}");
        let mut recovered = spawn_core(&db, &pipe, &next_nonce);
        wait_ready(&db, &next_nonce);
        let store = Store::open(&db).unwrap();
        let recovered_epoch = store.latest_core_launch_epoch().unwrap().unwrap();
        assert_eq!(recovered_epoch.launch_nonce, next_nonce);
        assert_eq!(recovered_epoch.state, "READY_COMMITTED");
        assert_eq!(
            store
                .get_product_receipt_by_nonce("startup", &next_nonce)
                .unwrap()
                .unwrap()["startupState"],
            "READY_COMMITTED"
        );
        assert_eq!(
            store
                .get_product_receipt_by_nonce("launch-ready", &next_nonce)
                .unwrap()
                .unwrap()["readyState"],
            "READY_COMMITTED"
        );
        recovered.kill().unwrap();
        recovered.wait().unwrap();
    }
}

#[test]
fn still_active_exit_code_with_retained_handle_is_not_running() {
    let mut child = ProcessCommand::new("powershell")
        .args(["-NoProfile", "-Command", "exit 259"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let pid = child.id();
    let status = child.wait().unwrap();
    assert_eq!(status.code(), Some(259));
    assert!(
        independent_process_signaled(pid),
        "OS must confirm the STILL_ACTIVE exit while the Child handle is retained"
    );
    assert!(
        matches!(observe_process(pid), ProcessObservation::NotRunning),
        "exit code 259 must not be classified as Live: {:?}",
        observe_process(pid)
    );
    assert_eq!(
        classify_recorded_process(pid, "/Date(1)/", r"C:\not-the-occupant.exe"),
        PriorCoreStatus::Ended
    );
}

#[test]
fn unconfirmable_identity_still_refuses_startup() {
    let _guard = crate_env_lock();
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("unknown.sqlite");
    let store = Store::open(&db).unwrap();
    store
        .put_product_receipt(
            "startup:99999999-9999-4999-8999-999999999999",
            "startup",
            Some("99999999-9999-4999-8999-999999999999"),
            None,
            None,
            &json!({
                "kind":"startup",
                "launchNonce":"99999999-9999-4999-8999-999999999999",
                "core":{"pid":4,"creationDate":"/Date(1)/","executablePath":"C:\\Windows\\System32\\ntoskrnl.exe","executableSha256":"unknown"}
            }),
        )
        .unwrap();
    unsafe {
        env::set_var("GOALPORT_REQUIRE_ISOLATED", "1");
        env::set_var(
            "GOALPORT_LAUNCH_NONCE",
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        );
    }
    let error = begin_startup_epoch(&store, "unknown-identity", &db).unwrap_err();
    assert!(
        error.contains("prior Core identity is unknown"),
        "unexpected refusal: {error}"
    );
    assert!(store.list_core_launch_epochs().unwrap().is_empty());
}

fn crate_env_lock() -> std::sync::MutexGuard<'static, ()> {
    use std::sync::{Mutex, OnceLock};
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(())).lock().unwrap()
}

#[test]
fn schema_four_legacy_receipt_is_preserved_on_new_epoch() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("legacy.sqlite");
    let store = Store::open(&db).unwrap();
    let legacy_nonce = "66666666-6666-4666-8666-666666666666";
    store
        .put_product_receipt(
            &format!("startup:{legacy_nonce}"),
            "startup",
            Some(legacy_nonce),
            None,
            None,
            &json!({
                "kind":"startup",
                "launchNonce":legacy_nonce,
                "core":{"pid":4_000_000_000u64,"creationDate":"/Date(1)/","executablePath":"C:\\legacy\\goalport-core.exe","executableSha256":"legacy"}
            }),
        )
        .unwrap();
    drop(store);
    let nonce = "77777777-7777-4777-8777-777777777777";
    let pipe = unique("goalport-core-legacy");
    let mut child = spawn_core(&db, &pipe, nonce);
    wait_ready(&db, nonce);
    let store = Store::open(&db).unwrap();
    assert!(
        store
            .get_product_receipt_by_nonce("startup", legacy_nonce)
            .unwrap()
            .is_some()
    );
    assert!(
        store
            .get_product_receipt_by_nonce("startup", nonce)
            .unwrap()
            .is_some()
    );
    assert_eq!(store.list_core_launch_epochs().unwrap().len(), 1);
    assert_eq!(
        store.list_core_launch_epochs().unwrap()[0]
            .previous_epoch_id
            .as_deref(),
        Some("legacy:66666666-6666-4666-8666-666666666666")
    );
    child.kill().unwrap();
    child.wait().unwrap();
}

#[test]
fn legacy_receipt_without_nonce_is_rejected_as_unknown() {
    let _guard = crate_env_lock();
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("legacy-missing-nonce.sqlite");
    let store = Store::open(&db).unwrap();
    store
        .put_product_receipt(
            "startup:legacy-missing-nonce",
            "startup",
            None,
            None,
            None,
            &json!({
                "kind":"startup",
                "core":{"pid":4_000_000_000u64,"creationDate":"/Date(1)/","executablePath":"C:\\legacy\\goalport-core.exe","executableSha256":"legacy"}
            }),
        )
        .unwrap();
    unsafe {
        env::set_var("GOALPORT_REQUIRE_ISOLATED", "1");
        env::set_var(
            "GOALPORT_LAUNCH_NONCE",
            "88888888-8888-4888-8888-888888888888",
        );
    }
    let error = begin_startup_epoch(&store, "legacy-missing-nonce", &db).unwrap_err();
    assert!(error.contains("legacy startup receipt has no launch nonce"));
    assert!(store.list_core_launch_epochs().unwrap().is_empty());
}
