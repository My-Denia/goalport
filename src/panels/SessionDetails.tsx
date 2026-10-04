import type { CoreSnapshot, ProductConversation } from "../types";
import { connectionLabel, headlineState, runtimeSelectionDisplay } from "../lib/display";
import { GoalLayer } from "../ui/GoalLayer";

interface SessionDetailsProps {
  browserPreview?: boolean;
  open: boolean;
  onClose: () => void;
  snapshot: CoreSnapshot;
  product: ProductConversation | null;
  onChangeRuntime: () => void;
  onOpenHandoff: () => void;
  onCloseSession: () => void;
  onResumeSession: () => void;
  onOpenWorkspaceFolder: () => void;
  closingSession?: boolean;
}

/**
 * Session details: the everyday overlay. Plain facts only — workspace,
 * selected Runtime, connection, status, approval count — plus the three
 * actions that belong here (Change Runtime, Handoff, open workspace).
 * No capability catalog, no evidence ledger, no internal identifiers; those
 * live in the separate Developer diagnostics surface.
 */
export function SessionDetails({ browserPreview = false, open, onClose, snapshot, product, onChangeRuntime, onOpenHandoff, onCloseSession, onResumeSession, onOpenWorkspaceFolder, closingSession = false }: SessionDetailsProps) {
  const pendingCount = snapshot.decisions.filter((decision) => decision.state === "pending").length;
  const state = headlineState(product, snapshot, closingSession ? "closing-session" : undefined);
  const runtime = product?.runtime ?? { state: "none" as const, provider: "", name: "" };
  const runtimeDisplay = runtimeSelectionDisplay(runtime);
  const held = snapshot.stopResponsibility?.writeResponsibility === "held";
  const hasConversation = Boolean(snapshot.activeCampaignId);
  const sessionLabel = closingSession ? "Closing…"
    : product?.session?.state === "starting" ? "Starting"
    : product?.session?.state === "attached" ? "Connected"
    : product?.session?.state === "detached" ? "Detached"
    : product?.session?.state === "closed" ? "Closed"
    : product?.session?.state === "unavailable" ? "Unavailable"
    : product?.session?.state === "none" ? "Not started" : null;

  return (
    <GoalLayer
      variant="drawer"
      open={open}
      onOpenChange={(next) => { if (!next) onClose(); }}
      label="Session details"
      surface={<aside className={`inspector${open ? " inspector-open" : ""}`} role="complementary" data-open={open ? "true" : "false"} />}
    >
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
            <div><span>Connection</span><strong>{browserPreview ? "Browser preview · no Core" : connectionLabel(snapshot)}</strong></div>
            {sessionLabel ? <div><span>Runtime session</span><strong>{sessionLabel}</strong></div> : null}
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
            {snapshot.connection === "connected" && !held && product?.turn.actions?.includes("close-session") ? (
              <button className="button button-quiet" type="button" onClick={onCloseSession}>Close Runtime session</button>
            ) : null}
            {snapshot.connection === "connected" && !held && product?.turn.actions?.includes("resume-session") ? (
              <button className="button button-quiet" type="button" onClick={onResumeSession}>Resume session</button>
            ) : null}
            <button className="button button-quiet" type="button" onClick={onOpenWorkspaceFolder} disabled={!snapshot.project.workspaceRoot}>
              Open workspace folder
            </button>
          </div>
        </section>
        {product?.resultSummary ? (
          <section className="rail-panel" aria-labelledby="last-result-title">
            <h3 id="last-result-title">Last result</h3>
            <p className="result-excerpt">{product.resultSummary}</p>
          </section>
        ) : null}
      </div>
    </GoalLayer>
  );
}
