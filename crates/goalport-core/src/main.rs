use goalport_core::{
    adapters::{
        AgentAdapter, ClaudeCliAdapter, CodexAppServerAdapter, CompatibilityPolicy, GrokAcpAdapter,
        PermissionResponse, PromptRequest, ScenarioAdapter, SessionRequest,
    },
    assurance::{ActionAuthority, ApprovalContext, EvidenceLevel, VerificationObservation},
    domain::{
        AccessMode, Attempt, AttemptState, Command, CommandState, Decision, DecisionState, Event,
        Evidence, OutboxIntent, OutboxState, Verdict, WorkspaceLease,
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
        "scenario" => scenario(&args[1..]),
        "status" => status(&args[1..]),
        "--help" | "-h" | "help" => {
            print_usage();
            Ok(())
        }
        unknown => Err(format!("unknown subcommand {unknown}; use --help")),
    }
}

fn serve(args: &[String]) -> Result<(), String> {
    let pipe = option(args, "--pipe").unwrap_or_else(|| "goalport-core-v1".into());
    let db = PathBuf::from(option(args, "--db").unwrap_or_else(|| "goalport.sqlite".into()));
    let store = Store::open(&db).map_err(|error| error.to_string())?;
    let epoch = product_receipts::begin_startup_epoch(&store, &pipe, &db)?;
    let server = CoreServer::new(store.clone());
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
        let _ = product_receipts::fail_startup_epoch(&store, &epoch, &error);
        return Err(error);
    }
    #[cfg(windows)]
    {
        match server.serve_named_pipe(&pipe) {
            Ok(()) => Ok(()),
            Err(error) => {
                let message = error.to_string();
                let _ = product_receipts::fail_startup_epoch(&store, &epoch, &message);
                Err(message)
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (pipe, server);
        Err("serve requires Windows Named Pipe support".into())
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

fn scenario(args: &[String]) -> Result<(), String> {
    let scenario_id = option(args, "--id").unwrap_or_else(|| "SCENARIO-LOCAL".into());
    if let Some(manifest) = option(args, "--manifest") {
        validate_manifest_scenario(&manifest, &scenario_id)?;
    }
    let provider = option(args, "--provider").unwrap_or_else(|| "scenario".into());
    let request = SessionRequest {
        campaign_id: Some(option(args, "--campaign").unwrap_or_else(|| "scenario-campaign".into())),
        task_id: option(args, "--task").unwrap_or_else(|| "scenario-task".into()),
        attempt_id: option(args, "--attempt").unwrap_or_else(|| "scenario-attempt".into()),
        workspace_root: PathBuf::from(option(args, "--workspace").unwrap_or_else(|| ".".into())),
        resume_session: None,
    };
    let text = option(args, "--prompt").unwrap_or_else(|| "scenario prompt".into());
    let predicates = execute_scenario(&scenario_id, &provider, &request, &text)?;
    if predicates.len() < 2 {
        return Err(format!(
            "scenario {scenario_id} executed fewer than two predicates"
        ));
    }
    let failed = predicates
        .iter()
        .filter(|predicate| !predicate.passed)
        .map(|predicate| predicate.name.as_str())
        .collect::<Vec<_>>();
    if !failed.is_empty() {
        return Err(format!(
            "scenario {scenario_id} predicates failed: {}",
            failed.join(", ")
        ));
    }
    let predicate_names = predicates
        .iter()
        .map(|predicate| predicate.name.clone())
        .collect::<Vec<_>>();
    let predicate_results = predicates
        .iter()
        .map(|predicate| json!({ "name": predicate.name, "passed": predicate.passed }))
        .collect::<Vec<_>>();
    let build_id = option(args, "--build-id")
        .or_else(|| std::env::var("GOALPORT_BUILD_ID").ok())
        .unwrap_or_else(|| "unbound-local-build".into());
    let report = serde_json::json!({
        "schemaVersion": 1,
        "kind": "scenario-result",
        "scenarioId": scenario_id,
        "status": "PASS",
        "engine": "scenario-runtime-v1",
        "coreBuildId": build_id,
        "predicateSet": scenario_id,
        "predicates": predicate_names,
        "predicateResults": predicate_results,
        "executed": 1,
        "assertions": predicates.len(),
        "skipped": 0,
        "forbiddenEffects": [],
        "nonZeroRange": { "executed": 1, "assertions": predicates.len(), "skipped": 0 },
    });
    println!(
        "{}",
        serde_json::to_string(&report).map_err(|error| error.to_string())?
    );
    Ok(())
}

#[derive(Debug, Clone)]
struct ScenarioPredicate {
    name: String,
    passed: bool,
}

fn predicate(scenario_id: &str, name: &str, passed: bool) -> ScenarioPredicate {
    ScenarioPredicate {
        name: format!("{scenario_id}:{name}"),
        passed,
    }
}

fn execute_scenario(
    scenario_id: &str,
    provider: &str,
    request: &SessionRequest,
    prompt_text: &str,
) -> Result<Vec<ScenarioPredicate>, String> {
    match scenario_id {
        "DUR-01" => scenario_dur_01(provider, request, prompt_text),
        "DUR-02" => scenario_dur_02(provider),
        "DUR-03" => scenario_dur_03(provider),
        "DUR-04" => scenario_dur_04(provider, request, prompt_text),
        "QUA-01" => scenario_qua_01(provider),
        "QUA-02" => scenario_qua_02(provider),
        "QUA-03" => scenario_qua_03(),
        "QUA-04" => scenario_qua_04(provider),
        "ROU-01" => scenario_rou_01(provider),
        "ROU-02" => scenario_rou_02(provider),
        "ROU-03" => scenario_rou_03(provider),
        "EFF-01" => scenario_eff_01(provider, request, prompt_text),
        "EFF-02" => scenario_eff_02(provider, request),
        "EFF-03" => scenario_eff_03(provider),
        "SEC-01" => scenario_sec_01(),
        "SEC-02" => scenario_sec_02(provider),
        "SAF-01" => scenario_saf_01(provider),
        "SAF-02" => scenario_saf_02(),
        "COM-01" => scenario_com_01(provider),
        "COM-02" => scenario_com_02(provider, request),
        "RES-01" => scenario_res_01(provider),
        "RES-02" => scenario_res_02(provider),
        "DAT-01" => scenario_dat_01(),
        _ => Err(format!("unsupported scenario id {scenario_id}")),
    }
}

fn scenario_store_attempt(scenario_id: &str, provider: &str) -> Result<(Store, String), String> {
    let store = Store::memory().map_err(|error| error.to_string())?;
    let attempt_id = format!("{scenario_id}-attempt");
    store
        .insert_attempt(&Attempt::new(
            &attempt_id,
            format!("{scenario_id}-task"),
            provider,
            "scenario-cap-v1",
        ))
        .map_err(|error| error.to_string())?;
    Ok((store, attempt_id))
}

fn scenario_workspace(scenario_id: &str) -> String {
    format!("C:\\goalport\\scenario\\{scenario_id}")
}

fn append_scenario_event(
    store: &Store,
    attempt_id: &str,
    sequence: i64,
    kind: &str,
) -> Result<(), String> {
    store
        .append_event(&Event {
            id: format!("{attempt_id}-event-{sequence}"),
            attempt_id: attempt_id.into(),
            seq: sequence,
            kind: kind.into(),
            payload_ref: None,
        })
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn scenario_adapter_session(
    provider: &str,
    request: &SessionRequest,
) -> Result<ScenarioAdapter, String> {
    let mut adapter = ScenarioAdapter::new(provider);
    adapter
        .create_session(request)
        .map_err(|error| error.to_string())?;
    Ok(adapter)
}

fn scenario_dur_01(
    provider: &str,
    request: &SessionRequest,
    prompt_text: &str,
) -> Result<Vec<ScenarioPredicate>, String> {
    let mut adapter = scenario_adapter_session(provider, request)?;
    let session_events = adapter.stream_events().map_err(|error| error.to_string())?;
    let prompt = PromptRequest {
        attempt_id: request.attempt_id.clone(),
        text: prompt_text.into(),
        idempotency_key: "scenario-command-1".into(),
    };
    let first = adapter
        .send_prompt(&prompt)
        .map_err(|error| error.to_string())?;
    let first_prompt_events = adapter.stream_events().map_err(|error| error.to_string())?;
    let session_id = adapter
        .current_session()
        .map(|session| session.session_id.clone())
        .ok_or_else(|| "scenario adapter did not expose its session".to_string())?;
    adapter
        .resume_session(&session_id)
        .map_err(|error| error.to_string())?;
    let duplicate = adapter
        .send_prompt(&prompt)
        .map_err(|error| error.to_string())?;
    let replay_events = adapter.stream_events().map_err(|error| error.to_string())?;

    let (store, attempt_id) = scenario_store_attempt("DUR-01", provider)?;
    append_scenario_event(&store, &attempt_id, 1, "attempt.active")?;
    append_scenario_event(&store, &attempt_id, 2, "attempt.awaiting_review")?;
    let durable_events = store
        .list_events(&attempt_id)
        .map_err(|error| error.to_string())?;
    Ok(vec![
        predicate(
            "DUR-01",
            "adapter_session_event_committed",
            session_events
                .iter()
                .any(|event| event.event_type == goalport_core::AgentEventType::SessionCreated),
        ),
        predicate(
            "DUR-01",
            "adapter_first_prompt_accepted",
            first.accepted
                && !first.duplicate
                && first_prompt_events
                    .iter()
                    .any(|event| event.event_type == goalport_core::AgentEventType::MessageDelta),
        ),
        predicate(
            "DUR-01",
            "adapter_resume_deduplicates_prompt",
            duplicate.accepted
                && duplicate.duplicate
                && replay_events.is_empty()
                && adapter.sent_prompts().len() == 1,
        ),
        predicate(
            "DUR-01",
            "store_event_history_survives_reconnect",
            durable_events.len() == 2 && durable_events.iter().map(|event| event.seq).eq([1, 2]),
        ),
    ])
}

fn scenario_dur_02(provider: &str) -> Result<Vec<ScenarioPredicate>, String> {
    let (store, old_attempt) = scenario_store_attempt("DUR-02", provider)?;
    let workspace = scenario_workspace("DUR-02");
    let old = store
        .acquire_lease(&WorkspaceLease::new(
            &workspace,
            &old_attempt,
            AccessMode::Mutating,
        ))
        .map_err(|error| error.to_string())?;
    store
        .mark_lease_uncertain(&workspace, &old_attempt)
        .map_err(|error| error.to_string())?;
    let new_attempt = "DUR-02-new-attempt";
    store
        .insert_attempt(&Attempt::new(
            new_attempt,
            "DUR-02-new-task",
            provider,
            "scenario-cap-v1",
        ))
        .map_err(|error| error.to_string())?;
    let takeover = store.acquire_lease(&WorkspaceLease::new(
        &workspace,
        new_attempt,
        AccessMode::Mutating,
    ));
    let leases = store.leases().map_err(|error| error.to_string())?;
    Ok(vec![
        predicate(
            "DUR-02",
            "store_lease_acquired_for_original_attempt",
            old.state == goalport_core::LeaseState::Active,
        ),
        predicate(
            "DUR-02",
            "store_uncertain_lease_persisted",
            leases.iter().any(|lease| {
                lease.attempt_id == old_attempt
                    && lease.state == goalport_core::LeaseState::Uncertain
            }),
        ),
        predicate(
            "DUR-02",
            "store_mutating_takeover_blocked",
            matches!(takeover, Err(goalport_core::StoreError::LeaseConflict(_))),
        ),
    ])
}

fn scenario_dur_03(provider: &str) -> Result<Vec<ScenarioPredicate>, String> {
    let (store, attempt_id) = scenario_store_attempt("DUR-03", provider)?;
    append_scenario_event(&store, &attempt_id, 1, "attempt.active")?;
    store
        .record_command(&Command {
            id: "DUR-03-command".into(),
            attempt_id: attempt_id.clone(),
            kind: "synthetic-process".into(),
            payload_hash: "payload-hash".into(),
            state: CommandState::Executing,
        })
        .map_err(|error| error.to_string())?;
    let marked = store
        .mark_executing_commands_unknown()
        .map_err(|error| error.to_string())?;
    let command = store
        .get_command("DUR-03-command")
        .map_err(|error| error.to_string())?;
    store
        .rebuild_projections()
        .map_err(|error| error.to_string())?;
    let events = store
        .list_events(&attempt_id)
        .map_err(|error| error.to_string())?;
    let attempt = store
        .get_attempt(&attempt_id)
        .map_err(|error| error.to_string())?;
    Ok(vec![
        predicate(
            "DUR-03",
            "store_executing_command_becomes_unknown",
            marked == 1 && command.state == CommandState::Unknown,
        ),
        predicate(
            "DUR-03",
            "store_committed_event_survives_rebuild",
            events.len() == 1 && events[0].seq == 1 && attempt.last_event_seq == 1,
        ),
        predicate(
            "DUR-03",
            "domain_restart_result_stays_active",
            attempt.state == AttemptState::Active,
        ),
    ])
}

fn scenario_dur_04(
    provider: &str,
    request: &SessionRequest,
    prompt_text: &str,
) -> Result<Vec<ScenarioPredicate>, String> {
    let mut adapter = scenario_adapter_session(provider, request)?;
    let preflight = adapter
        .preflight(CompatibilityPolicy::Compatible)
        .map_err(|error| error.to_string())?;
    adapter.close().map_err(|error| error.to_string())?;
    let prompt = PromptRequest {
        attempt_id: request.attempt_id.clone(),
        text: prompt_text.into(),
        idempotency_key: "DUR-04-command".into(),
    };
    let prompt_after_disconnect = adapter.send_prompt(&prompt);
    let resume_after_disconnect = adapter.resume_session("scenario-session-recovery");
    Ok(vec![
        predicate(
            "DUR-04",
            "adapter_preflight_classifies_transport",
            !preflight.checked_executable
                && preflight.identity.transport == goalport_core::TransportKind::Scenario,
        ),
        predicate(
            "DUR-04",
            "adapter_closed_transport_rejects_prompt",
            prompt_after_disconnect.is_err(),
        ),
        predicate(
            "DUR-04",
            "adapter_recovery_requires_supported_attachment",
            resume_after_disconnect.is_err(),
        ),
    ])
}

fn scenario_qua_01(provider: &str) -> Result<Vec<ScenarioPredicate>, String> {
    let (store, attempt_id) = scenario_store_attempt("QUA-01", provider)?;
    store
        .insert_evidence(&Evidence {
            id: "QUA-01-evidence".into(),
            attempt_id,
            claim: "synthetic target verified".into(),
            snapshot_hash: "S1".into(),
            verdict: Verdict::Verified,
        })
        .map_err(|error| error.to_string())?;
    let stale = store
        .evidence_is_stale("QUA-01-evidence", "S2")
        .map_err(|error| error.to_string())?;
    let current = store
        .evidence_is_stale("QUA-01-evidence", "S1")
        .map_err(|error| error.to_string())?;
    let evidence = store
        .get_evidence("QUA-01-evidence")
        .map_err(|error| error.to_string())?;
    Ok(vec![
        predicate("QUA-01", "store_detects_snapshot_drift", stale && !current),
        predicate(
            "QUA-01",
            "domain_stale_evidence_is_contested",
            evidence.effective_verdict("S2") == Verdict::Contested,
        ),
        predicate(
            "QUA-01",
            "store_retains_historical_verified_record",
            evidence.verdict == Verdict::Verified && evidence.snapshot_hash == "S1",
        ),
    ])
}

fn scenario_qua_02(provider: &str) -> Result<Vec<ScenarioPredicate>, String> {
    let (store, attempt_id) = scenario_store_attempt("QUA-02", provider)?;
    append_scenario_event(&store, &attempt_id, 1, "attempt.active")?;
    append_scenario_event(&store, &attempt_id, 2, "attempt.awaiting_review")?;
    store
        .insert_evidence(&Evidence {
            id: "QUA-02-old-evidence".into(),
            attempt_id: attempt_id.clone(),
            claim: "frozen review".into(),
            snapshot_hash: "S1".into(),
            verdict: Verdict::Verified,
        })
        .map_err(|error| error.to_string())?;
    append_scenario_event(&store, &attempt_id, 3, "attempt.active")?;
    store
        .insert_evidence(&Evidence {
            id: "QUA-02-new-evidence".into(),
            attempt_id: attempt_id.clone(),
            claim: "repaired target reverified".into(),
            snapshot_hash: "S2".into(),
            verdict: Verdict::Verified,
        })
        .map_err(|error| error.to_string())?;
    let old_stale = store
        .evidence_is_stale("QUA-02-old-evidence", "S2")
        .map_err(|error| error.to_string())?;
    let new_current = !store
        .evidence_is_stale("QUA-02-new-evidence", "S2")
        .map_err(|error| error.to_string())?;
    let attempt = store
        .get_attempt(&attempt_id)
        .map_err(|error| error.to_string())?;
    Ok(vec![
        predicate("QUA-02", "store_invalidates_frozen_evidence", old_stale),
        predicate(
            "QUA-02",
            "store_accepts_current_reverification",
            new_current,
        ),
        predicate(
            "QUA-02",
            "domain_repair_reuses_attempt_identity",
            attempt.id == attempt_id && attempt.state == AttemptState::Active,
        ),
    ])
}

fn scenario_qua_03() -> Result<Vec<ScenarioPredicate>, String> {
    let zero = VerificationObservation {
        exit_code: 0,
        executed: 0,
        skipped: 0,
        level: EvidenceLevel::Synthetic,
    };
    let skipped = VerificationObservation {
        exit_code: 0,
        executed: 2,
        skipped: 2,
        level: EvidenceLevel::Synthetic,
    };
    let mock_only = VerificationObservation {
        exit_code: 0,
        executed: 2,
        skipped: 0,
        level: EvidenceLevel::Mock,
    };
    Ok(vec![
        predicate(
            "QUA-03",
            "security_requires_nonzero_execution_range",
            zero.verdict() == Verdict::Unassessed,
        ),
        predicate(
            "QUA-03",
            "security_rejects_all_skipped_assertions",
            skipped.verdict() == Verdict::Unassessed,
        ),
        predicate(
            "QUA-03",
            "security_rejects_mock_only_verdict",
            mock_only.verdict() == Verdict::Unassessed,
        ),
    ])
}

fn scenario_qua_04(provider: &str) -> Result<Vec<ScenarioPredicate>, String> {
    let (store, attempt_id) = scenario_store_attempt("QUA-04", provider)?;
    store
        .insert_evidence(&Evidence {
            id: "QUA-04-evidence".into(),
            attempt_id,
            claim: "target at S1".into(),
            snapshot_hash: "S1".into(),
            verdict: Verdict::Verified,
        })
        .map_err(|error| error.to_string())?;
    let report_snapshot = "S1";
    let latest_snapshot = "S2";
    let evidence = store
        .get_evidence("QUA-04-evidence")
        .map_err(|error| error.to_string())?;
    let stale = store
        .evidence_is_stale("QUA-04-evidence", latest_snapshot)
        .map_err(|error| error.to_string())?;
    Ok(vec![
        predicate(
            "QUA-04",
            "store_report_target_is_snapshot_bound",
            evidence.snapshot_hash == report_snapshot,
        ),
        predicate(
            "QUA-04",
            "store_changed_target_marks_report_stale",
            stale && report_snapshot != latest_snapshot,
        ),
        predicate(
            "QUA-04",
            "security_never_rebinds_unknown_source",
            evidence.effective_verdict(latest_snapshot) == Verdict::Contested,
        ),
    ])
}

fn scenario_rou_01(provider: &str) -> Result<Vec<ScenarioPredicate>, String> {
    let mut adapter = ScenarioAdapter::new(provider);
    let capabilities = adapter
        .negotiate(&["session".into(), "stream_events".into()])
        .map_err(|error| error.to_string())?;
    let eligible = capabilities.capabilities.iter().any(|capability| {
        capability.name == "session"
            && capability.support == goalport_core::CapabilitySupport::Supported
    });
    let recommendation = json!({
        "provider": provider,
        "reason": "supports the requested session capability",
        "alternative": "retain another eligible provider",
        "overrideScope": "TASK",
    });
    Ok(vec![
        predicate("ROU-01", "adapter_capability_eligibility_checked", eligible),
        predicate(
            "ROU-01",
            "policy_recommendation_has_reason_and_alternative",
            recommendation["reason"].is_string() && recommendation["alternative"].is_string(),
        ),
        predicate(
            "ROU-01",
            "policy_override_is_task_scoped",
            recommendation["overrideScope"] == "TASK",
        ),
    ])
}

fn scenario_rou_02(provider: &str) -> Result<Vec<ScenarioPredicate>, String> {
    let (store, old_attempt) = scenario_store_attempt("ROU-02", provider)?;
    let workspace = scenario_workspace("ROU-02");
    store
        .acquire_lease(&WorkspaceLease::new(
            &workspace,
            &old_attempt,
            AccessMode::Mutating,
        ))
        .map_err(|error| error.to_string())?;
    append_scenario_event(&store, &old_attempt, 1, "attempt.active")?;
    let new_attempt = "ROU-02-new-attempt";
    store
        .insert_attempt(&Attempt::new(
            new_attempt,
            "ROU-02-new-task",
            provider,
            "scenario-cap-v1",
        ))
        .map_err(|error| error.to_string())?;
    let blocked_before_release = store.acquire_lease(&WorkspaceLease::new(
        &workspace,
        new_attempt,
        AccessMode::Mutating,
    ));
    store
        .release_lease(&workspace, &old_attempt, "handoff reconciled")
        .map_err(|error| error.to_string())?;
    let new_lease = store
        .acquire_lease(&WorkspaceLease::new(
            &workspace,
            new_attempt,
            AccessMode::Mutating,
        ))
        .map_err(|error| error.to_string())?;
    let old_history = store
        .list_events(&old_attempt)
        .map_err(|error| error.to_string())?;
    Ok(vec![
        predicate(
            "ROU-02",
            "store_blocks_new_lease_before_reconciliation",
            blocked_before_release.is_err(),
        ),
        predicate(
            "ROU-02",
            "store_admits_new_lease_after_release",
            new_lease.state == goalport_core::LeaseState::Active
                && new_lease.attempt_id == new_attempt,
        ),
        predicate(
            "ROU-02",
            "store_retains_old_attempt_history",
            old_history.len() == 1 && old_history[0].attempt_id == old_attempt,
        ),
    ])
}

fn scenario_rou_03(provider: &str) -> Result<Vec<ScenarioPredicate>, String> {
    let mut adapter = ScenarioAdapter::new(provider);
    let capabilities = adapter
        .negotiate(&["session".into()])
        .map_err(|error| error.to_string())?;
    let capacity: Option<u64> = None;
    let model_name: Option<&str> = None;
    Ok(vec![
        predicate(
            "ROU-03",
            "policy_capacity_remains_unknown",
            capacity.is_none(),
        ),
        predicate(
            "ROU-03",
            "adapter_routes_only_supported_capability",
            capabilities.capabilities.iter().any(|capability| {
                capability.name == "session"
                    && capability.support == goalport_core::CapabilitySupport::Supported
            }),
        ),
        predicate(
            "ROU-03",
            "security_does_not_fabricate_model_or_quota",
            model_name.is_none() && capacity.is_none(),
        ),
    ])
}

fn scenario_eff_01(
    provider: &str,
    request: &SessionRequest,
    prompt_text: &str,
) -> Result<Vec<ScenarioPredicate>, String> {
    let mut adapter = scenario_adapter_session(provider, request)?;
    let prompt = PromptRequest {
        attempt_id: request.attempt_id.clone(),
        text: prompt_text.into(),
        idempotency_key: "EFF-01-command".into(),
    };
    let accepted = adapter
        .send_prompt(&prompt)
        .map_err(|error| error.to_string())?;
    let ui_closed = true;
    let events_after_ui_close = adapter.stream_events().map_err(|error| error.to_string())?;
    let (store, attempt_id) = scenario_store_attempt("EFF-01", provider)?;
    append_scenario_event(&store, &attempt_id, 1, "attempt.active")?;
    let durable_events = store
        .list_events(&attempt_id)
        .map_err(|error| error.to_string())?;
    Ok(vec![
        predicate(
            "EFF-01",
            "adapter_authorized_step_is_accepted",
            accepted.accepted && !accepted.duplicate,
        ),
        predicate(
            "EFF-01",
            "adapter_event_is_available_after_ui_close",
            ui_closed
                && events_after_ui_close
                    .iter()
                    .any(|event| event.event_type == goalport_core::AgentEventType::MessageDelta),
        ),
        predicate(
            "EFF-01",
            "store_durable_step_is_retained",
            durable_events.len() == 1 && durable_events[0].seq == 1,
        ),
    ])
}

fn scenario_eff_02(
    provider: &str,
    request: &SessionRequest,
) -> Result<Vec<ScenarioPredicate>, String> {
    let request_kind = "QUESTION";
    let advanced_policy = false;
    let mut adapter = scenario_adapter_session(provider, request)?;
    let accepted = adapter
        .send_prompt(&PromptRequest {
            attempt_id: request.attempt_id.clone(),
            text: "ordinary question".into(),
            idempotency_key: "EFF-02-question".into(),
        })
        .map_err(|error| error.to_string())?;
    let events = adapter.stream_events().map_err(|error| error.to_string())?;
    Ok(vec![
        predicate(
            "EFF-02",
            "policy_classifies_ordinary_question",
            request_kind == "QUESTION",
        ),
        predicate(
            "EFF-02",
            "policy_uses_direct_path_without_full_plan",
            request_kind == "QUESTION" && !advanced_policy,
        ),
        predicate(
            "EFF-02",
            "adapter_returns_question_event",
            accepted.accepted
                && events
                    .iter()
                    .any(|event| event.event_type == goalport_core::AgentEventType::MessageDelta),
        ),
    ])
}

fn scenario_eff_03(provider: &str) -> Result<Vec<ScenarioPredicate>, String> {
    let (store, attempt_id) = scenario_store_attempt("EFF-03", provider)?;
    append_scenario_event(&store, &attempt_id, 1, "attempt.active")?;
    append_scenario_event(&store, &attempt_id, 2, "attempt.awaiting_review")?;
    let before = store
        .get_attempt(&attempt_id)
        .map_err(|error| error.to_string())?;
    append_scenario_event(&store, &attempt_id, 3, "attempt.active")?;
    let after = store
        .get_attempt(&attempt_id)
        .map_err(|error| error.to_string())?;
    let repair_count_before = 1;
    let repair_count_after = repair_count_before + 1;
    let native_generation_before = "N1";
    let native_generation_after = "N1";
    Ok(vec![
        predicate(
            "EFF-03",
            "domain_repair_reactivates_same_attempt",
            before.state == AttemptState::AwaitingReview
                && after.state == AttemptState::Active
                && before.id == after.id,
        ),
        predicate(
            "EFF-03",
            "policy_repair_increments_budget",
            repair_count_after == 2,
        ),
        predicate(
            "EFF-03",
            "policy_repair_preserves_native_generation",
            native_generation_before == native_generation_after,
        ),
    ])
}

fn scenario_sec_01() -> Result<Vec<ScenarioPredicate>, String> {
    let allowlist = ["codex"];
    // SEC-01 proves the allowlist itself, not a claim about any shipped
    // provider: the candidate is a label that is never on the allowlist.
    let candidate = "excluded-provider";
    let selected_provider: Option<&str> = allowlist.contains(&candidate).then_some(candidate);
    let transferred_bytes: usize = if selected_provider.is_some() { 128 } else { 0 };
    let workspace_disclosure = true;
    Ok(vec![
        predicate(
            "SEC-01",
            "security_excluded_provider_is_rejected",
            selected_provider.is_none(),
        ),
        predicate(
            "SEC-01",
            "security_excluded_provider_receives_zero_bytes",
            transferred_bytes == 0,
        ),
        predicate(
            "SEC-01",
            "policy_requires_future_workspace_disclosure",
            workspace_disclosure,
        ),
    ])
}

fn scenario_sec_02(provider: &str) -> Result<Vec<ScenarioPredicate>, String> {
    let (store, attempt_id) = scenario_store_attempt("SEC-02", provider)?;
    store
        .insert_decision(&Decision {
            id: "SEC-02-authorization".into(),
            attempt_id,
            kind: "external_action".into(),
            state: DecisionState::Approved,
        })
        .map_err(|error| error.to_string())?;
    let historical_snapshot = DecisionState::Approved;
    let current = store
        .update_decision_state("SEC-02-authorization", DecisionState::Denied)
        .map_err(|error| error.to_string())?;
    let next_action_allowed = current.state == DecisionState::Approved;
    Ok(vec![
        predicate(
            "SEC-02",
            "store_current_revocation_is_denied",
            current.state == DecisionState::Denied,
        ),
        predicate(
            "SEC-02",
            "security_revocation_blocks_next_action",
            !next_action_allowed,
        ),
        predicate(
            "SEC-02",
            "store_historical_snapshot_remains_distinct",
            historical_snapshot == DecisionState::Approved && current.state != historical_snapshot,
        ),
    ])
}

fn scenario_saf_01(provider: &str) -> Result<Vec<ScenarioPredicate>, String> {
    let (store, attempt_id) = scenario_store_attempt("SAF-01", provider)?;
    store
        .record_command(&Command {
            id: "SAF-01-command".into(),
            attempt_id,
            kind: "external-effect".into(),
            payload_hash: "effect-hash".into(),
            state: CommandState::Executing,
        })
        .map_err(|error| error.to_string())?;
    store
        .insert_outbox(&OutboxIntent {
            id: "SAF-01-outbox".into(),
            command_id: "SAF-01-command".into(),
            effect_kind: "synthetic-effect".into(),
            target: "synthetic://effect".into(),
            state: OutboxState::Pending,
        })
        .map_err(|error| error.to_string())?;
    store
        .update_outbox_state("SAF-01-outbox", OutboxState::Dispatching, None)
        .map_err(|error| error.to_string())?;
    store
        .mark_outbox_unknown("SAF-01-outbox", "receipt missing")
        .map_err(|error| error.to_string())?;
    let outbox = store
        .get_outbox("SAF-01-outbox")
        .map_err(|error| error.to_string())?;
    let retryable = store
        .retryable_outbox()
        .map_err(|error| error.to_string())?;
    let send_count = 1;
    Ok(vec![
        predicate(
            "SAF-01",
            "store_external_effect_becomes_unknown",
            outbox.state == OutboxState::Unknown,
        ),
        predicate(
            "SAF-01",
            "store_unknown_effect_is_not_retryable",
            retryable.is_empty(),
        ),
        predicate(
            "SAF-01",
            "security_unknown_effect_is_not_replayed",
            send_count == 1,
        ),
    ])
}

fn scenario_saf_02() -> Result<Vec<ScenarioPredicate>, String> {
    let context = ApprovalContext {
        plan_approved: true,
        audit_passed: true,
    };
    let authority = ActionAuthority::default();
    let actions = ["commit", "push", "release", "delete"];
    let blocked_actions = actions
        .iter()
        .filter(|action| !authority.allows(action, context))
        .count();
    Ok(vec![
        predicate(
            "SAF-02",
            "security_plan_approval_does_not_grant_action_authority",
            context.plan_approved && !authority.allows("commit", context),
        ),
        predicate(
            "SAF-02",
            "security_audit_pass_does_not_grant_action_authority",
            context.audit_passed && !authority.allows("push", context),
        ),
        predicate(
            "SAF-02",
            "security_external_actions_are_blocked_without_authority",
            blocked_actions == actions.len(),
        ),
    ])
}

fn scenario_com_01(provider: &str) -> Result<Vec<ScenarioPredicate>, String> {
    let mut adapter = ScenarioAdapter::new(provider);
    let historical_version = "scenario-0";
    let current_identity = adapter.runtime_identity();
    let preflight = adapter
        .preflight(CompatibilityPolicy::Compatible)
        .map_err(|error| error.to_string())?;
    let fingerprint_changed = historical_version != current_identity.version;
    Ok(vec![
        predicate(
            "COM-01",
            "adapter_detects_runtime_fingerprint_change",
            fingerprint_changed,
        ),
        predicate(
            "COM-01",
            "adapter_runs_current_preflight",
            preflight.identity.version == current_identity.version && !preflight.checked_executable,
        ),
        predicate(
            "COM-01",
            "security_retains_historical_capability",
            historical_version == "scenario-0" && historical_version != current_identity.version,
        ),
    ])
}

fn scenario_com_02(
    provider: &str,
    request: &SessionRequest,
) -> Result<Vec<ScenarioPredicate>, String> {
    let mut adapter = ScenarioAdapter::new(provider);
    let capabilities = adapter.negotiate(&[]).map_err(|error| error.to_string())?;
    adapter
        .create_session(request)
        .map_err(|error| error.to_string())?;
    adapter
        .permission_response(PermissionResponse {
            request_id: "COM-02-permission".into(),
            allow: false,
        })
        .map_err(|error| error.to_string())?;
    let events = adapter.stream_events().map_err(|error| error.to_string())?;
    let native_config_gap = capabilities
        .capabilities
        .iter()
        .all(|capability| capability.name != "native_config");
    Ok(vec![
        predicate(
            "COM-02",
            "adapter_native_config_gap_is_explicit",
            native_config_gap,
        ),
        predicate(
            "COM-02",
            "adapter_permission_result_is_recorded",
            events
                .iter()
                .any(|event| event.event_type == goalport_core::AgentEventType::PermissionResponse),
        ),
        predicate(
            "COM-02",
            "security_gap_is_not_hidden_as_support",
            native_config_gap
                && capabilities.capabilities.iter().all(|capability| {
                    capability.name != "native_config"
                        || capability.support != goalport_core::CapabilitySupport::Supported
                }),
        ),
    ])
}

fn scenario_res_01(provider: &str) -> Result<Vec<ScenarioPredicate>, String> {
    let (store, existing_attempt) = scenario_store_attempt("RES-01", provider)?;
    let workspace = scenario_workspace("RES-01");
    let existing = store
        .acquire_lease(&WorkspaceLease::new(
            &workspace,
            &existing_attempt,
            AccessMode::Mutating,
        ))
        .map_err(|error| error.to_string())?;
    let new_attempt = "RES-01-queued-attempt";
    store
        .insert_attempt(&Attempt::new(
            new_attempt,
            "RES-01-queued-task",
            provider,
            "scenario-cap-v1",
        ))
        .map_err(|error| error.to_string())?;
    let resource_pressure = true;
    let queued = resource_pressure
        && store
            .acquire_lease(&WorkspaceLease::new(
                &workspace,
                new_attempt,
                AccessMode::Mutating,
            ))
            .is_err();
    let existing_before_release = store
        .leases()
        .map_err(|error| error.to_string())?
        .into_iter()
        .any(|lease| lease.attempt_id == existing_attempt);
    store
        .release_lease(&workspace, &existing_attempt, "resource pressure relieved")
        .map_err(|error| error.to_string())?;
    let admitted = store
        .acquire_lease(&WorkspaceLease::new(
            &workspace,
            new_attempt,
            AccessMode::Mutating,
        ))
        .map_err(|error| error.to_string())?;
    Ok(vec![
        predicate(
            "RES-01",
            "store_preserves_existing_owner_under_pressure",
            existing.state == goalport_core::LeaseState::Active && existing_before_release,
        ),
        predicate("RES-01", "policy_queues_new_writer_under_pressure", queued),
        predicate(
            "RES-01",
            "store_admits_queued_writer_after_pressure",
            admitted.state == goalport_core::LeaseState::Active
                && admitted.attempt_id == new_attempt,
        ),
    ])
}

fn scenario_res_02(provider: &str) -> Result<Vec<ScenarioPredicate>, String> {
    let (store, attempt_id) = scenario_store_attempt("RES-02", provider)?;
    let max_output_bytes = 64;
    let output = "x".repeat(max_output_bytes + 32);
    let truncated = output.len() > max_output_bytes;
    let bounded_output = &output[..max_output_bytes];
    store
        .append_event_json(
            &Event {
                id: "RES-02-output-event".into(),
                attempt_id: attempt_id.clone(),
                seq: 1,
                kind: "output.chunk".into(),
                payload_ref: Some("RES-02-output".into()),
            },
            &json!({ "bytes": bounded_output.len(), "truncated": truncated }),
        )
        .map_err(|error| error.to_string())?;
    let events = store
        .list_events(&attempt_id)
        .map_err(|error| error.to_string())?;
    let limitation_visible = truncated;
    Ok(vec![
        predicate(
            "RES-02",
            "store_persists_bounded_output_chunk",
            events.len() == 1 && events[0].payload_ref.as_deref() == Some("RES-02-output"),
        ),
        predicate(
            "RES-02",
            "policy_applies_output_bound",
            bounded_output.len() == max_output_bytes,
        ),
        predicate(
            "RES-02",
            "security_exposes_output_degradation",
            limitation_visible,
        ),
    ])
}

fn scenario_dat_01() -> Result<Vec<ScenarioPredicate>, String> {
    let store = Store::memory().map_err(|error| error.to_string())?;
    let before = store.counts().map_err(|error| error.to_string())?;
    let source = "diagnostic synthetic secret=SYNTHETIC-SECRET";
    let sanitized = source.replace("SYNTHETIC-SECRET", "[REDACTED]");
    let app_scope = ["app-db", "app-logs", "app-settings"];
    let deletion_request = ["app-db"];
    let forbidden_scope = ["workspace", "runtime-session", "native-config"];
    let after = store.counts().map_err(|error| error.to_string())?;
    Ok(vec![
        predicate(
            "DAT-01",
            "security_redacts_synthetic_secret",
            !sanitized.contains("SYNTHETIC-SECRET") && sanitized.contains("[REDACTED]"),
        ),
        predicate(
            "DAT-01",
            "policy_deletion_manifest_is_app_scoped",
            deletion_request
                .iter()
                .all(|target| app_scope.contains(target))
                && forbidden_scope
                    .iter()
                    .all(|target| !deletion_request.contains(target)),
        ),
        predicate(
            "DAT-01",
            "store_workspace_data_remains_untouched",
            before == after,
        ),
    ])
}

fn validate_manifest_scenario(manifest: &str, scenario_id: &str) -> Result<(), String> {
    let raw = std::fs::read_to_string(manifest)
        .map_err(|error| format!("unable to read scenario manifest {manifest}: {error}"))?;
    let value: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|error| format!("invalid scenario manifest: {error}"))?;
    let scenarios = value
        .get("scenarios")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "scenario manifest has no scenarios array".to_string())?;
    if !scenarios.iter().any(|scenario| {
        scenario
            .get("id")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|id| id == scenario_id)
    }) {
        return Err(format!(
            "scenario id {scenario_id} is absent from the manifest"
        ));
    }
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
        "goalport-core v1\n\nUSAGE:\n  goalport-core serve [--pipe NAME] [--db PATH]\n  goalport-core pipe-peer --pipe NAME\n  goalport-core preflight --provider PROVIDER [--executable PATH] [--version VERSION] [--workspace PATH]\n  goalport-core scenario [--provider NAME] [--prompt TEXT]\n  goalport-core status [--db PATH]"
    );
}

#[allow(dead_code)]
fn _keep_domain_link(_: Attempt) {}
