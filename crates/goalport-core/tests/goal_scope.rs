//! Client view is not Core selection. Reading or approving one goal must not
//! retarget the shared snapshot another client is using.

use goalport_core::{
    Attempt, Campaign, Decision, DecisionState, Project, Task, WorkStatus,
    ipc::{CONNECTED_UI_PROTOCOL_VERSION, CoreServer},
    store::{CampaignAuthorization, Store},
};
use serde_json::{Value, json};

fn wire(id: &str, kind: &str, payload: Value) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "protocolVersion": CONNECTED_UI_PROTOCOL_VERSION,
        "requestId": id,
        "entityVersion": 0,
        "messageType": kind,
        "payload": payload
    }))
    .unwrap()
}

fn result(server: &CoreServer, id: &str, kind: &str, payload: Value) -> Value {
    server.handle_json(&wire(id, kind, payload)).unwrap()
}

fn view(response: Value) -> Value {
    assert_eq!(response["ok"], true, "{response}");
    response["payload"]["snapshot"].clone()
}

fn workspace(label: &str) -> String {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.keep().join(label);
    std::fs::create_dir_all(&path).unwrap();
    std::fs::canonicalize(&path).unwrap().to_string_lossy().to_string()
}

fn campaign(store: &Store, label: &str) -> (String, String) {
    let root = workspace(label);
    let project = Project {
        id: format!("project-{label}"),
        workspace_root: root,
    };
    let campaign = Campaign {
        id: format!("campaign-{label}"),
        goal: format!("Goal {label}"),
        root_task_id: format!("task-{label}"),
        state: WorkStatus::InProgress,
    };
    let task = Task {
        id: format!("task-{label}"),
        campaign_id: campaign.id.clone(),
        title: format!("Task {label}"),
        acceptance: "done".into(),
        state: WorkStatus::InProgress,
    };
    store
        .create_workspace_campaign(
            &project,
            &campaign,
            &task,
            &format!("policy-{label}"),
            "{}",
            &CampaignAuthorization::granted(),
        )
        .unwrap();
    let attempt = Attempt::new(
        format!("attempt-{label}"),
        &task.id,
        "scenario",
        "scenario-cap-v1",
    );
    store.insert_attempt(&attempt).unwrap();
    (campaign.id, attempt.id)
}

#[test]
fn detail_and_overview_do_not_retarget_the_shared_selection() {
    let store = Store::memory().unwrap();
    let (campaign_a, _attempt_a) = campaign(&store, "alpha");
    let (campaign_b, attempt_b) = campaign(&store, "beta");
    store
        .insert_decision(&Decision {
            id: "decision-beta".into(),
            attempt_id: attempt_b.clone(),
            kind: "permission".into(),
            state: DecisionState::Pending,
        })
        .unwrap();
    let server = CoreServer::new(store);

    let selected = view(result(
        &server,
        "select-alpha",
        "select_campaign",
        json!({ "campaignId": campaign_a }),
    ));
    assert_eq!(selected["activeCampaignId"], campaign_a);

    let detail = result(
        &server,
        "detail-beta",
        "goal_detail",
        json!({ "campaignId": campaign_b }),
    );
    assert_eq!(detail["ok"], true, "{detail}");
    assert_eq!(detail["payload"]["snapshot"]["activeCampaignId"], campaign_b);
    assert!(
        detail["payload"]["snapshot"]["decisions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|decision| decision["id"] == "decision-beta")
    );
    assert!(
        detail["payload"]["snapshot"]["timeline"].as_array().is_some(),
        "detail still carries that goal's own recent record"
    );

    let still_alpha = view(result(&server, "snap-alpha", "snapshot", json!({})));
    assert_eq!(
        still_alpha["activeCampaignId"], campaign_a,
        "reading beta changed the shared selection"
    );
    assert!(
        still_alpha["decisions"]
            .as_array()
            .unwrap()
            .iter()
            .all(|decision| decision["id"] != "decision-beta")
    );

    let overview = result(&server, "overview", "goal_overview", json!({}));
    assert_eq!(overview["ok"], true, "{overview}");
    let pending = overview["payload"]["overview"]["pending"].as_array().unwrap();
    assert!(
        pending.iter().any(|item| {
            item["decisionId"] == "decision-beta" && item["campaignId"] == campaign_b
        }),
        "beta's approval is hidden while alpha is selected: {overview}"
    );
    let beta = overview["payload"]["overview"]["goals"]
        .as_array()
        .unwrap()
        .iter()
        .find(|goal| goal["campaignId"] == campaign_b)
        .unwrap();
    assert_eq!(beta["attention"], "awaiting_approval");
    assert!(
        overview["payload"]["overview"]["goals"][0]
            .get("items")
            .is_none(),
        "overview must not embed conversation history"
    );

    let scoped = result(
        &server,
        "scope-beta",
        "snapshot_if_changed",
        json!({ "campaignId": campaign_b }),
    );
    let revision = scoped["payload"]["revision"].as_str().unwrap().to_owned();
    assert_eq!(scoped["payload"]["snapshot"]["activeCampaignId"], campaign_b);

    let _ = result(
        &server,
        "select-alpha-again",
        "select_campaign",
        json!({ "campaignId": campaign_a }),
    );
    let unchanged = result(
        &server,
        "scope-beta-again",
        "snapshot_if_changed",
        json!({ "campaignId": campaign_b, "revision": revision }),
    );
    assert_eq!(unchanged["payload"]["unchanged"], true, "{unchanged}");
    assert!(unchanged["payload"].get("snapshot").is_none());

    let send = result(
        &server,
        "send-beta",
        "conversation_send",
        json!({
            "campaignId": campaign_b,
            "attemptId": attempt_b,
            "message": "continue beta"
        }),
    );
    let send_error = send["error"].as_str().unwrap_or("");
    assert!(
        !send_error.contains("not selected by Core"),
        "explicit send still depends on shared selection: {send}"
    );
    let after_send = view(result(&server, "snap-after-send", "snapshot", json!({})));
    assert_eq!(after_send["activeCampaignId"], campaign_a);
}

fn unscoped_revision(server: &CoreServer, id: &str) -> String {
    let response = result(server, id, "snapshot_if_changed", json!({}));
    assert_eq!(response["ok"], true, "{response}");
    response["payload"]["revision"]
        .as_str()
        .unwrap()
        .to_owned()
}

#[test]
fn failed_and_concurrent_reads_restore_selection_without_bumping_it() {
    let store = Store::memory().unwrap();
    let (campaign_a, _) = campaign(&store, "read-a");
    let (campaign_b, _) = campaign(&store, "read-b");
    let server = std::sync::Arc::new(CoreServer::new(store));
    let selected = view(result(
        &server,
        "select-read-a",
        "select_campaign",
        json!({ "campaignId": campaign_a }),
    ));
    assert_eq!(selected["activeCampaignId"], campaign_a);
    let revision = unscoped_revision(&server, "revision-before-reads");

    let missing = result(
        &server,
        "detail-missing",
        "goal_detail",
        json!({ "campaignId": "campaign-does-not-exist" }),
    );
    assert_eq!(missing["ok"], false, "{missing}");
    let still = view(result(&server, "snap-after-missing", "snapshot", json!({})));
    assert_eq!(still["activeCampaignId"], campaign_a);

    let server_threads = server.clone();
    let left = campaign_a.clone();
    let right = campaign_b.clone();
    let mut joins = Vec::new();
    for worker in 0..4 {
        let server = server_threads.clone();
        let left = left.clone();
        let right = right.clone();
        joins.push(std::thread::spawn(move || {
            for step in 0..12 {
                let campaign = if step % 2 == 0 { left.clone() } else { right.clone() };
                let response = result(
                    &server,
                    &format!("read-{worker}-{step}"),
                    "goal_detail",
                    json!({ "campaignId": campaign }),
                );
                assert_eq!(response["ok"], true, "{response}");
                assert_eq!(
                    response["payload"]["snapshot"]["activeCampaignId"],
                    campaign,
                    "a detail response showed a different goal"
                );
            }
        }));
    }
    for join in joins {
        join.join().unwrap();
    }

    let after = view(result(&server, "snap-after-concurrent", "snapshot", json!({})));
    assert_eq!(after["activeCampaignId"], campaign_a);
    let unchanged = result(
        &server,
        "revision-after-reads",
        "snapshot_if_changed",
        json!({ "revision": revision }),
    );
    assert_eq!(
        unchanged["payload"]["unchanged"], true,
        "a read changed the shared selection revision: {unchanged}"
    );
}

#[test]
fn approval_and_send_use_the_named_goal_while_another_stays_selected() {
    let store = Store::memory().unwrap();
    let (campaign_a, _attempt_a) = campaign(&store, "keep-a");
    let (campaign_b, attempt_b) = campaign(&store, "approve-b");
    store
        .insert_decision(&Decision {
            id: "decision-approve-b".into(),
            attempt_id: attempt_b.clone(),
            kind: "permission".into(),
            state: DecisionState::Pending,
        })
        .unwrap();
    let server = CoreServer::new(store.clone());
    let admitted = result(
        &server,
        "admit-b",
        "select_runtime",
        json!({
            "campaignId": campaign_b,
            "attemptId": attempt_b,
            "provider": "scenario"
        }),
    );
    assert_eq!(admitted["ok"], true, "{admitted}");
    let selected = view(result(
        &server,
        "watch-a",
        "select_campaign",
        json!({ "campaignId": campaign_a }),
    ));
    assert_eq!(selected["activeCampaignId"], campaign_a);

    let decision = result(
        &server,
        "allow-b",
        "resolve_decision",
        json!({ "decisionId": "decision-approve-b", "allow": true }),
    );
    assert_eq!(decision["ok"], true, "{decision}");
    assert_eq!(
        decision["payload"]["snapshot"]["activeCampaignId"], campaign_b,
        "the approval answer should describe the goal that owned the decision"
    );
    let still_a = view(result(&server, "snap-after-allow", "snapshot", json!({})));
    assert_eq!(still_a["activeCampaignId"], campaign_a);
    let overview = result(&server, "overview-after-allow", "goal_overview", json!({}));
    let pending = overview["payload"]["overview"]["pending"].as_array().unwrap();
    assert!(
        pending.iter().all(|item| item["decisionId"] != "decision-approve-b"),
        "B's approval is still pending: {overview}"
    );

    let send = result(
        &server,
        "send-only-b",
        "conversation_send",
        json!({
            "campaignId": campaign_b,
            "attemptId": attempt_b,
            "message": "continue only beta"
        }),
    );
    assert_eq!(send["ok"], true, "{send}");
    let beta_messages = store
        .list_event_records(&attempt_b, 0)
        .unwrap()
        .into_iter()
        .filter(|record| record.event.kind == "message.user")
        .filter(|record| {
            record
                .payload
                .as_ref()
                .and_then(|payload| payload.get("text"))
                .and_then(Value::as_str)
                == Some("continue only beta")
        })
        .count();
    assert_eq!(beta_messages, 1, "the send did not land on B");
    let alpha_attempt = "attempt-keep-a";
    let alpha_messages = store
        .list_event_records(alpha_attempt, 0)
        .unwrap()
        .into_iter()
        .filter(|record| record.event.kind == "message.user")
        .count();
    assert_eq!(alpha_messages, 0, "B's send was written onto A");
    let after = view(result(&server, "snap-after-send-b", "snapshot", json!({})));
    assert_eq!(after["activeCampaignId"], campaign_a);
}
