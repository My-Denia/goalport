import { useState } from "react";
import type { TurnCommandFact, TurnFileFact, TurnResult } from "../types";

interface TurnResultsProps {
  results: TurnResult[] | undefined;
}

const REPLY_LABEL: Record<TurnResult["replyState"], string> = {
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  uncertain: "Uncertain"
};

/**
 * The user came back to a finished turn and wants to check the final reply,
 * which files were already dirty, what changed afterwards, and which commands
 * actually finished. A reply that mentions tests is not an exit code.
 */
export function TurnResults({ results }: TurnResultsProps) {
  if (!results || results.length === 0) return null;
  const ordered = [...results].reverse();
  return (
    <section className="turn-results" aria-label="Results">
      <h2>Results</h2>
      {ordered.map((result, index) => (
        <article className="turn-result" key={`${result.requestId}-${index}`}>
          <header className="turn-result-head">
            <span className={`turn-reply-state reply-${result.replyState}`}>{REPLY_LABEL[result.replyState]}</span>
          </header>
          {result.replyText ? <ReplyBody text={result.replyText} /> : <p className="turn-reply muted">No final reply for this turn.</p>}
          {result.baselineRecorded ? (
            <>
              <FileGroup title="Already in the workspace" files={result.before} empty="No dirty, staged, or untracked files were recorded at the start." />
              <FileGroup title="Changed during this turn" files={result.during} empty="No file edit in this turn named a path." />
              <FileGroup title="Changed, not tied to a file edit" files={result.unattributed} empty="" />
            </>
          ) : (
            <p className="baseline-missing">Baseline not recorded</p>
          )}
          <CommandList commands={result.commands} />
        </article>
      ))}
    </section>
  );
}

const REPLY_FOLD = 1200;

/** The stored reply is the final assistant item. Folding is only a reading aid. */
function ReplyBody({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  if (text.length <= REPLY_FOLD) return <p className="turn-reply">{text}</p>;
  return (
    <div className="turn-reply-block">
      <p className="turn-reply">{open ? text : `${text.slice(0, REPLY_FOLD).trimEnd()}…`}</p>
      <button className="button button-quiet turn-reply-more" type="button" onClick={() => setOpen((value) => !value)}>
        {open ? "Show less" : "Show the full reply"}
      </button>
    </div>
  );
}

function FileGroup({ title, files, empty }: { title: string; files: TurnFileFact[]; empty: string }) {
  if (files.length === 0 && !empty) return null;
  return (
    <div className="turn-file-group">
      <h3>{title}</h3>
      {files.length === 0 ? <p className="muted">{empty}</p> : (
        <ul>
          {files.map((file) => (
            <li key={`${file.change}-${file.area}-${file.fromPath ?? ""}-${file.path}`}>
              <code>{file.fromPath ? `${file.fromPath} → ${file.path}` : file.path}</code>
              <span>{file.area} {file.status} {file.change === "before" ? "" : file.change}</span>
              {inspectionNote(file.contentInspection) ? <span className="muted">{inspectionNote(file.contentInspection)}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
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

function CommandList({ commands }: { commands: TurnCommandFact[] }) {
  return (
    <div className="turn-commands">
      <h3>Commands</h3>
      {commands.length === 0 ? <p className="muted">No command execution was recorded.</p> : (
        <ul>
          {commands.map((command, index) => (
            <li key={`${command.command}-${index}`}>
              <code>{command.command}</code>
              <span>{command.state}{command.exitCode === undefined ? "" : ` · exit ${command.exitCode}`}</span>
              {command.cwd ? <span className="turn-command-cwd">{command.cwd}</span> : null}
              {command.output ? <pre>{command.output}</pre> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
