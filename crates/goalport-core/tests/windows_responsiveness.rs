//! Real Windows pipe/child regression: never release a stalled peer to make Stop pass.
#![cfg(windows)]
use goalport_core::{commands::sha256_hex, ipc::NamedPipeClient};
use serde_json::{Value, json};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};

struct Harness {
    root: tempfile::TempDir,
    child: Child,
    pipe: String,
    workspace: PathBuf,
}
impl Harness {
    fn new(scenario: &str) -> Self {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        let shim = root.path().join("shim");
        let appdata = root.path().join("appdata");
        for dir in [&workspace, &shim, &appdata] {
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
            root.path().file_name().unwrap().to_string_lossy()
        );
        let mut command = Command::new(env!("CARGO_BIN_EXE_goalport-core"));
        command
            .args(["serve", "--pipe", &pipe, "--db"])
            .arg(root.path().join("core.sqlite"))
            .current_dir(root.path())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
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
            .env("GOALPORT_LAUNCH_NONCE", &pipe);
        let child = command.spawn().unwrap();
        let harness = Self {
            root,
            child,
            pipe,
            workspace,
        };
        assert_eq!(harness.call("ready", "snapshot", json!({}))["ok"], true);
        harness
    }
    fn async_call(&self, id: &str, kind: &str, payload: Value) -> mpsc::Receiver<Value> {
        let pipe = self.pipe.clone();
        let id = id.to_owned();
        let kind = kind.to_owned();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let response = wire(&pipe, &id, &kind, payload);
            let _ = tx.send(response);
        });
        rx
    }
    fn call(&self, id: &str, kind: &str, payload: Value) -> Value {
        self.async_call(id, kind, payload)
            .recv_timeout(Duration::from_secs(2))
            .expect("control request blocked beyond 2 s")
    }
    fn await_marker(&self, marker: &str) {
        let end = Instant::now() + Duration::from_secs(15);
        while !self.workspace.join(marker).exists() {
            assert!(Instant::now() < end, "missing {marker}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    fn start(&self) -> mpsc::Receiver<Value> {
        self.async_call("start", "start_conversation", json!({"workspaceRoot": self.workspace,"provider":"codex","message":"Do not replay this prompt"}))
    }
    fn attempt(&self) -> String {
        format!("attempt-{}", sha256_hex(b"start"))
    }
}
impl Drop for Harness {
    fn drop(&mut self) {
        // Fixture-owned marker cleanup, never used before cancellation assertions.
        let _ = fs::write(self.workspace.join(".fake-codex-stop.marker"), "cleanup");
        std::thread::sleep(Duration::from_millis(150));
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = self.root.path();
    }
}
fn connect(pipe: &str) -> NamedPipeClient {
    let end = Instant::now() + Duration::from_secs(10);
    loop {
        if let Ok(client) = NamedPipeClient::connect(pipe) {
            return client;
        }
        assert!(Instant::now() < end, "pipe unavailable");
        std::thread::sleep(Duration::from_millis(10));
    }
}
fn wire(pipe: &str, id: &str, kind: &str, payload: Value) -> Value {
    let mut client = connect(pipe);
    let bytes = serde_json::to_vec(&json!({"protocolVersion":"goalport.ipc.v2","requestId":id,"entityVersion":0,"messageType":kind,"payload":payload})).unwrap();
    client
        .write_all(&(bytes.len() as u32).to_le_bytes())
        .unwrap();
    client.write_all(&bytes).unwrap();
    let mut header = [0; 4];
    client.read_exact(&mut header).unwrap();
    let len = u32::from_le_bytes(header) as usize;
    assert!(len < 16 * 1024 * 1024);
    let mut body = vec![0; len];
    client.read_exact(&mut body).unwrap();
    serde_json::from_slice(&body).unwrap()
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
    let other = h.root.path().join("other");
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
        view.recv_timeout(Duration::from_secs(2)).unwrap()["ok"],
        true
    );
    let stopped = stop
        .recv_timeout(Duration::from_secs(2))
        .expect("Stop blocked");
    assert_eq!(
        stopped["payload"]["receipt"]["startupCancel"], "confirmed",
        "{stopped}"
    );
    assert_eq!(stopped["payload"]["receipt"]["nativePromptSent"], false);
    assert_eq!(
        start.recv_timeout(Duration::from_secs(2)).unwrap()["ok"],
        false
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
    let next = h.async_call("explicit-next", "conversation_send", json!({"campaignId": format!("campaign-{}",sha256_hex(b"start")),"attemptId":h.attempt(),"message":"Explicit new input"})).recv_timeout(Duration::from_secs(15)).expect("explicit next send failed to settle");
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
    assert_eq!(
        start.recv_timeout(Duration::from_secs(2)).unwrap()["ok"],
        false
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
        .expect("startup watchdog never returned the lend");
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
    let next = h.async_call("after-timeout-next", "conversation_send", json!({"campaignId":format!("campaign-{}",sha256_hex(b"start")),"attemptId":h.attempt(),"message":"Explicit timeout recovery"})).recv_timeout(Duration::from_secs(15)).unwrap();
    assert_eq!(next["ok"], true, "{next}");
}
#[test]
fn cancel_racing_initialize_never_confirms_a_dispatched_prompt() {
    let h = Harness::new("stall_initialize");
    let start = h.start();
    h.await_marker(".fake-codex-initialized.marker");
    let stop = h.async_call("race-stop", "safe_stop", json!({"attemptId":h.attempt()}));
    fs::write(h.workspace.join(".fake-codex-release"), "race release").unwrap();
    let stopped = stop.recv_timeout(Duration::from_secs(2)).unwrap();
    let returned = start.recv_timeout(Duration::from_secs(15)).unwrap();
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
    let started = h.start().recv_timeout(Duration::from_secs(15)).unwrap();
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
    let response = h.start().recv_timeout(Duration::from_secs(15)).unwrap();
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
    assert_eq!(a.recv_timeout(Duration::from_secs(2)).unwrap()["ok"], true);
    assert_eq!(b.recv_timeout(Duration::from_secs(2)).unwrap()["ok"], true);
}
