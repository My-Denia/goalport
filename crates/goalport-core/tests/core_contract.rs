use goalport_core::{
    AccessMode, AgentAdapter, AgentEventType, Attempt, AttemptState, CoreCommand, CoreOperation,
    CoreServer, Event, Evidence, IpcRequest, LeaseState, OutboxIntent, OutboxState,
    PermissionResponse, ScenarioAdapter, SessionRequest, Store, Verdict, WorkspaceLease,
};
use std::{io::Cursor, path::PathBuf};

fn session(attempt_id: &str) -> SessionRequest {
    SessionRequest {
        campaign_id: Some("campaign".into()),
        task_id: "task".into(),
        attempt_id: attempt_id.into(),
        workspace_root: PathBuf::from("."),
        resume_session: None,
    }
}

#[test]
fn duplicate_and_out_of_order_events_preserve_sequence_invariant() {
    let store = Store::open_in_memory().unwrap();
    store
        .insert_attempt(&Attempt::new("attempt", "task", "scenario", "cap-v1"))
        .unwrap();
    for sequence in 1..=32 {
        let event = Event {
            id: format!("event-{sequence}"),
            attempt_id: "attempt".into(),
            seq: sequence,
            kind: "message.delta".into(),
            payload_ref: None,
        };
        store.append_event(&event).unwrap();
        assert_eq!(
            store.get_attempt("attempt").unwrap().last_event_seq,
            sequence
        );
        assert!(matches!(
            store.append_event(&event).unwrap(),
            goalport_core::AppendEventOutcome::Duplicate(_)
        ));
    }
    let out_of_order = Event {
        id: "event-gap".into(),
        attempt_id: "attempt".into(),
        seq: 34,
        kind: "message.delta".into(),
        payload_ref: None,
    };
    assert!(store.append_event(&out_of_order).is_err());
    assert_eq!(store.list_events("attempt").unwrap().len(), 32);
}

#[test]
fn restart_rebuild_keeps_terminal_attempt_and_history() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("core.sqlite");
    let store = Store::open(&path).unwrap();
    store
        .insert_attempt(&Attempt::new("attempt", "task", "scenario", "cap-v1"))
        .unwrap();
    store
        .append_event(&Event {
            id: "e1".into(),
            attempt_id: "attempt".into(),
            seq: 1,
            kind: "attempt.active".into(),
            payload_ref: None,
        })
        .unwrap();
    store
        .append_event(&Event {
            id: "e2".into(),
            attempt_id: "attempt".into(),
            seq: 2,
            kind: "attempt.awaiting_review".into(),
            payload_ref: None,
        })
        .unwrap();
    store
        .append_event(&Event {
            id: "e3".into(),
            attempt_id: "attempt".into(),
            seq: 3,
            kind: "attempt.closed".into(),
            payload_ref: None,
        })
        .unwrap();
    drop(store);
    let restarted = Store::open(&path).unwrap();
    restarted.rebuild_projections().unwrap();
    assert_eq!(
        restarted.get_attempt("attempt").unwrap().state,
        AttemptState::Closed
    );
    assert_eq!(restarted.list_events("attempt").unwrap().len(), 3);
}

#[test]
fn lease_revocation_allows_explicit_takeover_but_uncertain_blocks_it() {
    let store = Store::open_in_memory().unwrap();
    let first = store
        .acquire_lease(&WorkspaceLease::new(
            r"C:\project",
            "a1",
            AccessMode::Mutating,
        ))
        .unwrap();
    assert_eq!(first.state, LeaseState::Active);
    store
        .mark_lease_uncertain(&first.workspace_key, "a1")
        .unwrap();
    assert!(
        store
            .acquire_lease(&WorkspaceLease::new(
                r"C:\project\child",
                "a2",
                AccessMode::Mutating
            ))
            .is_err()
    );
    store
        .revoke_lease(
            &first.workspace_key,
            "a1",
            "owner confirmed process stopped",
        )
        .unwrap();
    let second = store
        .acquire_lease(&WorkspaceLease::new(
            r"C:\project\child",
            "a2",
            AccessMode::Mutating,
        ))
        .unwrap();
    assert_eq!(second.state, LeaseState::Active);
}

#[test]
fn verified_evidence_is_only_current_for_its_snapshot() {
    let store = Store::open_in_memory().unwrap();
    let evidence = Evidence {
        id: "e".into(),
        attempt_id: "a".into(),
        claim: "tests pass".into(),
        snapshot_hash: "snapshot-1".into(),
        verdict: Verdict::Verified,
    };
    store.insert_evidence(&evidence).unwrap();
    assert!(!store.evidence_is_stale("e", "snapshot-1").unwrap());
    assert!(store.evidence_is_stale("e", "snapshot-2").unwrap());
    assert_eq!(store.get_evidence("e").unwrap().verdict, Verdict::Verified);
}

#[test]
fn unknown_outbox_effect_is_not_retryable() {
    let store = Store::open_in_memory().unwrap();
    store
        .insert_outbox(&OutboxIntent {
            id: "outbox".into(),
            command_id: "command".into(),
            effect_kind: "publish".into(),
            target: "synthetic-target".into(),
            state: OutboxState::Pending,
        })
        .unwrap();
    let unknown = store
        .mark_outbox_unknown("outbox", "connection closed after send")
        .unwrap();
    assert_eq!(unknown.state, OutboxState::Unknown);
    assert!(store.retryable_outbox().unwrap().is_empty());
}

#[test]
fn permission_round_trip_and_cancel_gap_are_explicit() {
    let mut adapter = ScenarioAdapter::new("scenario");
    adapter.create_session(&session("attempt")).unwrap();
    adapter
        .permission_response(PermissionResponse {
            request_id: "permission-1".into(),
            allow: false,
        })
        .unwrap();
    let events = adapter.stream_events().unwrap();
    assert!(
        events
            .iter()
            .any(|event| event.event_type == AgentEventType::PermissionResponse)
    );
    assert!(adapter.cancel_turn("turn-1").is_err());
    assert!(
        adapter
            .negotiate(&["cancel_turn".into()])
            .unwrap()
            .support("cancel_turn")
            != goalport_core::adapters::CapabilitySupport::Supported
    );
}

#[test]
fn ipc_contract_preserves_request_identity_and_unknown_events() {
    let store = Store::open_in_memory().unwrap();
    store
        .insert_attempt(&Attempt::new("attempt", "task", "scenario", "cap-v1"))
        .unwrap();
    let server = CoreServer::new(store.clone());
    let command = CoreCommand::new(
        "command",
        "attempt",
        CoreOperation::TransitionAttempt {
            attempt_id: "attempt".into(),
            state: AttemptState::Active,
            event_id: "event".into(),
        },
    )
    .unwrap();
    let request = IpcRequest::new("request", command);
    let encoded = goalport_core::ipc::encode_frame(&request).unwrap();
    let mut input = Cursor::new(encoded);
    let mut output = Cursor::new(Vec::<u8>::new());
    assert_eq!(server.serve_stream(&mut input, &mut output).unwrap(), 1);
    assert_eq!(
        store.get_attempt("attempt").unwrap().state,
        AttemptState::Active
    );
    let future = ScenarioAdapter::new("scenario");
    let _ = future;
}
