//! Contract tests for the transient Claude-only stop broker.
//!
//! The production Core launch route deliberately refuses the brokered Claude
//! path (native Stop product candidate decision), even with the per-process
//! environment opt-in set. One test here pins that refusal exactly, including
//! the evidence that no process is ever spawned on the refused route. The
//! remaining stop-contract cases drive the production broker binary directly
//! over its control protocol, so the mechanism stays observable even though no
//! product integration may exercise it. Every case is still about one
//! distinction: the OS accepting a console control event is *delivery*, and
//! delivery is not a stop. A stop needs the exact bound child to leave, its
//! stream to drain, and its private job to be empty; anything short of that is
//! unknown here as it is in the product. No test in this file may assert a
//! product-level `safe_process_stop` claim: that assertion belonged to the
//! retired brokered runtime integration and must not be resurrected.
//!
//! Threading contract: this file is valid under the default parallel test
//! harness — whole-suite `cargo test` needs neither `--test-threads=1` nor a
//! `RUST_TEST_THREADS` setting. The two env-sensitive tests mutate
//! process-global environment keys, so they serialize on an explicit
//! in-binary guard that also restores the prior environment on exit, and
//! every process spawn from this binary happens under the same lock.
//! Environment mutation, launch-route reads, and child-environment
//! inheritance therefore can never race across tests.
#![cfg(windows)]

use goalport_core::{
    AdapterError, AgentEventEnvelope, AgentEventType, PromptRequest, RuntimeManager,
    SessionRequest,
    claude_stop_broker::{BrokerLaunch, BrokerSession, StopTarget},
    process_identity::{self, ProcessObservation},
};
use serde_json::{Value, json};
use std::{
    ffi::OsString,
    fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard, OnceLock},
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

/// Every process-global environment key the Claude launch route reads: the
/// isolated-test fixture interpreter indirection and the brokered-launch
/// opt-in pair. `cargo test` runs the tests of one binary as parallel threads
/// by default, and this file must stay valid under that default, so mutation,
/// removal, and reading of these keys happen only while one in-binary lock is
/// held.
const ENV_LOCK_KEYS: [&str; 3] = [
    "GOALPORT_CLAUDE_FIXTURE_INTERPRETER",
    goalport_core::claude_stop_broker::BROKER_ENABLE_ENV,
    goalport_core::claude_stop_broker::BROKER_PATH_ENV,
];

/// The in-binary environment lock. The two env-sensitive tests hold it for
/// their whole body through [`env_selection`]; every other test takes it for
/// the moments it spawns a child from this process (see [`spawn_exclusive`]).
/// Together this means no test can observe or inherit another test's
/// transient process-global value mid-write, and no leftover survives a
/// finished (or panicking) test.
fn env_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// RAII hold of [`env_lock`] that restores the exact prior values of
/// [`ENV_LOCK_KEYS`] on drop — including on panic, so a failed test cannot
/// poison a later one with its selection.
struct EnvSelection {
    prior: Vec<(&'static str, Option<OsString>)>,
    _held: MutexGuard<'static, ()>,
}

fn env_selection() -> EnvSelection {
    let _held = env_lock()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let prior = ENV_LOCK_KEYS
        .iter()
        .map(|&key| (key, std::env::var_os(key)))
        .collect();
    EnvSelection { prior, _held }
}

impl Drop for EnvSelection {
    fn drop(&mut self) {
        for (key, value) in self.prior.drain(..) {
            // SAFETY: this thread still holds the in-binary environment lock,
            // the same lock every mutation, every launch-route read, and every
            // spawn from this binary is serialized on, so no other test thread
            // can be reading or inheriting the environment during the restore.
            match value {
                Some(value) => unsafe { std::env::set_var(key, value) },
                None => unsafe { std::env::remove_var(key) },
            }
        }
    }
}

/// Mutual exclusion for process spawns from this test binary: a child launched
/// with an inherited environment reads that environment at spawn time, so a
/// spawn must never overlap a concurrent `set_var`/`remove_var` in another
/// test thread. The bare-broker tests hold this around their launch calls and
/// release it as soon as the children exist. Inheriting a transient value is
/// itself inert for those children — the broker binary parses argv only and
/// never reads the broker env keys, and the fixture consults only its scenario
/// file, whose env fallback this binary never sets — so this guard exists to
/// exclude the inheritance-during-write race itself.
fn spawn_exclusive() -> MutexGuard<'static, ()> {
    env_lock()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn select_fixture_interpreter() {
    // SAFETY: callers hold `env_selection()` for their whole test body, so no
    // other thread of this binary can be reading, inheriting, or racing this
    // key, and the guard restores the prior value afterwards.
    unsafe { std::env::set_var("GOALPORT_CLAUDE_FIXTURE_INTERPRETER", node_exe()) };
}

/// The brokered launch is opt-in per process. Safe under the default parallel
/// harness because the caller holds [`env_selection`] for its whole test body:
/// the unbrokered control test's contradictory `remove_var` cannot interleave,
/// concurrent tests never observe the opt-in, and the guard restores the prior
/// environment when the test ends.
fn select_brokered_launch() {
    select_fixture_interpreter();
    // SAFETY: caller holds `env_selection()`; see `select_fixture_interpreter`.
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

// --------------------------------------------------- brokered route refusal

/// The product launch route, with the per-process environment opt-in set, must
/// refuse the brokered Claude launch before any process exists. This replaces
/// the retired positive runtime integration: that integration could only pass
/// by enabling the route the product deliberately rejected, so the honest
/// coverage is the refusal itself. The refusal happens in `ensure_started`
/// before argv construction and before the broker executable is resolved, so a
/// deliberately missing broker exe can never surface here as a `Connection`
/// error — if it ever did, the spawn path had been reached.
#[test]
fn the_opted_in_broker_route_is_rejected_before_any_process_spawns() {
    let attempt = "attempt-route-rejected";
    let root = workspace("route-rejected", "broker_stop");
    // Hold the in-binary environment lock for the whole body: the opt-in below
    // is process-global, and the unbrokered control test's contradictory
    // `remove_var` runs under the same lock, so the two can never interleave.
    let _selection = env_selection();
    select_brokered_launch();
    // Point the opt-in at an exe that does not exist: reaching the spawn path
    // would fail with a different (Connection) error naming the missing file.
    // SAFETY: this test holds `env_selection()`; the guard restores the prior
    // values when this test ends, on success or on panic.
    unsafe {
        std::env::set_var(
            "GOALPORT_CLAUDE_STOP_BROKER_EXE",
            root.join("no-such-broker.exe"),
        );
    }
    let mut manager = RuntimeManager::new();
    manager
        .select_runtime(attempt, "claude", Some(fake_cli()), "2.1.259", &root)
        .expect("claude runtime should be selectable");
    let rejection = manager
        .create_session(
            attempt,
            &SessionRequest {
                campaign_id: Some("campaign-broker".into()),
                task_id: "task-broker".into(),
                attempt_id: attempt.into(),
                workspace_root: root.clone(),
                resume_session: None,
            },
        )
        .expect_err("the opted-in brokered route must be refused");
    match &rejection {
        AdapterError::Unsupported(message) => assert_eq!(
            message,
            "Rejected Claude broker route is unavailable in the native Stop product candidate",
            "the refusal must be the deliberate pre-spawn route rejection"
        ),
        other => panic!("the refusal must be the pre-spawn route rejection, saw {other:?}"),
    }
    // The next entry stays refused as well: no turn can start on this route.
    let second = manager
        .send_prompt(
            attempt,
            &PromptRequest {
                attempt_id: attempt.into(),
                text: "fixture prompt".into(),
                idempotency_key: format!("{attempt}-1"),
            },
        )
        .expect_err("no turn may start on the refused route");
    assert!(
        matches!(
            second,
            AdapterError::Unsupported(_) | AdapterError::Connection(_)
        ),
        "the follow-up refusal stays fail-closed, saw {second:?}"
    );
    // Corroborating no-spawn evidence, checked against what the fixture
    // actually writes. `.fake-claude-argv.json` is written synchronously and
    // unconditionally as the fixture's first side effect, so any fixture that
    // started in this workspace would have left it. `.fake-claude-stdin.jsonl`
    // appears when the fixture consumes input or after its ~50 ms startup
    // timer, so its absence additionally rules out a started-and-idle fixture;
    // the stop-signal marker exists only once a console control event reached
    // the handler. The decisive proof is the exact pre-spawn `Unsupported`
    // rejection asserted above — it fires before argv construction and before
    // the broker exe is resolved, so no spawn path is reachable at all; the
    // absences below only have to stay consistent with that.
    assert!(
        !root.join(".fake-claude-argv.json").exists(),
        "the fixture writes this ledger unconditionally on startup; absence means no child ran here"
    );
    assert!(
        !root.join(".fake-claude-stop-signal.json").exists(),
        "no console control event can have reached a target that never existed"
    );
    assert!(
        !root.join(".fake-claude-stdin.jsonl").exists(),
        "no fixture process ever consumed input or reached its startup ledger timer"
    );
}

// ---------------------------------------------------------------- negatives

/// The original consoleless topology, unchanged, on the same fixture. Core is
/// the caller and has no console, so the OS refuses before any target is
/// reached. This is the control that shows the broker is what changed.
#[test]
fn the_unbrokered_consoleless_launch_still_cannot_deliver_the_event() {
    // Hold the in-binary environment lock for the whole body: the removal below
    // and the fixture spawn under the interpreter selection must not be
    // interleaved with the opt-in test's contradictory process-global state.
    let _selection = env_selection();
    select_fixture_interpreter();
    // SAFETY: this test holds `env_selection()`; the guard restores the prior
    // value on exit, so the removal cannot leak into any other test.
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

// --------------------------- broker protocol level (bare broker) negatives

/// Launch a broker over a bare fixture, with no Core stream driving it, to test
/// the control protocol itself.
fn bare_broker_in(name: &str, scenario: &str) -> (BrokerSession, PathBuf) {
    let root = workspace(name, scenario);
    // `node_exe()` probes through a spawned `cmd` and the broker launch spawns
    // the broker with an inherited environment; both stay inside the in-binary
    // environment lock so they cannot race an env-sensitive test's process-
    // global writes. The guard is released as soon as the children exist.
    let _spawns = spawn_exclusive();
    let session = BrokerSession::launch(&BrokerLaunch {
        broker_exe: PathBuf::from(BROKER_EXE),
        claude_exe: node_exe(),
        args: vec![fake_cli().to_string_lossy().into_owned()],
        cwd: root.clone(),
        env_remove: vec!["ANTHROPIC_API_KEY".into()],
    })
    .expect("the broker should launch");
    drop(_spawns);
    (session, root)
}

fn bare_broker(name: &str) -> (BrokerSession, PathBuf) {
    bare_broker_in(name, "broker_stop")
}

/// A background reader for the fixture's provider stream (the child stdout the
/// broker hands straight through). Lines surface as they are written, so a test
/// can prove ordering and content ("working" text, forged frames) without
/// blocking the control protocol.
struct ProviderStream {
    lines: Arc<Mutex<Vec<String>>>,
}

impl ProviderStream {
    fn spawn(read: fs::File) -> Self {
        let lines = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&lines);
        std::thread::Builder::new()
            .name("bare-broker-provider-stream".into())
            .spawn(move || {
                let mut reader = BufReader::new(read);
                loop {
                    let mut line = String::new();
                    match reader.read_line(&mut line) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {
                            if let Ok(mut guard) = sink.lock() {
                                guard.push(line);
                            }
                        }
                    }
                }
            })
            .expect("provider stream reader thread");
        Self { lines }
    }

    fn lines(&self) -> Vec<String> {
        self.lines
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default()
    }

    fn wait_for(&self, needle: &str, limit: Duration) -> Vec<String> {
        let deadline = Instant::now() + limit;
        while Instant::now() < deadline {
            let lines = self.lines();
            if lines.iter().any(|line| line.contains(needle)) {
                return lines;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        self.lines()
    }
}

/// Drive the bare fixture into its scenario turn the way the Core stream would:
/// one `initialize` control request, then one user message. The returned stdin
/// handle must stay open for the life of the test — stdin EOF would end the
/// fixture before the console control event under test is delivered.
fn drive_fixture_turn(session: &mut BrokerSession) -> fs::File {
    let mut stdin = session
        .claude_stdin
        .take()
        .expect("the broker hands over the fixture stdin");
    for frame in [
        json!({
            "type": "control_request",
            "request_id": "req-bare-init",
            "request": { "subtype": "initialize", "hooks": null }
        }),
        json!({
            "type": "user",
            "uuid": "00000000-0000-4000-8000-000000000001",
            "message": { "role": "user", "content": "fixture prompt" },
            "parent_tool_use_id": null
        }),
    ] {
        let mut line = serde_json::to_string(&frame).expect("frame serializes");
        line.push('\n');
        stdin
            .write_all(line.as_bytes())
            .and_then(|()| stdin.flush())
            .expect("fixture stdin write");
    }
    stdin
}

/// A signal the OS accepted, whose target handler ran, but which did not stop
/// the process. Delivery is not effect: this must fail closed. Ported from the
/// retired brokered runtime integration to the bare broker harness; the
/// observables are unchanged — one delivered `CTRL_BREAK_EVENT`, the target's
/// own handler acknowledgement, and no observed exit. No product-level stop
/// claim exists to make, and none may be inferred from a mere delivery.
#[test]
fn a_signal_without_an_observed_exit_is_never_a_stop() {
    let (mut session, root) = bare_broker_in("no-effect", "broker_stop_ignores_signal");
    let stream = ProviderStream::spawn(
        session
            .claude_stdout
            .take()
            .expect("the broker hands over the fixture stdout"),
    );
    let _fixture_stdin = drive_fixture_turn(&mut session);
    let working = stream.wait_for("working", Duration::from_secs(20));
    assert!(
        working.iter().any(|line| line.contains("working")),
        "the fixture turn should have started: {working:?}"
    );

    let pid = session.claude_pid;
    let observed = match process_identity::observe_process(pid) {
        ProcessObservation::Live(identity) => identity,
        other => panic!("the fixture child should be live: {other:?}"),
    };
    let delivery = session
        .request_stop(
            &StopTarget {
                request_id: "req-no-effect".into(),
                pid,
                creation_date: observed.creation_date(),
                executable_path: observed.executable_path.clone(),
                executable_sha256: observed.executable_sha256.clone(),
                process_epoch: "runtime-epoch:no-effect".into(),
                attempt_id: "attempt-no-effect".into(),
                session_hash: String::new(),
                turn_epoch: 1,
            },
            4_000,
        )
        .expect("the broker answers the request");
    assert!(
        delivery.accepted && delivery.identity_match,
        "{:?}",
        delivery.raw
    );
    assert!(
        delivery.signal_attempted && delivery.signal_returned,
        "the OS accepted the event: {:?}",
        delivery.raw
    );
    assert_eq!(
        delivery
            .raw
            .pointer("/signal/ctrlEvent")
            .and_then(Value::as_str),
        Some("CTRL_BREAK_EVENT")
    );
    assert_eq!(
        delivery.group_id, pid,
        "the signal group id must be the exact child's own group"
    );
    assert_eq!(
        delivery
            .raw
            .pointer("/signal/signalCount")
            .and_then(Value::as_u64),
        Some(1),
        "exactly one signal"
    );

    let effect = session
        .await_effect("req-no-effect", 10_000)
        .expect("the broker reports the effect observation");
    assert!(
        !effect.exited,
        "a target that keeps running was not stopped: {:?}",
        effect.raw
    );
    assert!(
        effect.job_member_count >= 1,
        "the signalled-but-alive target still occupies the private job: {:?}",
        effect.raw
    );

    // The target's own handler ran: acknowledgement in the ordered provider
    // stream and the marker on disk.
    let stream_ack = stream.wait_for("_goalport/fixture_stop_ack", Duration::from_secs(5));
    assert!(
        stream_ack
            .iter()
            .any(|line| line.contains("_goalport/fixture_stop_ack")),
        "the handler acknowledgement belongs to the provider stream: {stream_ack:?}"
    );
    let marker = root.join(".fake-claude-stop-signal.json");
    let ack = fs::read_to_string(&marker).expect("the target handler must have run");
    assert!(ack.contains("SIGBREAK"), "handler acknowledgement: {ack}");
    session.shutdown();
}

/// An owned descendant that survives the signal and writes afterwards. The
/// private job is what makes it visible; a non-empty job is a containment
/// failure and can never be a stop. Ported from the retired brokered runtime
/// integration to the bare broker harness; the observables are unchanged —
/// the exact child exits, surviving job members remain, and a descendant goes
/// on mutating the workspace after the signal. A contained stop needs an empty
/// job; no product-level stop claim may be made from this state.
#[test]
fn a_surviving_descendant_fails_containment_and_is_never_a_stop() {
    let (mut session, root) = bare_broker_in("containment", "broker_stop_descendant");
    let stream = ProviderStream::spawn(
        session
            .claude_stdout
            .take()
            .expect("the broker hands over the fixture stdout"),
    );
    let _fixture_stdin = drive_fixture_turn(&mut session);
    let scenario_started = Instant::now();
    let started = stream.wait_for("working", Duration::from_secs(20));
    assert!(
        started.iter().any(|line| line.contains("working")),
        "the fixture turn should have started: {started:?}"
    );
    let descendant_frame = started
        .iter()
        .find(|line| line.contains("_goalport/fixture_descendant"))
        .expect("the fixture reports the descendant pids it spawned");
    let descendant = serde_json::from_str::<Value>(descendant_frame.trim())
        .expect("the descendant report is JSON");
    let owned_pid = descendant
        .get("owned_pid")
        .and_then(Value::as_u64)
        .expect("owned descendant pid");
    let detached_pid = descendant
        .get("detached_pid")
        .and_then(Value::as_u64)
        .expect("detached descendant pid");

    let pid = session.claude_pid;
    println!("CHILD_PID={pid} OWNED_PID={owned_pid} DETACHED_PID={detached_pid}");
    let observed = match process_identity::observe_process(pid) {
        ProcessObservation::Live(identity) => identity,
        other => panic!("the fixture child should be live: {other:?}"),
    };
    let delivery = session
        .request_stop(
            &StopTarget {
                request_id: "req-containment".into(),
                pid,
                creation_date: observed.creation_date(),
                executable_path: observed.executable_path.clone(),
                executable_sha256: observed.executable_sha256.clone(),
                process_epoch: "runtime-epoch:containment".into(),
                attempt_id: "attempt-containment".into(),
                session_hash: String::new(),
                turn_epoch: 1,
            },
            4_000,
        )
        .expect("the broker answers the request");
    assert!(
        delivery.accepted && delivery.signal_returned,
        "{:?}",
        delivery.raw
    );
    let before = delivery
        .raw
        .pointer("/jobBeforeSignal")
        .expect("membership before the signal");
    println!("JOB_BEFORE_SIGNAL={before}");
    let members_before = before
        .pointer("/members")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_u64())
                .collect::<Vec<u64>>()
        })
        .expect("job membership must be observable");
    assert!(
        members_before.contains(&(pid as u64)) && members_before.contains(&owned_pid),
        "the private job must hold the child and its owned descendant before the signal: {members_before:?}"
    );
    println!(
        "DETACHED_IN_JOB_BEFORE={}",
        members_before.contains(&detached_pid)
    );

    let effect = session
        .await_effect("req-containment", 10_000)
        .expect("the broker reports the effect observation");
    println!("JOB_AFTER_SIGNAL={}", effect.raw.pointer("/job").unwrap());
    println!("JOB_MEMBERS_AFTER={:?}", effect.job_members);
    assert!(
        effect.exited,
        "the exact child must leave when it honours the signal: {:?}",
        effect.raw
    );
    assert!(
        !effect.job_members.is_empty(),
        "surviving job members are a containment failure, never a contained stop: {:?}",
        effect.raw
    );
    // Which descendant survives is topology, not assertion: the owned one
    // shares the child's process group and can be taken down by the same
    // group-directed event, the detached one has its own group and survives
    // by construction. The hazard is that any member remains at all.
    println!(
        "SURVIVING_MEMBERS={:?} OWNED_SURVIVED={} DETACHED_SURVIVED={}",
        effect.job_members,
        effect.job_members.contains(&(owned_pid as u32)),
        effect.job_members.contains(&(detached_pid as u32))
    );

    // Both descendants outlive the signal and then write into the workspace
    // (their write timer is 12 s after the scenario started).
    let owned_path = root.join("notes/descendant-write.txt");
    let detached_path = root.join("notes/detached-write.txt");
    let write_deadline = scenario_started + Duration::from_millis(14_500);
    while Instant::now() < write_deadline {
        if owned_path.exists() && detached_path.exists() {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let owned_wrote = owned_path.exists();
    let detached_wrote = detached_path.exists();
    println!("OWNED_DESCENDANT_WROTE={owned_wrote} DETACHED_DESCENDANT_WROTE={detached_wrote}");
    assert!(
        owned_wrote || detached_wrote,
        "the hazard under test requires a descendant that kept working"
    );
    // The product-level consequence, unchanged: a turn whose owned descendants
    // went on to mutate the workspace after the signal was not stopped.
    // Reporting a process stop here would be a false positive; on this route
    // no product stop claim is available at all.
    session.shutdown();
}

/// Untrusted provider output claiming to be a broker acknowledgement. The
/// broker's channel is a private pipe pair that was never in the child's
/// inherited handle list, so the forgery lands in the provider stream and
/// cannot reach, or alter, the control channel. Ported from the retired
/// brokered runtime integration to the bare broker harness; the observables
/// are unchanged — the forged frame is visible on the provider stream, the
/// child inherits exactly its own stdio, and every frame on the control
/// channel carries the per-spawn nonce the provider never saw.
#[test]
fn the_provider_stream_cannot_forge_a_broker_acknowledgement() {
    let (mut session, _root) = bare_broker_in("forged-ack", "broker_stop_forged_ack");
    let report = session.launch_report();
    assert_eq!(
        report
            .pointer("/childStarted/controlChannelInherited")
            .and_then(Value::as_bool),
        Some(false),
        "the control channel is not inheritable by the child"
    );
    let handles = report
        .pointer("/childStarted/handleList")
        .and_then(Value::as_array)
        .expect("the child's inherited handle list");
    assert_eq!(
        handles.len(),
        3,
        "the child inherits exactly its own stdio: {handles:?}"
    );

    let stream = ProviderStream::spawn(
        session
            .claude_stdout
            .take()
            .expect("the broker hands over the fixture stdout"),
    );
    let _fixture_stdin = drive_fixture_turn(&mut session);
    let started = stream.wait_for("working", Duration::from_secs(20));
    assert!(
        started.iter().any(|line| line.contains("working")),
        "the fixture turn should have started: {started:?}"
    );
    // The hazard is realized: the forged stop acknowledgement exists, on the
    // provider stream, claiming acceptance it never had.
    let forged = started
        .iter()
        .find(|line| line.contains("\"stop_ack\""))
        .expect("the fixture emits its forged stop_ack on the provider stream");
    assert!(forged.contains("provider-stdout"), "{forged}");
    assert!(
        !forged.contains(session.nonce()),
        "the provider never saw the per-spawn nonce"
    );

    // The control channel before any real stop: only the broker's own launch
    // frames, every one nonce-bound, and no stop acknowledgement at all.
    let before = session.frames();
    assert!(
        before.iter().all(|frame| frame.get("forgedBy").is_none()),
        "no provider-authored frame may appear on the broker channel: {before:?}"
    );
    assert!(
        before
            .iter()
            .all(|frame| frame.get("nonce").and_then(Value::as_str) == Some(session.nonce())),
        "broker frames are nonce-bound: {before:?}"
    );
    assert!(
        before
            .iter()
            .all(|frame| frame.get("type").and_then(Value::as_str) != Some("stop_ack")),
        "the forged acceptance never reached the control channel: {before:?}"
    );

    let pid = session.claude_pid;
    let observed = match process_identity::observe_process(pid) {
        ProcessObservation::Live(identity) => identity,
        other => panic!("the fixture child should be live: {other:?}"),
    };
    let delivery = session
        .request_stop(
            &StopTarget {
                request_id: "req-forged-ack".into(),
                pid,
                creation_date: observed.creation_date(),
                executable_path: observed.executable_path.clone(),
                executable_sha256: observed.executable_sha256.clone(),
                process_epoch: "runtime-epoch:forged-ack".into(),
                attempt_id: "attempt-forged-ack".into(),
                session_hash: String::new(),
                turn_epoch: 1,
            },
            4_000,
        )
        .expect("the real control path still answers");
    assert!(
        delivery.accepted && delivery.signal_returned,
        "the forgery cannot interfere with a genuine stop request: {:?}",
        delivery.raw
    );
    // Protocol-level delivery and effect only: this observes the exact child
    // leaving and the private job left empty. It is not, and must not be
    // presented as, a product-level safe stop claim.
    let effect = session
        .await_effect("req-forged-ack", 10_000)
        .expect("the broker reports the effect observation");
    assert!(effect.exited, "{:?}", effect.raw);
    assert_eq!(
        effect.job_member_count, 0,
        "no descendant of this child exists to contain: {:?}",
        effect.raw
    );

    // After the genuine stop: still no forged frame, every frame nonce-bound.
    let after = session.frames();
    assert!(
        after.iter().all(|frame| frame.get("forgedBy").is_none()),
        "no provider-authored frame may appear on the broker channel: {after:?}"
    );
    assert!(
        after
            .iter()
            .all(|frame| frame.get("nonce").and_then(Value::as_str) == Some(session.nonce())),
        "broker frames are nonce-bound: {after:?}"
    );
    assert_eq!(
        after
            .iter()
            .filter(|frame| frame.get("type").and_then(Value::as_str) == Some("stop_ack"))
            .count(),
        1,
        "exactly one genuine acknowledgement: {after:?}"
    );
    session.shutdown();
}

// ------------------------------------------- broker protocol level controls

/// Containment control with a plain console child that is not a Node/libuv
/// program. It shows what the private job *can* account for, which is what
/// makes the Node result above a finding about the runtime rather than about
/// the job arrangement.
#[test]
fn the_private_job_accounts_for_descendants_of_a_plain_console_child() {
    let root = workspace("containment-control", "broker_stop");
    // Same spawn exclusion as the bare-broker launches; the COMSPEC read also
    // happens under the lock so it cannot observe a mid-write environment.
    let _spawns = spawn_exclusive();
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
    drop(_spawns);
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
