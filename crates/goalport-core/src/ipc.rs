//! Versioned local IPC for the detached Core.
//!
//! Windows builds use a Named Pipe whose security descriptor is set explicitly:
//! only the Windows user that runs Core has access, remote clients are rejected,
//! Core never joins a pipe name created by someone else, and every instance is
//! read back and verified before use (fail closed). The JSON framing and request
//! ledger are platform-independent, which lets contract tests run without a
//! desktop or a provider Runtime.

use crate::{
    commands::{CommandError, CommandExecution, CommandProcessor, CoreCommand, CoreOperation},
    projection::{UiCommandResult, UiController},
    response_bounds::{MAX_RESPONSE_BYTES, bound_error, bound_result_metadata, bound_ui_response},
    store::{Store, StoreError},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    io::{self, Read, Write},
    sync::{Arc, Mutex, Once},
    thread,
    time::Duration,
};
use thiserror::Error;

pub const IPC_PROTOCOL_VERSION: &str = "goalport.ipc.v1";
/// Versioned UI projection/command envelope. The legacy IPC v1 envelope is
/// retained for Core contract clients and accepted by the same server.
pub const CONNECTED_UI_PROTOCOL_VERSION: &str = "goalport.ipc.v2";
pub const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IpcRequest {
    pub protocol_version: String,
    pub request_id: String,
    pub entity_version: i64,
    pub command: CoreCommand,
}

impl IpcRequest {
    pub fn new(request_id: impl Into<String>, command: CoreCommand) -> Self {
        Self {
            protocol_version: IPC_PROTOCOL_VERSION.into(),
            request_id: request_id.into(),
            entity_version: 1,
            command,
        }
    }

    pub fn validate(&self) -> Result<(), IpcError> {
        validate_header(&self.protocol_version, &self.request_id, None)?;
        if self.protocol_version != IPC_PROTOCOL_VERSION
            && self.protocol_version != CONNECTED_UI_PROTOCOL_VERSION
        {
            return Err(IpcError::ProtocolVersion {
                expected: IPC_PROTOCOL_VERSION.into(),
                received: self.protocol_version.clone(),
            });
        }
        if self.entity_version <= 0 {
            return Err(IpcError::Invalid("entity_version must be positive".into()));
        }
        validate_core_command_ids(&self.command)?;
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IpcResponse {
    pub protocol_version: String,
    pub request_id: String,
    pub entity_version: i64,
    pub ok: bool,
    pub duplicate: bool,
    pub result: Option<CommandExecution>,
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_truncated: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_reference: Option<Value>,
}

/// Compatibility wire shape used by the thin Tauri bridge. It is intentionally
/// kept as a transport DTO; it is converted to a typed `CoreCommand` before any
/// domain mutation is allowed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiCommandRequest {
    #[serde(alias = "protocol_version")]
    pub protocol_version: String,
    #[serde(alias = "request_id")]
    pub request_id: String,
    #[serde(alias = "entity_version")]
    pub entity_version: i64,
    #[serde(alias = "message_type")]
    pub message_type: String,
    #[serde(default)]
    pub payload: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiCommandResponse {
    pub protocol_version: &'static str,
    pub request_id: String,
    pub entity_version: i64,
    pub ok: bool,
    pub payload: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl UiCommandRequest {
    pub fn validate(&self) -> Result<(), IpcError> {
        validate_header(
            &self.protocol_version,
            &self.request_id,
            Some(&self.message_type),
        )?;
        if self.protocol_version != IPC_PROTOCOL_VERSION
            && self.protocol_version != CONNECTED_UI_PROTOCOL_VERSION
        {
            return Err(IpcError::ProtocolVersion {
                expected: IPC_PROTOCOL_VERSION.into(),
                received: self.protocol_version.clone(),
            });
        }
        if self.entity_version < 0 {
            return Err(IpcError::Invalid(
                "entity_version must be non-negative".into(),
            ));
        }
        if !supported_ui_message(&self.message_type) {
            return Err(IpcError::Invalid("unsupported message_type".into()));
        }
        validate_ui_operational_ids(&self.payload)?;
        Ok(())
    }
}

fn validate_header(
    protocol_version: &str,
    request_id: &str,
    message_type: Option<&str>,
) -> Result<(), IpcError> {
    if protocol_version.is_empty() || protocol_version.as_bytes().len() > 64 {
        return Err(IpcError::Invalid(
            "protocol_version is empty or exceeds 64 bytes".into(),
        ));
    }
    if request_id.trim().is_empty() || request_id.as_bytes().len() > 256 {
        return Err(IpcError::Invalid(
            "request_id is empty or exceeds 256 bytes".into(),
        ));
    }
    if let Some(message_type) = message_type
        && (message_type.trim().is_empty() || message_type.as_bytes().len() > 64)
    {
        return Err(IpcError::Invalid(
            "message_type is empty or exceeds 64 bytes".into(),
        ));
    }
    Ok(())
}

fn supported_ui_message(value: &str) -> bool {
    matches!(
        value,
        "snapshot"
            | "snapshot_if_changed"
            | "select_project"
            | "select_campaign"
            | "create_campaign"
            | "create_campaign_with_task"
            | "select_runtime"
            | "select_attempt"
            | "start_conversation"
            | "conversation_send"
            | "rename_conversation"
            | "send_message"
            | "resolve_decision"
            | "permission_response"
            | "interrupt"
            | "safe_stop"
            | "cancel"
            | "reconnect"
            | "handoff"
            | "reassign"
            | "revoke_authorization"
            | "request_owner_action"
            | "resume_native_session"
            | "continue_in_isolated_workspace"
            | "recheck_stop_responsibility"
            | "classify_recovery"
            | "close_session"
            | "close_adapter_transport"
            | "mark_runtime_exit"
            | "observe_workspace_edit"
            | "queue_override"
            | "record_close_choice"
            | "get_startup_receipt"
            | "get_close_choice_receipt"
            | "history_page"
            | "goal_overview"
            | "goal_detail"
    )
}

fn validate_ui_operational_ids(value: &Value) -> Result<(), IpcError> {
    fn visit(value: &Value, key: Option<&str>) -> Result<(), IpcError> {
        if let (Some(key), Some(text)) = (key, value.as_str()) {
            let lower = key.to_ascii_lowercase();
            let identifier = matches!(
                lower.as_str(),
                "projectid"
                    | "project_id"
                    | "campaignid"
                    | "campaign_id"
                    | "taskid"
                    | "task_id"
                    | "attemptid"
                    | "attempt_id"
                    | "sourceattemptid"
                    | "source_attempt_id"
                    | "decisionid"
                    | "decision_id"
                    | "requestid"
                    | "request_id"
                    | "operationid"
                    | "operation_id"
                    | "receiptid"
                    | "receipt_id"
                    | "queueid"
                    | "queue_id"
                    | "requestreference"
            );
            if identifier && text.as_bytes().len() > 256 {
                return Err(IpcError::Invalid(format!(
                    "operational identifier {key} exceeds 256 bytes"
                )));
            }
            if matches!(lower.as_str(), "workspaceroot" | "workspace_root")
                && serde_json::to_vec(text)?.len() > 128 * 1024
            {
                return Err(IpcError::Invalid("workspace path exceeds 128 KiB".into()));
            }
        }
        match value {
            Value::Object(map) => {
                for (child_key, child) in map {
                    visit(child, Some(child_key))?;
                }
            }
            Value::Array(values) => {
                for child in values {
                    visit(child, key)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
    visit(value, None)
}

fn validate_goalport_id(name: &str, value: &str) -> Result<(), IpcError> {
    if value.as_bytes().len() > 256 {
        return Err(IpcError::Invalid(format!(
            "operational identifier {name} exceeds 256 bytes"
        )));
    }
    Ok(())
}

fn validate_core_command_ids(command: &CoreCommand) -> Result<(), IpcError> {
    validate_goalport_id("command.id", &command.command.id)?;
    validate_goalport_id("command.attempt_id", &command.command.attempt_id)?;
    match &command.operation {
        CoreOperation::TransitionAttempt {
            attempt_id,
            event_id,
            ..
        } => {
            validate_goalport_id("attempt_id", attempt_id)?;
            validate_goalport_id("event_id", event_id)?;
        }
        CoreOperation::AppendEvent { event } => {
            validate_goalport_id("event.id", &event.id)?;
            validate_goalport_id("event.attempt_id", &event.attempt_id)?;
        }
        CoreOperation::AcquireLease { lease } => {
            validate_goalport_id("lease.attempt_id", &lease.attempt_id)?;
        }
        CoreOperation::ReleaseLease { attempt_id, .. }
        | CoreOperation::RevokeLease { attempt_id, .. } => {
            validate_goalport_id("attempt_id", attempt_id)?;
        }
        CoreOperation::MarkOutboxUnknown { outbox_id, .. }
        | CoreOperation::ReconcileOutbox { outbox_id, .. } => {
            validate_goalport_id("outbox_id", outbox_id)?;
        }
    }
    Ok(())
}

impl IpcResponse {
    fn error(request: &IpcRequest, error: impl Into<String>) -> Self {
        Self {
            protocol_version: IPC_PROTOCOL_VERSION.into(),
            request_id: if request.request_id.as_bytes().len() <= 256 {
                request.request_id.clone()
            } else {
                String::new()
            },
            entity_version: request.entity_version,
            ok: false,
            duplicate: false,
            result: None,
            error: Some(bound_error(&error.into())),
            result_truncated: None,
            result_reference: None,
        }
    }
}

fn bound_legacy_response(mut response: IpcResponse) -> IpcResponse {
    if let Some(error) = response.error.take() {
        response.error = Some(bound_error(&error));
    }
    if serde_json::to_vec(&response).is_ok_and(|bytes| bytes.len() <= MAX_RESPONSE_BYTES) {
        return response;
    }
    let reference = response.result.as_ref().map(|result| {
        serde_json::json!({
            "commandId": result.command.id,
            "attemptId": result.command.attempt_id,
            "state": format!("{:?}", result.command.state).to_ascii_uppercase()
        })
    });
    response.result = None;
    response.result_truncated = Some(true);
    response.result_reference = reference;
    response
}

#[derive(Debug, Error)]
pub enum IpcError {
    #[error("ipc protocol version mismatch: expected {expected}, received {received}")]
    ProtocolVersion { expected: String, received: String },
    #[error("invalid ipc message: {0}")]
    Invalid(String),
    #[error("ipc frame exceeds maximum size: {0} bytes")]
    FrameTooLarge(usize),
    #[error("ipc stream ended before a complete frame")]
    TruncatedFrame,
    #[error("ipc io error: {0}")]
    Io(#[from] io::Error),
    #[error("ipc json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("command error: {0}")]
    Command(#[from] CommandError),
    #[error("store error: {0}")]
    Store(#[from] StoreError),
    #[error("named pipes are unavailable on this platform")]
    UnsupportedPlatform,
    #[error("local Unix socket Core serve is only supported on Linux")]
    UnixSocketUnsupported,
    /// Security setup or verification of a named pipe failed. The message is
    /// bounded: it carries a fixed stage name and an OS code, never a SID,
    /// security descriptor or path.
    #[error("named pipe security setup failed at {stage} (os error {code})")]
    PipeSecurity { stage: &'static str, code: i32 },
    #[error("named pipe name is already in use by another instance")]
    PipeNameOccupied,
}

/// Security descriptor of every Core pipe instance: owner and group are the
/// Core process user, and the protected DACL grants full access to that user
/// only (no SYSTEM, Administrators, Everyone or Anonymous entries).
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn pipe_sddl(user_sid: &str) -> String {
    format!("O:{user_sid}G:{user_sid}D:P(A;;FA;;;{user_sid})")
}

/// Identity of the process serving a named pipe, as proven by
/// [`verify_pipe_peer`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PipePeer {
    pub server_pid: u32,
}

pub fn encode_frame<T: Serialize>(value: &T) -> Result<Vec<u8>, IpcError> {
    let payload = serde_json::to_vec(value)?;
    if payload.len() > MAX_FRAME_BYTES {
        return Err(IpcError::FrameTooLarge(payload.len()));
    }
    let length =
        u32::try_from(payload.len()).map_err(|_| IpcError::FrameTooLarge(payload.len()))?;
    let mut frame = Vec::with_capacity(4 + payload.len());
    frame.extend_from_slice(&length.to_le_bytes());
    frame.extend_from_slice(&payload);
    Ok(frame)
}

pub fn decode_frame<T: for<'de> Deserialize<'de>>(frame: &[u8]) -> Result<T, IpcError> {
    if frame.len() < 4 {
        return Err(IpcError::TruncatedFrame);
    }
    let length = u32::from_le_bytes([frame[0], frame[1], frame[2], frame[3]]) as usize;
    if length > MAX_FRAME_BYTES {
        return Err(IpcError::FrameTooLarge(length));
    }
    if frame.len() != length + 4 {
        return Err(IpcError::TruncatedFrame);
    }
    Ok(serde_json::from_slice(&frame[4..])?)
}

pub fn read_frame<R: Read>(reader: &mut R) -> Result<Option<Vec<u8>>, IpcError> {
    let mut header = [0_u8; 4];
    let mut read = 0;
    while read < header.len() {
        let count = reader.read(&mut header[read..])?;
        if count == 0 {
            return if read == 0 {
                Ok(None)
            } else {
                Err(IpcError::TruncatedFrame)
            };
        }
        read += count;
    }
    let length = u32::from_le_bytes(header) as usize;
    if length > MAX_FRAME_BYTES {
        return Err(IpcError::FrameTooLarge(length));
    }
    let mut payload = vec![0_u8; length];
    reader.read_exact(&mut payload)?;
    let mut frame = Vec::with_capacity(length + 4);
    frame.extend_from_slice(&header);
    frame.extend_from_slice(&payload);
    Ok(Some(frame))
}

pub fn write_frame<W: Write, T: Serialize>(writer: &mut W, value: &T) -> Result<(), IpcError> {
    writer.write_all(&encode_frame(value)?)?;
    writer.flush()?;
    Ok(())
}

#[derive(Default, Debug)]
struct RequestLedger {
    responses: HashMap<String, IpcResponse>,
}

#[derive(Clone, Debug)]
pub struct CoreServer {
    processor: CommandProcessor,
    ledger: Arc<Mutex<RequestLedger>>,
    ui: Arc<Mutex<UiController>>,
    flusher_started: Arc<Once>,
}

impl CoreServer {
    pub fn new(store: Store) -> Self {
        let ui = UiController::new(store.clone())
            .unwrap_or_else(|error| panic!("unable to initialize Core UI projection: {error}"));
        Self::with_ui(store, ui)
    }

    /// Explicit constructor for tests that still exercise the legacy seeded
    /// projection. Production startup uses `new` and leaves a fresh Store empty.
    pub fn new_seeded_fixture(store: Store, workspace_root: impl Into<String>) -> Self {
        let ui = UiController::new_seeded_fixture(store.clone(), workspace_root)
            .unwrap_or_else(|error| panic!("unable to initialize seeded Core fixture: {error}"));
        Self::with_ui(store, ui)
    }

    /// Empty-store constructor with the native Runtime firewall forced on,
    /// intended for parallel-safe synthetic acceptance tests.
    pub fn new_synthetic_only(store: Store) -> Self {
        let ui = UiController::new_synthetic_only(store.clone())
            .unwrap_or_else(|error| panic!("unable to initialize synthetic-only Core: {error}"));
        Self::with_ui(store, ui)
    }

    fn with_ui(store: Store, ui: UiController) -> Self {
        Self {
            processor: CommandProcessor::new(store),
            ledger: Arc::new(Mutex::new(RequestLedger::default())),
            ui: Arc::new(Mutex::new(ui)),
            flusher_started: Arc::new(Once::new()),
        }
    }

    /// Keep Runtime event persistence independent from the desktop connection.
    /// A dropped window therefore cannot prevent provider output from reaching
    /// SQLite before a later cursor reconnect.
    pub fn start_runtime_flusher(&self) {
        let ui = Arc::downgrade(&self.ui);
        self.flusher_started.call_once(|| {
            thread::Builder::new()
                .name("goalport-runtime-flusher".into())
                .spawn(move || {
                    loop {
                        let Some(ui) = ui.upgrade() else { break };
                        if let Ok(mut controller) = ui.lock() {
                            let _ = controller.flush_runtime_events();
                        }
                        thread::sleep(Duration::from_millis(100));
                    }
                })
                .expect("unable to start Runtime event flusher");
        });
    }

    pub fn handle(&self, request: IpcRequest) -> IpcResponse {
        if let Err(error) = request.validate() {
            return bound_legacy_response(IpcResponse::error(&request, error.to_string()));
        }
        if let Some(response) = self
            .ledger
            .lock()
            .expect("ipc ledger poisoned")
            .responses
            .get(&request.request_id)
            .cloned()
        {
            return IpcResponse {
                duplicate: true,
                ..response
            };
        }
        let response = match self.processor.execute(request.command.clone()) {
            Ok(result) => IpcResponse {
                protocol_version: IPC_PROTOCOL_VERSION.into(),
                request_id: request.request_id.clone(),
                entity_version: request.entity_version,
                ok: true,
                duplicate: result.duplicate,
                result: Some(result),
                error: None,
                result_truncated: None,
                result_reference: None,
            },
            Err(error) => IpcResponse::error(&request, error.to_string()),
        };
        let response = bound_legacy_response(response);
        self.ledger
            .lock()
            .expect("ipc ledger poisoned")
            .responses
            .insert(request.request_id, response.clone());
        response
    }

    #[cfg(not(target_os = "linux"))]
    fn execute_ui_request(&self, request: &UiCommandRequest) -> Result<UiCommandResult, String> {
        self.ui.lock().expect("ui projection poisoned").handle(request.clone())
    }

    #[cfg(target_os = "linux")]
    fn execute_ui_request(&self, request: &UiCommandRequest) -> Result<UiCommandResult, String> {
        if matches!(request.message_type.as_str(), "interrupt" | "safe_stop" | "cancel") {
            let control = self.ui.lock().expect("ui projection poisoned").startup_control_for(request);
            if let Some((attempt_id, control)) = control {
                let requested = control.request_cancel();
                if requested == Ok(false) {
                    return Err("Runtime startup already passed the no-send boundary; check the turn before stopping it.".into());
                }
                let mut detail = requested.err();
                let mut confirmed = control.wait_finished(Duration::from_millis(650));
                if !confirmed {
                    if let Err(error) = control.force_if_stalled() { detail = Some(error); }
                    confirmed = control.wait_finished(Duration::from_millis(650));
                }
                let mut ui = self.ui.lock().expect("ui projection poisoned");
                return ui.record_startup_cancel(request, &attempt_id, confirmed, detail.as_deref());
            }
        }
        let worker = {
            let mut ui = self.ui.lock().expect("ui projection poisoned");
            match ui.native_worker_plan(request) {
                Some(plan) => Some(
                    ui.fork_native_worker(&plan)
                        .map(|(worker, baseline)| (plan, worker, baseline)),
                ),
                None => return ui.handle(request.clone()),
            }
        };
        let Some(worker) = worker else { unreachable!() };
        let (plan, mut worker, baseline) = worker?;
        // Native initialization and its protocol waits run on this connection
        // worker, outside the shared projection lock. Other connections can
        // still snapshot and operate on different sessions.
        let outcome = worker.handle(request.clone());
        let mut ui = self.ui.lock().expect("ui projection poisoned");
        ui.merge_native_worker(&plan, worker, baseline)?;
        outcome.map(|mut result| {
            // Rebuild from the merged controller. A named send, stop or
            // approval shows that goal and leaves the shared selection as it
            // was; anything else keeps the single-window snapshot.
            result.snapshot = ui.response_snapshot(request, None)?;
            Ok(result)
        })?
    }

    pub fn serve_stream<R: Read, W: Write>(
        &self,
        reader: &mut R,
        writer: &mut W,
    ) -> Result<usize, IpcError> {
        let mut count = 0;
        while let Some(frame) = read_frame(reader)? {
            let payload = &frame[4..];
            let response = self.handle_json(payload)?;
            if std::env::var_os("GOALPORT_DEBUG").is_some() {
                eprintln!("goalport-ipc: writing stream response");
            }
            write_frame(writer, &response)?;
            count += 1;
        }
        Ok(count)
    }

    pub fn handle_json(&self, payload: &[u8]) -> Result<Value, IpcError> {
        match serde_json::from_slice::<IpcRequest>(payload) {
            Ok(request) => Ok(serde_json::to_value(self.handle(request))?),
            Err(typed_error) => {
                let request =
                    serde_json::from_slice::<UiCommandRequest>(payload).map_err(|_| typed_error)?;
                request.validate()?;
                if request.message_type == "snapshot_if_changed" {
                    if request.protocol_version != CONNECTED_UI_PROTOCOL_VERSION {
                        return Err(IpcError::Invalid("snapshot_if_changed requires UI protocol v2".into()));
                    }
                    let known = request.payload.get("revision").and_then(Value::as_str);
                    let campaign_id = request
                        .payload
                        .get("campaignId")
                        .and_then(Value::as_str)
                        .filter(|value| !value.is_empty());
                    let outcome = self
                        .ui
                        .lock()
                        .expect("ui projection poisoned")
                        .snapshot_if_changed(known, campaign_id);
                    let (ok, payload, error) = match outcome {
                        Ok(payload) => (true, payload, None),
                        Err(message) => (false, Value::Null, Some(bound_error(&message))),
                    };
                    let value = serde_json::to_value(UiCommandResponse {
                        protocol_version: CONNECTED_UI_PROTOCOL_VERSION,
                        request_id: request.request_id,
                        entity_version: request.entity_version,
                        ok, payload, error,
                    })?;
                    return bound_ui_response(value).map_err(IpcError::Invalid);
                }
                if request.message_type == "snapshot"
                    && request.protocol_version == IPC_PROTOCOL_VERSION
                {
                    // Legacy v1 desktop probes intentionally retain the
                    // historical StoreCounts response. Connected Preview v2
                    // requests below receive the complete UI projection.
                    let counts = self.processor.store().counts()?;
                    let value = serde_json::to_value(UiCommandResponse {
                        protocol_version: IPC_PROTOCOL_VERSION,
                        request_id: request.request_id,
                        entity_version: request.entity_version,
                        ok: true,
                        payload: serde_json::to_value(counts)?,
                        error: None,
                    })?;
                    bound_ui_response(value).map_err(IpcError::Invalid)
                } else {
                    if std::env::var_os("GOALPORT_DEBUG").is_some() {
                        eprintln!("goalport-ui: handling {}", request.message_type);
                    }
                    if request.message_type == "goal_overview" || request.message_type == "goal_detail" {
                        if request.protocol_version != CONNECTED_UI_PROTOCOL_VERSION {
                            return Err(IpcError::Invalid(
                                "goal overview and detail require UI protocol v2".into(),
                            ));
                        }
                        let mut ui = self.ui.lock().expect("ui projection poisoned");
                        let outcome = if request.message_type == "goal_overview" {
                            ui.goal_overview().map(|overview| serde_json::json!({
                                "requestId": request.request_id,
                                "accepted": true,
                                "overview": overview
                            }))
                        } else {
                            let campaign_id = request
                                .payload
                                .get("campaignId")
                                .and_then(Value::as_str)
                                .filter(|value| !value.is_empty());
                            match campaign_id {
                                None => Err("campaignId is required".to_string()),
                                Some(campaign_id) => match ui.scoped_view_revision(campaign_id) {
                                    Err(error) => Err(error),
                                    Ok(revision) => ui.snapshot_for_campaign(campaign_id, None).map(|snapshot| {
                                        serde_json::json!({
                                            "requestId": request.request_id,
                                            "accepted": true,
                                            "revision": revision,
                                            "snapshot": snapshot
                                        })
                                    }),
                                },
                            }
                        };
                        let value = match outcome {
                            Ok(payload) => serde_json::to_value(UiCommandResponse {
                                protocol_version: CONNECTED_UI_PROTOCOL_VERSION,
                                request_id: request.request_id.clone(),
                                entity_version: request.entity_version,
                                ok: true,
                                payload,
                                error: None,
                            })?,
                            Err(error) => {
                                let error = bound_error(&error);
                                serde_json::to_value(UiCommandResponse {
                                    protocol_version: CONNECTED_UI_PROTOCOL_VERSION,
                                    request_id: request.request_id.clone(),
                                    entity_version: request.entity_version,
                                    ok: false,
                                    payload: serde_json::json!({
                                        "requestId": request.request_id,
                                        "accepted": false,
                                        "rejection": {
                                            "code": "goal-read-rejected",
                                            "message": error.clone(),
                                            "deliveryState": "FAILED",
                                            "nativeDispatchState": "NOT_STARTED",
                                            "retryMode": "NONE",
                                            "reservation": Value::Null
                                        }
                                    }),
                                    error: Some(error),
                                })?
                            }
                        };
                        return bound_ui_response(value).map_err(IpcError::Invalid);
                    }
                    if request.message_type == "history_page" {
                        let outcome = self
                            .ui
                            .lock()
                            .expect("ui projection poisoned")
                            .history_page(&request);
                        let value = match outcome {
                            Ok(page) => serde_json::to_value(UiCommandResponse {
                                protocol_version: CONNECTED_UI_PROTOCOL_VERSION,
                                request_id: request.request_id.clone(),
                                entity_version: request.entity_version,
                                ok: true,
                                payload: serde_json::json!({
                                    "requestId": request.request_id,
                                    "accepted": true,
                                    "historyPage": page
                                }),
                                error: None,
                            })?,
                            Err(error) => {
                                let error = bound_error(&error);
                                serde_json::to_value(UiCommandResponse {
                                    protocol_version: CONNECTED_UI_PROTOCOL_VERSION,
                                    request_id: request.request_id.clone(),
                                    entity_version: request.entity_version,
                                    ok: false,
                                    payload: serde_json::json!({
                                        "requestId": request.request_id,
                                        "accepted": false,
                                        "rejection": {
                                            "code": "history-page-rejected",
                                            "message": error.clone(),
                                            "deliveryState": "FAILED",
                                            "nativeDispatchState": "NOT_STARTED",
                                            "retryMode": "NONE",
                                            "reservation": Value::Null
                                        }
                                    }),
                                    error: Some(error),
                                })?
                            }
                        };
                        return bound_ui_response(value).map_err(IpcError::Invalid);
                    }
                    let outcome = self.execute_ui_request(&request);
                    match outcome {
                        Ok(mut result) => {
                            if std::env::var_os("GOALPORT_DEBUG").is_some() {
                                eprintln!("goalport-ui: completed {}", request.message_type);
                            }
                            let (receipt, _truncated) =
                                bound_result_metadata(result.receipt.take());
                            result.receipt = receipt;
                            let value = serde_json::to_value(UiCommandResponse {
                                protocol_version: CONNECTED_UI_PROTOCOL_VERSION,
                                request_id: request.request_id,
                                entity_version: request.entity_version,
                                ok: true,
                                payload: serde_json::to_value(result)?,
                                error: None,
                            })?;
                            if std::env::var_os("GOALPORT_DEBUG").is_some() {
                                eprintln!(
                                    "goalport-ui: serialized response bytes={}",
                                    serde_json::to_vec(&value)?.len()
                                );
                            }
                            bound_ui_response(value).map_err(IpcError::Invalid)
                        }
                        Err(error) => {
                            let error = bound_error(&error);
                            let rejected = self
                                .ui
                                .lock()
                                .expect("ui projection poisoned")
                                .rejected_payload(&request, &error)
                                .map_err(IpcError::Invalid)?;
                            let value = serde_json::to_value(UiCommandResponse {
                                protocol_version: CONNECTED_UI_PROTOCOL_VERSION,
                                request_id: request.request_id,
                                entity_version: request.entity_version,
                                ok: false,
                                payload: rejected,
                                error: Some(error),
                            })?;
                            bound_ui_response(value).map_err(IpcError::Invalid)
                        }
                    }
                }
            }
        }
    }

    #[cfg(windows)]
    pub fn serve_named_pipe(&self, name: &str) -> Result<(), IpcError> {
        self.start_runtime_flusher();
        let mut server = NamedPipeServer::bind(name)?;
        loop {
            let mut connection = match server.accept() {
                Ok(connection) => connection,
                Err(IpcError::Io(_)) => {
                    // Continue-then-destroy, or a client that connected and
                    // closed before this accept (ERROR_NO_DATA), can invalidate
                    // the listening instance. Replace it with a further instance
                    // of the same pipe while the old handle is still open, so the
                    // name is never released to another creator and a later UI
                    // attaches instead of spawning a second Core. Security
                    // failures of the replacement are fatal.
                    thread::sleep(Duration::from_millis(20));
                    server.replace_listening_instance()?;
                    continue;
                }
                Err(error) => return Err(error),
            };
            match self.serve_duplex(&mut connection) {
                Ok(()) => {}
                Err(IpcError::Io(_)) => {}
                Err(error) => return Err(error),
            }
        }
    }

    #[cfg(windows)]
    pub fn serve_named_pipe_once(&self, name: &str) -> Result<usize, IpcError> {
        self.start_runtime_flusher();
        let mut server = NamedPipeServer::bind(name)?;
        let mut connection = server.accept()?;
        self.serve_duplex(&mut connection).map(|_| 1)
    }

    #[cfg(not(windows))]
    pub fn serve_named_pipe(&self, _name: &str) -> Result<(), IpcError> {
        Err(IpcError::UnsupportedPlatform)
    }

    #[cfg(not(windows))]
    pub fn serve_named_pipe_once(&self, _name: &str) -> Result<usize, IpcError> {
        Err(IpcError::UnsupportedPlatform)
    }

    /// Linux local socket. Named pipes stay unsupported. Peer uid must match;
    /// a missing `SO_PEERCRED` fails closed. `endpoint` is resolved the same
    /// way as serve receipts (`resolve_unix_socket`).
    #[cfg(target_os = "linux")]
    pub fn serve_unix_socket(&self, endpoint: &str) -> Result<(), IpcError> {
        let resolved = resolve_unix_socket(endpoint)?;
        let owned = self.bind_resolved_unix_socket(&resolved)?;
        self.serve_owned_unix_socket(owned)
    }

    /// Bind and own a resolved Linux socket path (lock + listen) without
    /// entering the accept loop. Production `serve` binds before writing
    /// `READY_COMMITTED` so a failed bind never leaves a ready file behind.
    #[cfg(target_os = "linux")]
    pub fn bind_resolved_unix_socket(
        &self,
        resolved: &ResolvedUnixSocketPath,
    ) -> Result<OwnedUnixSocket, IpcError> {
        bind_unix_socket(&resolved.path, resolved.managed_runtime_parent)
    }

    /// Bind an explicit filesystem path. Does not chmod parents (explicit /
    /// test paths). Prefer [`Self::bind_resolved_unix_socket`] for named
    /// endpoints so the default managed runtime dir can be tightened.
    #[cfg(target_os = "linux")]
    pub fn bind_unix_socket_at(&self, path: &std::path::Path) -> Result<OwnedUnixSocket, IpcError> {
        bind_unix_socket(path, false)
    }

    /// Accept-loop on an already-owned listener. The caller must have bound
    /// successfully before advertising launch-ready.
    #[cfg(target_os = "linux")]
    pub fn serve_owned_unix_socket(&self, owned: OwnedUnixSocket) -> Result<(), IpcError> {
        use std::sync::atomic::{AtomicUsize, Ordering};

        const MAX_CLIENTS: usize = 32;
        const CLIENT_IO_TIMEOUT: Duration = Duration::from_secs(10);
        self.start_runtime_flusher();
        let active = Arc::new(AtomicUsize::new(0));
        loop {
            let (stream, _) = owned.listener.accept().map_err(IpcError::Io)?;
            if !unix_peer_uid_matches(&stream, current_uid())? {
                continue;
            }
            if active
                .fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| {
                    (count < MAX_CLIENTS).then_some(count + 1)
                })
                .is_err()
            {
                continue;
            }
            let server = self.clone();
            let workers = active.clone();
            if thread::Builder::new()
                .name("goalport-unix-client".into())
                .spawn(move || {
                    let _permit = UnixConnectionPermit(workers);
                    if stream.set_read_timeout(Some(CLIENT_IO_TIMEOUT)).is_err()
                        || stream.set_write_timeout(Some(CLIENT_IO_TIMEOUT)).is_err()
                    {
                        return;
                    }
                    let Ok(mut reader) = stream.try_clone() else { return };
                    let mut writer = stream;
                    let _ = server.serve_stream(&mut reader, &mut writer);
                })
                .is_err()
            {
                active.fetch_sub(1, Ordering::AcqRel);
            }
        }
    }

    /// Test and production seam: serve an already-resolved socket path.
    /// Callers must pass an explicit path; tests must not mutate `HOME`.
    /// Explicit paths do not chmod parents.
    #[cfg(target_os = "linux")]
    pub fn serve_unix_socket_at(&self, path: &std::path::Path) -> Result<(), IpcError> {
        let owned = self.bind_unix_socket_at(path)?;
        self.serve_owned_unix_socket(owned)
    }

    #[cfg(not(any(windows, target_os = "linux")))]
    pub fn serve_unix_socket(&self, _endpoint: &str) -> Result<(), IpcError> {
        Err(IpcError::UnixSocketUnsupported)
    }

    #[cfg(not(any(windows, target_os = "linux")))]
    pub fn serve_unix_socket_at(&self, _path: &std::path::Path) -> Result<(), IpcError> {
        Err(IpcError::UnixSocketUnsupported)
    }

    #[cfg(windows)]
    fn serve_duplex<S: Read + Write>(&self, stream: &mut S) -> Result<(), IpcError> {
        while let Some(frame) = read_frame(stream)? {
            let response = self.handle_json(&frame[4..])?;
            if std::env::var_os("GOALPORT_DEBUG").is_some() {
                eprintln!(
                    "goalport-ipc: writing duplex response bytes={}",
                    serde_json::to_vec(&response)?.len()
                );
            }
            write_frame(stream, &response)?;
            if std::env::var_os("GOALPORT_DEBUG").is_some() {
                eprintln!("goalport-ipc: duplex response flushed");
            }
        }
        Ok(())
    }

    pub fn processor(&self) -> &CommandProcessor {
        &self.processor
    }

    pub fn reconcile_after_restart(&self) -> Result<usize, CommandError> {
        self.processor.reconcile_after_restart()
    }
}

#[derive(Debug)]
pub struct IpcClient<S> {
    stream: S,
}

impl<S: Read + Write> IpcClient<S> {
    pub fn new(stream: S) -> Self {
        Self { stream }
    }

    pub fn request(&mut self, request: IpcRequest) -> Result<IpcResponse, IpcError> {
        request.validate()?;
        write_frame(&mut self.stream, &request)?;
        let frame = read_frame(&mut self.stream)?.ok_or(IpcError::TruncatedFrame)?;
        let response: IpcResponse = decode_frame(&frame)?;
        if response.protocol_version != IPC_PROTOCOL_VERSION {
            return Err(IpcError::ProtocolVersion {
                expected: IPC_PROTOCOL_VERSION.into(),
                received: response.protocol_version,
            });
        }
        if response.request_id != request.request_id {
            return Err(IpcError::Invalid(
                "ipc response request_id does not match the request".into(),
            ));
        }
        if response.entity_version != request.entity_version {
            return Err(IpcError::Invalid(
                "ipc response entity_version does not match the request".into(),
            ));
        }
        Ok(response)
    }
}

#[cfg(windows)]
mod windows_pipe {
    use super::{IpcClient, IpcError, PipePeer, pipe_sddl};
    use std::{
        ffi::OsStr,
        fs::File,
        io::{Read, Write},
        os::windows::ffi::OsStrExt,
        os::windows::io::FromRawHandle,
        ptr::null_mut,
        time::{Duration, Instant},
    };
    use winapi::{
        ctypes::c_void,
        shared::{
            minwindef::{DWORD, FALSE, ULONG},
            ntdef::NULL,
            sddl::{
                ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
                SDDL_REVISION_1,
            },
            winerror::{
                ERROR_ACCESS_DENIED, ERROR_INVALID_HANDLE, ERROR_INVALID_OWNER,
                ERROR_INVALID_PARAMETER, ERROR_INVALID_SECURITY_DESCR, ERROR_PIPE_BUSY,
                ERROR_PIPE_CONNECTED,
            },
        },
        um::{
            accctrl::SE_KERNEL_OBJECT,
            aclapi::GetSecurityInfo,
            errhandlingapi::GetLastError,
            fileapi::{CreateFileW, OPEN_EXISTING},
            handleapi::{CloseHandle, INVALID_HANDLE_VALUE},
            minwinbase::SECURITY_ATTRIBUTES,
            namedpipeapi::{ConnectNamedPipe, CreateNamedPipeW, WaitNamedPipeW},
            processthreadsapi::{GetCurrentProcess, OpenProcess, OpenProcessToken},
            securitybaseapi::{
                EqualSid, GetAce, GetSecurityDescriptorControl, GetTokenInformation,
            },
            winbase::{
                FILE_FLAG_FIRST_PIPE_INSTANCE, GetNamedPipeServerProcessId, LocalFree,
                PIPE_ACCESS_DUPLEX, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE,
                PIPE_UNLIMITED_INSTANCES, PIPE_WAIT, SECURITY_IDENTIFICATION,
                SECURITY_SQOS_PRESENT,
            },
            winnt::{
                ACCESS_ALLOWED_ACE, ACCESS_ALLOWED_ACE_TYPE, DACL_SECURITY_INFORMATION,
                FILE_ALL_ACCESS, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, FILE_SHARE_WRITE,
                GENERIC_READ, GENERIC_WRITE, HANDLE, OWNER_SECURITY_INFORMATION, PACL,
                PROCESS_QUERY_LIMITED_INFORMATION, PSECURITY_DESCRIPTOR, PSID, SE_DACL_PRESENT,
                SE_DACL_PROTECTED, TOKEN_QUERY, TOKEN_USER, TokenUser,
            },
        },
    };

    /// Every client open of a Core pipe (Rust client and `verify_pipe_peer`)
    /// limits the server to identification-level impersonation.
    pub(crate) const PIPE_CLIENT_FLAGS: DWORD =
        FILE_ATTRIBUTE_NORMAL | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION;
    /// Every Core pipe instance rejects remote (SMB) clients.
    pub(crate) const PIPE_SERVER_MODE: DWORD =
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS;
    /// Total time `verify_pipe_peer` waits for a busy pipe, from its first attempt.
    pub(crate) const PEER_BUSY_BUDGET: Duration = Duration::from_millis(3000);

    fn wide(value: &str) -> Vec<u16> {
        OsStr::new(value)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    fn pipe_path(name: &str) -> String {
        if name.starts_with(r"\\.\pipe\") {
            name.to_owned()
        } else {
            format!(r"\\.\pipe\{name}")
        }
    }

    fn last_error() -> i32 {
        unsafe { GetLastError() as i32 }
    }

    fn security(stage: &'static str, code: i32) -> IpcError {
        IpcError::PipeSecurity { stage, code }
    }

    /// Closes a kernel handle on drop unless ownership was released.
    struct OwnedHandle(HANDLE);
    impl OwnedHandle {
        fn into_raw(mut self) -> HANDLE {
            std::mem::replace(&mut self.0, null_mut())
        }
    }
    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
                unsafe {
                    CloseHandle(self.0);
                }
            }
        }
    }

    /// Frees a LocalAlloc-owned buffer returned by a Win32 API on drop.
    struct LocalBuffer(*mut c_void);
    impl Drop for LocalBuffer {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    LocalFree(self.0);
                }
            }
        }
    }

    /// A `TOKEN_USER` buffer (aligned) whose SID pointer stays valid while it lives.
    pub(crate) struct TokenUserSid {
        buffer: Vec<u64>,
    }
    impl TokenUserSid {
        fn sid(&self) -> PSID {
            unsafe { (*(self.buffer.as_ptr() as *const TOKEN_USER)).User.Sid }
        }
    }

    fn query_token_user(token: HANDLE) -> Result<TokenUserSid, i32> {
        let mut needed: DWORD = 0;
        unsafe {
            GetTokenInformation(token, TokenUser, null_mut(), 0, &mut needed);
        }
        if needed == 0 {
            return Err(last_error());
        }
        let mut buffer = vec![0_u64; (needed as usize).div_ceil(8)];
        let ok = unsafe {
            GetTokenInformation(
                token,
                TokenUser,
                buffer.as_mut_ptr() as *mut c_void,
                (buffer.len() * 8) as DWORD,
                &mut needed,
            )
        };
        if ok == 0 {
            return Err(last_error());
        }
        Ok(TokenUserSid { buffer })
    }

    /// `TokenUser` of the current process token.
    fn current_user() -> Result<TokenUserSid, IpcError> {
        let mut token: HANDLE = null_mut();
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
            return Err(security("token-open", last_error()));
        }
        let token = OwnedHandle(token);
        query_token_user(token.0).map_err(|code| security("token-user", code))
    }

    fn sid_string(sid: PSID) -> Result<String, IpcError> {
        let mut raw: *mut u16 = null_mut();
        if unsafe { ConvertSidToStringSidW(sid, &mut raw) } == 0 || raw.is_null() {
            return Err(security("sid-string", last_error()));
        }
        let _owned = LocalBuffer(raw as *mut c_void);
        let text = unsafe {
            let length = (0..).take_while(|&index| *raw.add(index) != 0).count();
            String::from_utf16(std::slice::from_raw_parts(raw, length))
        };
        text.map_err(|_| security("sid-string", ERROR_INVALID_PARAMETER as i32))
    }

    enum SecurityMismatch {
        Query(i32),
        Owner,
        Dacl,
    }

    /// Structural check of a pipe handle's owner and DACL against `expected`:
    /// owner equals `expected`; DACL present and protected; exactly one
    /// ACCESS_ALLOWED ACE with flags 0, mask FILE_ALL_ACCESS and SID `expected`.
    fn check_pipe_security(handle: HANDLE, expected: PSID) -> Result<(), SecurityMismatch> {
        unsafe {
            let mut owner: PSID = null_mut();
            let mut dacl: PACL = null_mut();
            let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
            let status = GetSecurityInfo(
                handle,
                SE_KERNEL_OBJECT,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                &mut owner,
                null_mut(),
                &mut dacl,
                null_mut(),
                &mut descriptor,
            );
            if status != 0 {
                return Err(SecurityMismatch::Query(status as i32));
            }
            let _descriptor = LocalBuffer(descriptor as *mut c_void);
            if owner.is_null() || EqualSid(owner, expected) == 0 {
                return Err(SecurityMismatch::Owner);
            }
            let mut control = 0;
            let mut revision = 0;
            if GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) == 0 {
                return Err(SecurityMismatch::Query(last_error()));
            }
            if control & SE_DACL_PRESENT == 0 || control & SE_DACL_PROTECTED == 0 || dacl.is_null()
            {
                return Err(SecurityMismatch::Dacl);
            }
            if (*dacl).AceCount != 1 {
                return Err(SecurityMismatch::Dacl);
            }
            let mut ace: *mut c_void = null_mut();
            if GetAce(dacl, 0, &mut ace) == 0 || ace.is_null() {
                return Err(SecurityMismatch::Dacl);
            }
            let ace = &*(ace as *const ACCESS_ALLOWED_ACE);
            if ace.Header.AceType != ACCESS_ALLOWED_ACE_TYPE
                || ace.Header.AceFlags != 0
                || ace.Mask != FILE_ALL_ACCESS
            {
                return Err(SecurityMismatch::Dacl);
            }
            let ace_sid = &ace.SidStart as *const DWORD as PSID;
            if EqualSid(ace_sid, expected) == 0 {
                return Err(SecurityMismatch::Dacl);
            }
            Ok(())
        }
    }

    /// The single production instance-creation path. `first` requests
    /// FILE_FLAG_FIRST_PIPE_INSTANCE (used only by `bind`).
    fn create_pipe_instance(path: &str, first: bool) -> Result<HANDLE, IpcError> {
        let user = current_user()?;
        let sid = sid_string(user.sid())?;
        create_instance_with_sid(path, first, &sid, &user)
    }

    /// Test seam: the same creation path with the SID string supplied by the
    /// caller (real SDDL conversion, `CreateNamedPipeW` and verification against
    /// the process user). It accepts no DACL.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn create_pipe_instance_for_sid(
        name: &str,
        first: bool,
        sid: &str,
    ) -> Result<HANDLE, IpcError> {
        let user = current_user()?;
        create_instance_with_sid(&pipe_path(name), first, sid, &user)
    }

    fn create_instance_with_sid(
        path: &str,
        first: bool,
        sid: &str,
        user: &TokenUserSid,
    ) -> Result<HANDLE, IpcError> {
        let sddl = wide(&pipe_sddl(sid));
        let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
        let converted = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1 as DWORD,
                &mut descriptor,
                null_mut(),
            )
        };
        if converted == 0 || descriptor.is_null() {
            return Err(security("sddl", last_error()));
        }
        let _descriptor = LocalBuffer(descriptor as *mut c_void);
        let mut attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as DWORD,
            lpSecurityDescriptor: descriptor,
            bInheritHandle: FALSE,
        };
        let open_mode = PIPE_ACCESS_DUPLEX
            | if first {
                FILE_FLAG_FIRST_PIPE_INSTANCE
            } else {
                0
            };
        let name = wide(path);
        let handle = unsafe {
            CreateNamedPipeW(
                name.as_ptr(),
                open_mode,
                PIPE_SERVER_MODE,
                PIPE_UNLIMITED_INSTANCES,
                65_536,
                65_536,
                0,
                &mut attributes,
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            let code = last_error();
            return Err(if first && code == ERROR_ACCESS_DENIED as i32 {
                IpcError::PipeNameOccupied
            } else {
                security("create", code)
            });
        }
        let handle = OwnedHandle(handle);
        check_pipe_security(handle.0, user.sid()).map_err(|mismatch| match mismatch {
            SecurityMismatch::Query(code) => security("verify", code),
            SecurityMismatch::Owner => security("verify", ERROR_INVALID_OWNER as i32),
            SecurityMismatch::Dacl => security("verify", ERROR_INVALID_SECURITY_DESCR as i32),
        })?;
        Ok(handle.into_raw())
    }

    #[derive(Debug)]
    pub struct NamedPipeServer {
        name: String,
        handle: *mut std::ffi::c_void,
    }
    unsafe impl Send for NamedPipeServer {}
    unsafe impl Sync for NamedPipeServer {}

    impl NamedPipeServer {
        /// Creates the first instance of `name`. Fails with
        /// `PipeNameOccupied` when any instance of that name already exists.
        pub fn bind(name: &str) -> Result<Self, IpcError> {
            let name = pipe_path(name);
            let handle = create_pipe_instance(&name, true)?;
            Ok(Self {
                name,
                handle: handle as _,
            })
        }

        pub fn accept(&mut self) -> Result<NamedPipeConnection, IpcError> {
            let connected = unsafe { ConnectNamedPipe(self.handle as _, std::ptr::null_mut()) };
            if connected == 0 {
                let error = std::io::Error::last_os_error();
                if error.raw_os_error() != Some(ERROR_PIPE_CONNECTED as i32) {
                    return Err(IpcError::Io(error));
                }
            }
            let handle = std::mem::replace(&mut self.handle, std::ptr::null_mut());
            let file = unsafe { File::from_raw_handle(handle as _) };
            // The next instance is created while the connected handle is still
            // open. A failure drops the connection and is fatal for the server.
            let next = create_pipe_instance(&self.name, false)?;
            self.handle = next as _;
            Ok(NamedPipeConnection { file })
        }

        /// Replaces an invalidated listening instance with a further instance
        /// of the same pipe, created before the old handle is closed.
        pub fn replace_listening_instance(&mut self) -> Result<(), IpcError> {
            if self.handle.is_null() {
                return Err(security("create", ERROR_INVALID_HANDLE as i32));
            }
            let next = create_pipe_instance(&self.name, false)?;
            let old = std::mem::replace(&mut self.handle, next as _);
            unsafe {
                CloseHandle(old as _);
            }
            Ok(())
        }
    }

    impl Drop for NamedPipeServer {
        fn drop(&mut self) {
            // accept() transfers ownership to the connection; when it was not
            // accepted the server still owns the handle.
            if !self.handle.is_null() {
                unsafe {
                    CloseHandle(self.handle as _);
                }
            }
        }
    }

    #[derive(Debug)]
    pub struct NamedPipeConnection {
        file: File,
    }
    impl Read for NamedPipeConnection {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            self.file.read(buf)
        }
    }
    impl Write for NamedPipeConnection {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.file.write(buf)
        }
        fn flush(&mut self) -> std::io::Result<()> {
            self.file.flush()
        }
    }

    #[derive(Debug)]
    pub struct NamedPipeClient {
        file: File,
    }
    impl NamedPipeClient {
        pub fn connect(name: &str) -> Result<Self, IpcError> {
            let name = wide(&pipe_path(name));
            let handle = unsafe {
                CreateFileW(
                    name.as_ptr(),
                    GENERIC_READ | GENERIC_WRITE,
                    FILE_SHARE_READ | FILE_SHARE_WRITE,
                    std::ptr::null_mut(),
                    OPEN_EXISTING,
                    PIPE_CLIENT_FLAGS,
                    NULL as _,
                )
            };
            if handle == INVALID_HANDLE_VALUE {
                return Err(IpcError::Io(std::io::Error::last_os_error()));
            }
            Ok(Self {
                file: unsafe { File::from_raw_handle(handle as _) },
            })
        }
        pub fn into_ipc_client(self) -> IpcClient<Self> {
            IpcClient::new(self)
        }
    }
    impl Read for NamedPipeClient {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            self.file.read(buf)
        }
    }
    impl Write for NamedPipeClient {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.file.write(buf)
        }
        fn flush(&mut self) -> std::io::Result<()> {
            self.file.flush()
        }
    }

    /// Authenticates the server of `name` without sending a frame: the pipe's
    /// owner and DACL must match the Core contract for the calling user, and
    /// the serving process must run as that same user. A busy pipe is waited
    /// for within `PEER_BUSY_BUDGET`. Failures are `PipeSecurity` with one of
    /// the stages open, busy, sd, owner, dacl, server-pid, server-token,
    /// server-user.
    pub fn verify_pipe_peer(name: &str) -> Result<PipePeer, IpcError> {
        let path = wide(&pipe_path(name));
        let started = Instant::now();
        let connection = loop {
            let handle = unsafe {
                CreateFileW(
                    path.as_ptr(),
                    GENERIC_READ | GENERIC_WRITE,
                    FILE_SHARE_READ | FILE_SHARE_WRITE,
                    std::ptr::null_mut(),
                    OPEN_EXISTING,
                    PIPE_CLIENT_FLAGS,
                    NULL as _,
                )
            };
            if handle != INVALID_HANDLE_VALUE {
                break OwnedHandle(handle);
            }
            let code = last_error();
            if code != ERROR_PIPE_BUSY as i32 {
                return Err(security("open", code));
            }
            let elapsed = started.elapsed();
            if elapsed >= PEER_BUSY_BUDGET {
                return Err(security("busy", ERROR_PIPE_BUSY as i32));
            }
            let remaining = (PEER_BUSY_BUDGET - elapsed).as_millis().max(1) as DWORD;
            // The result is not trusted: the loop re-opens and re-checks time.
            unsafe {
                WaitNamedPipeW(path.as_ptr(), remaining);
            }
        };
        let caller = current_user().map_err(|error| match error {
            IpcError::PipeSecurity { code, .. } => security("sd", code),
            other => other,
        })?;
        check_pipe_security(connection.0, caller.sid()).map_err(|mismatch| match mismatch {
            SecurityMismatch::Query(code) => security("sd", code),
            SecurityMismatch::Owner => security("owner", ERROR_INVALID_OWNER as i32),
            SecurityMismatch::Dacl => security("dacl", ERROR_INVALID_SECURITY_DESCR as i32),
        })?;
        let mut server_pid: ULONG = 0;
        if unsafe { GetNamedPipeServerProcessId(connection.0, &mut server_pid) } == 0 {
            return Err(security("server-pid", last_error()));
        }
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, server_pid) };
        if process.is_null() {
            return Err(security("server-token", last_error()));
        }
        let process = OwnedHandle(process);
        let mut token: HANDLE = null_mut();
        if unsafe { OpenProcessToken(process.0, TOKEN_QUERY, &mut token) } == 0 {
            return Err(security("server-token", last_error()));
        }
        let token = OwnedHandle(token);
        let server_user =
            query_token_user(token.0).map_err(|code| security("server-token", code))?;
        if unsafe { EqualSid(server_user.sid(), caller.sid()) } == 0 {
            return Err(security("server-user", ERROR_ACCESS_DENIED as i32));
        }
        drop(connection);
        Ok(PipePeer { server_pid })
    }
}

#[cfg(windows)]
pub use windows_pipe::{NamedPipeClient, NamedPipeConnection, NamedPipeServer, verify_pipe_peer};

#[cfg(not(windows))]
#[derive(Debug)]
pub struct NamedPipeServer;
#[cfg(not(windows))]
impl NamedPipeServer {
    pub fn bind(_name: &str) -> Result<Self, IpcError> {
        Err(IpcError::UnsupportedPlatform)
    }

    pub fn serve_named_pipe_once(_name: &str) -> Result<usize, IpcError> {
        Err(IpcError::UnsupportedPlatform)
    }
}
#[cfg(not(windows))]
#[derive(Debug)]
pub struct NamedPipeClient;
#[cfg(not(windows))]
impl NamedPipeClient {
    pub fn connect(_name: &str) -> Result<Self, IpcError> {
        Err(IpcError::UnsupportedPlatform)
    }
}
#[cfg(not(windows))]
pub fn verify_pipe_peer(_name: &str) -> Result<PipePeer, IpcError> {
    Err(IpcError::UnsupportedPlatform)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        commands::{CoreCommand, CoreOperation},
        domain::{Attempt, AttemptState},
    };
    use std::io::Cursor;

    #[cfg(target_os = "linux")]
    #[test]
    fn new_lock_waits_for_a_brief_competing_opener() {
        use std::os::fd::AsRawFd;
        use std::sync::mpsc;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("first.sock.lock");
        let creator = std::fs::OpenOptions::new()
            .create_new(true)
            .read(true)
            .write(true)
            .open(&path)
            .unwrap();
        let contender = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&path)
            .unwrap();
        assert_eq!(
            unsafe { libc::flock(contender.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
            0
        );
        let metadata = creator.metadata().unwrap();
        let worker_path = path.clone();
        let (observed_tx, observed_rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            acquire_or_remove_new_lock(&creator, &worker_path, &metadata, true, || {
                observed_tx.send(()).unwrap()
            })
        });
        observed_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(!worker.is_finished(), "creator must wait while contender holds lock");
        assert_eq!(unsafe { libc::flock(contender.as_raw_fd(), libc::LOCK_UN) }, 0);
        worker.join().unwrap().unwrap();
        assert!(path.exists());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn timed_out_new_lock_removes_its_empty_path() {
        use std::os::fd::AsRawFd;
        use std::sync::mpsc;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("first.sock.lock");
        let creator = std::fs::OpenOptions::new()
            .create_new(true)
            .read(true)
            .write(true)
            .open(&path)
            .unwrap();
        let contender = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&path)
            .unwrap();
        assert_eq!(
            unsafe { libc::flock(contender.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
            0
        );
        let metadata = creator.metadata().unwrap();
        let worker_path = path.clone();
        let (observed_tx, observed_rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            acquire_or_remove_new_lock(&creator, &worker_path, &metadata, true, || {
                observed_tx.send(()).unwrap()
            })
        });
        observed_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let error = worker.join().unwrap().unwrap_err();
        assert!(error.to_string().contains("already owned"), "{error}");
        assert!(!path.exists(), "timed-out creator must not strand an empty lock");
        assert_eq!(unsafe { libc::flock(contender.as_raw_fd(), libc::LOCK_UN) }, 0);
    }

    fn command() -> CoreCommand {
        CoreCommand::new(
            "cmd-1",
            "a",
            CoreOperation::TransitionAttempt {
                attempt_id: "a".into(),
                state: AttemptState::Active,
                event_id: "e-1".into(),
            },
        )
        .unwrap()
    }

    #[test]
    fn framed_json_round_trips_and_rejects_wrong_protocol() {
        let request = IpcRequest::new("req-1", command());
        let frame = encode_frame(&request).unwrap();
        let decoded: IpcRequest = decode_frame(&frame).unwrap();
        assert_eq!(decoded.request_id, "req-1");
        let mut bad = request.clone();
        bad.protocol_version = "future".into();
        assert!(matches!(
            bad.validate(),
            Err(IpcError::ProtocolVersion { .. })
        ));
    }

    #[test]
    fn server_ledger_deduplicates_request_ids_and_streams_responses() {
        let store = Store::open_in_memory().unwrap();
        store
            .insert_attempt(&Attempt::new("a", "t", "scenario", "cap-v1"))
            .unwrap();
        let server = CoreServer::new(store.clone());
        let request = IpcRequest::new("req-1", command());
        let first = server.handle(request.clone());
        let second = server.handle(request.clone());
        assert!(first.ok);
        assert!(second.duplicate);
        assert_eq!(store.list_events("a").unwrap().len(), 1);
        let mut input = Cursor::new(
            encode_frame(&IpcRequest::new(
                "req-2",
                CoreCommand::new(
                    "cmd-2",
                    "a",
                    CoreOperation::TransitionAttempt {
                        attempt_id: "a".into(),
                        state: AttemptState::AwaitingReview,
                        event_id: "e-2".into(),
                    },
                )
                .unwrap(),
            ))
            .unwrap(),
        );
        let mut output = Cursor::new(Vec::new());
        assert_eq!(server.serve_stream(&mut input, &mut output).unwrap(), 1);
        assert!(!output.get_ref().is_empty());
    }

    #[test]
    fn desktop_compatibility_wire_accepts_camel_and_snake_case() {
        let server = CoreServer::new(Store::open_in_memory().unwrap());
        let camel = serde_json::json!({
            "protocolVersion": IPC_PROTOCOL_VERSION,
            "requestId": "snapshot-camel",
            "entityVersion": 0,
            "messageType": "snapshot",
            "payload": {}
        });
        let snake = serde_json::json!({
            "protocol_version": IPC_PROTOCOL_VERSION,
            "request_id": "snapshot-snake",
            "entity_version": 0,
            "message_type": "snapshot",
            "payload": {}
        });
        let camel_response = server
            .handle_json(&serde_json::to_vec(&camel).unwrap())
            .unwrap();
        let snake_response = server
            .handle_json(&serde_json::to_vec(&snake).unwrap())
            .unwrap();
        assert_eq!(camel_response["ok"], true);
        assert_eq!(snake_response["ok"], true);
    }

    #[test]
    fn u1_pipe_sddl_grants_only_the_core_user_with_protected_dacl() {
        assert_eq!(
            pipe_sddl("S-1-5-21-1-2-3-1001"),
            "O:S-1-5-21-1-2-3-1001G:S-1-5-21-1-2-3-1001D:P(A;;FA;;;S-1-5-21-1-2-3-1001)"
        );
    }

    #[test]
    fn pipe_security_errors_are_bounded_and_carry_no_identity() {
        let security = IpcError::PipeSecurity {
            stage: "verify",
            code: 1338,
        };
        assert_eq!(
            security.to_string(),
            "named pipe security setup failed at verify (os error 1338)"
        );
        assert_eq!(
            IpcError::PipeNameOccupied.to_string(),
            "named pipe name is already in use by another instance"
        );
    }

    #[cfg(windows)]
    mod windows_security {
        use super::super::{IpcError, windows_pipe};
        use std::{
            ffi::OsStr,
            os::windows::ffi::OsStrExt,
            time::{SystemTime, UNIX_EPOCH},
        };
        use winapi::{
            shared::winerror::ERROR_FILE_NOT_FOUND,
            um::{
                errhandlingapi::GetLastError,
                fileapi::{CreateFileW, OPEN_EXISTING},
                handleapi::{CloseHandle, INVALID_HANDLE_VALUE},
                processthreadsapi::{GetCurrentProcess, OpenProcessToken},
                securitybaseapi::GetTokenInformation,
                winbase::{
                    PIPE_REJECT_REMOTE_CLIENTS, SECURITY_IDENTIFICATION, SECURITY_SQOS_PRESENT,
                },
                winnt::{GENERIC_READ, GENERIC_WRITE, TOKEN_QUERY, TOKEN_USER, TokenUser},
            },
        };

        fn unique_path(label: &str) -> String {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            format!(r"\\.\pipe\goalport-{label}-{}-{nanos}", std::process::id())
        }

        fn open_client(path: &str) -> Result<(), u32> {
            let wide: Vec<u16> = OsStr::new(path)
                .encode_wide()
                .chain(std::iter::once(0))
                .collect();
            let handle = unsafe {
                CreateFileW(
                    wide.as_ptr(),
                    GENERIC_READ | GENERIC_WRITE,
                    0,
                    std::ptr::null_mut(),
                    OPEN_EXISTING,
                    windows_pipe::PIPE_CLIENT_FLAGS,
                    std::ptr::null_mut(),
                )
            };
            if handle == INVALID_HANDLE_VALUE {
                return Err(unsafe { GetLastError() });
            }
            unsafe { CloseHandle(handle) };
            Ok(())
        }

        fn current_user_sid_string() -> String {
            unsafe {
                let mut token = std::ptr::null_mut();
                assert_ne!(
                    OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token),
                    0
                );
                let mut buffer = vec![0_u64; 128];
                let mut needed = 0;
                assert_ne!(
                    GetTokenInformation(
                        token,
                        TokenUser,
                        buffer.as_mut_ptr().cast(),
                        (buffer.len() * 8) as u32,
                        &mut needed,
                    ),
                    0
                );
                CloseHandle(token);
                let sid = (*(buffer.as_ptr() as *const TOKEN_USER)).User.Sid;
                let mut raw: *mut u16 = std::ptr::null_mut();
                assert_ne!(
                    winapi::shared::sddl::ConvertSidToStringSidW(sid, &mut raw),
                    0
                );
                let length = (0..).take_while(|&index| *raw.add(index) != 0).count();
                let text = String::from_utf16(std::slice::from_raw_parts(raw, length)).unwrap();
                winapi::um::winbase::LocalFree(raw.cast());
                text
            }
        }

        #[test]
        fn u2_invalid_sid_fails_closed_and_leaves_no_pipe() {
            let path = unique_path("u2-invalid-sid");
            let result = windows_pipe::create_pipe_instance_for_sid(&path, true, "not-a-sid");
            assert!(
                matches!(result, Err(IpcError::PipeSecurity { stage: "sddl", .. })),
                "invalid SID must fail at SDDL conversion: {result:?}"
            );
            assert_eq!(open_client(&path), Err(ERROR_FILE_NOT_FOUND));
        }

        #[test]
        fn u2_control_real_user_sid_creates_a_connectable_pipe() {
            let path = unique_path("u2-control");
            let handle =
                windows_pipe::create_pipe_instance_for_sid(&path, true, &current_user_sid_string())
                    .expect("real user SID creates and verifies the pipe");
            assert_eq!(open_client(&path), Ok(()));
            unsafe { CloseHandle(handle) };
        }

        #[test]
        fn client_and_server_modes_carry_the_static_security_flags() {
            assert_eq!(
                windows_pipe::PIPE_CLIENT_FLAGS & (SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION),
                SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION
            );
            assert_eq!(
                windows_pipe::PIPE_SERVER_MODE & PIPE_REJECT_REMOTE_CLIENTS,
                PIPE_REJECT_REMOTE_CLIENTS
            );
        }
    }
}

#[cfg(target_os = "linux")]
fn current_uid() -> u32 {
    unsafe { libc::getuid() }
}

/// Usable byte length for a Linux `sockaddr_un.sun_path` path.
///
/// On Linux, `sun_path` is typically 108 bytes **including** the terminating
/// NUL, so the absolute socket path may be at most 107 bytes. This constant is
/// conservative and matches `sizeof(((struct sockaddr_un *)0)->sun_path) - 1`.
#[cfg(target_os = "linux")]
pub const LINUX_UNIX_SOCKET_PATH_MAX_BYTES: usize = 107;

/// Hex length of the collision-resistant truncated sha256 endpoint suffix.
#[cfg(target_os = "linux")]
const ENDPOINT_NAME_HASH_HEX_LEN: usize = 16;

/// Separator between the readable ASCII prefix and the stable hash suffix.
#[cfg(target_os = "linux")]
const ENDPOINT_NAME_HASH_SEP: &str = "--";

/// Resolved Linux Core socket path plus whether the parent is the default
/// managed runtime directory (`$HOME/.goalport/runtime`).
#[cfg(target_os = "linux")]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedUnixSocketPath {
    pub path: std::path::PathBuf,
    /// When true, bind may create the parent with mode `0700` and chmod it.
    /// Explicit absolute endpoints leave this false so shared parents are not
    /// mutated.
    pub managed_runtime_parent: bool,
}

/// Resolve a Linux Core socket endpoint identity to a filesystem path.
///
/// - Absolute path → used as-is (no chmod of parents on bind).
/// - Otherwise → `~/.goalport/runtime/<hashed-leaf>.sock` (managed parent).
///
/// Clients may still override with `GOALPORT_SOCK`; the server always binds
/// the path resolved from `--pipe` (or an explicit path passed to
/// [`CoreServer::serve_unix_socket_at`]).
#[cfg(target_os = "linux")]
pub fn resolve_unix_socket_path(endpoint: &str) -> Result<std::path::PathBuf, IpcError> {
    Ok(resolve_unix_socket(endpoint)?.path)
}

/// Resolve a Linux socket endpoint, including whether the parent is managed.
#[cfg(target_os = "linux")]
pub fn resolve_unix_socket(endpoint: &str) -> Result<ResolvedUnixSocketPath, IpcError> {
    let endpoint = endpoint.trim();
    if endpoint.is_empty() {
        return Err(IpcError::Invalid("Unix socket endpoint is empty".into()));
    }
    let path = std::path::Path::new(endpoint);
    if path.is_absolute() {
        validate_unix_socket_path_capacity(path)?;
        return Ok(ResolvedUnixSocketPath {
            path: path.to_path_buf(),
            managed_runtime_parent: false,
        });
    }
    let home = std::env::var("HOME").map_err(|_| IpcError::Invalid("HOME is required".into()))?;
    resolve_named_unix_socket(std::path::Path::new(&home), endpoint)
}

/// Test seam: resolve a named (non-absolute) endpoint under an explicit home
/// without mutating the process `HOME` environment variable.
#[cfg(target_os = "linux")]
pub fn resolve_named_unix_socket(
    home: &std::path::Path,
    endpoint: &str,
) -> Result<ResolvedUnixSocketPath, IpcError> {
    let endpoint = endpoint.trim();
    if endpoint.is_empty() {
        return Err(IpcError::Invalid("Unix socket endpoint is empty".into()));
    }
    if std::path::Path::new(endpoint).is_absolute() {
        return Err(IpcError::Invalid(
            "resolve_named_unix_socket requires a non-absolute endpoint".into(),
        ));
    }
    let dir = home.join(".goalport").join("runtime");
    let leaf = endpoint_socket_leaf_name(endpoint, &dir)?;
    let path = dir.join(leaf);
    validate_unix_socket_path_capacity(&path)?;
    Ok(ResolvedUnixSocketPath {
        path,
        managed_runtime_parent: true,
    })
}

/// Build the collision-resistant sock leaf name (`{ascii-prefix}--{sha256[:16]}.sock`).
///
/// The prefix is ASCII-only (`is_ascii_alphanumeric` or `-_."); other code
/// points become `_`. The hash is over the original endpoint UTF-8 bytes so
/// `a/b` and `a?b` never collide even when prefixes match. The prefix is
/// shortened only enough for the full absolute path to fit
/// [`LINUX_UNIX_SOCKET_PATH_MAX_BYTES`]; exceeding capacity is an error.
#[cfg(target_os = "linux")]
pub fn endpoint_socket_leaf_name(
    endpoint: &str,
    parent_dir: &std::path::Path,
) -> Result<String, IpcError> {
    use sha2::{Digest, Sha256};
    use std::os::unix::ffi::OsStrExt;

    let digest = Sha256::digest(endpoint.as_bytes());
    let hash = digest
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    let hash = &hash[..ENDPOINT_NAME_HASH_HEX_LEN];
    let suffix = format!("{ENDPOINT_NAME_HASH_SEP}{hash}.sock");
    let parent_len = parent_dir.as_os_str().as_bytes().len().saturating_add(1);
    let max_leaf = LINUX_UNIX_SOCKET_PATH_MAX_BYTES.saturating_sub(parent_len);
    if suffix.len() > max_leaf {
        return Err(IpcError::Invalid(format!(
            "Unix socket path would exceed Linux sun_path capacity ({LINUX_UNIX_SOCKET_PATH_MAX_BYTES} bytes)"
        )));
    }
    let max_prefix = max_leaf - suffix.len();
    let mut prefix: String = endpoint
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '_'
            }
        })
        .collect();
    if prefix.is_empty() {
        prefix.push_str("endpoint");
    }
    if prefix.len() > max_prefix {
        prefix.truncate(max_prefix);
    }
    Ok(format!("{prefix}{suffix}"))
}

#[cfg(target_os = "linux")]
fn validate_unix_socket_path_capacity(path: &std::path::Path) -> Result<(), IpcError> {
    use std::os::unix::ffi::OsStrExt;
    let len = path.as_os_str().as_bytes().len();
    if len > LINUX_UNIX_SOCKET_PATH_MAX_BYTES {
        return Err(IpcError::Invalid(format!(
            "Unix socket path is {len} bytes; Linux sun_path capacity is {LINUX_UNIX_SOCKET_PATH_MAX_BYTES} bytes"
        )));
    }
    if len == 0 {
        return Err(IpcError::Invalid("Unix socket path is empty".into()));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn require_owner_umask_bits() -> Result<(), IpcError> {
    let status = std::fs::read_to_string("/proc/thread-self/status")?;
    let value = status
        .lines()
        .find_map(|line| line.strip_prefix("Umask:"))
        .ok_or_else(|| IpcError::Invalid("Linux thread umask is unavailable".into()))?;
    let mask = u32::from_str_radix(value.trim(), 8)
        .map_err(|_| IpcError::Invalid("Linux thread umask is invalid".into()))?;
    if mask & 0o700 != 0 {
        return Err(IpcError::Invalid(
            "Unix socket startup requires a umask that preserves owner permissions".into(),
        ));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn adjacent_lock_path(socket: &std::path::Path) -> std::path::PathBuf {
    let mut lock = socket.as_os_str().to_owned();
    lock.push(".lock");
    std::path::PathBuf::from(lock)
}

/// Open or create one managed directory component without following a symlink.
#[cfg(target_os = "linux")]
fn open_or_create_managed_dir_at(
    parent: &std::fs::File,
    name: &std::ffi::CStr,
) -> Result<std::fs::File, IpcError> {
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::fs::MetadataExt;

    let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
    let mut raw = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
    if raw < 0 && io::Error::last_os_error().kind() == io::ErrorKind::NotFound {
        let created = unsafe { libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), 0o700) };
        if created != 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::EEXIST) {
                return Err(IpcError::Io(error));
            }
        }
        raw = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
    }
    if raw < 0 {
        let error = io::Error::last_os_error();
        if matches!(error.raw_os_error(), Some(libc::ELOOP | libc::ENOTDIR)) {
            return Err(IpcError::Invalid(
                "managed Unix socket directory component must not be a symlink".into(),
            ));
        }
        return Err(IpcError::Io(error));
    }
    let directory = unsafe { std::fs::File::from_raw_fd(raw) };
    if directory.metadata()?.uid() != current_uid() {
        return Err(IpcError::Invalid(
            "managed Unix socket directory must be owned by the current user".into(),
        ));
    }
    Ok(directory)
}

/// Ensure the socket parent directory exists. Managed components are opened
/// relative to directory fds with `O_NOFOLLOW`; only the owned runtime fd is
/// chmodded. Explicit absolute paths never chmod an existing parent.
#[cfg(target_os = "linux")]
fn ensure_socket_parent(path: &std::path::Path, tighten_managed: bool) -> Result<(), IpcError> {
    use std::os::fd::AsRawFd;
    let Some(parent) = path.parent() else {
        return Ok(());
    };
    if parent.as_os_str().is_empty() {
        return Ok(());
    }
    if tighten_managed {
        let managed_root = parent.parent().ok_or_else(|| {
            IpcError::Invalid("managed Unix socket path has no .goalport parent".into())
        })?;
        if parent.file_name() != Some(std::ffi::OsStr::new("runtime"))
            || managed_root.file_name() != Some(std::ffi::OsStr::new(".goalport"))
        {
            return Err(IpcError::Invalid(
                "managed Unix socket path must end in .goalport/runtime".into(),
            ));
        }
        let home = managed_root.parent().ok_or_else(|| {
            IpcError::Invalid("managed Unix socket path has no home directory".into())
        })?;
        let home_dir = std::fs::File::open(home)?;
        let managed = open_or_create_managed_dir_at(
            &home_dir,
            std::ffi::CStr::from_bytes_with_nul(b".goalport\0").expect("static component"),
        )?;
        let runtime = open_or_create_managed_dir_at(
            &managed,
            std::ffi::CStr::from_bytes_with_nul(b"runtime\0").expect("static component"),
        )?;
        if unsafe { libc::fchmod(runtime.as_raw_fd(), 0o700) } != 0 {
            return Err(IpcError::Io(io::Error::last_os_error()));
        }
    } else if !parent.exists() {
        std::fs::create_dir_all(parent)?;
    }
    Ok(())
}

/// Exclusive ownership of a Linux Unix-socket endpoint for the server lifetime.
/// The flock on `_lock` is held until this value is dropped; the sock file is
/// not unlinked on drop (marked stale files are recovered on the next bind).
#[cfg(target_os = "linux")]
struct UnixConnectionPermit(Arc<std::sync::atomic::AtomicUsize>);

#[cfg(target_os = "linux")]
impl Drop for UnixConnectionPermit {
    fn drop(&mut self) {
        self.0.fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
    }
}

#[cfg(target_os = "linux")]
pub struct OwnedUnixSocket {
    _lock: std::fs::File,
    listener: std::os::unix::net::UnixListener,
}

#[cfg(target_os = "linux")]
const UNIX_SOCKET_LOCK_MAGIC: &str = "goalport-unix-socket-lock-v1";

#[cfg(target_os = "linux")]
fn unix_socket_lock_marker(
    path: &std::path::Path,
    socket: Option<&std::fs::Metadata>,
) -> String {
    use sha2::{Digest, Sha256};
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::MetadataExt;

    let digest = Sha256::digest(path.as_os_str().as_bytes());
    let (dev, ino, ctime, ctime_nsec) = socket
        .map(|metadata| {
            (
                metadata.dev(),
                metadata.ino(),
                metadata.ctime(),
                metadata.ctime_nsec(),
            )
        })
        .unwrap_or((0, 0, 0, 0));
    format!("{UNIX_SOCKET_LOCK_MAGIC} {digest:x} {dev} {ino} {ctime} {ctime_nsec}\n")
}

#[cfg(target_os = "linux")]
fn valid_unix_socket_lock_marker(path: &std::path::Path, marker: &str) -> bool {
    let unclaimed = unix_socket_lock_marker(path, None);
    let parts = marker.split_whitespace().collect::<Vec<_>>();
    let expected = unclaimed.split_whitespace().collect::<Vec<_>>();
    parts.len() == 6
        && parts[0] == expected[0]
        && parts[1] == expected[1]
        && parts[2].parse::<u64>().is_ok()
        && parts[3].parse::<u64>().is_ok()
        && parts[4].parse::<i64>().is_ok()
        && parts[5].parse::<i64>().is_ok()
        && marker.ends_with('\n')
}

#[cfg(target_os = "linux")]
fn write_unix_socket_lock_marker(lock: &mut std::fs::File, marker: &str) -> Result<(), IpcError> {
    use std::io::{Seek, SeekFrom};

    lock.seek(SeekFrom::Start(0))?;
    lock.write_all(marker.as_bytes())?;
    lock.set_len(marker.len() as u64)?;
    lock.sync_all()?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn remove_matching_bound_socket(
    path: &std::path::Path,
    expected: &std::fs::Metadata,
) -> Result<(), IpcError> {
    use std::os::unix::fs::{FileTypeExt, MetadataExt};

    let actual = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(IpcError::Io(error)),
    };
    if !actual.file_type().is_socket()
        || actual.dev() != expected.dev()
        || actual.ino() != expected.ino()
        || actual.ctime() != expected.ctime()
        || actual.ctime_nsec() != expected.ctime_nsec()
    {
        return Err(IpcError::Invalid(
            "new Unix socket path changed before cleanup; refusing to unlink it".into(),
        ));
    }
    std::fs::remove_file(path)?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn remove_matching_lock(
    path: &std::path::Path,
    expected: &std::fs::Metadata,
) -> Result<(), IpcError> {
    use std::os::unix::fs::MetadataExt;

    let actual = std::fs::symlink_metadata(path)?;
    if !actual.file_type().is_file()
        || actual.dev() != expected.dev()
        || actual.ino() != expected.ino()
    {
        return Err(IpcError::Invalid(
            "Unix socket lock path changed before cleanup; refusing to unlink it".into(),
        ));
    }
    std::fs::remove_file(path)?;
    Ok(())
}

/// Linux copies the socket fd's mode (masked by the current umask) when it
/// creates a pathname socket. Restrict the fd before bind so no process-wide
/// umask change or briefly accessible pathname is needed.
#[cfg(target_os = "linux")]
fn bind_restricted_unix_listener(
    path: &std::path::Path,
) -> Result<(std::os::unix::net::UnixListener, std::fs::Metadata), IpcError> {
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::ffi::OsStrExt;

    validate_unix_socket_path_capacity(path)?;
    let bytes = path.as_os_str().as_bytes();
    if bytes.contains(&0) {
        return Err(IpcError::Invalid("Unix socket path contains NUL".into()));
    }
    let raw = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0) };
    if raw < 0 {
        return Err(IpcError::Io(io::Error::last_os_error()));
    }
    let fd = unsafe { OwnedFd::from_raw_fd(raw) };
    if unsafe { libc::fchmod(fd.as_raw_fd(), 0o600) } != 0 {
        return Err(IpcError::Io(io::Error::last_os_error()));
    }

    let mut address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    address.sun_family = libc::AF_UNIX as libc::sa_family_t;
    for (slot, byte) in address.sun_path.iter_mut().zip(bytes) {
        *slot = *byte as libc::c_char;
    }
    let address_len = (std::mem::offset_of!(libc::sockaddr_un, sun_path) + bytes.len() + 1)
        as libc::socklen_t;
    if unsafe {
        libc::bind(
            fd.as_raw_fd(),
            &address as *const _ as *const libc::sockaddr,
            address_len,
        )
    } != 0
    {
        return Err(IpcError::Io(io::Error::last_os_error()));
    }
    let bound_metadata = std::fs::symlink_metadata(path)?;
    if unsafe { libc::listen(fd.as_raw_fd(), 128) } != 0 {
        let listen_error = IpcError::Io(io::Error::last_os_error());
        drop(fd);
        remove_matching_bound_socket(path, &bound_metadata).map_err(|cleanup_error| {
            IpcError::Invalid(format!(
                "Unix socket listen failed ({listen_error}); socket cleanup failed ({cleanup_error})"
            ))
        })?;
        return Err(listen_error);
    }
    Ok((std::os::unix::net::UnixListener::from(fd), bound_metadata))
}

#[cfg(target_os = "linux")]
fn acquire_unix_endpoint_lock(
    lock: &std::fs::File,
    created: bool,
    on_contention: impl FnOnce(),
) -> io::Result<()> {
    use std::os::fd::AsRawFd;
    use std::time::Instant;

    // A second starter can open a just-created lock before its creator flocks
    // it. Give that reader time to reject the still-empty marker and release.
    let deadline = Instant::now() + Duration::from_millis(250);
    let mut on_contention = Some(on_contention);
    loop {
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        if !created || error.kind() != io::ErrorKind::WouldBlock || Instant::now() >= deadline {
            return Err(error);
        }
        if let Some(callback) = on_contention.take() {
            callback();
        }
        std::thread::sleep(Duration::from_millis(1));
    }
}

#[cfg(target_os = "linux")]
fn acquire_or_remove_new_lock(
    lock: &std::fs::File,
    lock_path: &std::path::Path,
    lock_metadata: &std::fs::Metadata,
    created: bool,
    on_contention: impl FnOnce(),
) -> Result<(), IpcError> {
    if let Err(error) = acquire_unix_endpoint_lock(lock, created, on_contention) {
        if created {
            remove_matching_lock(lock_path, lock_metadata).map_err(|cleanup_error| {
                IpcError::Invalid(format!(
                    "Unix socket lock acquisition failed ({error}); lock cleanup failed ({cleanup_error})"
                ))
            })?;
        }
        return Err(IpcError::Invalid(format!(
            "Unix socket endpoint is already owned; refusing to replace it ({error})"
        )));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn bind_unix_socket(
    path: &std::path::Path,
    tighten_managed: bool,
) -> Result<OwnedUnixSocket, IpcError> {
    use std::os::unix::fs::{FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt};

    validate_unix_socket_path_capacity(path)?;
    require_owner_umask_bits()?;
    ensure_socket_parent(path, tighten_managed)?;
    let lock_path = adjacent_lock_path(path);
    let (mut lock, created) = match std::fs::OpenOptions::new()
        .create_new(true)
        .read(true)
        .write(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&lock_path)
    {
        Ok(lock) => (lock, true),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => (
            std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .custom_flags(libc::O_NOFOLLOW)
                .open(&lock_path)?,
            false,
        ),
        Err(error) => return Err(IpcError::Io(error)),
    };
    let lock_metadata = lock.metadata()?;
    if !lock_metadata.file_type().is_file()
        || lock_metadata.uid() != current_uid()
        || lock_metadata.nlink() != 1
        || lock_metadata.permissions().mode() & 0o7777 != 0o600
    {
        return Err(IpcError::Invalid(
            "Unix socket lock must be an owned, single-link 0o600 regular file".into(),
        ));
    }
    acquire_or_remove_new_lock(&lock, &lock_path, &lock_metadata, created, || {})?;
    let path_metadata = std::fs::symlink_metadata(&lock_path)?;
    if !path_metadata.file_type().is_file()
        || path_metadata.uid() != current_uid()
        || path_metadata.nlink() != 1
        || path_metadata.permissions().mode() & 0o7777 != 0o600
        || path_metadata.dev() != lock_metadata.dev()
        || path_metadata.ino() != lock_metadata.ino()
    {
        return Err(IpcError::Invalid(
            "Unix socket lock path changed while acquiring ownership".into(),
        ));
    }
    let marker = if created {
        let marker = unix_socket_lock_marker(path, None);
        let initial_write = if std::env::var("GOALPORT_REQUIRE_ISOLATED").ok().as_deref()
            == Some("1")
            && std::env::var("GOALPORT_TEST_SOCKET_MARKER_FAILURE")
                .ok()
                .as_deref()
                == Some("initial")
        {
            write_unix_socket_lock_marker(&mut lock, "partial-marker\n").and_then(|_| {
                Err(IpcError::Invalid(
                    "injected initial Unix socket marker failure".into(),
                ))
            })
        } else {
            write_unix_socket_lock_marker(&mut lock, &marker)
        };
        if let Err(marker_error) = initial_write {
            remove_matching_lock(&lock_path, &lock_metadata).map_err(|cleanup_error| {
                IpcError::Invalid(format!(
                    "initial Unix socket marker failed ({marker_error}); lock cleanup failed ({cleanup_error})"
                ))
            })?;
            return Err(marker_error);
        }
        marker
    } else {
        if lock.metadata()?.len() > 256 {
            return Err(IpcError::Invalid(
                "Unix socket lock has no valid GoalPort ownership marker".into(),
            ));
        }
        use std::io::{Seek, SeekFrom};
        lock.seek(SeekFrom::Start(0))?;
        let mut marker = String::new();
        lock.read_to_string(&mut marker)?;
        if !valid_unix_socket_lock_marker(path, &marker) {
            return Err(IpcError::Invalid(
                "Unix socket lock has no valid GoalPort ownership marker".into(),
            ));
        }
        marker
    };

    // Only an ECONNREFUSED socket with the exact inode recorded by a prior
    // GoalPort bind may be reclaimed. A failed stream connect alone cannot
    // distinguish stale streams from live datagram or seqpacket endpoints.
    match std::os::unix::net::UnixStream::connect(path) {
        Ok(stream) => {
            if unix_peer_uid_matches(&stream, current_uid())? {
                return Err(IpcError::Invalid(
                    "Unix socket is already served by this user; refusing to replace it".into(),
                ));
            }
            return Err(IpcError::Invalid(
                "Unix socket is already served; refusing to replace it".into(),
            ));
        }
        Err(connect_error) => match std::fs::symlink_metadata(path) {
            Ok(metadata) if metadata.file_type().is_socket() => {
                if connect_error.raw_os_error() != Some(libc::ECONNREFUSED)
                    || marker != unix_socket_lock_marker(path, Some(&metadata))
                {
                    return Err(IpcError::Invalid(
                        "Unix socket endpoint is not a proven stale GoalPort stream; refusing to replace it"
                            .into(),
                    ));
                }
                std::fs::remove_file(path)?;
            }
            Ok(_) => {
                return Err(IpcError::Invalid(
                    "Unix socket endpoint exists but is not a Unix socket; refusing to replace it"
                        .into(),
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(IpcError::Io(error)),
        },
    }

    let (listener, bound_metadata) = bind_restricted_unix_listener(path)?;
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) => {
            drop(listener);
            remove_matching_bound_socket(path, &bound_metadata)?;
            return Err(IpcError::Io(error));
        }
    };
    let mode = metadata.permissions().mode() & 0o777;
    let is_bound_inode = metadata.file_type().is_socket()
        && metadata.dev() == bound_metadata.dev()
        && metadata.ino() == bound_metadata.ino()
        && metadata.ctime() == bound_metadata.ctime()
        && metadata.ctime_nsec() == bound_metadata.ctime_nsec();
    if !is_bound_inode || mode != 0o600 {
        drop(listener);
        if is_bound_inode {
            remove_matching_bound_socket(path, &bound_metadata)?;
        }
        return Err(IpcError::Invalid(format!(
            "Unix socket endpoint is not the newly bound 0o600 socket (mode {mode:#o})"
        )));
    }
    let persist_marker = if std::env::var("GOALPORT_REQUIRE_ISOLATED").ok().as_deref() == Some("1")
        && std::env::var("GOALPORT_TEST_SOCKET_MARKER_FAILURE")
            .ok()
            .as_deref()
            == Some("after-bind")
    {
        // Leave invalid marker bytes before the injected error so the test
        // proves cleanup handles a partially published lock record.
        write_unix_socket_lock_marker(&mut lock, "partial-marker\n").and_then(|_| {
            Err(IpcError::Invalid(
                "injected post-bind Unix socket marker failure".into(),
            ))
        })
    } else {
        write_unix_socket_lock_marker(&mut lock, &unix_socket_lock_marker(path, Some(&metadata)))
    };
    if let Err(marker_error) = persist_marker {
        drop(listener);
        remove_matching_bound_socket(path, &metadata).map_err(|cleanup_error| {
            IpcError::Invalid(format!(
                "Unix socket marker persistence failed ({marker_error}); socket cleanup failed ({cleanup_error})"
            ))
        })?;
        remove_matching_lock(&lock_path, &lock_metadata).map_err(|cleanup_error| {
            IpcError::Invalid(format!(
                "Unix socket marker persistence failed ({marker_error}); lock cleanup failed ({cleanup_error})"
            ))
        })?;
        return Err(marker_error);
    }
    Ok(OwnedUnixSocket {
        _lock: lock,
        listener,
    })
}

#[cfg(target_os = "linux")]
fn unix_peer_uid_matches(
    stream: &std::os::unix::net::UnixStream,
    expected: u32,
) -> Result<bool, IpcError> {
    use std::os::unix::io::AsRawFd;
    let mut cred: libc::ucred = unsafe { std::mem::zeroed() };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    let rc = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            &mut cred as *mut _ as *mut libc::c_void,
            &mut len,
        )
    };
    if rc != 0 {
        return Err(IpcError::Invalid(
            "SO_PEERCRED unavailable; refusing connection".into(),
        ));
    }
    Ok(cred.uid == expected)
}
