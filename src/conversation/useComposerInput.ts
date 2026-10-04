import { useEffect, useRef, type CompositionEvent, type KeyboardEvent, type RefObject } from "react";

/**
 * The one copy of the composer input layer (AGENTS.md §4): auto-grow, IME
 * composition guards and Enter-to-send. Every textarea that submits a message
 * uses this hook — the conversation composer and the new-goal draft composer
 * previously carried two verbatim copies.
 *
 * Behavior contract (unchanged from the two copies it replaces):
 * - Enter sends via the enclosing form's requestSubmit (so the browser fires
 *   a real submit event); Shift+Enter is left alone as an explicit newline.
 * - Enter while an IME composition is active never sends: `isComposing`, the
 *   legacy keyCode 229 and the stray Enter some IMEs emit within 30ms after
 *   compositionend are all ignored.
 * - Enter is always prevented (never a newline) once it is a send intent,
 *   even when sending is currently unavailable.
 * - The textarea auto-grows with its content up to 220px.
 * - The textarea takes focus on mount and whenever `focusKey` changes.
 */
export interface UseComposerInputOptions {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  /** Current value; drives auto-grow. */
  value: string;
  /** Receives the textarea value when an IME composition commits. */
  onCompositionChange: (value: string) => void;
  /** Gate checked when Enter is pressed; a blocked Enter is still prevented. */
  canSubmit: boolean;
  /**
   * Focus on mount and whenever this changes (the conversation composer
   * passes the goal id: a new goal takes focus, snapshot polls do not).
   * Omit for mount-only focus (the draft composer).
   */
  focusKey?: string;
}

export interface ComposerInputHandlers {
  onCompositionStart: () => void;
  onCompositionEnd: (event: CompositionEvent<HTMLTextAreaElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
}

export function useComposerInput({
  textareaRef,
  value,
  onCompositionChange,
  canSubmit,
  focusKey
}: UseComposerInputOptions): ComposerInputHandlers {
  // IME composition guards. `composing` covers the active composition; the
  // timestamp catches the stray Enter some IMEs emit right after
  // compositionend with isComposing already false.
  const composingRef = useRef(false);
  const compositionEndedAtRef = useRef(0);

  // Auto-grow: keep the textarea matched to its content within a sane maximum.
  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 220)}px`;
  }, [value, textareaRef]);

  // The composer is the primary input of the app: it takes focus when it
  // appears or (for the conversation composer) a different goal is selected.
  // Snapshot refresh keeps focusKey unchanged, so it cannot steal focus from
  // a field the user chose.
  useEffect(() => {
    textareaRef.current?.focus();
  }, [focusKey, textareaRef]);

  const handleCompositionStart = () => { composingRef.current = true; };
  const handleCompositionEnd = (event: CompositionEvent<HTMLTextAreaElement>) => {
    composingRef.current = false;
    compositionEndedAtRef.current = Date.now();
    onCompositionChange(event.currentTarget.value);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter") return;
    // 229 is the keyCode IMEs use while composing; isComposing covers modern
    // browsers. An Enter within 30ms after compositionend is the Korean-IME
    // stray commit — never a send.
    const stray = Date.now() - compositionEndedAtRef.current < 30;
    if (composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229 || stray) {
      return;
    }
    if (event.shiftKey) return; // explicit newline
    event.preventDefault();
    if (!canSubmit) return;
    const form = textareaRef.current?.form;
    if (!form) return;
    if (typeof form.requestSubmit === "function") {
      form.requestSubmit();
    } else {
      form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    }
  };

  return {
    onCompositionStart: handleCompositionStart,
    onCompositionEnd: handleCompositionEnd,
    onKeyDown: handleKeyDown
  };
}
