"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");

const DEFAULT_MAX_DIFF_BYTES = 64 * 1024; // 64 KiB
const DEFAULT_MAX_UNTRACKED_FILES = 32;
const DEFAULT_MAX_UNTRACKED_FILE_BYTES = 8 * 1024; // 8 KiB
const DEFAULT_MAX_GIT_OUTPUT_BYTES = 4 * 1024 * 1024;
const OBSERVATION_LABEL =
  "Workspace before/after this round (observation; may include preexisting or concurrent edits, no exclusive writer attribution)";

function defaultGitExec(args, cwd, maxBuffer = DEFAULT_MAX_GIT_OUTPUT_BYTES) {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, maxBuffer, windowsHide: true }, (error, stdout, stderr) => {
      resolve({
        code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
        stdout: String(stdout || ""),
        stderr: String(stderr || ""),
        error: error || null,
      });
    });
  });
}

function truncateUtf8(text, maxBytes) {
  if (typeof text !== "string") return { text: "", truncated: false };
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return { text: buf.subarray(0, end).toString("utf8"), truncated: true };
}

// Production uses --porcelain=v1 -z: NUL framing leaves spaces, newlines and
// Unicode untouched and disables Git's C-style quotePath serialization.
// Newline parsing remains only as a small compatibility helper for old tests.
function parsePorcelainUntracked(stdout) {
  const source = String(stdout || "");
  const nulFramed = source.includes("\0");
  const entries = nulFramed ? source.split("\0") : source.split(/\r?\n/);
  const untracked = [];
  for (const entry of entries) {
    if (!entry.startsWith("?? ")) continue;
    let relPath = entry.slice(3);
    if (!nulFramed) {
      relPath = relPath.trimEnd();
      if (relPath.startsWith('"') && relPath.endsWith('"')) {
        try { relPath = JSON.parse(relPath); } catch { relPath = relPath.slice(1, -1); }
      }
    }
    if (relPath) untracked.push(relPath);
  }
  return untracked;
}

function outsideRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative.startsWith("..") || path.isAbsolute(relative);
}

function intermediateLinkSkip(workspacePath, relPath) {
  const relative = path.relative(workspacePath, path.resolve(workspacePath, relPath));
  const parts = relative.split(path.sep).filter(Boolean);
  let current = workspacePath;
  // The leaf is checked separately with lstat/O_NOFOLLOW. Every directory
  // below the authorized workspace must also be an actual directory, not a
  // symlink or junction that would redirect the bounded read elsewhere.
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) return "symlink-in-path";
      if (!stat.isDirectory()) return "special-file";
    } catch {
      return "read-error";
    }
  }
  return null;
}

function openedObjectSkip(before, opened) {
  if (!Number.isFinite(before.dev) || !Number.isFinite(before.ino) ||
      !Number.isFinite(opened.dev) || !Number.isFinite(opened.ino)) return "nofollow-unsupported";
  // Some filesystems expose zero rather than a useful identity. Without a
  // platform no-follow flag, zero cannot validate the opened object.
  const nofollow = typeof fs.constants.O_NOFOLLOW === "number";
  if (!nofollow && before.dev === 0 && before.ino === 0 && opened.dev === 0 && opened.ino === 0) return "nofollow-unsupported";
  return before.dev === opened.dev && before.ino === opened.ino ? null : "changed-during-read";
}

function inspectUntrackedFile(workspacePath, relPath, maxFileBytes = DEFAULT_MAX_UNTRACKED_FILE_BYTES) {
  const resolvedWorkspace = path.resolve(workspacePath);
  const fullPath = path.resolve(resolvedWorkspace, relPath);
  if (outsideRoot(resolvedWorkspace, fullPath)) return { path: relPath, skipped: "outside-target" };

  const intermediateSkip = intermediateLinkSkip(resolvedWorkspace, relPath);
  if (intermediateSkip) return { path: relPath, skipped: intermediateSkip };

  let stat;
  try { stat = fs.lstatSync(fullPath); } catch { return { path: relPath, skipped: "read-error" }; }
  if (stat.isSymbolicLink()) return { path: relPath, size: stat.size, skipped: "symlink" };
  if (!stat.isFile()) return { path: relPath, size: stat.size, skipped: "special-file" };

  const nofollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  const toRead = Math.min(stat.size, maxFileBytes);
  const buf = Buffer.alloc(toRead);
  let bytesRead = 0;
  let openedStat;
  let fd;
  try {
    // Linux/POSIX applies no-follow at open. Windows Node has no O_NOFOLLOW;
    // there the descriptor's dev/ino must match the ordinary in-bound object
    // lstat observed, otherwise nothing is read from the descriptor.
    fd = fs.openSync(fullPath, fs.constants.O_RDONLY | nofollow);
    openedStat = fs.fstatSync(fd);
    if (!openedStat.isFile()) return { path: relPath, size: openedStat.size, skipped: "special-file" };
    const identitySkip = openedObjectSkip(stat, openedStat);
    if (identitySkip) return { path: relPath, size: stat.size, skipped: identitySkip };
    bytesRead = fs.readSync(fd, buf, 0, toRead, 0);
  } catch {
    return { path: relPath, size: stat.size, skipped: "read-error" };
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* the capture is already bounded */ }
    }
  }

  let isBinary = false;
  for (let index = 0; index < bytesRead; index += 1) {
    if (buf[index] === 0) { isBinary = true; break; }
  }
  if (isBinary) return { path: relPath, size: openedStat.size, binary: true };

  return {
    path: relPath,
    size: openedStat.size,
    content: buf.subarray(0, bytesRead).toString("utf8"),
    binary: false,
    truncated: openedStat.size > maxFileBytes,
  };
}

function collectUntrackedSnapshots(
  workspacePath,
  fileList,
  maxFiles = DEFAULT_MAX_UNTRACKED_FILES,
  maxFileBytes = DEFAULT_MAX_UNTRACKED_FILE_BYTES,
  repoRoot = workspacePath,
) {
  const snapshots = [];
  const resolvedWorkspace = path.resolve(workspacePath);
  const resolvedRepo = path.resolve(repoRoot);
  const retained = Math.min(fileList.length, maxFiles);
  for (let index = 0; index < retained; index += 1) {
    const repoRelative = fileList[index];
    const fullPath = path.resolve(resolvedRepo, repoRelative);
    const relative = path.relative(resolvedWorkspace, fullPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      snapshots.push({ path: repoRelative, skipped: "outside-target" });
      continue;
    }
    const workspaceRelative = relative.split(path.sep).join("/");
    snapshots.push(inspectUntrackedFile(resolvedWorkspace, workspaceRelative, maxFileBytes));
  }
  const omitted = Math.max(0, fileList.length - retained);
  const truncated = snapshots.some((item) => item.truncated === true);
  const incomplete = omitted > 0 || truncated || snapshots.some((item) => item.skipped || item.binary === true);
  return { snapshots, truncated, incomplete, omitted };
}

function unavailableBaseline(reason, capturedAt, extra = {}) {
  return {
    gitAvailable: true,
    status: "unavailable",
    complete: false,
    changed: null,
    headCommit: null,
    beforeDiff: null,
    untrackedFiles: [],
    untrackedFilesOmitted: 0,
    reason,
    capturedAt,
    ...extra,
  };
}

async function readRepoRoot(git, workspacePath) {
  const result = await git(["-C", workspacePath, "rev-parse", "--show-toplevel"], workspacePath);
  if (result.code !== 0 || !result.stdout.trim()) return null;
  // Real Git returns an absolute path. Resolving also keeps injected failure
  // fixtures simple without weakening the subsequent workspace containment.
  return path.resolve(workspacePath, result.stdout.trim());
}

async function captureWorkspaceBaseline(workspacePath, options = {}) {
  const git = options.gitExec ?? defaultGitExec;
  const maxDiffBytes = options.maxDiffBytes ?? DEFAULT_MAX_DIFF_BYTES;
  const maxUntrackedFiles = options.maxUntrackedFiles ?? DEFAULT_MAX_UNTRACKED_FILES;
  const maxUntrackedFileBytes = options.maxUntrackedFileBytes ?? DEFAULT_MAX_UNTRACKED_FILE_BYTES;
  const capturedAt = new Date().toISOString();

  if (!workspacePath || typeof workspacePath !== "string") {
    return unavailableBaseline("No workspace path was provided.", capturedAt, { gitAvailable: false });
  }
  const inside = await git(["-C", workspacePath, "rev-parse", "--is-inside-work-tree"], workspacePath);
  if (inside.code !== 0 || inside.stdout.trim() !== "true") {
    return unavailableBaseline("The workspace is not inside a Git repository.", capturedAt, { gitAvailable: false });
  }
  const head = await git(["-C", workspacePath, "rev-parse", "HEAD"], workspacePath);
  if (head.code !== 0 || !head.stdout.trim()) {
    return unavailableBaseline("The Git repository has no HEAD commit.", capturedAt);
  }
  const headCommit = head.stdout.trim();
  const repoRoot = await readRepoRoot(git, workspacePath);
  if (!repoRoot) {
    return unavailableBaseline("The Git repository root could not be read before execution.", capturedAt, { headCommit });
  }
  const diffResult = await git(
    ["-C", workspacePath, "diff", "--no-ext-diff", "--no-textconv", "HEAD", "--", "."],
    workspacePath,
  );
  if (diffResult.code !== 0) {
    return unavailableBaseline(`Git diff failed before execution: ${diffResult.stderr.trim() || "unknown error"}`, capturedAt, { headCommit });
  }
  const { text: beforeDiff, truncated: diffTruncated } = truncateUtf8(diffResult.stdout, maxDiffBytes);

  const statusResult = await git(
    ["-C", workspacePath, "status", "--porcelain=v1", "-z", "-uall", "--", "."],
    workspacePath,
  );
  if (statusResult.code !== 0) {
    return {
      gitAvailable: true,
      status: "incomplete",
      complete: false,
      changed: null,
      headCommit,
      beforeDiff,
      untrackedFiles: [],
      untrackedFilesOmitted: 0,
      truncated: diffTruncated,
      reason: `Git status failed before execution: ${statusResult.stderr.trim() || "unknown error"}`,
      capturedAt,
    };
  }
  const untrackedList = parsePorcelainUntracked(statusResult.stdout);
  const collected = collectUntrackedSnapshots(workspacePath, untrackedList, maxUntrackedFiles, maxUntrackedFileBytes, repoRoot);
  const incomplete = diffTruncated || collected.incomplete;
  return {
    gitAvailable: true,
    status: incomplete ? "incomplete" : "available",
    complete: !incomplete,
    changed: null,
    headCommit,
    beforeDiff,
    untrackedFiles: collected.snapshots,
    untrackedFilesOmitted: collected.omitted,
    truncated: diffTruncated || collected.truncated,
    reason: incomplete ? "Before-execution workspace coverage is incomplete." : null,
    capturedAt,
  };
}

async function captureWorkspaceEvidence(workspacePath, baseline, options = {}) {
  const git = options.gitExec ?? defaultGitExec;
  const maxDiffBytes = options.maxDiffBytes ?? DEFAULT_MAX_DIFF_BYTES;
  const maxUntrackedFiles = options.maxUntrackedFiles ?? DEFAULT_MAX_UNTRACKED_FILES;
  const maxUntrackedFileBytes = options.maxUntrackedFileBytes ?? DEFAULT_MAX_UNTRACKED_FILE_BYTES;
  const timedOutObservation = options.timedOut === true;
  const spawnError = options.spawnError === true;
  const beforeUntrackedFiles = baseline?.untrackedFiles ?? [];
  const comparisonBaseline = baseline?.headCommit
    ? { headCommit: baseline.headCommit, capturedAt: baseline.capturedAt }
    : null;
  const incompleteResult = (reason, afterDiff = null, extra = {}) => ({
    status: "incomplete",
    complete: false,
    changed: null,
    beforeDiff: baseline?.beforeDiff ?? null,
    afterDiff,
    beforeUntrackedFiles,
    untrackedFiles: [],
    beforeUntrackedFilesOmitted: baseline?.untrackedFilesOmitted ?? 0,
    untrackedFilesOmitted: 0,
    comparisonBaseline,
    reason,
    timedOutObservation,
    truncated: baseline?.truncated === true,
    label: OBSERVATION_LABEL,
    ...extra,
  });

  if (!baseline || baseline.gitAvailable === false || baseline.status === "unavailable") {
    return {
      ...incompleteResult(baseline?.reason || "Workspace Git inspection unavailable."),
      status: "unavailable",
      timedOutObservation: undefined,
      truncated: undefined,
    };
  }

  const headAfter = await git(["-C", workspacePath, "rev-parse", "HEAD"], workspacePath);
  if (headAfter.code !== 0 || !headAfter.stdout.trim()) {
    return incompleteResult("HEAD commit could not be read after execution; changes cannot be confirmed.");
  }
  if (headAfter.stdout.trim() !== baseline.headCommit) {
    return incompleteResult("Comparison baseline changed during execution (HEAD moved); changes cannot be confirmed.");
  }
  const repoRoot = await readRepoRoot(git, workspacePath);
  if (!repoRoot) return incompleteResult("The Git repository root could not be read after execution; changes cannot be confirmed.");

  const diffResult = await git(
    ["-C", workspacePath, "diff", "--no-ext-diff", "--no-textconv", "HEAD", "--", "."],
    workspacePath,
  );
  if (diffResult.code !== 0) {
    return incompleteResult(`Git diff failed after execution: ${diffResult.stderr.trim() || "unknown error"}; changes cannot be confirmed.`);
  }
  const { text: afterDiff, truncated: diffTruncated } = truncateUtf8(diffResult.stdout, maxDiffBytes);

  const statusResult = await git(
    ["-C", workspacePath, "status", "--porcelain=v1", "-z", "-uall", "--", "."],
    workspacePath,
  );
  const statusFailed = statusResult.code !== 0;
  const untrackedList = statusFailed ? [] : parsePorcelainUntracked(statusResult.stdout);
  const collected = statusFailed
    ? { snapshots: [], truncated: false, incomplete: true, omitted: 0 }
    : collectUntrackedSnapshots(workspacePath, untrackedList, maxUntrackedFiles, maxUntrackedFileBytes, repoRoot);

  const incomplete = !baseline.complete || diffTruncated || collected.incomplete || statusFailed;
  const diffChanged = (afterDiff || "") !== (baseline.beforeDiff || "");
  // A failed before/after status read is unknown, not an empty snapshot that
  // can manufacture either a change or a no-change certification.
  const baselineStatusFailed = typeof baseline.reason === "string" && baseline.reason.startsWith("Git status failed");
  const untrackedChanged = !statusFailed && !baselineStatusFailed
    ? JSON.stringify(collected.snapshots) !== JSON.stringify(beforeUntrackedFiles)
    : false;
  const anyChangeObserved = diffChanged || untrackedChanged;
  let changed = anyChangeObserved ? true : incomplete ? null : false;
  let reason;
  if (statusFailed) reason = `Git status failed after execution: ${statusResult.stderr.trim() || "unknown error"}; untracked comparison is unknown.`;
  else if (incomplete) reason = anyChangeObserved
    ? "Changes observed; workspace evidence coverage is incomplete."
    : baseline.reason || "Evidence collection was incomplete; cannot confirm unchanged.";
  else reason = anyChangeObserved ? null : "No workspace changes observed between before and after snapshots.";
  if (timedOutObservation) {
    reason = `${reason ? `${reason} ` : ""}Workspace observation after execution timed out; process execution may not be quiescent.`;
  } else if (spawnError) {
    reason = `${reason ? `${reason} ` : ""}Workspace observation after spawn error; process did not start normally.`;
  }

  return {
    status: incomplete ? "incomplete" : "available",
    complete: !incomplete && !timedOutObservation && !spawnError,
    changed,
    beforeDiff: baseline.beforeDiff,
    afterDiff,
    beforeUntrackedFiles,
    untrackedFiles: collected.snapshots,
    beforeUntrackedFilesOmitted: baseline.untrackedFilesOmitted ?? 0,
    untrackedFilesOmitted: collected.omitted,
    comparisonBaseline,
    reason,
    timedOutObservation,
    truncated: baseline.truncated === true || diffTruncated || collected.truncated,
    label: OBSERVATION_LABEL,
  };
}

module.exports = {
  captureWorkspaceBaseline,
  captureWorkspaceEvidence,
  truncateUtf8,
  parsePorcelainUntracked,
  inspectUntrackedFile,
  collectUntrackedSnapshots,
  DEFAULT_MAX_DIFF_BYTES,
  DEFAULT_MAX_UNTRACKED_FILES,
  DEFAULT_MAX_UNTRACKED_FILE_BYTES,
  DEFAULT_MAX_GIT_OUTPUT_BYTES,
  OBSERVATION_LABEL,
};
