import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { argsFor } from "./package.mjs";
import { verifyPackage } from "./verify-package.mjs";

try {
  const args = argsFor(process.argv.slice(2), ["--package", "--data-dir", "--test-profile"]);
  if (args.help) {
    console.log("Usage: pnpm electron:start --package <GoalPort-win32-x64-directory> [--data-dir <absolute-directory> | --test-profile <absolute-directory>]\nNormal data: %APPDATA%/GoalPort/rc. Test profiles allow in-process Scenario only.\nThe complete package can also be moved anywhere and GoalPort.exe started directly.");
  } else {
    if (!args["--package"]) throw new Error("--package is required");
    if (args["--data-dir"] && args["--test-profile"]) throw new Error("Choose normal data or a synthetic test profile");
    const packageRoot = resolve(args["--package"]);
    const identity = verifyPackage(packageRoot);
    const flags = ["--data-dir", "--test-profile"].flatMap((name) => args[name] ? [name, args[name]] : []);
    const child = spawn(resolve(packageRoot, "GoalPort.exe"), flags, { cwd: packageRoot, detached: true, stdio: "ignore" });
    child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
    child.unref();
    console.log(`Launching GoalPort ${identity.version} (pid ${child.pid}).`);
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
