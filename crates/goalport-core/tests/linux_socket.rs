#![cfg(target_os = "linux")]

use goalport_core::ipc::resolve_unix_socket_path;
use goalport_core::{CoreServer, IpcError, Store};
use std::io::{Read, Write};
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

fn wait_until(mut ready: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline {
        if ready() {
            return true;
        }
        std::thread::yield_now();
    }
    false
}

fn frame(payload: &[u8]) -> Vec<u8> {
    let mut out = (payload.len() as u32).to_le_bytes().to_vec();
    out.extend_from_slice(payload);
    out
}

fn snapshot_round_trip(sock: &Path) {
    let mut client = UnixStream::connect(sock).unwrap();
    let payload = br#"{"protocol_version":"goalport.ipc.v2","message_type":"snapshot","request_id":"t","entity_version":1,"payload":{}}"#;
    client.write_all(&frame(payload)).unwrap();
    let mut header = [0u8; 4];
    client.read_exact(&mut header).unwrap();
    assert!(u32::from_le_bytes(header) > 0);
}

fn unique_sock(label: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "goalport-{label}-{}-{nanos}.sock",
        std::process::id()
    ))
}

fn spawn_server_at(path: PathBuf) -> std::thread::JoinHandle<Result<(), IpcError>> {
    let server = CoreServer::new(Store::open_in_memory().unwrap());
    std::thread::spawn(move || server.serve_unix_socket_at(&path))
}

#[test]
fn production_socket_round_trip_and_mode() {
    let sock = unique_sock("mode");
    let _ = std::fs::remove_file(&sock);
    let _ = std::fs::remove_file(format!("{}.lock", sock.display()));
    let thread = spawn_server_at(sock.clone());
    assert!(wait_until(|| sock.exists()));
    let sock_mode = std::fs::metadata(&sock).unwrap().permissions().mode();
    assert_eq!(sock_mode & 0o077, 0, "sock mode {sock_mode:#o}");
    assert_eq!(sock_mode & 0o600, 0o600);
    snapshot_round_trip(&sock);
    let _ = thread;
}

#[test]
fn live_endpoint_is_refused() {
    let sock = unique_sock("live");
    let _ = std::fs::remove_file(&sock);
    let thread = spawn_server_at(sock.clone());
    assert!(wait_until(|| sock.exists()));
    let second = CoreServer::new(Store::open_in_memory().unwrap());
    let error = second.serve_unix_socket_at(&sock).unwrap_err();
    assert!(
        error.to_string().contains("refusing to replace")
            || error.to_string().contains("already owned"),
        "{error}"
    );
    snapshot_round_trip(&sock);
    let _ = thread;
}

#[test]
fn stale_endpoint_recovers_when_lock_is_free() {
    let sock = unique_sock("stale");
    let lock = PathBuf::from(format!("{}.lock", sock.display()));
    let _ = std::fs::remove_file(&sock);
    let _ = std::fs::remove_file(&lock);
    // Orphan sock file with no live owner and no held lock.
    std::fs::write(&sock, b"dead-sock-placeholder").unwrap();
    assert!(sock.exists());
    let thread = spawn_server_at(sock.clone());
    assert!(wait_until(|| {
        std::fs::metadata(&sock)
            .ok()
            .is_some_and(|meta| meta.file_type().is_socket())
    }));
    snapshot_round_trip(&sock);
    let _ = thread;
}

#[test]
fn ownership_lock_refuses_second_starter_without_unlinking_live() {
    let sock = unique_sock("race");
    let _ = std::fs::remove_file(&sock);
    let first = spawn_server_at(sock.clone());
    assert!(wait_until(|| sock.exists()));
    let inode_before = std::fs::metadata(&sock).unwrap().ino();
    let second = CoreServer::new(Store::open_in_memory().unwrap());
    let error = second.serve_unix_socket_at(&sock).unwrap_err();
    assert!(
        error.to_string().contains("already owned")
            || error.to_string().contains("refusing to replace"),
        "{error}"
    );
    let inode_after = std::fs::metadata(&sock).unwrap().ino();
    assert_eq!(inode_before, inode_after, "live sock must not be unlinked");
    snapshot_round_trip(&sock);
    let _ = first;
}

#[test]
fn distinct_endpoints_coexist() {
    let a = unique_sock("coexist-a");
    let b = unique_sock("coexist-b");
    let _ = std::fs::remove_file(&a);
    let _ = std::fs::remove_file(&b);
    let ta = spawn_server_at(a.clone());
    let tb = spawn_server_at(b.clone());
    assert!(wait_until(|| a.exists() && b.exists()));
    snapshot_round_trip(&a);
    snapshot_round_trip(&b);
    let _ = ta;
    let _ = tb;
}

#[test]
fn resolve_sanitizes_named_endpoints_under_runtime() {
    let path = resolve_unix_socket_path("goalport-core-v1").unwrap();
    assert!(
        path.ends_with("goalport-core-v1.sock"),
        "{}",
        path.display()
    );
    assert!(
        path.to_string_lossy().contains(".goalport/runtime/"),
        "{}",
        path.display()
    );
    let abs = resolve_unix_socket_path("/tmp/explicit.sock").unwrap();
    assert_eq!(abs, PathBuf::from("/tmp/explicit.sock"));
}

struct SpawnedCore(Child);

impl Drop for SpawnedCore {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}

/// Black-box: spawn the real `goalport-core` binary and exchange one framed IPC
/// request over the Unix socket. This is not a CoreServer-internal call.
#[test]
fn blackbox_serve_binary_round_trip() {
    let core = env!("CARGO_BIN_EXE_goalport-core");
    let dir = tempfile::tempdir().unwrap();
    let pipe = format!("bb-{}-{}", std::process::id(), unique_suffix());
    let db = dir.path().join("core.sqlite");
    let sock = dir
        .path()
        .join(".goalport")
        .join("runtime")
        .join(format!("{pipe}.sock"));
    let nonce = format!("linux-bb-{}", unique_suffix());
    let child = Command::new(core)
        .args(["serve", "--pipe", &pipe, "--db"])
        .arg(&db)
        .env_clear()
        .env("HOME", dir.path())
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("GOALPORT_REQUIRE_ISOLATED", "1")
        .env("GOALPORT_LAUNCH_NONCE", &nonce)
        .env("GOALPORT_RUN_SLUG", "goalport-linux-socket-bb")
        .env("GOALPORT_ELECTRON_PID", std::process::id().to_string())
        .env("GOALPORT_ELECTRON_CREATED_MS", "1")
        .env("GOALPORT_ELECTRON_EXE", "linux-socket-bb")
        .env("GOALPORT_ELECTRON_SHA256", "test-only")
        .env("GOALPORT_LAUNCHER_PID", std::process::id().to_string())
        .env("GOALPORT_LAUNCHER_CREATED_MS", "1")
        .env("GOALPORT_LAUNCHER_EXE", "linux-socket-bb")
        .env("GOALPORT_LAUNCHER_SHA256", "test-only")
        .env(
            "GOALPORT_LAUNCHER_PARENT_PID",
            std::process::id().to_string(),
        )
        .env("GOALPORT_LAUNCH_REQUESTED_AT", "2026-09-29T00:00:00.000Z")
        .env("GOALPORT_LAUNCHER_STARTED_AT", "2026-09-29T00:00:00.001Z")
        .env("GOALPORT_CORE_SPAWNED_AT", "2026-09-29T00:00:00.002Z")
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let mut core = SpawnedCore(child);
    let ready = PathBuf::from(format!("{}.launch-ready", db.display()));
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if let Ok(text) = std::fs::read_to_string(&ready) {
            if text.contains(&nonce) && text.contains("READY_COMMITTED") {
                break;
            }
        }
        if let Some(status) = core.0.try_wait().unwrap() {
            panic!("spawned Core exited before ready: {status}");
        }
        assert!(Instant::now() < deadline, "Core did not write launch-ready");
        std::thread::yield_now();
    }
    assert!(
        wait_until(|| sock.exists()),
        "socket missing at {}",
        sock.display()
    );
    let ready_json: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&ready).unwrap()).unwrap();
    assert_eq!(
        ready_json["pipeIdentity"].as_str().unwrap(),
        sock.display().to_string()
    );
    snapshot_round_trip(&sock);
}

fn unique_suffix() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos()
}
