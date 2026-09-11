use goalport_core::{
    Attempt, AttemptState, CoreCommand, CoreOperation, CoreServer, IpcError, IpcRequest, Store,
};
use std::io::Cursor;

fn server() -> CoreServer {
    let store = Store::open_in_memory().unwrap();
    store
        .insert_attempt(&Attempt::new("attempt", "task", "scenario", "cap-v1"))
        .unwrap();
    CoreServer::new(store)
}

fn request(id: &str, command_id: &str, event_id: &str, state: AttemptState) -> IpcRequest {
    IpcRequest::new(
        id,
        CoreCommand::new(
            command_id,
            "attempt",
            CoreOperation::TransitionAttempt {
                attempt_id: "attempt".into(),
                state,
                event_id: event_id.into(),
            },
        )
        .unwrap(),
    )
}

#[test]
fn handshake_rejects_protocol_mismatch() {
    let server = server();
    let mut request = request("request", "command", "event", AttemptState::Active);
    request.protocol_version = "future".into();
    assert!(!server.handle(request).ok);
}

#[test]
fn request_id_is_returned_in_response() {
    let response = server().handle(request(
        "request-identity",
        "command",
        "event",
        AttemptState::Active,
    ));
    assert_eq!(response.request_id, "request-identity");
}

#[test]
fn entity_version_is_returned_in_response() {
    let response = server().handle(request(
        "request-version",
        "command",
        "event",
        AttemptState::Active,
    ));
    assert_eq!(response.entity_version, 1);
}

#[test]
fn duplicate_request_is_marked_without_second_event() {
    let server = server();
    let request = request("duplicate", "command", "event", AttemptState::Active);
    assert!(server.handle(request.clone()).ok);
    assert!(server.handle(request).duplicate);
}

#[test]
fn malformed_frame_is_rejected() {
    let error = goalport_core::ipc::decode_frame::<IpcRequest>(&[0, 0, 0, 0, 1]).unwrap_err();
    assert!(matches!(error, IpcError::TruncatedFrame));
}

#[test]
fn oversized_frame_is_rejected() {
    let mut frame = vec![0xff; 4];
    frame.extend_from_slice(&[0; 4]);
    assert!(matches!(
        goalport_core::ipc::decode_frame::<IpcRequest>(&frame),
        Err(IpcError::FrameTooLarge(_)) | Err(IpcError::TruncatedFrame)
    ));
}

#[test]
fn stream_transport_returns_one_response_per_request() {
    let server = server();
    let first = goalport_core::ipc::encode_frame(&request(
        "stream",
        "command",
        "event",
        AttemptState::Active,
    ))
    .unwrap();
    let mut input = Cursor::new(first);
    let mut output = Cursor::new(Vec::new());
    assert_eq!(server.serve_stream(&mut input, &mut output).unwrap(), 1);
    assert!(!output.get_ref().is_empty());
}

#[test]
fn ui_loss_does_not_replay_committed_command() {
    let server = server();
    let request = request("reconnect", "command", "event", AttemptState::Active);
    let first = server.handle(request.clone());
    let second = server.handle(request);
    assert!(first.ok);
    assert!(second.duplicate);
}

#[cfg(windows)]
#[test]
fn named_pipe_client_round_trips_to_detached_core_server() {
    use goalport_core::ipc::{IpcClient, NamedPipeClient};
    use std::{
        thread,
        time::{Duration, SystemTime, UNIX_EPOCH},
    };

    let name = format!(
        "goalport-ipc-test-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let server = server();
    let server_name = name.clone();
    let server_thread = thread::spawn(move || server.serve_named_pipe_once(&server_name));
    let mut client = None;
    for _ in 0..100 {
        match NamedPipeClient::connect(&name) {
            Ok(connection) => {
                client = Some(connection);
                break;
            }
            Err(_) => thread::sleep(Duration::from_millis(10)),
        }
    }
    let connection = client.expect("named pipe server did not accept a client");
    let mut client = IpcClient::new(connection);
    let response = client
        .request(request(
            "named-pipe",
            "named-command",
            "named-event",
            AttemptState::Active,
        ))
        .unwrap();
    assert!(response.ok);
    drop(client);
    assert_eq!(server_thread.join().unwrap().unwrap(), 1);
}

#[cfg(windows)]
#[test]
fn named_pipe_accepts_the_desktop_snapshot_wire_shape() {
    use goalport_core::ipc::{NamedPipeClient, decode_frame, read_frame, write_frame};
    use serde_json::{Value, json};
    use std::{
        thread,
        time::{Duration, SystemTime, UNIX_EPOCH},
    };

    let name = format!(
        "goalport-ui-wire-test-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let server = server();
    let server_name = name.clone();
    let server_thread = thread::spawn(move || server.serve_named_pipe_once(&server_name));
    let mut connection = None;
    for _ in 0..100 {
        match NamedPipeClient::connect(&name) {
            Ok(client) => {
                connection = Some(client);
                break;
            }
            Err(_) => thread::sleep(Duration::from_millis(10)),
        }
    }
    let mut connection = connection.expect("named pipe server did not accept a UI client");
    write_frame(
        &mut connection,
        &json!({
            "protocolVersion": "goalport.ipc.v1",
            "requestId": "desktop-snapshot",
            "entityVersion": 0,
            "messageType": "snapshot",
            "payload": {}
        }),
    )
    .unwrap();
    let frame = read_frame(&mut connection)
        .unwrap()
        .expect("Core returned no UI response");
    let response: Value = decode_frame(&frame).unwrap();
    assert_eq!(response["ok"], true);
    assert_eq!(response["requestId"], "desktop-snapshot");
    assert!(response["payload"]["attempts"].is_number());
    drop(connection);
    assert_eq!(server_thread.join().unwrap().unwrap(), 1);
}
