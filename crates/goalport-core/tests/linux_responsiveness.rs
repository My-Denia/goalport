#![cfg(target_os = "linux")]

use goalport_core::{
    commands::sha256_hex,
    domain::AttemptState,
    ipc::{CONNECTED_UI_PROTOCOL_VERSION, CoreServer},
    process_identity::{ProcessObservation, observe_process},
    product_receipts::{begin_startup_epoch, complete_startup_epoch},
    store::Store,
};
use serde_json::{Value, json};
use std::{
    fs,
    io::{Read, Write},
    os::unix::net::UnixStream,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

struct TestEnvironment(Vec<(&'static str, Option<std::ffi::OsString>)>);

impl TestEnvironment {
    fn set(changes: &[(&'static str, Option<std::ffi::OsString>)]) -> Self {
        let previous = changes
            .iter()
            .map(|(key, _)| (*key, std::env::var_os(key)))
            .collect();
        for (key, value) in changes {
            unsafe {
                if let Some(value) = value {
                    std::env::set_var(key, value)
                } else {
                    std::env::remove_var(key)
                }
            }
        }
        Self(previous)
    }
}

impl Drop for TestEnvironment {
    fn drop(&mut self) {
        for (key, value) in &self.0 {
            unsafe {
                if let Some(value) = value {
                    std::env::set_var(key, value)
                } else {
                    std::env::remove_var(key)
                }
            }
        }
    }
}

struct ReleaseOnDrop(PathBuf);
impl Drop for ReleaseOnDrop {
    fn drop(&mut self) {
        let _ = fs::write(&self.0, "release");
    }
}

fn python_executable() -> PathBuf {
    std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
        .map(|dir| dir.join("python3"))
        .find(|candidate| candidate.is_file())
        .and_then(|candidate| candidate.canonicalize().ok())
        .expect("python3 fixture interpreter must exist")
}

fn wire(sock: &Path, id: &str, kind: &str, payload: Value, timeout: Duration) -> Value {
    let request = json!({
        "protocolVersion": CONNECTED_UI_PROTOCOL_VERSION,
        "requestId": id,
        "entityVersion": 0,
        "messageType": kind,
        "payload": payload,
    })
    .to_string()
    .into_bytes();
    let mut stream = UnixStream::connect(sock).unwrap();
    stream.set_read_timeout(Some(timeout)).unwrap();
    stream.set_write_timeout(Some(timeout)).unwrap();
    stream
        .write_all(&(request.len() as u32).to_le_bytes())
        .unwrap();
    stream.write_all(&request).unwrap();
    let mut header = [0u8; 4];
    stream.read_exact(&mut header).unwrap();
    let length = u32::from_le_bytes(header) as usize;
    assert!(length < 16 * 1024 * 1024);
    let mut body = vec![0; length];
    stream.read_exact(&mut body).unwrap();
    serde_json::from_slice(&body).unwrap()
}

fn await_file(path: &Path) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !path.exists() {
        assert!(
            Instant::now() < deadline,
            "fixture did not reach {}",
            path.display()
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn await_turn(sock: &Path, state: &str) -> Value {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let view = wire(
            sock,
            "await-turn",
            "snapshot",
            json!({}),
            Duration::from_secs(2),
        );
        if view["payload"]["snapshot"]["productConversation"]["turn"]["state"] == state {
            return view;
        }
        assert!(
            Instant::now() < deadline,
            "turn never reached {state}: {view}"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn stalled_native_initialize_does_not_block_snapshot_other_session_or_cancel() {
    let home = tempfile::tempdir().unwrap();
    let first_workspace = home.path().join("first");
    let second_workspace = home.path().join("second");
    let bin = home.path().join("bin");
    fs::create_dir_all(&first_workspace).unwrap();
    fs::create_dir_all(&second_workspace).unwrap();
    fs::create_dir_all(&bin).unwrap();
    fs::copy(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/linux-codex-peer.py"),
        first_workspace.join("app-server"),
    )
    .unwrap();
    fs::write(first_workspace.join("peer-scenario"), "stall-initialize").unwrap();
    let _release = ReleaseOnDrop(first_workspace.join("release-initialize"));
    let python = python_executable();
    std::os::unix::fs::symlink(&python, bin.join("codex")).unwrap();
    assert_eq!(fs::canonicalize(bin.join("codex")).unwrap(), python);
    let mut paths = vec![bin.clone()];
    paths.extend(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    ));
    let path = std::env::join_paths(paths).unwrap();
    let _env = TestEnvironment::set(&[
        ("PATH", Some(path)),
        ("APPDATA", None),
        ("GOALPORT_CODEX_TRANSPORT", None),
        ("GOALPORT_TEST_SYNTHETIC_ONLY", None),
        (
            "GOALPORT_LAUNCH_NONCE",
            Some(format!("responsiveness-{}", std::process::id()).into()),
        ),
    ]);

    let store = Store::memory().unwrap();
    let db = home.path().join("core.sqlite");
    let epoch = begin_startup_epoch(&store, "responsive-peer", &db).unwrap();
    complete_startup_epoch(
        &store,
        "responsive-peer",
        &db,
        &epoch,
        &json!({"status":"completed"}),
    )
    .unwrap();
    let server = CoreServer::new(store.clone());
    let sock = home.path().join("core.sock");
    let server_thread = {
        let server = server.clone();
        let path = sock.clone();
        std::thread::spawn(move || server.serve_unix_socket_at(&path))
    };
    await_file(&sock);

    let first_request = "native-first";
    let first_attempt = format!("attempt-{}", sha256_hex(first_request.as_bytes()));
    let first_campaign = format!("campaign-{}", sha256_hex(first_request.as_bytes()));
    let first_call = {
        let path = sock.clone();
        let workspace = first_workspace.clone();
        std::thread::spawn(move || {
            wire(
                &path,
                first_request,
                "start_conversation",
                json!({
                    "workspaceRoot":workspace,"provider":"codex","message":"Fix a local bug"
                }),
                Duration::from_secs(5),
            )
        })
    };
    await_file(&first_workspace.join("initialize-entered"));

    let snapshot_started = Instant::now();
    let first_snapshot = wire(
        &sock,
        "during-initialize",
        "snapshot",
        json!({}),
        Duration::from_secs(2),
    );
    assert!(snapshot_started.elapsed() < Duration::from_secs(2));
    assert_eq!(first_snapshot["ok"], true, "{first_snapshot}");
    let snapshot = &first_snapshot["payload"]["snapshot"];
    assert_eq!(
        snapshot["productConversation"]["runtime"]["state"], "starting",
        "{snapshot}"
    );
    assert_eq!(snapshot["productConversation"]["turn"]["canSend"], false);
    assert!(
        snapshot["productConversation"]["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["kind"] == "user-message" && item["body"] == "Fix a local bug")
    );
    let revisioned = wire(
        &sock,
        "revision-initialize",
        "snapshot_if_changed",
        json!({}),
        Duration::from_secs(2),
    );
    let starting_revision = revisioned["payload"]["revision"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(revisioned["payload"]["unchanged"], false);
    let unchanged = wire(
        &sock,
        "same-revision",
        "snapshot_if_changed",
        json!({"revision":starting_revision}),
        Duration::from_secs(2),
    );
    assert_eq!(unchanged["payload"]["unchanged"], true);
    assert!(unchanged["payload"].get("snapshot").is_none());

    let competing_started = Instant::now();
    let competing = wire(
        &sock,
        "competing-first-send",
        "conversation_send",
        json!({
            "campaignId":first_campaign,"attemptId":first_attempt,"message":"do not send while starting"
        }),
        Duration::from_secs(2),
    );
    assert!(competing_started.elapsed() < Duration::from_secs(2));
    assert_eq!(competing["ok"], false, "{competing}");
    assert_eq!(
        fs::read_to_string(first_workspace.join("process-starts"))
            .unwrap()
            .lines()
            .count(),
        1
    );

    let other_started = Instant::now();
    let second = wire(
        &sock,
        "create-other",
        "create_campaign",
        json!({
            "workspaceRoot":second_workspace,"goal":"Another task","title":"Other"
        }),
        Duration::from_secs(2),
    );
    assert_eq!(second["ok"], true, "{second}");
    let other_campaign = second["payload"]["snapshot"]["activeCampaignId"]
        .as_str()
        .unwrap()
        .to_owned();
    let other_task = second["payload"]["snapshot"]["activeTask"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let selected = wire(
        &sock,
        "select-other",
        "select_runtime",
        json!({
            "campaignId":other_campaign,"taskId":other_task,"provider":"scenario"
        }),
        Duration::from_secs(2),
    );
    assert_eq!(selected["ok"], true, "{selected}");
    assert!(other_started.elapsed() < Duration::from_secs(2));
    let changed = wire(
        &sock,
        "after-other-selection",
        "snapshot_if_changed",
        json!({"revision":starting_revision}),
        Duration::from_secs(2),
    );
    assert_eq!(changed["payload"]["unchanged"], false);
    assert_ne!(changed["payload"]["revision"], starting_revision);

    let cancel_started = Instant::now();
    let cancelled = wire(
        &sock,
        "cancel-first",
        "interrupt",
        json!({"attemptId":first_attempt}),
        Duration::from_secs(2),
    );
    assert!(cancel_started.elapsed() < Duration::from_secs(2));
    assert_eq!(cancelled["ok"], true, "{cancelled}");
    assert_eq!(
        cancelled["payload"]["receipt"]["startupCancel"], "confirmed",
        "{cancelled}"
    );
    assert_eq!(cancelled["payload"]["receipt"]["nativePromptSent"], false);
    assert_eq!(
        store.get_attempt(&first_attempt).unwrap().state,
        AttemptState::Cancelled
    );
    assert_eq!(
        store
            .campaign_first_user_message(&first_campaign)
            .unwrap()
            .as_deref(),
        Some("Fix a local bug")
    );
    assert!(
        !first_workspace.join("turn-count").exists(),
        "no native prompt was sent"
    );
    assert_eq!(
        store
            .campaign_event_records(&first_campaign)
            .unwrap()
            .iter()
            .filter(|record| record.event.kind == "message.user")
            .count(),
        1
    );
    let first_response = first_call.join().unwrap();
    assert_eq!(first_response["ok"], false, "{first_response}");
    let current = wire(
        &sock,
        "after-native-cancel",
        "snapshot",
        json!({}),
        Duration::from_secs(2),
    );
    assert_eq!(
        current["payload"]["snapshot"]["activeCampaignId"],
        other_campaign
    );
    // A queued native admission takes the same worker path on explicit override.
    let queued_workspace = home.path().join("queued");
    fs::create_dir_all(&queued_workspace).unwrap();
    fs::copy(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/linux-codex-peer.py"),
        queued_workspace.join("app-server"),
    )
    .unwrap();
    fs::write(queued_workspace.join("peer-scenario"), "stall-initialize").unwrap();
    let _queued_release = ReleaseOnDrop(queued_workspace.join("release-initialize"));
    let queued_campaign = wire(
        &sock,
        "create-queued",
        "create_campaign",
        json!({
            "workspaceRoot":queued_workspace,"goal":"Queued work","title":"Queued"
        }),
        Duration::from_secs(2),
    );
    assert_eq!(queued_campaign["ok"], true, "{queued_campaign}");
    let queued_campaign_id = queued_campaign["payload"]["snapshot"]["activeCampaignId"]
        .as_str()
        .unwrap()
        .to_owned();
    let queued_task_id = queued_campaign["payload"]["snapshot"]["activeTask"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let queued = wire(
        &sock,
        "queue-native",
        "select_attempt",
        json!({
            "campaignId":queued_campaign_id,"taskId":queued_task_id,"provider":"CoDeX",
            "executable":"python3","resourcePressure":true
        }),
        Duration::from_secs(2),
    );
    assert_eq!(queued["ok"], true, "{queued}");
    let queue = store.get_admission("queue-queue-native").unwrap();
    let queued_attempt = queue.attempt_id.unwrap();
    let override_call = {
        let path = sock.clone();
        std::thread::spawn(move || {
            wire(
                &path,
                "override-native",
                "queue_override",
                json!({
                    "queueId":"queue-queue-native","reason":"local acceptance"
                }),
                Duration::from_secs(5),
            )
        })
    };
    await_file(&queued_workspace.join("initialize-entered"));
    let focused = wire(
        &sock,
        "focus-queued",
        "select_campaign",
        json!({
            "campaignId":queued_campaign_id
        }),
        Duration::from_secs(2),
    );
    assert_eq!(focused["ok"], true, "{focused}");
    let during_override = Instant::now();
    let view = wire(
        &sock,
        "queued-during-start",
        "snapshot",
        json!({}),
        Duration::from_secs(2),
    );
    assert_eq!(view["ok"], true, "{view}");
    assert!(during_override.elapsed() < Duration::from_secs(2));
    assert_eq!(
        view["payload"]["snapshot"]["productConversation"]["runtime"]["state"],
        "starting"
    );
    let queued_cancel = wire(
        &sock,
        "cancel-queued",
        "interrupt",
        json!({
            "attemptId":queued_attempt
        }),
        Duration::from_secs(2),
    );
    assert_eq!(
        queued_cancel["payload"]["receipt"]["startupCancel"], "confirmed",
        "{queued_cancel}"
    );
    assert_eq!(
        store.get_attempt(&queued_attempt).unwrap().state,
        AttemptState::Cancelled
    );
    assert!(!queued_workspace.join("turn-count").exists());
    assert_eq!(override_call.join().unwrap()["ok"], false);

    // A native handoff has two registrations to protect: the existing source
    // and the new target. Stalling the target's initialize must leave the
    // source attached and must not hold the UI lock.
    let handoff_workspace = home.path().join("handoff");
    fs::create_dir_all(&handoff_workspace).unwrap();
    fs::copy(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/linux-codex-peer.py"),
        handoff_workspace.join("app-server"),
    )
    .unwrap();
    let handoff_campaign = wire(
        &sock,
        "create-handoff",
        "create_campaign",
        json!({
            "workspaceRoot":handoff_workspace,"goal":"Handoff work","title":"Handoff"
        }),
        Duration::from_secs(2),
    );
    assert_eq!(handoff_campaign["ok"], true, "{handoff_campaign}");
    let handoff_campaign_id = handoff_campaign["payload"]["snapshot"]["activeCampaignId"]
        .as_str()
        .unwrap()
        .to_owned();
    let handoff_task_id = handoff_campaign["payload"]["snapshot"]["activeTask"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let source = wire(
        &sock,
        "select-handoff-source",
        "select_runtime",
        json!({
            "campaignId":handoff_campaign_id,"taskId":handoff_task_id,
            "provider":"codex","executable":"python3","version":"local-peer"
        }),
        Duration::from_secs(2),
    );
    assert_eq!(source["ok"], true, "{source}");
    let source_id = source["payload"]["snapshot"]["attempt"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let first = wire(
        &sock,
        "handoff-quota",
        "conversation_send",
        json!({
            "campaignId":handoff_campaign_id,"attemptId":source_id,"message":"first"
        }),
        Duration::from_secs(2),
    );
    assert_eq!(first["ok"], true, "{first}");
    await_turn(&sock, "failed");
    let second = wire(
        &sock,
        "handoff-complete",
        "conversation_send",
        json!({
            "campaignId":handoff_campaign_id,"attemptId":source_id,"message":"second"
        }),
        Duration::from_secs(2),
    );
    assert_eq!(second["ok"], true, "{second}");
    await_turn(&sock, "completed");
    let source_pid: u32 = fs::read_to_string(handoff_workspace.join("process-starts"))
        .unwrap()
        .lines()
        .next()
        .unwrap()
        .parse()
        .unwrap();
    assert!(matches!(
        observe_process(source_pid),
        ProcessObservation::Live(_)
    ));
    fs::write(handoff_workspace.join("peer-scenario"), "stall-initialize").unwrap();
    let _handoff_release = ReleaseOnDrop(handoff_workspace.join("release-initialize"));
    let handoff_call = {
        let path = sock.clone();
        let source = source_id.clone();
        std::thread::spawn(move || {
            wire(
                &path,
                "handoff-native",
                "handoff",
                json!({
                    "oldAttemptId":source,"provider":"codex",
                    "handoffInstruction":"Continue only after the source is settled."
                }),
                Duration::from_secs(5),
            )
        })
    };
    await_file(&handoff_workspace.join("initialize-entered"));
    let handoff_view_started = Instant::now();
    let handoff_view = wire(
        &sock,
        "during-handoff",
        "snapshot",
        json!({}),
        Duration::from_secs(2),
    );
    assert_eq!(handoff_view["ok"], true, "{handoff_view}");
    assert!(handoff_view_started.elapsed() < Duration::from_secs(2));
    let target_id = "attempt-handoff-handoff-native";
    let cancel_target = wire(
        &sock,
        "cancel-handoff-target",
        "interrupt",
        json!({
            "attemptId":target_id
        }),
        Duration::from_secs(2),
    );
    assert_eq!(
        cancel_target["payload"]["receipt"]["startupCancel"], "confirmed",
        "{cancel_target}"
    );
    assert_eq!(handoff_call.join().unwrap()["ok"], false);
    assert!(
        matches!(observe_process(source_pid), ProcessObservation::Live(_)),
        "source process was lost"
    );
    let source_again = wire(
        &sock,
        "reselect-handoff-source",
        "select_runtime",
        json!({
            "campaignId":handoff_campaign_id,"taskId":handoff_task_id,"attemptId":source_id,
            "provider":"codex","executable":"python3","version":"local-peer"
        }),
        Duration::from_secs(2),
    );
    assert_eq!(
        source_again["ok"], true,
        "source registration was not restored: {source_again}"
    );
    let _ = server_thread;
}
