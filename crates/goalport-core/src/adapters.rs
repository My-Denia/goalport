//! Versioned, structured Runtime adapters.
//!
//! The real-provider types in this module only construct protocol argv and parse
//! structured event envelopes. They never spawn a Runtime, invoke a model, or read
//! credentials. A caller must perform an explicit, separately authorized preflight
//! before attaching one to a running process.

use crate::domain::{AgentEventEnvelope, AgentEventType};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{HashSet, VecDeque},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use thiserror::Error;

pub const ADAPTER_API_VERSION: &str = "goalport.adapter.v1";
pub const MAX_EVENT_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TransportKind {
    AppServerStdio,
    AcpStdio,
    NativeCliStreamJson,
    Scenario,
}

impl std::fmt::Display for TransportKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::AppServerStdio => "app-server-stdio",
            Self::AcpStdio => "acp-stdio",
            Self::NativeCliStreamJson => "native-cli-stream-json",
            Self::Scenario => "scenario",
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeIdentity {
    pub provider: String,
    pub version: String,
    pub executable: Option<String>,
    pub transport: TransportKind,
    pub adapter_version: String,
    pub protocol_version: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CapabilitySupport {
    Supported,
    Partial,
    Unsupported,
    Unknown,
    Degraded,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CapabilitySource {
    RuntimeDeclared,
    ProtocolNegotiated,
    AdapterInferred,
    UserConfigured,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Capability {
    pub name: String,
    pub support: CapabilitySupport,
    pub semantics: String,
    pub limitations: Vec<String>,
    pub source: CapabilitySource,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CapabilitySnapshot {
    pub version: String,
    pub runtime: RuntimeIdentity,
    pub capabilities: Vec<Capability>,
    pub captured_at: String,
}

impl CapabilitySnapshot {
    pub fn support(&self, name: &str) -> CapabilitySupport {
        self.capabilities
            .iter()
            .find(|capability| capability.name == name)
            .map_or(CapabilitySupport::Unknown, |capability| capability.support)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AuthState {
    Authenticated,
    AuthRequired,
    Expired,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PreflightStatus {
    Ready,
    ReadyWithWarnings,
    AuthRequired,
    RuntimeMissing,
    VersionUntested,
    Incompatible,
    PolicyUnsatisfied,
    ConnectionFailed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CompatibilityPolicy {
    Strict,
    Compatible,
    Permissive,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreflightResult {
    pub status: PreflightStatus,
    pub identity: RuntimeIdentity,
    pub auth_state: AuthState,
    pub capabilities: CapabilitySnapshot,
    pub warnings: Vec<String>,
    pub checked_executable: bool,
    pub invoked_runtime: bool,
}

impl PreflightResult {
    pub fn is_ready(&self) -> bool {
        matches!(
            self.status,
            PreflightStatus::Ready | PreflightStatus::ReadyWithWarnings
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionRequest {
    pub campaign_id: Option<String>,
    pub task_id: String,
    pub attempt_id: String,
    pub workspace_root: PathBuf,
    pub resume_session: Option<String>,
}

impl SessionRequest {
    pub fn validate(&self) -> Result<(), AdapterError> {
        if self.task_id.trim().is_empty() || self.attempt_id.trim().is_empty() {
            return Err(AdapterError::InvalidRequest(
                "task_id and attempt_id are required".into(),
            ));
        }
        if self.workspace_root.as_os_str().is_empty() {
            return Err(AdapterError::InvalidRequest(
                "workspace_root is empty".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionHandle {
    pub session_id: String,
    pub resumed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PromptRequest {
    pub attempt_id: String,
    pub text: String,
    pub idempotency_key: String,
}

impl PromptRequest {
    pub fn validate(&self) -> Result<(), AdapterError> {
        if self.attempt_id.trim().is_empty() || self.idempotency_key.trim().is_empty() {
            return Err(AdapterError::InvalidRequest(
                "attempt_id and idempotency_key are required".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PromptAccepted {
    pub idempotency_key: String,
    pub accepted: bool,
    pub duplicate: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PermissionResponse {
    pub request_id: String,
    pub allow: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CancelResult {
    pub requested: bool,
    pub confirmed: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeProbe {
    pub identity: RuntimeIdentity,
    pub executable_present: bool,
}

#[derive(Debug, Error)]
pub enum AdapterError {
    #[error("adapter capability unsupported: {0}")]
    Unsupported(String),
    #[error("adapter protocol error: {0}")]
    Protocol(String),
    #[error("invalid adapter request: {0}")]
    InvalidRequest(String),
    #[error("runtime connection error: {0}")]
    Connection(String),
    /// A registration was requested for an attempt id that already holds a
    /// `ManagedRuntime` (registered; whether it is still live is a separate
    /// question). The boundary refuses instead of replacing: the existing Runtime,
    /// its session and any pending Stop stay exactly as they were.
    #[error("runtime registration occupied: {0}")]
    RegistrationOccupied(String),
    #[error("preflight error: {0}")]
    Preflight(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
}

/// The one provider-independent adapter boundary. It has no planning, routing,
/// retry, shell execution, or persistence methods by design.
pub trait AgentAdapter: Send {
    fn runtime_identity(&self) -> RuntimeIdentity {
        RuntimeIdentity {
            provider: "unknown".into(),
            version: "unknown".into(),
            executable: None,
            transport: TransportKind::Scenario,
            adapter_version: ADAPTER_API_VERSION.into(),
            protocol_version: "unknown".into(),
        }
    }
    fn probe(&mut self) -> Result<RuntimeProbe, AdapterError> {
        let identity = self.runtime_identity();
        Ok(RuntimeProbe {
            identity,
            executable_present: false,
        })
    }
    fn negotiate(&mut self, _requested: &[String]) -> Result<CapabilitySnapshot, AdapterError> {
        Err(AdapterError::Unsupported(
            "capability negotiation is not implemented".into(),
        ))
    }
    fn auth_state(&mut self) -> Result<AuthState, AdapterError> {
        Ok(AuthState::Unknown)
    }
    fn preflight(&mut self, _policy: CompatibilityPolicy) -> Result<PreflightResult, AdapterError> {
        Err(AdapterError::Unsupported(
            "preflight is not implemented".into(),
        ))
    }
    fn create_session(&mut self, _request: &SessionRequest) -> Result<SessionHandle, AdapterError> {
        Err(AdapterError::Unsupported(
            "create_session is not implemented".into(),
        ))
    }
    fn resume_session(&mut self, _session_id: &str) -> Result<SessionHandle, AdapterError> {
        Err(AdapterError::Unsupported(
            "resume is not implemented".into(),
        ))
    }
    fn send_prompt(&mut self, _request: &PromptRequest) -> Result<PromptAccepted, AdapterError> {
        Err(AdapterError::Unsupported(
            "send_prompt is not implemented".into(),
        ))
    }
    fn stream_events(&mut self) -> Result<Vec<AgentEventEnvelope>, AdapterError> {
        Ok(Vec::new())
    }
    fn permission_response(&mut self, _response: PermissionResponse) -> Result<(), AdapterError> {
        Err(AdapterError::Unsupported(
            "permission_response is not implemented".into(),
        ))
    }
    fn cancel_turn(&mut self, _turn_id: &str) -> Result<CancelResult, AdapterError> {
        Err(AdapterError::Unsupported(
            "cancel_turn is not implemented".into(),
        ))
    }
    fn interrupt(&mut self) -> Result<CancelResult, AdapterError> {
        Err(AdapterError::Unsupported(
            "interrupt is not implemented".into(),
        ))
    }
    fn close(&mut self) -> Result<(), AdapterError> {
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct ScenarioAdapter {
    identity: RuntimeIdentity,
    capabilities: CapabilitySnapshot,
    auth: AuthState,
    session: Option<SessionHandle>,
    events: VecDeque<AgentEventEnvelope>,
    sent_prompt_keys: HashSet<String>,
    sent_prompts: Vec<String>,
    sequence: i64,
    cancel_supported: bool,
    closed: bool,
    fail_next_send: Option<String>,
    context: Option<SessionRequest>,
}

pub type ScenarioRuntime = ScenarioAdapter;

impl ScenarioAdapter {
    pub fn new(provider: impl Into<String>) -> Self {
        let provider = provider.into();
        let identity = RuntimeIdentity {
            provider,
            version: "scenario-1".into(),
            executable: None,
            transport: TransportKind::Scenario,
            adapter_version: ADAPTER_API_VERSION.into(),
            protocol_version: "scenario.v1".into(),
        };
        let capabilities = CapabilitySnapshot {
            version: "scenario-cap-v1".into(),
            runtime: identity.clone(),
            capabilities: vec![
                capability(
                    "session",
                    CapabilitySupport::Supported,
                    "deterministic synthetic session",
                ),
                capability(
                    "stream_events",
                    CapabilitySupport::Supported,
                    "ordered in-memory events",
                ),
                capability(
                    "permission_response",
                    CapabilitySupport::Supported,
                    "records response",
                ),
                capability(
                    "resume",
                    CapabilitySupport::Supported,
                    "resumes without prompt resend",
                ),
                capability(
                    "cancel_turn",
                    CapabilitySupport::Unsupported,
                    "synthetic cancel gap by default",
                ),
            ],
            captured_at: now(),
        };
        Self {
            identity,
            capabilities,
            auth: AuthState::Authenticated,
            session: None,
            events: VecDeque::new(),
            sent_prompt_keys: HashSet::new(),
            sent_prompts: Vec::new(),
            sequence: 0,
            cancel_supported: false,
            closed: false,
            fail_next_send: None,
            context: None,
        }
    }

    pub fn with_cancel_support(mut self, supported: bool) -> Self {
        self.cancel_supported = supported;
        if let Some(capability) = self
            .capabilities
            .capabilities
            .iter_mut()
            .find(|item| item.name == "cancel_turn")
        {
            capability.support = if supported {
                CapabilitySupport::Supported
            } else {
                CapabilitySupport::Unsupported
            };
        }
        self
    }

    pub fn fail_next_send(&mut self, reason: impl Into<String>) {
        self.fail_next_send = Some(reason.into());
    }

    pub fn queue_event(&mut self, event: AgentEventEnvelope) {
        self.sequence = self.sequence.max(event.sequence);
        self.events.push_back(event);
    }

    pub fn sent_prompts(&self) -> &[String] {
        &self.sent_prompts
    }

    pub fn current_session(&self) -> Option<&SessionHandle> {
        self.session.as_ref()
    }

    pub fn preflight_result(&self) -> PreflightResult {
        PreflightResult {
            status: PreflightStatus::Ready,
            identity: self.identity.clone(),
            auth_state: self.auth,
            capabilities: self.capabilities.clone(),
            warnings: Vec::new(),
            checked_executable: false,
            invoked_runtime: false,
        }
    }

    fn next_event(&mut self, event_type: AgentEventType, payload: Value) -> AgentEventEnvelope {
        self.sequence += 1;
        let context = self.context.as_ref();
        AgentEventEnvelope {
            event_id: format!("scenario-event-{}", self.sequence),
            campaign_id: context.and_then(|item| item.campaign_id.clone()),
            task_id: context.map_or_else(String::new, |item| item.task_id.clone()),
            attempt_id: context.map_or_else(String::new, |item| item.attempt_id.clone()),
            process_epoch_id: "scenario-process-1".into(),
            sequence: self.sequence,
            occurred_at: now(),
            received_at: now(),
            provider_event_reference: None,
            event_type,
            payload,
        }
    }
}

impl AgentAdapter for ScenarioAdapter {
    fn runtime_identity(&self) -> RuntimeIdentity {
        self.identity.clone()
    }

    fn probe(&mut self) -> Result<RuntimeProbe, AdapterError> {
        Ok(RuntimeProbe {
            identity: self.identity.clone(),
            executable_present: true,
        })
    }

    fn negotiate(&mut self, _requested: &[String]) -> Result<CapabilitySnapshot, AdapterError> {
        Ok(self.capabilities.clone())
    }

    fn auth_state(&mut self) -> Result<AuthState, AdapterError> {
        Ok(self.auth)
    }

    fn preflight(&mut self, _policy: CompatibilityPolicy) -> Result<PreflightResult, AdapterError> {
        Ok(self.preflight_result())
    }

    fn create_session(&mut self, request: &SessionRequest) -> Result<SessionHandle, AdapterError> {
        request.validate()?;
        if self.closed {
            return Err(AdapterError::Connection(
                "scenario adapter is closed".into(),
            ));
        }
        let resumed = request.resume_session.is_some();
        let session_id = request
            .resume_session
            .clone()
            .unwrap_or_else(|| format!("scenario-session-{}", request.attempt_id));
        self.context = Some(request.clone());
        self.session = Some(SessionHandle {
            session_id: session_id.clone(),
            resumed,
        });
        if !resumed {
            let event = self.next_event(
                AgentEventType::SessionCreated,
                json!({ "session_id": session_id }),
            );
            self.events.push_back(event);
        }
        Ok(self.session.clone().expect("session just assigned"))
    }

    fn resume_session(&mut self, session_id: &str) -> Result<SessionHandle, AdapterError> {
        if session_id.trim().is_empty() {
            return Err(AdapterError::InvalidRequest("session id is empty".into()));
        }
        if self.context.is_none() {
            return Err(AdapterError::Connection(
                "scenario has no session context to resume".into(),
            ));
        }
        self.create_session(&SessionRequest {
            campaign_id: self
                .context
                .as_ref()
                .and_then(|item| item.campaign_id.clone()),
            task_id: self
                .context
                .as_ref()
                .map_or_else(String::new, |item| item.task_id.clone()),
            attempt_id: self
                .context
                .as_ref()
                .map_or_else(String::new, |item| item.attempt_id.clone()),
            workspace_root: self
                .context
                .as_ref()
                .map_or_else(PathBuf::new, |item| item.workspace_root.clone()),
            resume_session: Some(session_id.into()),
        })
    }

    fn send_prompt(&mut self, request: &PromptRequest) -> Result<PromptAccepted, AdapterError> {
        request.validate()?;
        if self.closed || self.session.is_none() {
            return Err(AdapterError::Connection(
                "scenario session is not active".into(),
            ));
        }
        if request.idempotency_key.trim().is_empty() {
            return Err(AdapterError::InvalidRequest(
                "idempotency_key is empty".into(),
            ));
        }
        if self
            .context
            .as_ref()
            .is_some_and(|context| context.attempt_id != request.attempt_id)
        {
            return Err(AdapterError::InvalidRequest(
                "prompt attempt does not match the active session".into(),
            ));
        }
        if isolated_required() && request.text.contains("RC-MARKER-FORCE-FAIL") {
            return Err(AdapterError::Connection(
                "RC-MARKER-FORCE-FAIL".into(),
            ));
        }
        if let Some(reason) = self.fail_next_send.take() {
            return Err(AdapterError::Connection(reason));
        }
        if isolated_required()
            && request.text.contains("RC-MARKER-HOLD")
            && !self.sent_prompt_keys.contains(&request.idempotency_key)
        {
            std::thread::sleep(std::time::Duration::from_millis(8000));
        }
        if self.sent_prompt_keys.contains(&request.idempotency_key) {
            return Ok(PromptAccepted {
                idempotency_key: request.idempotency_key.clone(),
                accepted: true,
                duplicate: true,
            });
        }
        self.sent_prompt_keys
            .insert(request.idempotency_key.clone());
        self.sent_prompts.push(request.text.clone());
        let event = self.next_event(
            AgentEventType::MessageDelta,
            json!({ "text": request.text }),
        );
        self.events.push_back(event);
        let tool_event = self.next_event(
            AgentEventType::ToolActivity,
            json!({ "tool": "scenario.workspace.inspect", "status": "completed" }),
        );
        self.events.push_back(tool_event);
        let waiting_event = self.next_event(
            AgentEventType::Waiting,
            json!({ "reason": "scenario checkpoint", "resumable": true }),
        );
        self.events.push_back(waiting_event);
        if request.text.to_ascii_lowercase().contains("permission")
            || request.text.to_ascii_lowercase().contains("write")
        {
            let permission_event = self.next_event(
                AgentEventType::PermissionRequest,
                json!({ "request_id": format!("scenario-permission-{}", self.sequence + 1), "kind": "workspace" }),
            );
            self.events.push_back(permission_event);
        }
        let completed_event = self.next_event(
            AgentEventType::TurnCompleted,
            json!({ "text": format!("Scenario Runtime completed: {}", request.text), "status": "completed" }),
        );
        self.events.push_back(completed_event);
        Ok(PromptAccepted {
            idempotency_key: request.idempotency_key.clone(),
            accepted: true,
            duplicate: false,
        })
    }

    fn stream_events(&mut self) -> Result<Vec<AgentEventEnvelope>, AdapterError> {
        Ok(self.events.drain(..).collect())
    }

    fn permission_response(&mut self, response: PermissionResponse) -> Result<(), AdapterError> {
        let event = self.next_event(
            AgentEventType::PermissionResponse,
            json!({ "request_id": response.request_id, "allow": response.allow }),
        );
        self.events.push_back(event);
        Ok(())
    }

    fn cancel_turn(&mut self, _turn_id: &str) -> Result<CancelResult, AdapterError> {
        if !self.cancel_supported {
            return Err(AdapterError::Unsupported(
                "cancel_turn is not verified by ScenarioAdapter".into(),
            ));
        }
        let event = self.next_event(AgentEventType::Cancelled, json!({ "confirmed": true }));
        self.events.push_back(event);
        Ok(CancelResult {
            requested: true,
            confirmed: true,
            reason: None,
        })
    }

    fn interrupt(&mut self) -> Result<CancelResult, AdapterError> {
        self.cancel_turn("interrupt")
    }

    fn close(&mut self) -> Result<(), AdapterError> {
        self.closed = true;
        self.session = None;
        Ok(())
    }
}

#[derive(Debug, Clone)]
struct StructuredAdapter {
    identity: RuntimeIdentity,
    executable: PathBuf,
    workspace_root: PathBuf,
    capabilities: CapabilitySnapshot,
    auth: AuthState,
    session: Option<SessionHandle>,
    context: Option<SessionRequest>,
    events: VecDeque<AgentEventEnvelope>,
    sent_prompt_keys: HashSet<String>,
    closed: bool,
}

impl StructuredAdapter {
    fn new(
        provider: &str,
        version: impl Into<String>,
        transport: TransportKind,
        protocol: &str,
        executable: PathBuf,
        workspace_root: PathBuf,
    ) -> Self {
        let identity = RuntimeIdentity {
            provider: provider.into(),
            version: version.into(),
            executable: Some(executable.to_string_lossy().into_owned()),
            transport,
            adapter_version: ADAPTER_API_VERSION.into(),
            protocol_version: protocol.into(),
        };
        let capabilities = CapabilitySnapshot {
            version: format!("{}-cap-v1", identity.provider),
            runtime: identity.clone(),
            capabilities: vec![
                capability(
                    "session",
                    CapabilitySupport::Supported,
                    "versioned structured session",
                ),
                capability(
                    "stream_events",
                    CapabilitySupport::Supported,
                    "structured event envelopes",
                ),
                capability(
                    "resume",
                    CapabilitySupport::Unknown,
                    "requires live protocol evidence",
                ),
                capability(
                    "permission_response",
                    CapabilitySupport::Unknown,
                    "requires live protocol evidence",
                ),
                capability(
                    "cancel_turn",
                    CapabilitySupport::Unknown,
                    "requires live protocol evidence",
                ),
                capability(
                    "native_config",
                    CapabilitySupport::Unknown,
                    "requires synthetic native-config probe",
                ),
            ],
            captured_at: now(),
        };
        Self {
            identity,
            executable,
            workspace_root,
            capabilities,
            auth: AuthState::Unknown,
            session: None,
            context: None,
            events: VecDeque::new(),
            sent_prompt_keys: HashSet::new(),
            closed: false,
        }
    }

    fn probe(&self) -> RuntimeProbe {
        RuntimeProbe {
            identity: self.identity.clone(),
            executable_present: self.executable.is_file(),
        }
    }

    fn preflight(&self, policy: CompatibilityPolicy) -> PreflightResult {
        let executable_present = self.executable.is_file();
        let mut warnings = vec!["credentials and model execution were not inspected".into()];
        if !self.workspace_root.exists() {
            warnings.push("workspace root does not currently exist; it will be checked again before session creation".into());
        }
        let status = if !executable_present {
            PreflightStatus::RuntimeMissing
        } else if self.identity.version.trim().is_empty()
            || self.identity.version.eq_ignore_ascii_case("unknown")
        {
            PreflightStatus::VersionUntested
        } else if matches!(policy, CompatibilityPolicy::Strict)
            && self.capabilities.capabilities.iter().any(|capability| {
                matches!(
                    capability.support,
                    CapabilitySupport::Unknown
                        | CapabilitySupport::Degraded
                        | CapabilitySupport::Partial
                )
            })
        {
            warnings.push(
                "strict compatibility rejects capabilities without direct protocol evidence".into(),
            );
            PreflightStatus::Incompatible
        } else {
            warnings.push(
                "authentication remains UNKNOWN until a Runtime-owned check is performed".into(),
            );
            PreflightStatus::ReadyWithWarnings
        };
        PreflightResult {
            status,
            identity: self.identity.clone(),
            auth_state: self.auth,
            capabilities: self.capabilities.clone(),
            warnings,
            checked_executable: true,
            invoked_runtime: false,
        }
    }

    fn create_session(&mut self, request: &SessionRequest) -> Result<SessionHandle, AdapterError> {
        request.validate()?;
        if self.closed {
            return Err(AdapterError::Connection("adapter is closed".into()));
        }
        self.context = Some(request.clone());
        let resumed = request.resume_session.is_some();
        let session_id = request.resume_session.clone().unwrap_or_else(|| {
            format!("{}-session-{}", self.identity.provider, request.attempt_id)
        });
        let session = SessionHandle {
            session_id,
            resumed,
        };
        self.session = Some(session.clone());
        Ok(session)
    }

    fn resume_session(&mut self, session_id: &str) -> Result<SessionHandle, AdapterError> {
        if session_id.trim().is_empty() {
            return Err(AdapterError::InvalidRequest("session id is empty".into()));
        }
        let request = self
            .context
            .clone()
            .ok_or_else(|| AdapterError::Connection("no session context to resume".into()))?;
        self.create_session(&SessionRequest {
            resume_session: Some(session_id.into()),
            ..request
        })
    }

    fn send_prompt(&mut self, request: &PromptRequest) -> Result<PromptAccepted, AdapterError> {
        request.validate()?;
        if self.closed || self.session.is_none() {
            return Err(AdapterError::Connection(
                "structured session is not active".into(),
            ));
        }
        if request.idempotency_key.trim().is_empty() {
            return Err(AdapterError::InvalidRequest(
                "idempotency_key is empty".into(),
            ));
        }
        if self
            .context
            .as_ref()
            .is_some_and(|context| context.attempt_id != request.attempt_id)
        {
            return Err(AdapterError::InvalidRequest(
                "prompt attempt does not match the active session".into(),
            ));
        }
        if self.sent_prompt_keys.contains(&request.idempotency_key) {
            return Ok(PromptAccepted {
                idempotency_key: request.idempotency_key.clone(),
                accepted: true,
                duplicate: true,
            });
        }
        self.sent_prompt_keys
            .insert(request.idempotency_key.clone());
        // The structured adapter does not synthesize a provider response. This event is
        // only emitted by the protocol parser after an actual provider frame is received.
        Ok(PromptAccepted {
            idempotency_key: request.idempotency_key.clone(),
            accepted: true,
            duplicate: false,
        })
    }
}

macro_rules! structured_adapter {
    ($name:ident, $provider:literal, $transport:expr, $protocol:literal, $help:expr) => {
        #[derive(Debug, Clone)]
        pub struct $name {
            inner: StructuredAdapter,
        }

        impl $name {
            pub fn new(
                executable: impl Into<PathBuf>,
                version: impl Into<String>,
                workspace_root: impl Into<PathBuf>,
            ) -> Self {
                Self {
                    inner: StructuredAdapter::new(
                        $provider,
                        version,
                        $transport,
                        $protocol,
                        executable.into(),
                        workspace_root.into(),
                    ),
                }
            }

            pub fn build_argv(
                executable: impl AsRef<Path>,
                workspace_root: impl AsRef<Path>,
                session_id: Option<&str>,
            ) -> Vec<String> {
                let mut argv = vec![executable.as_ref().to_string_lossy().into_owned()];
                argv.extend(
                    Self::protocol_argv(workspace_root.as_ref())
                        .iter()
                        .map(|arg| (*arg).to_owned()),
                );
                if let Some(session) = session_id {
                    argv.push(session.to_owned());
                }
                argv
            }

            pub fn protocol_argv(_workspace_root: &Path) -> &'static [&'static str] {
                $help
            }

            pub fn executable(&self) -> &Path {
                &self.inner.executable
            }
            pub fn workspace_root(&self) -> &Path {
                &self.inner.workspace_root
            }
            pub fn argv(&self, session_id: Option<&str>) -> Vec<String> {
                Self::build_argv(
                    &self.inner.executable,
                    &self.inner.workspace_root,
                    session_id,
                )
            }
            pub fn preflight_result(&self) -> PreflightResult {
                self.inner.preflight(CompatibilityPolicy::Compatible)
            }
            pub fn parse_event_line(line: &str) -> Result<AgentEventEnvelope, AdapterError> {
                parse_structured_event($provider, line)
            }
        }

        impl AgentAdapter for $name {
            fn runtime_identity(&self) -> RuntimeIdentity {
                self.inner.identity.clone()
            }
            fn probe(&mut self) -> Result<RuntimeProbe, AdapterError> {
                Ok(self.inner.probe())
            }
            fn negotiate(
                &mut self,
                _requested: &[String],
            ) -> Result<CapabilitySnapshot, AdapterError> {
                Ok(self.inner.capabilities.clone())
            }
            fn auth_state(&mut self) -> Result<AuthState, AdapterError> {
                Ok(self.inner.auth)
            }
            fn preflight(
                &mut self,
                policy: CompatibilityPolicy,
            ) -> Result<PreflightResult, AdapterError> {
                Ok(self.inner.preflight(policy))
            }
            fn create_session(
                &mut self,
                request: &SessionRequest,
            ) -> Result<SessionHandle, AdapterError> {
                self.inner.create_session(request)
            }
            fn resume_session(&mut self, session_id: &str) -> Result<SessionHandle, AdapterError> {
                self.inner.resume_session(session_id)
            }
            fn send_prompt(
                &mut self,
                request: &PromptRequest,
            ) -> Result<PromptAccepted, AdapterError> {
                self.inner.send_prompt(request)
            }
            fn stream_events(&mut self) -> Result<Vec<AgentEventEnvelope>, AdapterError> {
                Ok(self.inner.events.drain(..).collect())
            }
            fn permission_response(
                &mut self,
                _response: PermissionResponse,
            ) -> Result<(), AdapterError> {
                Err(AdapterError::Unsupported(
                    "permission_response requires live protocol capability".into(),
                ))
            }
            fn cancel_turn(&mut self, _turn_id: &str) -> Result<CancelResult, AdapterError> {
                Err(AdapterError::Unsupported(
                    "cancel_turn requires live protocol capability".into(),
                ))
            }
            fn interrupt(&mut self) -> Result<CancelResult, AdapterError> {
                Err(AdapterError::Unsupported(
                    "interrupt requires live protocol capability".into(),
                ))
            }
            fn close(&mut self) -> Result<(), AdapterError> {
                self.inner.closed = true;
                self.inner.session = None;
                Ok(())
            }
        }
    };
}

structured_adapter!(
    CodexAppServerAdapter,
    "codex",
    TransportKind::AppServerStdio,
    "codex.app-server.v1",
    &["app-server", "--json"]
);

pub type CodexAdapter = CodexAppServerAdapter;
pub type CodexAppServer = CodexAppServerAdapter;
pub type GrokAdapter = GrokAcpAdapter;
pub type GrokAcp = GrokAcpAdapter;
pub type ClaudeAdapter = ClaudeCliAdapter;
pub type ClaudeNativeCli = ClaudeCliAdapter;

structured_adapter!(
    GrokAcpAdapter,
    "grok",
    TransportKind::AcpStdio,
    "grok.acp.v1",
    &["agent", "stdio"]
);

structured_adapter!(
    ClaudeCliAdapter,
    "claude",
    TransportKind::NativeCliStreamJson,
    "claude.cli.stream-json.v1",
    &[
        "-p",
        "--output-format",
        "stream-json",
        "--input-format",
        "stream-json",
        "--verbose",
        "--permission-prompts",
        "host",
        "--permission-mode",
        "manual",
        "--permission-prompt-tool",
        "stdio",
        "--replay-user-messages",
    ]
);

impl ClaudeCliAdapter {
    /// Spawn argv for the persistent stream-json child. Prompt text is never an
    /// argv token; `--resume` is added only with a provider-observed session id.
    pub fn spawn_argv(
        executable: impl AsRef<Path>,
        workspace_root: impl AsRef<Path>,
        resume_session: Option<&str>,
    ) -> Vec<String> {
        let mut argv = Self::build_argv(executable, workspace_root, None);
        if let Some(session) = resume_session.map(str::trim).filter(|value| !value.is_empty()) {
            argv.push("--resume".into());
            argv.push(session.to_owned());
        }
        argv
    }

    pub fn spawn_argv_keeps_native_permissions(argv: &[String]) -> bool {
        let flags = argv.iter().map(String::as_str).collect::<Vec<_>>();
        flags.windows(2).any(|window| window == ["--permission-prompts", "host"])
            && flags
                .windows(2)
                .any(|window| window == ["--permission-mode", "manual"])
            && flags
                .windows(2)
                .any(|window| window == ["--permission-prompt-tool", "stdio"])
            && !flags.iter().any(|flag| *flag == "--bare")
            && !flags
                .iter()
                .any(|flag| *flag == "--dangerously-skip-permissions")
            && !flags.windows(2).any(|window| {
                window == ["--permission-prompts", "none"]
                    || window == ["--permission-prompts", "never"]
            })
    }
}

/// Parse one structured provider frame. Unknown event kinds are retained as
/// `Unknown` with their bounded JSON payload so they cannot mutate core state.
pub fn parse_structured_event(
    provider: &str,
    line: &str,
) -> Result<AgentEventEnvelope, AdapterError> {
    if line.len() > MAX_EVENT_BYTES {
        return Err(AdapterError::Protocol(format!(
            "provider event exceeds {} bytes",
            MAX_EVENT_BYTES
        )));
    }
    let value: Value = serde_json::from_str(line)?;
    let object = value
        .as_object()
        .ok_or_else(|| AdapterError::Protocol("provider frame must be a JSON object".into()))?;
    let event_name = object
        .get("event_type")
        .or_else(|| object.get("type"))
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let event_type = parse_event_type(event_name);
    let sequence = object
        .get("sequence")
        .or_else(|| object.get("seq"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let event_id = object
        .get("event_id")
        .or_else(|| object.get("id"))
        .and_then(Value::as_str)
        .unwrap_or("provider-event-unknown")
        .to_owned();
    let provider_event_reference = format!("{provider}:{event_id}");
    let payload = object
        .get("payload")
        .cloned()
        .unwrap_or_else(|| value.clone());
    Ok(AgentEventEnvelope {
        event_id,
        campaign_id: object
            .get("campaign_id")
            .and_then(Value::as_str)
            .map(str::to_owned),
        task_id: object
            .get("task_id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        attempt_id: object
            .get("attempt_id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        process_epoch_id: object
            .get("process_epoch_id")
            .and_then(Value::as_str)
            .unwrap_or("provider-process-unknown")
            .to_owned(),
        sequence,
        occurred_at: object
            .get("occurred_at")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_owned(),
        received_at: now(),
        provider_event_reference: Some(provider_event_reference),
        event_type,
        payload,
    })
}

fn parse_event_type(value: &str) -> AgentEventType {
    match value
        .to_ascii_lowercase()
        .replace(['-', '.', ':'], "_")
        .as_str()
    {
        "session_created" | "session" | "session_start" => AgentEventType::SessionCreated,
        "turn_started" | "turn_start" => AgentEventType::TurnStarted,
        "message_delta" | "text_delta" | "assistant_delta" => AgentEventType::MessageDelta,
        "tool_activity" | "tool_started" | "tool_completed" | "command_started"
        | "command_completed" => AgentEventType::ToolActivity,
        "permission_request" | "approval_request" => AgentEventType::PermissionRequest,
        "permission_response" | "approval_response" => AgentEventType::PermissionResponse,
        "waiting" | "awaiting_permission" | "awaiting_review" => AgentEventType::Waiting,
        "turn_completed" | "completed" | "done" => AgentEventType::TurnCompleted,
        "turn_failed" | "failed" | "error" => AgentEventType::TurnFailed,
        "cancelled" | "canceled" | "interrupted" => AgentEventType::Cancelled,
        _ => AgentEventType::Unknown,
    }
}

fn capability(name: &str, support: CapabilitySupport, semantics: &str) -> Capability {
    Capability {
        name: name.into(),
        support,
        semantics: semantics.into(),
        limitations: Vec::new(),
        source: CapabilitySource::AdapterInferred,
    }
}

fn isolated_required() -> bool {
    matches!(
        std::env::var("GOALPORT_REQUIRE_ISOLATED").as_deref(),
        Ok("1")
    )
}

fn now() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis().to_string())
        .unwrap_or_else(|_| "0".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> SessionRequest {
        SessionRequest {
            campaign_id: Some("c".into()),
            task_id: "t".into(),
            attempt_id: "a".into(),
            workspace_root: PathBuf::from("C:\\work"),
            resume_session: None,
        }
    }

    #[test]
    fn scenario_deduplicates_prompt_after_reconnect() {
        let mut adapter = ScenarioAdapter::new("scenario");
        let session = adapter.create_session(&request()).unwrap();
        let prompt = PromptRequest {
            attempt_id: "a".into(),
            text: "hello".into(),
            idempotency_key: "cmd-1".into(),
        };
        assert!(!adapter.send_prompt(&prompt).unwrap().duplicate);
        adapter.resume_session(&session.session_id).unwrap();
        assert!(adapter.send_prompt(&prompt).unwrap().duplicate);
        assert_eq!(adapter.sent_prompts(), &["hello"]);
    }

    const MARKER_CHILD: &str = "GOALPORT_ADAPTER_MARKER_CHILD";

    /// Re-executes this test in a child whose GOALPORT_REQUIRE_ISOLATED is set by
    /// the test, not inherited from the parent shell. Returns true in the parent
    /// after the child has already asserted the case.
    fn reexec_with_isolation(isolated: Option<&str>) -> bool {
        if std::env::var_os(MARKER_CHILD).is_some() {
            return false;
        }
        let test_name = std::thread::current()
            .name()
            .expect("cargo names the test thread")
            .to_string();
        let mut command = std::process::Command::new(
            std::env::current_exe().expect("test executable"),
        );
        command
            .arg(&test_name)
            .arg("--exact")
            .arg("--nocapture")
            .env(MARKER_CHILD, "1")
            .env_remove("GOALPORT_REQUIRE_ISOLATED");
        if let Some(value) = isolated {
            command.env("GOALPORT_REQUIRE_ISOLATED", value);
        }
        let output = command
            .output()
            .expect("spawn a child with a controlled isolation env");
        assert!(
            output.status.success(),
            "controlled child {test_name} failed (isolated={isolated:?})\nstdout:\n{}\nstderr:\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        true
    }

    #[test]
    fn isolated_markers_are_inert_without_isolated_env() {
        if reexec_with_isolation(None) {
            return;
        }
        assert!(
            !isolated_required(),
            "child must run with GOALPORT_REQUIRE_ISOLATED unset"
        );
        let mut adapter = ScenarioAdapter::new("scenario");
        adapter.create_session(&request()).unwrap();
        let started = std::time::Instant::now();
        let hold = PromptRequest {
            attempt_id: "a".into(),
            text: "RC-MARKER-HOLD".into(),
            idempotency_key: "hold-1".into(),
        };
        assert!(!adapter.send_prompt(&hold).unwrap().duplicate);
        assert!(
            started.elapsed() < std::time::Duration::from_millis(200),
            "HOLD must not sleep unless GOALPORT_REQUIRE_ISOLATED=1"
        );
        let fail = PromptRequest {
            attempt_id: "a".into(),
            text: "RC-MARKER-FORCE-FAIL".into(),
            idempotency_key: "fail-1".into(),
        };
        assert!(!adapter.send_prompt(&fail).unwrap().duplicate);
        assert_eq!(
            adapter.sent_prompts(),
            &["RC-MARKER-HOLD", "RC-MARKER-FORCE-FAIL"]
        );
    }

    #[test]
    fn isolated_markers_apply_when_isolated_env_is_set() {
        if reexec_with_isolation(Some("1")) {
            return;
        }
        assert!(
            isolated_required(),
            "child must run with GOALPORT_REQUIRE_ISOLATED=1"
        );
        let mut adapter = ScenarioAdapter::new("scenario");
        adapter.create_session(&request()).unwrap();
        let fail = PromptRequest {
            attempt_id: "a".into(),
            text: "RC-MARKER-FORCE-FAIL".into(),
            idempotency_key: "fail-1".into(),
        };
        match adapter.send_prompt(&fail) {
            Err(AdapterError::Connection(reason)) => {
                assert_eq!(reason, "RC-MARKER-FORCE-FAIL")
            }
            other => panic!("expected isolated FORCE-FAIL, got {other:?}"),
        }
        assert!(
            adapter.sent_prompts().is_empty(),
            "FORCE-FAIL must not be recorded as a sent prompt"
        );
        let ok = PromptRequest {
            attempt_id: "a".into(),
            text: "hello".into(),
            idempotency_key: "ok-1".into(),
        };
        assert!(!adapter.send_prompt(&ok).unwrap().duplicate);
        assert_eq!(adapter.sent_prompts(), &["hello"]);
        let started = std::time::Instant::now();
        let replay = PromptRequest {
            attempt_id: "a".into(),
            text: "RC-MARKER-HOLD".into(),
            idempotency_key: "ok-1".into(),
        };
        assert!(adapter.send_prompt(&replay).unwrap().duplicate);
        assert!(
            started.elapsed() < std::time::Duration::from_millis(200),
            "HOLD must not sleep on a duplicate idempotency key"
        );
        assert_eq!(adapter.sent_prompts(), &["hello"]);
    }

    #[test]
    fn fail_next_send_still_fails_once_then_succeeds() {
        let mut adapter = ScenarioAdapter::new("scenario");
        adapter.create_session(&request()).unwrap();
        adapter.fail_next_send("boom");
        let prompt = PromptRequest {
            attempt_id: "a".into(),
            text: "hello".into(),
            idempotency_key: "cmd-fail-once".into(),
        };
        match adapter.send_prompt(&prompt) {
            Err(AdapterError::Connection(reason)) => assert_eq!(reason, "boom"),
            other => panic!("expected Connection(boom), got {other:?}"),
        }
        assert!(!adapter.send_prompt(&prompt).unwrap().duplicate);
        assert_eq!(adapter.sent_prompts(), &["hello"]);
    }

    #[test]
    fn structured_adapters_construct_versioned_argv_without_prompt_or_credentials() {
        let argv = CodexAppServerAdapter::build_argv("codex", "C:\\work", Some("s1"));
        assert_eq!(argv, vec!["codex", "app-server", "--json", "s1"]);
        assert!(
            !argv
                .iter()
                .any(|item| item.contains("password") || item.contains("prompt"))
        );
        let grok = GrokAcpAdapter::build_argv("grok", "C:\\work", None);
        assert_eq!(grok, vec!["grok", "agent", "stdio"]);
        let claude = ClaudeCliAdapter::spawn_argv("claude", "C:\\work", None);
        assert_eq!(
            claude,
            vec![
                "claude",
                "-p",
                "--output-format",
                "stream-json",
                "--input-format",
                "stream-json",
                "--verbose",
                "--permission-prompts",
                "host",
                "--permission-mode",
                "manual",
                "--permission-prompt-tool",
                "stdio",
                "--replay-user-messages",
            ]
        );
        assert!(ClaudeCliAdapter::spawn_argv_keeps_native_permissions(&claude));
        let resumed = ClaudeCliAdapter::spawn_argv("claude", "C:\\work", Some("provider-session"));
        assert!(resumed.windows(2).any(|window| window == ["--resume", "provider-session"]));
        assert!(ClaudeCliAdapter::spawn_argv_keeps_native_permissions(&resumed));
    }

    #[test]
    fn spawn_argv_keeps_native_permissions() {
        let argv = ClaudeCliAdapter::spawn_argv("claude", ".", None);
        assert!(ClaudeCliAdapter::spawn_argv_keeps_native_permissions(&argv));
        assert!(
            argv.windows(2)
                .any(|window| window == ["--permission-prompts", "host"])
        );
        assert!(
            argv.windows(2)
                .any(|window| window == ["--permission-mode", "manual"])
        );
        assert!(
            argv.windows(2)
                .any(|window| window == ["--permission-prompt-tool", "stdio"])
        );
        assert!(!argv.iter().any(|flag| flag == "--bare"));
        assert!(!argv.iter().any(|flag| flag == "--dangerously-skip-permissions"));
        assert!(
            !argv
                .windows(2)
                .any(|window| window == ["--permission-prompts", "none"])
        );
    }

    #[test]
    fn unknown_structured_event_is_preserved_without_state_meaning() {
        let event = ClaudeCliAdapter::parse_event_line(
            r#"{"type":"future_event","seq":4,"payload":{"x":1}}"#,
        )
        .unwrap();
        assert_eq!(event.event_type, AgentEventType::Unknown);
        assert_eq!(event.sequence, 4);
        assert_eq!(event.payload["x"], 1);
    }
}
