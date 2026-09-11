#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod core_client;

use core_client::{CoreConnection, CoreStatus, UiCommandRequest};
use serde_json::Value;
use std::process::{Command, Stdio};
use tauri::State;

#[tauri::command]
fn core_snapshot(core: State<'_, CoreConnection>) -> Result<Value, String> {
    core.snapshot()
}

#[tauri::command]
fn core_command(
    request: UiCommandRequest,
    core: State<'_, CoreConnection>,
) -> Result<Value, String> {
    core.command(request)
}

#[tauri::command]
fn core_status(core: State<'_, CoreConnection>) -> CoreStatus {
    core.status()
}

#[tauri::command]
fn start_core(core: State<'_, CoreConnection>) -> Result<CoreStatus, String> {
    core.ensure_started()
}

/// Launches the user's editor only. GoalPort does not edit files or start a
/// Runtime from this command; VS Code remains the editor boundary.
#[tauri::command]
fn open_in_vscode(workspace_root: String) -> Result<(), String> {
    let workspace_root = workspace_root.trim();
    if workspace_root.is_empty() {
        return Err("workspace_root is empty".into());
    }
    Command::new("code")
        .arg(workspace_root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("unable to launch VS Code: {error}"))
}

pub fn run() {
    tauri::Builder::default()
        .manage(CoreConnection::default())
        .invoke_handler(tauri::generate_handler![
            core_snapshot,
            core_command,
            core_status,
            start_core,
            open_in_vscode
        ])
        .run(tauri::generate_context!())
        .expect("error while running GoalPort desktop");
}

fn main() {
    run();
}
