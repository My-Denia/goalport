// Repository-owned build entry. Historical verification scripts keep their own
// isolated helpers; ordinary packaging has no dependency on those run assets.
import { main } from "../desktop/package.mjs";

main().catch((error) => {
  console.error(`GoalPort packaging failed: ${error.message}`);
  process.exitCode = 1;
});
