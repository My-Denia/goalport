import type { ExecutionWorkspaceEvidence, AuditInputEvidenceCoverage } from "./coordinateGoal";
import type { CoordinationView } from "./requestCoordination";
import type { CoordinationVerdict } from "./verdict";

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

/**
 * Completed evidence for a prior pass in the same Send. These are report
 * facts only: they never include budgets, scope generations, memberships, or
 * permission state. commandIds are references to completed turns, not replay
 * instructions. A fact may be retained as feedbackHistory (the pass before
 * the one automatic repair) or as planRevisionHistory (the original
 * plan-rejected pass before the one revised chain) — one entry each, and a
 * retained fact never becomes permission for another turn.
 */
export interface CoordinationRoundFact {
  readonly planningHarness: string | null;
  readonly reviewHarness: string | null;
  readonly planText: string | null;
  readonly reviewText: string | null;
  readonly executionText: string | null;
  readonly auditText: string | null;
  readonly executionHarness: string | null;
  readonly auditHarness: string | null;
  readonly result: string | null;
  readonly verdict: CoordinationVerdict | null;
  readonly stopReason: string;
  readonly executionEvidence?: ExecutionWorkspaceEvidence | null;
  readonly auditInputEvidenceCoverage?: AuditInputEvidenceCoverage | null;
  readonly auditInputEvidenceText?: string | null;
  /** Dispatch state for this pass only; SavedPlan.messageDispatched is Send-wide. */
  readonly messageDispatched: boolean | null;
  /** Completed recovery facts only; transient started events are never stored. */
  readonly roundEvents?: readonly RoundEvent[];
  readonly commandIds: readonly string[];
}

export type SavedPlan = CoordinationView & {
  requestId: string;
  goal: string;
  workspacePath: string;
  savedAt?: string | null;
  /** Optional: records saved before recovery existed stay valid without it. */
  roundEvents?: readonly RoundEvent[];
  // feedbackHistory and planRevisionHistory are inherited from
  // CoordinationView: only completed earlier passes are retained (at most one
  // entry each), and top-level result fields are always the latest pass.
};
