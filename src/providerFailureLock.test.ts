import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { normalizeTurnReasonCode, PROVIDER_FAILURE_CODES, type ProductTurn } from "./types";

type Expect<T extends true> = T;
type ReasonField = NonNullable<ProductTurn["reasonCode"]>;
type _ReasonCodeExtendsString = Expect<[ReasonField] extends [string] ? true : false>;
type _StringDoesNotExtendReasonCode = Expect<[string] extends [ReasonField] ? false : true>;

// Locks the frontend union to the Rust enum's closed set. The Rust side is
// the source of truth (crates/goalport-core/src/provider_failure.rs,
// ALL_PROVIDER_FAILURE_CODES); this test parses that list so drift on either
// side fails here instead of shipping a code the other side cannot render.
describe("provider failure code lock", () => {
  it("frontend union equals the Rust ALL_PROVIDER_FAILURE_CODES set", () => {
    const rust = readFileSync(
      resolve(__dirname, "../crates/goalport-core/src/provider_failure.rs"),
      "utf8",
    );
    const matches = [...rust.matchAll(/\("([a-z-]+)",\s*ProviderFailure::\w+\)/g)];
    expect(matches.length).toBeGreaterThan(0);
    const rustCodes = matches.map((match) => match[1]);
    expect([...PROVIDER_FAILURE_CODES].sort()).toEqual([...rustCodes].sort());
  });

  it("keeps turn-state codes and degrades unknown provider strings", () => {
    expect(normalizeTurnReasonCode("provider-quota")).toBe("provider-quota");
    expect(normalizeTurnReasonCode("provider-exited")).toBe("provider-exited");
    expect(normalizeTurnReasonCode("session-closed")).toBe("session-closed");
    expect(normalizeTurnReasonCode("start-cancelling")).toBe("start-cancelling");
    expect(normalizeTurnReasonCode("provider-mystery")).toBe("provider-failed");
    expect(normalizeTurnReasonCode("")).toBeUndefined();
    expect(normalizeTurnReasonCode(12)).toBeUndefined();
  });
});
