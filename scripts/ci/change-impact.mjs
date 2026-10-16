import { appendFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT_DOCS = new Set(["README.md", "AGENTS.md", "CONTRIBUTING.md", "SECURITY.md"]);
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${result.error?.message ?? result.stderr?.toString("utf8") ?? "unknown error"}`);
  }
  return result.stdout;
}

function hasCommit(cwd, sha) {
  try {
    git(cwd, ["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function isAncestor(cwd, base, head) {
  try {
    git(cwd, ["merge-base", "--is-ancestor", base, head]);
    return true;
  } catch {
    return false;
  }
}

// Git's NUL-delimited raw format keeps even unusual pathnames unambiguous.
// --no-renames means a rename is D + A, both of which force full CI.
export function docsOnlyRaw(raw) {
  if (!raw.length || raw.at(-1) !== 0) return false;
  const parts = raw.subarray(0, -1).toString("utf8").split("\0");
  if (parts.length % 2 !== 0) return false;
  for (let i = 0; i < parts.length; i += 2) {
    const entry = /^:([0-7]{6}) ([0-7]{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z][0-9]*)$/.exec(parts[i]);
    if (!entry || entry[1] !== "100644" || entry[2] !== "100644" || entry[3] !== "M" || !ROOT_DOCS.has(parts[i + 1])) {
      return false;
    }
  }
  return parts.length > 0;
}

function docsOnlyDiff(cwd, base, head) {
  try {
    return docsOnlyRaw(git(cwd, ["diff", "--raw", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", "--no-abbrev", base, head, "--"]));
  } catch {
    return false; // A missing or incomplete diff must never create a light result.
  }
}

export function classifyChange({ cwd, eventName, event, githubSha }) {
  const checkout = git(cwd, ["rev-parse", "HEAD"]).toString("utf8").trim();
  if (!SHA.test(githubSha ?? "")) return { full: true, reason: "unknown event checkout SHA" };
  if (checkout !== githubSha) throw new Error("checkout HEAD does not match GITHUB_SHA");

  if (eventName === "pull_request") {
    const base = event.pull_request?.base?.sha;
    const head = event.pull_request?.head?.sha;
    if (!SHA.test(base ?? "") || !SHA.test(head ?? "")) return { full: true, reason: "unknown PR base or head SHA" };
    const parents = git(cwd, ["rev-list", "--parents", "-n", "1", "HEAD"]).toString("utf8").trim().split(" ");
    if (parents.length !== 3 || parents[0] !== checkout || parents[1] !== base || parents[2] !== head) {
      return { full: true, reason: "checkout is not the merge commit for the event base/head" };
    }
    if (!hasCommit(cwd, base) || !hasCommit(cwd, head)) return { full: true, reason: "PR base or head is unavailable" };
    const light = docsOnlyDiff(cwd, base, head) && docsOnlyDiff(cwd, base, checkout);
    return { full: !light, reason: light ? "root documentation content only" : "code, metadata, empty, or unknown PR diff" };
  }

  if (eventName === "push") {
    const base = event.before;
    const head = event.after;
    if (!SHA.test(base ?? "") || !SHA.test(head ?? "") || /^0+$/.test(base)) {
      return { full: true, reason: "unknown push base or head SHA" };
    }
    if (head !== checkout) throw new Error("checkout HEAD does not match push event after SHA");
    if (!hasCommit(cwd, base) || !hasCommit(cwd, head)) return { full: true, reason: "push base or head is unavailable" };
    if (!isAncestor(cwd, base, head)) return { full: true, reason: "push base is not an ancestor of head" };
    const light = docsOnlyDiff(cwd, base, checkout);
    return { full: !light, reason: light ? "root documentation content only" : "code, metadata, empty, or unknown push diff" };
  }

  return { full: true, reason: "unrecognized event" };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const result = classifyChange({
    cwd: process.cwd(),
    eventName: process.env.GITHUB_EVENT_NAME,
    event,
    githubSha: process.env.GITHUB_SHA,
  });
  appendFileSync(process.env.GITHUB_OUTPUT, `full=${result.full}\n`);
  console.log(`CI impact: ${result.full ? "full" : "light"} (${result.reason})`);
}
