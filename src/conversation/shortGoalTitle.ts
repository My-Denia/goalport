/**
 * Shared display-only short goal summary for title bars and conversation headings.
 * Displays up to 48 characters, taking the first non-empty line.
 * The full goal is preserved in accessible labels, tooltips, and outgoing payloads.
 */
export function shortGoalTitle(goal: string | null | undefined, maxLength = 48): string {
  if (!goal || typeof goal !== "string") return "";
  const trimmed = goal.trim();
  if (!trimmed) return "";
  const firstLine = trimmed.split(/\r?\n/)[0].trim();
  const characters = Array.from(firstLine);
  if (characters.length <= maxLength) return firstLine;
  return `${characters.slice(0, Math.max(0, maxLength - 3)).join("")}...`;
}
