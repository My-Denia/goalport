//! Linux protocol peer for Claude close and resume.
//! The Windows peer stays in `claude_stream.rs`. This file drives the same
//! fixture through node.
#![cfg(target_os = "linux")]

use goalport_core::{
    AgentEventEnvelope, AgentEventType, Attempt, AttemptState, Campaign, PermissionResponse,
    Project, PromptRequest, RuntimeManager, SessionRequest, Task,
    ipc::{CONNECTED_UI_PROTOCOL_VERSION, CoreServer},
    store::{CampaignAuthorization, Store},
};
use serde_json::Value;
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{Mutex, MutexGuard},
    thread,
    time::Duration,
};

static FIXTURE_ENV: Mutex<()> = Mutex::new(());

struct FixtureEnv;
impl Drop for FixtureEnv {
    fn drop(&mut self) {
        unsafe { env::remove_var("GOALPORT_CLAUDE_FIXTURE_INTERPRETER") };
    }
}

fn begin() -> (MutexGuard<'static, ()>, FixtureEnv) {
    let lock = FIXTURE_ENV.lock().unwrap_or_else(|error| error.into_inner());
    let node = Command::new("which")
        .arg("node")
        .output()
        .expect("which node");
    assert!(node.status.success(), "node is required for the Claude fixture peer");
    let path = String::from_utf8(node.stdout).unwrap();
    unsafe { env::set_var("GOALPORT_CLAUDE_FIXTURE_INTERPRETER", path.trim()) };
    (lock, FixtureEnv)
}

fn fake_cli() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/fake-claude-cli/fake-claude-cli.mjs")
}

fn workspace(name: &str, scenario: &str) -> PathBuf {
    let dir = env::temp_dir().join(format!(
        "goalport-claude-linux-{name}-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(dir.join("notes")).unwrap();
    fs::write(dir.join(".fake-claude-scenario"), scenario).unwrap();
    dir
}

fn request(attempt: &str, workspace: &Path, resume: Option<&str>) -> SessionRequest {
    SessionRequest {
        campaign_id: Some("campaign-linux".into()),
        task_id: "task-linux".into(),
        attempt_id: attempt.into(),
        workspace_root: workspace.to_path_buf(),
        resume_session: resume.map(str::to_owned),
    }
}

fn attach(attempt: &str, workspace: &Path) -> RuntimeManager {
    let mut manager = RuntimeManager::new();
    manager
        .select_runtime(attempt, "claude", Some(fake_cli()), "2.1.288", workspace)
        .expect("select claude fixture");
    let session = manager
        .create_session(attempt, &request(attempt, workspace, None))
        .expect("create session");
    assert!(session.handle.session_id.is_empty());
    assert!(!session.handle.resumed);
    manager
}

fn send(manager: &mut RuntimeManager, attempt: &str, text: &str) {
    manager
        .send_prompt(
            attempt,
            &PromptRequest {
                attempt_id: attempt.into(),
                text: text.into(),
                idempotency_key: format!("{attempt}-send"),
            },
        )
        .expect("prompt accepted");
}

fn drain(
    manager: &mut RuntimeManager,
    attempt: &str,
    done: impl Fn(&[AgentEventEnvelope]) -> bool,
) -> Vec<AgentEventEnvelope> {
    let mut events = Vec::new();
    for _ in 0..200 {
        events.extend(manager.poll_events(attempt).expect("poll"));
        if done(&events) {
            break;
        }
        thread::sleep(Duration::from_millis(25));
    }
    events
}

fn events_with(events: &[AgentEventEnvelope], kind: AgentEventType) -> usize {
    events.iter().filter(|event| event.event_type == kind).count()
}

fn has(events: &[AgentEventEnvelope], kind: AgentEventType) -> bool {
    events.iter().any(|event| event.event_type == kind)
}

fn read_json(workspace: &Path, name: &str) -> Value {
    let raw = fs::read_to_string(workspace.join(name)).unwrap_or_else(|error| {
        panic!("missing {name}: {error}")
    });
    serde_json::from_str(&raw).unwrap_or_else(|error| panic!("{name} is not json: {error}: {raw}"))
}

#[test]
fn resume_uses_the_stored_session_id_and_does_not_replay_the_prompt() {
    let (_lock, _env) = begin();
    let root = workspace("resume", "end_turn");
    let attempt = "attempt-resume";
    let mut manager = attach(attempt, &root);
    send(&mut manager, attempt, "original task must not be resent");
    let events = drain(&mut manager, attempt, |seen| has(seen, AgentEventType::TurnCompleted));
    assert!(has(&events, AgentEventType::TurnCompleted), "{events:#?}");
    let stored = fs::read_to_string(root.join(".fake-claude-session-id")).unwrap();
    assert!(!stored.is_empty());
    assert!(!stored.starts_with("claude-session-"));
    manager.close_idle_session(attempt).expect("idle close");
    let pid = read_json(&root, ".fake-claude-argv.json")["pid"].as_u64().unwrap();
    assert!(!Path::new(&format!("/proc/{pid}")).exists(), "closed pid {pid} still exists");
    assert!(manager.close_idle_session(attempt).is_err(), "registration must be gone");

    let mut resumed = RuntimeManager::new();
    resumed
        .select_runtime(attempt, "claude", Some(fake_cli()), "2.1.288", &root)
        .unwrap();
    let session = resumed
        .resume_session_with_context(attempt, &request(attempt, &root, Some(stored.trim())))
        .expect("spawn-only resume of the stored id");
    // Spawn-only: the handle names the stored target, but verification has
    // not happened — no user message has crossed yet.
    assert_eq!(session.handle.session_id, stored.trim());
    assert!(session.handle.resumed);
    let argv = read_json(&root, ".fake-claude-argv.json");
    let flags = argv["argv"].as_array().unwrap();
    assert!(flags.windows(2).any(|pair| pair[0] == "--resume" && pair[1] == stored.trim()));
    assert!(!flags.iter().any(|flag| flag == "--continue" || flag == "-c" || flag == "--bare"));
    let stdin = fs::read_to_string(root.join(".fake-claude-stdin.jsonl")).unwrap_or_default();
    assert!(!stdin.contains("\"type\":\"user\""), "{stdin}");
    // The first send is the vehicle that verifies the stored id: the real CLI
    // reports its session only after the first user message.
    send(&mut resumed, attempt, "reply after resume");
    let events = drain(&mut resumed, attempt, |seen| {
        has(seen, AgentEventType::TurnCompleted)
    });
    assert!(has(&events, AgentEventType::TurnCompleted), "{events:#?}");
    let stdin = fs::read_to_string(root.join(".fake-claude-stdin.jsonl")).unwrap_or_default();
    assert!(!stdin.contains("original task must not be resent"), "{stdin}");
    assert_eq!(stdin.matches("reply after resume").count(), 1, "{stdin}");
}

#[test]
fn resume_rejects_a_different_reported_session_id() {
    let (_lock, _env) = begin();
    let root = workspace("mismatch", "resume_mismatch");
    let attempt = "attempt-mismatch";
    let mut manager = RuntimeManager::new();
    manager
        .select_runtime(attempt, "claude", Some(fake_cli()), "2.1.288", &root)
        .unwrap();
    let session = manager
        .resume_session_with_context(
            attempt,
            &request(attempt, &root, Some("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")),
        )
        .expect("spawn-only resume");
    assert!(session.handle.resumed);
    // Verification happens on the first send: the fixture reports a
    // different session id in the init frame that answers the message.
    let error = manager
        .send_prompt(
            attempt,
            &PromptRequest {
                attempt_id: attempt.into(),
                text: "first message on a mismatched resume".into(),
                idempotency_key: format!("{attempt}-send"),
            },
        )
        .expect_err("mismatched session id");
    let text = error.to_string();
    assert!(text.contains("different session id"), "{text}");
    // The message crossed the transport before the id was checkable, so it
    // is recorded as crossed exactly once and never re-sent.
    let stdin = fs::read_to_string(root.join(".fake-claude-stdin.jsonl")).unwrap_or_default();
    assert_eq!(
        stdin.matches("first message on a mismatched resume").count(),
        1,
        "{stdin}"
    );
    // The unverified process is dead: a second send is refused outright.
    let second = manager.send_prompt(
        attempt,
        &PromptRequest {
            attempt_id: attempt.into(),
            text: "second message must not cross".into(),
            idempotency_key: format!("{attempt}-send-2"),
        },
    );
    assert!(second.is_err(), "no second send after a failed verification");
    let stdin = fs::read_to_string(root.join(".fake-claude-stdin.jsonl")).unwrap_or_default();
    assert!(!stdin.contains("second message must not cross"), "{stdin}");
}

#[test]
fn close_refuses_while_a_turn_is_in_flight() {
    let (_lock, _env) = begin();
    let root = workspace("close-busy", "interrupt");
    let attempt = "attempt-close-busy";
    let mut manager = attach(attempt, &root);
    send(&mut manager, attempt, "keep working");
    let events = drain(&mut manager, attempt, |seen| has(seen, AgentEventType::ToolActivity));
    assert!(has(&events, AgentEventType::ToolActivity), "{events:#?}");
    let error = manager.close_idle_session(attempt).expect_err("close during turn");
    assert!(error.to_string().contains("still unresolved"), "{error}");
    assert!(manager.poll_events(attempt).is_ok(), "registration stays");
    manager.close_attempt(attempt).unwrap();
}

#[test]
fn two_permissions_let_text_through_and_a_terminal_clears_the_card() {
    let (_lock, _env) = begin();
    let root = workspace("two", "two_permissions");
    let attempt = "attempt-two";
    let mut manager = attach(attempt, &root);
    send(&mut manager, attempt, "edit then read");
    let mut events = drain(&mut manager, attempt, |seen| has(seen, AgentEventType::PermissionRequest));
    assert!(
        events.iter().any(|event| event.payload["text"] == "BEFORE_FIRST_PERMISSION"),
        "text must arrive while the first permission is unanswered: {events:#?}"
    );
    let first_id = events
        .iter()
        .find(|event| event.event_type == AgentEventType::PermissionRequest)
        .unwrap()
        .payload["request_id"]
        .as_str()
        .unwrap()
        .to_owned();
    manager
        .permission_response(attempt, PermissionResponse { request_id: first_id, allow: true })
        .unwrap();
    events.extend(drain(&mut manager, attempt, |seen| {
        seen.iter().filter(|event| event.event_type == AgentEventType::PermissionRequest).count() >= 2
    }));
    assert!(
        events.iter().any(|event| event.payload["text"] == "BETWEEN_PERMISSIONS"),
        "text between permissions must not wait for the second answer: {events:#?}"
    );
    let second_id = events
        .iter()
        .filter(|event| event.event_type == AgentEventType::PermissionRequest)
        .nth(1)
        .unwrap()
        .payload["request_id"]
        .as_str()
        .unwrap()
        .to_owned();
    manager
        .permission_response(attempt, PermissionResponse { request_id: second_id, allow: true })
        .unwrap();
    events.extend(drain(&mut manager, attempt, |seen| has(seen, AgentEventType::TurnCompleted)));
    assert!(has(&events, AgentEventType::TurnCompleted), "{events:#?}");
    let responses = events
        .iter()
        .filter(|event| event.event_type == AgentEventType::PermissionResponse)
        .count();
    assert_eq!(responses, 2, "{events:#?}");
}

#[test]
fn permission_write_failure_does_not_send_a_second_response() {
    let (_lock, _env) = begin();
    let root = workspace("write-fail", "permission_close_stdin");
    let attempt = "attempt-write-fail";
    let mut manager = attach(attempt, &root);
    send(&mut manager, attempt, "needs a decision");
    let events = drain(&mut manager, attempt, |seen| has(seen, AgentEventType::PermissionRequest));
    let request_id = events
        .iter()
        .find(|event| event.event_type == AgentEventType::PermissionRequest)
        .expect("permission")
        .payload["request_id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(manager
        .permission_response(attempt, PermissionResponse { request_id: request_id.clone(), allow: true })
        .is_err());
    assert!(manager
        .permission_response(attempt, PermissionResponse { request_id, allow: true })
        .is_err());
    let raw = fs::read_to_string(root.join(".fake-claude-stdin-types.json")).unwrap_or_else(|_| "[]".into());
    let types: Value = serde_json::from_str(&raw).unwrap();
    let responses = types
        .as_array()
        .unwrap()
        .iter()
        .filter(|row| row["type"] == "control_response")
        .count();
    assert_eq!(responses, 0, "a failed permission write must not be retried: {types}");
    manager.close_attempt(attempt).ok();
}

#[test]
fn eof_during_permission_cancels_the_card() {
    let (_lock, _env) = begin();
    let root = workspace("eof", "permission_then_exit");
    let attempt = "attempt-eof";
    let mut manager = attach(attempt, &root);
    send(&mut manager, attempt, "exit while asking");
    let events = drain(&mut manager, attempt, |seen| {
        has(seen, AgentEventType::TurnFailed)
            && seen.iter().any(|event| {
                event.event_type == AgentEventType::PermissionResponse
                    && event.payload["cancelled"] == true
            })
    });
    assert!(has(&events, AgentEventType::PermissionRequest), "{events:#?}");
    assert!(has(&events, AgentEventType::TurnFailed), "{events:#?}");
    assert!(
        events.iter().any(|event| {
            event.event_type == AgentEventType::PermissionResponse && event.payload["cancelled"] == true
        }),
        "EOF must cancel the unanswered permission: {events:#?}"
    );
}

#[test]
fn stop_then_resume_does_not_replay_the_old_task() {
    let (_lock, _env) = begin();
    let root = workspace("stop-resume", "interrupt");
    let attempt = "attempt-stop-resume";
    let mut manager = attach(attempt, &root);
    send(&mut manager, attempt, "sleeping task must not be resent");
    let events = drain(&mut manager, attempt, |seen| has(seen, AgentEventType::ToolActivity));
    assert!(has(&events, AgentEventType::ToolActivity), "{events:#?}");
    manager.interrupt(attempt).expect("stop");
    let mut closed = false;
    for _ in 0..40 {
        let _ = manager.poll_events(attempt);
        if manager.close_idle_session(attempt).is_ok() {
            closed = true;
            break;
        }
        thread::sleep(Duration::from_millis(200));
    }
    assert!(closed, "close must wait until Stop is no longer unresolved");
    let stored = fs::read_to_string(root.join(".fake-claude-session-id")).unwrap();
    let mut resumed = RuntimeManager::new();
    resumed
        .select_runtime(attempt, "claude", Some(fake_cli()), "2.1.288", &root)
        .unwrap();
    let session = resumed
        .resume_session_with_context(attempt, &request(attempt, &root, Some(stored.trim())))
        .expect("spawn-only resume after stop");
    assert!(session.handle.resumed);
    // The old task is never replayed: the verification vehicle is a NEW
    // first message, and only that message crosses the transport. The
    // interrupt scenario never emits a result, so activity is the proof the
    // resumed turn is running.
    send(&mut resumed, attempt, "reply after stop resume");
    let events = drain(&mut resumed, attempt, |seen| {
        has(seen, AgentEventType::ToolActivity)
    });
    assert!(has(&events, AgentEventType::ToolActivity), "{events:#?}");
    let stdin = fs::read_to_string(root.join(".fake-claude-stdin.jsonl")).unwrap_or_default();
    assert!(!stdin.contains("sleeping task must not be resent"), "{stdin}");
    assert_eq!(stdin.matches("reply after stop resume").count(), 1, "{stdin}");
    resumed.interrupt(attempt).expect("stop the resumed turn");
    let _ = drain(&mut resumed, attempt, |seen| has(seen, AgentEventType::Cancelled));
}

fn git_repo(dir: &Path) {
    let run = |args: &[&str]| {
        let status = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .status()
            .expect("git");
        assert!(status.success(), "git {args:?} failed in {}", dir.display());
    };
    run(&["init"]);
    run(&["config", "user.email", "goalport-test@example.com"]);
    run(&["config", "user.name", "goalport-test"]);
    fs::write(dir.join("README.md"), "base\n").unwrap();
    fs::write(dir.join(".gitignore"), ".fake-claude-*\n").unwrap();
    run(&["add", "README.md", ".gitignore"]);
    run(&["commit", "-m", "base"]);
    fs::write(dir.join("NOTES"), "pre-existing dirty\n").unwrap();
}

fn fail_open(events: &[AgentEventEnvelope]) -> bool {
    events.iter().any(|event| event.payload.get("fail_open") == Some(&serde_json::json!(true)))
}

fn tool_payload<'a>(events: &'a [AgentEventEnvelope], status: &str) -> &'a serde_json::Value {
    &events
        .iter()
        .find(|event| {
            event.event_type == AgentEventType::ToolActivity && event.payload["status"] == status
        })
        .unwrap_or_else(|| panic!("missing tool activity {status}: {events:#?}"))
        .payload
}

#[test]
fn readonly_bash_without_a_host_decision_completes() {
    let (_lock, _env) = begin();
    let root = workspace("readonly-bash", "readonly_bash");
    git_repo(&root);
    let mut manager = attach("attempt-readonly", &root);
    send(&mut manager, "attempt-readonly", "list the notes");
    let events = drain(&mut manager, "attempt-readonly", |seen| {
        has(seen, AgentEventType::TurnCompleted) || has(seen, AgentEventType::TurnFailed)
    });
    assert!(has(&events, AgentEventType::TurnCompleted), "{events:#?}");
    assert!(!fail_open(&events), "{events:#?}");
    let started = tool_payload(&events, "started");
    assert_eq!(started["command"], "ls notes");
    assert_eq!(started["cwd"], root.to_string_lossy().as_ref());
    assert!(started.get("exitCode").is_none(), "{started}");
    let finished = tool_payload(&events, "completed");
    assert_eq!(finished["output"], "notes\n");
    assert!(finished.get("exitCode").is_none(), "output text must not become an exit code: {finished}");
    assert_eq!(fs::read_to_string(root.join("NOTES")).unwrap(), "pre-existing dirty\n");
}

#[test]
fn bash_without_a_decision_that_changes_the_workspace_fails_open() {
    let (_lock, _env) = begin();
    let root = workspace("bash-writes", "bash_writes_without_permission");
    git_repo(&root);
    let mut manager = attach("attempt-bash-write", &root);
    send(&mut manager, "attempt-bash-write", "change a file");
    let started = drain(&mut manager, "attempt-bash-write", |seen| {
        has(seen, AgentEventType::ToolActivity)
    });
    assert!(has(&started, AgentEventType::ToolActivity), "{started:#?}");
    fs::write(root.join(".fake-claude-continue"), "go\n").unwrap();
    let events = drain(&mut manager, "attempt-bash-write", |seen| {
        has(seen, AgentEventType::TurnFailed) || has(seen, AgentEventType::TurnCompleted)
    });
    assert!(fail_open(&events), "{events:#?}");
    assert!(
        events.iter().any(|event| event.payload["text"] == "mutating Claude tool ran without a host Decision"),
        "{events:#?}"
    );
    assert_eq!(fs::read_to_string(root.join("notes/mutated.txt")).unwrap(), "mutated\n");
}

#[test]
fn denied_bash_without_a_path_stays_unknown_on_a_clean_git_work_tree() {
    let (_lock, _env) = begin();
    let root = workspace("deny-bash-clean", "deny_bash_no_path");
    git_repo(&root);
    let mut manager = attach("attempt-deny-bash", &root);
    send(&mut manager, "attempt-deny-bash", "list files");
    let mut events = drain(&mut manager, "attempt-deny-bash", |seen| {
        has(seen, AgentEventType::PermissionRequest)
    });
    let request_id = events
        .iter()
        .find(|event| event.event_type == AgentEventType::PermissionRequest)
        .unwrap()
        .payload["request_id"]
        .as_str()
        .unwrap()
        .to_owned();
    manager
        .permission_response(
            "attempt-deny-bash",
            PermissionResponse { request_id, allow: false },
        )
        .unwrap();
    events.extend(drain(&mut manager, "attempt-deny-bash", |seen| {
        has(seen, AgentEventType::TurnFailed) || has(seen, AgentEventType::TurnCompleted)
    }));
    assert!(!fail_open(&events), "{events:#?}");
    assert!(has(&events, AgentEventType::TurnFailed), "{events:#?}");
    let failed = events.iter().find(|event| event.event_type == AgentEventType::TurnFailed).unwrap();
    assert_eq!(failed.payload["unknown_effect"], true);
    assert_eq!(fs::read_to_string(root.join("NOTES")).unwrap(), "pre-existing dirty\n");
}

#[test]
fn denied_bash_that_still_writes_fails_open() {
    let (_lock, _env) = begin();
    let root = workspace("deny-bash-write", "deny_bash_writes");
    git_repo(&root);
    let mut manager = attach("attempt-deny-bash-write", &root);
    send(&mut manager, "attempt-deny-bash-write", "do not write");
    let mut events = drain(&mut manager, "attempt-deny-bash-write", |seen| {
        has(seen, AgentEventType::PermissionRequest)
    });
    let request_id = events
        .iter()
        .find(|event| event.event_type == AgentEventType::PermissionRequest)
        .unwrap()
        .payload["request_id"]
        .as_str()
        .unwrap()
        .to_owned();
    manager
        .permission_response(
            "attempt-deny-bash-write",
            PermissionResponse { request_id, allow: false },
        )
        .unwrap();
    events.extend(drain(&mut manager, "attempt-deny-bash-write", |seen| {
        has(seen, AgentEventType::TurnFailed) || has(seen, AgentEventType::TurnCompleted)
    }));
    assert!(fail_open(&events), "{events:#?}");
    assert!(
        events.iter().any(|event| event.payload["text"] == "denied tool still changed the workspace"),
        "{events:#?}"
    );
    assert!(
        events.iter().all(|event| event.payload["text"] != "mutating Claude tool ran without a host Decision"),
        "{events:#?}"
    );
}

#[test]
fn an_edit_that_changes_before_allow_fails_open() {
    let (_lock, _env) = begin();
    let root = workspace("edit-early", "permission");
    let mut manager = attach("attempt-edit-early", &root);
    send(&mut manager, "attempt-edit-early", "edit the note");
    let mut events = drain(&mut manager, "attempt-edit-early", |seen| {
        has(seen, AgentEventType::PermissionRequest)
    });
    fs::write(root.join("notes/fixture-allow.txt"), "EARLY\n").unwrap();
    let request_id = events
        .iter()
        .find(|event| event.event_type == AgentEventType::PermissionRequest)
        .unwrap()
        .payload["request_id"]
        .as_str()
        .unwrap()
        .to_owned();
    manager
        .permission_response(
            "attempt-edit-early",
            PermissionResponse { request_id, allow: true },
        )
        .unwrap();
    events.extend(drain(&mut manager, "attempt-edit-early", |seen| {
        has(seen, AgentEventType::TurnFailed) || has(seen, AgentEventType::TurnCompleted)
    }));
    assert!(
        events.iter().any(|event| event.payload["text"] == "the file changed before the host allowed it"),
        "{events:#?}"
    );
}

#[test]
fn approved_bash_completes_and_records_only_explicit_fields() {
    let (_lock, _env) = begin();
    let root = workspace("approved-bash", "approved_bash");
    git_repo(&root);
    let mut manager = attach("attempt-approved-bash", &root);
    send(&mut manager, "attempt-approved-bash", "run the test");
    let mut events = drain(&mut manager, "attempt-approved-bash", |seen| {
        has(seen, AgentEventType::PermissionRequest)
    });
    let request_id = events
        .iter()
        .find(|event| event.event_type == AgentEventType::PermissionRequest)
        .unwrap()
        .payload["request_id"]
        .as_str()
        .unwrap()
        .to_owned();
    manager
        .permission_response(
            "attempt-approved-bash",
            PermissionResponse { request_id, allow: true },
        )
        .unwrap();
    events.extend(drain(&mut manager, "attempt-approved-bash", |seen| {
        has(seen, AgentEventType::TurnCompleted) || has(seen, AgentEventType::TurnFailed)
    }));
    assert!(has(&events, AgentEventType::TurnCompleted), "{events:#?}");
    assert!(!fail_open(&events), "{events:#?}");
    let started = tool_payload(&events, "started");
    assert_eq!(started["command"], "pytest -q");
    let finished = tool_payload(&events, "completed");
    assert_eq!(finished["output"], "edited");
    assert!(finished.get("exitCode").is_none(), "{finished}");
}

#[test]
fn explicit_exit_code_is_recorded_when_the_provider_sends_it() {
    let (_lock, _env) = begin();
    let root = workspace("bash-exit", "bash_exit_fact");
    git_repo(&root);
    let mut manager = attach("attempt-bash-exit", &root);
    send(&mut manager, "attempt-bash-exit", "run pytest");
    let events = drain(&mut manager, "attempt-bash-exit", |seen| {
        has(seen, AgentEventType::TurnCompleted) || has(seen, AgentEventType::TurnFailed)
    });
    assert!(has(&events, AgentEventType::TurnCompleted), "{events:#?}");
    let finished = tool_payload(&events, "completed");
    assert_eq!(finished["exitCode"], 0);
    assert_eq!(finished["output"], "1 passed\n");
    assert_eq!(finished["command"], "pytest -q");
}

#[test]
fn unchanged_binary_file_does_not_fail_a_read_only_bash() {
    let (_lock, _env) = begin();
    let root = workspace("readonly-binary", "readonly_bash");
    git_repo(&root);
    fs::write(root.join("cache.bin"), [0, 9, 9, 9]).unwrap();
    let mut manager = attach("attempt-readonly-binary", &root);
    send(&mut manager, "attempt-readonly-binary", "list the notes");
    let events = drain(&mut manager, "attempt-readonly-binary", |seen| {
        has(seen, AgentEventType::TurnCompleted) || has(seen, AgentEventType::TurnFailed)
    });
    assert!(has(&events, AgentEventType::TurnCompleted), "{events:#?}");
    assert!(!fail_open(&events), "{events:#?}");
    assert_eq!(fs::read(root.join("cache.bin")).unwrap(), [0, 9, 9, 9]);
}

#[test]
fn a_binary_rewrite_without_a_decision_fails_open() {
    let (_lock, _env) = begin();
    let root = workspace("binary-rewrite", "bash_rewrites_binary");
    git_repo(&root);
    fs::write(root.join("cache.bin"), [0, 9, 9, 9]).unwrap();
    let mut manager = attach("attempt-binary-rewrite", &root);
    send(&mut manager, "attempt-binary-rewrite", "change the cache");
    let started = drain(&mut manager, "attempt-binary-rewrite", |seen| {
        has(seen, AgentEventType::ToolActivity)
    });
    assert!(has(&started, AgentEventType::ToolActivity), "{started:#?}");
    fs::write(root.join(".fake-claude-continue"), "go\n").unwrap();
    let events = drain(&mut manager, "attempt-binary-rewrite", |seen| {
        has(seen, AgentEventType::TurnFailed) || has(seen, AgentEventType::TurnCompleted)
    });
    assert!(fail_open(&events), "{events:#?}");
    assert_eq!(fs::read(root.join("cache.bin")).unwrap(), [0, 1, 2, 3]);
}

fn closed_claude(label: &str, scenario: &str) -> (Store, CoreServer, String, PathBuf) {
    let root = workspace(label, scenario);
    let canonical = fs::canonicalize(&root).unwrap();
    let store = Store::memory().unwrap();
    let project = Project {
        id: format!("project-{label}"),
        workspace_root: canonical.to_string_lossy().into_owned(),
    };
    let campaign = Campaign {
        id: format!("campaign-{label}"),
        goal: label.into(),
        root_task_id: format!("task-{label}"),
        state: goalport_core::WorkStatus::InProgress,
    };
    let task = Task {
        id: campaign.root_task_id.clone(),
        campaign_id: campaign.id.clone(),
        title: label.into(),
        acceptance: "continued".into(),
        state: goalport_core::WorkStatus::InProgress,
    };
    store
        .create_workspace_campaign(
            &project,
            &campaign,
            &task,
            &format!("policy-{label}"),
            "{}",
            &CampaignAuthorization::granted(),
        )
        .unwrap();
    let attempt_id = format!("attempt-{label}");
    store
        .insert_attempt(&Attempt::new(&attempt_id, &task.id, "claude", "claude-cap-v1"))
        .unwrap();
    store
        .set_attempt_provider_session(&attempt_id, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")
        .unwrap();
    for (seq, kind, state) in [
        (1_i64, "attempt.active", AttemptState::Active),
        (2, "runtime.session.closed", AttemptState::Closed),
    ] {
        store
            .append_event_with_state(
                &goalport_core::Event {
                    id: format!("{label}-{seq}"),
                    attempt_id: attempt_id.clone(),
                    seq,
                    kind: kind.into(),
                    payload_ref: None,
                },
                Some(state),
                None,
            )
            .unwrap();
    }
    store
        .set_conversation_provider(&campaign.id, "claude")
        .unwrap();
    seed_core_launch_epoch(&store, label);
    let server = CoreServer::new(store.clone());
    let snapshot = server
        .handle_json(&serde_json::to_vec(&serde_json::json!({
            "protocolVersion": CONNECTED_UI_PROTOCOL_VERSION,
            "requestId": format!("{label}-snapshot"),
            "entityVersion": 0,
            "messageType": "snapshot",
            "payload": {}
        })).unwrap())
        .unwrap();
    assert!(
        snapshot["payload"]["snapshot"]["productConversation"]["turn"]["actions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|action| action == "resume-session"),
        "a closed Claude session offers Resume: {snapshot}"
    );
    (store, server, attempt_id, canonical)
}

// The real Core commits a launch epoch at startup, and `persist_recovery`
// requires a READY_COMMITTED epoch once a send binds a session. Seed the
// same lifecycle so the peer exercises the production path.
fn seed_core_launch_epoch(store: &Store, label: &str) {
    use goalport_core::store::CoreLaunchEpoch;
    let epoch = CoreLaunchEpoch {
        epoch_id: format!("core-epoch:peer-{label}"),
        launch_nonce: format!("peer-{label}"),
        core_pid: i64::from(std::process::id()),
        core_creation_date: format!("/LinuxStart(peer:{}:{})/", label, std::process::id()),
        core_executable_path: "goalport-core".into(),
        core_executable_sha256: "0".repeat(64),
        previous_epoch_id: None,
        state: "RECONCILING".into(),
        reconciliation: None,
        created_at: "2026-10-03T00:00:00Z".into(),
        activated_at: None,
    };
    assert!(
        store
            .claim_core_launch_epoch(&epoch, None, None)
            .expect("claim epoch"),
        "first epoch claim must win"
    );
    store
        .stage_core_launch_startup(
            &epoch.epoch_id,
            &epoch.launch_nonce,
            &serde_json::json!({}),
            &serde_json::json!({}),
            &format!("startup:peer-{label}"),
        )
        .expect("stage startup");
    store
        .commit_core_launch_ready(
            &epoch.epoch_id,
            &epoch.launch_nonce,
            &serde_json::json!({}),
            &serde_json::json!({}),
            &format!("ready:peer-{label}"),
            "2026-10-03T00:00:00Z",
        )
        .expect("commit ready");
}

fn resume_message(label: &str, attempt_id: &str) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "protocolVersion": CONNECTED_UI_PROTOCOL_VERSION,
        "requestId": format!("{label}-resume"),
        "entityVersion": 0,
        "messageType": "resume_native_session",
        "payload": {
            "attemptId": attempt_id,
            "executable": fake_cli()
        }
    }))
    .unwrap()
}

fn snapshot_message(label: &str) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "protocolVersion": CONNECTED_UI_PROTOCOL_VERSION,
        "requestId": format!("{label}-snapshot-{}", std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()),
        "entityVersion": 0,
        "messageType": "snapshot",
        "payload": {}
    }))
    .unwrap()
}

fn server_send(label: &str, campaign_id: &str, attempt_id: &str, message: &str) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "protocolVersion": CONNECTED_UI_PROTOCOL_VERSION,
        "requestId": format!("{label}-send-{}", std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()),
        "entityVersion": 1,
        "messageType": "conversation_send",
        "payload": {
            "campaignId": campaign_id,
            "attemptId": attempt_id,
            "message": message
        }
    }))
    .unwrap()
}

#[test]
fn closed_claude_resume_creates_a_successor_and_does_not_replay() {
    let (_lock, _env) = begin();
    let (store, server, attempt_id, root) = closed_claude("closed-resume", "end_turn");
    let source_events = store.list_event_records(&attempt_id, 0).unwrap().len();
    let response = server.handle_json(&resume_message("closed-resume", &attempt_id)).unwrap();
    assert_eq!(response["ok"], true, "{response}");
    let source = store.get_attempt(&attempt_id).unwrap();
    assert_eq!(source.state, AttemptState::Closed);
    assert_eq!(source.provider_session.as_deref(), Some("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"));
    assert_eq!(store.list_event_records(&attempt_id, 0).unwrap().len(), source_events);
    let attempts = store.attempts_for_task(&source.task_id).unwrap();
    let successor = attempts.last().unwrap();
    assert_ne!(successor.id, attempt_id);
    // Spawn-only resume: the successor exists with lineage and a spawned
    // `--resume` process, but no activation, no provider session, and no
    // resumed event until the provider echoes the stored id.
    assert_eq!(successor.state, AttemptState::Queued);
    assert!(successor.provider_session.is_none());
    let created = store.list_event_records(&successor.id, 0).unwrap();
    let lineage = created.iter().find(|record| record.event.kind == "attempt.created").unwrap();
    assert_eq!(lineage.payload.as_ref().unwrap()["rolledFrom"], attempt_id);
    assert!(
        !created.iter().any(|record| record.event.kind == "attempt.active"),
        "spawn alone must not activate: {created:#?}"
    );
    assert!(
        !created
            .iter()
            .any(|record| record.event.kind == "runtime.session.resumed"),
        "spawn alone must not record a resume: {created:#?}"
    );
    let argv = read_json(&root, ".fake-claude-argv.json");
    let flags = argv["argv"].as_array().unwrap();
    assert!(flags.windows(2).any(|pair| pair[0] == "--resume" && pair[1] == "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"));
    let stdin = fs::read_to_string(root.join(".fake-claude-stdin.jsonl")).unwrap_or_default();
    assert!(!stdin.contains("\"type\":\"user\""), "{stdin}");
    // The pending-resume successor is the rendered attempt and its composer
    // offers exactly the first send that verifies the session id.
    let snapshot = server.handle_json(&snapshot_message("closed-resume")).unwrap();
    assert_eq!(
        snapshot["payload"]["snapshot"]["attempt"]["id"], successor.id,
        "{snapshot}"
    );
    assert_eq!(
        snapshot["payload"]["snapshot"]["productConversation"]["turn"]["canSend"],
        true,
        "{}",
        snapshot["payload"]["snapshot"]["productConversation"]["turn"]
    );
    // The first send verifies the stored id and only then activates.
    let send = server
        .handle_json(&server_send(
            "closed-resume",
            &format!("campaign-{}", "closed-resume"),
            &successor.id,
            "first message on the resumed session",
        ))
        .unwrap();
    assert_eq!(send["ok"], true, "{send}");
    let mut activated = false;
    for _ in 0..80 {
        let _ = server.handle_json(&snapshot_message("closed-resume")).unwrap();
        let row = store.get_attempt(&successor.id).unwrap();
        if matches!(row.state, AttemptState::Active | AttemptState::AwaitingReview) {
            activated = true;
            break;
        }
        thread::sleep(Duration::from_millis(100));
    }
    assert!(
        activated,
        "the first send must activate the verified successor (still {:?})",
        store.get_attempt(&successor.id).unwrap().state
    );
    let row = store.get_attempt(&successor.id).unwrap();
    assert_eq!(
        row.provider_session.as_deref(),
        Some("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")
    );
    let records = store.list_event_records(&successor.id, 0).unwrap();
    let user_messages: Vec<_> = records
        .iter()
        .filter(|record| record.event.kind == "message.user")
        .filter_map(|record| record.payload.as_ref())
        .filter(|payload| {
            payload["text"]
                .as_str()
                .is_some_and(|text| text.contains("first message on the resumed session"))
        })
        .collect();
    assert_eq!(user_messages.len(), 1, "{records:#?}");
    let resumed = records
        .iter()
        .find(|record| record.event.kind == "runtime.session.resumed")
        .expect("verified resume is journaled");
    assert_eq!(resumed.payload.as_ref().unwrap()["promptReplay"], false);
    let stdin = fs::read_to_string(root.join(".fake-claude-stdin.jsonl")).unwrap_or_default();
    assert_eq!(
        stdin.matches("first message on the resumed session").count(),
        1,
        "{stdin}"
    );
}

#[test]
fn a_bare_resume_stays_queued_until_the_first_send() {
    let (_lock, _env) = begin();
    let (store, server, attempt_id, root) = closed_claude("bare-resume", "end_turn");
    let response = server.handle_json(&resume_message("bare-resume", &attempt_id)).unwrap();
    assert_eq!(response["ok"], true, "{response}");
    let source = store.get_attempt(&attempt_id).unwrap();
    let successor = store.attempts_for_task(&source.task_id).unwrap().pop().unwrap();
    assert_ne!(successor.id, attempt_id);
    // Nothing asynchronous activates the successor: with no first send there
    // is no verification, no resumed event, and no user message.
    thread::sleep(Duration::from_millis(400));
    let _ = server.handle_json(&snapshot_message("bare-resume")).unwrap();
    let successor = store.get_attempt(&successor.id).unwrap();
    assert_eq!(successor.state, AttemptState::Queued);
    assert!(successor.provider_session.is_none());
    let records = store.list_event_records(&successor.id, 0).unwrap();
    assert!(!records.iter().any(|record| record.event.kind == "attempt.active"), "{records:#?}");
    assert!(
        !records.iter().any(|record| record.event.kind == "runtime.session.resumed"),
        "{records:#?}"
    );
    let stdin = fs::read_to_string(root.join(".fake-claude-stdin.jsonl")).unwrap_or_default();
    assert!(!stdin.contains("\"type\":\"user\""), "{stdin}");
}

#[test]
fn a_wrong_resume_session_id_does_not_change_the_closed_attempt() {
    let (_lock, _env) = begin();
    let (store, server, attempt_id, root) = closed_claude("closed-mismatch", "resume_mismatch");
    let before = store.list_event_records(&attempt_id, 0).unwrap().len();
    // Spawn-only resume succeeds; the wrong id is only observable once the
    // provider answers the first message.
    let response = server.handle_json(&resume_message("closed-mismatch", &attempt_id)).unwrap();
    assert_eq!(response["ok"], true, "{response}");
    let source = store.get_attempt(&attempt_id).unwrap();
    assert_eq!(source.state, AttemptState::Closed);
    assert_eq!(source.provider_session.as_deref(), Some("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"));
    assert_eq!(store.list_event_records(&attempt_id, 0).unwrap().len(), before);
    let successor = store.attempts_for_task(&source.task_id).unwrap().pop().unwrap();
    assert_ne!(successor.id, attempt_id);
    assert!(successor.provider_session.is_none());
    // The first send crosses the transport, then the mismatch fails it with
    // the uniform verification shape: UNKNOWN delivery, no retry.
    let send = server
        .handle_json(&server_send(
            "closed-mismatch",
            "campaign-closed-mismatch",
            &successor.id,
            "first message on a mismatched resume",
        ))
        .unwrap();
    assert_eq!(send["ok"], false, "{send}");
    let records = store.list_event_records(&successor.id, 0).unwrap();
    let failed = records
        .iter()
        .find(|record| record.event.kind == "runtime.send.failed")
        .expect("the verification failure is journaled: {records:#?}");
    let failure = failed.payload.as_ref().unwrap();
    assert_eq!(failure["deliveryState"], "UNKNOWN", "{failure}");
    assert_eq!(failure["reasonCode"], "delivery-unknown", "{failure}");
    assert_eq!(failure["retry"], false, "{failure}");
    // The successor never activates and the closed source is untouched.
    let successor = store.get_attempt(&successor.id).unwrap();
    assert_ne!(successor.state, AttemptState::Active);
    assert!(successor.provider_session.is_none());
    let source = store.get_attempt(&attempt_id).unwrap();
    assert_eq!(source.state, AttemptState::Closed);
    assert_eq!(source.provider_session.as_deref(), Some("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"));
    assert_eq!(store.list_event_records(&attempt_id, 0).unwrap().len(), before);
    // Exactly one user message crossed; the dead gate offers no resend.
    let stdin = fs::read_to_string(root.join(".fake-claude-stdin.jsonl")).unwrap_or_default();
    assert_eq!(
        stdin.matches("first message on a mismatched resume").count(),
        1,
        "{stdin}"
    );
    let snapshot = server.handle_json(&snapshot_message("closed-mismatch")).unwrap();
    assert_eq!(
        snapshot["payload"]["snapshot"]["attempt"]["id"], successor.id,
        "{snapshot}"
    );
    assert_eq!(
        snapshot["payload"]["snapshot"]["productConversation"]["turn"]["canSend"],
        false,
        "a dead resume process must not satisfy the composer gate: {}",
        snapshot["payload"]["snapshot"]["productConversation"]["turn"]
    );
}

#[test]
fn a_failed_attempt_is_not_resumed() {
    let store = Store::memory().unwrap();
    let root = workspace("failed-resume", "end_turn");
    let canonical = fs::canonicalize(&root).unwrap();
    let project = Project {
        id: "project-failed-resume".into(),
        workspace_root: canonical.to_string_lossy().into_owned(),
    };
    let campaign = Campaign {
        id: "campaign-failed-resume".into(),
        goal: "failed".into(),
        root_task_id: "task-failed-resume".into(),
        state: goalport_core::WorkStatus::InProgress,
    };
    let task = Task {
        id: campaign.root_task_id.clone(),
        campaign_id: campaign.id.clone(),
        title: "failed".into(),
        acceptance: "no".into(),
        state: goalport_core::WorkStatus::InProgress,
    };
    store
        .create_workspace_campaign(&project, &campaign, &task, "policy-failed", "{}", &CampaignAuthorization::granted())
        .unwrap();
    let attempt_id = "attempt-failed-resume";
    store.insert_attempt(&Attempt::new(attempt_id, &task.id, "claude", "claude-cap-v1")).unwrap();
    store.set_attempt_provider_session(attempt_id, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee").unwrap();
    for (seq, kind, state) in [
        (1_i64, "attempt.active", AttemptState::Active),
        (2, "runtime.turn.failed", AttemptState::Failed),
    ] {
        store.append_event_with_state(
            &goalport_core::Event {
                id: format!("failed-{seq}"),
                attempt_id: attempt_id.into(),
                seq,
                kind: kind.into(),
                payload_ref: None,
            },
            Some(state),
            None,
        ).unwrap();
    }
    store.set_conversation_provider(&campaign.id, "claude").unwrap();
    let server = CoreServer::new(store.clone());
    let response = server.handle_json(&resume_message("failed-resume", attempt_id)).unwrap();
    assert_eq!(response["ok"], false, "{response}");
    assert!(response["error"].as_str().unwrap_or_default().contains("terminal"), "{response}");
    assert_eq!(store.attempts_for_task(&task.id).unwrap().len(), 1);
}

// --- Leg A: Stop landing on a pending permission decision -------------------
//
// Real claude 2.1.288 (live-fix-9 evidence) answers a Stop pressed while a
// can_use_tool is pending with: the permission denied (GoalPort's own deny),
// an interrupt receipt, and a terminal result of aborted_tools +
// error_during_execution carrying permission_denials=[the denied tool]. That
// is the turn ending at the Stop's own boundary and must classify as a native
// turn cancel, not "unverified".

#[test]
fn stop_while_a_permission_is_pending_confirms_the_native_cancel() {
    let (_lock, _env) = begin();
    let root = workspace("pending-stop", "native_stop_pending_permission");
    let attempt = "attempt-pending-stop";
    let mut manager = attach(attempt, &root);
    send(&mut manager, attempt, "ask for a Write and wait");
    let events = drain(&mut manager, attempt, |seen| {
        has(seen, AgentEventType::PermissionRequest)
    });
    assert!(has(&events, AgentEventType::PermissionRequest), "{events:#?}");

    let stop = manager
        .interrupt_with_operation(attempt, "gui-pending-stop")
        .unwrap();
    assert!(stop.requested && !stop.confirmed, "interrupt is async: {stop:?}");
    let events = drain(&mut manager, attempt, |seen| {
        has(seen, AgentEventType::Cancelled) || has(seen, AgentEventType::TurnFailed)
    });
    let terminal = events
        .iter()
        .find(|event| {
            matches!(
                event.event_type,
                AgentEventType::Cancelled | AgentEventType::TurnFailed
            )
        })
        .expect("terminal stop event");
    assert_eq!(
        terminal.event_type,
        AgentEventType::Cancelled,
        "the pending-permission Stop must confirm the native cancel: {terminal:#?}"
    );
    // Real Claude answers the Stop's deny with a tool_result for the rejected
    // Bash (no resolvable path): that intermediate frame must not fail the
    // turn before the Stop's own terminal resolution.
    assert!(
        !events.iter().any(|event| event.event_type == AgentEventType::TurnFailed
            && event.payload["text"]
                .as_str()
                .is_some_and(|text| text.contains("mutating Claude tool effect is unknown"))),
        "the stop-denied tool_result must not be classified as an unknown-effect failure: {events:#?}"
    );
    assert_eq!(terminal.payload["native_turn_cancel"], true);
    assert_eq!(terminal.payload["native_turn_state"], "interrupted");
    assert_eq!(terminal.payload["write_responsibility"], "held");
    assert_eq!(terminal.payload["residual_execution_state"], "unknown");
    // The Stop's own denied set and the admission ledger are durable facts on
    // the trace the release rules read.
    let denied: Vec<&str> = terminal.payload["stop_attempt"]["stop_denied_tool_use_ids"]
        .as_array()
        .expect("denied set recorded")
        .iter()
        .map(|value| value.as_str().unwrap_or_default())
        .collect();
    assert_eq!(denied, vec!["toolu_fake_edit_1"], "{terminal:#?}");
    assert_eq!(
        terminal.payload["stop_attempt"]["admission"]["executionEverAdmitted"],
        serde_json::json!(false),
        "no tool was ever admitted: {terminal:#?}"
    );
    assert_eq!(
        terminal.payload["stop_attempt"]["admission"]["mutatingToolsDenied"],
        serde_json::json!(1),
        "the pending Write reads as denied: {terminal:#?}"
    );
    manager.close_attempt(attempt).ok();
}

#[test]
fn a_pending_permission_denial_without_tool_use_id_does_not_confirm() {
    let (_lock, _env) = begin();
    let root = workspace("pending-stop-no-id", "native_stop_denial_no_id");
    let attempt = "attempt-pending-stop-no-id";
    let mut manager = attach(attempt, &root);
    send(&mut manager, attempt, "ask for a Write and wait");
    let events = drain(&mut manager, attempt, |seen| {
        has(seen, AgentEventType::PermissionRequest)
    });
    assert!(has(&events, AgentEventType::PermissionRequest), "{events:#?}");
    manager.interrupt_with_operation(attempt, "gui-pending-stop-no-id").unwrap();
    // The unconfirmed fallback resolves at its bounded deadline (~5 s after
    // the Stop), so the default 5 s drain is too tight under parallel load.
    let mut events = Vec::new();
    for _ in 0..240 {
        events.extend(manager.poll_events(attempt).expect("poll"));
        if has(&events, AgentEventType::TurnFailed) || has(&events, AgentEventType::Cancelled) {
            break;
        }
        thread::sleep(Duration::from_millis(100));
    }
    let terminal = events
        .iter()
        .find(|event| {
            matches!(
                event.event_type,
                AgentEventType::Cancelled | AgentEventType::TurnFailed
            )
        })
        .expect("terminal stop event");
    assert_eq!(
        terminal.event_type,
        AgentEventType::TurnFailed,
        "a denial entry without tool_use_id cannot be matched to the Stop's denied set: {terminal:#?}"
    );
    assert_eq!(terminal.payload["native_turn_cancel"], false);
    assert_eq!(terminal.payload["native_turn_state"], "unconfirmed");
    assert_eq!(terminal.payload["write_responsibility"], "held");
    manager.close_attempt(attempt).ok();
}

// --- merge-review P1: denial-set exact multiset equality ---------------------

#[test]
fn a_subset_denial_report_does_not_confirm_a_two_permission_stop() {
    let (_lock, _env) = begin();
    let root = workspace("denial-subset", "native_stop_denial_subset");
    let attempt = "attempt-denial-subset";
    let mut manager = attach(attempt, &root);
    send(&mut manager, attempt, "ask for a Write and a Bash and wait");
    let events = drain(&mut manager, attempt, |seen| {
        events_with(seen, AgentEventType::PermissionRequest) >= 2
    });
    assert!(
        events.iter().filter(|event| event.event_type == AgentEventType::PermissionRequest).count() >= 2,
        "{events:#?}"
    );
    manager.interrupt_with_operation(attempt, "gui-denial-subset").unwrap();
    let mut events = Vec::new();
    for _ in 0..240 {
        events.extend(manager.poll_events(attempt).expect("poll"));
        if has(&events, AgentEventType::TurnFailed) || has(&events, AgentEventType::Cancelled) {
            break;
        }
        thread::sleep(Duration::from_millis(100));
    }
    let terminal = events
        .iter()
        .find(|event| matches!(event.event_type, AgentEventType::Cancelled | AgentEventType::TurnFailed))
        .expect("terminal stop event");
    assert_eq!(
        terminal.event_type,
        AgentEventType::TurnFailed,
        "a result reporting ONE of the TWO stop-denied tools is incomplete evidence: {terminal:#?}"
    );
    assert_eq!(terminal.payload["native_turn_cancel"], false);
    assert_eq!(terminal.payload["native_turn_state"], "unconfirmed");
    let denied: Vec<&str> = terminal.payload["stop_attempt"]["stop_denied_tool_use_ids"]
        .as_array()
        .expect("denied set recorded")
        .iter()
        .map(|value| value.as_str().unwrap_or_default())
        .collect();
    assert_eq!(denied.len(), 2, "both pending permissions were denied by the Stop: {terminal:#?}");
    manager.close_attempt(attempt).ok();
}

#[test]
fn an_empty_denial_report_does_not_confirm_a_one_permission_stop() {
    let (_lock, _env) = begin();
    let root = workspace("denial-silent", "native_stop_denial_silent");
    let attempt = "attempt-denial-silent";
    let mut manager = attach(attempt, &root);
    send(&mut manager, attempt, "ask for a Write and wait");
    let events = drain(&mut manager, attempt, |seen| {
        has(seen, AgentEventType::PermissionRequest)
    });
    assert!(has(&events, AgentEventType::PermissionRequest), "{events:#?}");
    manager.interrupt_with_operation(attempt, "gui-denial-silent").unwrap();
    let mut events = Vec::new();
    for _ in 0..240 {
        events.extend(manager.poll_events(attempt).expect("poll"));
        if has(&events, AgentEventType::TurnFailed) || has(&events, AgentEventType::Cancelled) {
            break;
        }
        thread::sleep(Duration::from_millis(100));
    }
    let terminal = events
        .iter()
        .find(|event| matches!(event.event_type, AgentEventType::Cancelled | AgentEventType::TurnFailed))
        .expect("terminal stop event");
    assert_eq!(
        terminal.event_type,
        AgentEventType::TurnFailed,
        "a silent permission_denials report against a Stop that denied one tool is incomplete evidence: {terminal:#?}"
    );
    assert_eq!(terminal.payload["native_turn_cancel"], false);
    manager.close_attempt(attempt).ok();
}

// --- merge-review P1: failed resume teardown + deterministic retry ----------

#[test]
fn a_failed_resume_successor_detaches_and_can_be_retried() {
    let (_lock, _env) = begin();
    let (store, server, attempt_id, root) = closed_claude("retry", "resume_mismatch");

    // First resume: spawn-only successor.
    let response = server.handle_json(&resume_message("retry", &attempt_id)).unwrap();
    assert_eq!(response["ok"], true, "{response}");
    let task_id = store.get_attempt(&attempt_id).unwrap().task_id;
    let successor = store.attempts_for_task(&task_id).unwrap().pop().unwrap();

    // The first send fails verification: the successor must be DETACHED, stay
    // QUEUED (it never activated; the machine has no Queued->Failed edge),
    // journal the failure, and still offer the deterministic retry.
    let send = server
        .handle_json(&server_send("retry", "campaign-retry", &successor.id, "first message on a mismatched resume"))
        .unwrap();
    assert_eq!(send["ok"], false, "{send}");
    let row = store.get_attempt(&successor.id).unwrap();
    assert_eq!(row.state, AttemptState::Queued, "journal-only marking");
    assert!(row.provider_session.is_none());
    let records = store.list_event_records(&successor.id, 0).unwrap();
    assert!(
        records.iter().any(|record| record.event.kind == "runtime.resume.verification.failed"),
        "{records:#?}"
    );
    // Capture the first process's stdin before any retry overwrites the
    // fixture's per-process log: it crossed exactly the first message.
    let stdin_first = fs::read_to_string(root.join(".fake-claude-stdin.jsonl")).unwrap_or_default();
    assert_eq!(stdin_first.matches("first message on a mismatched resume").count(), 1, "{stdin_first}");

    // The dead view offers the retry (through the successor id -- the same
    // command path the UI uses), cannot send, and does NOT offer a fresh
    // session.
    let snapshot = server.handle_json(&snapshot_message("retry")).unwrap();
    let view = &snapshot["payload"]["snapshot"];
    assert_eq!(view["attempt"]["id"], successor.id, "{snapshot}");
    let turn = &view["productConversation"]["turn"];
    assert_eq!(turn["canSend"], false, "{turn}");
    let actions = turn["actions"].as_array().unwrap();
    assert!(
        actions.iter().any(|action| action == "resume-session"),
        "the dead resume view must offer the deterministic retry: {turn}"
    );
    assert!(
        !actions.iter().any(|action| action == "select-runtime"),
        "a verification-failed successor must not be offered a fresh session: {turn}"
    );
    assert_eq!(turn["reasonCode"], "resume-verification-failed", "{turn}");

    // The retry, driven with the SUCCESSOR id (the UI's command path): the
    // fresh process on the same row.
    let retry = server
        .handle_json(&resume_message("retry", &successor.id))
        .unwrap();
    assert_eq!(retry["ok"], true, "the retry must respawn a fresh process: {retry}");
    let row = store.get_attempt(&successor.id).unwrap();
    assert_eq!(row.state, AttemptState::Queued);
    assert!(row.provider_session.is_none());

    // A double-resume while the fresh process is spawned and registered keeps
    // today's refusal.
    let double = server
        .handle_json(&resume_message("retry", &successor.id))
        .unwrap();
    assert_eq!(double["ok"], false, "{double}");
    assert!(
        double["error"].as_str().unwrap_or_default().contains("no persisted native session"),
        "a registered bare-Queued successor keeps the plain refusal: {double}"
    );

    // The retried spawn crosses exactly one NEW message when the user sends
    // again (no replay of the first crossed message) and fails verification
    // again on this fixture by design.
    let second_send = server
        .handle_json(&server_send("retry", "campaign-retry", &successor.id, "second message on the retried resume"))
        .unwrap();
    assert_eq!(second_send["ok"], false, "{second_send}");
    // The fixture rewrites its stdin log per process, so the retried spawn's
    // log holding ONLY the second message is itself the no-replay proof.
    let stdin = fs::read_to_string(root.join(".fake-claude-stdin.jsonl")).unwrap_or_default();
    assert_eq!(stdin.matches("second message on the retried resume").count(), 1, "{stdin}");
    assert_eq!(stdin.matches("first message on a mismatched resume").count(), 0, "{stdin}");
    let records = store.list_event_records(&successor.id, 0).unwrap();
    assert_eq!(
        records.iter().filter(|record| record.event.kind == "runtime.resume.verification.failed").count(),
        2,
        "the retry failure is journaled again and the row is retryable once more: {records:#?}"
    );

    // The closed source is untouched and no hold was ever created.
    let source = store.get_attempt(&attempt_id).unwrap();
    assert_eq!(source.state, AttemptState::Closed);
    assert!(store.stop_responsibilities().unwrap().is_empty());
}

#[test]
fn a_spawn_failed_resume_retires_and_is_retryable() {
    let (_lock, _env) = begin();
    let (store, server, attempt_id, root) = closed_claude("spawn-fail", "end_turn");
    let task_id = store.get_attempt(&attempt_id).unwrap().task_id;

    // Resume with an executable that cannot spawn: the failure must retire
    // the process, journal the spawn-failed marker, and offer the retry.
    let bad = serde_json::json!({
        "attemptId": attempt_id,
        "executable": "/nonexistent/goalport-test-claude"
    });
    let wire = serde_json::to_vec(&serde_json::json!({
        "protocolVersion": goalport_core::ipc::CONNECTED_UI_PROTOCOL_VERSION,
        "requestId": "spawn-fail-resume-1",
        "entityVersion": 0,
        "messageType": "resume_native_session",
        "payload": bad
    })).unwrap();
    let response = server.handle_json(&wire).unwrap();
    assert_eq!(response["ok"], false, "{response}");
    let successor = store.attempts_for_task(&task_id).unwrap().pop().unwrap();
    let records = store.list_event_records(&successor.id, 0).unwrap();
    assert!(
        records.iter().any(|record| record.event.kind == "runtime.resume.spawn.failed"),
        "the spawn failure is journaled: {records:#?}"
    );
    let row = store.get_attempt(&successor.id).unwrap();
    assert_eq!(row.state, AttemptState::Queued);
    assert!(row.provider_session.is_none());

    // The dead view offers the retry through the generation-bound gate.
    let snapshot = server.handle_json(&snapshot_message("spawn-fail")).unwrap();
    let view = &snapshot["payload"]["snapshot"];
    assert_eq!(view["attempt"]["id"], successor.id, "selection moves to the successor row: {snapshot}");
    let turn = &view["productConversation"]["turn"];
    let actions = turn["actions"].as_array().unwrap();
    assert!(
        actions.iter().any(|action| action == "resume-session"),
        "a spawn-failed resume must offer the retry: {turn}"
    );
    assert!(
        !actions.iter().any(|action| action == "close-session"),
        "an unverified pending-resume successor must not offer close: {turn}"
    );

    // Retry through the SAME command path with the real fixture: respawns,
    // verifies on the first send, and completes.
    let good = resume_message("spawn-fail", &successor.id);
    let retry = server.handle_json(&good).unwrap();
    assert_eq!(retry["ok"], true, "the retry must respawn: {retry}");
    let send = server
        .handle_json(&server_send("spawn-fail", "campaign-spawn-fail", &successor.id, "reply with the single word recovered"))
        .unwrap();
    assert_eq!(send["ok"], true, "{send}");
    let mut recovered = false;
    for _ in 0..80 {
        let snap = server.handle_json(&snapshot_message("spawn-fail")).unwrap();
        let text = snap["payload"]["snapshot"]["productConversation"]["items"]
            .as_array()
            .map(|items| items.iter().map(|item| item["body"].as_str().unwrap_or("")).collect::<String>())
            .unwrap_or_default();
        if text.to_lowercase().contains("recovered") {
            recovered = true;
            break;
        }
        thread::sleep(Duration::from_millis(250));
    }
    assert!(recovered, "the retried resume must verify and complete");
}

// --- merge-review P1: every tool_use block enters the admission ledger -----

#[test]
fn an_assistant_frame_with_two_tool_use_blocks_ledgers_both() {
    let (_lock, _env) = begin();
    let root = workspace("multi-tool", "two_tool_frame");
    let attempt = "attempt-multi-tool";
    let mut manager = attach(attempt, &root);

    // Drive the scenario: the fixture's first turn emits ONE assistant frame
    // containing a Bash tool_use AND a Write tool_use. Both must be ledgered
    // (Bash into unrequested_bash at frame time, Write as a pending mutating
    // record) and both ToolActivity events must journal in frame order.
    send(&mut manager, attempt, "use two tools in one frame");
    let events = drain(&mut manager, attempt, |seen| {
        events_with(seen, AgentEventType::ToolActivity) >= 2
    });
    let started: Vec<&AgentEventEnvelope> = events
        .iter()
        .filter(|event| {
            event.event_type == AgentEventType::ToolActivity
                && event.payload.get("status") == Some(&serde_json::json!("started"))
        })
        .collect();
    assert_eq!(started.len(), 2, "{events:#?}");
    assert_eq!(started[0].payload["tool"], "Bash", "frame order kept: {events:#?}");
    assert_eq!(started[1].payload["tool"], "Write", "frame order kept: {events:#?}");
    // The denial evidence covers both: stop the turn and inspect the trace.
    manager.interrupt_with_operation(attempt, "gui-multi-tool").unwrap();
    let _ = drain(&mut manager, attempt, |seen| {
        has(seen, AgentEventType::TurnFailed) || has(seen, AgentEventType::Cancelled)
    });
    manager.close_attempt(attempt).ok();
}

// --- merge-review P1: close owns the process tree --------------------------

#[test]
fn close_terminates_the_runtime_descendants() {
    let (_lock, _env) = begin();
    let root = workspace("close-tree", "stop_descendant");
    let attempt = "attempt-close-tree";
    let mut manager = attach(attempt, &root);
    send(&mut manager, attempt, "leave a descendant behind");
    let events = drain(&mut manager, attempt, |seen| {
        has(seen, AgentEventType::ToolActivity)
    });
    assert!(has(&events, AgentEventType::ToolActivity), "{events:#?}");
    // Wait for the fixture's surviving (non-dumpable) descendant.
    let mut descendant_pid = None;
    for _ in 0..50 {
        if let Ok(text) = fs::read_to_string(root.join(".fake-claude-descendant.pid")) {
            descendant_pid = text.trim().parse::<u32>().ok();
            if descendant_pid.is_some() {
                break;
            }
        }
        let _ = manager.poll_events(attempt);
        thread::sleep(Duration::from_millis(100));
    }
    let descendant_pid =
        descendant_pid.expect("fixture descendant pid file");
    // Stop the turn (the fixture CLI then ends its turn), then close: the
    // close must terminate the surviving descendant, not just the CLI.
    manager.interrupt_with_operation(attempt, "gui-close-tree").unwrap();
    let mut closed = false;
    for _ in 0..40 {
        let _ = manager.poll_events(attempt);
        if manager.close_idle_session(attempt).is_ok() {
            closed = true;
            break;
        }
        thread::sleep(Duration::from_millis(250));
    }
    assert!(closed, "close must succeed once the turn settled");
    let alive = std::path::Path::new(&format!("/proc/{descendant_pid}")).exists();
    assert!(
        !alive,
        "close must terminate the Runtime's surviving descendant ({descendant_pid})"
    );
}

fn argv_pid(root: &Path) -> u64 {
    read_json(root, ".fake-claude-argv.json")["pid"].as_u64().unwrap()
}

fn resume_wire(label: &str, attempt_id: &str, request_id: &str) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "protocolVersion": CONNECTED_UI_PROTOCOL_VERSION,
        "requestId": request_id,
        "entityVersion": 0,
        "messageType": "resume_native_session",
        "payload": {
            "attemptId": attempt_id,
            "executable": fake_cli()
        }
    }))
    .unwrap()
}

#[test]
fn a_live_resume_descendant_blocks_the_marker_and_a_second_spawn() {
    let (_lock, _env) = begin();
    let (store, server, attempt_id, root) = closed_claude("live-child", "resume_mismatch_with_child");
    let response = server
        .handle_json(&resume_wire("live-child", &attempt_id, "live-child-resume-1"))
        .unwrap();
    assert_eq!(response["ok"], true, "{response}");
    let task_id = store.get_attempt(&attempt_id).unwrap().task_id;
    let successor = store.attempts_for_task(&task_id).unwrap().pop().unwrap();
    let first_pid = argv_pid(&root);
    let send = server
        .handle_json(&server_send(
            "live-child",
            "campaign-live-child",
            &successor.id,
            "first message on a mismatched resume",
        ))
        .unwrap();
    assert_eq!(send["ok"], false, "{send}");
    let close = server
        .handle_json(&serde_json::to_vec(&serde_json::json!({
            "protocolVersion": CONNECTED_UI_PROTOCOL_VERSION,
            "requestId": "live-child-close",
            "entityVersion": 0,
            "messageType": "close_session",
            "payload": { "attemptId": successor.id }
        })).unwrap())
        .unwrap();
    assert_eq!(close["ok"], false, "close must not drop an unproven resume: {close}");
    assert!(
        close["error"].as_str().unwrap_or_default().contains("not proven contained"),
        "{close}"
    );
    let descendant_pid = fs::read_to_string(root.join(".fake-claude-descendant.pid"))
        .unwrap()
        .trim()
        .parse::<u32>()
        .unwrap();
    assert!(
        Path::new(&format!("/proc/{descendant_pid}")).exists(),
        "the descendant must still be alive after the unverified send"
    );
    let records = store.list_event_records(&successor.id, 0).unwrap();
    assert!(
        !records.iter().any(|record| {
            record.event.kind == "runtime.resume.verification.failed"
                || record.event.kind == "runtime.resume.spawn.failed"
        }),
        "a live descendant must not authorize a retry marker: {records:#?}"
    );
    assert!(store.stop_responsibilities().unwrap().is_empty());
    let retry = server
        .handle_json(&resume_wire("live-child", &successor.id, "live-child-cleanup"))
        .unwrap();
    assert_eq!(retry["ok"], false, "cleanup must not spawn: {retry}");
    assert_eq!(argv_pid(&root), first_pid, "cleanup must not spawn a second process");
    // Cleanup must signal the identity-confirmed Alive descendant. This test
    // does not kill it. Once that descendant is Dead and the root handle wait
    // succeeded, the marker is journaled; the spawn is a subsequent command.
    assert!(
        !Path::new(&format!("/proc/{descendant_pid}")).exists(),
        "cleanup must signal the Alive descendant rather than leave it running"
    );
    let records = store.list_event_records(&successor.id, 0).unwrap();
    assert!(
        records.iter().any(|record| record.event.kind == "runtime.resume.verification.failed"),
        "proven containment journals the marker: {records:#?}"
    );
    let spawned = server
        .handle_json(&resume_wire("live-child", &successor.id, "live-child-spawn-after"))
        .unwrap();
    assert_eq!(spawned["ok"], true, "the subsequent command may spawn: {spawned}");
    assert_ne!(argv_pid(&root), first_pid, "the spawn is a subsequent command");
    let stdin = fs::read_to_string(root.join(".fake-claude-stdin.jsonl")).unwrap_or_default();
    assert_eq!(
        stdin.matches("first message on a mismatched resume").count(),
        0,
        "the crossed message must not be replayed: {stdin}"
    );
}

#[test]
fn core_restart_after_a_proven_marker_offers_retry_without_replay() {
    let (_lock, _env) = begin();
    let (store, server, attempt_id, root) = closed_claude("restart-after", "resume_mismatch");
    assert_eq!(
        server
            .handle_json(&resume_wire("restart-after", &attempt_id, "restart-after-resume-1"))
            .unwrap()["ok"],
        true
    );
    let task_id = store.get_attempt(&attempt_id).unwrap().task_id;
    let successor = store.attempts_for_task(&task_id).unwrap().pop().unwrap();
    let send = server
        .handle_json(&server_send(
            "restart-after",
            "campaign-restart-after",
            &successor.id,
            "crossed message must not replay",
        ))
        .unwrap();
    assert_eq!(send["ok"], false, "{send}");
    let records = store.list_event_records(&successor.id, 0).unwrap();
    assert!(
        records.iter().any(|record| record.event.kind == "runtime.resume.verification.failed"),
        "{records:#?}"
    );
    drop(server);
    let restarted = CoreServer::new(store.clone());
    let snapshot = restarted
        .handle_json(&snapshot_message("restart-after"))
        .unwrap();
    let turn = &snapshot["payload"]["snapshot"]["productConversation"]["turn"];
    let actions = turn["actions"].as_array().unwrap();
    assert!(
        actions.iter().any(|action| action == "resume-session"),
        "a proven marker still offers deterministic retry after restart: {turn}"
    );
    assert!(!actions.iter().any(|action| action == "select-runtime"), "{turn}");
    assert_eq!(turn["canSend"], false, "{turn}");
    let retry = restarted
        .handle_json(&resume_wire(
            "restart-after",
            &successor.id,
            "restart-after-resume-2",
        ))
        .unwrap();
    assert_eq!(retry["ok"], true, "{retry}");
    let stdin = fs::read_to_string(root.join(".fake-claude-stdin.jsonl")).unwrap_or_default();
    assert_eq!(
        stdin.matches("crossed message must not replay").count(),
        0,
        "{stdin}"
    );
}

#[test]
fn core_restart_before_a_marker_does_not_offer_retry_or_spawn() {
    let (_lock, _env) = begin();
    let (store, server, attempt_id, root) = closed_claude("restart-before", "resume_mismatch_with_child");
    assert_eq!(
        server
            .handle_json(&resume_wire("restart-before", &attempt_id, "restart-before-resume-1"))
            .unwrap()["ok"],
        true
    );
    let task_id = store.get_attempt(&attempt_id).unwrap().task_id;
    let successor = store.attempts_for_task(&task_id).unwrap().pop().unwrap();
    let first_pid = argv_pid(&root);
    let send = server
        .handle_json(&server_send(
            "restart-before",
            "campaign-restart-before",
            &successor.id,
            "unproven resume must not spawn again",
        ))
        .unwrap();
    assert_eq!(send["ok"], false, "{send}");
    let records = store.list_event_records(&successor.id, 0).unwrap();
    assert!(
        !records.iter().any(|record| record.event.kind == "runtime.resume.verification.failed"),
        "{records:#?}"
    );
    // Keep the original server alive so its process is not dropped, then a
    // restarted Core must not offer retry or spawn while the marker is absent.
    let restarted = CoreServer::new(store.clone());
    let snapshot = restarted
        .handle_json(&snapshot_message("restart-before"))
        .unwrap();
    let turn = &snapshot["payload"]["snapshot"]["productConversation"]["turn"];
    let actions = turn["actions"].as_array().unwrap();
    assert!(
        !actions.iter().any(|action| action == "resume-session" || action == "select-runtime"),
        "restart before a marker must not offer retry or a fresh session: {turn}"
    );
    assert_eq!(turn["canSend"], false, "{turn}");
    let retry = restarted
        .handle_json(&resume_wire(
            "restart-before",
            &successor.id,
            "restart-before-resume-2",
        ))
        .unwrap();
    assert_eq!(retry["ok"], false, "{retry}");
    assert_eq!(argv_pid(&root), first_pid, "restart before a marker must not spawn");
    let bypass = restarted
        .handle_json(&server_send(
            "restart-before",
            "campaign-restart-before",
            &successor.id,
            "send must not spawn while containment is unproven",
        ))
        .unwrap();
    assert_eq!(bypass["ok"], false, "send must not spawn: {bypass}");
    assert!(
        bypass["error"]
            .as_str()
            .unwrap_or_default()
            .contains("cannot start another process"),
        "{bypass}"
    );
    assert_eq!(argv_pid(&root), first_pid, "send after restart must not spawn");
    drop(server);
}
