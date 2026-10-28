"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

const {
  captureWorkspaceBaseline,
  captureWorkspaceEvidence,
  truncateUtf8,
  parsePorcelainUntracked,
  inspectUntrackedFile,
  collectUntrackedSnapshots,
  DEFAULT_MAX_DIFF_BYTES,
  DEFAULT_MAX_UNTRACKED_FILE_BYTES,
} = require("./execution-workspace-evidence.cjs");

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "goalport-evidence-test-"));
}

function initGitRepo(dir) {
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, windowsHide: true });
  execFileSync("git", ["config", "user.name", "Test Agent"], { cwd: dir, windowsHide: true });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, windowsHide: true });
}

test("truncateUtf8 respects byte limits and multibyte characters", () => {
  const ascii = "hello world";
  assert.deepEqual(truncateUtf8(ascii, 5), { text: "hello", truncated: true });
  assert.deepEqual(truncateUtf8(ascii, 20), { text: "hello world", truncated: false });

  // 🎯 is 4 bytes: 0xf0 0x9f 0x8e 0xaf
  const emoji = "test🎯end";
  const truncated = truncateUtf8(emoji, 6);
  assert.equal(truncated.truncated, true);
  // Byte 4 is 't', byte 5 is first byte of 🎯, so it should cleanly cut before 🎯
  assert.equal(truncated.text, "test");
});

test("parsePorcelainUntracked parses NUL-framed paths without Git quotePath decoding", () => {
  const parsed = parsePorcelainUntracked([" M src/existing.js", "?? file1.txt", "?? sub/file2.txt", "?? 新增 file.txt", ""].join("\0"));
  assert.deepEqual(parsed, ["file1.txt", "sub/file2.txt", "新增 file.txt"]);

  const legacy = ["?? file1.txt", '?? "file with spaces.txt"', ""].join("\n");
  assert.deepEqual(parsePorcelainUntracked(legacy), ["file1.txt", "file with spaces.txt"]);
});

test("inspectUntrackedFile handles ordinary text, binary, outside targets and limits", () => {
  const dir = makeTempDir();
  try {
    // 1. Text file
    fs.writeFileSync(path.join(dir, "note.txt"), "hello world\n");
    const textSnapshot = inspectUntrackedFile(dir, "note.txt");
    assert.equal(textSnapshot.skipped, undefined);
    assert.equal(textSnapshot.binary, false);
    assert.equal(textSnapshot.content, "hello world\n");
    assert.equal(textSnapshot.truncated, false);

    // 2. Binary file (contains null byte)
    const binBuf = Buffer.from([0x68, 0x65, 0x00, 0x6c, 0x6f]);
    fs.writeFileSync(path.join(dir, "data.bin"), binBuf);
    const binSnapshot = inspectUntrackedFile(dir, "data.bin");
    assert.equal(binSnapshot.binary, true);
    assert.equal(binSnapshot.content, undefined);

    // 3. File exceeding byte cap
    const largeContent = "x".repeat(100);
    fs.writeFileSync(path.join(dir, "large.txt"), largeContent);
    const largeSnapshot = inspectUntrackedFile(dir, "large.txt", 50);
    assert.equal(largeSnapshot.truncated, true);
    assert.equal(largeSnapshot.content.length, 50);

    // 4. Outside target / path traversal
    const outsideSnapshot = inspectUntrackedFile(dir, "../outside.txt");
    assert.equal(outsideSnapshot.skipped, "outside-target");

    // 5. Symlink handling (no-follow, never read target)
    try {
      const targetFile = path.join(dir, "target.txt");
      fs.writeFileSync(targetFile, "secret target\n");
      const linkFile = path.join(dir, "symlink.txt");
      fs.symlinkSync(targetFile, linkFile);
      const linkSnapshot = inspectUntrackedFile(dir, "symlink.txt");
      assert.equal(linkSnapshot.skipped, "symlink");
      assert.equal(linkSnapshot.content, undefined);
    } catch (err) {
      // Unprivileged Windows environments may refuse symlink creation
      if (err.code !== "EPERM") throw err;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("non-Git directory returns status: unavailable, changed: null", async () => {
  const dir = makeTempDir();
  try {
    const baseline = await captureWorkspaceBaseline(dir);
    assert.equal(baseline.gitAvailable, false);
    assert.equal(baseline.status, "unavailable");
    assert.equal(baseline.changed, null);

    const evidence = await captureWorkspaceEvidence(dir, baseline);
    assert.equal(evidence.status, "unavailable");
    assert.equal(evidence.changed, null);
    assert.equal(evidence.complete, false);
    assert.match(evidence.reason, /not inside a Git repository/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Git repo with no HEAD commit returns status: unavailable, changed: null", async () => {
  const dir = makeTempDir();
  try {
    initGitRepo(dir);
    const baseline = await captureWorkspaceBaseline(dir);
    assert.equal(baseline.gitAvailable, true);
    assert.equal(baseline.status, "unavailable");
    assert.equal(baseline.changed, null);
    assert.match(baseline.reason, /no HEAD commit/i);

    const evidence = await captureWorkspaceEvidence(dir, baseline);
    assert.equal(evidence.status, "unavailable");
    assert.equal(evidence.changed, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("subdir workspace explicitly constrains collection; edits outside subdir are ignored", async () => {
  const dir = makeTempDir();
  try {
    initGitRepo(dir);
    // Initial commit
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "root.txt"), "root initial\n");
    fs.writeFileSync(path.join(dir, "src", "child.txt"), "child initial\n");
    execFileSync("git", ["add", "."], { cwd: dir, windowsHide: true });
    execFileSync("git", ["commit", "-m", "Initial commit"], { cwd: dir, windowsHide: true });

    const srcDir = path.join(dir, "src");

    // Capture baseline in the subdir
    const baseline = await captureWorkspaceBaseline(srcDir);
    assert.equal(baseline.status, "available");
    assert.equal(baseline.complete, true);
    assert.equal(baseline.beforeDiff, "");

    // Modify a file outside the subdir (in repo root)
    fs.writeFileSync(path.join(dir, "root.txt"), "root modified outside!\n");

    // Evidence captured in subdir must NOT observe the root change!
    const evidenceOutsideOnly = await captureWorkspaceEvidence(srcDir, baseline);
    assert.equal(evidenceOutsideOnly.status, "available");
    assert.equal(evidenceOutsideOnly.changed, false);
    assert.equal(evidenceOutsideOnly.afterDiff, "");
    assert.deepEqual(evidenceOutsideOnly.untrackedFiles, []);

    // Now modify a file INSIDE the subdir
    fs.writeFileSync(path.join(srcDir, "child.txt"), "child modified inside!\n");
    const evidenceInside = await captureWorkspaceEvidence(srcDir, baseline);
    assert.equal(evidenceInside.status, "available");
    assert.equal(evidenceInside.changed, true);
    assert.match(evidenceInside.afterDiff, /child modified inside!/);
    assert.doesNotMatch(evidenceInside.afterDiff, /root modified outside!/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pre-existing staged and unstaged edits are captured in beforeDiff, new edits reflected in afterDiff", async () => {
  const dir = makeTempDir();
  try {
    initGitRepo(dir);
    fs.writeFileSync(path.join(dir, "file1.txt"), "initial 1\n");
    fs.writeFileSync(path.join(dir, "file2.txt"), "initial 2\n");
    execFileSync("git", ["add", "."], { cwd: dir, windowsHide: true });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: dir, windowsHide: true });

    // Pre-existing staged edit
    fs.writeFileSync(path.join(dir, "file1.txt"), "pre-existing staged\n");
    execFileSync("git", ["add", "file1.txt"], { cwd: dir, windowsHide: true });

    // Pre-existing unstaged edit
    fs.writeFileSync(path.join(dir, "file2.txt"), "pre-existing unstaged\n");

    const baseline = await captureWorkspaceBaseline(dir);
    assert.equal(baseline.status, "available");
    assert.match(baseline.beforeDiff, /pre-existing staged/);
    assert.match(baseline.beforeDiff, /pre-existing unstaged/);

    // Turn adds a new file and changes file2
    fs.writeFileSync(path.join(dir, "file2.txt"), "turn edit on file2\n");
    fs.writeFileSync(path.join(dir, "newfile.txt"), "new file content\n");

    const evidence = await captureWorkspaceEvidence(dir, baseline);
    assert.equal(evidence.status, "available", JSON.stringify({ node: process.version, capture: evidence }));
    assert.equal(evidence.changed, true);
    assert.match(evidence.beforeDiff, /pre-existing unstaged/);
    assert.match(evidence.afterDiff, /turn edit on file2/);
    assert.equal(evidence.untrackedFiles.length, 1);
    assert.equal(evidence.untrackedFiles[0].path, "newfile.txt");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("baseline change (HEAD moved during execution) cannot produce changed: false", async () => {
  const dir = makeTempDir();
  try {
    initGitRepo(dir);
    fs.writeFileSync(path.join(dir, "file.txt"), "v1\n");
    execFileSync("git", ["add", "."], { cwd: dir, windowsHide: true });
    execFileSync("git", ["commit", "-m", "v1"], { cwd: dir, windowsHide: true });

    const baseline = await captureWorkspaceBaseline(dir);
    assert.equal(baseline.status, "available");

    // Commit changes behind the scenes (HEAD moves)
    fs.writeFileSync(path.join(dir, "file.txt"), "v2\n");
    execFileSync("git", ["commit", "-am", "v2"], { cwd: dir, windowsHide: true });

    const evidence = await captureWorkspaceEvidence(dir, baseline);
    assert.equal(evidence.status, "incomplete");
    assert.equal(evidence.complete, false);
    assert.equal(evidence.changed, null); // Cannot confirm unchanged!
    assert.match(evidence.reason, /HEAD moved/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("timed-out observation is marked with timedOutObservation: true and not quiescent", async () => {
  const dir = makeTempDir();
  try {
    initGitRepo(dir);
    fs.writeFileSync(path.join(dir, "file.txt"), "initial\n");
    execFileSync("git", ["add", "."], { cwd: dir, windowsHide: true });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: dir, windowsHide: true });

    const baseline = await captureWorkspaceBaseline(dir);
    fs.writeFileSync(path.join(dir, "file.txt"), "partial write before timeout\n");

    const evidence = await captureWorkspaceEvidence(dir, baseline, { timedOut: true });
    assert.equal(evidence.timedOutObservation, true);
    assert.equal(evidence.complete, false);
    assert.equal(evidence.changed, true);
    assert.match(evidence.reason, /timed out.*quiescent/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("diff truncation flags incomplete and does not claim changed: false if empty", async () => {
  const dir = makeTempDir();
  try {
    initGitRepo(dir);
    fs.writeFileSync(path.join(dir, "file.txt"), "initial\n");
    execFileSync("git", ["add", "."], { cwd: dir, windowsHide: true });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: dir, windowsHide: true });

    // Artificially tiny maxDiffBytes to force truncation
    const baseline = await captureWorkspaceBaseline(dir, { maxDiffBytes: 10 });
    fs.writeFileSync(path.join(dir, "file.txt"), "A very long line that exceeds ten bytes diff\n");

    const evidence = await captureWorkspaceEvidence(dir, baseline, { maxDiffBytes: 10 });
    assert.equal(evidence.truncated, true);
    assert.equal(evidence.status, "incomplete");
    assert.equal(evidence.complete, false);
    assert.equal(evidence.changed, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("subdirectory and Unicode untracked paths retain before/after text observations", async () => {
  const dir = makeTempDir();
  try {
    initGitRepo(dir);
    const workspace = path.join(dir, "src");
    fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(dir, "tracked.txt"), "initial\n");
    execFileSync("git", ["add", "."], { cwd: dir, windowsHide: true });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: dir, windowsHide: true });
    fs.writeFileSync(path.join(workspace, "新增 before.txt"), "BEFORE_UNTRACKED_TEXT");

    const baseline = await captureWorkspaceBaseline(workspace);
    assert.equal(baseline.status, "available", JSON.stringify({ node: process.version, capture: baseline }));
    assert.equal(baseline.untrackedFiles[0].path, "新增 before.txt");
    assert.equal(baseline.untrackedFiles[0].content, "BEFORE_UNTRACKED_TEXT");
    fs.writeFileSync(path.join(workspace, "新增 before.txt"), "AFTER_EXISTING_UNTRACKED_TEXT");
    fs.writeFileSync(path.join(workspace, "new.txt"), "NEW_SUBDIR_CONTENT");

    const evidence = await captureWorkspaceEvidence(workspace, baseline);
    assert.equal(evidence.status, "available");
    assert.equal(evidence.complete, true);
    assert.equal(evidence.changed, true);
    assert.deepEqual(evidence.beforeUntrackedFiles.map((file) => file.content), ["BEFORE_UNTRACKED_TEXT"]);
    const after = Object.fromEntries(evidence.untrackedFiles.map((file) => [file.path, file.content]));
    assert.deepEqual(after, { "new.txt": "NEW_SUBDIR_CONTENT", "新增 before.txt": "AFTER_EXISTING_UNTRACKED_TEXT" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an authorized workspace alias shares Git's canonical root without losing in-bound untracked files", async () => {
  const dir = makeTempDir();
  try {
    const real = path.join(dir, "real-repo");
    const alias = path.join(dir, "workspace-alias");
    fs.mkdirSync(real);
    initGitRepo(real);
    fs.writeFileSync(path.join(real, "tracked.txt"), "baseline\n");
    execFileSync("git", ["add", "."], { cwd: real, windowsHide: true });
    execFileSync("git", ["commit", "-m", "baseline"], { cwd: real, windowsHide: true });
    fs.symlinkSync(real, alias, process.platform === "win32" ? "junction" : "dir");
    fs.writeFileSync(path.join(alias, "新增.txt"), "IN_BOUND_ALIAS_CONTENT");
    const baseline = await captureWorkspaceBaseline(alias);
    assert.equal(baseline.status, "available", JSON.stringify(baseline));
    assert.equal(baseline.untrackedFiles[0].content, "IN_BOUND_ALIAS_CONTENT");
    fs.writeFileSync(path.join(alias, "新增.txt"), "UPDATED_ALIAS_CONTENT");
    const evidence = await captureWorkspaceEvidence(alias, baseline);
    assert.equal(evidence.complete, true, JSON.stringify(evidence));
    assert.equal(evidence.changed, true);
    assert.equal(evidence.untrackedFiles[0].content, "UPDATED_ALIAS_CONTENT");

    fs.mkdirSync(path.join(real, "src"));
    fs.writeFileSync(path.join(real, "outside.txt"), "OUTSIDE_SUBDIR_NOT_CAPTURED");
    fs.writeFileSync(path.join(real, "src", "child.txt"), "IN_BOUND_CHILD");
    const child = await captureWorkspaceBaseline(path.join(alias, "src"));
    assert.equal(child.complete, true, JSON.stringify(child));
    assert.deepEqual(child.untrackedFiles.map((file) => file.path), ["child.txt"]);
    assert.equal(child.untrackedFiles[0].content, "IN_BOUND_CHILD");
    assert.ok(!JSON.stringify(child).includes("OUTSIDE_SUBDIR_NOT_CAPTURED"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("status failures propagate incomplete/unknown instead of empty no-change evidence", async () => {
  const dir = makeTempDir();
  try {
    const gitExec = async (args) => {
      if (args.includes("status")) return { code: 1, stdout: "", stderr: "simulated status read failure" };
      if (args.includes("--is-inside-work-tree")) return { code: 0, stdout: "true\n", stderr: "" };
      if (args.includes("--show-toplevel")) return { code: 0, stdout: `${dir}\n`, stderr: "" };
      if (args.includes("diff")) return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: "abc\n", stderr: "" };
    };
    const baseline = await captureWorkspaceBaseline(dir, { gitExec });
    assert.equal(baseline.status, "incomplete");
    assert.equal(baseline.complete, false);
    const evidence = await captureWorkspaceEvidence(dir, baseline, { gitExec });
    assert.equal(evidence.status, "incomplete");
    assert.equal(evidence.complete, false);
    assert.equal(evidence.changed, null);
    assert.match(evidence.reason, /status failed.*untracked comparison is unknown/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("untracked open/read failures propagate incomplete/unknown rather than no change", async () => {
  const dir = makeTempDir();
  try {
    const gitExec = async (args) => {
      if (args.includes("status")) return { code: 0, stdout: "?? missing.txt\0", stderr: "" };
      if (args.includes("--is-inside-work-tree")) return { code: 0, stdout: "true\n", stderr: "" };
      if (args.includes("--show-toplevel")) return { code: 0, stdout: `${dir}\n`, stderr: "" };
      if (args.includes("diff")) return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: "abc\n", stderr: "" };
    };
    const baseline = await captureWorkspaceBaseline(dir, { gitExec });
    assert.equal(baseline.untrackedFiles[0].skipped, "read-error");
    assert.equal(baseline.complete, false);
    const evidence = await captureWorkspaceEvidence(dir, baseline, { gitExec });
    assert.equal(evidence.status, "incomplete");
    assert.equal(evidence.changed, null);
    assert.equal(evidence.complete, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("same-size binary modifications cannot certify unchanged bytes", async () => {
  const dir = makeTempDir();
  try {
    initGitRepo(dir);
    fs.writeFileSync(path.join(dir, "tracked.txt"), "initial\n");
    execFileSync("git", ["add", "."], { cwd: dir, windowsHide: true });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: dir, windowsHide: true });
    fs.writeFileSync(path.join(dir, "asset.bin"), Buffer.from([1, 0, 2]));
    const baseline = await captureWorkspaceBaseline(dir);
    assert.equal(baseline.complete, false);
    fs.writeFileSync(path.join(dir, "asset.bin"), Buffer.from([3, 0, 4]));
    const evidence = await captureWorkspaceEvidence(dir, baseline);
    assert.equal(evidence.status, "incomplete");
    assert.equal(evidence.complete, false);
    assert.equal(evidence.changed, null);
    assert.equal(evidence.untrackedFiles[0].binary, true, JSON.stringify({ node: process.version, capture: evidence }));
    fs.writeFileSync(path.join(dir, "new-text.txt"), "observable new text");
    const withNewText = await captureWorkspaceEvidence(dir, baseline);
    assert.equal(withNewText.changed, true);
    assert.equal(withNewText.complete, false);
    assert.equal(withNewText.untrackedFiles.find((file) => file.path === "new-text.txt").content, "observable new text");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("untracked file-list output stays bounded and omitted coverage is explicit", () => {
  const dir = makeTempDir();
  try {
    for (const name of ["a.txt", "b.txt", "c.txt", "d.txt"]) fs.writeFileSync(path.join(dir, name), name);
    const collected = collectUntrackedSnapshots(dir, ["a.txt", "b.txt", "c.txt", "d.txt"], 2);
    assert.equal(collected.snapshots.length, 2);
    assert.equal(collected.omitted, 2);
    assert.equal(collected.incomplete, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("opened-object no-follow rejects the reviewer lstat/open replacement race", { skip: process.platform === "win32" }, () => {
  const parent = makeTempDir();
  const workspace = path.join(parent, "workspace");
  fs.mkdirSync(workspace);
  try {
    const outside = path.join(parent, "outside.txt");
    const leaf = path.join(workspace, "untracked.txt");
    fs.writeFileSync(outside, "OUTSIDE_NOFOLLOW_TOKEN");
    fs.writeFileSync(leaf, "inside");
    const originalOpen = fs.openSync;
    let swapped = false;
    fs.openSync = function (file, ...args) {
      if (file === leaf && !swapped) {
        swapped = true;
        fs.unlinkSync(leaf);
        fs.symlinkSync(outside, leaf);
      }
      return originalOpen.call(fs, file, ...args);
    };
    try {
      const snapshot = inspectUntrackedFile(workspace, "untracked.txt");
      assert.equal(swapped, true);
      assert.ok(snapshot.skipped);
      assert.equal(snapshot.content, undefined);
      assert.notEqual(snapshot.content, "OUTSIDE_NOFOLLOW_TOKEN");
    } finally {
      fs.openSync = originalOpen;
    }
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("descriptor identity mismatch skips before any content read", () => {
  const dir = makeTempDir();
  try {
    const leaf = path.join(dir, "ordinary.txt");
    fs.writeFileSync(leaf, "must not be read after identity swap");
    const originalFstat = fs.fstatSync;
    const originalRead = fs.readSync;
    let reads = 0;
    fs.fstatSync = function (fd, ...args) {
      const stat = originalFstat.call(fs, fd, ...args);
      return { ...stat, dev: stat.dev + 1, isFile: () => stat.isFile() };
    };
    fs.readSync = function (...args) {
      reads += 1;
      return originalRead.apply(fs, args);
    };
    try {
      const snapshot = inspectUntrackedFile(dir, "ordinary.txt");
      assert.equal(snapshot.skipped, "changed-during-read");
      assert.equal(snapshot.content, undefined);
      assert.equal(reads, 0);
    } finally {
      fs.fstatSync = originalFstat;
      fs.readSync = originalRead;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an intermediate directory link is skipped instead of reading through it", { skip: process.platform === "win32" }, () => {
  const parent = makeTempDir();
  const workspace = path.join(parent, "workspace");
  const outside = path.join(parent, "outside");
  fs.mkdirSync(workspace);
  fs.mkdirSync(outside);
  try {
    fs.writeFileSync(path.join(outside, "leaf.txt"), "OUTSIDE_INTERMEDIATE_TOKEN");
    fs.symlinkSync(outside, path.join(workspace, "linked"), "dir");
    const snapshot = inspectUntrackedFile(workspace, "linked/leaf.txt");
    assert.equal(snapshot.skipped, "symlink-in-path");
    assert.equal(snapshot.content, undefined);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
