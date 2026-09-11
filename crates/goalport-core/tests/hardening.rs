use goalport_core::{
    AccessMode, Attempt, OutboxIntent, OutboxState, Store, WorkspaceLease,
    adapters::ClaudeCliAdapter,
    ipc::{IpcError, MAX_FRAME_BYTES, decode_frame},
};
use std::time::Instant;

#[test]
fn malformed_protocol_and_unknown_effects_fail_closed() {
    let started = Instant::now();
    let malformed = format!(
        r#"{{"type":"future","payload":{{"value":"{}"}}}}"#,
        "redacted"
    );
    let event = ClaudeCliAdapter::parse_event_line(&malformed).unwrap();
    assert_eq!(event.event_type, goalport_core::AgentEventType::Unknown);
    let mut oversized = (MAX_FRAME_BYTES as u32 + 1).to_le_bytes().to_vec();
    oversized.extend_from_slice(&[0; 4]);
    assert!(matches!(
        decode_frame::<goalport_core::IpcRequest>(&oversized),
        Err(IpcError::FrameTooLarge(_))
    ));
    let store = Store::open_in_memory().unwrap();
    store
        .insert_attempt(&Attempt::new("attempt", "task", "scenario", "cap-v1"))
        .unwrap();
    store
        .insert_outbox(&OutboxIntent {
            id: "outbox".into(),
            command_id: "command".into(),
            effect_kind: "external".into(),
            target: "synthetic".into(),
            state: OutboxState::Pending,
        })
        .unwrap();
    assert_eq!(
        store
            .mark_outbox_unknown("outbox", "receipt unavailable")
            .unwrap()
            .state,
        OutboxState::Unknown
    );
    assert!(
        store
            .acquire_lease(&WorkspaceLease::new(".", "attempt", AccessMode::Mutating))
            .is_ok()
    );
    println!("wall_clock_seconds={:.3}", started.elapsed().as_secs_f64());
}
