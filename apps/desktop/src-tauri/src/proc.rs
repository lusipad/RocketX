use std::{
    collections::HashMap,
    ffi::{OsStr, OsString},
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

const MAX_MESSAGE_BYTES: usize = 2 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES: usize = 10 * 1024 * 1024;

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

/// 转移会话文件的落点。codex 的外部会话导入器只探测 Claude Code 标准会话根
/// （~/.claude/projects/…）下的 JSONL，任意路径一律判 session_missing（issue #99）——
/// 所以路径完全由本端拼装：前端只提供 UUID 与内容，不接受任意路径，防目录穿越。
fn transfer_session_path(
    app: &tauri::AppHandle,
    session_uuid: &str,
) -> Result<std::path::PathBuf, String> {
    if session_uuid.len() != 36
        || !session_uuid
            .chars()
            .all(|value| value.is_ascii_hexdigit() || value == '-')
    {
        return Err("invalid transfer session id".to_string());
    }
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("failed to resolve home directory: {error}"))?;
    Ok(home
        .join(".claude")
        .join("projects")
        .join("rocketx-transfers")
        .join(format!("{session_uuid}.jsonl")))
}

#[tauri::command]
pub async fn codex_transfer_session_write(
    app: tauri::AppHandle,
    session_uuid: String,
    content: String,
) -> Result<String, String> {
    if content.len() > MAX_ATTACHMENT_BYTES {
        return Err("转移内容超过大小上限".to_string());
    }
    let path = transfer_session_path(&app, &session_uuid)?;
    let parent = path
        .parent()
        .ok_or_else(|| "invalid transfer path".to_string())?;
    std::fs::create_dir_all(parent).map_err(|error| format!("无法准备转移目录：{error}"))?;
    std::fs::write(&path, content).map_err(|error| format!("无法写入转移会话：{error}"))?;
    Ok(host_path(&path))
}

/// 导入完成后清走源文件：这些 JSONL 若留在 ~/.claude/projects 下，
/// 会出现在 Claude Code 自己的会话列表里造成困扰。
#[tauri::command]
pub async fn codex_transfer_session_cleanup(
    app: tauri::AppHandle,
    session_uuid: String,
) -> Result<(), String> {
    let path = transfer_session_path(&app, &session_uuid)?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("无法清理转移会话：{error}")),
    }
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
        exec_optional_args_for_help, host_path, parse_codex_cli_version, safe_attachment_path,
        validate_session_id,
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
