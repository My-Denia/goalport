import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { acpPermissionDisposition } from "./AcpClientPolicy";
import { authorizeCoordinateTurn, authorizeCoordinateWriteTurn, roleOfCommandId } from "./coordinateTurn";

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

function validWriteCommand() {
  return {
    type: "goalport.coordinateTurn" as const,
    commandId: "coordinate-execute-1a2b",
    projectId: "project-1",
    modelSelection: { instanceId: "instance-a", model: "default" },
    runtimeMode: "approval-required" as const,
    approvalPolicy: "never" as const,
    sandboxPolicy: { type: "workspaceWrite" as const },
    workspaceStrategy: { type: "existing_worktree" as const, worktreePath: "/work/selected" },
    initialMessage: { text: "Carry out the plan." },
  };
}

describe("Write shape gate (pure, renderer-side)", () => {
  it("authorizes an execute turn with workspaceWrite and an absolute existing worktree", () => {
    const authorization = authorizeCoordinateWriteTurn(validWriteCommand());
    expect(authorization).toEqual({ outcome: "write-authorized", role: "execute" });
  });

  it("authorizes an audit turn only in its read-only shape", () => {
    const audit = {
      ...validWriteCommand(),
      commandId: "coordinate-audit-9c8d",
      sandboxPolicy: { type: "readOnly" as const },
      initialMessage: { text: "Verify the carried-out plan." },
    };
    expect(authorizeCoordinateWriteTurn(audit)).toEqual({ outcome: "write-authorized", role: "audit" });
    expect(authorizeCoordinateWriteTurn({ ...audit, sandboxPolicy: { type: "workspaceWrite" } }).outcome).toBe("stopped");
  });

  it("refuses an execute turn with readOnly — pairing direction one", () => {
    const authorization = authorizeCoordinateWriteTurn({
      ...validWriteCommand(),
      sandboxPolicy: { type: "readOnly" },
    });
    expect(authorization.outcome).toBe("stopped");
    expect(authorization).toHaveProperty("reason", "An execution turn must use workspaceWrite.");
  });

  it("refuses plan and review turns with workspaceWrite — pairing direction two", () => {
    const asPlan = { ...validWriteCommand(), commandId: "coordinate-plan-1a2b", sandboxPolicy: { type: "workspaceWrite" as const } };
    const asReview = { ...validWriteCommand(), commandId: "coordinate-review-1a2b", sandboxPolicy: { type: "workspaceWrite" as const } };
    expect(authorizeCoordinateWriteTurn(asPlan)).toHaveProperty("reason", "A plan, check, or verification turn must stay readOnly.");
    expect(authorizeCoordinateWriteTurn(asReview).outcome).toBe("stopped");
  });

  it("refuses dangerFullAccess and full-access in any role — never treated as a pass", () => {
    const fullAccess = { ...validWriteCommand(), sandboxPolicy: { type: "dangerFullAccess" } };
    expect(authorizeCoordinateWriteTurn(fullAccess).outcome).toBe("stopped");
    const openRuntime = { ...validWriteCommand(), runtimeMode: "full-access" as const };
    expect(authorizeCoordinateWriteTurn(openRuntime)).toHaveProperty("reason", "runtimeMode must be approval-required.");
  });

  it("refuses a relative, empty, or whitespace worktree path", () => {
    const relative = { ...validWriteCommand(), workspaceStrategy: { type: "existing_worktree" as const, worktreePath: "work/relative" } };
    expect(authorizeCoordinateWriteTurn(relative)).toHaveProperty("reason", "A write-authorized turn needs an absolute worktree path.");
    const empty = { ...validWriteCommand(), workspaceStrategy: { type: "existing_worktree" as const, worktreePath: "   " } };
    expect(authorizeCoordinateWriteTurn(empty)).toHaveProperty("reason", "A write-authorized turn must run in an existing worktree.");
    const root = { ...validWriteCommand(), workspaceStrategy: { type: "root" as const } };
    expect(authorizeCoordinateWriteTurn(root).outcome).toBe("stopped");
  });

  it("refuses an unknown role id and a prompt-only dispatch", () => {
    expect(authorizeCoordinateWriteTurn({ ...validWriteCommand(), commandId: "coordinate-other-1" }).outcome).toBe("stopped");
    expect(authorizeCoordinateWriteTurn({ ...validWriteCommand(), commandId: "cmd-1" }).outcome).toBe("stopped");
    expect(authorizeCoordinateWriteTurn({ type: "message.dispatch", text: "edit please" }).outcome).toBe("stopped");
  });

  it("classifies the closed prefix set exactly like the electron leaf", () => {
    expect(roleOfCommandId("coordinate-plan-a")).toBe("plan");
    expect(roleOfCommandId("coordinate-review-b")).toBe("review");
    expect(roleOfCommandId("coordinate-execute-c")).toBe("execute");
    expect(roleOfCommandId("coordinate-audit-d")).toBe("audit");
    expect(roleOfCommandId("coordinate-other-e")).toBe(null);
    expect(roleOfCommandId("coordinate-plan")).toBe(null);
    expect(roleOfCommandId("coordinate-execute")).toBe(null);
    expect(roleOfCommandId(42)).toBe(null);
  });

  it("stays pure: the module imports no node builtins and probes nothing outside its shape checks", () => {
    const source = readFileSync(new URL("./coordinateTurn.ts", import.meta.url), "utf8");
    // Comments may mention processes; the code may not touch one.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code.match(/from "node:/g)).toBeNull();
    expect(code).not.toMatch(/\brequire\(/);
    expect(code).not.toMatch(/\bprocess\./);
    // The ACP disposition is the read gate's edit check only; the write gate
    // must never route a workspaceWrite policy through it.
    expect(code.split("acpPermissionDisposition(").length - 1).toBe(1);
  });
});
