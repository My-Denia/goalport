//! GoalPort local control core.
//!
//! The crate keeps the domain and persistence boundary independent from the desktop
//! transport. Adapters are deliberately thin: they can report provider events and
//! capabilities but cannot write the authoritative store directly.

pub mod adapters;
pub mod assurance;
pub mod claude_stop_broker;
pub mod commands;
pub mod domain;
pub mod ipc;
pub mod process_identity;
pub mod product_conversation;
pub mod product_receipts;
pub mod profile_ops;
pub mod projection;
pub mod runtime_manager;
pub mod store;

pub use adapters::{
    AdapterError, AgentAdapter, AuthState, CancelResult, Capability, CapabilitySnapshot,
    CapabilitySource, CapabilitySupport, ClaudeAdapter, ClaudeCliAdapter, ClaudeNativeCli,
    CodexAdapter, CodexAppServer, CodexAppServerAdapter, CompatibilityPolicy, GrokAcp,
    GrokAcpAdapter, GrokAdapter, MAX_EVENT_BYTES, PermissionResponse, PreflightResult,
    PreflightStatus, PromptAccepted, PromptRequest, RuntimeIdentity, RuntimeProbe, ScenarioAdapter,
    ScenarioRuntime, SessionHandle, SessionRequest, TransportKind, parse_structured_event,
};
pub use commands::{CommandError, CommandExecution, CommandProcessor, CoreCommand, CoreOperation};
pub use domain::*;
pub use ipc::{
    CoreServer, IpcClient, IpcError, IpcRequest, IpcResponse, UiCommandRequest, UiCommandResponse,
};
pub use projection::{CoreSnapshot, UiCommandResult, UiController};
pub use product_conversation::{
    ProductConversation, ProductConversationItem, ProductRuntimeSelection, ProductTurn,
};
pub use runtime_manager::{
    RuntimeIdentitySummary, RuntimeManager, RuntimeSendResult, RuntimeSessionResult, TurnFacts,
};
pub use store::{
    AppendEventOutcome, AttemptRecovery, CampaignAuthorization, ConfirmedStopSuccessor,
    ConversationPreference, ConversationPrepareOutcome, ConversationRequestPhase,
    ConversationRequestRow, ConversationStart, CoreLaunchEpoch, EventRecord, SqliteStore, Store,
    StoreCounts, StoreError,
};

pub const CORE_PROTOCOL_VERSION: &str = "goalport.core.v1";
