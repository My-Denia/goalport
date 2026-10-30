/** One sentence from a workbench CLI reply. Never the whole status dump. */
export function coordinationReplyLine(body: { error?: unknown; payload?: { stdout?: unknown; stderr?: unknown } } | null, fallback: string): string {
  if (typeof body?.error === "string" && body.error.trim()) return body.error.trim();
  const stdout = typeof body?.payload?.stdout === "string" ? body.payload.stdout : "";
  const lines = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  const unconfirmed = lines.find((line) => line.includes("exit remains unconfirmed") || line.includes("exit is unconfirmed") || line.includes("exit is not confirmed"));
  if (unconfirmed) return unconfirmed;
  const isRevoked = lines.some((line) => line === "revoked: true");
  if (isRevoked) {
    const hasPending = lines.some((line) => line.startsWith("pending command:") && !line.includes("none"));
    if (hasPending) {
      return "Access stopped; the current turn may finish, but no further turn was sent.";
    }
    const hasStoppedOutcome = lines.some((line) => line.startsWith("outcome: stopped"));
    if (hasStoppedOutcome) {
      return "Stopped. No further turn was sent. Existing workspace edits remain.";
    }
    return "Access stopped; no further turn was sent.";
  }
  const activity = lines.find((line) => line.startsWith("activity: "));
  if (activity) return activity.slice("activity: ".length);
  const stoppedOutcome = lines.find((line) => line === "outcome: stopped");
  if (stoppedOutcome) {
    return "Stopped. No further turn was sent. Existing workspace edits remain.";
  }
  const stderr = typeof body?.payload?.stderr === "string" ? body.payload.stderr.trim() : "";
  if (stderr) return stderr.split("\n")[0].trim();
  return fallback;
}

export function harnessDisplayName(id: string): string {
  if (id === "codex") return "Codex";
  if (id === "pi") return "Pi";
  if (id === "claude") return "Claude";
  return id;
}

export function signedInLine(ids: readonly string[]): string | null {
  if (ids.length < 2) return null;
  return `Signed in: ${ids.map(harnessDisplayName).join(", ")}.`;
}

export function coordinationStartAdmitted(body: { error?: unknown; payload?: { stdout?: unknown } } | null): boolean {
  if (typeof body?.error === "string" && body.error.trim()) return false;
  const stdout = typeof body?.payload?.stdout === "string" ? body.payload.stdout : "";
  return stdout.includes("The goal was admitted");
}
