//! Final response and control-projection byte guards.

use crate::projection::CoreSnapshot;
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;

pub const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_CONTROL_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_CAPACITY_ACK_BYTES: usize = 128 * 1024;
pub const MAX_ERROR_BYTES: usize = 32 * 1024;
pub const MAX_RESULT_METADATA_BYTES: usize = 256 * 1024;
pub const MAX_DISPLAY_BYTES: usize = 16 * 1024;
pub const MAX_WORKSPACE_BYTES: usize = 128 * 1024;

pub fn bound_snapshot(snapshot: &mut CoreSnapshot) -> Result<(), String> {
    bound_snapshot_strings(snapshot);
    let original = collection_counts(snapshot);
    prioritize_control(snapshot);
    while control_size(snapshot)? > MAX_CONTROL_BYTES {
        if pop_optional_control(snapshot) {
            continue;
        }
        // Mandatory control should be far below 2 MiB once display strings are
        // bounded. If a legacy opaque detail still escapes, omit only that
        // display detail and mark the projection explicitly.
        if let Some(stop) = snapshot.stop_responsibility.as_mut()
            && stop.detail.take().is_some()
        {
            snapshot.bounds.truncated = true;
            continue;
        }
        snapshot.bounds.truncated = true;
        snapshot.bounds.projection_unavailable = true;
        break;
    }
    record_omissions(snapshot, &original);
    Ok(())
}

pub fn bound_error(value: &str) -> String {
    bounded_json_string(value, MAX_ERROR_BYTES)
}

pub fn bound_result_metadata(value: Option<Value>) -> (Option<Value>, bool) {
    let Some(value) = value else {
        return (None, false);
    };
    if serde_json::to_vec(&value).is_ok_and(|bytes| bytes.len() <= MAX_RESULT_METADATA_BYTES) {
        return (Some(value), false);
    }
    let keys = [
        "receiptId",
        "choice",
        "required",
        "acknowledged",
        "operationId",
        "attemptId",
        "campaignId",
        "taskId",
        "requestId",
    ];
    let mut bounded = Map::new();
    if let Some(source) = value.as_object() {
        for key in keys {
            if let Some(candidate) = source.get(key) {
                bounded.insert(key.into(), bound_scalar(candidate));
            }
        }
    }
    bounded.insert("resultTruncated".into(), Value::Bool(true));
    (Some(Value::Object(bounded)), true)
}

/// Measure a complete UI response. If an unexpected field defeats the normal
/// budgets, return a fixed-shape acknowledgement that preserves request,
/// mutation and governing safety facts without reclassifying the mutation as a
/// transport failure.
pub fn bound_ui_response(value: Value) -> Result<Value, String> {
    if serde_json::to_vec(&value)
        .map_err(|error| error.to_string())?
        .len()
        <= MAX_RESPONSE_BYTES
    {
        return Ok(value);
    }
    let fallback = capacity_acknowledgement(&value);
    let size = serde_json::to_vec(&fallback)
        .map_err(|error| error.to_string())?
        .len();
    if size > MAX_CAPACITY_ACK_BYTES {
        // The emergency shape contains only validated correlation, operation
        // identities and safety-state scalars. With at most 24 identifiers of
        // 256 bytes it is mathematically below 128 KiB; never turn a committed
        // mutation into a transport failure because an optional display field
        // defeated the richer acknowledgement.
        return Ok(emergency_capacity_acknowledgement(&value));
    }
    Ok(fallback)
}

fn bound_snapshot_strings(snapshot: &mut CoreSnapshot) {
    snapshot.protocol_version = bounded_json_string(&snapshot.protocol_version, 64);
    snapshot.build_id = bounded_json_string(&snapshot.build_id, MAX_DISPLAY_BYTES);
    snapshot.connection = bounded_json_string(&snapshot.connection, MAX_DISPLAY_BYTES);
    if bound_project(&mut snapshot.project) {
        snapshot.bounds.truncated = true;
        snapshot.bounds.projection_unavailable = true;
        snapshot.product_conversation.turn.state = "uncertain".into();
        snapshot.product_conversation.turn.can_stop = false;
        snapshot.product_conversation.turn.can_send = false;
        snapshot.product_conversation.turn.reason = Some(
            "The active workspace path exceeds the projection contract; authoritative control is unavailable."
                .into(),
        );
    }
    for project in &mut snapshot.projects {
        if bound_project(project) {
            snapshot.bounds.truncated = true;
        }
    }
    for campaign in &mut snapshot.campaigns {
        campaign.title = bounded_json_string(&campaign.title, MAX_DISPLAY_BYTES);
        campaign.goal = bounded_json_string(&campaign.goal, MAX_DISPLAY_BYTES);
        campaign.active_task_title =
            bounded_json_string(&campaign.active_task_title, MAX_DISPLAY_BYTES);
        campaign.updated_label = bounded_json_string(&campaign.updated_label, MAX_DISPLAY_BYTES);
    }
    snapshot.active_task.title =
        bounded_json_string(&snapshot.active_task.title, MAX_DISPLAY_BYTES);
    snapshot.active_task.acceptance =
        bounded_json_string(&snapshot.active_task.acceptance, MAX_DISPLAY_BYTES);
    snapshot.attempt.session_label =
        bounded_json_string(&snapshot.attempt.session_label, MAX_DISPLAY_BYTES);
    for runtime in &mut snapshot.runtimes {
        runtime.name = bounded_json_string(&runtime.name, MAX_DISPLAY_BYTES);
        runtime.version = bounded_json_string(&runtime.version, MAX_DISPLAY_BYTES);
        runtime.support = bounded_json_string(&runtime.support, MAX_DISPLAY_BYTES);
        runtime.mode = bounded_json_string(&runtime.mode, MAX_DISPLAY_BYTES);
        runtime.subtitle = bounded_json_string(&runtime.subtitle, MAX_DISPLAY_BYTES);
        runtime.reasons = runtime
            .reasons
            .iter()
            .map(|value| bounded_json_string(value, MAX_DISPLAY_BYTES))
            .collect();
    }
    for decision in &mut snapshot.decisions {
        decision.title = bounded_json_string(&decision.title, MAX_DISPLAY_BYTES);
        decision.kind = bounded_json_string(&decision.kind, MAX_DISPLAY_BYTES);
        decision.recommendation = bounded_json_string(&decision.recommendation, MAX_DISPLAY_BYTES);
        decision.default_behavior =
            bounded_json_string(&decision.default_behavior, MAX_DISPLAY_BYTES);
        decision.facts = decision
            .facts
            .iter()
            .map(|value| bounded_json_string(value, MAX_DISPLAY_BYTES))
            .collect();
    }
    for evidence in &mut snapshot.evidence {
        evidence.claim = bounded_json_string(&evidence.claim, MAX_DISPLAY_BYTES);
        evidence.source = bounded_json_string(&evidence.source, MAX_DISPLAY_BYTES);
        evidence.snapshot = bounded_json_string(&evidence.snapshot, MAX_DISPLAY_BYTES);
    }
    if let Some(stop) = snapshot.stop_responsibility.as_mut() {
        bound_stop(stop);
    }
    for stop in &mut snapshot.related_holds {
        bound_stop(stop);
    }
    snapshot.product_conversation.title =
        bounded_json_string(&snapshot.product_conversation.title, MAX_DISPLAY_BYTES);
    if let Some(reason) = snapshot.product_conversation.turn.reason.as_mut() {
        *reason = bounded_json_string(reason, MAX_DISPLAY_BYTES);
    }
    snapshot.notices = snapshot
        .notices
        .iter()
        .map(|value| bounded_json_string(value, MAX_DISPLAY_BYTES))
        .collect();
}

fn bound_project(project: &mut crate::projection::UiProject) -> bool {
    project.name = bounded_json_string(&project.name, MAX_DISPLAY_BYTES);
    project.color = bounded_json_string(&project.color, MAX_DISPLAY_BYTES);
    if serde_json::to_vec(&project.workspace_root)
        .is_ok_and(|bytes| bytes.len() > MAX_WORKSPACE_BYTES)
    {
        project.workspace_root.clear();
        return true;
    }
    false
}

fn bound_stop(stop: &mut crate::projection::UiStopResponsibility) {
    stop.source = bounded_json_string(&stop.source, MAX_DISPLAY_BYTES);
    stop.workspace_key = bounded_json_string(&stop.workspace_key, MAX_WORKSPACE_BYTES);
    stop.interrupted_at = bounded_json_string(&stop.interrupted_at, MAX_DISPLAY_BYTES);
    stop.task_title = bounded_json_string(&stop.task_title, MAX_DISPLAY_BYTES);
    stop.campaign_goal = bounded_json_string(&stop.campaign_goal, MAX_DISPLAY_BYTES);
    stop.blocked_reason = bounded_json_string(&stop.blocked_reason, MAX_DISPLAY_BYTES);
    if stop.detail.as_ref().is_some_and(|value| {
        serde_json::to_vec(value).is_ok_and(|bytes| bytes.len() > MAX_DISPLAY_BYTES)
    }) {
        stop.detail = Some(json!({ "truncated": true }));
    }
    if stop.latest_recheck.as_ref().is_some_and(|value| {
        serde_json::to_vec(value).is_ok_and(|bytes| bytes.len() > MAX_DISPLAY_BYTES)
    }) {
        stop.latest_recheck = Some(json!({ "truncated": true }));
    }
}

fn prioritize_control(snapshot: &mut CoreSnapshot) {
    let selected_project = snapshot.selected_project_id.clone();
    snapshot
        .projects
        .sort_by_key(|project| project.id != selected_project);
    let active_campaign = snapshot.active_campaign_id.clone();
    snapshot
        .campaigns
        .sort_by_key(|campaign| campaign.id != active_campaign);
    snapshot
        .decisions
        .sort_by_key(|decision| decision.state != "pending");
}

fn pop_optional_control(snapshot: &mut CoreSnapshot) -> bool {
    if !snapshot.notices.is_empty() {
        snapshot.notices.pop();
        snapshot.bounds.truncated = true;
        return true;
    }
    if !snapshot.evidence.is_empty() {
        snapshot.evidence.pop();
        snapshot.bounds.truncated = true;
        return true;
    }
    if snapshot.related_holds.len() > 1 {
        snapshot.related_holds.pop();
        snapshot.bounds.truncated = true;
        return true;
    }
    if snapshot.decisions.len() > 1 {
        snapshot.decisions.pop();
        snapshot.bounds.truncated = true;
        return true;
    }
    if snapshot.campaigns.len() > 1 {
        snapshot.campaigns.pop();
        snapshot.bounds.truncated = true;
        return true;
    }
    if snapshot.projects.len() > 1 {
        snapshot.projects.pop();
        snapshot.bounds.truncated = true;
        return true;
    }
    if snapshot.runtimes.len() > 1 {
        snapshot.runtimes.pop();
        snapshot.bounds.truncated = true;
        return true;
    }
    false
}

fn control_size(snapshot: &CoreSnapshot) -> Result<usize, String> {
    let mut control = snapshot.clone();
    control.timeline.clear();
    control.product_conversation.items.clear();
    serde_json::to_vec(&control)
        .map(|bytes| bytes.len())
        .map_err(|error| error.to_string())
}

fn collection_counts(snapshot: &CoreSnapshot) -> BTreeMap<&'static str, usize> {
    BTreeMap::from([
        ("projects", snapshot.projects.len()),
        ("campaigns", snapshot.campaigns.len()),
        ("runtimes", snapshot.runtimes.len()),
        ("decisions", snapshot.decisions.len()),
        ("evidence", snapshot.evidence.len()),
        ("relatedHolds", snapshot.related_holds.len()),
        ("notices", snapshot.notices.len()),
    ])
}

fn record_omissions(snapshot: &mut CoreSnapshot, original: &BTreeMap<&'static str, usize>) {
    let current = collection_counts(snapshot);
    for (key, count) in original {
        let omitted = count.saturating_sub(*current.get(key).unwrap_or(&0));
        if omitted > 0 {
            snapshot
                .bounds
                .omitted_counts
                .insert((*key).into(), omitted);
        }
    }
}

fn capacity_acknowledgement(source: &Value) -> Value {
    let request_id = exact_id(source.get("requestId").unwrap_or(&Value::Null));
    let entity_version = source.get("entityVersion").cloned().unwrap_or(json!(0));
    let ok = source.get("ok").and_then(Value::as_bool).unwrap_or(true);
    let payload = source.get("payload").cloned().unwrap_or(Value::Null);
    let snapshot = payload.get("snapshot").cloned().unwrap_or(Value::Null);
    let minimal_snapshot = minimal_snapshot(&snapshot);
    let mut minimal_payload = json!({
        "requestId": exact_id(payload.get("requestId").unwrap_or(&request_id)),
        "accepted": payload.get("accepted").cloned().unwrap_or(Value::Bool(ok)),
        "duplicate": payload.get("duplicate").cloned().unwrap_or(Value::Bool(false)),
        "snapshot": minimal_snapshot,
        "capacity": {
            "acknowledged": true,
            "projectionUnavailable": true,
            "message": "The operation result was committed, but the full projection exceeded the response capacity. Load history pages and retry the same request only for reconciliation."
        }
    });
    if let Some(value) = payload.get("reservation") {
        minimal_payload["reservation"] = minimal_reservation(value);
    }
    if let Some(rejection) = payload.get("rejection") {
        minimal_payload["rejection"] = json!({
            "code": bounded_scalar_string(rejection.get("code"), 2048, "capacity"),
            "message": rejection.get("message").and_then(Value::as_str).map(|value| bounded_json_string(value, 8192)),
            "deliveryState": rejection.get("deliveryState").cloned().unwrap_or(json!("UNKNOWN")),
            "nativeDispatchState": rejection.get("nativeDispatchState").cloned().unwrap_or(json!("UNKNOWN")),
            "retryMode": rejection.get("retryMode").cloned().unwrap_or(json!("RECONCILE")),
            "reservation": minimal_reservation(rejection.get("reservation").unwrap_or(&Value::Null))
        });
    }
    if let Some(receipt) = payload.get("receipt") {
        minimal_payload["receipt"] = minimal_receipt(receipt);
    }
    json!({
        "protocolVersion": bounded_scalar_string(source.get("protocolVersion"), 64, "goalport.ipc.v2"),
        "requestId": request_id,
        "entityVersion": entity_version,
        "ok": ok,
        "payload": minimal_payload,
        "error": source.get("error").and_then(Value::as_str).map(|value| bounded_json_string(value, 8192))
    })
}

fn minimal_snapshot(source: &Value) -> Value {
    let product = source
        .get("productConversation")
        .cloned()
        .unwrap_or(Value::Null);
    let active_decision = source
        .get("decisions")
        .and_then(Value::as_array)
        .and_then(|items| {
            items
                .iter()
                .find(|item| item.get("state").and_then(Value::as_str) == Some("pending"))
        })
        .map(minimal_decision);
    json!({
        "protocolVersion": bounded_scalar_string(source.get("protocolVersion"), 64, "goalport.ipc.v2"),
        "buildId": bounded_scalar_string(source.get("buildId"), 2048, ""),
        "connection": bounded_scalar_string(source.get("connection"), 256, "unknown"),
        "projects": [],
        "selectedProjectId": exact_id(path_value(source, &["selectedProjectId"])),
        "project": {
            "id": exact_id(path_value(source, &["project", "id"])),
            "name": bounded_scalar_string(Some(path_value(source, &["project", "name"])), 2048, ""),
            "workspaceRoot": exact_string(path_value(source, &["project", "workspaceRoot"]), 16 * 1024),
            "color": bounded_scalar_string(Some(path_value(source, &["project", "color"])), 512, "")
        },
        "campaigns": [],
        "activeCampaignId": exact_id(path_value(source, &["activeCampaignId"])),
        "activeTask": minimal_task(source.get("activeTask").unwrap_or(&Value::Null)),
        "attempt": minimal_attempt(source.get("attempt").unwrap_or(&Value::Null)),
        "timeline": [],
        "timelinePageInfo": minimal_page_info(source.get("timelinePageInfo")),
        "cursor": source.get("cursor").cloned().unwrap_or(json!(0)),
        "runtimes": [],
        "decisions": active_decision.into_iter().collect::<Vec<_>>(),
        "evidence": [],
        "stopResponsibility": minimal_stop(source.get("stopResponsibility").unwrap_or(&Value::Null)),
        "relatedHolds": [],
        "productConversation": {
            "items": [],
            "pageInfo": minimal_page_info(product.get("pageInfo")),
            "runtime": minimal_runtime(product.get("runtime").unwrap_or(&Value::Null)),
            "turn": {
                "state": "uncertain",
                "canStop": false,
                "canSend": false,
                "reason": "The authoritative control projection is temporarily unavailable because the response exceeded capacity."
            },
            "title": bounded_scalar_string(product.get("title"), 2048, "")
        },
        "preview": source.get("preview").cloned().unwrap_or(Value::Bool(false)),
        "notices": ["Full projection unavailable; existing active and held safety facts must be retained until an authoritative snapshot is loaded."],
        "bounds": {
            "truncated": true,
            "projectionUnavailable": true,
            "omittedCounts": { "controlProjection": 1 }
        }
    })
}

fn emergency_capacity_acknowledgement(source: &Value) -> Value {
    let payload = source.get("payload").unwrap_or(&Value::Null);
    let snapshot = payload.get("snapshot").unwrap_or(&Value::Null);
    let rejection = payload.get("rejection").unwrap_or(&Value::Null);
    json!({
        "protocolVersion": "goalport.ipc.v2",
        "requestId": exact_id(source.get("requestId").unwrap_or(&Value::Null)),
        "entityVersion": source.get("entityVersion").and_then(Value::as_i64).unwrap_or(0),
        "ok": source.get("ok").and_then(Value::as_bool).unwrap_or(true),
        "payload": {
            "requestId": exact_id(payload.get("requestId").unwrap_or(&Value::Null)),
            "accepted": payload.get("accepted").and_then(Value::as_bool).unwrap_or(false),
            "duplicate": payload.get("duplicate").and_then(Value::as_bool).unwrap_or(false),
            "snapshot": {
                "protocolVersion": "goalport.ipc.v2",
                "buildId": "",
                "connection": "unknown",
                "projects": [],
                "selectedProjectId": exact_id(snapshot.get("selectedProjectId").unwrap_or(&Value::Null)),
                "project": { "id": exact_id(path_value(snapshot, &["project","id"])), "name":"", "workspaceRoot": Value::Null, "color":"" },
                "campaigns": [],
                "activeCampaignId": exact_id(snapshot.get("activeCampaignId").unwrap_or(&Value::Null)),
                "activeTask": minimal_task(snapshot.get("activeTask").unwrap_or(&Value::Null)),
                "attempt": minimal_attempt(snapshot.get("attempt").unwrap_or(&Value::Null)),
                "timeline": [], "timelinePageInfo": empty_page_info(), "cursor": 0,
                "runtimes": [],
                "decisions": snapshot.get("decisions").and_then(Value::as_array).and_then(|values| values.iter().find(|value| value.get("state").and_then(Value::as_str)==Some("pending"))).map(minimal_decision).into_iter().collect::<Vec<_>>(),
                "evidence": [],
                "stopResponsibility": minimal_stop(snapshot.get("stopResponsibility").unwrap_or(&Value::Null)),
                "relatedHolds": [],
                "productConversation": { "items":[], "pageInfo":empty_page_info(), "runtime":{"state":"unavailable","provider":"","name":""}, "turn":{"state":"uncertain","canStop":false,"canSend":false,"reason":"Projection unavailable"}, "title":"" },
                "preview": false, "notices":["Projection unavailable"],
                "bounds":{"truncated":true,"projectionUnavailable":true,"omittedCounts":{"controlProjection":1}}
            },
            "rejection": if rejection.is_null() { Value::Null } else { json!({
                "code": bounded_scalar_string(rejection.get("code"), 512, "capacity"),
                "message": "Projection unavailable",
                "deliveryState": bounded_scalar_string(rejection.get("deliveryState"), 64, "UNKNOWN"),
                "nativeDispatchState": bounded_scalar_string(rejection.get("nativeDispatchState"), 64, "UNKNOWN"),
                "retryMode": bounded_scalar_string(rejection.get("retryMode"), 64, "RECONCILE"),
                "reservation": minimal_reservation(rejection.get("reservation").unwrap_or(&Value::Null))
            }) },
            "capacity":{"acknowledged":true,"projectionUnavailable":true,"message":"Projection unavailable"}
        },
        "error": source.get("error").and_then(Value::as_str).map(|value| bounded_json_string(value, 2048))
    })
}

fn minimal_reservation(value: &Value) -> Value {
    if value.is_null() {
        return Value::Null;
    }
    json!({
        "kind": bounded_scalar_string(value.get("kind"), 64, ""),
        "requestId": exact_id(value.get("requestId").unwrap_or(&Value::Null)),
        "campaignId": exact_id(value.get("campaignId").unwrap_or(&Value::Null)),
        "taskId": exact_id(value.get("taskId").unwrap_or(&Value::Null)),
        "attemptId": exact_id(value.get("attemptId").unwrap_or(&Value::Null)),
        "sourceAttemptId": exact_id(value.get("sourceAttemptId").unwrap_or(&Value::Null)),
        "messageReserved": value.get("messageReserved").and_then(Value::as_bool).unwrap_or(false)
    })
}

fn minimal_receipt(value: &Value) -> Value {
    json!({
        "receiptId": exact_id(value.get("receiptId").unwrap_or(&Value::Null)),
        "choice": bounded_scalar_string(value.get("choice"), 2048, ""),
        "required": value.get("required").and_then(Value::as_bool),
        "acknowledged": value.get("acknowledged").and_then(Value::as_bool),
        "operationId": exact_id(value.get("operationId").unwrap_or(&Value::Null)),
        "requestId": exact_id(value.get("requestId").unwrap_or(&Value::Null)),
        "attemptId": exact_id(value.get("attemptId").unwrap_or(&Value::Null)),
        "resultTruncated": true
    })
}

fn minimal_task(value: &Value) -> Value {
    json!({
        "id": exact_id(value.get("id").unwrap_or(&Value::Null)),
        "title": bounded_scalar_string(value.get("title"), 2048, ""),
        "acceptance": bounded_scalar_string(value.get("acceptance"), 4096, ""),
        "state": bounded_scalar_string(value.get("state"), 128, "unknown")
    })
}

fn minimal_attempt(value: &Value) -> Value {
    json!({
        "id": exact_id(value.get("id").unwrap_or(&Value::Null)),
        "taskId": exact_id(value.get("taskId").unwrap_or(&Value::Null)),
        "provider": bounded_scalar_string(value.get("provider"), 256, ""),
        "role": bounded_scalar_string(value.get("role"), 256, ""),
        "state": bounded_scalar_string(value.get("state"), 128, "unknown"),
        "sessionLabel": bounded_scalar_string(value.get("sessionLabel"), 2048, ""),
        "sessionHash": exact_id(value.get("sessionHash").unwrap_or(&Value::Null)),
        "eventCount": value.get("eventCount").and_then(Value::as_u64).unwrap_or(0)
    })
}

fn minimal_decision(value: &Value) -> Value {
    json!({
        "actionKnown": value.get("actionKnown").and_then(Value::as_bool).unwrap_or(false),
        "id": exact_id(value.get("id").unwrap_or(&Value::Null)),
        "title": bounded_scalar_string(value.get("title"), 2048, "Pending decision"),
        "kind": bounded_scalar_string(value.get("kind"), 512, "unknown"),
        "facts": [],
        "recommendation": "",
        "defaultBehavior": "Keep waiting; no approval is sent.",
        "state": bounded_scalar_string(value.get("state"), 128, "pending")
    })
}

fn minimal_stop(value: &Value) -> Value {
    if value.is_null() {
        return Value::Null;
    }
    json!({
        "attemptId": exact_id(value.get("attemptId").unwrap_or(&Value::Null)),
        "operationId": exact_id(value.get("operationId").unwrap_or(&Value::Null)),
        "provider": bounded_scalar_string(value.get("provider"), 256, ""),
        "nativeTurnState": bounded_scalar_string(value.get("nativeTurnState"), 128, "unknown"),
        "residualExecutionState": bounded_scalar_string(value.get("residualExecutionState"), 128, "unknown"),
        "writeResponsibility": bounded_scalar_string(value.get("writeResponsibility"), 128, "held"),
        "inputUuid": exact_id(value.get("inputUuid").unwrap_or(&Value::Null)),
        "sessionHash": exact_id(value.get("sessionHash").unwrap_or(&Value::Null)),
        "turnEpoch": value.get("turnEpoch").and_then(Value::as_u64).unwrap_or(0),
        "processEpoch": exact_id(value.get("processEpoch").unwrap_or(&Value::Null)),
        "source": bounded_scalar_string(value.get("source"), 1024, ""),
        "detail": Value::Null,
        "workspaceKey": exact_string(value.get("workspaceKey").unwrap_or(&Value::Null), 16 * 1024),
        "interruptedAt": bounded_scalar_string(value.get("interruptedAt"), 1024, ""),
        "taskTitle": bounded_scalar_string(value.get("taskTitle"), 2048, ""),
        "campaignGoal": bounded_scalar_string(value.get("campaignGoal"), 2048, ""),
        "blockedReason": bounded_scalar_string(value.get("blockedReason"), 4096, "Control state unavailable; retain the hold."),
        "blocksCurrentWorkspace": value.get("blocksCurrentWorkspace").and_then(Value::as_bool).unwrap_or(true),
        "latestRecheck": Value::Null
    })
}

fn minimal_runtime(value: &Value) -> Value {
    json!({
        "state": bounded_scalar_string(value.get("state"), 128, "unavailable"),
        "provider": bounded_scalar_string(value.get("provider"), 256, ""),
        "name": bounded_scalar_string(value.get("name"), 2048, "")
    })
}

fn minimal_page_info(value: Option<&Value>) -> Value {
    let Some(value) = value else {
        return empty_page_info();
    };
    json!({
        "olderCursor": exact_string(value.get("olderCursor").unwrap_or(&Value::Null), 2048),
        "newerCursor": exact_string(value.get("newerCursor").unwrap_or(&Value::Null), 2048),
        "hasOlder": value.get("hasOlder").and_then(Value::as_bool).unwrap_or(true),
        "hasNewer": value.get("hasNewer").and_then(Value::as_bool).unwrap_or(true),
        "contentBytes": value.get("contentBytes").and_then(Value::as_u64).unwrap_or(2),
        "itemCount": 0
    })
}

fn exact_id(value: &Value) -> Value {
    match value.as_str() {
        Some(text) if text.as_bytes().len() <= 256 => Value::String(text.to_owned()),
        _ => Value::Null,
    }
}

fn exact_string(value: &Value, max_serialized_bytes: usize) -> Value {
    match value.as_str() {
        Some(text)
            if serde_json::to_vec(text).is_ok_and(|bytes| bytes.len() <= max_serialized_bytes) =>
        {
            Value::String(text.to_owned())
        }
        _ => Value::Null,
    }
}

fn bounded_scalar_string(value: Option<&Value>, max_bytes: usize, fallback: &str) -> Value {
    Value::String(
        value
            .and_then(Value::as_str)
            .map(|text| bounded_json_string(text, max_bytes))
            .unwrap_or_else(|| fallback.to_owned()),
    )
}

fn path_value<'a>(source: &'a Value, path: &[&str]) -> &'a Value {
    let mut current = source;
    for segment in path {
        current = current.get(*segment).unwrap_or(&Value::Null);
    }
    current
}

fn empty_page_info() -> Value {
    json!({
        "olderCursor": Value::Null,
        "newerCursor": Value::Null,
        "hasOlder": true,
        "hasNewer": true,
        "contentBytes": 2,
        "itemCount": 0
    })
}

fn bound_scalar(value: &Value) -> Value {
    match value {
        Value::String(text) => Value::String(bounded_json_string(text, MAX_DISPLAY_BYTES)),
        Value::Bool(_) | Value::Number(_) | Value::Null => value.clone(),
        _ => Value::Null,
    }
}

fn bounded_json_string(value: &str, max_bytes: usize) -> String {
    if serde_json::to_vec(value).is_ok_and(|bytes| bytes.len() <= max_bytes) {
        return value.to_owned();
    }
    let mut out = String::new();
    for character in value.chars() {
        out.push(character);
        if serde_json::to_vec(&out).is_ok_and(|bytes| bytes.len() > max_bytes) {
            out.pop();
            break;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_error_accounts_for_json_escaping() {
        let bounded = bound_error(&"\\\"\n".repeat(100_000));
        assert!(serde_json::to_vec(&bounded).unwrap().len() <= MAX_ERROR_BYTES);
    }
}
