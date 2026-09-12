// Kept self-contained so the same guard runs inside the real renderer.
export function clickPointFor(element) {
  if (!element) throw new Error("click target is missing");
  if (element.disabled || element.getAttribute?.("aria-disabled") === "true") throw new Error("click target is disabled");
  const document = element.ownerDocument;
  const view = document.defaultView;
  const rect = element.getBoundingClientRect();
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) {
    throw new Error("click target has no visible area");
  }
  const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  if (point.x < 0 || point.y < 0 || point.x >= view.innerWidth || point.y >= view.innerHeight) {
    throw new Error("click target center is outside the viewport");
  }
  const hit = document.elementFromPoint(point.x, point.y);
  if (!hit || (hit !== element && !element.contains(hit))) throw new Error("click target is hidden or occluded");
  return point;
}
