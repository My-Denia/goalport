use goalport_core::{
    AccessMode, Attempt, Campaign, CoreCommand, CoreOperation, Decision, DecisionState,
    OutboxIntent, OutboxState, Project, Store, StoreError, Task, UiCommandRequest, UiController,
    WorkStatus, WorkspaceLease,
    store::{StopNativeTurnState, StopResponsibility, StopResponsibilityUpdate},
};
use serde_json::json;

fn seed_attempt(store: &Store, workspace: &str, attempt_id: &str, provider: &str) {
    store
        .insert_project(&Project {
            id: "project-stop".into(),
            workspace_root: workspace.into(),
        })
        .unwrap();
    let campaign = Campaign {
        id: "campaign-stop".into(),
        goal: "exercise durable stop".into(),
        root_task_id: "task-stop".into(),
        state: WorkStatus::InProgress,
    };
    let task = Task {
        id: "task-stop".into(),
        campaign_id: "campaign-stop".into(),
        title: "stop".into(),
        acceptance: "held across restart".into(),
        state: WorkStatus::InProgress,
    };
    store
        .create_campaign_with_task("project-stop", &campaign, &task)
        .unwrap();
    store
        .insert_attempt(&Attempt::new(attempt_id, "task-stop", provider, "cap-v1"))
        .unwrap();
}

fn binding() -> serde_json::Value {
    json!({
        "input_uuid": "input-7",
        "session_id": "session-9",
        "turn_epoch": 4,
        "process_epoch": "process-3"
    })
}

#[test]
fn stop_commit_is_schema_v7_and_survives_reopen_with_lease_uncertain() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("stop.sqlite");
    let workspace = directory.path().join("workspace");
    let workspace_text = workspace.to_string_lossy();
    let first = Store::open(&path).unwrap();
    seed_attempt(&first, &workspace_text, "attempt-claude", "claude");
    first
        .acquire_lease(&WorkspaceLease::new(
            &workspace,
            "attempt-claude",
            AccessMode::Mutating,
        ))
        .unwrap();

    let begun = first
        .begin_stop_responsibility(
            "attempt-claude",
            "operation-ui-stop-1",
            &workspace_text,
            "claude",
            &binding(),
            Some(&json!({ "source": "ui.stop" })),
        )
        .unwrap();

    assert!(begun.inserted);
    // Schema v8 added the append-only re-check ledger and the continuation record.
    // Both are new tables; every column asserted by this suite is unchanged.
    assert_eq!(first.schema_version().unwrap(), 8);
    assert_eq!(
        begun.responsibility.native_turn_state,
        StopNativeTurnState::Pending
    );
    assert_eq!(begun.responsibility.residual_execution_state, "unknown");
    assert_eq!(begun.responsibility.write_responsibility, "held");
    assert_eq!(begun.responsibility.binding, binding());
    assert_eq!(
        first.leases().unwrap()[0].state,
        goalport_core::LeaseState::Uncertain
    );
    drop(first);

    let reopened = Store::open(&path).unwrap();
    let row = reopened
        .stop_responsibility_for_attempt("attempt-claude")
        .unwrap()
        .unwrap();
    assert_eq!(row.operation_id, "operation-ui-stop-1");
    assert_eq!(row.binding, binding());
    assert!(
        reopened
            .held_stop_for_workspace(&workspace_text)
            .unwrap()
            .is_some()
    );
}

#[test]
fn duplicate_stop_never_rebinds_and_only_exact_outcome_advances() {
    let store = Store::memory().unwrap();
    seed_attempt(&store, "C:\\work\\stop", "attempt-claude", "claude");
    let first = store
        .begin_stop_responsibility(
            "attempt-claude",
            "operation-first",
            "C:\\work\\stop",
            "claude",
            &binding(),
            None,
        )
        .unwrap();
    assert!(first.inserted);

    let duplicate = store
        .begin_stop_responsibility(
            "attempt-claude",
            "operation-second-click",
            "C:\\work\\stop",
            "claude",
            &json!({
                "input_uuid": "replacement",
                "session_id": "replacement",
                "turn_epoch": 99,
                "process_epoch": "replacement"
            }),
            None,
        )
        .unwrap();
    assert!(!duplicate.inserted);
    assert_eq!(duplicate.responsibility.operation_id, "operation-first");
    assert_eq!(duplicate.responsibility.binding, binding());

    let mut foreign_binding = binding();
    foreign_binding["session_id"] = json!("foreign");
    assert_eq!(
        store
            .update_stop_responsibility(&StopResponsibilityUpdate {
                attempt_id: "attempt-claude".into(),
                operation_id: "operation-first".into(),
                binding: foreign_binding,
                native_turn_state: StopNativeTurnState::Interrupted,
                residual_execution_state: "unknown".into(),
                detail: Some(json!({ "source": "foreign.result" })),
            })
            .unwrap(),
        None
    );
    let updated = store
        .update_stop_responsibility(&StopResponsibilityUpdate {
            attempt_id: "attempt-claude".into(),
            operation_id: "operation-first".into(),
            binding: binding(),
            native_turn_state: StopNativeTurnState::Interrupted,
            residual_execution_state: "unknown".into(),
            detail: Some(json!({ "source": "claude.native.result" })),
        })
        .unwrap()
        .unwrap();
    assert_eq!(updated.native_turn_state, StopNativeTurnState::Interrupted);

    let late = store
        .update_stop_responsibility(&StopResponsibilityUpdate {
            attempt_id: "attempt-claude".into(),
            operation_id: "operation-first".into(),
            binding: binding(),
            native_turn_state: StopNativeTurnState::Unconfirmed,
            residual_execution_state: "unknown".into(),
            detail: Some(json!({ "source": "late.timeout" })),
        })
        .unwrap()
        .unwrap();
    assert_eq!(late.native_turn_state, StopNativeTurnState::Interrupted);
    assert_eq!(late.binding, binding());

    assert_eq!(
        store
            .update_stop_responsibility(&StopResponsibilityUpdate {
                attempt_id: "attempt-foreign".into(),
                operation_id: "operation-first".into(),
                binding: binding(),
                native_turn_state: StopNativeTurnState::Interrupted,
                residual_execution_state: "active".into(),
                detail: None,
            })
            .unwrap(),
        None
    );
}

#[test]
fn stop_is_allowed_for_each_preexisting_attempt_in_overlapping_workspaces() {
    let store = Store::memory().unwrap();
    seed_attempt(&store, "C:\\work\\stop", "attempt-first", "claude");
    store
        .insert_attempt(&Attempt::new(
            "attempt-second",
            "task-stop",
            "claude",
            "cap-v1",
        ))
        .unwrap();
    let first = store
        .begin_stop_responsibility(
            "attempt-first",
            "operation-first",
            "C:\\work\\stop",
            "claude",
            &binding(),
            None,
        )
        .unwrap();
    let second_binding = json!({
        "input_uuid": "input-second",
        "session_id": "session-second",
        "turn_epoch": 8,
        "process_epoch": "process-second"
    });
    let second = store
        .begin_stop_responsibility(
            "attempt-second",
            "operation-second",
            "C:\\work\\stop\\child",
            "claude",
            &second_binding,
            None,
        )
        .unwrap();

    assert!(first.inserted);
    assert!(second.inserted);
    assert_eq!(store.stop_responsibilities().unwrap().len(), 2);
    let duplicate = store
        .begin_stop_responsibility(
            "attempt-second",
            "operation-second-click",
            "C:\\work\\stop\\child",
            "claude",
            &second_binding,
            None,
        )
        .unwrap();
    assert!(!duplicate.inserted);
    assert_eq!(duplicate.responsibility.operation_id, "operation-second");
    assert_eq!(store.stop_responsibilities().unwrap().len(), 2);
    assert_eq!(
        store
            .held_stop_for_workspace_prefer("C:\\work\\stop", Some("attempt-second"))
            .unwrap()
            .unwrap()
            .attempt_id,
        "attempt-second"
    );
}

#[test]
fn missing_active_binding_is_durable_unconfirmed_and_cannot_confirm_interrupted() {
    let store = Store::memory().unwrap();
    seed_attempt(&store, "C:\\work\\missing", "attempt-missing", "claude");
    let begun = store
        .begin_stop_responsibility(
            "attempt-missing",
            "operation-missing",
            "C:\\work\\missing",
            "claude",
            &serde_json::Value::Null,
            Some(&json!({ "bindingCapture": "missing-active" })),
        )
        .unwrap();
    assert!(begun.inserted);
    let unconfirmed = store
        .update_stop_responsibility(&StopResponsibilityUpdate {
            attempt_id: "attempt-missing".into(),
            operation_id: "operation-missing".into(),
            binding: serde_json::Value::Null,
            native_turn_state: StopNativeTurnState::Unconfirmed,
            residual_execution_state: "unknown".into(),
            detail: Some(json!({ "bindingCapture": "missing-active", "nativeDispatch": false })),
        })
        .unwrap()
        .unwrap();
    assert_eq!(
        unconfirmed.native_turn_state,
        StopNativeTurnState::Unconfirmed
    );
    assert_eq!(unconfirmed.write_responsibility, "held");

    let invalid_confirmation = store.update_stop_responsibility(&StopResponsibilityUpdate {
        attempt_id: "attempt-missing".into(),
        operation_id: "operation-missing".into(),
        binding: serde_json::Value::Null,
        native_turn_state: StopNativeTurnState::Interrupted,
        residual_execution_state: "unknown".into(),
        detail: None,
    });
    assert!(matches!(
        invalid_confirmation,
        Err(StoreError::InvalidState(_))
    ));
    assert_eq!(
        store
            .stop_responsibility_for_attempt("attempt-missing")
            .unwrap()
            .unwrap()
            .native_turn_state,
        StopNativeTurnState::Unconfirmed
    );
}

#[test]
fn held_responsibility_blocks_overlapping_lease_release_and_outbox_dispatch() {
    let store = Store::memory().unwrap();
    seed_attempt(&store, "C:\\work\\stop", "attempt-claude", "claude");
    store
        .acquire_lease(&WorkspaceLease::new(
            "C:\\work\\stop",
            "attempt-claude",
            AccessMode::Mutating,
        ))
        .unwrap();
    store
        .begin_stop_responsibility(
            "attempt-claude",
            "operation-first",
            "C:\\work\\stop",
            "claude",
            &binding(),
            None,
        )
        .unwrap();

    let conflict = store
        .acquire_lease(&WorkspaceLease::new(
            "C:\\work\\stop\\child",
            "attempt-other",
            AccessMode::Mutating,
        ))
        .unwrap_err();
    assert!(matches!(
        conflict,
        StoreError::StopResponsibilityConflict { .. }
    ));
    assert!(matches!(
        store.release_lease("C:\\work\\stop", "attempt-claude", "terminal"),
        Err(StoreError::StopResponsibilityConflict { .. })
    ));
    assert!(matches!(
        store.revoke_lease("C:\\work\\stop", "attempt-claude", "owner"),
        Err(StoreError::StopResponsibilityConflict { .. })
    ));

    let command = CoreCommand::new(
        "command-write",
        "attempt-claude",
        CoreOperation::AppendEvent {
            event: goalport_core::Event {
                id: "event-write".into(),
                attempt_id: "attempt-claude".into(),
                seq: 1,
                kind: "workspace.write".into(),
                payload_ref: None,
            },
        },
    )
    .unwrap();
    store.record_command(&command.command).unwrap();
    store
        .insert_outbox(&OutboxIntent {
            id: "outbox-write".into(),
            command_id: "command-write".into(),
            effect_kind: "workspace.write".into(),
            target: "C:\\work\\stop\\file.txt".into(),
            state: OutboxState::Pending,
        })
        .unwrap();
    assert!(matches!(
        store.update_outbox_state("outbox-write", OutboxState::Dispatching, None),
        Err(StoreError::StopResponsibilityConflict { .. })
    ));
    store
        .insert_attempt(&Attempt::new(
            "attempt-other",
            "task-stop",
            "scenario",
            "cap-v1",
        ))
        .unwrap();
    let other_command = CoreCommand::new(
        "command-other-write",
        "attempt-other",
        CoreOperation::AppendEvent {
            event: goalport_core::Event {
                id: "event-other-write".into(),
                attempt_id: "attempt-other".into(),
                seq: 1,
                kind: "workspace.write".into(),
                payload_ref: None,
            },
        },
    )
    .unwrap();
    store.record_command(&other_command.command).unwrap();
    store
        .insert_outbox(&OutboxIntent {
            id: "outbox-other-write".into(),
            command_id: "command-other-write".into(),
            effect_kind: "workspace.write".into(),
            target: "C:\\work\\stop\\child\\file.txt".into(),
            state: OutboxState::Pending,
        })
        .unwrap();
    assert!(matches!(
        store.update_outbox_state("outbox-other-write", OutboxState::Dispatching, None),
        Err(StoreError::StopResponsibilityConflict { .. })
    ));
    assert!(store.retryable_outbox().unwrap().is_empty());
}

#[test]
fn held_row_shape_has_no_release_or_quiescence_state() {
    let store = Store::memory().unwrap();
    seed_attempt(&store, "C:\\work\\stop", "attempt-claude", "claude");
    store
        .begin_stop_responsibility(
            "attempt-claude",
            "operation-first",
            "C:\\work\\stop",
            "claude",
            &binding(),
            None,
        )
        .unwrap();

    let rows: Vec<StopResponsibility> = store.stop_responsibilities().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].residual_execution_state, "unknown");
    assert_eq!(rows[0].write_responsibility, "held");
}

fn ui(message_type: &str, request_id: &str, payload: serde_json::Value) -> UiCommandRequest {
    UiCommandRequest {
        protocol_version: goalport_core::ipc::CONNECTED_UI_PROTOCOL_VERSION.into(),
        request_id: request_id.into(),
        entity_version: 0,
        message_type: message_type.into(),
        payload,
    }
}

#[test]
fn held_workspace_rejects_new_attempt_send_and_allow_before_side_effects() {
    let store = Store::memory().unwrap();
    let mut controller = UiController::new_seeded_fixture(
        store.clone(),
        "synthetic://goalport-fixture",
    )
    .unwrap();
    let snapshot = controller.snapshot(None).unwrap();
    let workspace = snapshot.project.workspace_root;
    let campaign_id = snapshot.active_campaign_id;
    let task_id = snapshot.active_task.id;
    let attempt_id = snapshot.attempt.id;
    store
        .begin_stop_responsibility(
            &attempt_id,
            "operation-existing",
            &workspace,
            "scenario",
            &binding(),
            None,
        )
        .unwrap();
    store
        .insert_decision(&Decision {
            id: "decision-held".into(),
            attempt_id: attempt_id.clone(),
            kind: "workspace-write".into(),
            state: DecisionState::Pending,
        })
        .unwrap();
    let before_attempts = store.list_attempts().unwrap().len();
    let before_events = store.list_events(&attempt_id).unwrap().len();

    let select = controller.handle(ui(
        "select_runtime",
        "select-held",
        json!({
            "projectId": snapshot.project.id,
            "campaignId": campaign_id,
            "taskId": task_id,
            "attemptId": "attempt-must-not-exist",
            "provider": "scenario"
        }),
    ));
    assert!(select.unwrap_err().contains("durable Stop responsibility"));
    assert_eq!(store.list_attempts().unwrap().len(), before_attempts);

    let send = controller.handle(ui(
        "send_message",
        "send-held",
        json!({
            "campaignId": campaign_id,
            "taskId": task_id,
            "attemptId": attempt_id,
            "message": "must not dispatch"
        }),
    ));
    assert!(send.unwrap_err().contains("durable Stop responsibility"));
    assert_eq!(store.list_events(&attempt_id).unwrap().len(), before_events);

    let allow = controller.handle(ui(
        "resolve_decision",
        "allow-held",
        json!({ "decisionId": "decision-held", "allow": true }),
    ));
    assert!(allow.unwrap_err().contains("durable Stop responsibility"));
    assert_eq!(
        store.get_decision("decision-held").unwrap().state,
        DecisionState::Pending
    );
}

#[test]
fn inert_campaign_is_allowed_but_downstream_admission_is_blocked() {
    let store = Store::memory().unwrap();
    let mut controller = UiController::new_seeded_fixture(
        store.clone(),
        "synthetic://goalport-fixture",
    )
    .unwrap();
    let snapshot = controller.snapshot(None).unwrap();
    store
        .begin_stop_responsibility(
            &snapshot.attempt.id,
            "operation-existing",
            &snapshot.project.workspace_root,
            "scenario",
            &binding(),
            None,
        )
        .unwrap();
    let before_attempts = store.list_attempts().unwrap().len();

    let created = controller
        .handle(ui(
            "create_campaign",
            "create-inert",
            json!({
                "projectId": snapshot.project.id,
                "goal": "metadata only",
                "title": "inert"
            }),
        ))
        .unwrap();
    assert_eq!(store.list_attempts().unwrap().len(), before_attempts);
    assert_eq!(
        created
            .snapshot
            .stop_responsibility
            .as_ref()
            .map(|row| row.attempt_id.as_str()),
        Some(snapshot.attempt.id.as_str())
    );
    let denied = controller.handle(ui(
        "select_runtime",
        "admit-inert",
        json!({
            "projectId": created.snapshot.project.id,
            "campaignId": created.snapshot.active_campaign_id,
            "taskId": created.snapshot.active_task.id,
            "attemptId": "attempt-inert",
            "provider": "scenario"
        }),
    ));
    assert!(denied.unwrap_err().contains("durable Stop responsibility"));
    assert!(store.get_attempt("attempt-inert").is_err());
}

#[test]
fn revocation_fans_out_distinct_stop_operations_and_retains_parent_operation() {
    let store = Store::memory().unwrap();
    seed_attempt(
        &store,
        "C:\\work\\revocation-fanout",
        "attempt-claude-first",
        "claude",
    );
    store
        .insert_attempt(&Attempt::new(
            "attempt-claude-second",
            "task-stop",
            "claude",
            "cap-v1",
        ))
        .unwrap();
    for attempt_id in ["attempt-claude-first", "attempt-claude-second"] {
        store
            .append_event_with_state(
                &goalport_core::Event {
                    id: format!("activate-{attempt_id}"),
                    attempt_id: attempt_id.into(),
                    seq: 1,
                    kind: "attempt.active".into(),
                    payload_ref: None,
                },
                Some(goalport_core::AttemptState::Active),
                None,
            )
            .unwrap();
    }
    store
        .set_campaign_authorization(
            "campaign-stop",
            &goalport_core::store::CampaignAuthorization::granted(),
        )
        .unwrap();
    let mut controller = UiController::new(store.clone()).unwrap();

    let response = controller
        .handle(ui(
            "revoke_authorization",
            "revoke-parent-operation",
            json!({ "campaignId": "campaign-stop", "scope": "action" }),
        ))
        .unwrap();

    let notice_snapshot = controller.snapshot(None).unwrap();
    assert!(notice_snapshot.notices.iter().any(|n| n.contains("stop handling requested")));
    assert!(!notice_snapshot.notices.iter().any(|n| n.contains("Runtime interrupted")));
    let rows = store.stop_responsibilities().unwrap();
    assert_eq!(rows.len(), 2);
    assert_ne!(rows[0].operation_id, rows[1].operation_id);
    for row in rows {
        assert!(
            row.operation_id
                .starts_with("revoke-parent-operation:revoke:")
        );
        assert_eq!(row.binding, serde_json::Value::Null);
        assert_eq!(row.native_turn_state, StopNativeTurnState::Unconfirmed);
        assert_eq!(row.write_responsibility, "held");
        assert_eq!(
            row.detail
                .as_ref()
                .and_then(|detail| detail.get("parentOperationId"))
                .and_then(serde_json::Value::as_str),
            Some("revoke-parent-operation")
        );
    }
}

