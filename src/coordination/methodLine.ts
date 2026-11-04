import type { CoordinationDecision } from "../../electron/coordination-decision.mjs";
import type { CoordinationVerdict } from "./verdict";

/** Which workflow definition a coordinated result ran under. */
export interface WorkflowRef {
  readonly id: string;
  readonly version: number;
  /** The name the user knows it by; absent on older records. */
  readonly name?: string;
  /** What actually happened: "off" only when review did not run because the definition says so. */
  readonly planReview?: "on" | "off";
}

/** One check whose reply actually came back. Absence means it did not run. */
export interface CheckRan {
  readonly kind: "plan-check" | "audit";
  readonly harness: string;
  readonly verdict: CoordinationVerdict | null;
}

/**
 * What one dispatched model turn was actually launched with, read from the
 * command that went out. `preference` is what the workflow asked for;
 * `applied` is true only when the launch carried it (an unavailable swap runs
 * the unchanged command and records applied: false).
 */
export interface TurnRan {
  readonly role: "plan" | "review" | "execute" | "audit";
  /** The harness instance id: codex, claude or pi. */
  readonly harness: string;
  readonly model: string | null;
  readonly effort: string | null;
  readonly preference: "default" | "faster" | "stronger";
  readonly applied: boolean;
}

const RECOMMENDED_NAME = "Recommended workflow";
// "Independent verification" is the word the result page already uses for the audit step.
const KIND_WORDS: Readonly<Record<CheckRan["kind"], string>> = { "plan-check": "plan check", audit: "verification" };

/** One honest line of what ran; null when the method is unknown, so nothing is guessed. No verdict words. */
export function methodLine(workflow: WorkflowRef | null | undefined, checksRan: readonly CheckRan[] | null | undefined, decision?: CoordinationDecision | null): string | null {
  const name = workflow ? (workflow.name?.trim() || (workflow.id === "recommended" ? RECOMMENDED_NAME : "")) : "";
  if (!workflow || !name || !checksRan) return null; // absent checksRan is unknown, not "none ran"
  if (workflow.planReview === "off") return `${name} v${workflow.version} · Independent review: not run (off in ${name})`;
  const ran = [...new Set(checksRan.map((check) => `${KIND_WORDS[check.kind]} by ${check.harness}`))];
  const line = `${name} v${workflow.version} · ${ran.length === 0 ? "No check ran" : `Ran: ${ran.join(", ")}`}`;
  // Only when the setting itself changed what ran; a stop for any other reason says nothing about it.
  if (decision?.kind !== "automatic-off") return line;
  return `${line} · ${decision.stage === "plan" ? "Automatic plan revision" : "Automatic repair"}: off in ${name}`;
}

const ROLE_ORDER: readonly TurnRan["role"][] = ["plan", "review", "execute", "audit"];
const ROLE_WORDS: Readonly<Record<TurnRan["role"], string>> = { plan: "Plan", review: "Check", execute: "Changes", audit: "Verification" };
const HARNESS_WORDS: Readonly<Record<string, string>> = { codex: "Codex", claude: "Claude", pi: "Pi" };

const MODEL_SHOWN_MAX = 40;
/** Long ids (ARNs) keep their start and end so they stay recognisable in one line. */
function shownModel(model: string, full: boolean): string {
  if (full || model.length <= MODEL_SHOWN_MAX) return model;
  return `${model.slice(0, 18)}…${model.slice(-18)}`;
}

function turnWords(source: TurnRan, full: boolean): string {
  const turn = source.model ? { ...source, model: shownModel(source.model, full) } : source;
  const name = HARNESS_WORDS[turn.harness] ?? turn.harness;
  if (turn.preference !== "default" && turn.applied) {
    if (turn.harness === "claude") {
      return `${name}${turn.model ? ` ${turn.model}` : ""}${turn.effort ? `, ${turn.effort} effort` : ""} (${turn.preference})`;
    }
    return `${name}, ${turn.effort ?? ""} ${turn.harness === "pi" ? "thinking" : "effort"} (${turn.preference})`;
  }
  if (turn.preference !== "default") {
    if (turn.harness === "pi") return `${name}${turn.model ? ` ${turn.model}` : ""} (its own setting)`;
    return turn.harness === "claude" && !turn.model ? `${name} (no change with an API key)` : `${name}${turn.model ? ` ${turn.model}` : ""} (no change)`;
  }
  if (turn.harness === "claude") return `${name}${turn.model ? ` ${turn.model}` : ""}`;
  if (turn.harness === "pi" && turn.model) return `${name} ${turn.model}`;
  return `${name} (its own setting)`;
}

/**
 * One plain line of which model setting each step really ran with, from the
 * recorded launches only. Null when nothing was recorded or no step asked for
 * a change, so a default run shows nothing new. The last launch per step wins,
 * because a replacement agent is the one that finished the step. It never
 * says faster or stronger unless the launch carried it.
 */
export function resourcesLine(turnsRan: readonly TurnRan[] | null | undefined, full = false): string | null {
  if (!turnsRan || turnsRan.length === 0 || turnsRan.every((turn) => turn.preference === "default")) return null;
  const parts: string[] = [];
  for (const role of ROLE_ORDER) {
    const last = [...turnsRan].reverse().find((turn) => turn.role === role);
    if (last) parts.push(`${ROLE_WORDS[role]}: ${turnWords(last, full)}`);
  }
  return parts.length === 0 ? null : parts.join(" · ");
}

/** Hover text with the untruncated model ids; null when the line already shows everything. */
export function resourcesTitle(turnsRan: readonly TurnRan[] | null | undefined): string | null {
  const full = resourcesLine(turnsRan, true);
  return full !== null && full !== resourcesLine(turnsRan) ? full : null;
}
