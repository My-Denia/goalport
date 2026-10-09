import { outcomeLabel, type CoordinationVerdict } from "../coordination/verdict";

// The user types a goal and sends, and should see the plan and the check separately, plus why it stopped, without picking a runtime or writing a handoff.

export type CoordinationQuotaWord = "unknown" | "available" | "exhausted";

export interface CoordinationStatusProps {
  goal?: string | null;
  planningHarness: string | null;
  reviewHarness: string | null;
  planText: string | null;
  reviewText: string | null;
  verdict: CoordinationVerdict | null;
  stopReason: string;
  planningQuota: CoordinationQuotaWord | null;
  reviewQuota: CoordinationQuotaWord | null;
  savedAt?: string | null;
  onRevise?: () => void;
}

function savedLabel(savedAt: string | null | undefined): string | null {
  if (!savedAt) return null;
  const parsed = Date.parse(savedAt);
  if (Number.isNaN(parsed)) return null;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(parsed);
}

function fact(value: string | null): string {
  const text = value?.trim() ?? "";
  return text.length > 0 ? text : "None";
}

export function CoordinationStatus({
  goal,
  planningHarness,
  reviewHarness,
  planText,
  reviewText,
  verdict,
  stopReason,
  planningQuota,
  reviewQuota,
  savedAt,
  onRevise,
}: CoordinationStatusProps) {
  const saved = savedLabel(savedAt);
  return (
    <section className="coordination-status" aria-label="Plan and check">
      <p>You sent a goal without picking a runtime. Below are the planning harness, the review harness, the plan, the check, and why this stopped.</p>
      {onRevise ? (
        <div className="coordination-revise">
          <p>This needs a revision. Revise keeps this plan and opens the goal so you can send an update. Nothing is sent until you press Send.</p>
          <button type="button" onClick={onRevise}>Revise</button>
        </div>
      ) : null}
      <dl>
        <dt>Goal</dt>
        <dd>{fact(goal ?? null)}</dd>
        {saved && savedAt ? (
          <>
            <dt>Saved</dt>
            <dd><time dateTime={savedAt}>{saved}</time></dd>
          </>
        ) : null}
        <dt>Planning harness</dt>
        <dd>{fact(planningHarness)}</dd>
        <dt>Planning quota</dt>
        <dd>{fact(planningQuota)}</dd>
        <dt>Review harness</dt>
        <dd>{fact(reviewHarness)}</dd>
        <dt>Review quota</dt>
        <dd>{fact(reviewQuota)}</dd>
        <dt>Plan</dt>
        <dd>{fact(planText)}</dd>
        <dt>Check</dt>
        <dd>{fact(reviewText)}</dd>
        <dt>Outcome</dt>
        <dd>{outcomeLabel(verdict)}</dd>
        <dt>Stop reason</dt>
        <dd>{fact(stopReason)}</dd>
      </dl>
    </section>
  );
}
