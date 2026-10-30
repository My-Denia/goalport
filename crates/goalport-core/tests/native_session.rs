//! Synthetic contract checks. No installed provider, account, bound Core or profile.
use goalport_core::{RuntimeManager, ipc::{CoreServer, CONNECTED_UI_PROTOCOL_VERSION}, store::Store};
use goalport_core::runtime_manager::{CodexTransportKind, configured_codex_transport};
use goalport_core::commands::sha256_hex;
use serde_json::{json, Value};
use std::sync::Mutex;

static ENV: Mutex<()> = Mutex::new(());
struct Environment(Vec<(String, Option<std::ffi::OsString>)>);
impl Environment {
    fn set(values: &[(&str, &str)]) -> Self {
        Self(values.iter().map(|(key, value)| {
            let before = std::env::var_os(key);
            unsafe { std::env::set_var(key, value); }
            ((*key).into(), before)
        }).collect())
    }
}
impl Drop for Environment {
    fn drop(&mut self) {
        for (key, before) in self.0.drain(..) {
            unsafe { if let Some(value) = before { std::env::set_var(key, value); } else { std::env::remove_var(key); } }
        }
    }
}
fn call(server: &CoreServer, id: &str, payload: Value) -> Value {
    server.handle_json(&serde_json::to_vec(&json!({
        "protocolVersion": CONNECTED_UI_PROTOCOL_VERSION, "requestId": id,
        "entityVersion": 0, "messageType": "start_conversation", "payload": payload
    })).unwrap()).unwrap()
}
fn root(path: &std::path::Path) -> String {
    let text = std::fs::canonicalize(path).unwrap().to_string_lossy().to_string();
    text.strip_prefix(r"\\?\").unwrap_or(&text).to_owned()
}

#[test]
fn frozen_whole_binding_survives_env_flip_without_spawn_or_second_lookup() {
    let _lock = ENV.lock().unwrap();
    let _env = Environment::set(&[("GOALPORT_CODEX_TRANSPORT", "app-server"), ("GOALPORT_CODEX_APPROVAL_POLICY", "on-request")]);
    let directory = tempfile::tempdir().unwrap();
    let executable = directory.path().join("never-executed-codex");
    let binding = RuntimeManager::intended_binding("codex", Some(executable.clone()), "fixture-version", directory.path()).unwrap();
    unsafe {
        std::env::set_var("GOALPORT_CODEX_TRANSPORT", "exec");
        std::env::set_var("GOALPORT_CODEX_APPROVAL_POLICY", "untrusted");
    }
    let mut manager = RuntimeManager::new();
    manager.select_runtime_from_binding("frozen-app", binding.clone()).unwrap();
    assert_eq!(manager.codex_transport("frozen-app"), Some(CodexTransportKind::AppServer));
    assert_eq!(manager.registered_binding("frozen-app"), Some(&binding));
    assert_eq!(binding.approval_policy.as_deref(), Some("on-request"));
    assert_eq!(manager.native_pid("frozen-app"), None);
    assert_eq!(configured_codex_transport(), CodexTransportKind::Exec);
    let exec = RuntimeManager::intended_binding("codex", Some(executable), "exec-version", directory.path()).unwrap();
    unsafe { std::env::set_var("GOALPORT_CODEX_TRANSPORT", "app-server"); }
    manager.select_runtime_from_binding("frozen-exec", exec.clone()).unwrap();
    assert_eq!(manager.codex_transport("frozen-exec"), Some(CodexTransportKind::Exec));
    assert_eq!(manager.registered_binding("frozen-exec"), Some(&exec));
    assert_eq!(manager.codex_transport("missing"), None);
    manager.select_runtime("synthetic", "scenario", None, "fixture", directory.path()).unwrap();
    assert_eq!(manager.codex_transport("synthetic"), None);
    #[cfg(unix)] {
        let first = directory.path().join("bin-first"); let second = directory.path().join("bin-second");
        std::fs::create_dir(&first).unwrap(); std::fs::create_dir(&second).unwrap();
        std::fs::write(first.join("codex"), "synthetic never executed").unwrap();
        std::fs::write(second.join("codex"), "different synthetic never executed").unwrap();
        let _path = Environment::set(&[("PATH", first.to_str().unwrap())]);
        let resolved = RuntimeManager::intended_binding("codex", None, "path-frozen", directory.path()).unwrap();
        assert_eq!(resolved.executable, Some(std::fs::canonicalize(first.join("codex")).unwrap()));
        unsafe { std::env::set_var("PATH", &second); }
        manager.select_runtime_from_binding("path-frozen", resolved.clone()).unwrap();
        assert_eq!(manager.registered_binding("path-frozen"), Some(&resolved));
        assert_eq!(manager.native_pid("path-frozen"), None);
    }
}

#[test]
fn literal_constraint_and_exec_refuse_before_any_goal_request_or_runtime_rows() {
    let _lock = ENV.lock().unwrap();
    let _env = Environment::set(&[("GOALPORT_CODEX_TRANSPORT", "exec")]);
    let directory = tempfile::tempdir().unwrap();
    let store = Store::memory().unwrap();
    let server = CoreServer::new(store.clone());
    for (n, flag) in [Value::Null, json!(false), json!("true"), json!(1), json!({}), json!([]), json!(true)].into_iter().enumerate() {
        let id = format!("native-refusal-{n}");
        let response = call(&server, &id, json!({"workspaceRoot":root(directory.path()),"provider":"codex","message":"synthetic only","requireNativeSession":flag}));
        assert_eq!(response["ok"], false, "{response}");
        assert!(store.conversation_request(&id).unwrap().is_none());
        assert!(store.list_projects().unwrap().is_empty());
        assert!(store.list_campaigns().unwrap().is_empty());
    }
}

#[test]
fn absent_constraint_keeps_legacy_hash_and_recorded_success_precedes_current_config() {
    let _lock = ENV.lock().unwrap();
    let directory = tempfile::tempdir().unwrap();
    let workspace = root(directory.path());
    let store = Store::memory().unwrap();
    let server = CoreServer::new(store.clone());
    let payload = json!({"workspaceRoot":workspace,"provider":"scenario","message":"legacy synthetic"});
    let response = call(&server, "legacy-exact", payload.clone());
    assert_eq!(response["ok"], true, "{response}");
    let row = store.conversation_request("legacy-exact").unwrap().unwrap();
    let expected = format!("{{\"identity\":{},\"message\":\"legacy synthetic\",\"provider\":\"scenario\"}}", serde_json::to_string(&workspace).unwrap());
    assert_eq!(row.payload_hash, sha256_hex(expected.as_bytes()));
    let before = store.list_event_records(&row.attempt_id, 0).unwrap().len();
    let other = call(&server, "other-goal", json!({"workspaceRoot":workspace,"provider":"scenario","message":"another goal"}));
    assert_eq!(other["ok"], true, "{other}");
    assert_ne!(other["payload"]["snapshot"]["activeCampaignId"], row.campaign_id);
    let _env = Environment::set(&[("GOALPORT_CODEX_TRANSPORT", "exec")]);
    let replay = call(&server, "legacy-exact", payload.clone());
    assert_eq!(replay["ok"], true);
    assert_eq!(replay["payload"]["snapshot"]["activeCampaignId"], row.campaign_id);
    assert_eq!(store.list_event_records(&row.attempt_id, 0).unwrap().len(), before);
    let changed = call(&server, "legacy-exact", json!({"requireNativeSession":true, "workspaceRoot":workspace,"provider":"scenario","message":"legacy synthetic"}));
    assert_eq!(changed["ok"], false);
    assert!(changed["error"].as_str().unwrap().contains("different payload"));
    assert_eq!(store.conversation_request("legacy-exact").unwrap().unwrap().payload_hash, row.payload_hash);
}

#[test]
fn additive_transport_wire_is_explicit_and_other_runtime_advertisements_omit_it() {
    let _lock = ENV.lock().unwrap();
    let server = CoreServer::new(Store::memory().unwrap());
    let response = server.handle_json(&serde_json::to_vec(&json!({"protocolVersion":CONNECTED_UI_PROTOCOL_VERSION,"requestId":"wire","entityVersion":0,"messageType":"snapshot","payload":{}})).unwrap()).unwrap();
    let view = &response["payload"]["snapshot"];
    assert_eq!(view["productConversation"]["session"]["transport"], "unknown");
    for runtime in view["runtimes"].as_array().unwrap() {
        if runtime["id"] == "codex" { assert!(matches!(runtime["nativeSessionTransport"].as_str(), Some("app-server" | "exec"))); }
        else { assert!(runtime.get("nativeSessionTransport").is_none()); }
    }
    let legacy: goalport_core::product_conversation::ProductSession = serde_json::from_value(json!({"state":"detached","nativeIdKnown":true})).unwrap();
    assert_eq!(serde_json::to_value(legacy).unwrap()["transport"], "unknown");
}

#[test]
fn recorded_constrained_success_uses_namespaced_hash_and_never_admits_under_current_exec() {
    use goalport_core::{Attempt, Campaign, Project, Task, WorkStatus, store::{ConversationStart, CampaignAuthorization, ConversationRequestPhase}};
    let _lock = ENV.lock().unwrap();
    let _env = Environment::set(&[("GOALPORT_CODEX_TRANSPORT", "exec")]);
    let directory = tempfile::tempdir().unwrap();
    let workspace = root(directory.path());
    let request_id = "synthetic-recorded-native";
    let suffix = sha256_hex(request_id.as_bytes());
    let campaign_id = format!("campaign-{suffix}"); let task_id = format!("task-{suffix}"); let attempt_id = format!("attempt-{suffix}");
    let message = "stored synthetic result";
    let legacy = sha256_hex(json!({"identity":workspace,"provider":"codex","message":message}).to_string().as_bytes());
    let payload_hash = sha256_hex(format!("{legacy}\nrequire-native-session=true").as_bytes());
    let store = Store::memory().unwrap();
    store.prepare_conversation_start(&ConversationStart {
        request_id:request_id.into(), payload_hash:payload_hash.clone(), claim_token:"synthetic-claim".into(), native_command_id:"synthetic-command".into(),
        project:Project{id:format!("project-{}",sha256_hex(workspace.as_bytes())),workspace_root:workspace.clone()},
        campaign:Campaign{id:campaign_id.clone(),goal:message.into(),root_task_id:task_id.clone(),state:WorkStatus::InProgress},
        task:Task{id:task_id.clone(),campaign_id:campaign_id.clone(),title:message.into(),acceptance:"synthetic".into(),state:WorkStatus::InProgress},
        policy_id:format!("policy-{suffix}"),policy_payload_json:json!({"campaignId":campaign_id,"providerAuthorized":true,"transferAuthorized":true,"actionAuthorized":true}).to_string(),
        authorization:CampaignAuthorization::granted(),attempt:Attempt::new(&attempt_id,&task_id,"codex","synthetic-cap"),selected_provider:"codex".into(),first_user_message:message.into(),
    }).unwrap();
    store.claim_conversation_request(request_id,"synthetic-claim").unwrap();
    let failed = json!({"requestId":request_id,"deliveryState":"FAILED","nativeDispatchState":"NOT_STARTED","retryMode":"SAME_REQUEST"});
    store.finish_conversation_request(request_id,ConversationRequestPhase::Failed,&failed).unwrap();
    let before = store.list_event_records(&attempt_id,0).unwrap().len();
    let server = CoreServer::new(store.clone());
    let refused = call(&server,request_id,json!({"workspaceRoot":workspace,"provider":"codex","message":message,"requireNativeSession":true}));
    assert_eq!(refused["ok"],false); assert!(refused["error"].as_str().unwrap().contains("require the app-server"));
    let still_failed = store.conversation_request(request_id).unwrap().unwrap();
    assert_eq!(still_failed.phase,"failed"); assert_eq!(still_failed.result,Some(failed));
    assert_eq!(store.list_event_records(&attempt_id,0).unwrap().len(),before,"refusal precedes rearm or registration");
    // Synthetic stored success fixture, not a claim of native execution.
    store.rearm_failed_conversation_request(request_id,&payload_hash,"synthetic-success-claim").unwrap();
    store.claim_conversation_request(request_id,"synthetic-success-claim").unwrap();
    store.begin_dispatch_conversation_request(request_id,"synthetic-success-claim").unwrap();
    store.finish_conversation_request(request_id,ConversationRequestPhase::Succeeded,&json!({"requestId":request_id,"deliveryState":"SUCCEEDED"})).unwrap();
    let replay = call(&server,request_id,json!({"workspaceRoot":workspace,"provider":"codex","message":message,"requireNativeSession":true}));
    assert_eq!(replay["ok"],true,"{replay}");
    assert_eq!(replay["payload"]["snapshot"]["activeCampaignId"],campaign_id);
    assert_eq!(replay["payload"]["snapshot"]["productConversation"]["session"]["transport"],"unknown");
    assert_eq!(store.conversation_request(request_id).unwrap().unwrap().payload_hash,payload_hash);
    assert_eq!(store.list_event_records(&attempt_id,0).unwrap().len(),before);
    assert_eq!(store.list_campaigns().unwrap().len(),1);
    let absent = call(&server,request_id,json!({"workspaceRoot":workspace,"provider":"codex","message":message}));
    assert_eq!(absent["ok"],false); assert!(absent["error"].as_str().unwrap().contains("different payload"));
}

#[cfg(unix)]
#[test]
fn fake_title_is_one_separate_ephemeral_readonly_prompt_with_no_retry_on_tools() {
    use goalport_core::async_title::{spawn_title_with_timeout, TitleRequest};
    use std::time::Duration;
    let _lock = ENV.lock().unwrap();
    let _env = Environment::set(&[("GOALPORT_CODEX_TRANSPORT", "app-server"), ("GOALPORT_CODEX_APPROVAL_POLICY", "on-request")]);
    let directory = tempfile::tempdir().unwrap();
    std::fs::copy(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/linux-codex-peer.py"), directory.path().join("app-server")).unwrap();
    std::fs::write(directory.path().join("peer-scenario"), "native-title-tools").unwrap();
    let result = spawn_title_with_timeout(TitleRequest {
        campaign_id:"title-synthetic".into(), provider:"codex".into(), executable:Some("/usr/bin/python3".into()), workspace_root:directory.path().to_path_buf(), first_prompt:"synthetic title source".into(),
    }, Duration::from_secs(3)).recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(result.title.is_none(), "the fake's tool activity keeps the local fallback");
    let requests: Vec<Value> = std::fs::read_to_string(directory.path().join("native-requests.jsonl")).unwrap().lines().map(|s| serde_json::from_str(s).unwrap()).collect();
    let starts: Vec<_> = requests.iter().filter(|v|v["method"]=="thread/start").collect();
    assert_eq!(starts.len(),1); assert_eq!(starts[0]["params"]["sandbox"],"read-only"); assert_eq!(starts[0]["params"]["ephemeral"],true);
    assert_eq!(requests.iter().filter(|v|v["method"]=="turn/start").count(),1);
    assert_eq!(requests.iter().filter(|v|v["method"]=="thread/resume").count(),0);
}

#[cfg(unix)]
#[test]
fn fake_app_server_two_turns_and_explicit_resume_use_the_original_handle() {
    use goalport_core::{SessionRequest, PromptRequest};
    use std::time::{Duration, Instant};
    let _lock = ENV.lock().unwrap();
    let _env = Environment::set(&[("GOALPORT_CODEX_TRANSPORT", "app-server"), ("GOALPORT_CODEX_APPROVAL_POLICY", "on-request")]);
    let directory = tempfile::tempdir().unwrap();
    let workspace = directory.path();
    std::fs::copy(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/linux-codex-peer.py"), workspace.join("app-server")).unwrap();
    std::fs::write(workspace.join("peer-scenario"), "native-session").unwrap();
    let executable = std::path::PathBuf::from("/usr/bin/python3");
    assert!(executable.is_file(), "installed Python fixture interpreter required");
    let mut manager = RuntimeManager::new();
    let binding = RuntimeManager::intended_binding("codex", Some(executable), "fixture", workspace).unwrap();
    manager.select_runtime_from_binding("native-attempt", binding.clone()).unwrap();
    let request = SessionRequest { campaign_id: Some("native-campaign".into()), task_id: "native-task".into(), attempt_id: "native-attempt".into(), workspace_root: workspace.to_path_buf(), resume_session: None };
    let session = manager.create_session("native-attempt", &request).unwrap().handle.session_id;
    let mut hashes = Vec::new();
    for n in 1..=2 {
        let sent = manager.send_prompt("native-attempt", &PromptRequest { attempt_id:"native-attempt".into(), text:format!("synthetic message {n}"), idempotency_key:format!("synthetic-{n}") }).unwrap();
        assert_eq!(sent.session_id.as_deref(), Some(session.as_str()));
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut events = sent.events;
        loop {
            events.extend(manager.poll_events("native-attempt").unwrap());
            if events.iter().any(|e| e.payload.get("native_turn_hash").and_then(Value::as_str) == Some(sha256_hex(format!("local-turn-{n}").as_bytes()).as_str()) && e.payload.to_string().contains("completed")) { break; }
            assert!(Instant::now() < deadline, "fake native turn did not complete: {events:?}");
            std::thread::sleep(Duration::from_millis(10));
        }
        let hash = sha256_hex(format!("local-turn-{n}").as_bytes());
        assert!(events.iter().filter(|e| e.payload["native_turn_hash"] == hash).count() >= 2, "started and nested turn.id completed refs are both projected");
        assert!(events.iter().filter_map(|e| e.payload.get("native_thread_hash").and_then(Value::as_str)).all(|h| h == sha256_hex(session.as_bytes())));
        hashes.push(hash);
        if n == 1 {
            // Only the settled synthetic peer is closed. A fresh adapter must attach
            // the saved handle without thread/start, title or prompt replay.
            manager.close_attempt("native-attempt").unwrap();
            manager.select_runtime_from_binding("native-attempt", binding.clone()).unwrap();
            let resumed = manager.resume_session_with_context("native-attempt", &SessionRequest { resume_session: Some(session.clone()), ..request.clone() }).unwrap();
            assert!(resumed.handle.resumed);
            assert_eq!(resumed.handle.session_id, session);
        }
    }
    assert_ne!(hashes[0], hashes[1]);
    let requests: Vec<Value> = std::fs::read_to_string(workspace.join("native-requests.jsonl")).unwrap().lines().map(|s| serde_json::from_str(s).unwrap()).collect();
    assert_eq!(requests.iter().filter(|v| v["method"] == "thread/start").count(), 1);
    assert_eq!(requests.iter().filter(|v| v["method"] == "turn/start").count(), 2);
    assert_eq!(requests.iter().filter(|v| v["method"] == "thread/resume").count(), 1);
    for request in requests.iter().filter(|v| v["method"] == "turn/start" || v["method"] == "thread/resume") { assert_eq!(request["params"]["threadId"], session); }
    assert_eq!(manager.codex_transport("native-attempt"), Some(CodexTransportKind::AppServer));
}

