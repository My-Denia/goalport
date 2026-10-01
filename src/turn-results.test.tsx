// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TurnResults } from "./panels/TurnResults";
import type { TurnResult } from "./types";

const result: TurnResult = {
  requestId: "request-1",
  replyState: "completed",
  replyText: "I think the tests passed",
  baselineRecorded: true,
  before: [{ path: "user.txt", area: "untracked", status: "??", change: "before" }],
  during: [{ path: "agent.txt", area: "untracked", status: "??", change: "added" }],
  unattributed: [{ path: "hand.txt", area: "untracked", status: "??", change: "added" }],
  commands: [
    { command: "echo ok", cwd: "/work", state: "completed", exitCode: 0, output: "ok" },
    { command: "echo fail", cwd: "/work", state: "failed", exitCode: 1, output: "no" }
  ]
};

afterEach(() => cleanup());

describe("Turn results", () => {
  it("keeps the reply, the preexisting file, and the two exit codes apart", () => {
    render(<TurnResults results={[result]} />);
    expect(screen.getByText("I think the tests passed")).toBeTruthy();
    expect(screen.getByText("user.txt")).toBeTruthy();
    expect(screen.getByText("agent.txt")).toBeTruthy();
    expect(screen.getByText("hand.txt")).toBeTruthy();
    expect(screen.getByText("completed · exit 0")).toBeTruthy();
    expect(screen.getByText("failed · exit 1")).toBeTruthy();
    render(<TurnResults results={[{
      ...result,
      before: [],
      during: [{ path: "b.txt", fromPath: "a.txt", area: "staged", status: "RM", change: "renamed", contentInspection: "available" }],
      unattributed: [{ path: "blob.bin", area: "untracked", status: "??", change: "added", contentInspection: "binary" }]
    }]} />);
    expect(screen.getByText("a.txt → b.txt")).toBeTruthy();
    expect(screen.getByText("Content not inspected — binary file")).toBeTruthy();
    expect(screen.queryByText(/tests passed · exit/)).toBeNull();
  });

  it("does not invent a diff when the turn has no baseline", () => {
    render(<TurnResults results={[{ ...result, baselineRecorded: false, before: [], during: [], unattributed: [] }]} />);
    expect(screen.getByText("Baseline not recorded")).toBeTruthy();
    expect(screen.queryByText("user.txt")).toBeNull();
  });
});
