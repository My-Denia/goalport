import { normalizeRequestedPiCapacity, type PiPair } from "../../electron/pi-capacity.mjs";
import {
  coordinateGoal,
  assertContinuationPrompt,
  ContinuationPromptLimitError,
  evidenceCommand,
  eligibleInstances,
  replacementCommand,
  type CoordinateGoalInput,
  type CoordinateGoalState,
  type SyntheticCatalogInstance,
  type ExecutionWorkspaceEvidence,
  type AuditInputEvidenceCoverage,
} from "./coordinateGoal";
import type { CoordinateTurnCommand } from "./coordinateTurn";
import { classifyProviderError, environmentSignature, providerErrorSentence } from "./providerError";
import { verdictFromAudit, verdictFromReview, type CoordinationVerdict } from "./verdict";
import type { RoundEvent } from "./savedPlan";

/**
 * Structured stop codes from the CLI and scope layers (mirrors the bridge
 * type). Provider-level failures — an is_error reply, an empty text — carry
 * no stopCode at all, so their classification falls to the errorText mapping.
 */
export type CoordinationStopCode =
  | "no-text"
  | "not-finished"
  | "not-installed"
  | "scope-exhausted"
  | "scope-revoked";

export interface AuditInputTransport {
  readonly instanceId: "pi";
  readonly promptDelivery: "stdin";
  /** Host UTF-8 bytes and stream-end confirmation, not model consumption. */
  readonly inputBytes: number;
  readonly inputEnded: boolean;
}

export interface CoordinateLaunchResult {
  readonly requestedPiCapacity?: PiPair;
  readonly text: string;
  readonly errorText: string;
  readonly prepared?: boolean;
  /**
   * Whether a model turn was actually dispatched. A failed launch that never
   * dispatched (not authorized, not installed, unrecorded) may be retried
   * explicitly by the user; a dispatched or unknown outcome may not.
   */
  readonly dispatched?: boolean | null;
  /**
   * Typed flag set by the CLI layer when the turn's own tool events prove the
   * harness cannot run tools on this machine (sandbox helper failure). It
   * wins over the stderr-signature fallback in classifyProviderError.
   */
  readonly environmentBlocked?: boolean | null;
  readonly environmentDetail?: string | null;
  readonly stopCode?: CoordinationStopCode | null;
  /** Authorized scope budget left after this launch, when a scope is active. */
  readonly turnsRemaining?: number | null;
  /** Independent WRITE counter from M6; turnsRemaining always means READ. */
  readonly writeTurnsRemaining?: number | null;
  readonly scopeExhausted?: boolean;
  readonly executionEvidence?: ExecutionWorkspaceEvidence | null;
  readonly auditInputTransport?: AuditInputTransport;
}

export interface EnvironmentBlockedInfo {
  readonly role: CoordinationRole;
  readonly instanceId: string;
  readonly harness: string | null;
  readonly detail: string | null;
}

export type CoordinationRole = "planning" | "review" | "execution" | "audit";

/**
 * Synchronous round events. "started" fires before each launch and is never
 * persisted; "failed" and "continued" are completed facts and land in
 * roundEvents.
 */
export type CoordinateSessionEvent =
  | { readonly kind: "started"; readonly role: CoordinationRole; readonly instanceId: string; readonly harness: string | null }
  | { readonly kind: "failed"; readonly role: CoordinationRole; readonly instanceId: string; readonly harness: string | null; readonly sentence: string; readonly detail?: string | null }
  | { readonly kind: "continued"; readonly role: CoordinationRole; readonly instanceId: string; readonly harness: string | null; readonly sentence: string };

export interface CoordinateTransport {
  launch(command: CoordinateTurnCommand): Promise<CoordinateLaunchResult>;
}

export interface CoordinateSessionOptions {
  readonly sendAuthorized: boolean;
  /**
   * Present = a scoped round: recovery is authorized, and selection is
   * restricted to these instances. Absent = the legacy round: two sequential
   * turns and an early stop, with no automatic recovery.
   */
  readonly allowedInstances?: readonly string[];
  /** Receives round events synchronously, before the awaited launch resolves. */
  readonly onEvent?: (event: CoordinateSessionEvent) => void;
}

export interface CoordinateSessionState extends CoordinateGoalState {
  readonly requestedPiCapacity?: PiPair;
  readonly planText: string | null;
  readonly reviewText: string | null;
  readonly executionText?: string | null;
  readonly auditText?: string | null;
  readonly executionHarness?: string | null;
  readonly auditHarness?: string | null;
  readonly authorizedWriteTurnsLeft?: number | null;
  readonly verdict: CoordinationVerdict | null;
  readonly messageDispatched: boolean | null;
  readonly environmentBlocked?: EnvironmentBlockedInfo | null;
  /** Completed failure and takeover facts only — started is never persisted. */
  readonly roundEvents: readonly RoundEvent[];
  /** Scope budget after the last launch; absent on rounds without a scope. */
  readonly authorizedTurnsLeft?: number | null;
  /** True when the authorized scope ran out of model turns. */
  readonly scopeExhausted?: boolean;
  readonly executionEvidence?: ExecutionWorkspaceEvidence | null;
  readonly auditInputEvidenceCoverage?: AuditInputEvidenceCoverage | null;
  /** Exact captured-evidence section delivered to the auditor, after transport crops. */
  readonly auditInputEvidenceText?: string | null;
}

function reportFromPlan(
  plan: CoordinateGoalState,
  fields: {
    stopReason?: string;
    planText?: string | null;
    reviewText?: string | null;
    verdict?: CoordinationVerdict | null;
    result?: string | null;
    messageDispatched?: boolean | null;
    environmentBlocked?: EnvironmentBlockedInfo | null;
    roundEvents?: readonly RoundEvent[];
  } = {},
): CoordinateSessionState {
  return {
    ...plan,
    stopReason: fields.stopReason ?? plan.stopReason,
    result: fields.result === undefined ? plan.result : fields.result,
    planText: fields.planText ?? null,
    reviewText: fields.reviewText ?? null,
    verdict: fields.verdict ?? null,
    // An explicit null (unknown dispatch) must survive; only an unset field
    // falls back to "nothing was sent".
    messageDispatched: fields.messageDispatched === undefined ? false : fields.messageDispatched,
    environmentBlocked: fields.environmentBlocked ?? null,
    roundEvents: fields.roundEvents ?? [],
  };
}

/**
 * Typed JSONL-event flag first (the CLI layer watched the turn's own tool
 * events); the stderr-signature fallback covers harnesses that only leave
 * the failure in stderr. Neither means the model misbehaved — the machine
 * could not run the harness's tools.
 */
function environmentFromLaunch(
  launch: CoordinateLaunchResult,
  role: CoordinationRole,
  instanceId: string,
  harness: string | null,
): EnvironmentBlockedInfo | null {
  if (launch.environmentBlocked === true) {
    return { role, instanceId, harness, detail: launch.environmentDetail?.trim() || null };
  }
  if (classifyProviderError(launch.errorText) === "environment") {
    return { role, instanceId, harness, detail: environmentSignature(launch.errorText) };
  }
  return null;
}

function checkStopReason(verdict: CoordinationVerdict): string {
  switch (verdict) {
    case "checked":
      return "The independent check finished, so this stopped.";
    case "revise":
      return "The independent check says the plan needs revision, so this stopped.";
    case "stopped":
      return "The independent check says to stop, so this stopped.";
    case "verified":
    case "failed":
    case "unconfirmed":
      return "The independent check did not confirm the plan, so this stopped.";
    default: {
      const unreachable: never = verdict;
      return unreachable;
    }
  }
}

function withPlanText(command: CoordinateTurnCommand, planText: string): CoordinateTurnCommand {
  return {
    ...command,
    initialMessage: {
      text: [
        command.initialMessage.text,
        "",
        "Plan:",
        planText.length > 0 ? planText : "(The planner returned no text.)",
      ].join("\n"),
    },
  };
}

/** The legacy round: exactly two sequential turns and an early stop. */
async function runLegacyRound(
  input: CoordinateGoalInput,
  transport: CoordinateTransport,
  plan: CoordinateGoalState,
  planning: CoordinateTurnCommand,
  review: CoordinateTurnCommand,
): Promise<CoordinateSessionState> {
  assertContinuationPrompt(input, planning.initialMessage.text);
  const planned = await transport.launch(planning);
  const planError = classifyProviderError(planned.errorText);
  const planEnvironment = environmentFromLaunch(planned, "planning", planning.modelSelection.instanceId, plan.planningHarness);
  const planText = planned.text.trim();
  if (
    planEnvironment !== null ||
    planError === "usage_credits" ||
    planError === "authentication" ||
    planned.errorText.trim().length > 0
  ) {
    return reportFromPlan(
      { ...plan, commands: [planning], roles: ["planning", "review"], result: null },
      {
        verdict: "failed",
        planText: planText.length > 0 ? planText : null,
        stopReason:
          planEnvironment !== null
            ? "The harness could not finish the turn, so this stopped."
            : providerErrorSentence(planned.errorText),
        // Tri-state passthrough: a null (the runtime died mid-turn, the turn
        // may have reached the provider) must never read as "nothing was
        // sent" — that would make an unknown outcome retryable.
        messageDispatched: planned.dispatched ?? null,
        environmentBlocked: planEnvironment,
      },
    );
  }
  if (planText.length === 0) {
    return reportFromPlan(
      { ...plan, result: null },
      { verdict: "failed", stopReason: "The planner returned no text, so the check was not sent.", messageDispatched: true },
    );
  }

  const reviewCommand = withPlanText(review, planText);
  try {
    assertContinuationPrompt(input, reviewCommand.initialMessage.text);
  } catch (error) {
    if (!(error instanceof ContinuationPromptLimitError)) throw error;
    return reportFromPlan({ ...plan, commands: [planning] }, {
      verdict: "stopped", planText, messageDispatched: planned.dispatched ?? null,
      stopReason: `${error.message} The review was not sent; the earlier planning result is retained.`,
    });
  }
  const checked = await transport.launch(reviewCommand);
  const reviewText = checked.text.trim();
  const reviewEnvironment = environmentFromLaunch(checked, "review", review.modelSelection.instanceId, plan.reviewHarness);
  if (reviewEnvironment !== null || checked.errorText.trim().length > 0) {
    return reportFromPlan(
      { ...plan, result: null },
      {
        verdict: "failed",
        planText,
        reviewText: reviewText.length > 0 ? reviewText : null,
        stopReason:
          reviewEnvironment !== null
            ? "The harness could not finish the turn, so this stopped."
            : providerErrorSentence(checked.errorText),
        // Tri-state passthrough: an absent dispatch state is unknown, never
        // "proven not sent" — the same rule the planning branch applies.
        messageDispatched: checked.dispatched ?? null,
        environmentBlocked: reviewEnvironment,
      },
    );
  }
  const verdict = verdictFromReview(reviewText);
  const stopReason = checkStopReason(verdict);
  return reportFromPlan(
    { ...plan, result: reviewText.length > 0 ? reviewText : null },
    {
      verdict,
      planText,
      reviewText: reviewText.length > 0 ? reviewText : null,
      stopReason,
      messageDispatched: true,
    },
  );
}

const ROLES: readonly CoordinationRole[] = ["planning", "review"];
const MAX_DETAIL = 300;

function harnessOf(instance: SyntheticCatalogInstance): string {
  const name = instance.name.trim();
  return name.length > 0 ? name : instance.instanceId;
}

function roleLabel(role: CoordinationRole): string {
  return { planning: "planning", review: "checking", execution: "making changes", audit: "verifying" }[role];
}

function boundedDetail(text: string | null): string | null {
  const trimmed = text?.trim() ?? "";
  return trimmed.length > 0 ? trimmed.slice(0, MAX_DETAIL) : null;
}

interface Failure {
  readonly role: CoordinationRole;
  readonly instanceId: string;
  readonly harness: string | null;
  /** One human line naming the harness that failed. */
  readonly sentence: string;
  /** The round-level stop line if the round stops on this failure. */
  readonly stopReason: string;
  readonly detail: string | null;
  readonly environment: EnvironmentBlockedInfo | null;
  readonly continuable: boolean;
}

/**
 * Failure classification for the recovery engine, in the load-bearing
 * precedence: the typed environment flag (or an env-signature errorText)
 * first, a structured stopCode second, the errorText class last. A generic
 * provider error — including an is_error reply with no stopCode, an
 * empty-text failure, a REPLACED/cancelled round, and guard or scope
 * refusals — never lands in a continuable class. For a write-enabled round,
 * even a positive response is successful only with literal dispatched=true.
 * Returns null for a success.
 */
function failureFromLaunch(
  launch: CoordinateLaunchResult,
  role: CoordinationRole,
  instance: SyntheticCatalogInstance,
  requireConfirmedDispatch = false,
): Failure | null {
  const harness = harnessOf(instance);
  const errorText = launch.errorText.trim();
  if (
    launch.environmentBlocked !== true
    && launch.stopCode == null
    && errorText.length === 0
    && launch.text.trim().length > 0
  ) {
    if (!requireConfirmedDispatch || launch.dispatched === true) return null;

    const notSent = launch.dispatched === false;
    return {
      role,
      instanceId: instance.instanceId,
      harness,
      sentence: `${harness} returned text without confirmed dispatch, so this stopped for it.`,
      stopReason: notSent
        ? `The ${role} response returned text but was marked not sent, so this stopped before another role could rely on it.`
        : `The ${role} response returned text, but whether it was sent is unknown, so this stopped before another role could rely on it.`,
      detail: null,
      environment: null,
      continuable: false,
    };
  }

  // Classification order is load-bearing: the typed environment fact wins,
  // then an explicit completion stopCode, and only then stderr/provider text.
  // This prevents a coincidental stderr signature from overriding a more
  // authoritative structured stop code.
  const typedEnvironment = launch.environmentBlocked === true
    ? { role, instanceId: instance.instanceId, harness, detail: launch.environmentDetail?.trim() || null }
    : null;
  if (typedEnvironment !== null) {
    return {
      role,
      instanceId: instance.instanceId,
      harness,
      sentence: `${harness} could not run its tools on this machine, so this stopped for it.`,
      stopReason: "The harness could not finish the turn, so this stopped.",
      detail: boundedDetail(typedEnvironment.detail),
      environment: typedEnvironment,
      continuable: true,
    };
  }
  if (launch.stopCode === "not-installed") {
    return {
      role,
      instanceId: instance.instanceId,
      harness,
      sentence: `${harness} is not installed on this machine, so this stopped for it.`,
      stopReason: "This harness is not installed, so nothing was sent.",
      detail: null,
      environment: null,
      continuable: true,
    };
  }
  if (launch.stopCode === "no-text") {
    return {
      role,
      instanceId: instance.instanceId,
      harness,
      sentence: `${harness} finished without any text, so this stopped for it.`,
      stopReason: "The harness finished without any text, so this stopped.",
      detail: null,
      environment: null,
      continuable: true,
    };
  }
  if (launch.stopCode === "not-finished") {
    return {
      role,
      instanceId: instance.instanceId,
      harness,
      sentence: `${harness} did not finish its turn, so this stopped for it.`,
      stopReason: "The harness did not finish, so this stopped.",
      detail: null,
      environment: null,
      continuable: true,
    };
  }
  const environment = environmentFromLaunch(launch, role, instance.instanceId, harness);
  if (environment !== null) {
    return {
      role,
      instanceId: instance.instanceId,
      harness,
      sentence: `${harness} could not run its tools on this machine, so this stopped for it.`,
      stopReason: "The harness could not finish the turn, so this stopped.",
      detail: boundedDetail(environment.detail),
      environment,
      continuable: true,
    };
  }
  const kind = classifyProviderError(errorText);
  // usage_limit, authentication, and usage_credits are the harness's own
  // resource problems; the sentence mapping is the existing one.
  if (kind === "usage_limit" || kind === "authentication" || kind === "usage_credits") {
    const sentence = providerErrorSentence(errorText);
    return {
      role,
      instanceId: instance.instanceId,
      harness,
      sentence,
      stopReason: sentence,
      detail: null,
      environment: null,
      continuable: true,
    };
  }
  const sentence = providerErrorSentence(errorText);
  return {
    role,
    instanceId: instance.instanceId,
    harness,
    sentence,
    stopReason: sentence,
    detail: null,
    environment: null,
    continuable: false,
  };
}

/**
 * The scoped round: the ordered role chain with controlled automatic
 * recovery. A continuable failure on a known-dispatched or proven-not-sent
 * turn re-selects a replacement instance; the chain-completeness pre-check
 * runs before every replacement launch so a pool that cannot staff the rest
 * of the chain stops without spending another turn. Bounded by construction:
 * each read-role/instance at most once; every write failure is terminal.
 */
async function runRecoveryRound(
  input: CoordinateGoalInput,
  options: CoordinateSessionOptions,
  transport: CoordinateTransport,
  plan: CoordinateGoalState,
): Promise<CoordinateSessionState> {
  const write = input.writeAuthorization;
  const roles: readonly CoordinationRole[] = write ? ["planning", "review", "execution", "audit"] : ROLES;
  const emitEvent = options.onEvent;
  const failed = new Set<string>(); // Instance-global: a burned harness never returns in any role.
  const used = new Set<string>();
  const usedKey = (role: CoordinationRole, id: string) => write ? `${role}:${id}` : id;
  const roundEvents: RoundEvent[] = [];
  const launched: CoordinateTurnCommand[] = [];
  const assignments: Partial<Record<CoordinationRole, SyntheticCatalogInstance>> = {};
  const commands: Partial<Record<CoordinationRole, CoordinateTurnCommand>> = {
    planning: plan.commands[0], review: plan.commands[1],
  };
  for (const role of ROLES) {
    assignments[role] = input.catalog.find((item) => item.instanceId === commands[role]?.modelSelection.instanceId);
  }
  let planText: string | null = null;
  let reviewText: string | null = null;
  let executionText: string | null = null;
  let auditText: string | null = null;
  let executionFacts: string | undefined;
  let executionEvidence: ExecutionWorkspaceEvidence | null = null;
  let auditInputEvidenceCoverage: AuditInputEvidenceCoverage | null = null;
  let auditInputEvidenceText: string | null = null;
  let environmentBlocked: EnvironmentBlockedInfo | null = null;
  let lastFailure: Failure | null = null;
  let turnsRemaining: number | null | undefined;
  let writeTurnsRemaining: number | null | undefined = write?.remaining;
  let dispatchState: "unsent" | "sent" | "unknown" = "unsent";
  let requestedPiCapacity: PiPair | undefined;

  const mergeDispatch = (value: boolean | null | undefined) => {
    if (value === true) dispatchState = "sent";
    else if (value === false) dispatchState = dispatchState === "unsent" ? "unsent" : dispatchState;
    else if (dispatchState === "unsent") dispatchState = "unknown";
  };
  const messageDispatched = () => (dispatchState === "sent" ? true : dispatchState === "unknown" ? null : false);
  const poolFor = (role: CoordinationRole) => eligibleInstances(input.catalog, {
    avoidInstances: input.avoidInstances,
    allowedInstances: role === "execution" ? write?.instances : input.allowedInstances,
    piCapacity: input.piCapacity,
    legacyPiContinuation: input.legacyPiContinuation,
    exclude: [...failed],
  }).filter((item) => !used.has(usedKey(role, item.instanceId)));
  const counterpart = (role: CoordinationRole): CoordinationRole | null =>
    role === "review" ? "planning" : role === "audit" ? "execution" : null;
  // Assignment feasibility, not all-read-roles-distinct. The legacy two-role
  // pre-check still requires two survivors before replacing a failed planner.
  const canStaff = (index: number, chosen: Partial<Record<CoordinationRole, SyntheticCatalogInstance>>): boolean => {
    if (index >= roles.length) return true;
    const role = roles[index] as CoordinationRole;
    const other = counterpart(role);
    return poolFor(role).some((candidate) => {
      if (other && chosen[other]?.instanceId === candidate.instanceId) return false;
      return canStaff(index + 1, { ...chosen, [role]: candidate });
    });
  };
  const candidatesFor = (index: number) => {
    const role = roles[index] as CoordinationRole;
    const other = counterpart(role);
    return poolFor(role).filter((candidate) =>
      (!other || assignments[other]?.instanceId !== candidate.instanceId) &&
      canStaff(index + 1, { ...assignments, [role]: candidate }));
  };

  const finish = (fields: {
    stopReason: string; verdict: CoordinationVerdict; result?: string | null; scopeExhausted?: boolean;
  }): CoordinateSessionState => {
    const planning = assignments.planning ?? null;
    const review = assignments.review ?? null;
    return {
      planningHarness: planning ? harnessOf(planning) : null,
      reviewHarness: review ? harnessOf(review) : null,
      result: fields.result === undefined ? null : fields.result,
      stopReason: fields.stopReason,
      planningQuota: planning ? plan.quotaLabels[planning.instanceId] ?? null : null,
      reviewQuota: review ? plan.quotaLabels[review.instanceId] ?? null : null,
      roles: planning && review ? plan.roles : [],
      commands: launched, quotaLabels: plan.quotaLabels, planText, reviewText,
      ...(requestedPiCapacity ? { requestedPiCapacity } : {}),
      verdict: fields.verdict, messageDispatched: messageDispatched(), environmentBlocked, roundEvents,
      ...(write ? {
        executionText, auditText,
        executionHarness: assignments.execution ? harnessOf(assignments.execution) : null,
        auditHarness: assignments.audit ? harnessOf(assignments.audit) : null,
        executionEvidence: executionEvidence ?? null,
        auditInputEvidenceCoverage: auditInputEvidenceCoverage ?? null,
        auditInputEvidenceText: auditInputEvidenceText ?? null,
        authorizedWriteTurnsLeft: writeTurnsRemaining ?? null,
      } : {}),
      ...(turnsRemaining === undefined ? {} : { authorizedTurnsLeft: turnsRemaining }),
      ...(fields.scopeExhausted === undefined ? {} : { scopeExhausted: fields.scopeExhausted }),
    };
  };
  const saveText = (role: CoordinationRole, text: string) => {
    if (!text) return;
    if (role === "planning") planText = text;
    if (role === "review") reviewText = text;
    if (role === "execution") executionText = text;
    if (role === "audit") auditText = text;
  };

  for (let roleIndex = 0; roleIndex < roles.length; roleIndex += 1) {
    const role = roles[roleIndex] as CoordinationRole;
    let instance = assignments[role];
    let command = commands[role];
    const other = counterpart(role);
    if (instance && (failed.has(instance.instanceId) || used.has(usedKey(role, instance.instanceId)) ||
        (other && assignments[other]?.instanceId === instance.instanceId))) {
      instance = undefined; command = undefined;
    }
    let recovering = false;
    do {
      recovering = false;
      let replacementEvent: RoundEvent | null = null;
      if (!instance || !command) {
        const replacement = candidatesFor(roleIndex)[0];
        if (!replacement) {
          return finish({
            stopReason: lastFailure?.environment
              ? `Stopped. ${lastFailure.harness} cannot run on this machine right now, and an independent check needs two harnesses that can run.`
              : lastFailure?.stopReason ?? "Stopped. An independent verification needs another eligible harness, so no further role was sent.",
            verdict: "failed",
          });
        }
        instance = replacement;
        assignments[role] = replacement;
        try {
          command = role === "execution" || role === "audit"
            ? evidenceCommand(role === "execution" ? "execute" : "audit", replacement, input, {
                planText: planText ?? "", reviewText: reviewText ?? "", executionText: executionText ?? "", executionFacts,
                executionEvidence,
              })
            : replacementCommand(role === "planning" ? "plan" : "review", replacement, input, input.sendKey);
        } catch (error) {
          if (!(error instanceof ContinuationPromptLimitError)) throw error;
          return finish({ verdict: "stopped", stopReason: `${error.message} The ${role} was not sent; earlier results and dispatch facts are retained.` });
        }
        commands[role] = command;
        if (role === "audit" && "auditInputEvidenceCoverage" in command) {
          auditInputEvidenceCoverage = (command as { auditInputEvidenceCoverage?: AuditInputEvidenceCoverage }).auditInputEvidenceCoverage ?? null;
          auditInputEvidenceText = (command as { auditInputEvidenceText?: string }).auditInputEvidenceText ?? null;
        }
        // Initial lazy execution/audit assignment is not a takeover.
        if (role === "planning" || role === "review" || lastFailure?.role === role) {
          const harness = harnessOf(replacement);
          replacementEvent = { kind: "continued", role, instanceId: replacement.instanceId, harness,
            sentence: `${harness} is ${roleLabel(role)} instead.` };
        }
      }
      if (role === "execution") {
        // Immediately before the first write, after checked review: both known
        // budgets and an independent eligible reader are necessary. No upfront
        // >=3 gate: a read budget of 2 still runs the plan and check.
        const executorId = instance.instanceId;
        if (!poolFor("audit").some((reader) => reader.instanceId !== executorId)) {
          return finish({ verdict: "stopped", stopReason: "An independent verification needs another eligible harness, so no workspace changes were sent." });
        }
        if (typeof turnsRemaining !== "number" || !Number.isFinite(turnsRemaining) || turnsRemaining < 1) {
          return finish({ verdict: "stopped", stopReason: "Verification needs one more authorized read turn, so no workspace changes were sent." });
        }
        if (typeof writeTurnsRemaining !== "number" || !Number.isFinite(writeTurnsRemaining) || writeTurnsRemaining < 1) {
          return finish({ verdict: "stopped", stopReason: "Workspace changes need an available authorized write turn, so no workspace changes were sent." });
        }
      }
      const harness = harnessOf(instance);
      const launchCommand = role === "review" && planText !== null ? withPlanText(command, planText) : command;
      try {
        assertContinuationPrompt(input, launchCommand.initialMessage.text);
      } catch (error) {
        if (!(error instanceof ContinuationPromptLimitError)) throw error;
        return finish({ verdict: "stopped", stopReason: `${error.message} The ${role} was not sent; earlier results and dispatch facts are retained.` });
      }
      if (replacementEvent) emitEvent?.({ ...replacementEvent });
      emitEvent?.({ kind: "started", role, instanceId: instance.instanceId, harness });
      launched.push(launchCommand);
      let result: CoordinateLaunchResult;
      if (write) {
        try {
          result = await transport.launch(launchCommand);
        } catch {
          // A rejected IPC transport is not proof that nothing was sent.
          // After a writer, preserve accumulated evidence rather than letting
          // a caller replace it with an empty unsent failure.
          result = {
            text: "", errorText: `The ${role} transport did not return a result, so its dispatch is unknown.`, dispatched: null,
          };
        }
      } else {
        result = await transport.launch(launchCommand);
      }
      const requested = normalizeRequestedPiCapacity(result.requestedPiCapacity);
      if (requested && instance.instanceId === "pi") requestedPiCapacity = requested;
      mergeDispatch(result.dispatched);
      turnsRemaining = result.turnsRemaining ?? null;
      if (write) writeTurnsRemaining = result.writeTurnsRemaining ?? null;
      // Partial execution/audit text is retained even on scope terminal stops.
      if (role === "execution" || role === "audit") saveText(role, result.text.trim());
      if (role === "execution") {
        if (result.executionEvidence) {
          executionEvidence = result.executionEvidence;
        }
        executionFacts = JSON.stringify({
          commandId: launchCommand.commandId, instanceId: instance.instanceId,
          workspace: input.workspacePath, sandbox: launchCommand.sandboxPolicy.type,
          dispatched: result.dispatched ?? null, stopCode: result.stopCode ?? null,
          turnsRemaining: result.turnsRemaining ?? null, writeTurnsRemaining: result.writeTurnsRemaining ?? null,
        });
      }
      if (result.scopeExhausted === true || result.stopCode === "scope-exhausted") {
        return finish({ stopReason: role === "execution"
          ? "All authorized workspace-change turns were used, so this stopped. Inspect any partial changes before sending again."
          : "All authorized model turns were used, so this stopped.", verdict: "failed", scopeExhausted: true });
      }
      if (result.stopCode === "scope-revoked") {
        return finish({ stopReason: result.errorText.trim() || "The authorized harness scope was revoked, so this stopped.", verdict: "failed" });
      }
      if (replacementEvent !== null) roundEvents.push(replacementEvent);
      const failure = failureFromLaunch(result, role, instance, write !== undefined);
      if (failure === null) {
        saveText(role, result.text.trim());
        used.add(usedKey(role, instance.instanceId));
        break;
      }
      failed.add(instance.instanceId);
      lastFailure = failure;
      if (failure.environment !== null) environmentBlocked = failure.environment;
      if (role !== "planning" || planText === null) saveText(role, result.text.trim());
      const failedEvent: RoundEvent = {
        kind: "failed", role, instanceId: failure.instanceId, harness: failure.harness,
        sentence: failure.sentence, ...(failure.detail === null ? {} : { detail: failure.detail }),
      };
      roundEvents.push(failedEvent);
      emitEvent?.({ ...failedEvent });
      // Write failures NEVER recover, even proven-not-sent ones. Unknown read
      // dispatch is also terminal; neither command nor instance is replayed.
      if (role !== "execution" && failure.continuable && (result.dispatched === true || result.dispatched === false)) {
        instance = undefined; command = undefined; recovering = true;
        continue;
      }
      return finish({ stopReason: role === "execution"
        ? `${failure.stopReason} Workspace changes were not retried; inspect any partial changes before sending again.`
        : failure.stopReason, verdict: "failed" });
    } while (recovering);
    if (role === "review") {
      const verdict = verdictFromReview(reviewText ?? "");
      if (!write || verdict !== "checked") return finish({
        stopReason: checkStopReason(verdict), verdict, result: reviewText,
      });
    }
  }
  const verdict = verdictFromAudit(auditText ?? "");
  return finish({ verdict, result: auditText,
    stopReason: verdict === "verified" ? "The independent harness verified the changes, so this stopped."
      : verdict === "revise" ? "The independent verification says the changes need revision, so this stopped."
      : verdict === "stopped" ? "The independent verification says to stop, so this stopped."
      : "The independent verification did not confirm the changes, so this stopped.",
  });
}

/**
 * The user sent a goal and wants the product to plan, check, and stop.
 * Without a scope this sends at most those two turns and never a third
 * implementation turn; with a scoped round (allowedInstances present) a
 * continuable harness failure hands the role to another authorized instance.
 */
export async function runCoordinateSession(
  input: CoordinateGoalInput,
  options: CoordinateSessionOptions,
  transport: CoordinateTransport,
): Promise<CoordinateSessionState> {
  const plannedInput = options.allowedInstances === undefined
    ? input
    : { ...input, allowedInstances: options.allowedInstances };
  const plan = coordinateGoal(plannedInput);
  if (plan.commands.length !== 2) return reportFromPlan(plan, { verdict: "stopped" });
  const planning = plan.commands[0];
  const review = plan.commands[1];
  if (!planning || !review || planning.modelSelection.instanceId === review.modelSelection.instanceId) {
    return reportFromPlan(
      { ...plan, commands: [], roles: [], result: null, planningHarness: null, reviewHarness: null },
      {
        verdict: "stopped",
        stopReason: "Stopped. An independent check needs a second logged-in harness, so no second role was assigned.",
      },
    );
  }
  if (!options.sendAuthorized) {
    return reportFromPlan(plan, {
      verdict: "stopped",
      stopReason: "Planning and review are assigned to two different harnesses. No model turn was sent, because this session is not authorized to spend subscription quota.",
    });
  }
  if (plannedInput.writeAuthorization !== undefined || options.allowedInstances !== undefined) {
    return runRecoveryRound(plannedInput, options, transport, plan);
  }
  return runLegacyRound(input, transport, plan, planning, review);
}
