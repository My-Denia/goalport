import {
  coordinateGoal,
  eligibleInstances,
  replacementCommand,
  type CoordinateGoalInput,
  type CoordinateGoalState,
  type SyntheticCatalogInstance,
} from "./coordinateGoal";
import type { CoordinateTurnCommand } from "./coordinateTurn";
import { classifyProviderError, environmentSignature, providerErrorSentence } from "./providerError";
import { verdictFromReview, type CoordinationVerdict } from "./verdict";
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

export interface CoordinateLaunchResult {
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
  readonly scopeExhausted?: boolean;
}

export interface EnvironmentBlockedInfo {
  readonly role: "planning" | "review";
  readonly instanceId: string;
  readonly harness: string | null;
  readonly detail: string | null;
}

export type CoordinationRole = "planning" | "review";

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
  readonly planText: string | null;
  readonly reviewText: string | null;
  readonly verdict: CoordinationVerdict | null;
  readonly messageDispatched: boolean | null;
  readonly environmentBlocked?: EnvironmentBlockedInfo | null;
  /** Completed failure and takeover facts only — started is never persisted. */
  readonly roundEvents: readonly RoundEvent[];
  /** Scope budget after the last launch; absent on rounds without a scope. */
  readonly authorizedTurnsLeft?: number | null;
  /** True when the authorized scope ran out of model turns. */
  readonly scopeExhausted?: boolean;
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
  role: "planning" | "review",
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

  const checked = await transport.launch(withPlanText(review, planText));
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
  return role === "planning" ? "planning" : "checking";
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
 * refusals — never lands in a continuable class. Returns null for a success.
 */
function failureFromLaunch(
  launch: CoordinateLaunchResult,
  role: CoordinationRole,
  instance: SyntheticCatalogInstance,
): Failure | null {
  const harness = harnessOf(instance);
  const errorText = launch.errorText.trim();
  if (
    launch.environmentBlocked !== true
    && launch.stopCode == null
    && errorText.length === 0
    && launch.text.trim().length > 0
  ) return null;

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
 * two roles, each instance at most once.
 */
async function runRecoveryRound(
  input: CoordinateGoalInput,
  options: CoordinateSessionOptions,
  transport: CoordinateTransport,
  plan: CoordinateGoalState,
): Promise<CoordinateSessionState> {
  const allowed = options.allowedInstances;
  const emitEvent = options.onEvent;
  const failed = new Set<string>();
  const used = new Set<string>();
  const roundEvents: RoundEvent[] = [];
  const launched: CoordinateTurnCommand[] = [];
  const assignments: { planning?: SyntheticCatalogInstance; review?: SyntheticCatalogInstance } = {};
  const commands: { planning?: CoordinateTurnCommand; review?: CoordinateTurnCommand } = {
    planning: plan.commands[0],
    review: plan.commands[1],
  };
  const instanceFor = (command: CoordinateTurnCommand | undefined) =>
    command
      ? input.catalog.find((item) => item.instanceId === command.modelSelection.instanceId)
      : undefined;
  assignments.planning = instanceFor(commands.planning);
  assignments.review = instanceFor(commands.review);
  let planText: string | null = null;
  let reviewText: string | null = null;
  let environmentBlocked: EnvironmentBlockedInfo | null = null;
  let lastFailure: Failure | null = null;
  let turnsRemaining: number | null | undefined;
  let dispatchState: "unsent" | "sent" | "unknown" = "unsent";

  const mergeDispatch = (value: boolean | null | undefined) => {
    if (value === true) dispatchState = "sent";
    else if (value === false) dispatchState = dispatchState === "unsent" ? "unsent" : dispatchState;
    else if (dispatchState === "unsent") dispatchState = "unknown";
  };
  const messageDispatched = () => (dispatchState === "sent" ? true : dispatchState === "unknown" ? null : false);
  const remainingPool = (exclude: Iterable<string>) =>
    eligibleInstances(input.catalog, {
      avoidInstances: input.avoidInstances,
      allowedInstances: allowed,
      exclude: [...exclude],
    });

  const finish = (fields: {
    stopReason: string;
    verdict: CoordinationVerdict;
    result?: string | null;
    scopeExhausted?: boolean;
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
      roles: planning && review ? (["planning", "review"] as const) : ([] as const),
      commands: launched,
      quotaLabels: plan.quotaLabels,
      planText,
      reviewText,
      verdict: fields.verdict,
      messageDispatched: messageDispatched(),
      environmentBlocked,
      roundEvents,
      ...(turnsRemaining === undefined ? {} : { authorizedTurnsLeft: turnsRemaining }),
      ...(fields.scopeExhausted === undefined ? {} : { scopeExhausted: fields.scopeExhausted }),
    };
  };

  for (let roleIndex = 0; roleIndex < ROLES.length; roleIndex += 1) {
    const role = ROLES[roleIndex] as CoordinationRole;
    let instance = assignments[role];
    let command = commands[role];
    // A takeover may have promoted this role's instance to an earlier role
    // (or failed it); re-select before launching so independence and
    // per-instance-once hold.
    if (instance && (failed.has(instance.instanceId) || used.has(instance.instanceId))) {
      instance = undefined;
      command = undefined;
    }
    let recovering = false;
    do {
      recovering = false;
      let replacementEvent: RoundEvent | null = null;
      if (!instance || !command) {
        // Chain-completeness pre-check, before every replacement launch: the
        // remaining pool must still staff this role and every remaining role
        // with distinct instances. If it cannot, stop without launching.
        const candidates = remainingPool([...failed, ...used]);
        const remainingRoles = ROLES.length - roleIndex;
        if (candidates.length < remainingRoles) {
          return finish({
            stopReason: lastFailure?.environment
              ? `Stopped. ${lastFailure.harness} cannot run on this machine right now, and an independent check needs two harnesses that can run.`
              : lastFailure?.stopReason
                ?? "Stopped. An independent check needs a second logged-in harness, so no second role was assigned.",
            verdict: "failed",
          });
        }
        const replacement = candidates[0] as SyntheticCatalogInstance;
        instance = replacement;
        command = replacementCommand(role === "planning" ? "plan" : "review", replacement, input, input.sendKey);
        commands[role] = command;
        assignments[role] = replacement;
        const harness = harnessOf(replacement);
        const sentence = `${harness} is ${roleLabel(role)} instead.`;
        replacementEvent = { kind: "continued", role, instanceId: replacement.instanceId, harness, sentence };
        emitEvent?.({ ...replacementEvent });
      }
      const harness = harnessOf(instance);
      emitEvent?.({ kind: "started", role, instanceId: instance.instanceId, harness });
      const launchCommand = role === "review" && planText !== null ? withPlanText(command, planText) : command;
      launched.push(launchCommand);
      const result = await transport.launch(launchCommand);
      mergeDispatch(result.dispatched);
      turnsRemaining = result.turnsRemaining ?? null;

      // Budget and revocation stops never auto-continue; the scope layer has
      // the authority here, not the harness classification.
      if (result.scopeExhausted === true || result.stopCode === "scope-exhausted") {
        return finish({
          stopReason: "All authorized model turns were used, so this stopped.",
          verdict: "failed",
          scopeExhausted: true,
        });
      }
      if (result.stopCode === "scope-revoked") {
        return finish({
          stopReason: result.errorText.trim() || "The authorized harness scope was revoked, so this stopped.",
          verdict: "failed",
        });
      }
      // A takeover becomes a persistent fact only once the replacement launch
      // returns as a completed turn result. A budget/revocation refusal above
      // is transient and must not claim that the round actually continued.
      if (replacementEvent !== null) roundEvents.push(replacementEvent);

      const failure = failureFromLaunch(result, role, instance);
      if (failure === null) {
        const text = result.text.trim();
        if (role === "planning") {
          planText = text;
          used.add(instance.instanceId);
        } else {
          reviewText = text;
        }
        break;
      }
      failed.add(instance.instanceId);
      lastFailure = failure;
      if (failure.environment !== null) environmentBlocked = failure.environment;
      if (result.text.trim().length > 0) {
        if (role === "planning" && planText === null) planText = result.text.trim();
        if (role === "review") reviewText = result.text.trim();
      }
      const failedEvent: RoundEvent = {
        kind: "failed",
        role,
        instanceId: failure.instanceId,
        harness: failure.harness,
        sentence: failure.sentence,
        ...(failure.detail === null ? {} : { detail: failure.detail }),
      };
      roundEvents.push(failedEvent);
      emitEvent?.({ ...failedEvent });
      // The dispatch tri-state gates the takeover: a known-sent classified
      // failure or a proven-not-sent one may continue; unknown (null/absent)
      // never does — the turn may have reached the provider.
      if (failure.continuable && (result.dispatched === true || result.dispatched === false)) {
        // Never retry this instance or its command id. Leave the failed
        // assignment available for the report, but force the next iteration
        // through the replacement pool before another launch.
        instance = undefined;
        command = undefined;
        recovering = true;
        continue;
      }
      return finish({ stopReason: failure.stopReason, verdict: "failed" });
    } while (recovering);
  }

  const verdict = verdictFromReview(reviewText ?? "");
  return finish({
    stopReason: checkStopReason(verdict),
    verdict,
    result: reviewText !== null && reviewText.length > 0 ? reviewText : null,
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
  if (options.allowedInstances !== undefined) {
    return runRecoveryRound(plannedInput, options, transport, plan);
  }
  return runLegacyRound(input, transport, plan, planning, review);
}
