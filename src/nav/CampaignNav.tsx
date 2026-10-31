import { useEffect, useRef, useState } from "react";
import type { CoreSnapshot, GoalCard } from "../types";
import { outcomeLabel, type CoordinationVerdict } from "../coordination/verdict";
import { shortGoalTitle } from "../conversation/shortGoalTitle";

interface CampaignNavProps {
  snapshot: CoreSnapshot;
  collapsed: boolean;
  plans?: readonly { requestId: string; title: string; active: boolean; verdict: CoordinationVerdict | null; savedAt?: string | null }[];
  onSelectPlan?: (requestId: string) => void;
  savedTargets?: readonly { requestId: string; title: string; workspacePath: string; outcome: string | null; statusLabel?: string; active: boolean; reason?: string | null }[];
  onSelectSavedTarget?: (requestId: string) => void;
  savedTargetOwnsView?: boolean;
  onSelectCampaign: (id: string) => void;
  onSelectProject: (id: string) => void;
  onRenameCampaign: (id: string, title: string) => void;
  runningJob?: { goal: string; stateLabel: string; viewing: boolean; locked?: boolean; workspace?: string; returnHint?: string | null } | null;
  navigationLocked?: boolean;
  navigationLockedReason?: string | null;
  onOpenRunningJob?: () => void;
  projectOverride?: string;
  failedOpenId?: string;
  goalListUnreadable?: boolean;
  newGoalEnabled?: boolean;
  plansUnreadable?: boolean;
  /** The composer is already saying this, so the sidebar does not repeat it. */
  plansSentenceVisible?: boolean;
}

/**
 * Left navigation: workspace switcher and goals. Titles come from the Core
 * campaign title / product conversation title. The active goal carries a
 * Rename affordance (a durable product title change — title entry exists only
 * here, never at creation). The "Current" activity label is gone.
 *
 * Collapsed state is an icon rail, never display:none — goal entries stay
 * reachable. At narrow widths the same markup becomes an off-canvas drawer
 * opened from the title bar toggle.
 */
function runningJobDetail(label: string): string {
  if (label === "Unreplayed") return "Unreplayed. The same request id cannot be admitted again.";
  if (label === "Not confirmed") return "Not confirmed. This goal's exit is not confirmed.";
  if (label === "Not admitted") return "Not admitted. The reply did not say the goal was admitted.";
  if (label === "Worker gone") return "Worker gone. Its exit is not confirmed.";
  if (label === "Failed") return "Failed. The last action did not succeed.";
  if (label === "Slot held") return "Slot held. The next valid send will release it.";
  if (label === "Stopped") return "Stopped. No further turn was sent.";
  return label;
}

export function CampaignNav({ snapshot, collapsed, plans = [], onSelectPlan, savedTargets = [], onSelectSavedTarget, savedTargetOwnsView = false, onSelectCampaign, onSelectProject, onRenameCampaign, runningJob = null, navigationLocked = false, navigationLockedReason = null, onOpenRunningJob, projectOverride, failedOpenId, goalListUnreadable = false, newGoalEnabled = false, plansUnreadable = false, plansSentenceVisible = true }: CampaignNavProps) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const overview = snapshot.goalOverview;
  const backgroundOwnsView = savedTargetOwnsView || runningJob?.viewing === true;
  const campaignListUnavailable = !overview && snapshot.bounds?.projectionUnavailable === true
    && snapshot.campaigns.length === 0;
  const goalCount = savedTargets.length + (overview ? overview.goals.length : snapshot.campaigns.length);

  useEffect(() => {
    if (renamingId) renameInputRef.current?.focus();
  }, [renamingId]);

  // A goal that finished while the user was elsewhere says so until they open it.
  const lastAttention = useRef(new Map<string, GoalCard["attention"]>(readLastAttention()));
  const [finished, setFinished] = useState<ReadonlySet<string>>(new Set());
  const goals = overview?.goals;
  useEffect(() => {
    if (!goals) return;
    const justFinished = goals.filter((goal) => goal.campaignId !== snapshot.activeCampaignId
      && lastAttention.current.get(goal.campaignId) === "running" && goal.attention === "complete").map((goal) => goal.campaignId);
    lastAttention.current = new Map(goals.map((goal) => [goal.campaignId, goal.attention]));
    rememberLastAttention(lastAttention.current);
    setFinished((current) => {
      const next = new Set([...current, ...justFinished]);
      next.delete(snapshot.activeCampaignId);
      return next.size === current.size && [...next].every((id) => current.has(id)) ? current : next;
    });
  }, [goals, snapshot.activeCampaignId]);

  // Core projects the persisted title for every goal, not just the active one.
  const titleFor = (_campaignId: string, title: string): string => title;

  const commitRename = () => {
    const id = renamingId;
    const title = renameDraft.trim();
    setRenamingId(null);
    if (id && title) onRenameCampaign(id, title);
  };

  return (
    <nav className={`campaign-nav${collapsed ? " nav-collapsed" : ""}`} aria-label="Workspace and goals">
      <div className="nav-head">
        <label className="project-switcher" aria-label={projectOverride || "Select project"}>
          <span className="project-avatar" aria-hidden="true">{projectOverride ? "·" : "G"}</span>
          <span className="project-switcher-copy">
            <strong>{projectOverride || snapshot.project.name}</strong>
          </span>
          {projectOverride || overview ? (
            <span className="project-select project-select-static">{projectOverride || snapshot.project.name || "Workspace"}</span>
          ) : (
            <select
              className="project-select"
              aria-label="Project"
              value={snapshot.selectedProjectId || snapshot.project.id}
              disabled={navigationLocked}
              onChange={(event) => { if (!navigationLocked) onSelectProject(event.target.value); }}
            >
              {(snapshot.projects.length > 0 ? snapshot.projects : [snapshot.project]).map((project) => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
            </select>
          )}
        </label>
      </div>

      <div className="sidebar-section-title">
        <span>Goals</span>
        <span className="count-badge" aria-label={goalListUnreadable ? `The goal list could not be read. This is not the workbench connection.${newGoalEnabled ? " New goal can still start." : ""}` : campaignListUnavailable ? "Goal list unavailable" : undefined}>
          {goalListUnreadable || campaignListUnavailable ? "–" : goalCount + (runningJob ? 1 : 0)}
        </span>
      </div>
      {!collapsed && navigationLockedReason ? <p className="nav-empty" role="status">{navigationLockedReason}</p> : null}

      <div className="campaign-list">
        {savedTargets.map(item => (
          <button key={item.requestId} type="button" className={`campaign-item coordinated-target-item${item.active ? " campaign-active" : ""}`}
            title={`${item.title} — ${item.workspacePath}`} aria-label={`${item.title}, ${item.workspacePath}`}
            onClick={() => onSelectSavedTarget?.(item.requestId)}>
            <span className="campaign-state" aria-hidden="true" />
            <span className="campaign-item-copy"><strong title={item.title}>{shortGoalTitle(item.title)}</strong><small title={item.workspacePath}>{item.workspacePath.split(/[\\/]/).filter(Boolean).at(-1) || item.workspacePath}</small><small title={item.reason || item.statusLabel || "Saved result"}>{item.reason || item.statusLabel || "Saved result"}</small></span>
            {item.active ? <span className="active-arrow" aria-hidden="true">›</span> : null}
          </button>
        ))}
        {runningJob ? (
          <button
            className={`campaign-item${runningJob.viewing ? " campaign-active" : ""}`}
            type="button"
            disabled={runningJob.locked}
            title={`${runningJob.goal} — ${runningJobDetail(runningJob.stateLabel)}${runningJob.workspace ? ` — ${runningJob.workspace}` : ""}${runningJob.returnHint ? `. ${runningJob.returnHint}` : ""}`}
            aria-label={`${runningJob.goal}, ${runningJobDetail(runningJob.stateLabel)}${runningJob.workspace ? `, ${runningJob.workspace}` : ""}${runningJob.returnHint ? `. ${runningJob.returnHint}` : ""}`}
            onClick={() => { if (!runningJob.locked) onOpenRunningJob?.(); }}
          >
            <span className="campaign-state campaign-state-active" aria-hidden="true" />
            <span className="campaign-item-copy">
              <strong>{runningJob.goal}</strong>
              <small>{runningJob.returnHint ?? runningJobDetail(runningJob.stateLabel)}</small>
            </span>
            {runningJob.viewing ? <span className="active-arrow" aria-hidden="true">›</span> : null}
          </button>
        ) : null}
        {goalListUnreadable ? (collapsed ? null : <p className="nav-empty" role="status">{`The goal list could not be read. This is not the workbench connection.${newGoalEnabled ? " New goal can still start." : ""}`}</p>) : null}
        {campaignListUnavailable && !projectOverride ? (
          collapsed ? null : <p className="nav-empty" role="status">Goal list unavailable until GoalPort reconnects.</p>
        ) : goalCount === 0 && !runningJob && !goalListUnreadable ? (
          collapsed ? null : <p className="nav-empty">No goals yet.</p>
        ) : overview ? (
          overview.goals.map((goal) => {
            const active = !backgroundOwnsView && goal.campaignId === snapshot.activeCampaignId;
            const renaming = renamingId === goal.campaignId;
            return (
              <div key={goal.campaignId} className={`campaign-item-wrap${active ? " campaign-active" : ""}`}>
                {renaming ? (
                  <input
                    ref={renameInputRef}
                    className="campaign-rename-input"
                    aria-label="Rename goal"
                    value={renameDraft}
                    onChange={(event) => setRenameDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        commitRename();
                      } else if (event.key === "Escape") {
                        event.preventDefault();
                        setRenamingId(null);
                      }
                    }}
                    onBlur={commitRename}
                  />
                ) : (
                  <button
                    className={`campaign-item${active ? " campaign-active" : ""}`}
                    type="button"
                    title={failedOpenId === goal.campaignId ? `${goal.title} — Could not open. Not the workbench. — ${goal.workspaceRoot}` : goal.workspaceRoot}
                    aria-label={collapsed ? goal.title : undefined}
                    disabled={navigationLocked}
                    onClick={() => { if (!navigationLocked) onSelectCampaign(goal.campaignId); }}
                  >
                    <span className={`campaign-state ${attentionClass(goal)}`} aria-hidden="true" />
                    <span className="campaign-item-copy">
                      <strong>{goal.title}</strong>
                      {failedOpenId === goal.campaignId ? <small>Could not open. Not the workbench.</small> : attentionText(goal) ? <small>{attentionText(goal)}</small> : finished.has(goal.campaignId) ? <small>Done</small> : null}
                    </span>
                    {active ? <span className="active-arrow" aria-hidden="true">›</span> : null}
                  </button>
                )}
                {active && !renaming && !collapsed ? (
                  <button
                    className="campaign-rename-button"
                    type="button"
                    aria-label="Rename goal"
                    title="Rename this goal"
                    disabled={navigationLocked}
                    onClick={() => {
                      if (navigationLocked) return;
                      setRenamingId(goal.campaignId);
                      setRenameDraft(goal.title);
                    }}
                  >
                    <span aria-hidden="true">✎</span>
                  </button>
                ) : null}
              </div>
            );
          })
        ) : (
          snapshot.campaigns.map((campaign) => {
            const active = !backgroundOwnsView && campaign.id === snapshot.activeCampaignId;
            const renaming = renamingId === campaign.id;
            return (
              <div key={campaign.id} className={`campaign-item-wrap${active ? " campaign-active" : ""}`}>
                {renaming ? (
                  <input
                    ref={renameInputRef}
                    className="campaign-rename-input"
                    aria-label="Rename goal"
                    value={renameDraft}
                    onChange={(event) => setRenameDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        commitRename();
                      } else if (event.key === "Escape") {
                        event.preventDefault();
                        setRenamingId(null);
                      }
                    }}
                    onBlur={commitRename}
                  />
                ) : (
                  <button
                    className={`campaign-item${active ? " campaign-active" : ""}`}
                    type="button"
                    title={failedOpenId === campaign.id ? `${titleFor(campaign.id, campaign.title)} — Could not open. Not the workbench.` : collapsed ? titleFor(campaign.id, campaign.title) : undefined}
                    aria-label={collapsed ? titleFor(campaign.id, campaign.title) : undefined}
                    disabled={navigationLocked}
                    onClick={() => { if (!navigationLocked) onSelectCampaign(campaign.id); }}
                  >
                    <span className={`campaign-state campaign-state-${campaign.state}`} aria-hidden="true" />
                    <span className="campaign-item-copy">
                      <strong>{titleFor(campaign.id, campaign.title)}</strong>
                      {failedOpenId === campaign.id ? <small>Could not open. Not the workbench.</small> : null}
                    </span>
                    {active ? <span className="active-arrow" aria-hidden="true">›</span> : null}
                  </button>
                )}
                {active && !renaming && !collapsed ? (
                  <button
                    className="campaign-rename-button"
                    type="button"
                    aria-label="Rename goal"
                    title="Rename this goal"
                    disabled={navigationLocked}
                    onClick={() => {
                      if (navigationLocked) return;
                      setRenamingId(campaign.id);
                      setRenameDraft(titleFor(campaign.id, campaign.title));
                    }}
                  >
                    <span aria-hidden="true">✎</span>
                  </button>
                ) : null}
              </div>
            );
          })
        )}
      </div>

      {!collapsed && plansUnreadable && plansSentenceVisible ? <p className="nav-empty" role="status">Saved plans could not be read. Send will try again. Continue stays hidden until that read succeeds.</p> : null}
      {!collapsed && navigationLockedReason && plans.length > 0 ? <p className="nav-empty" role="status">{navigationLockedReason}</p> : null}
      {plans.length > 0 ? (
        <>
          <div className="sidebar-section-title">
            <span>Plans</span>
            <span className="count-badge" aria-label={plansUnreadable ? "Saved plans could not be read. Send will try again. Continue stays hidden until that read succeeds." : undefined}>{plansUnreadable ? "–" : plans.length}</span>
          </div>
          <div className="campaign-list">
            {plans.map((plan) => (
              <div key={plan.requestId} className={`campaign-item-wrap${plan.active ? " campaign-active" : ""}`}>
                <button
                  className={`campaign-item${plan.active ? " campaign-active" : ""}`}
                  type="button"
                  disabled={navigationLocked || plansUnreadable}
                  onClick={() => { if (!navigationLocked && !plansUnreadable) onSelectPlan?.(plan.requestId); }}
                  title={plansUnreadable ? "Saved plans could not be read. Send will try again. Continue stays hidden until that read succeeds." : planSubline(plan.verdict, plan.savedAt)}
                  aria-label={plansUnreadable ? `Plan: ${plan.title}. Saved plans could not be read. Send will try again. Continue stays hidden until that read succeeds.` : `Plan: ${plan.title}, ${planSubline(plan.verdict, plan.savedAt)}`}
                >
                  <span className={`campaign-state ${planStateClass(plan.verdict)}`} aria-hidden="true" />
                  <span className="campaign-item-copy">
                    <strong>{plan.title}</strong>
                    <small>{planSubline(plan.verdict, plan.savedAt)}</small>
                  </span>
                  {plan.active ? <span className="active-arrow" aria-hidden="true">›</span> : null}
                </button>
              </div>
            ))}
          </div>
        </>
      ) : null}

      <div className="nav-spacer" />
    </nav>
  );
}

function planSubline(verdict: CoordinationVerdict | null, savedAt?: string | null): string {
  const label = outcomeLabel(verdict);
  if (!savedAt) return label;
  const parsed = Date.parse(savedAt);
  if (Number.isNaN(parsed)) return label;
  const saved = new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" }).format(parsed);
  return `${label} · ${saved}`;
}

function planStateClass(verdict: CoordinationVerdict | null): string {
  switch (verdict) {
    case "verified":
    case "checked":
      return "campaign-state-complete";
    case "failed":
      return "campaign-state-failed";
    case "revise":
    case "stopped":
    case "unconfirmed":
    case null:
      return "campaign-state-paused";
    default: {
      const unreachable: never = verdict;
      return unreachable;
    }
  }
}

const LAST_ATTENTION_KEY = "goalport.lastAttention";
function readLastAttention(): [string, GoalCard["attention"]][] {
  try {
    const value = JSON.parse(localStorage.getItem(LAST_ATTENTION_KEY) ?? "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}
function rememberLastAttention(attention: Map<string, GoalCard["attention"]>): void {
  try {
    localStorage.setItem(LAST_ATTENTION_KEY, JSON.stringify([...attention]));
  } catch {
    // Done simply will not survive a restart.
  }
}

function attentionClass(goal: GoalCard): string {
  switch (goal.attention) {
    case "awaiting_approval":
    case "needs_recovery":
      return "campaign-state-paused";
    case "failed":
      return "campaign-state-failed";
    case "complete":
      return "campaign-state-complete";
    case "running":
    case "idle":
      return "campaign-state-active";
    default: {
      const unreachable: never = goal.attention;
      return unreachable;
    }
  }
}

function attentionText(goal: GoalCard): string {
  switch (goal.attention) {
    case "running": return "Working";
    case "awaiting_approval": return "Needs your OK";
    case "failed": return "Stopped with a problem";
    case "needs_recovery": return "Send a message to continue";
    default: return "";
  }
}
