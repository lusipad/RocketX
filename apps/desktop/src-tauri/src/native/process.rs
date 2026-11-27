use std::{
    ffi::OsStr,
    io::{self, Read},
    process::{Child, Command, ExitStatus, Output, Stdio},
    thread,
    time::{Duration, Instant},
};

pub(crate) const OWNED_TREE_STOP_TIMEOUT: Duration = Duration::from_secs(10);

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

/// Convert Windows extended path prefixes back to paths accepted by Node and
/// Tauri plugins.  The same normalization is used by every native adapter.
pub(crate) fn host_path(path: &std::path::Path) -> String {
    let value = path.to_string_lossy();
    #[cfg(windows)]
    {
        if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{rest}");
        }
        if let Some(rest) = value.strip_prefix(r"\\?\") {
            return rest.to_string();
        }
    }
    value.into_owned()
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

/// Bounds both capture memory and the time spent waiting for the process and its streams.
pub(crate) fn run_bounded_output(
    mut command: Command,
    timeout: Duration,
    byte_limit: usize,
) -> io::Result<Output> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let start = Instant::now();
    let capture = |reader: Box<dyn Read + Send>| {
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        thread::spawn(move || {
            let mut bytes = Vec::new();
            let result = reader
                .take(byte_limit.saturating_add(1) as u64)
                .read_to_end(&mut bytes)
                .map(|_| bytes);
            let _ = sender.send(result);
        });
        receiver
    };
    let stdout = capture(Box::new(child.stdout.take().expect("piped stdout")));
    let stderr = capture(Box::new(child.stderr.take().expect("piped stderr")));
    let status = match wait_for_exit(&mut child, timeout, Duration::from_millis(10)) {
        Ok(Some(status)) => status,
        Ok(None) => {
            kill_and_wait(&mut child)?;
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "owned probe timed out and was reaped",
            ));
        }
        Err(error) => {
            kill_and_wait(&mut child)?;
            return Err(error);
        }
    };
    let receive = |receiver: std::sync::mpsc::Receiver<io::Result<Vec<u8>>>| {
        let remaining = timeout.saturating_sub(start.elapsed());
        let bytes = receiver.recv_timeout(remaining).map_err(|_| {
            io::Error::new(
                io::ErrorKind::TimedOut,
                "owned probe streams did not close before deadline",
            )
        })??;
        if bytes.len() > byte_limit {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "owned probe output exceeded capture limit",
            ));
        }
        Ok(bytes)
    };
    Ok(Output {
        status,
        stdout: receive(stdout)?,
        stderr: receive(stderr)?,
    })
}

/// Only an owned, still-running child may be targeted. Never target a process by name.
pub(crate) fn kill_owned_tree_and_wait(
    child: &mut Child,
    timeout: Duration,
) -> io::Result<ExitStatus> {
    let started = Instant::now();
    if child.try_wait()?.is_some() {
        return Err(io::Error::other(
            "owned parent already exited; descendant state is unknown",
        ));
    }
    if timeout.is_zero() {
        return Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "owned tree stop deadline expired before termination",
        ));
    }
    #[cfg(windows)]
    {
        let root = std::env::var_os("SystemRoot")
            .map(std::path::PathBuf::from)
            .filter(|root| root.is_absolute())
            .ok_or_else(|| io::Error::other("Windows system directory is unavailable"))?;
        let taskkill = root.join("System32").join("taskkill.exe");
        if !taskkill.is_file() {
            return Err(io::Error::other(
                "Windows owned-tree termination is unavailable",
            ));
        }
        let mut command = hidden_command(taskkill);
        command.args(["/PID", &child.id().to_string(), "/T", "/F"]);
        let output = run_bounded_output(
            command,
            timeout.saturating_sub(started.elapsed()),
            16 * 1024,
        )?;
        if !output.status.success() {
            return Err(io::Error::other(format!(
                "owned process tree termination was not confirmed (exit {:?})",
                output.status.code()
            )));
        }
        wait_for_exit(
            child,
            timeout.saturating_sub(started.elapsed()),
            Duration::from_millis(10),
        )?
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::TimedOut,
                "owned parent exit was not confirmed before deadline",
            )
        })
    }
    #[cfg(not(windows))]
    {
        let pid_str = child.id().to_string();
        if let Ok(mut term_children) = hidden_command("pkill")
            .args(["-TERM", "-P", &pid_str])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            let _ = wait_for_exit(
                &mut term_children,
                Duration::from_millis(250),
                Duration::from_millis(10),
            );
        }
        let _ = child.kill();
        if let Some(status) = wait_for_exit(
            child,
            timeout.saturating_sub(started.elapsed()),
            Duration::from_millis(10),
        )? {
            return Ok(status);
        }
        if let Ok(mut kill_children) = hidden_command("pkill")
            .args(["-KILL", "-P", &pid_str])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            let _ = wait_for_exit(
                &mut kill_children,
                Duration::from_millis(250),
                Duration::from_millis(10),
            );
        }
        let _ = child.kill();
        wait_for_exit(child, Duration::from_millis(300), Duration::from_millis(10))?.ok_or_else(
            || {
                io::Error::new(
                    io::ErrorKind::TimedOut,
                    "owned parent exit was not confirmed before deadline",
                )
            },
        )
    }
}

#[cfg(test)]
mod tests {
    use super::{
        hidden_command, kill_and_wait, kill_owned_tree_and_wait, run_bounded_output, wait_for_exit,
        OWNED_TREE_STOP_TIMEOUT,
    };
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

    fn fixture_command(mode: &str) -> std::process::Command {
        let mut command = hidden_command(std::env::current_exe().unwrap());
        let module = module_path!().split_once("::").unwrap().1;
        command.args([
            "--exact",
            &format!("{module}::owned_tree_fixture"),
            "--ignored",
            "--nocapture",
        ]);
        command.env("ROCKETX_OWNED_PROCESS_FIXTURE", mode);
        command
    }

    #[test]
    #[ignore = "child fixture; only invoked by bounded process tests"]
    fn owned_tree_fixture() {
        match std::env::var("ROCKETX_OWNED_PROCESS_FIXTURE").as_deref() {
            Ok("sleep") => std::thread::sleep(Duration::from_secs(30)),
            Ok("flood") => {
                use std::io::Write;
                let _ = std::io::stdout().write_all(&vec![b'x'; 4096]);
                let _ = std::io::stderr().write_all(&vec![b'y'; 4096]);
            }
            Ok("tree") => {
                let mut child = fixture_command("sleep").spawn().unwrap();
                std::fs::write(
                    std::env::var_os("ROCKETX_OWNED_PROCESS_PID_FILE").unwrap(),
                    child.id().to_string(),
                )
                .unwrap();
                let _ = child.wait();
            }
            _ => {}
        }
    }

    #[test]
    fn bounded_probe_reaps_sleeping_fixture_and_releases_admission_gate() {
        let gate = std::sync::Mutex::new(());
        let start = std::time::Instant::now();
        {
            let _admission = gate.lock().unwrap();
            let error =
                run_bounded_output(fixture_command("sleep"), Duration::from_millis(750), 1024)
                    .unwrap_err();
            assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
        }
        assert!(start.elapsed() < Duration::from_secs(3));
        assert!(gate.try_lock().is_ok());
    }

    #[test]
    fn bounded_probe_rejects_output_over_the_capture_limit() {
        let error =
            run_bounded_output(fixture_command("flood"), Duration::from_secs(3), 1024).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
    }

    #[test]
    fn owned_tree_stop_rejects_already_exited_parent_without_targeting_its_pid() {
        let mut child = short_lived_child(0).spawn().unwrap();
        child.wait().unwrap();
        assert!(kill_owned_tree_and_wait(&mut child, Duration::from_secs(1)).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn owned_tree_stop_confirms_synthetic_descendant_has_exited() {
        use std::{ffi::c_void, ptr};
        #[link(name = "kernel32")]
        extern "system" {
            fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
            fn WaitForSingleObject(handle: *mut c_void, timeout: u32) -> u32;
            fn TerminateProcess(handle: *mut c_void, code: u32) -> i32;
            fn CloseHandle(handle: *mut c_void) -> i32;
        }
        struct OwnedFixtureHandle(*mut c_void);
        impl Drop for OwnedFixtureHandle {
            fn drop(&mut self) {
                unsafe {
                    if WaitForSingleObject(self.0, 0) != 0 {
                        TerminateProcess(self.0, 1);
                        WaitForSingleObject(self.0, 1000);
                    }
                    CloseHandle(self.0);
                }
            }
        }
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let marker = std::env::temp_dir().join(format!(
            "rocketx-owned-tree-{}-{stamp}.pid",
            std::process::id()
        ));
        let mut child = fixture_command("tree")
            .env("ROCKETX_OWNED_PROCESS_PID_FILE", &marker)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while !marker.exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        let pid: u32 = std::fs::read_to_string(&marker).unwrap().parse().unwrap();
        let handle = unsafe { OpenProcess(0x0010_0001, 0, pid) };
        assert_ne!(handle, ptr::null_mut());
        let handle = OwnedFixtureHandle(handle);
        let expired = kill_owned_tree_and_wait(&mut child, Duration::ZERO).unwrap_err();
        assert_eq!(expired.kind(), std::io::ErrorKind::TimedOut);
        assert!(child.try_wait().unwrap().is_none());
        assert_eq!(unsafe { WaitForSingleObject(handle.0, 0) }, 258);
        let stopped = kill_owned_tree_and_wait(&mut child, OWNED_TREE_STOP_TIMEOUT);
        if stopped.is_err() {
            let _ = kill_and_wait(&mut child);
        }
        assert!(stopped.is_ok(), "owned tree stop failed: {stopped:?}");
        assert_eq!(unsafe { WaitForSingleObject(handle.0, 1000) }, 0);
        assert!(child.try_wait().unwrap().is_some());
        std::fs::remove_file(marker).unwrap();
    }
}
