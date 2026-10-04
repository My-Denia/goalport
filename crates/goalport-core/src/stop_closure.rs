//! Linux evidence that a cancelled Claude turn is no longer writing its workspace.
//!
//! Provider turn cancellation is not enough. A hold is released only when two
//! quiet observations, at least a second apart, both see no other process with
//! that workspace as its cwd and the same complete workspace fingerprint.

use crate::turn_results::{
    WorkspaceDelta, WorkspaceSample, compare_workspace_samples, sample_workspace_entries,
};
use serde_json::{Value, json};
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

pub(crate) fn workspace_writers(workspace: &Path, claude_pid: u32) -> Result<Vec<u32>, String> {
    let workspace = fs::canonicalize(workspace).map_err(|error| error.to_string())?;
    let mut writers = Vec::new();
    let entries = fs::read_dir("/proc").map_err(|error| error.to_string())?;
    for entry in entries.flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        if pid == claude_pid || pid == 0 {
            continue;
        }
        let cwd_link = entry.path().join("cwd");
        let Ok(cwd) = fs::read_link(&cwd_link) else {
            continue;
        };
        let Ok(cwd) = fs::canonicalize(&cwd) else {
            continue;
        };
        if cwd == workspace {
            writers.push(pid);
        }
    }
    writers.sort_unstable();
    Ok(writers)
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
    compare_workspace_samples(&earlier, &later) == WorkspaceDelta::Equal
}

fn fingerprint_json(sample: &WorkspaceSample) -> Value {
    json!({
        "truncated": sample.truncated,
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
    sample_workspace_entries(workspace)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::turn_results::WorkspaceEntry;

    fn sample(path: &str, hash: &str) -> WorkspaceSample {
        WorkspaceSample {
            truncated: false,
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
