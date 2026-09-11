#![cfg(windows)]

use std::{
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Command, Stdio},
};

#[test]
#[ignore = "requires the owner's installed native Codex subscription"]
fn rust_spawned_codex_app_server_emits_initialize() {
    let app_data = std::env::var_os("APPDATA").unwrap();
    let executable = PathBuf::from(app_data).join("npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe");
    let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../goal-runs/goalport-electron-stable-v1/fixtures/synthetic-workspace");
    let mut child = Command::new(executable)
        .args(["app-server", "--listen", "stdio://"])
        .current_dir(workspace)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .env_remove("OPENAI_API_KEY")
        .env_remove("ANTHROPIC_API_KEY")
        .env_remove("XAI_API_KEY")
        .spawn()
        .unwrap();
    let request = serde_json::json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"goalport-core","version":"test"},"capabilities":{"experimentalApi":false}}});
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(request.to_string().as_bytes())
        .unwrap();
    child.stdin.as_mut().unwrap().write_all(b"\n").unwrap();
    child.stdin.as_mut().unwrap().flush().unwrap();
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    assert!(line.contains("\"id\":1"), "response={line}");
    let _ = child.kill();
    let _ = child.wait();
}
