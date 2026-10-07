import { describe, expect, it } from "vitest";
import { acpPermissionDisposition } from "./AcpClientPolicy";
import { authorizeCoordinateTurn } from "./coordinateTurn";

const policy = {
  runtimeMode: "approval-required" as const,
  sandboxPolicy: { type: "readOnly" as const },
  cwd: "/work/selected",
  approvalPolicy: undefined,
};

function validCommand() {
  return {
    type: "goalport.coordinateTurn" as const,
    commandId: "cmd-1",
    projectId: "project-1",
    modelSelection: { instanceId: "instance-a", model: "default" },
    runtimeMode: "approval-required" as const,
    approvalPolicy: "never" as const,
    sandboxPolicy: { type: "readOnly" as const },
    workspaceStrategy: { type: "existing_worktree" as const, worktreePath: "/work/selected" },
    initialMessage: { text: "Plan only." },
  };
}

describe("Deny test", () => {
  it("denies an edit when runtimeMode is approval-required and the sandbox is readOnly", () => {
    const disposition = acpPermissionDisposition(policy, {
      toolCall: { kind: "edit", locations: [{ path: "notes.txt" }] },
    });
    expect(disposition).toBe("deny");
  });

  it("still allows a read under the same read-only policy", () => {
    const disposition = acpPermissionDisposition(policy, {
      toolCall: { kind: "read", locations: [{ path: "notes.txt" }] },
    });
    expect(disposition).toBe("allow");
  });

  it("stops a valid coordinate turn on deny and does not look like success", () => {
    const authorization = authorizeCoordinateTurn(validCommand());
    expect(authorization).toEqual({ outcome: "write-denied", disposition: "deny" });
    expect(JSON.stringify(authorization)).not.toMatch(/success/i);
  });

  it("refuses a missing runtimeMode literal", () => {
    const command = validCommand();
    const { runtimeMode: _runtimeMode, ...missing } = command;
    const authorization = authorizeCoordinateTurn(missing);
    expect(authorization.outcome).toBe("stopped");
    expect(authorization).not.toHaveProperty("disposition");
  });

  it("refuses approval-required without never, because that asks for every read", () => {
    const command = validCommand();
    const { approvalPolicy: _approvalPolicy, ...missing } = command;
    const authorization = authorizeCoordinateTurn(missing);
    expect(authorization).toEqual({
      outcome: "stopped",
      reason: "approvalPolicy must be never. approval-required alone asks for every read.",
    });
  });

  it("refuses a missing sandboxPolicy literal", () => {
    const command = validCommand();
    const { sandboxPolicy: _sandboxPolicy, ...missing } = command;
    const authorization = authorizeCoordinateTurn(missing);
    expect(authorization.outcome).toBe("stopped");
    expect(authorization).not.toHaveProperty("disposition");
  });

  it("refuses full-access and does not treat it as a pass", () => {
    const authorization = authorizeCoordinateTurn({ ...validCommand(), runtimeMode: "full-access" });
    expect(authorization).toEqual({ outcome: "stopped", reason: "runtimeMode must be approval-required." });
  });

  it("refuses workspaceWrite", () => {
    const authorization = authorizeCoordinateTurn({
      ...validCommand(),
      sandboxPolicy: { type: "workspaceWrite" },
    });
    expect(authorization.outcome).toBe("stopped");
    expect(authorization).not.toHaveProperty("disposition");
  });

  it("refuses dangerFullAccess and does not treat it as a pass", () => {
    const authorization = authorizeCoordinateTurn({
      ...validCommand(),
      sandboxPolicy: { type: "dangerFullAccess" },
    });
    expect(authorization.outcome).toBe("stopped");
    expect(authorization).not.toHaveProperty("disposition");
  });

  it("refuses a prompt-only message.dispatch even when the text says not to edit", () => {
    const authorization = authorizeCoordinateTurn({
      type: "message.dispatch",
      text: "Do not edit files.",
    });
    expect(authorization.outcome).toBe("stopped");
    expect(authorization).not.toHaveProperty("disposition");
  });
});
