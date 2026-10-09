import type { CoordinationView } from "./requestCoordination";

export type SavedPlan = CoordinationView & {
  requestId: string;
  goal: string;
  workspacePath: string;
  savedAt?: string | null;
};
