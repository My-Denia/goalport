// Compiled by the existing tsconfig.app.json include, never executed.
import type { BackgroundStatus } from "./backgroundStatus";
import type { SavedAllowanceView, SavedCurrentBase, SavedTargetPayload } from "./savedTargetView";
import { acknowledgedCurrentJob } from "./allowanceStatus";
import { matchingAcknowledgedLiveReady } from "./liveRead";
export function nominalReadBoundary(saved: SavedAllowanceView, base: SavedCurrentBase) {
  // @ts-expect-error A saved label lacks the host-status members and cannot carry liveRead/counters.
  const job: BackgroundStatus = saved;
  // @ts-expect-error Saved labels cannot enter the single acknowledged-host converter.
  acknowledgedCurrentJob(saved);
  // @ts-expect-error A saved label cannot enter the host-ACK matcher either.
  matchingAcknowledgedLiveReady(saved, null);
  // @ts-expect-error Descriptive base observations cannot enter the host-ACK matcher.
  matchingAcknowledgedLiveReady(base, null);
  // @ts-expect-error Passive payload has no BackgroundStatus field.
  const payload: SavedTargetPayload = { allowanceJob: job };
  // @ts-expect-error Saved label cannot carry worker ACK.
  const fabricated: SavedAllowanceView = { ...saved, liveRead: { ready: true } };
  return { payload, fabricated };
}
