# Architecture

GoalPort separates the window you look at from the process that owns your work. The window is Electron with a React renderer. A local Rust Core owns all GoalPort state in SQLite and supervises the native Runtime processes, and it keeps running when the window closes.

## Processes

```text
┌──────────────────────── GoalPort.exe (Electron) ────────────────────────┐
│ React renderer ── window.goalportCore (preload) ── Electron main        │
└──────────────────────────────────────┬──────────────────────────────────┘
                     Windows Named Pipe, length-prefixed JSON (goalport.ipc.v2)
┌──────────────────────────────────────┴──────────────────────────────────┐
│ goalport-core.exe  (started once by goalport-core-launcher.exe)         │
│   UiController ─ CommandProcessor ─ Store (SQLite, WAL)                 │
│   RuntimeManager ─┬─ codex app-server        (JSON-RPC over stdio)      │
│                   ├─ claude -p stream-json   (persistent stdio)         │
│                   ├─ grok agent stdio        (ACP)                      │
│                   └─ Scenario                (in-process, synthetic)    │
└─────────────────────────────────────────────────────────────────────────┘
```

**Renderer** (`src/`). A single React app. It has no Node access. It reaches Core only through the preload bridge (`electron/preload.cjs`) and polls a snapshot every 750 ms.

**Electron main** (`electron/main.cjs`). Runs a single instance with a sandboxed, context-isolated window. On start it attaches to an existing Core for the same profile. Only if none answers does it launch one through `goalport-core-launcher.exe`. It refuses to attach to a Core whose startup receipt is not `READY_COMMITTED` for the same Core binary hash, database and pipe (`electron/launch-config.cjs`). With a normal or synthetic-test data profile it also authenticates the pipe server (the legacy isolated test mode without a data profile does not; see [limitations](limitations.md#local-pipe-security)): before attaching, before every request other than a snapshot poll, and after any connection failure, it runs `goalport-core pipe-peer`. That command checks the pipe's owner and access list and that the serving process runs as the same Windows user, and the window requires the serving process to be the Core that committed the startup receipt. Otherwise attachment is refused and the request is not sent.

**Launcher** (`crates/goalport-launcher`). Starts Core detached from the window, requesting breakaway from any Windows job object. If a supervising job refuses breakaway, Core starts inside that job instead, and the launcher records which mode it used beside the database. In that case an external supervisor, such as a terminal or CI runner, can still end Core when its job ends. See [Windows job objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects).

**Core** (`crates/goalport-core`). The only writer of GoalPort state. It serves a local Windows Named Pipe whose name is derived from the profile and the Core binary hash. The pipe's security is set explicitly rather than inherited from Windows defaults. The pipe grants access to only the Windows user account that runs Core: it is owned by that account and has a protected access list with a single entry for it, with no SYSTEM, Administrators, Everyone or Anonymous entries. Every pipe instance is created with `PIPE_REJECT_REMOTE_CLIENTS`, and the first one with `FILE_FLAG_FIRST_PIPE_INSTANCE`, so Core never adds itself to a pipe name that another process created. Core reads back the security of each instance it creates and fails closed: if setting it up or verifying it fails, or the name is already taken, Core records the startup as aborted and exits with a short message. `crates/goalport-core/tests/pipe_security.rs` checks this on real Windows objects, including denial for a restricted token and `pipe-peer` against Cores and foreign pipes. It does not open a TCP listener. Frames are length-prefixed JSON capped at 16 MiB. Every command reply carries a full snapshot. A background thread keeps persisting Runtime events whether or not a window is attached.

**Tauri** (`src-tauri/`). A second host for the same renderer and Core. It is kept as a bounded regression target for shared Core/protocol changes, not as a product.

## The work model: Campaign → Task → Attempt

| Entity | Meaning |
| --- | --- |
| Project | A canonical workspace folder you chose |
| Campaign | A goal you are pursuing in that workspace; has a root Task and a work status (`IN_PROGRESS`, `FINISHED`, `ABANDONED`, `FAILED`) |
| Task | The unit of work with a title and acceptance text |
| Attempt | One Runtime binding working on a Task: provider, native session, strictly ordered events, and a state (`Queued`, `Active`, `AwaitingReview`, `Closed`, `Failed`, `Cancelled`) |

How these change in practice:

- **Creating a Campaign** saves the Project, Campaign, root Task and policy in one transaction. No prompt is sent and no Attempt exists yet.
- **Selecting a Runtime** creates or reuses the Attempt. A Task keeps at most one live Attempt. Choosing a different Runtime while it is live is refused, and the existing binding is kept.
- **After an Attempt ends**, selecting a Runtime starts a new Attempt that records the one it rolled from. If several selections race, only one replacement is created.
- **Handing off to another Runtime** ("Assign next step to…" in the window) creates a new Attempt with a persisted handoff packet. It is refused while workspace responsibility is held, while a lease is unreleased, or while any outbound effect is pending or unknown.

The design behind this model is in the [historical V1 design](history/v1-design/2026-08-31-goalport-v1-design-r2.md) (sections 5–6, Chinese).

## Storage

Core writes one SQLite database per profile (`goalport.sqlite`, WAL mode). Main table groups (`crates/goalport-core/src/store.rs`):

| Group | Tables |
| --- | --- |
| Work | `projects`, `campaigns`, `campaign_projects`, `tasks`, `attempts` |
| History | `events` (append-only, unique per Attempt sequence), `commands` |
| Safety | `workspace_leases`, `decisions`, `outbox`, `attempt_recovery`, `policy_snapshots`, `campaign_authorizations`, `admission_queue` |
| Stop | `stop_responsibilities`, `stop_recheck_observations`, `stop_continuations` |
| Process identity | `core_launch_epochs`, `runtime_epoch_bindings`, `product_receipts` |

Where the database lives and how profiles are bound to a build: [local data](local-data.md). How these records are used when things go wrong: [safety and recovery](safety.md).
