import { useState } from "react";
import { catalogFromProviderSnapshots, type ProviderSnapshot } from "../coordination/catalogFromProviders";
import type { SyntheticCatalogInstance } from "../coordination/coordinateGoal";

/**
 * The harness-access panel sits above the new-goal composer on a runtime-less
 * draft. The user chooses which harnesses may work on the goal and how many
 * model turns they may spend, before anything is sent. Vocabulary stays
 * user-facing: harnesses, model turns, blocked on this machine.
 */

export interface AuthorizationScopeLine {
  readonly remaining: number;
  readonly maxTurns: number;
}

export interface AuthorizationPanelProps {
  /** One discovery remembered from when this runtime-less draft opened. */
  readonly backgroundConsent?: boolean;
  readonly backgroundConfigured?: boolean;
  readonly onAllowBackgroundSend?: () => Promise<void>;
  readonly onBackgroundConsentChange?: (enabled: boolean) => void;
  readonly providers: readonly ProviderSnapshot[];
  readonly selected: readonly string[];
  readonly onToggle: (instanceId: string, selected: boolean) => void;
  readonly workspaceRoot: string;
  readonly writeSelected: readonly string[];
  readonly onWriteToggle: (instanceId: string, selected: boolean) => void;
  readonly writeTurns: number;
  readonly onWriteTurnsChange: (raw: string) => void;
  readonly writeScope: { remaining: number | null; maxTurns: number; workspaceRoot: string } | null;
  readonly maxTurns: number;
  readonly onMaxTurnsChange: (raw: string) => void;
  /** The active authorization, mirrored from the app. */
  readonly scope: AuthorizationScopeLine | null;
  /** Change mode edits an existing authorization before re-authorizing. */
  readonly changeMode: boolean;
  readonly onEnterChangeMode: () => void;
  readonly onStopAllowing: () => void;
  readonly onConfirmChange: () => void;
  readonly onUseAgain: (instanceId: string) => void;
}

function localizedSince(since: string): string {
  const parsed = Date.parse(since);
  if (Number.isNaN(parsed)) return since;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(parsed);
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function quotaExhausted(quota: SyntheticCatalogInstance["quota"]): boolean {
  if (typeof quota === "string") return quota.toLowerCase() === "exhausted";
  if (quota && typeof quota === "object" && typeof quota.state === "string") {
    return quota.state.toLowerCase() === "exhausted";
  }
  return false;
}

type RowState = "selectable" | "blocked" | "paid-api" | "unavailable";

function rowState(instance: SyntheticCatalogInstance): { state: RowState; reason: string | null } {
  if (instance.environmentAvoided) return { state: "blocked", reason: null };
  if (instance.billing === "paid-api") {
    return { state: "paid-api", reason: "bills through its own API key, so it cannot be selected." };
  }
  if (instance.billing === "unknown") {
    return { state: "unavailable", reason: "has no confirmed subscription sign-in, so it cannot be selected." };
  }
  if (instance.authenticated === false) return { state: "unavailable", reason: "is not signed in, so it cannot be selected." };
  if (instance.installed === false) return { state: "unavailable", reason: "is not installed on this machine." };
  if (instance.enabled === false || instance.launchable === false) {
    return { state: "unavailable", reason: "is not available right now." };
  }
  if (quotaExhausted(instance.quota)) return { state: "unavailable", reason: "has its subscription quota used up right now." };
  if (!instance.models || instance.models.length === 0) return { state: "unavailable", reason: "has no model available right now." };
  return { state: "selectable", reason: null };
}

export function AuthorizationPanel({
  providers,
  selected,
  onToggle,
  maxTurns,
  onMaxTurnsChange,
  workspaceRoot,
  writeSelected,
  onWriteToggle,
  writeTurns,
  onWriteTurnsChange,
  writeScope,
  scope,
  changeMode,
  onEnterChangeMode,
  onStopAllowing,
  onConfirmChange,
  onUseAgain,
  backgroundConsent = false,
  backgroundConfigured = true,
  onAllowBackgroundSend,
  onBackgroundConsentChange,
}: AuthorizationPanelProps) {
  const [grantBusy, setGrantBusy] = useState(false);
  const [grantError, setGrantError] = useState<string | null>(null);
  async function allowBackgroundSend() {
    if (!onAllowBackgroundSend || grantBusy) return;
    setGrantBusy(true);
    setGrantError(null);
    try {
      await onAllowBackgroundSend(); // Capability grant never selects another goal's checkbox.
    } catch { setGrantError("Harness turns could not be allowed. Try again; nothing was sent."); }
    finally { setGrantBusy(false); }
  }
  const catalog = catalogFromProviderSnapshots(providers);
  const editable = changeMode || scope === null;
  const selectedNames = catalog
    .filter((instance) => selected.includes(instance.instanceId))
    .map((instance) => instance.name);
  return (
    <section className="authorization-panel" aria-label="Harness access">
      <p className="authorization-panel-lead">
        {selectedNames.length > 0
          ? `GoalPort may use ${joinNames(selectedNames)} for plan and check turns. Nothing is sent until you press Send.`
          : "Choose the harnesses GoalPort may use for plan and check turns. Nothing is sent until you press Send."}
      </p>
      <p>
        If the independent check rejects the plan itself, GoalPort may write one revised plan and
        have it checked again inside the budgets you choose here, before any file changes.
      </p>
      <p>
        If independent verification then finds unfinished work, GoalPort may organize one further
        checked repair inside the budgets you choose here{backgroundConsent ? "." : " — keep this window open for it."}
      </p>
      {onBackgroundConsentChange ? <div className="authorization-background">
        <p>Only this goal and the access below may continue after you close GoalPort. This does not allow file changes. Choose that next to Send.</p>
        {!backgroundConfigured ? <>
          <p>Allow GoalPort to run harness turns for goals on this profile, in this window or after closing.</p>
          <button type="button" disabled={grantBusy || !onAllowBackgroundSend} onClick={() => { void allowBackgroundSend(); }}>Allow GoalPort to run harness turns on this profile</button>
          {grantError ? <p role="alert">{grantError}</p> : null}
        </> : null}
      </div> : null}
      <ul className="authorization-provider-list">
        {catalog.map((instance) => {
          const { state, reason } = rowState(instance);
          return (
            <li
              key={instance.instanceId}
              className={`authorization-row authorization-row-${state}`}
              data-instance={instance.instanceId}
            >
              {state === "selectable" ? (
                <label className="authorization-row-select">
                  <input
                    type="checkbox"
                    aria-label={`Select ${instance.name}`}
                    checked={selected.includes(instance.instanceId)}
                    disabled={!editable}
                    onChange={(event) => onToggle(instance.instanceId, event.target.checked)}
                  />
                  <span>{instance.name}</span>
                </label>
              ) : (
                <div className="authorization-row-static">
                  <span className="authorization-row-name">{instance.name}</span>
                  {state === "blocked" && instance.environmentAvoided ? (
                    <>
                      <span className="authorization-row-reason">
                        Blocked on this machine since {localizedSince(instance.environmentAvoided.since)} — its tools could not run.
                      </span>
                      <button
                        type="button"
                        className="button button-small button-outline"
                        aria-label={`Use again ${instance.name}`}
                        onClick={() => onUseAgain(instance.instanceId)}
                      >
                        Use again
                      </button>
                      <details className="technical-details">
                        <summary>Technical details</summary>
                        <pre className="technical-details-pre">{instance.environmentAvoided.detail}</pre>
                      </details>
                    </>
                  ) : (
                    <span className="authorization-row-reason">{instance.name} {reason}</span>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <div className="authorization-turns-row">
        <label className="field-label" htmlFor="authorization-turns">Model turns to allow</label>
        <input
          id="authorization-turns"
          type="number"
          min={2}
          max={32}
          aria-label="Model turns to allow"
          value={maxTurns}
          disabled={!editable}
          onChange={(event) => onMaxTurnsChange(event.target.value)}
        />
      </div>
      <div className="authorization-write-section" aria-label="Workspace changes">
        <h3>Workspace changes</h3>
        <p>File changes are a separate decision. GoalPort may edit files only in the workspace below, through the checked harnesses.</p>
        <p className="authorization-workspace">{workspaceRoot || "Choose a project folder before allowing file changes."}</p>
        <ul className="authorization-provider-list">
          {catalog.map((instance) => {
            const { state, reason } = rowState(instance);
            return (
              <li key={instance.instanceId} className={`authorization-row authorization-row-${state}`}>
                <label className="authorization-row-select">
                  <input type="checkbox" aria-label={`Allow changes through ${instance.name}`}
                    checked={writeSelected.includes(instance.instanceId)}
                    disabled={state !== "selectable" || !workspaceRoot || (writeScope !== null && !changeMode)}
                    onChange={(event) => onWriteToggle(instance.instanceId, event.target.checked)} />
                  <span>{instance.name}</span>
                </label>
                {state !== "selectable" ? <span className="authorization-row-reason">
                  {state === "blocked" ? "Blocked on this machine; use the access row above to try it again." : "Unavailable for file changes; see the access reason above."}
                </span> : null}
              </li>
            );
          })}
        </ul>
        <div className="authorization-turns-row">
          <label className="field-label" htmlFor="authorization-write-turns">Write turns to allow</label>
          <input id="authorization-write-turns" type="number" min={1} max={8}
            aria-label="Write turns to allow" value={Number.isNaN(writeTurns) ? "" : writeTurns}
            disabled={writeScope !== null && !changeMode}
            onChange={(event) => onWriteTurnsChange(event.target.value)} />
        </div>
        {!Number.isInteger(writeTurns) || writeTurns < 1 || writeTurns > 8
          ? <p role="alert">Choose 1 to 8 write turns before allowing workspace changes.</p> : null}
        {writeScope ? <p>{writeScope.remaining ?? "Unknown"} of {writeScope.maxTurns} write turns left.</p>
          : <p>No file changes are allowed unless you check a harness here and press Send.</p>}
      </div>
      {scope && !changeMode ? (
        <p className="authorization-scope-line">
          {scope.remaining} of {scope.maxTurns} authorized model turns left.{" "}
          <button
            type="button"
            className="button button-small button-outline"
            aria-label="Change"
            onClick={onEnterChangeMode}
          >
            Change
          </button>{" "}
          <button
            type="button"
            className="button button-small button-outline"
            aria-label="Stop allowing"
            onClick={onStopAllowing}
          >
            Stop allowing
          </button>
        </p>
      ) : null}
      {changeMode ? (
        <div className="dialog-actions">
          <button
            type="button"
            className="button button-primary"
            aria-label="Save harness access"
            onClick={onConfirmChange}
          >
            Save harness access
          </button>
        </div>
      ) : null}
    </section>
  );
}
