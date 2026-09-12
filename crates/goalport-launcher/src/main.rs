use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    env, fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

fn main() -> Result<(), String> {
    let result = run();
    if let Err(error) = &result {
        // The detached launcher can have null stdio. Keep
        // startup failures beside this launch's DB instead of losing the cause.
        let args: Vec<String> = env::args().skip(1).collect();
        if let Some(db) = arg_option(&args, "--db") {
            let file = format!("{db}.launcher.log");
            if let Ok(mut log) = fs::OpenOptions::new().create(true).append(true).open(file) {
                let _ = writeln!(log, "{} {error}", utc_now_iso());
            }
        }
    }
    result
}

fn run() -> Result<(), String> {
    if matches!(env::args().nth(1).as_deref(), Some("--version" | "-V")) {
        println!("goalport-core-launcher {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    // Electron already starts this launcher detached. Create Core directly:
    // repeating a breakaway in a second launcher can be denied by nested jobs.
    // Core's own creation flags and full READY identity gate remain unchanged.
    let mut args = env::args().skip(1);
    let core = args
        .next()
        .ok_or_else(|| "usage: goalport-core-launcher CORE [CORE_ARGS...]".to_string())?;
    let core = PathBuf::from(core);
    if !core.is_file() {
        return Err(format!("Core binary does not exist: {}", core.display()));
    }
    let core = core.canonicalize().unwrap_or(core);
    let core_args: Vec<String> = args.collect();
    let db = arg_option(&core_args, "--db").map(PathBuf::from);
    let pipe = arg_option(&core_args, "--pipe").unwrap_or_default();
    let nonce = env::var("GOALPORT_LAUNCH_NONCE").unwrap_or_default();
    let started_at = utc_now_iso();
    let identity = current_identity();
    let parent_pid = identity.parent_pid;

    let mut command = Command::new(&core);
    command.args(&core_args).stdin(Stdio::null());
    if let Some(db) = db.as_ref() {
        let log_path = launch_log_path(db);
        match fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
        {
            Ok(file) => match file.try_clone() {
                Ok(clone) => {
                    command.stdout(Stdio::from(file));
                    command.stderr(Stdio::from(clone));
                }
                Err(_) => {
                    command.stdout(Stdio::from(file));
                    command.stderr(Stdio::null());
                }
            },
            Err(_) => {
                command.stdout(Stdio::null());
                command.stderr(Stdio::null());
            }
        }
    } else {
        command.stdout(Stdio::null());
        command.stderr(Stdio::null());
    }
    command.env("GOALPORT_LAUNCHER_PID", identity.pid.to_string());
    command.env(
        "GOALPORT_LAUNCHER_CREATED_MS",
        identity.created_ms.to_string(),
    );
    command.env("GOALPORT_LAUNCHER_EXE", &identity.executable_path);
    command.env("GOALPORT_LAUNCHER_SHA256", &identity.executable_sha256);
    let observed_parent = env::var("GOALPORT_ELECTRON_PID")
        .ok()
        .and_then(|value| value.parse().ok())
        .filter(|pid| *pid > 0)
        .unwrap_or(parent_pid);
    command.env("GOALPORT_LAUNCHER_PARENT_PID", observed_parent.to_string());
    command.env("GOALPORT_LAUNCHER_STARTED_AT", &started_at);
    command.env("GOALPORT_CORE_SPAWNED_AT", utc_now_iso());
    if !nonce.trim().is_empty() {
        command.env("GOALPORT_LAUNCH_NONCE", nonce.trim());
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Break the Core out of a desktop job/process group. The Core owns the
        // SQLite/event/runtime lifetime after the launcher exits.
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        command.creation_flags(
            CREATE_BREAKAWAY_FROM_JOB
                | CREATE_NEW_PROCESS_GROUP
                | CREATE_NO_WINDOW
                | DETACHED_PROCESS,
        );
    }
    let child = command
        .spawn()
        .map_err(|error| format!("unable to launch lifecycle-independent Core: {error}"))?;
    let core_pid = child.id();
    drop(child);

    if let Some(db) = db {
        if !nonce.trim().is_empty() {
            let database = absolute_path(&db);
            let expectation = LaunchReadyExpectation {
                nonce: nonce.trim().to_string(),
                run_slug: env::var("GOALPORT_RUN_SLUG").unwrap_or_default(),
                pipe_identity: pipe,
                database_identity: database.display().to_string(),
                startup_receipt_id: format!("startup:{}", nonce.trim()),
                core_pid,
                core_executable_path: display_path(&core),
                core_executable_sha256: file_sha256(&core),
                launcher: identity,
                launcher_started_at: started_at,
            };
            wait_launch_ready(&launch_ready_path(&db), &expectation)?;
        }
    }
    Ok(())
}

fn arg_option(args: &[String], name: &str) -> Option<String> {
    args.windows(2)
        .find(|pair| pair[0] == name)
        .map(|pair| pair[1].clone())
}

fn launch_ready_path(db: &Path) -> PathBuf {
    let mut path = db.as_os_str().to_os_string();
    path.push(".launch-ready");
    PathBuf::from(path)
}

fn launch_log_path(db: &Path) -> PathBuf {
    let mut path = db.as_os_str().to_os_string();
    path.push(".core.log");
    PathBuf::from(path)
}

fn absolute_path(path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        env::current_dir()
            .map(|cwd| cwd.join(path))
            .unwrap_or_else(|_| path.to_path_buf())
    }
}

#[derive(Debug)]
struct LaunchReadyExpectation {
    nonce: String,
    run_slug: String,
    pipe_identity: String,
    database_identity: String,
    startup_receipt_id: String,
    core_pid: u32,
    core_executable_path: String,
    core_executable_sha256: String,
    launcher: ProcessIdentity,
    launcher_started_at: String,
}

fn wait_launch_ready(path: &Path, expectation: &LaunchReadyExpectation) -> Result<(), String> {
    let timeout_ms = env::var("GOALPORT_LAUNCH_READY_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(10_000u64);
    let deadline = Instant::now() + Duration::from_millis(timeout_ms.max(100));
    while Instant::now() < deadline {
        if path.is_file() {
            let text = fs::read_to_string(path).unwrap_or_default();
            if launch_ready_matches(&text, expectation) {
                return Ok(());
            }
        }
        thread::sleep(Duration::from_millis(20));
    }
    Err(format!(
        "Core did not persist startup receipt before launcher exit ({})",
        path.display()
    ))
}

fn launch_ready_matches(text: &str, expected: &LaunchReadyExpectation) -> bool {
    let Ok(ready) = serde_json::from_str::<Value>(text) else {
        return false;
    };
    let expected_epoch = format!("core-epoch:{}", expected.nonce);
    let expected_launcher_creation = expected.launcher.creation_date();
    if ready.get("kind").and_then(Value::as_str) != Some("launch-ready")
        || ready.get("readyState").and_then(Value::as_str) != Some("READY_COMMITTED")
        || ready.get("launchNonce").and_then(Value::as_str) != Some(expected.nonce.as_str())
        || ready.get("coreEpochId").and_then(Value::as_str) != Some(expected_epoch.as_str())
        || ready.get("runSlug").and_then(Value::as_str) != Some(expected.run_slug.as_str())
        || normalize(
            ready
                .get("pipeIdentity")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        ) != normalize(&expected.pipe_identity)
        || normalize(
            ready
                .get("databaseIdentity")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        ) != normalize(&expected.database_identity)
        || ready.get("startupReceiptId").and_then(Value::as_str)
            != Some(expected.startup_receipt_id.as_str())
    {
        return false;
    }
    let launcher = ready.get("launcher").unwrap_or(&Value::Null);
    if launcher.get("pid").and_then(Value::as_u64) != Some(u64::from(expected.launcher.pid))
        || launcher.get("creationDate").and_then(Value::as_str)
            != Some(expected_launcher_creation.as_str())
        || normalize(
            launcher
                .get("executablePath")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        ) != normalize(&expected.launcher.executable_path)
        || launcher.get("executableSha256").and_then(Value::as_str)
            != Some(expected.launcher.executable_sha256.as_str())
    {
        return false;
    }
    let Some(observed_core) = observe_process(expected.core_pid) else {
        return false;
    };
    let core = ready.get("core").unwrap_or(&Value::Null);
    if core.get("pid").and_then(Value::as_u64) != Some(u64::from(expected.core_pid))
        || core.get("creationDate").and_then(Value::as_str)
            != Some(observed_core.creation_date().as_str())
        || normalize(
            core.get("executablePath")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        ) != normalize(&expected.core_executable_path)
        || normalize(&observed_core.executable_path) != normalize(&expected.core_executable_path)
        || core.get("executableSha256").and_then(Value::as_str)
            != Some(expected.core_executable_sha256.as_str())
        || observed_core.executable_sha256 != expected.core_executable_sha256
    {
        return false;
    }
    let timestamps = ready.get("timestamps").unwrap_or(&Value::Null);
    let launch_requested = timestamps
        .get("launchRequestedAtUtc")
        .and_then(Value::as_str)
        .and_then(parse_utc_ms);
    let startup = timestamps
        .get("startupReceiptPersistedAtUtc")
        .and_then(Value::as_str)
        .and_then(parse_utc_ms);
    let ready_at = timestamps
        .get("readyAtUtc")
        .and_then(Value::as_str)
        .and_then(parse_utc_ms);
    let launcher_started = parse_utc_ms(&expected.launcher_started_at);
    matches!(
        (launch_requested, launcher_started, startup, ready_at),
        (Some(requested), Some(launcher), Some(startup), Some(ready))
            if requested <= launcher
                && launcher <= startup
                && startup <= ready
                && observed_core.created_ms <= ready
    )
}

fn normalize(value: &str) -> String {
    value
        .strip_prefix(r"\\?\")
        .unwrap_or(value)
        .replace('/', "\\")
        .to_ascii_lowercase()
}

#[derive(Debug, Clone)]
struct ProcessIdentity {
    pid: u32,
    parent_pid: u32,
    executable_path: String,
    executable_sha256: String,
    created_ms: u64,
}

impl ProcessIdentity {
    fn creation_date(&self) -> String {
        format!("/Date({})/", self.created_ms)
    }
}

fn current_identity() -> ProcessIdentity {
    let executable_path = env::current_exe()
        .ok()
        .and_then(|path| path.canonicalize().ok().or(Some(path)))
        .unwrap_or_default();
    ProcessIdentity {
        pid: std::process::id(),
        parent_pid: observed_parent_pid(),
        executable_sha256: file_sha256(&executable_path),
        executable_path: display_path(&executable_path),
        created_ms: process_created_ms(),
    }
}

fn observe_process(pid: u32) -> Option<ProcessIdentity> {
    #[cfg(windows)]
    {
        windows_process_identity(pid)
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
        None
    }
}

fn display_path(path: &Path) -> String {
    let text = path.display().to_string();
    text.strip_prefix(r"\\?\").unwrap_or(&text).to_string()
}

fn file_sha256(path: &Path) -> String {
    fs::read(path)
        .map(|bytes| {
            let mut hasher = Sha256::new();
            hasher.update(&bytes);
            format!("{:x}", hasher.finalize())
        })
        .unwrap_or_default()
}

fn utc_now_iso() -> String {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    utc_millis_iso(ms as u64)
}

fn utc_millis_iso(ms: u64) -> String {
    let secs = (ms / 1000) as i64;
    let milli = (ms % 1000) as u32;
    let days = secs.div_euclid(86_400);
    let remaining = secs.rem_euclid(86_400) as u32;
    let hour = remaining / 3600;
    let min = (remaining % 3600) / 60;
    let sec = remaining % 60;
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{min:02}:{sec:02}.{milli:03}Z")
}

fn parse_utc_ms(value: &str) -> Option<u64> {
    if value.len() != 24
        || value.as_bytes().get(4) != Some(&b'-')
        || value.as_bytes().get(7) != Some(&b'-')
        || value.as_bytes().get(10) != Some(&b'T')
        || value.as_bytes().get(13) != Some(&b':')
        || value.as_bytes().get(16) != Some(&b':')
        || value.as_bytes().get(19) != Some(&b'.')
        || value.as_bytes().get(23) != Some(&b'Z')
    {
        return None;
    }
    let year = value.get(0..4)?.parse::<i32>().ok()?;
    let month = value.get(5..7)?.parse::<u32>().ok()?;
    let day = value.get(8..10)?.parse::<u32>().ok()?;
    let hour = value.get(11..13)?.parse::<u32>().ok()?;
    let minute = value.get(14..16)?.parse::<u32>().ok()?;
    let second = value.get(17..19)?.parse::<u32>().ok()?;
    let milli = value.get(20..23)?.parse::<u32>().ok()?;
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 59
        || milli > 999
    {
        return None;
    }
    let days = days_from_civil(year, month, day)?;
    let seconds = days
        .checked_mul(86_400)?
        .checked_add(i64::from(hour * 3600 + minute * 60 + second))?;
    let ms = u64::try_from(seconds)
        .ok()?
        .checked_mul(1000)?
        .checked_add(u64::from(milli))?;
    (utc_millis_iso(ms) == value).then_some(ms)
}

fn days_from_civil(year: i32, month: u32, day: u32) -> Option<i64> {
    let adjusted_year = i64::from(year) - i64::from(month <= 2);
    let era = adjusted_year.div_euclid(400);
    let year_of_era = adjusted_year - era * 400;
    let month_prime = i64::from(month) + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * month_prime + 2) / 5 + i64::from(day) - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    Some(era * 146_097 + day_of_era - 719_468)
}

fn civil_from_days(days_since_unix_epoch: i64) -> (i32, u32, u32) {
    let z = days_since_unix_epoch + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097) as u32;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = era * 400 + i64::from(yoe);
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    (year as i32, m, d)
}

fn process_created_ms() -> u64 {
    #[cfg(windows)]
    {
        windows_process_created_ms().unwrap_or_else(fallback_created_ms)
    }
    #[cfg(not(windows))]
    {
        fallback_created_ms()
    }
}

fn fallback_created_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn observed_parent_pid() -> u32 {
    #[cfg(windows)]
    {
        windows_parent_pid().unwrap_or(0)
    }
    #[cfg(not(windows))]
    {
        0
    }
}

#[cfg(windows)]
fn windows_parent_pid() -> Option<u32> {
    unsafe {
        let mut pbi = ProcessBasicInformation::default();
        let status = NtQueryInformationProcess(
            GetCurrentProcess(),
            0,
            &mut pbi as *mut _ as *mut _,
            std::mem::size_of::<ProcessBasicInformation>() as u32,
            std::ptr::null_mut(),
        );
        if status != 0 {
            return None;
        }
        Some(pbi.inherited_from_unique_process_id as u32)
    }
}

#[cfg(windows)]
fn windows_process_created_ms() -> Option<u64> {
    unsafe {
        let mut created = FileTime::default();
        let mut exit = FileTime::default();
        let mut kernel = FileTime::default();
        let mut user = FileTime::default();
        if GetProcessTimes(
            GetCurrentProcess(),
            &mut created,
            &mut exit,
            &mut kernel,
            &mut user,
        ) == 0
        {
            return None;
        }
        let ticks =
            (u64::from(created.dw_high_date_time) << 32) | u64::from(created.dw_low_date_time);
        Some(ticks / 10_000 - 11_644_473_600_000)
    }
}

#[cfg(windows)]
fn windows_process_identity(pid: u32) -> Option<ProcessIdentity> {
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() {
            return None;
        }
        let result = (|| {
            let mut created = FileTime::default();
            let mut exit = FileTime::default();
            let mut kernel = FileTime::default();
            let mut user = FileTime::default();
            if GetProcessTimes(process, &mut created, &mut exit, &mut kernel, &mut user) == 0 {
                return None;
            }
            let mut path = vec![0u16; 32_768];
            let mut size = path.len() as u32;
            if QueryFullProcessImageNameW(process, 0, path.as_mut_ptr(), &mut size) == 0 {
                return None;
            }
            path.truncate(size as usize);
            let executable_path = PathBuf::from(String::from_utf16_lossy(&path));
            let ticks =
                (u64::from(created.dw_high_date_time) << 32) | u64::from(created.dw_low_date_time);
            Some(ProcessIdentity {
                pid,
                parent_pid: 0,
                executable_sha256: file_sha256(&executable_path),
                executable_path: display_path(&executable_path),
                created_ms: ticks / 10_000 - 11_644_473_600_000,
            })
        })();
        CloseHandle(process);
        result
    }
}

#[cfg(windows)]
#[repr(C)]
#[derive(Default)]
struct ProcessBasicInformation {
    reserved1: usize,
    peb_base_address: usize,
    reserved2_0: usize,
    reserved2_1: usize,
    unique_process_id: usize,
    inherited_from_unique_process_id: usize,
}

#[cfg(windows)]
#[repr(C)]
#[derive(Default)]
struct FileTime {
    dw_low_date_time: u32,
    dw_high_date_time: u32,
}

#[cfg(windows)]
unsafe extern "system" {
    fn OpenProcess(
        desired_access: u32,
        inherit_handle: i32,
        process_id: u32,
    ) -> *mut std::ffi::c_void;
    fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
    fn QueryFullProcessImageNameW(
        process: *mut std::ffi::c_void,
        flags: u32,
        image_file_name: *mut u16,
        size: *mut u32,
    ) -> i32;
    fn GetCurrentProcess() -> *mut std::ffi::c_void;
    fn GetProcessTimes(
        process: *mut std::ffi::c_void,
        created: *mut FileTime,
        exit: *mut FileTime,
        kernel: *mut FileTime,
        user: *mut FileTime,
    ) -> i32;
    fn NtQueryInformationProcess(
        process: *mut std::ffi::c_void,
        info_class: i32,
        info: *mut std::ffi::c_void,
        info_length: u32,
        return_length: *mut u32,
    ) -> i32;
}

#[cfg(test)]
mod tests {
    use super::{LaunchReadyExpectation, current_identity, launch_ready_matches, utc_now_iso};
    use serde_json::json;

    #[test]
    fn launch_ready_is_bound_to_fresh_full_process_identity() {
        let identity = current_identity();
        let now = utc_now_iso();
        let expected = LaunchReadyExpectation {
            nonce: "nonce-1".into(),
            run_slug: "run-1".into(),
            pipe_identity: r"\\.\pipe\run-1".into(),
            database_identity: r"C:\evidence\run-1.sqlite".into(),
            startup_receipt_id: "startup:nonce-1".into(),
            core_pid: identity.pid,
            core_executable_path: identity.executable_path.clone(),
            core_executable_sha256: identity.executable_sha256.clone(),
            launcher: identity.clone(),
            launcher_started_at: now.clone(),
        };
        let ready = json!({
            "kind":"launch-ready",
            "readyState":"READY_COMMITTED",
            "launchNonce":"nonce-1",
            "coreEpochId":"core-epoch:nonce-1",
            "runSlug":"run-1",
            "pipeIdentity":r"\\.\pipe\run-1",
            "databaseIdentity":r"C:\evidence\run-1.sqlite",
            "startupReceiptId":"startup:nonce-1",
            "launcher":{
                "pid":identity.pid,
                "creationDate":identity.creation_date(),
                "executablePath":identity.executable_path,
                "executableSha256":identity.executable_sha256,
            },
            "core":{
                "pid":expected.core_pid,
                "creationDate":expected.launcher.creation_date(),
                "executablePath":expected.core_executable_path,
                "executableSha256":expected.core_executable_sha256,
            },
            "timestamps":{
                "launchRequestedAtUtc":now,
                "startupReceiptPersistedAtUtc":now,
                "readyAtUtc":now,
            }
        });
        let text = serde_json::to_string(&ready).unwrap();
        assert!(launch_ready_matches(&text, &expected));
        for (field, value) in [
            ("launchNonce", json!("old-nonce")),
            ("coreEpochId", json!("core-epoch:old-nonce")),
            ("runSlug", json!("old-run")),
            ("readyState", json!("STARTUP_PENDING")),
        ] {
            let mut changed = ready.clone();
            changed[field] = value;
            assert!(!launch_ready_matches(
                &serde_json::to_string(&changed).unwrap(),
                &expected
            ));
        }
        let mut wrong_creation = ready.clone();
        wrong_creation["core"]["creationDate"] = json!("/Date(1)/");
        assert!(!launch_ready_matches(
            &serde_json::to_string(&wrong_creation).unwrap(),
            &expected
        ));
        let mut invalid_time = ready;
        invalid_time["timestamps"]["readyAtUtc"] = json!("not-a-time");
        assert!(!launch_ready_matches(
            &serde_json::to_string(&invalid_time).unwrap(),
            &expected
        ));
    }
}
