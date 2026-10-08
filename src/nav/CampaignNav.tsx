import { useEffect, useRef, useState } from "react";
import type { CoreSnapshot, GoalCard } from "../types";

interface CampaignNavProps {
  snapshot: CoreSnapshot;
  collapsed: boolean;
  plans?: readonly { requestId: string; title: string; active: boolean; verdict: "checked" | "revise" | "stopped" | "failed" | "unconfirmed" | null }[];
  onSelectPlan?: (requestId: string) => void;
  onSelectCampaign: (id: string) => void;
  onSelectProject: (id: string) => void;
  onRenameCampaign: (id: string, title: string) => void;
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
export function CampaignNav({ snapshot, collapsed, plans = [], onSelectPlan, onSelectCampaign, onSelectProject, onRenameCampaign }: CampaignNavProps) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const overview = snapshot.goalOverview;
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
        <label className="project-switcher" aria-label="Select project">
          <span className="project-avatar" aria-hidden="true">G</span>
          <span className="project-switcher-copy">
            <strong>{snapshot.project.name}</strong>
          </span>
          {overview ? (
            <span className="project-select project-select-static">{snapshot.project.name || "Workspace"}</span>
          ) : (
            <select
              className="project-select"
              aria-label="Project"
              value={snapshot.selectedProjectId || snapshot.project.id}
              onChange={(event) => onSelectProject(event.target.value)}
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
          {campaignListUnavailable ? "–" : goalCount}
        </span>
      </div>

      <div className="campaign-list">
        {campaignListUnavailable ? (
          <p className="nav-empty" role="status">Goal list unavailable until Core returns a full control snapshot.</p>
        ) : goalCount === 0 ? (
          <p className="nav-empty">No goals yet. Start one from the top bar.</p>
        ) : overview ? (
          overview.goals.map((goal) => {
            const active = goal.campaignId === snapshot.activeCampaignId;
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
                    title={goal.workspaceRoot}
                    onClick={() => onSelectCampaign(goal.campaignId)}
                  >
                    <span className={`campaign-state ${attentionClass(goal)}`} aria-hidden="true" />
                    <span className="campaign-item-copy">
                      <strong>{goal.title}</strong>
                      {attentionText(goal) ? <small>{attentionText(goal)}</small> : null}
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
                    onClick={() => {
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
            const active = campaign.id === snapshot.activeCampaignId;
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
                    title={collapsed ? titleFor(campaign.id, campaign.title) : undefined}
                    onClick={() => onSelectCampaign(campaign.id)}
                  >
                    <span className={`campaign-state campaign-state-${campaign.state}`} aria-hidden="true" />
                    <span className="campaign-item-copy">
                      <strong>{titleFor(campaign.id, campaign.title)}</strong>
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
                    onClick={() => {
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
                  onClick={() => onSelectPlan?.(plan.requestId)}
                >
                  <span className={`campaign-state ${planStateClass(plan.verdict)}`} aria-hidden="true" />
                  <span className="campaign-item-copy">
                    <strong>{plan.title}</strong>
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

function planStateClass(verdict: "checked" | "revise" | "stopped" | "failed" | "unconfirmed" | null): string {
  switch (verdict) {
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
