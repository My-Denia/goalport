import { useEffect, useState } from "react";

/** "0:24" since `active` turned on; empty while off. A real count, never an estimate. */
export function useElapsed(active: boolean): string {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    setSeconds(0);
    if (!active) return undefined;
    const timer = window.setInterval(() => setSeconds((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return active ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : "";
}
