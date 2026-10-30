//! Real Windows pipe/child regression: never release a stalled peer to make Stop pass.
#![cfg(windows)]
use goalport_core::{commands::sha256_hex, ipc::{IpcError, NamedPipeClient}};
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    fs::{self, File},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};

#[derive(Debug)]
enum WireErrorKind {
    Connect { os_error: Option<i32>, raw: String },
    Write { os_error: Option<i32>, raw: String },
    ReadHeader { os_error: Option<i32>, raw: String },
    ReadBody { os_error: Option<i32>, raw: String },
    FrameTooLarge { len: usize },
    Decode { raw: String },
    WorkerPanicked { detail: String },
}

#[derive(Debug)]
struct WireError {
    stage: &'static str,
    id: String,
    kind: String,
    elapsed: Duration,
    error: WireErrorKind,
}

impl std::fmt::Display for WireError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "wire failure at stage '{}' for req '{}' (type '{}') after {:.2?}: {:?}",
            self.stage, self.id, self.kind, self.elapsed, self.error
        )
    }
}

struct Harness {
    root: Option<tempfile::TempDir>,
    root_path: PathBuf,
    child: RefCell<Child>,
    stderr_path: PathBuf,
    pipe: String,
    workspace: PathBuf,
    failure_observed: RefCell<bool>,
}
impl Harness {
    fn new(scenario: &str) -> Self {
        Self::new_with_env(scenario, None)
    }

    fn new_with_env(scenario: &str, inherited_localappdata: Option<PathBuf>) -> Self {
        let root = tempfile::tempdir().unwrap();
        let root_path = root.path().to_path_buf();
        let workspace = root_path.join("workspace");
        let shim = root_path.join("shim");
        let appdata = root_path.join("appdata");
        let localappdata = inherited_localappdata.unwrap_or_else(|| root_path.join("localappdata"));
        let stderr_path = root_path.join("core.stderr.log");
        for dir in [&workspace, &shim, &appdata, &localappdata] {
            fs::create_dir_all(dir).unwrap();
        }
        let node = std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
            .map(|dir| dir.join("node.exe"))
            .find(|p| p.is_file())
            .expect("node.exe required");
        fs::copy(node, shim.join("codex.exe")).unwrap();
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/fake-codex-app-server/fake-codex-app-server.mjs");
        fs::copy(fixture, workspace.join("fixture.mjs")).unwrap();
        fs::write(workspace.join("app-server"), "import('./fixture.mjs');\n").unwrap();
        fs::write(workspace.join(".fake-codex-scenario"), scenario).unwrap();
        let pipe = format!(
            "goalport-responsive-{}-{}",
            std::process::id(),
            root_path.file_name().unwrap().to_string_lossy()
        );
        let stderr_file = File::create(&stderr_path).unwrap();
        let mut command = Command::new(env!("CARGO_BIN_EXE_goalport-core"));
        command
            .args(["serve", "--pipe", &pipe, "--db"])
            .arg(root_path.join("core.sqlite"))
            .current_dir(&root_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::from(stderr_file));
        for (key, _) in std::env::vars().filter(|(key, _)| key.starts_with("GOALPORT_")) {
            command.env_remove(key);
        }
        let mut paths = vec![shim];
        paths.extend(std::env::split_paths(
            &std::env::var_os("PATH").unwrap_or_default(),
        ));
        command
            .env("PATH", std::env::join_paths(paths).unwrap())
            .env("APPDATA", appdata)
            .env("LOCALAPPDATA", localappdata)
            .env("GOALPORT_LAUNCH_NONCE", &pipe);
        let child = command.spawn().unwrap();
        let harness = Self {
            root: Some(root),
            root_path,
            child: RefCell::new(child),
            stderr_path,
            pipe,
            workspace,
            failure_observed: RefCell::new(false),
        };
        // Cold process start is not the 2s stall contract. A loaded CI
        // runner misses that bound when several cores spawn together.
        assert_eq!(
            harness.call_within("ready", "snapshot", json!({}), Duration::from_secs(20))["ok"],
            true
        );
        harness
    }

    fn snapshot_child_failure(&self) -> String {
        *self.failure_observed.borrow_mut() = true;
        let mut child = self.child.borrow_mut();
        let status = match child.try_wait() {
            Ok(Some(exit)) => format!("exited ({exit})"),
            Ok(None) => "still running".to_string(),
            Err(e) => format!("error querying status: {e}"),
        };
        let stderr_tail = match File::open(&self.stderr_path) {
            Ok(mut f) => {
                let len = f.metadata().map(|m| m.len()).unwrap_or(0);
                let start = if len > 4096 { len - 4096 } else { 0 };
                let _ = f.seek(SeekFrom::Start(start));
                let mut buf = Vec::new();
                let _ = f.take(4096).read_to_end(&mut buf);
                String::from_utf8_lossy(&buf).to_string()
            }
            Err(e) => format!("(could not read stderr: {e})"),
        };
        let db_path = self.root_path.join("core.sqlite");
        let ready_path = self.root_path.join("core.sqlite.launch-ready");
        let db_present = db_path.exists();
        let ready_present = ready_path.exists();
        format!(
            "Child status: {status}; db present: {db_present} ({db_path:?}), launch-ready: {ready_present} ({ready_path:?}); stderr tail:\n{stderr_tail}"
        )
    }

    fn async_call(&self, id: &str, kind: &str, payload: Value) -> mpsc::Receiver<Result<Value, WireError>> {
        let pipe = self.pipe.clone();
        let id = id.to_owned();
        let kind = kind.to_owned();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let start = Instant::now();
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                wire_result(&pipe, &id, &kind, payload)
            }));
            let response = match result {
                Ok(res) => res,
                Err(panic_err) => {
                    let detail = if let Some(s) = panic_err.downcast_ref::<&str>() {
                        (*s).to_string()
                    } else if let Some(s) = panic_err.downcast_ref::<String>() {
                        s.clone()
                    } else {
                        "unknown worker panic".to_string()
                    };
                    Err(WireError {
                        stage: "worker",
                        id: id.clone(),
                        kind: kind.clone(),
                        elapsed: start.elapsed(),
                        error: WireErrorKind::WorkerPanicked { detail },
                    })
                }
            };
            let _ = tx.send(response);
        });
        rx
    }
    fn call(&self, id: &str, kind: &str, payload: Value) -> Value {
        self.call_within(id, kind, payload, Duration::from_secs(2))
    }
    fn call_within(&self, id: &str, kind: &str, payload: Value, timeout: Duration) -> Value {
        self.recv_call_within(id, kind, self.async_call(id, kind, payload), timeout)
    }

    fn recv_call_within(&self, id: &str, kind: &str, rx: mpsc::Receiver<Result<Value, WireError>>, timeout: Duration) -> Value {
        let start = Instant::now();
        match rx.recv_timeout(timeout) {
            Ok(Ok(val)) => val,
            Ok(Err(wire_err)) => {
                let diag = self.snapshot_child_failure();
                panic!("request '{id}' (type '{kind}') failed wire check:\n{wire_err}\n{diag}");
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let diag = self.snapshot_child_failure();
                panic!("control request '{id}' (type '{kind}') timed out after {:.2?} (budget {}s):\n{diag}", start.elapsed(), timeout.as_secs());
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                let diag = self.snapshot_child_failure();
                panic!("control request '{id}' (type '{kind}') worker thread disconnected unexpectedly after {:.2?}:\n{diag}", start.elapsed());
            }
        }
    }
    fn await_marker(&self, marker: &str) {
        let end = Instant::now() + Duration::from_secs(15);
        while !self.workspace.join(marker).exists() {
            if Instant::now() >= end {
                let diag = self.snapshot_child_failure();
                panic!("missing {marker} after 15s:\n{diag}");
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    fn start(&self) -> mpsc::Receiver<Result<Value, WireError>> {
        self.async_call("start", "start_conversation", json!({"workspaceRoot": self.workspace,"provider":"codex","message":"Do not replay this prompt"}))
    }
    fn attempt(&self) -> String {
        format!("attempt-{}", sha256_hex(b"start"))
    }
}
impl Drop for Harness {
    fn drop(&mut self) {
        // Keep directory if failure_observed was set OR if thread is unwinding (assertion panic anywhere in test)
        let failed = *self.failure_observed.borrow() || std::thread::panicking();
        if failed {
            // Portably retain the unique failure directory by keeping the TempDir
            if let Some(td) = self.root.take() {
                let path = td.keep();
                eprintln!("Harness failure observed; uniquely retained TempDir at {path:?}");
            }
        }
        // Fixture-owned marker cleanup, never used before cancellation assertions.
        let _ = fs::write(self.workspace.join(".fake-codex-stop.marker"), "cleanup");
        std::thread::sleep(Duration::from_millis(150));
        let mut child = self.child.borrow_mut();
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn connect_result(pipe: &str, id: &str, kind: &str) -> Result<NamedPipeClient, WireError> {
    let start = Instant::now();
    let end = start + Duration::from_secs(10);
    loop {
        match NamedPipeClient::connect(pipe) {
            Ok(client) => return Ok(client),
            Err(IpcError::Io(e)) => {
                if Instant::now() >= end {
                    return Err(WireError {
                        stage: "connect",
                        id: id.to_string(),
                        kind: kind.to_string(),
                        elapsed: start.elapsed(),
                        error: WireErrorKind::Connect {
                            os_error: e.raw_os_error(),
                            raw: e.to_string(),
                        },
                    });
                }
            }
            Err(other) => {
                return Err(WireError {
                    stage: "connect",
                    id: id.to_string(),
                    kind: kind.to_string(),
                    elapsed: start.elapsed(),
                    error: WireErrorKind::Connect {
                        os_error: None,
                        raw: other.to_string(),
                    },
                });
            }
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn connect(pipe: &str) -> NamedPipeClient {
    connect_result(pipe, "direct-connect", "connect").unwrap_or_else(|e| panic!("pipe connect failed: {e}"))
}

fn wire_result(pipe: &str, id: &str, kind: &str, payload: Value) -> Result<Value, WireError> {
    let start = Instant::now();
    let mut client = connect_result(pipe, id, kind)?;
    let bytes = serde_json::to_vec(&json!({"protocolVersion":"goalport.ipc.v2","requestId":id,"entityVersion":0,"messageType":kind,"payload":payload}))
        .map_err(|e| WireError {
            stage: "encode",
            id: id.to_string(),
            kind: kind.to_string(),
            elapsed: start.elapsed(),
            error: WireErrorKind::Decode { raw: e.to_string() },
        })?;
    client
        .write_all(&(bytes.len() as u32).to_le_bytes())
        .map_err(|e| WireError {
            stage: "write_len",
            id: id.to_string(),
            kind: kind.to_string(),
            elapsed: start.elapsed(),
            error: WireErrorKind::Write { os_error: e.raw_os_error(), raw: e.to_string() },
        })?;
    client.write_all(&bytes).map_err(|e| WireError {
        stage: "write_body",
        id: id.to_string(),
        kind: kind.to_string(),
        elapsed: start.elapsed(),
        error: WireErrorKind::Write { os_error: e.raw_os_error(), raw: e.to_string() },
    })?;
    let mut header = [0; 4];
    client.read_exact(&mut header).map_err(|e| WireError {
        stage: "read_header",
        id: id.to_string(),
        kind: kind.to_string(),
        elapsed: start.elapsed(),
        error: WireErrorKind::ReadHeader { os_error: e.raw_os_error(), raw: e.to_string() },
    })?;
    let len = u32::from_le_bytes(header) as usize;
    if len >= 16 * 1024 * 1024 {
        return Err(WireError {
            stage: "frame",
            id: id.to_string(),
            kind: kind.to_string(),
            elapsed: start.elapsed(),
            error: WireErrorKind::FrameTooLarge { len },
        });
    }
    let mut body = vec![0; len];
    client.read_exact(&mut body).map_err(|e| WireError {
        stage: "read_body",
        id: id.to_string(),
        kind: kind.to_string(),
        elapsed: start.elapsed(),
        error: WireErrorKind::ReadBody { os_error: e.raw_os_error(), raw: e.to_string() },
    })?;
    serde_json::from_slice(&body).map_err(|e| WireError {
        stage: "decode",
        id: id.to_string(),
        kind: kind.to_string(),
        elapsed: start.elapsed(),
        error: WireErrorKind::Decode { raw: e.to_string() },
    })
}
fn stalled_case(scenario: &str, marker: &str) {
    let h = Harness::new(scenario);
    let start = h.start();
    h.await_marker(marker);
    assert!(
        start.try_recv().is_err(),
        "start must still be stalled before controls"
    );
    let snapshot = h.call("during", "snapshot", json!({}));
    assert_eq!(
        snapshot["payload"]["snapshot"]["productConversation"]["runtime"]["state"], "starting",
        "{snapshot}"
    );
    let revision = h.call("revision", "snapshot_if_changed", json!({}));
    assert_eq!(revision["ok"], true);
    // Another selection must remain usable and must not be stolen on merge.
    let other = h.root_path.join("other");
    fs::create_dir_all(&other).unwrap();
    let selected = h.call(
        "other",
        "create_campaign",
        json!({"workspaceRoot":other,"goal":"Other work","title":"Other"}),
    );
    assert_eq!(selected["ok"], true, "{selected}");
    let other_campaign = selected["payload"]["snapshot"]["activeCampaignId"].clone();
    // Two independent pipe clients overlap the still-stalled start.
    let view = h.async_call("concurrent-view", "snapshot", json!({}));
    let stop = h.async_call("stop", "safe_stop", json!({"attemptId":h.attempt()}));
    assert_eq!(
        view.recv_timeout(Duration::from_secs(2)).unwrap().expect("view wire failed")["ok"],
        true
    );
    let stopped = stop
        .recv_timeout(Duration::from_secs(2))
        .expect("Stop blocked")
        .expect("stop wire failed");
    let mut cancel = stopped["payload"]["receipt"]["startupCancel"].clone();
    // The first response is the 2s contract. Exit proof can land just after
    // that response when the runner is busy; pending must not stay pending.
    let confirm_by = Instant::now() + Duration::from_secs(8);
    while cancel == "pending" && Instant::now() < confirm_by {
        std::thread::sleep(Duration::from_millis(50));
        cancel = h.call("stop-confirm", "safe_stop", json!({"attemptId":h.attempt()}))["payload"]["receipt"]["startupCancel"].clone();
    }
    assert_eq!(cancel, "confirmed", "{stopped}");
    assert_eq!(stopped["payload"]["receipt"]["nativePromptSent"], false);
    let start_response = start
        .recv_timeout(Duration::from_secs(2))
        .unwrap()
        .expect("start wire failed");
    assert_eq!(start_response["ok"], false, "{start_response}");
    assert!(
        start_response["error"]
            .as_str()
            .unwrap_or_default()
            .contains("cancelled before prompt dispatch"),
        "a user Stop during startup must not be reported as a startup failure: {start_response}"
    );
    assert!(!h.workspace.join(".fake-codex-release").exists());
    assert!(
        !h.workspace
            .join(".fake-codex-initialize-released.marker")
            .exists()
    );
    assert!(!h.workspace.join(".fake-codex-turn.marker").exists());
    let terminal = h.call("terminal", "snapshot", json!({}));
    assert_eq!(
        terminal["payload"]["snapshot"]["activeCampaignId"], other_campaign,
        "late merge stole selection: {terminal}"
    );
    let detail = h.call(
        "detail",
        "goal_detail",
        json!({"campaignId": format!("campaign-{}",sha256_hex(b"start"))}),
    );
    assert_ne!(
        detail["payload"]["snapshot"]["productConversation"]["runtime"]["state"], "starting",
        "{detail}"
    );
    assert_eq!(stopped["payload"]["receipt"]["attemptId"], h.attempt());
    fs::write(h.workspace.join(".fake-codex-scenario"), "linger").unwrap();
    let next = h.async_call("explicit-next", "conversation_send", json!({"campaignId": format!("campaign-{}",sha256_hex(b"start")),"attemptId":h.attempt(),"message":"Explicit new input"})).recv_timeout(Duration::from_secs(15)).expect("explicit next send failed to settle").expect("explicit next send wire failed");
    assert_eq!(next["ok"], true, "{next}");
    h.await_marker(".fake-codex-turn.marker");
}
#[test]
fn withheld_initialize_status_stop_and_explicit_next_send() {
    stalled_case("stall_initialize", ".fake-codex-initialized.marker");
}
#[test]
fn withheld_thread_start_keeps_owned_cancel_handle() {
    stalled_case("stall_thread_start", ".fake-codex-thread-start.marker");
}
#[test]
fn partial_initialize_output_does_not_defeat_stop() {
    stalled_case("stall_initialize_partial", ".fake-codex-initialized.marker");
}
#[test]
fn stop_before_binding_is_not_registered_as_effective_cancellation() {
    let h = Harness::new("stall_initialize");
    let early = h.call(
        "too-early-stop",
        "safe_stop",
        json!({"attemptId":h.attempt()}),
    );
    assert_ne!(early["payload"]["receipt"]["startupCancel"], "confirmed");
    let start = h.start();
    h.await_marker(".fake-codex-initialized.marker");
    assert!(
        start.try_recv().is_err(),
        "early Stop became a hidden cancellation registry"
    );
    assert_eq!(
        h.call("after-early-stop", "snapshot", json!({}))["payload"]["snapshot"]["productConversation"]
            ["runtime"]["state"],
        "starting"
    );
    let actual = h.call("actual-stop", "safe_stop", json!({"attemptId":h.attempt()}));
    assert_eq!(
        actual["payload"]["receipt"]["startupCancel"], "confirmed",
        "{actual}"
    );
    let start_response = start
        .recv_timeout(Duration::from_secs(2))
        .unwrap()
        .expect("start wire failed");
    assert_eq!(start_response["ok"], false, "{start_response}");
    assert!(
        start_response["error"]
            .as_str()
            .unwrap_or_default()
            .contains("cancelled before prompt dispatch"),
        "a user Stop during startup must not be reported as a startup failure: {start_response}"
    );
}
#[test]
fn timeout_settles_without_claiming_a_user_cancel() {
    // End-to-end production duration, complemented by the injected 25 ms
    // StartupControl unit test. No product environment hook changes deadlines.
    let h = Harness::new("stall_initialize");
    let start = h.start();
    h.await_marker(".fake-codex-initialized.marker");
    assert_eq!(h.call("during-timeout", "snapshot", json!({}))["ok"], true);
    let response = start
        .recv_timeout(Duration::from_secs(35))
        .expect("startup watchdog never returned the lend")
        .expect("start wire failed");
    assert_eq!(response["ok"], false, "{response}");
    assert!(
        response["error"]
            .as_str()
            .unwrap_or_default()
            .contains("timed out"),
        "{response}"
    );
    assert!(!h.workspace.join(".fake-codex-turn.marker").exists());
    assert!(!h.workspace.join(".fake-codex-release").exists());
    let view = h.call("after-timeout", "snapshot", json!({}));
    assert!(view["payload"]["snapshot"]["productConversation"]["items"].to_string().contains("timed out"), "timeout disappeared from the retained error: {view}");
    let events = view["payload"]["snapshot"]["timeline"].as_array().unwrap();
    assert!(
        events
            .iter()
            .any(|e| e["eventKind"] == "attempt.start.timeout"),
        "{view}"
    );
    assert!(
        !events
            .iter()
            .any(|e| e["eventKind"] == "attempt.start.cancelled"),
        "timeout forged a user Stop"
    );
    fs::write(h.workspace.join(".fake-codex-scenario"), "linger").unwrap();
    let next = h.async_call("after-timeout-next", "conversation_send", json!({"campaignId":format!("campaign-{}",sha256_hex(b"start")),"attemptId":h.attempt(),"message":"Explicit timeout recovery"})).recv_timeout(Duration::from_secs(15)).unwrap().expect("next send wire failed");
    assert_eq!(next["ok"], true, "{next}");
}
#[test]
fn cancel_racing_initialize_never_confirms_a_dispatched_prompt() {
    let h = Harness::new("stall_initialize");
    let start = h.start();
    h.await_marker(".fake-codex-initialized.marker");
    let stop = h.async_call("race-stop", "safe_stop", json!({"attemptId":h.attempt()}));
    fs::write(h.workspace.join(".fake-codex-release"), "race release").unwrap();
    let stopped = stop.recv_timeout(Duration::from_secs(8)).unwrap().expect("race stop wire failed");
    let returned = start.recv_timeout(Duration::from_secs(15)).unwrap().expect("start wire failed");
    if stopped["payload"]["receipt"]["startupCancel"] == "confirmed" {
        assert_eq!(returned["ok"], false);
        assert!(!h.workspace.join(".fake-codex-turn.marker").exists());
    } else {
        assert_ne!(
            stopped["payload"]["receipt"]["nativePromptSent"], false,
            "unproven unsent receipt"
        );
    }
}
#[test]
fn dispatch_wins_and_late_stop_cannot_kill_startup_child() {
    let h = Harness::new("linger");
    let started = h.start().recv_timeout(Duration::from_secs(30)).unwrap().expect("start wire failed");
    assert_eq!(started["ok"], true, "{started}");
    h.await_marker(".fake-codex-turn.marker");
    let stopped = h.call("late-stop", "safe_stop", json!({"attemptId":h.attempt()}));
    assert_ne!(stopped["payload"]["receipt"]["startupCancel"], "confirmed");
    let marker: Value =
        serde_json::from_slice(&fs::read(h.workspace.join(".fake-codex-turn.marker")).unwrap())
            .unwrap();
    assert!(matches!(
        goalport_core::process_identity::observe_process(marker["pid"].as_u64().unwrap() as u32),
        goalport_core::process_identity::ProcessObservation::Live(_)
    ));
}
#[test]
fn worker_cap_refuses_excess_without_killing_listener() {
    let h = Harness::new("linger");
    let clients: Vec<_> = (0..32).map(|_| connect(&h.pipe)).collect();
    std::thread::sleep(Duration::from_millis(100));
    let mut excess = connect(&h.pipe);
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut byte = [0];
        let _ = tx.send(excess.read(&mut byte).unwrap_or(0));
    });
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(2))
            .expect("excess client was queued instead of refused"),
        0
    );
    drop(clients);
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(h.call("after-cap", "snapshot", json!({}))["ok"], true);
}
#[test]
fn transport_disconnect_is_not_a_confirmed_user_stop() {
    let h = Harness::new("disconnect_initialize");
    let response = h.start().recv_timeout(Duration::from_secs(15)).unwrap().expect("start wire failed");
    assert_eq!(response["ok"], false, "{response}");
    assert!(!h.workspace.join(".fake-codex-turn.marker").exists());
    let snapshot = h.call("after-disconnect", "snapshot", json!({}));
    assert_eq!(snapshot["ok"], true);
    assert_ne!(
        snapshot["payload"]["snapshot"]["productConversation"]["runtime"]["state"],
        "starting"
    );
    assert!(!snapshot.to_string().contains("attempt.start.cancelled"));
}
#[test]
fn disconnected_start_client_does_not_lose_cancel_or_lend_return() {
    let h = Harness::new("stall_initialize");
    let mut start = connect(&h.pipe);
    let bytes = serde_json::to_vec(&json!({"protocolVersion":"goalport.ipc.v2","requestId":"start","entityVersion":0,"messageType":"start_conversation","payload":{"workspaceRoot":h.workspace,"provider":"codex","message":"Lost client"}})).unwrap();
    start
        .write_all(&(bytes.len() as u32).to_le_bytes())
        .unwrap();
    start.write_all(&bytes).unwrap();
    h.await_marker(".fake-codex-initialized.marker");
    drop(start);
    let stopped = h.call(
        "stop-lost-client",
        "safe_stop",
        json!({"attemptId":h.attempt()}),
    );
    assert_eq!(
        stopped["payload"]["receipt"]["startupCancel"], "confirmed",
        "{stopped}"
    );
    assert!(!h.workspace.join(".fake-codex-turn.marker").exists());
    assert_eq!(
        h.call("after-lost-client", "snapshot", json!({}))["ok"],
        true
    );
}
#[test]
fn malformed_and_disconnected_clients_do_not_kill_listener() {
    let h = Harness::new("linger");
    let mut bad = connect(&h.pipe);
    bad.write_all(&3u32.to_le_bytes()).unwrap();
    bad.write_all(b"bad").unwrap();
    drop(bad);
    drop(connect(&h.pipe));
    let a = h.async_call("client-a", "snapshot", json!({}));
    let b = h.async_call("client-b", "snapshot", json!({}));
    assert_eq!(a.recv_timeout(Duration::from_secs(2)).unwrap().unwrap()["ok"], true);
    assert_eq!(b.recv_timeout(Duration::from_secs(2)).unwrap().unwrap()["ok"], true);
}

#[test]
fn diagnostic_harness_classifiers_distinguish_errors() {
    // 1. Missing pipe reports stage 'connect' with OS code 2 (ERROR_FILE_NOT_FOUND)
    let non_existent = format!("goalport-missing-pipe-{}", std::process::id());
    let err = connect_result(&non_existent, "test-missing", "snapshot").unwrap_err();
    assert_eq!(err.stage, "connect");
    match err.error {
        WireErrorKind::Connect { os_error, .. } => {
            assert_eq!(os_error, Some(2), "expected ERROR_FILE_NOT_FOUND (2)");
        }
        other => panic!("expected WireErrorKind::Connect, got: {other:?}"),
    }

    // 2. Harness real recv_call_within path distinguishes worker disconnection vs timeout
    let (tx_wire_err, rx_wire_err) = mpsc::channel::<Result<Value, WireError>>();
    tx_wire_err.send(Err(WireError {
        stage: "connect",
        id: "test-fail".to_string(),
        kind: "snapshot".to_string(),
        elapsed: Duration::from_millis(10),
        error: WireErrorKind::Connect { os_error: Some(2), raw: "not found".to_string() },
    })).unwrap();

    let root = tempfile::tempdir().unwrap();
    let root_path = root.path().to_path_buf();
    let stderr_path = root_path.join("test.stderr.log");
    fs::write(&stderr_path, "actual stderr from test").unwrap();
    let dummy_child = Command::new("cmd.exe").args(["/c", "exit 0"]).spawn().unwrap();
    let harness = Harness {
        root: Some(root),
        root_path: root_path.clone(),
        child: RefCell::new(dummy_child),
        stderr_path,
        pipe: non_existent.clone(),
        workspace: root_path.join("ws"),
        failure_observed: RefCell::new(false),
    };

    // (2a) Wire error reporting through the real harness.call_within entry point
    let call_res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        harness.call_within("test-fail", "snapshot", json!({}), Duration::from_secs(12));
    }));
    let panic_msg = call_res.unwrap_err();
    let msg_str = panic_msg.downcast_ref::<String>().map(|s| s.as_str()).unwrap_or("");
    assert!(msg_str.contains("failed wire check") && msg_str.contains("stage 'connect'"), "expected wire failure report from real call_within, got: {msg_str}");

    // (2b) Worker disconnection reporting
    let (tx_disconn, rx_disconn) = mpsc::channel::<Result<Value, WireError>>();
    drop(tx_disconn);
    let disconn_res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        harness.recv_call_within("test-disconn", "snapshot", rx_disconn, Duration::from_millis(50));
    }));
    let disconn_msg = disconn_res.unwrap_err();
    let disconn_str = disconn_msg.downcast_ref::<String>().map(|s| s.as_str()).unwrap_or("");
    assert!(disconn_str.contains("worker thread disconnected unexpectedly"), "expected disconnected message, got: {disconn_str}");

    // (2c) True timeout reporting
    let (_tx_timeout, rx_timeout) = mpsc::channel::<Result<Value, WireError>>();
    let start_to = Instant::now();
    let timeout_res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        harness.recv_call_within("test-timeout", "snapshot", rx_timeout, Duration::from_millis(50));
    }));
    assert!(start_to.elapsed() >= Duration::from_millis(50));
    let timeout_msg = timeout_res.unwrap_err();
    let timeout_str = timeout_msg.downcast_ref::<String>().map(|s| s.as_str()).unwrap_or("");
    assert!(timeout_str.contains("timed out after") && timeout_str.contains("budget 0s"), "expected timeout message, got: {timeout_str}");

    // 3. Child early exit before bind writes actual stderr, exits code 42, and TempDir is uniquely retained with content
    let crash_root = tempfile::tempdir().unwrap();
    let crash_root_path = crash_root.path().to_path_buf();
    let crash_stderr_path = crash_root_path.join("crash.stderr.log");
    let stderr_file = File::create(&crash_stderr_path).unwrap();
    let mut exit_child = Command::new("cmd.exe")
        .args(["/c", "echo fatal error output 1>&2 && exit 42"])
        .stderr(Stdio::from(stderr_file))
        .spawn()
        .unwrap();
    // Bounded synchronization: wait up to 5s for exit
    let exit_deadline = Instant::now() + Duration::from_secs(5);
    let mut exit_code_val = None;
    while Instant::now() < exit_deadline {
        if let Ok(Some(status)) = exit_child.try_wait() {
            exit_code_val = status.code();
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(exit_code_val, Some(42), "child must exit with code 42 within 5s deadline");
    let crash_harness = Harness {
        root: Some(crash_root),
        root_path: crash_root_path.clone(),
        child: RefCell::new(exit_child),
        stderr_path: crash_stderr_path.clone(),
        pipe: "fake-pipe".to_string(),
        workspace: crash_root_path.join("workspace"),
        failure_observed: RefCell::new(false),
    };
    let diag = crash_harness.snapshot_child_failure();
    assert!(diag.contains("42"), "expected exit code 42 in diag: {diag}");
    assert!(diag.contains("fatal error output"), "expected real child stderr in diag: {diag}");
    assert_eq!(*crash_harness.failure_observed.borrow(), true);

    drop(crash_harness);
    // Verified post-drop unique retention: directory and actual stderr log file must still exist!
    assert!(crash_root_path.exists(), "crash directory must be retained on failure!");
    assert!(crash_stderr_path.exists(), "stderr log must exist inside retained directory!");
    let retained_content = fs::read_to_string(&crash_stderr_path).unwrap();
    assert!(retained_content.contains("fatal error output"));
    let _ = fs::remove_dir_all(&crash_root_path); // clean up isolated test directory after verified retention

    // 4. Controlled scratch decoy at inherited LOCALAPPDATA proves harness isolation prevents hijacks
    let decoy_root = tempfile::tempdir().unwrap();
    let decoy_appdata = decoy_root.path().join("decoy_localappdata");
    let decoy_bin = decoy_appdata.join("Programs/OpenAI/Codex/bin");
    fs::create_dir_all(&decoy_bin).unwrap();
    let dummy_exe = decoy_bin.join("codex.exe");
    // Copy the valid node.exe so GetBinaryTypeW considers it a genuine loadable executable candidate
    let node = std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
        .map(|dir| dir.join("node.exe"))
        .find(|p| p.is_file())
        .expect("node.exe required");
    fs::copy(&node, &dummy_exe).unwrap();

    // Case A: When Core is spawned with isolated LOCALAPPDATA (default Harness::new),
    // it ignores the decoy_appdata candidate entirely and executes the shim.
    let h_isolated = Harness::new("linger");
    let start_res = h_isolated.start().recv_timeout(Duration::from_secs(30)).unwrap().expect("start wire failed");
    assert_eq!(start_res["ok"], true);
    let prov_path = h_isolated.workspace.join(".fake-codex-app-server.json");
    assert!(prov_path.exists(), "fixture startup provenance JSON must exist");
    let prov: Value = serde_json::from_slice(&fs::read(&prov_path).unwrap()).unwrap();
    assert_eq!(prov["scenario"], "linger");
    assert!(prov["argv"].as_array().unwrap().contains(&json!("--listen")));
    assert!(prov["argv"].as_array().unwrap().contains(&json!("stdio://")));
    let exec_path = prov["execPath"].as_str().unwrap().to_lowercase();
    assert!(exec_path.contains("shim"), "isolated harness must execute from shim directory, got: {exec_path}");

    // Case B: Counterexample proving the decoy actually competes and wins when NOT isolated:
    // When Core is explicitly supplied with decoy_appdata as its LOCALAPPDATA,
    // Core's resolver prioritizes LOCALAPPDATA\\Programs\\OpenAI\\Codex\\bin\\codex.exe over PATH shim!
    let h_unisolated = Harness::new_with_env("linger", Some(decoy_appdata));
    let start_unisolated = h_unisolated.start().recv_timeout(Duration::from_secs(30)).unwrap().expect("start wire failed");
    assert_eq!(start_unisolated["ok"], true);
    let prov_unisolated_path = h_unisolated.workspace.join(".fake-codex-app-server.json");
    assert!(prov_unisolated_path.exists());
    let prov_unisolated: Value = serde_json::from_slice(&fs::read(&prov_unisolated_path).unwrap()).unwrap();
    let unisolated_exec = prov_unisolated["execPath"].as_str().unwrap().to_lowercase();
    assert!(unisolated_exec.contains("decoy_localappdata"), "when LOCALAPPDATA is unisolated, Core resolver must select the higher-priority LOCALAPPDATA candidate, got: {unisolated_exec}");
    assert_ne!(exec_path, unisolated_exec, "isolated and unisolated executions must select different candidates");
}
