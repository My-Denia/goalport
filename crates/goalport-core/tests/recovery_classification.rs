//! Increment 3 of run `goal-runs/runtime-registration-safety`: the recovery classification entry
//! (`classify_recovery`) must not award `R1` to an exited or unconfirmable Runtime because a handle
//! or a pid field still exists, must not read `native_pid == None` as death across transports, and
//! must not remove, release or replace anything while classifying.
//!
//! Command-surface cases drive `CoreServer::handle_json`. Codex app-server cases launch the
//! SYNTHETIC `tests/fixtures/fake-codex-app-server/` (cmd.exe -> node) with an explicit executable
//! into a per-case workspace under `GOALPORT_TEST_ARTIFACT_ROOT`; no real CLI, no subscription. The
//! managed child Core holds is the `cmd.exe` shim, which is the process whose identity is recorded
//! and confirmed. Every codex case holds `CODEX_LOCK` for its whole body: `GOALPORT_CODEX_TRANSPORT`
//! is read inside `intended_binding` before any refusal, and the Core launch epoch commit sets
//! launch-identity variables in-process.
#![cfg(windows)]

use goalport_core::{
    Project, RuntimeManager,
    domain::{Campaign, Task, WorkStatus},
    ipc::{CONNECTED_UI_PROTOCOL_VERSION, CoreServer},
    product_receipts::{begin_startup_epoch, complete_startup_epoch},
    runtime_manager::ProcessConfirmation,
    store::{CampaignAuthorization, Store},
};
use serde_json::{Value, json};
use std::{
    env, fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};

const LIVE_REFUSAL: &str = "has a registered Runtime that is no longer live; it is kept, not replaced";

/// One mutex for everything process-global this file touches: the launch-identity variables the
/// epoch commit sets and `GOALPORT_CODEX_TRANSPORT`.
static CODEX_LOCK: Mutex<()> = Mutex::new(());

const ALLOWED_ENV: &[&str] = &[
    "GOALPORT_SYNTHETIC_ROOT",
    "GOALPORT_TEST_ARTIFACT_ROOT",
    "GOALPORT_CODEX_TRANSPORT",
    "GOALPORT_LAUNCH_NONCE",
    "GOALPORT_LAUNCH_REQUESTED_AT",
    "GOALPORT_LAUNCHER_STARTED_AT",
    "GOALPORT_CORE_SPAWNED_AT",
];

fn assert_env_pinned() {
    for (key, _) in env::vars() {
        if key.starts_with("GOALPORT_") {
            assert!(
                ALLOWED_ENV.contains(&key.as_str())
                    || key.starts_with("GOALPORT_ELECTRON_")
                    || key.starts_with("GOALPORT_LAUNCHER_"),
                "stray {key} in the test environment; the runner must scrub GOALPORT_* first"
            );
        }
    }
}

fn request(id: &str, message_type: &str, payload: Value) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "protocolVersion": CONNECTED_UI_PROTOCOL_VERSION,
        "requestId": id,
        "entityVersion": 0,
        "messageType": message_type,
        "payload": payload
    }))
    .unwrap()
}

fn call(server: &CoreServer, id: &str, message_type: &str, payload: Value) -> Value {
    server
        .handle_json(&request(id, message_type, payload))
        .expect("the command envelope must be accepted by handle_json")
}

fn error_of(response: &Value) -> String {
    assert_eq!(response["ok"], false, "expected a refusal, got {response}");
    response["error"].as_str().unwrap_or_default().to_string()
}

fn fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/fake-codex-app-server/fake-codex-app-server.cmd")
}

fn scratch_root() -> PathBuf {
    env::var_os("GOALPORT_TEST_ARTIFACT_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| env::temp_dir().join("goalport-recovery-classification"))
}

/// The real Core commits a launch epoch at `serve` startup; the fixture commits one through the
/// same product-receipt path (as `grok_acp.rs` does) instead of weakening `persist_recovery`.
/// Caller holds `CODEX_LOCK`.
fn seed_core_epoch(store: &Store, workspace: &Path, nonce: &str) {
    let db = workspace.join("core-fixture.sqlite");
    unsafe {
        env::set_var("GOALPORT_LAUNCH_NONCE", nonce);
        env::set_var("GOALPORT_ELECTRON_PID", "10");
        env::set_var("GOALPORT_ELECTRON_CREATED_MS", "1000");
        env::set_var("GOALPORT_ELECTRON_EXE", r"C:\pkg\GoalPort.exe");
        env::set_var("GOALPORT_ELECTRON_SHA256", "aa");
        env::set_var("GOALPORT_LAUNCHER_PID", "20");
        env::set_var("GOALPORT_LAUNCHER_CREATED_MS", "1100");
        env::set_var("GOALPORT_LAUNCHER_EXE", r"C:\pkg\goalport-core-launcher.exe");
        env::set_var("GOALPORT_LAUNCHER_SHA256", "bb");
        env::set_var("GOALPORT_LAUNCHER_PARENT_PID", "10");
        env::set_var("GOALPORT_LAUNCH_REQUESTED_AT", "2026-09-02T00:00:00.000Z");
        env::set_var("GOALPORT_LAUNCHER_STARTED_AT", "2026-09-02T00:00:00.010Z");
        env::set_var("GOALPORT_CORE_SPAWNED_AT", "2026-09-02T00:00:00.020Z");
        env::remove_var("GOALPORT_REQUIRE_ISOLATED");
    }
    let claim = begin_startup_epoch(store, r"\\.\pipe\recovery-classification-fixture", &db)
        .expect("startup epoch should be claimable");
    complete_startup_epoch(
        store,
        r"\\.\pipe\recovery-classification-fixture",
        &db,
        &claim,
        &json!({
            "status": "completed",
            "commandsUnknown": 0,
            "outboxUnknown": 0,
            "leasesUncertain": 0,
            "runtimeAttachment": "UNKNOWN_OR_UNSUPPORTED",
            "promptReplay": false
        }),
    )
    .expect("startup epoch should commit");
}

struct Case {
    project: String,
    campaign: String,
    task: String,
    workspace: PathBuf,
}

/// One project per case with its own workspace under the scratch root: the Codex spawn runs with
/// `current_dir(workspace_root)`, so the fixture's scenario file and markers live here.
fn case_project(server: &CoreServer, name: &str, scenario: Option<&str>) -> Case {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let workspace = scratch_root().join(format!("i3-{name}-{nonce}"));
    fs::create_dir_all(&workspace).expect("case workspace should be creatable");
    if let Some(scenario) = scenario {
        fs::write(workspace.join(".fake-codex-scenario"), scenario).unwrap();
    }
    let project = format!("project-{name}");
    let campaign = format!("campaign-{name}");
    let task = format!("task-{name}");
    let store = server.processor().store();
    store
        .insert_project(&Project {
            id: project.clone(),
            workspace_root: workspace.to_string_lossy().into_owned(),
        })
        .unwrap();
    store
        .create_campaign_with_task(
            &project,
            &Campaign {
                id: campaign.clone(),
                goal: format!("recovery classification case {name}"),
                root_task_id: task.clone(),
                state: WorkStatus::InProgress,
            },
            &Task {
                id: task.clone(),
                campaign_id: campaign.clone(),
                title: format!("task {name}"),
                acceptance: "selectable".into(),
                state: WorkStatus::InProgress,
            },
        )
        .unwrap();
    store
        .set_campaign_authorization(&campaign, &CampaignAuthorization::granted())
        .unwrap();
    Case {
        project,
        campaign,
        task,
        workspace,
    }
}

fn select_codex(server: &CoreServer, id: &str, case: &Case, executable: &Path) -> Value {
    call(
        server,
        id,
        "select_runtime",
        json!({
            "projectId": case.project,
            "campaignId": case.campaign,
            "taskId": case.task,
            "provider": "codex",
            "executable": executable.to_string_lossy()
        }),
    )
}

fn classification(server: &CoreServer, attempt: &str) -> (Option<String>, Option<String>) {
    let store = server.processor().store();
    let class = store
        .get_attempt_recovery(attempt)
        .unwrap()
        .and_then(|row| row.recovery_class);
    let identity = store
        .list_event_records(attempt, 0)
        .unwrap()
        .into_iter()
        .filter(|record| record.event.kind == "recovery.classified")
        .last()
        .and_then(|record| record.payload)
        .and_then(|payload| payload["identity"].as_str().map(str::to_owned));
    (class, identity)
}

fn has_event(server: &CoreServer, attempt: &str, kind: &str) -> bool {
    server
        .processor()
        .store()
        .list_event_records(attempt, 0)
        .unwrap()
        .iter()
        .any(|record| record.event.kind == kind)
}

fn wait_for(path: &Path, bound: Duration) -> bool {
    let started = Instant::now();
    while started.elapsed() < bound {
        if path.exists() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    path.exists()
}

fn fixture_cwd(case: &Case) -> String {
    let json: Value = serde_json::from_str(
        &fs::read_to_string(case.workspace.join(".fake-codex-app-server.json"))
            .expect("the fixture records its argv/cwd at start"),
    )
    .unwrap();
    json["cwd"].as_str().unwrap().to_string()
}

fn assert_under_scratch(path: &str) {
    let root = scratch_root().canonicalize().unwrap_or_else(|_| scratch_root());
    let actual = PathBuf::from(path)
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(path));
    assert!(
        actual.starts_with(&root),
        "the fixture wrote outside the scratch root: {actual:?} not under {root:?}"
    );
}

// ---------------------------------------------------------------------------------------------
// C1: a dead app-server is never R1, and nothing is removed while classifying
// ---------------------------------------------------------------------------------------------

#[test]
fn c1_exited_app_server_is_not_r1_and_stays_registered() {
    // A RED case panics while holding the lock (by design at I3-M2a); a poisoned lock must not
    // turn the sibling cases into PoisonError failures.
    let _lock = CODEX_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    assert_env_pinned();
    let server = CoreServer::new(Store::memory().unwrap());
    let case = case_project(&server, "c1-exit", Some("exit_after_thread_start"));
    seed_core_epoch(server.processor().store(), &case.workspace, "c1-nonce");

    let selected = select_codex(&server, "c1-select", &case, &fixture());
    assert_eq!(selected["ok"], true, "{selected}");
    let attempt = selected["payload"]["snapshot"]["attempt"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    assert_under_scratch(&fixture_cwd(&case));

    // Records the spawn-time identity (pid + process epoch) into the recovery row; drops Core's
    // stdio pipes but keeps the Child handle. The fixture exits by its own timer.
    let closed = call(
        &server,
        "c1-close",
        "close_adapter_transport",
        json!({ "attemptId": attempt }),
    );
    assert_eq!(closed["ok"], true, "{closed}");
    let row = server
        .processor()
        .store()
        .get_attempt_recovery(&attempt)
        .unwrap()
        .expect("close_adapter_transport persists the recovery row");
    assert!(row.pid.is_some() && row.process_epoch.is_some(), "spawn identity recorded: {row:?}");

    // Sequencing gate: poll the identical re-select until the command surface refuses because the
    // registration is no longer live. That refusal is driven by try_wait on the very Child handle
    // the classification inspects, so once it appears the shim has exited.
    let started = Instant::now();
    let mut last = String::new();
    loop {
        let again = select_codex(&server, &format!("c1-again-{}", started.elapsed().as_millis()), &case, &fixture());
        if again["ok"] == false {
            last = again["error"].as_str().unwrap_or_default().to_string();
            if last.contains(LIVE_REFUSAL) {
                break;
            }
        }
        assert!(
            started.elapsed() < Duration::from_secs(15),
            "the shim did not exit within 15 s; last refusal: {last:?}"
        );
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(
        wait_for(&case.workspace.join(".fake-codex-exited.marker"), Duration::from_secs(5)),
        "the fixture records its exit"
    );

    let classified = call(
        &server,
        "c1-classify",
        "classify_recovery",
        json!({ "attemptId": attempt, "class": "R1" }),
    );
    assert_eq!(classified["ok"], true, "{classified}");
    let (class, identity) = classification(&server, &attempt);
    assert_eq!(
        class.as_deref(),
        Some("R1_UNSUPPORTED"),
        "an exited app-server must not be classified re-attachable (R1 awarded to an exited process)"
    );
    assert_eq!(identity.as_deref(), Some("exited"), "identity field on recovery.classified");
    assert!(!has_event(&server, &attempt, "runtime.exited"), "classification emits no exit event");

    // Kept, not removed: the same refusal after classification proves the registration survived.
    let after = select_codex(&server, "c1-after", &case, &fixture());
    let error = error_of(&after);
    assert!(error.contains(LIVE_REFUSAL), "registration must still be held after classifying: {error}");
}

// ---------------------------------------------------------------------------------------------
// C2: a live app-server whose identity matches the spawn-time binding is R1
// ---------------------------------------------------------------------------------------------

#[test]
fn c2_live_app_server_is_confirmed_r1() {
    // A RED case panics while holding the lock (by design at I3-M2a); a poisoned lock must not
    // turn the sibling cases into PoisonError failures.
    let _lock = CODEX_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    assert_env_pinned();
    let server = CoreServer::new(Store::memory().unwrap());
    let case = case_project(&server, "c2-live", Some("linger"));
    seed_core_epoch(server.processor().store(), &case.workspace, "c2-nonce");
    let spawned = Instant::now();

    let selected = select_codex(&server, "c2-select", &case, &fixture());
    assert_eq!(selected["ok"], true, "{selected}");
    let attempt = selected["payload"]["snapshot"]["attempt"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    assert_under_scratch(&fixture_cwd(&case));
    let closed = call(
        &server,
        "c2-close",
        "close_adapter_transport",
        json!({ "attemptId": attempt }),
    );
    assert_eq!(closed["ok"], true, "{closed}");

    let classified = call(
        &server,
        "c2-classify",
        "classify_recovery",
        json!({ "attemptId": attempt, "class": "R1" }),
    );
    let elapsed = spawned.elapsed();
    assert_eq!(classified["ok"], true, "{classified}");
    assert!(
        elapsed < Duration::from_secs(30),
        "timing, not product: classify took {elapsed:?} since spawn (watchdog is 45 s)"
    );
    let (class, identity) = classification(&server, &attempt);
    assert_eq!(class.as_deref(), Some("R1"), "a live, identity-confirmed app-server is R1 ({elapsed:?})");
    assert_eq!(identity.as_deref(), Some("confirmed"), "identity field on recovery.classified");

    // No leak: the fixture's unconditional watchdog ends the node process.
    assert!(
        wait_for(&case.workspace.join(".fake-codex-exited.marker"), Duration::from_secs(50)),
        "the lingering fixture must exit on its 45 s watchdog"
    );
}

// ---------------------------------------------------------------------------------------------
// C3 / C5: transports without a process identity are not-applicable, never "exited"
// ---------------------------------------------------------------------------------------------

/// The historical synthetic seed (`campaign-synthetic-preview`) is no longer created by
/// `CoreServer::new`: normal Core construction never seeds synthetic rows, and admission now
/// requires a real project whose workspace exists. These cases therefore create a Campaign
/// through the command surface on an existing fixture workspace and drive the scenario select
/// with the ids that command actually returned; every command's success is asserted before its
/// payload is read.
fn select_scenario_attempt(server: &CoreServer, id: &str) -> String {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let workspace = scratch_root().join(format!("i3-{id}-{nonce}"));
    fs::create_dir_all(&workspace).expect("case workspace should be creatable");

    let created = call(
        server,
        &format!("{id}-create"),
        "create_campaign",
        json!({
            "workspaceRoot": workspace.to_string_lossy(),
            "goal": format!("recovery classification scenario case {id}")
        }),
    );
    assert_eq!(created["ok"], true, "create_campaign refused: {created}");
    let snapshot = &created["payload"]["snapshot"];
    let project = snapshot["selectedProjectId"]
        .as_str()
        .expect("project id in the create snapshot")
        .to_owned();
    let campaign = snapshot["activeCampaignId"]
        .as_str()
        .expect("campaign id in the create snapshot")
        .to_owned();
    let task = snapshot["activeTask"]["id"]
        .as_str()
        .expect("root task id in the create snapshot")
        .to_owned();

    let selected = call(
        server,
        &format!("{id}-select"),
        "select_runtime",
        json!({
            "projectId": project,
            "campaignId": campaign,
            "taskId": task,
            "provider": "scenario"
        }),
    );
    assert_eq!(selected["ok"], true, "{selected}");
    selected["payload"]["snapshot"]["attempt"]["id"]
        .as_str()
        .expect("select_runtime returns the registered attempt")
        .to_string()
}

#[test]
fn c3_scenario_claim_r1_is_unsupported_and_not_applicable() {
    assert_env_pinned();
    let server = CoreServer::new(Store::memory().unwrap());
    let attempt = select_scenario_attempt(&server, "c3");
    let classified = call(
        &server,
        "c3-classify",
        "classify_recovery",
        json!({ "attemptId": attempt, "class": "R1" }),
    );
    assert_eq!(classified["ok"], true, "{classified}");
    let (class, identity) = classification(&server, &attempt);
    assert_eq!(class.as_deref(), Some("R1_UNSUPPORTED"));
    assert_eq!(identity.as_deref(), Some("not-applicable"), "identity field on recovery.classified");
}

#[test]
fn c5_other_claims_pass_through_with_identity_reported() {
    assert_env_pinned();
    let server = CoreServer::new(Store::memory().unwrap());
    let attempt = select_scenario_attempt(&server, "c5");
    let classified = call(
        &server,
        "c5-classify",
        "classify_recovery",
        json!({ "attemptId": attempt, "class": "R2" }),
    );
    assert_eq!(classified["ok"], true, "{classified}");
    let (class, identity) = classification(&server, &attempt);
    assert_eq!(class.as_deref(), Some("R2"));
    assert_eq!(identity.as_deref(), Some("not-applicable"), "identity field on recovery.classified");
}

// ---------------------------------------------------------------------------------------------
// C4: the codex exec transport has no pid and is not-applicable, never "exited"
// ---------------------------------------------------------------------------------------------

#[test]
fn c4_codex_exec_transport_is_not_applicable_not_exited() {
    // A RED case panics while holding the lock (by design at I3-M2a); a poisoned lock must not
    // turn the sibling cases into PoisonError failures.
    let _lock = CODEX_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    assert_env_pinned();
    let server = CoreServer::new(Store::memory().unwrap());
    let case = case_project(&server, "c4-exec", None);
    let dummy = PathBuf::from(r"C:\nonexistent\goalport-increment-3-dummy-codex.exe");
    unsafe { env::set_var("GOALPORT_CODEX_TRANSPORT", "exec") };
    let outcome = (|| {
        let selected = select_codex(&server, "c4-select", &case, &dummy);
        assert_eq!(selected["ok"], true, "codex exec registers without a process: {selected}");
        let attempt = selected["payload"]["snapshot"]["attempt"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        let classified = call(
            &server,
            "c4-classify",
            "classify_recovery",
            json!({ "attemptId": attempt, "class": "R1" }),
        );
        assert_eq!(classified["ok"], true, "{classified}");
        classification(&server, &attempt)
    })();
    unsafe { env::remove_var("GOALPORT_CODEX_TRANSPORT") };
    let (class, identity) = outcome;
    assert_eq!(class.as_deref(), Some("R1_UNSUPPORTED"));
    assert_eq!(
        identity.as_deref(),
        Some("not-applicable"),
        "a transport without a pid is not-applicable, never exited"
    );
    assert!(!dummy.exists());
}

// ---------------------------------------------------------------------------------------------
// M1: manager level
// ---------------------------------------------------------------------------------------------

#[test]
fn m1_confirmation_is_not_applicable_for_scenario_and_none_when_unregistered() {
    assert_env_pinned();
    let directory = tempfile::tempdir().unwrap();
    let workspace = directory.path().join("ws");
    fs::create_dir_all(&workspace).unwrap();
    let mut manager = RuntimeManager::new();
    assert_eq!(manager.confirm_process_identity("attempt-none"), None);
    manager
        .select_runtime("attempt-m1", "scenario", None, "scenario-1", &workspace)
        .unwrap();
    assert_eq!(
        manager.confirm_process_identity("attempt-m1"),
        Some(ProcessConfirmation::NotApplicable)
    );
}
