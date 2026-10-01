import type { CoreSnapshot, GoalCard } from "../types";

interface BackgroundAttentionProps {
  snapshot: CoreSnapshot;
  onOpen: (campaignId: string) => void;
}

const LABEL: Record<GoalCard["attention"], string> = {
  running: "Running",
  awaiting_approval: "Waiting for your approval",
  failed: "Failed",
  needs_recovery: "Needs a session resume",
  idle: "",
  complete: ""
};

/**
 * The user is in one goal and needs to notice that another goal is waiting,
 * failed, or still running. Opening it is explicit; this list does not
 * change the goal they are typing in.
 */
export function BackgroundAttention({ snapshot, onOpen }: BackgroundAttentionProps) {
  const overview = snapshot.goalOverview;
  if (!overview) return null;
  const items = overview.goals.filter((goal) =>
    goal.campaignId !== snapshot.activeCampaignId
    && (goal.attention === "awaiting_approval"
      || goal.attention === "failed"
      || goal.attention === "needs_recovery"
      || goal.attention === "running")
  );
  if (items.length === 0) return null;
  return (
    <section className="background-attention" aria-label="Other goals">
      {items.map((goal) => (
        <div className={`background-attention-item attention-${goal.attention}`} key={goal.campaignId}>
          <div className="background-attention-copy">
            <strong>{goal.title}</strong>
            <span>{LABEL[goal.attention]}</span>
          </div>
          <button className="button button-small button-outline" type="button" onClick={() => onOpen(goal.campaignId)}>
            Open
          </button>
        </div>
      ))}
    </section>
  );
}
