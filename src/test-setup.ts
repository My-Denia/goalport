// jsdom does not implement ResizeObserver. Base UI's Popover positioner
// (Floating UI autoUpdate) touches it even in tests where the popup never
// opens, which crashed the whole React tree. A no-op observer is sufficient:
// tests assert presence and interaction, never geometry.
if (typeof globalThis.ResizeObserver === "undefined") {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as Record<string, unknown>).ResizeObserver = ResizeObserverStub;
}
