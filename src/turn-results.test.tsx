// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TurnResults } from "./panels/TurnResults";
import { SinceLastVisit } from "./conversation/SinceLastVisit";
import { coalesceVisibleFragments } from "./conversation/ProductConversationView";
import { PendingApprovals } from "./panels/PendingApprovals";
import { folderName, readRecentFolders, rememberRecentFolder } from "./lib/recentFolders";
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
    expect(screen.getByText("Changes for this turn couldn't be compared.")).toBeTruthy();
    expect(screen.queryByText("user.txt")).toBeNull();
  });
});

describe("Recent folders", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key)
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("keeps the newest first, once each, and at most five", () => {
    for (const folder of ["C:\\a", "C:\\b", "C:\\A", "C:\\c", "C:\\d", "C:\\e", "C:\\f"]) rememberRecentFolder(folder);
    expect(readRecentFolders()).toEqual(["C:\\f", "C:\\e", "C:\\d", "C:\\c", "C:\\A"]);
  });

  it("names a folder the way people do", () => {
    expect(folderName("C:\\work\\goalport\\")).toBe("goalport");
    expect(folderName("/home/me/site")).toBe("site");
  });
});

describe("Answering a permission request", () => {
  const snapshot = (sessionAnswer: boolean) => ({ attempt: { provider: "codex" }, decisions: [{ id: "d1", state: "pending", title: "codex wants your approval", facts: ["npm test"], sessionAnswer }] }) as never;

  it("lets the user stop being asked when the agent can honour it", () => {
    const answers: unknown[][] = [];
    render(<PendingApprovals snapshot={snapshot(true)} onPermissionDecision={(...args) => answers.push(args)} />);
    fireEvent.click(screen.getByRole("button", { name: "Allow for this session" }));
    expect(answers).toEqual([["d1", true, true]]);
  });

  it("doesn't offer what the agent can't do", () => {
    render(<PendingApprovals snapshot={snapshot(false)} onPermissionDecision={() => undefined} />);
    expect(screen.queryByRole("button", { name: "Allow for this session" })).toBeNull();
  });
});

describe("A streamed reply", () => {
  const piece = (id: string, body: string) => ({ id, kind: "assistant-message", body, logicalItemId: "reply" }) as never;

  it("shows once when the finished message differs from the stream only by spacing", () => {
    const [reply, ...rest] = coalesceVisibleFragments([piece("a", "to GUIDE.md:"), piece("b", "31 words."), piece("c", "to GUIDE.md: 31 words.")]);
    expect(rest).toEqual([]);
    expect(reply.body).toBe("to GUIDE.md: 31 words.");
  });

  it("keeps a space that arrived on its own", () => {
    expect(coalesceVisibleFragments([piece("a", "to:"), piece("b", " "), piece("c", "31")])[0].body).toBe("to: 31");
  });

  it("never leaves an empty message behind", () => {
    expect(coalesceVisibleFragments([piece("a", " ")])).toEqual([]);
  });
});

describe("Coming back to a goal", () => {
  // Node's own partial localStorage can shadow jsdom's, so the store is explicit.
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key)
    });
  });
  afterEach(() => vi.unstubAllGlobals());
  const seen = (requestId: string) => localStorage.setItem("goalport.lastSeenTurn", JSON.stringify({ goal: requestId }));
  const product = (canStop = false) => ({ items: [], runtime: { name: "Codex" }, turn: { canStop } }) as never;
  const away = { ...result, during: [{ path: "a.md" }], unattributed: [] } as never;

  it("says what happened since the last visit, once, and stays quiet otherwise", () => {
    seen("earlier");
    render(<SinceLastVisit campaignId="goal" product={product()} results={[away]} />);
    expect(screen.getByText("Codex finished while you were away · 1 file changed.")).toBeTruthy();
    cleanup();
    render(<SinceLastVisit campaignId="goal" product={product()} results={[away]} />);
    expect(screen.queryByText(/while you were away/)).toBeNull();
  });

  it("does not call a turn finished in front of the user 'away'", () => {
    seen("earlier");
    const old = { ...result, requestId: "earlier" };
    const { rerender } = render(<SinceLastVisit campaignId="goal" product={product()} results={[old]} />);
    rerender(<SinceLastVisit campaignId="goal" product={product(true)} results={[old]} />);
    rerender(<SinceLastVisit campaignId="goal" product={product()} results={[old, away]} />);
    expect(screen.queryByText(/while you were away/)).toBeNull();
  });

  it("stays quiet when a message never became a turn", () => {
    seen("earlier");
    render(<SinceLastVisit campaignId="goal" product={product()} results={[{ ...result, requestId: "earlier" }]} />);
    expect(screen.queryByText(/while you were away/)).toBeNull();
  });

  it("says when the turn did not end well", () => {
    seen("earlier");
    render(<SinceLastVisit campaignId="goal" product={product()} results={[{ ...result, replyState: "failed", during: [], unattributed: [] }]} />);
    expect(screen.getByText("Codex ran into a problem while you were away.")).toBeTruthy();
  });
});
