#![cfg(target_os = "linux")]

use goalport_core::{
    domain::{AttemptState, Command, CommandState, Decision, DecisionState},
    ipc::{CONNECTED_UI_PROTOCOL_VERSION, CoreServer},
    process_identity::{ProcessIdentity, ProcessObservation, observe_process},
    product_receipts::{begin_startup_epoch, complete_startup_epoch},
    store::Store,
};
use serde_json::{Value, json};
use std::{
    env, fs,
    ffi::OsString,
    path::{Path, PathBuf},
    sync::{Mutex, mpsc},
    time::{Duration, Instant},
};

static SERIAL: Mutex<()> = Mutex::new(());

struct ReleaseOnDrop(PathBuf);
impl Drop for ReleaseOnDrop {
    fn drop(&mut self) {
        let _ = fs::write(&self.0, "release");
    }
}

struct ContinueOwnedShim(ProcessIdentity);
impl Drop for ContinueOwnedShim {
    fn drop(&mut self) {
        if let ProcessObservation::Live(current) = observe_process(self.0.pid)
            && current.creation_date() == self.0.creation_date()
            && current.parent_pid == self.0.parent_pid
        {
            unsafe { libc::kill(self.0.pid as libc::pid_t, libc::SIGCONT) };
        }
    }
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

fn write_exec_shim(workspace: &Path) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;

    let shim = workspace.join("codex-shim");
    fs::write(&shim, "#!/bin/sh\nset -eu\nIFS= read -r request\nprintf '%s' \"$request\" > shim-initialize.json\nprintf '%s' \"$$\" > shim-pid\nkill -STOP $$\nexec python3 app-server \"$@\"\n").unwrap();
    fs::set_permissions(&shim, fs::Permissions::from_mode(0o700)).unwrap();
    shim
}

struct LaunchNonceGuard(Option<std::ffi::OsString>);

impl LaunchNonceGuard {
    fn set(value: String) -> Self {
        let previous = std::env::var_os("GOALPORT_LAUNCH_NONCE");
        unsafe { std::env::set_var("GOALPORT_LAUNCH_NONCE", value) };
        Self(previous)
    }
}

impl Drop for LaunchNonceGuard {
    fn drop(&mut self) {
        unsafe {
            if let Some(previous) = &self.0 {
                std::env::set_var("GOALPORT_LAUNCH_NONCE", previous);
            } else {
                std::env::remove_var("GOALPORT_LAUNCH_NONCE");
            }
        }
    }
}

fn request(server: &CoreServer, id: &str, kind: &str, payload: Value) -> Value {
    let wire = json!({
        "protocolVersion": CONNECTED_UI_PROTOCOL_VERSION,
        "requestId": id,
        "entityVersion": 0,
        "messageType": kind,
        "payload": payload,
    });
    server.handle_json(wire.to_string().as_bytes()).unwrap()
}

fn accepted(server: &CoreServer, id: &str, kind: &str, payload: Value) -> Value {
    let response = request(server, id, kind, payload);
    assert_eq!(response["ok"], true, "{response}");
    response["payload"]["snapshot"].clone()
}

fn wait_for_turn(server: &CoreServer, state: &str) -> Value {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let snapshot = accepted(
            server,
            &format!("snapshot-{}", state),
            "snapshot",
            json!({}),
        );
        if snapshot["productConversation"]["turn"]["state"] == state {
            return snapshot;
        }
        assert!(
            Instant::now() < deadline,
            "turn never reached {state}: {snapshot}"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn seed_core_epoch(store: &Store, workspace: &Path, label: &str) {
    let db = workspace.join("core-fixture.sqlite");
    let _nonce = LaunchNonceGuard::set(format!("{label}-{}", std::process::id()));
    let epoch = begin_startup_epoch(store, label, &db).unwrap();
    complete_startup_epoch(store, label, &db, &epoch, &json!({"status":"completed"})).unwrap();
}

struct LocalCodexPath {
    path: Option<OsString>,
    app_data: Option<OsString>,
}

impl LocalCodexPath {
    fn install(workspace: &Path) -> Self {
        use std::os::unix::fs::PermissionsExt;

        let stub = workspace.join("codex");
        fs::write(&stub, "#!/bin/sh\nexec python3 app-server \"$@\"\n").unwrap();
        fs::set_permissions(&stub, fs::Permissions::from_mode(0o700)).unwrap();
        let previous = env::var_os("PATH");
        let app_data = env::var_os("APPDATA");
        let mut paths = vec![workspace.to_path_buf()];
        if let Some(previous) = &previous {
            paths.extend(env::split_paths(previous));
        }
        unsafe {
            env::set_var("PATH", env::join_paths(paths).unwrap());
            // Native resolution checks APPDATA before PATH even on Linux.
            // Pin both lookups to this synthetic workspace.
            env::set_var("APPDATA", workspace);
        };
        Self { path: previous, app_data }
    }
}

impl Drop for LocalCodexPath {
    fn drop(&mut self) {
        unsafe {
            if let Some(previous) = &self.path {
                env::set_var("PATH", previous);
            } else {
                env::remove_var("PATH");
            }
            if let Some(previous) = &self.app_data {
                env::set_var("APPDATA", previous);
            } else {
                env::remove_var("APPDATA");
            }
        }
    }
}

fn persisted_peer_session(workspace: &Path, store: &Store, scenario: &str) -> (String, String) {
    fs::copy(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/linux-codex-peer.py"),
        workspace.join("app-server"),
    )
    .unwrap();
    fs::write(workspace.join("peer-scenario"), scenario).unwrap();
    seed_core_epoch(store, workspace, "restart-fixture");
    let server = CoreServer::new(store.clone());
    let created = accepted(
        &server,
        "create-restart",
        "create_campaign",
        json!({"workspaceRoot":workspace,"goal":"Resume finished local work","title":"Restart example"}),
    );
    let campaign_id = created["activeCampaignId"].as_str().unwrap().to_owned();
    let task_id = created["activeTask"]["id"].as_str().unwrap();
    let selected = accepted(
        &server,
        "select-restart-peer",
        "select_runtime",
        json!({
            "campaignId":campaign_id,
            "taskId":task_id,
            "provider":"codex",
            "version":"local-peer",
            "executable":"python3"
        }),
    );
    let attempt_id = selected["attempt"]["id"].as_str().unwrap().to_owned();
    accepted(
        &server,
        "send-before-restart",
        "conversation_send",
        json!({"campaignId":campaign_id,"attemptId":attempt_id,"message":"one local turn"}),
    );
    wait_for_turn(&server, if scenario == "stall-turn" { "running" } else { "completed" });
    assert_eq!(fs::read_to_string(workspace.join("turn-count")).unwrap(), "1");
    assert_eq!(fs::read_to_string(workspace.join("turn-starts")).unwrap().lines().count(), 1);
    drop(server);
    if scenario != "stall-turn" {
        // The persisted completed native turn can coexist with an Active
        // Attempt after review/continuation. Keep that exact restart edge in
        // the fixture instead of relying on AwaitingReview's terminal view.
        let row = store.get_attempt(&attempt_id).unwrap();
        if row.state != AttemptState::Active {
            store
                .append_event_with_state(
                    &goalport_core::Event {
                        id: "return-to-active-after-completion".into(),
                        attempt_id: attempt_id.clone(),
                        seq: row.last_event_seq + 1,
                        kind: "attempt.active".into(),
                        payload_ref: None,
                    },
                    Some(AttemptState::Active),
                    None,
                )
                .unwrap();
        }
        assert_eq!(store.get_attempt(&attempt_id).unwrap().state, AttemptState::Active);
    }
    (campaign_id, attempt_id)
}

#[test]
fn completed_turn_after_core_restart_offers_exact_resume_without_prompt_replay() {
    let _serial = SERIAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let workspace = tempfile::tempdir().unwrap();
    let store = Store::memory().unwrap();
    let (campaign_id, attempt_id) =
        persisted_peer_session(workspace.path(), &store, "complete-first");
    let _path = LocalCodexPath::install(workspace.path());
    let server = CoreServer::new(store.clone());

    let detached = accepted(&server, "detached-completed", "snapshot", json!({}));
    assert_eq!(detached["productConversation"]["turn"]["state"], "completed");
    assert_eq!(detached["productConversation"]["session"]["state"], "detached");
    assert_eq!(detached["productConversation"]["turn"]["canSend"], false);
    assert!(detached["productConversation"]["turn"]["actions"]
        .as_array()
        .unwrap()
        .iter()
        .any(|action| action == "resume-session"));
    assert_eq!(detached["productConversation"]["turn"]["reasonCode"], "session-detached");
    assert_eq!(
        detached["productConversation"]["turn"]["reason"],
        "Resume this session to continue. Earlier messages will not be sent again."
    );
    let before_messages = store
        .list_event_records(&attempt_id, 0)
        .unwrap()
        .iter()
        .filter(|event| event.event.kind == "message.user")
        .count();
    let early_send = request(
        &server,
        "send-before-explicit-resume",
        "conversation_send",
        json!({"campaignId":campaign_id,"attemptId":attempt_id,"message":"not sent"}),
    );
    assert_eq!(early_send["ok"], false, "{early_send}");
    assert!(early_send["error"].as_str().unwrap_or_default().contains("Resume"));
    assert_eq!(
        store.list_event_records(&attempt_id, 0).unwrap().iter()
            .filter(|event| event.event.kind == "message.user").count(),
        before_messages
    );
    assert_eq!(fs::read_to_string(workspace.path().join("turn-count")).unwrap(), "1");
    assert_eq!(fs::read_to_string(workspace.path().join("turn-starts")).unwrap().lines().count(), 1);

    let resumed = request(
        &server,
        "resume-exact-local-thread",
        "resume_native_session",
        json!({"attemptId":attempt_id}),
    );
    assert_eq!(resumed["ok"], true, "advertised Resume must work: {resumed}");
    assert_eq!(fs::read_to_string(workspace.path().join("resume-requested-thread")).unwrap(), "local-thread");
    let attached = accepted(&server, "attached-after-resume", "snapshot", json!({}));
    assert_eq!(attached["productConversation"]["session"]["state"], "attached");
    assert_eq!(attached["productConversation"]["turn"]["canSend"], true);
    assert_eq!(fs::read_to_string(workspace.path().join("turn-count")).unwrap(), "1");
    assert_eq!(fs::read_to_string(workspace.path().join("turn-starts")).unwrap().lines().count(), 1);
    accepted(&server, "close-resumed", "close_session", json!({"attemptId":attempt_id}));
}

#[test]
fn review_checkpoint_after_core_restart_explains_resume_in_plain_language() {
    let _serial = SERIAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let workspace = tempfile::tempdir().unwrap();
    let store = Store::memory().unwrap();
    let (_campaign_id, attempt_id) =
        persisted_peer_session(workspace.path(), &store, "complete-first");
    let row = store.get_attempt(&attempt_id).unwrap();
    store
        .append_event_with_state(
            &goalport_core::Event {
                id: "review-after-restart".into(),
                attempt_id: attempt_id.clone(),
                seq: row.last_event_seq + 1,
                kind: "attempt.awaiting_review".into(),
                payload_ref: None,
            },
            Some(AttemptState::AwaitingReview),
            None,
        )
        .unwrap();
    let server = CoreServer::new(store);
    let snapshot = accepted(&server, "review-resume-copy", "snapshot", json!({}));
    let turn = &snapshot["productConversation"]["turn"];
    assert_eq!(snapshot["productConversation"]["session"]["state"], "detached");
    assert_eq!(turn["state"], "completed");
    assert!(turn["actions"].as_array().unwrap().iter().any(|action| action == "resume-session"));
    assert_eq!(turn["reasonCode"], "session-detached");
    assert_eq!(turn["reason"], "Resume this session to continue. Earlier messages will not be sent again.");
}

#[test]
fn invalid_resume_response_never_attaches_or_replays_prompt() {
    let _serial = SERIAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    for scenario in ["resume-wrong-id", "resume-missing-id", "resume-error"] {
        let workspace = tempfile::tempdir().unwrap();
        let store = Store::memory().unwrap();
        let (_campaign_id, attempt_id) =
            persisted_peer_session(workspace.path(), &store, "complete-first");
        fs::write(workspace.path().join("peer-scenario"), scenario).unwrap();
        let _path = LocalCodexPath::install(workspace.path());
        let server = CoreServer::new(store.clone());
        let refused = request(
            &server,
            &format!("resume-{scenario}"),
            "resume_native_session",
            json!({"attemptId":attempt_id}),
        );
        assert_eq!(refused["ok"], false, "{scenario}: {refused}");
        assert!(refused["error"].as_str().unwrap_or_default().contains("resume"));
        let snapshot = accepted(&server, &format!("after-{scenario}"), "snapshot", json!({}));
        assert_ne!(snapshot["productConversation"]["session"]["state"], "attached");
        assert_eq!(snapshot["productConversation"]["turn"]["canSend"], false);
        let send = request(
            &server,
            &format!("send-after-{scenario}"),
            "conversation_send",
            json!({"campaignId":_campaign_id,"attemptId":attempt_id,"message":"not sent"}),
        );
        assert_eq!(send["ok"], false, "{scenario}: {send}");
        assert_eq!(fs::read_to_string(workspace.path().join("resume-requested-thread")).unwrap(), "local-thread");
        assert_eq!(fs::read_to_string(workspace.path().join("turn-count")).unwrap(), "1");
        assert_eq!(fs::read_to_string(workspace.path().join("turn-starts")).unwrap().lines().count(), 1);
        let events = store.list_event_records(&attempt_id, 0).unwrap();
        assert!(events.iter().any(|event| event.event.kind == "runtime.session.resumed"
            && event.payload.as_ref().is_some_and(|payload| payload["resumed"] == false)));
        assert!(!events.iter().any(|event| event.event.kind == "runtime.registration.established"
            && event.payload.as_ref().is_some_and(|payload| payload["cause"] == "resume_native_session")));
    }
}

#[test]
fn unfinished_turn_after_core_restart_refuses_resume_before_native_start() {
    let _serial = SERIAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let workspace = tempfile::tempdir().unwrap();
    let store = Store::memory().unwrap();
    let (_campaign_id, attempt_id) = persisted_peer_session(workspace.path(), &store, "stall-turn");
    let _path = LocalCodexPath::install(workspace.path());
    let server = CoreServer::new(store.clone());
    let uncertain = accepted(&server, "unfinished-after-restart", "snapshot", json!({}));
    assert_eq!(uncertain["productConversation"]["turn"]["state"], "uncertain");
    assert!(!uncertain["productConversation"]["turn"]["actions"]
        .as_array()
        .unwrap()
        .iter()
        .any(|action| action == "resume-session"));
    let refused = request(
        &server,
        "resume-unfinished",
        "resume_native_session",
        json!({"attemptId":attempt_id}),
    );
    assert_eq!(refused["ok"], false, "{refused}");
    assert!(refused["error"].as_str().unwrap_or_default().contains("unresolved"));
    assert_eq!(fs::read_to_string(workspace.path().join("process-starts")).unwrap().lines().count(), 1);
    assert_eq!(fs::read_to_string(workspace.path().join("turn-count")).unwrap(), "1");
    assert_eq!(fs::read_to_string(workspace.path().join("turn-starts")).unwrap().lines().count(), 1);
}

#[test]
fn unknown_delivery_after_core_restart_cannot_resume_or_replay() {
    let _serial = SERIAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let workspace = tempfile::tempdir().unwrap();
    let store = Store::memory().unwrap();
    let (_campaign_id, attempt_id) =
        persisted_peer_session(workspace.path(), &store, "complete-first");
    store
        .record_command(&Command {
            id: "lost-delivery-receipt".into(),
            attempt_id: attempt_id.clone(),
            kind: "runtime.send".into(),
            payload_hash: "local-fixture".into(),
            state: CommandState::Unknown,
        })
        .unwrap();
    let _path = LocalCodexPath::install(workspace.path());
    let server = CoreServer::new(store.clone());
    let uncertain = accepted(&server, "unknown-delivery-snapshot", "snapshot", json!({}));
    assert_eq!(uncertain["productConversation"]["turn"]["state"], "uncertain");
    assert!(!uncertain["productConversation"]["turn"]["actions"]
        .as_array()
        .unwrap()
        .iter()
        .any(|action| action == "resume-session"));
    let refused = request(
        &server,
        "resume-unknown-delivery",
        "resume_native_session",
        json!({"attemptId":attempt_id}),
    );
    assert_eq!(refused["ok"], false, "{refused}");
    assert!(refused["error"].as_str().unwrap_or_default().contains("unresolved"));
    assert_eq!(fs::read_to_string(workspace.path().join("process-starts")).unwrap().lines().count(), 1);
    assert_eq!(fs::read_to_string(workspace.path().join("turn-starts")).unwrap().lines().count(), 1);
}

#[test]
fn quota_failed_turn_keeps_session_for_explicit_next_send() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let workspace = tempfile::tempdir().unwrap();
    fs::copy(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/linux-codex-peer.py"),
        workspace.path().join("app-server"),
    )
    .unwrap();
    let store = Store::memory().unwrap();
    seed_core_epoch(&store, workspace.path(), "quota-fixture");
    let server = CoreServer::new(store.clone());
    let created = accepted(
        &server,
        "create-quota",
        "create_campaign",
        json!({"workspaceRoot":workspace.path(),"goal":"Fix a local test","title":"Quota example"}),
    );
    let campaign_id = created["activeCampaignId"].as_str().unwrap().to_owned();
    let task_id = created["activeTask"]["id"].as_str().unwrap().to_owned();
    let selected = accepted(
        &server,
        "select-local-peer",
        "select_runtime",
        json!({
            "campaignId":campaign_id,
            "taskId":task_id,
            "provider":"codex",
            "version":"local-peer",
            "executable":"python3"
        }),
    );
    let attempt_id = selected["attempt"]["id"].as_str().unwrap().to_owned();
    accepted(
        &server,
        "send-first",
        "conversation_send",
        json!({"campaignId":campaign_id,"attemptId":attempt_id,"message":"first local turn"}),
    );
    let failed = wait_for_turn(&server, "failed");
    assert_eq!(
        failed["productConversation"]["turn"]["reasonCode"],
        "provider-quota"
    );
    assert_eq!(failed["productConversation"]["turn"]["canSend"], true);
    assert_eq!(
        failed["productConversation"]["session"]["state"],
        "attached"
    );
    assert_eq!(
        store.get_attempt(&attempt_id).unwrap().state,
        AttemptState::Active
    );
    assert!(
        failed["productConversation"]["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["kind"] == "actionable-error"
                && item["body"].as_str().unwrap().contains("usage limit"))
    );
    assert_eq!(
        fs::read_to_string(workspace.path().join("turn-count")).unwrap(),
        "1"
    );

    accepted(
        &server,
        "send-second",
        "conversation_send",
        json!({"campaignId":campaign_id,"attemptId":attempt_id,"message":"continue explicitly"}),
    );
    let completed = wait_for_turn(&server, "completed");
    assert_eq!(completed["productConversation"]["turn"]["canSend"], true);
    assert_eq!(
        completed["productConversation"]["resultSummary"],
        "local peer completed"
    );
    assert_eq!(
        fs::read_to_string(workspace.path().join("turn-count")).unwrap(),
        "2"
    );
    assert!(
        completed["productConversation"]["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["kind"] == "assistant-message"
                && item["body"]
                    .as_str()
                    .unwrap()
                    .contains("local peer completed"))
    );

    let closed = accepted(
        &server,
        "close-local-session",
        "close_session",
        json!({"attemptId":attempt_id}),
    );
    assert_eq!(closed["productConversation"]["session"]["state"], "closed");
    assert_eq!(
        store.get_attempt(&attempt_id).unwrap().state,
        AttemptState::Closed
    );
    let duplicate = request(
        &server,
        "close-local-session-again",
        "close_session",
        json!({"attemptId":attempt_id}),
    );
    assert_eq!(duplicate["ok"], true, "{duplicate}");
    assert_eq!(duplicate["payload"]["duplicate"], true);
    let after_close = request(
        &server,
        "resume-closed",
        "resume_native_session",
        json!({"attemptId":attempt_id}),
    );
    assert_eq!(
        after_close["ok"], false,
        "closed Attempt must not resume: {after_close}"
    );
    assert!(after_close["error"].as_str().unwrap().contains("terminal"));
    assert_eq!(
        fs::read_to_string(workspace.path().join("process-starts"))
            .unwrap()
            .lines()
            .count(),
        1
    );
}

#[test]
fn native_permission_denial_reaches_peer_and_turn_continues() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let workspace = tempfile::tempdir().unwrap();
    fs::copy(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/linux-codex-peer.py"),
        workspace.path().join("app-server"),
    )
    .unwrap();
    fs::write(workspace.path().join("peer-scenario"), "permission-deny").unwrap();
    let store = Store::memory().unwrap();
    seed_core_epoch(&store, workspace.path(), "permission-fixture");
    let server = CoreServer::new(store);
    let created = accepted(
        &server,
        "create-permission",
        "create_campaign",
        json!({
            "workspaceRoot":workspace.path(),"goal":"Permission local case","title":"Permission"
        }),
    );
    let campaign_id = created["activeCampaignId"].as_str().unwrap().to_owned();
    let task_id = created["activeTask"]["id"].as_str().unwrap().to_owned();
    let selected = accepted(
        &server,
        "select-permission",
        "select_runtime",
        json!({
            "campaignId":campaign_id,"taskId":task_id,"provider":"codex",
            "version":"local-peer","executable":"python3"
        }),
    );
    let attempt_id = selected["attempt"]["id"].as_str().unwrap().to_owned();
    accepted(
        &server,
        "send-permission",
        "conversation_send",
        json!({
            "campaignId":campaign_id,"attemptId":attempt_id,"message":"request a local permission"
        }),
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    let decision_id = loop {
        let snapshot = accepted(&server, "permission-snapshot", "snapshot", json!({}));
        if let Some(id) = snapshot["decisions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|decision| decision["state"] == "pending")
            .and_then(|decision| decision["id"].as_str())
        {
            break id.to_owned();
        }
        assert!(
            Instant::now() < deadline,
            "native permission never appeared"
        );
        std::thread::sleep(Duration::from_millis(10));
    };
    accepted(
        &server,
        "deny-permission",
        "permission_response",
        json!({
            "decisionId":decision_id,"allow":false
        }),
    );
    let completed = wait_for_turn(&server, "completed");
    assert_eq!(completed["decisions"][0]["state"], "resolved");
    assert_eq!(
        fs::read_to_string(workspace.path().join("permission-decision")).unwrap(),
        "decline"
    );
}

fn open_codex_permission(scenario: &str) -> (tempfile::TempDir, Store, CoreServer, String) {
    let workspace = tempfile::tempdir().unwrap();
    fs::copy(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/linux-codex-peer.py"),
        workspace.path().join("app-server"),
    )
    .unwrap();
    fs::write(workspace.path().join("peer-scenario"), scenario).unwrap();
    let store = Store::memory().unwrap();
    seed_core_epoch(&store, workspace.path(), scenario);
    let server = CoreServer::new(store.clone());
    let created = accepted(
        &server,
        &format!("{scenario}-create"),
        "create_campaign",
        json!({
            "workspaceRoot": workspace.path(),
            "goal": "Permission local case",
            "title": "Permission"
        }),
    );
    let campaign_id = created["activeCampaignId"].as_str().unwrap().to_owned();
    let task_id = created["activeTask"]["id"].as_str().unwrap().to_owned();
    let selected = accepted(
        &server,
        &format!("{scenario}-select"),
        "select_runtime",
        json!({
            "campaignId": campaign_id,
            "taskId": task_id,
            "provider": "codex",
            "version": "local-peer",
            "executable": "python3"
        }),
    );
    let attempt_id = selected["attempt"]["id"].as_str().unwrap().to_owned();
    accepted(
        &server,
        &format!("{scenario}-send"),
        "conversation_send",
        json!({
            "campaignId": campaign_id,
            "attemptId": attempt_id,
            "message": "request a local permission"
        }),
    );
    (workspace, store, server, attempt_id)
}

fn snapshot_of(server: &CoreServer, label: &str) -> Value {
    accepted(server, label, "snapshot", json!({}))
}

fn decisions_for(store: &Store, attempt_id: &str) -> Vec<Decision> {
    let mut rows = store
        .list_decisions()
        .unwrap()
        .into_iter()
        .filter(|row| row.attempt_id == attempt_id)
        .collect::<Vec<_>>();
    rows.sort_by(|left, right| left.id.cmp(&right.id));
    rows
}

#[test]
fn permission_wait_drains_later_stdout() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let (_workspace, _store, server, _attempt_id) = open_codex_permission("permission-drain");
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let snapshot = snapshot_of(&server, "drain-snapshot");
        let pending = snapshot["decisions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|decision| decision["state"] == "pending");
        let drained = snapshot.to_string().contains("drained-while-pending");
        if pending && drained {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "stdout after the approval was not visible while the decision stayed pending: {snapshot}"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn permission_answer_binds_live_identity() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let (workspace, store, server, attempt_id) = open_codex_permission("permission-identity");
    let deadline = Instant::now() + Duration::from_secs(5);
    let decision_id = loop {
        let snapshot = snapshot_of(&server, "identity-snapshot");
        if let Some(id) = snapshot["decisions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|decision| decision["state"] == "pending")
            .and_then(|decision| decision["id"].as_str())
        {
            break id.to_owned();
        }
        assert!(
            Instant::now() < deadline,
            "native permission never appeared"
        );
        std::thread::sleep(Duration::from_millis(10));
    };
    assert!(
        decision_id.starts_with("codex-decision-"),
        "{decision_id}"
    );
    assert_ne!(decision_id, "rpc-A");
    let records = store.list_event_records(&attempt_id, 0).unwrap();
    let payload = records
        .iter()
        .find_map(|record| {
            record.payload.as_ref().filter(|payload| {
                payload.get("providerRpcId").and_then(Value::as_str) == Some("rpc-A")
            })
        })
        .expect("permission event");
    assert_eq!(payload["request_id"], decision_id);
    assert_eq!(payload["threadId"], "T");
    assert_eq!(payload["turnId"], "U");
    assert_eq!(payload["itemId"], "I");
    assert_eq!(payload["providerRequestId"], "other");
    accepted(
        &server,
        "identity-allow",
        "permission_response",
        json!({"decisionId": decision_id, "allow": true}),
    );
    let file = workspace.path().join("permission-decision");
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if file.is_file() && fs::read_to_string(&file).unwrap() == "rpc-A accept\n" {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "peer did not record one rpc-A accept"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    let second = request(
        &server,
        "identity-allow-again",
        "permission_response",
        json!({"decisionId": "rpc-A", "allow": true}),
    );
    assert_eq!(second["ok"], false, "{second}");
    assert_eq!(fs::read_to_string(&file).unwrap(), "rpc-A accept\n");
    assert_eq!(
        store.get_decision(&decision_id).unwrap().state,
        DecisionState::Approved
    );
}

#[test]
fn stop_during_permission_does_not_accept() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let (workspace, store, server, attempt_id) = open_codex_permission("permission-stop");
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let snapshot = snapshot_of(&server, "stop-wait");
        let pending = snapshot["decisions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|decision| decision["state"] == "pending");
        if pending {
            break;
        }
        assert!(Instant::now() < deadline, "permission never became pending");
        std::thread::sleep(Duration::from_millis(10));
    }
    let stopped = request(
        &server,
        "stop-during-permission",
        "interrupt",
        json!({"attemptId": attempt_id}),
    );
    assert_eq!(stopped["ok"], true, "{stopped}");
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let snapshot = snapshot_of(&server, "stop-settled");
        let turn = snapshot["productConversation"]["turn"]["state"]
            .as_str()
            .unwrap_or("");
        let pending = snapshot["decisions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|decision| decision["state"] == "pending");
        if !pending && turn != "waiting-permission" && turn != "running" && turn != "stopping" {
            assert_eq!(
                snapshot["productConversation"]["turn"]["canSend"], true,
                "{snapshot}"
            );
            break;
        }
        assert!(
            Instant::now() < deadline,
            "stop left the turn waiting: {snapshot}"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    let rows = decisions_for(&store, &attempt_id);
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0].state, DecisionState::Cancelled);
    assert_ne!(rows[0].state, DecisionState::Approved);
    let record = workspace.path().join("permission-decision");
    if record.exists() {
        let text = fs::read_to_string(record).unwrap();
        assert!(!text.contains("accept"), "{text}");
    }
}

#[test]
fn permission_eof_clears_pending() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let (_workspace, store, server, attempt_id) = open_codex_permission("permission-eof");
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let rows = decisions_for(&store, &attempt_id);
        let attempt = store.get_attempt(&attempt_id).unwrap();
        if rows.first().is_some_and(|row| row.state == DecisionState::Cancelled)
            && attempt.state == AttemptState::Failed
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "eof left decisions {rows:?} attempt {:?}",
            attempt.state
        );
        std::thread::sleep(Duration::from_millis(10));
        let _ = snapshot_of(&server, "eof-poll");
    }
    let snapshot = snapshot_of(&server, "eof-final");
    let turn = snapshot["productConversation"]["turn"]["state"]
        .as_str()
        .unwrap();
    assert_ne!(turn, "waiting-permission");
    assert_ne!(turn, "running");
    let rows = decisions_for(&store, &attempt_id);
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0].state, DecisionState::Cancelled);
}

#[test]
fn stop_before_approval_is_drained_does_not_leave_pending() {
    let _serial = SERIAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let (workspace, store, server, attempt_id) = open_codex_permission("permission-stop");
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let snapshot = snapshot_of(&server, "stop-early-wait");
        if snapshot["productConversation"]["turn"]["canStop"] == true {
            break;
        }
        assert!(Instant::now() < deadline, "turn never became stoppable");
        std::thread::sleep(Duration::from_millis(10));
    }
    let stopped = request(
        &server,
        "stop-before-drain",
        "interrupt",
        json!({"attemptId": attempt_id}),
    );
    assert_eq!(stopped["ok"], true, "{stopped}");
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let _ = snapshot_of(&server, "stop-early-settle");
        let rows = decisions_for(&store, &attempt_id);
        let pending = rows.iter().any(|row| row.state == DecisionState::Pending);
        let attempt = store.get_attempt(&attempt_id).unwrap();
        if !pending && attempt.state.is_terminal() {
            if let Some(row) = rows.first() {
                assert_ne!(row.state, DecisionState::Approved);
            }
            for _ in 0..20 {
                let _ = snapshot_of(&server, "stop-early-after");
                std::thread::sleep(Duration::from_millis(20));
            }
            let rows = decisions_for(&store, &attempt_id);
            assert!(
                rows.len() == 1 && rows[0].state != DecisionState::Pending,
                "approval became pending after stop settled: {rows:?}"
            );
            assert_ne!(rows[0].state, DecisionState::Approved);
            break;
        }
        assert!(
            Instant::now() < deadline,
            "stop left a pending approval: {rows:?} attempt {:?}",
            attempt.state
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    let record = workspace.path().join("permission-decision");
    if record.exists() {
        let text = fs::read_to_string(record).unwrap();
        assert!(!text.contains("accept"), "{text}");
    }
}

#[test]
fn approval_after_terminal_is_not_left_pending() {
    let _serial = SERIAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let (workspace, store, server, attempt_id) = open_codex_permission("permission-after-terminal");
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if workspace.path().join("terminal-visible").is_file() {
            let attempt = store.get_attempt(&attempt_id).unwrap();
            if attempt.state == AttemptState::AwaitingReview || attempt.state.is_terminal() {
                break;
            }
        }
        let _ = snapshot_of(&server, "late-approval-wait");
        assert!(
            Instant::now() < deadline,
            "turn never finished before the late approval; files={:?}",
            std::fs::read_dir(workspace.path())
                .map(|entries| entries.filter_map(|entry| entry.ok()).map(|entry| entry.file_name()).collect::<Vec<_>>())
                .ok()
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    fs::write(workspace.path().join("release-late-approval"), "go").unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let _ = snapshot_of(&server, "late-approval-settle");
        let rows = decisions_for(&store, &attempt_id);
        if rows.first().is_some_and(|row| row.state == DecisionState::Cancelled) {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "late approval stayed unresolved: {rows:?}"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    let record = workspace.path().join("permission-decision");
    if record.exists() {
        assert!(!fs::read_to_string(record).unwrap().contains("accept"));
    }
}


fn wait_for_decisions(store: &Store, server: &CoreServer, attempt_id: &str, count: usize) -> Vec<Decision> {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let _ = snapshot_of(server, "decision-wait");
        let rows = decisions_for(store, attempt_id);
        if rows.len() >= count {
            return rows;
        }
        assert!(
            Instant::now() < deadline,
            "expected {count} decisions, saw {rows:?}"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn two_approvals_on_one_turn_are_answered_separately() {
    let _serial = SERIAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let (workspace, store, server, attempt_id) = open_codex_permission("permission-two");
    let rows = wait_for_decisions(&store, &server, &attempt_id, 2);
    assert!(rows.iter().all(|row| row.state == DecisionState::Pending));
    assert!(rows.iter().all(|row| row.id.starts_with("codex-decision-")));
    let records = store.list_event_records(&attempt_id, 0).unwrap();
    let decision_for = |rpc: &str| -> String {
        records
            .iter()
            .find_map(|record| {
                let payload = record.payload.as_ref()?;
                (payload.get("providerRpcId").and_then(Value::as_str) == Some(rpc))
                    .then(|| payload["request_id"].as_str().unwrap().to_owned())
            })
            .unwrap_or_else(|| panic!("missing {rpc}"))
    };
    let allow_id = decision_for("rpc-A");
    let deny_id = decision_for("rpc-B");
    assert_ne!(allow_id, deny_id);
    accepted(
        &server,
        "two-allow",
        "permission_response",
        json!({"decisionId": allow_id, "allow": true}),
    );
    accepted(
        &server,
        "two-deny",
        "permission_response",
        json!({"decisionId": deny_id, "allow": false}),
    );
    let file = workspace.path().join("permission-decision");
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if file.is_file() {
            let text = fs::read_to_string(&file).unwrap();
            if text.contains("rpc-A accept\n") && text.contains("rpc-B decline\n") {
                break;
            }
        }
        assert!(Instant::now() < deadline, "peer did not record both answers");
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(store.get_decision(&allow_id).unwrap().state, DecisionState::Approved);
    assert_eq!(store.get_decision(&deny_id).unwrap().state, DecisionState::Denied);
}

#[test]
fn stop_after_two_approvals_writes_no_accept() {
    let _serial = SERIAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let (workspace, store, server, attempt_id) = open_codex_permission("permission-two-stop");
    let rows = wait_for_decisions(&store, &server, &attempt_id, 2);
    assert!(rows.iter().all(|row| row.state == DecisionState::Pending));
    let stopped = request(
        &server,
        "two-stop",
        "interrupt",
        json!({"attemptId": attempt_id}),
    );
    assert_eq!(stopped["ok"], true, "{stopped}");
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let _ = snapshot_of(&server, "two-stop-settle");
        let rows = decisions_for(&store, &attempt_id);
        if rows.len() == 2 && rows.iter().all(|row| row.state == DecisionState::Cancelled) {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "stop left approvals answerable: {rows:?}"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    let record = workspace.path().join("permission-decision");
    if record.exists() {
        assert!(!fs::read_to_string(&record).unwrap().contains("accept"));
    }
}

#[test]
fn approval_terminal_approval_batch_leaves_nothing_pending() {
    let _serial = SERIAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let (workspace, store, server, attempt_id) = open_codex_permission("permission-batch");
    let deadline = Instant::now() + Duration::from_secs(5);
    let rows = loop {
        let _ = snapshot_of(&server, "batch-settle");
        let rows = decisions_for(&store, &attempt_id);
        if rows.len() == 2 && rows.iter().all(|row| row.state != DecisionState::Pending) {
            break rows;
        }
        assert!(
            Instant::now() < deadline,
            "batch left a pending approval: {rows:?}"
        );
        std::thread::sleep(Duration::from_millis(10));
    };
    assert!(rows.iter().all(|row| row.state != DecisionState::Approved));
    for row in &rows {
        let response = request(
            &server,
            &format!("batch-accept-{}", row.id),
            "permission_response",
            json!({"decisionId": row.id, "allow": true}),
        );
        assert_eq!(response["ok"], false, "{response}");
    }
    let record = workspace.path().join("permission-decision");
    if record.exists() {
        assert!(!fs::read_to_string(&record).unwrap().contains("accept"));
    }
}

#[test]
fn next_turn_same_rpc_id_leaves_the_settled_decision() {
    let _serial = SERIAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let (workspace, store, server, attempt_id) = open_codex_permission("permission-reuse");
    let first = wait_for_decisions(&store, &server, &attempt_id, 1);
    let first_id = first[0].id.clone();
    assert_ne!(first_id, "rpc-A");
    accepted(
        &server,
        "reuse-allow",
        "permission_response",
        json!({"decisionId": first_id, "allow": true}),
    );
    let snapshot = wait_for_turn(&server, "completed");
    assert_eq!(
        store.get_decision(&first_id).unwrap().state,
        DecisionState::Approved
    );
    let campaign_id = snapshot["activeCampaignId"].as_str().unwrap();
    accepted(
        &server,
        "reuse-send",
        "conversation_send",
        json!({
            "campaignId": campaign_id,
            "attemptId": attempt_id,
            "message": "ask again"
        }),
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    let second_id = loop {
        let _ = snapshot_of(&server, "reuse-second");
        let pending: Vec<_> = store
            .list_decisions()
            .unwrap()
            .into_iter()
            .filter(|row| row.state == DecisionState::Pending)
            .collect();
        if let Some(row) = pending.first() {
            break row.id.clone();
        }
        assert!(Instant::now() < deadline, "second approval never appeared");
        std::thread::sleep(Duration::from_millis(10));
    };
    assert_ne!(second_id, first_id);
    assert_ne!(second_id, "rpc-A");
    assert_eq!(
        store.get_decision(&first_id).unwrap().state,
        DecisionState::Approved
    );
    let text = fs::read_to_string(workspace.path().join("permission-decision")).unwrap();
    assert_eq!(text, "rpc-A accept\n");
}

fn approval_answer_before_next_poll_is_refused(
    scenario: &str,
    release: &str,
    visible: &str,
) {
    let _serial = SERIAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let (workspace, store, server, attempt_id) = open_codex_permission(scenario);
    let rows = wait_for_decisions(&store, &server, &attempt_id, 1);
    assert_eq!(rows[0].state, DecisionState::Pending);
    let decision_id = rows[0].id.clone();
    fs::write(workspace.path().join(release), "go").unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !workspace.path().join(visible).is_file() {
        assert!(Instant::now() < deadline, "{visible} never appeared");
        std::thread::sleep(Duration::from_millis(10));
    }
    let response = request(
        &server,
        "answer-before-poll",
        "permission_response",
        json!({"decisionId": decision_id, "allow": true}),
    );
    assert_eq!(response["ok"], false, "{response}");
    let record = workspace.path().join("permission-decision");
    if record.exists() {
        assert!(!fs::read_to_string(&record).unwrap().contains("accept"));
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let _ = snapshot_of(&server, "settle-closed-approval");
        let rows = decisions_for(&store, &attempt_id);
        if rows.len() == 1 && rows[0].state != DecisionState::Pending {
            assert_ne!(rows[0].state, DecisionState::Approved);
            break;
        }
        assert!(
            Instant::now() < deadline,
            "closed approval stayed pending: {rows:?}"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
#[test]
fn close_adapter_transport_cancels_the_shown_approval_without_killing() {
    let _serial = SERIAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let (workspace, store, server, attempt_id) = open_codex_permission("permission-drop");
    let rows = wait_for_decisions(&store, &server, &attempt_id, 1);
    assert_eq!(rows[0].state, DecisionState::Pending);
    let pid: i32 = fs::read_to_string(workspace.path().join("process-starts"))
        .unwrap()
        .lines()
        .next()
        .unwrap()
        .parse()
        .unwrap();
    let closed = request(
        &server,
        "drop-transport",
        "close_adapter_transport",
        json!({"attemptId": attempt_id}),
    );
    assert_eq!(closed["ok"], true, "{closed}");
    let snapshot = snapshot_of(&server, "after-drop");
    let decision = snapshot["decisions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|decision| decision["id"] == rows[0].id)
        .unwrap();
    assert_eq!(decision["state"], "resolved");
    assert_eq!(
        store.get_decision(&rows[0].id).unwrap().state,
        DecisionState::Cancelled
    );
    let record = workspace.path().join("permission-decision");
    if record.exists() {
        let text = fs::read_to_string(&record).unwrap();
        assert!(!text.contains("accept"), "{text}");
        assert!(!text.contains("decline"), "{text}");
    }
    assert_eq!(unsafe { libc::kill(pid, 0) }, 0, "the runtime child is still alive");
    let recovery = store.get_attempt_recovery(&attempt_id).unwrap().unwrap();
    assert_eq!(recovery.recovery_class.as_deref(), Some("BLOCKED"));
    let kinds = store
        .list_event_records(&attempt_id, 0)
        .unwrap()
        .into_iter()
        .map(|record| record.event.kind)
        .collect::<Vec<_>>();
    assert!(kinds.iter().any(|kind| kind == "transport_lost"), "{kinds:?}");
    assert!(
        !kinds.iter().any(|kind| kind == "runtime.transport.closed"),
        "{kinds:?}"
    );
    unsafe { libc::kill(pid, libc::SIGTERM) };
}

fn approval_then_terminal_error_is_not_acceptable() {
    approval_answer_before_next_poll_is_refused(
        "permission-terminal-error",
        "release-terminal-error",
        "error-visible",
    );
}

#[test]
fn approval_then_oversized_stdout_is_not_acceptable() {
    approval_answer_before_next_poll_is_refused(
        "permission-reader-oversize",
        "release-oversize",
        "oversize-visible",
    );
}

#[test]
fn two_attempts_sharing_a_raw_rpc_id_do_not_collide() {
    let _serial = SERIAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let (_workspace, store, server, first_attempt) = open_codex_permission("permission-deny");
    let workspace = tempfile::tempdir().unwrap();
    fs::copy(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/linux-codex-peer.py"),
        workspace.path().join("app-server"),
    )
    .unwrap();
    fs::write(workspace.path().join("peer-scenario"), "permission-deny").unwrap();
    let created = accepted(
        &server,
        "second-attempt-create",
        "create_campaign",
        json!({
            "workspaceRoot": workspace.path(),
            "goal": "Second permission",
            "title": "Second"
        }),
    );
    let campaign_id = created["activeCampaignId"].as_str().unwrap().to_owned();
    let task_id = created["activeTask"]["id"].as_str().unwrap().to_owned();
    let selected = accepted(
        &server,
        "second-attempt-select",
        "select_runtime",
        json!({
            "campaignId": campaign_id,
            "taskId": task_id,
            "provider": "codex",
            "version": "local-peer",
            "executable": "python3"
        }),
    );
    let second_attempt = selected["attempt"]["id"].as_str().unwrap().to_owned();
    accepted(
        &server,
        "second-attempt-send",
        "conversation_send",
        json!({
            "campaignId": campaign_id,
            "attemptId": second_attempt,
            "message": "request a local permission"
        }),
    );
    let first = wait_for_decisions(&store, &server, &first_attempt, 1);
    let second = wait_for_decisions(&store, &server, &second_attempt, 1);
    assert_ne!(first[0].id, second[0].id);
    assert_ne!(first[0].id, "local-approval");
    assert_ne!(second[0].id, "local-approval");
    assert_eq!(store.get_decision(&first[0].id).unwrap().state, DecisionState::Pending);
    assert_eq!(store.get_decision(&second[0].id).unwrap().state, DecisionState::Pending);
}

fn admission_failure(executable: String, scenario: Option<&str>) -> Value {
    let workspace = tempfile::tempdir().unwrap();
    if let Some(scenario) = scenario {
        fs::copy(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/linux-codex-peer.py"),
            workspace.path().join("app-server"),
        )
        .unwrap();
        fs::write(workspace.path().join("peer-scenario"), scenario).unwrap();
    }
    let server = CoreServer::new(Store::memory().unwrap());
    let created = accepted(
        &server,
        "create-admission",
        "create_campaign",
        json!({"workspaceRoot":workspace.path(),"goal":"Local admission case","title":"Admission"}),
    );
    let response = request(
        &server,
        "select-admission",
        "select_runtime",
        json!({
            "campaignId":created["activeCampaignId"],
            "taskId":created["activeTask"]["id"],
            "provider":"codex",
            "version":"local-peer",
            "executable":executable,
        }),
    );
    assert_eq!(response["ok"], false, "{response}");
    response["payload"]["snapshot"]["productConversation"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["kind"] == "actionable-error")
        .cloned()
        .expect("visible admission error")
}

#[test]
fn missing_runtime_and_native_auth_error_have_distinct_reasons() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let missing = admission_failure("/goalport-fixture-no-such-codex".into(), None);
    assert!(missing["body"].as_str().unwrap().contains("not installed"));
    assert!(
        missing["technicalDetails"]
            .as_str()
            .unwrap()
            .contains("provider-not-installed")
    );

    let auth = admission_failure("python3".into(), Some("auth-required"));
    assert!(auth["body"].as_str().unwrap().contains("Sign in"));
    assert!(
        auth["technicalDetails"]
            .as_str()
            .unwrap()
            .contains("provider-auth-required")
    );
}

#[test]
fn revision_observes_parent_exit_even_when_descendant_keeps_stdout_open() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let workspace = tempfile::tempdir().unwrap();
    fs::copy(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/linux-codex-peer.py"),
        workspace.path().join("app-server"),
    )
    .unwrap();
    fs::write(
        workspace.path().join("peer-scenario"),
        "exit-parent-stdout-open",
    )
    .unwrap();
    let _parent_release = ReleaseOnDrop(workspace.path().join("release-parent-exit"));
    let _holder_release = ReleaseOnDrop(workspace.path().join("release-stdout-holder"));
    let store = Store::memory().unwrap();
    seed_core_epoch(&store, workspace.path(), "exit-fixture");
    let server = CoreServer::new(store);
    let created = accepted(
        &server,
        "create-exit",
        "create_campaign",
        json!({
            "workspaceRoot":workspace.path(),"goal":"Exit observation","title":"Exit"
        }),
    );
    let selected = accepted(
        &server,
        "select-exit",
        "select_runtime",
        json!({
            "campaignId":created["activeCampaignId"],"taskId":created["activeTask"]["id"],
            "provider":"codex","version":"local-peer","executable":"python3"
        }),
    );
    assert_eq!(
        selected["productConversation"]["session"]["state"],
        "attached"
    );
    let before = request(&server, "before-exit", "snapshot_if_changed", json!({}));
    assert_eq!(before["ok"], true, "{before}");
    let revision = before["payload"]["revision"].as_str().unwrap().to_owned();
    let parent_pid: u32 = fs::read_to_string(workspace.path().join("process-starts"))
        .unwrap()
        .lines()
        .next()
        .unwrap()
        .parse()
        .unwrap();
    let holder_pid: u32 = fs::read_to_string(workspace.path().join("stdout-holder-pid"))
        .unwrap()
        .parse()
        .unwrap();
    assert!(matches!(
        observe_process(holder_pid),
        ProcessObservation::Live(_)
    ));
    fs::write(workspace.path().join("release-parent-exit"), "release").unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while observe_process(parent_pid) != ProcessObservation::NotRunning {
        assert!(Instant::now() < deadline, "provider parent never exited");
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(
        matches!(observe_process(holder_pid), ProcessObservation::Live(_)),
        "stdout holder ended too early"
    );
    let changed = request(
        &server,
        "after-exit",
        "snapshot_if_changed",
        json!({"revision":revision}),
    );
    assert_eq!(changed["ok"], true, "{changed}");
    assert_eq!(
        changed["payload"]["unchanged"], false,
        "parent exit must invalidate revision"
    );
    assert_eq!(
        changed["payload"]["snapshot"]["productConversation"]["session"]["state"],
        "unavailable"
    );
    let turn = &changed["payload"]["snapshot"]["productConversation"]["turn"];
    assert!(
        turn["actions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|action| action == "close-session")
    );
    assert!(
        !turn["actions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|action| action == "select-runtime")
    );
    let attempt_id = selected["attempt"]["id"].as_str().unwrap();
    let closed = request(
        &server,
        "close-exited",
        "close_session",
        json!({"attemptId":attempt_id}),
    );
    assert_eq!(
        closed["ok"], true,
        "advertised recovery action must work: {closed}"
    );
    assert_eq!(
        closed["payload"]["snapshot"]["productConversation"]["session"]["state"],
        "closed"
    );
    let resume = request(
        &server,
        "resume-exited-closed",
        "resume_native_session",
        json!({"attemptId":attempt_id}),
    );
    assert_eq!(resume["ok"], false);
    assert_eq!(
        fs::read_to_string(workspace.path().join("process-starts"))
            .unwrap()
            .lines()
            .count(),
        1
    );
    fs::write(workspace.path().join("release-stdout-holder"), "release").unwrap();
    let holder_deadline = Instant::now() + Duration::from_secs(2);
    while observe_process(holder_pid) != ProcessObservation::NotRunning {
        assert!(
            Instant::now() < holder_deadline,
            "owned stdout holder did not exit"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn exec_shim_finalizes_identity_before_session_and_closes_exact_child() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let workspace = tempfile::tempdir().unwrap();
    fs::copy(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/linux-codex-peer.py"),
        workspace.path().join("app-server"),
    )
    .unwrap();
    let shim = write_exec_shim(workspace.path());
    let store = Store::memory().unwrap();
    seed_core_epoch(&store, workspace.path(), "exec-shim-fixture");
    let server = CoreServer::new(store.clone());
    let created = accepted(
        &server,
        "create-exec-shim",
        "create_campaign",
        json!({
            "workspaceRoot":workspace.path(),"goal":"Exec shim observation","title":"Exec shim"
        }),
    );
    let campaign_id = created["activeCampaignId"].as_str().unwrap().to_owned();
    let task_id = created["activeTask"]["id"].as_str().unwrap().to_owned();
    let (sender, receiver) = mpsc::channel();
    let worker = {
        let server = server.clone();
        let executable = shim.display().to_string();
        std::thread::spawn(move || {
            let result = request(
                &server,
                "select-exec-shim",
                "select_runtime",
                json!({
                    "campaignId":campaign_id,"taskId":task_id,"provider":"codex",
                    "version":"local-peer","executable":executable
                }),
            );
            let _ = sender.send(result);
        })
    };
    await_file(&workspace.path().join("shim-pid"));
    let pid: u32 = fs::read_to_string(workspace.path().join("shim-pid"))
        .unwrap()
        .parse()
        .unwrap();
    let provisional = match observe_process(pid) {
        ProcessObservation::Live(identity) => identity,
        other => panic!("stopped shim must have an exact identity: {other:?}"),
    };
    let _continue_on_panic = ContinueOwnedShim(provisional.clone());
    assert!(workspace.path().join("shim-initialize.json").exists());
    assert_eq!(unsafe { libc::kill(pid as libc::pid_t, libc::SIGCONT) }, 0);
    let selected = receiver.recv_timeout(Duration::from_secs(5)).unwrap();
    worker.join().unwrap();
    assert_eq!(selected["ok"], true, "{selected}");
    let attempt_id = selected["payload"]["snapshot"]["attempt"]["id"]
        .as_str()
        .unwrap();
    let initialized = match observe_process(pid) {
        ProcessObservation::Live(identity) => identity,
        other => panic!("initialized peer must still be live: {other:?}"),
    };
    assert_eq!(initialized.pid, provisional.pid);
    assert_eq!(initialized.parent_pid, provisional.parent_pid);
    assert_eq!(initialized.creation_date(), provisional.creation_date());
    assert_ne!(initialized.executable_sha256, provisional.executable_sha256);
    let bindings = store.runtime_epoch_bindings(attempt_id).unwrap();
    assert_eq!(bindings.len(), 1);
    assert_eq!(
        bindings[0].runtime_executable_sha256,
        initialized.executable_sha256
    );
    assert_eq!(
        bindings[0].runtime_executable_path,
        initialized.executable_path
    );
    let closed = request(
        &server,
        "close-exec-shim",
        "close_session",
        json!({"attemptId":attempt_id}),
    );
    assert_eq!(
        closed["ok"], true,
        "finalized identity must allow close: {closed}"
    );
    assert_eq!(
        closed["payload"]["snapshot"]["productConversation"]["session"]["state"],
        "closed"
    );
}

#[test]
fn startup_cancel_stops_the_owned_shim_before_exec_or_prompt() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let workspace = tempfile::tempdir().unwrap();
    fs::copy(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/linux-codex-peer.py"),
        workspace.path().join("app-server"),
    )
    .unwrap();
    let shim = write_exec_shim(workspace.path());
    let store = Store::memory().unwrap();
    seed_core_epoch(&store, workspace.path(), "cancel-exec-shim-fixture");
    let server = CoreServer::new(store.clone());
    let created = accepted(
        &server,
        "create-cancel-shim",
        "create_campaign",
        json!({
            "workspaceRoot":workspace.path(),"goal":"Cancel startup","title":"Cancel"
        }),
    );
    let campaign_id = created["activeCampaignId"].as_str().unwrap().to_owned();
    let task_id = created["activeTask"]["id"].as_str().unwrap().to_owned();
    let (sender, receiver) = mpsc::channel();
    let worker = {
        let server = server.clone();
        let task = task_id.clone();
        let executable = shim.display().to_string();
        std::thread::spawn(move || {
            let result = request(
                &server,
                "select-cancel-shim",
                "select_runtime",
                json!({
                    "campaignId":campaign_id,"taskId":task,"provider":"codex",
                    "version":"local-peer","executable":executable
                }),
            );
            let _ = sender.send(result);
        })
    };
    await_file(&workspace.path().join("shim-pid"));
    let pid: u32 = fs::read_to_string(workspace.path().join("shim-pid"))
        .unwrap()
        .parse()
        .unwrap();
    let provisional = match observe_process(pid) {
        ProcessObservation::Live(identity) => identity,
        other => panic!("stopped shim must be live before cancel: {other:?}"),
    };
    let _continue_on_panic = ContinueOwnedShim(provisional);
    let attempt_id = store
        .attempts_for_task(&task_id)
        .unwrap()
        .last()
        .unwrap()
        .id
        .clone();
    let started = Instant::now();
    let cancelled = request(
        &server,
        "cancel-exec-shim",
        "interrupt",
        json!({"attemptId":attempt_id}),
    );
    assert!(started.elapsed() < Duration::from_secs(2));
    assert_eq!(cancelled["ok"], true, "{cancelled}");
    assert_eq!(
        cancelled["payload"]["receipt"]["startupCancel"],
        "confirmed"
    );
    assert_eq!(cancelled["payload"]["receipt"]["nativePromptSent"], false);
    assert_eq!(
        store.get_attempt(&attempt_id).unwrap().state,
        AttemptState::Cancelled
    );
    assert!(!workspace.path().join("turn-count").exists());
    assert_eq!(
        receiver.recv_timeout(Duration::from_secs(5)).unwrap()["ok"],
        false
    );
    worker.join().unwrap();
}


#[test]
fn stop_cache_tracks_next_send_delivery_boundary() {
    let _serial = SERIAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    for outcome in ["success", "closed", "unknown"] {
        let workspace = tempfile::tempdir().unwrap();
        let _release = ReleaseOnDrop(workspace.path().join("release-stop-peer"));
        fs::copy(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/linux-codex-peer.py"), workspace.path().join("app-server")).unwrap();
        fs::write(workspace.path().join("peer-scenario"), format!("stop-cache-{outcome}")).unwrap();
        let store = Store::memory().unwrap();
        seed_core_epoch(&store, workspace.path(), "stop-cache-fixture");
        let server = CoreServer::new(store.clone());
        let created = accepted(&server, "create-stop-cache", "create_campaign", json!({"workspaceRoot":workspace.path(),"goal":"Local Stop boundary","title":"Stop boundary"}));
        let campaign = created["activeCampaignId"].as_str().unwrap();
        let selected = accepted(&server, "select-stop-peer", "select_runtime", json!({"campaignId":campaign,"taskId":created["activeTask"]["id"],"provider":"codex","version":"local-peer","executable":"python3"}));
        let attempt = selected["attempt"]["id"].as_str().unwrap();
        accepted(&server, "first-stop-turn", "conversation_send", json!({"campaignId":campaign,"attemptId":attempt,"message":"first turn"}));
        wait_for_turn(&server, "running");
        let first_stop = request(&server, "original-implicit-stop", "safe_stop", json!({}));
        assert_eq!(first_stop["ok"], true, "{first_stop}");
        assert_eq!(first_stop["payload"]["receipt"]["requested"], true);
        assert_eq!(first_stop["payload"]["receipt"]["confirmed"], false);
        wait_for_turn(&server, "completed");
        assert_eq!(store.get_attempt(attempt).unwrap().state, AttemptState::AwaitingReview);
        if outcome != "success" { await_file(&workspace.path().join("pipe-closed")); }
        let sibling_workspace = tempfile::tempdir().unwrap();
        let sibling_campaign = accepted(&server, "create-stop-sibling", "create_campaign", json!({"workspaceRoot":sibling_workspace.path(),"goal":"Independent selection","title":"Sibling"}));
        let sibling = accepted(&server, "select-stop-sibling", "select_runtime", json!({"campaignId":sibling_campaign["activeCampaignId"],"taskId":sibling_campaign["activeTask"]["id"],"provider":"scenario","version":"scenario-1"}));
        let sibling_id = sibling["attempt"]["id"].as_str().unwrap();
        assert_ne!(sibling_id, attempt);
        let replay = request(&server, "original-implicit-stop", "safe_stop", json!({}));
        assert_eq!(replay["ok"], true, "{replay}");
        assert_eq!(replay["payload"]["receipt"]["duplicateDispatch"], true);
        assert_eq!(replay["payload"]["receipt"]["attemptId"], attempt);
        assert_eq!(fs::read_to_string(workspace.path().join("interrupt-count")).unwrap(), "1");
        let payload = json!({"campaignId":campaign,"attemptId":attempt,"message":"next user turn"});
        let next = request(&server, "next-stop-turn", "conversation_send", payload.clone());
        println!("STOP_BOUNDARY {outcome} next_ok={} delivery={}", next["ok"], next["payload"]["rejection"]["deliveryState"]);
        if outcome == "success" {
            assert_eq!(next["ok"], true, "{next}");
            // Selection stays on the sibling, so inspect this explicit target.
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                accepted(&server, "poll-next-stop-turn", "snapshot", json!({}));
                if store.list_event_records(attempt, 0).unwrap().iter().filter(|r|r.event.kind=="runtime.turn.started").count() == 2 { break; }
                assert!(Instant::now() < deadline);
                std::thread::sleep(Duration::from_millis(10));
            }
            let stop = request(&server, "stop-next-turn", "cancel", json!({"attemptId":attempt}));
            assert_eq!(stop["ok"], true, "{stop}");
            assert_eq!(stop["payload"]["receipt"]["duplicateDispatch"], false);
            await_file(&workspace.path().join("interrupt-count"));
            let deadline = Instant::now() + Duration::from_secs(5);
            while fs::read_to_string(workspace.path().join("interrupt-count")).unwrap() != "2" {
                assert!(Instant::now() < deadline); std::thread::sleep(Duration::from_millis(10));
            }
        } else {
            assert_eq!(next["ok"], false, "{next}");
            let command = store.command_result("ui-send-next-stop-turn").unwrap().unwrap();
            assert_eq!(command["deliveryState"], if outcome=="unknown" {"UNKNOWN"} else {"FAILED"});
            let records = store.list_event_records(attempt, 0).unwrap().len();
            let retry = request(&server, "next-stop-turn", "conversation_send", payload);
            assert_eq!(retry["ok"], false, "{retry}");
            assert_eq!(store.list_event_records(attempt, 0).unwrap().len(), records, "recorded failed/UNKNOWN send must not execute again");
            let stop = request(&server, "stop-next-turn", "cancel", json!({"attemptId":attempt}));
            println!("STOP_BOUNDARY {outcome} stop_ok={} receipt={} error={}", stop["ok"], stop["payload"]["receipt"], stop["error"]);
            if outcome == "unknown" {
                assert_eq!(stop["ok"], false, "old Stop cannot stand in for an unacknowledged potentially new turn: {stop}");
                assert!(stop["error"].as_str().unwrap().contains("no proven cancellable live turn"));
            } else {
                assert_eq!(stop["ok"], true, "{stop}");
                assert_eq!(stop["payload"]["receipt"]["duplicateDispatch"], true, "definitely unsent input preserves the previous Stop outcome");
                assert_eq!(stop["payload"]["receipt"]["originalRequestId"], "original-implicit-stop");
            }
            assert_eq!(fs::read_to_string(workspace.path().join("turn-count")).unwrap(), "1");
            assert_eq!(fs::read_to_string(workspace.path().join("interrupt-count")).unwrap(), "1");
        }
        let snapshot = accepted(&server, "selection-after-stop-boundary", "snapshot", json!({}));
        assert_eq!(snapshot["attempt"]["id"], sibling_id);
        assert_eq!(store.get_attempt(sibling_id).unwrap().state, AttemptState::Active);
        println!("STOP_BOUNDARY {outcome} PASSED");
        // Drop closes only the fixture-owned Runtime. Close Session correctly
        // refuses while a Stop acknowledgement/UNKNOWN delivery is outstanding.
        fs::write(workspace.path().join("release-stop-peer"), "release").unwrap();
    }
}


#[test]
fn terminal_workspace_is_frozen_before_any_append_retry() {
    use goalport_core::{ipc::UiCommandRequest, projection::UiController};
    let _serial = SERIAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    fn git(root: &Path, args: &[&str]) {
        let output = std::process::Command::new("git").args(args).current_dir(root).output().unwrap();
        assert!(output.status.success(), "fixture git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
    }
    fn command(id: &str, kind: &str, payload: Value) -> UiCommandRequest {
        UiCommandRequest { protocol_version: CONNECTED_UI_PROTOCOL_VERSION.into(), request_id: id.into(),
            entity_version: 0, message_type: kind.into(), payload }
    }
    fn count(store: &Store, attempt: &str, kind: &str) -> usize {
        store.list_event_records(attempt, 0).unwrap().iter().filter(|record| record.event.kind == kind).count()
    }
    for stage in ["terminal", "result", "earlier", "unavailable", "missing-baseline", "disappeared"] {
        let workspace = tempfile::tempdir().unwrap();
        let root = workspace.path();
        fs::write(root.join("tracked.txt"), "unchanged at completion\n").unwrap();
        if stage != "missing-baseline" {
            git(root, &["init", "--quiet"]);
            git(root, &["add", "--", "tracked.txt"]);
            git(root, &["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture baseline"]);
        }
        if stage == "disappeared" { fs::write(root.join("observed.txt"), "dirty baseline\n").unwrap(); }
        let mut peer = fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/linux-codex-peer.py")).unwrap();
        let completion = "            send({\"method\": \"turn/completed\", \"params\": {\"threadId\": \"local-thread\", \"turn\": {\"id\": turn_id, \"status\": \"completed\"}}})";
        assert!(peer.contains(completion));
        let before = if stage == "unavailable" { "            (workspace / \".git\").rename(workspace / \".git-paused\")\n" }
            else if stage == "disappeared" { "            (workspace / \"observed.txt\").unlink()\n" } else { "" };
        peer = peer.replace(completion, &format!("{before}{completion}\n            (workspace / \"completion-written\").write_text(\"yes\")"));
        fs::write(root.join("app-server"), peer).unwrap();
        fs::write(root.join("peer-scenario"), "complete-first").unwrap();
        let db = root.join("test.sqlite");
        let store = Store::open(&db).unwrap();
        let sql = rusqlite::Connection::open(&db).unwrap();
        let _nonce = LaunchNonceGuard::set(format!("terminal-freeze-{stage}"));
        let epoch = begin_startup_epoch(&store, stage, &db).unwrap();
        complete_startup_epoch(&store, stage, &db, &epoch, &json!({"status":"completed"})).unwrap();
        let mut ui = UiController::new(store.clone()).unwrap();
        let created = ui.handle(command("create-freeze", "create_campaign", json!({"workspaceRoot":root,"goal":"Local result recovery","title":"Result recovery"}))).unwrap().snapshot;
        let selected = ui.handle(command("select-freeze", "select_runtime", json!({"campaignId":created.active_campaign_id,"taskId":created.active_task.id,"provider":"codex","executable":"python3","version":"local-peer"}))).unwrap().snapshot;
        let attempt = selected.attempt.id;
        let kind = if stage == "result" { "workspace.turn_result" } else if stage == "earlier" { "runtime.reply.delta" } else { "runtime.turn.completed" };
        sql.execute_batch(&format!("CREATE TRIGGER block_terminal_result BEFORE INSERT ON events WHEN NEW.kind='{kind}' BEGIN SELECT RAISE(ABORT,'selected append failure'); END;")).unwrap();
        ui.handle(command("send-freeze", "send_message", json!({"attemptId":attempt,"campaignId":selected.active_campaign_id,"message":"one local turn"}))).unwrap();
        await_file(&root.join("completion-written"));
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if ui.flush_runtime_events().is_err() { break; }
            assert!(Instant::now() < deadline, "{stage}: selected append did not fail");
            std::thread::sleep(Duration::from_millis(10));
        }
        if stage == "earlier" {
            // The terminal is behind the failed head. Keep the fault active
            // while the reader consumes the peer's already-written completion.
            std::thread::sleep(Duration::from_millis(50));
            assert!(ui.flush_runtime_events().is_err());
        }
        assert_eq!(count(&store, &attempt, "runtime.turn.completed"), usize::from(stage == "result"));
        assert_eq!(count(&store, &attempt, "workspace.turn_result"), 0);
        fs::write(root.join("tracked.txt"), "external edit during failed persistence\n").unwrap();
        if stage == "unavailable" { fs::rename(root.join(".git-paused"), root.join(".git")).unwrap(); }
        if stage == "missing-baseline" { git(root, &["init", "--quiet"]); }
        if stage == "disappeared" { fs::write(root.join("observed.txt"), "external recreation\n").unwrap(); }
        sql.execute_batch("DROP TRIGGER block_terminal_result;").unwrap();
        ui.flush_runtime_events().unwrap();
        let records = store.list_event_records(&attempt, 0).unwrap();
        let result = records.iter().find(|record| record.event.kind == "workspace.turn_result").unwrap().payload.as_ref().unwrap();
        let changed: Vec<&Value> = result["during"].as_array().unwrap().iter().chain(result["unattributed"].as_array().unwrap()).collect();
        assert!(changed.iter().all(|file| file["path"] != "tracked.txt"), "{stage}: later edit entered completed result: {result}");
        assert_eq!(result["baselineRecorded"], stage != "missing-baseline");
        assert_eq!(result["comparisonUnavailable"], stage == "unavailable");
        if stage == "disappeared" {
            assert!(changed.iter().any(|file| file["path"] == "observed.txt" && file["change"] == "deleted"), "first-observed deletion must survive later recreation: {result}");
        }
        let terminal = records.iter().find(|record| record.event.kind == "runtime.turn.completed").unwrap();
        assert_eq!(result["terminalSeq"], terminal.event.seq);
        assert_eq!(count(&store, &attempt, "runtime.turn.completed"), 1);
        assert_eq!(count(&store, &attempt, "workspace.turn_result"), 1);
        assert_eq!(ui.flush_runtime_events().unwrap(), 0);
        assert_eq!(ui.flush_runtime_events().unwrap(), 0);
        assert_eq!(fs::read_to_string(root.join("turn-count")).unwrap(), "1");
        println!("TERMINAL_FREEZE {stage} PASSED");
    }
}
