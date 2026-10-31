import { useMemo } from "react";
import type { ProductConversation, ProductConversationItem } from "../types";
import { formatTimestamp } from "../lib/display";
import { renderMarkdownBody } from "../lib/markdown";

/**
 * The normal conversation surface: renders ONLY `productConversation.items`.
 * The raw timeline is never a fallback for this view (that lives in Developer
 * diagnostics). Item kinds outside the allowlist do not exist by construction
 * (the normalizer drops them); this component still renders defensively — an
 * unknown kind would render as a plain system row, never as a message.
 */

function Timestamp({ value }: { value?: string }) {
  const formatted = formatTimestamp(value);
  if (!formatted) return null;
  return <time>{formatted}</time>;
}

function UserMessage({ item }: { item: ProductConversationItem }) {
  return (
    <article className="tl-event tl-user" data-kind="user-message">
      <div className="tl-user-body">
        <div className="tl-bubble">{renderMarkdownBody(item.body, item.id)}</div>
        <div className="tl-meta">
          <span>You</span>
          <Timestamp value={item.timestamp} />
        </div>
      </div>
    </article>
  );
}

function AssistantMessage({ item, agentName }: { item: ProductConversationItem; agentName: string }) {
  return (
    <article className="tl-event tl-agent" data-kind="assistant-message">
      <div className="tl-avatar" aria-hidden="true">◎</div>
      <div className="tl-event-body">
        <div className="tl-meta">
          <span className="tl-actor">{item.actor?.trim() || agentName}</span>
          <Timestamp value={item.timestamp} />
        </div>
        <div className="tl-agent-body">{renderMarkdownBody(item.body, item.id)}</div>
      </div>
    </article>
  );
}

function HandoffSummary({ item }: { item: ProductConversationItem }) {
  return (
    <article className="tl-event tl-system card-accent-blue" data-kind="handoff-summary">
      <div className="tl-avatar" aria-hidden="true">⇄</div>
      <div className="tl-event-body">
        <div className="tl-meta">
          <span className="tl-kind">Handoff</span>
          <Timestamp value={item.timestamp} />
        </div>
        <div className="tl-system-title">{item.body}</div>
      </div>
    </article>
  );
}

/**
 * Actionable runtime failure: one honest, actionable sentence; the exact raw
 * technical context sits in a collapsed disclosure. No guessed cause.
 */
function ActionableError({ item, onChooseRuntime, onDiagnose }: { item: ProductConversationItem; onChooseRuntime?: () => void; onDiagnose?: () => void }) {
  return (
    <article className="tl-event tl-system card-accent-red" data-kind="actionable-error">
      <div className="tl-avatar" aria-hidden="true">⚠</div>
      <div className="tl-event-body">
        <div className="tl-meta">
          <span className="tl-kind">The agent reported a problem</span>
          <Timestamp value={item.timestamp} />
        </div>
        <div className="tl-system-body">{item.body}</div>
        {item.actions?.includes("select-runtime") && onChooseRuntime ? (
          <button className="button button-small button-outline" type="button" onClick={onChooseRuntime}>Choose agent</button>
        ) : item.actions?.includes("diagnose") && onDiagnose ? (
          <button className="button button-small button-outline" type="button" onClick={onDiagnose}>Open details</button>
        ) : null}
        {item.technicalDetails ? (
          <details className="technical-details">
            <summary>Technical details</summary>
            <pre className="technical-details-pre">{item.technicalDetails}</pre>
          </details>
        ) : null}
      </div>
    </article>
  );
}

/** One grouped, collapsed row of REAL tool activity. No invented time/actions. */
function stepLabel(count: number): string {
  if (count === 0) return "Working notes";
  return count === 1 ? "1 step" : `${count} steps`;
}

/** Everything an agent said on the way to its answer, folded so the answer stands alone. */
function WorkingGroup({ items, agentName }: { items: ProductConversationItem[]; agentName: string }) {
  return (
    <details className="activity-group" data-kind="working">
      <summary><span aria-hidden="true">⌁</span>{stepLabel(items.filter((item) => item.kind === "activity-summary").length)}</summary>
      {items.map((item) => item.kind === "assistant-message"
        ? <AssistantMessage key={item.id} agentName={agentName} item={item} />
        : <p className="activity-step" key={item.id}><span>{item.body}</span><Timestamp value={item.timestamp} /></p>)}
    </details>
  );
}

/** Groups consecutive activity-summary items; everything else renders directly. */
function renderItems(items: ProductConversationItem[], agentName: string, onChooseRuntime?: () => void, onDiagnose?: () => void) {
  const nodes: React.ReactNode[] = [];
  // Within one exchange, every message before the last is working, not the answer.
  const finalAnswers = new Set<string>();
  let last: ProductConversationItem | null = null;
  for (const item of items) {
    if (item.kind === "user-message") { if (last) finalAnswers.add(last.id); last = null; }
    else if (item.kind === "assistant-message") last = item;
  }
  if (last) finalAnswers.add(last.id);
  let working: ProductConversationItem[] = [];
  const flushWorking = () => {
    if (working.length > 0) {
      nodes.push(<WorkingGroup key={`working-${working[0].id}`} items={working} agentName={agentName} />);
      working = [];
    }
  };
  for (const item of items) {
    if (item.kind === "activity-summary" || (item.kind === "assistant-message" && !finalAnswers.has(item.id))) {
      working.push(item);
      continue;
    }
    flushWorking();
    switch (item.kind) {
      case "user-message":
        nodes.push(<UserMessage key={item.id} item={item} />);
        break;
      case "assistant-message":
        nodes.push(<AssistantMessage agentName={agentName} key={item.id} item={item} />);
        break;
      case "actionable-error":
        nodes.push(<ActionableError key={item.id} item={item} onChooseRuntime={onChooseRuntime} onDiagnose={onDiagnose} />);
        break;
      case "handoff-summary":
        nodes.push(<HandoffSummary key={item.id} item={item} />);
        break;
      default:
        // Unknown product kinds are not ordinary conversation content.
        break;
    }
  }
  flushWorking();
  return nodes;
}

/** Join adjacent bounded fragments after pages are merged, without changing their stored IDs. */
export function coalesceVisibleFragments(items: ProductConversationItem[]): ProductConversationItem[] {
  const visible: ProductConversationItem[] = [];
  for (const item of items) {
    const logicalId = item.logicalItemId;
    const previous = visible.at(-1);
    const fragmentCoverageIsContinuous = previous
      ? (!previous.continuesAfter && !item.continuesBefore)
        || item.fragmentIndex === (previous.fragmentIndex ?? 0) + 1
      : false;
    if (logicalId && previous?.logicalItemId === logicalId && previous.kind === item.kind
      && fragmentCoverageIsContinuous) {
      // A completed provider item repeats the whole message after its deltas.
      // That fragment replaces the streamed text; a later delta still appends.
      // Stored replies may have lost whitespace deltas, so spacing doesn't count.
      const replacesStream = previous.body.trim().length > 0 && withoutSpacing(item.body).startsWith(withoutSpacing(previous.body));
      visible[visible.length - 1] = {
        ...previous,
        body: replacesStream ? item.body : previous.body + item.body,
        continuesAfter: item.continuesAfter,
        technicalDetails: item.technicalDetails ?? previous.technicalDetails
      };
    } else {
      visible.push({ ...item });
    }
  }
  return visible.filter((item) => item.body.trim().length > 0);
}

function withoutSpacing(text: string): string {
  return text.replace(/\s+/g, "");
}

interface ProductConversationViewProps {
  product: ProductConversation;
  loadingEarlier?: boolean;
  onLoadEarlier?: () => void;
  onChooseRuntime?: () => void;
  onDiagnose?: () => void;
}

export function ProductConversationView({ product, loadingEarlier = false, onLoadEarlier, onChooseRuntime, onDiagnose }: ProductConversationViewProps) {
  const visibleItems = useMemo(() => coalesceVisibleFragments(product.items), [product.items]);
  const nodes = useMemo(() => renderItems(visibleItems, product.runtime.name?.trim() || "Agent", onChooseRuntime, onDiagnose), [visibleItems, product.runtime.name, onChooseRuntime, onDiagnose]);
  return (
    <div className="timeline-inner" data-product-conversation="true">
      {product.runtime.provider === "codex" && product.session?.transport === "exec" ? <p className="draft-hint" role="status">Codex can't continue this conversation after this turn.</p> : null}
      {product.pageInfo?.hasOlder && onLoadEarlier ? (
        <button className="button button-quiet history-load-earlier" type="button" onClick={onLoadEarlier} disabled={loadingEarlier}>
          {loadingEarlier ? "Loading earlier…" : "Load earlier"}
        </button>
      ) : null}
      {product.items.length === 0 ? (
        <div className="timeline-intro">
          <p className="timeline-intro-copy">No messages yet. Send the first message below.</p>
        </div>
      ) : nodes}
    </div>
  );
}
