//! Stop-time and close-time descendant observation.
//!
//! A cancelled Claude turn's residual execution is, by construction, the CLI
//! process and whatever it spawned. While the CLI lives, every descendant is
//! reachable through parent links (`/proc/<pid>/stat` PPid on Linux —
//! world-readable even for non-dumpable processes; `th32ParentProcessID` on
//! Windows), so snapshotting the descendant set at Stop time gives the
//! release rules a durable, identity-checked liveness leg that re-parenting
//! after the CLI's death cannot evade. Each record carries the OS start-time
//! identity so a recycled pid is never mistaken for a survivor.
//!
//! Missing evidence is NOT absence (projection's re-check discipline): a
//! responsibility without a snapshot keeps its hold; classification failures
//! read as unknown, never as dead.
#![allow(dead_code)]

use serde_json::{Value, json};
#[cfg(target_os = "linux")]
use libc;

/// One snapshotted descendant: pid plus the OS start-time identity used to
/// detect pid reuse. `start_tick` is Linux /proc starttime (clock ticks since
/// boot) or the Windows creation-time representation, both opaque here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DescendantRecord {
    pub pid: u32,
    pub start_tick: String,
}

/// Classify a snapshotted descendant against current OS state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DescendantState {
    /// The pid is gone: the recorded descendant ended.
    Dead,
    /// The pid exists with the recorded start-time identity: still running.
    Alive,
    /// The pid exists with a DIFFERENT identity: recycled, the recorded
    /// process ended.
    Reused,
    /// The observation failed: unknown, never dead.
    Unknown,
}

/// `None` means the enumeration FAILED: the caller must persist NO snapshot
/// field (missing evidence holds the release — plan rev 4's default). A
/// successful enumeration of a childless CLI yields `Some(vec![])`, which is
/// a recorded, provable empty set.
pub fn snapshot_descendants(root_pid: u32) -> Option<Vec<DescendantRecord>> {
    #[cfg(target_os = "linux")]
    {
        linux_snapshot(root_pid)
    }
    #[cfg(windows)]
    {
        windows_snapshot(root_pid)
    }
    #[cfg(not(any(target_os = "linux", windows)))]
    {
        let _ = root_pid;
        None
    }
}

pub fn classify_descendant(record: &DescendantRecord) -> DescendantState {
    #[cfg(target_os = "linux")]
    {
        linux_classify(record)
    }
    #[cfg(windows)]
    {
        windows_classify(record)
    }
    #[cfg(not(any(target_os = "linux", windows)))]
    {
        let _ = record;
        DescendantState::Unknown
    }
}

/// Serialize a snapshot for the durable stop trace.
pub fn descendants_json(records: &[DescendantRecord]) -> Value {
    json!(records
        .iter()
        .map(|record| json!({
            "pid": record.pid,
            "startTick": record.start_tick,
        }))
        .collect::<Vec<_>>())
}

/// Parse a snapshot from a durable stop trace. `None` when the payload carries
/// no snapshot field at all (pre-upgrade or crash-window holds) — the caller
/// must treat that as missing evidence, never as an empty set.
pub fn descendants_from_json(value: &Value) -> Option<Vec<DescendantRecord>> {
    let list = value.as_array()?;
    let mut records = Vec::with_capacity(list.len());
    for entry in list {
        records.push(DescendantRecord {
            pid: entry.get("pid").and_then(Value::as_u64)? as u32,
            start_tick: entry
                .get("startTick")
                .and_then(Value::as_str)?
                .to_owned(),
        });
    }
    Some(records)
}

#[cfg(target_os = "linux")]
fn linux_stat_fields(pid: u32) -> Option<(u32, String)> {
    let text = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // Field 4 is ppid and field 22 is starttime; the comm field (2) may
    // contain spaces inside parentheses, so parse after the LAST ')'.
    let after = text.rsplit(')').next()?;
    let mut fields = after.split_whitespace();
    let _state = fields.next()?;
    let ppid: u32 = fields.next()?.parse().ok()?;
    // After the comm parens we consumed state (field 3) and ppid (field 4).
    // starttime is field 22 overall, i.e. enumerate index 17 from here
    // (fields 5..=21 are 17 fields: index 0==field 5 … index 17==field 22).
    // Index 18 would be field 23 (vsize), which CHANGES for a live process —
    // an execution-audit empirically caught that off-by-one reading vsize as
    // the identity: a memory-growing descendant classified as pid-reused and
    // the release let go of a live residual.
    let mut tick = None;
    for (index, field) in fields.enumerate() {
        if index == 17 {
            tick = Some(field.to_owned());
            break;
        }
    }
    let start_tick = tick?;
    Some((ppid, start_tick))
}

#[cfg(target_os = "linux")]
fn linux_snapshot(root_pid: u32) -> Option<Vec<DescendantRecord>> {
    let mut parents: std::collections::HashMap<u32, u32> = std::collections::HashMap::new();
    let mut ticks: std::collections::HashMap<u32, String> = std::collections::HashMap::new();
    for entry in std::fs::read_dir("/proc").ok()?.into_iter().flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        if let Some((ppid, tick)) = linux_stat_fields(pid) {
            parents.insert(pid, ppid);
            ticks.insert(pid, tick);
        }
    }
    // Collect every pid whose parent chain reaches root_pid. Children of
    // root first, then transitively; a single pass per depth over the parent
    // map (workspaces have shallow trees; the map is small).
    let mut in_tree: std::collections::HashSet<u32> = std::collections::HashSet::new();
    in_tree.insert(root_pid);
    loop {
        let mut grew = false;
        for (&pid, &ppid) in parents.iter() {
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
            ticks
                .get(&pid)
                .map(|tick| DescendantRecord { pid, start_tick: tick.clone() })
        })
        .collect();
    records.sort_by_key(|record| record.pid);
    Some(records)
}

#[cfg(target_os = "linux")]
fn linux_classify(record: &DescendantRecord) -> DescendantState {
    match linux_stat_fields(record.pid) {
        None => {
            // /proc/<pid> gone, or stat unreadable. Distinguish via the
            // directory's existence: no directory -> process ended.
            if std::path::Path::new(&format!("/proc/{}", record.pid)).exists() {
                DescendantState::Unknown
            } else {
                DescendantState::Dead
            }
        }
        Some((_, tick)) => {
            if tick == record.start_tick {
                DescendantState::Alive
            } else {
                DescendantState::Reused
            }
        }
    }
}

#[cfg(windows)]
fn windows_snapshot(root_pid: u32) -> Option<Vec<DescendantRecord>> {
    crate::windows_descendants::snapshot(root_pid)
}

#[cfg(windows)]
fn windows_classify(record: &DescendantRecord) -> DescendantState {
    crate::windows_descendants::classify(record)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "linux")]
    #[test]
    fn a_spawned_child_is_snapshotted_with_identity() {
        use std::process::Command;
        let mut child = Command::new("sleep")
            .arg("30")
            .spawn()
            .expect("spawn sleep");
        let records = linux_snapshot(std::process::id()).expect("enumeration works");
        assert!(
            records.iter().any(|record| record.pid == child.id()),
            "our own child must be in the snapshot: {records:?}"
        );
        let record = records
            .iter()
            .find(|record| record.pid == child.id())
            .unwrap();
        assert_eq!(linux_classify(record), DescendantState::Alive);
        let _ = child.kill();
        let _ = child.wait();
        assert_eq!(linux_classify(record), DescendantState::Dead);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn json_round_trip_and_missing_field() {
        let records = vec![DescendantRecord {
            pid: 42,
            start_tick: "12345".into(),
        }];
        let parsed = descendants_from_json(&descendants_json(&records)).unwrap();
        assert_eq!(parsed, records);
        assert!(descendants_from_json(&Value::Null).is_none());
    }
}

/// Terminate identity-matched survivors: SIGTERM (Windows: TerminateProcess),
/// a bounded reap wait, then SIGKILL. Returns the number of descendants that
/// are STILL Alive/Unknown afterwards — the caller refuses a confirmed close
/// while any remain (merge-review P1: explicit close owns the whole process
/// tree or does not claim closure).
pub fn terminate_descendants(records: &[DescendantRecord]) -> usize {
    #[cfg(target_os = "linux")]
    {
        linux_terminate(records)
    }
    #[cfg(windows)]
    {
        windows_terminate(records)
    }
    #[cfg(not(any(target_os = "linux", windows)))]
    {
        let _ = records;
        records.len() // unimplemented platforms never claim containment
    }
}

#[cfg(target_os = "linux")]
fn linux_terminate(records: &[DescendantRecord]) -> usize {
    let live = |record: &DescendantRecord| {
        matches!(
            classify_descendant(record),
            DescendantState::Alive | DescendantState::Unknown
        )
    };
    let signal = |record: &DescendantRecord, sig: i32| {
        // SAFETY: libc kill with a checked pid; errors (already gone) ignore.
        unsafe { libc::kill(record.pid as i32, sig) };
    };
    for record in records {
        if live(record) {
            signal(record, libc::SIGTERM);
        }
    }
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(2_000);
    while std::time::Instant::now() < deadline
        && records.iter().any(|record| live(record))
    {
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    for record in records {
        if live(record) {
            signal(record, libc::SIGKILL);
        }
    }
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(2_000);
    while std::time::Instant::now() < deadline
        && records.iter().any(|record| live(record))
    {
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    records.iter().filter(|record| live(record)).count()
}

#[cfg(windows)]
fn windows_terminate(records: &[DescendantRecord]) -> usize {
    crate::windows_descendants::terminate(records)
}

#[cfg(target_os = "linux")]
#[cfg(test)]
mod terminate_tests {
    use super::*;
    use std::process::Command;

    #[test]
    fn a_surviving_descendant_is_terminated_or_reported() {
        let mut child = Command::new("sleep")
            .arg("60")
            .spawn()
            .expect("spawn sleep");
        let records = linux_snapshot(std::process::id()).expect("enumeration works");
        let record = records
            .iter()
            .find(|record| record.pid == child.id())
            .expect("child snapshotted")
            .clone();
        assert_eq!(classify_descendant(&record), DescendantState::Alive);
        // Kill the child ourselves so the walk's root is gone but the record
        // stays; termination then acts on the record's identity.
        let _ = child.kill();
        let _ = child.wait();
        let remaining = linux_terminate(&[record]);
        assert_eq!(remaining, 0, "a dead descendant reports zero survivors");
    }
}

#[cfg(target_os = "linux")]
#[cfg(test)]
mod starttime_identity_tests {
    use super::*;
    use std::process::{Command, Stdio};

    /// Execution-audit regression: the identity field must be starttime
    /// (constant for a live process), NOT vsize (field 23, which changes as
    /// a live descendant allocates). Before the fix, a memory-growing
    /// descendant classified as pid-reused and release treated it as dead.
    #[test]
    fn a_memory_growing_descendant_stays_alive_across_snapshots() {
        // A python child that allocates in a loop: vsize changes constantly,
        // starttime never does.
        let mut child = Command::new("python3")
            .args([
                "-c",
                "import time\nbuf=[]\nwhile True:\n    buf.append(b'x'*65536)\n    time.sleep(0.05)\n",
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn python");
        let first = linux_snapshot(std::process::id()).expect("enumeration");
        let record = first
            .iter()
            .find(|record| record.pid == child.id())
            .expect("child snapshotted")
            .clone();
        // Give the allocator time to change vsize, then re-classify with a
        // FRESH snapshot's tick for the same pid: identity must still match.
        std::thread::sleep(std::time::Duration::from_millis(600));
        let second = linux_snapshot(std::process::id()).expect("enumeration");
        let second_record = second
            .iter()
            .find(|record| record.pid == child.id())
            .expect("child still snapshotted");
        assert_eq!(
            record.start_tick, second_record.start_tick,
            "starttime identity is stable while vsize changes"
        );
        assert_eq!(classify_descendant(&record), DescendantState::Alive);
        let _ = child.kill();
        let _ = child.wait();
    }
}
