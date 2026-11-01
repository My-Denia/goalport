use goalport_core::{Attempt, AttemptState};

#[test]
fn direct_and_revised_attempts_close_without_reactivation() {
    for (name, path) in [
        ("direct", vec![AttemptState::Active, AttemptState::AwaitingReview, AttemptState::Closed]),
        ("revised", vec![AttemptState::Active, AttemptState::AwaitingReview, AttemptState::Active, AttemptState::AwaitingReview, AttemptState::Closed]),
    ] {
        let mut attempt = Attempt::new(format!("attempt-{name}"), "task", "scenario", "cap-v1");
        assert_eq!(attempt.state, AttemptState::Queued);
        for state in path {
            attempt.transition(state).unwrap();
            assert_eq!(attempt.state, state, "{name}");
        }
        assert!(attempt.state.is_terminal());
        assert!(attempt.transition(AttemptState::Active).is_err(), "{name}");
    }
}
