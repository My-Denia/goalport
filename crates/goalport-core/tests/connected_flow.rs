use goalport_core::{
    Attempt, Command, CommandState, Event, OutboxIntent, OutboxState,
    ipc::{CONNECTED_UI_PROTOCOL_VERSION, CoreServer},
    store::Store,
};
use serde_json::{Value, json};

fn wire(id: &str, kind: &str, payload: Value) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "protocolVersion": CONNECTED_UI_PROTOCOL_VERSION,
        "requestId": id,
        "entityVersion": 0,
        "messageType": kind,
        "payload": payload
    }))
    .unwrap()
}

fn result(server: &CoreServer, id: &str, kind: &str, payload: Value) -> Value {
    server.handle_json(&wire(id, kind, payload)).unwrap()
}

fn view(response: Value) -> Value {
    response["payload"]["snapshot"].clone()
}

fn select(server: &CoreServer, id: &str) -> Value {
    view(result(
        server,
        id,
        "select_runtime",
        json!({
            "campaignId": "campaign-synthetic-preview",
            "taskId": "task-synthetic-preview",
            "provider": "scenario"
        }),
    ))
}

#[test]
fn connected_send_persists_reply_tool_waiting_before_terminal_state() {
    let server = CoreServer::new(Store::memory().unwrap());
    let selected = select(&server, "flow-runtime");
    let attempt = selected["attempt"]["id"].as_str().unwrap();
    let response = result(
        &server,
        "flow-send",
        "send_message",
        json!({
            "campaignId": "campaign-synthetic-preview", "taskId": "task-synthetic-preview", "attemptId": attempt, "message": "connected flow"
        }),
    );
    let snapshot = view(response);
    let timeline = snapshot["timeline"].as_array().unwrap();
    let tool = timeline
        .iter()
        .position(|item| item["kind"] == "tool")
        .unwrap();
    let waiting = timeline
        .iter()
        .position(|item| item["kind"] == "recovery")
        .unwrap();
    let terminal = timeline
        .iter()
        .rposition(|item| item["title"] == "Attempt state updated")
        .unwrap();
    assert!(tool > 0 && waiting > tool && terminal > waiting);
    assert_eq!(snapshot["attempt"]["id"], attempt);
    assert_eq!(snapshot["attempt"]["state"], "waiting");
}

#[test]
fn permission_request_is_projected_and_gui_decision_is_durable() {
    let server = CoreServer::new(Store::memory().unwrap());
    let selected = select(&server, "permission-runtime");
    let attempt = selected["attempt"]["id"].as_str().unwrap();
    let pending = view(result(
        &server,
        "permission-send",
        "send_message",
        json!({
            "campaignId": "campaign-synthetic-preview", "taskId": "task-synthetic-preview", "attemptId": attempt, "message": "permission write check"
        }),
    ));
    let decision = pending["decisions"].as_array().unwrap().first().unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(pending["decisions"][0]["state"], "pending");
    let resolved = view(result(
        &server,
        "permission-deny",
        "permission_response",
        json!({
            "decisionId": decision, "allow": false
        }),
    ));
    assert_eq!(resolved["decisions"][0]["state"], "resolved");
    assert!(
        resolved["timeline"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["kind"] == "permission")
    );
}

#[test]
fn permission_decision_stays_pending_when_native_callback_is_unavailable() {
    use goalport_core::{Decision, DecisionState};

    let store = Store::memory().unwrap();
    let server = CoreServer::new(store.clone());
    store
        .insert_decision(&Decision {
            id: "native-callback-missing".into(),
            attempt_id: "attempt-scenario-preview".into(),
            kind: "permission".into(),
            state: DecisionState::Pending,
        })
        .unwrap();
    let response = result(
        &server,
        "permission-callback-missing",
        "permission_response",
        json!({ "decisionId": "native-callback-missing", "allow": true }),
    );
    assert_eq!(response["ok"], false);
    assert!(
        response["error"]
            .as_str()
            .unwrap()
            .contains("not delivered")
    );
    assert_eq!(
        store.get_decision("native-callback-missing").unwrap().state,
        DecisionState::Pending
    );
}

#[test]
fn safe_stop_records_cancelled_attempt_without_host_state_invention() {
    let server = CoreServer::new(Store::memory().unwrap());
    let selected = select(&server, "stop-runtime");
    let attempt = selected["attempt"]["id"].as_str().unwrap();
    let stopped = view(result(
        &server,
        "safe-stop",
        "safe_stop",
        json!({ "attemptId": attempt }),
    ));
    assert_eq!(stopped["attempt"]["id"], attempt);
    assert_eq!(stopped["attempt"]["state"], "failed");
    assert!(
        stopped["timeline"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["status"] == "FAILED")
    );
}

#[test]
fn reconnect_cursor_backfills_only_committed_events_and_does_not_resend_prompt() {
    let server = CoreServer::new(Store::memory().unwrap());
    let selected = select(&server, "reconnect-runtime");
    let attempt = selected["attempt"]["id"].as_str().unwrap();
    let cursor = selected["cursor"].as_i64().unwrap();
    let sent = view(result(
        &server,
        "reconnect-send",
        "send_message",
        json!({
            "campaignId": "campaign-synthetic-preview", "taskId": "task-synthetic-preview", "attemptId": attempt, "message": "one committed prompt"
        }),
    ));
    let backfill = view(result(
        &server,
        "reconnect",
        "reconnect",
        json!({ "cursor": cursor }),
    ));
    let events = backfill["timeline"].as_array().unwrap();
    assert!(!events.is_empty());
    assert!(
        events
            .iter()
            .all(|event| event["cursor"].as_i64().unwrap() > cursor)
    );
    let sent_count = sent["attempt"]["eventCount"].as_u64().unwrap();
    let backfill_count = backfill["attempt"]["eventCount"].as_u64().unwrap();
    assert!(
        backfill_count >= sent_count,
        "reconnect may append ui.reconnected but must not drop committed events"
    );
    assert!(
        events
            .iter()
            .any(|event| event["body"] == "ui.reconnected" || event["kind"] == "recovery")
    );
    let duplicate = result(
        &server,
        "reconnect-send",
        "send_message",
        json!({
            "campaignId": "campaign-synthetic-preview", "taskId": "task-synthetic-preview", "attemptId": attempt, "message": "one committed prompt"
        }),
    );
    assert_eq!(duplicate["payload"]["duplicate"], true);
    assert_eq!(
        view(duplicate)["attempt"]["eventCount"],
        backfill["attempt"]["eventCount"]
    );
}

#[test]
fn invalid_attempt_and_campaign_references_are_rejected_by_core() {
    let server = CoreServer::new(Store::memory().unwrap());
    let response = result(
        &server,
        "bad-send",
        "send_message",
        json!({
            "campaignId": "campaign-synthetic-preview", "taskId": "task-synthetic-preview", "attemptId": "missing-attempt", "message": "must fail"
        }),
    );
    assert_eq!(response["ok"], false);
    let bad_runtime = result(
        &server,
        "bad-runtime",
        "select_runtime",
        json!({
            "campaignId": "missing-campaign", "taskId": "task-synthetic-preview", "provider": "scenario"
        }),
    );
    assert_eq!(bad_runtime["ok"], false);
}

#[test]
fn handoff_creates_distinct_attempt_and_retains_old_history() {
    let server = CoreServer::new(Store::memory().unwrap());
    let selected = select(&server, "handoff-runtime");
    let old_attempt = selected["attempt"]["id"].as_str().unwrap().to_string();
    let sent = view(result(
        &server,
        "handoff-send",
        "send_message",
        json!({
            "campaignId": "campaign-synthetic-preview", "taskId": "task-synthetic-preview", "attemptId": old_attempt, "message": "handoff source"
        }),
    ));
    let new = view(result(
        &server,
        "handoff",
        "handoff",
        json!({ "oldAttemptId": old_attempt, "provider": "scenario" }),
    ));
    assert_ne!(new["attempt"]["id"], sent["attempt"]["id"]);
    assert_eq!(new["attempt"]["taskId"], "task-synthetic-preview");
    assert!(
        new["timeline"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["kind"] == "attempt")
    );
}

#[test]
fn handoff_instruction_is_submitted_from_core_packet_without_manual_copy() {
    let server = CoreServer::new(Store::memory().unwrap());
    let selected = select(&server, "handoff-packet-runtime");
    let old_attempt = selected["attempt"]["id"].as_str().unwrap().to_string();
    let source = view(result(
        &server,
        "handoff-packet-source",
        "send_message",
        json!({
            "campaignId": "campaign-synthetic-preview",
            "taskId": "task-synthetic-preview",
            "attemptId": old_attempt,
            "message": "source responsibility"
        }),
    ));
    let handoff = view(result(
        &server,
        "handoff-packet",
        "handoff",
        json!({
            "oldAttemptId": source["attempt"]["id"],
            "provider": "scenario",
            "authorization": "test-owner-request",
            "authorizationManifest": "test-manifest",
            "handoffInstruction": "Reply with the next safe step."
        }),
    ));
    assert_ne!(handoff["attempt"]["id"], source["attempt"]["id"]);
    assert!(handoff["attempt"]["sessionHash"].as_str().is_some());
    assert!(handoff["timeline"].as_array().unwrap().iter().any(|item| {
        item["kind"] == "handoff" && item["body"] == "Core handoff packet committed"
    }));
    assert!(handoff["timeline"].as_array().unwrap().iter().any(|item| {
        item["kind"] == "message"
            && item["body"]
                .as_str()
                .unwrap_or_default()
                .contains("Handoff instruction")
    }));
}

#[test]
fn handoff_does_not_create_attempt_when_native_stop_is_unconfirmed() {
    let store = Store::memory().unwrap();
    let server = CoreServer::new(store.clone());
    store
        .insert_attempt(&Attempt::new(
            "active-native",
            "task-synthetic-preview",
            "codex",
            "codex-cap-v1",
        ))
        .unwrap();
    store
        .append_event(&Event {
            id: "active-native-event".into(),
            attempt_id: "active-native".into(),
            seq: 1,
            kind: "attempt.active".into(),
            payload_ref: None,
        })
        .unwrap();
    let before = store.counts().unwrap().attempts;
    let response = result(
        &server,
        "blocked-handoff",
        "handoff",
        json!({ "oldAttemptId": "active-native", "provider": "claude" }),
    );
    assert_eq!(response["ok"], false);
    assert!(
        response["error"]
            .as_str()
            .unwrap()
            .contains("Runtime has not been selected")
    );
    assert_eq!(store.counts().unwrap().attempts, before);
}

#[test]
fn handoff_does_not_create_attempt_with_unknown_external_effect() {
    let store = Store::memory().unwrap();
    let server = CoreServer::new(store.clone());
    let selected = select(&server, "handoff-outbox-runtime");
    let old_attempt = selected["attempt"]["id"].as_str().unwrap();
    store
        .record_command(&Command {
            id: "handoff-effect-command".into(),
            attempt_id: old_attempt.into(),
            kind: "external-effect".into(),
            payload_hash: "hash".into(),
            state: CommandState::Pending,
        })
        .unwrap();
    store
        .insert_outbox(&OutboxIntent {
            id: "handoff-effect".into(),
            command_id: "handoff-effect-command".into(),
            effect_kind: "workspace-write".into(),
            target: "synthetic://effect".into(),
            state: OutboxState::Unknown,
        })
        .unwrap();
    let response = result(
        &server,
        "blocked-unknown-effect",
        "handoff",
        json!({ "oldAttemptId": old_attempt, "provider": "scenario" }),
    );
    assert_eq!(response["ok"], false);
    assert!(
        response["error"]
            .as_str()
            .unwrap()
            .contains("external effect")
    );
    assert_eq!(
        store
            .attempts_for_task("task-synthetic-preview")
            .unwrap()
            .iter()
            .filter(|attempt| attempt.id.contains("handoff"))
            .count(),
        0
    );
}

#[test]
fn resource_pressure_persists_queued_request_and_override_admits_it() {
    let server = CoreServer::new(Store::memory().unwrap());
    let first = select(&server, "res-existing");
    let existing = first["attempt"]["id"].as_str().unwrap().to_string();
    let queued = view(result(
        &server,
        "res-queue",
        "select_runtime",
        json!({
            "campaignId": "campaign-synthetic-preview",
            "taskId": "task-synthetic-preview",
            "provider": "scenario",
            "attemptId": "attempt-queued-res01",
            "resourcePressure": true
        }),
    ));
    assert_eq!(queued["attempt"]["id"], existing);
    let notices = queued["notices"].as_array().unwrap();
    let queue_id = notices
        .iter()
        .filter_map(|item| item.as_str())
        .find_map(|text| text.strip_prefix("Queued under resource pressure: "))
        .expect("queued admission id");
    let admitted = view(result(
        &server,
        "res-override",
        "queue_override",
        json!({ "queueId": queue_id, "reason": "explicit-owner-override" }),
    ));
    assert_eq!(admitted["attempt"]["id"], "attempt-queued-res01");
}
