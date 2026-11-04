import { useState, type FormEvent } from "react";
import { RECOMMENDED_V1, MAX_WORKFLOW_NAME, DEFAULT_RESOURCES, DEFAULT_FEEDBACK, RESOURCE_BOUNDS } from "../../electron/workflow-checks.mjs";
import type { FeedbackChoice, FeedbackStage, ResourcePreference, ResourceRole, WorkflowFeedback, WorkflowResources } from "../../electron/workflow-checks.mjs";
import type { WorkflowChecks, WorkflowDefinition, WorkflowSaveInput } from "../types";
import { GoalDialog } from "./GoalDialog";
import { SegmentedRow } from "./SegmentedRow";

/** What a save or delete did, in the words the dialog can show. */
export type WorkflowEditResult = { ok: true; saved?: WorkflowDefinition } | { ok: false; error: string };

interface WorkflowEditorDialogProps {
  /** null: a new copy of Recommended. Otherwise the saved workflow being edited. */
  workflow: WorkflowDefinition | null;
  /** Names already in use by other saved workflows, so a copy can start with a free one. */
  otherNames: readonly string[];
  onSave: (input: WorkflowSaveInput) => Promise<WorkflowEditResult>;
  onDelete?: (id: string) => Promise<WorkflowEditResult>;
  onClose: () => void;
}

const SAME_AS_RECOMMENDED = "Same as Recommended v1";
/** Checks, Resources and Feedback can be changed in this version; the rest follow Recommended. */
const FIXED_GROUPS = ["Planning", "Execution", "Delivery"] as const;

const FEEDBACK_ROWS: ReadonlyArray<{ stage: FeedbackStage; label: string; automatic: string }> = [
  { stage: "planRevision", label: "When the plan check asks for changes", automatic: "Revise the plan automatically" },
  { stage: "repair", label: "When verification asks for changes", automatic: "Repair automatically" },
];

const ROLE_ROWS: ReadonlyArray<{ role: ResourceRole; label: string; note?: string }> = [
  { role: "plan", label: "Writing the plan" },
  { role: "review", label: "Independent check" },
  { role: "execute", label: "Making changes", note: "Only for goals that change files" },
  { role: "audit", label: "Verification", note: "Only for goals that change files" },
];
const PREFERENCES: ReadonlyArray<{ value: ResourcePreference; label: string }> = [
  { value: "default", label: "Default" }, { value: "faster", label: "Faster" }, { value: "stronger", label: "Stronger" },
];
const BOUNDS = RESOURCE_BOUNDS;

function freeName(taken: readonly string[]): string {
  const lower = new Set(taken.map((name) => name.toLowerCase()));
  if (!lower.has("my workflow")) return "My workflow";
  for (let n = 2; ; n += 1) if (!lower.has(`my workflow ${n}`)) return `My workflow ${n}`;
}

/**
 * The user has the recommended method in front of them and wants to switch off what they
 * don't need and call it their own. One dialog on the shared modal card; Checks, Resources and
 * Feedback have controls, every other group says it follows Recommended.
 */
export function WorkflowEditorDialog({ workflow, otherNames, onSave, onDelete, onClose }: WorkflowEditorDialogProps) {
  const base: WorkflowChecks = workflow?.modules.checks ?? RECOMMENDED_V1.modules.checks;
  const [name, setName] = useState(workflow?.name ?? freeName(otherNames));
  const [planReview, setPlanReview] = useState(base.planReview === "on");
  const [readsFiles, setReadsFiles] = useState(base.reviewerNeeds.readWorkspace === "required");
  const baseResources: WorkflowResources = workflow?.modules.resources ?? DEFAULT_RESOURCES;
  const [roles, setRoles] = useState<Record<ResourceRole, ResourcePreference>>({ ...baseResources.roles });
  const [readTurns, setReadTurns] = useState(String(baseResources.budget.readTurns));
  const [writeTurns, setWriteTurns] = useState(String(baseResources.budget.writeTurns));
  const [feedback, setFeedback] = useState<WorkflowFeedback>({ ...(workflow?.modules.feedback ?? DEFAULT_FEEDBACK) });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const trimmed = name.trim();
    if (!trimmed) { setError("Give it a name."); return; }
    const reads = Number(readTurns), writes = Number(writeTurns);
    if (!Number.isInteger(reads) || reads < BOUNDS.readTurns.min || reads > BOUNDS.readTurns.max) { setError(`Turn limit to start with: choose ${BOUNDS.readTurns.min} to ${BOUNDS.readTurns.max}.`); return; }
    if (!Number.isInteger(writes) || writes < BOUNDS.writeTurns.min || writes > BOUNDS.writeTurns.max) { setError(`File-change turn limit: choose ${BOUNDS.writeTurns.min} to ${BOUNDS.writeTurns.max}.`); return; }
    setBusy(true); setError(null);
    const result = await onSave({
      ...(workflow ? { id: workflow.id } : {}),
      name: trimmed,
      modules: { checks: {
        ...base,
        planReview: planReview ? "on" : "off",
        reviewerNeeds: { readWorkspace: readsFiles ? "required" : "preferred" },
      }, resources: { roles, budget: { readTurns: reads, writeTurns: writes } }, feedback },
    });
    // On success the owner closes the dialog; only a refusal keeps it open.
    if (!result.ok) { setError(result.error); setBusy(false); }
  };

  const remove = async () => {
    if (!workflow || !onDelete || busy) return;
    setBusy(true); setError(null);
    const result = await onDelete(workflow.id);
    if (!result.ok) { setError(result.error); setBusy(false); setConfirmingDelete(false); }
  };

  return (
    <GoalDialog label={workflow ? "Edit workflow" : "Copy Recommended workflow"} className="workflow-editor-dialog" onDismiss={onClose}>
      <form noValidate onSubmit={(event) => { void submit(event); }}>
        <h2>{workflow ? "Edit workflow" : "Copy Recommended workflow"}</h2>
        <p className="dialog-lead">Start from the recommended method, switch off what you don't need, and give it a name. You can pick it for any new goal.</p>
        <label className="field-label" htmlFor="workflow-name">Name</label>
        <div className="field-with-icon workflow-name-field">
          <input id="workflow-name" value={name} maxLength={MAX_WORKFLOW_NAME} autoComplete="off" disabled={busy}
            onChange={(event) => { setName(event.target.value); setError(null); }} />
        </div>

        <div className="workflow-groups">
          <section className="workflow-group workflow-group-open" aria-label="Checks">
            <h3>Checks</h3>
            <label className="workflow-option">
              <input type="checkbox" checked={planReview} disabled={busy} onChange={(event) => setPlanReview(event.target.checked)} />
              <span>
                <strong>Independent plan review</strong>
                <small>Another agent checks the plan before anything happens. Goals that change files are always reviewed first.</small>
              </span>
            </label>
            <label className="workflow-option">
              <input type="checkbox" checked={readsFiles} disabled={busy || !planReview} onChange={(event) => setReadsFiles(event.target.checked)} />
              <span>
                <strong>Reviewer must be able to read your files</strong>
                <small>When required, an agent that cannot open files (Pi) is never the reviewer.</small>
              </span>
            </label>
          </section>
          <section className="workflow-group workflow-group-open" aria-label="Resources">
            <h3>Resources</h3>
            <p className="workflow-resources-lead">Faster or Stronger changes how hard an agent works: Codex and Pi think less or more; Claude uses Sonnet for Faster and thinks harder on Opus for Stronger. Claude with an API key stays as it is.</p>
            {ROLE_ROWS.map(({ role, label, note }) => (
              <SegmentedRow key={role} name={role} label={label} note={note} options={PREFERENCES} value={roles[role]} disabled={busy}
                onChange={(value) => setRoles((current) => ({ ...current, [role]: value }))} />
            ))}
            <div className="resource-turns">
              <label className="resource-turn">
                <span>Turn limit to start with</span>
                <input id="workflow-read-turns" type="number" inputMode="numeric" min={BOUNDS.readTurns.min} max={BOUNDS.readTurns.max} value={readTurns} disabled={busy}
                  onChange={(event) => { setReadTurns(event.target.value); setError(null); }} />
              </label>
              <label className="resource-turn">
                <span>File-change turn limit</span>
                <input id="workflow-write-turns" type="number" inputMode="numeric" min={BOUNDS.writeTurns.min} max={BOUNDS.writeTurns.max} value={writeTurns} disabled={busy}
                  onChange={(event) => { setWriteTurns(event.target.value); setError(null); }} />
              </label>
            </div>
            <small className="workflow-resources-note">These only fill in the turn limits for a new goal. They never change access you already gave.</small>
          </section>
          <section className="workflow-group workflow-group-open" aria-label="Feedback & continuation">
            <h3>Feedback &amp; continuation</h3>
            <p className="workflow-resources-lead">Stop and ask me keeps GoalPort from spending another round until you decide.</p>
            {FEEDBACK_ROWS.map(({ stage, label, automatic }) => (
              <SegmentedRow<FeedbackChoice> key={stage} stacked name={stage} label={label} note="Only for goals that change files" disabled={busy}
                options={[{ value: "automatic", label: <>{automatic} <em className="resource-recommended">Recommended</em></> }, { value: "ask", label: "Stop and ask me" }]}
                value={feedback[stage]} onChange={(value) => setFeedback((current) => ({ ...current, [stage]: value }))} />
            ))}
          </section>
          {FIXED_GROUPS.map((group) => (
            <section key={group} className="workflow-group" aria-label={group}>
              <h3>{group}</h3>
              <p>{SAME_AS_RECOMMENDED}</p>
            </section>
          ))}
        </div>

        {error ? <div className="dialog-note" role="alert"><span aria-hidden="true">!</span><span>{error}</span></div> : null}

        {confirmingDelete && workflow ? (
          <div className="workflow-delete-confirm" role="group" aria-label="Delete this workflow">
            <p>Delete “{workflow.name}”? Results already made with it stay as they are.</p>
            <div className="dialog-actions">
              <button className="button button-outline" type="button" disabled={busy} onClick={() => setConfirmingDelete(false)}>Keep it</button>
              <button className="button button-danger" type="button" disabled={busy} onClick={() => { void remove(); }}>Delete workflow</button>
            </div>
          </div>
        ) : (
          <div className="dialog-actions workflow-actions">
            {workflow && onDelete ? <button className="button button-quiet workflow-delete" type="button" disabled={busy} onClick={() => setConfirmingDelete(true)}>Delete…</button> : null}
            <button className="button button-outline" type="button" disabled={busy} onClick={onClose}>Cancel</button>
            <button className="button button-primary" type="submit" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
          </div>
        )}
      </form>
    </GoalDialog>
  );
}
