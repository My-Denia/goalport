import { useEffect } from "react";
import type { CoreSnapshot, ProductConversation } from "../types";
import { connectionLabel, headlineState, runtimeSelectionDisplay } from "../lib/display";

interface SessionDetailsProps {
  open: boolean;
  onClose: () => void;
  snapshot: CoreSnapshot;
  product: ProductConversation | null;
  onChangeRuntime: () => void;
  onOpenHandoff: () => void;
  onOpenWorkspaceFolder: () => void;
}

/**
 * Session details: the everyday overlay. Plain facts only — workspace,
 * selected Runtime, connection, status, approval count — plus the three
 * actions that belong here (Change Runtime, Handoff, open workspace).
 * No capability catalog, no evidence ledger, no internal identifiers; those
 * live in the separate Developer diagnostics surface.
 */
export function SessionDetails({ open, onClose, snapshot, product, onChangeRuntime, onOpenHandoff, onOpenWorkspaceFolder }: SessionDetailsProps) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const pendingCount = snapshot.decisions.filter((decision) => decision.state === "pending").length;
  const state = headlineState(product, snapshot);
  const runtime = product?.runtime ?? { state: "none" as const, provider: "", name: "" };
  const runtimeDisplay = runtimeSelectionDisplay(runtime);
  const held = snapshot.stopResponsibility?.writeResponsibility === "held";
  const hasConversation = Boolean(snapshot.activeCampaignId);

  return (
    <aside className={`inspector${open ? " inspector-open" : ""}`} aria-label="Session details" data-open={open ? "true" : "false"}>
      <div className="inspector-scroll">
        <div className="inspector-head">
          <h2>Session details</h2>
          <button className="icon-button subtle" type="button" aria-label="Close details panel" onClick={onClose}>×</button>
        </div>

        <section className="rail-panel" aria-labelledby="session-facts-title">
          <div className="rail-panel-heading compact-heading">
            <div className="rail-title-lockup">
              <span className="rail-icon rail-icon-blue" aria-hidden="true">◎</span>
              <div>
                <p className="eyebrow">THIS SESSION</p>
                <h2 id="session-facts-title">{state.label}</h2>
              </div>
            </div>
          </div>
          <div className="detail-facts">
            <div><span>Workspace</span><strong className="detail-workspace">{snapshot.project.workspaceRoot || snapshot.project.name || "—"}</strong></div>
            <div>
              <span>Runtime</span>
              <strong>
                {runtime.state === "none"
                  ? "None selected"
                  : `${runtimeDisplay.label}${runtime.state === "unavailable" ? " · not connected" : ""}`}
              </strong>
            </div>
            <div><span>Connection</span><strong>{connectionLabel(snapshot)}</strong></div>
            <div><span>Status</span><strong>{state.label}{held ? " — held by a Stop" : ""}</strong></div>
            <div>
              <span>Approvals</span>
              <strong>{pendingCount === 0 ? "None pending" : `${pendingCount} shown in the conversation`}</strong>
            </div>
          </div>
          <div className="diagnostics-actions session-details-actions">
            <button className="button button-quiet" type="button" onClick={onChangeRuntime} disabled={!hasConversation}>
              Change Runtime
            </button>
            <button className="button button-quiet" type="button" onClick={onOpenHandoff} disabled={held || !hasConversation}>
              Handoff…
            </button>
            <button className="button button-quiet" type="button" onClick={onOpenWorkspaceFolder} disabled={!snapshot.project.workspaceRoot}>
              Open workspace folder
            </button>
          </div>
        </section>


      </div>
    </aside>
  );
}
