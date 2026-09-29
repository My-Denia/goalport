#![cfg(unix)]

use goalport_core::{CoreServer, Store};
use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::time::{Duration, Instant};

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

#[test]
fn production_socket_round_trip_and_mode() {
    let home = std::env::temp_dir().join(format!("goalport-home-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).unwrap();
    unsafe { std::env::set_var("HOME", &home); }
    let server = CoreServer::new(Store::open_in_memory().unwrap());
    let thread = std::thread::spawn(move || server.serve_unix_socket());
    let sock = home.join(".goalport/runtime/core.sock");
    assert!(wait_until(|| sock.exists()));
    let dir_mode = std::fs::metadata(sock.parent().unwrap()).unwrap().permissions().mode();
    let sock_mode = std::fs::metadata(&sock).unwrap().permissions().mode();
    eprintln!("dir_mode={dir_mode:#o} sock_mode={sock_mode:#o}");
    assert_eq!(dir_mode & 0o077, 0, "dir mode {dir_mode:#o}");
    assert_eq!(sock_mode & 0o077, 0, "sock mode {sock_mode:#o}");
    assert_eq!(dir_mode & 0o700, 0o700);
    assert_eq!(sock_mode & 0o600, 0o600);
    let mut client = UnixStream::connect(&sock).unwrap();
    let payload = br#"{"protocol_version":"goalport.ipc.v2","message_type":"snapshot","request_id":"t","entity_version":1,"payload":{}}"#;
    client.write_all(&frame(payload)).unwrap();
    let mut header = [0u8; 4];
    client.read_exact(&mut header).unwrap();
    assert!(u32::from_le_bytes(header) > 0);
    drop(client);
    let _ = thread;
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn live_socket_is_not_replaced() {
    let home = std::env::temp_dir().join(format!("goalport-home-live-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).unwrap();
    unsafe { std::env::set_var("HOME", &home); }
    let first = CoreServer::new(Store::open_in_memory().unwrap());
    let thread = std::thread::spawn(move || first.serve_unix_socket());
    let sock = home.join(".goalport/runtime/core.sock");
    assert!(wait_until(|| sock.exists()));
    let second = CoreServer::new(Store::open_in_memory().unwrap());
    let error = second.serve_unix_socket().unwrap_err();
    assert!(error.to_string().contains("refusing to replace"));
    let _ = thread;
    let _ = std::fs::remove_dir_all(&home);
}
