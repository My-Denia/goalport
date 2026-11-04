// @vitest-environment jsdom
// Picking how to work: Recommended, the user's saved workflows, and a way to make one.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RECOMMENDED_V1 } from "../../electron/workflow-checks.mjs";
import type { WorkflowDefinition } from "../types";
import { clickRuntimeOption } from "../runtime-picker.test-helpers";
import { DraftGoalComposer, type GoalDraftValue, type SendBlockers } from "./DraftGoalComposer";
import { NEED_TWO_AGENTS_SENTENCE } from "./sendDisabledReason";

afterEach(cleanup);

const quick: WorkflowDefinition = {
  schema: 1, id: "my-0a1b2c3d", version: 1, name: "Quick plans", parent: "recommended@1",
  modules: { checks: { ...RECOMMENDED_V1.modules.checks, planReview: "off" } },
};

function mount(over: { draft?: GoalDraftValue; workflows?: readonly WorkflowDefinition[]; onChange?: (v: GoalDraftValue) => void; save?: any; linuxEntry?: boolean; blockers?: SendBlockers } = {}) {
  const onChange = over.onChange ?? vi.fn();
  render(
    <DraftGoalComposer
      linuxEntry={over.linuxEntry}
      runtimes={[]} busy={false} error={null} canBrowse onBrowse={() => {}} onSubmit={() => {}} onDiscard={() => {}}
      connected waitingOn={null} blockedFromSending={false} coordinationAvailable coordinationEntryAvailable
      draft={over.draft ?? { workspace: "C:\\work", provider: "", message: "plan it" }}
      onChange={onChange}
      workflows={"workflows" in over ? over.workflows : [quick]}
      sendBlockers={over.blockers}
      onSaveWorkflow={over.save ?? (async () => ({ ok: true as const }))}
    />,
  );
  return onChange;
}

async function openPicker() {
  fireEvent.click(screen.getByRole("combobox", { name: "Select agent" }));
  await screen.findByRole("listbox", { name: "Runtimes" });
}

describe("workflow rows in the picker", () => {
  it("lists Recommended, each saved workflow with a plain line, and Copy Recommended; nothing disabled or coming soon", async () => {
    mount();
    await openPicker();
    const rows = screen.getAllByRole("option").map((option) => option.textContent ?? "");
    expect(rows.some((text) => text.includes("Recommended workflowPlan first"))).toBe(true);
    expect(rows.some((text) => text.includes("Quick plans") && text.includes("Your copy of Recommended · plan review off"))).toBe(true);
    expect(rows.some((text) => text.includes("Copy Recommended…"))).toBe(true);
    expect(rows.join(" ")).not.toMatch(/coming soon|My workflow/i);
    for (const option of screen.getAllByRole("option")) expect(option.getAttribute("aria-disabled")).not.toBe("true");
  });

  it("choosing a saved workflow carries its id on the draft and keeps the runtime empty", async () => {
    const onChange = mount();
    await openPicker();
    clickRuntimeOption(screen.getByRole("option", { name: /Quick plans/ }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ workspace: "C:\\work", provider: "", message: "plan it", workflowId: "my-0a1b2c3d" }));
  });

  it("choosing Recommended clears the carried workflow", async () => {
    const onChange = mount({ draft: { workspace: "C:\\work", provider: "", message: "x", workflowId: "my-0a1b2c3d" } });
    await openPicker();
    clickRuntimeOption(screen.getByRole("option", { name: /^Recommended workflow/ }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ workspace: "C:\\work", provider: "", message: "x", workflowId: undefined }));
  });

  it("the trigger names the chosen workflow and Edit is next to it", () => {
    mount({ draft: { workspace: "C:\\work", provider: "", message: "x", workflowId: "my-0a1b2c3d" } });
    const trigger = screen.getByRole("combobox", { name: "Select agent" });
    expect(trigger.textContent).toContain("Quick plans");
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
  });

  it("Copy Recommended opens the editor with focus in the name field and changes no selection", async () => {
    const onChange = mount();
    await openPicker();
    clickRuntimeOption(screen.getByRole("option", { name: /Copy Recommended…/ }));
    const name = await screen.findByLabelText("Name");
    await waitFor(() => expect(document.activeElement).toBe(name));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("saving from the editor selects the new workflow for this goal", async () => {
    const created = { ...quick, id: "my-99999999", name: "Fast plans" };
    const onChange = mount({ save: async () => ({ ok: true as const, saved: created }) });
    await openPicker();
    clickRuntimeOption(screen.getByRole("option", { name: /Copy Recommended…/ }));
    await screen.findByLabelText("Name");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ workspace: "C:\\work", provider: "", message: "plan it", workflowId: "my-99999999" }));
    await waitFor(() => expect(screen.queryByLabelText("Name")).toBeNull());
  });

  it("without saved-workflow support there are no workflow rows at all (Linux)", async () => {
    mount({ workflows: undefined, linuxEntry: true });
    fireEvent.click(screen.getByRole("combobox", { name: "Choose goal mode" }));
    await screen.findByRole("listbox", { name: "Runtimes" });
    const text = screen.getAllByRole("option").map((option) => option.textContent).join(" ");
    expect(text).not.toMatch(/Copy Recommended|My workflow|coming soon/i);
  });

  it("with review on one agent holds Send and says why; with review off the same one agent sends", () => {
    const blockers = { holdSentence: null, grantMissing: false, grantControlVisible: false };
    mount({ blockers: { ...blockers, agentsUsable: 1, agentsNeeded: 2 } });
    expect((screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("status", { name: "" }).textContent).toBe(NEED_TWO_AGENTS_SENTENCE);
    cleanup();
    mount({ draft: { workspace: "C:\\work", provider: "", message: "plan it", workflowId: "my-0a1b2c3d" }, blockers: { ...blockers, agentsUsable: 1, agentsNeeded: 1 } });
    expect((screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement).disabled).toBe(false);
    expect(document.getElementById("send-disabled-reason")).toBeNull();
  });
});

describe("editing the workflow a Use again draft carries", () => {
  it("Send follows the edited workflow: the draft carries only the id, and the list is the one source", async () => {
    const edited: WorkflowDefinition = { ...quick, version: 2, modules: { checks: { ...RECOMMENDED_V1.modules.checks, planReview: "on" } } };
    let draft: GoalDraftValue = { workspace: "C:\work", provider: "", message: "plan it", workflowId: quick.id };
    const onChange = vi.fn((value: GoalDraftValue) => { draft = { ...draft, ...value }; });
    mount({ draft, workflows: [quick], onChange, save: async () => ({ ok: true as const, saved: edited }) });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await screen.findByLabelText("Name");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(draft).not.toHaveProperty("workflowSnapshot");
    expect([edited].find((item) => item.id === draft.workflowId)?.modules.checks.planReview).toBe("on");
  });
});
