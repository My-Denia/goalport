// Pure presentation helpers shared by App and the split components.
// Moved verbatim (or near-verbatim) from the pre-split App.tsx; behavior is
// unchanged. No state, no IPC.
import { persistedAttemptId, type AppInfo } from "../ipc";
import type {
  CoreSnapshot,
  ProductConversation,
  ProductRuntimeSelection,
  TimelineItem
} from "../types";

export const EVIDENCE_LABEL: Record<string, string> = {
  verified: "Verified",
  "needs-review": "Needs review",
  stale: "Stale",
  unavailable: "Unavailable",
  unsupported: "Unsupported"
};

export function attemptIsRoutable(snapshot: CoreSnapshot): boolean {
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

export function attemptDisplay(snapshot: CoreSnapshot): { label: string; detail: string; glyph: string; uncertain: boolean } {
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

export function scenarioIsActive(snapshot: CoreSnapshot): boolean {
  return snapshot.attempt.provider.trim().toLowerCase() === "scenario";
}

/**
 * Honest short support status for normal UI. Derived only from the capability
 * evidence Core already reported — no historical upgrade. "Preview" was the old
 * skin over the partial-admission label; "Limited" says what the user can
 * actually expect from it.
 */
export function supportStatusLabel(runtime: { id: string; support: string }): string {
  if (runtime.id === "scenario") return "Synthetic";
  if (runtime.support === "supported") return "Available";
  if (runtime.support === "partial") return "Limited";
  return "Unavailable";
}

export function presentedTimelineItem(item: TimelineItem, syntheticScenario: boolean): TimelineItem {
  if (!syntheticScenario || !/native runtime/i.test(item.actor)) return item;
  return { ...item, actor: item.actor.replace(/native runtime/gi, "Synthetic Scenario Runtime") };
}

export function presentedSessionLabel(snapshot: CoreSnapshot): string {
  const label = snapshot.attempt.sessionLabel.trim();
  if (!scenarioIsActive(snapshot)) return label;
  const synthetic = label
    .replace(/native runtime/gi, "Synthetic Scenario Runtime")
    .replace(/native session/gi, "synthetic session");
  return `Synthetic Scenario · ${synthetic || "synthetic session"}`;
}

export function connectionLabel(snapshot: CoreSnapshot): string {
  if (snapshot.connection === "connected") return "Core connected";
  if (snapshot.connection === "reconnecting") return "Reconnecting";
  if (snapshot.connection === "degraded") return "Core degraded";
  return "Core disconnected";
}

// ---------------------------------------------------------------------------
// Product-conversation presentation (product-interaction-reset).
// The normal UI's state vocabulary comes from the product turn model — never
// from `Attempt.active`.
// ---------------------------------------------------------------------------

export interface HeadlineState {
  label: string;
  tone: "in-progress" | "complete" | "waiting" | "blocked";
}

/**
 * Ready / Working / Needs approval / Stopping / Stopped / Blocked /
 * Disconnected / Error — derived from the product turn (and connection/hold
 * facts that gate it), never from Attempt.active.
 */
export function headlineState(
  product: ProductConversation | null,
  snapshot: CoreSnapshot
): HeadlineState {
  if (snapshot.connection !== "connected") return { label: "Disconnected", tone: "blocked" };
  if (snapshot.stopResponsibility?.writeResponsibility === "held") return { label: "Blocked", tone: "blocked" };
  const turn = product?.turn;
  if (!turn) return { label: "Unavailable", tone: "blocked" };
  switch (turn.state) {
    case "running":
    case "starting":
      return { label: "Working", tone: "in-progress" };
    case "waiting-permission":
      return { label: "Needs approval", tone: "waiting" };
    case "stopping":
      return { label: "Stopping", tone: "waiting" };
    case "stopped":
      return { label: "Stopped", tone: "complete" };
    case "failed":
      return { label: "Error", tone: "blocked" };
    case "uncertain":
      return { label: "Blocked", tone: "blocked" };
    case "completed":
      return { label: turn.canSend ? "Ready" : "Completed", tone: "complete" };
    case "idle":
    default:
      if (product?.runtime.state === "none") return { label: "Waiting for Runtime", tone: "waiting" };
      return turn.canSend
        ? { label: "Ready", tone: "complete" }
        : { label: "Blocked", tone: "blocked" };
  }
}

/** Honest chip for the composer's Runtime chooser, from the product selection. */
export function runtimeSelectionDisplay(runtime: ProductRuntimeSelection): { label: string; detail: string; glyph: string } {
  if (runtime.state === "none" || !runtime.provider) {
    return { label: "Choose a Runtime", detail: "required before sending", glyph: "–" };
  }
  const name = runtime.name || runtime.provider;
  return {
    label: name,
    detail: runtime.state === "selected" ? "selected" : "selected · reconnecting to use",
    glyph: name[0]?.toUpperCase() ?? "–"
  };
}

/**
 * Format a durable timestamp for the normal UI. Raw epoch numbers are never
 * displayed; ISO stamps are localized; anything else (already-formatted
 * preview labels) passes through.
 */
export function formatTimestamp(value: string | undefined | null): string {
  const trimmed = value?.trim();
  if (!trimmed) return "";
  if (/^\d{10,}$/.test(trimmed)) {
    const numeric = Number(trimmed);
    const date = new Date(trimmed.length >= 13 ? numeric : numeric * 1000);
    if (!Number.isNaN(date.getTime())) return date.toLocaleString();
  }
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:/.test(trimmed)) {
    const date = new Date(trimmed);
    if (!Number.isNaN(date.getTime())) return date.toLocaleString();
  }
  return trimmed;
}

/** The conversation title for the sidebar: product title first, campaign title as fallback. */
export function conversationTitle(snapshot: CoreSnapshot): string {
  const product = snapshot.productConversation;
  if (product?.title) return product.title;
  const campaign = snapshot.campaigns.find((candidate) => candidate.id === snapshot.activeCampaignId);
  return campaign?.title ?? snapshot.activeTask.title;
}

export function channelLabel(appInfo: AppInfo | null, preview: boolean): string {
  const channel = appInfo?.channel.trim() || (preview ? "preview" : "rc");
  const version = appInfo?.version.trim();
  return `${channel.toUpperCase()}${version ? ` ${version}` : ""}${appInfo?.testMode ? " · TEST" : ""}`;
}

export function isUserMessage(item: TimelineItem): boolean {
  // Raw journal kind is authoritative when Core provides it; the actor fallback
  // covers the browser preview and older Cores.
  if (item.eventKind) return item.eventKind === "message.user";
  return item.kind === "message" && /^user$/i.test(item.actor.trim());
}

export function shortPath(path: string): string {
  if (path.length <= 29) return path;
  return `…${path.slice(-26)}`;
}
