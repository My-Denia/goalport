export type ProviderErrorClass =
  | "usage_credits"
  | "usage_limit"
  | "authentication"
  | "environment"
  | "provider_error";

/**
 * Signatures proven by the captured diagnostic turn
 * (goal-runs/goalport-pr26-blockers-codex-diag/evidence/diag/): the Windows
 * read-only sandbox helper fails to initialize, so every tool call dies in
 * the sandbox layer while the CLI still exits 0 with a text reply. The typed
 * JSONL-event flag from the CLI layer wins over this stderr fallback.
 */
const ENVIRONMENT_SIGNATURES: readonly RegExp[] = [
  /helper_unknown_error/i,
  /Failed to create unified exec process/i,
  /sandbox failed/i,
];

export function environmentSignature(text: string): string | null {
  for (const pattern of ENVIRONMENT_SIGNATURES) {
    const match = pattern.exec(text);
    if (match) return match[0];
  }
  return null;
}

export function classifyProviderError(text: string): ProviderErrorClass {
  if (/requires usage credits/i.test(text)) return "usage_credits";
  if (/authentication|not logged in|unauthorized|please log in|login required/i.test(text)) return "authentication";
  if (/usage limit reached|rate limit reached/i.test(text)) return "usage_limit";
  if (environmentSignature(text) !== null) return "environment";
  return "provider_error";
}

export function providerErrorSentence(text: string): string {
  const kind = classifyProviderError(text);
  switch (kind) {
    case "usage_credits":
      return "This model requires extra usage credits. It was not used.";
    case "usage_limit":
      return text.trim();
    case "authentication":
      return "This agent is not signed in.";
    case "environment":
      return "This agent cannot run its tools on this machine, so this stopped.";
    case "provider_error": {
      const trimmed = text.trim();
      return trimmed.length > 0 ? trimmed : "The agent stopped with a provider error.";
    }
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }
}
