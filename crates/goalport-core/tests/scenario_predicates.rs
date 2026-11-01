use goalport_core::{AgentAdapter, PromptRequest, ScenarioAdapter, SessionRequest};
use std::{path::PathBuf, process::Command};

#[test]
fn retired_scenario_cli_never_reports_a_pass() {
    for args in [
        vec!["scenario"],
        vec!["scenario", "--id", "DUR-01"],
        vec!["scenario", "--id", "SEC-01"],
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_goalport-core"))
            .args(&args)
            .output()
            .expect("core binary should start");
        assert!(!output.status.success(), "{args:?} unexpectedly succeeded");
        assert!(output.stdout.is_empty(), "{args:?} emitted a report");
        assert!(
            String::from_utf8_lossy(&output.stderr).contains("scenario command was retired"),
            "{args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

#[test]
fn closed_scenario_adapter_rejects_prompt_and_resume() {
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
    adapter.close().unwrap();
    assert!(
        adapter
            .send_prompt(&PromptRequest {
                attempt_id: "attempt".into(),
                text: "hello".into(),
                idempotency_key: "command".into(),
            })
            .is_err()
    );
    assert!(adapter.resume_session(&session.session_id).is_err());
}
