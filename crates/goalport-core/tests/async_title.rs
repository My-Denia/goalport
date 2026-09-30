#![cfg(target_os = "linux")]

use goalport_core::async_title::{TitleRequest, spawn_title_with_timeout};
use std::{fs, path::PathBuf, sync::Mutex, time::{Duration, Instant}};

// These tests exercise a shared two-slot cap; serialize this file so each peer
// has a naming slot without changing process-wide provider environment.
static SERIAL: Mutex<()> = Mutex::new(());

fn request(root: &std::path::Path) -> TitleRequest {
    TitleRequest {
        campaign_id: "campaign-title-test".into(), provider: "codex".into(),
        executable: Some(PathBuf::from("python3")), workspace_root: root.to_owned(),
        first_prompt: "Fix the calculator's addition bug".into(),
    }
}

fn peer(root: &std::path::Path, mode: &str) {
    fs::write(root.join("mode"), mode).unwrap();
    fs::write(root.join("app-server"), r#"
import json, pathlib, sys, time
root = pathlib.Path.cwd()
def send(value):
    print(json.dumps(value), flush=True)
for line in sys.stdin:
    message = json.loads(line)
    method, request_id = message.get('method'), message.get('id')
    if method == 'initialize': send({'id':request_id,'result':{}})
    elif method == 'thread/start':
        (root/'thread.json').write_text(json.dumps(message))
        send({'id':request_id,'result':{'thread':{'id':'independent-title-thread'}}})
    elif method == 'turn/start':
        (root/'prompt.json').write_text(json.dumps(message))
        send({'id':request_id,'result':{'turn':{'id':'title-turn'}}})
        send({'method':'turn/started','params':{'threadId':'independent-title-thread','turnId':'title-turn'}})
        mode=(root/'mode').read_text()
        if mode=='delayed':
            while not (root/'release').exists(): time.sleep(0.01)
        if mode=='quota':
            send({'method':'turn/completed','params':{'threadId':'independent-title-thread','turn':{'id':'title-turn','status':'failed','error':{'codexErrorInfo':'usageLimitExceeded','message':'fixture quota'}}}})
        elif mode=='permission':
            send({'id':'title-permission','method':'item/commandExecution/requestApproval','params':{'threadId':'independent-title-thread','turnId':'title-turn','command':'write something'}})
        else:
            for text in ['Fix ', 'calculator ', 'addition']:
                send({'method':'item/agentMessage/delta','params':{'threadId':'independent-title-thread','turnId':'title-turn','delta':text}})
            send({'method':'turn/completed','params':{'threadId':'independent-title-thread','turn':{'id':'title-turn','status':'completed'}}})
"#).unwrap();
}

#[test]
fn independent_naming_returns_without_waiting_and_uses_read_only_ephemeral_session() {
    let _serial = SERIAL.lock().unwrap();
    let root = tempfile::tempdir().unwrap();
    peer(root.path(), "delayed");
    let began = Instant::now();
    let receiver = spawn_title_with_timeout(request(root.path()), Duration::from_secs(5));
    assert!(began.elapsed() < Duration::from_millis(200));
    let deadline = Instant::now() + Duration::from_secs(4);
    while !root.path().join("prompt.json").exists() {
        assert!(Instant::now() < deadline, "title peer never received a prompt");
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(receiver.try_recv().is_err(), "must wait for the independent peer's completion");
    let thread: serde_json::Value = serde_json::from_slice(&fs::read(root.path().join("thread.json")).unwrap()).unwrap();
    assert_eq!(thread["params"]["sandbox"], "read-only");
    assert_eq!(thread["params"]["ephemeral"], true);
    let prompt = fs::read_to_string(root.path().join("prompt.json")).unwrap();
    assert!(prompt.contains("naming task only"));
    fs::write(root.path().join("release"), "release").unwrap();
    let result = receiver.recv_timeout(Duration::from_secs(4)).unwrap();
    assert_eq!(result.campaign_id, "campaign-title-test");
    assert_eq!(result.title.as_deref(), Some("Fix calculator addition"));
}

#[test]
fn quota_and_permission_leave_the_local_title_in_place() {
    let _serial = SERIAL.lock().unwrap();
    for mode in ["quota", "permission"] {
        let root = tempfile::tempdir().unwrap();
        peer(root.path(), mode);
        let result = spawn_title_with_timeout(request(root.path()), Duration::from_secs(3))
            .recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(result.title, None, "{mode} must not become a generated title");
    }
}

#[test]
fn unsupported_provider_does_not_launch_a_different_runtime() {
    let _serial = SERIAL.lock().unwrap();
    let root = tempfile::tempdir().unwrap();
    let mut input = request(root.path());
    input.provider = "claude".into();
    input.executable = Some(PathBuf::from("/nonexistent-provider"));
    let result = spawn_title_with_timeout(input, Duration::from_secs(1))
        .recv_timeout(Duration::from_secs(1)).unwrap();
    assert_eq!(result.title, None);
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
}
