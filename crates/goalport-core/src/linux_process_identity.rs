//! Linux process facts shared by Core and its detached launcher.

use super::{ProcessIdentity, ProcessObservation, display_path, file_sha256};
use std::{fs, path::PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ProcStat {
    parent_pid: u32,
    start_ticks: u64,
    state: char,
}

fn read_stat(pid: u32) -> Result<ProcStat, String> {
    let path = format!("/proc/{pid}/stat");
    let stat = fs::read_to_string(&path).map_err(|error| format!("{path}: {error}"))?;
    parse_stat(&path, &stat)
}

fn parse_stat(path: &str, stat: &str) -> Result<ProcStat, String> {
    // comm is parenthesized and may itself contain spaces and closing parentheses.
    // The last ')' ends comm; the following fields start with state (field 3).
    let (_, rest) = stat
        .rsplit_once(')')
        .ok_or_else(|| format!("{path}: malformed comm field"))?;
    let fields = rest.split_whitespace().collect::<Vec<_>>();
    if fields.len() < 20 {
        return Err(format!("{path}: missing process start field"));
    }
    let state = fields[0]
        .chars()
        .next()
        .ok_or_else(|| format!("{path}: missing process state"))?;
    let parent_pid = fields[1]
        .parse::<u32>()
        .map_err(|_| format!("{path}: invalid parent pid"))?;
    let start_ticks = fields[19]
        .parse::<u64>()
        .map_err(|_| format!("{path}: invalid process start field"))?;
    Ok(ProcStat {
        parent_pid,
        start_ticks,
        state,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stat_parser_handles_parentheses_inside_comm() {
        let mut fields = vec!["S", "123"];
        fields.extend(std::iter::repeat_n("0", 17));
        fields.push("456");
        let text = format!("9 (odd ) process name) {}", fields.join(" "));
        assert_eq!(
            parse_stat("/proc/9/stat", &text).unwrap(),
            ProcStat {
                parent_pid: 123,
                start_ticks: 456,
                state: 'S',
            }
        );
        assert!(parse_stat("/proc/9/stat", "9 (incomplete) S").is_err());
    }
}

fn created_ms(start_ticks: u64) -> Result<u64, String> {
    let boot_seconds = fs::read_to_string("/proc/stat")
        .map_err(|error| format!("/proc/stat: {error}"))?
        .lines()
        .find_map(|line| line.strip_prefix("btime "))
        .ok_or_else(|| "/proc/stat: missing btime".to_string())?
        .trim()
        .parse::<u64>()
        .map_err(|_| "/proc/stat: invalid btime".to_string())?;
    let ticks_per_second = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
    if ticks_per_second <= 0 {
        return Err("sysconf(_SC_CLK_TCK) failed".into());
    }
    let ticks_per_second = ticks_per_second as u64;
    boot_seconds
        .checked_mul(1000)
        .and_then(|boot_ms| {
            let whole_seconds = start_ticks / ticks_per_second;
            let fractional_ticks = start_ticks % ticks_per_second;
            whole_seconds
                .checked_mul(1000)
                .and_then(|whole_ms| boot_ms.checked_add(whole_ms))
                .and_then(|ms| ms.checked_add(fractional_ticks * 1000 / ticks_per_second))
        })
        .ok_or_else(|| "Linux process creation time overflowed".into())
}

fn creation_token(start_ticks: u64) -> Result<String, String> {
    let boot_id = fs::read_to_string("/proc/sys/kernel/random/boot_id")
        .map_err(|error| format!("/proc/sys/kernel/random/boot_id: {error}"))?;
    let boot_id = boot_id.trim();
    if boot_id.len() != 36
        || !boot_id.chars().enumerate().all(|(index, ch)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                ch == '-'
            } else {
                ch.is_ascii_hexdigit()
            }
        })
    {
        return Err("Linux boot ID is invalid".into());
    }
    Ok(format!("/LinuxStart({boot_id}:{start_ticks})/"))
}

fn existence_after_failure(pid: u32, cause: String) -> ProcessObservation {
    let rc = unsafe { libc::kill(pid as libc::pid_t, 0) };
    if rc == 0 {
        return ProcessObservation::Unknown(cause);
    }
    let errno = std::io::Error::last_os_error().raw_os_error().unwrap_or(-1);
    if errno == libc::ESRCH {
        ProcessObservation::NotRunning
    } else {
        ProcessObservation::Unknown(format!("{cause}; kill(0) errno {errno}"))
    }
}

pub(super) fn observe_process(pid: u32) -> ProcessObservation {
    if pid == 0 {
        return ProcessObservation::Unknown("pid 0 is not observable".into());
    }
    let first = match read_stat(pid) {
        Ok(stat) => stat,
        Err(cause) => return existence_after_failure(pid, cause),
    };
    if matches!(first.state, 'Z' | 'X' | 'x') {
        return ProcessObservation::NotRunning;
    }

    let exe_link = PathBuf::from(format!("/proc/{pid}/exe"));
    let executable_path = match fs::read_link(&exe_link) {
        Ok(path) => path,
        Err(error) => {
            return existence_after_failure(pid, format!("{}: {error}", exe_link.display()));
        }
    };
    let hash = file_sha256(&exe_link);
    if hash.is_empty() {
        return existence_after_failure(
            pid,
            format!("{}: executable unreadable", exe_link.display()),
        );
    }
    let second = match read_stat(pid) {
        Ok(stat) => stat,
        Err(cause) => return existence_after_failure(pid, cause),
    };
    if matches!(second.state, 'Z' | 'X' | 'x') {
        return ProcessObservation::NotRunning;
    }
    if second.start_ticks != first.start_ticks || second.parent_pid != first.parent_pid {
        return ProcessObservation::Unknown(format!(
            "process {pid} changed identity while it was observed"
        ));
    }
    let created_ms = match created_ms(first.start_ticks) {
        Ok(ms) if ms > 0 => ms,
        Ok(_) => return ProcessObservation::Unknown(format!("process {pid} has no creation time")),
        Err(cause) => return ProcessObservation::Unknown(cause),
    };
    let creation_token = match creation_token(first.start_ticks) {
        Ok(token) => token,
        Err(cause) => return ProcessObservation::Unknown(cause),
    };
    let path = display_path(&executable_path);
    // /proc/<pid>/exe appends this marker after unlink; it is still the same
    // running executable inode, whose content was hashed through the proc link.
    let path = path.strip_suffix(" (deleted)").unwrap_or(&path).to_owned();
    ProcessObservation::Live(ProcessIdentity {
        pid,
        parent_pid: first.parent_pid,
        executable_path: path,
        executable_sha256: hash,
        created_ms,
        creation_token: Some(creation_token),
    })
}
