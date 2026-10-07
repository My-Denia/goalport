// The user types a goal and sends, and should see which harness is planning, which is checking, the result, and why it stopped, without picking a runtime or writing a handoff.
export type CoordinationQuotaWord = "unknown" | "available" | "exhausted";

export interface CoordinationStatusProps {
  planningHarness: string | null;
  reviewHarness: string | null;
  result: string | null;
  stopReason: string;
  planningQuota: CoordinationQuotaWord | null;
  reviewQuota: CoordinationQuotaWord | null;
}

function fact(value: string | null): string {
  const text = value?.trim() ?? "";
  return text.length > 0 ? text : "None";
}

export function CoordinationStatus({
  planningHarness,
  reviewHarness,
  result,
  stopReason,
  planningQuota,
  reviewQuota,
}: CoordinationStatusProps) {
  return (
    <section className="coordination-status" aria-label="Plan and check">
      <p>You sent a goal without picking a runtime. Below are the planning harness, the review harness, the quota, the result, and why this stopped.</p>
      <dl>
        <dt>Planning harness</dt>
        <dd>{fact(planningHarness)}</dd>
        <dt>Planning quota</dt>
        <dd>{fact(planningQuota)}</dd>
        <dt>Review harness</dt>
        <dd>{fact(reviewHarness)}</dd>
        <dt>Review quota</dt>
        <dd>{fact(reviewQuota)}</dd>
        <dt>Result</dt>
        <dd>{fact(result)}</dd>
        <dt>Stop reason</dt>
        <dd>{fact(stopReason)}</dd>
      </dl>
    </section>
  );
}
