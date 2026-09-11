use goalport_core::{
    ipc::{CONNECTED_UI_PROTOCOL_VERSION, CoreServer},
    store::Store,
};
use serde_json::{Value, json};

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

fn snapshot(response: Value) -> Value {
    response["payload"]["snapshot"].clone()
}

#[test]
fn full_projection_snapshot_wire_contains_core_owned_identity() {
    let server = CoreServer::new(Store::memory().unwrap());
    let value = server
        .handle_json(&request("snapshot-1", "snapshot", json!({})))
        .unwrap();
    assert_eq!(value["ok"], true);
    assert_eq!(value["protocolVersion"], CONNECTED_UI_PROTOCOL_VERSION);
    let view = snapshot(value);
    for field in [
        "project",
        "projects",
        "campaigns",
        "activeTask",
        "attempt",
        "timeline",
        "runtimes",
        "decisions",
        "evidence",
        "cursor",
    ] {
        assert!(
            view.get(field).is_some(),
            "missing projection field {field}"
        );
    }
    assert_eq!(view["project"]["id"], "project-synthetic");
    assert_eq!(view["attempt"]["taskId"], view["activeTask"]["id"]);
    let build_id = view["buildId"].as_str().unwrap();
    assert_eq!(build_id.len(), 64);
    assert!(
        build_id
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    );
}

#[test]
fn create_select_send_and_duplicate_preserve_campaign_task_attempt_ids() {
    let server = CoreServer::new(Store::memory().unwrap());
    let created = server
        .handle_json(&request(
            "create-1",
            "create_campaign_with_task",
            json!({
                "projectId": "project-synthetic",
                "goal": "Connected projection integration",
                "title": "Wire identities",
                "acceptance": "identity continuity"
            }),
        ))
        .unwrap();
    assert_eq!(created["ok"], true);
    let created_view = snapshot(created);
    let campaign_id = created_view["activeCampaignId"].as_str().unwrap();
    let task_id = created_view["activeTask"]["id"].as_str().unwrap();
    let selected = server
        .handle_json(&request(
            "runtime-1",
            "select_runtime",
            json!({
                "projectId": "project-synthetic",
                "campaignId": campaign_id,
                "taskId": task_id,
                "provider": "scenario"
            }),
        ))
        .unwrap();
    let selected_view = snapshot(selected);
    let attempt_id = selected_view["attempt"]["id"].as_str().unwrap();
    assert_eq!(selected_view["attempt"]["taskId"], task_id);
    assert_eq!(selected_view["activeCampaignId"], campaign_id);

    let sent_request = request(
        "send-1",
        "send_message",
        json!({
            "campaignId": campaign_id,
            "taskId": task_id,
            "attemptId": attempt_id,
            "message": "show a tool and waiting checkpoint"
        }),
    );
    let sent = server.handle_json(&sent_request).unwrap();
    assert_eq!(sent["ok"], true);
    assert_eq!(sent["payload"]["duplicate"], false);
    let sent_view = snapshot(sent);
    assert_eq!(sent_view["attempt"]["id"], attempt_id);
    assert!(
        sent_view["timeline"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["kind"] == "tool")
    );
    assert!(
        sent_view["timeline"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["kind"] == "recovery")
    );

    let duplicate = server.handle_json(&sent_request).unwrap();
    assert_eq!(duplicate["ok"], true);
    assert_eq!(duplicate["payload"]["duplicate"], true);
    assert_eq!(
        duplicate["payload"]["snapshot"]["attempt"]["id"],
        attempt_id
    );
    assert_eq!(
        duplicate["payload"]["snapshot"]["timeline"]
            .as_array()
            .unwrap()
            .len(),
        sent_view["timeline"].as_array().unwrap().len()
    );
}

#[test]
fn invalid_project_and_cross_campaign_task_fail_closed() {
    let server = CoreServer::new(Store::memory().unwrap());
    let missing = server
        .handle_json(&request(
            "project-missing",
            "select_project",
            json!({ "projectId": "missing" }),
        ))
        .unwrap();
    assert_eq!(missing["ok"], false);
    assert!(missing["error"].as_str().unwrap().contains("project"));

    let seed = snapshot(
        server
            .handle_json(&request("snapshot-2", "snapshot", json!({})))
            .unwrap(),
    );
    let task_id = seed["activeTask"]["id"].as_str().unwrap();
    let other = server
        .handle_json(&request(
            "create-other",
            "create_campaign_with_task",
            json!({ "projectId": "project-synthetic", "goal": "Other campaign", "title": "Other task" }),
        ))
        .unwrap();
    let other_view = snapshot(other);
    let cross = server
        .handle_json(&request(
            "cross-task",
            "select_runtime",
            json!({ "campaignId": other_view["activeCampaignId"], "taskId": task_id, "provider": "scenario" }),
        ))
        .unwrap();
    assert_eq!(cross["ok"], false);
}

#[test]
fn ui_command_round_trip_returns_versioned_envelope_and_request_id() {
    let server = CoreServer::new(Store::memory().unwrap());
    let response = server
        .handle_json(&request("round-trip", "snapshot", json!({})))
        .unwrap();
    assert_eq!(response["protocolVersion"], CONNECTED_UI_PROTOCOL_VERSION);
    assert_eq!(response["requestId"], "round-trip");
    assert_eq!(response["payload"]["accepted"], true);
    assert_eq!(response["payload"]["requestId"], "round-trip");
}

#[test]
fn atomic_campaign_task_creation_returns_related_ids() {
    let server = CoreServer::new(Store::memory().unwrap());
    let view = snapshot(
        server
            .handle_json(&request(
                "atomic",
                "create_campaign_with_task",
                json!({
                    "projectId": "project-synthetic", "goal": "atomic", "title": "root"
                }),
            ))
            .unwrap(),
    );
    let campaign_id = view["activeCampaignId"].as_str().unwrap();
    let task_id = view["activeTask"]["id"].as_str().unwrap();
    assert!(!campaign_id.is_empty());
    assert!(!task_id.is_empty());
    let campaign = view["campaigns"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == campaign_id)
        .unwrap();
    assert_eq!(campaign["projectId"], "project-synthetic");
}

#[test]
fn core_reopen_preserves_selected_projection_identity() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("connected.sqlite");
    let first = CoreServer::new(Store::open(&path).unwrap());
    let view = snapshot(
        first
            .handle_json(&request(
                "reopen-create",
                "create_campaign_with_task",
                json!({
                    "projectId": "project-synthetic", "goal": "reopen", "title": "reopen task"
                }),
            ))
            .unwrap(),
    );
    let campaign_id = view["activeCampaignId"].as_str().unwrap().to_string();
    let task_id = view["activeTask"]["id"].as_str().unwrap().to_string();
    drop(first);
    let second = CoreServer::new(Store::open(&path).unwrap());
    let reopened = snapshot(
        second
            .handle_json(&request("reopen-snapshot", "snapshot", json!({})))
            .unwrap(),
    );
    assert_eq!(reopened["activeCampaignId"], campaign_id);
    assert_eq!(reopened["activeTask"]["id"], task_id);
    assert_eq!(reopened["attempt"]["taskId"], task_id);
}

#[test]
fn event_payload_commit_and_cursor_are_visible_in_projection() {
    let server = CoreServer::new(Store::memory().unwrap());
    let selected = snapshot(server.handle_json(&request("event-runtime", "select_runtime", json!({
        "provider": "scenario", "campaignId": "campaign-synthetic-preview", "taskId": "task-synthetic-preview"
    }))).unwrap());
    let attempt = selected["attempt"]["id"].as_str().unwrap();
    let response = server.handle_json(&request("event-send", "send_message", json!({
        "campaignId": "campaign-synthetic-preview", "taskId": "task-synthetic-preview", "attemptId": attempt, "message": "payload test"
    }))).unwrap();
    let view = snapshot(response);
    let events = view["timeline"].as_array().unwrap();
    assert!(view["cursor"].as_i64().unwrap() >= 2);
    assert!(events.iter().any(|item| item["body"] == "payload test"));
    assert!(
        events
            .iter()
            .all(|item| item["cursor"].as_i64().unwrap() > 0)
    );
    assert!(events.iter().any(|item| item["kind"] == "tool"));
}

#[test]
fn duplicate_send_request_does_not_add_a_second_user_event() {
    let server = CoreServer::new(Store::memory().unwrap());
    let selected = snapshot(server.handle_json(&request("dup-runtime", "select_runtime", json!({
        "provider": "scenario", "campaignId": "campaign-synthetic-preview", "taskId": "task-synthetic-preview"
    }))).unwrap());
    let attempt = selected["attempt"]["id"].as_str().unwrap();
    let payload = json!({ "campaignId": "campaign-synthetic-preview", "taskId": "task-synthetic-preview", "attemptId": attempt, "message": "once" });
    let first = snapshot(
        server
            .handle_json(&request("dup-send", "send_message", payload.clone()))
            .unwrap(),
    );
    let second_response = server
        .handle_json(&request("dup-send", "send_message", payload))
        .unwrap();
    let second = snapshot(second_response.clone());
    assert_eq!(second_response["payload"]["duplicate"], true);
    assert_eq!(
        second["timeline"].as_array().unwrap().len(),
        first["timeline"].as_array().unwrap().len()
    );
    assert_eq!(
        second["attempt"]["eventCount"],
        first["attempt"]["eventCount"]
    );
}

#[test]
fn reused_send_request_id_with_changed_prompt_is_rejected() {
    let server = CoreServer::new(Store::memory().unwrap());
    let selected = snapshot(
        server
            .handle_json(&request(
                "conflict-runtime",
                "select_runtime",
                json!({ "provider": "scenario", "campaignId": "campaign-synthetic-preview", "taskId": "task-synthetic-preview" }),
            ))
            .unwrap(),
    );
    let payload = json!({ "campaignId": "campaign-synthetic-preview", "taskId": "task-synthetic-preview", "attemptId": selected["attempt"]["id"], "message": "first" });
    assert_eq!(
        server
            .handle_json(&request("conflict-send", "send_message", payload))
            .unwrap()["ok"],
        true
    );
    let conflict = server
        .handle_json(&request(
            "conflict-send",
            "send_message",
            json!({ "campaignId": "campaign-synthetic-preview", "taskId": "task-synthetic-preview", "attemptId": selected["attempt"]["id"], "message": "changed" }),
        ))
        .unwrap();
    assert_eq!(conflict["ok"], false);
    assert!(
        conflict["error"]
            .as_str()
            .unwrap()
            .contains("different content")
    );
}

#[test]
fn select_project_switches_core_owned_project_without_host_fallback() {
    let store = Store::memory().unwrap();
    store
        .insert_project(&goalport_core::Project {
            id: "project-second".into(),
            workspace_root: "synthetic://second".into(),
        })
        .unwrap();
    let server = CoreServer::new(store);
    let switched = server
        .handle_json(&request(
            "project-select",
            "select_project",
            json!({ "projectId": "project-second" }),
        ))
        .unwrap();
    assert_eq!(switched["ok"], true);
    let view = snapshot(switched);
    assert_eq!(view["selectedProjectId"], "project-second");
    assert_eq!(view["project"]["id"], "project-second");
}

#[test]
fn runtime_selection_creates_attempt_and_session_under_core_identity() {
    let server = CoreServer::new(Store::memory().unwrap());
    let value = server.handle_json(&request("runtime-select", "select_runtime", json!({
        "provider": "scenario", "campaignId": "campaign-synthetic-preview", "taskId": "task-synthetic-preview"
    }))).unwrap();
    let view = snapshot(value);
    assert_eq!(view["attempt"]["provider"], "scenario");
    assert_eq!(view["attempt"]["taskId"], "task-synthetic-preview");
    assert!(view["attempt"]["eventCount"].as_u64().unwrap() >= 2);
    assert!(
        view["timeline"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["body"].as_str().unwrap_or("").contains("session"))
    );
}
