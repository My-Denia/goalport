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

function AssistantMessage({ item }: { item: ProductConversationItem }) {
  return (
    <article className="tl-event tl-agent" data-kind="assistant-message">
      <div className="tl-avatar" aria-hidden="true">◎</div>
      <div className="tl-event-body">
        <div className="tl-meta">
          <span className="tl-actor">{item.actor?.trim() || "Runtime"}</span>
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
function ActionableError({ item }: { item: ProductConversationItem }) {
  return (
    <article className="tl-event tl-system card-accent-red" data-kind="actionable-error">
      <div className="tl-avatar" aria-hidden="true">⚠</div>
      <div className="tl-event-body">
        <div className="tl-meta">
          <span className="tl-kind">Runtime reported a problem</span>
          <Timestamp value={item.timestamp} />
        </div>
        <div className="tl-system-body">{item.body}</div>
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
function ActivityGroup({ items }: { items: ProductConversationItem[] }) {
  return (
    <details className="activity-group" data-kind="activity-summary">
      <summary>
        <span aria-hidden="true">⌁</span>
        {items.length === 1 ? "1 activity update" : `${items.length} activity updates`}
      </summary>
      <ul className="activity-rows">
        {items.map((item) => (
          <li key={item.id}>
            <span className="activity-body">{item.body}</span>
            <Timestamp value={item.timestamp} />
          </li>
        ))}
      </ul>
    </details>
  );
}

/** Groups consecutive activity-summary items; everything else renders directly. */
function renderItems(items: ProductConversationItem[]) {
  const nodes: React.ReactNode[] = [];
  let activity: ProductConversationItem[] = [];
  const flush = () => {
    if (activity.length > 0) {
      nodes.push(<ActivityGroup key={`activity-${activity[0].id}`} items={activity} />);
      activity = [];
    }
  };
  for (const item of items) {
    if (item.kind === "activity-summary") {
      activity.push(item);
      continue;
    }
    flush();
    switch (item.kind) {
      case "user-message":
        nodes.push(<UserMessage key={item.id} item={item} />);
        break;
      case "assistant-message":
        nodes.push(<AssistantMessage key={item.id} item={item} />);
        break;
      case "actionable-error":
        nodes.push(<ActionableError key={item.id} item={item} />);
        break;
      case "handoff-summary":
        nodes.push(<HandoffSummary key={item.id} item={item} />);
        break;
      default:
        // Unknown product kinds are not ordinary conversation content.
        break;
    }
  }
  flush();
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
      visible[visible.length - 1] = {
        ...previous,
        body: previous.body + item.body,
        continuesAfter: item.continuesAfter,
        technicalDetails: item.technicalDetails ?? previous.technicalDetails
      };
    } else {
      visible.push({ ...item });
    }
  }
  return visible;
}

interface ProductConversationViewProps {
  product: ProductConversation;
  loadingEarlier?: boolean;
  onLoadEarlier?: () => void;
}

export function ProductConversationView({ product, loadingEarlier = false, onLoadEarlier }: ProductConversationViewProps) {
  const visibleItems = useMemo(() => coalesceVisibleFragments(product.items), [product.items]);
  const nodes = useMemo(() => renderItems(visibleItems), [visibleItems]);
  return (
    <div className="timeline-inner" data-product-conversation="true">
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
