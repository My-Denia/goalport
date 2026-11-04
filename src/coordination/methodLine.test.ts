import { describe, expect, it } from "vitest";
import { methodLine } from "./methodLine";

const recommended = { id: "recommended", version: 1 };
describe("methodLine", () => {
  it("names only the checks that came back, once each", () => {
    const plan = { kind: "plan-check", harness: "Pi", verdict: "checked" } as const;
    expect(methodLine(recommended, [plan])).toBe("Recommended workflow v1 · Ran: plan check by Pi");
    expect(methodLine(recommended, [plan, { kind: "audit", harness: "Codex", verdict: "verified" }]))
      .toBe("Recommended workflow v1 · Ran: plan check by Pi, verification by Codex");
    expect(methodLine(recommended, [plan, { ...plan, verdict: "revise" }, plan])).toBe("Recommended workflow v1 · Ran: plan check by Pi");
  });
  it("says the setting changed what ran only when the stop came from that setting", () => {
    const plan = { kind: "plan-check", harness: "Pi", verdict: "revise" } as const;
    const mine = { id: "my-0a1b2c3d", version: 2, name: "Careful" };
    expect(methodLine(mine, [plan], { kind: "automatic-off", stage: "plan" })).toBe("Careful v2 · Ran: plan check by Pi · Automatic plan revision: off in Careful");
    expect(methodLine(mine, [plan], { kind: "automatic-off", stage: "changes" })).toBe("Careful v2 · Ran: plan check by Pi · Automatic repair: off in Careful");
    for (const kind of ["limit-reached", "not-enough-turns", "window-refused", "unstaffed", "revise"] as const) {
      expect(methodLine(mine, [plan], { kind, stage: "plan" })).toBe("Careful v2 · Ran: plan check by Pi");
    }
  });
  it("says no check ran, and shows nothing when the method is unknown", () => {
    expect(methodLine(recommended, [])).toBe("Recommended workflow v1 · No check ran");
    expect(methodLine(recommended, undefined)).toBeNull();
    expect(methodLine(null, [])).toBeNull();
    expect(methodLine(undefined, undefined)).toBeNull();
    expect(methodLine({ id: "mine", version: 2 }, [])).toBeNull();
  });
});
