//! Claude-only transient console broker.
//!
//! Windows delivers `CTRL_BREAK_EVENT` to a process group whose members share
//! the *caller's* console. A consoleless Core has no console, so it can never be
//! that caller: `GenerateConsoleCtrlEvent` fails with Win32 error 6 before any
//! target is reached. This module adds the only arrangement that removes that
//! obstacle without touching the shared spawn path used by the other providers:
//!
//! ```text
//! Core (unchanged, consoleless)
//!   `-- broker: CREATE_NEW_CONSOLE + STARTF_USESHOWWINDOW/SW_HIDE
//!         `-- Claude: CREATE_NEW_PROCESS_GROUP alone, inherits the broker console
//! ```
//!
//! The broker is a child process, not a service or daemon: it has no
//! registration, no listener and no persistent port, and it dies with the
//! runtime it was created for. It is the signal caller and the owner of the
//! Claude process handle and of one private job object. Core keeps the reader
//! side of everything: Claude's stdout pipe is handed straight through to Core,
//! and the broker's acknowledgement channel is a *separate* private pipe pair
//! that Claude never inherits, so provider output cannot forge an acknowledgement.
//!
//! Nothing in this module decides an AC6c disposition. It reports what the OS
//! returned; the caller stays responsible for treating an unobserved or
//! ambiguous answer as unknown.

#![allow(clippy::result_large_err)]

use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    sync::{Arc, Mutex},
};

/// Wire version of the Core <-> broker control protocol. A broker that does not
/// echo this exact string is not the broker Core launched.
pub const BROKER_PROTOCOL: &str = "goalport.claude.stop-broker.v1";

/// Environment switch that selects the brokered Claude launch. Absent or not
/// exactly `1`, the Claude path keeps its existing direct spawn byte-for-byte.
pub const BROKER_ENABLE_ENV: &str = "GOALPORT_CLAUDE_STOP_BROKER";

/// Explicit broker executable override used by the isolated tests. Production
/// resolution is "next to the running Core binary" and needs no environment.
pub const BROKER_PATH_ENV: &str = "GOALPORT_CLAUDE_STOP_BROKER_EXE";

pub const BROKER_EXE_NAME: &str = "goalport-claude-stop-broker.exe";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrokerError(pub String);

impl std::fmt::Display for BrokerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for BrokerError {}

fn err(message: impl Into<String>) -> BrokerError {
    BrokerError(message.into())
}

/// Everything Core needs to ask the broker to launch one Claude child.
#[derive(Debug, Clone)]
pub struct BrokerLaunch {
    pub broker_exe: PathBuf,
    pub claude_exe: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    /// Keys removed from the child environment, matching the direct path.
    pub env_remove: Vec<String>,
}

/// The exact tuple a stop request must match before the broker will signal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StopTarget {
    pub request_id: String,
    pub pid: u32,
    pub creation_date: String,
    pub executable_path: String,
    pub executable_sha256: String,
    pub process_epoch: String,
    pub attempt_id: String,
    pub session_hash: String,
    pub turn_epoch: u64,
}

/// Whether the broker accepted a stop request and what the OS returned. This is
/// delivery only: `signal_returned` true is an API result, never a stopped turn.
#[derive(Debug, Clone, PartialEq)]
pub struct StopDelivery {
    pub accepted: bool,
    pub identity_match: bool,
    pub signal_attempted: bool,
    pub signal_returned: bool,
    pub last_error: u32,
    pub group_id: u32,
    pub reason: Option<String>,
    pub raw: Value,
}

/// The separately observed effect of a delivered signal.
#[derive(Debug, Clone, PartialEq)]
pub struct StopEffect {
    pub exited: bool,
    pub exit_code: Option<u32>,
    pub elapsed_ms: u64,
    pub job_member_count: u32,
    pub job_members: Vec<u32>,
    pub raw: Value,
}

pub use platform::{BrokerSession, broker_main, resolve_broker_exe};

#[cfg(not(windows))]
mod platform {
    use super::*;

    /// The brokered arrangement is a Windows console-topology mechanism. The
    /// stub keeps the crate portable and refuses rather than pretending. Its
    /// surface matches the Windows one so the Claude path needs no `cfg`.
    #[derive(Debug)]
    pub struct BrokerSession {
        pub claude_pid: u32,
        pub claude_stdin: Option<std::fs::File>,
        pub claude_stdout: Option<std::fs::File>,
    }

    const UNSUPPORTED: &str = "the Claude stop broker is only implemented on Windows console topology";

    impl BrokerSession {
        pub fn launch(_launch: &BrokerLaunch) -> Result<Self, BrokerError> {
            Err(err(UNSUPPORTED))
        }

        pub fn broker_pid(&self) -> u32 {
            0
        }

        pub fn nonce(&self) -> &str {
            ""
        }

        pub fn launch_report(&self) -> Value {
            Value::Null
        }

        pub fn frames(&self) -> Vec<Value> {
            Vec::new()
        }

        pub fn request_stop(
            &mut self,
            _target: &StopTarget,
            _effect_bound_ms: u64,
        ) -> Result<StopDelivery, BrokerError> {
            Err(err(UNSUPPORTED))
        }

        pub fn await_effect(
            &self,
            _request_id: &str,
            _timeout_ms: u64,
        ) -> Result<StopEffect, BrokerError> {
            Err(err(UNSUPPORTED))
        }

        pub fn shutdown(&mut self) {}
    }

    pub fn resolve_broker_exe() -> Option<PathBuf> {
        None
    }

    pub fn broker_main() -> i32 {
        eprintln!("goalport-claude-stop-broker: Windows only");
        2
    }
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::{
        ffi::{OsStr, OsString, c_void},
        os::windows::{ffi::OsStrExt, io::FromRawHandle},
        time::{Duration, Instant},
    };

    type Handle = *mut c_void;

    const INVALID_HANDLE_VALUE: Handle = usize::MAX as Handle;
    const HANDLE_FLAG_INHERIT: u32 = 0x0000_0001;
    const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_SUSPENDED: u32 = 0x0000_0004;
    const CREATE_UNICODE_ENVIRONMENT: u32 = 0x0000_0400;
    const EXTENDED_STARTUPINFO_PRESENT: u32 = 0x0008_0000;
    const STARTF_USESTDHANDLES: u32 = 0x0000_0100;
    const STARTF_USESHOWWINDOW: u32 = 0x0000_0001;
    const SW_HIDE: u16 = 0;
    const PROC_THREAD_ATTRIBUTE_HANDLE_LIST: usize = 0x0002_0002;
    const CTRL_C_EVENT: u32 = 0;
    const CTRL_BREAK_EVENT: u32 = 1;
    const GENERIC_READ: u32 = 0x8000_0000;
    const GENERIC_WRITE: u32 = 0x4000_0000;
    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const FILE_SHARE_WRITE: u32 = 0x0000_0002;
    const OPEN_EXISTING: u32 = 3;
    const STD_INPUT_HANDLE: u32 = -10i32 as u32;
    const STD_OUTPUT_HANDLE: u32 = -11i32 as u32;
    const WAIT_OBJECT_0: u32 = 0;
    const WAIT_TIMEOUT: u32 = 258;
    const STILL_ACTIVE: u32 = 259;
    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;
    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: u32 = 9;
    const JOB_OBJECT_BASIC_PROCESS_ID_LIST: u32 = 3;
    /// Upper bound for one broker control frame, matched by both sides.
    const MAX_CONTROL_LINE_BYTES: usize = 256 * 1024;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct StartupInfoW {
        cb: u32,
        lp_reserved: *mut u16,
        lp_desktop: *mut u16,
        lp_title: *mut u16,
        dw_x: u32,
        dw_y: u32,
        dw_x_size: u32,
        dw_y_size: u32,
        dw_x_count_chars: u32,
        dw_y_count_chars: u32,
        dw_fill_attribute: u32,
        dw_flags: u32,
        w_show_window: u16,
        cb_reserved2: u16,
        lp_reserved2: *mut u8,
        h_std_input: Handle,
        h_std_output: Handle,
        h_std_error: Handle,
    }

    impl Default for StartupInfoW {
        fn default() -> Self {
            // SAFETY: STARTUPINFOW is a plain-old-data struct whose all-zero
            // value is the documented "nothing requested" state.
            unsafe { std::mem::zeroed() }
        }
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct StartupInfoExW {
        startup_info: StartupInfoW,
        attribute_list: *mut c_void,
    }

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct ProcessInformation {
        process: Handle,
        thread: Handle,
        process_id: u32,
        thread_id: u32,
    }

    // SAFETY of the Default impl above for raw pointers: zeroed is null.
    impl Default for StartupInfoExW {
        fn default() -> Self {
            Self {
                startup_info: StartupInfoW::default(),
                attribute_list: std::ptr::null_mut(),
            }
        }
    }

    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct IoCounters {
        read_operation_count: u64,
        write_operation_count: u64,
        other_operation_count: u64,
        read_transfer_count: u64,
        write_transfer_count: u64,
        other_transfer_count: u64,
    }

    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct JobObjectBasicLimitInformation {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: u32,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }

    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct JobObjectExtendedLimitInformation {
        basic_limit_information: JobObjectBasicLimitInformation,
        io_info: IoCounters,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }

    #[repr(C)]
    struct JobObjectBasicProcessIdList {
        number_of_assigned_processes: u32,
        number_of_process_ids_in_list: u32,
        process_id_list: [usize; 1],
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CloseHandle(handle: Handle) -> i32;
        fn GetLastError() -> u32;
        fn SetHandleInformation(handle: Handle, mask: u32, flags: u32) -> i32;
        fn CreatePipe(
            read: *mut Handle,
            write: *mut Handle,
            attributes: *mut c_void,
            size: u32,
        ) -> i32;
        fn CreateProcessW(
            application_name: *const u16,
            command_line: *mut u16,
            process_attributes: *mut c_void,
            thread_attributes: *mut c_void,
            inherit_handles: i32,
            creation_flags: u32,
            environment: *mut c_void,
            current_directory: *const u16,
            startup_info: *mut StartupInfoW,
            process_information: *mut ProcessInformation,
        ) -> i32;
        fn InitializeProcThreadAttributeList(
            list: *mut c_void,
            attribute_count: u32,
            flags: u32,
            size: *mut usize,
        ) -> i32;
        fn UpdateProcThreadAttribute(
            list: *mut c_void,
            flags: u32,
            attribute: usize,
            value: *mut c_void,
            size: usize,
            previous_value: *mut c_void,
            return_size: *mut usize,
        ) -> i32;
        fn DeleteProcThreadAttributeList(list: *mut c_void);
        fn ResumeThread(thread: Handle) -> u32;
        fn WaitForSingleObject(handle: Handle, milliseconds: u32) -> u32;
        fn GetExitCodeProcess(process: Handle, exit_code: *mut u32) -> i32;
        fn TerminateProcess(process: Handle, exit_code: u32) -> i32;
        fn GenerateConsoleCtrlEvent(ctrl_event: u32, process_group_id: u32) -> i32;
        fn GetConsoleProcessList(process_list: *mut u32, count: u32) -> u32;
        fn GetConsoleWindow() -> *mut c_void;
        fn SetConsoleCtrlHandler(handler: Option<unsafe extern "system" fn(u32) -> i32>, add: i32)
        -> i32;
        fn GetStdHandle(std_handle: u32) -> Handle;
        fn CreateFileW(
            file_name: *const u16,
            desired_access: u32,
            share_mode: u32,
            security_attributes: *mut c_void,
            creation_disposition: u32,
            flags_and_attributes: u32,
            template_file: Handle,
        ) -> Handle;
        fn CreateJobObjectW(attributes: *mut c_void, name: *const u16) -> Handle;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        fn SetInformationJobObject(
            job: Handle,
            info_class: u32,
            info: *mut c_void,
            length: u32,
        ) -> i32;
        fn QueryInformationJobObject(
            job: Handle,
            info_class: u32,
            info: *mut c_void,
            length: u32,
            return_length: *mut u32,
        ) -> i32;
        fn TerminateJobObject(job: Handle, exit_code: u32) -> i32;
        fn IsProcessInJob(process: Handle, job: Handle, result: *mut i32) -> i32;
        fn SetEnvironmentVariableW(name: *const u16, value: *const u16) -> i32;
    }

    fn wide(value: impl AsRef<OsStr>) -> Vec<u16> {
        value.as_ref().encode_wide().chain(Some(0)).collect()
    }

    /// MSVCRT argv quoting. Keeps the native CLI argv byte-identical to the
    /// direct path, which `std::process::Command` produces the same way.
    fn quote_argument(argument: &str) -> String {
        if !argument.is_empty() && !argument.contains([' ', '\t', '"']) {
            return argument.to_owned();
        }
        let mut quoted = String::from("\"");
        let mut backslashes = 0usize;
        for character in argument.chars() {
            match character {
                '\\' => {
                    backslashes += 1;
                    quoted.push('\\');
                }
                '"' => {
                    for _ in 0..=backslashes {
                        quoted.push('\\');
                    }
                    backslashes = 0;
                    quoted.push('"');
                }
                other => {
                    backslashes = 0;
                    quoted.push(other);
                }
            }
        }
        for _ in 0..backslashes {
            quoted.push('\\');
        }
        quoted.push('"');
        quoted
    }

    fn command_line(program: &OsStr, args: &[String]) -> Vec<u16> {
        let mut line = quote_argument(&program.to_string_lossy());
        for argument in args {
            line.push(' ');
            line.push_str(&quote_argument(argument));
        }
        wide(OsString::from(line))
    }

    /// An owned Win32 handle. Every handle this module opens is closed exactly
    /// once, including on the error paths.
    struct RawHandle(Handle);

    // SAFETY: a Win32 HANDLE is a process-wide value, not a thread-affine
    // pointer to thread state. Moving ownership between threads is exactly what
    // the OS supports, and this type still closes it exactly once.
    unsafe impl Send for RawHandle {}
    unsafe impl Sync for RawHandle {}

    impl RawHandle {
        fn get(&self) -> Handle {
            self.0
        }

        fn value(&self) -> usize {
            self.0 as usize
        }

        fn set_inheritable(&self, inheritable: bool) -> Result<(), BrokerError> {
            let flags = if inheritable { HANDLE_FLAG_INHERIT } else { 0 };
            // SAFETY: `self.0` is a live handle owned by this process.
            let ok = unsafe { SetHandleInformation(self.0, HANDLE_FLAG_INHERIT, flags) };
            if ok == 0 {
                // SAFETY: reading the thread's last error code.
                return Err(err(format!(
                    "SetHandleInformation failed with win32 error {}",
                    unsafe { GetLastError() }
                )));
            }
            Ok(())
        }

        /// Give the handle up to a `std::fs::File` so Core can read/write it
        /// with ordinary blocking IO.
        fn into_file(self) -> std::fs::File {
            let raw = self.0;
            std::mem::forget(self);
            // SAFETY: ownership of a valid file-like handle transfers to File,
            // which closes it exactly once on drop.
            unsafe { std::fs::File::from_raw_handle(raw as _) }
        }
    }

    impl Drop for RawHandle {
        fn drop(&mut self) {
            if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
                // SAFETY: closing a handle this type exclusively owns.
                unsafe { CloseHandle(self.0) };
            }
        }
    }

    fn create_pipe() -> Result<(RawHandle, RawHandle), BrokerError> {
        let mut read: Handle = std::ptr::null_mut();
        let mut write: Handle = std::ptr::null_mut();
        // SAFETY: both out-params are valid locals; a null security descriptor
        // means "non-inheritable by default", which each end then opts into.
        let ok = unsafe { CreatePipe(&mut read, &mut write, std::ptr::null_mut(), 0) };
        if ok == 0 {
            // SAFETY: reading the thread's last error code.
            return Err(err(format!("CreatePipe failed with win32 error {}", unsafe {
                GetLastError()
            })));
        }
        Ok((RawHandle(read), RawHandle(write)))
    }

    fn open_nul() -> Result<RawHandle, BrokerError> {
        let name = wide("NUL");
        // SAFETY: `name` is a NUL-terminated wide string that outlives the call.
        let handle = unsafe {
            CreateFileW(
                name.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                std::ptr::null_mut(),
                OPEN_EXISTING,
                0,
                std::ptr::null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            // SAFETY: reading the thread's last error code.
            return Err(err(format!("opening NUL failed with win32 error {}", unsafe {
                GetLastError()
            })));
        }
        Ok(RawHandle(handle))
    }

    struct SpawnRequest<'a> {
        program: &'a OsStr,
        args: &'a [String],
        cwd: Option<&'a OsStr>,
        creation_flags: u32,
        hide_window: bool,
        stdio: [Handle; 3],
        /// Exactly the handles the child may inherit. Anything absent here is
        /// unreachable from the child even though `bInheritHandles` is TRUE.
        inherit: &'a [Handle],
    }

    struct SpawnedProcess {
        process: RawHandle,
        thread: RawHandle,
        pid: u32,
    }

    fn spawn_process(request: &SpawnRequest<'_>) -> Result<SpawnedProcess, BrokerError> {
        let mut command = command_line(request.program, request.args);
        let cwd = request.cwd.map(wide);
        let mut attribute_size: usize = 0;
        // SAFETY: documented two-call pattern; the first call is expected to
        // fail and only reports the required buffer size.
        unsafe {
            InitializeProcThreadAttributeList(
                std::ptr::null_mut(),
                1,
                0,
                &mut attribute_size,
            )
        };
        if attribute_size == 0 {
            return Err(err("InitializeProcThreadAttributeList reported no size"));
        }
        let mut attribute_buffer = vec![0u8; attribute_size];
        let attribute_list = attribute_buffer.as_mut_ptr().cast::<c_void>();
        // SAFETY: buffer is exactly the size the OS just asked for.
        if unsafe { InitializeProcThreadAttributeList(attribute_list, 1, 0, &mut attribute_size) }
            == 0
        {
            // SAFETY: reading the thread's last error code.
            return Err(err(format!(
                "InitializeProcThreadAttributeList failed with win32 error {}",
                unsafe { GetLastError() }
            )));
        }
        let mut handles = request.inherit.to_vec();
        let update = if handles.is_empty() {
            1
        } else {
            // SAFETY: `handles` outlives the CreateProcessW call below, which is
            // the documented lifetime requirement for the handle list.
            unsafe {
                UpdateProcThreadAttribute(
                    attribute_list,
                    0,
                    PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                    handles.as_mut_ptr().cast::<c_void>(),
                    std::mem::size_of_val(&handles[0]) * handles.len(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                )
            }
        };
        if update == 0 {
            // SAFETY: reading last error, then releasing the attribute list.
            let code = unsafe { GetLastError() };
            unsafe { DeleteProcThreadAttributeList(attribute_list) };
            return Err(err(format!(
                "UpdateProcThreadAttribute(HANDLE_LIST) failed with win32 error {code}"
            )));
        }

        let mut startup = StartupInfoExW {
            startup_info: StartupInfoW {
                cb: std::mem::size_of::<StartupInfoExW>() as u32,
                dw_flags: STARTF_USESTDHANDLES
                    | if request.hide_window {
                        STARTF_USESHOWWINDOW
                    } else {
                        0
                    },
                w_show_window: if request.hide_window { SW_HIDE } else { 0 },
                h_std_input: request.stdio[0],
                h_std_output: request.stdio[1],
                h_std_error: request.stdio[2],
                ..StartupInfoW::default()
            },
            attribute_list,
        };
        let mut information = ProcessInformation::default();
        // SAFETY: every pointer is a live local; the command line buffer is
        // mutable as CreateProcessW requires.
        let ok = unsafe {
            CreateProcessW(
                std::ptr::null(),
                command.as_mut_ptr(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                1,
                request.creation_flags | EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
                std::ptr::null_mut(),
                cwd.as_ref().map_or(std::ptr::null(), |value| value.as_ptr()),
                std::ptr::addr_of_mut!(startup).cast::<StartupInfoW>(),
                &mut information,
            )
        };
        // SAFETY: the attribute list is no longer referenced by the OS.
        let last_error = unsafe { GetLastError() };
        unsafe { DeleteProcThreadAttributeList(attribute_list) };
        if ok == 0 {
            return Err(err(format!(
                "CreateProcessW({}) failed with win32 error {last_error}",
                request.program.to_string_lossy()
            )));
        }
        Ok(SpawnedProcess {
            process: RawHandle(information.process),
            thread: RawHandle(information.thread),
            pid: information.process_id,
        })
    }

    fn console_process_ids() -> (Vec<u32>, u32) {
        let mut buffer = vec![0u32; 64];
        // SAFETY: buffer is sized by `len`, which the API respects.
        let count = unsafe { GetConsoleProcessList(buffer.as_mut_ptr(), buffer.len() as u32) };
        if count == 0 {
            // SAFETY: reading the thread's last error code.
            return (Vec::new(), unsafe { GetLastError() });
        }
        let count = count.min(buffer.len() as u32) as usize;
        buffer.truncate(count);
        (buffer, 0)
    }

    fn console_window_hex() -> Option<String> {
        // SAFETY: no arguments; returns null when there is no console window.
        let window = unsafe { GetConsoleWindow() };
        (!window.is_null()).then(|| format!("0x{:X}", window as usize))
    }

    fn console_snapshot() -> Value {
        let (ids, error) = console_process_ids();
        json!({
            "attached": !ids.is_empty(),
            "consoleProcessIds": ids,
            "consoleProcessListError": error,
            "consoleWindow": console_window_hex(),
        })
    }

    fn wait_process(handle: Handle, timeout_ms: u32) -> u32 {
        // SAFETY: `handle` is a live process handle owned by the caller.
        unsafe { WaitForSingleObject(handle, timeout_ms) }
    }

    fn exit_code(handle: Handle) -> Option<u32> {
        let mut code = 0u32;
        // SAFETY: `handle` is live; `code` is a valid out-param.
        if unsafe { GetExitCodeProcess(handle, &mut code) } == 0 {
            return None;
        }
        (code != STILL_ACTIVE).then_some(code)
    }

    // ---------------------------------------------------------------- Core side

    /// Core's half of one brokered Claude launch. Owns the broker process, the
    /// private control pipes and Claude's stdio pipes; the Claude process handle
    /// itself deliberately stays with the broker.
    pub struct BrokerSession {
        nonce: String,
        broker: RawHandle,
        broker_pid: u32,
        control_out: std::fs::File,
        frames: Arc<Mutex<Vec<Value>>>,
        /// Frames are answers to requests, in order. The cursor is what makes a
        /// refusal of a repeated request id readable instead of shadowed by the
        /// earlier acknowledgement that carried the same id.
        cursor: Mutex<usize>,
        control_closed: Arc<Mutex<bool>>,
        child_started: Value,
        broker_ready: Value,
        pub claude_pid: u32,
        pub claude_stdin: Option<std::fs::File>,
        pub claude_stdout: Option<std::fs::File>,
    }

    impl std::fmt::Debug for BrokerSession {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.debug_struct("BrokerSession")
                .field("broker_pid", &self.broker_pid)
                .field("claude_pid", &self.claude_pid)
                .finish()
        }
    }

    pub fn resolve_broker_exe() -> Option<PathBuf> {
        if let Some(explicit) = std::env::var_os(BROKER_PATH_ENV) {
            let path = PathBuf::from(explicit);
            return path.is_file().then_some(path);
        }
        let base = std::env::current_exe().ok()?;
        let candidate = base.with_file_name(BROKER_EXE_NAME);
        candidate.is_file().then_some(candidate)
    }

    fn random_nonce() -> String {
        use std::time::{SystemTime, UNIX_EPOCH};
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or_default();
        let mixed = nanos ^ (u128::from(std::process::id()) << 64) ^ (&nanos as *const _ as u128);
        crate::commands::sha256_hex(format!("claude-stop-broker:{mixed}:{nanos}").as_bytes())
    }

    impl BrokerSession {
        /// Launch the broker, then have it launch Claude, and return only after
        /// the broker has reported a concrete child identity.
        pub fn launch(launch: &BrokerLaunch) -> Result<Self, BrokerError> {
            if !launch.broker_exe.is_file() {
                return Err(err(format!(
                    "the Claude stop broker executable is missing: {}",
                    launch.broker_exe.display()
                )));
            }
            let nonce = random_nonce();

            // Control channel: Core writes requests, the broker writes
            // acknowledgements. Claude never sees either end.
            let (control_request_read, control_request_write) = create_pipe()?;
            let (control_ack_read, control_ack_write) = create_pipe()?;
            // Claude's own stdio, created by Core so Core keeps the reader.
            let (claude_stdin_read, claude_stdin_write) = create_pipe()?;
            let (claude_stdout_read, claude_stdout_write) = create_pipe()?;
            let claude_stderr = open_nul()?;

            for handle in [
                &control_request_read,
                &control_ack_write,
                &claude_stdin_read,
                &claude_stdout_write,
                &claude_stderr,
            ] {
                handle.set_inheritable(true)?;
            }
            for handle in [
                &control_request_write,
                &control_ack_read,
                &claude_stdin_write,
                &claude_stdout_read,
            ] {
                handle.set_inheritable(false)?;
            }

            let broker_stderr = open_nul()?;
            broker_stderr.set_inheritable(true)?;

            let args = vec![
                "--protocol".to_owned(),
                BROKER_PROTOCOL.to_owned(),
                "--nonce".to_owned(),
                nonce.clone(),
                "--child-stdin".to_owned(),
                claude_stdin_read.value().to_string(),
                "--child-stdout".to_owned(),
                claude_stdout_write.value().to_string(),
                "--child-stderr".to_owned(),
                claude_stderr.value().to_string(),
                "--child-exe".to_owned(),
                launch.claude_exe.to_string_lossy().into_owned(),
                "--child-cwd".to_owned(),
                launch.cwd.to_string_lossy().into_owned(),
            ]
            .into_iter()
            .chain(
                launch
                    .env_remove
                    .iter()
                    .flat_map(|key| ["--env-remove".to_owned(), key.clone()]),
            )
            .chain(
                launch
                    .args
                    .iter()
                    .flat_map(|value| ["--child-arg".to_owned(), value.clone()]),
            )
            .collect::<Vec<_>>();

            let inherit = [
                control_request_read.get(),
                control_ack_write.get(),
                broker_stderr.get(),
                claude_stdin_read.get(),
                claude_stdout_write.get(),
                claude_stderr.get(),
            ];
            let spawned = spawn_process(&SpawnRequest {
                program: launch.broker_exe.as_os_str(),
                args: &args,
                cwd: Some(launch.cwd.as_os_str()),
                // The whole point: a real console the broker owns, never shown.
                creation_flags: CREATE_NEW_CONSOLE,
                hide_window: true,
                stdio: [
                    control_request_read.get(),
                    control_ack_write.get(),
                    broker_stderr.get(),
                ],
                inherit: &inherit,
            })?;

            // Core keeps only its own ends alive.
            drop(control_request_read);
            drop(control_ack_write);
            drop(broker_stderr);
            drop(claude_stdin_read);
            drop(claude_stdout_write);
            drop(claude_stderr);

            let frames: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
            let control_closed = Arc::new(Mutex::new(false));
            let reader_frames = Arc::clone(&frames);
            let reader_closed = Arc::clone(&control_closed);
            let ack_file = control_ack_read.into_file();
            std::thread::Builder::new()
                .name("claude-stop-broker-ack".into())
                .spawn(move || {
                    let mut reader = BufReader::new(ack_file);
                    loop {
                        let mut line = String::new();
                        match read_line_bounded(&mut reader, &mut line) {
                            Ok(0) | Err(_) => break,
                            Ok(_) => {}
                        }
                        let trimmed = line.trim();
                        if trimmed.is_empty() {
                            continue;
                        }
                        if let Ok(value) = serde_json::from_str::<Value>(trimmed)
                            && let Ok(mut guard) = reader_frames.lock()
                        {
                            guard.push(value);
                        }
                    }
                    if let Ok(mut closed) = reader_closed.lock() {
                        *closed = true;
                    }
                })
                .map_err(|error| err(format!("broker acknowledgement reader: {error}")))?;

            let mut session = Self {
                nonce,
                broker: spawned.process,
                broker_pid: spawned.pid,
                control_out: control_request_write.into_file(),
                frames,
                cursor: Mutex::new(0),
                control_closed,
                child_started: Value::Null,
                broker_ready: Value::Null,
                claude_pid: 0,
                claude_stdin: Some(claude_stdin_write.into_file()),
                claude_stdout: Some(claude_stdout_read.into_file()),
            };
            // The broker starts suspended-then-resumed, so a ready frame means
            // the console exists and a started frame means the job holds Claude.
            drop(spawned.thread);
            session.broker_ready = session.await_frame("broker_ready", None, 20_000)?;
            let started = session.await_frame("child_started", None, 30_000)?;
            if let Some(reason) = started.get("error").and_then(Value::as_str) {
                return Err(err(format!("the broker could not start Claude: {reason}")));
            }
            session.claude_pid = started
                .pointer("/child/pid")
                .and_then(Value::as_u64)
                .unwrap_or_default() as u32;
            if session.claude_pid == 0 {
                return Err(err("the broker reported no Claude process id"));
            }
            session.child_started = started;
            Ok(session)
        }

        pub fn broker_pid(&self) -> u32 {
            self.broker_pid
        }

        pub fn nonce(&self) -> &str {
            &self.nonce
        }

        /// The broker's own report of the launch: flags, console membership,
        /// group id, job configuration and the child's identity.
        pub fn launch_report(&self) -> Value {
            json!({
                "protocol": BROKER_PROTOCOL,
                "nonce": self.nonce,
                "brokerPid": self.broker_pid,
                "brokerReady": self.broker_ready,
                "childStarted": self.child_started,
            })
        }

        pub fn frames(&self) -> Vec<Value> {
            self.frames.lock().map(|guard| guard.clone()).unwrap_or_default()
        }

        fn control_is_closed(&self) -> bool {
            self.control_closed.lock().map(|guard| *guard).unwrap_or(true)
        }

        fn take_frame(&self, kind: &str, request_id: Option<&str>) -> Option<Value> {
            let guard = self.frames.lock().ok()?;
            let mut cursor = self.cursor.lock().ok()?;
            let start = *cursor;
            let (offset, frame) = guard.iter().skip(start).enumerate().find(|(_, frame)| {
                frame.get("type").and_then(Value::as_str) == Some(kind)
                    && frame.get("nonce").and_then(Value::as_str) == Some(self.nonce.as_str())
                    && request_id
                        .is_none_or(|id| frame.get("requestId").and_then(Value::as_str) == Some(id))
            })?;
            *cursor = start + offset + 1;
            Some(frame.clone())
        }

        fn await_frame(
            &self,
            kind: &str,
            request_id: Option<&str>,
            timeout_ms: u64,
        ) -> Result<Value, BrokerError> {
            let deadline = Instant::now() + Duration::from_millis(timeout_ms);
            loop {
                if let Some(frame) = self.take_frame(kind, request_id) {
                    return Ok(frame);
                }
                if self.control_is_closed() {
                    return Err(err(format!(
                        "the broker control channel closed before its {kind} frame"
                    )));
                }
                if Instant::now() >= deadline {
                    return Err(err(format!(
                        "the broker did not send its {kind} frame within {timeout_ms} ms"
                    )));
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        }

        fn send(&mut self, value: &Value) -> Result<(), BrokerError> {
            let mut line = serde_json::to_string(value)
                .map_err(|error| err(format!("broker control frame: {error}")))?;
            if line.len() > MAX_CONTROL_LINE_BYTES {
                return Err(err("broker control frame exceeds the protocol bound"));
            }
            line.push('\n');
            self.control_out
                .write_all(line.as_bytes())
                .and_then(|()| self.control_out.flush())
                .map_err(|error| err(format!("writing to the broker control channel: {error}")))
        }

        /// Ask the broker to signal the exact bound child. Returns delivery
        /// only; the effect is a separate observation.
        pub fn request_stop(
            &mut self,
            target: &StopTarget,
            effect_bound_ms: u64,
        ) -> Result<StopDelivery, BrokerError> {
            self.send(&json!({
                "v": 1,
                "protocol": BROKER_PROTOCOL,
                "nonce": self.nonce,
                "type": "stop",
                "requestId": target.request_id,
                "pid": target.pid,
                "creationDate": target.creation_date,
                "executablePath": target.executable_path,
                "executableSha256": target.executable_sha256,
                "processEpoch": target.process_epoch,
                "attemptId": target.attempt_id,
                "sessionHash": target.session_hash,
                "turnEpoch": target.turn_epoch,
                "effectBoundMs": effect_bound_ms,
            }))?;
            let frame = self.await_frame("stop_ack", Some(&target.request_id), 10_000)?;
            let signal = frame.get("signal").cloned().unwrap_or(Value::Null);
            Ok(StopDelivery {
                accepted: frame.get("accepted").and_then(Value::as_bool).unwrap_or(false),
                identity_match: frame
                    .get("identityMatch")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                signal_attempted: signal
                    .get("attempted")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                signal_returned: signal
                    .get("returned")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                last_error: signal
                    .get("lastError")
                    .and_then(Value::as_u64)
                    .unwrap_or_default() as u32,
                group_id: signal
                    .get("groupId")
                    .and_then(Value::as_u64)
                    .unwrap_or_default() as u32,
                reason: frame
                    .get("reason")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                raw: frame,
            })
        }

        /// The broker's separate effect observation: exact-child exit inside the
        /// bound plus the private job's membership afterwards.
        pub fn await_effect(
            &self,
            request_id: &str,
            timeout_ms: u64,
        ) -> Result<StopEffect, BrokerError> {
            let frame = self.await_frame("effect", Some(request_id), timeout_ms)?;
            let job = frame.get("job").cloned().unwrap_or(Value::Null);
            Ok(StopEffect {
                exited: frame.get("exited").and_then(Value::as_bool).unwrap_or(false),
                exit_code: frame.get("exitCode").and_then(Value::as_u64).map(|v| v as u32),
                elapsed_ms: frame
                    .get("elapsedMs")
                    .and_then(Value::as_u64)
                    .unwrap_or_default(),
                job_member_count: job
                    .get("memberCount")
                    .and_then(Value::as_u64)
                    .unwrap_or_default() as u32,
                job_members: job
                    .get("members")
                    .and_then(Value::as_array)
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(|item| item.as_u64().map(|value| value as u32))
                            .collect()
                    })
                    .unwrap_or_default(),
                raw: frame,
            })
        }

        /// Explicit, recorded cleanup of the task-owned tree. This is forced
        /// termination, never an interrupt result.
        pub fn shutdown(&mut self) {
            let _ = self.send(&json!({
                "v": 1,
                "protocol": BROKER_PROTOCOL,
                "nonce": self.nonce,
                "type": "shutdown",
            }));
            if wait_process(self.broker.get(), 3_000) != WAIT_OBJECT_0 {
                // SAFETY: terminating a process this session exclusively owns.
                unsafe { TerminateProcess(self.broker.get(), 1) };
            }
        }
    }

    impl Drop for BrokerSession {
        fn drop(&mut self) {
            self.shutdown();
        }
    }

    fn read_line_bounded(
        reader: &mut BufReader<std::fs::File>,
        line: &mut String,
    ) -> std::io::Result<usize> {
        let mut total = 0usize;
        loop {
            let mut byte = [0u8; 1];
            let read = std::io::Read::read(reader, &mut byte)?;
            if read == 0 {
                return Ok(total);
            }
            total += read;
            if total > MAX_CONTROL_LINE_BYTES {
                return Err(std::io::Error::other("broker control line exceeded bound"));
            }
            line.push(byte[0] as char);
            if byte[0] == b'\n' {
                return Ok(total);
            }
        }
    }

    // -------------------------------------------------------------- Broker side

    /// The broker ignores console control events itself. It is the caller, not a
    /// target: `CTRL_BREAK` is addressed to the child's group id, so this only
    /// guards against a stray event taking the signal caller down with it.
    unsafe extern "system" fn ignore_console_ctrl(event: u32) -> i32 {
        i32::from(event == CTRL_C_EVENT || event == CTRL_BREAK_EVENT)
    }

    struct BrokerArgs {
        nonce: String,
        child_stdin: Handle,
        child_stdout: Handle,
        child_stderr: Handle,
        child_exe: PathBuf,
        child_cwd: PathBuf,
        child_args: Vec<String>,
        env_remove: Vec<String>,
    }

    fn parse_broker_args() -> Result<BrokerArgs, String> {
        let argv = std::env::args().skip(1).collect::<Vec<_>>();
        let mut nonce = String::new();
        let mut protocol = String::new();
        let mut child_stdin = 0usize;
        let mut child_stdout = 0usize;
        let mut child_stderr = 0usize;
        let mut child_exe = PathBuf::new();
        let mut child_cwd = PathBuf::new();
        let mut child_args = Vec::new();
        let mut env_remove = Vec::new();
        let mut index = 0usize;
        while index < argv.len() {
            let key = argv[index].as_str();
            let value = argv.get(index + 1).cloned().unwrap_or_default();
            match key {
                "--protocol" => protocol = value,
                "--nonce" => nonce = value,
                "--child-stdin" => child_stdin = value.parse().map_err(|_| "bad --child-stdin")?,
                "--child-stdout" => child_stdout = value.parse().map_err(|_| "bad --child-stdout")?,
                "--child-stderr" => child_stderr = value.parse().map_err(|_| "bad --child-stderr")?,
                "--child-exe" => child_exe = PathBuf::from(value),
                "--child-cwd" => child_cwd = PathBuf::from(value),
                "--child-arg" => child_args.push(value),
                "--env-remove" => env_remove.push(value),
                other => return Err(format!("unknown broker argument {other}")),
            }
            index += 2;
        }
        if protocol != BROKER_PROTOCOL {
            return Err(format!("broker protocol mismatch: {protocol}"));
        }
        if nonce.is_empty() {
            return Err("broker requires --nonce".into());
        }
        if child_stdin == 0 || child_stdout == 0 || child_stderr == 0 {
            return Err("broker requires the three child stdio handles".into());
        }
        if !child_exe.is_file() {
            return Err(format!("child executable missing: {}", child_exe.display()));
        }
        Ok(BrokerArgs {
            nonce,
            child_stdin: child_stdin as Handle,
            child_stdout: child_stdout as Handle,
            child_stderr: child_stderr as Handle,
            child_exe,
            child_cwd,
            child_args,
            env_remove,
        })
    }

    struct AckWriter {
        out: Mutex<std::fs::File>,
        nonce: String,
    }

    impl AckWriter {
        fn emit(&self, mut value: Value) {
            if let Some(object) = value.as_object_mut() {
                object.insert("v".into(), json!(1));
                object.insert("protocol".into(), json!(BROKER_PROTOCOL));
                object.insert("nonce".into(), json!(self.nonce));
            }
            let Ok(mut line) = serde_json::to_string(&value) else {
                return;
            };
            line.push('\n');
            if let Ok(mut out) = self.out.lock() {
                let _ = out.write_all(line.as_bytes());
                let _ = out.flush();
            }
        }
    }

    /// Broker entry point. Returns the process exit code.
    pub fn broker_main() -> i32 {
        // SAFETY: registering a console control handler for this process.
        unsafe { SetConsoleCtrlHandler(Some(ignore_console_ctrl), 1) };
        // SAFETY: the two std handles are owned by this process for its lifetime.
        let ack_handle = unsafe { GetStdHandle(STD_OUTPUT_HANDLE) };
        let request_handle = unsafe { GetStdHandle(STD_INPUT_HANDLE) };
        if ack_handle == INVALID_HANDLE_VALUE || request_handle == INVALID_HANDLE_VALUE {
            return 2;
        }
        // SAFETY: taking ownership of this process's own std handles for the
        // remainder of its lifetime; nothing else closes them.
        let ack_file = unsafe { std::fs::File::from_raw_handle(ack_handle as _) };
        let request_file = unsafe { std::fs::File::from_raw_handle(request_handle as _) };

        let args = match parse_broker_args() {
            Ok(args) => args,
            Err(reason) => {
                let mut out = ack_file;
                let _ = writeln!(
                    out,
                    "{}",
                    json!({ "v": 1, "type": "fatal", "error": reason })
                );
                return 2;
            }
        };
        let ack = Arc::new(AckWriter {
            out: Mutex::new(ack_file),
            nonce: args.nonce.clone(),
        });

        ack.emit(json!({
            "type": "broker_ready",
            "brokerPid": std::process::id(),
            "console": console_snapshot(),
            "consoleFlags": "CREATE_NEW_CONSOLE|SW_HIDE",
            "inJob": crate::process_identity::in_any_job(),
        }));

        match run_broker(&args, &ack, request_file) {
            Ok(code) => code,
            Err(reason) => {
                ack.emit(json!({ "type": "fatal", "error": reason.0 }));
                2
            }
        }
    }

    fn run_broker(
        args: &BrokerArgs,
        ack: &Arc<AckWriter>,
        request_file: std::fs::File,
    ) -> Result<i32, BrokerError> {
        // The child inherits this process's environment, so the same keys the
        // direct path removes are removed here before it is created.
        for key in &args.env_remove {
            let name = wide(key);
            // SAFETY: `name` is a NUL-terminated wide string; a null value
            // deletes the variable from this process's environment.
            unsafe { SetEnvironmentVariableW(name.as_ptr(), std::ptr::null()) };
        }

        // One private job, created before the child can run.
        // SAFETY: an unnamed job object with default security.
        let job = RawHandle(unsafe {
            CreateJobObjectW(std::ptr::null_mut(), std::ptr::null())
        });
        if job.get().is_null() {
            // SAFETY: reading the thread's last error code.
            return Err(err(format!("CreateJobObjectW failed with win32 error {}", unsafe {
                GetLastError()
            })));
        }
        let mut limits = JobObjectExtendedLimitInformation {
            basic_limit_information: JobObjectBasicLimitInformation {
                // No breakaway of any kind. The tree cannot leave this job.
                limit_flags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                ..JobObjectBasicLimitInformation::default()
            },
            ..JobObjectExtendedLimitInformation::default()
        };
        // SAFETY: `limits` is a live, correctly sized local.
        let limits_ok = unsafe {
            SetInformationJobObject(
                job.get(),
                JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                std::ptr::addr_of_mut!(limits).cast::<c_void>(),
                std::mem::size_of::<JobObjectExtendedLimitInformation>() as u32,
            )
        };
        if limits_ok == 0 {
            // SAFETY: reading the thread's last error code.
            return Err(err(format!(
                "SetInformationJobObject failed with win32 error {}",
                unsafe { GetLastError() }
            )));
        }

        // Suspended create -> assign -> resume. The child cannot run, and so
        // cannot create a descendant, before the job holds it.
        let spawned = match spawn_process(&SpawnRequest {
            program: args.child_exe.as_os_str(),
            args: &args.child_args,
            cwd: Some(args.child_cwd.as_os_str()),
            // No console flag: the child inherits this broker's console, which
            // is what makes it reachable by a console control event. The group
            // flag must be on this call, not on a console-creating one.
            creation_flags: CREATE_NEW_PROCESS_GROUP | CREATE_SUSPENDED,
            hide_window: false,
            stdio: [args.child_stdin, args.child_stdout, args.child_stderr],
            // Exactly three handles. The control channel is not among them.
            inherit: &[args.child_stdin, args.child_stdout, args.child_stderr],
        }) {
            Ok(spawned) => spawned,
            Err(error) => {
                ack.emit(json!({ "type": "child_started", "error": error.0 }));
                return Err(error);
            }
        };

        // SAFETY: assigning a suspended, exclusively owned process to our job.
        let assigned = unsafe { AssignProcessToJobObject(job.get(), spawned.process.get()) };
        // SAFETY: reading the thread's last error code.
        let assign_error = if assigned == 0 { unsafe { GetLastError() } } else { 0 };
        if assigned == 0 {
            // SAFETY: the child never ran; terminating the exact handle we hold.
            unsafe { TerminateProcess(spawned.process.get(), 1) };
            ack.emit(json!({
                "type": "child_started",
                "error": format!("AssignProcessToJobObject failed with win32 error {assign_error}"),
            }));
            return Err(err(format!(
                "AssignProcessToJobObject failed with win32 error {assign_error}"
            )));
        }
        let mut in_job = 0i32;
        // SAFETY: `spawned.process` is live; a null job asks "in any job".
        unsafe { IsProcessInJob(spawned.process.get(), std::ptr::null_mut(), &mut in_job) };

        // The control channel must be unreachable from the child. It already is
        // (it was never in the child's handle list); this makes it explicit and
        // is what the leak test observes.
        // SAFETY: both are live handles owned by this process.
        unsafe {
            SetHandleInformation(GetStdHandle(STD_INPUT_HANDLE), HANDLE_FLAG_INHERIT, 0);
            SetHandleInformation(GetStdHandle(STD_OUTPUT_HANDLE), HANDLE_FLAG_INHERIT, 0);
        }

        // SAFETY: resuming the single primary thread we just created suspended.
        let resumed = unsafe { ResumeThread(spawned.thread.get()) };
        if resumed == u32::MAX {
            // SAFETY: reading last error, then cleaning up the child we own.
            let code = unsafe { GetLastError() };
            unsafe { TerminateProcess(spawned.process.get(), 1) };
            ack.emit(json!({
                "type": "child_started",
                "error": format!("ResumeThread failed with win32 error {code}"),
            }));
            return Err(err(format!("ResumeThread failed with win32 error {code}")));
        }
        drop(spawned.thread);

        let identity = match crate::process_identity::observe_process(spawned.pid) {
            crate::process_identity::ProcessObservation::Live(identity) => identity,
            other => {
                ack.emit(json!({
                    "type": "child_started",
                    "error": format!("the child identity was not observable: {other:?}"),
                }));
                return Err(err("the child identity was not observable"));
            }
        };

        ack.emit(json!({
            "type": "child_started",
            "child": {
                "pid": identity.pid,
                "parentPid": identity.parent_pid,
                "createdMs": identity.created_ms,
                "creationDate": identity.creation_date(),
                "executablePath": identity.executable_path,
                "executableSha256": identity.executable_sha256,
            },
            "processGroupId": spawned.pid,
            "creationFlags": "CREATE_NEW_PROCESS_GROUP|CREATE_SUSPENDED",
            "consoleInherited": true,
            "brokerConsole": console_snapshot(),
            "job": {
                "assignedBeforeResume": true,
                "assignError": assign_error,
                "inJob": in_job != 0,
                "breakawayAllowed": false,
                "limitFlags": limits.basic_limit_information.limit_flags,
            },
            "handleList": ["stdin", "stdout", "stderr"],
            "controlChannelInherited": false,
        }));

        let state = BrokerState {
            child: spawned.process,
            job,
            pid: spawned.pid,
            creation_date: identity.creation_date(),
            executable_path: identity.executable_path.clone(),
            executable_sha256: identity.executable_sha256.clone(),
            signalled: Mutex::new(Vec::new()),
        };
        serve_control(args, ack, request_file, &state);
        Ok(0)
    }

    struct BrokerState {
        child: RawHandle,
        job: RawHandle,
        pid: u32,
        creation_date: String,
        executable_path: String,
        executable_sha256: String,
        /// Request ids already answered. One signal per request, ever.
        signalled: Mutex<Vec<String>>,
    }

    impl BrokerState {
        fn job_members(&self) -> (u32, Vec<u32>, u32) {
            let mut buffer = vec![0u8; std::mem::size_of::<JobObjectBasicProcessIdList>() + 1024];
            let mut returned = 0u32;
            // SAFETY: buffer is sized for the header plus room for ids.
            let ok = unsafe {
                QueryInformationJobObject(
                    self.job.get(),
                    JOB_OBJECT_BASIC_PROCESS_ID_LIST,
                    buffer.as_mut_ptr().cast::<c_void>(),
                    buffer.len() as u32,
                    &mut returned,
                )
            };
            if ok == 0 {
                // SAFETY: reading the thread's last error code.
                return (u32::MAX, Vec::new(), unsafe { GetLastError() });
            }
            // SAFETY: the OS filled the buffer with this exact layout.
            let list = unsafe { &*buffer.as_ptr().cast::<JobObjectBasicProcessIdList>() };
            let count = list.number_of_process_ids_in_list as usize;
            // SAFETY: `count` ids follow the header, inside the buffer we sized.
            let ids = unsafe {
                std::slice::from_raw_parts(list.process_id_list.as_ptr(), count)
                    .iter()
                    .map(|value| *value as u32)
                    .collect::<Vec<_>>()
            };
            (list.number_of_assigned_processes, ids, 0)
        }
    }

    fn serve_control(
        args: &BrokerArgs,
        ack: &Arc<AckWriter>,
        request_file: std::fs::File,
        state: &BrokerState,
    ) {
        let mut reader = BufReader::new(request_file);
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            if trimmed.len() > MAX_CONTROL_LINE_BYTES {
                ack.emit(json!({ "type": "fatal", "error": "control frame too large" }));
                break;
            }
            let Ok(frame) = serde_json::from_str::<Value>(trimmed) else {
                ack.emit(json!({ "type": "protocol_error", "error": "unparseable control frame" }));
                continue;
            };
            // A frame that does not carry this broker's exact nonce is not from
            // its Core. It is refused without touching the child.
            if frame.get("nonce").and_then(Value::as_str) != Some(args.nonce.as_str()) {
                ack.emit(json!({
                    "type": "protocol_error",
                    "error": "control frame nonce mismatch",
                }));
                continue;
            }
            match frame.get("type").and_then(Value::as_str) {
                Some("stop") => handle_stop(ack, state, &frame),
                Some("shutdown") => {
                    // Explicit forced cleanup of the task-owned tree, reported
                    // as cleanup and never as a stop result.
                    // SAFETY: terminating the job this broker exclusively owns.
                    let terminated = unsafe { TerminateJobObject(state.job.get(), 1) };
                    ack.emit(json!({
                        "type": "shutdown_complete",
                        "forcedCleanup": true,
                        "terminateJobReturned": terminated != 0,
                    }));
                    break;
                }
                _ => ack.emit(json!({
                    "type": "protocol_error",
                    "error": "unknown control frame type",
                })),
            }
        }
    }

    fn handle_stop(ack: &Arc<AckWriter>, state: &BrokerState, frame: &Value) {
        let request_id = frame
            .get("requestId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let reject = |reason: &str| {
            ack.emit(json!({
                "type": "stop_ack",
                "requestId": request_id,
                "accepted": false,
                "identityMatch": false,
                "reason": reason,
                "signal": { "attempted": false, "returned": Value::Null, "lastError": Value::Null },
            }));
        };
        if request_id.is_empty() {
            return reject("stop frame carried no request id");
        }
        {
            let Ok(mut seen) = state.signalled.lock() else {
                return reject("broker stop state is poisoned");
            };
            if seen.iter().any(|id| id == &request_id) {
                return reject("duplicate stop request id; the broker signals once per request");
            }
            // A second, differently-identified request after one was already
            // served is still only one signal for this child.
            if !seen.is_empty() {
                return reject("this child was already signalled once");
            }
            seen.push(request_id.clone());
        }

        // Re-observe the live child and compare the full tuple. A stale or
        // mismatched request never reaches GenerateConsoleCtrlEvent.
        let pid = frame.get("pid").and_then(Value::as_u64).unwrap_or_default() as u32;
        if pid != state.pid {
            return reject("stop request pid does not match the broker's child");
        }
        let observed = match crate::process_identity::observe_process(state.pid) {
            crate::process_identity::ProcessObservation::Live(identity) => identity,
            crate::process_identity::ProcessObservation::NotRunning => {
                return reject("the broker's child had already exited");
            }
            crate::process_identity::ProcessObservation::Unknown(reason) => {
                return reject(&format!("the child identity was not observable: {reason}"));
            }
        };
        let requested = |key: &str| {
            frame
                .get(key)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned()
        };
        let identity_match = observed.creation_date() == state.creation_date
            && observed.creation_date() == requested("creationDate")
            && observed
                .executable_path
                .eq_ignore_ascii_case(&state.executable_path)
            && observed
                .executable_path
                .eq_ignore_ascii_case(&requested("executablePath"))
            && observed
                .executable_sha256
                .eq_ignore_ascii_case(&state.executable_sha256)
            && observed
                .executable_sha256
                .eq_ignore_ascii_case(&requested("executableSha256"));
        if !identity_match {
            return reject("the stop request identity does not match the live child");
        }

        let console = console_snapshot();
        let members = console
            .get("consoleProcessIds")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_u64().map(|value| value as u32))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if !members.contains(&state.pid) {
            return reject("the child is not a member of the broker console");
        }

        // Membership immediately before the signal. Compared with the reading
        // after it, this distinguishes "the tree was accounted for and then
        // left" from "the job never held it in the first place".
        let (assigned_before, members_before, query_error_before) = state.job_members();

        // The group id is the child's pid because the child was created with
        // CREATE_NEW_PROCESS_GROUP. Group zero is never a target.
        let group_id = state.pid;
        // SAFETY: a console control event addressed to a specific group id.
        let (returned, last_error) = unsafe {
            let result = GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, group_id);
            (result != 0, if result == 0 { GetLastError() } else { 0 })
        };
        let signalled_at = Instant::now();
        ack.emit(json!({
            "type": "stop_ack",
            "requestId": request_id,
            "accepted": true,
            "identityMatch": true,
            "signal": {
                "api": "GenerateConsoleCtrlEvent",
                "ctrlEvent": "CTRL_BREAK_EVENT",
                "ctrlEventValue": CTRL_BREAK_EVENT,
                "groupId": group_id,
                "attempted": true,
                "returned": returned,
                "lastError": last_error,
                "signalCount": 1,
            },
            "brokerConsole": console,
            "jobBeforeSignal": {
                "memberCount": if assigned_before == u32::MAX { Value::Null } else { json!(members_before.len()) },
                "assignedProcesses": if assigned_before == u32::MAX { Value::Null } else { json!(assigned_before) },
                "members": members_before,
                "queryError": query_error_before,
            },
        }));
        if !returned {
            ack.emit(json!({
                "type": "effect",
                "requestId": request_id,
                "exited": false,
                "exitCode": Value::Null,
                "elapsedMs": 0,
                "reason": "the console control event was rejected; no effect was observed",
                "job": { "memberCount": Value::Null, "members": [] },
            }));
            return;
        }

        let bound = frame
            .get("effectBoundMs")
            .and_then(Value::as_u64)
            .unwrap_or(4_000)
            .min(30_000);
        let wait = wait_process(state.child.get(), bound as u32);
        let elapsed = signalled_at.elapsed().as_millis() as u64;
        let exited = wait == WAIT_OBJECT_0;
        let code = exited.then(|| exit_code(state.child.get())).flatten();
        let (assigned, member_ids, query_error) = state.job_members();
        ack.emit(json!({
            "type": "effect",
            "requestId": request_id,
            "exited": exited,
            "exitCode": code,
            "elapsedMs": elapsed,
            "waitResult": wait,
            "waitTimedOut": wait == WAIT_TIMEOUT,
            "effectBoundMs": bound,
            "job": {
                "memberCount": if assigned == u32::MAX { Value::Null } else { json!(member_ids.len()) },
                "assignedProcesses": if assigned == u32::MAX { Value::Null } else { json!(assigned) },
                "members": member_ids,
                "queryError": query_error,
            },
        }));
    }
}
