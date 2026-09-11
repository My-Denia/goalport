//! Fail-closed contract tests for the Grok ACP stdio adapter.
//!
//! Every case drives the real `GrokAcpProcess` (or the real Core command path)
//! against the deterministic fake ACP agent in
//! `tests/fixtures/fake-acp-agent/`. No live subscription, no network, no model.
//! The fake agent reproduces the wire shapes recorded by the Phase 0 live probe:
//! agent->client JSON-RPC ids that restart at 0 per process, an
//! `available_commands_update` published before the `session/new` response, and
//! `session/request_permission` options that include `allow_always` /
//! `reject_always` the adapter must never select.
#![cfg(windows)]

use goalport_core::{
    AgentEventEnvelope, AgentEventType, PermissionResponse, Project, PromptRequest, RuntimeManager,
    SessionRequest,
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

fn fake_agent() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-acp-agent/fake-acp-agent.cmd")
}

/// One private workspace per case. The scenario travels in a file inside the
/// workspace instead of a process-wide environment variable, so cases can run in
/// parallel without racing each other.
fn fixture_workspace(name: &str, scenario: &str) -> PathBuf {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../target/grok-acp-tests")
        .join(name);
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("fixture workspace should be creatable");
    fs::write(dir.join(".fake-acp-scenario"), scenario).expect("scenario file should be writable");
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

fn attach(attempt: &str, workspace: &Path) -> (RuntimeManager, Vec<AgentEventEnvelope>) {
    let mut manager = RuntimeManager::new();
    let summary = manager
        .select_runtime(attempt, "grok", Some(fake_agent()), "1.0.13", workspace)
        .expect("grok runtime should be selectable");
    assert_eq!(summary.provider, "grok");
    assert_eq!(summary.protocol, "grok.acp.v1");
    let session = manager
        .create_session(attempt, &session_request(attempt, workspace))
        .expect("grok ACP session should be created");
    (manager, session.events)
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

fn has(events: &[AgentEventEnvelope], event_type: AgentEventType) -> bool {
    events.iter().any(|event| event.event_type == event_type)
}

fn first(events: &[AgentEventEnvelope], event_type: AgentEventType) -> &AgentEventEnvelope {
    events
        .iter()
        .find(|event| event.event_type == event_type)
        .unwrap_or_else(|| panic!("expected a {event_type:?} event, saw {events:#?}"))
}

fn session_created(events: &[AgentEventEnvelope]) -> &AgentEventEnvelope {
    first(events, AgentEventType::SessionCreated)
}

// ---------------------------------------------------------------------------
// Limit and failure semantics: every one of them is terminal for the Attempt,
// and none of them respawns a process, opens a new session or creates an Attempt.
// ---------------------------------------------------------------------------

#[test]
fn max_turn_requests_marks_failed_without_new_session() {
    let workspace = fixture_workspace("max-turn-requests", "max_turn_requests");
    let (mut manager, session_events) = attach("attempt-max-turns", &workspace);
    let started = send(&mut manager, "attempt-max-turns");
    let events = drain_until(&mut manager, "attempt-max-turns", |seen| {
        has(seen, AgentEventType::TurnFailed)
    });

    let failed = first(&events, AgentEventType::TurnFailed);
    assert_eq!(failed.payload["status"], "failed");
    assert_eq!(failed.payload["text"], "Grok stopped: max_turn_requests");
    assert_eq!(failed.payload["stop_reason"], "max_turn_requests");
    assert_eq!(started.len(), 1);
    assert_eq!(started[0].event_type, AgentEventType::TurnStarted);
    // No recovery attempt: exactly one session, no second TurnStarted.
    assert_eq!(
        session_events
            .iter()
            .filter(|event| event.event_type == AgentEventType::SessionCreated)
            .count(),
        1
    );
    assert!(!has(&events, AgentEventType::SessionCreated));
    assert!(!has(&events, AgentEventType::TurnStarted));
    assert!(!has(&events, AgentEventType::TurnCompleted));
}

#[test]
fn refusal_marks_failed() {
    let workspace = fixture_workspace("refusal", "refusal");
    let (mut manager, _) = attach("attempt-refusal", &workspace);
    send(&mut manager, "attempt-refusal");
    let events = drain_until(&mut manager, "attempt-refusal", |seen| {
        has(seen, AgentEventType::TurnFailed)
    });

    let failed = first(&events, AgentEventType::TurnFailed);
    assert_eq!(failed.payload["text"], "Grok stopped: refusal");
    assert!(!has(&events, AgentEventType::TurnCompleted));
}

#[test]
fn rpc_error_marks_failed() {
    let workspace = fixture_workspace("rpc-error", "rpc_error");
    let (mut manager, _) = attach("attempt-rpc-error", &workspace);
    send(&mut manager, "attempt-rpc-error");
    let events = drain_until(&mut manager, "attempt-rpc-error", |seen| {
        has(seen, AgentEventType::TurnFailed)
    });

    let failed = first(&events, AgentEventType::TurnFailed);
    assert_eq!(failed.payload["text"], "native Runtime error -32603");
    assert!(!has(&events, AgentEventType::TurnCompleted));
}

#[test]
fn stream_eof_mid_turn_marks_failed() {
    let workspace = fixture_workspace("stream-eof", "stream_eof");
    let (mut manager, _) = attach("attempt-stream-eof", &workspace);
    send(&mut manager, "attempt-stream-eof");
    let events = drain_until(&mut manager, "attempt-stream-eof", |seen| {
        has(seen, AgentEventType::TurnFailed)
    });

    let failed = first(&events, AgentEventType::TurnFailed);
    assert_eq!(
        failed.payload["text"],
        "native Runtime closed the ACP stream"
    );
    assert!(!has(&events, AgentEventType::TurnCompleted));
    assert!(!has(&events, AgentEventType::SessionCreated));
}

#[test]
fn cancel_maps_to_cancelled() {
    let workspace = fixture_workspace("cancel", "cancel");
    let (mut manager, _) = attach("attempt-cancel", &workspace);
    send(&mut manager, "attempt-cancel");
    let running = drain_until(&mut manager, "attempt-cancel", |seen| {
        has(seen, AgentEventType::ToolActivity)
    });
    assert!(has(&running, AgentEventType::ToolActivity));

    let cancel = manager
        .interrupt("attempt-cancel")
        .expect("interrupt should be accepted");
    assert!(cancel.requested);
    // No provider effect is claimed before the native stopReason arrives.
    assert!(!cancel.confirmed);

    let events = drain_until(&mut manager, "attempt-cancel", |seen| {
        has(seen, AgentEventType::Cancelled)
    });
    let cancelled = first(&events, AgentEventType::Cancelled);
    assert_eq!(cancelled.payload["status"], "cancelled");
    assert_eq!(
        cancelled.payload["text"],
        "Grok turn cancelled (stopReason=cancelled)"
    );
    assert!(!has(&events, AgentEventType::TurnCompleted));
}

// ---------------------------------------------------------------------------
// Native permission prompts
// ---------------------------------------------------------------------------

#[test]
fn session_command_enables_native_permissions() {
    let advertised = fixture_workspace("session-command-on", "end_turn");
    let (_manager, events) = attach("attempt-session-command", &advertised);
    let created = session_created(&events);
    assert_eq!(
        created.payload["native_permission_prompts"],
        "enabled-by-session-command"
    );
    assert_eq!(created.payload["always_approve_flag"], false);
    assert_eq!(created.payload["session_id"], "[NATIVE_SESSION]");
    assert!(created.payload["native_thread_hash"].as_str().is_some());

    // A Runtime that does not advertise the command is recorded as a miss, never
    // as a silent success.
    let missing = fixture_workspace("session-command-off", "no_command");
    let (_second, events) = attach("attempt-session-default", &missing);
    assert_eq!(
        session_created(&events).payload["native_permission_prompts"],
        "native-default"
    );
}

#[test]
fn permission_request_round_trip_selects_option() {
    let workspace = fixture_workspace("permission-allow", "permission");
    let (mut manager, _) = attach("attempt-permission-allow", &workspace);
    send(&mut manager, "attempt-permission-allow");
    let mut events = drain_until(&mut manager, "attempt-permission-allow", |seen| {
        has(seen, AgentEventType::PermissionRequest)
    });

    let request = first(&events, AgentEventType::PermissionRequest);
    let request_id = request.payload["request_id"]
        .as_str()
        .expect("permission request carries a Decision id")
        .to_owned();
    assert!(request_id.starts_with("grok-"));
    // The agent's own JSON-RPC id is 0; the Decision id stays DB-unique anyway.
    assert!(request_id.ends_with("-0"));
    assert_eq!(request.payload["kind"], "native-permission");
    assert_eq!(request.payload["tool_kind"], "edit");
    assert_eq!(request.payload["text"], "Write `notes/fixture.txt`");

    manager
        .permission_response(
            "attempt-permission-allow",
            PermissionResponse {
                request_id: request_id.clone(),
                allow: true,
            },
        )
        .expect("decision should reach the reader");

    events.extend(drain_until(
        &mut manager,
        "attempt-permission-allow",
        |seen| has(seen, AgentEventType::TurnCompleted),
    ));
    let response = first(&events, AgentEventType::PermissionResponse);
    assert_eq!(response.payload["request_id"], request_id.as_str());
    assert_eq!(response.payload["option_kind"], "allow_once");
    assert_eq!(response.payload["option_id"], "allow-once");
    assert_eq!(response.payload["allow"], true);
    assert!(
        events.iter().any(|event| event.event_type == AgentEventType::MessageDelta
            && event.payload["text"] == "SELECTED:allow-once"),
        "the agent must observe the one-shot option id"
    );
    assert_eq!(
        first(&events, AgentEventType::TurnCompleted).payload["status"],
        "completed"
    );
    let serialized = serde_json::to_string(&events).expect("events serialize");
    assert!(!serialized.contains("allow_always"));
    assert!(!serialized.contains("allow-edits-session"));
}

#[test]
fn permission_deny_selects_reject_once() {
    let workspace = fixture_workspace("permission-deny", "permission");
    let (mut manager, _) = attach("attempt-permission-deny", &workspace);
    send(&mut manager, "attempt-permission-deny");
    let mut events = drain_until(&mut manager, "attempt-permission-deny", |seen| {
        has(seen, AgentEventType::PermissionRequest)
    });
    let request_id = first(&events, AgentEventType::PermissionRequest).payload["request_id"]
        .as_str()
        .expect("permission request carries a Decision id")
        .to_owned();

    manager
        .permission_response(
            "attempt-permission-deny",
            PermissionResponse {
                request_id,
                allow: false,
            },
        )
        .expect("decision should reach the reader");

    events.extend(drain_until(&mut manager, "attempt-permission-deny", |seen| {
        has(seen, AgentEventType::TurnCompleted)
    }));
    let response = first(&events, AgentEventType::PermissionResponse);
    assert_eq!(response.payload["option_kind"], "reject_once");
    assert_eq!(response.payload["option_id"], "reject-once");
    assert_eq!(response.payload["allow"], false);
    assert!(
        events.iter().any(|event| event.event_type == AgentEventType::MessageDelta
            && event.payload["text"] == "SELECTED:reject-once")
    );
    // A denied write never produced tool activity in this turn.
    assert!(!has(&events, AgentEventType::ToolActivity));
    let serialized = serde_json::to_string(&events).expect("events serialize");
    assert!(!serialized.contains("reject_always"));
    assert!(!serialized.contains("reject-always"));
}

// ---------------------------------------------------------------------------
// Core command path: Decision identity and the terminal-Attempt guard
// ---------------------------------------------------------------------------

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

static EPOCH_LOCK: Mutex<()> = Mutex::new(());

/// A native Runtime event is only persisted against a committed Core launch
/// epoch. The real Core commits one at `serve` startup; the fixture commits one
/// through the same product-receipt path instead of weakening the check.
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
    let claim = begin_startup_epoch(store, r"\\.\pipe\grok-acp-fixture", &db)
        .expect("startup epoch should be claimable");
    complete_startup_epoch(
        store,
        r"\\.\pipe\grok-acp-fixture",
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

fn core_server(workspace: &Path, nonce: &str) -> (CoreServer, Store) {
    let store = Store::memory().expect("in-memory store");
    store
        .insert_project(&Project {
            id: "project-grok-fixture".into(),
            workspace_root: workspace.to_string_lossy().into_owned(),
        })
        .expect("fixture project should be insertable");
    seed_core_epoch(&store, workspace, nonce);
    let server = CoreServer::new(store.clone());
    (server, store)
}

#[test]
fn permission_ids_unique_across_sessions() {
    let workspace = fixture_workspace("decision-ids", "permission");
    let (server, store) = core_server(&workspace, "11111111-2222-4333-8444-555555555555");
    let executable = fake_agent().to_string_lossy().into_owned();
    let mut attempts = Vec::new();

    for suffix in ["ida", "idb"] {
        call(
            &server,
            &format!("grok-campaign-{suffix}"),
            "create_campaign",
            json!({ "goal": format!("decision id fixture {suffix}") }),
        );
        let response = call(
            &server,
            &format!("grok-select-{suffix}"),
            "select_runtime",
            json!({
                "campaignId": format!("campaign-grok-campaign-{suffix}"),
                "taskId": format!("task-grok-campaign-{suffix}"),
                "provider": "grok",
                "executable": executable
            }),
        );
        assert_eq!(response["ok"], true, "grok runtime was refused: {response}");
        let selected = snapshot_of(&response);
        let attempt = selected["attempt"]["id"]
            .as_str()
            .unwrap_or_else(|| panic!("attempt id missing in {selected}"))
            .to_owned();
        assert_eq!(
            attempt,
            format!("attempt-task-grok-campaign-{suffix}-grok"),
            "attempt ids stay deterministic per task and provider"
        );
        let sent = call(
            &server,
            &format!("grok-send-{suffix}"),
            "send_message",
            json!({
                "campaignId": format!("campaign-grok-campaign-{suffix}"),
                "attemptId": attempt,
                "message": "fixture prompt"
            }),
        );
        assert_eq!(sent["ok"], true, "send was refused: {sent}");
        attempts.push(attempt);
    }

    let mut decisions = Vec::new();
    for round in 0..600 {
        call(&server, &format!("grok-poll-{round}"), "snapshot", json!({}));
        decisions = store.list_decisions().expect("decisions readable");
        if decisions.len() >= 2 {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    assert_eq!(
        decisions.len(),
        2,
        "both fake sessions must create their own Decision: {decisions:#?}"
    );
    let ids = decisions
        .iter()
        .map(|decision| decision.id.clone())
        .collect::<Vec<_>>();
    assert_ne!(ids[0], ids[1], "Decision ids must not collide");
    // Both agents used agent->client JSON-RPC id 0; only the session-derived
    // prefix keeps the two Decisions apart.
    assert!(ids.iter().all(|id| id.starts_with("grok-") && id.ends_with("-0")));
    assert_eq!(
        decisions
            .iter()
            .map(|decision| decision.attempt_id.clone())
            .collect::<std::collections::HashSet<_>>()
            .len(),
        2
    );

    for (index, decision) in decisions.iter().enumerate() {
        let resolved = call(
            &server,
            &format!("grok-resolve-{index}"),
            "resolve_decision",
            json!({ "decisionId": decision.id, "allow": true }),
        );
        assert_eq!(resolved["ok"], true, "decision was not resolved: {resolved}");
    }
    assert!(
        store
            .list_decisions()
            .expect("decisions readable")
            .iter()
            .all(|decision| decision.state != goalport_core::DecisionState::Pending)
    );
    assert_eq!(attempts.len(), 2);
}

#[test]
fn send_to_terminal_attempt_is_refused() {
    let workspace = fixture_workspace("terminal-guard", "end_turn");
    let (server, store) = core_server(&workspace, "66666666-7777-4888-8999-aaaaaaaaaaaa");
    let selected = snapshot_of(&call(
        &server,
        "terminal-select",
        "select_runtime",
        json!({
            "campaignId": "campaign-synthetic-preview",
            "taskId": "task-synthetic-preview",
            "provider": "scenario"
        }),
    ));
    let attempt = selected["attempt"]["id"]
        .as_str()
        .expect("attempt id")
        .to_owned();

    let first_send = call(
        &server,
        "terminal-send-1",
        "send_message",
        json!({
            "campaignId": "campaign-synthetic-preview",
            "attemptId": attempt,
            "message": "first turn"
        }),
    );
    assert_eq!(first_send["ok"], true);
    let stopped = call(
        &server,
        "terminal-stop",
        "interrupt",
        json!({ "attemptId": attempt }),
    );
    assert_eq!(stopped["ok"], true);
    assert_eq!(
        store
            .get_attempt(&attempt)
            .expect("attempt readable")
            .state,
        goalport_core::AttemptState::Cancelled
    );

    let before = store
        .list_event_records(&attempt, 0)
        .expect("events readable")
        .len();
    let refused = call(
        &server,
        "terminal-send-2",
        "send_message",
        json!({
            "campaignId": "campaign-synthetic-preview",
            "attemptId": attempt,
            "message": "second turn"
        }),
    );
    assert_eq!(refused["ok"], false);
    let error = refused["error"].as_str().expect("refusal carries a reason");
    assert!(
        error.contains("attempt is terminal (CANCELLED)"),
        "unexpected refusal text: {error}"
    );
    assert!(error.contains("select a Runtime to start a new Attempt"));
    // Nothing was persisted for the refused message: no user event, no command.
    let after = store
        .list_event_records(&attempt, 0)
        .expect("events readable");
    assert_eq!(after.len(), before);
    assert!(
        !after
            .iter()
            .any(|record| record.event.kind == "message.user"
                && record
                    .payload
                    .as_ref()
                    .is_some_and(|payload| payload.to_string().contains("second turn")))
    );
}

// ---------------------------------------------------------------------------
// Fix round 2 (critic findings F1-F3)
// ---------------------------------------------------------------------------

#[test]
fn cancel_while_permission_pending_unblocks_reader() {
    // F1: the reader blocks on the Core Decision while a native permission is pending.
    // Safe stop must release it, answer the pending request `cancelled`, and let the
    // cancelled stopReason through — otherwise the Attempt is trapped until the user answers.
    let workspace = fixture_workspace("cancel-pending-permission", "permission");
    let (mut manager, _) = attach("attempt-cancel-pending", &workspace);
    send(&mut manager, "attempt-cancel-pending");
    let mut events = drain_until(&mut manager, "attempt-cancel-pending", |seen| {
        has(seen, AgentEventType::PermissionRequest)
    });
    assert!(has(&events, AgentEventType::PermissionRequest));
    assert!(
        !has(&events, AgentEventType::PermissionResponse),
        "the permission must still be unanswered when Safe stop is pressed"
    );

    // No Decision is answered: the only action is Safe stop.
    let cancel = manager
        .interrupt("attempt-cancel-pending")
        .expect("interrupt should be accepted while a permission is pending");
    assert!(cancel.requested);
    assert!(!cancel.confirmed);

    events.extend(drain_until(&mut manager, "attempt-cancel-pending", |seen| {
        has(seen, AgentEventType::Cancelled)
    }));

    let cancelled = first(&events, AgentEventType::Cancelled);
    assert_eq!(cancelled.payload["status"], "cancelled");
    assert_eq!(
        cancelled.payload["text"],
        "Grok turn cancelled (stopReason=cancelled)"
    );
    let response = first(&events, AgentEventType::PermissionResponse);
    assert_eq!(response.payload["option_kind"], "cancelled");
    assert_eq!(response.payload["cancelled"], true);
    assert_eq!(response.payload["allow"], false);
    assert_eq!(response.payload["option_id"], "");
    // A cancel selects no option at all.
    let serialized = serde_json::to_string(&events).expect("events serialize");
    assert!(!serialized.contains("allow_once"));
    assert!(!serialized.contains("reject_once"));
    assert!(!serialized.contains("allow-once"));
    assert!(!serialized.contains("reject-once"));
    assert!(!has(&events, AgentEventType::TurnCompleted));
}

#[test]
fn cancelled_permission_decision_is_not_left_pending() {
    // The Core-level half of F1: the Decision row must be closed, not stranded PENDING.
    let workspace = fixture_workspace("cancel-pending-decision", "permission");
    let (server, store) = core_server(&workspace, "22222222-3333-4444-8555-666666666666");
    let executable = fake_agent().to_string_lossy().into_owned();
    call(
        &server,
        "grok-campaign-cancelpend",
        "create_campaign",
        json!({ "goal": "cancel a pending permission" }),
    );
    let response = call(
        &server,
        "grok-select-cancelpend",
        "select_runtime",
        json!({
            "campaignId": "campaign-grok-campaign-cancelpend",
            "taskId": "task-grok-campaign-cancelpend",
            "provider": "grok",
            "executable": executable
        }),
    );
    assert_eq!(response["ok"], true, "grok runtime was refused: {response}");
    let attempt = snapshot_of(&response)["attempt"]["id"]
        .as_str()
        .expect("attempt id")
        .to_owned();
    let sent = call(
        &server,
        "grok-send-cancelpend",
        "send_message",
        json!({
            "campaignId": "campaign-grok-campaign-cancelpend",
            "attemptId": attempt,
            "message": "fixture prompt"
        }),
    );
    assert_eq!(sent["ok"], true, "send was refused: {sent}");

    // Wait for the pending Decision, then Safe stop WITHOUT answering it.
    let mut decision_id = String::new();
    for round in 0..600 {
        call(&server, &format!("cancelpend-poll-{round}"), "snapshot", json!({}));
        if let Some(decision) = store
            .list_decisions()
            .expect("decisions readable")
            .into_iter()
            .find(|decision| decision.attempt_id == attempt)
        {
            decision_id = decision.id;
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(!decision_id.is_empty(), "no Decision was created");
    assert_eq!(
        store
            .get_decision(&decision_id)
            .expect("decision readable")
            .state,
        goalport_core::DecisionState::Pending
    );

    let stopped = call(
        &server,
        "cancelpend-stop",
        "interrupt",
        json!({ "attemptId": attempt }),
    );
    assert_eq!(stopped["ok"], true, "interrupt was refused: {stopped}");

    let mut final_state = goalport_core::DecisionState::Pending;
    let mut attempt_state = goalport_core::AttemptState::Active;
    for round in 0..600 {
        call(&server, &format!("cancelpend-after-{round}"), "snapshot", json!({}));
        final_state = store
            .get_decision(&decision_id)
            .expect("decision readable")
            .state;
        attempt_state = store.get_attempt(&attempt).expect("attempt readable").state;
        if final_state != goalport_core::DecisionState::Pending
            && attempt_state == goalport_core::AttemptState::Cancelled
        {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    assert_eq!(final_state, goalport_core::DecisionState::Cancelled);
    assert_eq!(attempt_state, goalport_core::AttemptState::Cancelled);
}

#[test]
fn second_prompt_while_turn_in_flight_is_refused() {
    // F2: a second prompt must not overwrite the in-flight turn id and orphan the first
    // response. It is refused outright; nothing is queued.
    let workspace = fixture_workspace("second-prompt", "cancel");
    let (mut manager, _) = attach("attempt-second-prompt", &workspace);
    let started = send(&mut manager, "attempt-second-prompt");
    assert_eq!(started.len(), 1);
    let running = drain_until(&mut manager, "attempt-second-prompt", |seen| {
        has(seen, AgentEventType::ToolActivity)
    });
    assert!(has(&running, AgentEventType::ToolActivity));

    let refused = manager
        .send_prompt(
            "attempt-second-prompt",
            &PromptRequest {
                attempt_id: "attempt-second-prompt".into(),
                text: "second prompt".into(),
                idempotency_key: "attempt-second-prompt-2".into(),
            },
        )
        .expect_err("a second prompt must be refused while a turn is in flight");
    let message = refused.to_string();
    assert!(
        message.contains("a Grok turn is already in flight"),
        "unexpected refusal: {message}"
    );
    assert!(manager.turn_in_flight("attempt-second-prompt"));

    // The first turn is still the tracked one and still completes normally.
    let cancel = manager.interrupt("attempt-second-prompt").expect("interrupt");
    assert!(cancel.requested);
    let events = drain_until(&mut manager, "attempt-second-prompt", |seen| {
        has(seen, AgentEventType::Cancelled)
    });
    assert!(has(&events, AgentEventType::Cancelled));
    assert!(!manager.turn_in_flight("attempt-second-prompt"));
}

#[test]
fn second_message_while_turn_in_flight_is_refused_before_persisting() {
    // The Core-level half of F2: the refusal happens before any user event is journalled,
    // so the GUI shows `Core refused:` and the transcript keeps no orphan message.
    let workspace = fixture_workspace("second-message", "cancel");
    let (server, store) = core_server(&workspace, "33333333-4444-4555-8666-777777777777");
    let executable = fake_agent().to_string_lossy().into_owned();
    call(
        &server,
        "grok-campaign-inflight",
        "create_campaign",
        json!({ "goal": "second message while in flight" }),
    );
    let response = call(
        &server,
        "grok-select-inflight",
        "select_runtime",
        json!({
            "campaignId": "campaign-grok-campaign-inflight",
            "taskId": "task-grok-campaign-inflight",
            "provider": "grok",
            "executable": executable
        }),
    );
    assert_eq!(response["ok"], true, "grok runtime was refused: {response}");
    let attempt = snapshot_of(&response)["attempt"]["id"]
        .as_str()
        .expect("attempt id")
        .to_owned();
    let first_send = call(
        &server,
        "grok-send-inflight-1",
        "send_message",
        json!({
            "campaignId": "campaign-grok-campaign-inflight",
            "attemptId": attempt,
            "message": "first prompt"
        }),
    );
    assert_eq!(first_send["ok"], true, "first send was refused: {first_send}");

    let before = store
        .list_event_records(&attempt, 0)
        .expect("events readable")
        .len();
    let refused = call(
        &server,
        "grok-send-inflight-2",
        "send_message",
        json!({
            "campaignId": "campaign-grok-campaign-inflight",
            "attemptId": attempt,
            "message": "second prompt"
        }),
    );
    assert_eq!(refused["ok"], false);
    let error = refused["error"].as_str().expect("refusal carries a reason");
    assert!(
        error.contains("a Grok turn is already in flight"),
        "unexpected refusal text: {error}"
    );
    let after = store
        .list_event_records(&attempt, 0)
        .expect("events readable");
    assert!(
        !after.iter().any(|record| record.event.kind == "message.user"
            && record
                .payload
                .as_ref()
                .is_some_and(|payload| payload.to_string().contains("second prompt"))),
        "a refused second prompt must not be persisted"
    );
    // Only Runtime events may have arrived meanwhile; no user event was added.
    let user_messages = after
        .iter()
        .filter(|record| record.event.kind == "message.user")
        .count();
    assert_eq!(user_messages, 1, "exactly one user message survives");
    assert!(after.len() >= before);
}

#[test]
fn exited_child_is_not_reported_live() {
    // F3: once the child is gone the projection must not see it as a live native Runtime,
    // otherwise a dead Grok looks attached and the Attempt can neither recover nor refuse.
    let workspace = fixture_workspace("exited-child", "stream_eof");
    let (mut manager, _) = attach("attempt-exited", &workspace);
    assert!(
        manager.native_pid("attempt-exited").is_some(),
        "a freshly spawned child is live"
    );
    send(&mut manager, "attempt-exited");
    let events = drain_until(&mut manager, "attempt-exited", |seen| {
        has(seen, AgentEventType::TurnFailed)
    });
    assert_eq!(
        first(&events, AgentEventType::TurnFailed).payload["text"],
        "native Runtime closed the ACP stream"
    );

    assert!(
        manager.native_pid("attempt-exited").is_none(),
        "an exited child must not be reported live"
    );
    assert!(manager.process_binding("attempt-exited").is_some());

    // No respawn, no new session: the next send is refused visibly instead.
    let refused = manager
        .send_prompt(
            "attempt-exited",
            &PromptRequest {
                attempt_id: "attempt-exited".into(),
                text: "after the stream closed".into(),
                idempotency_key: "attempt-exited-2".into(),
            },
        )
        .expect_err("a closed stream must refuse the next prompt");
    assert!(
        refused.to_string().contains("native Runtime closed the ACP stream"),
        "unexpected refusal: {refused}"
    );
    assert!(!has(&events, AgentEventType::SessionCreated));
}

// ---------------------------------------------------------------------------
// Fix round 3 (critic round 2 findings K1/K2)
// ---------------------------------------------------------------------------

#[test]
fn stale_cancel_does_not_affect_next_permission() {
    // K1: Safe stop pressed while a turn id is still set but NO permission is pending must not
    // leave a cancel queued that the NEXT turn's first permission request silently consumes.
    let workspace = fixture_workspace("stale-cancel", "permission_second_turn");
    let (mut manager, _) = attach("attempt-stale-cancel", &workspace);

    // Turn 1 answers end_turn at once and never asks for permission. Interrupt immediately, in
    // the exact window the critic described: turn_request_id is still set, nothing is pending.
    send(&mut manager, "attempt-stale-cancel");
    let cancel = manager
        .interrupt("attempt-stale-cancel")
        .expect("interrupt is accepted");
    assert!(!cancel.confirmed);
    let first_turn = drain_until(&mut manager, "attempt-stale-cancel", |seen| {
        has(seen, AgentEventType::TurnCompleted) || has(seen, AgentEventType::Cancelled)
    });
    assert!(
        !has(&first_turn, AgentEventType::PermissionResponse),
        "no permission existed in turn 1, so none may be answered: {first_turn:#?}"
    );

    // Turn 2 asks for permission. It must reach the Decision Inbox still pending.
    send(&mut manager, "attempt-stale-cancel");
    let mut second = drain_until(&mut manager, "attempt-stale-cancel", |seen| {
        has(seen, AgentEventType::PermissionRequest)
    });
    let request_id = first(&second, AgentEventType::PermissionRequest).payload["request_id"]
        .as_str()
        .expect("permission request carries a Decision id")
        .to_owned();
    // Give any leaked cancel a generous chance to be consumed; it must not exist.
    for _ in 0..20 {
        second.extend(manager.poll_events("attempt-stale-cancel").expect("poll"));
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(
        !has(&second, AgentEventType::PermissionResponse),
        "a stale cancel answered turn 2's permission without a GUI decision: {second:#?}"
    );

    // And the Decision is still answerable by the user, the normal way.
    manager
        .permission_response(
            "attempt-stale-cancel",
            PermissionResponse {
                request_id: request_id.clone(),
                allow: true,
            },
        )
        .expect("decision reaches the reader");
    second.extend(drain_until(&mut manager, "attempt-stale-cancel", |seen| {
        has(seen, AgentEventType::PermissionResponse)
    }));
    let response = first(&second, AgentEventType::PermissionResponse);
    assert_eq!(response.payload["request_id"], request_id.as_str());
    assert_eq!(response.payload["option_kind"], "allow_once");
    assert_eq!(response.payload["cancelled"], false);
}

#[test]
fn cancel_targets_only_pending_request() {
    // K1: a cancel is addressed to the exact pending request id, never sent untargeted.
    let workspace = fixture_workspace("cancel-targeted", "permission");
    let (mut manager, _) = attach("attempt-cancel-targeted", &workspace);
    send(&mut manager, "attempt-cancel-targeted");
    let mut events = drain_until(&mut manager, "attempt-cancel-targeted", |seen| {
        has(seen, AgentEventType::PermissionRequest)
    });
    let request_id = first(&events, AgentEventType::PermissionRequest).payload["request_id"]
        .as_str()
        .expect("permission request carries a Decision id")
        .to_owned();

    manager
        .interrupt("attempt-cancel-targeted")
        .expect("interrupt is accepted");
    events.extend(drain_until(&mut manager, "attempt-cancel-targeted", |seen| {
        has(seen, AgentEventType::PermissionResponse)
    }));
    let response = first(&events, AgentEventType::PermissionResponse);
    assert_eq!(
        response.payload["request_id"],
        request_id.as_str(),
        "the cancelled response must name the request that was actually pending"
    );
    assert_eq!(response.payload["option_kind"], "cancelled");
    assert_eq!(response.payload["cancelled"], true);
    assert_eq!(
        events
            .iter()
            .filter(|event| event.event_type == AgentEventType::PermissionResponse)
            .count(),
        1,
        "exactly one response per request"
    );
}

#[test]
fn child_exit_while_permission_pending_marks_failed_and_releases_reader() {
    // K2: the reader blocked on a pending permission cannot see its own EOF. Core must notice
    // the dead child, close the Decision as cancelled and fail the turn — fail-closed, no respawn.
    let workspace = fixture_workspace("exit-pending-permission", "permission_then_exit");
    let (mut manager, _) = attach("attempt-exit-pending", &workspace);
    send(&mut manager, "attempt-exit-pending");
    let mut events = drain_until(&mut manager, "attempt-exit-pending", |seen| {
        has(seen, AgentEventType::PermissionRequest)
    });
    let request_id = first(&events, AgentEventType::PermissionRequest).payload["request_id"]
        .as_str()
        .expect("permission request carries a Decision id")
        .to_owned();

    events.extend(drain_until(&mut manager, "attempt-exit-pending", |seen| {
        has(seen, AgentEventType::TurnFailed) && has(seen, AgentEventType::PermissionResponse)
    }));

    let response = first(&events, AgentEventType::PermissionResponse);
    assert_eq!(response.payload["request_id"], request_id.as_str());
    assert_eq!(response.payload["option_kind"], "cancelled");
    assert_eq!(response.payload["cancelled"], true);
    let failed = first(&events, AgentEventType::TurnFailed);
    assert_eq!(
        failed.payload["text"],
        "native Runtime closed the ACP stream"
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| event.event_type == AgentEventType::TurnFailed)
            .count(),
        1,
        "the closed stream must fail the turn exactly once"
    );
    // R2: the released reader and poll_events can both reach a dying permission. Exactly one
    // runtime.permission.response may be journalled per request id.
    let responses = events
        .iter()
        .filter(|event| event.event_type == AgentEventType::PermissionResponse)
        .collect::<Vec<_>>();
    assert_eq!(
        responses.len(),
        1,
        "exactly one PermissionResponse per request, saw {responses:#?}"
    );
    assert_eq!(responses[0].payload["request_id"], request_id.as_str());
    assert!(
        manager.native_pid("attempt-exit-pending").is_none(),
        "an exited child is not live"
    );
    assert!(!has(&events, AgentEventType::SessionCreated), "no new session");
    assert!(!has(&events, AgentEventType::TurnCompleted));
    let serialized = serde_json::to_string(&events).expect("events serialize");
    assert!(!serialized.contains("allow_once"));
    assert!(!serialized.contains("reject_once"));
}

#[test]
fn interrupt_releases_reader_even_if_pipe_is_broken() {
    // K2(b): the reader must be released even when the session/cancel write cannot be delivered,
    // otherwise a dead pipe traps Safe stop for ever. interrupt() must not return Err in that case.
    let workspace = fixture_workspace("interrupt-broken-pipe", "permission_then_exit");
    let (mut manager, _) = attach("attempt-broken-pipe", &workspace);
    send(&mut manager, "attempt-broken-pipe");
    let mut events = drain_until(&mut manager, "attempt-broken-pipe", |seen| {
        has(seen, AgentEventType::PermissionRequest)
    });
    let request_id = first(&events, AgentEventType::PermissionRequest).payload["request_id"]
        .as_str()
        .expect("permission request carries a Decision id")
        .to_owned();

    // The fake agent exits ~700 ms after publishing the request. Wait past that WITHOUT polling,
    // so the child is already gone when Safe stop runs and the wire write has to cope with it.
    std::thread::sleep(Duration::from_millis(2500));
    let cancel = manager
        .interrupt("attempt-broken-pipe")
        .expect("interrupt must not fail even when the pipe is broken");
    assert!(!cancel.confirmed);
    if !cancel.requested {
        let reason = cancel.reason.clone().unwrap_or_default();
        assert!(
            reason.contains("session/cancel could not be written"),
            "unexpected reason: {reason}"
        );
        assert!(reason.contains("the reader was released"));
    }

    events.extend(drain_until(&mut manager, "attempt-broken-pipe", |seen| {
        has(seen, AgentEventType::TurnFailed) && has(seen, AgentEventType::PermissionResponse)
    }));
    let response = first(&events, AgentEventType::PermissionResponse);
    assert_eq!(response.payload["request_id"], request_id.as_str());
    assert_eq!(response.payload["option_kind"], "cancelled");
    assert_eq!(
        first(&events, AgentEventType::TurnFailed).payload["text"],
        "native Runtime closed the ACP stream"
    );
    assert!(manager.native_pid("attempt-broken-pipe").is_none());
}

// ---------------------------------------------------------------------------
// Fix round 4 (critic round 3 / auditor r3: R1 drain-vs-publish window)
// ---------------------------------------------------------------------------

#[test]
fn cancel_after_publish_is_never_drained() {
    // R1: the reader used to set `pending_permission` BEFORE draining the command channel, so a
    // Safe stop landing in that gap enqueued a correctly targeted cancel that the drain then
    // threw away — the first Safe stop of a turn was silently lost. The drain and the publish
    // now happen under one lock, drain first, and `interrupt` enqueues under the same lock.
    let workspace = fixture_workspace("cancel-after-publish", "permission_second_turn");
    let (mut manager, _) = attach("attempt-cancel-publish", &workspace);

    // Turn 1 asks for no permission. Queue a command while nothing is published: it must be
    // drained and must never be mistaken for an answer to turn 2's request.
    send(&mut manager, "attempt-cancel-publish");
    manager
        .permission_response(
            "attempt-cancel-publish",
            PermissionResponse {
                request_id: "grok-stale-decision-0".into(),
                allow: true,
            },
        )
        .expect("a stale command can be enqueued");
    let cancel = manager
        .interrupt("attempt-cancel-publish")
        .expect("interrupt is accepted");
    assert!(!cancel.confirmed);
    let first_turn = drain_until(&mut manager, "attempt-cancel-publish", |seen| {
        has(seen, AgentEventType::TurnCompleted) || has(seen, AgentEventType::Cancelled)
    });
    assert!(
        !has(&first_turn, AgentEventType::PermissionResponse),
        "turn 1 had no permission, so none may be answered: {first_turn:#?}"
    );

    // Turn 2 publishes a real request. The stale command must have been drained.
    send(&mut manager, "attempt-cancel-publish");
    let mut events = drain_until(&mut manager, "attempt-cancel-publish", |seen| {
        has(seen, AgentEventType::PermissionRequest)
    });
    let request_id = first(&events, AgentEventType::PermissionRequest).payload["request_id"]
        .as_str()
        .expect("permission request carries a Decision id")
        .to_owned();
    for _ in 0..20 {
        events.extend(manager.poll_events("attempt-cancel-publish").expect("poll"));
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(
        !has(&events, AgentEventType::PermissionResponse),
        "a drained stale command must not answer the new request: {events:#?}"
    );

    // Now Safe stop AFTER publication: this cancel is past the drain and must be honoured on
    // the very first press.
    let cancel = manager
        .interrupt("attempt-cancel-publish")
        .expect("interrupt is accepted");
    assert!(!cancel.confirmed);
    events.extend(drain_until(&mut manager, "attempt-cancel-publish", |seen| {
        has(seen, AgentEventType::PermissionResponse)
    }));
    let responses = events
        .iter()
        .filter(|event| event.event_type == AgentEventType::PermissionResponse)
        .collect::<Vec<_>>();
    assert_eq!(
        responses.len(),
        1,
        "one press, one response, saw {responses:#?}"
    );
    assert_eq!(responses[0].payload["request_id"], request_id.as_str());
    assert_eq!(responses[0].payload["option_kind"], "cancelled");
    assert_eq!(responses[0].payload["cancelled"], true);
    let serialized = serde_json::to_string(&events).expect("events serialize");
    assert!(!serialized.contains("allow_once"));
    assert!(!serialized.contains("reject_once"));
}

// ---------------------------------------------------------------------------
// Fix round 5 (critic round 4 finding V1: the pre-publication cancel window)
// ---------------------------------------------------------------------------

#[test]
fn cancel_before_publish_is_latched_and_honoured() {
    // V1: `interrupt()` used to enqueue nothing when no permission was pending yet, so a Safe
    // stop pressed while the reader was still decoding the request left no trace: the reader
    // published and blocked, and only a SECOND press released it. The cancel is now latched for
    // the current turn and consumed by the reader before it blocks.
    //
    // The window is made deterministic by the fake agent: it emits tool activity, waits 2.5 s,
    // and only then publishes the permission request. Safe stop is pressed inside that gap.
    let workspace = fixture_workspace("cancel-before-publish", "permission_delayed");
    let (mut manager, _) = attach("attempt-cancel-prepublish", &workspace);
    send(&mut manager, "attempt-cancel-prepublish");

    let running = drain_until(&mut manager, "attempt-cancel-prepublish", |seen| {
        has(seen, AgentEventType::ToolActivity)
    });
    assert!(has(&running, AgentEventType::ToolActivity));
    assert!(
        !has(&running, AgentEventType::PermissionRequest),
        "the request must still be unpublished when Safe stop is pressed"
    );

    // ONE press, before the request exists.
    let cancel = manager
        .interrupt("attempt-cancel-prepublish")
        .expect("interrupt is accepted");
    assert!(!cancel.confirmed);

    let mut events = running;
    events.extend(drain_until(&mut manager, "attempt-cancel-prepublish", |seen| {
        has(seen, AgentEventType::PermissionResponse)
            && (has(seen, AgentEventType::Cancelled) || has(seen, AgentEventType::TurnFailed))
    }));

    let request = first(&events, AgentEventType::PermissionRequest);
    let request_id = request.payload["request_id"]
        .as_str()
        .expect("permission request carries a Decision id")
        .to_owned();
    let responses = events
        .iter()
        .filter(|event| event.event_type == AgentEventType::PermissionResponse)
        .collect::<Vec<_>>();
    assert_eq!(
        responses.len(),
        1,
        "one press, exactly one response, saw {responses:#?}"
    );
    assert_eq!(responses[0].payload["request_id"], request_id.as_str());
    assert_eq!(responses[0].payload["option_kind"], "cancelled");
    assert_eq!(responses[0].payload["cancelled"], true);
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(
                event.event_type,
                AgentEventType::Cancelled | AgentEventType::TurnFailed
            ))
            .count(),
        1,
        "the turn ends exactly once"
    );
    assert!(!has(&events, AgentEventType::TurnCompleted));
    let serialized = serde_json::to_string(&events).expect("events serialize");
    assert!(!serialized.contains("allow_once"));
    assert!(!serialized.contains("reject_once"));
    assert!(!serialized.contains("allow-once"));
    assert!(!serialized.contains("reject-once"));
}

#[test]
fn latched_cancel_does_not_reach_a_later_turn() {
    // The V1 latch belongs to the turn it was pressed in: `send_prompt` clears it, so the next
    // turn's permission still reaches the Decision Inbox and is answerable by the user.
    let workspace = fixture_workspace("latch-not-leaked", "permission_second_turn");
    let (mut manager, _) = attach("attempt-latch-leak", &workspace);

    // Turn 1 asks for nothing; press Safe stop so the latch is raised with no pending request.
    send(&mut manager, "attempt-latch-leak");
    manager
        .interrupt("attempt-latch-leak")
        .expect("interrupt is accepted");
    let first_turn = drain_until(&mut manager, "attempt-latch-leak", |seen| {
        has(seen, AgentEventType::TurnCompleted) || has(seen, AgentEventType::Cancelled)
    });
    assert!(!has(&first_turn, AgentEventType::PermissionResponse));

    // Turn 2 publishes a real request: the stale latch must not answer it.
    send(&mut manager, "attempt-latch-leak");
    let mut events = drain_until(&mut manager, "attempt-latch-leak", |seen| {
        has(seen, AgentEventType::PermissionRequest)
    });
    let request_id = first(&events, AgentEventType::PermissionRequest).payload["request_id"]
        .as_str()
        .expect("permission request carries a Decision id")
        .to_owned();
    for _ in 0..20 {
        events.extend(manager.poll_events("attempt-latch-leak").expect("poll"));
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(
        !has(&events, AgentEventType::PermissionResponse),
        "a latch from turn 1 must not cancel turn 2's permission: {events:#?}"
    );

    manager
        .permission_response(
            "attempt-latch-leak",
            PermissionResponse {
                request_id: request_id.clone(),
                allow: true,
            },
        )
        .expect("decision reaches the reader");
    events.extend(drain_until(&mut manager, "attempt-latch-leak", |seen| {
        has(seen, AgentEventType::PermissionResponse)
    }));
    let response = first(&events, AgentEventType::PermissionResponse);
    assert_eq!(response.payload["request_id"], request_id.as_str());
    assert_eq!(response.payload["option_kind"], "allow_once");
    assert_eq!(response.payload["cancelled"], false);
}

// ---------------------------------------------------------------------------
// Fix round 6 (critic round 5 finding W1: Decision ids across a resumed session)
// ---------------------------------------------------------------------------

#[test]
fn resumed_session_permission_ids_do_not_collide() {
    // W1: agent->client JSON-RPC ids restart at 0 for every spawned process, and a session/load
    // of the SAME session after a Core restart reuses the session hash too. The Decision id used
    // to be session-hash + native id only, so the first permission of a resumed session collided
    // with an earlier Decision of that attempt: store.insert_decision conflicts on a reused id
    // with a different state, persist_agent_event errors, and the request is stranded.
    let workspace = fixture_workspace("resumed-session-ids", "permission");
    let attempt = "attempt-resume-collide";
    let mut manager = RuntimeManager::new();
    manager
        .select_runtime(attempt, "grok", Some(fake_agent()), "1.0.13", &workspace)
        .expect("grok runtime should be selectable");
    let session = manager
        .create_session(attempt, &session_request(attempt, &workspace))
        .expect("grok ACP session should be created");
    let session_id = session.handle.session_id.clone();
    assert!(!session_id.is_empty());

    send(&mut manager, attempt);
    let first_events = drain_until(&mut manager, attempt, |seen| {
        has(seen, AgentEventType::PermissionRequest)
    });
    let first_id = first(&first_events, AgentEventType::PermissionRequest).payload["request_id"]
        .as_str()
        .expect("permission request carries a Decision id")
        .to_owned();
    manager
        .permission_response(
            attempt,
            PermissionResponse {
                request_id: first_id.clone(),
                allow: true,
            },
        )
        .expect("decision reaches the reader");
    drain_until(&mut manager, attempt, |seen| {
        has(seen, AgentEventType::TurnCompleted)
    });

    // A Core restart: the SAME attempt is re-attached to a NEW Grok process which loads the SAME
    // native session. A restarted Core has a fresh RuntimeManager, so the restart is modelled with
    // one: the old manager (and its child) is dropped here, and the registration boundary of the
    // new manager sees a vacant key. (Re-selecting on the same manager is refused by design.)
    drop(manager);
    let mut manager = RuntimeManager::new();
    manager
        .select_runtime(attempt, "grok", Some(fake_agent()), "1.0.13", &workspace)
        .expect("grok runtime should be selectable on the restarted manager");
    let mut resumed_request = session_request(attempt, &workspace);
    resumed_request.resume_session = Some(session_id.clone());
    let resumed = manager
        .create_session(attempt, &resumed_request)
        .expect("the native session should load in the new process");
    assert!(resumed.handle.resumed);
    assert_eq!(resumed.handle.session_id, session_id, "same native session");

    send(&mut manager, attempt);
    let second_events = drain_until(&mut manager, attempt, |seen| {
        has(seen, AgentEventType::PermissionRequest)
    });
    let second_id = first(&second_events, AgentEventType::PermissionRequest).payload["request_id"]
        .as_str()
        .expect("permission request carries a Decision id")
        .to_owned();

    // Same session, same native JSON-RPC id 0 - and still two different Decision ids.
    assert!(first_id.ends_with("-0"), "native id 0: {first_id}");
    assert!(second_id.ends_with("-0"), "native id 0 again: {second_id}");
    assert_ne!(
        first_id, second_id,
        "a resumed session must not reuse an earlier Decision id"
    );
    let session_prefix = first_id.split('-').nth(1).expect("session segment").to_owned();
    assert_eq!(
        second_id.split('-').nth(1).expect("session segment"),
        session_prefix,
        "the session segment is identical, which is exactly what made the collision possible"
    );
    assert_ne!(
        first_id.split('-').nth(2).expect("process segment"),
        second_id.split('-').nth(2).expect("process segment"),
        "the per-process segment is what keeps them apart"
    );

    // Both Decisions insert and resolve on the SAME attempt through the real store API that
    // persist_agent_event and resolve_decision use; a reused id would raise IdempotencyConflict.
    let store = Store::memory().expect("in-memory store");
    store
        .insert_attempt(&goalport_core::Attempt::new(
            attempt,
            "task-resume-collide",
            "grok",
            "grok-cap-v1",
        ))
        .expect("attempt inserts");
    for id in [&first_id, &second_id] {
        store
            .insert_decision(&goalport_core::Decision {
                id: id.clone(),
                attempt_id: attempt.into(),
                kind: "permission".into(),
                state: goalport_core::DecisionState::Pending,
            })
            .unwrap_or_else(|error| panic!("decision {id} must insert: {error}"));
    }
    for id in [&first_id, &second_id] {
        store
            .update_decision_state(id, goalport_core::DecisionState::Approved)
            .unwrap_or_else(|error| panic!("decision {id} must resolve: {error}"));
    }
    assert_eq!(store.list_decisions().expect("decisions readable").len(), 2);
}
