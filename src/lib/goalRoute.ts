/** The goal on this page. Refresh reads it back; Core's shared selection does not. */

const GOAL_PREFIX = "/goals/";

export type CoordinatedRoute = { kind: "new" } | { kind: "result"; requestId: string } | { kind: "unavailable" };
export function coordinatedRouteFromLocation(location: Pick<Location, "hash"> = window.location): CoordinatedRoute | null {
  const hash = location.hash;
  if (!hash.startsWith("#coordinated")) return null;
  if (hash === "#coordinated/new") return { kind: "new" };
  if (!hash.startsWith("#coordinated/result/")) return { kind: "unavailable" };
  try {
    const requestId = decodeURIComponent(hash.slice("#coordinated/result/".length));
    return /^[A-Za-z0-9._-]{1,256}$/.test(requestId) ? { kind: "result", requestId } : { kind: "unavailable" };
  } catch { return { kind: "unavailable" }; }
}

export function setCoordinatedRoute(route: CoordinatedRoute, replace = false): void {
  const hash = route.kind === "new" ? "#coordinated/new" : route.kind === "result" ? `#coordinated/result/${encodeURIComponent(route.requestId)}` : "#coordinated/unavailable";
  if (window.location.hash === hash) return;
  window.history[replace ? "replaceState" : "pushState"](null, "", `${window.location.pathname}${window.location.search}${hash}`);
}

export function campaignIdFromLocation(location: Pick<Location, "pathname"> = window.location): string | null {
  const path = location.pathname;
  if (!path.startsWith(GOAL_PREFIX)) return null;
  try {
    const id = decodeURIComponent(path.slice(GOAL_PREFIX.length).split("/")[0] ?? "");
    return id.startsWith("campaign-") ? id : null;
  } catch { return null; }
}

export function goalPath(campaignId: string | null): string {
  return campaignId ? `${GOAL_PREFIX}${encodeURIComponent(campaignId)}` : "/";
}

export function replaceGoalRoute(campaignId: string | null): void {
  const next = goalPath(campaignId);
  if (coordinatedRouteFromLocation() !== null) return;
  if (`${window.location.pathname}${window.location.search}` === next) return;
  window.history.replaceState(null, "", next);
}

export function pushGoalRoute(campaignId: string): void {
  const next = goalPath(campaignId);
  if (window.location.pathname === next && !window.location.hash) return;
  window.history.pushState(null, "", next);
}
