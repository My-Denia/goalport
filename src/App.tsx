import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { getCoreClient, persistedAttemptId, reusableAttemptId, type AppInfo, type CoreCommand } from "./ipc";
import {
  appendPreviewMessage,
  createPreviewCampaign,
  DEMO_SNAPSHOT,
  EMPTY_SNAPSHOT,
  resolvePermission,
  withConnection,
  type CoreSnapshot,
  type EvidenceState,
  type RuntimeProfile,
  type StopResponsibilitySummary,
  type TimelineItem,
  type TimelineKind
} from "./types";
import "./styles.css";

const KIND_META: Record<TimelineKind, { label: string; glyph: string }> = {
  message: { label: "Message", glyph: "↗" },
  plan: { label: "Plan", glyph: "☷" },
  attempt: { label: "Attempt", glyph: "◌" },
  tool: { label: "Tool activity", glyph: "⌁" },
  permission: { label: "Permission", glyph: "⊘" },
  decision: { label: "Decision", glyph: "◆" },
  evidence: { label: "Evidence", glyph: "✓" },
  audit: { label: "Audit", glyph: "◎" },
  handoff: { label: "Handoff", glyph: "⇄" },
  recovery: { label: "Recovery", glyph: "↻" },
  completion: { label: "Completion", glyph: "✦" }
};

const EVIDENCE_LABEL: Record<EvidenceState, string> = {
  verified: "Verified",
  "needs-review": "Needs review",
  stale: "Stale",
  unavailable: "Unavailable",
  unsupported: "Unsupported"
};

function noticeAfterRuntimeSelect(next: CoreSnapshot, current: string | null): string | null {
  return commandFailure(next, "select_runtime") ?? (next.connection === "disconnected" ? current : null);
}

function commandFailure(next: CoreSnapshot, messageType: string): string | null {
  const outcome = next.commandOutcome;
  if (outcome?.messageType === messageType) {
    if (outcome.kind === "accepted") return null;
    return outcome.kind === "refused"
      ? `Core refused: ${outcome.error ?? "request not accepted"}`
      : `Core request failed: ${outcome.error ?? "transport unavailable"}`;
  }
  const notices = next.notices ?? [];
  const explicit = notices.find((notice) =>
    notice.startsWith("Core refused:")
    || notice.startsWith("Core request failed:")
    || notice.startsWith("Core unavailable")
  );
  if (explicit) return explicit;
  return `Core did not confirm ${messageType.replace(/_/g, " ")}.`;
}

function attemptIsRoutable(snapshot: CoreSnapshot): boolean {
  const attemptId = persistedAttemptId(snapshot.attempt.id);
  const provider = snapshot.attempt.provider.trim().toLowerCase();
  return Boolean(
    attemptId
    && snapshot.activeCampaignId
    && snapshot.activeTask.id
    && snapshot.attempt.taskId === snapshot.activeTask.id
    && provider
    && provider !== "unassigned"
    && snapshot.attempt.state !== "uncertain"
    && snapshot.attempt.state !== "completed"
    && snapshot.attempt.state !== "failed"
  );
}

function attemptDisplay(snapshot: CoreSnapshot): { label: string; detail: string; glyph: string; uncertain: boolean } {
  const provider = snapshot.attempt.provider.trim();
  const unassigned = !persistedAttemptId(snapshot.attempt.id) || provider.toLowerCase() === "unassigned";
  const mismatched = Boolean(snapshot.activeTask.id && snapshot.attempt.taskId !== snapshot.activeTask.id);
  const uncertain = !unassigned && (snapshot.attempt.state === "uncertain" || mismatched);
  if (unassigned) return { label: "No Runtime selected", detail: "unassigned", glyph: "–", uncertain: false };
  if (uncertain) return { label: "Runtime identity uncertain", detail: "send blocked", glyph: "?", uncertain: true };
  if (provider.toLowerCase() === "scenario") {
    return { label: "Synthetic Scenario Runtime", detail: `synthetic · ${snapshot.attempt.state}`, glyph: "S", uncertain: false };
  }
  return { label: provider, detail: `${snapshot.attempt.role} · ${snapshot.attempt.state}`, glyph: provider[0]?.toUpperCase() ?? "?", uncertain: false };
}

function scenarioIsActive(snapshot: CoreSnapshot): boolean {
  return snapshot.attempt.provider.trim().toLowerCase() === "scenario";
}

function presentedTimelineItem(item: TimelineItem, syntheticScenario: boolean): TimelineItem {
  if (!syntheticScenario || !/native runtime/i.test(item.actor)) return item;
  return { ...item, actor: item.actor.replace(/native runtime/gi, "Synthetic Scenario Runtime") };
}

function presentedSessionLabel(snapshot: CoreSnapshot): string {
  const label = snapshot.attempt.sessionLabel.trim();
  if (!scenarioIsActive(snapshot)) return label;
  const synthetic = label
    .replace(/native runtime/gi, "Synthetic Scenario Runtime")
    .replace(/native session/gi, "synthetic session");
  return `Synthetic Scenario · ${synthetic || "synthetic session"}`;
}

function commandTargetKey(campaignId: string, taskId: string, attemptId: string): string {
  return `${campaignId}\u001f${taskId}\u001f${attemptId}`;
}

function snapshotTargetKey(snapshot: CoreSnapshot): string {
  return commandTargetKey(snapshot.activeCampaignId, snapshot.activeTask.id, snapshot.attempt.id);
}

function connectionLabel(snapshot: CoreSnapshot): string {
  if (snapshot.connection === "connected") return "Core connected";
  if (snapshot.connection === "reconnecting") return "Reconnecting";
  if (snapshot.connection === "degraded") return "Core degraded";
  return "Core disconnected";
}

function channelLabel(appInfo: AppInfo | null, preview: boolean): string {
  const channel = appInfo?.channel.trim() || (preview ? "preview" : "rc");
  const version = appInfo?.version.trim();
  return `${channel.toUpperCase()}${version ? ` ${version}` : ""}${appInfo?.testMode ? " · TEST" : ""}`;
}

function App() {
  const client = useMemo(() => getCoreClient(), []);
  const [snapshot, setSnapshot] = useState<CoreSnapshot>(() => client.mode === "browser-preview" ? DEMO_SNAPSHOT : EMPTY_SNAPSHOT);
  const [campaignDrafts, setCampaignDrafts] = useState<Record<string, string>>({});
  const [workspaceDraft, setWorkspaceDraft] = useState("");
  const [goalDraft, setGoalDraft] = useState("");
  const [firstRunOpen, setFirstRunOpen] = useState(false);
  const [expandedItems, setExpandedItems] = useState<Record<string, boolean>>({});
  const [activeNotice, setActiveNotice] = useState<string | null>(null);
  const [targetNotices, setTargetNotices] = useState<Record<string, string>>({});
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [sendBusy, setSendBusy] = useState(false);
  const [campaignBusy, setCampaignBusy] = useState(false);
  const [campaignError, setCampaignError] = useState<string | null>(null);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [closeChoiceOpen, setCloseChoiceOpen] = useState(false);
  const selectionIntent = useRef(0);
  const sendInFlight = useRef(false);

  const draftCampaignId = snapshot.activeCampaignId;
  const draft = draftCampaignId ? campaignDrafts[draftCampaignId] ?? "" : "";

  function updateVisibleCampaignDraft(value: string) {
    // Selection is authoritative only after Core returns its projection. While a
    // selection is pending, the visible composer remains bound to the campaign
    // still on screen, so keystrokes cannot silently move to the requested one.
    if (!draftCampaignId) return;
    setCampaignDrafts((current) => ({ ...current, [draftCampaignId]: value }));
  }

  useEffect(() => {
    let mounted = true;
    let autoStartAttempted = false;
    const refresh = async (allowStart: boolean) => {
      const next = await client.snapshot();
      if (!mounted) return;
      setSnapshot(next);
      if (allowStart && !autoStartAttempted && next.connection !== "connected" && client.mode !== "browser-preview") {
        autoStartAttempted = true;
        const started = await client.startCore();
        if (mounted) setSnapshot(started);
      }
    };
    void refresh(true);
    const timer = window.setInterval(() => {
      if (!mounted) return;
      void refresh(false);
    }, 750);
    return () => {
      mounted = false;
      window.clearInterval(timer);
    };
  }, [client]);

  useEffect(() => {
    let mounted = true;
    if (client.appInfo) {
      void client.appInfo().then((info) => {
        if (mounted) setAppInfo(info);
      }).catch(() => undefined);
    }
    return () => { mounted = false; };
  }, [client]);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const bindIsolatedDispatch = (): boolean => {
      if (window.__GOALPORT_ISOLATED !== 1) return false;
      if (typeof client.dispatch !== "function") return false;
      window.__goalportDispatch = (request: CoreCommand) => client.dispatch!(request);
      window.__goalportAppSnapshot = () => client.snapshot();
      return true;
    };
    if (bindIsolatedDispatch()) {
      return () => {
        delete window.__goalportDispatch;
        delete window.__goalportAppSnapshot;
      };
    }
    const interval = window.setInterval(() => {
      if (bindIsolatedDispatch()) window.clearInterval(interval);
    }, 50);
    const timeout = window.setTimeout(() => window.clearInterval(interval), 8000);
    return () => {
      window.clearInterval(interval);
      window.clearTimeout(timeout);
      if (window.__GOALPORT_ISOLATED === 1) {
        delete window.__goalportDispatch;
        delete window.__goalportAppSnapshot;
      }
    };
  }, [client]);

  useEffect(() => {
    const api = window.goalportCore;
    if (!api?.onClosePrompt) return;
    const stopPrompt = api.onClosePrompt(() => setCloseChoiceOpen(true));
    const stopFailed = api.onCloseChoiceFailed?.(() => {
      setCloseChoiceOpen(true);
      setActiveNotice("Continue in background was not recorded. The window stays open.");
    });
    return () => {
      stopPrompt();
      stopFailed?.();
    };
  }, []);

  function attemptIsActive(state: string | undefined): boolean {
    return state === "active" || state === "ACTIVE";
  }

  function handleCloseWindow() {
    if (attemptIsActive(snapshot.attempt.state) || snapshot.stopResponsibility?.writeResponsibility === "held") {
      setCloseChoiceOpen(true);
      return;
    }
    if (window.goalportCore?.requestClose) {
      void window.goalportCore.requestClose();
      return;
    }
  }

  function handleCloseChoice(choice: "continue" | "stop") {
    if (!window.goalportCore?.confirmCloseChoice) {
      setCloseChoiceOpen(false);
      return;
    }
    void confirmCloseChoiceWithReceipt(choice);
  }

  async function confirmCloseChoiceWithReceipt(choice: "continue" | "stop") {
    const requestId = typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `close-${Date.now()}`;
    const continueClickIssuedAtUtc = new Date().toISOString();
    window.__goalportCloseRequestId = requestId;
    try {
      const result = await window.goalportCore?.confirmCloseChoice?.({
        requestId,
        choice,
        continueClickIssuedAtUtc
      }) as {
        ok?: boolean;
        receiptId?: string;
        coreAcknowledged?: boolean;
        allowQuitLatch?: boolean;
        choice?: string;
      } | undefined;
      const accepted = result?.ok === true
        && result.coreAcknowledged === true
        && result.allowQuitLatch === true
        && Boolean(result.receiptId)
        && result.choice === choice;
      if (!accepted) {
        setCloseChoiceOpen(true);
        setActiveNotice(choice === "continue"
          ? "Continue in background was not recorded. The window stays open."
          : "Stop was not durably acknowledged by Core. The window stays open.");
        return;
      }
      setCloseChoiceOpen(false);
    } catch {
      setCloseChoiceOpen(true);
      setActiveNotice(choice === "continue"
        ? "Continue in background failed. The window stays open."
        : "Stop failed before durable Core acknowledgement. The window stays open.");
    }
  }

  function handleDismissCloseChoice() {
    setCloseChoiceOpen(false);
    if (window.goalportCore?.dismissCloseChoice) void window.goalportCore.dismissCloseChoice();
  }

  const activeCampaign = snapshot.campaigns.find((campaign) => campaign.id === snapshot.activeCampaignId);
  const activeTargetKey = snapshotTargetKey(snapshot);
  const displayedNotice = activeNotice ?? targetNotices[activeTargetKey] ?? null;
  const syntheticScenario = scenarioIsActive(snapshot);

  async function handleSend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (snapshot.stopResponsibility?.writeResponsibility === "held") {
      setActiveNotice("Core refused new work while residual execution is unknown and write responsibility is held.");
      return;
    }
    if (!attemptIsRoutable(snapshot)) {
      setActiveNotice(snapshot.attempt.state === "uncertain"
        ? "Runtime identity is uncertain. Select a Runtime before sending new input."
        : "Select a Runtime for the active task before sending a message.");
      return;
    }
    if (sendInFlight.current) return;
    const submittedDraft = draft;
    const message = submittedDraft.trim();
    if (!message) return;
    const target = {
      campaignId: snapshot.activeCampaignId,
      taskId: snapshot.activeTask.id,
      attemptId: snapshot.attempt.id,
      selection: selectionIntent.current
    };
    const targetKey = commandTargetKey(target.campaignId, target.taskId, target.attemptId);
    sendInFlight.current = true;
    setSendBusy(true);
    try {
      const next = client.mode === "browser-preview"
        ? appendPreviewMessage(snapshot, message)
        : await client.sendMessage(message, target.campaignId, target.attemptId, target.taskId);
      if (target.selection === selectionIntent.current) setSnapshot(next);
      const failure = client.mode === "browser-preview" ? null : commandFailure(next, "send_message");
      const notice = failure
        ?? `Message recorded for task ${target.taskId} with a stable command identity. Reconnect will not replay it.`;
      setTargetNotices((current) => ({ ...current, [targetKey]: notice }));
      if (failure) {
        if (target.selection === selectionIntent.current) setActiveNotice(failure);
        return;
      }
      setCampaignDrafts((current) => current[target.campaignId] === submittedDraft
        ? { ...current, [target.campaignId]: "" }
        : current);
      if (target.selection === selectionIntent.current) {
        setActiveNotice(notice);
      }
    } finally {
      sendInFlight.current = false;
      setSendBusy(false);
    }
  }

  async function handlePermissionDecision(decisionId: string, allow: boolean) {
    if (allow && snapshot.stopResponsibility?.writeResponsibility === "held") {
      setActiveNotice("Permission Allow is blocked while Core holds Stop responsibility. Decline remains available.");
      return;
    }
    const viewIntent = selectionIntent.current;
    const next = client.mode === "browser-preview" ? resolvePermission(snapshot, allow) : await client.resolveDecision(decisionId, allow);
    if (viewIntent === selectionIntent.current) setSnapshot(next);
    if (client.mode !== "browser-preview") {
      const failure = commandFailure(next, "resolve_decision");
      if (failure) {
        setActiveNotice(failure);
        return;
      }
    }
    setActiveNotice(allow ? "Permission allowed once. Session-wide approval remains disabled." : "Permission denied. No write action was sent and automatic retry is disabled.");
    if (client.notify) {
      void client.notify(allow ? "GoalPort decision" : "GoalPort decision", allow ? "Permission allowed once." : "Permission denied.");
    }
  }

  async function handleRevoke(scope: string) {
    if (!client.revokeAuthorization || !snapshot.activeCampaignId) {
      setActiveNotice("Revocation is unavailable until a Core campaign is selected.");
      return;
    }
    const viewIntent = selectionIntent.current;
    const next = await client.revokeAuthorization(snapshot.activeCampaignId, scope);
    if (viewIntent === selectionIntent.current) setSnapshot(next);
    const failure = commandFailure(next, "revoke_authorization");
    if (failure) {
      setActiveNotice(failure);
      return;
    }
    setActiveNotice(`Current ${scope} authorization revoked. The next related action will re-check current auth.`);
    if (client.notify) void client.notify("GoalPort decision", `Authorization revoked: ${scope}`);
  }

  async function handleOwnerAction(action: string) {
    if (!client.requestOwnerAction) {
      setActiveNotice("Owner-only requests require a connected Core.");
      return;
    }
    const viewIntent = selectionIntent.current;
    const next = await client.requestOwnerAction(action, true, true);
    if (viewIntent === selectionIntent.current) setSnapshot(next);
    setActiveNotice(commandFailure(next, "request_owner_action") ?? `Owner-only ${action} was blocked. Plan/audit flags do not grant authority.`);
  }

  // A re-check reads current reality and appends one observation. It cannot release
  // anything, so it needs no confirmation -- but it can fail, and a failed re-check
  // must say so rather than leaving the previous verdict on screen looking current.
  async function handleRecheck(attemptId: string) {
    if (!client.recheckStopResponsibility) {
      setActiveNotice("This build cannot re-check a hold.");
      return;
    }
    setRecoveryBusy(true);
    const viewIntent = selectionIntent.current;
    try {
      const next = await client.recheckStopResponsibility(attemptId);
      if (viewIntent === selectionIntent.current) setSnapshot(next);
      const failure = commandFailure(next, "recheck_stop_responsibility");
      if (failure) setActiveNotice(failure.replace(/^Core (?:refused|request failed):\s*/, "Re-check failed: "));
    } catch (error) {
      setActiveNotice(`Re-check failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setRecoveryBusy(false);
    }
  }

  // Continuing does not release the held workspace and never claims to. Core
  // refuses an overlapping target, a stale observation, or a replay; those
  // refusals are surfaced verbatim rather than reworded, because Core's wording
  // names the specific reason and a friendlier paraphrase would lose it.
  async function handleContinue(attemptId: string) {
    if (!client.continueInIsolatedWorkspace) {
      setActiveNotice("This build cannot continue in a new workspace.");
      return;
    }
    const hold = snapshot.stopResponsibility?.attemptId === attemptId
      ? snapshot.stopResponsibility
      : snapshot.relatedHolds.find((candidate) => candidate.attemptId === attemptId);
    const source = hold?.workspaceKey ?? "";
    if (!source) {
      setActiveNotice("Core did not report which workspace this hold covers, so no continuation target can be proposed.");
      return;
    }
    // A sibling, never a child: a child of the held workspace overlaps it and Core
    // would refuse. Proposing one anyway would train the user to expect a refusal.
    const suggestion = `${source.replace(/[\/]+$/, "")}-continued-${Date.now().toString(36)}`;
    setRecoveryBusy(true);
    const viewIntent = selectionIntent.current;
    try {
      const next = await client.continueInIsolatedWorkspace(attemptId, suggestion);
      if (viewIntent === selectionIntent.current) setSnapshot(next);
      // A Core refusal does NOT reject: `dispatch` returns the previous snapshot with
      // a "Core refused: …" notice prepended. Announcing success on that path would
      // tell the user their work had been carried somewhere it had not -- the exact
      // class of false safety claim this whole feature exists to avoid. So the
      // refusal is detected and shown as a refusal.
      const failure = commandFailure(next, "continue_in_isolated_workspace");
      if (failure) {
        setActiveNotice(failure.replace(/^Core (?:refused|request failed):\s*/, "Continuation refused: "));
        return;
      }
      setActiveNotice(`Continued in ${suggestion}. The original workspace stays held.`);
    } catch (error) {
      setActiveNotice(`Continuation refused: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setRecoveryBusy(false);
    }
  }

  async function handleHandoff() {
    if (snapshot.stopResponsibility?.writeResponsibility === "held") {
      setActiveNotice("Handoff is blocked while residual execution remains unknown and Core holds write responsibility.");
      return;
    }
    if (!client.handoff || !snapshot.attempt.id) {
      setActiveNotice("Core handoff is unavailable until a connected Runtime Attempt is selected.");
      return;
    }
    const candidate = snapshot.runtimes.find((runtime) => runtime.id !== snapshot.attempt.provider && runtime.support !== "unsupported");
    if (!candidate) {
      setActiveNotice("No second Runtime has a verified capability path for handoff.");
      return;
    }
    const viewIntent = selectionIntent.current;
    const next = await client.handoff(
      candidate.id,
      snapshot.attempt.id,
      "Continue from the Core generated handoff packet and report the next safe step."
    );
    if (viewIntent === selectionIntent.current) setSnapshot(next);
    const failure = commandFailure(next, "handoff");
    if (failure) {
      setActiveNotice(failure);
      return;
    }
    setActiveNotice(`Core assigned a new ${candidate.name} Attempt from the persisted handoff packet.`);
  }

  async function handleOffline() {
    const next = client.mode === "browser-preview" ? withConnection(snapshot, "disconnected") : await client.setConnection("disconnected");
    setSnapshot(next);
    setActiveNotice("UI is offline. Core keeps committed task state; uncommitted input remains in this window.");
  }

  async function handleInterrupt() {
    const attemptId = persistedAttemptId(snapshot.attempt.id);
    if (!client.interrupt || !attemptId || snapshot.attempt.state !== "active") {
      setActiveNotice("Core has no active Runtime turn to stop.");
      return;
    }
    const viewIntent = selectionIntent.current;
    const next = await client.interrupt(attemptId);
    if (viewIntent === selectionIntent.current) setSnapshot(next);
    const failure = commandFailure(next, "interrupt");
    if (failure) setActiveNotice(failure);
  }

  async function handleReconnect() {
    const next = client.mode === "browser-preview" ? withConnection(snapshot, "connected") : await client.startCore();
    setSnapshot(next);
    const failure = client.mode === "browser-preview" || next.commandOutcome?.messageType !== "reconnect"
      ? null
      : commandFailure(next, "reconnect");
    setActiveNotice(
      failure
        ? failure
        : next.connection === "connected"
        ? "Reconnected from the Core projection. No prompt was replayed."
        : "Core connection remains unavailable. No prompt was replayed."
    );
  }

  function handleKeepWaiting() {
    setActiveNotice("Decision remains pending. No action was sent and the Attempt will stay waiting.");
  }

  async function handleCreateCampaign(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (campaignBusy) return;
    const workspace = workspaceDraft.trim();
    const goal = goalDraft.trim();
    if (!workspace || !goal) return;
    const intent = ++selectionIntent.current;
    setCampaignBusy(true);
    setCampaignError(null);
    try {
      const next = client.mode === "browser-preview"
        ? createPreviewCampaign(snapshot, workspace, goal)
        : await client.createCampaign(workspace, goal);
      if (intent !== selectionIntent.current) return;
      const failure = client.mode === "browser-preview" ? null : commandFailure(next, "create_campaign");
      if (failure) {
        setSnapshot(next);
        setCampaignError(failure);
        setActiveNotice(failure);
        return;
      }
      setSnapshot(next);
      setWorkspaceDraft("");
      setGoalDraft("");
      setFirstRunOpen(false);
      setActiveNotice(client.mode === "browser-preview"
        ? "Synthetic preview campaign created. Connect Core before assigning work to a Runtime."
        : "Campaign created. Select a Runtime before sending work.");
    } finally {
      setCampaignBusy(false);
    }
  }

  async function selectCampaign(campaignId: string) {
    const selected = snapshot.campaigns.find((campaign) => campaign.id === campaignId);
    if (!selected || selected.id === snapshot.activeCampaignId) return;
    if (client.selectCampaign) {
      const intent = ++selectionIntent.current;
      const next = await client.selectCampaign(campaignId);
      if (intent !== selectionIntent.current) return;
      setSnapshot(next);
      const failure = commandFailure(next, "select_campaign");
      setActiveNotice(failure);
      return;
    }
    setSnapshot({
      ...snapshot,
      activeCampaignId: selected.id,
      activeTask: { ...snapshot.activeTask, title: selected.activeTaskTitle },
      notices: [`Viewing ${selected.title}. Attempt continuity is read from Core.`, ...snapshot.notices]
    });
  }

  async function selectProject(projectId: string) {
    if (!client.selectProject || projectId === snapshot.selectedProjectId) return;
    const intent = ++selectionIntent.current;
    const next = await client.selectProject(projectId);
    if (intent !== selectionIntent.current) return;
    setSnapshot(next);
    const failure = commandFailure(next, "select_project");
    setActiveNotice(failure);
  }

  async function selectRuntime(provider: string) {
    if (!client.selectRuntime || !snapshot.activeCampaignId || !snapshot.activeTask.id) {
      setActiveNotice("Create or select a campaign task before choosing a Runtime.");
      return;
    }
    const intent = ++selectionIntent.current;
    const campaignId = snapshot.activeCampaignId;
    const taskId = snapshot.activeTask.id;
    const attemptId = reusableAttemptId(snapshot.attempt);
    const next = attemptId
      ? await client.selectRuntime(provider, campaignId, taskId, attemptId)
      : await client.selectRuntime(provider, campaignId, taskId);
    if (intent !== selectionIntent.current) return;
    setSnapshot(next);
    setActiveNotice((current) => noticeAfterRuntimeSelect(next, current));
    if (typeof window !== "undefined" && window.__GOALPORT_ISOLATED === 1) {
      window.__goalportLastSelectResult = next;
      window.__goalportLastSnapshot = next;
    }
  }

  async function chooseWorkspace() {
    if (client.mode !== "electron" || !client.chooseWorkspace) return;
    try {
      const selected = await client.chooseWorkspace();
      if (selected) {
        setWorkspaceDraft(selected);
        setCampaignError(null);
      }
    } catch (error) {
      const message = `Workspace selection failed: ${error instanceof Error ? error.message : String(error)}`;
      setCampaignError(message);
      setActiveNotice(message);
    }
  }

  function openCampaignDialog() {
    setCampaignError(null);
    setFirstRunOpen(true);
  }

  function toggleTimelineItem(id: string) {
    setExpandedItems((current) => ({ ...current, [id]: !current[id] }));
  }

  return (
    <div className="goalport-shell" data-connection={snapshot.connection} data-preview={snapshot.preview}
      data-attempt-id={snapshot.attempt.id} data-campaign-id={snapshot.activeCampaignId} data-core-build-id={snapshot.buildId}>
      <TopBar
        snapshot={snapshot}
        activeCampaign={activeCampaign}
        appInfo={appInfo}
        onReconnect={handleReconnect}
        onOffline={handleOffline}
        onOpenFirstRun={openCampaignDialog}
        onCloseWindow={handleCloseWindow}
      />

      <div className="workspace-grid">
        <ProjectSidebar
          snapshot={snapshot}
          onSelectCampaign={(campaignId) => { void selectCampaign(campaignId); }}
          onSelectProject={(projectId) => {
            void selectProject(projectId);
          }}
          onNewCampaign={openCampaignDialog}
        />

        <main className="conversation-column" aria-label="Campaign conversation">
          <ConversationHeading snapshot={snapshot} activeCampaign={activeCampaign} />
          <div className="timeline-scroll" aria-live="polite">
            <div className="timeline-intro">
              <div className="intro-mark">GP</div>
              <div>
                <p className="eyebrow">CAMPAIGN CONTINUITY</p>
                <h1>{activeCampaign?.title ?? "New campaign"}</h1>
                <p>
                  The conversation is grouped by responsibility. Native Runtime sessions stay in their own tools; this timeline records the
                  durable control facts.
                </p>
              </div>
            </div>

            <div className="timeline-list">
              {snapshot.timeline.map((item) => (
                <TimelineCard key={item.id} item={presentedTimelineItem(item, syntheticScenario)} expanded={Boolean(expandedItems[item.id])} onToggle={toggleTimelineItem} />
              ))}
            </div>
          </div>
          <Composer
            draft={draft}
            connection={snapshot.connection}
            held={snapshot.stopResponsibility?.writeResponsibility === "held"}
            ready={attemptIsRoutable(snapshot)}
            busy={sendBusy}
            onChange={updateVisibleCampaignDraft}
            onSubmit={handleSend}
          />
        </main>

        <ContextRail
          snapshot={snapshot}
          onPermissionDecision={(decisionId, allow) => {
            void handlePermissionDecision(decisionId, allow);
          }}
          onKeepWaiting={handleKeepWaiting}
          onReconnect={handleReconnect}
          onOffline={handleOffline}
          onHandoff={() => { void handleHandoff(); }}
          onSelectRuntime={(provider) => { void selectRuntime(provider); }}
          onRecheck={(attemptId) => { void handleRecheck(attemptId); }}
          onContinue={(attemptId) => { void handleContinue(attemptId); }}
          recoveryBusy={recoveryBusy}
          onInterrupt={() => { void handleInterrupt(); }}
          onRevoke={(scope) => { void handleRevoke(scope); }}
          onOwnerAction={(action) => { void handleOwnerAction(action); }}
          onOpenInVsCode={() => {
            void client.openInVsCode(snapshot.project.workspaceRoot).catch(() => {
              setActiveNotice("VS Code launcher is unavailable for the selected workspace.");
            });
          }}
        />
      </div>

      <FooterBar
        snapshot={snapshot}
        appInfo={appInfo}
        activeNotice={displayedNotice}
        onDismissNotice={() => {
          setActiveNotice(null);
          setTargetNotices((current) => {
            const next = { ...current };
            delete next[activeTargetKey];
            return next;
          });
        }}
      />

      {firstRunOpen ? (
        <FirstRunDialog
          workspace={workspaceDraft}
          goal={goalDraft}
          preview={client.mode === "browser-preview"}
          busy={campaignBusy}
          error={campaignError}
          canBrowse={client.mode === "electron" && Boolean(client.chooseWorkspace)}
          onWorkspaceChange={setWorkspaceDraft}
          onGoalChange={setGoalDraft}
          onBrowse={() => { void chooseWorkspace(); }}
          onCancel={() => {
            if (!campaignBusy) setFirstRunOpen(false);
          }}
          onSubmit={handleCreateCampaign}
        />
      ) : null}

      {closeChoiceOpen ? (
        <CloseChoiceDialog
          provider={snapshot.attempt.provider}
          active={snapshot.attempt.state === "active"}
          stopResponsibility={snapshot.stopResponsibility}
          onContinue={() => { void handleCloseChoice("continue"); }}
          onStop={() => { void handleCloseChoice("stop"); }}
          onKeepOpen={handleDismissCloseChoice}
        />
      ) : null}
    </div>
  );
}

interface TopBarProps {
  snapshot: CoreSnapshot;
  activeCampaign: CoreSnapshot["campaigns"][number] | undefined;
  appInfo: AppInfo | null;
  onReconnect: () => void;
  onOffline: () => void;
  onOpenFirstRun: () => void;
  onCloseWindow: () => void;
}

function TopBar({ snapshot, activeCampaign, appInfo, onReconnect, onOffline, onOpenFirstRun, onCloseWindow }: TopBarProps) {
  const connected = snapshot.connection === "connected";
  const channel = (appInfo?.channel || (snapshot.preview ? "preview" : "rc")).toUpperCase();
  return (
    <header className="topbar" role="banner">
      <div className="brand-lockup">
        <div className="brand-glyph" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <span className="brand-name">GoalPort</span>
        <span className="brand-version">{channelLabel(appInfo, snapshot.preview)}</span>
      </div>

      <div className="breadcrumb" aria-label="Current campaign">
        <span className="breadcrumb-project">{snapshot.project.name}</span>
        <span className="breadcrumb-divider">/</span>
        <strong>{activeCampaign?.title ?? "New campaign"}</strong>
      </div>

      <div className="topbar-actions">
        <span className={`connection-pill connection-${snapshot.connection}`}>
          <span className="status-dot" aria-hidden="true" />
          {connectionLabel(snapshot)}
        </span>
        <span className="mode-pill">
          <span className="mode-dot" aria-hidden="true" />
          {snapshot.preview ? "Synthetic Scenario" : `Assisted · ${channel}`}
        </span>
        {connected ? (
          <button className="icon-button" type="button" aria-label="Simulate offline" onClick={onOffline} title="Simulate offline">
            ↯
          </button>
        ) : (
          <button className="button button-small button-accent" type="button" aria-label="Reconnect Core" onClick={onReconnect}>
            Reconnect
          </button>
        )}
        <button className="button button-small button-outline" type="button" onClick={onOpenFirstRun}>
          <span aria-hidden="true">＋</span> New campaign
        </button>
        <button className="icon-button" type="button" aria-label="Close window" title="Close window" onClick={onCloseWindow}>
          ×
        </button>
        <button className="avatar-button" type="button" aria-label="Open profile menu">
          P
        </button>
      </div>
    </header>
  );
}

interface ProjectSidebarProps {
  snapshot: CoreSnapshot;
  onSelectCampaign: (id: string) => void;
  onSelectProject: (id: string) => void;
  onNewCampaign: () => void;
}

function ProjectSidebar({ snapshot, onSelectCampaign, onSelectProject, onNewCampaign }: ProjectSidebarProps) {
  return (
    <aside className="project-sidebar" aria-label="Projects and campaigns">
      <div className="sidebar-heading">
        <div>
          <p className="eyebrow">WORKSPACE</p>
          <h2>Projects</h2>
        </div>
        <button className="icon-button subtle" type="button" aria-label="Add project" title="Add project" onClick={onNewCampaign}>
          ＋
        </button>
      </div>

      <label className="project-switcher" aria-label="Select project">
        <span className="project-avatar">G</span>
        <span className="project-switcher-copy">
          <strong>{snapshot.project.name}</strong>
          <small>{shortPath(snapshot.project.workspaceRoot)}</small>
        </span>
        <select
          className="project-select"
          aria-label="Project"
          value={snapshot.selectedProjectId || snapshot.project.id}
          onChange={(event) => onSelectProject(event.target.value)}
        >
          {(snapshot.projects.length > 0 ? snapshot.projects : [snapshot.project]).map((project) => (
            <option key={project.id} value={project.id}>{project.name}</option>
          ))}
        </select>
      </label>

      <div className="sidebar-section-title">
        <span>Campaigns</span>
        <span className="count-badge">{snapshot.campaigns.length}</span>
      </div>

      <div className="campaign-list">
        {snapshot.campaigns.map((campaign) => (
          <button
            className={`campaign-item ${campaign.id === snapshot.activeCampaignId ? "campaign-active" : ""}`}
            key={campaign.id}
            type="button"
            onClick={() => onSelectCampaign(campaign.id)}
          >
            <span className={`campaign-state campaign-state-${campaign.state}`} aria-hidden="true" />
            <span className="campaign-item-copy">
              <strong>{campaign.title}</strong>
              <small>{campaign.updatedLabel}</small>
            </span>
            {campaign.id === snapshot.activeCampaignId ? <span className="active-arrow" aria-hidden="true">›</span> : null}
          </button>
        ))}
      </div>

      <button className="new-campaign-link" type="button" onClick={onNewCampaign}>
        <span className="new-campaign-icon" aria-hidden="true">
          ＋
        </span>
        <span>Start a new campaign</span>
      </button>

      <div className="sidebar-spacer" />
      <div className="sidebar-footnote">
        <span className="footnote-shield" aria-hidden="true">◈</span>
        <p>
          <strong>Core-owned continuity</strong>
          <span>Window lifecycle does not own your task state.</span>
        </p>
      </div>
    </aside>
  );
}

function ConversationHeading({ snapshot, activeCampaign }: { snapshot: CoreSnapshot; activeCampaign: CoreSnapshot["campaigns"][number] | undefined }) {
  const attempt = attemptDisplay(snapshot);
  return (
    <div className="conversation-heading">
      <div className="conversation-heading-main">
        <div className="heading-kicker">
          <span className="live-indicator"><span aria-hidden="true" /> Live projection</span>
          <span className="heading-separator">·</span>
          <span>Campaign → Task → Attempt</span>
        </div>
        <h2>{snapshot.activeTask.title}</h2>
        <p>{activeCampaign?.goal ?? "Start a campaign to give the active Runtime a scoped goal."}</p>
      </div>
      <div className="conversation-heading-side">
        <span className={`task-state task-state-${snapshot.activeTask.state}`}>{snapshot.activeTask.state.replace("-", " ")}</span>
        <span className="attempt-chip" data-identity-uncertain={attempt.uncertain ? "true" : "false"}>
          <span className={`provider-avatar provider-${snapshot.attempt.provider.toLowerCase()}`}>{attempt.glyph}</span>
          <span>{attempt.label}</span>
          <span className="attempt-role">{attempt.detail}</span>
        </span>
      </div>
    </div>
  );
}

interface TimelineCardProps {
  item: TimelineItem;
  expanded: boolean;
  onToggle: (id: string) => void;
}

function TimelineCard({ item, expanded, onToggle }: TimelineCardProps) {
  const meta = KIND_META[item.kind];
  const details = item.details ?? [];
  return (
    <article className={`timeline-card card-accent-${item.accent ?? "slate"} kind-${item.kind}`}>
      <div className="timeline-connector" aria-hidden="true" />
      <div className="timeline-card-icon" aria-hidden="true">{meta.glyph}</div>
      <div className="timeline-card-body">
        <div className="timeline-card-topline">
          <span className="timeline-kind">{meta.label}</span>
          <span className="timeline-actor">{item.actor}</span>
          <time>{item.timestamp}</time>
        </div>
        <div className="timeline-card-title-row">
          <h3>{item.title}</h3>
          {item.status ? <span className={`event-status event-status-${item.status.toLowerCase().replace(/\s+/g, "-")}`}>{item.status}</span> : null}
        </div>
        <p className="timeline-card-copy">{item.body}</p>
        {item.evidenceState ? <EvidenceBadge state={item.evidenceState} /> : null}
        {details.length > 0 ? (
          <>
            <button className="details-toggle" type="button" onClick={() => onToggle(item.id)} aria-expanded={expanded}>
              <span aria-hidden="true">{expanded ? "⌃" : "⌄"}</span>
              {expanded ? "Hide details" : `${details.length} structured ${details.length === 1 ? "detail" : "details"}`}
            </button>
            {expanded ? (
              <ul className="timeline-details">
                {details.map((detail) => <li key={detail}>{detail}</li>)}
              </ul>
            ) : null}
          </>
        ) : null}
      </div>
    </article>
  );
}

function EvidenceBadge({ state }: { state: EvidenceState }) {
  return <span className={`evidence-badge evidence-${state}`}><span aria-hidden="true">{state === "verified" ? "✓" : "!"}</span>{EVIDENCE_LABEL[state]}</span>;
}

interface ComposerProps {
  draft: string;
  connection: CoreSnapshot["connection"];
  held: boolean;
  ready: boolean;
  busy: boolean;
  onChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

function Composer({ draft, connection, held, ready, busy, onChange, onSubmit }: ComposerProps) {
  const canSubmit = draft.trim().length > 0 && connection === "connected" && !held && ready && !busy;
  return (
    <form className="composer" aria-label="Message composer" onSubmit={onSubmit}>
      <div className="composer-inner">
        <textarea
          aria-label="Message composer"
          value={draft}
          onChange={(event) => onChange(event.target.value)}
          placeholder={held
            ? "Core holds write responsibility while residual execution is unknown…"
            : connection !== "connected"
              ? "Reconnect Core before sending a new message…"
              : ready
                ? "Ask the active Runtime to continue…"
                : "Select a Runtime before sending work…"}
          rows={2}
          disabled={connection !== "connected" || held}
        />
        <div className="composer-actions">
          <div className="composer-tools">
            <button className="composer-tool" type="button" aria-label="Attach context" title="Attach context">
              ⊕ <span>Context</span>
            </button>
            <span className="composer-hint">Draft stays with the campaign shown · sent to its active Attempt</span>
          </div>
          <button className="send-button" type="submit" aria-label="Send message" disabled={!canSubmit}>
            <span>{busy ? "Sending…" : "Send"}</span>
            <span className="send-arrow" aria-hidden="true">↗</span>
          </button>
        </div>
      </div>
      <div className="composer-footnote">
        <span><span className="lock-glyph" aria-hidden="true">⌑</span> Local Core projection</span>
        <span>Enter to send · Shift + Enter for a new line</span>
      </div>
    </form>
  );
}

interface BlockedWorkPanelProps {
  hold: StopResponsibilitySummary;
  onRecheck: (attemptId: string) => void;
  onContinue: (attemptId: string) => void;
  busy: boolean;
}

// The panel a user meets after Stop. Before this revision the GUI showed three
// state words and nothing else: what was blocked, which workspace, when, and what
// could be done about it all had no answer on screen.
function BlockedWorkPanel({ hold, onRecheck, onContinue, busy }: BlockedWorkPanelProps) {
  const governs = hold.blocksCurrentWorkspace !== false;
  const recheck = hold.latestRecheck ?? null;
  return (
    <section
      className={`rail-panel stop-responsibility-panel${governs ? "" : " related-hold-panel"}`}
      role="region"
      // The accessible name stays "Stop responsibility" for a governing hold. The
      // panel says more than it used to, but renaming the region would break both
      // the existing accessibility contract and the packaged-GUI driver that finds
      // it by name -- and the heading below already carries the better wording.
      aria-label={governs ? "Stop responsibility" : "Related hold"}
      data-attempt-id={hold.attemptId}
      data-governs={governs ? "true" : "false"}
    >
      <div className="rail-panel-heading compact-heading">
        <div className="rail-title-lockup">
          <span className="rail-icon rail-icon-amber" aria-hidden="true">■</span>
          <div>
            <p className="eyebrow">DURABLE CORE STATE</p>
            <h2>{governs ? "Blocked work" : "Related hold"}</h2>
          </div>
        </div>
      </div>

      {/* Which work, and where. */}
      <dl className="blocked-work-facts">
        <div><dt>Task</dt><dd className="blocked-task">{hold.taskTitle || "(untitled)"}</dd></div>
        <div><dt>Goal</dt><dd>{hold.campaignGoal || "(none recorded)"}</dd></div>
        <div><dt>Workspace</dt><dd className="blocked-workspace">{hold.workspaceKey || "(unrecorded)"}</dd></div>
        <div><dt>Interruption</dt><dd>
          operation {hold.operationId} · input {hold.inputUuid} · {hold.interruptedAt || "time unrecorded"}
        </dd></div>
      </dl>

      {/* The three independent states, unchanged. */}
      <div className="stop-state-grid">
        <strong>Native turn: {hold.nativeTurnState}</strong>
        <strong>Residual execution: {hold.residualExecutionState}</strong>
        <strong>Write responsibility: {hold.writeResponsibility}</strong>
      </div>

      <p className="blocked-reason">{hold.blockedReason || "Conflicting work remains blocked."}</p>
      <p>Unknown means Core has no proof that descendants or effects are quiescent. Conflicting work remains blocked.</p>

      {/* A re-check reports when it looked, not merely what it found. Without the
          timestamp the same three words read as if they were current. */}
      <div className="recheck-state">
        {recheck ? (
          <>
            <strong className="recheck-verdict">Last re-check: {recheck.verdict}</strong>
            <small>
              observed at {recheck.observedAt} · bound runtime {recheck.runtimeObservation} ·
              {" "}{recheck.activeLeaseCount} overlapping lease(s) · {recheck.pendingOutboxCount} pending outbox intent(s)
            </small>
            {recheck.verdict === "observation-unavailable" ? (
              <small className="recheck-unavailable">
                Nothing could be concluded. This is not evidence that anything stopped.
              </small>
            ) : null}
            {recheck.verdict === "bound-runtime-absent-residual-still-unknown" ? (
              <small className="recheck-unavailable">
                The bound runtime is gone. Its descendants were not observed, so residual execution stays unknown.
              </small>
            ) : null}
          </>
        ) : (
          <small>No re-check has been taken yet.</small>
        )}
      </div>

      {/* What can actually be done next. */}
      <div className="blocked-work-actions">
        <button
          className="button"
          type="button"
          aria-label="Re-check this hold"
          disabled={busy}
          onClick={() => onRecheck(hold.attemptId)}
        >
          Re-check now
        </button>
        <button
          className="button button-accent"
          type="button"
          aria-label="Continue in a new isolated workspace"
          disabled={busy || !recheck}
          onClick={() => onContinue(hold.attemptId)}
        >
          Continue in a new isolated workspace
        </button>
      </div>
      {!recheck ? (
        <small className="blocked-work-hint">Re-check first: continuing requires a current observation.</small>
      ) : null}

      {/* The disclosure. Pinned to content rather than to the word "isolated",
          because "isolated" is the part a reader will assume and the two sentences
          below are the part they will not. */}
      <details className="isolation-disclosure">
        <summary>What continuing elsewhere does and does not control</summary>
        <p className="disclosure-controlled">
          GoalPort will not admit a runtime, send, grant a permission Allow, hand off, resume,
          acquire or release a lease, or dispatch an outbox intent into any workspace that
          path-overlaps a held responsibility. A continuation gets a new native session, a new
          recorded identity, and a workspace key with no ancestor or descendant relationship to
          the held one.
        </p>
        <p className="disclosure-residual">
          GoalPort is not an OS sandbox. A residual process or descendant left over from the
          interrupted turn holds ordinary file-system rights and can write anywhere you can,
          including into the new workspace.
        </p>
        <p className="disclosure-not-evidence">
          Changing directory, database, session, provider or Core epoch is not evidence of
          isolation and does not release the original hold, which stays held.
        </p>
        <p className="disclosure-authorization">
          Continuing grants the new campaign three authorizations — provider, action and
          transfer — so it may send work, approve tool permissions, and hand off. The grant
          covers the new campaign only; this one is untouched.
        </p>
      </details>

      <small>Source: {hold.source} · Attempt {hold.attemptId} · Operation {hold.operationId}</small>
    </section>
  );
}

interface ContextRailProps {
  snapshot: CoreSnapshot;
  onPermissionDecision: (decisionId: string, allow: boolean) => void;
  onKeepWaiting: () => void;
  onReconnect: () => void;
  onOffline: () => void;
  onHandoff: () => void;
  onOpenInVsCode: () => void;
  onSelectRuntime: (provider: RuntimeProfile["id"]) => void;
  onRevoke: (scope: string) => void;
  onOwnerAction: (action: string) => void;
  onInterrupt: () => void;
  onRecheck: (attemptId: string) => void;
  onContinue: (attemptId: string) => void;
  recoveryBusy: boolean;
}

function ContextRail({ snapshot, onPermissionDecision, onKeepWaiting, onReconnect, onOffline, onHandoff, onOpenInVsCode, onSelectRuntime, onRevoke, onOwnerAction, onInterrupt, onRecheck, onContinue, recoveryBusy }: ContextRailProps) {
  const pendingDecisions = snapshot.decisions.filter((decision) => decision.state === "pending");
  const responsibilityHeld = snapshot.stopResponsibility?.writeResponsibility === "held";
  const ownStopRequested = responsibilityHeld && snapshot.stopResponsibility?.attemptId === snapshot.attempt.id;
  const stopDisabled = ownStopRequested || snapshot.attempt.state !== "active";
  const hasTask = Boolean(snapshot.activeCampaignId && snapshot.activeTask.id);
  const routable = attemptIsRoutable(snapshot);
  const attempt = attemptDisplay(snapshot);
  const syntheticScenario = scenarioIsActive(snapshot);
  return (
    <aside className="context-rail" aria-label="Runtime context">
      <div className="rail-scroll">
        <section className="rail-panel decision-panel" role="region" aria-label="Decision Inbox">
          <div className="rail-panel-heading">
            <div className="rail-title-lockup">
              <span className="rail-icon rail-icon-amber" aria-hidden="true">◆</span>
              <div>
                <p className="eyebrow">BLOCKING ONLY</p>
                <h2>Decision Inbox</h2>
              </div>
            </div>
            {pendingDecisions.length > 0 ? <span className="pending-count">{pendingDecisions.length}</span> : <span className="resolved-mark">✓</span>}
          </div>
          {pendingDecisions.length > 0 ? (
            pendingDecisions.map((decision) => (
              <div className="decision-request" key={decision.id} data-decision-id={decision.id}>
                <div className="decision-request-header">
                  <span className="decision-type">{decision.kind}</span>
                  <span className="decision-time">needs answer</span>
                </div>
                <h3>{decision.title}</h3>
                <ul className="fact-list">
                  {decision.facts.map((fact) => <li key={fact}>{fact}</li>)}
                </ul>
                <div className="recommendation">
                  <span className="recommendation-label">RECOMMENDED</span>
                  <p>{decision.recommendation}</p>
                </div>
                <p className="decision-default"><strong>If unanswered:</strong> {decision.defaultBehavior}</p>
                <div className="decision-actions">
                    <button className="button button-accent" type="button" onClick={() => onPermissionDecision(decision.id, true)} disabled={responsibilityHeld}>Allow once</button>
                    <button className="button button-danger" type="button" onClick={() => onPermissionDecision(decision.id, false)}>Decline permission</button>
                  <button className="button button-quiet" type="button" onClick={onKeepWaiting}>Keep waiting</button>
                </div>
              </div>
            ))
          ) : (
            <div className="empty-decision">
              <span className="empty-check" aria-hidden="true">✓</span>
              <p>No blocking decisions. Core will stop before an unsafe action.</p>
            </div>
          )}
        </section>

        <section className="rail-panel runtime-panel" aria-labelledby="runtime-support-title">
          <div className="rail-panel-heading">
            <div className="rail-title-lockup">
              <span className="rail-icon rail-icon-blue" aria-hidden="true">◈</span>
              <div>
                <p className="eyebrow">EXPLAINABLE ROUTING</p>
                <h2 id="runtime-support-title">Runtime support</h2>
              </div>
            </div>
            <button className="icon-button subtle" type="button" aria-label="Open runtime support details">···</button>
          </div>
          <p className="rail-caption">Assign the next role using observed capability and policy. A provider never becomes supported by being selected.</p>
          <div className="routing-mode-row">
            <span>Routing mode</span>
            <strong>Recommend</strong>
          </div>
          <div className="routing-modes" aria-label="Routing modes">
            <span>Manual</span>
            <span className="routing-mode-active">Recommend</span>
            <span className="routing-mode-disabled">Automatic · gated</span>
          </div>
          <div className="runtime-list">
            {snapshot.runtimes.map((runtime) => <RuntimeRow key={runtime.id} runtime={runtime} onSelect={onSelectRuntime} blocked={responsibilityHeld || !hasTask || snapshot.connection !== "connected"} />)}
          </div>
          <div className="routing-phrases" aria-label="Routing actions">
            <span>Assign next step to…</span>
            <span>Request independent audit from…</span>
            <span>Create fallback attempt with…</span>
          </div>
          <div className="decision-actions">
            <button className="button button-danger" type="button" onClick={() => onRevoke("action")}>Revoke action authorization</button>
            <button className="button button-quiet" type="button" onClick={() => onRevoke("provider")}>Revoke provider</button>
            <button className="button button-quiet" type="button" onClick={() => onRevoke("transfer")}>Revoke transfer</button>
          </div>
          <div className="decision-actions">
            <button className="button button-quiet" type="button" onClick={() => onOwnerAction("commit")}>Request commit</button>
            <button className="button button-quiet" type="button" onClick={() => onOwnerAction("push")}>Request push</button>
            <button className="button button-quiet" type="button" onClick={() => onOwnerAction("release")}>Request release</button>
            <button className="button button-quiet" type="button" onClick={() => onOwnerAction("delete")}>Request delete</button>
          </div>
        </section>

        <section className="rail-panel attempt-panel" aria-labelledby="attempt-context-title">
          <div className="rail-panel-heading compact-heading">
            <div className="rail-title-lockup">
              <span className="rail-icon rail-icon-violet" aria-hidden="true">◌</span>
              <div>
                <p className="eyebrow">CURRENT RESPONSIBILITY</p>
                <h2 id="attempt-context-title">{routable ? "Active Attempt" : "Runtime Attempt"}</h2>
              </div>
            </div>
            <span className="active-state-dot" style={{ opacity: routable ? 1 : 0.35 }} aria-label={routable ? "Active" : attempt.detail} />
          </div>
          <div className="attempt-detail-card">
            <div className="attempt-detail-header">
              <span className={`provider-avatar provider-${snapshot.attempt.provider.toLowerCase()}`}>{attempt.glyph}</span>
              <div>
                <strong>{attempt.label}</strong>
                <span>{attempt.detail}</span>
                {syntheticScenario ? <span>{presentedSessionLabel(snapshot)}</span> : null}
              </div>
              <span className="attempt-event-count">{snapshot.attempt.eventCount} events</span>
            </div>
            {routable ? <div className="attempt-meter"><span style={{ width: `${Math.min(92, 24 + snapshot.attempt.eventCount * 2)}%` }} /></div> : null}
            <p>{routable
              ? "Long-running work remains Core-owned while this window is closed. Session identity stays in diagnostic detail."
              : attempt.uncertain
                ? "Core could not bind this view to a trustworthy Runtime identity. Sending stays blocked until you select a Runtime."
                : "Select a Runtime explicitly. Creating a campaign does not send its goal as a prompt."}</p>
          </div>
          <div className="rail-actions">
            <button className="rail-action" type="button" onClick={onOpenInVsCode} disabled={!snapshot.project.workspaceRoot}><span aria-hidden="true">↗</span> Open in VS Code</button>
            <button className="rail-action" type="button" onClick={onHandoff} disabled={responsibilityHeld || !routable}><span aria-hidden="true">⇄</span> Assign next step</button>
            <button className="rail-action rail-action-danger" type="button" onClick={onInterrupt} disabled={stopDisabled}><span aria-hidden="true">■</span> {ownStopRequested ? "Stop already requested" : stopDisabled ? "No active turn" : syntheticScenario ? "Stop synthetic Scenario turn" : "Stop native turn"}</button>
          </div>
        </section>

        {snapshot.stopResponsibility ? (
          <BlockedWorkPanel
            hold={snapshot.stopResponsibility}
            onRecheck={onRecheck}
            onContinue={onContinue}
            busy={recoveryBusy}
          />
        ) : null}

        {/* Holds that do not govern this workspace. After a continuation the user is
            standing in the new workspace, where the governing hold is absent -- this
            is the only place the source hold is still visible, and it is exactly
            when they need it. */}
        {snapshot.relatedHolds.map((hold) => (
          <BlockedWorkPanel
            key={hold.attemptId}
            hold={hold}
            onRecheck={onRecheck}
            onContinue={onContinue}
            busy={recoveryBusy}
          />
        ))}

        <section className="rail-panel evidence-panel" aria-labelledby="evidence-state-title">
          <div className="rail-panel-heading compact-heading">
            <div className="rail-title-lockup">
              <span className="rail-icon rail-icon-green" aria-hidden="true">✓</span>
              <div>
                <p className="eyebrow">CLAIM · EVIDENCE · VERDICT</p>
                <h2 id="evidence-state-title">Evidence state</h2>
              </div>
            </div>
            <span className="evidence-count">{snapshot.evidence.length}</span>
          </div>
          <div className="evidence-list">
            {snapshot.evidence.map((evidence) => (
              <div className="evidence-row" key={evidence.id}>
                <EvidenceBadge state={evidence.state} />
                <div>
                  <strong>{evidence.claim}</strong>
                  <span>{evidence.source}</span>
                </div>
              </div>
            ))}
          </div>
          <p className="stale-note"><span aria-hidden="true">!</span> External edits make related evidence stale; they are never attributed to an Agent automatically.</p>
        </section>

        <section className="rail-panel boundary-panel" aria-labelledby="boundary-title">
          <div className="boundary-topline"><span className="preview-ribbon">{snapshot.preview ? "SYNTHETIC" : "RC"}</span><span>V1 boundary</span></div>
          <h2 id="boundary-title">You stay in control of the edges.</h2>
          <ul>
            <li>Core reconnect is available; session attachment remains capability-gated.</li>
            <li>Grok runs over native ACP stdio; permissions stay Runtime-owned.</li>
            <li>Native plugins, skills, hooks and MCP remain Runtime-owned.</li>
            <li>At a narrow window width, rails collapse while the conversation stays usable.</li>
          </ul>
          <button className="text-link" type="button" onClick={onOffline}>Test offline boundary <span aria-hidden="true">→</span></button>
        </section>
      </div>
    </aside>
  );
}

function RuntimeRow({ runtime, onSelect, blocked }: { runtime: RuntimeProfile; onSelect: (provider: RuntimeProfile["id"]) => void; blocked: boolean }) {
  return (
    <details className={`runtime-row runtime-${runtime.support}`}>
      <summary>
        <span className={`provider-avatar provider-${runtime.id}`}>{runtime.name[0]}</span>
        <span className="runtime-copy"><strong>{runtime.name}</strong><small>{runtime.subtitle}</small></span>
        <span className={`support-chip support-${runtime.support}`}>{runtime.id === "scenario" ? "Synthetic" : runtime.support === "partial" ? "Preview" : runtime.support}</span>
        <span className="runtime-chevron" aria-hidden="true">⌄</span>
      </summary>
      <div className="runtime-reasons">
        <div className="runtime-role"><span>Next role</span><strong>{runtime.mode}</strong></div>
        <span className="runtime-version">{runtime.version}</span>
        <ul>{runtime.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
        <div className="capability-grid">
          {Object.entries(runtime.capabilities).map(([capability, state]) => (
            <span key={capability}><small>{capability}</small><EvidenceBadge state={state} /></span>
          ))}
        </div>
        <button className="button button-small button-outline" type="button" onClick={() => onSelect(runtime.id)} disabled={runtime.support === "unsupported" || blocked}>
          Select {runtime.name}
        </button>
      </div>
    </details>
  );
}

function FooterBar({ snapshot, appInfo, activeNotice, onDismissNotice }: { snapshot: CoreSnapshot; appInfo: AppInfo | null; activeNotice: string | null; onDismissNotice: () => void }) {
  return (
    <footer className="footerbar">
      <div className="footer-status">
        <span className={`footer-dot footer-dot-${snapshot.connection}`} aria-hidden="true" />
        <strong>{connectionLabel(snapshot)}</strong>
        <span className="footer-divider">·</span>
        <span>{snapshot.attempt.eventCount} committed events</span>
        <span className="footer-divider">·</span>
        <span className="footer-secure"><span aria-hidden="true">⌑</span> Local workspace</span>
      </div>
      <div className="footer-message">
        {activeNotice ? <><span>{activeNotice}</span><button type="button" aria-label="Dismiss notification" onClick={onDismissNotice}>×</button></> : <span>Core owns continuity · UI owns presentation</span>}
      </div>
      <div className="footer-build" title={appInfo?.dataPath ? `Data: ${appInfo.dataPath}` : undefined}>
        {channelLabel(appInfo, snapshot.preview)} · {snapshot.protocolVersion} · {snapshot.buildId}
      </div>
    </footer>
  );
}

interface FirstRunDialogProps {
  workspace: string;
  goal: string;
  preview: boolean;
  busy: boolean;
  error: string | null;
  canBrowse: boolean;
  onWorkspaceChange: (value: string) => void;
  onGoalChange: (value: string) => void;
  onBrowse: () => void;
  onCancel: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

interface CloseChoiceDialogProps {
  provider: string;
  active: boolean;
  stopResponsibility: StopResponsibilitySummary | null;
  onContinue: () => void;
  onStop: () => void;
  onKeepOpen: () => void;
}

function CloseChoiceDialog({ provider, active, stopResponsibility, onContinue, onStop, onKeepOpen }: CloseChoiceDialogProps) {
  const targetProvider = active ? provider : stopResponsibility?.provider || provider;
  const isClaude = targetProvider.toLowerCase() === "claude";
  const isScenario = targetProvider.toLowerCase() === "scenario";
  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="first-run-dialog close-choice-dialog" role="dialog" aria-modal="true" aria-label="Continue running in the background?">
        <p className="eyebrow">WINDOW CLOSE</p>
        <h2>Continue running in the background?</h2>
        <p className="dialog-lead">
          {stopResponsibility
            ? "Residual execution remains unknown. Core keeps write responsibility held. Continue closes only this window and starts no new work; Stop waits for the durable Core response before quit acknowledgement."
            : isClaude
              ? "Stop requests interruption of the current native Claude turn. Started tools may keep running; Core records residual responsibility before closing. Continue closes this window and starts no new work."
              : isScenario
                ? "This is a synthetic Scenario turn. Stop records the synthetic Attempt transition; no native provider process is implied. Continue closes only this window and starts no new work."
              : "Long-running work remains Core-owned while this window is closed. Continue leaves Core and the authorized Runtime running. Stop asks Core to end the active Attempt, then quits this window."}
        </p>
        <div className="dialog-actions">
          <button className="button button-quiet" type="button" onClick={onKeepOpen}>Keep window open</button>
          <button className="button button-danger" type="button" onClick={onStop}>{isClaude ? "Stop Claude turn and quit" : isScenario ? "Stop synthetic Scenario and quit" : "Stop background work and quit"}</button>
          <button className="button button-primary" type="button" onClick={onContinue}>Continue in background</button>
        </div>
      </section>
    </div>
  );
}

function FirstRunDialog({ workspace, goal, preview, busy, error, canBrowse, onWorkspaceChange, onGoalChange, onBrowse, onCancel, onSubmit }: FirstRunDialogProps) {
  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="first-run-dialog" role="dialog" aria-modal="true" aria-label="Start your first campaign">
        <button className="dialog-close" type="button" aria-label="Close first-run setup" onClick={onCancel} disabled={busy}>×</button>
        <div className="dialog-mark" aria-hidden="true"><span>GP</span></div>
        <p className="eyebrow">{preview ? "SYNTHETIC BROWSER PREVIEW" : "LOCAL RC SETUP"}</p>
        <h2>Create a campaign</h2>
        <p className="dialog-lead">Give GoalPort a workspace and a durable goal. You can customize routing and working style before a Runtime receives work.</p>
        <form onSubmit={onSubmit}>
          <label className="field-label" htmlFor="project-folder">Project folder</label>
          <div className="field-with-icon">
            <span aria-hidden="true">⌂</span>
            <input id="project-folder" aria-label="Project folder" value={workspace} onChange={(event) => onWorkspaceChange(event.target.value)} placeholder="C:\\workspace\\your-project" required disabled={busy} />
            {canBrowse ? <button className="button button-small button-outline" type="button" onClick={onBrowse} disabled={busy}>Browse…</button> : null}
          </div>
          <label className="field-label" htmlFor="campaign-goal">Campaign goal</label>
          <textarea id="campaign-goal" aria-label="Campaign goal" value={goal} onChange={(event) => onGoalChange(event.target.value)} placeholder="What should this campaign accomplish?" rows={3} required disabled={busy} />
          {error ? <div className="dialog-note" role="alert"><span aria-hidden="true">!</span><span>{error}</span></div> : (
            <div className="dialog-note"><span aria-hidden="true">ⓘ</span><span>{preview
              ? "This browser-only Scenario is synthetic. No native Runtime receives work."
              : "Core saves the campaign locally. No Runtime receives work until you select one and send a message."}</span></div>
          )}
          <div className="dialog-actions">
            <button className="button button-quiet" type="button" onClick={onCancel} disabled={busy}>Cancel</button>
            <button className="button button-primary" type="submit" disabled={busy}>{busy ? "Creating…" : preview ? "Begin preview" : "Create campaign"} <span aria-hidden="true">↗</span></button>
          </div>
        </form>
      </section>
    </div>
  );
}

function shortPath(path: string): string {
  if (path.length <= 29) return path;
  return `…${path.slice(-26)}`;
}

export default App;
