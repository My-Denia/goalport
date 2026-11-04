"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createWorkflowStore, carryWorkflows, ipcResult, FILE, UNREADABLE_NOTICE } = require("./workflow-store.cjs");

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gp-workflows-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "profile");
  const backupsDirectory = path.join(directory, "backups");
  fs.mkdirSync(directory, { recursive: true });
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + (tick++) * 1000);
  return { root, directory, backupsDirectory, store: createWorkflowStore({ directory, backupsDirectory, now }) };
}
const checks = (planReview = "off", readWorkspace = "preferred") => ({ checks: { planReview, reviewerNeeds: { readWorkspace } } });
const file = (s) => path.join(s.directory, FILE);

test("a missing file is an empty list with no notice", (t) => {
  assert.deepEqual(sandbox(t).store.read(), { workflows: [], notice: null });
});

test("a corrupt file is set aside with a plain notice and never throws", (t) => {
  const s = sandbox(t);
  fs.writeFileSync(file(s), "{ not json");
  const result = s.store.read();
  assert.deepEqual(result.workflows, []);
  assert.equal(result.notice, UNREADABLE_NOTICE);
  assert.equal(fs.existsSync(file(s)), false);
  assert.equal(fs.readdirSync(s.directory).filter((n) => n.startsWith("workflows.json.unreadable-")).length, 1);
  assert.deepEqual(s.store.read(), { workflows: [], notice: null });
});

test("a wrong-shaped file is set aside too", (t) => {
  const s = sandbox(t);
  fs.writeFileSync(file(s), JSON.stringify({ schema: 2, workflows: [] }));
  assert.equal(s.store.read().notice, UNREADABLE_NOTICE);
});

test("an invalid entry is dropped, the valid ones stay, and the notice says so", (t) => {
  const s = sandbox(t);
  const good = s.store.save({ name: "Quick plan", modules: checks() }).saved;
  const text = JSON.parse(fs.readFileSync(file(s), "utf8"));
  text.workflows.push({ schema: 1, id: "my-badbad00", version: 1, name: "Broken", modules: { checks: { planReview: "maybe" } } });
  text.workflows.push({ ...good, id: "recommended" });
  fs.writeFileSync(file(s), JSON.stringify(text));
  const result = s.store.read();
  assert.deepEqual(result.workflows.map((w) => w.id), [good.id]);
  assert.match(result.notice, /left out/);
  assert.equal(fs.existsSync(file(s)), true, "a file with some valid entries is not set aside");
});

test("saving a new workflow assigns my-xxxxxxxx, version 1 and the Recommended parent", (t) => {
  const s = sandbox(t);
  const { saved, workflows } = s.store.save({ name: "  Quick plan  ", parent: "recommended@9", id: undefined, modules: checks("off", "required") });
  assert.match(saved.id, /^my-[0-9a-f]{8}$/);
  assert.equal(saved.version, 1);
  assert.equal(saved.parent, "recommended@1");
  assert.equal(saved.name, "Quick plan");
  assert.equal(saved.modules.checks.planReview, "off");
  assert.equal(saved.modules.checks.reviewerNeeds.readWorkspace, "required");
  assert.equal(saved.modules.checks.requirementCitation, "quote-when-reviewer-cannot-read");
  assert.deepEqual(workflows, [saved]);
  assert.deepEqual(createWorkflowStore({ directory: s.directory }).read().workflows, [saved], "survives a restart");
});

test("saving a user-supplied requirementCitation or extra modules is ignored", (t) => {
  const s = sandbox(t);
  const { saved } = s.store.save({ name: "A", modules: { checks: { planReview: "on", reviewerNeeds: { readWorkspace: "preferred" }, requirementCitation: "path" }, other: { x: 1 } } });
  assert.equal(saved.modules.checks.requirementCitation, "quote-when-reviewer-cannot-read");
  assert.deepEqual(Object.keys(saved.modules), ["checks"]);
});

test("saving again bumps the version and keeps id and parent", (t) => {
  const s = sandbox(t);
  const first = s.store.save({ name: "Quick plan", modules: checks("off") }).saved;
  const second = s.store.save({ id: first.id, name: "Quick plan v2", modules: checks("on", "required") }).saved;
  assert.equal(second.id, first.id);
  assert.equal(second.version, 2);
  assert.equal(second.parent, first.parent);
  assert.equal(s.store.read().workflows.length, 1);
});

test("duplicate names, the Recommended name, the recommended id and bad input are refused with one sentence", (t) => {
  const s = sandbox(t);
  const first = s.store.save({ name: "Quick plan", modules: checks() }).saved;
  assert.throws(() => s.store.save({ name: "quick PLAN", modules: checks() }), /already have a workflow with that name/);
  assert.throws(() => s.store.save({ name: "Recommended workflow", modules: checks() }), /Recommended workflow/);
  assert.throws(() => s.store.save({ id: "recommended", name: "X", modules: checks() }), /cannot be changed/);
  assert.throws(() => s.store.save({ id: "my-00000000", name: "X", modules: checks() }), /no longer saved/);
  assert.throws(() => s.store.save({ name: "", modules: checks() }), /name/);
  assert.throws(() => s.store.save({ name: "x".repeat(61), modules: checks() }), /60/);
  assert.throws(() => s.store.save({ name: "Bad", modules: checks("maybe") }), /not valid/);
  assert.throws(() => s.store.save({ name: "Bad", modules: {} }), /not valid/);
  // Renaming a workflow to its own name is not a duplicate.
  assert.equal(s.store.save({ id: first.id, name: "Quick plan", modules: checks("on") }).saved.version, 2);
  assert.equal(s.store.read().workflows.length, 1);
});

test("ipcResult turns a refusal into { error } with the plain sentence", (t) => {
  const s = sandbox(t);
  assert.deepEqual(ipcResult(() => s.store.save({ name: "", modules: checks() })), { error: "Give this workflow a name." });
  assert.deepEqual(ipcResult(() => { throw new TypeError("boom"); }), { error: "Your workflows could not be read or saved." });
});

test("delete removes one workflow and ignores an unknown id", (t) => {
  const s = sandbox(t);
  const a = s.store.save({ name: "A", modules: checks() }).saved;
  const b = s.store.save({ name: "B", modules: checks() }).saved;
  assert.deepEqual(s.store.delete(a.id).workflows.map((w) => w.id), [b.id]);
  assert.deepEqual(s.store.delete("my-ffffffff").workflows.map((w) => w.id), [b.id]);
  assert.deepEqual(s.store.read().workflows.map((w) => w.id), [b.id]);
});

test("the write is atomic: no temporary file is left and a failed rename leaves the old file whole", (t) => {
  const s = sandbox(t);
  s.store.save({ name: "A", modules: checks() });
  assert.deepEqual(fs.readdirSync(s.directory).filter((n) => n.endsWith(".tmp")), []);
  const before = fs.readFileSync(file(s), "utf8");
  const failing = createWorkflowStore({
    directory: s.directory,
    fsApi: { ...fs, renameSync: () => { throw new Error("disk says no"); } },
  });
  assert.throws(() => failing.save({ name: "B", modules: checks() }), /could not be saved/);
  assert.equal(fs.readFileSync(file(s), "utf8"), before);
  assert.deepEqual(fs.readdirSync(s.directory).filter((n) => n.endsWith(".tmp")), []);
});

test("each save writes a backup copy; backups are pruned to 10 and never touch the sqlite backups", (t) => {
  const s = sandbox(t);
  fs.mkdirSync(s.backupsDirectory, { recursive: true });
  const sqlite = "goalport-2026-01-01T00-00-00-000Z.sqlite";
  fs.writeFileSync(path.join(s.backupsDirectory, sqlite), "database backup");
  fs.writeFileSync(path.join(s.backupsDirectory, "notes.json"), "keep");
  for (let n = 0; n < 13; n += 1) s.store.save({ name: `Workflow ${n}`, modules: checks() });
  const names = fs.readdirSync(s.backupsDirectory);
  const copies = names.filter((name) => /^workflows-.*\.json$/.test(name)).sort();
  assert.equal(copies.length, 10);
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.backupsDirectory, copies.at(-1)), "utf8")).workflows.length, 13, "newest copy is the latest save");
  assert.equal(fs.readFileSync(path.join(s.backupsDirectory, sqlite), "utf8"), "database backup");
  assert.equal(fs.readFileSync(path.join(s.backupsDirectory, "notes.json"), "utf8"), "keep");
});

test("a backup problem never fails the save", (t) => {
  const s = sandbox(t);
  fs.mkdirSync(s.backupsDirectory, { recursive: true });
  const store = createWorkflowStore({ directory: s.directory, backupsDirectory: s.backupsDirectory, fsApi: { ...fs, readdirSync: () => { throw new Error("no listing"); } } });
  assert.equal(store.save({ name: "A", modules: checks() }).saved.version, 1);
});

test("carryWorkflows copies a valid source file only when the target has none", (t) => {
  const s = sandbox(t);
  const source = path.join(s.root, "source");
  fs.mkdirSync(source);
  const other = createWorkflowStore({ directory: source });
  const saved = other.save({ name: "From before", modules: checks() }).saved;
  assert.equal(carryWorkflows(source, s.directory), true);
  assert.deepEqual(s.store.read().workflows, [saved]);
  assert.equal(carryWorkflows(source, s.directory), false, "idempotent: nothing to carry the second time");
  other.save({ name: "Another", modules: checks() });
  assert.equal(carryWorkflows(source, s.directory), false, "an existing target file is never replaced");
  assert.deepEqual(s.store.read().workflows, [saved]);
});

test("carryWorkflows skips an invalid source and never throws", (t) => {
  const s = sandbox(t);
  const source = path.join(s.root, "source");
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, FILE), "{ nope");
  assert.equal(carryWorkflows(source, s.directory), false);
  assert.equal(carryWorkflows(path.join(s.root, "missing"), s.directory), false);
  assert.equal(carryWorkflows(undefined, s.directory), false);
  assert.equal(fs.existsSync(file(s)), false);
});

function busyFs(real) {
  let locked = false;
  const api = Object.create(real);
  api.readFileSync = (target, ...rest) => {
    if (locked && String(target).endsWith(FILE)) throw Object.assign(new Error("resource busy or locked"), { code: "EBUSY" });
    return real.readFileSync(target, ...rest);
  };
  return { api, lock: () => { locked = true; }, unlock: () => { locked = false; } };
}

test("a file that cannot be read right now is left byte-identical by save and by delete", (t) => {
  const s = sandbox(t);
  const busy = busyFs(fs);
  const store = createWorkflowStore({ directory: s.directory, backupsDirectory: s.backupsDirectory, fsApi: busy.api });
  const kept = store.save({ name: "Keep me", modules: checks() }).saved;
  const before = fs.readFileSync(file(s));
  busy.lock();

  const listed = store.read();
  assert.deepEqual(listed.workflows, []);
  assert.equal(listed.notice, "Your saved workflows could not be read right now.");
  assert.doesNotMatch(listed.notice, /set aside/);

  const refusal = /could not be read right now, so nothing was changed\. Try again\./;
  assert.match(ipcResult(() => store.save({ name: "Another", modules: checks() })).error, refusal);
  assert.equal(Buffer.compare(fs.readFileSync(file(s)), before), 0, "save left the file untouched");

  assert.match(ipcResult(() => store.delete(kept.id)).error, refusal);
  assert.equal(Buffer.compare(fs.readFileSync(file(s)), before), 0, "delete left the file untouched");
  assert.deepEqual(fs.readdirSync(s.directory).filter((n) => n.includes("unreadable") || n.endsWith(".tmp")), []);

  busy.unlock();
  assert.deepEqual(store.read().workflows.map((w) => w.id), [kept.id]);
});

test("saving keeps the resources module, keeps it when an edit leaves it out, and carries it into a new profile", (t) => {
  const s = sandbox(t);
  const resources = { roles: { plan: "faster", review: "stronger", execute: "default", audit: "default" }, budget: { readTurns: 6, writeTurns: 2 } };
  const first = s.store.save({ name: "Fast plan", modules: { ...checks("on"), resources } });
  assert.deepEqual(first.saved.modules.resources, resources);
  const edited = s.store.save({ id: first.saved.id, name: "Fast plan", modules: checks("on") });
  assert.deepEqual(edited.saved.modules.resources, resources);
  const changed = { ...resources, roles: { ...resources.roles, plan: "default" } };
  assert.deepEqual(s.store.save({ id: first.saved.id, name: "Fast plan", modules: { ...checks("on"), resources: changed } }).saved.modules.resources, changed);
  assert.throws(() => s.store.save({ name: "Bad", modules: { ...checks("on"), resources: { ...resources, roles: { ...resources.roles, plan: "turbo" } } } }), { message: "Those workflow settings are not valid, so nothing was saved." });
  assert.equal("resources" in s.store.save({ name: "Plain", modules: checks("on") }).saved.modules, false);
  const target = path.join(s.root, "other");
  assert.equal(carryWorkflows(s.directory, target), true);
  assert.deepEqual(createWorkflowStore({ directory: target, backupsDirectory: path.join(target, "backups") }).read().workflows.find((w) => w.id === first.saved.id).modules.resources, changed);
});

test("saving keeps the feedback module, keeps it when an edit leaves it out, and refuses a bad one", (t) => {
  const s = sandbox(t);
  const feedback = { planRevision: "ask", repair: "automatic" };
  const first = s.store.save({ name: "Ask first", modules: { ...checks("on"), feedback } });
  assert.deepEqual(first.saved.modules.feedback, feedback);
  const edited = s.store.save({ id: first.saved.id, name: "Ask first", modules: checks("off") });
  assert.deepEqual(edited.saved.modules.feedback, feedback);
  const changed = { planRevision: "automatic", repair: "ask" };
  assert.deepEqual(s.store.save({ id: first.saved.id, name: "Ask first", modules: { ...checks("on"), feedback: changed } }).saved.modules.feedback, changed);
  assert.throws(() => s.store.save({ name: "Bad", modules: { ...checks("on"), feedback: { planRevision: "ask" } } }), { message: "Those workflow settings are not valid, so nothing was saved." });
  assert.equal("feedback" in s.store.save({ name: "Plain", modules: checks("on") }).saved.modules, false);
});
