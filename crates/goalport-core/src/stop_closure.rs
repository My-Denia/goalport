//! Linux evidence that a cancelled Claude turn is no longer writing its workspace.
//!
//! Provider turn cancellation is not enough. A hold is released only when two
//! quiet observations, at least a second apart, both see no other process with
//! that workspace as its cwd and the same complete workspace fingerprint.

use crate::turn_results::{
    WorkspaceDelta, WorkspaceSample, compare_workspace_samples, sample_workspace_entries,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::Path,
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
    let mut sample = sample_workspace_entries(workspace)?;
    // Merge-review P1: the quiet proof must cover git-ignored content too
    // (a residual process can write target/ or dist/ by absolute path from
    // outside the workspace). Aggregate digest over (path, size, mtime_ns)
    // triples — stat only, no content reads — and only on THIS path: the
    // shared hot helper stays untouched. Over-cap enumerations mark the
    // sample honestly unknown instead of guessing quiet.
    match ignored_digest(workspace) {
        IgnoredDigest::Digest(digest) => sample.ignored_digest = Some(digest),
        IgnoredDigest::Truncated => sample.ignored_truncated = true,
        IgnoredDigest::Unavailable => {}
    }
    Some(sample)
}

const MAX_IGNORED_RECORDS: usize = 50_000;

enum IgnoredDigest {
    Digest(String),
    Truncated,
    Unavailable,
}

fn ignored_digest(workspace: &Path) -> IgnoredDigest {
    let output = match std::process::Command::new("git")
        .arg("-C")
        .arg(workspace)
        .args(["status", "--porcelain=v1", "-z", "-uall", "--ignored"])
        .output()
    {
        Ok(output) if output.status.success() => output,
        _ => return IgnoredDigest::Unavailable,
    };
    let bytes = output.stdout;
    // -z records are NUL-separated "XY <path>"; ignored records are "!! ".
    let mut triples: Vec<String> = Vec::new();
    let mut count = 0usize;
    let mut start = 0usize;
    for (index, byte) in bytes.iter().enumerate() {
        if *byte != 0 {
            continue;
        }
        let record = &bytes[start..index];
        start = index + 1;
        if record.len() < 3 || &record[..2] != b"!!" {
            continue;
        }
        count += 1;
        if count > MAX_IGNORED_RECORDS {
            return IgnoredDigest::Truncated;
        }
        let path = &record[3..];
        let path = if let Some(pos) = path.iter().position(|&b| b == b'\0') {
            &path[..pos]
        } else {
            path
        };
        let full = workspace.join(String::from_utf8_lossy(path).as_ref());
        // stat-only fingerprint: (path, size, mtime_nanos).
        if let Ok(metadata) = std::fs::metadata(&full) {
            let mtime_ns = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_nanos())
                .unwrap_or(0);
            triples.push(format!(
                "{}|{}|{}",
                String::from_utf8_lossy(path),
                metadata.len(),
                mtime_ns
            ));
        } else {
            triples.push(format!("{}|absent", String::from_utf8_lossy(path)));
        }
    }
    triples.sort();
    let mut hasher = Sha256::new();
    for triple in &triples {
        hasher.update(triple.as_bytes());
        hasher.update(b"\n");
    }
    IgnoredDigest::Digest(format!("{:x}", hasher.finalize()))
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
}
