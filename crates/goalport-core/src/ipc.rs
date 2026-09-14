//! Versioned local IPC for the detached Core.
//!
//! Windows builds use a Named Pipe whose security descriptor is set explicitly:
//! only the Windows user that runs Core has access, remote clients are rejected,
//! Core never joins a pipe name created by someone else, and every instance is
//! read back and verified before use (fail closed). The JSON framing and request
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
            securitybaseapi::{EqualSid, GetAce, GetSecurityDescriptorControl, GetTokenInformation},
            winbase::{
                FILE_FLAG_FIRST_PIPE_INSTANCE, GetNamedPipeServerProcessId, LocalFree,
                PIPE_ACCESS_DUPLEX, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS,
                PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT, SECURITY_IDENTIFICATION,
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
                winbase::{PIPE_REJECT_REMOTE_CLIENTS, SECURITY_IDENTIFICATION, SECURITY_SQOS_PRESENT},
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
                assert_ne!(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token), 0);
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
                assert_ne!(winapi::shared::sddl::ConvertSidToStringSidW(sid, &mut raw), 0);
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
