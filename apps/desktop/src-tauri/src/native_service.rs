use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{Emitter, Manager};

const MAX_FRAME_BYTES: usize = 1024 * 1024;
const CALL_TIMEOUT: Duration = Duration::from_secs(5 * 60);

type PendingCalls = Arc<Mutex<HashMap<u64, mpsc::Sender<Result<Value, String>>>>>;

pub struct NativeServiceState {
    processes: Mutex<HashMap<String, Arc<NativeServiceProcess>>>,
    next_id: AtomicU64,
}

impl Default for NativeServiceState {
    fn default() -> Self {
        Self {
            processes: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
        }
    }
}

struct NativeServiceProcess {
    child: Mutex<Child>,
    stdin: Mutex<Option<ChildStdin>>,
    pending: PendingCalls,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeServiceEvent {
    app_id: String,
    event: String,
    payload: Value,
}

fn validate_app_id(value: &str) -> Result<&str, String> {
    if value.len() > 160
        || !value.contains('.')
        || !value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'-')
        })
    {
        return Err("native service app id is invalid".to_string());
    }
    Ok(value)
}

fn validate_command(value: &str) -> Result<&str, String> {
    if !value.starts_with("rcx-plugin-")
        || value.len() > 96
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err("native service command is invalid".to_string());
    }
    Ok(value)
}

fn executable_name(command: &str) -> String {
    if cfg!(windows) {
        format!("{command}.exe")
    } else {
        command.to_string()
    }
}

fn contained_file(root: &Path, file: &Path) -> Result<PathBuf, String> {
    let root = fs::canonicalize(root)
        .map_err(|error| format!("native service directory is unavailable: {error}"))?;
    let file = fs::canonicalize(file)
        .map_err(|error| format!("native service executable is unavailable: {error}"))?;
    if !file.starts_with(&root) || !file.is_file() {
        return Err("native service executable escaped its bundled directory".to_string());
    }
    Ok(file)
}

fn service_path(app: &tauri::AppHandle, command: &str) -> Result<PathBuf, String> {
    let root = app
        .path()
        .resource_dir()
        .map_err(|error| format!("failed to resolve native service resources: {error}"))?
        .join("plugins");
    contained_file(&root, &root.join(executable_name(command)))
}

fn service_data_dir(app: &tauri::AppHandle, app_id: &str) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("failed to resolve native service data directory: {error}"))?
        .join("native-services")
        .join(app_id);
    fs::create_dir_all(&directory)
        .map_err(|error| format!("failed to create native service data directory: {error}"))?;
    Ok(directory)
}

fn hidden_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
}

fn finish_pending(pending: &PendingCalls, message: &str) {
    if let Ok(mut calls) = pending.lock() {
        for (_, sender) in calls.drain() {
            let _ = sender.send(Err(message.to_string()));
        }
    }
}

fn read_output(
    app: tauri::AppHandle,
    app_id: String,
    stdout: std::process::ChildStdout,
    pending: PendingCalls,
) {
    for line in BufReader::new(stdout).lines() {
        let line = match line {
            Ok(line) if line.len() <= MAX_FRAME_BYTES => line,
            Ok(_) => continue,
            Err(_) => break,
        };
        let Ok(frame) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(id) = frame.get("id").and_then(Value::as_u64) {
            let sender = pending.lock().ok().and_then(|mut calls| calls.remove(&id));
            if let Some(sender) = sender {
                let response = frame
                    .get("error")
                    .and_then(|error| error.get("message"))
                    .and_then(Value::as_str)
                    .map(|message| Err(message.to_string()))
                    .unwrap_or_else(|| Ok(frame.get("result").cloned().unwrap_or(Value::Null)));
                let _ = sender.send(response);
            }
            continue;
        }
        if frame.get("method").and_then(Value::as_str) != Some("event") {
            continue;
        }
        let params = frame.get("params").cloned().unwrap_or(Value::Null);
        let event = params
            .get("event")
            .and_then(Value::as_str)
            .unwrap_or("event")
            .to_string();
        let payload = params.get("payload").cloned().unwrap_or(Value::Null);
        let _ = app.emit(
            "rocketx://native-service-event",
            NativeServiceEvent {
                app_id: app_id.clone(),
                event,
                payload,
            },
        );
    }
    finish_pending(&pending, "native service stopped before replying");
}

fn spawn_service(
    app: &tauri::AppHandle,
    app_id: &str,
    command: &str,
    args: &[String],
) -> Result<Arc<NativeServiceProcess>, String> {
    if args.len() > 16 || args.iter().any(|argument| argument.len() > 1024) {
        return Err("native service arguments exceed the safety limit".to_string());
    }
    let executable = service_path(app, command)?;
    let data_dir = service_data_dir(app, app_id)?;
    let mut child = hidden_command(executable)
        .args(args)
        .env("ROCKETX_NATIVE_SERVICE_DATA_DIR", data_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("failed to start native service: {error}"))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "native service stdin is unavailable".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "native service stdout is unavailable".to_string())?;
    let pending = Arc::new(Mutex::new(HashMap::new()));
    let process = Arc::new(NativeServiceProcess {
        child: Mutex::new(child),
        stdin: Mutex::new(Some(stdin)),
        pending: pending.clone(),
    });
    let reader_app = app.clone();
    let reader_app_id = app_id.to_string();
    thread::spawn(move || read_output(reader_app, reader_app_id, stdout, pending));
    Ok(process)
}

fn process_is_running(process: &NativeServiceProcess) -> bool {
    process
        .child
        .lock()
        .map(|mut child| matches!(child.try_wait(), Ok(None)))
        .unwrap_or(false)
}

fn stop_process(process: Arc<NativeServiceProcess>) {
    if let Ok(mut stdin) = process.stdin.lock() {
        stdin.take();
    }
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline {
        if !process_is_running(&process) {
            finish_pending(&process.pending, "native service stopped");
            return;
        }
        thread::sleep(Duration::from_millis(50));
    }
    if let Ok(mut child) = process.child.lock() {
        let _ = child.kill();
        let _ = child.wait();
    }
    finish_pending(&process.pending, "native service stopped");
}

#[tauri::command]
pub fn native_service_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, NativeServiceState>,
    app_id: String,
    command: String,
    args: Option<Vec<String>>,
) -> Result<(), String> {
    validate_app_id(&app_id)?;
    validate_command(&command)?;
    let mut processes = state
        .processes
        .lock()
        .map_err(|_| "native service registry is unavailable".to_string())?;
    if let Some(process) = processes.get(&app_id) {
        if process_is_running(process) {
            return Ok(());
        }
        processes.remove(&app_id);
    }
    let process = spawn_service(&app, &app_id, &command, &args.unwrap_or_default())?;
    processes.insert(app_id, process);
    Ok(())
}

#[tauri::command]
pub async fn native_service_call(
    state: tauri::State<'_, NativeServiceState>,
    app_id: String,
    method: String,
    params: Value,
) -> Result<Value, String> {
    validate_app_id(&app_id)?;
    if method.is_empty() || method.len() > 128 {
        return Err("native service method is invalid".to_string());
    }
    let process = state
        .processes
        .lock()
        .map_err(|_| "native service registry is unavailable".to_string())?
        .get(&app_id)
        .cloned()
        .ok_or_else(|| "native service is not running".to_string())?;
    if !process_is_running(&process) {
        return Err("native service is not running".to_string());
    }
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    let frame = serde_json::to_vec(&json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    }))
    .map_err(|error| format!("failed to encode native service request: {error}"))?;
    if frame.len() > MAX_FRAME_BYTES {
        return Err("native service request exceeds 1 MB".to_string());
    }
    let (sender, receiver) = mpsc::channel();
    process
        .pending
        .lock()
        .map_err(|_| "native service pending registry is unavailable".to_string())?
        .insert(id, sender);
    let write_result = process
        .stdin
        .lock()
        .map_err(|_| "native service stdin is unavailable".to_string())?
        .as_mut()
        .ok_or_else(|| "native service is stopping".to_string())?
        .write_all(&[frame, b"\n".to_vec()].concat());
    if let Err(error) = write_result {
        if let Ok(mut pending) = process.pending.lock() {
            pending.remove(&id);
        }
        return Err(format!("failed to write native service request: {error}"));
    }
    let response = tauri::async_runtime::spawn_blocking(move || {
        receiver
            .recv_timeout(CALL_TIMEOUT)
            .map_err(|_| "native service call timed out".to_string())?
    })
    .await
    .map_err(|error| format!("native service call task failed: {error}"))?;
    if response.is_err() {
        if let Ok(mut pending) = process.pending.lock() {
            pending.remove(&id);
        }
    }
    response
}

#[tauri::command]
pub fn native_service_stop(
    state: tauri::State<'_, NativeServiceState>,
    app_id: String,
) -> Result<(), String> {
    validate_app_id(&app_id)?;
    let process = state
        .processes
        .lock()
        .map_err(|_| "native service registry is unavailable".to_string())?
        .remove(&app_id);
    if let Some(process) = process {
        stop_process(process);
    }
    Ok(())
}

pub fn shutdown(app: &tauri::AppHandle) {
    let state = app.state::<NativeServiceState>();
    let processes = state
        .processes
        .lock()
        .map(|mut processes| {
            processes
                .drain()
                .map(|(_, process)| process)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for process in processes {
        stop_process(process);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_service_names_cannot_escape_bundled_directory() {
        assert!(validate_command("rcx-plugin-intranet-link").is_ok());
        assert!(validate_command("../rcx-plugin-intranet-link").is_err());
        assert!(validate_command("cmd.exe").is_err());
        assert!(validate_app_id("dev.rocketx.intranet-link").is_ok());
        assert!(validate_app_id("../escape").is_err());
    }

    #[cfg(windows)]
    #[test]
    fn native_services_do_not_create_a_console_window() {
        let output = hidden_command("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                r#"Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class ConsoleProbe { [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow(); }'; [ConsoleProbe]::GetConsoleWindow().ToInt64()"#,
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .expect("Windows console probe should start");
        assert!(
            output.status.success(),
            "Windows console probe failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "0");
    }
}
