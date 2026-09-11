use goalport_core::{Attempt, AttemptState};
use std::env;

#[test]
fn generated_state_traces_preserve_attempt_invariants() {
    let traces = env::var("GOALPORT_STATE_MACHINE_TRACES")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(1_000)
        .max(1);
    for index in 0..traces {
        let mut attempt = Attempt::new(format!("attempt-{index}"), "task", "scenario", "cap-v1");
        assert_eq!(attempt.state, AttemptState::Queued);
        attempt.transition(AttemptState::Active).unwrap();
        if index % 2 == 0 {
            attempt.transition(AttemptState::AwaitingReview).unwrap();
            attempt.transition(AttemptState::Active).unwrap();
        }
        attempt.transition(AttemptState::AwaitingReview).unwrap();
        attempt.transition(AttemptState::Closed).unwrap();
        assert!(attempt.state.is_terminal());
        assert!(attempt.transition(AttemptState::Active).is_err());
    }
    println!("traces={traces}");
}
