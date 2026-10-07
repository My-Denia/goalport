import { authorizeCoordinateTurn, type CoordinateTurnCommand } from "./coordinateTurn";

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

export interface SyntheticCatalogInstance {
  readonly instanceId: string;
  readonly name: string;
  readonly defaultModel?: string;
  readonly models?: readonly (string | CatalogModel)[];
  readonly overageWindowIds?: readonly string[];
  readonly enabled?: boolean;
  readonly installed?: boolean;
  readonly authenticated?: boolean;
  readonly launchable?: boolean;
  readonly quota?: SyntheticQuota;
  readonly billing?: "subscription" | "paid-api" | "included";
}

export interface CoordinateGoalInput {
  readonly catalog: readonly SyntheticCatalogInstance[];
  readonly goal: string;
  readonly workspacePath: string;
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
  readonly roles: readonly ["planning", "review"] | readonly [];
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

function isUsable(instance: SyntheticCatalogInstance): boolean {
  if (instance.enabled === false) return false;
  if (instance.installed === false) return false;
  if (instance.authenticated === false) return false;
  if (instance.launchable === false) return false;
  if (instance.billing === "paid-api") return false;
  if (quotaWord(instance.quota) === "exhausted") return false;
  if (modelChoices(instance).length > 0 && publishedModel(instance).length === 0) return false;
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

function turnCommand(input: {
  commandId: string;
  instance: SyntheticCatalogInstance;
  workspacePath: string;
  text: string;
}): CoordinateTurnCommand {
  return {
    type: "goalport.coordinateTurn",
    commandId: input.commandId,
    projectId: "coordinate-project",
    modelSelection: { instanceId: input.instance.instanceId, model: publishedModel(input.instance) },
    runtimeMode: "approval-required",
    approvalPolicy: "never",
    sandboxPolicy: { type: "readOnly" },
    workspaceStrategy: { type: "existing_worktree", worktreePath: input.workspacePath },
    initialMessage: { text: input.text },
  };
}

/**
 * Pick two different catalog instances for a plan and a check.
 * The returned commands are not sent. A later session may send them.
 * Assigning both roles is not a completed review.
 */
export function coordinateGoal(input: CoordinateGoalInput): CoordinateGoalState {
  const unique = uniqueInstances(input.catalog);
  const quotaLabels = quotaLabelsFor(unique);
  const usable = unique.filter(isUsable);
  if (input.catalog.length === 0) {
    return stopped(
      quotaLabels,
      "Stopped. No harness catalog is connected, so no role was assigned.",
    );
  }
  if (usable.length < 2) {
    const credits = unique.some(creditsBlocked);
    return stopped(
      quotaLabels,
      credits
        ? "Stopped. A model that requires extra usage credits was not selected, and an independent check still needs a second harness with an included model."
        : "Stopped. An independent check needs a second logged-in harness, so no second role was assigned.",
    );
  }

  const planner = usable[0];
  const reviewer = usable[1];
  if (!planner || !reviewer || planner.instanceId === reviewer.instanceId) {
    return stopped(
      quotaLabels,
      "Stopped. An independent check needs a second logged-in harness, so no second role was assigned.",
    );
  }

  const planText = [
    input.goal,
    input.workspacePath,
    "Hand back a bounded plan without claiming the review passed.",
  ].join("\n");
  const reviewText = [
    input.goal,
    "The planner's done-claim is not a pass. Judge only whether the plan can be carried out.",
  ].join("\n");
  const commands = [
    turnCommand({ commandId: "coordinate-plan", instance: planner, workspacePath: input.workspacePath, text: planText }),
    turnCommand({ commandId: "coordinate-review", instance: reviewer, workspacePath: input.workspacePath, text: reviewText }),
  ] as const;

  for (const command of commands) {
    const authorization = authorizeCoordinateTurn(command);
    if (authorization.outcome !== "write-denied") {
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
    roles: ["planning", "review"],
    commands,
    quotaLabels,
  };
}
