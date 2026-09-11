//! Process identity observations for startup receipts.

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    env, fs,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessIdentity {
    pub pid: u32,
    pub parent_pid: u32,
    pub executable_path: String,
    pub executable_sha256: String,
    pub created_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProcessObservation {
    Live(ProcessIdentity),
    NotRunning,
    Unknown(String),
}

impl ProcessIdentity {
    pub fn creation_date(&self) -> String {
        cim_date(self.created_ms)
    }

    pub fn to_json(&self) -> Value {
        json!({
            "pid": self.pid,
            "parentPid": self.parent_pid,
            "createdMs": self.created_ms,
            "creationDate": self.creation_date(),
            "executablePath": self.executable_path,
            "executableSha256": self.executable_sha256,
            "inAnyJob": in_any_job(),
        })
    }
}

pub fn cim_date(created_ms: u64) -> String {
    format!("/Date({created_ms})/")
}

pub fn current_identity() -> ProcessIdentity {
    let executable_path = env::current_exe()
        .ok()
        .and_then(|path| path.canonicalize().ok().or(Some(path)))
        .unwrap_or_default();
    let executable_sha256 = file_sha256(&executable_path);
    ProcessIdentity {
        pid: std::process::id(),
        parent_pid: observed_parent_pid(),
        executable_path: display_path(&executable_path),
        executable_sha256,
        created_ms: process_created_ms(),
    }
}

/// Observe an exact process identity. Access-denied or incomplete observations
/// remain Unknown; callers must not turn them into proof that a prior Core ended.
pub fn observe_process(pid: u32) -> ProcessObservation {
    #[cfg(windows)]
    {
        windows_process_identity(pid)
    }
    #[cfg(not(windows))]
    {
        if pid == std::process::id() {
            ProcessObservation::Live(current_identity())
        } else {
            ProcessObservation::Unknown("process observation is only implemented on Windows".into())
        }
    }
}

pub fn display_path(path: &Path) -> String {
    let text = path.display().to_string();
    text.strip_prefix(r"\\?\").unwrap_or(&text).to_string()
}

pub fn file_sha256(path: impl AsRef<Path>) -> String {
    fs::read(path)
        .map(|bytes| {
            let mut hasher = Sha256::new();
            hasher.update(&bytes);
            format!("{:x}", hasher.finalize())
        })
        .unwrap_or_default()
}

pub fn env_u32(key: &str) -> u32 {
    env::var(key)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(0)
}

pub fn env_u64(key: &str) -> u64 {
    env::var(key)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(0)
}

pub fn env_string(key: &str) -> String {
    env::var(key).unwrap_or_default()
}

pub fn identity_from_env(prefix: &str) -> Value {
    let created_ms = env_u64(&format!("{prefix}_CREATED_MS"));
    json!({
        "pid": env_u32(&format!("{prefix}_PID")),
        "createdMs": created_ms,
        "creationDate": cim_date(created_ms),
        "executablePath": env_string(&format!("{prefix}_EXE")),
        "executableSha256": env_string(&format!("{prefix}_SHA256")),
    })
}

fn process_created_ms() -> u64 {
    #[cfg(windows)]
    {
        windows_process_created_ms().unwrap_or_else(fallback_created_ms)
    }
    #[cfg(not(windows))]
    {
        fallback_created_ms()
    }
}

fn fallback_created_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

pub fn in_any_job() -> Option<bool> {
    #[cfg(windows)]
    {
        unsafe {
            let mut result: i32 = 0;
            if IsProcessInJob(GetCurrentProcess(), std::ptr::null_mut(), &mut result) == 0 {
                return None;
            }
            Some(result != 0)
        }
    }
    #[cfg(not(windows))]
    {
        None
    }
}

fn observed_parent_pid() -> u32 {
    #[cfg(windows)]
    {
        windows_parent_pid().unwrap_or(0)
    }
    #[cfg(not(windows))]
    {
        0
    }
}

#[cfg(windows)]
fn windows_parent_pid() -> Option<u32> {
    unsafe {
        let mut pbi = ProcessBasicInformation::default();
        let status = NtQueryInformationProcess(
            GetCurrentProcess(),
            0,
            &mut pbi as *mut _ as *mut _,
            std::mem::size_of::<ProcessBasicInformation>() as u32,
            std::ptr::null_mut(),
        );
        if status != 0 {
            return None;
        }
        Some(pbi.inherited_from_unique_process_id as u32)
    }
}

#[cfg(windows)]
fn windows_process_created_ms() -> Option<u64> {
    unsafe {
        let mut created = FileTime::default();
        let mut exit = FileTime::default();
        let mut kernel = FileTime::default();
        let mut user = FileTime::default();
        if GetProcessTimes(
            GetCurrentProcess(),
            &mut created,
            &mut exit,
            &mut kernel,
            &mut user,
        ) == 0
        {
            return None;
        }
        let ticks =
            (u64::from(created.dw_high_date_time) << 32) | u64::from(created.dw_low_date_time);
        Some(ticks / 10_000 - 11_644_473_600_000)
    }
}

#[cfg(windows)]
fn file_time_ms(created: &FileTime) -> u64 {
    let ticks = (u64::from(created.dw_high_date_time) << 32) | u64::from(created.dw_low_date_time);
    ticks / 10_000 - 11_644_473_600_000
}

#[cfg(windows)]
fn windows_process_identity(pid: u32) -> ProcessObservation {
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const ERROR_INVALID_PARAMETER: u32 = 87;
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() {
            let error = GetLastError();
            return if error == ERROR_INVALID_PARAMETER {
                ProcessObservation::NotRunning
            } else {
                ProcessObservation::Unknown(format!("OpenProcess({pid}) failed with {error}"))
            };
        }
        let result = (|| {
            let mut created = FileTime::default();
            let mut exit = FileTime::default();
            let mut kernel = FileTime::default();
            let mut user = FileTime::default();
            if GetProcessTimes(process, &mut created, &mut exit, &mut kernel, &mut user) == 0 {
                return Err(format!(
                    "GetProcessTimes({pid}) failed with {}",
                    GetLastError()
                ));
            }
            let mut path_buffer = vec![0u16; 32_768];
            let mut path_len = path_buffer.len() as u32;
            if QueryFullProcessImageNameW(process, 0, path_buffer.as_mut_ptr(), &mut path_len) == 0
            {
                return Err(format!(
                    "QueryFullProcessImageNameW({pid}) failed with {}",
                    GetLastError()
                ));
            }
            path_buffer.truncate(path_len as usize);
            let executable_path = PathBuf::from(String::from_utf16_lossy(&path_buffer));
            let mut pbi = ProcessBasicInformation::default();
            let status = NtQueryInformationProcess(
                process,
                0,
                &mut pbi as *mut _ as *mut _,
                std::mem::size_of::<ProcessBasicInformation>() as u32,
                std::ptr::null_mut(),
            );
            if status != 0 {
                return Err(format!(
                    "NtQueryInformationProcess({pid}) failed with {status}"
                ));
            }
            Ok(ProcessIdentity {
                pid,
                parent_pid: pbi.inherited_from_unique_process_id as u32,
                executable_sha256: file_sha256(&executable_path),
                executable_path: display_path(&executable_path),
                created_ms: file_time_ms(&created),
            })
        })();
        CloseHandle(process);
        match result {
            Ok(identity)
                if !identity.executable_path.is_empty()
                    && !identity.executable_sha256.is_empty() =>
            {
                ProcessObservation::Live(identity)
            }
            Ok(_) => ProcessObservation::Unknown(format!("process {pid} identity was incomplete")),
            Err(error) => ProcessObservation::Unknown(error),
        }
    }
}

#[cfg(windows)]
#[repr(C)]
#[derive(Default)]
struct ProcessBasicInformation {
    reserved1: usize,
    peb_base_address: usize,
    reserved2_0: usize,
    reserved2_1: usize,
    unique_process_id: usize,
    inherited_from_unique_process_id: usize,
}

#[cfg(windows)]
#[repr(C)]
#[derive(Default)]
struct FileTime {
    dw_low_date_time: u32,
    dw_high_date_time: u32,
}

#[cfg(windows)]
unsafe extern "system" {
    fn OpenProcess(
        desired_access: u32,
        inherit_handle: i32,
        process_id: u32,
    ) -> *mut std::ffi::c_void;
    fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
    fn GetLastError() -> u32;
    fn QueryFullProcessImageNameW(
        process: *mut std::ffi::c_void,
        flags: u32,
        image_file_name: *mut u16,
        size: *mut u32,
    ) -> i32;
    fn GetCurrentProcess() -> *mut std::ffi::c_void;
    fn GetProcessTimes(
        process: *mut std::ffi::c_void,
        created: *mut FileTime,
        exit: *mut FileTime,
        kernel: *mut FileTime,
        user: *mut FileTime,
    ) -> i32;
    fn NtQueryInformationProcess(
        process: *mut std::ffi::c_void,
        info_class: i32,
        info: *mut std::ffi::c_void,
        info_length: u32,
        return_length: *mut u32,
    ) -> i32;
    fn IsProcessInJob(
        process: *mut std::ffi::c_void,
        job: *mut std::ffi::c_void,
        result: *mut i32,
    ) -> i32;
}
