//! Focused Core tests for the product-interaction reset (plan R2/R3):
//! first-send orchestration claim machine and crash cuts, duplicate/collision
//! handling, durable cross-attempt event ordering (migration, reopen, VACUUM),
//! selected-idle runtime states, confirmed-stop successor lineage, held/unknown
//! refusals, and the no-retry send rule with call-count evidence.
//!
//! Everything here is local and synthetic (the in-process Scenario Runtime or
//! direct store calls). No Windows behavior is claimed from these unit tests.

use goalport_core::{
    Attempt, AttemptState, Campaign, Project, Task,
    commands::sha256_hex,
    ipc::{CONNECTED_UI_PROTOCOL_VERSION, CoreServer},
    store::{
        CampaignAuthorization, ConversationStart, Store,
    },
};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{Mutex, OnceLock},
};

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

fn error_of(response: Value) -> String {
    assert_eq!(response["ok"], false, "expected a refusal: {response}");
    response["error"].as_str().unwrap_or_default().to_owned()
}

fn temp_workspace(label: &str) -> PathBuf {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.keep().join(label);
    std::fs::create_dir_all(&path).unwrap();
    path
}

fn canonical(path: &PathBuf) -> String {
    let canonical = std::fs::canonicalize(path).unwrap();
    let text = canonical.to_string_lossy().to_string();
    text.strip_prefix(r"\\?\")
        .map(str::to_owned)
        .unwrap_or(text)
}

fn start_payload(workspace: &str, provider: &str, message: &str) -> Value {
    json!({
        "workspaceRoot": workspace,
        "provider": provider,
        "message": message
    })
}

fn event_kinds(store: &Store, attempt: &str) -> Vec<String> {
    store
        .list_event_records(attempt, 0)
        .unwrap()
        .into_iter()
        .map(|record| record.event.kind)
        .collect()
}

fn user_message_texts(store: &Store, campaign: &str) -> Vec<String> {
    store
        .campaign_event_records(campaign)
        .unwrap()
        .into_iter()
        .filter(|record| record.event.kind == "message.user")
        .filter_map(|record| {
            record
                .payload
                .as_ref()
                .and_then(|payload| payload.get("text"))
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .collect()
}

// ---------------------------------------------------------------------------
// First-send: atomic reservation, replay, collision
// ---------------------------------------------------------------------------

#[test]
fn first_send_reserves_conversation_and_repeats_answer_recorded_outcome() {
    let workspace = temp_workspace("first-send");
    let root = canonical(&workspace);
    let server = CoreServer::new(Store::memory().unwrap());
    let response = result(
        &server,
        "start-1",
        "start_conversation",
        start_payload(&root, "scenario", "  please   summarize   the workspace  "),
    );
    let snapshot = view(response);
    let product = &snapshot["productConversation"];
    let store = server.processor().store();

    // The conversation, the reserved first user message (once), the selected
    // runtime and a completed synthetic turn.
    let items = product["items"].as_array().unwrap();
    assert!(
        items
            .iter()
            .any(|item| item["kind"] == "user-message"
                && item["body"] == "please   summarize   the workspace"),
        "history keeps the raw prompt verbatim: {items:?}"
    );
    assert!(
        items
            .iter()
            .any(|item| item["kind"] == "assistant-message"
                && item["body"].as_str().unwrap().contains("summarize")),
        "{items:?}"
    );
    assert_eq!(product["runtime"]["state"], "selected");
    assert_eq!(product["runtime"]["provider"], "scenario");
    assert_eq!(product["turn"]["state"], "completed");
    assert_eq!(product["turn"]["canSend"], true);
    assert_eq!(product["turn"]["canStop"], false);
    // Deterministic title: whitespace-normalized first prompt.
    assert_eq!(product["title"], "please summarize the workspace");

    let counts = store.counts().unwrap();
    assert_eq!(counts.campaigns, 1);
    assert_eq!(counts.attempts, 1);
    assert_eq!(user_message_texts(store, "campaign-start-1-placeholder").len(), 0);

    // The repeat answers the recorded outcome and never sends again.
    let again = result(
        &server,
        "start-1",
        "start_conversation",
        start_payload(&root, "scenario", "  please   summarize   the workspace  "),
    );
    assert_eq!(again["ok"], true, "{again}");
    assert_eq!(again["payload"]["duplicate"], true, "{again}");
    let after = store.counts().unwrap();
    assert_eq!(after.events, counts.events, "a repeat persists nothing");
    let campaign_id = snapshot["activeCampaignId"].as_str().unwrap();
    assert_eq!(
        user_message_texts(store, campaign_id).len(),
        1,
        "the initial user event appears exactly once"
    );
}

#[test]
fn first_send_same_request_id_with_different_payload_is_refused() {
    let workspace = temp_workspace("collision");
    let root = canonical(&workspace);
    let server = CoreServer::new(Store::memory().unwrap());
    let first = result(
        &server,
        "collide-1",
        "start_conversation",
        start_payload(&root, "scenario", "original prompt"),
    );
    assert_eq!(first["ok"], true, "{first}");
    let store = server.processor().store();
    let counts = store.counts().unwrap();

    let error = error_of(result(
        &server,
        "collide-1",
        "start_conversation",
        start_payload(&root, "scenario", "different prompt"),
    ));
    assert!(
        error.contains("already recorded with a different payload"),
        "{error}"
    );
    let after = store.counts().unwrap();
    assert_eq!(after.events, counts.events, "the refused repeat wrote nothing");
}

#[test]
fn unknown_provider_or_missing_workspace_leaves_no_rows() {
    let workspace = temp_workspace("refused-start");
    let root = canonical(&workspace);
    let server = CoreServer::new(Store::memory().unwrap());
    let error = error_of(result(
        &server,
        "start-bogus",
        "start_conversation",
        start_payload(&root, "bogus-provider", "hello"),
    ));
    assert!(error.contains("unknown Runtime provider"), "{error}");
    let missing = error_of(result(
        &server,
        "start-missing",
        "start_conversation",
        start_payload(
            &workspace.join("does-not-exist").to_string_lossy(),
            "scenario",
            "hello"
        ),
    ));
    assert!(
        missing.contains("must name an existing directory"),
        "{missing}"
    );
    assert_eq!(server.processor().store().counts().unwrap().campaigns, 0);
}

// ---------------------------------------------------------------------------
// Crash cuts of the first-send claim machine (R3): simulate each durable cut
// directly through the store, then hand the same store to a fresh Core.
// ---------------------------------------------------------------------------

/// Build the exact ConversationStart the controller would build, minus running
/// it: this is the state a crash between prepare and claim leaves behind.
fn prepared_start_cut(
    store: &Store,
    request_id: &str,
    workspace_root: &str,
    provider: &str,
    message: &str,
) -> String {
    let request_hash = sha256_hex(request_id.as_bytes());
    let campaign_id = format!("campaign-{request_hash}");
    let task_id = format!("task-{request_hash}");
    let attempt_id = format!("attempt-{request_hash}");
    let start = ConversationStart {
        request_id: request_id.to_owned(),
        payload_hash: conversation_payload_hash_for_test(workspace_root, provider, message),
        claim_token: "sim-claim-token".to_owned(),
        native_command_id: format!("ui-send-sim-{request_hash}"),
        project: Project {
            id: format!("project-{}", sha256_hex(workspace_root.as_bytes())),
            workspace_root: workspace_root.to_owned(),
        },
        campaign: Campaign {
            id: campaign_id.clone(),
            goal: message.to_owned(),
            root_task_id: task_id.clone(),
            state: goalport_core::WorkStatus::InProgress,
        },
        task: Task {
            id: task_id.clone(),
            campaign_id: campaign_id.clone(),
            title: message.chars().take(44).collect(),
            acceptance: "Persist ordered Runtime events and recover without replay.".into(),
            state: goalport_core::WorkStatus::InProgress,
        },
        policy_id: format!("policy-{request_hash}"),
        policy_payload_json: json!({
            "campaignId": campaign_id,
            "goal": message,
            "providerAuthorized": true,
            "transferAuthorized": true,
            "actionAuthorized": true
        })
        .to_string(),
        authorization: CampaignAuthorization::granted(),
        attempt: Attempt::new(&attempt_id, &task_id, provider, format!("{provider}-cap-v1")),
        selected_provider: provider.to_owned(),
        first_user_message: message.to_owned(),
    };
    let attempt_id = start.attempt.id.clone();
    match store.prepare_conversation_start(&start).unwrap() {
        goalport_core::ConversationPrepareOutcome::Prepared { .. } => attempt_id,
        goalport_core::ConversationPrepareOutcome::Existing(_) => {
            panic!("cut setup must prepare, not collide")
        }
    }
}

fn conversation_payload_hash_for_test(identity: &str, provider: &str, message: &str) -> String {
    sha256_hex(json!({ "identity": identity, "provider": provider, "message": message }).to_string().as_bytes())
}

#[test]
fn crash_after_prepare_is_uncertain_after_restart_and_never_dispatched() {
    let workspace = temp_workspace("cut-prepare");
    let root = canonical(&workspace);
    let store = Store::memory().unwrap();
    let attempt = prepared_start_cut(&store, "cut-prepare-1", &root, "scenario", "first words");

    // A fresh Core over the same durable state is the restart.
    let server = CoreServer::new(store.clone());
    let error = error_of(result(
        &server,
        "cut-prepare-1",
        "start_conversation",
        start_payload(&root, "scenario", "first words"),
    ));
    assert!(
        error.contains("never dispatched automatically"),
        "{error}"
    );
    // The created conversation survives with its first user message exactly
    // once, but nothing was admitted or sent after the restart.
    assert_eq!(
        user_message_texts(&store, "campaign-cut-prepare-1-x").len(),
        0,
        "placeholder id must not exist"
    );
    let campaign_id = format!("campaign-{}", sha256_hex("cut-prepare-1".as_bytes()));
    assert_eq!(user_message_texts(&store, &campaign_id).len(), 1);
    assert!(!event_kinds(&store, &attempt).contains(&"attempt.active".to_owned()));
    assert!(!event_kinds(&store, &attempt).contains(&"runtime.session.created".to_owned()));
    let row = store.conversation_request("cut-prepare-1").unwrap().unwrap();
    assert_eq!(row.phase, "unknown", "recovery marked the unsettled request");
}

#[test]
fn crash_after_claim_or_dispatch_cas_never_dispatches() {
    for (label, advance) in [("claim", 1), ("dispatch", 2)] {
        let workspace = temp_workspace(label);
        let root = canonical(&workspace);
        let store = Store::memory().unwrap();
        let request_id = format!("cut-{label}-1");
        let attempt = prepared_start_cut(&store, &request_id, &root, "scenario", "first words");
        assert!(store
            .claim_conversation_request(&request_id, "sim-claim-token")
            .is_ok());
        if advance > 1 {
            assert!(store
                .begin_dispatch_conversation_request(&request_id, "sim-claim-token")
                .is_ok());
        }

        let server = CoreServer::new(store.clone());
        let error = error_of(result(
            &server,
            &request_id,
            "start_conversation",
            start_payload(&root, "scenario", "first words"),
        ));
        assert!(
            error.contains("never dispatched automatically"),
            "{label}: {error}"
        );
        assert!(!event_kinds(&store, &attempt).contains(&"runtime.session.created".to_owned()));
        let row = store.conversation_request(&request_id).unwrap().unwrap();
        assert_eq!(row.phase, "unknown", "{label}: recovered as unknown");
    }
}

#[test]
fn claim_cas_rejects_a_foreign_or_stale_token() {
    let workspace = temp_workspace("claim-cas");
    let root = canonical(&workspace);
    let store = Store::memory().unwrap();
    prepared_start_cut(&store, "claim-cas-1", &root, "scenario", "first words");
    // A caller without the inserted claim token cannot move the row.
    assert!(store
        .claim_conversation_request("claim-cas-1", "forged-token")
        .is_err());
    assert_eq!(
        store.conversation_request("claim-cas-1").unwrap().unwrap().phase,
        "prepared"
    );
    // The winning token moves it exactly once.
    assert!(store
        .claim_conversation_request("claim-cas-1", "sim-claim-token")
        .is_ok());
    // A second CAS by the same token fails: the row is no longer prepared.
    assert!(store
        .claim_conversation_request("claim-cas-1", "sim-claim-token")
        .is_err());
    // Dispatch CAS requires the claimed phase and the same token.
    assert!(store
        .begin_dispatch_conversation_request("claim-cas-1", "forged-token")
        .is_err());
    assert!(store
        .begin_dispatch_conversation_request("claim-cas-1", "sim-claim-token")
        .is_ok());
    // Terminal outcomes are written once.
    assert!(store
        .finish_conversation_request(
            "claim-cas-1",
            goalport_core::ConversationRequestPhase::Failed,
            &json!({"error": "settled"})
        )
        .is_ok());
    assert!(store
        .finish_conversation_request(
            "claim-cas-1",
            goalport_core::ConversationRequestPhase::Succeeded,
            &json!({"error": "rewrite"})
        )
        .is_err());
}

#[test]
fn native_command_identity_is_unique_across_prepared_requests() {
    let workspace = temp_workspace("command-binding");
    let root = canonical(&workspace);
    let store = Store::memory().unwrap();
    prepared_start_cut(&store, "binding-1", &root, "scenario", "first");
    // A second request may not bind to the first request's native command id:
    // the forged/mismatched command binding is refused at the database layer.
    let request_hash = sha256_hex("binding-2".as_bytes());
    let start = ConversationStart {
        request_id: "binding-2".to_owned(),
        payload_hash: conversation_payload_hash_for_test(&root, "scenario", "second"),
        claim_token: "sim-claim-token-2".to_owned(),
        // Same native_command_id as binding-1's row.
        native_command_id: format!("ui-send-sim-{}", sha256_hex("binding-1".as_bytes())),
        project: Project {
            id: format!("project-{}", sha256_hex(root.as_bytes())),
            workspace_root: root.clone(),
        },
        campaign: Campaign {
            id: format!("campaign-{request_hash}"),
            goal: "second".to_owned(),
            root_task_id: format!("task-{request_hash}"),
            state: goalport_core::WorkStatus::InProgress,
        },
        task: Task {
            id: format!("task-{request_hash}"),
            campaign_id: format!("campaign-{request_hash}"),
            title: "second".to_owned(),
            acceptance: "a".to_owned(),
            state: goalport_core::WorkStatus::InProgress,
        },
        policy_id: format!("policy-{request_hash}"),
        policy_payload_json: "{}".to_owned(),
        authorization: CampaignAuthorization::granted(),
        attempt: Attempt::new(
            format!("attempt-{request_hash}"),
            format!("task-{request_hash}"),
            "scenario",
            "scenario-cap-v1",
        ),
        selected_provider: "scenario".to_owned(),
        first_user_message: "second".to_owned(),
    };
    assert!(store.prepare_conversation_start(&start).is_err());
}

// ---------------------------------------------------------------------------
// Durable cross-attempt event ordering (R3): trigger coverage, migration
// backfill determinism, reopen and VACUUM stability.
// ---------------------------------------------------------------------------

#[test]
fn campaign_event_order_covers_all_insert_paths_and_survives_reopen_and_vacuum() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("order.sqlite");
    let store = Store::open(&path).unwrap();
    assert_eq!(store.schema_version().unwrap(), 9);

    let workspace = directory.path().join("ws");
    std::fs::create_dir_all(&workspace).unwrap();
    let project = Project {
        id: "project-order".to_owned(),
        workspace_root: workspace.to_string_lossy().to_string(),
    };
    let campaign = Campaign {
        id: "campaign-order".to_owned(),
        goal: "ordering".to_owned(),
        root_task_id: "task-order".to_owned(),
        state: goalport_core::WorkStatus::InProgress,
    };
    let task = Task {
        id: "task-order".to_owned(),
        campaign_id: "campaign-order".to_owned(),
        title: "ordering".to_owned(),
        acceptance: "a".to_owned(),
        state: goalport_core::WorkStatus::InProgress,
    };
    store
        .create_workspace_campaign(
            &project,
            &campaign,
            &task,
            "policy-order",
            "{}",
            &CampaignAuthorization::granted(),
        )
        .unwrap();

    // Insert path 1: append_event_json.
    let first = Attempt::new("attempt-order-1", "task-order", "scenario", "scenario-cap-v1");
    store.insert_attempt(&first).unwrap();
    store
        .append_event_json(
            &goalport_core::Event {
                id: "e1".to_owned(),
                attempt_id: "attempt-order-1".to_owned(),
                seq: 1,
                kind: "message.user".to_owned(),
                payload_ref: None,
            },
            &json!({ "text": "first user message" }),
        )
        .unwrap();
    // Insert path 2: append_event_with_state (the state-machine path).
    store
        .append_event_with_state(
            &goalport_core::Event {
                id: "e2".to_owned(),
                attempt_id: "attempt-order-1".to_owned(),
                seq: 2,
                kind: "attempt.active".to_owned(),
                payload_ref: None,
            },
            Some(AttemptState::Active),
            Some(&json!({ "provider": "scenario" })),
        )
        .unwrap();
    // Insert path 3: insert_rollover_attempt (the atomic lineage path).
    let second = Attempt::new("attempt-order-2", "task-order", "scenario", "scenario-cap-v1");
    store
        .insert_rollover_attempt(&second, "attempt-order-1")
        .unwrap();
    store
        .append_event_json(
            &goalport_core::Event {
                id: "e3".to_owned(),
                attempt_id: "attempt-order-2".to_owned(),
                seq: 2,
                kind: "message.user".to_owned(),
                payload_ref: None,
            },
            &json!({ "text": "second user message" }),
        )
        .unwrap();

    let ids = |store: &Store| {
        store
            .campaign_event_records("campaign-order")
            .unwrap()
            .into_iter()
            .map(|record| record.event.id)
            .collect::<Vec<_>>()
    };
    let baseline = ids(&store);
    assert_eq!(
        baseline,
        vec![
            "e1".to_owned(),
            "e2".to_owned(),
            "core-event-attempt-order-2-1".to_owned(),
            "e3".to_owned(),
        ],
        "campaign order follows durable insertion order across attempts"
    );
    // Every event row has exactly one order row (trigger coverage).
    let counts = store.counts().unwrap();
    let connection = rusqlite::Connection::open(&path).unwrap();
    let ordered: i64 = connection
        .query_row("SELECT COUNT(*) FROM product_event_order", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(ordered, counts.events, "every events insert is ordered");
    drop(connection);

    // Reopen: same order.
    drop(store);
    let store = Store::open(&path).unwrap();
    assert_eq!(ids(&store), baseline);

    // VACUUM: the explicit INTEGER primary key order survives.
    store.vacuum().unwrap();
    assert_eq!(ids(&store), baseline, "order_seq survives VACUUM");

    // Migration backfill determinism: wipe the order table and the sequence,
    // then re-run migrate() as a v8->v9 upgrade would: the backfill re-orders
    // by the current rowid, which preserves the insertion order.
    drop(store);
    {
        let connection = rusqlite::Connection::open(&path).unwrap();
        connection.execute("DELETE FROM product_event_order", []).unwrap();
        connection
            .execute(
                "DELETE FROM sqlite_sequence WHERE name = 'product_event_order'",
                [],
            )
            .unwrap();
        // Drop the trigger too: a fresh v8 database would not have it.
        connection
            .execute("DROP TRIGGER trg_events_product_order_after_insert", [])
            .unwrap();
    }
    let store = Store::open(&path).unwrap();
    assert_eq!(ids(&store), baseline, "backfill re-derives the same order");
    // And new inserts after the backfill still allocate order rows.
    store
        .append_event_json(
            &goalport_core::Event {
                id: "e4".to_owned(),
                attempt_id: "attempt-order-2".to_owned(),
                seq: 3,
                kind: "message.user".to_owned(),
                payload_ref: None,
            },
            &json!({ "text": "third" }),
        )
        .unwrap();
    let mut extended = baseline.clone();
    extended.push("e4".to_owned());
    assert_eq!(ids(&store), extended);
}

// ---------------------------------------------------------------------------
// Selected runtime preference, idle/uncertain turn states
// ---------------------------------------------------------------------------

#[test]
fn selected_runtime_preference_without_live_registration_is_unavailable_and_uncertain() {
    let workspace = temp_workspace("idle-preference");
    let store = Store::memory().unwrap();
    let project = Project {
        id: "project-idle".to_owned(),
        workspace_root: workspace.to_string_lossy().to_string(),
    };
    let campaign = Campaign {
        id: "campaign-idle".to_owned(),
        goal: "idle".to_owned(),
        root_task_id: "task-idle".to_owned(),
        state: goalport_core::WorkStatus::InProgress,
    };
    let task = Task {
        id: "task-idle".to_owned(),
        campaign_id: "campaign-idle".to_owned(),
        title: "idle task".to_owned(),
        acceptance: "a".to_owned(),
        state: goalport_core::WorkStatus::InProgress,
    };
    store
        .create_workspace_campaign(
            &project,
            &campaign,
            &task,
            "policy-idle",
            "{}",
            &CampaignAuthorization::granted(),
        )
        .unwrap();
    // An Active attempt with NO live registration (a restart leftover) and a
    // persisted preference: selected-but-unavailable, turn uncertain — never
    // inferred runnable and never "working".
    let attempt = Attempt::new("attempt-idle", "task-idle", "scenario", "scenario-cap-v1");
    store.insert_attempt(&attempt).unwrap();
    store
        .append_event_with_state(
            &goalport_core::Event {
                id: "e-idle-1".to_owned(),
                attempt_id: "attempt-idle".to_owned(),
                seq: 1,
                kind: "attempt.active".to_owned(),
                payload_ref: None,
            },
            Some(AttemptState::Active),
            None,
        )
        .unwrap();
    store
        .set_conversation_provider("campaign-idle", "scenario")
        .unwrap();

    let server = CoreServer::new(store.clone());
    // An explicit Send BEFORE anything has selected the attempt performs no
    // implicit admission or selection change: it is refused, and nothing is
    // registered or sent on the user's behalf.
    let error = error_of(result(
        &server,
        "idle-send",
        "conversation_send",
        json!({
            "campaignId": "campaign-idle",
            "message": "hello again"
        }),
    ));
    assert!(
        error.contains("not selected by Core"),
        "no implicit admission from an explicit send: {error}"
    );
    assert!(
        !event_kinds(&store, "attempt-idle").contains(&"runtime.session.created".to_owned()),
        "nothing was registered by the refused send"
    );
    // Only after the projection has been read (which selects the attempt for
    // display) does the product model speak: unavailable runtime, uncertain
    // turn, no Stop, no Send.
    let snapshot = view(result(&server, "idle-snapshot", "snapshot", json!({})));
    let product = &snapshot["productConversation"];
    assert_eq!(product["runtime"]["state"], "unavailable");
    assert_eq!(product["runtime"]["provider"], "scenario");
    assert_eq!(product["turn"]["state"], "uncertain");
    assert_eq!(product["turn"]["canStop"], false);
    assert_eq!(product["turn"]["canSend"], false);
    assert!(
        product["turn"]["reason"]
            .as_str()
            .unwrap_or_default()
            .contains("result is uncertain"),
        "{product}"
    );
}

#[test]
fn reserved_queued_attempt_is_idle_with_reason() {
    let workspace = temp_workspace("reserved-idle");
    let store = Store::memory().unwrap();
    let attempt = prepared_start_cut(
        &store,
        "reserved-idle-1",
        &canonical(&workspace),
        "scenario",
        "reserved prompt",
    );
    // No controller admission has run: the row is still the reserved queued
    // attempt with its single message.user event.
    let row = store.get_attempt(&attempt).unwrap();
    assert_eq!(row.state, AttemptState::Queued);
    // The product projection (built through a controller that has not
    // admitted anything) reports idle, not running, and no send.
    let server = CoreServer::new(store.clone());
    let snapshot = view(result(&server, "reserved-snapshot", "snapshot", json!({})));
    let product = &snapshot["productConversation"];
    assert_eq!(product["turn"]["state"], "idle");
    assert_eq!(product["turn"]["canSend"], false);
    assert_eq!(product["turn"]["canStop"], false);
    assert!(
        product["turn"]["reason"]
            .as_str()
            .unwrap_or_default()
            .contains("reserved"),
        "{product}"
    );
}

// ---------------------------------------------------------------------------
// Confirmed-stop successor lineage (R2/R3)
// ---------------------------------------------------------------------------

/// A campaign whose single scenario attempt was durably confirmed-cancelled.
fn confirmed_stopped_campaign(store: &Store, workspace: &str, label: &str) -> (String, String) {
    let project = Project {
        id: format!("project-{label}"),
        workspace_root: workspace.to_owned(),
    };
    let campaign = Campaign {
        id: format!("campaign-{label}"),
        goal: label.to_owned(),
        root_task_id: format!("task-{label}"),
        state: goalport_core::WorkStatus::InProgress,
    };
    let task = Task {
        id: format!("task-{label}"),
        campaign_id: campaign.id.clone(),
        title: label.to_owned(),
        acceptance: "a".to_owned(),
        state: goalport_core::WorkStatus::InProgress,
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
    store
        .append_event_with_state(
            &goalport_core::Event {
                id: format!("e-{label}-1"),
                attempt_id: attempt.id.clone(),
                seq: 1,
                kind: "attempt.active".to_owned(),
                payload_ref: None,
            },
            Some(AttemptState::Active),
            None,
        )
        .unwrap();
    store
        .append_event_with_state(
            &goalport_core::Event {
                id: format!("e-{label}-2"),
                attempt_id: attempt.id.clone(),
                seq: 2,
                kind: "attempt.cancelled".to_owned(),
                payload_ref: None,
            },
            Some(AttemptState::Cancelled),
            Some(&json!({ "requested": true, "confirmed": true })),
        )
        .unwrap();
    store
        .set_conversation_provider(&campaign.id, "scenario")
        .unwrap();
    (campaign.id.clone(), task.id.clone())
}

#[test]
fn confirmed_stop_successor_lineage_is_atomic_source_immutable_and_single_use() {
    let workspace = temp_workspace("successor");
    let root = canonical(&workspace);
    let store = Store::memory().unwrap();
    let (campaign_id, task_id) =
        confirmed_stopped_campaign(&store, &root, "successor");
    let source = format!("attempt-successor");
    let source_events_before = event_kinds(&store, &source);

    let server = CoreServer::new(store.clone());
    let response = result(
        &server,
        "successor-send-1",
        "conversation_send",
        json!({
            "campaignId": campaign_id,
            "message": "continue the work"
        }),
    );
    let snapshot = view(response);
    let store = server.processor().store();

    // A successor attempt exists with recorded lineage, same provider.
    let attempts = store.attempts_for_task(&task_id).unwrap();
    assert_eq!(attempts.len(), 2, "exactly one successor was created");
    let successor = attempts
        .iter()
        .find(|attempt| attempt.id != source)
        .expect("successor row");
    assert_eq!(successor.provider, "scenario");
    assert_eq!(successor.task_id, task_id);
    let lineage = store
        .list_event_records(&successor.id, 0)
        .unwrap()
        .into_iter()
        .find(|record| record.event.kind == "attempt.created")
        .expect("successor lineage event");
    assert_eq!(
        lineage
            .payload
            .as_ref()
            .and_then(|payload| payload.get("rolledFrom"))
            .and_then(Value::as_str),
        Some(source.as_str())
    );
    // The source state and its events are immutable.
    let source_after = store.get_attempt(&source).unwrap();
    assert_eq!(source_after.state, AttemptState::Cancelled);
    assert_eq!(event_kinds(&store, &source), source_events_before);
    // The conversation spans the campaign: original messages plus the new one.
    let texts = user_message_texts(&store, &campaign_id);
    assert_eq!(texts, vec!["continue the work".to_owned()]);
    // The product turn completed on the successor.
    let product = &snapshot["productConversation"];
    assert_eq!(product["turn"]["state"], "completed");
    assert_eq!(product["turn"]["canSend"], true);
    // The preference survives the stop (same provider, still selected).
    assert_eq!(product["runtime"]["state"], "selected");
    assert_eq!(product["runtime"]["provider"], "scenario");

    // A repeat of the same request answers the recorded outcome and never
    // creates a second successor or a second message.
    let again = result(
        &server,
        "successor-send-1",
        "conversation_send",
        json!({
            "campaignId": campaign_id,
            "message": "continue the work"
        }),
    );
    assert_eq!(again["ok"], true, "{again}");
    assert_eq!(again["payload"]["duplicate"], true, "{again}");
    assert_eq!(store.attempts_for_task(&task_id).unwrap().len(), 2);
    assert_eq!(user_message_texts(&store, &campaign_id).len(), 1);
}

#[test]
fn unconfirmed_or_uncertain_stop_refuses_a_successor_transactionally() {
    let workspace = temp_workspace("refuse-successor");
    let root = canonical(&workspace);
    let store = Store::memory().unwrap();

    // (a) An ACTIVE attempt with only an interrupt request: uncertain, refused.
    let project = Project {
        id: "project-refuse".to_owned(),
        workspace_root: root.clone(),
    };
    let campaign = Campaign {
        id: "campaign-refuse".to_owned(),
        goal: "refuse".to_owned(),
        root_task_id: "task-refuse".to_owned(),
        state: goalport_core::WorkStatus::InProgress,
    };
    let task = Task {
        id: "task-refuse".to_owned(),
        campaign_id: campaign.id.clone(),
        title: "refuse".to_owned(),
        acceptance: "a".to_owned(),
        state: goalport_core::WorkStatus::InProgress,
    };
    store
        .create_workspace_campaign(
            &project,
            &campaign,
            &task,
            "policy-refuse",
            "{}",
            &CampaignAuthorization::granted(),
        )
        .unwrap();
    let active = Attempt::new("attempt-refuse", &task.id, "scenario", "scenario-cap-v1");
    store.insert_attempt(&active).unwrap();
    store
        .append_event_with_state(
            &goalport_core::Event {
                id: "e-refuse-1".to_owned(),
                attempt_id: "attempt-refuse".to_owned(),
                seq: 1,
                kind: "attempt.active".to_owned(),
                payload_ref: None,
            },
            Some(AttemptState::Active),
            None,
        )
        .unwrap();
    store
        .set_conversation_provider("campaign-refuse", "scenario")
        .unwrap();
    let server = CoreServer::new(store.clone());
    let error = error_of(result(
        &server,
        "refuse-send-1",
        "conversation_send",
        json!({
            "campaignId": "campaign-refuse",
            "message": "continue anyway"
        }),
    ));
    assert!(
        error.contains("has current persisted work but no registered Runtime")
            || error.contains("Runtime has not been selected")
            || error.contains("not selected by Core"),
        "an unconfirmed stop must not create a replacement: {error}"
    );
    assert_eq!(
        store.attempts_for_task(&task.id).unwrap().len(),
        1,
        "no successor row was created"
    );

    // (b) A CANCELLED attempt whose workspace is still held by a durable stop
    // responsibility: refused transactionally, registration preserved.
    let store = Store::memory().unwrap();
    let (campaign_id, task_id) =
        confirmed_stopped_campaign(&store, &root, "held");
    store
        .begin_stop_responsibility(
            "attempt-held",
            "operation-held",
            &root,
            "scenario",
            &json!({ "held": true }),
            None,
        )
        .unwrap();
    let server = CoreServer::new(store.clone());
    let error = error_of(result(
        &server,
        "held-send-1",
        "conversation_send",
        json!({
            "campaignId": campaign_id,
            "message": "continue anyway"
        }),
    ));
    assert!(
        error.contains("durable Stop responsibility"),
        "a held workspace refuses the replacement: {error}"
    );
    assert_eq!(store.attempts_for_task(&task_id).unwrap().len(), 1);
    // The product turn model reports the held stop as stopping (the interrupt
    // is out, the native terminal has not been observed) — never ready.
    let snapshot = view(result(&server, "held-snapshot", "snapshot", json!({})));
    let product = &snapshot["productConversation"];
    assert_eq!(product["turn"]["state"], "stopping");
    assert_eq!(product["turn"]["canSend"], false);
    assert_eq!(product["turn"]["canStop"], false);
    assert!(
        product["turn"]["reason"]
            .as_str()
            .unwrap_or_default()
            .contains("durable Stop responsibility"),
        "{product}"
    );
}

// ---------------------------------------------------------------------------
// No-retry send rule (R2: the generic retry after UNKNOWN is REMOVED)
// ---------------------------------------------------------------------------

fn env_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

#[test]
fn no_retry_records_a_single_failed_send_event_with_unknown_delivery() {
    let _lock = env_lock().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    // Seed a campaign + registered scenario runtime through the fixture server,
    // then force exactly one send failure through the isolated marker.
    let workspace = temp_workspace("no-retry-2");
    let server = CoreServer::new_seeded_fixture(Store::memory().unwrap(), workspace.to_string_lossy().to_string());
    // A snapshot selects the fixture attempt, exactly as the desktop would.
    let _ = view(result(&server, "no-retry-snapshot", "snapshot", json!({})));
    unsafe { std::env::set_var("GOALPORT_REQUIRE_ISOLATED", "1"); };
    let response = result(
        &server,
        "no-retry-send",
        "send_message",
        json!({
            "campaignId": "campaign-synthetic-preview",
            "taskId": "task-synthetic-preview",
            "attemptId": "attempt-scenario-preview",
            "message": "please fail RC-MARKER-FORCE-FAIL now"
        }),
    );
    unsafe { std::env::remove_var("GOALPORT_REQUIRE_ISOLATED"); };
    let error = error_of(response);
    assert!(error.contains("RC-MARKER-FORCE-FAIL"), "{error}");
    let store = server.processor().store();
    let records = store
        .list_event_records("attempt-scenario-preview", 0)
        .unwrap();
    let failures = records
        .iter()
        .filter(|record| record.event.kind == "runtime.send.failed")
        .collect::<Vec<_>>();
    assert_eq!(
        failures.len(),
        1,
        "exactly one send-failure record: no silent retry ran a second native call"
    );
    let failure = failures[0];
    assert_eq!(failure.payload.as_ref().unwrap()["retry"], json!(false));
    assert_eq!(
        failure.payload.as_ref().unwrap()["deliveryState"],
        json!("UNKNOWN")
    );
    let command = store.get_command("ui-send-no-retry-send").unwrap();
    assert_eq!(command.state, goalport_core::CommandState::Failed);
    assert_eq!(
        store
            .command_result("ui-send-no-retry-send")
            .unwrap()
            .unwrap()["deliveryState"],
        json!("UNKNOWN")
    );
    // A replay of the failed request refuses instead of re-sending.
    unsafe { std::env::set_var("GOALPORT_REQUIRE_ISOLATED", "1"); };
    let replay = result(
        &server,
        "no-retry-send",
        "send_message",
        json!({
            "campaignId": "campaign-synthetic-preview",
            "taskId": "task-synthetic-preview",
            "attemptId": "attempt-scenario-preview",
            "message": "please fail RC-MARKER-FORCE-FAIL now"
        }),
    );
    unsafe { std::env::remove_var("GOALPORT_REQUIRE_ISOLATED"); };
    let replay_error = error_of(replay);
    assert!(
        replay_error.contains("was not sent again"),
        "{replay_error}"
    );
    let after = store
        .list_event_records("attempt-scenario-preview", 0)
        .unwrap()
        .iter()
        .filter(|record| record.event.kind == "runtime.send.failed")
        .count();
    assert_eq!(after, 1, "the replay did not attempt another native call");
}

// ---------------------------------------------------------------------------
// Rename
// ---------------------------------------------------------------------------

#[test]
fn rename_updates_title_durably_without_rewriting_history() {
    let workspace = temp_workspace("rename");
    let root = canonical(&workspace);
    let server = CoreServer::new(Store::memory().unwrap());
    let first = view(result(
        &server,
        "rename-start-1",
        "start_conversation",
        start_payload(&root, "scenario", "the original first prompt text"),
    ));
    let campaign_id = first["activeCampaignId"].as_str().unwrap().to_owned();
    let store = server.processor().store();
    assert_eq!(
        first["productConversation"]["title"],
        "the original first prompt text"
    );
    let history_before = store.campaign_event_records(&campaign_id).unwrap();

    let renamed = view(result(
        &server,
        "rename-1",
        "rename_conversation",
        json!({
            "campaignId": campaign_id,
            "title": "  Renamed conversation  "
        }),
    ));
    assert_eq!(renamed["productConversation"]["title"], "Renamed conversation");
    // The history is unchanged: same records, same original prompt payload.
    let history_after = store.campaign_event_records(&campaign_id).unwrap();
    assert_eq!(history_before, history_after);
    assert_eq!(
        user_message_texts(&store, &campaign_id),
        vec!["the original first prompt text".to_owned()]
    );
    // Empty titles are refused.
    let error = error_of(result(
        &server,
        "rename-2",
        "rename_conversation",
        json!({ "campaignId": campaign_id, "title": "   " }),
    ));
    assert!(
        error.contains("title is required") || error.contains("must not be empty"),
        "{error}"
    );
}

// ---------------------------------------------------------------------------
// Rename navigation: the campaigns list resolves its
// title from the durable preference when present and keeps the legacy root
// task title fallback otherwise. No history or task rows are rewritten.
// ---------------------------------------------------------------------------

#[test]
fn rename_updates_campaign_navigation_title_immediately_and_after_reopen() {
    let workspace = temp_workspace("rename-nav");
    let root = canonical(&workspace);
    let path = workspace.join("rename-nav.sqlite");
    let campaign_id;
    {
        let server = CoreServer::new(Store::open(&path).unwrap());
        let first = view(result(
            &server,
            "rename-nav-start-1",
            "start_conversation",
            start_payload(&root, "scenario", "the navigation prompt"),
        ));
        campaign_id = first["activeCampaignId"].as_str().unwrap().to_owned();
        // Before any rename the navigation title is the legacy root task title.
        let before = first["campaigns"]
            .as_array()
            .unwrap()
            .iter()
            .find(|campaign| campaign["id"] == campaign_id.as_str())
            .expect("started campaign is listed")
            .clone();
        assert_eq!(
            before["title"], before["activeTaskTitle"],
            "without a preference the navigation title is the root task title"
        );

        let renamed = view(result(
            &server,
            "rename-nav-1",
            "rename_conversation",
            json!({ "campaignId": campaign_id, "title": "Navigated conversation" }),
        ));
        // Immediately: both the product title and the campaigns entry follow.
        assert_eq!(
            renamed["productConversation"]["title"],
            "Navigated conversation"
        );
        let listed = renamed["campaigns"]
            .as_array()
            .unwrap()
            .iter()
            .find(|campaign| campaign["id"] == campaign_id.as_str())
            .expect("renamed campaign is listed")
            .clone();
        assert_eq!(listed["title"], "Navigated conversation");
    }
    // Reopen: both titles persist from the durable preference column.
    let server = CoreServer::new(Store::open(&path).unwrap());
    let reopened = view(result(&server, "rename-nav-snapshot", "snapshot", json!({})));
    assert_eq!(reopened["activeCampaignId"].as_str().unwrap(), campaign_id);
    assert_eq!(
        reopened["productConversation"]["title"],
        "Navigated conversation"
    );
    let listed = reopened["campaigns"]
        .as_array()
        .unwrap()
        .iter()
        .find(|campaign| campaign["id"] == campaign_id.as_str())
        .expect("campaign is listed after reopen");
    assert_eq!(listed["title"], "Navigated conversation");
}

#[test]
fn rename_leaves_sibling_campaign_titles_untouched() {
    let workspace = temp_workspace("rename-sibling");
    let root = canonical(&workspace);
    let server = CoreServer::new(Store::memory().unwrap());
    let first = view(result(
        &server,
        "sibling-start-1",
        "start_conversation",
        start_payload(&root, "scenario", "the sibling prompt"),
    ));
    let first_id = first["activeCampaignId"].as_str().unwrap().to_owned();
    let second = view(result(
        &server,
        "sibling-start-2",
        "start_conversation",
        start_payload(&root, "scenario", "the kept prompt"),
    ));
    let second_id = second["activeCampaignId"].as_str().unwrap().to_owned();
    let second_title = second["campaigns"]
        .as_array()
        .unwrap()
        .iter()
        .find(|campaign| campaign["id"] == second_id)
        .expect("sibling campaign is listed")["title"]
        .clone();

    // Rename only the older (non-active) campaign.
    let renamed = view(result(
        &server,
        "sibling-rename-1",
        "rename_conversation",
        json!({ "campaignId": first_id, "title": "First renamed" }),
    ));
    let listed = renamed["campaigns"].as_array().unwrap();
    let renamed_row = listed
        .iter()
        .find(|campaign| campaign["id"] == first_id.as_str())
        .expect("renamed campaign is listed");
    let sibling_row = listed
        .iter()
        .find(|campaign| campaign["id"] == second_id.as_str())
        .expect("sibling campaign is listed");
    assert_eq!(renamed_row["title"], "First renamed");
    assert_eq!(
        sibling_row["title"], second_title,
        "the sibling keeps its own title"
    );
    // The active conversation is the sibling; its product title is unchanged.
    assert_eq!(renamed["activeCampaignId"].as_str().unwrap(), second_id);
    assert_eq!(renamed["productConversation"]["title"], "the kept prompt");
}

#[test]
fn campaign_title_falls_back_to_root_task_without_preference() {
    let directory = tempfile::tempdir().unwrap();
    let workspace = directory.path().join("ws");
    std::fs::create_dir_all(&workspace).unwrap();
    let store = Store::memory().unwrap();
    let project = Project {
        id: "project-legacy".into(),
        workspace_root: workspace.to_string_lossy().to_string(),
    };
    let campaign = Campaign {
        id: "campaign-legacy".into(),
        goal: "legacy goal text".into(),
        root_task_id: "task-legacy".into(),
        state: goalport_core::WorkStatus::InProgress,
    };
    let task = Task {
        id: "task-legacy".into(),
        campaign_id: "campaign-legacy".into(),
        title: "legacy root task title".into(),
        acceptance: "a".into(),
        state: goalport_core::WorkStatus::InProgress,
    };
    store
        .create_workspace_campaign(
            &project,
            &campaign,
            &task,
            "policy-legacy",
            "{}",
            &CampaignAuthorization::granted(),
        )
        .unwrap();
    let server = CoreServer::new(store);
    let snapshot = view(result(&server, "legacy-snapshot-1", "snapshot", json!({})));
    let row = snapshot["campaigns"]
        .as_array()
        .unwrap()
        .iter()
        .find(|campaign| campaign["id"] == "campaign-legacy")
        .expect("legacy campaign is listed");
    // No preference row and no first prompt: the root task title is the
    // navigation title, not the campaign goal.
    assert_eq!(row["title"], "legacy root task title");
    assert_eq!(row["activeTaskTitle"], "legacy root task title");
}

// ---------------------------------------------------------------------------
// No automatic send on selection/reconnect
// ---------------------------------------------------------------------------

#[test]
fn selection_and_reconnect_never_send() {
    let workspace = temp_workspace("no-auto-send");
    let root = canonical(&workspace);
    let server = CoreServer::new(Store::memory().unwrap());
    let started = view(result(
        &server,
        "auto-start-1",
        "start_conversation",
        start_payload(&root, "scenario", "the only message"),
    ));
    let campaign_id = started["activeCampaignId"].as_str().unwrap().to_owned();
    let store = server.processor().store();
    let messages_before = user_message_texts(&store, &campaign_id).len();

    for (id, kind, payload) in [
        (
            "auto-select",
            "select_runtime",
            json!({ "provider": "scenario", "campaignId": campaign_id }),
        ),
        (
            "auto-reconnect",
            "reconnect",
            json!({ "cursor": 0 }),
        ),
        ("auto-snapshot", "snapshot", json!({})),
    ] {
        let response = result(&server, id, kind, payload);
        assert_eq!(response["ok"], true, "{id}: {response}");
    }
    assert_eq!(
        user_message_texts(&store, &campaign_id).len(),
        messages_before,
        "selection, reconnect and polling never trigger a send"
    );
}

// ---------------------------------------------------------------------------
// Preference backfill (R2): last durable attempt by insertion rowid
// ---------------------------------------------------------------------------

#[test]
fn preference_backfill_uses_last_durable_attempt_and_skips_attemptless_campaigns() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("backfill.sqlite");
    {
        let store = Store::open(&path).unwrap();
        let workspace = directory.path().join("ws");
        std::fs::create_dir_all(&workspace).unwrap();
        for label in ["backfill-a", "backfill-b"] {
            let project = Project {
                id: format!("project-{label}"),
                workspace_root: workspace.to_string_lossy().to_string(),
            };
            let campaign = Campaign {
                id: format!("campaign-{label}"),
                goal: label.to_owned(),
                root_task_id: format!("task-{label}"),
                state: goalport_core::WorkStatus::InProgress,
            };
            let task = Task {
                id: format!("task-{label}"),
                campaign_id: campaign.id.clone(),
                title: label.to_owned(),
                acceptance: "a".to_owned(),
                state: goalport_core::WorkStatus::InProgress,
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
        }
        // campaign-a gets an attempt; campaign-b gets none.
        let attempt = Attempt::new(
            "attempt-backfill-a",
            "task-backfill-a",
            "grok",
            "grok-cap-v1",
        );
        store.insert_attempt(&attempt).unwrap();
        // An explicit preference row is never overwritten by the backfill.
        store
            .set_conversation_provider("campaign-backfill-a", "codex")
            .unwrap();
    }
    // Reopen: migrate() backfills only absent rows.
    let store = Store::open(&path).unwrap();
    let preserved = store
        .conversation_preference("campaign-backfill-a")
        .unwrap()
        .expect("row exists");
    assert_eq!(preserved.selected_provider.as_deref(), Some("codex"));
    // The attemptless campaign reads as 'none': either no row or a row whose
    // selected_provider is NULL.
    let attemptless = store
        .conversation_preference("campaign-backfill-b")
        .unwrap();
    assert!(
        attemptless.as_ref().and_then(|row| row.selected_provider.clone()).is_none(),
        "no attempt means no selected provider: {attemptless:?}"
    );
}
