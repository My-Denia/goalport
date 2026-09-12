use goalport_core::{
    AccessMode, Attempt, AttemptRecovery, Command, CommandState, Decision, DecisionState,
    OutboxIntent, OutboxState, Store, WorkspaceLease, ipc::UiCommandRequest,
    projection::UiController,
};
use serde_json::json;

fn ui(message_type: &str, payload: serde_json::Value) -> UiCommandRequest {
    UiCommandRequest {
        protocol_version: "goalport.ipc.v2".into(),
        request_id: format!("test-{message_type}-{}", payload),
        entity_version: 0,
        message_type: message_type.into(),
        payload,
    }
}

#[test]
fn core_crash_does_not_replay_prompt() {
    let store = Store::open_in_memory().unwrap();
    let mut first = UiController::new_seeded_fixture(
        store.clone(),
        "synthetic://goalport-fixture",
    )
    .unwrap();
    let snapshot = first.handle(ui("snapshot", json!({}))).unwrap().snapshot;
    let campaign_id = snapshot.active_campaign_id.clone();
    let task_id = snapshot.active_task.id.clone();
    let selected = first
        .handle(ui(
            "select_runtime",
            json!({
                "projectId": snapshot.selected_project_id,
                "campaignId": campaign_id,
                "taskId": task_id,
                "provider": "scenario"
            }),
        ))
        .unwrap()
        .snapshot;
    let attempt_id = selected.attempt.id.clone();
    let sent = first
        .handle(ui(
            "send_message",
            json!({
                "campaignId": campaign_id,
                "taskId": task_id,
                "attemptId": attempt_id,
                "message": "do not replay this prompt"
            }),
        ))
        .unwrap()
        .snapshot;
    let before = store.list_events(&attempt_id).unwrap();
    let user_before = before
        .iter()
        .filter(|event| event.kind == "message.user")
        .count();
    assert!(user_before >= 1);
    drop(first);

    let mut restarted = UiController::new(store.clone()).unwrap();
    let after = restarted
        .handle(ui("snapshot", json!({})))
        .unwrap()
        .snapshot;
    let events = store.list_events(&attempt_id).unwrap();
    let user_after = events
        .iter()
        .filter(|event| event.kind == "message.user")
        .count();
    assert_eq!(
        user_after, user_before,
        "Core restart must not resend the committed prompt"
    );
    assert_eq!(after.attempt.id, sent.attempt.id);
    let recovery = store.get_attempt_recovery(&attempt_id).unwrap();
    assert!(recovery.is_some());
    assert!(!recovery.unwrap().prompt_replay);
}

#[test]
fn uncertain_effect_not_replayed() {
    let store = Store::open_in_memory().unwrap();
    store
        .insert_attempt(&Attempt::new(
            "attempt-effect",
            "task",
            "scenario",
            "cap-v1",
        ))
        .unwrap();
    store
        .insert_outbox(&OutboxIntent {
            id: "outbox-effect".into(),
            command_id: "command-effect".into(),
            effect_kind: "external-write".into(),
            target: "synthetic".into(),
            state: OutboxState::Pending,
        })
        .unwrap();
    store
        .record_command(&Command {
            id: "command-effect".into(),
            attempt_id: "attempt-effect".into(),
            kind: "effect.dispatch".into(),
            payload_hash: "abc".into(),
            state: CommandState::Executing,
        })
        .unwrap();
    let unknown = store
        .mark_outbox_unknown("outbox-effect", "receipt missing after crash")
        .unwrap();
    assert_eq!(unknown.state, OutboxState::Unknown);
    store.rebuild_projections().unwrap();
    store.mark_executing_commands_unknown().unwrap();
    let _controller = UiController::new(store.clone()).unwrap();
    let outbox = store.outbox_for_attempt("attempt-effect").unwrap();
    assert!(
        outbox
            .iter()
            .all(|intent| intent.state == OutboxState::Unknown || intent.id != "outbox-effect")
    );
    assert!(
        outbox
            .iter()
            .all(|intent| intent.state != OutboxState::Dispatching
                && intent.state != OutboxState::Pending)
    );
}

#[test]
fn recovery_class_is_explicit() {
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
    let classified = controller
        .handle(ui(
            "classify_recovery",
            json!({
                "attemptId": selected.attempt.id,
                "class": "R1"
            }),
        ))
        .unwrap()
        .snapshot;
    let recovery = store
        .get_attempt_recovery(&selected.attempt.id)
        .unwrap()
        .expect("recovery row");
    assert_eq!(recovery.recovery_class.as_deref(), Some("R1_UNSUPPORTED"));
    assert!(
        classified
            .timeline
            .iter()
            .any(|item| item.body.contains("recovery.classified")
                || item.title.to_lowercase().contains("recovery"))
    );
    let _lease = store
        .acquire_lease(&WorkspaceLease::new(
            ".",
            &selected.attempt.id,
            AccessMode::Mutating,
        ))
        .unwrap();
}

#[test]
fn missing_campaign_authorization_is_deny() {
    let store = Store::open_in_memory().unwrap();
    let auth = store
        .get_campaign_authorization("missing-campaign")
        .unwrap();
    assert!(!auth.provider_authorized);
    assert!(!auth.transfer_authorized);
    assert!(!auth.action_authorized);
}

#[test]
fn reconstruct_preserves_prompt_replay_true() {
    let store = Store::open_in_memory().unwrap();
    store
        .upsert_attempt_recovery(&AttemptRecovery {
            attempt_id: "attempt-replay".into(),
            provider: "scenario".into(),
            session_hash: None,
            process_epoch: None,
            pid: None,
            last_seq: 1,
            pending_permission_ids: "[]".into(),
            outbox_ids: "[]".into(),
            lease_workspace_key: None,
            recovery_class: Some("R2".into()),
            prompt_replay: true,
        })
        .unwrap();
    let _controller = UiController::new(store.clone()).unwrap();
    let recovery = store
        .get_attempt_recovery("attempt-replay")
        .unwrap()
        .expect("recovery row");
    assert!(recovery.prompt_replay);
    assert_eq!(recovery.recovery_class.as_deref(), Some("R2"));
}

#[test]
fn new_core_does_not_reuse_r1_runtime_identity() {
    let store = Store::open_in_memory().unwrap();
    store
        .upsert_attempt_recovery(&AttemptRecovery {
            attempt_id: "attempt-old-r1".into(),
            provider: "codex".into(),
            session_hash: Some("session-hash".into()),
            process_epoch: Some("old-runtime-epoch".into()),
            pid: Some(4242),
            last_seq: 7,
            pending_permission_ids: "[\"permission-1\"]".into(),
            outbox_ids: "[\"outbox-1\"]".into(),
            lease_workspace_key: Some("synthetic".into()),
            recovery_class: Some("R1".into()),
            prompt_replay: false,
        })
        .unwrap();
    let _controller = UiController::new(store.clone()).unwrap();
    let recovery = store
        .get_attempt_recovery("attempt-old-r1")
        .unwrap()
        .expect("recovery row");
    assert_eq!(recovery.recovery_class.as_deref(), Some("R1_UNSUPPORTED"));
    assert_eq!(recovery.pid, None);
    assert_eq!(recovery.process_epoch, None);
    assert_eq!(recovery.session_hash.as_deref(), Some("session-hash"));
    assert_eq!(recovery.pending_permission_ids, "[\"permission-1\"]");
    assert_eq!(recovery.outbox_ids, "[\"outbox-1\"]");
    assert!(!recovery.prompt_replay);
}

#[test]
fn terminal_decision_cannot_be_approved() {
    let store = Store::open_in_memory().unwrap();
    store
        .insert_attempt(&Attempt::new(
            "attempt-decision",
            "task",
            "scenario",
            "cap-v1",
        ))
        .unwrap();
    store
        .insert_decision(&Decision {
            id: "decision-1".into(),
            attempt_id: "attempt-decision".into(),
            kind: "permission".into(),
            state: DecisionState::Pending,
        })
        .unwrap();
    store
        .update_decision_state("decision-1", DecisionState::Denied)
        .unwrap();
    let err = store
        .update_decision_state("decision-1", DecisionState::Approved)
        .unwrap_err();
    assert!(err.to_string().contains("cannot transition"));
}
