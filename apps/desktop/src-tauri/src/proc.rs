use std::{
    collections::HashMap,
    ffi::{OsStr, OsString},
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64::Engine;
use minisign_verify::{PublicKey, Signature};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

const MAX_MESSAGE_BYTES: usize = 2 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES: usize = 10 * 1024 * 1024;
const UPDATER_PUBLIC_KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDE5MzhFNzU5Q0ZDRDQ3MTIKUldRU1I4M1BXZWM0R1owekdDWWwyV3ZwTlFuRnNwNlZOK0QwMVRUNUNFSmhSdkJBYzZsMDBaSjYK";

#[derive(Clone)]
struct ManagedCodex {
    process_id: String,
    session_id: String,
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<ChildStdin>>,
    attachments_dir: PathBuf,
    workspace_root: String,
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
    runtime_workspace_root: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRuntimeProbe {
    ready: bool,
    version: Option<String>,
    executable_path: Option<String>,
    reason: Option<String>,
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

fn hidden_command(program: impl AsRef<OsStr>) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
}

#[derive(Clone)]
struct ResolvedCodex {
    program: PathBuf,
    prefix_args: Vec<OsString>,
    display_path: String,
}

impl ResolvedCodex {
    fn command(&self) -> Command {
        let mut command = Command::new(&self.program);
        command.args(&self.prefix_args);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        command
    }
}

#[cfg(windows)]
fn find_program(name: &str) -> Option<PathBuf> {
    let output = hidden_command("where.exe")
        .arg(name)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .find(|path| path.is_file())
}

#[cfg(windows)]
fn resolved_codex_path(path: &Path) -> Result<ResolvedCodex, String> {
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("Codex 路径不可用：{error}"))?;
    // canonicalize 产生的 `\\?\` 扩展前缀会让 Node 无法加载作为入口脚本的
    // codex.js，也不适合作为子进程工作目录，统一还原成常规主机路径。
    let canonical = PathBuf::from(host_path(&canonical));
    if !canonical.is_file() {
        return Err("Codex 路径不是文件".to_string());
    }
    let name = canonical
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    if name != "codex.exe" && name != "codex.cmd" && name != "codex" {
        return Err("请选择 codex.exe 或 codex.cmd".to_string());
    }
    if name == "codex.cmd" {
        let entry = canonical
            .parent()
            .unwrap_or_else(|| Path::new(""))
            .join("node_modules")
            .join("@openai")
            .join("codex")
            .join("bin")
            .join("codex.js");
        if !entry.is_file() {
            return Err("codex.cmd 缺少对应的 @openai/codex 安装文件".to_string());
        }
        let node = canonical
            .parent()
            .map(|parent| parent.join("node.exe"))
            .filter(|candidate| candidate.is_file())
            .or_else(|| find_program("node.exe"))
            .ok_or_else(|| "未检测到 Node.js，无法运行 codex.cmd".to_string())?;
        return Ok(ResolvedCodex {
            program: node,
            prefix_args: vec![entry.into_os_string()],
            display_path: canonical.to_string_lossy().into_owned(),
        });
    }
    Ok(ResolvedCodex {
        program: canonical.clone(),
        prefix_args: Vec::new(),
        display_path: canonical.to_string_lossy().into_owned(),
    })
}

#[cfg(windows)]
fn standard_codex_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(app_data) = std::env::var_os("APPDATA") {
        paths.push(PathBuf::from(app_data).join("npm").join("codex.cmd"));
    }
    if let Some(user_profile) = std::env::var_os("USERPROFILE") {
        paths.push(
            PathBuf::from(user_profile)
                .join("Codex")
                .join("_internal")
                .join("app")
                .join("resources")
                .join("codex.exe"),
        );
    }
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        let local = PathBuf::from(local_app_data);
        paths.push(
            local
                .join("Programs")
                .join("Codex")
                .join("resources")
                .join("codex.exe"),
        );
        paths.push(local.join("Codex").join("resources").join("codex.exe"));
        paths.push(local.join("Codex").join("codex.exe"));
    }
    paths
}

fn resolve_codex() -> Result<ResolvedCodex, String> {
    #[cfg(windows)]
    {
        if let Some(path) = find_program("codex.cmd") {
            if let Ok(resolved) = resolved_codex_path(&path) {
                return Ok(resolved);
            }
        }
        if let Some(path) = find_program("codex.exe") {
            return resolved_codex_path(&path);
        }
        for path in standard_codex_paths() {
            if path.is_file() {
                if let Ok(resolved) = resolved_codex_path(&path) {
                    return Ok(resolved);
                }
            }
        }
        return Err("未检测到可用的 Codex".to_string());
    }

    #[cfg(not(windows))]
    Ok(ResolvedCodex {
        program: PathBuf::from("codex"),
        prefix_args: Vec::new(),
        display_path: "codex".to_string(),
    })
}

pub(crate) fn codex_command() -> Result<Command, String> {
    Ok(resolve_codex()?.command())
}

fn version_token(token: &str) -> Option<&str> {
    let token = token.strip_prefix('v').unwrap_or(token);
    if !token
        .chars()
        .next()
        .is_some_and(|value| value.is_ascii_digit())
        || !token.contains('.')
    {
        return None;
    }
    token
        .chars()
        .all(|value| value.is_ascii_alphanumeric() || matches!(value, '.' | '-' | '+'))
        .then_some(token)
}

fn parse_codex_cli_version(output: &str, require_codex_prefix: bool) -> Option<String> {
    let mut fallback = None;
    for line in output.lines() {
        let tokens: Vec<&str> = line.split_whitespace().collect();
        let Some((first, rest)) = tokens.split_first() else {
            continue;
        };
        if first.eq_ignore_ascii_case("codex-cli") || first.eq_ignore_ascii_case("codex") {
            if let Some(version) = rest.iter().copied().find_map(version_token) {
                return Some(version.to_string());
            }
        }
        if !require_codex_prefix && fallback.is_none() {
            fallback = tokens
                .iter()
                .copied()
                .find_map(version_token)
                .map(ToOwned::to_owned);
        }
    }
    fallback
}

fn output_preview(value: &str) -> String {
    const MAX_CHARS: usize = 200;
    let value = value.trim();
    if value.chars().count() <= MAX_CHARS {
        return value.to_string();
    }
    let mut preview: String = value.chars().take(MAX_CHARS).collect();
    preview.push('…');
    preview
}

fn codex_cli_version() -> Result<String, String> {
    let mut command = codex_command()?;
    command.arg("--version");
    let output = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| format!("Codex CLI 不可用，请先安装并登录：{error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    // 只要能读出版本号就放行：npm/pnpm 等包装脚本可能追加提示行、把版本打到
    // stderr，甚至以非零码退出；可用性另由 app-server/login 探测把关。退出码
    // 非零时只认带 codex 前缀的行，避免把报错里的其他版本号当成 Codex 版本。
    let strict = !output.status.success();
    if let Some(version) =
        parse_codex_cli_version(&stdout, strict).or_else(|| parse_codex_cli_version(&stderr, true))
    {
        return Ok(version);
    }
    let mut details = vec![match output.status.code() {
        Some(code) => format!("退出码 {code}"),
        None => "进程被信号终止".to_string(),
    }];
    for (label, value) in [("stderr", stderr.trim()), ("stdout", stdout.trim())] {
        if !value.is_empty() {
            details.push(format!("{label}：{}", output_preview(value)));
        }
    }
    Err(format!("无法读取 Codex CLI 版本（{}）", details.join("；")))
}

fn codex_command_succeeds(args: &[&str]) -> Result<(), String> {
    let mut command = codex_command()?;
    let output = command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| format!("Codex 无法启动：{error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if detail.is_empty() {
        format!("Codex {} 执行失败", args.join(" "))
    } else {
        detail
    })
}

/// 子命令的 --help 文本，用来探测当前 CLI 版本还认识哪些参数。
/// 部分包装脚本把用法打到 stderr，两路都收。
fn subcommand_help(subcommand: &str) -> Result<String, String> {
    let mut command = codex_command()?;
    let output = command
        .args([subcommand, "--help"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| format!("Codex 无法启动：{error}"))?;
    Ok(format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    ))
}

/// 基线 0.144.4 的 app-server 需要显式 `--stdio`；后续版本把 stdio 设为默认
/// 并移除了该参数，继续传会被 clap 拒绝并立刻以退出码 2 退出（表现为
/// 「Codex app-server 已退出（2）」）。按 `--help` 是否列出该参数决定传不传。
fn app_server_args_for_help(help: &str) -> Vec<&'static str> {
    if help.contains("--stdio") {
        vec!["app-server", "--stdio"]
    } else {
        vec!["app-server"]
    }
}

fn app_server_launch_args() -> Result<Vec<&'static str>, String> {
    Ok(app_server_args_for_help(&subcommand_help("app-server")?))
}

/// `codex exec` 的可选参数同样存在版本漂移：任何一个被新版移除都会让进程
/// 以退出码 2 直接退出（与 app-server --stdio 同构）。按 `exec --help` 是否
/// 列出决定传不传；`--json` 与 `--sandbox` 是协议/安全必需，不做降级——
/// 真缺了就让错误明确暴露，绝不能悄悄放开沙箱跑。
pub(crate) fn exec_optional_args_for_help(help: &str) -> Vec<&'static str> {
    let mut args = Vec::new();
    if help.contains("--ephemeral") {
        args.push("--ephemeral");
    }
    if help.contains("--ignore-user-config") {
        args.push("--ignore-user-config");
    }
    if help.contains("--skip-git-repo-check") {
        args.push("--skip-git-repo-check");
    }
    if help.contains("--color") {
        args.extend(["--color", "never"]);
    }
    args
}

pub(crate) fn codex_exec_optional_args() -> Result<Vec<&'static str>, String> {
    Ok(exec_optional_args_for_help(&subcommand_help("exec")?))
}

#[tauri::command]
pub fn codex_runtime_probe() -> CodexRuntimeProbe {
    let resolved = match resolve_codex() {
        Ok(value) => value,
        Err(reason) => {
            return CodexRuntimeProbe {
                ready: false,
                version: None,
                executable_path: None,
                reason: Some(reason),
            }
        }
    };
    let version = match codex_cli_version() {
        Ok(value) => value,
        Err(reason) => {
            return CodexRuntimeProbe {
                ready: false,
                version: None,
                executable_path: Some(resolved.display_path),
                reason: Some(reason),
            }
        }
    };
    if let Err(reason) = codex_command_succeeds(&["app-server", "--help"]) {
        return CodexRuntimeProbe {
            ready: false,
            version: Some(version),
            executable_path: Some(resolved.display_path),
            reason: Some(format!("Codex 缺少 app-server 能力：{reason}")),
        };
    }
    if let Err(reason) = codex_command_succeeds(&["login", "status"]) {
        return CodexRuntimeProbe {
            ready: false,
            version: Some(version),
            executable_path: Some(resolved.display_path),
            reason: Some(format!("Codex 尚未登录：{reason}")),
        };
    }
    CodexRuntimeProbe {
        ready: true,
        version: Some(version),
        executable_path: Some(resolved.display_path),
        reason: None,
    }
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

fn host_path(path: &Path) -> String {
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

fn prepare_attachments_dir(app: &tauri::AppHandle, session_id: &str) -> Result<PathBuf, String> {
    let path = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("无法定位应用缓存目录：{error}"))?
        .join("agent-runtime")
        .join(session_id)
        .join("attachments");
    std::fs::create_dir_all(&path).map_err(|error| format!("无法准备 Agent 附件目录：{error}"))?;
    Ok(path)
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
    child: Arc<Mutex<Child>>,
) {
    thread::spawn(move || loop {
        let status = match child.lock() {
            Ok(mut child) => child.try_wait(),
            Err(_) => return,
        };
        match status {
            Ok(Some(status)) => {
                let process = state
                    .lock()
                    .ok()
                    .and_then(|mut processes| processes.remove(&process_id));
                if let Some(process) = process {
                    let _ = std::fs::remove_dir_all(process.attachments_dir);
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
    let workspace_root = host_path(&canonical_directory(&workspace_root)?);
    let version = codex_cli_version()?;
    let attachments_dir = prepare_attachments_dir(&app, &session_id)?;

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
            runtime_workspace_root: process.workspace_root.clone(),
        });
    }

    let launch_args = app_server_launch_args()?;
    let mut command = codex_command()?;
    command
        .args(&launch_args)
        .current_dir(&workspace_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("无法在所选本地目录启动 Codex app-server：{error}"))?;
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
        child: Arc::clone(&child),
        stdin: Arc::new(Mutex::new(stdin)),
        attachments_dir,
        workspace_root: workspace_root.clone(),
        version: version.clone(),
    };
    processes.insert(process_id.clone(), managed);
    drop(processes);

    spawn_reader(app.clone(), process_id.clone(), "stdout", stdout);
    spawn_reader(app.clone(), process_id.clone(), "stderr", stderr);
    monitor_child(app, Arc::clone(&state.processes), process_id.clone(), child);
    Ok(CodexProcessInfo {
        process_id,
        version,
        runtime_workspace_root: workspace_root,
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAttachmentRuntimePath {
    path: String,
    root: String,
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
) -> Result<AgentAttachmentRuntimePath, String> {
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
    Ok(AgentAttachmentRuntimePath {
        path: host_path(&target),
        root: host_path(&attachments_dir),
    })
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

#[tauri::command]
pub async fn butler_home_dir(app: tauri::AppHandle) -> Result<String, String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("failed to resolve Butler home directory: {error}"))?
        .join("butler");
    std::fs::create_dir_all(&path)
        .map_err(|error| format!("failed to prepare Butler home directory: {error}"))?;
    for directory in ["memory", "skills"] {
        std::fs::create_dir_all(path.join(directory))
            .map_err(|error| format!("failed to prepare Butler {directory} directory: {error}"))?;
    }
    Ok(host_path(&path))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDirManifest {
    manifest: String,
    installer_path: Option<String>,
    signature: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedHttpUpdateMetadata {
    rid: tauri::ResourceId,
    current_version: String,
    version: String,
    date: Option<String>,
    body: Option<String>,
    raw_json: serde_json::Value,
}

fn decode_updater_text(value: &str, label: &str) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(value)
        .map_err(|error| format!("{label} Base64 无效：{error}"))?;
    String::from_utf8(bytes).map_err(|_| format!("{label} 不是 UTF-8 文本"))
}

fn verify_update_package(path: &Path, signature: &str) -> Result<(), String> {
    let public_key = PublicKey::decode(&decode_updater_text(UPDATER_PUBLIC_KEY, "更新公钥")?)
        .map_err(|error| format!("更新公钥无效：{error}"))?;
    let signature = Signature::decode(&decode_updater_text(signature, "更新签名")?)
        .map_err(|error| format!("更新签名无效：{error}"))?;
    let mut verifier = public_key
        .verify_stream(&signature)
        .map_err(|error| format!("无法创建更新验签器：{error}"))?;
    let mut file = std::fs::File::open(path)
        .map_err(|error| format!("读取更新包 {} 失败：{error}", path.display()))?;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| format!("读取更新包 {} 失败：{error}", path.display()))?;
        if count == 0 {
            break;
        }
        verifier.update(&buffer[..count]);
    }
    verifier
        .finalize()
        .map_err(|error| format!("更新包签名校验失败：{error}"))
}

fn resolve_update_package(
    base: &Path,
    manifest: &serde_json::Value,
) -> Result<(PathBuf, String), String> {
    let platform = manifest
        .get("platforms")
        .and_then(|platforms| {
            platforms
                .get("windows-x86_64")
                .or_else(|| platforms.get("windows-x86_64-msi"))
        })
        .ok_or_else(|| "latest.json 缺少 Windows x86_64 平台条目".to_string())?;
    let url = platform
        .get("url")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "Windows 更新条目缺少 url".to_string())?;
    let signature = platform
        .get("signature")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Windows 更新条目缺少 signature，拒绝使用未签名安装包".to_string())?
        .to_string();
    let file_name = url
        .rsplit(['/', '\\'])
        .next()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Windows 更新 URL 缺少文件名".to_string())?;
    let path = base.join(file_name);
    if !path.is_file() {
        return Err(format!("更新包不存在：{}", path.display()));
    }
    Ok((path, signature))
}

#[tauri::command]
pub async fn check_signed_http_update(
    webview: tauri::Webview,
    endpoint: String,
) -> Result<Option<SignedHttpUpdateMetadata>, String> {
    let url = tauri::Url::parse(endpoint.trim()).map_err(|_| "更新清单 URL 无效".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("更新清单必须是无凭据的 http/https URL".to_string());
    }
    let updater = webview
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|error| format!("更新源无效：{error}"))?
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|error| format!("无法创建更新检查器：{error}"))?;
    let Some(update) = updater
        .check()
        .await
        .map_err(|error| format!("检查更新失败：{error}"))?
    else {
        return Ok(None);
    };
    let metadata = SignedHttpUpdateMetadata {
        current_version: update.current_version.clone(),
        version: update.version.clone(),
        date: update.date.map(|value| value.to_string()),
        body: update.body.clone(),
        raw_json: update.raw_json.clone(),
        rid: webview.resources_table().add(update),
    };
    Ok(Some(metadata))
}

/// 共享目录更新源（issue #106）：webview 读不了 UNC/本地任意路径，
/// 由这里读 latest.json，并按清单里 Windows 平台条目的文件名在同目录
/// 找安装包。目录是用户自己在设置页填的更新源，只读不写。
#[tauri::command]
pub async fn read_update_manifest_dir(dir: String) -> Result<UpdateDirManifest, String> {
    let base = std::path::PathBuf::from(dir.trim());
    if !base.is_absolute() {
        return Err("更新目录必须是绝对路径（本地盘符或 \\\\server\\share 形式）".to_string());
    }
    let manifest_path = base.join("latest.json");
    let manifest = std::fs::read_to_string(&manifest_path)
        .map_err(|error| format!("读取 {} 失败：{error}", manifest_path.display()))?;

    let value = serde_json::from_str::<serde_json::Value>(&manifest)
        .map_err(|error| format!("latest.json 无效：{error}"))?;
    let (package_path, signature) = resolve_update_package(&base, &value)?;
    verify_update_package(&package_path, &signature)?;

    Ok(UpdateDirManifest {
        manifest,
        installer_path: Some(package_path.to_string_lossy().into_owned()),
        signature: Some(signature),
    })
}

fn extract_signed_installer(package: &Path) -> Result<PathBuf, String> {
    let extension = package
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if extension == "exe" || extension == "msi" {
        return Ok(package.to_path_buf());
    }
    if extension != "zip" {
        return Err("签名更新包只支持 .zip / .exe / .msi".to_string());
    }
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let target_dir =
        std::env::temp_dir().join(format!("rocketx-update-{}-{stamp}", std::process::id()));
    std::fs::create_dir_all(&target_dir)
        .map_err(|error| format!("创建更新临时目录失败：{error}"))?;
    let mut command = Command::new("powershell");
    command
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force",
        ])
        .arg(package)
        .arg(&target_dir);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let status = command
        .status()
        .map_err(|error| format!("无法启动更新解压程序：{error}"))?;
    if !status.success() {
        return Err(format!("更新压缩包解压失败，退出码：{status}"));
    }
    for entry in
        std::fs::read_dir(&target_dir).map_err(|error| format!("读取更新临时目录失败：{error}"))?
    {
        let path = entry
            .map_err(|error| format!("读取更新临时目录失败：{error}"))?
            .path();
        let ext = path
            .extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase)
            .unwrap_or_default();
        if path.is_file() && (ext == "exe" || ext == "msi") {
            return Ok(path);
        }
    }
    Err("签名更新压缩包中没有 .exe / .msi 安装器".to_string())
}

/// 只启动配置目录里的签名更新包；启动前再次验签，避免检查与执行之间被替换。
#[tauri::command]
pub async fn launch_update_installer(
    dir: String,
    path: String,
    signature: String,
) -> Result<(), String> {
    let base = std::fs::canonicalize(PathBuf::from(dir.trim()))
        .map_err(|error| format!("更新目录不可访问：{error}"))?;
    let package = std::fs::canonicalize(PathBuf::from(path.trim()))
        .map_err(|error| format!("更新包不可访问：{error}"))?;
    if !package.starts_with(&base) {
        return Err("更新包不在配置的共享目录中".to_string());
    }
    verify_update_package(&package, &signature)?;
    let target = extract_signed_installer(&package)?;
    let extension = target
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_default();
    if extension != "exe" && extension != "msi" {
        return Err("只支持运行 .exe / .msi 安装包".to_string());
    }
    if !target.is_file() {
        return Err(format!("安装包不存在：{}", target.display()));
    }
    let result = if extension == "msi" {
        std::process::Command::new("msiexec")
            .arg("/i")
            .arg(&target)
            .spawn()
    } else {
        std::process::Command::new(&target).spawn()
    };
    result
        .map(|_| ())
        .map_err(|error| format!("无法启动安装包：{error}"))
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
        if let Ok(mut child) = process.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[cfg(test)]
mod tests {
    #[cfg(windows)]
    use super::ResolvedCodex;
    use super::{
        app_server_args_for_help, decode_attachment_request, encode_message,
        exec_optional_args_for_help, host_path, parse_codex_cli_version, resolve_update_package,
        safe_attachment_path, validate_session_id, verify_update_package, UPDATER_PUBLIC_KEY,
    };
    use serde_json::json;
    use std::path::Path;
    #[cfg(windows)]
    use std::{ffi::OsString, path::PathBuf};

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
    fn session_ids_are_safe_for_runtime_directories() {
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
    fn shared_directory_update_rejects_unsigned_packages() {
        let manifest = json!({
            "platforms": {
                "windows-x86_64": {
                    "url": "RocketX-update.zip"
                }
            }
        });
        let error = resolve_update_package(Path::new("."), &manifest).unwrap_err();
        assert!(error.contains("缺少 signature"));
    }

    #[test]
    fn shared_directory_update_rejects_malformed_signatures_before_reading_the_package() {
        let error = verify_update_package(Path::new("missing-package.zip"), "not-base64").unwrap_err();
        assert!(error.contains("更新签名 Base64 无效"));
    }

    #[test]
    fn shared_directory_verifier_uses_the_tauri_updater_public_key() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(
            config["plugins"]["updater"]["pubkey"].as_str(),
            Some(UPDATER_PUBLIC_KEY)
        );
    }

    #[test]
    fn codex_version_parsing_accepts_official_and_wrapped_outputs() {
        assert_eq!(
            parse_codex_cli_version("codex-cli 0.144.4\n", false).as_deref(),
            Some("0.144.4")
        );
        assert_eq!(
            parse_codex_cli_version("codex v0.150.2", false).as_deref(),
            Some("0.150.2")
        );
        assert_eq!(
            parse_codex_cli_version("npm warn deprecated something\ncodex-cli 0.144.4", false)
                .as_deref(),
            Some("0.144.4")
        );
        assert_eq!(
            parse_codex_cli_version("0.144.4", false).as_deref(),
            Some("0.144.4")
        );
        assert_eq!(parse_codex_cli_version("", false), None);
        assert_eq!(
            parse_codex_cli_version("usage: codex [options]", false),
            None
        );
    }

    #[test]
    fn codex_version_parsing_in_strict_mode_only_trusts_codex_lines() {
        assert_eq!(
            parse_codex_cli_version("codex-cli 0.144.4", true).as_deref(),
            Some("0.144.4")
        );
        assert_eq!(
            parse_codex_cli_version("Node.js v22.17.0 is required", true),
            None
        );
        assert_eq!(
            parse_codex_cli_version("Node.js v22.17.0 is required", false).as_deref(),
            Some("22.17.0")
        );
    }

    #[test]
    fn app_server_stdio_flag_follows_cli_help() {
        assert_eq!(
            app_server_args_for_help("Usage: codex app-server [OPTIONS]\n      --stdio  Serve over stdio"),
            vec!["app-server", "--stdio"],
        );
        // 新版 CLI 移除了 --stdio（stdio 已是默认），传了会以退出码 2 拒绝
        assert_eq!(
            app_server_args_for_help("Usage: codex app-server [OPTIONS]\n      --listen <ADDR>"),
            vec!["app-server"],
        );
    }

    #[test]
    fn exec_optional_flags_follow_cli_help() {
        assert_eq!(
            exec_optional_args_for_help(
                "--ephemeral  --ignore-user-config  --skip-git-repo-check  --color <WHEN>",
            ),
            vec!["--ephemeral", "--ignore-user-config", "--skip-git-repo-check", "--color", "never"],
        );
        // 新版移除的参数不再传，避免 clap 以退出码 2 拒绝
        assert_eq!(
            exec_optional_args_for_help("Usage: codex exec [OPTIONS]\n  --skip-git-repo-check"),
            vec!["--skip-git-repo-check"],
        );
        assert_eq!(exec_optional_args_for_help("Usage: codex exec"), Vec::<&str>::new());
    }

    #[test]
    fn host_paths_do_not_keep_windows_extended_prefixes() {
        let value = host_path(Path::new(r"\\?\C:\work\repo"));
        #[cfg(windows)]
        assert_eq!(value, r"C:\work\repo");
        #[cfg(not(windows))]
        assert_eq!(value, r"\\?\C:\work\repo");
    }

    #[cfg(windows)]
    #[test]
    fn resolved_npm_codex_runs_the_official_node_entry_without_a_shell() {
        use std::ffi::OsStr;

        let resolved = ResolvedCodex {
            program: PathBuf::from(r"C:\Program Files\nodejs\node.exe"),
            prefix_args: vec![OsString::from(
                r"C:\Users\test\AppData\Roaming\npm\node_modules\@openai\codex\bin\codex.js",
            )],
            display_path: r"C:\Users\test\AppData\Roaming\npm\codex.cmd".to_string(),
        };
        let command = resolved.command();
        assert_eq!(
            command.get_program(),
            OsStr::new(r"C:\Program Files\nodejs\node.exe")
        );
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            [OsStr::new(
                r"C:\Users\test\AppData\Roaming\npm\node_modules\@openai\codex\bin\codex.js",
            )]
        );
    }
}
