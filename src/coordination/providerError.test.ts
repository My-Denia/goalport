import { describe, expect, it } from "vitest";
import { classifyProviderError, environmentSignature, providerErrorSentence, type ProviderErrorClass } from "./providerError";

describe("classifyProviderError", () => {
  it("keeps the closed-set classes from before", () => {
    expect(classifyProviderError("This model requires usage credits.")).toBe("usage_credits");
    expect(classifyProviderError("stream error: You are not logged in. Run codex login.")).toBe("authentication");
    expect(classifyProviderError("usage limit reached")).toBe("usage_limit");
    expect(classifyProviderError("anything else")).toBe("provider_error");
  });

  it("classifies proven sandbox-helper signatures as environment", () => {
    expect(classifyProviderError("Failed to create unified exec process: helper_unknown_error: setup refresh had errors")).toBe("environment");
    expect(classifyProviderError("codex_core::tools::router ERROR windows sandbox failed: helper_unknown_error")).toBe("environment");
    expect(classifyProviderError("sandbox failed before the tool ran")).toBe("environment");
  });

  it("keeps an unknown provider failure out of the specialty classes", () => {
    expect(classifyProviderError("the model server returned a 500")).toBe("provider_error");
    expect(classifyProviderError("")).toBe("provider_error");
  });

  it("covers every class in the sentence mapping", () => {
    const seen: ProviderErrorClass[] = [];
    for (const text of [
      "requires usage credits",
      "usage limit reached",
      "please log in",
      "helper_unknown_error",
      "a generic failure",
    ]) {
      seen.push(classifyProviderError(text));
      expect(typeof providerErrorSentence(text)).toBe("string");
    }
    expect(new Set(seen).size).toBe(5);
  });
});

describe("environmentSignature", () => {
  it("returns the first matched signature, each pattern on its own", () => {
    expect(environmentSignature("helper_unknown_error: setup refresh had errors")).toBe("helper_unknown_error");
    expect(environmentSignature("Failed to create unified exec process: helper_unknown_error")).toBe("helper_unknown_error");
    expect(environmentSignature("Failed to create unified exec process")).toBe("Failed to create unified exec process");
    expect(environmentSignature("windows sandbox failed")).toBe("sandbox failed");
  });

  it("returns null for ordinary tool failures", () => {
    expect(environmentSignature("grep: no matches found")).toBeNull();
    expect(environmentSignature("trusted Node process exited unexpectedly; kernel reset, rerun your request")).toBeNull();
    expect(environmentSignature("")).toBeNull();
  });
});

describe("providerErrorSentence for environment", () => {
  it("uses one fixed sentence for the machine failure", () => {
    expect(providerErrorSentence("helper_unknown_error: setup refresh had errors"))
      .toBe("This agent cannot run its tools on this machine, so this stopped.");
  });
});
