// 阻止 Windows release 版本弹出控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent_bot;
mod diagnostics;
mod mcp;
mod proc;
mod winauth;

use std::{
    collections::HashSet,
    io::{Read, Write},
    path::PathBuf,
    process::{Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};
#[cfg(windows)]
use tauri::Emitter;
use tauri::{
    image::Image,
    ipc::CapabilityBuilder,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind, WEBVIEW_TARGET};

const MAIN_TRAY_ID: &str = "main";

struct AllowedHttpOrigins(Mutex<HashSet<String>>);

struct AiKeychainLock(Mutex<()>);

const AI_KEYCHAIN_SERVICE: &str = "com.lusipad.rocketx.ai";

fn validate_ai_provider_id(provider_id: &str) -> Result<&str, String> {
    let provider_id = provider_id.trim();
    if provider_id.is_empty()
        || provider_id.len() > 128
        || provider_id.chars().any(char::is_control)
    {
        return Err("invalid AI provider id".to_string());
    }
    Ok(provider_id)
}

fn ai_keychain_entry(provider_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(AI_KEYCHAIN_SERVICE, validate_ai_provider_id(provider_id)?)
        .map_err(|error| format!("AI keychain is unavailable: {error}"))
}

#[tauri::command]
fn ai_secret_set(
    keychain: tauri::State<'_, AiKeychainLock>,
    provider_id: String,
    secret: String,
) -> Result<(), String> {
    if secret.is_empty() || secret.len() > 64 * 1024 {
        return Err("invalid AI provider secret".to_string());
    }
    let _guard = keychain
        .0
        .lock()
        .map_err(|_| "AI keychain lock is unavailable".to_string())?;
    ai_keychain_entry(&provider_id)?
        .set_password(&secret)
        .map_err(|error| format!("failed to save AI provider secret: {error}"))
}

#[tauri::command]
fn ai_secret_get(
    keychain: tauri::State<'_, AiKeychainLock>,
    provider_id: String,
) -> Result<Option<String>, String> {
    let _guard = keychain
        .0
        .lock()
        .map_err(|_| "AI keychain lock is unavailable".to_string())?;
    match ai_keychain_entry(&provider_id)?.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("failed to read AI provider secret: {error}")),
    }
}

#[tauri::command]
fn ai_secret_delete(
    keychain: tauri::State<'_, AiKeychainLock>,
    provider_id: String,
) -> Result<(), String> {
    let _guard = keychain
        .0
        .lock()
        .map_err(|_| "AI keychain lock is unavailable".to_string())?;
    match ai_keychain_entry(&provider_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("failed to delete AI provider secret: {error}")),
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexExecResult {
    text: String,
    thread_id: Option<String>,
}

fn run_codex_once(cache_dir: PathBuf, prompt: String) -> Result<CodexExecResult, String> {
    if prompt.trim().is_empty() || prompt.len() > 100_000 {
        return Err("Codex prompt is empty or too long".to_string());
    }
    std::fs::create_dir_all(&cache_dir)
        .map_err(|error| format!("failed to prepare Codex workspace: {error}"))?;
    let mut command = Command::new("codex");
    command.args([
        "exec",
        "--json",
        "--sandbox",
        "read-only",
        "--ephemeral",
        "--ignore-user-config",
        "--skip-git-repo-check",
        "--color",
        "never",
        "-C",
    ]);
    command.arg(&cache_dir).arg("-");
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("Codex CLI is unavailable: {error}"))?;
    child
        .stdin
        .take()
        .ok_or_else(|| "Codex stdin is unavailable".to_string())?
        .write_all(prompt.as_bytes())
        .map_err(|error| format!("failed to send prompt to Codex: {error}"))?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Codex stdout is unavailable".to_string())?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Codex stderr is unavailable".to_string())?;
    let stdout_reader = thread::spawn(move || {
        let mut value = String::new();
        let _ = stdout.read_to_string(&mut value);
        value
    });
    let stderr_reader = thread::spawn(move || {
        let mut value = String::new();
        let _ = stderr.read_to_string(&mut value);
        value
    });
    let deadline = Instant::now() + Duration::from_secs(300);
    let status = loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("failed to monitor Codex: {error}"))?
        {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Codex timed out after 5 minutes".to_string());
        }
        thread::sleep(Duration::from_millis(100));
    };
    let stdout = stdout_reader
        .join()
        .map_err(|_| "failed to read Codex output".to_string())?;
    let stderr = stderr_reader
        .join()
        .map_err(|_| "failed to read Codex error output".to_string())?;
    if !status.success() {
        let detail = stderr.trim().chars().take(2_000).collect::<String>();
        return Err(format!(
            "Codex exited with {}{}",
            status,
            if detail.is_empty() {
                String::new()
            } else {
                format!(": {detail}")
            }
        ));
    }
    let mut text = String::new();
    let mut thread_id = None;
    for line in stdout.lines() {
        let Ok(event) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if event.get("type").and_then(|value| value.as_str()) == Some("thread.started") {
            thread_id = event
                .get("thread_id")
                .and_then(|value| value.as_str())
                .map(ToOwned::to_owned);
        }
        let item = event.get("item");
        if event.get("type").and_then(|value| value.as_str()) == Some("item.completed")
            && item
                .and_then(|value| value.get("type"))
                .and_then(|value| value.as_str())
                == Some("agent_message")
        {
            if let Some(value) = item
                .and_then(|value| value.get("text"))
                .and_then(|value| value.as_str())
            {
                text = value.to_string();
            }
        }
    }
    if text.trim().is_empty() {
        return Err("Codex completed without an agent response".to_string());
    }
    Ok(CodexExecResult { text, thread_id })
}

#[tauri::command]
async fn codex_exec_once(app: tauri::AppHandle, prompt: String) -> Result<CodexExecResult, String> {
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("failed to resolve app cache directory: {error}"))?
        .join("codex-once");
    tauri::async_runtime::spawn_blocking(move || run_codex_once(cache_dir, prompt))
        .await
        .map_err(|error| format!("Codex task failed: {error}"))?
}

fn normalize_http_origin(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 2048 || value.chars().any(char::is_control) {
        return Err("invalid HTTP origin".to_string());
    }
    let url = tauri::Url::parse(value).map_err(|_| "invalid HTTP origin".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("only credential-free http/https origins are allowed".to_string());
    }
    Ok(url.origin().ascii_serialization())
}

#[tauri::command]
fn allow_http_origin(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    origins: tauri::State<'_, AllowedHttpOrigins>,
    origin: String,
) -> Result<String, String> {
    if webview.label() != "main" {
        return Err("HTTP origin registration is limited to the main webview".to_string());
    }
    let origin = normalize_http_origin(&origin)?;
    let mut allowed = origins
        .0
        .lock()
        .map_err(|_| "HTTP origin registry is unavailable".to_string())?;
    if allowed.contains(&origin) {
        return Ok(origin);
    }
    let capability = CapabilityBuilder::new(format!("http-origin-{}", allowed.len()))
        .webview("main")
        .permission_scoped("http:default", vec![origin.clone()], Vec::<String>::new());
    app.add_capability(capability)
        .map_err(|error| error.to_string())?;
    allowed.insert(origin.clone());
    Ok(origin)
}

/// 显示并聚焦主窗口（从托盘点回来）
fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[tauri::command]
fn show_main_window(app: tauri::AppHandle) {
    show_main(&app);
}

#[cfg(windows)]
#[derive(Clone, serde::Serialize)]
struct NotificationRoomPayload {
    rid: String,
    mid: String,
}

#[cfg(windows)]
fn notification_opens_room(response: &notify_rust::NotificationResponse) -> bool {
    response.is_default_action()
}

#[cfg(windows)]
#[tauri::command]
fn show_message_notification(
    app: tauri::AppHandle,
    title: String,
    body: String,
    rid: String,
    mid: String,
) -> Result<(), String> {
    let rid = rid.trim().to_string();
    let mid = mid.trim().to_string();
    if rid.is_empty()
        || rid.len() > 256
        || rid.chars().any(char::is_control)
        || mid.is_empty()
        || mid.len() > 256
        || mid.chars().any(char::is_control)
    {
        return Err("invalid notification target".to_string());
    }

    let mut notification = notify_rust::Notification::new();
    notification.summary(&title).body(&body);

    // 未安装的 target/debug、target/release 没有注册 AppUserModelId，沿用 PowerShell 标识；
    // 安装包运行时才使用应用 identifier，与官方通知插件行为一致。
    let target_build = tauri::utils::platform::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(std::path::Path::to_path_buf))
        .is_some_and(|dir| {
            dir.ends_with(std::path::Path::new("target").join("debug"))
                || dir.ends_with(std::path::Path::new("target").join("release"))
        });
    if !target_build {
        notification.app_id(&app.config().identifier);
    }

    let handle = notification.show().map_err(|err| err.to_string())?;
    std::thread::spawn(move || {
        let _ = handle.wait_for_response(move |response: &notify_rust::NotificationResponse| {
            if notification_opens_room(response) {
                show_main(&app);
                let _ = app.emit(
                    "notification-open-room",
                    NotificationRoomPayload { rid, mid },
                );
            }
        });
    });
    Ok(())
}

#[cfg(all(test, windows))]
mod tests {
    use super::notification_opens_room;
    use notify_rust::{CloseReason, NotificationResponse};

    #[test]
    fn only_notification_body_click_opens_room() {
        assert!(notification_opens_room(&NotificationResponse::Default));
        assert!(!notification_opens_room(&NotificationResponse::Action(
            "reply".to_string()
        )));
        assert!(!notification_opens_room(&NotificationResponse::Closed(
            CloseReason::Dismissed
        )));
    }
}

#[cfg(not(windows))]
#[tauri::command]
fn show_message_notification(
    _app: tauri::AppHandle,
    _title: String,
    _body: String,
    _rid: String,
    _mid: String,
) -> Result<(), String> {
    Err("clickable notifications are only available on Windows".to_string())
}

#[tauri::command]
fn set_tray_icon_normal(app: tauri::AppHandle, normal: bool) -> Result<(), String> {
    let tray = app
        .tray_by_id(MAIN_TRAY_ID)
        .ok_or_else(|| "main tray icon is not available".to_string())?;
    let default_icon = app
        .default_window_icon()
        .ok_or_else(|| "default window icon is not available".to_string())?;
    let icon = if normal {
        default_icon.clone()
    } else {
        // Windows 会把全透明的动态托盘帧合成为黑底；保留原 alpha，只降低 RGB 亮度。
        dim_tray_icon(default_icon)
    };
    tray.set_icon(Some(icon)).map_err(|err| err.to_string())
}

fn dim_tray_icon(source: &Image<'_>) -> Image<'static> {
    let mut rgba = source.rgba().to_vec();
    for pixel in rgba.chunks_exact_mut(4) {
        pixel[0] = ((pixel[0] as u16 * 35) / 100) as u8;
        pixel[1] = ((pixel[1] as u16 * 35) / 100) as u8;
        pixel[2] = ((pixel[2] as u16 * 35) / 100) as u8;
    }
    Image::new_owned(rgba, source.width(), source.height())
}

#[tauri::command]
fn set_tray_tooltip(app: tauri::AppHandle, tooltip: String) -> Result<(), String> {
    let tray = app
        .tray_by_id(MAIN_TRAY_ID)
        .ok_or_else(|| "main tray icon is not available".to_string())?;
    tray.set_tooltip(Some(tooltip))
        .map_err(|err| err.to_string())
}

#[cfg(test)]
mod tray_icon_tests {
    use super::{dim_tray_icon, normalize_http_origin, validate_ai_provider_id};
    use tauri::image::Image;

    #[test]
    fn dim_frame_keeps_alpha_channel() {
        let source = Image::new_owned(vec![100, 200, 50, 0, 200, 100, 40, 255], 2, 1);
        let dimmed = dim_tray_icon(&source);
        assert_eq!(dimmed.rgba(), &[35, 70, 17, 0, 70, 35, 14, 255]);
    }

    #[test]
    fn http_scope_keeps_only_exact_origin() {
        assert_eq!(
            normalize_http_origin("https://chat.example.test:8443/path?q=1").unwrap(),
            "https://chat.example.test:8443"
        );
        assert!(normalize_http_origin("ftp://chat.example.test").is_err());
        assert!(normalize_http_origin("https://user:secret@chat.example.test").is_err());
    }

    #[test]
    fn ai_keychain_rejects_unsafe_provider_ids() {
        assert_eq!(validate_ai_provider_id("deepseek").unwrap(), "deepseek");
        assert!(validate_ai_provider_id("").is_err());
        assert!(validate_ai_provider_id("bad\nname").is_err());
    }
}

fn main() {
    if std::env::args().any(|argument| argument == "--mcp") {
        if let Err(error) = mcp::run_stdio() {
            eprintln!("rcx-mcp: {error}");
            std::process::exit(1);
        }
        return;
    }
    tauri::Builder::default()
        // 必须最先注册：第二次启动立即退出，并把已存在的主窗口带回前台。
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app);
        }))
        // Windows 集成认证（NTLM/Negotiate）：域内 ADO Server 的默认认证方式，
        // webview 和 reqwest 都做不到「用当前登录用户的凭据」，只能走 WinHTTP
        .invoke_handler(tauri::generate_handler![
            allow_http_origin,
            diagnostics::collect_diagnostic_logs,
            winauth::win_auth_request,
            set_tray_icon_normal,
            set_tray_tooltip,
            show_main_window,
            show_message_notification,
            ai_secret_set,
            ai_secret_get,
            ai_secret_delete,
            codex_exec_once,
            proc::codex_runner_status,
            proc::codex_runner_install,
            proc::codex_app_server_start,
            proc::codex_app_server_write,
            proc::codex_app_server_stop,
            proc::codex_agent_workspace,
            proc::codex_agent_attachment_write,
            mcp::mcp_config_enable,
            mcp::mcp_config_status,
            mcp::mcp_config_disable,
            agent_bot::agent_bot_config_set,
            agent_bot::agent_bot_config_status,
            agent_bot::agent_bot_config_delete,
            agent_bot::agent_bot_send
        ])
        .manage(AllowedHttpOrigins(Mutex::new(HashSet::new())))
        .manage(AiKeychainLock(Mutex::new(())))
        .manage(proc::CodexAppServerState::default())
        .manage(mcp::McpConfigLock(Mutex::new(())))
        .manage(agent_bot::AgentBotLock(Mutex::new(())))
        // HTTP 走 Rust 通道，绕开 webview CORS——连接任意 Rocket.Chat 服务器
        // 都不需要服务端开启 API_Enable_CORS
        .plugin(tauri_plugin_http::init())
        // GitHub Releases 更新通道；签名公钥和 endpoint 由 tauri.conf.json 固定。
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // 外部链接用系统默认浏览器打开（webview 里 target="_blank" 无效）
        .plugin(tauri_plugin_opener::init())
        // 下载文件：webview 忽略 blob URL 上的 download 属性，
        // 必须用原生「另存为」对话框 + 文件写入
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        // 只持久化前端显式写入的脱敏诊断事件；不接管 console，也不收集依赖日志。
        .plugin(
            tauri_plugin_log::Builder::new()
                .clear_targets()
                .target(
                    Target::new(TargetKind::LogDir {
                        file_name: Some("rocketx".into()),
                    })
                    .filter(|metadata| metadata.target().starts_with(WEBVIEW_TARGET)),
                )
                .level(log::LevelFilter::Info)
                .max_file_size(1_000_000)
                .rotation_strategy(RotationStrategy::KeepOne)
                .build(),
        )
        // 系统通知：WebView2 里 Web Notification 常年被判 denied（issue #4）
        .plugin(tauri_plugin_notification::init())
        // Windows 全局指令中心快捷键；具体组合由 Web 设置页注册和切换。
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        // 开机自启由系统登记，设置页只负责读取和切换，不自行修改注册表。
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            // 系统托盘：显示 / 退出（issue #3）
            let show = MenuItem::with_id(app, "show", "显示 RocketX", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            TrayIconBuilder::with_id(MAIN_TRAY_ID)
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("RocketX")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    // 左键单击托盘图标 → 显示主窗口
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // 点关闭按钮 = 隐藏到托盘，不退出进程（issue #3）。
            // 真正退出走托盘菜单的「退出」。
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building RocketX")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                proc::shutdown(app);
            }
        });
}
