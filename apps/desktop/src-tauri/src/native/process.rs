use std::{
    ffi::OsStr,
    io,
    process::{Child, Command, ExitStatus},
    thread,
    time::{Duration, Instant},
};

/// Build a child-process command without opening a console window on Windows.
/// Runtime adapters use this same primitive so Codex and DSH launches have
/// identical desktop behavior.
pub(crate) fn hidden_command(program: impl AsRef<OsStr>) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
}

/// Wait for a child without blocking forever on a runtime that stopped
/// responding to its graceful shutdown request.
pub(crate) fn wait_for_exit(
    child: &mut Child,
    timeout: Duration,
    poll_interval: Duration,
) -> io::Result<Option<ExitStatus>> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(Some(status));
        }
        if Instant::now() >= deadline {
            return Ok(None);
        }
        thread::sleep(poll_interval);
    }
}

/// Kill and reap a child. Reaping is part of the contract: returning after
/// `kill` alone can leave a zombie on Unix and an owned process handle on
/// Windows.
pub(crate) fn kill_and_wait(child: &mut Child) -> io::Result<ExitStatus> {
    child.kill().or_else(|error| match child.try_wait()? {
        Some(_) => Ok(()),
        None => Err(error),
    })?;
    child.wait()
}

#[cfg(test)]
mod tests {
    use super::{hidden_command, kill_and_wait, wait_for_exit};
    use std::time::Duration;

    fn short_lived_child(exit_code: u8) -> std::process::Command {
        #[cfg(windows)]
        {
            let mut command = hidden_command("cmd.exe");
            command.args(["/C", &format!("exit {exit_code}")]);
            command
        }
        #[cfg(not(windows))]
        {
            let mut command = hidden_command("sh");
            command.args(["-c", &format!("exit {exit_code}")]);
            command
        }
    }

    fn long_lived_child() -> std::process::Command {
        #[cfg(windows)]
        {
            let mut command = hidden_command("cmd.exe");
            command.args(["/C", "ping 127.0.0.1 -n 30 > nul"]);
            command
        }
        #[cfg(not(windows))]
        {
            let mut command = hidden_command("sh");
            command.args(["-c", "sleep 30"]);
            command
        }
    }

    #[test]
    fn fake_child_exit_is_observed_and_reaped() {
        let mut child = short_lived_child(17).spawn().unwrap();
        let status = wait_for_exit(&mut child, Duration::from_secs(2), Duration::from_millis(5))
            .unwrap()
            .expect("fake child should exit");
        assert_eq!(status.code(), Some(17));
        assert!(child.try_wait().unwrap().is_some());
    }

    #[test]
    fn stop_path_kills_and_joins_fake_child() {
        let mut child = long_lived_child().spawn().unwrap();
        let status = kill_and_wait(&mut child).unwrap();
        assert!(!status.success());
        assert!(child.try_wait().unwrap().is_some());
    }
}
