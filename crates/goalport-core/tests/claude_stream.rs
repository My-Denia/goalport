//! Fail-closed contract tests for the persistent Claude stream-json adapter.
//!
//! Drives `ClaudeStreamProcess` against `tests/fixtures/fake-claude-cli/`.
//! Named cases are the AC3a predicates.
#![cfg(windows)]

use goalport_core::{
    AgentEventEnvelope, AgentEventType, PermissionResponse, Project, PromptRequest, RuntimeManager,
    SessionRequest,
    adapters::ClaudeCliAdapter,
    ipc::{CONNECTED_UI_PROTOCOL_VERSION, CoreServer},
    product_receipts::{begin_startup_epoch, complete_startup_epoch},
    store::Store,
};
use serde_json::{Value, json};
use std::{
    env, fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};

fn fake_cli() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/fake-claude-cli/fake-claude-cli.cmd")
}

fn fixture_workspace(name: &str, scenario: &str) -> PathBuf {
    // The default used to be `../../goal-runs/claude-native-stop-product/evidence/
    // test-artifacts`, i.e. INSIDE a completed run's evidence directory. Every plain
    // `cargo test` therefore wrote fixture workspaces into a protected historical
    // asset -- 5688 files by the time an auditor measured it. Default to a cleanable
    // system temp directory instead; set GOALPORT_TEST_ARTIFACT_ROOT to retain them
    // somewhere deliberate.
    let artifact_root = env::var_os("GOALPORT_TEST_ARTIFACT_ROOT").map(PathBuf::from)
        .unwrap_or_else(|| env::temp_dir().join("goalport-test-artifacts"));
    let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let dir = artifact_root.join(format!("{name}-{nonce}"));
    fs::create_dir_all(&dir).expect("fixture workspace should be creatable");
    fs::create_dir_all(dir.join("notes")).expect("notes dir");
    fs::write(dir.join(".fake-claude-scenario"), scenario).expect("scenario file");
    dir
}

fn session_request(attempt: &str, workspace: &Path) -> SessionRequest {
    SessionRequest {
        campaign_id: Some("campaign-fake".into()),
        task_id: "task-fake".into(),
        attempt_id: attempt.into(),
        workspace_root: workspace.to_path_buf(),
        resume_session: None,
    }
}

fn attach(attempt: &str, workspace: &Path) -> RuntimeManager {
    let mut manager = RuntimeManager::new();
    let summary = manager
        .select_runtime(attempt, "claude", Some(fake_cli()), "2.1.259", workspace)
        .expect("claude runtime should be selectable");
    assert_eq!(summary.provider, "claude");
    assert_eq!(summary.protocol, "claude.cli.stream-json.v1");
    let session = manager
        .create_session(attempt, &session_request(attempt, workspace))
        .expect("claude stream-json session should be created");
    assert!(
        session.handle.session_id.is_empty(),
        "create_session must not manufacture a provider session id, got {}",
        session.handle.session_id
    );
    assert!(!session.handle.resumed);
    manager
}

fn send(manager: &mut RuntimeManager, attempt: &str) -> Vec<AgentEventEnvelope> {
    manager
        .send_prompt(
            attempt,
            &PromptRequest {
                attempt_id: attempt.into(),
                text: "fixture prompt".into(),
                idempotency_key: format!("{attempt}-1"),
            },
        )
        .expect("prompt should be accepted")
        .events
}

fn drain_until(
    manager: &mut RuntimeManager,
    attempt: &str,
    done: impl Fn(&[AgentEventEnvelope]) -> bool,
) -> Vec<AgentEventEnvelope> {
    let mut events = Vec::new();
    for _ in 0..600 {
        events.extend(manager.poll_events(attempt).expect("poll should not fail"));
        if done(&events) {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    events
}

/// Poll for a fixed wall-clock window without stopping at the first terminal.
/// The AC6c B path is time-bounded, so "nothing happened yet" is an assertion
/// target of its own.
fn poll_for(
    manager: &mut RuntimeManager,
    attempt: &str,
    window: Duration,
) -> Vec<AgentEventEnvelope> {
    let deadline = std::time::Instant::now() + window;
    let mut events = Vec::new();
    while std::time::Instant::now() < deadline {
        events.extend(manager.poll_events(attempt).expect("poll should not fail"));
        std::thread::sleep(Duration::from_millis(50));
    }
    events
}

fn has(events: &[AgentEventEnvelope], event_type: AgentEventType) -> bool {
    events.iter().any(|event| event.event_type == event_type)
}

fn terminal_stops(events: &[AgentEventEnvelope]) -> Vec<&AgentEventEnvelope> {
    events
        .iter()
        .filter(|event| {
            event.event_type == AgentEventType::Cancelled
                || event.event_type == AgentEventType::TurnFailed
        })
        .collect()
}

fn stop_attempt(payload: &Value) -> &Value {
    payload
        .get("stop_attempt")
        .unwrap_or_else(|| panic!("stop payload must carry a stop_attempt trace: {payload}"))
}

fn first(events: &[AgentEventEnvelope], event_type: AgentEventType) -> &AgentEventEnvelope {
    events
        .iter()
        .find(|event| event.event_type == event_type)
        .unwrap_or_else(|| panic!("expected a {event_type:?} event, saw {events:#?}"))
}

fn read_json(workspace: &Path, name: &str) -> Value {
    serde_json::from_str(&fs::read_to_string(workspace.join(name)).unwrap_or_else(|error| {
        panic!("{} missing in {}: {error}", name, workspace.display())
    }))
    .expect("json")
}

#[test]
fn native_stop_exact_input_and_reordered_receipt_keep_residual_held() {
    for scenario in ["native_stop_positive", "native_stop_reordered"] {
        let workspace=fixture_workspace(scenario,scenario);
        let mut manager=attach(scenario,&workspace);
        send(&mut manager,scenario);
        drain_until(&mut manager,scenario,|seen|has(seen,AgentEventType::ToolActivity));
        let binding=manager.claude_turn_binding(scenario).expect("active binding");
        let stop=manager.interrupt_with_operation(scenario,"gui-operation-exact").unwrap();
        assert!(stop.requested && !stop.confirmed);
        let events=drain_until(&mut manager,scenario,|seen|has(seen,AgentEventType::Cancelled));
        let event=first(&events,AgentEventType::Cancelled);
        assert_eq!(event.payload["native_turn_cancel"],true);
        assert_eq!(event.payload["stop_operation_id"],"gui-operation-exact");
        assert_eq!(event.payload["input_uuid"],binding["input_uuid"]);
        assert_eq!(event.payload["session_id"],binding["session_id"]);
        assert_eq!(event.payload["safe_process_stop"],false);
        assert_eq!(event.payload["residual_execution_state"],"unknown");
        assert_eq!(event.payload["write_responsibility"],"held");
        let later=poll_for(&mut manager,scenario,Duration::from_millis(300));
        assert!(!has(&later,AgentEventType::Cancelled),"duplicate result cannot resolve twice");
        if scenario=="native_stop_positive" {
            assert!(workspace.join("post-result.txt").is_file(),"preserve actual post-result write counterexample");
            assert!(later.iter().any(|e|e.payload.pointer("/claude_native_frame/type")==Some(&json!("user"))),"late tool frame must remain journaled");
        }
        assert!(manager.send_prompt(scenario,&PromptRequest{attempt_id:scenario.into(),text:"conflict".into(),idempotency_key:"new-input".into()}).is_err());
        manager.interrupt_with_operation(scenario,"duplicate-gui-operation").unwrap();
        assert!(poll_for(&mut manager,scenario,Duration::from_millis(100)).iter().all(|e|e.event_type!=AgentEventType::Cancelled));
        manager.close_attempt(scenario).ok();
    }
}

#[test]
fn native_stop_foreign_missing_denial_error_normal_or_bad_receipt_never_confirms() {
    for scenario in ["native_stop_foreign","native_stop_missing","native_stop_denial",
        "native_stop_error","native_stop_normal","native_stop_origin","native_stop_receipt_error","native_stop_no_receipt"] {
        let workspace=fixture_workspace(scenario,scenario);
        let mut manager=attach(scenario,&workspace);
        send(&mut manager,scenario);
        drain_until(&mut manager,scenario,|seen|has(seen,AgentEventType::ToolActivity));
        manager.interrupt_with_operation(scenario,"gui-negative").unwrap();
        let events=drain_until(&mut manager,scenario,|seen|has(seen,AgentEventType::TurnFailed));
        let event=first(&events,AgentEventType::TurnFailed);
        assert_eq!(event.payload["native_turn_cancel"],false,"{scenario}");
        assert_eq!(event.payload["safe_process_stop"],false,"{scenario}");
        assert_eq!(event.payload["write_responsibility"],"held","{scenario}");
        assert!(!has(&events,AgentEventType::Cancelled),"{scenario}");
        manager.close_attempt(scenario).ok();
    }
}

fn fail_open_true(events: &[AgentEventEnvelope]) -> bool {
    events
        .iter()
        .any(|event| event.payload.get("fail_open") == Some(&json!(true)))
}

fn without_host_decision(events: &[AgentEventEnvelope]) -> bool {
    events.iter().any(|event| {
        event.payload.get("mutating_tool_without_host_decision") == Some(&json!(true))
    })
}

fn serialized_contains(events: &[AgentEventEnvelope], needle: &str) -> bool {
    serde_json::to_string(events)
        .expect("serialize")
        .contains(needle)
}

#[test]
fn spawn_argv_keeps_native_permissions() {
    let workspace = fixture_workspace("argv", "end_turn");
    let mut manager = attach("attempt-argv", &workspace);
    let _ = send(&mut manager, "attempt-argv");
    let dumped = read_json(&workspace, ".fake-claude-argv.json");
    let argv = dumped["argv"]
        .as_array()
        .expect("argv array")
        .iter()
        .map(|value| value.as_str().unwrap_or_default().to_owned())
        .collect::<Vec<_>>();
    assert!(argv.windows(2).any(|window| window == ["--permission-prompts", "host"]));
    assert!(argv.windows(2).any(|window| window == ["--permission-mode", "manual"]));
    assert!(argv.windows(2).any(|window| window == ["--permission-prompt-tool", "stdio"]));
    assert!(argv.windows(2).any(|window| window == ["--output-format", "stream-json"]));
    assert!(argv.windows(2).any(|window| window == ["--input-format", "stream-json"]));
    assert!(argv.iter().any(|flag| flag == "--replay-user-messages"));
    assert!(!argv.iter().any(|flag| flag == "--bare"));
    assert!(!argv.iter().any(|flag| flag == "--dangerously-skip-permissions"));
    assert!(!argv.windows(2).any(|window| window == ["--permission-prompts", "none"]));
    let adapter = ClaudeCliAdapter::spawn_argv("claude", ".", None);
    assert!(ClaudeCliAdapter::spawn_argv_keeps_native_permissions(&adapter));
}

#[test]
fn token_stream_emits_one_message_delta() {
    let workspace = fixture_workspace("token-stream", "token_stream");
    let mut manager = attach("attempt-token-stream", &workspace);
    let mut events = send(&mut manager, "attempt-token-stream");
    events.extend(drain_until(&mut manager, "attempt-token-stream", |seen| {
        has(seen, AgentEventType::TurnCompleted)
    }));
    let deltas: Vec<_> = events
        .iter()
        .filter(|event| event.event_type == AgentEventType::MessageDelta)
        .collect();
    assert_eq!(
        deltas.len(),
        1,
        "each stream-json token must not become its own message: {events:#?}"
    );
    assert_eq!(deltas[0].payload["text"], "HELLO");
}

#[test]
fn duplicate_assistant_text_is_one_message_delta() {
    let workspace = fixture_workspace("dup-text", "duplicate_text");
    let mut manager = attach("attempt-dup-text", &workspace);
    let mut events = send(&mut manager, "attempt-dup-text");
    events.extend(drain_until(&mut manager, "attempt-dup-text", |seen| {
        has(seen, AgentEventType::TurnCompleted)
    }));
    let deltas: Vec<_> = events
        .iter()
        .filter(|event| event.event_type == AgentEventType::MessageDelta)
        .collect();
    assert_eq!(
        deltas.len(),
        1,
        "identical assistant snapshots must not become two cards: {events:#?}"
    );
    assert_eq!(deltas[0].payload["text"], "SAME_REPLY");
}

#[test]
fn initialize_precedes_first_user_message() {
    let workspace = fixture_workspace("init-order", "end_turn");
    let mut manager = attach("attempt-init-order", &workspace);
    let _ = send(&mut manager, "attempt-init-order");
    let _ = drain_until(&mut manager, "attempt-init-order", |seen| {
        has(seen, AgentEventType::TurnCompleted)
    });
    let types = read_json(&workspace, ".fake-claude-stdin-types.json");
    let rows = types.as_array().expect("stdin types");
    assert!(
        rows.len() >= 2,
        "expected initialize then user, got {rows:?}"
    );
    assert_eq!(rows[0]["type"], "control_request");
    assert_eq!(rows[0]["subtype"], "initialize");
    assert!(
        rows.iter().any(|row| row["type"] == "user"),
        "user message missing: {rows:?}"
    );
    let user_index = rows.iter().position(|row| row["type"] == "user").unwrap();
    assert!(user_index > 0, "user must not be the first stdin frame");
    assert!(
        !workspace.join(".fake-claude-order-error.json").exists(),
        "fake CLI recorded user-before-initialize"
    );
}

#[test]
fn permission_allow_once_replies_to_same_request_id() {
    let workspace = fixture_workspace("allow-once", "allow_once");
    let mut manager = attach("attempt-allow", &workspace);
    let mut events = send(&mut manager, "attempt-allow");
    events.extend(drain_until(&mut manager, "attempt-allow", |seen| {
        has(seen, AgentEventType::PermissionRequest)
    }));
    let request = first(&events, AgentEventType::PermissionRequest);
    let request_id = request.payload["request_id"]
        .as_str()
        .expect("Decision id")
        .to_owned();
    assert!(request_id.starts_with("claude-"));
    assert!(request_id.contains("11111111-2222-4333-8444-555555555555"));

    manager
        .permission_response(
            "attempt-allow",
            PermissionResponse {
                request_id: request_id.clone(),
                allow: true,
            },
        )
        .expect("allow should be delivered");

    events.extend(drain_until(&mut manager, "attempt-allow", |seen| {
        has(seen, AgentEventType::TurnCompleted)
    }));
    let response = first(&events, AgentEventType::PermissionResponse);
    assert_eq!(response.payload["request_id"], request_id.as_str());
    assert_eq!(response.payload["option_kind"], "allow_once");
    assert_eq!(response.payload["allow"], true);
    let native = read_json(&workspace, ".fake-claude-last-permission-response.json");
    assert_eq!(native["request_id"], "11111111-2222-4333-8444-555555555555");
    assert_eq!(native["body"]["behavior"], "allow");
    assert!(native["body"]["updatedInput"].is_object());
    assert!(native["body"].get("updatedPermissions").is_none());
    assert_eq!(
        fs::read_to_string(workspace.join("notes/fixture-allow.txt")).expect("written"),
        "PROBE_WRITE_OK\n"
    );
    let serialized = serde_json::to_string(&events).expect("serialize");
    assert!(!serialized.contains("allow_always"));
    assert!(!serialized.contains("updatedPermissions"));
}

#[test]
fn permission_deny_does_not_execute_tool() {
    let workspace = fixture_workspace("deny", "deny");
    let mut manager = attach("attempt-deny", &workspace);
    let mut events = send(&mut manager, "attempt-deny");
    events.extend(drain_until(&mut manager, "attempt-deny", |seen| {
        has(seen, AgentEventType::PermissionRequest)
    }));
    let request_id = first(&events, AgentEventType::PermissionRequest).payload["request_id"]
        .as_str()
        .expect("Decision id")
        .to_owned();
    manager
        .permission_response(
            "attempt-deny",
            PermissionResponse {
                request_id,
                allow: false,
            },
        )
        .expect("deny should be delivered");
    events.extend(drain_until(&mut manager, "attempt-deny", |seen| {
        has(seen, AgentEventType::TurnCompleted)
    }));
    assert_eq!(
        first(&events, AgentEventType::PermissionResponse).payload["option_kind"],
        "reject_once"
    );
    assert!(!workspace.join("notes/fixture-allow.txt").exists());
    let native = read_json(&workspace, ".fake-claude-last-permission-response.json");
    assert_eq!(native["request_id"], "11111111-2222-4333-8444-555555555555");
    assert_eq!(native["body"]["behavior"], "deny");
}

#[test]
fn permission_deny_with_tool_result_is_not_fail_open() {
    let workspace = fixture_workspace("deny-tool-result", "deny_tool_result");
    let mut manager = attach("attempt-deny-tr", &workspace);
    let mut events = send(&mut manager, "attempt-deny-tr");
    events.extend(drain_until(&mut manager, "attempt-deny-tr", |seen| {
        has(seen, AgentEventType::PermissionRequest)
    }));
    let request_id = first(&events, AgentEventType::PermissionRequest).payload["request_id"]
        .as_str()
        .expect("Decision id")
        .to_owned();
    manager
        .permission_response(
            "attempt-deny-tr",
            PermissionResponse {
                request_id,
                allow: false,
            },
        )
        .expect("deny should be delivered");
    events.extend(drain_until(&mut manager, "attempt-deny-tr", |seen| {
        has(seen, AgentEventType::TurnCompleted) || has(seen, AgentEventType::TurnFailed)
    }));
    assert_eq!(
        first(&events, AgentEventType::PermissionResponse).payload["option_kind"],
        "reject_once"
    );
    assert!(
        !fail_open_true(&events),
        "deny + tool_result with no snapshot delta must not fail_open: {events:#?}"
    );
    assert!(
        !without_host_decision(&events),
        "host Decision existed: {events:#?}"
    );
    assert!(!workspace.join("notes/fixture-allow.txt").exists());
    let native = read_json(&workspace, ".fake-claude-last-permission-response.json");
    assert_eq!(native["request_id"], "11111111-2222-4333-8444-555555555555");
    assert_eq!(native["body"]["behavior"], "deny");
}

#[test]
fn permission_deny_that_still_writes_is_fail_open() {
    let workspace = fixture_workspace("deny-still-writes", "deny_still_writes");
    let target = workspace.join("notes/fixture-allow.txt");
    let mut manager = attach("attempt-deny-write", &workspace);
    let mut events = send(&mut manager, "attempt-deny-write");
    events.extend(drain_until(&mut manager, "attempt-deny-write", |seen| {
        has(seen, AgentEventType::PermissionRequest)
    }));
    let request_id = first(&events, AgentEventType::PermissionRequest).payload["request_id"]
        .as_str()
        .expect("Decision id")
        .to_owned();
    manager
        .permission_response(
            "attempt-deny-write",
            PermissionResponse {
                request_id,
                allow: false,
            },
        )
        .expect("deny should be delivered");
    events.extend(drain_until(&mut manager, "attempt-deny-write", |seen| {
        has(seen, AgentEventType::TurnFailed) || has(seen, AgentEventType::TurnCompleted)
    }));
    assert!(
        fail_open_true(&events),
        "deny + snapshot delta must fail_open: {events:#?}"
    );
    assert!(
        !without_host_decision(&events),
        "deny+delta is not missing a host Decision: {events:#?}"
    );
    assert!(
        !serialized_contains(&events, "without a host Decision"),
        "result-frame must echo denial-not-enforced, not missing Decision: {events:#?}"
    );
    assert_eq!(
        fs::read_to_string(&target).expect("changed file"),
        "DENIED_BUT_WROTE\n"
    );
}

#[test]
fn fail_open_when_mutating_tool_result_without_host_decision() {
    let workspace = fixture_workspace("fail-open", "fail_open");
    let mut manager = attach("attempt-fail-open", &workspace);
    let mut events = send(&mut manager, "attempt-fail-open");
    events.extend(drain_until(&mut manager, "attempt-fail-open", |seen| {
        has(seen, AgentEventType::TurnFailed)
    }));
    assert!(
        fail_open_true(&events),
        "pending mutating tool_result must fail_open: {events:#?}"
    );
    assert!(
        without_host_decision(&events),
        "pending tool_result is without a host Decision: {events:#?}"
    );
    assert!(workspace.join("notes/fixture-allow.txt").exists());
}

#[test]
fn unknown_path_is_not_safely_denied() {
    let workspace = fixture_workspace("unknown-path", "unknown_path");
    let mut manager = attach("attempt-unknown", &workspace);
    let mut events = send(&mut manager, "attempt-unknown");
    events.extend(drain_until(&mut manager, "attempt-unknown", |seen| {
        has(seen, AgentEventType::PermissionRequest)
    }));
    let request_id = first(&events, AgentEventType::PermissionRequest).payload["request_id"]
        .as_str()
        .expect("Decision id")
        .to_owned();
    manager
        .permission_response(
            "attempt-unknown",
            PermissionResponse {
                request_id,
                allow: false,
            },
        )
        .expect("deny should be delivered");
    events.extend(drain_until(&mut manager, "attempt-unknown", |seen| {
        has(seen, AgentEventType::TurnFailed) || has(seen, AgentEventType::TurnCompleted)
    }));
    assert!(
        !fail_open_true(&events),
        "denied Bash with no resolvable path is not fail_open: {events:#?}"
    );
    assert!(
        has(&events, AgentEventType::TurnFailed),
        "unresolved path must be unknown/error, not a clean success: {events:#?}"
    );
    assert!(
        !has(&events, AgentEventType::TurnCompleted),
        "unresolved path must not complete as safely-denied: {events:#?}"
    );
    let failed = first(&events, AgentEventType::TurnFailed);
    assert_eq!(failed.payload.get("unknown_effect"), Some(&json!(true)));
    assert_ne!(failed.payload.get("fail_open"), Some(&json!(true)));
}

#[test]
fn stale_or_mismatched_permission_response_is_rejected() {
    let workspace = fixture_workspace("mismatch", "mismatch");
    let mut manager = attach("attempt-mismatch", &workspace);
    let mut events = send(&mut manager, "attempt-mismatch");
    events.extend(drain_until(&mut manager, "attempt-mismatch", |seen| {
        has(seen, AgentEventType::PermissionRequest)
    }));
    let request_id = first(&events, AgentEventType::PermissionRequest).payload["request_id"]
        .as_str()
        .expect("Decision id")
        .to_owned();
    let mismatched = manager.permission_response(
        "attempt-mismatch",
        PermissionResponse {
            request_id: "claude-not-this-request".into(),
            allow: true,
        },
    );
    assert!(mismatched.is_err(), "mismatched id must be rejected");
    let err = mismatched.unwrap_err().to_string();
    assert!(
        err.contains("stale or mismatched") || err.contains("rejected"),
        "unexpected error: {err}"
    );
    assert!(!workspace.join("notes/fixture-allow.txt").exists());

    manager
        .permission_response(
            "attempt-mismatch",
            PermissionResponse {
                request_id: request_id.clone(),
                allow: true,
            },
        )
        .expect("matching id should be accepted once");
    let duplicate = manager.permission_response(
        "attempt-mismatch",
        PermissionResponse {
            request_id,
            allow: true,
        },
    );
    assert!(duplicate.is_err(), "duplicate response must be rejected");
}

#[test]
fn interrupt_maps_to_cancelled_or_safe_stop_label() {
    // implement-B: unofficial fake-CLI stop_reason=interrupted is not A.
    let workspace = fixture_workspace("interrupt", "interrupt");
    let mut manager = attach("attempt-interrupt", &workspace);
    send(&mut manager, "attempt-interrupt");
    let running = drain_until(&mut manager, "attempt-interrupt", |seen| {
        has(seen, AgentEventType::ToolActivity)
    });
    assert!(has(&running, AgentEventType::ToolActivity));
    let cancel = manager
        .interrupt("attempt-interrupt")
        .expect("interrupt should be accepted");
    assert!(cancel.requested);
    assert!(!cancel.confirmed);
    let events = drain_until(&mut manager, "attempt-interrupt", |seen| {
        has(seen, AgentEventType::TurnFailed) || has(seen, AgentEventType::Cancelled)
    });
    let terminal = events
        .iter()
        .rev()
        .find(|event| {
            event.event_type == AgentEventType::TurnFailed
                || event.event_type == AgentEventType::Cancelled
        })
        .unwrap_or_else(|| panic!("expected a terminal stop event, saw {events:#?}"));
    let (native, process_stop, unsupported) = honest_stop_triple(&terminal.payload);
    assert!(
        !native,
        "unofficial stop_reason=interrupted must not be native_turn_cancel: {}",
        terminal.payload
    );
    assert!(
        unsupported || process_stop,
        "interrupt without an official unique A field must be unsupported or B: {}",
        terminal.payload
    );
    let text = terminal.payload["text"].as_str().unwrap_or_default();
    assert!(
        !text.contains("native interrupt"),
        "UI/payload must not say native cancel on B/unsupported: {}",
        terminal.payload
    );
    assert_honest_stop_payload(&terminal.payload);
    assert!(!has(&events, AgentEventType::TurnCompleted));
}

#[test]
fn interrupted_result_without_interrupt_receipt_is_not_native_turn_cancel() {
    let workspace = fixture_workspace("interrupt-no-receipt", "interrupt_no_receipt");
    let mut manager = attach("attempt-interrupt-no-receipt", &workspace);
    send(&mut manager, "attempt-interrupt-no-receipt");
    let running = drain_until(&mut manager, "attempt-interrupt-no-receipt", |seen| {
        has(seen, AgentEventType::ToolActivity)
    });
    assert!(has(&running, AgentEventType::ToolActivity));
    let cancel = manager
        .interrupt("attempt-interrupt-no-receipt")
        .expect("interrupt should be accepted");
    assert!(cancel.requested);
    assert!(!cancel.confirmed);
    let events = drain_until(&mut manager, "attempt-interrupt-no-receipt", |seen| {
        has(seen, AgentEventType::TurnFailed) || has(seen, AgentEventType::Cancelled)
    });
    let types = read_json(&workspace, ".fake-claude-stdin-types.json");
    let interrupt_sent = types.as_array().is_some_and(|rows| {
        rows.iter().any(|row| row.get("subtype").and_then(Value::as_str) == Some("interrupt"))
    });
    assert!(
        interrupt_sent,
        "interrupt stdin must be accepted before the interrupted result: {types}"
    );
    let terminal = events
        .iter()
        .rev()
        .find(|event| {
            event.event_type == AgentEventType::TurnFailed
                || event.event_type == AgentEventType::Cancelled
        })
        .unwrap_or_else(|| panic!("expected a terminal stop event, saw {events:#?}"));
    let (native, _process_stop, _unsupported) = honest_stop_triple(&terminal.payload);
    assert!(
        !native,
        "interrupted result without matching interrupt receipt must not be native_turn_cancel: {}",
        terminal.payload
    );
    assert_honest_stop_payload(&terminal.payload);
}

#[test]
fn error_during_execution_with_interrupt_receipt_is_native_turn_cancel() {
    // r6: name kept. Bare EDE + matching interrupt receipt is the bce967ce
    // shape and must NOT be native_turn_cancel. Official EDE is overloaded
    // (API failure / cancelled request / crash / sandbox-start failure).
    let workspace = fixture_workspace("interrupt-ede", "interrupt_error_during_execution");
    let mut manager = attach("attempt-interrupt-ede", &workspace);
    send(&mut manager, "attempt-interrupt-ede");
    let running = drain_until(&mut manager, "attempt-interrupt-ede", |seen| {
        has(seen, AgentEventType::ToolActivity)
    });
    assert!(has(&running, AgentEventType::ToolActivity));
    let cancel = manager
        .interrupt("attempt-interrupt-ede")
        .expect("interrupt should be accepted");
    assert!(cancel.requested);
    assert!(!cancel.confirmed);
    let events = drain_until(&mut manager, "attempt-interrupt-ede", |seen| {
        has(seen, AgentEventType::Cancelled) || has(seen, AgentEventType::TurnFailed)
    });
    let terminal = events
        .iter()
        .rev()
        .find(|event| {
            event.event_type == AgentEventType::TurnFailed
                || event.event_type == AgentEventType::Cancelled
        })
        .unwrap_or_else(|| panic!("expected a terminal stop event, saw {events:#?}"));
    let (native, _process_stop, _unsupported) = honest_stop_triple(&terminal.payload);
    assert!(
        !native,
        "bare error_during_execution + interrupt receipt must not be native_turn_cancel: {}",
        terminal.payload
    );
    assert_eq!(
        terminal.payload.get("result_subtype").and_then(Value::as_str),
        Some("error_during_execution")
    );
    assert_eq!(
        terminal.payload.get("interrupt_receipt_matched").and_then(Value::as_bool),
        Some(true)
    );
}

#[test]
fn ambiguous_result_keeps_stop_pending_then_unconfirmed_without_process_fallback() {
    // AC6c B-path RED/GREEN. The ambiguous `error_during_execution` result lands
    // ~46 ms after the interrupt (live gen3 ordering) and truthfully clears
    // `turn_in_flight`. The unresolved Stop must survive that frame so the
    // five-second fallback can still inspect the exact still-live managed child.
    let workspace = fixture_workspace("interrupt-pending-b", "interrupt_error_during_execution");
    let mut manager = attach("attempt-pending-b", &workspace);
    send(&mut manager, "attempt-pending-b");
    let running = drain_until(&mut manager, "attempt-pending-b", |seen| {
        has(seen, AgentEventType::ToolActivity)
    });
    assert!(has(&running, AgentEventType::ToolActivity));
    let bound_pid = manager
        .native_pid("attempt-pending-b")
        .expect("managed child pid before Stop");
    let bound_epoch = manager
        .process_epoch("attempt-pending-b")
        .expect("process epoch before Stop");
    let cancel = manager
        .interrupt("attempt-pending-b")
        .expect("interrupt should be accepted");
    assert!(cancel.requested);
    assert!(!cancel.confirmed);

    // Window strictly inside the five-second fallback deadline.
    let early = poll_for(&mut manager, "attempt-pending-b", Duration::from_millis(2_500));
    assert!(
        !manager.turn_in_flight("attempt-pending-b"),
        "a terminal result may truthfully clear turn_in_flight: {early:#?}"
    );
    assert!(
        !early.iter().any(|event| {
            event.payload.get("used_sigint").and_then(Value::as_bool) == Some(true)
        }),
        "no signal may be sent before the fallback deadline: {early:#?}"
    );
    assert_eq!(
        manager.native_pid("attempt-pending-b"),
        Some(bound_pid),
        "the exact managed child must still be alive when the deadline arrives"
    );
    assert!(
        terminal_stops(&early).is_empty(),
        "the unresolved Stop must not be disposed before the bounded B evaluation: {early:#?}"
    );

    let events = drain_until(&mut manager, "attempt-pending-b", |seen| {
        has(seen, AgentEventType::Cancelled) || has(seen, AgentEventType::TurnFailed)
    });
    let terminals = terminal_stops(&events);
    assert_eq!(
        terminals.len(),
        1,
        "an unresolved Stop must reach exactly one terminal disposition: {events:#?}"
    );
    let terminal = terminals[0];
    // Archived by --nocapture: the exact disposition this freeze reached.
    println!("NATIVE_STOP_UNCONFIRMED={}", terminal.payload);
    let trace = stop_attempt(&terminal.payload);
    assert_eq!(
        trace["exact_child_alive_at_deadline"],
        Value::Null,
        "No target-exit predicate is used to claim safety: {}",
        terminal.payload
    );
    assert_eq!(
        trace["signal_attempted"],
        json!(false),
        "Native Stop must never enter the rejected process fallback: {}",
        terminal.payload
    );
    assert_eq!(
        trace["signal_count"],
        json!(0),
        "No process signal may be issued: {}",
        terminal.payload
    );
    assert_eq!(trace["bound_pid"], json!(bound_pid));
    assert_eq!(trace["bound_process_epoch"], json!(bound_epoch));
    assert_eq!(trace["bound_attempt_id"], json!("attempt-pending-b"));
    assert!(
        trace["bound_creation_date"].as_str().is_some_and(|value| !value.is_empty()),
        "B must bind the observed CreationDate: {}",
        terminal.payload
    );
    assert!(
        trace["bound_executable_sha256"]
            .as_str()
            .is_some_and(|value| value.len() == 64),
        "B must bind the observed executable identity: {}",
        terminal.payload
    );
    assert_honest_stop_payload(&terminal.payload);
    assert!(!has(&events, AgentEventType::TurnCompleted));
}

#[test]
fn interrupt_send_success_does_not_sigint_while_child_alive() {
    let workspace = fixture_workspace("interrupt-no-early-sigint", "interrupt");
    let mut manager = attach("attempt-interrupt-no-early-sigint", &workspace);
    send(&mut manager, "attempt-interrupt-no-early-sigint");
    let running = drain_until(
        &mut manager,
        "attempt-interrupt-no-early-sigint",
        |seen| has(seen, AgentEventType::ToolActivity),
    );
    assert!(has(&running, AgentEventType::ToolActivity));
    let cancel = manager
        .interrupt("attempt-interrupt-no-early-sigint")
        .expect("interrupt should be accepted");
    assert!(cancel.requested);
    assert!(!cancel.confirmed);
    // A full window strictly inside the five-second deadline.
    let early = poll_for(
        &mut manager,
        "attempt-interrupt-no-early-sigint",
        Duration::from_millis(4_000),
    );
    let used_early = early.iter().any(|event| {
        event.payload.get("used_sigint").and_then(Value::as_bool) == Some(true)
    });
    assert!(
        !used_early,
        "successful interrupt send must not SIGINT merely because the child is still alive: {early:#?}"
    );
    assert!(
        terminal_stops(&early).is_empty(),
        "the Stop must still be unresolved before the deadline: {early:#?}"
    );
    assert!(
        manager.native_pid("attempt-interrupt-no-early-sigint").is_some(),
        "the exact managed child must not have been stopped before the deadline"
    );
}

#[test]
fn normal_turn_completion_never_attempts_a_process_stop() {
    let workspace = fixture_workspace("no-stop-no-b", "end_turn");
    let mut manager = attach("attempt-no-stop-no-b", &workspace);
    let mut events = send(&mut manager, "attempt-no-stop-no-b");
    events.extend(drain_until(&mut manager, "attempt-no-stop-no-b", |seen| {
        has(seen, AgentEventType::TurnCompleted)
    }));
    events.extend(poll_for(
        &mut manager,
        "attempt-no-stop-no-b",
        Duration::from_millis(6_000),
    ));
    assert!(
        !events.iter().any(|event| {
            event.payload.get("used_sigint").and_then(Value::as_bool) == Some(true)
                || event.payload.get("safe_process_stop").and_then(Value::as_bool) == Some(true)
        }),
        "a turn that completed normally must never be signalled or reported as a process stop: {events:#?}"
    );
    assert!(
        terminal_stops(&events).is_empty(),
        "a completed turn has no Stop to dispose: {events:#?}"
    );
}

#[test]
fn duplicate_safe_stop_does_not_open_a_second_stop_or_signal() {
    let workspace = fixture_workspace("interrupt-dup-stop", "interrupt_error_during_execution");
    let mut manager = attach("attempt-dup-stop", &workspace);
    send(&mut manager, "attempt-dup-stop");
    let running = drain_until(&mut manager, "attempt-dup-stop", |seen| {
        has(seen, AgentEventType::ToolActivity)
    });
    assert!(has(&running, AgentEventType::ToolActivity));
    let first = manager
        .interrupt("attempt-dup-stop")
        .expect("interrupt should be accepted");
    assert!(first.requested);
    // The ambiguous result lands and truthfully clears turn_in_flight; a second
    // Safe stop must still be recognised as the same unresolved Stop.
    let early = poll_for(&mut manager, "attempt-dup-stop", Duration::from_millis(1_500));
    assert!(terminal_stops(&early).is_empty());
    let second = manager
        .interrupt("attempt-dup-stop")
        .expect("a duplicate interrupt should be answered, not rejected as no active turn");
    assert!(second.requested, "a duplicate Stop is not 'no active turn': {second:?}");
    assert!(!second.confirmed);
    assert!(
        second
            .reason
            .as_deref()
            .unwrap_or_default()
            .contains("already pending"),
        "a duplicate Stop must be reported as the same pending Stop: {second:?}"
    );
    let events = drain_until(&mut manager, "attempt-dup-stop", |seen| {
        has(seen, AgentEventType::Cancelled) || has(seen, AgentEventType::TurnFailed)
    });
    let terminals = terminal_stops(&events);
    assert_eq!(
        terminals.len(),
        1,
        "two Safe stops on one turn still resolve to one disposition: {events:#?}"
    );
    assert_eq!(
        stop_attempt(&terminals[0].payload)["signal_count"],
        json!(0),
        "a duplicate Stop must not add a second signal: {}",
        terminals[0].payload
    );
    let types = read_json(&workspace, ".fake-claude-stdin-types.json");
    let interrupts = types
        .as_array()
        .map(|rows| {
            rows.iter()
                .filter(|row| row.get("subtype").and_then(Value::as_str) == Some("interrupt"))
                .count()
        })
        .unwrap_or_default();
    assert_eq!(
        interrupts, 1,
        "a duplicate Stop must not send a second native interrupt: {types}"
    );
}

#[test]
fn interrupt_does_not_fail_open_on_denied_tool_result() {
    let workspace = fixture_workspace("interrupt-mutating", "interrupt_mutating");
    let mut manager = attach("attempt-int-mut", &workspace);
    send(&mut manager, "attempt-int-mut");
    let running = drain_until(&mut manager, "attempt-int-mut", |seen| {
        has(seen, AgentEventType::PermissionRequest)
    });
    assert!(has(&running, AgentEventType::PermissionRequest));
    assert!(has(&running, AgentEventType::ToolActivity));
    let cancel = manager
        .interrupt("attempt-int-mut")
        .expect("interrupt should be accepted");
    assert!(cancel.requested);
    let events = drain_until(&mut manager, "attempt-int-mut", |seen| {
        has(seen, AgentEventType::Cancelled) || has(seen, AgentEventType::TurnFailed)
    });
    assert!(
        !fail_open_true(&events),
        "interrupt deny + tool_result with no delta must not fail_open: {events:#?}"
    );
    let terminal = events
        .iter()
        .rev()
        .find(|event| {
            event.event_type == AgentEventType::TurnFailed
                || event.event_type == AgentEventType::Cancelled
        })
        .unwrap_or_else(|| panic!("expected a terminal stop event, saw {events:#?}"));
    let (native, _process_stop, _unsupported) = honest_stop_triple(&terminal.payload);
    assert!(
        !native,
        "interrupt_mutating must not label unofficial interrupt as native_turn_cancel: {}",
        terminal.payload
    );
    assert!(!has(&events, AgentEventType::TurnCompleted));
    assert!(!workspace.join("notes/fixture-allow.txt").exists());
}

#[test]
fn manufactured_session_id_is_not_emitted_as_native_resume() {
    let workspace = fixture_workspace("no-resume", "end_turn");
    let mut manager = attach("attempt-no-resume", &workspace);
    let created = manager
        .create_session(
            "attempt-no-resume",
            &session_request("attempt-no-resume", &workspace),
        )
        .expect("second create_session on a live process is the same child");
    assert!(!created.handle.session_id.starts_with("claude-session-"));
    assert!(!created.handle.resumed);
    let resume = manager.resume_session("attempt-no-resume", "claude-session-attempt-no-resume");
    assert!(resume.is_err());
    let events = send(&mut manager, "attempt-no-resume");
    let polled = drain_until(&mut manager, "attempt-no-resume", |seen| {
        has(seen, AgentEventType::SessionCreated) || has(seen, AgentEventType::TurnCompleted)
    });
    let mut all = events;
    all.extend(polled);
    if let Some(session) = all
        .iter()
        .find(|event| event.event_type == AgentEventType::SessionCreated)
    {
        assert_eq!(session.payload["resumed"], false);
        assert_ne!(session.payload["session_id"], "claude-session-attempt-no-resume");
        let sid = session.payload["session_id"].as_str().unwrap_or_default();
        assert!(!sid.starts_with("claude-session-"));
    }
}

fn wire(request_id: &str, message_type: &str, payload: Value) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "protocolVersion": CONNECTED_UI_PROTOCOL_VERSION,
        "requestId": request_id,
        "entityVersion": 0,
        "messageType": message_type,
        "payload": payload
    }))
    .expect("request should serialize")
}

fn call(server: &CoreServer, request_id: &str, message_type: &str, payload: Value) -> Value {
    server
        .handle_json(&wire(request_id, message_type, payload))
        .expect("Core should answer")
}

fn snapshot_of(response: &Value) -> Value {
    response["payload"]["snapshot"].clone()
}

/// `create_campaign` derives campaign/task identity from the request hash and
/// requires an existing workspace, so fixtures must read the real ids back
/// from the successful command snapshot instead of hardcoding
/// `campaign-<request-id>` / `task-<request-id>`.
fn create_campaign_fixture(
    server: &CoreServer,
    request_id: &str,
    workspace: &Path,
    goal: &str,
) -> (String, String) {
    let response = call(
        server,
        request_id,
        "create_campaign",
        json!({
            "workspaceRoot": workspace.to_string_lossy(),
            "goal": goal
        }),
    );
    assert_eq!(response["ok"], true, "create_campaign refused: {response}");
    let snapshot = snapshot_of(&response);
    let campaign_id = snapshot["activeCampaignId"]
        .as_str()
        .expect("campaign id in create snapshot")
        .to_owned();
    let task_id = snapshot["activeTask"]["id"]
        .as_str()
        .expect("root task id in create snapshot")
        .to_owned();
    (campaign_id, task_id)
}

static EPOCH_LOCK: Mutex<()> = Mutex::new(());

fn seed_core_epoch(store: &Store, workspace: &Path, nonce: &str) {
    let _guard = EPOCH_LOCK.lock().expect("env lock");
    let db = workspace.join("core-fixture.sqlite");
    unsafe {
        env::set_var("GOALPORT_LAUNCH_NONCE", nonce);
        env::set_var("GOALPORT_ELECTRON_PID", "10");
        env::set_var("GOALPORT_ELECTRON_CREATED_MS", "1000");
        env::set_var("GOALPORT_ELECTRON_EXE", r"C:\pkg\GoalPort.exe");
        env::set_var("GOALPORT_ELECTRON_SHA256", "aa");
        env::set_var("GOALPORT_LAUNCHER_PID", "20");
        env::set_var("GOALPORT_LAUNCHER_CREATED_MS", "1100");
        env::set_var("GOALPORT_LAUNCHER_EXE", r"C:\pkg\goalport-core-launcher.exe");
        env::set_var("GOALPORT_LAUNCHER_SHA256", "bb");
        env::set_var("GOALPORT_LAUNCHER_PARENT_PID", "10");
        env::set_var("GOALPORT_LAUNCH_REQUESTED_AT", "2026-09-02T00:00:00.000Z");
        env::set_var("GOALPORT_LAUNCHER_STARTED_AT", "2026-09-02T00:00:00.010Z");
        env::set_var("GOALPORT_CORE_SPAWNED_AT", "2026-09-02T00:00:00.020Z");
        env::remove_var("GOALPORT_REQUIRE_ISOLATED");
    }
    let claim = begin_startup_epoch(store, r"\\.\pipe\claude-stream-fixture", &db)
        .expect("startup epoch should be claimable");
    complete_startup_epoch(
        store,
        r"\\.\pipe\claude-stream-fixture",
        &db,
        &claim,
        &json!({
            "status": "completed",
            "commandsUnknown": 0,
            "outboxUnknown": 0,
            "leasesUncertain": 0,
            "runtimeAttachment": "UNKNOWN_OR_UNSUPPORTED",
            "promptReplay": false
        }),
    )
    .expect("startup epoch should commit");
}

#[test]
fn send_to_terminal_attempt_is_refused() {
    let workspace = fixture_workspace("terminal-guard", "interrupt");
    let store = Store::memory().expect("in-memory store");
    store
        .insert_project(&Project {
            id: "project-claude-fixture".into(),
            workspace_root: workspace.to_string_lossy().into_owned(),
        })
        .expect("project");
    seed_core_epoch(&store, &workspace, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    let server = CoreServer::new(store.clone());
    let executable = fake_cli().to_string_lossy().into_owned();
    let (campaign_id, task_id) = create_campaign_fixture(
        &server,
        "claude-campaign-terminal",
        &workspace,
        "terminal guard",
    );
    let selected = snapshot_of(&call(
        &server,
        "claude-select-terminal",
        "select_runtime",
        json!({
            "campaignId": campaign_id,
            "taskId": task_id,
            "provider": "claude",
            "executable": executable
        }),
    ));
    assert_eq!(selected["ok"].as_bool().or(Some(true)), Some(true));
    let attempt = selected["attempt"]["id"]
        .as_str()
        .expect("attempt id")
        .to_owned();
    let sent = call(
        &server,
        "claude-send-1",
        "send_message",
        json!({
            "campaignId": campaign_id,
            "attemptId": attempt,
            "message": "first turn"
        }),
    );
    assert_eq!(sent["ok"], true, "first send refused: {sent}");
    for round in 0..400 {
        call(&server, &format!("claude-poll-{round}"), "snapshot", json!({}));
        let kinds = store
            .list_event_records(&attempt, 0)
            .expect("events")
            .into_iter()
            .map(|record| record.event.kind)
            .collect::<Vec<_>>();
        if kinds.iter().any(|kind| kind == "runtime.tool.activity") {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let stopped = call(
        &server,
        "claude-stop",
        "interrupt",
        json!({ "attemptId": attempt }),
    );
    assert_eq!(stopped["ok"], true, "interrupt refused: {stopped}");
    for round in 0..200 {
        call(&server, &format!("claude-poll-stop-{round}"), "snapshot", json!({}));
        if store.get_attempt(&attempt).expect("attempt").state.is_terminal() {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(
        store.get_attempt(&attempt).expect("attempt").state.is_terminal(),
        "interrupt must mark the Attempt terminal"
    );
    let before = store
        .list_event_records(&attempt, 0)
        .expect("events readable")
        .len();
    let refused = call(
        &server,
        "claude-send-2",
        "send_message",
        json!({
            "campaignId": campaign_id,
            "attemptId": attempt,
            "message": "second turn"
        }),
    );
    assert_eq!(refused["ok"], false);
    let error = refused["error"].as_str().expect("refusal carries a reason");
    assert!(
        error.contains("responsibility held"),
        "unexpected refusal text: {error}"
    );
    assert!(error.contains("residual execution is unknown"));
    let after = store
        .list_event_records(&attempt, 0)
        .expect("events readable");
    assert_eq!(after.len(), before);
}

#[test]
fn uncertain_claude_send_is_attempted_once_and_holds_responsibility() {
    let workspace=fixture_workspace("uncertain-send","end_turn");
    fs::write(workspace.join(".fake-claude-send-error-after-write"),"debug fixture only").unwrap();
    let store=Store::memory().unwrap();
    store.insert_project(&Project{id:"project-claude-fixture".into(),workspace_root:workspace.to_string_lossy().into_owned()}).unwrap();
    seed_core_epoch(&store,&workspace,"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeef");
    let server=CoreServer::new(store.clone());
    let (campaign_id, task_id)=create_campaign_fixture(&server,"uncertain-campaign",&workspace,"uncertain send");
    let selected=snapshot_of(&call(&server,"uncertain-select","select_runtime",json!({
        "campaignId":campaign_id,"taskId":task_id,
        "provider":"claude","executable":fake_cli().to_string_lossy()})));
    let attempt=selected["attempt"]["id"].as_str().unwrap();
    let sent=call(&server,"uncertain-input","send_message",json!({"campaignId":campaign_id,"attemptId":attempt,"message":"one input only"}));
    assert_eq!(sent["ok"],false,"{sent}");
    let mut input_count=0;
    for _ in 0..40 {
        if let Some(value) = fs::read_to_string(workspace.join(".fake-claude-stdin-types.json")).ok()
            .and_then(|raw|serde_json::from_str::<Value>(&raw).ok()) {
            input_count=value.as_array().unwrap().iter().filter(|x|x["type"]=="user").count();
            if input_count>0 {break}
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    assert_eq!(fs::read_to_string(workspace.join(".fake-claude-send-attempts")).unwrap().lines().count(),1,"Core must not retry even after a pipe write already succeeded");
    assert_eq!(input_count,1,"native fixture received exactly one input");
    let held=store.stop_responsibility_for_attempt(attempt).unwrap().unwrap();
    assert_eq!(held.native_turn_state,goalport_core::store::StopNativeTurnState::Unconfirmed);
    assert_eq!(held.write_responsibility,"held");
    let again=call(&server,"uncertain-second-input","send_message",json!({"campaignId":campaign_id,"attemptId":attempt,"message":"must not be sent"}));
    assert_eq!(again["ok"],false);
    assert_eq!(fs::read_to_string(workspace.join(".fake-claude-send-attempts")).unwrap().lines().count(),1);
}

fn notice_strings(snapshot: &Value) -> Vec<String> {
    snapshot["notices"]
        .as_array()
        .unwrap_or(&Vec::new())
        .iter()
        .filter_map(|value| value.as_str().map(str::to_owned))
        .collect()
}

fn pending_decision_id(snapshot: &Value) -> Option<String> {
    snapshot["decisions"].as_array().and_then(|rows| {
        rows.iter()
            .find(|row| row["state"] == "pending")
            .and_then(|row| row["id"].as_str())
            .map(str::to_owned)
    })
}

fn wait_pending_decision(server: &CoreServer, label: &str) -> (Value, String) {
    for round in 0..400 {
        let snap = snapshot_of(&call(
            server,
            &format!("{label}-wait-{round}"),
            "snapshot",
            json!({}),
        ));
        if let Some(id) = pending_decision_id(&snap) {
            return (snap, id);
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!("{label}: no pending Decision appeared")
}

fn wait_turn_settled(server: &CoreServer, store: &Store, attempt: &str, label: &str) {
    for round in 0..400 {
        call(
            server,
            &format!("{label}-settle-{round}"),
            "snapshot",
            json!({}),
        );
        let kinds = store
            .list_event_records(attempt, 0)
            .expect("events")
            .into_iter()
            .map(|record| record.event.kind)
            .collect::<Vec<_>>();
        if kinds.iter().any(|kind| {
            kind == "runtime.turn.completed"
                || kind == "runtime.turn.failed"
                || kind == "runtime.turn.cancelled"
        }) {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!("{label}: turn did not settle")
}

fn honest_stop_triple(payload: &Value) -> (bool, bool, bool) {
    let native = payload
        .get("native_turn_cancel")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let process_stop = payload
        .get("safe_process_stop")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let unsupported = payload
        .get("unsupported")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || payload
            .get("unverified")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        || payload
            .get("stopKind")
            .and_then(Value::as_str)
            .is_some_and(|kind| {
                kind.eq_ignore_ascii_case("unsupported") || kind.eq_ignore_ascii_case("unverified")
            });
    (native, process_stop, unsupported)
}

fn assert_honest_stop_payload(payload: &Value) {
    let (native, process_stop, unsupported) = honest_stop_triple(payload);
    let set = [native, process_stop, unsupported]
        .into_iter()
        .filter(|flag| *flag)
        .count();
    assert_eq!(
        set, 1,
        "stop payload must be exactly one of native_turn_cancel / safe_process_stop / unsupported|unverified: {payload}"
    );
    if native {
        let reason = payload
            .get("stop_reason")
            .and_then(Value::as_str)
            .unwrap_or("");
        let subtype = payload
            .get("result_subtype")
            .and_then(Value::as_str)
            .unwrap_or("");
        assert!(
            !reason.eq_ignore_ascii_case("interrupted")
                && !reason.eq_ignore_ascii_case("cancelled")
                && !reason.eq_ignore_ascii_case("user_interrupt")
                && !subtype.eq_ignore_ascii_case("error_during_execution"),
            "native_turn_cancel must not use unofficial stop_reason or overloaded EDE, got {payload}"
        );
        panic!(
            "native_turn_cancel requires an M1-quoted official unique cancel field; stop-path-trace names implement-B: {payload}"
        );
    }
    if process_stop {
        let text = payload
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_lowercase();
        let used = payload
            .get("used_sigint")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        assert!(
            used || text.contains("sigint") || text.contains("safe process stop"),
            "safe_process_stop requires GoalPort SIGINT proof, got {payload}"
        );
        assert!(!native);
    }
}

#[test]
fn deny_resolve_decision_inserts_bound_notice_in_snapshot() {
    let workspace = fixture_workspace("ac6e-notices", "deny");
    let store = Store::memory().expect("in-memory store");
    store
        .insert_project(&Project {
            id: "project-claude-fixture".into(),
            workspace_root: workspace.to_string_lossy().into_owned(),
        })
        .expect("project");
    seed_core_epoch(&store, &workspace, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeac6e");
    let server = CoreServer::new(store.clone());
    let executable = fake_cli().to_string_lossy().into_owned();
    let (campaign_id, task_id) = create_campaign_fixture(
        &server,
        "claude-campaign-ac6e",
        &workspace,
        "ac6e notices",
    );
    let selected = snapshot_of(&call(
        &server,
        "claude-select-ac6e",
        "select_runtime",
        json!({
            "campaignId": campaign_id,
            "taskId": task_id,
            "provider": "claude",
            "executable": executable
        }),
    ));
    // The selection snapshot must carry exactly the campaign created above.
    assert_eq!(
        selected["activeCampaignId"].as_str().unwrap_or_default(),
        campaign_id,
        "select snapshot must carry the created campaign"
    );
    assert_eq!(
        selected["activeTask"]["id"].as_str().unwrap_or_default(),
        task_id,
        "select snapshot must carry the created root task"
    );
    let attempt = selected["attempt"]["id"]
        .as_str()
        .expect("attempt id")
        .to_owned();
    let sent = call(
        &server,
        "claude-send-ac6e-1",
        "send_message",
        json!({
            "campaignId": campaign_id,
            "attemptId": attempt,
            "message": "first deny turn"
        }),
    );
    assert_eq!(sent["ok"], true, "first send refused: {sent}");
    let (snap_pending_a, id_a) = wait_pending_decision(&server, "ac6e-a");
    let session_a = snap_pending_a["attempt"]["sessionHash"]
        .as_str()
        .unwrap_or("unbound")
        .to_owned();
    let denied_a = call(
        &server,
        "claude-deny-ac6e-1",
        "resolve_decision",
        json!({ "decisionId": id_a, "allow": false }),
    );
    assert_eq!(denied_a["ok"], true, "deny A refused: {denied_a}");
    let notices_after_1 = notice_strings(&snapshot_of(&denied_a));
    wait_turn_settled(&server, &store, &attempt, "ac6e-a");
    let sent_b = call(
        &server,
        "claude-send-ac6e-2",
        "send_message",
        json!({
            "campaignId": campaign_id,
            "attemptId": attempt,
            "message": "second deny turn"
        }),
    );
    assert_eq!(sent_b["ok"], true, "second send refused: {sent_b}");
    let (snap_pending_b, id_b) = wait_pending_decision(&server, "ac6e-b");
    assert_ne!(id_a, id_b, "independent denies must use distinct decision ids");
    let session_b = snap_pending_b["attempt"]["sessionHash"]
        .as_str()
        .unwrap_or(session_a.as_str())
        .to_owned();
    let denied_b = call(
        &server,
        "claude-deny-ac6e-2",
        "resolve_decision",
        json!({ "decisionId": id_b, "allow": false }),
    );
    assert_eq!(denied_b["ok"], true, "deny B refused: {denied_b}");
    let notices_after_2 = notice_strings(&snapshot_of(&denied_b));
    let bound_b = notices_after_2.iter().find(|notice| {
        notice.contains(&id_b)
            && notice.contains(&attempt)
            && notice.contains(&campaign_id)
            && notice.contains(&task_id)
            && (session_b == "unbound" || notice.contains(&session_b))
    });
    let bound_b = bound_b.unwrap_or_else(|| {
        panic!(
            "Core snapshot.notices after deny B must contain decision {id_b} bound to attempt/campaign/task/session; noticesAfterDecline1={notices_after_1:?} noticesAfterDecline2={notices_after_2:?}"
        )
    });
    assert!(
        !notices_after_1.iter().any(|notice| notice == bound_b),
        "B-containing notice must be absent from noticesAfterDecline1: {notices_after_1:?}"
    );
    let reconnect = snapshot_of(&call(
        &server,
        "claude-reconnect-ac6e",
        "reconnect",
        json!({ "cursor": 0 }),
    ));
    let reconnect_copies = notice_strings(&reconnect)
        .into_iter()
        .filter(|notice| notice == bound_b)
        .count();
    assert!(
        reconnect_copies <= 1,
        "reconnect must not duplicate the B-containing notice: {:?}",
        notice_strings(&reconnect)
    );
    let restarted = CoreServer::new(store.clone());
    let rebuilt = snapshot_of(&call(
        &restarted,
        "claude-rebuild-ac6e",
        "snapshot",
        json!({}),
    ));
    let rebuilt_copies = notice_strings(&rebuilt)
        .into_iter()
        .filter(|notice| notice.contains(&id_b) && notice.contains(&attempt))
        .count();
    assert_eq!(
        rebuilt_copies, 1,
        "snapshot rebuild must keep the B-containing notice once: {:?}",
        notice_strings(&rebuilt)
    );
}

#[test]
fn stream_close_without_sigint_emits_honest_stop_payload() {
    let workspace = fixture_workspace("interrupt-eof", "interrupt_eof");
    let mut manager = attach("attempt-interrupt-eof", &workspace);
    send(&mut manager, "attempt-interrupt-eof");
    let running = drain_until(&mut manager, "attempt-interrupt-eof", |seen| {
        has(seen, AgentEventType::ToolActivity)
    });
    assert!(has(&running, AgentEventType::ToolActivity));
    let cancel = manager
        .interrupt("attempt-interrupt-eof")
        .expect("interrupt should be accepted");
    assert!(cancel.requested);
    assert!(!cancel.confirmed);
    let events = drain_until(&mut manager, "attempt-interrupt-eof", |seen| {
        has(seen, AgentEventType::TurnFailed) || has(seen, AgentEventType::Cancelled)
    });
    let terminal = events
        .iter()
        .rev()
        .find(|event| {
            event.event_type == AgentEventType::TurnFailed
                || event.event_type == AgentEventType::Cancelled
        })
        .unwrap_or_else(|| panic!("expected a terminal stop event, saw {events:#?}"));
    assert_honest_stop_payload(&terminal.payload);
    assert!(
        !has(&events, AgentEventType::TurnCompleted),
        "stream-close stop must not complete the turn: {events:#?}"
    );
}

// Name kept from r6. `is_error` + `tool_use` with no EDE is still not A. Under
// the owner B-path fix it no longer disposes the Stop by itself either: the
// child is still alive, so the Stop stays unresolved until the bounded,
// identity-checked B evaluation, which fails closed to unsupported/unverified
// unless the exact child is observed to stop.
#[test]
fn interrupt_error_result_without_stop_reason_is_unsupported() {
    let workspace = fixture_workspace("interrupt-error", "interrupt_error");
    let mut manager = attach("attempt-interrupt-error", &workspace);
    send(&mut manager, "attempt-interrupt-error");
    let running = drain_until(&mut manager, "attempt-interrupt-error", |seen| {
        has(seen, AgentEventType::ToolActivity)
    });
    assert!(has(&running, AgentEventType::ToolActivity));
    let cancel = manager
        .interrupt("attempt-interrupt-error")
        .expect("interrupt should be accepted");
    assert!(cancel.requested);
    assert!(!cancel.confirmed);
    let events = drain_until(&mut manager, "attempt-interrupt-error", |seen| {
        has(seen, AgentEventType::TurnFailed) || has(seen, AgentEventType::Cancelled)
    });
    let terminal = events
        .iter()
        .rev()
        .find(|event| {
            event.event_type == AgentEventType::TurnFailed
                || event.event_type == AgentEventType::Cancelled
        })
        .unwrap_or_else(|| panic!("expected a terminal stop event, saw {events:#?}"));
    assert_honest_stop_payload(&terminal.payload);
    let (native, process_stop, unsupported) = honest_stop_triple(&terminal.payload);
    assert!(
        !native,
        "live-like is_error tool_use after interrupt must never be native cancel, got {}",
        terminal.payload
    );
    assert!(
        unsupported || process_stop,
        "the Stop must reach unsupported/unverified or a confirmed process stop, got {}",
        terminal.payload
    );
    if process_stop {
        assert_eq!(
            stop_attempt(&terminal.payload)["signal_sent"],
            json!(true),
            "safe_process_stop requires GoalPort's own signal, got {}",
            terminal.payload
        );
    }
}

