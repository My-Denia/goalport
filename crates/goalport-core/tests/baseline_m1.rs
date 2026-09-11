use goalport_core::{
    Attempt, Event, Evidence, Store, Verdict,
    adapters::{AgentAdapter, ScenarioAdapter, SessionRequest},
};
use std::{env, path::PathBuf, time::Instant};

fn requested(name: &str, default: i64) -> i64 {
    env::var(name)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
        .max(1)
}

#[test]
fn baseline_persists_requested_events_history_and_reconnects() {
    let event_target = requested("GOALPORT_BASELINE_EVENTS", 10_000);
    let history_target = requested("GOALPORT_BASELINE_HISTORY", 1_000);
    let reconnect_target = requested("GOALPORT_BASELINE_RECONNECTS", 20);
    let started = Instant::now();
    let store = Store::open_in_memory().unwrap();
    store
        .insert_attempt(&Attempt::new("attempt", "task", "scenario", "cap-v1"))
        .unwrap();
    for sequence in 1..=event_target {
        store
            .append_event(&Event {
                id: format!("event-{sequence}"),
                attempt_id: "attempt".into(),
                seq: sequence,
                kind: "message.delta".into(),
                payload_ref: None,
            })
            .unwrap();
    }
    for index in 0..history_target {
        store
            .insert_evidence(&Evidence {
                id: format!("evidence-{index}"),
                attempt_id: "attempt".into(),
                claim: format!("history-{index}"),
                snapshot_hash: "snapshot".into(),
                verdict: Verdict::Claimed,
            })
            .unwrap();
    }
    let mut adapter = ScenarioAdapter::new("scenario");
    let session = adapter
        .create_session(&SessionRequest {
            campaign_id: Some("campaign".into()),
            task_id: "task".into(),
            attempt_id: "attempt".into(),
            workspace_root: PathBuf::from("."),
            resume_session: None,
        })
        .unwrap();
    for _ in 0..reconnect_target {
        adapter.resume_session(&session.session_id).unwrap();
    }
    let counts = store.counts().unwrap();
    assert_eq!(counts.events, event_target);
    assert_eq!(counts.evidence, history_target);
    assert_eq!(
        adapter.current_session().unwrap().session_id,
        session.session_id
    );
    let elapsed = started.elapsed().as_millis();
    println!(
        "events={} history={} reconnects={} elapsed_ms={}",
        counts.events, counts.evidence, reconnect_target, elapsed
    );
}
