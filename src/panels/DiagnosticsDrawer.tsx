import { useEffect, useState } from "react";
import type { AppInfo } from "../ipc";
import type { CoreCommandOutcome, CoreSnapshot, EvidenceSummary, TimelineItem } from "../types";
import { EVIDENCE_LABEL, formatTimestamp } from "../lib/display";

interface DiagnosticsDrawerProps {
  open: boolean;
  onClose: () => void;
  snapshot: CoreSnapshot;
  appInfo: AppInfo | null;
  onRevoke: (scope: string) => void;
  onOwnerAction: (action: string) => void;
  onOffline: () => void;
}

/** Copy-to-clipboard with a transient confirmation; never throws. */
function CopyButton({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="md-copy"
      type="button"
      aria-label={label}
      onClick={() => {
        void (async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          } catch {
            setCopied(false);
          }
        })();
      }}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function DiagnosticsRow({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <div className="diag-row">
      <span className="diag-label">{label}</span>
      <span className="diag-value">{value}</span>
      <CopyButton label={`Copy ${label}`} value={value} />
    </div>
  );
}

const BODY_TRUNCATE = 240;

function RawEventRow({ item, index }: { item: TimelineItem; index: number }) {
  const [expanded, setExpanded] = useState(false);
  const truncated = item.body.length > BODY_TRUNCATE && !expanded;
  const body = truncated ? `${item.body.slice(0, BODY_TRUNCATE)}…` : item.body;
  const json = JSON.stringify(
    {
      id: item.id,
      kind: item.kind,
      eventKind: item.eventKind,
      actor: item.actor,
      title: item.title,
      body: item.body,
      timestamp: item.timestamp,
      status: item.status,
      details: item.details
    },
    null,
    2
  );
  return (
    <li className="diag-event" data-event-id={item.id}>
      <div className="diag-event-head">
        <span className="diag-event-index">#{index + 1}</span>
        <span className="diag-event-kind">{item.eventKind || item.kind}</span>
        {item.status ? <span className="event-status">{item.status}</span> : null}
        <CopyButton label={`Copy event ${item.id}`} value={json} />
      </div>
      <div className="diag-event-meta">
        <span className="diag-value">{item.id}</span>
        <span>{item.actor}</span>
        <span>{formatTimestamp(item.timestamp) || item.timestamp}</span>
      </div>
      {item.title ? <div className="diag-event-title">{item.title}</div> : null}
      <div className="diag-event-body">
        {body}
        {item.body.length > BODY_TRUNCATE ? (
          <button className="diag-expand" type="button" onClick={() => setExpanded((value) => !value)}>
            {expanded ? "Show less" : "Show full text"}
          </button>
        ) : null}
      </div>
      {item.details && item.details.length > 0 ? (
        <ul className="diag-event-details">
          {item.details.map((detail) => <li key={detail} className="diag-value">{detail}</li>)}
        </ul>
      ) : null}
    </li>
  );
}

function CommandOutcomeBlock({ outcome }: { outcome: CoreCommandOutcome | undefined }) {
  if (!outcome) {
    return <p className="rail-caption">No command outcome in this projection.</p>;
  }
  const json = JSON.stringify(outcome, null, 2);
  return (
    <div className="diag-block">
      <div className="diag-row">
        <span className="diag-label">Kind</span>
        <span className="diag-value">{outcome.kind}</span>
      </div>
      <div className="diag-row">
        <span className="diag-label">Message type</span>
        <span className="diag-value">{outcome.messageType}</span>
      </div>
      {outcome.error ? (
        <div className="diag-row">
          <span className="diag-label">Error</span>
          <span className="diag-value">{outcome.error}</span>
        </div>
      ) : null}
      <div className="diag-row">
        <span className="diag-label">Request id</span>
        <span className="diag-value">{outcome.requestId}</span>
        <CopyButton label="Copy command outcome" value={json} />
      </div>
    </div>
  );
}

function EvidenceRow({ evidence }: { evidence: EvidenceSummary }) {
  return (
    <div className="diag-row" key={evidence.id}>
      <span className="diag-label">{EVIDENCE_LABEL[evidence.state] ?? evidence.state}</span>
      <span className="diag-value">{evidence.claim} · {evidence.source}</span>
      <CopyButton label={`Copy evidence ${evidence.id}`} value={evidence.id} />
    </div>
  );
}

/**
 * Developer diagnostics: the deliberately separate engineering surface. Raw
 * timeline events, attempt/session identity, command outcome, holds, evidence
 * and build/protocol/cursor — wrapped, truncatable, copyable. Fault injection
 * appears only in test mode or a development distribution, never merely
 * because a snapshot says "preview".
 */
export function DiagnosticsDrawer({ open, onClose, snapshot, appInfo, onRevoke, onOwnerAction, onOffline }: DiagnosticsDrawerProps) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  const canInjectFaults = appInfo?.testMode === true || appInfo?.distribution === "dev";
  const holdsJson = JSON.stringify(
    { stopResponsibility: snapshot.stopResponsibility, relatedHolds: snapshot.relatedHolds },
    null,
    2
  );
  const timelineJson = JSON.stringify(snapshot.timeline, null, 2);

  return (
    <aside className={`diagnostics-drawer diagnostics-open`} aria-label="Developer diagnostics" role="region">
      <div className="inspector-scroll">
        <div className="inspector-head">
          <h2>Developer diagnostics</h2>
          <button className="icon-button subtle" type="button" aria-label="Close developer diagnostics" onClick={onClose}>×</button>
        </div>
        <p className="rail-caption">Raw engineering detail. Long values wrap; use Copy for exact text. Nothing here is needed for everyday use.</p>

        <section className="rail-panel" aria-labelledby="diag-identity-title">
          <div className="rail-panel-heading compact-heading">
            <div className="rail-title-lockup">
              <span className="rail-icon rail-icon-slate" aria-hidden="true">⚙</span>
              <div>
                <p className="eyebrow">IDENTITY</p>
                <h2 id="diag-identity-title">Build · protocol · cursor</h2>
              </div>
            </div>
          </div>
          <DiagnosticsRow label="Build" value={snapshot.buildId} />
          <DiagnosticsRow label="Protocol" value={snapshot.protocolVersion} />
          <DiagnosticsRow label="Cursor" value={String(snapshot.cursor)} />
          <DiagnosticsRow label="Preview" value={snapshot.preview ? "true" : ""} />
        </section>

        <section className="rail-panel" aria-labelledby="diag-attempt-title">
          <div className="rail-panel-heading compact-heading">
            <div className="rail-title-lockup">
              <span className="rail-icon rail-icon-blue" aria-hidden="true">◌</span>
              <div>
                <p className="eyebrow">ATTEMPT · SESSION</p>
                <h2 id="diag-attempt-title">Current attempt</h2>
              </div>
            </div>
          </div>
          <DiagnosticsRow label="Attempt id" value={snapshot.attempt.id} />
          <DiagnosticsRow label="Task id" value={snapshot.attempt.taskId} />
          <DiagnosticsRow label="Provider" value={snapshot.attempt.provider} />
          <DiagnosticsRow label="State" value={snapshot.attempt.state} />
          <DiagnosticsRow label="Session" value={snapshot.attempt.sessionLabel} />
          <DiagnosticsRow label="Session hash" value={snapshot.attempt.sessionHash ?? ""} />
          <DiagnosticsRow label="Events" value={String(snapshot.attempt.eventCount)} />
        </section>

        <section className="rail-panel" aria-labelledby="diag-command-title">
          <div className="rail-panel-heading compact-heading">
            <div className="rail-title-lockup">
              <span className="rail-icon rail-icon-violet" aria-hidden="true">⌘</span>
              <div>
                <p className="eyebrow">COMMAND</p>
                <h2 id="diag-command-title">Last command outcome</h2>
              </div>
            </div>
          </div>
          <CommandOutcomeBlock outcome={snapshot.commandOutcome} />
        </section>

        <section className="rail-panel" aria-labelledby="diag-holds-title">
          <div className="rail-panel-heading compact-heading">
            <div className="rail-title-lockup">
              <span className="rail-icon rail-icon-amber" aria-hidden="true">■</span>
              <div>
                <p className="eyebrow">HOLDS</p>
                <h2 id="diag-holds-title">Stop responsibilities</h2>
              </div>
            </div>
          </div>
          {snapshot.stopResponsibility || snapshot.relatedHolds.length > 0 ? (
            <>
              <pre className="diag-pre">{holdsJson}</pre>
              <CopyButton label="Copy holds" value={holdsJson} />
            </>
          ) : (
            <p className="rail-caption">No stop responsibility held.</p>
          )}
        </section>

        <section className="rail-panel" aria-labelledby="diag-evidence-title">
          <div className="rail-panel-heading compact-heading">
            <div className="rail-title-lockup">
              <span className="rail-icon rail-icon-green" aria-hidden="true">✓</span>
              <div>
                <p className="eyebrow">EVIDENCE</p>
                <h2 id="diag-evidence-title">Evidence state</h2>
              </div>
            </div>
            <span className="evidence-count">{snapshot.evidence.length}</span>
          </div>
          {snapshot.evidence.length === 0
            ? <p className="rail-caption">No evidence records.</p>
            : snapshot.evidence.map((evidence) => <EvidenceRow key={evidence.id} evidence={evidence} />)}
        </section>

        <section className="rail-panel" aria-labelledby="diag-timeline-title">
          <div className="rail-panel-heading compact-heading">
            <div className="rail-title-lockup">
              <span className="rail-icon rail-icon-slate" aria-hidden="true">☰</span>
              <div>
                <p className="eyebrow">RAW TIMELINE</p>
                <h2 id="diag-timeline-title">Journal events ({snapshot.timeline.length})</h2>
              </div>
            </div>
            <CopyButton label="Copy all raw events" value={timelineJson} />
          </div>
          <p className="rail-caption">The raw event journal, exactly as Core projects it. The conversation view never renders these.</p>
          <ul className="diag-events">
            {snapshot.timeline.map((item, index) => <RawEventRow key={item.id} item={item} index={index} />)}
          </ul>
        </section>

        {canInjectFaults ? (
          <section className="rail-panel" aria-labelledby="diag-fault-title">
            <div className="rail-panel-heading compact-heading">
              <div className="rail-title-lockup">
                <span className="rail-icon rail-icon-red" aria-hidden="true">⚡</span>
                <div>
                  <p className="eyebrow">FAULT INJECTION</p>
                  <h2 id="diag-fault-title">Test-mode controls</h2>
                </div>
              </div>
            </div>
            <p className="rail-caption">Available because this is a test-mode or development build.</p>
            <div className="decision-actions">
              <button className="button button-quiet" type="button" onClick={() => onRevoke("action")}>Revoke action authorization</button>
              <button className="button button-quiet" type="button" onClick={() => onRevoke("provider")}>Revoke provider</button>
              <button className="button button-quiet" type="button" onClick={() => onRevoke("transfer")}>Revoke transfer</button>
            </div>
            <div className="decision-actions">
              <button className="button button-quiet" type="button" onClick={() => onOwnerAction("commit")}>Request commit</button>
              <button className="button button-quiet" type="button" onClick={() => onOwnerAction("push")}>Request push</button>
              <button className="button button-quiet" type="button" onClick={() => onOwnerAction("release")}>Request release</button>
              <button className="button button-quiet" type="button" onClick={() => onOwnerAction("delete")}>Request delete</button>
            </div>
            <p className="diagnostics-note">Owner-only actions are always refused in the UI; plan/audit flags never grant authority.</p>
            <div className="decision-actions">
              {snapshot.connection === "connected" ? (
                <button className="button button-outline" type="button" aria-label="Simulate offline" onClick={onOffline}>
                  Simulate offline (diagnostics)
                </button>
              ) : null}
            </div>
          </section>
        ) : null}
      </div>
    </aside>
  );
}
