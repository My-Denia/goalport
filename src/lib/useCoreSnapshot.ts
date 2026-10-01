import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { mergeSnapshotHistory, previewInitialSnapshot, type CoreClient } from "../ipc";
import { EMPTY_SNAPSHOT, type CoreSnapshot } from "../types";

/**
 * One refresh owner for this page. A poll that started before the user got
 * an authoritative snapshot cannot paint over it, and a slow poll does not
 * pile up behind itself.
 */
export function useCoreSnapshot(client: CoreClient, coreReady: boolean): [CoreSnapshot, Dispatch<SetStateAction<CoreSnapshot>>, boolean] {
  const [snapshot, setSnapshotState] = useState<CoreSnapshot>(() => client.mode === "browser-preview" ? previewInitialSnapshot() : EMPTY_SNAPSHOT);
  const [booted, setBooted] = useState(() => client.mode === "browser-preview");
  const epoch = useRef(0);
  const setSnapshot = useCallback((action: SetStateAction<CoreSnapshot>) => {
    epoch.current += 1;
    setSnapshotState(action);
  }, []);

  useEffect(() => {
    if (!coreReady) return undefined;
    let mounted = true;
    let flight = false;
    let again = false;
    let autoStartAttempted = false;
    const refresh = async (allowStart: boolean) => {
      if (flight) {
        again = true;
        return;
      }
      flight = true;
      try {
        do {
          again = false;
          const token = epoch.current;
          const next = await client.snapshot();
          if (!mounted) return;
          if (token !== epoch.current) {
            again = true;
            continue;
          }
          setSnapshotState((current) => current.loadedHistory ? mergeSnapshotHistory(current, next) : next);
          setBooted(true);
          if (allowStart && !autoStartAttempted && next.connection !== "connected" && client.mode !== "browser-preview") {
            autoStartAttempted = true;
            const started = await client.startCore();
            if (mounted && token === epoch.current) setSnapshotState(started);
          }
        } while (mounted && again);
      } finally {
        flight = false;
      }
    };
    void refresh(true);
    const timer = window.setInterval(() => { if (mounted) void refresh(false); }, 750);
    return () => { mounted = false; window.clearInterval(timer); };
  }, [client, coreReady]);

  return [snapshot, setSnapshot, booted];
}
