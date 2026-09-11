//! Increment 5 of run `goal-runs/runtime-registration-safety`: a failure record constrains only the
//! registration it belongs to. After a legitimate re-registration that actually completed recovery
//! or initialization through an existing entry (`resume_native_session`, the `send_message`
//! re-select), the same Attempt is no longer refused by the old kept record; a re-registration
//! whose recovery failed, and a success record that does not belong to the current registration,
//! keep the refusal.
//!
//! The "Core restart" is a second `CoreServer` over the same cloned store (fresh `RuntimeManager`,
//! `reconstruct_from_store`). The restart entries pass no executable and resolve codex through
//! `%APPDATA%\npm\node_modules\@openai\codex\...\bin\codex.exe` — ON THIS MACHINE THE INSTALLED
//! CODEX CLI EXISTS AT THAT PATH. The restart cases therefore run under a fail-closed guard: an RAII
//! `FakeAppData` builds that tree under the scratch artifact root with A COPY OF node.exe NAMED
//! codex.exe (the node fixture 1 reports as its `execPath`), sets `APPDATA` to the scratch root and
//! restores it on drop (also on unwind); before any restart entry the case asserts `APPDATA` and the
//! first candidate's presence and hash; after each entry it asserts the new fixture instance's
//! `execPath` lies under the scratch root and otherwise panics with `REAL-CODEX-RISK`, which the
//! runner treats as a hard stop. No real CLI, no subscription. Two fixture instances share a case
//! workspace and are told apart by the per-pid files the fixture writes; one stop marker ends both.
#![cfg(windows)]

use goalport_core::{
    Project, PromptRequest, RuntimeManager, SessionRequest,
    domain::{AttemptState, Campaign, CommandState, Event, Task, WorkStatus},
    ipc::{CONNECTED_UI_PROTOCOL_VERSION, CoreServer},
    process_identity::{ProcessObservation, observe_process},
    product_receipts::{begin_startup_epoch, complete_startup_epoch},
    projection::send_message_command,
    runtime_manager::{ProcessConfirmation, TransportState},
    store::{CampaignAuthorization, Store},
};
use serde_json::{Value, json};
use std::{
    env, fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};

const FAILED_KIND: &str = "attempt.admission.failed";
const ESTABLISHED_KIND: &str = "runtime.registration.established";
const NOT_COMPLETE: &str = "initialization did not complete";
const NOT_RECORDED: &str = "initialization or recovery success is not recorded";
const NOT_RETRIED: &str = "not retried automatically";
/// Budget of a restart case: fixture 1's unconditional watchdog.
const WATCHDOG: Duration = Duration::from_secs(45);

static CODEX_LOCK: Mutex<()> = Mutex::new(());

const ALLOWED_ENV: &[&str] = &[
    "GOALPORT_SYNTHETIC_ROOT",
    "GOALPORT_TEST_ARTIFACT_ROOT",
    "GOALPORT_CODEX_TRANSPORT",
    "GOALPORT_LAUNCH_NONCE",
    "GOALPORT_LAUNCH_REQUESTED_AT",
    "GOALPORT_LAUNCHER_STARTED_AT",
    "GOALPORT_CORE_SPAWNED_AT",
];

fn assert_env_pinned() {
    for (key, _) in env::vars() {
        if key.starts_with("GOALPORT_") {
            assert!(
                ALLOWED_ENV.contains(&key.as_str())
                    || key.starts_with("GOALPORT_ELECTRON_")
                    || key.starts_with("GOALPORT_LAUNCHER_"),
                "stray {key} in the test environment; the runner must scrub GOALPORT_* first"
            );
        }
    }
}

fn lock() -> std::sync::MutexGuard<'static, ()> {
    CODEX_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn request(id: &str, message_type: &str, payload: Value) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "protocolVersion": CONNECTED_UI_PROTOCOL_VERSION,
        "requestId": id,
        "entityVersion": 0,
        "messageType": message_type,
        "payload": payload
    }))
    .unwrap()
}

fn call(server: &CoreServer, id: &str, message_type: &str, payload: Value) -> Value {
    server
        .handle_json(&request(id, message_type, payload))
        .expect("the command envelope must be accepted by handle_json")
}

fn error_of(response: &Value) -> String {
    assert_eq!(response["ok"], false, "expected a refusal, got {response}");
    response["error"].as_str().unwrap_or_default().to_string()
}

fn snapshot(server: &CoreServer, id: &str) -> Value {
    let response = call(server, id, "snapshot", json!({}));
    assert_eq!(response["ok"], true, "snapshot must succeed: {response}");
    response["payload"]["snapshot"].clone()
}

fn selected_attempt(server: &CoreServer, id: &str) -> String {
    snapshot(server, id)["attempt"]["id"]
        .as_str()
        .unwrap_or_default()
        .to_string()
}

fn fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/fake-codex-app-server/fake-codex-app-server.cmd")
}

fn fixture_module() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/fake-codex-app-server/fake-codex-app-server.mjs")
}

fn scratch_root() -> PathBuf {
    env::var_os("GOALPORT_TEST_ARTIFACT_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| env::temp_dir().join("goalport-registration-generation"))
}

fn canonical(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

fn under_scratch(path: &Path) -> bool {
    canonical(path).starts_with(canonical(&scratch_root()))
}

fn default_attempt(task: &str, provider: &str) -> String {
    let suffix: String = task
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .collect();
    format!("attempt-{suffix}-{provider}")
}

/// Commits the case's only Core launch epoch (server 2, the "restarted" Core) through the
/// product-receipt path; the nonce and pipe name are per case. Caller holds `CODEX_LOCK`.
fn seed_core_epoch(store: &Store, workspace: &Path, nonce: &str) {
    let db = workspace.join("core-fixture.sqlite");
    let pipe = format!(r"\\.\pipe\registration-generation-{nonce}");
    unsafe {
        env::set_var("GOALPORT_LAUNCH_NONCE", nonce);
        env::set_var("GOALPORT_ELECTRON_PID", "10");
        env::set_var("GOALPORT_ELECTRON_CREATED_MS", "1000");
        env::set_var("GOALPORT_ELECTRON_EXE", r"C:\pkg\GoalPort.exe");
        env::set_var("GOALPORT_ELECTRON_SHA256", "aa");
        env::set_var("GOALPORT_LAUNCHER_PID", "20");
        env::set_var("GOALPORT_LAUNCHER_CREATED_MS", "1100");
        env::set_var("GOALPORT_LAUNCHER_EXE", r"C:\pkg\goalport-core-launcher.exe");
        env::set_var("GOALPORT_LAUNCHER_SHA256", "bb");
        env::set_var("GOALPORT_LAUNCHER_PARENT_PID", "10");
        env::set_var("GOALPORT_LAUNCH_REQUESTED_AT", "2026-09-02T00:00:00.000Z");
        env::set_var("GOALPORT_LAUNCHER_STARTED_AT", "2026-09-02T00:00:00.010Z");
        env::set_var("GOALPORT_CORE_SPAWNED_AT", "2026-09-02T00:00:00.020Z");
        env::remove_var("GOALPORT_REQUIRE_ISOLATED");
    }
    let claim = begin_startup_epoch(store, &pipe, &db).expect("startup epoch should be claimable");
    complete_startup_epoch(
        store,
        &pipe,
        &db,
        &claim,
        &json!({
            "status": "completed",
            "commandsUnknown": 0,
            "outboxUnknown": 0,
            "leasesUncertain": 0,
            "runtimeAttachment": "UNKNOWN_OR_UNSUPPORTED",
            "promptReplay": false
        }),
    )
    .expect("startup epoch should commit");
}

struct Case {
    project: String,
    campaign: String,
    task: String,
    workspace: PathBuf,
}

fn case_project(server: &CoreServer, name: &str, scenario: &str) -> Case {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let workspace = scratch_root().join(format!("i5-{name}-{nonce}"));
    fs::create_dir_all(&workspace).expect("case workspace should be creatable");
    fs::write(workspace.join(".fake-codex-scenario"), scenario).unwrap();
    let project = format!("project-{name}");
    let campaign = format!("campaign-{name}");
    let task = format!("task-{name}");
    let store = server.processor().store();
    store
        .insert_project(&Project {
            id: project.clone(),
            workspace_root: workspace.to_string_lossy().into_owned(),
        })
        .unwrap();
    store
        .create_campaign_with_task(
            &project,
            &Campaign {
                id: campaign.clone(),
                goal: format!("registration generation case {name}"),
                root_task_id: task.clone(),
                state: WorkStatus::InProgress,
            },
            &Task {
                id: task.clone(),
                campaign_id: campaign.clone(),
                title: format!("task {name}"),
                acceptance: "selectable".into(),
                state: WorkStatus::InProgress,
            },
        )
        .unwrap();
    store
        .set_campaign_authorization(&campaign, &CampaignAuthorization::granted())
        .unwrap();
    Case {
        project,
        campaign,
        task,
        workspace,
    }
}

fn select_codex(server: &CoreServer, id: &str, case: &Case, executable: Option<&Path>) -> Value {
    let mut payload = json!({
        "projectId": case.project,
        "campaignId": case.campaign,
        "taskId": case.task,
        "provider": "codex"
    });
    if let Some(executable) = executable {
        payload["executable"] = json!(executable.to_string_lossy());
    }
    call(server, id, "select_runtime", payload)
}

fn events(server: &CoreServer, attempt: &str) -> Vec<(String, Option<Value>)> {
    server
        .processor()
        .store()
        .list_event_records(attempt, 0)
        .unwrap()
        .into_iter()
        .map(|record| (record.event.kind, record.payload))
        .collect()
}

fn records_of<'a>(events: &'a [(String, Option<Value>)], kind: &str) -> Vec<&'a Value> {
    events
        .iter()
        .filter(|(k, _)| k == kind)
        .filter_map(|(_, payload)| payload.as_ref())
        .collect()
}

fn wait_for(path: &Path, bound: Duration) -> bool {
    let started = Instant::now();
    while started.elapsed() < bound {
        if path.exists() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    path.exists()
}

// ---------------------------------------------------------------------------------------------
// Fixture instances (per-pid files)
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct Instance {
    pid: u32,
    exec_path: PathBuf,
}

/// Every fixture instance that has started in the workspace, by its per-pid json.
fn instances(workspace: &Path) -> Vec<Instance> {
    let mut found = Vec::new();
    for entry in fs::read_dir(workspace).unwrap() {
        let path = entry.unwrap().path();
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        if name.starts_with(".fake-codex-app-server.") && name.ends_with(".json") && name != ".fake-codex-app-server.json" {
            let json: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
            found.push(Instance {
                pid: u32::try_from(json["pid"].as_u64().expect("pid recorded")).unwrap(),
                exec_path: PathBuf::from(json["execPath"].as_str().expect("execPath recorded")),
            });
        }
    }
    found
}

/// The instance launched since `known`, waiting briefly for its json to appear.
fn new_instance(workspace: &Path, known: &[Instance]) -> Instance {
    let started = Instant::now();
    loop {
        let fresh: Vec<Instance> = instances(workspace)
            .into_iter()
            .filter(|instance| !known.iter().any(|k| k.pid == instance.pid))
            .collect();
        if fresh.len() == 1 {
            return fresh[0].clone();
        }
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "REAL-CODEX-RISK: no new synthetic fixture instance recorded after the entry returned ({} found)",
            fresh.len()
        );
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn is_live(pid: u32) -> bool {
    matches!(observe_process(pid), ProcessObservation::Live(_))
}

fn exit_reason(workspace: &Path, pid: u32) -> Option<String> {
    let path = workspace.join(format!(".fake-codex-exited.{pid}.marker"));
    let text = fs::read_to_string(path).ok()?;
    let json: Value = serde_json::from_str(&text).ok()?;
    json["reason"].as_str().map(str::to_owned)
}

/// Ends every fixture instance in the workspace through the stop marker (never through Core) and
/// requires each named pid to have written its exit marker; fixture 1 must have ended on the stop
/// marker, not on its watchdog (a watchdog exit means the case overran its budget).
fn stop_fixtures(workspace: &Path, pids: &[u32]) {
    fs::write(workspace.join(".fake-codex-stop.marker"), "stop").unwrap();
    for pid in pids {
        assert!(
            wait_for(&workspace.join(format!(".fake-codex-exited.{pid}.marker")), Duration::from_secs(10)),
            "fixture pid {pid} must end on the stop marker (no leaked node process)"
        );
    }
    let first = exit_reason(workspace, pids[0]);
    assert_eq!(first.as_deref(), Some("stop_marker"), "fixture 1 ended on the stop marker, not the watchdog");
}

// ---------------------------------------------------------------------------------------------
// The synthetic codex.exe the restart entries resolve — and the fail-closed guard
// ---------------------------------------------------------------------------------------------

/// Real SHA-256 over the whole file (the crate's `sha2` dependency): the guard must prove the
/// executable it will let Core launch is byte-identical to the node.exe it copied.
fn sha256_of(path: &Path) -> String {
    use sha2::{Digest, Sha256};
    let bytes = fs::read(path).unwrap();
    let digest = Sha256::digest(&bytes);
    format!("{}:{:x}", bytes.len(), digest)
}

const CANDIDATE: &str =
    r"npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe";

/// The `%APPDATA%` tree `resolve_native_executable("codex")` searches, holding a byte copy of the
/// node.exe fixture 1 ran on, named codex.exe. Installing it sets `APPDATA` in-process (caller
/// holds `CODEX_LOCK`); dropping it restores the previous value and asserts the restore, also on
/// unwind.
struct FakeAppData {
    previous: Option<std::ffi::OsString>,
    root: PathBuf,
    exe: PathBuf,
    digest: String,
}

impl FakeAppData {
    fn install(node: &Path) -> Self {
        let root = scratch_root().join("appdata");
        let exe = root.join(CANDIDATE);
        fs::create_dir_all(exe.parent().unwrap()).unwrap();
        let digest = sha256_of(node);
        if !exe.is_file() || sha256_of(&exe) != digest {
            fs::copy(node, &exe).expect("node.exe should be copyable as codex.exe");
        }
        let previous = env::var_os("APPDATA");
        unsafe {
            env::set_var("APPDATA", &root);
        }
        Self {
            previous,
            root,
            exe,
            digest,
        }
    }

    /// Must hold immediately before every restart entry: the resolution can only find the copy.
    fn assert_armed(&self) {
        assert_eq!(env::var_os("APPDATA").as_deref(), Some(self.root.as_os_str()), "APPDATA must point at the scratch tree");
        assert!(self.exe.is_file(), "the synthetic codex.exe must exist at the first candidate path");
        assert!(under_scratch(&self.exe), "the synthetic codex.exe must lie under the scratch root");
        assert_eq!(sha256_of(&self.exe), self.digest, "the synthetic codex.exe must be the node.exe copy");
    }

    /// Must hold right after every restart entry: the instance that started is the synthetic one.
    fn assert_synthetic(&self, instance: &Instance) {
        assert!(
            under_scratch(&instance.exec_path),
            "REAL-CODEX-RISK: a fixture instance reports an executable outside the scratch root: {:?}",
            instance.exec_path
        );
        assert_eq!(
            canonical(&instance.exec_path).to_string_lossy().to_ascii_lowercase(),
            canonical(&self.exe).to_string_lossy().to_ascii_lowercase(),
            "the restart entry resolved the synthetic codex.exe"
        );
    }
}

impl Drop for FakeAppData {
    fn drop(&mut self) {
        unsafe {
            match &self.previous {
                Some(value) => env::set_var("APPDATA", value),
                None => env::remove_var("APPDATA"),
            }
        }
        assert_eq!(env::var_os("APPDATA"), self.previous, "APPDATA restored");
    }
}

/// The cwd-local ESM loader node runs when invoked as `codex.exe app-server --listen stdio://`.
fn write_loader(workspace: &Path) {
    let module = fixture_module().canonicalize().unwrap();
    let url = format!(
        "file:///{}",
        module.to_string_lossy().trim_start_matches(r"\\?\").replace('\\', "/")
    );
    fs::write(workspace.join("app-server"), format!("import(\"{url}\");\n")).unwrap();
}

/// The a4 shape of increment 4: an admission that fails at `session_events` (no Core epoch), row
/// Active, registration kept, fixture 1 alive. Returns the attempt id and fixture 1.
fn kept_failure(server: &CoreServer, case: &Case) -> (String, Instance) {
    let attempt = default_attempt(&case.task, "codex");
    let error = error_of(&select_codex(server, "first-admission", case, Some(&fixture())));
    assert!(
        error.contains("runtime admission failed during session_events") && error.contains("kept"),
        "the a4 shape must be produced by the product: {error}"
    );
    let first = new_instance(&case.workspace, &[]);
    assert!(is_live(first.pid));
    let store = server.processor().store();
    assert_eq!(store.get_attempt(&attempt).unwrap().state, AttemptState::Active);
    (attempt, first)
}

fn kept_record(server: &CoreServer, attempt: &str) -> Value {
    let all = events(server, attempt);
    let kept: Vec<&Value> = records_of(&all, FAILED_KIND)
        .into_iter()
        .filter(|payload| payload["registration"] == "kept")
        .collect();
    assert_eq!(kept.len(), 1, "exactly one kept record: {all:?}");
    kept[0].clone()
}

struct Restarted {
    server: CoreServer,
    appdata: FakeAppData,
    attempt: String,
    first: Instance,
    kept_before: Value,
    began: Instant,
}

/// Server 1 produces the kept failure, is dropped, and server 2 comes up over the same store with
/// the case's only epoch and the guard armed.
fn restart_after_kept_failure(case_name: &str, scenario: &str) -> (Case, Restarted) {
    let began = Instant::now();
    let store = Store::memory().unwrap();
    let server1 = CoreServer::new(store.clone());
    let case = case_project(&server1, case_name, scenario);
    write_loader(&case.workspace);
    let (attempt, first) = kept_failure(&server1, &case);
    let kept_before = kept_record(&server1, &attempt);
    drop(server1); // the "Core restart": the in-memory registration is gone

    let server = CoreServer::new(store.clone());
    seed_core_epoch(server.processor().store(), &case.workspace, &format!("{case_name}-restart"));
    let appdata = FakeAppData::install(&first.exec_path);
    appdata.assert_armed();
    (
        case,
        Restarted {
            server,
            appdata,
            attempt,
            first,
            kept_before,
            began,
        },
    )
}

// ---------------------------------------------------------------------------------------------
// G1: Core restart, resume succeeds, the fresh registration is reusable
// ---------------------------------------------------------------------------------------------

#[test]
fn g1_restart_then_successful_resume_makes_the_fresh_registration_reusable() {
    let _lock = lock();
    assert_env_pinned();
    let (case, r) = restart_after_kept_failure("g1", "resume_ok");
    let server = &r.server;

    r.appdata.assert_armed();
    let resumed = call(server, "g1-resume", "resume_native_session", json!({ "attemptId": r.attempt }));
    let second = new_instance(&case.workspace, &[r.first.clone()]);
    r.appdata.assert_synthetic(&second);
    assert_eq!(resumed["ok"], true, "{resumed}");
    assert!(is_live(second.pid));
    let after_resume = events(server, &r.attempt);
    assert!(
        records_of(&after_resume, "runtime.session.resumed").iter().any(|p| p["resumed"] == true),
        "{after_resume:?}"
    );

    // Inside the APPDATA window (binding equality depends on it): the fresh, live, legitimately
    // resumed registration is selectable again.
    r.appdata.assert_armed();
    let selected = select_codex(server, "g1-select", &case, None);
    assert_eq!(
        selected["ok"], true,
        "a registration re-established through resume must not be refused by the old kept record: {selected}"
    );
    assert_eq!(selected_attempt(server, "g1-view"), r.attempt);

    let established: Vec<Value> = records_of(&after_resume, ESTABLISHED_KIND).into_iter().cloned().collect();
    assert_eq!(established.len(), 1, "{after_resume:?}");
    assert_eq!(established[0]["entry"], "resume_native_session");
    let kept_identity = r.kept_before["registration_identity"].as_str().expect("the kept record names its registration");
    let new_identity = established[0]["registration_identity"].as_str().expect("the established record names its registration");
    assert_ne!(kept_identity, new_identity);
    assert_eq!(kept_record(server, &r.attempt), r.kept_before, "old records are never rewritten");
    assert_eq!(events(server, &r.attempt), after_resume, "a reuse writes nothing");
    assert!(is_live(second.pid), "nothing may kill the resumed process");

    // Boundary (3) at path level: the re-established registration bypasses no revocation. A
    // revoked provider authorization is refused before the reuse decision is ever reached.
    let revoked = call(
        server,
        "g1-revoke",
        "revoke_authorization",
        json!({ "campaignId": case.campaign, "scope": "provider" }),
    );
    assert_eq!(revoked["ok"], true, "{revoked}");
    r.appdata.assert_armed();
    let denied = error_of(&select_codex(server, "g1-select-revoked", &case, None));
    assert!(
        denied.contains("denies provider attach"),
        "the authorization refusal must precede the reuse, not be bypassed by it: {denied}"
    );
    assert!(is_live(second.pid), "a refusal kills nothing");
    assert!(r.began.elapsed() < WATCHDOG, "the case must finish inside fixture 1's watchdog");

    stop_fixtures(&case.workspace, &[r.first.pid, second.pid]);
}

// ---------------------------------------------------------------------------------------------
// G2: Core restart, resume rejected, the fresh registration is still refused
// ---------------------------------------------------------------------------------------------

#[test]
fn g2_restart_then_rejected_resume_is_still_refused() {
    let _lock = lock();
    assert_env_pinned();
    let (case, r) = restart_after_kept_failure("g2", "resume_rejected");
    let server = &r.server;

    r.appdata.assert_armed();
    let resumed = call(server, "g2-resume", "resume_native_session", json!({ "attemptId": r.attempt }));
    let second = new_instance(&case.workspace, &[r.first.clone()]);
    r.appdata.assert_synthetic(&second);
    assert_eq!(resumed["ok"], true, "the command records the rejection and returns ok: {resumed}");
    assert!(is_live(second.pid), "the process the rejected resume started is alive");
    let after_resume = events(server, &r.attempt);
    assert!(
        records_of(&after_resume, "runtime.session.resumed").iter().any(|p| p["resumed"] == false),
        "{after_resume:?}"
    );
    assert!(records_of(&after_resume, ESTABLISHED_KIND).is_empty(), "a failed recovery establishes nothing");

    r.appdata.assert_armed();
    let refused = error_of(&select_codex(server, "g2-select", &case, None));
    assert!(
        refused.contains(NOT_RECORDED) && refused.contains(NOT_RETRIED),
        "a re-registration whose recovery failed is not handed back: {refused}"
    );
    assert_eq!(events(server, &r.attempt), after_resume, "the refusal writes nothing");
    assert_eq!(kept_record(server, &r.attempt), r.kept_before);
    assert!(is_live(second.pid), "nothing may kill the kept process");
    assert!(r.began.elapsed() < WATCHDOG);

    stop_fixtures(&case.workspace, &[r.first.pid, second.pid]);
}

// ---------------------------------------------------------------------------------------------
// G3: a success record that does not belong to the current registration does not lift the refusal
// (restart shape: kept A, registration B without its own record, a CONSTRUCTED record for a third
// identity appended through the store — no product path writes a record for a registration it did
// not establish)
// ---------------------------------------------------------------------------------------------

fn append_constructed_established(server: &CoreServer, attempt: &str, identity: &str) {
    let recorded = events(server, attempt);
    let next_seq = i64::try_from(recorded.len()).unwrap() + 1;
    server
        .processor()
        .store()
        .append_event_with_state(
            &Event {
                id: format!("core-event-{attempt}-{next_seq}"),
                attempt_id: attempt.into(),
                seq: next_seq,
                kind: ESTABLISHED_KIND.into(),
                payload_ref: None,
            },
            None,
            Some(&json!({
                "registration_identity": identity,
                "entry": "resume_native_session",
                "provider": "codex",
                "constructed": "test-seeded record for a registration that never existed"
            })),
        )
        .unwrap();
}

#[test]
fn g3_a_foreign_success_record_does_not_lift_the_refusal_across_a_restart() {
    let _lock = lock();
    assert_env_pinned();
    let (case, r) = restart_after_kept_failure("g3", "resume_rejected");
    let server = &r.server;

    r.appdata.assert_armed();
    let resumed = call(server, "g3-resume", "resume_native_session", json!({ "attemptId": r.attempt }));
    let second = new_instance(&case.workspace, &[r.first.clone()]);
    r.appdata.assert_synthetic(&second);
    assert_eq!(resumed["ok"], true, "{resumed}");
    append_constructed_established(server, &r.attempt, "constructed-other:1");
    let before_select = events(server, &r.attempt);

    r.appdata.assert_armed();
    let refused = error_of(&select_codex(server, "g3-select", &case, None));
    assert!(
        refused.contains(NOT_RECORDED) && refused.contains(NOT_RETRIED),
        "a success record for another registration exempts nothing: {refused}"
    );
    assert_eq!(events(server, &r.attempt), before_select, "the refusal writes nothing");
    assert_eq!(kept_record(server, &r.attempt), r.kept_before);
    assert!(is_live(second.pid));
    assert!(r.began.elapsed() < WATCHDOG);

    stop_fixtures(&case.workspace, &[r.first.pid, second.pid]);
}

#[test]
fn g3b_same_lifetime_a_foreign_success_record_does_not_lift_the_failed_registrations_refusal() {
    let _lock = lock();
    assert_env_pinned();
    let server = CoreServer::new(Store::memory().unwrap());
    let case = case_project(&server, "g3b", "linger");
    let (attempt, first) = kept_failure(&server, &case);
    let kept = kept_record(&server, &attempt);
    append_constructed_established(&server, &attempt, "constructed-other:1");

    let refused = error_of(&select_codex(&server, "g3b-select", &case, Some(&fixture())));
    assert!(
        refused.contains(NOT_COMPLETE) && refused.contains(NOT_RETRIED),
        "the registration that failed stays refused: {refused}"
    );
    assert_eq!(kept_record(&server, &attempt), kept);
    assert!(is_live(first.pid));
    stop_fixtures(&case.workspace, &[first.pid]);
}

// ---------------------------------------------------------------------------------------------
// G4: Core restart, the send_message re-select re-establishes, then reusable
// ---------------------------------------------------------------------------------------------

#[test]
fn g4_restart_then_send_message_reselect_makes_the_fresh_registration_reusable() {
    let _lock = lock();
    assert_env_pinned();
    let (case, r) = restart_after_kept_failure("g4", "resume_ok");
    let server = &r.server;

    // send_message requires the attempt to be Core-selected: select_project clears the selection
    // and the snapshot selects the task's latest attempt.
    let project = call(server, "g4-project", "select_project", json!({ "projectId": case.project }));
    assert_eq!(project["ok"], true, "{project}");
    assert_eq!(selected_attempt(server, "g4-snapshot"), r.attempt, "the snapshot selects the case attempt");

    r.appdata.assert_armed();
    let sent = call(
        server,
        "g4-send",
        "send_message",
        json!({ "attemptId": r.attempt, "campaignId": case.campaign, "message": "hello after restart" }),
    );
    let second = new_instance(&case.workspace, &[r.first.clone()]);
    r.appdata.assert_synthetic(&second);
    assert_eq!(sent["ok"], true, "{sent}");
    assert!(is_live(second.pid));
    let after_send = events(server, &r.attempt);

    r.appdata.assert_armed();
    let selected = select_codex(server, "g4-select", &case, None);
    assert_eq!(
        selected["ok"], true,
        "a registration re-established through the send path must not be refused by the old kept record: {selected}"
    );
    let established: Vec<Value> = records_of(&after_send, ESTABLISHED_KIND).into_iter().cloned().collect();
    assert_eq!(established.len(), 1, "{after_send:?}");
    assert_eq!(established[0]["entry"], "send_message");
    assert_ne!(
        established[0]["registration_identity"].as_str().unwrap(),
        r.kept_before["registration_identity"].as_str().unwrap()
    );
    assert_eq!(kept_record(server, &r.attempt), r.kept_before);
    assert!(is_live(second.pid));
    assert!(r.began.elapsed() < WATCHDOG);

    stop_fixtures(&case.workspace, &[r.first.pid, second.pid]);
}

// ---------------------------------------------------------------------------------------------
// G5 (owner ruling B): after a real resume the event-reading path is attached — a new input
// submitted through send_message yields the provider's reply for that Attempt through the real
// consumption path (snapshot -> flush_runtime_events -> poll_events -> persisted runtime events)
// ---------------------------------------------------------------------------------------------

#[test]
fn g5_restart_then_resume_delivers_events_through_poll_events() {
    let _lock = lock();
    assert_env_pinned();
    let (case, r) = restart_after_kept_failure("g5", "resume_ok");
    let server = &r.server;

    r.appdata.assert_armed();
    let resumed = call(server, "g5-resume", "resume_native_session", json!({ "attemptId": r.attempt }));
    let second = new_instance(&case.workspace, &[r.first.clone()]);
    r.appdata.assert_synthetic(&second);
    assert_eq!(resumed["ok"], true, "{resumed}");
    let after_resume = events(server, &r.attempt);
    assert_eq!(records_of(&after_resume, ESTABLISHED_KIND).len(), 1, "{after_resume:?}");

    // Use the resumed registration: select it (send_message requires the Core selection) and
    // submit a correlatable input. The fixture echoes the input back as an agent message.
    let project = call(server, "g5-project", "select_project", json!({ "projectId": case.project }));
    assert_eq!(project["ok"], true, "{project}");
    assert_eq!(selected_attempt(server, "g5-snapshot"), r.attempt);
    let marker = format!("g5-input-{}", second.pid);
    let sent = call(
        server,
        "g5-send",
        "send_message",
        json!({ "attemptId": r.attempt, "campaignId": case.campaign, "message": marker }),
    );
    assert_eq!(sent["ok"], true, "{sent}");
    assert_eq!(instances(&case.workspace).len(), 2, "sending after a resume launches nothing");

    // The reply must arrive through the real consumption path: each snapshot flushes
    // poll_events into the store. Bounded wait for the echoed delta tied to this Attempt.
    let started = Instant::now();
    let (delta, completed) = loop {
        let _ = snapshot(server, &format!("g5-poll-{}", started.elapsed().as_millis()));
        let all = events(server, &r.attempt);
        let delta = records_of(&all, "runtime.reply.delta")
            .into_iter()
            .find(|payload| payload["text"].as_str().is_some_and(|text| text.contains(&marker)))
            .cloned();
        let completed = !records_of(&all, "runtime.turn.completed").is_empty();
        if delta.is_some() && completed {
            break (delta, completed);
        }
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "the resumed registration's reader must deliver the echoed reply for this Attempt; events: {:?}",
            all.iter().map(|(kind, _)| kind.clone()).collect::<Vec<_>>()
        );
        std::thread::sleep(Duration::from_millis(100));
    };
    assert!(delta.is_some() && completed);
    assert!(is_live(second.pid), "nothing may kill the resumed process");
    assert_eq!(kept_record(server, &r.attempt), r.kept_before, "old records are never rewritten");
    assert!(r.began.elapsed() < WATCHDOG);

    stop_fixtures(&case.workspace, &[r.first.pid, second.pid]);
}

// ---------------------------------------------------------------------------------------------
// M1: registration identities
// ---------------------------------------------------------------------------------------------

#[test]
fn m1_registration_identities_are_unique_per_registration_and_per_manager() {
    let directory = tempfile::tempdir().unwrap();
    let workspace = directory.path().join("ws");
    fs::create_dir_all(&workspace).unwrap();
    let mut first = RuntimeManager::new();
    let mut second = RuntimeManager::new();
    assert!(first.registration_identity("nobody").is_none());
    first.select_runtime("a", "scenario", None, "v", &workspace).unwrap();
    first.select_runtime("b", "scenario", None, "v", &workspace).unwrap();
    second.select_runtime("a", "scenario", None, "v", &workspace).unwrap();
    let a1 = first.registration_identity("a").unwrap();
    let b1 = first.registration_identity("b").unwrap();
    let a2 = second.registration_identity("a").unwrap();
    assert_ne!(a1, b1, "two registrations of one manager differ");
    assert_ne!(a1, a2, "the same seq on two managers built back-to-back differs");
    assert!(a1.ends_with(":1") && b1.ends_with(":2") && a2.ends_with(":1"));
    let _ = first.registration_live("a");
    let _ = first.confirm_process_identity("a");
    assert_eq!(first.registration_identity("a").unwrap(), a1, "stable across observations");
}

// =================================================================================================
// Increment 6: a Codex registration's usability reflects the OBSERVED reader/transport state.
//
// The node fixture cannot release its own stdout while it stays alive on Windows (libuv keeps the
// pipe; evidence/increment-6/node-stdout-end-probe.txt), so the "process alive, stream dead" shape
// - the exact defect - is produced by the PYTHON twin `fake-codex-app-server.py`, which can
// `os.close(1)` and keep running (python-close-probe.txt). Same-lifetime cases pass the interpreter
// explicitly (`Some(python)`), so Core holds python directly (no `.cmd` keeping the pipe open) and
// `resolve_native_executable` is never called. Restart cases resolve codex from `%APPDATA%` under
// `FakeCodexPython`: a python.exe copy named `codex.exe` plus its runtime DLLs, with `PYTHONHOME`
// set (required, python-close-probe.txt). The installed real Codex CLI is never launched.
// =================================================================================================

/// H1's re-select refusal text: a Queued kept row hits the "session was never established" gate
/// (projection.rs, before the kept-record branch), exactly as `admission_failure::a3`.
const NEVER_ESTABLISHED: &str = "has a registered Runtime but its session was never established";

fn fixture_module_py() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/fake-codex-app-server/fake-codex-app-server.py")
}

/// Resolve the machine's real Python interpreter (`sys.executable`), or `None` to skip. Tries a
/// `GOALPORT_TEST_PYTHON` override, every `python.exe` on `PATH`, then the pinned pythoncore path;
/// each candidate is asked for its own `sys.executable` so a launcher shim resolves to the real one.
fn resolve_python() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(p) = env::var_os("GOALPORT_TEST_PYTHON") {
        candidates.push(PathBuf::from(p));
    }
    if let Some(paths) = env::var_os("PATH") {
        for dir in env::split_paths(&paths) {
            candidates.push(dir.join("python.exe"));
        }
    }
    if let Some(home) = env::var_os("USERPROFILE") {
        candidates.push(PathBuf::from(&home).join(r"AppData\Local\Python\pythoncore-3.14-64\python.exe"));
    }
    for candidate in candidates {
        if !candidate.is_file() {
            continue;
        }
        if let Ok(output) = std::process::Command::new(&candidate)
            .args(["-c", "import sys;print(sys.executable)"])
            .output()
        {
            if output.status.success() {
                let real = String::from_utf8_lossy(&output.stdout).trim().to_string();
                let path = PathBuf::from(&real);
                if path.is_file() {
                    return Some(path);
                }
            }
        }
    }
    None
}

/// The cwd-local `app-server` loader Python runs when invoked as `codex.exe app-server --listen
/// stdio://`: it runpy-executes the fixture as `__main__` with the script args preserved.
fn write_python_loader(workspace: &Path) {
    let module = fixture_module_py().canonicalize().unwrap();
    let path = module
        .to_string_lossy()
        .trim_start_matches(r"\\?\")
        .replace('\\', "/");
    fs::write(
        workspace.join("app-server"),
        format!(
            "import runpy, sys\nsys.argv = ['app-server'] + sys.argv[1:]\nrunpy.run_path('{path}', run_name='__main__')\n"
        ),
    )
    .unwrap();
}

/// The `%APPDATA%` tree `resolve_native_executable("codex")` searches, holding a python.exe copy
/// named codex.exe plus its runtime DLLs. Install sets `APPDATA` and `PYTHONHOME` in-process
/// (caller holds `CODEX_LOCK`); drop restores both and asserts the restore, also on unwind.
struct FakeCodexPython {
    previous_appdata: Option<std::ffi::OsString>,
    previous_home: Option<std::ffi::OsString>,
    root: PathBuf,
    home: PathBuf,
    exe: PathBuf,
    digest: String,
}

impl FakeCodexPython {
    fn install(python: &Path) -> Self {
        let root = scratch_root().join("appdata-py");
        let exe = root.join(CANDIDATE);
        let bin = exe.parent().unwrap().to_path_buf();
        fs::create_dir_all(&bin).unwrap();
        fs::copy(python, &exe).expect("python.exe should be copyable as codex.exe");
        let home = python.parent().unwrap().to_path_buf();
        for entry in fs::read_dir(&home).unwrap() {
            let path = entry.unwrap().path();
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                let lower = name.to_ascii_lowercase();
                if lower.ends_with(".dll") && (lower.starts_with("python") || lower.starts_with("vcruntime")) {
                    fs::copy(&path, bin.join(name)).unwrap();
                }
            }
        }
        let digest = sha256_of(&exe);
        let previous_appdata = env::var_os("APPDATA");
        let previous_home = env::var_os("PYTHONHOME");
        unsafe {
            env::set_var("APPDATA", &root);
            env::set_var("PYTHONHOME", &home);
        }
        Self { previous_appdata, previous_home, root, home, exe, digest }
    }

    fn assert_armed(&self) {
        assert_eq!(env::var_os("APPDATA").as_deref(), Some(self.root.as_os_str()), "APPDATA must point at the scratch tree");
        assert_eq!(env::var_os("PYTHONHOME").as_deref(), Some(self.home.as_os_str()), "PYTHONHOME must point at the real interpreter");
        assert!(self.exe.is_file(), "the synthetic codex.exe must exist at the first candidate path");
        assert!(under_scratch(&self.exe), "the synthetic codex.exe must lie under the scratch root");
        assert_eq!(sha256_of(&self.exe), self.digest, "the synthetic codex.exe must be the python.exe copy");
    }

    fn assert_synthetic(&self, instance: &Instance) {
        assert!(
            under_scratch(&instance.exec_path),
            "REAL-CODEX-RISK: a fixture instance reports an executable outside the scratch root: {:?}",
            instance.exec_path
        );
        assert_eq!(
            canonical(&instance.exec_path).to_string_lossy().to_ascii_lowercase(),
            canonical(&self.exe).to_string_lossy().to_ascii_lowercase(),
            "the restart entry resolved the synthetic codex.exe"
        );
    }
}

impl Drop for FakeCodexPython {
    fn drop(&mut self) {
        unsafe {
            match &self.previous_appdata {
                Some(value) => env::set_var("APPDATA", value),
                None => env::remove_var("APPDATA"),
            }
            match &self.previous_home {
                Some(value) => env::set_var("PYTHONHOME", value),
                None => env::remove_var("PYTHONHOME"),
            }
        }
        assert_eq!(env::var_os("APPDATA"), self.previous_appdata, "APPDATA restored");
        assert_eq!(env::var_os("PYTHONHOME"), self.previous_home, "PYTHONHOME restored");
    }
}

/// The turn count the fixture recorded for a pid (`.fake-codex-turns.<pid>.json`), or 0 if none.
fn turns(workspace: &Path, pid: u32) -> u64 {
    let path = workspace.join(format!(".fake-codex-turns.{pid}.json"));
    match fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| v["count"].as_u64())
            .unwrap_or(0),
        Err(_) => 0,
    }
}

/// A `.cmd` shim that runs the python fixture. Core holds the `cmd.exe`, so when the first server
/// is dropped it is the shim (not the python fixture) that is torn down — the python process is
/// orphaned and lingers until the stop marker, exactly as the node `.cmd` fixture does. (Fixture 2,
/// the resumed one, is instead the relocated `codex.exe` held directly, so its own stdout close
/// reaches Core.)
fn write_python_cmd(workspace: &Path, python: &Path) -> PathBuf {
    let module = fixture_module_py().canonicalize().unwrap();
    let module = module.to_string_lossy().trim_start_matches(r"\\?\").to_string();
    let py = python.to_string_lossy().trim_start_matches(r"\\?\").to_string();
    let shim = workspace.join("codex-python.cmd");
    fs::write(&shim, format!("@echo off\r\n\"{py}\" \"{module}\" %*\r\n")).unwrap();
    shim
}

/// A same-lifetime Codex admission that fails at `session_events` (no Core epoch), the python
/// fixture launched through the `.cmd` shim so it survives the first server's drop: row Active,
/// registration kept, fixture 1 alive. Returns the attempt and fixture 1.
fn kept_failure_python(server: &CoreServer, case: &Case, python: &Path) -> (String, Instance) {
    let attempt = default_attempt(&case.task, "codex");
    let shim = write_python_cmd(&case.workspace, python);
    let error = error_of(&select_codex(server, "first-admission", case, Some(&shim)));
    assert!(
        error.contains("runtime admission failed during session_events") && error.contains("kept"),
        "the a4 shape must be produced by the product: {error}"
    );
    let first = new_instance(&case.workspace, &[]);
    assert!(is_live(first.pid));
    assert_eq!(server.processor().store().get_attempt(&attempt).unwrap().state, AttemptState::Active);
    (attempt, first)
}

struct RestartedPython {
    server: CoreServer,
    appdata: FakeCodexPython,
    attempt: String,
    first: Instance,
    kept_before: Value,
    began: Instant,
}

/// Server 1 (python fixture, held directly) produces the kept failure, is dropped, and server 2
/// comes up over the same store with the case's only epoch and the python guard armed.
fn restart_after_kept_failure_python(case_name: &str, scenario: &str, python: &Path) -> (Case, RestartedPython) {
    let began = Instant::now();
    let store = Store::memory().unwrap();
    let server1 = CoreServer::new(store.clone());
    let case = case_project(&server1, case_name, scenario);
    write_python_loader(&case.workspace);
    let (attempt, first) = kept_failure_python(&server1, &case, python);
    assert_eq!(
        canonical(&first.exec_path).to_string_lossy().to_ascii_lowercase(),
        canonical(python).to_string_lossy().to_ascii_lowercase(),
        "fixture 1 must run the resolved python so the guard copies it"
    );
    let kept_before = kept_record(&server1, &attempt);
    drop(server1);

    let server = CoreServer::new(store.clone());
    seed_core_epoch(server.processor().store(), &case.workspace, &format!("{case_name}-restart"));
    let appdata = FakeCodexPython::install(&first.exec_path);
    appdata.assert_armed();
    (case, RestartedPython { server, appdata, attempt, first, kept_before, began })
}

fn transport_of<'a>(events: &'a [(String, Option<Value>)], kind: &str) -> Option<&'a Value> {
    records_of(events, kind).into_iter().last()
}

// ---------------------------------------------------------------------------------------------
// H1: creation, stdout closed before the thread/start response (process alive)
// ---------------------------------------------------------------------------------------------
#[test]
fn h1_creation_stream_closed_before_response_is_kept_and_recorded() {
    let _lock = lock();
    assert_env_pinned();
    let Some(python) = resolve_python() else {
        eprintln!("SKIP h1: no python interpreter resolved");
        return;
    };
    let server = CoreServer::new(Store::memory().unwrap());
    let case = case_project(&server, "h1", "stdout_closed_before_thread_start");
    write_python_loader(&case.workspace);
    let attempt = default_attempt(&case.task, "codex");

    let error = error_of(&select_codex(&server, "h1-select", &case, Some(&python)));
    assert!(
        error.contains("admission failed during create_session") && error.contains("kept"),
        "create_session must fail on the closed stream and keep the started process: {error}"
    );
    assert!(error.contains("closed before a response"), "{error}");
    let first = new_instance(&case.workspace, &[]);
    assert!(is_live(first.pid), "the process must be alive with its stdout closed");

    let recorded = events(&server, &attempt);
    let record = records_of(&recorded, FAILED_KIND).into_iter().next_back().cloned().expect("a failure record");
    assert_eq!(record["stage"], "create_session", "{record}");
    assert_eq!(record["registration"], "kept", "{record}");
    assert_eq!(record["process"], "started-or-unconfirmed", "{record}");
    assert_eq!(record["transport"]["closed"], true, "the failure record names the observed closure: {record}");
    assert_eq!(record["transport"]["reason"], "eof", "{record}");
    assert!(records_of(&recorded, "runtime.transport.closed").is_empty(), "a pre-establishment closure writes no separate transport record");

    let again = error_of(&select_codex(&server, "h1-again", &case, Some(&python)));
    assert!(again.contains(NEVER_ESTABLISHED) && again.contains(NOT_RETRIED), "a Queued kept row is refused as never-established: {again}");
    assert_eq!(turns(&case.workspace, first.pid), 0);
    assert_eq!(instances(&case.workspace).len(), 1, "nothing new was launched");
    assert!(is_live(first.pid));
    assert!(record["pid"].as_u64().is_some() && record["pid"].as_u64().unwrap() == u64::from(first.pid), "{record}");

    stop_fixtures(&case.workspace, &[first.pid]);
}

// ---------------------------------------------------------------------------------------------
// H2: creation, stdout closed right after the session (process alive)
// ---------------------------------------------------------------------------------------------
#[test]
fn h2_creation_stream_closed_after_session_degrades_the_registration() {
    let _lock = lock();
    assert_env_pinned();
    let Some(python) = resolve_python() else {
        eprintln!("SKIP h2: no python interpreter resolved");
        return;
    };
    let server = CoreServer::new(Store::memory().unwrap());
    let case = case_project(&server, "h2", "stdout_closed_after_thread_start");
    write_python_loader(&case.workspace);
    seed_core_epoch(server.processor().store(), &case.workspace, "h2-nonce");
    let attempt = default_attempt(&case.task, "codex");

    let admitted = select_codex(&server, "h2-select", &case, Some(&python));
    assert_eq!(admitted["ok"], true, "the session is established before the stream closes: {admitted}");
    let first = new_instance(&case.workspace, &[]);
    assert_eq!(server.processor().store().get_attempt(&attempt).unwrap().state, AttemptState::Active);

    // The closure reaches the store through the real consumption path (snapshot -> flush_runtime_events).
    let started = Instant::now();
    loop {
        let _ = snapshot(&server, &format!("h2-poll-{}", started.elapsed().as_millis()));
        let closed = transport_of(&events(&server, &attempt), "runtime.transport.closed").cloned();
        if let Some(record) = closed {
            assert_eq!(record["reason"], "eof", "{record}");
            assert_eq!(record["turnFailed"], false, "{record}");
            assert_eq!(record["kept"], true, "{record}");
            assert_eq!(record["killed"], false, "{record}");
            break;
        }
        assert!(started.elapsed() < Duration::from_secs(10), "the closed transport must be recorded through the snapshot drain");
        std::thread::sleep(Duration::from_millis(100));
    }

    let sent = call(&server, "h2-send", "send_message", json!({ "attemptId": attempt, "campaignId": case.campaign, "message": "after close" }));
    assert_eq!(sent["ok"], false, "a closed-transport registration refuses the send: {sent}");
    assert!(error_of(&sent).contains("output stream is closed") && error_of(&sent).contains("not sent"), "{sent}");
    let after_send = events(&server, &attempt);
    let failed: Vec<&Value> = records_of(&after_send, "runtime.send.failed");
    assert_eq!(failed.len(), 1, "exactly one send.failed: {after_send:?}");
    assert_eq!(failed[0]["retry"], false, "{}", failed[0]);
    assert_eq!(failed[0]["deliveryState"], "FAILED", "{}", failed[0]);
    assert_eq!(records_of(&after_send, "message.user").len(), 1, "the user input is recorded once");
    assert_eq!(turns(&case.workspace, first.pid), 0, "nothing was sent to the fixture");

    let again = error_of(&select_codex(&server, "h2-again", &case, Some(&python)));
    assert!(again.contains("output stream is closed"), "the reuse refusal names the closed stream: {again}");
    assert!(is_live(first.pid), "the process is never killed");
    assert_eq!(instances(&case.workspace).len(), 1);

    stop_fixtures(&case.workspace, &[first.pid]);
}

// ---------------------------------------------------------------------------------------------
// H3a: resume, stdout closed BEFORE the resume answer (deterministic boundary-(1), process alive)
// ---------------------------------------------------------------------------------------------
#[test]
fn h3a_resume_stream_closed_before_answer_is_unsupported_and_recorded() {
    let _lock = lock();
    assert_env_pinned();
    let Some(python) = resolve_python() else {
        eprintln!("SKIP h3a: no python interpreter resolved");
        return;
    };
    let (case, r) = restart_after_kept_failure_python("h3a", "stdout_closed_before_resume", &python);
    let server = &r.server;

    r.appdata.assert_armed();
    let resumed = call(server, "h3a-resume", "resume_native_session", json!({ "attemptId": r.attempt }));
    let second = new_instance(&case.workspace, &[r.first.clone()]);
    r.appdata.assert_synthetic(&second);
    assert_eq!(resumed["ok"], true, "the command records the failure and returns ok: {resumed}");
    let after = events(server, &r.attempt);
    let resumed_rec = records_of(&after, "runtime.session.resumed").into_iter().next_back().cloned().expect("a resumed record");
    assert_eq!(resumed_rec["resumed"], false, "{resumed_rec}");
    assert_eq!(resumed_rec["transport"], "eof", "the resumed-false record names the observed closure: {resumed_rec}");
    assert!(records_of(&after, ESTABLISHED_KIND).is_empty(), "a failed resume writes no established record");
    assert!(records_of(&after, "runtime.transport.closed").is_empty(), "a pre-establishment closure writes no separate transport record");

    r.appdata.assert_armed();
    let again = error_of(&select_codex(server, "h3a-again", &case, None));
    assert!(again.contains(NOT_RECORDED) && again.contains(NOT_RETRIED), "no established record: {again}");
    assert_eq!(kept_record(server, &r.attempt), r.kept_before, "old records are never rewritten");
    assert!(is_live(second.pid));
    assert!(r.began.elapsed() < WATCHDOG);

    stop_fixtures(&case.workspace, &[r.first.pid, second.pid]);
}

// ---------------------------------------------------------------------------------------------
// H3b: resume, stdout closed right AFTER the answer (established, then degraded; process alive)
// ---------------------------------------------------------------------------------------------
#[test]
fn h3b_resume_stream_closed_after_answer_degrades_the_registration() {
    let _lock = lock();
    assert_env_pinned();
    let Some(python) = resolve_python() else {
        eprintln!("SKIP h3b: no python interpreter resolved");
        return;
    };
    let (case, r) = restart_after_kept_failure_python("h3b", "stdout_closed_after_resume", &python);
    let server = &r.server;

    r.appdata.assert_armed();
    let resumed = call(server, "h3b-resume", "resume_native_session", json!({ "attemptId": r.attempt }));
    let second = new_instance(&case.workspace, &[r.first.clone()]);
    r.appdata.assert_synthetic(&second);
    assert_eq!(resumed["ok"], true, "{resumed}");
    let after_resume = events(server, &r.attempt);
    assert_eq!(records_of(&after_resume, ESTABLISHED_KIND).len(), 1, "resume established the registration: {after_resume:?}");

    let started = Instant::now();
    loop {
        let _ = snapshot(server, &format!("h3b-poll-{}", started.elapsed().as_millis()));
        if transport_of(&events(server, &r.attempt), "runtime.transport.closed").is_some() {
            break;
        }
        assert!(started.elapsed() < Duration::from_secs(10), "the closed transport must be recorded");
        std::thread::sleep(Duration::from_millis(100));
    }
    assert_eq!(records_of(&events(server, &r.attempt), ESTABLISHED_KIND).len(), 1, "the established record is never deleted");

    let project = call(server, "h3b-project", "select_project", json!({ "projectId": case.project }));
    assert_eq!(project["ok"], true, "{project}");
    assert_eq!(selected_attempt(server, "h3b-snapshot"), r.attempt);
    let sent = call(server, "h3b-send", "send_message", json!({ "attemptId": r.attempt, "campaignId": case.campaign, "message": "after close" }));
    assert_eq!(sent["ok"], false, "the send is refused on the closed transport: {sent}");
    assert!(error_of(&sent).contains("output stream is closed"), "{sent}");
    let after_send = events(server, &r.attempt);
    assert!(records_of(&after_send, "runtime.reply.delta").is_empty(), "no reply is delivered");
    assert_eq!(turns(&case.workspace, second.pid), 0, "nothing was sent to fixture 2");

    r.appdata.assert_armed();
    let again = error_of(&select_codex(server, "h3b-again", &case, None));
    assert!(again.contains("output stream is closed"), "{again}");
    assert_eq!(kept_record(server, &r.attempt), r.kept_before);
    assert!(is_live(second.pid));
    assert!(r.began.elapsed() < WATCHDOG);

    stop_fixtures(&case.workspace, &[r.first.pid, second.pid]);
}

// ---------------------------------------------------------------------------------------------
// H4: resume, an oversized frame arrives with a turn in flight (degrade, terminal, no re-send)
// ---------------------------------------------------------------------------------------------
#[test]
fn h4_resume_oversized_frame_fails_the_turn_and_degrades() {
    let _lock = lock();
    assert_env_pinned();
    let Some(python) = resolve_python() else {
        eprintln!("SKIP h4: no python interpreter resolved");
        return;
    };
    let (case, r) = restart_after_kept_failure_python("h4", "oversized_after_turn_start", &python);
    let server = &r.server;

    r.appdata.assert_armed();
    let resumed = call(server, "h4-resume", "resume_native_session", json!({ "attemptId": r.attempt }));
    let second = new_instance(&case.workspace, &[r.first.clone()]);
    r.appdata.assert_synthetic(&second);
    assert_eq!(resumed["ok"], true, "{resumed}");

    let project = call(server, "h4-project", "select_project", json!({ "projectId": case.project }));
    assert_eq!(project["ok"], true, "{project}");
    assert_eq!(selected_attempt(server, "h4-snapshot"), r.attempt);
    let marker = format!("h4-input-{}", second.pid);
    let sent = call(server, "h4-send", "send_message", json!({ "attemptId": r.attempt, "campaignId": case.campaign, "message": marker }));
    assert_eq!(sent["ok"], true, "the send is accepted before the oversized frame is read: {sent}");

    let started = Instant::now();
    loop {
        let _ = snapshot(server, &format!("h4-poll-{}", started.elapsed().as_millis()));
        let all = events(server, &r.attempt);
        if let Some(failed) = records_of(&all, "runtime.turn.failed").into_iter().next_back() {
            assert!(failed["text"].as_str().unwrap_or_default().contains("oversized-frame"), "{failed}");
            let closed = transport_of(&all, "runtime.transport.closed").cloned().expect("a transport record");
            assert_eq!(closed["reason"], "oversized-frame", "{closed}");
            assert_eq!(closed["turnFailed"], true, "{closed}");
            break;
        }
        assert!(started.elapsed() < Duration::from_secs(10), "the oversized frame must fail the turn, not break silently");
        std::thread::sleep(Duration::from_millis(100));
    }
    let all = events(server, &r.attempt);
    assert!(records_of(&all, "runtime.reply.delta").iter().all(|d| !d["text"].as_str().unwrap_or_default().contains(&marker)), "no reply carries the marker");
    assert!(records_of(&all, "runtime.turn.completed").is_empty(), "the turn did not complete");
    assert_eq!(server.processor().store().get_attempt(&r.attempt).unwrap().state, AttemptState::Failed, "the turn failure is terminal");
    assert_eq!(turns(&case.workspace, second.pid), 1, "the input was sent once and never re-sent");
    assert!(is_live(second.pid));
    assert_eq!(kept_record(server, &r.attempt), r.kept_before);
    assert!(r.began.elapsed() < WATCHDOG);

    stop_fixtures(&case.workspace, &[r.first.pid, second.pid]);
}

// ---------------------------------------------------------------------------------------------
// M2: transport_state query
// ---------------------------------------------------------------------------------------------
#[test]
fn m2_transport_state_reports_registration_state() {
    let _lock = lock();
    assert_env_pinned();
    let directory = tempfile::tempdir().unwrap();
    let workspace = directory.path().join("ws");
    fs::create_dir_all(&workspace).unwrap();
    let mut manager = RuntimeManager::new();
    assert!(manager.transport_state("nobody").is_none(), "unregistered has no transport state");
    manager.select_runtime("codex-attempt", "codex", Some(PathBuf::from(r"C:\nonexistent\codex.exe")), "0.0.0", &workspace).unwrap();
    assert!(matches!(manager.transport_state("codex-attempt"), Some(TransportState::NotStarted)), "a registered, never-started codex is NotStarted");
    manager.select_runtime("scenario-attempt", "scenario", None, "v", &workspace).unwrap();
    assert!(matches!(manager.transport_state("scenario-attempt"), Some(TransportState::NotApplicable)), "a scenario adapter is NotApplicable");
}

// ---------------------------------------------------------------------------------------------
// M3: the adapter's own refusal on a closed transport (process alive)
// ---------------------------------------------------------------------------------------------
#[test]
fn m3_adapter_refuses_send_on_closed_transport_without_exit() {
    let _lock = lock();
    assert_env_pinned();
    let Some(python) = resolve_python() else {
        eprintln!("SKIP m3: no python interpreter resolved");
        return;
    };
    let workspace = scratch_root().join(format!("i6-m3-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
    fs::create_dir_all(&workspace).unwrap();
    fs::write(workspace.join(".fake-codex-scenario"), "stdout_closed_after_thread_start").unwrap();
    write_python_loader(&workspace);
    let mut manager = RuntimeManager::new();
    let attempt = "m3-attempt";
    manager.select_runtime(attempt, "codex", Some(python.clone()), "0.152.0", &workspace).unwrap();
    manager
        .create_session(
            attempt,
            &SessionRequest {
                campaign_id: Some("c".into()),
                task_id: "t".into(),
                attempt_id: attempt.into(),
                workspace_root: workspace.clone(),
                resume_session: None,
            },
        )
        .expect("create_session succeeds before the stream closes");
    let first = new_instance(&workspace, &[]);

    let started = Instant::now();
    loop {
        let _ = manager.poll_events(attempt);
        if matches!(manager.transport_state(attempt), Some(TransportState::Closed { .. })) {
            break;
        }
        assert!(started.elapsed() < Duration::from_secs(10), "the reader must observe the closure");
        std::thread::sleep(Duration::from_millis(100));
    }
    assert_eq!(manager.registration_live(attempt), Some(false), "a closed transport is not live even with a running child");
    assert!(is_live(first.pid), "the child is still running");
    assert!(matches!(manager.confirm_process_identity(attempt), Some(ProcessConfirmation::Confirmed { .. })), "a closed stream is not an exit");
    let send = manager.send_prompt(attempt, &PromptRequest { attempt_id: attempt.into(), text: "x".into(), idempotency_key: "m3-1".into() });
    assert!(send.is_err(), "the adapter refuses the send on a closed transport");
    assert!(send.unwrap_err().to_string().contains("not sent"), "the input is not sent");

    stop_fixtures(&workspace, &[first.pid]);
}

// ---------------------------------------------------------------------------------------------
// M4 (critic round 2): Core dropping its OWN side of the transport is a known-unusable transport.
// `close_adapter_transport` discards the event receiver, so this Core can never read another event
// from the registration however healthy the provider is. The registration must stop reporting
// usable - without the child being touched, and without the drop being mistaken for a process exit.
// ---------------------------------------------------------------------------------------------
#[test]
fn m4_core_dropping_its_transport_degrades_without_killing() {
    let _lock = lock();
    assert_env_pinned();
    let Some(python) = resolve_python() else {
        eprintln!("SKIP m4: no python interpreter resolved");
        return;
    };
    let workspace = scratch_root().join(format!(
        "i6-m4-{}",
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    ));
    fs::create_dir_all(&workspace).unwrap();
    fs::write(workspace.join(".fake-codex-scenario"), "linger").unwrap();
    write_python_loader(&workspace);
    let mut manager = RuntimeManager::new();
    let attempt = "m4-attempt";
    manager
        .select_runtime(attempt, "codex", Some(python.clone()), "0.152.0", &workspace)
        .unwrap();
    manager
        .create_session(
            attempt,
            &SessionRequest {
                campaign_id: Some("c".into()),
                task_id: "t".into(),
                attempt_id: attempt.into(),
                workspace_root: workspace.clone(),
                resume_session: None,
            },
        )
        .expect("the session is established against a healthy fixture");
    let first = new_instance(&workspace, &[]);
    assert!(matches!(manager.transport_state(attempt), Some(TransportState::Open)), "open before the drop");
    assert_eq!(manager.registration_live(attempt), Some(true), "usable before the drop");

    // The product path `close_adapter_transport` takes: Core drops its own pipes, keeps the child.
    manager.drop_adapter_transport(attempt).expect("Core drops its own side of the transport");

    match manager.transport_state(attempt) {
        Some(TransportState::Closed { reason }) => {
            assert_eq!(reason, "transport-dropped", "the reason distinguishes Core's own drop from a provider close");
        }
        other => panic!("a dropped transport must read Closed, got {other:?}"),
    }
    assert_eq!(
        manager.registration_live(attempt),
        Some(false),
        "Core discarded the only receiver, so the registration is not usable even though the child runs"
    );
    assert!(is_live(first.pid), "dropping Core's pipes never touches the child");
    assert!(
        matches!(manager.confirm_process_identity(attempt), Some(ProcessConfirmation::Confirmed { .. })),
        "a dropped transport is not a process exit"
    );
    let send = manager.send_prompt(
        attempt,
        &PromptRequest { attempt_id: attempt.into(), text: "x".into(), idempotency_key: "m4-1".into() },
    );
    assert!(send.is_err(), "the adapter refuses a send once Core dropped the transport");
    assert!(send.unwrap_err().to_string().contains("not sent"), "the input is not sent");

    stop_fixtures(&workspace, &[first.pid]);
}

// =================================================================================================
// Increment 7: a repeated `send_message` returns the command's RECORDED result (owner ruling 1 and
// the 2026-09-10 re-ruling). Two axes are reported from the command row — the command state and the
// recorded delivery state — and neither is re-derived from the current environment. Every case
// drives `CoreServer::handle_json` (the connected-UI entry the product uses). Cases R3–R7 and R9
// build their pre-state through the PUBLIC store API and are LABELLED constructed; R1/R1b/R8 are
// hermetic scenario-provider cases; R1py/R2 use the increment-6 python scaffold (adapter-level
// delivery witness `turns(pid)`), skipping with a marker when no interpreter resolves. Every case
// writes a positive execution marker under the scratch root so a skip can never read as a pass.
// =================================================================================================

const NOT_SENT_AGAIN: &str = "it was not sent again";

fn i7_marker(case: &str, note: &str) {
    let dir = scratch_root().join("i7-markers");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join(format!("{case}.txt")), format!("{case}: {note}\n")).unwrap();
}

fn select_scenario(server: &CoreServer, id: &str, case: &Case) -> String {
    let selected = call(
        server,
        id,
        "select_runtime",
        json!({ "projectId": case.project, "campaignId": case.campaign, "taskId": case.task, "provider": "scenario" }),
    );
    assert_eq!(selected["ok"], true, "scenario admission must succeed: {selected}");
    let attempt = selected["payload"]["snapshot"]["attempt"]["id"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    assert_eq!(attempt, default_attempt(&case.task, "scenario"));
    attempt
}

fn send(server: &CoreServer, id: &str, case: &Case, attempt: &str, message: &str) -> Value {
    call(
        server,
        id,
        "send_message",
        json!({ "attemptId": attempt, "campaignId": case.campaign, "message": message }),
    )
}

/// Drain the Runtime event queue through the real consumption path (snapshot -> flush).
fn drain(server: &CoreServer, label: &str) {
    for i in 0..3 {
        let _ = snapshot(server, &format!("{label}-drain-{i}"));
    }
}

fn user_messages(events: &[(String, Option<Value>)]) -> usize {
    records_of(events, "message.user").len()
}

/// The refusal a replayed non-success request must carry: both tokens, the clause, the closing
/// statement — and no `duplicate` flag, which rides the `Ok` path only.
fn assert_replay_refusal(response: &Value, request_id: &str, state: &str, delivery: &str, clause: &str) {
    let error = error_of(response);
    assert!(error.starts_with(&format!("replayed request {request_id} ")), "{error}");
    assert!(error.contains(&format!("[state={state}]")), "state token: {error}");
    assert!(error.contains(&format!("[delivery={delivery}]")), "delivery token: {error}");
    assert!(error.contains(clause), "clause {clause:?}: {error}");
    assert!(error.ends_with(NOT_SENT_AGAIN), "{error}");
    assert!(response["payload"].get("duplicate").is_none(), "no duplicate flag on a refusal: {response}");
}

/// LABELLED CONSTRUCTED: the row `send_message` would record for (request, attempt, message),
/// driven through the public store API along the permitted chain from Pending. `finish` records a
/// terminal state WITH a result; `chain` records states WITHOUT one (`update_command_state`).
fn constructed_row(
    server: &CoreServer,
    request_id: &str,
    attempt: &str,
    message: &str,
    chain: &[CommandState],
    finish: Option<(CommandState, Value)>,
) -> String {
    let command = send_message_command(request_id, attempt, message).unwrap();
    let store = server.processor().store();
    let recorded = store.record_command(&command.command).unwrap();
    assert_eq!(recorded.state, CommandState::Pending, "constructed rows start Pending");
    for state in chain {
        store.update_command_state(&command.command.id, *state).unwrap();
    }
    if let Some((state, result)) = finish {
        store.finish_command(&command.command.id, state, &result).unwrap();
    }
    command.command.id
}

// ---------------------------------------------------------------------------------------------
// R1: a succeeded send replays as the duplicate success and delivers nothing (control)
// ---------------------------------------------------------------------------------------------
#[test]
fn r1_succeeded_send_replays_as_duplicate_success_without_delivery() {
    let server = CoreServer::new(Store::memory().unwrap());
    let case = case_project(&server, "r1", "linger");
    let attempt = select_scenario(&server, "r1-select", &case);
    let first = send(&server, "r1-send", &case, &attempt, "first input");
    assert_eq!(first["ok"], true, "{first}");
    assert_eq!(first["payload"]["duplicate"], false, "{first}");
    drain(&server, "r1");
    let baseline = events(&server, &attempt);
    assert_eq!(user_messages(&baseline), 1);
    assert!(baseline.len() > 1, "the scenario Runtime replied to the first send: {baseline:?}");

    let again = send(&server, "r1-send", &case, &attempt, "first input");
    assert_eq!(again["ok"], true, "{again}");
    assert_eq!(again["payload"]["duplicate"], true, "{again}");
    drain(&server, "r1-after");
    assert_eq!(events(&server, &attempt), baseline, "a replay writes nothing and delivers nothing");
    // The success path records the delivery it observed (the adapter reported the input accepted).
    let row_id = send_message_command("r1-send", &attempt, "first input").unwrap().command.id;
    let store = server.processor().store();
    assert_eq!(store.get_command(&row_id).unwrap().state, CommandState::Succeeded);
    let recorded = store.command_result(&row_id).unwrap().expect("the success row carries its result");
    assert_eq!(recorded["deliveryState"], "DELIVERED", "{recorded}");
    assert_eq!(recorded["requestId"], "r1-send", "{recorded}");
    i7_marker("r1", "completed");
}

// ---------------------------------------------------------------------------------------------
// R1b: the recorded success is NOT flipped by the current environment (attempt now terminal)
// ---------------------------------------------------------------------------------------------
#[test]
fn r1b_succeeded_send_still_replays_as_success_after_the_attempt_became_terminal() {
    let server = CoreServer::new(Store::memory().unwrap());
    let case = case_project(&server, "r1b", "linger");
    let attempt = select_scenario(&server, "r1b-select", &case);
    assert_eq!(send(&server, "r1b-send", &case, &attempt, "first input")["ok"], true);
    drain(&server, "r1b");
    let cancelled = call(&server, "r1b-cancel", "cancel", json!({ "attemptId": attempt }));
    assert_eq!(cancelled["ok"], true, "{cancelled}");
    let row = server.processor().store().get_attempt(&attempt).unwrap();
    assert!(row.state.is_terminal(), "the hostile step made the attempt terminal: {:?}", row.state);
    drain(&server, "r1b-hostile");
    let baseline = events(&server, &attempt);

    let again = send(&server, "r1b-send", &case, &attempt, "first input");
    assert_eq!(again["ok"], true, "a recorded success is reported, not the terminality refusal: {again}");
    assert_eq!(again["payload"]["duplicate"], true, "{again}");
    drain(&server, "r1b-after");
    let after = events(&server, &attempt);
    assert_eq!(after, baseline, "nothing delivered, nothing written");
    assert_eq!(user_messages(&after), 1);
    i7_marker("r1b", "completed");
}

// ---------------------------------------------------------------------------------------------
// R1py: adapter-level delivery witness — the fixture's turn counter does not move on a replay
// ---------------------------------------------------------------------------------------------
#[test]
fn r1py_replay_of_a_delivered_send_adds_no_fixture_turn() {
    let _lock = lock();
    assert_env_pinned();
    let Some(python) = resolve_python() else {
        i7_marker("r1py", "SKIPPED: no python interpreter resolved");
        eprintln!("SKIP r1py: no python interpreter resolved");
        return;
    };
    let server = CoreServer::new(Store::memory().unwrap());
    let case = case_project(&server, "r1py", "linger");
    write_python_loader(&case.workspace);
    seed_core_epoch(server.processor().store(), &case.workspace, "r1py-nonce");
    let attempt = default_attempt(&case.task, "codex");
    let admitted = select_codex(&server, "r1py-select", &case, Some(&python));
    assert_eq!(admitted["ok"], true, "{admitted}");
    let first = new_instance(&case.workspace, &[]);

    let sent = send(&server, "r1py-send", &case, &attempt, "deliver once");
    assert_eq!(sent["ok"], true, "{sent}");
    let turns_file = case.workspace.join(format!(".fake-codex-turns.{}.json", first.pid));
    assert!(wait_for(&turns_file, Duration::from_secs(10)), "the fixture recorded the turn");
    assert_eq!(turns(&case.workspace, first.pid), 1, "exactly one turn delivered");
    drain(&server, "r1py");
    let baseline = events(&server, &attempt);

    let again = send(&server, "r1py-send", &case, &attempt, "deliver once");
    assert_eq!(again["ok"], true, "{again}");
    assert_eq!(again["payload"]["duplicate"], true, "{again}");
    std::thread::sleep(Duration::from_millis(400));
    assert_eq!(turns(&case.workspace, first.pid), 1, "the replay added no turn");
    drain(&server, "r1py-after");
    assert_eq!(events(&server, &attempt), baseline);
    stop_fixtures(&case.workspace, &[first.pid]);
    i7_marker("r1py", "completed");
}

// ---------------------------------------------------------------------------------------------
// R2: a send refused on a closed transport replays as THAT failure — real path, real record
// ---------------------------------------------------------------------------------------------
#[test]
fn r2_failed_send_on_closed_transport_replays_as_the_recorded_failure() {
    let _lock = lock();
    assert_env_pinned();
    let Some(python) = resolve_python() else {
        i7_marker("r2", "SKIPPED: no python interpreter resolved");
        eprintln!("SKIP r2: no python interpreter resolved");
        return;
    };
    let server = CoreServer::new(Store::memory().unwrap());
    let case = case_project(&server, "r2", "stdout_closed_after_thread_start");
    write_python_loader(&case.workspace);
    seed_core_epoch(server.processor().store(), &case.workspace, "r2-nonce");
    let attempt = default_attempt(&case.task, "codex");
    let admitted = select_codex(&server, "r2-select", &case, Some(&python));
    assert_eq!(admitted["ok"], true, "{admitted}");
    let first = new_instance(&case.workspace, &[]);
    let started = Instant::now();
    loop {
        let _ = snapshot(&server, &format!("r2-poll-{}", started.elapsed().as_millis()));
        if transport_of(&events(&server, &attempt), "runtime.transport.closed").is_some() {
            break;
        }
        assert!(started.elapsed() < Duration::from_secs(10), "the closed transport must be recorded");
        std::thread::sleep(Duration::from_millis(100));
    }

    let sent = send(&server, "r2-send", &case, &attempt, "after close");
    let first_error = error_of(&sent);
    assert!(first_error.contains("output stream is closed"), "{first_error}");
    drain(&server, "r2");
    let baseline = events(&server, &attempt);
    assert_eq!(records_of(&baseline, "runtime.send.failed").len(), 1);
    assert_eq!(turns(&case.workspace, first.pid), 0);

    let again = send(&server, "r2-send", &case, &attempt, "after close");
    assert_replay_refusal(&again, "r2-send", "FAILED", "FAILED", "output stream is closed");
    drain(&server, "r2-after");
    let after = events(&server, &attempt);
    assert_eq!(after, baseline, "the replay wrote no event");
    assert_eq!(records_of(&after, "runtime.send.failed").len(), 1, "no second failure record");
    assert_eq!(turns(&case.workspace, first.pid), 0, "nothing delivered");
    assert!(is_live(first.pid), "the process is never killed");
    stop_fixtures(&case.workspace, &[first.pid]);
    i7_marker("r2", "completed");
}

// ---------------------------------------------------------------------------------------------
// R3: an UNKNOWN command with no result is reported unknown on both axes (constructed)
// ---------------------------------------------------------------------------------------------
#[test]
fn r3_unknown_command_without_result_replays_as_unknown_not_failed() {
    let server = CoreServer::new(Store::memory().unwrap());
    let case = case_project(&server, "r3", "linger");
    let attempt = select_scenario(&server, "r3-select", &case);
    constructed_row(&server, "r3-send", &attempt, "uncertain", &[CommandState::Executing, CommandState::Unknown], None);
    let baseline = events(&server, &attempt);

    let again = send(&server, "r3-send", &case, &attempt, "uncertain");
    assert_replay_refusal(&again, "r3-send", "UNKNOWN", "UNKNOWN", "reason not recorded");
    assert!(!error_of(&again).contains("[state=FAILED]"));
    drain(&server, "r3-after");
    assert_eq!(events(&server, &attempt), baseline);
    i7_marker("r3", "completed (constructed row)");
}

// ---------------------------------------------------------------------------------------------
// R4: an EXECUTING row is answered "in progress" and, above all, never delivered again
// ---------------------------------------------------------------------------------------------
#[test]
fn r4_executing_command_replays_as_in_progress_and_is_not_delivered_again() {
    let server = CoreServer::new(Store::memory().unwrap());
    let case = case_project(&server, "r4", "linger");
    let attempt = select_scenario(&server, "r4-select", &case);
    constructed_row(&server, "r4-send", &attempt, "in flight", &[CommandState::Executing], None);
    let baseline = events(&server, &attempt);
    assert_eq!(user_messages(&baseline), 0);

    let again = send(&server, "r4-send", &case, &attempt, "in flight");
    drain(&server, "r4-after");
    // The delivery assertion comes FIRST: with the early answer deleted this replay reaches the
    // delivery closure (Executing -> Executing is written without a transition check), and the
    // attributable red is the `message.user` it appends.
    let after = events(&server, &attempt);
    assert_eq!(user_messages(&after), 0, "the replay must not deliver (message.user appended): {after:?}");
    assert_eq!(after, baseline);
    assert_replay_refusal(&again, "r4-send", "EXECUTING", "UNKNOWN", "still in progress");
    assert!(!error_of(&again).contains("[state=FAILED]") && !error_of(&again).contains("[state=UNKNOWN]"));
    i7_marker("r4", "completed (constructed row)");
}

// ---------------------------------------------------------------------------------------------
// R5: a FAILED row with no result is still a failure — reason and delivery honestly unknown
// ---------------------------------------------------------------------------------------------
#[test]
fn r5_failed_command_without_result_replays_as_failure_with_unknown_delivery() {
    let server = CoreServer::new(Store::memory().unwrap());
    let case = case_project(&server, "r5", "linger");
    let attempt = select_scenario(&server, "r5-select", &case);
    constructed_row(&server, "r5-send", &attempt, "lost reason", &[CommandState::Executing, CommandState::Failed], None);
    let baseline = events(&server, &attempt);

    let again = send(&server, "r5-send", &case, &attempt, "lost reason");
    assert_replay_refusal(&again, "r5-send", "FAILED", "UNKNOWN", "reason not recorded");
    drain(&server, "r5-after");
    let after = events(&server, &attempt);
    assert_eq!(user_messages(&after), 0, "no message.user appended by the replay");
    assert_eq!(after, baseline);
    i7_marker("r5", "completed (constructed row)");
}

// ---------------------------------------------------------------------------------------------
// R6: FAILED with delivery UNKNOWN is never reported as a confirmed non-delivery
// ---------------------------------------------------------------------------------------------
#[test]
fn r6_failed_command_with_unknown_delivery_replays_with_unknown_delivery() {
    let server = CoreServer::new(Store::memory().unwrap());
    let case = case_project(&server, "r6", "linger");
    let attempt = select_scenario(&server, "r6-select", &case);
    constructed_row(
        &server,
        "r6-send",
        &attempt,
        "maybe written",
        &[CommandState::Executing],
        Some((CommandState::Failed, json!({ "requestId": "r6-send", "deliveryState": "UNKNOWN", "error": "write failed; delivery unknown" }))),
    );
    let baseline = events(&server, &attempt);

    let again = send(&server, "r6-send", &case, &attempt, "maybe written");
    assert_replay_refusal(&again, "r6-send", "FAILED", "UNKNOWN", "write failed; delivery unknown");
    assert!(!error_of(&again).contains("[delivery=FAILED]"), "{again}");
    drain(&server, "r6-after");
    assert_eq!(events(&server, &attempt), baseline);
    i7_marker("r6", "completed (constructed row)");
}

// ---------------------------------------------------------------------------------------------
// R7: a command that failed AFTER the Runtime accepted the input says so
// ---------------------------------------------------------------------------------------------
#[test]
fn r7_failed_command_after_delivery_replays_as_failed_but_delivered() {
    let server = CoreServer::new(Store::memory().unwrap());
    let case = case_project(&server, "r7", "linger");
    let attempt = select_scenario(&server, "r7-select", &case);
    constructed_row(
        &server,
        "r7-send",
        &attempt,
        "delivered then failed",
        &[CommandState::Executing],
        Some((CommandState::Failed, json!({ "requestId": "r7-send", "deliveryState": "DELIVERED", "error": "recovery persistence failed" }))),
    );
    let baseline = events(&server, &attempt);

    let again = send(&server, "r7-send", &case, &attempt, "delivered then failed");
    assert_replay_refusal(&again, "r7-send", "FAILED", "DELIVERED", "recovery persistence failed");
    drain(&server, "r7-after");
    assert_eq!(events(&server, &attempt), baseline);
    i7_marker("r7", "completed (constructed row)");
}

// ---------------------------------------------------------------------------------------------
// R8: identity is content-bound — the same id with a different message is a conflict (control)
// ---------------------------------------------------------------------------------------------
#[test]
fn r8_same_request_id_with_different_content_is_a_conflict_not_a_replay() {
    let server = CoreServer::new(Store::memory().unwrap());
    let case = case_project(&server, "r8", "linger");
    let attempt = select_scenario(&server, "r8-select", &case);
    assert_eq!(send(&server, "r8-send", &case, &attempt, "first")["ok"], true);
    drain(&server, "r8");
    let baseline = events(&server, &attempt);

    let conflict = send(&server, "r8-send", &case, &attempt, "changed");
    let error = error_of(&conflict);
    assert!(error.contains("different content"), "{error}");
    assert!(!error.starts_with("replayed request"), "a conflict is not answered as a replay: {error}");
    drain(&server, "r8-after");
    assert_eq!(events(&server, &attempt), baseline, "nothing delivered for the conflicting content");
    i7_marker("r8", "completed");
}

// ---------------------------------------------------------------------------------------------
// R9: the answer survives a Core restart — it comes from the persisted row, not process memory
// ---------------------------------------------------------------------------------------------
#[test]
fn r9_recorded_results_answer_replays_across_a_core_restart() {
    let store = Store::memory().unwrap();
    let server1 = CoreServer::new(store.clone());
    let case = case_project(&server1, "r9", "linger");
    let attempt = select_scenario(&server1, "r9-select", &case);
    constructed_row(
        &server1,
        "r9-failed",
        &attempt,
        "before restart",
        &[CommandState::Executing],
        Some((CommandState::Failed, json!({ "requestId": "r9-failed", "deliveryState": "UNKNOWN", "error": "write failed; delivery unknown" }))),
    );
    constructed_row(&server1, "r9-executing", &attempt, "mid flight", &[CommandState::Executing], None);
    drop(server1);

    let server2 = CoreServer::new(store.clone());
    let reconciled = server2.processor().reconcile_after_restart().unwrap();
    assert_eq!(reconciled, 1, "the executing row is marked UNKNOWN by the restart reconcile");
    // A fresh UiController starts with no selection. Restore it the way increment 5's g4 does
    // after a restart: select_project clears the selection and the snapshot selects the case
    // task's latest attempt. (select_runtime would be refused here: an Active row with no
    // registration and no recovery row hits insert_attempt's IdempotencyConflict.) Asserted
    // before replaying, so a selection-gate refusal can never masquerade as this case's outcome.
    let project = call(&server2, "r9-project", "select_project", json!({ "projectId": case.project }));
    assert_eq!(project["ok"], true, "{project}");
    assert_eq!(selected_attempt(&server2, "r9-snapshot"), attempt, "the snapshot selects the case attempt");
    drain(&server2, "r9-reselect");
    let baseline = events(&server2, &attempt);

    let failed = send(&server2, "r9-failed", &case, &attempt, "before restart");
    assert_replay_refusal(&failed, "r9-failed", "FAILED", "UNKNOWN", "write failed; delivery unknown");
    let interrupted = send(&server2, "r9-executing", &case, &attempt, "mid flight");
    assert_replay_refusal(&interrupted, "r9-executing", "UNKNOWN", "UNKNOWN", "reason not recorded");
    drain(&server2, "r9-after");
    let after = events(&server2, &attempt);
    assert_eq!(user_messages(&after), 0, "no delivery after the restart");
    assert_eq!(after, baseline);
    i7_marker("r9", "completed (constructed rows, real restart reconcile)");
}

// ---------------------------------------------------------------------------------------------
// R10: the second product caller (handoff) — a repeated handoff is refused BEFORE its derived send
// could ever be answered as a replay, and nothing is delivered again
// ---------------------------------------------------------------------------------------------
#[test]
fn r10_repeated_handoff_is_refused_before_its_derived_send_and_delivers_nothing() {
    let server = CoreServer::new(Store::memory().unwrap());
    let case = case_project(&server, "r10", "linger");
    let old_attempt = select_scenario(&server, "r10-select", &case);
    assert_eq!(send(&server, "r10-send", &case, &old_attempt, "before handoff")["ok"], true);
    drain(&server, "r10");
    let handoff_payload = json!({
        "oldAttemptId": old_attempt,
        "campaignId": case.campaign,
        "taskId": case.task,
        "provider": "scenario",
        "handoffInstruction": "continue from the packet"
    });
    let first = call(&server, "r10-handoff", "handoff", handoff_payload.clone());
    assert_eq!(first["ok"], true, "{first}");
    let new_attempt = first["payload"]["snapshot"]["attempt"]["id"].as_str().unwrap_or_default().to_string();
    assert!(new_attempt.starts_with("attempt-handoff-"), "{new_attempt}");
    drain(&server, "r10-first");
    let old_baseline = events(&server, &old_attempt);
    let new_baseline = events(&server, &new_attempt);
    assert_eq!(user_messages(&new_baseline), 1, "the derived instruction was sent once: {new_baseline:?}");

    let again = call(&server, "r10-handoff", "handoff", handoff_payload);
    let error = error_of(&again);
    assert!(!error.starts_with("replayed request"), "the repeat is refused before its derived send: {error}");
    drain(&server, "r10-again");
    assert_eq!(events(&server, &old_attempt), old_baseline);
    let new_after = events(&server, &new_attempt);
    assert_eq!(user_messages(&new_after), 1, "nothing delivered again");
    assert_eq!(new_after, new_baseline);
    i7_marker("r10", &format!("completed; repeat refused with: {error}"));
}

// ---------------------------------------------------------------------------------------------
// R11: a REAL refusal through the Codex exec transport — the Runtime did not accept the input
// (one of the failure points that recorded nothing before this increment) — replays as that
// failure, and the replay runs no process
// ---------------------------------------------------------------------------------------------
#[test]
fn r11_exec_transport_rejection_replays_as_the_recorded_failure_without_a_second_process() {
    let _lock = lock();
    assert_env_pinned();
    let server = CoreServer::new(Store::memory().unwrap());
    let case = case_project(&server, "r11", "linger");
    // No Core epoch is seeded here on purpose: the exec transport has no process binding, so
    // `persist_runtime_epoch_binding` returns `None` before any epoch is consulted, and the
    // canonical-binding refusal below happens with or without a seeded epoch (the third M1 RED
    // run had the seed and produced the same error).
    let invocations = case.workspace.join(".exec-invocations.txt");
    let script = case.workspace.join("codex-exec-reject.cmd");
    fs::write(
        &script,
        format!("@echo off\r\necho invoked>>\"{}\"\r\nexit /b 1\r\n", invocations.display()),
    )
    .unwrap();
    // The exec transport is chosen at select time from this process-wide variable: held under
    // CODEX_LOCK (every codex case in this binary serialises on it, m2 included) and owned by an
    // RAII guard so a panic can never leak `exec` into a later case.
    let _transport = ExecTransport::install();
    let attempt = default_attempt(&case.task, "codex");
    let admitted = select_codex(&server, "r11-select", &case, Some(&script));
    assert_eq!(admitted["ok"], true, "the exec transport registers without a process: {admitted}");

    // Plain ASCII input: the text travels as a batch-file argument, and a rejected escaping would
    // divert the send into the generic-retry path instead of the post-`sent` failure below.
    let first = send(&server, "r11-send", &case, &attempt, "reject me");
    let first_error = error_of(&first);
    // The real path (plan v10.1): the exec adapter reports `accepted: false` and pushes a TurnFailed
    // envelope; `send_message` tries to persist it BEFORE the `!sent.accepted` check, and the product
    // refuses every native event of the exec transport because that transport has no process
    // binding (runtime_manager.rs:1050; projection.rs:3601-3608). So the FIRST send fails at
    // persist_agent_event (:2162) — one of the failure points that recorded nothing before this
    // increment — with the delivery already known: the Runtime did not accept the input.
    assert!(first_error.contains("no canonical Runtime binding"), "{first_error}");
    let lines = fs::read_to_string(&invocations).unwrap_or_default();
    assert_eq!(lines.lines().count(), 1, "the first send ran the executable once: {lines:?}");
    // The TurnFailed envelope was never persisted, so the attempt is NOT terminal: pre-fix the
    // replay below passes every gate and is answered by the blind Ok(true).
    let row = server.processor().store().get_attempt(&attempt).unwrap();
    assert!(!row.state.is_terminal(), "the unpersisted failure event leaves the attempt live: {:?}", row.state);
    drain(&server, "r11");
    let baseline = events(&server, &attempt);
    assert_eq!(user_messages(&baseline), 1);
    assert_eq!(records_of(&baseline, "runtime.turn.failed").len(), 0, "the exec event was refused, not journaled");

    let again = send(&server, "r11-send", &case, &attempt, "reject me");
    assert_replay_refusal(&again, "r11-send", "FAILED", "FAILED", "no canonical Runtime binding");
    assert!(error_of(&again).contains(&first_error), "the replay carries the recorded reason verbatim");
    drain(&server, "r11-after");
    let lines = fs::read_to_string(&invocations).unwrap_or_default();
    assert_eq!(lines.lines().count(), 1, "the replay ran no process: {lines:?}");
    let after = events(&server, &attempt);
    assert_eq!(user_messages(&after), 1);
    assert_eq!(after, baseline);
    i7_marker("r11", "completed (codex exec transport, cmd.exe script)");
}

/// `GOALPORT_CODEX_TRANSPORT=exec` for exactly one case: set on construction, removed on drop
/// (also on unwind), the removal asserted. Caller holds `CODEX_LOCK`.
struct ExecTransport;

impl ExecTransport {
    fn install() -> Self {
        assert!(env::var_os("GOALPORT_CODEX_TRANSPORT").is_none(), "the transport variable must not already be set");
        unsafe { env::set_var("GOALPORT_CODEX_TRANSPORT", "exec") };
        Self
    }
}

impl Drop for ExecTransport {
    fn drop(&mut self) {
        unsafe { env::remove_var("GOALPORT_CODEX_TRANSPORT") };
        assert!(env::var_os("GOALPORT_CODEX_TRANSPORT").is_none(), "the transport variable is removed");
    }
}

// ---------------------------------------------------------------------------------------------
// R12 (critic round 1, finding 1): identity is content-bound AND request-bound. `stable_suffix`
// truncates to 48 characters, so two different request ids can share one command id and one
// payload hash; the second is a COLLISION and is refused without delivery - never answered as the
// first request's replay.
// ---------------------------------------------------------------------------------------------
#[test]
fn r12_distinct_request_ids_sharing_a_command_identity_are_refused_not_replayed() {
    let server = CoreServer::new(Store::memory().unwrap());
    let case = case_project(&server, "r12", "linger");
    let attempt = select_scenario(&server, "r12-select", &case);
    let first_id = format!("r12-collide-{}", "x".repeat(40));
    let second_id = format!("{first_id}-second");
    assert_eq!(
        send_message_command(&first_id, &attempt, "same text").unwrap().command,
        send_message_command(&second_id, &attempt, "same text").unwrap().command,
        "the two ids share one command identity (48-character truncation)"
    );
    assert_eq!(send(&server, &first_id, &case, &attempt, "same text")["ok"], true);
    drain(&server, "r12");
    let baseline = events(&server, &attempt);
    assert_eq!(user_messages(&baseline), 1);

    let again = send(&server, &second_id, &case, &attempt, "same text");
    let error = error_of(&again);
    assert!(error.contains(&format!("collides with the recorded request {first_id}")), "{error}");
    assert!(!error.starts_with("replayed request"), "a collision is not a replay: {error}");
    assert!(again["payload"].get("duplicate").is_none(), "{again}");
    drain(&server, "r12-after");
    let after = events(&server, &attempt);
    assert_eq!(user_messages(&after), 1, "nothing delivered for the colliding request");
    assert_eq!(after, baseline);
    i7_marker("r12", "completed");
}

// ---------------------------------------------------------------------------------------------
// R13 (delta audit on v11, blocking 1): a refused RETRY must not erase the first attempt's
// uncertainty. Codex exec transport: the first invocation prints one non-JSON line and exits 0
// (send_prompt fails on the parse -> not closed-transport, not "delivery unknown" -> the generic
// retry runs, delivery already UNKNOWN); the second invocation exits 1 (accepted:false; its
// TurnFailed envelope is then refused by the product as in R11). The recorded delivery must stay
// UNKNOWN - the first process DID receive the input (two invocation lines) - and the replay must
// say so.
// ---------------------------------------------------------------------------------------------
#[test]
fn r13_refused_retry_keeps_the_first_attempts_unknown_delivery() {
    let _lock = lock();
    assert_env_pinned();
    let server = CoreServer::new(Store::memory().unwrap());
    let case = case_project(&server, "r13", "linger");
    // As in R11: no Core epoch is seeded on purpose - the exec transport has no process binding,
    // so the canonical-binding refusal happens with or without one.
    let invocations = case.workspace.join(".exec-invocations.txt");
    let first_done = case.workspace.join(".exec-first-done");
    let script = case.workspace.join("codex-exec-flaky.cmd");
    fs::write(
        &script,
        format!(
            "@echo off\r\necho invoked %*>>\"{inv}\"\r\nif exist \"{done}\" exit /b 1\r\necho.>\"{done}\"\r\necho this line is not json\r\nexit /b 0\r\n",
            inv = invocations.display(),
            done = first_done.display()
        ),
    )
    .unwrap();
    let _transport = ExecTransport::install();
    let attempt = default_attempt(&case.task, "codex");
    let admitted = select_codex(&server, "r13-select", &case, Some(&script));
    assert_eq!(admitted["ok"], true, "{admitted}");

    let first = send(&server, "r13-send", &case, &attempt, "maybe delivered");
    let first_error = error_of(&first);
    assert!(first_error.contains("no canonical Runtime binding"), "{first_error}");
    let lines = fs::read_to_string(&invocations).unwrap_or_default();
    assert_eq!(lines.lines().count(), 2, "first attempt + retry both ran a process: {lines:?}");
    // The marker line carries the process's arguments: the prompt text reached BOTH processes.
    assert!(lines.lines().all(|line| line.contains("maybe delivered")), "the input reached the processes: {lines:?}");
    let row = server.processor().store().get_attempt(&attempt).unwrap();
    assert!(!row.state.is_terminal(), "the refused envelope leaves the attempt live: {:?}", row.state);
    drain(&server, "r13");
    let baseline = events(&server, &attempt);
    assert_eq!(user_messages(&baseline), 1);
    let intermediate: Vec<&Value> = records_of(&baseline, "runtime.send.failed");
    assert!(intermediate.iter().any(|r| r["retry"] == true), "the generic retry record was written: {baseline:?}");
    let row_id = send_message_command("r13-send", &attempt, "maybe delivered").unwrap().command.id;
    let recorded = server.processor().store().command_result(&row_id).unwrap().expect("the failure row carries its result");
    assert_eq!(recorded["deliveryState"], "UNKNOWN", "the first attempt's uncertainty survives the refused retry: {recorded}");

    let again = send(&server, "r13-send", &case, &attempt, "maybe delivered");
    assert_replay_refusal(&again, "r13-send", "FAILED", "UNKNOWN", "no canonical Runtime binding");
    assert!(error_of(&again).contains(&first_error), "the replay carries the recorded reason verbatim");
    drain(&server, "r13-after");
    let lines = fs::read_to_string(&invocations).unwrap_or_default();
    assert_eq!(lines.lines().count(), 2, "the replay ran no process: {lines:?}");
    assert_eq!(events(&server, &attempt), baseline);
    i7_marker("r13", "completed (codex exec transport, flaky cmd.exe script)");
}

// ---------------------------------------------------------------------------------------------
// R14 (critic round 2, finding 1): a row that rests Pending — the crash window between the
// record and the Executing transition, which no admitted fixture can produce, so the row is
// LABELLED constructed through the store's request-addressed insert — names its request from
// the moment it exists. A colliding request id (same lossy identity, same message) is refused
// without delivery; the original request id then executes exactly once.
// ---------------------------------------------------------------------------------------------
#[test]
fn r14_pending_row_refuses_a_colliding_id_and_still_executes_its_own_request() {
    let server = CoreServer::new(Store::memory().unwrap());
    let case = case_project(&server, "r14", "linger");
    let attempt = select_scenario(&server, "r14-select", &case);
    let original_id = format!("r14-pending-{}", "y".repeat(40));
    let colliding_id = format!("{original_id}-other");
    let command = send_message_command(&original_id, &attempt, "pending input").unwrap();
    assert_eq!(command.command, send_message_command(&colliding_id, &attempt, "pending input").unwrap().command);
    let store = server.processor().store();
    let recorded = store.record_command_for_request(&command.command, &original_id).unwrap();
    assert_eq!(recorded.state, CommandState::Pending, "constructed: the row rests Pending");
    let baseline = events(&server, &attempt);
    assert_eq!(user_messages(&baseline), 0);

    let collided = send(&server, &colliding_id, &case, &attempt, "pending input");
    let error = error_of(&collided);
    assert!(error.contains(&format!("collides with the recorded request {original_id}")), "{error}");
    drain(&server, "r14-collide");
    let after_collision = events(&server, &attempt);
    assert_eq!(user_messages(&after_collision), 0, "the colliding request delivered nothing");
    assert_eq!(after_collision, baseline);
    assert_eq!(store.get_command(&command.command.id).unwrap().state, CommandState::Pending, "the row is untouched");

    let own = send(&server, &original_id, &case, &attempt, "pending input");
    assert_eq!(own["ok"], true, "the original request executes normally: {own}");
    assert_eq!(own["payload"]["duplicate"], false, "{own}");
    drain(&server, "r14-own");
    assert_eq!(user_messages(&events(&server, &attempt)), 1, "delivered exactly once");
    assert_eq!(store.get_command(&command.command.id).unwrap().state, CommandState::Succeeded);
    let result = store.command_result(&command.command.id).unwrap().unwrap();
    assert_eq!(result["requestId"], original_id, "{result}");
    assert_eq!(result["deliveryState"], "DELIVERED", "{result}");
    i7_marker("r14", "completed (constructed Pending row)");
}

// ---------------------------------------------------------------------------------------------
// N1 pin (test-only, closes a coverage gap found this session): the "registered for another task"
// refusal keeps the existing registration and the selection.
// ---------------------------------------------------------------------------------------------
#[test]
fn n1_reuse_for_another_task_is_refused_and_the_selection_is_kept() {
    let server = CoreServer::new(Store::memory().unwrap());
    let case = case_project(&server, "n1t", "linger");
    let attempt = select_scenario(&server, "n1t-select", &case);
    let other_task = format!("{}-other", case.task);
    server
        .processor()
        .store()
        .insert_task(&Task {
            id: other_task.clone(),
            campaign_id: case.campaign.clone(),
            title: "other task".into(),
            acceptance: "selectable".into(),
            state: WorkStatus::InProgress,
        })
        .unwrap();
    let refused = call(
        &server,
        "n1t-reselect",
        "select_runtime",
        json!({ "projectId": case.project, "campaignId": case.campaign, "taskId": other_task, "provider": "scenario", "attemptId": attempt }),
    );
    let error = error_of(&refused);
    assert!(error.contains("registered for another task"), "{error}");
    assert_eq!(selected_attempt(&server, "n1t-snapshot"), attempt, "the selection is untouched");
    assert_eq!(send(&server, "n1t-send", &case, &attempt, "still usable")["ok"], true, "the kept registration still works");
    i7_marker("n1t", "completed");
}
