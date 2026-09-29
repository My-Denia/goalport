#![cfg(target_os = "linux")]

use goalport_core::ipc::{
    LINUX_UNIX_SOCKET_PATH_MAX_BYTES, ResolvedUnixSocketPath, endpoint_socket_leaf_name,
    resolve_named_unix_socket, resolve_unix_socket_path,
};
use goalport_core::process_identity::{ProcessObservation, classify_linux_kill0_result};
use goalport_core::{CoreServer, IpcError, Store};
use std::io::{Read, Write};
use std::os::unix::ffi::OsStrExt;
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

fn python_resolve(home: &Path, endpoint: &str) -> String {
    let script =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../scripts/connected/unix-client.py");
    let output = Command::new("python3")
        .arg(&script)
        .arg("--resolve-only")
        .arg(endpoint)
        .env("HOME", home)
        .env_remove("GOALPORT_SOCK")
        .env_remove("GOALPORT_PIPE")
        .output()
        .expect("python resolve");
    assert!(
        output.status.success(),
        "python resolve failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().to_string()
}

fn spawn_core_binary(home: &Path, pipe: &str, db: &Path, nonce: &str) -> SpawnedCore {
    let core = env!("CARGO_BIN_EXE_goalport-core");
    let child = Command::new(core)
        .args(["serve", "--pipe", pipe, "--db"])
        .arg(db)
        .env_clear()
        .env("HOME", home)
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("GOALPORT_REQUIRE_ISOLATED", "1")
        .env("GOALPORT_LAUNCH_NONCE", nonce)
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
    SpawnedCore(child)
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
fn resolve_uses_injective_leaf_under_runtime() {
    let home = tempfile::tempdir().unwrap();
    let resolved = resolve_named_unix_socket(home.path(), "goalport-core-v1").unwrap();
    assert!(resolved.managed_runtime_parent);
    let leaf = resolved
        .path
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    assert!(
        leaf.starts_with("goalport-core-v1--") && leaf.ends_with(".sock"),
        "{leaf}"
    );
    assert!(
        resolved
            .path
            .starts_with(home.path().join(".goalport").join("runtime")),
        "{}",
        resolved.path.display()
    );
    let abs = resolve_unix_socket_path("/tmp/explicit.sock").unwrap();
    assert_eq!(abs, PathBuf::from("/tmp/explicit.sock"));
}

#[test]
fn injective_mapping_separates_slash_and_question() {
    let parent = PathBuf::from("/home/user/.goalport/runtime");
    let a = endpoint_socket_leaf_name("a/b", &parent).unwrap();
    let b = endpoint_socket_leaf_name("a?b", &parent).unwrap();
    assert_ne!(a, b);
    assert!(a.starts_with("a_b--"));
    assert!(b.starts_with("a_b--"));
}

#[test]
fn unicode_endpoint_rust_and_python_agree() {
    let home = tempfile::tempdir().unwrap();
    let endpoint = "café";
    let rust = resolve_named_unix_socket(home.path(), endpoint).unwrap();
    let py = python_resolve(home.path(), endpoint);
    assert_eq!(rust.path.display().to_string(), py);
    let leaf = rust.path.file_name().unwrap().to_string_lossy();
    assert!(leaf.starts_with("caf_--"), "{leaf}");
}

#[test]
fn long_endpoint_fits_or_rejects_without_silent_collision() {
    let home = tempfile::tempdir().unwrap();
    let dir = home.path().join(".goalport").join("runtime");
    let short = "ok-endpoint";
    let leaf = endpoint_socket_leaf_name(short, &dir).unwrap();
    let path = dir.join(&leaf);
    assert!(path.as_os_str().as_bytes().len() <= LINUX_UNIX_SOCKET_PATH_MAX_BYTES);

    let long = "x".repeat(300);
    let long_leaf = endpoint_socket_leaf_name(&long, &dir).unwrap();
    let long_path = dir.join(&long_leaf);
    assert!(long_path.as_os_str().as_bytes().len() <= LINUX_UNIX_SOCKET_PATH_MAX_BYTES);
    // Distinct originals must not collapse to the same leaf.
    let other = format!("{long}y");
    let other_leaf = endpoint_socket_leaf_name(&other, &dir).unwrap();
    assert_ne!(long_leaf, other_leaf);

    // Absolute path over capacity is rejected (no silent truncate).
    let oversized = format!("/{}", "p".repeat(LINUX_UNIX_SOCKET_PATH_MAX_BYTES));
    assert!(oversized.as_bytes().len() > LINUX_UNIX_SOCKET_PATH_MAX_BYTES);
    let err = resolve_unix_socket_path(&oversized).unwrap_err();
    assert!(err.to_string().contains("sun_path capacity"), "{err}");
}

#[test]
fn explicit_absolute_goalport_parent_perms_unchanged() {
    let root = tempfile::tempdir().unwrap();
    let parent = root
        .path()
        .join("srv")
        .join("shared")
        .join(".goalport")
        .join("runtime");
    std::fs::create_dir_all(&parent).unwrap();
    let mut perms = std::fs::metadata(&parent).unwrap().permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(&parent, perms).unwrap();
    let mode_before = std::fs::metadata(&parent).unwrap().permissions().mode() & 0o777;

    let sock = parent.join("core.sock");
    let resolved = ResolvedUnixSocketPath {
        path: sock.clone(),
        managed_runtime_parent: false,
    };
    let server = CoreServer::new(Store::open_in_memory().unwrap());
    let owned = server.bind_resolved_unix_socket(&resolved).unwrap();
    let mode_after = std::fs::metadata(&parent).unwrap().permissions().mode() & 0o777;
    assert_eq!(
        mode_before, mode_after,
        "explicit .goalport parent must not be chmod'd"
    );
    assert!(sock.exists());
    drop(owned);
}

#[test]
fn occupied_endpoint_does_not_leave_ready_committed() {
    let home = tempfile::tempdir().unwrap();
    let pipe = format!("occupy-{}-{}", std::process::id(), unique_suffix());
    let db1 = home.path().join("first.sqlite");
    let db2 = home.path().join("second.sqlite");
    let nonce1 = format!("occupy-first-{}", unique_suffix());
    let nonce2 = format!("occupy-second-{}", unique_suffix());
    let sock = resolve_named_unix_socket(home.path(), &pipe).unwrap().path;

    let mut first = spawn_core_binary(home.path(), &pipe, &db1, &nonce1);
    let ready1 = PathBuf::from(format!("{}.launch-ready", db1.display()));
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if let Ok(text) = std::fs::read_to_string(&ready1) {
            if text.contains(&nonce1) && text.contains("READY_COMMITTED") {
                break;
            }
        }
        if let Some(status) = first.0.try_wait().unwrap() {
            panic!("first Core exited before ready: {status}");
        }
        assert!(
            Instant::now() < deadline,
            "first Core did not write launch-ready"
        );
        std::thread::yield_now();
    }
    assert!(wait_until(|| sock.exists()));

    let mut second = spawn_core_binary(home.path(), &pipe, &db2, &nonce2);
    let ready2 = PathBuf::from(format!("{}.launch-ready", db2.display()));
    let exit_deadline = Instant::now() + Duration::from_secs(15);
    let status = loop {
        if let Some(status) = second.0.try_wait().unwrap() {
            break status;
        }
        assert!(
            Instant::now() < exit_deadline,
            "second Core should exit after bind refusal"
        );
        std::thread::yield_now();
    };
    assert!(
        !status.success(),
        "second Core must fail when endpoint occupied"
    );
    if ready2.exists() {
        let text = std::fs::read_to_string(&ready2).unwrap();
        assert!(
            !text.contains("READY_COMMITTED"),
            "occupied bind must not leave READY_COMMITTED: {text}"
        );
    }
}

#[test]
fn linux_kill0_classification_fail_closed() {
    assert!(matches!(
        classify_linux_kill0_result(42, Ok(())),
        ProcessObservation::Unknown(_)
    ));
    assert_eq!(
        classify_linux_kill0_result(42, Err(libc::ESRCH)),
        ProcessObservation::NotRunning
    );
    assert!(matches!(
        classify_linux_kill0_result(42, Err(libc::EPERM)),
        ProcessObservation::Unknown(_)
    ));
    assert!(matches!(
        classify_linux_kill0_result(42, Err(libc::EIO)),
        ProcessObservation::Unknown(_)
    ));
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
    let dir = tempfile::tempdir().unwrap();
    let pipe = format!("bb-{}-{}", std::process::id(), unique_suffix());
    let db = dir.path().join("core.sqlite");
    let sock = resolve_named_unix_socket(dir.path(), &pipe).unwrap().path;
    let nonce = format!("linux-bb-{}", unique_suffix());
    let mut core = spawn_core_binary(dir.path(), &pipe, &db, &nonce);
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
