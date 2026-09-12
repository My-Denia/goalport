use goalport_core::{
    Store,
    ipc::{CONNECTED_UI_PROTOCOL_VERSION, CoreServer},
};
use rusqlite::Connection;
use serde_json::{Value, json};
use std::path::Path;

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
        .expect("valid connected UI envelope")
}

fn create_campaign(server: &CoreServer, id: &str, workspace: &Path) -> Value {
    call(
        server,
        id,
        "create_campaign",
        json!({
            "workspaceRoot": workspace,
            "goal": format!("handoff lineage goal for {id}"),
            "title": format!("handoff lineage task for {id}"),
            "acceptance": "stale selection keeps one successor"
        }),
    )
}

fn active_ids(response: &Value) -> (String, String, String) {
    let snapshot = &response["payload"]["snapshot"];
    (
        snapshot["selectedProjectId"].as_str().unwrap().to_owned(),
        snapshot["activeCampaignId"].as_str().unwrap().to_owned(),
        snapshot["activeTask"]["id"].as_str().unwrap().to_owned(),
    )
}

fn select_scenario(
    server: &CoreServer,
    id: &str,
    project: &str,
    campaign: &str,
    task: &str,
    attempt: Option<&str>,
) -> Value {
    let mut payload = json!({
        "projectId": project,
        "campaignId": campaign,
        "taskId": task,
        "provider": "scenario"
    });
    if let Some(attempt) = attempt {
        payload["attemptId"] = json!(attempt);
    }
    call(server, id, "select_runtime", payload)
}

fn selected_attempt(response: &Value) -> String {
    response["payload"]["snapshot"]["attempt"]["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn handoff_payload(old_attempt: &str) -> Value {
    json!({
        "oldAttemptId": old_attempt,
        "provider": "scenario",
        "handoffInstruction": "continue from the persisted handoff packet"
    })
}

fn event_count(store: &Store, attempt: &str, kind: &str) -> usize {
    store
        .list_event_records(attempt, 0)
        .unwrap()
        .into_iter()
        .filter(|record| record.event.kind == kind)
        .count()
}

fn assert_created_lineage(store: &Store, successor: &str, source: &str) {
    let records = store.list_event_records(successor, 0).unwrap();
    let created = records
        .iter()
        .find(|record| record.event.kind == "attempt.created")
        .expect("handoff successor must have an attempt.created event");
    assert_eq!(created.event.seq, 1);
    assert_eq!(
        created.payload,
        Some(json!({"provider": "scenario", "rolledFrom": source}))
    );
}

#[test]
fn stale_handoff_source_reuses_one_successor_and_preserves_independent_campaigns() {
    let workspace_a = tempfile::tempdir().unwrap();
    let workspace_b = tempfile::tempdir().unwrap();
    let store = Store::memory().unwrap();
    let server = CoreServer::new_synthetic_only(store.clone());

    let campaign_a = create_campaign(&server, "lineage-campaign-a", workspace_a.path());
    assert_eq!(campaign_a["ok"], true, "{campaign_a}");
    let (project_a, campaign_a, task_a) = active_ids(&campaign_a);
    let first = select_scenario(
        &server,
        "lineage-select-source",
        &project_a,
        &campaign_a,
        &task_a,
        None,
    );
    assert_eq!(first["ok"], true, "{first}");
    let source = selected_attempt(&first);

    let handoff_payload = handoff_payload(&source);
    let handoff = call(
        &server,
        "lineage-handoff",
        "handoff",
        handoff_payload.clone(),
    );
    assert_eq!(handoff["ok"], true, "{handoff}");
    let successor = selected_attempt(&handoff);
    assert_ne!(successor, source);

    let baseline_counts = store.counts().unwrap();
    let baseline_successor_events = store.list_event_records(&successor, 0).unwrap();
    let baseline_messages = event_count(&store, &successor, "message.user");
    assert_eq!(
        baseline_messages, 1,
        "the handoff instruction is delivered once"
    );

    let conflict = call(
        &server,
        "lineage-conflicting-provider",
        "select_runtime",
        json!({
            "projectId": project_a,
            "campaignId": campaign_a,
            "taskId": task_a,
            "attemptId": source,
            "provider": "codex",
            "executable": "Z:\\goalport-does-not-exist\\codex.exe"
        }),
    );
    assert_eq!(conflict["ok"], false, "{conflict}");
    assert!(
        conflict["error"]
            .as_str()
            .unwrap()
            .contains("already bound to a different Runtime binding"),
        "the persisted successor must be resolved before the synthetic firewall: {conflict}"
    );
    assert_eq!(store.counts().unwrap(), baseline_counts);
    assert_eq!(
        store.list_event_records(&successor, 0).unwrap(),
        baseline_successor_events
    );
    assert_eq!(
        event_count(&store, &successor, "message.user"),
        baseline_messages
    );

    let stale = select_scenario(
        &server,
        "lineage-stale-source",
        &project_a,
        &campaign_a,
        &task_a,
        Some(&source),
    );
    assert_eq!(stale["ok"], true, "{stale}");
    assert_eq!(selected_attempt(&stale), successor);
    assert_eq!(store.counts().unwrap(), baseline_counts);
    assert_eq!(
        event_count(&store, &successor, "message.user"),
        baseline_messages
    );
    assert_created_lineage(&store, &successor, &source);

    let duplicate = call(&server, "lineage-handoff", "handoff", handoff_payload);
    assert_eq!(duplicate["ok"], false, "{duplicate}");
    assert_eq!(store.counts().unwrap(), baseline_counts);
    assert_eq!(
        event_count(&store, &successor, "message.user"),
        baseline_messages
    );

    let campaign_b = create_campaign(&server, "lineage-campaign-b", workspace_b.path());
    assert_eq!(campaign_b["ok"], true, "{campaign_b}");
    let (project_b, campaign_b, task_b) = active_ids(&campaign_b);
    let selected_b = select_scenario(
        &server,
        "lineage-select-independent",
        &project_b,
        &campaign_b,
        &task_b,
        None,
    );
    assert_eq!(selected_b["ok"], true, "{selected_b}");
    let attempt_b = selected_attempt(&selected_b);
    let campaign_b_rows = store.attempts_for_task(&task_b).unwrap();
    let campaign_b_events = store.list_event_records(&attempt_b, 0).unwrap();

    let return_to_a = select_scenario(
        &server,
        "lineage-return-to-a",
        &project_a,
        &campaign_a,
        &task_a,
        Some(&source),
    );
    assert_eq!(return_to_a["ok"], true, "{return_to_a}");
    assert_eq!(selected_attempt(&return_to_a), successor);
    assert_eq!(store.attempts_for_task(&task_b).unwrap(), campaign_b_rows);
    assert_eq!(
        store.list_event_records(&attempt_b, 0).unwrap(),
        campaign_b_events
    );
}

#[test]
fn persisted_handoff_lineage_resolves_after_reopen_without_a_competing_attempt() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let db = root.path().join("goalport.sqlite");
    let store = Store::open(&db).unwrap();
    let server = CoreServer::new_synthetic_only(store.clone());

    let created = create_campaign(&server, "reopen-campaign", &workspace);
    assert_eq!(created["ok"], true, "{created}");
    let (project, campaign, task) = active_ids(&created);
    let first = select_scenario(
        &server,
        "reopen-select-source",
        &project,
        &campaign,
        &task,
        None,
    );
    assert_eq!(first["ok"], true, "{first}");
    let source = selected_attempt(&first);
    let handoff = call(
        &server,
        "reopen-handoff",
        "handoff",
        json!({"oldAttemptId": source, "provider": "scenario"}),
    );
    assert_eq!(handoff["ok"], true, "{handoff}");
    let successor = selected_attempt(&handoff);
    assert_created_lineage(&store, &successor, &source);
    drop(server);
    drop(store);

    let reopened = Store::open(&db).unwrap();
    let reopened_server = CoreServer::new_synthetic_only(reopened.clone());
    let before = reopened.counts().unwrap();
    let stale = select_scenario(
        &reopened_server,
        "reopen-stale-source",
        &project,
        &campaign,
        &task,
        Some(&source),
    );
    assert_eq!(
        stale["ok"], false,
        "a restart requires explicit recovery: {stale}"
    );
    let error = stale["error"].as_str().unwrap();
    assert!(
        error.contains(&successor),
        "the persisted successor must be resolved: {error}"
    );
    assert!(error.contains("explicit recovery is required"), "{error}");
    assert_eq!(reopened.counts().unwrap(), before);
    assert_eq!(reopened.attempts_for_task(&task).unwrap().len(), 2);
    assert_created_lineage(&reopened, &successor, &source);
}

#[test]
fn failed_initial_lineage_insert_leaves_no_partial_handoff_attempt_or_registration() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let db = root.path().join("goalport.sqlite");
    let store = Store::open(&db).unwrap();
    let server = CoreServer::new_synthetic_only(store.clone());

    let created = create_campaign(&server, "abort-campaign", &workspace);
    assert_eq!(created["ok"], true, "{created}");
    let (project, campaign, task) = active_ids(&created);
    let first = select_scenario(
        &server,
        "abort-select-source",
        &project,
        &campaign,
        &task,
        None,
    );
    assert_eq!(first["ok"], true, "{first}");
    let source = selected_attempt(&first);

    let injector = Connection::open(&db).unwrap();
    injector
        .execute_batch(
            "CREATE TRIGGER abort_handoff_created
             BEFORE INSERT ON events
             WHEN NEW.kind = 'attempt.created'
              AND NEW.attempt_id LIKE 'attempt-handoff-%'
             BEGIN
               SELECT RAISE(ABORT, 'injected handoff lineage failure');
             END;",
        )
        .unwrap();
    let before = store.counts().unwrap();
    let payload = json!({"oldAttemptId": source, "provider": "scenario"});
    let failed = call(&server, "abort-handoff", "handoff", payload.clone());
    assert_eq!(failed["ok"], false, "{failed}");
    assert!(
        failed["error"]
            .as_str()
            .unwrap()
            .contains("injected handoff lineage failure"),
        "{failed}"
    );
    let after = store.counts().unwrap();
    assert_eq!(
        after.attempts, before.attempts,
        "the successor row rolls back"
    );
    assert_eq!(
        after.events,
        before.events + 1,
        "only source cancellation persists"
    );
    assert_eq!(store.attempts_for_task(&task).unwrap().len(), 1);

    injector
        .execute_batch("DROP TRIGGER abort_handoff_created;")
        .unwrap();
    let retry = call(&server, "abort-handoff", "handoff", payload);
    assert_eq!(
        retry["ok"], true,
        "the same derived id remains usable: {retry}"
    );
    let successor = selected_attempt(&retry);
    assert_eq!(store.attempts_for_task(&task).unwrap().len(), 2);
    assert_created_lineage(&store, &successor, &source);
}
