//! Linux evidence that a cancelled Claude turn is no longer writing its workspace.
//!
//! Provider turn cancellation is not enough. A hold is released only when the
//! recorded descendants and spawn-time domain are clear, and two quiet
//! observations at least a second apart have the same workspace fingerprint.
//! An unrelated process that only shares the workspace directory is not a hold.

use crate::turn_results::{WorkspaceDelta, WorkspaceSample, compare_workspace_samples};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
    thread,
    time::{SystemTime, UNIX_EPOCH},
};

const QUIET_MS: u128 = 1_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum QuietDecision {
    Hold { residual: &'static str, quiet: Value },
    Release { evidence: Value },
}

pub(crate) fn hosted_workspace(key: &str) -> Option<std::path::PathBuf> {
    let unix = key.replace('\\', "/");
    fs::canonicalize(unix).ok()
}

/// Normalize a path an OS observation handed us as text: strip the verbatim
/// (`\\?\`) prefix `canonicalize` produces on Windows and the object-manager
/// (`\??\`) prefix the PEB reports, so both forms compare equal to the
/// canonicalized workspace. A behavioral no-op on Linux.
pub(crate) fn normalize_observed_path(text: &str) -> std::path::PathBuf {
    let stripped = text
        .strip_prefix(r"\\?\")
        .or_else(|| text.strip_prefix(r"\??\"))
        .unwrap_or(text);
    std::path::PathBuf::from(stripped)
}

/// Component-aware containment: the observed directory IS the workspace or a
/// descendant of it. A path that merely shares a string prefix
/// (`workspace-src`) is not within. On Windows the comparison additionally
/// ASCII-case-folds (DOS paths are case-insensitive) while staying
/// component-aware, so a case-variant spelling of the workspace itself
/// (equal length) also matches.
pub(crate) fn path_is_within(workspace: &Path, dir: &Path) -> bool {
    if dir == workspace {
        return true;
    }
    #[cfg(windows)]
    {
        let fold = |path: &Path| {
            path.components()
                .map(|component| component.as_os_str().to_string_lossy().to_ascii_lowercase())
                .collect::<Vec<_>>()
        };
        let dir_parts = fold(dir);
        let workspace_parts = fold(workspace);
        return dir_parts.len() >= workspace_parts.len()
            && dir_parts[..workspace_parts.len()] == workspace_parts[..];
    }
    #[cfg(not(windows))]
    {
        dir.starts_with(workspace)
    }
}

pub(crate) fn workspace_writers(workspace: &Path, claude_pid: u32) -> Result<Vec<u32>, String> {
    let workspace = fs::canonicalize(workspace).map_err(|error| error.to_string())?;
    // canonicalize resolves symlinks and `..`, but on Windows it also yields
    // a verbatim `\\?\` path while OS observations arrive in DOS form.
    // Normalize both sides through the same helper so containment compares
    // like with like (a no-op on Linux).
    let workspace = normalize_observed_path(&workspace.to_string_lossy());
    let mut writers = Vec::new();
    for pid in platform_enumerate_cwds(claude_pid)? {
        if path_is_within(&workspace, &pid.cwd) {
            writers.push(pid.pid);
        }
    }
    writers.sort_unstable();
    Ok(writers)
}

struct ObservedCwd {
    pid: u32,
    cwd: std::path::PathBuf,
}

/// Enumerate every other live process's current working directory.
///
/// Per-process observation failures (permissions, a process that exited
/// mid-scan, an unreadable PEB) skip that process -- the same observational
/// limitation on both platforms. Only a systemic failure returns Err, so the
/// release loop's fail-closed posture is unchanged.
#[cfg(target_os = "linux")]
fn platform_enumerate_cwds(claude_pid: u32) -> Result<Vec<ObservedCwd>, String> {
    let mut observed = Vec::new();
    let entries = fs::read_dir("/proc").map_err(|error| error.to_string())?;
    let core_pid = std::process::id();
    for entry in entries.flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        // The excluded CLI pid AND Core's own pid: running Core from inside
        // the managed workspace must not permanently block release
        // (merge-review P2).
        if pid == claude_pid || pid == core_pid || pid == 0 {
            continue;
        }
        let cwd_link = entry.path().join("cwd");
        let Ok(cwd) = fs::read_link(&cwd_link) else {
            continue;
        };
        let Ok(cwd) = fs::canonicalize(&cwd) else {
            continue;
        };
        observed.push(ObservedCwd { pid, cwd });
    }
    Ok(observed)
}

#[cfg(windows)]
fn platform_enumerate_cwds(claude_pid: u32) -> Result<Vec<ObservedCwd>, String> {
    Ok(super::windows_writers::enumerate_cwds(claude_pid)?
        .into_iter()
        .map(|(pid, cwd)| ObservedCwd { pid, cwd })
        .collect())
}

pub(crate) fn decide_quiet(
    previous: Option<&Value>,
    writers: &[u32],
    sample: Option<&WorkspaceSample>,
    now_ms: u128,
) -> QuietDecision {
    if !writers.is_empty() {
        return QuietDecision::Hold {
            residual: "active",
            quiet: json!({
                "observedAtMs": now_ms,
                "writers": writers,
                "fingerprint": Value::Null,
            }),
        };
    }
    let Some(sample) = sample else {
        return QuietDecision::Hold {
            residual: "unknown",
            quiet: json!({
                "observedAtMs": now_ms,
                "writers": [],
                "fingerprint": Value::Null,
                "reason": "workspace fingerprint could not be read",
            }),
        };
    };
    if sample.truncated {
        return QuietDecision::Hold {
            residual: "unknown",
            quiet: json!({
                "observedAtMs": now_ms,
                "writers": [],
                "fingerprint": Value::Null,
                "reason": "workspace fingerprint is truncated",
            }),
        };
    }
    let current = fingerprint_json(sample);
    let previous_quiet = previous.and_then(|value| value.get("workspaceQuiet"));
    let previous_fp = previous_quiet.and_then(|value| value.get("fingerprint"));
    let previous_at = previous_quiet
        .and_then(|value| value.get("observedAtMs"))
        .and_then(Value::as_u64)
        .unwrap_or(0) as u128;
    let equal = previous_fp.is_some_and(|earlier| {
        earlier != &Value::Null && fingerprints_equal(earlier, &current)
    });
    if equal && now_ms.saturating_sub(previous_at) >= QUIET_MS {
        return QuietDecision::Release {
            evidence: json!({
                "writers": [],
                "fingerprintEqual": true,
                "quietMs": now_ms.saturating_sub(previous_at),
                "claudePidExcluded": true,
            }),
        };
    }
    // While the fingerprint is unchanged the window keeps its ORIGINAL start:
    // the quiet duration being measured is "how long since the last change",
    // not "how long between two polls". Resetting the timestamp on every
    // sample would let a poll cadence faster than QUIET_MS starve the release
    // forever, whatever the workspace state. A fingerprint change, a live
    // writer or an unreadable sample still restarts the window.
    let window_start = if equal { previous_at } else { now_ms };
    QuietDecision::Hold {
        residual: "unknown",
        quiet: json!({
            "observedAtMs": window_start,
            "writers": [],
            "fingerprint": current,
        }),
    }
}

fn fingerprints_equal(previous: &Value, current: &Value) -> bool {
    let Some(earlier) = sample_from_json(previous) else {
        return false;
    };
    let Some(later) = sample_from_json(current) else {
        return false;
    };
    if compare_workspace_samples(&earlier, &later) != WorkspaceDelta::Equal {
        return false;
    }
    // The ignored-content leg (merge-review P1): quiet requires both samples
    // to carry an untruncated ignored digest and for the digests to be
    // equal. Absent-vs-present is a change (pre-digest samples never compare
    // equal to digested ones); truncated never compares equal.
    match (&earlier.ignored_digest, &later.ignored_digest) {
        (Some(before), Some(after)) => {
            !earlier.ignored_truncated && !later.ignored_truncated && before == after
        }
        _ => false,
    }
}

fn fingerprint_json(sample: &WorkspaceSample) -> Value {
    json!({
        "truncated": sample.truncated,
        "ignoredDigest": sample.ignored_digest,
        "ignoredTruncated": sample.ignored_truncated,
        "entries": sample.entries.iter().map(|entry| json!({
            "path": entry.path,
            "area": entry.area,
            "status": entry.status,
            "contentHash": entry.content_hash,
            "contentInspection": entry.content_inspection,
        })).collect::<Vec<_>>(),
    })
}

fn sample_from_json(value: &Value) -> Option<WorkspaceSample> {
    let entries = value.get("entries")?.as_array()?;
    let mut parsed = Vec::new();
    for entry in entries {
        parsed.push(crate::turn_results::WorkspaceEntry {
            path: entry.get("path")?.as_str()?.to_owned(),
            area: entry.get("area")?.as_str()?.to_owned(),
            status: entry.get("status")?.as_str()?.to_owned(),
            content_hash: entry
                .get("contentHash")
                .and_then(Value::as_str)
                .map(str::to_owned),
            content_inspection: entry.get("contentInspection")?.as_str()?.to_owned(),
        });
    }
    Some(WorkspaceSample {
        truncated: value.get("truncated").and_then(Value::as_bool).unwrap_or(true),
        ignored_digest: value
            .get("ignoredDigest")
            .and_then(Value::as_str)
            .map(str::to_owned),
        ignored_truncated: value
            .get("ignoredTruncated")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        entries: parsed,
    })
}

pub(crate) fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

pub(crate) fn sample_workspace(workspace: &Path) -> Option<WorkspaceSample> {
    // Release uses one uncapped stat digest. The turn-result sampler stops at
    // 80 paths and leaves a file over 1 MiB without a hash, which would hold
    // Stop forever. Git is not required: a missing binary or a localized
    // "not a repository" error must not make an ordinary folder unreadable.
    if !workspace.is_dir() {
        return None;
    }
    filesystem_sample(workspace)
}

/// A snapshot request must not walk the tree. `Pending` means a scan is
/// still running; the caller leaves the previous quiet observation alone.
/// `Unreadable` is a completed failure and holds. `Ready` is one completed
/// sample, consumed once.
#[derive(Debug)]
pub(crate) enum ReleaseSample {
    Pending,
    Unreadable,
    Ready(WorkspaceSample),
}

struct ScanSlot {
    running: bool,
    ready: Option<Result<WorkspaceSample, ()>>,
}

static RELEASE_SCANS: LazyLock<Mutex<HashMap<PathBuf, ScanSlot>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub(crate) fn take_release_sample(workspace: &Path) -> ReleaseSample {
    let Ok(mut slots) = RELEASE_SCANS.lock() else {
        return ReleaseSample::Unreadable;
    };
    let slot = slots.entry(workspace.to_path_buf()).or_insert(ScanSlot {
        running: false,
        ready: None,
    });
    if let Some(result) = slot.ready.take() {
        spawn_release_scan(workspace, slot);
        return match result {
            Ok(sample) => ReleaseSample::Ready(sample),
            Err(()) => ReleaseSample::Unreadable,
        };
    }
    if !slot.running {
        spawn_release_scan(workspace, slot);
    }
    ReleaseSample::Pending
}

fn spawn_release_scan(workspace: &Path, slot: &mut ScanSlot) {
    let path = workspace.to_path_buf();
    slot.running = true;
    let spawned = thread::Builder::new()
        .name("goalport-quiet-scan".into())
        .spawn(move || {
            let result = sample_workspace(&path).ok_or(());
            if let Ok(mut slots) = RELEASE_SCANS.lock() {
                if let Some(slot) = slots.get_mut(&path) {
                    slot.running = false;
                    slot.ready = Some(result);
                }
            }
        });
    if spawned.is_err() {
        slot.running = false;
        slot.ready = Some(Err(()));
    }
}

fn filesystem_sample(workspace: &Path) -> Option<WorkspaceSample> {
    let mut records = Vec::new();
    if walk_files(workspace, workspace, &mut records).is_err() {
        return None;
    }
    records.sort();
    let mut hasher = Sha256::new();
    for record in &records {
        hasher.update(record);
        hasher.update(b"\n");
    }
    Some(WorkspaceSample {
        truncated: false,
        ignored_digest: Some(format!("{:x}", hasher.finalize())),
        ignored_truncated: false,
        entries: Vec::new(),
    })
}

fn walk_files(root: &Path, dir: &Path, records: &mut Vec<Vec<u8>>) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        let meta = std::fs::symlink_metadata(&path)?;
        if meta.file_type().is_symlink() {
            let relative = path.strip_prefix(root).unwrap_or(&path);
            let mut record = path_bytes(relative);
            record.extend_from_slice(b"\0symlink\0");
            if let Ok(target) = std::fs::read_link(&path) {
                record.extend_from_slice(&path_bytes(&target));
            }
            records.push(record);
            continue;
        }
        if meta.is_dir() {
            let relative = path.strip_prefix(root).unwrap_or(&path);
            let modified = meta
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|time| time.as_nanos())
                .unwrap_or(0);
            let mut record = path_bytes(relative);
            record.extend_from_slice(b"\0dir\0");
            record.extend_from_slice(modified.to_string().as_bytes());
            records.push(record);
            walk_files(root, &path, records)?;
            continue;
        }
        let relative = path.strip_prefix(root).unwrap_or(&path);
        let modified = meta
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|time| time.as_nanos())
            .unwrap_or(0);
        let mut record = path_bytes(relative);
        record.push(0);
        record.extend_from_slice(meta.len().to_string().as_bytes());
        record.push(0);
        record.extend_from_slice(modified.to_string().as_bytes());
        records.push(record);
    }
    Ok(())
}

fn path_bytes(path: &Path) -> Vec<u8> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        return path.as_os_str().as_bytes().to_vec();
    }
    #[cfg(not(unix))]
    {
        path.to_string_lossy().into_owned().into_bytes()
    }
}

/// Writer filter at the Stop release gate. Does not signal. Does not change
/// `decide_quiet` or `workspace_writers`.
///
/// `Hold` means do not release. `Filtered` is passed to `decide_quiet`; an
/// empty list still runs the fingerprint window and is not itself a release.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ReleaseWriterGate {
    Hold,
    Filtered(Vec<u32>),
}

/// Identity view of the bound runtime. Mismatch is not `NotRunning`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum BoundRuntimeView {
    MissingIdentity,
    Unknown,
    IdentityMismatch,
    NotRunning,
    LiveMatch { pid: u32 },
}

/// `fresh_snapshot` is consulted only for `LiveMatch`. `None` there means the
/// fresh enumeration failed and the gate holds. Other views ignore it.
pub(crate) fn gate_release_writers(
    view: BoundRuntimeView,
    stop_time: &[crate::descendants::DescendantRecord],
    writers: &[u32],
    fresh_snapshot: Option<&[crate::descendants::DescendantRecord]>,
    classify: impl Fn(&crate::descendants::DescendantRecord) -> crate::descendants::DescendantState,
) -> ReleaseWriterGate {
    use crate::descendants::DescendantState;
    match view {
        BoundRuntimeView::MissingIdentity
        | BoundRuntimeView::Unknown
        | BoundRuntimeView::IdentityMismatch => ReleaseWriterGate::Hold,
        BoundRuntimeView::NotRunning => ReleaseWriterGate::Filtered(
            alive_stop_time_writers(writers, stop_time, classify),
        ),
        BoundRuntimeView::LiveMatch { .. } => {
            let Some(fresh) = fresh_snapshot else {
                return ReleaseWriterGate::Hold;
            };
            if fresh.iter().any(|record| {
                matches!(
                    classify(record),
                    DescendantState::Alive | DescendantState::Unknown
                )
            }) {
                return ReleaseWriterGate::Hold;
            }
            ReleaseWriterGate::Filtered(alive_stop_time_writers(writers, stop_time, classify))
        }
    }
}

fn alive_stop_time_writers(
    writers: &[u32],
    stop_time: &[crate::descendants::DescendantRecord],
    classify: impl Fn(&crate::descendants::DescendantRecord) -> crate::descendants::DescendantState,
) -> Vec<u32> {
    writers
        .iter()
        .copied()
        .filter(|pid| {
            stop_time.iter().any(|record| {
                record.pid == *pid
                    && classify(record) == crate::descendants::DescendantState::Alive
            })
        })
        .collect()
}

pub(crate) fn gate_stop_release_writers(
    bound: &Value,
    stop_time: &[crate::descendants::DescendantRecord],
    writers: &[u32],
) -> ReleaseWriterGate {
    let view = bound_runtime_view(bound);
    if let BoundRuntimeView::LiveMatch { pid } = view {
        let fresh = crate::descendants::snapshot_descendants(pid);
        return gate_release_writers(
            BoundRuntimeView::LiveMatch { pid },
            stop_time,
            writers,
            fresh.as_deref(),
            crate::descendants::classify_descendant,
        );
    }
    gate_release_writers(
        view,
        stop_time,
        writers,
        None,
        crate::descendants::classify_descendant,
    )
}

fn bound_runtime_view(bound: &Value) -> BoundRuntimeView {
    let pid = bound.get("pid").and_then(Value::as_u64).unwrap_or(0) as u32;
    let creation = bound
        .get("creationDate")
        .and_then(Value::as_str)
        .unwrap_or("");
    let sha = bound
        .get("executableSha256")
        .and_then(Value::as_str)
        .unwrap_or("");
    if bound.is_null() || pid == 0 || creation.is_empty() || sha.is_empty() {
        return BoundRuntimeView::MissingIdentity;
    }
    match crate::process_identity::observe_process(pid) {
        crate::process_identity::ProcessObservation::NotRunning => BoundRuntimeView::NotRunning,
        crate::process_identity::ProcessObservation::Unknown(_) => BoundRuntimeView::Unknown,
        crate::process_identity::ProcessObservation::Live(identity) => {
            if identity.creation_date() == creation && identity.executable_sha256 == sha {
                BoundRuntimeView::LiveMatch { pid }
            } else {
                // A recycled pid or a different binary is not evidence the
                // bound process ended. Do not treat it as NotRunning.
                BoundRuntimeView::IdentityMismatch
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::turn_results::WorkspaceEntry;

    fn sample(path: &str, hash: &str) -> WorkspaceSample {
        WorkspaceSample {
            truncated: false,
            ignored_digest: Some("ignored-digest".into()),
            ignored_truncated: false,
            entries: vec![WorkspaceEntry {
                path: path.into(),
                area: "unstaged".into(),
                status: " M".into(),
                content_hash: Some(hash.into()),
                content_inspection: "available".into(),
            }],
        }
    }

    #[test]
    fn a_live_writer_keeps_the_hold_active() {
        let decision = decide_quiet(None, &[42], Some(&sample("tick.txt", "aaa")), 5_000);
        match decision {
            QuietDecision::Hold { residual, .. } => assert_eq!(residual, "active"),
            QuietDecision::Release { .. } => panic!("a live writer must not release"),
        }
    }

    #[test]
    fn one_quiet_sample_does_not_release() {
        let decision = decide_quiet(None, &[], Some(&sample("tick.txt", "aaa")), 5_000);
        assert!(matches!(decision, QuietDecision::Hold { residual: "unknown", .. }));
    }

    #[test]
    fn two_equal_quiet_samples_a_second_apart_release() {
        let first = decide_quiet(None, &[], Some(&sample("tick.txt", "aaa")), 5_000);
        let QuietDecision::Hold { quiet, .. } = first else {
            panic!("first sample holds");
        };
        let detail = json!({ "workspaceQuiet": quiet });
        let second = decide_quiet(Some(&detail), &[], Some(&sample("tick.txt", "aaa")), 6_200);
        match second {
            QuietDecision::Release { evidence } => {
                // The quiet gate proves only the quiet window. Whether the turn
                // itself was cancelled is the caller's separate, durable claim.
                assert_eq!(evidence["fingerprintEqual"], true);
                assert_eq!(evidence["writers"], json!([]));
                assert!(evidence.get("nativeTurnCancelled").is_none());
            }
            QuietDecision::Hold { .. } => panic!("equal quiet window should release"),
        }
    }

    #[test]
    fn fast_polling_does_not_starve_the_quiet_window() {
        // A poll cadence faster than QUIET_MS must not restart the window on
        // every sample; the release measures quiet duration since the last
        // fingerprint change, not the spacing of two polls.
        let first = decide_quiet(None, &[], Some(&sample("tick.txt", "aaa")), 5_000);
        let QuietDecision::Hold { quiet, .. } = first else {
            panic!("first sample holds");
        };
        let detail = json!({ "workspaceQuiet": quiet });
        let second = decide_quiet(Some(&detail), &[], Some(&sample("tick.txt", "aaa")), 5_300);
        let second_quiet = match second {
            QuietDecision::Hold { quiet, .. } => {
                assert_eq!(quiet["observedAtMs"], json!(5_000), "window start is kept");
                quiet
            }
            QuietDecision::Release { .. } => panic!("300 ms is not a quiet second"),
        };
        let detail = json!({ "workspaceQuiet": second_quiet });
        let third = decide_quiet(Some(&detail), &[], Some(&sample("tick.txt", "aaa")), 6_100);
        assert!(
            matches!(third, QuietDecision::Release { .. }),
            "1.1 s since the window start must release despite 800 ms poll spacing"
        );
    }

    #[test]
    fn a_fingerprint_change_does_not_release() {
        let first = decide_quiet(None, &[], Some(&sample("tick.txt", "aaa")), 5_000);
        let QuietDecision::Hold { quiet, .. } = first else {
            panic!("first sample holds");
        };
        let detail = json!({ "workspaceQuiet": quiet });
        let second = decide_quiet(Some(&detail), &[], Some(&sample("tick.txt", "bbb")), 8_000);
        assert!(matches!(second, QuietDecision::Hold { .. }));
    }

    #[test]
    fn a_non_git_folder_can_go_quiet() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("notes.txt"), "one\n").unwrap();
        let first = sample_workspace(dir.path()).expect("non-git sample");
        assert!(first.ignored_digest.is_some());
        assert!(!first.truncated);
        let held = decide_quiet(None, &[], Some(&first), 1_000);
        assert!(matches!(held, QuietDecision::Hold { .. }));
        let detail = json!({
            "workspaceQuiet": {
                "observedAtMs": 1_000,
                "writers": [],
                "fingerprint": fingerprint_json(&first)
            }
        });
        let second = sample_workspace(dir.path()).expect("second sample");
        let released = decide_quiet(Some(&detail), &[], Some(&second), 3_000);
        assert!(matches!(released, QuietDecision::Release { .. }), "{released:?}");
    }

    #[test]
    fn a_large_non_git_folder_is_not_permanently_unknown() {
        let dir = tempfile::tempdir().unwrap();
        for index in 0..2_001 {
            std::fs::write(dir.path().join(format!("f{index}.txt")), "x").unwrap();
        }
        let sample = sample_workspace(dir.path()).expect("large folder");
        assert!(!sample.truncated, "file count must not freeze the hold");
        assert!(!sample.ignored_truncated);
        std::fs::write(dir.path().join("f0.txt"), "changed").unwrap();
        let changed = sample_workspace(dir.path()).expect("changed folder");
        assert_ne!(sample.ignored_digest, changed.ignored_digest);
    }

    #[test]
    fn an_empty_directory_changes_the_fingerprint() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("notes.txt"), "one\n").unwrap();
        let before = sample_workspace(dir.path()).unwrap();
        std::fs::create_dir(dir.path().join("empty")).unwrap();
        let after = sample_workspace(dir.path()).unwrap();
        assert_ne!(before.ignored_digest, after.ignored_digest);
    }

    #[test]
    fn a_release_sample_does_not_walk_on_the_caller() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("notes.txt"), "one\n").unwrap();
        assert!(matches!(
            take_release_sample(dir.path()),
            ReleaseSample::Pending
        ));
        let started = std::time::Instant::now();
        loop {
            match take_release_sample(dir.path()) {
                ReleaseSample::Ready(sample) => {
                    assert!(sample.ignored_digest.is_some());
                    return;
                }
                ReleaseSample::Pending => {
                    assert!(started.elapsed() < std::time::Duration::from_secs(2));
                    thread::yield_now();
                }
                ReleaseSample::Unreadable => panic!("walk failed"),
            }
        }
    }

    #[test]
    fn a_git_repo_past_the_turn_result_cap_can_still_go_quiet() {
        let dir = tempfile::tempdir().unwrap();
        let run = |args: &[&str]| {
            let status = std::process::Command::new("git")
                .arg("-C")
                .arg(dir.path())
                .args(args)
                .status()
                .unwrap();
            assert!(status.success());
        };
        run(&["init", "-q"]);
        for index in 0..81 {
            std::fs::write(dir.path().join(format!("f{index}.txt")), "x").unwrap();
        }
        let sample = sample_workspace(dir.path()).expect("wide git sample");
        assert!(!sample.truncated);
        assert!(!sample.ignored_truncated);
        std::fs::write(dir.path().join("f0.txt"), "changed").unwrap();
        let changed = sample_workspace(dir.path()).unwrap();
        assert_ne!(sample.ignored_digest, changed.ignored_digest);
    }

    #[test]
    fn an_unreadable_workspace_does_not_release() {
        let decision = decide_quiet(None, &[], None, 5_000);
        assert!(matches!(decision, QuietDecision::Hold { residual: "unknown", .. }));
    }
}

#[cfg(test)]
mod ignored_digest_tests {
    use super::*;

    fn repo_with_ignore(name: &str) -> tempfile::TempDir {
        let outer = tempfile::tempdir().unwrap();
        let dir = tempfile::tempdir_in(outer.path()).unwrap();
        std::mem::forget(outer);
        let run = |args: &[&str]| {
            let status = std::process::Command::new("git")
                .arg("-C")
                .arg(dir.path())
                .args(args)
                .status()
                .unwrap();
            assert!(status.success());
        };
        run(&["init", "-q"]);
        run(&["config", "user.email", "t@e.c"]);
        run(&["config", "user.name", "t"]);
        std::fs::write(dir.path().join(".gitignore"), format!("{name}\n")).unwrap();
        std::fs::write(dir.path().join("README.md"), "base\n").unwrap();
        run(&["add", ".gitignore", "README.md"]);
        run(&["commit", "-qm", "base"]);
        dir
    }

    #[test]
    fn an_ignored_write_changes_the_digest_and_quiet_requires_equality() {
        let dir = repo_with_ignore("target-out");
        std::fs::write(dir.path().join("target-out"), "one\n").unwrap();
        let first = sample_workspace(dir.path()).unwrap();
        assert!(first.ignored_digest.is_some(), "{first:?}");
        // Identical consecutive reads compare equal.
        let second = sample_workspace(dir.path()).unwrap();
        let detail = json!({ "workspaceQuiet": {
            "fingerprint": fingerprint_json(&first),
        }});
        let decision = decide_quiet(
            Some(&detail),
            &[],
            Some(&second),
            crate::stop_closure::now_ms() + 2_000,
        );
        assert!(
            matches!(decision, QuietDecision::Release { .. }),
            "unchanged ignored content stays quiet: {decision:?}"
        );
        // A new write into the ignored path changes the digest: hold.
        std::fs::write(dir.path().join("target-out"), "two\n").unwrap();
        let third = sample_workspace(dir.path()).unwrap();
        assert_ne!(first.ignored_digest, third.ignored_digest);
        let detail = json!({ "workspaceQuiet": {
            "fingerprint": fingerprint_json(&first),
        }});
        let decision = decide_quiet(
            Some(&detail),
            &[],
            Some(&third),
            crate::stop_closure::now_ms() + 2_000,
        );
        assert!(
            matches!(decision, QuietDecision::Hold { .. }),
            "changed ignored content must hold: {decision:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_non_utf8_ignored_path_is_still_fingerprinted() {
        use std::os::unix::ffi::OsStrExt;
        let dir = repo_with_ignore("keep");
        std::fs::write(dir.path().join(".gitignore"), "*\n").unwrap();
        let name = std::ffi::OsStr::from_bytes(b"ignored-\xff.txt");
        std::fs::write(dir.path().join(name), "one\n").unwrap();
        let first = sample_workspace(dir.path()).unwrap();
        std::fs::write(dir.path().join(name), "two\n").unwrap();
        let second = sample_workspace(dir.path()).unwrap();
        assert_ne!(first.ignored_digest, second.ignored_digest);
    }

    #[test]
    fn a_digest_absent_from_either_sample_never_compares_equal() {
        // Pre-digest samples (hot-path samples carry no digest) never satisfy
        // the quiet comparator against a digested one.
        let dir = repo_with_ignore("target-out");
        std::fs::write(dir.path().join("target-out"), "one\n").unwrap();
        let digested = sample_workspace(dir.path()).unwrap();
        let mut undigested = digested.clone();
        undigested.ignored_digest = None;
        let detail = json!({ "workspaceQuiet": {
            "fingerprint": fingerprint_json(&undigested),
        }});
        let decision = decide_quiet(
            Some(&detail),
            &[],
            Some(&digested),
            crate::stop_closure::now_ms() + 2_000,
        );
        assert!(
            matches!(decision, QuietDecision::Hold { .. }),
            "absent-vs-present digest is a change: {decision:?}"
        );
    }

    fn record(pid: u32, tick: &str) -> crate::descendants::DescendantRecord {
        crate::descendants::DescendantRecord {
            pid,
            start_tick: tick.into(),
        }
    }

    fn classify_fixed(
        alive: u32,
    ) -> impl Fn(&crate::descendants::DescendantRecord) -> crate::descendants::DescendantState {
        move |record| {
            if record.pid == alive {
                crate::descendants::DescendantState::Alive
            } else if record.start_tick == "unknown" {
                crate::descendants::DescendantState::Unknown
            } else if record.start_tick == "reused" {
                crate::descendants::DescendantState::Reused
            } else {
                crate::descendants::DescendantState::Dead
            }
        }
    }

    #[test]
    fn missing_unknown_or_mismatch_holds_without_a_release() {
        let stop = [record(7, "tick")];
        for view in [
            BoundRuntimeView::MissingIdentity,
            BoundRuntimeView::Unknown,
            BoundRuntimeView::IdentityMismatch,
        ] {
            assert_eq!(
                gate_release_writers(view, &stop, &[7, 9], None, classify_fixed(7)),
                ReleaseWriterGate::Hold
            );
        }
    }

    #[test]
    fn not_running_blocks_only_an_identity_confirmed_alive_snapshot_member() {
        let stop = [record(7, "tick"), record(8, "dead")];
        let gated = gate_release_writers(
            BoundRuntimeView::NotRunning,
            &stop,
            &[7, 8, 99],
            None,
            classify_fixed(7),
        );
        assert_eq!(gated, ReleaseWriterGate::Filtered(vec![7]));
    }

    #[test]
    fn live_match_holds_on_fresh_none_or_any_alive_or_unknown_descendant() {
        let stop = [record(1, "old")];
        assert_eq!(
            gate_release_writers(
                BoundRuntimeView::LiveMatch { pid: 4 },
                &stop,
                &[],
                None,
                classify_fixed(0),
            ),
            ReleaseWriterGate::Hold
        );
        let fresh_alive = [record(50, "alive")];
        assert_eq!(
            gate_release_writers(
                BoundRuntimeView::LiveMatch { pid: 4 },
                &stop,
                &[],
                Some(&fresh_alive),
                |record| {
                    if record.pid == 50 {
                        crate::descendants::DescendantState::Alive
                    } else {
                        crate::descendants::DescendantState::Dead
                    }
                },
            ),
            ReleaseWriterGate::Hold,
            "a current Alive descendant holds even if it is not a CWD writer"
        );
        let fresh_unknown = [record(51, "unknown")];
        assert_eq!(
            gate_release_writers(
                BoundRuntimeView::LiveMatch { pid: 4 },
                &stop,
                &[99],
                Some(&fresh_unknown),
                |record| {
                    if record.start_tick == "unknown" {
                        crate::descendants::DescendantState::Unknown
                    } else {
                        crate::descendants::DescendantState::Dead
                    }
                },
            ),
            ReleaseWriterGate::Hold
        );
    }

    #[test]
    fn live_match_with_no_live_descendants_omits_unrelated_writers_and_still_fingerprints() {
        let stop = [record(7, "dead")];
        let fresh = [record(3, "dead")];
        let gated = gate_release_writers(
            BoundRuntimeView::LiveMatch { pid: 4 },
            &stop,
            &[99],
            Some(&fresh),
            |_| crate::descendants::DescendantState::Dead,
        );
        assert_eq!(
            gated,
            ReleaseWriterGate::Filtered(vec![]),
            "an empty filtered list is not a Hold/release short-circuit"
        );
    }
}
