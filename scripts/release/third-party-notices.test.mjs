import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { generate, OUTPUT_PATH } from "./generate-third-party-notices.mjs";

test("release/THIRD_PARTY_NOTICES.txt matches the live dependency graph", () => {
  const committed = readFileSync(OUTPUT_PATH, "utf8");
  const fresh = generate();
  assert.equal(committed, fresh, "Dependencies changed since THIRD_PARTY_NOTICES.txt was last generated. Run `pnpm release:third-party-notices` and commit the result.");
});
