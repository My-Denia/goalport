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

/// Assemble records for pids already known to be in the Runtime tree.
///
/// `None` if any of those pids has no creation tick. A partial set is not a
/// snapshot: callers already treat `None` as unavailable and must not journal
/// it. An empty pid list is `Some(vec![])`, a recorded empty set.
pub(crate) fn assemble_descendant_records(
    pids: impl IntoIterator<Item = u32>,
    mut tick_of: impl FnMut(u32) -> Option<String>,
) -> Option<Vec<DescendantRecord>> {
    let mut records = Vec::new();
    for pid in pids {
        let start_tick = tick_of(pid)?;
        records.push(DescendantRecord { pid, start_tick });
    }
    records.sort_by_key(|record| record.pid);
    Some(records)
}

/// Which bounded signal pass a platform signaller is performing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TerminatePhase {
    Term,
    Kill,
}

/// Signal only a record that classifies `Alive` immediately before that signal.
/// `Unknown` is never passed to `signal`. `Alive` and `Unknown` still count as
/// remaining. `Dead` and `Reused` are neither signalled nor counted.
///
/// `term_wait` / `kill_wait` are the bounded reap waits. Production callers
/// pass two seconds each. The classifier and signaller are injected by the
/// platform wrappers and by tests; there is no production test hook.
pub(crate) fn terminate_alive_only<C, S>(
    records: &[DescendantRecord],
    classify: C,
    mut signal: S,
    term_wait: std::time::Duration,
    kill_wait: std::time::Duration,
) -> usize
where
    C: Fn(&DescendantRecord) -> DescendantState,
    S: FnMut(&DescendantRecord, TerminatePhase),
{
    let counts = |record: &DescendantRecord| {
        matches!(
            classify(record),
            DescendantState::Alive | DescendantState::Unknown
        )
    };
    for record in records {
        if classify(record) == DescendantState::Alive {
            signal(record, TerminatePhase::Term);
        }
    }
    wait_while(term_wait, || records.iter().any(|record| counts(record)));
    for record in records {
        if classify(record) == DescendantState::Alive {
            signal(record, TerminatePhase::Kill);
        }
    }
    wait_while(kill_wait, || records.iter().any(|record| counts(record)));
    records.iter().filter(|record| counts(record)).count()
}

fn wait_while(bound: std::time::Duration, mut pending: impl FnMut() -> bool) {
    if bound.is_zero() || !pending() {
        return;
    }
    let deadline = std::time::Instant::now() + bound;
    while std::time::Instant::now() < deadline && pending() {
        let slice = std::time::Duration::from_millis(50)
            .min(deadline.saturating_duration_since(std::time::Instant::now()));
        if slice.is_zero() {
            break;
        }
        std::thread::sleep(slice);
    }
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
fn linux_process_state(pid: u32) -> Option<char> {
    let text = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let after = text.rsplit(')').next()?;
    after.split_whitespace().next()?.chars().next()
}

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
    // Every pid inserted into this map already had a tick. The assembler still
    // returns None if any in-tree pid lacks one, instead of dropping it.
    assemble_descendant_records(in_tree, |pid| ticks.get(&pid).cloned())
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
            if tick != record.start_tick {
                return DescendantState::Reused;
            }
            // A zombie is not executing. Holding until its parent reaps it
            // keeps a killed descendant blocking release after the workspace
            // is already quiet.
            if linux_process_state(record.pid) == Some('Z') {
                DescendantState::Dead
            } else {
                DescendantState::Alive
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
    terminate_alive_only(
        records,
        classify_descendant,
        |record, phase| {
            let sig = match phase {
                TerminatePhase::Term => libc::SIGTERM,
                TerminatePhase::Kill => libc::SIGKILL,
            };
            // SAFETY: libc kill with a checked pid; errors (already gone) ignore.
            // Only invoked for a record that classified Alive immediately before.
            unsafe { libc::kill(record.pid as i32, sig) };
        },
        std::time::Duration::from_millis(2_000),
        std::time::Duration::from_millis(2_000),
    )
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

#[cfg(test)]
mod assembler_and_signal_tests {
    use super::*;
    use std::cell::RefCell;

    #[test]
    fn assembler_returns_none_when_any_in_tree_pid_lacks_a_tick() {
        let ticks = std::collections::HashMap::from([(1u32, "a".to_owned())]);
        let partial = assemble_descendant_records([1, 2], |pid| ticks.get(&pid).cloned());
        assert!(partial.is_none(), "a missing tick must not become a partial snapshot");
        let complete = assemble_descendant_records([1], |pid| ticks.get(&pid).cloned()).unwrap();
        assert_eq!(complete.len(), 1);
        assert_eq!(complete[0].start_tick, "a");
        assert!(assemble_descendant_records(std::iter::empty(), |_| None).unwrap().is_empty());
    }

    #[test]
    fn unknown_is_never_signalled_and_alive_unknown_remain() {
        let records = vec![
            DescendantRecord { pid: 1, start_tick: "alive".into() },
            DescendantRecord { pid: 2, start_tick: "unknown".into() },
            DescendantRecord { pid: 3, start_tick: "dead".into() },
            DescendantRecord { pid: 4, start_tick: "reused".into() },
        ];
        let signalled = RefCell::new(Vec::new());
        let remaining = terminate_alive_only(
            &records,
            |record| match record.pid {
                1 => DescendantState::Alive,
                2 => DescendantState::Unknown,
                3 => DescendantState::Dead,
                _ => DescendantState::Reused,
            },
            |record, phase| {
                signalled.borrow_mut().push((record.pid, phase));
            },
            std::time::Duration::ZERO,
            std::time::Duration::ZERO,
        );
        let signalled = signalled.into_inner();
        assert!(
            signalled.iter().all(|(pid, _)| *pid == 1),
            "only the Alive record may be signalled: {signalled:?}"
        );
        assert!(
            !signalled.iter().any(|(pid, _)| *pid == 2),
            "Unknown must not reach the signaller: {signalled:?}"
        );
        assert_eq!(signalled.len(), 2, "Alive is signalled on both passes: {signalled:?}");
        assert_eq!(remaining, 2, "Alive and Unknown still count; Dead and Reused do not");
    }
}
