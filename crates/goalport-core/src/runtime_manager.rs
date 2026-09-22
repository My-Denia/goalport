//! Core-owned Runtime process management.
//!
//! The desktop never starts a provider.  A RuntimeManager lives with the
//! detached Core, keeps native authentication and configuration in the native
//! process, and translates structured provider frames into bounded event
//! envelopes.  Scenario is intentionally deterministic for contract tests;
//! Codex uses the versioned app-server JSON-RPC stdio transport and Claude uses
//! its native persistent stream-json CLI (`-p --input-format stream-json` with
//! host permission prompts). Prompt text travels on stdin, never as a trailing
//! argv string.

use crate::{
    adapters::{
        AdapterError, AgentAdapter, ClaudeCliAdapter, PermissionResponse, PromptRequest,
        ScenarioAdapter, SessionHandle, SessionRequest,
    },
    claude_stop_broker::{self, BrokerLaunch, BrokerSession},
    commands::sha256_hex,
    domain::{AgentEventEnvelope, AgentEventType},
    process_identity::{self, ProcessObservation},
};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU8, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError, Sender},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const CODEX_PROTOCOL_VERSION: &str = "codex.app-server.v2";
const GROK_PROTOCOL_VERSION: &str = "grok.acp.v1";
const CLAUDE_PROTOCOL_VERSION: &str = "claude.cli.stream-json.v1";
const CLAUDE_INIT_TIMEOUT_MS: u64 = 60_000;
const CLAUDE_SESSION_BIND_TIMEOUT_MS: u64 = 15_000;
/// Documented interrupt-receipt bound. `interrupt()` does not wait this long:
/// UiController holds the projection mutex and `poll_events` needs the same lock.
const CLAUDE_INTERRUPT_RECEIPT_WAIT_MS: u64 = 2_000;
const CLAUDE_SIGINT_FALLBACK_MS: u64 = 5_000;
/// Provider keys stripped from the Claude child environment. Identical on the
/// direct and brokered launches so the child sees the same sanitised env.
const CLAUDE_ENV_REMOVED: &[&str] = &["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "XAI_API_KEY"];
/// Isolated-test-only interpreter for a synthetic Claude fixture script.
const CLAUDE_FIXTURE_INTERPRETER_ENV: &str = "GOALPORT_CLAUDE_FIXTURE_INTERPRETER";
const CLAUDE_PERMISSION_RESPONSE_TYPE: &str = "_goalport/claude_permission_response";
const MAX_NATIVE_LINE_BYTES: usize = 16 * 1024 * 1024;
/// The ACP-advertised session command that turns the native permission prompts
/// back on for this session only. Nothing in `~/.grok` is read or written; the
/// user's own `permission_mode` stays exactly as the Runtime owner set it.
const GROK_ALWAYS_APPROVE_OFF: &str = "/always-approve off";
const GROK_REQUEST_TIMEOUT_MS: u64 = 120_000;
/// Internal key that carries the DB-unique Decision id from the reader thread
/// to the frame mapper, and the reader-synthesised permission-response frame.
const GROK_DECISION_ID_KEY: &str = "_goalportRequestId";
const GROK_PERMISSION_RESPONSE_METHOD: &str = "_goalport/permission_response";

/// Hide the native Runtime console on Windows. Console-subsystem CLIs
/// (especially `claude.exe`) otherwise allocate a visible terminal as soon as
/// Core spawns them. `CREATE_NEW_PROCESS_GROUP` is kept so Ctrl+Break can still
/// target the child if the structured interrupt path fails.
/// Whether this Core launches Claude through the transient console broker.
///
/// Off unless explicitly selected, so the default Claude launch stays exactly
/// the consoleless one every existing artifact was produced with. Nothing else
/// in the process reads this: it is Claude-only and never reaches the shared
/// spawn helper or the other providers.
fn brokered_claude_launch() -> bool {
    std::env::var(claude_stop_broker::BROKER_ENABLE_ENV).as_deref() == Ok("1")
}

/// Isolated-test fixture indirection, Claude-only and off by default.
///
/// A synthetic Claude-protocol fixture is a script, not a console executable.
/// Running it through a `.cmd` shim would put `cmd.exe` between Core and the
/// fixture and make *that* the exact managed child, which is not the identity
/// under test. When this is set, the child is launched as
/// `<interpreter> <executable> <unchanged Claude flags>` instead. The flags,
/// stdio, environment sanitisation and both launch paths are otherwise
/// untouched, and real `claude.exe` never takes this branch.
fn claude_fixture_interpreter() -> Option<PathBuf> {
    let value = std::env::var_os(CLAUDE_FIXTURE_INTERPRETER_ENV)?;
    let path = PathBuf::from(value);
    path.is_file().then_some(path)
}

fn hide_native_console(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        command.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
    }
    let _ = command;
}
/// The `available_commands_update` notification is emitted shortly before the
/// `session/new` response. When a slower Core-spawned session has not published
/// it yet, wait this long for it and then record the miss explicitly.
const GROK_COMMAND_ADVERTISEMENT_GRACE_MS: u64 = 3_000;

#[derive(Debug, Clone, PartialEq)]
pub struct RuntimeSendResult {
    pub accepted: bool,
    pub duplicate: bool,
    /// The provider session/thread identity observed while accepting the
    /// prompt.  Core may persist this only after validating it belongs to the
    /// current Attempt; hosts never manufacture this identity.
    pub session_id: Option<String>,
    pub events: Vec<AgentEventEnvelope>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RuntimeSessionResult {
    pub handle: SessionHandle,
    pub events: Vec<AgentEventEnvelope>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeIdentitySummary {
    pub provider: String,
    pub version: String,
    pub executable: Option<String>,
    pub protocol: String,
    pub native: bool,
}

/// Per-attempt turn facts for the product read model (plan R2/R3): what the
/// live Runtime can actually prove right now. Nothing here is inferred from
/// `Attempt.active`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TurnFacts {
    /// The Runtime still owes a response for a prompt (send exclusion).
    pub in_flight: bool,
    /// A proven cancellable live turn exists. Stop is offered only for this.
    pub stoppable: bool,
    /// A Codex start whose delivery could not be confirmed; fail-closed.
    pub delivery_unknown: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeProcessBinding {
    pub process_epoch: String,
    pub pid: u32,
    pub creation_date: String,
    pub executable_path: String,
    pub executable_sha256: String,
}

enum ManagedRuntime {
    Scenario(Box<ScenarioAdapter>),
    Codex(Box<CodexProcess>),
    CodexExec(Box<CodexExecProcess>),
    Claude(Box<ClaudeStreamProcess>),
    Grok(Box<GrokAcpProcess>),
}

impl std::fmt::Debug for ManagedRuntime {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("ManagedRuntime")
            .field(&match self {
                Self::Scenario(_) => "scenario",
                Self::Codex(_) => "codex-app-server",
                Self::CodexExec(_) => "codex-exec-json",
                Self::Claude(_) => "claude-stream-json",
                Self::Grok(_) => "grok-acp-stdio",
            })
            .finish()
    }
}

/// The binding a registration was requested with and recorded under: provider,
/// version, the resolved executable (`None` for the in-process scenario adapter),
/// the workspace, and for Codex the adopted transport and approval policy. It is
/// what a later selection is compared against to decide whether it is the same
/// binding (legitimate reuse) or a different one (a conflict).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeBinding {
    pub provider: String,
    pub version: String,
    pub executable: Option<PathBuf>,
    pub workspace_root: PathBuf,
    pub transport: Option<String>,
    pub approval_policy: Option<String>,
}

/// What the recovery classification may conclude about a registered Runtime's
/// process, kept apart on purpose: a confirmed exit, a confirmed live identity
/// equal to the spawn-time binding, an observation that failed (neither alive
/// nor safely stopped), or a transport that has no process identity at all.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProcessConfirmation {
    /// The process is running and its pid, creation date and executable hash
    /// equal the identity recorded when it was spawned.
    Confirmed { pid: u32, process_epoch: String },
    /// The process has exited (reaped, reported ended, or observed not running).
    Exited { pid: Option<u32> },
    /// Could not be established; never read as alive and never as stopped.
    Unknown { reason: String },
    /// No process identity exists for this transport between turns.
    NotApplicable,
}

/// What can be observed about a registered Runtime's output transport right now (increment 6).
/// Codex reflects what its reader has actually observed; Grok/Claude are expressed from their
/// existing stream flags (read-only — their behaviour is unchanged); the in-process scenario
/// adapter and the one-shot Codex exec transport have no live stdio transport.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransportState {
    /// No live stdio transport between turns.
    NotApplicable,
    /// Registered, but no process or stream has been started yet.
    NotStarted,
    /// The stream is open as far as any observer has seen.
    Open,
    /// A reader observed the stream end — EOF, an oversized frame, or a read error — while the
    /// process may still be running. A closed transport is never reported usable.
    Closed { reason: &'static str },
}

/// One Codex registration whose transport closed and has not yet been reported to the projection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransportClosure {
    pub attempt_id: String,
    pub reason: &'static str,
    pub pid: Option<u32>,
    pub turn_failed: bool,
}

/// Outcome of `RuntimeManager::withdraw_unstarted_registration`: the compensation for a
/// failed initialization of a registration the caller itself just created.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RegistrationWithdrawal {
    /// The registration was the caller's and no process had ever been spawned: removed.
    Withdrawn,
    /// A process was spawned (alive, exited, or killed by Core's own identity check):
    /// the registration is kept exactly as it is.
    KeptProcessStarted { pid: Option<u32> },
    /// The registration under this id is not the one the caller created: kept exactly as it is.
    KeptNotOurs { current_seq: u64 },
}

/// Compare a live observation of `pid` against the spawn-time binding. Only a
/// full match is `Confirmed`; a running process with a different identity is
/// `Unknown`, not `Exited` — pid reuse proves nothing about the bound child.
fn confirm_against_binding(
    pid: u32,
    binding: Option<&RuntimeProcessBinding>,
) -> ProcessConfirmation {
    let Some(binding) = binding else {
        return ProcessConfirmation::Unknown {
            reason: "no spawn-time process binding recorded".into(),
        };
    };
    match process_identity::observe_process(pid) {
        ProcessObservation::NotRunning => ProcessConfirmation::Exited { pid: Some(pid) },
        ProcessObservation::Unknown(reason) => ProcessConfirmation::Unknown { reason },
        ProcessObservation::Live(identity) => {
            let hash_matches = !identity.executable_sha256.is_empty()
                && !binding.executable_sha256.is_empty()
                && identity
                    .executable_sha256
                    .eq_ignore_ascii_case(&binding.executable_sha256);
            if identity.pid == binding.pid
                && identity.creation_date() == binding.creation_date
                && hash_matches
            {
                ProcessConfirmation::Confirmed {
                    pid,
                    process_epoch: binding.process_epoch.clone(),
                }
            } else {
                ProcessConfirmation::Unknown {
                    reason: "live process identity differs from the spawn-time binding".into(),
                }
            }
        }
    }
}

#[derive(Debug, Clone)]
struct Registration {
    binding: RuntimeBinding,
    /// Minted per successful registration on this manager. A replacement would
    /// necessarily change it, which is what makes "not replaced" observable for
    /// variants whose process epoch and session id are constants.
    seq: u64,
}

/// RuntimeManager is deliberately owned by the Core UI controller.  It is not
/// serialised into the desktop and has no methods that mutate provider config.
#[derive(Debug)]
pub struct RuntimeManager {
    attempts: HashMap<String, ManagedRuntime>,
    selected_provider: HashMap<String, String>,
    registrations: HashMap<String, Registration>,
    registration_counter: u64,
    /// Minted once per manager (a Core restart yields a new one) and joined with `seq` into
    /// `registration_identity`, the persisted name of one registration.
    instance: String,
    /// Captured once when Core starts. An isolated synthetic profile may never
    /// cross the in-process Scenario boundary into a native provider process.
    synthetic_only: bool,
}

/// In-process manager counter: two managers built in the same nanosecond still get distinct
/// instance nonces.
static MANAGER_INSTANCES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// 128 bits derived from two independent OS-seeded hasher states (`RandomState` is seeded from
/// the operating system's random source per thread and stepped per instance). The instance nonce
/// is therefore probabilistically unique across Core processes even when the pid, the clock and
/// the counter all repeat — about one chance in 2^128 per pair of identities, the same grade as a
/// random UUID — not structurally impossible: `Hasher::finish` is many-to-one, so distinct seeds
/// can in principle hash alike. The established-record lookup compares identities by exact
/// string; this is the residual collision surface it inherits.
fn os_random_u128() -> u128 {
    use std::hash::{BuildHasher, Hasher};
    let mut first = std::collections::hash_map::RandomState::new().build_hasher();
    first.write_u128(monotonic_id());
    let mut second = std::collections::hash_map::RandomState::new().build_hasher();
    second.write_u128(monotonic_id() ^ u128::from(std::process::id()));
    (u128::from(first.finish()) << 64) | u128::from(second.finish())
}

impl Default for RuntimeManager {
    fn default() -> Self {
        Self::new()
    }
}

impl RuntimeManager {
    pub fn new() -> Self {
        Self::with_synthetic_only(
            std::env::var("GOALPORT_TEST_SYNTHETIC_ONLY").as_deref() == Ok("1"),
        )
    }

    fn with_synthetic_only(synthetic_only: bool) -> Self {
        Self {
            attempts: HashMap::new(),
            selected_provider: HashMap::new(),
            registrations: HashMap::new(),
            registration_counter: 0,
            instance: format!(
                "{:x}-{:x}-{}-{:032x}",
                std::process::id(),
                monotonic_id(),
                MANAGER_INSTANCES.fetch_add(1, std::sync::atomic::Ordering::SeqCst),
                os_random_u128()
            ),
            synthetic_only,
        }
    }

    /// Explicit constructor for in-process firewall tests. It avoids mutating
    /// process-global environment variables in a parallel Rust test runner.
    pub fn new_synthetic_only() -> Self {
        Self::with_synthetic_only(true)
    }

    pub fn ensure_provider_allowed(&self, provider: &str) -> Result<(), AdapterError> {
        if self.synthetic_only && !provider.trim().eq_ignore_ascii_case("scenario") {
            return Err(AdapterError::Unsupported(format!(
                "test profile permits only the in-process Scenario Runtime; native provider {} is refused",
                provider.trim()
            )));
        }
        Ok(())
    }

    fn ensure_attempt_allowed(&self, attempt_id: &str) -> Result<(), AdapterError> {
        let provider = self
            .selected_provider
            .get(attempt_id)
            .ok_or_else(|| AdapterError::Connection("Runtime has not been selected".into()))?;
        self.ensure_provider_allowed(provider)
    }

    /// The binding a `select_runtime` call with these arguments would adopt,
    /// computed without registering or creating anything: provider
    /// normalization, the unknown-provider refusal, the default executable
    /// resolution and the Codex transport/approval reads happen here exactly as
    /// they do in `select_runtime`, so a caller can compare a request against
    /// `registered_binding` before touching any state.
    pub fn intended_binding(
        provider: &str,
        executable: Option<PathBuf>,
        version: impl Into<String>,
        workspace_root: &Path,
    ) -> Result<RuntimeBinding, AdapterError> {
        let provider = provider.trim().to_ascii_lowercase();
        let (executable, transport, approval_policy) = match provider.as_str() {
            "scenario" => (None, None, None),
            "codex" => {
                let executable = executable.unwrap_or_else(|| resolve_native_executable("codex"));
                let approval_policy = native_approval_policy()?;
                let transport =
                    if std::env::var("GOALPORT_CODEX_TRANSPORT").ok().as_deref() == Some("exec") {
                        "exec"
                    } else {
                        "app-server"
                    };
                (
                    Some(executable),
                    Some(transport.to_owned()),
                    Some(approval_policy),
                )
            }
            "claude" => (
                Some(executable.unwrap_or_else(|| resolve_native_executable("claude"))),
                None,
                None,
            ),
            "grok" => (
                Some(executable.unwrap_or_else(|| resolve_native_executable("grok"))),
                None,
                None,
            ),
            _ => {
                return Err(AdapterError::Unsupported(format!(
                    "unknown Runtime provider {provider}"
                )));
            }
        };
        Ok(RuntimeBinding {
            provider,
            version: version.into(),
            executable,
            workspace_root: workspace_root.to_path_buf(),
            transport,
            approval_policy,
        })
    }

    /// The binding recorded when this attempt's Runtime was registered.
    pub fn registered_binding(&self, attempt_id: &str) -> Option<&RuntimeBinding> {
        self.registrations
            .get(attempt_id)
            .map(|registration| &registration.binding)
    }

    /// The per-manager registration sequence number of this attempt's Runtime.
    pub fn registration_seq(&self, attempt_id: &str) -> Option<u64> {
        self.registrations
            .get(attempt_id)
            .map(|registration| registration.seq)
    }

    /// The persisted identity of this attempt's current registration: this manager's instance
    /// nonce joined with the registration's sequence number. Unique per registration across
    /// Core restarts (a new manager has a new instance; `seq` is never reused within one).
    /// `None` when nothing is registered. Written into the admission-failure record and the
    /// `runtime.registration.established` record so a persisted failure can be attributed to
    /// the registration it belongs to.
    pub fn registration_identity(&self, attempt_id: &str) -> Option<String> {
        self.registration_seq(attempt_id)
            .map(|seq| format!("{}:{seq}", self.instance))
    }

    /// Whether the registered Runtime has spawned a process, or may have. The sticky
    /// `spawned` flag (set the moment a spawn succeeds, never cleared) counts, and so does
    /// any `Child`, any broker session or any spawn-time process binding — so a process Core
    /// itself spawned and then killed on a failed identity observation still counts as
    /// started. The in-process scenario adapter and the one-shot codex exec transport start
    /// no process at admission time, before any turn, and answer `false`. `None` when nothing
    /// is registered.
    pub fn process_started(&self, attempt_id: &str) -> Option<bool> {
        Some(match self.attempts.get(attempt_id)? {
            ManagedRuntime::Scenario(_) | ManagedRuntime::CodexExec(_) => false,
            ManagedRuntime::Codex(process) => {
                process.spawned || process.child.is_some() || process.process_binding.is_some()
            }
            ManagedRuntime::Grok(process) => {
                process.spawned || process.child.is_some() || process.process_binding.is_some()
            }
            ManagedRuntime::Claude(process) => {
                process.spawned
                    || process.child.is_some()
                    || process.broker.is_some()
                    || process.process_binding.is_some()
            }
        })
    }

    /// Compensation for a failed initialization of a registration the caller itself just
    /// created: the entry is removed only when it is still the caller's registration (`seq`
    /// equals the sequence number `select_runtime` assigned) AND no process was ever spawned
    /// for it. A registration whose process was spawned — alive, exited, or killed by Core's
    /// own identity check — is kept untouched (`KeptProcessStarted`); a registration the
    /// caller did not create is kept untouched (`KeptNotOurs`). Nothing is killed, waited
    /// for, released or re-created; `pending_stop`, held rows, the sequence counter (never
    /// reused) and every other registration are untouched. Dropping a never-spawned object
    /// runs a `close()` whose kill/wait is guarded by `if let Some(child)` and is a no-op.
    /// `selected_provider` is removed too (unlike `close_attempt`): `send_message` reads it
    /// as the scenario liveness proxy, so a withdrawn registration must not leave it behind.
    /// This is not a retirement path: retiring a Runtime that ran remains `close_attempt`.
    pub fn withdraw_unstarted_registration(
        &mut self,
        attempt_id: &str,
        seq: u64,
    ) -> Result<RegistrationWithdrawal, AdapterError> {
        let current_seq = self.registration_seq(attempt_id).ok_or_else(|| {
            AdapterError::InvalidRequest(format!(
                "attempt {attempt_id} has no registered Runtime to withdraw"
            ))
        })?;
        if current_seq != seq {
            return Ok(RegistrationWithdrawal::KeptNotOurs { current_seq });
        }
        if self.process_started(attempt_id) == Some(true) {
            let pid = match self.attempts.get(attempt_id) {
                Some(ManagedRuntime::Codex(process)) => {
                    process.child.as_ref().map(std::process::Child::id)
                }
                Some(ManagedRuntime::Grok(process)) => {
                    process.child.as_ref().map(std::process::Child::id)
                }
                Some(ManagedRuntime::Claude(process)) => process.managed_pid(),
                _ => None,
            };
            return Ok(RegistrationWithdrawal::KeptProcessStarted { pid });
        }
        // Never spawned: dropping the object cannot reach a process (see above).
        self.attempts.remove(attempt_id);
        self.selected_provider.remove(attempt_id);
        self.registrations.remove(attempt_id);
        Ok(RegistrationWithdrawal::Withdrawn)
    }

    /// Whether the registered Runtime is still live, by the notion each variant
    /// can actually observe: the in-process scenario adapter and the one-shot
    /// Codex exec transport are live while registered (neither holds a child
    /// between turns); Codex app-server while its child has not exited — a stored
    /// `Child` handle outlives the process, so it is polled with `try_wait`
    /// rather than tested for presence; Grok and Claude while their stream pid is
    /// live. `None` when nothing is registered.
    pub fn registration_live(&mut self, attempt_id: &str) -> Option<bool> {
        Some(match self.attempts.get_mut(attempt_id)? {
            ManagedRuntime::Scenario(_) | ManagedRuntime::CodexExec(_) => true,
            // Increment 6: a Codex registration is live only while its child has not exited AND its
            // output transport has not ended. A live pid alone no longer means usable.
            ManagedRuntime::Codex(process) => {
                !process.transport.ended()
                    && process
                        .child
                        .as_mut()
                        .is_some_and(|child| matches!(child.try_wait(), Ok(None)))
            }
            ManagedRuntime::Grok(process) => process.live_pid().is_some(),
            ManagedRuntime::Claude(process) => process.live_pid().is_some(),
        })
    }

    /// The observed state of the Runtime's output transport (increment 6). `None` when nothing is
    /// registered. Codex reflects its reader's observations; Grok/Claude are expressed from their
    /// existing stream flags (read-only — their behaviour is unchanged); the scenario and one-shot
    /// exec adapters have none.
    pub fn transport_state(&self, attempt_id: &str) -> Option<TransportState> {
        Some(match self.attempts.get(attempt_id)? {
            ManagedRuntime::Scenario(_) | ManagedRuntime::CodexExec(_) => {
                TransportState::NotApplicable
            }
            ManagedRuntime::Codex(process) => {
                if process.transport.ended() {
                    TransportState::Closed {
                        reason: process.transport.reason_str(),
                    }
                } else if process.child.is_none() {
                    TransportState::NotStarted
                } else {
                    TransportState::Open
                }
            }
            // Expression only: Grok/Claude's existing `stream_closed`/`child_ended` surface through
            // `live_pid` (None once closed); their behaviour and records are untouched.
            ManagedRuntime::Grok(process) => {
                if process.stream_ended() {
                    TransportState::Closed {
                        reason: "stream-closed",
                    }
                } else if process.live_pid().is_some() {
                    TransportState::Open
                } else {
                    TransportState::NotStarted
                }
            }
            ManagedRuntime::Claude(process) => {
                if process.stream_ended() {
                    TransportState::Closed {
                        reason: "stream-closed",
                    }
                } else if process.live_pid().is_some() {
                    TransportState::Open
                } else {
                    TransportState::NotStarted
                }
            }
        })
    }

    /// Codex registrations whose transport ended and were not yet reported to the projection; each
    /// is returned at most once. The pid is the (kept) child's — reporting a closure never claims
    /// an exit.
    pub fn take_transport_closures(&mut self) -> Vec<TransportClosure> {
        let mut closures = Vec::new();
        for (attempt_id, runtime) in self.attempts.iter_mut() {
            if let ManagedRuntime::Codex(process) = runtime {
                // Only a registration whose session was actually established this lifetime
                // (`thread_id` set by a successful `create_session`/`resume_session`) reports a
                // closure. A registration that failed during admission or resume has `thread_id`
                // unset; its closure is carried by the admission-failure / resumed-false record
                // instead (boundary 1), so it never produces a separate `runtime.transport.closed`.
                // The closure is reported only once it has been DRAINED through `poll_events`
                // (`stream_closed`), never merely marked. `flush_runtime_events` polls before it
                // takes, so the drain happens first and `closure_failed_turn` is final. Reporting on
                // `transport.ended()` alone could copy a still-false `turn_failed` into a record
                // that is written once and could never afterwards be corrected.
                if process.thread_id.is_some()
                    && process.stream_closed
                    && !process.transport_reported
                {
                    process.transport_reported = true;
                    closures.push(TransportClosure {
                        attempt_id: attempt_id.clone(),
                        reason: process.transport.reason_str(),
                        pid: process.child.as_ref().map(std::process::Child::id),
                        turn_failed: process.closure_failed_turn,
                    });
                }
            }
        }
        closures
    }

    /// Establish what can actually be confirmed about the registered Runtime's
    /// process, for the recovery classification. Confirmed-exit sources come
    /// first (a reaped child, or for brokered Claude the identity-checked OS
    /// observation `brokered_child_exited` performs); then the pid each variant
    /// can still expose is observed and compared with the spawn-time binding.
    /// Reader-side flags (`child_ended`, `stream_closed`) are never exit sources:
    /// the reader also raises them on a read error or an oversized line, so a
    /// closed stream on a process not confirmed exited is `Unknown`. `None` when
    /// nothing is registered. Observing kills nothing, waits for nothing beyond
    /// `try_wait`, and removes or replaces nothing; on the brokered Claude arm a
    /// confirmed exit is memoized by `brokered_child_exited` as it already is.
    pub fn confirm_process_identity(&mut self, attempt_id: &str) -> Option<ProcessConfirmation> {
        Some(match self.attempts.get_mut(attempt_id)? {
            ManagedRuntime::Scenario(_) | ManagedRuntime::CodexExec(_) => {
                ProcessConfirmation::NotApplicable
            }
            ManagedRuntime::Codex(process) => match process.child.as_mut() {
                None => ProcessConfirmation::Unknown {
                    reason: "Codex app-server was never started".into(),
                },
                Some(child) => match child.try_wait() {
                    Ok(Some(_)) => ProcessConfirmation::Exited {
                        pid: Some(child.id()),
                    },
                    Err(error) => ProcessConfirmation::Unknown {
                        reason: format!("try_wait failed: {error}"),
                    },
                    Ok(None) => {
                        let pid = child.id();
                        confirm_against_binding(pid, process.process_binding.as_ref())
                    }
                },
            },
            ManagedRuntime::Grok(process) => {
                if let Some(child) = process.child.as_mut() {
                    match child.try_wait() {
                        Ok(Some(_)) => {
                            return Some(ProcessConfirmation::Exited {
                                pid: Some(child.id()),
                            });
                        }
                        Err(error) => {
                            return Some(ProcessConfirmation::Unknown {
                                reason: format!("try_wait failed: {error}"),
                            });
                        }
                        Ok(None) => {}
                    }
                }
                // `child_ended` / `stream_closed` are reader-side flags: the reader also sets
                // them on a read error or an oversized line, so they never confirm an exit
                // here. A real exit of the held child is caught by `try_wait` above; a closed
                // stream on a process that could not be confirmed exited stays Unknown.
                match process.live_pid() {
                    Some(pid) => confirm_against_binding(pid, process.process_binding.as_ref()),
                    None if process.child.is_none() => ProcessConfirmation::Unknown {
                        reason: "Grok agent was never started".into(),
                    },
                    None => ProcessConfirmation::Unknown {
                        reason: "ACP stream ended; process exit not confirmed".into(),
                    },
                }
            }
            ManagedRuntime::Claude(process) => {
                if let Some(child) = process.child.as_mut() {
                    match child.try_wait() {
                        Ok(Some(_)) => {
                            return Some(ProcessConfirmation::Exited {
                                pid: Some(child.id()),
                            });
                        }
                        Err(error) => {
                            return Some(ProcessConfirmation::Unknown {
                                reason: format!("try_wait failed: {error}"),
                            });
                        }
                        Ok(None) => {}
                    }
                }
                // Brokered Claude holds no Child: its confirmed exit is the identity-checked
                // OS observation `brokered_child_exited` performs (memoized there).
                // `child_ended` / `stream_closed` alone are reader-side flags that also fire on
                // a read error or an oversized line, so a closed stream on a process that could
                // not be confirmed exited stays Unknown.
                if process.brokered_child_exited() == Some(true) {
                    ProcessConfirmation::Exited {
                        pid: process.managed_pid(),
                    }
                } else {
                    match process.live_pid() {
                        Some(pid) => confirm_against_binding(pid, process.process_binding.as_ref()),
                        None if process.managed_pid().is_none() => ProcessConfirmation::Unknown {
                            reason: "Claude stream-json was never started".into(),
                        },
                        None => ProcessConfirmation::Unknown {
                            reason: "Claude stream ended; process exit not confirmed".into(),
                        },
                    }
                }
            }
        })
    }

    /// Whether a `ManagedRuntime` is already registered under this attempt id
    /// (registered, not necessarily live: see `registration_live`).
    ///
    /// `select_runtime` refuses an occupied key instead of replacing it, because
    /// replacing would drop the previous `ManagedRuntime` — for a Claude runtime
    /// `Drop` -> `close()` -> `child.kill()`, force-killing the residual process of
    /// an interrupted turn with no event and no record. Callers that mint a new
    /// attempt still check this FIRST so they choose a vacant id rather than run
    /// into the refusal.
    pub fn has_attempt(&self, attempt_id: &str) -> bool {
        self.attempts.contains_key(attempt_id)
    }

    pub fn select_runtime(
        &mut self,
        attempt_id: &str,
        provider: &str,
        executable: Option<PathBuf>,
        version: impl Into<String>,
        workspace_root: &Path,
    ) -> Result<RuntimeIdentitySummary, AdapterError> {
        let provider = provider.trim().to_ascii_lowercase();
        if attempt_id.trim().is_empty() || provider.is_empty() {
            return Err(AdapterError::InvalidRequest(
                "attempt_id and provider are required".into(),
            ));
        }
        // The registration boundary: an occupied key is refused before anything is
        // constructed or inserted. Replacing the entry would drop the existing
        // `ManagedRuntime` (and for a native variant kill its child) with no event
        // and no record; callers that legitimately re-select the same binding are
        // served by `admit_runtime`'s reuse decision, never by replacement here.
        if self.attempts.contains_key(attempt_id) {
            return Err(AdapterError::RegistrationOccupied(format!(
                "attempt {attempt_id} already has a registered Runtime; it is kept, not replaced"
            )));
        }
        self.ensure_provider_allowed(&provider)?;
        let version = version.into();
        let binding =
            Self::intended_binding(&provider, executable, version.clone(), workspace_root)?;
        let executable = binding.executable.clone();
        let runtime = match provider.as_str() {
            "scenario" => ManagedRuntime::Scenario(Box::new(
                ScenarioAdapter::new("scenario").with_cancel_support(true),
            )),
            "codex" => {
                let executable = executable.unwrap_or_else(|| resolve_native_executable("codex"));
                let approval_policy = native_approval_policy()?;
                if std::env::var("GOALPORT_CODEX_TRANSPORT").ok().as_deref() != Some("exec") {
                    ManagedRuntime::Codex(Box::new(CodexProcess::new(
                        executable,
                        version.clone(),
                        workspace_root.to_path_buf(),
                        approval_policy,
                    )))
                } else {
                    ManagedRuntime::CodexExec(Box::new(CodexExecProcess::new(
                        executable,
                        version.clone(),
                        workspace_root.to_path_buf(),
                    )))
                }
            }
            "claude" => ManagedRuntime::Claude(Box::new(ClaudeStreamProcess::new(
                executable.unwrap_or_else(|| resolve_native_executable("claude")),
                version.clone(),
                workspace_root.to_path_buf(),
            ))),
            "grok" => ManagedRuntime::Grok(Box::new(GrokAcpProcess::new(
                executable.unwrap_or_else(|| resolve_native_executable("grok")),
                version.clone(),
                workspace_root.to_path_buf(),
            ))),
            _ => {
                return Err(AdapterError::Unsupported(format!(
                    "unknown Runtime provider {provider}"
                )));
            }
        };
        let summary = runtime.identity_summary();
        self.attempts.insert(attempt_id.to_owned(), runtime);
        self.selected_provider
            .insert(attempt_id.to_owned(), provider);
        self.registration_counter += 1;
        self.registrations.insert(
            attempt_id.to_owned(),
            Registration {
                binding,
                seq: self.registration_counter,
            },
        );
        Ok(summary)
    }

    pub fn selected_provider(&self, attempt_id: &str) -> Option<&str> {
        self.selected_provider.get(attempt_id).map(String::as_str)
    }

    pub fn create_session(
        &mut self,
        attempt_id: &str,
        request: &SessionRequest,
    ) -> Result<RuntimeSessionResult, AdapterError> {
        self.ensure_attempt_allowed(attempt_id)?;
        let runtime = self
            .attempts
            .get_mut(attempt_id)
            .ok_or_else(|| AdapterError::Connection("Runtime has not been selected".into()))?;
        match runtime {
            ManagedRuntime::Scenario(adapter) => {
                let handle = adapter.create_session(request)?;
                let events = adapter.stream_events()?;
                Ok(RuntimeSessionResult { handle, events })
            }
            ManagedRuntime::Codex(process) => process.create_session(request),
            ManagedRuntime::CodexExec(process) => process.create_session(request),
            ManagedRuntime::Claude(process) => process.create_session(request),
            ManagedRuntime::Grok(process) => process.create_session(request),
        }
    }

    pub fn send_prompt(
        &mut self,
        attempt_id: &str,
        request: &PromptRequest,
    ) -> Result<RuntimeSendResult, AdapterError> {
        self.ensure_attempt_allowed(attempt_id)?;
        let runtime = self
            .attempts
            .get_mut(attempt_id)
            .ok_or_else(|| AdapterError::Connection("Runtime has not been selected".into()))?;
        match runtime {
            ManagedRuntime::Scenario(adapter) => {
                let accepted = adapter.send_prompt(request)?;
                let events = adapter.stream_events()?;
                Ok(RuntimeSendResult {
                    accepted: accepted.accepted,
                    duplicate: accepted.duplicate,
                    session_id: adapter
                        .current_session()
                        .map(|handle| handle.session_id.clone()),
                    events,
                })
            }
            ManagedRuntime::Codex(process) => process.send_prompt(request),
            ManagedRuntime::CodexExec(process) => process.send_prompt(request),
            ManagedRuntime::Claude(process) => process.send_prompt(request),
            ManagedRuntime::Grok(process) => process.send_prompt(request),
        }
    }

    pub fn permission_response(
        &mut self,
        attempt_id: &str,
        response: PermissionResponse,
    ) -> Result<(), AdapterError> {
        self.ensure_attempt_allowed(attempt_id)?;
        let runtime = self
            .attempts
            .get_mut(attempt_id)
            .ok_or_else(|| AdapterError::Connection("Runtime has not been selected".into()))?;
        match runtime {
            ManagedRuntime::Scenario(adapter) => adapter.permission_response(response),
            ManagedRuntime::Codex(process) => process.permission_response(response),
            ManagedRuntime::CodexExec(_) => Err(AdapterError::Unsupported(
                "Codex exec JSON has no interactive permission callback channel".into(),
            )),
            ManagedRuntime::Claude(process) => process.permission_response(response),
            ManagedRuntime::Grok(process) => process.permission_response(response),
        }
    }

    pub fn interrupt(
        &mut self,
        attempt_id: &str,
    ) -> Result<crate::adapters::CancelResult, AdapterError> {
        let runtime = self
            .attempts
            .get_mut(attempt_id)
            .ok_or_else(|| AdapterError::Connection("Runtime has not been selected".into()))?;
        match runtime {
            ManagedRuntime::Scenario(adapter) => adapter.interrupt(),
            ManagedRuntime::Codex(process) => process.interrupt(),
            ManagedRuntime::CodexExec(_) => Err(AdapterError::Unsupported(
                "Codex exec JSON is a one-shot process without a safe interrupt channel".into(),
            )),
            ManagedRuntime::Claude(process) => process.interrupt(),
            ManagedRuntime::Grok(process) => process.interrupt(),
        }
    }

    /// Capture the exact active Claude input before Core durably records Stop.
    pub fn claude_turn_binding(&self, attempt_id: &str) -> Option<Value> {
        let ManagedRuntime::Claude(process) = self.attempts.get(attempt_id)? else {
            return None;
        };
        if !process.turn_in_flight {
            return None;
        }
        Some(json!({
            "input_uuid": process.input_uuid.as_ref()?,
            "session_id": process.session_id.as_ref()?,
            "turn_epoch": process.turn_epoch,
            "process_epoch": process.process_binding.as_ref()?.process_epoch
        }))
    }

    pub fn interrupt_with_operation(
        &mut self,
        attempt_id: &str,
        operation_id: &str,
    ) -> Result<crate::adapters::CancelResult, AdapterError> {
        if operation_id.trim().is_empty() {
            return Err(AdapterError::InvalidRequest(
                "Stop operation id is required".into(),
            ));
        }
        if let Some(ManagedRuntime::Claude(process)) = self.attempts.get_mut(attempt_id) {
            if process.pending_stop.is_none() {
                process.stop_operation_id = Some(operation_id.to_owned());
            }
        }
        self.interrupt(attempt_id)
    }

    pub fn resume_session(
        &mut self,
        attempt_id: &str,
        session_id: &str,
    ) -> Result<RuntimeSessionResult, AdapterError> {
        self.ensure_attempt_allowed(attempt_id)?;
        let runtime = self
            .attempts
            .get_mut(attempt_id)
            .ok_or_else(|| AdapterError::Connection("Runtime has not been selected".into()))?;
        match runtime {
            ManagedRuntime::Scenario(adapter) => {
                let handle = adapter.resume_session(session_id)?;
                Ok(RuntimeSessionResult {
                    handle,
                    events: adapter.stream_events()?,
                })
            }
            ManagedRuntime::Codex(process) => process.resume_session(session_id),
            ManagedRuntime::CodexExec(_) => Err(AdapterError::Unsupported(
                "Codex exec JSON has no verified native resume method".into(),
            )),
            ManagedRuntime::Claude(process) => process.resume_session(session_id),
            ManagedRuntime::Grok(process) => process.resume_session(session_id),
        }
    }

    /// Resume a persisted native session under the attempt's canonical context. `request`
    /// carries the validated Attempt, Campaign and Task ids and the workspace the caller derived
    /// from the persisted objects the attempt is bound to (never from a UI selection or a
    /// default) and `resume_session: Some(session id)`. The Codex arm sets the process's identity
    /// fields from it BEFORE the resume, so every event the resumed process later reads carries
    /// the canonical task and campaign and passes the projection's binding check; the process
    /// keeps its own spawn-time identity. The other arms behave exactly as `resume_session`:
    /// Grok's direct resume still leaves its fields unset (a disclosed gap, not changed here).
    /// The reader attach and the resume itself happen inside the adapter's `resume_session`.
    pub fn resume_session_with_context(
        &mut self,
        attempt_id: &str,
        request: &SessionRequest,
    ) -> Result<RuntimeSessionResult, AdapterError> {
        self.ensure_attempt_allowed(attempt_id)?;
        request.validate()?;
        if request.attempt_id != attempt_id {
            return Err(AdapterError::InvalidRequest(
                "resume context names another attempt".into(),
            ));
        }
        let session_id = request
            .resume_session
            .as_deref()
            .filter(|session| !session.trim().is_empty())
            .ok_or_else(|| {
                AdapterError::InvalidRequest("resume requires a persisted session id".into())
            })?
            .to_owned();
        if let Some(ManagedRuntime::Codex(process)) = self.attempts.get_mut(attempt_id) {
            process.attempt_id = Some(request.attempt_id.clone());
            process.campaign_id = request.campaign_id.clone();
            process.task_id = Some(request.task_id.clone());
        }
        self.resume_session(attempt_id, &session_id)
    }

    pub fn close_attempt(&mut self, attempt_id: &str) -> Result<(), AdapterError> {
        let Some(mut runtime) = self.attempts.remove(attempt_id) else {
            return Ok(());
        };
        self.registrations.remove(attempt_id);
        match &mut runtime {
            ManagedRuntime::Scenario(adapter) => adapter.close(),
            ManagedRuntime::Codex(process) => process.close(),
            ManagedRuntime::CodexExec(process) => process.close(),
            ManagedRuntime::Claude(process) => process.close(),
            ManagedRuntime::Grok(process) => process.close(),
        }
    }

    /// Drain structured provider messages that arrived while the desktop was
    /// disconnected. The Core caller persists these events before exposing its
    /// next projection.
    pub fn poll_events(
        &mut self,
        attempt_id: &str,
    ) -> Result<Vec<AgentEventEnvelope>, AdapterError> {
        let runtime = self
            .attempts
            .get_mut(attempt_id)
            .ok_or_else(|| AdapterError::Connection("Runtime has not been selected".into()))?;
        match runtime {
            ManagedRuntime::Codex(process) => process.poll_events(attempt_id),
            ManagedRuntime::Grok(process) => process.poll_events(attempt_id),
            ManagedRuntime::Claude(process) => process.poll_events(attempt_id),
            ManagedRuntime::CodexExec(_) | ManagedRuntime::Scenario(_) => Ok(Vec::new()),
        }
    }

    pub fn poll_all_events(&mut self) -> Result<Vec<AgentEventEnvelope>, AdapterError> {
        let attempt_ids = self.attempts.keys().cloned().collect::<Vec<_>>();
        let mut events = Vec::new();
        for attempt_id in attempt_ids {
            events.extend(self.poll_events(&attempt_id)?);
        }
        Ok(events)
    }

    pub fn native_pid(&self, attempt_id: &str) -> Option<u32> {
        match self.attempts.get(attempt_id)? {
            ManagedRuntime::Codex(process) => process.child.as_ref().map(std::process::Child::id),
            ManagedRuntime::Grok(process) => process.live_pid(),
            ManagedRuntime::Claude(process) => process.live_pid(),
            ManagedRuntime::CodexExec(_) | ManagedRuntime::Scenario(_) => None,
        }
    }

    /// Whether the Runtime attached to this Attempt still owes a response for a
    /// prompt. R3: the Codex arm is included — an acknowledged native turn OR a
    /// pending, successfully-written start request both count for send
    /// exclusion. A `delivery_unknown` write does not (it is degraded, not
    /// in flight), and CodexExec has no turn concept.
    pub fn turn_in_flight(&self, attempt_id: &str) -> bool {
        match self.attempts.get(attempt_id) {
            Some(ManagedRuntime::Codex(process)) => process.turn_in_flight(),
            Some(ManagedRuntime::Grok(process)) => process.turn_in_flight(),
            Some(ManagedRuntime::Claude(process)) => process.turn_in_flight(),
            _ => false,
        }
    }

    /// The turn facts the product projection needs, per provider, without
    /// inferring anything from `Attempt.active`:
    /// - `in_flight`: the Runtime still owes a response (send exclusion);
    /// - `stoppable`: a proven cancellable live turn exists — for Codex an
    ///   acknowledged native turn with an open output transport; for Claude and
    ///   Grok an in-flight turn, whose stop paths are directly defined;
    /// - `delivery_unknown`: a Codex start whose delivery could not be confirmed;
    ///   such a registration never reports a ready turn.
    /// Claude residual-hold behavior is unchanged: it lives in the store, not
    /// here.
    pub fn turn_facts(&self, attempt_id: &str) -> Option<TurnFacts> {
        match self.attempts.get(attempt_id) {
            Some(ManagedRuntime::Codex(process)) => Some(TurnFacts {
                in_flight: process.turn_in_flight(),
                stoppable: process.acknowledged_turn_in_flight() && !process.transport.ended(),
                delivery_unknown: process.delivery_unknown,
            }),
            Some(ManagedRuntime::Grok(process)) => {
                let in_flight = process.turn_in_flight();
                Some(TurnFacts {
                    in_flight,
                    stoppable: in_flight,
                    delivery_unknown: false,
                })
            }
            Some(ManagedRuntime::Claude(process)) => {
                let in_flight = process.turn_in_flight();
                Some(TurnFacts {
                    in_flight,
                    stoppable: in_flight,
                    delivery_unknown: false,
                })
            }
            Some(ManagedRuntime::CodexExec(_) | ManagedRuntime::Scenario(_)) => Some(TurnFacts {
                in_flight: false,
                stoppable: false,
                delivery_unknown: false,
            }),
            None => None,
        }
    }

    pub fn process_epoch(&self, attempt_id: &str) -> Option<String> {
        match self.attempts.get(attempt_id)? {
            ManagedRuntime::Codex(process) => process
                .process_binding
                .as_ref()
                .map(|binding| binding.process_epoch.clone()),
            ManagedRuntime::Grok(process) => process
                .process_binding
                .as_ref()
                .map(|binding| binding.process_epoch.clone()),
            ManagedRuntime::Claude(process) => process
                .process_binding
                .as_ref()
                .map(|binding| binding.process_epoch.clone()),
            ManagedRuntime::CodexExec(_) => Some("codex-exec-oneshot".into()),
            ManagedRuntime::Scenario(_) => Some("scenario-inprocess".into()),
        }
    }

    pub fn process_binding(&self, attempt_id: &str) -> Option<RuntimeProcessBinding> {
        match self.attempts.get(attempt_id)? {
            ManagedRuntime::Codex(process) => process.process_binding.clone(),
            ManagedRuntime::Grok(process) => process.process_binding.clone(),
            ManagedRuntime::Claude(process) => process.process_binding.clone(),
            ManagedRuntime::CodexExec(_) | ManagedRuntime::Scenario(_) => None,
        }
    }

    pub fn drop_adapter_transport(&mut self, attempt_id: &str) -> Result<(), AdapterError> {
        let runtime = self
            .attempts
            .get_mut(attempt_id)
            .ok_or_else(|| AdapterError::Connection("Runtime has not been selected".into()))?;
        match runtime {
            ManagedRuntime::Codex(process) => process.drop_stdio(),
            ManagedRuntime::Grok(process) => process.drop_stdio(),
            ManagedRuntime::Claude(process) => process.drop_stdio(),
            ManagedRuntime::CodexExec(_) => Err(AdapterError::Unsupported(
                "one-shot transport close is process exit, not a live stdio drop".into(),
            )),
            ManagedRuntime::Scenario(_) => Ok(()),
        }
    }

    pub fn reconstruct_without_spawn(&mut self, attempt_id: &str, provider: &str) {
        self.selected_provider
            .insert(attempt_id.to_owned(), provider.to_ascii_lowercase());
    }
}

impl ManagedRuntime {
    fn identity_summary(&self) -> RuntimeIdentitySummary {
        match self {
            Self::Scenario(adapter) => {
                let identity = adapter.runtime_identity();
                RuntimeIdentitySummary {
                    provider: identity.provider,
                    version: identity.version,
                    executable: identity.executable,
                    protocol: identity.protocol_version,
                    native: false,
                }
            }
            Self::Codex(process) => process.identity_summary(),
            Self::CodexExec(process) => process.identity_summary(),
            Self::Claude(process) => process.identity_summary(),
            Self::Grok(process) => process.identity_summary(),
        }
    }
}

/// The Codex output transport's observed health (increment 6). Every reader of the stream — the
/// background reader thread and the main-thread `read_until_response` — marks this the moment it
/// observes the stream end (EOF while the process may still run, an oversized frame, or a read
/// error). First observation wins, so the first reason is the one kept. Shared through an `Arc` so
/// the reader thread and the owning `CodexProcess` see the same flag.
#[derive(Debug, Default)]
struct CodexTransport {
    ended: AtomicBool,
    reason: AtomicU8,
}

const TRANSPORT_EOF: u8 = 1;
const TRANSPORT_OVERSIZED: u8 = 2;
const TRANSPORT_READ_ERROR: u8 = 3;
/// Core itself discarded its side of the transport (`drop_stdio`). The provider may be perfectly
/// healthy; what is unusable is THIS Core's ability to read it, which is what usability means here.
const TRANSPORT_DROPPED: u8 = 4;

impl CodexTransport {
    /// Record an observed closure. Idempotent: only the first observation sets the reason.
    fn mark(&self, reason: u8) {
        // The reason is claimed first-writer-wins and stored BEFORE `ended` is set, so a thread
        // that reads `ended == true` can never see a reason that has not been written yet (which
        // would read as the "eof" default). A later marker's reason is discarded, keeping the first
        // observation's - the closure that actually happened first.
        let _ = self
            .reason
            .compare_exchange(0, reason, Ordering::SeqCst, Ordering::SeqCst);
        self.ended.store(true, Ordering::SeqCst);
    }

    fn ended(&self) -> bool {
        self.ended.load(Ordering::SeqCst)
    }

    fn reason_str(&self) -> &'static str {
        match self.reason.load(Ordering::SeqCst) {
            TRANSPORT_OVERSIZED => "oversized-frame",
            TRANSPORT_READ_ERROR => "read-error",
            TRANSPORT_DROPPED => "transport-dropped",
            _ => "eof",
        }
    }
}

#[derive(Debug)]
struct CodexProcess {
    executable: PathBuf,
    version: String,
    workspace_root: PathBuf,
    child: Option<Child>,
    stdin: Option<Arc<Mutex<ChildStdin>>>,
    stdout: Option<BufReader<ChildStdout>>,
    event_rx: Option<Receiver<NativeMessage>>,
    permission_tx: Option<Sender<PermissionCommand>>,
    next_id: u64,
    thread_id: Option<String>,
    /// R3 turn facts, deliberately split so a locally generated request id can
    /// never masquerade as a provider turn:
    /// - `pending_start_request_id`: a turn/start whose JSON write succeeded but
    ///   whose native acknowledgement has not been observed yet. Set only AFTER
    /// the write succeeds.
    /// - `native_turn_id`: the turn id the provider itself acknowledged (matched
    /// by request id, or a correlated started notification on the bound thread).
    /// Never a generated `turn-N`.
    /// - `delivery_unknown`: a turn/start write whose delivery could not be
    ///   confirmed. Latched; such a registration never reports a ready turn.
    pending_start_request_id: Option<u64>,
    native_turn_id: Option<String>,
    delivery_unknown: bool,
    sequence: i64,
    attempt_id: Option<String>,
    campaign_id: Option<String>,
    task_id: Option<String>,
    process_binding: Option<RuntimeProcessBinding>,
    /// Set the moment a spawn succeeds and never cleared: a process existed at some point,
    /// whatever happened to it afterwards (see `RuntimeManager::process_started`).
    spawned: bool,
    approval_policy: String,
    /// The observed output-transport health, shared with the reader thread (increment 6).
    transport: Arc<CodexTransport>,
    /// The `Closed` message has been drained through `poll_events` (so a `TurnFailed` was emitted
    /// once if a turn was in flight).
    stream_closed: bool,
    /// A turn was in flight when the stream closed, so `poll_events` emitted a `TurnFailed`. The
    /// projection carries this onto the transport record's `turnFailed`.
    closure_failed_turn: bool,
    /// The projection has taken this closure through `take_transport_closures`.
    transport_reported: bool,
}

#[derive(Debug)]
enum NativeMessage {
    Json(Value),
    Closed,
}

#[derive(Debug)]
struct PermissionCommand {
    request_id: String,
    allow: bool,
    /// Set by `interrupt` so a reader blocked on a pending native permission
    /// request can answer it `cancelled` and resume reading. Without this the
    /// cancelled stopReason could never be observed (critic finding F1).
    cancel: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CodexStartFailure {
    request_id: u64,
    detail: String,
}

impl CodexProcess {
    fn new(
        executable: PathBuf,
        version: String,
        workspace_root: PathBuf,
        approval_policy: String,
    ) -> Self {
        Self {
            executable,
            version,
            workspace_root,
            child: None,
            stdin: None,
            stdout: None,
            event_rx: None,
            permission_tx: None,
            next_id: 1,
            thread_id: None,
            pending_start_request_id: None,
            native_turn_id: None,
            delivery_unknown: false,
            sequence: 0,
            attempt_id: None,
            campaign_id: None,
            task_id: None,
            process_binding: None,
            spawned: false,
            approval_policy,
            transport: Arc::new(CodexTransport::default()),
            stream_closed: false,
            closure_failed_turn: false,
            transport_reported: false,
        }
    }

    fn identity_summary(&self) -> RuntimeIdentitySummary {
        RuntimeIdentitySummary {
            provider: "codex".into(),
            version: self.version.clone(),
            executable: Some(self.executable.to_string_lossy().into_owned()),
            protocol: CODEX_PROTOCOL_VERSION.into(),
            native: true,
        }
    }

    /// R3: an in-flight turn is an acknowledged native turn OR a pending,
    /// successfully-written start request (send exclusion).
    fn turn_in_flight(&self) -> bool {
        self.native_turn_id.is_some() || self.pending_start_request_id.is_some()
    }

    /// R3: a cancellable turn requires the provider's own acknowledgement.
    fn acknowledged_turn_in_flight(&self) -> bool {
        self.native_turn_id.is_some()
    }

    fn ensure_started(&mut self) -> Result<(), AdapterError> {
        if self.child.is_some() {
            return Ok(());
        }
        let mut command = Command::new(&self.executable);
        command
            .args(["app-server", "--listen", "stdio://"])
            .current_dir(&self.workspace_root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            // A native subscription is selected through the installed CLI's
            // own login. API-key environment variables are never forwarded.
            .env_remove("OPENAI_API_KEY")
            .env_remove("ANTHROPIC_API_KEY")
            .env_remove("XAI_API_KEY");
        hide_native_console(&mut command);
        debug_runtime(&format!(
            "spawning Codex app-server exe={} cwd={}",
            self.executable.display(),
            self.workspace_root.display()
        ));
        let mut child = command.spawn().map_err(|error| {
            AdapterError::Connection(format!("unable to start Codex app-server: {error}"))
        })?;
        self.spawned = true;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| AdapterError::Connection("Codex app-server stdin unavailable".into()))?;
        let stdout = child.stdout.take().ok_or_else(|| {
            AdapterError::Connection("Codex app-server stdout unavailable".into())
        })?;
        let pid = child.id();
        let observed = match process_identity::observe_process(pid) {
            ProcessObservation::Live(identity) => identity,
            ProcessObservation::NotRunning => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(AdapterError::Connection(
                    "Codex app-server exited before its process identity was observed".into(),
                ));
            }
            ProcessObservation::Unknown(reason) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(AdapterError::Connection(format!(
                    "Codex app-server process identity is unknown: {reason}"
                )));
            }
        };
        let canonical = format!(
            "codex|{}|{}|{}|{}",
            observed.pid,
            observed.created_ms,
            observed.executable_path.to_ascii_lowercase(),
            observed.executable_sha256.to_ascii_lowercase()
        );
        self.process_binding = Some(RuntimeProcessBinding {
            process_epoch: format!("runtime-epoch:{}", sha256_hex(canonical.as_bytes())),
            pid: observed.pid,
            creation_date: observed.creation_date(),
            executable_path: observed.executable_path,
            executable_sha256: observed.executable_sha256,
        });
        self.child = Some(child);
        self.stdin = Some(Arc::new(Mutex::new(stdin)));
        self.stdout = Some(BufReader::new(stdout));
        let init_id = self.next_request_id();
        debug_runtime(&format!("sending initialize id={init_id}"));
        self.send_json(&json!({
            "id": init_id,
            "method": "initialize",
            "params": {
                "clientInfo": { "name": "goalport-core", "version": env!("CARGO_PKG_VERSION") },
                "capabilities": { "experimentalApi": false }
            }
        }))?;
        self.read_until_response(init_id, None, None)?;
        debug_runtime("initialize response received");
        self.send_json(&json!({ "method": "initialized", "params": {} }))?;
        Ok(())
    }

    fn create_session(
        &mut self,
        request: &SessionRequest,
    ) -> Result<RuntimeSessionResult, AdapterError> {
        request.validate()?;
        self.attempt_id = Some(request.attempt_id.clone());
        self.campaign_id = request.campaign_id.clone();
        self.task_id = Some(request.task_id.clone());
        self.ensure_started()?;
        if let Some(session_id) = request.resume_session.as_deref() {
            return self.resume_session(session_id);
        }
        let id = self.next_request_id();
        debug_runtime(&format!("sending thread/start id={id}"));
        self.send_json(&json!({
            "id": id,
            "method": "thread/start",
            "params": {
                "cwd": request.workspace_root.to_string_lossy(),
                "approvalPolicy": self.approval_policy,
                "threadSource": "goalport"
            }
        }))?;
        let value = self.read_until_response(id, None, None)?;
        debug_runtime("thread/start response received");
        let session = value
            .get("result")
            .and_then(|result| result.get("thread").or_else(|| result.get("threadId")))
            .and_then(|thread| {
                thread
                    .get("id")
                    .and_then(Value::as_str)
                    .or_else(|| thread.as_str())
            })
            .map(str::to_owned)
            .or_else(|| {
                value
                    .get("result")
                    .and_then(|r| r.get("id"))
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .ok_or_else(|| AdapterError::Protocol("thread/start returned no thread id".into()))?;
        self.start_reader()?;
        // Increment 6: a closure the reader has ALREADY observed (an app-server that answered
        // thread/start then closed its stdout) means the session is not usable. Fail here rather
        // than hand back a registration whose events can never be read. This inspects what was
        // observed; it waits for nothing and guarantees nothing about later reads.
        if self.transport.ended() {
            return Err(AdapterError::Connection(format!(
                "Codex output stream closed before the session became usable ({})",
                self.transport.reason_str()
            )));
        }
        // `thread_id` is what `send_prompt` and the closure reporting treat as "this session was
        // established", so it is set only once the reader is attached AND the stream is still open.
        // Setting it earlier would leave a failed initialization looking established: prompts would
        // be accepted with no reader, and a pre-establishment closure would be reported as if it
        // had happened to a live session.
        self.thread_id = Some(session.clone());
        let instruction_marker = value
            .get("result")
            .and_then(|result| result.get("instructionSources"))
            .and_then(Value::as_array)
            .map(|sources| {
                sources.iter().any(|source| {
                    source
                        .as_str()
                        .is_some_and(|path| path.contains("synthetic-workspace"))
                })
            })
            .unwrap_or(false);
        Ok(RuntimeSessionResult {
            handle: SessionHandle {
                session_id: session,
                resumed: false,
            },
            events: vec![AgentEventEnvelope {
                event_id: format!("codex-session-{}", monotonic_id()),
                campaign_id: self.campaign_id.clone(),
                task_id: self.task_id.clone().unwrap_or_default(),
                attempt_id: self.attempt_id.clone().unwrap_or_default(),
                process_epoch_id: self
                    .process_binding
                    .as_ref()
                    .map(|binding| binding.process_epoch.clone())
                    .ok_or_else(|| {
                        AdapterError::Connection("Codex process epoch is unavailable".into())
                    })?,
                sequence: 0,
                occurred_at: now(),
                received_at: now(),
                provider_event_reference: None,
                event_type: AgentEventType::SessionCreated,
                payload: json!({
                    "session_id": "[NATIVE_SESSION]",
                    "native_instruction_marker": instruction_marker,
                    "native_surfaces": "instruction source observed; skills and hooks remain runtime-owned"
                }),
            }],
        })
    }

    fn resume_session(&mut self, session_id: &str) -> Result<RuntimeSessionResult, AdapterError> {
        if session_id.trim().is_empty() {
            return Err(AdapterError::InvalidRequest("session id is empty".into()));
        }
        if self.event_rx.is_some() {
            return Err(AdapterError::Unsupported(
                "native session resume requires a fresh app-server attachment; UI reconnect does not resume execution".into(),
            ));
        }
        self.ensure_started()?;
        let id = self.next_request_id();
        debug_runtime(&format!("sending turn/start id={id}"));
        self.send_json(&json!({
            "id": id,
            "method": "thread/resume",
            "params": { "threadId": session_id, "approvalPolicy": self.approval_policy }
        }))?;
        let value = self.read_until_response(id, None, None)?;
        if value.get("error").is_some() {
            return Err(AdapterError::Protocol(
                "thread/resume was rejected by Codex".into(),
            ));
        }
        // A resumed thread is only usable once the existing event-reading path is attached, as
        // `create_session` does after `thread/start`: without the reader, prompts would be
        // accepted but `poll_events` could never deliver the provider's replies. `start_reader`
        // is idempotent and this path refused an existing reader above, so exactly one reader
        // owns the stream; if it cannot start, the resume fails and nothing records success.
        self.start_reader()?;
        // Increment 6: as in `create_session`, a closure the reader has already observed means the
        // resumed session is not usable; fail rather than record success.
        if self.transport.ended() {
            return Err(AdapterError::Connection(format!(
                "Codex output stream closed before the session became usable ({})",
                self.transport.reason_str()
            )));
        }
        // Set only once the reader is attached and the stream is still open (see `create_session`).
        self.thread_id = Some(session_id.to_owned());
        Ok(RuntimeSessionResult {
            handle: SessionHandle {
                session_id: session_id.to_owned(),
                resumed: true,
            },
            events: Vec::new(),
        })
    }

    fn send_prompt(&mut self, request: &PromptRequest) -> Result<RuntimeSendResult, AdapterError> {
        request.validate()?;
        if self.thread_id.is_none() {
            return Err(AdapterError::Connection(
                "Codex thread is not active".into(),
            ));
        }
        // Increment 6: an observed closure is not usable. Refuse BEFORE writing, so the input is
        // never sent to a Runtime whose reply can never be read; the projection reports this as a
        // FAILED delivery (never re-sent to prove the failure).
        if self.transport.ended() {
            return Err(AdapterError::Connection(format!(
                "Codex output stream is closed ({}); the input was not sent",
                self.transport.reason_str()
            )));
        }
        let id = self.next_request_id();
        // R3: pending is marked only after the write succeeds; a write failure
        // latches delivery_unknown instead. The generated request id is never
        // recorded as a native turn.
        let written = self.send_json(&json!({
            "id": id,
            "method": "turn/start",
            "params": {
                "threadId": self.thread_id,
                "input": [{ "type": "text", "text": request.text }],
                "clientUserMessageId": request.idempotency_key
            }
        }));
        if let Err(error) = written {
            self.delivery_unknown = true;
            return Err(AdapterError::Connection(format!(
                "Codex input write failed; delivery unknown: {error}"
            )));
        }
        self.pending_start_request_id = Some(id);
        // The reader thread now owns the provider stdout. Returning after the
        // request is flushed keeps the UI responsive and lets Core snapshots
        // persist pre-terminal events while the native turn is still active.
        Ok(RuntimeSendResult {
            accepted: true,
            duplicate: false,
            session_id: self.thread_id.clone(),
            events: Vec::new(),
        })
    }

    fn poll_events(&mut self, attempt_id: &str) -> Result<Vec<AgentEventEnvelope>, AdapterError> {
        let Some(receiver) = self.event_rx.as_ref() else {
            return Ok(Vec::new());
        };
        let values = receiver.try_iter().collect::<Vec<_>>();
        let mut events = Vec::new();
        for message in values {
            let value = match message {
                NativeMessage::Json(value) => value,
                // Increment 6: a closed stream is not swallowed. If a turn was in flight when the
                // stream ended it can never complete, so it is failed here (never a silent
                // completion, never a respawn); the closure is latched so `TurnFailed` is emitted
                // at most once. `take_transport_closures` reports the closure to the projection.
                NativeMessage::Closed => {
                    if !self.stream_closed {
                        self.stream_closed = true;
                        let reason = self.transport.reason_str();
                        // R3: an acknowledged native turn is referenced by its
                        // provider turn id; a still-pending start by its request
                        // id. Both are cleared; a closed stream can never become
                        // a ready turn again.
                        let turn_reference = self
                            .native_turn_id
                            .take()
                            .map(|turn_id| format!("codex-turn:{turn_id}"))
                            .or_else(|| {
                                self.pending_start_request_id.take().map(|request_id| {
                                    format!("codex-turn-start-request:{request_id}")
                                })
                            });
                        if let Some(turn_reference) = turn_reference {
                            self.closure_failed_turn = true;
                            self.sequence += 1;
                            events.push(AgentEventEnvelope {
                                event_id: format!("codex-event-{}", self.sequence),
                                campaign_id: self.campaign_id.clone(),
                                task_id: self.task_id.clone().unwrap_or_default(),
                                attempt_id: attempt_id.to_owned(),
                                process_epoch_id: self
                                    .process_binding
                                    .as_ref()
                                    .map(|binding| binding.process_epoch.clone())
                                    .unwrap_or_default(),
                                sequence: self.sequence,
                                occurred_at: now(),
                                received_at: now(),
                                provider_event_reference: Some(turn_reference),
                                event_type: AgentEventType::TurnFailed,
                                payload: json!({
                                    "status": "failed",
                                    "text": format!("Codex output stream closed ({reason})"),
                                    "transport": { "closed": true, "reason": reason }
                                }),
                            });
                        }
                    }
                    break;
                }
            };
            if let Some(failure) = self.observe_native_message(&value) {
                self.sequence += 1;
                events.push(AgentEventEnvelope {
                    event_id: format!("codex-event-{}", self.sequence),
                    campaign_id: self.campaign_id.clone(),
                    task_id: self.task_id.clone().unwrap_or_default(),
                    attempt_id: attempt_id.to_owned(),
                    process_epoch_id: self
                        .process_binding
                        .as_ref()
                        .map(|binding| binding.process_epoch.clone())
                        .unwrap_or_default(),
                    sequence: self.sequence,
                    occurred_at: now(),
                    received_at: now(),
                    provider_event_reference: Some(format!(
                        "codex-turn-start-request:{}",
                        failure.request_id
                    )),
                    event_type: AgentEventType::TurnFailed,
                    payload: json!({
                        "status": "failed",
                        "text": "Codex rejected the turn start request",
                        "turnStartRequestId": failure.request_id,
                        "error": failure.detail,
                        "nativeTurnId": Value::Null
                    }),
                });
                // The matching JSON-RPC error is represented by the correlated
                // TurnFailed above. Do not also persist it as an unknown raw
                // provider event: one rejected start produces one terminal fact.
                continue;
            }
            let method = value
                .get("method")
                .and_then(Value::as_str)
                .unwrap_or("notification");
            let terminal = matches!(
                classify_codex_method(method, &value),
                AgentEventType::TurnCompleted
                    | AgentEventType::TurnFailed
                    | AgentEventType::Cancelled
            );
            // Never let an old/foreign terminal finish the current turn or
            // transition its durable Attempt. Preserve unmatched frames as raw evidence.
            let params = value.get("params");
            let terminal_turn = params
                .and_then(|p| {
                    p.get("turnId")
                        .or_else(|| p.get("turn").and_then(|t| t.get("id")))
                })
                .and_then(Value::as_str);
            let terminal_thread = params
                .and_then(|p| p.get("threadId"))
                .and_then(Value::as_str);
            let terminal_matches = terminal_turn.is_some()
                && terminal_turn == self.native_turn_id.as_deref()
                && terminal_thread == self.thread_id.as_deref();
            if let Some(mut event) = self.native_event(attempt_id, method, &value) {
                if terminal && !terminal_matches {
                    event.event_type = AgentEventType::Unknown;
                }
                self.sequence += 1;
                let mut event = event;
                event.sequence = self.sequence;
                event.event_id = format!("codex-event-{}", self.sequence);
                events.push(event);
            }
            if terminal && terminal_matches {
                // R3: a terminal for the bound turn clears BOTH facts. A stale or
                // unsolicited response arriving afterwards finds no pending and
                // no native turn and can never resurrect one.
                self.native_turn_id = None;
                self.pending_start_request_id = None;
            }
        }
        Ok(events)
    }

    /// R3 turn-fact matcher. Runs for every native message before it is
    /// classified:
    /// - a RESPONSE whose id equals `pending_start_request_id` either promotes
    ///   the provider's `result.turn.id` to `native_turn_id` (valid ack) or, on
    ///   an error response, clears the pending start;
    /// - a NOTIFICATION correlated with the bound thread (`params.threadId`) that
    ///   carries a `turnId` promotes it while a start is still pending;
    /// - anything else — a response for another request, an unsolicited frame,
    ///   a notification for another thread — is ignored, and nothing can set a
    ///   native turn once the facts are clear (after a terminal or a closure).
    fn observe_native_message(&mut self, value: &Value) -> Option<CodexStartFailure> {
        let pending = match self.pending_start_request_id {
            Some(pending) => pending,
            None => return None,
        };
        if let Some(response_id) = value.get("id").and_then(Value::as_u64) {
            if response_id != pending || value.get("method").is_some() {
                return None;
            }
            if let Some(error) = value.get("error") {
                // An error response answers the start: the turn was not created.
                // Return a bounded, correlated failure so poll_events can make
                // the rejection durable before the pending fact is forgotten.
                self.pending_start_request_id = None;
                return Some(CodexStartFailure {
                    request_id: pending,
                    detail: bounded_codex_error(error),
                });
            }
            if let Some(turn_id) = value
                .get("result")
                .and_then(|result| result.get("turn"))
                .and_then(|turn| turn.get("id"))
                .and_then(Value::as_str)
                .filter(|id| !id.trim().is_empty())
            {
                self.native_turn_id = Some(turn_id.to_owned());
                self.pending_start_request_id = None;
            }
            return None;
        }
        // Only a start notification can acknowledge a pending request.
        // Deltas and terminal frames may belong to a previous turn.
        if value.get("method").and_then(Value::as_str) != Some("turn/started") {
            return None;
        }
        let bound_thread = value
            .get("params")
            .and_then(|params| params.get("threadId"))
            .and_then(Value::as_str);
        if bound_thread.is_none() || bound_thread != self.thread_id.as_deref() {
            return None;
        }
        if let Some(turn_id) = value
            .get("params")
            .and_then(|params| {
                params
                    .get("turnId")
                    .or_else(|| params.get("turn").and_then(|turn| turn.get("id")))
            })
            .and_then(Value::as_str)
            .filter(|id| !id.trim().is_empty())
        {
            self.native_turn_id = Some(turn_id.to_owned());
            self.pending_start_request_id = None;
        }
        None
    }

    fn start_reader(&mut self) -> Result<(), AdapterError> {
        if self.event_rx.is_some() {
            return Ok(());
        }
        // If a reader cannot be attached at all, this registration can never deliver a reply. Mark
        // the transport on every failure path so liveness, the send refusal and the reuse refusal
        // treat it as closed instead of trusting a live child.
        let Some(mut stdout) = self.stdout.take() else {
            self.transport.mark(TRANSPORT_READ_ERROR);
            return Err(AdapterError::Connection("Codex stdout is closed".into()));
        };
        let Some(stdin) = self.stdin.as_ref().cloned() else {
            self.transport.mark(TRANSPORT_READ_ERROR);
            return Err(AdapterError::Connection("Codex stdin is closed".into()));
        };
        let (event_tx, event_rx) = mpsc::channel();
        let (permission_tx, permission_rx): (
            Sender<PermissionCommand>,
            Receiver<PermissionCommand>,
        ) = mpsc::channel();
        // Increment 6: the reader records the observed transport closure (its reason) BEFORE it
        // sends `Closed`, so the manager can reflect it in liveness and the projection can persist
        // it. First observation wins (see `CodexTransport::mark`).
        let transport = Arc::clone(&self.transport);
        let spawned = std::thread::Builder::new()
            .name("goalport-codex-reader".into())
            .spawn(move || {
                loop {
                    let mut line = String::new();
                    match stdout.read_line(&mut line) {
                        Ok(0) => {
                            transport.mark(TRANSPORT_EOF);
                            let _ = event_tx.send(NativeMessage::Closed);
                            break;
                        }
                        Ok(size) if size > MAX_NATIVE_LINE_BYTES => {
                            transport.mark(TRANSPORT_OVERSIZED);
                            let _ = event_tx.send(NativeMessage::Closed);
                            break;
                        }
                        Ok(_) => {}
                        Err(_) => {
                            transport.mark(TRANSPORT_READ_ERROR);
                            let _ = event_tx.send(NativeMessage::Closed);
                            break;
                        }
                    }
                    let Ok(value) = serde_json::from_str::<Value>(line.trim_end()) else {
                        continue;
                    };
                    let is_permission = value
                        .get("method")
                        .and_then(Value::as_str)
                        .map(|method| {
                            let lower = method.to_ascii_lowercase();
                            lower.contains("approval") || lower.contains("permission")
                        })
                        .unwrap_or(false)
                        && value.get("id").is_some_and(|id| !id.is_null());
                    let _ = event_tx.send(NativeMessage::Json(value.clone()));
                    if !is_permission {
                        continue;
                    }
                    let native_id = value.get("id").map(bounded_scalar).unwrap_or_default();
                    // A reader that stops for ANY reason leaves this registration unable to deliver
                    // a reply, so every exit below records an observed closure exactly like EOF.
                    // Without it the live child and a set thread id would keep reporting the
                    // registration usable and an in-flight turn would never be failed.
                    let Some(decision) = permission_rx
                        .iter()
                        .find(|command| command.request_id == native_id)
                    else {
                        transport.mark(TRANSPORT_READ_ERROR);
                        let _ = event_tx.send(NativeMessage::Closed);
                        break;
                    };
                    let response = json!({
                        "id": value.get("id").cloned().unwrap_or(Value::Null),
                        "result": { "decision": if decision.allow { "accept" } else { "decline" } }
                    });
                    let Ok(mut writer) = stdin.lock() else {
                        transport.mark(TRANSPORT_READ_ERROR);
                        let _ = event_tx.send(NativeMessage::Closed);
                        break;
                    };
                    if serde_json::to_writer(&mut *writer, &response).is_err()
                        || writer.write_all(b"\n").is_err()
                        || writer.flush().is_err()
                    {
                        transport.mark(TRANSPORT_READ_ERROR);
                        let _ = event_tx.send(NativeMessage::Closed);
                        break;
                    }
                }
            });
        if let Err(error) = spawned {
            self.transport.mark(TRANSPORT_READ_ERROR);
            return Err(AdapterError::Connection(format!(
                "unable to start Codex reader: {error}"
            )));
        }
        self.event_rx = Some(event_rx);
        self.permission_tx = Some(permission_tx);
        Ok(())
    }

    fn permission_response(&mut self, response: PermissionResponse) -> Result<(), AdapterError> {
        let request_id = response.request_id.trim();
        if request_id.is_empty() {
            return Err(AdapterError::InvalidRequest(
                "permission request id is empty".into(),
            ));
        }
        let sender = self
            .permission_tx
            .as_ref()
            .ok_or_else(|| AdapterError::Connection("Codex reader is not active".into()))?;
        sender
            .send(PermissionCommand {
                request_id: request_id.into(),
                allow: response.allow,
                cancel: false,
            })
            .map_err(|_| AdapterError::Connection("Codex permission reader is closed".into()))
    }

    fn interrupt(&mut self) -> Result<crate::adapters::CancelResult, AdapterError> {
        let Some(thread_id) = self.thread_id.clone() else {
            return Err(AdapterError::Connection(
                "Codex thread is not active".into(),
            ));
        };
        // R3: an interrupt needs a proven cancellable target — the turn id the
        // provider itself acknowledged. A pending (written but unacknowledged)
        // start, or an unknown delivery, has no real interrupt target yet.
        let Some(turn_id) = self.native_turn_id.clone() else {
            return Ok(crate::adapters::CancelResult {
                requested: false,
                confirmed: false,
                reason: Some(
                    "no acknowledged native turn to interrupt; the turn start has not been confirmed by Codex"
                        .into(),
                ),
            });
        };
        let id = self.next_request_id();
        self.send_json(&json!({
            "id": id,
            "method": "turn/interrupt",
            "params": { "threadId": thread_id, "turnId": turn_id }
        }))?;
        // A background reader will receive the JSON-RPC acknowledgement. The
        // Core records the request immediately; no provider effect is claimed
        // until a subsequent terminal event is observed.
        let confirmed = false;
        Ok(crate::adapters::CancelResult {
            requested: true,
            confirmed,
            reason: (!confirmed)
                .then(|| "interrupt request sent; awaiting native terminal acknowledgement".into()),
        })
    }

    fn drop_stdio(&mut self) -> Result<(), AdapterError> {
        self.stdin.take();
        self.stdout.take();
        self.event_rx.take();
        // Increment 6 (critic round 2): dropping the receiver means THIS Core can never read
        // another event from the registration, however healthy the provider is. That is a KNOWN
        // unusable transport, so it is marked - otherwise `registration_live` would keep reporting
        // the live child usable and a re-selection would be handed back a registration whose only
        // output path Core has itself discarded (owner boundary 3). The child is untouched: the
        // registration is degraded, never killed or replaced (boundary 5).
        //
        // `stream_closed` is deliberately NOT set: the caller of this path
        // (`close_adapter_transport`) already persists its own `transport_lost` event and a BLOCKED
        // recovery row, so emitting a second `runtime.transport.closed` for the same deliberate act
        // would duplicate the journal.
        self.transport.mark(TRANSPORT_DROPPED);
        Ok(())
    }

    fn close(&mut self) -> Result<(), AdapterError> {
        if let Some(child) = self.child.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        self.child = None;
        self.stdin = None;
        self.stdout = None;
        Ok(())
    }

    fn next_request_id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    fn send_json(&mut self, value: &Value) -> Result<(), AdapterError> {
        let stdin = self
            .stdin
            .as_mut()
            .ok_or_else(|| AdapterError::Connection("Codex stdin is closed".into()))?;
        let mut stdin = stdin
            .lock()
            .map_err(|_| AdapterError::Connection("Codex stdin lock is poisoned".into()))?;
        serde_json::to_writer(&mut *stdin, value)?;
        stdin.write_all(b"\n")?;
        stdin.flush()?;
        Ok(())
    }

    fn read_until_response(
        &mut self,
        request_id: u64,
        mut event_target: Option<&mut Vec<AgentEventEnvelope>>,
        attempt_id: Option<&str>,
    ) -> Result<Value, AdapterError> {
        let collect_until_terminal = event_target.is_some();
        let mut matched_response: Option<Value> = None;
        loop {
            let line = match self
                .stdout
                .as_mut()
                .ok_or_else(|| AdapterError::Connection("Codex stdout is closed".into()))?
                .read_line_bounded()
            {
                Ok(line) => line,
                Err(error) => {
                    // Increment 6: a read-side transport failure is an observed closure — an
                    // oversized frame (the bound `Protocol`) or an io read error. Mark it (with its
                    // reason) before propagating. A later `serde_json` parse error is NOT marked: a
                    // malformed line is not a closed stream.
                    self.transport.mark(match &error {
                        AdapterError::Protocol(_) => TRANSPORT_OVERSIZED,
                        _ => TRANSPORT_READ_ERROR,
                    });
                    return Err(error);
                }
            };
            if line.is_empty() {
                if let Some(response) = matched_response {
                    return Ok(response);
                }
                // The stream ended before the response: an observed EOF closure.
                self.transport.mark(TRANSPORT_EOF);
                return Err(AdapterError::Connection(
                    "Codex app-server closed before a response".into(),
                ));
            }
            let value: Value = serde_json::from_str(line.trim_end())?;
            debug_runtime(&format!(
                "received method={} id={}",
                value.get("method").and_then(Value::as_str).unwrap_or(""),
                value.get("id").map(Value::to_string).unwrap_or_default()
            ));
            if value.get("method").is_some() && value.get("id").is_some() {
                let method = value
                    .get("method")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                let id = value.get("id").cloned().unwrap_or(Value::Null);
                if let (Some(events), Some(attempt_id)) = (event_target.as_mut(), attempt_id) {
                    self.sequence += 1;
                    if let Some(event) = self.native_event(attempt_id, method, &value) {
                        (*events).push(event);
                    }
                }
                // Do not grant a provider effect without a UI decision. This
                // preserves native safety while making the capability gap
                // visible in the timeline.
                self.send_json(&json!({ "id": id, "result": { "decision": "decline" } }))?;
                continue;
            }
            if let Some(id) = value.get("id").and_then(Value::as_u64)
                && id == request_id
            {
                if !collect_until_terminal {
                    return Ok(value);
                }
                matched_response = Some(value);
                continue;
            }
            if let (Some(events), Some(attempt_id)) = (event_target.as_mut(), attempt_id) {
                self.sequence += 1;
                if let Some(event) = self.native_event(
                    attempt_id,
                    value
                        .get("method")
                        .and_then(Value::as_str)
                        .unwrap_or("notification"),
                    &value,
                ) {
                    let terminal = matches!(
                        event.event_type,
                        AgentEventType::TurnCompleted
                            | AgentEventType::TurnFailed
                            | AgentEventType::Cancelled
                    );
                    (*events).push(event);
                    if terminal && value.get("id").is_none() {
                        return Ok(matched_response.unwrap_or(value));
                    }
                }
            }
        }
    }

    fn native_event(
        &self,
        attempt_id: &str,
        method: &str,
        value: &Value,
    ) -> Option<AgentEventEnvelope> {
        let event_type = classify_codex_method(method, value);
        let mut payload = normalized_codex_payload(method, value)?;
        let provider_ref = value
            .get("id")
            .or_else(|| value.get("params").and_then(|p| p.get("itemId")))
            .map(|v| format!("codex-ref:{}", sha256_hex(bounded_scalar(v).as_bytes())));
        if let Some(object) = payload.as_object_mut() {
            if let Some(reference) = provider_ref.as_deref() {
                object.insert(
                    "provider_event_hash".into(),
                    Value::String(reference.into()),
                );
            }
            if let Some(thread_id) = value
                .get("params")
                .and_then(|params| params.get("threadId"))
                .map(bounded_scalar)
            {
                object.insert(
                    "native_thread_hash".into(),
                    Value::String(sha256_hex(thread_id.as_bytes())),
                );
            }
            if let Some(turn_id) = value
                .get("params")
                .and_then(|params| params.get("turnId"))
                .map(bounded_scalar)
            {
                object.insert(
                    "native_turn_hash".into(),
                    Value::String(sha256_hex(turn_id.as_bytes())),
                );
            }
        }
        Some(AgentEventEnvelope {
            event_id: format!("codex-event-{}", self.sequence),
            campaign_id: self.campaign_id.clone(),
            task_id: self.task_id.clone().unwrap_or_default(),
            attempt_id: attempt_id.into(),
            process_epoch_id: self.process_binding.as_ref()?.process_epoch.clone(),
            sequence: self.sequence,
            occurred_at: now(),
            received_at: now(),
            provider_event_reference: provider_ref,
            event_type,
            payload,
        })
    }
}

impl Drop for CodexProcess {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

/// A native Grok subscription attached over the Agent Client Protocol
/// (`grok agent stdio`, JSON-RPC over stdio).  The adapter spawns the installed,
/// OIDC-authenticated CLI with exactly `agent stdio` — never `--always-approve`
/// and never an API key — and keeps every provider identifier hashed.  Native
/// permission prompts are turned ON for the Core-owned session through the
/// ACP-advertised `always-approve` command; the Runtime owner's `~/.grok`
/// configuration is never read or written.
#[derive(Debug)]
struct GrokAcpProcess {
    executable: PathBuf,
    version: String,
    workspace_root: PathBuf,
    child: Option<Child>,
    stdin: Option<Arc<Mutex<ChildStdin>>>,
    stdout: Option<BufReader<ChildStdout>>,
    event_rx: Option<Receiver<NativeMessage>>,
    permission_tx: Option<Sender<PermissionCommand>>,
    /// Shared with the reader thread so a `session/request_permission` observed
    /// there is given the same DB-unique Decision id the projection will store.
    session_hash: Arc<Mutex<String>>,
    /// Frames read while waiting for a JSON-RPC response.  ACP publishes the
    /// command advertisement *before* the `session/new` response, so nothing may
    /// be discarded while a control call is in flight.
    pending_frames: Vec<Value>,
    next_id: u64,
    session_id: Option<String>,
    thread_hash: Option<String>,
    turn_request_id: Option<u64>,
    turn_hash: Option<String>,
    always_approve_advertised: bool,
    /// Request ids whose PermissionResponse has already been emitted. Both the released
    /// reader and `poll_events` can reach a dying permission; this makes whichever arrives
    /// second a no-op instead of a duplicate `runtime.permission.response` row (R2).
    answered_permissions: HashSet<String>,
    /// Latched Safe stop for the CURRENT turn. `interrupt` sets it whether or not a permission
    /// is pending yet; the reader consumes it once, immediately after publishing a request and
    /// before blocking, so a cancel that arrived while the request was still being decoded is
    /// honoured on the first press instead of being lost (critic finding V1). `send_prompt`
    /// clears it at turn start so it can never cancel a permission of a LATER turn.
    cancel_requested: Arc<AtomicBool>,
    native_permission_prompts: String,
    stream_closed: bool,
    /// Set by the reader thread the moment stdout ends. `native_pid` consults it so a
    /// dead child is never reported live to the projection (critic finding F3).
    child_ended: Arc<AtomicBool>,
    /// The DB-unique id of the `session/request_permission` the reader is currently blocked
    /// on, or None. Set before the request is published and cleared the moment a command is
    /// received, so a cancel can be TARGETED at exactly that request and can never leak into
    /// a later turn (critic finding K1).
    pending_permission: Arc<Mutex<Option<String>>>,
    sequence: i64,
    attempt_id: Option<String>,
    campaign_id: Option<String>,
    task_id: Option<String>,
    process_binding: Option<RuntimeProcessBinding>,
    /// Set the moment a spawn succeeds and never cleared: a process existed at some point,
    /// whatever happened to it afterwards (see `RuntimeManager::process_started`).
    spawned: bool,
}

impl GrokAcpProcess {
    fn new(executable: PathBuf, version: String, workspace_root: PathBuf) -> Self {
        Self {
            executable,
            version,
            workspace_root,
            child: None,
            stdin: None,
            stdout: None,
            event_rx: None,
            permission_tx: None,
            session_hash: Arc::new(Mutex::new(String::new())),
            pending_frames: Vec::new(),
            next_id: 1,
            session_id: None,
            thread_hash: None,
            turn_request_id: None,
            turn_hash: None,
            always_approve_advertised: false,
            answered_permissions: HashSet::new(),
            cancel_requested: Arc::new(AtomicBool::new(false)),
            native_permission_prompts: "native-default".into(),
            stream_closed: false,
            child_ended: Arc::new(AtomicBool::new(false)),
            pending_permission: Arc::new(Mutex::new(None)),
            sequence: 0,
            attempt_id: None,
            campaign_id: None,
            task_id: None,
            process_binding: None,
            spawned: false,
        }
    }

    fn identity_summary(&self) -> RuntimeIdentitySummary {
        RuntimeIdentitySummary {
            provider: "grok".into(),
            version: self.version.clone(),
            executable: Some(self.executable.to_string_lossy().into_owned()),
            protocol: GROK_PROTOCOL_VERSION.into(),
            native: true,
        }
    }

    fn ensure_started(&mut self) -> Result<(), AdapterError> {
        if self.child.is_some() {
            return Ok(());
        }
        let mut command = Command::new(&self.executable);
        command
            .args(["agent", "stdio"])
            .current_dir(&self.workspace_root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            // A native subscription is selected through the installed CLI's own
            // login. API-key environment variables are never forwarded.
            .env_remove("OPENAI_API_KEY")
            .env_remove("ANTHROPIC_API_KEY")
            .env_remove("XAI_API_KEY");
        hide_native_console(&mut command);
        // The full argument vector is logged so an auditor can see that no
        // `--always-approve` (or any other permission flag) is ever passed. The
        // executable path and workspace are hashed instead of printed.
        debug_runtime(&format!(
            "spawn grok argv=[\"{}\",\"agent\",\"stdio\"] exe_path_sha256={} cwd={}",
            self.executable
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| "grok".into()),
            sha256_hex(self.executable.to_string_lossy().as_bytes()),
            sha256_hex(self.workspace_root.to_string_lossy().as_bytes())
        ));
        let mut child = command.spawn().map_err(|error| {
            AdapterError::Connection(format!("unable to start grok agent stdio: {error}"))
        })?;
        self.spawned = true;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| AdapterError::Connection("Grok ACP stdin unavailable".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AdapterError::Connection("Grok ACP stdout unavailable".into()))?;
        let pid = child.id();
        let observed = match process_identity::observe_process(pid) {
            ProcessObservation::Live(identity) => identity,
            ProcessObservation::NotRunning => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(AdapterError::Connection(
                    "grok agent stdio exited before its process identity was observed".into(),
                ));
            }
            ProcessObservation::Unknown(reason) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(AdapterError::Connection(format!(
                    "grok agent stdio process identity is unknown: {reason}"
                )));
            }
        };
        let canonical = format!(
            "grok|{}|{}|{}|{}",
            observed.pid,
            observed.created_ms,
            observed.executable_path.to_ascii_lowercase(),
            observed.executable_sha256.to_ascii_lowercase()
        );
        self.process_binding = Some(RuntimeProcessBinding {
            process_epoch: format!("runtime-epoch:{}", sha256_hex(canonical.as_bytes())),
            pid: observed.pid,
            creation_date: observed.creation_date(),
            executable_path: observed.executable_path,
            executable_sha256: observed.executable_sha256,
        });
        self.child = Some(child);
        self.stdin = Some(Arc::new(Mutex::new(stdin)));
        self.stdout = Some(BufReader::new(stdout));
        // The reader owns stdout from the first byte: ACP notifications that
        // arrive before a response must be buffered, not raced for.
        self.start_reader()?;
        let response = self.request(
            "initialize",
            json!({
                "protocolVersion": 1,
                "clientCapabilities": {
                    "fs": { "readTextFile": false, "writeTextFile": false },
                    "terminal": false
                },
                "clientInfo": { "name": "goalport-core", "version": env!("CARGO_PKG_VERSION") }
            }),
            GROK_REQUEST_TIMEOUT_MS,
        )?;
        let negotiated = response
            .pointer("/result/protocolVersion")
            .and_then(Value::as_u64)
            .unwrap_or_default();
        if negotiated != 1 {
            return Err(AdapterError::Protocol(format!(
                "Grok ACP negotiated protocolVersion {negotiated}; this adapter speaks 1"
            )));
        }
        debug_runtime("grok ACP initialize accepted protocolVersion=1");
        Ok(())
    }

    fn create_session(
        &mut self,
        request: &SessionRequest,
    ) -> Result<RuntimeSessionResult, AdapterError> {
        request.validate()?;
        self.attempt_id = Some(request.attempt_id.clone());
        self.campaign_id = request.campaign_id.clone();
        self.task_id = Some(request.task_id.clone());
        self.ensure_started()?;
        if let Some(session_id) = request.resume_session.as_deref() {
            return self.resume_session(session_id);
        }
        let cwd = request.workspace_root.to_string_lossy().into_owned();
        let response = self.request(
            "session/new",
            json!({ "cwd": cwd, "mcpServers": [] }),
            GROK_REQUEST_TIMEOUT_MS,
        )?;
        let session_id = response
            .pointer("/result/sessionId")
            .and_then(Value::as_str)
            .ok_or_else(|| AdapterError::Protocol("session/new returned no sessionId".into()))?
            .to_owned();
        self.bind_session(&session_id);
        self.enable_native_permissions(&session_id)?;
        // Pre-turn notifications (MCP, models, announcements, the command list)
        // carry no Core meaning and are never projected.
        self.pending_frames.clear();
        self.sequence += 1;
        let event = self.session_created_event(false)?;
        Ok(RuntimeSessionResult {
            handle: SessionHandle {
                session_id,
                resumed: false,
            },
            events: vec![event],
        })
    }

    fn resume_session(&mut self, session_id: &str) -> Result<RuntimeSessionResult, AdapterError> {
        if session_id.trim().is_empty() {
            return Err(AdapterError::InvalidRequest("session id is empty".into()));
        }
        self.ensure_started()?;
        let cwd = self.workspace_root.to_string_lossy().into_owned();
        self.request(
            "session/load",
            json!({ "sessionId": session_id, "cwd": cwd, "mcpServers": [] }),
            GROK_REQUEST_TIMEOUT_MS,
        )?;
        self.bind_session(session_id);
        self.enable_native_permissions(session_id)?;
        self.pending_frames.clear();
        self.sequence += 1;
        let event = self.session_created_event(true)?;
        Ok(RuntimeSessionResult {
            handle: SessionHandle {
                session_id: session_id.to_owned(),
                resumed: true,
            },
            events: vec![event],
        })
    }

    fn bind_session(&mut self, session_id: &str) {
        let hash = sha256_hex(session_id.as_bytes());
        if let Ok(mut shared) = self.session_hash.lock() {
            shared.clone_from(&hash);
        }
        self.thread_hash = Some(hash);
        self.session_id = Some(session_id.to_owned());
    }

    /// Turn native permission prompts ON for this session only.
    ///
    /// Nothing is disabled here: the Runtime owner's `[ui] permission_mode` stays
    /// untouched on disk, and the session-scoped `/always-approve off` command is
    /// only sent when the agent itself advertised it.  A miss is recorded as
    /// `native-default`, never silently.
    fn enable_native_permissions(&mut self, session_id: &str) -> Result<(), AdapterError> {
        if std::env::var("GOALPORT_GROK_PERMISSIONS").ok().as_deref() == Some("native") {
            self.native_permission_prompts = "native-default".into();
            debug_runtime(
                "grok permission prompts left at the Runtime default (GOALPORT_GROK_PERMISSIONS=native)",
            );
            return Ok(());
        }
        self.scan_for_always_approve();
        if !self.always_approve_advertised {
            let deadline =
                Instant::now() + Duration::from_millis(GROK_COMMAND_ADVERTISEMENT_GRACE_MS);
            while !self.always_approve_advertised {
                let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                    break;
                };
                let message = {
                    let Some(receiver) = self.event_rx.as_ref() else {
                        break;
                    };
                    receiver.recv_timeout(remaining)
                };
                match message {
                    Ok(NativeMessage::Json(value)) => {
                        self.pending_frames.push(value);
                        self.scan_for_always_approve();
                    }
                    Ok(NativeMessage::Closed) => {
                        self.stream_closed = true;
                        break;
                    }
                    Err(_) => break,
                }
            }
        }
        if !self.always_approve_advertised {
            self.native_permission_prompts = "native-default".into();
            debug_runtime(
                "grok always-approve session command was not advertised within the grace window; permission prompts stay at the Runtime default",
            );
            return Ok(());
        }
        let before = self.pending_frames.len();
        self.request(
            "session/prompt",
            json!({
                "sessionId": session_id,
                "prompt": [{ "type": "text", "text": GROK_ALWAYS_APPROVE_OFF }]
            }),
            GROK_REQUEST_TIMEOUT_MS,
        )?;
        // A session command must not be absorbed by a model turn: if the agent
        // answered with prose, the switch was not applied and the adapter refuses
        // to claim it was.
        if self.pending_frames[before..].iter().any(|frame| {
            frame
                .pointer("/params/update/sessionUpdate")
                .and_then(Value::as_str)
                == Some("agent_message_chunk")
        }) {
            return Err(AdapterError::Protocol(
                "the Grok session command /always-approve off was answered by a model turn; native permission prompts were not enabled".into(),
            ));
        }
        self.native_permission_prompts = "enabled-by-session-command".into();
        debug_runtime("grok native permission prompts enabled by session command");
        Ok(())
    }

    fn scan_for_always_approve(&mut self) {
        if self.always_approve_advertised {
            return;
        }
        self.always_approve_advertised = self.pending_frames.iter().any(|frame| {
            frame
                .pointer("/params/update/sessionUpdate")
                .and_then(Value::as_str)
                == Some("available_commands_update")
                && frame
                    .pointer("/params/update/availableCommands")
                    .and_then(Value::as_array)
                    .is_some_and(|commands| {
                        commands.iter().any(|command| {
                            command.get("name").and_then(Value::as_str) == Some("always-approve")
                        })
                    })
        });
    }

    fn send_prompt(&mut self, request: &PromptRequest) -> Result<RuntimeSendResult, AdapterError> {
        request.validate()?;
        if self.stream_closed {
            return Err(AdapterError::Connection(
                "native Runtime closed the ACP stream".into(),
            ));
        }
        let Some(session_id) = self.session_id.clone() else {
            return Err(AdapterError::Connection(
                "Grok ACP session is not active".into(),
            ));
        };
        // One turn at a time. Overwriting the in-flight request id would orphan the
        // first response and misattribute its events to the second turn, so a second
        // prompt is refused outright: no queueing, no overwrite (critic finding F2).
        if self.turn_request_id.is_some() {
            return Err(AdapterError::InvalidRequest(
                "a Grok turn is already in flight; wait for it to finish or use Safe stop".into(),
            ));
        }
        // No permission of a finished turn may still be considered pending when a new turn
        // starts; the reader additionally drains stale commands before publishing a request.
        let _ = self.take_pending_permission();
        // A Safe stop belongs to the turn it was pressed in. Clearing the latch here is what
        // stops it from cancelling a permission of this new turn (V1).
        self.cancel_requested.store(false, Ordering::SeqCst);
        let id = self.next_request_id();
        // The turn identity is the JSON-RPC request id of this `session/prompt`,
        // qualified by the session so two sessions cannot collide, and only its
        // hash is ever persisted.
        let turn_hash = sha256_hex(format!("{session_id}#{id}").as_bytes());
        self.turn_request_id = Some(id);
        self.turn_hash = Some(turn_hash.clone());
        self.send_json(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "session/prompt",
            "params": {
                "sessionId": session_id,
                "prompt": [{ "type": "text", "text": request.text }]
            }
        }))?;
        // The reader thread owns stdout; returning as soon as the prompt is
        // flushed keeps the UI responsive while the native turn runs.
        let attempt_id = self.attempt_id.clone().unwrap_or_default();
        self.sequence += 1;
        let event = self
            .envelope(
                &attempt_id,
                AgentEventType::TurnStarted,
                json!({ "status": "running" }),
                None,
            )
            .ok_or_else(|| AdapterError::Connection("Grok process epoch is unavailable".into()))?;
        Ok(RuntimeSendResult {
            accepted: true,
            duplicate: false,
            session_id: Some(session_id),
            events: vec![event],
        })
    }

    /// The child pid ONLY while the process is demonstrably alive. Once stdout ended or the
    /// child exited, the projection must not treat this Runtime as live, otherwise a dead
    /// Grok looks attached and the Attempt can neither recover nor refuse visibly
    /// (critic finding F3).
    fn live_pid(&self) -> Option<u32> {
        if self.stream_closed || self.child_ended.load(Ordering::SeqCst) {
            return None;
        }
        self.child.as_ref().map(std::process::Child::id)
    }

    /// Increment 6 (read-only expression): whether the ACP stream has ended, from the existing
    /// flags. Behaviour is unchanged; this only lets `transport_state` report Grok uniformly.
    fn stream_ended(&self) -> bool {
        self.stream_closed || self.child_ended.load(Ordering::SeqCst)
    }

    /// True while a `session/prompt` response is still outstanding.
    fn turn_in_flight(&self) -> bool {
        self.turn_request_id.is_some()
    }

    /// Take the pending permission id so exactly one path may close it.
    fn take_pending_permission(&self) -> Option<String> {
        self.pending_permission
            .lock()
            .ok()
            .and_then(|mut pending| pending.take())
    }

    /// Release a reader blocked on a pending permission, addressed to that exact request.
    /// Never sent speculatively: without a pending id there is nothing to release, and an
    /// untargeted command would be consumed by the NEXT turn's first permission.
    ///
    /// Reading the slot and enqueueing happen under ONE lock, the same lock the reader holds
    /// across its drain and publish. That makes the two impossible to interleave: either this
    /// runs before the reader published (slot empty, nothing is enqueued and nothing can be
    /// lost) or after it (the command is enqueued past the drain and is honoured). Splitting
    /// the read from the send is exactly the window that swallowed the first Safe stop (R1).
    fn release_pending_permission(&self) -> Option<String> {
        let pending = self.pending_permission.lock().ok()?;
        // The latch is raised under the SAME lock the reader holds across its drain and publish,
        // so a Safe stop is recorded whether it arrives before the request is published (the
        // reader consumes the latch) or after (the tagged command below is honoured). Without it
        // the pre-publication window silently swallowed the first press (V1).
        self.cancel_requested.store(true, Ordering::SeqCst);
        let request_id = pending.clone()?;
        if let Some(sender) = self.permission_tx.as_ref() {
            let _ = sender.send(PermissionCommand {
                request_id: request_id.clone(),
                allow: false,
                cancel: true,
            });
        }
        Some(request_id)
    }

    fn poll_events(&mut self, attempt_id: &str) -> Result<Vec<AgentEventEnvelope>, AdapterError> {
        // An exited child is observed here too, so liveness does not depend on the reader
        // winning a race with the caller.
        if let Some(child) = self.child.as_mut()
            && matches!(child.try_wait(), Ok(Some(_)))
        {
            self.child_ended.store(true, Ordering::SeqCst);
        }
        let mut frames = std::mem::take(&mut self.pending_frames);
        // A child that has gone is a closed stream even if no Closed frame has been drained
        // yet: a reader blocked on a pending permission can never observe its own EOF (K2).
        let mut closed = self.child_ended.load(Ordering::SeqCst);
        if let Some(receiver) = self.event_rx.as_ref() {
            for message in receiver.try_iter() {
                match message {
                    NativeMessage::Json(value) => frames.push(value),
                    NativeMessage::Closed => {
                        closed = true;
                        break;
                    }
                }
            }
        }
        let mut events = Vec::new();
        for frame in frames {
            if let Some(event) = self.map_frame(attempt_id, &frame) {
                events.push(event);
            }
        }
        if closed && !self.stream_closed {
            self.stream_closed = true;
            // A permission still pending when the Runtime died can never be answered by the
            // user. Release the blocked reader (addressed to that exact request) and close the
            // Decision as cancelled, so nothing is left waiting for a person who cannot help.
            if let Some(request_id) = self.release_pending_permission()
                && self.take_pending_permission().is_some()
                && self.answered_permissions.insert(request_id.clone())
            {
                self.sequence += 1;
                if let Some(event) = self.envelope(
                    attempt_id,
                    AgentEventType::PermissionResponse,
                    json!({
                        "request_id": request_id,
                        "kind": "native-permission",
                        "option_kind": "cancelled",
                        "option_id": "",
                        "allow": false,
                        "cancelled": true,
                        "reason": "native Runtime closed the ACP stream while the permission was pending"
                    }),
                    None,
                ) {
                    events.push(event);
                }
            }
            // A stream that ends with a turn in flight is a failure, never a
            // silent completion, and never a reason to respawn.
            if self.turn_request_id.take().is_some() {
                self.sequence += 1;
                if let Some(event) = self.envelope(
                    attempt_id,
                    AgentEventType::TurnFailed,
                    json!({
                        "status": "failed",
                        "text": "native Runtime closed the ACP stream"
                    }),
                    None,
                ) {
                    events.push(event);
                }
            }
        }
        Ok(events)
    }

    /// Map one ACP frame onto at most one bounded Core event. Vendor `_x.ai/*`
    /// notifications, thoughts, plans, usage and echoed user messages are dropped.
    fn map_frame(&mut self, attempt_id: &str, value: &Value) -> Option<AgentEventEnvelope> {
        if let Some(id) = value.get("id").and_then(Value::as_u64)
            && Some(id) == self.turn_request_id
            && (value.get("result").is_some() || value.get("error").is_some())
        {
            self.turn_request_id = None;
            let reference = Some(format!(
                "grok-ref:{}",
                sha256_hex(format!("turn-{id}").as_bytes())
            ));
            if let Some(error) = value.get("error") {
                let code = error
                    .get("code")
                    .map(bounded_scalar)
                    .unwrap_or_else(|| "unknown".into());
                self.sequence += 1;
                return self.envelope(
                    attempt_id,
                    AgentEventType::TurnFailed,
                    json!({ "status": "failed", "text": format!("native Runtime error {code}") }),
                    reference,
                );
            }
            let stop_reason = value
                .pointer("/result/stopReason")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_owned();
            self.sequence += 1;
            return match stop_reason.as_str() {
                "end_turn" => self.envelope(
                    attempt_id,
                    AgentEventType::TurnCompleted,
                    json!({ "status": "completed", "stop_reason": "end_turn" }),
                    reference,
                ),
                "cancelled" => self.envelope(
                    attempt_id,
                    AgentEventType::Cancelled,
                    json!({
                        "status": "cancelled",
                        "stop_reason": "cancelled",
                        "text": "Grok turn cancelled (stopReason=cancelled)"
                    }),
                    reference,
                ),
                other => self.envelope(
                    attempt_id,
                    AgentEventType::TurnFailed,
                    json!({
                        "status": "failed",
                        "stop_reason": bounded_text(other),
                        "text": format!("Grok stopped: {other}")
                    }),
                    reference,
                ),
            };
        }
        let method = value
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        if method.is_empty() || method.starts_with("_x.ai/") {
            return None;
        }
        if method == "session/request_permission" {
            let request_id = value
                .get(GROK_DECISION_ID_KEY)
                .and_then(Value::as_str)?
                .to_owned();
            let tool_call = value.pointer("/params/toolCall");
            let title = tool_call
                .and_then(|call| call.get("title"))
                .and_then(Value::as_str)
                .unwrap_or("native permission request");
            let tool_kind = tool_call
                .and_then(|call| call.get("kind"))
                .and_then(Value::as_str)
                .or_else(|| {
                    tool_call
                        .and_then(|call| call.pointer("/_meta/x.ai~1tool/kind"))
                        .and_then(Value::as_str)
                })
                .unwrap_or("unknown");
            let reference = Some(format!("grok-ref:{}", sha256_hex(request_id.as_bytes())));
            self.sequence += 1;
            return self.envelope(
                attempt_id,
                AgentEventType::PermissionRequest,
                json!({
                    "request_id": request_id,
                    "kind": "native-permission",
                    "text": bounded_text(title),
                    "tool_kind": bounded_text(tool_kind)
                }),
                reference,
            );
        }
        if method == GROK_PERMISSION_RESPONSE_METHOD {
            let params = value.get("params")?;
            let request_id = params
                .get("request_id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            // Exactly one PermissionResponse per request: on a dying Runtime both the released
            // reader and poll_events can reach the same pending permission (R2).
            if !self.answered_permissions.insert(request_id.clone()) {
                return None;
            }
            let reference = Some(format!("grok-ref:{}", sha256_hex(request_id.as_bytes())));
            self.sequence += 1;
            return self.envelope(
                attempt_id,
                AgentEventType::PermissionResponse,
                json!({
                    "request_id": request_id,
                    "kind": "native-permission",
                    "option_kind": params.get("option_kind").and_then(Value::as_str).unwrap_or("unknown"),
                    "option_id": params.get("option_id").and_then(Value::as_str).unwrap_or_default(),
                    "allow": params.get("allow").and_then(Value::as_bool).unwrap_or(false),
                    "cancelled": params.get("cancelled").and_then(Value::as_bool).unwrap_or(false)
                }),
                reference,
            );
        }
        if method != "session/update" {
            return None;
        }
        let update = value.pointer("/params/update")?;
        match update.get("sessionUpdate").and_then(Value::as_str)? {
            "agent_message_chunk" => {
                let text = update
                    .pointer("/content/text")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if text.is_empty() {
                    return None;
                }
                self.sequence += 1;
                self.envelope(
                    attempt_id,
                    AgentEventType::MessageDelta,
                    json!({ "text": bounded_text(text) }),
                    None,
                )
            }
            kind @ ("tool_call" | "tool_call_update") => {
                let tool = update
                    .get("title")
                    .and_then(Value::as_str)
                    .or_else(|| {
                        update
                            .pointer("/_meta/x.ai~1tool/label")
                            .and_then(Value::as_str)
                    })
                    .unwrap_or("native-tool");
                // ACP leaves `status` optional on the first frame; the observed
                // value is used when the Runtime supplies one.
                let status = update.get("status").and_then(Value::as_str).unwrap_or(
                    if kind == "tool_call" {
                        "started"
                    } else {
                        "updated"
                    },
                );
                let tool_kind = update
                    .get("kind")
                    .and_then(Value::as_str)
                    .or_else(|| {
                        update
                            .pointer("/_meta/x.ai~1tool/kind")
                            .and_then(Value::as_str)
                    })
                    .unwrap_or("unknown");
                let reference = update
                    .get("toolCallId")
                    .map(|id| format!("grok-ref:{}", sha256_hex(bounded_scalar(id).as_bytes())));
                self.sequence += 1;
                self.envelope(
                    attempt_id,
                    AgentEventType::ToolActivity,
                    json!({
                        "tool": bounded_text(tool),
                        "status": bounded_text(status),
                        "kind": bounded_text(tool_kind)
                    }),
                    reference,
                )
            }
            _ => None,
        }
    }

    fn session_created_event(&self, resumed: bool) -> Result<AgentEventEnvelope, AdapterError> {
        let attempt_id = self.attempt_id.clone().unwrap_or_default();
        self.envelope(
            &attempt_id,
            AgentEventType::SessionCreated,
            json!({
                "session_id": "[NATIVE_SESSION]",
                "provider": "grok",
                "transport": "acp-stdio",
                "resumed": resumed,
                "always_approve_flag": false,
                "native_permission_prompts": self.native_permission_prompts,
                "native_surfaces": "MCP servers, skills and hooks remain runtime-owned"
            }),
            None,
        )
        .ok_or_else(|| AdapterError::Connection("Grok process epoch is unavailable".into()))
    }

    fn envelope(
        &self,
        attempt_id: &str,
        event_type: AgentEventType,
        mut payload: Value,
        provider_reference: Option<String>,
    ) -> Option<AgentEventEnvelope> {
        if let Some(object) = payload.as_object_mut() {
            if let Some(hash) = self.thread_hash.as_deref() {
                object.insert("native_thread_hash".into(), Value::String(hash.into()));
            }
            if let Some(hash) = self.turn_hash.as_deref() {
                object.insert("native_turn_hash".into(), Value::String(hash.into()));
            }
            if let Some(reference) = provider_reference.as_deref() {
                object.insert(
                    "provider_event_hash".into(),
                    Value::String(reference.into()),
                );
            }
        }
        Some(AgentEventEnvelope {
            event_id: format!("grok-event-{}", self.sequence),
            campaign_id: self.campaign_id.clone(),
            task_id: self.task_id.clone().unwrap_or_default(),
            attempt_id: attempt_id.into(),
            process_epoch_id: self.process_binding.as_ref()?.process_epoch.clone(),
            sequence: self.sequence,
            occurred_at: now(),
            received_at: now(),
            provider_event_reference: provider_reference,
            event_type,
            payload,
        })
    }

    fn start_reader(&mut self) -> Result<(), AdapterError> {
        if self.event_rx.is_some() {
            return Ok(());
        }
        let mut stdout = self
            .stdout
            .take()
            .ok_or_else(|| AdapterError::Connection("Grok ACP stdout is closed".into()))?;
        let stdin = self
            .stdin
            .as_ref()
            .cloned()
            .ok_or_else(|| AdapterError::Connection("Grok ACP stdin is closed".into()))?;
        let session_hash = Arc::clone(&self.session_hash);
        let child_ended = Arc::clone(&self.child_ended);
        let pending_permission = Arc::clone(&self.pending_permission);
        let cancel_requested = Arc::clone(&self.cancel_requested);
        // Agent->client JSON-RPC ids restart at 0 for every spawned process, and a session/load
        // of the SAME session after a Core restart reuses the session hash too. Without a
        // per-process component the first permission of a resumed session would collide with an
        // earlier Decision of that attempt and strand the request (critic finding W1). The
        // process epoch is pid + creation time + executable hash, so it is unique per spawn.
        let process_epoch = self
            .process_binding
            .as_ref()
            .map(|binding| {
                binding
                    .process_epoch
                    .rsplit(':')
                    .next()
                    .unwrap_or(&binding.process_epoch)
                    .chars()
                    .take(16)
                    .collect::<String>()
            })
            .unwrap_or_else(|| "noepoch".into());
        let (event_tx, event_rx) = mpsc::channel();
        let (permission_tx, permission_rx): (
            Sender<PermissionCommand>,
            Receiver<PermissionCommand>,
        ) = mpsc::channel();
        std::thread::Builder::new()
            .name("goalport-grok-reader".into())
            .spawn(move || {
                let write_line = |value: &Value| -> bool {
                    let Ok(mut writer) = stdin.lock() else {
                        return false;
                    };
                    serde_json::to_writer(&mut *writer, value).is_ok()
                        && writer.write_all(b"\n").is_ok()
                        && writer.flush().is_ok()
                };
                loop {
                    let mut line = String::new();
                    match stdout.read_line(&mut line) {
                        Ok(0) => {
                            child_ended.store(true, Ordering::SeqCst);
                            let _ = event_tx.send(NativeMessage::Closed);
                            break;
                        }
                        Ok(size) if size > MAX_NATIVE_LINE_BYTES => {
                            child_ended.store(true, Ordering::SeqCst);
                            let _ = event_tx.send(NativeMessage::Closed);
                            break;
                        }
                        Ok(_) => {}
                        Err(_) => {
                            child_ended.store(true, Ordering::SeqCst);
                            let _ = event_tx.send(NativeMessage::Closed);
                            break;
                        }
                    }
                    let Ok(value) = serde_json::from_str::<Value>(line.trim_end()) else {
                        continue;
                    };
                    let method = value
                        .get("method")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned();
                    let is_request =
                        !method.is_empty() && value.get("id").is_some_and(|id| !id.is_null());
                    if !is_request {
                        if event_tx.send(NativeMessage::Json(value)).is_err() {
                            break;
                        }
                        continue;
                    }
                    let original_id = value.get("id").cloned().unwrap_or(Value::Null);
                    if method != "session/request_permission" {
                        // No client file system or terminal capability was
                        // negotiated; every other agent->client request is
                        // refused immediately instead of being left hanging.
                        if !write_line(&json!({
                            "jsonrpc": "2.0",
                            "id": original_id,
                            "error": {
                                "code": -32601,
                                "message": format!("goalport-core does not implement {method}")
                            }
                        })) {
                            break;
                        }
                        continue;
                    }
                    // Agent->client JSON-RPC ids restart at 0 for every process,
                    // so the Decision id must carry the session identity too.
                    let hash = session_hash
                        .lock()
                        .map(|shared| shared.clone())
                        .unwrap_or_default();
                    let request_id = format!(
                        "grok-{}-{}-{}",
                        hash.chars().take(16).collect::<String>(),
                        process_epoch,
                        bounded_scalar(&original_id)
                    );
                    let options = value
                        .pointer("/params/options")
                        .cloned()
                        .unwrap_or(Value::Null);
                    let mut forwarded = value.clone();
                    if let Some(object) = forwarded.as_object_mut() {
                        object.insert(GROK_DECISION_ID_KEY.into(), json!(request_id));
                    }
                    // Drain stale commands and publish the pending id under ONE lock, drain
                    // first. While the slot is empty `interrupt` cannot enqueue anything, so
                    // nothing legitimate can be discarded; once the slot is set, every cancel is
                    // enqueued after the drain and is therefore honoured. Setting the slot before
                    // draining lost the first Safe stop of a turn (R1).
                    {
                        let Ok(mut pending) = pending_permission.lock() else {
                            break;
                        };
                        for _ in permission_rx.try_iter() {}
                        *pending = Some(request_id.clone());
                    }
                    if event_tx.send(NativeMessage::Json(forwarded)).is_err() {
                        break;
                    }
                    // A Safe stop pressed before this request was published leaves no command
                    // to receive, only the latch. Consume it here, once, BEFORE blocking: the
                    // first press is then honoured instead of waiting for a second one (V1).
                    let mut allow = None;
                    let mut cancelled = cancel_requested.swap(false, Ordering::SeqCst);
                    // Otherwise: either the Core Decision arrives, or `interrupt` releases us so
                    // the pending request can be answered `cancelled` and the reader can go on to
                    // read the cancelled stopReason (critic finding F1).
                    while !cancelled {
                        match permission_rx.recv() {
                            // A cancel is honoured only for the request actually pending.
                            Ok(command) if command.cancel && command.request_id == request_id => {
                                cancelled = true;
                                break;
                            }
                            Ok(command) if !command.cancel && command.request_id == request_id => {
                                allow = Some(command.allow);
                                break;
                            }
                            Ok(_) => continue,
                            Err(_) => break,
                        }
                    }
                    // The slot is cleared the moment a command lands, so poll_events never
                    // synthesises a second cancelled response for a request already handled.
                    if let Ok(mut pending) = pending_permission.lock() {
                        *pending = None;
                    }
                    if !cancelled && allow.is_none() {
                        break;
                    }
                    // `allow_always` and `reject_always` are never sent: one Core Decision
                    // grants exactly one native action, and a cancel selects no option at all.
                    let wanted = match allow {
                        Some(true) => "allow_once",
                        Some(false) => "reject_once",
                        None => "",
                    };
                    let chosen = if cancelled {
                        None
                    } else {
                        options.as_array().and_then(|list| {
                            list.iter()
                                .find(|option| {
                                    option.get("kind").and_then(Value::as_str) == Some(wanted)
                                })
                                .cloned()
                        })
                    };
                    let (outcome, option_kind, option_id) = match chosen {
                        Some(option) => {
                            let option_id = option.get("optionId").cloned().unwrap_or(Value::Null);
                            (
                                json!({ "outcome": "selected", "optionId": option_id }),
                                wanted.to_owned(),
                                bounded_scalar(&option_id),
                            )
                        }
                        None => (
                            json!({ "outcome": "cancelled" }),
                            "cancelled".to_owned(),
                            String::new(),
                        ),
                    };
                    if !write_line(&json!({
                        "jsonrpc": "2.0",
                        "id": original_id,
                        "result": { "outcome": outcome }
                    })) {
                        // The answer never reached the Runtime, so nothing was granted. Report
                        // the Decision as cancelled anyway: leaving it open would strand it on a
                        // process that can no longer act (critic finding K2).
                        let _ = event_tx.send(NativeMessage::Json(json!({
                            "method": GROK_PERMISSION_RESPONSE_METHOD,
                            "params": {
                                "request_id": request_id,
                                "option_kind": "cancelled",
                                "option_id": "",
                                "allow": false,
                                "cancelled": true,
                                "reason": "the native Runtime could not be answered"
                            }
                        })));
                        break;
                    }
                    if event_tx
                        .send(NativeMessage::Json(json!({
                            "method": GROK_PERMISSION_RESPONSE_METHOD,
                            "params": {
                                "request_id": request_id,
                                "option_kind": option_kind,
                                "option_id": option_id,
                                "allow": allow == Some(true),
                                "cancelled": cancelled
                            }
                        })))
                        .is_err()
                    {
                        break;
                    }
                }
                // Whatever ended the loop (EOF, a write failure on a dead pipe, a closed
                // channel), the Core side must learn that the stream is gone exactly once.
                child_ended.store(true, Ordering::SeqCst);
                let _ = event_tx.send(NativeMessage::Closed);
            })
            .map_err(|error| {
                AdapterError::Connection(format!("unable to start the Grok ACP reader: {error}"))
            })?;
        self.event_rx = Some(event_rx);
        self.permission_tx = Some(permission_tx);
        Ok(())
    }

    fn permission_response(&mut self, response: PermissionResponse) -> Result<(), AdapterError> {
        let request_id = response.request_id.trim();
        if request_id.is_empty() {
            return Err(AdapterError::InvalidRequest(
                "permission request id is empty".into(),
            ));
        }
        let sender = self
            .permission_tx
            .as_ref()
            .ok_or_else(|| AdapterError::Connection("Grok ACP reader is not active".into()))?;
        sender
            .send(PermissionCommand {
                request_id: request_id.into(),
                allow: response.allow,
                cancel: false,
            })
            .map_err(|_| AdapterError::Connection("Grok permission reader is closed".into()))
    }

    fn interrupt(&mut self) -> Result<crate::adapters::CancelResult, AdapterError> {
        let Some(session_id) = self.session_id.clone() else {
            return Err(AdapterError::Connection(
                "Grok ACP session is not active".into(),
            ));
        };
        if self.turn_request_id.is_none() {
            return Ok(crate::adapters::CancelResult {
                requested: false,
                confirmed: false,
                reason: Some("no active turn".into()),
            });
        }
        // Release FIRST and unconditionally: a reader blocked on a pending permission must be
        // freed even when the wire write fails, otherwise a dead or broken pipe traps Safe stop
        // for ever. The release is addressed to the exact pending request, so it can never be
        // consumed by a later turn (critic findings K1 and K2).
        let _ = self.release_pending_permission();
        let wire = self.send_json(&json!({
            "jsonrpc": "2.0",
            "method": "session/cancel",
            "params": { "sessionId": session_id }
        }));
        // No provider effect is claimed until the native `cancelled` stopReason
        // is observed on the in-flight `session/prompt` response.
        match wire {
            Ok(()) => Ok(crate::adapters::CancelResult {
                requested: true,
                confirmed: false,
                reason: Some(
                    "session/cancel sent; awaiting the native cancelled stopReason".into(),
                ),
            }),
            Err(error) => Ok(crate::adapters::CancelResult {
                requested: false,
                confirmed: false,
                reason: Some(format!(
                    "session/cancel could not be written ({error}); the reader was released and the pending permission is answered cancelled"
                )),
            }),
        }
    }

    fn drop_stdio(&mut self) -> Result<(), AdapterError> {
        self.stdin.take();
        self.stdout.take();
        self.event_rx.take();
        self.permission_tx.take();
        Ok(())
    }

    fn close(&mut self) -> Result<(), AdapterError> {
        if let Some(child) = self.child.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        self.child = None;
        self.stdin = None;
        self.stdout = None;
        self.permission_tx = None;
        Ok(())
    }

    fn next_request_id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    fn send_json(&mut self, value: &Value) -> Result<(), AdapterError> {
        let stdin = self
            .stdin
            .as_mut()
            .ok_or_else(|| AdapterError::Connection("Grok ACP stdin is closed".into()))?;
        let mut stdin = stdin
            .lock()
            .map_err(|_| AdapterError::Connection("Grok ACP stdin lock is poisoned".into()))?;
        serde_json::to_writer(&mut *stdin, value)?;
        stdin.write_all(b"\n")?;
        stdin.flush()?;
        Ok(())
    }

    fn request(
        &mut self,
        method: &str,
        params: Value,
        timeout_ms: u64,
    ) -> Result<Value, AdapterError> {
        let id = self.next_request_id();
        self.send_json(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        }))?;
        let response = self.await_response(id, method, timeout_ms)?;
        if let Some(error) = response.get("error") {
            let code = error
                .get("code")
                .map(bounded_scalar)
                .unwrap_or_else(|| "unknown".into());
            return Err(AdapterError::Protocol(format!(
                "Grok ACP {method} returned error {code}"
            )));
        }
        Ok(response)
    }

    /// Drain the reader channel until the matching JSON-RPC response arrives.
    /// Every other frame is buffered, because ACP publishes notifications (the
    /// command advertisement in particular) before the response they precede.
    fn await_response(
        &mut self,
        id: u64,
        method: &str,
        timeout_ms: u64,
    ) -> Result<Value, AdapterError> {
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        loop {
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                return Err(AdapterError::Connection(format!(
                    "Grok ACP {method} did not answer within {timeout_ms} ms"
                )));
            };
            let message = {
                let receiver = self.event_rx.as_ref().ok_or_else(|| {
                    AdapterError::Connection("Grok ACP reader is not active".into())
                })?;
                receiver.recv_timeout(remaining)
            };
            match message {
                Ok(NativeMessage::Json(value)) => {
                    if value.get("id").and_then(Value::as_u64) == Some(id)
                        && (value.get("result").is_some() || value.get("error").is_some())
                    {
                        return Ok(value);
                    }
                    self.pending_frames.push(value);
                }
                Ok(NativeMessage::Closed) | Err(RecvTimeoutError::Disconnected) => {
                    self.stream_closed = true;
                    return Err(AdapterError::Connection(
                        "native Runtime closed the ACP stream".into(),
                    ));
                }
                Err(RecvTimeoutError::Timeout) => {
                    return Err(AdapterError::Connection(format!(
                        "Grok ACP {method} did not answer within {timeout_ms} ms"
                    )));
                }
            }
        }
    }
}

impl Drop for GrokAcpProcess {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

/// A bounded native Codex fallback for environments where a detached Core
/// cannot keep the app-server stdio child attached. It still calls the
/// installed, ChatGPT-authenticated CLI, keeps the prompt in the native
/// process, and persists every JSONL frame through Core. Resume and interactive
/// approval remain explicit capability gaps for this transport.
#[derive(Debug)]
struct CodexExecProcess {
    executable: PathBuf,
    version: String,
    workspace_root: PathBuf,
    session_id: Option<String>,
}

impl CodexExecProcess {
    fn new(executable: PathBuf, version: String, workspace_root: PathBuf) -> Self {
        Self {
            executable,
            version,
            workspace_root,
            session_id: None,
        }
    }

    fn identity_summary(&self) -> RuntimeIdentitySummary {
        RuntimeIdentitySummary {
            provider: "codex".into(),
            version: self.version.clone(),
            executable: Some(self.executable.to_string_lossy().into_owned()),
            protocol: "codex.exec.json.v1".into(),
            native: true,
        }
    }

    fn create_session(
        &mut self,
        request: &SessionRequest,
    ) -> Result<RuntimeSessionResult, AdapterError> {
        request.validate()?;
        let session_id = request
            .resume_session
            .clone()
            .unwrap_or_else(|| format!("codex-exec-session-{}", request.attempt_id));
        if request.resume_session.is_some() {
            return Err(AdapterError::Unsupported(
                "Codex exec JSON has no native resume method".into(),
            ));
        }
        self.session_id = Some(session_id.clone());
        Ok(RuntimeSessionResult {
            handle: SessionHandle {
                session_id,
                resumed: false,
            },
            events: Vec::new(),
        })
    }

    fn send_prompt(&mut self, request: &PromptRequest) -> Result<RuntimeSendResult, AdapterError> {
        request.validate()?;
        if self.session_id.is_none() {
            return Err(AdapterError::Connection(
                "Codex exec session is not active".into(),
            ));
        }
        let mut command = Command::new(&self.executable);
        debug_runtime(&format!(
            "starting Codex exec cwd={}",
            self.workspace_root.display()
        ));
        let output = command
            .args([
                "exec",
                "--json",
                "--ephemeral",
                "--sandbox",
                "read-only",
                "--skip-git-repo-check",
                "--cd",
                self.workspace_root.to_string_lossy().as_ref(),
                request.text.as_str(),
            ])
            .current_dir(&self.workspace_root)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .env_remove("OPENAI_API_KEY")
            .env_remove("ANTHROPIC_API_KEY")
            .env_remove("XAI_API_KEY")
            .output()
            .map_err(|error| {
                AdapterError::Connection(format!("unable to start Codex exec: {error}"))
            })?;
        debug_runtime(&format!(
            "Codex exec returned status={:?} stdout_bytes={}",
            output.status.code(),
            output.stdout.len()
        ));
        let mut events = Vec::new();
        let process_epoch_id = format!("codex-exec-process-{}", monotonic_id());
        let mut observed_session_id = None;
        for (index, line) in String::from_utf8_lossy(&output.stdout).lines().enumerate() {
            if line.len() > MAX_NATIVE_LINE_BYTES {
                return Err(AdapterError::Protocol(
                    "native Runtime event exceeds bound".into(),
                ));
            }
            let value: Value = serde_json::from_str(line)?;
            if observed_session_id.is_none() {
                observed_session_id = extract_provider_session_id(&value);
            }
            let method = value
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("notification");
            let event_type = classify_cli_event(method, &value);
            let Some(payload) = normalized_cli_payload(method, &value) else {
                continue;
            };
            events.push(AgentEventEnvelope {
                event_id: format!("codex-exec-event-{}", index + 1),
                campaign_id: None,
                task_id: String::new(),
                attempt_id: request.attempt_id.clone(),
                process_epoch_id: process_epoch_id.clone(),
                sequence: (index + 1) as i64,
                occurred_at: now(),
                received_at: now(),
                provider_event_reference: value
                    .get("id")
                    .and_then(Value::as_str)
                    .map(|id| format!("codex-exec-ref:{}", sha256_hex(id.as_bytes()))),
                event_type,
                payload,
            });
        }
        if !output.status.success() {
            events.push(AgentEventEnvelope {
                event_id: format!("codex-exec-failed-{}", monotonic_id()),
                campaign_id: None,
                task_id: String::new(),
                attempt_id: request.attempt_id.clone(),
                process_epoch_id,
                sequence: events.len() as i64 + 1,
                occurred_at: now(),
                received_at: now(),
                provider_event_reference: None,
                event_type: AgentEventType::TurnFailed,
                payload: json!({ "status": output.status.code(), "provider": "codex" }),
            });
        }
        if let Some(session_id) = observed_session_id.as_ref() {
            self.session_id = Some(session_id.clone());
        }
        Ok(RuntimeSendResult {
            accepted: output.status.success(),
            duplicate: false,
            // The id generated during create_session is only a Core-local
            // placeholder.  Report a session identity from native output so
            // handoff cannot mistake a synthetic Attempt id for a native one.
            session_id: observed_session_id,
            events,
        })
    }

    fn close(&mut self) -> Result<(), AdapterError> {
        self.session_id = None;
        Ok(())
    }
}

struct ClaudePendingPermission {
    native_request_id: String,
    tool_name: String,
    input: Value,
    tool_use_id: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MutatingToolDecision {
    Pending,
    Allowed,
    Denied,
}

#[derive(Clone, Debug)]
struct PathSnapshot {
    path: PathBuf,
    exists: bool,
    sha256: Option<String>,
    mtime: Option<SystemTime>,
}

#[derive(Clone, Debug)]
struct MutatingToolRecord {
    decision: MutatingToolDecision,
    snapshot: Option<PathSnapshot>,
}

/// The single terminal disposition an unresolved Claude Stop may reach.
///
/// `turn_in_flight` answers "does the Runtime still owe a response for a prompt"
/// and a terminal result may truthfully clear it. That is a different question
/// from "has the Stop the user asked for been resolved", which this answers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ClaudeStopDisposition {
    Pending,
    /// A: the native result confirmed this turn's interrupt.
    NativeTurnCancel,
    /// Fail-closed: attempted, rejected or unobservable. Never A and never B.
    Unknown,
}

impl ClaudeStopDisposition {
    fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::NativeTurnCancel => "native_turn_cancel",
            Self::Unknown => "unknown",
        }
    }
}

/// One unresolved Stop request, bound to the exact managed child that was live
/// when the user pressed Safe stop. Every field here is compared again at the
/// fallback deadline; any drift fails the Stop closed instead of signalling.
struct ClaudeStopRequest {
    request_id: String,
    operation_id: String,
    input_uuid: Option<String>,
    requested_ns: u64,
    send_succeeded: bool,
    raw_receipt: Option<Value>,
    raw_result: Option<Value>,
    requested_at: Instant,
    attempt_id: String,
    session_id: Option<String>,
    turn_epoch: u64,
    process_epoch: String,
    pid: u32,
    creation_date: String,
    executable_path: String,
    executable_sha256: String,
    disposition: ClaudeStopDisposition,
    /// Latched before the signal is issued, so a failed send can never be
    /// retried into a second signal.
    signal_attempted: bool,
    signal_count: u32,
    signal_sent: bool,
    exact_child_alive_at_deadline: Option<bool>,
    post_stop_activity: bool,
    result_seen: bool,
    result_stop_reason: Option<String>,
    result_subtype: Option<String>,
    reason: Option<String>,
    terminal_emitted: bool,
}

impl ClaudeStopRequest {
    fn unresolved(&self) -> bool {
        !self.terminal_emitted
    }
}

struct ClaudeStreamProcess {
    executable: PathBuf,
    version: String,
    workspace_root: PathBuf,
    child: Option<Child>,
    /// The transient Claude-only broker, when the brokered console topology is
    /// selected. `child` stays `None` in that mode: the Claude process handle is
    /// deliberately owned by the broker, which is the only process that can be
    /// the console signal caller.
    broker: Option<BrokerSession>,
    /// Broker-reported exit of the exact child, latched once observed.
    brokered_exit: Option<bool>,
    /// Raw broker frames kept for the stop trace. Delivery and effect are
    /// separate observations and are never collapsed into one another.
    broker_delivery: Option<Value>,
    broker_effect: Option<Value>,
    /// Reader/writer are trait objects because Claude's pipes come either from
    /// `Child` (direct) or from Core-created pipe handles (brokered).
    stdin: Option<Arc<Mutex<Box<dyn Write + Send>>>>,
    stdout: Option<BufReader<Box<dyn Read + Send>>>,
    event_rx: Option<Receiver<NativeMessage>>,
    pending_frames: Vec<Value>,
    next_control: u64,
    session_id: Option<String>,
    session_hash: Option<String>,
    session_created_emitted: bool,
    initialized: bool,
    turn_in_flight: bool,
    fail_open: bool,
    fail_open_without_host_decision: bool,
    unknown_effect: bool,
    used_sigint: bool,
    interrupt_requested: bool,
    pending_interrupt_request_id: Option<String>,
    interrupt_requested_at: Option<Instant>,
    interrupt_receipt_matched: bool,
    interrupt_still_queued: Option<Vec<String>>,
    /// Unresolved Stop state. Independent of `turn_in_flight` by design.
    pending_stop: Option<ClaudeStopRequest>,
    /// Bumped on every prompt so a Stop can recognise a newer turn taking over.
    turn_epoch: u64,
    input_uuid: Option<String>,
    input_result_seen: bool,
    stop_operation_id: Option<String>,
    receive_clock: Instant,
    claude_capabilities: HashSet<String>,
    pending_permissions: HashMap<String, ClaudePendingPermission>,
    answered_permissions: HashSet<String>,
    mutating_tools: HashMap<String, MutatingToolRecord>,
    assistant_text: String,
    last_emitted_assistant: String,
    pending_out: Vec<AgentEventEnvelope>,
    child_ended: Arc<AtomicBool>,
    stream_closed: bool,
    sequence: i64,
    attempt_id: Option<String>,
    campaign_id: Option<String>,
    task_id: Option<String>,
    process_binding: Option<RuntimeProcessBinding>,
    /// Set the moment a spawn succeeds and never cleared: a process existed at some point,
    /// whatever happened to it afterwards (see `RuntimeManager::process_started`).
    spawned: bool,
}

impl ClaudeStreamProcess {
    fn new(executable: PathBuf, version: String, workspace_root: PathBuf) -> Self {
        Self {
            executable,
            version,
            workspace_root,
            child: None,
            broker: None,
            brokered_exit: None,
            broker_delivery: None,
            broker_effect: None,
            stdin: None,
            stdout: None,
            event_rx: None,
            pending_frames: Vec::new(),
            next_control: 1,
            session_id: None,
            session_hash: None,
            session_created_emitted: false,
            initialized: false,
            turn_in_flight: false,
            fail_open: false,
            fail_open_without_host_decision: false,
            unknown_effect: false,
            used_sigint: false,
            interrupt_requested: false,
            pending_interrupt_request_id: None,
            interrupt_requested_at: None,
            interrupt_receipt_matched: false,
            interrupt_still_queued: None,
            pending_stop: None,
            turn_epoch: 0,
            input_uuid: None,
            input_result_seen: false,
            stop_operation_id: None,
            receive_clock: Instant::now(),
            claude_capabilities: HashSet::new(),
            pending_permissions: HashMap::new(),
            answered_permissions: HashSet::new(),
            mutating_tools: HashMap::new(),
            assistant_text: String::new(),
            last_emitted_assistant: String::new(),
            pending_out: Vec::new(),
            child_ended: Arc::new(AtomicBool::new(false)),
            stream_closed: false,
            sequence: 0,
            attempt_id: None,
            campaign_id: None,
            task_id: None,
            process_binding: None,
            spawned: false,
        }
    }

    fn identity_summary(&self) -> RuntimeIdentitySummary {
        RuntimeIdentitySummary {
            provider: "claude".into(),
            version: self.version.clone(),
            executable: Some(self.executable.to_string_lossy().into_owned()),
            protocol: CLAUDE_PROTOCOL_VERSION.into(),
            native: true,
        }
    }

    fn ensure_started(&mut self) -> Result<(), AdapterError> {
        if self.child.is_some() {
            return Ok(());
        }
        if brokered_claude_launch() {
            return Err(AdapterError::Unsupported(
                "Rejected Claude broker route is unavailable in the native Stop product candidate"
                    .into(),
            ));
        }
        let argv = ClaudeCliAdapter::spawn_argv(&self.executable, &self.workspace_root, None);
        // The native flags are never rewritten. Under the fixture indirection
        // the interpreter becomes the program and the fixture script is simply
        // the first argument ahead of those unchanged flags.
        let (program, flags) = match claude_fixture_interpreter() {
            Some(interpreter) => {
                let mut flags = vec![self.executable.to_string_lossy().into_owned()];
                flags.extend(argv.iter().skip(1).cloned());
                (interpreter, flags)
            }
            None => (
                self.executable.clone(),
                argv.iter().skip(1).cloned().collect::<Vec<_>>(),
            ),
        };
        debug_runtime(&format!(
            "spawn claude argv={:?} exe_path_sha256={} cwd={} brokered={}",
            argv,
            sha256_hex(self.executable.to_string_lossy().as_bytes()),
            sha256_hex(self.workspace_root.to_string_lossy().as_bytes()),
            brokered_claude_launch()
        ));
        let (pid, stdin, stdout): (u32, Box<dyn Write + Send>, Box<dyn Read + Send>) =
            if brokered_claude_launch() {
                let broker_exe = claude_stop_broker::resolve_broker_exe().ok_or_else(|| {
                    AdapterError::Connection(format!(
                        "the brokered Claude launch was requested but {} was not found next to Core",
                        claude_stop_broker::BROKER_EXE_NAME
                    ))
                })?;
                let mut broker = BrokerSession::launch(&BrokerLaunch {
                    broker_exe,
                    claude_exe: program,
                    args: flags,
                    cwd: self.workspace_root.clone(),
                    env_remove: CLAUDE_ENV_REMOVED
                        .iter()
                        .map(|key| (*key).to_owned())
                        .collect(),
                })
                .map_err(|error| {
                    AdapterError::Connection(format!(
                        "unable to start brokered claude stream-json: {error}"
                    ))
                })?;
                let stdin = broker.claude_stdin.take().ok_or_else(|| {
                    AdapterError::Connection("brokered Claude stdin unavailable".into())
                })?;
                let stdout = broker.claude_stdout.take().ok_or_else(|| {
                    AdapterError::Connection("brokered Claude stdout unavailable".into())
                })?;
                let pid = broker.claude_pid;
                self.broker = Some(broker);
                self.spawned = true;
                (pid, Box::new(stdin), Box::new(stdout))
            } else {
                let mut command = Command::new(&program);
                command
                    .args(&flags)
                    .current_dir(&self.workspace_root)
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::null());
                for key in CLAUDE_ENV_REMOVED {
                    command.env_remove(key);
                }
                hide_native_console(&mut command);
                let mut child = command.spawn().map_err(|error| {
                    AdapterError::Connection(format!("unable to start claude stream-json: {error}"))
                })?;
                self.spawned = true;
                let stdin = child.stdin.take().ok_or_else(|| {
                    AdapterError::Connection("Claude stream-json stdin unavailable".into())
                })?;
                let stdout = child.stdout.take().ok_or_else(|| {
                    AdapterError::Connection("Claude stream-json stdout unavailable".into())
                })?;
                let pid = child.id();
                self.child = Some(child);
                (pid, Box::new(stdin), Box::new(stdout))
            };
        let observed = match process_identity::observe_process(pid) {
            ProcessObservation::Live(identity) => identity,
            ProcessObservation::NotRunning => {
                let _ = self.close();
                return Err(AdapterError::Connection(
                    "claude stream-json exited before its process identity was observed".into(),
                ));
            }
            ProcessObservation::Unknown(reason) => {
                let _ = self.close();
                return Err(AdapterError::Connection(format!(
                    "claude stream-json process identity is unknown: {reason}"
                )));
            }
        };
        let canonical = format!(
            "claude|{}|{}|{}|{}",
            observed.pid,
            observed.created_ms,
            observed.executable_path.to_ascii_lowercase(),
            observed.executable_sha256.to_ascii_lowercase()
        );
        self.process_binding = Some(RuntimeProcessBinding {
            process_epoch: format!("runtime-epoch:{}", sha256_hex(canonical.as_bytes())),
            pid: observed.pid,
            creation_date: observed.creation_date(),
            executable_path: observed.executable_path,
            executable_sha256: observed.executable_sha256,
        });
        self.stdin = Some(Arc::new(Mutex::new(stdin)));
        self.stdout = Some(BufReader::new(stdout));
        self.start_reader()?;
        let init_id = self.next_control_id();
        self.send_json(&json!({
            "type": "control_request",
            "request_id": init_id,
            "request": { "subtype": "initialize", "hooks": null }
        }))?;
        self.await_control_response(&init_id, CLAUDE_INIT_TIMEOUT_MS)?;
        self.initialized = true;
        Ok(())
    }

    fn create_session(
        &mut self,
        request: &SessionRequest,
    ) -> Result<RuntimeSessionResult, AdapterError> {
        request.validate()?;
        self.attempt_id = Some(request.attempt_id.clone());
        self.campaign_id = request.campaign_id.clone();
        self.task_id = Some(request.task_id.clone());
        if request
            .resume_session
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
        {
            return Err(AdapterError::Unsupported(
                "Claude native --resume is not verified on this adapter path; start a new Attempt or Handoff"
                    .into(),
            ));
        }
        self.ensure_started()?;
        Ok(RuntimeSessionResult {
            handle: SessionHandle {
                session_id: String::new(),
                resumed: false,
            },
            events: Vec::new(),
        })
    }

    fn resume_session(&mut self, session_id: &str) -> Result<RuntimeSessionResult, AdapterError> {
        if session_id.trim().is_empty() || session_id.starts_with("claude-session-") {
            return Err(AdapterError::InvalidRequest(
                "Claude resume refused: session id is empty or manufactured".into(),
            ));
        }
        Err(AdapterError::Unsupported(
            "Claude native --resume is not verified on this adapter path; start a new Attempt or Handoff"
                .into(),
        ))
    }

    fn send_prompt(&mut self, request: &PromptRequest) -> Result<RuntimeSendResult, AdapterError> {
        request.validate()?;
        if self.stream_closed {
            return Err(AdapterError::Connection(
                "native Runtime closed the Claude stream".into(),
            ));
        }
        if !self.initialized {
            return Err(AdapterError::Connection(
                "Claude stream-json initialize handshake has not completed".into(),
            ));
        }
        #[cfg(debug_assertions)]
        if self.executable.file_name().and_then(|x| x.to_str()) == Some("fake-claude-cli.cmd")
            && self
                .workspace_root
                .join(".fake-claude-send-error-after-write")
                .is_file()
        {
            use std::io::Write;
            if let Ok(mut file) = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(self.workspace_root.join(".fake-claude-send-attempts"))
            {
                let _ = writeln!(file, "attempt");
            }
        }
        if self.turn_in_flight {
            return Err(AdapterError::InvalidRequest(
                "a Claude turn is already in flight; wait for it to finish or use Safe stop".into(),
            ));
        }
        if self.pending_stop.is_some() {
            return Err(AdapterError::InvalidRequest(
                "Claude residual execution is unconfirmed; write responsibility remains held"
                    .into(),
            ));
        }
        // A newer turn is newer ownership: an unresolved Stop from the previous
        // turn can no longer be signalled or confirmed, so it fails closed here
        // rather than silently disappearing.
        let attempt_id = self
            .attempt_id
            .clone()
            .unwrap_or_else(|| request.attempt_id.clone());
        let superseded = if self
            .pending_stop
            .as_ref()
            .is_some_and(ClaudeStopRequest::unresolved)
        {
            self.resolve_stop(
                &attempt_id,
                ClaudeStopDisposition::Unknown,
                Some("a newer Claude turn was started before this Stop was resolved".into()),
            )
        } else {
            Vec::new()
        };
        self.pending_stop = None;
        self.turn_epoch += 1;
        // UUIDv8: a Core-defined identifier bound to process/Attempt/input key/epoch.
        // It is transmitted explicitly; returned identities are never guessed.
        let digest = sha256_hex(
            format!(
                "{}|{}|{}|{}",
                self.process_binding
                    .as_ref()
                    .map(|b| b.process_epoch.as_str())
                    .unwrap_or(""),
                attempt_id,
                request.idempotency_key,
                self.turn_epoch
            )
            .as_bytes(),
        );
        self.input_uuid = Some(format!(
            "{}-{}-8{}-a{}-{}",
            &digest[0..8],
            &digest[8..12],
            &digest[13..16],
            &digest[17..20],
            &digest[20..32]
        ));
        self.input_result_seen = false;
        self.stop_operation_id = None;
        self.fail_open = false;
        self.fail_open_without_host_decision = false;
        self.unknown_effect = false;
        self.used_sigint = false;
        self.interrupt_requested = false;
        self.pending_interrupt_request_id = None;
        self.interrupt_requested_at = None;
        self.interrupt_receipt_matched = false;
        self.interrupt_still_queued = None;
        self.mutating_tools.clear();
        self.assistant_text.clear();
        self.last_emitted_assistant.clear();
        self.send_json(&json!({
            "type": "user",
            "uuid": self.input_uuid,
            "message": { "role": "user", "content": request.text },
            "parent_tool_use_id": null
        }))?;
        self.turn_in_flight = true;
        // Debug fixture only: accepted pipe write followed by uncertain return.
        // This code is absent from the release product and cannot target native Claude.
        #[cfg(debug_assertions)]
        if self.executable.file_name().and_then(|x| x.to_str()) == Some("fake-claude-cli.cmd")
            && self
                .workspace_root
                .join(".fake-claude-send-error-after-write")
                .is_file()
        {
            return Err(AdapterError::Connection(
                "synthetic delivery error after accepted input write".into(),
            ));
        }
        self.sequence += 1;
        let started = self
            .envelope(
                &attempt_id,
                AgentEventType::TurnStarted,
                json!({ "status": "running", "input_uuid": self.input_uuid,
                    "turn_epoch": self.turn_epoch, "input_idempotency_key": request.idempotency_key }),
                None,
            )
            .ok_or_else(|| {
                AdapterError::Connection("Claude process epoch is unavailable".into())
            })?;
        let mut events = superseded;
        events.push(started);
        if self.session_id.is_none() {
            events.extend(self.drain_until_session(&attempt_id)?);
        }
        Ok(RuntimeSendResult {
            accepted: true,
            duplicate: false,
            session_id: self.session_id.clone(),
            events,
        })
    }

    fn drain_until_session(
        &mut self,
        attempt_id: &str,
    ) -> Result<Vec<AgentEventEnvelope>, AdapterError> {
        let deadline = Instant::now() + Duration::from_millis(CLAUDE_SESSION_BIND_TIMEOUT_MS);
        let mut events = Vec::new();
        while self.session_id.is_none() {
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                break;
            };
            let message = {
                let Some(receiver) = self.event_rx.as_ref() else {
                    break;
                };
                receiver.recv_timeout(remaining)
            };
            match message {
                Ok(NativeMessage::Json(value)) => {
                    events.extend(self.take_mapped(attempt_id, &value));
                }
                Ok(NativeMessage::Closed) | Err(RecvTimeoutError::Disconnected) => {
                    self.stream_closed = true;
                    break;
                }
                Err(RecvTimeoutError::Timeout) => break,
            }
        }
        Ok(events)
    }

    fn live_pid(&self) -> Option<u32> {
        if self.stream_closed || self.child_ended.load(Ordering::SeqCst) {
            return None;
        }
        self.managed_pid()
    }

    /// Increment 6 (read-only expression): whether the stream has ended, from the existing flags.
    /// Behaviour is unchanged; this only lets `transport_state` report Claude uniformly.
    fn stream_ended(&self) -> bool {
        self.stream_closed || self.child_ended.load(Ordering::SeqCst)
    }

    /// The exact managed Claude pid under either launch. In brokered mode the
    /// process handle belongs to the broker, so the pid comes from the identity
    /// the broker reported at launch and Core re-observes it before every use.
    fn managed_pid(&self) -> Option<u32> {
        match (self.child.as_ref(), self.broker.as_ref()) {
            (Some(child), _) => Some(child.id()),
            (None, Some(broker)) => (broker.claude_pid != 0).then_some(broker.claude_pid),
            (None, None) => None,
        }
    }

    /// Observe the exact brokered child by its bound identity. Core never holds
    /// that process handle, so `try_wait` is unavailable: exit is established
    /// from the broker's own effect report, or from an OS observation that is
    /// only trusted while the full bound identity still matches.
    fn brokered_child_exited(&mut self) -> Option<bool> {
        if let Some(exited) = self.brokered_exit {
            return Some(exited);
        }
        let pid = self.broker.as_ref().map(|broker| broker.claude_pid)?;
        let binding = self.process_binding.clone()?;
        if pid == 0 {
            return None;
        }
        match process_identity::observe_process(pid) {
            ProcessObservation::NotRunning => {
                self.brokered_exit = Some(true);
                self.child_ended.store(true, Ordering::SeqCst);
                Some(true)
            }
            // A live pid that is no longer the bound identity is pid reuse, and
            // pid reuse is not evidence that the bound child stopped.
            ProcessObservation::Live(identity) => (identity.creation_date()
                == binding.creation_date
                && identity
                    .executable_sha256
                    .eq_ignore_ascii_case(&binding.executable_sha256))
            .then_some(false),
            ProcessObservation::Unknown(_) => None,
        }
    }

    fn turn_in_flight(&self) -> bool {
        self.turn_in_flight
    }

    fn poll_events(&mut self, attempt_id: &str) -> Result<Vec<AgentEventEnvelope>, AdapterError> {
        if self.broker.is_some() {
            if self.brokered_child_exited() == Some(true) {
                self.child_ended.store(true, Ordering::SeqCst);
            }
        } else if let Some(child) = self.child.as_mut()
            && matches!(child.try_wait(), Ok(Some(_)))
        {
            self.child_ended.store(true, Ordering::SeqCst);
        }
        let mut frames = std::mem::take(&mut self.pending_frames);
        let mut closed = self.child_ended.load(Ordering::SeqCst);
        if let Some(receiver) = self.event_rx.as_ref() {
            for message in receiver.try_iter() {
                match message {
                    NativeMessage::Json(value) => frames.push(value),
                    NativeMessage::Closed => {
                        closed = true;
                        break;
                    }
                }
            }
        }
        let mut events = Vec::new();
        for frame in frames {
            events.extend(self.take_mapped(attempt_id, &frame));
        }
        if let Some(child) = self.child.as_mut()
            && matches!(child.try_wait(), Ok(Some(_)))
        {
            self.child_ended.store(true, Ordering::SeqCst);
            closed = true;
        }
        // The Stop is driven from its own pending state, never from
        // `turn_in_flight`. It runs before the stream-close branch so that a
        // Stop that owns this turn emits the single terminal disposition.
        events.extend(self.drive_pending_stop(attempt_id));
        if closed && !self.stream_closed {
            self.stream_closed = true;
            if self.turn_in_flight {
                if let Some(text) = self.flush_assistant_text(attempt_id) {
                    events.push(text);
                }
                self.turn_in_flight = false;
                self.sequence += 1;
                // Reaching here means no Stop owned this turn (an owned Stop
                // clears `turn_in_flight` when it resolves), so GoalPort never
                // signalled and this can never be a safe process stop.
                let payload = self.with_interrupt_trace(json!({
                    "status": "failed",
                    "native_turn_cancel": false,
                    "safe_process_stop": false,
                    "unsupported": true,
                    "stopKind": "unsupported",
                    "text": "Claude stop unsupported: native Runtime closed the stream without interrupt confirmation"
                }));
                if let Some(event) =
                    self.envelope(attempt_id, AgentEventType::TurnFailed, payload, None)
                {
                    events.push(event);
                }
            }
        }
        Ok(events)
    }

    fn take_mapped(&mut self, attempt_id: &str, value: &Value) -> Vec<AgentEventEnvelope> {
        let mut retained = Vec::new();
        let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
        if matches!(
            kind,
            "assistant"
                | "user"
                | "stream_event"
                | "result"
                | "command_lifecycle"
                | "task_started"
                | "task_progress"
                | "task_notification"
                | "rate_limit_event"
        ) || (kind == "control_request"
            && value.pointer("/request/subtype").and_then(Value::as_str) == Some("can_use_tool"))
            || (kind == "control_response"
                && self.pending_interrupt_request_id.as_deref()
                    == claude_control_response_id(value).as_deref())
            || (kind == "system"
                && matches!(
                    value.get("subtype").and_then(Value::as_str),
                    Some(
                        "status"
                            | "task_started"
                            | "task_progress"
                            | "task_notification"
                            | "command_lifecycle"
                    )
                ))
        {
            let received = value.get("_goalport_received_ns").and_then(Value::as_u64);
            let delivery = self.receive_clock.elapsed().as_nanos() as u64;
            let buffer_class = match (self.pending_stop.as_ref(), received) {
                (Some(stop), Some(at)) if at < stop.requested_ns => {
                    "received_before_stop_delivered_after"
                }
                (Some(_), _) => "first_received_after_stop_generation_unknown",
                _ => "no_stop_at_delivery",
            };
            self.sequence += 1;
            if let Some(event) = self.envelope(
                attempt_id,
                AgentEventType::Unknown,
                json!({
                    "claude_native_frame": value, "frame_received_ns": received,
                    "frame_delivered_ns": delivery, "buffer_class": buffer_class,
                    "generation_time": "unknown", "effect_evidence": false,
                    "text": format!("Claude {kind} protocol evidence; generation time unknown")
                }),
                None,
            ) {
                retained.push(event);
            }
        }
        let mapped = self.map_frame(attempt_id, value);
        if kind == "assistant"
            && self
                .pending_stop
                .as_ref()
                .is_some_and(|s| s.terminal_emitted)
        {
            if let Some(message) = self.flush_assistant_text(attempt_id) {
                self.pending_out.push(message);
            }
        }
        let mut events = std::mem::take(&mut self.pending_out);
        retained.append(&mut events);
        if let Some(event) = mapped {
            retained.push(event);
        }
        retained
    }

    fn absorb_assistant_text(&mut self, piece: &str) {
        let piece = piece.trim();
        if piece.is_empty() {
            return;
        }
        if self.assistant_text.is_empty() {
            self.assistant_text = piece.to_owned();
        } else if piece.starts_with(&self.assistant_text) {
            self.assistant_text = piece.to_owned();
        } else if piece != self.assistant_text {
            self.assistant_text.push_str(piece);
        }
    }

    fn flush_assistant_text(&mut self, attempt_id: &str) -> Option<AgentEventEnvelope> {
        let text = std::mem::take(&mut self.assistant_text);
        let text = text.trim();
        if text.is_empty() {
            return None;
        }
        if text == self.last_emitted_assistant {
            return None;
        }
        self.last_emitted_assistant = text.to_owned();
        self.sequence += 1;
        self.envelope(
            attempt_id,
            AgentEventType::MessageDelta,
            json!({ "text": bounded_text(text) }),
            None,
        )
    }

    fn map_frame(&mut self, attempt_id: &str, value: &Value) -> Option<AgentEventEnvelope> {
        let frame_type = value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if frame_type == "stream_event" {
            return None;
        }
        self.note_post_stop_activity(frame_type, value);
        if frame_type == CLAUDE_PERMISSION_RESPONSE_TYPE {
            let request_id = value.get("request_id").and_then(Value::as_str)?.to_owned();
            if !self.answered_permissions.insert(request_id.clone()) {
                return None;
            }
            self.sequence += 1;
            return self.envelope(
                attempt_id,
                AgentEventType::PermissionResponse,
                json!({
                    "request_id": request_id,
                    "kind": "native-permission",
                    "option_kind": value.get("option_kind").and_then(Value::as_str).unwrap_or("unknown"),
                    "allow": value.get("allow").and_then(Value::as_bool).unwrap_or(false),
                    "cancelled": value.get("cancelled").and_then(Value::as_bool).unwrap_or(false)
                }),
                Some(format!("claude-ref:{}", sha256_hex(request_id.as_bytes()))),
            );
        }
        if frame_type == "control_response" {
            self.latch_interrupt_receipt(value);
            return self.try_confirm_native_stop(attempt_id);
        }
        if frame_type == "system" && value.get("subtype").and_then(Value::as_str) == Some("init") {
            if let Some(caps) = value.get("capabilities").and_then(Value::as_array) {
                self.claude_capabilities = caps
                    .iter()
                    .filter_map(|cap| cap.as_str().map(str::to_owned))
                    .collect();
            }
            let Some(session_id) = value.get("session_id").and_then(Value::as_str) else {
                return None;
            };
            if session_id.trim().is_empty() || session_id.starts_with("claude-session-") {
                return None;
            }
            self.bind_session(session_id);
            if self.session_created_emitted {
                return None;
            }
            self.session_created_emitted = true;
            self.sequence += 1;
            return self.envelope(
                attempt_id,
                AgentEventType::SessionCreated,
                json!({
                    "session_id": "[NATIVE_SESSION]",
                    "provider": "claude",
                    "transport": "stream-json",
                    "resumed": false,
                    "native_permission_prompts": "host-manual-stdio"
                    ,"runtime_version": value.get("claude_code_version").and_then(Value::as_str)
                }),
                None,
            );
        }
        if frame_type == "control_request" {
            if let Some(text) = self.flush_assistant_text(attempt_id) {
                self.pending_out.push(text);
            }
            let request = value.get("request")?;
            if request.get("subtype").and_then(Value::as_str) != Some("can_use_tool") {
                return None;
            }
            let native_id = value.get("request_id").and_then(Value::as_str)?.to_owned();
            let tool_name = request
                .get("tool_name")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_owned();
            let input = request.get("input").cloned().unwrap_or(Value::Null);
            let tool_use_id = request
                .get("tool_use_id")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let epoch = self
                .process_binding
                .as_ref()
                .map(|binding| {
                    binding
                        .process_epoch
                        .rsplit(':')
                        .next()
                        .unwrap_or(&binding.process_epoch)
                        .chars()
                        .take(16)
                        .collect::<String>()
                })
                .unwrap_or_else(|| "noepoch".into());
            let hash = self
                .session_hash
                .as_deref()
                .unwrap_or("unbound")
                .chars()
                .take(16)
                .collect::<String>();
            let decision_id = format!("claude-{hash}-{epoch}-{native_id}");
            self.pending_permissions.insert(
                decision_id.clone(),
                ClaudePendingPermission {
                    native_request_id: native_id,
                    tool_name: tool_name.clone(),
                    input,
                    tool_use_id,
                },
            );
            self.sequence += 1;
            return self.envelope(
                attempt_id,
                AgentEventType::PermissionRequest,
                json!({
                    "request_id": decision_id,
                    "kind": "native-permission",
                    "text": bounded_text(&tool_name),
                    "tool_kind": bounded_text(&tool_name)
                }),
                Some(format!("claude-ref:{}", sha256_hex(decision_id.as_bytes()))),
            );
        }
        if frame_type == "assistant" {
            if let Some(event) = self.map_assistant(attempt_id, value) {
                return Some(event);
            }
        }
        if frame_type == "user" {
            if let Some(event) = self.map_user_tool_result(attempt_id, value) {
                return Some(event);
            }
        }
        if frame_type == "result" {
            // Foreign, old, injected and unbound results stay in the journal but
            // cannot clear the current input or release its permissions.
            if !self.result_matches_input(value) || self.input_result_seen {
                return None;
            }
            self.input_result_seen = true;
            if let Some(stop) = self.pending_stop.as_mut() {
                stop.raw_result = Some(value.clone());
            }
            if let Some(text) = self.flush_assistant_text(attempt_id) {
                self.pending_out.push(text);
            }
            self.turn_in_flight = false;
            self.pending_permissions.clear();
            let is_error = value
                .get("is_error")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let stop_reason = value
                .get("stop_reason")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned();
            self.sequence += 1;
            if self.fail_open {
                let without_host = self.fail_open_without_host_decision;
                return self.envelope(
                    attempt_id,
                    AgentEventType::TurnFailed,
                    json!({
                        "status": "failed",
                        "fail_open": true,
                        "mutating_tool_without_host_decision": without_host,
                        "text": if without_host {
                            "mutating Claude tool ran without a host Decision"
                        } else {
                            "denied tool still changed the workspace"
                        }
                    }),
                    None,
                );
            }
            if self.unknown_effect {
                return self.envelope(
                    attempt_id,
                    AgentEventType::TurnFailed,
                    json!({
                        "status": "failed",
                        "fail_open": false,
                        "unknown_effect": true,
                        "mutating_tool_without_host_decision": false,
                        "text": "mutating Claude tool effect is unknown (no resolvable path)"
                    }),
                    None,
                );
            }
            if self
                .mutating_tools
                .values()
                .any(|record| record.decision == MutatingToolDecision::Pending)
            {
                return self.envelope(
                    attempt_id,
                    AgentEventType::TurnFailed,
                    json!({
                        "status": "failed",
                        "fail_open": false,
                        "unknown_effect": true,
                        "mutating_tool_without_host_decision": false,
                        "text": "mutating Claude tool was still pending when the turn ended"
                    }),
                    None,
                );
            }
            let result_subtype = value
                .get("subtype")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned();
            let stop_state = match self.pending_stop.as_mut() {
                None => None,
                Some(stop) if stop.terminal_emitted => Some(false),
                Some(stop) => {
                    stop.result_seen = true;
                    stop.result_stop_reason =
                        (!stop_reason.is_empty()).then(|| bounded_text(&stop_reason));
                    stop.result_subtype =
                        (!result_subtype.is_empty()).then(|| bounded_text(&result_subtype));
                    Some(true)
                }
            };
            match stop_state {
                // The Stop already reached its single terminal disposition; a
                // later result frame must not manufacture a second one.
                Some(false) => return None,
                // A is the only disposition a result frame settles by itself, and
                // it suppresses B. Every other result leaves the Stop unresolved
                // so the bounded fallback can still inspect the exact managed
                // child. `turn_in_flight` above stays truthful either way.
                Some(true) => {
                    return self.try_confirm_native_stop(attempt_id);
                }
                None => {}
            }
            if is_error {
                return self.envelope(
                    attempt_id,
                    AgentEventType::TurnFailed,
                    json!({
                        "status": "failed",
                        "stop_reason": bounded_text(&stop_reason),
                        "text": "native Claude turn failed"
                    }),
                    None,
                );
            }
            return self.envelope(
                attempt_id,
                AgentEventType::TurnCompleted,
                json!({
                    "status": "completed",
                    "stop_reason": if stop_reason.is_empty() { Value::Null } else { json!(bounded_text(&stop_reason)) }
                }),
                None,
            );
        }
        None
    }

    fn map_assistant(&mut self, attempt_id: &str, value: &Value) -> Option<AgentEventEnvelope> {
        let content = value.pointer("/message/content")?;
        if let Some(blocks) = content.as_array() {
            for block in blocks {
                if block.get("type").and_then(Value::as_str) != Some("tool_use") {
                    continue;
                }
                if let Some(text) = self.flush_assistant_text(attempt_id) {
                    self.pending_out.push(text);
                }
                let name = block
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("native-tool");
                let id = block.get("id").and_then(Value::as_str).unwrap_or_default();
                if claude_mutating_tool(name) && !id.is_empty() {
                    let input = block.get("input").cloned().unwrap_or(Value::Null);
                    self.mutating_tools.entry(id.to_owned()).or_insert_with(|| {
                        MutatingToolRecord {
                            decision: MutatingToolDecision::Pending,
                            snapshot: snapshot_tool_path(&self.workspace_root, &input),
                        }
                    });
                }
                self.sequence += 1;
                return self.envelope(
                    attempt_id,
                    AgentEventType::ToolActivity,
                    json!({
                        "tool": bounded_text(name),
                        "status": "started",
                        "kind": bounded_text(name)
                    }),
                    if id.is_empty() {
                        None
                    } else {
                        Some(format!("claude-ref:{}", sha256_hex(id.as_bytes())))
                    },
                );
            }
        }
        if let Some(text) = extract_cli_text(content) {
            self.absorb_assistant_text(&text);
        }
        None
    }

    fn map_user_tool_result(
        &mut self,
        attempt_id: &str,
        value: &Value,
    ) -> Option<AgentEventEnvelope> {
        let content = value.pointer("/message/content")?.as_array()?;
        for block in content {
            if block.get("type").and_then(Value::as_str) != Some("tool_result") {
                continue;
            }
            let tool_use_id = block
                .get("tool_use_id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            if let Some(record) = self.mutating_tools.get(&tool_use_id).cloned() {
                match record.decision {
                    MutatingToolDecision::Pending => {
                        self.fail_open = true;
                        self.fail_open_without_host_decision = true;
                        self.sequence += 1;
                        return self.envelope(
                            attempt_id,
                            AgentEventType::TurnFailed,
                            json!({
                                "status": "failed",
                                "fail_open": true,
                                "mutating_tool_without_host_decision": true,
                                "text": "mutating Claude tool ran without a host Decision"
                            }),
                            None,
                        );
                    }
                    MutatingToolDecision::Denied => match record.snapshot.as_ref() {
                        None => {
                            self.unknown_effect = true;
                            self.sequence += 1;
                            return self.envelope(
                                attempt_id,
                                AgentEventType::TurnFailed,
                                json!({
                                    "status": "failed",
                                    "fail_open": false,
                                    "unknown_effect": true,
                                    "mutating_tool_without_host_decision": false,
                                    "text": "mutating Claude tool effect is unknown (no resolvable path)"
                                }),
                                None,
                            );
                        }
                        Some(snap) if snapshot_delta(snap) => {
                            self.fail_open = true;
                            self.sequence += 1;
                            return self.envelope(
                                attempt_id,
                                AgentEventType::TurnFailed,
                                json!({
                                    "status": "failed",
                                    "fail_open": true,
                                    "mutating_tool_without_host_decision": false,
                                    "text": "denied tool still changed the workspace"
                                }),
                                None,
                            );
                        }
                        Some(_) => {}
                    },
                    MutatingToolDecision::Allowed => {}
                }
            }
            self.sequence += 1;
            return self.envelope(
                attempt_id,
                AgentEventType::ToolActivity,
                json!({
                    "tool": "tool_result",
                    "status": "completed"
                }),
                if tool_use_id.is_empty() {
                    None
                } else {
                    Some(format!("claude-ref:{}", sha256_hex(tool_use_id.as_bytes())))
                },
            );
        }
        None
    }

    fn bind_session(&mut self, session_id: &str) {
        self.session_id = Some(session_id.to_owned());
        self.session_hash = Some(sha256_hex(session_id.as_bytes()));
    }

    fn permission_response(&mut self, response: PermissionResponse) -> Result<(), AdapterError> {
        let request_id = response.request_id.trim();
        if request_id.is_empty() {
            return Err(AdapterError::InvalidRequest(
                "permission request id is empty".into(),
            ));
        }
        if self.answered_permissions.contains(request_id) {
            return Err(AdapterError::InvalidRequest(
                "duplicate permission response is rejected".into(),
            ));
        }
        let pending = self.pending_permissions.remove(request_id).ok_or_else(|| {
            AdapterError::InvalidRequest(
                "stale or mismatched permission response is rejected".into(),
            )
        })?;
        if let Some(tool_use_id) = pending.tool_use_id.as_deref()
            && claude_mutating_tool(&pending.tool_name)
        {
            let snapshot = snapshot_tool_path(&self.workspace_root, &pending.input);
            let record = self
                .mutating_tools
                .entry(tool_use_id.to_owned())
                .or_insert_with(|| MutatingToolRecord {
                    decision: MutatingToolDecision::Pending,
                    snapshot: snapshot.clone(),
                });
            if record.snapshot.is_none() {
                record.snapshot = snapshot;
            }
            record.decision = if response.allow {
                MutatingToolDecision::Allowed
            } else {
                MutatingToolDecision::Denied
            };
        }
        let native_response = if response.allow {
            json!({
                "behavior": "allow",
                "updatedInput": pending.input
            })
        } else {
            json!({
                "behavior": "deny",
                "message": "GoalPort host denied this tool"
            })
        };
        self.send_json(&json!({
            "type": "control_response",
            "response": {
                "subtype": "success",
                "request_id": pending.native_request_id,
                "response": native_response
            }
        }))?;
        self.pending_frames.push(json!({
            "type": CLAUDE_PERMISSION_RESPONSE_TYPE,
            "request_id": request_id,
            "option_kind": if response.allow { "allow_once" } else { "reject_once" },
            "allow": response.allow,
            "cancelled": false
        }));
        Ok(())
    }

    fn interrupt(&mut self) -> Result<crate::adapters::CancelResult, AdapterError> {
        // A Stop that is still unresolved owns this turn. A duplicate Safe stop
        // must not open a second Stop, restart the deadline, or add a second
        // signal, and it must not be reported as "no active turn" either.
        if self.pending_stop.is_some() {
            return Ok(crate::adapters::CancelResult {
                requested: true,
                confirmed: false,
                reason: Some(
                    "a Stop is already pending for this Claude turn; GoalPort will not send a second interrupt or a second process stop signal"
                        .into(),
                ),
            });
        }
        if !self.turn_in_flight {
            return Ok(crate::adapters::CancelResult {
                requested: false,
                confirmed: false,
                reason: Some("no active turn".into()),
            });
        }
        self.interrupt_requested = true;
        for record in self.mutating_tools.values_mut() {
            if record.decision == MutatingToolDecision::Pending {
                record.decision = MutatingToolDecision::Denied;
            }
        }
        let pending_ids = self.pending_permissions.keys().cloned().collect::<Vec<_>>();
        for decision_id in pending_ids {
            if let Some(pending) = self.pending_permissions.remove(&decision_id) {
                let _ = self.send_json(&json!({
                    "type": "control_response",
                    "response": {
                        "subtype": "success",
                        "request_id": pending.native_request_id,
                        "response": {
                            "behavior": "deny",
                            "message": "GoalPort host interrupted this turn"
                        }
                    }
                }));
                self.pending_frames.push(json!({
                    "type": CLAUDE_PERMISSION_RESPONSE_TYPE,
                    "request_id": decision_id,
                    "option_kind": "cancelled",
                    "allow": false,
                    "cancelled": true
                }));
            }
        }
        let interrupt_id = self.next_control_id();
        self.pending_interrupt_request_id = Some(interrupt_id.clone());
        self.interrupt_requested_at = Some(Instant::now());
        self.interrupt_receipt_matched = false;
        self.interrupt_still_queued = None;
        self.pending_stop = Some(self.new_stop_request(&interrupt_id));
        let request = json!({ "subtype": "interrupt" });
        match self.send_json(&json!({
            "type": "control_request",
            "request_id": interrupt_id,
            "request": request
        })) {
            Ok(()) => {
                if let Some(stop) = self.pending_stop.as_mut() {
                    stop.send_succeeded = true;
                }
                Ok(crate::adapters::CancelResult {
                    requested: true,
                    confirmed: false,
                    reason: Some(format!(
                        "interrupt control_request sent request_id={interrupt_id}; receipt wait skipped under UI mutex (bound {CLAUDE_INTERRUPT_RECEIPT_WAIT_MS} ms); A latched later only with matching receipt and confirming result"
                    )),
                })
            }
            Err(error) => {
                // Sending failed. Preserve the pending evidence and responsibility;
                // the confirmation deadline never sends a process signal.
                if let Some(stop) = self.pending_stop.as_mut() {
                    stop.reason = Some(format!(
                        "the interrupt control_request could not be written ({error})"
                    ));
                }
                Ok(crate::adapters::CancelResult {
                    requested: true,
                    confirmed: false,
                    reason: Some(format!(
                        "interrupt control_request failed ({error}); native interruption is unconfirmed and residual responsibility remains held"
                    )),
                })
            }
        }
    }

    /// Snapshot the exact managed child the user asked to stop. Everything here
    /// is re-checked at the fallback deadline; a Stop with no observable binding
    /// starts already failed closed instead of guessing a target later.
    fn new_stop_request(&self, request_id: &str) -> ClaudeStopRequest {
        let mut stop = ClaudeStopRequest {
            request_id: request_id.to_owned(),
            operation_id: self
                .stop_operation_id
                .clone()
                .unwrap_or_else(|| request_id.to_owned()),
            input_uuid: self.input_uuid.clone(),
            requested_ns: self.receive_clock.elapsed().as_nanos() as u64,
            send_succeeded: false,
            raw_receipt: None,
            raw_result: None,
            requested_at: Instant::now(),
            attempt_id: self.attempt_id.clone().unwrap_or_default(),
            session_id: self.session_id.clone(),
            turn_epoch: self.turn_epoch,
            process_epoch: String::new(),
            pid: 0,
            creation_date: String::new(),
            executable_path: String::new(),
            executable_sha256: String::new(),
            disposition: ClaudeStopDisposition::Pending,
            signal_attempted: false,
            signal_count: 0,
            signal_sent: false,
            exact_child_alive_at_deadline: None,
            post_stop_activity: false,
            result_seen: false,
            result_stop_reason: None,
            result_subtype: None,
            reason: None,
            terminal_emitted: false,
        };
        let live_pid = self.managed_pid();
        match (self.process_binding.as_ref(), live_pid) {
            (Some(binding), Some(pid)) if binding.pid == pid => {
                stop.process_epoch = binding.process_epoch.clone();
                stop.pid = binding.pid;
                stop.creation_date = binding.creation_date.clone();
                stop.executable_path = binding.executable_path.clone();
                stop.executable_sha256 = binding.executable_sha256.clone();
            }
            _ => {
                stop.disposition = ClaudeStopDisposition::Unknown;
                stop.reason = Some(
                    "the managed Claude child identity was not observable when Stop was requested"
                        .into(),
                );
            }
        }
        stop
    }

    /// Newer ownership of any kind invalidates a Stop bound to the older one.
    fn stop_ownership_mismatch(&self) -> Option<String> {
        let stop = self.pending_stop.as_ref()?;
        if stop.turn_epoch != self.turn_epoch {
            return Some(
                "a newer Claude turn took ownership of this Runtime before the Stop was resolved"
                    .into(),
            );
        }
        if self.attempt_id.as_deref() != Some(stop.attempt_id.as_str()) {
            return Some("a different Attempt now owns this Claude Runtime".into());
        }
        if self.session_id != stop.session_id {
            return Some("a different native session now owns this Claude Runtime".into());
        }
        let binding = self.process_binding.as_ref()?;
        if binding.process_epoch != stop.process_epoch
            || binding.pid != stop.pid
            || binding.creation_date != stop.creation_date
            || !binding
                .executable_sha256
                .eq_ignore_ascii_case(&stop.executable_sha256)
        {
            return Some(
                "the managed Claude process binding changed after Stop was requested".into(),
            );
        }
        None
    }

    fn stop_trace(&self) -> Value {
        let Some(stop) = self.pending_stop.as_ref() else {
            return Value::Null;
        };
        json!({
            "bound_attempt_id": stop.attempt_id,
            "operation_id": stop.operation_id,
            "input_uuid": stop.input_uuid,
            "requested_ns": stop.requested_ns,
            "send_succeeded": stop.send_succeeded,
            "native_receipt": stop.raw_receipt,
            "native_result": stop.raw_result,
            "bound_session_hash": stop.session_id.as_deref().map(|id| sha256_hex(id.as_bytes())),
            "bound_turn_epoch": stop.turn_epoch,
            "bound_process_epoch": stop.process_epoch,
            "bound_pid": stop.pid,
            "bound_creation_date": stop.creation_date,
            "bound_executable_sha256": stop.executable_sha256,
            "interrupt_request_id": stop.request_id,
            "disposition": stop.disposition.as_str(),
            "signal_attempted": stop.signal_attempted,
            "signal_count": stop.signal_count,
            "signal_sent": stop.signal_sent,
            "exact_child_alive_at_deadline": stop.exact_child_alive_at_deadline,
            "legacy_post_signal_frame_activity": stop.post_stop_activity,
            "result_seen": stop.result_seen,
            "confirmation_deadline_ms": CLAUDE_SIGINT_FALLBACK_MS,
            "process_fallback_enabled": false,
            "reason": stop.reason,
            "broker": self.broker_trace()
        })
    }

    /// Console-topology evidence for this Stop. Null on the direct launch, so
    /// every existing consoleless artifact keeps its exact shape.
    fn broker_trace(&self) -> Value {
        let Some(broker) = self.broker.as_ref() else {
            return Value::Null;
        };
        json!({
            "protocol": claude_stop_broker::BROKER_PROTOCOL,
            "broker_pid": broker.broker_pid(),
            "nonce_sha256": sha256_hex(broker.nonce().as_bytes()),
            "launch": broker.launch_report(),
            "delivery": self.broker_delivery,
            "effect": self.broker_effect,
            "frames": broker.frames(),
        })
    }

    /// Give the unresolved Stop its single terminal disposition and the one
    /// event that reports it. Any assistant text still buffered by the stopped
    /// turn is flushed first so it is not lost behind the terminal.
    fn resolve_stop(
        &mut self,
        attempt_id: &str,
        disposition: ClaudeStopDisposition,
        reason: Option<String>,
    ) -> Vec<AgentEventEnvelope> {
        {
            let Some(stop) = self.pending_stop.as_mut() else {
                return Vec::new();
            };
            if stop.terminal_emitted {
                return Vec::new();
            }
            stop.disposition = disposition;
            if reason.is_some() {
                stop.reason = reason;
            }
            stop.terminal_emitted = true;
        }
        let mut events = Vec::new();
        if let Some(text) = self.flush_assistant_text(attempt_id) {
            events.push(text);
        }
        // The stopped turn is over under every disposition.
        self.turn_in_flight = false;
        self.pending_permissions.clear();
        let trace = self.stop_trace();
        let Some(stop) = self.pending_stop.as_ref() else {
            return events;
        };
        let reason_text = stop
            .reason
            .clone()
            .unwrap_or_else(|| "no reason recorded".into());
        let stop_reason = stop
            .result_stop_reason
            .clone()
            .map_or(Value::Null, Value::String);
        let result_subtype = stop
            .result_subtype
            .clone()
            .map_or(Value::Null, Value::String);
        let (event_type, mut payload) = match disposition {
            ClaudeStopDisposition::NativeTurnCancel => (
                AgentEventType::Cancelled,
                json!({
                    "status": "cancelled",
                    "native_turn_cancel": true,
                    "safe_process_stop": false,
                    "stopKind": "native_turn_cancel",
                    "text": "Current Claude turn interrupted; residual tool execution is unconfirmed. Write responsibility remains held."
                }),
            ),
            // Fail closed. Never A, never B, and never silently successful.
            ClaudeStopDisposition::Unknown | ClaudeStopDisposition::Pending => (
                AgentEventType::TurnFailed,
                json!({
                    "status": "failed",
                    "native_turn_cancel": false,
                    "safe_process_stop": false,
                    "unverified": true,
                    "stopKind": "unverified",
                    "text": bounded_text(&format!("Claude stop unverified: {reason_text}"))
                }),
            ),
        };
        if let Some(object) = payload.as_object_mut() {
            object.insert("stop_operation_id".into(), json!(stop.operation_id));
            object.insert("input_uuid".into(), json!(stop.input_uuid));
            object.insert("session_id".into(), json!(stop.session_id));
            object.insert("turn_epoch".into(), json!(stop.turn_epoch));
            object.insert("process_epoch".into(), json!(stop.process_epoch));
            object.insert(
                "native_turn_state".into(),
                json!(if disposition == ClaudeStopDisposition::NativeTurnCancel {
                    "interrupted"
                } else {
                    "unconfirmed"
                }),
            );
            object.insert("residual_execution_state".into(), json!("unknown"));
            object.insert("write_responsibility".into(), json!("held"));
            object.insert("safe_process_stop".into(), json!(false));
            object.insert("stop_reason".into(), stop_reason);
            object.insert("result_subtype".into(), result_subtype);
            object.insert("stop_attempt".into(), trace);
        }
        let payload = self.with_interrupt_trace(payload);
        self.sequence += 1;
        if let Some(event) = self.envelope(attempt_id, event_type, payload, None) {
            events.push(event);
        }
        events
    }

    /// `resolve_stop` for callers that return a single mapped event; anything
    /// flushed alongside the terminal is queued rather than dropped.
    fn emit_stop_terminal(
        &mut self,
        attempt_id: &str,
        disposition: ClaudeStopDisposition,
        reason: Option<String>,
    ) -> Option<AgentEventEnvelope> {
        let mut events = self.resolve_stop(attempt_id, disposition, reason);
        let terminal = events.pop();
        self.pending_out.extend(events);
        terminal
    }

    /// Drive the unresolved Stop toward exactly one terminal disposition.
    ///
    /// Order matters: every fail-closed branch is checked before the one branch
    /// that can conclude B.
    fn drive_pending_stop(&mut self, attempt_id: &str) -> Vec<AgentEventEnvelope> {
        let Some(stop) = self.pending_stop.as_ref() else {
            return Vec::new();
        };
        if !stop.unresolved() {
            return Vec::new();
        }
        if stop.attempt_id != attempt_id {
            return self.resolve_stop(
                attempt_id,
                ClaudeStopDisposition::Unknown,
                Some("Stop was polled under a foreign Attempt".into()),
            );
        }
        if let Some(reason) = self.stop_ownership_mismatch() {
            return self.resolve_stop(attempt_id, ClaudeStopDisposition::Unknown, Some(reason));
        }
        if let Some(event) = self.try_confirm_native_stop(attempt_id) {
            let mut out = std::mem::take(&mut self.pending_out);
            out.push(event);
            return out;
        }
        let stop = self.pending_stop.as_ref().expect("pending Stop");
        if stop.disposition != ClaudeStopDisposition::Pending
            || self.stream_closed
            || self.child_ended.load(Ordering::SeqCst)
            || stop.requested_at.elapsed() >= Duration::from_millis(CLAUDE_SIGINT_FALLBACK_MS)
        {
            return self.resolve_stop(attempt_id, ClaudeStopDisposition::Unknown,
                Some("Native turn interruption unconfirmed; residual execution unknown and write responsibility held. No process-stop fallback was used.".into()));
        }
        Vec::new()
    }

    fn result_matches_input(&self, value: &Value) -> bool {
        let Some(input) = self.input_uuid.as_deref() else {
            return false;
        };
        let Some(session) = self.session_id.as_deref() else {
            return false;
        };
        let origin_ok = match value.get("origin") {
            None | Some(Value::Null) => true,
            Some(origin) => origin.get("kind").and_then(Value::as_str) == Some("human"),
        };
        value.get("type").and_then(Value::as_str) == Some("result")
            && value.get("user_message_uuid").and_then(Value::as_str) == Some(input)
            && value.get("user_message_uuids") == Some(&json!([input]))
            && value.get("session_id").and_then(Value::as_str) == Some(session)
            && value
                .get("uuid")
                .and_then(Value::as_str)
                .is_some_and(|id| !id.is_empty())
            && origin_ok
    }

    fn try_confirm_native_stop(&mut self, attempt_id: &str) -> Option<AgentEventEnvelope> {
        let stop = self.pending_stop.as_ref()?;
        if stop.terminal_emitted
            || stop.attempt_id != attempt_id
            || stop.input_uuid.is_none()
            || stop.input_uuid != self.input_uuid
            || self.stop_ownership_mismatch().is_some()
            || self.process_binding.is_none()
            || !stop.send_succeeded
            || !self.interrupt_receipt_matched
            || self.used_sigint
            || stop.signal_attempted
        {
            return None;
        }
        let result = stop.raw_result.as_ref()?;
        let receipt = stop.raw_receipt.as_ref()?;
        if !self.result_matches_input(result)
            || !claude_result_confirms_interrupt(result, "")
            || result
                .get("_goalport_received_ns")
                .and_then(Value::as_u64)?
                < stop.requested_ns
            || receipt
                .get("_goalport_received_ns")
                .and_then(Value::as_u64)?
                < stop.requested_ns
        {
            return None;
        }
        self.emit_stop_terminal(attempt_id, ClaudeStopDisposition::NativeTurnCancel,
            Some("Exact input/session result and native interrupt receipt match the durable Stop operation; residual effects remain unconfirmed".into()))
    }

    fn note_post_stop_activity(&mut self, frame_type: &str, value: &Value) {
        let watching = self
            .pending_stop
            .as_ref()
            .is_some_and(|stop| stop.signal_sent && stop.unresolved());
        if !watching {
            return;
        }
        let block_is = |kind: &str| {
            value
                .pointer("/message/content")
                .and_then(Value::as_array)
                .is_some_and(|blocks| {
                    blocks
                        .iter()
                        .any(|block| block.get("type").and_then(Value::as_str) == Some(kind))
                })
        };
        let activity = match frame_type {
            "assistant" => block_is("tool_use"),
            "user" => block_is("tool_result"),
            "control_request" => {
                value.pointer("/request/subtype").and_then(Value::as_str) == Some("can_use_tool")
            }
            _ => false,
        };
        if activity && let Some(stop) = self.pending_stop.as_mut() {
            stop.post_stop_activity = true;
        }
    }

    fn latch_interrupt_receipt(&mut self, value: &Value) {
        let Some(id) = claude_control_response_id(value) else {
            return;
        };
        let Some(expected) = self.pending_interrupt_request_id.as_deref() else {
            return;
        };
        if id != expected {
            return;
        }
        if value.pointer("/response/subtype").and_then(Value::as_str) != Some("success")
            || value.pointer("/response/response/still_queued") != Some(&json!([]))
        {
            return;
        }
        if let Some(stop) = self.pending_stop.as_mut() {
            if stop.raw_receipt.is_none() {
                stop.raw_receipt = Some(value.clone());
            }
        }
        self.interrupt_receipt_matched = true;
        if let Some(queued) = value
            .pointer("/response/response/still_queued")
            .and_then(Value::as_array)
        {
            self.interrupt_still_queued = Some(
                queued
                    .iter()
                    .filter_map(|item| item.as_str().map(str::to_owned))
                    .collect(),
            );
        }
    }

    fn with_interrupt_trace(&self, mut payload: Value) -> Value {
        if let Some(object) = payload.as_object_mut() {
            object.insert("used_sigint".into(), json!(self.used_sigint));
            object.insert(
                "interrupt_receipt_matched".into(),
                json!(self.interrupt_receipt_matched),
            );
            if let Some(id) = self.pending_interrupt_request_id.as_deref() {
                object.insert("interrupt_request_id".into(), json!(id));
            }
            if let Some(queued) = self.interrupt_still_queued.as_ref() {
                object.insert("still_queued".into(), json!(queued));
            }
        }
        payload
    }

    fn drop_stdio(&mut self) -> Result<(), AdapterError> {
        self.stdin.take();
        self.stdout.take();
        self.event_rx.take();
        Ok(())
    }

    fn close(&mut self) -> Result<(), AdapterError> {
        if let Some(child) = self.child.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        // Forced cleanup of the task-owned brokered tree, recorded by the broker
        // as cleanup. It is never a stop result and never becomes one.
        if let Some(broker) = self.broker.as_mut() {
            broker.shutdown();
        }
        self.child = None;
        self.broker = None;
        self.stdin = None;
        self.stdout = None;
        Ok(())
    }

    fn next_control_id(&mut self) -> String {
        let id = format!("goalport-ctrl-{}", self.next_control);
        self.next_control += 1;
        id
    }

    fn send_json(&mut self, value: &Value) -> Result<(), AdapterError> {
        let stdin = self
            .stdin
            .as_mut()
            .ok_or_else(|| AdapterError::Connection("Claude stdin is closed".into()))?;
        let mut stdin = stdin
            .lock()
            .map_err(|_| AdapterError::Connection("Claude stdin lock is poisoned".into()))?;
        serde_json::to_writer(&mut *stdin, value)?;
        stdin.write_all(b"\n")?;
        stdin.flush()?;
        Ok(())
    }

    fn await_control_response(
        &mut self,
        request_id: &str,
        timeout_ms: u64,
    ) -> Result<Value, AdapterError> {
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        loop {
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                return Err(AdapterError::Connection(format!(
                    "Claude initialize did not answer within {timeout_ms} ms"
                )));
            };
            let message = {
                let receiver = self.event_rx.as_ref().ok_or_else(|| {
                    AdapterError::Connection("Claude reader is not active".into())
                })?;
                receiver.recv_timeout(remaining)
            };
            match message {
                Ok(NativeMessage::Json(value)) => {
                    if claude_control_response_id(&value).as_deref() == Some(request_id) {
                        return Ok(value);
                    }
                    self.pending_frames.push(value);
                }
                Ok(NativeMessage::Closed) | Err(RecvTimeoutError::Disconnected) => {
                    self.stream_closed = true;
                    return Err(AdapterError::Connection(
                        "native Runtime closed the Claude stream".into(),
                    ));
                }
                Err(RecvTimeoutError::Timeout) => {
                    return Err(AdapterError::Connection(format!(
                        "Claude initialize did not answer within {timeout_ms} ms"
                    )));
                }
            }
        }
    }

    fn start_reader(&mut self) -> Result<(), AdapterError> {
        if self.event_rx.is_some() {
            return Ok(());
        }
        let mut stdout = self
            .stdout
            .take()
            .ok_or_else(|| AdapterError::Connection("Claude stdout is closed".into()))?;
        let receive_clock = self.receive_clock;
        let child_ended = Arc::clone(&self.child_ended);
        let (event_tx, event_rx) = mpsc::channel();
        std::thread::Builder::new()
            .name("goalport-claude-reader".into())
            .spawn(move || {
                loop {
                    let mut line = String::new();
                    match stdout.read_line(&mut line) {
                        Ok(0) => {
                            child_ended.store(true, Ordering::SeqCst);
                            let _ = event_tx.send(NativeMessage::Closed);
                            break;
                        }
                        Ok(size) if size > MAX_NATIVE_LINE_BYTES => {
                            child_ended.store(true, Ordering::SeqCst);
                            let _ = event_tx.send(NativeMessage::Closed);
                            break;
                        }
                        Ok(_) => {}
                        Err(_) => {
                            child_ended.store(true, Ordering::SeqCst);
                            let _ = event_tx.send(NativeMessage::Closed);
                            break;
                        }
                    }
                    let Ok(mut value) = serde_json::from_str::<Value>(line.trim_end()) else {
                        continue;
                    };
                    value["_goalport_received_ns"] =
                        json!(receive_clock.elapsed().as_nanos() as u64);
                    value["_goalport_received_at"] = json!(now());
                    if event_tx.send(NativeMessage::Json(value)).is_err() {
                        break;
                    }
                }
            })
            .map_err(|error| {
                AdapterError::Connection(format!("unable to start the Claude reader: {error}"))
            })?;
        self.event_rx = Some(event_rx);
        Ok(())
    }

    fn envelope(
        &self,
        attempt_id: &str,
        event_type: AgentEventType,
        mut payload: Value,
        provider_reference: Option<String>,
    ) -> Option<AgentEventEnvelope> {
        if let Some(object) = payload.as_object_mut() {
            if let Some(hash) = self.session_hash.as_deref() {
                object.insert("native_session_hash".into(), Value::String(hash.into()));
            }
            if let Some(reference) = provider_reference.as_deref() {
                object.insert(
                    "provider_event_hash".into(),
                    Value::String(reference.into()),
                );
            }
        }
        Some(AgentEventEnvelope {
            event_id: format!("claude-event-{}", self.sequence),
            campaign_id: self.campaign_id.clone(),
            task_id: self.task_id.clone().unwrap_or_default(),
            attempt_id: attempt_id.into(),
            process_epoch_id: self.process_binding.as_ref()?.process_epoch.clone(),
            sequence: self.sequence,
            occurred_at: now(),
            received_at: now(),
            provider_event_reference: provider_reference,
            event_type,
            payload,
        })
    }
}

impl Drop for ClaudeStreamProcess {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

fn claude_mutating_tool(name: &str) -> bool {
    matches!(name, "Edit" | "Write" | "Bash" | "NotebookEdit")
}

fn claude_tool_path(workspace: &Path, input: &Value) -> Option<PathBuf> {
    let raw = input
        .get("file_path")
        .or_else(|| input.get("path"))
        .or_else(|| input.get("notebook_path"))
        .and_then(Value::as_str)?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let path = Path::new(trimmed);
    Some(if path.is_absolute() {
        path.to_path_buf()
    } else {
        workspace.join(path)
    })
}

fn snapshot_tool_path(workspace: &Path, input: &Value) -> Option<PathSnapshot> {
    let path = claude_tool_path(workspace, input)?;
    let exists = path.exists();
    let sha256 = if exists {
        fs::read(&path).ok().map(|bytes| sha256_hex(&bytes))
    } else {
        None
    };
    let mtime = fs::metadata(&path)
        .ok()
        .and_then(|meta| meta.modified().ok());
    Some(PathSnapshot {
        path,
        exists,
        sha256,
        mtime,
    })
}

fn snapshot_delta(baseline: &PathSnapshot) -> bool {
    let exists = baseline.path.exists();
    if exists != baseline.exists {
        return true;
    }
    if !exists {
        return false;
    }
    let sha256 = fs::read(&baseline.path)
        .ok()
        .map(|bytes| sha256_hex(&bytes));
    if sha256 != baseline.sha256 {
        return true;
    }
    let mtime = fs::metadata(&baseline.path)
        .ok()
        .and_then(|meta| meta.modified().ok());
    mtime != baseline.mtime
}

fn claude_control_response_id(value: &Value) -> Option<String> {
    if value.get("type").and_then(Value::as_str) != Some("control_response") {
        return None;
    }
    value
        .pointer("/response/request_id")
        .and_then(Value::as_str)
        .or_else(|| value.get("request_id").and_then(Value::as_str))
        .map(str::to_owned)
}

fn claude_result_confirms_interrupt(value: &Value, _stop_reason: &str) -> bool {
    // This is only the terminal shape predicate, NOT cancellation proof.
    matches!(
        value.get("terminal_reason").and_then(Value::as_str),
        Some("aborted_tools" | "aborted_streaming")
    ) && value.get("subtype").and_then(Value::as_str) == Some("error_during_execution")
        && value.get("is_error").and_then(Value::as_bool) == Some(true)
        && value.get("permission_denials") == Some(&json!([]))
        && value.get("api_error_status").is_none_or(Value::is_null)
}

trait BoundedReadLine {
    fn read_line_bounded(&mut self) -> Result<String, AdapterError>;
}

impl BoundedReadLine for BufReader<ChildStdout> {
    fn read_line_bounded(&mut self) -> Result<String, AdapterError> {
        let mut line = String::new();
        let size = self.read_line(&mut line)?;
        if size > MAX_NATIVE_LINE_BYTES {
            return Err(AdapterError::Protocol(
                "native Runtime event exceeds bound".into(),
            ));
        }
        Ok(line)
    }
}

fn normalized_codex_payload(method: &str, value: &Value) -> Option<Value> {
    let lower = method.to_ascii_lowercase();
    // These notifications describe the provider's own diagnostics and can
    // contain account metadata, MCP names, global hook paths or rate limits.
    // They are deliberately kept out of the GoalPort event journal.
    if lower.starts_with("mcpserver/")
        || lower.starts_with("account/")
        || lower.starts_with("remotecontrol/")
        || lower.starts_with("hook/")
        || lower.starts_with("thread/tokenusage/")
        || lower == "thread/status/changed"
    {
        return None;
    }
    let params = value.get("params").unwrap_or(&Value::Null);
    if lower.contains("agentmessage") && lower.contains("delta") {
        let text = params
            .get("delta")
            .and_then(Value::as_str)
            .unwrap_or_default();
        return Some(json!({ "text": bounded_text(text) }));
    }
    if lower.contains("agentmessage") && lower.contains("completed") {
        let text = params
            .get("item")
            .and_then(|item| item.get("text"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        return Some(json!({ "text": bounded_text(text), "status": "completed" }));
    }
    if lower.contains("item/started") || lower.contains("item/completed") {
        let item = params.get("item").unwrap_or(&Value::Null);
        let item_type = item.get("type").and_then(Value::as_str).unwrap_or("item");
        if item_type.eq_ignore_ascii_case("agentMessage") {
            let text = item.get("text").and_then(Value::as_str).unwrap_or_default();
            return Some(
                json!({ "text": bounded_text(text), "status": if lower.contains("completed") { "completed" } else { "started" } }),
            );
        }
        if item_type.eq_ignore_ascii_case("userMessage") {
            return None;
        }
        if item_type.to_ascii_lowercase().contains("tool")
            || item_type.to_ascii_lowercase().contains("command")
            || item_type.to_ascii_lowercase().contains("filechange")
        {
            return Some(json!({
                "tool": bounded_text(item_type),
                "status": if lower.contains("completed") { "completed" } else { "started" }
            }));
        }
        return None;
    }
    if lower.contains("turn/started") || lower.contains("turn_started") {
        return Some(json!({ "status": "running" }));
    }
    if lower.contains("turn/completed") || lower.contains("turn_completed") {
        let status = params
            .get("turn")
            .and_then(|turn| turn.get("status"))
            .and_then(Value::as_str)
            .unwrap_or("completed");
        return Some(json!({ "status": bounded_text(status) }));
    }
    if lower.contains("approval") || lower.contains("permission") {
        if value.get("id").is_none_or(Value::is_null) {
            return Some(json!({
                "status": "waiting",
                "reason": "native permission notification has no callback id"
            }));
        }
        let request_id = params
            .get("requestId")
            .or_else(|| value.get("id"))
            .or_else(|| params.get("itemId"))
            .or_else(|| params.get("approvalId"))
            .map(bounded_scalar)
            .unwrap_or_else(|| "native-permission".into());
        let command = params.get("command").and_then(|value| {
            value.as_str().map(str::to_owned).or_else(|| {
                value.as_array().map(|parts| {
                    parts
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(" ")
                })
            })
        });
        let action = command;
        return Some(
            json!({ "request_id": request_id, "kind": "native-permission", "text": action.map(|text| bounded_text(&text)) }),
        );
    }
    if lower.contains("error") || value.get("error").is_some() {
        return Some(json!({ "status": "failed", "error": "native Runtime error" }));
    }
    None
}

/// Normalize the line based stream-json envelope emitted by native CLI
/// adapters.  The CLI's assistant text is nested under `message.content` or
/// `result`; retaining the entire envelope would leak diagnostics and private
/// configuration, so only the bounded user-visible fields are projected.
fn normalized_cli_payload(method: &str, value: &Value) -> Option<Value> {
    let lower = method.to_ascii_lowercase();
    if lower.contains("rate_limit")
        || lower.contains("ratelimit")
        || lower == "system"
        || lower == "init"
        || lower == "metadata"
        || lower == "user"
    {
        return None;
    }
    if lower.contains("permission") || lower.contains("approval") {
        let request_id = extract_provider_request_id(value);
        return Some(json!({
            "status": "waiting",
            "request_id": request_id.unwrap_or_else(|| "native-permission".into()),
            "kind": "native-permission"
        }));
    }
    if lower.contains("tool") || lower.contains("command") || lower.contains("file_change") {
        let tool = extract_named_text(value, &["name", "tool_name", "toolName", "type"])
            .unwrap_or_else(|| "native-tool".into());
        return Some(json!({
            "tool": bounded_text(&tool),
            "status": if lower.contains("result") || lower.contains("complete") { "completed" } else { "started" }
        }));
    }
    if lower == "result" || lower.contains("complete") || lower == "end" {
        let text = extract_cli_text(value).unwrap_or_default();
        return Some(json!({ "text": bounded_text(&text), "status": "completed" }));
    }
    if lower.contains("assistant") || lower.contains("message") || lower.contains("text") {
        let text = extract_cli_text(value).unwrap_or_default();
        if !text.is_empty() {
            return Some(json!({ "text": bounded_text(&text) }));
        }
        return None;
    }
    if value.get("is_error").and_then(Value::as_bool) == Some(true)
        || value.get("isError").and_then(Value::as_bool) == Some(true)
        || lower.contains("error")
    {
        return Some(json!({ "status": "failed", "error": "native Runtime error" }));
    }
    None
}

fn extract_cli_text(value: &Value) -> Option<String> {
    match value {
        Value::Object(object) => {
            for key in ["text", "delta", "result", "output"] {
                if let Some(text) = object.get(key).and_then(Value::as_str) {
                    let text = text.trim();
                    if !text.is_empty() {
                        return Some(text.to_owned());
                    }
                }
            }
            for key in ["message", "content", "data"] {
                if let Some(child) = object.get(key)
                    && let Some(text) = extract_cli_text(child)
                {
                    return Some(text);
                }
            }
            None
        }
        Value::Array(values) => values.iter().find_map(extract_cli_text),
        _ => None,
    }
}

fn extract_named_text(value: &Value, keys: &[&str]) -> Option<String> {
    match value {
        Value::Object(object) => {
            for key in keys {
                if let Some(text) = object.get(*key).and_then(Value::as_str) {
                    let text = text.trim();
                    if !text.is_empty() && text.len() <= 256 {
                        return Some(text.to_owned());
                    }
                }
            }
            object
                .values()
                .find_map(|child| extract_named_text(child, keys))
        }
        Value::Array(values) => values
            .iter()
            .find_map(|child| extract_named_text(child, keys)),
        _ => None,
    }
}

fn extract_provider_request_id(value: &Value) -> Option<String> {
    match value {
        Value::Object(object) => {
            for key in ["request_id", "requestId", "approval_id", "approvalId", "id"] {
                if let Some(value) = object.get(key) {
                    let id = bounded_scalar(value);
                    if !id.is_empty() && id != "null" {
                        return Some(id);
                    }
                }
            }
            object.values().find_map(extract_provider_request_id)
        }
        Value::Array(values) => values.iter().find_map(extract_provider_request_id),
        _ => None,
    }
}

fn bounded_codex_error(error: &Value) -> String {
    let code = error
        .get("code")
        .map(|value| value.to_string())
        .unwrap_or_else(|| "unknown".into());
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("turn start rejected")
        .chars()
        .map(|character| {
            if character.is_control() && !matches!(character, '\n' | '\t') {
                ' '
            } else {
                character
            }
        })
        .take(2048)
        .collect::<String>();
    format!("code={code}; message={message}")
}

fn classify_codex_method(method: &str, value: &Value) -> AgentEventType {
    let lower = method.to_ascii_lowercase();
    if (lower.contains("approval") || lower.contains("permission"))
        && value.get("id").is_some_and(|id| !id.is_null())
    {
        return AgentEventType::PermissionRequest;
    }
    if lower.contains("approval") || lower.contains("permission") {
        return AgentEventType::Waiting;
    }
    if lower.contains("agentmessage") {
        return AgentEventType::MessageDelta;
    }
    if lower.contains("item/started") || lower.contains("item/completed") {
        let item_type = value
            .get("params")
            .and_then(|params| params.get("item"))
            .and_then(|item| item.get("type"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_ascii_lowercase();
        if item_type.contains("tool")
            || item_type.contains("command")
            || item_type.contains("filechange")
        {
            return AgentEventType::ToolActivity;
        }
    }
    if lower.contains("commandexecution") || lower.contains("tool") || lower.contains("exec") {
        return AgentEventType::ToolActivity;
    }
    if lower.contains("turn/started") || lower.contains("turn_started") {
        return AgentEventType::TurnStarted;
    }
    if lower.contains("turn/completed") || lower.contains("turn_completed") {
        let status = value
            .get("params")
            .and_then(|params| params.get("turn"))
            .and_then(|turn| turn.get("status"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_ascii_lowercase();
        if status.contains("interrupt") || status.contains("cancel") {
            return AgentEventType::Cancelled;
        }
        return AgentEventType::TurnCompleted;
    }
    if lower.contains("turn/failed") || lower.contains("error") {
        return AgentEventType::TurnFailed;
    }
    if lower.contains("interrupt") || lower.contains("cancel") {
        return AgentEventType::Cancelled;
    }
    if value.get("params").and_then(|p| p.get("reason")).is_some() {
        return AgentEventType::Waiting;
    }
    AgentEventType::Unknown
}

fn classify_cli_event(method: &str, value: &Value) -> AgentEventType {
    let lower = method.to_ascii_lowercase();
    if lower.contains("assistant") || lower.contains("message") {
        AgentEventType::MessageDelta
    } else if lower.contains("tool") || lower.contains("command") {
        AgentEventType::ToolActivity
    } else if lower == "result" || lower.contains("complete") || lower == "end" {
        AgentEventType::TurnCompleted
    } else if lower.contains("permission") || lower.contains("approval") {
        AgentEventType::PermissionRequest
    } else if value.get("is_error").and_then(Value::as_bool) == Some(true) {
        AgentEventType::TurnFailed
    } else {
        AgentEventType::Unknown
    }
}

/// Extract only provider session/thread identifiers from a native structured
/// frame.  The native CLI formats differ (`session_id` vs `threadId`) and may
/// nest the identity under an event/result object.  We deliberately recurse
/// through JSON values instead of retaining the complete native frame; the
/// caller stores only this bounded opaque identifier.
fn extract_provider_session_id(value: &Value) -> Option<String> {
    const SESSION_KEYS: [&str; 4] = ["session_id", "sessionId", "thread_id", "threadId"];
    match value {
        Value::Object(object) => {
            for key in SESSION_KEYS {
                if let Some(candidate) = object.get(key).and_then(Value::as_str) {
                    let candidate = candidate.trim();
                    if !candidate.is_empty() && candidate.len() <= 256 {
                        return Some(candidate.to_owned());
                    }
                }
            }
            object.values().find_map(extract_provider_session_id)
        }
        Value::Array(values) => values.iter().find_map(extract_provider_session_id),
        _ => None,
    }
}

#[allow(dead_code)]
fn sanitize_provider_payload(value: &Value) -> Value {
    match value {
        Value::Object(object) => {
            let mut output = serde_json::Map::new();
            for (key, value) in object {
                let lower = key.to_ascii_lowercase();
                if lower.contains("token")
                    || lower.contains("secret")
                    || lower.contains("password")
                    || lower.contains("email")
                    || lower.contains("account")
                    || lower.contains("ratelimit")
                    || lower.contains("sourcepath")
                    || lower == "cwd"
                    || lower == "path"
                    || lower == "home"
                    || lower.contains("installation")
                {
                    continue;
                }
                if is_safe_payload_key(&lower) {
                    output.insert(key.clone(), sanitize_provider_payload(value));
                }
            }
            Value::Object(output)
        }
        Value::Array(values) => {
            Value::Array(values.iter().map(sanitize_provider_payload).collect())
        }
        Value::String(value) => {
            if value.len() > 8_192 {
                Value::String(format!("{}…", &value[..8_192]))
            } else {
                Value::String(value.clone())
            }
        }
        _ => value.clone(),
    }
}

#[allow(dead_code)]
fn is_safe_payload_key(key: &str) -> bool {
    matches!(
        key,
        "type"
            | "status"
            | "text"
            | "delta"
            | "tool"
            | "name"
            | "reason"
            | "provider"
            | "id"
            | "itemid"
            | "item_id"
            | "turnid"
            | "turn_id"
            | "threadid"
            | "thread_id"
            | "requestid"
            | "request_id"
            | "decision"
            | "allow"
            | "confirmed"
            | "resumable"
            | "iserror"
            | "is_error"
            | "usage"
    )
}

fn bounded_text(value: &str) -> String {
    if value.len() > 8_192 {
        format!("{}…", &value[..8_192])
    } else {
        value.to_owned()
    }
}

fn bounded_scalar(value: &Value) -> String {
    let text = value
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| value.to_string());
    if text.len() > 128 {
        format!("{}…", &text[..128])
    } else {
        text
    }
}

fn now() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis().to_string())
        .unwrap_or_else(|_| "0".into())
}

fn monotonic_id() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or_default()
}

fn debug_runtime(message: &str) {
    if std::env::var_os("GOALPORT_DEBUG").is_some() {
        eprintln!("goalport-runtime: {message}");
    }
}

fn resolve_native_executable(provider: &str) -> PathBuf {
    let candidates = match provider {
        "codex" => {
            let app_data = std::env::var_os("APPDATA").map(PathBuf::from);
            app_data
                .into_iter()
                .flat_map(|root| {
                    [
                        root.join("npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe"),
                        root.join("npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-arm64/vendor/aarch64-pc-windows-msvc/bin/codex.exe"),
                    ]
                })
                .collect::<Vec<_>>()
        }
        "claude" => std::env::var_os("USERPROFILE")
            .map(|root| PathBuf::from(root).join(".local/bin/claude.exe"))
            .into_iter()
            .collect(),
        "grok" => std::env::var_os("USERPROFILE")
            .map(|root| PathBuf::from(root).join(".grok/bin/grok.exe"))
            .into_iter()
            .collect(),
        _ => Vec::new(),
    };
    candidates
        .into_iter()
        .find(|candidate| candidate.is_file())
        .unwrap_or_else(|| PathBuf::from(provider))
}

fn native_approval_policy() -> Result<String, AdapterError> {
    match std::env::var("GOALPORT_CODEX_APPROVAL_POLICY") {
        Ok(value) if value == "untrusted" || value == "on-request" => Ok(value),
        Ok(value) => Err(AdapterError::InvalidRequest(format!(
            "GOALPORT_CODEX_APPROVAL_POLICY must be untrusted or on-request, received {value}"
        ))),
        Err(_) => Ok("on-request".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn synthetic_firewall_blocks_native_session_resume_and_send_before_spawn() {
        let workspace = PathBuf::from("Z:\\goalport-does-not-exist");
        let mut manager = RuntimeManager::with_synthetic_only(false);
        manager
            .select_runtime(
                "attempt-firewall",
                "codex",
                Some(workspace.join("codex.exe")),
                "test",
                &workspace,
            )
            .unwrap();
        assert_eq!(manager.process_started("attempt-firewall"), Some(false));
        manager.synthetic_only = true;
        let session = SessionRequest {
            campaign_id: Some("campaign-firewall".into()),
            task_id: "task-firewall".into(),
            attempt_id: "attempt-firewall".into(),
            workspace_root: workspace,
            resume_session: None,
        };
        for error in [
            manager
                .create_session("attempt-firewall", &session)
                .unwrap_err(),
            manager
                .resume_session("attempt-firewall", "native-session")
                .unwrap_err(),
            manager
                .permission_response(
                    "attempt-firewall",
                    PermissionResponse {
                        request_id: "permission-firewall".into(),
                        allow: true,
                    },
                )
                .unwrap_err(),
            manager
                .send_prompt(
                    "attempt-firewall",
                    &PromptRequest {
                        attempt_id: "attempt-firewall".into(),
                        text: "must not dispatch".into(),
                        idempotency_key: "firewall-send".into(),
                    },
                )
                .unwrap_err(),
        ] {
            assert!(error.to_string().contains("test profile permits only"));
        }
        assert_eq!(manager.process_started("attempt-firewall"), Some(false));
        assert_eq!(manager.native_pid("attempt-firewall"), None);
    }

    #[test]
    fn codex_agent_delta_is_normalized_to_visible_text() {
        let value = json!({ "method": "item/agentMessage/delta", "params": { "delta": "hello" } });
        let payload = normalized_codex_payload("item/agentMessage/delta", &value).unwrap();
        assert_eq!(payload["text"], "hello");
    }

    #[test]
    fn provider_diagnostics_and_paths_are_not_persisted() {
        let value = json!({
            "type": "account/rateLimits/updated",
            "accountId": "private-account",
            "sourcePath": "C:\\Users\\owner\\.codex\\hooks.json",
            "path": "C:\\private",
            "tokenUsage": { "totalTokens": 10 }
        });
        assert!(normalized_codex_payload("account/rateLimits/updated", &value).is_none());
        let sanitized = sanitize_provider_payload(&value);
        assert!(sanitized.get("accountId").is_none());
        assert!(sanitized.get("sourcePath").is_none());
        assert!(sanitized.get("path").is_none());
    }

    #[test]
    fn native_approval_uses_json_rpc_callback_id() {
        let value = json!({
            "id": 17,
            "method": "item/commandExecution/requestApproval",
            "params": { "itemId": "item-1", "reason": "needs workspace command" }
        });
        let payload =
            normalized_codex_payload("item/commandExecution/requestApproval", &value).unwrap();
        assert_eq!(payload["request_id"], "17");
    }

    #[test]
    fn native_event_exposes_only_hashed_provider_identifiers() {
        let mut process = CodexProcess::new(
            PathBuf::from("codex"),
            "0.151.0".into(),
            PathBuf::from("C:\\Users\\owner\\private-workspace"),
            "on-request".into(),
        );
        process.process_binding = Some(RuntimeProcessBinding {
            process_epoch: "runtime-epoch:test".into(),
            pid: 123,
            creation_date: "/Date(1788307200000)/".into(),
            executable_path: "C:\\bin\\codex.exe".into(),
            executable_sha256: "a".repeat(64),
        });
        let value = json!({
            "id": "provider-message-1",
            "method": "item/agentMessage/delta",
            "params": {
                "threadId": "private-thread",
                "turnId": "private-turn",
                "delta": "safe"
            }
        });
        let event = process
            .native_event("attempt", "item/agentMessage/delta", &value)
            .unwrap();
        assert!(event.payload.get("native_thread_id").is_none());
        assert!(event.payload.get("native_turn_id").is_none());
        assert!(event.payload["native_thread_hash"].as_str().is_some());
        assert!(event.payload["native_turn_hash"].as_str().is_some());
        assert!(event.payload["provider_event_hash"].as_str().is_some());
        assert!(!event.process_epoch_id.contains("Users"));
        assert!(!event.process_epoch_id.contains("private-workspace"));
    }

    /// A Claude process with a bound, already-past-deadline Stop and no live
    /// child handle. Every fail-closed branch under test is reached before the
    /// child is consulted, so these cases need no spawn.
    fn claude_with_bound_stop() -> ClaudeStreamProcess {
        let mut process = ClaudeStreamProcess::new(
            PathBuf::from("claude"),
            "2.1.260".into(),
            PathBuf::from("C:\\Users\\owner\\private-workspace"),
        );
        process.attempt_id = Some("attempt-stop".into());
        process.session_id = Some("session-stop".into());
        process.turn_epoch = 4;
        process.interrupt_requested = true;
        process.interrupt_receipt_matched = true;
        process.process_binding = Some(RuntimeProcessBinding {
            process_epoch: "runtime-epoch:stop".into(),
            pid: 4242,
            creation_date: "/Date(1788307200000)/".into(),
            executable_path: "C:\\bin\\claude.exe".into(),
            executable_sha256: "b".repeat(64),
        });
        let binding = process.process_binding.clone().expect("binding");
        process.pending_stop = Some(ClaudeStopRequest {
            request_id: "goalport-ctrl-9".into(),
            operation_id: "stop-test-operation".into(),
            input_uuid: None,
            requested_ns: 0,
            send_succeeded: true,
            raw_receipt: None,
            raw_result: None,
            requested_at: Instant::now()
                .checked_sub(Duration::from_millis(CLAUDE_SIGINT_FALLBACK_MS + 1_000))
                .unwrap_or_else(Instant::now),
            attempt_id: "attempt-stop".into(),
            session_id: Some("session-stop".into()),
            turn_epoch: 4,
            process_epoch: binding.process_epoch,
            pid: binding.pid,
            creation_date: binding.creation_date,
            executable_path: binding.executable_path,
            executable_sha256: binding.executable_sha256,
            disposition: ClaudeStopDisposition::Pending,
            signal_attempted: false,
            signal_count: 0,
            signal_sent: false,
            exact_child_alive_at_deadline: None,
            post_stop_activity: false,
            result_seen: true,
            result_stop_reason: Some("tool_use".into()),
            result_subtype: Some("error_during_execution".into()),
            reason: None,
            terminal_emitted: false,
        });
        process
    }

    fn drive_once(process: &mut ClaudeStreamProcess) -> Value {
        let events = process.drive_pending_stop("attempt-stop");
        let terminal = events
            .last()
            .unwrap_or_else(|| panic!("an unresolved Stop must reach a terminal disposition"));
        terminal.payload.clone()
    }

    fn assert_not_a_and_not_b(payload: &Value) {
        assert_eq!(payload["native_turn_cancel"], json!(false), "{payload}");
        assert_eq!(payload["safe_process_stop"], json!(false), "{payload}");
    }

    #[test]
    fn stop_rejects_a_newer_turn_taking_ownership() {
        let mut process = claude_with_bound_stop();
        process.turn_epoch = 5;
        let payload = drive_once(&mut process);
        assert_eq!(payload["stopKind"], json!("unverified"));
        assert_not_a_and_not_b(&payload);
        assert_eq!(payload["stop_attempt"]["signal_attempted"], json!(false));
        assert!(
            payload["text"]
                .as_str()
                .unwrap_or_default()
                .contains("newer Claude turn"),
            "{payload}"
        );
    }

    #[test]
    fn stop_rejects_a_foreign_attempt_or_session() {
        let mut process = claude_with_bound_stop();
        process.attempt_id = Some("attempt-other".into());
        let payload = drive_once(&mut process);
        assert_eq!(payload["stopKind"], json!("unverified"));
        assert_not_a_and_not_b(&payload);

        let mut process = claude_with_bound_stop();
        process.session_id = Some("session-other".into());
        let payload = drive_once(&mut process);
        assert_eq!(payload["stopKind"], json!("unverified"));
        assert_not_a_and_not_b(&payload);
        assert_eq!(payload["stop_attempt"]["signal_attempted"], json!(false));
    }

    #[test]
    fn stop_rejects_a_reused_pid_or_changed_process_identity() {
        for mutate in [
            (|binding: &mut RuntimeProcessBinding| binding.pid = 5151) as fn(&mut _),
            |binding: &mut RuntimeProcessBinding| {
                binding.creation_date = "/Date(1788307299999)/".into();
            },
            |binding: &mut RuntimeProcessBinding| binding.executable_sha256 = "c".repeat(64),
            |binding: &mut RuntimeProcessBinding| {
                binding.process_epoch = "runtime-epoch:other".into();
            },
        ] {
            let mut process = claude_with_bound_stop();
            mutate(process.process_binding.as_mut().expect("binding"));
            let payload = drive_once(&mut process);
            assert_eq!(payload["stopKind"], json!("unverified"), "{payload}");
            assert_not_a_and_not_b(&payload);
            assert_eq!(
                payload["stop_attempt"]["signal_attempted"],
                json!(false),
                "a mismatched binding must be rejected before any signal: {payload}"
            );
            assert!(!process.used_sigint);
        }
    }

    #[test]
    fn confirmed_native_cancel_suppresses_the_b_attempt() {
        let mut process = claude_with_bound_stop();
        bind_native_abort(&mut process);
        let payload = drive_once(&mut process);
        assert_eq!(payload["native_turn_cancel"], json!(true), "{payload}");
        assert_eq!(payload["safe_process_stop"], json!(false), "{payload}");
        assert_eq!(
            payload["stop_attempt"]["signal_attempted"],
            json!(false),
            "confirmed A must suppress B: {payload}"
        );
        assert!(!process.used_sigint);
    }

    fn bind_native_abort(process: &mut ClaudeStreamProcess) {
        process.input_uuid = Some("11111111-1111-8111-a111-111111111111".into());
        let stop = process.pending_stop.as_mut().unwrap();
        stop.input_uuid = process.input_uuid.clone();
        stop.raw_receipt = Some(json!({"_goalport_received_ns": 2}));
        stop.raw_result = Some(json!({"type":"result","uuid":"result-1",
            "user_message_uuid":process.input_uuid,"user_message_uuids":[process.input_uuid],
            "session_id":"session-stop","terminal_reason":"aborted_tools",
            "subtype":"error_during_execution","is_error":true,"permission_denials":[],
            "_goalport_received_ns":3}));
    }

    #[test]
    fn native_abort_requires_every_correlation_and_cause_predicate() {
        for key in [
            "uuid",
            "user_message_uuid",
            "user_message_uuids",
            "session_id",
            "terminal_reason",
            "subtype",
            "is_error",
            "permission_denials",
            "_goalport_received_ns",
        ] {
            let mut p = claude_with_bound_stop();
            bind_native_abort(&mut p);
            p.pending_stop
                .as_mut()
                .unwrap()
                .raw_result
                .as_mut()
                .unwrap()
                .as_object_mut()
                .unwrap()
                .remove(key);
            assert!(
                p.try_confirm_native_stop("attempt-stop").is_none(),
                "missing {key}"
            );
        }
        for (key, bad) in [
            ("user_message_uuid", json!("foreign")),
            ("user_message_uuids", json!(["foreign"])),
            ("session_id", json!("foreign")),
            ("origin", json!({"kind":"background_task"})),
            ("terminal_reason", json!("completed")),
            ("terminal_reason", json!("api_error")),
            ("permission_denials", json!([{"tool_use_id":"denial"}])),
            ("api_error_status", json!(404)),
        ] {
            let mut p = claude_with_bound_stop();
            bind_native_abort(&mut p);
            p.pending_stop
                .as_mut()
                .unwrap()
                .raw_result
                .as_mut()
                .unwrap()[key] = bad;
            assert!(
                p.try_confirm_native_stop("attempt-stop").is_none(),
                "bad {key}"
            );
        }
        for origin in [Value::Null, json!({"kind":"human"})] {
            let mut p = claude_with_bound_stop();
            bind_native_abort(&mut p);
            p.pending_stop
                .as_mut()
                .unwrap()
                .raw_result
                .as_mut()
                .unwrap()["origin"] = origin;
            assert!(p.try_confirm_native_stop("attempt-stop").is_some());
            assert!(
                p.try_confirm_native_stop("attempt-stop").is_none(),
                "duplicate must not resolve twice"
            );
        }
        let mut p = claude_with_bound_stop();
        bind_native_abort(&mut p);
        p.pending_stop.as_mut().unwrap().requested_ns = 10;
        assert!(
            p.try_confirm_native_stop("attempt-stop").is_none(),
            "buffered old result is not Stop cause"
        );
        let mut p = claude_with_bound_stop();
        bind_native_abort(&mut p);
        p.pending_stop.as_mut().unwrap().send_succeeded = false;
        assert!(p.try_confirm_native_stop("attempt-stop").is_none());
    }

    #[test]
    fn buffered_frame_is_retained_without_claiming_post_stop_generation() {
        let mut p = claude_with_bound_stop();
        p.pending_stop.as_mut().unwrap().requested_ns = 10;
        let value = json!({"type":"stream_event","uuid":"buffered-1","_goalport_received_ns":5,
            "event":{"type":"content_block_delta","delta":{"text":"buffered"}}});
        let events = p.take_mapped("attempt-stop", &value);
        assert_eq!(events[0].payload["claude_native_frame"], value);
        assert_eq!(
            events[0].payload["buffer_class"],
            "received_before_stop_delivered_after"
        );
        assert_eq!(events[0].payload["effect_evidence"], false);
        let lifecycle = json!({"type":"command_lifecycle","command_uuid":"bound-command","state":"cancelled","_goalport_received_ns":15});
        let events = p.take_mapped("attempt-stop", &lifecycle);
        assert_eq!(events[0].payload["claude_native_frame"], lifecycle);
        assert_eq!(
            events[0].payload["buffer_class"],
            "first_received_after_stop_generation_unknown"
        );
        assert!(
            !events
                .iter()
                .any(|e| e.event_type == AgentEventType::Cancelled)
        );
    }

    #[test]
    fn a_signal_that_was_not_delivered_is_never_b() {
        let mut process = claude_with_bound_stop();
        let stop = process.pending_stop.as_mut().expect("stop");
        stop.signal_attempted = true;
        stop.signal_count = 1;
        stop.signal_sent = false;
        let payload = drive_once(&mut process);
        assert_eq!(payload["stopKind"], json!("unverified"), "{payload}");
        assert_not_a_and_not_b(&payload);
        assert_eq!(payload["stop_attempt"]["signal_count"], json!(1));
    }

    #[test]
    fn post_stop_tool_activity_is_never_b() {
        let mut process = claude_with_bound_stop();
        let stop = process.pending_stop.as_mut().expect("stop");
        stop.signal_attempted = true;
        stop.signal_count = 1;
        stop.signal_sent = true;
        stop.post_stop_activity = true;
        let payload = drive_once(&mut process);
        assert_eq!(payload["stopKind"], json!("unverified"), "{payload}");
        assert_not_a_and_not_b(&payload);
        assert!(
            payload["write_responsibility"] == "held"
                && payload["residual_execution_state"] == "unknown",
            "{payload}"
        );
    }

    #[test]
    fn post_stop_tool_frames_are_recorded_only_after_a_signal() {
        let tool_use = json!({
            "type": "assistant",
            "message": { "role": "assistant", "content": [{ "type": "tool_use", "id": "t1", "name": "Bash", "input": {} }] }
        });
        let mut process = claude_with_bound_stop();
        process.note_post_stop_activity("assistant", &tool_use);
        assert!(
            !process
                .pending_stop
                .as_ref()
                .expect("stop")
                .post_stop_activity,
            "activity before the signal is just the turn still running"
        );
        process.pending_stop.as_mut().expect("stop").signal_sent = true;
        process.note_post_stop_activity("assistant", &tool_use);
        assert!(
            process
                .pending_stop
                .as_ref()
                .expect("stop")
                .post_stop_activity
        );
    }

    #[test]
    fn an_exited_child_is_unsupported_and_never_b() {
        let mut process = claude_with_bound_stop();
        let payload = drive_once(&mut process);
        assert_eq!(payload["stopKind"], json!("unverified"), "{payload}");
        assert_not_a_and_not_b(&payload);
        assert_eq!(payload["stop_attempt"]["signal_attempted"], json!(false));
        assert!(!process.used_sigint);
    }

    #[test]
    fn no_pending_stop_means_no_process_stop_attempt() {
        let mut process = claude_with_bound_stop();
        process.pending_stop = None;
        assert!(
            process.drive_pending_stop("attempt-stop").is_empty(),
            "without a pending Stop there is nothing to dispose and nothing to signal"
        );
        assert!(!process.used_sigint);
    }

    #[test]
    fn a_resolved_stop_is_not_disposed_twice() {
        let mut process = claude_with_bound_stop();
        let first = process.drive_pending_stop("attempt-stop");
        assert_eq!(first.len(), 1);
        assert!(
            process.drive_pending_stop("attempt-stop").is_empty(),
            "a Stop reaches exactly one terminal disposition"
        );
    }

    #[test]
    fn a_stop_polled_under_a_foreign_attempt_is_never_b() {
        let mut process = claude_with_bound_stop();
        let events = process.drive_pending_stop("attempt-someone-else");
        let payload = events.last().expect("terminal").payload.clone();
        assert_eq!(payload["stopKind"], json!("unverified"), "{payload}");
        assert_not_a_and_not_b(&payload);
    }

    #[test]
    fn interrupted_turn_completion_is_not_promoted_to_success() {
        let value = json!({
            "method": "turn/completed",
            "params": { "turn": { "status": "interrupted" } }
        });
        assert_eq!(
            classify_codex_method("turn/completed", &value),
            AgentEventType::Cancelled
        );
    }
}

/// R3 Codex turn-fact machine tests: pending start request vs acknowledged
/// native turn vs unknown delivery. These drive `CodexProcess` directly (no
/// child process) through the same `poll_events` the reader thread feeds.
#[cfg(test)]
mod codex_turn_fact_tests {
    use super::*;

    fn process_with_thread() -> CodexProcess {
        let mut process = CodexProcess::new(
            PathBuf::from("codex"),
            "0.152.0".into(),
            PathBuf::from(r"Z:\goalport-turn-facts"),
            "on-request".into(),
        );
        process.thread_id = Some("thread-1".into());
        process.attempt_id = Some("attempt-turn".into());
        process.task_id = Some("task-turn".into());
        process.campaign_id = Some("campaign-turn".into());
        let (_tx, rx) = mpsc::channel();
        process.event_rx = Some(rx);
        process
    }

    fn feed(process: &mut CodexProcess, value: Value) -> Vec<AgentEventEnvelope> {
        let (tx, rx) = mpsc::channel();
        tx.send(NativeMessage::Json(value)).unwrap();
        drop(tx);
        process.event_rx = Some(rx);
        process.poll_events("attempt-turn").unwrap()
    }

    #[test]
    fn idle_session_has_no_turn_and_is_not_stoppable() {
        let mut manager = RuntimeManager::new();
        manager
            .select_runtime(
                "attempt-idle",
                "codex",
                Some(PathBuf::from(r"Z:\codex.exe")),
                "test",
                &PathBuf::from(r"Z:\goalport-turn-facts"),
            )
            .unwrap();
        let facts = manager.turn_facts("attempt-idle").unwrap();
        assert!(!facts.in_flight);
        assert!(!facts.stoppable);
        assert!(!facts.delivery_unknown);
    }

    #[test]
    fn pending_start_is_in_flight_but_not_stoppable() {
        let mut process = process_with_thread();
        process.pending_start_request_id = Some(7);
        assert!(process.turn_in_flight());
        assert!(!process.acknowledged_turn_in_flight());
        // A pending start with no ack has no interrupt target: the generated
        // request id is never a native turn.
        assert!(process.native_turn_id.is_none());
    }

    #[test]
    fn matching_response_acknowledges_the_native_turn() {
        let mut process = process_with_thread();
        process.pending_start_request_id = Some(7);
        feed(
            &mut process,
            json!({ "id": 7, "result": { "turn": { "id": "turn-provider-1" } } }),
        );
        assert_eq!(process.native_turn_id.as_deref(), Some("turn-provider-1"));
        assert!(process.pending_start_request_id.is_none());
        assert!(process.turn_in_flight());
        assert!(process.acknowledged_turn_in_flight());
    }

    #[test]
    fn stale_response_for_another_request_never_acknowledges() {
        let mut process = process_with_thread();
        process.pending_start_request_id = Some(7);
        feed(
            &mut process,
            json!({ "id": 9, "result": { "turn": { "id": "turn-stale" } } }),
        );
        assert_eq!(process.native_turn_id, None);
        assert_eq!(process.pending_start_request_id, Some(7));
    }

    #[test]
    fn unsolicited_response_with_no_pending_start_is_ignored() {
        let mut process = process_with_thread();
        feed(
            &mut process,
            json!({ "id": 9, "result": { "turn": { "id": "turn-unsolicited" } } }),
        );
        assert_eq!(process.native_turn_id, None);
    }

    #[test]
    fn correlated_started_notification_on_bound_thread_acknowledges() {
        let mut process = process_with_thread();
        process.pending_start_request_id = Some(7);
        feed(
            &mut process,
            json!({
                "method": "turn/started",
                "params": { "threadId": "thread-1", "turn": { "id": "turn-notif" } }
            }),
        );
        assert_eq!(process.native_turn_id.as_deref(), Some("turn-notif"));
    }

    #[test]
    fn notification_for_another_thread_is_ignored() {
        let mut process = process_with_thread();
        process.pending_start_request_id = Some(7);
        feed(
            &mut process,
            json!({
                "method": "item/agentMessage/delta",
                "params": { "threadId": "thread-other", "turnId": "turn-foreign", "delta": "x" }
            }),
        );
        assert_eq!(process.native_turn_id, None);
        assert_eq!(process.pending_start_request_id, Some(7));
    }

    #[test]
    fn error_response_clears_the_pending_start() {
        let mut process = process_with_thread();
        process.pending_start_request_id = Some(7);
        let events = feed(
            &mut process,
            json!({ "id": 7, "error": { "code": -1, "message": "no" } }),
        );
        assert_eq!(process.pending_start_request_id, None);
        assert_eq!(process.native_turn_id, None);
        assert!(!process.turn_in_flight());
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, AgentEventType::TurnFailed);
        assert_eq!(
            events[0].provider_event_reference.as_deref(),
            Some("codex-turn-start-request:7")
        );
        assert_eq!(events[0].payload["turnStartRequestId"], 7);
        assert!(events[0].payload["nativeTurnId"].is_null());
    }

    #[test]
    fn terminal_clears_both_facts_and_a_late_ack_cannot_resurrect() {
        let mut process = process_with_thread();
        process.pending_start_request_id = Some(7);
        feed(
            &mut process,
            json!({ "id": 7, "result": { "turn": { "id": "turn-done" } } }),
        );
        assert!(process.acknowledged_turn_in_flight());
        feed(
            &mut process,
            json!({
                "method": "turn/completed",
                "params": { "threadId": "thread-1", "turn": { "id": "turn-done", "status": "completed" } }
            }),
        );
        assert_eq!(process.native_turn_id, None);
        assert_eq!(process.pending_start_request_id, None);
        assert!(!process.turn_in_flight());
        // A stale response for the completed turn's request arrives late: no
        // pending start exists, so it cannot resurrect the turn.
        feed(
            &mut process,
            json!({ "id": 7, "result": { "turn": { "id": "turn-done" } } }),
        );
        assert_eq!(process.native_turn_id, None);
        assert!(!process.turn_in_flight());
    }

    #[test]
    fn unknown_write_is_latched_and_never_a_ready_turn() {
        let mut process = process_with_thread();
        process.delivery_unknown = true;
        assert!(!process.turn_in_flight());
        assert!(!process.acknowledged_turn_in_flight());
        // Even a matching response cannot acknowledge a start that was never
        // confirmed written: no pending request id exists to match.
        feed(
            &mut process,
            json!({ "id": 7, "result": { "turn": { "id": "turn-ghost" } } }),
        );
        assert_eq!(process.native_turn_id, None);
        assert!(process.delivery_unknown);
    }

    #[test]
    fn closure_fails_a_pending_start_and_references_the_request_id() {
        let mut process = process_with_thread();
        process.pending_start_request_id = Some(12);
        let (tx, rx) = mpsc::channel();
        tx.send(NativeMessage::Closed).unwrap();
        drop(tx);
        process.event_rx = Some(rx);
        let events = process.poll_events("attempt-turn").unwrap();
        assert_eq!(process.pending_start_request_id, None);
        assert_eq!(process.native_turn_id, None);
        let failed = events
            .iter()
            .find(|event| event.event_type == AgentEventType::TurnFailed)
            .expect("closure fails the pending turn");
        assert_eq!(
            failed.provider_event_reference.as_deref(),
            Some("codex-turn-start-request:12")
        );
    }

    #[test]
    fn closure_fails_an_acknowledged_turn_by_its_native_id() {
        let mut process = process_with_thread();
        process.native_turn_id = Some("turn-live".into());
        let (tx, rx) = mpsc::channel();
        tx.send(NativeMessage::Closed).unwrap();
        drop(tx);
        process.event_rx = Some(rx);
        let events = process.poll_events("attempt-turn").unwrap();
        let failed = events
            .iter()
            .find(|event| event.event_type == AgentEventType::TurnFailed)
            .expect("closure fails the acknowledged turn");
        assert_eq!(
            failed.provider_event_reference.as_deref(),
            Some("codex-turn:turn-live")
        );
    }

    #[test]
    fn restart_leaves_no_turn_facts() {
        // A brand-new CodexProcess (what a Core restart would register) has no
        // turn facts at all: uncertainty on restart must come from durable
        // records, never from an invented in-flight turn.
        let process = process_with_thread();
        assert_eq!(process.pending_start_request_id, None);
        assert_eq!(process.native_turn_id, None);
        assert!(!process.delivery_unknown);
        assert!(!process.turn_in_flight());
    }
}
