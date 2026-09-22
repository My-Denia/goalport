//! Durable single-writer SQLite store.
//!
//! The store is deliberately the only module that mutates the authoritative domain
//! projections.  Adapters produce events; callers submit commands and events here.

use crate::domain::{
    AccessMode, Attempt, AttemptState, Campaign, Command, CommandState, Decision, DecisionState,
    DomainError, Event, Evidence, LeaseState, OutboxIntent, OutboxState, Project, Task, Verdict,
    WorkspaceLease, workspace_keys_overlap,
};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    path::Path,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use thiserror::Error;

pub const SCHEMA_VERSION: i64 = 9;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("domain error: {0}")]
    Domain(#[from] DomainError),
    #[error("entity not found: {0}")]
    NotFound(String),
    #[error("duplicate identifier {0} has different content")]
    IdempotencyConflict(String),
    #[error(
        "event sequence conflict for attempt {attempt_id}: expected {expected}, received {received}"
    )]
    SequenceConflict {
        attempt_id: String,
        expected: i64,
        received: i64,
    },
    #[error("workspace lease conflict with attempt {0}")]
    LeaseConflict(String),
    #[error(
        "workspace is held by durable Stop responsibility for attempt {attempt_id} (operation {operation_id})"
    )]
    StopResponsibilityConflict {
        attempt_id: String,
        operation_id: String,
    },
    #[error("invalid persisted state: {0}")]
    InvalidState(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppendEventOutcome {
    Inserted(Event),
    Duplicate(Event),
}

#[derive(Clone)]
pub struct Store {
    inner: Arc<Mutex<Connection>>,
}

/// Descriptive alias for callers that want to make the SQLite boundary explicit.
pub type SqliteStore = Store;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CoreLaunchEpoch {
    pub epoch_id: String,
    pub launch_nonce: String,
    pub core_pid: i64,
    pub core_creation_date: String,
    pub core_executable_path: String,
    pub core_executable_sha256: String,
    pub previous_epoch_id: Option<String>,
    pub state: String,
    pub reconciliation: Option<Value>,
    pub created_at: String,
    pub activated_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeEpochBinding {
    pub attempt_id: String,
    pub campaign_id: String,
    pub task_id: String,
    pub provider: String,
    pub session_hash: String,
    pub process_epoch: String,
    pub runtime_pid: i64,
    pub runtime_creation_date: String,
    pub runtime_executable_path: String,
    pub runtime_executable_sha256: String,
    pub core_epoch_id: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StopNativeTurnState {
    Pending,
    Interrupted,
    Unconfirmed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StopResponsibility {
    pub attempt_id: String,
    pub operation_id: String,
    pub workspace_key: String,
    pub provider: String,
    pub binding: Value,
    pub native_turn_state: StopNativeTurnState,
    pub residual_execution_state: String,
    pub write_responsibility: String,
    pub detail: Option<Value>,
    pub created_at: String,
    pub updated_at: String,
}

/// What was observed about the bound residual runtime. Three-valued on purpose:
/// `observe_process` is already three-valued and its doc comment warns that callers
/// must not turn an unobservable process into proof that it ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RuntimeObservation {
    Live,
    NotRunning,
    Unknown,
}

impl RuntimeObservation {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Live => "live",
            Self::NotRunning => "not-running",
            Self::Unknown => "unknown",
        }
    }
}

/// The conclusion a single re-check is allowed to reach.
///
/// There is deliberately no `Quiescent` member. Interrupting a native turn does not
/// stop tools or descendants it already started, and this product has no way to prove
/// they stopped, so "everything has stopped" is not a conclusion the type system will
/// let a caller express. The SQLite CHECK on `stop_recheck_observations.verdict`
/// repeats the restriction at the storage layer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RecheckVerdict {
    /// The exact bound runtime is still running: pid, creation date and executable
    /// SHA-256 all matched.
    BoundRuntimeLive,
    /// The bound runtime is gone. Says nothing about its descendants, which is why
    /// the residual state stays unknown and the responsibility stays held.
    BoundRuntimeAbsentResidualStillUnknown,
    /// Nothing could be concluded: no identity was ever recorded, the observation
    /// failed, or the identity did not match. Never a safe conclusion.
    ObservationUnavailable,
}

impl RecheckVerdict {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::BoundRuntimeLive => "bound-runtime-live",
            Self::BoundRuntimeAbsentResidualStillUnknown => {
                "bound-runtime-absent-residual-still-unknown"
            }
            Self::ObservationUnavailable => "observation-unavailable",
        }
    }
}

/// One durable re-check. Written once, never updated.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StopRecheckObservation {
    pub seq: i64,
    pub id: String,
    pub attempt_id: String,
    pub operation_id: String,
    pub workspace_key: String,
    pub core_epoch_id: String,
    pub observed_at: String,
    pub bound_runtime: Value,
    pub runtime_observation: RuntimeObservation,
    pub observation_detail: Value,
    pub active_lease_count: i64,
    pub pending_outbox_count: i64,
    pub attempt_state: String,
    pub verdict: RecheckVerdict,
}

/// A re-check about to be recorded. `seq` is assigned by the store, not the caller.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewRecheckObservation {
    pub id: String,
    pub attempt_id: String,
    pub operation_id: String,
    pub workspace_key: String,
    pub core_epoch_id: String,
    pub bound_runtime: Value,
    pub runtime_observation: RuntimeObservation,
    pub observation_detail: Value,
    pub active_lease_count: i64,
    pub pending_outbox_count: i64,
    pub attempt_state: String,
    pub verdict: RecheckVerdict,
}

/// A recorded decision to continue the work in a non-overlapping workspace.
///
/// It is a record, not a grant: nothing in the enforcement path reads it. The
/// source responsibility keeps `write_responsibility='held'` and the source
/// workspace stays blocked exactly as before.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StopContinuation {
    pub id: String,
    pub source_attempt_id: String,
    pub source_operation_id: String,
    pub source_task_id: String,
    pub source_campaign_id: String,
    pub source_workspace_key: String,
    pub target_workspace_key: String,
    pub new_attempt_id: String,
    pub new_project_id: String,
    pub new_campaign_id: String,
    pub new_task_id: String,
    pub basis_observation_id: String,
    /// Exactly what was carried: `title`, `acceptance`, `goal`. Nothing from the
    /// runtime layer -- no session, no prompt, no permission decision.
    pub carried_context: Value,
    /// The full `CampaignAuthorization` triple the new campaign receives. Named in
    /// full because "grants provider authorization" while also enabling send and
    /// permission-Allow would be a partial truth about the one authorization
    /// surface a continuation creates.
    pub authorization_granted: Value,
    pub isolation_disclosure: Value,
    pub decided_at: String,
    pub applied_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BeginStopResponsibilityOutcome {
    pub responsibility: StopResponsibility,
    pub inserted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StopResponsibilityUpdate {
    pub attempt_id: String,
    pub operation_id: String,
    pub binding: Value,
    pub native_turn_state: StopNativeTurnState,
    pub residual_execution_state: String,
    pub detail: Option<Value>,
}

impl std::fmt::Debug for Store {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Store").finish_non_exhaustive()
    }
}

impl Store {
    pub fn new(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        Self::open(path)
    }

    pub fn memory() -> Result<Self, StoreError> {
        Self::open_in_memory()
    }

    pub fn open(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let connection = Connection::open(path)?;
        let store = Self {
            inner: Arc::new(Mutex::new(connection)),
        };
        store.migrate()?;
        Ok(store)
    }

    pub fn open_in_memory() -> Result<Self, StoreError> {
        let connection = Connection::open_in_memory()?;
        let store = Self {
            inner: Arc::new(Mutex::new(connection)),
        };
        store.migrate()?;
        Ok(store)
    }

    /// Apply all migrations. Every statement is idempotent and is run under the
    /// same connection lock as normal writes.
    pub fn migrate(&self) -> Result<(), StoreError> {
        let mut connection = self.inner.lock().expect("store mutex poisoned");
        // journal_mode is a connection property and SQLite does not allow changing
        // it from inside a transaction. The schema itself remains transactional.
        connection.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")?;
        let tx = connection.transaction()?;
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_migrations (
                 version INTEGER PRIMARY KEY,
                 applied_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS projects (
                 id TEXT PRIMARY KEY,
                 workspace_root TEXT NOT NULL,
                 version INTEGER NOT NULL DEFAULT 1
             );
             CREATE TABLE IF NOT EXISTS campaigns (
                 id TEXT PRIMARY KEY,
                 goal TEXT NOT NULL,
                 root_task_id TEXT NOT NULL,
                 state TEXT NOT NULL,
                 version INTEGER NOT NULL DEFAULT 1
             );
             CREATE TABLE IF NOT EXISTS campaign_projects (
                 campaign_id TEXT PRIMARY KEY,
                 project_id TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS tasks (
                 id TEXT PRIMARY KEY,
                 campaign_id TEXT NOT NULL,
                 title TEXT NOT NULL,
                 acceptance TEXT NOT NULL,
                 state TEXT NOT NULL,
                 version INTEGER NOT NULL DEFAULT 1
             );
             CREATE TABLE IF NOT EXISTS attempts (
                 id TEXT PRIMARY KEY,
                 task_id TEXT NOT NULL,
                 provider TEXT NOT NULL,
                 provider_session TEXT,
                 state TEXT NOT NULL,
                 last_event_seq INTEGER NOT NULL DEFAULT 0,
                 capability_version TEXT NOT NULL,
                 version INTEGER NOT NULL DEFAULT 1
             );
             CREATE TABLE IF NOT EXISTS commands (
                 id TEXT PRIMARY KEY,
                 attempt_id TEXT NOT NULL,
                 kind TEXT NOT NULL,
                 payload_hash TEXT NOT NULL,
                 state TEXT NOT NULL,
                 version INTEGER NOT NULL DEFAULT 1,
                 created_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS events (
                 id TEXT PRIMARY KEY,
                 attempt_id TEXT NOT NULL,
                 seq INTEGER NOT NULL,
                 kind TEXT NOT NULL,
                 payload_ref TEXT,
                 state_after TEXT,
                 payload_json TEXT,
                 created_at TEXT NOT NULL,
                 UNIQUE(attempt_id, seq)
             );
             CREATE TABLE IF NOT EXISTS workspace_leases (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 workspace_key TEXT NOT NULL,
                 attempt_id TEXT NOT NULL,
                 access_mode TEXT NOT NULL,
                 state TEXT NOT NULL,
                 acquired_at TEXT NOT NULL,
                 last_heartbeat TEXT NOT NULL,
                 release_reason TEXT
             );
             CREATE TABLE IF NOT EXISTS decisions (
                 id TEXT PRIMARY KEY,
                 attempt_id TEXT NOT NULL,
                 kind TEXT NOT NULL,
                 state TEXT NOT NULL,
                 version INTEGER NOT NULL DEFAULT 1
             );
             CREATE TABLE IF NOT EXISTS evidence (
                 id TEXT PRIMARY KEY,
                 attempt_id TEXT NOT NULL,
                 claim TEXT NOT NULL,
                 snapshot_hash TEXT NOT NULL,
                 verdict TEXT NOT NULL,
                 captured_at TEXT NOT NULL,
                 version INTEGER NOT NULL DEFAULT 1
             );
             CREATE TABLE IF NOT EXISTS outbox (
                 id TEXT PRIMARY KEY,
                 command_id TEXT NOT NULL UNIQUE,
                 effect_kind TEXT NOT NULL,
                 target TEXT NOT NULL,
                 state TEXT NOT NULL,
                 last_error TEXT,
                 created_at TEXT NOT NULL,
                 updated_at TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_events_attempt_seq ON events(attempt_id, seq);
             CREATE INDEX IF NOT EXISTS idx_leases_workspace_state ON workspace_leases(workspace_key, state);
             CREATE INDEX IF NOT EXISTS idx_outbox_state ON outbox(state);
             CREATE TABLE IF NOT EXISTS attempt_recovery (
                 attempt_id TEXT PRIMARY KEY,
                 provider TEXT NOT NULL,
                 session_hash TEXT,
                 process_epoch TEXT,
                 pid INTEGER,
                 last_seq INTEGER NOT NULL DEFAULT 0,
                 pending_permission_ids TEXT NOT NULL DEFAULT '[]',
                 outbox_ids TEXT NOT NULL DEFAULT '[]',
                 lease_workspace_key TEXT,
                 recovery_class TEXT,
                 prompt_replay INTEGER NOT NULL DEFAULT 0,
                 updated_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS policy_snapshots (
                 id TEXT PRIMARY KEY,
                 campaign_id TEXT NOT NULL,
                 payload_json TEXT NOT NULL,
                 created_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS campaign_authorizations (
                 campaign_id TEXT PRIMARY KEY,
                 provider_authorized INTEGER NOT NULL DEFAULT 1,
                 transfer_authorized INTEGER NOT NULL DEFAULT 1,
                 action_authorized INTEGER NOT NULL DEFAULT 1,
                 updated_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS admission_queue (
                 id TEXT PRIMARY KEY,
                 attempt_id TEXT,
                 reason TEXT NOT NULL,
                 override_reason TEXT,
                 created_at TEXT NOT NULL,
                 request_json TEXT
             );
             CREATE TABLE IF NOT EXISTS product_receipts (
                 id TEXT PRIMARY KEY,
                 kind TEXT NOT NULL,
                 launch_nonce TEXT,
                 receipt_id TEXT,
                 attempt_id TEXT,
                 payload_json TEXT NOT NULL,
                 created_at TEXT NOT NULL
             );
             CREATE UNIQUE INDEX IF NOT EXISTS idx_product_receipts_startup_nonce
                 ON product_receipts(kind, launch_nonce)
                 WHERE kind = 'startup' AND launch_nonce IS NOT NULL;
             CREATE UNIQUE INDEX IF NOT EXISTS idx_product_receipts_receipt_id
                 ON product_receipts(receipt_id)
                 WHERE receipt_id IS NOT NULL;
             CREATE TABLE IF NOT EXISTS core_launch_epochs (
                 epoch_id TEXT PRIMARY KEY,
                 launch_nonce TEXT NOT NULL UNIQUE,
                 core_pid INTEGER NOT NULL,
                 core_creation_date TEXT NOT NULL,
                 core_executable_path TEXT NOT NULL,
                 core_executable_sha256 TEXT NOT NULL,
                 previous_epoch_id TEXT,
                 state TEXT NOT NULL,
                 active_slot INTEGER,
                 reconciliation_json TEXT,
                 created_at TEXT NOT NULL,
                 activated_at TEXT
             );
             CREATE UNIQUE INDEX IF NOT EXISTS idx_core_launch_epochs_active_slot
                 ON core_launch_epochs(active_slot)
                 WHERE active_slot IS NOT NULL;
             CREATE TABLE IF NOT EXISTS runtime_epoch_bindings (
                 attempt_id TEXT NOT NULL,
                 campaign_id TEXT NOT NULL,
                 task_id TEXT NOT NULL,
                 provider TEXT NOT NULL,
                 session_hash TEXT NOT NULL,
                 process_epoch TEXT NOT NULL,
                 runtime_pid INTEGER NOT NULL,
                 runtime_creation_date TEXT NOT NULL,
                 runtime_executable_path TEXT NOT NULL,
                 runtime_executable_sha256 TEXT NOT NULL,
                 core_epoch_id TEXT NOT NULL,
                 created_at TEXT NOT NULL,
                 PRIMARY KEY(attempt_id, process_epoch)
             );
             CREATE TABLE IF NOT EXISTS stop_responsibilities (
                 attempt_id TEXT PRIMARY KEY,
                 operation_id TEXT NOT NULL UNIQUE,
                 workspace_key TEXT NOT NULL,
                 provider TEXT NOT NULL,
                 binding_json TEXT NOT NULL,
                 native_turn_state TEXT NOT NULL CHECK(native_turn_state IN ('pending','interrupted','unconfirmed')),
                 residual_execution_state TEXT NOT NULL CHECK(residual_execution_state IN ('unknown','active')),
                 write_responsibility TEXT NOT NULL CHECK(write_responsibility = 'held'),
                 detail_json TEXT,
                 created_at TEXT NOT NULL,
                 updated_at TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_stop_responsibilities_workspace
                 ON stop_responsibilities(workspace_key, write_responsibility);
             -- Schema v8, fact layer. Append-only: one row per re-check, never updated,
             -- never deleted, and never written by a user decision. A re-check reports
             -- what is observably true right now; it does not change responsibility.
             --
             -- `verdict` has no 'quiescent' member ON PURPOSE. This product cannot prove
             -- that arbitrary descendants of an interrupted turn have stopped, so the
             -- conclusion is made unrepresentable here rather than merely un-emitted by
             -- today's callers: SQLite rejects it even if a later caller tries to write it.
             --
             -- `seq` exists because now() is millisecond-resolution TEXT (see fn now), so
             -- two re-checks in the same millisecond tie on observed_at. seq is strictly
             -- increasing and never reused, which is what 'this observation is newer'
             -- actually needs.
             CREATE TABLE IF NOT EXISTS stop_recheck_observations (
                 seq INTEGER PRIMARY KEY AUTOINCREMENT,
                 id TEXT NOT NULL UNIQUE,
                 attempt_id TEXT NOT NULL,
                 operation_id TEXT NOT NULL,
                 workspace_key TEXT NOT NULL,
                 core_epoch_id TEXT NOT NULL,
                 observed_at TEXT NOT NULL,
                 bound_runtime_json TEXT NOT NULL,
                 runtime_observation TEXT NOT NULL
                     CHECK(runtime_observation IN ('live','not-running','unknown')),
                 observation_detail_json TEXT NOT NULL,
                 active_lease_count INTEGER NOT NULL,
                 pending_outbox_count INTEGER NOT NULL,
                 attempt_state TEXT NOT NULL,
                 verdict TEXT NOT NULL CHECK(verdict IN (
                     'bound-runtime-live',
                     'bound-runtime-absent-residual-still-unknown',
                     'observation-unavailable'))
             );
             CREATE INDEX IF NOT EXISTS idx_stop_recheck_attempt
                 ON stop_recheck_observations(attempt_id, seq);
             -- Schema v8, authorization layer. A recorded user DECISION to carry the
             -- work into a workspace that does not overlap the held one.
             --
             -- This table grants nothing. It appears in no enforcement predicate. The
             -- continuation works because a disjoint workspace was never blocked, not
             -- because anything here unblocks it, and the source responsibility stays
             -- held and untouched. Keeping the decision separate from the fact ledger
             -- and from the responsibility row is the point: 'the owner accepted a
             -- residual risk' and 'the residual stopped' must never share a label.
             --
             -- UNIQUE(source_attempt_id) plus applied_at make it single-use, so a
             -- repeat click, a GUI reopen or a Core restart cannot mint a second
             -- continuation from the same held responsibility.
             CREATE TABLE IF NOT EXISTS stop_continuations (
                 id TEXT PRIMARY KEY,
                 source_attempt_id TEXT NOT NULL,
                 source_operation_id TEXT NOT NULL,
                 source_task_id TEXT NOT NULL,
                 source_campaign_id TEXT NOT NULL,
                 source_workspace_key TEXT NOT NULL,
                 target_workspace_key TEXT NOT NULL,
                 new_attempt_id TEXT NOT NULL,
                 new_project_id TEXT NOT NULL,
                 new_campaign_id TEXT NOT NULL,
                 new_task_id TEXT NOT NULL,
                 basis_observation_id TEXT NOT NULL
                     REFERENCES stop_recheck_observations(id),
                 carried_context_json TEXT NOT NULL,
                 authorization_granted_json TEXT NOT NULL,
                 isolation_disclosure_json TEXT NOT NULL,
                 decided_at TEXT NOT NULL,
                 applied_at TEXT NOT NULL,
                 -- Single-use per SOURCE, not per (source, target).
                 --
                 -- Keying on the pair was tested against the real packaged GUI and did
                 -- not hold: the panel proposes a fresh timestamped sibling on every
                 -- click, so a second click was never the same pair, and quietly minted
                 -- a second workspace, a second campaign and a second three-flag
                 -- authorization grant. One held responsibility gets at most one
                 -- continuation.
                 UNIQUE(source_attempt_id)
             );
             CREATE INDEX IF NOT EXISTS idx_stop_continuations_source
                 ON stop_continuations(source_attempt_id);
             -- Schema v9, product-interaction layer (plan product-interaction-reset R2/R3).
             --
             -- product_event_order gives campaign-wide reading an order that is
             -- explicit, INTEGER-keyed and therefore stable across VACUUM, unlike the
             -- implicit events.rowid. Backfill runs once per database inside this
             -- migration transaction, ordered by the CURRENT rowid; the AFTER INSERT
             -- trigger allocates order_seq for every subsequent events insert in the
             -- same SQLite transaction as the insert itself. No existing event row is
             -- rewritten.
             CREATE TABLE IF NOT EXISTS product_event_order (
                 order_seq INTEGER PRIMARY KEY AUTOINCREMENT,
                 event_id TEXT UNIQUE NOT NULL
             );
             INSERT INTO product_event_order(event_id)
                 SELECT id FROM events WHERE id NOT IN (SELECT event_id FROM product_event_order)
                 ORDER BY rowid;
             CREATE TRIGGER IF NOT EXISTS trg_events_product_order_after_insert
                 AFTER INSERT ON events
                 BEGIN
                     INSERT INTO product_event_order(event_id) VALUES (NEW.id);
                 END;
             -- Per-campaign product preferences. selected_provider is the persisted
             -- Runtime preference: it survives terminal attempts, restarts and
             -- admission failures, and is never cleared by turn terminality. The
             -- backfill is deterministic and only fills absent rows: the last durable
             -- attempt by insertion rowid for the campaign (terminal or not); a
             -- campaign with no attempt keeps no row, which reads as state 'none'.
             CREATE TABLE IF NOT EXISTS conversation_preferences (
                 campaign_id TEXT PRIMARY KEY,
                 selected_provider TEXT,
                 title TEXT
             );
             INSERT INTO conversation_preferences(campaign_id, selected_provider)
                 SELECT t.campaign_id, (
                     SELECT a.provider FROM attempts a
                     JOIN tasks t2 ON t2.id = a.task_id
                     WHERE t2.campaign_id = t.campaign_id
                     ORDER BY a.rowid DESC LIMIT 1
                 )
                 FROM tasks t
                 GROUP BY t.campaign_id
                 ON CONFLICT(campaign_id) DO NOTHING;
             -- First-send / explicit-send orchestration ledger (R3 claim machine).
             -- request_id is the full request identity (PRIMARY KEY); payload_hash
             -- binds workspace/provider/prompt. claim_token is generated per
             -- invocation, inserted with the row and never returned to other
             -- callers: only the INSERT winner can move prepared->claimed.
             -- native_command_id is fixed at preparation and must equal the send
             -- command id the eventual native send records. phase is the claim
             -- machine: prepared -> claimed -> dispatching -> terminal
             -- (succeeded|failed|unknown). source_attempt_id names the cancelled
             -- source for a confirmed-stop successor; the partial UNIQUE index
             -- makes one source get at most one successor.
             CREATE TABLE IF NOT EXISTS conversation_requests (
                 request_id TEXT PRIMARY KEY,
                 payload_hash TEXT NOT NULL,
                 campaign_id TEXT NOT NULL,
                 task_id TEXT NOT NULL,
                 attempt_id TEXT NOT NULL,
                 phase TEXT NOT NULL CHECK(phase IN
                     ('prepared','claimed','dispatching','succeeded','failed','unknown')),
                 claim_token TEXT NOT NULL,
                 native_command_id TEXT NOT NULL UNIQUE,
                 result_json TEXT,
                 source_attempt_id TEXT,
                 created_at TEXT NOT NULL,
                 updated_at TEXT NOT NULL
             );
             CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_requests_source
                 ON conversation_requests(source_attempt_id)
                 WHERE source_attempt_id IS NOT NULL;",
        )?;
        tx.execute(
            "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, ?1)",
            params![now()],
        )?;
        tx.execute(
            "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?1, ?2)",
            params![SCHEMA_VERSION, now()],
        )?;
        ensure_admission_request_json(&tx)?;
        ensure_command_result_json(&tx)?;
        tx.commit()?;
        Ok(())
    }

    pub fn schema_version(&self) -> Result<i64, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        Ok(connection.query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
            [],
            |row| row.get(0),
        )?)
    }

    pub fn put_product_receipt(
        &self,
        id: &str,
        kind: &str,
        launch_nonce: Option<&str>,
        receipt_id: Option<&str>,
        attempt_id: Option<&str>,
        payload: &Value,
    ) -> Result<(), StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        connection.execute(
            "INSERT INTO product_receipts(id, kind, launch_nonce, receipt_id, attempt_id, payload_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(id) DO UPDATE SET
               payload_json=excluded.payload_json,
               created_at=excluded.created_at",
            params![
                id,
                kind,
                launch_nonce,
                receipt_id,
                attempt_id,
                serde_json::to_string(payload)?,
                utc_now_iso()
            ],
        )?;
        Ok(())
    }

    pub fn get_product_receipt_by_nonce(
        &self,
        kind: &str,
        launch_nonce: &str,
    ) -> Result<Option<Value>, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        let json: Option<String> = connection
            .query_row(
                "SELECT payload_json FROM product_receipts WHERE kind=?1 AND launch_nonce=?2 ORDER BY created_at DESC LIMIT 1",
                params![kind, launch_nonce],
                |row| row.get(0),
            )
            .optional()?;
        json.map(|raw| serde_json::from_str(&raw))
            .transpose()
            .map_err(StoreError::from)
    }

    pub fn get_product_receipt_by_receipt_id(
        &self,
        receipt_id: &str,
    ) -> Result<Option<Value>, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        let json: Option<String> = connection
            .query_row(
                "SELECT payload_json FROM product_receipts WHERE receipt_id=?1 LIMIT 1",
                params![receipt_id],
                |row| row.get(0),
            )
            .optional()?;
        json.map(|raw| serde_json::from_str(&raw))
            .transpose()
            .map_err(StoreError::from)
    }

    pub fn get_product_receipt_by_id(&self, id: &str) -> Result<Option<Value>, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        let json: Option<String> = connection
            .query_row(
                "SELECT payload_json FROM product_receipts WHERE id=?1 LIMIT 1",
                params![id],
                |row| row.get(0),
            )
            .optional()?;
        json.map(|raw| serde_json::from_str(&raw))
            .transpose()
            .map_err(StoreError::from)
    }

    pub fn latest_product_receipt(&self, kind: &str) -> Result<Option<Value>, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        let json: Option<String> = connection
            .query_row(
                "SELECT payload_json FROM product_receipts WHERE kind=?1 ORDER BY created_at DESC LIMIT 1",
                params![kind],
                |row| row.get(0),
            )
            .optional()?;
        json.map(|raw| serde_json::from_str(&raw))
            .transpose()
            .map_err(StoreError::from)
    }

    pub fn latest_core_launch_epoch(&self) -> Result<Option<CoreLaunchEpoch>, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        connection
            .query_row(
                "SELECT epoch_id, launch_nonce, core_pid, core_creation_date,
                        core_executable_path, core_executable_sha256, previous_epoch_id,
                        state, reconciliation_json, created_at, activated_at
                 FROM core_launch_epochs ORDER BY rowid DESC LIMIT 1",
                [],
                core_launch_epoch_from_row,
            )
            .optional()
            .map_err(StoreError::from)
    }

    pub fn list_core_launch_epochs(&self) -> Result<Vec<CoreLaunchEpoch>, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        let mut statement = connection.prepare(
            "SELECT epoch_id, launch_nonce, core_pid, core_creation_date,
                    core_executable_path, core_executable_sha256, previous_epoch_id,
                    state, reconciliation_json, created_at, activated_at
             FROM core_launch_epochs ORDER BY rowid",
        )?;
        let rows = statement.query_map([], core_launch_epoch_from_row)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn put_runtime_epoch_binding(
        &self,
        binding: &RuntimeEpochBinding,
    ) -> Result<(), StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        connection.execute(
            "INSERT OR IGNORE INTO runtime_epoch_bindings(
                 attempt_id, campaign_id, task_id, provider, session_hash, process_epoch,
                 runtime_pid, runtime_creation_date, runtime_executable_path,
                 runtime_executable_sha256, core_epoch_id, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                binding.attempt_id,
                binding.campaign_id,
                binding.task_id,
                binding.provider,
                binding.session_hash,
                binding.process_epoch,
                binding.runtime_pid,
                binding.runtime_creation_date,
                binding.runtime_executable_path,
                binding.runtime_executable_sha256,
                binding.core_epoch_id,
                binding.created_at,
            ],
        )?;
        let existing = connection.query_row(
            "SELECT attempt_id, campaign_id, task_id, provider, session_hash, process_epoch,
                    runtime_pid, runtime_creation_date, runtime_executable_path,
                    runtime_executable_sha256, core_epoch_id, created_at
             FROM runtime_epoch_bindings WHERE attempt_id=?1 AND process_epoch=?2",
            params![binding.attempt_id, binding.process_epoch],
            runtime_epoch_binding_from_row,
        )?;
        if existing.attempt_id != binding.attempt_id
            || existing.campaign_id != binding.campaign_id
            || existing.task_id != binding.task_id
            || existing.provider != binding.provider
            || existing.session_hash != binding.session_hash
            || existing.process_epoch != binding.process_epoch
            || existing.runtime_pid != binding.runtime_pid
            || existing.runtime_creation_date != binding.runtime_creation_date
            || existing.runtime_executable_path != binding.runtime_executable_path
            || existing.runtime_executable_sha256 != binding.runtime_executable_sha256
            || existing.core_epoch_id != binding.core_epoch_id
        {
            return Err(StoreError::IdempotencyConflict(format!(
                "runtime-epoch:{}:{}",
                binding.attempt_id, binding.process_epoch
            )));
        }
        Ok(())
    }

    pub fn runtime_epoch_bindings(
        &self,
        attempt_id: &str,
    ) -> Result<Vec<RuntimeEpochBinding>, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        let mut statement = connection.prepare(
            "SELECT attempt_id, campaign_id, task_id, provider, session_hash, process_epoch,
                    runtime_pid, runtime_creation_date, runtime_executable_path,
                    runtime_executable_sha256, core_epoch_id, created_at
             FROM runtime_epoch_bindings WHERE attempt_id=?1 ORDER BY created_at, process_epoch",
        )?;
        let rows = statement.query_map(params![attempt_id], runtime_epoch_binding_from_row)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Atomically claims the singleton live Core slot. The caller must first
    /// classify the exact prior process identity; this compare-and-swap closes
    /// the gap between that observation and a competing SQLite connection.
    pub fn claim_core_launch_epoch(
        &self,
        epoch: &CoreLaunchEpoch,
        expected_previous_epoch_id: Option<&str>,
        expected_legacy_nonce: Option<&str>,
    ) -> Result<bool, StoreError> {
        let mut connection = self.inner.lock().expect("store mutex poisoned");
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let actual_previous: Option<String> = tx
            .query_row(
                "SELECT epoch_id FROM core_launch_epochs ORDER BY rowid DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .optional()?;
        if actual_previous.as_deref() != expected_previous_epoch_id {
            tx.rollback()?;
            return Ok(false);
        }
        if actual_previous.is_none() {
            let actual_legacy_nonce: Option<String> = tx
                .query_row(
                    "SELECT launch_nonce FROM product_receipts
                     WHERE kind='startup' ORDER BY created_at DESC, rowid DESC LIMIT 1",
                    [],
                    |row| row.get(0),
                )
                .optional()?
                .flatten();
            if actual_legacy_nonce.as_deref() != expected_legacy_nonce {
                tx.rollback()?;
                return Ok(false);
            }
        }
        if let Some(previous) = actual_previous.as_deref() {
            tx.execute(
                "UPDATE core_launch_epochs
                 SET state=CASE WHEN state IN ('ACTIVE','READY_COMMITTED') THEN 'ENDED' ELSE state END,
                     active_slot=NULL
                 WHERE epoch_id=?1",
                params![previous],
            )?;
        }
        tx.execute(
            "INSERT INTO core_launch_epochs(
                 epoch_id, launch_nonce, core_pid, core_creation_date,
                 core_executable_path, core_executable_sha256, previous_epoch_id,
                 state, active_slot, reconciliation_json, created_at, activated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'RECONCILING', 1, NULL, ?8, NULL)",
            params![
                epoch.epoch_id,
                epoch.launch_nonce,
                epoch.core_pid,
                epoch.core_creation_date,
                epoch.core_executable_path,
                epoch.core_executable_sha256,
                epoch.previous_epoch_id,
                epoch.created_at,
            ],
        )?;
        tx.commit()?;
        Ok(true)
    }

    pub fn stage_core_launch_startup(
        &self,
        epoch_id: &str,
        launch_nonce: &str,
        reconciliation: &Value,
        startup_pending: &Value,
        startup_receipt_id: &str,
    ) -> Result<(), StoreError> {
        let mut connection = self.inner.lock().expect("store mutex poisoned");
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let staged_at = utc_now_iso();
        let changed = tx.execute(
            "UPDATE core_launch_epochs
             SET state='STARTUP_PENDING', reconciliation_json=?1
             WHERE epoch_id=?3 AND launch_nonce=?4 AND state='RECONCILING' AND active_slot=1",
            params![
                serde_json::to_string(reconciliation)?,
                staged_at,
                epoch_id,
                launch_nonce
            ],
        )?;
        if changed != 1 {
            return Err(StoreError::InvalidState(format!(
                "Core launch epoch {epoch_id} is not available for STARTUP_PENDING"
            )));
        }
        tx.execute(
            "INSERT INTO product_receipts(
                 id, kind, launch_nonce, receipt_id, attempt_id, payload_json, created_at
             ) VALUES (?1, 'startup', ?2, ?3, NULL, ?4, ?5)",
            params![
                format!("startup:{launch_nonce}"),
                launch_nonce,
                startup_receipt_id,
                serde_json::to_string(startup_pending)?,
                staged_at,
            ],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn commit_core_launch_ready(
        &self,
        epoch_id: &str,
        launch_nonce: &str,
        startup_committed: &Value,
        ready_committed: &Value,
        ready_receipt_id: &str,
        ready_at: &str,
    ) -> Result<(), StoreError> {
        let mut connection = self.inner.lock().expect("store mutex poisoned");
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let changed = tx.execute(
            "UPDATE core_launch_epochs
             SET state='READY_COMMITTED', activated_at=?1
             WHERE epoch_id=?2 AND launch_nonce=?3 AND state='STARTUP_PENDING' AND active_slot=1",
            params![ready_at, epoch_id, launch_nonce],
        )?;
        if changed != 1 {
            return Err(StoreError::InvalidState(format!(
                "Core launch epoch {epoch_id} is not STARTUP_PENDING"
            )));
        }
        let changed = tx.execute(
            "UPDATE product_receipts SET payload_json=?1
             WHERE id=?2 AND kind='startup' AND launch_nonce=?3",
            params![
                serde_json::to_string(startup_committed)?,
                format!("startup:{launch_nonce}"),
                launch_nonce
            ],
        )?;
        if changed != 1 {
            return Err(StoreError::InvalidState(format!(
                "Core launch epoch {epoch_id} has no STARTUP_PENDING receipt"
            )));
        }
        tx.execute(
            "INSERT INTO product_receipts(
                 id, kind, launch_nonce, receipt_id, attempt_id, payload_json, created_at
             ) VALUES (?1, 'launch-ready', ?2, ?3, NULL, ?4, ?5)",
            params![
                format!("launch-ready:{launch_nonce}"),
                launch_nonce,
                ready_receipt_id,
                serde_json::to_string(ready_committed)?,
                ready_at,
            ],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn abort_core_launch_epoch(
        &self,
        epoch_id: &str,
        launch_nonce: &str,
        reason: &Value,
        startup_aborted: Option<&Value>,
        ready_aborted: Option<&Value>,
    ) -> Result<(), StoreError> {
        let mut connection = self.inner.lock().expect("store mutex poisoned");
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute(
            "UPDATE core_launch_epochs
             SET state='ABORTED', active_slot=NULL, reconciliation_json=?1
             WHERE epoch_id=?2 AND launch_nonce=?3 AND state IN ('RECONCILING','STARTUP_PENDING','READY_COMMITTED')",
            params![serde_json::to_string(reason)?, epoch_id, launch_nonce],
        )?;
        if let Some(payload) = startup_aborted {
            tx.execute(
                "UPDATE product_receipts SET payload_json=?1
                 WHERE id=?2 AND kind='startup' AND launch_nonce=?3",
                params![
                    serde_json::to_string(payload)?,
                    format!("startup:{launch_nonce}"),
                    launch_nonce
                ],
            )?;
        }
        if let Some(payload) = ready_aborted {
            tx.execute(
                "UPDATE product_receipts SET payload_json=?1
                 WHERE id=?2 AND kind='launch-ready' AND launch_nonce=?3",
                params![
                    serde_json::to_string(payload)?,
                    format!("launch-ready:{launch_nonce}"),
                    launch_nonce
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn insert_project(&self, project: &Project) -> Result<(), StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        insert_or_conflict(
            &connection,
            "SELECT workspace_root FROM projects WHERE id=?1",
            params![project.id],
            &project.id,
            |row| {
                row.get::<_, String>(0)
                    .is_ok_and(|value| value == project.workspace_root)
            },
            "INSERT INTO projects(id, workspace_root) VALUES (?1, ?2)",
            params![project.id, project.workspace_root],
        )
    }

    pub fn get_project(&self, id: &str) -> Result<Project, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        connection
            .query_row(
                "SELECT workspace_root FROM projects WHERE id=?1",
                params![id],
                |row| {
                    Ok(Project {
                        id: id.into(),
                        workspace_root: row.get(0)?,
                    })
                },
            )
            .optional()?
            .ok_or_else(|| StoreError::NotFound(format!("project {id}")))
    }

    /// Return projects in stable insertion order. The Core projection uses this
    /// list to populate the project switcher; hosts never invent project ids.
    pub fn list_projects(&self) -> Result<Vec<Project>, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        let mut statement =
            connection.prepare("SELECT id, workspace_root FROM projects ORDER BY rowid, id")?;
        let rows = statement.query_map([], |row| {
            Ok(Project {
                id: row.get(0)?,
                workspace_root: row.get(1)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn insert_campaign(&self, campaign: &Campaign) -> Result<(), StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        insert_or_conflict(
            &connection,
            "SELECT goal, root_task_id, state FROM campaigns WHERE id=?1",
            params![campaign.id],
            &campaign.id,
            |row| {
                row.get::<_, String>(0)
                    .is_ok_and(|value| value == campaign.goal)
                    && row
                        .get::<_, String>(1)
                        .is_ok_and(|value| value == campaign.root_task_id)
                    && row
                        .get::<_, String>(2)
                        .is_ok_and(|value| value == work_status_string(campaign.state))
            },
            "INSERT INTO campaigns(id, goal, root_task_id, state) VALUES (?1, ?2, ?3, ?4)",
            params![
                campaign.id,
                campaign.goal,
                campaign.root_task_id,
                work_status_string(campaign.state)
            ],
        )
    }

    pub fn get_campaign(&self, id: &str) -> Result<Campaign, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        connection
            .query_row(
                "SELECT goal, root_task_id, state FROM campaigns WHERE id=?1",
                params![id],
                |row| {
                    Ok(Campaign {
                        id: id.into(),
                        goal: row.get(0)?,
                        root_task_id: row.get(1)?,
                        state: parse_work_status(&row.get::<_, String>(2)?)
                            .map_err(to_sql_error)?,
                    })
                },
            )
            .optional()?
            .ok_or_else(|| StoreError::NotFound(format!("campaign {id}")))
    }

    pub fn list_campaigns(&self) -> Result<Vec<Campaign>, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        let mut statement = connection
            .prepare("SELECT id, goal, root_task_id, state FROM campaigns ORDER BY rowid, id")?;
        let rows = statement.query_map([], |row| {
            Ok(Campaign {
                id: row.get(0)?,
                goal: row.get(1)?,
                root_task_id: row.get(2)?,
                state: parse_work_status(&row.get::<_, String>(3)?).map_err(to_sql_error)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn campaign_project(&self, campaign_id: &str) -> Result<Option<String>, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        Ok(connection
            .query_row(
                "SELECT project_id FROM campaign_projects WHERE campaign_id=?1",
                params![campaign_id],
                |row| row.get(0),
            )
            .optional()?)
    }

    pub fn campaigns_for_project(&self, project_id: &str) -> Result<Vec<Campaign>, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        let mut statement = connection.prepare(
            "SELECT c.id, c.goal, c.root_task_id, c.state
             FROM campaigns c
             INNER JOIN campaign_projects cp ON cp.campaign_id=c.id
             WHERE cp.project_id=?1 ORDER BY c.rowid, c.id",
        )?;
        let rows = statement.query_map(params![project_id], |row| {
            Ok(Campaign {
                id: row.get(0)?,
                goal: row.get(1)?,
                root_task_id: row.get(2)?,
                state: parse_work_status(&row.get::<_, String>(3)?).map_err(to_sql_error)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn insert_task(&self, task: &Task) -> Result<(), StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        insert_or_conflict(
            &connection,
            "SELECT campaign_id, title, acceptance, state FROM tasks WHERE id=?1",
            params![task.id],
            &task.id,
            |row| {
                row.get::<_, String>(0)
                    .is_ok_and(|value| value == task.campaign_id)
                    && row
                        .get::<_, String>(1)
                        .is_ok_and(|value| value == task.title)
                    && row
                        .get::<_, String>(2)
                        .is_ok_and(|value| value == task.acceptance)
                    && row
                        .get::<_, String>(3)
                        .is_ok_and(|value| value == work_status_string(task.state))
            },
            "INSERT INTO tasks(id, campaign_id, title, acceptance, state) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                task.id,
                task.campaign_id,
                task.title,
                task.acceptance,
                work_status_string(task.state)
            ],
        )
    }

    pub fn get_task(&self, id: &str) -> Result<Task, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        connection
            .query_row(
                "SELECT campaign_id, title, acceptance, state FROM tasks WHERE id=?1",
                params![id],
                |row| {
                    Ok(Task {
                        id: id.into(),
                        campaign_id: row.get(0)?,
                        title: row.get(1)?,
                        acceptance: row.get(2)?,
                        state: parse_work_status(&row.get::<_, String>(3)?)
                            .map_err(to_sql_error)?,
                    })
                },
            )
            .optional()?
            .ok_or_else(|| StoreError::NotFound(format!("task {id}")))
    }

    pub fn list_tasks(&self) -> Result<Vec<Task>, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        let mut statement = connection.prepare(
            "SELECT id, campaign_id, title, acceptance, state FROM tasks ORDER BY rowid, id",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(Task {
                id: row.get(0)?,
                campaign_id: row.get(1)?,
                title: row.get(2)?,
                acceptance: row.get(3)?,
                state: parse_work_status(&row.get::<_, String>(4)?).map_err(to_sql_error)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn tasks_for_campaign(&self, campaign_id: &str) -> Result<Vec<Task>, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        let mut statement = connection.prepare(
            "SELECT id, campaign_id, title, acceptance, state FROM tasks
             WHERE campaign_id=?1 ORDER BY rowid, id",
        )?;
        let rows = statement.query_map(params![campaign_id], |row| {
            Ok(Task {
                id: row.get(0)?,
                campaign_id: row.get(1)?,
                title: row.get(2)?,
                acceptance: row.get(3)?,
                state: parse_work_status(&row.get::<_, String>(4)?).map_err(to_sql_error)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn insert_attempt(&self, attempt: &Attempt) -> Result<(), StoreError> {
        attempt.validate()?;
        let connection = self.inner.lock().expect("store mutex poisoned");
        let existing = connection
            .query_row(
                "SELECT task_id, provider, provider_session, state, last_event_seq, capability_version FROM attempts WHERE id=?1",
                params![attempt.id],
                attempt_from_row,
            )
            .optional()?
            .map(|mut found| {
                found.id = attempt.id.clone();
                found
            });
        if let Some(found) = existing {
            if found == *attempt {
                return Ok(());
            }
            return Err(StoreError::IdempotencyConflict(attempt.id.clone()));
        }
        connection.execute(
            "INSERT INTO attempts(id, task_id, provider, provider_session, state, last_event_seq, capability_version) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                attempt.id,
                attempt.task_id,
                attempt.provider,
                attempt.provider_session,
                attempt_state_string(attempt.state),
                attempt.last_event_seq,
                attempt.capability_version
            ],
        )?;
        Ok(())
    }

    /// Insert a new rollover Attempt together with the event that establishes
    /// its source lineage. Existing rows are refused rather than repaired: this
    /// operation is only for a newly-created successor, never for historical
    /// backfill. The Attempt cannot become visible without its lineage event.
    pub fn insert_rollover_attempt(
        &self,
        attempt: &Attempt,
        rolled_from: &str,
    ) -> Result<(), StoreError> {
        attempt.validate()?;
        if attempt.state != AttemptState::Queued
            || attempt.last_event_seq != 0
            || attempt.provider_session.is_some()
        {
            return Err(StoreError::InvalidState(
                "a rollover Attempt must be a new queued row with no events or provider session"
                    .into(),
            ));
        }
        let rolled_from = rolled_from.trim();
        if rolled_from.is_empty() || rolled_from == attempt.id {
            return Err(StoreError::InvalidState(
                "rollover source must name a distinct Attempt".into(),
            ));
        }
        let payload_json = serde_json::to_string(&serde_json::json!({
            "provider": attempt.provider,
            "rolledFrom": rolled_from,
        }))?;
        let event_id = format!("core-event-{}-1", attempt.id);
        let mut connection = self.inner.lock().expect("store mutex poisoned");
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;

        let source_task_id: String = tx
            .query_row(
                "SELECT task_id FROM attempts WHERE id=?1",
                params![rolled_from],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| StoreError::NotFound(format!("attempt {rolled_from}")))?;
        if source_task_id != attempt.task_id {
            return Err(StoreError::InvalidState(format!(
                "rollover source {rolled_from} must belong to task {}",
                attempt.task_id
            )));
        }
        let existing: Option<i64> = tx
            .query_row(
                "SELECT 1 FROM attempts WHERE id=?1",
                params![attempt.id],
                |row| row.get(0),
            )
            .optional()?;
        if existing.is_some() {
            return Err(StoreError::IdempotencyConflict(attempt.id.clone()));
        }

        tx.execute(
            "INSERT INTO attempts(id, task_id, provider, provider_session, state, last_event_seq, capability_version) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                attempt.id,
                attempt.task_id,
                attempt.provider,
                attempt.provider_session,
                attempt_state_string(attempt.state),
                attempt.last_event_seq,
                attempt.capability_version
            ],
        )?;
        tx.execute(
            "INSERT INTO events(id, attempt_id, seq, kind, payload_ref, state_after, payload_json, created_at) VALUES (?1, ?2, 1, 'attempt.created', NULL, NULL, ?3, ?4)",
            params![event_id, attempt.id, payload_json, now()],
        )?;
        tx.execute(
            "UPDATE attempts SET last_event_seq=1, version=version+1 WHERE id=?1",
            params![attempt.id],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn get_attempt(&self, id: &str) -> Result<Attempt, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        connection
            .query_row(
                "SELECT task_id, provider, provider_session, state, last_event_seq, capability_version FROM attempts WHERE id=?1",
                params![id],
                |row| attempt_from_row_with_id(row, id),
            )
            .optional()?
            .ok_or_else(|| StoreError::NotFound(format!("attempt {id}")))
    }

    pub fn set_attempt_provider_session(
        &self,
        id: &str,
        session_id: &str,
    ) -> Result<Attempt, StoreError> {
        if session_id.trim().is_empty() {
            return Err(StoreError::InvalidState(
                "provider session id is empty".into(),
            ));
        }
        let connection = self.inner.lock().expect("store mutex poisoned");
        let changed = connection.execute(
            "UPDATE attempts SET provider_session=?1, version=version+1 WHERE id=?2 AND state NOT IN ('CLOSED','FAILED','CANCELLED')",
            params![session_id, id],
        )?;
        if changed == 0 {
            return Err(StoreError::NotFound(format!("active attempt {id}")));
        }
        connection
            .query_row(
                "SELECT task_id, provider, provider_session, state, last_event_seq, capability_version FROM attempts WHERE id=?1",
                params![id],
                |row| attempt_from_row_with_id(row, id),
            )
            .map_err(StoreError::from)
    }

    pub fn list_attempts(&self) -> Result<Vec<Attempt>, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        let mut statement = connection.prepare(
            "SELECT id, task_id, provider, provider_session, state, last_event_seq, capability_version
             FROM attempts ORDER BY rowid, id",
        )?;
        let rows = statement.query_map([], |row| {
            let id: String = row.get(0)?;
            Ok(Attempt {
                id,
                task_id: row.get(1)?,
                provider: row.get(2)?,
                provider_session: row.get(3)?,
                state: parse_attempt_state(&row.get::<_, String>(4)?).map_err(to_sql_error)?,
                last_event_seq: row.get(5)?,
                capability_version: row.get(6)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn attempts_for_task(&self, task_id: &str) -> Result<Vec<Attempt>, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        let mut statement = connection.prepare(
            "SELECT id, task_id, provider, provider_session, state, last_event_seq, capability_version
             FROM attempts WHERE task_id=?1 ORDER BY rowid, id",
        )?;
        let rows = statement.query_map(params![task_id], |row| {
            let id: String = row.get(0)?;
            Ok(Attempt {
                id,
                task_id: row.get(1)?,
                provider: row.get(2)?,
                provider_session: row.get(3)?,
                state: parse_attempt_state(&row.get::<_, String>(4)?).map_err(to_sql_error)?,
                last_event_seq: row.get(5)?,
                capability_version: row.get(6)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Create the Campaign and its root Task in one SQLite transaction. The
    /// project association is committed with the same transaction so a host
    /// can never observe a half-created task tree.
    pub fn create_campaign_with_task(
        &self,
        project_id: &str,
        campaign: &Campaign,
        task: &Task,
    ) -> Result<(), StoreError> {
        if campaign.root_task_id != task.id || task.campaign_id != campaign.id {
            return Err(StoreError::InvalidState(
                "campaign root_task_id and task campaign_id must agree".into(),
            ));
        }
        let mut connection = self.inner.lock().expect("store mutex poisoned");
        let tx = connection.transaction()?;
        let project_exists: Option<String> = tx
            .query_row(
                "SELECT id FROM projects WHERE id=?1",
                params![project_id],
                |row| row.get(0),
            )
            .optional()?;
        if project_exists.is_none() {
            return Err(StoreError::NotFound(format!("project {project_id}")));
        }
        let campaign_existing: Option<(String, String, String)> = tx
            .query_row(
                "SELECT goal, root_task_id, state FROM campaigns WHERE id=?1",
                params![campaign.id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        if let Some((goal, root_task_id, state)) = campaign_existing {
            if goal != campaign.goal
                || root_task_id != campaign.root_task_id
                || state != work_status_string(campaign.state)
            {
                return Err(StoreError::IdempotencyConflict(campaign.id.clone()));
            }
        } else {
            tx.execute(
                "INSERT INTO campaigns(id, goal, root_task_id, state) VALUES (?1, ?2, ?3, ?4)",
                params![
                    campaign.id,
                    campaign.goal,
                    campaign.root_task_id,
                    work_status_string(campaign.state)
                ],
            )?;
        }
        let task_existing: Option<(String, String, String, String)> = tx
            .query_row(
                "SELECT campaign_id, title, acceptance, state FROM tasks WHERE id=?1",
                params![task.id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        if let Some((campaign_id, title, acceptance, state)) = task_existing {
            if campaign_id != task.campaign_id
                || title != task.title
                || acceptance != task.acceptance
                || state != work_status_string(task.state)
            {
                return Err(StoreError::IdempotencyConflict(task.id.clone()));
            }
        } else {
            tx.execute(
                "INSERT INTO tasks(id, campaign_id, title, acceptance, state) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    task.id,
                    task.campaign_id,
                    task.title,
                    task.acceptance,
                    work_status_string(task.state)
                ],
            )?;
        }
        let mapping: Option<String> = tx
            .query_row(
                "SELECT project_id FROM campaign_projects WHERE campaign_id=?1",
                params![campaign.id],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(existing_project) = mapping {
            if existing_project != project_id {
                return Err(StoreError::IdempotencyConflict(campaign.id.clone()));
            }
        } else {
            tx.execute(
                "INSERT INTO campaign_projects(campaign_id, project_id) VALUES (?1, ?2)",
                params![campaign.id, project_id],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Create or reuse the Project identified by a canonical workspace and
    /// commit the Campaign, root Task, policy snapshot, and current
    /// authorization in one transaction. Existing authorization is never
    /// widened by a replay: it must already equal the requested value.
    pub fn create_workspace_campaign(
        &self,
        proposed_project: &Project,
        campaign: &Campaign,
        task: &Task,
        policy_id: &str,
        policy_payload_json: &str,
        authorization: &CampaignAuthorization,
    ) -> Result<Project, StoreError> {
        if proposed_project.id.trim().is_empty()
            || proposed_project.workspace_root.trim().is_empty()
            || policy_id.trim().is_empty()
        {
            return Err(StoreError::InvalidState(
                "project id, workspace root, and policy id are required".into(),
            ));
        }
        if campaign.root_task_id != task.id || task.campaign_id != campaign.id {
            return Err(StoreError::InvalidState(
                "campaign root_task_id and task campaign_id must agree".into(),
            ));
        }

        let mut connection = self.inner.lock().expect("store mutex poisoned");
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let project = ensure_workspace_campaign_on(
            &tx,
            proposed_project,
            campaign,
            task,
            policy_id,
            policy_payload_json,
            authorization,
        )?;
        tx.commit()?;
        Ok(project)
    }

    /// Reserve a whole first-send conversation in ONE IMMEDIATE SQLite transaction
    /// (plan product-interaction-reset R2/R3): the workspace campaign (project,
    /// campaign, root task, policy snapshot, authorization), the request-derived
    /// initial queued Attempt, the original first user message event, the Runtime
    /// preference row and the `conversation_requests` prepared row. Either every
    /// row exists or none does.
    ///
    /// A repeat of the same request id returns the recorded row when the payload
    /// hash matches, and is refused with `IdempotencyConflict` when it does not; in
    /// neither case does a repeat execute or resume anything.
    pub fn prepare_conversation_start(
        &self,
        start: &ConversationStart,
    ) -> Result<ConversationPrepareOutcome, StoreError> {
        if start.request_id.trim().is_empty() {
            return Err(StoreError::InvalidState(
                "conversation request id is required".into(),
            ));
        }
        if start.payload_hash.trim().is_empty()
            || start.claim_token.trim().is_empty()
            || start.native_command_id.trim().is_empty()
        {
            return Err(StoreError::InvalidState(
                "conversation request hash, claim token and native command id are required".into(),
            ));
        }
        if start.attempt.state != AttemptState::Queued
            || start.attempt.last_event_seq != 0
            || start.attempt.provider_session.is_some()
        {
            return Err(StoreError::InvalidState(
                "the reserved Attempt must be a new queued row".into(),
            ));
        }
        if start.first_user_message.trim().is_empty() {
            return Err(StoreError::InvalidState(
                "the first user message is required".into(),
            ));
        }
        if start.selected_provider.trim().is_empty() {
            return Err(StoreError::InvalidState(
                "the selected Runtime provider is required".into(),
            ));
        }
        if start.campaign.root_task_id != start.task.id
            || start.task.campaign_id != start.campaign.id
        {
            return Err(StoreError::InvalidState(
                "campaign root_task_id and task campaign_id must agree".into(),
            ));
        }
        if start.attempt.task_id != start.task.id {
            return Err(StoreError::InvalidState(
                "the reserved Attempt must belong to the root task".into(),
            ));
        }
        let mut connection = self.inner.lock().expect("store mutex poisoned");
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(existing) = conversation_request_on(&tx, &start.request_id)? {
            if existing.payload_hash != start.payload_hash {
                return Err(StoreError::IdempotencyConflict(format!(
                    "conversation request {} was recorded with a different payload",
                    start.request_id
                )));
            }
            return Ok(ConversationPrepareOutcome::Existing(existing));
        }
        let project = ensure_workspace_campaign_on(
            &tx,
            &start.project,
            &start.campaign,
            &start.task,
            &start.policy_id,
            &start.policy_payload_json,
            &start.authorization,
        )?;
        let attempt_existing: Option<(String, String, Option<String>, String, i64, String)> = tx
            .query_row(
                "SELECT task_id, provider, provider_session, state, last_event_seq, capability_version FROM attempts WHERE id=?1",
                params![start.attempt.id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .optional()?;
        if let Some((task_id, provider, session, state, last_seq, _)) = attempt_existing {
            let same = task_id == start.attempt.task_id
                && provider == start.attempt.provider
                && session.is_none()
                && state == attempt_state_string(AttemptState::Queued)
                && last_seq == 0;
            if !same {
                return Err(StoreError::IdempotencyConflict(start.attempt.id.clone()));
            }
        } else {
            tx.execute(
                "INSERT INTO attempts(id, task_id, provider, provider_session, state, last_event_seq, capability_version) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    start.attempt.id,
                    start.attempt.task_id,
                    start.attempt.provider,
                    start.attempt.provider_session,
                    attempt_state_string(start.attempt.state),
                    start.attempt.last_event_seq,
                    start.attempt.capability_version
                ],
            )?;
        }
        // The original first user message, reserved exactly once. The event id uses
        // the same core-event-{attempt}-{seq} convention as `persist_event`, and the
        // later native send is told the message is already reserved so it never
        // appends a second message.user.
        let message_event_id = format!("core-event-{}-1", start.attempt.id);
        let message_exists: Option<i64> = tx
            .query_row(
                "SELECT 1 FROM events WHERE id=?1",
                params![message_event_id],
                |row| row.get(0),
            )
            .optional()?;
        if message_exists.is_none() {
            let payload = serde_json::to_string(&serde_json::json!({
                "text": start.first_user_message,
                "requestId": start.request_id,
                "reservedBy": "start_conversation"
            }))?;
            tx.execute(
                "INSERT INTO events(id, attempt_id, seq, kind, payload_ref, state_after, payload_json, created_at) VALUES (?1, ?2, 1, 'message.user', NULL, NULL, ?3, ?4)",
                params![message_event_id, start.attempt.id, payload, now()],
            )?;
            tx.execute(
                "UPDATE attempts SET last_event_seq=1, version=version+1 WHERE id=?1",
                params![start.attempt.id],
            )?;
        }
        tx.execute(
            "INSERT INTO conversation_preferences(campaign_id, selected_provider, title) VALUES (?1, ?2, NULL)
             ON CONFLICT(campaign_id) DO UPDATE SET selected_provider=excluded.selected_provider",
            params![start.campaign.id, start.selected_provider],
        )?;
        insert_conversation_request_on(
            &tx,
            &NewConversationRequest {
                request_id: start.request_id.clone(),
                payload_hash: start.payload_hash.clone(),
                campaign_id: start.campaign.id.clone(),
                task_id: start.task.id.clone(),
                attempt_id: start.attempt.id.clone(),
                claim_token: start.claim_token.clone(),
                native_command_id: start.native_command_id.clone(),
                source_attempt_id: None,
            },
        )?;
        let row = conversation_request_on(&tx, &start.request_id)?
            .ok_or_else(|| StoreError::InvalidState("prepared row missing after insert".into()))?;
        tx.commit()?;
        Ok(ConversationPrepareOutcome::Prepared {
            project: Some(project),
            row,
        })
    }

    /// CAS prepared -> claimed. Only the caller holding `claim_token` — the token
    /// inserted with the row by the invocation whose INSERT succeeded — can move
    /// the row; every other or later caller fails and must re-read the row to
    /// report its status. Repeats never execute or resume.
    pub fn claim_conversation_request(
        &self,
        request_id: &str,
        claim_token: &str,
    ) -> Result<(), StoreError> {
        let mut connection = self.inner.lock().expect("store mutex poisoned");
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let changed = tx.execute(
            "UPDATE conversation_requests SET phase='claimed', updated_at=?3
             WHERE request_id=?1 AND phase='prepared' AND claim_token=?2",
            params![request_id, claim_token, now()],
        )?;
        if changed != 1 {
            return Err(StoreError::InvalidState(format!(
                "conversation request {request_id} was not claimed; it is not prepared for this invocation"
            )));
        }
        tx.commit()?;
        Ok(())
    }

    /// CAS claimed -> dispatching. Only a row this invocation changed (changed=1)
    /// permits the native send; anything else must stop before any native call.
    pub fn begin_dispatch_conversation_request(
        &self,
        request_id: &str,
        claim_token: &str,
    ) -> Result<(), StoreError> {
        let mut connection = self.inner.lock().expect("store mutex poisoned");
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let changed = tx.execute(
            "UPDATE conversation_requests SET phase='dispatching', updated_at=?3
             WHERE request_id=?1 AND phase='claimed' AND claim_token=?2",
            params![request_id, claim_token, now()],
        )?;
        if changed != 1 {
            return Err(StoreError::InvalidState(format!(
                "conversation request {request_id} was not moved to dispatching; native dispatch is refused"
            )));
        }
        tx.commit()?;
        Ok(())
    }

    /// Record the terminal outcome of a conversation request. Write-once: a row
    /// already in a terminal phase is refused. The terminal phase and the result
    /// are written in one UPDATE so a terminal row is never observable without
    /// its recorded outcome.
    pub fn finish_conversation_request(
        &self,
        request_id: &str,
        phase: ConversationRequestPhase,
        result: &Value,
    ) -> Result<(), StoreError> {
        if !phase.is_terminal() {
            return Err(StoreError::InvalidState(
                "finish_conversation_request records terminal phases only".into(),
            ));
        }
        let mut connection = self.inner.lock().expect("store mutex poisoned");
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let previous_result: Option<String> = tx
            .query_row(
                "SELECT result_json FROM conversation_requests WHERE request_id=?1",
                params![request_id],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        let mut stored_result = result.clone();
        if let Some(previous) = previous_result
            .as_deref()
            .map(serde_json::from_str::<Value>)
            .transpose()?
            && let Some(attempts) = previous.get("attempts").and_then(Value::as_array)
            && let Some(object) = stored_result.as_object_mut()
        {
            object.insert("attempts".into(), Value::Array(attempts.clone()));
        }
        let result_json = serde_json::to_string(&stored_result)?;
        let changed = tx.execute(
            "UPDATE conversation_requests SET phase=?2, result_json=?3, updated_at=?4
             WHERE request_id=?1 AND phase IN ('prepared','claimed','dispatching')",
            params![request_id, phase.as_str(), result_json, now()],
        )?;
        if changed != 1 {
            return Err(StoreError::InvalidState(format!(
                "conversation request {request_id} is not in an unsettled phase; its recorded result is written once"
            )));
        }
        tx.commit()?;
        Ok(())
    }

    /// Re-arm a proven pre-dispatch conversation reservation for an explicit
    /// same-ID retry. This is the only terminal -> prepared transition in the
    /// request machine. The transaction proves that the prior failure said
    /// NOT_STARTED, that no native command row exists, and that the exact
    /// reserved campaign/task/attempt (plus first-message or Stop lineage) is
    /// still present. Runtime registration facts are checked by the caller
    /// immediately before this CAS because they are process-local.
    pub fn rearm_failed_conversation_request(
        &self,
        request_id: &str,
        payload_hash: &str,
        claim_token: &str,
    ) -> Result<ConversationRequestRow, StoreError> {
        if request_id.trim().is_empty()
            || payload_hash.trim().is_empty()
            || claim_token.trim().is_empty()
        {
            return Err(StoreError::InvalidState(
                "request id, payload hash and claim token are required to re-arm a reservation"
                    .into(),
            ));
        }
        let mut connection = self.inner.lock().expect("store mutex poisoned");
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let row = conversation_request_on(&tx, request_id)?
            .ok_or_else(|| StoreError::NotFound(format!("conversation request {request_id}")))?;
        if row.payload_hash != payload_hash {
            return Err(StoreError::IdempotencyConflict(format!(
                "conversation request {request_id} payload changed"
            )));
        }
        if row.phase != "failed" {
            return Err(StoreError::InvalidState(format!(
                "conversation request {request_id} is {}, not a retryable failed reservation",
                row.phase
            )));
        }
        let result = row.result.as_ref().ok_or_else(|| {
            StoreError::InvalidState(format!(
                "conversation request {request_id} has no failure proof"
            ))
        })?;
        let retryable = result.get("deliveryState").and_then(Value::as_str) == Some("FAILED")
            && result.get("nativeDispatchState").and_then(Value::as_str) == Some("NOT_STARTED")
            && result.get("retryMode").and_then(Value::as_str) == Some("SAME_REQUEST");
        if !retryable {
            return Err(StoreError::InvalidState(format!(
                "conversation request {request_id} does not carry proven pre-dispatch retry facts"
            )));
        }
        let native_command_exists: Option<i64> = tx
            .query_row(
                "SELECT 1 FROM commands WHERE id=?1 LIMIT 1",
                params![row.native_command_id],
                |db_row| db_row.get(0),
            )
            .optional()?;
        if native_command_exists.is_some() {
            return Err(StoreError::InvalidState(format!(
                "conversation request {request_id} already has a native command row; dispatch cannot be re-armed"
            )));
        }
        let target_matches: Option<i64> = tx
            .query_row(
                "SELECT 1 FROM attempts a
                 JOIN tasks t ON t.id=a.task_id
                 WHERE a.id=?1 AND a.task_id=?2 AND t.campaign_id=?3 LIMIT 1",
                params![row.attempt_id, row.task_id, row.campaign_id],
                |db_row| db_row.get(0),
            )
            .optional()?;
        if target_matches.is_none() {
            return Err(StoreError::InvalidState(format!(
                "conversation request {request_id} no longer owns its reserved target"
            )));
        }
        let reservation_matches: Option<i64> = if let Some(source_attempt_id) =
            row.source_attempt_id.as_deref()
        {
            let source_state: Option<String> = tx
                .query_row(
                    "SELECT state FROM attempts WHERE id=?1",
                    params![source_attempt_id],
                    |db_row| db_row.get(0),
                )
                .optional()?;
            if source_state.as_deref() != Some(attempt_state_string(AttemptState::Cancelled))
                || !cancellation_confirmed_on(&tx, source_attempt_id)?
            {
                return Err(StoreError::InvalidState(format!(
                    "conversation request {request_id} no longer has a confirmed cancelled source"
                )));
            }
            let unsafe_source: Option<i64> = tx
                .query_row(
                    "SELECT 1 WHERE
                       EXISTS(SELECT 1 FROM stop_responsibilities WHERE attempt_id=?1)
                       OR EXISTS(
                         SELECT 1 FROM outbox o JOIN commands c ON c.id=o.command_id
                         WHERE c.attempt_id=?1 AND o.state!='SUCCEEDED'
                       )
                       OR EXISTS(
                         SELECT 1 FROM attempts newer
                         WHERE newer.task_id=?2
                           AND newer.rowid>(SELECT rowid FROM attempts WHERE id=?3)
                       )",
                    params![source_attempt_id, row.task_id, row.attempt_id],
                    |db_row| db_row.get(0),
                )
                .optional()?;
            if unsafe_source.is_some() {
                return Err(StoreError::InvalidState(format!(
                    "conversation request {request_id} Stop successor is no longer the latest safe reservation"
                )));
            }
            tx.query_row(
                "SELECT 1 FROM events
                 WHERE attempt_id=?1 AND kind='attempt.created'
                   AND json_extract(payload_json,'$.rolledFrom')=?2 LIMIT 1",
                params![row.attempt_id, source_attempt_id],
                |db_row| db_row.get(0),
            )
            .optional()?
        } else {
            tx.query_row(
                "SELECT 1 FROM events
                 WHERE attempt_id=?1 AND kind='message.user'
                   AND json_extract(payload_json,'$.requestId')=?2 LIMIT 1",
                params![row.attempt_id, row.request_id],
                |db_row| db_row.get(0),
            )
            .optional()?
        };
        if reservation_matches.is_none() {
            return Err(StoreError::InvalidState(format!(
                "conversation request {request_id} reservation proof no longer matches"
            )));
        }
        let mut attempts = result
            .get("attempts")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut previous = result.clone();
        if let Some(object) = previous.as_object_mut() {
            object.remove("attempts");
        }
        attempts.push(previous);
        let rearmed_result = serde_json::to_string(&serde_json::json!({
            "attempts": attempts,
            "rearmed": true,
            "retryMode": "SAME_REQUEST",
            "nativeDispatchState": "NOT_STARTED"
        }))?;
        let changed = tx.execute(
            "UPDATE conversation_requests
             SET phase='prepared', claim_token=?2, result_json=?3, updated_at=?4
             WHERE request_id=?1 AND phase='failed' AND payload_hash=?5",
            params![request_id, claim_token, rearmed_result, now(), payload_hash],
        )?;
        if changed != 1 {
            return Err(StoreError::InvalidState(format!(
                "conversation request {request_id} changed while its retry was being re-armed"
            )));
        }
        let row = conversation_request_on(&tx, request_id)?
            .ok_or_else(|| StoreError::InvalidState("re-armed request disappeared".into()))?;
        tx.commit()?;
        Ok(row)
    }

    /// Restart recovery (R3): every prepared/claimed/dispatching row is a command
    /// whose settlement this process can no longer prove. All become
    /// 'unknown' with a recorded reason; nothing is ever dispatched by recovery.
    pub fn mark_unsettled_conversation_requests_unknown(&self) -> Result<usize, StoreError> {
        let mut connection = self.inner.lock().expect("store mutex poisoned");
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let changed = tx.execute(
            "UPDATE conversation_requests
             SET phase='unknown',
                 result_json=COALESCE(result_json, ?1),
                 updated_at=?2
             WHERE phase IN ('prepared','claimed','dispatching')",
            params![
                serde_json::to_string(&serde_json::json!({
                    "recovered": "core-restart",
                    "deliveryState": "UNKNOWN",
                    "note": "the request was not settled before the Core process ended; it is never dispatched automatically"
                }))?,
                now()
            ],
        )?;
        tx.commit()?;
        Ok(changed)
    }

    pub fn confirmed_cancellation(&self, attempt_id: &str) -> Result<bool, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        cancellation_confirmed_on(&connection, attempt_id)
    }

    pub fn conversation_request(
        &self,
        request_id: &str,
    ) -> Result<Option<ConversationRequestRow>, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        conversation_request_on(&connection, request_id)
    }

    /// Create the same-provider successor of a durably confirmed stop in one
    /// transaction (plan R3 `insert_confirmed_stop_successor`). Loads the source
    /// provider/task/state and verifies, transactionally: the source state is
    /// CANCELLED; a durable cancellation event exists for that source (its
    /// `state_after` is CANCELLED); no Stop responsibility is held for it; no
    /// unsettled outbox intent belongs to it; the selected preference provider (if
    /// recorded) matches; the successor provider equals the source provider; and
    /// the source is the task's latest attempt. Inserts the successor Attempt, its
    /// rolledFrom lineage event, the preference pointer and the request mapping
    /// atomically. The source state is never rewritten. An uncertain or
    /// unconfirmed source is refused here, before any native registration.
    pub fn insert_confirmed_stop_successor(
        &self,
        successor: &ConfirmedStopSuccessor,
    ) -> Result<ConversationPrepareOutcome, StoreError> {
        let source_attempt_id = successor.source_attempt_id.trim();
        if source_attempt_id.is_empty()
            || successor.request_id.trim().is_empty()
            || successor.payload_hash.trim().is_empty()
            || successor.claim_token.trim().is_empty()
            || successor.native_command_id.trim().is_empty()
        {
            return Err(StoreError::InvalidState(
                "successor source, request, payload hash, claim token and native command id are required"
                    .into(),
            ));
        }
        if successor.successor_attempt.id == source_attempt_id {
            return Err(StoreError::InvalidState(
                "the successor must be a distinct Attempt".into(),
            ));
        }
        let mut connection = self.inner.lock().expect("store mutex poisoned");
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(existing) = conversation_request_on(&tx, &successor.request_id)? {
            if existing.payload_hash != successor.payload_hash {
                return Err(StoreError::IdempotencyConflict(format!(
                    "successor request {} was recorded with a different payload",
                    successor.request_id
                )));
            }
            return Ok(ConversationPrepareOutcome::Existing(existing));
        }
        let source: (String, String, String) = tx
            .query_row(
                "SELECT task_id, provider, state FROM attempts WHERE id=?1",
                params![source_attempt_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?
            .ok_or_else(|| StoreError::NotFound(format!("attempt {source_attempt_id}")))?;
        let (source_task_id, source_provider, source_state) = source;
        if source_state != attempt_state_string(AttemptState::Cancelled) {
            return Err(StoreError::InvalidState(format!(
                "confirmed-stop successor requires source attempt {source_attempt_id} to be CANCELLED, not {source_state}; no replacement is created"
            )));
        }
        if !cancellation_confirmed_on(&tx, source_attempt_id)? {
            return Err(StoreError::InvalidState(format!(
                "attempt {source_attempt_id} is CANCELLED without a durable cancellation event; an unconfirmed stop never creates a replacement"
            )));
        }
        let held: Option<i64> = tx
            .query_row(
                "SELECT 1 FROM stop_responsibilities WHERE attempt_id=?1 LIMIT 1",
                params![source_attempt_id],
                |row| row.get(0),
            )
            .optional()?;
        if held.is_some() {
            return Err(StoreError::StopResponsibilityConflict {
                attempt_id: source_attempt_id.to_owned(),
                operation_id: format!("successor-of-{source_attempt_id}"),
            });
        }
        let unsettled_outbox: Option<i64> = tx
            .query_row(
                "SELECT 1 FROM outbox o INNER JOIN commands c ON c.id=o.command_id
                 WHERE c.attempt_id=?1 AND o.state != 'SUCCEEDED' LIMIT 1",
                params![source_attempt_id],
                |row| row.get(0),
            )
            .optional()?;
        if unsettled_outbox.is_some() {
            return Err(StoreError::InvalidState(format!(
                "attempt {source_attempt_id} still has a pending, dispatching, failed or unknown outbox effect; no replacement is created"
            )));
        }
        let latest: Option<i64> = tx
            .query_row(
                "SELECT 1 FROM attempts WHERE task_id=?1 AND rowid > (SELECT rowid FROM attempts WHERE id=?2) LIMIT 1",
                params![source_task_id, source_attempt_id],
                |row| row.get(0),
            )
            .optional()?;
        if latest.is_some() {
            return Err(StoreError::InvalidState(format!(
                "attempt {source_attempt_id} is not the latest Attempt of its task; successors are created only from the latest, cancelled attempt"
            )));
        }
        let campaign_id: String = tx
            .query_row(
                "SELECT campaign_id FROM tasks WHERE id=?1",
                params![source_task_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| StoreError::NotFound(format!("task {source_task_id}")))?;
        let preferred: Option<Option<String>> = tx
            .query_row(
                "SELECT selected_provider FROM conversation_preferences WHERE campaign_id=?1",
                params![campaign_id],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(Some(provider)) = preferred.as_ref() {
            if !provider.eq_ignore_ascii_case(&source_provider) {
                return Err(StoreError::InvalidState(format!(
                    "selected Runtime preference is {provider} but the confirmed-stop successor must use the source provider {source_provider}"
                )));
            }
        }
        if !successor
            .successor_attempt
            .provider
            .eq_ignore_ascii_case(&source_provider)
        {
            return Err(StoreError::InvalidState(format!(
                "confirmed-stop successor provider {} must equal the source provider {source_provider}",
                successor.successor_attempt.provider
            )));
        }
        if successor.successor_attempt.task_id != source_task_id {
            return Err(StoreError::InvalidState(
                "the successor must belong to the source task".into(),
            ));
        }
        if successor.successor_attempt.state != AttemptState::Queued
            || successor.successor_attempt.last_event_seq != 0
            || successor.successor_attempt.provider_session.is_some()
        {
            return Err(StoreError::InvalidState(
                "the successor must be a new queued row with no events or provider session".into(),
            ));
        }
        let existing_successor: Option<i64> = tx
            .query_row(
                "SELECT 1 FROM attempts WHERE id=?1",
                params![successor.successor_attempt.id],
                |row| row.get(0),
            )
            .optional()?;
        if existing_successor.is_some() {
            return Err(StoreError::IdempotencyConflict(
                successor.successor_attempt.id.clone(),
            ));
        }
        let lineage_payload = serde_json::to_string(&serde_json::json!({
            "provider": successor.successor_attempt.provider,
            "rolledFrom": source_attempt_id,
        }))?;
        let event_id = format!("core-event-{}-1", successor.successor_attempt.id);
        tx.execute(
            "INSERT INTO attempts(id, task_id, provider, provider_session, state, last_event_seq, capability_version) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                successor.successor_attempt.id,
                successor.successor_attempt.task_id,
                successor.successor_attempt.provider,
                successor.successor_attempt.provider_session,
                attempt_state_string(successor.successor_attempt.state),
                successor.successor_attempt.last_event_seq,
                successor.successor_attempt.capability_version
            ],
        )?;
        tx.execute(
            "INSERT INTO events(id, attempt_id, seq, kind, payload_ref, state_after, payload_json, created_at) VALUES (?1, ?2, 1, 'attempt.created', NULL, NULL, ?3, ?4)",
            params![event_id, successor.successor_attempt.id, lineage_payload, now()],
        )?;
        tx.execute(
            "UPDATE attempts SET last_event_seq=1, version=version+1 WHERE id=?1",
            params![successor.successor_attempt.id],
        )?;
        tx.execute(
            "INSERT INTO conversation_preferences(campaign_id, selected_provider, title) VALUES (?1, ?2, NULL)
             ON CONFLICT(campaign_id) DO UPDATE SET selected_provider=excluded.selected_provider",
            params![campaign_id, source_provider],
        )?;
        insert_conversation_request_on(
            &tx,
            &NewConversationRequest {
                request_id: successor.request_id.clone(),
                payload_hash: successor.payload_hash.clone(),
                campaign_id,
                task_id: source_task_id,
                attempt_id: successor.successor_attempt.id.clone(),
                claim_token: successor.claim_token.clone(),
                native_command_id: successor.native_command_id.clone(),
                source_attempt_id: Some(source_attempt_id.to_owned()),
            },
        )?;
        let row = conversation_request_on(&tx, &successor.request_id)?
            .ok_or_else(|| StoreError::InvalidState("successor row missing after insert".into()))?;
        tx.commit()?;
        Ok(ConversationPrepareOutcome::Prepared { project: None, row })
    }

    /// The persisted Runtime preference for a campaign, if a row exists.
    pub fn conversation_preference(
        &self,
        campaign_id: &str,
    ) -> Result<Option<ConversationPreference>, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        Ok(connection
            .query_row(
                "SELECT selected_provider, title FROM conversation_preferences WHERE campaign_id=?1",
                params![campaign_id],
                |row| {
                    Ok(ConversationPreference {
                        selected_provider: row.get(0)?,
                        title: row.get(1)?,
                    })
                },
            )
            .optional()?)
    }

    /// Persist the Runtime preference. Written only after an accepted selection
    /// (or inside the first-send/successor transactions); never cleared by turn
    /// terminality, so a cancelled or failed attempt keeps its provider selected.
    pub fn set_conversation_provider(
        &self,
        campaign_id: &str,
        provider: &str,
    ) -> Result<(), StoreError> {
        if campaign_id.trim().is_empty() || provider.trim().is_empty() {
            return Err(StoreError::InvalidState(
                "campaign id and provider are required for the Runtime preference".into(),
            ));
        }
        let connection = self.inner.lock().expect("store mutex poisoned");
        connection.execute(
            "INSERT INTO conversation_preferences(campaign_id, selected_provider, title) VALUES (?1, ?2, NULL)
             ON CONFLICT(campaign_id) DO UPDATE SET selected_provider=excluded.selected_provider",
            params![campaign_id, provider],
        )?;
        Ok(())
    }

    /// Rename: update the product title durably. The original prompt and history
    /// are never rewritten; only this preference column changes.
    pub fn set_conversation_title(&self, campaign_id: &str, title: &str) -> Result<(), StoreError> {
        let title = title.trim();
        if campaign_id.trim().is_empty() {
            return Err(StoreError::InvalidState(
                "campaign id is required to rename a conversation".into(),
            ));
        }
        if title.is_empty() {
            return Err(StoreError::InvalidState(
                "conversation title must not be empty".into(),
            ));
        }
        if title.chars().count() > 200 {
            return Err(StoreError::InvalidState(
                "conversation title is too long (limit 200 characters)".into(),
            ));
        }
        let connection = self.inner.lock().expect("store mutex poisoned");
        connection.execute(
            "INSERT INTO conversation_preferences(campaign_id, selected_provider, title) VALUES (?1, NULL, ?2)
             ON CONFLICT(campaign_id) DO UPDATE SET title=excluded.title",
            params![campaign_id, title],
        )?;
        Ok(())
    }

    /// The campaign's full event journal in durable cross-attempt order: events of
    /// every attempt of every task of the campaign, ordered by the explicit,
    /// VACUUM-stable product_event_order sequence (R3), never by timestamps.
    pub fn campaign_event_records(
        &self,
        campaign_id: &str,
    ) -> Result<Vec<EventRecord>, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        let mut statement = connection.prepare(
            "SELECT e.id, e.attempt_id, e.seq, e.kind, e.payload_ref, e.payload_json, e.created_at
             FROM events e
             JOIN attempts a ON a.id = e.attempt_id
             JOIN tasks t ON t.id = a.task_id
             JOIN product_event_order o ON o.event_id = e.id
             WHERE t.campaign_id = ?1
             ORDER BY o.order_seq ASC",
        )?;
        let rows = statement.query_map(params![campaign_id], |row| {
            let payload_json: Option<String> = row.get(5)?;
            let payload = payload_json
                .as_deref()
                .map(serde_json::from_str)
                .transpose()
                .map_err(|error| to_sql_error(DomainError::InvalidEntity(error.to_string())))?;
            Ok(EventRecord {
                event: Event {
                    id: row.get(0)?,
                    attempt_id: row.get(1)?,
                    seq: row.get(2)?,
                    kind: row.get(3)?,
                    payload_ref: row.get(4)?,
                },
                payload,
                created_at: row.get(6)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Bounded campaign journal window in immutable product order. `before` is
    /// exclusive; `None` selects the newest rows. Results are returned in
    /// display order even though SQLite reads the newest rows first.
    pub fn campaign_event_records_before(
        &self,
        campaign_id: &str,
        before: Option<i64>,
        limit: usize,
    ) -> Result<Vec<OrderedEventRecord>, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        let mut statement = connection.prepare(
            "SELECT o.order_seq, e.id, e.attempt_id, e.seq, e.kind, e.payload_ref, e.payload_json, e.created_at
             FROM events e
             JOIN attempts a ON a.id=e.attempt_id
             JOIN tasks t ON t.id=a.task_id
             JOIN product_event_order o ON o.event_id=e.id
             WHERE t.campaign_id=?1 AND o.order_seq<?2
             ORDER BY o.order_seq DESC LIMIT ?3",
        )?;
        let anchor = before.unwrap_or(i64::MAX);
        let rows = statement.query_map(
            params![campaign_id, anchor, limit as i64],
            ordered_event_from_row,
        )?;
        let mut records = rows.collect::<Result<Vec<_>, _>>()?;
        records.reverse();
        Ok(records)
    }

    /// Bounded campaign journal window after an exclusive durable position.
    pub fn campaign_event_records_after(
        &self,
        campaign_id: &str,
        after: i64,
        limit: usize,
    ) -> Result<Vec<OrderedEventRecord>, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        let mut statement = connection.prepare(
            "SELECT o.order_seq, e.id, e.attempt_id, e.seq, e.kind, e.payload_ref, e.payload_json, e.created_at
             FROM events e
             JOIN attempts a ON a.id=e.attempt_id
             JOIN tasks t ON t.id=a.task_id
             JOIN product_event_order o ON o.event_id=e.id
             WHERE t.campaign_id=?1 AND o.order_seq>?2
             ORDER BY o.order_seq ASC LIMIT ?3",
        )?;
        let rows = statement.query_map(
            params![campaign_id, after, limit as i64],
            ordered_event_from_row,
        )?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Bounded single-attempt timeline window before an exclusive sequence.
    pub fn attempt_event_records_before(
        &self,
        attempt_id: &str,
        before: Option<i64>,
        limit: usize,
    ) -> Result<Vec<OrderedEventRecord>, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        let mut statement = connection.prepare(
            "SELECT e.seq, e.id, e.attempt_id, e.seq, e.kind, e.payload_ref, e.payload_json, e.created_at
             FROM events e WHERE e.attempt_id=?1 AND e.seq<?2
             ORDER BY e.seq DESC LIMIT ?3",
        )?;
        let anchor = before.unwrap_or(i64::MAX);
        let rows = statement.query_map(
            params![attempt_id, anchor, limit as i64],
            ordered_event_from_row,
        )?;
        let mut records = rows.collect::<Result<Vec<_>, _>>()?;
        records.reverse();
        Ok(records)
    }

    /// Bounded single-attempt timeline window after an exclusive sequence.
    pub fn attempt_event_records_after(
        &self,
        attempt_id: &str,
        after: i64,
        limit: usize,
    ) -> Result<Vec<OrderedEventRecord>, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        let mut statement = connection.prepare(
            "SELECT e.seq, e.id, e.attempt_id, e.seq, e.kind, e.payload_ref, e.payload_json, e.created_at
             FROM events e WHERE e.attempt_id=?1 AND e.seq>?2
             ORDER BY e.seq ASC LIMIT ?3",
        )?;
        let rows = statement.query_map(
            params![attempt_id, after, limit as i64],
            ordered_event_from_row,
        )?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Targeted title fallback: read only the first user-authored message.
    pub fn campaign_first_user_message(
        &self,
        campaign_id: &str,
    ) -> Result<Option<String>, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        Ok(connection
            .query_row(
                "SELECT json_extract(e.payload_json,'$.text')
                 FROM events e
                 JOIN attempts a ON a.id=e.attempt_id
                 JOIN tasks t ON t.id=a.task_id
                 JOIN product_event_order o ON o.event_id=e.id
                 WHERE t.campaign_id=?1 AND e.kind='message.user'
                   AND COALESCE(json_extract(e.payload_json,'$.origin'),'user')!='generated-handoff'
                   AND NOT (
                     json_extract(e.payload_json,'$.requestId') LIKE 'handoff-instruction-%'
                     AND EXISTS(
                       SELECT 1 FROM events prior
                       WHERE prior.attempt_id=e.attempt_id AND prior.seq=e.seq-1
                         AND prior.kind='handoff.completed'
                         AND json_extract(prior.payload_json,'$.packetVersion')='goalport.handoff.v1'
                         AND json_extract(prior.payload_json,'$.newAttempt.id')=e.attempt_id
                         AND json_extract(prior.payload_json,'$.authorization.requestHash') IS NOT NULL
                     )
                   )
                 ORDER BY o.order_seq ASC LIMIT 1",
                params![campaign_id],
                |row| row.get(0),
            )
            .optional()?)
    }

    /// Stable presentation identity for one streamed reply delta. It finds the
    /// first delta after the latest semantic boundary (or attempt change) using
    /// durable product order, so adjacent pages share a logical item without
    /// loading the campaign journal.
    pub fn campaign_reply_group_id(
        &self,
        campaign_id: &str,
        position: i64,
    ) -> Result<Option<String>, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        let current_attempt: Option<String> = connection
            .query_row(
                "SELECT e.attempt_id FROM events e
                 JOIN attempts a ON a.id=e.attempt_id
                 JOIN tasks t ON t.id=a.task_id
                 JOIN product_event_order o ON o.event_id=e.id
                 WHERE t.campaign_id=?1 AND o.order_seq=?2",
                params![campaign_id, position],
                |row| row.get(0),
            )
            .optional()?;
        let Some(current_attempt) = current_attempt else {
            return Ok(None);
        };
        let boundary: i64 = connection.query_row(
            "SELECT COALESCE(MAX(o.order_seq),0)
             FROM events e
             JOIN attempts a ON a.id=e.attempt_id
             JOIN tasks t ON t.id=a.task_id
             JOIN product_event_order o ON o.event_id=e.id
             WHERE t.campaign_id=?1 AND o.order_seq<?2 AND (
                 e.attempt_id!=?3 OR e.kind IN (
                   'message.user','runtime.tool.activity','runtime.turn.started',
                   'runtime.turn.completed','runtime.turn.cancelled','runtime.turn.failed',
                   'runtime.send.failed','runtime.transport.closed','handoff.completed'
                 )
             )",
            params![campaign_id, position, current_attempt],
            |row| row.get(0),
        )?;
        Ok(connection
            .query_row(
                "SELECT e.id FROM events e
                 JOIN attempts a ON a.id=e.attempt_id
                 JOIN tasks t ON t.id=a.task_id
                 JOIN product_event_order o ON o.event_id=e.id
                 WHERE t.campaign_id=?1 AND e.attempt_id=?2
                   AND e.kind='runtime.reply.delta'
                   AND o.order_seq>?3 AND o.order_seq<=?4
                 ORDER BY o.order_seq ASC LIMIT 1",
                params![campaign_id, current_attempt, boundary, position],
                |row| row.get(0),
            )
            .optional()?)
    }

    /// Backward-compatible proof for handoff prompts written before typed
    /// `origin`/`handoffId` existed. The deterministic request namespace alone
    /// is insufficient; require the immediately preceding durable structured
    /// handoff packet to name this attempt as its destination.
    pub fn historical_generated_handoff_message(
        &self,
        attempt_id: &str,
        event_seq: i64,
        request_id: &str,
    ) -> Result<bool, StoreError> {
        if !request_id.starts_with("handoff-instruction-") || event_seq <= 1 {
            return Ok(false);
        }
        let connection = self.inner.lock().expect("store mutex poisoned");
        let found: Option<i64> = connection
            .query_row(
                "SELECT 1 FROM events
                 WHERE attempt_id=?1 AND seq=?2 AND kind='handoff.completed'
                   AND json_extract(payload_json,'$.packetVersion')='goalport.handoff.v1'
                   AND json_extract(payload_json,'$.newAttempt.id')=?1
                   AND json_extract(payload_json,'$.authorization.requestHash') IS NOT NULL
                 LIMIT 1",
                params![attempt_id, event_seq - 1],
                |row| row.get(0),
            )
            .optional()?;
        Ok(found.is_some())
    }

    /// Whether this source-side handoff fact is the canonical first durable
    /// record for its operation identity. Both new `handoffId` packets and
    /// historical packets (authorization request hash) are covered, so a
    /// repeated fact cannot render another summary on a later page.
    pub fn campaign_handoff_is_canonical(
        &self,
        campaign_id: &str,
        position: i64,
        operation_id: &str,
    ) -> Result<bool, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        let first: Option<i64> = connection
            .query_row(
                "SELECT MIN(o.order_seq)
                 FROM events e
                 JOIN attempts a ON a.id=e.attempt_id
                 JOIN tasks t ON t.id=a.task_id
                 JOIN product_event_order o ON o.event_id=e.id
                 WHERE t.campaign_id=?1 AND e.kind='handoff.completed'
                   AND (
                     json_extract(e.payload_json,'$.summarySide')='source'
                     OR (
                       json_extract(e.payload_json,'$.summarySide') IS NULL
                       AND json_extract(e.payload_json,'$.oldAttempt.id')=e.attempt_id
                     )
                   )
                   AND COALESCE(
                     json_extract(e.payload_json,'$.handoffId'),
                     'handoff-' || json_extract(e.payload_json,'$.authorization.requestHash')
                   )=?2",
                params![campaign_id, operation_id],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        Ok(first == Some(position))
    }

    /// Ids of commands for this attempt that are still Executing (no recorded
    /// result) or Unknown. Product turn model input: an unsettled command makes
    /// the turn uncertain, fail-closed.
    pub fn unsettled_commands_for_attempt(
        &self,
        attempt_id: &str,
    ) -> Result<Vec<String>, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        let mut statement = connection.prepare(
            "SELECT id FROM commands WHERE attempt_id=?1 AND state IN ('EXECUTING','UNKNOWN')",
        )?;
        let rows = statement.query_map(params![attempt_id], |row| row.get(0))?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// VACUUM the database. Maintenance surface for the explicit order_seq test:
    /// the point is that the INTEGER PRIMARY KEY values survive it.
    pub fn vacuum(&self) -> Result<(), StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        connection.execute_batch("VACUUM")?;
        Ok(())
    }

    pub fn record_command(&self, command: &Command) -> Result<Command, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        if let Some(existing) = connection
            .query_row(
                "SELECT attempt_id, kind, payload_hash, state FROM commands WHERE id=?1",
                params![command.id],
                |row| command_from_row_with_id(row, &command.id),
            )
            .optional()?
        {
            if existing.attempt_id == command.attempt_id
                && existing.kind == command.kind
                && existing.payload_hash == command.payload_hash
            {
                return Ok(existing);
            }
            return Err(StoreError::IdempotencyConflict(command.id.clone()));
        }
        connection.execute(
            "INSERT INTO commands(id, attempt_id, kind, payload_hash, state, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![command.id, command.attempt_id, command.kind, command.payload_hash, command_state_string(command.state), now()],
        )?;
        Ok(command.clone())
    }

    /// `record_command` for a request-addressed command (increment 7, plan v12): a NEW row is
    /// inserted with `result_json = {"requestId": …}` so the row names its request from the
    /// moment it exists — a Pending row left behind by a crash between the record and the
    /// Executing transition can then still be told apart from a different request id that shares
    /// its lossy command identity. An EXISTING row is returned untouched (same identity rule as
    /// `record_command`: attempt, kind and payload hash must match, else IdempotencyConflict).
    pub fn record_command_for_request(
        &self,
        command: &Command,
        request_id: &str,
    ) -> Result<Command, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        if let Some(existing) = connection
            .query_row(
                "SELECT attempt_id, kind, payload_hash, state FROM commands WHERE id=?1",
                params![command.id],
                |row| command_from_row_with_id(row, &command.id),
            )
            .optional()?
        {
            if existing.attempt_id == command.attempt_id
                && existing.kind == command.kind
                && existing.payload_hash == command.payload_hash
            {
                return Ok(existing);
            }
            return Err(StoreError::IdempotencyConflict(command.id.clone()));
        }
        let stamp = serde_json::to_string(&serde_json::json!({ "requestId": request_id }))?;
        connection.execute(
            "INSERT INTO commands(id, attempt_id, kind, payload_hash, state, created_at, result_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![command.id, command.attempt_id, command.kind, command.payload_hash, command_state_string(command.state), now(), stamp],
        )?;
        Ok(command.clone())
    }

    pub fn update_command_state(
        &self,
        id: &str,
        state: CommandState,
    ) -> Result<Command, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        let current = connection
            .query_row(
                "SELECT attempt_id, kind, payload_hash, state FROM commands WHERE id=?1",
                params![id],
                |row| command_from_row_with_id(row, id),
            )
            .optional()?
            .ok_or_else(|| StoreError::NotFound(format!("command {id}")))?;
        if current.state != state && !current.state.can_transition_to(state) {
            return Err(StoreError::InvalidState(format!(
                "command {id} cannot transition from {:?} to {:?}",
                current.state, state
            )));
        }
        // Predicated on the state that was read (plan v13): if another connection or process
        // moved the row in between - in particular committed a terminal state WITH its result -
        // this write changes nothing and is refused, so a state can never be overwritten from a
        // stale read and a recorded result never ends up under a different state.
        let changed = connection.execute(
            "UPDATE commands SET state=?, version=version+1 WHERE id=? AND state=?",
            params![
                command_state_string(state),
                id,
                command_state_string(current.state)
            ],
        )?;
        if changed != 1 {
            return Err(StoreError::InvalidState(format!(
                "command {id} changed concurrently while its state was being updated; nothing written"
            )));
        }
        connection
            .query_row(
                "SELECT attempt_id, kind, payload_hash, state FROM commands WHERE id=?1",
                params![id],
                |row| command_from_row_with_id(row, id),
            )
            .map_err(StoreError::from)
    }

    /// Terminal transition WITH the command's recorded result, written in one UPDATE so a
    /// terminal state is never observable without its result (increment 7, run
    /// runtime-registration-safety). Deliberately STRICTER than `update_command_state`: the TARGET
    /// must be terminal (a non-terminal target is refused) and a row that is already terminal is
    /// refused, so a recorded result is written exactly once; otherwise the same
    /// `can_transition_to` check applies. `result` is stored as JSON in `commands.result_json`
    /// and read back by `command_result`. The convention `send_message` uses:
    /// `{"requestId", "deliveryState": "FAILED"|"DELIVERED"|"UNKNOWN", "error"?}`.
    pub fn finish_command(
        &self,
        id: &str,
        state: CommandState,
        result: &Value,
    ) -> Result<Command, StoreError> {
        let mut connection = self.inner.lock().expect("store mutex poisoned");
        // Write-once under concurrent connections too (plan v12): the read and the write share one
        // IMMEDIATE transaction, which takes SQLite's write lock at the read, so a second
        // connection or process cannot observe the same Executing state and overwrite this
        // result; the UPDATE is additionally predicated on the state that was read.
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = tx
            .query_row(
                "SELECT attempt_id, kind, payload_hash, state FROM commands WHERE id=?1",
                params![id],
                |row| command_from_row_with_id(row, id),
            )
            .optional()?
            .ok_or_else(|| StoreError::NotFound(format!("command {id}")))?;
        if current.state.is_terminal() {
            return Err(StoreError::InvalidState(format!(
                "command {id} is already {:?}; its recorded result is written once",
                current.state
            )));
        }
        // A result is a TERMINAL fact (plan v15): recording one under a non-terminal state would
        // let a later terminal write replace it, which is exactly what "written once" forbids.
        if !state.is_terminal() {
            return Err(StoreError::InvalidState(format!(
                "command {id}: finish_command records terminal states only, not {state:?}"
            )));
        }
        if !current.state.can_transition_to(state) {
            return Err(StoreError::InvalidState(format!(
                "command {id} cannot transition from {:?} to {:?}",
                current.state, state
            )));
        }
        let result_json = serde_json::to_string(result)?;
        let changed = tx.execute(
            "UPDATE commands SET state=?, version=version+1, result_json=? WHERE id=? AND state=?",
            params![
                command_state_string(state),
                result_json,
                id,
                command_state_string(current.state)
            ],
        )?;
        if changed != 1 {
            return Err(StoreError::InvalidState(format!(
                "command {id} changed concurrently while its result was being recorded; nothing written"
            )));
        }
        let finished = tx.query_row(
            "SELECT attempt_id, kind, payload_hash, state FROM commands WHERE id=?1",
            params![id],
            |row| command_from_row_with_id(row, id),
        )?;
        tx.commit()?;
        Ok(finished)
    }

    /// The result recorded for the row: the full result written by `finish_command`, or — for a
    /// row inserted through `record_command_for_request` that has not (yet) been finished, or was
    /// finished through the bare `update_command_state` fallback — only its insert stamp
    /// `{"requestId": …}` (no `deliveryState`, no `error`, which a replay reads as UNKNOWN /
    /// "reason not recorded"). `None` for a row inserted through `record_command` (no stamp), a
    /// row written before the column existed, a missing row, or a result that fails to parse — a
    /// replay must never be refused by a malformed result; it answers "not recorded" instead.
    pub fn command_result(&self, id: &str) -> Result<Option<Value>, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        let raw: Option<Option<String>> = connection
            .query_row(
                "SELECT result_json FROM commands WHERE id=?1",
                params![id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(raw
            .flatten()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok()))
    }

    pub fn get_command(&self, id: &str) -> Result<Command, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        connection
            .query_row(
                "SELECT attempt_id, kind, payload_hash, state FROM commands WHERE id=?1",
                params![id],
                |row| command_from_row_with_id(row, id),
            )
            .optional()?
            .ok_or_else(|| StoreError::NotFound(format!("command {id}")))
    }

    /// A command left executing when the Core process disappeared has no durable
    /// acknowledgement. Marking it UNKNOWN prevents a restart from replaying a
    /// possibly non-idempotent provider action.
    pub fn mark_executing_commands_unknown(&self) -> Result<usize, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        Ok(connection.execute(
            "UPDATE commands SET state='UNKNOWN', version=version+1 WHERE state='EXECUTING'",
            [],
        )?)
    }

    pub fn append_event(&self, event: &Event) -> Result<AppendEventOutcome, StoreError> {
        self.append_event_with_state(event, infer_state_after(&event.kind), None)
    }

    pub fn append_event_json(
        &self,
        event: &Event,
        payload: &Value,
    ) -> Result<AppendEventOutcome, StoreError> {
        self.append_event_with_state(event, infer_state_after(&event.kind), Some(payload))
    }

    pub fn append_event_with_state(
        &self,
        event: &Event,
        state_after: Option<AttemptState>,
        payload: Option<&Value>,
    ) -> Result<AppendEventOutcome, StoreError> {
        if event.seq <= 0 {
            return Err(StoreError::SequenceConflict {
                attempt_id: event.attempt_id.clone(),
                expected: 1,
                received: event.seq,
            });
        }
        let mut connection = self.inner.lock().expect("store mutex poisoned");
        let tx = connection.transaction()?;

        if let Some(existing) = tx
            .query_row(
                "SELECT attempt_id, seq, kind, payload_ref FROM events WHERE id=?1",
                params![event.id],
                |row| event_from_row_with_id(row, &event.id),
            )
            .optional()?
        {
            if existing == *event {
                tx.commit()?;
                return Ok(AppendEventOutcome::Duplicate(existing));
            }
            return Err(StoreError::IdempotencyConflict(event.id.clone()));
        }

        let current: Option<i64> = tx
            .query_row(
                "SELECT last_event_seq FROM attempts WHERE id=?1",
                params![event.attempt_id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(current) = current else {
            return Err(StoreError::NotFound(format!(
                "attempt {}",
                event.attempt_id
            )));
        };
        let expected = current + 1;
        if event.seq != expected {
            return Err(StoreError::SequenceConflict {
                attempt_id: event.attempt_id.clone(),
                expected,
                received: event.seq,
            });
        }

        let new_state = if let Some(next) = state_after {
            let previous = tx.query_row(
                "SELECT state FROM attempts WHERE id=?1",
                params![event.attempt_id],
                |row| row.get::<_, String>(0),
            )?;
            let previous = parse_attempt_state(&previous)?;
            if previous != next && !previous.can_transition_to(next) {
                return Err(StoreError::Domain(DomainError::InvalidAttemptTransition {
                    from: previous,
                    to: next,
                }));
            }
            Some(next)
        } else {
            None
        };

        tx.execute(
            "INSERT INTO events(id, attempt_id, seq, kind, payload_ref, state_after, payload_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                event.id,
                event.attempt_id,
                event.seq,
                event.kind,
                event.payload_ref,
                new_state.map(attempt_state_string),
                payload.map(serde_json::to_string).transpose()?,
                now()
            ],
        )?;
        if let Some(next) = new_state {
            tx.execute(
                "UPDATE attempts SET last_event_seq=?1, state=?2, version=version+1 WHERE id=?3",
                params![event.seq, attempt_state_string(next), event.attempt_id],
            )?;
        } else {
            tx.execute(
                "UPDATE attempts SET last_event_seq=?1, version=version+1 WHERE id=?2",
                params![event.seq, event.attempt_id],
            )?;
        }
        tx.commit()?;
        Ok(AppendEventOutcome::Inserted(event.clone()))
    }

    pub fn list_events(&self, attempt_id: &str) -> Result<Vec<Event>, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        let mut statement = connection.prepare(
            "SELECT id, attempt_id, seq, kind, payload_ref FROM events WHERE attempt_id=?1 ORDER BY seq ASC",
        )?;
        let rows = statement.query_map(params![attempt_id], |row| {
            Ok(Event {
                id: row.get(0)?,
                attempt_id: row.get(1)?,
                seq: row.get(2)?,
                kind: row.get(3)?,
                payload_ref: row.get(4)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Read the event journal with its structured payload and commit timestamp.
    /// Consumers use `after_seq` as a reconnect cursor; the query is ordered by
    /// the per-Attempt sequence, never by arrival order.
    pub fn list_event_records(
        &self,
        attempt_id: &str,
        after_seq: i64,
    ) -> Result<Vec<EventRecord>, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        let mut statement = connection.prepare(
            "SELECT id, attempt_id, seq, kind, payload_ref, payload_json, created_at
             FROM events WHERE attempt_id=?1 AND seq>?2 ORDER BY seq ASC",
        )?;
        let rows = statement.query_map(params![attempt_id, after_seq], |row| {
            let payload_json: Option<String> = row.get(5)?;
            let payload = payload_json
                .as_deref()
                .map(serde_json::from_str)
                .transpose()
                .map_err(|error| to_sql_error(DomainError::InvalidEntity(error.to_string())))?;
            Ok(EventRecord {
                event: Event {
                    id: row.get(0)?,
                    attempt_id: row.get(1)?,
                    seq: row.get(2)?,
                    kind: row.get(3)?,
                    payload_ref: row.get(4)?,
                },
                payload,
                created_at: row.get(6)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn latest_event_seq(&self, attempt_id: &str) -> Result<i64, StoreError> {
        Ok(self.get_attempt(attempt_id)?.last_event_seq)
    }

    pub fn event_count(&self, attempt_id: &str) -> Result<usize, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        let count: i64 = connection.query_row(
            "SELECT COUNT(*) FROM events WHERE attempt_id=?1",
            params![attempt_id],
            |row| row.get(0),
        )?;
        Ok(count.max(0) as usize)
    }

    pub fn latest_event_kind_in(
        &self,
        attempt_id: &str,
        kinds: &[&str],
    ) -> Result<Option<String>, StoreError> {
        if kinds.is_empty() {
            return Ok(None);
        }
        let connection = self.inner.lock().expect("store mutex poisoned");
        let placeholders = std::iter::repeat("?")
            .take(kinds.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT kind FROM events WHERE attempt_id=? AND kind IN ({placeholders}) ORDER BY seq DESC LIMIT 1"
        );
        let mut values: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(kinds.len() + 1);
        values.push(&attempt_id);
        for kind in kinds {
            values.push(kind);
        }
        Ok(connection
            .query_row(&sql, values.as_slice(), |row| row.get(0))
            .optional()?)
    }

    pub fn latest_runtime_session_version(
        &self,
        attempt_id: &str,
    ) -> Result<Option<String>, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        Ok(connection
            .query_row(
                "SELECT json_extract(payload_json,'$.runtime_version') FROM events
                 WHERE attempt_id=?1 AND kind='runtime.session.created'
                   AND json_type(payload_json,'$.runtime_version')='text'
                 ORDER BY seq DESC LIMIT 1",
                params![attempt_id],
                |row| row.get(0),
            )
            .optional()?)
    }

    pub fn permission_request_text(
        &self,
        attempt_id: &str,
        decision_id: &str,
    ) -> Result<Option<String>, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        Ok(connection
            .query_row(
                "SELECT json_extract(payload_json,'$.text') FROM events
                 WHERE attempt_id=?1 AND kind='runtime.permission.request'
                   AND COALESCE(
                     json_extract(payload_json,'$.request_id'),
                     json_extract(payload_json,'$.requestId')
                   )=?2
                   AND json_type(payload_json,'$.text')='text'
                 ORDER BY seq DESC LIMIT 1",
                params![attempt_id, decision_id],
                |row| row.get(0),
            )
            .optional()?)
    }

    /// Rebuild only the projections from the immutable event log. This is used on restart and
    /// also makes duplicate/out-of-order replay harmless: events are read in their durable order.
    pub fn rebuild_projections(&self) -> Result<(), StoreError> {
        let mut connection = self.inner.lock().expect("store mutex poisoned");
        let tx = connection.transaction()?;
        let attempt_ids: Vec<String> = {
            let mut stmt = tx.prepare("SELECT id FROM attempts")?;
            let ids = stmt.query_map([], |row| row.get(0))?;
            ids.collect::<Result<Vec<String>, _>>()?
        };
        for attempt_id in attempt_ids {
            let mut stmt = tx.prepare(
                "SELECT seq, state_after FROM events WHERE attempt_id=?1 ORDER BY seq ASC",
            )?;
            let mut rows = stmt.query(params![attempt_id])?;
            let mut last = 0_i64;
            let mut state = AttemptState::Queued;
            while let Some(row) = rows.next()? {
                let seq: i64 = row.get(0)?;
                if seq != last + 1 {
                    return Err(StoreError::SequenceConflict {
                        attempt_id: attempt_id.clone(),
                        expected: last + 1,
                        received: seq,
                    });
                }
                last = seq;
                if let Some(raw) = row.get::<_, Option<String>>(1)? {
                    state = parse_attempt_state(&raw)?;
                }
            }
            tx.execute(
                "UPDATE attempts SET last_event_seq=?1, state=?2, version=version+1 WHERE id=?3",
                params![last, attempt_state_string(state), attempt_id],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn acquire_lease(&self, requested: &WorkspaceLease) -> Result<WorkspaceLease, StoreError> {
        let mut connection = self.inner.lock().expect("store mutex poisoned");
        let tx = connection.transaction()?;
        let requested_key =
            crate::domain::normalize_workspace_key(Path::new(&requested.workspace_key));
        if requested.is_mutating() {
            ensure_workspace_not_held(&tx, &requested_key)?;
        }
        let mut statement = tx.prepare(
            "SELECT workspace_key, attempt_id, access_mode, state FROM workspace_leases WHERE state IN ('ACTIVE','UNCERTAIN')",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(WorkspaceLease {
                workspace_key: row.get(0)?,
                attempt_id: row.get(1)?,
                access_mode: parse_access_mode(&row.get::<_, String>(2)?)?,
                state: parse_lease_state(&row.get::<_, String>(3)?)?,
            })
        })?;
        let existing = rows.collect::<Result<Vec<_>, rusqlite::Error>>()?;
        drop(statement);
        for lease in existing {
            if !workspace_keys_overlap(&lease.workspace_key, &requested_key) {
                continue;
            }
            if lease.attempt_id == requested.attempt_id {
                // Reissuing the acquisition command for the same holder is
                // idempotent; do not create a second active lease row.
                tx.commit()?;
                return Ok(lease);
            }
            // Unknown is represented as mutating by AccessMode::Unknown. Two managed
            // writers are never allowed. A declared read-only lease may coexist only
            // with another declared read-only lease.
            if lease.is_mutating() || requested.is_mutating() {
                return Err(StoreError::LeaseConflict(lease.attempt_id));
            }
        }
        let timestamp = now();
        tx.execute(
            "INSERT INTO workspace_leases(workspace_key, attempt_id, access_mode, state, acquired_at, last_heartbeat) VALUES (?1, ?2, ?3, 'ACTIVE', ?4, ?4)",
            params![requested_key, requested.attempt_id, access_mode_string(requested.access_mode), timestamp],
        )?;
        tx.commit()?;
        Ok(WorkspaceLease {
            workspace_key: requested_key,
            state: LeaseState::Active,
            ..requested.clone()
        })
    }

    pub fn release_lease(
        &self,
        workspace_key: &str,
        attempt_id: &str,
        reason: &str,
    ) -> Result<(), StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        let workspace_key = crate::domain::normalize_workspace_key(Path::new(workspace_key));
        ensure_workspace_not_held(&connection, &workspace_key)?;
        let changed = connection.execute(
            "UPDATE workspace_leases SET state='RELEASED', release_reason=?, last_heartbeat=? WHERE workspace_key=? AND attempt_id=? AND state IN ('ACTIVE','UNCERTAIN','RELEASING')",
            params![reason, now(), workspace_key, attempt_id],
        )?;
        if changed == 0 {
            return Err(StoreError::NotFound(format!(
                "lease {workspace_key}/{attempt_id}"
            )));
        }
        Ok(())
    }

    /// Revocation is an explicit owner action. It uses the same terminal release
    /// record so the old holder remains in history and cannot be silently reused.
    pub fn revoke_lease(
        &self,
        workspace_key: &str,
        attempt_id: &str,
        reason: &str,
    ) -> Result<(), StoreError> {
        self.release_lease(workspace_key, attempt_id, reason)
    }

    pub fn mark_lease_uncertain(
        &self,
        workspace_key: &str,
        attempt_id: &str,
    ) -> Result<(), StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        let workspace_key = crate::domain::normalize_workspace_key(Path::new(workspace_key));
        let changed = connection.execute(
            "UPDATE workspace_leases SET state='UNCERTAIN', last_heartbeat=? WHERE workspace_key=? AND attempt_id=? AND state='ACTIVE'",
            params![now(), workspace_key, attempt_id],
        )?;
        if changed == 0 {
            return Err(StoreError::NotFound(format!(
                "lease {workspace_key}/{attempt_id}"
            )));
        }
        Ok(())
    }

    pub fn leases(&self) -> Result<Vec<WorkspaceLease>, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        let mut statement = connection.prepare(
            "SELECT workspace_key, attempt_id, access_mode, state FROM workspace_leases ORDER BY id",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(WorkspaceLease {
                workspace_key: row.get(0)?,
                attempt_id: row.get(1)?,
                access_mode: parse_access_mode(&row.get::<_, String>(2)?)?,
                state: parse_lease_state(&row.get::<_, String>(3)?)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn mark_active_leases_uncertain(&self) -> Result<usize, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        Ok(connection.execute(
            "UPDATE workspace_leases SET state='UNCERTAIN', last_heartbeat=? WHERE state='ACTIVE'",
            params![now()],
        )?)
    }

    /// Persist the conservative Stop responsibility before any native interrupt is sent.
    /// A second Stop for the same Attempt returns the original immutable operation/binding;
    /// callers use `inserted` to avoid sending the native control twice.
    pub fn begin_stop_responsibility(
        &self,
        attempt_id: &str,
        operation_id: &str,
        workspace_key: &str,
        provider: &str,
        binding: &Value,
        detail: Option<&Value>,
    ) -> Result<BeginStopResponsibilityOutcome, StoreError> {
        if attempt_id.trim().is_empty()
            || operation_id.trim().is_empty()
            || workspace_key.trim().is_empty()
            || provider.trim().is_empty()
        {
            return Err(StoreError::InvalidState(
                "Stop attempt, operation, workspace and provider are required".into(),
            ));
        }
        let mut connection = self.inner.lock().expect("store mutex poisoned");
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(existing) = stop_responsibility_for_attempt_on(&tx, attempt_id)? {
            tx.commit()?;
            return Ok(BeginStopResponsibilityOutcome {
                responsibility: existing,
                inserted: false,
            });
        }
        if let Some(existing_attempt) = tx
            .query_row(
                "SELECT attempt_id FROM stop_responsibilities WHERE operation_id=?1",
                params![operation_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
        {
            return Err(StoreError::IdempotencyConflict(format!(
                "Stop operation {operation_id} already belongs to {existing_attempt}"
            )));
        }
        let workspace_key = crate::domain::normalize_workspace_key(Path::new(workspace_key));
        let timestamp = now();
        let binding_json = serde_json::to_string(binding)?;
        let detail_json = detail.map(serde_json::to_string).transpose()?;
        tx.execute(
            "INSERT INTO stop_responsibilities(
                 attempt_id, operation_id, workspace_key, provider, binding_json,
                 native_turn_state, residual_execution_state, write_responsibility,
                 detail_json, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, 'pending', 'unknown', 'held', ?6, ?7, ?7)",
            params![
                attempt_id,
                operation_id,
                workspace_key,
                provider,
                binding_json,
                detail_json,
                timestamp
            ],
        )?;
        let lease_rows = {
            let mut statement = tx.prepare(
                "SELECT id, workspace_key FROM workspace_leases
                 WHERE state IN ('ACTIVE','RELEASING')",
            )?;
            let rows = statement.query_map([], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        for (lease_id, lease_workspace) in lease_rows {
            if workspace_keys_overlap(&lease_workspace, &workspace_key) {
                tx.execute(
                    "UPDATE workspace_leases SET state='UNCERTAIN', last_heartbeat=?1
                     WHERE id=?2 AND state IN ('ACTIVE','RELEASING')",
                    params![timestamp, lease_id],
                )?;
            }
        }
        let responsibility = stop_responsibility_for_attempt_on(&tx, attempt_id)?
            .ok_or_else(|| StoreError::NotFound(format!("Stop responsibility {attempt_id}")))?;
        tx.commit()?;
        Ok(BeginStopResponsibilityOutcome {
            responsibility,
            inserted: true,
        })
    }

    pub fn stop_responsibility_for_attempt(
        &self,
        attempt_id: &str,
    ) -> Result<Option<StopResponsibility>, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        stop_responsibility_for_attempt_on(&connection, attempt_id)
    }

    pub fn stop_responsibilities(&self) -> Result<Vec<StopResponsibility>, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        let mut statement = connection.prepare(
            "SELECT attempt_id, operation_id, workspace_key, provider, binding_json,
                    native_turn_state, residual_execution_state, write_responsibility,
                    detail_json, created_at, updated_at
             FROM stop_responsibilities ORDER BY created_at, attempt_id",
        )?;
        let rows = statement.query_map([], stop_responsibility_from_row)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn held_stop_for_workspace(
        &self,
        workspace_key: &str,
    ) -> Result<Option<StopResponsibility>, StoreError> {
        self.held_stop_for_workspace_prefer(workspace_key, None)
    }

    pub fn held_stop_for_workspace_prefer(
        &self,
        workspace_key: &str,
        preferred_attempt_id: Option<&str>,
    ) -> Result<Option<StopResponsibility>, StoreError> {
        let requested = crate::domain::normalize_workspace_key(Path::new(workspace_key));
        let rows = self
            .stop_responsibilities()?
            .into_iter()
            .filter(|row| workspace_keys_overlap(&row.workspace_key, &requested))
            .collect::<Vec<_>>();
        Ok(preferred_attempt_id
            .and_then(|attempt_id| {
                rows.iter()
                    .find(|row| row.attempt_id == attempt_id)
                    .cloned()
            })
            .or_else(|| rows.into_iter().next()))
    }

    /// Append one re-check. There is no update or delete counterpart by design: the
    /// fact layer is a ledger, so a later observation never rewrites an earlier one.
    ///
    /// This never touches `stop_responsibilities`. A re-check reports; it does not
    /// decide, and it cannot release, downgrade or transfer responsibility.
    pub fn record_recheck_observation(
        &self,
        observation: &NewRecheckObservation,
    ) -> Result<StopRecheckObservation, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        let observed_at = now();
        connection.execute(
            "INSERT INTO stop_recheck_observations(
                 id, attempt_id, operation_id, workspace_key, core_epoch_id, observed_at,
                 bound_runtime_json, runtime_observation, observation_detail_json,
                 active_lease_count, pending_outbox_count, attempt_state, verdict
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                observation.id,
                observation.attempt_id,
                observation.operation_id,
                observation.workspace_key,
                observation.core_epoch_id,
                observed_at,
                observation.bound_runtime.to_string(),
                observation.runtime_observation.as_str(),
                observation.observation_detail.to_string(),
                observation.active_lease_count,
                observation.pending_outbox_count,
                observation.attempt_state,
                observation.verdict.as_str(),
            ],
        )?;
        let seq = connection.last_insert_rowid();
        Ok(StopRecheckObservation {
            seq,
            id: observation.id.clone(),
            attempt_id: observation.attempt_id.clone(),
            operation_id: observation.operation_id.clone(),
            workspace_key: observation.workspace_key.clone(),
            core_epoch_id: observation.core_epoch_id.clone(),
            observed_at,
            bound_runtime: observation.bound_runtime.clone(),
            runtime_observation: observation.runtime_observation,
            observation_detail: observation.observation_detail.clone(),
            active_lease_count: observation.active_lease_count,
            pending_outbox_count: observation.pending_outbox_count,
            attempt_state: observation.attempt_state.clone(),
            verdict: observation.verdict,
        })
    }

    pub fn recheck_observations_for_attempt(
        &self,
        attempt_id: &str,
    ) -> Result<Vec<StopRecheckObservation>, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        let mut statement = connection.prepare(
            "SELECT seq, id, attempt_id, operation_id, workspace_key, core_epoch_id,
                    observed_at, bound_runtime_json, runtime_observation,
                    observation_detail_json, active_lease_count, pending_outbox_count,
                    attempt_state, verdict
             FROM stop_recheck_observations WHERE attempt_id=?1 ORDER BY seq",
        )?;
        let rows = statement.query_map(params![attempt_id], recheck_observation_from_row)?;
        rows.collect::<Result<Vec<_>, rusqlite::Error>>()
            .map_err(StoreError::from)
    }

    /// The newest re-check by `seq`, which is the only ordering that is safe here:
    /// `observed_at` is millisecond TEXT and two re-checks can tie on it.
    pub fn latest_recheck_observation(
        &self,
        attempt_id: &str,
    ) -> Result<Option<StopRecheckObservation>, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        connection
            .query_row(
                "SELECT seq, id, attempt_id, operation_id, workspace_key, core_epoch_id,
                        observed_at, bound_runtime_json, runtime_observation,
                        observation_detail_json, active_lease_count, pending_outbox_count,
                        attempt_state, verdict
                 FROM stop_recheck_observations WHERE attempt_id=?1
                 ORDER BY seq DESC LIMIT 1",
                params![attempt_id],
                recheck_observation_from_row,
            )
            .optional()
            .map_err(StoreError::from)
    }

    /// Record a continuation decision. Single-use per (source attempt, target
    /// workspace): the UNIQUE constraint makes a replayed request a conflict
    /// rather than a second continuation.
    ///
    /// Deliberately does not touch `stop_responsibilities`. If this ever needs to,
    /// that is a design change to argue for, not an implementation detail.
    pub fn record_stop_continuation(
        &self,
        continuation: &StopContinuation,
    ) -> Result<StopContinuation, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        let changed = connection.execute(
            "INSERT OR IGNORE INTO stop_continuations(
                 id, source_attempt_id, source_operation_id, source_task_id,
                 source_campaign_id, source_workspace_key, target_workspace_key,
                 new_attempt_id, new_project_id, new_campaign_id, new_task_id,
                 basis_observation_id, carried_context_json,
                 authorization_granted_json, isolation_disclosure_json,
                 decided_at, applied_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
            params![
                continuation.id,
                continuation.source_attempt_id,
                continuation.source_operation_id,
                continuation.source_task_id,
                continuation.source_campaign_id,
                continuation.source_workspace_key,
                continuation.target_workspace_key,
                continuation.new_attempt_id,
                continuation.new_project_id,
                continuation.new_campaign_id,
                continuation.new_task_id,
                continuation.basis_observation_id,
                continuation.carried_context.to_string(),
                continuation.authorization_granted.to_string(),
                continuation.isolation_disclosure.to_string(),
                continuation.decided_at,
                continuation.applied_at,
            ],
        )?;
        if changed == 0 {
            let existing = connection
                .query_row(
                    "SELECT target_workspace_key FROM stop_continuations WHERE source_attempt_id=?1",
                    params![continuation.source_attempt_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
                .unwrap_or_default();
            return Err(StoreError::InvalidState(format!(
                "attempt {} already has a continuation, in {existing}. A repeat click, a reopened window or a replayed request never mints a second one; continue working there, or take a new decision explicitly.",
                continuation.source_attempt_id
            )));
        }
        Ok(continuation.clone())
    }

    pub fn stop_continuations_for_source(
        &self,
        source_attempt_id: &str,
    ) -> Result<Vec<StopContinuation>, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        let mut statement = connection.prepare(
            "SELECT id, source_attempt_id, source_operation_id, source_task_id,
                    source_campaign_id, source_workspace_key, target_workspace_key,
                    new_attempt_id, new_project_id, new_campaign_id, new_task_id,
                    basis_observation_id, carried_context_json,
                    authorization_granted_json, isolation_disclosure_json,
                    decided_at, applied_at
             FROM stop_continuations WHERE source_attempt_id=?1 ORDER BY rowid",
        )?;
        let rows = statement.query_map(params![source_attempt_id], stop_continuation_from_row)?;
        rows.collect::<Result<Vec<_>, rusqlite::Error>>()
            .map_err(StoreError::from)
    }

    pub fn stop_continuation_for_new_attempt(
        &self,
        new_attempt_id: &str,
    ) -> Result<Option<StopContinuation>, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        connection
            .query_row(
                "SELECT id, source_attempt_id, source_operation_id, source_task_id,
                        source_campaign_id, source_workspace_key, target_workspace_key,
                        new_attempt_id, new_project_id, new_campaign_id, new_task_id,
                        basis_observation_id, carried_context_json,
                        authorization_granted_json, isolation_disclosure_json,
                        decided_at, applied_at
                 FROM stop_continuations WHERE new_attempt_id=?1 LIMIT 1",
                params![new_attempt_id],
                stop_continuation_from_row,
            )
            .optional()
            .map_err(StoreError::from)
    }

    pub fn update_stop_responsibility(
        &self,
        update: &StopResponsibilityUpdate,
    ) -> Result<Option<StopResponsibility>, StoreError> {
        if update.native_turn_state == StopNativeTurnState::Interrupted {
            validate_stop_binding(&update.binding)?;
        }
        if !matches!(
            update.residual_execution_state.as_str(),
            "unknown" | "active"
        ) {
            return Err(StoreError::InvalidState(
                "Stop residual execution state must be unknown or active".into(),
            ));
        }
        let mut connection = self.inner.lock().expect("store mutex poisoned");
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = tx
            .query_row(
                "SELECT attempt_id, operation_id, workspace_key, provider, binding_json,
                        native_turn_state, residual_execution_state, write_responsibility,
                        detail_json, created_at, updated_at
                 FROM stop_responsibilities WHERE operation_id=?1",
                params![update.operation_id],
                stop_responsibility_from_row,
            )
            .optional()?;
        let Some(current) = current else {
            tx.commit()?;
            return Ok(None);
        };
        if current.attempt_id != update.attempt_id || current.binding != update.binding {
            tx.commit()?;
            return Ok(None);
        }
        let native_turn_state = if current.native_turn_state == StopNativeTurnState::Interrupted {
            StopNativeTurnState::Interrupted
        } else {
            update.native_turn_state
        };
        let residual_execution_state = if current.residual_execution_state == "active" {
            "active"
        } else {
            update.residual_execution_state.as_str()
        };
        let detail_json = update
            .detail
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        tx.execute(
            "UPDATE stop_responsibilities
             SET native_turn_state=?1, residual_execution_state=?2,
                 detail_json=COALESCE(?3, detail_json), updated_at=?4
             WHERE attempt_id=?5 AND operation_id=?6 AND binding_json=?7",
            params![
                stop_native_turn_state_string(native_turn_state),
                residual_execution_state,
                detail_json,
                now(),
                update.attempt_id,
                update.operation_id,
                serde_json::to_string(&update.binding)?
            ],
        )?;
        let updated = stop_responsibility_for_attempt_on(&tx, &current.attempt_id)?;
        tx.commit()?;
        Ok(updated)
    }

    pub fn mark_dispatching_outbox_unknown(&self) -> Result<usize, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        Ok(connection.execute(
            "UPDATE outbox
             SET state='UNKNOWN', last_error='Core restart without external acknowledgement', updated_at=?1
             WHERE state='DISPATCHING'",
            params![now()],
        )?)
    }

    pub fn insert_decision(&self, decision: &Decision) -> Result<(), StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        insert_or_conflict(
            &connection,
            "SELECT attempt_id, kind, state FROM decisions WHERE id=?1",
            params![decision.id],
            &decision.id,
            |row| {
                row.get::<_, String>(0)
                    .is_ok_and(|value| value == decision.attempt_id)
                    && row
                        .get::<_, String>(1)
                        .is_ok_and(|value| value == decision.kind)
                    && row
                        .get::<_, String>(2)
                        .is_ok_and(|value| value == decision_state_string(decision.state))
            },
            "INSERT INTO decisions(id, attempt_id, kind, state) VALUES (?1, ?2, ?3, ?4)",
            params![
                decision.id,
                decision.attempt_id,
                decision.kind,
                decision_state_string(decision.state)
            ],
        )
    }

    pub fn get_decision(&self, id: &str) -> Result<Decision, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        connection
            .query_row(
                "SELECT attempt_id, kind, state FROM decisions WHERE id=?1",
                params![id],
                |row| {
                    Ok(Decision {
                        id: id.into(),
                        attempt_id: row.get(0)?,
                        kind: row.get(1)?,
                        state: parse_decision_state(&row.get::<_, String>(2)?)
                            .map_err(to_sql_error)?,
                    })
                },
            )
            .optional()?
            .ok_or_else(|| StoreError::NotFound(format!("decision {id}")))
    }

    pub fn list_decisions(&self) -> Result<Vec<Decision>, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        let mut statement = connection
            .prepare("SELECT id, attempt_id, kind, state FROM decisions ORDER BY rowid, id")?;
        let rows = statement.query_map([], |row| {
            Ok(Decision {
                id: row.get(0)?,
                attempt_id: row.get(1)?,
                kind: row.get(2)?,
                state: parse_decision_state(&row.get::<_, String>(3)?).map_err(to_sql_error)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn decisions_for_attempt(
        &self,
        attempt_id: &str,
        limit: usize,
    ) -> Result<Vec<Decision>, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        let mut statement = connection.prepare(
            "SELECT id, attempt_id, kind, state FROM decisions
             WHERE attempt_id=?1
             ORDER BY (state='PENDING') DESC, rowid DESC LIMIT ?2",
        )?;
        let rows = statement.query_map(params![attempt_id, limit as i64], |row| {
            Ok(Decision {
                id: row.get(0)?,
                attempt_id: row.get(1)?,
                kind: row.get(2)?,
                state: parse_decision_state(&row.get::<_, String>(3)?).map_err(to_sql_error)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn update_decision_state(
        &self,
        id: &str,
        state: DecisionState,
    ) -> Result<Decision, StoreError> {
        let current = self.get_decision(id)?;
        if current.state != state && !current.state.can_transition_to(state) {
            return Err(StoreError::InvalidState(format!(
                "decision {id} cannot transition from {:?} to {:?}",
                current.state, state
            )));
        }
        let connection = self.inner.lock().expect("store mutex poisoned");
        let changed = connection.execute(
            "UPDATE decisions SET state=?, version=version+1 WHERE id=?",
            params![decision_state_string(state), id],
        )?;
        if changed == 0 {
            return Err(StoreError::NotFound(format!("decision {id}")));
        }
        connection
            .query_row(
                "SELECT attempt_id, kind, state FROM decisions WHERE id=?1",
                params![id],
                |row| {
                    Ok(Decision {
                        id: id.into(),
                        attempt_id: row.get(0)?,
                        kind: row.get(1)?,
                        state: parse_decision_state(&row.get::<_, String>(2)?)
                            .map_err(to_sql_error)?,
                    })
                },
            )
            .map_err(StoreError::from)
    }

    pub fn insert_evidence(&self, evidence: &Evidence) -> Result<(), StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        insert_or_conflict(
            &connection,
            "SELECT attempt_id, claim, snapshot_hash, verdict FROM evidence WHERE id=?1",
            params![evidence.id],
            &evidence.id,
            |row| {
                row.get::<_, String>(0)
                    .is_ok_and(|value| value == evidence.attempt_id)
                    && row
                        .get::<_, String>(1)
                        .is_ok_and(|value| value == evidence.claim)
                    && row
                        .get::<_, String>(2)
                        .is_ok_and(|value| value == evidence.snapshot_hash)
                    && row
                        .get::<_, String>(3)
                        .is_ok_and(|value| value == verdict_string(evidence.verdict))
            },
            "INSERT INTO evidence(id, attempt_id, claim, snapshot_hash, verdict, captured_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                evidence.id,
                evidence.attempt_id,
                evidence.claim,
                evidence.snapshot_hash,
                verdict_string(evidence.verdict),
                now()
            ],
        )
    }

    pub fn get_evidence(&self, id: &str) -> Result<Evidence, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        connection
            .query_row(
                "SELECT attempt_id, claim, snapshot_hash, verdict FROM evidence WHERE id=?1",
                params![id],
                |row| {
                    Ok(Evidence {
                        id: id.to_string(),
                        attempt_id: row.get(0)?,
                        claim: row.get(1)?,
                        snapshot_hash: row.get(2)?,
                        verdict: parse_verdict(&row.get::<_, String>(3)?)?,
                    })
                },
            )
            .optional()?
            .ok_or_else(|| StoreError::NotFound(format!("evidence {id}")))
    }

    pub fn list_evidence(&self) -> Result<Vec<Evidence>, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        let mut statement = connection.prepare(
            "SELECT id, attempt_id, claim, snapshot_hash, verdict FROM evidence ORDER BY rowid, id",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(Evidence {
                id: row.get(0)?,
                attempt_id: row.get(1)?,
                claim: row.get(2)?,
                snapshot_hash: row.get(3)?,
                verdict: parse_verdict(&row.get::<_, String>(4)?)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn evidence_for_attempt(
        &self,
        attempt_id: &str,
        limit: usize,
    ) -> Result<Vec<Evidence>, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        let mut statement = connection.prepare(
            "SELECT id, attempt_id, claim, snapshot_hash, verdict FROM evidence
             WHERE attempt_id=?1 ORDER BY rowid DESC LIMIT ?2",
        )?;
        let rows = statement.query_map(params![attempt_id, limit as i64], |row| {
            Ok(Evidence {
                id: row.get(0)?,
                attempt_id: row.get(1)?,
                claim: row.get(2)?,
                snapshot_hash: row.get(3)?,
                verdict: parse_verdict(&row.get::<_, String>(4)?)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn evidence_is_stale(
        &self,
        id: &str,
        current_snapshot_hash: &str,
    ) -> Result<bool, StoreError> {
        Ok(self.get_evidence(id)?.is_stale_for(current_snapshot_hash))
    }

    pub fn insert_outbox(&self, intent: &OutboxIntent) -> Result<(), StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        insert_or_conflict(
            &connection,
            "SELECT command_id, effect_kind, target, state FROM outbox WHERE id=?1",
            params![intent.id],
            &intent.id,
            |row| {
                row.get::<_, String>(0)
                    .is_ok_and(|value| value == intent.command_id)
                    && row
                        .get::<_, String>(1)
                        .is_ok_and(|value| value == intent.effect_kind)
                    && row
                        .get::<_, String>(2)
                        .is_ok_and(|value| value == intent.target)
                    && row
                        .get::<_, String>(3)
                        .is_ok_and(|value| value == outbox_state_string(intent.state))
            },
            "INSERT INTO outbox(id, command_id, effect_kind, target, state, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            params![
                intent.id,
                intent.command_id,
                intent.effect_kind,
                intent.target,
                outbox_state_string(intent.state),
                now()
            ],
        )
    }

    pub fn update_outbox_state(
        &self,
        id: &str,
        state: OutboxState,
        error: Option<&str>,
    ) -> Result<OutboxIntent, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        let current = connection
            .query_row(
                "SELECT command_id, effect_kind, target, state FROM outbox WHERE id=?1",
                params![id],
                |row| {
                    Ok(OutboxIntent {
                        id: id.to_string(),
                        command_id: row.get(0)?,
                        effect_kind: row.get(1)?,
                        target: row.get(2)?,
                        state: parse_outbox_state(&row.get::<_, String>(3)?)?,
                    })
                },
            )
            .optional()?
            .ok_or_else(|| StoreError::NotFound(format!("outbox {id}")))?;
        if state == OutboxState::Dispatching {
            let (attempt_id, target): (String, String) = connection.query_row(
                "SELECT c.attempt_id, o.target
                 FROM outbox o INNER JOIN commands c ON c.id=o.command_id
                 WHERE o.id=?1",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            ensure_outbox_dispatch_not_held(&connection, &attempt_id, &target)?;
        }
        if current.state != state && !current.state.can_transition_to(state) {
            return Err(StoreError::InvalidState(format!(
                "outbox {id} cannot transition from {:?} to {:?}",
                current.state, state
            )));
        }
        let changed = connection.execute(
            "UPDATE outbox SET state=?, last_error=?, updated_at=? WHERE id=?",
            params![outbox_state_string(state), error, now(), id],
        )?;
        debug_assert_eq!(changed, 1);
        connection
            .query_row(
                "SELECT command_id, effect_kind, target, state FROM outbox WHERE id=?1",
                params![id],
                |row| {
                    Ok(OutboxIntent {
                        id: id.to_string(),
                        command_id: row.get(0)?,
                        effect_kind: row.get(1)?,
                        target: row.get(2)?,
                        state: parse_outbox_state(&row.get::<_, String>(3)?)?,
                    })
                },
            )
            .map_err(StoreError::from)
    }

    /// Explicit reconciliation is the only path that can resolve an UNKNOWN
    /// external effect. It records the caller's observed result without allowing
    /// a scheduler to treat UNKNOWN as retryable.
    pub fn reconcile_outbox(
        &self,
        id: &str,
        state: OutboxState,
        evidence: &str,
    ) -> Result<OutboxIntent, StoreError> {
        if !matches!(state, OutboxState::Succeeded | OutboxState::Failed) {
            return Err(StoreError::InvalidState(
                "reconciliation must record SUCCEEDED or FAILED".into(),
            ));
        }
        let connection = self.inner.lock().expect("store mutex poisoned");
        let current: OutboxState = connection
            .query_row("SELECT state FROM outbox WHERE id=?1", params![id], |row| {
                parse_outbox_state(&row.get::<_, String>(0)?)
            })
            .optional()?
            .ok_or_else(|| StoreError::NotFound(format!("outbox {id}")))?;
        if current != OutboxState::Unknown {
            return Err(StoreError::InvalidState(format!(
                "outbox {id} is not UNKNOWN"
            )));
        }
        let changed = connection.execute(
            "UPDATE outbox SET state=?, last_error=?, updated_at=? WHERE id=?",
            params![outbox_state_string(state), evidence, now(), id],
        )?;
        debug_assert_eq!(changed, 1);
        connection
            .query_row(
                "SELECT command_id, effect_kind, target, state FROM outbox WHERE id=?1",
                params![id],
                |row| {
                    Ok(OutboxIntent {
                        id: id.to_string(),
                        command_id: row.get(0)?,
                        effect_kind: row.get(1)?,
                        target: row.get(2)?,
                        state: parse_outbox_state(&row.get::<_, String>(3)?)?,
                    })
                },
            )
            .map_err(StoreError::from)
    }

    /// An unknown external effect is terminal until an explicit reconciliation command
    /// records what actually happened. It is intentionally excluded from retryable work.
    pub fn mark_outbox_unknown(&self, id: &str, reason: &str) -> Result<OutboxIntent, StoreError> {
        self.update_outbox_state(id, OutboxState::Unknown, Some(reason))
    }

    pub fn get_outbox(&self, id: &str) -> Result<OutboxIntent, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        connection
            .query_row(
                "SELECT command_id, effect_kind, target, state FROM outbox WHERE id=?1",
                params![id],
                |row| {
                    Ok(OutboxIntent {
                        id: id.into(),
                        command_id: row.get(0)?,
                        effect_kind: row.get(1)?,
                        target: row.get(2)?,
                        state: parse_outbox_state(&row.get::<_, String>(3)?)?,
                    })
                },
            )
            .optional()?
            .ok_or_else(|| StoreError::NotFound(format!("outbox {id}")))
    }

    pub fn retryable_outbox(&self) -> Result<Vec<OutboxIntent>, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        let mut statement = connection.prepare(
            "SELECT o.id, o.command_id, o.effect_kind, o.target, o.state, c.attempt_id
             FROM outbox o INNER JOIN commands c ON c.id=o.command_id
             WHERE o.state IN ('PENDING','FAILED')
             ORDER BY o.created_at",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                OutboxIntent {
                    id: row.get(0)?,
                    command_id: row.get(1)?,
                    effect_kind: row.get(2)?,
                    target: row.get(3)?,
                    state: parse_outbox_state(&row.get::<_, String>(4)?)?,
                },
                row.get::<_, String>(5)?,
            ))
        })?;
        let candidates = rows.collect::<Result<Vec<_>, rusqlite::Error>>()?;
        drop(statement);
        let mut retryable = Vec::new();
        for (intent, attempt_id) in candidates {
            match ensure_outbox_dispatch_not_held(&connection, &attempt_id, &intent.target) {
                Ok(()) => retryable.push(intent),
                Err(StoreError::StopResponsibilityConflict { .. }) => {}
                Err(error) => return Err(error),
            }
        }
        Ok(retryable)
    }

    pub fn outbox_for_attempt(&self, attempt_id: &str) -> Result<Vec<OutboxIntent>, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        let mut statement = connection.prepare(
            "SELECT o.id, o.command_id, o.effect_kind, o.target, o.state
             FROM outbox o INNER JOIN commands c ON c.id=o.command_id
             WHERE c.attempt_id=?1 ORDER BY o.created_at, o.id",
        )?;
        let rows = statement.query_map(params![attempt_id], |row| {
            Ok(OutboxIntent {
                id: row.get(0)?,
                command_id: row.get(1)?,
                effect_kind: row.get(2)?,
                target: row.get(3)?,
                state: parse_outbox_state(&row.get::<_, String>(4)?)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn counts(&self) -> Result<StoreCounts, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        Ok(StoreCounts {
            projects: table_count(&connection, "projects")?,
            campaigns: table_count(&connection, "campaigns")?,
            tasks: table_count(&connection, "tasks")?,
            attempts: table_count(&connection, "attempts")?,
            commands: table_count(&connection, "commands")?,
            events: table_count(&connection, "events")?,
            decisions: table_count(&connection, "decisions")?,
            evidence: table_count(&connection, "evidence")?,
            outbox: table_count(&connection, "outbox")?,
        })
    }

    pub fn snapshot(&self) -> Result<StoreCounts, StoreError> {
        self.counts()
    }

    pub fn upsert_attempt_recovery(&self, record: &AttemptRecovery) -> Result<(), StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        connection.execute(
            "INSERT INTO attempt_recovery(
                 attempt_id, provider, session_hash, process_epoch, pid, last_seq,
                 pending_permission_ids, outbox_ids, lease_workspace_key, recovery_class,
                 prompt_replay, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT(attempt_id) DO UPDATE SET
                 provider=excluded.provider,
                 session_hash=excluded.session_hash,
                 process_epoch=excluded.process_epoch,
                 pid=excluded.pid,
                 last_seq=excluded.last_seq,
                 pending_permission_ids=excluded.pending_permission_ids,
                 outbox_ids=excluded.outbox_ids,
                 lease_workspace_key=excluded.lease_workspace_key,
                 recovery_class=excluded.recovery_class,
                 prompt_replay=excluded.prompt_replay,
                 updated_at=excluded.updated_at",
            params![
                record.attempt_id,
                record.provider,
                record.session_hash,
                record.process_epoch,
                record.pid,
                record.last_seq,
                record.pending_permission_ids,
                record.outbox_ids,
                record.lease_workspace_key,
                record.recovery_class,
                if record.prompt_replay { 1 } else { 0 },
                now()
            ],
        )?;
        Ok(())
    }

    pub fn get_attempt_recovery(
        &self,
        attempt_id: &str,
    ) -> Result<Option<AttemptRecovery>, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        Ok(connection
            .query_row(
                "SELECT attempt_id, provider, session_hash, process_epoch, pid, last_seq,
                        pending_permission_ids, outbox_ids, lease_workspace_key, recovery_class, prompt_replay
                 FROM attempt_recovery WHERE attempt_id=?1",
                params![attempt_id],
                |row| {
                    Ok(AttemptRecovery {
                        attempt_id: row.get(0)?,
                        provider: row.get(1)?,
                        session_hash: row.get(2)?,
                        process_epoch: row.get(3)?,
                        pid: row.get(4)?,
                        last_seq: row.get(5)?,
                        pending_permission_ids: row.get(6)?,
                        outbox_ids: row.get(7)?,
                        lease_workspace_key: row.get(8)?,
                        recovery_class: row.get(9)?,
                        prompt_replay: row.get::<_, i64>(10)? != 0,
                    })
                },
            )
            .optional()?)
    }

    pub fn list_attempt_recovery(&self) -> Result<Vec<AttemptRecovery>, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        let mut statement = connection.prepare(
            "SELECT attempt_id, provider, session_hash, process_epoch, pid, last_seq,
                    pending_permission_ids, outbox_ids, lease_workspace_key, recovery_class, prompt_replay
             FROM attempt_recovery ORDER BY attempt_id",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(AttemptRecovery {
                attempt_id: row.get(0)?,
                provider: row.get(1)?,
                session_hash: row.get(2)?,
                process_epoch: row.get(3)?,
                pid: row.get(4)?,
                last_seq: row.get(5)?,
                pending_permission_ids: row.get(6)?,
                outbox_ids: row.get(7)?,
                lease_workspace_key: row.get(8)?,
                recovery_class: row.get(9)?,
                prompt_replay: row.get::<_, i64>(10)? != 0,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn insert_policy_snapshot(
        &self,
        id: &str,
        campaign_id: &str,
        payload_json: &str,
    ) -> Result<(), StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        connection.execute(
            "INSERT OR IGNORE INTO policy_snapshots(id, campaign_id, payload_json, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![id, campaign_id, payload_json, now()],
        )?;
        Ok(())
    }

    pub fn policy_snapshots_for_campaign(
        &self,
        campaign_id: &str,
    ) -> Result<Vec<(String, String)>, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        let mut statement = connection.prepare(
            "SELECT id, payload_json FROM policy_snapshots WHERE campaign_id=?1 ORDER BY created_at, id",
        )?;
        let rows =
            statement.query_map(params![campaign_id], |row| Ok((row.get(0)?, row.get(1)?)))?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn set_campaign_authorization(
        &self,
        campaign_id: &str,
        auth: &CampaignAuthorization,
    ) -> Result<(), StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        connection.execute(
            "INSERT INTO campaign_authorizations(campaign_id, provider_authorized, transfer_authorized, action_authorized, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(campaign_id) DO UPDATE SET
                 provider_authorized=excluded.provider_authorized,
                 transfer_authorized=excluded.transfer_authorized,
                 action_authorized=excluded.action_authorized,
                 updated_at=excluded.updated_at",
            params![
                campaign_id,
                if auth.provider_authorized { 1 } else { 0 },
                if auth.transfer_authorized { 1 } else { 0 },
                if auth.action_authorized { 1 } else { 0 },
                now()
            ],
        )?;
        Ok(())
    }

    pub fn get_campaign_authorization(
        &self,
        campaign_id: &str,
    ) -> Result<CampaignAuthorization, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        Ok(connection
            .query_row(
                "SELECT provider_authorized, transfer_authorized, action_authorized FROM campaign_authorizations WHERE campaign_id=?1",
                params![campaign_id],
                |row| {
                    Ok(CampaignAuthorization {
                        provider_authorized: row.get::<_, i64>(0)? != 0,
                        transfer_authorized: row.get::<_, i64>(1)? != 0,
                        action_authorized: row.get::<_, i64>(2)? != 0,
                    })
                },
            )
            .optional()?
            .unwrap_or_else(CampaignAuthorization::denied))
    }

    pub fn enqueue_admission(
        &self,
        id: &str,
        attempt_id: Option<&str>,
        reason: &str,
        request_json: Option<&str>,
    ) -> Result<(), StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        connection.execute(
            "INSERT OR IGNORE INTO admission_queue(id, attempt_id, reason, created_at, request_json) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, attempt_id, reason, now(), request_json],
        )?;
        Ok(())
    }

    pub fn get_admission(&self, id: &str) -> Result<AdmissionRow, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        connection
            .query_row(
                "SELECT id, attempt_id, reason, override_reason, request_json FROM admission_queue WHERE id=?1",
                params![id],
                admission_row_from_sql,
            )
            .optional()?
            .ok_or_else(|| StoreError::NotFound(format!("admission {id}")))
    }

    pub fn override_admission(&self, id: &str, override_reason: &str) -> Result<(), StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        let changed = connection.execute(
            "UPDATE admission_queue SET override_reason=?1 WHERE id=?2",
            params![override_reason, id],
        )?;
        if changed == 0 {
            return Err(StoreError::NotFound(format!("admission {id}")));
        }
        Ok(())
    }

    pub fn pending_admissions(&self) -> Result<Vec<AdmissionRow>, StoreError> {
        let connection = self.inner.lock().expect("store mutex poisoned");
        let mut statement = connection.prepare(
            "SELECT id, attempt_id, reason, override_reason, request_json FROM admission_queue ORDER BY created_at, id",
        )?;
        let rows = statement.query_map([], admission_row_from_sql)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }
}

fn match_workspace_project<F>(
    projects: &[Project],
    proposed: &Project,
    canonicalize: F,
) -> Result<Option<Project>, StoreError>
where
    F: Fn(&str) -> Option<std::path::PathBuf>,
{
    let requested_key = crate::domain::normalize_workspace_key(Path::new(&proposed.workspace_root));
    let requested_identity = canonicalize(&proposed.workspace_root);
    let candidates = projects
        .iter()
        .map(|project| {
            let conservative_key =
                crate::domain::normalize_workspace_key(Path::new(&project.workspace_root));
            let canonical_identity = canonicalize(&project.workspace_root);
            (project, conservative_key, canonical_identity)
        })
        .collect::<Vec<_>>();

    if let Some(requested_identity) = requested_identity.as_ref() {
        let actual = candidates
            .iter()
            .filter(|(_, _, identity)| identity.as_ref() == Some(requested_identity))
            .collect::<Vec<_>>();
        let conservative_conflicts = candidates
            .iter()
            .filter(|(_, key, identity)| {
                key == &requested_key && identity.as_ref() != Some(requested_identity)
            })
            .count();
        if actual.len() > 1 || conservative_conflicts > 0 {
            return Err(StoreError::InvalidState(format!(
                "workspace identity is ambiguous across {} projects; creation refused",
                actual.len() + conservative_conflicts
            )));
        }
        return Ok(actual.first().map(|(project, _, _)| (*project).clone()));
    }

    let conservative = candidates
        .iter()
        .filter(|(_, key, _)| key == &requested_key)
        .collect::<Vec<_>>();
    let exact = conservative.iter().filter(|(project, _, _)| {
        project.id == proposed.id && project.workspace_root == proposed.workspace_root
    });
    if conservative.len() == 1 {
        if let Some((project, _, _)) = exact.into_iter().next() {
            return Ok(Some((*project).clone()));
        }
    }
    if !conservative.is_empty() {
        return Err(StoreError::InvalidState(format!(
            "workspace identity is ambiguous across {} projects; creation refused",
            conservative.len()
        )));
    }
    Ok(None)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AdmissionRow {
    pub id: String,
    pub attempt_id: Option<String>,
    pub reason: String,
    pub override_reason: Option<String>,
    pub request_json: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CampaignAuthorization {
    pub provider_authorized: bool,
    pub transfer_authorized: bool,
    pub action_authorized: bool,
}

impl CampaignAuthorization {
    pub fn granted() -> Self {
        Self {
            provider_authorized: true,
            transfer_authorized: true,
            action_authorized: true,
        }
    }

    pub fn denied() -> Self {
        Self {
            provider_authorized: false,
            transfer_authorized: false,
            action_authorized: false,
        }
    }
}

impl Default for CampaignAuthorization {
    fn default() -> Self {
        Self::denied()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct AttemptRecovery {
    pub attempt_id: String,
    pub provider: String,
    pub session_hash: Option<String>,
    pub process_epoch: Option<String>,
    pub pid: Option<i64>,
    pub last_seq: i64,
    pub pending_permission_ids: String,
    pub outbox_ids: String,
    pub lease_workspace_key: Option<String>,
    pub recovery_class: Option<String>,
    pub prompt_replay: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct StoreCounts {
    pub projects: i64,
    pub campaigns: i64,
    pub tasks: i64,
    pub attempts: i64,
    pub commands: i64,
    pub events: i64,
    pub decisions: i64,
    pub evidence: i64,
    pub outbox: i64,
}

// Shared by presentation and the transactional successor admission. A state
// name alone is not proof of a confirmed native cancellation.
fn cancellation_confirmed_on(
    connection: &Connection,
    attempt_id: &str,
) -> Result<bool, StoreError> {
    let found: Option<i64> = connection.query_row(
        "SELECT 1 FROM events WHERE attempt_id=?1 AND state_after='CANCELLED' AND (
           (kind='attempt.cancelled' AND json_extract(payload_json,'$.confirmed')=1)
           OR kind='runtime.turn.cancelled'
           OR (kind='runtime.turn.completed' AND json_extract(payload_json,'$.status') IN ('interrupted','cancelled'))
         ) LIMIT 1",
        params![attempt_id], |row| row.get(0),
    ).optional()?;
    Ok(found.is_some())
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventRecord {
    pub event: Event,
    pub payload: Option<Value>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OrderedEventRecord {
    /// Campaign-wide product order for conversation pages, or per-attempt
    /// event sequence for timeline pages.
    pub position: i64,
    pub record: EventRecord,
}

fn ordered_event_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<OrderedEventRecord> {
    let payload_json: Option<String> = row.get(6)?;
    let payload = payload_json
        .as_deref()
        .map(serde_json::from_str)
        .transpose()
        .map_err(|error| to_sql_error(DomainError::InvalidEntity(error.to_string())))?;
    Ok(OrderedEventRecord {
        position: row.get(0)?,
        record: EventRecord {
            event: Event {
                id: row.get(1)?,
                attempt_id: row.get(2)?,
                seq: row.get(3)?,
                kind: row.get(4)?,
                payload_ref: row.get(5)?,
            },
            payload,
            created_at: row.get(7)?,
        },
    })
}

/// Phase of a conversation-scope request in the R3 claim machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConversationRequestPhase {
    Prepared,
    Claimed,
    Dispatching,
    Succeeded,
    Failed,
    Unknown,
}

impl ConversationRequestPhase {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Prepared => "prepared",
            Self::Claimed => "claimed",
            Self::Dispatching => "dispatching",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Unknown => "unknown",
        }
    }

    pub const fn is_terminal(self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed | Self::Unknown)
    }

    pub fn is_settled_phase(value: &str) -> bool {
        matches!(value, "succeeded" | "failed" | "unknown")
    }
}

/// The durable row of a conversation request (first-send or explicit-send).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationRequestRow {
    pub request_id: String,
    pub payload_hash: String,
    pub campaign_id: String,
    pub task_id: String,
    pub attempt_id: String,
    pub phase: String,
    pub claim_token: String,
    pub native_command_id: String,
    pub result: Option<Value>,
    pub source_attempt_id: Option<String>,
}

impl ConversationRequestRow {
    /// A phase string a repeat must answer from the record: everything except a
    /// row this invocation itself just prepared. Recovered unsettled rows
    /// (prepared/claimed/dispatching after a restart) are repeats too — they are
    /// uncertain, never dispatched.
    pub fn phase_is_settled(&self) -> bool {
        ConversationRequestPhase::is_settled_phase(&self.phase)
    }
}

/// A new conversation_requests row to insert inside a transaction.
#[derive(Debug, Clone, PartialEq, Eq)]
struct NewConversationRequest {
    request_id: String,
    payload_hash: String,
    campaign_id: String,
    task_id: String,
    attempt_id: String,
    claim_token: String,
    native_command_id: String,
    source_attempt_id: Option<String>,
}

/// The complete first-send reservation submitted to one transaction.
#[derive(Debug, Clone)]
pub struct ConversationStart {
    pub request_id: String,
    pub payload_hash: String,
    pub claim_token: String,
    pub native_command_id: String,
    pub project: Project,
    pub campaign: Campaign,
    pub task: Task,
    pub policy_id: String,
    pub policy_payload_json: String,
    pub authorization: CampaignAuthorization,
    pub attempt: Attempt,
    pub selected_provider: String,
    pub first_user_message: String,
}

/// The same-provider successor of a durably confirmed stop.
#[derive(Debug, Clone)]
pub struct ConfirmedStopSuccessor {
    pub source_attempt_id: String,
    pub request_id: String,
    pub payload_hash: String,
    pub claim_token: String,
    pub native_command_id: String,
    pub successor_attempt: Attempt,
}

/// Result of `prepare_conversation_start` / `insert_confirmed_stop_successor`.
#[derive(Debug, Clone, PartialEq)]
pub enum ConversationPrepareOutcome {
    /// The transaction inserted the rows. `project` is None on the successor
    /// path, which reuses the existing project.
    Prepared {
        project: Option<Project>,
        row: ConversationRequestRow,
    },
    /// The request id already existed with the same payload: the recorded row is
    /// returned untouched and the caller must answer from it, never re-execute.
    Existing(ConversationRequestRow),
}

/// Persisted per-campaign product preferences.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ConversationPreference {
    pub selected_provider: Option<String>,
    pub title: Option<String>,
}

fn insert_conversation_request_on(
    tx: &Transaction<'_>,
    request: &NewConversationRequest,
) -> Result<(), StoreError> {
    tx.execute(
        "INSERT INTO conversation_requests(
             request_id, payload_hash, campaign_id, task_id, attempt_id, phase,
             claim_token, native_command_id, result_json, source_attempt_id, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, 'prepared', ?6, ?7, NULL, ?8, ?9, ?9)",
        params![
            request.request_id,
            request.payload_hash,
            request.campaign_id,
            request.task_id,
            request.attempt_id,
            request.claim_token,
            request.native_command_id,
            request.source_attempt_id,
            now()
        ],
    )?;
    Ok(())
}

fn conversation_request_on(
    connection: &Connection,
    request_id: &str,
) -> Result<Option<ConversationRequestRow>, StoreError> {
    Ok(connection
        .query_row(
            "SELECT request_id, payload_hash, campaign_id, task_id, attempt_id, phase,
                    claim_token, native_command_id, result_json, source_attempt_id
             FROM conversation_requests WHERE request_id=?1",
            params![request_id],
            |row| {
                let raw_result: Option<String> = row.get(8)?;
                Ok(ConversationRequestRow {
                    request_id: row.get(0)?,
                    payload_hash: row.get(1)?,
                    campaign_id: row.get(2)?,
                    task_id: row.get(3)?,
                    attempt_id: row.get(4)?,
                    phase: row.get(5)?,
                    claim_token: row.get(6)?,
                    native_command_id: row.get(7)?,
                    result: raw_result
                        .as_deref()
                        .and_then(|text| serde_json::from_str(text).ok()),
                    source_attempt_id: row.get(9)?,
                })
            },
        )
        .optional()?)
}

/// The transactional core of `create_workspace_campaign`, reused by the
/// first-send reservation so project/campaign/task/policy/authorization rows
/// and the conversation rows commit together (plan R2: extend/reuse the existing
/// create_workspace_campaign transaction).
fn ensure_workspace_campaign_on(
    tx: &Transaction<'_>,
    proposed_project: &Project,
    campaign: &Campaign,
    task: &Task,
    policy_id: &str,
    policy_payload_json: &str,
    authorization: &CampaignAuthorization,
) -> Result<Project, StoreError> {
    let projects = {
        let mut statement =
            tx.prepare("SELECT id, workspace_root FROM projects ORDER BY rowid, id")?;
        let rows = statement.query_map([], |row| {
            Ok(Project {
                id: row.get(0)?,
                workspace_root: row.get(1)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    let matching = match_workspace_project(&projects, proposed_project, |workspace_root| {
        std::fs::canonicalize(Path::new(workspace_root)).ok()
    })?;
    let project = if let Some(existing) = matching {
        existing
    } else {
        if let Some(existing) = projects
            .iter()
            .find(|project| project.id == proposed_project.id)
        {
            return Err(StoreError::IdempotencyConflict(existing.id.clone()));
        }
        tx.execute(
            "INSERT INTO projects(id, workspace_root) VALUES (?1, ?2)",
            params![proposed_project.id, proposed_project.workspace_root],
        )?;
        proposed_project.clone()
    };

    let campaign_existing: Option<(String, String, String)> = tx
        .query_row(
            "SELECT goal, root_task_id, state FROM campaigns WHERE id=?1",
            params![campaign.id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    if let Some((goal, root_task_id, state)) = campaign_existing {
        if goal != campaign.goal
            || root_task_id != campaign.root_task_id
            || state != work_status_string(campaign.state)
        {
            return Err(StoreError::IdempotencyConflict(campaign.id.clone()));
        }
    } else {
        tx.execute(
            "INSERT INTO campaigns(id, goal, root_task_id, state) VALUES (?1, ?2, ?3, ?4)",
            params![
                campaign.id,
                campaign.goal,
                campaign.root_task_id,
                work_status_string(campaign.state)
            ],
        )?;
    }

    let task_existing: Option<(String, String, String, String)> = tx
        .query_row(
            "SELECT campaign_id, title, acceptance, state FROM tasks WHERE id=?1",
            params![task.id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    if let Some((campaign_id, title, acceptance, state)) = task_existing {
        if campaign_id != task.campaign_id
            || title != task.title
            || acceptance != task.acceptance
            || state != work_status_string(task.state)
        {
            return Err(StoreError::IdempotencyConflict(task.id.clone()));
        }
    } else {
        tx.execute(
            "INSERT INTO tasks(id, campaign_id, title, acceptance, state) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                task.id,
                task.campaign_id,
                task.title,
                task.acceptance,
                work_status_string(task.state)
            ],
        )?;
    }

    let mapping: Option<String> = tx
        .query_row(
            "SELECT project_id FROM campaign_projects WHERE campaign_id=?1",
            params![campaign.id],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(existing_project) = mapping {
        if existing_project != project.id {
            return Err(StoreError::IdempotencyConflict(campaign.id.clone()));
        }
    } else {
        tx.execute(
            "INSERT INTO campaign_projects(campaign_id, project_id) VALUES (?1, ?2)",
            params![campaign.id, project.id],
        )?;
    }

    let existing_policy: Option<(String, String)> = tx
        .query_row(
            "SELECT campaign_id, payload_json FROM policy_snapshots WHERE id=?1",
            params![policy_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if let Some((campaign_id, payload)) = existing_policy {
        if campaign_id != campaign.id || payload != policy_payload_json {
            return Err(StoreError::IdempotencyConflict(policy_id.into()));
        }
    } else {
        tx.execute(
            "INSERT INTO policy_snapshots(id, campaign_id, payload_json, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![policy_id, campaign.id, policy_payload_json, now()],
        )?;
    }

    let existing_authorization: Option<(i64, i64, i64)> = tx
        .query_row(
            "SELECT provider_authorized, transfer_authorized, action_authorized FROM campaign_authorizations WHERE campaign_id=?1",
            params![campaign.id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let expected = (
        i64::from(authorization.provider_authorized),
        i64::from(authorization.transfer_authorized),
        i64::from(authorization.action_authorized),
    );
    if let Some(existing) = existing_authorization {
        if existing != expected {
            return Err(StoreError::IdempotencyConflict(campaign.id.clone()));
        }
    } else {
        tx.execute(
            "INSERT INTO campaign_authorizations(campaign_id, provider_authorized, transfer_authorized, action_authorized, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![campaign.id, expected.0, expected.1, expected.2, now()],
        )?;
    }
    Ok(project)
}

fn insert_or_conflict<F>(
    connection: &Connection,
    lookup_sql: &str,
    lookup_params: impl rusqlite::Params,
    id: &str,
    same: F,
    insert_sql: &str,
    insert_params: impl rusqlite::Params,
) -> Result<(), StoreError>
where
    F: FnOnce(&rusqlite::Row<'_>) -> bool,
{
    let mut statement = connection.prepare(lookup_sql)?;
    let mut rows = statement.query(lookup_params)?;
    if let Some(row) = rows.next()? {
        if same(row) {
            return Ok(());
        }
        return Err(StoreError::IdempotencyConflict(id.to_string()));
    }
    connection.execute(insert_sql, insert_params)?;
    Ok(())
}

fn table_count(connection: &Connection, table: &str) -> Result<i64, rusqlite::Error> {
    // `table` is always one of the fixed literals used by counts().
    connection.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
        row.get(0)
    })
}

fn now() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().to_string())
        .unwrap_or_else(|_| "0".into())
}

/// The same millisecond epoch stamp the durable rows carry, exposed so callers
/// outside this module can compare against `observed_at` on the same clock rather
/// than inventing a second one.
pub fn epoch_millis() -> String {
    now()
}

pub fn utc_now_iso() -> String {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    utc_millis_iso(ms)
}

pub fn utc_millis_iso(ms: u128) -> String {
    let secs = (ms / 1000) as i64;
    let milli = (ms % 1000) as u32;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400) as u32;
    let hour = rem / 3600;
    let min = (rem % 3600) / 60;
    let sec = rem % 60;
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{min:02}:{sec:02}.{milli:03}Z")
}

fn civil_from_days(days_since_unix_epoch: i64) -> (i32, u32, u32) {
    let z = days_since_unix_epoch + 719_468;
    let era = z.div_euclid(146_097);
    let doe = (z - era * 146_097) as u32;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe as i32 + era as i32 * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { year + 1 } else { year };
    (year, month, day)
}

fn runtime_epoch_binding_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<RuntimeEpochBinding> {
    Ok(RuntimeEpochBinding {
        attempt_id: row.get(0)?,
        campaign_id: row.get(1)?,
        task_id: row.get(2)?,
        provider: row.get(3)?,
        session_hash: row.get(4)?,
        process_epoch: row.get(5)?,
        runtime_pid: row.get(6)?,
        runtime_creation_date: row.get(7)?,
        runtime_executable_path: row.get(8)?,
        runtime_executable_sha256: row.get(9)?,
        core_epoch_id: row.get(10)?,
        created_at: row.get(11)?,
    })
}

fn stop_responsibility_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<StopResponsibility> {
    let binding_raw: String = row.get(4)?;
    let detail_raw: Option<String> = row.get(8)?;
    Ok(StopResponsibility {
        attempt_id: row.get(0)?,
        operation_id: row.get(1)?,
        workspace_key: row.get(2)?,
        provider: row.get(3)?,
        binding: serde_json::from_str(&binding_raw).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                4,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?,
        native_turn_state: parse_stop_native_turn_state(&row.get::<_, String>(5)?)?,
        residual_execution_state: row.get(6)?,
        write_responsibility: row.get(7)?,
        detail: detail_raw
            .map(|raw| {
                serde_json::from_str(&raw).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        8,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })
            })
            .transpose()?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

fn stop_continuation_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<StopContinuation> {
    let carried: String = row.get(12)?;
    let authorization: String = row.get(13)?;
    let disclosure: String = row.get(14)?;
    Ok(StopContinuation {
        id: row.get(0)?,
        source_attempt_id: row.get(1)?,
        source_operation_id: row.get(2)?,
        source_task_id: row.get(3)?,
        source_campaign_id: row.get(4)?,
        source_workspace_key: row.get(5)?,
        target_workspace_key: row.get(6)?,
        new_attempt_id: row.get(7)?,
        new_project_id: row.get(8)?,
        new_campaign_id: row.get(9)?,
        new_task_id: row.get(10)?,
        basis_observation_id: row.get(11)?,
        carried_context: serde_json::from_str(&carried).unwrap_or(Value::Null),
        authorization_granted: serde_json::from_str(&authorization).unwrap_or(Value::Null),
        isolation_disclosure: serde_json::from_str(&disclosure).unwrap_or(Value::Null),
        decided_at: row.get(15)?,
        applied_at: row.get(16)?,
    })
}

fn recheck_observation_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<StopRecheckObservation> {
    let bound_runtime: String = row.get(7)?;
    let detail: String = row.get(9)?;
    let observation: String = row.get(8)?;
    let verdict: String = row.get(13)?;
    Ok(StopRecheckObservation {
        seq: row.get(0)?,
        id: row.get(1)?,
        attempt_id: row.get(2)?,
        operation_id: row.get(3)?,
        workspace_key: row.get(4)?,
        core_epoch_id: row.get(5)?,
        observed_at: row.get(6)?,
        bound_runtime: serde_json::from_str(&bound_runtime).unwrap_or(Value::Null),
        runtime_observation: match observation.as_str() {
            "live" => RuntimeObservation::Live,
            "not-running" => RuntimeObservation::NotRunning,
            // The column CHECK admits only these three, so this arm is unreachable
            // through the store's own writer. It resolves to Unknown rather than
            // panicking because an unreadable observation is exactly the case that
            // must never become a safe conclusion.
            _ => RuntimeObservation::Unknown,
        },
        observation_detail: serde_json::from_str(&detail).unwrap_or(Value::Null),
        active_lease_count: row.get(10)?,
        pending_outbox_count: row.get(11)?,
        attempt_state: row.get(12)?,
        verdict: match verdict.as_str() {
            "bound-runtime-live" => RecheckVerdict::BoundRuntimeLive,
            "bound-runtime-absent-residual-still-unknown" => {
                RecheckVerdict::BoundRuntimeAbsentResidualStillUnknown
            }
            _ => RecheckVerdict::ObservationUnavailable,
        },
    })
}

fn stop_responsibility_for_attempt_on(
    connection: &Connection,
    attempt_id: &str,
) -> Result<Option<StopResponsibility>, StoreError> {
    Ok(connection
        .query_row(
            "SELECT attempt_id, operation_id, workspace_key, provider, binding_json,
                    native_turn_state, residual_execution_state, write_responsibility,
                    detail_json, created_at, updated_at
             FROM stop_responsibilities WHERE attempt_id=?1",
            params![attempt_id],
            stop_responsibility_from_row,
        )
        .optional()?)
}

fn ensure_workspace_not_held(
    connection: &Connection,
    workspace_key: &str,
) -> Result<(), StoreError> {
    let mut statement = connection.prepare(
        "SELECT attempt_id, operation_id, workspace_key
         FROM stop_responsibilities WHERE write_responsibility='held'",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    for row in rows {
        let (attempt_id, operation_id, held_workspace) = row?;
        if workspace_keys_overlap(&held_workspace, workspace_key) {
            return Err(StoreError::StopResponsibilityConflict {
                attempt_id,
                operation_id,
            });
        }
    }
    Ok(())
}

fn ensure_outbox_dispatch_not_held(
    connection: &Connection,
    attempt_id: &str,
    target: &str,
) -> Result<(), StoreError> {
    if let Some(row) = stop_responsibility_for_attempt_on(connection, attempt_id)? {
        return Err(StoreError::StopResponsibilityConflict {
            attempt_id: row.attempt_id,
            operation_id: row.operation_id,
        });
    }
    let target_key = crate::domain::normalize_workspace_key(Path::new(target));
    ensure_workspace_not_held(connection, &target_key)
}

fn validate_stop_binding(binding: &Value) -> Result<(), StoreError> {
    let Some(object) = binding.as_object() else {
        return Err(StoreError::InvalidState(
            "Stop binding must be a JSON object".into(),
        ));
    };
    for field in ["input_uuid", "session_id", "process_epoch"] {
        if !object
            .get(field)
            .and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty())
        {
            return Err(StoreError::InvalidState(format!(
                "Stop binding requires non-empty {field}"
            )));
        }
    }
    if !object
        .get("turn_epoch")
        .is_some_and(|value| value.as_u64().is_some() || value.as_i64().is_some_and(|n| n >= 0))
    {
        return Err(StoreError::InvalidState(
            "Stop binding requires a non-negative turn_epoch".into(),
        ));
    }
    if object.len() != 4 {
        return Err(StoreError::InvalidState(
            "Stop binding must contain only input_uuid, session_id, turn_epoch and process_epoch"
                .into(),
        ));
    }
    Ok(())
}

fn stop_native_turn_state_string(state: StopNativeTurnState) -> &'static str {
    match state {
        StopNativeTurnState::Pending => "pending",
        StopNativeTurnState::Interrupted => "interrupted",
        StopNativeTurnState::Unconfirmed => "unconfirmed",
    }
}

fn parse_stop_native_turn_state(value: &str) -> Result<StopNativeTurnState, rusqlite::Error> {
    match value {
        "pending" => Ok(StopNativeTurnState::Pending),
        "interrupted" => Ok(StopNativeTurnState::Interrupted),
        "unconfirmed" => Ok(StopNativeTurnState::Unconfirmed),
        _ => Err(to_sql_error(DomainError::InvalidEntity(format!(
            "unknown Stop native turn state {value}"
        )))),
    }
}

fn core_launch_epoch_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<CoreLaunchEpoch> {
    let reconciliation_raw: Option<String> = row.get(8)?;
    let reconciliation = reconciliation_raw
        .map(|raw| {
            serde_json::from_str(&raw).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    8,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })
        })
        .transpose()?;
    Ok(CoreLaunchEpoch {
        epoch_id: row.get(0)?,
        launch_nonce: row.get(1)?,
        core_pid: row.get(2)?,
        core_creation_date: row.get(3)?,
        core_executable_path: row.get(4)?,
        core_executable_sha256: row.get(5)?,
        previous_epoch_id: row.get(6)?,
        state: row.get(7)?,
        reconciliation,
        created_at: row.get(9)?,
        activated_at: row.get(10)?,
    })
}

fn attempt_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Attempt> {
    Ok(Attempt {
        id: String::new(),
        task_id: row.get(0)?,
        provider: row.get(1)?,
        provider_session: row.get(2)?,
        state: parse_attempt_state(&row.get::<_, String>(3)?).map_err(to_sql_error)?,
        last_event_seq: row.get(4)?,
        capability_version: row.get(5)?,
    })
}

fn attempt_from_row_with_id(row: &rusqlite::Row<'_>, id: &str) -> rusqlite::Result<Attempt> {
    let mut attempt = attempt_from_row(row)?;
    attempt.id = id.into();
    Ok(attempt)
}

fn command_from_row_with_id(row: &rusqlite::Row<'_>, id: &str) -> rusqlite::Result<Command> {
    Ok(Command {
        id: id.into(),
        attempt_id: row.get(0)?,
        kind: row.get(1)?,
        payload_hash: row.get(2)?,
        state: parse_command_state(&row.get::<_, String>(3)?).map_err(to_sql_error)?,
    })
}

fn event_from_row_with_id(row: &rusqlite::Row<'_>, id: &str) -> rusqlite::Result<Event> {
    Ok(Event {
        id: id.into(),
        attempt_id: row.get(0)?,
        seq: row.get(1)?,
        kind: row.get(2)?,
        payload_ref: row.get(3)?,
    })
}

fn infer_state_after(kind: &str) -> Option<AttemptState> {
    let upper = kind.to_ascii_uppercase();
    [
        ("QUEUED", AttemptState::Queued),
        ("ACTIVE", AttemptState::Active),
        ("AWAITING_REVIEW", AttemptState::AwaitingReview),
        ("CLOSED", AttemptState::Closed),
        ("FAILED", AttemptState::Failed),
        ("CANCELLED", AttemptState::Cancelled),
    ]
    .into_iter()
    .find_map(|(name, state)| upper.ends_with(name).then_some(state))
}

fn parse_attempt_state(value: &str) -> Result<AttemptState, DomainError> {
    value.parse()
}

fn attempt_state_string(state: AttemptState) -> &'static str {
    match state {
        AttemptState::Queued => "QUEUED",
        AttemptState::Active => "ACTIVE",
        AttemptState::AwaitingReview => "AWAITING_REVIEW",
        AttemptState::Closed => "CLOSED",
        AttemptState::Failed => "FAILED",
        AttemptState::Cancelled => "CANCELLED",
    }
}
fn work_status_string(state: crate::domain::WorkStatus) -> &'static str {
    match state {
        crate::domain::WorkStatus::InProgress => "IN_PROGRESS",
        crate::domain::WorkStatus::Finished => "FINISHED",
        crate::domain::WorkStatus::Abandoned => "ABANDONED",
        crate::domain::WorkStatus::Failed => "FAILED",
    }
}
fn parse_work_status(value: &str) -> Result<crate::domain::WorkStatus, DomainError> {
    match value {
        "IN_PROGRESS" => Ok(crate::domain::WorkStatus::InProgress),
        "FINISHED" => Ok(crate::domain::WorkStatus::Finished),
        "ABANDONED" => Ok(crate::domain::WorkStatus::Abandoned),
        "FAILED" => Ok(crate::domain::WorkStatus::Failed),
        _ => Err(DomainError::InvalidEntity(format!(
            "unknown work status {value}"
        ))),
    }
}
fn command_state_string(state: CommandState) -> &'static str {
    match state {
        CommandState::Pending => "PENDING",
        CommandState::Executing => "EXECUTING",
        CommandState::Succeeded => "SUCCEEDED",
        CommandState::Failed => "FAILED",
        CommandState::Unknown => "UNKNOWN",
    }
}
fn parse_command_state(value: &str) -> Result<CommandState, DomainError> {
    match value {
        "PENDING" => Ok(CommandState::Pending),
        "EXECUTING" => Ok(CommandState::Executing),
        "SUCCEEDED" => Ok(CommandState::Succeeded),
        "FAILED" => Ok(CommandState::Failed),
        "UNKNOWN" => Ok(CommandState::Unknown),
        _ => Err(DomainError::InvalidEntity(format!(
            "unknown command state {value}"
        ))),
    }
}
fn access_mode_string(mode: AccessMode) -> &'static str {
    match mode {
        AccessMode::ReadOnly => "READ_ONLY",
        AccessMode::Mutating => "MUTATING",
        AccessMode::Unknown => "UNKNOWN",
    }
}
fn parse_access_mode(value: &str) -> Result<AccessMode, rusqlite::Error> {
    match value {
        "READ_ONLY" => Ok(AccessMode::ReadOnly),
        "MUTATING" => Ok(AccessMode::Mutating),
        "UNKNOWN" => Ok(AccessMode::Unknown),
        _ => Err(to_sql_error(DomainError::InvalidEntity(format!(
            "unknown access mode {value}"
        )))),
    }
}
fn parse_lease_state(value: &str) -> Result<LeaseState, rusqlite::Error> {
    match value {
        "PENDING" => Ok(LeaseState::Pending),
        "ACTIVE" => Ok(LeaseState::Active),
        "RELEASING" => Ok(LeaseState::Releasing),
        "RELEASED" => Ok(LeaseState::Released),
        "UNCERTAIN" => Ok(LeaseState::Uncertain),
        _ => Err(to_sql_error(DomainError::InvalidEntity(format!(
            "unknown lease state {value}"
        )))),
    }
}
fn decision_state_string(state: DecisionState) -> &'static str {
    match state {
        DecisionState::Pending => "PENDING",
        DecisionState::Approved => "APPROVED",
        DecisionState::Denied => "DENIED",
        DecisionState::Expired => "EXPIRED",
        DecisionState::Cancelled => "CANCELLED",
    }
}
fn parse_decision_state(value: &str) -> Result<DecisionState, DomainError> {
    match value {
        "PENDING" => Ok(DecisionState::Pending),
        "APPROVED" => Ok(DecisionState::Approved),
        "DENIED" => Ok(DecisionState::Denied),
        "EXPIRED" => Ok(DecisionState::Expired),
        "CANCELLED" => Ok(DecisionState::Cancelled),
        _ => Err(DomainError::InvalidEntity(format!(
            "unknown decision state {value}"
        ))),
    }
}
fn verdict_string(verdict: Verdict) -> &'static str {
    match verdict {
        Verdict::Unassessed => "UNASSESSED",
        Verdict::Claimed => "CLAIMED",
        Verdict::PartiallyVerified => "PARTIALLY_VERIFIED",
        Verdict::Verified => "VERIFIED",
        Verdict::Waived => "WAIVED",
        Verdict::Contested => "CONTESTED",
    }
}
fn parse_verdict(value: &str) -> Result<Verdict, rusqlite::Error> {
    match value {
        "UNASSESSED" => Ok(Verdict::Unassessed),
        "CLAIMED" => Ok(Verdict::Claimed),
        "PARTIALLY_VERIFIED" => Ok(Verdict::PartiallyVerified),
        "VERIFIED" => Ok(Verdict::Verified),
        "WAIVED" => Ok(Verdict::Waived),
        "CONTESTED" => Ok(Verdict::Contested),
        _ => Err(to_sql_error(DomainError::InvalidEntity(format!(
            "unknown verdict {value}"
        )))),
    }
}
fn outbox_state_string(state: OutboxState) -> &'static str {
    match state {
        OutboxState::Pending => "PENDING",
        OutboxState::Dispatching => "DISPATCHING",
        OutboxState::Succeeded => "SUCCEEDED",
        OutboxState::Failed => "FAILED",
        OutboxState::Unknown => "UNKNOWN",
    }
}
fn parse_outbox_state(value: &str) -> Result<OutboxState, rusqlite::Error> {
    match value {
        "PENDING" => Ok(OutboxState::Pending),
        "DISPATCHING" => Ok(OutboxState::Dispatching),
        "SUCCEEDED" => Ok(OutboxState::Succeeded),
        "FAILED" => Ok(OutboxState::Failed),
        "UNKNOWN" => Ok(OutboxState::Unknown),
        _ => Err(to_sql_error(DomainError::InvalidEntity(format!(
            "unknown outbox state {value}"
        )))),
    }
}
fn to_sql_error(error: DomainError) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
}

#[allow(dead_code)]
fn _transaction_marker<'a>(tx: &'a Transaction<'a>) -> &'a Transaction<'a> {
    tx
}

fn admission_row_from_sql(row: &rusqlite::Row<'_>) -> rusqlite::Result<AdmissionRow> {
    Ok(AdmissionRow {
        id: row.get(0)?,
        attempt_id: row.get(1)?,
        reason: row.get(2)?,
        override_reason: row.get(3)?,
        request_json: row.get(4)?,
    })
}

fn ensure_admission_request_json(tx: &Transaction<'_>) -> Result<(), StoreError> {
    let exists: i64 = tx.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('admission_queue') WHERE name = 'request_json'",
        [],
        |row| row.get(0),
    )?;
    if exists == 0 {
        tx.execute(
            "ALTER TABLE admission_queue ADD COLUMN request_json TEXT",
            [],
        )?;
    }
    Ok(())
}

/// `commands.result_json` (increment 7): nullable, added idempotently on every `migrate` like
/// `admission_queue.request_json` above. `SCHEMA_VERSION` is deliberately not bumped for a
/// nullable column that every reader tolerates as NULL.
fn ensure_command_result_json(tx: &Transaction<'_>) -> Result<(), StoreError> {
    let exists: i64 = tx.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('commands') WHERE name = 'result_json'",
        [],
        |row| row.get(0),
    )?;
    if exists == 0 {
        tx.execute("ALTER TABLE commands ADD COLUMN result_json TEXT", [])?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_matcher_refuses_distinct_canonical_identities_with_one_conservative_key() {
        let stored = Project {
            id: "project-upper".into(),
            workspace_root: r"Z:\identity-probe\Foo".into(),
        };
        let proposed = Project {
            id: "project-lower".into(),
            workspace_root: r"Z:\identity-probe\foo".into(),
        };
        let result =
            match_workspace_project(std::slice::from_ref(&stored), &proposed, |workspace_root| {
                match workspace_root {
                    r"Z:\identity-probe\Foo" => {
                        Some(std::path::PathBuf::from(r"\\?\Z:\identity-probe\Foo"))
                    }
                    r"Z:\identity-probe\foo" => {
                        Some(std::path::PathBuf::from(r"\\?\Z:\identity-probe\foo"))
                    }
                    _ => None,
                }
            });
        assert!(matches!(result, Err(StoreError::InvalidState(_))));
    }

    #[test]
    fn workspace_matcher_reuses_one_verified_actual_alias() {
        let stored = Project {
            id: "project-short".into(),
            workspace_root: r"Z:\PROGRA~1\workspace".into(),
        };
        let proposed = Project {
            id: "project-long".into(),
            workspace_root: r"Z:\Program Files\workspace".into(),
        };
        let identity = std::path::PathBuf::from(r"\\?\Z:\Program Files\workspace");
        let matched = match_workspace_project(std::slice::from_ref(&stored), &proposed, |_| {
            Some(identity.clone())
        })
        .unwrap();
        assert_eq!(matched, Some(stored));
    }

    #[test]
    fn workspace_matcher_refuses_multiple_projects_for_one_actual_identity() {
        let first = Project {
            id: "project-first".into(),
            workspace_root: r"Z:\alias-one\workspace".into(),
        };
        let second = Project {
            id: "project-second".into(),
            workspace_root: r"Z:\alias-two\workspace".into(),
        };
        let proposed = Project {
            id: "project-proposed".into(),
            workspace_root: r"Z:\actual\workspace".into(),
        };
        let identity = std::path::PathBuf::from(r"\\?\Z:\actual\workspace");
        let result =
            match_workspace_project(&[first, second], &proposed, |_| Some(identity.clone()));
        assert!(matches!(result, Err(StoreError::InvalidState(_))));
    }

    fn attempt() -> Attempt {
        Attempt::new("a1", "t1", "scenario", "cap-v1")
    }

    #[test]
    fn migrations_are_idempotent_and_projection_survives_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("goalport.db");
        let first = Store::open(&path).unwrap();
        first.migrate().unwrap();
        assert_eq!(first.schema_version().unwrap(), SCHEMA_VERSION);
        first.insert_attempt(&attempt()).unwrap();
        first
            .append_event(&Event {
                id: "e1".into(),
                attempt_id: "a1".into(),
                seq: 1,
                kind: "attempt.active".into(),
                payload_ref: None,
            })
            .unwrap();
        drop(first);
        let second = Store::open(&path).unwrap();
        second.rebuild_projections().unwrap();
        let loaded = second.get_attempt("a1").unwrap();
        assert_eq!(loaded.state, AttemptState::Active);
        assert_eq!(loaded.last_event_seq, 1);
    }

    #[test]
    fn duplicate_event_is_idempotent_but_out_of_order_is_rejected() {
        let store = Store::open_in_memory().unwrap();
        store.insert_attempt(&attempt()).unwrap();
        let event = Event {
            id: "e1".into(),
            attempt_id: "a1".into(),
            seq: 1,
            kind: "attempt.active".into(),
            payload_ref: None,
        };
        assert!(matches!(
            store.append_event(&event).unwrap(),
            AppendEventOutcome::Inserted(_)
        ));
        assert!(matches!(
            store.append_event(&event).unwrap(),
            AppendEventOutcome::Duplicate(_)
        ));
        let late = Event {
            id: "e3".into(),
            attempt_id: "a1".into(),
            seq: 3,
            kind: "message.delta".into(),
            payload_ref: None,
        };
        assert!(matches!(
            store.append_event(&late),
            Err(StoreError::SequenceConflict { expected: 2, .. })
        ));
    }

    #[test]
    fn lease_overlap_and_unknown_outbox_are_fail_closed() {
        let store = Store::open_in_memory().unwrap();
        let first = store
            .acquire_lease(&WorkspaceLease::new(r"C:\work", "a1", AccessMode::Mutating))
            .unwrap();
        assert_eq!(first.state, LeaseState::Active);
        let duplicate = store
            .acquire_lease(&WorkspaceLease::new(r"C:\work", "a1", AccessMode::Mutating))
            .unwrap();
        assert_eq!(duplicate.state, LeaseState::Active);
        assert_eq!(store.leases().unwrap().len(), 1);
        let second = WorkspaceLease::new(r"C:\work\nested", "a2", AccessMode::Unknown);
        assert!(matches!(
            store.acquire_lease(&second),
            Err(StoreError::LeaseConflict(_))
        ));
        let intent = OutboxIntent {
            id: "o1".into(),
            command_id: "c1".into(),
            effect_kind: "publish".into(),
            target: "synthetic".into(),
            state: OutboxState::Pending,
        };
        store.insert_outbox(&intent).unwrap();
        store.mark_outbox_unknown("o1", "ack lost").unwrap();
        assert!(store.retryable_outbox().unwrap().is_empty());
        assert!(matches!(
            store.update_outbox_state("o1", OutboxState::Succeeded, None),
            Err(StoreError::InvalidState(_))
        ));
        assert_eq!(
            store
                .reconcile_outbox("o1", OutboxState::Succeeded, "effect observed")
                .unwrap()
                .state,
            OutboxState::Succeeded
        );
    }

    #[test]
    fn executing_command_is_marked_unknown_after_restart_boundary() {
        let store = Store::open_in_memory().unwrap();
        let command = Command {
            id: "c1".into(),
            attempt_id: "a1".into(),
            kind: "external.effect".into(),
            payload_hash: "hash".into(),
            state: CommandState::Executing,
        };
        store
            .record_command(&Command {
                state: CommandState::Pending,
                ..command.clone()
            })
            .unwrap();
        store
            .update_command_state("c1", CommandState::Executing)
            .unwrap();
        assert_eq!(store.mark_executing_commands_unknown().unwrap(), 1);
        assert_eq!(
            store.get_command("c1").unwrap().state,
            CommandState::Unknown
        );
        assert!(matches!(
            store.update_command_state("c1", CommandState::Succeeded),
            Err(StoreError::InvalidState(_))
        ));
    }

    #[test]
    fn product_receipts_round_trip_by_nonce_and_receipt_id() {
        let store = Store::open_in_memory().unwrap();
        let payload = serde_json::json!({
            "kind": "startup",
            "launchNonce": "nonce-1",
            "pipe": "pipe-a"
        });
        store
            .put_product_receipt(
                "startup:nonce-1",
                "startup",
                Some("nonce-1"),
                None,
                None,
                &payload,
            )
            .unwrap();
        let loaded = store
            .get_product_receipt_by_nonce("startup", "nonce-1")
            .unwrap()
            .unwrap();
        assert_eq!(loaded["launchNonce"], "nonce-1");
        store
            .put_product_receipt(
                "close-choice:req-1",
                "close-choice",
                None,
                Some("rcpt-1"),
                Some("attempt-1"),
                &serde_json::json!({"receiptId":"rcpt-1","choice":"continue-background"}),
            )
            .unwrap();
        let close = store
            .get_product_receipt_by_receipt_id("rcpt-1")
            .unwrap()
            .unwrap();
        assert_eq!(close["choice"], "continue-background");
        let by_id = store
            .get_product_receipt_by_id("close-choice:req-1")
            .unwrap()
            .unwrap();
        assert_eq!(by_id["receiptId"], "rcpt-1");
    }

    #[test]
    fn enqueue_admission_persists_attempt_and_request_json() {
        let store = Store::open_in_memory().unwrap();
        store
            .enqueue_admission(
                "queue-1",
                Some("attempt-queued"),
                "resource-pressure",
                Some(r#"{"attemptId":"attempt-queued"}"#),
            )
            .unwrap();
        let row = store.get_admission("queue-1").unwrap();
        assert_eq!(row.attempt_id.as_deref(), Some("attempt-queued"));
        assert_eq!(
            row.request_json.as_deref(),
            Some(r#"{"attemptId":"attempt-queued"}"#)
        );
        store.override_admission("queue-1", "owner").unwrap();
        let pending = store.pending_admissions().unwrap();
        assert_eq!(pending[0].override_reason.as_deref(), Some("owner"));
        assert_eq!(
            pending[0].request_json.as_deref(),
            Some(r#"{"attemptId":"attempt-queued"}"#)
        );
    }

    // ---- increment 7 (run runtime-registration-safety): the command result column ----

    fn seeded_command(store: &Store, id: &str) -> Command {
        let _ = store.insert_attempt(&attempt());
        let command = Command {
            id: id.into(),
            attempt_id: "a1".into(),
            kind: "event.append".into(),
            payload_hash: "hash".into(),
            state: CommandState::Pending,
        };
        store.record_command(&command).unwrap();
        store
            .update_command_state(id, CommandState::Executing)
            .unwrap();
        command
    }

    #[test]
    fn finish_command_writes_state_and_result_atomically() {
        let store = Store::open_in_memory().unwrap();
        seeded_command(&store, "cmd-1");
        let result = serde_json::json!({ "requestId": "r-1", "deliveryState": "DELIVERED", "error": "late failure" });
        let row = store
            .finish_command("cmd-1", CommandState::Failed, &result)
            .unwrap();
        assert_eq!(row.state, CommandState::Failed);
        assert_eq!(store.command_result("cmd-1").unwrap(), Some(result));
        assert_eq!(
            store.get_command("cmd-1").unwrap().state,
            CommandState::Failed
        );
    }

    #[test]
    fn finish_command_refuses_illegal_transitions_and_second_terminal_writes() {
        let store = Store::open_in_memory().unwrap();
        seeded_command(&store, "cmd-2");
        let first = serde_json::json!({ "deliveryState": "DELIVERED" });
        store
            .finish_command("cmd-2", CommandState::Succeeded, &first)
            .unwrap();
        // Succeeded -> Failed is not a permitted transition, and the row is already terminal.
        let refused = store.finish_command(
            "cmd-2",
            CommandState::Failed,
            &serde_json::json!({ "deliveryState": "FAILED", "error": "must not land" }),
        );
        assert!(
            matches!(refused, Err(StoreError::InvalidState(_))),
            "{refused:?}"
        );
        // Same terminal state again: update_command_state would short-circuit it, finish_command
        // refuses it so a recorded result is written exactly once.
        let again = store.finish_command(
            "cmd-2",
            CommandState::Succeeded,
            &serde_json::json!({ "deliveryState": "FAILED" }),
        );
        assert!(
            matches!(again, Err(StoreError::InvalidState(_))),
            "{again:?}"
        );
        assert_eq!(
            store.get_command("cmd-2").unwrap().state,
            CommandState::Succeeded
        );
        assert_eq!(store.command_result("cmd-2").unwrap(), Some(first));
        // Pending -> Failed is refused by the transition check (only Pending -> Executing exists).
        let _ = store.insert_attempt(&attempt());
        store
            .record_command(&Command {
                id: "cmd-2b".into(),
                attempt_id: "a1".into(),
                kind: "event.append".into(),
                payload_hash: "hash".into(),
                state: CommandState::Pending,
            })
            .unwrap();
        let pending = store.finish_command("cmd-2b", CommandState::Failed, &serde_json::json!({}));
        assert!(
            matches!(pending, Err(StoreError::InvalidState(_))),
            "{pending:?}"
        );
        assert_eq!(store.command_result("cmd-2b").unwrap(), None);
    }

    #[test]
    fn command_result_is_none_without_finish_command_and_for_missing_rows() {
        let store = Store::open_in_memory().unwrap();
        seeded_command(&store, "cmd-3");
        store
            .update_command_state("cmd-3", CommandState::Failed)
            .unwrap();
        assert_eq!(store.command_result("cmd-3").unwrap(), None);
        assert_eq!(store.command_result("no-such-command").unwrap(), None);
    }

    #[test]
    fn result_json_column_is_added_once_and_survives_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("goalport.db");
        let first = Store::open(&path).unwrap();
        first.migrate().unwrap();
        first.migrate().unwrap();
        assert_eq!(first.schema_version().unwrap(), SCHEMA_VERSION);
        seeded_command(&first, "cmd-4");
        first
            .finish_command(
                "cmd-4",
                CommandState::Unknown,
                &serde_json::json!({ "deliveryState": "UNKNOWN" }),
            )
            .unwrap();
        drop(first);
        let second = Store::open(&path).unwrap();
        second.migrate().unwrap();
        assert_eq!(
            second.command_result("cmd-4").unwrap(),
            Some(serde_json::json!({ "deliveryState": "UNKNOWN" }))
        );
    }

    // ---- plan v12 (critic round 2): the request-id stamp at insert and the write-once predicate ----

    #[test]
    fn record_command_for_request_stamps_a_new_row_and_leaves_an_existing_row_untouched() {
        let store = Store::open_in_memory().unwrap();
        let _ = store.insert_attempt(&attempt());
        let command = Command {
            id: "cmd-5".into(),
            attempt_id: "a1".into(),
            kind: "event.append".into(),
            payload_hash: "hash".into(),
            state: CommandState::Pending,
        };
        let first = store
            .record_command_for_request(&command, "req-original")
            .unwrap();
        assert_eq!(first.state, CommandState::Pending);
        assert_eq!(
            store.command_result("cmd-5").unwrap(),
            Some(serde_json::json!({ "requestId": "req-original" })),
            "a new row names its request from the moment it exists"
        );
        let again = store
            .record_command_for_request(&command, "req-colliding")
            .unwrap();
        assert_eq!(again.state, CommandState::Pending);
        assert_eq!(
            store.command_result("cmd-5").unwrap(),
            Some(serde_json::json!({ "requestId": "req-original" })),
            "an existing row keeps its original request id"
        );
        let other = Command {
            payload_hash: "other".into(),
            ..command.clone()
        };
        assert!(matches!(
            store.record_command_for_request(&other, "req-x"),
            Err(StoreError::IdempotencyConflict(_))
        ));
        // the terminal write replaces the stamp with the full result, as before
        store
            .update_command_state("cmd-5", CommandState::Executing)
            .unwrap();
        store
            .finish_command(
                "cmd-5",
                CommandState::Succeeded,
                &serde_json::json!({ "requestId": "req-original", "deliveryState": "DELIVERED" }),
            )
            .unwrap();
        assert_eq!(
            store.command_result("cmd-5").unwrap().unwrap()["deliveryState"],
            "DELIVERED"
        );
    }

    #[test]
    fn finish_command_is_write_once_across_two_connections() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("goalport.db");
        let first = Store::open(&path).unwrap();
        first.migrate().unwrap();
        seeded_command(&first, "cmd-6");
        let second = Store::open(&path).unwrap();
        second.migrate().unwrap();
        // Both connections observe the row Executing; only one terminal write may land.
        let a = std::thread::spawn({
            let store = first.clone();
            move || {
                store.finish_command(
                    "cmd-6",
                    CommandState::Failed,
                    &serde_json::json!({ "writer": "a" }),
                )
            }
        });
        let b = std::thread::spawn({
            let store = second.clone();
            move || {
                store.finish_command(
                    "cmd-6",
                    CommandState::Succeeded,
                    &serde_json::json!({ "writer": "b" }),
                )
            }
        });
        let outcomes = [a.join().unwrap(), b.join().unwrap()];
        let winners: Vec<&str> = outcomes
            .iter()
            .enumerate()
            .filter(|(_, o)| o.is_ok())
            .map(|(i, _)| if i == 0 { "a" } else { "b" })
            .collect();
        assert_eq!(
            winners.len(),
            1,
            "exactly one terminal write lands: {outcomes:?}"
        );
        let stored = first.command_result("cmd-6").unwrap().unwrap();
        assert_eq!(
            stored["writer"], winners[0],
            "the stored result belongs to the winner: {stored}"
        );
        let state = first.get_command("cmd-6").unwrap().state;
        assert_eq!(
            state,
            if winners[0] == "a" {
                CommandState::Failed
            } else {
                CommandState::Succeeded
            }
        );
        // The loser waits (up to 5 s, rusqlite's default busy timeout) if the winner still holds
        // SQLite's write lock, and is then refused by the read (already terminal) or by the state
        // predicate; either way it is an error and it never writes.
        assert!(outcomes.iter().any(|o| o.is_err()));
    }

    // ---- plan v13 (critic round 3): a bare state update never overwrites a concurrently recorded result ----

    #[test]
    fn a_bare_state_update_never_lands_on_top_of_a_concurrently_recorded_result() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("goalport.db");
        let first = Store::open(&path).unwrap();
        seeded_command(&first, "cmd-7");
        let second = Store::open(&path).unwrap();
        let recorded =
            serde_json::json!({ "writer": "finish", "deliveryState": "FAILED", "error": "x" });
        let a = std::thread::spawn({
            let store = first.clone();
            let recorded = recorded.clone();
            move || {
                store
                    .finish_command("cmd-7", CommandState::Failed, &recorded)
                    .map(|_| ())
            }
        });
        let b = std::thread::spawn({
            let store = second.clone();
            move || {
                store
                    .update_command_state("cmd-7", CommandState::Succeeded)
                    .map(|_| ())
            }
        });
        let _ = (a.join().unwrap(), b.join().unwrap());
        let state = first.get_command("cmd-7").unwrap().state;
        let result = first.command_result("cmd-7").unwrap();
        // Either the recorded failure stands with its result, or the bare success landed first and
        // the finish was refused; NEVER the recorded failure's result under a Succeeded state. On
        // the unpredicated (v12) update this test is a timing-dependent but effective detector
        // (removing the predicate reds it in 28 of 30 runs on the auditing machine); the
        // deterministic driver of the wrong-predicate shape is the same-state test below.
        match (state, result) {
            (CommandState::Failed, Some(r)) => assert_eq!(r, recorded),
            (CommandState::Succeeded, r) => {
                assert!(r.is_none() || r != Some(recorded.clone()), "{r:?}")
            }
            other => panic!(
                "unexpected terminal record (both writers refused, or a state neither wrote): {other:?}"
            ),
        }
    }

    #[test]
    fn update_command_state_still_short_circuits_the_same_state() {
        let store = Store::open_in_memory().unwrap();
        seeded_command(&store, "cmd-8");
        store
            .update_command_state("cmd-8", CommandState::Executing)
            .unwrap();
        assert_eq!(
            store.get_command("cmd-8").unwrap().state,
            CommandState::Executing
        );
        store
            .update_command_state("cmd-8", CommandState::Failed)
            .unwrap();
        assert!(matches!(
            store.update_command_state("cmd-8", CommandState::Executing),
            Err(StoreError::InvalidState(_))
        ));
    }

    // ---- plan v15 (critic round 5): a result is recorded only with a terminal state ----

    #[test]
    fn finish_command_refuses_a_non_terminal_target_so_a_result_can_never_be_replaced() {
        let store = Store::open_in_memory().unwrap();
        let _ = store.insert_attempt(&attempt());
        store
            .record_command(&Command {
                id: "cmd-9".into(),
                attempt_id: "a1".into(),
                kind: "event.append".into(),
                payload_hash: "hash".into(),
                state: CommandState::Pending,
            })
            .unwrap();
        // Pending -> Executing is a permitted transition, but not a place for a result.
        let refused = store.finish_command(
            "cmd-9",
            CommandState::Executing,
            &serde_json::json!({ "writer": "one" }),
        );
        assert!(
            matches!(refused, Err(StoreError::InvalidState(_))),
            "{refused:?}"
        );
        assert_eq!(
            store.get_command("cmd-9").unwrap().state,
            CommandState::Pending
        );
        assert_eq!(store.command_result("cmd-9").unwrap(), None);
        // The bare transition still works, and the single terminal write then lands once.
        store
            .update_command_state("cmd-9", CommandState::Executing)
            .unwrap();
        store
            .finish_command(
                "cmd-9",
                CommandState::Succeeded,
                &serde_json::json!({ "writer": "two" }),
            )
            .unwrap();
        assert_eq!(
            store.command_result("cmd-9").unwrap(),
            Some(serde_json::json!({ "writer": "two" }))
        );
        assert!(matches!(
            store.finish_command(
                "cmd-9",
                CommandState::Failed,
                &serde_json::json!({ "writer": "three" })
            ),
            Err(StoreError::InvalidState(_))
        ));
        assert_eq!(
            store.command_result("cmd-9").unwrap(),
            Some(serde_json::json!({ "writer": "two" }))
        );
    }
}
