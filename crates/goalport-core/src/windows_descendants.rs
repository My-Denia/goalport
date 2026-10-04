//! Windows descendant snapshot/classification for Stop release and close
//! containment (see crates/goalport-core/src/descendants.rs for the design).
#![cfg(windows)]

use crate::descendants::{DescendantRecord, DescendantState};

use winapi::ctypes::c_void;
use winapi::um::handleapi::{CloseHandle, INVALID_HANDLE_VALUE};
use winapi::um::tlhelp32::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
};
use winapi::um::winnt::HANDLE;

#[repr(C)]
#[derive(Default)]
struct FileTime {
    dw_low_date_time: u32,
    dw_high_date_time: u32,
}

unsafe extern "system" {
    fn TerminateProcess(process: HANDLE, exit_code: u32) -> i32;
    fn WaitForSingleObject(process: HANDLE, milliseconds: u32) -> u32;
    fn OpenProcess(
        desired_access: u32,
        inherit_handle: i32,
        process_id: u32,
    ) -> HANDLE;
    fn GetProcessTimes(
        process: HANDLE,
        created: *mut FileTime,
        exit: *mut FileTime,
        kernel: *mut FileTime,
        user: *mut FileTime,
    ) -> i32;
}

const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;

fn creation_tick(pid: u32) -> Option<String> {
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() {
            return None;
        }
        let mut created = FileTime::default();
        let mut exit = FileTime::default();
        let mut kernel = FileTime::default();
        let mut user = FileTime::default();
        let ok = GetProcessTimes(process, &mut created, &mut exit, &mut kernel, &mut user);
        CloseHandle(process);
        if ok == 0 {
            return None;
        }
        Some(format!(
            "{:08x}{:08x}",
            created.dw_high_date_time, created.dw_low_date_time
        ))
    }
}

/// Snapshot every descendant of `root_pid` (all depths) with creation-time
/// identity, via a single Toolhelp process snapshot. `None` = the
/// enumeration FAILED: callers persist no snapshot field and the release
/// holds on missing evidence; `Some(empty)` is a recorded, provable empty
/// set (a childless CLI).
pub(crate) fn snapshot(root_pid: u32) -> Option<Vec<DescendantRecord>> {
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap.is_null() || snap == INVALID_HANDLE_VALUE {
            // Enumeration failed: None means the caller persists NO snapshot
            // field, and the release holds on missing evidence — a failed
            // enumeration must never be journaled as a recorded-empty set.
            return None;
        }
        let mut entries: Vec<(u32, u32)> = Vec::new(); // (pid, ppid)
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        if Process32FirstW(snap, &mut entry) != 0 {
            loop {
                entries.push((entry.th32ProcessID, entry.th32ParentProcessID));
                if Process32NextW(snap, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snap);
        let mut in_tree: std::collections::HashSet<u32> = std::collections::HashSet::new();
        in_tree.insert(root_pid);
        loop {
            let mut grew = false;
            for &(pid, ppid) in entries.iter() {
                if in_tree.contains(&ppid) && in_tree.insert(pid) {
                    grew = true;
                }
            }
            if !grew {
                break;
            }
        }
        in_tree.remove(&root_pid);
        let mut records: Vec<DescendantRecord> = in_tree
            .into_iter()
            .filter_map(|pid| {
                creation_tick(pid)
                    .map(|tick| DescendantRecord { pid, start_tick: tick })
            })
            .collect();
        records.sort_by_key(|record| record.pid);
        Some(records)
    }
}

/// Classify one record: pid absent (OpenProcess/query fails with the pid no
/// longer present) reads as Dead only when the pid is truly gone from a fresh
/// enumeration; otherwise identity comparison decides Alive/Reused; an
/// unreadable live pid is Unknown.
pub(crate) fn classify(record: &DescendantRecord) -> DescendantState {
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap.is_null() || snap == INVALID_HANDLE_VALUE {
            return DescendantState::Unknown;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut present = false;
        if Process32FirstW(snap, &mut entry) != 0 {
            loop {
                if entry.th32ProcessID == record.pid {
                    present = true;
                    break;
                }
                if Process32NextW(snap, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snap);
        if !present {
            return DescendantState::Dead;
        }
        match creation_tick(record.pid) {
            None => DescendantState::Unknown,
            Some(tick) if tick == record.start_tick => DescendantState::Alive,
            Some(_) => DescendantState::Reused,
        }
    }
}

const PROCESS_TERMINATE: u32 = 0x0001;
const WAIT_TIMEOUT: u32 = 0x0000_0102;

/// Terminate identity-matched survivors, bounded; returns how many remain
/// Alive/Unknown afterwards (see descendants::terminate_descendants).
pub(crate) fn terminate(records: &[crate::descendants::DescendantRecord]) -> usize {
    let live = |record: &crate::descendants::DescendantRecord| {
        matches!(
            crate::descendants::classify_descendant(record),
            crate::descendants::DescendantState::Alive
                | crate::descendants::DescendantState::Unknown
        )
    };
    unsafe {
        for record in records {
            if live(record) {
                let process = OpenProcess(PROCESS_TERMINATE, 0, record.pid);
                if !process.is_null() {
                    TerminateProcess(process, 1);
                    CloseHandle(process);
                }
            }
        }
        // Bounded reap wait.
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(2_000);
        while std::time::Instant::now() < deadline && records.iter().any(|r| live(r)) {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        for record in records {
            if live(record) {
                let process = OpenProcess(PROCESS_TERMINATE, 0, record.pid);
                if !process.is_null() {
                    TerminateProcess(process, 1);
                    // A hard kill gets one synchronous wait.
                    WaitForSingleObject(process, 2_000);
                    CloseHandle(process);
                }
            }
        }
    }
    records.iter().filter(|record| live(record)).count()
}

// Keep c_void linked in parity with the sibling modules' extern style.
#[allow(unused_imports)]
use c_void as _Void;
