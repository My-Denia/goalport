use goalport_core::{
    AccessMode, Attempt, AttemptState, Command, CommandState, Decision, DecisionState, Event,
    LeaseState, OutboxIntent, OutboxState, Store, StoreError, WorkspaceLease,
};
use serde_json::json;

fn append_event(store: &Store, attempt_id: &str, seq: i64, kind: &str) {
    store
        .append_event(&Event {
            id: format!("{attempt_id}-{seq}"),
            attempt_id: attempt_id.into(),
            seq,
            kind: kind.into(),
            payload_ref: None,
        })
        .unwrap();
}

#[test]
fn review_can_reactivate_the_same_persisted_attempt() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("core.sqlite");
    let store = Store::open(&path).unwrap();
    store
        .insert_attempt(&Attempt::new("attempt", "task", "scenario", "cap-v1"))
        .unwrap();
    append_event(&store, "attempt", 1, "attempt.active");
    append_event(&store, "attempt", 2, "attempt.awaiting_review");
    assert_eq!(
        store.get_attempt("attempt").unwrap().state,
        AttemptState::AwaitingReview
    );
    drop(store);

    let store = Store::open(&path).unwrap();
    append_event(&store, "attempt", 3, "attempt.active");
    drop(store);

    let store = Store::open(&path).unwrap();
    let attempt = store.get_attempt("attempt").unwrap();
    assert_eq!(attempt.id, "attempt");
    assert_eq!(attempt.state, AttemptState::Active);
    assert_eq!(attempt.last_event_seq, 3);
    assert_eq!(
        store
            .list_events("attempt")
            .unwrap()
            .into_iter()
            .map(|event| event.kind)
            .collect::<Vec<_>>(),
        [
            "attempt.active",
            "attempt.awaiting_review",
            "attempt.active"
        ]
    );
}

#[test]
fn revoking_approved_decision_updates_the_stored_state() {
    let store = Store::open_in_memory().unwrap();
    store
        .insert_decision(&Decision {
            id: "decision".into(),
            attempt_id: "attempt".into(),
            kind: "external_action".into(),
            state: DecisionState::Approved,
        })
        .unwrap();
    assert_eq!(
        store
            .update_decision_state("decision", DecisionState::Denied)
            .unwrap()
            .state,
        DecisionState::Denied
    );
    assert_eq!(
        store.get_decision("decision").unwrap().state,
        DecisionState::Denied
    );
    assert!(
        store
            .update_decision_state("decision", DecisionState::Approved)
            .is_err()
    );
}

#[test]
fn unknown_dispatched_outbox_is_excluded_while_pending_work_is_retryable() {
    let store = Store::open_in_memory().unwrap();
    store
        .insert_attempt(&Attempt::new("attempt", "task", "scenario", "cap-v1"))
        .unwrap();
    for id in ["lost-receipt", "pending"] {
        store
            .record_command(&Command {
                id: format!("command-{id}"),
                attempt_id: "attempt".into(),
                kind: "external-effect".into(),
                payload_hash: format!("hash-{id}"),
                state: CommandState::Executing,
            })
            .unwrap();
        store
            .insert_outbox(&OutboxIntent {
                id: id.into(),
                command_id: format!("command-{id}"),
                effect_kind: "external-effect".into(),
                target: "synthetic://effect".into(),
                state: OutboxState::Pending,
            })
            .unwrap();
    }
    let retryable_ids = |store: &Store| {
        let mut ids = store
            .retryable_outbox()
            .unwrap()
            .into_iter()
            .map(|intent| intent.id)
            .collect::<Vec<_>>();
        ids.sort();
        ids
    };
    assert_eq!(retryable_ids(&store), ["lost-receipt", "pending"]);
    store
        .update_outbox_state("lost-receipt", OutboxState::Dispatching, None)
        .unwrap();
    store
        .mark_outbox_unknown("lost-receipt", "receipt missing")
        .unwrap();
    assert_eq!(
        store.get_outbox("lost-receipt").unwrap().state,
        OutboxState::Unknown
    );
    assert_eq!(retryable_ids(&store), ["pending"]);
}

#[test]
fn releasing_a_lease_allows_takeover_without_erasing_previous_history() {
    let directory = tempfile::tempdir().unwrap();
    let workspace = directory.path().to_string_lossy().into_owned();
    let store = Store::open_in_memory().unwrap();
    for id in ["first", "second"] {
        store
            .insert_attempt(&Attempt::new(id, "task", "scenario", "cap-v1"))
            .unwrap();
    }
    let first = store
        .acquire_lease(&WorkspaceLease::new(
            &workspace,
            "first",
            AccessMode::Mutating,
        ))
        .unwrap();
    append_event(&store, "first", 1, "attempt.active");
    assert!(matches!(
        store.acquire_lease(&WorkspaceLease::new(
            &workspace,
            "second",
            AccessMode::Mutating
        )),
        Err(StoreError::LeaseConflict(_))
    ));
    store
        .release_lease(&first.workspace_key, "first", "work finished")
        .unwrap();
    let second = store
        .acquire_lease(&WorkspaceLease::new(
            &workspace,
            "second",
            AccessMode::Mutating,
        ))
        .unwrap();
    assert_eq!(second.attempt_id, "second");
    assert_eq!(second.state, LeaseState::Active);
    let history = store.list_events("first").unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].kind, "attempt.active");
}

#[test]
fn output_event_payload_and_reference_survive_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("core.sqlite");
    let store = Store::open(&path).unwrap();
    store
        .insert_attempt(&Attempt::new("attempt", "task", "scenario", "cap-v1"))
        .unwrap();
    let payload = json!({ "text": "saved output" });
    store
        .append_event_json(
            &Event {
                id: "output".into(),
                attempt_id: "attempt".into(),
                seq: 1,
                kind: "output.chunk".into(),
                payload_ref: Some("output-ref".into()),
            },
            &payload,
        )
        .unwrap();
    drop(store);

    let store = Store::open(&path).unwrap();
    let records = store.list_event_records("attempt", 0).unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].event.kind, "output.chunk");
    assert_eq!(records[0].event.payload_ref.as_deref(), Some("output-ref"));
    assert_eq!(records[0].payload.as_ref(), Some(&payload));
}
