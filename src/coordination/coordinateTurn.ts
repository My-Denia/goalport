import { acpPermissionDisposition } from "./AcpClientPolicy";

/**
 * Local command for one plan or check turn.
 * `runtimeMode` and `sandboxPolicy.type` are literals. This module does not
 * spawn a process and does not boot a server.
 */
export interface CoordinateTurnCommand {
  readonly type: "goalport.coordinateTurn";
  readonly commandId: string;
  readonly projectId: string;
  readonly modelSelection: { readonly instanceId: string; readonly model: string };
  readonly runtimeMode: "approval-required";
  readonly approvalPolicy: "never";
  readonly sandboxPolicy: { readonly type: "readOnly" };
  readonly workspaceStrategy:
    | { readonly type: "root"; readonly branch?: string }
    | { readonly type: "existing_worktree"; readonly worktreePath: string; readonly branch?: string };
  readonly initialMessage: { readonly text: string };
}

export type CoordinateTurnAuthorization =
  | { readonly outcome: "stopped"; readonly reason: string }
  | { readonly outcome: "write-denied"; readonly disposition: "deny" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function commandCwd(input: Record<string, unknown>): string {
  const strategy = input.workspaceStrategy;
  if (isRecord(strategy) && strategy.type === "existing_worktree" && typeof strategy.worktreePath === "string") {
    const worktreePath = strategy.worktreePath.trim();
    if (worktreePath.length > 0) return worktreePath;
  }
  if (typeof input.projectId === "string" && input.projectId.trim().length > 0) return input.projectId;
  return ".";
}

/**
 * Refuse a command that is not the audited read-only coordinate turn.
 * A valid command is checked as an edit. Anything other than deny stops.
 * Write-denied is the gate result; it is not a completed provider turn.
 */
export function authorizeCoordinateTurn(input: unknown): CoordinateTurnAuthorization {
  if (!isRecord(input)) {
    return { outcome: "stopped", reason: "The command is missing." };
  }
  if (input.type === "message.dispatch") {
    return { outcome: "stopped", reason: "A prompt-only message.dispatch cannot refuse writes." };
  }
  if (input.type !== "goalport.coordinateTurn") {
    return { outcome: "stopped", reason: "The command is not a coordinate turn." };
  }
  if (input.runtimeMode !== "approval-required") {
    return { outcome: "stopped", reason: "runtimeMode must be approval-required." };
  }
  if (input.approvalPolicy !== "never") {
    return {
      outcome: "stopped",
      reason: "approvalPolicy must be never. approval-required alone asks for every read.",
    };
  }
  if (!isRecord(input.sandboxPolicy) || input.sandboxPolicy.type !== "readOnly") {
    return { outcome: "stopped", reason: "sandboxPolicy.type must be readOnly." };
  }

  const disposition = acpPermissionDisposition(
    {
      runtimeMode: "approval-required",
      sandboxPolicy: { type: "readOnly" },
      cwd: commandCwd(input),
      approvalPolicy: undefined,
    },
    { toolCall: { kind: "edit", locations: undefined } },
  );
  if (disposition !== "deny") {
    return { outcome: "stopped", reason: "The edit disposition was not deny." };
  }
  return { outcome: "write-denied", disposition: "deny" };
}
