// Fixture matrix for the Recommended v1 command-equivalence golden. The JSON
// next to it was captured from the engine BEFORE the workflow definition
// existed; it must never be regenerated from changed source.
import { backgroundEngineInput, type BackgroundJobStartInput } from "../backgroundJob";
import { catalogFromProviderSnapshots, type ProviderSnapshot } from "../catalogFromProviders";
import {
  coordinateGoal, evidenceCommand, replacementCommand,
  type CoordinateGoalInput, type SyntheticCatalogInstance,
} from "../coordinateGoal";
import type { CoordinateLaunchResult } from "../coordinateSession";
import type { CoordinateTurnCommand } from "../coordinateTurn";
import { requestCoordination } from "../requestCoordination";

const workspace = "/work/selected-goal";
const goal = "Explain the failure and leave a bounded plan.";
const selection = { provider: "Fixture", model: "alpha", useExistingCapacity: true as const };
const codex: SyntheticCatalogInstance = { instanceId: "codex", name: "Codex", billing: "subscription", models: ["default"] };
const claude: SyntheticCatalogInstance = { instanceId: "claude", name: "Claude", billing: "subscription", models: ["opus"] };
const pi: SyntheticCatalogInstance = {
  instanceId: "pi", name: "Pi", billing: "unknown", piCredentialKind: "apiKey-only", models: ["new-global-default"],
  piCapacity: { offer: { ...selection, model: "beta" }, catalog: [{ provider: "Fixture", model: "alpha" }, { provider: "Fixture", model: "beta" }] },
};
const quote: CoordinateGoalInput = { catalog: [codex, pi], goal, workspacePath: workspace, sendKey: "k-quote", allowedInstances: ["codex", "pi"], piCapacity: selection };
const read: CoordinateGoalInput = { catalog: [codex, claude], goal, workspacePath: workspace, sendKey: "k-read", allowedInstances: ["codex", "claude"] };
const write = { instances: ["codex"], workspaceRoot: workspace, remaining: 2 };
const feedback = {
  previousPlan: "Old plan", previousPlanReview: "Old review", previousExecutionReport: "Old report",
  previousExecutionAudit: "Old audit\nVERDICT: revise", previousCommandIds: ["coordinate-plan-x"],
};
const continuation = { parentRequestId: "parent-1", rootRequestId: "root-1", originalGoal: "Original goal", followUp: "Now do the follow-up." };

const dump = (commands: readonly CoordinateTurnCommand[]) => commands.map((c) => ({
  role: c.commandId.split("-")[1], instanceId: c.modelSelection.instanceId, commandId: c.commandId, text: c.initialMessage.text,
}));

const piSnapshot = { instanceId: "pi", auth: { status: "invalid_state", type: "apiKey" }, models: [{ slug: "default", isDefault: true }], piCapacity: { ...pi.piCapacity!, offer: selection } };
const providers = (second: "pi" | "claude") => [
  { instanceId: "codex", auth: { status: "authenticated", type: "subscription" }, models: [{ slug: "default", isDefault: true }] },
  second === "pi" ? piSnapshot : { instanceId: "claude", auth: { status: "authenticated", type: "subscription" }, models: [{ slug: "opus", isDefault: true }] },
] as unknown as readonly ProviderSnapshot[];

/** Drive the real engine with a scripted transport; verdictFor maps (role, nth) to the VERDICT line. */
async function chain(
  second: "pi" | "claude",
  extra: Record<string, unknown>,
  verdictFor: (role: string, nth: number) => string,
) {
  const seen: Record<string, number> = {};
  const commands: CoordinateTurnCommand[] = [];
  await requestCoordination({
    workspacePath: workspace, goal, sendKey: "k-chain", allowedInstances: ["codex", second],
    ...(second === "pi" ? { piCapacity: selection } : {}), ...extra,
  } as never, { connected: true, sendAuthorized: true, stopReason: null, providers: providers(second) }, {
    async launch(command) {
      commands.push(command);
      const role = command.commandId.split("-")[1];
      seen[role] = (seen[role] ?? 0) + 1;
      const result: CoordinateLaunchResult = {
        text: `${role} text ${seen[role]}\n${verdictFor(role, seen[role])}`.replace(/\n$/, ""), errorText: "", dispatched: true,
        turnsRemaining: 12, writeTurnsRemaining: 2,
      };
      return result;
    },
  });
  return dump(commands);
}
const verdict = (role: string, revise: boolean) =>
  role === "review" ? `VERDICT: ${revise ? "revise" : "carry-out"}` : role === "audit" ? `VERDICT: ${revise ? "revise" : "verified"}` : "";

export async function recommendedV1Scenarios(): Promise<Record<string, unknown>> {
  const backgroundStart: BackgroundJobStartInput = {
    requestId: "8f0b6a58-1c2d-4e3f-9a4b-5c6d7e8f9a0b", goal, workspaceRoot: workspace,
    readInstances: ["codex", "claude"], readMaxTurns: 4, backgroundConsent: true,
  };
  const bgCatalog = catalogFromProviderSnapshots(providers("claude"));
  const out: Record<string, unknown> = {
    quoteMode: dump(coordinateGoal(quote).commands),
    readMode: dump(coordinateGoal(read).commands),
    continuation: dump(coordinateGoal({ ...read, continuation }).commands),
    continuationQuote: dump(coordinateGoal({ ...quote, continuation }).commands),
    revisionRead: dump(coordinateGoal({ ...read, priorPlan: "Prior plan text", priorReview: "Prior review text\nVERDICT: revise" }).commands),
    revisionQuote: dump(coordinateGoal({ ...quote, priorPlan: "Prior plan text", priorReview: "Prior review text\nVERDICT: revise" }).commands),
    writeModeCommands: dump(coordinateGoal({ ...read, writeAuthorization: write }).commands),
    executeAndAudit: [
      dump([evidenceCommand("execute", codex, { ...read, writeAuthorization: write }, { planText: "Plan", reviewText: "VERDICT: carry-out" })]),
      dump([evidenceCommand("audit", claude, { ...read, writeAuthorization: write }, { planText: "Plan", reviewText: "VERDICT: carry-out", executionText: "Report" })]),
    ],
    piCapacityVariant: dump(coordinateGoal({ ...quote, sendKey: "k-cap", piCapacity: { ...selection, model: "beta" } }).commands),
    replacement: [
      dump([replacementCommand("plan", claude, read, "rep-1")]),
      dump([replacementCommand("plan", claude, read, "rep-1", "pi")]),
      dump([replacementCommand("plan", claude, read, "rep-1", "codex")]),
      dump([replacementCommand("review", pi, quote, "rep-2")]),
      dump([replacementCommand("review", claude, read, "rep-2")]),
    ],
    executionFeedbackRepair: dump(coordinateGoal({ ...read, sendKey: "k-chain:repair-1", writeAuthorization: write, executionFeedback: feedback }).commands),
    backgroundEngineInputCommands: dump(coordinateGoal({ ...backgroundEngineInput(backgroundStart), catalog: bgCatalog } as unknown as CoordinateGoalInput).commands),
    backgroundContinuationCommands: dump(coordinateGoal({
      ...backgroundEngineInput({ ...backgroundStart, continuation }), catalog: bgCatalog,
    } as unknown as CoordinateGoalInput).commands),
    chainReadQuote: await chain("pi", {}, (role) => verdict(role, false)),
    chainReadMode: await chain("claude", {}, (role) => verdict(role, false)),
    chainPlanRevision: await chain("claude", { writeAuthorization: write, beforePlanRevision: async () => true },
      (role, nth) => verdict(role, role === "review" && nth === 1)),
    chainRepair: await chain("claude", { writeAuthorization: write, beforeRepair: async () => true },
      (role, nth) => verdict(role, role === "audit" && nth === 1)),
  };
  return JSON.parse(JSON.stringify(out));
}
