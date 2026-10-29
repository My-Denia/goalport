import { describe, expect, it } from "vitest";
import {
  isValidContinuationDescriptor,
  normalizeContinuationDescriptor,
  validatedContinuationOf,
  MAX_CONTINUATION_CHARS,
  MAX_CONTINUATION_PROMPT_BYTES,
  type SavedTargetContinuation,
} from "./continuation";

describe("SavedTargetContinuation shape and validation", () => {
  const validDescriptor: SavedTargetContinuation = {
    parentRequestId: "parent-req-001",
    rootRequestId: "root-req-001",
    originalGoal: "Build a cross-platform coordination service.",
    followUp: "Add Windows and Linux support.",
  };

  it("recognizes a well-formed continuation descriptor", () => {
    expect(isValidContinuationDescriptor(validDescriptor)).toBe(true);
    const normalized = normalizeContinuationDescriptor(validDescriptor);
    expect(normalized).toEqual(validDescriptor);
  });

  it("handles empty followUp as valid", () => {
    const withEmpty = {
      ...validDescriptor,
      followUp: "",
    };
    expect(isValidContinuationDescriptor(withEmpty)).toBe(true);
    expect(normalizeContinuationDescriptor(withEmpty)?.followUp).toBe("");
  });

  it("trims whitespace on normalization", () => {
    const withWhitespace = {
      parentRequestId: "  parent-req-001  ",
      rootRequestId: "  root-req-001  ",
      originalGoal: "  Original goal with whitespace.  ",
      followUp: "  Follow-up with whitespace.  ",
    };
    expect(isValidContinuationDescriptor(withWhitespace)).toBe(true);
    expect(normalizeContinuationDescriptor(withWhitespace)).toEqual({
      parentRequestId: "parent-req-001",
      rootRequestId: "root-req-001",
      originalGoal: "Original goal with whitespace.",
      followUp: "Follow-up with whitespace.",
    });
  });

  it("supports Unicode, CJK, and emoji in originalGoal and followUp", () => {
    const cjkEmoji: SavedTargetContinuation = {
      parentRequestId: "req-cjk-01",
      rootRequestId: "req-root-01",
      originalGoal: "修复任务协调器：支持中文目标与表情 🎯🚀",
      followUp: "继续执行：验证日语・한국어・Emoji 🌟 支持",
    };
    expect(isValidContinuationDescriptor(cjkEmoji)).toBe(true);
    expect(normalizeContinuationDescriptor(cjkEmoji)).toEqual(cjkEmoji);
  });

  it("rejects extra descriptor fields rather than sanitizing them into valid origin", () => {
    expect(isValidContinuationDescriptor({ ...validDescriptor, unrelated: true })).toBe(false);
    expect(normalizeContinuationDescriptor({ ...validDescriptor, unrelated: true })).toBeNull();
    expect(validatedContinuationOf({ continuation: { ...validDescriptor, unrelated: true } })).toBeUndefined();
  });

  it("refuses non-object or array values", () => {
    expect(isValidContinuationDescriptor(null)).toBe(false);
    expect(isValidContinuationDescriptor(undefined)).toBe(false);
    expect(isValidContinuationDescriptor("string")).toBe(false);
    expect(isValidContinuationDescriptor(123)).toBe(false);
    expect(isValidContinuationDescriptor([])).toBe(false);
    expect(isValidContinuationDescriptor([validDescriptor])).toBe(false);
  });

  it("refuses missing or invalid request IDs", () => {
    expect(isValidContinuationDescriptor({ ...validDescriptor, parentRequestId: "" })).toBe(false);
    expect(isValidContinuationDescriptor({ ...validDescriptor, rootRequestId: "" })).toBe(false);
    expect(isValidContinuationDescriptor({ ...validDescriptor, parentRequestId: "bad id with spaces" })).toBe(false);
    expect(isValidContinuationDescriptor({ ...validDescriptor, rootRequestId: "bad/slash/id" })).toBe(false);
    expect(isValidContinuationDescriptor({ ...validDescriptor, parentRequestId: "a".repeat(257) })).toBe(false);
  });

  it("refuses empty or whitespace-only originalGoal", () => {
    expect(isValidContinuationDescriptor({ ...validDescriptor, originalGoal: "" })).toBe(false);
    expect(isValidContinuationDescriptor({ ...validDescriptor, originalGoal: "   " })).toBe(false);
    expect(isValidContinuationDescriptor({ ...validDescriptor, originalGoal: 42 as unknown as string })).toBe(false);
  });

  it("refuses non-string followUp", () => {
    expect(isValidContinuationDescriptor({ ...validDescriptor, followUp: null as unknown as string })).toBe(false);
    expect(isValidContinuationDescriptor({ ...validDescriptor, followUp: 123 as unknown as string })).toBe(false);
  });

  it("refuses when combined character count exceeds 100,000", () => {
    const atLimit: SavedTargetContinuation = {
      parentRequestId: "parent-1",
      rootRequestId: "root-1",
      originalGoal: "a".repeat(50_000),
      followUp: "b".repeat(50_000),
    };
    expect(isValidContinuationDescriptor(atLimit)).toBe(true);

    const overLimit: SavedTargetContinuation = {
      parentRequestId: "parent-1",
      rootRequestId: "root-1",
      originalGoal: "a".repeat(50_001),
      followUp: "b".repeat(50_000),
    };
    expect(isValidContinuationDescriptor(overLimit)).toBe(false);
    expect(normalizeContinuationDescriptor(overLimit)).toBeNull();
  });

  it("validatedContinuationOf safely projects from record or returns undefined", () => {
    expect(validatedContinuationOf(null)).toBeUndefined();
    expect(validatedContinuationOf({})).toBeUndefined();
    expect(validatedContinuationOf({ continuation: null })).toBeUndefined();
    expect(validatedContinuationOf({ continuation: "malformed" })).toBeUndefined();
    expect(validatedContinuationOf({ continuation: { bad: 1 } })).toBeUndefined();
    expect(validatedContinuationOf({ continuation: validDescriptor })).toEqual(validDescriptor);
  });
});
