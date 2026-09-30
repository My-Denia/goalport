import { fireEvent } from "@testing-library/react";

/** Select requires a pointer press that begins on the option, as a real click does. */
export function clickRuntimeOption(option: HTMLElement) {
  fireEvent.pointerDown(option, { pointerType: "mouse", button: 0 });
  fireEvent.pointerUp(option, { pointerType: "mouse", button: 0 });
  fireEvent.click(option, { button: 0, detail: 1 });
}
