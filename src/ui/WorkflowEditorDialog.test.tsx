// @vitest-environment jsdom
// The user copies the recommended method, switches off what they don't need and names it.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { RECOMMENDED_V1 } from "../../electron/workflow-checks.mjs";
import type { WorkflowDefinition } from "../types";
import { WorkflowEditorDialog } from "./WorkflowEditorDialog";

afterEach(cleanup);

const saved: WorkflowDefinition = {
  schema: 1, id: "my-0a1b2c3d", version: 2, name: "Quick plans", parent: "recommended@1",
  modules: { checks: { ...RECOMMENDED_V1.modules.checks, planReview: "off" } },
};

function open(over: Partial<React.ComponentProps<typeof WorkflowEditorDialog>> = {}) {
  const props = { workflow: null, otherNames: [], onSave: vi.fn(async () => ({ ok: true as const })), onDelete: vi.fn(async () => ({ ok: true as const })), onClose: vi.fn(), ...over };
  render(<WorkflowEditorDialog {...props} />);
  return props as unknown as { onSave: Mock; onDelete: Mock; onClose: Mock };
}

describe("workflow editor", () => {
  it("opens on a copy of Recommended with a free name and focus in the name field", async () => {
    open({ otherNames: ["My workflow"] });
    const name = await screen.findByLabelText("Name") as HTMLInputElement;
    expect(name.value).toBe("My workflow 2");
    await waitFor(() => expect(document.activeElement).toBe(name));
    expect((screen.getByRole("checkbox", { name: /Independent plan review/ }) as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByRole("button", { name: /Delete/ })).toBeNull();
  });

  it("only Checks, Resources and Feedback have controls; every other group says it follows Recommended", async () => {
    open();
    await screen.findByLabelText("Name");
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    for (const group of ["Planning", "Execution", "Delivery"]) {
      const section = screen.getByRole("region", { name: group });
      expect(within(section).getByText("Same as Recommended v1")).toBeTruthy();
      expect(within(section).queryByRole("checkbox")).toBeNull();
    }
    expect(screen.getByText(/Goals that change files are always reviewed first\./)).toBeTruthy();
    expect(screen.getByText(/an agent that cannot open files \(Pi\) is never the reviewer/)).toBeTruthy();
  });

  it("saves the switched-off review under the chosen name, without an id for a new copy", async () => {
    const { onSave } = open();
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "  Quick plans " } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Reviewer must be able to read your files/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Independent plan review/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const input = (onSave.mock.calls as unknown as [Record<string, any>][])[0][0];
    expect(input.id).toBeUndefined();
    expect(input.name).toBe("Quick plans");
    expect(input.modules.checks.planReview).toBe("off");
    expect(input.modules.checks.reviewerNeeds.readWorkspace).toBe("required");
  });

  it("with review off the reviewer-reads-files control is disabled but keeps its value", async () => {
    open();
    await screen.findByLabelText("Name");
    const reads = screen.getByRole("checkbox", { name: /Reviewer must be able to read your files/ }) as HTMLInputElement;
    fireEvent.click(reads);
    expect(reads.checked).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /Independent plan review/ }));
    expect(reads.disabled).toBe(true);
    expect(reads.checked).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /Independent plan review/ }));
    expect(reads.disabled).toBe(false);
    expect(reads.checked).toBe(true);
  });

  it("editing keeps the id, shows the saved choices and renames in place", async () => {
    const { onSave } = open({ workflow: saved });
    const name = await screen.findByLabelText("Name") as HTMLInputElement;
    expect(name.value).toBe("Quick plans");
    expect((screen.getByRole("checkbox", { name: /Independent plan review/ }) as HTMLInputElement).checked).toBe(false);
    fireEvent.change(name, { target: { value: "Fast plans" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect((onSave.mock.calls as unknown as [Record<string, any>][])[0][0]).toMatchObject({ id: "my-0a1b2c3d", name: "Fast plans" });
  });

  it("a refused save stays open with the one sentence; an empty name never reaches the store", async () => {
    const { onSave, onClose } = open({ onSave: vi.fn(async () => ({ ok: false as const, error: "You already have a workflow with that name." })) });
    const name = await screen.findByLabelText("Name");
    fireEvent.change(name, { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Give it a name.");
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.change(name, { target: { value: "Quick plans" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("You already have a workflow with that name."));
    expect(onClose).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
  });

  // Issue #69: plan with the strong model, check fast, start new goals with fewer turns.
  it("Resources starts at Default with 4 and 2 turns, and says it only fills in new goals", async () => {
    open();
    await screen.findByLabelText("Name");
    const section = screen.getByRole("region", { name: "Resources" });
    for (const role of ["Writing the plan", "Independent check", "Making changes", "Verification"]) {
      expect((within(section).getByRole("radiogroup", { name: new RegExp(`^${role}`) }).querySelector("input:checked") as HTMLInputElement).value).toBe("default");
    }
    expect((within(section).getByLabelText("Turn limit to start with") as HTMLInputElement).value).toBe("4");
    expect((within(section).getByLabelText("File-change turn limit") as HTMLInputElement).value).toBe("2");
    expect(within(section).getByText(/never change access you already gave/)).toBeTruthy();
    expect(within(section).getAllByText("Only for goals that change files")).toHaveLength(2);
  });

  it("saves planning Stronger, the check Faster and 3 turns to start with", async () => {
    const { onSave } = open();
    await screen.findByLabelText("Name");
    const group = (name: RegExp) => screen.getByRole("radiogroup", { name });
    fireEvent.click(within(group(/^Writing the plan/)).getByRole("radio", { name: "Stronger" }));
    fireEvent.click(within(group(/^Independent check/)).getByRole("radio", { name: "Faster" }));
    fireEvent.change(screen.getByLabelText("Turn limit to start with"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const input = (onSave.mock.calls as unknown as [Record<string, any>][])[0][0];
    expect(input.modules.resources).toEqual({
      roles: { plan: "stronger", review: "faster", execute: "default", audit: "default" },
      budget: { readTurns: 3, writeTurns: 2 },
    });
  });

  it("opens a saved workflow on its own resources and refuses a turn count outside the allowed range", async () => {
    const withResources: WorkflowDefinition = { ...saved, modules: { ...saved.modules, resources: {
      roles: { plan: "stronger", review: "default", execute: "default", audit: "faster" }, budget: { readTurns: 6, writeTurns: 1 } } } };
    const { onSave } = open({ workflow: withResources });
    await screen.findByLabelText("Name");
    expect((within(screen.getByRole("radiogroup", { name: /^Writing the plan/ })).getByRole("radio", { name: "Stronger" }) as HTMLInputElement).checked).toBe(true);
    expect((within(screen.getByRole("radiogroup", { name: /^Verification/ })).getByRole("radio", { name: "Faster" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Turn limit to start with") as HTMLInputElement).value).toBe("6");
    fireEvent.change(screen.getByLabelText("File-change turn limit"), { target: { value: "9" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toContain("File-change turn limit: choose 1 to 8.");
    expect(onSave).not.toHaveBeenCalled();
  });

  // Issue #70: decide myself instead of GoalPort spending another round.
  it("Feedback starts on automatic for both stops, in the same segmented control as Resources", async () => {
    open();
    await screen.findByLabelText("Name");
    const section = screen.getByRole("region", { name: "Feedback & continuation" });
    expect(within(section).queryByText("Same as Recommended v1")).toBeNull();
    for (const label of [/^When the plan check asks for changes/, /^When verification asks for changes/]) {
      const group = within(section).getByRole("radiogroup", { name: label });
      expect(group.classList.contains("resource-seg")).toBe(true);
      expect((group.querySelector("input:checked") as HTMLInputElement).value).toBe("automatic");
    }
    expect(within(section).getAllByText("Only for goals that change files")).toHaveLength(2);
    expect(within(section).getByRole("radio", { name: /Revise the plan automatically/ })).toBeTruthy();
    expect(within(section).getByRole("radio", { name: /Repair automatically/ })).toBeTruthy();
  });

  it("saves Stop and ask me for the plan check and leaves verification automatic", async () => {
    const { onSave } = open();
    await screen.findByLabelText("Name");
    fireEvent.click(within(screen.getByRole("radiogroup", { name: /^When the plan check asks/ })).getByRole("radio", { name: "Stop and ask me" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect((onSave.mock.calls as unknown as [Record<string, any>][])[0][0].modules.feedback).toEqual({ planRevision: "ask", repair: "automatic" });
  });

  it("editing starts from the saved feedback", async () => {
    const asking: WorkflowDefinition = { ...saved, modules: { ...saved.modules, feedback: { planRevision: "automatic", repair: "ask" } } };
    const { onSave } = open({ workflow: asking });
    await screen.findByLabelText("Name");
    expect((within(screen.getByRole("radiogroup", { name: /^When verification asks/ })).getByRole("radio", { name: "Stop and ask me" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect((onSave.mock.calls as unknown as [Record<string, any>][])[0][0].modules.feedback).toEqual({ planRevision: "automatic", repair: "ask" });
  });

  it("Cancel closes without saving", async () => {
    const { onSave, onClose } = open();
    await screen.findByLabelText("Name");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("delete asks once, and Keep it deletes nothing", async () => {
    const { onDelete } = open({ workflow: saved });
    await screen.findByLabelText("Name");
    fireEvent.click(screen.getByRole("button", { name: "Delete…" }));
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByText(/Delete “Quick plans”\?/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete…" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete workflow" }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith("my-0a1b2c3d"));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});
