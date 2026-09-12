use goalport_core::{
    Store,
    ipc::UiCommandRequest,
    product_receipts::{begin_startup_epoch, complete_startup_epoch, launch_ready_path},
    projection::UiController,
};
use serde_json::json;
use std::{env, sync::Mutex};

static ENV_LOCK: Mutex<()> = Mutex::new(());

fn ui(message_type: &str, payload: serde_json::Value) -> UiCommandRequest {
    UiCommandRequest {
        protocol_version: "goalport.ipc.v2".into(),
        request_id: format!("test-{message_type}"),
        entity_version: 0,
        message_type: message_type.into(),
        payload,
    }
}

#[test]
fn startup_receipt_persists_before_launch_ready_file() {
    let _guard = ENV_LOCK.lock().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("core.sqlite");
    let store = Store::open(&db).unwrap();
    unsafe {
        env::set_var(
            "GOALPORT_LAUNCH_NONCE",
            "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        );
        env::set_var("GOALPORT_RUN_SLUG", "goalport-resume-chain-collect-b");
        env::set_var("GOALPORT_ELECTRON_PID", "10");
        env::set_var("GOALPORT_ELECTRON_CREATED_MS", "1000");
        env::set_var("GOALPORT_ELECTRON_EXE", "C:\\pkg\\GoalPort.exe");
        env::set_var("GOALPORT_ELECTRON_SHA256", "aa");
        env::set_var("GOALPORT_LAUNCHER_PID", "20");
        env::set_var("GOALPORT_LAUNCHER_CREATED_MS", "1100");
        env::set_var(
            "GOALPORT_LAUNCHER_EXE",
            "C:\\pkg\\goalport-core-launcher.exe",
        );
        env::set_var("GOALPORT_LAUNCHER_SHA256", "bb");
        env::set_var("GOALPORT_LAUNCHER_PARENT_PID", "10");
        env::set_var("GOALPORT_LAUNCH_REQUESTED_AT", "2026-09-02T00:00:00.000Z");
        env::set_var("GOALPORT_LAUNCHER_STARTED_AT", "2026-09-02T00:00:00.010Z");
        env::set_var("GOALPORT_CORE_SPAWNED_AT", "2026-09-02T00:00:00.020Z");
        env::remove_var("GOALPORT_REQUIRE_ISOLATED");
    }
    let claim = begin_startup_epoch(&store, r"\\.\pipe\collect-b-obs", &db).unwrap();
    assert!(store.latest_product_receipt("startup").unwrap().is_none());
    let payload = complete_startup_epoch(
        &store,
        r"\\.\pipe\collect-b-obs",
        &db,
        &claim,
        &json!({"status":"completed","commandsUnknown":0,"outboxUnknown":0,"leasesUncertain":0,"runtimeAttachment":"UNKNOWN_OR_UNSUPPORTED","promptReplay":false}),
    )
    .unwrap();
    assert_eq!(
        payload["launchNonce"],
        "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
    );
    assert_eq!(payload["launcher"]["observedParentPid"], 10);
    assert_eq!(payload["startupState"], "READY_COMMITTED");
    assert_eq!(payload["epochState"], "READY_COMMITTED");
    assert!(payload["core"]["pid"].as_u64().unwrap() > 0);
    assert_eq!(
        payload["coreEpochId"],
        "core-epoch:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
    );
    assert!(launch_ready_path(&db).is_file());
    let ready = store
        .latest_product_receipt("launch-ready")
        .unwrap()
        .unwrap();
    assert_eq!(ready["readyState"], "READY_COMMITTED");
    assert_eq!(ready["startupReceiptId"], payload["startupReceiptId"]);
    assert_eq!(ready["coreEpochId"], payload["coreEpochId"]);
    assert_eq!(
        store.latest_core_launch_epoch().unwrap().unwrap().state,
        "READY_COMMITTED"
    );
    let loaded = store
        .get_product_receipt_by_nonce("startup", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")
        .unwrap()
        .unwrap();
    assert_eq!(loaded["runSlug"], "goalport-resume-chain-collect-b");
    let duplicate = begin_startup_epoch(&store, r"\\.\pipe\collect-b-obs", &db).unwrap_err();
    assert!(duplicate.contains("duplicate or replayed"), "{duplicate}");
    unsafe {
        env::set_var(
            "GOALPORT_LAUNCH_NONCE",
            "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        );
    }
    let live = begin_startup_epoch(&store, r"\\.\pipe\collect-b-obs", &db).unwrap_err();
    assert!(live.contains("still live"), "{live}");
    assert_eq!(store.list_core_launch_epochs().unwrap().len(), 1);
}

#[test]
fn isolated_serve_without_nonce_is_rejected() {
    let _guard = ENV_LOCK.lock().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("core.sqlite");
    let store = Store::open(&db).unwrap();
    unsafe {
        env::remove_var("GOALPORT_LAUNCH_NONCE");
        env::set_var("GOALPORT_REQUIRE_ISOLATED", "1");
    }
    let error = begin_startup_epoch(&store, "pipe", &db).unwrap_err();
    unsafe {
        env::remove_var("GOALPORT_REQUIRE_ISOLATED");
    }
    assert!(error.contains("GOALPORT_LAUNCH_NONCE"));
}

#[test]
fn record_close_choice_persists_receipt_and_event() {
    let store = Store::open_in_memory().unwrap();
    let mut controller = UiController::new_seeded_fixture(
        store.clone(),
        "synthetic://goalport-fixture",
    )
    .unwrap();
    let snapshot = controller
        .handle(ui("snapshot", json!({})))
        .unwrap()
        .snapshot;
    let selected = controller
        .handle(ui(
            "select_runtime",
            json!({
                "projectId": snapshot.selected_project_id,
                "campaignId": snapshot.active_campaign_id,
                "taskId": snapshot.active_task.id,
                "provider": "scenario"
            }),
        ))
        .unwrap()
        .snapshot;
    let result = controller
        .handle(ui(
            "record_close_choice",
            json!({
                "requestId": "req-continue-1",
                "choice": "continue",
                "attemptId": selected.attempt.id,
                "campaignId": selected.active_campaign_id,
                "uiPid": 10,
                "uiCreatedMs": 1000,
                "mainReceivedAtUtc": "2026-09-02T00:00:04.150Z"
            }),
        ))
        .unwrap();
    let receipt = result.receipt.expect("receipt");
    assert_eq!(receipt["choice"], "continue-background");
    assert_eq!(receipt["requestId"], "req-continue-1");
    assert!(receipt["receiptId"].as_str().unwrap().starts_with("rcpt-"));
    let events = store.list_event_records(&selected.attempt.id, 0).unwrap();
    assert!(events.iter().any(|row| row.event.kind == "ui.close_choice"));
    let again = controller
        .handle(ui(
            "record_close_choice",
            json!({
                "requestId": "req-continue-1",
                "choice": "continue",
                "attemptId": selected.attempt.id
            }),
        ))
        .unwrap();
    assert_eq!(again.duplicate, true);
    assert_eq!(again.receipt.unwrap()["receiptId"], receipt["receiptId"]);
}

#[test]
fn record_close_choice_without_attempt_fails() {
    let store = Store::open_in_memory().unwrap();
    let mut controller = UiController::new(store).unwrap();
    let error = controller
        .handle(ui(
            "record_close_choice",
            json!({
                "requestId": "req-missing",
                "choice": "continue"
            }),
        ))
        .unwrap_err();
    assert!(error.contains("attemptId"));
}
