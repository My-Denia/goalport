use goalport_core::{
    AttemptState, Event, Store,
    ipc::{CONNECTED_UI_PROTOCOL_VERSION, CoreServer},
};
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

fn snapshot(server: &CoreServer, id: &str) -> Value {
    let response = call(server, id, "snapshot", json!({}));
    assert_eq!(response["ok"], true, "{response}");
    response["payload"]["snapshot"].clone()
}

fn create_campaign(server: &CoreServer, id: &str, workspace: &Path, goal: &str) -> Value {
    call(
        server,
        id,
        "create_campaign",
        json!({
            "workspaceRoot": workspace,
            "projectId": "stale-project-must-be-ignored",
            "goal": goal,
            "title": format!("Task for {goal}"),
            "acceptance": "bounded Core regression passes"
        }),
    )
}

fn operational_canonical(path: &Path) -> String {
    let canonical = std::fs::canonicalize(path).unwrap();
    let value = canonical.to_string_lossy();
    if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = value.strip_prefix(r"\\?\") {
        rest.to_owned()
    } else {
        value.into_owned()
    }
}

fn active_ids(response: &Value) -> (String, String) {
    let view = &response["payload"]["snapshot"];
    (
        view["activeCampaignId"].as_str().unwrap().to_owned(),
        view["activeTask"]["id"].as_str().unwrap().to_owned(),
    )
}

fn fail_attempt(store: &Store, attempt_id: &str, event_id: &str) {
    let row = store.get_attempt(attempt_id).unwrap();
    store
        .append_event(&Event {
            id: event_id.into(),
            attempt_id: attempt_id.into(),
            seq: row.last_event_seq + 1,
            kind: "attempt.failed".into(),
            payload_ref: None,
        })
        .unwrap();
    assert!(store.get_attempt(attempt_id).unwrap().state.is_terminal());
}

#[test]
fn normal_empty_store_is_connected_and_has_no_synthetic_rows() {
    let store = Store::memory().unwrap();
    let server = CoreServer::new(store.clone());

    let view = snapshot(&server, "empty-snapshot");
    assert_eq!(view["connection"], "connected");
    assert_eq!(view["projects"], json!([]));
    assert_eq!(view["selectedProjectId"], "");
    assert_eq!(view["project"]["id"], "");
    assert_eq!(view["project"]["workspaceRoot"], "");
    assert_eq!(view["activeCampaignId"], "");
    assert_eq!(view["activeTask"]["id"], "");
    assert_eq!(view["activeTask"]["title"], "");
    assert_eq!(view["activeTask"]["state"], "waiting");
    assert_eq!(view["attempt"]["id"], "attempt-unassigned");
    assert_eq!(view["attempt"]["provider"], "unassigned");
    assert_eq!(view["attempt"]["state"], "waiting");
    assert_eq!(view["attempt"]["sessionLabel"], "No Runtime selected");
    assert_eq!(view["preview"], false);
    for provider in ["codex", "claude", "grok"] {
        let runtime = view["runtimes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|runtime| runtime["id"] == provider)
            .unwrap();
        assert_eq!(runtime["version"], "not observed in this Attempt");
    }
    let counts = store.counts().unwrap();
    assert_eq!((counts.projects, counts.campaigns, counts.tasks, counts.attempts), (0, 0, 0, 0));
}

#[test]
fn workspace_campaign_creation_is_canonical_atomic_and_reuses_alias_identity() {
    let workspace = tempfile::tempdir().unwrap();
    let store = Store::memory().unwrap();
    let server = CoreServer::new(store.clone());

    let first = create_campaign(&server, "create/a", workspace.path(), "first goal");
    assert_eq!(first["ok"], true, "{first}");
    let first_view = &first["payload"]["snapshot"];
    assert_eq!(
        first_view["project"]["workspaceRoot"],
        operational_canonical(workspace.path())
    );
    assert_eq!(first_view["attempt"]["id"], "attempt-unassigned");
    assert_eq!(first_view["attempt"]["provider"], "unassigned");
    assert_eq!(first_view["preview"], false);

    let alias = workspace.path().join(".");
    let second = create_campaign(&server, "create_a", &alias, "second goal");
    assert_eq!(second["ok"], true, "{second}");
    assert_ne!(
        first["payload"]["snapshot"]["activeCampaignId"],
        second["payload"]["snapshot"]["activeCampaignId"],
        "request ids that collide under lossy sanitization must remain distinct"
    );
    let counts = store.counts().unwrap();
    assert_eq!((counts.projects, counts.campaigns, counts.tasks, counts.attempts), (1, 2, 2, 0));
    for campaign in store.list_campaigns().unwrap() {
        assert_eq!(
            store.get_campaign_authorization(&campaign.id).unwrap(),
            goalport_core::store::CampaignAuthorization::granted()
        );
        assert_eq!(store.policy_snapshots_for_campaign(&campaign.id).unwrap().len(), 1);
    }
}

#[test]
fn campaign_idempotency_conflict_rolls_back_a_new_workspace_project() {
    let first_workspace = tempfile::tempdir().unwrap();
    let second_workspace = tempfile::tempdir().unwrap();
    let store = Store::memory().unwrap();
    let server = CoreServer::new(store.clone());
    let first = create_campaign(
        &server,
        "same-create-request",
        first_workspace.path(),
        "first content",
    );
    assert_eq!(first["ok"], true, "{first}");
    let replay = create_campaign(
        &server,
        "same-create-request",
        first_workspace.path(),
        "first content",
    );
    assert_eq!(replay["ok"], true, "{replay}");
    assert_eq!(store.counts().unwrap().campaigns, 1);
    let conflict = create_campaign(
        &server,
        "same-create-request",
        second_workspace.path(),
        "different content",
    );
    assert_eq!(conflict["ok"], false, "{conflict}");
    assert!(conflict["error"].as_str().unwrap().contains("different content"));
    let counts = store.counts().unwrap();
    assert_eq!((counts.projects, counts.campaigns, counts.tasks), (1, 1, 1));
}

#[test]
fn missing_workspace_refuses_without_partial_rows() {
    let root = tempfile::tempdir().unwrap();
    let missing = root.path().join("does-not-exist");
    let store = Store::memory().unwrap();
    let server = CoreServer::new(store.clone());
    let response = create_campaign(&server, "missing-workspace", &missing, "must fail");
    assert_eq!(response["ok"], false, "{response}");
    assert!(
        response["error"]
            .as_str()
            .unwrap()
            .contains("existing directory"),
        "{response}"
    );
    let counts = store.counts().unwrap();
    assert_eq!((counts.projects, counts.campaigns, counts.tasks, counts.attempts), (0, 0, 0, 0));
}

#[test]
fn terminal_rollover_is_single_and_provider_independent() {
    let workspace = tempfile::tempdir().unwrap();
    let store = Store::memory().unwrap();
    let server = CoreServer::new_synthetic_only(store.clone());
    let created = create_campaign(&server, "race-create", workspace.path(), "race goal");
    assert_eq!(created["ok"], true, "{created}");
    let (campaign, task) = active_ids(&created);

    let first = call(
        &server,
        "race-first",
        "select_runtime",
        json!({"campaignId": campaign, "taskId": task, "provider": "scenario"}),
    );
    assert_eq!(first["ok"], true, "{first}");
    let first_id = first["payload"]["snapshot"]["attempt"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let row = store.get_attempt(&first_id).unwrap();
    store
        .append_event(&Event {
            id: "race-force-terminal".into(),
            attempt_id: first_id.clone(),
            seq: row.last_event_seq + 1,
            kind: "attempt.failed".into(),
            payload_ref: None,
        })
        .unwrap();
    assert_eq!(store.get_attempt(&first_id).unwrap().state, AttemptState::Failed);

    let scenario = call(
        &server,
        "race-r1-scenario",
        "select_runtime",
        json!({
            "campaignId": campaign,
            "taskId": task,
            "attemptId": first_id,
            "provider": "scenario"
        }),
    );
    assert_eq!(scenario["ok"], true, "{scenario}");
    let successor = scenario["payload"]["snapshot"]["attempt"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_ne!(successor, first_id);

    let codex = call(
        &server,
        "race-r2-codex",
        "select_runtime",
        json!({
            "campaignId": campaign,
            "taskId": task,
            "attemptId": first_id,
            "provider": "codex",
            "executable": "Z:\\goalport-does-not-exist\\codex.exe"
        }),
    );
    assert_eq!(codex["ok"], false, "{codex}");
    assert!(
        codex["error"]
            .as_str()
            .unwrap()
            .contains("already bound to a different Runtime binding"),
        "the race must reach binding conflict before the synthetic-only guard: {codex}"
    );

    let attempts = store.attempts_for_task(&task).unwrap();
    assert_eq!(attempts.len(), 2, "no competing third Attempt may be created");
    assert_eq!(attempts.iter().filter(|row| !row.state.is_terminal()).count(), 1);
    assert_eq!(attempts.iter().find(|row| row.id == successor).unwrap().provider, "scenario");

    let repeat = call(
        &server,
        "race-repeat-old-a",
        "select_runtime",
        json!({
            "campaignId": campaign,
            "taskId": task,
            "attemptId": first_id,
            "provider": "scenario"
        }),
    );
    assert_eq!(repeat["ok"], true, "{repeat}");
    assert_eq!(repeat["payload"]["snapshot"]["attempt"]["id"], successor);
}

#[test]
fn synthetic_firewall_refuses_native_before_write_and_before_handoff_interrupt() {
    let workspace = tempfile::tempdir().unwrap();
    let store = Store::memory().unwrap();
    let server = CoreServer::new_synthetic_only(store.clone());
    let created = create_campaign(&server, "firewall-create", workspace.path(), "firewall goal");
    assert_eq!(created["ok"], true, "{created}");
    let (campaign, task) = active_ids(&created);

    for provider in ["codex", "claude", "grok"] {
        let before = store.counts().unwrap();
        let response = call(
            &server,
            &format!("firewall-{provider}"),
            "select_runtime",
            json!({
                "campaignId": campaign,
                "taskId": task,
                "provider": provider,
                "executable": format!("Z:\\goalport-does-not-exist\\{provider}.exe")
            }),
        );
        assert_eq!(response["ok"], false, "{response}");
        assert!(response["error"].as_str().unwrap().contains("test profile permits only"));
        let after = store.counts().unwrap();
        assert_eq!((after.attempts, after.events), (before.attempts, before.events));
    }

    let scenario = call(
        &server,
        "firewall-scenario",
        "select_runtime",
        json!({"campaignId": campaign, "taskId": task, "provider": "scenario"}),
    );
    assert_eq!(scenario["ok"], true, "{scenario}");
    let attempt = scenario["payload"]["snapshot"]["attempt"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let before = store.get_attempt(&attempt).unwrap();
    let handoff = call(
        &server,
        "firewall-handoff",
        "handoff",
        json!({
            "oldAttemptId": attempt,
            "provider": "codex"
        }),
    );
    assert_eq!(handoff["ok"], false, "{handoff}");
    assert!(handoff["error"].as_str().unwrap().contains("test profile permits only"));
    let after = store.get_attempt(&attempt).unwrap();
    assert_eq!(after.state, before.state, "destination guard must run before source interrupt");
    assert_eq!(store.attempts_for_task(&task).unwrap().len(), 1);
}

#[test]
fn delayed_cross_provider_choice_without_attempt_id_conflicts_with_current_binding() {
    let workspace = tempfile::tempdir().unwrap();
    let store = Store::memory().unwrap();
    let server = CoreServer::new_synthetic_only(store.clone());
    let created = create_campaign(&server, "delayed-create", workspace.path(), "delayed goal");
    let (campaign, task) = active_ids(&created);
    let first = call(
        &server,
        "delayed-scenario",
        "select_runtime",
        json!({"campaignId": campaign, "taskId": task, "provider": "scenario"}),
    );
    assert_eq!(first["ok"], true, "{first}");
    let first_id = first["payload"]["snapshot"]["attempt"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let before = store.attempts_for_task(&task).unwrap().len();
    let delayed = call(
        &server,
        "delayed-codex",
        "select_runtime",
        json!({
            "campaignId": campaign,
            "taskId": task,
            "provider": "codex",
            "executable": "Z:\\goalport-does-not-exist\\codex.exe"
        }),
    );
    assert_eq!(delayed["ok"], false, "{delayed}");
    assert!(delayed["error"].as_str().unwrap().contains("already bound to a different Runtime binding"));
    assert_eq!(store.attempts_for_task(&task).unwrap().len(), before);
    assert_eq!(snapshot(&server, "delayed-after")["attempt"]["id"], first_id);
}

#[test]
fn stale_ancestor_resolves_the_only_live_descendant_across_generations() {
    let workspace = tempfile::tempdir().unwrap();
    let store = Store::memory().unwrap();
    let server = CoreServer::new_synthetic_only(store.clone());
    let created = create_campaign(&server, "ancestry-create", workspace.path(), "ancestry goal");
    let (campaign, task) = active_ids(&created);
    let first = call(&server, "ancestry-a", "select_runtime", json!({
        "campaignId": campaign, "taskId": task, "provider": "scenario"
    }));
    let a = first["payload"]["snapshot"]["attempt"]["id"].as_str().unwrap().to_owned();
    fail_attempt(&store, &a, "ancestry-a-failed");
    let second = call(&server, "ancestry-b", "select_runtime", json!({
        "campaignId": campaign, "taskId": task, "attemptId": a, "provider": "scenario"
    }));
    let b = second["payload"]["snapshot"]["attempt"]["id"].as_str().unwrap().to_owned();
    fail_attempt(&store, &b, "ancestry-b-failed");
    let third = call(&server, "ancestry-c", "select_runtime", json!({
        "campaignId": campaign, "taskId": task, "attemptId": b, "provider": "scenario"
    }));
    let c = third["payload"]["snapshot"]["attempt"]["id"].as_str().unwrap().to_owned();
    assert_ne!(c, a);
    assert_ne!(c, b);

    let stale = call(&server, "ancestry-stale-a", "select_runtime", json!({
        "campaignId": campaign, "taskId": task, "attemptId": a, "provider": "scenario"
    }));
    assert_eq!(stale["ok"], true, "{stale}");
    assert_eq!(stale["payload"]["snapshot"]["attempt"]["id"], c);
    assert_eq!(store.attempts_for_task(&task).unwrap().len(), 3);
}

#[test]
fn unknown_explicit_attempt_cannot_bypass_current_work() {
    let workspace = tempfile::tempdir().unwrap();
    let store = Store::memory().unwrap();
    let server = CoreServer::new_synthetic_only(store.clone());
    let created = create_campaign(&server, "unknown-create", workspace.path(), "unknown goal");
    let (campaign, task) = active_ids(&created);
    assert_eq!(call(&server, "unknown-current", "select_runtime", json!({
        "campaignId": campaign, "taskId": task, "provider": "scenario"
    }))["ok"], true);
    let before = store.attempts_for_task(&task).unwrap().len();
    let refused = call(&server, "unknown-explicit", "select_runtime", json!({
        "campaignId": campaign,
        "taskId": task,
        "attemptId": "attempt-never-observed",
        "provider": "codex",
        "executable": "Z:\\goalport-does-not-exist\\codex.exe"
    }));
    assert_eq!(refused["ok"], false, "{refused}");
    assert!(refused["error"].as_str().unwrap().contains("is unknown while task"));
    assert_eq!(store.attempts_for_task(&task).unwrap().len(), before);
}

#[test]
fn ambiguous_live_rollover_lineage_is_refused_without_a_third_successor() {
    let workspace = tempfile::tempdir().unwrap();
    let store = Store::memory().unwrap();
    let server = CoreServer::new_synthetic_only(store.clone());
    let created = create_campaign(&server, "ambiguous-create", workspace.path(), "ambiguous goal");
    let (campaign, task) = active_ids(&created);
    let first = call(
        &server,
        "ambiguous-first",
        "select_runtime",
        json!({"campaignId": campaign, "taskId": task, "provider": "scenario"}),
    );
    let source = first["payload"]["snapshot"]["attempt"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let row = store.get_attempt(&source).unwrap();
    store
        .append_event(&Event {
            id: "ambiguous-source-failed".into(),
            attempt_id: source.clone(),
            seq: row.last_event_seq + 1,
            kind: "attempt.failed".into(),
            payload_ref: None,
        })
        .unwrap();

    for suffix in ["one", "two"] {
        let id = format!("attempt-ambiguous-{suffix}");
        store
            .insert_attempt(&goalport_core::Attempt::new(
                &id,
                &task,
                "scenario",
                "scenario-cap-v1",
            ))
            .unwrap();
        store
            .append_event_with_state(
                &Event {
                    id: format!("{id}-created"),
                    attempt_id: id,
                    seq: 1,
                    kind: "attempt.created".into(),
                    payload_ref: None,
                },
                None,
                Some(&json!({"rolledFrom": source.clone()})),
            )
            .unwrap();
    }
    let before = store.attempts_for_task(&task).unwrap().len();
    let refused = call(
        &server,
        "ambiguous-third",
        "select_runtime",
        json!({
            "campaignId": campaign,
            "taskId": task,
            "attemptId": source,
            "provider": "scenario"
        }),
    );
    assert_eq!(refused["ok"], false, "{refused}");
    assert!(refused["error"].as_str().unwrap().contains("ambiguous live rollover lineage"));
    assert_eq!(store.attempts_for_task(&task).unwrap().len(), before);
}
