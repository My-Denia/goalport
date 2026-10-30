import { useElapsed } from "../lib/useElapsed";
import type { BackgroundStatus } from "../coordination/backgroundStatus";
import { parseLiveRead } from "../coordination/liveRead";
import { outcomeLabel, type CoordinationVerdict } from "../coordination/verdict";
import type { EnvironmentBlockedInfo } from "../coordination/coordinateSession";
import type { CoordinationRoundFact, RoundEvent } from "../coordination/savedPlan";
import { WorkspaceEvidenceDetails } from "./WorkspaceEvidenceDetails";
import { renderMarkdownBody } from "../lib/markdown";
import type { ExecutionWorkspaceEvidence, AuditInputEvidenceCoverage } from "../coordination/coordinateGoal";

// The user types a goal and sends, and should see the plan and the check separately, plus why it stopped, without picking a runtime or writing a handoff.

export type CoordinationQuotaWord = "unknown" | "available" | "exhausted";

export interface CoordinationStatusProps {
  goal?: string | null;
  planningHarness: string | null;
  reviewHarness: string | null;
  planText: string | null;
  reviewText: string | null;
  executionText?: string | null;
  auditText?: string | null;
  executionHarness?: string | null;
  auditHarness?: string | null;
  executionEvidence?: ExecutionWorkspaceEvidence | null;
  auditInputEvidenceCoverage?: AuditInputEvidenceCoverage | null;
  auditInputEvidenceText?: string | null;
  verdict: CoordinationVerdict | null;
  /** Presentation only: a background Stop with a proven settled outcome. */
  stoppedOutcome?: boolean;
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
  /**
   * Retained first-pass facts when the one automatic repair ran in this Send.
   * Facts only: history never carries live controls or restores permissions.
   */
  feedbackHistory?: readonly CoordinationRoundFact[];
  /**
   * Retained facts of the original plan-rejected pass when the one automatic
   * plan revision ran in this Send. Same rule: facts only, never permission.
   */
  planRevisionHistory?: readonly CoordinationRoundFact[];
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
  writeBudget?: { remaining: number | null; maxTurns: number } | null;
  onAllowMoreTurns?: () => void;
  /** Harness access management, reachable only on the current round. */
  onChangeAccess?: () => void;
  onStopAllowing?: () => void;
  /** Inside the returned goal: the goal is already the title, so skip the ledger. */
  plain?: boolean;
}

/** The one Stop-allowing caption: what stopping ends, and what it honestly does not claim. */
const STOP_ALLOWING_CAPTION =
  "Stopping ends the authorization for further turns. It does not undo any edit and does not prove a turn already in flight stopped.";

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
          {/* This kind also covers launch refusals, so it cannot establish harness fault. */}
          <span className="tl-kind">{failed ? "Step not completed" : "Took over"}</span>
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
  const step = blocked.role === "planning" ? "plan" : blocked.role === "review" ? "check" : blocked.role === "execution" ? "changes" : "verification";
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

/** One retained earlier pass, folded away with an explicit heading. */
function RetainedRoundSection({ round, heading }: { round: CoordinationRoundFact; heading: string }) {
  return (
    <details className="coordination-retained-round">
      <summary>{heading}</summary>
      <dl>
        <dt>Outcome</dt><dd>{outcomeLabel(round.verdict)}</dd>
        <dt>Planning harness</dt><dd>{fact(round.planningHarness)}</dd>
        <dt>Review harness</dt><dd>{fact(round.reviewHarness)}</dd>
        <dt>Plan</dt><dd>{fact(round.planText)}</dd>
        <dt>Check</dt><dd>{fact(round.reviewText)}</dd>
        {round.executionEvidence ? (
          <dd>
            <WorkspaceEvidenceDetails
              evidence={round.executionEvidence}
              executionText={round.executionText}
              executionHarness={round.executionHarness}
              auditInputEvidenceCoverage={round.auditInputEvidenceCoverage}
              auditInputEvidenceText={round.auditInputEvidenceText}
            />
          </dd>
        ) : (
          <>
            <dt>Changes{round.executionHarness ? ` — ${round.executionHarness}` : ""}</dt><dd>{fact(round.executionText)}</dd>
          </>
        )}
        <dt>Independent verification{round.auditHarness ? ` — ${round.auditHarness}` : ""}</dt><dd>{fact(round.auditText)}</dd>
        <dt>Stop reason</dt><dd>{fact(round.stopReason)}</dd>
      </dl>
      {round.commandIds.length > 0 ? (
        <details className="technical-details">
          <summary>Completed command IDs</summary>
          <pre className="technical-details-pre">{round.commandIds.join("\n")}</pre>
        </details>
      ) : null}
    </details>
  );
}

export function CoordinationStatus({
  goal,
  planningHarness,
  reviewHarness,
  planText,
  reviewText,
  executionText,
  auditText,
  executionHarness,
  auditHarness,
  executionEvidence,
  auditInputEvidenceCoverage,
  auditInputEvidenceText,
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
  feedbackHistory,
  planRevisionHistory,
  onUseAgain,
  roundSummary,
  budget,
  scopeExhausted,
  writeBudget,
  onAllowMoreTurns,
  onChangeAccess,
  onStopAllowing,
  plain = false,
  stoppedOutcome = false,
}: CoordinationStatusProps) {
  const saved = savedLabel(savedAt);
  // An assigned writer alone is not evidence it launched: the read-budget
  // feasibility stop assigns one before refusing all edits.
  const hasExecutionActivity = Boolean(executionText || auditHarness || auditText || executionEvidence)
    || roundEvents?.some((event) => event.role === "execution") === true;
  return (
    <section className="coordination-status" aria-label={verdict === "stopped" ? "Stopped. No further turn was sent." : "Plan and check"}>
      <dl className="coordination-outcome">
        <dt>Outcome</dt><dd>{stoppedOutcome ? "Stopped" : outcomeLabel(verdict)}</dd>
        <dt>Stop reason</dt><dd>{fact(stopReason)}</dd>
      </dl>
      {feedbackHistory && feedbackHistory.length > 0 ? (
        <p className="coordination-repair-note">
          The independent check found unfinished work, so GoalPort organized one checked repair
          with the remaining access you allowed. The result above is the repaired pass.
        </p>
      ) : null}
      {planRevisionHistory && planRevisionHistory.length > 0 ? (
        <p className="coordination-repair-note">
          The independent check rejected the plan, so GoalPort wrote one revised plan and had it
          checked again with the remaining access you allowed before any file changed. The result
          above is the revised pass.
        </p>
      ) : null}
      {verdict === "checked" && !executionHarness && !executionText && !executionEvidence ? <p>The plan passed its check. No harness is allowed to change files, so this stopped here.</p> : null}
      {hasExecutionActivity ? (
        <article className="coordination-result" aria-label="Workspace changes result">
          <h3>Changes{executionHarness ? ` — ${executionHarness}` : ""}</h3>
          <WorkspaceEvidenceDetails
            evidence={executionEvidence}
            executionText={executionText}
            executionHarness={executionHarness}
            auditInputEvidenceCoverage={auditInputEvidenceCoverage}
            auditInputEvidenceText={auditInputEvidenceText}
          />
          {(verdict === "failed" || (!auditText && verdict !== "verified")) && !stopReason.toLowerCase().includes("inspect")
            ? <p>Files may have changed. Inspect the workspace before sending a new goal; this write will not be retried automatically.</p> : null}
        </article>
      ) : null}
      {auditHarness || auditText ? (
        <article className="coordination-result" aria-label="Independent verification result">
          <h3>Independent verification{auditHarness ? ` — ${auditHarness}` : ""}</h3>
          <p>{fact(auditText ?? null)}</p>
        </article>
      ) : null}
      {feedbackHistory && feedbackHistory.length > 0
        ? feedbackHistory.map((round, index) => <RetainedRoundSection key={`repair-${round.verdict ?? "none"}-${index}`} round={round} heading="Before automatic repair" />)
        : null}
      {planRevisionHistory && planRevisionHistory.length > 0
        ? planRevisionHistory.map((round, index) => <RetainedRoundSection key={`plan-revision-${round.verdict ?? "none"}-${index}`} round={round} heading="Before plan revision" />)
        : null}
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
      {plain && planText?.trim() ? (
        <article className="coordination-result">
          <h3>Plan{planningHarness ? ` — ${planningHarness}` : ""}</h3>
          <p>{planText}</p>
        </article>
      ) : null}
      {plain && reviewText?.trim() ? (
        <article className="coordination-result">
          <h3>Check{reviewHarness ? ` — ${reviewHarness}` : ""}</h3>
          <p>{reviewText}</p>
        </article>
      ) : null}
      {plain ? null : (
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
      </dl>
      )}
      {scopeExhausted ? (
        <div className="coordination-budget" role="status">
          {/* The Stop reason above already says the sentence; this block only
              carries the action — copy says it once (AGENTS.md §4). */}
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
      {writeBudget ? <p className="coordination-budget">{writeBudget.remaining ?? "Unknown"} of {writeBudget.maxTurns} write turns left.</p> : null}
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
  /** True while the one in-window corrective pass is running. */
  readonly repair?: boolean;
  /** True while the one in-window plan revision is running. */
  readonly planRevision?: boolean;
  readonly remaining: number | null;
  readonly maxTurns: number | null;
  readonly writeRemaining?: number | null;
  readonly maxWriteTurns?: number | null;
  /** Ends the authorization for further turns; never a claim about edits. */
  readonly onStopAllowing?: () => void;
}

/**
 * While a scoped round is in flight this replaces the composer area: the
 * user sees which harness is working, which failed, who took over, and how
 * many authorized model turns are left.
 */
export function CoordinationProgress({ failures, activity, repair, planRevision, remaining, maxTurns, writeRemaining, maxWriteTurns, onStopAllowing }: CoordinationProgressProps) {
  return (
    <section className="coordination-status coordination-progress" aria-label="Round in progress" aria-live="polite">
      <p>Working on this goal.</p>
      {planRevision ? (
        <p className="coordination-progress-repair">
          The first check rejected the plan, so one revised plan is now being written and checked
          again with the remaining allowed turns. No file changes happen until the revised plan passes its check.
        </p>
      ) : null}
      {repair ? (
        <p className="coordination-progress-repair">
          The first check found unfinished work, so one checked repair is now running with the remaining allowed turns.
        </p>
      ) : null}
      {failures.map((sentence, index) => (
        <p key={index} className="coordination-progress-failure">{sentence}</p>
      ))}
      {activity ? <p className="coordination-progress-activity">{activity}</p> : null}
      {remaining !== null && maxTurns !== null ? (
        <p>{remaining} of {maxTurns} authorized model turns left.</p>
      ) : null}
      {maxWriteTurns != null ? <p>{writeRemaining ?? "Unknown"} of {maxWriteTurns} write turns left.</p> : null}
      {onStopAllowing ? (
        <div className="coordination-access">
          <button
            type="button"
            className="button button-small button-outline"
            aria-label="Stop allowing"
            onClick={onStopAllowing}
          >
            Stop allowing
          </button>
          <span className="coordination-access-caption">{STOP_ALLOWING_CAPTION}</span>
        </div>
      ) : null}
    </section>
  );
}

/** The user returns to the SAME live job, not a draft or saved permission. */
/** The answer first; the working behind it stays one click away. */
export function PiReview({ text, id }: { text: string; id: string }) {
  const body = text.trim();
  const split = body.search(/\n\s*\n/);
  const firstPart = split < 0 ? body : body.slice(0, split);
  const verdict = /^\**(Looks right|Needs attention|Can['’]t tell)\**:\**\s*/i.exec(firstPart);
  const opening = verdict ? firstPart.slice(verdict[0].length) : firstPart;
  const lead = opening.charAt(0).toUpperCase() + opening.slice(1);
  const rest = split < 0 ? '' : body.slice(split).trim();
  const tone = verdict ? (/^looks/i.test(verdict[1]) ? 'good' : /^needs/i.test(verdict[1]) ? 'attention' : 'unclear') : null;
  return <div className="tl-agent-body native-check-review">
    {tone ? <span className={`review-verdict review-verdict-${tone}`}>{verdict![1]}</span> : null}
    {renderMarkdownBody(lead, `pi-review-lead-${id}`)}
    {rest ? <details><summary>Full review</summary>{renderMarkdownBody(rest, `pi-review-${id}`)}</details> : null}
  </div>;
}

export function BackgroundCoordinationStatus({ job, onStopAllowing, onContinue, onLeave, onAskCodex }: { job: BackgroundStatus; onStopAllowing: () => void; onContinue?: () => void; onLeave?: () => void; onAskCodex?: (text: string) => void }) {
  const elapsed = useElapsed(job.recordKind === 'native-workspace-check' && Boolean(job.active && job.live && !job.revoked));
  const report = job.outcome?.report ?? job.progress?.firstRound;
  // Sentence ladder: unconfirmed > SETTLED TERMINAL > revoked-still-settling
  // > live/finished. A stopped job that has settled must say so — the user
  // pressing Stop wants to know it finished stopping, not that a turn "may"
  // still run (that copy is only true while a revocation is still in flight).
  const stoppedOutcome = job.state === "stopped" && job.outcome?.status === "stopped"
    && !job.live && !job.active && !job.pendingCommand;
  const settled = (job.state === "completed" || job.state === "failed" || stoppedOutcome)
    && !!job.outcome && !job.live && !job.active && !job.pendingCommand;
  const liveReady = job.live && parseLiveRead(job.liveRead)?.ready === true && job.liveRead?.initialRequestId === job.requestId && !job.pendingCommand && !job.revoked;
  const waitingAllowance = job.followUpMode === "live-read-once" && job.phase === "awaiting-followup";
  const interruptedRecovery = job.state === "unconfirmed" || Boolean(job.pendingCommand)
    || (job.followUpMode === "live-read-once" && job.active && !job.live && !job.outcome);
  const sentence = liveReady ? "Ready for one follow-up. No model is running; Continue uses the remaining open allowance."
    : waitingAllowance ? "The open allowance is not confirmed. The checked result is kept; nothing was restarted."
    : job.outcome?.allowanceEnd === "expired" && settled ? "The unused allowance expired. The checked result is kept."
    : job.outcome?.allowanceEnd === "idle-stopped" && stoppedOutcome ? "The unused allowance was stopped. The checked result is kept."
    : job.state === "unconfirmed"
    ? "Progress unavailable or interrupted; the outcome is unconfirmed. GoalPort did not restart this job and will not replay it."
    : stoppedOutcome
      ? "This goal was stopped and has settled. Whatever completed before the stop is retained below."
      : settled
        ? "This background job finished. Its result is retained below."
        : job.revoked ? "Access stopped. The current turn may finish; no further turn will start. This does not undo edits or confirm tools stopped."
        : job.live ? "This goal is running on its own. You can close GoalPort and return to this same job."
        : "This background job finished. Its result is retained below.";
  if (job.recordKind === 'native-workspace-check') {
    const running = job.active && job.live && !job.revoked;
    const review = report?.auditText;
    const unfinished = !review && !running && !job.revoked;
    return <section className="background-job native-check-panel" aria-label="Pi review" data-job-id={job.jobId}>
      <h3>{review ? "Pi's review" : running ? `Pi is reviewing Codex's changes · ${elapsed}` : job.revoked && !settled ? 'Stopping the review…' : "Pi's review didn't finish"}</h3>
      {running ? <p role="status">Keep working or close this window. The review will be here when it's done.</p> : null}
      {unfinished ? <p role="status">Your files weren't changed. You can ask for another review.</p> : null}
      {review ? <PiReview text={review} id={job.jobId} /> : null}
      {job.outcome?.error ? <details><summary>Technical details</summary><p>{job.outcome.error}</p></details> : null}
      {job.nativeCheckMaterial ? <details><summary>What Pi was sent · {savedLabel(job.nativeCheckMaterial.capturedAt)}</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:320,overflow:'auto'}}>{job.nativeCheckMaterial.exactPrompt}</pre></details> : null}
      <div className="native-check-actions">
        {running ? <button type="button" className="button button-small button-outline" onClick={onStopAllowing}>Stop review</button> : null}
        {review && onAskCodex && !/^\**looks right/i.test(review.trim()) ? <button type="button" className="button button-small button-outline" onClick={() => onAskCodex(`Pi flagged this in your changes: ${review.trim().split(/\n\s*\n/)[0]}\n\nCheck it and fix anything that needs it.`)}>Ask Codex to fix this</button> : null}
        {job.active && !job.live && !job.acknowledgedStuckAt && onLeave ? <button type="button" className="button button-small button-outline" onClick={onLeave}>Dismiss</button> : null}
      </div>
    </section>;
  }
  return <section className="background-job" aria-label="Background goal" data-job-id={job.jobId}>
    <h2>{job.goal}</h2><p role="status">{sentence}</p>
    {/* Stop allowing stays reachable while the admission is active and not
        revoked, even when control is unreachable: revocation itself persists.
        The progress block below stays honestly live-gated. */}
    {job.workspacePath ? <p className="background-job-place" title={job.workspacePath} aria-label={job.workspacePath}>{workspaceFolder(job.workspacePath)}</p> : null}
    {onContinue && !job.live ? <div className="coordination-access">
      <button type="button" className="button button-primary" onClick={onContinue}>
        {interruptedRecovery ? "Continue in a new send" : "New send for this goal"}
      </button>
      <span className="coordination-access-caption">
        {interruptedRecovery
          ? "The interrupted turn stays unconfirmed and is not replayed. Tools from it may still be running. Nothing is sent until you press Send."
          : "The finished job stays as it is. Nothing is sent until you press Send."}
      </span>
    </div> : null}
    {job.active && !job.revoked ? <div className="coordination-access">
      <button type="button" className="button button-outline" aria-label="Stop" onClick={onStopAllowing}>Stop</button>
      {job.state === "unconfirmed" ? <span className="coordination-access-caption">{STOP_ALLOWING_CAPTION}</span> : null}
    </div> : null}
    {job.active && job.live && !waitingAllowance && !liveReady && job.state !== "unconfirmed" ? <CoordinationProgress failures={job.progress?.failures ?? []} activity={job.progress?.activity ?? null}
      repair={job.progress?.repair === true} planRevision={job.progress?.planRevision === true} remaining={null} maxTurns={null}
      writeRemaining={null} maxWriteTurns={null} /> : null}
    {report ? <CoordinationStatus plain {...report} stoppedOutcome={stoppedOutcome && !(job.followUpMode === "live-read-once" && job.outcome?.allowanceEnd === "idle-stopped" && report.verdict === "checked")} goal={job.goal} feedbackHistory={report.feedbackHistory ?? []} planRevisionHistory={report.planRevisionHistory ?? []} /> : null}
    {!report && job.completedCommands.map(command => command.facts.text ? <article className="coordination-result" key={command.commandId}><h3>Completed {command.commandId.startsWith("coordinate-plan-") ? "plan" : command.commandId.startsWith("coordinate-review-") ? "check" : command.commandId.startsWith("coordinate-execute-") ? "changes" : "verification"}</h3><p>{command.facts.text}</p></article> : null)}
    {job.outcome?.error ? <p>{job.outcome.error}</p> : null}
    <details className="technical-details"><summary>Technical details</summary><p>Job: {job.jobId}; worker: {job.workerPid ?? "unconfirmed"}</p>
      {job.pendingCommand ? <p>Unconfirmed command: {job.pendingCommand.commandId}. No replay is allowed.</p> : null}</details>
  </section>;
}

function workspaceFolder(root: string): string {
  const trimmed = root.replace(/[\\/]+$/, "");
  if (trimmed === "~") return trimmed;
  const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const name = slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
  return trimmed.startsWith("~/") ? `~/${name}` : name;
}
