import type { SyntheticCatalogInstance, SyntheticQuota } from "./coordinateGoal";

export interface ProviderSnapshotModel {
  readonly slug?: unknown;
  readonly name?: unknown;
  readonly isDefault?: unknown;
  readonly isLegacy?: unknown;
}

export interface ProviderSnapshot {
  readonly instanceId?: unknown;
  readonly displayName?: unknown;
  readonly driver?: unknown;
  readonly enabled?: unknown;
  readonly installed?: unknown;
  readonly availability?: unknown;
  readonly status?: unknown;
  readonly auth?: { readonly status?: unknown; readonly type?: unknown; readonly label?: unknown };
  readonly models?: readonly ProviderSnapshotModel[];
  readonly usageLimits?: {
    readonly unavailable?: unknown;
    readonly windows?: readonly { readonly id?: unknown; readonly usedPercent?: unknown }[];
  };
  /** Persisted harness-health evidence merged into the snapshot by discovery. */
  readonly environmentHealth?: unknown;
}

function modelSpecificWindow(id: unknown): boolean {
  return typeof id === "string" && id.startsWith("seven_day_") && id !== "seven_day";
}

function quotaFromSnapshot(snapshot: ProviderSnapshot): SyntheticQuota {
  const limits = snapshot.usageLimits;
  const windows = limits?.windows ?? [];
  if (limits === undefined || limits.unavailable !== undefined || windows.length === 0) return "unknown";
  const providerWide = windows.filter((window) => !modelSpecificWindow(window.id));
  if (providerWide.length === 0) return "unknown";
  if (providerWide.some((window) => typeof window.usedPercent === "number" && window.usedPercent >= 100)) {
    return "exhausted";
  }
  return "available";
}

/**
 * Health evidence maps to the catalog's avoided marker: a well-formed record
 * keeps its since/detail, a malformed one degrades to null (blocked-by-shape
 * is never guessed), and a snapshot without the field leaves the catalog
 * exactly as it was before this field existed.
 */
function environmentAvoidedOf(
  snapshot: ProviderSnapshot,
): { since: string; detail: string } | null | undefined {
  if (!("environmentHealth" in snapshot)) return undefined;
  const health = snapshot.environmentHealth as { since?: unknown; detail?: unknown } | null | undefined;
  if (typeof health !== "object" || health === null) return null;
  const since = typeof health.since === "string" ? health.since.trim() : "";
  const detail = typeof health.detail === "string" ? health.detail.trim() : "";
  if (since.length === 0 || detail.length === 0) return null;
  return { since, detail };
}

function confirmedSubscription(type: unknown): boolean {
  return type === "chatgpt" || type === "subscription";
}

function billing(snapshot: ProviderSnapshot): SyntheticCatalogInstance["billing"] {
  if (snapshot.auth?.type === "apiKey") return "paid-api";
  if (typeof snapshot.auth?.label === "string" && snapshot.auth.label.toLowerCase().includes("api key")) {
    return "paid-api";
  }
  if (confirmedSubscription(snapshot.auth?.type)) return "subscription";
  return "unknown";
}

export function catalogFromProviderSnapshots(
  providers: readonly ProviderSnapshot[],
): SyntheticCatalogInstance[] {
  return providers.flatMap((snapshot) => {
    if (typeof snapshot.instanceId !== "string" || snapshot.instanceId.trim().length === 0) return [];
    const models = (snapshot.models ?? []).flatMap((model) => {
      if (typeof model.slug !== "string" || model.slug.trim().length === 0) return [];
      return [{
        slug: model.slug,
        name: typeof model.name === "string" ? model.name : model.slug,
        isDefault: model.isDefault === true,
        legacy: model.isLegacy === true,
      }];
    });
    const overageWindowIds = (snapshot.usageLimits?.windows ?? []).flatMap((window) =>
      typeof window.id === "string" ? [window.id] : [],
    );
    const environmentAvoided = environmentAvoidedOf(snapshot);
    return [{
      instanceId: snapshot.instanceId,
      name: typeof snapshot.displayName === "string" && snapshot.displayName.trim().length > 0
        ? snapshot.displayName
        : typeof snapshot.driver === "string"
          ? snapshot.driver
          : snapshot.instanceId,
      models,
      overageWindowIds,
      enabled: snapshot.enabled !== false,
      installed: snapshot.installed !== false,
      authenticated: snapshot.auth?.status === "authenticated",
      launchable: snapshot.availability !== "unavailable" && snapshot.status !== "disabled" && snapshot.status !== "error",
      quota: quotaFromSnapshot(snapshot),
      billing: billing(snapshot),
      ...(environmentAvoided === undefined ? {} : { environmentAvoided }),
    } satisfies SyntheticCatalogInstance];
  });
}
