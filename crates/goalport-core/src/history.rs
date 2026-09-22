//! Byte-bounded, cursor-addressed conversation and timeline history.
//!
//! Durable rows remain untouched. This module reads small ordered windows,
//! projects only allowlisted product content, and fragments display text at
//! UTF-8 boundaries using the actual serialized JSON size.

use crate::{
    commands::sha256_hex,
    product_conversation::{ProductConversationItem, project_items},
    projection::{UiTimelineItem, event_to_timeline},
    store::{OrderedEventRecord, Store},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const RECENT_CONVERSATION_BYTES: usize = 512 * 1024;
pub const RECENT_TIMELINE_BYTES: usize = 256 * 1024;
pub const HISTORY_ITEMS_BYTES: usize = 1024 * 1024;
pub const SERIALIZED_FRAGMENT_BYTES: usize = 64 * 1024;
pub const DISPLAY_TEXT_BYTES: usize = 16 * 1024;
const QUERY_BATCH: usize = 16;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPageInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub older_cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub newer_cursor: Option<String>,
    pub has_older: bool,
    pub has_newer: bool,
    pub content_bytes: usize,
    pub item_count: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPage {
    pub scope: String,
    pub owner_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation_items: Option<Vec<ProductConversationItem>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeline_items: Option<Vec<UiTimelineItem>>,
    pub page_info: HistoryPageInfo,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HistoryDirection {
    Older,
    Newer,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct HistoryCursor {
    v: u8,
    scope: String,
    owner: String,
    position: i64,
    fragment: usize,
}

#[derive(Debug, Clone)]
struct Positioned<T> {
    position: i64,
    fragment: usize,
    continues_before: bool,
    continues_after: bool,
    value: T,
}

pub fn recent_conversation(
    store: &Store,
    campaign_id: &str,
) -> Result<(Vec<ProductConversationItem>, HistoryPageInfo), String> {
    let page = conversation_page(
        store,
        campaign_id,
        HistoryDirection::Older,
        None,
        RECENT_CONVERSATION_BYTES,
    )?;
    Ok((page.conversation_items.unwrap_or_default(), page.page_info))
}

pub fn recent_timeline(
    store: &Store,
    attempt_id: &str,
) -> Result<(Vec<UiTimelineItem>, HistoryPageInfo), String> {
    let page = timeline_page(
        store,
        attempt_id,
        HistoryDirection::Older,
        None,
        RECENT_TIMELINE_BYTES,
    )?;
    Ok((page.timeline_items.unwrap_or_default(), page.page_info))
}

pub fn timeline_after(
    store: &Store,
    attempt_id: &str,
    after_sequence: i64,
) -> Result<(Vec<UiTimelineItem>, HistoryPageInfo), String> {
    let cursor = HistoryCursor {
        v: 1,
        scope: "timeline".into(),
        owner: attempt_id.into(),
        position: after_sequence,
        fragment: usize::MAX,
    };
    let positioned = collect_timeline(
        store,
        attempt_id,
        HistoryDirection::Newer,
        Some(&cursor),
        RECENT_TIMELINE_BYTES,
    )?;
    let page_info = timeline_page_info(
        store,
        attempt_id,
        &positioned,
        Some(&cursor),
        HistoryDirection::Newer,
    )?;
    Ok((
        positioned.into_iter().map(|item| item.value).collect(),
        page_info,
    ))
}

pub fn conversation_page(
    store: &Store,
    campaign_id: &str,
    direction: HistoryDirection,
    cursor: Option<&str>,
    budget: usize,
) -> Result<HistoryPage, String> {
    let decoded = cursor
        .map(|value| decode_cursor(value, "conversation", campaign_id))
        .transpose()?;
    let positioned = collect_conversation(store, campaign_id, direction, decoded.as_ref(), budget)?;
    let page_info =
        conversation_page_info(store, campaign_id, &positioned, decoded.as_ref(), direction)?;
    Ok(HistoryPage {
        scope: "conversation".into(),
        owner_id: campaign_id.into(),
        conversation_items: Some(positioned.into_iter().map(|item| item.value).collect()),
        timeline_items: None,
        page_info,
    })
}

pub fn timeline_page(
    store: &Store,
    attempt_id: &str,
    direction: HistoryDirection,
    cursor: Option<&str>,
    budget: usize,
) -> Result<HistoryPage, String> {
    let decoded = cursor
        .map(|value| decode_cursor(value, "timeline", attempt_id))
        .transpose()?;
    let positioned = collect_timeline(store, attempt_id, direction, decoded.as_ref(), budget)?;
    let page_info =
        timeline_page_info(store, attempt_id, &positioned, decoded.as_ref(), direction)?;
    Ok(HistoryPage {
        scope: "timeline".into(),
        owner_id: attempt_id.into(),
        conversation_items: None,
        timeline_items: Some(positioned.into_iter().map(|item| item.value).collect()),
        page_info,
    })
}

fn collect_conversation(
    store: &Store,
    owner: &str,
    direction: HistoryDirection,
    cursor: Option<&HistoryCursor>,
    budget: usize,
) -> Result<Vec<Positioned<ProductConversationItem>>, String> {
    collect(
        direction,
        cursor,
        budget,
        |before| {
            store
                .campaign_event_records_before(owner, before, QUERY_BATCH)
                .map_err(|e| e.to_string())
        },
        |after| {
            store
                .campaign_event_records_after(owner, after, QUERY_BATCH)
                .map_err(|e| e.to_string())
        },
        |ordered| conversation_fragments(store, owner, ordered),
    )
}

fn collect_timeline(
    store: &Store,
    owner: &str,
    direction: HistoryDirection,
    cursor: Option<&HistoryCursor>,
    budget: usize,
) -> Result<Vec<Positioned<UiTimelineItem>>, String> {
    collect(
        direction,
        cursor,
        budget,
        |before| {
            store
                .attempt_event_records_before(owner, before, QUERY_BATCH)
                .map_err(|e| e.to_string())
        },
        |after| {
            store
                .attempt_event_records_after(owner, after, QUERY_BATCH)
                .map_err(|e| e.to_string())
        },
        |ordered| Ok(timeline_fragments(ordered)),
    )
}

fn collect<T, Before, After, Project>(
    direction: HistoryDirection,
    cursor: Option<&HistoryCursor>,
    budget: usize,
    mut before_query: Before,
    mut after_query: After,
    project: Project,
) -> Result<Vec<Positioned<T>>, String>
where
    T: Clone + Serialize,
    Before: FnMut(Option<i64>) -> Result<Vec<OrderedEventRecord>, String>,
    After: FnMut(i64) -> Result<Vec<OrderedEventRecord>, String>,
    Project: Fn(&OrderedEventRecord) -> Result<Vec<Positioned<T>>, String>,
{
    let mut selected: Vec<Positioned<T>> = Vec::new();
    match direction {
        HistoryDirection::Older => {
            let mut anchor = cursor.map(|cursor| cursor.position);
            if let Some(cursor) = cursor.filter(|cursor| cursor.fragment > 0) {
                let same = before_query(cursor.position.checked_add(1))?;
                if let Some(record) = same
                    .into_iter()
                    .find(|record| record.position == cursor.position)
                {
                    let fragments = project(&record)?
                        .into_iter()
                        .filter(|fragment| fragment.fragment < cursor.fragment)
                        .collect::<Vec<_>>();
                    if append_nearest_older(&mut selected, fragments, budget)? {
                        return Ok(selected);
                    }
                }
            }
            while serialized_values_len(&selected)? < budget {
                let batch = before_query(anchor)?;
                if batch.is_empty() {
                    break;
                }
                anchor = batch.first().map(|record| record.position);
                for record in batch.into_iter().rev() {
                    if append_nearest_older(&mut selected, project(&record)?, budget)? {
                        return Ok(selected);
                    }
                }
            }
        }
        HistoryDirection::Newer => {
            let mut anchor = cursor.map(|cursor| cursor.position).unwrap_or(0);
            if let Some(cursor) = cursor {
                let same = before_query(cursor.position.checked_add(1))?;
                if let Some(record) = same
                    .into_iter()
                    .find(|record| record.position == cursor.position)
                {
                    let fragments = project(&record)?
                        .into_iter()
                        .filter(|fragment| fragment.fragment > cursor.fragment)
                        .collect::<Vec<_>>();
                    if append_nearest_newer(&mut selected, fragments, budget)? {
                        return Ok(selected);
                    }
                }
            }
            while serialized_values_len(&selected)? < budget {
                let batch = after_query(anchor)?;
                if batch.is_empty() {
                    break;
                }
                anchor = batch.last().map(|record| record.position).unwrap_or(anchor);
                for record in batch {
                    if append_nearest_newer(&mut selected, project(&record)?, budget)? {
                        return Ok(selected);
                    }
                }
            }
        }
    }
    Ok(selected)
}

fn append_nearest_older<T: Clone + Serialize>(
    selected: &mut Vec<Positioned<T>>,
    fragments: Vec<Positioned<T>>,
    budget: usize,
) -> Result<bool, String> {
    let mut encoded_len = serialized_values_len(selected)?;
    let mut item_count = selected.len();
    let mut accepted = Vec::new();
    for fragment in fragments.into_iter().rev() {
        let item_len = serde_json::to_vec(&fragment.value)
            .map_err(|error| error.to_string())?
            .len();
        let added = item_len + usize::from(item_count > 0);
        if encoded_len + added > budget {
            accepted.reverse();
            accepted.append(selected);
            *selected = accepted;
            return Ok(true);
        }
        encoded_len += added;
        item_count += 1;
        accepted.push(fragment);
    }
    accepted.reverse();
    accepted.append(selected);
    *selected = accepted;
    Ok(false)
}

fn append_nearest_newer<T: Clone + Serialize>(
    selected: &mut Vec<Positioned<T>>,
    fragments: Vec<Positioned<T>>,
    budget: usize,
) -> Result<bool, String> {
    let mut encoded_len = serialized_values_len(selected)?;
    let mut item_count = selected.len();
    for fragment in fragments {
        let item_len = serde_json::to_vec(&fragment.value)
            .map_err(|error| error.to_string())?
            .len();
        let added = item_len + usize::from(item_count > 0);
        if encoded_len + added > budget {
            return Ok(true);
        }
        encoded_len += added;
        item_count += 1;
        selected.push(fragment);
    }
    Ok(false)
}

fn serialized_values_len<T: Serialize>(items: &[Positioned<T>]) -> Result<usize, String> {
    serde_json::to_vec(&items.iter().map(|item| &item.value).collect::<Vec<_>>())
        .map(|bytes| bytes.len())
        .map_err(|error| error.to_string())
}

fn conversation_fragments(
    store: &Store,
    campaign_id: &str,
    record: &OrderedEventRecord,
) -> Result<Vec<Positioned<ProductConversationItem>>, String> {
    if record.record.event.kind == "handoff.completed" {
        let operation_id = record
            .record
            .payload
            .as_ref()
            .and_then(|payload| payload.get("handoffId"))
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or_else(|| {
                record
                    .record
                    .payload
                    .as_ref()
                    .and_then(|payload| payload.pointer("/authorization/requestHash"))
                    .and_then(Value::as_str)
                    .map(|hash| format!("handoff-{hash}"))
            });
        if let Some(operation_id) = operation_id
            && !store
                .campaign_handoff_is_canonical(campaign_id, record.position, &operation_id)
                .map_err(|error| error.to_string())?
        {
            return Ok(Vec::new());
        }
    }
    if record.record.event.kind == "message.user"
        && record
            .record
            .payload
            .as_ref()
            .and_then(|payload| payload.get("origin"))
            .and_then(Value::as_str)
            .is_none()
        && let Some(request_id) = record
            .record
            .payload
            .as_ref()
            .and_then(|payload| payload.get("requestId"))
            .and_then(Value::as_str)
        && store
            .historical_generated_handoff_message(
                &record.record.event.attempt_id,
                record.record.event.seq,
                request_id,
            )
            .map_err(|error| error.to_string())?
    {
        return Ok(Vec::new());
    }
    let projected = if record.record.event.kind == "runtime.reply.delta" {
        let Some(body) = record
            .record
            .payload
            .as_ref()
            .and_then(|payload| payload.get("text"))
            .and_then(Value::as_str)
        else {
            return Ok(Vec::new());
        };
        let logical_item_id = store
            .campaign_reply_group_id(campaign_id, record.position)
            .map_err(|error| error.to_string())?
            .unwrap_or_else(|| record.record.event.id.clone());
        vec![ProductConversationItem {
            id: record.record.event.id.clone(),
            logical_item_id,
            fragment_index: 0,
            continues_before: false,
            continues_after: false,
            kind: "assistant-message".into(),
            body: body.to_owned(),
            actor: None,
            timestamp: Some(record.record.created_at.clone()),
            actions: None,
            technical_details: None,
        }]
    } else {
        project_items(std::slice::from_ref(&record.record))
    };
    Ok(projected
        .into_iter()
        .flat_map(|item| fragment_conversation_item(item, record.position))
        .collect())
}

fn timeline_fragments(record: &OrderedEventRecord) -> Vec<Positioned<UiTimelineItem>> {
    fragment_timeline_item(event_to_timeline(&record.record), record.position)
}

fn fragment_conversation_item(
    mut item: ProductConversationItem,
    position: i64,
) -> Vec<Positioned<ProductConversationItem>> {
    item.actor = item.actor.map(|value| bounded_string(&value, 4096));
    item.timestamp = item.timestamp.map(|value| bounded_string(&value, 4096));
    item.technical_details = item
        .technical_details
        .map(|value| bounded_string(&value, DISPLAY_TEXT_BYTES));
    let logical = stable_logical_id(&item.logical_item_id, &item.id);
    let physical = stable_logical_id(&item.id, &logical);
    item.logical_item_id = logical.clone();
    let body = std::mem::take(&mut item.body);
    fragment_body(body, |body, index, before, after| {
        let mut fragment = item.clone();
        fragment.id = fragment_id(&physical, index);
        fragment.body = body;
        fragment.fragment_index = index;
        fragment.continues_before = before;
        fragment.continues_after = after;
        fragment
    })
    .into_iter()
    .enumerate()
    .map(|(fragment, value)| Positioned {
        position,
        fragment,
        continues_before: value.continues_before,
        continues_after: value.continues_after,
        value,
    })
    .collect()
}

fn fragment_timeline_item(
    mut item: UiTimelineItem,
    position: i64,
) -> Vec<Positioned<UiTimelineItem>> {
    item.title = bounded_string(&item.title, 4096);
    item.actor = bounded_string(&item.actor, 4096);
    item.timestamp = bounded_string(&item.timestamp, 4096);
    item.status = item.status.map(|value| bounded_string(&value, 4096));
    item.evidence_state = item
        .evidence_state
        .map(|value| bounded_string(&value, 4096));
    item.details = item
        .details
        .into_iter()
        .take(32)
        .map(|value| bounded_string(&value, DISPLAY_TEXT_BYTES))
        .collect();
    let logical = stable_logical_id(&item.logical_item_id, &item.id);
    let physical = stable_logical_id(&item.id, &logical);
    item.logical_item_id = logical.clone();
    let body = std::mem::take(&mut item.body);
    fragment_body(body, |body, index, before, after| {
        let mut fragment = item.clone();
        fragment.id = fragment_id(&physical, index);
        fragment.body = body;
        fragment.fragment_index = index;
        fragment.continues_before = before;
        fragment.continues_after = after;
        fragment
    })
    .into_iter()
    .enumerate()
    .map(|(fragment, value)| Positioned {
        position,
        fragment,
        continues_before: value.continues_before,
        continues_after: value.continues_after,
        value,
    })
    .collect()
}

fn fragment_body<T: Clone + Serialize>(
    body: String,
    make: impl Fn(String, usize, bool, bool) -> T,
) -> Vec<T> {
    if body.is_empty() {
        return vec![make(body, 0, false, false)];
    }
    let mut pieces = Vec::new();
    let mut start_byte = 0usize;
    while start_byte < body.len() {
        // A Unicode scalar contributes at least one encoded JSON byte. Limit
        // the exact binary search to the next DISPLAY_TEXT_BYTES raw bytes so
        // a giant item never serializes multi-megabyte midpoint candidates.
        let mut raw_end = body.len().min(start_byte + DISPLAY_TEXT_BYTES);
        while raw_end > start_byte && !body.is_char_boundary(raw_end) {
            raw_end -= 1;
        }
        let mut boundaries = body[start_byte..raw_end]
            .char_indices()
            .map(|(offset, _)| start_byte + offset)
            .collect::<Vec<_>>();
        if boundaries.first().copied() != Some(start_byte) {
            boundaries.insert(0, start_byte);
        }
        if boundaries.last().copied() != Some(raw_end) {
            boundaries.push(raw_end);
        }
        let mut low = 1usize;
        let mut high = boundaries.len() - 1;
        let mut best = low;
        while low <= high {
            let middle = low + (high - low) / 2;
            let end_byte = boundaries[middle];
            let text = &body[start_byte..end_byte];
            let candidate = make(
                text.to_owned(),
                pieces.len(),
                start_byte > 0,
                end_byte < body.len(),
            );
            let display_ok = serde_json::to_vec(text)
                .map(|bytes| bytes.len())
                .unwrap_or(usize::MAX)
                <= DISPLAY_TEXT_BYTES;
            let item_ok = serde_json::to_vec(&candidate)
                .map(|bytes| bytes.len())
                .unwrap_or(usize::MAX)
                <= SERIALIZED_FRAGMENT_BYTES;
            if display_ok && item_ok {
                best = middle;
                low = middle + 1;
            } else if middle == 0 {
                break;
            } else {
                high = middle - 1;
            }
        }
        let end_byte = boundaries[best];
        let text = body[start_byte..end_byte].to_owned();
        pieces.push(make(
            text,
            pieces.len(),
            start_byte > 0,
            end_byte < body.len(),
        ));
        start_byte = end_byte;
    }
    if pieces.len() == 1 {
        pieces[0] = make(body, 0, false, false);
    }
    pieces
}

fn stable_logical_id(logical: &str, fallback: &str) -> String {
    let source = if logical.trim().is_empty() {
        fallback
    } else {
        logical
    };
    if source.as_bytes().len() <= 256 {
        source.to_owned()
    } else {
        format!("logical-{}", sha256_hex(source.as_bytes()))
    }
}

fn fragment_id(logical: &str, index: usize) -> String {
    if index == 0 {
        logical.to_owned()
    } else {
        format!("fragment-{}-{index}", sha256_hex(logical.as_bytes()))
    }
}

fn bounded_string(value: &str, max_serialized_bytes: usize) -> String {
    if serde_json::to_vec(value).is_ok_and(|bytes| bytes.len() <= max_serialized_bytes) {
        return value.to_owned();
    }
    let mut out = String::new();
    for character in value.chars() {
        out.push(character);
        if serde_json::to_vec(&out).is_ok_and(|bytes| bytes.len() > max_serialized_bytes) {
            out.pop();
            break;
        }
    }
    out
}

fn conversation_page_info(
    store: &Store,
    owner: &str,
    items: &[Positioned<ProductConversationItem>],
    cursor: Option<&HistoryCursor>,
    direction: HistoryDirection,
) -> Result<HistoryPageInfo, String> {
    page_info(
        "conversation",
        owner,
        items,
        cursor,
        direction,
        |position| {
            store
                .campaign_event_records_before(owner, Some(position), 1)
                .map(|rows| !rows.is_empty())
                .map_err(|e| e.to_string())
        },
        |position| {
            store
                .campaign_event_records_after(owner, position, 1)
                .map(|rows| !rows.is_empty())
                .map_err(|e| e.to_string())
        },
    )
}

fn timeline_page_info(
    store: &Store,
    owner: &str,
    items: &[Positioned<UiTimelineItem>],
    cursor: Option<&HistoryCursor>,
    direction: HistoryDirection,
) -> Result<HistoryPageInfo, String> {
    page_info(
        "timeline",
        owner,
        items,
        cursor,
        direction,
        |position| {
            store
                .attempt_event_records_before(owner, Some(position), 1)
                .map(|rows| !rows.is_empty())
                .map_err(|e| e.to_string())
        },
        |position| {
            store
                .attempt_event_records_after(owner, position, 1)
                .map(|rows| !rows.is_empty())
                .map_err(|e| e.to_string())
        },
    )
}

fn page_info<T: Serialize>(
    scope: &str,
    owner: &str,
    items: &[Positioned<T>],
    cursor: Option<&HistoryCursor>,
    direction: HistoryDirection,
    has_before: impl Fn(i64) -> Result<bool, String>,
    has_after: impl Fn(i64) -> Result<bool, String>,
) -> Result<HistoryPageInfo, String> {
    let content_bytes = serialized_values_len(items)?;
    let first = items.first();
    let last = items.last();
    let older_cursor = first
        .map(|item| encode_cursor(scope, owner, item.position, item.fragment))
        .transpose()?;
    let newer_cursor = last
        .map(|item| encode_cursor(scope, owner, item.position, item.fragment))
        .transpose()?;
    let has_older = match first {
        Some(item) => item.continues_before || item.fragment > 0 || has_before(item.position)?,
        None => direction == HistoryDirection::Newer && cursor.is_some(),
    };
    let has_newer = match last {
        Some(item) => item.continues_after || has_after(item.position)?,
        None => direction == HistoryDirection::Older && cursor.is_some(),
    };
    Ok(HistoryPageInfo {
        older_cursor,
        newer_cursor,
        has_older,
        has_newer,
        content_bytes,
        item_count: items.len(),
    })
}

fn encode_cursor(
    scope: &str,
    owner: &str,
    position: i64,
    fragment: usize,
) -> Result<String, String> {
    let bytes = serde_json::to_vec(&HistoryCursor {
        v: 1,
        scope: scope.into(),
        owner: owner.into(),
        position,
        fragment,
    })
    .map_err(|error| error.to_string())?;
    Ok(base64url_encode(&bytes))
}

fn decode_cursor(value: &str, scope: &str, owner: &str) -> Result<HistoryCursor, String> {
    if value.is_empty() || value.len() > 2048 {
        return Err("history cursor is empty or oversized".into());
    }
    let bytes = base64url_decode(value)?;
    let cursor: HistoryCursor =
        serde_json::from_slice(&bytes).map_err(|_| "history cursor is malformed".to_string())?;
    if cursor.v != 1 || cursor.scope != scope || cursor.owner != owner || cursor.position <= 0 {
        return Err("history cursor does not match its scope and owner".into());
    }
    Ok(cursor)
}

fn base64url_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let a = chunk[0];
        let b = *chunk.get(1).unwrap_or(&0);
        let c = *chunk.get(2).unwrap_or(&0);
        out.push(TABLE[(a >> 2) as usize] as char);
        out.push(TABLE[(((a & 0x03) << 4) | (b >> 4)) as usize] as char);
        if chunk.len() > 1 {
            out.push(TABLE[(((b & 0x0f) << 2) | (c >> 6)) as usize] as char);
        }
        if chunk.len() > 2 {
            out.push(TABLE[(c & 0x3f) as usize] as char);
        }
    }
    out
}

fn base64url_decode(value: &str) -> Result<Vec<u8>, String> {
    fn sextet(byte: u8) -> Option<u8> {
        match byte {
            b'A'..=b'Z' => Some(byte - b'A'),
            b'a'..=b'z' => Some(byte - b'a' + 26),
            b'0'..=b'9' => Some(byte - b'0' + 52),
            b'-' => Some(62),
            b'_' => Some(63),
            _ => None,
        }
    }
    if value.len() % 4 == 1 {
        return Err("history cursor is malformed".into());
    }
    let encoded = value.as_bytes();
    let mut out = Vec::with_capacity(encoded.len() * 3 / 4);
    let mut index = 0;
    while index < encoded.len() {
        let a = sextet(encoded[index]).ok_or_else(|| "history cursor is malformed".to_string())?;
        let b = sextet(
            *encoded
                .get(index + 1)
                .ok_or_else(|| "history cursor is malformed".to_string())?,
        )
        .ok_or_else(|| "history cursor is malformed".to_string())?;
        out.push((a << 2) | (b >> 4));
        if let Some(&third) = encoded.get(index + 2) {
            let c = sextet(third).ok_or_else(|| "history cursor is malformed".to_string())?;
            out.push(((b & 0x0f) << 4) | (c >> 2));
            if let Some(&fourth) = encoded.get(index + 3) {
                let d = sextet(fourth).ok_or_else(|| "history cursor is malformed".to_string())?;
                out.push(((c & 0x03) << 6) | d);
            }
        }
        index += 4;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursor_round_trip_is_owner_bound() {
        let encoded = encode_cursor("conversation", "campaign-1", 42, 7).unwrap();
        let decoded = decode_cursor(&encoded, "conversation", "campaign-1").unwrap();
        assert_eq!(decoded.position, 42);
        assert_eq!(decoded.fragment, 7);
        assert!(decode_cursor(&encoded, "conversation", "campaign-2").is_err());
        assert!(decode_cursor(&encoded, "timeline", "campaign-1").is_err());
    }

    #[test]
    fn escaped_unicode_fragments_are_bounded_and_reconstruct_exactly() {
        let body = "🙂\\\n\"control\t".repeat(5000);
        let item = ProductConversationItem {
            id: "event-1".into(),
            logical_item_id: "event-1".into(),
            fragment_index: 0,
            continues_before: false,
            continues_after: false,
            kind: "user-message".into(),
            body: body.clone(),
            actor: Some("user".into()),
            timestamp: None,
            actions: None,
            technical_details: None,
        };
        let fragments = fragment_conversation_item(item, 1);
        assert!(fragments.len() > 1);
        assert_eq!(
            fragments
                .iter()
                .map(|fragment| fragment.value.body.as_str())
                .collect::<String>(),
            body
        );
        assert!(fragments.iter().all(|fragment| {
            serde_json::to_vec(&fragment.value).unwrap().len() <= SERIALIZED_FRAGMENT_BYTES
                && serde_json::to_vec(&fragment.value.body).unwrap().len() <= DISPLAY_TEXT_BYTES
        }));
    }
}
