import { describe, expect, it } from "vitest";
import { DEFAULT_RESOURCES } from "../../electron/workflow-checks.mjs";
import { startingBudget } from "./startingBudget";

const workflow = { readTurns: 3, writeTurns: 1 };
const current = { readTurns: 4, writeTurns: 2 };
const untouched = { read: false, write: false };

describe("a new goal's starting turn limits", () => {
  it("follow the chosen workflow", () => {
    expect(startingBudget({ workflow, current, accessGranted: false, typed: untouched })).toEqual({ readTurns: 3, writeTurns: 1 });
  });
  it("go back to 4 and 2 when Recommended is chosen again", () => {
    const picked = startingBudget({ workflow, current, accessGranted: false, typed: untouched });
    expect(startingBudget({ workflow: DEFAULT_RESOURCES.budget, current: picked, accessGranted: false, typed: untouched })).toEqual({ readTurns: 4, writeTurns: 2 });
  });
  it("never touch limits that access was already granted with", () => {
    expect(startingBudget({ workflow, current: { readTurns: 8, writeTurns: 5 }, accessGranted: true, typed: untouched })).toEqual({ readTurns: 8, writeTurns: 5 });
  });
  it("keep a number the user typed, and still fill in the one they did not", () => {
    expect(startingBudget({ workflow, current: { readTurns: 9, writeTurns: 2 }, accessGranted: false, typed: { read: true, write: false } })).toEqual({ readTurns: 9, writeTurns: 1 });
    expect(startingBudget({ workflow, current: { readTurns: 9, writeTurns: 7 }, accessGranted: false, typed: { read: true, write: true } })).toEqual({ readTurns: 9, writeTurns: 7 });
  });
});
