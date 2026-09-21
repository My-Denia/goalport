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
    runtime_manager::RuntimeManager,
    store::{ConversationPreference, EventRecord, Store, StopResponsibility},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The additive product snapshot member (camelCase wire contract).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductConversation {
    pub items: Vec<ProductConversationItem>,
    pub runtime: ProductRuntimeSelection,
    pub turn: ProductTurn,
    /// Additive beyond the packet's minimum wire shape: the deterministic
    /// product title (rename > first prompt, normalized to the first 44 Unicode
    /// characters > root task title). The sidebar needs it from Core.
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductConversationItem {
    pub id: String,
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
pub struct ProductTurn {
    /// `idle` | `starting` | `running` | `waiting-permission` | `stopping` |
    /// `stopped` | `completed` | `failed` | `uncertain`.
    pub state: String,
    pub can_stop: bool,
    pub can_send: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
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
) -> Result<ProductConversation, String> {
    let records = store
        .campaign_event_records(context.campaign_id)
        .map_err(|error| error.to_string())?;
    let items = project_items(&records);
    let preference = store
        .conversation_preference(context.campaign_id)
        .map_err(|error| error.to_string())?;
    let title = effective_title(&preference, &records, context.root_task_title);
    let runtime = project_runtime(store, runtime_manager, context, &preference)?;
    let mut turn = project_turn(store, runtime_manager, context, &runtime)?;
    if turn.can_send && !campaign_send_authorized(store, context.campaign_id)? {
        turn.can_send = false;
        turn.reason = Some("Sending is blocked because this conversation's permission to use the Runtime or perform actions was revoked.".into());
    }
    Ok(ProductConversation {
        items,
        runtime,
        turn,
        title,
    })
}

/// The deterministic product title: an explicit rename wins; otherwise the
/// first user message whitespace-normalized to its first 44 Unicode characters;
/// otherwise the existing root task title. Nothing is rewritten to compute it.
fn effective_title(
    preference: &Option<ConversationPreference>,
    records: &[EventRecord],
    root_task_title: &str,
) -> String {
    if let Some(title) = preference
        .as_ref()
        .and_then(|row| row.title.as_deref())
        .filter(|title| !title.trim().is_empty())
    {
        return title.trim().to_owned();
    }
    let first_prompt = records.iter().find_map(|record| {
        if record.event.kind != "message.user" {
            return None;
        }
        record
            .payload
            .as_ref()
            .and_then(|payload| payload.get("text"))
            .and_then(Value::as_str)
            .map(str::to_owned)
    });
    if let Some(prompt) = first_prompt {
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
fn project_items(records: &[EventRecord]) -> Vec<ProductConversationItem> {
    let mut items = Vec::new();
    let mut pending_reply: Option<ProductConversationItem> = None;
    let mut reply_attempt = String::new();
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
        let boundary = matches!(record.event.kind.as_str(),
            "message.user" | "runtime.tool.activity" | "runtime.turn.started"
            | "runtime.turn.completed" | "runtime.turn.cancelled" | "runtime.turn.failed"
            | "runtime.send.failed" | "handoff.completed");
        if boundary || (!reply_attempt.is_empty() && reply_attempt != record.event.attempt_id) {
            if let Some(reply) = pending_reply.take() {
                items.push(reply);
            }
        }
        match record.event.kind.as_str() {
            "message.user" => {
                let Some(text) = text_of("text") else {
                    continue;
                };
                if text.trim().is_empty() {
                    continue;
                }
                items.push(ProductConversationItem {
                    id: record.event.id.clone(),
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
                match pending_reply.as_mut() {
                    Some(reply) => reply.body.push_str(&delta),
                    None => {
                        reply_attempt = record.event.attempt_id.clone();
                        pending_reply = Some(ProductConversationItem {
                            id: record.event.id.clone(),
                            kind: "assistant-message".into(),
                            body: delta,
                            actor: None,
                            timestamp: Some(record.created_at.clone()),
                            actions: None,
                            technical_details: None,
                        });
                    }
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
                let body = if status.is_empty() {
                    tool
                } else {
                    format!("{tool} — {status}")
                };
                items.push(ProductConversationItem {
                    id: record.event.id.clone(),
                    kind: "activity-summary".into(),
                    body,
                    actor: None,
                    timestamp: Some(record.created_at.clone()),
                    actions: None,
                    technical_details: None,
                });
            }
            "runtime.turn.failed" | "runtime.send.failed" | "attempt.admission.failed"
            | "runtime.transport.closed" => {
                let technical_body = text_of("text").or_else(|| text_of("error"));
                let body = match record.event.kind.as_str() {
                    "runtime.send.failed" => "Message delivery could not be completed. Check the connection and Technical details before sending anything again.",
                    "attempt.admission.failed" => "The selected Runtime could not be started. Review Technical details or choose another Runtime.",
                    "runtime.transport.closed" => "The Runtime connection closed. Review the session status before continuing.",
                    _ => "The Runtime could not finish this response. Review Technical details before continuing.",
                }.to_owned();
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
                items.push(ProductConversationItem {
                    id: record.event.id.clone(),
                    kind: "actionable-error".into(),
                    body,
                    actor: None,
                    timestamp: Some(record.created_at.clone()),
                    actions: None,
                    technical_details: Some(
                        Value::Object(technical).to_string(),
                    ),
                });
            }
            "handoff.completed" => {
                let provider = payload
                    .and_then(|value| value.get("newAttempt"))
                    .and_then(|value| value.get("provider"))
                    .and_then(Value::as_str)
                    .unwrap_or("another Runtime");
                items.push(ProductConversationItem {
                    id: record.event.id.clone(),
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
        .list_decisions()
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
            state: state.into(),
            can_stop: false,
            can_send: false,
            reason: Some(format!(
                "work in this workspace is held by a durable Stop responsibility (residual execution {})",
                hold.residual_execution_state
            )),
        });
    }
    // 2. Delivery unknown / send still executing.
    if facts.is_some_and(|facts| facts.delivery_unknown) {
        return Ok(ProductTurn {
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
    let records = store.list_event_records(&attempt.id, 0).map_err(|error| error.to_string())?;
    let latest_turn_fact = records.iter().rev().find(|record| matches!(record.event.kind.as_str(),
        "attempt.interrupt.requested" | "runtime.turn.started" | "runtime.turn.completed"
        | "runtime.turn.failed" | "runtime.turn.cancelled" | "attempt.cancelled"));
    if latest_turn_fact.is_some_and(|record| record.event.kind == "attempt.interrupt.requested") {
        return Ok(ProductTurn {
            state: if facts.is_some_and(|facts| facts.in_flight) { "stopping" } else { "uncertain" }.into(),
            can_stop: false, can_send: false,
            reason: Some("Stop was requested. Waiting for the Runtime to confirm the result; new messages are blocked.".into()),
        });
    }
    // 3. Restart leftover: unfinished turn facts without a live registration.
    if attempt.state == AttemptState::Active
        && runtime_manager.selected_provider(&attempt.id).is_none()
    {
        return Ok(ProductTurn {
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
        if pending_permission {
            return Ok(ProductTurn {
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
                state: "running".into(),
                can_stop: true,
                can_send: false,
                reason: None,
            });
        }
        return Ok(ProductTurn {
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
            && store.confirmed_cancellation(&attempt.id).map_err(|error| error.to_string())?;
        let send_allowed = stopped_can_continue || (attempt.state == AttemptState::AwaitingReview
            && runtime.state == "selected");
        let reason = fixed_reason.map(str::to_owned).or_else(|| {
            (!send_allowed).then(|| {
                format!(
                    "the selected Runtime is not available (state {}); no send is offered",
                    runtime.state
                )
            })
        });
        return Ok(ProductTurn {
            state: state.into(),
            can_stop: false,
            can_send: send_allowed,
            reason,
        });
    }
    // 6. Active with a live registration and no turn in flight: between turns.
    let send_allowed = runtime.state == "selected";
    Ok(ProductTurn {
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
