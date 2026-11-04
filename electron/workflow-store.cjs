"use strict";
// The user's saved workflows, kept in the profile as workflows.json. A saved
// workflow is data the engine can compile; it never grants anything. A damaged
// file must never stop the app from starting, so every read degrades to "no
// workflows" with one plain notice.
const fs = require("node:fs");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { RECOMMENDED_V1, RECOMMENDED_PARENT, MAX_WORKFLOW_NAME, compileWorkflow } = require("./workflow-checks.mjs");

const FILE = "workflows.json";
const SCHEMA = 1;
const KEEP_BACKUPS = 10;
const BACKUP_NAME = /^workflows-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(?:-\d+)?\.json$/;
const UNREADABLE_NOTICE = "Your saved workflows could not be read, so GoalPort set that file aside and started a fresh list.";
const BUSY_NOTICE = "Your saved workflows could not be read right now.";
const BUSY_REFUSAL = "Your saved workflows could not be read right now, so nothing was changed. Try again.";
const DROPPED_NOTICE = "Some saved workflows could not be read and were left out.";

class WorkflowError extends Error {}
const plain = (message) => new WorkflowError(message);

function validEntry(entry) {
  try {
    if (!entry || typeof entry !== "object" || entry.id === RECOMMENDED_V1.id) return false;
    compileWorkflow(entry);
    return true;
  } catch { return false; }
}

// Pure parse: { workflows, dropped } or null when the whole file is unusable.
function parseWorkflowsText(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || parsed.schema !== SCHEMA || !Array.isArray(parsed.workflows)) return null;
  const seen = new Set();
  const workflows = [];
  let dropped = 0;
  for (const entry of parsed.workflows) {
    if (!validEntry(entry) || seen.has(entry.id)) { dropped += 1; continue; }
    seen.add(entry.id);
    workflows.push(entry);
  }
  return { workflows, dropped };
}

function fsyncDirectory(fsApi, directory) {
  let descriptor;
  try { descriptor = fsApi.openSync(directory, "r"); fsApi.fsyncSync(descriptor); }
  catch { /* Directory fsync is unavailable on some filesystems; file fsync and rename remain authoritative. */ }
  finally { if (descriptor !== undefined) { try { fsApi.closeSync(descriptor); } catch { /* ignore */ } } }
}

function writeAtomic(fsApi, file, text) {
  const directory = path.dirname(file);
  fsApi.mkdirSync(directory, { recursive: true });
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  let descriptor;
  try {
    descriptor = fsApi.openSync(temporary, "wx");
    fsApi.writeFileSync(descriptor, text, "utf8");
    fsApi.fsyncSync(descriptor);
    fsApi.closeSync(descriptor);
    descriptor = undefined;
    fsApi.renameSync(temporary, file);
  } catch (error) {
    if (descriptor !== undefined) { try { fsApi.closeSync(descriptor); } catch { /* ignore */ } }
    try { fsApi.rmSync(temporary, { force: true }); } catch { /* ignore */ }
    throw error;
  }
  fsyncDirectory(fsApi, directory);
}

function stampOf(date) { return date.toISOString().replace(/[:.]/g, "-"); }
const fileText = (workflows) => `${JSON.stringify({ schema: SCHEMA, workflows }, null, 2)}\n`;

function createWorkflowStore({ directory, backupsDirectory, fsApi = fs, now = () => new Date(), idSuffix = () => randomBytes(4).toString("hex") } = {}) {
  if (typeof directory !== "string" || directory.length === 0) throw new Error("A workflow store needs a profile directory.");
  const file = path.join(directory, FILE);

  function setAside() {
    const target = `${file}.unreadable-${stampOf(now())}`;
    try { fsApi.renameSync(file, target); } catch { /* A file that cannot be moved is still ignored. */ }
  }

  // Never throws: { workflows, notice, busy }. busy means the file exists but could not be
  // read this time (antivirus lock, permissions); the file is left alone and writes must refuse.
  function read() {
    let text;
    try { text = fsApi.readFileSync(file, "utf8"); }
    catch (error) {
      if (error && error.code === "ENOENT") return { workflows: [], notice: null };
      return { workflows: [], notice: BUSY_NOTICE, busy: true };
    }
    const parsed = parseWorkflowsText(text);
    if (!parsed) { setAside(); return { workflows: [], notice: UNREADABLE_NOTICE }; }
    return { workflows: parsed.workflows, notice: parsed.dropped > 0 ? DROPPED_NOTICE : null };
  }

  // A rotated copy on every save. Best effort: a backup problem never fails the save.
  function backup(workflows) {
    if (typeof backupsDirectory !== "string" || backupsDirectory.length === 0) return;
    try {
      fsApi.mkdirSync(backupsDirectory, { recursive: true });
      const base = `workflows-${stampOf(now())}`;
      let name = `${base}.json`;
      for (let n = 1; fsApi.existsSync(path.join(backupsDirectory, name)); n += 1) name = `${base}-${n}.json`;
      writeAtomic(fsApi, path.join(backupsDirectory, name), fileText(workflows));
      const names = fsApi.readdirSync(backupsDirectory).filter((n) => BACKUP_NAME.test(n)).sort();
      for (const stale of names.slice(0, Math.max(0, names.length - KEEP_BACKUPS))) {
        try { fsApi.rmSync(path.join(backupsDirectory, stale), { force: true }); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }

  function persist(workflows) {
    writeAtomic(fsApi, file, fileText(workflows));
    backup(workflows);
  }

  function save(input) {
    if (!input || typeof input !== "object") throw plain("This workflow could not be saved.");
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (name.length === 0) throw plain("Give this workflow a name.");
    if (name.length > MAX_WORKFLOW_NAME) throw plain(`Use a name of ${MAX_WORKFLOW_NAME} characters or fewer.`);
    if (name.toLowerCase() === RECOMMENDED_V1.name.toLowerCase()) throw plain("That name belongs to the Recommended workflow. Choose another name.");
    if (input.id === RECOMMENDED_V1.id) throw plain("The Recommended workflow cannot be changed. Copy it to make your own.");
    const checks = input.modules?.checks;
    const current = read();
    if (current.busy) throw plain(BUSY_REFUSAL);
    const list = current.workflows;
    const hasId = input.id !== undefined && input.id !== null;
    const existing = hasId ? list.find((w) => w.id === input.id) ?? null : null;
    if (hasId && !existing) throw plain("That workflow is no longer saved.");
    if (list.some((w) => w.id !== existing?.id && w.name.trim().toLowerCase() === name.toLowerCase())) {
      throw plain("You already have a workflow with that name. Choose another name.");
    }
    let id = existing?.id;
    if (!id) {
      do { id = `my-${idSuffix()}`; } while (list.some((w) => w.id === id));
    }
    // Resources are optional. Sent by the editor they replace the saved ones;
    // left out they keep what an existing workflow already had, so an editor
    // that only knows the checks never erases a resource choice. compileWorkflow
    // below refuses anything that is not exactly the closed shape.
    const sentResources = input.modules?.resources;
    const resources = sentResources !== undefined ? JSON.parse(JSON.stringify(sentResources)) : existing?.modules?.resources;
    const definition = {
      schema: SCHEMA,
      id,
      version: existing ? existing.version + 1 : 1,
      name,
      parent: existing?.parent ?? RECOMMENDED_PARENT,
      modules: {
        checks: {
          planReview: checks?.planReview,
          reviewerNeeds: { readWorkspace: checks?.reviewerNeeds?.readWorkspace },
          // Not editable in v1: it follows the reviewer rule above.
          requirementCitation: RECOMMENDED_V1.modules.checks.requirementCitation,
        },
        ...(resources !== undefined ? { resources } : {}),
      },
    };
    try { compileWorkflow(definition); } catch { throw plain("Those workflow settings are not valid, so nothing was saved."); }
    const next = existing ? list.map((w) => (w.id === existing.id ? definition : w)) : [...list, definition];
    try { persist(next); } catch { throw plain("Your workflow could not be saved. Nothing was changed."); }
    return { workflows: next, notice: current.notice, saved: definition };
  }

  function remove(id) {
    const current = read();
    if (current.busy) throw plain(BUSY_REFUSAL);
    const next = current.workflows.filter((w) => w.id !== id);
    if (next.length === current.workflows.length) return { workflows: current.workflows, notice: current.notice };
    try { persist(next); } catch { throw plain("Your workflow could not be deleted. Nothing was changed."); }
    return { workflows: next, notice: current.notice };
  }

  return { read, save, delete: remove, file };
}

// Profile import: bring the source profile's workflows along when this profile
// has none. Never throws; an import must not fail over a convenience file.
function carryWorkflows(sourceDirectory, targetDirectory, fsApi = fs) {
  try {
    if (typeof sourceDirectory !== "string" || typeof targetDirectory !== "string") return false;
    const target = path.join(targetDirectory, FILE);
    if (fsApi.existsSync(target)) return false;
    let text;
    try { text = fsApi.readFileSync(path.join(sourceDirectory, FILE), "utf8"); } catch { return false; }
    const parsed = parseWorkflowsText(text);
    if (!parsed || parsed.workflows.length === 0) return false;
    writeAtomic(fsApi, target, fileText(parsed.workflows));
    return true;
  } catch { return false; }
}

// IPC bodies: errors become one plain sentence, never a thrown stack.
function ipcResult(run) {
  try { return run(); }
  catch (error) { return { error: error instanceof WorkflowError ? error.message : "Your workflows could not be read or saved." }; }
}

module.exports = { createWorkflowStore, carryWorkflows, ipcResult, parseWorkflowsText, FILE, BACKUP_NAME, KEEP_BACKUPS, UNREADABLE_NOTICE };
