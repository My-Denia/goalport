use goalport_core::{
    Store,
    ipc::{CONNECTED_UI_PROTOCOL_VERSION, CoreServer},
};
use serde_json::{Value, json};

const CHILD_ENV: &str = "GOALPORT_TURN_FAIL_TEST_CHILD";

fn reexec_with_isolation(isolated: bool) -> bool {
    if std::env::var_os(CHILD_ENV).is_some() {
        return false;
    }
    let test_name = std::thread::current()
        .name()
        .expect("cargo names the test thread")
        .to_owned();
    let mut command = std::process::Command::new(std::env::current_exe().unwrap());
    command
        .arg(&test_name)
        .arg("--exact")
        .arg("--nocapture")
        .env(CHILD_ENV, "1")
        .env_remove("GOALPORT_REQUIRE_ISOLATED")
        .env_remove("GOALPORT_TEST_SYNTHETIC_ONLY");
    if isolated {
        command
            .env("GOALPORT_REQUIRE_ISOLATED", "1")
            .env("GOALPORT_TEST_SYNTHETIC_ONLY", "1");
    }
    let output = command.output().expect("controlled marker child");
    assert!(
        output.status.success(),
        "controlled child failed\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    true
}

fn request(id: &str, kind: &str, payload: Value) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "protocolVersion": CONNECTED_UI_PROTOCOL_VERSION,
        "requestId": id,
        "entityVersion": 0,
        "messageType": kind,
        "payload": payload
    }))
    .unwrap()
}

fn call(server: &CoreServer, id: &str, kind: &str, payload: Value) -> Value {
    server.handle_json(&request(id, kind, payload)).unwrap()
}

fn setup() -> (tempfile::TempDir, CoreServer, Store, String, String, String) {
    let workspace = tempfile::tempdir().unwrap();
    let store = Store::memory().unwrap();
    let server = CoreServer::new_synthetic_only(store.clone());
    let created = call(
        &server,
        "turn-fail-create",
        "create_campaign",
        json!({
            "workspaceRoot": workspace.path(),
            "goal": "Scenario turn failure contract",
            "title": "Fail one accepted turn"
        }),
    );
    assert_eq!(created["ok"], true, "{created}");
    let campaign = created["payload"]["snapshot"]["activeCampaignId"]
        .as_str()
        .unwrap()
        .to_owned();
    let task = created["payload"]["snapshot"]["activeTask"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let selected = call(
        &server,
        "turn-fail-select",
        "select_runtime",
        json!({"campaignId": campaign, "taskId": task, "provider": "scenario"}),
    );
    assert_eq!(selected["ok"], true, "{selected}");
    let attempt = selected["payload"]["snapshot"]["attempt"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    (workspace, server, store, campaign, task, attempt)
}

#[test]
fn normal_profile_treats_turn_failure_marker_as_plain_text() {
    if reexec_with_isolation(false) {
        return;
    }
    assert!(std::env::var_os("GOALPORT_REQUIRE_ISOLATED").is_none());
    let (_workspace, server, store, campaign, task, attempt) = setup();
    let response = call(
        &server,
        "normal-turn-fail-send",
        "send_message",
        json!({
            "campaignId": campaign,
            "taskId": task,
            "attemptId": attempt,
            "message": "RC-MARKER-TURN-FAIL"
        }),
    );
    assert_eq!(response["ok"], true, "{response}");
    assert_ne!(response["payload"]["snapshot"]["attempt"]["state"], "failed");
    let kinds = store
        .list_event_records(&attempt, 0)
        .unwrap()
        .into_iter()
        .map(|record| record.event.kind)
        .collect::<Vec<_>>();
    assert!(kinds.iter().any(|kind| kind == "runtime.tool.activity"));
    assert!(kinds.iter().any(|kind| kind == "runtime.turn.completed"));
    assert!(!kinds.iter().any(|kind| kind == "runtime.turn.failed"));
}

#[test]
fn isolated_scenario_turn_failure_is_accepted_failed_and_duplicate_safe() {
    if reexec_with_isolation(true) {
        return;
    }
    assert_eq!(std::env::var("GOALPORT_REQUIRE_ISOLATED").as_deref(), Ok("1"));
    let (_workspace, server, store, campaign, task, attempt) = setup();
    let payload = json!({
        "campaignId": campaign,
        "taskId": task,
        "attemptId": attempt,
        "message": "RC-MARKER-TURN-FAIL"
    });
    let first = call(
        &server,
        "isolated-turn-fail-send",
        "send_message",
        payload.clone(),
    );
    assert_eq!(first["ok"], true, "{first}");
    assert_eq!(first["payload"]["duplicate"], false);
    assert_eq!(first["payload"]["snapshot"]["attempt"]["state"], "failed");
    let before = store.list_event_records(&attempt, 0).unwrap();
    assert_eq!(
        before
            .iter()
            .filter(|record| record.event.kind == "message.user")
            .count(),
        1
    );
    assert_eq!(
        before
            .iter()
            .filter(|record| record.event.kind == "runtime.turn.failed")
            .count(),
        1
    );
    assert!(!before.iter().any(|record| record.event.kind == "runtime.tool.activity"));
    assert!(!before.iter().any(|record| record.event.kind == "runtime.waiting"));

    let duplicate = call(
        &server,
        "isolated-turn-fail-send",
        "send_message",
        payload,
    );
    assert_eq!(duplicate["ok"], true, "{duplicate}");
    assert_eq!(duplicate["payload"]["duplicate"], true);
    assert_eq!(store.list_event_records(&attempt, 0).unwrap(), before);
}
