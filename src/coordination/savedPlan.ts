import type { CoordinationView } from "./requestCoordination";

/**
 * One completed fact about a recovery round: a harness failure or a takeover
 * by another harness. "started" is deliberately not a kind here — it is a
 * transient onEvent only and never lands in a saved record.
 */
export interface RoundEvent {
  readonly kind: "failed" | "continued";
  readonly role: "planning" | "review" | "execution" | "audit";
  readonly instanceId: string;
  readonly harness: string | null;
  readonly sentence: string;
  readonly detail?: string | null;
}

export type SavedPlan = CoordinationView & {
  requestId: string;
  goal: string;
  workspacePath: string;
  savedAt?: string | null;
  /** Optional: records saved before recovery existed stay valid without it. */
  roundEvents?: readonly RoundEvent[];
};
