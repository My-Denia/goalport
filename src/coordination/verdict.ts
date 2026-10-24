export type CoordinationVerdict = "verified" | "checked" | "revise" | "stopped" | "failed" | "unconfirmed";

/**
 * The check counts as carried out only when its last line says so.
 * Prose, a planner's done-claim, and any other ending stay unconfirmed.
 */
export function verdictFromReview(text: string): CoordinationVerdict {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  const last = lines[lines.length - 1] ?? "";
  if (last === "VERDICT: carry-out") return "checked";
  if (last === "VERDICT: revise") return "revise";
  if (last === "VERDICT: stop") return "stopped";
  return "unconfirmed";
}

/** Only an independent post-execution audit may use these tokens. */
export function verdictFromAudit(text: string): CoordinationVerdict {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  const last = lines[lines.length - 1] ?? "";
  if (last === "VERDICT: verified") return "verified";
  if (last === "VERDICT: revise") return "revise";
  if (last === "VERDICT: stop") return "stopped";
  return "unconfirmed";
}

export function outcomeLabel(verdict: CoordinationVerdict | null): string {
  switch (verdict) {
    case "verified":
      return "Changes verified";
    case "checked":
      return "Can be carried out";
    case "revise":
      return "Needs revision";
    case "stopped":
      return "Stopped. No further turn was sent.";
    case "failed":
      return "Failed";
    case "unconfirmed":
      return "Not confirmed";
    case null:
      return "None";
    default: {
      const unreachable: never = verdict;
      return unreachable;
    }
  }
}
