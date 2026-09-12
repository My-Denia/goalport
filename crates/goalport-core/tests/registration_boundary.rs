//! Increment 2 of run `goal-runs/runtime-registration-safety`: the registration boundary must refuse
//! to replace an occupied key, a legitimate same-binding re-selection must return the existing
//! selection without creating a Runtime, session or Attempt, an inconsistent request under a held
//! attempt id must be refused explicitly, and a refused re-selection must change nothing. Reuse is not
//! a way around the authorization or held-workspace checks.
//!
//! Command-surface cases (U*) drive `CoreServer::handle_json` with provider `scenario` (no process) on
//! the store shape **T** of `selection_preservation.rs` (two campaigns on the seeded project, live
//! selection on campaign 1). Manager cases (M*) drive `RuntimeManager` directly, also without a process.

use goalport_core::{
    Project, PromptRequest, RuntimeManager, SessionRequest,
    adapters::AdapterError,
    domain::{Campaign, Task, WorkStatus},
    ipc::{CONNECTED_UI_PROTOCOL_VERSION, CoreServer},
    store::{CampaignAuthorization, Store},
};
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Mutex};

const SEED_PROJECT: &str = "project-synthetic";
const SEED_CAMPAIGN: &str = "campaign-synthetic-preview";
const SEED_TASK: &str = "task-synthetic-preview";
const EXPLICIT_ATTEMPT: &str = "attempt-u-explicit";

/// The runner removes every `GOALPORT_*` variable and pins the two roots. `GOALPORT_CODEX_TRANSPORT`
/// is the one additional key this file may see, transiently, while M3 holds `ENV_LOCK`.
fn assert_env_pinned() {
    for (key, _) in std::env::vars() {
        if key.starts_with("GOALPORT_") {
            assert!(
                key == "GOALPORT_SYNTHETIC_ROOT"
                    || key == "GOALPORT_TEST_ARTIFACT_ROOT"
                    || key == "GOALPORT_CODEX_TRANSPORT",
                "stray {key} in the test environment; the runner must scrub GOALPORT_* first"
            );
        }
    }
}

static ENV_LOCK: Mutex<()> = Mutex::new(());

fn request(id: &str, message_type: &str, payload: Value) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "protocolVersion": CONNECTED_UI_PROTOCOL_VERSION,
        "requestId": id,
        "entityVersion": 0,
        "messageType": message_type,
        "payload": payload
    }))
    .unwrap()
}

fn call(server: &CoreServer, id: &str, message_type: &str, payload: Value) -> Value {
    server
        .handle_json(&request(id, message_type, payload))
        .expect("the command envelope must be accepted by handle_json")
}

fn snapshot(server: &CoreServer, id: &str) -> Value {
    let response = call(server, id, "snapshot", json!({}));
    assert_eq!(response["ok"], true, "snapshot must succeed: {response}");
    response["payload"]["snapshot"].clone()
}

fn error_of(response: &Value) -> String {
    assert_eq!(response["ok"], false, "expected a refusal, got {response}");
    response["error"].as_str().unwrap_or_default().to_string()
}

#[derive(Debug, PartialEq, Eq)]
struct Observed {
    project: String,
    campaign: String,
    task: String,
    attempt: String,
    timeline_len: usize,
    attempt_rows: usize,
}

fn observe(server: &CoreServer, id: &str) -> Observed {
    let view = snapshot(server, id);
    Observed {
        project: view["selectedProjectId"].as_str().unwrap().to_string(),
        campaign: view["activeCampaignId"].as_str().unwrap().to_string(),
        task: view["activeTask"]["id"].as_str().unwrap().to_string(),
        attempt: view["attempt"]["id"].as_str().unwrap().to_string(),
        timeline_len: view["timeline"].as_array().map_or(0, Vec::len),
        attempt_rows: server.processor().store().list_attempts().unwrap().len(),
    }
}

fn add_second_campaign(server: &CoreServer) -> (String, String) {
    let created = call(
        server,
        "t-create-second-campaign",
        "create_campaign_with_task",
        json!({
            "projectId": SEED_PROJECT,
            "goal": "second campaign on the seeded project",
            "title": "second task",
            "acceptance": "exists so a moved selection is visible"
        }),
    );
    assert_eq!(created["ok"], true, "{created}");
    let view = &created["payload"]["snapshot"];
    (
        view["activeCampaignId"].as_str().unwrap().to_string(),
        view["activeTask"]["id"].as_str().unwrap().to_string(),
    )
}

fn seed_payload() -> Value {
    json!({
        "projectId": SEED_PROJECT,
        "provider": "scenario",
        "campaignId": SEED_CAMPAIGN,
        "taskId": SEED_TASK,
        "attemptId": EXPLICIT_ATTEMPT
    })
}

fn seed_server() -> CoreServer {
    assert_env_pinned();
    let store = Store::memory().unwrap();
    store
        .insert_project(&Project {
            id: SEED_PROJECT.into(),
            workspace_root: "synthetic://goalport-fixture".into(),
        })
        .unwrap();
    let campaign = Campaign {
        id: SEED_CAMPAIGN.into(),
        goal: "explicit registration fixture".into(),
        root_task_id: SEED_TASK.into(),
        state: WorkStatus::InProgress,
    };
    store
        .create_campaign_with_task(
            SEED_PROJECT,
            &campaign,
            &Task {
                id: SEED_TASK.into(),
                campaign_id: SEED_CAMPAIGN.into(),
                title: "explicit registration".into(),
                acceptance: "first select creates the Attempt".into(),
                state: WorkStatus::InProgress,
            },
        )
        .unwrap();
    store
        .set_campaign_authorization(SEED_CAMPAIGN, &CampaignAuthorization::granted())
        .unwrap();
    CoreServer::new(store)
}

/// Store T with a successful selection on campaign 1 under the explicit attempt id.
fn selected_server() -> CoreServer {
    let server = seed_server();
    let _ = add_second_campaign(&server);
    let selected = call(&server, "u-select", "select_runtime", seed_payload());
    assert_eq!(selected["ok"], true, "{selected}");
    server
}

fn stable_suffix(value: &str) -> String {
    value
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .collect()
}

// ---------------------------------------------------------------------------------------------
// Command surface
// ---------------------------------------------------------------------------------------------

#[test]
fn u1_legitimate_reselect_returns_existing_selection_without_creating_anything() {
    let server = selected_server();
    let before = observe(&server, "u1-before");
    assert_eq!(before.attempt, EXPLICIT_ATTEMPT);
    assert_eq!(before.campaign, SEED_CAMPAIGN);

    let again = call(&server, "u1-again", "select_runtime", seed_payload());
    assert_eq!(again["ok"], true, "a same-binding re-select must succeed: {again}");
    assert_eq!(again["payload"]["snapshot"]["attempt"]["id"], EXPLICIT_ATTEMPT);

    let after = observe(&server, "u1-after");
    assert_eq!(after, before, "reuse must create no Attempt row, no event and move nothing");
}

#[test]
fn u2_inconsistent_binding_under_the_same_attempt_id_is_refused() {
    let server = selected_server();
    let before = observe(&server, "u2-before");

    let refused = call(
        &server,
        "u2-other-binding",
        "select_runtime",
        json!({
            "provider": "scenario",
            "campaignId": SEED_CAMPAIGN,
            "taskId": SEED_TASK,
            "attemptId": EXPLICIT_ATTEMPT,
            "version": "scenario-2"
        }),
    );
    let error = error_of(&refused);
    assert!(
        error.contains("already bound to a different Runtime binding"),
        "expected the explicit binding conflict, got: {error}"
    );

    let after = observe(&server, "u2-after");
    assert_eq!(after, before, "a conflict refusal must change nothing");
}

#[test]
fn u3_reuse_does_not_bypass_a_revoked_authorization() {
    let server = selected_server();
    let revoked = call(
        &server,
        "u3-revoke",
        "revoke_authorization",
        json!({ "campaignId": SEED_CAMPAIGN, "scope": "provider" }),
    );
    assert_eq!(revoked["ok"], true, "{revoked}");
    let before = observe(&server, "u3-before");

    let refused = call(&server, "u3-again", "select_runtime", seed_payload());
    let error = error_of(&refused);
    assert!(
        error.contains("denies provider attach"),
        "expected the authorization refusal, not a reuse: {error}"
    );

    let after = observe(&server, "u3-after");
    assert_eq!(after, before);
}

#[test]
fn u6_reuse_does_not_bypass_a_held_workspace() {
    let server = selected_server();
    let store = server.processor().store();
    let workspace = store.get_project(SEED_PROJECT).unwrap().workspace_root;
    store
        .begin_stop_responsibility(
            EXPLICIT_ATTEMPT,
            "operation-held",
            &workspace,
            "scenario",
            &json!({
                "input_uuid": "input-7",
                "session_id": "session-9",
                "turn_epoch": 4,
                "process_epoch": "process-3"
            }),
            None,
        )
        .unwrap();
    let before = observe(&server, "u6-before");

    let refused = call(&server, "u6-again", "select_runtime", seed_payload());
    let error = error_of(&refused);
    assert!(
        error.contains("durable Stop responsibility"),
        "expected the held-workspace refusal, not a reuse: {error}"
    );

    let after = observe(&server, "u6-after");
    assert_eq!(after, before);
    let held = store
        .held_stop_for_workspace(&workspace)
        .unwrap()
        .expect("the held Stop must still be there");
    assert_eq!(held.attempt_id, EXPLICIT_ATTEMPT);
}

#[test]
fn u4_unknown_provider_is_refused_before_any_attempt_row_is_written() {
    let server = seed_server();
    let (campaign_two, task_two) = add_second_campaign(&server);
    let before = observe(&server, "u4-before");

    let refused = call(
        &server,
        "u4-nope",
        "select_runtime",
        json!({ "provider": "nope", "campaignId": campaign_two, "taskId": task_two }),
    );
    let _ = error_of(&refused);

    let derived = format!("attempt-{}-nope", stable_suffix(&task_two));
    assert!(
        server.processor().store().get_attempt(&derived).is_err(),
        "an unknown provider must be refused before insert_attempt; row {derived} exists"
    );
    let after = observe(&server, "u4-after");
    assert_eq!(after, before);
}

#[test]
fn u5_fresh_selection_still_registers_and_commits() {
    let server = seed_server();
    let selected = call(&server, "u5-select", "select_runtime", seed_payload());
    assert_eq!(selected["ok"], true, "{selected}");
    assert!(server.processor().store().get_attempt(EXPLICIT_ATTEMPT).is_ok());
    let view = observe(&server, "u5-after");
    assert_eq!(view.project, SEED_PROJECT);
    assert_eq!(view.campaign, SEED_CAMPAIGN);
    assert_eq!(view.task, SEED_TASK);
    assert_eq!(view.attempt, EXPLICIT_ATTEMPT);
}

// ---------------------------------------------------------------------------------------------
// RuntimeManager boundary
// ---------------------------------------------------------------------------------------------

fn session_request(attempt: &str, workspace: &PathBuf) -> SessionRequest {
    SessionRequest {
        campaign_id: Some("campaign-m".into()),
        task_id: "task-m".into(),
        attempt_id: attempt.into(),
        workspace_root: workspace.clone(),
        resume_session: None,
    }
}

fn prompt(attempt: &str, key: &str) -> PromptRequest {
    PromptRequest {
        attempt_id: attempt.into(),
        text: "boundary prompt".into(),
        idempotency_key: key.into(),
    }
}

#[test]
fn m1_occupied_key_is_refused_and_the_original_registration_keeps_working() {
    assert_env_pinned();
    let directory = tempfile::tempdir().unwrap();
    let workspace = directory.path().join("ws");
    std::fs::create_dir_all(&workspace).unwrap();
    let attempt = "attempt-m1";
    let mut manager = RuntimeManager::new();
    manager
        .select_runtime(attempt, "scenario", None, "scenario-1", &workspace)
        .unwrap();
    let created = manager
        .create_session(attempt, &session_request(attempt, &workspace))
        .unwrap();
    let session_id = created.handle.session_id.clone();
    let first = manager.send_prompt(attempt, &prompt(attempt, "m1-1")).unwrap();
    assert!(first.accepted && !first.duplicate);
    assert_eq!(first.session_id.as_deref(), Some(session_id.as_str()));
    let max_seq = first
        .events
        .iter()
        .map(|event| event.sequence)
        .max()
        .expect("the first send yields events");
    let seq_before = manager.registration_seq(attempt).expect("registered");

    let refused = manager.select_runtime(attempt, "scenario", None, "scenario-1", &workspace);
    assert!(
        matches!(refused, Err(AdapterError::RegistrationOccupied(ref id)) if id.contains(attempt)),
        "the occupied key must be refused by the boundary, got {refused:?}"
    );
    assert!(manager.has_attempt(attempt));
    assert_eq!(manager.registration_seq(attempt), Some(seq_before));
    assert_eq!(manager.registration_live(attempt), Some(true));

    // The original object is still the registered one: a replaced ScenarioAdapter would have no
    // session (send_prompt would return Err) and would restart its event sequence at zero.
    let second = manager.send_prompt(attempt, &prompt(attempt, "m1-2")).unwrap();
    assert!(second.accepted && !second.duplicate);
    assert_eq!(second.session_id.as_deref(), Some(session_id.as_str()));
    assert!(!second.events.is_empty(), "the surviving session must still emit events");
    for event in &second.events {
        assert_eq!(event.attempt_id, attempt);
        assert!(
            event.sequence > max_seq,
            "sequence {} did not continue above {max_seq}: the adapter was replaced",
            event.sequence
        );
    }
}

#[test]
fn m2_distinct_keys_register_with_increasing_seqs() {
    assert_env_pinned();
    let directory = tempfile::tempdir().unwrap();
    let workspace = directory.path().join("ws");
    std::fs::create_dir_all(&workspace).unwrap();
    let mut manager = RuntimeManager::new();
    manager
        .select_runtime("attempt-m2-a", "scenario", None, "scenario-1", &workspace)
        .unwrap();
    manager
        .select_runtime("attempt-m2-b", "scenario", None, "scenario-1", &workspace)
        .unwrap();
    assert_eq!(manager.registration_seq("attempt-m2-a"), Some(1));
    assert_eq!(manager.registration_seq("attempt-m2-b"), Some(2));
    assert_eq!(manager.registration_seq("attempt-m2-c"), None);
    assert_eq!(manager.registration_live("attempt-m2-c"), None);
}

/// Codex exec transport never exposes a pid, which is what made `send_message`'s old liveness check
/// false on a healthy runtime. Nothing is spawned: the exec process only runs a command on
/// `send_prompt`, which this case never issues, and the executable path does not exist.
#[test]
fn m3_codex_exec_registration_is_live_without_a_pid() {
    let _guard = ENV_LOCK.lock().unwrap();
    assert_env_pinned();
    let directory = tempfile::tempdir().unwrap();
    let workspace = directory.path().join("ws");
    std::fs::create_dir_all(&workspace).unwrap();
    let attempt = "attempt-m3";
    let dummy = PathBuf::from(r"C:\nonexistent\goalport-increment-2-dummy-codex.exe");
    unsafe { std::env::set_var("GOALPORT_CODEX_TRANSPORT", "exec") };
    let outcome = (|| {
        let mut manager = RuntimeManager::new();
        manager.select_runtime(attempt, "codex", Some(dummy.clone()), "0.152.0", &workspace)?;
        manager.create_session(attempt, &session_request(attempt, &workspace))?;
        Ok::<_, AdapterError>((
            manager.native_pid(attempt),
            manager.registration_live(attempt),
            manager.registration_seq(attempt),
        ))
    })();
    unsafe { std::env::remove_var("GOALPORT_CODEX_TRANSPORT") };
    let (pid, live, seq) = outcome.expect("codex exec registration and session need no process");
    assert_eq!(pid, None, "codex exec never exposes a pid");
    assert_eq!(live, Some(true), "a registered codex exec runtime is live by registration");
    assert_eq!(seq, Some(1));
    assert!(!dummy.exists());
}
