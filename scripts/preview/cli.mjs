import readline from "node:readline";
import { startPreview } from "./harness.mjs";

const preview = await startPreview({ fixture: process.argv.includes("--demo") ? "demo" : "empty" });
console.log(JSON.stringify({ ready: true, url: preview.url, methods: ["preview_snapshot", "click", "evaluate", "screenshot", "viewport", "fill", "key", "navigate", "quit"] }));
const input = readline.createInterface({ input: process.stdin });
try {
for await (const line of input) {
  try {
    const request = JSON.parse(line);
    const result = request.method === "preview_snapshot" ? await preview.snapshot()
      : request.method === "click" ? await preview.click(request.selector)
      : request.method === "evaluate" ? await preview.evaluate(request.expression)
      : request.method === "screenshot" ? await preview.screenshot(request.path)
      : request.method === "viewport" ? await preview.viewport(request.width, request.height)
      : request.method === "fill" ? await preview.fill(request.selector, request.value)
      : request.method === "key" ? await preview.key(request.key, request.code)
      : request.method === "navigate" ? await preview.navigate(request.fixture)
      : request.method === "quit" ? "closing" : (() => { throw new Error("Unknown preview method"); })();
    console.log(JSON.stringify({ ok: true, result: result ?? null }));
    if (request.method === "quit") break;
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  }
}
} finally {
  input.close();
  process.stdin.pause();
  await preview.stop();
}
