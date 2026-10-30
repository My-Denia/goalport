import type { ExecutionWorkspaceEvidence, AuditInputEvidenceCoverage, UntrackedFileSnapshot } from "../coordination/coordinateGoal";

export interface WorkspaceEvidenceDetailsProps {
  readonly evidence?: ExecutionWorkspaceEvidence | null;
  readonly executionText?: string | null;
  readonly executionHarness?: string | null;
  readonly auditInputEvidenceCoverage?: AuditInputEvidenceCoverage | null;
  readonly auditInputEvidenceText?: string | null;
}

function UntrackedFiles({ files, omitted = 0 }: { files: readonly UntrackedFileSnapshot[]; omitted?: number }) {
  return (
    <>
      <ul>
        {files.map((file) => (
          <li key={file.path}>
            <code>{file.path}</code>
            {file.skipped
              ? ` [${file.skipped}]`
              : file.binary
                ? ` (binary, ${file.size} bytes; content not captured)`
                : file.size != null
                  ? ` (${file.size} bytes${file.truncated ? ", capture truncated" : ""})`
                  : ""}
            {typeof file.content === "string" && !file.skipped && !file.binary ? (
              <pre className="workspace-diff-view workspace-untracked-content" tabIndex={0}>{file.content}</pre>
            ) : null}
          </li>
        ))}
      </ul>
      {omitted > 0 ? <p className="workspace-evidence-crop-note">{omitted} additional paths were omitted by the capture file limit.</p> : null}
    </>
  );
}

export function WorkspaceEvidenceDetails({
  evidence,
  executionText,
  executionHarness,
  auditInputEvidenceCoverage,
  auditInputEvidenceText,
}: WorkspaceEvidenceDetailsProps) {
  if (!evidence && !executionText) return null;

  const incompleteMaterial = Boolean(auditInputEvidenceCoverage?.cropped || (evidence && (
    !evidence.complete || evidence.truncated || evidence.status !== "available" ||
    evidence.untrackedFilesOmitted || evidence.beforeUntrackedFilesOmitted ||
    [...(evidence.untrackedFiles ?? []), ...(evidence.beforeUntrackedFiles ?? [])]
      .some(file => file.binary || file.skipped || file.truncated)
  )));

  const changedSummary = evidence
    ? evidence.changed === true
      ? " — changes observed"
      : evidence.changed === false
        ? " — no changes"
        : ` — ${evidence.status}`
    : "";

  return (
    <div className="workspace-evidence-container">
      {evidence ? (
        <details className="draft-hint workspace-captured-evidence">
          <summary>Workspace changes{changedSummary}</summary>
          <div className="workspace-evidence-content">
            <p className="workspace-evidence-label">
              {evidence.label || "Workspace before/after this round (observation; may include preexisting or concurrent edits)"}
            </p>
            {evidence.reason ? <p className="workspace-evidence-reason">{evidence.reason}</p> : null}
            {evidence.comparisonBaseline?.headCommit ? (
              <p className="workspace-evidence-baseline">
                <code>Baseline: {evidence.comparisonBaseline.headCommit.slice(0, 8)}</code>
              </p>
            ) : null}
            {evidence.afterDiff ? (
              <div className="workspace-diff-wrapper">
                <h4>Captured AFTER tracked diff</h4>
                <pre className="workspace-diff-view" tabIndex={0}>{evidence.afterDiff}</pre>
              </div>
            ) : null}
            {evidence.untrackedFiles && evidence.untrackedFiles.length > 0 ? (
              <div className="workspace-untracked-wrapper">
                <h4>New untracked files after execution ({evidence.untrackedFiles.length})</h4>
                <UntrackedFiles files={evidence.untrackedFiles} omitted={evidence.untrackedFilesOmitted} />
              </div>
            ) : null}
            {evidence.beforeDiff ? (
              <details className="workspace-before-diff">
                <summary>Pre-execution baseline diff</summary>
                <pre className="workspace-diff-view" tabIndex={0}>{evidence.beforeDiff}</pre>
              </details>
            ) : null}
            {evidence.beforeUntrackedFiles && evidence.beforeUntrackedFiles.length > 0 ? (
              <details className="workspace-before-diff">
                <summary>Untracked files before execution ({evidence.beforeUntrackedFiles.length})</summary>
                <UntrackedFiles files={evidence.beforeUntrackedFiles} omitted={evidence.beforeUntrackedFilesOmitted} />
              </details>
            ) : null}
            {auditInputEvidenceCoverage || auditInputEvidenceText ? (
              <details className="workspace-audit-input">
                <summary>What the independent audit received</summary>
                {incompleteMaterial ? <p>Only part of the workspace material was supplied; omitted content was not delivered in this prompt.</p> : null}
                {auditInputEvidenceCoverage ? (
                  <p className="workspace-evidence-crop-note">
                    Audit delivery contains {auditInputEvidenceCoverage.includedEvidenceBytes} of {auditInputEvidenceCoverage.totalEvidenceBytes} original captured-material bytes; crop notices are additional.
                    The complete assembled prompt was {auditInputEvidenceCoverage.promptBytes} UTF-8 bytes{auditInputEvidenceCoverage.promptBudgetBytes ? ` within its ${auditInputEvidenceCoverage.promptBudgetBytes}-byte budget` : ""}.
                    {auditInputEvidenceCoverage.promptDelivery ? ` Selected prompt transport: ${auditInputEvidenceCoverage.promptDelivery}.${auditInputEvidenceCoverage.promptDelivery === "stdin" ? " GoalPort writes host UTF-8 bytes and EOF; Pi trims edge whitespace before building its message." : ""}` : ""}
                    {auditInputEvidenceCoverage.croppedSections && auditInputEvidenceCoverage.croppedSections.length > 0
                      ? ` Cropped: ${auditInputEvidenceCoverage.croppedSections.join(", ")}.`
                      : " No captured-material section was cropped for transport."}
                  </p>
                ) : null}
                {auditInputEvidenceText ? (
                  <pre className="workspace-diff-view workspace-audit-input-text" tabIndex={0}>{auditInputEvidenceText}</pre>
                ) : <p>The exact delivered evidence subset was not retained in this older record.</p>}
              </details>
            ) : null}
          </div>
        </details>
      ) : null}

      {executionText ? (
        <details className="draft-hint workspace-executor-report">
          <summary>Executor report{executionHarness ? ` — ${executionHarness}` : ""}</summary>
          <p>{executionText}</p>
        </details>
      ) : null}
    </div>
  );
}
