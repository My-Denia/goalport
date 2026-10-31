import type { CoreSnapshot } from "../types";

interface PendingApprovalsProps {
  snapshot: CoreSnapshot;
  onPermissionDecision: (decisionId: string, allow: boolean, forSession?: boolean) => void;
}

/**
 * Blocking decisions rendered in the main conversation area. A pending
 * permission must be discoverable, readable and answerable at every supported
 * width — it never lives only inside a collapsed rail.
 *
 * Accessible names are part of the safety contract: "Allow once" and
 * "Decline permission" stay verbatim. Not answering simply keeps waiting.
 */
export function PendingApprovals({ snapshot, onPermissionDecision }: PendingApprovalsProps) {
  const pending = snapshot.decisions.filter((decision) => decision.state === "pending");
  const held = snapshot.stopResponsibility?.writeResponsibility === "held";
  if (pending.length === 0) return null;
  return (
    <section className="approvals" role="region" aria-label="Decision Inbox">
      {pending.map((decision) => {
        const agent = decision.title.replace(/ wants your approval$/i, "");
        const fromAgent = agent !== decision.title;
        const name = (fromAgent && snapshot.productConversation?.runtime.name) || agent.charAt(0).toUpperCase() + agent.slice(1);
        return (
          <div className="decision-request" key={decision.id} data-decision-id={decision.id}>
            <h2>{name} wants to do this</h2>
            {decision.actionKnown === false
              ? <p>{name} didn't say what it wants to do, so it can't be allowed. You can decline it.</p>
              : decision.facts.map((fact) => <pre className="decision-action" key={fact}>{fact}</pre>)}
            <div className="decision-actions">
              <button className="button button-accent" type="button" onClick={() => onPermissionDecision(decision.id, true)} disabled={held || decision.actionKnown === false}>Allow once</button>
              {decision.sessionAnswer && decision.actionKnown !== false ? <button className="button button-outline" type="button" onClick={() => onPermissionDecision(decision.id, true, true)} disabled={held}>Allow for this session</button> : null}
              <button className="button button-danger" type="button" aria-label="Decline permission" onClick={() => onPermissionDecision(decision.id, false)}>Decline</button>
            </div>
            {decision.sessionAnswer && decision.actionKnown !== false && !held ? <p className="decision-scope-note">This session allows the same request again without asking. Anything different still asks.</p> : null}
            {held ? <p className="decision-hold-note">Allow is off until the earlier stop is confirmed. You can still decline.</p> : null}
          </div>
        );
      })}
    </section>
  );
}
