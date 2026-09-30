import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { mergeSnapshotHistory, previewInitialSnapshot, type CoreClient } from "../ipc";
import { EMPTY_SNAPSHOT, type CoreSnapshot } from "../types";

/** Core refresh owns only the projected snapshot. Local input is never reset by a poll. */
export function useCoreSnapshot(client: CoreClient, coreReady: boolean): [CoreSnapshot, Dispatch<SetStateAction<CoreSnapshot>>, boolean] {
  const [snapshot, setSnapshot] = useState<CoreSnapshot>(() => client.mode === "browser-preview" ? previewInitialSnapshot() : EMPTY_SNAPSHOT);
  const [booted, setBooted] = useState(() => client.mode === "browser-preview");

  useEffect(() => {
    if (!coreReady) return undefined;
    let mounted = true;
    let autoStartAttempted = false;
    const refresh = async (allowStart: boolean) => {
      const next = await client.snapshot();
      if (!mounted) return;
      setSnapshot((current) => current.loadedHistory ? mergeSnapshotHistory(current, next) : next);
      setBooted(true);
      if (allowStart && !autoStartAttempted && next.connection !== "connected" && client.mode !== "browser-preview") {
        autoStartAttempted = true;
        const started = await client.startCore();
        if (mounted) setSnapshot(started);
      }
    };
    void refresh(true);
    const timer = window.setInterval(() => { if (mounted) void refresh(false); }, 750);
    return () => { mounted = false; window.clearInterval(timer); };
  }, [client, coreReady]);

  return [snapshot, setSnapshot, booted];
}
