// Side-effect-free close-window helper for smoke and regression testing.
// Discriminates between an in-flight close-induced transport disconnect and an abnormal failure.

export function isExpectedCloseTeardownError(error) {
  if (!error || typeof error !== "object") return false;
  // Must be dispatchMouseEvent with eventType === "mouseReleased",
  // request must have actually been sent, and failure must be due to
  // transport closure while in flight.
  return (
    error.method === "Input.dispatchMouseEvent" &&
    error.eventType === "mouseReleased" &&
    error.requestSent === true &&
    error.transportClosed === true &&
    !error.alreadyClosed &&
    !error.sendFailed &&
    !error.isTimeout
  );
}

export async function performCloseWindow({
  click,
  until,
  read,
  body,
  child,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutMs = 15000,
}) {
  await click("button[aria-label='Application menu']");
  await until("close window menu item", () =>
    read("Boolean(document.querySelector(\"div[role='menu'] button[aria-label='Close window']\"))")
  );

  await click("div[role='menu'] button[aria-label='Close window']", undefined, {
    allowCloseTeardown: true,
  });

  await sleep(150);

  // If child hasn't exited yet and we are still connected, check for background dialog
  if (child.exitCode === null) {
    const text = await body().catch(() => "");
    if (text.includes("Continue running in the background?")) {
      await click(".close-choice-dialog button", "Continue in background", {
        allowCloseTeardown: true,
      });
    }
  }

  // Enforce natural clean exit: exitCode === 0 and signalCode === null.
  // Whether release was acknowledged or lost to provisional teardown,
  // the child MUST exit cleanly with 0. Non-zero or hung child fails closed.
  await until(
    "Electron clean close",
    () => child.exitCode === 0 && child.signalCode === null,
    timeoutMs
  );
}
