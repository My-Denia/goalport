import { outcomeLabel, type CoordinationVerdict } from "../coordination/verdict";
import type { EnvironmentBlockedInfo } from "../coordination/coordinateSession";

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
  environmentBlocked?: EnvironmentBlockedInfo | null;
  /**
   * How many other usable harnesses the app knows about, excluding the blocked
   * one. Null when no discovery is remembered in this window.
   */
  environmentAlternatives?: number | null;
  onSendAgainWithout?: () => void;
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

function EnvironmentBlockedCard({
  blocked,
  alternatives,
  onSendAgainWithout,
}: {
  blocked: EnvironmentBlockedInfo;
  alternatives: number | null;
  onSendAgainWithout?: () => void;
}) {
  const harness = blocked.harness ?? blocked.instanceId;
  const step = blocked.role === "planning" ? "plan" : "check";
  const enoughOthers = alternatives !== null && alternatives >= 2;
  return (
    <article className="tl-event tl-system card-accent-red" data-kind="environment-blocked">
      <div className="tl-avatar" aria-hidden="true">⚠</div>
      <div className="tl-event-body">
        <div className="tl-meta">
          <span className="tl-kind">This harness cannot run on this machine</span>
        </div>
        <div className="tl-system-body">
          {harness} cannot run its tools on this machine right now, so the {step} was not completed.
          This is a machine problem, not a plan problem—sending the same harness again will not help.
        </div>
        {alternatives !== null && !enoughOthers ? (
          <div className="tl-system-body">
            Only {alternatives} other usable {alternatives === 1 ? "harness is" : "harnesses are"} signed in,
            so an independent check cannot run until {harness} is fixed or another harness is signed in.
          </div>
        ) : null}
        {enoughOthers && onSendAgainWithout ? (
          <button
            className="button button-small button-outline"
            type="button"
            aria-label={`Send again without ${harness}`}
            onClick={onSendAgainWithout}
          >
            Send again without {harness}
          </button>
        ) : null}
        {blocked.detail ? (
          <details className="technical-details">
            <summary>Technical details</summary>
            <pre className="technical-details-pre">{blocked.detail}</pre>
          </details>
        ) : null}
      </div>
    </article>
  );
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
  environmentBlocked,
  environmentAlternatives,
  onSendAgainWithout,
}: CoordinationStatusProps) {
  const saved = savedLabel(savedAt);
  return (
    <section className="coordination-status" aria-label="Plan and check">
      <p>You sent a goal without picking a runtime. Below are the planning harness, the review harness, the plan, the check, and why this stopped.</p>
      {environmentBlocked ? (
        <EnvironmentBlockedCard blocked={environmentBlocked} alternatives={environmentAlternatives ?? null} onSendAgainWithout={onSendAgainWithout} />
      ) : null}
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
