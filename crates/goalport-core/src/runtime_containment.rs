//! Spawn-time ownership domain for a Claude Runtime tree.
//!
//! A parent-link snapshot taken before close or interrupt is not atomic with
//! the spawn boundary. A child forked after that snapshot is reparented when
//! the root dies and cannot be found again. The domain is created before the
//! Runtime runs, and leaving it is not possible:
//! - Linux: the Runtime is pid 1 of a new pid namespace. The kernel kills every
//!   process in that namespace when pid 1 dies, including a child that called
//!   `setsid`.
//! - Windows: the Runtime is assigned to a job before its primary thread is
//!   resumed. Breakaway is not enabled, so descendants stay in the job.
//!   `TerminateJobObject` ends the job, not a stale pid list.

use std::fs::File;
use std::io::{self, Read, Write};
use std::os::fd::{FromRawFd, IntoRawFd, RawFd};
use std::path::Path;
use std::process::ExitStatus;

#[cfg(unix)]
use std::os::unix::process::ExitStatusExt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DomainOccupy {
    /// No process remains in the domain except, when asked, the recorded root.
    Empty,
    /// At least one other process is still in the domain.
    Occupied,
    /// The domain could not be observed. Missing evidence, not empty.
    Unreadable,
    /// This attempt has no live contained Runtime to ask.
    Untracked,
}

pub(crate) struct ContainedChild {
    pid: u32,
    reaped: bool,
    #[cfg(target_os = "linux")]
    ns_inode: u64,
    #[cfg(windows)]
    process: winapi::um::winnt::HANDLE,
    #[cfg(windows)]
    job: winapi::um::winnt::HANDLE,
}

pub(crate) struct ContainedSpawn {
    pub child: ContainedChild,
    pub stdin: File,
    pub stdout: File,
}

impl ContainedChild {
    pub(crate) fn id(&self) -> u32 {
        self.pid
    }

    pub(crate) fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        if self.reaped {
            return Ok(Some(ExitStatus::from_raw(0)));
        }
        #[cfg(target_os = "linux")]
        {
            let mut status = 0;
            let pid = unsafe { libc::waitpid(self.pid as i32, &mut status, libc::WNOHANG) };
            if pid == 0 {
                return Ok(None);
            }
            if pid < 0 {
                let err = io::Error::last_os_error();
                if err.raw_os_error() == Some(libc::ECHILD) {
                    self.reaped = true;
                    return Ok(Some(ExitStatus::from_raw(0)));
                }
                return Err(err);
            }
            self.reaped = true;
            return Ok(Some(ExitStatus::from_raw(status)));
        }
        #[cfg(windows)]
        {
            let mut code = 0u32;
            let ok = unsafe { winapi::um::processthreadsapi::GetExitCodeProcess(self.process, &mut code) };
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
            if code == 259 {
                return Ok(None);
            }
            self.reaped = true;
            return Ok(Some(ExitStatus::from_raw(code as i32)));
        }
        #[cfg(not(any(target_os = "linux", windows)))]
        {
            let _ = self;
            Err(io::Error::new(io::ErrorKind::Unsupported, "no containment domain"))
        }
    }

    pub(crate) fn wait(&mut self) -> io::Result<ExitStatus> {
        loop {
            if let Some(status) = self.try_wait()? {
                return Ok(status);
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }

    /// End the ownership domain. On Linux this is SIGKILL to namespace init,
    /// which the kernel extends to every process in the namespace. On Windows
    /// this is `TerminateJobObject`. A reused pid outside the domain is not a
    /// member and is not signalled.
    pub(crate) fn kill(&mut self) -> io::Result<()> {
        if self.reaped {
            return Ok(());
        }
        #[cfg(target_os = "linux")]
        {
            let rc = unsafe { libc::kill(self.pid as i32, libc::SIGKILL) };
            if rc != 0 {
                let err = io::Error::last_os_error();
                if err.raw_os_error() == Some(libc::ESRCH) {
                    return Ok(());
                }
                return Err(err);
            }
            return Ok(());
        }
        #[cfg(windows)]
        {
            let ok = unsafe { terminate_job(self.job) };
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
            return Ok(());
        }
        #[cfg(not(any(target_os = "linux", windows)))]
        Err(io::Error::new(io::ErrorKind::Unsupported, "no containment domain"))
    }

    pub(crate) fn extras_alive(&self) -> io::Result<bool> {
        #[cfg(target_os = "linux")]
        {
            return linux_namespace_has_other(self.ns_inode, self.pid);
        }
        #[cfg(windows)]
        {
            return windows_job_has_other(self.job, self.pid);
        }
        #[cfg(not(any(target_os = "linux", windows)))]
        {
            let _ = self;
            Err(io::Error::new(io::ErrorKind::Unsupported, "no containment domain"))
        }
    }
}

impl Drop for ContainedChild {
    fn drop(&mut self) {
        if !self.reaped {
            let _ = self.kill();
            let _ = self.wait();
        }
        #[cfg(windows)]
        unsafe {
            winapi::um::handleapi::CloseHandle(self.process);
            winapi::um::handleapi::CloseHandle(self.job);
        }
    }
}

pub(crate) fn spawn_contained(
    program: &Path,
    args: &[String],
    cwd: &Path,
    env_remove: &[&str],
) -> io::Result<ContainedSpawn> {
    #[cfg(target_os = "linux")]
    {
        return linux_spawn(program, args, cwd, env_remove);
    }
    #[cfg(windows)]
    {
        return windows_spawn(program, args, cwd, env_remove);
    }
    #[cfg(not(any(target_os = "linux", windows)))]
    {
        let _ = (program, args, cwd, env_remove);
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "Claude spawn requires a containment domain",
        ))
    }
}

#[cfg(target_os = "linux")]
fn linux_spawn(
    program: &Path,
    args: &[String],
    cwd: &Path,
    env_remove: &[&str],
) -> io::Result<ContainedSpawn> {
    let (stdin_read, stdin_write) = pipe()?;
    let (stdout_read, stdout_write) = pipe()?;
    let (sync_read, sync_write) = pipe()?;
    let program = resolve_program(program)?;
    let program_c = std::ffi::CString::new(program.as_os_str().as_encoded_bytes())
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?;
    let mut argv_owned = Vec::new();
    argv_owned.push(program_c);
    for arg in args {
        argv_owned.push(
            std::ffi::CString::new(arg.as_str())
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?,
        );
    }
    let mut argv_ptrs: Vec<*const libc::c_char> = argv_owned.iter().map(|s| s.as_ptr()).collect();
    argv_ptrs.push(std::ptr::null());
    let cwd_c = std::ffi::CString::new(cwd.as_os_str().as_encoded_bytes())
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?;
    let mut env_owned = inherited_env(env_remove)?;
    let mut env_ptrs: Vec<*const libc::c_char> = env_owned.iter().map(|s| s.as_ptr()).collect();
    env_ptrs.push(std::ptr::null());
    // The child reads these pointers after clone copies the address space.
    // They must stay alive until exec. Leak is one spawn's argv, freed with
    // the process. The sync pipe is the barrier before exec.
    let argv_ptrs = Box::leak(argv_ptrs.into_boxed_slice());
    let env_ptrs = Box::leak(env_ptrs.into_boxed_slice());
    let program_ptr = argv_owned[0].as_ptr();
    let argv_owned = Box::leak(argv_owned.into_boxed_slice());
    let _env_owned = Box::leak(env_owned.into_boxed_slice());
    let cwd_c = Box::leak(Box::new(cwd_c));
    let mut arg = LinuxSpawnArg {
        program: program_ptr,
        argv: argv_ptrs.as_ptr(),
        envp: env_ptrs.as_ptr(),
        cwd: cwd_c.as_ptr(),
        stdin_fd: stdin_read,
        stdout_fd: stdout_write,
        sync_fd: sync_read,
    };
    let flags = libc::CLONE_NEWUSER | libc::CLONE_NEWPID | libc::SIGCHLD;
    let pid = unsafe {
        libc::syscall(
            libc::SYS_clone,
            flags,
            0,
            0,
            0,
            0,
        )
    };
    if pid < 0 {
        return Err(io::Error::last_os_error());
    }
    if pid == 0 {
        linux_child(&mut arg);
    }
    // Parent. Close the ends the child owns.
    unsafe {
        libc::close(stdin_read);
        libc::close(stdout_write);
        libc::close(sync_read);
    }
    let pid = pid as u32;
    if let Err(error) = write_id_maps(pid) {
        unsafe { libc::kill(pid as i32, libc::SIGKILL) };
        return Err(error);
    }
    let mut go = [1u8];
    let wrote = unsafe { libc::write(sync_write, go.as_mut_ptr().cast(), 1) };
    unsafe { libc::close(sync_write) };
    if wrote != 1 {
        unsafe { libc::kill(pid as i32, libc::SIGKILL) };
        return Err(io::Error::last_os_error());
    }
    let ns_inode = namespace_inode(pid)?;
    let _ = argv_owned;
    Ok(ContainedSpawn {
        child: ContainedChild {
            pid,
            reaped: false,
            ns_inode,
        },
        stdin: unsafe { File::from_raw_fd(stdin_write) },
        stdout: unsafe { File::from_raw_fd(stdout_read) },
    })
}

#[cfg(target_os = "linux")]
struct LinuxSpawnArg {
    program: *const libc::c_char,
    argv: *const *const libc::c_char,
    envp: *const *const libc::c_char,
    cwd: *const libc::c_char,
    stdin_fd: RawFd,
    stdout_fd: RawFd,
    sync_fd: RawFd,
}

#[cfg(target_os = "linux")]
fn linux_child(arg: &LinuxSpawnArg) -> ! {
    let mut buf = [0u8; 1];
    unsafe {
        while libc::read(arg.sync_fd, buf.as_mut_ptr().cast(), 1) < 0 {
            if *libc::__errno_location() != libc::EINTR {
                libc::_exit(127);
            }
        }
        libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL);
        if libc::getppid() == 1 {
            libc::_exit(127);
        }
        if libc::chdir(arg.cwd) != 0 {
            libc::_exit(127);
        }
        let devnull = libc::open(c"/dev/null".as_ptr(), libc::O_WRONLY);
        if devnull >= 0 {
            libc::dup2(devnull, 2);
            libc::close(devnull);
        }
        libc::dup2(arg.stdin_fd, 0);
        libc::dup2(arg.stdout_fd, 1);
        libc::execve(arg.program, arg.argv, arg.envp);
        libc::_exit(127);
    }
}

#[cfg(target_os = "linux")]
fn write_id_maps(pid: u32) -> io::Result<()> {
    let uid = unsafe { libc::geteuid() };
    let gid = unsafe { libc::getegid() };
    std::fs::write(format!("/proc/{pid}/uid_map"), format!("0 {uid} 1\n"))?;
    std::fs::write(format!("/proc/{pid}/setgroups"), "deny\n")?;
    std::fs::write(format!("/proc/{pid}/gid_map"), format!("0 {gid} 1\n"))?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn namespace_inode(pid: u32) -> io::Result<u64> {
    let mut stat = unsafe { std::mem::zeroed::<libc::stat>() };
    let path = std::ffi::CString::new(format!("/proc/{pid}/ns/pid"))
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?;
    if unsafe { libc::stat(path.as_ptr(), &mut stat) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(stat.st_ino)
}

#[cfg(target_os = "linux")]
fn linux_namespace_has_other(inode: u64, root: u32) -> io::Result<bool> {
    let entries = std::fs::read_dir("/proc")?;
    for entry in entries.flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        if pid == root || pid == 0 {
            continue;
        }
        let Ok(found) = namespace_inode(pid) else {
            continue;
        };
        if found == inode {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(target_os = "linux")]
fn resolve_program(program: &Path) -> io::Result<std::path::PathBuf> {
    if program.components().count() > 1 || program.is_absolute() {
        return Ok(program.to_path_buf());
    }
    let path = std::env::var_os("PATH").unwrap_or_default();
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(program);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err(io::Error::new(io::ErrorKind::NotFound, "program not on PATH"))
}

#[cfg(target_os = "linux")]
fn inherited_env(remove: &[&str]) -> io::Result<Vec<std::ffi::CString>> {
    let mut out = Vec::new();
    for (key, value) in std::env::vars() {
        if remove.iter().any(|banned| key.eq_ignore_ascii_case(banned)) {
            continue;
        }
        let pair = format!("{key}={value}");
        if let Ok(c) = std::ffi::CString::new(pair) {
            out.push(c);
        }
    }
    Ok(out)
}

#[cfg(any(target_os = "linux", windows))]
fn pipe() -> io::Result<(RawFd, RawFd)> {
    let mut fds = [0; 2];
    #[cfg(target_os = "linux")]
    {
        if unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
            return Err(io::Error::last_os_error());
        }
        return Ok((fds[0], fds[1]));
    }
    #[cfg(windows)]
    {
        let _ = fds;
        Err(io::Error::new(io::ErrorKind::Unsupported, "windows pipes are created in windows_spawn"))
    }
}

#[cfg(windows)]
fn windows_spawn(
    program: &Path,
    args: &[String],
    cwd: &Path,
    env_remove: &[&str],
) -> io::Result<ContainedSpawn> {
    let _ = (program, args, cwd, env_remove);
    // The Windows job path is compiled here so the ownership domain exists in
    // the same module. The full suspended CreateProcess assignment is below.
    windows_spawn_in_job(program, args, cwd, env_remove)
}

#[cfg(windows)]
fn windows_spawn_in_job(
    program: &Path,
    args: &[String],
    cwd: &Path,
    _env_remove: &[&str],
) -> io::Result<ContainedSpawn> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::FromRawHandle;
    use winapi::um::handleapi::{CloseHandle, SetHandleInformation};
    use winapi::um::jobapi2::{
        AssignProcessToJobObject, CreateJobObjectW, QueryInformationJobObject, SetInformationJobObject,
        TerminateJobObject,
    };
    use winapi::um::minwinbase::SECURITY_ATTRIBUTES;
    use winapi::um::namedpipeapi::CreatePipe;
    use winapi::um::processthreadsapi::{CreateProcessW, ResumeThread, PROCESS_INFORMATION, STARTUPINFOW};
    use winapi::um::winbase::{
        CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW, CREATE_SUSPENDED, HANDLE_FLAG_INHERIT,
        STARTF_USESTDHANDLES,
    };
    use winapi::um::winnt::HANDLE;
    unsafe {
        let job = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
        if job.is_null() {
            return Err(io::Error::last_os_error());
        }
        #[repr(C)]
        struct BasicLimit {
            per_process_user_time_limit: i64,
            per_job_user_time_limit: i64,
            limit_flags: u32,
            minimum_working_set_size: usize,
            maximum_working_set_size: usize,
            active_process_limit: u32,
            affinity: usize,
            priority_class: u32,
            scheduling_class: u32,
        }
        #[repr(C)]
        struct ExtendedLimit {
            basic: BasicLimit,
            io_info: [u8; 48],
            process_memory_limit: usize,
            job_memory_limit: usize,
            peak_process_memory_used: usize,
            peak_job_memory_used: usize,
        }
        let mut limits = std::mem::zeroed::<ExtendedLimit>();
        limits.basic.limit_flags = 0x0000_2000;
        let _ = SetInformationJobObject(
            job,
            9,
            &mut limits as *mut _ as *mut _,
            std::mem::size_of::<ExtendedLimit>() as u32,
        );
        let mut sa = std::mem::zeroed::<SECURITY_ATTRIBUTES>();
        sa.nLength = std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32;
        sa.bInheritHandle = 1;
        let mut in_read: HANDLE = std::ptr::null_mut();
        let mut in_write: HANDLE = std::ptr::null_mut();
        let mut out_read: HANDLE = std::ptr::null_mut();
        let mut out_write: HANDLE = std::ptr::null_mut();
        if CreatePipe(&mut in_read, &mut in_write, &mut sa, 0) == 0
            || CreatePipe(&mut out_read, &mut out_write, &mut sa, 0) == 0
        {
            CloseHandle(job);
            return Err(io::Error::last_os_error());
        }
        SetHandleInformation(in_write, HANDLE_FLAG_INHERIT, 0);
        SetHandleInformation(out_read, HANDLE_FLAG_INHERIT, 0);
        let mut cmdline = std::ffi::OsString::from("\"");
        cmdline.push(program);
        cmdline.push("\"");
        for arg in args {
            cmdline.push(" ");
            cmdline.push(arg);
        }
        let mut wide: Vec<u16> = cmdline.encode_wide().chain(std::iter::once(0)).collect();
        let cwd_wide: Vec<u16> = cwd.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        let mut process_info = std::mem::zeroed::<PROCESS_INFORMATION>();
        let mut startup = std::mem::zeroed::<STARTUPINFOW>();
        startup.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
        startup.dwFlags = STARTF_USESTDHANDLES;
        startup.hStdInput = in_read;
        startup.hStdOutput = out_write;
        startup.hStdError = out_write;
        let ok = CreateProcessW(
            std::ptr::null(),
            wide.as_mut_ptr(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            1,
            CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP,
            std::ptr::null_mut(),
            cwd_wide.as_ptr(),
            &mut startup,
            &mut process_info,
        );
        CloseHandle(in_read);
        CloseHandle(out_write);
        if ok == 0 {
            CloseHandle(in_write);
            CloseHandle(out_read);
            CloseHandle(job);
            return Err(io::Error::last_os_error());
        }
        if AssignProcessToJobObject(job, process_info.hProcess) == 0 {
            TerminateJobObject(job, 1);
            CloseHandle(process_info.hThread);
            CloseHandle(process_info.hProcess);
            CloseHandle(in_write);
            CloseHandle(out_read);
            CloseHandle(job);
            return Err(io::Error::new(
                io::ErrorKind::Other,
                "AssignProcessToJobObject failed; the Runtime was not resumed",
            ));
        }
        if ResumeThread(process_info.hThread) == u32::MAX {
            TerminateJobObject(job, 1);
            CloseHandle(process_info.hThread);
            CloseHandle(process_info.hProcess);
            CloseHandle(in_write);
            CloseHandle(out_read);
            CloseHandle(job);
            return Err(io::Error::last_os_error());
        }
        CloseHandle(process_info.hThread);
        Ok(ContainedSpawn {
            child: ContainedChild {
                pid: process_info.dwProcessId,
                reaped: false,
                process: process_info.hProcess,
                job,
            },
            stdin: File::from_raw_handle(in_write as std::os::windows::io::RawHandle),
            stdout: File::from_raw_handle(out_read as std::os::windows::io::RawHandle),
        })
    }
}

#[cfg(windows)]
fn terminate_job(job: winapi::um::winnt::HANDLE) -> i32 {
    unsafe { winapi::um::jobapi2::TerminateJobObject(job, 1) }
}

#[cfg(windows)]
fn windows_job_has_other(job: winapi::um::winnt::HANDLE, root: u32) -> io::Result<bool> {
    #[repr(C)]
    struct List {
        assigned: u32,
        listed: u32,
        ids: [usize; 1],
    }
    let mut buffer = vec![0u8; std::mem::size_of::<List>() + 1024];
    let mut returned = 0u32;
    let ok = unsafe {
        winapi::um::jobapi2::QueryInformationJobObject(
            job,
            3,
            buffer.as_mut_ptr().cast(),
            buffer.len() as u32,
            &mut returned,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    let list = unsafe { &*buffer.as_ptr().cast::<List>() };
    let count = list.listed as usize;
    let ids = unsafe { std::slice::from_raw_parts(list.ids.as_ptr(), count) };
    Ok(ids.iter().any(|id| *id as u32 != root && *id != 0))
}

#[cfg(test)]
#[cfg(target_os = "linux")]
mod tests {
    use super::*;

    #[test]
    fn a_setsid_grandchild_dies_with_the_namespace_init() {
        let dir = std::env::temp_dir().join(format!("goalport-contain-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = "import os,time\nchild=os.fork()\nif child==0:\n os.setsid()\n open('setsid.pid','w').write(str(os.getpid()))\n time.sleep(30)\nelse:\n time.sleep(30)\n";
        let spawned = spawn_contained(
            Path::new("python3"),
            &[String::from("-c"), script.to_owned()],
            &dir,
            &[],
        )
        .expect("pid namespace spawn");
        let marker = dir.join("setsid.pid");
        let mut pid = None;
        for _ in 0..50 {
            if let Ok(text) = std::fs::read_to_string(&marker) {
                pid = text.trim().parse::<u32>().ok();
                if pid.is_some() {
                    break;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let _namespace_local_pid = pid.expect("setsid child started");
        assert!(
            spawned.child.extras_alive().expect("domain scan"),
            "the setsid grandchild must be inside the pid namespace before kill"
        );
        let inode = spawned.child.ns_inode;
        let root = spawned.child.id();
        let mut child = spawned.child;
        child.kill().expect("kill namespace init");
        let _ = child.wait();
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert!(
            !linux_namespace_has_other(inode, root).expect("post-kill scan")
                && namespace_inode(root).is_err(),
            "a setsid grandchild must die with the pid namespace"
        );
        let _ = std::fs::remove_file(marker);
    }
}
