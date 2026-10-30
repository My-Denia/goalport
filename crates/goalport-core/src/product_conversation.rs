//! Bounded product conversation projection (plan `product-interaction-reset` R1–R3).
//!
//! This is the product read model: an independent, allowlisted projection of the
//! durable `EventRecord` journal — never a projection of `TimelineItem` cards.
//! The raw timeline / debug ledger stays exactly as it is; this module only
//! reads. Three rules are load-bearing:
//!
//! 1. **Allowlist, no fallbacks.** Only proven event kinds become product items.
//!    An unknown event never falls back to `message`-shaped content; it simply
//!    does not appear here (it remains in the raw timeline).
//! 2. **No generated content.** No runtime reply is invented, no action is
//!    guessed, no timestamp is synthesized — item bodies come from durable
//!    provider-authored payloads and timestamps from durable commit stamps.
//!    Internal metadata identifiers (attempt/campaign ids) stay internal.
//! 3. **Fail-closed turn state.** The turn model is derived from live Runtime
//!    turn facts, correlated lifecycle and stop holds — never from
//!    `Attempt.active`. Held/uncertain wins over routability; a disconnected
//!    registration never pretends to be executing.
//!
//! Permission decisions are deliberately NOT items: they stay first-class inline
//! content through `snapshot.decisions`, which the renderer already renders.

use crate::{
    domain::{Attempt, AttemptState, DecisionState},
    history::HistoryPageInfo,
    provider_failure::ProviderFailure,
    runtime_manager::{CodexTransportKind, RuntimeManager},
    store::{ConversationPreference, EventRecord, StopResponsibility, Store},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;

/// The additive product snapshot member (camelCase wire contract).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductConversation {
    pub items: Vec<ProductConversationItem>,
    pub page_info: HistoryPageInfo,
    pub runtime: ProductRuntimeSelection,
    pub session: ProductSession,
    pub turn: ProductTurn,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_summary: Option<String>,
    /// What the agent is doing right now, while a tool is still running.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_step: Option<String>,
    /// Additive beyond the packet's minimum wire shape: the deterministic
    /// product title (rename > first prompt, normalized to the first 44 Unicode
    /// characters > root task title). The sidebar needs it from Core.
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductConversationItem {
    pub id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub logical_item_id: String,
    #[serde(default)]
    pub fragment_index: usize,
    #[serde(default)]
    pub continues_before: bool,
    #[serde(default)]
    pub continues_after: bool,
    /// `user-message` | `assistant-message` | `activity-summary` |
    /// `actionable-error` | `handoff-summary`.
    pub kind: String,
    pub body: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<String>,
    /// Only proven actions. No event kind in the allowlist carries a proven
    /// action vocabulary today, so this is always `None` — the field exists so
    /// the wire contract does not have to change when one does.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actions: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub technical_details: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductRuntimeSelection {
    /// `none` | `selected` | `unavailable`.
    pub state: String,
    pub provider: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductSession {
    /// `attached` | `detached` | `unavailable` | `none`.
    pub state: String,
    pub native_id_known: bool,
    #[serde(default)]
    pub transport: ProductSessionTransport,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProductSessionTransport {
    AppServer,
    Exec,
    #[default]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductTurn {
    /// `idle` | `starting` | `running` | `waiting-permission` | `stopping` |
    /// `stopped` | `completed` | `failed` | `uncertain`.
    pub state: String,
    pub can_stop: bool,
    pub can_send: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason_code: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub actions: Vec<String>,
}

/// Everything the projection needs from the controller context: which campaign
/// is on screen, which attempt is selected, its workspace, and the root task
/// title (the title fallback for conversations that predate preferences).
pub struct ProductConversationContext<'a> {
    pub campaign_id: &'a str,
    pub attempt: &'a Attempt,
    pub workspace_root: &'a str,
    pub root_task_title: &'a str,
}

const TITLE_MAX_CHARS: usize = 44;

/// Build the product conversation for one campaign. Read-only against the
/// store; `runtime_manager` is borrowed mutably because liveness observation
/// (`registration_live`) updates memoized process facts.
pub fn product_conversation(
    store: &Store,
    runtime_manager: &mut RuntimeManager,
    context: &ProductConversationContext<'_>,
    items: Vec<ProductConversationItem>,
    first_user_message: Option<&str>,
    page_info: HistoryPageInfo,
) -> Result<ProductConversation, String> {
    let preference = store
        .conversation_preference(context.campaign_id)
        .map_err(|error| error.to_string())?;
    let title = effective_title(&preference, first_user_message, context.root_task_title);
    let runtime = project_runtime(store, runtime_manager, context, &preference)?;
    let session = ProductSession {
        state: if runtime.state == "selected" {
            "attached"
        } else if runtime.state == "starting" {
            "starting"
        } else if runtime_manager.registered_binding(&context.attempt.id).is_some() {
            "unavailable"
        } else if store
            .latest_event_kind_in(&context.attempt.id, &["runtime.session.closed"])
            .map_err(|error| error.to_string())?
            .is_some()
        {
            "closed"
        } else if context.attempt.provider_session.is_some() {
            "detached"
        } else {
            "none"
        }
        .into(),
        native_id_known: context.attempt.provider_session.is_some(),
        transport: match runtime_manager.codex_transport(&context.attempt.id) {
            Some(CodexTransportKind::AppServer) => ProductSessionTransport::AppServer,
            Some(CodexTransportKind::Exec) => ProductSessionTransport::Exec,
            None => ProductSessionTransport::Unknown,
        },
    };
    let mut turn = project_turn(store, runtime_manager, context, &runtime)?;
    describe_turn(store, runtime_manager, context, &runtime, &session, &mut turn)?;
    if turn.can_send && !campaign_send_authorized(store, context.campaign_id)? {
        turn.can_send = false;
        turn.reason = Some("Sending is blocked because this conversation's permission to use the Runtime or perform actions was revoked.".into());
        turn.reason_code = Some("authorization-revoked".into());
        turn.actions.retain(|action| action != "send");
    }
    let result_summary = if turn.state == "completed" {
        store
            .latest_completed_turn_reply(&context.attempt.id)
            .map_err(|error| error.to_string())?
    } else {
        None
    };
    let current_step = if turn.can_stop && turn.state == "running" {
        store
            .latest_turn_tool_activity(&context.attempt.id)
            .map_err(|error| error.to_string())?
            .as_ref()
            .and_then(running_step)
    } else {
        None
    };
    Ok(ProductConversation {
        items,
        page_info,
        runtime,
        session,
        turn,
        result_summary,
        current_step,
        title,
    })
}

/// The deterministic product title: an explicit rename wins; otherwise the
/// first user message whitespace-normalized to its first 44 Unicode characters;
/// otherwise the existing root task title. Nothing is rewritten to compute it.
fn effective_title(
    preference: &Option<ConversationPreference>,
    first_user_message: Option<&str>,
    root_task_title: &str,
) -> String {
    if let Some(title) = preference
        .as_ref()
        .and_then(|row| row.title.as_deref())
        .filter(|title| !title.trim().is_empty())
    {
        return title.trim().to_owned();
    }
    if let Some(prompt) = first_user_message {
        let normalized: String = prompt.split_whitespace().collect::<Vec<_>>().join(" ");
        let bounded: String = normalized.chars().take(TITLE_MAX_CHARS).collect();
        if !bounded.is_empty() {
            return bounded;
        }
    }
    root_task_title.trim().to_owned()
}

/// Allowlist projection of the campaign journal. Consecutive provider reply
/// deltas of one attempt are aggregated into a single assistant message (the
/// proven runtime reply body); everything not in the allowlist is skipped.
pub(crate) fn project_items(records: &[EventRecord]) -> Vec<ProductConversationItem> {
    let mut items = Vec::new();
    let mut pending_reply: Option<ProductConversationItem> = None;
    let mut pending_item_id: Option<String> = None;
    let mut reply_attempt = String::new();
    let mut seen_handoff_operations = HashSet::new();
    for record in records {
        let payload = record.payload.as_ref();
        let text_of = |key: &str| {
            payload
                .and_then(|value| value.get(key))
                .and_then(Value::as_str)
                .map(str::to_owned)
        };
        // Diagnostic frames/bookkeeping interleaved with deltas are not new
        // messages. Only semantic boundaries (or another attempt) split replies.
        let boundary = matches!(
            record.event.kind.as_str(),
            "message.user"
                | "runtime.tool.activity"
                | "runtime.turn.started"
                | "runtime.turn.completed"
                | "runtime.turn.cancelled"
                | "runtime.turn.failed"
                | "runtime.send.failed"
                | "runtime.transport.closed"
                | "handoff.completed"
        );
        if boundary || (!reply_attempt.is_empty() && reply_attempt != record.event.attempt_id) {
            if let Some(reply) = pending_reply.take() {
                items.push(reply);
            }
            pending_item_id = None;
        }
        match record.event.kind.as_str() {
            "message.user" => {
                if payload
                    .and_then(|value| value.get("origin"))
                    .and_then(Value::as_str)
                    == Some("generated-handoff")
                {
                    continue;
                }
                let Some(text) = text_of("text") else {
                    continue;
                };
                if text.trim().is_empty() {
                    continue;
                }
                items.push(ProductConversationItem {
                    id: record.event.id.clone(),
                    logical_item_id: record.event.id.clone(),
                    fragment_index: 0,
                    continues_before: false,
                    continues_after: false,
                    kind: "user-message".into(),
                    body: text,
                    actor: Some("user".into()),
                    timestamp: Some(record.created_at.clone()),
                    actions: None,
                    technical_details: None,
                });
            }
            "runtime.reply.delta" => {
                let Some(delta) = text_of("text") else {
                    continue;
                };
                if delta.trim().is_empty() {
                    continue;
                }
                let item_id = text_of("itemId").filter(|item_id| !item_id.is_empty());
                let completed = text_of("status").as_deref() == Some("completed");
                if pending_reply.is_some() && item_id.is_some() && pending_item_id.as_ref() != item_id.as_ref() {
                    if let Some(reply) = pending_reply.take() {
                        items.push(reply);
                    }
                    pending_item_id = None;
                }
                match pending_reply.as_mut() {
                    // A completed provider item carries the whole message.
                    // Appending it after that item's deltas would show the reply twice.
                    Some(reply) if completed && item_id.is_some() => {
                        reply.body = delta;
                    }
                    Some(reply) => reply.body.push_str(&delta),
                    None => {
                        reply_attempt = record.event.attempt_id.clone();
                        pending_item_id = item_id.clone();
                        pending_reply = Some(ProductConversationItem {
                            id: record.event.id.clone(),
                            logical_item_id: item_id.clone().unwrap_or_else(|| record.event.id.clone()),
                            fragment_index: 0,
                            continues_before: false,
                            continues_after: false,
                            kind: "assistant-message".into(),
                            body: delta,
                            actor: None,
                            timestamp: Some(record.created_at.clone()),
                            actions: None,
                            technical_details: None,
                        });
                    }
                }
                if completed && item_id.is_some() {
                    if let Some(reply) = pending_reply.take() {
                        items.push(reply);
                    }
                    pending_item_id = None;
                }
            }
            "runtime.tool.activity" => {
                let Some(tool) = text_of("tool") else {
                    continue;
                };
                if tool.trim().is_empty() {
                    continue;
                }
                let status = text_of("status").unwrap_or_default();
                // Records project one at a time, so a start cannot be paired
                // with its finish here. The finished line is the one that counts.
                if status == "started" {
                    continue;
                }
                let body = activity_sentence(&text_of("toolName").unwrap_or(tool), &status, payload);
                items.push(ProductConversationItem {
                    id: record.event.id.clone(),
                    logical_item_id: record.event.id.clone(),
                    fragment_index: 0,
                    continues_before: false,
                    continues_after: false,
                    kind: "activity-summary".into(),
                    body,
                    actor: None,
                    timestamp: Some(record.created_at.clone()),
                    actions: None,
                    technical_details: None,
                });
            }
            "runtime.turn.failed"
            | "runtime.send.failed"
            | "attempt.admission.failed"
            | "runtime.transport.closed" => {
                let technical_body = text_of("text").or_else(|| text_of("error"));
                let reason_code = payload
                    .and_then(|value| value.get("reasonCode"))
                    .and_then(Value::as_str);
                let body = if let Some(reason_code) = reason_code {
                    provider_issue_message(reason_code)
                } else {
                    match record.event.kind.as_str() {
                    "runtime.send.failed" => "Message delivery could not be completed. Check the connection and Technical details before sending anything again.",
                    "attempt.admission.failed" => "The selected Runtime could not be started. Review Technical details or choose another Runtime.",
                    "runtime.transport.closed" => "The Runtime connection closed. Review the session status before continuing.",
                    _ => "The Runtime could not finish this response. Review Technical details before continuing.",
                    }
                }
                .to_owned();
                if body.trim().is_empty() {
                    continue;
                }
                let mut technical = serde_json::Map::new();
                technical.insert("eventKind".into(), Value::String(record.event.kind.clone()));
                if let Some(text) = technical_body {
                    technical.insert("message".into(), Value::String(text));
                }
                if let Some(reason) = text_of("reason") {
                    technical.insert("reason".into(), Value::String(reason));
                }
                if let Some(retry) = payload.and_then(|value| value.get("retry")) {
                    technical.insert("retry".into(), retry.clone());
                }
                if let Some(reason_code) = reason_code {
                    technical.insert("reasonCode".into(), Value::String(reason_code.into()));
                }
                items.push(ProductConversationItem {
                    id: record.event.id.clone(),
                    logical_item_id: record.event.id.clone(),
                    fragment_index: 0,
                    continues_before: false,
                    continues_after: false,
                    kind: "actionable-error".into(),
                    body,
                    actor: None,
                    timestamp: Some(record.created_at.clone()),
                    actions: Some(vec!["diagnose".into()]),
                    technical_details: Some(Value::Object(technical).to_string()),
                });
            }
            "handoff.completed" => {
                let summary_side = payload
                    .and_then(|value| value.get("summarySide"))
                    .and_then(Value::as_str);
                let historical_source = payload
                    .and_then(|value| value.pointer("/oldAttempt/id"))
                    .and_then(Value::as_str)
                    == Some(record.event.attempt_id.as_str());
                if summary_side.is_some_and(|side| side != "source")
                    || (summary_side.is_none() && !historical_source)
                {
                    continue;
                }
                let provider = payload
                    .and_then(|value| value.get("newAttempt"))
                    .and_then(|value| value.get("provider"))
                    .and_then(Value::as_str)
                    .unwrap_or("another Runtime");
                let logical_item_id = payload
                    .and_then(|value| value.get("handoffId"))
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .or_else(|| {
                        payload
                            .and_then(|value| value.pointer("/authorization/requestHash"))
                            .and_then(Value::as_str)
                            .map(|hash| format!("handoff-{hash}"))
                    })
                    .unwrap_or_else(|| record.event.id.clone());
                if !seen_handoff_operations.insert(logical_item_id.clone()) {
                    continue;
                }
                items.push(ProductConversationItem {
                    id: record.event.id.clone(),
                    logical_item_id,
                    fragment_index: 0,
                    continues_before: false,
                    continues_after: false,
                    kind: "handoff-summary".into(),
                    body: format!("Handed off to {provider}"),
                    actor: None,
                    timestamp: Some(record.created_at.clone()),
                    actions: None,
                    technical_details: None,
                });
            }
            // Everything else — lifecycle, sessions, permissions (they stay in
            // snapshot.decisions), raw protocol frames, unknown events — is
            // deliberately NOT product content. No fallback mapping exists.
            _ => {}
        }
    }
    if let Some(reply) = pending_reply.take() {
        if !reply.body.trim().is_empty() {
            items.push(reply);
        }
    }
    items
        .into_iter()
        .filter(|item| !item.body.trim().is_empty())
        .collect()
}

/// What the user would have typed: agents wrap commands in their shell.
fn inside_shell(command: &str) -> &str {
    let (program, rest) = match command.strip_prefix('"') {
        Some(quoted) => match quoted.split_once('"') {
            Some(parts) => parts,
            None => return command,
        },
        None => match command.split_once(char::is_whitespace) {
            Some(parts) => parts,
            None => return command,
        },
    };
    let name = program.rsplit(['/', '\\']).next().unwrap_or(program).to_ascii_lowercase();
    let name = name.strip_suffix(".exe").unwrap_or(&name);
    if !matches!(name, "pwsh" | "powershell" | "cmd" | "bash" | "sh" | "zsh") {
        return command;
    }
    let mut rest = rest.trim_start();
    while let Some(flag) = rest.split_whitespace().next().filter(|word| word.starts_with('-') || word.starts_with('/')) {
        rest = rest[flag.len()..].trim_start();
        let lower = flag.to_ascii_lowercase();
        if matches!(lower.as_str(), "-command" | "-c" | "-lc" | "/c") {
            let inner = rest.trim_matches(['"', '\'']).trim();
            return if inner.is_empty() { command } else { inner };
        }
    }
    command
}

/// The first statement that does something; agents open with `cd` and the like.
fn main_statement(command: &str) -> &str {
    command
        .split("; ")
        .flat_map(|part| part.split(" && "))
        .map(str::trim)
        .find(|part| {
            let lower = part.to_ascii_lowercase();
            !part.is_empty()
                && !part.starts_with('$')
                && !["cd ", "set-location", "get-location", "pwd"].iter().any(|noise| lower.starts_with(noise))
        })
        .unwrap_or(command)
}

/// A step still in progress, or nothing once the newest tool event has ended.
fn running_step(payload: &Value) -> Option<String> {
    if payload.get("status").and_then(Value::as_str) != Some("started") {
        return None;
    }
    let tool = payload.get("toolName").or_else(|| payload.get("tool")).and_then(Value::as_str)?;
    let done = activity_sentence(tool, "completed", Some(payload));
    Some(match done.strip_prefix("Ran ") {
        Some(rest) => format!("Running {rest}"),
        None => match done.strip_prefix("Changed ") {
            Some(rest) => format!("Changing {rest}"),
            None => format!("{done}…"),
        },
    })
}

/// The list under Files changed has the full path; a step only needs the name.
fn short_path(path: &str) -> &str {
    let absolute = path.starts_with('/') || path.as_bytes().get(1) == Some(&b':');
    if absolute {
        path.rsplit(['/', '\\']).next().unwrap_or(path)
    } else {
        path
    }
}

/// One step in the words a person would use. Providers name these after their
/// own protocol (`commandExecution`, `Bash`), which means nothing on screen.
fn activity_sentence(tool: &str, status: &str, payload: Option<&Value>) -> String {
    const COMMAND_LIMIT: usize = 80;
    let exit_code = payload.and_then(|value| value.get("exitCode")).and_then(Value::as_i64);
    let failed = status.contains("fail") || status.contains("error") || exit_code.is_some_and(|code| code != 0);
    if let Some(command) = payload
        .and_then(|value| value.get("command"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|command| !command.is_empty())
    {
        let whole = inside_shell(command);
        let part = main_statement(whole);
        let first_line = part.lines().next().unwrap_or(part);
        let mut shown: String = first_line.chars().take(COMMAND_LIMIT).collect();
        if shown.len() < whole.len() {
            shown.push('…');
        }
        return if failed { format!("Failed: {shown}") } else { format!("Ran {shown}") };
    }
    let mut paths: Vec<&str> = payload
        .and_then(|value| value.get("paths"))
        .and_then(Value::as_array)
        .map(|paths| paths.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    paths.extend(payload.and_then(|value| value.get("path")).and_then(Value::as_str));
    let lower = tool.to_ascii_lowercase();
    let action = if lower.contains("command") || lower == "bash" || lower.contains("shell") {
        "Ran a command".to_owned()
    } else if lower.contains("filechange") || lower.contains("edit") || lower.contains("write") {
        match paths.as_slice() {
            [] => "Changed files".to_owned(),
            [path] => format!("Changed {}", short_path(path)),
            [path, rest @ ..] => format!("Changed {} and {} more", short_path(path), rest.len()),
        }
    } else if lower == "read" {
        paths.first().map_or_else(|| "Read a file".to_owned(), |path| format!("Read {}", short_path(path)))
    } else if lower == "grep" || lower == "glob" || lower == "ls" {
        "Searched the workspace".to_owned()
    } else if lower.contains("web") {
        "Looked something up online".to_owned()
    } else if lower == "task" || lower == "agent" {
        "Asked a helper agent".to_owned()
    } else if lower.contains("toolcall") || lower == "native-tool" || lower == "tool_result" {
        "Used a tool".to_owned()
    } else {
        format!("Used {tool}")
    };
    if failed { format!("Failed: {action}") } else { action }
}

fn provider_issue_message(reason_code: &str) -> &'static str {
    // The closed typed mapping owns the copy (AGENTS.md §3 prerequisite);
    // unknown codes degrade to the generic failure, never a guessed
    // specialty.
    crate::provider_failure::ProviderFailure::parse(reason_code).message()
}

fn describe_turn(
    store: &Store,
    runtime_manager: &mut RuntimeManager,
    context: &ProductConversationContext<'_>,
    runtime: &ProductRuntimeSelection,
    session: &ProductSession,
    turn: &mut ProductTurn,
) -> Result<(), String> {
    let latest = store
        .latest_event_record_in(
            &context.attempt.id,
            &[
                "runtime.turn.started",
                "runtime.turn.completed",
                "runtime.turn.failed",
                "runtime.turn.cancelled",
            ],
        )
        .map_err(|error| error.to_string())?;
    if let Some(record) = latest
        && record.event.kind == "runtime.turn.failed"
        && matches!(turn.state.as_str(), "idle" | "failed")
    {
        let failure = record
            .payload
            .as_ref()
            .and_then(|payload| payload.get("reasonCode"))
            .and_then(Value::as_str)
            .map(ProviderFailure::parse)
            .unwrap_or(ProviderFailure::Failed);
        let code = failure.as_str();
        turn.reason_code = Some(code.into());
        turn.reason = Some(provider_issue_message(code).into());
        if turn.state == "idle" {
            turn.state = "failed".into();
            turn.can_send = runtime.state == "selected";
        }
    }
    if turn.reason_code.is_none() {
        turn.reason_code = match turn.state.as_str() {
            "uncertain" => Some(if turn.reason.as_deref().is_some_and(|reason| reason.contains("delivery")) {
                ProviderFailure::DeliveryUnknown.as_str()
            } else {
                "recovery-required"
            }),
            "waiting-permission" => Some("permission-pending"),
            "starting" => Some("turn-starting"),
            "stopping" => Some("stop-pending"),
            _ => None,
        }
        .map(str::to_owned);
    }
    if turn.can_send {
        turn.actions.push("send".into());
    }
    if turn.can_stop {
        turn.actions.push("stop".into());
    }
    // Merge-review P2: a spawn-only pending-resume successor (claude, QUEUED,
    // never activated, still unverified) must not offer Close — closing it
    // would leave the task's latest attempt closed with no session and no
    // retry marker. Close returns once the resume verifies (activation).
    let unverified_pending_resume = context.attempt.provider.eq_ignore_ascii_case("claude")
        && matches!(context.attempt.state, AttemptState::Queued)
        && context.attempt.provider_session.is_none()
        && matches!(
            store.closed_claude_successor_source(&context.attempt.id),
            Ok(Some(_))
        );
    if session.state == "attached"
        && matches!(turn.state.as_str(), "idle" | "completed" | "failed" | "stopped")
        && !unverified_pending_resume
    {
        turn.actions.push("close-session".into());
    }
    if !turn.can_send && !turn.can_stop && turn.reason.is_some() {
        let retained = runtime_manager.registered_binding(&context.attempt.id).is_some();
        let settled = matches!(turn.state.as_str(), "idle" | "completed" | "failed" | "stopped");
        let no_unsettled_effect = store
            .unsettled_commands_for_attempt(&context.attempt.id)
            .map_err(|error| error.to_string())?
            .is_empty()
            && store
                .outbox_for_attempt(&context.attempt.id)
                .map_err(|error| error.to_string())?
                .iter()
                .all(|item| item.state == crate::domain::OutboxState::Succeeded)
            && !store
                .decisions_for_attempt(&context.attempt.id, 1)
                .map_err(|error| error.to_string())?
                .iter()
                .any(|decision| decision.state == DecisionState::Pending);
        let exited = retained
            && matches!(
                runtime_manager.confirm_process_identity(&context.attempt.id),
                Some(crate::runtime_manager::ProcessConfirmation::Exited { .. })
            );
        let unproven_successor = matches!(context.attempt.state, AttemptState::Queued)
            && context.attempt.provider.eq_ignore_ascii_case("claude")
            && context.attempt.provider_session.is_none()
            && matches!(
                store.closed_claude_successor_source(&context.attempt.id),
                Ok(Some(_))
            )
            && !matches!(
                store.resume_retry_generation_dead(&context.attempt.id),
                Ok(true)
            );
        let action = if unproven_successor {
            turn.reason_code = Some("resume-containment-unproven".into());
            turn.reason = Some(
                "This resume is not proven contained. It cannot be closed, retried, or replaced until containment is proven."
                    .into(),
            );
            "diagnose"
        } else if session.state == "unavailable"
            && exited
            && settled
            && no_unsettled_effect
        {
            turn.reason_code = Some(ProviderFailure::Exited.as_str().into());
            turn.reason = Some("The Runtime process ended. Close this session before starting new work; its history remains here.".into());
            "close-session"
        } else if turn.state == "uncertain" {
            "diagnose"
        } else if session.state == "closed"
            && context.attempt.state == AttemptState::Closed
            && (context.attempt.provider.eq_ignore_ascii_case("claude")
                || context.attempt.provider.eq_ignore_ascii_case("codex"))
            && session.native_id_known
            && settled
            && no_unsettled_effect
            && store
                .attempts_for_task(&context.attempt.task_id)
                .map_err(|error| error.to_string())?
                .last()
                .is_some_and(|latest| latest.id == context.attempt.id)
        {
            turn.reason_code = Some("session-closed".into());
            turn.reason = Some(
                "Resume this session to continue. Earlier messages will not be sent again."
                    .into(),
            );
            "resume-session"
        } else if !retained
            && session.native_id_known
            && !context.attempt.state.is_terminal()
            && settled
            && no_unsettled_effect
        {
            turn.reason_code = Some("session-detached".into());
            turn.reason = Some("Resume this session to continue. Earlier messages will not be sent again.".into());
            "resume-session"
        } else if matches!(context.attempt.state, AttemptState::Queued)
            && context.attempt.provider.eq_ignore_ascii_case("claude")
            && context.attempt.provider_session.is_none()
            && runtime_manager
                .registered_binding(&context.attempt.id)
                .is_none()
            && matches!(
                store.resume_retry_generation_dead(&context.attempt.id),
                Ok(true)
            )
            && {
                // Merge-review P1: a successor whose first-send resume
                // verification failed offers the deterministic retry instead
                // of a dead composer with no way out. Precedes the plain
                // Queued arm (which would offer a FRESH session) and carries
                // no settled/no_unsettled_effect gate: the crossed send's
                // outbox item is UNKNOWN, not Succeeded.
                match store.closed_claude_successor_source(&context.attempt.id) {
                    Ok(Some(source_id)) => store
                        .get_attempt(&source_id)
                        .map(|source| {
                            source.state == AttemptState::Closed
                                && source
                                    .provider_session
                                    .as_deref()
                                    .is_some_and(|id| !id.trim().is_empty())
                        })
                        .unwrap_or(false),
                    Ok(None) => false,
                    Err(_) => false,
                }
            }
        {
            turn.reason_code = Some(ProviderFailure::ResumeVerificationFailed.as_str().into());
            turn.reason = Some(
                "The last resume failed to start or did not verify the stored session id. Resume to try again; earlier messages will not be sent again."
                    .into(),
            );
            "resume-session"
        } else if matches!(context.attempt.state, AttemptState::Queued)
            && context.attempt.provider.eq_ignore_ascii_case("claude")
            && context.attempt.provider_session.is_none()
            && matches!(
                store.closed_claude_successor_source(&context.attempt.id),
                Ok(Some(_))
            )
            && !matches!(
                store.resume_retry_generation_dead(&context.attempt.id),
                Ok(true)
            )
        {
            // Marker absent: do not offer retry or a fresh session, whether
            // the registration is still held or was lost to a restart.
            turn.reason_code = Some("resume-containment-unproven".into());
            turn.reason = Some(
                "This resume is not proven contained. It cannot be retried or replaced until containment is proven."
                    .into(),
            );
            "diagnose"
        } else if !retained
            && matches!(context.attempt.state, AttemptState::Queued)
            && no_unsettled_effect
        {
            "select-runtime"
        } else {
            "diagnose"
        };
        if !turn.actions.iter().any(|existing| existing == action) {
            turn.actions.push(action.into());
        }
    }
    Ok(())
}

fn provider_display_name(provider: &str) -> String {
    match provider.to_ascii_lowercase().as_str() {
        "codex" => "Codex".into(),
        "claude" => "Claude Code".into(),
        "grok" => "Grok".into(),
        "scenario" => "Scenario Runtime".into(),
        other => other.to_owned(),
    }
}

/// Selected-Runtime preference, independent of any live turn:
/// - `none`: no persisted preference row / no selected provider;
/// - `selected`: a preference exists AND the campaign's current attempt has a
///   live, usable registration of exactly that provider;
/// - `unavailable`: a preference exists (it survives cancelled/failed attempts
///   and restarts) but there is no live registration to serve it. Ambiguous or
///   missing bindings are unavailable, never inferred runnable.
fn project_runtime(
    _store: &Store,
    runtime_manager: &mut RuntimeManager,
    context: &ProductConversationContext<'_>,
    preference: &Option<ConversationPreference>,
) -> Result<ProductRuntimeSelection, String> {
    if runtime_manager.operation_busy(&context.attempt.id) {
        let provider = context.attempt.provider.clone();
        return Ok(ProductRuntimeSelection {
            state: "starting".into(),
            name: provider_display_name(&provider),
            provider,
        });
    }
    let Some(selected) = preference
        .as_ref()
        .and_then(|row| row.selected_provider.clone())
        .filter(|provider| !provider.trim().is_empty())
    else {
        return Ok(ProductRuntimeSelection {
            state: "none".into(),
            provider: String::new(),
            name: String::new(),
        });
    };
    let registered = runtime_manager
        .selected_provider(&context.attempt.id)
        .map(str::to_owned);
    let live = runtime_manager.registration_live(&context.attempt.id) == Some(true);
    let state = if registered.as_deref() == Some(selected.to_ascii_lowercase().as_str()) && live {
        "selected"
    } else {
        "unavailable"
    };
    Ok(ProductRuntimeSelection {
        state: state.into(),
        provider: selected.clone(),
        name: provider_display_name(&selected),
    })
}

/// The fail-closed turn model. Priority (highest first):
/// 1. a held Stop responsibility for this workspace (stopping while the stop is
///    pending; uncertain afterwards — residual execution is never assumed done);
/// 2. a Codex delivery whose outcome is unknown, or an unsettled (Executing)
///    send command: uncertain;
/// 3. a restart leftover: an Active attempt with no live registration and no
///    terminal event: uncertain, not Working and not an absent Runtime;
/// 4. a live in-flight turn: running when it is a proven cancellable turn,
///    waiting-permission when a decision is pending, starting while the
///    provider has not yet acknowledged the turn start;
/// 5. terminal attempt states (stopped / failed / completed);
/// 6. otherwise idle.
fn project_turn(
    store: &Store,
    runtime_manager: &mut RuntimeManager,
    context: &ProductConversationContext<'_>,
    runtime: &ProductRuntimeSelection,
) -> Result<ProductTurn, String> {
    let attempt = context.attempt;
    let held = store
        .held_stop_for_workspace(context.workspace_root)
        .map_err(|error| error.to_string())?;
    let facts = runtime_manager.turn_facts(&attempt.id);
    let pending_permission = store
        .decisions_for_attempt(&attempt.id, 1)
        .map_err(|error| error.to_string())?
        .into_iter()
        .any(|decision| {
            decision.attempt_id == attempt.id && decision.state == DecisionState::Pending
        });
    let executing_send = unsettled_send_command(store, &attempt.id)?;

    // 1. Held stop responsibility governs the workspace.
    if let Some(hold) = held.as_ref() {
        let state = match hold_native_turn_state(hold) {
            "pending" => "stopping",
            _ => "uncertain",
        };
        return Ok(ProductTurn {
            reason_code: None,
            actions: Vec::new(),
            state: state.into(),
            can_stop: false,
            can_send: false,
            reason: Some(format!(
                "work in this workspace is held by a durable Stop responsibility (residual execution {})",
                hold.residual_execution_state
            )),
        });
    }
    if runtime_manager.operation_cancelling(&attempt.id) {
        return Ok(ProductTurn {
            reason_code: Some("start-cancelling".into()),
            actions: Vec::new(),
            state: "stopping".into(),
            can_stop: false,
            can_send: false,
            reason: Some("Ending this Runtime startup before any message is sent.".into()),
        });
    }
    // 2. Delivery unknown / send still executing.
    if facts.is_some_and(|facts| facts.delivery_unknown) {
        return Ok(ProductTurn {
            reason_code: None,
            actions: Vec::new(),
            state: "uncertain".into(),
            can_stop: false,
            can_send: false,
            reason: Some(
                "the previous send could not be confirmed delivered; it is never re-sent \
                 automatically"
                    .into(),
            ),
        });
    }
    if executing_send {
        return Ok(ProductTurn {
            reason_code: None,
            actions: Vec::new(),
            state: "uncertain".into(),
            can_stop: false,
            can_send: false,
            reason: Some(
                "a send is still executing with no recorded outcome; its result is not \
                     assumed"
                    .into(),
            ),
        });
    }
    let latest_turn_fact = store
        .latest_event_kind_in(
            &attempt.id,
            &[
                "attempt.interrupt.requested",
                "runtime.turn.started",
                "runtime.turn.completed",
                "runtime.turn.failed",
                "runtime.turn.cancelled",
                "attempt.cancelled",
            ],
        )
        .map_err(|error| error.to_string())?;
    if latest_turn_fact.as_deref() == Some("attempt.interrupt.requested") {
        return Ok(ProductTurn {
            reason_code: None,
            actions: Vec::new(),
            state: if facts.is_some_and(|facts| facts.in_flight) { "stopping" } else { "uncertain" }.into(),
            can_stop: false, can_send: false,
            reason: Some("Stop was requested. Waiting for the Runtime to confirm the result; new messages are blocked.".into()),
        });
    }
    // 3. A finished native turn remains recoverable across a Core restart. The
    // provider session is detached until the user explicitly resumes it; no
    // message is resent as part of this projection. A confirmed Stop that has
    // already released its hold is the same shape: the Attempt stays Active so
    // a still-attached session can send, and once the registration is gone the
    // stored session id is resumed instead of looking uncertain.
    if attempt.state == AttemptState::Active
        && runtime_manager.registered_binding(&attempt.id).is_none()
    {
        let quiet_release = latest_turn_fact.as_deref() == Some("runtime.turn.cancelled")
            && store
                .latest_event_kind_in(&attempt.id, &["runtime.stop.responsibility.released"])
                .map_err(|error| error.to_string())?
                .is_some();
        let finished = latest_turn_fact.as_deref() == Some("runtime.turn.completed") || quiet_release;
        if finished
            && attempt.provider_session.is_some()
            && !pending_permission
            && !runtime_manager.operation_busy(&attempt.id)
            && store
                .outbox_for_attempt(&attempt.id)
                .map_err(|error| error.to_string())?
                .iter()
                .all(|item| item.state == crate::domain::OutboxState::Succeeded)
        {
            return Ok(ProductTurn {
                reason_code: Some("session-detached".into()),
                actions: Vec::new(),
                state: if quiet_release { "stopped" } else { "completed" }.into(),
                can_stop: false,
                can_send: false,
                reason: Some(
                    if quiet_release {
                        "The previous turn was stopped. Resume this session to continue."
                    } else {
                        "The previous turn finished. Resume this session to continue."
                    }
                    .into(),
                ),
            });
        }
        return Ok(ProductTurn {
            reason_code: None,
            actions: Vec::new(),
            state: "uncertain".into(),
            can_stop: false,
            can_send: false,
            reason: Some(
                "The previous Runtime session is no longer connected and its result is uncertain. Sending is blocked until its state is checked."
                    .into(),
            ),
        });
    }
    // 4. Live turn facts.
    if let Some(facts) = facts.filter(|facts| facts.in_flight) {
        if runtime.state != "selected" && runtime.state != "starting" {
            return Ok(ProductTurn {
                reason_code: Some("recovery-required".into()),
                actions: Vec::new(),
                state: "uncertain".into(),
                can_stop: false,
                can_send: false,
                reason: Some("The Runtime connection is unavailable and this turn's result is uncertain. Check it before continuing.".into()),
            });
        }
        if pending_permission {
            return Ok(ProductTurn {
                reason_code: None,
                actions: Vec::new(),
                state: "waiting-permission".into(),
                can_stop: facts.stoppable,
                can_send: false,
                reason: (!facts.stoppable).then(|| {
                    "the Runtime has not confirmed the turn start; Stop is not offered \
                     without a proven interrupt target"
                        .to_owned()
                }),
            });
        }
        if facts.stoppable {
            return Ok(ProductTurn {
                reason_code: None,
                actions: Vec::new(),
                state: "running".into(),
                can_stop: true,
                can_send: false,
                reason: None,
            });
        }
        return Ok(ProductTurn {
            reason_code: None,
            actions: Vec::new(),
            state: "starting".into(),
            can_stop: false,
            can_send: false,
            reason: Some(
                "the Runtime has not confirmed the turn start; Stop is not offered \
                 without a proven interrupt target"
                    .into(),
            ),
        });
    }
    // 5. Terminal attempt states.
    // A pending closed-session resume successor sits between spawn and its
    // first send: the real CLI reports the session id only after that first
    // message, so the composer must offer exactly that send. Every other
    // Queued attempt keeps the admission reason below.
    if attempt.state == AttemptState::Queued
        && attempt.provider.eq_ignore_ascii_case("claude")
        && runtime.state == "selected"
        && runtime_manager.registered_binding(&attempt.id).is_some()
        && runtime_manager.registration_live(&attempt.id) == Some(true)
        && store
            .list_event_records(&attempt.id, 0)
            .map_err(|error| error.to_string())?
            .iter()
            .any(|record| {
                record.event.kind == "attempt.created"
                    && record
                        .payload
                        .as_ref()
                        .is_some_and(|payload| payload.get("rolledFrom").is_some())
            })
    {
        return Ok(ProductTurn {
            reason_code: Some("resume-pending-verification".into()),
            actions: Vec::new(),
            state: "idle".into(),
            can_stop: false,
            can_send: true,
            reason: Some(
                "Session is starting again. Send a message to continue. Earlier messages will not be sent again."
                    .into(),
            ),
        });
    }
    let terminal = match attempt.state {
        AttemptState::Cancelled => Some(("stopped", None)),
        AttemptState::Failed => Some(("failed", None)),
        AttemptState::Closed => Some(("completed", None)),
        AttemptState::AwaitingReview => Some(("completed", None)),
        AttemptState::Queued => Some((
            "idle",
            Some("the reserved Runtime has not been admitted yet; select it to start work"),
        )),
        AttemptState::Active => None,
    };
    if let Some((state, fixed_reason)) = terminal {
        // Confirmed Stop continues via a freshly admitted same-provider successor,
        // so an old native registration is not a prerequisite (including restart).
        let stopped_can_continue = attempt.state == AttemptState::Cancelled
            && runtime.state != "none"
            && store
                .confirmed_cancellation(&attempt.id)
                .map_err(|error| error.to_string())?;
        let send_allowed = stopped_can_continue
            || (attempt.state == AttemptState::AwaitingReview && runtime.state == "selected");
        let reason = fixed_reason.map(str::to_owned).or_else(|| {
            (!send_allowed).then(|| {
                format!(
                    "the selected Runtime is not available (state {}); no send is offered",
                    runtime.state
                )
            })
        });
        return Ok(ProductTurn {
            reason_code: None,
            actions: Vec::new(),
            state: state.into(),
            can_stop: false,
            can_send: send_allowed,
            reason,
        });
    }
    // 6. Active with a live registration and no turn in flight: between turns.
    let send_allowed = runtime.state == "selected";
    Ok(ProductTurn {
        reason_code: None,
        actions: Vec::new(),
        state: "idle".into(),
        can_stop: false,
        can_send: send_allowed,
        reason: (!send_allowed).then(|| {
            format!(
                "the selected Runtime is not available (state {}); no send is offered",
                runtime.state
            )
        }),
    })
}

fn hold_native_turn_state(hold: &StopResponsibility) -> &'static str {
    match hold.native_turn_state {
        crate::store::StopNativeTurnState::Pending => "pending",
        crate::store::StopNativeTurnState::Interrupted => "interrupted",
        crate::store::StopNativeTurnState::Unconfirmed => "unconfirmed",
    }
}

/// Whether an unsettled command (Executing with no recorded result, or Unknown)
/// still exists for the attempt. A send whose delivery was never settled makes
/// the turn uncertain, fail-closed; restart reconciliation moves Executing rows
/// to Unknown, so both are covered by one predicate.
fn unsettled_send_command(store: &Store, attempt_id: &str) -> Result<bool, String> {
    store
        .unsettled_commands_for_attempt(attempt_id)
        .map(|ids| !ids.is_empty())
        .map_err(|error| error.to_string())
}

/// Whether the campaign authorization allows send at all (provider + action).
pub fn campaign_send_authorized(store: &Store, campaign_id: &str) -> Result<bool, String> {
    let auth = store
        .get_campaign_authorization(campaign_id)
        .map_err(|error| error.to_string())?;
    Ok(auth.provider_authorized && auth.action_authorized)
}

#[cfg(test)]
mod activity_sentence_tests {
    use super::{activity_sentence, running_step};
    use serde_json::json;

    #[test]
    fn steps_read_as_sentences_not_protocol_names() {
        assert_eq!(activity_sentence("commandExecution", "completed", Some(&json!({"command": "npm test", "exitCode": 0}))), "Ran npm test");
        assert_eq!(activity_sentence("commandExecution", "completed", Some(&json!({"command": "npm test", "exitCode": 1}))), "Failed: npm test");
        assert_eq!(activity_sentence("fileChange", "completed", Some(&json!({"paths": ["a.md"]}))), "Changed a.md");
        assert_eq!(activity_sentence("fileChange", "completed", Some(&json!({"paths": ["a.md", "b.md", "c.md"]}))), "Changed a.md and 2 more");
        assert_eq!(activity_sentence("Read", "completed", None), "Read a file");
        assert_eq!(activity_sentence("Grep", "failed", None), "Failed: Searched the workspace");
        assert_eq!(activity_sentence("Edit", "completed", Some(&json!({"path": "a.md"}))), "Changed a.md");
        assert_eq!(activity_sentence("Read", "completed", Some(&json!({"path": "a.md"}))), "Read a.md");
        assert_eq!(activity_sentence("tool_result", "completed", None), "Used a tool");
    }

    #[test]
    fn shell_wrappers_and_machine_paths_stay_out_of_steps() {
        let wrapped = r#""C:\\Users\\me\\pwsh.exe" -Command "git status --short""#;
        assert_eq!(activity_sentence("commandExecution", "completed", Some(&json!({"command": wrapped}))), "Ran git status --short");
        assert_eq!(activity_sentence("commandExecution", "completed", Some(&json!({"command": "/bin/bash -lc 'npm test'"}))), "Ran npm test");
        assert_eq!(activity_sentence("commandExecution", "completed", Some(&json!({"command": "git status"}))), "Ran git status");
        assert_eq!(activity_sentence("fileChange", "completed", Some(&json!({"paths": ["C:\\Users\\me\\repo\\GUIDE.md"]}))), "Changed GUIDE.md");
        assert_eq!(activity_sentence("fileChange", "completed", Some(&json!({"paths": ["docs/guide.md"]}))), "Changed docs/guide.md");
    }

    #[test]
    fn steps_lead_with_the_statement_that_matters() {
        let body = |command: &str| activity_sentence("Bash", "completed", Some(&json!({"command": command})));
        assert_eq!(body("Get-Location; git status; git branch"), "Ran git status…");
        assert_eq!(body("cd src && npm test"), "Ran npm test…");
        assert_eq!(body("$x = 1; npm test"), "Ran npm test…");
    }

    #[test]
    fn only_an_unfinished_tool_is_a_running_step() {
        assert_eq!(running_step(&json!({"tool": "commandExecution", "status": "started", "command": "npm test"})).as_deref(), Some("Running npm test"));
        assert_eq!(running_step(&json!({"tool": "fileChange", "status": "started", "paths": ["a.md"]})).as_deref(), Some("Changing a.md"));
        assert_eq!(running_step(&json!({"tool": "Read", "status": "started"})).as_deref(), Some("Read a file…"));
        assert_eq!(running_step(&json!({"tool": "commandExecution", "status": "completed", "command": "npm test"})), None);
    }

    #[test]
    fn long_or_multi_line_commands_are_cut_visibly() {
        let body = activity_sentence("Bash", "completed", Some(&json!({"command": "first\nsecond"})));
        assert_eq!(body, "Ran first…");
    }
}
