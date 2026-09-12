//! Versioned local IPC for the detached Core.
//!
//! Windows builds use a current-user Named Pipe. The JSON framing and request
//! ledger are platform-independent, which lets contract tests run without a
//! desktop or a provider Runtime.

use crate::{
    commands::{CommandError, CommandExecution, CommandProcessor, CoreCommand},
    projection::UiController,
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
        if self.protocol_version != IPC_PROTOCOL_VERSION
            && self.protocol_version != CONNECTED_UI_PROTOCOL_VERSION
        {
            return Err(IpcError::ProtocolVersion {
                expected: IPC_PROTOCOL_VERSION.into(),
                received: self.protocol_version.clone(),
            });
        }
        if self.request_id.trim().is_empty() {
            return Err(IpcError::Invalid("request_id is empty".into()));
        }
        if self.entity_version <= 0 {
            return Err(IpcError::Invalid("entity_version must be positive".into()));
        }
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
        if self.protocol_version != IPC_PROTOCOL_VERSION
            && self.protocol_version != CONNECTED_UI_PROTOCOL_VERSION
        {
            return Err(IpcError::ProtocolVersion {
                expected: IPC_PROTOCOL_VERSION.into(),
                received: self.protocol_version.clone(),
            });
        }
        if self.request_id.trim().is_empty() || self.message_type.trim().is_empty() {
            return Err(IpcError::Invalid(
                "request_id and message_type are required".into(),
            ));
        }
        if self.entity_version < 0 {
            return Err(IpcError::Invalid(
                "entity_version must be non-negative".into(),
            ));
        }
        Ok(())
    }
}

impl IpcResponse {
    fn error(request: &IpcRequest, error: impl Into<String>) -> Self {
        Self {
            protocol_version: IPC_PROTOCOL_VERSION.into(),
            request_id: request.request_id.clone(),
            entity_version: request.entity_version,
            ok: false,
            duplicate: false,
            result: None,
            error: Some(error.into()),
        }
    }
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
            return IpcResponse::error(&request, error.to_string());
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
            },
            Err(error) => IpcResponse::error(&request, error.to_string()),
        };
        self.ledger
            .lock()
            .expect("ipc ledger poisoned")
            .responses
            .insert(request.request_id, response.clone());
        response
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
                if request.message_type == "snapshot"
                    && request.protocol_version == IPC_PROTOCOL_VERSION
                {
                    // Legacy v1 desktop probes intentionally retain the
                    // historical StoreCounts response. Connected Preview v2
                    // requests below receive the complete UI projection.
                    let counts = self.processor.store().counts()?;
                    Ok(serde_json::to_value(UiCommandResponse {
                        protocol_version: IPC_PROTOCOL_VERSION,
                        request_id: request.request_id,
                        entity_version: request.entity_version,
                        ok: true,
                        payload: serde_json::to_value(counts)?,
                        error: None,
                    })?)
                } else {
                    if std::env::var_os("GOALPORT_DEBUG").is_some() {
                        eprintln!("goalport-ui: handling {}", request.message_type);
                    }
                    match self
                        .ui
                        .lock()
                        .expect("ui projection poisoned")
                        .handle(request.clone())
                    {
                        Ok(result) => {
                            if std::env::var_os("GOALPORT_DEBUG").is_some() {
                                eprintln!("goalport-ui: completed {}", request.message_type);
                            }
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
                            Ok(value)
                        }
                        Err(error) => Ok(serde_json::to_value(UiCommandResponse {
                            protocol_version: CONNECTED_UI_PROTOCOL_VERSION,
                            request_id: request.request_id,
                            entity_version: request.entity_version,
                            ok: false,
                            payload: Value::Null,
                            error: Some(error),
                        })?),
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
                    // Continue-then-destroy can invalidate the listening
                    // instance. Re-bind the same name so a later UI attaches
                    // instead of spawning a second Core.
                    thread::sleep(Duration::from_millis(20));
                    match NamedPipeServer::bind(name) {
                        Ok(next) => server = next,
                        Err(IpcError::Io(_)) => {}
                        Err(error) => return Err(error),
                    }
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
    use super::{IpcClient, IpcError};
    use std::{
        ffi::OsStr,
        fs::File,
        io::{Read, Write},
        os::windows::ffi::OsStrExt,
        os::windows::io::FromRawHandle,
    };
    use winapi::um::winnt::{FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, FILE_SHARE_WRITE};
    use winapi::{
        shared::{ntdef::NULL, winerror::ERROR_PIPE_CONNECTED},
        um::{
            errhandlingapi::GetLastError,
            fileapi::{CreateFileW, OPEN_EXISTING},
            handleapi::{CloseHandle, INVALID_HANDLE_VALUE},
            namedpipeapi::{ConnectNamedPipe, CreateNamedPipeW},
            winbase::{
                PIPE_ACCESS_DUPLEX, PIPE_READMODE_BYTE, PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES,
                PIPE_WAIT,
            },
            winnt::{GENERIC_READ, GENERIC_WRITE},
        },
    };

    fn wide(value: &str) -> Vec<u16> {
        OsStr::new(value)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    #[derive(Debug)]
    pub struct NamedPipeServer {
        name: String,
        handle: *mut std::ffi::c_void,
    }
    unsafe impl Send for NamedPipeServer {}
    unsafe impl Sync for NamedPipeServer {}

    impl NamedPipeServer {
        pub fn bind(name: &str) -> Result<Self, IpcError> {
            let name = if name.starts_with(r"\\.\pipe\") {
                name.to_owned()
            } else {
                format!(r"\\.\pipe\{name}")
            };
            let handle = create(&name)?;
            Ok(Self { name, handle })
        }

        fn create_instance(&self) -> Result<*mut std::ffi::c_void, IpcError> {
            create(&self.name)
        }

        pub fn accept(&mut self) -> Result<NamedPipeConnection, IpcError> {
            let connected = unsafe { ConnectNamedPipe(self.handle as _, std::ptr::null_mut()) };
            if connected == 0 && unsafe { GetLastError() } != ERROR_PIPE_CONNECTED {
                return Err(IpcError::Io(std::io::Error::last_os_error()));
            }
            let handle = self.handle;
            self.handle = std::ptr::null_mut();
            let file = unsafe { File::from_raw_handle(handle as _) };
            match self.create_instance() {
                Ok(next) => {
                    self.handle = next;
                    Ok(NamedPipeConnection { file })
                }
                Err(error) => Err(error),
            }
        }
    }

    fn create(name: &str) -> Result<*mut std::ffi::c_void, IpcError> {
        let name = wide(name);
        let handle = unsafe {
            CreateNamedPipeW(
                name.as_ptr(),
                PIPE_ACCESS_DUPLEX,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
                PIPE_UNLIMITED_INSTANCES,
                65_536,
                65_536,
                0,
                std::ptr::null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(IpcError::Io(std::io::Error::last_os_error()));
        }
        Ok(handle as _)
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
            let name = if name.starts_with(r"\\.\pipe\") {
                name.to_owned()
            } else {
                format!(r"\\.\pipe\{name}")
            };
            let name = wide(&name);
            let handle = unsafe {
                CreateFileW(
                    name.as_ptr(),
                    GENERIC_READ | GENERIC_WRITE,
                    FILE_SHARE_READ | FILE_SHARE_WRITE,
                    std::ptr::null_mut(),
                    OPEN_EXISTING,
                    FILE_ATTRIBUTE_NORMAL,
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
}

#[cfg(windows)]
pub use windows_pipe::{NamedPipeClient, NamedPipeConnection, NamedPipeServer};

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        commands::{CoreCommand, CoreOperation},
        domain::{Attempt, AttemptState},
    };
    use std::io::Cursor;

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
}
