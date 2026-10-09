const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readHealth, markBlocked, clearBlocked } = require("./harness-health.cjs");

function tempState() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "goalport-harness-health-"));
}

function cleanup(directory) {
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

test("a mark survives a read with its evidence stamp and the pinned format", () => {
  const directory = tempState();
  try {
    markBlocked(directory, "codex", "Failed to create unified exec process: helper_unknown_error", "coordinate-plan-codex", () => "2026-10-09T15:55:46.000Z");
    assert.deepEqual(readHealth(directory), {
      codex: {
        blockedAt: "2026-10-09T15:55:46.000Z",
        detail: "Failed to create unified exec process: helper_unknown_error",
        commandId: "coordinate-plan-codex",
      },
    });
    const stored = JSON.parse(fs.readFileSync(path.join(directory, "harness-health.json"), "utf8"));
    assert.equal(stored.version, 1);
    assert.deepEqual(Object.keys(stored.instances), ["codex"]);
  } finally {
    cleanup(directory);
  }
});

test("a clear removes only its target instance", () => {
  const directory = tempState();
  try {
    markBlocked(directory, "codex", "sandbox failed", "coordinate-plan-codex");
    markBlocked(directory, "claude", "sandbox failed", "coordinate-review-claude");
    clearBlocked(directory, "codex");
    const health = readHealth(directory);
    assert.equal(health.codex, undefined);
    assert.equal(health.claude.commandId, "coordinate-review-claude");
  } finally {
    cleanup(directory);
  }
});

test("damaged JSON reads as an empty health map", () => {
  const directory = tempState();
  try {
    fs.writeFileSync(path.join(directory, "harness-health.json"), "{ this is not json");
    assert.deepEqual(readHealth(directory), {});
    fs.writeFileSync(path.join(directory, "harness-health.json"), JSON.stringify(["not", "an", "object"]));
    assert.deepEqual(readHealth(directory), {});
  } finally {
    cleanup(directory);
  }
});

test("bad entries are dropped while good ones survive", () => {
  const directory = tempState();
  try {
    fs.writeFileSync(path.join(directory, "harness-health.json"), JSON.stringify({
      version: 1,
      instances: {
        codex: { blockedAt: "2026-10-09T10:00:00.000Z", detail: "sandbox failed", commandId: "coordinate-plan-codex" },
        claude: { detail: "missing the timestamp" },
        ghost: "not an object",
        empty: null,
      },
    }));
    const health = readHealth(directory);
    assert.deepEqual(Object.keys(health), ["codex"]);
    assert.equal(health.codex.detail, "sandbox failed");
    fs.writeFileSync(path.join(directory, "harness-health.json"), JSON.stringify({ version: 1, instances: "garbage" }));
    assert.deepEqual(readHealth(directory), {});
  } finally {
    cleanup(directory);
  }
});

test("clearing an absent instance or file is a no-op", () => {
  const directory = tempState();
  try {
    assert.doesNotThrow(() => clearBlocked(directory, "ghost"));
    assert.deepEqual(readHealth(directory), {});
    assert.equal(fs.existsSync(path.join(directory, "harness-health.json")), false);
    const missing = path.join(directory, "no-such-state-dir");
    assert.doesNotThrow(() => clearBlocked(missing, "codex"));
    assert.equal(fs.existsSync(missing), false);
  } finally {
    cleanup(directory);
  }
});

test("a write failure never reaches the caller and keeps the stored records", () => {
  const directory = tempState();
  try {
    markBlocked(directory, "codex", "sandbox failed", "coordinate-plan-codex");
    // Occupy the atomic tmp path so the next write dies mid-flight.
    fs.mkdirSync(path.join(directory, `.harness-health.${process.pid}.tmp`));
    assert.doesNotThrow(() => markBlocked(directory, "claude", "sandbox failed too", "coordinate-review-claude"));
    assert.doesNotThrow(() => clearBlocked(directory, "codex"));
    const health = readHealth(directory);
    assert.equal(health.codex.detail, "sandbox failed");
    assert.equal(health.claude, undefined);
    // A state dir that is really a file fails the same way, quietly.
    const filePath = path.join(directory, "occupied");
    fs.writeFileSync(filePath, "not a directory");
    assert.doesNotThrow(() => markBlocked(filePath, "codex", "sandbox failed"));
    assert.doesNotThrow(() => clearBlocked(filePath, "codex"));
  } finally {
    cleanup(directory);
  }
});

test("the stored detail is bounded to 300 characters", () => {
  const directory = tempState();
  try {
    markBlocked(directory, "codex", "x".repeat(5000), "coordinate-plan-codex");
    assert.equal(readHealth(directory).codex.detail.length, 300);
  } finally {
    cleanup(directory);
  }
});
