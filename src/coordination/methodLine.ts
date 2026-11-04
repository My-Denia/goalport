import type { CoordinationVerdict } from "./verdict";

/** Which workflow definition a coordinated result ran under. */
export interface WorkflowRef {
  readonly id: string;
  readonly version: number;
  /** The name the user knows it by; absent on older records. */
  readonly name?: string;
  /** What actually happened: "off" only when review did not run because the definition says so. */
  readonly planReview?: "on" | "off";
}

/** One check whose reply actually came back. Absence means it did not run. */
export interface CheckRan {
  readonly kind: "plan-check" | "audit";
  readonly harness: string;
  readonly verdict: CoordinationVerdict | null;
}

const RECOMMENDED_NAME = "Recommended workflow";
// "Independent verification" is the word the result page already uses for the audit step.
const KIND_WORDS: Readonly<Record<CheckRan["kind"], string>> = { "plan-check": "plan check", audit: "verification" };

/** One honest line of what ran; null when the method is unknown, so nothing is guessed. No verdict words. */
export function methodLine(workflow: WorkflowRef | null | undefined, checksRan: readonly CheckRan[] | null | undefined): string | null {
  const name = workflow ? (workflow.name?.trim() || (workflow.id === "recommended" ? RECOMMENDED_NAME : "")) : "";
  if (!workflow || !name || !checksRan) return null; // absent checksRan is unknown, not "none ran"
  if (workflow.planReview === "off") return `${name} v${workflow.version} · Independent review: not run (off in ${name})`;
  const ran = [...new Set(checksRan.map((check) => `${KIND_WORDS[check.kind]} by ${check.harness}`))];
  return `${name} v${workflow.version} · ${ran.length === 0 ? "No check ran" : `Ran: ${ran.join(", ")}`}`;
}
