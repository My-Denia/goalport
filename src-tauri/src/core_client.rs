//! Thin Desktop -> Core bridge.
//!
//! The desktop never opens the Core database and never launches a provider
//! Runtime. It only sends versioned, length-delimited JSON frames to the
//! lifecycle-independent Core over the current user's Named Pipe.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs::{File, OpenOptions},
    io::{Read, Write},
    path::PathBuf,
    process::{Command, Stdio},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

pub const IPC_PROTOCOL_VERSION: &str = "goalport.ipc.v2";
pub const DEFAULT_PIPE_NAME: &str = r"\\.\pipe\goalport-core-v1";
const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiCommandRequest {
    pub protocol_version: String,
    pub request_id: String,
    pub entity_version: i64,
    pub message_type: String,
    #[serde(default)]
    pub payload: Value,
}

impl UiCommandRequest {
    pub fn validate(&self) -> Result<(), String> {
        if self.protocol_version != IPC_PROTOCOL_VERSION
            && self.protocol_version != "goalport.ipc.v1"
        {
            return Err(format!(
                "IPC protocol mismatch: expected {IPC_PROTOCOL_VERSION}, received {}",
                self.protocol_version
            ));
        }
        if self.request_id.trim().is_empty() {
            return Err("request_id is empty".into());
        }
        if self.entity_version < 0 {
            return Err("entity_version must be non-negative".into());
        }
        if self.message_type.trim().is_empty() {
            return Err("message_type is empty".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreStatus {
    pub protocol_version: &'static str,
    pub pipe_name: String,
    pub connected: bool,
    pub lifecycle: &'static str,
    pub ownership: &'static str,
}

#[derive(Debug, Clone)]
pub struct CoreConnection {
    pipe_name: String,
    core_binary: Option<PathBuf>,
    launcher_binary: Option<PathBuf>,
}

impl Default for CoreConnection {
    fn default() -> Self {
        let pipe_name =
            std::env::var("GOALPORT_CORE_PIPE").unwrap_or_else(|_| DEFAULT_PIPE_NAME.to_string());
        let core_binary = std::env::var_os("GOALPORT_CORE_BIN")
            .map(PathBuf::from)
            .or_else(|| adjacent_binary("goalport-core.exe"));
        let launcher_binary = std::env::var_os("GOALPORT_CORE_LAUNCHER_BIN")
            .map(PathBuf::from)
            .or_else(|| adjacent_binary("goalport-core-launcher.exe"));
        Self {
            pipe_name,
            core_binary,
            launcher_binary,
        }
    }
}

impl CoreConnection {
    pub fn status(&self) -> CoreStatus {
        CoreStatus {
            protocol_version: IPC_PROTOCOL_VERSION,
            pipe_name: self.pipe_name.clone(),
            connected: self.can_open_pipe(),
            lifecycle: "detached-core",
            ownership: "Core owns persistence and Runtime connections",
        }
    }

    /// Start only the GoalPort Core executable, when an explicit binary path
    /// was configured. The child is detached from the UI's stdio and is not a
    /// provider Runtime. Dropping this process handle intentionally leaves Core
    /// independent from the window lifecycle.
    pub fn ensure_started(&self) -> Result<CoreStatus, String> {
        if self.can_open_pipe() {
            return Ok(self.status());
        }
        let Some(binary) = self.core_binary.as_ref() else {
            return Err("Core is not running and GOALPORT_CORE_BIN is not configured".into());
        };
        let db = std::env::var_os("GOALPORT_CORE_DB")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::current_exe()
                    .ok()
                    .and_then(|exe| exe.parent().map(|parent| parent.join("goalport.sqlite")))
            })
            .unwrap_or_else(|| PathBuf::from("goalport.sqlite"));
        let mut command = if let Some(launcher) = self.launcher_binary.as_ref() {
            let mut command = Command::new(launcher);
            command.arg(binary);
            command
        } else {
            Command::new(binary)
        };
        command
            .arg("serve")
            .arg("--pipe")
            .arg(&self.pipe_name)
            .arg("--db")
            .arg(db)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        command
            .spawn()
            .map_err(|error| format!("unable to start the detached Core: {error}"))?;
        // Cold Windows startup can include SQLite migration and process setup.
        // Give the detached Core the same bounded 10-second readiness window
        // used by the Electron host.
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if self.can_open_pipe() {
                return Ok(self.status());
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        Err("detached Core did not expose its Named Pipe within 10 seconds".into())
    }

    /// Request a Core projection through the same framed IPC boundary as
    /// commands. A newer Core may implement `snapshot`; an older Core returns
    /// an explicit unsupported/protocol error which the UI displays as a
    /// disconnected Preview state.
    pub fn snapshot(&self) -> Result<Value, String> {
        let request_id = format!("desktop-snapshot-{}", monotonic_id());
        let wire = json!({
            "protocol_version": IPC_PROTOCOL_VERSION,
            "request_id": request_id,
            "entity_version": 0,
            "message_type": "snapshot",
            "payload": {}
        });
        unwrap_ui_snapshot(self.exchange(&wire)?)
    }

    pub fn command(&self, request: UiCommandRequest) -> Result<Value, String> {
        request.validate()?;
        let request_id = request.request_id.clone();
        let wire = serde_json::to_value(request)
            .map_err(|error| format!("unable to encode Core command: {error}"))?;
        let response = self.exchange(&wire)?;
        if response.get("requestId").or_else(|| response.get("request_id")).and_then(Value::as_str) != Some(request_id.as_str()) {
            return Err("Core response identity does not match the request; result remains unknown".into());
        }
        unwrap_command_result(response)
    }

    fn exchange(&self, value: &Value) -> Result<Value, String> {
        let bytes = serde_json::to_vec(value)
            .map_err(|error| format!("unable to encode IPC request: {error}"))?;
        if bytes.len() > MAX_FRAME_BYTES {
            return Err("IPC request exceeds the maximum frame size".into());
        }
        let mut pipe = self.open_pipe()?;
        write_frame(&mut pipe, &bytes)?;
        let response = read_frame(&mut pipe)?
            .ok_or_else(|| "Core closed the IPC connection without a response".to_string())?;
        serde_json::from_slice(&response)
            .map_err(|error| format!("Core returned invalid JSON: {error}"))
    }

    fn can_open_pipe(&self) -> bool {
        #[cfg(windows)]
        {
            use std::{ffi::OsStr, os::windows::ffi::OsStrExt};
            use windows_sys::Win32::System::Pipes::WaitNamedPipeW;

            let name = normalized_pipe_name(&self.pipe_name);
            let wide: Vec<u16> = OsStr::new(&name)
                .encode_wide()
                .chain(std::iter::once(0))
                .collect();
            // A zero timeout asks Windows to report availability without
            // consuming a server connection. Opening the pipe here would
            // steal the single accepted connection from the next command.
            unsafe { WaitNamedPipeW(wide.as_ptr(), 0) != 0 }
        }
        #[cfg(not(windows))]
        {
            false
        }
    }

    fn open_pipe(&self) -> Result<File, String> {
        #[cfg(windows)]
        {
            OpenOptions::new()
                .read(true)
                .write(true)
                .open(normalized_pipe_name(&self.pipe_name))
                .map_err(|error| format!("Core pipe unavailable: {error}"))
        }
        #[cfg(not(windows))]
        {
            let _ = &self.pipe_name;
            Err("GoalPort Core IPC requires Windows Named Pipe support".into())
        }
    }
}

fn normalized_pipe_name(name: &str) -> String {
    if name.starts_with(r"\\.\pipe\") {
        name.to_owned()
    } else {
        format!(r"\\.\pipe\{name}")
    }
}

fn tagged_core_rejection(value: &Value) -> Option<Value> {
    if value.get("ok").and_then(Value::as_bool) != Some(false) {
        return None;
    }
    let mut result = value.get("payload").and_then(Value::as_object).cloned().unwrap_or_default();
    result.insert("goalportRejected".into(), json!(true));
    result.insert("requestId".into(), value.get("requestId").or_else(|| value.get("request_id")).cloned().unwrap_or(Value::Null));
    result.insert("error".into(), json!(value
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("Core rejected the UI request")));
    Some(Value::Object(result))
}

fn unwrap_ui_snapshot_payload(value: Value) -> Result<Value, String> {
    // v2 responses carry UiCommandResult in payload; retain compatibility with
    // the old direct projection and with a raw UiCommandResponse envelope.
    if let Some(snapshot) = value
        .get("payload")
        .and_then(|payload| payload.get("snapshot"))
    {
        return Ok(snapshot.clone());
    }
    if value.get("payload").is_some() {
        return Ok(value.get("payload").cloned().unwrap_or(Value::Null));
    }
    Ok(value)
}

fn unwrap_ui_snapshot(value: Value) -> Result<Value, String> {
    if let Some(rejected) = tagged_core_rejection(&value) {
        return Err(rejected
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("Core rejected the UI request")
            .to_string());
    }
    unwrap_ui_snapshot_payload(value)
}

fn unwrap_command_result(value: Value) -> Result<Value, String> {
    if let Some(rejected) = tagged_core_rejection(&value) {
        return Ok(rejected);
    }
    // Preserve request acknowledgement, reservation and history metadata. The
    // renderer must never infer delivery from a bare snapshot after a command.
    if let Some(payload) = value.get("payload") {
        return Ok(payload.clone());
    }
    Ok(value)
}

fn write_frame(writer: &mut File, payload: &[u8]) -> Result<(), String> {
    let length = u32::try_from(payload.len()).map_err(|_| "IPC frame is too large".to_string())?;
    writer
        .write_all(&length.to_le_bytes())
        .map_err(|error| format!("IPC write failed: {error}"))?;
    writer
        .write_all(payload)
        .map_err(|error| format!("IPC write failed: {error}"))?;
    writer
        .flush()
        .map_err(|error| format!("IPC flush failed: {error}"))
}

fn read_frame(reader: &mut File) -> Result<Option<Vec<u8>>, String> {
    let mut header = [0_u8; 4];
    let mut offset = 0;
    while offset < header.len() {
        let count = reader
            .read(&mut header[offset..])
            .map_err(|error| format!("IPC read failed: {error}"))?;
        if count == 0 {
            return if offset == 0 {
                Ok(None)
            } else {
                Err("IPC response header is truncated".into())
            };
        }
        offset += count;
    }
    let length = u32::from_le_bytes(header) as usize;
    if length > MAX_FRAME_BYTES {
        return Err("Core response exceeds the maximum frame size".into());
    }
    let mut payload = vec![0_u8; length];
    reader
        .read_exact(&mut payload)
        .map_err(|error| format!("IPC response is truncated: {error}"))?;
    Ok(Some(payload))
}

fn monotonic_id() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default()
}

fn adjacent_binary(name: &str) -> Option<PathBuf> {
    std::env::current_exe().ok().and_then(|exe| {
        let parent = exe.parent()?;
        [
            parent.join(name),
            parent.join("resources").join(name),
            parent.join("binaries").join(name),
        ]
        .into_iter()
        .find(|candidate| candidate.is_file())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_validation_keeps_protocol_and_identity_explicit() {
        let request = UiCommandRequest {
            protocol_version: IPC_PROTOCOL_VERSION.into(),
            request_id: "req-1".into(),
            entity_version: 0,
            message_type: "send_message".into(),
            payload: json!({ "message": "synthetic" }),
        };
        assert!(request.validate().is_ok());

        let mut invalid = request.clone();
        invalid.protocol_version = "future".into();
        assert!(invalid.validate().is_err());
    }

    #[test]
    fn frame_round_trip_is_length_delimited_and_bounded() {
        let value = b"{\"ok\":true}";
        let mut bytes = Vec::new();
        let length = u32::try_from(value.len()).unwrap();
        bytes.extend_from_slice(&length.to_le_bytes());
        bytes.extend_from_slice(value);
        let decoded_length = u32::from_le_bytes(bytes[0..4].try_into().unwrap()) as usize;
        assert_eq!(decoded_length, value.len());
        assert_eq!(&bytes[4..], value);
        assert!(value.len() < MAX_FRAME_BYTES);
    }

    #[test]
    fn short_pipe_name_is_normalized_for_both_probe_and_open() {
        assert_eq!(
            normalized_pipe_name("goalport-connected"),
            r"\\.\pipe\goalport-connected"
        );
        assert_eq!(
            normalized_pipe_name(r"\\.\pipe\goalport-connected"),
            r"\\.\pipe\goalport-connected"
        );
    }

    #[test]
    fn command_result_tags_a_core_business_rejection() {
        let tagged = unwrap_command_result(json!({
            "ok": false,
            "error": "attempt is already bound to a different Runtime binding"
        }))
        .expect("a business rejection is a successful invoke payload");
        assert_eq!(tagged["goalportRejected"], true);
        assert_eq!(
            tagged["error"],
            "attempt is already bound to a different Runtime binding"
        );
    }

    #[test]
    fn snapshot_result_still_surfaces_a_core_rejection_as_an_error() {
        let error = unwrap_ui_snapshot(json!({
            "ok": false,
            "error": "Core rejected the UI request"
        }))
        .expect_err("snapshot keeps ok:false as a transport-level error");
        assert_eq!(error, "Core rejected the UI request");
    }

    #[test]
    fn command_result_preserves_acknowledgement_and_snapshot_payload() {
        let snapshot = unwrap_command_result(json!({
            "ok": true,
            "payload": { "requestId": "r1", "accepted": true, "snapshot": { "connection": "connected", "attempt": { "id": "a-1" } } }
        }))
        .expect("ok:true still unwraps to the snapshot");
        assert_eq!(snapshot["requestId"], "r1");
        assert_eq!(snapshot["accepted"], true);
        assert_eq!(snapshot["snapshot"]["connection"], "connected");
        assert_eq!(snapshot["snapshot"]["attempt"]["id"], "a-1");
    }

    #[test]
    fn rejection_keeps_authoritative_reservation_and_history_has_no_snapshot() {
        let rejected = unwrap_command_result(json!({"requestId":"r1","ok":false,"error":"admission failed",
            "payload":{"requestId":"r1","accepted":false,"snapshot":{"activeCampaignId":"c1"},
            "rejection":{"retryMode":"SAME_REQUEST","reservation":{"campaignId":"c1"}}}})).unwrap();
        assert_eq!(rejected["rejection"]["reservation"]["campaignId"], "c1");
        assert_eq!(rejected["snapshot"]["activeCampaignId"], "c1");
        let page = unwrap_command_result(json!({"ok":true,"payload":{"requestId":"h1","accepted":true,"historyPage":{"ownerId":"c1"}}})).unwrap();
        assert_eq!(page["historyPage"]["ownerId"], "c1");
        assert!(page.get("snapshot").is_none());
    }
}
