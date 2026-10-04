// @vitest-environment jsdom
// The one composer input layer (AGENTS.md §4): auto-grow, IME-safe Enter,
// Shift+Enter newline and focus keying. The conversation composer and the
// draft composer previously carried two verbatim copies of this logic; these
// tests pin the shared copy so both keep the exact contract.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRef, type ReactNode } from "react";
import { useComposerInput } from "./useComposerInput";

afterEach(cleanup);

function Harness({
  value,
  canSubmit = true,
  focusKey,
  onCompositionChange = vi.fn(),
  onSubmit
}: {
  value: string;
  canSubmit?: boolean;
  focusKey?: string;
  onCompositionChange?: (value: string) => void;
  onSubmit: () => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const input = useComposerInput({
    textareaRef,
    value,
    onCompositionChange,
    canSubmit,
    focusKey
  });
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <textarea ref={textareaRef} aria-label="Message composer" value={value} readOnly rows={2} {...input} />
    </form>
  );
}

function composer() {
  return screen.getByRole("textbox", { name: /message composer/i }) as HTMLTextAreaElement;
}

describe("useComposerInput submit rules", () => {
  it("Enter submits through the form's real submit path", async () => {
    const submitted = vi.fn();
    render(<Harness value="hello" onSubmit={submitted} />);
    fireEvent.keyDown(composer(), { key: "Enter" });
    await waitFor(() => expect(submitted).toHaveBeenCalledTimes(1));
  });

  it("Shift+Enter is an explicit newline, never a submit", () => {
    const submitted = vi.fn();
    render(<Harness value="hello" onSubmit={submitted} />);
    // fireEvent returns false when the event was default-prevented; a
    // Shift+Enter must reach the browser untouched so it inserts a newline.
    const untouched = fireEvent.keyDown(composer(), { key: "Enter", shiftKey: true });
    expect(untouched).toBe(true);
    expect(submitted).not.toHaveBeenCalled();
  });

  it("Enter while sending is unavailable is still prevented (never a newline)", () => {
    const submitted = vi.fn();
    render(<Harness value="hello" canSubmit={false} onSubmit={submitted} />);
    const untouched = fireEvent.keyDown(composer(), { key: "Enter" });
    expect(untouched).toBe(false);
    expect(submitted).not.toHaveBeenCalled();
  });
});

describe("useComposerInput IME guards", () => {
  it("Enter during an active composition never submits (isComposing and keyCode 229)", () => {
    const submitted = vi.fn();
    render(<Harness value="中文候选" onSubmit={submitted} />);
    const field = composer();
    fireEvent.compositionStart(field);
    fireEvent.keyDown(field, { key: "Enter", isComposing: true });
    fireEvent.keyDown(field, { key: "Enter", keyCode: 229 });
    expect(submitted).not.toHaveBeenCalled();
  });

  it("the stray Enter within 30ms after compositionend is swallowed", () => {
    const submitted = vi.fn();
    render(<Harness value="确定候选词" onSubmit={submitted} />);
    const field = composer();
    fireEvent.compositionStart(field);
    fireEvent.compositionEnd(field, { target: { value: "确定候选词" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(submitted).not.toHaveBeenCalled();
  });

  it("a committed composition reports its value through onCompositionChange", () => {
    const committed = vi.fn();
    render(<Harness value="" onCompositionChange={committed} onSubmit={vi.fn()} />);
    const field = composer();
    fireEvent.compositionStart(field);
    fireEvent.compositionEnd(field, { target: { value: "한국어" } });
    expect(committed).toHaveBeenCalledWith("한국어");
  });
});

describe("useComposerInput auto-grow and focus", () => {
  function mockScrollHeight(element: HTMLElement, height: number) {
    Object.defineProperty(element, "scrollHeight", { configurable: true, get: () => height });
  }

  it("grows with content up to its natural height", async () => {
    const { rerender } = render(<Harness value="short" onSubmit={vi.fn()} />);
    const field = composer();
    mockScrollHeight(field, 96);
    rerender(<Harness value="short but growing" onSubmit={vi.fn()} />);
    await waitFor(() => expect(field.style.height).toBe("96px"));
  });

  it("clamps to 220px however tall the content is", async () => {
    const { rerender } = render(<Harness value="one line" onSubmit={vi.fn()} />);
    const field = composer();
    mockScrollHeight(field, 900);
    rerender(<Harness value="one line\nand many more" onSubmit={vi.fn()} />);
    await waitFor(() => expect(field.style.height).toBe("220px"));
  });

  it("focuses on mount and again whenever focusKey changes", async () => {
    const { rerender } = render(<Harness value="x" focusKey="goal-a" onSubmit={vi.fn()} />);
    const field = composer();
    await waitFor(() => expect(document.activeElement).toBe(field));
    (screen.getByRole("textbox") as HTMLElement).blur();
    expect(document.activeElement).not.toBe(field);
    rerender(<Harness value="x" focusKey="goal-b" onSubmit={vi.fn()} />);
    await waitFor(() => expect(document.activeElement).toBe(field));
  });
});
