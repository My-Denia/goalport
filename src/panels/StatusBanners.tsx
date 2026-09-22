import { HISTORY_WINDOW_ADVANCED_NOTICE, type CoreSnapshot } from "../types";

export interface ActiveNotice {
  /** One user-actionable sentence. No guessed cause. */
  sentence: string;
  /** Exact raw error text, shown only inside a collapsed disclosure. */
  technical?: string;
}

interface StatusBannersProps {
  snapshot: CoreSnapshot;
  activeNotice: ActiveNotice | null;
  onDismissNotice: () => void;
  onReconnect: () => void;
}

/**
 * Persistent, main-area visibility for states that change what the user may
 * safely do: a held workspace, a lost Core connection, or an active failure.
 * Success paths are deliberately quiet — no banner is raised for accepted
 * sends, renames, reconnects or handoffs.
 */
export function StatusBanners({ snapshot, activeNotice, onDismissNotice, onReconnect }: StatusBannersProps) {
  const hold = snapshot.stopResponsibility;
  const disconnected = snapshot.connection === "disconnected";
  const reconnecting = snapshot.connection === "reconnecting" || snapshot.connection === "degraded";
  const capacityLimited = snapshot.bounds?.projectionUnavailable === true;
  const historyWindowAdvanced = snapshot.notices.includes(HISTORY_WINDOW_ADVANCED_NOTICE);

  return (
    <div className="status-banners">
      {capacityLimited ? (
        <div className="banner banner-warn" role="status">
          <span className="banner-glyph" aria-hidden="true">⚠</span>
          <div>
            <strong>Conversation controls are temporarily unavailable</strong>
            <span>Core acknowledged the current state, but the full control projection exceeded capacity. Existing work is not an empty profile; reconnect before starting or approving new work.</span>
          </div>
          <button className="button button-small button-outline" type="button" aria-label="Reconnect Core" onClick={onReconnect}>
            Reconnect
          </button>
        </div>
      ) : null}
      {historyWindowAdvanced ? (
        <div className="banner banner-warn" role="status">
          <span className="banner-glyph" aria-hidden="true">↥</span>
          <div>
            <strong>Conversation history window advanced</strong>
            <span>Core has newer messages beyond the loaded range. The recent view was refreshed; use Load earlier to retrieve the missing history from the current boundary.</span>
          </div>
        </div>
      ) : null}
      {hold ? (
        <div className={`banner banner-held${hold.blocksCurrentWorkspace === false ? " banner-related" : ""}`} role="status">
          <span className="banner-glyph" aria-hidden="true">■</span>
          <div>
            <strong>{hold.blocksCurrentWorkspace === false ? "A related workspace is held" : "This workspace is held by a Stop"}</strong>
            <span>
              {hold.blocksCurrentWorkspace === false
                ? "Residual execution there is unknown; the source workspace stays blocked. Details in the panel below."
                : "Residual execution is unknown, so new work, permission approvals and handoffs in this workspace are blocked until a re-check or a continuation."}
            </span>
          </div>
        </div>
      ) : null}
      {disconnected ? (
        <div className="banner banner-error" role="alert">
          <span className="banner-glyph" aria-hidden="true">⚠</span>
          <div>
            <strong>Core is disconnected</strong>
            <span>Committed work is safe. Nothing is re-sent automatically; reconnect reads the Core projection.</span>
          </div>
          <button className="button button-small button-outline" type="button" aria-label="Reconnect Core" onClick={onReconnect}>
            Reconnect
          </button>
        </div>
      ) : reconnecting ? (
        <div className="banner banner-warn" role="status">
          <span className="banner-glyph" aria-hidden="true">↻</span>
          <div>
            <strong>Reconnecting to Core…</strong>
            <span>No prompt is replayed while reconnecting.</span>
          </div>
        </div>
      ) : null}
      {activeNotice ? (
        <div className="banner banner-notice" role="status">
          <div className="banner-notice-text">
            {activeNotice.sentence}
            {activeNotice.technical ? (
              <details className="technical-details">
                <summary>Technical details</summary>
                <pre className="technical-details-pre">{activeNotice.technical}</pre>
              </details>
            ) : null}
          </div>
          <button type="button" aria-label="Dismiss notification" onClick={onDismissNotice}>×</button>
        </div>
      ) : null}
    </div>
  );
}
