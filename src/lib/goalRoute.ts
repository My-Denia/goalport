/** The goal on this page. Refresh reads it back; Core's shared selection does not. */

const GOAL_PREFIX = "/goals/";

export function campaignIdFromLocation(location: Pick<Location, "pathname"> = window.location): string | null {
  const path = location.pathname;
  if (!path.startsWith(GOAL_PREFIX)) return null;
  const id = decodeURIComponent(path.slice(GOAL_PREFIX.length).split("/")[0] ?? "");
  return id.startsWith("campaign-") ? id : null;
}

export function goalPath(campaignId: string | null): string {
  return campaignId ? `${GOAL_PREFIX}${encodeURIComponent(campaignId)}` : "/";
}

export function replaceGoalRoute(campaignId: string | null): void {
  const next = goalPath(campaignId);
  if (`${window.location.pathname}${window.location.search}` === next) return;
  window.history.replaceState(null, "", next);
}

export function pushGoalRoute(campaignId: string): void {
  const next = goalPath(campaignId);
  if (window.location.pathname === next) return;
  window.history.pushState(null, "", next);
}
