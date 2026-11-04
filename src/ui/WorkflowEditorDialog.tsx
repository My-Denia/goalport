import { useState, type FormEvent } from "react";
import { RECOMMENDED_V1, MAX_WORKFLOW_NAME } from "../../electron/workflow-checks.mjs";
import type { WorkflowChecks, WorkflowDefinition, WorkflowSaveInput } from "../types";
import { GoalDialog } from "./GoalDialog";

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
/** Only Checks can be changed in this version; the rest follow Recommended. */
const FIXED_GROUPS = ["Planning", "Execution", "Resources", "Feedback & continuation", "Delivery"] as const;

function freeName(taken: readonly string[]): string {
  const lower = new Set(taken.map((name) => name.toLowerCase()));
  if (!lower.has("my workflow")) return "My workflow";
  for (let n = 2; ; n += 1) if (!lower.has(`my workflow ${n}`)) return `My workflow ${n}`;
}

/**
 * The user has the recommended method in front of them and wants to switch off what they
 * don't need and call it their own. One dialog on the shared modal card; only the Checks
 * group has controls, every other group says it follows Recommended.
 */
export function WorkflowEditorDialog({ workflow, otherNames, onSave, onDelete, onClose }: WorkflowEditorDialogProps) {
  const base: WorkflowChecks = workflow?.modules.checks ?? RECOMMENDED_V1.modules.checks;
  const [name, setName] = useState(workflow?.name ?? freeName(otherNames));
  const [planReview, setPlanReview] = useState(base.planReview === "on");
  const [readsFiles, setReadsFiles] = useState(base.reviewerNeeds.readWorkspace === "required");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const trimmed = name.trim();
    if (!trimmed) { setError("Give it a name."); return; }
    setBusy(true); setError(null);
    const result = await onSave({
      ...(workflow ? { id: workflow.id } : {}),
      name: trimmed,
      modules: { checks: {
        ...base,
        planReview: planReview ? "on" : "off",
        reviewerNeeds: { readWorkspace: readsFiles ? "required" : "preferred" },
      } },
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
      <form onSubmit={(event) => { void submit(event); }}>
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
