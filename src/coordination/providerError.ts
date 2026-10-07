export type ProviderErrorClass = "usage_credits" | "usage_limit" | "authentication" | "provider_error";

export function classifyProviderError(text: string): ProviderErrorClass {
  if (/requires usage credits/i.test(text)) return "usage_credits";
  if (/authentication|not logged in|unauthorized|please log in|login required/i.test(text)) return "authentication";
  if (/usage limit reached|rate limit reached/i.test(text)) return "usage_limit";
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
      return "This harness is not signed in.";
    case "provider_error": {
      const trimmed = text.trim();
      return trimmed.length > 0 ? trimmed : "The harness stopped with a provider error.";
    }
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }
}
