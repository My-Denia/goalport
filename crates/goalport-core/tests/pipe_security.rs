//! Named pipe security contract on real Windows objects.
//!
//! These tests prove the Core pipe's explicit security descriptor (current
//! user only, protected DACL), remote rejection, first-instance ownership,
//! fail-closed startup and server authentication (`pipe-peer`). Every control
//! or foreign pipe whose outcome is asserted states `O:<U>G:<U>` explicitly and
//! differs from the Core descriptor only in the property under test.
#![cfg(windows)]

use goalport_core::{
    Attempt, AttemptState, CoreCommand, CoreOperation, CoreServer, IpcError, IpcRequest, Store,
    ipc::{IpcClient, NamedPipeClient, NamedPipeServer, decode_frame, read_frame, verify_pipe_peer, write_frame},
    product_receipts::{PriorCoreStatus, classify_recorded_process},
};
use serde_json::{Value, json};
use std::{
    ffi::OsStr,
    fs::File,
    io::{Read, Write},
    os::windows::{ffi::OsStrExt, io::FromRawHandle},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    ptr::null_mut,
    sync::mpsc,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use winapi::{
    ctypes::c_void,
    shared::{
        minwindef::{DWORD, FALSE},
        sddl::{
            ConvertSecurityDescriptorToStringSecurityDescriptorW, ConvertSidToStringSidW,
            ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
        },
        winerror::{ERROR_ACCESS_DENIED, ERROR_PIPE_BUSY},
    },
    um::{
        accctrl::SE_KERNEL_OBJECT,
        aclapi::GetSecurityInfo,
        errhandlingapi::GetLastError,
        fileapi::{CreateFileW, OPEN_EXISTING},
        handleapi::{CloseHandle, INVALID_HANDLE_VALUE},
        minwinbase::SECURITY_ATTRIBUTES,
        namedpipeapi::{ConnectNamedPipe, CreateNamedPipeW, WaitNamedPipeW},
        processthreadsapi::{GetCurrentProcess, OpenProcessToken},
        securitybaseapi::{
            CreateRestrictedToken, CreateWellKnownSid, EqualSid, GetAce,
            GetSecurityDescriptorControl, GetTokenInformation, ImpersonateLoggedOnUser,
            RevertToSelf,
        },
        winbase::{
            FILE_FLAG_FIRST_PIPE_INSTANCE, LocalFree, PIPE_ACCESS_DUPLEX, PIPE_READMODE_BYTE,
            PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
            SECURITY_IDENTIFICATION, SECURITY_SQOS_PRESENT,
        },
        winnt::{
            ACCESS_ALLOWED_ACE, ACCESS_ALLOWED_ACE_TYPE, DACL_SECURITY_INFORMATION,
            FILE_ALL_ACCESS, GENERIC_READ, GENERIC_WRITE, HANDLE, OWNER_SECURITY_INFORMATION,
            PACL, PSECURITY_DESCRIPTOR, PSID, SE_DACL_PRESENT, SE_DACL_PROTECTED,
            SID_AND_ATTRIBUTES, TOKEN_ASSIGN_PRIMARY, TOKEN_DUPLICATE, TOKEN_IMPERSONATE,
            TOKEN_QUERY, TOKEN_USER, TokenUser, WinBuiltinAdministratorsSid,
        },
    },
};

const CORE: &str = env!("CARGO_BIN_EXE_goalport-core");
const PEER_SCHEMA: &str = "goalport.pipe-peer.v1";

// ---------------------------------------------------------------------------
// Win32 helpers (independent of the crate's implementation)
// ---------------------------------------------------------------------------

fn unique(label: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    format!("goalport-sec-{label}-{}-{nanos}", std::process::id())
}

fn local_path(name: &str) -> String {
    format!(r"\\.\pipe\{name}")
}

fn wide(value: &str) -> Vec<u16> {
    OsStr::new(value)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

struct Handle(HANDLE);
unsafe impl Send for Handle {}
impl Drop for Handle {
    fn drop(&mut self) {
        if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
            unsafe { CloseHandle(self.0) };
        }
    }
}
impl Handle {
    fn into_file(mut self) -> File {
        let raw = std::mem::replace(&mut self.0, null_mut());
        unsafe { File::from_raw_handle(raw as _) }
    }
}

struct TokenUserBuffer(Vec<u64>);
impl TokenUserBuffer {
    fn sid(&self) -> PSID {
        unsafe { (*(self.0.as_ptr() as *const TOKEN_USER)).User.Sid }
    }
}

fn token_user(token: HANDLE) -> TokenUserBuffer {
    let mut buffer = vec![0_u64; 128];
    let mut needed = 0;
    let ok = unsafe {
        GetTokenInformation(
            token,
            TokenUser,
            buffer.as_mut_ptr() as *mut c_void,
            (buffer.len() * 8) as DWORD,
            &mut needed,
        )
    };
    assert_ne!(ok, 0, "TokenUser query failed: {}", unsafe { GetLastError() });
    TokenUserBuffer(buffer)
}

fn process_user() -> TokenUserBuffer {
    let mut token = null_mut();
    assert_ne!(
        unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) },
        0
    );
    let token = Handle(token);
    token_user(token.0)
}

fn wide_to_string(raw: *const u16) -> String {
    unsafe {
        let length = (0..).take_while(|&index| *raw.add(index) != 0).count();
        String::from_utf16(std::slice::from_raw_parts(raw, length)).unwrap()
    }
}

fn user_sid_string() -> String {
    let user = process_user();
    let mut raw: *mut u16 = null_mut();
    assert_ne!(unsafe { ConvertSidToStringSidW(user.sid(), &mut raw) }, 0);
    let text = wide_to_string(raw);
    unsafe { LocalFree(raw as *mut c_void) };
    text
}

fn core_sddl(user: &str) -> String {
    format!("O:{user}G:{user}D:P(A;;FA;;;{user})")
}

/// Creates a raw test pipe instance with an explicit SDDL.
fn create_raw_pipe(name: &str, sddl: &str, open_flags: DWORD, mode: DWORD) -> Result<Handle, u32> {
    let text = wide(sddl);
    let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
    assert_ne!(
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                text.as_ptr(),
                SDDL_REVISION_1 as DWORD,
                &mut descriptor,
                null_mut(),
            )
        },
        0,
        "test SDDL must convert"
    );
    let mut attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as DWORD,
        lpSecurityDescriptor: descriptor,
        bInheritHandle: FALSE,
    };
    let path = wide(&local_path(name));
    let handle = unsafe {
        CreateNamedPipeW(
            path.as_ptr(),
            PIPE_ACCESS_DUPLEX | open_flags,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | mode,
            PIPE_UNLIMITED_INSTANCES,
            65_536,
            65_536,
            0,
            &mut attributes,
        )
    };
    let error = unsafe { GetLastError() };
    unsafe { LocalFree(descriptor as *mut c_void) };
    if handle == INVALID_HANDLE_VALUE {
        Err(error)
    } else {
        Ok(Handle(handle))
    }
}

/// Opens a pipe path (local or remote) with identification-level SQOS.
fn open_path(path: &str, access: DWORD) -> Result<Handle, u32> {
    let path = wide(path);
    let handle = unsafe {
        CreateFileW(
            path.as_ptr(),
            access,
            0,
            null_mut(),
            OPEN_EXISTING,
            SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
            null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        Err(unsafe { GetLastError() })
    } else {
        Ok(Handle(handle))
    }
}

fn open_local(name: &str, access: DWORD) -> Result<Handle, u32> {
    open_path(&local_path(name), access)
}

/// Opens a local pipe, retrying while it does not exist yet or is busy.
fn open_local_retry(name: &str, access: DWORD) -> Handle {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match open_local(name, access) {
            Ok(handle) => return handle,
            Err(error) if Instant::now() < deadline => {
                let _ = error;
                thread::sleep(Duration::from_millis(10));
            }
            Err(error) => panic!("pipe did not become connectable: error {error}"),
        }
    }
}

/// Waits until the pipe exists and has an instance available, without connecting.
fn wait_pipe(name: &str) {
    let path = wide(&local_path(name));
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        if unsafe { WaitNamedPipeW(path.as_ptr(), 50) } != 0 {
            return;
        }
        thread::sleep(Duration::from_millis(20));
    }
    panic!("pipe did not appear");
}

/// A restricted token for the current user: the user SID and Administrators are
/// deny-only while every group SID stays enabled. It models a different local
/// principal that shares those groups but is not the pipe's authorized user.
fn restricted_token() -> Handle {
    let mut token = null_mut();
    assert_ne!(
        unsafe {
            OpenProcessToken(
                GetCurrentProcess(),
                TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY | TOKEN_IMPERSONATE,
                &mut token,
            )
        },
        0
    );
    let token = Handle(token);
    let user = token_user(token.0);
    let mut administrators = vec![0_u8; 68];
    let mut size = administrators.len() as DWORD;
    assert_ne!(
        unsafe {
            CreateWellKnownSid(
                WinBuiltinAdministratorsSid,
                null_mut(),
                administrators.as_mut_ptr() as PSID,
                &mut size,
            )
        },
        0
    );
    let mut disable = [
        SID_AND_ATTRIBUTES {
            Sid: user.sid(),
            Attributes: 0,
        },
        SID_AND_ATTRIBUTES {
            Sid: administrators.as_mut_ptr() as PSID,
            Attributes: 0,
        },
    ];
    let mut restricted = null_mut();
    assert_ne!(
        unsafe {
            CreateRestrictedToken(
                token.0,
                0,
                2,
                disable.as_mut_ptr(),
                0,
                null_mut(),
                0,
                null_mut(),
                &mut restricted,
            )
        },
        0,
        "CreateRestrictedToken failed: {}",
        unsafe { GetLastError() }
    );
    Handle(restricted)
}

/// Runs `work` on the current thread while impersonating the restricted token.
fn as_restricted<T>(work: impl FnOnce() -> T) -> T {
    struct Revert;
    impl Drop for Revert {
        fn drop(&mut self) {
            unsafe { RevertToSelf() };
        }
    }
    let token = restricted_token();
    assert_ne!(unsafe { ImpersonateLoggedOnUser(token.0) }, 0);
    let _revert = Revert;
    work()
}

#[derive(Debug)]
struct SecurityFacts {
    sddl: String,
    dacl_present: bool,
    dacl_protected: bool,
    ace_count: u16,
    ace_type: u8,
    ace_flags: u8,
    mask: u32,
    owner_is_user: bool,
    ace_sid_is_user: bool,
}

fn security_facts(handle: HANDLE, user: PSID) -> SecurityFacts {
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
        assert_eq!(status, 0, "GetSecurityInfo failed");
        let mut raw: *mut u16 = null_mut();
        assert_ne!(
            ConvertSecurityDescriptorToStringSecurityDescriptorW(
                descriptor,
                SDDL_REVISION_1 as DWORD,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                &mut raw,
                null_mut(),
            ),
            0
        );
        let sddl = wide_to_string(raw);
        LocalFree(raw as *mut c_void);
        let mut control = 0;
        let mut revision = 0;
        assert_ne!(
            GetSecurityDescriptorControl(descriptor, &mut control, &mut revision),
            0
        );
        let mut facts = SecurityFacts {
            sddl,
            dacl_present: control & SE_DACL_PRESENT != 0,
            dacl_protected: control & SE_DACL_PROTECTED != 0,
            ace_count: if dacl.is_null() { 0 } else { (*dacl).AceCount },
            ace_type: 0xff,
            ace_flags: 0xff,
            mask: 0,
            owner_is_user: !owner.is_null() && EqualSid(owner, user) != 0,
            ace_sid_is_user: false,
        };
        if !dacl.is_null() && facts.ace_count > 0 {
            let mut ace: *mut c_void = null_mut();
            assert_ne!(GetAce(dacl, 0, &mut ace), 0);
            let ace = &*(ace as *const ACCESS_ALLOWED_ACE);
            facts.ace_type = ace.Header.AceType;
            facts.ace_flags = ace.Header.AceFlags;
            facts.mask = ace.Mask;
            facts.ace_sid_is_user = EqualSid(&ace.SidStart as *const DWORD as PSID, user) != 0;
        }
        LocalFree(descriptor as *mut c_void);
        facts
    }
}

/// C4 structural contract, read back from `handle`.
fn assert_c4(handle: HANDLE) {
    let user = process_user();
    let facts = security_facts(handle, user.sid());
    let expected_sddl = {
        let sid = user_sid_string();
        format!("O:{sid}D:P(A;;FA;;;{sid})")
    };
    assert!(
        facts.dacl_present
            && facts.dacl_protected
            && facts.ace_count == 1
            && facts.ace_type == ACCESS_ALLOWED_ACE_TYPE
            && facts.ace_flags == 0
            && facts.mask == FILE_ALL_ACCESS
            && facts.owner_is_user
            && facts.ace_sid_is_user
            && facts.sddl == expected_sddl,
        "pipe security does not satisfy C4: {facts:?}"
    );
}

// ---------------------------------------------------------------------------
// Core helpers
// ---------------------------------------------------------------------------

fn test_server() -> CoreServer {
    let store = Store::open_in_memory().unwrap();
    store
        .insert_attempt(&Attempt::new("attempt", "task", "scenario", "cap-v1"))
        .unwrap();
    CoreServer::new(store)
}

/// Starts an in-process Core serving `name` and waits until it is connectable.
fn start_in_process_core(name: &str) -> thread::JoinHandle<Result<(), IpcError>> {
    let server = test_server();
    let serving = name.to_owned();
    let handle = thread::spawn(move || server.serve_named_pipe(&serving));
    wait_pipe(name);
    handle
}

fn transition_request(id: &str) -> IpcRequest {
    IpcRequest::new(
        id,
        CoreCommand::new(
            format!("command-{id}"),
            "attempt",
            CoreOperation::TransitionAttempt {
                attempt_id: "attempt".into(),
                state: AttemptState::Active,
                event_id: format!("event-{id}"),
            },
        )
        .unwrap(),
    )
}

fn connect_client(name: &str) -> NamedPipeClient {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match NamedPipeClient::connect(name) {
            Ok(client) => return client,
            Err(error) if Instant::now() < deadline => {
                let _ = error;
                thread::sleep(Duration::from_millis(10));
            }
            Err(error) => panic!("Core pipe did not accept a client: {error}"),
        }
    }
}

fn snapshot_v1(connection: &mut NamedPipeClient, request_id: &str) -> Value {
    write_frame(
        connection,
        &json!({
            "protocolVersion": "goalport.ipc.v1",
            "requestId": request_id,
            "entityVersion": 0,
            "messageType": "snapshot",
            "payload": {}
        }),
    )
    .unwrap();
    let frame = read_frame(connection).unwrap().expect("Core returned no response");
    decode_frame(&frame).unwrap()
}

/// Sends one authorized snapshot on a fresh connection and returns whether it
/// was answered within `limit`.
fn authorized_snapshot_within(name: &str, limit: Duration) -> bool {
    let (sender, receiver) = mpsc::channel();
    let target = name.to_owned();
    thread::spawn(move || {
        let mut connection = connect_client(&target);
        let response = snapshot_v1(&mut connection, "authorized-within");
        let _ = sender.send(response);
    });
    matches!(receiver.recv_timeout(limit), Ok(response) if response["ok"] == true)
}

fn ready_path(db: &Path) -> PathBuf {
    let mut value = db.as_os_str().to_os_string();
    value.push(".launch-ready");
    PathBuf::from(value)
}

fn core_command(db: &Path, pipe: &str, nonce: &str) -> Command {
    let mut command = Command::new(CORE);
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().to_ascii_uppercase().starts_with("GOALPORT_") {
            command.env_remove(key);
        }
    }
    command
        .args(["serve", "--pipe", pipe, "--db"])
        .arg(db)
        .env("GOALPORT_REQUIRE_ISOLATED", "1")
        .env("GOALPORT_LAUNCH_NONCE", nonce)
        .env("GOALPORT_RUN_SLUG", "goalport-pipe-security-test")
        .env("GOALPORT_ELECTRON_PID", std::process::id().to_string())
        .env("GOALPORT_ELECTRON_CREATED_MS", "1")
        .env("GOALPORT_ELECTRON_EXE", "pipe-security-test.exe")
        .env("GOALPORT_ELECTRON_SHA256", "test-only")
        .env("GOALPORT_LAUNCHER_PID", std::process::id().to_string())
        .env("GOALPORT_LAUNCHER_CREATED_MS", "1")
        .env("GOALPORT_LAUNCHER_EXE", "pipe-security-test.exe")
        .env("GOALPORT_LAUNCHER_SHA256", "test-only")
        .env("GOALPORT_LAUNCHER_PARENT_PID", std::process::id().to_string())
        .env("GOALPORT_LAUNCH_REQUESTED_AT", "2026-09-14T00:00:00.000Z")
        .env("GOALPORT_LAUNCHER_STARTED_AT", "2026-09-14T00:00:00.001Z")
        .env("GOALPORT_CORE_SPAWNED_AT", "2026-09-14T00:00:00.002Z");
    command
}

/// A spawned Core child that is killed (by its own handle) when dropped.
struct SpawnedCore(Child);
impl Drop for SpawnedCore {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}

fn spawn_ready_core(db: &Path, pipe: &str, nonce: &str) -> SpawnedCore {
    let child = core_command(db, pipe, nonce)
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let mut core = SpawnedCore(child);
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if let Ok(text) = std::fs::read_to_string(ready_path(db)) {
            if text.contains(nonce) && text.contains("READY_COMMITTED") {
                break;
            }
        }
        if let Some(status) = core.0.try_wait().unwrap() {
            panic!("spawned Core exited before ready: {status}");
        }
        assert!(Instant::now() < deadline, "Core did not write launch-ready");
        thread::sleep(Duration::from_millis(20));
    }
    wait_pipe(pipe);
    core
}

struct PeerRun {
    code: Option<i32>,
    stdout: String,
    json: Value,
}

fn run_pipe_peer(pipe: &str) -> PeerRun {
    let output = Command::new(CORE)
        .args(["pipe-peer", "--pipe", pipe])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    let stdout = String::from_utf8(output.stdout).unwrap();
    let lines = stdout.lines().collect::<Vec<_>>();
    assert_eq!(lines.len(), 1, "pipe-peer prints exactly one line: {stdout:?}");
    let json = serde_json::from_str(lines[0]).unwrap();
    PeerRun {
        code: output.status.code(),
        stdout,
        json,
    }
}

fn assert_peer_ok(pipe: &str, pid: u32) {
    let run = run_pipe_peer(pipe);
    assert_eq!(run.code, Some(0), "pipe-peer failed: {}", run.stdout);
    assert_eq!(run.json["schema"], PEER_SCHEMA);
    assert_eq!(run.json["ok"], true);
    assert_eq!(run.json["serverPid"], json!(pid), "{}", run.stdout);
}

fn wait_prior_ended(db: &Path) {
    let store = Store::open(db).unwrap();
    let prior = store.latest_core_launch_epoch().unwrap().unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if classify_recorded_process(
            u32::try_from(prior.core_pid).unwrap(),
            &prior.core_creation_date,
            &prior.core_executable_path,
        ) == PriorCoreStatus::Ended
        {
            return;
        }
        thread::sleep(Duration::from_millis(20));
    }
    panic!("prior Core identity did not become decisively ended");
}

// ---------------------------------------------------------------------------
// T1-T12
// ---------------------------------------------------------------------------

#[test]
fn t1_core_pipe_security_descriptor_read_back_from_a_client_handle_satisfies_c4() {
    let name = unique("t1");
    let _core = start_in_process_core(&name);
    let client = open_local_retry(&name, GENERIC_READ | GENERIC_WRITE);
    assert_c4(client.0);
}

#[test]
fn t2_authorized_client_round_trips_ipc_v1_request_and_snapshot_wire() {
    let name = unique("t2");
    let _core = start_in_process_core(&name);
    let mut client = IpcClient::new(connect_client(&name));
    let response = client.request(transition_request("t2-request")).unwrap();
    assert!(response.ok, "authorized v1 request refused: {response:?}");
    drop(client);
    let mut connection = connect_client(&name);
    let snapshot = snapshot_v1(&mut connection, "t2-snapshot");
    assert_eq!(snapshot["ok"], true);
    assert_eq!(snapshot["requestId"], "t2-snapshot");
    assert!(snapshot["payload"]["attempts"].is_number());
}

#[test]
fn t3_restricted_token_is_denied_read_write_and_instance_creation_with_positive_controls() {
    let user = user_sid_string();
    let name = unique("t3-core");
    let _core = start_in_process_core(&name);
    let (read, read_write, extra_instance) = as_restricted(|| {
        let read = open_local(&name, GENERIC_READ).map(|_| ());
        let read_write = open_local(&name, GENERIC_READ | GENERIC_WRITE).map(|_| ());
        let extra = create_raw_pipe(&name, "D:(A;;FA;;;WD)", 0, PIPE_REJECT_REMOTE_CLIENTS).map(|_| ());
        (read, read_write, extra)
    });
    assert_eq!(read, Err(ERROR_ACCESS_DENIED), "restricted GENERIC_READ");
    assert_eq!(read_write, Err(ERROR_ACCESS_DENIED), "restricted GENERIC_READ|WRITE");
    assert_eq!(extra_instance, Err(ERROR_ACCESS_DENIED), "restricted extra instance");

    // Controls differ from the Core descriptor only by one Everyone ACE.
    let read_control = unique("t3-control-wd-fr");
    let _read_pipe = create_raw_pipe(
        &read_control,
        &format!("{}(A;;FR;;;WD)", core_sddl(&user)),
        FILE_FLAG_FIRST_PIPE_INSTANCE,
        PIPE_REJECT_REMOTE_CLIENTS,
    )
    .unwrap();
    let full_control = unique("t3-control-wd-fa");
    let _full_pipe = create_raw_pipe(
        &full_control,
        &format!("{}(A;;FA;;;WD)", core_sddl(&user)),
        FILE_FLAG_FIRST_PIPE_INSTANCE,
        PIPE_REJECT_REMOTE_CLIENTS,
    )
    .unwrap();
    let (control_read, control_read_write) = as_restricted(|| {
        (
            open_local(&read_control, GENERIC_READ).map(|_| ()),
            open_local(&full_control, GENERIC_READ | GENERIC_WRITE).map(|_| ()),
        )
    });
    assert_eq!(control_read, Ok(()), "restricted token must read a WD-FR control pipe");
    assert_eq!(
        control_read_write,
        Ok(()),
        "restricted token must read/write a WD-FA control pipe"
    );
}

/// A minimal serial server with Core's accept shape: after each connect it
/// immediately creates the next instance, then blocks reading one frame on the
/// connected instance and echoes it.
fn start_serial_control_server(name: &str, sddl: String) {
    let name = name.to_owned();
    let first = create_raw_pipe(&name, &sddl, FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_REJECT_REMOTE_CLIENTS)
        .expect("control server first instance");
    thread::spawn(move || {
        let mut listening = first;
        loop {
            let connected = unsafe { ConnectNamedPipe(listening.0, null_mut()) };
            if connected == 0 && unsafe { GetLastError() } != 535 {
                // ERROR_NO_DATA and similar: replace the instance.
                let next = create_raw_pipe(&name, &sddl, 0, PIPE_REJECT_REMOTE_CLIENTS)
                    .expect("control server replacement instance");
                listening = next;
                continue;
            }
            let next = create_raw_pipe(&name, &sddl, 0, PIPE_REJECT_REMOTE_CLIENTS)
                .expect("control server next instance");
            let mut connection = std::mem::replace(&mut listening, next).into_file();
            let mut header = [0_u8; 4];
            if connection.read_exact(&mut header).is_err() {
                continue;
            }
            let mut payload = vec![0_u8; u32::from_le_bytes(header) as usize];
            if connection.read_exact(&mut payload).is_err() {
                continue;
            }
            let _ = connection.write_all(&header);
            let _ = connection.write_all(&payload);
            let _ = connection.flush();
        }
    });
}

#[test]
fn t4_non_authorized_reader_blocks_a_serial_control_server_but_cannot_open_the_core_pipe() {
    let user = user_sid_string();
    // Control: the B5 mechanism, reproduced against a WD-FR serial server.
    let control = unique("t4-control");
    start_serial_control_server(&control, format!("{}(A;;FR;;;WD)", core_sddl(&user)));
    wait_pipe(&control);
    let hold = as_restricted(|| open_local(&control, GENERIC_READ)).expect("restricted holder opens the control pipe");
    thread::sleep(Duration::from_millis(300));
    let authorized = open_local(&control, GENERIC_READ | GENERIC_WRITE)
        .expect("authorized client must open the control pipe while it is held");
    let mut writer = authorized.into_file();
    let mut reader = writer.try_clone().unwrap();
    writer.write_all(&[4, 0, 0, 0, b'p', b'i', b'n', b'g']).unwrap();
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let mut reply = [0_u8; 8];
        let _ = sender.send(reader.read_exact(&mut reply).map(|_| reply));
    });
    assert!(
        matches!(receiver.recv_timeout(Duration::from_secs(3)), Err(mpsc::RecvTimeoutError::Timeout)),
        "control serial server must be blocked by the non-authorized reader"
    );
    drop(hold);
    let reply = receiver
        .recv_timeout(Duration::from_secs(10))
        .expect("control server must answer after the holder releases")
        .expect("control reply");
    assert_eq!(&reply[4..], b"ping");
    drop(writer);

    // Core pipe: the same principal is denied and authorized work proceeds.
    let name = unique("t4-core");
    let _core = start_in_process_core(&name);
    let denied = as_restricted(|| open_local(&name, GENERIC_READ).map(|_| ()));
    assert_eq!(denied, Err(ERROR_ACCESS_DENIED));
    assert!(
        authorized_snapshot_within(&name, Duration::from_secs(3)),
        "authorized request must be answered within 3 s"
    );
}

#[test]
fn t5_remote_loopback_is_rejected_by_the_production_instance_and_observable_without_reject() {
    let user = user_sid_string();
    let control = unique("t5-no-reject-control");
    let _control_pipe = create_raw_pipe(&control, &core_sddl(&user), FILE_FLAG_FIRST_PIPE_INSTANCE, 0)
        .expect("owner-only control pipe without REJECT_REMOTE");
    if open_path(&format!(r"\\127.0.0.1\pipe\{control}"), GENERIC_READ | GENERIC_WRITE).is_err() {
        panic!("remote path unobservable");
    }

    let production = unique("t5-production-instance");
    let _instance = NamedPipeServer::bind(&production).expect("production create path");
    let remote_production = open_path(
        &format!(r"\\127.0.0.1\pipe\{production}"),
        GENERIC_READ | GENERIC_WRITE,
    );
    assert!(
        remote_production.is_err(),
        "production pipe instance must reject the SMB loopback client"
    );

    let name = unique("t5-core");
    let _core = start_in_process_core(&name);
    for access in [GENERIC_READ | GENERIC_WRITE, GENERIC_READ] {
        assert!(
            open_path(&format!(r"\\127.0.0.1\pipe\{name}"), access).is_err(),
            "Core pipe must reject remote access {access:#x}"
        );
    }
}

#[test]
fn t6_bind_refuses_a_pre_created_name_and_leaves_the_squatter_descriptor() {
    let user = user_sid_string();
    let name = unique("t6");
    let squatter_sddl = format!("{}(A;;FA;;;WD)", core_sddl(&user));
    let _squatter = create_raw_pipe(&name, &squatter_sddl, FILE_FLAG_FIRST_PIPE_INSTANCE, 0)
        .expect("squatter pipe");
    let bound = NamedPipeServer::bind(&name);
    assert!(
        matches!(bound, Err(IpcError::PipeNameOccupied)),
        "bind over an existing name must fail as occupied: {bound:?}"
    );
    let client = open_local(&name, GENERIC_READ).expect("squatter instance still reachable");
    let facts = security_facts(client.0, process_user().sid());
    assert_eq!(facts.ace_count, 2, "descriptor must still be the squatter's: {facts:?}");
    assert!(facts.sddl.contains("(A;;FA;;;WD)"), "{facts:?}");
}

#[test]
fn t7_clients_that_disconnect_before_accept_do_not_stop_the_server() {
    let name = unique("t7");
    let _core = start_in_process_core(&name);
    for _ in 0..5 {
        // Hold the serving connection so the next client connects to the
        // pending instance and closes before Core calls ConnectNamedPipe on it.
        let busy = connect_client(&name);
        thread::sleep(Duration::from_millis(50));
        let early = open_local_retry(&name, GENERIC_READ | GENERIC_WRITE);
        drop(early);
        drop(busy);
        thread::sleep(Duration::from_millis(50));
    }
    for _ in 0..20 {
        drop(open_local_retry(&name, GENERIC_READ | GENERIC_WRITE));
    }
    assert!(
        authorized_snapshot_within(&name, Duration::from_secs(5)),
        "server must keep serving after early disconnects"
    );
    let client = open_local_retry(&name, GENERIC_READ | GENERIC_WRITE);
    assert_c4(client.0);
}

#[test]
fn t8_pipe_peer_reports_the_spawned_core_and_refuses_a_foreign_dacl() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("t8.sqlite");
    let pipe = unique("t8-core");
    let core = spawn_ready_core(&db, &pipe, "88888888-0000-4000-8000-000000000008");
    assert_peer_ok(&pipe, core.0.id());

    let user = user_sid_string();
    let foreign = unique("t8-foreign");
    let _foreign_pipe = create_raw_pipe(
        &foreign,
        &format!("{}(A;;FA;;;WD)", core_sddl(&user)),
        FILE_FLAG_FIRST_PIPE_INSTANCE,
        PIPE_REJECT_REMOTE_CLIENTS,
    )
    .unwrap();
    let run = run_pipe_peer(&foreign);
    assert_eq!(run.code, Some(3), "{}", run.stdout);
    assert_eq!(run.json["schema"], PEER_SCHEMA);
    assert_eq!(run.json["ok"], false);
    assert_eq!(run.json["stage"], "dacl", "{}", run.stdout);
    assert!(run.stdout.contains(r#""stage":"dacl""#));
}

#[test]
fn t9_spawned_core_fails_closed_on_a_squatted_name_with_a_bounded_message() {
    let user = user_sid_string();
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("t9.sqlite");
    let pipe = unique("t9-squatted");
    let _squatter = create_raw_pipe(
        &pipe,
        &format!("{}(A;;FA;;;WD)", core_sddl(&user)),
        FILE_FLAG_FIRST_PIPE_INSTANCE,
        0,
    )
    .unwrap();
    let nonce = "99999999-0000-4000-8000-000000000009";
    let mut child = core_command(&db, &pipe, nonce)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if started.elapsed() > Duration::from_secs(20) {
            let _ = child.kill();
            let _ = child.wait();
            panic!("Core did not exit within 20 s on a squatted name");
        }
        thread::sleep(Duration::from_millis(20));
    };
    let mut stderr = String::new();
    child.stderr.take().unwrap().read_to_string(&mut stderr).unwrap();
    assert!(!status.success(), "Core must exit non-zero");
    assert!(
        stderr.contains("named pipe name is already in use"),
        "stderr: {stderr}"
    );
    assert!(!stderr.contains("S-1-5-"), "stderr leaks a SID: {stderr}");
    assert!(!stderr.contains("D:"), "stderr leaks a descriptor: {stderr}");
    let store = Store::open(&db).unwrap();
    let startup = store
        .get_product_receipt_by_nonce("startup", nonce)
        .unwrap()
        .expect("startup receipt");
    assert_eq!(startup["startupState"], "ABORTED");
}

#[test]
fn t10_restarted_core_rebinds_its_name_with_a_lingering_client_and_reports_the_new_pid() {
    // The database differs while the old client lingers: a killed pipe server's
    // process object stays referenced while a client handle to its pipe is
    // open, so restart-epoch classification would still see the prior Core as
    // live on the same database. The same-database restart follows once the
    // client is closed.
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("t10.sqlite");
    let pipe = unique("t10");
    let mut first = spawn_ready_core(&db, &pipe, "10101010-0000-4000-8000-00000000000a");
    let mut lingering = connect_client(&pipe);
    assert_eq!(snapshot_v1(&mut lingering, "t10-before")["ok"], true);
    let first_pid = first.0.id();
    first.0.kill().unwrap();
    first.0.wait().unwrap();
    drop(first);

    // Same name, lingering client still open: the first-instance bind succeeds.
    let other_db = dir.path().join("t10-lingering.sqlite");
    let mut second =
        spawn_ready_core(&other_db, &pipe, "10101010-0000-4000-8000-00000000000b");
    assert_ne!(second.0.id(), first_pid);
    let client = open_local_retry(&pipe, GENERIC_READ | GENERIC_WRITE);
    assert_c4(client.0);
    drop(client);
    assert_peer_ok(&pipe, second.0.id());

    // Same name and same database once the lingering client is closed.
    drop(lingering);
    wait_prior_ended(&db);
    second.0.kill().unwrap();
    second.0.wait().unwrap();
    drop(second);
    let third = spawn_ready_core(&db, &pipe, "10101010-0000-4000-8000-00000000000c");
    let client = open_local_retry(&pipe, GENERIC_READ | GENERIC_WRITE);
    assert_c4(client.0);
    drop(client);
    assert_peer_ok(&pipe, third.0.id());
}

#[test]
fn t11_concurrent_profiles_each_serve_their_own_verified_pipe() {
    let dir = tempfile::tempdir().unwrap();
    let pipe_a = unique("t11-a");
    let pipe_b = unique("t11-b");
    let core_a = spawn_ready_core(&dir.path().join("a.sqlite"), &pipe_a, "11111111-0000-4000-8000-00000000000a");
    let core_b = spawn_ready_core(&dir.path().join("b.sqlite"), &pipe_b, "11111111-0000-4000-8000-00000000000b");
    for (pipe, core) in [(&pipe_a, &core_a), (&pipe_b, &core_b)] {
        let client = open_local_retry(pipe, GENERIC_READ | GENERIC_WRITE);
        assert_c4(client.0);
        drop(client);
        assert_peer_ok(pipe, core.0.id());
    }
    assert_ne!(core_a.0.id(), core_b.0.id());
}

#[test]
fn t12_verify_pipe_peer_waits_for_a_busy_core_within_its_budget() {
    // Busy until the budget ends.
    let name = unique("t12-busy");
    let _core = start_in_process_core(&name);
    let serving = connect_client(&name);
    thread::sleep(Duration::from_millis(200));
    let pending = connect_client(&name);
    let started = Instant::now();
    let result = verify_pipe_peer(&name);
    let elapsed = started.elapsed();
    assert!(
        matches!(result, Err(IpcError::PipeSecurity { stage: "busy", code }) if code == ERROR_PIPE_BUSY as i32),
        "expected busy: {result:?}"
    );
    assert!(
        elapsed >= Duration::from_millis(2900) && elapsed <= Duration::from_millis(4500),
        "busy budget elapsed {elapsed:?}"
    );
    drop(pending);
    drop(serving);

    // Released within the budget.
    let name = unique("t12-released");
    let _core = start_in_process_core(&name);
    let serving = connect_client(&name);
    thread::sleep(Duration::from_millis(200));
    let pending = connect_client(&name);
    let release = thread::spawn(move || {
        thread::sleep(Duration::from_millis(1000));
        drop(serving);
        drop(pending);
    });
    let started = Instant::now();
    let peer = verify_pipe_peer(&name).expect("peer verification after release");
    let elapsed = started.elapsed();
    release.join().unwrap();
    assert!(elapsed < Duration::from_millis(3000), "elapsed {elapsed:?}");
    assert_eq!(peer.server_pid, std::process::id());
}
