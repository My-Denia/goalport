use goalport_core::{
    AccessMode, Attempt, AttemptState, Campaign, CommandState, CoreCommand, CoreOperation, Event,
    Evidence, OutboxIntent, OutboxState, Project, Store, Task, Verdict, WorkStatus, WorkspaceLease,
};

fn store_with_attempt() -> Store {
    let store = Store::open_in_memory().unwrap();
    store
        .insert_attempt(&Attempt::new("attempt", "task", "scenario", "cap-v1"))
        .unwrap();
    store
}

#[test]
fn project_is_persisted() {
    let store = Store::open_in_memory().unwrap();
    let project = Project {
        id: "project".into(),
        workspace_root: "C:\\project".into(),
    };
    store.insert_project(&project).unwrap();
    assert_eq!(store.get_project("project").unwrap(), project);
}

#[test]
fn campaign_is_persisted() {
    let store = Store::open_in_memory().unwrap();
    let campaign = Campaign {
        id: "campaign".into(),
        goal: "goal".into(),
        root_task_id: "task".into(),
        state: WorkStatus::InProgress,
    };
    store.insert_campaign(&campaign).unwrap();
    assert_eq!(store.get_campaign("campaign").unwrap(), campaign);
}

#[test]
fn task_is_persisted() {
    let store = Store::open_in_memory().unwrap();
    let task = Task {
        id: "task".into(),
        campaign_id: "campaign".into(),
        title: "title".into(),
        acceptance: "tests".into(),
        state: WorkStatus::InProgress,
    };
    store.insert_task(&task).unwrap();
    assert_eq!(store.get_task("task").unwrap(), task);
}

#[test]
fn attempt_starts_queued() {
    let store = store_with_attempt();
    assert_eq!(
        store.get_attempt("attempt").unwrap().state,
        AttemptState::Queued
    );
}

#[test]
fn queued_attempt_can_become_active() {
    let store = store_with_attempt();
    store
        .append_event(&Event {
            id: "active".into(),
            attempt_id: "attempt".into(),
            seq: 1,
            kind: "attempt.active".into(),
            payload_ref: None,
        })
        .unwrap();
    assert_eq!(
        store.get_attempt("attempt").unwrap().state,
        AttemptState::Active
    );
}

#[test]
fn active_attempt_can_await_review() {
    let store = store_with_attempt();
    store
        .append_event(&Event {
            id: "active".into(),
            attempt_id: "attempt".into(),
            seq: 1,
            kind: "attempt.active".into(),
            payload_ref: None,
        })
        .unwrap();
    store
        .append_event(&Event {
            id: "review".into(),
            attempt_id: "attempt".into(),
            seq: 2,
            kind: "attempt.awaiting_review".into(),
            payload_ref: None,
        })
        .unwrap();
    assert_eq!(
        store.get_attempt("attempt").unwrap().state,
        AttemptState::AwaitingReview
    );
}

#[test]
fn review_can_continue_for_repair() {
    let mut attempt = Attempt::new("attempt", "task", "scenario", "cap-v1");
    attempt.transition(AttemptState::Active).unwrap();
    attempt.transition(AttemptState::AwaitingReview).unwrap();
    attempt.transition(AttemptState::Active).unwrap();
    assert_eq!(attempt.state, AttemptState::Active);
}

#[test]
fn review_can_close_without_rewriting_history() {
    let mut attempt = Attempt::new("attempt", "task", "scenario", "cap-v1");
    attempt.transition(AttemptState::Active).unwrap();
    attempt.transition(AttemptState::AwaitingReview).unwrap();
    attempt.transition(AttemptState::Closed).unwrap();
    assert!(attempt.state.is_terminal());
}

#[test]
fn duplicate_event_does_not_increment_projection() {
    let store = store_with_attempt();
    let event = Event {
        id: "active".into(),
        attempt_id: "attempt".into(),
        seq: 1,
        kind: "attempt.active".into(),
        payload_ref: None,
    };
    store.append_event(&event).unwrap();
    store.append_event(&event).unwrap();
    assert_eq!(store.get_attempt("attempt").unwrap().last_event_seq, 1);
}

#[test]
fn event_gap_is_rejected() {
    let store = store_with_attempt();
    let event = Event {
        id: "gap".into(),
        attempt_id: "attempt".into(),
        seq: 2,
        kind: "message.delta".into(),
        payload_ref: None,
    };
    assert!(store.append_event(&event).is_err());
}

#[test]
fn stale_evidence_is_visible_without_rewriting_verdict() {
    let store = store_with_attempt();
    let evidence = Evidence {
        id: "evidence".into(),
        attempt_id: "attempt".into(),
        claim: "claim".into(),
        snapshot_hash: "old".into(),
        verdict: Verdict::Verified,
    };
    store.insert_evidence(&evidence).unwrap();
    assert!(store.evidence_is_stale("evidence", "new").unwrap());
    assert_eq!(
        store.get_evidence("evidence").unwrap().verdict,
        Verdict::Verified
    );
}

#[test]
fn active_mutating_lease_is_recorded() {
    let store = store_with_attempt();
    let lease = store
        .acquire_lease(&WorkspaceLease::new(
            "C:\\project",
            "attempt",
            AccessMode::Mutating,
        ))
        .unwrap();
    assert_eq!(lease.state, goalport_core::LeaseState::Active);
}

#[test]
fn unknown_lease_access_is_treated_as_mutating() {
    let store = store_with_attempt();
    store
        .acquire_lease(&WorkspaceLease::new(
            "C:\\project",
            "attempt",
            AccessMode::Unknown,
        ))
        .unwrap();
    assert!(
        store
            .acquire_lease(&WorkspaceLease::new(
                "C:\\project\\nested",
                "other",
                AccessMode::Mutating
            ))
            .is_err()
    );
}

#[test]
fn unknown_outbox_is_not_retryable() {
    let store = store_with_attempt();
    store
        .insert_outbox(&OutboxIntent {
            id: "outbox".into(),
            command_id: "command".into(),
            effect_kind: "publish".into(),
            target: "synthetic".into(),
            state: OutboxState::Pending,
        })
        .unwrap();
    store.mark_outbox_unknown("outbox", "ack missing").unwrap();
    assert!(store.retryable_outbox().unwrap().is_empty());
}

#[test]
fn command_path_is_idempotent() {
    let store = store_with_attempt();
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
    let processor = goalport_core::CommandProcessor::new(store.clone());
    processor.execute(command.clone()).unwrap();
    assert!(processor.execute(command).unwrap().duplicate);
    assert_eq!(
        store.get_command("command").unwrap().state,
        CommandState::Succeeded
    );
}
