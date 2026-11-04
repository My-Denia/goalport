# ADR-0002: Working modes — Direct, Recommended workflow, My workflow

> **Design record.** Written 2026-11-04 before implementation. The implemented
> state is tracked in the slice issues linked at the end; this file does not
> claim any slice is built.

Status: accepted direction (owner, 2026-11-04). Slices are proposed and land one PR at a time.

## Why

The owner's North Star for GoalPort is unchanged: ship the user's GAH design as
out-of-the-box multi-harness coordination that makes full use of subscriptions
and API quota. What changed is how that is offered.

Until now GoalPort had one built-in method: a fixed plan → review (→ execute →
audit) chain with one plan revision and one repair. The owner's current method,
kept in Agent Core (`goal-workflow`, the planner / executor-lead / worker /
scout / clerk / reviewer roles, tiered model routing, independent review that
blocks only on real breakage), has moved past that chain. A fixed chain also
cannot serve two other real users: the one who just wants their harness, and
the one who has their own way of working.

Owner's words (2026-11-04): make "how the work gets done" a capability users
can choose and customise. Agent Core / GAH supplies the recommended method the
owner maintains; GoalPort also holds direct harness use and the user's own
method. Many products accept a user's own config but never help them create it
inside the product; GoalPort must let them start creating it here.

Real problems this answers:

- #63: with Codex + Pi, no read-only result reaches "checked", so Live
  Continue never appears. Cause: a reviewer started with `--no-tools` is asked to
  confirm a contract file it cannot read. Pi's `--no-tools` was recorded at
  delivery (2026-10-12) as a known limit ("read-only subset later"), not a
  design choice. Reviewer capability belongs in a workflow setting.
- The plan/review prompts, revision counts, reviewer choice (`usable[1]`) and
  Live Continue's exact `["codex","pi"]` / `maxTurns === 4` match are all
  hard-coded, so nothing about the method can change without a code change.

## Decision

Three modes share one foundation: sessions, history, background runs,
permissions and result display. They differ only in who decides the method.

| Mode (UI name) | User intent | What GoalPort does |
|---|---|---|
| **Direct** (直接使用; internal: Inline) | "I picked my harness and subscription; let me work." | The native session path. No extra agents, no extra steps. Long tasks are fine. The harness's own skills, tools and native delegation stay the user's. |
| **Recommended workflow** (推荐工作流) | "Organise the work for me with your method." | Runs the owner-maintained workflow, shipped with the app as a read-only, versioned definition derived from Agent Core practice. |
| **My workflow** (我的工作流) | "I have my own preferences." | The user creates, edits, saves and uses definitions in the app. Main entry: copy Recommended and change what doesn't fit. Also: start from a base template. |

### Modules

A workflow definition is grouped by the decisions a user makes:

| Module | What the user decides |
|---|---|
| Planning | Start directly, plan only complex tasks, or plan and review first; how the plan cites the requirement it serves |
| Execution | One harness, or plan → execute → audit; who may write |
| Checks & review | Which checks run; independent review on or off; what the reviewer must be able to do (e.g. read the workspace) and who is preferred |
| Resources | Allowed harnesses / subscriptions; which roles prefer fast vs strong models; turn budget |
| Feedback & continuation | Repair vs replan vs stop on "revise"; how many rounds; what needs the user; continue remaining work |
| Delivery | The outcome wanted; how results are presented and saved |

Every option changes real execution. When a check is off, the result page says
it did not run. It never implies a check that did not happen.

### Rules

1. **A definition never grants anything.** Allowed harnesses, budgets and write
   choices only prefill the existing scope panel; authority still comes from
   `coordination-scope` and explicit write consent. This matches the
   continuation descriptor rule.
2. **Safety semantics are not modules.** No automatic replay (`commandKey`),
   write failure stops, unknown dispatch is UNKNOWN and is never resent, held is
   never shown as released, auditor ≠ executor when an audit runs, transport
   byte limits. A workflow cannot turn these off.
3. **One interpreter.** No second scheduler. A pure `compileWorkflow(definition,
   goal)` produces the inputs the existing `coordinateGoal` /
   `coordinateSession` / `requestCoordination` engine already runs; the
   background worker gets it through `workerEntry`.
4. **Every result records its method.** Records gain `workflow {id, version}`
   and `checksRan [{kind, harness, verdict}]` so the result page can show what
   actually ran.
5. **Storage.** User definitions live in the profile (`workflows.json`) and
   must be included in profile backup and import. Recommended versions ship in
   the app.
6. **Versions.** A copy records its parent (`recommended@vN`). It belongs to the
   user; a newer Recommended can be compared and adopted module by module, never
   applied silently.
7. **Method, not private state.** Recommended absorbs Agent Core's portable
   method: Outcome / Done / Not-in-scope, separate plan / execute / review,
   fresh-context review on a different model, four blocker classes, continue
   authorised work. It never depends on the owner's private bindings (project
   archive, Linear / Notion / Slack, hooks, private model ids, owner-only gates).
8. **Live Continue keys on capability, not a pair.** Eligibility becomes:
   read-only, background consent, a reviewer that could judge the plan, ≥ 2
   reads left. It stops being an exact `["codex","pi"]` + 4-turn match.

### Not in v1

- A lead-driven agent loop (Agent Core's main-agent + dynamic delegation).
  v1 parameterises the existing chain; a loop is a separate design.
- Delivery actions such as commit / PR. They need a new authorisation surface.
- Grok in the coordinated path, Pi as a Direct runtime: new runtime work, tracked separately.

## Slices

1. Recommended v1 + mode picker + "what ran" on the result page, with no
   behaviour drift (same command ids before and after).
2. Checks module: reviewer capability and requirement quoting; Live Continue
   on capability. Accept on the packaged EXE: a Codex + Pi read-only goal reaches
   "checked" and Live Continue appears (#63, and real-app acceptance of #61).
3. My workflow: copy Recommended, edit grouped modules, save, use.
4. Resources: per-role fast / strong preference, budget prefill.
5. Feedback: repair / replan / stop, round counts, what needs the user.
6. Compare and adopt a newer Recommended.

Each slice is accepted per AGENTS.md §2 (screenshots at ≤860, ~1020, ≥1440;
new-user walkthrough; packaged EXE).
