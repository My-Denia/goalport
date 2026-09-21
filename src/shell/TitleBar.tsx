import { useEffect, useRef, useState } from "react";
import type { AppInfo } from "../ipc";
import { connectionLabel } from "../lib/display";
import type { CoreSnapshot } from "../types";

interface TitleBarProps {
  snapshot: CoreSnapshot;
  campaignTitle: string | null;
  appInfo: AppInfo | null;
  navCollapsed: boolean;
  onToggleNav: () => void;
  detailsOpen: boolean;
  onToggleDetails: () => void;
  onOpenDiagnostics: () => void;
  onNewGoal: () => void;
  onOpenAbout: () => void;
  onReconnect: () => void;
  onCloseWindow: () => void;
}

/**
 * Integrated application title bar.
 *
 * Window controls are the native Window Controls Overlay (Electron
 * titleBarOverlay on Windows); this bar owns the remaining surface. The bar
 * element is a drag region (`-webkit-app-region: drag`); every interactive
 * child — including nested spans, popovers and pills — is explicitly
 * `no-drag` so buttons keep working inside it. The bar width/offset follow
 * `env(titlebar-area-*)` so content never underlaps the native controls.
 * The bar stacks above every drawer so its menu popover is never trapped.
 */
export function TitleBar({
  snapshot, campaignTitle, appInfo, navCollapsed, onToggleNav, detailsOpen, onToggleDetails, onOpenDiagnostics, onNewGoal, onOpenAbout, onReconnect, onCloseWindow
}: TitleBarProps) {
  const connected = snapshot.connection === "connected";
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onDocClick = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  return (
    <header className="titlebar" role="banner">
      <div className="titlebar-inner">
        <div className="titlebar-left">
          <button
            className="tb-button tb-icon"
            type="button"
            aria-label={navCollapsed ? "Expand navigation" : "Collapse navigation"}
            aria-expanded={!navCollapsed}
            title={navCollapsed ? "Expand navigation" : "Collapse navigation"}
            onClick={onToggleNav}
          >
            <span aria-hidden="true">☰</span>
          </button>
          <div className="titlebar-identity">
            <span className="titlebar-app" title={appInfo ? `GoalPort ${appInfo.version}` : "GoalPort"}>GoalPort</span>
            <span className="titlebar-sep" aria-hidden="true">/</span>
            <span className="titlebar-workspace" title={snapshot.project.workspaceRoot || snapshot.project.name}>
              {snapshot.project.name || "No workspace"}
            </span>
            {campaignTitle ? (
              <>
                <span className="titlebar-sep" aria-hidden="true">/</span>
                <span className="titlebar-campaign">{campaignTitle}</span>
              </>
            ) : null}
          </div>
        </div>

        <div className="titlebar-right">
          <span className={`connection-pill connection-${snapshot.connection}`} title={connectionLabel(snapshot)}>
            <span className="status-dot" aria-hidden="true" />
            <span className="connection-text">{connectionLabel(snapshot)}</span>
          </span>
          {connected ? null : (
            <button className="tb-button" type="button" aria-label="Reconnect Core" onClick={onReconnect}>
              Reconnect
            </button>
          )}
          <button className="tb-button" type="button" aria-label="New goal" onClick={onNewGoal}>
            <span aria-hidden="true">＋</span> New goal
          </button>
          <button
            className="tb-button tb-icon"
            type="button"
            aria-label={detailsOpen ? "Close details panel" : "Open details panel"}
            aria-expanded={detailsOpen}
            title={detailsOpen ? "Close details panel" : "Open details panel"}
            onClick={onToggleDetails}
          >
            <span aria-hidden="true">ⓘ</span>
          </button>
          <div className="app-menu" ref={menuRef}>
            <button
              className="tb-button tb-icon"
              type="button"
              aria-label="Application menu"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              title="Application menu"
              onClick={() => setMenuOpen((value) => !value)}
            >
              <span aria-hidden="true">⋯</span>
            </button>
            {menuOpen ? (
              <div className="app-menu-pop" role="menu">
                <button
                  className="app-menu-item"
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={detailsOpen}
                  onClick={() => {
                    setMenuOpen(false);
                    onToggleDetails();
                  }}
                >
                  {detailsOpen ? "✓ " : ""}Details (Ctrl+I)
                </button>
                <button
                  className="app-menu-item"
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onOpenDiagnostics();
                  }}
                >
                  Developer diagnostics
                </button>
                <button
                  className="app-menu-item"
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onOpenAbout();
                  }}
                >
                  About GoalPort
                </button>
                <button
                  className="app-menu-item"
                  type="button"
                  role="menuitem"
                  aria-label="Close window"
                  onClick={() => {
                    setMenuOpen(false);
                    onCloseWindow();
                  }}
                >
                  Close window
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </header>
  );
}
