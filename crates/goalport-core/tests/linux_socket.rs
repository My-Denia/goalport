#![cfg(target_os = "linux")]

use goalport_core::ipc::{
    LINUX_UNIX_SOCKET_PATH_MAX_BYTES, ResolvedUnixSocketPath, endpoint_socket_leaf_name,
    resolve_named_unix_socket, resolve_unix_socket_path,
};
use goalport_core::process_identity::{
    ProcessObservation, classify_linux_kill0_result, current_identity, observe_process,
};
use goalport_core::{CoreServer, IpcError, Store};
use std::io::{Read, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::os::unix::net::{UnixDatagram, UnixListener, UnixStream};
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
    spawn_core_binary_with_marker_fault(home, pipe, db, nonce, None)
}

fn spawn_core_binary_with_marker_fault(
    home: &Path,
    pipe: &str,
    db: &Path,
    nonce: &str,
    marker_fault: Option<&str>,
) -> SpawnedCore {
    use std::os::unix::process::CommandExt;

    let core = env!("CARGO_BIN_EXE_goalport-core");
    let mut command = Command::new(core);
    command
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
        .stderr(Stdio::inherit());
    if let Some(fault) = marker_fault {
        command.env("GOALPORT_TEST_SOCKET_MARKER_FAILURE", fault);
    }
    // The child's permissive mask proves the socket's 0600 mode comes from
    // the bind implementation rather than an inherited restrictive mask.
    unsafe {
        command.pre_exec(|| {
            libc::umask(0);
            Ok(())
        });
    }
    let child = command.spawn().unwrap();
    SpawnedCore(child)
}

#[test]
fn production_socket_round_trip_and_mode() {
    let sock = unique_sock("mode");
    let _ = std::fs::remove_file(&sock);
    let _ = std::fs::remove_file(format!("{}.lock", sock.display()));
    let thread = spawn_server_at(sock.clone());
    assert!(wait_until(|| UnixStream::connect(&sock).is_ok()));
    let sock_mode = std::fs::metadata(&sock).unwrap().permissions().mode();
    assert_eq!(sock_mode & 0o077, 0, "sock mode {sock_mode:#o}");
    assert_eq!(sock_mode & 0o600, 0o600);
    snapshot_round_trip(&sock);
    let _ = thread;
}

#[test]
fn idle_partial_frame_client_does_not_block_another_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("parallel.sock");
    let thread = spawn_server_at(sock.clone());
    assert!(wait_until(|| sock.exists()));
    let mut idle = UnixStream::connect(&sock).unwrap();
    idle.write_all(&[8, 0]).unwrap();

    let started = Instant::now();
    let mut second = UnixStream::connect(&sock).unwrap();
    second.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
    let payload = br#"{"protocol_version":"goalport.ipc.v2","message_type":"snapshot","request_id":"parallel","entity_version":1,"payload":{}}"#;
    second.write_all(&frame(payload)).unwrap();
    let mut header = [0u8; 4];
    second.read_exact(&mut header).unwrap();
    assert!(u32::from_le_bytes(header) > 0);
    assert!(started.elapsed() < Duration::from_secs(2));
    drop(idle);
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
    // A real GoalPort-owned orphan socket inode with a matching lock marker.
    let first = CoreServer::new(Store::open_in_memory().unwrap());
    drop(first.bind_unix_socket_at(&sock).unwrap());
    assert!(sock.exists());
    let thread = spawn_server_at(sock.clone());
    assert!(wait_until(|| UnixStream::connect(&sock).is_ok()));
    snapshot_round_trip(&sock);
    let _ = thread;
}

#[test]
fn foreign_stale_stream_socket_is_preserved_without_goalport_marker() {
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("foreign-stale.sock");
    drop(UnixListener::bind(&sock).unwrap());
    let before = std::fs::symlink_metadata(&sock).unwrap().ino();

    let server = CoreServer::new(Store::open_in_memory().unwrap());
    assert!(server.bind_unix_socket_at(&sock).is_err());
    assert_eq!(std::fs::symlink_metadata(&sock).unwrap().ino(), before);
}

#[test]
fn live_foreign_datagram_socket_keeps_its_inode_and_connectivity() {
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("foreign-datagram.sock");
    let live = UnixDatagram::bind(&sock).unwrap();
    live.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
    let before = std::fs::symlink_metadata(&sock).unwrap().ino();

    let server = CoreServer::new(Store::open_in_memory().unwrap());
    assert!(server.bind_unix_socket_at(&sock).is_err());
    assert_eq!(std::fs::symlink_metadata(&sock).unwrap().ino(), before);
    let client = UnixDatagram::unbound().unwrap();
    client.send_to(b"still-live", &sock).unwrap();
    let mut received = [0u8; 32];
    let (count, _) = live.recv_from(&mut received).unwrap();
    assert_eq!(&received[..count], b"still-live");
}

#[test]
fn non_socket_endpoint_inodes_are_refused_and_preserved() {
    use std::ffi::CString;
    use std::os::unix::fs::symlink;

    let dir = tempfile::tempdir().unwrap();
    let regular = dir.path().join("regular.sock");
    let directory = dir.path().join("directory.sock");
    let fifo = dir.path().join("fifo.sock");
    let link = dir.path().join("symlink.sock");
    std::fs::write(&regular, b"important contents").unwrap();
    std::fs::create_dir(&directory).unwrap();
    let fifo_c = CString::new(fifo.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(fifo_c.as_ptr(), 0o600) }, 0);
    symlink(&regular, &link).unwrap();

    let server = CoreServer::new(Store::open_in_memory().unwrap());
    for path in [&regular, &directory, &fifo, &link] {
        let before = std::fs::symlink_metadata(path).unwrap();
        let error = match server.bind_unix_socket_at(path) {
            Ok(_) => panic!("non-socket endpoint was bound: {}", path.display()),
            Err(error) => error,
        };
        assert!(
            error.to_string().contains("not a Unix socket"),
            "{}: {error}",
            path.display()
        );
        let after = std::fs::symlink_metadata(path).unwrap();
        assert_eq!(before.ino(), after.ino(), "{} inode changed", path.display());
        assert_eq!(before.file_type(), after.file_type());
    }
    assert_eq!(std::fs::read(&regular).unwrap(), b"important contents");
    assert_eq!(std::fs::read_link(&link).unwrap(), regular);
}

#[test]
fn lock_symlink_is_refused_without_changing_its_target() {
    use std::os::unix::fs::symlink;

    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("core.sock");
    let lock = PathBuf::from(format!("{}.lock", sock.display()));
    let victim = dir.path().join("important-script");
    std::fs::write(&victim, b"important contents").unwrap();
    let mut permissions = std::fs::metadata(&victim).unwrap().permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&victim, permissions).unwrap();
    symlink(&victim, &lock).unwrap();
    let before = std::fs::metadata(&victim).unwrap();

    let server = CoreServer::new(Store::open_in_memory().unwrap());
    assert!(server.bind_unix_socket_at(&sock).is_err());
    let after = std::fs::metadata(&victim).unwrap();
    assert_eq!(before.ino(), after.ino());
    assert_eq!(after.permissions().mode() & 0o777, 0o755);
    assert_eq!(std::fs::read(&victim).unwrap(), b"important contents");
    assert!(std::fs::symlink_metadata(&lock).unwrap().file_type().is_symlink());
    assert!(!sock.exists());
}

#[test]
fn existing_nonprivate_lock_is_refused_without_chmod() {
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("core.sock");
    let lock = PathBuf::from(format!("{}.lock", sock.display()));
    std::fs::write(&lock, b"existing lock contents").unwrap();
    let mut permissions = std::fs::metadata(&lock).unwrap().permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&lock, permissions).unwrap();
    let before = std::fs::metadata(&lock).unwrap();

    let server = CoreServer::new(Store::open_in_memory().unwrap());
    assert!(server.bind_unix_socket_at(&sock).is_err());
    let after = std::fs::metadata(&lock).unwrap();
    assert_eq!(before.ino(), after.ino());
    assert_eq!(after.permissions().mode() & 0o777, 0o755);
    assert_eq!(std::fs::read(&lock).unwrap(), b"existing lock contents");
    assert!(!sock.exists());
}

#[test]
fn lock_hardlink_is_refused_without_changing_its_target() {
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("core.sock");
    let lock = PathBuf::from(format!("{}.lock", sock.display()));
    let victim = dir.path().join("important-file");
    std::fs::write(&victim, b"important contents").unwrap();
    std::fs::hard_link(&victim, &lock).unwrap();
    let before = std::fs::metadata(&victim).unwrap();
    assert_eq!(before.nlink(), 2);

    let server = CoreServer::new(Store::open_in_memory().unwrap());
    assert!(server.bind_unix_socket_at(&sock).is_err());
    let after = std::fs::metadata(&victim).unwrap();
    assert_eq!(before.ino(), after.ino());
    assert_eq!(after.nlink(), 2);
    assert_eq!(std::fs::read(&victim).unwrap(), b"important contents");
    assert!(!sock.exists());
}

#[test]
fn blackbox_serve_refuses_regular_file_without_changing_contents_or_inode() {
    let dir = tempfile::tempdir().unwrap();
    let pipe = dir.path().join("important.sock");
    let db = dir.path().join("core.sqlite");
    std::fs::write(&pipe, b"important contents").unwrap();
    let inode_before = std::fs::symlink_metadata(&pipe).unwrap().ino();
    let mut core = spawn_core_binary(
        dir.path(),
        pipe.to_str().unwrap(),
        &db,
        "refuse-regular-file",
    );
    let deadline = Instant::now() + Duration::from_secs(15);
    let status = loop {
        if let Some(status) = core.0.try_wait().unwrap() {
            break status;
        }
        assert!(Instant::now() < deadline, "Core did not refuse regular file");
        std::thread::yield_now();
    };
    assert!(!status.success(), "Core must refuse a regular-file endpoint");
    assert_eq!(std::fs::read(&pipe).unwrap(), b"important contents");
    assert_eq!(std::fs::symlink_metadata(&pipe).unwrap().ino(), inode_before);
    let ready = PathBuf::from(format!("{}.launch-ready", db.display()));
    if ready.exists() {
        assert!(
            !std::fs::read_to_string(&ready)
                .unwrap()
                .contains("READY_COMMITTED"),
            "refused bind must not advertise readiness"
        );
    }
}

#[test]
fn blackbox_post_bind_marker_failure_removes_own_socket_and_lock() {
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("marker-failure.sock");
    let lock = PathBuf::from(format!("{}.lock", sock.display()));
    let db = dir.path().join("core.sqlite");
    let mut core = spawn_core_binary_with_marker_fault(
        dir.path(),
        sock.to_str().unwrap(),
        &db,
        "marker-failure",
        Some("after-bind"),
    );
    let deadline = Instant::now() + Duration::from_secs(15);
    let status = loop {
        if let Some(status) = core.0.try_wait().unwrap() {
            break status;
        }
        assert!(Instant::now() < deadline, "Core did not fail after marker fault");
        std::thread::yield_now();
    };
    assert!(!status.success());
    assert!(!sock.exists(), "failed bind must remove its own socket");
    assert!(!lock.exists(), "failed bind must remove its owned lock");
    let ready = PathBuf::from(format!("{}.launch-ready", db.display()));
    if ready.exists() {
        assert!(!std::fs::read_to_string(&ready).unwrap().contains("READY_COMMITTED"));
    }

    let server = CoreServer::new(Store::open_in_memory().unwrap());
    let owned = server.bind_unix_socket_at(&sock).unwrap();
    assert!(std::fs::symlink_metadata(&sock).unwrap().file_type().is_socket());
    drop(owned);
}

#[test]
fn blackbox_initial_marker_failure_removes_partial_lock_and_allows_retry() {
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("initial-marker-failure.sock");
    let lock = PathBuf::from(format!("{}.lock", sock.display()));
    let db = dir.path().join("core.sqlite");
    let mut core = spawn_core_binary_with_marker_fault(
        dir.path(),
        sock.to_str().unwrap(),
        &db,
        "initial-marker-failure",
        Some("initial"),
    );
    let deadline = Instant::now() + Duration::from_secs(15);
    let status = loop {
        if let Some(status) = core.0.try_wait().unwrap() {
            break status;
        }
        assert!(Instant::now() < deadline, "Core did not fail after initial marker fault");
        std::thread::yield_now();
    };
    assert!(!status.success());
    assert!(!sock.exists(), "initial marker failure must not bind a socket");
    assert!(!lock.exists(), "partial initial lock marker must be removed");

    let server = CoreServer::new(Store::open_in_memory().unwrap());
    let owned = server.bind_unix_socket_at(&sock).unwrap();
    assert!(std::fs::symlink_metadata(&sock).unwrap().file_type().is_socket());
    drop(owned);
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
fn resolve_uses_collision_resistant_leaf_under_runtime() {
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
fn hashed_mapping_separates_slash_and_question() {
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
fn python_client_rejects_explicit_empty_endpoint_even_with_overrides() {
    let script =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../scripts/connected/unix-client.py");
    let output = Command::new("python3")
        .arg(script)
        .arg("--resolve-only")
        .arg("")
        .env("GOALPORT_SOCK", "/tmp/wrong-core.sock")
        .env("GOALPORT_PIPE", "wrong-core")
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("Unix socket endpoint is empty"),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
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
fn managed_runtime_symlink_does_not_chmod_shared_target() {
    use std::os::unix::fs::symlink;

    let home = tempfile::tempdir().unwrap();
    let shared = tempfile::tempdir().unwrap();
    let managed = home.path().join(".goalport");
    std::fs::create_dir(&managed).unwrap();
    let mut permissions = std::fs::metadata(shared.path()).unwrap().permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(shared.path(), permissions).unwrap();
    symlink(shared.path(), managed.join("runtime")).unwrap();
    let before = std::fs::metadata(shared.path()).unwrap();

    let resolved = resolve_named_unix_socket(home.path(), "managed-symlink").unwrap();
    let server = CoreServer::new(Store::open_in_memory().unwrap());
    assert!(server.bind_resolved_unix_socket(&resolved).is_err());
    let after = std::fs::metadata(shared.path()).unwrap();
    assert_eq!(before.ino(), after.ino());
    assert_eq!(after.permissions().mode() & 0o777, 0o755);
    assert!(!shared.path().join(resolved.path.file_name().unwrap()).exists());
}

#[test]
fn managed_root_symlink_does_not_chmod_shared_runtime() {
    use std::os::unix::fs::symlink;

    let home = tempfile::tempdir().unwrap();
    let shared = tempfile::tempdir().unwrap();
    let runtime = shared.path().join("runtime");
    std::fs::create_dir(&runtime).unwrap();
    let mut permissions = std::fs::metadata(&runtime).unwrap().permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&runtime, permissions).unwrap();
    symlink(shared.path(), home.path().join(".goalport")).unwrap();
    let before = std::fs::metadata(&runtime).unwrap();

    let resolved = resolve_named_unix_socket(home.path(), "managed-root-symlink").unwrap();
    let server = CoreServer::new(Store::open_in_memory().unwrap());
    assert!(server.bind_resolved_unix_socket(&resolved).is_err());
    let after = std::fs::metadata(&runtime).unwrap();
    assert_eq!(before.ino(), after.ino());
    assert_eq!(after.permissions().mode() & 0o777, 0o755);
    assert!(!runtime.join(resolved.path.file_name().unwrap()).exists());
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

#[test]
fn linux_self_process_identity_remains_stable_between_observations() {
    let first = current_identity();
    std::thread::sleep(Duration::from_millis(2));
    let ProcessObservation::Live(second) = observe_process(first.pid) else {
        panic!("current process must remain observable as live");
    };
    assert_eq!(first.creation_date(), second.creation_date());
    assert!(first.creation_date().starts_with("/LinuxStart("));
    assert_eq!(first.executable_path, second.executable_path);
}

#[test]
fn linux_child_identity_is_observable_and_exit_is_distinct_from_unknown() {
    let mut child = SpawnedCore(Command::new("sleep")
        .arg("30")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn local sleep fixture"));
    let pid = child.0.id();
    let observation_started = Instant::now();
    let deadline = observation_started + Duration::from_secs(2);
    let first = loop {
        let observed = observe_process(pid);
        match observed {
            ProcessObservation::Live(identity)
                if std::path::Path::new(&identity.executable_path).file_name()
                    == Some(std::ffi::OsStr::new("sleep")) => break identity,
            observed => assert!(
                Instant::now() < deadline,
                "spawned sleep did not finish exec: pid={pid}, elapsed={:?}, last_observation={observed:?}, proc_exe={:?}",
                observation_started.elapsed(),
                std::fs::read_link(format!("/proc/{pid}/exe")),
            ),
        }
        std::thread::yield_now();
    };
    assert_eq!(first.parent_pid, std::process::id());
    assert!(first.created_ms > 0);
    assert!(!first.executable_sha256.is_empty());
    let second = match observe_process(pid) {
        ProcessObservation::Live(identity) => identity,
        observed => panic!("same child must still be live: {observed:?}"),
    };
    assert_eq!(first.pid, second.pid);
    assert_eq!(first.parent_pid, second.parent_pid);
    assert_eq!(first.creation_date(), second.creation_date());
    assert_eq!(first.executable_path, second.executable_path);
    assert_eq!(first.executable_sha256, second.executable_sha256);
    child.0.kill().unwrap();
    child.0.wait().unwrap();
    assert_eq!(observe_process(pid), ProcessObservation::NotRunning);
}

#[test]
fn linux_zombie_is_not_reported_as_live() {
    let mut child = SpawnedCore(Command::new("true").spawn().expect("spawn local true fixture"));
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if observe_process(child.0.id()) == ProcessObservation::NotRunning {
            break;
        }
        assert!(Instant::now() < deadline, "child did not reach zombie state");
        std::thread::yield_now();
    }
    child.0.wait().unwrap();
}

#[test]
fn restrictive_umask_refuses_before_creating_socket_state() {
    use std::os::unix::process::CommandExt;

    const CHILD: &str = "GOALPORT_RESTRICTIVE_UMASK_CHILD";
    const ROOT: &str = "GOALPORT_RESTRICTIVE_UMASK_ROOT";
    if std::env::var_os(CHILD).is_some() {
        let root = PathBuf::from(std::env::var_os(ROOT).unwrap());
        let server = CoreServer::new(Store::open_in_memory().unwrap());
        for path in [root.join("fresh.sock"), root.join("existing.sock")] {
            let error = match server.bind_unix_socket_at(&path) {
                Ok(_) => panic!("restrictive umask unexpectedly bound {}", path.display()),
                Err(error) => error,
            };
            assert!(error.to_string().contains("umask"), "{error}");
        }
        let named = resolve_named_unix_socket(&root, "named").unwrap();
        let error = match server.bind_resolved_unix_socket(&named) {
            Ok(_) => panic!("restrictive umask unexpectedly bound named endpoint"),
            Err(error) => error,
        };
        assert!(error.to_string().contains("umask"), "{error}");
        return;
    }

    let root = tempfile::tempdir().unwrap();
    let existing = root.path().join("existing.sock");
    let lock = PathBuf::from(format!("{}.lock", existing.display()));
    let server = CoreServer::new(Store::open_in_memory().unwrap());
    drop(server.bind_unix_socket_at(&existing).unwrap());
    let inode_before = std::fs::symlink_metadata(&existing).unwrap().ino();
    let lock_before = std::fs::read(&lock).unwrap();

    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args(["--exact", "restrictive_umask_refuses_before_creating_socket_state"])
        .env(CHILD, "1")
        .env(ROOT, root.path());
    unsafe {
        command.pre_exec(|| {
            libc::umask(0o777);
            Ok(())
        });
    }
    let output = command.output().unwrap();
    assert!(
        output.status.success(),
        "child failed: {} {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!root.path().join("fresh.sock").exists());
    assert!(!root.path().join("fresh.sock.lock").exists());
    assert!(!root.path().join(".goalport").exists());
    assert_eq!(std::fs::symlink_metadata(&existing).unwrap().ino(), inode_before);
    assert_eq!(std::fs::read(&lock).unwrap(), lock_before);
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
    assert_eq!(
        std::fs::metadata(&sock).unwrap().permissions().mode() & 0o777,
        0o600,
        "socket mode must stay private even with child umask 000"
    );
    let ready_json: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&ready).unwrap()).unwrap();
    assert_eq!(
        ready_json["pipeIdentity"].as_str().unwrap(),
        sock.display().to_string()
    );
    snapshot_round_trip(&sock);
}

#[test]
fn pipe_peer_reads_the_serving_process() {
    let sock = unique_sock("pipe-peer");
    let _server = spawn_server_at(sock.clone());
    assert!(wait_until(|| sock.exists()), "socket was not bound");
    let peer = goalport_core::ipc::verify_pipe_peer(sock.to_str().unwrap()).unwrap();
    assert_eq!(peer.server_pid, std::process::id());
}

fn unique_suffix() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos()
}
