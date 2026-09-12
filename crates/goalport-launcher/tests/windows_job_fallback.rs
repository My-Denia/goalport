#![cfg(windows)]

use std::{
    env, fs, io,
    os::windows::{io::AsRawHandle, process::CommandExt},
    path::{Path, PathBuf},
    process::Command,
    ptr, thread,
    time::{Duration, Instant},
};
use tempfile::tempdir;
use winapi::{
    shared::{minwindef::FALSE, winerror::WAIT_TIMEOUT},
    um::{
        handleapi::CloseHandle,
        jobapi::IsProcessInJob,
        jobapi2::{
            AssignProcessToJobObject, CreateJobObjectW, QueryInformationJobObject,
            SetInformationJobObject,
        },
        processthreadsapi::OpenProcess,
        synchapi::WaitForSingleObject,
        winbase::{CREATE_BREAKAWAY_FROM_JOB, CREATE_NO_WINDOW, DETACHED_PROCESS, WAIT_OBJECT_0},
        winnt::{
            HANDLE, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectBasicAccountingInformation,
            JobObjectExtendedLimitInformation, PROCESS_QUERY_LIMITED_INFORMATION, SYNCHRONIZE,
        },
    },
};

const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
const OLD_LAUNCH_FLAGS: u32 =
    CREATE_BREAKAWAY_FROM_JOB | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW | DETACHED_PROCESS;
const HELPER_TIMEOUT: Duration = Duration::from_secs(30);

struct OwnedHandle(HANDLE);

impl OwnedHandle {
    fn new(handle: HANDLE, operation: &str) -> Self {
        assert!(
            !handle.is_null(),
            "{operation}: {}",
            io::Error::last_os_error()
        );
        Self(handle)
    }

    fn raw(&self) -> HANDLE {
        self.0
    }

    fn close(&mut self) {
        if !self.0.is_null() {
            unsafe {
                CloseHandle(self.0);
            }
            self.0 = ptr::null_mut();
        }
    }
}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        self.close();
    }
}

fn wait_for_path(path: &Path) {
    let deadline = Instant::now() + HELPER_TIMEOUT;
    while Instant::now() < deadline {
        if path.exists() {
            return;
        }
        thread::sleep(Duration::from_millis(20));
    }
    panic!("timed out waiting for {}", path.display());
}

fn helper_command(test_name: &str) -> Command {
    let mut command = Command::new(env::current_exe().unwrap());
    command.args(["--ignored", "--exact", test_name, "--nocapture"]);
    command
}

fn managed_dir() -> PathBuf {
    PathBuf::from(env::var_os("GOALPORT_MANAGED_JOB_TEST_DIR").unwrap())
}

fn core_markers(root: &Path) -> Vec<PathBuf> {
    let mut markers: Vec<_> = fs::read_dir(root)
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("core-") && name.ends_with(".started"))
        })
        .collect();
    markers.sort();
    markers
}

fn process_is_in_job(process: HANDLE, job: HANDLE) -> io::Result<bool> {
    let mut result = 0;
    let succeeded = unsafe { IsProcessInJob(process, job, &mut result) };
    if succeeded == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(result != 0)
    }
}

fn active_processes(job: HANDLE) -> io::Result<u32> {
    let mut accounting: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { std::mem::zeroed() };
    let succeeded = unsafe {
        QueryInformationJobObject(
            job,
            JobObjectBasicAccountingInformation,
            &mut accounting as *mut _ as *mut _,
            std::mem::size_of_val(&accounting) as u32,
            ptr::null_mut(),
        )
    };
    if succeeded == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(accounting.ActiveProcesses)
    }
}

#[test]
fn breakaway_denial_falls_back_once_and_keeps_supervisor_job_ownership() {
    let scratch = tempdir().unwrap();
    let root = scratch.path();
    let ready = root.join("supervisor.ready");
    let gate = root.join("supervisor.gate");
    let probe_result = root.join("old-probe-error.txt");

    let mut job = OwnedHandle::new(
        unsafe { CreateJobObjectW(ptr::null_mut(), ptr::null()) },
        "CreateJobObjectW",
    );
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    assert_ne!(
        unsafe {
            SetInformationJobObject(
                job.raw(),
                JobObjectExtendedLimitInformation,
                &mut limits as *mut _ as *mut _,
                std::mem::size_of_val(&limits) as u32,
            )
        },
        0,
        "SetInformationJobObject: {}",
        io::Error::last_os_error()
    );

    let mut supervisor = helper_command("managed_job_supervisor_helper")
        .env("GOALPORT_MANAGED_JOB_TEST_DIR", root)
        .env(
            "GOALPORT_MANAGED_JOB_LAUNCHER",
            env!("CARGO_BIN_EXE_goalport-core-launcher"),
        )
        .spawn()
        .unwrap();
    wait_for_path(&ready);
    let assigned =
        unsafe { AssignProcessToJobObject(job.raw(), supervisor.as_raw_handle() as HANDLE) };
    if assigned == 0 {
        let error = io::Error::last_os_error();
        let _ = supervisor.kill();
        panic!("AssignProcessToJobObject: {error}");
    }
    assert_eq!(
        process_is_in_job(supervisor.as_raw_handle() as HANDLE, job.raw()).unwrap(),
        true
    );
    fs::write(&gate, b"assigned").unwrap();

    let supervisor_status = supervisor.wait().unwrap();
    assert!(supervisor_status.success(), "supervisor helper failed");
    assert_eq!(fs::read_to_string(&probe_result).unwrap().trim(), "5");
    wait_for_path(&root.join("launcher.succeeded"));
    wait_for_path(&root.join("core.started"));

    let markers = core_markers(root);
    assert_eq!(
        markers.len(),
        1,
        "fallback must start exactly one inert Core"
    );
    let core_pid: u32 = fs::read_to_string(&markers[0])
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    let mut core = OwnedHandle::new(
        unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
                FALSE,
                core_pid,
            )
        },
        "OpenProcess(inert Core)",
    );
    assert_eq!(
        unsafe { WaitForSingleObject(core.raw(), 0) },
        WAIT_TIMEOUT,
        "inert Core did not survive launcher and supervisor-helper exit"
    );
    assert_eq!(process_is_in_job(core.raw(), job.raw()).unwrap(), true);
    assert_eq!(active_processes(job.raw()).unwrap(), 1);

    job.close();
    assert_eq!(
        unsafe { WaitForSingleObject(core.raw(), 10_000) },
        WAIT_OBJECT_0,
        "closing the owned supervisor job did not terminate inert Core"
    );
    core.close();
}

#[test]
#[ignore]
fn managed_job_supervisor_helper() {
    let root = managed_dir();
    fs::write(root.join("supervisor.ready"), b"ready").unwrap();
    wait_for_path(&root.join("supervisor.gate"));

    let mut old_probe = helper_command("managed_job_inert_core");
    old_probe
        .env("GOALPORT_MANAGED_JOB_TEST_DIR", &root)
        .creation_flags(OLD_LAUNCH_FLAGS);
    let old_error = old_probe
        .spawn()
        .expect_err("old forced-breakaway spawn unexpectedly worked");
    fs::write(
        root.join("old-probe-error.txt"),
        old_error.raw_os_error().unwrap_or_default().to_string(),
    )
    .unwrap();
    assert_eq!(old_error.raw_os_error(), Some(5));

    let status = Command::new(env::var_os("GOALPORT_MANAGED_JOB_LAUNCHER").unwrap())
        .arg(env::current_exe().unwrap())
        .args([
            "--ignored",
            "--exact",
            "managed_job_inert_core",
            "--nocapture",
        ])
        .env("GOALPORT_MANAGED_JOB_TEST_DIR", &root)
        .status()
        .unwrap();
    assert!(
        status.success(),
        "real launcher did not complete its fallback"
    );
    fs::write(root.join("launcher.succeeded"), b"success").unwrap();
}

#[test]
#[ignore]
fn managed_job_inert_core() {
    let root = managed_dir();
    let process_id = std::process::id();
    fs::write(
        root.join(format!("core-{process_id}.started")),
        process_id.to_string(),
    )
    .unwrap();
    fs::write(root.join("core.started"), b"started").unwrap();
    thread::sleep(HELPER_TIMEOUT);
}
