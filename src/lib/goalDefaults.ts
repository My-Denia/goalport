// The folder and agent from the last goal, so a new goal starts where the user already is.
// A convenience only: Core still checks every folder, and missing storage just means blank fields.
const KEY = "goalport.goalDefaults";

export interface GoalDefaults {
  workspace: string;
  provider: string;
}

export function readGoalDefaults(): GoalDefaults {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "null");
    return {
      workspace: typeof value?.workspace === "string" ? value.workspace : "",
      provider: typeof value?.provider === "string" ? value.provider : ""
    };
  } catch {
    return { workspace: "", provider: "" };
  }
}

export function rememberGoalDefaults(defaults: GoalDefaults): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(defaults));
  } catch {
    // The next goal simply starts blank.
  }
}
