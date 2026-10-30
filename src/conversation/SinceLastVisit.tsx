import { useEffect, useRef, useState } from "react";
import type { ProductConversation, TurnResult } from "../types";

const KEY = "goalport.lastSeenTurn";

const ENDING: Record<TurnResult["replyState"], string> = {
  completed: "finished",
  failed: "ran into a problem",
  cancelled: "was stopped",
  uncertain: "may not have finished"
};

function readSeen(): Record<string, string> {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function rememberSeen(seen: Record<string, string>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(seen));
  } catch {
    // The next visit simply shows no summary.
  }
}

/** One line on coming back: the answers are below; this says what happened while away. */
export function SinceLastVisit({ campaignId, product, results }: { campaignId: string; product: ProductConversation; results: TurnResult[] | undefined }) {
  const last = results?.at(-1);
  const lastTurn = last?.requestId ?? "";
  const working = product.turn.canStop;
  const [summary, setSummary] = useState<string | null>(null);
  const visit = useRef<string | null>(null);
  useEffect(() => {
    // A turn that ends in front of the user is not news; only arriving is.
    const arrived = visit.current !== campaignId;
    visit.current = campaignId;
    const seen = readSeen();
    const before = seen[campaignId];
    if (arrived) {
      if (last && before !== undefined && before !== lastTurn && !working) {
        const count = last.during.length + last.unattributed.length;
        setSummary(`${product.runtime.name || "The agent"} ${ENDING[last.replyState]} while you were away${count > 0 ? ` · ${count} ${count === 1 ? "file" : "files"} changed` : ""}.`);
      } else {
        setSummary(null);
      }
    } else if (working) {
      setSummary(null);
    }
    rememberSeen({ ...seen, [campaignId]: lastTurn });
    // A new goal on screen is a visit; the rest only keeps the record current.
  }, [campaignId, working, lastTurn]);
  if (!summary) return null;
  return <div className="since-last-visit" role="status"><span>{summary}</span><button type="button" className="button button-quiet button-small" onClick={() => setSummary(null)}>Dismiss</button></div>;
}
