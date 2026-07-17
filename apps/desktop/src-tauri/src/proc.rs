use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Output, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

const CODEX_VERSION: &str = "0.144.4";
const CODEX_RUNNER_IMAGE: &str = "rocketx/codex-runner:0.144.4";
const MAX_MESSAGE_BYTES: usize = 2 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES: usize = 10 * 1024 * 1024;
const RUNNER_WORKSPACE: &str = "/workspace";
const RUNNER_ATTACHMENTS: &str = "/workspace/.rocketx-agent/attachments";
const RUNNER_AUTH_FILE: &str = "/home/node/.codex/auth.json";
const RUNNER_CONFIG: &str = include_str!("../../agent-runner/runner.config.toml");

#[derive(Clone)]
struct ManagedCodex {
    process_id: String,
    session_id: String,
    container_name: String,
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<ChildStdin>>,
    attachments_dir: PathBuf,
    version: String,
}

#[derive(Default)]
pub struct CodexAppServerState {
    processes: Arc<Mutex<HashMap<String, ManagedCodex>>>,
    next_id: AtomicU64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexProcessInfo {
    process_id: String,
    version: String,
    runtime_workspace_root: &'static str,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexOutputEvent {
    process_id: String,
    stream: &'static str,
    line: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexExitEvent {
    process_id: String,
    code: Option<i32>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRunnerStatus {
    docker_available: bool,
    image_ready: bool,
    authenticated: bool,
    version: Option<String>,
}

fn hidden_command(program: &str) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
}

fn run_output(mut command: Command) -> Result<Output, String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| format!("Docker 不可用：{error}"))
}

fn successful_output(output: &Output) -> Option<String> {
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn codex_auth_file() -> Option<PathBuf> {
    let direct = std::env::var_os("CODEX_HOME").map(PathBuf::from);
    let base = direct.or_else(|| {
        #[cfg(windows)]
        let value = std::env::var_os("USERPROFILE");
        #[cfg(not(windows))]
        let value = std::env::var_os("HOME");
        value.map(|path| PathBuf::from(path).join(".codex"))
    })?;
    let auth = base.join("auth.json");
    auth.is_file().then_some(auth)
}

fn runner_status() -> CodexRunnerStatus {
    let mut docker = hidden_command("docker");
    docker.args(["version", "--format", "{{.Server.Version}}"]);
    let docker_available = run_output(docker)
        .ok()
        .and_then(|output| successful_output(&output))
        .is_some_and(|value| !value.is_empty());
    if !docker_available {
        return CodexRunnerStatus {
            docker_available: false,
            image_ready: false,
            authenticated: codex_auth_file().is_some(),
            version: None,
        };
    }

    let mut inspect = hidden_command("docker");
    inspect.args(["image", "inspect", CODEX_RUNNER_IMAGE]);
    let image_exists = run_output(inspect)
        .ok()
        .is_some_and(|output| output.status.success());
    let version = image_exists
        .then(|| {
            let mut probe = hidden_command("docker");
            probe.args([
                "run",
                "--rm",
                "--network",
                "none",
                CODEX_RUNNER_IMAGE,
                "--version",
            ]);
            run_output(probe)
                .ok()
                .and_then(|output| successful_output(&output))
                .and_then(|value| value.strip_prefix("codex-cli ").map(ToOwned::to_owned))
        })
        .flatten();
    let image_ready = version.as_deref() == Some(CODEX_VERSION);
    CodexRunnerStatus {
        docker_available,
        image_ready,
        authenticated: codex_auth_file().is_some(),
        version,
    }
}

fn runner_dockerfile(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let bundled = app
        .path()
        .resource_dir()
        .map_err(|error| format!("无法定位 RocketX 资源目录：{error}"))?
        .join("agent-runner")
        .join("Dockerfile");
    if bundled.is_file() {
        return Ok(bundled);
    }
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("agent-runner")
        .join("Dockerfile");
    development
        .is_file()
        .then_some(development)
        .ok_or_else(|| "找不到内置 Agent Runner Dockerfile".to_string())
}

#[tauri::command]
pub fn codex_runner_status() -> CodexRunnerStatus {
    runner_status()
}

#[tauri::command]
pub async fn codex_runner_install(app: tauri::AppHandle) -> Result<CodexRunnerStatus, String> {
    let dockerfile = runner_dockerfile(&app)?;
    let context = dockerfile
        .parent()
        .ok_or_else(|| "Agent Runner 构建目录无效".to_string())?
        .to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        let mut build = hidden_command("docker");
        build
            .arg("build")
            .args(["--tag", CODEX_RUNNER_IMAGE, "--file"])
            .arg(&dockerfile)
            .arg(context);
        let output = run_output(build)?;
        if !output.status.success() {
            let detail = String::from_utf8_lossy(&output.stderr);
            return Err(format!(
                "Agent Runner 构建失败：{}",
                detail
                    .lines()
                    .rev()
                    .take(8)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect::<Vec<_>>()
                    .join("\n")
            ));
        }
        let status = runner_status();
        if status.image_ready {
            Ok(status)
        } else {
            Err("Agent Runner 构建完成但镜像校验失败".to_string())
        }
    })
    .await
    .map_err(|error| format!("Agent Runner 构建任务失败：{error}"))?
}

fn validate_session_id(session_id: &str) -> Result<(), String> {
    if session_id.is_empty()
        || session_id.len() > 80
        || !session_id
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || value == '-')
    {
        return Err("invalid Agent session id".to_string());
    }
    Ok(())
}

fn canonical_directory(path: &str) -> Result<PathBuf, String> {
    let resolved =
        std::fs::canonicalize(path).map_err(|error| format!("Agent 工作区不可用：{error}"))?;
    if !resolved.is_dir() {
        return Err("Agent 工作区必须是目录".to_string());
    }
    Ok(resolved)
}

fn docker_host_path(path: &Path) -> String {
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

fn volume(path: &Path, target: &str, read_only: bool) -> String {
    format!(
        "{}:{target}{}",
        docker_host_path(path),
        if read_only { ":ro" } else { "" }
    )
}

fn prepare_runtime_home(app: &tauri::AppHandle, session_id: &str) -> Result<PathBuf, String> {
    let path = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("无法定位应用缓存目录：{error}"))?
        .join("agent-runtime")
        .join(session_id)
        .join("codex-home");
    std::fs::create_dir_all(&path).map_err(|error| format!("无法准备 Agent 会话目录：{error}"))?;
    std::fs::write(path.join("config.toml"), RUNNER_CONFIG)
        .map_err(|error| format!("无法写入 Agent 权限配置：{error}"))?;
    Ok(path)
}

fn prepare_attachments_dir(runtime_home: &Path) -> Result<PathBuf, String> {
    let path = runtime_home
        .parent()
        .ok_or_else(|| "Agent 会话目录无效".to_string())?
        .join("attachments");
    std::fs::create_dir_all(&path).map_err(|error| format!("无法准备 Agent 附件目录：{error}"))?;
    Ok(path)
}

fn cleanup_container(container_name: &str) {
    let mut remove = hidden_command("docker");
    remove.args(["rm", "--force", container_name]);
    let _ = run_output(remove);
}

fn spawn_reader<R: std::io::Read + Send + 'static>(
    app: tauri::AppHandle,
    process_id: String,
    stream: &'static str,
    reader: R,
) {
    thread::spawn(move || {
        for line in BufReader::new(reader).lines() {
            let Ok(line) = line else { break };
            let _ = app.emit(
                "codex-app-server-output",
                CodexOutputEvent {
                    process_id: process_id.clone(),
                    stream,
                    line,
                },
            );
        }
    });
}

fn monitor_child(
    app: tauri::AppHandle,
    state: Arc<Mutex<HashMap<String, ManagedCodex>>>,
    process_id: String,
    container_name: String,
    child: Arc<Mutex<Child>>,
) {
    thread::spawn(move || loop {
        let status = match child.lock() {
            Ok(mut child) => child.try_wait(),
            Err(_) => return,
        };
        match status {
            Ok(Some(status)) => {
                let owned = state
                    .lock()
                    .map(|mut processes| processes.remove(&process_id).is_some())
                    .unwrap_or(false);
                if owned {
                    cleanup_container(&container_name);
                }
                let _ = app.emit(
                    "codex-app-server-exit",
                    CodexExitEvent {
                        process_id,
                        code: status.code(),
                    },
                );
                return;
            }
            Ok(None) => thread::sleep(Duration::from_millis(100)),
            Err(_) => return,
        }
    });
}

fn encode_message(message: serde_json::Value) -> Result<Vec<u8>, String> {
    if !message.is_object() {
        return Err("Codex app-server message must be a JSON object".to_string());
    }
    let mut bytes = serde_json::to_vec(&message)
        .map_err(|error| format!("failed to encode Codex message: {error}"))?;
    if bytes.len() > MAX_MESSAGE_BYTES {
        return Err("Codex app-server message exceeds 2 MiB".to_string());
    }
    bytes.push(b'\n');
    Ok(bytes)
}

#[tauri::command]
pub fn codex_app_server_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, CodexAppServerState>,
    session_id: String,
    workspace_root: String,
) -> Result<CodexProcessInfo, String> {
    validate_session_id(&session_id)?;
    let status = runner_status();
    if !status.docker_available {
        return Err("共享 Agent 需要正在运行的 Docker Desktop".to_string());
    }
    if !status.image_ready {
        return Err("隔离 Agent Runner 尚未安装，请先在 AI 设置中安装".to_string());
    }
    let auth_file =
        codex_auth_file().ok_or_else(|| "Codex 尚未登录，请先执行 codex login".to_string())?;
    let workspace = canonical_directory(&workspace_root)?;
    let runtime_home = prepare_runtime_home(&app, &session_id)?;
    let attachments_dir = prepare_attachments_dir(&runtime_home)?;
    let container_name = format!("rocketx-agent-{}", session_id.to_ascii_lowercase());

    let mut processes = state
        .processes
        .lock()
        .map_err(|_| "Codex process registry is unavailable".to_string())?;
    if let Some(process) = processes
        .values()
        .find(|process| process.session_id == session_id)
    {
        return Ok(CodexProcessInfo {
            process_id: process.process_id.clone(),
            version: process.version.clone(),
            runtime_workspace_root: RUNNER_WORKSPACE,
        });
    }
    cleanup_container(&container_name);

    let mut command = hidden_command("docker");
    command
        .args(["run", "--rm", "--interactive", "--name"])
        .arg(&container_name)
        .args([
            "--workdir",
            RUNNER_WORKSPACE,
            "--read-only",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--security-opt",
            "seccomp=unconfined",
            "--pids-limit",
            "256",
            "--memory",
            "2g",
            "--cpus",
            "2",
            "--tmpfs",
            "/tmp:rw,noexec,nosuid,size=256m",
            "--tmpfs",
            "/run:rw,noexec,nosuid,size=16m",
            "--label",
        ])
        .arg(format!("com.lusipad.rocketx.session={session_id}"))
        .arg("--volume")
        .arg(volume(&workspace, RUNNER_WORKSPACE, false))
        .arg("--volume")
        .arg(volume(&attachments_dir, RUNNER_ATTACHMENTS, true))
        .arg("--volume")
        .arg(volume(&runtime_home, "/home/node/.codex", false))
        .arg("--volume")
        .arg(volume(&auth_file, RUNNER_AUTH_FILE, true))
        .args([CODEX_RUNNER_IMAGE, "app-server", "--stdio"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("无法启动隔离 Codex app-server：{error}"))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Codex app-server stdin is unavailable".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Codex app-server stdout is unavailable".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Codex app-server stderr is unavailable".to_string())?;
    let process_id = format!(
        "codex-{}-{}",
        child.id(),
        state.next_id.fetch_add(1, Ordering::Relaxed)
    );
    let child = Arc::new(Mutex::new(child));
    let managed = ManagedCodex {
        process_id: process_id.clone(),
        session_id,
        container_name: container_name.clone(),
        child: Arc::clone(&child),
        stdin: Arc::new(Mutex::new(stdin)),
        attachments_dir,
        version: CODEX_VERSION.to_string(),
    };
    processes.insert(process_id.clone(), managed);
    drop(processes);

    spawn_reader(app.clone(), process_id.clone(), "stdout", stdout);
    spawn_reader(app.clone(), process_id.clone(), "stderr", stderr);
    monitor_child(
        app,
        Arc::clone(&state.processes),
        process_id.clone(),
        container_name,
        child,
    );
    Ok(CodexProcessInfo {
        process_id,
        version: CODEX_VERSION.to_string(),
        runtime_workspace_root: RUNNER_WORKSPACE,
    })
}

fn safe_attachment_path(relative_path: &str) -> Result<PathBuf, String> {
    if relative_path.is_empty() || relative_path.len() > 300 {
        return Err("invalid Agent attachment path".to_string());
    }
    let path = Path::new(relative_path);
    if !path
        .components()
        .all(|component| matches!(component, std::path::Component::Normal(_)))
    {
        return Err("invalid Agent attachment path".to_string());
    }
    let sensitive = path.components().any(|component| {
        let value = component.as_os_str().to_string_lossy().to_ascii_lowercase();
        value == ".env"
            || value.starts_with(".env.")
            || value == "auth.json"
            || matches!(
                value.as_str(),
                "id_rsa" | "id_dsa" | "id_ecdsa" | "id_ed25519"
            )
            || matches!(
                Path::new(&value)
                    .extension()
                    .and_then(|extension| extension.to_str()),
                Some("pem" | "key" | "p12" | "pfx")
            )
            || value.starts_with("credentials.")
            || value.starts_with("secret.")
            || value.starts_with("secrets.")
    });
    if sensitive {
        return Err("敏感文件不能加入 Agent 上下文".to_string());
    }
    Ok(path.to_path_buf())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentAttachmentMetadata {
    session_id: String,
    relative_path: String,
}

fn decode_attachment_request(bytes: &[u8]) -> Result<(AgentAttachmentMetadata, &[u8]), String> {
    let metadata_size = bytes
        .get(..4)
        .and_then(|value| value.try_into().ok())
        .map(u32::from_le_bytes)
        .ok_or_else(|| "invalid Agent attachment request".to_string())?
        as usize;
    if metadata_size == 0 || metadata_size > 1_024 || bytes.len() < 4 + metadata_size {
        return Err("invalid Agent attachment request".to_string());
    }
    let metadata = serde_json::from_slice(&bytes[4..4 + metadata_size])
        .map_err(|_| "invalid Agent attachment metadata".to_string())?;
    Ok((metadata, &bytes[4 + metadata_size..]))
}

#[tauri::command]
pub fn codex_agent_attachment_write(
    state: tauri::State<'_, CodexAppServerState>,
    request: tauri::ipc::Request<'_>,
) -> Result<String, String> {
    let raw = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes,
        _ => return Err("Agent attachment request must be binary".to_string()),
    };
    let (metadata, bytes) = decode_attachment_request(raw)?;
    validate_session_id(&metadata.session_id)?;
    if bytes.len() > MAX_ATTACHMENT_BYTES {
        return Err("Agent 单个附件不能超过 10 MB".to_string());
    }
    let relative = safe_attachment_path(&metadata.relative_path)?;
    let attachments_dir = {
        let processes = state
            .processes
            .lock()
            .map_err(|_| "Codex process registry is unavailable".to_string())?;
        processes
            .values()
            .find(|process| process.session_id == metadata.session_id)
            .map(|process| process.attachments_dir.clone())
            .ok_or_else(|| "Agent 会话未运行".to_string())?
    };
    let target = attachments_dir.join(&relative);
    let parent = target
        .parent()
        .ok_or_else(|| "invalid Agent attachment path".to_string())?;
    std::fs::create_dir_all(parent).map_err(|error| format!("无法准备 Agent 附件目录：{error}"))?;
    std::fs::write(&target, bytes).map_err(|error| format!("无法写入 Agent 附件：{error}"))?;
    Ok(format!(
        "{RUNNER_ATTACHMENTS}/{}",
        relative.to_string_lossy().replace('\\', "/")
    ))
}

#[tauri::command]
pub fn codex_app_server_write(
    state: tauri::State<'_, CodexAppServerState>,
    process_id: String,
    message: serde_json::Value,
) -> Result<(), String> {
    let bytes = encode_message(message)?;
    let stdin = {
        let processes = state
            .processes
            .lock()
            .map_err(|_| "Codex process registry is unavailable".to_string())?;
        let process = processes
            .get(&process_id)
            .ok_or_else(|| "Codex app-server process is not active".to_string())?;
        Arc::clone(&process.stdin)
    };
    let mut stdin = stdin
        .lock()
        .map_err(|_| "Codex app-server stdin is unavailable".to_string())?;
    stdin
        .write_all(&bytes)
        .and_then(|_| stdin.flush())
        .map_err(|error| format!("failed to write Codex app-server message: {error}"))
}

#[tauri::command]
pub fn codex_app_server_stop(
    state: tauri::State<'_, CodexAppServerState>,
    process_id: String,
) -> Result<(), String> {
    let process = state
        .processes
        .lock()
        .map_err(|_| "Codex process registry is unavailable".to_string())?
        .remove(&process_id)
        .ok_or_else(|| "Codex app-server process is not active".to_string())?;
    cleanup_container(&process.container_name);
    let mut child = process
        .child
        .lock()
        .map_err(|_| "Codex app-server process is unavailable".to_string())?;
    child
        .kill()
        .or_else(|error| match child.try_wait() {
            Ok(Some(_)) => Ok(()),
            _ => Err(error),
        })
        .map_err(|error| format!("failed to stop Codex app-server: {error}"))?;
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(&process.attachments_dir);
    Ok(())
}

#[tauri::command]
pub fn codex_agent_workspace(app: tauri::AppHandle, session_id: String) -> Result<String, String> {
    validate_session_id(&session_id)?;
    let path = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("failed to resolve app cache directory: {error}"))?
        .join("agent-workspaces")
        .join(session_id);
    std::fs::create_dir_all(&path)
        .map_err(|error| format!("failed to prepare Agent workspace: {error}"))?;
    Ok(path.to_string_lossy().into_owned())
}

pub fn shutdown(app: &tauri::AppHandle) {
    let state = app.state::<CodexAppServerState>();
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
        cleanup_container(&process.container_name);
        if let Ok(mut child) = process.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        decode_attachment_request, docker_host_path, encode_message, safe_attachment_path,
        validate_session_id, RUNNER_CONFIG,
    };
    use serde_json::json;
    use std::path::Path;

    #[test]
    fn app_server_transport_accepts_one_json_object_per_line() {
        assert_eq!(
            encode_message(json!({"method": "initialized"})).unwrap(),
            b"{\"method\":\"initialized\"}\n"
        );
        assert!(encode_message(json!(["not", "an", "object"])).is_err());
        assert!(encode_message(json!({"value": "x".repeat(2 * 1024 * 1024)})).is_err());
    }

    #[test]
    fn runner_profile_denies_credentials_and_nested_env_files() {
        assert!(RUNNER_CONFIG.contains("\"/workspace/**/.env\" = \"deny\""));
        assert!(RUNNER_CONFIG.contains("\"/workspace/**/credentials.json\" = \"deny\""));
        assert!(RUNNER_CONFIG.contains("\"/home/node/.codex/auth.json\" = \"deny\""));
        assert!(RUNNER_CONFIG.contains("[permissions.rocketx_read.filesystem]"));
        assert!(RUNNER_CONFIG.contains("[permissions.rocketx_write.filesystem]"));
    }

    #[test]
    fn session_ids_are_safe_for_container_names() {
        assert!(validate_session_id("session-019f6d30-797a-7f63").is_ok());
        assert!(validate_session_id("../escape").is_err());
        assert!(validate_session_id("with space").is_err());
    }

    #[test]
    fn attachment_paths_stay_relative_and_reject_sensitive_files() {
        assert!(safe_attachment_path("message/1-build.log").is_ok());
        assert!(safe_attachment_path("../escape.txt").is_err());
        assert!(safe_attachment_path("message/.env").is_err());
        assert!(safe_attachment_path("message/credentials.json").is_err());
        assert!(safe_attachment_path("message/private.pem").is_err());
    }

    #[test]
    fn attachment_request_keeps_metadata_separate_from_raw_bytes() {
        let metadata = br#"{"sessionId":"session-1","relativePath":"message/build.log"}"#;
        let mut request = (metadata.len() as u32).to_le_bytes().to_vec();
        request.extend_from_slice(metadata);
        request.extend_from_slice(&[0, 1, 2, 255]);
        let (decoded, bytes) = decode_attachment_request(&request).unwrap();
        assert_eq!(decoded.session_id, "session-1");
        assert_eq!(decoded.relative_path, "message/build.log");
        assert_eq!(bytes, &[0, 1, 2, 255]);
        assert!(decode_attachment_request(&[0, 0, 0, 0]).is_err());
    }

    #[test]
    fn docker_paths_do_not_keep_windows_extended_prefixes() {
        let value = docker_host_path(Path::new(r"\\?\C:\work\repo"));
        #[cfg(windows)]
        assert_eq!(value, r"C:\work\repo");
        #[cfg(not(windows))]
        assert_eq!(value, r"\\?\C:\work\repo");
    }
}
