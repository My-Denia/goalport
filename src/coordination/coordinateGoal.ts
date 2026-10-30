import { authorizeCoordinateWriteTurn, authorizeCoordinateTurn, type CoordinateTurnCommand } from "./coordinateTurn";
import type { SavedTargetContinuation } from "./continuation";
import { selectedPiEligible, type PiCapacitySelection, type PiCapacityMetadata } from "../../electron/pi-capacity.mjs";

export const MAX_CONTINUATION_PROMPT_BYTES = 100_000;
export const MAX_CONTINUATION_CHARS = 100_000;

export class ContinuationPromptLimitError extends Error {
  constructor() { super("The assembled continuation prompt exceeded the 100,000-byte limit."); }
}

/** Check the actual full prompt, including text returned by earlier roles. */
export function assertContinuationPrompt(input: CoordinateGoalInput, text: string): void {
  if (input.continuation && utf8Bytes(text) > MAX_CONTINUATION_PROMPT_BYTES) {
    throw new ContinuationPromptLimitError();
  }
}

/**
 * Caller-supplied catalog entry. Quota is a word from this object.
 * This slice does not schedule T3 Limits and does not call a provider.
 */
export type SyntheticQuota =
  | "UNKNOWN"
  | "unknown"
  | "available"
  | "AVAILABLE"
  | "exhausted"
  | "EXHAUSTED"
  | { readonly state?: string; readonly remaining?: number };

export interface UntrackedFileSnapshot {
  readonly path: string;
  readonly size?: number;
  readonly content?: string | null;
  readonly binary?: boolean;
  readonly skipped?: "symlink" | "symlink-in-path" | "outside-target" | "special-file" | "read-error" | "file-limit" | "changed-during-read" | "nofollow-unsupported" | null;
  readonly truncated?: boolean;
}

export interface ComparisonBaseline {
  readonly headCommit: string | null;
  readonly capturedAt: string;
}

export interface ExecutionWorkspaceEvidence {
  readonly status: "available" | "unavailable" | "incomplete";
  readonly complete: boolean;
  readonly changed: boolean | null;
  readonly beforeDiff: string | null;
  readonly afterDiff: string | null;
  readonly beforeUntrackedFiles?: readonly UntrackedFileSnapshot[];
  readonly untrackedFiles?: readonly UntrackedFileSnapshot[];
  readonly beforeUntrackedFilesOmitted?: number;
  readonly untrackedFilesOmitted?: number;
  readonly comparisonBaseline?: ComparisonBaseline | null;
  readonly reason?: string | null;
  readonly timedOutObservation?: boolean;
  readonly truncated?: boolean;
  readonly label?: string;
}

export interface AuditInputEvidenceCoverage {
  /** Bytes in the complete serialized capture, including BEFORE/AFTER and file text. */
  readonly totalEvidenceBytes: number;
  /** Original serialized capture bytes delivered, excluding transport crop notices. */
  readonly includedEvidenceBytes: number;
  readonly cropped: boolean;
  /** Actual UTF-8 bytes of the COMPLETE assembled audit prompt. */
  readonly promptBytes: number;
  readonly promptBudgetBytes?: number;
  /** Descriptive only; the runtime independently guards the command selector. */
  readonly promptDelivery?: "stdin" | "argv";
  readonly windowsCmdWorstCaseChars?: number;
  readonly croppedSections?: readonly string[];
}

// cmd.exe can expand one prompt character into several escaped characters.
// UTF-8 bytes are a conservative upper bound for UTF-16 code units, and 6x
// covers the existing quote/backslash/metacharacter escaping. The remaining
// reserve covers the executable and fixed audit argv on the supported route.
export const MAX_AUDIT_PROMPT_BYTES = 4096;
export const AUDIT_EVIDENCE_RESERVE_BYTES = 2048;
export const LINUX_PI_AUDIT_PROMPT_BYTES = 32768;
export const LINUX_PI_AUDIT_EVIDENCE_RESERVE_BYTES = 16384;
export const WINDOWS_CMD_ESCAPE_FACTOR = 6;
export const WINDOWS_CMD_LAUNCH_RESERVE_CHARS = 4096;
export const WINDOWS_CMD_MAX_CHARS = 32767;
export const MAX_AUDIT_WINDOWS_CMD_CHARS =
  MAX_AUDIT_PROMPT_BYTES * WINDOWS_CMD_ESCAPE_FACTOR + WINDOWS_CMD_LAUNCH_RESERVE_CHARS;

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

function utf8Bytes(text: string): number {
  return utf8Encoder.encode(text).length;
}

export function windowsCmdWorstCaseChars(text: string): number {
  return utf8Bytes(text) * WINDOWS_CMD_ESCAPE_FACTOR + WINDOWS_CMD_LAUNCH_RESERVE_CHARS;
}

export function truncateUtf8Bytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = utf8Encoder.encode(text);
  if (bytes.length <= maxBytes) return { text, truncated: false };
  let end = Math.max(0, maxBytes);
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return { text: utf8Decoder.decode(bytes.subarray(0, end)), truncated: true };
}

interface TransportCrop {
  readonly text: string;
  readonly cropped: boolean;
  readonly includedBytes: number;
  readonly totalBytes: number;
}

function cropForTransport(text: string, budgetBytes: number, label: string, retained = false): TransportCrop {
  const totalBytes = utf8Bytes(text);
  if (totalBytes <= budgetBytes) return { text, cropped: false, includedBytes: totalBytes, totalBytes };
  const suffix = retained ? " Full capture retained in GoalPort record." : "";
  const noticeFor = (included: number) =>
    `\n[${label} cropped for transport: showing first ${included} bytes of ${totalBytes} bytes.${suffix}]`;
  let contentBudget = Math.max(0, budgetBytes - utf8Bytes(noticeFor(Math.min(totalBytes, budgetBytes))));
  let { text: content } = truncateUtf8Bytes(text, contentBudget);
  let includedBytes = utf8Bytes(content);
  let fitted = `${content}${noticeFor(includedBytes)}`;
  while (utf8Bytes(fitted) > budgetBytes && contentBudget > 0) {
    contentBudget -= 1;
    content = truncateUtf8Bytes(text, contentBudget).text;
    includedBytes = utf8Bytes(content);
    fitted = `${content}${noticeFor(includedBytes)}`;
  }
  if (utf8Bytes(fitted) > budgetBytes) {
    fitted = truncateUtf8Bytes(`[${label} cropped for transport.${suffix}]`, budgetBytes).text;
    includedBytes = 0;
  }
  return { text: fitted, cropped: true, includedBytes, totalBytes };
}

function fitSections(
  sections: readonly { readonly label: string; readonly text: string }[],
  budgetBytes: number,
  retained = false,
): { text: string; croppedSections: string[]; includedBytes: number; totalBytes: number } {
  const fullText = sections.map((section) => section.text).join("\n");
  const totalBytes = utf8Bytes(fullText);
  if (totalBytes <= budgetBytes) {
    return { text: fullText, croppedSections: [], includedBytes: totalBytes, totalBytes };
  }
  let remaining = Math.max(0, budgetBytes);
  const delivered: string[] = [];
  const croppedSections: string[] = [];
  let includedBytes = 0;
  sections.forEach((section, index) => {
    const share = Math.floor(remaining / (sections.length - index));
    const crop = cropForTransport(section.text, share, section.label, retained);
    if (crop.cropped) croppedSections.push(section.label);
    delivered.push(crop.text);
    includedBytes += crop.includedBytes;
    const separatorBytes = index < sections.length - 1 ? 1 : 0;
    remaining = Math.max(0, remaining - utf8Bytes(crop.text) - separatorBytes);
  });
  return {
    text: delivered.join("\n"),
    croppedSections,
    includedBytes: includedBytes + Math.max(0, sections.length - 1),
    totalBytes,
  };
}

function formatUntrackedForAudit(files: readonly UntrackedFileSnapshot[] | undefined, omitted = 0): string {
  if ((!files || files.length === 0) && omitted === 0) return "(none observed)";
  const lines = (files ?? []).map((file) => {
    const metadata = `  ${file.path} (${file.skipped ? `skipped: ${file.skipped}` : file.binary ? `binary, ${file.size ?? "unknown"} bytes; content not captured` : `${file.size ?? 0} bytes${file.truncated ? ", capture truncated" : ""}`})`;
    return typeof file.content === "string" && !file.skipped && !file.binary
      ? `${metadata}\n  Captured text content:\n${file.content}`
      : metadata;
  });
  if (omitted > 0) lines.push(`  (${omitted} additional paths omitted by the capture file limit)`);
  return lines.join("\n");
}

export function formatEvidenceForAudit(
  evidence: ExecutionWorkspaceEvidence | null | undefined,
  budgetBytes: number,
): { text: string; coverage: AuditInputEvidenceCoverage } {
  if (!evidence) {
    const text = "Captured workspace evidence: (none available - not captured)";
    return {
      text,
      coverage: { totalEvidenceBytes: 0, includedEvidenceBytes: 0, cropped: false, promptBytes: utf8Bytes(text) },
    };
  }
  const header = [
    "Captured workspace evidence (independently captured Git observation):",
    `Observation status: ${evidence.status}; complete: ${evidence.complete}`,
    `Changes detected: ${evidence.changed === true ? "yes" : evidence.changed === false ? "none" : "unknown / unconfirmed"}`,
    `Baseline HEAD: ${evidence.comparisonBaseline?.headCommit ?? "unknown"}`,
    evidence.reason ? `Observation note: ${evidence.reason}` : null,
  ].filter((line): line is string => line !== null).join("\n");
  const sections = [
    { label: "Workspace evidence header", text: header },
    { label: "Workspace AFTER tracked diff", text: `Captured AFTER tracked diff:\n${evidence.afterDiff ?? "(not captured)"}` },
    { label: "Workspace AFTER untracked files", text: `Captured AFTER untracked files:\n${formatUntrackedForAudit(evidence.untrackedFiles, evidence.untrackedFilesOmitted)}` },
    { label: "Workspace BEFORE tracked diff", text: `Captured BEFORE tracked diff:\n${evidence.beforeDiff ?? "(not captured)"}` },
    { label: "Workspace BEFORE untracked files", text: `Captured BEFORE untracked files:\n${evidence.beforeUntrackedFiles ? formatUntrackedForAudit(evidence.beforeUntrackedFiles, evidence.beforeUntrackedFilesOmitted) : "(not retained in this record)"}` },
  ];
  const fitted = fitSections(sections, budgetBytes, true);
  return {
    text: fitted.text,
    coverage: {
      totalEvidenceBytes: fitted.totalBytes,
      includedEvidenceBytes: Math.min(fitted.totalBytes, fitted.includedBytes),
      cropped: fitted.croppedSections.length > 0,
      promptBytes: utf8Bytes(fitted.text),
      croppedSections: fitted.croppedSections,
    },
  };
}

export interface SyntheticCatalogInstance {
  readonly instanceId: string;
  readonly name: string;
  readonly piCapacity?: PiCapacityMetadata;
  readonly piCredentialKind?: string;
  readonly defaultModel?: string;
  readonly models?: readonly (string | CatalogModel)[];
  readonly overageWindowIds?: readonly string[];
  readonly enabled?: boolean;
  readonly installed?: boolean;
  readonly authenticated?: boolean;
  readonly launchable?: boolean;
  readonly quota?: SyntheticQuota;
  readonly billing?: "subscription" | "paid-api" | "included" | "unknown";
  /**
   * Persisted evidence that this harness's tools cannot run on this machine
   * (harness health, stamped at the failure). Present means blocked exactly
   * like an avoidInstances entry; null means a malformed record degraded to
   * "no evidence" and the harness stays selectable.
   */
  readonly environmentAvoided?: { readonly since: string; readonly detail: string } | null;
}

/** Snapshot of explicit M6 scope.write consent, NOT a shape-gate verdict.
 * The transport must still reserve against the live scope generation. */
export interface CoordinationWriteAuthorization {
  readonly instances: readonly string[];
  readonly workspaceRoot: string;
  readonly remaining: number | null;
}

export interface ExecutionFeedback {
  /** Evidence from the completed round whose independent audit requested repair. */
  readonly previousPlan: string | null;
  readonly previousPlanReview: string | null;
  readonly previousExecutionReport: string | null;
  readonly previousExecutionAudit: string | null;
  /** Historical command IDs are references only; they must never be resubmitted. */
  readonly previousCommandIds: readonly string[];
}

export interface CoordinateGoalInput {
  readonly catalog: readonly SyntheticCatalogInstance[];
  readonly piCapacity?: PiCapacitySelection;
  /** Server-derived existing-parent context only, never renderer/admission authority. */
  readonly legacyPiContinuation?: boolean;
  /** In-memory worker capability; never an admission, grant, or UI setting. */
  readonly auditPromptTransport?: "linux-pi-stdin";
  readonly writeAuthorization?: CoordinationWriteAuthorization;
  readonly goal: string;
  readonly workspacePath: string;
  /**
   * Identity of the user send this round belongs to. Two sends of the same
   * goal text are different rounds; hashing only the prompt made the second
   * send replay the first round's stored result.
   */
  readonly sendKey: string;
  readonly priorPlan?: string | null;
  readonly priorReview?: string | null;
  /**
   * Optional continuation descriptor for continuing an existing saved target.
   * Describes origin (parent, root, original goal, follow-up), never grants,
   * scope, remaining budget, or native session handles.
   */
  readonly continuation?: SavedTargetContinuation;
  /** Completed execution/audit feedback for the one bounded corrective pass. */
  readonly executionFeedback?: ExecutionFeedback | null;
  /**
   * Instance ids that must not receive a role this round, set when a turn on
   * that harness proved it cannot run its tools on this machine. Draft-only:
   * it is never persisted as harness health, so a fixed machine stops being
   * avoided on the next fresh send.
   */
  readonly avoidInstances?: readonly string[];
  /**
   * When present, only these instance ids may take a role this round. A
   * scoped recovery round passes its authorized scope here; usability,
   * avoidance, health blocking, and the two-harness requirement all apply
   * within it.
   */
  readonly allowedInstances?: readonly string[];
}

/** Exclusions applied on top of the base catalog filters. */
export interface EligibilityFilter {
  readonly piCapacity?: PiCapacitySelection;
  readonly legacyPiContinuation?: boolean;
  /** Instance ids that may not receive a role (failed turns, roles already assigned). */
  readonly exclude?: readonly string[];
  /** Draft avoidance (Send again without X) — blocked like persisted health. */
  readonly avoidInstances?: readonly string[];
  /** Scoped round membership — when present, only these may take a role. */
  readonly allowedInstances?: readonly string[];
}

export interface CatalogModel {
  readonly slug: string;
  readonly name?: string;
  readonly isDefault?: boolean;
  readonly legacy?: boolean;
}

export type QuotaWord = "unknown" | "available" | "exhausted";

export interface CoordinateGoalState {
  readonly planningHarness: string | null;
  readonly reviewHarness: string | null;
  readonly result: string | null;
  readonly stopReason: string;
  readonly planningQuota: QuotaWord | null;
  readonly reviewQuota: QuotaWord | null;
  readonly roles: readonly ["planning", "review"] | readonly ["planning", "review", "execution", "audit"] | readonly [];
  readonly commands: readonly CoordinateTurnCommand[];
  readonly quotaLabels: Readonly<Record<string, QuotaWord>>;
}

function quotaWord(quota: SyntheticQuota | undefined): QuotaWord {
  if (quota === undefined) return "unknown";
  if (typeof quota === "object") {
    const state = typeof quota.state === "string" ? quota.state.toLowerCase() : "";
    if (state === "exhausted") return "exhausted";
    if (state === "available") return "available";
    return "unknown";
  }
  switch (quota) {
    case "UNKNOWN":
    case "unknown":
      return "unknown";
    case "exhausted":
    case "EXHAUSTED":
      return "exhausted";
    case "available":
    case "AVAILABLE":
      return "available";
    default: {
      const unreachable: never = quota;
      return unreachable;
    }
  }
}

interface ModelChoice {
  readonly slug: string;
  readonly name: string;
  readonly isDefault: boolean;
  readonly legacy: boolean;
}

function modelChoices(instance: SyntheticCatalogInstance): ModelChoice[] {
  const parsed = (instance.models ?? []).flatMap((item): ModelChoice[] => {
    if (typeof item === "string") {
      const slug = item.trim();
      if (slug.length === 0) return [];
      return [{ slug, name: slug, isDefault: slug === instance.defaultModel, legacy: false }];
    }
    const slug = item.slug.trim();
    if (slug.length === 0) return [];
    return [{
      slug,
      name: item.name?.trim() || slug,
      isDefault: item.isDefault === true || slug === instance.defaultModel,
      legacy: item.legacy === true,
    }];
  });
  if (parsed.length === 0 && typeof instance.defaultModel === "string" && instance.defaultModel.trim().length > 0) {
    const slug = instance.defaultModel.trim();
    return [{ slug, name: slug, isDefault: true, legacy: false }];
  }
  return parsed;
}

/**
 * T3 bfec2387 names Fable as the overage-included model bucket. A live turn
 * confirmed that bucket's published default requires usage credits. Account
 * quota "available" does not make that model eligible.
 */
function creditGated(choice: ModelChoice, instance: SyntheticCatalogInstance): boolean {
  if (/fable/i.test(choice.slug) || /fable/i.test(choice.name)) return true;
  const tokens = (instance.overageWindowIds ?? [])
    .filter((id) => id.startsWith("seven_day_") && id !== "seven_day")
    .map((id) => id.slice("seven_day_".length).replace(/_/g, "").toLowerCase())
    .filter((token) => token.length > 2);
  const haystack = `${choice.slug} ${choice.name}`.toLowerCase().replace(/[^a-z0-9]/g, "");
  return tokens.some((token) => haystack.includes(token));
}

function publishedModel(instance: SyntheticCatalogInstance): string {
  const eligible = modelChoices(instance).filter((choice) => !choice.legacy && !creditGated(choice, instance));
  return (eligible.find((choice) => choice.isDefault) ?? eligible[0])?.slug ?? "";
}

function creditsBlocked(instance: SyntheticCatalogInstance): boolean {
  const current = modelChoices(instance).filter((choice) => !choice.legacy);
  return current.length > 0 && current.every((choice) => creditGated(choice, instance));
}

function harnessLabel(instance: SyntheticCatalogInstance): string {
  const name = instance.name.trim();
  return name.length > 0 ? name : instance.instanceId;
}

function modelUnnamed(instance: SyntheticCatalogInstance): boolean {
  if (instance.authenticated !== true) return false;
  if (instance.enabled === false) return false;
  if (instance.installed === false) return false;
  if (instance.launchable === false) return false;
  if (instance.billing === "paid-api" || instance.billing === "unknown") return false;
  if (quotaWord(instance.quota) === "exhausted") return false;
  if (creditsBlocked(instance)) return false;
  return publishedModel(instance).length === 0;
}

function isUsable(instance: SyntheticCatalogInstance): boolean {
  if (instance.enabled === false) return false;
  if (instance.installed === false) return false;
  if (instance.authenticated === false) return false;
  if (instance.launchable === false) return false;
  if (instance.billing === "paid-api" || instance.billing === "unknown") return false;
  if (quotaWord(instance.quota) === "exhausted") return false;
  if (publishedModel(instance).length === 0) return false;
  return true;
}

function uniqueInstances(catalog: readonly SyntheticCatalogInstance[]): SyntheticCatalogInstance[] {
  const seen = new Set<string>();
  const unique: SyntheticCatalogInstance[] = [];
  for (const instance of catalog) {
    if (seen.has(instance.instanceId)) continue;
    seen.add(instance.instanceId);
    unique.push(instance);
  }
  return unique;
}

/** Instance ids that can receive a role right now, in assignment order. */
export function usableInstanceIds(catalog: readonly SyntheticCatalogInstance[]): readonly string[] {
  return eligibleInstances(catalog).map((instance) => instance.instanceId);
}

/**
 * The one selection rule: every instance that may receive a role right now,
 * in catalog order. Usable by the existing filters, not health-blocked, not
 * avoided, not excluded, and inside the allowed scope when one is set. Both
 * selection sites (initial assignment and recovery re-selection) and the
 * session's chain pre-check go through this helper so the rules exist once.
 */
export function eligibleInstances(
  catalog: readonly SyntheticCatalogInstance[],
  filter: EligibilityFilter = {},
): readonly SyntheticCatalogInstance[] {
  const exclude = new Set(filter.exclude ?? []);
  const avoid = new Set(filter.avoidInstances ?? []);
  const allowed = filter.allowedInstances === undefined ? null : new Set(filter.allowedInstances);
  const eligible = uniqueInstances(catalog).filter((instance) => {
    const named = allowed !== null && allowed.has(instance.instanceId);
    // An explicitly named harness whose sign-in type is unknown can take a
    // role. It is not added to the default pool, and it is not a subscription.
    if (instance.instanceId === "pi" && instance.piCapacity) {
      return named && !avoid.has("pi") && !exclude.has("pi") && selectedPiEligible(instance, filter.piCapacity, filter.legacyPiContinuation === true);
    }
    const explicitUnknown = named && instance.billing === "unknown"
      && instance.enabled !== false && instance.installed !== false
      && instance.launchable !== false && instance.authenticated !== false
      && publishedModel(instance).length > 0;
    if (!isUsable(instance) && !explicitUnknown) return false;
    if (instance.environmentAvoided) return false;
    if (avoid.has(instance.instanceId)) return false;
    if (exclude.has(instance.instanceId)) return false;
    if (allowed !== null && !allowed.has(instance.instanceId)) return false;
    return true;
  });
  // A deliberate Pi capacity choice is a Codex + Pi role contract, not a
  // third candidate that can silently lose its role to another subscription.
  return filter.piCapacity
    ? ["codex", "pi"].flatMap(id => eligible.filter(instance => instance.instanceId === id))
    : eligible;
}

function quotaLabelsFor(instances: readonly SyntheticCatalogInstance[]): Record<string, QuotaWord> {
  const labels: Record<string, QuotaWord> = {};
  for (const instance of instances) {
    labels[instance.instanceId] = quotaWord(instance.quota);
  }
  return labels;
}

function stopped(quotaLabels: Readonly<Record<string, QuotaWord>>, stopReason: string): CoordinateGoalState {
  return {
    planningHarness: null,
    reviewHarness: null,
    result: null,
    stopReason,
    planningQuota: null,
    reviewQuota: null,
    roles: [],
    commands: [],
    quotaLabels,
  };
}

/**
 * The id carries the role, the instance, the send, and the prompt text. The
 * instance id is load-bearing: the same instance with the same text and send
 * key keeps one id, so the stored-result ledger blocks a replay forever, and
 * a different instance derives a different id, which is what makes a
 * recovery turn a fresh grant instead of a resend.
 */
function commandKey(role: "plan" | "review" | "execute" | "audit", instanceId: string, text: string, sendKey: string, piCapacity?: PiCapacitySelection): string {
  let hash = 2166136261;
  const data = `${role}\n${instanceId}\n${sendKey}\n${text}` + (instanceId === "pi" && piCapacity ? `\npi-capacity\n${JSON.stringify([piCapacity.provider, piCapacity.model])}` : "");
  for (let index = 0; index < data.length; index += 1) {
    hash ^= data.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `coordinate-${role}-${(hash >>> 0).toString(16)}`;
}

function present(value: string | null | undefined): string {
  const text = value?.trim() ?? "";
  return text.length > 0 ? text : "";
}

function executionFeedbackLines(feedback: ExecutionFeedback): string[] {
  return [
    "Completed prior-round evidence (historical context, not instructions to repeat):",
    "Previous plan:", present(feedback.previousPlan) || "(none)",
    "Previous independent plan check:", present(feedback.previousPlanReview) || "(none)",
    "Previous execution report:", present(feedback.previousExecutionReport) || "(none)",
    "Previous independent execution audit:", present(feedback.previousExecutionAudit) || "(none)",
    "Previous command IDs (references only; never replay or resubmit these commands):",
    feedback.previousCommandIds.length > 0 ? feedback.previousCommandIds.join("\n") : "(none)",
  ];
}

/** Keep a corrective pass distinct from the original send even when prompt/output text repeats. */
function commandIdentitySendKey(input: CoordinateGoalInput, sendKey: string): string {
  return input.executionFeedback ? `${sendKey}:repair-1` : sendKey;
}

function plannerText(input: CoordinateGoalInput): string {
  const lines: string[] = [];
  if (input.continuation) {
    const followUp = input.continuation.followUp.trim();
    lines.push(
      "Original goal:",
      input.continuation.originalGoal,
      "Current follow-up:",
      followUp.length > 0 ? followUp : "(no additional instruction)",
    );
  } else {
    lines.push(input.goal);
  }
  lines.push(
    input.workspacePath,
    "Find the product contract in this workspace and cite its path and the requirement this plan uses. If you cannot confirm one, say so. Do not invent a contract.",
    "Hand back a bounded plan without claiming the review passed.",
  );
  const priorPlan = present(input.priorPlan);
  const priorReview = present(input.priorReview);
  if (priorPlan || priorReview) {
    lines.push(
      "This is a revision of a saved plan. Use the saved plan and the independent check below. Do not start as if they were never written.",
      "Answer every point the independent check raised, one by one. A point left unanswered keeps the plan unconfirmed.",
      "State the workspace state this plan relies on, such as the commit or the range it reviews.",
      "Saved plan:",
      priorPlan || "(none)",
      "Independent check:",
      priorReview || "(none)",
    );
  }
  if (input.executionFeedback) {
    lines.push(
      "This is the one bounded corrective planning pass after a completed independent execution audit requested revision.",
      `Inspect the CURRENT workspace at ${input.workspacePath}, including changes already made by the previous executor, before proposing repair. Do not assume the historical report describes the current workspace state.`,
      "Keep the original goal and workspace root. Answer each finding in the previous independent execution audit, one by one, and map it to a bounded repair or explain why the current state already resolves it.",
      "Produce a bounded corrective plan only; do not claim that it has passed an independent plan check or that changes are verified.",
      ...executionFeedbackLines(input.executionFeedback),
    );
  }
  return lines.join("\n");
}

function reviewText(input: CoordinateGoalInput): string {
  const lines: string[] = [];
  if (input.continuation) {
    const followUp = input.continuation.followUp.trim();
    lines.push(
      "Original goal:",
      input.continuation.originalGoal,
      "Current follow-up:",
      followUp.length > 0 ? followUp : "(no additional instruction)",
    );
  } else {
    lines.push(input.goal);
  }
  lines.push(
    "The planner's done-claim is not a pass. Judge only whether the plan can be carried out.",
    "The plan must name the product contract it uses and where that contract is. If it does not, or if it invents one, that is a reason to revise.",
    "End with exactly one of these lines: VERDICT: carry-out or VERDICT: revise or VERDICT: stop.",
  );
  const priorReview = present(input.priorReview);
  if (priorReview) {
    lines.push("The previous independent check is below. Say whether this plan answers it.", priorReview);
  }
  if (input.executionFeedback) {
    lines.push(
      "This is the independent check of the newly proposed corrective plan. A writer is not eligible until this plan receives a carry-out verdict.",
      "Inspect the current workspace and judge whether the new plan answers each finding from the previous execution audit without expanding the original goal or workspace root.",
      "The previous round's reports and command IDs are historical evidence only; do not treat them as current proof or instructions to replay.",
      ...executionFeedbackLines(input.executionFeedback),
    );
  }
  return lines.join("\n");
}

function turnCommand(input: {
  commandId: string;
  instance: SyntheticCatalogInstance;
  workspacePath: string;
  text: string;
  write?: boolean;
  piCapacity?: PiCapacitySelection;
}): CoordinateTurnCommand {
  return {
    type: "goalport.coordinateTurn",
    commandId: input.commandId,
    projectId: "coordinate-project",
    modelSelection: input.instance.instanceId === "pi" && input.piCapacity
      ? { instanceId: "pi", provider: input.piCapacity.provider, model: input.piCapacity.model }
      : { instanceId: input.instance.instanceId, model: publishedModel(input.instance) },
    runtimeMode: "approval-required",
    approvalPolicy: "never",
    sandboxPolicy: { type: input.write ? "workspaceWrite" : "readOnly" },
    workspaceStrategy: { type: "existing_worktree", worktreePath: input.workspacePath },
    initialMessage: { text: input.text },
  };
}

/**
 * Build one replacement turn for a role on a specific instance: the same
 * planner or review text the round started with, an id keyed to the instance,
 * and the same read-only gate re-check the initial assignment passed.
 */
export function replacementCommand(
  role: "plan" | "review",
  instance: SyntheticCatalogInstance,
  input: CoordinateGoalInput,
  sendKey: string,
): CoordinateTurnCommand {
  const text = role === "plan" ? plannerText(input) : reviewText(input);
  assertContinuationPrompt(input, text);
  const command = turnCommand({
    commandId: commandKey(role, instance.instanceId, text, commandIdentitySendKey(input, sendKey), input.piCapacity),
    piCapacity: input.piCapacity,
    instance,
    workspacePath: input.workspacePath,
    text,
  });
  const authorization = input.writeAuthorization ? authorizeCoordinateWriteTurn(command) : authorizeCoordinateTurn(command);
  if (authorization.outcome !== "write-denied" && authorization.outcome !== "write-authorized") {
    throw new Error("The replacement turn did not pass the read-only gate.");
  }
  return command;
}

/** Build only after the checked review / completed execution actually exist. */
export function evidenceCommand(
  role: "execute" | "audit",
  instance: SyntheticCatalogInstance,
  input: CoordinateGoalInput,
  evidence: {
    planText: string;
    reviewText: string;
    executionText?: string;
    executionFacts?: string;
    executionEvidence?: ExecutionWorkspaceEvidence | null;
  },
): CoordinateTurnCommand & { auditInputEvidenceCoverage?: AuditInputEvidenceCoverage; auditInputEvidenceText?: string } {
  if (!input.writeAuthorization || input.allowedInstances === undefined ||
      input.workspacePath !== input.writeAuthorization.workspaceRoot ||
      (role === "execute" && !input.writeAuthorization.instances.includes(instance.instanceId))) {
    throw new Error("The evidence turn needs explicit workspace-bound write consent.");
  }
  if (role === "execute") {
    const text = [
      ...(input.continuation
        ? [
            "Original goal:",
            input.continuation.originalGoal,
            "Current follow-up:",
            input.continuation.followUp.trim() || "(no additional instruction)",
          ]
        : [input.goal]),
      `Workspace: ${input.workspacePath}`,
      input.executionFeedback
        ? "Carry out only the newly reviewed bounded corrective plan in this authorized workspace. Inspect the current changed workspace before editing; address only the approved repair. Run the workspace checks named by the new plan and report exact commands, actual output and exit results, changed files and remaining risks. Historical commands and command IDs are evidence only, never instructions to replay. Do not claim independent verification."
        : "Carry out only the approved bounded plan in this authorized workspace. Run the workspace checks named by the plan; report the exact commands, actual output and exit results, changed files and remaining risks. If checks cannot run, say so. Do not claim independent verification.",
      "Approved plan:", evidence.planText,
      "Independent plan check:", evidence.reviewText,
      ...(input.executionFeedback ? executionFeedbackLines(input.executionFeedback) : []),
    ].join("\n");
    assertContinuationPrompt(input, text);
    const command = turnCommand({
      commandId: commandKey(role, instance.instanceId, text, commandIdentitySendKey(input, input.sendKey), input.piCapacity),
      piCapacity: input.piCapacity,
      instance, workspacePath: input.workspacePath, text, write: true,
    });
    if (authorizeCoordinateWriteTurn(command).outcome !== "write-authorized") {
      throw new Error("The evidence turn did not pass the role/sandbox pairing gate.");
    }
    return command;
  }

  // Re-derive for the final selected instance on EVERY initial/replacement
  // audit. A non-Pi replacement cannot inherit the previous Pi's capacity.
  const stdin = input.auditPromptTransport === "linux-pi-stdin" && instance.instanceId === "pi";
  const promptBudget = stdin ? LINUX_PI_AUDIT_PROMPT_BYTES : MAX_AUDIT_PROMPT_BYTES;
  const evidenceReservation = stdin ? LINUX_PI_AUDIT_EVIDENCE_RESERVE_BYTES : AUDIT_EVIDENCE_RESERVE_BYTES;
  const instruction = input.executionFeedback
    ? "Independently inspect the current workspace read-only against the newly approved corrective plan, its execution report, and captured workspace evidence. Check whether each finding from the previous audit is resolved in the current state; do not treat historical reports or the executor's done-claim as proof. If captured evidence is truncated, incomplete, cropped for transport, or unavailable, state that limitation explicitly. State any checks you actually perform and their results. GoalPort has not independently run a machine-test stage. End with exactly one of these lines: VERDICT: verified or VERDICT: revise or VERDICT: stop."
    : "Independently inspect the workspace read-only against the approved plan, execution report, and captured workspace evidence. Check the reported evidence against the captured before/after diffs and untracked text; do not treat the executor's done-claim as proof. If captured evidence is truncated, incomplete, cropped for transport, or unavailable, state that limitation explicitly. State any checks you actually perform and their results. GoalPort has not independently run a machine-test stage. End with exactly one of these lines: VERDICT: verified or VERDICT: revise or VERDICT: stop.";
  const baseSections = [
    {
      label: "Goal",
      text: input.continuation
        ? `Original goal:\n${input.continuation.originalGoal}\nCurrent follow-up:\n${input.continuation.followUp.trim() || "(no additional instruction)"}`
        : `Goal: ${input.goal}`,
    },
    { label: "Workspace", text: `Workspace: ${input.workspacePath}` },
    { label: "Approved plan", text: `Approved plan:\n${evidence.planText}` },
    { label: "Independent plan check", text: `Independent plan check:\n${evidence.reviewText}` },
    ...(input.executionFeedback
      ? [{ label: "Prior-round feedback and metadata", text: executionFeedbackLines(input.executionFeedback).join("\n") }]
      : []),
    { label: input.executionFeedback ? "Corrective execution report" : "Execution report", text: `${input.executionFeedback ? "Corrective execution report" : "Execution report"}:\n${evidence.executionText ?? "(none)"}` },
    { label: "Recorded execution facts", text: `Recorded execution facts:\n${evidence.executionFacts ?? "(none)"}` },
  ];
  // Preserve every byte on ordinary rounds. Only an actually oversize prompt
  // invokes the reserved-evidence split; unused evidence room is always made
  // available to goal/plan/review/report/feedback instead of cropping early.
  const fullBaseText = [instruction, ...baseSections.map((section) => section.text)].join("\n");
  const fullEvidence = formatEvidenceForAudit(evidence.executionEvidence, Number.MAX_SAFE_INTEGER);
  const fullPromptBytes = utf8Bytes(fullBaseText) + 1 + utf8Bytes(fullEvidence.text);
  let baseText = fullBaseText;
  let baseCroppedSections: string[] = [];
  let evidenceText = fullEvidence.text;
  let coverage = fullEvidence.coverage;
  if (fullPromptBytes > promptBudget) {
    const evidenceReserve = Math.min(evidenceReservation, utf8Bytes(fullEvidence.text));
    const baseBudget = promptBudget - evidenceReserve - 1;
    const variableBaseBudget = Math.max(0, baseBudget - utf8Bytes(instruction) - 1);
    const fittedBase = fitSections(baseSections, variableBaseBudget);
    baseCroppedSections = fittedBase.croppedSections;
    baseText = `${instruction}\n${fittedBase.text}`;
    const availableForEvidence = Math.max(0, promptBudget - utf8Bytes(baseText) - 1);
    const deliveredEvidence = formatEvidenceForAudit(evidence.executionEvidence, availableForEvidence);
    evidenceText = deliveredEvidence.text;
    coverage = deliveredEvidence.coverage;
  }
  const text = `${baseText}\n${evidenceText}`;
  const actualCoverage: AuditInputEvidenceCoverage = {
    ...coverage,
    cropped: baseCroppedSections.length > 0 || coverage.cropped,
    promptBytes: utf8Bytes(text),
    promptBudgetBytes: promptBudget,
    // Old absent-capability records keep their exact legacy key set.
    ...(stdin ? { promptDelivery: "stdin" as const } : {}),
    ...(!stdin ? { windowsCmdWorstCaseChars: windowsCmdWorstCaseChars(text) } : {}),
    croppedSections: [...baseCroppedSections, ...(coverage.croppedSections ?? [])],
  };
  if (actualCoverage.promptBytes > promptBudget ||
      (!stdin && (actualCoverage.windowsCmdWorstCaseChars ?? 0) > WINDOWS_CMD_MAX_CHARS)) {
    throw new Error("The assembled audit prompt exceeded its transport budget.");
  }

  const command = turnCommand({
    commandId: commandKey(role, instance.instanceId, text, commandIdentitySendKey(input, input.sendKey), input.piCapacity),
    piCapacity: input.piCapacity,
    instance, workspacePath: input.workspacePath, text, write: false,
  });
  if (authorizeCoordinateWriteTurn(command).outcome !== "write-authorized") {
    throw new Error("The evidence turn did not pass the role/sandbox pairing gate.");
  }
  return { ...command, ...(stdin ? { promptDelivery: "stdin" as const } : {}), auditInputEvidenceCoverage: actualCoverage, auditInputEvidenceText: evidenceText };
}

/**
 * Pick two different catalog instances for a plan and a check.
 * The returned commands are not sent. A later session may send them.
 * Assigning both roles is not a completed review.
 */
export function coordinateGoal(input: CoordinateGoalInput): CoordinateGoalState {
  const unique = uniqueInstances(input.catalog);
  const quotaLabels = quotaLabelsFor(unique);
  const usable = eligibleInstances(unique, {
    avoidInstances: input.avoidInstances,
    allowedInstances: input.allowedInstances,
    piCapacity: input.piCapacity,
    legacyPiContinuation: input.legacyPiContinuation,
  });
  if (input.catalog.length === 0) {
    return stopped(
      quotaLabels,
      "Stopped. No harness catalog is connected, so no role was assigned.",
    );
  }
  if (usable.length < 2) {
    // The named sentence fires only when the blockings are the cause:
    // ignoring avoidance and health evidence, two allowed harnesses could
    // still run. Health-blocked and avoided instances are one union here.
    const allowed = input.allowedInstances === undefined ? null : new Set(input.allowedInstances);
    const withinAllowed = unique.filter((instance) =>
      isUsable(instance) && (allowed === null || allowed.has(instance.instanceId))
    );
    // Name a blocker only when that same blocked instance is inside the
    // authorized pool and is the reason two otherwise usable harnesses cannot
    // be assigned. Unrelated health evidence outside scope is not a reason.
    const blocked = withinAllowed.find(
      (instance) => Boolean(instance.environmentAvoided)
        || (input.avoidInstances ?? []).includes(instance.instanceId),
    );
    if (blocked && withinAllowed.length >= 2) {
      return stopped(
        quotaLabels,
        `Stopped. ${harnessLabel(blocked)} cannot run on this machine right now, and an independent check needs two harnesses that can run.`,
      );
    }
    const authorizedPool = allowed === null
      ? unique
      : unique.filter((instance) => allowed.has(instance.instanceId));
    const credits = authorizedPool.some(creditsBlocked);
    const unnamed = authorizedPool.some(modelUnnamed);
    return stopped(
      quotaLabels,
      credits
        ? "Stopped. A model that requires extra usage credits was not selected, and an independent check still needs a second harness with an included model."
        : unnamed
          ? "Stopped. A signed-in harness has no included model GoalPort can name, so an extra-credit model was not selected."
          : "Stopped. An independent check needs a second logged-in harness, so no second role was assigned.",
    );
  }

  if (input.writeAuthorization !== undefined) {
    const write = input.writeAuthorization;
    const writers = eligibleInstances(unique, {
      avoidInstances: input.avoidInstances, allowedInstances: write.instances,
    });
    if (input.allowedInstances === undefined || input.workspacePath !== write.workspaceRoot ||
        !/^[/\\]|^[A-Za-z]:[/\\]/.test(write.workspaceRoot) ||
        !writers.some((writer) => usable.some((reader) => reader.instanceId !== writer.instanceId))) {
      return stopped(quotaLabels, "Stopped. Workspace changes need explicit scoped consent for this workspace and an independent verification harness.");
    }
  }

  const planner = usable[0];
  const reviewer = usable[1];
  if (!planner || !reviewer || planner.instanceId === reviewer.instanceId) {
    return stopped(
      quotaLabels,
      "Stopped. An independent check needs a second logged-in harness, so no second role was assigned.",
    );
  }

  if (input.continuation) {
    if (input.continuation.originalGoal.length + input.continuation.followUp.length > MAX_CONTINUATION_CHARS) {
      return stopped(
        quotaLabels,
        "Stopped. The combined character length of the original goal and follow-up exceeds 100,000 characters, so no turn was sent.",
      );
    }
  }

  const planMessage = plannerText(input);
  const reviewMessage = reviewText(input);

  if (input.continuation) {
    if (utf8Bytes(planMessage) > MAX_CONTINUATION_PROMPT_BYTES || utf8Bytes(reviewMessage) > MAX_CONTINUATION_PROMPT_BYTES) {
      return stopped(
        quotaLabels,
        "Stopped. The assembled continuation prompt exceeded the 100,000-byte limit, so no turn was sent.",
      );
    }
  }

  const identitySendKey = commandIdentitySendKey(input, input.sendKey);
  const commands = [
    turnCommand({ commandId: commandKey("plan", planner.instanceId, planMessage, identitySendKey, input.piCapacity), piCapacity: input.piCapacity, instance: planner, workspacePath: input.workspacePath, text: planMessage }),
    turnCommand({ commandId: commandKey("review", reviewer.instanceId, reviewMessage, identitySendKey, input.piCapacity), piCapacity: input.piCapacity, instance: reviewer, workspacePath: input.workspacePath, text: reviewMessage }),
  ] as const;

  for (const command of commands) {
    const authorization = input.writeAuthorization ? authorizeCoordinateWriteTurn(command) : authorizeCoordinateTurn(command);
    if (authorization.outcome !== "write-denied" && authorization.outcome !== "write-authorized") {
      return stopped(quotaLabels, "Stopped. The edit disposition was not deny, so no role was assigned.");
    }
  }

  return {
    planningHarness: harnessLabel(planner),
    reviewHarness: harnessLabel(reviewer),
    result: null,
    stopReason: "Two different harnesses are assigned. No model turn has been sent.",
    planningQuota: quotaWord(planner.quota),
    reviewQuota: quotaWord(reviewer.quota),
    roles: input.writeAuthorization ? ["planning", "review", "execution", "audit"] : ["planning", "review"],
    commands,
    quotaLabels,
  };
}
