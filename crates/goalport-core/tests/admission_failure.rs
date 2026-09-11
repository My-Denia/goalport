//! Increment 4 of run `goal-runs/runtime-registration-safety`: a NEW Runtime admission whose
//! initialization fails must not leave a registration that could be mistaken for usable or an
//! unexplained placeholder; existing selection, existing Runtimes and existing responsibility are
//! unaffected; a later explicit selection can retry safely. The registration `admit_runtime` just
//! created is withdrawn only when no process was ever started; when a process was started (or may
//! have been) it is kept — nothing is killed, released, replaced or re-launched — and the failure
//! record says so.
//!
//! Command-surface cases (A*) drive `CoreServer::handle_json`. Codex app-server cases launch the
//! SYNTHETIC `tests/fixtures/fake-codex-app-server/` (cmd.exe -> node) with an explicit executable
//! into a per-case workspace under `GOALPORT_TEST_ARTIFACT_ROOT`, or name a non-existent executable
//! under that workspace so the spawn fails before any process exists; no real CLI, no subscription.
//! The managed child Core holds is the `cmd.exe` shim; liveness is observed on its pid (the `ppid`
//! the fixture records). Every codex case holds `CODEX_LOCK` for its whole body:
//! `GOALPORT_CODEX_TRANSPORT` is read inside `intended_binding` before any refusal. Manager cases
//! (M*) drive `RuntimeManager` directly.
#![cfg(windows)]

use goalport_core::{
    Attempt, Project, RuntimeManager, SessionRequest,
    adapters::AdapterError,
    domain::{AttemptState, Campaign, Event, Task, WorkStatus},
    ipc::{CONNECTED_UI_PROTOCOL_VERSION, CoreServer},
    process_identity::{ProcessObservation, observe_process},
    product_receipts::{begin_startup_epoch, complete_startup_epoch},
    runtime_manager::RegistrationWithdrawal,
    store::{CampaignAuthorization, Store},
};
use serde_json::{Value, json};
use std::{
    env, fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};

const NEVER_ESTABLISHED: &str =
    "has a registered Runtime but its session was never established";
const NOT_RETRIED: &str = "not retried automatically";
const DIFFERENT_BINDING: &str = "is already bound to a different Runtime binding";
const FAILED_KIND: &str = "attempt.admission.failed";

/// One mutex for everything process-global this file touches: `GOALPORT_CODEX_TRANSPORT` is read by
/// `intended_binding` on every codex select, and A1's successful retry needs a committed Core launch
/// epoch, whose commit sets launch-identity variables in-process (`seed_core_epoch`, the
/// `recovery_classification.rs` pattern). Poison-tolerant: a RED case panics while holding it.
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

/// The real Core commits a launch epoch at `serve` startup; a successful native admission persists
/// the session-created event, which needs that epoch. Committed here through the same
/// product-receipt path (as `recovery_classification.rs` and `grok_acp.rs` do). Writes
/// `core-fixture.sqlite*` receipts into the case workspace under the scratch root. Caller holds
/// `CODEX_LOCK`.
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
    let claim = begin_startup_epoch(store, r"\\.\pipe\admission-failure-fixture", &db)
        .expect("startup epoch should be claimable");
    complete_startup_epoch(
        store,
        r"\\.\pipe\admission-failure-fixture",
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

fn lock() -> std::sync::MutexGuard<'static, ()> {
    CODEX_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
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

fn snapshot(server: &CoreServer, id: &str) -> Value {
    let response = call(server, id, "snapshot", json!({}));
    assert_eq!(response["ok"], true, "snapshot must succeed: {response}");
    response["payload"]["snapshot"].clone()
}

#[derive(Debug, PartialEq, Eq)]
struct Observed {
    project: String,
    campaign: String,
    task: String,
    attempt: String,
}

/// The selection as the UI sees it (increment 1: untouched by every refusal). The Attempt row a
/// failed admission legitimately leaves behind is counted separately by `rows`.
fn observe(server: &CoreServer, id: &str) -> Observed {
    let view = snapshot(server, id);
    Observed {
        project: view["selectedProjectId"].as_str().unwrap_or_default().to_string(),
        campaign: view["activeCampaignId"].as_str().unwrap_or_default().to_string(),
        task: view["activeTask"]["id"].as_str().unwrap_or_default().to_string(),
        attempt: view["attempt"]["id"].as_str().unwrap_or_default().to_string(),
    }
}

fn rows(server: &CoreServer) -> usize {
    server.processor().store().list_attempts().unwrap().len()
}

/// A path that does not exist and does NOT end in `.cmd`/`.bat`: Rust's `Command` routes those
/// two extensions through `cmd.exe`, which spawns successfully and only then fails to find the
/// script — that is a spawned process, not a spawn failure. An `.exe` name fails in
/// `CreateProcess` itself, before any process exists.
fn missing_executable(workspace: &Path) -> PathBuf {
    let path = workspace.join("missing-codex.exe");
    assert!(!path.exists());
    path
}

fn fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/fake-codex-app-server/fake-codex-app-server.cmd")
}

fn scratch_root() -> PathBuf {
    env::var_os("GOALPORT_TEST_ARTIFACT_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| env::temp_dir().join("goalport-admission-failure"))
}

/// The deterministic default attempt id `admit_runtime` derives (projection.rs `stable_suffix`,
/// private). The product's empty-input fallback ("request") is omitted: every task id here is
/// non-empty.
fn default_attempt(task: &str, provider: &str) -> String {
    let suffix: String = task
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .collect();
    format!("attempt-{suffix}-{provider}")
}

struct Case {
    project: String,
    campaign: String,
    task: String,
    workspace: PathBuf,
}

/// One project per case with its own workspace under the scratch root: the Codex spawn runs with
/// `current_dir(workspace_root)`, so the fixture's scenario file and markers live here, and the
/// never-created `missing-codex.exe` (see `missing_executable`) is named here too.
fn case_project(server: &CoreServer, name: &str, scenario: Option<&str>) -> Case {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let workspace = scratch_root().join(format!("i4-{name}-{nonce}"));
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
                goal: format!("admission failure case {name}"),
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

fn select_codex_explicit(
    server: &CoreServer,
    id: &str,
    case: &Case,
    attempt_id: &str,
    executable: &Path,
) -> Value {
    call(
        server,
        id,
        "select_runtime",
        json!({
            "projectId": case.project,
            "campaignId": case.campaign,
            "taskId": case.task,
            "provider": "codex",
            "attemptId": attempt_id,
            "executable": executable.to_string_lossy()
        }),
    )
}

/// `(kind, payload)` of every persisted event of the attempt, in sequence order.
fn events(server: &CoreServer, attempt: &str) -> Vec<(String, Option<Value>)> {
    server
        .processor()
        .store()
        .list_event_records(attempt, 0)
        .unwrap()
        .into_iter()
        .map(|record| (record.event.kind, record.payload))
        .collect()
}

fn kinds(events: &[(String, Option<Value>)]) -> Vec<&str> {
    events.iter().map(|(kind, _)| kind.as_str()).collect()
}

fn failure_record(events: &[(String, Option<Value>)]) -> Value {
    let records: Vec<&Value> = events
        .iter()
        .filter(|(kind, _)| kind == FAILED_KIND)
        .map(|(_, payload)| payload.as_ref().expect("the failure record carries a payload"))
        .collect();
    assert_eq!(records.len(), 1, "exactly one admission-failure record: {events:?}");
    records[0].clone()
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

fn fixture_json(workspace: &Path) -> Value {
    serde_json::from_str(
        &fs::read_to_string(workspace.join(".fake-codex-app-server.json"))
            .expect("the fixture records its argv/cwd/ppid at start"),
    )
    .unwrap()
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

fn shim_is_live(pid: u32) -> bool {
    matches!(observe_process(pid), ProcessObservation::Live(_))
}

/// Ends a lingering fixture through its own stop marker (never through Core) and waits for its
/// exit marker.
fn stop_fixture(workspace: &Path) {
    fs::write(workspace.join(".fake-codex-stop.marker"), "stop").unwrap();
    assert!(
        wait_for(&workspace.join(".fake-codex-exited.marker"), Duration::from_secs(10)),
        "the fixture must end on its stop marker (no leaked node process)"
    );
}

// ---------------------------------------------------------------------------------------------
// A1: a failed spawn (nothing started) is withdrawn with a record; an explicit retry is admitted
// ---------------------------------------------------------------------------------------------

#[test]
fn a1_withdrawn_failure_then_explicit_retry() {
    let _lock = lock();
    assert_env_pinned();
    let server = CoreServer::new(Store::memory().unwrap());
    let case = case_project(&server, "a1", Some("linger"));
    // The successful retry persists the native session-created event, which needs the epoch.
    seed_core_epoch(server.processor().store(), &case.workspace, "a1-nonce");
    let missing = missing_executable(&case.workspace);
    let attempt = default_attempt(&case.task, "codex");
    let before = observe(&server, "a1-before");
    let rows_before = rows(&server);

    // (1) the spawn fails before any process exists
    let refused = select_codex(&server, "a1-missing", &case, &missing);
    let error = error_of(&refused);
    assert!(
        error.contains("unable to start Codex app-server"),
        "the spawn failure must be the cause: {error}"
    );
    assert_eq!(observe(&server, "a1-after-refusal"), before, "a refusal moves no selection");
    assert!(
        !case.workspace.join(".fake-codex-app-server.json").exists(),
        "nothing may have been launched"
    );

    // (2) the explicit retry with the corrected executable is admitted through the ordinary path
    let admitted = select_codex(&server, "a1-retry", &case, &fixture());
    assert_eq!(
        admitted["ok"], true,
        "the explicit retry after a withdrawn failure must be admitted: {admitted}"
    );

    // the record of (1), read after the retry so a RED run reports the retry refusal first
    assert!(
        error.contains("withdrawn"),
        "the refusal must say the new registration was withdrawn: {error}"
    );
    let store = server.processor().store();
    let row = store.get_attempt(&attempt).unwrap();
    assert_eq!(row.state, AttemptState::Active, "{row:?}");
    assert_eq!(row.provider_session.as_deref(), Some("fake-thread-1"));
    let recorded = events(&server, &attempt);
    let recorded_kinds = kinds(&recorded);
    assert_eq!(
        recorded_kinds.iter().filter(|kind| **kind == "attempt.created").count(),
        1,
        "one attempt.created for the row: {recorded_kinds:?}"
    );
    assert_eq!(
        &recorded_kinds[..2],
        &["attempt.created", FAILED_KIND],
        "the failure record follows creation: {recorded_kinds:?}"
    );
    assert_eq!(
        &recorded_kinds[recorded_kinds.len() - 2..],
        &["attempt.active", "runtime.session.created"],
        "the retry activates the row: {recorded_kinds:?}"
    );
    let record = failure_record(&recorded);
    assert_eq!(record["stage"], "create_session", "{record}");
    assert_eq!(record["registration"], "withdrawn", "{record}");
    assert_eq!(record["process"], "not-started", "{record}");
    assert_eq!(record["retry"], "explicit-reselect", "{record}");
    assert_eq!(record["provider"], "codex", "{record}");
    assert!(
        record["error"].as_str().unwrap_or_default().contains("unable to start Codex app-server"),
        "{record}"
    );
    let json = fixture_json(&case.workspace);
    assert_under_scratch(json["cwd"].as_str().unwrap());
    let after = observe(&server, "a1-after-retry");
    assert_eq!(after.attempt, attempt);
    assert_eq!(after.project, case.project);
    assert_eq!(rows(&server), rows_before + 1, "one row for the failed-then-retried attempt");

    stop_fixture(&case.workspace);
}

// ---------------------------------------------------------------------------------------------
// A2: a handshake failure after the process started is kept; nothing killed, nothing retried,
// other admissions unaffected
// ---------------------------------------------------------------------------------------------

#[test]
fn a2_started_failure_is_kept_and_nothing_is_killed_or_retried() {
    let _lock = lock();
    assert_env_pinned();
    let server = CoreServer::new(Store::memory().unwrap());
    let case = case_project(&server, "a2", Some("thread_start_without_id"));
    let missing = missing_executable(&case.workspace);
    let attempt = default_attempt(&case.task, "codex");
    let before = observe(&server, "a2-before");
    let rows_before = rows(&server);

    // (1) the process starts, answers initialize, then breaks the handshake
    let refused = select_codex(&server, "a2-first", &case, &fixture());
    let error = error_of(&refused);
    assert!(
        error.contains("thread/start returned no thread id"),
        "the handshake failure must be the cause: {error}"
    );
    let json = fixture_json(&case.workspace);
    assert_under_scratch(json["cwd"].as_str().unwrap());
    let shim = u32::try_from(json["ppid"].as_u64().expect("ppid recorded")).unwrap();
    let started_at = json["startedAt"].clone();
    assert!(shim_is_live(shim), "the shim Core holds must still be running after the refusal");
    assert_eq!(observe(&server, "a2-after-first"), before, "a refusal moves no selection");
    let store = server.processor().store();
    assert_eq!(store.get_attempt(&attempt).unwrap().state, AttemptState::Queued);
    let recorded = events(&server, &attempt);
    assert_eq!(
        kinds(&recorded),
        ["attempt.created", FAILED_KIND],
        "the failed admission must leave its record"
    );
    let record = failure_record(&recorded);
    assert_eq!(record["stage"], "create_session", "{record}");
    assert_eq!(record["registration"], "kept", "{record}");
    assert_eq!(record["process"], "started-or-unconfirmed", "{record}");
    assert_eq!(record["retry"], "not-retried", "{record}");
    assert!(
        error.contains("kept"),
        "the refusal must say the registration was kept: {error}"
    );

    // (2) the identical re-select is refused the increment-2 way: kept, not retried
    let again = error_of(&select_codex(&server, "a2-again", &case, &fixture()));
    assert!(again.contains(NEVER_ESTABLISHED) && again.contains(NOT_RETRIED), "{again}");

    // (3) a different binding under the kept id is an explicit conflict
    let conflict = error_of(&select_codex(&server, "a2-conflict", &case, &missing));
    assert!(conflict.contains(DIFFERENT_BINDING), "{conflict}");

    // (4) another attempt's failed admission on the same task changes nothing here
    let other = error_of(&select_codex_explicit(
        &server,
        "a2-other",
        &case,
        "attempt-a2-other",
        &missing,
    ));
    assert!(other.contains("withdrawn"), "{other}");
    let other_row = store.get_attempt("attempt-a2-other").unwrap();
    assert_eq!(other_row.state, AttemptState::Queued);
    let other_events = events(&server, "attempt-a2-other");
    assert_eq!(kinds(&other_events), ["attempt.created", FAILED_KIND]);
    assert_eq!(failure_record(&other_events)["registration"], "withdrawn");

    // throughout: one launch, one record, the shim alive, the selection untouched
    let json_after = fixture_json(&case.workspace);
    assert_eq!(json_after["startedAt"], started_at, "exactly one launch");
    assert_eq!(events(&server, &attempt), recorded, "the kept row's record is unchanged");
    assert!(shim_is_live(shim), "nothing may kill the kept process");
    assert_eq!(
        observe(&server, "a2-after-all"),
        before,
        "the selection is untouched by every refusal"
    );
    assert_eq!(rows(&server), rows_before + 2, "the kept row and the other attempt's row");

    // (5) the fixture ends on its own stop marker, never through Core
    stop_fixture(&case.workspace);
}

// ---------------------------------------------------------------------------------------------
// A3: a process that was spawned and is gone (Core's own identity check killed it, or it exited
// before the handshake) is kept, never reported "never started"
// ---------------------------------------------------------------------------------------------

/// `cmd.exe` that exits at once: Core's identity observation lands on the NotRunning/Unknown arm
/// (spawned, killed, reaped: no Child left) or, if it wins the race, on the handshake-EOF arm
/// (Child kept). Both arms must answer `kept`; which one runs is timing-dependent.
fn write_exit_immediately(workspace: &Path) -> PathBuf {
    let path = workspace.join("exit-immediately.cmd");
    fs::write(&path, "@exit /b 0\r\n").unwrap();
    path
}

/// The cause a spawned-then-gone `cmd.exe` produces is timing-dependent (identity `unknown`,
/// `exited before its process identity was observed`, `closed before a response`, or a write
/// failure); the classification must be `kept` on every arm, so the cause is recorded, not asserted.
fn record_cause(workspace: &Path, label: &str, cause: &str) {
    fs::write(workspace.join("a3-cause.txt"), format!("{label}: {cause}\n")).unwrap();
}

#[test]
fn a3_spawned_then_gone_is_kept_not_never_started() {
    let _lock = lock();
    assert_env_pinned();
    let server = CoreServer::new(Store::memory().unwrap());
    let case = case_project(&server, "a3", None);
    let exit_now = write_exit_immediately(&case.workspace);
    let attempt = default_attempt(&case.task, "codex");
    let before = observe(&server, "a3-before");

    let refused = select_codex(&server, "a3-first", &case, &exit_now);
    let error = error_of(&refused);
    record_cause(&case.workspace, "a3", &error);
    assert_eq!(observe(&server, "a3-after-first"), before, "a refusal moves no selection");
    let store = server.processor().store();
    assert_eq!(store.get_attempt(&attempt).unwrap().state, AttemptState::Queued);
    let recorded = events(&server, &attempt);
    assert_eq!(
        kinds(&recorded),
        ["attempt.created", FAILED_KIND],
        "the failed admission must leave its record"
    );
    let record = failure_record(&recorded);
    assert_eq!(record["stage"], "create_session", "{record}");
    assert_eq!(record["registration"], "kept", "{record}");
    assert_eq!(record["process"], "started-or-unconfirmed", "{record}");
    assert!(
        error.contains("runtime admission failed during create_session") && error.contains("kept"),
        "a spawned process, alive or not, keeps the registration: {error}"
    );
    assert!(
        !case.workspace.join(".fake-codex-app-server.json").exists(),
        "this case never launches the node fixture"
    );

    let again = error_of(&select_codex(&server, "a3-again", &case, &exit_now));
    assert!(again.contains(NEVER_ESTABLISHED) && again.contains(NOT_RETRIED), "{again}");
    assert_eq!(events(&server, &attempt), recorded, "the kept row's record is unchanged");
    assert_eq!(observe(&server, "a3-after-all"), before);
}

// ---------------------------------------------------------------------------------------------
// A4: a failure AFTER activation (the session events) is kept and reported with its real state,
// and the half-initialized live registration is not handed back as a reuse
// ---------------------------------------------------------------------------------------------

#[test]
fn a4_failure_after_activation_is_kept_and_not_handed_back_as_reuse() {
    let _lock = lock();
    assert_env_pinned();
    let server = CoreServer::new(Store::memory().unwrap());
    // Deliberately NO Core launch epoch: create_session succeeds, the provider session is set
    // and attempt.active is persisted, then the native session-created event cannot be
    // persisted ("no committed Core epoch") -> the failure lands at stage session_events with
    // the row already Active and the fixture alive.
    let case = case_project(&server, "a4", Some("linger"));
    let attempt = default_attempt(&case.task, "codex");
    let before = observe(&server, "a4-before");

    let refused = select_codex(&server, "a4-first", &case, &fixture());
    let error = error_of(&refused);
    assert!(
        error.contains("runtime admission failed during session_events"),
        "the failure must be at the session-events stage: {error}"
    );
    let json = fixture_json(&case.workspace);
    assert_under_scratch(json["cwd"].as_str().unwrap());
    let shim = u32::try_from(json["ppid"].as_u64().expect("ppid recorded")).unwrap();
    assert!(shim_is_live(shim), "the shim Core holds must still be running after the refusal");
    assert_eq!(observe(&server, "a4-after-first"), before, "a refusal moves no selection");
    let store = server.processor().store();
    let row = store.get_attempt(&attempt).unwrap();
    assert_eq!(row.state, AttemptState::Active, "the failure came after activation: {row:?}");
    assert_eq!(row.provider_session.as_deref(), Some("fake-thread-1"));
    let recorded = events(&server, &attempt);
    let recorded_kinds = kinds(&recorded);
    assert_eq!(&recorded_kinds[..2], &["attempt.created", "attempt.active"], "{recorded_kinds:?}");
    assert_eq!(recorded_kinds.last(), Some(&FAILED_KIND), "{recorded_kinds:?}");
    let record = failure_record(&recorded);
    assert_eq!(record["stage"], "session_events", "{record}");
    assert_eq!(record["registration"], "kept", "{record}");
    assert_eq!(record["process"], "started-or-unconfirmed", "{record}");
    assert_eq!(record["state"], "ACTIVE", "the record reports the real state: {record}");
    assert!(
        error.contains("kept") && error.contains("is ACTIVE"),
        "the message must report the real state, not assume QUEUED: {error}"
    );

    // The kept, half-initialized registration is live and the row is Active — exactly the shape
    // the increment-2 reuse rule would hand back. It must not be.
    let again = error_of(&select_codex(&server, "a4-again", &case, &fixture()));
    assert!(
        again.contains("initialization did not complete")
            && again.contains("session_events")
            && again.contains(NOT_RETRIED),
        "{again}"
    );
    assert_eq!(events(&server, &attempt), recorded, "the refusal writes nothing");
    assert!(shim_is_live(shim), "nothing may kill the kept process");
    assert_eq!(observe(&server, "a4-after-again"), before);

    stop_fixture(&case.workspace);
}

// ---------------------------------------------------------------------------------------------
// A4b: a later unrelated event on the row (a recovery classification, a runtime event) neither
// completes the initialization nor withdraws the registration, so it must not make the kept
// registration reusable (cross-family critic, round 2)
// ---------------------------------------------------------------------------------------------

#[test]
fn a4b_later_unrelated_event_does_not_make_a_kept_registration_reusable() {
    let _lock = lock();
    assert_env_pinned();
    let server = CoreServer::new(Store::memory().unwrap());
    let case = case_project(&server, "a4b", Some("linger"));
    let attempt = default_attempt(&case.task, "codex");
    let before = observe(&server, "a4b-before");

    // The A4 shape: failure at session_events, row Active, registration kept, fixture alive.
    let error = error_of(&select_codex(&server, "a4b-first", &case, &fixture()));
    assert!(error.contains("runtime admission failed during session_events"), "{error}");
    let json = fixture_json(&case.workspace);
    let shim = u32::try_from(json["ppid"].as_u64().expect("ppid recorded")).unwrap();
    let store = server.processor().store();
    assert_eq!(store.get_attempt(&attempt).unwrap().state, AttemptState::Active);
    let recorded = events(&server, &attempt);
    assert_eq!(recorded.last().map(|(kind, _)| kind.as_str()), Some(FAILED_KIND));

    // A legitimate, unrelated event lands on the row after the kept record — the kind the
    // recovery classification command persists, written through the same store path.
    let next_seq = i64::try_from(recorded.len()).unwrap() + 1;
    store
        .append_event_with_state(
            &Event {
                id: format!("core-event-{attempt}-{next_seq}"),
                attempt_id: attempt.clone(),
                seq: next_seq,
                kind: "recovery.classified".into(),
                payload_ref: None,
            },
            None,
            Some(&json!({ "class": "R1_UNSUPPORTED", "identity": "not-applicable" })),
        )
        .unwrap();
    assert_eq!(
        events(&server, &attempt).last().map(|(kind, _)| kind.clone()),
        Some("recovery.classified".to_string())
    );

    // The kept, half-initialized registration is still not handed back as a reuse.
    let again = error_of(&select_codex(&server, "a4b-again", &case, &fixture()));
    assert!(
        again.contains("initialization did not complete")
            && again.contains("session_events")
            && again.contains(NOT_RETRIED),
        "{again}"
    );
    assert!(shim_is_live(shim), "nothing may kill the kept process");
    assert_eq!(observe(&server, "a4b-after"), before);

    stop_fixture(&case.workspace);
}

// ---------------------------------------------------------------------------------------------
// A5: the retry gate needs the withdrawn record (guard; green today, red only under mutation d)
// ---------------------------------------------------------------------------------------------

fn seed_queued_row(server: &CoreServer, case: &Case, attempt: &str, extra: Option<Value>) {
    let store = server.processor().store();
    store
        .insert_attempt(&Attempt::new(attempt, &case.task, "scenario", "scenario-cap-v1"))
        .unwrap();
    store
        .append_event_with_state(
            &Event {
                id: format!("core-event-{attempt}-1"),
                attempt_id: attempt.into(),
                seq: 1,
                kind: "attempt.created".into(),
                payload_ref: None,
            },
            None,
            Some(&json!({ "provider": "scenario" })),
        )
        .unwrap();
    if let Some(payload) = extra {
        store
            .append_event_with_state(
                &Event {
                    id: format!("core-event-{attempt}-2"),
                    attempt_id: attempt.into(),
                    seq: 2,
                    kind: FAILED_KIND.into(),
                    payload_ref: None,
                },
                None,
                Some(&payload),
            )
            .unwrap();
    }
}

fn select_scenario(server: &CoreServer, id: &str, case: &Case) -> Value {
    call(
        server,
        id,
        "select_runtime",
        json!({
            "projectId": case.project,
            "campaignId": case.campaign,
            "taskId": case.task,
            "provider": "scenario"
        }),
    )
}

#[test]
fn a5_retry_gate_requires_the_withdrawn_record() {
    assert_env_pinned();
    let server = CoreServer::new(Store::memory().unwrap());
    // A5a: a Queued row whose last event is only attempt.created
    let case_a = case_project(&server, "a5a", None);
    let attempt_a = default_attempt(&case_a.task, "scenario");
    seed_queued_row(&server, &case_a, &attempt_a, None);
    // A5b: a Queued row whose last record says the registration was KEPT
    let case_b = case_project(&server, "a5b", None);
    let attempt_b = default_attempt(&case_b.task, "scenario");
    seed_queued_row(
        &server,
        &case_b,
        &attempt_b,
        Some(json!({
            "stage": "create_session",
            "error": "seeded",
            "provider": "scenario",
            "registration": "kept",
            "process": "started-or-unconfirmed"
        })),
    );
    let before = observe(&server, "a5-before");

    for (label, case, attempt) in [("a5a", &case_a, &attempt_a), ("a5b", &case_b, &attempt_b)] {
        let refused = select_scenario(&server, &format!("{label}-select"), case);
        let error = error_of(&refused);
        // `StoreError::IdempotencyConflict` displays as "duplicate identifier {id} has different content".
        assert!(
            error.contains("has different content"),
            "{label}: the existing row must answer insert_attempt's conflict, not be retried: {error}"
        );
        assert_eq!(
            server.processor().store().get_attempt(attempt).unwrap().state,
            AttemptState::Queued
        );
        let recorded_events = events(&server, attempt);
        let recorded = kinds(&recorded_events);
        assert!(
            !recorded.contains(&"attempt.active") && !recorded.contains(&"runtime.session.created"),
            "{label}: no session may have been created: {recorded:?}"
        );
    }
    assert_eq!(observe(&server, "a5-after"), before, "no refusal moves the selection");
}

// ---------------------------------------------------------------------------------------------
// A5c: the retry record must name the provider being admitted (cross-family critic, round 3;
// owner ruling B). CONSTRUCTED persistent-state inconsistency: through the product the record's
// provider always equals the row's (record_admission_failure is its only writer and is reached
// only by an admission whose provider equals the row's), so the inconsistent row below is seeded
// through the store and never produced by a product path. The consistent row is the control that
// the same seeding, differing only in the provider named by the record, is still retried.
// ---------------------------------------------------------------------------------------------

fn withdrawn_record(provider: &str) -> Value {
    json!({
        "stage": "create_session",
        "error": "seeded",
        "provider": provider,
        "registration": "withdrawn",
        "process": "not-started",
        "retry": "explicit-reselect",
        "state": "QUEUED"
    })
}

#[test]
fn a5c_retry_record_must_name_the_same_provider() {
    assert_env_pinned();
    let server = CoreServer::new(Store::memory().unwrap());
    let store = server.processor().store();

    // Control: a scenario row whose withdrawn record names scenario is retried through the gate.
    let case_ok = case_project(&server, "a5c-ok", None);
    let attempt_ok = default_attempt(&case_ok.task, "scenario");
    seed_queued_row(&server, &case_ok, &attempt_ok, Some(withdrawn_record("scenario")));
    let admitted = select_scenario(&server, "a5c-ok-select", &case_ok);
    assert_eq!(admitted["ok"], true, "a consistent withdrawn record qualifies the retry: {admitted}");
    assert_eq!(store.get_attempt(&attempt_ok).unwrap().state, AttemptState::Active);
    let ok_events = kinds_owned(&events(&server, &attempt_ok));
    assert!(ok_events.contains(&"attempt.active".to_string()), "{ok_events:?}");
    let before = observe(&server, "a5c-after-ok");
    assert_eq!(before.attempt, attempt_ok);

    // Counterexample: a scenario row whose withdrawn record names codex is NOT retried; the row
    // falls through to insert_attempt as any non-qualifying row does.
    let case_bad = case_project(&server, "a5c-bad", None);
    let attempt_bad = default_attempt(&case_bad.task, "scenario");
    seed_queued_row(&server, &case_bad, &attempt_bad, Some(withdrawn_record("codex")));
    let seeded = events(&server, &attempt_bad);
    let refused = select_scenario(&server, "a5c-bad-select", &case_bad);
    let error = error_of(&refused);
    assert!(
        error.contains("has different content"),
        "a record naming another provider must not qualify the retry: {error}"
    );
    assert_eq!(store.get_attempt(&attempt_bad).unwrap().state, AttemptState::Queued);
    assert_eq!(events(&server, &attempt_bad), seeded, "the refusal writes nothing");
    assert_eq!(observe(&server, "a5c-after-bad"), before, "the refusal moves no selection");
}

fn kinds_owned(events: &[(String, Option<Value>)]) -> Vec<String> {
    events.iter().map(|(kind, _)| kind.clone()).collect()
}

// ---------------------------------------------------------------------------------------------
// RuntimeManager level
// ---------------------------------------------------------------------------------------------

fn session_request(attempt: &str, workspace: &Path) -> SessionRequest {
    SessionRequest {
        campaign_id: Some("campaign-m".into()),
        task_id: "task-m".into(),
        attempt_id: attempt.into(),
        workspace_root: workspace.to_path_buf(),
        resume_session: None,
    }
}

#[test]
fn m1_withdrawing_an_unregistered_id_is_an_error() {
    let mut manager = RuntimeManager::new();
    assert!(matches!(
        manager.withdraw_unstarted_registration("nobody", 1),
        Err(AdapterError::InvalidRequest(_))
    ));
    assert!(!manager.has_attempt("nobody"));
}

#[test]
fn m2_withdrawal_is_keyed_by_the_registration_seq() {
    let directory = tempfile::tempdir().unwrap();
    let workspace = directory.path().join("ws");
    fs::create_dir_all(&workspace).unwrap();
    let mut manager = RuntimeManager::new();
    manager
        .select_runtime("a", "scenario", None, "scenario-v1", &workspace)
        .unwrap();
    manager
        .select_runtime("b", "scenario", None, "scenario-v1", &workspace)
        .unwrap();
    assert_eq!(manager.registration_seq("a"), Some(1));
    assert_eq!(manager.registration_seq("b"), Some(2));

    assert_eq!(
        manager.withdraw_unstarted_registration("a", 2).unwrap(),
        RegistrationWithdrawal::KeptNotOurs { current_seq: 1 }
    );
    assert!(manager.has_attempt("a") && manager.has_attempt("b"));

    assert_eq!(
        manager.withdraw_unstarted_registration("a", 1).unwrap(),
        RegistrationWithdrawal::Withdrawn
    );
    assert!(!manager.has_attempt("a"));
    assert!(manager.registered_binding("a").is_none());
    assert!(manager.has_attempt("b"));
    assert_eq!(manager.registration_live("b"), Some(true));

    manager
        .select_runtime("a", "scenario", None, "scenario-v1", &workspace)
        .unwrap();
    assert_eq!(manager.registration_seq("a"), Some(3), "sequence numbers are never reused");
}

#[test]
fn m3_a_codex_registration_that_never_started_is_withdrawable() {
    let _lock = lock();
    assert_env_pinned();
    let directory = tempfile::tempdir().unwrap();
    let workspace = directory.path().join("ws");
    fs::create_dir_all(&workspace).unwrap();
    let missing = missing_executable(&workspace);
    let mut manager = RuntimeManager::new();
    manager
        .select_runtime("attempt-m3", "codex", Some(missing), "0.152.0", &workspace)
        .unwrap();
    let seq = manager.registration_seq("attempt-m3").unwrap();
    let error = manager
        .create_session("attempt-m3", &session_request("attempt-m3", &workspace))
        .unwrap_err();
    assert!(matches!(error, AdapterError::Connection(_)), "{error}");
    assert_eq!(manager.process_started("attempt-m3"), Some(false));
    assert_eq!(
        manager.withdraw_unstarted_registration("attempt-m3", seq).unwrap(),
        RegistrationWithdrawal::Withdrawn
    );
    assert!(!manager.has_attempt("attempt-m3"));
    assert!(manager.registered_binding("attempt-m3").is_none());
}

#[test]
fn m4_a_codex_registration_whose_process_started_is_kept() {
    let _lock = lock();
    assert_env_pinned();
    let directory = tempfile::tempdir().unwrap();
    let workspace = directory.path().join("ws");
    fs::create_dir_all(&workspace).unwrap();
    fs::write(workspace.join(".fake-codex-scenario"), "thread_start_without_id").unwrap();
    let mut manager = RuntimeManager::new();
    manager
        .select_runtime("attempt-m4", "codex", Some(fixture()), "0.152.0", &workspace)
        .unwrap();
    let seq = manager.registration_seq("attempt-m4").unwrap();
    let error = manager
        .create_session("attempt-m4", &session_request("attempt-m4", &workspace))
        .unwrap_err();
    assert!(matches!(error, AdapterError::Protocol(_)), "{error}");
    let json = fixture_json(&workspace);
    let shim = u32::try_from(json["ppid"].as_u64().unwrap()).unwrap();
    assert!(shim_is_live(shim));
    assert_eq!(manager.process_started("attempt-m4"), Some(true));
    assert!(matches!(
        manager.withdraw_unstarted_registration("attempt-m4", seq).unwrap(),
        RegistrationWithdrawal::KeptProcessStarted { pid: Some(_) }
    ));
    assert!(manager.has_attempt("attempt-m4"));
    assert!(shim_is_live(shim), "a kept registration's process is never killed");

    stop_fixture(&workspace);
    drop(manager);
}

#[test]
fn m5_a_codex_registration_whose_process_is_gone_is_kept() {
    let _lock = lock();
    assert_env_pinned();
    let directory = tempfile::tempdir().unwrap();
    let workspace = directory.path().join("ws");
    fs::create_dir_all(&workspace).unwrap();
    let exit_now = write_exit_immediately(&workspace);
    let mut manager = RuntimeManager::new();
    manager
        .select_runtime("attempt-m5", "codex", Some(exit_now), "0.152.0", &workspace)
        .unwrap();
    let seq = manager.registration_seq("attempt-m5").unwrap();
    let error = manager
        .create_session("attempt-m5", &session_request("attempt-m5", &workspace))
        .unwrap_err();
    record_cause(&workspace, "m5", &error.to_string());
    // Whether the child was reaped by the identity check (spawned flag) or is still held
    // (handshake EOF), a spawned process counts as started.
    assert_eq!(manager.process_started("attempt-m5"), Some(true));
    assert!(matches!(
        manager.withdraw_unstarted_registration("attempt-m5", seq).unwrap(),
        RegistrationWithdrawal::KeptProcessStarted { .. }
    ));
    assert!(manager.has_attempt("attempt-m5"));
}
