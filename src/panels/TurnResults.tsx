import type { TurnCommandFact, TurnFileFact, TurnResult } from "../types";

interface TurnResultsProps {
  results: TurnResult[] | undefined;
  omittedTurns?: number;
}

const REPLY_LABEL: Record<TurnResult["replyState"], string> = {
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  uncertain: "Uncertain"
};

/**
 * What each turn changed. The reply is already in the conversation, so this
 * answers the other question: which files, and what ran to get there.
 * A reply that mentions tests is not an exit code; the commands stay reachable.
 */
export function TurnResults({ results, omittedTurns = 0 }: TurnResultsProps) {
  if ((!results || results.length === 0) && omittedTurns === 0) return null;
  const ordered = [...(results ?? [])].reverse();
  return (
    <section className="turn-results" aria-label="Results">
      {omittedTurns > 0 ? <p className="muted">Older turns are not shown here.</p> : null}
      {ordered.map((result, index) => {
        const changed = [...result.during, ...result.unattributed];
        return (
          <article className="turn-result" key={`${result.requestId}-${index}`}>
            {result.replyState === "completed" ? null : <p className={`turn-reply-state reply-${result.replyState}`}>{REPLY_LABEL[result.replyState]}</p>}
            {!result.baselineRecorded || result.comparisonUnavailable ? <p className="muted">Changes for this turn couldn't be compared.</p>
              : changed.length === 0 ? <p className="muted">No files changed.</p>
              : <FileList files={changed} />}
            {result.filesTruncated ? <p className="muted">Some file changes are not listed.</p> : null}
            {result.before.length > 0 ? <details><summary>Already changed before this turn · {result.before.length}</summary><FileList files={result.before} /></details> : null}
            {result.commands.length > 0 ? <details><summary>Commands run · {result.commands.length}</summary><CommandList commands={result.commands} truncated={result.commandsTruncated === true} /></details> : null}
          </article>
        );
      })}
    </section>
  );
}

function FileList({ files }: { files: TurnFileFact[] }) {
  return (
    <ul className="turn-file-list">
      {files.map((file) => (
        <li key={`${file.change}-${file.area}-${file.fromPath ?? ""}-${file.path}`}>
          <code>{file.fromPath ? `${file.fromPath} → ${file.path}` : file.path}</code>
          <span className="muted">{file.status}</span>
          {inspectionNote(file.contentInspection) ? <span className="muted">{inspectionNote(file.contentInspection)}</span> : null}
        </li>
      ))}
    </ul>
  );
}

function inspectionNote(inspection: TurnFileFact["contentInspection"]): string {
  switch (inspection) {
    case "binary":
      return "Content not inspected — binary file";
    case "too-large":
      return "Content not inspected — file exceeds 1 MB";
    case "unreadable":
      return "Content not inspected — file could not be read";
    case "available":
    case "not-applicable":
    case undefined:
      return "";
    default: {
      const unreachable: never = inspection;
      return unreachable;
    }
  }
}

function CommandList({ commands, truncated }: { commands: TurnCommandFact[]; truncated: boolean }) {
  return (
    <div className="turn-commands">
      <ul>
        {commands.map((command, index) => (
          <li key={`${command.command}-${index}`}>
            <code>{command.command}</code>
            <span>{command.state}{command.exitCode === undefined ? "" : ` · exit ${command.exitCode}`}</span>
            {command.output ? <pre>{command.output}</pre> : null}
          </li>
        ))}
      </ul>
      {truncated ? <p className="muted">Some commands from this turn are not listed.</p> : null}
    </div>
  );
}
