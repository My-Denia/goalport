//! Windows workspace-writer observation for cancelled Claude turns.
//!
//! The Linux peer walks `/proc/<pid>/cwd`. On Windows the equivalent evidence
//! is each process's PEB `CurrentDirectory.DosPath`: enumerate PIDs, open each
//! process with query+read rights, and read the x64 PEB chain
//! (`ProcessParameters` at `peb+0x20`; `CurrentDirectory` is a CURDIR struct
//! whose `Handle` sits at `params+0x38` and whose `DosPath` UNICODE_STRING
//! sits at `params+0x40` with its buffer pointer at `params+0x48`).
//!
//! Per-process failures skip that process — access-denied, an exited race, an
//! unreadable PEB are the Windows face of the observational limitation the
//! Linux side already has for unreadable `/proc/<pid>/cwd` links. Only a
//! systemic failure (EnumProcesses or allocation) surfaces as `Err` so the
//! release loop keeps holding.
#![cfg(windows)]

use std::path::PathBuf;

use winapi::um::handleapi::CloseHandle;
use winapi::um::memoryapi::ReadProcessMemory;
use winapi::um::processthreadsapi::OpenProcess;
use winapi::um::psapi::EnumProcesses;
use winapi::ctypes::c_void;
use winapi::um::winnt::{HANDLE, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ};

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

#[repr(C)]
#[derive(Default)]
struct UnicodeString {
    length: u16,
    maximum_length: u16,
    _padding: u32,
    buffer: usize,
}

unsafe extern "system" {
    fn NtQueryInformationProcess(
        process: HANDLE,
        info_class: i32,
        info: *mut c_void,
        info_length: u32,
        return_length: *mut u32,
    ) -> i32;
}

// x64 PEB / RTL_USER_PROCESS_PARAMETERS offsets. The packaged target is
// x64-only; these offsets are wrong for 32-bit and intentionally unused there.
const PEB_PROCESS_PARAMETERS: usize = 0x20;
const PARAMS_CURDIR_HANDLE: usize = 0x38;
const PARAMS_CURDIR_DOSPATH: usize = 0x40;

/// Read `size` bytes at `address` in the target process into `out`.
/// Returns false on any read failure (guard page, exited race, unreadable).
unsafe fn read_memory(process: HANDLE, address: usize, out: &mut [u8]) -> bool {
    let mut read: usize = 0;
    let ok = ReadProcessMemory(
        process,
        address as *const c_void,
        out.as_mut_ptr() as *mut c_void,
        out.len(),
        &mut read,
    );
    ok != 0 && read == out.len()
}

unsafe fn read_usize(process: HANDLE, address: usize) -> Option<usize> {
    let mut buffer = [0u8; std::mem::size_of::<usize>()];
    if read_memory(process, address, &mut buffer) {
        Some(usize::from_ne_bytes(buffer))
    } else {
        None
    }
}

/// The process's current working directory, read from its PEB, normalized by
/// the shared stop-closure helper (strips `\??\` / `\\?\`).
unsafe fn process_cwd(process: HANDLE) -> Option<PathBuf> {
    let mut info = ProcessBasicInformation::default();
    let status = NtQueryInformationProcess(
        process,
        0,
        &mut info as *mut ProcessBasicInformation as *mut c_void,
        std::mem::size_of::<ProcessBasicInformation>() as u32,
        std::ptr::null_mut(),
    );
    if status != 0 || info.peb_base_address == 0 {
        return None;
    }
    let parameters = read_usize(process, info.peb_base_address + PEB_PROCESS_PARAMETERS)?;
    // CURDIR at params+0x38 is { HANDLE Handle; UNICODE_STRING DosPath; }:
    // the handle is NOT the path; the DosPath begins at +0x40.
    let _handle = read_usize(process, parameters + PARAMS_CURDIR_HANDLE);
    let mut dos_path = UnicodeString::default();
    let dos_path_bytes = std::slice::from_raw_parts_mut(
        &mut dos_path as *mut UnicodeString as *mut u8,
        std::mem::size_of::<UnicodeString>(),
    );
    if !read_memory(process, parameters + PARAMS_CURDIR_DOSPATH, dos_path_bytes) {
        return None;
    }
    if dos_path.length == 0 || dos_path.length % 2 != 0 || dos_path.buffer == 0 {
        return None;
    }
    let mut wide = vec![0u8; dos_path.length as usize];
    if !read_memory(process, dos_path.buffer, &mut wide) {
        return None;
    }
    let units: Vec<u16> = wide
        .chunks_exact(2)
        .map(|pair| u16::from_ne_bytes([pair[0], pair[1]]))
        .collect();
    let text = String::from_utf16_lossy(&units);
    Some(crate::stop_closure::normalize_observed_path(&text))
}

/// Every other live process's current working directory, as (pid, cwd).
pub(super) fn enumerate_cwds(claude_pid: u32) -> Result<Vec<(u32, PathBuf)>, String> {
    let self_pid = std::process::id();
    let pids: Vec<u32>;
    let mut capacity: usize = 4096;
    loop {
        let mut buffer = vec![0u32; capacity];
        let mut bytes_returned: u32 = 0;
        let ok = unsafe {
            EnumProcesses(
                buffer.as_mut_ptr(),
                (capacity * std::mem::size_of::<u32>()) as u32,
                &mut bytes_returned,
            )
        };
        if ok == 0 {
            return Err("EnumProcesses failed".into());
        }
        let returned = bytes_returned as usize / std::mem::size_of::<u32>();
        if returned < capacity {
            pids = buffer[..returned].to_vec();
            break;
        }
        capacity *= 2;
        if capacity > 1 << 20 {
            return Err("EnumProcesses buffer refused to settle".into());
        }
    }
    let mut observed = Vec::new();
    for pid in pids {
        if pid == 0 || pid == claude_pid || pid == self_pid {
            continue;
        }
        // SAFETY: per-process handles are closed immediately; a failure to
        // open or read one process is a skip, not a scan failure.
        unsafe {
            let process = OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ,
                0,
                pid,
            );
            if process.is_null() {
                continue;
            }
            let cwd = process_cwd(process);
            CloseHandle(process);
            if let Some(cwd) = cwd {
                observed.push((pid, cwd));
            }
        }
    }
    Ok(observed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn sleeper(dir: &std::path::Path) -> std::process::Child {
        Command::new("cmd")
            .args(["/C", "ping -n 60 127.0.0.1 > nul"])
            .current_dir(dir)
            .spawn()
            .expect("spawn sleeper")
    }

    /// Merge-review P1: writer detection must observe a process whose cwd is
    /// INSIDE the workspace (a subdirectory), and must not observe a sibling.
    /// The excluded claude_pid is this test process, which is neither child,
    /// so the positive assertion is not vacuous.
    #[test]
    fn a_child_inside_the_workspace_is_reported_and_a_sibling_is_not() {
        let root = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir_in(root.path()).unwrap();
        let inside = workspace.path().join("src");
        let sibling = root.path().join("workspace-sibling");
        std::fs::create_dir_all(&inside).unwrap();
        std::fs::create_dir_all(&sibling).unwrap();
        let mut inside_child = sleeper(&inside);
        let mut sibling_child = sleeper(&sibling);
        let mut writers = Vec::new();
        for _ in 0..50 {
            writers = crate::stop_closure::workspace_writers(
                workspace.path(),
                std::process::id(),
            )
            .expect("writer observation");
            if writers.contains(&inside_child.id()) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        assert!(
            writers.contains(&inside_child.id()),
            "a process inside {inside:?} must be a writer (saw {writers:?})"
        );
        assert!(
            !writers.contains(&sibling_child.id()),
            "a sibling-directory process must not be a writer (saw {writers:?})"
        );
        let _ = inside_child.kill();
        let _ = sibling_child.kill();
        let _ = inside_child.wait();
        let _ = sibling_child.wait();
    }
}
