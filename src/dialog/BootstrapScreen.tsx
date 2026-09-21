import { useEffect, useState } from "react";
import type { BootstrapActionType, BootstrapFacts, BootstrapState } from "../ipc";

// Startup-continuity screens shown inside the boot shell before any business
// data is trusted. The renderer displays facts pushed by the main process and
// forwards user actions; all decisions live in the main-process profile
// manager, never here.

function send(type: BootstrapActionType) {
  void window.goalportCore?.bootstrapAction?.({ type });
}

function countLabel(counts: Record<string, number> | null): string | null {
  if (!counts) return null;
  const goals = counts.campaigns ?? 0;
  const tasks = counts.tasks ?? 0;
  const attempts = counts.attempts ?? 0;
  const messages = counts.events ?? 0;
  const parts: string[] = [];
  if (goals) parts.push(`${goals} goal${goals === 1 ? "" : "s"}`);
  if (tasks) parts.push(`${tasks} task${tasks === 1 ? "" : "s"}`);
  if (attempts) parts.push(`${attempts} attempt${attempts === 1 ? "" : "s"}`);
  if (messages) parts.push(`${messages} recorded event${messages === 1 ? "" : "s"}`);
  return parts.length ? parts.join(", ") : "no recorded goals yet (startup history only)";
}

function createdByLabel(facts: BootstrapFacts): string {
  const version = facts.createdBy?.version;
  return version ? `GoalPort ${version}` : "an earlier GoalPort build";
}

function ActionButton({ kind, children, autoFocus }: { kind: BootstrapActionType; children: React.ReactNode; autoFocus?: boolean }) {
  return (
    <button type="button" className={kind === "import-accept" || kind === "retry" || kind === "fresh" ? "bootstrap-primary" : "bootstrap-secondary"}
      autoFocus={autoFocus} onClick={() => send(kind)}>
      {children}
    </button>
  );
}

function StatusLine({ state }: { state: BootstrapState }) {
  if (state.phase === "checking") return <p className="bootstrap-status">Checking your GoalPort data…</p>;
  if (state.phase === "backing-up") return <p className="bootstrap-status">Creating a safety backup before opening…</p>;
  if (state.phase === "importing" && "facts" in state) {
    const facts = state.facts as BootstrapFacts | undefined;
    return (
      <p className="bootstrap-status" role="status">
        Importing your existing GoalPort data{facts?.sourcePath ? ` from ${facts.sourcePath}` : ""}…
        <small>The original data stays untouched; GoalPort works on its own copy.</small>
      </p>
    );
  }
  return null;
}

export function BootstrapScreen({ state }: { state: BootstrapState }) {
  const [, forceRefresh] = useState(0);
  useEffect(() => { forceRefresh((value) => value + 1); }, [state]);

  const shell = (children: React.ReactNode) => (
    <div className="boot-shell bootstrap-screen" role="dialog" aria-label="GoalPort data profile">
      <span className="boot-mark" aria-hidden="true">◎</span>
      {children}
    </div>
  );

  if (state.phase === "import-offer") {
    const facts = state.facts;
    const summary = countLabel(facts.counts);
    return shell(
      <>
        <h2>Found existing GoalPort data</h2>
        <p>
          {createdByLabel(facts)} left data on this computer{facts.sourcePath ? <> at <code>{facts.sourcePath}</code></> : null}.
          {summary ? <> It contains {summary}.</> : null}
        </p>
        {facts.liveSource ? (
          <p className="bootstrap-note">The other GoalPort is still running. Import takes a point-in-time snapshot and does not disturb it.</p>
        ) : null}
        {facts.needsRecovery ? (
          <p className="bootstrap-note">The existing data&apos;s journal needs a one-time recovery read so it can be copied safely. The original files are not modified beyond that standard recovery.</p>
        ) : null}
        <div className="bootstrap-actions">
          <ActionButton kind="import-accept" autoFocus>Use my existing data</ActionButton>
          <ActionButton kind="fresh">Start fresh</ActionButton>
        </div>
        <small className="bootstrap-footnote">A verified copy is imported; the original stays where it is.</small>
      </>
    );
  }

  if (state.phase === "import-incompatible") {
    return shell(
      <>
        <h2>The existing GoalPort data cannot be used by this build</h2>
        <p>{state.reason}</p>
        {state.facts.sourcePath ? <p className="bootstrap-note">Kept untouched at <code>{state.facts.sourcePath}</code>.</p> : null}
        <div className="bootstrap-actions">
          <ActionButton kind="fresh" autoFocus>Start fresh</ActionButton>
          <ActionButton kind="open-folder">Show data folder</ActionButton>
          <ActionButton kind="exit">Exit</ActionButton>
        </div>
      </>
    );
  }

  if (state.phase === "coordination") {
    const live = state.kind === "live-core";
    const epoch = state.detail as { epochId?: string; corePid?: number } | null;
    return shell(
      <>
        <h2>{state.headline}</h2>
        <p>
          {live
            ? "Its Core process is still running (for example, background work you chose to continue). GoalPort will not close it, interrupt it, or take its place."
            : "GoalPort could not confirm whether a previous Core process has finished with this data. It will not guess: taking over could corrupt in-flight work."}
        </p>
        {epoch?.epochId ? <p className="bootstrap-note">Last known owner: Core epoch <code>{epoch.epochId}</code>{typeof epoch.corePid === "number" ? ` (pid ${epoch.corePid})` : ""}.</p> : null}
        <div className="bootstrap-actions">
          <ActionButton kind="retry" autoFocus>Try again</ActionButton>
          <ActionButton kind="open-folder">Show data folder</ActionButton>
          <ActionButton kind="exit">Exit GoalPort</ActionButton>
        </div>
        <small className="bootstrap-footnote">If the other GoalPort is still open, closing it releases the data; “Try again” then continues.</small>
      </>
    );
  }

  if (state.phase === "error") {
    return shell(
      <>
        <h2>{state.headline}</h2>
        {state.message ? <p className="bootstrap-detail">{state.message}</p> : null}
        <p className="bootstrap-note">Your data is preserved. Nothing was deleted or overwritten.</p>
        <div className="bootstrap-actions">
          {state.canChooseDir ? <ActionButton kind="choose-dir" autoFocus>Choose a different folder…</ActionButton> : null}
          <ActionButton kind="open-folder">Show data folder</ActionButton>
          <ActionButton kind="exit">Exit</ActionButton>
        </div>
      </>
    );
  }

  return shell(
    <>
      <p>Starting GoalPort…</p>
      <small>The local Core is restoring its record. This can take a moment.</small>
      <StatusLine state={state} />
    </>
  );
}
