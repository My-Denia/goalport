import { outcomeLabel, type CoordinationVerdict } from "../coordination/verdict";
import type { EnvironmentBlockedInfo } from "../coordination/coordinateSession";
import type { RoundEvent } from "../coordination/savedPlan";

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
  /** Completed recovery facts for this round: one card per failure or takeover. */
  roundEvents?: readonly RoundEvent[];
  /** Forgets that this machine could not run the blocked harness's tools. */
  onUseAgain?: () => void;
  /**
   * Top line when both roles finished on the harnesses that were authorized
   * and can run. Only ever passed for the current round, never for history.
   */
  roundSummary?: string | null;
  /** Authorized budget left on the CURRENT round; never set for history. */
  budget?: { readonly remaining: number; readonly maxTurns: number } | null;
  /** True when the current round ran out of authorized model turns. */
  scopeExhausted?: boolean;
  onAllowMoreTurns?: () => void;
  /** Harness access management, reachable only on the current round. */
  onChangeAccess?: () => void;
  onStopAllowing?: () => void;
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

function RoundEventCard({ event }: { event: RoundEvent }) {
  const failed = event.kind === "failed";
  return (
    <article
      className={`tl-event tl-system ${failed ? "card-accent-red" : "card-accent-blue"}`}
      data-kind={`round-${event.kind}`}
    >
      <div className="tl-avatar" aria-hidden="true">{failed ? "✕" : "⇄"}</div>
      <div className="tl-event-body">
        <div className="tl-meta">
          <span className="tl-kind">{failed ? "A harness failed" : "Took over"}</span>
        </div>
        <div className="tl-system-body">{event.sentence}</div>
        {event.detail ? (
          <details className="technical-details">
            <summary>Technical details</summary>
            <pre className="technical-details-pre">{event.detail}</pre>
          </details>
        ) : null}
      </div>
    </article>
  );
}

function EnvironmentBlockedCard({
  blocked,
  alternatives,
  onSendAgainWithout,
  onUseAgain,
}: {
  blocked: EnvironmentBlockedInfo;
  alternatives: number | null;
  onSendAgainWithout?: () => void;
  onUseAgain?: () => void;
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
        <div className="tl-system-body">It stays unused until you choose Use again.</div>
        {onUseAgain ? (
          <button
            className="button button-small button-outline"
            type="button"
            aria-label={`Use again ${harness}`}
            onClick={onUseAgain}
          >
            Use again
          </button>
        ) : null}
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
  roundEvents,
  onUseAgain,
  roundSummary,
  budget,
  scopeExhausted,
  onAllowMoreTurns,
  onChangeAccess,
  onStopAllowing,
}: CoordinationStatusProps) {
  const saved = savedLabel(savedAt);
  return (
    <section className="coordination-status" aria-label="Plan and check">
      <p>You sent a goal without picking a runtime. Below are the planning harness, the review harness, the plan, the check, and why this stopped.</p>
      {roundSummary ? <p className="coordination-summary">{roundSummary}</p> : null}
      {environmentBlocked ? (
        <EnvironmentBlockedCard
          blocked={environmentBlocked}
          alternatives={environmentAlternatives ?? null}
          onSendAgainWithout={onSendAgainWithout}
          onUseAgain={onUseAgain}
        />
      ) : null}
      {roundEvents && roundEvents.length > 0
        ? roundEvents.map((event, index) => <RoundEventCard key={`${event.kind}-${event.instanceId}-${index}`} event={event} />)
        : null}
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
      {scopeExhausted ? (
        <div className="coordination-budget" role="status">
          <p>All authorized model turns were used, so this stopped.</p>
          {onAllowMoreTurns ? (
            <button
              type="button"
              className="button button-small button-outline"
              aria-label="Allow more turns"
              onClick={onAllowMoreTurns}
            >
              Allow more turns
            </button>
          ) : null}
        </div>
      ) : budget ? (
        <p className="coordination-budget">{budget.remaining} of {budget.maxTurns} authorized model turns left.</p>
      ) : null}
      {onChangeAccess || onStopAllowing ? (
        <div className="coordination-access">
          <span className="coordination-access-label">Harness access</span>
          {onChangeAccess ? (
            <button
              type="button"
              className="button button-small button-outline"
              aria-label="Change"
              onClick={onChangeAccess}
            >
              Change
            </button>
          ) : null}
          {onStopAllowing ? (
            <button
              type="button"
              className="button button-small button-outline"
              aria-label="Stop allowing"
              onClick={onStopAllowing}
            >
              Stop allowing
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export interface CoordinationProgressProps {
  /** One-line failure sentences seen so far this round. */
  readonly failures: readonly string[];
  /** What is happening right now: "{Harness} is planning…" or a takeover line. */
  readonly activity: string | null;
  readonly remaining: number | null;
  readonly maxTurns: number | null;
}

/**
 * While a scoped round is in flight this replaces the composer area: the
 * user sees which harness is working, which failed, who took over, and how
 * many authorized model turns are left.
 */
export function CoordinationProgress({ failures, activity, remaining, maxTurns }: CoordinationProgressProps) {
  return (
    <section className="coordination-status coordination-progress" aria-label="Round in progress" aria-live="polite">
      <p>You sent a goal without picking a runtime. The harnesses you allowed are working on it now.</p>
      {failures.map((sentence, index) => (
        <p key={index} className="coordination-progress-failure">{sentence}</p>
      ))}
      {activity ? <p className="coordination-progress-activity">{activity}</p> : null}
      {remaining !== null && maxTurns !== null ? (
        <p>{remaining} of {maxTurns} authorized model turns left.</p>
      ) : null}
    </section>
  );
}
