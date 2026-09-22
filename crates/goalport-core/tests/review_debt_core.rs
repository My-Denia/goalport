use goalport_core::{
    Attempt, AttemptState, Campaign, CampaignAuthorization, ConversationPrepareOutcome,
    ConversationRequestPhase, ConversationStart, CoreCommand, CoreOperation, CoreServer, Event,
    HistoryDirection, IpcRequest, Project, Store, Task, WorkStatus,
    history::conversation_page,
    response_bounds::{MAX_CAPACITY_ACK_BYTES, bound_ui_response},
};
use serde_json::{Value, json};

fn ui_wire(request_id: &str, message_type: &str, payload: Value) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "protocolVersion": "goalport.ipc.v2",
        "requestId": request_id,
        "entityVersion": 1,
        "messageType": message_type,
        "payload": payload
    }))
    .unwrap()
}

#[test]
fn oversized_request_identity_is_rejected_before_any_store_mutation() {
    let store = Store::memory().unwrap();
    let server = CoreServer::new(store.clone());
    let before = store.counts().unwrap();
    let request_id = "r".repeat(257);
    let error = server
        .handle_json(&ui_wire(&request_id, "snapshot", json!({})))
        .unwrap_err();
    assert!(error.to_string().contains("256 bytes"));
    assert_eq!(store.counts().unwrap(), before);
}

#[test]
fn long_native_identity_is_allowed_but_goalport_entity_ids_fail_before_mutation() {
    let store = Store::memory().unwrap();
    let server = CoreServer::new(store.clone());
    let native = "native-opaque-".repeat(100);
    let accepted = server
        .handle_json(&ui_wire(
            "native-positive",
            "snapshot",
            json!({"nativeSessionId": native}),
        ))
        .unwrap();
    assert_eq!(accepted["ok"], true);
    let before = store.counts().unwrap();
    let error = server
        .handle_json(&ui_wire(
            "entity-negative",
            "snapshot",
            json!({"campaignId": "c".repeat(257)}),
        ))
        .unwrap_err();
    assert!(error.to_string().contains("campaignId exceeds 256 bytes"));
    assert_eq!(store.counts().unwrap(), before);
}

#[test]
fn invalid_legacy_header_never_echoes_an_unbounded_request_id() {
    let store = Store::memory().unwrap();
    let server = CoreServer::new(store.clone());
    let command = CoreCommand::new(
        "command-1",
        "attempt-1",
        CoreOperation::TransitionAttempt {
            attempt_id: "attempt-1".into(),
            state: AttemptState::Active,
            event_id: "event-1".into(),
        },
    )
    .unwrap();
    let mut request = IpcRequest::new("r".repeat(1024 * 1024), command);
    request.entity_version = 1;
    let response = server.handle(request);
    assert!(!response.ok);
    assert!(response.request_id.is_empty());
    assert!(serde_json::to_vec(&response).unwrap().len() < 64 * 1024);
    assert_eq!(store.counts().unwrap().commands, 0);
}

#[test]
fn unstructured_ui_failure_is_typed_unknown_and_same_id_reconcile_only() {
    let workspace = tempfile::tempdir().unwrap();
    let server = CoreServer::new(Store::memory().unwrap());
    let response = server
        .handle_json(&ui_wire(
            "typed-rejection-1",
            "start_conversation",
            json!({
                "workspaceRoot": workspace.path().to_string_lossy(),
                "provider": "not-a-provider",
                "message": "hello"
            }),
        ))
        .unwrap();
    assert_eq!(response["ok"], false);
    assert_eq!(response["payload"]["requestId"], "typed-rejection-1");
    assert_eq!(response["payload"]["accepted"], false);
    assert!(response["payload"]["snapshot"].is_object());
    assert_eq!(response["payload"]["rejection"]["deliveryState"], "UNKNOWN");
    assert_eq!(
        response["payload"]["rejection"]["nativeDispatchState"],
        "UNKNOWN"
    );
    assert_eq!(response["payload"]["rejection"]["retryMode"], "RECONCILE");
    assert!(response["payload"]["rejection"]["reservation"].is_null());
}

#[test]
fn predispatch_first_send_rearm_preserves_reserved_message_and_attempt_history() {
    let store = Store::memory().unwrap();
    let request_id = "first-rearm-1";
    let start = ConversationStart {
        request_id: request_id.into(),
        payload_hash: "payload-hash".into(),
        claim_token: "claim-1".into(),
        native_command_id: "ui-send-first-rearm-1".into(),
        project: Project {
            id: "project-rearm".into(),
            workspace_root: "C:/work/rearm".into(),
        },
        campaign: Campaign {
            id: "campaign-rearm".into(),
            goal: "goal".into(),
            root_task_id: "task-rearm".into(),
            state: WorkStatus::InProgress,
        },
        task: Task {
            id: "task-rearm".into(),
            campaign_id: "campaign-rearm".into(),
            title: "goal".into(),
            acceptance: "done".into(),
            state: WorkStatus::InProgress,
        },
        policy_id: "policy-rearm".into(),
        policy_payload_json: "{}".into(),
        authorization: CampaignAuthorization::granted(),
        attempt: Attempt::new("attempt-rearm", "task-rearm", "scenario", "scenario-cap-v1"),
        selected_provider: "scenario".into(),
        first_user_message: "reserved once".into(),
    };
    assert!(matches!(
        store.prepare_conversation_start(&start).unwrap(),
        ConversationPrepareOutcome::Prepared { .. }
    ));
    store
        .claim_conversation_request(request_id, "claim-1")
        .unwrap();
    store
        .finish_conversation_request(
            request_id,
            ConversationRequestPhase::Failed,
            &json!({
                "requestId": request_id,
                "deliveryState": "FAILED",
                "nativeDispatchState": "NOT_STARTED",
                "retryMode": "SAME_REQUEST",
                "reservation": {
                    "kind": "first-send",
                    "requestId": request_id,
                    "campaignId": "campaign-rearm",
                    "taskId": "task-rearm",
                    "attemptId": "attempt-rearm",
                    "messageReserved": true
                },
                "error": "admission refused"
            }),
        )
        .unwrap();
    let rearmed = store
        .rearm_failed_conversation_request(request_id, "payload-hash", "claim-2")
        .unwrap();
    assert_eq!(rearmed.phase, "prepared");
    assert_eq!(rearmed.attempt_id, "attempt-rearm");
    assert_eq!(
        rearmed
            .result
            .as_ref()
            .and_then(|value| value.get("attempts"))
            .and_then(Value::as_array)
            .map(Vec::len),
        Some(1)
    );
    let records = store.list_event_records("attempt-rearm", 0).unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].event.kind, "message.user");
    assert_eq!(
        records[0].payload.as_ref().unwrap()["text"],
        "reserved once"
    );
    assert_eq!(store.counts().unwrap().commands, 0);
}

#[test]
fn unexpected_oversize_ui_response_becomes_bounded_capacity_ack_with_safety_state() {
    let giant = "x".repeat(9 * 1024 * 1024);
    let source = json!({
        "protocolVersion": "goalport.ipc.v2",
        "requestId": "capacity-request",
        "entityVersion": 1,
        "ok": false,
        "payload": {
            "requestId": "capacity-request",
            "accepted": false,
            "snapshot": {
                "selectedProjectId": "project-1",
                "project": {"id":"project-1","name":"Project","workspaceRoot":"C:/work","color":"blue"},
                "activeCampaignId": "campaign-1",
                "activeTask": {"id":"task-1","title":"Task","acceptance":"done","state":"in-progress"},
                "attempt": {"id":"attempt-1","taskId":"task-1","provider":"codex","role":"executor","state":"active","sessionLabel":"Native","sessionHash":"abc","eventCount":1},
                "decisions": [{"actionKnown":false,"id":"decision-1","title":giant,"kind":"permission","facts":[giant],"recommendation":giant,"defaultBehavior":giant,"state":"pending"}],
                "stopResponsibility": {"attemptId":"attempt-1","operationId":"stop-1","provider":"codex","nativeTurnState":"unconfirmed","residualExecutionState":"unknown","writeResponsibility":"held","inputUuid":"input-1","sessionHash":"abc","turnEpoch":1,"processEpoch":"epoch-1","source":"test","detail":{"giant":giant},"workspaceKey":"C:/work","interruptedAt":"now","taskTitle":"Task","campaignGoal":"Goal","blockedReason":"held","blocksCurrentWorkspace":true,"latestRecheck":null},
                "productConversation": {"pageInfo":{},"runtime":{"state":"unavailable","provider":"codex","name":"Codex"},"title":"title"},
                "timelinePageInfo": {}
            },
            "rejection": {
                "code":"admission-failed","message":giant,
                "deliveryState":"FAILED","nativeDispatchState":"NOT_STARTED","retryMode":"SAME_REQUEST",
                "reservation":{"kind":"first-send","requestId":"capacity-request","campaignId":"campaign-1","taskId":"task-1","attemptId":"attempt-1","messageReserved":true}
            }
        },
        "error": giant
    });
    let bounded = bound_ui_response(source).unwrap();
    assert!(serde_json::to_vec(&bounded).unwrap().len() <= MAX_CAPACITY_ACK_BYTES);
    assert_eq!(bounded["payload"]["accepted"], false);
    assert_eq!(
        bounded["payload"]["rejection"]["reservation"]["attemptId"],
        "attempt-1"
    );
    assert_eq!(
        bounded["payload"]["snapshot"]["bounds"]["projectionUnavailable"],
        true
    );
    assert_eq!(
        bounded["payload"]["snapshot"]["productConversation"]["turn"]["state"],
        "uncertain"
    );
    assert_eq!(
        bounded["payload"]["snapshot"]["stopResponsibility"]["writeResponsibility"],
        "held"
    );
}

#[test]
fn capacity_ack_preserves_valid_256_byte_ids_even_when_json_escaping_expands_them() {
    for request_id in ["a".repeat(256), "\u{0001}".repeat(256)] {
        assert_eq!(request_id.as_bytes().len(), 256);
        let source = json!({
            "protocolVersion":"goalport.ipc.v2",
            "requestId":request_id,
            "entityVersion":1,
            "ok":true,
            "payload":{
                "requestId":request_id,
                "accepted":true,
                "duplicate":false,
                "snapshot":{
                    "selectedProjectId":"project-1",
                    "project":{"id":"project-1","name":"","workspaceRoot":"C:/work","color":""},
                    "activeCampaignId":"campaign-1",
                    "activeTask":{"id":"task-1","title":"","acceptance":"","state":"in-progress"},
                    "attempt":{"id":"attempt-1","taskId":"task-1","provider":"scenario","role":"executor","state":"active","sessionLabel":"","sessionHash":null,"eventCount":0},
                    "decisions":[],"stopResponsibility":null,"timelinePageInfo":{},
                    "productConversation":{"pageInfo":{},"runtime":{"state":"selected","provider":"scenario","name":"Scenario"},"title":""}
                },
                "unexpected":"z".repeat(9 * 1024 * 1024)
            }
        });
        let bounded = bound_ui_response(source).unwrap();
        assert_eq!(bounded["requestId"], request_id);
        assert_eq!(bounded["payload"]["requestId"], request_id);
        assert!(serde_json::to_vec(&bounded).unwrap().len() <= MAX_CAPACITY_ACK_BYTES);
    }
}

#[test]
fn legacy_generated_handoff_is_hidden_from_title_and_operation_summary_is_global_deduped() {
    let store = Store::memory().unwrap();
    store
        .create_workspace_campaign(
            &Project {
                id: "project-handoff-history".into(),
                workspace_root: "C:/work/handoff-history".into(),
            },
            &Campaign {
                id: "campaign-handoff-history".into(),
                goal: "fallback goal".into(),
                root_task_id: "task-handoff-history".into(),
                state: WorkStatus::InProgress,
            },
            &Task {
                id: "task-handoff-history".into(),
                campaign_id: "campaign-handoff-history".into(),
                title: "fallback task".into(),
                acceptance: "done".into(),
                state: WorkStatus::InProgress,
            },
            "policy-handoff-history",
            "{}",
            &CampaignAuthorization::granted(),
        )
        .unwrap();
    let old = "attempt-handoff-old";
    let new = "attempt-handoff-new";
    store
        .insert_attempt(&Attempt::new(
            old,
            "task-handoff-history",
            "scenario",
            "scenario-cap-v1",
        ))
        .unwrap();
    store
        .insert_attempt(&Attempt::new(
            new,
            "task-handoff-history",
            "scenario",
            "scenario-cap-v1",
        ))
        .unwrap();
    let packet = json!({
        "packetVersion":"goalport.handoff.v1",
        "authorization":{"requestHash":"operation-hash"},
        "oldAttempt":{"id":old},
        "newAttempt":{"id":new,"provider":"scenario"}
    });
    store
        .append_event_json(
            &Event {
                id: "handoff-source-first".into(),
                attempt_id: old.into(),
                seq: 1,
                kind: "handoff.completed".into(),
                payload_ref: None,
            },
            &packet,
        )
        .unwrap();
    store
        .append_event_json(
            &Event {
                id: "handoff-destination".into(),
                attempt_id: new.into(),
                seq: 1,
                kind: "handoff.completed".into(),
                payload_ref: None,
            },
            &packet,
        )
        .unwrap();
    store
        .append_event_json(
            &Event {
                id: "legacy-generated-message".into(),
                attempt_id: new.into(),
                seq: 2,
                kind: "message.user".into(),
                payload_ref: None,
            },
            &json!({
                "requestId":"handoff-instruction-review-debt",
                "text":"GoalPort Core handoff packet (machine generated)"
            }),
        )
        .unwrap();
    store
        .append_event_json(
            &Event {
                id: "real-user-message".into(),
                attempt_id: new.into(),
                seq: 3,
                kind: "message.user".into(),
                payload_ref: None,
            },
            &json!({"text":"Real user title"}),
        )
        .unwrap();
    store
        .append_event_json(
            &Event {
                id: "handoff-source-duplicate".into(),
                attempt_id: old.into(),
                seq: 2,
                kind: "handoff.completed".into(),
                payload_ref: None,
            },
            &packet,
        )
        .unwrap();

    let server = CoreServer::new(store.clone());
    let snapshot = server
        .handle_json(&ui_wire("handoff-snapshot", "snapshot", json!({})))
        .unwrap();
    assert_eq!(
        snapshot["payload"]["snapshot"]["productConversation"]["title"],
        "Real user title"
    );
    let mut cursor = None;
    let mut summaries = 0;
    let mut user_bodies = Vec::new();
    loop {
        let page = conversation_page(
            &store,
            "campaign-handoff-history",
            HistoryDirection::Newer,
            cursor.as_deref(),
            512,
        )
        .unwrap();
        for item in page.conversation_items.unwrap_or_default() {
            if item.kind == "handoff-summary" {
                summaries += 1;
            }
            if item.kind == "user-message" {
                user_bodies.push(item.body);
            }
        }
        if !page.page_info.has_newer {
            break;
        }
        cursor = page.page_info.newer_cursor;
        assert!(cursor.is_some());
    }
    assert_eq!(summaries, 1);
    assert_eq!(user_bodies, vec!["Real user title"]);
}
