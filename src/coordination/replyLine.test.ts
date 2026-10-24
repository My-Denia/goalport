import { describe, expect, it } from "vitest";
import { coordinationReplyLine } from "./replyLine";

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

  it("prefers the bridge error over a dump", () => {
    expect(coordinationReplyLine({ error: "No running coordinated goal to stop.", payload: { stdout: "activity: Codex is planning…" } }, "Stop was sent."))
      .toBe("No running coordinated goal to stop.");
  });
});
