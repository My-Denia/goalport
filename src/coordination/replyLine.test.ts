import { describe, expect, it } from "vitest";
import { coordinationReplyLine, coordinationStartAdmitted, signedInLine } from "./replyLine";

describe("coordinationReplyLine", () => {
  it("keeps the unconfirmed sentence instead of a planning activity", () => {
    const line = coordinationReplyLine({
      payload: { stdout: "state: revoked\nactivity: Codex is planning…\nThe stop is durably recorded; the job's exit remains unconfirmed and its turn is not replayed.\n" },
    }, "Stop was sent.");
    expect(line).toBe("The stop is durably recorded; the job's exit remains unconfirmed and its turn is not replayed.");
  });

  it("uses the activity sentence when the exit is settled", () => {
    const line = coordinationReplyLine({
      payload: { stdout: "state: stopped\nactivity: Stopped. No further turn was sent.\n" },
    }, "Stop was sent.");
    expect(line).toBe("Stopped. No further turn was sent.");
  });

  it("names the known harnesses the same way the rest of the page does", () => {
    expect(signedInLine(["codex", "pi"])).toBe("Signed in: Codex, Pi.");
    expect(signedInLine(["codex"])).toBeNull();
  });

  it("locks a second send only after the goal was actually admitted", () => {
    expect(coordinationStartAdmitted({ payload: { stdout: "The goal was admitted with request id coordinate-1; its worker runs detached.\n" } })).toBe(true);
    expect(coordinationStartAdmitted({ error: "The workspace must be an absolute path, so nothing was admitted." })).toBe(false);
  });

  it("prefers the bridge error over a dump", () => {
    expect(coordinationReplyLine({ error: "No running coordinated goal to stop.", payload: { stdout: "activity: Codex is planning…" } }, "Stop was sent."))
      .toBe("No running coordinated goal to stop.");
  });

  it("expresses stop accurately across live revoke, pending command, and settled states (R3)", () => {
    // 1. Live revoke with pending command in-flight
    const pendingRevoke = coordinationReplyLine({
      payload: { stdout: "state: running\nrevoked: true\npending command: coordinate-execute-1 (unconfirmed)\nactivity: Codex is making changes…\n" },
    }, "Stop was sent.");
    expect(pendingRevoke).toBe("Access stopped; the current turn may finish, but no further turn was sent.");

    // 2. Live revoke with no pending command
    const noPendingRevoke = coordinationReplyLine({
      payload: { stdout: "state: running\nrevoked: true\npending command: none\nactivity: Organizing this goal…\n" },
    }, "Stop was sent.");
    expect(noPendingRevoke).toBe("Access stopped; no further turn was sent.");

    // 3. Stopped outcome retains edits notice without claiming descendants exited
    const stoppedSettled = coordinationReplyLine({
      payload: { stdout: "state: stopped\nrevoked: true\noutcome: stopped\n" },
    }, "Stop was sent.");
    expect(stoppedSettled).toBe("Stopped. No further turn was sent. Existing workspace edits remain.");
  });
});
