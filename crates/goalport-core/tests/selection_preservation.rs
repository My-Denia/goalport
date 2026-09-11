//! Increment 1 of run `goal-runs/runtime-registration-safety`: a refused runtime admission must not
//! move the in-memory selection (`selected_project_id`, `selected_campaign_id`, `selected_task_id`,
//! `selected_attempt_id`), and a successful selection must still commit it.
//!
//! Every case is driven through `CoreServer::handle_json` with the payload shape the renderer sends
//! (`src/ipc.ts:317`: `provider`, `campaignId`, `taskId`), using the connected UI protocol so the
//! read-back `snapshot` carries the selection fields. Provider is always `scenario`, which creates no
//! process. The refused command returns an error with no snapshot, so each refusal case reads the
//! selection back through a separate `snapshot` command afterwards.
//!
//! Store shapes: **T** = the seeded project with a second campaign added through the command surface,
//! live selection on campaign 1 (the seeded one), so that today's post-refusal fallback
//! (`campaigns.last()`) lands visibly on campaign 2. **B** = T plus a second project with its own
//! campaign, task and granted authorization, inserted through the same `Store` the controller shares.

use goalport_core::{
    Event, Project,
    domain::{AttemptState, Campaign, Task, WorkStatus},
    ipc::{CONNECTED_UI_PROTOCOL_VERSION, CoreServer},
    store::{CampaignAuthorization, Store},
};
use serde_json::{Value, json};

const SEED_PROJECT: &str = "project-synthetic";
const SEED_CAMPAIGN: &str = "campaign-synthetic-preview";
const SEED_TASK: &str = "task-synthetic-preview";
const PROJECT_B: &str = "project-b";
const CAMPAIGN_B: &str = "campaign-b";
const TASK_B: &str = "task-b";
const EXPLICIT_ATTEMPT: &str = "attempt-d1-explicit";

fn assert_env_pinned() {
    for (key, _) in std::env::vars() {
        if key.starts_with("GOALPORT_") {
            assert!(
                key == "GOALPORT_SYNTHETIC_ROOT" || key == "GOALPORT_TEST_ARTIFACT_ROOT",
                "stray {key} in the test environment; the runner must scrub GOALPORT_* first"
            );
        }
    }
}

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

struct Selection {
    project: String,
    campaign: String,
    task: String,
    attempt: String,
}

fn selection(view: &Value) -> Selection {
    Selection {
        project: view["selectedProjectId"].as_str().unwrap().to_string(),
        campaign: view["activeCampaignId"].as_str().unwrap().to_string(),
        task: view["activeTask"]["id"].as_str().unwrap().to_string(),
        attempt: view["attempt"]["id"].as_str().unwrap().to_string(),
    }
}

fn assert_selection_eq(actual: &Selection, expected: &Selection, context: &str) {
    assert_eq!(actual.project, expected.project, "{context}: selected project moved");
    assert_eq!(actual.campaign, expected.campaign, "{context}: active campaign moved");
    assert_eq!(actual.task, expected.task, "{context}: active task moved");
    assert_eq!(actual.attempt, expected.attempt, "{context}: attempt moved");
}

/// Store T: adds a second campaign on the seeded project through the command surface and returns
/// its campaign and task ids. `create_campaign_with_task` itself selects the new campaign, which is
/// why every case then makes an explicit successful selection on campaign 1.
fn add_second_campaign(server: &CoreServer) -> (String, String) {
    let created = call(
        server,
        "t-create-second-campaign",
        "create_campaign_with_task",
        json!({
            "projectId": SEED_PROJECT,
            "goal": "second campaign on the seeded project",
            "title": "second task",
            "acceptance": "exists so the post-refusal fallback is visible"
        }),
    );
    assert_eq!(created["ok"], true, "{created}");
    let view = &created["payload"]["snapshot"];
    (
        view["activeCampaignId"].as_str().unwrap().to_string(),
        view["activeTask"]["id"].as_str().unwrap().to_string(),
    )
}

/// Store B: T plus a second project, inserted after `CoreServer::new` through the shared `Store`
/// (the bootstrap only seeds when the project table is empty and attaches the seeded campaign to
/// the first project by rowid, so the extra rows must come afterwards).
fn add_project_b(server: &CoreServer) {
    let store = server.processor().store();
    store
        .insert_project(&Project {
            id: PROJECT_B.into(),
            workspace_root: "synthetic://project-b".into(),
        })
        .unwrap();
    let campaign = Campaign {
        id: CAMPAIGN_B.into(),
        goal: "campaign on the second project".into(),
        root_task_id: TASK_B.into(),
        state: WorkStatus::InProgress,
    };
    let task = Task {
        id: TASK_B.into(),
        campaign_id: CAMPAIGN_B.into(),
        title: "task on the second project".into(),
        acceptance: "selectable".into(),
        state: WorkStatus::InProgress,
    };
    store
        .create_campaign_with_task(PROJECT_B, &campaign, &task)
        .unwrap();
    store
        .set_campaign_authorization(CAMPAIGN_B, &CampaignAuthorization::granted())
        .unwrap();
}

fn select_seed_campaign(server: &CoreServer, id: &str, attempt_id: Option<&str>) -> Value {
    let mut payload = json!({
        "provider": "scenario",
        "campaignId": SEED_CAMPAIGN,
        "taskId": SEED_TASK
    });
    if let Some(attempt_id) = attempt_id {
        payload["attemptId"] = Value::String(attempt_id.into());
    }
    call(server, id, "select_runtime", payload)
}

fn seed_server() -> CoreServer {
    assert_env_pinned();
    CoreServer::new(Store::memory().unwrap())
}

// ---------------------------------------------------------------------------------------------
// Refusals: the selection must not move.
// ---------------------------------------------------------------------------------------------

#[test]
fn r1_repeated_selection_conflict_keeps_selection() {
    let server = seed_server();
    let (campaign_two, _) = add_second_campaign(&server);
    let selected = select_seed_campaign(&server, "r1-select", None);
    assert_eq!(selected["ok"], true, "{selected}");
    let before = selection(&snapshot(&server, "r1-before"));
    assert_eq!(before.campaign, SEED_CAMPAIGN);
    assert_ne!(before.campaign, campaign_two);

    // The same attempt id with a different requested binding (version) is a conflict at the
    // registration boundary; an identical re-select is legitimate reuse and lives in
    // registration_boundary.rs (u1).
    let refused = call(
        &server,
        "r1-repeat",
        "select_runtime",
        json!({
            "provider": "scenario",
            "campaignId": SEED_CAMPAIGN,
            "taskId": SEED_TASK,
            "attemptId": before.attempt,
            "version": "scenario-2"
        }),
    );
    let error = error_of(&refused);
    assert!(
        error.contains("already bound to a different Runtime binding"),
        "expected the binding conflict refusal, got: {error}"
    );

    let after = selection(&snapshot(&server, "r1-after"));
    assert_selection_eq(&after, &before, "after a conflict refusal");
}

#[test]
fn r2_cross_project_refusal_keeps_selection() {
    let server = seed_server();
    let _ = add_second_campaign(&server);
    add_project_b(&server);
    let selected = select_seed_campaign(&server, "r2-select", None);
    assert_eq!(selected["ok"], true, "{selected}");
    let before = selection(&snapshot(&server, "r2-before"));
    assert_eq!(before.project, SEED_PROJECT);

    let refused = call(
        &server,
        "r2-cross",
        "select_runtime",
        json!({
            "projectId": PROJECT_B,
            "provider": "scenario",
            "campaignId": SEED_CAMPAIGN,
            "taskId": SEED_TASK
        }),
    );
    let error = error_of(&refused);
    assert!(
        error.contains("campaign does not belong to selected project"),
        "expected the campaign-ownership refusal, got: {error}"
    );

    let after = selection(&snapshot(&server, "r2-after"));
    assert_selection_eq(&after, &before, "after a cross-project refusal");
}

#[test]
fn r3_unauthorized_provider_refusal_keeps_selection() {
    let server = seed_server();
    let _ = add_second_campaign(&server);
    let selected = select_seed_campaign(&server, "r3-select", None);
    assert_eq!(selected["ok"], true, "{selected}");

    let revoked = call(
        &server,
        "r3-revoke",
        "revoke_authorization",
        json!({ "campaignId": SEED_CAMPAIGN, "scope": "provider" }),
    );
    assert_eq!(revoked["ok"], true, "{revoked}");
    let before = selection(&snapshot(&server, "r3-before"));
    assert_eq!(before.campaign, SEED_CAMPAIGN);

    let refused = select_seed_campaign(&server, "r3-denied", None);
    let error = error_of(&refused);
    assert!(
        error.contains("denies provider attach"),
        "expected the campaign-authorization refusal, got: {error}"
    );

    let after = selection(&snapshot(&server, "r3-after"));
    assert_selection_eq(&after, &before, "after an authorization refusal");
}

/// D1a: the `campaignId` fallback is the empty string, today and after the fix. The setup uses an
/// explicit attempt id so that, if edit 2 were omitted, the derived attempt id would be free and this
/// request would succeed instead of being refused — which makes `ok == false` the behavioural
/// assertion and the message check only a confirmation of the branch reached.
#[test]
fn d1a_omitted_campaign_id_is_refused() {
    let server = seed_server();
    let _ = add_second_campaign(&server);
    let selected = select_seed_campaign(&server, "d1a-select", Some(EXPLICIT_ATTEMPT));
    assert_eq!(selected["ok"], true, "{selected}");

    let refused = call(
        &server,
        "d1a-no-campaign",
        "select_runtime",
        json!({ "provider": "scenario" }),
    );
    let error = error_of(&refused);
    assert!(
        error.contains("entity not found: campaign"),
        "expected the empty campaign lookup to be the refusing branch, got: {error}"
    );
}

#[test]
fn d1b_omitted_campaign_id_refusal_keeps_selection() {
    let server = seed_server();
    let (campaign_two, _) = add_second_campaign(&server);
    let selected = select_seed_campaign(&server, "d1b-select", Some(EXPLICIT_ATTEMPT));
    assert_eq!(selected["ok"], true, "{selected}");
    let before = selection(&snapshot(&server, "d1b-before"));
    assert_eq!(before.campaign, SEED_CAMPAIGN);
    assert_eq!(before.attempt, EXPLICIT_ATTEMPT);
    assert_ne!(before.campaign, campaign_two);

    let refused = call(
        &server,
        "d1b-no-campaign",
        "select_runtime",
        json!({ "provider": "scenario" }),
    );
    let _ = error_of(&refused);

    let after = selection(&snapshot(&server, "d1b-after"));
    assert_selection_eq(&after, &before, "after the omitted-campaign refusal");
}

// ---------------------------------------------------------------------------------------------
// Successes: the selection must commit.
// ---------------------------------------------------------------------------------------------

fn assert_placeholder_not_persisted(server: &CoreServer, context: &str) {
    assert!(
        !server
            .processor()
            .store()
            .list_attempts()
            .unwrap()
            .iter()
            .any(|attempt| attempt.id == "attempt-unassigned"),
        "{context}: the display placeholder must not enter the Attempt table"
    );
}

fn add_campaign_without_attempt(server: &CoreServer, campaign_id: &str, task_id: &str) {
    let store = server.processor().store();
    let campaign = Campaign {
        id: campaign_id.into(),
        goal: format!("campaign {campaign_id}"),
        root_task_id: task_id.into(),
        state: WorkStatus::InProgress,
    };
    let task = Task {
        id: task_id.into(),
        campaign_id: campaign_id.into(),
        title: format!("task {task_id}"),
        acceptance: "selectable without a persisted Attempt".into(),
        state: WorkStatus::InProgress,
    };
    store
        .create_campaign_with_task(SEED_PROJECT, &campaign, &task)
        .unwrap();
    store
        .set_campaign_authorization(campaign_id, &CampaignAuthorization::granted())
        .unwrap();
}

fn select_campaign(server: &CoreServer, id: &str, campaign_id: &str) -> Value {
    let response = call(server, id, "select_campaign", json!({ "campaignId": campaign_id }));
    assert_eq!(response["ok"], true, "{response}");
    response["payload"]["snapshot"].clone()
}

/// The renderer snapshot uses `attempt-unassigned` as a display placeholder before any
/// Attempt exists. If that string is treated as a real identity, the second Campaign's
/// first select collides with the first Campaign's registration and is refused.
#[test]
fn display_placeholder_is_not_persisted_across_two_campaign_first_selects() {
    let server = seed_server();
    add_campaign_without_attempt(&server, "campaign-ph-a", "task-ph-a");
    add_campaign_without_attempt(&server, "campaign-ph-b", "task-ph-b");

    let before_a = select_campaign(&server, "ph-a-select", "campaign-ph-a");
    assert_eq!(before_a["activeCampaignId"], "campaign-ph-a");
    assert_eq!(before_a["attempt"]["id"], "attempt-unassigned");

    let first = call(
        &server,
        "ph-first",
        "select_runtime",
        json!({
            "provider": "scenario",
            "campaignId": "campaign-ph-a",
            "taskId": "task-ph-a",
            "attemptId": "attempt-unassigned"
        }),
    );
    assert_eq!(first["ok"], true, "{first}");
    let first_id = first["payload"]["snapshot"]["attempt"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    assert_ne!(first_id, "attempt-unassigned");
    assert_placeholder_not_persisted(&server, "after the first Campaign select");

    let before_b = select_campaign(&server, "ph-b-select", "campaign-ph-b");
    assert_eq!(before_b["activeCampaignId"], "campaign-ph-b");
    assert_eq!(before_b["attempt"]["id"], "attempt-unassigned");

    let second = call(
        &server,
        "ph-second",
        "select_runtime",
        json!({
            "provider": "scenario",
            "campaignId": "campaign-ph-b",
            "taskId": "task-ph-b",
            "attemptId": "attempt-unassigned"
        }),
    );
    assert_eq!(second["ok"], true, "{second}");
    let second_id = second["payload"]["snapshot"]["attempt"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    assert_ne!(second_id, "attempt-unassigned");
    assert_ne!(second_id, first_id);

    let reuse = call(
        &server,
        "ph-reuse",
        "select_runtime",
        json!({
            "provider": "scenario",
            "campaignId": "campaign-ph-a",
            "taskId": "task-ph-a",
            "attemptId": first_id
        }),
    );
    assert_eq!(reuse["ok"], true, "{reuse}");
    assert_eq!(
        reuse["payload"]["snapshot"]["attempt"]["id"].as_str().unwrap(),
        first_id
    );
    assert_placeholder_not_persisted(&server, "after the second Campaign select");

    let created = call(
        &server,
        "ph-create",
        "create_campaign",
        json!({
            "projectId": SEED_PROJECT,
            "goal": "command-surface campaign with no Attempt",
            "title": "created task",
            "acceptance": "first Runtime select must not persist the display placeholder"
        }),
    );
    assert_eq!(created["ok"], true, "{created}");
    let created_view = &created["payload"]["snapshot"];
    let created_campaign = created_view["activeCampaignId"].as_str().unwrap().to_string();
    let created_task = created_view["activeTask"]["id"].as_str().unwrap().to_string();
    let created_attempt = created_view["attempt"]["id"].as_str().unwrap().to_string();
    let third = call(
        &server,
        "ph-third",
        "select_runtime",
        json!({
            "provider": "scenario",
            "campaignId": created_campaign,
            "taskId": created_task,
            "attemptId": created_attempt
        }),
    );
    assert_eq!(third["ok"], true, "{third}");
    let third_id = third["payload"]["snapshot"]["attempt"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    assert_ne!(third_id, "attempt-unassigned");
    assert_ne!(third_id, first_id);
    assert_ne!(third_id, second_id);
    assert_placeholder_not_persisted(&server, "after create_campaign first select");
}

fn fail_attempt(server: &CoreServer, attempt_id: &str) {
    let store = server.processor().store();
    if store.get_attempt(attempt_id).unwrap().state == AttemptState::Queued {
        let seq = store.get_attempt(attempt_id).unwrap().last_event_seq + 1;
        store
            .append_event(&Event {
                id: format!("event-active-{seq}"),
                attempt_id: attempt_id.into(),
                seq,
                kind: "attempt.active".into(),
                payload_ref: None,
            })
            .unwrap();
    }
    let seq = store.get_attempt(attempt_id).unwrap().last_event_seq + 1;
    store
        .append_event(&Event {
            id: format!("event-fail-{seq}"),
            attempt_id: attempt_id.into(),
            seq,
            kind: "attempt.failed".into(),
            payload_ref: None,
        })
        .unwrap();
    assert!(
        store.get_attempt(attempt_id).unwrap().state.is_terminal(),
        "fixture must leave a terminal Attempt"
    );
}

/// After a selected Attempt finishes, select_runtime must mint a new identity instead of
/// reusing the terminal row. That is what the renderer instruction "select a Runtime to
/// start a new Attempt" requires.
#[test]
fn terminal_attempt_id_does_not_block_a_new_runtime_select() {
    let server = seed_server();
    add_campaign_without_attempt(&server, "campaign-term", "task-term");
    let first = call(
        &server,
        "term-first",
        "select_runtime",
        json!({
            "provider": "scenario",
            "campaignId": "campaign-term",
            "taskId": "task-term"
        }),
    );
    assert_eq!(first["ok"], true, "{first}");
    let first_id = first["payload"]["snapshot"]["attempt"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    fail_attempt(&server, &first_id);

    let again = call(
        &server,
        "term-again",
        "select_runtime",
        json!({
            "provider": "scenario",
            "campaignId": "campaign-term",
            "taskId": "task-term",
            "attemptId": first_id
        }),
    );
    assert_eq!(again["ok"], true, "{again}");
    let second_id = again["payload"]["snapshot"]["attempt"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    assert_ne!(second_id, first_id);
    let store = server.processor().store();
    assert!(store.get_attempt(&first_id).unwrap().state.is_terminal());
    assert!(!store.get_attempt(&second_id).unwrap().state.is_terminal());
}

#[test]
fn s1_first_selection_commits() {
    let server = seed_server();
    let selected = select_seed_campaign(&server, "s1-select", None);
    assert_eq!(selected["ok"], true, "{selected}");
    let admitted = selected["payload"]["snapshot"]["attempt"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    let view = selection(&snapshot(&server, "s1-after"));
    assert_eq!(view.project, SEED_PROJECT);
    assert_eq!(view.campaign, SEED_CAMPAIGN);
    assert_eq!(view.task, SEED_TASK);
    assert_eq!(view.attempt, admitted);
}

#[test]
fn s2_legitimate_second_selection_moves() {
    let server = seed_server();
    let (campaign_two, task_two) = add_second_campaign(&server);
    let first = select_seed_campaign(&server, "s2-first", None);
    assert_eq!(first["ok"], true, "{first}");

    let second = call(
        &server,
        "s2-second",
        "select_runtime",
        json!({ "provider": "scenario", "campaignId": campaign_two, "taskId": task_two }),
    );
    assert_eq!(second["ok"], true, "{second}");
    let admitted = second["payload"]["snapshot"]["attempt"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    let view = selection(&snapshot(&server, "s2-after"));
    assert_eq!(view.project, SEED_PROJECT);
    assert_eq!(view.campaign, campaign_two);
    assert_eq!(view.task, task_two);
    assert_eq!(view.attempt, admitted);
}

/// S3 is the mutation control for edit 3: the bootstrap already sets `selected_project_id` to the
/// seeded project, so only a successful cross-project admission can show that the project commit
/// still happens after the early `select_project` call is removed.
#[test]
fn s3_cross_project_selection_commits_project() {
    let server = seed_server();
    let _ = add_second_campaign(&server);
    add_project_b(&server);

    let selected = call(
        &server,
        "s3-select-b",
        "select_runtime",
        json!({
            "projectId": PROJECT_B,
            "provider": "scenario",
            "campaignId": CAMPAIGN_B,
            "taskId": TASK_B
        }),
    );
    assert_eq!(selected["ok"], true, "{selected}");

    let view = selection(&snapshot(&server, "s3-after"));
    assert_eq!(view.project, PROJECT_B);
    assert_eq!(view.campaign, CAMPAIGN_B);
    assert_eq!(view.task, TASK_B);
}
