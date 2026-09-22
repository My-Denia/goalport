//! Adversarial, protocol-level coverage for bounded conversation history.
//!
//! These tests seed only local SQLite stores and drive the connected-UI wire.
//! They do not start a native Runtime or delete/rewrite any durable history.

use goalport_core::{
    Attempt, AttemptState, Campaign, CoreCommand, CoreOperation, CoreServer, Event,
    HistoryDirection, HistoryPage, IpcRequest, Project, Store, Task, WorkStatus,
    history::{HISTORY_ITEMS_BYTES, SERIALIZED_FRAGMENT_BYTES, conversation_page},
    ipc::CONNECTED_UI_PROTOCOL_VERSION,
    response_bounds::{MAX_CAPACITY_ACK_BYTES, MAX_RESPONSE_BYTES, bound_ui_response},
    store::CampaignAuthorization,
};
use serde_json::{Value, json};
use std::{collections::HashSet, path::PathBuf};
use tempfile::TempDir;

struct Fixture {
    _directory: TempDir,
    database: PathBuf,
    store: Store,
    campaign_id: String,
    task_id: String,
    attempt_id: String,
    next_seq: i64,
}

impl Fixture {
    fn new(label: &str) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().join(format!("{label}-workspace"));
        std::fs::create_dir_all(&workspace).unwrap();
        let database = directory.path().join("goalport.sqlite");
        let store = Store::open(&database).unwrap();
        let campaign_id = format!("campaign-{label}");
        let task_id = format!("task-{label}");
        let attempt_id = format!("attempt-{label}");
        store
            .create_workspace_campaign(
                &Project {
                    id: format!("project-{label}"),
                    workspace_root: workspace.to_string_lossy().into_owned(),
                },
                &Campaign {
                    id: campaign_id.clone(),
                    goal: format!("paging test {label}"),
                    root_task_id: task_id.clone(),
                    state: WorkStatus::InProgress,
                },
                &Task {
                    id: task_id.clone(),
                    campaign_id: campaign_id.clone(),
                    title: format!("paging test {label}"),
                    acceptance: "all history is reachable exactly once".into(),
                    state: WorkStatus::InProgress,
                },
                &format!("policy-{label}"),
                "{}",
                &CampaignAuthorization::granted(),
            )
            .unwrap();
        store
            .insert_attempt(&Attempt::new(
                &attempt_id,
                &task_id,
                "scenario",
                "scenario-cap-v1",
            ))
            .unwrap();
        Self {
            _directory: directory,
            database,
            store,
            campaign_id,
            task_id,
            attempt_id,
            next_seq: 1,
        }
    }

    fn append(&mut self, kind: &str, payload: Value) -> String {
        let seq = self.next_seq;
        self.next_seq += 1;
        let id = format!("{}-event-{seq}", self.attempt_id);
        self.store
            .append_event_json(
                &Event {
                    id: id.clone(),
                    attempt_id: self.attempt_id.clone(),
                    seq,
                    kind: kind.into(),
                    payload_ref: None,
                },
                &payload,
            )
            .unwrap();
        id
    }

    fn append_without_state_transition(&mut self, kind: &str, payload: Value) -> String {
        let seq = self.next_seq;
        self.next_seq += 1;
        let id = format!("{}-event-{seq}", self.attempt_id);
        self.store
            .append_event_with_state(
                &Event {
                    id: id.clone(),
                    attempt_id: self.attempt_id.clone(),
                    seq,
                    kind: kind.into(),
                    payload_ref: None,
                },
                None,
                Some(&payload),
            )
            .unwrap();
        id
    }

    fn user(&mut self, text: &str) -> String {
        self.append("message.user", json!({ "text": text }))
    }

    fn delta(&mut self, text: &str) -> String {
        self.append("runtime.reply.delta", json!({ "text": text }))
    }
}

fn ui_wire(id: &str, message_type: &str, payload: Value) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "protocolVersion": CONNECTED_UI_PROTOCOL_VERSION,
        "requestId": id,
        "entityVersion": 0,
        "messageType": message_type,
        "payload": payload
    }))
    .unwrap()
}

fn ui_call(server: &CoreServer, id: &str, message_type: &str, payload: Value) -> Value {
    server
        .handle_json(&ui_wire(id, message_type, payload))
        .expect("valid connected-UI response")
}

fn snapshot(server: &CoreServer, id: &str) -> (Value, Value) {
    let response = ui_call(server, id, "snapshot", json!({}));
    assert_eq!(response["ok"], true, "{response}");
    assert!(
        serde_json::to_vec(&response).unwrap().len() <= MAX_RESPONSE_BYTES,
        "the complete success envelope must fit the 8 MiB contract"
    );
    let view = response["payload"]["snapshot"].clone();
    (response, view)
}

fn history_wire(
    server: &CoreServer,
    request_id: &str,
    scope: &str,
    owner_id: &str,
    direction: &str,
    cursor: Option<&str>,
) -> (Value, HistoryPage) {
    let mut payload = json!({
        "scope": scope,
        "ownerId": owner_id,
        "direction": direction
    });
    if let Some(cursor) = cursor {
        payload["cursor"] = json!(cursor);
    }
    let response = ui_call(server, request_id, "history_page", payload);
    assert_eq!(response["ok"], true, "{response}");
    assert!(
        response["payload"].get("snapshot").is_none(),
        "history pages never carry a snapshot"
    );
    assert!(serde_json::to_vec(&response).unwrap().len() <= MAX_RESPONSE_BYTES);
    let page: HistoryPage =
        serde_json::from_value(response["payload"]["historyPage"].clone()).unwrap();
    let values = page.conversation_items.as_deref().unwrap_or_default();
    assert_eq!(page.page_info.item_count, values.len());
    assert_eq!(
        page.page_info.content_bytes,
        serde_json::to_vec(values).unwrap().len()
    );
    for item in values {
        assert!(serde_json::to_vec(item).unwrap().len() <= SERIALIZED_FRAGMENT_BYTES);
    }
    (response, page)
}

fn all_conversation_newer(
    server: &CoreServer,
    campaign_id: &str,
) -> Vec<goalport_core::ProductConversationItem> {
    let mut cursor: Option<String> = None;
    let mut all = Vec::new();
    let mut seen_cursors = HashSet::new();
    for page_index in 0..2048 {
        let (_, page) = history_wire(
            server,
            &format!("history-newer-{page_index}"),
            "conversation",
            campaign_id,
            "newer",
            cursor.as_deref(),
        );
        all.extend(page.conversation_items.unwrap_or_default());
        if !page.page_info.has_newer {
            return all;
        }
        let next = page
            .page_info
            .newer_cursor
            .expect("hasNewer requires a cursor");
        assert!(
            seen_cursors.insert(next.clone()),
            "cursor traversal must make progress"
        );
        cursor = Some(next);
    }
    panic!("history traversal did not terminate")
}

fn all_conversation_older(
    store: &Store,
    campaign_id: &str,
    budget: usize,
) -> Vec<goalport_core::ProductConversationItem> {
    let mut cursor: Option<String> = None;
    let mut all = Vec::new();
    let mut seen_cursors = HashSet::new();
    for _ in 0..4096 {
        let page = conversation_page(
            store,
            campaign_id,
            HistoryDirection::Older,
            cursor.as_deref(),
            budget,
        )
        .unwrap();
        let mut items = page.conversation_items.unwrap_or_default();
        items.extend(all);
        all = items;
        assert!(page.page_info.content_bytes <= budget);
        if !page.page_info.has_older {
            return all;
        }
        let next = page
            .page_info
            .older_cursor
            .expect("hasOlder requires a cursor");
        assert!(
            seen_cursors.insert(next.clone()),
            "older traversal must make progress"
        );
        cursor = Some(next);
    }
    panic!("older history traversal did not terminate")
}

fn all_conversation_newer_direct(
    store: &Store,
    campaign_id: &str,
    budget: usize,
) -> Vec<goalport_core::ProductConversationItem> {
    let mut cursor: Option<String> = None;
    let mut all = Vec::new();
    let mut seen_cursors = HashSet::new();
    for _ in 0..4096 {
        let page = conversation_page(
            store,
            campaign_id,
            HistoryDirection::Newer,
            cursor.as_deref(),
            budget,
        )
        .unwrap();
        assert!(page.page_info.content_bytes <= budget);
        all.extend(page.conversation_items.unwrap_or_default());
        if !page.page_info.has_newer {
            return all;
        }
        let next = page
            .page_info
            .newer_cursor
            .expect("hasNewer requires a cursor");
        assert!(
            seen_cursors.insert(next.clone()),
            "newer traversal must make progress"
        );
        cursor = Some(next);
    }
    panic!("newer history traversal did not terminate")
}

fn logical_bodies(
    items: &[goalport_core::ProductConversationItem],
) -> Vec<(String, String, String)> {
    let mut groups: Vec<(String, String, String)> = Vec::new();
    for item in items {
        if let Some((logical, kind, body)) = groups.last_mut()
            && *logical == item.logical_item_id
            && *kind == item.kind
        {
            body.push_str(&item.body);
        } else {
            groups.push((
                item.logical_item_id.clone(),
                item.kind.clone(),
                item.body.clone(),
            ));
        }
    }
    groups
}

fn assert_unique_fragments(items: &[goalport_core::ProductConversationItem]) {
    let mut ids = HashSet::new();
    for item in items {
        assert!(
            ids.insert(item.id.clone()),
            "duplicate physical fragment {}",
            item.id
        );
    }
}

#[test]
fn seventeen_mib_campaign_keeps_recent_snapshot_and_reconstructs_every_utf8_message() {
    let mut fixture = Fixture::new("seventeen-mib");
    let unit = "🌏\"\\\n";
    let messages = (0..20)
        .map(|index| format!("message-{index:02}:{}", unit.repeat(130_000)))
        .collect::<Vec<_>>();
    assert!(messages.iter().map(|value| value.len()).sum::<usize>() > 17 * 1024 * 1024);
    for message in &messages {
        fixture.user(message);
    }
    fixture.user("RECENT_SENTINEL");
    let expected_event_count = fixture.store.counts().unwrap().events;
    let server = CoreServer::new(fixture.store.clone());

    let (_, view) = snapshot(&server, "snapshot-17m");
    let recent = view["productConversation"]["items"].as_array().unwrap();
    assert!(
        recent.iter().any(|item| item["body"] == "RECENT_SENTINEL"),
        "the bounded recent page must remain useful"
    );
    assert!(serde_json::to_vec(recent).unwrap().len() <= 512 * 1024);
    assert_eq!(fixture.store.counts().unwrap().events, expected_event_count);

    let all = all_conversation_newer(&server, &fixture.campaign_id);
    assert_unique_fragments(&all);
    let reconstructed = logical_bodies(&all)
        .into_iter()
        .filter(|(_, kind, _)| kind == "user-message")
        .map(|(_, _, body)| body)
        .collect::<Vec<_>>();
    let mut expected = messages;
    expected.push("RECENT_SENTINEL".into());
    assert_eq!(
        reconstructed, expected,
        "escaped UTF-8 content must reconstruct exactly"
    );
    assert_eq!(
        fixture.store.counts().unwrap().events,
        expected_event_count,
        "paging is read-only"
    );

    let refused = ui_call(
        &server,
        "bounded-refusal",
        "select_campaign",
        json!({ "campaignId": "missing-campaign" }),
    );
    assert_eq!(refused["ok"], false, "{refused}");
    assert!(refused["payload"]["snapshot"].is_object());
    assert!(serde_json::to_vec(&refused).unwrap().len() <= MAX_RESPONSE_BYTES);
}

#[test]
fn exclusive_cursors_survive_restart_vacuum_batches_and_concurrent_append_without_gaps() {
    let mut fixture = Fixture::new("cursor-stability");
    let mut expected = Vec::new();
    for index in 0..41 {
        let body = if index == 17 {
            format!("huge-{index}:{}", "\"\\\n🙂".repeat(180_000))
        } else if index % 3 == 0 {
            format!("medium-{index}:{}", "m".repeat(48_000))
        } else {
            format!("small-{index}:{}", "s".repeat(2_000 + index))
        };
        fixture.user(&body);
        expected.push(body);
    }
    let budget = 90 * 1024;
    let newer = all_conversation_newer_direct(&fixture.store, &fixture.campaign_id, budget);
    let older = all_conversation_older(&fixture.store, &fixture.campaign_id, budget);
    assert_unique_fragments(&newer);
    assert_unique_fragments(&older);
    assert_eq!(
        newer
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>(),
        older
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>(),
        "exclusive older/newer traversal must cover identical physical fragments"
    );
    assert_eq!(
        logical_bodies(&newer)
            .into_iter()
            .map(|(_, _, body)| body)
            .collect::<Vec<_>>(),
        expected
    );

    let first = conversation_page(
        &fixture.store,
        &fixture.campaign_id,
        HistoryDirection::Newer,
        None,
        budget,
    )
    .unwrap();
    let cursor = first.page_info.newer_cursor.clone().unwrap();
    let expected_after_cursor = conversation_page(
        &fixture.store,
        &fixture.campaign_id,
        HistoryDirection::Newer,
        Some(&cursor),
        budget,
    )
    .unwrap();
    let database = fixture.database.clone();
    drop(fixture.store);
    let reopened = Store::open(&database).unwrap();
    reopened.vacuum().unwrap();
    let after_restart = conversation_page(
        &reopened,
        &fixture.campaign_id,
        HistoryDirection::Newer,
        Some(&cursor),
        budget,
    )
    .unwrap();
    assert_eq!(
        after_restart, expected_after_cursor,
        "cursor result changes across restart/VACUUM"
    );

    let end = conversation_page(
        &reopened,
        &fixture.campaign_id,
        HistoryDirection::Older,
        None,
        budget,
    )
    .unwrap()
    .page_info
    .newer_cursor
    .unwrap();
    reopened
        .append_event_json(
            &Event {
                id: "cursor-append-event".into(),
                attempt_id: fixture.attempt_id.clone(),
                seq: fixture.next_seq,
                kind: "message.user".into(),
                payload_ref: None,
            },
            &json!({ "text": "APPENDED_AFTER_CURSOR" }),
        )
        .unwrap();
    let appended = conversation_page(
        &reopened,
        &fixture.campaign_id,
        HistoryDirection::Newer,
        Some(&end),
        budget,
    )
    .unwrap();
    assert_eq!(
        logical_bodies(appended.conversation_items.as_deref().unwrap_or_default())
            .into_iter()
            .map(|(_, _, body)| body)
            .collect::<Vec<_>>(),
        vec!["APPENDED_AFTER_CURSOR"]
    );
}

#[test]
fn multi_delta_logical_reply_preserves_whitespace_and_splits_at_transport_closure() {
    let mut fixture = Fixture::new("reply-groups");
    fixture.user("question");
    fixture.append("attempt.active", json!({ "provider": "scenario" }));
    fixture.append("runtime.turn.started", json!({ "turn": "one" }));
    fixture.delta("alpha ");
    fixture.delta("   ");
    fixture.delta("omega");
    fixture.append_without_state_transition("runtime.transport.closed", json!({ "reason": "eof" }));
    fixture.delta("after closure");

    let items = all_conversation_newer_direct(&fixture.store, &fixture.campaign_id, 1024);
    assert_unique_fragments(&items);
    let assistant = items
        .iter()
        .filter(|item| item.kind == "assistant-message")
        .collect::<Vec<_>>();
    assert_eq!(
        assistant.len(),
        4,
        "each durable delta stays independently cursor-addressable"
    );
    assert_eq!(assistant[0].logical_item_id, assistant[1].logical_item_id);
    assert_eq!(assistant[1].logical_item_id, assistant[2].logical_item_id);
    assert_ne!(assistant[2].logical_item_id, assistant[3].logical_item_id);
    assert_eq!(
        assistant[..3]
            .iter()
            .map(|item| item.body.as_str())
            .collect::<String>(),
        "alpha    omega",
        "whitespace-only deltas are durable visible content"
    );
    assert_eq!(assistant[3].body, "after closure");
    let closure_index = items
        .iter()
        .position(|item| item.kind == "actionable-error")
        .expect("transport closure is projected as an actionable error");
    let after_index = items
        .iter()
        .position(|item| item.id == assistant[3].id)
        .unwrap();
    assert!(
        closure_index < after_index,
        "closure must precede the post-closure reply group"
    );
}

#[test]
fn filtered_only_raw_prefix_and_suffix_terminate_without_reset_or_visible_loss() {
    let mut fixture = Fixture::new("filtered-edges");
    for index in 0..25 {
        fixture.append(
            "runtime.protocol.diagnostic",
            json!({ "note": format!("filtered-prefix-{index}") }),
        );
    }
    fixture.user("VISIBLE_FIRST");
    for index in 0..25 {
        fixture.append(
            "runtime.protocol.diagnostic",
            json!({ "note": format!("filtered-middle-{index}") }),
        );
    }
    fixture.user("VISIBLE_LAST");
    for index in 0..25 {
        fixture.append(
            "runtime.protocol.diagnostic",
            json!({ "note": format!("filtered-suffix-{index}") }),
        );
    }
    let server = CoreServer::new(fixture.store.clone());

    let newer = all_conversation_newer(&server, &fixture.campaign_id);
    let older = all_conversation_older(&fixture.store, &fixture.campaign_id, HISTORY_ITEMS_BYTES);
    for items in [&newer, &older] {
        assert_unique_fragments(items);
        assert_eq!(
            logical_bodies(items)
                .into_iter()
                .filter(|(_, kind, _)| kind == "user-message")
                .map(|(_, _, body)| body)
                .collect::<Vec<_>>(),
            vec!["VISIBLE_FIRST", "VISIBLE_LAST"],
            "filtered raw rows at an edge must neither hide nor repeat visible content"
        );
    }
    assert_eq!(
        newer
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>(),
        older
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>(),
        "older/newer traversal diverged around filtered-only edges"
    );
}

#[test]
fn history_cursor_is_owner_bound_and_malformed_cursor_returns_a_bounded_ui_refusal() {
    let mut fixture = Fixture::new("cursor-owner");
    fixture.user(&"history".repeat(40_000));
    let server = CoreServer::new(fixture.store.clone());
    let (_, first) = history_wire(
        &server,
        "owner-first",
        "conversation",
        &fixture.campaign_id,
        "newer",
        None,
    );
    let cursor = first.page_info.newer_cursor.unwrap();
    for (request_id, owner, bad_cursor) in [
        ("wrong-owner", "campaign-somebody-else", cursor.as_str()),
        (
            "malformed",
            fixture.campaign_id.as_str(),
            "not-a-valid-cursor",
        ),
    ] {
        let response = server
            .handle_json(&ui_wire(
                request_id,
                "history_page",
                json!({
                    "scope": "conversation",
                    "ownerId": owner,
                    "direction": "newer",
                    "cursor": bad_cursor
                }),
            ))
            .expect("invalid history cursors are bounded UI refusals, not transport errors");
        assert_eq!(response["ok"], false, "{response}");
        assert!(response["payload"].get("snapshot").is_none());
        assert!(serde_json::to_vec(&response).unwrap().len() <= MAX_RESPONSE_BYTES);
    }
}

#[test]
fn legacy_and_connected_envelopes_remain_bounded_without_deleting_history() {
    let mut fixture = Fixture::new("envelopes");
    fixture.user(&"z".repeat(HISTORY_ITEMS_BYTES + 64 * 1024));
    let before = fixture.store.counts().unwrap();
    let server = CoreServer::new(fixture.store.clone());
    let (connected, _) = snapshot(&server, "bounded-connected");
    assert!(serde_json::to_vec(&connected).unwrap().len() <= MAX_RESPONSE_BYTES);

    let legacy = server.handle(IpcRequest::new(
        "legacy-bounded",
        CoreCommand::new(
            "legacy-command",
            &fixture.attempt_id,
            CoreOperation::TransitionAttempt {
                attempt_id: fixture.attempt_id.clone(),
                state: AttemptState::Active,
                event_id: "legacy-active-event".into(),
            },
        )
        .unwrap(),
    ));
    assert!(serde_json::to_vec(&legacy).unwrap().len() <= MAX_RESPONSE_BYTES);
    assert_eq!(legacy.request_id, "legacy-bounded");
    assert!(legacy.ok, "{legacy:?}");
    assert_eq!(fixture.store.counts().unwrap().events, before.events + 1);
}

#[test]
fn capacity_fallback_bounds_active_decision_receipt_and_rejection_without_fabricating_ids() {
    let oversized_facts = (0..12_000)
        .map(|index| format!("fact-{index}:{}", "\\\"\n🙂".repeat(180)))
        .collect::<Vec<_>>();
    let invalid_persisted_id = "i".repeat(300);
    let escaped_request_id = format!("{}x", "\\\"\n".repeat(85));
    assert_eq!(escaped_request_id.as_bytes().len(), 256);
    let oversized_workspace = format!("C:\\{}", "path-segment\\".repeat(20_000));
    let snapshot = json!({
        "protocolVersion": CONNECTED_UI_PROTOCOL_VERSION,
        "buildId": "build",
        "connection": "connected",
        "projects": [],
        "selectedProjectId": invalid_persisted_id,
        "project": { "id": "project-valid", "name": "Project", "workspaceRoot": oversized_workspace, "color": "blue" },
        "campaigns": [],
        "activeCampaignId": invalid_persisted_id,
        "activeTask": { "id": "task-valid", "title": "Task", "acceptance": "a", "state": "in-progress" },
        "attempt": { "id": "attempt-valid", "taskId": "task-valid", "provider": "scenario", "role": "executor", "state": "waiting", "sessionLabel": "none", "eventCount": 0 },
        "timeline": [],
        "timelinePageInfo": { "olderCursor": null, "newerCursor": null, "hasOlder": false, "hasNewer": false, "contentBytes": 2, "itemCount": 0 },
        "cursor": 0,
        "runtimes": [],
        "decisions": [{
            "actionKnown": true,
            "id": "decision-active",
            "title": "Active decision",
            "kind": "permission",
            "facts": oversized_facts,
            "recommendation": "wait",
            "defaultBehavior": "wait",
            "state": "pending"
        }],
        "evidence": [],
        "stopResponsibility": null,
        "relatedHolds": [],
        "productConversation": {
            "items": [],
            "pageInfo": { "olderCursor": null, "newerCursor": null, "hasOlder": false, "hasNewer": false, "contentBytes": 2, "itemCount": 0 },
            "runtime": { "state": "unavailable", "provider": "scenario", "name": "Scenario" },
            "turn": { "state": "uncertain", "canStop": false, "canSend": false, "reason": "unknown" },
            "title": "Capacity"
        },
        "preview": false,
        "notices": [],
        "bounds": { "truncated": false, "projectionUnavailable": false, "omittedCounts": {} }
    });
    let accepted = json!({
        "protocolVersion": CONNECTED_UI_PROTOCOL_VERSION,
        "requestId": escaped_request_id.clone(),
        "entityVersion": 7,
        "ok": true,
        "payload": {
            "requestId": escaped_request_id.clone(),
            "accepted": true,
            "duplicate": false,
            "snapshot": snapshot,
            "receipt": {
                "receiptId": "receipt-exact",
                "choice": "continue",
                "coreAcknowledged": true,
                "holdRequired": true,
                "oversizedDisplay": "r".repeat(400_000)
            }
        }
    });
    let bounded = bound_ui_response(accepted)
        .expect("committed success must always have a bounded acknowledgement");
    let bytes = serde_json::to_vec(&bounded).unwrap();
    assert!(
        bytes.len() <= MAX_CAPACITY_ACK_BYTES,
        "fallback was {} bytes",
        bytes.len()
    );
    assert_eq!(bounded["ok"], true);
    assert_eq!(bounded["requestId"], escaped_request_id);
    assert_eq!(bounded["payload"]["requestId"], escaped_request_id);
    assert_eq!(bounded["payload"]["accepted"], true);
    assert_eq!(bounded["payload"]["receipt"]["receiptId"], "receipt-exact");
    assert_eq!(
        bounded["payload"]["snapshot"]["bounds"]["projectionUnavailable"],
        true
    );
    let projected_campaign = bounded["payload"]["snapshot"]["activeCampaignId"]
        .as_str()
        .unwrap_or_default();
    assert!(
        projected_campaign.is_empty(),
        "an invalid persisted operational id must be omitted, never truncated into a new id"
    );
    let projected_workspace = bounded["payload"]["snapshot"]["project"]["workspaceRoot"]
        .as_str()
        .unwrap_or_default();
    assert!(
        projected_workspace.is_empty()
            || projected_workspace.starts_with("<workspace unavailable:"),
        "an oversized operational path must not become an actionable truncated prefix"
    );

    let rejected = json!({
        "protocolVersion": CONNECTED_UI_PROTOCOL_VERSION,
        "requestId": "capacity-rejected-request",
        "entityVersion": 8,
        "ok": false,
        "payload": {
            "requestId": "capacity-rejected-request",
            "accepted": false,
            "snapshot": bounded["payload"]["snapshot"].clone(),
            "rejection": {
                "code": "admission-failed",
                "message": "e".repeat(9 * 1024 * 1024),
                "deliveryState": "FAILED",
                "nativeDispatchState": "NOT_STARTED",
                "retryMode": "SAME_REQUEST",
                "reservation": {
                    "kind": "first-send",
                    "requestId": "capacity-rejected-request",
                    "campaignId": "campaign-reserved",
                    "taskId": "task-reserved",
                    "attemptId": "attempt-reserved",
                    "messageReserved": true
                }
            }
        },
        "error": "e".repeat(9 * 1024 * 1024)
    });
    let rejected = bound_ui_response(rejected).expect("typed refusal must remain frameable");
    assert!(serde_json::to_vec(&rejected).unwrap().len() <= MAX_CAPACITY_ACK_BYTES);
    assert_eq!(rejected["ok"], false);
    assert_eq!(rejected["requestId"], "capacity-rejected-request");
    assert_eq!(
        rejected["payload"]["rejection"]["reservation"]["attemptId"],
        "attempt-reserved"
    );
}
