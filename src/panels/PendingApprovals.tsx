import type { CoreSnapshot } from "../types";

interface PendingApprovalsProps {
  snapshot: CoreSnapshot;
  onPermissionDecision: (decisionId: string, allow: boolean) => void;
  onKeepWaiting: () => void;
}

/**
 * Blocking decisions rendered in the main conversation area. A pending
 * permission must be discoverable, readable and answerable at every supported
 * width — it never lives only inside a collapsed rail.
 *
 * Accessible names are part of the safety contract: "Allow once",
 * "Decline permission", "Keep waiting" stay verbatim.
 */
export function PendingApprovals({ snapshot, onPermissionDecision, onKeepWaiting }: PendingApprovalsProps) {
  const pending = snapshot.decisions.filter((decision) => decision.state === "pending");
  const held = snapshot.stopResponsibility?.writeResponsibility === "held";
  if (pending.length === 0) return null;
  return (
    <section className="approvals" role="region" aria-label="Decision Inbox">
      <div className="approvals-head">
        <span className="approvals-badge" aria-hidden="true">◆</span>
        <h2>Awaiting your decision</h2>
        <span className="pending-count">{pending.length}</span>
      </div>
      {pending.map((decision) => (
        <div className="decision-request" key={decision.id} data-decision-id={decision.id}>
          <div className="decision-request-header">
            <span className="decision-type">{decision.kind}</span>
            <span className="decision-time">needs answer</span>
          </div>
          <h3>{decision.title}</h3>
          <ul className="fact-list">
            {decision.facts.map((fact) => <li key={fact}>{fact}</li>)}
          </ul>

          <p className="decision-default"><strong>If unanswered:</strong> {decision.defaultBehavior}</p>
          <div className="decision-actions">
            <button className="button button-accent" type="button" onClick={() => onPermissionDecision(decision.id, true)} disabled={held || decision.actionKnown === false}>Allow once</button>
            <button className="button button-danger" type="button" onClick={() => onPermissionDecision(decision.id, false)}>Decline permission</button>
            <button className="button button-quiet" type="button" onClick={onKeepWaiting}>Keep waiting</button>
          </div>
          {held ? (
            <p className="decision-hold-note">Allow is blocked while Core holds Stop responsibility. Decline remains available.</p>
          ) : null}
        </div>
      ))}
    </section>
  );
}
