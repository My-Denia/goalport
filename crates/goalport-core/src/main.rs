use goalport_core::{
    adapters::{
        AgentAdapter, ClaudeCliAdapter, CodexAppServerAdapter, CompatibilityPolicy, GrokAcpAdapter,
        ScenarioAdapter,
    },
    ipc::CoreServer,
    product_receipts,
    store::Store,
};
use serde_json::json;
use std::{env, path::PathBuf, process::ExitCode};

/// Exit code of `pipe-peer` for every verification failure.
const PIPE_PEER_FAILURE_EXIT: u8 = 3;
const PIPE_PEER_SCHEMA: &str = "goalport.pipe-peer.v1";

fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("pipe-peer") {
        return pipe_peer(&args[1..]);
    }
    if args.first().map(String::as_str) == Some("profile") {
        return profile(&args[1..]);
    }
    match run(args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("goalport-core: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run(args: Vec<String>) -> Result<(), String> {
    let Some(command) = args.first().map(String::as_str) else {
        print_usage();
        return Ok(());
    };
    match command {
        "--version" | "-V" => {
            println!("goalport-core {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        "serve" => serve(&args[1..]),
        "preflight" => preflight(&args[1..]),
        "scenario" => Err(
            "the scenario command was retired; use targeted tests and runtime or desktop verification"
                .into(),
        ),
        "status" => status(&args[1..]),
        "--help" | "-h" | "help" => {
            print_usage();
            Ok(())
        }
        unknown => Err(format!("unknown subcommand {unknown}; use --help")),
    }
}

fn serve(args: &[String]) -> Result<(), String> {
    let pipe_arg = option(args, "--pipe").unwrap_or_else(|| "goalport-core-v1".into());
    #[cfg(windows)]
    let pipe = pipe_arg;
    #[cfg(target_os = "linux")]
    let resolved =
        goalport_core::ipc::resolve_unix_socket(&pipe_arg).map_err(|error| error.to_string())?;
    #[cfg(target_os = "linux")]
    let pipe = resolved.path.display().to_string();
    #[cfg(not(any(windows, target_os = "linux")))]
    let pipe = pipe_arg;
    let db = PathBuf::from(option(args, "--db").unwrap_or_else(|| "goalport.sqlite".into()));
    let store = Store::open(&db).map_err(|error| error.to_string())?;
    let epoch = product_receipts::begin_startup_epoch(&store, &pipe, &db)?;
    let server = CoreServer::new(store.clone());

    // Linux: bind and hold the socket BEFORE READY_COMMITTED so a failed bind
    // (endpoint occupied) never leaves a launch-ready file advertising ready.
    #[cfg(target_os = "linux")]
    let owned = match server.bind_resolved_unix_socket(&resolved) {
        Ok(owned) => owned,
        Err(error) => {
            let message = error.to_string();
            return Err(abort_startup_after_failure(&store, &epoch, &db, message));
        }
    };

    let reconciled = (|| {
        let commands_unknown = server
            .reconcile_after_restart()
            .map_err(|error| error.to_string())?;
        let outbox_unknown = server
            .processor()
            .store()
            .mark_dispatching_outbox_unknown()
            .map_err(|error| error.to_string())?;
        let leases_uncertain = server
            .processor()
            .store()
            .mark_active_leases_uncertain()
            .map_err(|error| error.to_string())?;
        let reconciliation = json!({
            "status": "completed",
            "commandsUnknown": commands_unknown,
            "outboxUnknown": outbox_unknown,
            "leasesUncertain": leases_uncertain,
            "runtimeAttachment": "UNKNOWN_OR_UNSUPPORTED",
            "promptReplay": false,
            "completedAtUtc": goalport_core::store::utc_now_iso(),
        });
        product_receipts::complete_startup_epoch(&store, &pipe, &db, &epoch, &reconciliation)?;
        Ok::<(), String>(())
    })();
    if let Err(error) = reconciled {
        return Err(abort_startup_after_failure(&store, &epoch, &db, error));
    }
    #[cfg(windows)]
    {
        match server.serve_named_pipe(&pipe) {
            Ok(()) => Ok(()),
            Err(error) => {
                let message = error.to_string();
                Err(abort_startup_after_failure(&store, &epoch, &db, message))
            }
        }
    }
    #[cfg(target_os = "linux")]
    {
        match server.serve_owned_unix_socket(owned) {
            Ok(()) => Ok(()),
            Err(error) => {
                let message = error.to_string();
                Err(abort_startup_after_failure(&store, &epoch, &db, message))
            }
        }
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        let _ = pipe;
        let message = goalport_core::ipc::IpcError::UnixSocketUnsupported.to_string();
        Err(abort_startup_after_failure(&store, &epoch, &db, message))
    }
}

fn abort_startup_after_failure(
    store: &Store,
    epoch: &product_receipts::StartupEpochClaim,
    db: &std::path::Path,
    message: String,
) -> String {
    match product_receipts::fail_startup_epoch_clearing_ready(store, epoch, &message, Some(db)) {
        Ok(()) => message,
        Err(cleanup_error) => format!("{message}; startup cleanup failed: {cleanup_error}"),
    }
}

/// `profile inspect|backup|import|recovery-probe|verify-source|verify-staging …`:
/// startup-continuity storage operations.
/// Never migrates a database. Output contract: exactly one JSON line on
/// stdout; success exits 0, failure exits 3 with `{ok:false, stage, error}`.
fn profile(args: &[String]) -> ExitCode {
    use goalport_core::profile_ops;
    let Some(command) = args.first().map(String::as_str) else {
        println!(
            "{{\"schema\":\"{}\",\"ok\":false,\"stage\":\"usage\",\"error\":\"profile requires inspect|backup|import|recovery-probe|verify-source|verify-staging\"}}",
            profile_ops::PROFILE_OPS_SCHEMA
        );
        return ExitCode::from(profile_ops::PROFILE_OPS_FAILURE_EXIT);
    };
    let flags = |name: &str| -> Option<String> {
        option(args, name).or_else(|| {
            if args.iter().any(|arg| arg == name) {
                Some(String::new())
            } else {
                None
            }
        })
    };
    let result: Result<serde_json::Value, String> = match command {
        "inspect" => match option(args, "--db") {
            Some(db) => profile_ops::inspect(&PathBuf::from(db), flags("--quick-check").is_some()),
            None => Err("profile inspect requires --db".into()),
        },
        "backup" => match (option(args, "--db"), option(args, "--out")) {
            (Some(db), Some(out)) => profile_ops::backup(
                &PathBuf::from(db),
                &PathBuf::from(out),
                flags("--allow-write-open").is_some(),
            ),
            _ => Err("profile backup requires --db and --out".into()),
        },
        "import" => match (option(args, "--source-db"), option(args, "--staging-dir")) {
            (Some(source), Some(staging)) => {
                let provenance = option(args, "--provenance")
                    .and_then(|raw| serde_json::from_str(&raw).ok())
                    .unwrap_or(serde_json::json!(null));
                if flags("--allow-source-recovery").is_some() {
                    profile_ops::import(&PathBuf::from(source), &PathBuf::from(staging), &provenance, true)
                } else {
                    match (
                        option(args, "--operation-id"),
                        option(args, "--source-marker-sha256"),
                        option(args, "--provenance-sha256"),
                    ) {
                        (Some(operation_id), Some(marker), Some(provenance_sha)) => profile_ops::import_bound(
                            &PathBuf::from(source),
                            &PathBuf::from(staging),
                            &provenance,
                            &operation_id,
                            &marker,
                            &provenance_sha,
                        ),
                        (None, None, None) => profile_ops::import(
                            &PathBuf::from(source),
                            &PathBuf::from(staging),
                            &provenance,
                            false,
                        ),
                        _ => Err("bound profile import requires --operation-id, --source-marker-sha256 and --provenance-sha256 together".into()),
                    }
                }
            }
            _ => Err("profile import requires --source-db and --staging-dir".into()),
        },
        "recovery-probe" => match (
            option(args, "--source-db"),
            option(args, "--staging-dir"),
            option(args, "--operation-id"),
            option(args, "--source-marker-sha256"),
            option(args, "--provenance-sha256"),
        ) {
            (Some(source), Some(staging), Some(operation_id), Some(marker), Some(provenance)) => profile_ops::recovery_probe(
                &PathBuf::from(source),
                &PathBuf::from(staging),
                &operation_id,
                &marker,
                &provenance,
            ),
            _ => Err("profile recovery-probe requires --source-db, --staging-dir, --operation-id, --source-marker-sha256 and --provenance-sha256".into()),
        },
        "verify-source" => match (
            option(args, "--source-db"),
            option(args, "--expected-source-snapshot-token"),
        ) {
            (Some(source), Some(token)) => profile_ops::verify_source(&PathBuf::from(source), &token),
            _ => Err("profile verify-source requires --source-db and --expected-source-snapshot-token".into()),
        },
        "verify-staging" => match (
            option(args, "--staging-dir"),
            option(args, "--expected-operation-id"),
            option(args, "--expected-proof-token"),
            option(args, "--expected-source-binding-sha256"),
        ) {
            (Some(staging), Some(operation_id), Some(proof), Some(binding)) => profile_ops::verify_staging(
                &PathBuf::from(staging),
                &operation_id,
                &proof,
                &binding,
            ),
            _ => Err("profile verify-staging requires --staging-dir, --expected-operation-id, --expected-proof-token and --expected-source-binding-sha256".into()),
        },
        unknown => Err(format!("unknown profile subcommand {unknown}; use inspect|backup|import|recovery-probe|verify-source|verify-staging")),
    };
    match result {
        Ok(mut value) => {
            value["ok"] = serde_json::json!(true);
            println!("{}", value);
            ExitCode::SUCCESS
        }
        Err(error) => {
            println!(
                "{{\"schema\":\"{}\",\"ok\":false,\"stage\":\"profile\",\"error\":{}}}",
                profile_ops::PROFILE_OPS_SCHEMA,
                serde_json::to_string(&error).unwrap_or_else(|_| "\"error\"".into())
            );
            ExitCode::from(profile_ops::PROFILE_OPS_FAILURE_EXIT)
        }
    }
}

/// `pipe-peer --pipe NAME`: authenticate the server of a Core pipe without
/// opening a Store, writing a receipt or sending a frame. Stdout is exactly one
/// JSON line; success exits 0, any failure exits 3.
fn pipe_peer(args: &[String]) -> ExitCode {
    let result = match option(args, "--pipe").filter(|name| !name.trim().is_empty()) {
        Some(name) => goalport_core::ipc::verify_pipe_peer(&name).map_err(|error| match error {
            goalport_core::IpcError::PipeSecurity { stage, code } => (stage, code),
            _ => ("open", 50),
        }),
        // ERROR_INVALID_PARAMETER: no pipe to open.
        None => Err(("open", 87)),
    };
    match result {
        Ok(peer) => {
            // Fixed key order; every value is a number or a fixed ASCII token.
            println!(
                "{{\"schema\":\"{PIPE_PEER_SCHEMA}\",\"ok\":true,\"serverPid\":{}}}",
                peer.server_pid
            );
            ExitCode::SUCCESS
        }
        Err((stage, code)) => {
            println!(
                "{{\"schema\":\"{PIPE_PEER_SCHEMA}\",\"ok\":false,\"stage\":\"{stage}\",\"code\":{code}}}"
            );
            ExitCode::from(PIPE_PEER_FAILURE_EXIT)
        }
    }
}

fn preflight(args: &[String]) -> Result<(), String> {
    let provider = option(args, "--provider")
        .unwrap_or_else(|| "scenario".into())
        .to_ascii_lowercase();
    let executable =
        PathBuf::from(option(args, "--executable").unwrap_or_else(|| provider.clone()));
    let version = option(args, "--version").unwrap_or_else(|| "unknown".into());
    let workspace = PathBuf::from(option(args, "--workspace").unwrap_or_else(|| ".".into()));
    let result = match provider.as_str() {
        "codex" => {
            let mut adapter = CodexAppServerAdapter::new(executable, version, workspace);
            adapter
                .preflight(CompatibilityPolicy::Compatible)
                .map_err(|error| error.to_string())?
        }
        "grok" => {
            let mut adapter = GrokAcpAdapter::new(executable, version, workspace);
            adapter
                .preflight(CompatibilityPolicy::Compatible)
                .map_err(|error| error.to_string())?
        }
        "claude" => {
            let mut adapter = ClaudeCliAdapter::new(executable, version, workspace);
            adapter
                .preflight(CompatibilityPolicy::Compatible)
                .map_err(|error| error.to_string())?
        }
        "scenario" => {
            let mut adapter = ScenarioAdapter::new("scenario");
            adapter
                .preflight(CompatibilityPolicy::Compatible)
                .map_err(|error| error.to_string())?
        }
        _ => return Err(format!("unsupported provider {provider}")),
    };
    println!(
        "{}",
        serde_json::to_string_pretty(&result).map_err(|error| error.to_string())?
    );
    Ok(())
}

fn status(args: &[String]) -> Result<(), String> {
    let db = PathBuf::from(option(args, "--db").unwrap_or_else(|| "goalport.sqlite".into()));
    let store = Store::open(db).map_err(|error| error.to_string())?;
    let counts = store.counts().map_err(|error| error.to_string())?;
    println!(
        "{}",
        serde_json::to_string_pretty(&counts).map_err(|error| error.to_string())?
    );
    Ok(())
}

fn option(args: &[String], key: &str) -> Option<String> {
    args.windows(2)
        .find(|pair| pair[0] == key)
        .map(|pair| pair[1].clone())
}

fn print_usage() {
    println!(
        "goalport-core v1\n\nUSAGE:\n  goalport-core serve [--pipe NAME] [--db PATH]\n  goalport-core pipe-peer --pipe NAME\n  goalport-core preflight --provider PROVIDER [--executable PATH] [--version VERSION] [--workspace PATH]\n  goalport-core status [--db PATH]"
    );
}
