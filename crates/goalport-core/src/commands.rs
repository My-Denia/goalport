//! The single command path for mutating the Core.

use crate::{
    domain::{AttemptState, Command, CommandState, Event, OutboxIntent, WorkspaceLease},
    store::{AppendEventOutcome, Store, StoreError},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum CoreOperation {
    TransitionAttempt {
        attempt_id: String,
        state: AttemptState,
        event_id: String,
    },
    AppendEvent {
        event: Event,
    },
    AcquireLease {
        lease: WorkspaceLease,
    },
    ReleaseLease {
        workspace_key: String,
        attempt_id: String,
        reason: String,
    },
    RevokeLease {
        workspace_key: String,
        attempt_id: String,
        reason: String,
    },
    MarkOutboxUnknown {
        outbox_id: String,
        reason: String,
    },
    ReconcileOutbox {
        outbox_id: String,
        state: crate::domain::OutboxState,
        evidence: String,
    },
}

impl CoreOperation {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::TransitionAttempt { .. } => "attempt.transition",
            Self::AppendEvent { .. } => "event.append",
            Self::AcquireLease { .. } => "lease.acquire",
            Self::ReleaseLease { .. } => "lease.release",
            Self::RevokeLease { .. } => "lease.revoke",
            Self::MarkOutboxUnknown { .. } => "outbox.mark_unknown",
            Self::ReconcileOutbox { .. } => "outbox.reconcile",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CoreCommand {
    pub command: Command,
    pub operation: CoreOperation,
}

impl CoreCommand {
    pub fn new(
        id: impl Into<String>,
        attempt_id: impl Into<String>,
        operation: CoreOperation,
    ) -> Result<Self, CommandError> {
        let attempt_id = attempt_id.into();
        let payload = serde_json::to_vec(&operation)?;
        Ok(Self {
            command: Command {
                id: id.into(),
                attempt_id,
                kind: operation.kind().into(),
                payload_hash: sha256_hex(&payload),
                state: CommandState::Pending,
            },
            operation,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommandExecution {
    pub command: Command,
    pub duplicate: bool,
    pub event: Option<Event>,
    pub lease: Option<WorkspaceLease>,
    pub outbox: Option<OutboxIntent>,
}

type OperationResult =
    Result<(Option<Event>, Option<WorkspaceLease>, Option<OutboxIntent>), CommandError>;

#[derive(Debug, Error)]
pub enum CommandError {
    #[error("store error: {0}")]
    Store(#[from] StoreError),
    #[error("serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("command operation is invalid: {0}")]
    Invalid(String),
}

#[derive(Clone, Debug)]
pub struct CommandProcessor {
    store: Store,
}

impl CommandProcessor {
    pub fn new(store: Store) -> Self {
        Self { store }
    }

    pub fn store(&self) -> &Store {
        &self.store
    }

    pub fn reconcile_after_restart(&self) -> Result<usize, CommandError> {
        self.store.rebuild_projections()?;
        Ok(self.store.mark_executing_commands_unknown()?)
    }

    /// Execute a command once. Reusing an id with the same payload returns the
    /// persisted result and performs no operation; reusing it with a different
    /// payload is rejected by the store.
    pub fn execute(&self, request: CoreCommand) -> Result<CommandExecution, CommandError> {
        let persisted = self.store.record_command(&request.command)?;
        if !matches!(persisted.state, CommandState::Pending) {
            return Ok(CommandExecution {
                command: persisted,
                duplicate: true,
                event: None,
                lease: None,
                outbox: None,
            });
        }
        self.store
            .update_command_state(&request.command.id, CommandState::Executing)?;
        let result = self.execute_operation(&request.operation);
        match result {
            Ok((event, lease, outbox)) => {
                let command = self
                    .store
                    .update_command_state(&request.command.id, CommandState::Succeeded)?;
                Ok(CommandExecution {
                    command,
                    duplicate: false,
                    event,
                    lease,
                    outbox,
                })
            }
            Err(error) => {
                // Preserve the original operation failure while recording that the
                // command did not succeed. A later command id may explicitly recover.
                let _ = self
                    .store
                    .update_command_state(&request.command.id, CommandState::Failed);
                Err(error)
            }
        }
    }

    fn execute_operation(&self, operation: &CoreOperation) -> OperationResult {
        match operation {
            CoreOperation::TransitionAttempt {
                attempt_id,
                state,
                event_id,
            } => {
                let attempt = self.store.get_attempt(attempt_id)?;
                let event = Event {
                    id: event_id.clone(),
                    attempt_id: attempt_id.clone(),
                    seq: attempt.last_event_seq + 1,
                    kind: format!("attempt.{}", state),
                    payload_ref: None,
                };
                let outcome = self
                    .store
                    .append_event_with_state(&event, Some(*state), None)?;
                let event = match outcome {
                    AppendEventOutcome::Inserted(event) | AppendEventOutcome::Duplicate(event) => {
                        event
                    }
                };
                Ok((Some(event), None, None))
            }
            CoreOperation::AppendEvent { event } => {
                let outcome = self.store.append_event(event)?;
                let event = match outcome {
                    AppendEventOutcome::Inserted(event) | AppendEventOutcome::Duplicate(event) => {
                        event
                    }
                };
                Ok((Some(event), None, None))
            }
            CoreOperation::AcquireLease { lease } => {
                Ok((None, Some(self.store.acquire_lease(lease)?), None))
            }
            CoreOperation::ReleaseLease {
                workspace_key,
                attempt_id,
                reason,
            } => {
                self.store
                    .release_lease(workspace_key, attempt_id, reason)?;
                Ok((None, None, None))
            }
            CoreOperation::RevokeLease {
                workspace_key,
                attempt_id,
                reason,
            } => {
                self.store.revoke_lease(workspace_key, attempt_id, reason)?;
                Ok((None, None, None))
            }
            CoreOperation::MarkOutboxUnknown { outbox_id, reason } => Ok((
                None,
                None,
                Some(self.store.mark_outbox_unknown(outbox_id, reason)?),
            )),
            CoreOperation::ReconcileOutbox {
                outbox_id,
                state,
                evidence,
            } => Ok((
                None,
                None,
                Some(self.store.reconcile_outbox(outbox_id, *state, evidence)?),
            )),
        }
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Convenience constructor used by IPC callers that already have a JSON payload.
pub fn command_for_payload(
    id: impl Into<String>,
    attempt_id: impl Into<String>,
    kind: impl Into<String>,
    payload: &[u8],
) -> Command {
    Command {
        id: id.into(),
        attempt_id: attempt_id.into(),
        kind: kind.into(),
        payload_hash: sha256_hex(payload),
        state: CommandState::Pending,
    }
}

#[allow(dead_code)]
fn _workspace_path(path: PathBuf) -> PathBuf {
    path
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{AccessMode, Attempt, LeaseState, OutboxState};

    #[test]
    fn command_id_is_idempotent_and_never_reexecutes_transition() {
        let store = Store::open_in_memory().unwrap();
        store
            .insert_attempt(&Attempt::new("a", "t", "scenario", "cap-v1"))
            .unwrap();
        let command = CoreCommand::new(
            "cmd-1",
            "a",
            CoreOperation::TransitionAttempt {
                attempt_id: "a".into(),
                state: AttemptState::Active,
                event_id: "e-1".into(),
            },
        )
        .unwrap();
        let processor = CommandProcessor::new(store.clone());
        let first = processor.execute(command.clone()).unwrap();
        let second = processor.execute(command).unwrap();
        assert!(!first.duplicate);
        assert!(second.duplicate);
        assert_eq!(store.list_events("a").unwrap().len(), 1);
        assert_eq!(store.get_attempt("a").unwrap().last_event_seq, 1);
    }

    #[test]
    fn lease_command_and_unknown_outbox_are_explicit() {
        let store = Store::open_in_memory().unwrap();
        let processor = CommandProcessor::new(store.clone());
        let lease = WorkspaceLease::new(r"C:\work", "a", AccessMode::Mutating);
        let command =
            CoreCommand::new("lease-cmd", "a", CoreOperation::AcquireLease { lease }).unwrap();
        let execution = processor.execute(command).unwrap();
        assert_eq!(execution.lease.unwrap().state, LeaseState::Active);
        let outbox = OutboxIntent {
            id: "o".into(),
            command_id: "external".into(),
            effect_kind: "publish".into(),
            target: "synthetic".into(),
            state: OutboxState::Pending,
        };
        store.insert_outbox(&outbox).unwrap();
        let unknown = CoreCommand::new(
            "unknown-cmd",
            "a",
            CoreOperation::MarkOutboxUnknown {
                outbox_id: "o".into(),
                reason: "ack missing".into(),
            },
        )
        .unwrap();
        assert_eq!(
            processor.execute(unknown).unwrap().outbox.unwrap().state,
            OutboxState::Unknown
        );
    }
}
