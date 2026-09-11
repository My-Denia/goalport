#![cfg(windows)]

use goalport_core::{PromptRequest, RuntimeManager, SessionRequest};
use std::path::PathBuf;

#[test]
#[ignore = "requires the owner's installed native Codex subscription"]
fn runtime_manager_creates_codex_app_server_session() {
    let mut manager = RuntimeManager::new();
    let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../goal-runs/goalport-electron-stable-v1/fixtures/synthetic-workspace");
    let summary = manager
        .select_runtime("native-attempt", "codex", None, "0.152.0", &workspace)
        .unwrap();
    assert_eq!(summary.protocol, "codex.app-server.v2");
    let result = manager
        .create_session(
            "native-attempt",
            &SessionRequest {
                campaign_id: Some("native-campaign".into()),
                task_id: "native-task".into(),
                attempt_id: "native-attempt".into(),
                workspace_root: workspace,
                resume_session: None,
            },
        )
        .unwrap();
    assert!(!result.handle.session_id.is_empty());
}

#[test]
#[ignore = "requires the owner's installed native Codex subscription"]
fn runtime_manager_streams_normalized_codex_events_after_send() {
    let mut manager = RuntimeManager::new();
    let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../goal-runs/goalport-electron-stable-v1/fixtures/synthetic-workspace");
    manager
        .select_runtime("native-send", "codex", None, "0.152.0", &workspace)
        .unwrap();
    manager
        .create_session(
            "native-send",
            &SessionRequest {
                campaign_id: Some("native-campaign".into()),
                task_id: "native-task".into(),
                attempt_id: "native-send".into(),
                workspace_root: workspace,
                resume_session: None,
            },
        )
        .unwrap();
    let sent = manager
        .send_prompt(
            "native-send",
            &PromptRequest {
                attempt_id: "native-send".into(),
                text: "Reply exactly GOALPORT_CONNECTED_OK. Do not use tools or modify files."
                    .into(),
                idempotency_key: "native-send-request".into(),
            },
        )
        .unwrap();
    assert!(sent.accepted);
    let mut events = Vec::new();
    for _ in 0..60 {
        events.extend(manager.poll_events("native-send").unwrap());
        if events.iter().any(|event| {
            matches!(
                event.event_type,
                goalport_core::AgentEventType::TurnCompleted
                    | goalport_core::AgentEventType::TurnFailed
            )
        }) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
    assert!(
        events
            .iter()
            .any(|event| event.event_type == goalport_core::AgentEventType::MessageDelta)
    );
    assert!(
        events
            .iter()
            .any(|event| event.event_type == goalport_core::AgentEventType::TurnCompleted)
    );
    let serialized = serde_json::to_string(&events).unwrap();
    assert!(!serialized.contains("rateLimits"));
    assert!(!serialized.contains("sourcePath"));
    assert!(!serialized.contains("C:\\\\Users"));
}
