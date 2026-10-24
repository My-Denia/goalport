import { useEffect, useRef, useState } from "react";
import type { CoreSnapshot, GoalCard } from "../types";
import { outcomeLabel, type CoordinationVerdict } from "../coordination/verdict";

interface CampaignNavProps {
  snapshot: CoreSnapshot;
  collapsed: boolean;
  plans?: readonly { requestId: string; title: string; active: boolean; verdict: CoordinationVerdict | null; savedAt?: string | null }[];
  onSelectPlan?: (requestId: string) => void;
  onSelectCampaign: (id: string) => void;
  onSelectProject: (id: string) => void;
  onRenameCampaign: (id: string, title: string) => void;
  runningJob?: { goal: string; stateLabel: string; viewing: boolean; locked?: boolean; workspace?: string } | null;
  navigationLocked?: boolean;
  onOpenRunningJob?: () => void;
  projectOverride?: string;
  failedOpenId?: string;
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
export function CampaignNav({ snapshot, collapsed, plans = [], onSelectPlan, onSelectCampaign, onSelectProject, onRenameCampaign, runningJob = null, navigationLocked = false, onOpenRunningJob, projectOverride, failedOpenId }: CampaignNavProps) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const overview = snapshot.goalOverview;
  const backgroundOwnsView = runningJob?.viewing === true;
  const campaignListUnavailable = !overview && snapshot.bounds?.projectionUnavailable === true
    && snapshot.campaigns.length === 0;
  const goalCount = overview ? overview.goals.length : snapshot.campaigns.length;

  useEffect(() => {
    if (renamingId) renameInputRef.current?.focus();
  }, [renamingId]);

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
        <span className="count-badge" aria-label={campaignListUnavailable ? "Goal list unavailable" : undefined}>
          {campaignListUnavailable ? "–" : goalCount + (runningJob ? 1 : 0)}
        </span>
      </div>

      <div className="campaign-list">
        {runningJob ? (
          <button
            className={`campaign-item${runningJob.viewing ? " campaign-active" : ""}`}
            type="button"
            disabled={runningJob.locked}
            title={runningJob.workspace ? `${runningJob.goal} — ${runningJob.stateLabel} — ${runningJob.workspace}` : `${runningJob.goal} — ${runningJob.stateLabel}`}
            aria-label={runningJob.workspace ? `${runningJob.goal}, ${runningJob.stateLabel}, ${runningJob.workspace}` : undefined}
            onClick={() => { if (!runningJob.locked) onOpenRunningJob?.(); }}
          >
            <span className="campaign-state campaign-state-active" aria-hidden="true" />
            <span className="campaign-item-copy">
              <strong>{runningJob.goal}</strong>
              <small>{runningJob.stateLabel}</small>
            </span>
            {runningJob.viewing ? <span className="active-arrow" aria-hidden="true">›</span> : null}
          </button>
        ) : null}
        {campaignListUnavailable && !projectOverride ? (
          <p className="nav-empty" role="status">Goal list unavailable until Core returns a full control snapshot.</p>
        ) : goalCount === 0 && !runningJob ? (
          <p className="nav-empty">{projectOverride ? "No goals yet. Start one with New goal." : "No goals yet. Start one from the top bar."}</p>
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
                    title={failedOpenId === goal.campaignId ? `${goal.title} — Could not open — ${goal.workspaceRoot}` : goal.workspaceRoot}
                    disabled={navigationLocked}
                    onClick={() => { if (!navigationLocked) onSelectCampaign(goal.campaignId); }}
                  >
                    <span className={`campaign-state ${attentionClass(goal)}`} aria-hidden="true" />
                    <span className="campaign-item-copy">
                      <strong>{goal.title}</strong>
                      {failedOpenId === goal.campaignId ? <small>Could not open</small> : attentionText(goal) ? <small>{attentionText(goal)}</small> : null}
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
                    title={failedOpenId === campaign.id ? `${titleFor(campaign.id, campaign.title)} — Could not open` : collapsed ? titleFor(campaign.id, campaign.title) : undefined}
                    disabled={navigationLocked}
                    onClick={() => { if (!navigationLocked) onSelectCampaign(campaign.id); }}
                  >
                    <span className={`campaign-state campaign-state-${campaign.state}`} aria-hidden="true" />
                    <span className="campaign-item-copy">
                      <strong>{titleFor(campaign.id, campaign.title)}</strong>
                      {failedOpenId === campaign.id ? <small>Could not open</small> : null}
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

      {plans.length > 0 ? (
        <>
          <div className="sidebar-section-title">
            <span>Plans</span>
            <span className="count-badge">{plans.length}</span>
          </div>
          <div className="campaign-list">
            {plans.map((plan) => (
              <div key={plan.requestId} className={`campaign-item-wrap${plan.active ? " campaign-active" : ""}`}>
                <button
                  className={`campaign-item${plan.active ? " campaign-active" : ""}`}
                  type="button"
                  disabled={navigationLocked}
                  onClick={() => { if (!navigationLocked) onSelectPlan?.(plan.requestId); }}
                  title={planSubline(plan.verdict, plan.savedAt)}
                  aria-label={`Plan: ${plan.title}, ${planSubline(plan.verdict, plan.savedAt)}`}
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
    case "awaiting_approval":
      return "Needs approval";
    case "failed":
      return "Failed";
    case "needs_recovery":
      return "Needs resume";
    case "running":
      return "Running";
    case "idle":
    case "complete":
      return "";
    default: {
      const unreachable: never = goal.attention;
      return unreachable;
    }
  }
}
