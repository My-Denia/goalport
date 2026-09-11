//! Contract tests for the transient Claude-only stop broker.
//!
//! These drive the production broker binary and the production Claude launch
//! routine. Every case is about one distinction: the OS accepting a console
//! control event is *delivery*, and delivery is not a stop. A stop needs the
//! exact bound child to leave, its stream to drain, and its private job to be
//! empty; anything short of that is unknown here as it is in the product.
#![cfg(windows)]

use goalport_core::{
    AgentEventEnvelope, AgentEventType, PromptRequest, RuntimeManager, SessionRequest,
    claude_stop_broker::{BrokerLaunch, BrokerSession, StopTarget},
    process_identity::{self, ProcessObservation},
};
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

const BROKER_EXE: &str = env!("CARGO_BIN_EXE_goalport-claude-stop-broker");

/// The synthetic fixture is a script. It is launched through the isolated-test
/// interpreter indirection so the exact managed child is the fixture process
/// itself, with no `cmd.exe` batch shim standing in for its identity.
fn fake_cli() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/fake-claude-cli/fake-claude-cli.mjs")
}

fn node_exe() -> PathBuf {
    let output = std::process::Command::new("cmd")
        .args(["/c", "where node.exe"])
        .output()
        .expect("node must be on PATH for the fixture");
    let text = String::from_utf8_lossy(&output.stdout);
    let first = text.lines().next().unwrap_or_default().trim().to_owned();
    let path = PathBuf::from(first);
    assert!(path.is_file(), "node.exe not found: {path:?}");
    path
}

fn select_fixture_interpreter() {
    // SAFETY: the test binary is single threaded by contract for this target.
    unsafe { std::env::set_var("GOALPORT_CLAUDE_FIXTURE_INTERPRETER", node_exe()) };
}

/// The brokered launch is opt-in per process. These tests are required to run
/// single threaded (`--test-threads=1`), so one process-wide selection is safe.
fn select_brokered_launch() {
    select_fixture_interpreter();
    // SAFETY: the test binary is single threaded by contract for this target.
    unsafe {
        std::env::set_var("GOALPORT_CLAUDE_STOP_BROKER", "1");
        std::env::set_var("GOALPORT_CLAUDE_STOP_BROKER_EXE", BROKER_EXE);
    }
}

fn workspace(name: &str, scenario: &str) -> PathBuf {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../target/claude-stop-broker-tests")
        .join(name);
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join("notes")).expect("fixture workspace");
    fs::write(dir.join(".fake-claude-scenario"), scenario).expect("scenario file");
    dir
}

fn attach(attempt: &str, workspace: &Path) -> RuntimeManager {
    let mut manager = RuntimeManager::new();
    manager
        .select_runtime(attempt, "claude", Some(fake_cli()), "2.1.259", workspace)
        .expect("claude runtime should be selectable");
    manager
        .create_session(
            attempt,
            &SessionRequest {
                campaign_id: Some("campaign-broker".into()),
                task_id: "task-broker".into(),
                attempt_id: attempt.into(),
                workspace_root: workspace.to_path_buf(),
                resume_session: None,
            },
        )
        .expect("brokered claude session should be created");
    manager
}

fn send(manager: &mut RuntimeManager, attempt: &str) {
    manager
        .send_prompt(
            attempt,
            &PromptRequest {
                attempt_id: attempt.into(),
                text: "fixture prompt".into(),
                idempotency_key: format!("{attempt}-1"),
            },
        )
        .expect("prompt should be accepted");
}

fn drain_until(
    manager: &mut RuntimeManager,
    attempt: &str,
    limit: Duration,
    done: impl Fn(&[AgentEventEnvelope]) -> bool,
) -> Vec<AgentEventEnvelope> {
    let deadline = Instant::now() + limit;
    let mut events = Vec::new();
    while Instant::now() < deadline {
        events.extend(manager.poll_events(attempt).expect("poll should not fail"));
        if done(&events) {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    events
}

fn terminal(events: &[AgentEventEnvelope]) -> Option<&AgentEventEnvelope> {
    events.iter().find(|event| {
        event.event_type == AgentEventType::Cancelled
            || event.event_type == AgentEventType::TurnFailed
    })
}

fn broker_trace(payload: &Value) -> &Value {
    payload
        .pointer("/stop_attempt/broker")
        .unwrap_or_else(|| panic!("a brokered stop must carry a broker trace: {payload}"))
}

/// Run one brokered turn to its single stop terminal.
fn brokered_stop(name: &str, scenario: &str) -> (Value, PathBuf) {
    select_brokered_launch();
    let attempt = format!("attempt-{name}");
    let root = workspace(name, scenario);
    let mut manager = attach(&attempt, &root);
    send(&mut manager, &attempt);
    // The fixture reaches "working" and then produces nothing further: only a
    // delivered console control event can end this turn.
    let running = drain_until(&mut manager, &attempt, Duration::from_secs(20), |seen| {
        seen.iter().any(|event| {
            event
                .payload
                .get("text")
                .and_then(Value::as_str)
                .is_some_and(|text| text.contains("working"))
        })
    });
    assert!(
        !running.is_empty(),
        "{name}: the fixture turn should have started"
    );
    manager.interrupt(&attempt).expect("interrupt is accepted");
    // 5 s structured fallback + 4 s effect bound, plus slack for the broker.
    let events = drain_until(&mut manager, &attempt, Duration::from_secs(25), |seen| {
        terminal(seen).is_some()
    });
    let stops = events
        .iter()
        .filter(|event| {
            event.event_type == AgentEventType::Cancelled
                || event.event_type == AgentEventType::TurnFailed
        })
        .count();
    assert_eq!(stops, 1, "{name}: exactly one terminal, saw {stops}");
    let payload = terminal(&events)
        .unwrap_or_else(|| panic!("{name}: a stop terminal is required"))
        .payload
        .clone();
    let _ = manager.close_attempt(&attempt);
    (payload, root)
}

// ---------------------------------------------------------------- positive

/// The whole mechanism, end to end, through the production launch and stop
/// routine: the broker owns a hidden console, the exact child is a member of
/// it, one `CTRL_BREAK_EVENT` is delivered to the child's own group, the
/// target's handler acknowledges inside the ordered provider stream, the exact
/// child exits inside the bound and the private job is left empty.
#[test]
fn a_delivered_console_control_event_stops_the_exact_target_and_drains() {
    let (payload, root) = brokered_stop("positive", "broker_stop");
    let trace = broker_trace(&payload);

    let launch = trace.pointer("/launch/childStarted").expect("child_started");
    let child_pid = launch.pointer("/child/pid").and_then(Value::as_u64).unwrap();
    let broker_pid = trace.pointer("/broker_pid").and_then(Value::as_u64).unwrap();
    assert_ne!(child_pid, broker_pid, "the child is not the broker");
    assert_eq!(
        launch.pointer("/processGroupId").and_then(Value::as_u64),
        Some(child_pid),
        "the signal group id must be the exact child's own group"
    );
    assert_eq!(
        launch.pointer("/consoleInherited").and_then(Value::as_bool),
        Some(true)
    );
    assert_eq!(
        launch.pointer("/job/assignedBeforeResume").and_then(Value::as_bool),
        Some(true),
        "the job must hold the child before it can run"
    );
    assert_eq!(
        launch.pointer("/job/breakawayAllowed").and_then(Value::as_bool),
        Some(false)
    );
    let console = launch
        .pointer("/brokerConsole/consoleProcessIds")
        .and_then(Value::as_array)
        .expect("broker console membership");
    assert!(
        console.iter().any(|id| id.as_u64() == Some(child_pid)),
        "the exact child must share the broker console: {console:?}"
    );

    let delivery = trace.pointer("/delivery").expect("delivery");
    assert_eq!(
        delivery.pointer("/signal/ctrlEvent").and_then(Value::as_str),
        Some("CTRL_BREAK_EVENT")
    );
    assert_eq!(
        delivery.pointer("/signal/groupId").and_then(Value::as_u64),
        Some(child_pid),
        "group zero and any other group are never targets"
    );
    assert_eq!(
        delivery.pointer("/signal/returned").and_then(Value::as_bool),
        Some(true)
    );
    assert_eq!(
        delivery.pointer("/signal/lastError").and_then(Value::as_u64),
        Some(0)
    );
    assert_eq!(
        delivery.pointer("/signal/signalCount").and_then(Value::as_u64),
        Some(1),
        "exactly one signal"
    );
    assert_eq!(
        payload.pointer("/stop_attempt/signal_count").and_then(Value::as_u64),
        Some(1)
    );

    let effect = trace.pointer("/effect").expect("effect");
    assert_eq!(
        effect.get("exited").and_then(Value::as_bool),
        Some(true),
        "the exact child must actually exit: {effect}"
    );
    assert_eq!(
        effect.pointer("/job/memberCount").and_then(Value::as_u64),
        Some(0),
        "the private job must be empty before a stop is claimed: {effect}"
    );

    // The target's own handler acknowledgement, and nothing after it.
    let marker = root.join(".fake-claude-stop-signal.json");
    let ack = fs::read_to_string(&marker).expect("the target handler must have run");
    assert!(ack.contains("SIGBREAK"), "handler acknowledgement: {ack}");

    assert_eq!(
        payload.get("safe_process_stop").and_then(Value::as_bool),
        Some(true),
        "with delivery, exit, drain and empty containment this is a process stop: {payload}"
    );
    assert_eq!(payload.get("native_turn_cancel").and_then(Value::as_bool), Some(false));
}

// ---------------------------------------------------------------- negatives

/// The original consoleless topology, unchanged, on the same fixture. Core is
/// the caller and has no console, so the OS refuses before any target is
/// reached. This is the control that shows the broker is what changed.
#[test]
fn the_unbrokered_consoleless_launch_still_cannot_deliver_the_event() {
    select_fixture_interpreter();
    // SAFETY: single-threaded test target.
    unsafe { std::env::remove_var("GOALPORT_CLAUDE_STOP_BROKER") };
    let attempt = "attempt-negative-original";
    let root = workspace("negative-original", "broker_stop");
    let mut manager = attach(attempt, &root);
    send(&mut manager, attempt);
    drain_until(&mut manager, attempt, Duration::from_secs(20), |seen| {
        seen.iter().any(|event| {
            event
                .payload
                .get("text")
                .and_then(Value::as_str)
                .is_some_and(|text| text.contains("working"))
        })
    });
    manager.interrupt(attempt).expect("interrupt is accepted");
    let events = drain_until(&mut manager, attempt, Duration::from_secs(25), |seen| {
        terminal(seen).is_some()
    });
    let payload = terminal(&events).expect("a terminal is required").payload.clone();
    assert_eq!(
        payload.pointer("/stop_attempt/broker"),
        Some(&Value::Null),
        "the direct launch has no broker at all"
    );
    assert_ne!(
        payload.get("safe_process_stop").and_then(Value::as_bool),
        Some(true),
        "the consoleless topology must not produce a process stop: {payload}"
    );
    assert!(
        !root.join(".fake-claude-stop-signal.json").exists(),
        "no console control event should have reached the target"
    );
    let _ = manager.close_attempt(attempt);
}

/// A signal the OS accepted, whose target handler ran, but which did not stop
/// the process. Delivery is not effect: this must fail closed. It is the same
/// observable an early signal produces, before a target can act on it.
#[test]
fn a_signal_without_an_observed_exit_is_never_a_stop() {
    let (payload, root) = brokered_stop("no-effect", "broker_stop_ignores_signal");
    let trace = broker_trace(&payload);
    assert_eq!(
        trace.pointer("/delivery/signal/returned").and_then(Value::as_bool),
        Some(true),
        "the OS accepted the event"
    );
    let marker = root.join(".fake-claude-stop-signal.json");
    assert!(marker.exists(), "the target handler did run");
    assert_ne!(
        payload.get("safe_process_stop").and_then(Value::as_bool),
        Some(true),
        "a target that keeps running was not stopped: {payload}"
    );
    assert_eq!(
        payload.get("unverified").and_then(Value::as_bool),
        Some(true),
        "the disposition must be unverified: {payload}"
    );
}

/// An owned descendant that survives the signal and writes afterwards. The
/// private job is what makes it visible; a non-empty job is a containment
/// failure and can never be a stop.
#[test]
fn a_surviving_descendant_fails_containment_and_is_never_a_stop() {
    let (payload, root) = brokered_stop("containment", "broker_stop_descendant");
    let trace = broker_trace(&payload);
    let effect = trace.pointer("/effect").expect("effect");
    let before = trace
        .pointer("/delivery/jobBeforeSignal")
        .expect("membership before the signal");
    println!("JOB_BEFORE_SIGNAL={before}");
    println!("JOB_AFTER_SIGNAL={}", effect.pointer("/job").unwrap());
    println!("CHILD_PID={:?}", trace.pointer("/launch/childStarted/child/pid"));
    let members = effect
        .pointer("/job/memberCount")
        .and_then(Value::as_u64)
        .expect("job membership must be observable");
    println!("DISPOSITION={}", payload.get("stopKind").unwrap_or(&Value::Null));
    println!("JOB_MEMBERS_AFTER={members}");

    // Both descendants outlive the signal and then write into the workspace.
    std::thread::sleep(Duration::from_secs(9));
    let owned_wrote = root.join("notes/descendant-write.txt").exists();
    let detached_wrote = root.join("notes/detached-write.txt").exists();
    println!("OWNED_DESCENDANT_WROTE={owned_wrote} DETACHED_DESCENDANT_WROTE={detached_wrote}");
    assert!(
        owned_wrote || detached_wrote,
        "the hazard under test requires a descendant that kept working"
    );

    // The product-level requirement: a turn whose owned descendants went on to
    // mutate the workspace after the signal was not stopped. Reporting a
    // process stop here would be a false B.
    assert_ne!(
        payload.get("safe_process_stop").and_then(Value::as_bool),
        Some(true),
        "a stop with a surviving descendant that wrote afterwards is not a stop: {payload}"
    );
}

/// Untrusted provider output claiming to be a broker acknowledgement. The
/// broker's channel is a private pipe pair that was never in the child's
/// inherited handle list, so the forgery lands in the provider stream and
/// cannot reach, or alter, the control channel.
#[test]
fn the_provider_stream_cannot_forge_a_broker_acknowledgement() {
    let (payload, _root) = brokered_stop("forged-ack", "broker_stop_forged_ack");
    let trace = broker_trace(&payload);
    assert_eq!(
        trace.pointer("/launch/childStarted/controlChannelInherited").and_then(Value::as_bool),
        Some(false),
        "the control channel is not inheritable by the child"
    );
    let handles = trace
        .pointer("/launch/childStarted/handleList")
        .and_then(Value::as_array)
        .expect("the child's inherited handle list");
    assert_eq!(
        handles.len(),
        3,
        "the child inherits exactly its own stdio: {handles:?}"
    );
    let frames = trace
        .pointer("/frames")
        .and_then(Value::as_array)
        .expect("broker frames");
    assert!(
        frames.iter().all(|frame| frame.get("forgedBy").is_none()),
        "no provider-authored frame may appear on the broker channel: {frames:?}"
    );
    // Every accepted frame carries the per-spawn nonce the provider never saw.
    assert!(
        frames.iter().all(|frame| frame.get("nonce").and_then(Value::as_str).is_some()),
        "broker frames are nonce-bound: {frames:?}"
    );
}

// ------------------------------------------- broker protocol level negatives

/// Launch a broker over a bare fixture, with no Core stream driving it, to test
/// the control protocol itself.
fn bare_broker(name: &str) -> (BrokerSession, PathBuf) {
    let root = workspace(name, "broker_stop");
    let session = BrokerSession::launch(&BrokerLaunch {
        broker_exe: PathBuf::from(BROKER_EXE),
        claude_exe: node_exe(),
        args: vec![fake_cli().to_string_lossy().into_owned()],
        cwd: root.clone(),
        env_remove: vec!["ANTHROPIC_API_KEY".into()],
    })
    .expect("the broker should launch");
    (session, root)
}

/// Containment control with a plain console child that is not a Node/libuv
/// program. It shows what the private job *can* account for, which is what
/// makes the Node result below a finding about the runtime rather than about
/// the job arrangement.
#[test]
fn the_private_job_accounts_for_descendants_of_a_plain_console_child() {
    let root = workspace("containment-control", "broker_stop");
    let comspec = std::env::var("COMSPEC").unwrap_or_else(|_| r"C:\Windows\System32\cmd.exe".into());
    let mut session = BrokerSession::launch(&BrokerLaunch {
        broker_exe: PathBuf::from(BROKER_EXE),
        claude_exe: PathBuf::from(&comspec),
        // The command processor plus a long-running child: two processes if the
        // job accounts for the tree, one if it does not. `ping` is used because
        // it needs no console input, unlike `timeout`.
        args: vec!["/c".into(), "ping".into(), "-n".into(), "30".into(), "127.0.0.1".into()],
        cwd: root.clone(),
        env_remove: Vec::new(),
    })
    .expect("the broker should launch");
    std::thread::sleep(Duration::from_secs(2));
    let pid = session.claude_pid;
    let observed = match process_identity::observe_process(pid) {
        ProcessObservation::Live(identity) => identity,
        other => panic!("the control child should be live: {other:?}"),
    };
    let delivery = session
        .request_stop(
            &StopTarget {
                request_id: "req-containment-control".into(),
                pid,
                creation_date: observed.creation_date(),
                executable_path: observed.executable_path.clone(),
                executable_sha256: observed.executable_sha256.clone(),
                process_epoch: "runtime-epoch:control".into(),
                attempt_id: "attempt-control".into(),
                session_hash: String::new(),
                turn_epoch: 1,
            },
            4_000,
        )
        .expect("the broker answers");
    let members = delivery
        .raw
        .pointer("/jobBeforeSignal/memberCount")
        .and_then(Value::as_u64)
        .expect("membership before the signal");
    println!("CONTROL_JOB_BEFORE_SIGNAL={}", delivery.raw.pointer("/jobBeforeSignal").unwrap());
    assert!(
        members > 1,
        "the private job must account for an ordinary descendant tree, saw {members}"
    );
}

/// A stop request whose identity does not match the live child is refused
/// before `GenerateConsoleCtrlEvent` is called at all.
#[test]
fn a_wrong_identity_stop_request_is_refused_without_a_signal() {
    let (mut session, _root) = bare_broker("wrong-identity");
    let pid = session.claude_pid;
    let observed = match process_identity::observe_process(pid) {
        ProcessObservation::Live(identity) => identity,
        other => panic!("the child should be live: {other:?}"),
    };
    let delivery = session
        .request_stop(
            &StopTarget {
                request_id: "req-wrong-identity".into(),
                pid,
                // A creation date that is not this process's.
                creation_date: "/Date(1)/".into(),
                executable_path: observed.executable_path.clone(),
                executable_sha256: observed.executable_sha256.clone(),
                process_epoch: "runtime-epoch:wrong".into(),
                attempt_id: "attempt-wrong".into(),
                session_hash: String::new(),
                turn_epoch: 1,
            },
            4_000,
        )
        .expect("the broker answers the request");
    assert!(!delivery.accepted, "a mismatched identity is refused");
    assert!(!delivery.identity_match);
    assert!(
        !delivery.signal_attempted,
        "no signal may be attempted for a mismatched identity: {:?}",
        delivery.raw
    );
    assert_eq!(
        process_identity::observe_process(pid),
        ProcessObservation::Live(observed),
        "the child must be untouched"
    );
}

/// One signal per child, ever. A repeated request id, and any further request
/// after one was served, are both refused without a second signal.
#[test]
fn a_duplicate_stop_request_never_produces_a_second_signal() {
    let (mut session, _root) = bare_broker("duplicate");
    let pid = session.claude_pid;
    let observed = match process_identity::observe_process(pid) {
        ProcessObservation::Live(identity) => identity,
        other => panic!("the child should be live: {other:?}"),
    };
    let target = StopTarget {
        request_id: "req-duplicate".into(),
        pid,
        creation_date: observed.creation_date(),
        executable_path: observed.executable_path.clone(),
        executable_sha256: observed.executable_sha256.clone(),
        process_epoch: "runtime-epoch:duplicate".into(),
        attempt_id: "attempt-duplicate".into(),
        session_hash: String::new(),
        turn_epoch: 1,
    };
    let first = session.request_stop(&target, 4_000).expect("first answer");
    assert!(first.accepted && first.signal_attempted, "{:?}", first.raw);

    let repeat = session
        .request_stop(&target, 4_000)
        .expect("the broker answers the duplicate");
    assert!(!repeat.accepted, "a duplicate request id is refused");
    assert!(!repeat.signal_attempted, "{:?}", repeat.raw);

    let different = session
        .request_stop(
            &StopTarget {
                request_id: "req-duplicate-2".into(),
                ..target
            },
            4_000,
        )
        .expect("the broker answers the second request");
    assert!(
        !different.accepted && !different.signal_attempted,
        "a child is signalled once even under a fresh request id: {:?}",
        different.raw
    );
}
