use goalport_core::{
    AgentEventType, PromptRequest, ScenarioAdapter, SessionRequest,
    adapters::{
        AgentAdapter, ClaudeCliAdapter, CodexAppServerAdapter, CompatibilityPolicy, GrokAcpAdapter,
    },
};
use std::path::PathBuf;

fn request(attempt: &str) -> SessionRequest {
    SessionRequest {
        campaign_id: Some("campaign".into()),
        task_id: "task".into(),
        attempt_id: attempt.into(),
        workspace_root: PathBuf::from("."),
        resume_session: None,
    }
}

#[test]
fn scenario_adapter_exposes_runtime_identity() {
    assert_eq!(
        ScenarioAdapter::new("scenario").runtime_identity().provider,
        "scenario"
    );
}

#[test]
fn scenario_adapter_creates_a_native_owned_session() {
    let mut adapter = ScenarioAdapter::new("scenario");
    let session = adapter.create_session(&request("attempt")).unwrap();
    assert!(session.session_id.contains("attempt"));
}

#[test]
fn scenario_adapter_streams_session_event() {
    let mut adapter = ScenarioAdapter::new("scenario");
    adapter.create_session(&request("attempt")).unwrap();
    assert!(
        adapter
            .stream_events()
            .unwrap()
            .iter()
            .any(|event| event.event_type == AgentEventType::SessionCreated)
    );
}

#[test]
fn scenario_adapter_continues_same_attempt_on_resume() {
    let mut adapter = ScenarioAdapter::new("scenario");
    let session = adapter.create_session(&request("attempt")).unwrap();
    let resumed = adapter.resume_session(&session.session_id).unwrap();
    assert!(resumed.resumed);
    assert_eq!(resumed.session_id, session.session_id);
}

#[test]
fn scenario_adapter_does_not_resend_same_prompt() {
    let mut adapter = ScenarioAdapter::new("scenario");
    adapter.create_session(&request("attempt")).unwrap();
    let prompt = PromptRequest {
        attempt_id: "attempt".into(),
        text: "one".into(),
        idempotency_key: "idempotent".into(),
    };
    adapter.send_prompt(&prompt).unwrap();
    adapter.send_prompt(&prompt).unwrap();
    assert_eq!(adapter.sent_prompts(), &["one"]);
}

#[test]
fn scenario_adapter_reports_cancel_gap() {
    let mut adapter = ScenarioAdapter::new("scenario");
    assert!(adapter.cancel_turn("turn").is_err());
}

#[test]
fn codex_argv_is_versioned_without_prompt() {
    let argv = CodexAppServerAdapter::build_argv("codex", ".", None);
    assert_eq!(argv, vec!["codex", "app-server", "--json"]);
}

#[test]
fn grok_argv_is_versioned_without_prompt() {
    let argv = GrokAcpAdapter::build_argv("grok", ".", None);
    assert_eq!(argv, vec!["grok", "agent", "stdio"]);
}

#[test]
fn claude_argv_uses_structured_stream_json() {
    let argv = ClaudeCliAdapter::spawn_argv("claude", ".", None);
    assert_eq!(
        argv,
        vec![
            "claude",
            "-p",
            "--output-format",
            "stream-json",
            "--input-format",
            "stream-json",
            "--verbose",
            "--permission-prompts",
            "host",
            "--permission-mode",
            "manual",
            "--permission-prompt-tool",
            "stdio",
            "--replay-user-messages",
        ]
    );
    assert!(ClaudeCliAdapter::spawn_argv_keeps_native_permissions(&argv));
}

#[test]
fn spawn_argv_keeps_native_permissions() {
    let argv = ClaudeCliAdapter::protocol_argv(std::path::Path::new("."));
    assert!(argv.contains(&"--permission-prompts"));
    assert!(argv.contains(&"host"));
    assert!(argv.contains(&"--permission-mode"));
    assert!(argv.contains(&"manual"));
    assert!(argv.contains(&"--permission-prompt-tool"));
    assert!(argv.contains(&"stdio"));
    assert!(!argv.contains(&"--bare"));
    assert!(!argv.contains(&"--dangerously-skip-permissions"));
    assert!(!argv.contains(&"none"));
}

#[test]
fn real_adapter_preflight_never_invokes_runtime() {
    let adapter = CodexAppServerAdapter::new("missing-codex", "0.151.0", ".");
    let result = adapter.preflight_result();
    assert!(!result.invoked_runtime);
    assert!(
        !result.checked_executable
            || result.status == goalport_core::PreflightStatus::RuntimeMissing
    );
}

#[test]
fn structured_event_parser_maps_permission() {
    let event = GrokAcpAdapter::parse_event_line(
        r#"{"type":"permission_request","seq":1,"attempt_id":"a","task_id":"t"}"#,
    )
    .unwrap();
    assert_eq!(event.event_type, AgentEventType::PermissionRequest);
}

#[test]
fn scenario_capabilities_are_explicitly_negotiated() {
    let mut adapter = ScenarioAdapter::new("scenario");
    let capabilities = adapter.negotiate(&["resume".into()]).unwrap();
    assert_eq!(
        capabilities.support("resume"),
        goalport_core::CapabilitySupport::Supported
    );
    assert_eq!(
        adapter
            .preflight(CompatibilityPolicy::Strict)
            .unwrap()
            .status,
        goalport_core::PreflightStatus::Ready
    );
}
