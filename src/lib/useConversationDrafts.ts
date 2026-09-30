import { useState } from "react";
import type { SendIntent } from "./sendIntent";

/** Unsent text and its request identity belong to a goal, not to a snapshot. */
export function useConversationDrafts() {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [intents, setIntents] = useState<Record<string, SendIntent>>({});

  function update(campaignId: string, value: string) {
    if (!campaignId) return;
    setDrafts((current) => ({ ...current, [campaignId]: value }));
    setIntents((current) => {
      const intent = current[campaignId];
      if (!intent || intent.message === value.trim()) return current;
      const next = { ...current };
      delete next[campaignId];
      return next;
    });
  }

  return { drafts, setDrafts, intents, setIntents, update };
}
