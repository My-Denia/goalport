//! Full-core regression coverage for Claude Stop hold release rules.
//!
//! The defect this suite locks out (reproduced on the pre-fix head, GAH run
//! claude-stop-pending-permission): a Stop issued while a Claude permission
//! decision was pending left the workspace durably held -- re-check returned
//! `bound-runtime-absent-residual-still-unknown` and no rule could ever
//! release the hold.
//!
//! Release rules under test (projection poll loop):
//! - `interrupted`: the native turn was confirmed cancelled; a quiet window
//!   (no workspace writers + two equal fingerprints >= 1 s apart) releases.
//! - `unconfirmed` + never-admitted: additionally requires the exact bound
//!   runtime to be observed gone AND the durable admission ledger to prove no
//!   tool execution was EVER admitted during the process binding.
//!
//! Matrix (owner requirement): Stop while permission pending; permission
//! Allow then active Stop; permission Deny; process disappearance; and NO
//! release when residual execution is genuinely unknown (a tool was admitted
//! earlier in the process binding).
#![cfg(target_os = "linux")]

use goalport_core::{
    ipc::{CONNECTED_UI_PROTOCOL_VERSION, CoreServer},
    store::Store,
};
use serde_json::{Value, json};
#[cfg(target_os = "linux")]
use libc;
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
    thread,
    time::{Duration, Instant},
};

static FIXTURE_ENV: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn begin() -> std::sync::MutexGuard<'static, ()> {
    let lock = FIXTURE_ENV.lock().unwrap_or_else(|error| error.into_inner());
    let node = Command::new("which").arg("node").output().expect("which node");
    assert!(node.status.success(), "node is required for the Claude fixture peer");
    let path = String::from_utf8(node.stdout).unwrap();
    unsafe { env::set_var("GOALPORT_CLAUDE_FIXTURE_INTERPRETER", path.trim()) };
    lock
}

fn fake_cli() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/fake-claude-cli/fake-claude-cli.mjs")
}

fn wire(id: &str, kind: &str, payload: Value) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "protocolVersion": CONNECTED_UI_PROTOCOL_VERSION,
        "requestId": id,
        "entityVersion": 0,
        "messageType": kind,
        "payload": payload
    }))
    .unwrap()
}

struct Core {
    server: CoreServer,
    epoch: String,
}

fn boot(store: &Store, previous_epoch: Option<&str>) -> Core {
    static BOOTS: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let n = BOOTS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let label = format!("hold-release-{}-{n}", std::process::id());
    seed_core_launch_epoch(store, &label, previous_epoch);
    Core {
        server: CoreServer::new(store.clone()),
        epoch: format!("core-epoch:{label}"),
    }
}

struct Conversation {
    campaign_id: String,
    task_id: String,
    attempt_id: String,
}

fn admit_claude(core: &Core, root: &Path, label: &str) -> Conversation {
    let created = core
        .server
        .handle_json(&wire(
            &format!("{label}-create"),
            "create_campaign_with_task",
            json!({
                "workspaceRoot": root.to_string_lossy(),
                "goal": label,
                "title": label,
                "acceptance": "hold release rules"
            }),
        ))
        .unwrap();
    assert_eq!(created["ok"], true, "{created}");
    let view = &created["payload"]["snapshot"];
    let campaign_id = view["activeCampaignId"].as_str().unwrap().to_owned();
    let task_id = view["activeTask"]["id"].as_str().unwrap().to_owned();
    let selected = core
        .server
        .handle_json(&wire(
            &format!("{label}-runtime"),
            "select_runtime",
            json!({
                "campaignId": campaign_id,
                "taskId": task_id,
                "provider": "claude",
                "executable": fake_cli(),
            }),
        ))
        .unwrap();
    assert_eq!(selected["ok"], true, "{selected}");
    let attempt_id = selected["payload"]["snapshot"]["attempt"]["id"]
        .as_str()
        .expect("attempt id after runtime selection")
        .to_owned();
    Conversation { campaign_id, task_id, attempt_id }
}

fn send(core: &Core, conversation: &Conversation, label: &str, message: &str) {
    let sent = core
        .server
        .handle_json(&wire(
            &format!("{label}-send-{}", nanos()),
            "send_message",
            json!({
                "campaignId": conversation.campaign_id,
                "taskId": conversation.task_id,
                "attemptId": conversation.attempt_id,
                "message": message
            }),
        ))
        .unwrap();
    assert_eq!(sent["ok"], true, "{sent}");
}

fn stop(core: &Core, conversation: &Conversation, label: &str) -> Value {
    core.server
        .handle_json(&wire(
            &format!("{label}-stop"),
            "interrupt",
            json!({ "attemptId": conversation.attempt_id }),
        ))
        .unwrap()
}

fn snapshot(core: &Core) -> Value {
    core.server
        .handle_json(&wire(&format!("snap-{}", nanos()), "snapshot", json!({})))
        .unwrap()
}

fn wait_for(
    core: &Core,
    store: &Store,
    attempt: &str,
    label: &str,
    done: impl Fn(&[goalport_core::EventRecord]) -> bool,
) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        let _ = snapshot(core);
        let records = store.list_event_records(attempt, 0).unwrap();
        if done(&records) {
            return;
        }
        thread::sleep(Duration::from_millis(100));
    }
    panic!("condition not reached for {attempt} ({label})");
}

fn poll_until(
    core: &Core,
    store: &Store,
    label: &str,
    window: Duration,
    done: impl Fn() -> bool,
) -> bool {
    let deadline = Instant::now() + window;
    while Instant::now() < deadline {
        let _ = snapshot(core);
        if done() {
            return true;
        }
        thread::sleep(Duration::from_millis(250));
    }
    done()
}

fn pending_decision_id(core: &Core) -> Option<String> {
    let view = snapshot(core);
    view["payload"]["snapshot"]["decisions"]
        .as_array()?
        .iter()
        .find(|decision| decision["state"] == json!("PENDING") || decision["state"] == json!("pending"))
        .and_then(|decision| decision["id"].as_str())
        .map(str::to_owned)
}

fn release_events(store: &Store, attempt: &str) -> Vec<Value> {
    store
        .list_event_records(attempt, 0)
        .unwrap()
        .into_iter()
        .filter(|record| record.event.kind == "runtime.stop.responsibility.released")
        .filter_map(|record| record.payload)
        .collect()
}

fn workspace_dir(label: &str, scenario: &str) -> PathBuf {
    let dir = env::temp_dir().join(format!(
        "goalport-hold-release-{label}-{}",
        nanos()
    ));
    fs::create_dir_all(dir.join("notes")).unwrap();
    fs::write(dir.join(".fake-claude-scenario"), scenario).unwrap();
    git_repo(&dir);
    dir
}

fn nanos() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos()
}

// --- matrix case 1: Stop while permission pending -----------------------------

#[test]
fn stop_while_permission_pending_releases_the_hold() {
    let _fixture_guard = begin();
    let root = workspace_dir("pending-stop", "interrupt_mutating");
    let store = Store::memory().unwrap();
    let core = boot(&store, None);
    let conversation = admit_claude(&core, &root, "pending-stop");

    send(&core, &conversation, "pending-stop", "ask for a Write and wait");
    wait_for(&core, &store, &conversation.attempt_id, "permission card", |records| {
        records.iter().any(|record| record.event.kind == "runtime.permission.request")
    });

    let stop_receipt = stop(&core, &conversation, "pending-stop");
    assert_eq!(stop_receipt["ok"], true, "{stop_receipt}");
    wait_for(&core, &store, &conversation.attempt_id, "unverified stop", |records| {
        records.iter().any(|record| record.event.kind == "runtime.turn.failed")
    });
    let held = store.stop_responsibilities().unwrap();
    assert_eq!(held.len(), 1, "exactly one hold expected");
    assert_eq!(
        held[0].detail.as_ref().unwrap()
            .pointer("/payload/stop_attempt/admission/executionEverAdmitted"),
        Some(&json!(false)),
        "no tool was ever admitted"
    );

    // Core restart with the runtime gone: the live-fix-9 situation.
    let first_epoch = core.epoch.clone();
    drop(core);
    let core = boot(&store, Some(&first_epoch));
    let recheck = core
        .server
        .handle_json(&wire(
            "pending-stop-recheck",
            "recheck_stop_responsibility",
            json!({ "attemptId": conversation.attempt_id }),
        ))
        .unwrap();
    assert_eq!(
        recheck["payload"]["receipt"]["observation"]["verdict"],
        json!("bound-runtime-absent-residual-still-unknown"),
        "{recheck}"
    );
    assert_eq!(
        recheck["payload"]["receipt"]["releaseEligibility"]["executionNeverAdmitted"],
        json!(true),
        "the never-admitted leg must be reported satisfied: {recheck}"
    );

    let released = poll_until(&core, &store, "pending-stop", Duration::from_secs(10), || {
        store.stop_responsibilities().unwrap().is_empty()
    });
    assert!(
        released,
        "the pending-permission Stop hold must release once the bound runtime is \
         absent and the workspace is quiet"
    );
    let releases = release_events(&store, &conversation.attempt_id);
    assert_eq!(releases.len(), 1, "exactly one release event: {releases:?}");
    assert_eq!(releases[0]["rule"], json!("never-admitted"));
    assert_eq!(releases[0]["evidence"]["executionNeverAdmitted"], json!(true));
    assert_eq!(releases[0]["evidence"]["nativeTurnCancelled"], json!(false));
    assert_eq!(releases[0]["evidence"]["fingerprintEqual"], json!(true));

    // The workspace must be usable again.
    let restart = core
        .server
        .handle_json(&wire(
            "pending-stop-newgoal",
            "start_conversation",
            json!({
                "workspaceRoot": root.to_string_lossy(),
                "provider": "scenario",
                "message": "new goal on the same workspace after release"
            }),
        ))
        .unwrap();
    assert_eq!(restart["ok"], true, "workspace still blocked: {restart}");
}

// --- matrix case 2: permission Allow, then active Stop ------------------------

#[test]
fn allow_then_active_stop_confirms_and_releases() {
    let _fixture_guard = begin();
    let root = workspace_dir("allow-stop", "native_stop_after_allow");
    let store = Store::memory().unwrap();
    let core = boot(&store, None);
    let conversation = admit_claude(&core, &root, "allow-stop");

    send(&core, &conversation, "allow-stop", "run the probe, then keep working");
    wait_for(&core, &store, &conversation.attempt_id, "permission card", |records| {
        records.iter().any(|record| record.event.kind == "runtime.permission.request")
    });
    let decision = pending_decision_id(&core).expect("a pending permission decision");
    let allowed = core
        .server
        .handle_json(&wire(
            "allow-stop-allow",
            "resolve_decision",
            json!({ "decisionId": decision, "allow": true }),
        ))
        .unwrap();
    assert_eq!(allowed["ok"], true, "{allowed}");
    wait_for(&core, &store, &conversation.attempt_id, "tool ran after allow", |records| {
        records.iter().any(|record| record.event.kind == "runtime.tool.activity"
            && record.payload.as_ref().is_some_and(|payload| payload.get("status") == Some(&json!("completed"))))
    });

    let stop_receipt = stop(&core, &conversation, "allow-stop");
    assert_eq!(stop_receipt["ok"], true, "{stop_receipt}");
    wait_for(&core, &store, &conversation.attempt_id, "confirmed stop", |records| {
        records.iter().any(|record| record.event.kind == "runtime.turn.cancelled")
    });
    // The hold may already be gone by the time the cancelled event is visible:
    // snapshot polling drives the quiet release, and the interrupted rule does
    // not wait for the runtime to disappear. What must hold is the release
    // event itself -- a turn confirmed cancelled by the native result, with
    // the admission latch set (a tool WAS allowed) and quiet evidence alone.
    let released = poll_until(&core, &store, "allow-stop", Duration::from_secs(10), || {
        store.stop_responsibilities().unwrap().is_empty()
    });
    assert!(released, "an interrupted Stop with a quiet workspace releases");
    let releases = release_events(&store, &conversation.attempt_id);
    assert_eq!(releases.len(), 1, "{releases:?}");
    assert_eq!(releases[0]["evidence"]["nativeTurnCancelled"], json!(true));
    assert!(
        releases[0].get("rule").is_none(),
        "the interrupted release carries no never-admitted rule tag: {releases:?}"
    );
    let cancelled = store
        .list_event_records(&conversation.attempt_id, 0)
        .unwrap()
        .into_iter()
        .find(|record| record.event.kind == "runtime.turn.cancelled")
        .and_then(|record| record.payload)
        .expect("cancelled event payload");
    assert_eq!(cancelled["native_turn_cancel"], json!(true));
    assert_eq!(
        cancelled["stop_attempt"]["admission"]["executionEverAdmitted"],
        json!(true),
        "a tool was allowed before the Stop: {cancelled:#?}"
    );
}

// --- matrix case 3: permission Deny -------------------------------------------

#[test]
fn permission_deny_ends_the_turn_with_no_hold() {
    let _fixture_guard = begin();
    let root = workspace_dir("deny", "deny");
    let store = Store::memory().unwrap();
    let core = boot(&store, None);
    let conversation = admit_claude(&core, &root, "deny");

    send(&core, &conversation, "deny", "ask for a Write");
    wait_for(&core, &store, &conversation.attempt_id, "permission card", |records| {
        records.iter().any(|record| record.event.kind == "runtime.permission.request")
    });
    let decision = pending_decision_id(&core).expect("a pending permission decision");
    let denied = core
        .server
        .handle_json(&wire(
            "deny-deny",
            "resolve_decision",
            json!({ "decisionId": decision, "allow": false }),
        ))
        .unwrap();
    assert_eq!(denied["ok"], true, "{denied}");
    wait_for(&core, &store, &conversation.attempt_id, "turn ends after deny", |records| {
        records.iter().any(|record| matches!(
            record.event.kind.as_str(),
            "runtime.turn.completed" | "runtime.turn.failed"
        ))
    });

    // A user denial is a normal terminal turn: no Stop was issued, so no
    // responsibility may exist and the workspace was never blocked.
    assert!(
        store.stop_responsibilities().unwrap().is_empty(),
        "permission Deny must not create a Stop hold"
    );
    let restart = core
        .server
        .handle_json(&wire(
            "deny-newgoal",
            "start_conversation",
            json!({
                "workspaceRoot": root.to_string_lossy(),
                "provider": "scenario",
                "message": "new goal on the same workspace after a plain deny"
            }),
        ))
        .unwrap();
    assert_eq!(restart["ok"], true, "workspace unexpectedly blocked: {restart}");
}

// --- matrix case 4: process disappearance -------------------------------------

#[test]
fn process_disappearance_releases_the_never_admitted_hold() {
    let _fixture_guard = begin();
    let root = workspace_dir("vanish", "interrupt_eof");
    let store = Store::memory().unwrap();
    let core = boot(&store, None);
    let conversation = admit_claude(&core, &root, "vanish");

    send(&core, &conversation, "vanish", "work until stopped");
    wait_for(&core, &store, &conversation.attempt_id, "activity", |records| {
        records.iter().any(|record| record.event.kind == "runtime.tool.activity")
    });
    let stop_receipt = stop(&core, &conversation, "vanish");
    assert_eq!(stop_receipt["ok"], true, "{stop_receipt}");
    // The fixture exits on the interrupt with no receipt and no result: an
    // unconfirmed Stop whose bound runtime is then gone.
    wait_for(&core, &store, &conversation.attempt_id, "unverified stop", |records| {
        records.iter().any(|record| record.event.kind == "runtime.turn.failed")
    });
    let held = store.stop_responsibilities().unwrap();
    assert_eq!(held.len(), 1, "{held:?}");

    let recheck = core
        .server
        .handle_json(&wire(
            "vanish-recheck",
            "recheck_stop_responsibility",
            json!({ "attemptId": conversation.attempt_id }),
        ))
        .unwrap();
    assert_eq!(
        recheck["payload"]["receipt"]["observation"]["verdict"],
        json!("bound-runtime-absent-residual-still-unknown"),
        "{recheck}"
    );

    let released = poll_until(&core, &store, "vanish", Duration::from_secs(10), || {
        store.stop_responsibilities().unwrap().is_empty()
    });
    assert!(
        released,
        "a vanished runtime with no execution ever admitted must release"
    );
    let releases = release_events(&store, &conversation.attempt_id);
    assert_eq!(releases.len(), 1, "{releases:?}");
    assert_eq!(releases[0]["rule"], json!("never-admitted"));
}

// --- matrix case 5: no false release when execution was admitted --------------

#[test]
fn an_admitted_execution_keeps_an_unconfirmed_stop_held() {
    let _fixture_guard = begin();
    let root = workspace_dir("admitted", "allow_then_unconfirmed_stop");
    let store = Store::memory().unwrap();
    let core = boot(&store, None);
    let conversation = admit_claude(&core, &root, "admitted");

    // Turn 1: an allowed Bash runs to completion. The sticky admission latch
    // is set for the whole process binding.
    send(&core, &conversation, "admitted", "run the allowed probe");
    wait_for(&core, &store, &conversation.attempt_id, "permission card", |records| {
        records.iter().any(|record| record.event.kind == "runtime.permission.request")
    });
    let decision = pending_decision_id(&core).expect("a pending permission decision");
    let allowed = core
        .server
        .handle_json(&wire(
            "admitted-allow",
            "resolve_decision",
            json!({ "decisionId": decision, "allow": true }),
        ))
        .unwrap();
    assert_eq!(allowed["ok"], true, "{allowed}");
    wait_for(&core, &store, &conversation.attempt_id, "turn 1 completes", |records| {
        records.iter().any(|record| record.event.kind == "runtime.turn.completed")
    });

    // Turn 2: activity, then a Stop that makes the process vanish with no
    // receipt: an unconfirmed Stop -- but execution WAS admitted earlier.
    send(&core, &conversation, "admitted", "second task until stopped");
    wait_for(&core, &store, &conversation.attempt_id, "turn 2 activity", |records| {
        records.iter().filter(|record| record.event.kind == "runtime.tool.activity").count() >= 2
    });
    let stop_receipt = stop(&core, &conversation, "admitted");
    assert_eq!(stop_receipt["ok"], true, "{stop_receipt}");
    wait_for(&core, &store, &conversation.attempt_id, "unverified stop", |records| {
        records.iter().any(|record| record.event.kind == "runtime.turn.failed")
    });
    let held = store.stop_responsibilities().unwrap();
    assert_eq!(held.len(), 1, "{held:?}");
    assert_eq!(
        held[0].detail.as_ref().unwrap()
            .pointer("/payload/stop_attempt/admission/executionEverAdmitted"),
        Some(&json!(true)),
        "the latch must survive the turn reset"
    );

    let recheck = core
        .server
        .handle_json(&wire(
            "admitted-recheck",
            "recheck_stop_responsibility",
            json!({ "attemptId": conversation.attempt_id }),
        ))
        .unwrap();
    assert_eq!(
        recheck["payload"]["receipt"]["releaseEligibility"]["executionNeverAdmitted"],
        json!(false),
        "the ledger leg must report unsatisfied: {recheck}"
    );

    // Quiet workspace, absent runtime -- and still no release. Residual
    // execution from the admitted tool is genuinely unknown here; only the
    // isolated-workspace continuation may carry the work forward.
    let released = poll_until(&core, &store, "admitted", Duration::from_secs(6), || {
        store.stop_responsibilities().unwrap().is_empty()
    });
    assert!(
        !released,
        "an unconfirmed Stop with execution ever admitted must NOT release on quiet evidence"
    );
    let restart = core
        .server
        .handle_json(&wire(
            "admitted-newgoal",
            "start_conversation",
            json!({
                "workspaceRoot": root.to_string_lossy(),
                "provider": "scenario",
                "message": "must be refused while the hold stands"
            }),
        ))
        .unwrap();
    assert_eq!(
        restart["ok"], false,
        "the held workspace must refuse new conversations: {restart}"
    );
}

// --- helpers -------------------------------------------------------------------

fn seed_core_launch_epoch(store: &Store, label: &str, previous: Option<&str>) {
    use goalport_core::store::CoreLaunchEpoch;
    let epoch = CoreLaunchEpoch {
        epoch_id: format!("core-epoch:{label}"),
        launch_nonce: label.to_owned(),
        core_pid: i64::from(std::process::id()),
        core_creation_date: format!("/LinuxStart({}:{})/", label, std::process::id()),
        core_executable_path: "goalport-core".into(),
        core_executable_sha256: "0".repeat(64),
        previous_epoch_id: None,
        state: "RECONCILING".into(),
        reconciliation: None,
        created_at: "2026-10-04T00:00:00Z".into(),
        activated_at: None,
    };
    assert!(
        store.claim_core_launch_epoch(&epoch, previous, None).expect("claim epoch"),
        "epoch claim must win"
    );
    store
        .stage_core_launch_startup(
            &epoch.epoch_id,
            &epoch.launch_nonce,
            &json!({}),
            &json!({}),
            &format!("startup:{label}"),
        )
        .expect("stage startup");
    store
        .commit_core_launch_ready(
            &epoch.epoch_id,
            &epoch.launch_nonce,
            &json!({}),
            &json!({}),
            &format!("ready:{label}"),
            "2026-10-04T00:00:00Z",
        )
        .expect("commit ready");
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
    fs::write(dir.join(".gitignore"), ".fake-claude-*\nnotes/fixture-allow.txt\n");
    run(&["add", "README.md", ".gitignore"]);
    run(&["commit", "-m", "base"]);
    fs::write(dir.join("NOTES"), "pre-existing dirty\n").unwrap();
}

// --- merge-review P1: stop-time descendant snapshot release leg -----------

#[test]
fn a_surviving_descendant_blocks_release_and_death_releases() {
    let _fixture_guard = begin();
    let root = workspace_dir("descendant", "stop_descendant");
    let store = Store::memory().unwrap();
    let core = boot(&store, None);
    let conversation = admit_claude(&core, &root, "descendant");

    send(&core, &conversation, "descendant", "work until stopped");
    wait_for(&core, &store, &conversation.attempt_id, "activity", |records| {
        records.iter().any(|record| record.event.kind == "runtime.tool.activity")
    });
    // Wait until the fixture's non-dumpable child is alive (its pid file).
    let mut descendant_pid = None;
    for _ in 0..50 {
        if let Ok(text) = fs::read_to_string(root.join(".fake-claude-descendant.pid")) {
            descendant_pid = text.trim().parse::<u32>().ok();
            if descendant_pid.is_some() {
                break;
            }
        }
        let _ = snapshot(&core);
        thread::sleep(Duration::from_millis(100));
    }
    let descendant_pid = descendant_pid.expect("fixture descendant pid file");

    let stop_receipt = stop(&core, &conversation, "descendant");
    assert_eq!(stop_receipt["ok"], true, "{stop_receipt}");
    wait_for(&core, &store, &conversation.attempt_id, "confirmed stop", |records| {
        records.iter().any(|record| record.event.kind == "runtime.turn.cancelled")
    });

    // The snapshot must have recorded the descendant in the stop trace.
    let held = store.stop_responsibilities().unwrap();
    assert_eq!(held.len(), 1, "{held:?}");
    let detail = held[0].detail.as_ref().unwrap();
    let descendants = detail
        .pointer("/payload/stop_attempt/descendants")
        .and_then(|value| goalport_core::descendants::descendants_from_json(value))
        .expect("snapshot present in the durable trace");
    assert!(
        descendants.iter().any(|record| record.pid == descendant_pid),
        "the non-dumpable child is snapshotted: {descendants:?}"
    );

    // While the descendant lives, the hold must NOT release even though the
    // workspace is quiet and the CLI ended the turn.
    let released_early = poll_until(&core, &store, "descendant-alive", Duration::from_secs(4), || {
        store.stop_responsibilities().unwrap().is_empty()
    });
    assert!(
        !released_early,
        "a surviving stop-time descendant must block release"
    );

    // Kill the descendant; the identity-checked leg now sees it dead and the
    // interrupted rule releases on quiet evidence.
    kill_descendant(descendant_pid);
    let released = poll_until(&core, &store, "descendant-dead", Duration::from_secs(20), || {
        store.stop_responsibilities().unwrap().is_empty()
    });
    if !released {
        let held = store.stop_responsibilities().unwrap();
        panic!("release completes once the descendant is dead: {held:?}");
    }
    let releases = release_events(&store, &conversation.attempt_id);
    assert_eq!(releases.len(), 1, "{releases:?}");
}

#[cfg(target_os = "linux")]
fn kill_descendant(pid: u32) {
    let result = unsafe { libc::kill(pid as i32, libc::SIGKILL) };
    assert_eq!(result, 0, "kill descendant {pid}");
}
