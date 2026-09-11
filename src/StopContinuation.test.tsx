// @vitest-environment jsdom
//
// The blocked-work panel and, more importantly, the regression bearer that the
// predicate baseline structurally cannot provide.
//
// `predicate_baseline.py` proves the 16 `held` gate predicates in App.tsx still
// exist verbatim. It cannot see a change to their INPUT: `normalizeStopResponsibility`
// returns null if any field validation tightens, which makes `responsibilityHeld`
// false and opens every one of those 16 gates while all 21 anchors still match.
// So the first test here feeds a payload shaped exactly like the pre-revision Core
// -- none of this run's new fields -- and asserts the gates are all still shut.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import App from "./App";
import { DEMO_SNAPSHOT, resolveCoreSnapshot } from "./types";

afterEach(() => {
  cleanup();
  delete window.goalportCore;
  delete window.__GOALPORT_ELECTRON__;
});

/** Exactly the shape the accepted candidate's Core sends: no new fields at all. */
const V7_HOLD = {
  attemptId: "attempt-legacy",
  operationId: "operation-legacy",
  provider: "claude",
  nativeTurnState: "interrupted",
  residualExecutionState: "unknown",
  writeResponsibility: "held",
  inputUuid: "input-legacy",
  sessionHash: "hash-legacy",
  turnEpoch: 1,
  processEpoch: "epoch-legacy",
  source: "ui.stop"
} as const;

function mount(snapshot: unknown) {
  window.__GOALPORT_ELECTRON__ = true;
  window.goalportCore = {
    snapshot: async () => snapshot,
    command: async () => snapshot,
    startCore: async () => ({}),
    openInVsCode: async () => undefined
  } as never;
  render(<App />);
}

describe("a pre-revision hold still blocks everything", () => {
  it("normalizes without any of this revision's fields", () => {
    const normalized = resolveCoreSnapshot({ ...DEMO_SNAPSHOT, stopResponsibility: V7_HOLD });
    expect(normalized).not.toBeNull();
    const hold = normalized!.stopResponsibility;
    expect(hold).not.toBeNull();
    expect(hold?.writeResponsibility).toBe("held");
    // Absent means "governs the workspace on screen". Only an explicit false may
    // downgrade a hold to somebody else's, so an older Core cannot accidentally
    // present a governing hold as unrelated to the user's current workspace.
    expect(hold?.blocksCurrentWorkspace).toBe(true);
    expect(hold?.latestRecheck ?? null).toBeNull();
    expect(normalized!.relatedHolds).toEqual([]);
  });

  it("keeps the composer, send, Allow, handoff and provider select disabled", async () => {
    mount({
      ...DEMO_SNAPSHOT,
      preview: false,
      attempt: { ...DEMO_SNAPSHOT.attempt, provider: "claude", state: "active" },
      stopResponsibility: V7_HOLD,
      relatedHolds: []
    });
    await screen.findByRole("region", { name: /stop responsibility/i });

    const composer = (await screen.findByRole("textbox", { name: /message composer/i })) as HTMLTextAreaElement;
    expect(composer.disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /assign next step/i }) as HTMLButtonElement).disabled).toBe(true);
    // Allow: this test's NAME claimed it for two audit rounds while the body never
    // asserted it. DEMO_SNAPSHOT carries a pending permission decision, so the button
    // is rendered and the assertion was always writable -- it was simply missing.
    const allow = screen.getByRole("button", { name: /allow once/i }) as HTMLButtonElement;
    expect(allow.disabled).toBe(true);
    const select = screen.queryByRole("button", { name: /select claude code/i }) as HTMLButtonElement | null;
    if (select) expect(select.disabled).toBe(true);
  });

  it("leaves the handler guards unreachable, which is the stronger property", async () => {
    // App.tsx also guards send, Allow and handoff inside their handlers, and those
    // guards are genuinely unreachable while a hold governs the workspace: every
    // control that could invoke them is disabled. Asserting a notice by clicking
    // would require the button to be live, which is exactly the state that must not
    // exist. So the reachable guard is asserted instead -- Close, which is never
    // disabled -- and it must still route through the close dialog rather than
    // quitting while responsibility is held.
    mount({
      ...DEMO_SNAPSHOT,
      preview: false,
      attempt: { ...DEMO_SNAPSHOT.attempt, provider: "claude", state: "active" },
      stopResponsibility: V7_HOLD,
      relatedHolds: []
    });
    await screen.findByRole("region", { name: /stop responsibility/i });
    fireEvent.click(screen.getByRole("button", { name: "Close window" }));
    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: /continue running in the background/i })).toBeTruthy()
    );
  });
});

describe("the blocked-work panel", () => {
  const HOLD = {
    ...V7_HOLD,
    workspaceKey: "C:\\work\\alpha",
    interruptedAt: "1788600000000",
    taskTitle: "Migrate the importer",
    campaignGoal: "Ship the importer rewrite",
    blockedReason:
      "New work in C:\\work\\alpha is blocked by durable Stop responsibility held for attempt attempt-legacy (operation operation-legacy); residual execution is unknown",
    blocksCurrentWorkspace: true,
    latestRecheck: {
      seq: 4,
      id: "recheck-4",
      observedAt: "1788600009999",
      runtimeObservation: "unknown",
      verdict: "observation-unavailable",
      activeLeaseCount: 1,
      pendingOutboxCount: 2,
      attemptState: "Cancelled"
    }
  };

  it("names the work, the workspace, the interruption and the choices", async () => {
    mount({ ...DEMO_SNAPSHOT, preview: false, stopResponsibility: HOLD, relatedHolds: [] });
    const panel = await screen.findByRole("region", { name: /stop responsibility/i });

    expect(panel.textContent).toContain("Migrate the importer");
    expect(panel.textContent).toContain("Ship the importer rewrite");
    expect(panel.textContent).toContain("C:\\work\\alpha");
    expect(panel.textContent).toContain("operation-legacy");
    expect(panel.textContent).toContain("input-legacy");
    expect(panel.textContent).toContain("blocked by durable Stop responsibility");
    // The three independent states survive the redesign.
    expect(panel.textContent).toContain("Native turn: interrupted");
    expect(panel.textContent).toContain("Residual execution: unknown");
    expect(panel.textContent).toContain("Write responsibility: held");
    // Both actions are offered.
    expect(screen.getByRole("button", { name: /re-check this hold/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /continue in a new isolated workspace/i })).toBeTruthy();
  });

  it("reports when the last re-check looked, and refuses to make it sound safe", async () => {
    mount({ ...DEMO_SNAPSHOT, preview: false, stopResponsibility: HOLD, relatedHolds: [] });
    const panel = await screen.findByRole("region", { name: /stop responsibility/i });
    expect(panel.textContent).toContain("Last re-check: observation-unavailable");
    expect(panel.textContent).toContain("observed at 1788600009999");
    expect(panel.textContent).toContain("Nothing could be concluded");
    expect(panel.textContent).toContain("not evidence that anything stopped");
  });

  it("will not offer a continuation before a re-check exists", async () => {
    mount({
      ...DEMO_SNAPSHOT,
      preview: false,
      stopResponsibility: { ...HOLD, latestRecheck: null },
      relatedHolds: []
    });
    await screen.findByRole("region", { name: /stop responsibility/i });
    expect(
      (screen.getByRole("button", { name: /continue in a new isolated workspace/i }) as HTMLButtonElement).disabled
    ).toBe(true);
    expect(document.body.textContent).toContain("Re-check first");
  });

  it("discloses what continuing does not control, by content and not by the word isolated", async () => {
    mount({ ...DEMO_SNAPSHOT, preview: false, stopResponsibility: HOLD, relatedHolds: [] });
    const panel = await screen.findByRole("region", { name: /stop responsibility/i });
    // The two sentences a reader would otherwise assume away.
    expect(panel.textContent).toContain("including into the new workspace");
    expect(panel.textContent).toContain("is not evidence of isolation and does not release the original hold");
    // And the whole authorization grant, not the one flag that sounds smallest.
    expect(panel.textContent).toContain("provider, action and transfer");
  });

  it("shows a related hold as somebody else's, not as a block on this workspace", async () => {
    // After a continuation the user stands in the new workspace. Rendering the same
    // three state words here without saying whose they are would tell them their
    // current workspace is blocked when it is not.
    mount({
      ...DEMO_SNAPSHOT,
      preview: false,
      stopResponsibility: null,
      relatedHolds: [
        {
          ...HOLD,
          blocksCurrentWorkspace: false,
          blockedReason:
            "This hold belongs to source workspace C:\\work\\alpha; the current workspace is not blocked by it. Residual execution there is unknown and write responsibility remains held."
        }
      ]
    });
    const panel = await screen.findByRole("region", { name: /related hold/i });
    expect(panel.getAttribute("data-governs")).toBe("false");
    expect(panel.textContent).toContain("belongs to source workspace C:\\work\\alpha");
    expect(panel.textContent).toContain("current workspace is not blocked by it");
    expect(panel.textContent).toContain("Write responsibility: held");
    // Re-check stays reachable from here: this is the view the user is in when the
    // post-continuation re-check matters.
    expect(screen.getByRole("button", { name: /re-check this hold/i })).toBeTruthy();
  });
});

describe("a refused continuation is never announced as a success", () => {
  // Found by running the packaged GUI, not by reading the code. `dispatch` does not
  // reject on a Core refusal: it returns the previous snapshot with a
  // "Core refused: …" notice prepended. So the handler's catch never fired, and the
  // success line ran anyway -- telling the user their work had been carried into a
  // new workspace when Core had refused and carried nothing. A false safety claim,
  // in the feature built to avoid exactly those.
  const HELD = {
    ...V7_HOLD,
    workspaceKey: "C:\\work\\alpha",
    interruptedAt: "1788600000000",
    taskTitle: "Migrate the importer",
    campaignGoal: "Ship the importer rewrite",
    blocksCurrentWorkspace: true,
    latestRecheck: {
      seq: 1, id: "recheck-1", observedAt: "1788600009999",
      runtimeObservation: "unknown", verdict: "observation-unavailable",
      activeLeaseCount: 0, pendingOutboxCount: 0, attemptState: "Cancelled"
    }
  };

  it("shows Core's reason instead of a success line", async () => {
    const base = { ...DEMO_SNAPSHOT, preview: false, stopResponsibility: HELD, relatedHolds: [] };
    const refused = {
      ...base,
      notices: [
        "Core refused: attempt attempt-legacy already has a continuation, in C:\\work\\alpha-continued-abc. A repeat click, a reopened window or a replayed request never mints a second one; continue working there, or take a new decision explicitly.",
        ...DEMO_SNAPSHOT.notices
      ]
    };
    window.__GOALPORT_ELECTRON__ = true;
    window.goalportCore = {
      snapshot: async () => base,
      command: async () => refused,
      startCore: async () => ({}),
      openInVsCode: async () => undefined
    } as never;
    render(<App />);
    await screen.findByRole("region", { name: /stop responsibility/i });

    fireEvent.click(screen.getByRole("button", { name: /continue in a new isolated workspace/i }));

    await waitFor(() =>
      expect(document.body.textContent).toContain("Continuation refused")
    );
    expect(document.body.textContent).toContain("already has a continuation");
    // The success line must be absent, not merely outranked.
    expect(document.body.textContent).not.toContain("The original workspace stays held.");
  });

  it("still announces a real continuation as a success", async () => {
    // The control: without a refusal notice the success path must survive, so the
    // fix above cannot be satisfied by never reporting success at all.
    const base = { ...DEMO_SNAPSHOT, preview: false, stopResponsibility: HELD, relatedHolds: [] };
    window.__GOALPORT_ELECTRON__ = true;
    window.goalportCore = {
      snapshot: async () => base,
      command: async () => ({ ...base, notices: [] }),
      startCore: async () => ({}),
      openInVsCode: async () => undefined
    } as never;
    render(<App />);
    await screen.findByRole("region", { name: /stop responsibility/i });
    fireEvent.click(screen.getByRole("button", { name: /continue in a new isolated workspace/i }));
    await waitFor(() =>
      expect(document.body.textContent).toContain("The original workspace stays held.")
    );
    expect(document.body.textContent).not.toContain("Continuation refused");
  });
});
