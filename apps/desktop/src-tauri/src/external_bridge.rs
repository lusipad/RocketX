use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::{
    butler_worktree::{inspect_workspace_git_sync, WorkspaceGitSnapshot},
    local_sessions::{
        collect_codex_sessions_from_root, find_transcript_for_session, parse_codex_messages,
        read_local_session_messages_sync, LocalSessionMessage,
    },
    native::{
        dsh_discovery::find_program,
        process::{hidden_command, host_path},
    },
};

const TRANSCRIPT_ACTIVE_WINDOW_MS: i64 = 4_000;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedExternalTool {
    pub id: String,
    pub label: String,
    pub available: bool,
    pub kind: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenExternalToolInput {
    pub tool_id: String,
    pub workspace_root: String,
    pub file_path: Option<String>,
    pub provider: Option<String>,
    pub session_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalPulseInput {
    pub workspace_root: String,
    pub provider: Option<String>,
    pub session_id: Option<String>,
    pub source_path: Option<String>,
    pub message_limit: Option<usize>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalWorkspacePulse {
    pub workspace_root: String,
    pub external_writer_active: bool,
    pub writer_hint: Option<String>,
    pub transcript_mtime_ms: Option<i64>,
    pub transcript_size_bytes: Option<u64>,
    pub latest_messages: Vec<LocalSessionMessage>,
    pub git_snapshot: Option<WorkspaceGitSnapshot>,
}

pub(crate) fn validate_safe_session_id(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty()
        || trimmed.len() > 200
        || trimmed.contains("..")
        || !trimmed
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    {
        return Err("外部会话 ID 格式无效或包含不安全字符".to_string());
    }
    Ok(trimmed.to_string())
}

fn user_home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
}

fn now_epoch_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn metadata_mtime_and_size(path: &Path) -> (Option<i64>, Option<u64>) {
    let Ok(meta) = fs::metadata(path) else {
        return (None, None);
    };
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64);
    (mtime, Some(meta.len()))
}

fn resolve_tool_binary(tool_id: &str) -> Option<PathBuf> {
    let candidates: &[&str] = match tool_id {
        "vscode" => {
            #[cfg(windows)]
            {
                &["code.cmd", "code.exe", "code"]
            }
            #[cfg(not(windows))]
            {
                &["code"]
            }
        }
        "cursor" => {
            #[cfg(windows)]
            {
                &["cursor.cmd", "cursor.exe", "cursor"]
            }
            #[cfg(not(windows))]
            {
                &["cursor"]
            }
        }
        "windsurf" => {
            #[cfg(windows)]
            {
                &["windsurf.cmd", "windsurf.exe", "windsurf"]
            }
            #[cfg(not(windows))]
            {
                &["windsurf"]
            }
        }
        "zed" => {
            #[cfg(windows)]
            {
                &["zed.exe", "zed"]
            }
            #[cfg(not(windows))]
            {
                &["zed"]
            }
        }
        "antigravity" => {
            #[cfg(windows)]
            {
                &["antigravity.cmd", "antigravity.exe", "agy.cmd", "agy"]
            }
            #[cfg(not(windows))]
            {
                &["antigravity", "agy"]
            }
        }
        "system_terminal" => {
            #[cfg(windows)]
            {
                &["wt.exe", "pwsh.exe", "powershell.exe", "cmd.exe"]
            }
            #[cfg(not(windows))]
            {
                &["x-terminal-emulator", "gnome-terminal", "konsole", "bash"]
            }
        }
        "claude" => {
            #[cfg(windows)]
            {
                &["claude.exe", "claude.cmd", "claude"]
            }
            #[cfg(not(windows))]
            {
                &["claude"]
            }
        }
        "codex" => {
            #[cfg(windows)]
            {
                &["codex.exe", "codex.cmd", "codex"]
            }
            #[cfg(not(windows))]
            {
                &["codex"]
            }
        }
        "pi" => {
            #[cfg(windows)]
            {
                &["pi.cmd", "pi.exe", "pi"]
            }
            #[cfg(not(windows))]
            {
                &["pi"]
            }
        }
        _ => return None,
    };

    for name in candidates {
        if let Some(found) = find_program(name) {
            return Some(found);
        }
    }

    #[cfg(windows)]
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
        let extra = match tool_id {
            "vscode" => Some(
                local_app_data
                    .join("Programs")
                    .join("Microsoft VS Code")
                    .join("Code.exe"),
            ),
            "cursor" => Some(
                local_app_data
                    .join("Programs")
                    .join("cursor")
                    .join("Cursor.exe"),
            ),
            "windsurf" => Some(
                local_app_data
                    .join("Programs")
                    .join("Windsurf")
                    .join("Windsurf.exe"),
            ),
            _ => None,
        };
        if let Some(path) = extra.filter(|p| p.is_file()) {
            return Some(path);
        }
    }

    #[cfg(target_os = "macos")]
    {
        let app_path = match tool_id {
            "vscode" => Some(PathBuf::from("/Applications/Visual Studio Code.app")),
            "cursor" => Some(PathBuf::from("/Applications/Cursor.app")),
            "windsurf" => Some(PathBuf::from("/Applications/Windsurf.app")),
            "zed" => Some(PathBuf::from("/Applications/Zed.app")),
            "system_terminal" => Some(PathBuf::from("/System/Applications/Utilities/Terminal.app")),
            _ => None,
        };
        if let Some(path) = app_path.filter(|p| p.exists()) {
            return Some(path);
        }
    }

    None
}

pub(crate) fn detect_external_tools_sync() -> Vec<DetectedExternalTool> {
    let specs = [
        ("vscode", "VS Code", "editor"),
        ("cursor", "Cursor", "editor"),
        ("windsurf", "Windsurf", "editor"),
        ("zed", "Zed", "editor"),
        ("antigravity", "Antigravity", "editor"),
        ("system_terminal", "系统终端", "terminal"),
    ];
    let mut out: Vec<DetectedExternalTool> = specs
        .into_iter()
        .map(|(id, label, kind)| DetectedExternalTool {
            id: id.to_string(),
            label: label.to_string(),
            available: resolve_tool_binary(id).is_some(),
            kind: kind.to_string(),
        })
        .collect();
    out.push(DetectedExternalTool {
        id: "file_explorer".to_string(),
        label: if cfg!(windows) {
            "资源管理器"
        } else if cfg!(target_os = "macos") {
            "Finder"
        } else {
            "文件管理器"
        }
        .to_string(),
        available: true,
        kind: "explorer".to_string(),
    });
    out
}

fn build_external_cli_resume_spec(
    provider: &str,
    session_id: &str,
) -> Result<(String, Vec<String>), String> {
    let safe_id = validate_safe_session_id(session_id)?;
    let normalized = provider.trim().to_ascii_lowercase();
    let args = match normalized.as_str() {
        "claude" | "claude-code" => ("claude", vec!["--resume".to_string(), safe_id]),
        "codex" | "codex-acp" => ("codex", vec!["resume".to_string(), safe_id]),
        "pi" => ("pi", vec!["--session".to_string(), safe_id]),
        _ => return Err(format!("不支持外部 CLI 接管的引擎类型：{provider}")),
    };
    Ok((args.0.to_string(), args.1))
}

fn spawn_detached_editor(
    tool_id: &str,
    workspace: &Path,
    file_path: Option<&Path>,
) -> Result<(), String> {
    let bin = resolve_tool_binary(tool_id)
        .ok_or_else(|| format!("本机未检测到 {tool_id}，请先安装或加入 PATH"))?;
    let ws_str = host_path(workspace);

    #[cfg(target_os = "macos")]
    if bin.extension().and_then(|s| s.to_str()) == Some("app") {
        let mut cmd = Command::new("open");
        cmd.arg("-a").arg(&bin).arg(&ws_str);
        if let Some(fp) = file_path {
            cmd.arg(host_path(fp));
        }
        cmd.stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("打开外部编辑器失败：{e}"))?;
        return Ok(());
    }

    #[cfg(windows)]
    let mut cmd = {
        let is_batch = bin
            .extension()
            .and_then(|s| s.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"));
        if is_batch {
            let mut c = hidden_command("cmd.exe");
            c.arg("/C").arg(host_path(&bin));
            c
        } else {
            hidden_command(host_path(&bin))
        }
    };
    #[cfg(not(windows))]
    let mut cmd = Command::new(&bin);

    cmd.arg(&ws_str);
    if let Some(fp) = file_path {
        cmd.arg(host_path(fp));
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("启动 {tool_id} 失败：{e}"))?;
    Ok(())
}

fn spawn_external_terminal(
    workspace: &Path,
    cli_exe: Option<&Path>,
    cli_args: &[String],
) -> Result<(), String> {
    let ws_str = host_path(workspace);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;

        if let Some(program) = cli_exe {
            let prog_str = host_path(program);
            let is_batch = program
                .extension()
                .and_then(|s| s.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"));
            let mut cmd = Command::new("cmd.exe");
            cmd.creation_flags(CREATE_NEW_CONSOLE)
                .current_dir(&ws_str)
                .arg("/K");
            if is_batch {
                cmd.arg(&prog_str);
            } else {
                cmd.arg(&prog_str);
            }
            for arg in cli_args {
                cmd.arg(arg);
            }
            cmd.spawn()
                .map_err(|e| format!("拉起外部命令行窗口失败：{e}"))?;
            return Ok(());
        }

        if let Some(wt) = find_program("wt.exe") {
            let mut cmd = hidden_command(host_path(&wt));
            cmd.arg("-d").arg(&ws_str);
            cmd.spawn()
                .map_err(|e| format!("启动 Windows Terminal 失败：{e}"))?;
            return Ok(());
        }

        let shell = find_program("pwsh.exe")
            .or_else(|| find_program("powershell.exe"))
            .unwrap_or_else(|| PathBuf::from("cmd.exe"));
        Command::new(host_path(&shell))
            .creation_flags(CREATE_NEW_CONSOLE)
            .current_dir(&ws_str)
            .spawn()
            .map_err(|e| format!("启动外部终端失败：{e}"))?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        if let Some(program) = cli_exe {
            let mut parts = vec![format!("cd '{}'", ws_str.replace('\'', "'\\''"))];
            let mut line = format!("'{}'", host_path(program).replace('\'', "'\\''"));
            for arg in cli_args {
                line.push(' ');
                line.push('\'');
                line.push_str(&arg.replace('\'', "'\\''"));
                line.push('\'');
            }
            parts.push(line);
            let script = format!(
                "tell application \"Terminal\" to do script \"{}\"\ntell application \"Terminal\" to activate",
                parts.join(" && ").replace('\"', "\\\"")
            );
            Command::new("osascript")
                .arg("-e")
                .arg(script)
                .spawn()
                .map_err(|e| format!("打开 macOS Terminal 失败：{e}"))?;
        } else {
            Command::new("open")
                .arg("-a")
                .arg("Terminal")
                .arg(&ws_str)
                .spawn()
                .map_err(|e| format!("打开 macOS Terminal 失败：{e}"))?;
        }
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let term = resolve_tool_binary("system_terminal")
            .ok_or_else(|| "未找到可用的 Linux 终端程序".to_string())?;
        let mut cmd = Command::new(term);
        cmd.current_dir(&ws_str);
        if let Some(program) = cli_exe {
            cmd.arg("-e").arg(host_path(program)).args(cli_args);
        }
        cmd.spawn().map_err(|e| format!("打开外部终端失败：{e}"))?;
        Ok(())
    }
}

pub(crate) fn collect_internal_child_pids(app: &tauri::AppHandle) -> HashSet<u32> {
    let mut set = HashSet::new();
    set.insert(std::process::id());
    for pid in crate::proc::active_codex_child_pids(app) {
        set.insert(pid);
    }
    for pid in crate::acp::active_acp_child_pids(app) {
        set.insert(pid);
    }
    for pid in crate::pi::active_pi_child_pids(app) {
        set.insert(pid);
    }
    for pid in crate::pty_terminal::active_pty_pids(app) {
        set.insert(pid);
    }
    set
}

fn find_external_writer_process(session_id: &str, excluded_pids: &HashSet<u32>) -> Option<String> {
    let safe_id = validate_safe_session_id(session_id).ok()?;

    #[cfg(windows)]
    {
        let script = format!(
            "Get-CimInstance Win32_Process | Where-Object {{ $_.CommandLine -and $_.CommandLine -like '*{safe_id}*' }} | Select-Object ProcessId,Name | ConvertTo-Json -Compress"
        );
        let ps = find_program("powershell.exe")
            .or_else(|| find_program("pwsh.exe"))
            .unwrap_or_else(|| PathBuf::from("powershell.exe"));
        let output = hidden_command(host_path(&ps))
            .args(["-NoProfile", "-Command", &script])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if stdout.is_empty() {
            return None;
        }
        let parsed: serde_json::Value = serde_json::from_str(&stdout).ok()?;
        let items = match parsed {
            serde_json::Value::Array(arr) => arr,
            obj @ serde_json::Value::Object(_) => vec![obj],
            _ => Vec::new(),
        };
        for item in items {
            let pid = item
                .get("ProcessId")
                .and_then(|v| v.as_u64())
                .map(|v| v as u32);
            let name = item.get("Name").and_then(|v| v.as_str()).unwrap_or("cli");
            if let Some(pid) = pid {
                if !excluded_pids.contains(&pid) && !name.eq_ignore_ascii_case("powershell.exe") {
                    return Some(format!("外部 CLI 进程 ({name}, PID {pid})"));
                }
            }
        }
        None
    }

    #[cfg(not(windows))]
    {
        let output = Command::new("ps")
            .args(["-eo", "pid=,args="])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines() {
            let trimmed = line.trim();
            let mut parts = trimmed.splitn(2, char::is_whitespace);
            let Some(pid_str) = parts.next() else {
                continue;
            };
            let Some(args) = parts.next() else {
                continue;
            };
            let Ok(pid) = pid_str.trim().parse::<u32>() else {
                continue;
            };
            if excluded_pids.contains(&pid) {
                continue;
            }
            if args
                .split_whitespace()
                .any(|tok| tok == safe_id || tok.ends_with(&format!("/{safe_id}.jsonl")))
            {
                return Some(format!("外部 CLI 进程 (PID {pid})"));
            }
        }
        None
    }
}

pub(crate) fn assert_no_external_cli_writer(
    app: &tauri::AppHandle,
    session_id: &str,
) -> Result<(), String> {
    let excluded = collect_internal_child_pids(app);
    if let Some(hint) = find_external_writer_process(session_id, &excluded) {
        return Err(format!(
            "检测到{hint}仍在写入同一会话，为防双写损坏存档已拦截接管；请先退出外部终端后再点「接管回 RocketX」"
        ));
    }
    Ok(())
}

pub(crate) fn is_recent_transcript_activity(
    mtime_ms: Option<i64>,
    now_ms: i64,
    window_ms: i64,
) -> bool {
    mtime_ms.is_some_and(|mtime| now_ms.saturating_sub(mtime) <= window_ms)
}

#[tauri::command]
pub async fn butler_external_tools_detect() -> Result<Vec<DetectedExternalTool>, String> {
    tauri::async_runtime::spawn_blocking(detect_external_tools_sync)
        .await
        .map_err(|error| format!("探测外部工具失败：{error}"))
}

#[tauri::command]
pub async fn butler_open_in_external_tool(input: OpenExternalToolInput) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ws_path = PathBuf::from(input.workspace_root.trim());
        if !ws_path.is_dir() {
            return Err("工作区目录不存在".to_string());
        }
        let canonical_ws = ws_path.canonicalize().unwrap_or(ws_path);
        let validated_file = if let Some(ref raw_file) = input.file_path {
            let trimmed = raw_file.trim();
            if trimmed.is_empty() {
                None
            } else {
                let candidate = canonical_ws.join(trimmed);
                let canonical_file = candidate
                    .canonicalize()
                    .map_err(|_| "目标文件不存在".to_string())?;
                if !canonical_file.starts_with(&canonical_ws) {
                    return Err("目标文件越出工作区边界".to_string());
                }
                Some(canonical_file)
            }
        } else {
            None
        };

        match input.tool_id.trim() {
            "vscode" | "cursor" | "windsurf" | "zed" | "antigravity" => spawn_detached_editor(
                input.tool_id.trim(),
                &canonical_ws,
                validated_file.as_deref(),
            ),
            "file_explorer" => {
                let target = validated_file.unwrap_or(canonical_ws);
                let target_str = host_path(&target);
                #[cfg(windows)]
                let mut cmd = hidden_command("explorer.exe");
                #[cfg(target_os = "macos")]
                let mut cmd = Command::new("open");
                #[cfg(all(unix, not(target_os = "macos")))]
                let mut cmd = Command::new("xdg-open");
                cmd.arg(&target_str)
                    .spawn()
                    .map_err(|e| format!("打开系统文件夹失败：{e}"))?;
                Ok(())
            }
            "system_terminal" => spawn_external_terminal(&canonical_ws, None, &[]),
            "external_cli_resume" => {
                let provider = input
                    .provider
                    .as_deref()
                    .ok_or_else(|| "缺少需要外部接管的 Agent 引擎名称".to_string())?;
                let session_id = input
                    .session_id
                    .as_deref()
                    .ok_or_else(|| "当前会话尚未生成外部可恢复 ID".to_string())?;
                let (bin_key, cli_args) = build_external_cli_resume_spec(provider, session_id)?;
                let cli_path = resolve_tool_binary(&bin_key)
                    .ok_or_else(|| format!("未在本机 PATH 找到 `{bin_key}` 命令"))?;
                spawn_external_terminal(&canonical_ws, Some(&cli_path), &cli_args)
            }
            other => Err(format!("不支持的外部工具标识：{other}")),
        }
    })
    .await
    .map_err(|error| format!("外部工具打开任务失败：{error}"))?
}

#[tauri::command]
pub async fn butler_workspace_external_pulse(
    app: tauri::AppHandle,
    input: ExternalPulseInput,
) -> Result<ExternalWorkspacePulse, String> {
    let excluded_pids = collect_internal_child_pids(&app);
    let has_internal_pty = crate::pty_terminal::has_live_pty_in_workspace(
        &app,
        Path::new(input.workspace_root.trim()),
    );
    let codex_sources = crate::acp::codex_session_sources(&app).unwrap_or_default();
    let app_local_data_dir = app.path().app_local_data_dir().ok();

    tauri::async_runtime::spawn_blocking(move || {
        let ws_raw = input.workspace_root.trim();
        let ws_path = Path::new(ws_raw);
        let canonical_ws = if ws_path.is_dir() {
            host_path(
                &ws_path
                    .canonicalize()
                    .unwrap_or_else(|_| ws_path.to_path_buf()),
            )
        } else {
            ws_raw.to_string()
        };

        let git_snapshot = if ws_path.is_dir() {
            inspect_workspace_git_sync(ws_path).ok()
        } else {
            None
        };

        let home = user_home_dir();
        let limit = input.message_limit.unwrap_or(16).clamp(1, 100);
        let provider = input.provider.as_deref().map(str::trim).unwrap_or("");
        let session_id = input
            .session_id
            .as_deref()
            .and_then(|s| validate_safe_session_id(s).ok());

        let mut writer_hint = session_id
            .as_deref()
            .and_then(|sid| find_external_writer_process(sid, &excluded_pids));

        let mut transcript_mtime_ms = None;
        let mut transcript_size_bytes = None;
        let mut latest_messages = Vec::new();

        if let Some(ref sid) = session_id {
            if provider == "codex" {
                let mut sources = codex_sources;
                if let Some(ref h) = home {
                    sources.push(crate::local_sessions::CodexSessionSource {
                        root: crate::local_sessions::default_codex_root(h),
                        profile_id: None,
                    });
                }
                for src in sources {
                    if let Some(found) =
                        collect_codex_sessions_from_root(&src.root, src.profile_id.as_deref())
                            .into_iter()
                            .find(|s| s.native_session_id == *sid)
                    {
                        if let Some(ref sp) = found.source_path {
                            let sp_path = PathBuf::from(sp);
                            let (mt, sz) = metadata_mtime_and_size(&sp_path);
                            transcript_mtime_ms = mt;
                            transcript_size_bytes = sz;
                            latest_messages = parse_codex_messages(&sp_path, limit);
                            break;
                        }
                    }
                }
            } else if !provider.is_empty() {
                let path = input
                    .source_path
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(PathBuf::from)
                    .filter(|p| p.is_file())
                    .or_else(|| {
                        find_transcript_for_session(
                            provider,
                            sid,
                            home.as_deref(),
                            app_local_data_dir.as_deref(),
                        )
                    });
                if let Some(ref p) = path {
                    let (mt, sz) = metadata_mtime_and_size(p);
                    transcript_mtime_ms = mt;
                    transcript_size_bytes = sz;
                }
                latest_messages = read_local_session_messages_sync(
                    provider,
                    sid,
                    path.as_deref().and_then(|p| p.to_str()),
                    home,
                    app_local_data_dir,
                    limit,
                );
            }
        }

        if writer_hint.is_none()
            && !has_internal_pty
            && is_recent_transcript_activity(
                transcript_mtime_ms,
                now_epoch_ms(),
                TRANSCRIPT_ACTIVE_WINDOW_MS,
            )
        {
            writer_hint = Some("外部会话文件最近刚有写入".to_string());
        }

        Ok(ExternalWorkspacePulse {
            workspace_root: canonical_ws,
            external_writer_active: writer_hint.is_some(),
            writer_hint,
            transcript_mtime_ms,
            transcript_size_bytes,
            latest_messages,
            git_snapshot,
        })
    })
    .await
    .map_err(|error| format!("探测外部工作区脉冲失败：{error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_safe_session_ids_and_cli_specs() {
        assert!(validate_safe_session_id("thr_01abc-DEF.9").is_ok());
        assert!(validate_safe_session_id("").is_err());
        assert!(validate_safe_session_id("../escape").is_err());
        assert!(validate_safe_session_id("abc && calc").is_err());

        let (bin, args) = build_external_cli_resume_spec("claude-code", "sess-123").unwrap();
        assert_eq!(bin, "claude");
        assert_eq!(args, vec!["--resume", "sess-123"]);

        let (bin2, args2) = build_external_cli_resume_spec("codex", "thr_456").unwrap();
        assert_eq!(bin2, "codex");
        assert_eq!(args2, vec!["resume", "thr_456"]);

        assert!(build_external_cli_resume_spec("unknown", "thr_456").is_err());
    }

    #[test]
    fn recent_transcript_window_marks_active_and_expired_correctly() {
        assert!(is_recent_transcript_activity(Some(10_000), 12_500, 4_000));
        assert!(!is_recent_transcript_activity(Some(10_000), 15_000, 4_000));
        assert!(!is_recent_transcript_activity(None, 12_500, 4_000));
    }

    #[test]
    fn non_git_folder_returns_none_git_snapshot_without_error() {
        let dir = std::env::temp_dir().join(format!("rcx-non-git-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        assert!(inspect_workspace_git_sync(&dir).is_err());
        let snap = inspect_workspace_git_sync(&dir).ok();
        assert!(snap.is_none());
        let _ = fs::remove_dir_all(&dir);
    }
}
