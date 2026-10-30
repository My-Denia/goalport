/**
 * Node-compatible entry for the detached background worker bundle
 * (dist/coordination-engine.cjs, built by vite.coordination.config.ts).
 *
 * This file deliberately re-exports the SAME requestCoordination
 * implementation the renderer window uses — there is no second role
 * scheduler. The engine graph (requestCoordination, coordinateGoal,
 * coordinateSession) is free of React and browser-only runtime imports, so
 * the bundle needs no renderer plugin; node builtins used by the CLI policy
 * code stay external because the worker runs in Node.
 */
export { requestCoordination } from "./requestCoordination";
export { prepareNativeWorkspaceCheckMaterial, buildNativeWorkspaceCheckCommand } from "./nativeWorkspaceCheck";
import { coordinateGoal } from "./coordinateGoal";
import { catalogFromProviderSnapshots, type ProviderSnapshot } from "./catalogFromProviders";
import { backgroundEngineInput, type BackgroundJobStartInput } from "./backgroundJob";
/** Pure assembly of the SAME engine input; does not launch or authorize. */
export function preflightBackgroundContinuation(input: BackgroundJobStartInput, providers: readonly ProviderSnapshot[]): void {
  const assembled = coordinateGoal({ ...backgroundEngineInput(input), catalog: catalogFromProviderSnapshots(providers) });
  if (assembled.commands.length !== 2) throw new Error(assembled.stopReason);
}
export type {
  CoordinationDiscovery,
  CoordinationView,
  PlanRevisionCheckpoint,
  RepairCheckpoint,
} from "./requestCoordination";
export type {
  CoordinateLaunchResult,
  CoordinateSessionEvent,
  CoordinateTransport,
} from "./coordinateSession";
export {
  BACKGROUND_PLAN_REVISION_REFUSAL_SENTENCE,
  BACKGROUND_REPAIR_REFUSAL_SENTENCE,
  backgroundEngineInput,
  backgroundJobKey,
  backgroundJobSentence,
  backgroundStartRefusal,
} from "./backgroundJob";
export type {
  BackgroundEngineInput,
  BackgroundJobCounters,
  BackgroundJobPhase,
  BackgroundJobProjection,
  BackgroundJobStartInput,
  BackgroundJobWriteScope,
} from "./backgroundJob";
export type {
  SavedTargetContinuation,
  SavedTargetRelationStatus,
} from "./continuation";
