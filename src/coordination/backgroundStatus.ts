import type { CoordinationView } from "./requestCoordination";
/** Permission-free IPC projection. Controls require a fresh acknowledged connection. */
export interface BackgroundStatus {
  jobId: string;
  requestId: string;
  goal: string;
  state: "admitted" | "running" | "revoked" | "completed" | "failed" | "stopped" | "unconfirmed";
  active: boolean;
  live: boolean;
  revoked: boolean;
  workerPid: number | null;
  readMaxTurns: number;
  writeMaxTurns: number | null;
  counters: { readTurnsLeft?: number | null; writeTurnsLeft?: number | null } | null;
  pendingCommand: { commandId: string; state: string } | null;
  completedCommands: readonly { commandId: string; facts: { text?: string; dispatched?: boolean | null } }[];
  progress: { activity?: string; failures?: readonly string[]; repair?: boolean; firstRound?: CoordinationView } | null;
  outcome: { status: string; report?: CoordinationView; error?: string } | null;
}
