import type { PiCapacitySelection } from "../../electron/pi-capacity.mjs";
import type { LiveReadStatus } from "./liveRead";
import type { CoordinationView } from "./requestCoordination";
/** Read-only presentation facts. The host/store still decides admission. */
export interface BackgroundHeldWorkspaces {
  holds: readonly { jobId: string; workspacePath: string }[];
  complete: boolean;
  globalBlock: boolean;
  /** Present only for a candidate-bound host check; echoed without normalization. */
  candidate?: string;
  candidateBlocked?: boolean;
}

/** Permission-free IPC projection. Controls require a fresh acknowledged connection. */
export interface BackgroundStatus {
  readonly piCapacity?: PiCapacitySelection;
  jobId: string;
  requestId: string;
  followUpMode?: "live-read-once";
  /** Validated accepted input identity, not readiness or a budget. */
  acceptedRequestId?: string;
  phase?: string | null;
  liveRead?: LiveReadStatus;
  goal: string;
  state: "admitted" | "running" | "revoked" | "completed" | "failed" | "stopped" | "unconfirmed";
  active: boolean;
  live: boolean;
  revoked: boolean;
  workerPid: number | null;
  /** Workspace this job was admitted against. Older projections may omit it. */
  workspacePath?: string;
  /** Set when the user left an interrupted job so a different send can start. */
  acknowledgedStuckAt?: string | null;
  readMaxTurns: number;
  writeMaxTurns: number | null;
  counters: { readTurnsLeft?: number | null; writeTurnsLeft?: number | null } | null;
  pendingCommand: { commandId: string; state: string } | null;
  completedCommands: readonly { commandId: string; facts: { text?: string; dispatched?: boolean | null } }[];
  progress: { activity?: string; failures?: readonly string[]; repair?: boolean; planRevision?: boolean; firstRound?: CoordinationView } | null;
  outcome: { status: string; report?: CoordinationView; error?: string; allowanceEnd?: "idle-stopped" | "expired" } | null;
}
