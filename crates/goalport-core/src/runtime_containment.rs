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
use std::path::Path;
use std::process::ExitStatus;

#[cfg(target_os = "linux")]
use std::os::fd::{FromRawFd, RawFd};
#[cfg(unix)]
use std::os::unix::process::ExitStatusExt;
#[cfg(windows)]
use std::os::windows::process::ExitStatusExt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DomainOccupy {
    /// Every non-root member is identity-matched to the session baseline.
    /// The recorded root may remain and is not required to be in the baseline.
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
    // usize, not HANDLE: a raw pointer is not Send, and this child moves
    // across the Runtime thread.
    #[cfg(windows)]
    process: usize,
    #[cfg(windows)]
    job: usize,
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
            // 259 is both STILL_ACTIVE and a legal exit code. The handle is
            // the liveness check; the code is only read after it is signaled.
            let waited = unsafe { wait_for_single_object(self.process as _, 0) };
            if waited == 0x0000_0102 {
                return Ok(None);
            }
            if waited != 0 {
                return Err(io::Error::last_os_error());
            }
            let mut code = 0u32;
            let ok = unsafe {
                winapi::um::processthreadsapi::GetExitCodeProcess(self.process as _, &mut code)
            };
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
            self.reaped = true;
            return Ok(Some(ExitStatus::from_raw(code)));
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

    /// End the ownership domain even if the root handle was already reaped.
    /// Windows does not kill job members when the root process exits; only
    /// `TerminateJobObject` does. Linux namespace init death already took the
    /// tree, so a reaped root is a no-op here and `extras_alive` is the check.
    pub(crate) fn end_domain(&mut self) -> io::Result<()> {
        #[cfg(windows)]
        {
            let ok = unsafe { terminate_job(self.job as _) };
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
            return Ok(());
        }
        #[cfg(not(windows))]
        {
            if self.reaped {
                return Ok(());
            }
            self.kill()
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
            let ok = unsafe { terminate_job(self.job as _) };
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
            return Ok(());
        }
        #[cfg(not(any(target_os = "linux", windows)))]
        Err(io::Error::new(io::ErrorKind::Unsupported, "no containment domain"))
    }

    /// Every process in the ownership domain, including the root.
    /// An unreadable identity is `Err`, not a partial list.
    pub(crate) fn members(&self) -> io::Result<Vec<crate::descendants::DescendantRecord>> {
        #[cfg(target_os = "linux")]
        {
            return linux_namespace_members(self.ns_inode, self.pid);
        }
        #[cfg(windows)]
        {
            return windows_job_members(self.job as _, self.pid);
        }
        #[cfg(not(any(target_os = "linux", windows)))]
        {
            let _ = self;
            Err(io::Error::new(io::ErrorKind::Unsupported, "no containment domain"))
        }
    }

    pub(crate) fn extras_alive(&self) -> io::Result<bool> {
        #[cfg(target_os = "linux")]
        {
            return linux_namespace_has_other(self.ns_inode, self.pid);
        }
        #[cfg(windows)]
        {
            return windows_job_has_other(self.job as _, self.pid);
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
            winapi::um::handleapi::CloseHandle(self.process as _);
            winapi::um::handleapi::CloseHandle(self.job as _);
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
    // Closed on every early return, including clone and uid-map failure.
    let (stdin_r, stdin_w) = pipe()?;
    let mut stdin_read = FdGuard::new(stdin_r);
    let mut stdin_write = FdGuard::new(stdin_w);
    let (stdout_r, stdout_w) = pipe()?;
    let mut stdout_read = FdGuard::new(stdout_r);
    let mut stdout_write = FdGuard::new(stdout_w);
    let (sync_r, sync_w) = pipe()?;
    let mut sync_read = FdGuard::new(sync_r);
    let mut sync_write = FdGuard::new(sync_w);
    let (ack_r, ack_w) = pipe()?;
    let mut ack_read = FdGuard::new(ack_r);
    let mut ack_write = FdGuard::new(ack_w);
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
    // clone without CLONE_VM copies this address space. The parent may
    // drop these buffers after clone returns; the child already has its copy.
    let program_ptr = argv_owned[0].as_ptr();
    let mut arg = LinuxSpawnArg {
        program: program_ptr,
        argv: argv_ptrs.as_ptr(),
        envp: env_ptrs.as_ptr(),
        cwd: cwd_c.as_ptr(),
        stdin_fd: stdin_read.fd(),
        stdout_fd: stdout_write.fd(),
        sync_fd: sync_read.fd(),
        ack_fd: ack_write.fd(),
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
        libc::close(stdin_read.take());
        libc::close(stdout_write.take());
        libc::close(sync_read.take());
        libc::close(ack_write.take());
    }
    let pid = pid as u32;
    if let Err(error) = write_id_maps(pid) {
        kill_and_reap(pid);
        return Err(error);
    }
    // Do not send go until the child has armed PR_SET_PDEATHSIG. Inside a
    // pid namespace the outside parent is reported as pid 0, so getppid()
    // cannot tell a live Core from a dead one.
    let mut ack = [0u8; 1];
    let acked = unsafe { libc::read(ack_read.fd(), ack.as_mut_ptr().cast(), 1) };
    unsafe { libc::close(ack_read.take()) };
    if acked != 1 {
        kill_and_reap(pid);
        return Err(io::Error::new(
            io::ErrorKind::BrokenPipe,
            "contained child exited before arming parent-death",
        ));
    }
    let mut go = [1u8];
    let wrote = unsafe { libc::write(sync_write.fd(), go.as_mut_ptr().cast(), 1) };
    unsafe { libc::close(sync_write.take()) };
    if wrote != 1 {
        kill_and_reap(pid);
        return Err(io::Error::last_os_error());
    }
    let ns_inode = match namespace_inode(pid) {
        Ok(inode) => inode,
        Err(error) => {
            // The sync byte already let the child proceed toward exec.
            // A failed namespace capture must not leave that process untracked.
            kill_and_reap(pid);
            return Err(error);
        }
    };
    Ok(ContainedSpawn {
        child: ContainedChild {
            pid,
            reaped: false,
            ns_inode,
        },
        stdin: unsafe { File::from_raw_fd(stdin_write.take()) },
        stdout: unsafe { File::from_raw_fd(stdout_read.take()) },
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
    ack_fd: RawFd,
}

#[cfg(target_os = "linux")]
fn linux_child(arg: &LinuxSpawnArg) -> ! {
    let mut buf = [0u8; 1];
    unsafe {
        // Arm parent-death before blocking. If Core dies while this read
        // waits, the kernel delivers SIGKILL. A zero read is EOF: the parent
        // closed the pipe, so exec would run with nobody holding the domain.
        libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL);
        let ack = [1u8; 1];
        if libc::write(arg.ack_fd, ack.as_ptr().cast(), 1) != 1 {
            libc::_exit(127);
        }
        libc::close(arg.ack_fd);
        loop {
            let n = libc::read(arg.sync_fd, buf.as_mut_ptr().cast(), 1);
            if n < 0 {
                if *libc::__errno_location() == libc::EINTR {
                    continue;
                }
                libc::_exit(127);
            }
            if n == 0 {
                libc::_exit(127);
            }
            break;
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
fn kill_and_reap(pid: u32) {
    unsafe {
        libc::kill(pid as i32, libc::SIGKILL);
        let mut status = 0;
        while libc::waitpid(pid as i32, &mut status, 0) < 0 {
            if *libc::__errno_location() != libc::EINTR {
                break;
            }
        }
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
            // A zombie is not executing and cannot write or fork. Counting it
            // keeps a killed descendant blocking release until some parent reaps it.
            if process_state(pid) == Some('Z') {
                continue;
            }
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(target_os = "linux")]
fn linux_namespace_members(
    inode: u64,
    root: u32,
) -> io::Result<Vec<crate::descendants::DescendantRecord>> {
    let entries = std::fs::read_dir("/proc")?;
    let mut records = Vec::new();
    for entry in entries.flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        if pid == 0 {
            continue;
        }
        let Ok(found) = namespace_inode(pid) else {
            continue;
        };
        if found != inode {
            continue;
        }
        if process_state(pid) == Some('Z') {
            continue;
        }
        let Some(start_tick) = crate::descendants::start_tick(pid) else {
            return Err(io::Error::new(
                io::ErrorKind::Other,
                "a domain member identity could not be read",
            ));
        };
        records.push(crate::descendants::DescendantRecord { pid, start_tick });
    }
    if !records.iter().any(|record| record.pid == root) {
        return Err(io::Error::new(
            io::ErrorKind::Other,
            "the domain root was not in the namespace listing",
        ));
    }
    records.sort_by_key(|record| record.pid);
    Ok(records)
}

/// The recorded root may remain and is not part of the baseline.
/// Any other member must match `(pid, startTick)`. A reused pid is occupied.
pub(crate) fn classify_domain(
    members: &[crate::descendants::DescendantRecord],
    root: u32,
    baseline: &[crate::descendants::DescendantRecord],
) -> DomainOccupy {
    for member in members {
        if member.pid == root || member.pid == 0 {
            continue;
        }
        let matched = baseline.iter().any(|known| {
            known.pid == member.pid && known.start_tick == member.start_tick
        });
        if !matched {
            return DomainOccupy::Occupied;
        }
    }
    DomainOccupy::Empty
}

#[cfg(target_os = "linux")]
fn process_state(pid: u32) -> Option<char> {
    let text = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let after = text.rsplit(')').next()?;
    after.split_whitespace().next()?.chars().next()
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
    use std::os::unix::ffi::OsStrExt;
    let mut out = Vec::new();
    for (key, value) in std::env::vars_os() {
        if remove.iter().any(|banned| key.eq_ignore_ascii_case(banned)) {
            continue;
        }
        let mut pair = key.as_bytes().to_vec();
        pair.push(b'=');
        pair.extend_from_slice(value.as_bytes());
        if let Ok(c) = std::ffi::CString::new(pair) {
            out.push(c);
        }
    }
    Ok(out)
}

#[cfg(target_os = "linux")]
struct FdGuard(RawFd);

#[cfg(target_os = "linux")]
impl FdGuard {
    fn new(fd: RawFd) -> Self {
        Self(fd)
    }

    fn fd(&self) -> RawFd {
        self.0
    }

    fn take(&mut self) -> RawFd {
        let fd = self.0;
        self.0 = -1;
        fd
    }
}

#[cfg(target_os = "linux")]
impl Drop for FdGuard {
    fn drop(&mut self) {
        if self.0 >= 0 {
            unsafe { libc::close(self.0) };
        }
    }
}

#[cfg(target_os = "linux")]
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
    env_remove: &[&str],
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
    use winapi::um::processthreadsapi::{CreateProcessW, ResumeThread, TerminateProcess, PROCESS_INFORMATION, STARTUPINFOW};
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
        if SetInformationJobObject(
            job,
            9,
            &mut limits as *mut _ as *mut _,
            std::mem::size_of::<ExtendedLimit>() as u32,
        ) == 0
        {
            CloseHandle(job);
            return Err(io::Error::new(
                io::ErrorKind::Other,
                "SetInformationJobObject failed; Claude was not started without kill-on-close",
            ));
        }
        let mut sa = std::mem::zeroed::<SECURITY_ATTRIBUTES>();
        sa.nLength = std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32;
        sa.bInheritHandle = 1;
        let mut in_read: HANDLE = std::ptr::null_mut();
        let mut in_write: HANDLE = std::ptr::null_mut();
        let mut out_read: HANDLE = std::ptr::null_mut();
        let mut out_write: HANDLE = std::ptr::null_mut();
        if CreatePipe(&mut in_read, &mut in_write, &mut sa, 0) == 0 {
            CloseHandle(job);
            return Err(io::Error::last_os_error());
        }
        if CreatePipe(&mut out_read, &mut out_write, &mut sa, 0) == 0 {
            let error = io::Error::last_os_error();
            CloseHandle(in_read);
            CloseHandle(in_write);
            CloseHandle(job);
            return Err(error);
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
        let mut env_block = windows_env_block(env_remove);
        let ok = CreateProcessW(
            std::ptr::null(),
            wide.as_mut_ptr(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            1,
            CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | 0x0000_0400,
            env_block.as_mut_ptr().cast(),
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
            // The process is not in the job, so the job terminator cannot
            // reach it. It is still suspended; end it directly.
            TerminateProcess(process_info.hProcess, 1);
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
                process: process_info.hProcess as usize,
                job: job as usize,
            },
            stdin: File::from_raw_handle(in_write as std::os::windows::io::RawHandle),
            stdout: File::from_raw_handle(out_read as std::os::windows::io::RawHandle),
        })
    }
}

#[cfg(windows)]
fn windows_env_block(remove: &[&str]) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    let mut block = Vec::new();
    for (key, value) in std::env::vars_os() {
        if remove.iter().any(|banned| key.eq_ignore_ascii_case(banned)) {
            continue;
        }
        block.extend(key.encode_wide());
        block.push(u16::from(b'='));
        block.extend(value.encode_wide());
        block.push(0);
    }
    block.push(0);
    block
}

#[cfg(windows)]
fn wait_for_single_object(handle: winapi::um::winnt::HANDLE, milliseconds: u32) -> u32 {
    unsafe extern "system" {
        fn WaitForSingleObject(handle: winapi::um::winnt::HANDLE, milliseconds: u32) -> u32;
    }
    unsafe { WaitForSingleObject(handle, milliseconds) }
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

#[cfg(windows)]
fn windows_job_members(
    job: winapi::um::winnt::HANDLE,
    root: u32,
) -> io::Result<Vec<crate::descendants::DescendantRecord>> {
    #[repr(C)]
    struct List {
        assigned: u32,
        listed: u32,
        ids: [usize; 1],
    }
    let mut buffer = vec![0u8; std::mem::size_of::<List>() + 4096];
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
    if list.listed != list.assigned {
        return Err(io::Error::new(
            io::ErrorKind::Other,
            "job membership listing is incomplete",
        ));
    }
    let count = list.listed as usize;
    let ids = unsafe { std::slice::from_raw_parts(list.ids.as_ptr(), count) };
    let mut records = Vec::new();
    for id in ids {
        let pid = *id as u32;
        if pid == 0 {
            continue;
        }
        let Some(start_tick) = crate::descendants::start_tick(pid) else {
            return Err(io::Error::new(
                io::ErrorKind::Other,
                "a job member identity could not be read",
            ));
        };
        records.push(crate::descendants::DescendantRecord { pid, start_tick });
    }
    if !records.iter().any(|record| record.pid == root) {
        return Err(io::Error::new(
            io::ErrorKind::Other,
            "the job root was not in the membership listing",
        ));
    }
    records.sort_by_key(|record| record.pid);
    Ok(records)
}

#[cfg(test)]
#[cfg(target_os = "linux")]
mod tests {
    use super::*;

    fn record(pid: u32, tick: &str) -> crate::descendants::DescendantRecord {
        crate::descendants::DescendantRecord {
            pid,
            start_tick: tick.to_owned(),
        }
    }

    #[test]
    fn inherited_env_drops_provider_keys_without_utf8_panic() {
        let env = inherited_env(&["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "XAI_API_KEY"]).unwrap();
        for entry in env {
            let text = entry.to_string_lossy().to_ascii_uppercase();
            assert!(!text.starts_with("ANTHROPIC_API_KEY="));
            assert!(!text.starts_with("OPENAI_API_KEY="));
            assert!(!text.starts_with("XAI_API_KEY="));
        }
    }

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
        for _ in 0..250 {
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

    #[test]
    fn a_zombie_in_the_namespace_is_not_an_extra() {
        let dir = std::env::temp_dir().join(format!("goalport-zombie-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = "import os,time\nchild=os.fork()\nif child==0:\n os._exit(0)\nopen('zombie.ready','w').write('1')\ntime.sleep(30)\n";
        let spawned = spawn_contained(
            Path::new("python3"),
            &[String::from("-c"), script.to_owned()],
            &dir,
            &[],
        )
        .expect("pid namespace spawn");
        let marker = dir.join("zombie.ready");
        for _ in 0..250 {
            if marker.is_file() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(marker.is_file(), "zombie parent did not start");
        let mut quiet = false;
        for _ in 0..50 {
            if spawned.child.extras_alive().expect("domain scan") == false {
                quiet = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(quiet, "a zombie must not keep the domain occupied");
        let mut child = spawned.child;
        child.kill().expect("kill namespace init");
        let _ = child.wait();
        let _ = std::fs::remove_file(marker);
    }

    #[test]
    fn domain_classification_allows_only_identity_matched_baseline() {
        let root = record(1, "root-tick");
        let helper = record(2, "helper-tick");
        let baseline = [helper.clone()];
        assert_eq!(
            classify_domain(&[root.clone(), helper.clone()], root.pid, &baseline),
            DomainOccupy::Empty
        );
        assert_eq!(
            classify_domain(&[root.clone()], root.pid, &[]),
            DomainOccupy::Empty,
            "the root may remain and is not a baseline member"
        );
        assert_eq!(
            classify_domain(
                &[root.clone(), helper.clone(), record(3, "turn-tick")],
                root.pid,
                &baseline
            ),
            DomainOccupy::Occupied
        );
        assert_eq!(
            classify_domain(&[root.clone(), record(2, "other-tick")], root.pid, &baseline),
            DomainOccupy::Occupied
        );
        assert_eq!(
            classify_domain(&[root.clone(), helper], root.pid, &[]),
            DomainOccupy::Occupied
        );
    }

    #[test]
    fn domain_members_carry_the_snapshot_identity() {
        let dir = std::env::temp_dir().join(format!(
            "goalport-members-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let script = "import os,time\nchild=os.fork()\nif child==0:\n status=open('/proc/self/status').read()\n host=[line.split()[1] for line in status.splitlines() if line.startswith('NSpid:')][0]\n open('sleeper.pid','w').write(host)\n time.sleep(30)\nelse:\n time.sleep(30)\n";
        let spawned = spawn_contained(
            Path::new("python3"),
            &[String::from("-c"), script.to_owned()],
            &dir,
            &[],
        )
        .expect("pid namespace spawn");
        let marker = dir.join("sleeper.pid");
        let mut sleeper = None;
        for _ in 0..250 {
            if let Ok(text) = std::fs::read_to_string(&marker) {
                sleeper = text.trim().parse::<u32>().ok();
                if sleeper.is_some() {
                    break;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let sleeper = sleeper.expect("sleeper host pid");
        let members = spawned.child.members().expect("members");
        let root = spawned.child.id();
        let sleeper_record = members
            .iter()
            .find(|member| member.pid == sleeper)
            .cloned()
            .expect("sleeper is a domain member");
        let tick = crate::descendants::start_tick(sleeper).expect("sleeper tick");
        assert_eq!(sleeper_record.start_tick, tick);
        let snapshot = crate::descendants::snapshot_descendants(root).expect("snapshot");
        assert!(
            snapshot.iter().any(|member| {
                member.pid == sleeper && member.start_tick == sleeper_record.start_tick
            }),
            "members and the descendant snapshot share one identity: {snapshot:?} {members:?}"
        );
        assert_eq!(
            classify_domain(&members, root, &members),
            DomainOccupy::Empty,
            "a domain classified against itself is empty once the root is exempt"
        );
        let mut child = spawned.child;
        child.kill().expect("kill");
        let _ = child.wait();
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(all(test, windows))]
mod windows_job_tests {
    use super::*;
    use std::path::Path;

    fn pid_still_running(pid: u32) -> bool {
        unsafe {
            let handle = winapi::um::processthreadsapi::OpenProcess(0x0010_1000, 0, pid);
            if handle.is_null() {
                return false;
            }
            let waited = super::wait_for_single_object(handle, 0);
            winapi::um::handleapi::CloseHandle(handle);
            waited == 0x0000_0102
        }
    }

    #[test]
    fn a_breakaway_attempt_child_dies_with_the_job() {
        let dir = std::env::temp_dir().join(format!("goalport-job-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("breakaway.ps1");
        std::fs::write(
            &script,
            r#"Set-Content -LiteralPath 'started.txt' -Value 'started'
$ErrorActionPreference = 'Stop'
trap { Set-Content -LiteralPath 'error.txt' -Value $_.Exception.Message; exit 1 }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class GoalPortBreakaway {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct STARTUPINFO {
    public int cb; public IntPtr lpReserved; public IntPtr lpDesktop; public IntPtr lpTitle;
    public int dwX; public int dwY; public int dwXSize; public int dwYSize;
    public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute; public int dwFlags;
    public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2;
    public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION {
    public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId;
  }
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool CreateProcess(IntPtr app, System.Text.StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, IntPtr dir, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
}
'@
$si = New-Object GoalPortBreakaway+STARTUPINFO
$si.cb = [Runtime.InteropServices.Marshal]::SizeOf($si)
$pi = New-Object GoalPortBreakaway+PROCESS_INFORMATION
$cmd = New-Object System.Text.StringBuilder 'C:\Windows\System32\ping.exe -n 40 127.0.0.1'
$ok = [GoalPortBreakaway]::CreateProcess([IntPtr]::Zero, $cmd, [IntPtr]::Zero, [IntPtr]::Zero, $false, 0x01000000, [IntPtr]::Zero, [IntPtr]::Zero, [ref]$si, [ref]$pi)
$err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
if (-not $ok) {
  $cmd = New-Object System.Text.StringBuilder 'C:\Windows\System32\ping.exe -n 40 127.0.0.1'
  $ok2 = [GoalPortBreakaway]::CreateProcess([IntPtr]::Zero, $cmd, [IntPtr]::Zero, [IntPtr]::Zero, $false, 0, [IntPtr]::Zero, [IntPtr]::Zero, [ref]$si, [ref]$pi)
  if (-not $ok2) { throw "child spawn failed $err" }
  Set-Content -LiteralPath 'breakaway.txt' -Value "denied $err pid $($pi.dwProcessId)"
} else {
  Set-Content -LiteralPath 'breakaway.txt' -Value "allowed pid $($pi.dwProcessId)"
}
Start-Sleep -Seconds 45
"#,
        )
        .unwrap();
        let powershell = Path::new(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe");
        let spawned = spawn_contained(
            powershell,
            &[
                "-NoProfile".into(),
                "-ExecutionPolicy".into(),
                "Bypass".into(),
                "-File".into(),
                script.display().to_string(),
            ],
            &dir,
            &[],
        )
        .expect("contained powershell");
        let marker = dir.join("breakaway.txt");
        let mut text = String::new();
        for _ in 0..250 {
            if let Ok(read) = std::fs::read_to_string(&marker) {
                if read.contains("pid ") {
                    text = read;
                    break;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(40));
        }
        let started = dir.join("started.txt");
        let error_file = dir.join("error.txt");
        let error_text = std::fs::read_to_string(&error_file).unwrap_or_default();
        eprintln!("breakaway-result {text}");
        assert!(
            !text.is_empty(),
            "breakaway attempt did not record a child; started={} root={} error={}",
            started.is_file(),
            pid_still_running(spawned.child.id()),
            error_text
        );
        let pid: u32 = text
            .split("pid ")
            .nth(1)
            .and_then(|rest| rest.split_whitespace().next())
            .and_then(|value| value.parse().ok())
            .expect("child pid");
        assert!(pid_still_running(pid), "child {pid} was not alive: {text}");
        assert!(
            spawned.child.extras_alive().expect("domain scan"),
            "the child must be inside the job before it is ended: {text}"
        );
        let mut child = spawned.child;
        child.end_domain().expect("end job");
        let mut dead = false;
        for _ in 0..50 {
            if !pid_still_running(pid) && child.extras_alive().ok() == Some(false) {
                dead = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(40));
        }
        assert!(dead, "breakaway-attempt child {pid} survived the job: {text}");
        let _ = child.wait();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn job_members_carry_the_snapshot_identity() {
        let dir = std::env::temp_dir().join(format!(
            "goalport-job-members-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let spawned = spawn_contained(
            Path::new("cmd"),
            &[
                String::from("/c"),
                String::from("ping 127.0.0.1 -n 6 > nul"),
            ],
            &dir,
            &[],
        )
        .expect("job spawn");
        let members = spawned.child.members().expect("job members");
        let root = spawned.child.id();
        assert!(
            members.iter().any(|member| member.pid == root),
            "the job root is listed: {members:?}"
        );
        assert_eq!(classify_domain(&members, root, &members), DomainOccupy::Empty);
        let mut child = spawned.child;
        child.kill().expect("kill job");
        let _ = child.wait();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
