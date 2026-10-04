import { Menu } from "@base-ui/react/menu";
import type { AppInfo } from "../ipc";
import { connectionLabel } from "../lib/display";
import type { CoreSnapshot } from "../types";
import { GoalLayer } from "../ui/GoalLayer";

interface TitleBarProps {
  browserPreview?: boolean;
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
  browserPreview = false, snapshot, campaignTitle, appInfo, navCollapsed, onToggleNav, detailsOpen, onToggleDetails, onOpenDiagnostics, onNewGoal, onOpenAbout, onReconnect, onCloseWindow
}: TitleBarProps) {
  const connected = snapshot.connection === "connected";

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
          <span className={`connection-pill connection-${browserPreview ? "preview" : snapshot.connection}`} title={browserPreview ? "Browser preview · no Core" : connectionLabel(snapshot)}>
            <span className="status-dot" aria-hidden="true" />
            <span className="connection-text">{browserPreview ? "Browser preview" : connectionLabel(snapshot)}</span>
          </span>
          {connected ? null : (
            <button className="tb-button" type="button" aria-label={browserPreview ? "Reconnect preview" : "Reconnect Core"} onClick={onReconnect}>
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
          <div className="app-menu">
            <GoalLayer
              variant="menu"
              label="Application menu"
              positionerClassName="app-menu-pop"
              trigger={(
                <button className="tb-button tb-icon" type="button" aria-label="Application menu" title="Application menu">
                  <span aria-hidden="true">⋯</span>
                </button>
              )}
            >
              <Menu.CheckboxItem
                className="app-menu-item"
                checked={detailsOpen}
                onCheckedChange={() => { onToggleDetails(); }}
                closeOnClick
              >
                {detailsOpen ? "✓ " : ""}Details (Ctrl+I)
              </Menu.CheckboxItem>
              <Menu.Item className="app-menu-item" onClick={() => { onOpenDiagnostics(); }}>
                Developer diagnostics
              </Menu.Item>
              <Menu.Item className="app-menu-item" onClick={() => { onOpenAbout(); }}>
                About GoalPort
              </Menu.Item>
              <Menu.Item className="app-menu-item" aria-label="Close window" onClick={() => { onCloseWindow(); }}>
                Close window
              </Menu.Item>
            </GoalLayer>
          </div>
        </div>
      </div>
    </header>
  );
}
