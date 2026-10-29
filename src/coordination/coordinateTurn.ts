import { acpPermissionDisposition } from "./AcpClientPolicy";

/**
 * Local command for one coordination turn. `runtimeMode` is a literal;
 * `sandboxPolicy.type` is the closed two-value literal (readOnly for plan,
 * review and audit; workspaceWrite for explicitly authorized execute turns).
 * This module does not spawn a process and does not boot a server.
 */
export interface CoordinateTurnCommand {
  readonly type: "goalport.coordinateTurn";
  readonly commandId: string;
  readonly projectId: string;
  readonly modelSelection: { readonly instanceId: string; readonly model: string };
  readonly runtimeMode: "approval-required";
  readonly approvalPolicy: "never";
  readonly sandboxPolicy: { readonly type: "readOnly" | "workspaceWrite" };
  readonly workspaceStrategy:
    | { readonly type: "root"; readonly branch?: string }
    | { readonly type: "existing_worktree"; readonly worktreePath: string; readonly branch?: string };
  readonly initialMessage: { readonly text: string };
  /** Narrow runtime selector, not permission or descriptive coverage. */
  readonly promptDelivery?: "stdin";
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

/** The closed coordination turn family; the commandId prefix names the role. */
export type CoordinateTurnRole = "plan" | "review" | "execute" | "audit";

// The one canonical role rule, twin of the electron leaf's roleOfCommandId.
// Anything outside the closed prefixes classifies as null and must be
// refused wherever a role matters.
const ROLE_PREFIX = /^coordinate-(plan|review|execute|audit)-/;

export function roleOfCommandId(commandId: unknown): CoordinateTurnRole | null {
  const match = ROLE_PREFIX.exec(typeof commandId === "string" ? commandId : "");
  // The capture group is total over the four literals, so the cast cannot
  // produce a value outside CoordinateTurnRole.
  return match ? (match[1] as CoordinateTurnRole) : null;
}

export type CoordinateWriteTurnAuthorization =
  | { readonly outcome: "stopped"; readonly reason: string }
  | { readonly outcome: "write-authorized"; readonly role: CoordinateTurnRole };

// Absolute-path shape without node:path: a leading separator, or a Windows
// drive or UNC prefix. Shape only — never resolution; the pinned-root
// resolve-equality for write turns lives at the scope's budget authority in
// the main process.
function isAbsoluteWorktreePathShape(text: string): boolean {
  return /^[/\\]/.test(text) || /^[A-Za-z]:[/\\]/.test(text);
}

/**
 * Pure shape validation for a turn inside an explicitly write-authorized
 * round. Checks the type and runtime literals, the role↔sandbox pairing in
 * both directions (execute ⇒ workspaceWrite; plan/review/audit ⇒ readOnly)
 * and an existing worktree with a non-empty absolute path. NO filesystem,
 * process or ACP probes: the renderer is sandboxed, and every fs-backed
 * check — the electron write guard and the scope's root equality — lives in
 * the main process. Root shape validation is authorization binding, not
 * physical confinement.
 */
export function authorizeCoordinateWriteTurn(input: unknown): CoordinateWriteTurnAuthorization {
  if (!isRecord(input)) {
    return { outcome: "stopped", reason: "The command is missing." };
  }
  if (input.type !== "goalport.coordinateTurn") {
    return { outcome: "stopped", reason: "The command is not a coordinate turn." };
  }
  const role = roleOfCommandId(input.commandId);
  if (!role) {
    return { outcome: "stopped", reason: "The command id does not name a coordination turn role." };
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
  const sandboxType = isRecord(input.sandboxPolicy) ? input.sandboxPolicy.type : undefined;
  if (role === "execute") {
    if (sandboxType !== "workspaceWrite") {
      return { outcome: "stopped", reason: "An execution turn must use workspaceWrite." };
    }
  } else if (sandboxType !== "readOnly") {
    return { outcome: "stopped", reason: "A plan, check, or verification turn must stay readOnly." };
  }
  const strategy = input.workspaceStrategy;
  const worktreePath = isRecord(strategy) && typeof strategy.worktreePath === "string" ? strategy.worktreePath.trim() : "";
  if (!isRecord(strategy) || strategy.type !== "existing_worktree" || worktreePath.length === 0) {
    return { outcome: "stopped", reason: "A write-authorized turn must run in an existing worktree." };
  }
  if (!isAbsoluteWorktreePathShape(worktreePath)) {
    return { outcome: "stopped", reason: "A write-authorized turn needs an absolute worktree path." };
  }
  return { outcome: "write-authorized", role };
}
