//! Read-only result of one turn: the final reply, files relative to the
//! baseline taken before send, and commands that were actually observed.
//! Nothing here commits, resets, or cleans the workspace.

use crate::{
    commands::sha256_hex,
    store::{EventRecord, Store},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Read,
    path::Path,
    process::Command,
};

const OUTPUT_CHARS: usize = 400;
/// Failure text stays short. A completed reply is the final assistant item,
/// so this cap must not decide which item that is.
const REPLY_CHARS: usize = 480;
const REPLY_STORAGE_CHARS: usize = 32_768;
const MAX_FILES: usize = 80;
const MAX_PROJECTED_TURNS: usize = 8;
const MAX_COMMANDS: usize = 40;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnResultView {
    pub request_id: String,
    /// `completed` | `failed` | `cancelled` | `uncertain`.
    pub reply_state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_text: Option<String>,
    /// The stored reply is a prefix of the final assistant item.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub reply_truncated: bool,
    pub baseline_recorded: bool,
    pub before: Vec<FileFact>,
    pub during: Vec<FileFact>,
    pub unattributed: Vec<FileFact>,
    pub commands: Vec<CommandFact>,
    /// Later command records for this turn were not included.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub commands_truncated: bool,
    /// The workspace had more status rows than this result lists.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub files_truncated: bool,
    /// The ending git status could not be read, so no file change was inferred.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub comparison_unavailable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileFact {
    pub path: String,
    /// Source path for `renamed` and `copied`. Absent for every other change.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_path: Option<String>,
    /// `staged` | `unstaged` | `untracked`.
    pub area: String,
    pub status: String,
    /// `before` | `added` | `modified` | `deleted` | `renamed` | `copied`.
    pub change: String,
    /// `available` | `binary` | `too-large` | `unreadable` | `not-applicable`.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub content_inspection: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandFact {
    pub command: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// `started` | `completed` | `failed`.
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
}

#[derive(Debug, Clone)]
struct Fingerprint {
    path: String,
    from_path: Option<String>,
    area: String,
    status: String,
    change: String,
    content_hash: Option<String>,
    content_inspection: String,
}

pub fn baseline_payload(workspace: &Path, request_id: &str) -> Value {
    match read_fingerprints(workspace) {
        Some(read) => json!({
            "requestId": request_id,
            "recorded": true,
            "entriesTruncated": read.truncated,
            "entries": read.entries.iter().map(fingerprint_json).collect::<Vec<_>>()
        }),
        None => json!({
            "requestId": request_id,
            "recorded": false
        }),
    }
}

pub fn project_turn_results(store: &Store, attempt_id: &str) -> Result<Vec<TurnResultView>, String> {
    Ok(project_turn_result_window(store, attempt_id)?.0)
}

/// Newest settled turns, plus how many older turns were left out of this view.
pub fn project_turn_result_window(store: &Store, attempt_id: &str) -> Result<(Vec<TurnResultView>, usize), String> {
    if attempt_id.is_empty() {
        return Ok((Vec::new(), 0));
    }
    let records = store
        .list_event_records(attempt_id, 0)
        .map_err(|error| error.to_string())?;
    let mut results = Vec::new();
    for record in &records {
        if record.event.kind != "workspace.turn_result" {
            continue;
        }
        let Some(payload) = record.payload.as_ref() else {
            continue;
        };
        results.push(view_from_payload(payload, &records, record.event.seq));
    }
    let omitted = results.len().saturating_sub(MAX_PROJECTED_TURNS);
    if omitted > 0 {
        results.drain(0..omitted);
    }
    Ok((results, omitted))
}

/// Filesystem facts captured at the first observation of a native terminal.
/// An unavailable sample stays unavailable on persistence retries.
#[derive(Debug, Clone)]
pub(crate) struct WorkspaceSnapshot {
    end: Option<StatusRead>,
    disappeared: BTreeMap<String, Fingerprint>,
}

impl WorkspaceSnapshot {
    pub(crate) fn unavailable() -> Self {
        Self { end: None, disappeared: BTreeMap::new() }
    }
}

pub(crate) fn sample_workspace(store: &Store, attempt_id: &str, workspace: &Path) -> WorkspaceSnapshot {
    let Ok(records) = store.list_event_records(attempt_id, 0) else {
        return WorkspaceSnapshot::unavailable();
    };
    sample_workspace_at_baseline(&records, None, workspace)
}

fn sample_workspace_at_baseline(records: &[EventRecord], before_seq: Option<i64>, workspace: &Path) -> WorkspaceSnapshot {
    let Some(end) = read_fingerprints(workspace) else {
        return WorkspaceSnapshot::unavailable();
    };
    let baseline = records.iter().rev().find(|record| record.event.kind == "workspace.baseline"
        && before_seq.is_none_or(|seq| record.event.seq < seq));
    let disappeared = fingerprints_from_payload(baseline.and_then(|record| record.payload.as_ref()))
        .into_iter().filter(|entry| !end.truncated && !path_still_present(&end.entries, &entry.path))
        .map(|entry| (entry.path.clone(), disappeared(workspace, &entry))).collect();
    WorkspaceSnapshot { end: Some(end), disappeared }
}

/// Freeze the file comparison for a terminal turn that does not yet have one.
/// Returns a payload to persist, or nothing when there is no new terminal turn.
pub fn settlement_payload(store: &Store, attempt_id: &str, workspace: &Path) -> Result<Option<Value>, String> {
    let records = store.list_event_records(attempt_id, 0).map_err(|error| error.to_string())?;
    let Some(terminal) = unsettled_terminal(&records, None) else { return Ok(None); };
    let snapshot = sample_workspace_at_baseline(&records, Some(terminal.event.seq), workspace);
    settlement_payload_with_snapshot(store, attempt_id, Some(&terminal.event.id), &snapshot)
}

fn unsettled_terminal<'a>(records: &'a [EventRecord], terminal_id: Option<&str>) -> Option<&'a EventRecord> {
    records.iter().find(|record| {
        terminal_id.is_none_or(|id| record.event.id == id) &&
        is_terminal(&record.event.kind)
            && !records.iter().any(|other| {
                other.event.kind == "workspace.turn_result"
                    && other
                        .payload
                        .as_ref()
                        .and_then(|payload| payload.get("terminalSeq"))
                        .and_then(Value::as_i64)
                        == Some(record.event.seq)
            })
    })
}

pub(crate) fn settlement_payload_with_snapshot(
    store: &Store, attempt_id: &str, terminal_id: Option<&str>, snapshot: &WorkspaceSnapshot,
) -> Result<Option<Value>, String> {
    let records = store
        .list_event_records(attempt_id, 0)
        .map_err(|error| error.to_string())?;
    let Some(terminal) = unsettled_terminal(&records, terminal_id) else {
        return Ok(None);
    };
    if records.iter().any(|record| {
        record.event.kind == "workspace.turn_result"
            && record
                .payload
                .as_ref()
                .and_then(|payload| payload.get("terminalSeq"))
                .and_then(Value::as_i64)
                == Some(terminal.event.seq)
    }) {
        return Ok(None);
    }
    let baseline = records.iter().rev().find(|record| {
        record.event.kind == "workspace.baseline" && record.event.seq < terminal.event.seq
    });
    let request_id = baseline
        .and_then(|record| record.payload.as_ref())
        .and_then(|payload| payload.get("requestId"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let recorded = baseline
        .and_then(|record| record.payload.as_ref())
        .and_then(|payload| payload.get("recorded"))
        .and_then(Value::as_bool)
        == Some(true);
    let (before, during, unattributed, lists_truncated, comparison_unavailable) = if recorded {
        let start = fingerprints_from_payload(baseline.and_then(|record| record.payload.as_ref()));
        let start_truncated = baseline
            .and_then(|record| record.payload.as_ref())
            .and_then(|payload| payload.get("entriesTruncated"))
            .and_then(Value::as_bool)
            == Some(true);
        match snapshot.end.as_ref() {
            None => {
                let before = start.iter().take(MAX_FILES).map(|entry| file_json(entry, "before")).collect();
                (before, Vec::new(), Vec::new(), start_truncated, true)
            }
            Some(end) => {
                let attributed = attributed_paths(&records, baseline.map(|record| record.event.seq).unwrap_or(0), terminal.event.seq);
                // A truncated end window cannot prove that a baseline path
                // disappeared. Absence from the first 80 rows is not a delete.
                let (before, during, unattributed, dropped) = classify(
                    &snapshot.disappeared,
                    &start,
                    &end.entries,
                    &attributed,
                    !end.truncated,
                    start_truncated,
                );
                (before, during, unattributed, start_truncated || end.truncated || dropped, false)
            }
        }
    } else {
        (Vec::new(), Vec::new(), Vec::new(), false, false)
    };
    let (reply_state, reply_text, reply_truncated) = reply_for(&records, terminal);
    Ok(Some(json!({
        "requestId": request_id,
        "terminalSeq": terminal.event.seq,
        "baselineSeq": baseline.map(|record| record.event.seq),
        "replyState": reply_state,
        "replyText": reply_text,
        "replyTruncated": reply_truncated,
        "baselineRecorded": recorded,
        "afterSeq": baseline.map(|record| record.event.seq).unwrap_or_else(|| {
            records
                .iter()
                .rev()
                .find(|record| record.event.kind == "runtime.turn.started" && record.event.seq < terminal.event.seq)
                .map(|record| record.event.seq)
                .unwrap_or(0)
        }),
        "before": before,
        "during": during,
        "unattributed": unattributed,
        "filesTruncated": lists_truncated,
        "comparisonUnavailable": comparison_unavailable
    })))
}

fn view_from_payload(payload: &Value, records: &[EventRecord], result_seq: i64) -> TurnResultView {
    let baseline_seq = payload
        .get("afterSeq")
        .or_else(|| payload.get("baselineSeq"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let terminal_seq = payload.get("terminalSeq").and_then(Value::as_i64).unwrap_or(result_seq);
    let mut commands = commands_between(records, baseline_seq, terminal_seq);
    let commands_truncated = commands.len() > MAX_COMMANDS;
    if commands_truncated {
        commands.truncate(MAX_COMMANDS);
    }
    TurnResultView {
        request_id: payload.get("requestId").and_then(Value::as_str).unwrap_or("").to_string(),
        reply_state: payload
            .get("replyState")
            .and_then(Value::as_str)
            .unwrap_or("uncertain")
            .to_string(),
        reply_text: payload
            .get("replyText")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(str::to_owned),
        reply_truncated: payload.get("replyTruncated").and_then(Value::as_bool) == Some(true),
        baseline_recorded: payload.get("baselineRecorded").and_then(Value::as_bool) == Some(true),
        before: file_facts(payload.get("before")),
        during: file_facts(payload.get("during")),
        unattributed: file_facts(payload.get("unattributed")),
        commands,
        commands_truncated,
        files_truncated: payload.get("filesTruncated").and_then(Value::as_bool) == Some(true),
        comparison_unavailable: payload.get("comparisonUnavailable").and_then(Value::as_bool) == Some(true),
    }
}

fn file_facts(value: Option<&Value>) -> Vec<FileFact> {
    value
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(|row| {
                    Some(FileFact {
                        path: row.get("path")?.as_str()?.to_string(),
                        from_path: row.get("fromPath").and_then(Value::as_str).filter(|value| !value.is_empty()).map(str::to_owned),
                        area: row.get("area").and_then(Value::as_str).unwrap_or("unstaged").to_string(),
                        status: row.get("status").and_then(Value::as_str).unwrap_or("").to_string(),
                        change: row.get("change").and_then(Value::as_str).unwrap_or("before").to_string(),
                        content_inspection: row.get("contentInspection").and_then(Value::as_str).unwrap_or("").to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn is_terminal(kind: &str) -> bool {
    matches!(kind, "runtime.turn.completed" | "runtime.turn.failed" | "runtime.turn.cancelled")
}

fn reply_for(records: &[EventRecord], terminal: &EventRecord) -> (String, Option<String>, bool) {
    let state = match terminal.event.kind.as_str() {
        "runtime.turn.failed" => "failed",
        "runtime.turn.cancelled" => "cancelled",
        "runtime.turn.completed" => {
            let status = terminal
                .payload
                .as_ref()
                .and_then(|payload| payload.get("status"))
                .and_then(Value::as_str)
                .unwrap_or("completed");
            if status.eq_ignore_ascii_case("interrupted") || status.eq_ignore_ascii_case("cancelled") {
                "cancelled"
            } else if status.eq_ignore_ascii_case("failed") {
                "failed"
            } else if status.eq_ignore_ascii_case("completed") {
                "completed"
            } else {
                "uncertain"
            }
        }
        _ => "uncertain",
    };
    let (text, truncated) = match state {
        "completed" => completed_reply(records, terminal.event.seq)
            .map(|reply| (Some(reply.text), reply.truncated))
            .unwrap_or((None, false)),
        "failed" => (
            terminal
                .payload
                .as_ref()
                .and_then(|payload| payload.get("text").or_else(|| payload.get("error")))
                .and_then(Value::as_str)
                .filter(|text| !text.trim().is_empty())
                .map(|text| bound_chars(text.trim(), REPLY_CHARS)),
            false,
        ),
        _ => (None, false),
    };
    (state.to_string(), text, truncated)
}

struct BoundedReply {
    text: String,
    truncated: bool,
}

struct ReplyItem {
    completed_body: Option<String>,
    deltas: String,
}

/// The reply is the last assistant item that reached `item/completed`.
/// Earlier progress items stay in the transcript and do not join this text.
/// A completed body wins; that item's own deltas are used only when the
/// protocol sealed the item without a body.
fn completed_reply(records: &[EventRecord], terminal_seq: i64) -> Option<BoundedReply> {
    let window_start = records
        .iter()
        .rev()
        .find(|record| record.event.kind == "runtime.turn.started" && record.event.seq < terminal_seq)
        .or_else(|| {
            records.iter().rev().find(|record| {
                record.event.kind == "workspace.baseline" && record.event.seq < terminal_seq
            })
        })
        .map(|record| record.event.seq)
        .unwrap_or(0);
    let mut items: BTreeMap<String, ReplyItem> = BTreeMap::new();
    let mut last_sealed: Option<(i64, String)> = None;
    for record in records {
        if record.event.kind != "runtime.reply.delta" || record.event.seq <= window_start || record.event.seq >= terminal_seq {
            continue;
        }
        let Some(payload) = record.payload.as_ref() else { continue };
        let text = payload.get("text").and_then(Value::as_str).unwrap_or("");
        let completed = payload.get("status").and_then(Value::as_str) == Some("completed");
        let key = payload
            .get("itemId")
            .and_then(Value::as_str)
            .filter(|item_id| !item_id.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| {
                if completed {
                    format!("sealed-{}", record.event.seq)
                } else {
                    "open".to_string()
                }
            });
        let item = items.entry(key.clone()).or_insert_with(|| ReplyItem {
            completed_body: None,
            deltas: String::new(),
        });
        if completed {
            let body = text.trim();
            if !body.is_empty() {
                item.completed_body = Some(body.to_string());
            }
            last_sealed = Some((record.event.seq, key));
        } else if !text.is_empty() {
            item.deltas.push_str(text);
        }
    }
    let text = if let Some((_, key)) = last_sealed {
        let item = items.get(&key)?;
        item.completed_body.clone().filter(|body| !body.is_empty()).unwrap_or_else(|| item.deltas.clone())
    } else {
        items.get("open").map(|item| item.deltas.clone()).unwrap_or_default()
    };
    let text = text.trim();
    (!text.is_empty()).then(|| bound_reply(text))
}

fn bound_reply(text: &str) -> BoundedReply {
    let truncated = text.chars().nth(REPLY_STORAGE_CHARS).is_some();
    BoundedReply {
        text: bound_chars(text, REPLY_STORAGE_CHARS),
        truncated,
    }
}

fn commands_between(records: &[EventRecord], start_seq: i64, end_seq: i64) -> Vec<CommandFact> {
    let mut commands = Vec::new();
    for record in records {
        if record.event.kind != "runtime.tool.activity" || record.event.seq <= start_seq || record.event.seq > end_seq {
            continue;
        }
        let Some(payload) = record.payload.as_ref() else { continue };
        let Some(command) = payload.get("command").and_then(Value::as_str).filter(|value| !value.trim().is_empty()) else {
            continue;
        };
        let exit_code = payload.get("exitCode").and_then(Value::as_i64);
        let status = payload.get("status").and_then(Value::as_str).unwrap_or("");
        let state = if exit_code.is_some_and(|code| code != 0) || status.eq_ignore_ascii_case("failed") {
            "failed"
        } else if exit_code == Some(0) {
            "completed"
        } else if status.eq_ignore_ascii_case("completed") {
            "completed"
        } else {
            "started"
        };
        let output = payload
            .get("output")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(|text| bound_chars(text, OUTPUT_CHARS));
        commands.push(CommandFact {
            command: command.trim().to_string(),
            cwd: payload.get("cwd").and_then(Value::as_str).filter(|value| !value.is_empty()).map(str::to_owned),
            state: state.to_string(),
            exit_code,
            output,
        });
    }
    commands
}

fn attributed_paths(records: &[EventRecord], start_seq: i64, end_seq: i64) -> BTreeMap<String, ()> {
    let mut paths = BTreeMap::new();
    for record in records {
        if record.event.kind != "runtime.tool.activity" || record.event.seq <= start_seq || record.event.seq > end_seq {
            continue;
        }
        let Some(payload) = record.payload.as_ref() else { continue };
        if let Some(path) = payload.get("path").and_then(Value::as_str) {
            paths.insert(path.to_string(), ());
        }
        if let Some(list) = payload.get("paths").and_then(Value::as_array) {
            for path in list.iter().filter_map(Value::as_str) {
                paths.insert(path.to_string(), ());
            }
        }
    }
    paths
}

fn classify(
    disappeared: &BTreeMap<String, Fingerprint>,
    start: &[Fingerprint],
    end: &[Fingerprint],
    attributed: &BTreeMap<String, ()>,
    allow_disappearance: bool,
    start_truncated: bool,
) -> (Vec<Value>, Vec<Value>, Vec<Value>, bool) {
    let mut before = Vec::new();
    let mut during = Vec::new();
    let mut unattributed = Vec::new();
    let mut dropped = false;
    for entry in start {
        if before.len() >= MAX_FILES {
            dropped = true;
            break;
        }
        before.push(file_json(entry, "before"));
    }
    for entry in end {
        if start.iter().any(|prior| same_git_fact(prior, entry)) {
            continue;
        }
        // A truncated baseline did not capture every pre-existing path.
        // An end row that was outside that slice is not proof of an add.
        if start_truncated && !captured_baseline_path(start, &entry.path) {
            continue;
        }
        // A rename/copy is one Git record. Do not also invent an add of the
        // destination or a delete of the source from the other path.
        if !push_change(&mut during, &mut unattributed, attributed, entry) {
            dropped = true;
        }
    }
    for entry in start {
        if !allow_disappearance || path_still_present(end, &entry.path) {
            continue;
        }
        // A baseline path that git status no longer lists was deleted, or a
        // dirty tracked file was restored to HEAD. Either way the user's
        // bytes changed and must show up as a turn change, not only as
        // "already in the workspace".
        if let Some(change) = disappeared.get(&entry.path)
            && !push_change(&mut during, &mut unattributed, attributed, change)
        {
            dropped = true;
        }
    }
    (before, during, unattributed, dropped)
}

fn captured_baseline_path(start: &[Fingerprint], path: &str) -> bool {
    start.iter().any(|entry| entry.path == path || entry.from_path.as_deref() == Some(path))
}

fn path_still_present(end: &[Fingerprint], path: &str) -> bool {
    end.iter().any(|entry| entry.path == path || entry.from_path.as_deref() == Some(path))
}

fn disappeared(workspace: &Path, entry: &Fingerprint) -> Fingerprint {
    let candidate = workspace.join(&entry.path);
    if candidate.is_file() {
        let (content_hash, content_inspection) = inspect_content(workspace, &entry.path);
        Fingerprint {
            path: entry.path.clone(),
            from_path: None,
            area: entry.area.clone(),
            status: "  ".into(),
            change: "modified".into(),
            content_hash,
            content_inspection,
        }
    } else {
        Fingerprint {
            path: entry.path.clone(),
            from_path: None,
            area: entry.area.clone(),
            status: entry.status.clone(),
            change: "deleted".into(),
            content_hash: None,
            content_inspection: "not-applicable".into(),
        }
    }
}

fn same_git_fact(prior: &Fingerprint, current: &Fingerprint) -> bool {
    prior.path == current.path
        && prior.from_path == current.from_path
        && prior.area == current.area
        && prior.status == current.status
        && prior.content_hash == current.content_hash
        && prior.content_inspection == current.content_inspection
}

fn push_change(
    during: &mut Vec<Value>,
    unattributed: &mut Vec<Value>,
    attributed: &BTreeMap<String, ()>,
    entry: &Fingerprint,
) -> bool {
    let row = file_json(entry, &entry.change);
    let named = attributed.contains_key(&entry.path)
        || entry.from_path.as_ref().is_some_and(|path| attributed.contains_key(path));
    if named {
        if during.len() < MAX_FILES {
            during.push(row);
            return true;
        }
        return false;
    }
    if unattributed.len() < MAX_FILES {
        unattributed.push(row);
        return true;
    }
    false
}

fn fingerprints_from_payload(payload: Option<&Value>) -> Vec<Fingerprint> {
    payload
        .and_then(|payload| payload.get("entries"))
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(|row| {
                    Some(Fingerprint {
                        path: row.get("path")?.as_str()?.to_string(),
                        from_path: row.get("fromPath").and_then(Value::as_str).filter(|value| !value.is_empty()).map(str::to_owned),
                        area: row.get("area").and_then(Value::as_str).unwrap_or("unstaged").to_string(),
                        status: row.get("status").and_then(Value::as_str).unwrap_or("").to_string(),
                        change: row.get("change").and_then(Value::as_str).unwrap_or("modified").to_string(),
                        content_hash: row.get("contentHash").and_then(Value::as_str).map(str::to_owned),
                        content_inspection: row.get("contentInspection").and_then(Value::as_str).unwrap_or("available").to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn fingerprint_json(entry: &Fingerprint) -> Value {
    json!({
        "path": entry.path,
        "fromPath": entry.from_path,
        "area": entry.area,
        "status": entry.status,
        "change": entry.change,
        "contentHash": entry.content_hash,
        "contentInspection": entry.content_inspection
    })
}

fn file_json(entry: &Fingerprint, change: &str) -> Value {
    json!({
        "path": entry.path,
        "fromPath": entry.from_path,
        "area": entry.area,
        "status": entry.status,
        "change": change,
        "contentInspection": entry.content_inspection
    })
}

#[derive(Debug, Clone)]
struct StatusRead {
    entries: Vec<Fingerprint>,
    truncated: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WorkspaceEntry {
    pub path: String,
    pub area: String,
    pub status: String,
    pub content_hash: Option<String>,
    pub content_inspection: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WorkspaceSample {
    pub entries: Vec<WorkspaceEntry>,
    pub truncated: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WorkspaceDelta {
    Equal,
    Changed,
    Unknown,
}

pub(crate) fn sample_workspace_entries(workspace: &Path) -> Option<WorkspaceSample> {
    let read = read_fingerprints(workspace)?;
    let mut entries = read
        .entries
        .into_iter()
        .map(|entry| WorkspaceEntry {
            path: entry.path,
            area: entry.area,
            status: entry.status,
            content_hash: entry.content_hash,
            content_inspection: entry.content_inspection,
        })
        .collect::<Vec<_>>();
    for entry in &mut entries {
        if entry.content_hash.is_none() && entry.content_inspection == "binary" {
            entry.content_hash = hash_binary_for_effect(workspace, &entry.path);
        }
    }
    Some(WorkspaceSample {
        truncated: read.truncated,
        entries,
    })
}

/// Path appearance, disappearance, or a different area, status, or content hash
/// is a change. A still-present path with no content hash, or a truncated
/// sample, is unknown. An unchanged dirty file is equal.
pub(crate) fn compare_workspace_samples(
    before: &WorkspaceSample,
    after: &WorkspaceSample,
) -> WorkspaceDelta {
    if before.truncated || after.truncated {
        return WorkspaceDelta::Unknown;
    }
    let before_map = before
        .entries
        .iter()
        .map(|entry| (entry.path.as_str(), entry))
        .collect::<BTreeMap<_, _>>();
    let after_map = after
        .entries
        .iter()
        .map(|entry| (entry.path.as_str(), entry))
        .collect::<BTreeMap<_, _>>();
    let mut paths = BTreeSet::new();
    paths.extend(before_map.keys().copied());
    paths.extend(after_map.keys().copied());
    let mut changed = false;
    let mut unknown = false;
    for path in paths {
        match (before_map.get(path), after_map.get(path)) {
            (Some(left), Some(right)) => {
                if left.area != right.area || left.status != right.status {
                    changed = true;
                    continue;
                }
                if left.content_inspection == "not-applicable"
                    && right.content_inspection == "not-applicable"
                {
                    continue;
                }
                match (&left.content_hash, &right.content_hash) {
                    (Some(earlier), Some(later)) if earlier == later => {}
                    (Some(_), Some(_)) => changed = true,
                    _ => unknown = true,
                }
            }
            _ => changed = true,
        }
    }
    if changed {
        WorkspaceDelta::Changed
    } else if unknown {
        WorkspaceDelta::Unknown
    } else {
        WorkspaceDelta::Equal
    }
}

fn hash_binary_for_effect(workspace: &Path, path: &str) -> Option<String> {
    if path.starts_with('/') || path.split(['/', '\\']).any(|part| part == "..") {
        return None;
    }
    let full = workspace.join(path);
    let meta = fs::metadata(&full).ok()?;
    if !meta.is_file() || meta.len() > CONTENT_LIMIT {
        return None;
    }
    let bytes = fs::read(&full).ok()?;
    Some(sha256_hex(&bytes))
}

fn read_fingerprints(workspace: &Path) -> Option<StatusRead> {
    if !workspace.is_dir() {
        return None;
    }
    let inside = Command::new("git")
        .arg("-C")
        .arg(workspace)
        .args(["rev-parse", "--is-inside-work-tree"])
        .output()
        .ok()?;
    if !inside.status.success()
        || std::str::from_utf8(&inside.stdout).map(|text| text.trim() != "true").unwrap_or(true)
    {
        return None;
    }
    let status = Command::new("git")
        .arg("-C")
        .arg(workspace)
        .args(["status", "--porcelain=v1", "-z", "-uall"])
        .output()
        .ok()?;
    if !status.status.success() {
        return None;
    }
    let records = parse_porcelain_records(&status.stdout);
    let truncated = records.len() > MAX_FILES;
    Some(StatusRead {
        entries: records.into_iter().take(MAX_FILES).map(|record| fingerprint(workspace, record)).collect(),
        truncated,
    })
}

struct PorcelainRecord {
    x: char,
    y: char,
    path: String,
    from_path: Option<String>,
}

fn parse_porcelain_records(bytes: &[u8]) -> Vec<PorcelainRecord> {
    let fields: Vec<&[u8]> = bytes.split(|byte| *byte == 0).filter(|field| !field.is_empty()).collect();
    let mut records = Vec::new();
    let mut index = 0;
    while index < fields.len() {
        let head = fields[index];
        if head.len() < 4 || head.get(2) != Some(&b' ') {
            index += 1;
            continue;
        }
        let x = head[0] as char;
        let y = head[1] as char;
        let path = String::from_utf8_lossy(&head[3..]).into_owned();
        let paired = x == 'R' || x == 'C' || y == 'R' || y == 'C';
        let from_path = if paired {
            index += 1;
            fields.get(index).map(|field| String::from_utf8_lossy(field).into_owned())
        } else {
            None
        };
        index += 1;
        if path.is_empty() {
            continue;
        }
        records.push(PorcelainRecord { x, y, path, from_path });
    }
    records
}

fn fingerprint(workspace: &Path, record: PorcelainRecord) -> Fingerprint {
    let status: String = [record.x, record.y].into_iter().collect();
    let change = change_kind(record.x, record.y);
    let area = if record.x == '?' && record.y == '?' {
        "untracked"
    } else if record.x != ' ' && record.x != '?' {
        "staged"
    } else {
        "unstaged"
    };
    let inspect_path = if change == "deleted" { None } else { Some(record.path.as_str()) };
    let (content_hash, content_inspection) = match inspect_path {
        None => (None, "not-applicable".to_string()),
        Some(path) => inspect_content(workspace, path),
    };
    Fingerprint {
        path: record.path,
        from_path: record.from_path,
        area: area.to_string(),
        status,
        change: change.to_string(),
        content_hash,
        content_inspection,
    }
}

fn change_kind(x: char, y: char) -> &'static str {
    if x == 'R' || y == 'R' {
        "renamed"
    } else if x == 'C' || y == 'C' {
        "copied"
    } else if x == 'D' || y == 'D' {
        "deleted"
    } else if x == '?' || y == '?' || x == 'A' || y == 'A' {
        "added"
    } else {
        "modified"
    }
}

const CONTENT_LIMIT: u64 = 1_048_576;
const SNIFF_BYTES: usize = 8192;

fn inspect_content(workspace: &Path, path: &str) -> (Option<String>, String) {
    if path.starts_with('/') || path.split(['/', '\\']).any(|part| part == "..") {
        return (None, "unreadable".into());
    }
    let full = workspace.join(path);
    let meta = match fs::metadata(&full) {
        Ok(meta) => meta,
        Err(_) => return (None, "unreadable".into()),
    };
    if !meta.is_file() {
        return (None, "not-applicable".into());
    }
    if meta.len() > CONTENT_LIMIT {
        return (None, "too-large".into());
    }
    let mut file = match fs::File::open(&full) {
        Ok(file) => file,
        Err(_) => return (None, "unreadable".into()),
    };
    let sniff_len = SNIFF_BYTES.min(meta.len() as usize);
    let mut sniff = vec![0; sniff_len];
    if file.read_exact(&mut sniff).is_err() {
        return (None, "unreadable".into());
    }
    if sniff.contains(&0) {
        return (None, "binary".into());
    }
    let mut bytes = sniff;
    if (meta.len() as usize) > bytes.len() && file.read_to_end(&mut bytes).is_err() {
        return (None, "unreadable".into());
    }
    if bytes.contains(&0) {
        return (None, "binary".into());
    }
    (Some(sha256_hex(&bytes)), "available".into())
}

fn bound_chars(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        Attempt, Campaign, Project, Task, UiController, WorkStatus,
        domain::Event,
        ipc::{CONNECTED_UI_PROTOCOL_VERSION, UiCommandRequest},
        store::{CampaignAuthorization, Store},
    };
    use std::process::Command;

    fn git(root: &Path, args: &[&str]) {
        let status = Command::new("git").arg("-C").arg(root).args(args).status().unwrap();
        assert!(status.success(), "git {args:?} failed");
    }

    #[test]
    fn baseline_keeps_a_preexisting_edit_apart_from_later_changes_and_exit_codes() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        git(root, &["init"]);
        git(root, &["config", "user.email", "turn@example.com"]);
        git(root, &["config", "user.name", "Turn"]);
        fs::write(root.join("base.txt"), "base\n").unwrap();
        git(root, &["add", "base.txt"]);
        git(root, &["commit", "-m", "base"]);
        fs::write(root.join("user.txt"), "dirty before\n").unwrap();

        let db = root.join("core.sqlite");
        let store = Store::open(&db).unwrap();
        let project = Project { id: "project-turn".into(), workspace_root: root.to_string_lossy().to_string() };
        let campaign = Campaign {
            id: "campaign-turn".into(),
            goal: "check the result".into(),
            root_task_id: "task-turn".into(),
            state: WorkStatus::InProgress,
        };
        let task = Task {
            id: "task-turn".into(),
            campaign_id: campaign.id.clone(),
            title: "Check".into(),
            acceptance: "see the files".into(),
            state: WorkStatus::InProgress,
        };
        store.create_workspace_campaign(&project, &campaign, &task, "policy-turn", "{}", &CampaignAuthorization::granted()).unwrap();
        store.insert_attempt(&Attempt::new("attempt-turn", &task.id, "scenario", "scenario-cap-v1")).unwrap();
        let baseline = baseline_payload(root, "request-turn");
        append(&store, 1, "workspace.baseline", &baseline);
        fs::write(root.join("agent.txt"), "from the runtime\n").unwrap();
        fs::write(root.join("hand.txt"), "typed beside the runtime\n").unwrap();
        append(&store, 2, "runtime.turn.started", &json!({ "status": "running" }));
        append(&store, 3, "runtime.tool.activity", &json!({
            "tool": "commandExecution", "command": "echo ok", "cwd": root.to_string_lossy(),
            "status": "completed", "exitCode": 0, "output": "ok"
        }));
        append(&store, 4, "runtime.tool.activity", &json!({
            "tool": "commandExecution", "command": "echo fail", "cwd": root.to_string_lossy(),
            "status": "failed", "exitCode": 1, "output": "no"
        }));
        append(&store, 5, "runtime.tool.activity", &json!({
            "tool": "fileChange", "status": "completed", "paths": ["agent.txt"]
        }));
        append(&store, 6, "runtime.reply.delta", &json!({
            "text": "I think the tests passed", "status": "completed"
        }));
        append(&store, 7, "runtime.turn.completed", &json!({ "status": "completed" }));
        let payload = settlement_payload(&store, "attempt-turn", root).unwrap().unwrap();
        append(&store, 8, "workspace.turn_result", &payload);
        drop(store);

        let reopened = Store::open(&db).unwrap();
        let results = project_turn_results(&reopened, "attempt-turn").unwrap();
        assert_eq!(results.len(), 1);
        let result = &results[0];
        assert_eq!(result.reply_state, "completed");
        assert_eq!(result.reply_text.as_deref(), Some("I think the tests passed"));
        assert!(result.before.iter().any(|file| file.path == "user.txt" && file.change == "before"));
        assert!(result.during.iter().any(|file| file.path == "agent.txt" && file.change == "added"));
        assert!(result.unattributed.iter().any(|file| file.path == "hand.txt"));
        assert!(result.before.iter().all(|file| file.path != "agent.txt"));
        let codes: Vec<_> = result.commands.iter().map(|command| (command.command.as_str(), command.exit_code, command.state.as_str())).collect();
        assert_eq!(codes, vec![("echo ok", Some(0), "completed"), ("echo fail", Some(1), "failed")]);
        assert!(result.commands.iter().all(|command| command.command != "I think the tests passed"));
    }

    #[test]
    fn a_real_send_records_the_baseline_and_a_reopened_core_still_shows_it() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        git(root, &["init"]);
        git(root, &["config", "user.email", "turn@example.com"]);
        git(root, &["config", "user.name", "Turn"]);
        fs::write(root.join("base.txt"), "base\n").unwrap();
        git(root, &["add", "base.txt"]);
        git(root, &["commit", "-m", "base"]);
        fs::write(root.join("user.txt"), "dirty before\n").unwrap();
        let db = root.join("core.sqlite");
        let store = Store::open(&db).unwrap();
        let mut ui = UiController::new(store).unwrap();
        let started = ui.handle(UiCommandRequest {
            protocol_version: CONNECTED_UI_PROTOCOL_VERSION.into(),
            request_id: "wire-send".into(),
            entity_version: 0,
            message_type: "start_conversation".into(),
            payload: json!({
                "workspaceRoot": root.to_string_lossy(),
                "provider": "scenario",
                "message": "look at the workspace"
            }),
        }).unwrap();
        let first = started.snapshot.turn_results.last().expect("settled result");
        assert!(first.before.iter().any(|file| file.path == "user.txt"));
        assert!(first.baseline_recorded);
        assert!(first.commands.is_empty());
        let campaign_id = started.snapshot.active_campaign_id.clone();
        let other = tempfile::tempdir().unwrap();
        fs::write(other.path().join("note.txt"), "other\n").unwrap();
        let elsewhere = ui.handle(UiCommandRequest {
            protocol_version: CONNECTED_UI_PROTOCOL_VERSION.into(),
            request_id: "wire-other".into(),
            entity_version: 0,
            message_type: "start_conversation".into(),
            payload: json!({
                "workspaceRoot": other.path().to_string_lossy(),
                "provider": "scenario",
                "message": "a different goal"
            }),
        }).unwrap();
        assert!(elsewhere.snapshot.turn_results.iter().all(|result| result.before.iter().all(|file| file.path != "user.txt")));
        let back = ui.handle(UiCommandRequest {
            protocol_version: CONNECTED_UI_PROTOCOL_VERSION.into(),
            request_id: "wire-back".into(),
            entity_version: 0,
            message_type: "select_campaign".into(),
            payload: json!({ "campaignId": campaign_id }),
        }).unwrap();
        assert!(back.snapshot.turn_results.iter().any(|result| result.before.iter().any(|file| file.path == "user.txt")));
        drop(ui);
        let store = Store::open(&db).unwrap();
        let mut ui = UiController::new(store).unwrap();
        ui.handle(UiCommandRequest {
            protocol_version: CONNECTED_UI_PROTOCOL_VERSION.into(),
            request_id: "wire-select".into(),
            entity_version: 0,
            message_type: "select_campaign".into(),
            payload: json!({ "campaignId": campaign_id }),
        }).unwrap();
        let again = ui.snapshot(None).unwrap();
        assert!(again.turn_results.iter().any(|result| result.before.iter().any(|file| file.path == "user.txt")));
    }

    fn append(store: &Store, seq: i64, kind: &str, payload: &Value) {
        append_on(store, "attempt-turn", seq, kind, payload);
    }

    fn append_on(store: &Store, attempt_id: &str, seq: i64, kind: &str, payload: &Value) {
        let event = Event {
            id: format!("event-{attempt_id}-{seq}"),
            attempt_id: attempt_id.into(),
            seq,
            kind: kind.into(),
            payload_ref: None,
        };
        store.append_event_with_state(&event, None, Some(payload)).unwrap();
    }

    fn settle(store: &Store, attempt_id: &str, root: &Path, seq: i64) {
        let payload = settlement_payload(store, attempt_id, root).unwrap().expect("a terminal turn should settle");
        append_on(store, attempt_id, seq, "workspace.turn_result", &payload);
    }

    #[test]
    fn audit_two_turns_do_not_overwrite_each_other() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        git(root, &["init"]);
        git(root, &["config", "user.email", "turn@example.com"]);
        git(root, &["config", "user.name", "Turn"]);
        fs::write(root.join("base.txt"), "base\n").unwrap();
        git(root, &["add", "base.txt"]);
        git(root, &["commit", "-m", "base"]);
        let db = root.join("audit-turns.sqlite");
        let store = prepared(&db, root, "attempt-audit");

        append_on(&store, "attempt-audit", 1, "workspace.baseline", &baseline_payload(root, "turn-1"));
        fs::write(root.join("one.txt"), "one\n").unwrap();
        append_on(&store, "attempt-audit", 2, "runtime.turn.started", &json!({ "status": "running" }));
        append_on(&store, "attempt-audit", 3, "runtime.tool.activity", &json!({
            "tool": "fileChange", "status": "completed", "paths": ["one.txt"]
        }));
        append_on(&store, "attempt-audit", 4, "runtime.tool.activity", &json!({
            "tool": "commandExecution", "command": "echo one", "status": "completed", "exitCode": 0
        }));
        append_on(&store, "attempt-audit", 5, "runtime.reply.delta", &json!({ "text": "first reply", "status": "completed" }));
        append_on(&store, "attempt-audit", 6, "runtime.turn.completed", &json!({ "status": "completed" }));
        settle(&store, "attempt-audit", root, 7);

        append_on(&store, "attempt-audit", 8, "workspace.baseline", &baseline_payload(root, "turn-2"));
        fs::write(root.join("two.txt"), "two\n").unwrap();
        append_on(&store, "attempt-audit", 9, "runtime.turn.started", &json!({ "status": "running" }));
        append_on(&store, "attempt-audit", 10, "runtime.tool.activity", &json!({
            "tool": "commandExecution", "command": "echo two", "status": "completed", "exitCode": 0
        }));
        append_on(&store, "attempt-audit", 11, "runtime.reply.delta", &json!({ "text": "second reply", "status": "completed" }));
        append_on(&store, "attempt-audit", 12, "runtime.turn.completed", &json!({ "status": "completed" }));
        settle(&store, "attempt-audit", root, 13);

        append_on(&store, "attempt-audit", 14, "workspace.baseline", &json!({ "requestId": "turn-failed", "recorded": false }));
        append_on(&store, "attempt-audit", 15, "runtime.reply.delta", &json!({ "text": "partial delta must not be the failure reply" }));
        append_on(&store, "attempt-audit", 16, "runtime.turn.failed", &json!({ "text": "the turn failed" }));
        settle(&store, "attempt-audit", root, 17);
        append_on(&store, "attempt-audit", 18, "workspace.baseline", &json!({ "requestId": "turn-cancelled", "recorded": false }));
        append_on(&store, "attempt-audit", 19, "runtime.reply.delta", &json!({ "text": "partial delta must not be the cancellation reply", "status": "completed" }));
        append_on(&store, "attempt-audit", 20, "runtime.turn.cancelled", &json!({}));
        settle(&store, "attempt-audit", root, 21);
        append_on(&store, "attempt-audit", 22, "workspace.baseline", &json!({ "requestId": "turn-uncertain", "recorded": false }));
        append_on(&store, "attempt-audit", 23, "runtime.turn.completed", &json!({ "status": "unknown" }));
        settle(&store, "attempt-audit", root, 24);

        let results = project_turn_results(&store, "attempt-audit").unwrap();
        assert_eq!(results.len(), 5, "{results:?}");
        assert_eq!(results[0].request_id, "turn-1");
        assert_eq!(results[0].reply_text.as_deref(), Some("first reply"));
        assert!(results[0].during.iter().any(|file| file.path == "one.txt"));
        assert!(results[0].commands.iter().any(|command| command.command == "echo one"));
        assert!(results[0].commands.iter().all(|command| command.command != "echo two"));
        assert!(results[0].during.iter().all(|file| file.path != "two.txt"));
        assert_eq!(results[1].request_id, "turn-2");
        assert_eq!(results[1].reply_text.as_deref(), Some("second reply"));
        assert!(results[1].commands.iter().any(|command| command.command == "echo two"));
        assert!(results[1].commands.iter().all(|command| command.command != "echo one"));
        assert_eq!(results[2].reply_state, "failed");
        assert_eq!(results[2].reply_text.as_deref(), Some("the turn failed"));
        assert_eq!(results[3].reply_state, "cancelled");
        assert_eq!(results[3].reply_text, None);
        assert_eq!(results[4].reply_state, "uncertain");
        assert_eq!(results[4].reply_text, None);
    }

    #[test]
    fn the_final_completed_assistant_item_is_the_reply() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        git(root, &["init"]);
        git(root, &["config", "user.email", "turn@example.com"]);
        git(root, &["config", "user.name", "Turn"]);
        fs::write(root.join("base.txt"), "base\n").unwrap();
        git(root, &["add", "base.txt"]);
        git(root, &["commit", "-m", "base"]);
        let db = root.join("final-item.sqlite");
        let store = prepared(&db, root, "attempt-final");
        let progress = "I'll check calc.py and leave the dirty README alone.";
        let deltas = "Fixed `add()` ";
        let final_body = format!("Fixed `add()` in `calc.py` to return `a + b`.\n\n{}", "x".repeat(600));
        append_on(&store, "attempt-final", 1, "workspace.baseline", &baseline_payload(root, "turn-final"));
        append_on(&store, "attempt-final", 2, "runtime.turn.started", &json!({ "status": "running" }));
        append_on(&store, "attempt-final", 3, "runtime.reply.delta", &json!({ "itemId": "item-progress", "text": progress }));
        append_on(&store, "attempt-final", 4, "runtime.reply.delta", &json!({ "itemId": "item-progress", "text": progress, "status": "completed" }));
        append_on(&store, "attempt-final", 5, "runtime.tool.activity", &json!({
            "tool": "commandExecution", "command": "python3 -m pytest -q", "status": "completed", "exitCode": 0
        }));
        append_on(&store, "attempt-final", 6, "runtime.reply.delta", &json!({ "itemId": "item-final", "text": deltas }));
        append_on(&store, "attempt-final", 7, "runtime.reply.delta", &json!({ "itemId": "item-final", "text": final_body, "status": "completed" }));
        append_on(&store, "attempt-final", 8, "runtime.turn.completed", &json!({ "status": "completed" }));
        settle(&store, "attempt-final", root, 9);
        let results = project_turn_results(&store, "attempt-final").unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].reply_text.as_deref(), Some(final_body.as_str()));
        assert!(results[0].reply_text.as_deref().unwrap().len() > 480);
        assert!(!results[0].reply_text.as_deref().unwrap().contains(progress));
        assert!(results[0].commands.iter().any(|command| command.command == "python3 -m pytest -q" && command.exit_code == Some(0)));
    }

    #[test]
    fn a_sealed_item_without_a_body_uses_only_its_own_deltas() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        git(root, &["init"]);
        git(root, &["config", "user.email", "turn@example.com"]);
        git(root, &["config", "user.name", "Turn"]);
        fs::write(root.join("base.txt"), "base\n").unwrap();
        git(root, &["add", "base.txt"]);
        git(root, &["commit", "-m", "base"]);
        let db = root.join("delta-item.sqlite");
        let store = prepared(&db, root, "attempt-delta");
        append_on(&store, "attempt-delta", 1, "workspace.baseline", &baseline_payload(root, "turn-delta"));
        append_on(&store, "attempt-delta", 2, "runtime.turn.started", &json!({ "status": "running" }));
        append_on(&store, "attempt-delta", 3, "runtime.reply.delta", &json!({ "itemId": "item-progress", "text": "checking", "status": "completed" }));
        append_on(&store, "attempt-delta", 4, "runtime.reply.delta", &json!({ "itemId": "item-final", "text": "only this item" }));
        append_on(&store, "attempt-delta", 5, "runtime.reply.delta", &json!({ "itemId": "item-final", "text": "", "status": "completed" }));
        append_on(&store, "attempt-delta", 6, "runtime.turn.completed", &json!({ "status": "completed" }));
        settle(&store, "attempt-delta", root, 7);
        let results = project_turn_results(&store, "attempt-delta").unwrap();
        assert_eq!(results[0].reply_text.as_deref(), Some("only this item"));
    }

    #[test]
    fn audit_baseline_areas_and_later_edit_does_not_recompute_history() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        git(root, &["init"]);
        git(root, &["config", "user.email", "turn@example.com"]);
        git(root, &["config", "user.name", "Turn"]);
        fs::write(root.join("keep.txt"), "keep\n").unwrap();
        fs::write(root.join("will-change.txt"), "old\n").unwrap();
        fs::write(root.join("will-delete.txt"), "gone\n").unwrap();
        fs::write(root.join("will-rename.txt"), "name\n").unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-m", "base"]);
        fs::write(root.join("staged.txt"), "staged\n").unwrap();
        git(root, &["add", "staged.txt"]);
        fs::write(root.join("will-change.txt"), "unstaged before\n").unwrap();
        fs::write(root.join("loose.txt"), "untracked before\n").unwrap();
        let head_before = head_of(root);
        let db = root.join("audit-files.sqlite");
        let store = prepared(&db, root, "attempt-files");
        append_on(&store, "attempt-files", 1, "workspace.baseline", &baseline_payload(root, "files"));
        assert_eq!(head_of(root), head_before, "recording a baseline changed HEAD");

        fs::write(root.join("will-change.txt"), "changed during\n").unwrap();
        fs::write(root.join("agent.txt"), "agent\n").unwrap();
        fs::write(root.join("hand.txt"), "hand\n").unwrap();
        fs::remove_file(root.join("will-delete.txt")).unwrap();
        git(root, &["mv", "will-rename.txt", "renamed.txt"]);
        append_on(&store, "attempt-files", 2, "runtime.tool.activity", &json!({
            "tool": "fileChange", "status": "completed", "paths": ["agent.txt"]
        }));
        append_on(&store, "attempt-files", 3, "runtime.turn.completed", &json!({ "status": "completed" }));
        settle(&store, "attempt-files", root, 4);
        let frozen = project_turn_results(&store, "attempt-files").unwrap();
        let result = &frozen[0];
        assert!(result.before.iter().any(|file| file.path == "staged.txt" && file.area == "staged"), "staged: {result:?}");
        assert!(result.before.iter().any(|file| file.path == "will-change.txt" && file.area == "unstaged"), "unstaged: {result:?}");
        assert!(result.before.iter().any(|file| file.path == "loose.txt" && file.area == "untracked"), "untracked: {result:?}");
        assert!(result.during.iter().any(|file| file.path == "agent.txt"), "agent file was not attributed: {result:?}");
        assert!(result.unattributed.iter().any(|file| file.path == "hand.txt"), "hand edit was attributed: {result:?}");
        assert!(result.during.iter().all(|file| file.path != "hand.txt"));
        assert!(result.unattributed.iter().any(|file| file.path == "will-change.txt" && file.change == "modified"));

        fs::write(root.join("agent.txt"), "rewritten after the turn\n").unwrap();
        git(root, &["add", "agent.txt"]);
        git(root, &["commit", "-m", "after"]);
        assert!(settlement_payload(&store, "attempt-files", root).unwrap().is_none());
        let again = project_turn_results(&store, "attempt-files").unwrap();
        assert_eq!(again, frozen, "reopening the result recomputed it from the workspace");
    }

    #[test]
    fn audit_command_facts_stay_literal_and_output_is_bounded() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        git(root, &["init"]);
        git(root, &["config", "user.email", "turn@example.com"]);
        git(root, &["config", "user.name", "Turn"]);
        fs::write(root.join("base.txt"), "base\n").unwrap();
        git(root, &["add", "base.txt"]);
        git(root, &["commit", "-m", "base"]);
        let store = prepared(&root.join("audit-commands.sqlite"), root, "attempt-commands");
        append_on(&store, "attempt-commands", 1, "workspace.baseline", &baseline_payload(root, "commands"));
        let long_output = "x".repeat(900);
        append_on(&store, "attempt-commands", 2, "runtime.tool.activity", &json!({
            "tool": "commandExecution", "command": "sleep 5", "cwd": "/work", "status": "started"
        }));
        append_on(&store, "attempt-commands", 3, "runtime.tool.activity", &json!({
            "tool": "commandExecution", "command": "echo ok", "status": "completed", "exitCode": 0, "output": "ok"
        }));
        append_on(&store, "attempt-commands", 4, "runtime.tool.activity", &json!({
            "tool": "commandExecution", "command": "echo fail", "status": "completed", "exitCode": 2, "output": "no"
        }));
        append_on(&store, "attempt-commands", 5, "runtime.tool.activity", &json!({
            "tool": "commandExecution", "command": "echo maybe", "status": "completed", "output": long_output
        }));
        append_on(&store, "attempt-commands", 6, "runtime.reply.delta", &json!({
            "text": "tests passed", "status": "completed"
        }));
        append_on(&store, "attempt-commands", 7, "runtime.turn.completed", &json!({ "status": "completed" }));
        settle(&store, "attempt-commands", root, 8);
        let commands = &project_turn_results(&store, "attempt-commands").unwrap()[0].commands;
        assert_eq!(commands[0].command, "sleep 5");
        assert_eq!(commands[0].state, "started");
        assert_eq!(commands[0].exit_code, None);
        assert_eq!(commands[1].exit_code, Some(0));
        assert_eq!(commands[1].state, "completed");
        assert_eq!(commands[2].exit_code, Some(2));
        assert_eq!(commands[2].state, "failed");
        assert_eq!(commands[3].command, "echo maybe");
        assert_eq!(commands[3].exit_code, None);
        assert_eq!(commands[3].state, "completed");
        assert_eq!(commands[3].output.as_ref().map(String::len), Some(OUTPUT_CHARS));
        assert!(commands.iter().all(|command| command.command != "tests passed"));
    }

    #[test]
    fn audit_missing_baseline_and_non_git_workspace_do_not_invent_a_diff() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        fs::write(root.join("note.txt"), "not a repo\n").unwrap();
        let captured = baseline_payload(root, "no-git");
        assert_eq!(captured["recorded"], false);
        git(root, &["init"]);
        let head = Command::new("git").arg("-C").arg(root).args(["rev-parse", "HEAD"]).output().unwrap();
        let _ = baseline_payload(root, "still-no-commit");
        let head_after = Command::new("git").arg("-C").arg(root).args(["rev-parse", "HEAD"]).output().unwrap();
        assert_eq!((head.status.code(), head.stdout.clone()), (head_after.status.code(), head_after.stdout));

        let store = prepared(&root.join("audit-missing.sqlite"), root, "attempt-missing");
        append_on(&store, "attempt-missing", 1, "runtime.turn.completed", &json!({ "status": "completed", "text": "old turn" }));
        settle(&store, "attempt-missing", root, 2);
        let result = &project_turn_results(&store, "attempt-missing").unwrap()[0];
        assert!(!result.baseline_recorded);
        assert!(result.before.is_empty() && result.during.is_empty() && result.unattributed.is_empty());
    }

    fn prepared(db: &Path, root: &Path, attempt_id: &str) -> Store {
        let store = Store::open(db).unwrap();
        let project = Project { id: format!("project-{attempt_id}"), workspace_root: root.to_string_lossy().to_string() };
        let campaign = Campaign {
            id: format!("campaign-{attempt_id}"),
            goal: "audit".into(),
            root_task_id: format!("task-{attempt_id}"),
            state: WorkStatus::InProgress,
        };
        let task = Task {
            id: format!("task-{attempt_id}"),
            campaign_id: campaign.id.clone(),
            title: "Audit".into(),
            acceptance: "check".into(),
            state: WorkStatus::InProgress,
        };
        store.create_workspace_campaign(&project, &campaign, &task, &format!("policy-{attempt_id}"), "{}", &CampaignAuthorization::granted()).unwrap();
        store.insert_attempt(&Attempt::new(attempt_id, &task.id, "scenario", "scenario-cap-v1")).unwrap();
        store
    }

    fn head_of(root: &Path) -> Vec<u8> {
        Command::new("git").arg("-C").arg(root).args(["rev-parse", "HEAD"]).output().unwrap().stdout
    }

    #[test]
    fn porcelain_v1_z_keeps_both_paths_for_rename_and_copy() {
        let cases: &[(&[u8], &str, Option<&str>, &str)] = &[
            (b" D gone.txt\0", "gone.txt", None, "deleted"),
            (b"D  gone.txt\0", "gone.txt", None, "deleted"),
            (b"R  b.txt\0a.txt\0", "b.txt", Some("a.txt"), "renamed"),
            (b" R new.txt\0old.txt\0", "new.txt", Some("old.txt"), "renamed"),
            (b"RM moved.txt\0source.txt\0", "moved.txt", Some("source.txt"), "renamed"),
            (b"R  c d.txt\0a b.txt\0", "c d.txt", Some("a b.txt"), "renamed"),
            (b"R  b->c.txt\0a.txt\0", "b->c.txt", Some("a.txt"), "renamed"),
            ("R  目标.txt\0源.txt\0".as_bytes(), "目标.txt", Some("源.txt"), "renamed"),
            (b"C  copy.txt\0orig.txt\0", "copy.txt", Some("orig.txt"), "copied"),
            (b"A  staged.txt\0", "staged.txt", None, "added"),
            (b" M changed.txt\0", "changed.txt", None, "modified"),
            (b"?? loose file.txt\0", "loose file.txt", None, "added"),
        ];
        for (bytes, path, from, change) in cases {
            let records = parse_porcelain_records(bytes);
            assert_eq!(records.len(), 1, "{}", String::from_utf8_lossy(bytes));
            assert_eq!(records[0].path, *path);
            assert_eq!(records[0].from_path.as_deref(), *from);
            assert_eq!(change_kind(records[0].x, records[0].y), *change);
        }
    }

    #[test]
    fn unsettled_terminal_uses_its_own_baseline_for_disappeared_files() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        git(root, &["init", "--quiet"]);
        fs::write(root.join("earlier.txt"), "earlier dirty baseline\n").unwrap();
        let store = prepared(&root.join("core.sqlite"), root, "attempt-older-terminal");
        append_on(&store, "attempt-older-terminal", 1, "workspace.baseline", &baseline_payload(root, "older-turn"));
        fs::remove_file(root.join("earlier.txt")).unwrap();
        append_on(&store, "attempt-older-terminal", 2, "runtime.turn.completed", &json!({"status":"completed"}));
        append_on(&store, "attempt-older-terminal", 3, "workspace.baseline", &baseline_payload(root, "later-turn"));
        let result = settlement_payload(&store, "attempt-older-terminal", root).unwrap().unwrap();
        assert_eq!(result["terminalSeq"], 2);
        assert_eq!(result["requestId"], "older-turn");
        assert!(result["unattributed"].as_array().unwrap().iter().any(|file| file["path"] == "earlier.txt" && file["change"] == "deleted"), "older terminal must retain its baseline disappearance: {result}");
    }

    #[test]
    fn a_baseline_file_that_vanishes_is_a_turn_change() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        git(root, &["init"]);
        git(root, &["config", "user.email", "turn@example.com"]);
        git(root, &["config", "user.name", "Turn"]);
        fs::write(root.join("tracked.txt"), "committed\n").unwrap();
        git(root, &["add", "tracked.txt"]);
        git(root, &["commit", "-m", "base"]);
        fs::write(root.join("tracked.txt"), "dirty before the turn\n").unwrap();
        fs::write(root.join("scratch.txt"), "user file\n").unwrap();
        let db = root.join("vanish.sqlite");
        let store = prepared(&db, root, "attempt-vanish");
        append_on(&store, "attempt-vanish", 1, "workspace.baseline", &baseline_payload(root, "vanish"));
        fs::write(root.join("tracked.txt"), "committed\n").unwrap();
        fs::remove_file(root.join("scratch.txt")).unwrap();
        append_on(&store, "attempt-vanish", 2, "runtime.turn.completed", &json!({ "status": "completed" }));
        settle(&store, "attempt-vanish", root, 3);
        let result = &project_turn_results(&store, "attempt-vanish").unwrap()[0];
        assert!(result.before.iter().any(|file| file.path == "scratch.txt"), "{result:?}");
        assert!(result.before.iter().any(|file| file.path == "tracked.txt"), "{result:?}");
        let deleted = result.unattributed.iter().find(|file| file.path == "scratch.txt").expect("deleted scratch");
        assert_eq!(deleted.change, "deleted");
        assert_eq!(deleted.content_inspection, "not-applicable");
        let restored = result.unattributed.iter().find(|file| file.path == "tracked.txt").expect("restored tracked");
        assert_eq!(restored.change, "modified");
    }

    #[test]
    fn more_than_the_file_cap_is_marked_truncated() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        git(root, &["init"]);
        git(root, &["config", "user.email", "turn@example.com"]);
        git(root, &["config", "user.name", "Turn"]);
        fs::write(root.join("base.txt"), "base\n").unwrap();
        git(root, &["add", "base.txt"]);
        git(root, &["commit", "-m", "base"]);
        for index in 0..=MAX_FILES {
            fs::write(root.join(format!("extra-{index}.txt")), "x\n").unwrap();
        }
        let payload = baseline_payload(root, "many");
        assert_eq!(payload["entriesTruncated"], true);
        assert_eq!(payload["entries"].as_array().unwrap().len(), MAX_FILES);
        let db = root.join("many.sqlite");
        let store = prepared(&db, root, "attempt-many");
        append_on(&store, "attempt-many", 1, "workspace.baseline", &payload);
        append_on(&store, "attempt-many", 2, "runtime.turn.completed", &json!({ "status": "completed" }));
        settle(&store, "attempt-many", root, 3);
        let result = &project_turn_results(&store, "attempt-many").unwrap()[0];
        assert!(result.files_truncated, "{result:?}");
        assert_eq!(result.before.len(), MAX_FILES);
    }

    #[test]
    fn a_failed_end_status_does_not_invent_file_changes() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        git(root, &["init"]);
        git(root, &["config", "user.email", "turn@example.com"]);
        git(root, &["config", "user.name", "Turn"]);
        fs::write(root.join("tracked.txt"), "committed\n").unwrap();
        git(root, &["add", "tracked.txt"]);
        git(root, &["commit", "-m", "base"]);
        fs::write(root.join("tracked.txt"), "dirty\n").unwrap();
        fs::write(root.join("scratch.txt"), "user file\n").unwrap();
        let payload = baseline_payload(root, "unreadable-end");
        assert_eq!(payload["recorded"], true);
        let db = root.join("unreadable.sqlite");
        let store = prepared(&db, root, "attempt-unreadable");
        append_on(&store, "attempt-unreadable", 1, "workspace.baseline", &payload);
        fs::rename(root.join(".git"), root.join("git-hidden")).unwrap();
        append_on(&store, "attempt-unreadable", 2, "runtime.turn.completed", &json!({ "status": "completed" }));
        settle(&store, "attempt-unreadable", root, 3);
        let result = &project_turn_results(&store, "attempt-unreadable").unwrap()[0];
        assert!(result.comparison_unavailable, "{result:?}");
        assert!(result.before.iter().any(|file| file.path == "tracked.txt"));
        assert!(result.before.iter().any(|file| file.path == "scratch.txt"));
        assert!(result.during.is_empty() && result.unattributed.is_empty(), "{result:?}");
    }

    #[test]
    fn a_truncated_window_shift_does_not_invent_a_change() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        git(root, &["init"]);
        git(root, &["config", "user.email", "turn@example.com"]);
        git(root, &["config", "user.name", "Turn"]);
        fs::write(root.join("base.txt"), "base\n").unwrap();
        git(root, &["add", "base.txt"]);
        git(root, &["commit", "-m", "base"]);
        for index in 0..=MAX_FILES {
            fs::write(root.join(format!("file-{index:03}.txt")), "same\n").unwrap();
        }
        let payload = baseline_payload(root, "shift");
        assert_eq!(payload["entriesTruncated"], true);
        let captured: Vec<String> = payload["entries"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|entry| entry.get("path").and_then(Value::as_str).map(str::to_owned))
            .collect();
        fs::write(root.join("000-shift.txt"), "new\n").unwrap();
        let db = root.join("shift.sqlite");
        let store = prepared(&db, root, "attempt-shift");
        append_on(&store, "attempt-shift", 1, "workspace.baseline", &payload);
        append_on(&store, "attempt-shift", 2, "runtime.turn.completed", &json!({ "status": "completed" }));
        settle(&store, "attempt-shift", root, 3);
        let result = &project_turn_results(&store, "attempt-shift").unwrap()[0];
        assert!(result.files_truncated);
        assert!(!result.comparison_unavailable);
        let invented = result.during.iter().chain(result.unattributed.iter()).any(|file| {
            captured.iter().any(|path| path == &file.path) && (file.change == "modified" || file.change == "deleted")
        });
        assert!(!invented, "{result:?}");
        assert!(
            result.unattributed.iter().chain(result.during.iter()).all(|file| file.path != "000-shift.txt"),
            "a path outside the captured baseline is not an add: {result:?}"
        );
    }

    #[test]
    fn a_path_sliding_into_a_truncated_window_is_not_an_add() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("repo");
        fs::create_dir(&root).unwrap();
        git(&root, &["init"]);
        git(&root, &["config", "user.email", "turn@example.com"]);
        git(&root, &["config", "user.name", "Turn"]);
        fs::write(root.join("base.txt"), "base\n").unwrap();
        git(&root, &["add", "base.txt"]);
        git(&root, &["commit", "-m", "base"]);
        for index in 0..=MAX_FILES {
            fs::write(root.join(format!("file-{index:03}.txt")), "same\n").unwrap();
        }
        let payload = baseline_payload(&root, "slide");
        assert_eq!(payload["entriesTruncated"], true);
        let captured: Vec<String> = payload["entries"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|entry| entry.get("path").and_then(Value::as_str).map(str::to_owned))
            .collect();
        assert!(captured.iter().any(|path| path == "file-000.txt"), "{captured:?}");
        assert!(!captured.iter().any(|path| path == "file-080.txt"), "{captured:?}");
        fs::remove_file(root.join("file-000.txt")).unwrap();
        let db = directory.path().join("slide.sqlite");
        let store = prepared(&db, &root, "attempt-slide");
        append_on(&store, "attempt-slide", 1, "workspace.baseline", &payload);
        append_on(&store, "attempt-slide", 2, "runtime.turn.completed", &json!({ "status": "completed" }));
        settle(&store, "attempt-slide", &root, 3);
        let result = &project_turn_results(&store, "attempt-slide").unwrap()[0];
        assert!(result.files_truncated);
        assert!(!result.comparison_unavailable);
        let deleted = result.unattributed.iter().chain(result.during.iter()).find(|file| file.path == "file-000.txt");
        assert_eq!(deleted.map(|file| file.change.as_str()), Some("deleted"), "{result:?}");
        assert!(
            result.unattributed.iter().chain(result.during.iter()).all(|file| file.path != "file-080.txt"),
            "the pre-existing file that slid into the window is not an add: {result:?}"
        );
    }

    #[test]
    fn a_reply_past_the_storage_cap_is_marked_truncated() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        git(root, &["init"]);
        git(root, &["config", "user.email", "turn@example.com"]);
        git(root, &["config", "user.name", "Turn"]);
        fs::write(root.join("base.txt"), "base\n").unwrap();
        git(root, &["add", "base.txt"]);
        git(root, &["commit", "-m", "base"]);
        let db = root.join("long.sqlite");
        let store = prepared(&db, root, "attempt-long");
        let body = "y".repeat(REPLY_STORAGE_CHARS + 24);
        append_on(&store, "attempt-long", 1, "workspace.baseline", &baseline_payload(root, "long"));
        append_on(&store, "attempt-long", 2, "runtime.turn.started", &json!({ "status": "running" }));
        append_on(&store, "attempt-long", 3, "runtime.reply.delta", &json!({ "itemId": "item-final", "text": body, "status": "completed" }));
        append_on(&store, "attempt-long", 4, "runtime.turn.completed", &json!({ "status": "completed" }));
        settle(&store, "attempt-long", root, 5);
        let result = &project_turn_results(&store, "attempt-long").unwrap()[0];
        assert!(result.reply_truncated);
        assert_eq!(result.reply_text.as_deref().unwrap().chars().count(), REPLY_STORAGE_CHARS);
        assert!(!result.reply_text.as_deref().unwrap().contains("progress"));
    }

    #[test]
    fn audit_delete_rename_inspection_and_frozen_reopen() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("repo");
        fs::create_dir(&root).unwrap();
        git(&root, &["init"]);
        git(&root, &["config", "user.email", "turn@example.com"]);
        git(&root, &["config", "user.name", "Turn"]);
        fs::write(root.join("tracked.txt"), "tracked\n").unwrap();
        fs::write(root.join("rename-src.txt"), "name\n").unwrap();
        fs::write(root.join("edit-me.txt"), "old\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-m", "base"]);
        fs::write(root.join("staged.txt"), "staged\n").unwrap();
        git(&root, &["add", "staged.txt"]);
        fs::write(root.join("edit-me.txt"), "unstaged before\n").unwrap();
        fs::write(root.join("loose.txt"), "loose\n").unwrap();

        let db = directory.path().join("core.sqlite");
        let store = prepared(&db, &root, "attempt-gates");
        append_on(&store, "attempt-gates", 1, "workspace.baseline", &baseline_payload(&root, "gates"));
        fs::remove_file(root.join("tracked.txt")).unwrap();
        git(&root, &["mv", "rename-src.txt", "rename-dst.txt"]);
        fs::write(root.join("rename-dst.txt"), "name\nedited after rename\n").unwrap();
        fs::write(root.join("binary.bin"), b"hello\0world").unwrap();
        fs::write(root.join("big.bin"), vec![b'a'; (CONTENT_LIMIT as usize) + 1]).unwrap();
        #[cfg(unix)]
        {
            let locked = root.join("locked.txt");
            fs::write(&locked, "secret\n").unwrap();
            let _ = std::fs::set_permissions(&locked, std::os::unix::fs::PermissionsExt::from_mode(0));
        }
        append_on(&store, "attempt-gates", 2, "runtime.turn.completed", &json!({ "status": "completed" }));
        settle(&store, "attempt-gates", &root, 3);
        #[cfg(unix)]
        {
            let _ = std::fs::set_permissions(root.join("locked.txt"), std::os::unix::fs::PermissionsExt::from_mode(0o644));
        }

        let frozen = project_turn_results(&store, "attempt-gates").unwrap();
        let result = &frozen[0];
        assert!(result.before.iter().any(|file| file.path == "staged.txt" && file.area == "staged"), "{result:?}");
        assert!(result.before.iter().any(|file| file.path == "edit-me.txt" && file.area == "unstaged"), "{result:?}");
        assert!(result.before.iter().any(|file| file.path == "loose.txt" && file.area == "untracked"), "{result:?}");
        let deleted = result.unattributed.iter().chain(result.during.iter()).find(|file| file.path == "tracked.txt").expect("delete missing");
        assert_eq!(deleted.change, "deleted");
        assert_eq!(deleted.content_inspection, "not-applicable");
        let renamed: Vec<_> = result.unattributed.iter().chain(result.during.iter()).filter(|file| file.change == "renamed").collect();
        assert_eq!(renamed.len(), 1, "{result:?}");
        assert_eq!(renamed[0].from_path.as_deref(), Some("rename-src.txt"));
        assert_eq!(renamed[0].path, "rename-dst.txt");
        assert!(result.unattributed.iter().chain(result.during.iter()).all(|file| file.path != "rename-src.txt" || file.change == "renamed"));
        assert!(result.unattributed.iter().any(|file| file.path == "binary.bin" && file.content_inspection == "binary"), "{result:?}");
        assert!(result.unattributed.iter().any(|file| file.path == "big.bin" && file.content_inspection == "too-large"), "{result:?}");
        #[cfg(unix)]
        assert!(result.unattributed.iter().any(|file| file.path == "locked.txt" && file.content_inspection == "unreadable"), "{result:?}");

        fs::write(root.join("rename-dst.txt"), "replaced after settlement\n").unwrap();
        git(&root, &["add", "rename-dst.txt"]);
        git(&root, &["commit", "-m", "later"]);
        assert!(settlement_payload(&store, "attempt-gates", &root).unwrap().is_none());
        drop(store);
        let reopened = Store::open(&db).unwrap();
        assert_eq!(project_turn_results(&reopened, "attempt-gates").unwrap(), frozen);
    }
}
