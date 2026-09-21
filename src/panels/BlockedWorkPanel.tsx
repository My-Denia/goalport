import type { StopResponsibilitySummary } from "../types";
import { formatTimestamp } from "../lib/display";

interface BlockedWorkPanelProps {
  hold: StopResponsibilitySummary;
  onRecheck: (attemptId: string) => void;
  onContinue: (attemptId: string) => void;
  busy: boolean;
}

// The panel a user meets after Stop. Rendered inline in the conversation
// column (main area) whenever a hold governs the workspace or is related to
// it, so the block is continuously visible — no side panel owns it.
// The region accessible name "Stop responsibility" is part of the safety
// contract: the packaged-GUI driver locates this panel by that name.
//
// product-interaction-reset: the visible panel keeps the truthful residual
// safety facts and the two actions; internal identifiers, epochs and lease
// bookkeeping moved into the collapsed "Technical details" disclosure.
export function BlockedWorkPanel({ hold, onRecheck, onContinue, busy }: BlockedWorkPanelProps) {
  const governs = hold.blocksCurrentWorkspace !== false;
  const recheck = hold.latestRecheck ?? null;
  const observedAt = formatTimestamp(recheck?.observedAt) || "time unrecorded";
  const technical = [
    `Source: ${hold.source}`,
    `Reason: ${hold.blockedReason ?? "Conflicting work remains blocked."}`,
    `Native turn: ${hold.nativeTurnState}`,
    `Residual execution: ${hold.residualExecutionState}`,
    `Write responsibility: ${hold.writeResponsibility}`,
    recheck ? `Last re-check: ${recheck.verdict}` : null,
    `Attempt: ${hold.attemptId}`,
    `Operation: ${hold.operationId}`,
    `Input: ${hold.inputUuid}`,
    `Session hash: ${hold.sessionHash}`,
    `Turn epoch: ${hold.turnEpoch}`,
    `Process epoch: ${hold.processEpoch}`,
    recheck ? `Re-check id: ${recheck.id} · seq ${recheck.seq}` : null,
    recheck ? `Overlapping leases: ${recheck.activeLeaseCount} · pending outbox intents: ${recheck.pendingOutboxCount}` : null,
    recheck ? `Attempt state at re-check: ${recheck.attemptState}` : null,
    hold.interruptedAt ? `Interrupted at: ${formatTimestamp(hold.interruptedAt) || hold.interruptedAt}` : null
  ].filter((line): line is string => line !== null).join("\n");

  return (
    <section
      className={`stop-responsibility-panel${governs ? "" : " related-hold-panel"}`}
      role="region"
      aria-label={governs ? "Stop responsibility" : "Related hold"}
      data-attempt-id={hold.attemptId}
      data-governs={governs ? "true" : "false"}
    >
      <div className="rail-panel-heading compact-heading">
        <div className="rail-title-lockup">
          <span className="rail-icon rail-icon-amber" aria-hidden="true">■</span>
          <div>
            <p className="eyebrow">SAFETY HOLD</p>
            <h2>{governs ? "Blocked work" : "Related hold"}</h2>
          </div>
        </div>
      </div>

      {/* Which work, and where. */}
      <dl className="blocked-work-facts">
        <div><dt>Task</dt><dd className="blocked-task">{hold.taskTitle || "(untitled)"}</dd></div>
        <div><dt>Goal</dt><dd>{hold.campaignGoal || "(none recorded)"}</dd></div>
        <div><dt>Workspace</dt><dd className="blocked-workspace">{hold.workspaceKey || "(unrecorded)"}</dd></div>
        <div><dt>Interruption</dt><dd>{hold.interruptedAt ? formatTimestamp(hold.interruptedAt) || hold.interruptedAt : "time unrecorded"}</dd></div>
      </dl>

      <p className="blocked-reason">{governs
        ? "GoalPort cannot confirm that all background activity has stopped. New work in this workspace stays blocked."
        : "Background activity in the original workspace is still uncertain. Its hold remains in place."}</p>
      <p>Your Runtime selection is kept. Re-check the status, or continue in a separate workspace.</p>

      <div className="recheck-state">
        {recheck ? (
          <>
            <strong className="recheck-verdict">Last check: {recheck.runtimeObservation === "live" ? "Runtime still running" : "Background activity remains unconfirmed"}</strong>
            <small>observed at {observedAt} · bound runtime {recheck.runtimeObservation}</small>
            {recheck.verdict === "observation-unavailable" ? (
              <small className="recheck-unavailable">
                Nothing could be concluded. This is not evidence that anything stopped.
              </small>
            ) : null}
            {recheck.verdict === "bound-runtime-absent-residual-still-unknown" ? (
              <small className="recheck-unavailable">
                The bound runtime is gone. Its descendants were not observed, so residual execution stays unknown.
              </small>
            ) : null}
          </>
        ) : (
          <small>No re-check has been taken yet.</small>
        )}
      </div>

      <div className="blocked-work-actions">
        <button
          className="button"
          type="button"
          aria-label="Re-check this hold"
          disabled={busy}
          onClick={() => onRecheck(hold.attemptId)}
        >
          Re-check now
        </button>
        <button
          className="button button-accent"
          type="button"
          aria-label="Continue in a new isolated workspace"
          disabled={busy || !recheck}
          onClick={() => onContinue(hold.attemptId)}
        >
          Continue in a new isolated workspace
        </button>
      </div>
      {!recheck ? (
        <small className="blocked-work-hint">Re-check first: continuing requires a current observation.</small>
      ) : null}

      <details className="isolation-disclosure">
        <summary>What continuing elsewhere does and does not control</summary>
        <p className="disclosure-controlled">
          GoalPort will not admit a runtime, send, grant a permission Allow, hand off, resume,
          acquire or release a lease, or dispatch an outbox intent into any workspace that
          path-overlaps a held responsibility. A continuation gets a new native session, a new
          recorded identity, and a workspace key with no ancestor or descendant relationship to
          the held one.
        </p>
        <p className="disclosure-residual">
          GoalPort is not an OS sandbox. A residual process or descendant left over from the
          interrupted turn holds ordinary file-system rights and can write anywhere you can,
          including into the new workspace.
        </p>
        <p className="disclosure-not-evidence">
          Changing directory, database, session, provider or Core epoch is not evidence of
          isolation and does not release the original hold, which stays held.
        </p>
        <p className="disclosure-authorization">
          Continuing grants the new campaign three authorizations — provider, action and
          transfer — so it may send work, approve tool permissions, and hand off. The grant
          covers the new campaign only; this one is untouched.
        </p>
      </details>

      <details className="technical-details">
        <summary>Technical details</summary>
        <pre className="technical-details-pre">{technical}</pre>
      </details>
    </section>
  );
}
