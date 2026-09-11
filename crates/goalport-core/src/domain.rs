//! Core domain values and invariants.

use serde::{Deserialize, Serialize};
use std::{fmt, path::Path};
use thiserror::Error;

pub type EntityId = String;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Project {
    pub id: EntityId,
    pub workspace_root: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum WorkStatus {
    #[default]
    InProgress,
    Finished,
    Abandoned,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Campaign {
    pub id: EntityId,
    pub goal: String,
    pub root_task_id: EntityId,
    pub state: WorkStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Task {
    pub id: EntityId,
    pub campaign_id: EntityId,
    pub title: String,
    pub acceptance: String,
    pub state: WorkStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AttemptState {
    #[default]
    Queued,
    Active,
    AwaitingReview,
    Closed,
    Failed,
    Cancelled,
}

impl AttemptState {
    pub const fn is_terminal(self) -> bool {
        matches!(self, Self::Closed | Self::Failed | Self::Cancelled)
    }

    pub const fn can_transition_to(self, next: Self) -> bool {
        matches!(
            (self, next),
            (Self::Queued, Self::Active)
                | (Self::Active, Self::AwaitingReview)
                | (Self::Active, Self::Failed)
                | (Self::Active, Self::Cancelled)
                | (Self::AwaitingReview, Self::Active)
                | (Self::AwaitingReview, Self::Closed)
                | (Self::AwaitingReview, Self::Failed)
                | (Self::AwaitingReview, Self::Cancelled)
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Attempt {
    pub id: EntityId,
    pub task_id: EntityId,
    pub provider: String,
    pub provider_session: Option<String>,
    pub state: AttemptState,
    pub last_event_seq: i64,
    pub capability_version: String,
}

impl Attempt {
    pub fn new(
        id: impl Into<String>,
        task_id: impl Into<String>,
        provider: impl Into<String>,
        capability_version: impl Into<String>,
    ) -> Self {
        Self {
            id: id.into(),
            task_id: task_id.into(),
            provider: provider.into(),
            provider_session: None,
            state: AttemptState::Queued,
            last_event_seq: 0,
            capability_version: capability_version.into(),
        }
    }

    pub fn transition(&mut self, next: AttemptState) -> Result<(), DomainError> {
        if self.state == next {
            return Ok(());
        }
        if !self.state.can_transition_to(next) {
            return Err(DomainError::InvalidAttemptTransition {
                from: self.state,
                to: next,
            });
        }
        self.state = next;
        Ok(())
    }

    pub fn set_provider_session(&mut self, session: impl Into<String>) -> Result<(), DomainError> {
        if self.state.is_terminal() {
            return Err(DomainError::TerminalAttemptMutation(self.id.clone()));
        }
        self.provider_session = Some(session.into());
        Ok(())
    }

    pub fn accept_event_sequence(&mut self, sequence: i64) -> Result<(), DomainError> {
        if sequence != self.last_event_seq + 1 {
            return Err(DomainError::OutOfOrderEvent {
                expected: self.last_event_seq + 1,
                received: sequence,
            });
        }
        self.last_event_seq = sequence;
        Ok(())
    }

    pub fn validate(&self) -> Result<(), DomainError> {
        if self.id.trim().is_empty() || self.task_id.trim().is_empty() {
            return Err(DomainError::InvalidEntity(
                "attempt identifiers must not be empty".into(),
            ));
        }
        if self.provider.trim().is_empty() || self.capability_version.trim().is_empty() {
            return Err(DomainError::InvalidEntity(
                "attempt provider metadata is required".into(),
            ));
        }
        if self.last_event_seq < 0 {
            return Err(DomainError::InvalidEntity(
                "last_event_seq must be non-negative".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CommandState {
    #[default]
    Pending,
    Executing,
    Succeeded,
    Failed,
    Unknown,
}

impl CommandState {
    pub const fn is_terminal(self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed | Self::Unknown)
    }

    pub const fn can_transition_to(self, next: Self) -> bool {
        matches!(
            (self, next),
            (Self::Pending, Self::Executing)
                | (Self::Executing, Self::Succeeded)
                | (Self::Executing, Self::Failed)
                | (Self::Executing, Self::Unknown)
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Command {
    pub id: EntityId,
    pub attempt_id: EntityId,
    pub kind: String,
    pub payload_hash: String,
    pub state: CommandState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Event {
    pub id: EntityId,
    pub attempt_id: EntityId,
    pub seq: i64,
    pub kind: String,
    pub payload_ref: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AccessMode {
    ReadOnly,
    #[default]
    Mutating,
    Unknown,
}

impl AccessMode {
    pub const fn is_mutating(self) -> bool {
        !matches!(self, Self::ReadOnly)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum LeaseState {
    #[default]
    Pending,
    Active,
    Releasing,
    Released,
    Uncertain,
}

impl LeaseState {
    pub const fn blocks_mutating_acquisition(self) -> bool {
        matches!(self, Self::Active | Self::Uncertain)
    }

    pub const fn can_transition_to(self, next: Self) -> bool {
        matches!(
            (self, next),
            (Self::Pending, Self::Active)
                | (Self::Pending, Self::Released)
                | (Self::Active, Self::Releasing)
                | (Self::Active, Self::Released)
                | (Self::Active, Self::Uncertain)
                | (Self::Uncertain, Self::Releasing)
                | (Self::Uncertain, Self::Released)
                | (Self::Releasing, Self::Released)
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceLease {
    pub workspace_key: String,
    pub attempt_id: EntityId,
    pub access_mode: AccessMode,
    pub state: LeaseState,
}

impl WorkspaceLease {
    pub fn new(
        workspace_key: impl AsRef<Path>,
        attempt_id: impl Into<String>,
        mode: AccessMode,
    ) -> Self {
        Self {
            workspace_key: normalize_workspace_key(workspace_key.as_ref()),
            attempt_id: attempt_id.into(),
            access_mode: mode,
            state: LeaseState::Pending,
        }
    }

    pub fn is_mutating(&self) -> bool {
        self.access_mode.is_mutating()
    }

    pub fn blocks_new_mutating(&self) -> bool {
        self.is_mutating() && self.state.blocks_mutating_acquisition()
    }

    pub fn transition(&mut self, next: LeaseState) -> Result<(), DomainError> {
        if self.state == next {
            return Ok(());
        }
        if !self.state.can_transition_to(next) {
            return Err(DomainError::InvalidLeaseTransition {
                from: self.state,
                to: next,
            });
        }
        self.state = next;
        Ok(())
    }

    pub fn conflicts_with(&self, other: &Self) -> bool {
        workspace_keys_overlap(&self.workspace_key, &other.workspace_key)
            && (self.is_mutating() || other.is_mutating())
            && self.state.blocks_mutating_acquisition()
            && other.state.blocks_mutating_acquisition()
    }
}

/// Normalizes the lexical form of a Windows workspace path without requiring it to exist.
/// Existing paths are canonicalized first, but failure to canonicalize is intentionally not an
/// error: a lease must also protect a workspace that is about to be created.
pub fn normalize_workspace_key(path: &Path) -> String {
    let raw = path.to_string_lossy();
    // On Unix test hosts a Windows-looking path is not a filesystem-relative path;
    // canonicalizing it would prepend the test checkout and break alias checks.
    let windows_form = raw.starts_with("\\\\") || raw.as_bytes().get(1) == Some(&b':');
    let candidate = if cfg!(windows) || !windows_form {
        std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
    } else {
        path.to_path_buf()
    };
    let mut value = candidate.to_string_lossy().replace('/', "\\");
    // Windows canonicalize may use the extended-length prefix while caller input
    // uses the ordinary DOS form. Strip only this syntactic prefix so aliases
    // cannot bypass the overlap check.
    if let Some(rest) = value.strip_prefix("\\\\?\\") {
        value = if let Some(unc) = rest.strip_prefix("UNC\\") {
            format!(r"\\{}", unc)
        } else {
            rest.to_owned()
        };
    }
    let mut value = lexical_windows_path(&value);
    if value.starts_with("\\\\") || value.as_bytes().get(1) == Some(&b':') {
        value = value.to_ascii_lowercase();
    }
    value
}

fn lexical_windows_path(value: &str) -> String {
    let (prefix, rest) = if value.starts_with("\\\\") {
        ("\\\\", value.trim_start_matches('\\'))
    } else if value.len() >= 3
        && value.as_bytes().get(1) == Some(&b':')
        && value.as_bytes().get(2) == Some(&b'\\')
    {
        (&value[..3], &value[3..])
    } else if value.starts_with('\\') {
        ("\\", value.trim_start_matches('\\'))
    } else {
        ("", value)
    };
    let mut parts = Vec::new();
    for part in rest.split('\\') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.last().is_some_and(|last| last != "..") {
                    parts.pop();
                } else if prefix.is_empty() {
                    parts.push("..".into());
                }
            }
            part => parts.push(part.to_owned()),
        }
    }
    let mut normalized = String::from(prefix);
    if !normalized.is_empty() && !normalized.ends_with('\\') && !parts.is_empty() {
        normalized.push('\\');
    }
    normalized.push_str(&parts.join("\\"));
    if normalized.is_empty() {
        ".".into()
    } else {
        normalized
    }
}

pub fn workspace_keys_overlap(left: &str, right: &str) -> bool {
    let left = normalize_workspace_key(Path::new(left));
    let right = normalize_workspace_key(Path::new(right));
    left == right || is_parent_key(&left, &right) || is_parent_key(&right, &left)
}

fn is_parent_key(parent: &str, child: &str) -> bool {
    child
        .strip_prefix(parent)
        .is_some_and(|rest| rest.starts_with('\\'))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DecisionState {
    #[default]
    Pending,
    Approved,
    Denied,
    Expired,
    Cancelled,
}

impl DecisionState {
    pub const fn is_terminal(self) -> bool {
        !matches!(self, Self::Pending)
    }

    pub const fn can_transition_to(self, next: Self) -> bool {
        matches!(
            (self, next),
            (Self::Pending, Self::Approved)
                | (Self::Pending, Self::Denied)
                | (Self::Pending, Self::Expired)
                | (Self::Pending, Self::Cancelled)
                | (Self::Approved, Self::Denied)
                | (Self::Approved, Self::Expired)
                | (Self::Approved, Self::Cancelled)
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Decision {
    pub id: EntityId,
    pub attempt_id: EntityId,
    pub kind: String,
    pub state: DecisionState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Verdict {
    #[default]
    Unassessed,
    Claimed,
    PartiallyVerified,
    Verified,
    Waived,
    Contested,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Evidence {
    pub id: EntityId,
    pub attempt_id: EntityId,
    pub claim: String,
    pub snapshot_hash: String,
    pub verdict: Verdict,
}

impl Evidence {
    pub fn is_stale_for(&self, current_snapshot_hash: &str) -> bool {
        self.snapshot_hash != current_snapshot_hash
    }

    pub fn effective_verdict(&self, current_snapshot_hash: &str) -> Verdict {
        if self.is_stale_for(current_snapshot_hash) {
            Verdict::Contested
        } else {
            self.verdict
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum OutboxState {
    #[default]
    Pending,
    Dispatching,
    Succeeded,
    Failed,
    Unknown,
}

impl OutboxState {
    pub const fn can_retry(self) -> bool {
        matches!(self, Self::Pending | Self::Failed)
    }

    pub const fn can_transition_to(self, next: Self) -> bool {
        matches!(
            (self, next),
            (Self::Pending, Self::Dispatching)
                | (Self::Pending, Self::Succeeded)
                | (Self::Pending, Self::Failed)
                | (Self::Pending, Self::Unknown)
                | (Self::Dispatching, Self::Succeeded)
                | (Self::Dispatching, Self::Failed)
                | (Self::Dispatching, Self::Unknown)
                | (Self::Failed, Self::Pending)
                | (Self::Failed, Self::Dispatching)
                | (Self::Failed, Self::Unknown)
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutboxIntent {
    pub id: EntityId,
    pub command_id: EntityId,
    pub effect_kind: String,
    pub target: String,
    pub state: OutboxState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AgentEventType {
    SessionCreated,
    TurnStarted,
    MessageDelta,
    ToolActivity,
    PermissionRequest,
    PermissionResponse,
    Waiting,
    TurnCompleted,
    TurnFailed,
    Cancelled,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentEventEnvelope {
    pub event_id: String,
    pub campaign_id: Option<String>,
    pub task_id: String,
    pub attempt_id: String,
    pub process_epoch_id: String,
    pub sequence: i64,
    pub occurred_at: String,
    pub received_at: String,
    pub provider_event_reference: Option<String>,
    pub event_type: AgentEventType,
    pub payload: serde_json::Value,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum DomainError {
    #[error("invalid Attempt transition from {from:?} to {to:?}")]
    InvalidAttemptTransition {
        from: AttemptState,
        to: AttemptState,
    },
    #[error("event sequence is out of order: expected {expected}, received {received}")]
    OutOfOrderEvent { expected: i64, received: i64 },
    #[error("attempt {0} is terminal and cannot be mutated")]
    TerminalAttemptMutation(String),
    #[error("invalid entity: {0}")]
    InvalidEntity(String),
    #[error("workspace lease conflict with {0}")]
    LeaseConflict(String),
    #[error("invalid WorkspaceLease transition from {from:?} to {to:?}")]
    InvalidLeaseTransition { from: LeaseState, to: LeaseState },
}

impl fmt::Display for AttemptState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let value = match self {
            Self::Queued => "QUEUED",
            Self::Active => "ACTIVE",
            Self::AwaitingReview => "AWAITING_REVIEW",
            Self::Closed => "CLOSED",
            Self::Failed => "FAILED",
            Self::Cancelled => "CANCELLED",
        };
        f.write_str(value)
    }
}

impl std::str::FromStr for AttemptState {
    type Err = DomainError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.to_ascii_uppercase().as_str() {
            "QUEUED" => Ok(Self::Queued),
            "ACTIVE" => Ok(Self::Active),
            "AWAITING_REVIEW" => Ok(Self::AwaitingReview),
            "CLOSED" => Ok(Self::Closed),
            "FAILED" => Ok(Self::Failed),
            "CANCELLED" | "CANCELED" => Ok(Self::Cancelled),
            _ => Err(DomainError::InvalidEntity(format!(
                "unknown Attempt state {value}"
            ))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attempt_state_machine_rejects_terminal_skip_and_allows_repair() {
        let mut attempt = Attempt::new("a", "t", "scenario", "cap-v1");
        assert!(attempt.transition(AttemptState::Closed).is_err());
        attempt.transition(AttemptState::Active).unwrap();
        attempt.transition(AttemptState::AwaitingReview).unwrap();
        attempt.transition(AttemptState::Active).unwrap();
        attempt.transition(AttemptState::AwaitingReview).unwrap();
        attempt.transition(AttemptState::Closed).unwrap();
        assert!(attempt.transition(AttemptState::Active).is_err());
    }

    #[test]
    fn unknown_access_is_mutating_and_overlapping_paths_conflict() {
        assert!(AccessMode::Unknown.is_mutating());
        assert!(workspace_keys_overlap(r"C:\work", r"c:/work\child"));
        assert!(workspace_keys_overlap(r"C:\work", r"C:\work\child\.."));
        assert!(workspace_keys_overlap(r"C:\work", r"\\?\C:\work\child"));
        assert!(workspace_keys_overlap(
            r"\\server\share",
            r"\\?\UNC\server\share\child"
        ));
        assert!(!workspace_keys_overlap(r"C:\work", r"C:\workshop"));
    }

    #[test]
    fn stale_evidence_never_remains_verified() {
        let evidence = Evidence {
            id: "e".into(),
            attempt_id: "a".into(),
            claim: "tests pass".into(),
            snapshot_hash: "old".into(),
            verdict: Verdict::Verified,
        };
        assert_eq!(evidence.effective_verdict("new"), Verdict::Contested);
        assert_eq!(evidence.effective_verdict("old"), Verdict::Verified);
    }

    #[test]
    fn uncertain_lease_can_only_be_released_explicitly() {
        let mut lease = WorkspaceLease::new(r"C:\work", "a", AccessMode::Mutating);
        lease.transition(LeaseState::Active).unwrap();
        lease.transition(LeaseState::Uncertain).unwrap();
        assert!(lease.transition(LeaseState::Active).is_err());
        lease.transition(LeaseState::Released).unwrap();
        assert_eq!(lease.state, LeaseState::Released);
    }
}
