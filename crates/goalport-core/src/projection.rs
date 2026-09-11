//! Durable Core-to-Desktop projection and UI command coordinator.
//!
//! This module is the only place that turns persisted domain rows into the
//! React projection.  Both desktop hosts call the same request/response shape;
//! a host cannot create an id or maintain a second recovery state machine.

use crate::{
    adapters::{PermissionResponse, PromptRequest, SessionRequest},
    assurance::{ActionAuthority, ApprovalContext},
    commands::{CoreCommand, CoreOperation, sha256_hex},
    domain::{
        AccessMode, AgentEventEnvelope, AgentEventType, Attempt, AttemptState, Campaign,
        Command, CommandState, Decision, DecisionState, Event, Evidence, Project, Task,
        Verdict,
        WorkspaceLease,
    },
    ipc::{CONNECTED_UI_PROTOCOL_VERSION, UiCommandRequest},
    runtime_manager::{RegistrationWithdrawal, RuntimeManager, TransportState},
    store::{
        self, AppendEventOutcome, AttemptRecovery, CampaignAuthorization, EventRecord,
        NewRecheckObservation, RecheckVerdict, RuntimeEpochBinding, RuntimeObservation,
        StopNativeTurnState, StopResponsibility, StopResponsibilityUpdate, Store, StoreError,
    },
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{fs, path::PathBuf};

/// Display-only Attempt identity used when a task has no persisted row.
/// Admission must never persist or register this string.
const UNASSIGNED_ATTEMPT_ID: &str = "attempt-unassigned";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiProject {
    pub id: String,
    pub name: String,
    pub workspace_root: String,
    pub color: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiCampaign {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub goal: String,
    pub state: String,
    pub task_count: usize,
    pub active_task_title: String,
    pub updated_label: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiAttempt {
    pub id: String,
    pub task_id: String,
    pub provider: String,
    pub role: String,
    pub state: String,
    pub session_label: String,
    /// SHA-256 of the opaque native provider session/thread id.  The raw id
    /// remains Core-owned and is never sent to the desktop projection.
    pub session_hash: Option<String>,
    pub event_count: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiTask {
    pub id: String,
    pub title: String,
    pub acceptance: String,
    pub state: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiTimelineItem {
    pub id: String,
    pub kind: String,
    pub actor: String,
    pub title: String,
    pub body: String,
    pub timestamp: String,
    pub status: Option<String>,
    pub evidence_state: Option<String>,
    pub details: Vec<String>,
    pub accent: String,
    pub cursor: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiRuntime {
    pub id: String,
    pub name: String,
    pub version: String,
    pub support: String,
    pub mode: String,
    pub subtitle: String,
    pub reasons: Vec<String>,
    pub capabilities: UiRuntimeCapabilities,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UiRuntimeCapabilities {
    pub events: String,
    pub resume: String,
    pub permissions: String,
    pub cancel: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiDecision {
    pub id: String,
    pub title: String,
    pub kind: String,
    pub facts: Vec<String>,
    pub recommendation: String,
    pub default_behavior: String,
    pub state: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiEvidence {
    pub id: String,
    pub claim: String,
    pub state: String,
    pub source: String,
    pub snapshot: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiStopResponsibility {
    pub attempt_id: String,
    pub operation_id: String,
    pub provider: String,
    pub native_turn_state: String,
    pub residual_execution_state: String,
    pub write_responsibility: String,
    pub input_uuid: String,
    pub session_hash: String,
    pub turn_epoch: u64,
    pub process_epoch: String,
    pub source: String,
    pub detail: Option<Value>,
    /// The exact workspace path the hold covers. Previously the GUI could say a
    /// workspace was blocked without ever naming which one.
    pub workspace_key: String,
    /// When the interruption happened, so "which interruption left this" has an
    /// answer.
    pub interrupted_at: String,
    /// Which work is blocked. A user looking at a held app needs the task, not an
    /// attempt id.
    pub task_title: String,
    pub campaign_goal: String,
    /// Core's own account of why this is still blocked, phrased the same way the
    /// ingress refusal phrases it. Standing, rather than produced only at the
    /// moment something is refused.
    pub blocked_reason: String,
    /// True when this hold blocks the workspace currently on screen. False on a
    /// hold surfaced through `related_holds`, which belongs to a different
    /// workspace -- rendering "held" there without this flag would tell the user
    /// their current workspace is blocked when it is not.
    pub blocks_current_workspace: bool,
    /// The newest re-check for this hold, if one has been taken. Carries its own
    /// `observed_at`, so the GUI shows when the fact was established rather than
    /// implying it is current.
    pub latest_recheck: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreSnapshot {
    pub protocol_version: String,
    pub build_id: String,
    pub connection: String,
    pub projects: Vec<UiProject>,
    pub selected_project_id: String,
    pub project: UiProject,
    pub campaigns: Vec<UiCampaign>,
    pub active_campaign_id: String,
    pub active_task: UiTask,
    pub attempt: UiAttempt,
    pub timeline: Vec<UiTimelineItem>,
    pub cursor: i64,
    pub runtimes: Vec<UiRuntime>,
    pub decisions: Vec<UiDecision>,
    pub evidence: Vec<UiEvidence>,
    pub stop_responsibility: Option<UiStopResponsibility>,
    /// Holds that do NOT govern the current workspace but that the user still needs
    /// to see -- above all the source hold after they have moved into a continuation
    /// workspace, where `stop_responsibility` is empty and the blocked-work panel
    /// would otherwise vanish exactly when it became useful.
    pub related_holds: Vec<UiStopResponsibility>,
    pub preview: bool,
    pub notices: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiCommandResult {
    pub request_id: String,
    pub duplicate: bool,
    pub accepted: bool,
    pub snapshot: CoreSnapshot,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub receipt: Option<Value>,
}

#[derive(Debug)]
pub struct UiController {
    store: Store,
    runtime_manager: RuntimeManager,
    selected_project_id: String,
    selected_campaign_id: Option<String>,
    selected_task_id: Option<String>,
    selected_attempt_id: Option<String>,
    notices: Vec<String>,
    build_id: String,
}

impl UiController {
    pub fn new(store: Store) -> Result<Self, String> {
        let mut controller = Self {
            store,
            runtime_manager: RuntimeManager::new(),
            selected_project_id: String::new(),
            selected_campaign_id: None,
            selected_task_id: None,
            selected_attempt_id: None,
            notices: Vec::new(),
            build_id: current_executable_build_id(),
        };
        controller.ensure_seed()?;
        controller.reconstruct_from_store()?;
        Ok(controller)
    }

    pub fn store(&self) -> &Store {
        &self.store
    }

    /// Persist provider events that arrived while no UI request was in flight.
    /// This is called by the Core-owned flusher as well as before each snapshot.
    pub fn flush_runtime_events(&mut self) -> Result<usize, String> {
        let pending = self
            .runtime_manager
            .poll_all_events()
            .map_err(|error| error.to_string())?;
        let count = pending.len();
        for event in pending {
            self.persist_agent_event(&event)?;
        }
        // Increment 6: a Codex output-transport closure observed since the last drain is recorded
        // ONCE. `take_transport_closures` returns only registrations whose session was actually
        // established this lifetime (thread_id set); a closure during admission or a failed resume
        // is carried by the admission-failure / resumed-false record instead, so those
        // pre-establishment timelines are unchanged. The record degrades the current communication
        // state without touching history: the process is kept, nothing is killed or replaced, and a
        // retry is never automatic.
        for closure in self.runtime_manager.take_transport_closures() {
            let identity = self
                .runtime_manager
                .registration_identity(&closure.attempt_id)
                .unwrap_or_default();
            self.persist_event(
                &closure.attempt_id,
                "runtime.transport.closed",
                json!({
                    "provider": "codex",
                    "reason": closure.reason,
                    "pid": closure.pid,
                    "registration_identity": identity,
                    "turnFailed": closure.turn_failed,
                    "kept": true,
                    "killed": false,
                    "replaced": false,
                    "retry": "not-automatic"
                }),
                None,
            )?;
        }
        Ok(count)
    }

    pub fn snapshot(&mut self, after_cursor: Option<i64>) -> Result<CoreSnapshot, String> {
        let projects = self.store.list_projects().map_err(store_message)?;
        if projects.is_empty() {
            return Err("Core has no project projection".into());
        }
        if !projects
            .iter()
            .any(|project| project.id == self.selected_project_id)
        {
            self.selected_project_id = projects[0].id.clone();
            self.selected_campaign_id = None;
            self.selected_task_id = None;
            self.selected_attempt_id = None;
        }
        self.flush_runtime_events()?;
        let selected_project = projects
            .iter()
            .find(|project| project.id == self.selected_project_id)
            .cloned()
            .ok_or_else(|| "selected project disappeared".to_string())?;
        let campaigns = self.campaigns_for_project(&selected_project.id)?;
        let active_campaign = self
            .selected_campaign_id
            .as_deref()
            .and_then(|id| campaigns.iter().find(|campaign| campaign.id == id))
            .cloned()
            .or_else(|| campaigns.last().cloned());
        let active_campaign_id = active_campaign
            .as_ref()
            .map(|campaign| campaign.id.clone())
            .unwrap_or_default();
        let tasks = active_campaign
            .as_ref()
            .map(|campaign| self.store.tasks_for_campaign(&campaign.id))
            .transpose()
            .map_err(store_message)?
            .unwrap_or_default();
        let active_task = self
            .selected_task_id
            .as_deref()
            .and_then(|id| tasks.iter().find(|task| task.id == id))
            .cloned()
            .or_else(|| tasks.first().cloned());
        let active_task_id = active_task.as_ref().map(|task| task.id.clone());
        let attempts = active_task
            .as_ref()
            .map(|task| self.store.attempts_for_task(&task.id))
            .transpose()
            .map_err(store_message)?
            .unwrap_or_default();
        let active_attempt = self
            .selected_attempt_id
            .as_deref()
            .and_then(|id| attempts.iter().find(|attempt| attempt.id == id))
            .cloned()
            .or_else(|| attempts.last().cloned())
            .unwrap_or_else(|| {
                Attempt::new(
                    UNASSIGNED_ATTEMPT_ID,
                    active_task_id.clone().unwrap_or_default(),
                    "scenario",
                    "scenario-cap-v1",
                )
            });
        self.selected_campaign_id = active_campaign.as_ref().map(|item| item.id.clone());
        self.selected_task_id = active_task_id;
        self.selected_attempt_id = Some(active_attempt.id.clone());
        let records = self
            .store
            .list_event_records(&active_attempt.id, after_cursor.unwrap_or(0))
            .map_err(store_message)?;
        let timeline =
            coalesce_reply_deltas(records.iter().map(event_to_timeline).collect(), &records);
        let cursor = records
            .last()
            .map(|record| record.event.seq)
            .unwrap_or(active_attempt.last_event_seq);
        let decisions = self
            .store
            .list_decisions()
            .map_err(store_message)?
            .into_iter()
            .filter(|decision| decision.attempt_id == active_attempt.id)
            .map(decision_to_ui)
            .collect::<Vec<_>>();
        let evidence = self
            .store
            .list_evidence()
            .map_err(store_message)?
            .into_iter()
            .filter(|item| item.attempt_id == active_attempt.id)
            .map(evidence_to_ui)
            .collect::<Vec<_>>();
        let project_ui = project_to_ui(&selected_project);
        // The hold that governs the workspace on screen, if any. This query is the
        // DISPLAY path and is deliberately untouched by this run.
        let governing = self
            .store
            .held_stop_for_workspace_prefer(
                &selected_project.workspace_root,
                Some(&active_attempt.id),
            )
            .map_err(store_message)?;
        let stop_responsibility = governing
            .clone()
            .map(|row| self.decorate_hold(row, true))
            .transpose()?;

        // Holds that do NOT govern this workspace but that the user still needs to
        // see. Without this the blocked-work panel disappears the moment the user
        // follows a continuation into its new workspace -- i.e. exactly when the
        // product has just steered them somewhere and owes them an explanation of
        // what stayed behind.
        let governing_attempt = governing.as_ref().map(|row| row.attempt_id.clone());
        let mut related_holds = Vec::new();
        if let Some(continuation) = self
            .store
            .stop_continuation_for_new_attempt(&active_attempt.id)
            .map_err(store_message)?
        {
            let source = continuation.source_attempt_id;
            if Some(&source) != governing_attempt.as_ref() {
                if let Some(row) = self
                    .store
                    .stop_responsibility_for_attempt(&source)
                    .map_err(store_message)?
                {
                    related_holds.push(self.decorate_hold(row, false)?);
                }
            }
        }
        let campaign_ui = campaigns
            .iter()
            .map(|campaign| campaign_to_ui(campaign, &self.store, &selected_project.id))
            .collect::<Result<Vec<_>, _>>()?;
        let task_ui = active_task
            .as_ref()
            .map(task_to_ui)
            .unwrap_or_else(|| UiTask {
                id: String::new(),
                title: "No task selected".into(),
                acceptance: String::new(),
                state: "in-progress".into(),
            });
        let mut runtimes = runtime_profiles();
        if active_attempt.provider.eq_ignore_ascii_case("claude") {
            let observed_version = self.store.list_event_records(&active_attempt.id, 0)
                .map_err(store_message)?.into_iter().find_map(|record| {
                    if record.event.kind != "runtime.session.created" { return None; }
                    record.payload.as_ref()?.get("runtime_version")?.as_str().map(str::to_owned)
                });
            if let Some(version) = observed_version {
                if let Some(profile) = runtimes.iter_mut().find(|profile| profile.id == "claude") {
                    profile.version = version;
                }
            }
        }
        Ok(CoreSnapshot {
            related_holds,
            protocol_version: CONNECTED_UI_PROTOCOL_VERSION.into(),
            build_id: self.build_id.clone(),
            connection: "connected".into(),
            projects: projects.iter().map(project_to_ui).collect(),
            selected_project_id: selected_project.id.clone(),
            project: project_ui,
            campaigns: campaign_ui,
            active_campaign_id,
            active_task: task_ui,
            attempt: attempt_to_ui(&active_attempt, &self.store),
            timeline,
            cursor,
            runtimes,
            decisions,
            evidence,
            stop_responsibility,
            preview: active_attempt.provider.eq_ignore_ascii_case("scenario"),
            notices: {
                let mut notices = self.notices.clone();
                self.merge_permission_denied_notices(&mut notices)?;
                if let Ok(queued) = self.store.pending_admissions() {
                    for row in queued.iter().filter(|row| row.override_reason.is_none()) {
                        notices.push(format!("Queued under resource pressure: {}", row.id));
                    }
                }
                notices
            },
        })
    }

    pub fn handle(&mut self, request: UiCommandRequest) -> Result<UiCommandResult, String> {
        request.validate().map_err(|error| error.to_string())?;
        let mut duplicate = false;
        let mut receipt = None;
        match request.message_type.as_str() {
            "snapshot" => {}
            "select_project" => {
                let project_id = payload_text(&request.payload, "projectId")?;
                self.select_project(&project_id)?;
            }
            "select_campaign" => {
                let campaign_id = payload_text(&request.payload, "campaignId")?;
                let campaign = self
                    .store
                    .get_campaign(&campaign_id)
                    .map_err(store_message)?;
                let project_id = self
                    .store
                    .campaign_project(&campaign_id)
                    .map_err(store_message)?
                    .unwrap_or_else(|| self.selected_project_id.clone());
                if project_id != self.selected_project_id {
                    self.select_project(&project_id)?;
                }
                self.selected_campaign_id = Some(campaign.id);
                self.selected_task_id = None;
                self.selected_attempt_id = None;
            }
            "create_campaign" | "create_campaign_with_task" => {
                self.create_campaign(&request)?;
            }
            "select_runtime" | "select_attempt" => {
                self.select_runtime(&request)?;
            }
            "send_message" => {
                duplicate = self.send_message(&request)?;
            }
            "resolve_decision" | "permission_response" => {
                self.resolve_decision(&request)?;
            }
            "interrupt" | "safe_stop" | "cancel" => {
                self.interrupt(&request)?;
            }
            "reconnect" => {
                self.reconnect_ui(&request)?;
            }
            "handoff" | "reassign" => {
                self.handoff(&request)?;
            }
            "revoke_authorization" => {
                self.revoke_authorization(&request)?;
            }
            "request_owner_action" => {
                self.request_owner_action(&request)?;
            }
            "resume_native_session" => {
                self.resume_native_session(&request)?;
            }
            "continue_in_isolated_workspace" => {
                receipt = Some(self.continue_in_isolated_workspace(&request)?);
            }
            "recheck_stop_responsibility" => {
                receipt = Some(self.recheck_stop_responsibility(&request)?);
            }
            "classify_recovery" => {
                self.classify_recovery(&request)?;
            }
            "close_adapter_transport" => {
                self.close_adapter_transport(&request)?;
            }
            "mark_runtime_exit" => {
                self.mark_runtime_exit(&request)?;
            }
            "observe_workspace_edit" => {
                self.observe_workspace_edit(&request)?;
            }
            "queue_override" => {
                self.queue_override(&request)?;
            }
            "record_close_choice" => {
                let (value, is_duplicate) = self.record_close_choice(&request)?;
                receipt = Some(value);
                duplicate = is_duplicate;
            }
            "get_startup_receipt" => {
                receipt = Some(self.get_startup_receipt(&request)?);
            }
            "get_close_choice_receipt" => {
                receipt = Some(self.get_close_choice_receipt(&request)?);
            }
            unknown => return Err(format!("unsupported UI message type: {unknown}")),
        }
        let after_cursor = if request.message_type == "reconnect" {
            payload_i64(&request.payload, "cursor")
        } else {
            None
        };
        let snapshot = self.snapshot(after_cursor)?;
        Ok(UiCommandResult {
            request_id: request.request_id,
            duplicate,
            accepted: true,
            snapshot,
            receipt,
        })
    }

    fn ensure_seed(&mut self) -> Result<(), String> {
        let projects = self.store.list_projects().map_err(store_message)?;
        if projects.is_empty() {
            let workspace = std::env::var("GOALPORT_SYNTHETIC_ROOT").unwrap_or_else(|_| {
                std::env::current_dir()
                    .map(|root| {
                        root.join(
                            "goal-runs/goalport-electron-stable-v1/fixtures/synthetic-workspace",
                        )
                        .to_string_lossy()
                        .into_owned()
                    })
                    .unwrap_or_else(|_| {
                        "goal-runs/goalport-electron-stable-v1/fixtures/synthetic-workspace".into()
                    })
            });
            self.store
                .insert_project(&Project {
                    id: "project-synthetic".into(),
                    workspace_root: workspace,
                })
                .map_err(store_message)?;
        }
        let project = self
            .store
            .list_projects()
            .map_err(store_message)?
            .into_iter()
            .next()
            .ok_or_else(|| "unable to seed project".to_string())?;
        self.selected_project_id = project.id.clone();
        let campaigns = self
            .store
            .campaigns_for_project(&project.id)
            .map_err(store_message)?;
        if campaigns.is_empty() {
            let campaign = Campaign {
                id: "campaign-synthetic-preview".into(),
                goal: "Exercise a connected GoalPort preview with a synthetic workspace".into(),
                root_task_id: "task-synthetic-preview".into(),
                state: crate::domain::WorkStatus::InProgress,
            };
            let task = Task {
                id: campaign.root_task_id.clone(),
                campaign_id: campaign.id.clone(),
                title: "Connect a real Core and Runtime".into(),
                acceptance: "Persist ordered reply, tool and waiting events and recover without prompt replay.".into(),
                state: crate::domain::WorkStatus::InProgress,
            };
            self.store
                .create_campaign_with_task(&project.id, &campaign, &task)
                .map_err(store_message)?;
            self.store
                .insert_attempt(&Attempt::new(
                    "attempt-scenario-preview",
                    &task.id,
                    "scenario",
                    "scenario-cap-v1",
                ))
                .map_err(store_message)?;
            self.store
                .append_event(&Event {
                    id: "event-scenario-attempt-active".into(),
                    attempt_id: "attempt-scenario-preview".into(),
                    seq: 1,
                    kind: "attempt.active".into(),
                    payload_ref: None,
                })
                .map_err(store_message)?;
            self.store
                .set_campaign_authorization(&campaign.id, &CampaignAuthorization::granted())
                .map_err(store_message)?;
        }
        Ok(())
    }

    fn select_project(&mut self, project_id: &str) -> Result<(), String> {
        self.store.get_project(project_id).map_err(store_message)?;
        self.selected_project_id = project_id.into();
        self.selected_campaign_id = None;
        self.selected_task_id = None;
        self.selected_attempt_id = None;
        Ok(())
    }

    fn create_campaign(&mut self, request: &UiCommandRequest) -> Result<(), String> {
        let project_id =
            payload_text_default(&request.payload, "projectId", &self.selected_project_id);
        let project = self.store.get_project(&project_id).map_err(store_message)?;
        let goal = payload_text_default(&request.payload, "goal", "Explore a GoalPort campaign");
        let title = payload_text_default(&request.payload, "title", &goal);
        let acceptance = payload_text_default(
            &request.payload,
            "acceptance",
            "Persist ordered Runtime events and recover without replay.",
        );
        let campaign_id = format!("campaign-{}", stable_suffix(&request.request_id));
        let task_id = format!("task-{}", stable_suffix(&request.request_id));
        let campaign = Campaign {
            id: campaign_id.clone(),
            goal,
            root_task_id: task_id.clone(),
            state: crate::domain::WorkStatus::InProgress,
        };
        let task = Task {
            id: task_id.clone(),
            campaign_id: campaign_id.clone(),
            title,
            acceptance,
            state: crate::domain::WorkStatus::InProgress,
        };
        self.store
            .create_campaign_with_task(&project.id, &campaign, &task)
            .map_err(store_message)?;
        let snapshot_payload = json!({
            "campaignId": campaign_id,
            "goal": campaign.goal,
            "providerAuthorized": true,
            "transferAuthorized": true,
            "actionAuthorized": true
        });
        self.store
            .insert_policy_snapshot(
                &format!("policy-{}", stable_suffix(&request.request_id)),
                &campaign_id,
                &snapshot_payload.to_string(),
            )
            .map_err(store_message)?;
        self.store
            .set_campaign_authorization(&campaign_id, &CampaignAuthorization::granted())
            .map_err(store_message)?;
        self.selected_project_id = project.id;
        self.selected_campaign_id = Some(campaign_id);
        self.selected_task_id = Some(task_id);
        self.selected_attempt_id = None;
        self.notices.insert(
            0,
            "Campaign and root Task committed atomically by Core".into(),
        );
        Ok(())
    }

    fn workspace_for_campaign(&self, campaign_id: &str) -> Result<String, String> {
        let project_id = self
            .store
            .campaign_project(campaign_id)
            .map_err(store_message)?
            .ok_or_else(|| format!("campaign {campaign_id} has no owning project"))?;
        Ok(self
            .store
            .get_project(&project_id)
            .map_err(store_message)?
            .workspace_root)
    }

    fn workspace_for_attempt(&self, attempt_id: &str) -> Result<String, String> {
        let attempt = self.store.get_attempt(attempt_id).map_err(store_message)?;
        let task = self
            .store
            .get_task(&attempt.task_id)
            .map_err(store_message)?;
        self.workspace_for_campaign(&task.campaign_id)
    }

    /// Re-check a held Stop responsibility against current facts.
    ///
    /// This is a read-and-append operation: it observes, writes one row to the
    /// append-only fact ledger, and returns it. It never writes
    /// `stop_responsibilities`, so it can neither release nor downgrade anything —
    /// a re-check reports, it does not decide.
    ///
    /// The mapping below is five disjoint rows, and the split that matters is
    /// between the RECORD side and the OBSERVATION side. "We never recorded an
    /// identity" and "the process we recorded is gone" are different facts, and
    /// collapsing them is how a re-check would manufacture a safe-looking
    /// conclusion for exactly the least certain holds. Two such holds are
    /// reachable today: `resolve_stop` records `pid: 0` with empty creation date
    /// and SHA-256 when the child identity was not observable, and the
    /// uncertain-send hold emits no Stop event at all. Feeding pid 0 to
    /// `observe_process` yields an OpenProcess failure, which would otherwise
    /// render as "the bound runtime is gone".
    ///
    /// So row 1 short-circuits BEFORE `observe_process` is called: with nothing
    /// recorded there is nothing to observe. `not-running` is reachable only from
    /// a real `NotRunning` on a real recorded identity.
    fn recheck_stop_responsibility(
        &mut self,
        request: &UiCommandRequest,
    ) -> Result<Value, String> {
        let attempt_id = payload_text_default(
            &request.payload,
            "attemptId",
            self.selected_attempt_id.as_deref().unwrap_or_default(),
        );
        let held = self
            .store
            .stop_responsibility_for_attempt(&attempt_id)
            .map_err(store_message)?
            .ok_or_else(|| {
                format!("no durable Stop responsibility is held for attempt {attempt_id}")
            })?;

        let bound = self.bound_runtime_identity(&attempt_id, &held.operation_id)?;
        let (observation, verdict, detail) = classify_recheck(&bound);

        let leases = self.store.leases().map_err(store_message)?;
        let active_leases = leases
            .iter()
            .filter(|lease| {
                crate::domain::workspace_keys_overlap(&lease.workspace_key, &held.workspace_key)
                    && matches!(lease.state, crate::domain::LeaseState::Active | crate::domain::LeaseState::Uncertain)
            })
            .count() as i64;
        let pending_outbox = self
            .store
            .outbox_for_attempt(&attempt_id)
            .map_err(store_message)?
            .iter()
            .filter(|intent| !matches!(intent.state, crate::domain::OutboxState::Succeeded))
            .count() as i64;
        let attempt_state = self
            .store
            .get_attempt(&attempt_id)
            .map(|attempt| format!("{:?}", attempt.state))
            .unwrap_or_else(|_| "UNKNOWN".into());
        let core_epoch_id = self
            .store
            .latest_core_launch_epoch()
            .map_err(store_message)?
            .map(|epoch| epoch.epoch_id)
            .unwrap_or_default();

        let recorded = self
            .store
            .record_recheck_observation(&NewRecheckObservation {
                id: format!("recheck-{}", stable_suffix(&request.request_id)),
                attempt_id: attempt_id.clone(),
                operation_id: held.operation_id.clone(),
                workspace_key: held.workspace_key.clone(),
                core_epoch_id,
                bound_runtime: bound.clone(),
                runtime_observation: observation,
                observation_detail: detail,
                active_lease_count: active_leases,
                pending_outbox_count: pending_outbox,
                attempt_state,
                verdict,
            })
            .map_err(store_message)?;

        // The responsibility is deliberately re-read AFTER the write, so the
        // returned receipt shows what the re-check did not change.
        let after = self
            .store
            .stop_responsibility_for_attempt(&attempt_id)
            .map_err(store_message)?;
        Ok(json!({
            "observation": recorded,
            "responsibilityUnchanged": after.map(|row| json!({
                "nativeTurnState": stop_native_turn_state_str(row.native_turn_state),
                "residualExecutionState": row.residual_execution_state,
                "writeResponsibility": row.write_responsibility,
            })),
        }))
    }

    /// Carry the work of a held Attempt into a workspace that does not overlap it.
    ///
    /// This is the delivered continuation path, and it works for an unglamorous
    /// reason: a disjoint workspace was never blocked. Nothing here unblocks
    /// anything, no enforcement predicate is consulted differently, and the source
    /// responsibility stays held with its row untouched.
    ///
    /// What it carries is the WORK -- `title`, `acceptance`, `goal` -- and what it
    /// deliberately does not carry is the TURN: no provider session, no prompt, no
    /// permission decision, no event history. Re-using any of those would make a new
    /// Attempt impersonate a native resume.
    fn continue_in_isolated_workspace(
        &mut self,
        request: &UiCommandRequest,
    ) -> Result<Value, String> {
        let source_attempt_id = payload_text_default(
            &request.payload,
            "attemptId",
            self.selected_attempt_id.as_deref().unwrap_or_default(),
        );
        let held = self
            .store
            .stop_responsibility_for_attempt(&source_attempt_id)
            .map_err(store_message)?
            .ok_or_else(|| {
                format!("no durable Stop responsibility is held for attempt {source_attempt_id}")
            })?;

        // (iv) The decision must rest on a CURRENT observation. A stale basis, or one
        // from a previous Core epoch, is refused: "I checked, some time ago, before a
        // restart" is not a current fact.
        let basis = self
            .store
            .latest_recheck_observation(&source_attempt_id)
            .map_err(store_message)?
            .ok_or("continuation requires a re-check first; none has been recorded")?;
        let current_epoch = self
            .store
            .latest_core_launch_epoch()
            .map_err(store_message)?
            .map(|epoch| epoch.epoch_id)
            .unwrap_or_default();
        if basis.core_epoch_id != current_epoch {
            return Err(format!(
                "the most recent re-check was taken under Core epoch {} but this Core is {}; \
                 re-check again before continuing",
                basis.core_epoch_id, current_epoch
            ));
        }
        let age_ms = store::epoch_millis()
            .parse::<i128>()
            .unwrap_or_default()
            .saturating_sub(basis.observed_at.parse::<i128>().unwrap_or_default());
        let fresh_ms: i128 = std::env::var("GOALPORT_RECHECK_FRESH_MS")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(120_000);
        if age_ms > fresh_ms {
            return Err(format!(
                "the most recent re-check is {age_ms} ms old (limit {fresh_ms} ms); \
                 re-check again before continuing"
            ));
        }

        // (v) Single-use, checked HERE -- before anything is created.
        //
        // The UNIQUE(source_attempt_id) constraint alone is not enough, and shipping it
        // alone was a real defect: it fires on the LAST step, after this method has
        // already created a directory, a Project, a Campaign, a Task, a policy snapshot,
        // an Attempt, and granted the campaign all three authorization flags. None of
        // that rolls back. A repeat click was refused in words while leaving a fully
        // authorized campaign behind, with no decision record, no disclosure and no link
        // to its source -- precisely the "a repeat click must not quietly create new
        // authority" case. Found in this run's own acceptance databases: one continuation
        // row, two granted authorization triples.
        //
        // The constraint stays as a backstop; this is the check that means anything.
        if let Some(existing) = self
            .store
            .stop_continuations_for_source(&source_attempt_id)
            .map_err(store_message)?
            .first()
        {
            return Err(format!(
                "attempt {source_attempt_id} already has a continuation, in {}. A repeat click, a reopened window or a replayed request never mints a second one; continue working there, or take a new decision explicitly.",
                existing.target_workspace_key
            ));
        }

        let source_task = self
            .store
            .get_task(&self.store.get_attempt(&source_attempt_id).map_err(store_message)?.task_id)
            .map_err(store_message)?;
        let source_campaign = self
            .store
            .get_campaign(&source_task.campaign_id)
            .map_err(store_message)?;

        let target_raw = payload_text(&request.payload, "targetWorkspace")
            .map_err(|_| "continuation requires a targetWorkspace".to_string())?;
        let target_path = PathBuf::from(&target_raw);
        if target_path.exists() && !target_path.is_dir() {
            return Err(format!(
                "target workspace {target_raw} exists but is not a directory"
            ));
        }
        // Deliberately NOT created yet. Every refusal below must be able to fire without
        // this method having touched the filesystem: a continuation refused for
        // overlapping a held workspace was otherwise creating its target directory
        // INSIDE that held workspace before saying no.
        let target_key = crate::domain::normalize_workspace_key(&target_path);

        // (i) Disjointness, decided by the SAME predicate the enforcement path uses.
        // Checked against EVERY held responsibility, not just the source one: a
        // continuation must not land inside somebody else's blocked workspace.
        for row in self.store.stop_responsibilities().map_err(store_message)? {
            if crate::domain::workspace_keys_overlap(&row.workspace_key, &target_key) {
                return Err(format!(
                    "target workspace overlaps a held Stop responsibility ({} held by attempt {}, \
                     operation {}); choose a workspace that does not overlap any held one",
                    row.workspace_key, row.attempt_id, row.operation_id
                ));
            }
        }
        for lease in self.store.leases().map_err(store_message)? {
            if matches!(
                lease.state,
                crate::domain::LeaseState::Active | crate::domain::LeaseState::Uncertain
            ) && crate::domain::workspace_keys_overlap(&lease.workspace_key, &target_key)
            {
                return Err(format!(
                    "target workspace overlaps a {:?} lease held by attempt {}",
                    lease.state, lease.attempt_id
                ));
            }
        }

        let suffix = stable_suffix(&request.request_id);
        let new_project_id = format!("project-cont-{suffix}");
        let new_campaign_id = format!("campaign-cont-{suffix}");
        let new_task_id = format!("task-cont-{suffix}");
        let new_attempt_id = format!("attempt-cont-{suffix}");

        // (ii) The collision guard. `select_runtime` REPLACES its map entry, dropping
        // the previous ManagedRuntime, and for Claude that Drop reaches child.kill().
        // A continuation that reused the held attempt id would therefore force-kill
        // the residual process with no event and no record. Refuse; never replace.
        if self.runtime_manager.has_attempt(&new_attempt_id)
            || new_attempt_id == source_attempt_id
        {
            return Err(format!(
                "continuation refused: a live runtime is already registered under \
                 {new_attempt_id}; continuing would replace and kill it"
            ));
        }

        // Every refusal has now had its say, so the filesystem may be touched.
        fs::create_dir_all(&target_path)
            .map_err(|error| format!("could not create target workspace: {error}"))?;

        self.store
            .insert_project(&Project {
                id: new_project_id.clone(),
                workspace_root: target_path.to_string_lossy().to_string(),
            })
            .map_err(store_message)?;
        let campaign = Campaign {
            id: new_campaign_id.clone(),
            goal: source_campaign.goal.clone(),
            root_task_id: new_task_id.clone(),
            state: crate::domain::WorkStatus::InProgress,
        };
        let task = Task {
            id: new_task_id.clone(),
            campaign_id: new_campaign_id.clone(),
            title: source_task.title.clone(),
            acceptance: source_task.acceptance.clone(),
            state: crate::domain::WorkStatus::InProgress,
        };
        self.store
            .create_campaign_with_task(&new_project_id, &campaign, &task)
            .map_err(store_message)?;

        // The authorization grant, named in full. `CampaignAuthorization::granted()`
        // sets all three flags, and the continuation needs at least provider+action
        // for any real work (send_message and permission Allow both gate on that
        // pair) and transfer for handoff. Disclosing only `provider_authorized` would
        // understate the one authorization surface a continuation creates.
        let authorization = CampaignAuthorization::granted();
        let authorization_granted = json!({
            "campaignId": new_campaign_id,
            "providerAuthorized": authorization.provider_authorized,
            "actionAuthorized": authorization.action_authorized,
            "transferAuthorized": authorization.transfer_authorized,
            "scope": "the new campaign only; the source campaign's authorization row is untouched",
            "consequences": "the new campaign may send work, approve tool permissions, and hand off",
        });
        self.store
            .insert_policy_snapshot(
                &format!("policy-cont-{suffix}"),
                &new_campaign_id,
                &json!({
                    "campaignId": new_campaign_id,
                    "goal": campaign.goal,
                    "providerAuthorized": true,
                    "transferAuthorized": true,
                    "actionAuthorized": true,
                    "note": "explanatory record written alongside the grant; not itself authorization",
                })
                .to_string(),
            )
            .map_err(store_message)?;
        self.store
            .set_campaign_authorization(&new_campaign_id, &authorization)
            .map_err(store_message)?;
        self.store
            .insert_attempt(&Attempt::new(
                &new_attempt_id,
                &new_task_id,
                &held.provider,
                &format!("{}-cap-v1", held.provider),
            ))
            .map_err(store_message)?;

        let carried_context = json!({
            "title": task.title,
            "acceptance": task.acceptance,
            "goal": campaign.goal,
            "notCarried": [
                "provider_session", "prompt text", "permission decisions", "event history",
                "attempt id", "campaign id", "task id", "work state"
            ],
        });
        let isolation_disclosure = json!({
            "controlled":
                "GoalPort will not admit a runtime, send, grant a permission Allow, hand off, \
                 resume, acquire or release a lease, or dispatch an outbox intent into any \
                 workspace that path-overlaps a held responsibility. This Attempt has a new \
                 native session, a new recorded identity, and a workspace key with no \
                 ancestor or descendant relationship to the held one.",
            "residualCanStillWriteHere":
                "GoalPort is not an OS sandbox. A residual process or descendant left over from \
                 the interrupted turn holds ordinary file-system rights and can write anywhere \
                 you can, including into this new workspace.",
            "notEvidenceOfIsolation":
                "Changing directory, database, session, provider or Core epoch is not evidence \
                 of isolation and does not release the original hold, which stays held.",
            "sourceWorkspaceStillHeld": held.workspace_key,
        });
        let continuation = self
            .store
            .record_stop_continuation(&store::StopContinuation {
                id: format!("continuation-{suffix}"),
                source_attempt_id: source_attempt_id.clone(),
                source_operation_id: held.operation_id.clone(),
                source_task_id: source_task.id.clone(),
                source_campaign_id: source_campaign.id.clone(),
                source_workspace_key: held.workspace_key.clone(),
                target_workspace_key: target_key.clone(),
                new_attempt_id: new_attempt_id.clone(),
                new_project_id: new_project_id.clone(),
                new_campaign_id: new_campaign_id.clone(),
                new_task_id: new_task_id.clone(),
                basis_observation_id: basis.id.clone(),
                carried_context,
                authorization_granted,
                isolation_disclosure,
                decided_at: store::epoch_millis(),
                applied_at: store::epoch_millis(),
            })
            .map_err(store_message)?;

        // Labelled for what it is. Never `runtime.session.resumed`: this is new work
        // that inherits a description, not a resumed native turn.
        self.persist_event(
            &new_attempt_id,
            "attempt.continuation.isolated",
            json!({
                "sourceAttemptId": source_attempt_id,
                "sourceOperationId": held.operation_id,
                "basisObservationId": basis.id,
                "targetWorkspaceKey": target_key,
                "nativeResume": false,
                "promptReplayed": false,
                "permissionReused": false,
            }),
            None,
        )?;

        self.selected_project_id = new_project_id;
        self.selected_campaign_id = Some(new_campaign_id);
        self.selected_task_id = Some(new_task_id);
        self.selected_attempt_id = Some(new_attempt_id);

        let still_held = self
            .store
            .stop_responsibility_for_attempt(&source_attempt_id)
            .map_err(store_message)?
            .ok_or("the source responsibility disappeared during continuation")?;
        Ok(json!({
            "continuation": continuation,
            "sourceResponsibilityUnchanged": {
                "attemptId": still_held.attempt_id,
                "workspaceKey": still_held.workspace_key,
                "nativeTurnState": stop_native_turn_state_str(still_held.native_turn_state),
                "residualExecutionState": still_held.residual_execution_state,
                "writeResponsibility": still_held.write_responsibility,
            },
        }))
    }

    /// Read the bound runtime identity recorded at Stop time.
    ///
    /// It does not live in `binding_json` — that carries only
    /// `{input_uuid, session_id, turn_epoch, process_epoch}`. pid, creation date
    /// and executable SHA-256 are emitted into the Stop event payload under
    /// `stop_attempt` by `stop_trace()`. There is no executable PATH there, only
    /// the SHA-256. Returns `Value::Null` when no such payload exists.
    fn bound_runtime_identity(
        &self,
        attempt_id: &str,
        operation_id: &str,
    ) -> Result<Value, String> {
        let records = self
            .store
            .list_event_records(attempt_id, 0)
            .map_err(store_message)?;
        for record in records.iter().rev() {
            let Some(payload) = record.payload.as_ref() else {
                continue;
            };
            let Some(trace) = payload.get("stop_attempt") else {
                continue;
            };
            if trace.get("operation_id").and_then(Value::as_str) != Some(operation_id) {
                continue;
            }
            return Ok(json!({
                "pid": trace.get("bound_pid").cloned().unwrap_or(Value::Null),
                "creationDate": trace.get("bound_creation_date").cloned().unwrap_or(Value::Null),
                "executableSha256": trace
                    .get("bound_executable_sha256")
                    .cloned()
                    .unwrap_or(Value::Null),
                "source": "stop_attempt",
            }));
        }
        Ok(Value::Null)
    }

    /// Attach the context a responsibility row cannot carry on its own: which task
    /// and campaign are blocked, the newest re-check, and -- the part that keeps the
    /// panel honest -- whether this hold governs the workspace on screen.
    fn decorate_hold(
        &self,
        row: StopResponsibility,
        blocks_current_workspace: bool,
    ) -> Result<UiStopResponsibility, String> {
        let (task_title, campaign_goal) = match self.store.get_attempt(&row.attempt_id) {
            Ok(attempt) => match self.store.get_task(&attempt.task_id) {
                Ok(task) => {
                    let goal = self
                        .store
                        .get_campaign(&task.campaign_id)
                        .map(|campaign| campaign.goal)
                        .unwrap_or_default();
                    (task.title, goal)
                }
                Err(_) => (String::new(), String::new()),
            },
            Err(_) => (String::new(), String::new()),
        };
        let latest_recheck = self
            .store
            .latest_recheck_observation(&row.attempt_id)
            .map_err(store_message)?
            .and_then(|observation| serde_json::to_value(observation).ok());
        Ok(stop_responsibility_to_ui_with(
            row,
            StopResponsibilityContext {
                task_title,
                campaign_goal,
                blocks_current_workspace,
                latest_recheck,
            },
        ))
    }

    fn ensure_workspace_ingress_allowed(
        &self,
        workspace: &str,
        action: &str,
    ) -> Result<(), String> {
        if let Some(held) = self
            .store
            .held_stop_for_workspace(workspace)
            .map_err(store_message)?
        {
            return Err(format!(
                "{action} blocked by durable Stop responsibility held for attempt {} (operation {}); residual execution is {}",
                held.attempt_id, held.operation_id, held.residual_execution_state
            ));
        }
        Ok(())
    }

    fn select_runtime(&mut self, request: &UiCommandRequest) -> Result<(), String> {
        if (std::env::var("GOALPORT_RESOURCE_PRESSURE").ok().as_deref() == Some("1")
            || payload_bool(&request.payload, "resourcePressure"))
            && self.selected_attempt_id.is_some()
        {
            return self.enqueue_runtime_request(request);
        }
        self.admit_runtime(request)
    }

    fn enqueue_runtime_request(&mut self, request: &UiCommandRequest) -> Result<(), String> {
        let project_id =
            payload_text_default(&request.payload, "projectId", &self.selected_project_id);
        let campaign_id = payload_text_default(
            &request.payload,
            "campaignId",
            self.selected_campaign_id.as_deref().unwrap_or_default(),
        );
        let project = self.store.get_project(&project_id).map_err(store_message)?;
        self.ensure_workspace_ingress_allowed(&project.workspace_root, "runtime queue admission")?;
        let campaign = self
            .store
            .get_campaign(&campaign_id)
            .map_err(store_message)?;
        let task_id = payload_text_default(&request.payload, "taskId", &campaign.root_task_id);
        let task = self.store.get_task(&task_id).map_err(store_message)?;
        if task.campaign_id != campaign.id {
            return Err("task does not belong to selected campaign".into());
        }
        let provider =
            payload_text_default(&request.payload, "provider", "scenario").to_ascii_lowercase();
        let attempt_id = resolve_admission_attempt_id(
            &self.store,
            &self.runtime_manager,
            &request.payload,
            &task.id,
            &provider,
            &request.request_id,
            false,
        )?;
        let mut stored = request.payload.clone();
        if let Some(obj) = stored.as_object_mut() {
            obj.insert("projectId".into(), json!(project_id));
            obj.insert("campaignId".into(), json!(campaign_id));
            obj.insert("taskId".into(), json!(task.id));
            obj.insert("provider".into(), json!(provider));
            obj.insert("attemptId".into(), json!(attempt_id));
            obj.remove("resourcePressure");
        }
        let queue_id = format!("queue-{}", stable_suffix(&request.request_id));
        let stored_json = stored.to_string();
        self.store
            .enqueue_admission(
                &queue_id,
                Some(attempt_id.as_str()),
                "resource-pressure",
                Some(stored_json.as_str()),
            )
            .map_err(store_message)?;
        self.notices.insert(
            0,
            "New Attempt queued under resource pressure; existing Runtime and Core were not killed"
                .into(),
        );
        Ok(())
    }

    fn admit_runtime(&mut self, request: &UiCommandRequest) -> Result<(), String> {
        let project_id =
            payload_text_default(&request.payload, "projectId", &self.selected_project_id);
        let project = self.store.get_project(&project_id).map_err(store_message)?;
        self.ensure_workspace_ingress_allowed(&project.workspace_root, "runtime admission")?;
        // The selection is committed only at the end of this function, after every fallible
        // step of the admission (see the commit below the event persistence). Calling
        // `select_project` here moved `selected_project_id` and cleared the campaign, task and
        // attempt selection BEFORE any refusal point, so a refused admission changed what the
        // user had selected. `get_project` above already validates the project exists.
        //
        // The `campaignId` fallback is deliberately the empty string: before this change
        // `select_project` had just cleared `selected_campaign_id` at this point, so an omitted
        // `campaignId` has always resolved to "" and been refused by the campaign lookup. Keeping
        // that default means the reorder changes when the selection is committed, not what an
        // incomplete payload does.
        let campaign_id = payload_text_default(&request.payload, "campaignId", "");
        let campaign = self
            .store
            .get_campaign(&campaign_id)
            .map_err(store_message)?;
        let owner = self
            .store
            .campaign_project(&campaign_id)
            .map_err(store_message)?;
        if owner.as_deref() != Some(project_id.as_str()) {
            return Err("campaign does not belong to selected project".into());
        }
        let task_id = payload_text_default(&request.payload, "taskId", &campaign.root_task_id);
        let task = self.store.get_task(&task_id).map_err(store_message)?;
        if task.campaign_id != campaign.id {
            return Err("task does not belong to selected campaign".into());
        }
        let auth = self
            .store
            .get_campaign_authorization(&campaign_id)
            .map_err(store_message)?;
        if !auth.provider_authorized {
            return Err("current campaign authorization denies provider attach; historical PolicySnapshot is explanatory only".into());
        }
        let provider =
            payload_text_default(&request.payload, "provider", "scenario").to_ascii_lowercase();
        let attempt_id = resolve_admission_attempt_id(
            &self.store,
            &self.runtime_manager,
            &request.payload,
            &task.id,
            &provider,
            &request.request_id,
            true,
        )?;
        let executable = payload_text(&request.payload, "executable")
            .ok()
            .map(PathBuf::from);
        let workspace = PathBuf::from(
            self.store
                .get_project(&project_id)
                .map_err(store_message)?
                .workspace_root,
        );
        let default_version = runtime_version(&provider);
        let version = payload_text_default(&request.payload, "version", &default_version);
        // The admission decision is taken BEFORE the first write. `intended_binding`
        // refuses an unknown provider (and an invalid Codex approval policy) here,
        // so no Attempt row is left behind by a request that could never register.
        let intended = RuntimeManager::intended_binding(
            &provider,
            executable.clone(),
            version.clone(),
            &workspace,
        )
        .map_err(|error| error.to_string())?;
        if let Some(existing) = self.runtime_manager.registered_binding(&attempt_id) {
            // A Runtime is already registered under this attempt id. Either this is
            // the user legitimately re-selecting the same binding, which returns the
            // existing selection without creating a Runtime, session or Attempt, or
            // it is a different binding, which is an explicit conflict. In no case is
            // the existing Runtime replaced, and nothing below is written.
            if *existing != intended {
                return Err(format!(
                    "attempt {attempt_id} is already bound to a different Runtime binding; \
                     the existing Runtime is kept and the request is refused"
                ));
            }
            let row = self.store.get_attempt(&attempt_id).map_err(store_message)?;
            if row.task_id != task.id {
                return Err(format!(
                    "attempt {attempt_id} is registered for another task; the request is refused"
                ));
            }
            if !matches!(
                row.state,
                AttemptState::Active | AttemptState::AwaitingReview
            ) {
                return Err(format!(
                    "attempt {attempt_id} has a registered Runtime but its session was never \
                     established (state {}); it is kept, not replaced, and not retried automatically",
                    attempt_state_label(row.state)
                ));
            }
            // Increment 4: a registration whose initialization did not complete is kept, but
            // it is not a usable Runtime to hand back as a reuse, whatever state the row
            // reached — a failure after `attempt.active` (the session events) leaves it Active
            // with a live process. The row's most recent admission-failure record decides;
            // later unrelated events (a recovery classification, runtime events) do not
            // complete the initialization and do not lift this refusal.
            // Increment 5: the kept-failure record constrains only the registration it belongs
            // to. The registration that failed stays refused for its lifetime (same identity);
            // any other registration under this id — a Core restart re-registers through resume
            // or the send path — is handed back only when its OWN initialization or recovery
            // success was recorded by that entry; a different identity alone, or a success
            // record that belongs to another registration, is not success. An unnamed current
            // registration is refused too.
            if let Some((stage, failed_identity)) = self.last_admission_failure_kept(&attempt_id)? {
                let current = self
                    .runtime_manager
                    .registration_identity(&attempt_id)
                    .unwrap_or_default();
                if current.is_empty() || failed_identity.as_deref() == Some(current.as_str()) {
                    return Err(format!(
                        "attempt {attempt_id} has a registered Runtime whose initialization did not \
                         complete (stage {stage}); it is kept, not replaced, and not retried automatically"
                    ));
                }
                if !self.registration_established(&attempt_id, &current)? {
                    return Err(format!(
                        "attempt {attempt_id} has a registered Runtime whose initialization or recovery \
                         success is not recorded while an earlier registration's initialization failed \
                         (stage {stage}); it is kept, not replaced, and not retried automatically"
                    ));
                }
            }
            if self.runtime_manager.registration_live(&attempt_id) != Some(true) {
                // Increment 6: distinguish a closed output stream (the process may still be
                // running) from a confirmed exit, but only for Codex and only when the child has
                // not been confirmed exited; a reaped child keeps the existing "no longer live"
                // text (so recovery_classification's live-refusal path is unchanged).
                if provider.eq_ignore_ascii_case("codex")
                    && !matches!(
                        self.runtime_manager.confirm_process_identity(&attempt_id),
                        Some(crate::runtime_manager::ProcessConfirmation::Exited { .. })
                    )
                    && let Some(TransportState::Closed { reason }) =
                        self.runtime_manager.transport_state(&attempt_id)
                {
                    return Err(format!(
                        "attempt {attempt_id} has a registered Runtime whose output stream is \
                         closed ({reason}) while its process may still be running; it is kept, not \
                         replaced, and not retried automatically"
                    ));
                }
                return Err(format!(
                    "attempt {attempt_id} has a registered Runtime that is no longer live; \
                     it is kept, not replaced"
                ));
            }
            // Idempotent reuse: only the selection is committed. No store write, no
            // runtime call, no event; reuse grants nothing the checks above denied.
            self.selected_project_id = project.id;
            self.selected_campaign_id = Some(campaign.id);
            self.selected_task_id = Some(task.id);
            self.selected_attempt_id = Some(attempt_id);
            return Ok(());
        }
        // Retry gate (increment 4). A row may already exist for this attempt id without any
        // registration. The one case admitted again here is a previous admission whose
        // initialization failed before any process was spawned, whose registration was
        // withdrawn and whose most recent admission-failure record says exactly that: it
        // continues below through the same path with a fresh registration, every check above
        // having run again. Every other
        // existing row keeps the `insert_attempt` behaviour: idempotent for an identical row,
        // refused as a duplicate otherwise. A row whose record says the registration was kept
        // (a process was spawned), an Active row without a registration (a Core restart), a
        // row for another task or provider are therefore not retried by this command.
        let retry_of_withdrawn_failure = match self.store.get_attempt(&attempt_id) {
            Ok(row) => {
                row.task_id == task.id
                    && row.provider == provider
                    && row.state == AttemptState::Queued
                    && self.last_admission_failure_was_withdrawn(&attempt_id, &provider)?
            }
            Err(_) => false,
        };
        if !retry_of_withdrawn_failure {
            let attempt = Attempt::new(
                &attempt_id,
                &task.id,
                &provider,
                format!("{provider}-cap-v1"),
            );
            let created_new = self.store.get_attempt(&attempt_id).is_err();
            self.store.insert_attempt(&attempt).map_err(store_message)?;
            if created_new {
                let mut created = json!({ "provider": provider });
                if let Ok(source_id) = payload_text(&request.payload, "attemptId") {
                    if source_id != attempt_id {
                        if let Ok(source) = self.store.get_attempt(&source_id) {
                            if source.state.is_terminal() && source.task_id == task.id {
                                created["rolledFrom"] = json!(source_id);
                            }
                        }
                    }
                }
                self.persist_event(&attempt_id, "attempt.created", created, None)?;
            }
        }
        // The registration stage needs no compensation of its own: `attempts` and
        // `registrations` are inserted and removed together, so an occupied key is
        // unreachable after the reuse decision above; the provider and approval-policy
        // refusals were already taken by `intended_binding`; a blank id was rejected by the
        // Attempt validation inside `insert_attempt` before any row was written.
        let identity = self
            .runtime_manager
            .select_runtime(&attempt_id, &provider, executable, version, &workspace)
            .map_err(|error| error.to_string())?;
        // The registration this command just created, by its sequence number: the only
        // registration the failure branch below may withdraw.
        let registration_seq = self
            .runtime_manager
            .registration_seq(&attempt_id)
            .ok_or_else(|| {
                format!("attempt {attempt_id} was registered without a sequence number")
            })?;
        // The persisted name of this registration: a failure record written below names it, so
        // the record can later be attributed to this registration and to no other.
        let registration_identity = self
            .runtime_manager
            .registration_identity(&attempt_id)
            .unwrap_or_default();
        if let Err((stage, error)) = self.initialize_admitted_runtime(
            &attempt_id,
            &campaign.id,
            &task.id,
            workspace,
            &identity.provider,
        ) {
            return Err(self.record_admission_failure(
                &attempt_id,
                &provider,
                registration_seq,
                &registration_identity,
                stage,
                error,
            ));
        }
        // Commit the selection last, after every fallible step of the admission. Any error
        // returned above leaves the four fields exactly as they were before the command.
        self.selected_project_id = project.id;
        self.selected_campaign_id = Some(campaign.id);
        self.selected_task_id = Some(task.id);
        self.selected_attempt_id = Some(attempt_id);
        Ok(())
    }

    /// The steps of `admit_runtime` that run after the registration exists: the session, the
    /// provider session id, the `attempt.active` transition and the session events. Returns
    /// the failing stage with its error so `admit_runtime` can compensate for the registration
    /// it created. The steps themselves are unchanged.
    fn initialize_admitted_runtime(
        &mut self,
        attempt_id: &str,
        campaign_id: &str,
        task_id: &str,
        workspace: PathBuf,
        provider_label: &str,
    ) -> Result<(), (&'static str, String)> {
        let session = self
            .runtime_manager
            .create_session(
                attempt_id,
                &SessionRequest {
                    campaign_id: Some(campaign_id.to_owned()),
                    task_id: task_id.to_owned(),
                    attempt_id: attempt_id.to_owned(),
                    workspace_root: workspace,
                    resume_session: None,
                },
            )
            .map_err(|error| ("create_session", error.to_string()))?;
        if !session.handle.session_id.trim().is_empty()
            && !session.handle.session_id.starts_with("claude-session-")
        {
            self.store
                .set_attempt_provider_session(attempt_id, &session.handle.session_id)
                .map_err(|error| ("provider_session", store_message(error)))?;
        }
        if self
            .store
            .get_attempt(attempt_id)
            .map_err(|error| ("attempt_active", store_message(error)))?
            .state
            == AttemptState::Queued
        {
            self.persist_event(
                attempt_id,
                "attempt.active",
                json!({ "provider": provider_label, "session": "[RUNTIME_SESSION]" }),
                Some(AttemptState::Active),
            )
            .map_err(|error| ("attempt_active", error))?;
        }
        for event in session.events {
            self.persist_agent_event(&event)
                .map_err(|error| ("session_events", error))?;
        }
        Ok(())
    }

    /// Compensation for a failed initialization of the registration `admit_runtime` just
    /// created (increment 4): the registration is withdrawn only when it is still that
    /// registration and no process was ever spawned for it; otherwise it is kept untouched
    /// (nothing killed, released, replaced or re-launched). Either way an
    /// `attempt.admission.failed` record is appended to the row with the state unchanged — the
    /// domain has no `Queued -> Failed` transition; the row is `Queued` after a failure before
    /// `attempt.active` and `Active` after a failure at the session events, and the record and
    /// the message report whichever it is — and the returned message says which of the two
    /// happened and what a retry needs. If the record itself cannot be written, the message
    /// names both failures and promises no retry path: without the record the retry gate does
    /// not take the row.
    fn record_admission_failure(
        &mut self,
        attempt_id: &str,
        provider: &str,
        registration_seq: u64,
        registration_identity: &str,
        stage: &'static str,
        error: String,
    ) -> String {
        // Increment 6: if the failure was an observed Codex transport closure, name it in the
        // record (before the withdrawal, while the registration is certainly present). This is the
        // boundary-(1) create-side reason; a pre-establishment closure writes no separate
        // `runtime.transport.closed` event.
        let transport = if provider.eq_ignore_ascii_case("codex") {
            match self.runtime_manager.transport_state(attempt_id) {
                Some(TransportState::Closed { reason }) => json!({ "closed": true, "reason": reason }),
                _ => json!({ "closed": false }),
            }
        } else {
            Value::Null
        };
        let withdrawal = self
            .runtime_manager
            .withdraw_unstarted_registration(attempt_id, registration_seq);
        let (registration, process, retry, pid) = match &withdrawal {
            Ok(RegistrationWithdrawal::Withdrawn) => {
                ("withdrawn", "not-started", "explicit-reselect", None)
            }
            Ok(RegistrationWithdrawal::KeptProcessStarted { pid }) => {
                ("kept", "started-or-unconfirmed", "not-retried", *pid)
            }
            Ok(RegistrationWithdrawal::KeptNotOurs { .. }) | Err(_) => {
                ("kept", "started-or-unconfirmed", "not-retried", None)
            }
        };
        // The row's actual state after the failure: Queued for a failure before
        // `attempt.active`, Active for a failure at the session events. The record and the
        // message report it rather than assume it.
        let state = self
            .store
            .get_attempt(attempt_id)
            .map(|row| attempt_state_label(row.state))
            .unwrap_or("UNKNOWN");
        let recorded = self.persist_event(
            attempt_id,
            "attempt.admission.failed",
            json!({
                "stage": stage,
                "error": error,
                "provider": provider,
                "registration": registration,
                "process": process,
                "retry": retry,
                "pid": pid,
                "state": state,
                "registration_identity": registration_identity,
                "transport": transport,
            }),
            None,
        );
        let mut message = if registration == "withdrawn" {
            // The retry gate needs the record; promise the path only when it exists.
            let retry_path = if state == "QUEUED" && recorded.is_ok() {
                "; it may be re-selected explicitly"
            } else {
                ""
            };
            format!(
                "runtime admission failed during {stage}: {error}; the new registration was \
                 withdrawn (no process had been started); attempt {attempt_id} is {state} with \
                 an admission-failure record{retry_path}"
            )
        } else {
            format!(
                "runtime admission failed during {stage}: {error}; the new registration was kept \
                 because its process may have started (not confirmed); nothing was killed, \
                 released or replaced; attempt {attempt_id} is {state} with an admission-failure \
                 record and is not retried automatically"
            )
        };
        if let Err(record_error) = recorded {
            message.push_str(&format!(
                "; the admission-failure record could not be written: {record_error}"
            ));
        }
        message
    }

    /// The payload of the row's MOST RECENT `attempt.admission.failed` record, whatever events
    /// followed it. A later unrelated event (a recovery classification, a runtime event) neither
    /// completes an initialization nor withdraws a registration, so it must not change what the
    /// reuse decision and the retry gate conclude; only a newer admission record supersedes an
    /// older one, and a future initialization-completion path must write its own record.
    fn latest_admission_failure(&self, attempt_id: &str) -> Result<Option<Value>, String> {
        let records = self
            .store
            .list_event_records(attempt_id, 0)
            .map_err(store_message)?;
        Ok(records
            .iter()
            .rev()
            .find(|record| record.event.kind == "attempt.admission.failed")
            .and_then(|record| record.payload.clone()))
    }

    /// The stage and the registration identity named by the row's most recent admission-failure
    /// record when that record says the registration was kept: that registration's
    /// initialization did not complete, so the reuse decision does not hand it back. The
    /// identity is absent on records written before it was recorded; such a record is treated
    /// as belonging to no current registration (the established requirement then applies).
    fn last_admission_failure_kept(
        &self,
        attempt_id: &str,
    ) -> Result<Option<(String, Option<String>)>, String> {
        Ok(self.latest_admission_failure(attempt_id)?.and_then(|payload| {
            (payload["registration"].as_str() == Some("kept")).then(|| {
                (
                    payload["stage"].as_str().unwrap_or("unknown").to_owned(),
                    payload["registration_identity"]
                        .as_str()
                        .filter(|identity| !identity.is_empty())
                        .map(str::to_owned),
                )
            })
        }))
    }

    /// Appends the append-only success record of one registration. Written by each legitimate
    /// re-registration entry only after its own initialization or recovery completed through the
    /// existing path; nothing else writes it, and nothing rewrites it.
    fn persist_registration_established(
        &self,
        attempt_id: &str,
        registration_identity: &str,
        entry: &str,
        provider: &str,
    ) -> Result<(), String> {
        self.persist_event(
            attempt_id,
            "runtime.registration.established",
            json!({
                "registration_identity": registration_identity,
                "entry": entry,
                "provider": provider,
            }),
            None,
        )
    }

    /// Whether a `runtime.registration.established` record names exactly this registration. An
    /// empty identity matches nothing.
    fn registration_established(
        &self,
        attempt_id: &str,
        registration_identity: &str,
    ) -> Result<bool, String> {
        if registration_identity.is_empty() {
            return Ok(false);
        }
        let records = self
            .store
            .list_event_records(attempt_id, 0)
            .map_err(store_message)?;
        Ok(records.iter().any(|record| {
            record.event.kind == "runtime.registration.established"
                && record
                    .payload
                    .as_ref()
                    .and_then(|payload| payload["registration_identity"].as_str())
                    == Some(registration_identity)
        }))
    }

    /// Whether the row's most recent admission-failure record says the registration was
    /// withdrawn AND names the provider being admitted — the one condition under which
    /// `admit_runtime` re-admits an existing `Queued` row. The record's own `provider` field is
    /// compared with the request (the caller has already required the row's provider to equal
    /// the request's): a record that is missing the field, unreadable, or written for another
    /// provider is not a wildcard and does not qualify the row. Through the product the record's
    /// provider always equals the row's; the check guards the persisted state against
    /// inconsistency, not against an actor who can rewrite rows and events together.
    fn last_admission_failure_was_withdrawn(
        &self,
        attempt_id: &str,
        provider: &str,
    ) -> Result<bool, String> {
        Ok(self
            .latest_admission_failure(attempt_id)?
            .is_some_and(|payload| {
                payload["registration"].as_str() == Some("withdrawn")
                    && payload["provider"].as_str() == Some(provider)
            }))
    }

    fn send_message(&mut self, request: &UiCommandRequest) -> Result<bool, String> {
        let attempt_id = payload_text(&request.payload, "attemptId")?;
        let campaign_id = payload_text(&request.payload, "campaignId")?;
        let message = payload_text(&request.payload, "message")?;
        let attempt = self.store.get_attempt(&attempt_id).map_err(store_message)?;
        let task = self
            .store
            .get_task(&attempt.task_id)
            .map_err(store_message)?;
        let campaign = self
            .store
            .get_campaign(&campaign_id)
            .map_err(store_message)?;
        if task.campaign_id != campaign.id {
            return Err("attempt task does not belong to campaign".into());
        }
        // Increment 7: a repeated request is answered from its RECORDED result before workspace
        // resolution and every environment gate below (ingress, Core selection, terminality,
        // turn in flight, authorization) can flip that result, and before anything is delivered.
        // Only a row whose identity (attempt, kind, payload hash) matches this request qualifies;
        // a same-id different-content request falls through to `record_command_for_request`,
        // which refuses it with IdempotencyConflict exactly as `record_command` did. A
        // still-`Pending` row never delivered anything (`message.user` and every `send_prompt`
        // come after the Executing transition), so it also falls through - unless its insert
        // stamp names a DIFFERENT request id, in which case the guard below refuses it as a
        // collision first (plan v12). `get_command` reports a missing row as NotFound.
        let command = send_message_command(&request.request_id, &attempt_id, &message)?;
        match self.store.get_command(&command.command.id) {
            Ok(row) => {
                if row.attempt_id == command.command.attempt_id
                    && row.kind == command.command.kind
                    && row.payload_hash == command.command.payload_hash
                {
                    let result = self
                        .store
                        .command_result(&row.id)
                        .map_err(store_message)?;
                    // Identity is content-bound AND request-bound: `stable_suffix` is lossy, so two
                    // different request ids can share one command id; a row recorded by this
                    // increment names its request id, and a different id is a collision, not a
                    // replay - refused without delivery (rows without a recorded id keep the old
                    // reading, see residual R-O).
                    if !same_request(result.as_ref(), &request.request_id) {
                        return Err(request_collision(&request.request_id, result.as_ref()));
                    }
                    if let Some(answer) = replay_answer(&request.request_id, &row, result.as_ref()) {
                        return answer;
                    }
                }
            }
            Err(StoreError::NotFound(_)) => {}
            Err(error) => return Err(store_message(error)),
        }
        let workspace = self.workspace_for_campaign(&campaign.id)?;
        self.ensure_workspace_ingress_allowed(&workspace, "message send")?;
        if self.selected_attempt_id.as_deref() != Some(attempt_id.as_str()) {
            return Err("attempt is not selected by Core".into());
        }
        // A terminal Attempt is finished: nothing is persisted, no Runtime is
        // reattached, and no new Attempt is invented on the user's behalf.
        if attempt.state.is_terminal() {
            return Err(format!(
                "attempt is terminal ({}); select a Runtime to start a new Attempt",
                attempt_state_label(attempt.state)
            ));
        }
        // One native turn at a time. Refusing here, before any CoreCommand or user event
        // is recorded, keeps a rejected second prompt out of the journal entirely and
        // surfaces it in the GUI as a visible Core refusal.
        if self.runtime_manager.turn_in_flight(&attempt_id) {
            return Err(
                "a Grok turn is already in flight; wait for it to finish or use Safe stop"
                    .to_string(),
            );
        }
        let auth = self
            .store
            .get_campaign_authorization(&campaign.id)
            .map_err(store_message)?;
        if !auth.provider_authorized || !auth.action_authorized {
            return Err("current campaign authorization denies send; historical PolicySnapshot is explanatory only".into());
        }
        let command_id = command.command.id.clone();
        // A new row is stamped with THIS request id at insert (plan v12), so even a Pending row
        // left by a crash before the Executing transition can refuse a colliding request id.
        let persisted = self
            .store
            .record_command_for_request(&command.command, &request.request_id)
            .map_err(store_message)?;
        // Unreachable under the UI lock (the read above would have seen the row), but never
        // again a blind `Ok(true)`: a non-Pending row is answered from its record.
        if persisted.state != CommandState::Pending {
            let result = self
                .store
                .command_result(&persisted.id)
                .map_err(store_message)?;
            if !same_request(result.as_ref(), &request.request_id) {
                return Err(request_collision(&request.request_id, result.as_ref()));
            }
            if let Some(answer) = replay_answer(&request.request_id, &persisted, result.as_ref()) {
                return answer;
            }
        }
        if attempt.state == AttemptState::AwaitingReview {
            self.persist_event(
                &attempt_id,
                "attempt.active",
                json!({ "reason": "new turn started after review checkpoint" }),
                Some(AttemptState::Active),
            )?;
        }
        self.store
            .update_command_state(&command_id, CommandState::Executing)
            .map_err(store_message)?;
        // Increment 7: what this send can actually confirm about delivery, recorded with the
        // terminal command state so a replay answers it. FAILED until the adapter reports the
        // input accepted; UNKNOWN where a write may have crossed the transport unconfirmed.
        let mut delivery = "FAILED";
        let result = (|| -> Result<(), String> {
            let mut user_payload = json!({ "text": message, "requestId": request.request_id });
            if let Some(binding) = self.persist_runtime_epoch_binding(&attempt_id)? {
                let observed_at = store::utc_now_iso();
                user_payload["goalportRuntime"] =
                    runtime_binding_payload(&binding, &observed_at, &observed_at);
            }
            self.persist_event(&attempt_id, "message.user", user_payload, None)?;
            let provider = attempt.provider.clone();
            // Increment 6: a Codex registration whose output stream is closed is not usable. Refuse
            // BEFORE the liveness check, so the `!runtime_live` re-registration path is never
            // entered (no `select_runtime`, no replacement implied) and the input is never sent to
            // a Runtime whose reply can never be read. The registration is kept, not replaced; the
            // failure is reported FAILED and never re-sent.
            if provider.eq_ignore_ascii_case("codex") {
                if let Some(TransportState::Closed { reason }) =
                    self.runtime_manager.transport_state(&attempt_id)
                {
                    self.persist_event(
                        &attempt_id,
                        "runtime.send.failed",
                        json!({
                            "error": format!("Codex output stream is closed ({reason})"),
                            "retry": false,
                            "deliveryState": "FAILED",
                            "transport": reason
                        }),
                        None,
                    )?;
                    return Err(format!(
                        "Codex output stream is closed ({reason}); the registration is kept, not \
                         replaced; the input was not sent"
                    ));
                }
            }
            let workspace = PathBuf::from(
                self.store
                    .get_project(&self.selected_project_id)
                    .map_err(store_message)?
                    .workspace_root,
            );
            let runtime_live = if provider.eq_ignore_ascii_case("codex")
                || provider.eq_ignore_ascii_case("grok")
                || provider.eq_ignore_ascii_case("claude")
            {
                // Liveness by what each variant can observe (see
                // `RuntimeManager::registration_live`): the Codex exec transport
                // never exposes a pid, so `native_pid` would re-select — and now be
                // refused by the registration boundary — on every send.
                self.runtime_manager.registration_live(&attempt_id) == Some(true)
            } else {
                self.runtime_manager
                    .selected_provider(&attempt_id)
                    .is_some()
            };
            if !runtime_live {
                self.runtime_manager
                    .select_runtime(
                        &attempt_id,
                        &provider,
                        None,
                        runtime_version(&provider),
                        &workspace,
                    )
                    .map_err(|error| error.to_string())?;
                let session_request = |resume: Option<String>| SessionRequest {
                    campaign_id: Some(campaign.id.clone()),
                    task_id: task.id.clone(),
                    attempt_id: attempt_id.clone(),
                    workspace_root: workspace.clone(),
                    resume_session: resume,
                };
                let session = match self.runtime_manager.create_session(
                    &attempt_id,
                    &session_request(attempt.provider_session.clone()),
                ) {
                    Ok(session) => session,
                    Err(_) => self
                        .runtime_manager
                        .create_session(&attempt_id, &session_request(None))
                        .map_err(|error| error.to_string())?,
                };
                // A newly attached Runtime may have an opaque provider
                // session already (Codex app-server and Scenario).  One-shot
                // adapters intentionally return a Core-local placeholder;
                // only a later native response can replace it with a real
                // provider identity.
                if !session.handle.session_id.trim().is_empty()
                    && !session.handle.session_id.starts_with("claude-session-")
                {
                    self.store
                        .set_attempt_provider_session(&attempt_id, &session.handle.session_id)
                        .map_err(store_message)?;
                }
                for event in session.events {
                    self.persist_agent_event(&event)?;
                }
                // Increment 5: this re-registration completed its initialization through the
                // existing path; the record names it so the reuse decision can tell it apart
                // from a registration whose initialization failed.
                let identity = self
                    .runtime_manager
                    .registration_identity(&attempt_id)
                    .unwrap_or_default();
                self.persist_registration_established(
                    &attempt_id,
                    &identity,
                    "send_message",
                    &provider,
                )?;
            }
            let prompt = PromptRequest {
                attempt_id: attempt_id.clone(),
                text: message,
                idempotency_key: request.request_id.clone(),
            };
            let sent = match self.runtime_manager.send_prompt(&attempt_id, &prompt) {
                Ok(sent) => sent,
                Err(error) => {
                    let first = error.to_string();
                    eprintln!("goalport-core: send_prompt failed: {first}");
                    // Increment 6: a Codex send that failed on a closed transport, or a write whose
                    // delivery cannot be confirmed, is NOT automatically re-sent (owner boundary 4).
                    // Report what can actually be confirmed and stop; nothing is re-sent to prove a
                    // failure. A transient error with the transport still open keeps the retry below.
                    if provider.eq_ignore_ascii_case("codex") {
                        let closed_reason = match self.runtime_manager.transport_state(&attempt_id) {
                            Some(TransportState::Closed { reason }) => Some(reason),
                            _ => None,
                        };
                        let write_unknown = first.contains("delivery unknown");
                        if closed_reason.is_some() || write_unknown {
                            if write_unknown {
                                delivery = "UNKNOWN";
                            }
                            self.persist_event(
                                &attempt_id,
                                "runtime.send.failed",
                                json!({
                                    "error": first,
                                    "retry": false,
                                    "deliveryState": if write_unknown { "UNKNOWN" } else { "FAILED" },
                                    "transport": closed_reason.unwrap_or("write-error")
                                }),
                                None,
                            )?;
                            return Err(first);
                        }
                    }
                    if provider.eq_ignore_ascii_case("claude") {
                        delivery = "UNKNOWN";
                        let _ = self.persist_event(
                            &attempt_id,
                            "runtime.send.failed",
                            json!({
                                "error": first,
                                "retry": false,
                                "deliveryState": "UNKNOWN",
                                "reason": "Claude native send may have partially crossed the transport boundary"
                            }),
                            None,
                        );
                        let binding = self
                            .runtime_manager
                            .claude_turn_binding(&attempt_id)
                            .unwrap_or(Value::Null);
                        let stop_operation_id = format!("{}:send-uncertain", request.request_id);
                        let begun = self
                            .store
                            .begin_stop_responsibility(
                                &attempt_id,
                                &stop_operation_id,
                                workspace.to_string_lossy().as_ref(),
                                &provider,
                                &binding,
                                Some(&json!({
                                    "source": "claude.send.uncertain",
                                    "parentOperationId": request.request_id,
                                    "nativeDispatch": false,
                                    "deliveryState": "UNKNOWN"
                                })),
                            )
                            .map_err(store_message)?;
                        let responsibility = if begun.inserted {
                            self.store
                                .update_stop_responsibility(&StopResponsibilityUpdate {
                                    attempt_id: attempt_id.clone(),
                                    operation_id: stop_operation_id.clone(),
                                    binding,
                                    native_turn_state: StopNativeTurnState::Unconfirmed,
                                    residual_execution_state: "unknown".into(),
                                    detail: Some(json!({
                                        "source": "claude.send.uncertain",
                                        "parentOperationId": request.request_id,
                                        "nativeDispatch": false,
                                        "deliveryState": "UNKNOWN",
                                        "error": first
                                    })),
                                })
                                .map_err(store_message)?
                                .ok_or_else(|| {
                                    "uncertain Claude send responsibility was not persisted"
                                        .to_string()
                                })?
                        } else {
                            begun.responsibility
                        };
                        self.persist_event(
                            &attempt_id,
                            "runtime.send.uncertain",
                            json!({
                                "stopOperationId": responsibility.operation_id,
                                "nativeTurnState": "unconfirmed",
                                "residualExecutionState": "unknown",
                                "writeResponsibility": "held",
                                "retry": false,
                                "deliveryState": "UNKNOWN"
                            }),
                            None,
                        )?;
                        return Err(first);
                    }
                    let _ = self.persist_event(
                        &attempt_id,
                        "runtime.send.failed",
                        json!({ "error": first, "retry": true }),
                        None,
                    );
                    delivery = "UNKNOWN";
                    std::thread::sleep(std::time::Duration::from_millis(120));
                    self.runtime_manager
                        .send_prompt(&attempt_id, &prompt)
                        .map_err(|retry| {
                            let message = format!("{first}; retry: {retry}");
                            eprintln!("goalport-core: send_prompt retry failed: {message}");
                            let _ = self.persist_event(
                                &attempt_id,
                                "runtime.send.failed",
                                json!({ "error": message, "retry": false }),
                                None,
                            );
                            message
                        })?
                }
            };
            // The adapter's answer decides: from here on a failure is a failure AFTER delivery.
            // A rejected RETRY does not erase the first attempt's uncertainty (delivery_after_answer).
            delivery = delivery_after_answer(delivery, sent.accepted);
            if let Some(session_id) = sent.session_id.as_deref() {
                let current = self.store.get_attempt(&attempt_id).map_err(store_message)?;
                if current.provider_session.as_deref() != Some(session_id) {
                    self.store
                        .set_attempt_provider_session(&attempt_id, session_id)
                        .map_err(store_message)?;
                    self.persist_event(
                        &attempt_id,
                        "runtime.session.bound",
                        json!({
                            "provider": provider,
                            "sessionHash": sha256_hex(session_id.as_bytes()),
                            "source": "native-runtime-event"
                        }),
                        None,
                    )?;
                }
            }
            for event in sent.events {
                self.persist_agent_event(&event)?;
            }
            if !sent.accepted {
                return Err("Runtime did not accept the prompt".into());
            }
            self.persist_recovery(&attempt_id, None)?;
            Ok(())
        })();
        match result {
            Ok(()) => {
                let recorded = json!({ "requestId": request.request_id, "deliveryState": delivery });
                if let Err(error) =
                    self.store
                        .finish_command(&command_id, CommandState::Succeeded, &recorded)
                {
                    // A failure specific to the result write must not leave a completed command
                    // resting Executing ("still in progress"): fall back to the bare state, which a
                    // replay answers as the duplicate success. A store that is down fails this write
                    // too and the error reaches the caller; the row is then converted to UNKNOWN by
                    // the restart reconcile (residual R-P).
                    eprintln!("goalport-core: send result not recorded: {error}");
                    self.store
                        .update_command_state(&command_id, CommandState::Succeeded)
                        .map_err(store_message)?;
                }
                Ok(false)
            }
            Err(error) => {
                // Nothing between the failure and the terminal write may return early (plan
                // v14): the stop-responsibility query decides Unknown vs Failed for a Claude send,
                // and if the query itself fails the command is classified Unknown (fail closed:
                // never a confirmed failure on a guess) and the terminal write still runs. The
                // query error is logged, not persisted (residual R-U).
                let failed_state = if attempt.provider.eq_ignore_ascii_case("claude") {
                    match self.store.stop_responsibility_for_attempt(&attempt_id) {
                        Ok(Some(_)) => CommandState::Unknown,
                        Ok(None) => CommandState::Failed,
                        Err(query_error) => {
                            eprintln!(
                                "goalport-core: stop responsibility lookup failed while recording a \
                                 failed Claude send ({query_error}); recording UNKNOWN"
                            );
                            CommandState::Unknown
                        }
                    }
                } else {
                    CommandState::Failed
                };
                // The result rides with the state in one write; a store failure here must not
                // mask the original error, and a row left without a result is answered
                // fail-closed ("reason not recorded", delivery UNKNOWN) on replay.
                let recorded = json!({
                    "requestId": request.request_id,
                    "deliveryState": delivery,
                    "error": error
                });
                if self
                    .store
                    .finish_command(&command_id, failed_state, &recorded)
                    .is_err()
                {
                    // Same rule as the success arm: the bare terminal state at least, so a replay
                    // answers "[delivery=UNKNOWN]: reason not recorded" rather than "in progress".
                    // If this write fails as well (store down) the row stays Executing until the
                    // restart reconcile; the original error still reaches the caller.
                    let _ = self.store.update_command_state(&command_id, failed_state);
                }
                Err(error)
            }
        }
    }

    fn resolve_decision(&mut self, request: &UiCommandRequest) -> Result<(), String> {
        let decision_id = payload_text(&request.payload, "decisionId")?;
        let allow = request
            .payload
            .get("allow")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let decision = self
            .store
            .get_decision(&decision_id)
            .map_err(store_message)?;
        if decision.state != DecisionState::Pending {
            return Err(format!(
                "decision {decision_id} is {:?}; only pending decisions can be resolved",
                decision.state
            ));
        }
        let attempt = self
            .store
            .get_attempt(&decision.attempt_id)
            .map_err(store_message)?;
        let task = self
            .store
            .get_task(&attempt.task_id)
            .map_err(store_message)?;
        if allow {
            let workspace = self.workspace_for_campaign(&task.campaign_id)?;
            self.ensure_workspace_ingress_allowed(&workspace, "permission Allow")?;
        }
        let auth = self
            .store
            .get_campaign_authorization(&task.campaign_id)
            .map_err(store_message)?;
        if allow && (!auth.action_authorized || !auth.provider_authorized) {
            return Err("current campaign authorization denies permission approval; historical PolicySnapshot is explanatory only".into());
        }
        self.runtime_manager
            .permission_response(
                &decision.attempt_id,
                PermissionResponse {
                    request_id: decision_id.clone(),
                    allow,
                },
            )
            .map_err(|error| format!("native permission response was not delivered: {error}"))?;
        let state = if allow {
            DecisionState::Approved
        } else {
            DecisionState::Denied
        };
        self.store
            .update_decision_state(&decision_id, state)
            .map_err(store_message)?;
        let session_hash = attempt
            .provider_session
            .as_deref()
            .map(hash_id)
            .unwrap_or_else(|| "unbound".into());
        let turn = (attempt.last_event_seq + 1).to_string();
        let mut payload = json!({
            "decisionId": decision_id,
            "allow": allow,
            "attemptId": decision.attempt_id,
            "campaignId": task.campaign_id,
            "taskId": attempt.task_id,
            "sessionHash": session_hash,
            "turnSeq": turn
        });
        if !allow {
            let notice = permission_denied_notice(
                &decision_id,
                &decision.attempt_id,
                &task.campaign_id,
                &attempt.task_id,
                &session_hash,
                &turn,
            );
            if let Some(object) = payload.as_object_mut() {
                object.insert("notice".into(), json!(notice.clone()));
            }
            self.persist_event(&decision.attempt_id, "permission.response", payload, None)?;
            self.insert_notice_unique(notice);
            return Ok(());
        }
        self.persist_event(&decision.attempt_id, "permission.response", payload, None)?;
        Ok(())
    }

    fn interrupt(&mut self, request: &UiCommandRequest) -> Result<(), String> {
        let attempt_id = payload_text_default(
            &request.payload,
            "attemptId",
            self.selected_attempt_id.as_deref().unwrap_or_default(),
        );
        let attempt = self.store.get_attempt(&attempt_id).map_err(store_message)?;
        if attempt.provider.eq_ignore_ascii_case("claude") {
            self.stop_claude_with_operation(&attempt_id, &request.request_id, "ui.stop", None)?;
            return Ok(());
        }
        let result = self
            .runtime_manager
            .interrupt(&attempt_id)
            .map_err(|error| error.to_string())?;
        if result.confirmed {
            self.persist_event(
                &attempt_id,
                "attempt.cancelled",
                json!({ "requested": result.requested, "confirmed": true, "reason": result.reason }),
                Some(AttemptState::Cancelled),
            )?;
        } else {
            self.persist_event(
                &attempt_id,
                "attempt.interrupt.requested",
                json!({ "requested": result.requested, "confirmed": false, "reason": result.reason }),
                None,
            )?;
        }
        Ok(())
    }

    fn stop_claude_with_operation(
        &mut self,
        attempt_id: &str,
        operation_id: &str,
        source: &str,
        parent_operation_id: Option<&str>,
    ) -> Result<StopResponsibility, String> {
        if let Some(existing) = self
            .store
            .stop_responsibility_for_attempt(attempt_id)
            .map_err(store_message)?
        {
            return Ok(existing);
        }
        let attempt = self.store.get_attempt(attempt_id).map_err(store_message)?;
        if !attempt.provider.eq_ignore_ascii_case("claude") {
            return Err(format!(
                "durable native Stop is only defined for Claude; attempt {attempt_id} uses {}",
                attempt.provider
            ));
        }
        let turn_in_flight = self.runtime_manager.turn_in_flight(attempt_id);
        let captured_binding = self.runtime_manager.claude_turn_binding(attempt_id);
        let runtime_attached = self.runtime_manager.selected_provider(attempt_id).is_some();
        let recovered_active_without_runtime =
            attempt.state == AttemptState::Active && !runtime_attached;
        if !turn_in_flight && !recovered_active_without_runtime {
            return Err(
                "Claude Stop found no active turn; no durable workspace hold was created".into(),
            );
        }
        // None means the Runtime still owes a response but one or more exact
        // correlation fields were unavailable. Null is the immutable record of
        // that failed capture; it is never eligible for Interrupted confirmation.
        let binding = captured_binding.unwrap_or(Value::Null);
        let binding_complete = complete_claude_stop_binding(&binding);
        let workspace = self.workspace_for_attempt(attempt_id)?;
        let begun = self
            .store
            .begin_stop_responsibility(
                attempt_id,
                operation_id,
                &workspace,
                &attempt.provider,
                &binding,
                Some(&json!({
                    "source": source,
                    "parentOperationId": parent_operation_id,
                    "bindingCapture": if binding_complete { "complete" } else { "missing-or-partial-active" }
                })),
            )
            .map_err(store_message)?;
        if !begun.inserted {
            return Ok(begun.responsibility);
        }
        if !binding_complete {
            let detail = json!({
                "source": source,
                "parentOperationId": parent_operation_id,
                "bindingCapture": "missing-or-partial-active",
                "nativeDispatch": false,
                "reason": "exact input/session/turn/process binding unavailable"
            });
            let responsibility = self
                .store
                .update_stop_responsibility(&StopResponsibilityUpdate {
                    attempt_id: attempt_id.into(),
                    operation_id: operation_id.into(),
                    binding,
                    native_turn_state: StopNativeTurnState::Unconfirmed,
                    residual_execution_state: "unknown".into(),
                    detail: Some(detail.clone()),
                })
                .map_err(store_message)?
                .ok_or_else(|| {
                    "durable Stop responsibility did not accept missing binding".to_string()
                })?;
            self.persist_event(
                attempt_id,
                "attempt.stop.unconfirmed",
                json!({
                    "stopOperationId": operation_id,
                    "nativeTurnState": "unconfirmed",
                    "residualExecutionState": "unknown",
                    "writeResponsibility": "held",
                    "detail": detail
                }),
                None,
            )?;
            return Ok(responsibility);
        }
        match self
            .runtime_manager
            .interrupt_with_operation(attempt_id, operation_id)
        {
            Ok(result) => {
                self.persist_event(
                    attempt_id,
                    "attempt.stop.requested",
                    json!({
                        "stopOperationId": operation_id,
                        "requested": result.requested,
                        "adapterConfirmed": result.confirmed,
                        "detail": result.reason,
                        "nativeTurnState": "pending",
                        "residualExecutionState": "unknown",
                        "writeResponsibility": "held",
                        "source": source,
                        "parentOperationId": parent_operation_id
                    }),
                    None,
                )?;
            }
            Err(error) => {
                let detail = json!({
                    "source": source,
                    "parentOperationId": parent_operation_id,
                    "adapterError": error.to_string()
                });
                let _ = self
                    .store
                    .update_stop_responsibility(&StopResponsibilityUpdate {
                        attempt_id: attempt_id.into(),
                        operation_id: operation_id.into(),
                        binding,
                        native_turn_state: StopNativeTurnState::Unconfirmed,
                        residual_execution_state: "unknown".into(),
                        detail: Some(detail.clone()),
                    })
                    .map_err(store_message)?;
                self.persist_event(
                    attempt_id,
                    "attempt.stop.unconfirmed",
                    json!({
                        "stopOperationId": operation_id,
                        "nativeTurnState": "unconfirmed",
                        "residualExecutionState": "unknown",
                        "writeResponsibility": "held",
                        "detail": detail
                    }),
                    None,
                )?;
            }
        }
        self.store
            .stop_responsibility_for_attempt(attempt_id)
            .map_err(store_message)?
            .ok_or_else(|| "durable Stop responsibility disappeared after commit".into())
    }

    fn handoff(&mut self, request: &UiCommandRequest) -> Result<(), String> {
        let old_attempt_id = payload_text_default(
            &request.payload,
            "oldAttemptId",
            self.selected_attempt_id.as_deref().unwrap_or_default(),
        );
        let old = self
            .store
            .get_attempt(&old_attempt_id)
            .map_err(store_message)?;
        let task = self.store.get_task(&old.task_id).map_err(store_message)?;
        let campaign = self
            .store
            .get_campaign(&task.campaign_id)
            .map_err(store_message)?;
        let old_workspace = self.workspace_for_campaign(&campaign.id)?;
        self.ensure_workspace_ingress_allowed(&old_workspace, "handoff")?;
        let auth = self
            .store
            .get_campaign_authorization(&campaign.id)
            .map_err(store_message)?;
        if !auth.transfer_authorized || !auth.provider_authorized {
            return Err("current campaign authorization denies handoff; historical PolicySnapshot is explanatory only".into());
        }
        if old.state == AttemptState::Active && old.provider.eq_ignore_ascii_case("claude") {
            self.stop_claude_with_operation(
                &old_attempt_id,
                &request.request_id,
                "handoff.stop",
                None,
            )?;
            return Err(
                "handoff blocked by durable Stop responsibility; residual execution remains unknown and held"
                    .into(),
            );
        }
        let old_leases = self.store.leases().map_err(store_message)?;
        if old_leases.iter().any(|lease| {
            lease.attempt_id == old_attempt_id && lease.state.blocks_mutating_acquisition()
        }) {
            return Err(
                "handoff blocked until old workspace lease is released or explicitly reconciled"
                    .into(),
            );
        }
        let old_outbox = self
            .store
            .outbox_for_attempt(&old_attempt_id)
            .map_err(store_message)?;
        if old_outbox
            .iter()
            .any(|intent| !matches!(intent.state, crate::domain::OutboxState::Succeeded))
        {
            return Err(
                "handoff blocked by a pending, failed, dispatching or unknown external effect"
                    .into(),
            );
        }
        if old.state == AttemptState::Active {
            let stopped = self
                .runtime_manager
                .interrupt(&old_attempt_id)
                .map_err(|error| error.to_string())?;
            if !stopped.confirmed {
                self.persist_event(
                    &old_attempt_id,
                    "attempt.interrupt.requested",
                    json!({ "requested": stopped.requested, "confirmed": false, "reason": stopped.reason }),
                    None,
                )?;
                return Err("handoff blocked until old Runtime stop is confirmed".into());
            }
            self.persist_event(
                &old_attempt_id,
                "attempt.cancelled",
                json!({ "reason": "handoff", "confirmed": true }),
                Some(AttemptState::Cancelled),
            )?;
        }
        let provider = payload_text(&request.payload, "provider")?;
        let project = self
            .store
            .get_project(&self.selected_project_id)
            .map_err(store_message)?;
        let evidence = self
            .store
            .list_evidence()
            .map_err(store_message)?
            .into_iter()
            .filter(|item| item.attempt_id == old_attempt_id)
            .collect::<Vec<_>>();
        let authorization = payload_text_default(
            &request.payload,
            "authorization",
            "goalport-electron-stable-v1:handoff",
        );
        let authorization_manifest = payload_text_default(
            &request.payload,
            "authorizationManifest",
            "goal-runs/goalport-electron-stable-v1/evidence/locks/shared-interface-freeze.json",
        );
        let new_id = format!("attempt-handoff-{}", stable_suffix(&request.request_id));
        self.store
            .insert_attempt(&Attempt::new(
                &new_id,
                &task.id,
                &provider,
                format!("{provider}-cap-v1"),
            ))
            .map_err(store_message)?;
        self.runtime_manager
            .select_runtime(
                &new_id,
                &provider,
                None,
                runtime_version(&provider),
                &PathBuf::from(project.workspace_root.clone()),
            )
            .map_err(|error| error.to_string())?;
        let workspace = PathBuf::from(project.workspace_root.clone());
        let session = self
            .runtime_manager
            .create_session(
                &new_id,
                &SessionRequest {
                    campaign_id: Some(campaign.id.clone()),
                    task_id: task.id.clone(),
                    attempt_id: new_id.clone(),
                    workspace_root: workspace,
                    resume_session: None,
                },
            )
            .map_err(|error| error.to_string())?;
        // Handoff is Core-owned: persist the identity returned by the Runtime
        // attachment before exposing the new Attempt.  One-shot providers may
        // return a temporary Core-local label here; send_message replaces it
        // only after a native session id is observed in provider output.
        if !session.handle.session_id.trim().is_empty()
            && !session.handle.session_id.starts_with("claude-session-")
        {
            self.store
                .set_attempt_provider_session(&new_id, &session.handle.session_id)
                .map_err(store_message)?;
        }
        self.selected_attempt_id = Some(new_id.clone());
        self.persist_event(
            &new_id,
            "attempt.active",
            json!({ "handoff": true }),
            Some(AttemptState::Active),
        )?;
        for event in session.events {
            self.persist_agent_event(&event)?;
        }
        let old_after = self
            .store
            .get_attempt(&old_attempt_id)
            .map_err(store_message)?;
        let old_lease_states = old_leases
            .iter()
            .filter(|lease| lease.attempt_id == old_attempt_id)
            .map(|lease| format!("{:?}", lease.state).to_ascii_uppercase())
            .collect::<Vec<_>>();
        let old_outbox_states = old_outbox
            .iter()
            .map(|intent| format!("{:?}", intent.state).to_ascii_uppercase())
            .collect::<Vec<_>>();
        let packet = json!({
            "packetVersion": "goalport.handoff.v1",
            "campaignId": campaign.id.clone(),
            "taskId": task.id.clone(),
            "goal": bounded_core_text(&campaign.goal, 2048),
            "workspaceHash": sha256_hex(project.workspace_root.as_bytes()),
            "evidence": evidence.iter().map(|item| json!({
                "id": item.id.clone(),
                "claim": bounded_core_text(&item.claim, 512),
                "snapshotHash": item.snapshot_hash.clone(),
                "source": "Core Store"
            })).take(32).collect::<Vec<_>>(),
            "authorization": {
                "request": bounded_core_text(&authorization, 256),
                "manifest": bounded_core_text(&authorization_manifest, 256),
                "requestHash": sha256_hex(request.request_id.as_bytes())
            },
            "oldAttempt": {
                "id": old_after.id.clone(),
                "state": attempt_state_label(old_after.state),
                "provider": old_after.provider.clone(),
                "sessionHash": old_after.provider_session.as_deref().map(hash_id),
                "responsibility": "reconciled",
                "leaseStates": old_lease_states,
                "outboxStates": old_outbox_states
            },
            "newAttempt": {
                "id": new_id.clone(),
                "provider": provider.clone(),
                "sessionHash": Some(hash_id(&session.handle.session_id)),
                "nativeSessionBound": !session.handle.session_id.trim().is_empty()
                    && !session.handle.session_id.starts_with("claude-session-")
            },
            "manualCopy": false
        });
        // Keep the packet in both timelines: the old Attempt proves the
        // responsibility boundary; the new Attempt lets a freshly connected
        // GUI inspect the exact Core-generated handoff without copying text.
        self.persist_event(&old_attempt_id, "handoff.completed", packet.clone(), None)?;
        self.persist_event(&new_id, "handoff.completed", packet.clone(), None)?;
        if let Ok(instruction) = payload_text(&request.payload, "handoffInstruction") {
            // The first prompt of the new Attempt is constructed inside Core
            // from the persisted packet.  A host supplies only a bounded
            // action instruction, so no desktop can silently copy or mutate
            // the previous conversation context.
            let packet_json = serde_json::to_string(&packet).map_err(|error| error.to_string())?;
            let handoff_message = format!(
                "GoalPort Core handoff packet (machine generated): {packet_json}\nHandoff instruction: {}",
                bounded_core_text(&instruction, 1024)
            );
            let handoff_request_id =
                format!("handoff-instruction-{}", stable_suffix(&request.request_id));
            let _ = self.send_message(&UiCommandRequest {
                protocol_version: CONNECTED_UI_PROTOCOL_VERSION.into(),
                request_id: handoff_request_id,
                entity_version: request.entity_version,
                message_type: "send_message".into(),
                payload: json!({
                    "campaignId": campaign.id,
                    "taskId": task.id,
                    "attemptId": new_id,
                    "message": handoff_message
                }),
            })?;
        }
        Ok(())
    }

    fn reconstruct_from_store(&mut self) -> Result<(), String> {
        let records = self.store.list_attempt_recovery().map_err(store_message)?;
        for record in records {
            self.runtime_manager
                .reconstruct_without_spawn(&record.attempt_id, &record.provider);
            let class = match record.recovery_class.as_deref() {
                None | Some("R1") => "R1_UNSUPPORTED".to_string(),
                Some(value) => value.to_string(),
            };
            self.store
                .upsert_attempt_recovery(&AttemptRecovery {
                    recovery_class: Some(class),
                    pid: None,
                    process_epoch: None,
                    ..record
                })
                .map_err(store_message)?;
        }
        Ok(())
    }

    fn persist_recovery(&mut self, attempt_id: &str, class: Option<&str>) -> Result<(), String> {
        let attempt = self.store.get_attempt(attempt_id).map_err(store_message)?;
        let pending = self
            .store
            .list_decisions()
            .map_err(store_message)?
            .into_iter()
            .filter(|decision| {
                decision.attempt_id == attempt_id && decision.state == DecisionState::Pending
            })
            .map(|decision| decision.id)
            .collect::<Vec<_>>();
        let outbox = self
            .store
            .outbox_for_attempt(attempt_id)
            .map_err(store_message)?
            .into_iter()
            .map(|intent| intent.id)
            .collect::<Vec<_>>();
        let lease_key = self
            .store
            .leases()
            .map_err(store_message)?
            .into_iter()
            .find(|lease| {
                lease.attempt_id == attempt_id && lease.state.blocks_mutating_acquisition()
            })
            .map(|lease| lease.workspace_key);
        let session_hash = attempt
            .provider_session
            .as_ref()
            .map(|session| sha256_hex(session.as_bytes()));
        let prompt_replay = self
            .store
            .get_attempt_recovery(attempt_id)
            .map_err(store_message)?
            .map(|record| record.prompt_replay)
            .unwrap_or(false);
        let runtime_binding = self.persist_runtime_epoch_binding(attempt_id)?;
        self.store
            .upsert_attempt_recovery(&AttemptRecovery {
                attempt_id: attempt_id.into(),
                provider: attempt.provider,
                session_hash,
                process_epoch: runtime_binding
                    .as_ref()
                    .map(|binding| binding.process_epoch.clone()),
                pid: runtime_binding.as_ref().map(|binding| binding.runtime_pid),
                last_seq: attempt.last_event_seq,
                pending_permission_ids: serde_json::to_string(&pending)
                    .unwrap_or_else(|_| "[]".into()),
                outbox_ids: serde_json::to_string(&outbox).unwrap_or_else(|_| "[]".into()),
                lease_workspace_key: lease_key,
                recovery_class: class.map(str::to_owned),
                prompt_replay,
            })
            .map_err(store_message)?;
        Ok(())
    }

    fn persist_runtime_epoch_binding(
        &self,
        attempt_id: &str,
    ) -> Result<Option<RuntimeEpochBinding>, String> {
        let Some(runtime) = self.runtime_manager.process_binding(attempt_id) else {
            return Ok(None);
        };
        let attempt = self.store.get_attempt(attempt_id).map_err(store_message)?;
        let task = self
            .store
            .get_task(&attempt.task_id)
            .map_err(store_message)?;
        let session_hash = match attempt
            .provider_session
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .map(|value| sha256_hex(value.as_bytes()))
        {
            Some(hash) => hash,
            None if attempt.provider.eq_ignore_ascii_case("claude") => return Ok(None),
            None => {
                return Err("native Runtime binding has no provider session".to_string());
            }
        };
        let core_epoch = self
            .store
            .latest_core_launch_epoch()
            .map_err(store_message)?
            .filter(|epoch| epoch.state == "READY_COMMITTED" || epoch.state == "ACTIVE")
            .ok_or_else(|| "native Runtime binding has no committed Core epoch".to_string())?;
        let binding = RuntimeEpochBinding {
            attempt_id: attempt.id,
            campaign_id: task.campaign_id,
            task_id: task.id,
            provider: attempt.provider,
            session_hash,
            process_epoch: runtime.process_epoch,
            runtime_pid: i64::from(runtime.pid),
            runtime_creation_date: runtime.creation_date,
            runtime_executable_path: runtime.executable_path,
            runtime_executable_sha256: runtime.executable_sha256,
            core_epoch_id: core_epoch.epoch_id,
            created_at: store::utc_now_iso(),
        };
        self.store
            .put_runtime_epoch_binding(&binding)
            .map_err(store_message)?;
        Ok(Some(binding))
    }

    fn reconnect_ui(&mut self, request: &UiCommandRequest) -> Result<(), String> {
        let cursor = payload_i64(&request.payload, "cursor").unwrap_or(0);
        self.notices
            .insert(0, format!("UI reconnect observed at cursor {cursor}"));
        if let Some(attempt_id) = self.selected_attempt_id.clone() {
            self.persist_event(
                &attempt_id,
                "ui.reconnected",
                json!({ "cursor": cursor, "promptReplay": false }),
                None,
            )?;
        }
        Ok(())
    }

    fn revoke_authorization(&mut self, request: &UiCommandRequest) -> Result<(), String> {
        let campaign_id = payload_text_default(
            &request.payload,
            "campaignId",
            self.selected_campaign_id.as_deref().unwrap_or_default(),
        );
        let scope = payload_text_default(&request.payload, "scope", "action").to_ascii_lowercase();
        let mut auth = self
            .store
            .get_campaign_authorization(&campaign_id)
            .map_err(store_message)?;
        match scope.as_str() {
            "provider" => auth.provider_authorized = false,
            "transfer" => auth.transfer_authorized = false,
            _ => auth.action_authorized = false,
        }
        self.store
            .set_campaign_authorization(&campaign_id, &auth)
            .map_err(store_message)?;
        let tasks = self
            .store
            .tasks_for_campaign(&campaign_id)
            .map_err(store_message)?;
        for task in tasks {
            let attempts = self
                .store
                .attempts_for_task(&task.id)
                .map_err(store_message)?;
            for attempt in attempts {
                if attempt.state.is_terminal() {
                    continue;
                }
                if attempt.provider.eq_ignore_ascii_case("claude") {
                    if attempt.state != AttemptState::Active {
                        continue;
                    }
                    let child_stop_operation_id =
                        format!("{}:revoke:{}", request.request_id, hash_id(&attempt.id));
                    self.stop_claude_with_operation(
                        &attempt.id,
                        &child_stop_operation_id,
                        "authorization.revoked",
                        Some(&request.request_id),
                    )?;
                    continue;
                }
                let stopped = self.runtime_manager.interrupt(&attempt.id);
                let (requested, confirmed, reason) = match stopped {
                    Ok(result) => (result.requested, result.confirmed, result.reason),
                    Err(error) => (true, false, Some(error.to_string())),
                };
                if confirmed {
                    self.persist_event(
                        &attempt.id,
                        "attempt.cancelled",
                        json!({ "reason": "authorization.revoked", "scope": scope, "requested": requested, "confirmed": true, "detail": reason }),
                        Some(AttemptState::Cancelled),
                    )?;
                } else {
                    self.persist_event(
                        &attempt.id,
                        "attempt.interrupt.requested",
                        json!({ "reason": "authorization.revoked", "scope": scope, "requested": requested, "confirmed": false, "detail": reason }),
                        None,
                    )?;
                }
            }
        }
        if let Some(attempt_id) = self.selected_attempt_id.clone() {
            self.persist_event(
                &attempt_id,
                "authorization.revoked",
                json!({ "campaignId": campaign_id, "scope": scope }),
                None,
            )?;
        }
        self.notices.insert(
            0,
            format!(
                "Current authorization revoked for {scope}; stop handling requested. Native turn and residual execution states remain independently evidenced; historical PolicySnapshot is unchanged"
            ),
        );
        Ok(())
    }

    fn request_owner_action(&mut self, request: &UiCommandRequest) -> Result<(), String> {
        let action =
            payload_text_default(&request.payload, "action", "commit").to_ascii_lowercase();
        let authority = ActionAuthority::default();
        let allowed = authority.allows(
            &action,
            ApprovalContext {
                plan_approved: payload_bool(&request.payload, "planApproved"),
                audit_passed: payload_bool(&request.payload, "auditPassed"),
            },
        );
        if allowed {
            return Err("owner-only action unexpectedly allowed".into());
        }
        if let Some(attempt_id) = self.selected_attempt_id.clone() {
            self.persist_event(
                &attempt_id,
                "owner_action.blocked",
                json!({ "action": action, "planApproved": payload_bool(&request.payload, "planApproved"), "auditPassed": payload_bool(&request.payload, "auditPassed") }),
                None,
            )?;
        }
        self.notices.insert(
            0,
            format!("Owner-only action {action} blocked; plan/audit flags do not grant authority"),
        );
        Ok(())
    }

    fn resume_native_session(&mut self, request: &UiCommandRequest) -> Result<(), String> {
        let attempt_id = payload_text_default(
            &request.payload,
            "attemptId",
            self.selected_attempt_id.as_deref().unwrap_or_default(),
        );
        let attempt = self.store.get_attempt(&attempt_id).map_err(store_message)?;
        let Some(session_id) = attempt.provider_session.clone() else {
            self.persist_recovery(&attempt_id, Some("UNSUPPORTED"))?;
            return Err("no persisted native session to resume".into());
        };
        let workspace = PathBuf::from(self.workspace_for_attempt(&attempt_id)?);
        self.ensure_workspace_ingress_allowed(
            workspace.to_string_lossy().as_ref(),
            "native session resume",
        )?;
        if self
            .runtime_manager
            .selected_provider(&attempt_id)
            .is_none()
        {
            self.runtime_manager
                .select_runtime(
                    &attempt_id,
                    &attempt.provider,
                    None,
                    runtime_version(&attempt.provider),
                    &workspace,
                )
                .map_err(|error| error.to_string())?;
        }
        // Increment 5 (ruling A): the resumed Runtime's identity context comes from the persisted
        // objects the attempt is bound to - its row's task and that task's campaign - and the
        // workspace derived above from the same chain; never from the UI selection, a default or
        // the request payload. Without it the resumed process would emit events the canonical
        // binding check (rightly) refuses.
        let task = self
            .store
            .get_task(&attempt.task_id)
            .map_err(store_message)?;
        let context = SessionRequest {
            campaign_id: Some(task.campaign_id.clone()),
            task_id: task.id.clone(),
            attempt_id: attempt_id.clone(),
            workspace_root: workspace.clone(),
            resume_session: Some(session_id.clone()),
        };
        match self
            .runtime_manager
            .resume_session_with_context(&attempt_id, &context)
        {
            Ok(session) => {
                if session.handle.session_id != session_id {
                    self.persist_event(
                        &attempt_id,
                        "runtime.session.resumed",
                        json!({ "resumed": false, "unsupported": true, "reason": "native thread id changed" }),
                        None,
                    )?;
                    self.persist_recovery(&attempt_id, Some("UNSUPPORTED"))?;
                    return Ok(());
                }
                self.persist_event(
                    &attempt_id,
                    "runtime.session.resumed",
                    json!({
                        "resumed": true,
                        "sessionHash": sha256_hex(session.handle.session_id.as_bytes()),
                        "nativeSubmissionCount": 1
                    }),
                    None,
                )?;
                self.persist_recovery(&attempt_id, Some("R2"))?;
                // Increment 5: this registration completed its recovery through the existing
                // path; the record names it so a later reuse is attributed to it and not to an
                // earlier registration whose initialization failed.
                let identity = self
                    .runtime_manager
                    .registration_identity(&attempt_id)
                    .unwrap_or_default();
                self.persist_registration_established(
                    &attempt_id,
                    &identity,
                    "resume_native_session",
                    &attempt.provider,
                )?;
                Ok(())
            }
            Err(error) => {
                // Increment 6: if the resume failed because the reader observed the stream close
                // (boundary-(1) resume side), name the reason in the record; no established record
                // is written and no separate transport record either (this is pre-establishment).
                // Provider-gated to codex: `resume_native_session` serves every provider, and
                // Grok/Claude are EXPRESSION-ONLY here - deriving a persisted record value from
                // their stream flags would be a behaviour change this increment is not allowed to
                // make, and "stream-closed" is not part of the Codex reason vocabulary.
                let transport = if attempt.provider.eq_ignore_ascii_case("codex") {
                    match self.runtime_manager.transport_state(&attempt_id) {
                        Some(TransportState::Closed { reason }) => Value::String(reason.into()),
                        _ => Value::Null,
                    }
                } else {
                    Value::Null
                };
                self.persist_event(
                    &attempt_id,
                    "runtime.session.resumed",
                    json!({ "resumed": false, "unsupported": true, "reason": error.to_string(), "transport": transport }),
                    None,
                )?;
                self.persist_recovery(&attempt_id, Some("UNSUPPORTED"))?;
                Ok(())
            }
        }
    }

    fn classify_recovery(&mut self, request: &UiCommandRequest) -> Result<(), String> {
        let attempt_id = payload_text_default(
            &request.payload,
            "attemptId",
            self.selected_attempt_id.as_deref().unwrap_or_default(),
        );
        let claimed = payload_text_default(&request.payload, "class", "R1_UNSUPPORTED");
        let previous = self
            .store
            .get_attempt_recovery(&attempt_id)
            .map_err(store_message)?;
        // R1 (re-attach to the same process) requires the process identity to be CONFIRMED live
        // and equal to the identity recorded when it was spawned. A stored handle or pid field is
        // not evidence: a `Child` outlives its process. An exited process, an observation that
        // failed, and a transport without a process identity are all refused R1 — distinctly
        // labelled, never conflated, and nothing is removed, released or replaced here.
        let confirmation = self.runtime_manager.confirm_process_identity(&attempt_id);
        let identity_confirmed = match &confirmation {
            Some(crate::runtime_manager::ProcessConfirmation::Confirmed { pid, process_epoch }) => {
                previous.as_ref().is_some_and(|record| {
                    record.pid == Some(i64::from(*pid))
                        && record.process_epoch.as_deref() == Some(process_epoch.as_str())
                })
            }
            _ => false,
        };
        let class = if claimed == "R1" && identity_confirmed {
            "R1"
        } else if claimed == "R1" {
            "R1_UNSUPPORTED"
        } else {
            claimed.as_str()
        };
        let (identity, reason) = match &confirmation {
            None => ("unregistered", None),
            Some(crate::runtime_manager::ProcessConfirmation::Confirmed { .. }) => ("confirmed", None),
            Some(crate::runtime_manager::ProcessConfirmation::Exited { .. }) => ("exited", None),
            Some(crate::runtime_manager::ProcessConfirmation::Unknown { reason }) => {
                ("unknown", Some(reason.clone()))
            }
            Some(crate::runtime_manager::ProcessConfirmation::NotApplicable) => {
                ("not-applicable", None)
            }
        };
        self.persist_event(
            &attempt_id,
            "recovery.classified",
            json!({
                "class": class,
                "promptReplay": false,
                "identity": identity,
                "reason": reason
            }),
            None,
        )?;
        self.persist_recovery(&attempt_id, Some(class))?;
        Ok(())
    }

    fn close_adapter_transport(&mut self, request: &UiCommandRequest) -> Result<(), String> {
        let attempt_id = payload_text_default(
            &request.payload,
            "attemptId",
            self.selected_attempt_id.as_deref().unwrap_or_default(),
        );
        self.runtime_manager
            .drop_adapter_transport(&attempt_id)
            .map_err(|error| error.to_string())?;
        self.persist_event(
            &attempt_id,
            "transport_lost",
            json!({ "class": "adapter-stdio", "recovery": "preflight" }),
            None,
        )?;
        self.persist_recovery(&attempt_id, Some("BLOCKED"))?;
        Ok(())
    }

    fn mark_runtime_exit(&mut self, request: &UiCommandRequest) -> Result<(), String> {
        let attempt_id = payload_text_default(
            &request.payload,
            "attemptId",
            self.selected_attempt_id.as_deref().unwrap_or_default(),
        );
        let workspace = self
            .store
            .get_project(&self.selected_project_id)
            .map_err(store_message)?
            .workspace_root;
        let _ = self.store.mark_lease_uncertain(&workspace, &attempt_id);
        if self
            .store
            .leases()
            .map_err(store_message)?
            .iter()
            .all(|lease| {
                lease.attempt_id != attempt_id
                    || lease.state != crate::domain::LeaseState::Uncertain
            })
        {
            let _ = self.store.acquire_lease(&WorkspaceLease::new(
                &workspace,
                &attempt_id,
                AccessMode::Mutating,
            ));
            let _ = self.store.mark_lease_uncertain(&workspace, &attempt_id);
        }
        self.persist_event(
            &attempt_id,
            "runtime.exited",
            json!({ "receipt": "missing", "lease": "UNCERTAIN" }),
            None,
        )?;
        self.persist_recovery(&attempt_id, Some("UNCERTAIN"))?;
        Ok(())
    }

    fn observe_workspace_edit(&mut self, request: &UiCommandRequest) -> Result<(), String> {
        let attempt_id = payload_text_default(
            &request.payload,
            "attemptId",
            self.selected_attempt_id.as_deref().unwrap_or_default(),
        );
        let path = payload_text_default(&request.payload, "path", "");
        let hash = if path.is_empty() {
            "missing".into()
        } else {
            fs::read(&path)
                .map(|bytes| sha256_hex(&bytes))
                .unwrap_or_else(|_| "unreadable".into())
        };
        let evidence_id = format!("evidence-stale-{}", stable_suffix(&request.request_id));
        self.store
            .insert_evidence(&Evidence {
                id: evidence_id.clone(),
                attempt_id: attempt_id.clone(),
                claim: "Runtime output still matches the current workspace".into(),
                snapshot_hash: hash.clone(),
                verdict: Verdict::Contested,
            })
            .map_err(store_message)?;
        self.persist_event(
            &attempt_id,
            "evidence.stale",
            json!({ "path": path, "snapshot": hash, "verdict": "STALE" }),
            None,
        )?;
        Ok(())
    }

    fn queue_override(&mut self, request: &UiCommandRequest) -> Result<(), String> {
        let id = payload_text(&request.payload, "queueId")?;
        let reason = payload_text_default(&request.payload, "reason", "explicit-owner-override");
        let queued = self.store.get_admission(&id).map_err(store_message)?;
        if let Some(request_json) = queued
            .request_json
            .as_deref()
            .filter(|text| !text.is_empty())
        {
            let queued_payload: Value =
                serde_json::from_str(request_json).map_err(|error| error.to_string())?;
            let project_id =
                payload_text_default(&queued_payload, "projectId", &self.selected_project_id);
            let project = self.store.get_project(&project_id).map_err(store_message)?;
            self.ensure_workspace_ingress_allowed(
                &project.workspace_root,
                "runtime queue override",
            )?;
        }
        self.store
            .override_admission(&id, &reason)
            .map_err(store_message)?;
        self.notices
            .insert(0, format!("Admission override recorded: {reason}"));
        if let Some(request_json) = queued
            .request_json
            .as_deref()
            .filter(|text| !text.is_empty())
        {
            let payload: Value =
                serde_json::from_str(request_json).map_err(|error| error.to_string())?;
            let admit_request = UiCommandRequest {
                protocol_version: request.protocol_version.clone(),
                request_id: format!("{}-admit", request.request_id),
                entity_version: request.entity_version,
                message_type: "select_runtime".into(),
                payload,
            };
            self.admit_runtime(&admit_request)?;
            self.notices
                .insert(0, "Queued Attempt admitted after owner override".into());
        }
        Ok(())
    }

    fn record_close_choice(&self, request: &UiCommandRequest) -> Result<(Value, bool), String> {
        let request_id = payload_text_default(&request.payload, "requestId", &request.request_id);
        if request_id.trim().is_empty() {
            return Err("payload.requestId is required".into());
        }
        let row_id = format!("close-choice:{request_id}");
        if let Some(existing) = self
            .store
            .get_product_receipt_by_id(&row_id)
            .map_err(store_message)?
        {
            return Ok((existing, true));
        }
        let choice = payload_text(&request.payload, "choice")?;
        let persisted_choice = match choice.as_str() {
            "continue" | "continue-background" => "continue-background",
            "stop" | "stop-background" => "stop-background",
            other => return Err(format!("unsupported close choice: {other}")),
        };
        let attempt_id = payload_text(&request.payload, "attemptId")?;
        let campaign_id = payload_text_default(&request.payload, "campaignId", "");
        let recorded_at = store::utc_now_iso();
        let receipt_id = format!("rcpt-{}", hash_id(&format!("{request_id}:{recorded_at}")));
        let ui_pid = payload_u64(&request.payload, "uiPid").unwrap_or(0);
        let ui_created_ms = payload_u64(&request.payload, "uiCreatedMs").unwrap_or(0);
        let payload = json!({
            "kind": "close-choice",
            "requestId": request_id,
            "receiptId": receipt_id,
            "choice": persisted_choice,
            "uiPid": ui_pid,
            "uiCreatedMs": ui_created_ms,
            "uiCreationDate": crate::process_identity::cim_date(ui_created_ms),
            "campaignId": campaign_id,
            "attemptId": attempt_id,
            "mainReceivedAtUtc": payload_text_default(&request.payload, "mainReceivedAtUtc", &recorded_at),
            "coreReceiptPersistedAtUtc": recorded_at,
            "recordedAtUtc": recorded_at,
        });
        self.store
            .put_product_receipt(
                &row_id,
                "close-choice",
                None,
                Some(&receipt_id),
                Some(&attempt_id),
                &payload,
            )
            .map_err(store_message)?;
        self.persist_event(&attempt_id, "ui.close_choice", payload.clone(), None)?;
        Ok((payload, false))
    }

    fn get_startup_receipt(&self, request: &UiCommandRequest) -> Result<Value, String> {
        let nonce = payload_text_default(&request.payload, "launchNonce", "");
        let value = if nonce.is_empty() {
            self.store.latest_product_receipt("startup")
        } else {
            self.store.get_product_receipt_by_nonce("startup", &nonce)
        }
        .map_err(store_message)?;
        value.ok_or_else(|| "startup receipt not found".into())
    }

    fn get_close_choice_receipt(&self, request: &UiCommandRequest) -> Result<Value, String> {
        if let Ok(receipt_id) = payload_text(&request.payload, "receiptId") {
            return self
                .store
                .get_product_receipt_by_receipt_id(&receipt_id)
                .map_err(store_message)?
                .ok_or_else(|| "close-choice receipt not found".into());
        }
        if let Ok(request_id) = payload_text(&request.payload, "requestId") {
            return self
                .store
                .get_product_receipt_by_id(&format!("close-choice:{request_id}"))
                .map_err(store_message)?
                .ok_or_else(|| "close-choice receipt not found".into());
        }
        self.store
            .latest_product_receipt("close-choice")
            .map_err(store_message)?
            .ok_or_else(|| "close-choice receipt not found".into())
    }

    fn insert_notice_unique(&mut self, notice: String) {
        if self.notices.iter().any(|existing| existing == &notice) {
            return;
        }
        self.notices.insert(0, notice);
    }

    fn merge_permission_denied_notices(&self, notices: &mut Vec<String>) -> Result<(), String> {
        let campaigns = self.store.list_campaigns().map_err(store_message)?;
        for campaign in campaigns {
            let tasks = self
                .store
                .tasks_for_campaign(&campaign.id)
                .map_err(store_message)?;
            for task in tasks {
                let attempts = self
                    .store
                    .attempts_for_task(&task.id)
                    .map_err(store_message)?;
                for attempt in attempts {
                    let records = self
                        .store
                        .list_event_records(&attempt.id, 0)
                        .map_err(store_message)?;
                    for record in records {
                        if record.event.kind != "permission.response" {
                            continue;
                        }
                        let Some(payload) = record.payload.as_ref() else {
                            continue;
                        };
                        if payload.get("allow") != Some(&json!(false)) {
                            continue;
                        }
                        let Some(decision_id) = payload.get("decisionId").and_then(Value::as_str)
                        else {
                            continue;
                        };
                        if notices.iter().any(|notice| {
                            notice.contains(decision_id) && notice.contains("Permission denied")
                        }) {
                            continue;
                        }
                        let notice = payload
                            .get("notice")
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                            .unwrap_or_else(|| {
                                let session = payload
                                    .get("sessionHash")
                                    .and_then(Value::as_str)
                                    .map(str::to_owned)
                                    .or_else(|| attempt.provider_session.as_deref().map(hash_id))
                                    .unwrap_or_else(|| "unbound".into());
                                permission_denied_notice(
                                    decision_id,
                                    &attempt.id,
                                    &campaign.id,
                                    &task.id,
                                    &session,
                                    &record.event.seq.to_string(),
                                )
                            });
                        if !notices.iter().any(|existing| existing == &notice) {
                            notices.push(notice);
                        }
                    }
                }
            }
        }
        Ok(())
    }

    fn persist_event(
        &self,
        attempt_id: &str,
        kind: &str,
        payload: Value,
        state: Option<AttemptState>,
    ) -> Result<(), String> {
        let attempt = self.store.get_attempt(attempt_id).map_err(store_message)?;
        let event = Event {
            id: format!("core-event-{}-{}", attempt_id, attempt.last_event_seq + 1),
            attempt_id: attempt_id.into(),
            seq: attempt.last_event_seq + 1,
            kind: kind.into(),
            payload_ref: None,
        };
        match self
            .store
            .append_event_with_state(&event, state, Some(&payload))
            .map_err(store_message)?
        {
            AppendEventOutcome::Inserted(_) | AppendEventOutcome::Duplicate(_) => Ok(()),
        }
    }

    fn persist_agent_event(&self, event: &AgentEventEnvelope) -> Result<(), String> {
        let kind = match event.event_type {
            AgentEventType::SessionCreated => "runtime.session.created",
            AgentEventType::TurnStarted => "runtime.turn.started",
            AgentEventType::MessageDelta => "runtime.reply.delta",
            AgentEventType::ToolActivity => "runtime.tool.activity",
            AgentEventType::PermissionRequest => "runtime.permission.request",
            AgentEventType::PermissionResponse => "runtime.permission.response",
            AgentEventType::Waiting => "runtime.waiting",
            AgentEventType::TurnCompleted => "runtime.turn.completed",
            AgentEventType::TurnFailed => "runtime.turn.failed",
            AgentEventType::Cancelled => "runtime.turn.cancelled",
            AgentEventType::Unknown if event.payload.get("claude_native_frame").is_some() => "runtime.native.frame",
            AgentEventType::Unknown => "runtime.event.unknown",
        };
        let state = match event.event_type {
            AgentEventType::TurnFailed => Some(AttemptState::Failed),
            AgentEventType::Cancelled => Some(AttemptState::Cancelled),
            AgentEventType::TurnCompleted => Some(AttemptState::AwaitingReview),
            _ => None,
        };
        let state = if event.event_type == AgentEventType::TurnCompleted
            && event
                .payload
                .get("status")
                .and_then(Value::as_str)
                .is_some_and(|status| {
                    status.eq_ignore_ascii_case("interrupted")
                        || status.eq_ignore_ascii_case("cancelled")
                }) {
            Some(AttemptState::Cancelled)
        } else {
            state
        };
        let mut state = if self
            .store
            .get_attempt(&event.attempt_id)
            .map_err(store_message)?
            .state
            .is_terminal()
        {
            None
        } else {
            state
        };
        let attempt = self
            .store
            .get_attempt(&event.attempt_id)
            .map_err(store_message)?;
        let mut payload = event.payload.clone();
        let mut claude_exact_interrupted = false;
        if attempt.provider.eq_ignore_ascii_case("claude") {
            let reported_native_state = event
                .payload
                .get("native_turn_state")
                .and_then(Value::as_str)
                .and_then(|state| match state {
                    "interrupted" => Some(StopNativeTurnState::Interrupted),
                    "unconfirmed" => Some(StopNativeTurnState::Unconfirmed),
                    _ => None,
                });
            let operation_id = event
                .payload
                .get("stop_operation_id")
                .and_then(Value::as_str);
            let residual = event
                .payload
                .get("residual_execution_state")
                .and_then(Value::as_str);
            let responsibility = event
                .payload
                .get("write_responsibility")
                .and_then(Value::as_str);
            let native_turn_cancel = event
                .payload
                .get("native_turn_cancel")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let safe_process_stop = event
                .payload
                .get("safe_process_stop")
                .and_then(Value::as_bool);
            let native_state = match reported_native_state {
                Some(StopNativeTurnState::Interrupted)
                    if native_turn_cancel && safe_process_stop == Some(false) =>
                {
                    Some(StopNativeTurnState::Interrupted)
                }
                Some(StopNativeTurnState::Unconfirmed) if safe_process_stop == Some(false) => {
                    Some(StopNativeTurnState::Unconfirmed)
                }
                _ => None,
            };
            if let (Some(native_state), Some(operation_id), Some(residual), Some("held")) =
                (native_state, operation_id, residual, responsibility)
            {
                let binding = json!({
                    "input_uuid": event.payload.get("input_uuid").cloned().unwrap_or(Value::Null),
                    "session_id": event.payload.get("session_id").cloned().unwrap_or(Value::Null),
                    "turn_epoch": event.payload.get("turn_epoch").cloned().unwrap_or(Value::Null),
                    "process_epoch": event.payload.get("process_epoch").cloned().unwrap_or(Value::Null)
                });
                if matches!(residual, "unknown" | "active") {
                    let parent_operation_id = self
                        .store
                        .stop_responsibility_for_attempt(&event.attempt_id)
                        .map_err(store_message)?
                        .and_then(|row| row.detail)
                        .and_then(|detail| detail.get("parentOperationId").cloned());
                    // Exact operation plus exact immutable binding is required. Foreign,
                    // stale or incomplete frames remain journal evidence only.
                    match self
                        .store
                        .update_stop_responsibility(&StopResponsibilityUpdate {
                            attempt_id: event.attempt_id.clone(),
                            operation_id: operation_id.into(),
                            binding,
                            native_turn_state: native_state,
                            residual_execution_state: residual.into(),
                            detail: Some(json!({
                                "source": "Claude native outcome",
                                "parentOperationId": parent_operation_id,
                                "payload": event.payload.clone()
                            })),
                        }) {
                        Ok(Some(updated)) => {
                            claude_exact_interrupted = native_state
                                == StopNativeTurnState::Interrupted
                                && updated.native_turn_state == StopNativeTurnState::Interrupted;
                        }
                        Ok(None) | Err(StoreError::InvalidState(_)) => {}
                        Err(error) => return Err(store_message(error)),
                    }
                }
            }
            if state == Some(AttemptState::Cancelled) && !claude_exact_interrupted {
                if let Some(current) = self
                    .store
                    .stop_responsibility_for_attempt(&event.attempt_id)
                    .map_err(store_message)?
                {
                    let _ = self
                        .store
                        .update_stop_responsibility(&StopResponsibilityUpdate {
                            attempt_id: current.attempt_id.clone(),
                            operation_id: current.operation_id.clone(),
                            binding: current.binding.clone(),
                            native_turn_state: StopNativeTurnState::Unconfirmed,
                            residual_execution_state: current.residual_execution_state.clone(),
                            detail: Some(json!({
                                "source": "Claude native outcome mismatch",
                                "previousDetail": current.detail,
                                "payload": event.payload.clone()
                            })),
                        })
                        .map_err(store_message)?;
                }
                state = None;
            }
        }
        if attempt.provider.eq_ignore_ascii_case("codex")
            || attempt.provider.eq_ignore_ascii_case("grok")
        {
            let binding = self
                .persist_runtime_epoch_binding(&event.attempt_id)?
                .ok_or_else(|| {
                    "native Runtime event has no canonical Runtime binding".to_string()
                })?;
            if event.process_epoch_id != binding.process_epoch
                || event.task_id != binding.task_id
                || event.campaign_id.as_deref() != Some(binding.campaign_id.as_str())
            {
                return Err("Runtime event identity does not match canonical binding".into());
            }
            let object = payload
                .as_object_mut()
                .ok_or_else(|| "Runtime event payload must be an object".to_string())?;
            object.insert(
                "goalportRuntime".into(),
                runtime_binding_payload(&binding, &event.occurred_at, &event.received_at),
            );
        }
        self.persist_event(&event.attempt_id, kind, payload, state)?;
        // A native permission answered `cancelled` (Safe stop while the prompt was
        // pending) must not leave its Decision pending for ever: no option was selected,
        // so the Decision is closed as CANCELLED rather than approved or denied.
        if event.event_type == AgentEventType::PermissionResponse
            && event
                .payload
                .get("cancelled")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            && let Some(decision_id) = event.payload.get("request_id").and_then(Value::as_str)
            && let Ok(decision) = self.store.get_decision(decision_id)
            && decision.state == DecisionState::Pending
        {
            self.store
                .update_decision_state(decision_id, DecisionState::Cancelled)
                .map_err(store_message)?;
        }
        if event.event_type == AgentEventType::PermissionRequest {
            let decision_id = event
                .payload
                .get("request_id")
                .or_else(|| event.payload.get("requestId"))
                .and_then(Value::as_str)
                .unwrap_or(&event.event_id)
                .to_owned();
            self.store
                .insert_decision(&Decision {
                    id: decision_id,
                    attempt_id: event.attempt_id.clone(),
                    kind: "permission".into(),
                    state: DecisionState::Pending,
                })
                .map_err(store_message)?;
        }
        Ok(())
    }

    fn campaigns_for_project(&self, project_id: &str) -> Result<Vec<Campaign>, String> {
        let mapped = self
            .store
            .campaigns_for_project(project_id)
            .map_err(store_message)?;
        if !mapped.is_empty() {
            return Ok(mapped);
        }
        // Legacy rows from the disconnected Preview had no project mapping. A
        // single existing project may safely display them until a new command
        // associates them explicitly; no host-side identity is invented.
        let projects = self.store.list_projects().map_err(store_message)?;
        if projects.len() == 1 {
            return self.store.list_campaigns().map_err(store_message);
        }
        Ok(Vec::new())
    }
}

fn runtime_binding_payload(
    binding: &RuntimeEpochBinding,
    occurred_at: &str,
    received_at: &str,
) -> Value {
    json!({
        "campaignId": binding.campaign_id,
        "taskId": binding.task_id,
        "attemptId": binding.attempt_id,
        "provider": binding.provider,
        "providerSessionHash": binding.session_hash,
        "processEpoch": binding.process_epoch,
        "runtimePid": binding.runtime_pid,
        "runtimeCreationDate": binding.runtime_creation_date,
        "runtimeExecutablePath": binding.runtime_executable_path,
        "runtimeExecutableSha256": binding.runtime_executable_sha256,
        "coreEpochId": binding.core_epoch_id,
        "occurredAtEpochMs": occurred_at,
        "receivedAtEpochMs": received_at,
    })
}

fn project_to_ui(project: &Project) -> UiProject {
    UiProject {
        id: project.id.clone(),
        name: project
            .id
            .strip_prefix("project-")
            .unwrap_or(&project.id)
            .replace('-', " "),
        workspace_root: project.workspace_root.clone(),
        color: "violet".into(),
    }
}

fn campaign_to_ui(
    campaign: &Campaign,
    store: &Store,
    project_id: &str,
) -> Result<UiCampaign, String> {
    let tasks = store
        .tasks_for_campaign(&campaign.id)
        .map_err(store_message)?;
    let title = tasks
        .first()
        .map(|task| task.title.clone())
        .unwrap_or_else(|| campaign.goal.clone());
    Ok(UiCampaign {
        id: campaign.id.clone(),
        project_id: project_id.into(),
        title,
        goal: campaign.goal.clone(),
        state: work_status_ui(campaign.state),
        task_count: tasks.len(),
        active_task_title: tasks
            .first()
            .map(|task| task.title.clone())
            .unwrap_or_default(),
        updated_label: "Core · current".into(),
    })
}

fn task_to_ui(task: &Task) -> UiTask {
    UiTask {
        id: task.id.clone(),
        title: task.title.clone(),
        acceptance: task.acceptance.clone(),
        state: match task.state {
            crate::domain::WorkStatus::Finished => "complete",
            crate::domain::WorkStatus::Failed | crate::domain::WorkStatus::Abandoned => "blocked",
            crate::domain::WorkStatus::InProgress => "in-progress",
        }
        .into(),
    }
}

fn attempt_to_ui(attempt: &Attempt, store: &Store) -> UiAttempt {
    let event_count = store
        .list_events(&attempt.id)
        .map(|events| events.len())
        .unwrap_or_default();
    UiAttempt {
        id: attempt.id.clone(),
        task_id: attempt.task_id.clone(),
        provider: attempt.provider.clone(),
        role: "executor".into(),
        state: match attempt.state {
            AttemptState::Queued => "waiting",
            AttemptState::Active => "active",
            AttemptState::AwaitingReview => "waiting",
            AttemptState::Closed => "completed",
            AttemptState::Failed => "failed",
            AttemptState::Cancelled => "failed",
        }
        .into(),
        session_label: attempt
            .provider_session
            .as_deref()
            .map(|session| format!("Native session {}", hash_id(session)))
            .unwrap_or_else(|| "Core session pending".into()),
        session_hash: attempt.provider_session.as_deref().map(hash_id),
        event_count,
    }
}

fn coalesce_reply_deltas(
    items: Vec<UiTimelineItem>,
    records: &[EventRecord],
) -> Vec<UiTimelineItem> {
    let mut out: Vec<UiTimelineItem> = Vec::new();
    for (item, record) in items.into_iter().zip(records.iter()) {
        let kind = record.event.kind.as_str();
        let is_reply = kind == "runtime.reply.delta";
        let is_unknown = kind == "runtime.event.unknown";
        if is_unknown && (item.body.is_empty() || item.body == kind) {
            continue;
        }
        if item.kind == "message" && !item.body.is_empty() && item.body != kind {
            let last_is_same_actor_message = out
                .last()
                .is_some_and(|last| last.kind == "message" && last.actor == item.actor);
            let prev_idx = out
                .iter()
                .rposition(|card| card.kind == "message" && card.actor == item.actor);
            if let Some(idx) = prev_idx {
                let previous_body = out[idx].body.clone();
                if item.body == previous_body {
                    continue;
                }
                if (is_reply || is_unknown) && item.body.starts_with(&previous_body) {
                    out[idx].body = item.body;
                    out[idx].cursor = item.cursor;
                    out[idx].timestamp = item.timestamp;
                    continue;
                }
                if (is_reply || is_unknown) && previous_body.starts_with(&item.body) {
                    continue;
                }
                if is_reply && last_is_same_actor_message {
                    out[idx].body.push_str(&item.body);
                    out[idx].cursor = item.cursor;
                    out[idx].timestamp = item.timestamp;
                    continue;
                }
            }
        }
        out.push(item);
    }
    out
}

fn event_to_timeline(record: &EventRecord) -> UiTimelineItem {
    let payload = record.payload.as_ref();
    let kind = if record.event.kind == "runtime.native.frame" {
        "audit"
    } else if record.event.kind.contains("tool") {
        "tool"
    } else if record.event.kind.contains("permission") {
        "permission"
    } else if record.event.kind.contains("handoff") {
        "handoff"
    } else if record.event.kind.contains("attempt") || record.event.kind.contains("turn") {
        "attempt"
    } else if record.event.kind.contains("waiting") {
        "recovery"
    } else if record.event.kind.contains("evidence") {
        "evidence"
    } else {
        "message"
    };
    let body = payload
        .and_then(|value| {
            value
                .get("text")
                .or_else(|| value.get("message"))
                .and_then(Value::as_str)
        })
        .map(str::to_owned)
        .or_else(|| {
            payload.and_then(|value| {
                value
                    .get("tool")
                    .and_then(Value::as_str)
                    .map(|tool| format!("Tool: {tool}"))
            })
        })
        .or_else(|| {
            payload
                .and_then(|value| value.get("packetVersion"))
                .and_then(Value::as_str)
                .map(|_| "Core handoff packet committed".into())
        })
        .unwrap_or_else(|| record.event.kind.clone());
    let status = if record.event.kind.contains("completed") || record.event.kind.ends_with("active")
    {
        Some("COMMITTED".into())
    } else if record.event.kind.contains("failed") || record.event.kind.contains("cancel") {
        Some("FAILED".into())
    } else if record.event.kind.contains("permission") {
        Some("WAITING".into())
    } else {
        None
    };
    let mut details = vec![
        format!("Core cursor {}", record.event.seq),
        format!("Attempt {}", record.event.attempt_id),
    ];
    if let Some(native_thread_hash) = payload
        .and_then(|value| value.get("native_thread_hash"))
        .and_then(Value::as_str)
    {
        details.push(format!("Native thread hash {}", native_thread_hash));
    }
    if let Some(native_turn_hash) = payload
        .and_then(|value| value.get("native_turn_hash"))
        .and_then(Value::as_str)
    {
        details.push(format!("Native turn hash {}", native_turn_hash));
    }
    if let Some(request_id) = payload
        .and_then(|value| value.get("requestId"))
        .and_then(Value::as_str)
    {
        details.push(format!("Prompt request {}", request_id));
    }
    if let Some(session_hash) = payload
        .and_then(|value| value.get("sessionHash"))
        .and_then(Value::as_str)
    {
        details.push(format!("Provider session hash {}", session_hash));
    }
    if let Some(provider_event_hash) = payload
        .and_then(|value| value.get("provider_event_hash"))
        .and_then(Value::as_str)
    {
        details.push(format!("Provider event hash {}", provider_event_hash));
    }
    UiTimelineItem {
        id: record.event.id.clone(),
        kind: kind.into(),
        actor: if record.event.kind.starts_with("runtime") {
            "Native Runtime"
        } else {
            "Core"
        }
        .into(),
        title: if record.event.kind == "runtime.native.frame" { "Native protocol evidence".into() } else { timeline_title(kind) },
        body,
        timestamp: record.created_at.clone(),
        status,
        evidence_state: None,
        details,
        accent: match kind {
            "tool" => "slate",
            "permission" => "red",
            "handoff" => "amber",
            "attempt" => "blue",
            _ => "violet",
        }
        .into(),
        cursor: record.event.seq,
    }
}

fn timeline_title(kind: &str) -> String {
    match kind {
        "tool" => "Tool activity committed",
        "permission" => "Permission decision required",
        "handoff" => "Attempt handoff committed",
        "attempt" => "Attempt state updated",
        "recovery" => "Waiting or recovery state",
        _ => "Message committed",
    }
    .into()
}

fn decision_to_ui(decision: Decision) -> UiDecision {
    UiDecision {
        id: decision.id,
        title: format!("{} permission", decision.kind),
        kind: decision.kind,
        facts: vec![
            "Request came from the Core-owned Runtime event path".into(),
            "No external effect is replayed automatically".into(),
        ],
        recommendation: "Review the exact Runtime request before allowing it.".into(),
        default_behavior: "Remain blocked and do not retry automatically.".into(),
        state: if decision.state == DecisionState::Pending {
            "pending"
        } else {
            "resolved"
        }
        .into(),
    }
}

fn evidence_to_ui(evidence: Evidence) -> UiEvidence {
    UiEvidence {
        id: evidence.id,
        claim: evidence.claim,
        state: match evidence.verdict {
            Verdict::Verified => "verified",
            Verdict::Contested => "stale",
            Verdict::Waived => "unavailable",
            Verdict::Unassessed | Verdict::Claimed | Verdict::PartiallyVerified => "needs-review",
        }
        .into(),
        source: "Core SQLite evidence".into(),
        snapshot: evidence.snapshot_hash,
    }
}

/// Build the display DTO. `context` carries what the responsibility row alone
/// cannot answer -- which task, which campaign, when, and whether this hold governs
/// the workspace the user is currently looking at.
fn stop_responsibility_to_ui_with(
    row: StopResponsibility,
    context: StopResponsibilityContext,
) -> UiStopResponsibility {
    let mut ui = stop_responsibility_to_ui(row);
    ui.task_title = context.task_title;
    ui.campaign_goal = context.campaign_goal;
    ui.blocks_current_workspace = context.blocks_current_workspace;
    ui.latest_recheck = context.latest_recheck;
    ui.blocked_reason = if context.blocks_current_workspace {
        format!(
            "New work in {} is blocked by durable Stop responsibility held for attempt {}              (operation {}); residual execution is {}",
            ui.workspace_key, ui.attempt_id, ui.operation_id, ui.residual_execution_state
        )
    } else {
        // Said explicitly, because the same three states rendered without it would
        // read as "your current workspace is blocked".
        format!(
            "This hold belongs to source workspace {}; the current workspace is not blocked by it.              Residual execution there is {} and write responsibility remains held.",
            ui.workspace_key, ui.residual_execution_state
        )
    };
    ui
}

#[derive(Debug, Clone, Default)]
struct StopResponsibilityContext {
    task_title: String,
    campaign_goal: String,
    blocks_current_workspace: bool,
    latest_recheck: Option<Value>,
}

fn stop_responsibility_to_ui(row: StopResponsibility) -> UiStopResponsibility {
    let input_uuid = row
        .binding
        .get("input_uuid")
        .and_then(Value::as_str)
        .unwrap_or("unbound")
        .to_owned();
    let session_hash = row
        .binding
        .get("session_id")
        .and_then(Value::as_str)
        .map(hash_id)
        .unwrap_or_else(|| "unbound".into());
    let turn_epoch = row
        .binding
        .get("turn_epoch")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let process_epoch = row
        .binding
        .get("process_epoch")
        .and_then(Value::as_str)
        .unwrap_or("unbound")
        .to_owned();
    let source = row
        .detail
        .as_ref()
        .and_then(|detail| detail.get("source"))
        .and_then(Value::as_str)
        .unwrap_or("Core durable Stop responsibility")
        .to_owned();
    let workspace_key = row.workspace_key.clone();
    let interrupted_at = row.created_at.clone();
    UiStopResponsibility {
        workspace_key,
        interrupted_at,
        task_title: String::new(),
        campaign_goal: String::new(),
        blocked_reason: String::new(),
        blocks_current_workspace: true,
        latest_recheck: None,
        attempt_id: row.attempt_id,
        operation_id: row.operation_id,
        provider: row.provider,
        native_turn_state: match row.native_turn_state {
            StopNativeTurnState::Pending => "pending",
            StopNativeTurnState::Interrupted => "interrupted",
            StopNativeTurnState::Unconfirmed => "unconfirmed",
        }
        .into(),
        residual_execution_state: row.residual_execution_state,
        write_responsibility: row.write_responsibility,
        input_uuid,
        session_hash,
        turn_epoch,
        process_epoch,
        source,
        detail: row.detail,
    }
}

fn runtime_profiles() -> Vec<UiRuntime> {
    vec![
        UiRuntime {
            id: "codex".into(),
            name: "Codex".into(),
            version: runtime_version("codex"),
            support: "partial".into(),
            mode: "Executor".into(),
            subtitle: "Native app-server · subscription path".into(),
            reasons: vec![
                "Uses installed ChatGPT-authenticated Codex CLI".into(),
                "Permissions and interrupt remain directly observable gates".into(),
            ],
            capabilities: UiRuntimeCapabilities {
                events: "needs-review".into(),
                resume: "needs-review".into(),
                permissions: "needs-review".into(),
                cancel: "needs-review".into(),
            },
        },
        UiRuntime {
            id: "claude".into(),
            name: "Claude Code".into(),
            version: "not observed in this Attempt".into(),
            support: "partial".into(),
            mode: "Planner".into(),
            subtitle: "Native stream-json · subscription path".into(),
            reasons: vec![
                "Uses the unmodified native CLI over persistent stream-json".into(),
                "Host permission prompts are fail-closed; resume stays unsupported until proven"
                    .into(),
            ],
            capabilities: UiRuntimeCapabilities {
                events: "needs-review".into(),
                resume: "unsupported".into(),
                permissions: "needs-review".into(),
                cancel: "needs-review".into(),
            },
        },
        UiRuntime {
            id: "grok".into(),
            name: "Grok".into(),
            version: runtime_version("grok"),
            support: "partial".into(),
            mode: "Auditor".into(),
            subtitle: "ACP stdio · subscription path".into(),
            reasons: vec![
                "Uses the installed subscription-authenticated Grok CLI over ACP stdio".into(),
                "Native permission prompts are enabled per session; approvals stay one-shot".into(),
            ],
            capabilities: UiRuntimeCapabilities {
                events: "needs-review".into(),
                resume: "needs-review".into(),
                permissions: "needs-review".into(),
                cancel: "needs-review".into(),
            },
        },
        UiRuntime {
            id: "scenario".into(),
            name: "Scenario Runtime".into(),
            version: "scenario-1".into(),
            support: "supported".into(),
            mode: "Contract test".into(),
            subtitle: "Deterministic synthetic fixture".into(),
            reasons: vec!["Available for local connected UI and Core contract tests".into()],
            capabilities: UiRuntimeCapabilities {
                events: "verified".into(),
                resume: "verified".into(),
                permissions: "verified".into(),
                cancel: "unsupported".into(),
            },
        },
    ]
}

fn runtime_version(provider: &str) -> String {
    match provider {
        "codex" => "0.152.0",
        "claude" => "2.1.259",
        "grok" => "1.0.13",
        _ => "scenario-1",
    }
    .into()
}

fn work_status_ui(state: crate::domain::WorkStatus) -> String {
    match state {
        crate::domain::WorkStatus::InProgress => "active",
        crate::domain::WorkStatus::Finished => "complete",
        crate::domain::WorkStatus::Abandoned | crate::domain::WorkStatus::Failed => "blocked",
    }
    .into()
}

fn attempt_state_label(state: AttemptState) -> &'static str {
    match state {
        AttemptState::Queued => "QUEUED",
        AttemptState::Active => "ACTIVE",
        AttemptState::AwaitingReview => "AWAITING_REVIEW",
        AttemptState::Closed => "CLOSED",
        AttemptState::Failed => "FAILED",
        AttemptState::Cancelled => "CANCELLED",
    }
}

fn hash_id(value: &str) -> String {
    sha256_hex(value.as_bytes())
}

fn permission_denied_notice(
    decision_id: &str,
    attempt_id: &str,
    campaign_id: &str,
    task_id: &str,
    session_hash: &str,
    turn: &str,
) -> String {
    format!(
        "Permission denied decision {decision_id} attempt {attempt_id} campaign {campaign_id} task {task_id} session {session_hash} turn {turn}"
    )
}

fn bounded_core_text(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn complete_claude_stop_binding(binding: &Value) -> bool {
    let Some(object) = binding.as_object() else {
        return false;
    };
    object.len() == 4
        && ["input_uuid", "session_id", "process_epoch"]
            .into_iter()
            .all(|field| {
                object
                    .get(field)
                    .and_then(Value::as_str)
                    .is_some_and(|value| !value.trim().is_empty())
            })
        && object.get("turn_epoch").is_some_and(|value| {
            value.as_u64().is_some() || value.as_i64().is_some_and(|number| number >= 0)
        })
}

fn current_executable_build_id() -> String {
    std::env::current_exe()
        .ok()
        .and_then(|path| fs::read(path).ok())
        .map(|bytes| sha256_hex(&bytes))
        .unwrap_or_else(|| "core-executable-hash-unavailable".into())
}

fn payload_text(value: &Value, key: &str) -> Result<String, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| format!("payload.{key} is required"))
}

fn payload_text_default(value: &Value, key: &str, fallback: &str) -> String {
    payload_text(value, key).unwrap_or_else(|_| fallback.to_owned())
}

fn payload_attempt_id(value: &Value, fallback: &str) -> String {
    match payload_text(value, "attemptId") {
        Ok(id) if id != UNASSIGNED_ATTEMPT_ID => id,
        _ => fallback.to_owned(),
    }
}

fn fresh_attempt_id(task_id: &str, provider: &str, request_id: &str) -> String {
    format!(
        "attempt-{}-{}-{}",
        stable_suffix(task_id),
        provider,
        sha256_hex(request_id.as_bytes())
    )
}

fn live_rollover_of(
    store: &store::Store,
    terminal_id: &str,
    task_id: &str,
    provider: &str,
) -> Result<Option<String>, String> {
    let attempts = store.attempts_for_task(task_id).map_err(store_message)?;
    let mut found = None;
    for attempt in attempts {
        if attempt.id == terminal_id
            || attempt.provider != provider
            || attempt.state.is_terminal()
        {
            continue;
        }
        let records = store
            .list_event_records(&attempt.id, 0)
            .map_err(store_message)?;
        let rolled_from_here = records.iter().any(|record| {
            record.event.kind == "attempt.created"
                && record
                    .payload
                    .as_ref()
                    .and_then(|payload| payload.get("rolledFrom"))
                    .and_then(Value::as_str)
                    == Some(terminal_id)
        });
        if rolled_from_here {
            found = Some(attempt.id);
        }
    }
    Ok(found)
}

fn resolve_admission_attempt_id(
    store: &store::Store,
    runtime_manager: &RuntimeManager,
    payload: &Value,
    task_id: &str,
    provider: &str,
    request_id: &str,
    allow_live_reuse: bool,
) -> Result<String, String> {
    let fallback = format!("attempt-{}-{}", stable_suffix(task_id), provider);
    let requested = payload_attempt_id(payload, &fallback);
    match store.get_attempt(&requested) {
        Ok(row) if row.task_id != task_id => Err(format!(
            "attempt {requested} is registered for another task; the request is refused"
        )),
        Ok(row) if row.state.is_terminal() => {
            if let Some(existing) = live_rollover_of(store, &requested, task_id, provider)? {
                Ok(existing)
            } else {
                Ok(fresh_attempt_id(task_id, provider, request_id))
            }
        }
        Ok(row)
            if row.provider != provider
                && row.state == AttemptState::Queued
                && runtime_manager.registered_binding(&requested).is_none() =>
        {
            Ok(fresh_attempt_id(task_id, provider, request_id))
        }
        Ok(_) if allow_live_reuse => Ok(requested),
        Ok(_) => Ok(fresh_attempt_id(task_id, provider, request_id)),
        Err(store::StoreError::NotFound(_)) => Ok(requested),
        Err(error) => Err(store_message(error)),
    }
}

fn payload_i64(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(Value::as_i64)
}

fn payload_u64(value: &Value, key: &str) -> Option<u64> {
    value.get(key).and_then(|item| {
        item.as_u64()
            .or_else(|| item.as_i64().and_then(|n| u64::try_from(n).ok()))
            .or_else(|| item.as_str().and_then(|text| text.parse().ok()))
    })
}

fn payload_bool(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

/// The five-row re-check mapping, kept as a free function so it can be tested
/// without a Store, a Runtime, or a live process.
///
/// Row 1 is evaluated first and short-circuits: with no usable recorded identity
/// there is nothing to observe, so `observe_process` is never called. Rows 2-5
/// then partition `ProcessObservation`'s three variants, with `Live` split by
/// whether the identity matches.
///
/// `not-running` is reachable only from row 2. That is the whole point: an
/// unobservable, unrecorded or mismatched runtime is `unknown`, never "gone",
/// because "gone" reads as safe and none of those states is.
fn classify_recheck(bound: &Value) -> (RuntimeObservation, RecheckVerdict, Value) {
    let pid = bound.get("pid").and_then(Value::as_u64).unwrap_or(0);
    let creation_date = bound
        .get("creationDate")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let sha = bound
        .get("executableSha256")
        .and_then(Value::as_str)
        .unwrap_or_default();

    // Row 1 -- record side. No identity was ever recorded for this hold.
    if bound.is_null() || pid == 0 || creation_date.is_empty() || sha.is_empty() {
        let missing = if bound.is_null() {
            "no Stop event carried a stop_attempt payload for this operation"
        } else if pid == 0 {
            "recorded bound_pid is 0 (the child identity was not observable at Stop time)"
        } else if creation_date.is_empty() {
            "recorded bound_creation_date is empty"
        } else {
            "recorded bound_executable_sha256 is empty"
        };
        return (
            RuntimeObservation::Unknown,
            RecheckVerdict::ObservationUnavailable,
            json!({
                "row": 1,
                "side": "record",
                "observeProcessCalled": false,
                "reason": missing,
            }),
        );
    }

    // Rows 2-5 -- observation side.
    match crate::process_identity::observe_process(pid as u32) {
        crate::process_identity::ProcessObservation::NotRunning => (
            RuntimeObservation::NotRunning,
            RecheckVerdict::BoundRuntimeAbsentResidualStillUnknown,
            json!({
                "row": 2,
                "side": "observation",
                "observeProcessCalled": true,
                "reason": "the exact bound process is not running; its descendants are not observed and residual execution stays unknown",
            }),
        ),
        crate::process_identity::ProcessObservation::Unknown(reason) => (
            RuntimeObservation::Unknown,
            RecheckVerdict::ObservationUnavailable,
            json!({
                "row": 3,
                "side": "observation",
                "observeProcessCalled": true,
                "reason": reason,
            }),
        ),
        crate::process_identity::ProcessObservation::Live(identity) => {
            let observed_date = identity.creation_date();
            let date_ok = observed_date == creation_date;
            let sha_ok = identity.executable_sha256 == sha;
            if date_ok && sha_ok {
                (
                    RuntimeObservation::Live,
                    RecheckVerdict::BoundRuntimeLive,
                    json!({
                        "row": 5,
                        "side": "observation",
                        "observeProcessCalled": true,
                        "reason": "pid, creation date and executable sha256 all match the identity recorded at Stop",
                        "observedCreationDate": observed_date,
                    }),
                )
            } else {
                // A recycled pid, or a different binary at the same pid. Neither is
                // evidence the bound process ended, so this is not `not-running`.
                (
                    RuntimeObservation::Unknown,
                    RecheckVerdict::ObservationUnavailable,
                    json!({
                        "row": 4,
                        "side": "observation",
                        "observeProcessCalled": true,
                        "reason": "a process exists at the recorded pid but its identity does not match",
                        "creationDateMatches": date_ok,
                        "executableSha256Matches": sha_ok,
                        "observedCreationDate": observed_date,
                    }),
                )
            }
        }
    }
}

fn stop_native_turn_state_str(state: StopNativeTurnState) -> &'static str {
    match state {
        StopNativeTurnState::Pending => "pending",
        StopNativeTurnState::Interrupted => "interrupted",
        StopNativeTurnState::Unconfirmed => "unconfirmed",
    }
}

/// The exact `CoreCommand` `send_message` records for a request, exposed so a caller (or a
/// test) can address the same row `send_message` will answer from. Identity: the command id is
/// `ui-send-{stable_suffix(request_id)}` and the payload hash covers the operation, which embeds
/// the attempt id, the event id `ui-event-{stable_suffix(request_id)}` and `sha256(message)` —
/// so a same-id request with a different attempt or message is a DIFFERENT command and is
/// refused as a conflict, never answered as a replay. `stable_suffix` is lossy: it keeps ASCII
/// alphanumerics and `-`, truncates to 48 characters, and falls back to the literal `"request"`
/// when nothing survives; two request ids sharing a 48-character prefix therefore share a row.
pub fn send_message_command(
    request_id: &str,
    attempt_id: &str,
    message: &str,
) -> Result<CoreCommand, String> {
    CoreCommand::new(
        format!("ui-send-{}", stable_suffix(request_id)),
        attempt_id.to_string(),
        CoreOperation::AppendEvent {
            event: Event {
                id: format!("ui-event-{}", stable_suffix(request_id)),
                attempt_id: attempt_id.to_string(),
                seq: 0,
                kind: "message.user".into(),
                payload_ref: Some(sha256_hex(message.as_bytes())),
            },
        },
    )
    .map_err(|error| error.to_string())
}

/// The caller-visible answer for a repeated `send_message`, derived ONLY from the recorded
/// command state and the recorded result (increment 7). `None` for a `Pending` row, which never
/// delivered anything and is executed normally. `Succeeded` replays as the existing
/// duplicate-success (`Ok(true)`). Every other state is a refusal whose text carries two stable
/// tokens — the command state and the recorded delivery state — plus the recorded reason, or
/// "reason not recorded" when the row carries none. An absent, empty or unrecognized
/// `deliveryState` reads as UNKNOWN, never as FAILED. Nothing here is inferred from the current
/// transport, liveness or authorization: a recorded result is reported, not re-derived.
fn replay_answer(
    request_id: &str,
    row: &Command,
    result: Option<&Value>,
) -> Option<Result<bool, String>> {
    let recorded = |key: &str| {
        result
            .and_then(|value| value.get(key))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
    };
    let delivery = match recorded("deliveryState") {
        Some(state @ ("FAILED" | "DELIVERED" | "UNKNOWN")) => state,
        _ => "UNKNOWN",
    };
    let reason = recorded("error").unwrap_or("reason not recorded");
    let refuse = |state: &str, delivery: &str, clause: &str| {
        Some(Err(format!(
            "replayed request {request_id} [state={state}] [delivery={delivery}]: {clause}; it \
             was not sent again"
        )))
    };
    match row.state {
        CommandState::Pending => None,
        CommandState::Succeeded => Some(Ok(true)),
        CommandState::Failed => refuse("FAILED", delivery, reason),
        CommandState::Unknown => refuse("UNKNOWN", delivery, reason),
        CommandState::Executing => refuse(
            "EXECUTING",
            "UNKNOWN",
            "still in progress; result not recorded yet",
        ),
    }
}

/// Whether a recorded result belongs to THIS request id. Rows recorded from increment 7 on carry
/// the exact `requestId`; a row without one (recorded before that, or never finished) cannot be
/// told apart from a same-identity request and keeps the pre-increment reading (residual R-O).
fn same_request(result: Option<&Value>, request_id: &str) -> bool {
    match result
        .and_then(|value| value.get("requestId"))
        .and_then(Value::as_str)
    {
        Some(recorded) => recorded == request_id,
        None => true,
    }
}

fn request_collision(request_id: &str, result: Option<&Value>) -> String {
    let recorded = result
        .and_then(|value| value.get("requestId"))
        .and_then(Value::as_str)
        .unwrap_or("<unrecorded>");
    format!(
        "request {request_id} collides with the recorded request {recorded}: same command \
         identity, different request id; it was not treated as a replay and was not sent"
    )
}

/// The delivery state once the adapter has answered: accepted means delivered; a refusal keeps an
/// earlier attempt's UNKNOWN (a retry that is refused does not prove the first write never
/// crossed the transport) and is FAILED only when nothing before it was uncertain.
fn delivery_after_answer(before: &'static str, accepted: bool) -> &'static str {
    if accepted {
        "DELIVERED"
    } else if before == "UNKNOWN" {
        "UNKNOWN"
    } else {
        "FAILED"
    }
}

#[cfg(test)]
mod replay_answer_tests {
    use super::*;

    #[test]
    fn same_request_requires_the_recorded_request_id_to_match_when_present() {
        assert!(same_request(None, "r"));
        assert!(same_request(Some(&json!({ "deliveryState": "FAILED" })), "r"));
        assert!(same_request(Some(&json!({ "requestId": "r" })), "r"));
        assert!(!same_request(Some(&json!({ "requestId": "r-other" })), "r"));
        let text = request_collision("r", Some(&json!({ "requestId": "r-other" })));
        assert!(text.contains("collides") && text.contains("r-other") && text.ends_with("was not sent"), "{text}");
        assert!(request_collision("r", None).contains("<unrecorded>"));
    }

    #[test]
    fn delivery_after_an_answer_keeps_the_first_attempts_uncertainty() {
        assert_eq!(delivery_after_answer("FAILED", true), "DELIVERED");
        assert_eq!(delivery_after_answer("UNKNOWN", true), "DELIVERED");
        assert_eq!(delivery_after_answer("FAILED", false), "FAILED");
        assert_eq!(delivery_after_answer("UNKNOWN", false), "UNKNOWN");
    }

    fn row(state: CommandState) -> Command {
        Command {
            id: "ui-send-r".into(),
            attempt_id: "attempt-r".into(),
            kind: "event.append".into(),
            payload_hash: "h".into(),
            state,
        }
    }

    fn refusal(state: CommandState, result: Option<Value>) -> String {
        match replay_answer("r", &row(state), result.as_ref()) {
            Some(Err(text)) => text,
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    #[test]
    fn pending_falls_through_and_succeeded_is_the_duplicate_success() {
        assert!(replay_answer("r", &row(CommandState::Pending), None).is_none());
        assert_eq!(replay_answer("r", &row(CommandState::Succeeded), None), Some(Ok(true)));
        assert_eq!(
            replay_answer("r", &row(CommandState::Succeeded), Some(&json!({ "deliveryState": "DELIVERED" }))),
            Some(Ok(true))
        );
    }

    #[test]
    fn failed_reports_the_recorded_delivery_state_and_reason_on_each_axis() {
        let failed = refusal(CommandState::Failed, Some(json!({ "deliveryState": "FAILED", "error": "stream closed" })));
        assert!(failed.contains("[state=FAILED]") && failed.contains("[delivery=FAILED]") && failed.contains("stream closed"), "{failed}");
        let delivered = refusal(CommandState::Failed, Some(json!({ "deliveryState": "DELIVERED", "error": "recovery persistence failed" })));
        assert!(delivered.contains("[state=FAILED]") && delivered.contains("[delivery=DELIVERED]") && delivered.contains("recovery persistence failed"), "{delivered}");
        let unknown = refusal(CommandState::Failed, Some(json!({ "deliveryState": "UNKNOWN", "error": "write failed; delivery unknown" })));
        assert!(unknown.contains("[state=FAILED]") && unknown.contains("[delivery=UNKNOWN]") && !unknown.contains("[delivery=FAILED]"), "{unknown}");
        for text in [&failed, &delivered, &unknown] {
            assert!(text.starts_with("replayed request r ") && text.ends_with("it was not sent again"), "{text}");
        }
    }

    #[test]
    fn missing_or_malformed_results_are_reported_as_not_recorded_never_invented() {
        let none = refusal(CommandState::Failed, None);
        assert!(none.contains("[state=FAILED] [delivery=UNKNOWN]: reason not recorded"), "{none}");
        let empty = refusal(CommandState::Failed, Some(json!({ "deliveryState": "", "error": "   " })));
        assert!(empty.contains("[delivery=UNKNOWN]: reason not recorded"), "{empty}");
        let bogus = refusal(CommandState::Failed, Some(json!({ "deliveryState": "SENT", "error": 7 })));
        assert!(bogus.contains("[delivery=UNKNOWN]: reason not recorded"), "{bogus}");
        let absent = refusal(CommandState::Failed, Some(json!({ "requestId": "r" })));
        assert!(absent.contains("[delivery=UNKNOWN]: reason not recorded"), "{absent}");
        let unknown = refusal(CommandState::Unknown, None);
        assert!(unknown.contains("[state=UNKNOWN] [delivery=UNKNOWN]: reason not recorded"), "{unknown}");
        let unknown_with = refusal(CommandState::Unknown, Some(json!({ "deliveryState": "UNKNOWN", "error": "uncertain send" })));
        assert!(unknown_with.contains("[state=UNKNOWN] [delivery=UNKNOWN]: uncertain send"), "{unknown_with}");
    }

    #[test]
    fn executing_is_in_progress_with_unknown_delivery_whatever_the_row_carries() {
        let text = refusal(CommandState::Executing, Some(json!({ "deliveryState": "DELIVERED", "error": "stale" })));
        assert!(text.contains("[state=EXECUTING] [delivery=UNKNOWN]: still in progress; result not recorded yet"), "{text}");
    }

    #[test]
    fn send_message_command_binds_identity_to_attempt_and_content() {
        let a = send_message_command("req/1!", "attempt-a", "hello").unwrap();
        let same = send_message_command("req/1!", "attempt-a", "hello").unwrap();
        let other_message = send_message_command("req/1!", "attempt-a", "hellp").unwrap();
        let other_attempt = send_message_command("req/1!", "attempt-b", "hello").unwrap();
        assert_eq!(a.command.id, "ui-send-req1");
        assert_eq!(a.command, same.command);
        assert_eq!(a.command.id, other_message.command.id);
        assert_ne!(a.command.payload_hash, other_message.command.payload_hash);
        assert_ne!(a.command.payload_hash, other_attempt.command.payload_hash);
        assert_eq!(send_message_command("!!!", "attempt-a", "x").unwrap().command.id, "ui-send-request");
    }
}

fn stable_suffix(value: &str) -> String {
    let mut output = String::new();
    for character in value.chars() {
        if character.is_ascii_alphanumeric() || character == '-' {
            output.push(character);
        }
    }
    if output.is_empty() {
        "request".into()
    } else {
        output.chars().take(48).collect()
    }
}

fn store_message(error: StoreError) -> String {
    error.to_string()
}

#[cfg(test)]
mod coalesce_tests {
    use super::*;
    use crate::domain::{AgentEventEnvelope, AgentEventType, Event};

    fn record(seq: i64, kind: &str, text: Option<&str>) -> EventRecord {
        EventRecord {
            event: Event {
                id: format!("e{seq}"),
                attempt_id: "attempt-dup".into(),
                seq,
                kind: kind.into(),
                payload_ref: None,
            },
            payload: text.map(|text| json!({ "text": text })),
            created_at: seq.to_string(),
        }
    }

    fn coalesce(records: &[EventRecord]) -> Vec<UiTimelineItem> {
        coalesce_reply_deltas(records.iter().map(event_to_timeline).collect(), records)
    }

    fn message_bodies(items: &[UiTimelineItem]) -> Vec<&str> {
        items
            .iter()
            .filter(|item| item.kind == "message")
            .map(|item| item.body.as_str())
            .collect()
    }

    #[test]
    fn native_protocol_evidence_never_coalesces_into_assistant_message() {
        let items=coalesce(&[
            record(1,"runtime.native.frame",Some("Claude result protocol evidence; generation time unknown")),
            record(2,"runtime.reply.delta",Some("DECLINE_FINISHED")),
        ]);
        assert_eq!(items.len(),2);
        assert_eq!(items[0].kind,"audit");
        assert_eq!(items[0].title,"Native protocol evidence");
        assert_eq!(message_bodies(&items),vec!["DECLINE_FINISHED"]);
    }

    #[test]
    fn mismatched_claude_cancel_is_journaled_without_cancelling_attempt() {
        let store = Store::memory().unwrap();
        let mut controller = UiController::new(store.clone()).unwrap();
        let snapshot = controller.snapshot(None).unwrap();
        let attempt_id = "attempt-claude-mismatch";
        store
            .insert_attempt(&Attempt::new(
                attempt_id,
                &snapshot.active_task.id,
                "claude",
                "claude-cap-v1",
            ))
            .unwrap();
        store
            .append_event_with_state(
                &Event {
                    id: "activate-claude-mismatch".into(),
                    attempt_id: attempt_id.into(),
                    seq: 1,
                    kind: "attempt.active".into(),
                    payload_ref: None,
                },
                Some(AttemptState::Active),
                None,
            )
            .unwrap();
        let binding = json!({
            "input_uuid": "input-expected",
            "session_id": "session-expected",
            "turn_epoch": 1,
            "process_epoch": "process-expected"
        });
        store
            .begin_stop_responsibility(
                attempt_id,
                "operation-expected",
                &snapshot.project.workspace_root,
                "claude",
                &binding,
                None,
            )
            .unwrap();

        controller
            .persist_agent_event(&AgentEventEnvelope {
                event_id: "native-mismatch".into(),
                campaign_id: Some(snapshot.active_campaign_id),
                task_id: snapshot.active_task.id,
                attempt_id: attempt_id.into(),
                process_epoch_id: "process-foreign".into(),
                sequence: 2,
                occurred_at: "2026-09-05T00:00:00Z".into(),
                received_at: "2026-09-05T00:00:01Z".into(),
                provider_event_reference: Some("foreign-result".into()),
                event_type: AgentEventType::Cancelled,
                payload: json!({
                    "stop_operation_id": "operation-expected",
                    "input_uuid": "input-expected",
                    "session_id": "session-foreign",
                    "turn_epoch": 1,
                    "process_epoch": "process-expected",
                    "native_turn_state": "interrupted",
                    "residual_execution_state": "unknown",
                    "write_responsibility": "held",
                    "native_turn_cancel": true,
                    "safe_process_stop": false
                }),
            })
            .unwrap();

        assert_eq!(
            store.get_attempt(attempt_id).unwrap().state,
            AttemptState::Active
        );
        assert_eq!(
            store
                .stop_responsibility_for_attempt(attempt_id)
                .unwrap()
                .unwrap()
                .native_turn_state,
            StopNativeTurnState::Unconfirmed
        );
        let records = store.list_event_records(attempt_id, 0).unwrap();
        assert!(records.iter().any(|record| {
            record.event.kind == "runtime.turn.cancelled"
                && record
                    .payload
                    .as_ref()
                    .and_then(|payload| payload.get("session_id"))
                    == Some(&json!("session-foreign"))
        }));
    }

    #[test]
    fn token_deltas_then_unknown_snapshot_is_one_message() {
        let snapshot = "已确认当前 run 仍是高风险 executing。";
        let records = vec![
            record(
                1,
                "runtime.reply.delta",
                Some("已确认当前 run 仍是高风险 executing"),
            ),
            record(2, "runtime.reply.delta", Some("。")),
            record(3, "runtime.event.unknown", Some(snapshot)),
        ];
        let items = coalesce(&records);
        assert_eq!(message_bodies(&items), [snapshot]);
    }

    #[test]
    fn exact_duplicate_unknown_after_message_is_skipped() {
        let body = "Message committed twice";
        let records = vec![
            record(1, "runtime.reply.delta", Some(body)),
            record(2, "runtime.tool.activity", Some("Read")),
            record(3, "runtime.event.unknown", Some(body)),
        ];
        let items = coalesce(&records);
        assert_eq!(message_bodies(&items), [body]);
    }

    #[test]
    fn empty_unknown_frames_are_dropped() {
        let records = vec![
            record(1, "runtime.reply.delta", Some("hello")),
            record(2, "runtime.event.unknown", None),
        ];
        let items = coalesce(&records);
        assert_eq!(message_bodies(&items), ["hello"]);
        assert!(
            items
                .iter()
                .all(|item| item.body != "runtime.event.unknown")
        );
    }

    #[test]
    fn consecutive_token_pieces_concatenate() {
        let records = vec![
            record(1, "runtime.reply.delta", Some("first")),
            record(2, "runtime.reply.delta", Some("second")),
        ];
        let items = coalesce(&records);
        assert_eq!(message_bodies(&items), ["firstsecond"]);
    }
}

#[cfg(test)]
mod resolve_admission_attempt_id_tests {
    use super::{fresh_attempt_id, resolve_admission_attempt_id};
    use crate::{
        domain::{Attempt, Event},
        runtime_manager::RuntimeManager,
        store::Store,
    };
    use serde_json::json;
    use std::path::Path;

    fn payload(attempt_id: &str) -> serde_json::Value {
        json!({ "attemptId": attempt_id })
    }

    #[test]
    fn queued_without_registration_mints_on_provider_change() {
        let store = Store::memory().unwrap();
        let manager = RuntimeManager::new();
        store
            .insert_attempt(&Attempt::new(
                "attempt-queued",
                "task-1",
                "codex",
                "codex-cap-v1",
            ))
            .unwrap();
        let resolved = resolve_admission_attempt_id(
            &store,
            &manager,
            &payload("attempt-queued"),
            "task-1",
            "scenario",
            "req-1",
            true,
        )
        .unwrap();
        assert_eq!(
            resolved,
            fresh_attempt_id("task-1", "scenario", "req-1")
        );
    }

    #[test]
    fn queued_with_registration_keeps_id_on_provider_change() {
        let store = Store::memory().unwrap();
        let mut manager = RuntimeManager::new();
        store
            .insert_attempt(&Attempt::new(
                "attempt-queued-kept",
                "task-1",
                "scenario",
                "scenario-cap-v1",
            ))
            .unwrap();
        manager
            .select_runtime(
                "attempt-queued-kept",
                "scenario",
                None,
                "scenario-cap-v1",
                Path::new("."),
            )
            .unwrap();
        let resolved = resolve_admission_attempt_id(
            &store,
            &manager,
            &payload("attempt-queued-kept"),
            "task-1",
            "claude",
            "req-2",
            true,
        )
        .unwrap();
        assert_eq!(resolved, "attempt-queued-kept");
    }

    #[test]
    fn replacement_ids_do_not_collapse_distinct_request_ids() {
        assert_ne!(
            fresh_attempt_id("task-1", "scenario", "rollover/a"),
            fresh_attempt_id("task-1", "scenario", "rollover_a")
        );
        let long_a = format!("{}a", "x".repeat(48));
        let long_b = format!("{}b", "x".repeat(48));
        assert_ne!(
            fresh_attempt_id("task-1", "scenario", &long_a),
            fresh_attempt_id("task-1", "scenario", &long_b)
        );
    }

    #[test]
    fn terminal_rollover_reuses_a_live_replacement_across_request_ids() {
        let store = Store::memory().unwrap();
        let manager = RuntimeManager::new();
        store
            .insert_attempt(&Attempt::new(
                "attempt-old",
                "task-1",
                "scenario",
                "scenario-cap-v1",
            ))
            .unwrap();
        store
            .append_event(&Event {
                id: "e-active".into(),
                attempt_id: "attempt-old".into(),
                seq: 1,
                kind: "attempt.active".into(),
                payload_ref: None,
            })
            .unwrap();
        store
            .append_event(&Event {
                id: "e-fail".into(),
                attempt_id: "attempt-old".into(),
                seq: 2,
                kind: "attempt.failed".into(),
                payload_ref: None,
            })
            .unwrap();
        let first = resolve_admission_attempt_id(
            &store,
            &manager,
            &payload("attempt-old"),
            "task-1",
            "scenario",
            "click-1",
            true,
        )
        .unwrap();
        store
            .insert_attempt(&Attempt::new(
                &first,
                "task-1",
                "scenario",
                "scenario-cap-v1",
            ))
            .unwrap();
        store
            .append_event_json(
                &Event {
                    id: "e-created".into(),
                    attempt_id: first.clone(),
                    seq: 1,
                    kind: "attempt.created".into(),
                    payload_ref: None,
                },
                &json!({ "provider": "scenario", "rolledFrom": "attempt-old" }),
            )
            .unwrap();
        let second = resolve_admission_attempt_id(
            &store,
            &manager,
            &payload("attempt-old"),
            "task-1",
            "scenario",
            "click-2",
            true,
        )
        .unwrap();
        assert_eq!(second, first);
        assert_ne!(first, "attempt-old");
    }
}
