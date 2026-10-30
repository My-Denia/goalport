import { useEffect, useState } from "react";
import type { ProductConversation, TurnResult } from "../types";

const KEY = "goalport.lastSeenAnswers";

function readSeen(): Record<string, number> {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function rememberSeen(seen: Record<string, number>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(seen));
  } catch {
    // The next visit simply shows no summary.
  }
}

/** One line on coming back: the answers are below; this says what happened while away. */
export function SinceLastVisit({ campaignId, product, results }: { campaignId: string; product: ProductConversation; results: TurnResult[] | undefined }) {
  const answers = product.items.filter((item) => item.kind === "user-message").length;
  const working = product.turn.canStop;
  const [summary, setSummary] = useState<string | null>(null);
  useEffect(() => {
    const seen = readSeen();
    const before = seen[campaignId];
    if (before !== undefined && answers > before && !working) {
      const files = (results ?? []).at(-1);
      const count = files ? files.during.length + files.unattributed.length : 0;
      setSummary(`${product.runtime.name || "The agent"} finished while you were away${count > 0 ? ` · ${count} ${count === 1 ? "file" : "files"} changed` : ""}.`);
    }
    if (!working) rememberSeen({ ...seen, [campaignId]: answers });
    // Only a new goal on screen or a finished turn is a new visit.
  }, [campaignId, working]);
  useEffect(() => setSummary(null), [campaignId]);
  if (!summary) return null;
  return <div className="since-last-visit" role="status"><span>{summary}</span><button type="button" className="button button-quiet button-small" onClick={() => setSummary(null)}>Dismiss</button></div>;
}
