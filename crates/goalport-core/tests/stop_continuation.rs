//! Post-Stop re-check and continuation (schema v8).
//!
//! The re-check is the FACT layer: it observes current reality and appends one row
//! to a ledger. It never writes `stop_responsibilities`, so it can neither release
//! nor downgrade a hold.
//!
//! The tests that matter most here are the ones proving what a re-check will NOT
//! say. `not-running` reads as safe, and the states that most need care -- a hold
//! whose child identity was never observable, an access-denied observation, a
//! recycled pid -- are exactly the ones a careless mapping would render as "the
//! bound runtime is gone".

use goalport_core::{
    Attempt, Campaign, Project, Store, Task, UiCommandRequest, UiController, WorkStatus,
    store::{RecheckVerdict, RuntimeObservation},
};
use serde_json::json;

/// Guards the process-global environment.
///
/// A plain Mutex was not enough and produced a real flake: it serialised the tests
/// that SET `GOALPORT_RECHECK_FRESH_MS`, but every other test still read the variable
/// while it was set, and two of them failed with "the most recent re-check is 1 ms old
/// (limit 0 ms)". A writer/reader split is the actual requirement -- the mutating test
/// takes the write lock, everything that depends on the variable takes a read lock.
static ENV_LOCK: std::sync::RwLock<()> = std::sync::RwLock::new(());

fn ui(message_type: &str, request_id: &str, payload: serde_json::Value) -> UiCommandRequest {
    UiCommandRequest {
        protocol_version: goalport_core::ipc::CONNECTED_UI_PROTOCOL_VERSION.into(),
        request_id: request_id.into(),
        entity_version: 0,
        message_type: message_type.into(),
        payload,
    }
}

fn binding() -> serde_json::Value {
    json!({
        "input_uuid": "input-recheck-1",
        "session_id": "session-recheck",
        "turn_epoch": 1,
        "process_epoch": "process-recheck"
    })
}

/// A held attempt in its own workspace, with no Stop event recorded yet.
fn seed_held(store: &Store, workspace: &str, attempt_id: &str) {
    store
        .insert_project(&Project {
            id: "project-recheck".into(),
            workspace_root: workspace.into(),
        })
        .unwrap();
    let campaign = Campaign {
        id: "campaign-recheck".into(),
        goal: "exercise post-stop re-check".into(),
        root_task_id: "task-recheck".into(),
        state: WorkStatus::InProgress,
    };
    let task = Task {
        id: "task-recheck".into(),
        campaign_id: "campaign-recheck".into(),
        title: "re-check the hold".into(),
        acceptance: "a fresh observation is recorded".into(),
        state: WorkStatus::InProgress,
    };
    store
        .create_campaign_with_task("project-recheck", &campaign, &task)
        .unwrap();
    store
        .insert_attempt(&Attempt::new(attempt_id, "task-recheck", "claude", "cap-v1"))
        .unwrap();
    store
        .begin_stop_responsibility(
            attempt_id,
            "operation-recheck-1",
            workspace,
            "claude",
            &binding(),
            Some(&json!({ "source": "ui.stop" })),
        )
        .unwrap();
}

/// Record a Stop event carrying the `stop_attempt` trace the re-check reads its
/// bound identity from. This mirrors what `stop_trace()` emits in production.
fn record_stop_trace(store: &Store, attempt_id: &str, seq: i64, trace: serde_json::Value) {
    store
        .append_event_with_state(
            &goalport_core::Event {
                id: format!("stop-trace-{seq}"),
                attempt_id: attempt_id.into(),
                seq,
                kind: "attempt.stop.requested".into(),
                payload_ref: None,
            },
            None,
            Some(&json!({ "stop_attempt": trace })),
        )
        .unwrap();
}

fn recheck(controller: &mut UiController, attempt_id: &str, n: u32) -> serde_json::Value {
    controller
        .handle(ui(
            "recheck_stop_responsibility",
            &format!("req-recheck-{n}"),
            json!({ "attemptId": attempt_id }),
        ))
        .unwrap()
        .receipt
        .expect("re-check returns a receipt")
}

// --- the impossibility, asserted at the storage layer -----------------------

#[test]
fn the_ledger_rejects_a_quiescence_verdict_at_the_sqlite_layer() {
    // The Rust enum has no Quiescent member, so this cannot be written through
    // the store's own API. That is the first line of defence and it is easy to
    // erode later. The CHECK constraint is the second, and it is the one that
    // still holds when a future caller reaches for raw SQL.
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("recheck.sqlite");
    let store = Store::open(&path).unwrap();
    assert_eq!(store.schema_version().unwrap(), 8);
    drop(store);

    let raw = rusqlite::Connection::open(&path).unwrap();
    let attempt = raw.execute(
        "INSERT INTO stop_recheck_observations(
             id, attempt_id, operation_id, workspace_key, core_epoch_id, observed_at,
             bound_runtime_json, runtime_observation, observation_detail_json,
             active_lease_count, pending_outbox_count, attempt_state, verdict)
         VALUES ('x','a','o','w','e','1','{}','not-running','{}',0,0,'CANCELLED','quiescent')",
        [],
    );
    assert!(
        attempt.is_err(),
        "SQLite accepted a quiescence verdict; the CHECK constraint is not doing its job"
    );

    // Control: the same insert with a legal verdict succeeds, so the rejection
    // above is about the verdict and not about the statement being malformed.
    raw.execute(
        "INSERT INTO stop_recheck_observations(
             id, attempt_id, operation_id, workspace_key, core_epoch_id, observed_at,
             bound_runtime_json, runtime_observation, observation_detail_json,
             active_lease_count, pending_outbox_count, attempt_state, verdict)
         VALUES ('x','a','o','w','e','1','{}','not-running','{}',0,0,'CANCELLED',
                 'bound-runtime-absent-residual-still-unknown')",
        [],
    )
    .unwrap();
}

#[test]
fn the_ledger_also_rejects_an_invented_runtime_observation() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("recheck.sqlite");
    Store::open(&path).unwrap();
    let raw = rusqlite::Connection::open(&path).unwrap();
    assert!(
        raw.execute(
            "INSERT INTO stop_recheck_observations(
                 id, attempt_id, operation_id, workspace_key, core_epoch_id, observed_at,
                 bound_runtime_json, runtime_observation, observation_detail_json,
                 active_lease_count, pending_outbox_count, attempt_state, verdict)
             VALUES ('y','a','o','w','e','1','{}','stopped','{}',0,0,'CANCELLED',
                     'observation-unavailable')",
            [],
        )
        .is_err(),
        "SQLite accepted a runtime_observation outside the three-valued domain"
    );
}

// --- freshness: a re-check is a new fact, not a redisplay -------------------

#[test]
fn each_recheck_appends_a_new_row_with_a_strictly_increasing_seq() {
    let directory = tempfile::tempdir().unwrap();
    let workspace = directory.path().join("ws");
    std::fs::create_dir_all(&workspace).unwrap();
    let store = Store::memory().unwrap();
    seed_held(&store, &workspace.to_string_lossy(), "attempt-recheck");
    let mut controller = UiController::new(store.clone()).unwrap();

    for n in 1..=3 {
        recheck(&mut controller, "attempt-recheck", n);
    }

    let rows = store
        .recheck_observations_for_attempt("attempt-recheck")
        .unwrap();
    assert_eq!(rows.len(), 3, "each invocation must append its own row");

    // `observed_at` is millisecond TEXT, so three re-checks can tie on it. That is
    // exactly why ordering is carried by `seq`: asserting a strict increase on the
    // timestamp would be a flaky test of the wrong property.
    for pair in rows.windows(2) {
        assert!(
            pair[1].seq > pair[0].seq,
            "seq must strictly increase: {} then {}",
            pair[0].seq,
            pair[1].seq
        );
        assert!(
            pair[1].observed_at >= pair[0].observed_at,
            "observed_at must be non-decreasing"
        );
    }
    assert_eq!(
        store
            .latest_recheck_observation("attempt-recheck")
            .unwrap()
            .unwrap()
            .seq,
        rows[2].seq
    );
}

#[test]
fn a_recheck_never_writes_the_responsibility_row() {
    let directory = tempfile::tempdir().unwrap();
    let workspace = directory.path().join("ws");
    std::fs::create_dir_all(&workspace).unwrap();
    let store = Store::memory().unwrap();
    seed_held(&store, &workspace.to_string_lossy(), "attempt-recheck");
    let before = store
        .stop_responsibility_for_attempt("attempt-recheck")
        .unwrap()
        .unwrap();

    let mut controller = UiController::new(store.clone()).unwrap();
    for n in 1..=2 {
        recheck(&mut controller, "attempt-recheck", n);
    }

    let after = store
        .stop_responsibility_for_attempt("attempt-recheck")
        .unwrap()
        .unwrap();
    assert_eq!(
        before, after,
        "a re-check must leave the responsibility row byte-identical, including updated_at"
    );
    assert_eq!(after.write_responsibility, "held");
    assert_eq!(after.residual_execution_state, "unknown");
}

// --- the five-row mapping ---------------------------------------------------

#[test]
fn row1_no_recorded_identity_is_unavailable_and_never_not_running() {
    // The uncertain-send hold emits no Stop event at all, so nothing was ever
    // recorded to observe. Rendering that as "the bound runtime is gone" would
    // manufacture a safe-looking conclusion for the least certain hold there is.
    let directory = tempfile::tempdir().unwrap();
    let workspace = directory.path().join("ws");
    std::fs::create_dir_all(&workspace).unwrap();
    let store = Store::memory().unwrap();
    seed_held(&store, &workspace.to_string_lossy(), "attempt-recheck");
    let mut controller = UiController::new(store.clone()).unwrap();

    let receipt = recheck(&mut controller, "attempt-recheck", 1);
    let row = store
        .latest_recheck_observation("attempt-recheck")
        .unwrap()
        .unwrap();
    assert_eq!(row.runtime_observation, RuntimeObservation::Unknown);
    assert_eq!(row.verdict, RecheckVerdict::ObservationUnavailable);
    assert_ne!(row.runtime_observation, RuntimeObservation::NotRunning);
    assert_eq!(row.observation_detail["row"], json!(1));
    assert_eq!(row.observation_detail["side"], json!("record"));
    assert_eq!(
        row.observation_detail["observeProcessCalled"],
        json!(false),
        "with no recorded identity there is nothing to observe, so the probe must not run"
    );
    assert_eq!(
        receipt["responsibilityUnchanged"]["writeResponsibility"],
        json!("held")
    );
}

#[test]
fn row1_also_covers_a_recorded_identity_that_is_present_but_empty() {
    // `resolve_stop` records pid 0 with empty creation date and sha when the child
    // identity was not observable. Feeding pid 0 to OpenProcess fails, which without
    // this row would classify as NotRunning.
    let directory = tempfile::tempdir().unwrap();
    let workspace = directory.path().join("ws");
    std::fs::create_dir_all(&workspace).unwrap();
    let store = Store::memory().unwrap();
    seed_held(&store, &workspace.to_string_lossy(), "attempt-recheck");
    record_stop_trace(
        &store,
        "attempt-recheck",
        1,
        json!({
            "operation_id": "operation-recheck-1",
            "bound_pid": 0,
            "bound_creation_date": "",
            "bound_executable_sha256": ""
        }),
    );
    let mut controller = UiController::new(store.clone()).unwrap();
    recheck(&mut controller, "attempt-recheck", 1);

    let row = store
        .latest_recheck_observation("attempt-recheck")
        .unwrap()
        .unwrap();
    assert_eq!(row.verdict, RecheckVerdict::ObservationUnavailable);
    assert_eq!(row.observation_detail["row"], json!(1));
    assert_eq!(row.observation_detail["observeProcessCalled"], json!(false));
    assert!(
        row.observation_detail["reason"]
            .as_str()
            .unwrap()
            .contains("bound_pid is 0")
    );
}

#[cfg(windows)]
#[test]
fn row5_matching_identity_is_live_and_row4_mismatch_is_unknown_not_absent() {
    use goalport_core::process_identity::{ProcessObservation, observe_process};

    // The one process guaranteed to be alive and observable during this test is
    // this one, so it stands in for a surviving residual runtime.
    let me = std::process::id();
    let ProcessObservation::Live(identity) = observe_process(me) else {
        panic!("the test process must be observable by its own pid");
    };

    let directory = tempfile::tempdir().unwrap();
    let workspace = directory.path().join("ws");
    std::fs::create_dir_all(&workspace).unwrap();

    // Row 5: pid, creation date and sha all match.
    let store = Store::memory().unwrap();
    seed_held(&store, &workspace.to_string_lossy(), "attempt-live");
    record_stop_trace(
        &store,
        "attempt-live",
        1,
        json!({
            "operation_id": "operation-recheck-1",
            "bound_pid": me,
            "bound_creation_date": identity.creation_date(),
            "bound_executable_sha256": identity.executable_sha256
        }),
    );
    let mut controller = UiController::new(store.clone()).unwrap();
    recheck(&mut controller, "attempt-live", 1);
    let row = store.latest_recheck_observation("attempt-live").unwrap().unwrap();
    assert_eq!(row.runtime_observation, RuntimeObservation::Live);
    assert_eq!(row.verdict, RecheckVerdict::BoundRuntimeLive);
    assert_eq!(row.observation_detail["row"], json!(5));

    // Row 4: same live pid, different creation date -- a recycled pid. This must
    // not become `live` (it is a different process) and must not become
    // `not-running` either (nothing showed the bound process ended).
    let store2 = Store::memory().unwrap();
    seed_held(&store2, &workspace.to_string_lossy(), "attempt-recycled");
    record_stop_trace(
        &store2,
        "attempt-recycled",
        1,
        json!({
            "operation_id": "operation-recheck-1",
            "bound_pid": me,
            "bound_creation_date": "/Date(1)/",
            "bound_executable_sha256": identity.executable_sha256
        }),
    );
    let mut controller2 = UiController::new(store2.clone()).unwrap();
    recheck(&mut controller2, "attempt-recycled", 1);
    let row = store2
        .latest_recheck_observation("attempt-recycled")
        .unwrap()
        .unwrap();
    assert_eq!(row.runtime_observation, RuntimeObservation::Unknown);
    assert_eq!(row.verdict, RecheckVerdict::ObservationUnavailable);
    assert_ne!(
        row.runtime_observation,
        RuntimeObservation::NotRunning,
        "a recycled pid is a mismatch, not evidence the bound process ended"
    );
    assert_eq!(row.observation_detail["row"], json!(4));
    assert_eq!(row.observation_detail["creationDateMatches"], json!(false));
}

#[cfg(windows)]
#[test]
fn row2_not_running_is_reachable_only_from_a_real_absent_process() {
    // 0xFFFFFFFE is not a valid Windows pid (pids are multiples of 4), so
    // OpenProcess fails with ERROR_INVALID_PARAMETER, which is the one failure
    // `observe_process` is willing to read as "not running".
    let directory = tempfile::tempdir().unwrap();
    let workspace = directory.path().join("ws");
    std::fs::create_dir_all(&workspace).unwrap();
    let store = Store::memory().unwrap();
    seed_held(&store, &workspace.to_string_lossy(), "attempt-gone");
    record_stop_trace(
        &store,
        "attempt-gone",
        1,
        json!({
            "operation_id": "operation-recheck-1",
            "bound_pid": 4294967294u32,
            "bound_creation_date": "/Date(1700000000000)/",
            "bound_executable_sha256": "0".repeat(64)
        }),
    );
    let mut controller = UiController::new(store.clone()).unwrap();
    recheck(&mut controller, "attempt-gone", 1);

    let row = store.latest_recheck_observation("attempt-gone").unwrap().unwrap();
    assert_eq!(row.runtime_observation, RuntimeObservation::NotRunning);
    assert_eq!(
        row.verdict,
        RecheckVerdict::BoundRuntimeAbsentResidualStillUnknown
    );
    assert_eq!(row.observation_detail["row"], json!(2));
    assert_eq!(row.observation_detail["observeProcessCalled"], json!(true));

    // The verdict names the bound runtime only. The hold stays held precisely
    // because descendants were never observed.
    let held = store
        .stop_responsibility_for_attempt("attempt-gone")
        .unwrap()
        .unwrap();
    assert_eq!(held.write_responsibility, "held");
    assert_eq!(held.residual_execution_state, "unknown");
}

#[cfg(windows)]
#[test]
fn row2_terminated_process_with_retained_handle_still_holds() {
    use goalport_core::process_identity::{ProcessObservation, observe_process};
    use std::process::{Command, Stdio};

    let mut child = Command::new("cmd")
        .args(["/C", "exit", "0"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let pid = child.id();
    child.wait().unwrap();
    assert!(
        matches!(observe_process(pid), ProcessObservation::NotRunning),
        "retained Child handle must not keep a terminated pid Live: {:?}",
        observe_process(pid)
    );

    let directory = tempfile::tempdir().unwrap();
    let workspace = directory.path().join("ws");
    std::fs::create_dir_all(&workspace).unwrap();
    let store = Store::memory().unwrap();
    seed_held(&store, &workspace.to_string_lossy(), "attempt-zombie");
    record_stop_trace(
        &store,
        "attempt-zombie",
        1,
        json!({
            "operation_id": "operation-recheck-1",
            "bound_pid": pid,
            "bound_creation_date": "/Date(1700000000000)/",
            "bound_executable_sha256": "0".repeat(64)
        }),
    );
    let mut controller = UiController::new(store.clone()).unwrap();
    recheck(&mut controller, "attempt-zombie", 1);
    let row = store
        .latest_recheck_observation("attempt-zombie")
        .unwrap()
        .unwrap();
    assert_eq!(row.runtime_observation, RuntimeObservation::NotRunning);
    assert_eq!(
        row.verdict,
        RecheckVerdict::BoundRuntimeAbsentResidualStillUnknown
    );
    let held = store
        .stop_responsibility_for_attempt("attempt-zombie")
        .unwrap()
        .unwrap();
    assert_eq!(held.write_responsibility, "held");
    assert_eq!(held.residual_execution_state, "unknown");
}

// --- the continuation: refusals first, then the one path that works ---------
//
// Refusals are tested before the happy path deliberately. A continuation that
// lands in the wrong workspace, or that reuses the held attempt id, is worse than
// no continuation at all: the second one force-kills the residual process, because
// `select_runtime` replaces its map entry and Claude's Drop reaches child.kill().

fn recheck_then(store: &Store, controller: &mut UiController, attempt_id: &str) {
    // Every continuation needs a current basis observation, so each of these tests
    // earns one first. No Stop trace was recorded, so the verdict is
    // observation-unavailable -- which is fine: a continuation does not require a
    // reassuring verdict, only a current one.
    recheck(controller, attempt_id, 1);
    assert!(store.latest_recheck_observation(attempt_id).unwrap().is_some());
}

fn continue_into(
    controller: &mut UiController,
    attempt_id: &str,
    target: &std::path::Path,
    n: u32,
) -> Result<serde_json::Value, String> {
    // Read lock: this path reads GOALPORT_RECHECK_FRESH_MS, so it must not run while
    // the staleness test has it pinned to 0.
    let _guard = ENV_LOCK.read().unwrap_or_else(|poisoned| poisoned.into_inner());
    continue_into_unguarded(controller, attempt_id, target, n)
}

fn continue_into_unguarded(
    controller: &mut UiController,
    attempt_id: &str,
    target: &std::path::Path,
    n: u32,
) -> Result<serde_json::Value, String> {
    controller
        .handle(ui(
            "continue_in_isolated_workspace",
            &format!("req-cont-{n}"),
            json!({ "attemptId": attempt_id, "targetWorkspace": target.to_string_lossy() }),
        ))
        .map(|result| result.receipt.expect("continuation returns a receipt"))
}

#[test]
fn continuation_without_a_recheck_is_refused() {
    let directory = tempfile::tempdir().unwrap();
    let workspace = directory.path().join("ws");
    std::fs::create_dir_all(&workspace).unwrap();
    let store = Store::memory().unwrap();
    seed_held(&store, &workspace.to_string_lossy(), "attempt-recheck");
    let mut controller = UiController::new(store.clone()).unwrap();

    let error = continue_into(
        &mut controller,
        "attempt-recheck",
        &directory.path().join("ws-continued"),
        1,
    )
    .unwrap_err();
    assert!(error.contains("requires a re-check"), "unexpected refusal: {error}");
    assert!(
        store
            .stop_continuations_for_source("attempt-recheck")
            .unwrap()
            .is_empty()
    );
}

#[test]
fn a_stale_recheck_is_refused() {
    let directory = tempfile::tempdir().unwrap();
    let workspace = directory.path().join("ws");
    std::fs::create_dir_all(&workspace).unwrap();
    let store = Store::memory().unwrap();
    seed_held(&store, &workspace.to_string_lossy(), "attempt-recheck");
    let mut controller = UiController::new(store.clone()).unwrap();
    recheck_then(&store, &mut controller, "attempt-recheck");

    // An observation older than the freshness window is not a current fact.
    //
    // Two things this test got wrong before, both worth naming because the second was
    // misdiagnosed once already:
    //
    //  1. The window is process-global, so it is taken under a WRITE lock while every
    //     reader (`continue_into`) takes a READ lock.
    //  2. Setting the window to 0 is not by itself enough. The product compares
    //     `age_ms > fresh_ms`, and when the re-check and the continuation land in the
    //     same millisecond `age_ms` is 0, so `0 > 0` is false, the staleness refusal
    //     does not fire, and this test's `unwrap_err()` panics -- about 7% of runs in
    //     isolation. The earlier "fix" blamed the lock and left this alone. The
    //     observation is therefore made genuinely older than the window.
    //
    // The variable is restored by a guard rather than a trailing statement: the panic
    // above unwound past the old `remove_var`, leaving the window pinned at 0 for the
    // whole process and turning one failure into twelve.
    struct EnvWindow;
    impl Drop for EnvWindow {
        fn drop(&mut self) {
            unsafe { std::env::remove_var("GOALPORT_RECHECK_FRESH_MS") };
        }
    }
    let _lock = ENV_LOCK.write().unwrap_or_else(|poisoned| poisoned.into_inner());
    unsafe { std::env::set_var("GOALPORT_RECHECK_FRESH_MS", "0") };
    let _restore = EnvWindow;
    std::thread::sleep(std::time::Duration::from_millis(3));
    // Unguarded: this thread already holds the write lock, and the guards are not
    // reentrant.
    let error = continue_into_unguarded(
        &mut controller,
        "attempt-recheck",
        &directory.path().join("ws-continued"),
        1,
    )
    .unwrap_err();
    assert!(error.contains("re-check again"), "unexpected refusal: {error}");
    assert!(
        store
            .stop_continuations_for_source("attempt-recheck")
            .unwrap()
            .is_empty()
    );
}

#[test]
fn a_target_overlapping_the_held_workspace_is_refused() {
    let directory = tempfile::tempdir().unwrap();
    let workspace = directory.path().join("ws");
    std::fs::create_dir_all(&workspace).unwrap();
    let store = Store::memory().unwrap();
    seed_held(&store, &workspace.to_string_lossy(), "attempt-recheck");
    let mut controller = UiController::new(store.clone()).unwrap();
    recheck_then(&store, &mut controller, "attempt-recheck");

    // A child of the held workspace overlaps it. This is the case a user would most
    // plausibly reach for -- "just work in a subfolder" -- and it is exactly wrong.
    let error = continue_into(&mut controller, "attempt-recheck", &workspace.join("inner"), 1)
        .unwrap_err();
    assert!(
        error.contains("overlaps a held Stop responsibility"),
        "unexpected refusal: {error}"
    );

    // The held workspace itself, likewise.
    let error = continue_into(&mut controller, "attempt-recheck", &workspace, 2).unwrap_err();
    assert!(
        error.contains("overlaps a held Stop responsibility"),
        "unexpected refusal: {error}"
    );
    assert!(
        store
            .stop_continuations_for_source("attempt-recheck")
            .unwrap()
            .is_empty()
    );
}

#[test]
fn a_target_overlapping_a_live_lease_is_refused() {
    use goalport_core::{AccessMode, WorkspaceLease};
    let directory = tempfile::tempdir().unwrap();
    let workspace = directory.path().join("ws");
    let other = directory.path().join("ws-leased");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::create_dir_all(&other).unwrap();
    let store = Store::memory().unwrap();
    seed_held(&store, &workspace.to_string_lossy(), "attempt-recheck");
    store
        .insert_attempt(&goalport_core::Attempt::new(
            "attempt-other",
            "task-recheck",
            "claude",
            "cap-v1",
        ))
        .unwrap();
    store
        .acquire_lease(&WorkspaceLease::new(&other, "attempt-other", AccessMode::Mutating))
        .unwrap();
    let mut controller = UiController::new(store.clone()).unwrap();
    recheck_then(&store, &mut controller, "attempt-recheck");

    let error = continue_into(&mut controller, "attempt-recheck", &other, 1).unwrap_err();
    assert!(error.contains("lease"), "unexpected refusal: {error}");
    assert!(
        store
            .stop_continuations_for_source("attempt-recheck")
            .unwrap()
            .is_empty()
    );
}

#[test]
fn a_target_that_is_a_file_is_refused_without_clobbering_it() {
    let directory = tempfile::tempdir().unwrap();
    let workspace = directory.path().join("ws");
    std::fs::create_dir_all(&workspace).unwrap();
    let occupied = directory.path().join("already-a-file");
    std::fs::write(&occupied, b"user data").unwrap();
    let store = Store::memory().unwrap();
    seed_held(&store, &workspace.to_string_lossy(), "attempt-recheck");
    let mut controller = UiController::new(store.clone()).unwrap();
    recheck_then(&store, &mut controller, "attempt-recheck");

    let error = continue_into(&mut controller, "attempt-recheck", &occupied, 1).unwrap_err();
    assert!(error.contains("not a directory"), "unexpected refusal: {error}");
    assert_eq!(
        std::fs::read(&occupied).unwrap(),
        b"user data",
        "a refused continuation must not touch what is already there"
    );
}

#[test]
fn a_replayed_continuation_never_mints_a_second_one() {
    let directory = tempfile::tempdir().unwrap();
    let workspace = directory.path().join("ws");
    std::fs::create_dir_all(&workspace).unwrap();
    let target = directory.path().join("ws-continued");
    let store = Store::memory().unwrap();
    seed_held(&store, &workspace.to_string_lossy(), "attempt-recheck");
    let mut controller = UiController::new(store.clone()).unwrap();
    recheck_then(&store, &mut controller, "attempt-recheck");

    continue_into(&mut controller, "attempt-recheck", &target, 1).unwrap();
    recheck(&mut controller, "attempt-recheck", 2);
    // Same source, same target, a different request id: a repeat click, a reopened
    // GUI, or a replayed request. One continuation is the answer to all three.
    let error = continue_into(&mut controller, "attempt-recheck", &target, 2).unwrap_err();
    assert!(
        error.contains("already has a continuation"),
        "unexpected refusal: {error}"
    );
    assert_eq!(
        store
            .stop_continuations_for_source("attempt-recheck")
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn continuation_carries_the_work_and_never_the_turn() {
    let directory = tempfile::tempdir().unwrap();
    let workspace = directory.path().join("ws");
    std::fs::create_dir_all(&workspace).unwrap();
    let target = directory.path().join("ws-continued");
    let store = Store::memory().unwrap();
    seed_held(&store, &workspace.to_string_lossy(), "attempt-recheck");
    let mut controller = UiController::new(store.clone()).unwrap();
    recheck_then(&store, &mut controller, "attempt-recheck");

    let receipt = continue_into(&mut controller, "attempt-recheck", &target, 1).unwrap();
    let record = &receipt["continuation"];

    // Carried: the description of the work.
    assert_eq!(record["carriedContext"]["title"], json!("re-check the hold"));
    assert_eq!(
        record["carriedContext"]["acceptance"],
        json!("a fresh observation is recorded")
    );
    assert_eq!(
        record["carriedContext"]["goal"],
        json!("exercise post-stop re-check")
    );

    // Linked to its source, so this is a continuation and not fresh metadata.
    assert_eq!(record["sourceAttemptId"], json!("attempt-recheck"));
    assert_eq!(record["sourceOperationId"], json!("operation-recheck-1"));
    assert_eq!(record["sourceTaskId"], json!("task-recheck"));
    assert_eq!(record["sourceCampaignId"], json!("campaign-recheck"));

    // New identity throughout. A copied task id would regenerate the held attempt
    // id and route straight into the kill path.
    assert_ne!(record["newAttemptId"], json!("attempt-recheck"));
    assert_ne!(record["newTaskId"], json!("task-recheck"));
    assert_ne!(record["newCampaignId"], json!("campaign-recheck"));

    // The whole authorization triple, not just the flag that sounds smallest.
    let auth = &record["authorizationGranted"];
    assert_eq!(auth["providerAuthorized"], json!(true));
    assert_eq!(auth["actionAuthorized"], json!(true));
    assert_eq!(auth["transferAuthorized"], json!(true));
    assert!(auth["scope"].as_str().unwrap().contains("new campaign only"));

    // The disclosure says the uncomfortable part out loud.
    let disclosure = &record["isolationDisclosure"];
    assert!(
        disclosure["residualCanStillWriteHere"]
            .as_str()
            .unwrap()
            .contains("including into this new workspace")
    );
    assert!(
        disclosure["notEvidenceOfIsolation"]
            .as_str()
            .unwrap()
            .contains("does not release the original hold")
    );

    // The source hold is exactly where it was.
    assert_eq!(
        receipt["sourceResponsibilityUnchanged"]["writeResponsibility"],
        json!("held")
    );
    assert_eq!(
        receipt["sourceResponsibilityUnchanged"]["residualExecutionState"],
        json!("unknown")
    );

    // Labelled as a continuation, never as a native resume.
    let new_attempt = record["newAttemptId"].as_str().unwrap();
    let kinds: Vec<String> = store
        .list_events(new_attempt)
        .unwrap()
        .into_iter()
        .map(|event| event.kind)
        .collect();
    assert!(kinds.iter().any(|kind| kind == "attempt.continuation.isolated"));
    assert!(
        !kinds.iter().any(|kind| kind.contains("session.resumed")),
        "a continuation must never present itself as a native resume: {kinds:?}"
    );
}

#[test]
fn the_source_workspace_stays_blocked_after_a_continuation() {
    // The continuation is not a release. Everything the hold blocked before, it
    // blocks after. This is the assertion that would catch a future change quietly
    // turning the continuation record into a bypass.
    let directory = tempfile::tempdir().unwrap();
    let workspace = directory.path().join("ws");
    std::fs::create_dir_all(&workspace).unwrap();
    let target = directory.path().join("ws-continued");
    let store = Store::memory().unwrap();
    seed_held(&store, &workspace.to_string_lossy(), "attempt-recheck");
    let mut controller = UiController::new(store.clone()).unwrap();
    recheck_then(&store, &mut controller, "attempt-recheck");
    continue_into(&mut controller, "attempt-recheck", &target, 1).unwrap();

    assert!(
        store
            .held_stop_for_workspace(&workspace.to_string_lossy())
            .unwrap()
            .is_some(),
        "the source workspace must still resolve to a held responsibility"
    );
    store
        .insert_attempt(&goalport_core::Attempt::new(
            "attempt-late",
            "task-recheck",
            "claude",
            "cap-v1",
        ))
        .unwrap();
    let conflict = store.acquire_lease(&goalport_core::WorkspaceLease::new(
        &workspace,
        "attempt-late",
        goalport_core::AccessMode::Mutating,
    ));
    assert!(
        matches!(
            conflict,
            Err(goalport_core::StoreError::StopResponsibilityConflict { .. })
        ),
        "the held workspace must still refuse a new mutating lease"
    );
}

// --- the collision guard ----------------------------------------------------
//
// This is the structural defence against a silent force-kill, tested as two
// halves: the boundary itself refuses to replace, and the continuation guard
// mints an id that is not already registered.
//
// The hazard used to be that `select_runtime` did `attempts.insert(attempt_id,
// runtime)`, which REPLACED any existing entry: dropping the old `ManagedRuntime`
// runs `close()`, which for a Claude runtime calls `child.kill()`, so registering
// under an occupied attempt id killed that process with no event and no record.
// The registration boundary now refuses an occupied key outright; `admit_runtime`
// still derives its default id deterministically from the task id and provider,
// which is why the continuation guard keeps asking before choosing a new id.

#[test]
fn select_runtime_refuses_to_replace_an_existing_entry() {
    let directory = tempfile::tempdir().unwrap();
    let workspace = directory.path().join("ws");
    std::fs::create_dir_all(&workspace).unwrap();
    let mut manager = goalport_core::RuntimeManager::new();

    assert!(
        !manager.has_attempt("attempt-x"),
        "nothing is registered before the first select"
    );
    manager
        .select_runtime("attempt-x", "scenario", None, "1.0.0", &workspace)
        .unwrap();
    assert!(manager.has_attempt("attempt-x"));

    // The second select under the SAME id is refused by the boundary and the
    // original registration survives untouched.
    let second = manager.select_runtime("attempt-x", "scenario", None, "1.0.0", &workspace);
    assert!(second.is_err(), "an occupied key must be refused, not replaced");
    let message = second.unwrap_err().to_string();
    assert!(
        message.contains("runtime registration occupied"),
        "the refusal must name the boundary, got: {message}"
    );
    assert!(manager.has_attempt("attempt-x"));

    // And a distinct id is genuinely distinct, so minting a fresh id is a real
    // escape from the hazard rather than a cosmetic one.
    assert!(!manager.has_attempt("attempt-y"));
}

#[test]
fn a_continuation_mints_an_attempt_id_that_is_not_already_registered() {
    // The guard's precondition, asserted end to end: after a real continuation the
    // new attempt id must differ from the source, and no runtime may already be
    // registered under it. If a future change made the id derivation collide, this
    // fails here rather than by killing a residual process in the field.
    let directory = tempfile::tempdir().unwrap();
    let workspace = directory.path().join("ws");
    std::fs::create_dir_all(&workspace).unwrap();
    let target = directory.path().join("ws-continued");
    let store = Store::memory().unwrap();
    seed_held(&store, &workspace.to_string_lossy(), "attempt-recheck");
    let mut controller = UiController::new(store.clone()).unwrap();
    recheck_then(&store, &mut controller, "attempt-recheck");

    let receipt = continue_into(&mut controller, "attempt-recheck", &target, 1).unwrap();
    let new_attempt = receipt["continuation"]["newAttemptId"].as_str().unwrap();
    assert_ne!(new_attempt, "attempt-recheck");

    // The source attempt still owns its own row, untouched by the continuation.
    let held = store
        .stop_responsibility_for_attempt("attempt-recheck")
        .unwrap()
        .unwrap();
    assert_eq!(held.attempt_id, "attempt-recheck");
    assert_eq!(held.write_responsibility, "held");

    // And the continuation is linked from the new attempt, so the two are related
    // in the record without sharing an identity.
    let linked = store
        .stop_continuation_for_new_attempt(new_attempt)
        .unwrap()
        .expect("the new attempt resolves back to its continuation record");
    assert_eq!(linked.source_attempt_id, "attempt-recheck");
}

// --- what the blocked-work panel is given -----------------------------------

#[test]
fn a_governing_hold_names_the_work_the_workspace_and_the_interruption() {
    // Before this, the GUI could say a workspace was held without ever naming which
    // workspace, which task, or when. "Something is blocked" is not an explanation.
    let directory = tempfile::tempdir().unwrap();
    let workspace = directory.path().join("ws");
    std::fs::create_dir_all(&workspace).unwrap();
    let store = Store::memory().unwrap();
    seed_held(&store, &workspace.to_string_lossy(), "attempt-recheck");
    let mut controller = UiController::new(store.clone()).unwrap();
    controller
        .handle(ui(
            "select_project",
            "req-select",
            json!({ "projectId": "project-recheck" }),
        ))
        .unwrap();

    let snapshot = controller.snapshot(None).unwrap();
    let hold = snapshot
        .stop_responsibility
        .expect("the held workspace must surface its hold");

    assert!(!hold.workspace_key.is_empty());
    assert_eq!(hold.task_title, "re-check the hold");
    assert_eq!(hold.campaign_goal, "exercise post-stop re-check");
    assert_eq!(hold.operation_id, "operation-recheck-1");
    assert_eq!(hold.input_uuid, "input-recheck-1");
    assert!(
        !hold.interrupted_at.is_empty(),
        "which interruption left this responsibility must have an answer"
    );
    assert!(hold.blocks_current_workspace);
    assert!(
        hold.blocked_reason.contains("blocked by durable Stop responsibility"),
        "unexpected reason: {}",
        hold.blocked_reason
    );
    // The three independent states are unchanged by all of this.
    assert_eq!(hold.native_turn_state, "pending");
    assert_eq!(hold.residual_execution_state, "unknown");
    assert_eq!(hold.write_responsibility, "held");
    assert!(hold.latest_recheck.is_none(), "no re-check has been taken yet");
}

#[test]
fn the_panel_survives_the_move_into_the_continuation_workspace() {
    // The product steers the user out of the held workspace, so this is exactly the
    // moment the explanation must not disappear. `stop_responsibility` is now empty
    // -- the new workspace really is not blocked -- and the source hold arrives
    // through `related_holds` instead.
    let directory = tempfile::tempdir().unwrap();
    let workspace = directory.path().join("ws");
    std::fs::create_dir_all(&workspace).unwrap();
    let target = directory.path().join("ws-continued");
    let store = Store::memory().unwrap();
    seed_held(&store, &workspace.to_string_lossy(), "attempt-recheck");
    let mut controller = UiController::new(store.clone()).unwrap();
    recheck_then(&store, &mut controller, "attempt-recheck");
    continue_into(&mut controller, "attempt-recheck", &target, 1).unwrap();

    let snapshot = controller.snapshot(None).unwrap();
    assert!(
        snapshot.stop_responsibility.is_none(),
        "the continuation workspace is genuinely not blocked, so nothing may claim it is"
    );
    assert_eq!(
        snapshot.related_holds.len(),
        1,
        "the source hold must still be reachable from here"
    );

    let related = &snapshot.related_holds[0];
    assert_eq!(related.attempt_id, "attempt-recheck");
    assert_eq!(related.write_responsibility, "held");
    assert!(
        !related.blocks_current_workspace,
        "rendering `held` here without this flag would tell the user their current \
         workspace is blocked when it is not"
    );
    assert!(
        related.blocked_reason.contains("belongs to source workspace"),
        "unexpected reason: {}",
        related.blocked_reason
    );
    assert!(
        related.blocked_reason.contains("current workspace is not blocked"),
        "unexpected reason: {}",
        related.blocked_reason
    );
    // It still names the source workspace, so the user can tell which one is held.
    assert!(related.workspace_key.to_lowercase().contains("ws"));
    // And the re-check that authorised the continuation is attached to it.
    assert!(related.latest_recheck.is_some());
}

#[test]
fn a_recheck_can_be_taken_from_the_related_holds_view() {
    // The post-continuation re-check happens when the user is in the new workspace,
    // where the source attempt is no longer the selected one. If the command only
    // ever worked on the selection, this would be impossible exactly when it matters.
    let directory = tempfile::tempdir().unwrap();
    let workspace = directory.path().join("ws");
    std::fs::create_dir_all(&workspace).unwrap();
    let target = directory.path().join("ws-continued");
    let store = Store::memory().unwrap();
    seed_held(&store, &workspace.to_string_lossy(), "attempt-recheck");
    let mut controller = UiController::new(store.clone()).unwrap();
    recheck_then(&store, &mut controller, "attempt-recheck");
    continue_into(&mut controller, "attempt-recheck", &target, 1).unwrap();

    let snapshot = controller.snapshot(None).unwrap();
    let related_attempt = snapshot.related_holds[0].attempt_id.clone();
    assert_ne!(
        Some(related_attempt.clone()),
        snapshot.stop_responsibility.map(|hold| hold.attempt_id),
        "precondition: the source hold is not the current selection"
    );

    let before = store
        .recheck_observations_for_attempt(&related_attempt)
        .unwrap()
        .len();
    recheck(&mut controller, &related_attempt, 9);
    let after = store
        .recheck_observations_for_attempt(&related_attempt)
        .unwrap();
    assert_eq!(
        after.len(),
        before + 1,
        "a re-check taken from the related-holds view must append a real observation"
    );

    // And it is still a fact about the SOURCE hold, not about where the user is now.
    assert_eq!(after.last().unwrap().attempt_id, related_attempt);
    assert_eq!(
        store
            .stop_responsibility_for_attempt(&related_attempt)
            .unwrap()
            .unwrap()
            .write_responsibility,
        "held"
    );
}

#[test]
fn the_latest_recheck_is_attached_to_the_hold_it_describes() {
    let directory = tempfile::tempdir().unwrap();
    let workspace = directory.path().join("ws");
    std::fs::create_dir_all(&workspace).unwrap();
    let store = Store::memory().unwrap();
    seed_held(&store, &workspace.to_string_lossy(), "attempt-recheck");
    let mut controller = UiController::new(store.clone()).unwrap();
    controller
        .handle(ui(
            "select_project",
            "req-select",
            json!({ "projectId": "project-recheck" }),
        ))
        .unwrap();
    recheck(&mut controller, "attempt-recheck", 1);
    recheck(&mut controller, "attempt-recheck", 2);

    let snapshot = controller.snapshot(None).unwrap();
    let hold = snapshot.stop_responsibility.unwrap();
    let attached = hold.latest_recheck.expect("the newest re-check is attached");

    // Newest by seq, and carrying its own timestamp so the GUI can show WHEN the
    // fact was established rather than implying it is current.
    let newest = store
        .latest_recheck_observation("attempt-recheck")
        .unwrap()
        .unwrap();
    assert_eq!(attached["seq"], json!(newest.seq));
    assert_eq!(attached["observedAt"], json!(newest.observed_at));
    assert_eq!(attached["verdict"], json!("observation-unavailable"));
}

#[test]
fn a_second_continuation_into_a_DIFFERENT_target_is_also_refused() {
    // Found by running the real GUI, not by reasoning: the panel proposes a fresh
    // timestamped sibling on every click, so keying single-use on
    // (source, target) never fired. A second click quietly minted a second
    // workspace, a second campaign, and a second three-flag authorization grant.
    // One held responsibility gets at most one continuation.
    let directory = tempfile::tempdir().unwrap();
    let workspace = directory.path().join("ws");
    std::fs::create_dir_all(&workspace).unwrap();
    let store = Store::memory().unwrap();
    seed_held(&store, &workspace.to_string_lossy(), "attempt-recheck");
    let mut controller = UiController::new(store.clone()).unwrap();
    recheck_then(&store, &mut controller, "attempt-recheck");

    continue_into(&mut controller, "attempt-recheck", &directory.path().join("ws-continued-a"), 1).unwrap();
    recheck(&mut controller, "attempt-recheck", 2);
    let error = continue_into(
        &mut controller,
        "attempt-recheck",
        &directory.path().join("ws-continued-b"),
        2,
    )
    .unwrap_err();
    assert!(
        error.contains("already has a continuation"),
        "unexpected refusal: {error}"
    );
    assert!(error.contains("ws-continued-a"), "the refusal must name where to go instead: {error}");
    assert_eq!(
        store.stop_continuations_for_source("attempt-recheck").unwrap().len(),
        1
    );
    // The refusal must leave NOTHING behind. The previous version of this assertion
    // checked `stop_continuation_for_new_attempt(...) == None` -- the very row whose
    // insert failed, so it was true by construction and checked none of what the
    // comment promised. Meanwhile the real leak was live: a refused repeat click had
    // already created a directory, a Project, a Campaign, a Task and a fully granted
    // authorization triple, none of which rolls back.
    let second_target = directory.path().join("ws-continued-b");
    assert!(
        !second_target.exists(),
        "a refused continuation must not leave its target directory behind"
    );
    assert!(
        store.get_project("project-cont-req-cont-2").is_err(),
        "a refused continuation must not leave a Project behind"
    );
    assert!(
        store.get_campaign("campaign-cont-req-cont-2").is_err(),
        "a refused continuation must not leave a Campaign behind"
    );
    assert_eq!(
        store
            .get_campaign_authorization("campaign-cont-req-cont-2")
            .unwrap(),
        goalport_core::store::CampaignAuthorization::denied(),
        "a refused continuation must not leave an authorization grant behind"
    );
    assert!(
        store.get_attempt("attempt-cont-req-cont-2").is_err(),
        "a refused continuation must not leave an Attempt behind"
    );
}

// --- bearers the frozen criteria name by name -------------------------------
//
// Added after the execution audit pointed out that CR4, CR5 and CR7 each named a
// specific deterministic bearer that did not exist. The behaviour was right; the
// evidence for it was borrowed from neighbouring tests. Borrowed evidence is how a
// criterion quietly stops being checked.

#[test]
fn cr4_the_responsibility_row_is_byte_identical_across_a_continuation() {
    // CR4's primary bearer. The neighbouring test covers re-checks; a continuation
    // writes far more (four entities, an authorization grant, an event) and is the
    // operation that would plausibly touch the row.
    let directory = tempfile::tempdir().unwrap();
    let workspace = directory.path().join("ws");
    std::fs::create_dir_all(&workspace).unwrap();
    let store = Store::memory().unwrap();
    seed_held(&store, &workspace.to_string_lossy(), "attempt-recheck");
    let mut controller = UiController::new(store.clone()).unwrap();
    recheck_then(&store, &mut controller, "attempt-recheck");

    let before = store
        .stop_responsibility_for_attempt("attempt-recheck")
        .unwrap()
        .unwrap();
    let before_json = serde_json::to_string(&before).unwrap();

    continue_into(&mut controller, "attempt-recheck", &directory.path().join("ws-cont"), 1).unwrap();

    let after = store
        .stop_responsibility_for_attempt("attempt-recheck")
        .unwrap()
        .unwrap();
    assert_eq!(
        before_json,
        serde_json::to_string(&after).unwrap(),
        "a continuation must leave the responsibility row byte-identical, updated_at included"
    );
    assert_eq!(after.write_responsibility, "held");
    assert_eq!(after.residual_execution_state, "unknown");
    assert_eq!(after.native_turn_state, before.native_turn_state);
}

#[test]
fn cr7_a_colliding_attempt_id_is_refused_and_the_runtime_map_is_not_touched() {
    // CR7's deterministic half, driven entirely through the public command surface --
    // no test-only constructor, because a guard that only holds under a test-shaped
    // entry point is not the guard that ships.
    //
    // `select_runtime` REPLACES its map entry, and replacing a Claude runtime drops
    // it, which kills its child. So the continuation must refuse on a collision
    // rather than proceed.
    let directory = tempfile::tempdir().unwrap();
    let held_ws = directory.path().join("ws-held");
    let other_ws = directory.path().join("ws-other");
    std::fs::create_dir_all(&held_ws).unwrap();
    std::fs::create_dir_all(&other_ws).unwrap();
    let store = Store::memory().unwrap();
    seed_held(&store, &held_ws.to_string_lossy(), "attempt-recheck");

    // A second, unheld project, so a runtime can legitimately be admitted there.
    store
        .insert_project(&Project {
            id: "project-other".into(),
            workspace_root: other_ws.to_string_lossy().to_string(),
        })
        .unwrap();
    let other_campaign = Campaign {
        id: "campaign-other".into(),
        goal: "occupy an attempt id".into(),
        root_task_id: "task-other".into(),
        state: WorkStatus::InProgress,
    };
    let other_task = Task {
        id: "task-other".into(),
        campaign_id: "campaign-other".into(),
        title: "occupy".into(),
        acceptance: "runtime registered".into(),
        state: WorkStatus::InProgress,
    };
    store
        .create_campaign_with_task("project-other", &other_campaign, &other_task)
        .unwrap();
    store
        .set_campaign_authorization(
            "campaign-other",
            &goalport_core::store::CampaignAuthorization::granted(),
        )
        .unwrap();

    let mut controller = UiController::new(store.clone()).unwrap();
    controller
        .handle(ui("select_project", "req-p", json!({ "projectId": "project-other" })))
        .unwrap();
    // Occupy exactly the id a continuation with request id "req-cont-1" will mint.
    controller
        .handle(ui(
            "select_runtime",
            "req-occupy",
            json!({
                "projectId": "project-other",
                "campaignId": "campaign-other",
                "taskId": "task-other",
                "provider": "scenario",
                "attemptId": "attempt-cont-req-cont-1"
            }),
        ))
        .unwrap();

    recheck(&mut controller, "attempt-recheck", 1);
    let error = continue_into(&mut controller, "attempt-recheck", &directory.path().join("ws-cont"), 1)
        .unwrap_err();
    assert!(
        error.contains("a live runtime is already registered"),
        "unexpected refusal: {error}"
    );
    // Nothing was recorded, so the refusal happened before any state was written.
    assert!(
        store
            .stop_continuations_for_source("attempt-recheck")
            .unwrap()
            .is_empty()
    );
    // And the occupying runtime is still admitted: a second select under that id
    // would have replaced (and, for Claude, killed) it.
    assert!(store.get_attempt("attempt-cont-req-cont-1").is_ok());
}

#[test]
fn cr5_a_basis_observation_from_another_core_epoch_is_refused() {
    // CR5's foreign-epoch negative. "I checked, before the restart" is not a current
    // fact: a Core epoch boundary means the process landscape may have changed
    // entirely underneath the observation.
    let directory = tempfile::tempdir().unwrap();
    let workspace = directory.path().join("ws");
    std::fs::create_dir_all(&workspace).unwrap();
    let store = Store::memory().unwrap();
    seed_held(&store, &workspace.to_string_lossy(), "attempt-recheck");
    let mut controller = UiController::new(store.clone()).unwrap();

    // Record an observation stamped with an epoch that is not the current one.
    store
        .record_recheck_observation(&goalport_core::store::NewRecheckObservation {
            id: "recheck-foreign".into(),
            attempt_id: "attempt-recheck".into(),
            operation_id: "operation-recheck-1".into(),
            workspace_key: workspace.to_string_lossy().to_string(),
            core_epoch_id: "core-epoch:from-a-previous-core".into(),
            bound_runtime: json!({}),
            runtime_observation: goalport_core::store::RuntimeObservation::Unknown,
            observation_detail: json!({ "row": 1 }),
            active_lease_count: 0,
            pending_outbox_count: 0,
            attempt_state: "Cancelled".into(),
            verdict: goalport_core::store::RecheckVerdict::ObservationUnavailable,
        })
        .unwrap();

    let error = continue_into(&mut controller, "attempt-recheck", &directory.path().join("ws-cont"), 1)
        .unwrap_err();
    assert!(
        error.contains("Core epoch") && error.contains("re-check again"),
        "unexpected refusal: {error}"
    );
    assert!(
        store
            .stop_continuations_for_source("attempt-recheck")
            .unwrap()
            .is_empty()
    );
}

#[test]
fn cr2_row3_an_unobservable_process_is_unknown_and_never_absent() {
    // The one mapping row with no coverage. An access-denied or otherwise
    // unobservable process must read as `unknown`, never as `not-running`: the
    // second reads as safe and nothing here established safety.
    //
    // pid 4 is the Windows System process: it exists, so OpenProcess does not fail
    // with the invalid-parameter code that means "absent", but a normal user cannot
    // query its image, so the observation is genuinely unavailable.
    let directory = tempfile::tempdir().unwrap();
    let workspace = directory.path().join("ws");
    std::fs::create_dir_all(&workspace).unwrap();
    let store = Store::memory().unwrap();
    seed_held(&store, &workspace.to_string_lossy(), "attempt-sys");
    record_stop_trace(
        &store,
        "attempt-sys",
        1,
        json!({
            "operation_id": "operation-recheck-1",
            "bound_pid": 4,
            "bound_creation_date": "/Date(1700000000000)/",
            "bound_executable_sha256": "0".repeat(64)
        }),
    );
    let mut controller = UiController::new(store.clone()).unwrap();
    recheck(&mut controller, "attempt-sys", 1);

    let row = store.latest_recheck_observation("attempt-sys").unwrap().unwrap();
    assert_ne!(
        row.runtime_observation,
        RuntimeObservation::NotRunning,
        "an unobservable process must never be reported as absent; got detail {}",
        row.observation_detail
    );
    assert_eq!(row.verdict, RecheckVerdict::ObservationUnavailable);
}

#[test]
fn no_refusal_path_touches_the_filesystem() {
    // Found by an auditor's probe, not by this suite: `create_dir_all` ran BEFORE the
    // overlap and collision checks, so a continuation refused for overlapping a held
    // workspace had already created its target directory INSIDE that held workspace.
    // The single-use refusal was tested for this; the other three were not, which is
    // how "refusals leave nothing behind" was true of one path and false of three.
    let directory = tempfile::tempdir().unwrap();
    let workspace = directory.path().join("ws");
    let leased = directory.path().join("ws-leased");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::create_dir_all(&leased).unwrap();
    let store = Store::memory().unwrap();
    seed_held(&store, &workspace.to_string_lossy(), "attempt-recheck");
    store
        .insert_attempt(&goalport_core::Attempt::new(
            "attempt-lease-holder",
            "task-recheck",
            "claude",
            "cap-v1",
        ))
        .unwrap();
    store
        .acquire_lease(&goalport_core::WorkspaceLease::new(
            &leased,
            "attempt-lease-holder",
            goalport_core::AccessMode::Mutating,
        ))
        .unwrap();
    let mut controller = UiController::new(store.clone()).unwrap();

    // (a) refused for overlapping the held workspace -- the sharpest case, because the
    //     directory would be created inside the very workspace that is blocked.
    let inside = workspace.join("inner");
    let error = continue_into(&mut controller, "attempt-recheck", &inside, 1).unwrap_err();
    assert!(error.contains("requires a re-check"), "unexpected refusal: {error}");
    assert!(!inside.exists(), "a refusal must not create a directory: {inside:?}");

    recheck_then(&store, &mut controller, "attempt-recheck");
    let error = continue_into(&mut controller, "attempt-recheck", &inside, 2).unwrap_err();
    assert!(
        error.contains("overlaps a held Stop responsibility"),
        "unexpected refusal: {error}"
    );
    assert!(
        !inside.exists(),
        "a continuation refused for overlapping a held workspace must not have created \
         its target inside that held workspace"
    );

    // (b) refused for overlapping a live lease.
    let under_lease = leased.join("nested");
    let error = continue_into(&mut controller, "attempt-recheck", &under_lease, 3).unwrap_err();
    assert!(error.contains("lease"), "unexpected refusal: {error}");
    assert!(!under_lease.exists(), "a lease refusal must not create a directory");

    // Nothing was recorded on any of the three paths.
    assert!(
        store
            .stop_continuations_for_source("attempt-recheck")
            .unwrap()
            .is_empty()
    );
}

#[test]
fn the_refusal_message_is_readable_by_a_person() {
    // The shipped string had two 18-space runs in it -- a Rust line continuation that
    // did not survive an edit. The GUI check matched a substring and the frontend test
    // asserted a hand-written clean copy, so neither side ever compared against what
    // Core actually emits. Assert the real string's shape here, where it is produced.
    let directory = tempfile::tempdir().unwrap();
    let workspace = directory.path().join("ws");
    std::fs::create_dir_all(&workspace).unwrap();
    let store = Store::memory().unwrap();
    seed_held(&store, &workspace.to_string_lossy(), "attempt-recheck");
    let mut controller = UiController::new(store.clone()).unwrap();
    recheck_then(&store, &mut controller, "attempt-recheck");
    continue_into(&mut controller, "attempt-recheck", &directory.path().join("ws-a"), 1).unwrap();
    recheck(&mut controller, "attempt-recheck", 2);
    let message = continue_into(&mut controller, "attempt-recheck", &directory.path().join("ws-b"), 2)
        .unwrap_err();

    assert!(
        !message.contains("  "),
        "the user-visible refusal must not contain runs of whitespace: {message:?}"
    );
    assert!(!message.contains('\n'), "it is rendered on one line: {message:?}");
    assert!(message.contains("already has a continuation"));
    assert!(
        message.contains("continue working there"),
        "a refusal should say what to do instead: {message:?}"
    );
}
