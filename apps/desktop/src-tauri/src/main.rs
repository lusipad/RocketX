// 阻止 Windows release 版本弹出控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent_bot;
mod business_mcp;
mod butler_db;
mod diagnostics;
mod dsh;
mod lan;
#[cfg(test)]
mod live_e2e;
mod mcp;
mod native;
mod native_service;
mod ocr;
mod proc;
mod winauth;

use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::Mutex,
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
use tauri_plugin_autostart::ManagerExt as AutostartManagerExt;
use tauri_plugin_http::reqwest::{
    multipart::{Form, Part},
    redirect::Policy,
    Client,
};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind, WEBVIEW_TARGET};
use tauri_plugin_opener::OpenerExt;

const MAIN_TRAY_ID: &str = "main";
const AUTOSTART_ARG: &str = "--autostart";
const PACKAGE_PROFILE_FILE: &str = "rocketx-package-profile";
const AUTOSTART_PREFERENCE_FILE: &str = "autostart-preference";
const DESKTOP_PREFERENCES_FILE: &str = "desktop-preferences.json";

fn normalize_desktop_distribution_profile(value: Option<&str>) -> &'static str {
    match value.map(str::trim) {
        Some("full") => "full",
        Some("slim") => "slim",
        _ => "unknown",
    }
}

#[tauri::command]
fn desktop_distribution_profile() -> &'static str {
    if std::env::current_exe().is_ok_and(|executable| executable_is_local_build(&executable)) {
        return "unknown";
    }
    let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") else {
        return "unknown";
    };
    let profile_path = PathBuf::from(local_app_data)
        .join("RocketX")
        .join(PACKAGE_PROFILE_FILE);
    let profile = std::fs::read_to_string(profile_path).ok();
    normalize_desktop_distribution_profile(profile.as_deref())
}

struct AllowedHttpOrigins(Mutex<HashSet<String>>);

#[cfg(windows)]
#[derive(Clone, Copy, Debug)]
enum WebviewMemoryUsage {
    Normal,
    Low,
}

fn is_autostart_launch<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter()
        .any(|argument| argument.as_ref() == AUTOSTART_ARG)
}

fn launch_opens_main_window<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    !is_autostart_launch(args)
}

fn executable_is_local_build(executable: &Path) -> bool {
    executable
        .parent()
        .and_then(Path::file_name)
        .and_then(|directory| directory.to_str())
        .is_some_and(|directory| {
            directory.eq_ignore_ascii_case("debug") || directory.eq_ignore_ascii_case("release")
        })
}

fn autostart_registration_allowed(debug: bool, executable: &Path) -> bool {
    !debug && !executable_is_local_build(executable)
}

fn current_autostart_registration_allowed() -> Result<bool, String> {
    let executable = std::env::current_exe()
        .map_err(|error| format!("无法确认当前 RocketX 安装路径：{error}"))?;
    Ok(autostart_registration_allowed(
        cfg!(debug_assertions),
        &executable,
    ))
}

fn autostart_preference_path<R: tauri::Runtime, M: Manager<R>>(app: &M) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join(AUTOSTART_PREFERENCE_FILE))
        .map_err(|error| format!("无法获取开机启动偏好目录：{error}"))
}

fn read_autostart_preference<R: tauri::Runtime, M: Manager<R>>(app: &M) -> Result<Option<bool>, String> {
    let path = autostart_preference_path(app)?;
    match std::fs::read_to_string(path) {
        Ok(value) => Ok(match value.trim() {
            "1" => Some(true),
            "0" => Some(false),
            _ => None,
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("无法读取开机启动偏好：{error}")),
    }
}

fn write_autostart_preference<R: tauri::Runtime, M: Manager<R>>(
    app: &M,
    enabled: bool,
) -> Result<(), String> {
    let path = autostart_preference_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("无法创建开机启动偏好目录：{error}"))?;
    }
    std::fs::write(path, if enabled { "1" } else { "0" })
        .map_err(|error| format!("无法保存开机启动偏好：{error}"))
}

fn desktop_preferences_path<R: tauri::Runtime, M: Manager<R>>(app: &M) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join(DESKTOP_PREFERENCES_FILE))
        .map_err(|error| format!("无法获取桌面偏好目录：{error}"))
}

#[tauri::command]
fn read_desktop_preferences(
    app: tauri::AppHandle,
    scope: String,
) -> Result<Option<serde_json::Value>, String> {
    let path = desktop_preferences_path(&app)?;
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("无法读取桌面偏好：{error}")),
    };
    let records = serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&raw)
        .map_err(|error| format!("桌面偏好文件无效：{error}"))?;
    Ok(records.get(&scope).cloned())
}

#[tauri::command]
fn write_desktop_preferences(
    app: tauri::AppHandle,
    scope: String,
    patch: serde_json::Value,
) -> Result<(), String> {
    let path = desktop_preferences_path(&app)?;
    let mut records = if let Ok(raw) = std::fs::read_to_string(&path) {
        serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&raw)
            .map_err(|error| format!("桌面偏好文件无效：{error}"))?
    } else {
        serde_json::Map::new()
    };
    let mut current = records
        .remove(&scope)
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    if let Some(patch) = patch.as_object() {
        current.extend(patch.clone());
    }
    records.insert(scope, serde_json::Value::Object(current));
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("无法创建桌面偏好目录：{error}"))?;
    }
    let content = serde_json::to_vec(&records).map_err(|error| format!("无法序列化桌面偏好：{error}"))?;
    std::fs::write(path, content).map_err(|error| format!("无法保存桌面偏好：{error}"))
}

#[cfg_attr(not(test), allow(dead_code))]
fn refresh_autostart_registration_with(
    allowed: bool,
    is_enabled: impl FnOnce() -> Result<bool, String>,
    enable: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    if !allowed {
        return Ok(());
    }
    if is_enabled()? {
        enable()?;
    }
    Ok(())
}

fn refresh_autostart_registration<R: tauri::Runtime>(app: &tauri::App<R>) -> Result<(), String> {
    let manager = app.autolaunch();
    if !current_autostart_registration_allowed()? {
        return Ok(());
    }
    let registered = manager.is_enabled().map_err(|error| error.to_string())?;
    let remembered = read_autostart_preference(app)?;
    if remembered == Some(false) {
        if registered {
            manager.disable().map_err(|error| error.to_string())?;
        }
        return Ok(());
    }
    if remembered == Some(true) || registered {
        // 官方插件的 is_enabled 只检查注册表值是否存在，不检查其中的 EXE 路径。
        // 每次正式版启动都覆盖一次，避免升级或安装目录变化后仍指向旧文件。
        manager.enable().map_err(|error| error.to_string())?;
        write_autostart_preference(app, true)?;
    }
    Ok(())
}

#[tauri::command]
fn read_autostart_enabled(app: tauri::AppHandle) -> Result<Option<bool>, String> {
    if !current_autostart_registration_allowed()? {
        return Ok(None);
    }
    let registered = app.autolaunch().is_enabled().map_err(|error| error.to_string())?;
    Ok(Some(read_autostart_preference(&app)?.unwrap_or(registered)))
}

#[tauri::command]
fn set_autostart_enabled(app: tauri::AppHandle, enabled: bool) -> Result<bool, String> {
    if !current_autostart_registration_allowed()? {
        return Err("本地构建版不能设置开机启动；请使用正式安装版".to_string());
    }
    let manager = app.autolaunch();
    if enabled {
        manager.enable().map_err(|error| error.to_string())?;
    } else {
        manager.disable().map_err(|error| error.to_string())?;
    }
    let actual = manager.is_enabled().map_err(|error| error.to_string())?;
    write_autostart_preference(&app, enabled && actual)?;
    Ok(actual)
}

fn validate_external_url(url: &str) -> Result<&str, String> {
    let url = url.trim();
    if url.len() > 8192 || url.chars().any(char::is_control) {
        return Err("invalid external URL".to_string());
    }
    let parsed = tauri::Url::parse(url).map_err(|_| "invalid external URL".to_string())?;
    if matches!(parsed.scheme(), "http" | "https") {
        return Ok(url);
    }
    if matches!(
        url,
        "codex://automations" | "codex://plugins/" | "codex://skills" | "codex://settings"
    ) {
        return Ok(url);
    }
    if parsed.scheme() == "codex"
        && parsed.host_str() == Some("threads")
        && parsed.fragment().is_none()
    {
        let thread_id = parsed.path().strip_prefix('/').unwrap_or_default();
        if thread_id != "new"
            && parsed.query().is_none()
            && !thread_id.is_empty()
            && thread_id.len() <= 256
            && thread_id.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '-' | '_')
            })
        {
            return Ok(url);
        }
        if thread_id == "new" {
            let mut prompt = false;
            let mut path = false;
            for (key, value) in parsed.query_pairs() {
                match key.as_ref() {
                    "prompt" if !prompt && !value.is_empty() => prompt = true,
                    "path"
                        if !path
                            && value.len() <= 2048
                            && !value.chars().any(char::is_control)
                            && std::path::Path::new(value.as_ref()).is_absolute() =>
                    {
                        path = true;
                    }
                    _ => return Err("unsupported external URL".to_string()),
                }
            }
            if prompt || path {
                return Ok(url);
            }
        }
    }
    Err("unsupported external URL".to_string())
}

#[tauri::command]
fn open_external_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    app.opener()
        .open_url(validate_external_url(&url)?, None::<&str>)
        .map_err(|error| format!("failed to open external URL: {error}"))
}

fn resolve_download_history_path(path: &str) -> Result<PathBuf, String> {
    if path.is_empty() || path.len() > 32_768 || path.chars().any(char::is_control) {
        return Err("下载记录中的路径无效".to_string());
    }
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err("下载记录中的路径必须是绝对路径".to_string());
    }
    let resolved = path
        .canonicalize()
        .map_err(|_| "下载文件不存在或已被移动".to_string())?;
    if !resolved.is_file() {
        return Err("下载记录指向的不是文件".to_string());
    }
    Ok(resolved)
}

#[tauri::command]
fn download_history_open(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let target = resolve_download_history_path(&path)?;
    app.opener()
        .open_path(target.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|error| format!("无法使用系统应用打开文件：{error}"))
}

#[tauri::command]
fn open_local_file(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let target = resolve_download_history_path(&path)?;
    app.opener()
        .open_path(target.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|error| format!("无法使用系统应用打开局域网文件：{error}"))
}

fn resolve_unc_path(path: &str) -> Result<&str, String> {
    if path.is_empty() || path.len() > 32_768 || path.chars().any(char::is_control) {
        return Err("局域网共享路径无效".to_string());
    }
    if !path.starts_with(r"\\") || path.contains('/') || path.starts_with(r"\\?\") {
        return Err("局域网共享路径必须是 UNC 路径".to_string());
    }
    let mut segments = path[2..].split('\\');
    let host = segments.next().unwrap_or_default();
    let share = segments.next().unwrap_or_default();
    if host.is_empty() || share.is_empty() || host == "." {
        return Err("局域网共享路径必须包含主机和共享名".to_string());
    }
    Ok(path)
}

#[tauri::command]
fn open_unc_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    app.opener()
        .open_path(resolve_unc_path(&path)?, None::<&str>)
        .map_err(|error| format!("无法使用系统应用打开局域网共享路径：{error}"))
}

#[tauri::command]
fn download_history_reveal(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let target = resolve_download_history_path(&path)?;
    app.opener()
        .reveal_item_in_dir(target)
        .map_err(|error| format!("无法打开文件所在目录：{error}"))
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

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeMediaUploadResult {
    status: u16,
    error: Option<String>,
    error_type: Option<String>,
}

fn native_media_url(server_url: &str, segments: &[&str]) -> Result<tauri::Url, String> {
    let mut url = tauri::Url::parse(server_url)
        .map_err(|_| "Rocket.Chat 服务器地址无效".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Rocket.Chat 服务器地址无效".to_string());
    }
    let base_path = url.path().trim_end_matches('/').to_string();
    url.set_path(&format!("{base_path}/api/v1"));
    url.path_segments_mut()
        .map_err(|_| "Rocket.Chat 服务器地址无效".to_string())?
        .extend(segments);
    Ok(url)
}

fn native_media_response(status: u16, body: &str) -> NativeMediaUploadResult {
    let parsed = serde_json::from_str::<serde_json::Value>(body).ok();
    NativeMediaUploadResult {
        status,
        error: parsed
            .as_ref()
            .and_then(|value| value.get("error").or_else(|| value.get("message")))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        error_type: parsed
            .as_ref()
            .and_then(|value| value.get("errorType"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
    }
}

fn native_media_confirm_body(msg: Option<String>, tmid: Option<String>) -> serde_json::Value {
    let mut body = serde_json::Map::from_iter([(
        "msg".to_string(),
        serde_json::Value::String(msg.unwrap_or_default()),
    )]);
    if let Some(tmid) = tmid {
        body.insert("tmid".to_string(), serde_json::Value::String(tmid));
    }
    serde_json::Value::Object(body)
}

#[tauri::command]
async fn upload_native_media(
    webview: tauri::Webview,
    origins: tauri::State<'_, AllowedHttpOrigins>,
    server_url: String,
    path: String,
    rid: String,
    auth_token: String,
    user_id: String,
    msg: Option<String>,
    tmid: Option<String>,
) -> Result<NativeMediaUploadResult, String> {
    if webview.label() != "main" {
        return Err("原生文件上传仅允许主窗口调用".to_string());
    }
    if rid.is_empty()
        || rid.len() > 256
        || rid.chars().any(char::is_control)
        || auth_token.is_empty()
        || user_id.is_empty()
        || tmid.as_ref().is_some_and(|value| {
            value.is_empty() || value.len() > 256 || value.chars().any(char::is_control)
        })
    {
        return Err("原生文件上传参数无效".to_string());
    }
    let upload_url = native_media_url(&server_url, &["rooms.media", &rid])?;
    let origin = upload_url.origin().ascii_serialization();
    let allowed = origins
        .0
        .lock()
        .map_err(|_| "HTTP origin registry is unavailable".to_string())?
        .contains(&origin);
    if !allowed {
        return Err("Rocket.Chat 服务器地址尚未由宿主授权".to_string());
    }
    let source = PathBuf::from(path);
    let file_name = source
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty() && !value.chars().any(char::is_control))
        .ok_or_else(|| "本地文件名无效".to_string())?
        .to_string();
    let part = Part::file(&source)
        .await
        .map_err(|error| format!("无法读取待上传文件：{error}"))?
        .file_name(file_name);
    let client = Client::builder()
        .redirect(Policy::limited(5))
        .build()
        .map_err(|error| format!("无法创建上传连接：{error}"))?;
    let upload = client
        .post(upload_url)
        .header("X-Auth-Token", &auth_token)
        .header("X-User-Id", &user_id)
        .multipart(Form::new().part("file", part))
        .send()
        .await
        .map_err(|error| format!("上传文件失败：{error}"))?;
    let status = upload.status().as_u16();
    let body = upload
        .text()
        .await
        .map_err(|error| format!("无法读取上传响应：{error}"))?;
    if !(200..300).contains(&status) {
        return Ok(native_media_response(status, &body));
    }
    let file_id = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|value| value.pointer("/file/_id")?.as_str().map(str::to_string))
        .ok_or_else(|| "Rocket.Chat 上传响应缺少文件 ID".to_string())?;
    let confirm_url = native_media_url(&server_url, &["rooms.mediaConfirm", &rid, &file_id])?;
    let confirm_body = native_media_confirm_body(msg, tmid);
    let confirm = client
        .post(confirm_url)
        .header("X-Auth-Token", auth_token)
        .header("X-User-Id", user_id)
        .json(&confirm_body)
        .send()
        .await
        .map_err(|error| format!("确认文件消息失败：{error}"))?;
    let status = confirm.status().as_u16();
    let body = confirm
        .text()
        .await
        .map_err(|error| format!("无法读取文件确认响应：{error}"))?;
    Ok(native_media_response(status, &body))
}

#[cfg(windows)]
fn set_webview_memory_usage(window: &tauri::WebviewWindow, usage: WebviewMemoryUsage) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
    };
    use windows::core::Interface;

    let target = match usage {
        WebviewMemoryUsage::Normal => COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
        WebviewMemoryUsage::Low => COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
    };
    let label = window.label().to_string();
    if let Err(error) = window.with_webview(move |webview| {
        let result = unsafe { webview.controller().CoreWebView2() }
            .and_then(|webview| webview.cast::<ICoreWebView2_19>())
            .and_then(|webview| unsafe { webview.SetMemoryUsageTargetLevel(target) });
        if let Err(error) = result {
            log::warn!("failed to set {label} WebView2 memory target to {usage:?}: {error}");
        }
    }) {
        log::warn!("failed to access {} WebView2: {error}", window.label());
    }
}

#[cfg(windows)]
fn set_window_webview_memory_usage(window: &tauri::Window, usage: WebviewMemoryUsage) {
    if let Some(webview) = window.app_handle().get_webview_window(window.label()) {
        set_webview_memory_usage(&webview, usage);
    }
}

/// 显示并聚焦主窗口（从托盘点回来）
fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        #[cfg(windows)]
        set_webview_memory_usage(&w, WebviewMemoryUsage::Normal);
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
        .is_ok_and(|executable| executable_is_local_build(&executable));
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
    use super::{
        autostart_registration_allowed, dim_tray_icon, is_autostart_launch,
        launch_opens_main_window, native_media_confirm_body, native_media_response,
        native_media_url, normalize_desktop_distribution_profile, normalize_http_origin,
        refresh_autostart_registration_with, resolve_download_history_path, resolve_unc_path,
        validate_external_url,
    };
    use std::{cell::Cell, path::Path};
    use tauri::image::Image;

    #[test]
    fn dim_frame_keeps_alpha_channel() {
        let source = Image::new_owned(vec![100, 200, 50, 0, 200, 100, 40, 255], 2, 1);
        let dimmed = dim_tray_icon(&source);
        assert_eq!(dimmed.rgba(), &[35, 70, 17, 0, 70, 35, 14, 255]);
    }

    #[test]
    fn package_profile_accepts_only_installer_markers() {
        assert_eq!(
            normalize_desktop_distribution_profile(Some("full\r\n")),
            "full"
        );
        assert_eq!(normalize_desktop_distribution_profile(Some("slim")), "slim");
        assert_eq!(normalize_desktop_distribution_profile(None), "unknown");
        assert_eq!(
            normalize_desktop_distribution_profile(Some("FULL")),
            "unknown"
        );
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
    fn native_media_request_preserves_server_subpath_and_omits_empty_thread() {
        assert_eq!(
            native_media_url(
                "https://chat.example.test/rocket",
                &["rooms.media", "room/id"]
            )
            .unwrap()
            .as_str(),
            "https://chat.example.test/rocket/api/v1/rooms.media/room%2Fid"
        );
        assert_eq!(
            native_media_confirm_body(Some("caption".into()), None),
            serde_json::json!({ "msg": "caption" })
        );
        assert_eq!(
            native_media_confirm_body(None, Some("thread-id".into())),
            serde_json::json!({ "msg": "", "tmid": "thread-id" })
        );
        let error = native_media_response(
            413,
            r#"{"error":"File too large","errorType":"error-file-too-large"}"#,
        );
        assert_eq!(error.status, 413);
        assert_eq!(error.error.as_deref(), Some("File too large"));
        assert_eq!(error.error_type.as_deref(), Some("error-file-too-large"));
    }

    #[test]
    fn external_url_allows_http_and_known_codex_surfaces_only() {
        assert_eq!(
            validate_external_url(" https://example.com/path ").unwrap(),
            "https://example.com/path"
        );
        assert_eq!(
            validate_external_url("HTTPS://example.com/path").unwrap(),
            "HTTPS://example.com/path"
        );
        assert_eq!(
            validate_external_url("codex://threads/019f7dcd-7b86-7c02-9ba6-7eadd0cf790d").unwrap(),
            "codex://threads/019f7dcd-7b86-7c02-9ba6-7eadd0cf790d"
        );
        let mut new_thread_url = tauri::Url::parse("codex://threads/new").unwrap();
        new_thread_url
            .query_pairs_mut()
            .append_pair("prompt", "继续处理")
            .append_pair("path", std::env::temp_dir().to_string_lossy().as_ref());
        assert!(validate_external_url(new_thread_url.as_str()).is_ok());
        assert!(validate_external_url("codex://threads/").is_err());
        assert!(validate_external_url("codex://threads/new").is_err());
        assert!(validate_external_url("codex://threads/new?prompt=").is_err());
        assert!(validate_external_url("codex://threads/new?path=relative").is_err());
        assert!(validate_external_url("codex://threads/new?prompt=ok&unsafe=1").is_err());
        assert!(validate_external_url("codex://automations").is_ok());
        assert!(validate_external_url("codex://plugins/").is_ok());
        assert!(validate_external_url("codex://skills").is_ok());
        assert!(validate_external_url("codex://settings").is_ok());
        assert!(validate_external_url("codex://settings?section=memory").is_err());
        assert!(validate_external_url("codex://unknown").is_err());
        assert!(validate_external_url("javascript:alert(1)").is_err());
        assert!(validate_external_url("https://example.com/\nheader").is_err());
    }

    #[test]
    fn autostart_refreshes_only_existing_release_registration() {
        let checks = Cell::new(0);
        let enables = Cell::new(0);
        refresh_autostart_registration_with(
            true,
            || {
                checks.set(checks.get() + 1);
                Ok(true)
            },
            || {
                enables.set(enables.get() + 1);
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(checks.get(), 1);
        assert_eq!(enables.get(), 1);

        refresh_autostart_registration_with(
            true,
            || Ok(false),
            || panic!("disabled registration must not be enabled"),
        )
        .unwrap();
        refresh_autostart_registration_with(
            false,
            || panic!("local build must not inspect the system registration"),
            || panic!("local build must not register itself"),
        )
        .unwrap();
    }

    #[test]
    fn autostart_rejects_debug_and_release_build_executables() {
        let local_release = Path::new("repo")
            .join("target")
            .join("release")
            .join("rocketx");
        let custom_target_release = Path::new("cargo-output").join("release").join("rocketx");
        let installed = Path::new("installed").join("RocketX").join("rocketx");

        assert!(!autostart_registration_allowed(false, &local_release));
        assert!(!autostart_registration_allowed(
            false,
            &custom_target_release
        ));
        assert!(!autostart_registration_allowed(true, &installed));
        assert!(autostart_registration_allowed(false, &installed));
    }

    #[test]
    fn autostart_marker_hides_only_system_login_launches() {
        assert!(is_autostart_launch(["RocketX.exe", "--autostart"]));
        assert!(!is_autostart_launch(["RocketX.exe", "--autostart=true"]));
        assert!(!launch_opens_main_window(["RocketX.exe", "--autostart"]));
        assert!(launch_opens_main_window(["RocketX.exe"]));
    }

    #[test]
    fn download_history_only_accepts_existing_absolute_files() {
        let current_exe = std::env::current_exe().unwrap();
        assert_eq!(
            resolve_download_history_path(current_exe.to_string_lossy().as_ref()).unwrap(),
            current_exe.canonicalize().unwrap()
        );
        assert!(resolve_download_history_path("relative.txt").is_err());
        assert!(resolve_download_history_path("missing\nfile.txt").is_err());
        assert!(
            resolve_download_history_path(std::env::temp_dir().to_string_lossy().as_ref()).is_err()
        );
    }

    #[test]
    fn unc_path_requires_a_host_and_share_without_device_or_mixed_paths() {
        assert_eq!(
            resolve_unc_path(r"\\fileserver\share\folder\file.txt").unwrap(),
            r"\\fileserver\share\folder\file.txt"
        );
        assert!(resolve_unc_path(r"C:\Users\file.txt").is_err());
        assert!(resolve_unc_path(r"\\fileserver").is_err());
        assert!(resolve_unc_path(r"\\?\UNC\fileserver\share").is_err());
        assert!(resolve_unc_path(r"\\fileserver/share/file.txt").is_err());
    }
}

fn main() {
    let launch_args = std::env::args().collect::<Vec<_>>();
    if proc::maybe_print_version(&launch_args) {
        return;
    }
    if launch_args
        .iter()
        .any(|argument| argument == "--apply-update-helper")
    {
        if let Err(error) = proc::maybe_run_update_helper(&launch_args) {
            eprintln!("rocketx-update-helper: {error}");
            std::process::exit(1);
        }
        return;
    }
    if launch_args
        .iter()
        .any(|argument| argument == "--business-mcp")
    {
        if let Err(error) = business_mcp::run_stdio() {
            eprintln!("rocketx-business-mcp: {error}");
            std::process::exit(1);
        }
        return;
    }
    if launch_args.iter().any(|argument| argument == "--mcp") {
        if let Err(error) = mcp::run_stdio() {
            eprintln!("rcx-mcp: {error}");
            std::process::exit(1);
        }
        return;
    }
    let show_main_on_launch = launch_opens_main_window(&launch_args);
    tauri::Builder::default()
        // 必须最先注册：第二实例立即退出；只有用户手动启动才把已有窗口带回前台。
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // 登录项若迟到且已有实例，不能把用户主动隐藏的窗口重新弹出来。
            if launch_opens_main_window(&args) {
                show_main(app);
            }
        }))
        // Windows 集成认证（NTLM/Negotiate）：域内 ADO Server 的默认认证方式，
        // webview 和 reqwest 都做不到「用当前登录用户的凭据」，只能走 WinHTTP
        .invoke_handler(tauri::generate_handler![
            allow_http_origin,
            upload_native_media,
            desktop_distribution_profile,
            open_external_url,
            read_autostart_enabled,
            set_autostart_enabled,
            read_desktop_preferences,
            write_desktop_preferences,
            download_history_open,
            open_local_file,
            open_unc_path,
            download_history_reveal,
            diagnostics::collect_diagnostic_logs,
            winauth::win_auth_request,
            set_tray_icon_normal,
            set_tray_tooltip,
            show_main_window,
            show_message_notification,
            ocr::image_ocr_recognize,
            ocr::image_ocr_runtime_probe,
            butler_db::butler_todo_add,
            butler_db::butler_todo_update,
            butler_db::butler_todo_delete,
            butler_db::butler_todo_list,
            butler_db::butler_todo_migrate_from_json,
            proc::codex_runtime_probe,
            proc::codex_app_server_start,
            proc::codex_app_server_write,
            proc::codex_app_server_stop,
            proc::codex_artifact_read,
            proc::codex_artifact_open,
            proc::codex_artifact_reveal,
            proc::codex_default_workspace,
            proc::codex_butler_workspace,
            proc::codex_automation_list,
            proc::codex_automation_write,
            proc::codex_automation_delete,
            proc::butler_azure_devops_server_read,
            proc::check_signed_http_update,
            proc::read_update_manifest_dir,
            proc::read_workspace_config_unc,
            proc::launch_update_installer,
            proc::take_update_result,
            proc::codex_agent_attachment_write,
            dsh::dsh_agent_attachment_write,
            dsh::dsh_runtime_probe,
            dsh::dsh_bridge_start,
            dsh::dsh_bridge_write,
            dsh::dsh_bridge_stop,
            mcp::mcp_config_enable,
            mcp::mcp_config_status,
            mcp::mcp_config_disable,
            business_mcp::business_mcp_launch_config,
            business_mcp::business_mcp_sync_rocket_chat,
            business_mcp::business_mcp_clear_rocket_chat,
            business_mcp::business_mcp_sync_azure_devops,
            business_mcp::business_mcp_clear_azure_devops,
            agent_bot::agent_bot_config_set,
            agent_bot::agent_bot_config_status,
            agent_bot::agent_bot_config_delete,
            agent_bot::agent_bot_send,
            native_service::native_service_start,
            native_service::native_service_call,
            native_service::native_service_stop,
            lan::lan_service_start,
            lan::lan_service_stop,
            lan::lan_trust_replace,
            lan::lan_peers,
            lan::lan_probe_peer,
            lan::lan_send_chat,
            lan::lan_send_file
        ])
        .manage(AllowedHttpOrigins(Mutex::new(HashSet::new())))
        .manage(native::host::NativeHost::default())
        .manage(proc::CodexRuntimeConfig::default())
        .manage(proc::CodexAppServerState::default())
        .manage(dsh::DshBridgeState::default())
        .manage(mcp::McpConfigLock(Mutex::new(())))
        .manage(business_mcp::BusinessMcpConfigLock(Mutex::new(())))
        .manage(agent_bot::AgentBotLock(Mutex::new(())))
        .manage(native_service::NativeServiceState::default())
        .manage(lan::LanKeychainLock::default())
        .manage(lan::LanRuntimeState::default())
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
            Some(vec![AUTOSTART_ARG]),
        ))
        .setup(move |app| {
            if show_main_on_launch {
                show_main(app.handle());
            } else {
                #[cfg(windows)]
                if let Some(window) = app.get_webview_window("main") {
                    set_webview_memory_usage(&window, WebviewMemoryUsage::Low);
                }
            }
            if let Err(error) = refresh_autostart_registration(app) {
                log::warn!("failed to refresh autostart registration: {error}");
            }
            // 管家待办池 SQLite
            let data_dir = app
                .path()
                .app_data_dir()
                .map_err(|error| std::io::Error::other(format!("无法获取应用数据目录：{error}")))?;
            let db = butler_db::init_db(data_dir).map_err(std::io::Error::other)?;
            app.manage(db);

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
        .on_window_event(|window, event| match event {
            // 点关闭按钮 = 隐藏到托盘，不退出进程（issue #3）。
            // 真正退出走托盘菜单的「退出」。
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = window.hide();
                #[cfg(windows)]
                set_window_webview_memory_usage(window, WebviewMemoryUsage::Low);
            }
            WindowEvent::Resized(_) =>
            {
                #[cfg(windows)]
                if window.is_minimized().unwrap_or(false) {
                    set_window_webview_memory_usage(window, WebviewMemoryUsage::Low);
                }
            }
            WindowEvent::Focused(false) => {
                #[cfg(windows)]
                set_window_webview_memory_usage(window, WebviewMemoryUsage::Low);
            }
            WindowEvent::Focused(true) => {
                #[cfg(windows)]
                set_window_webview_memory_usage(window, WebviewMemoryUsage::Normal);
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("error while building RocketX")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                app.state::<native::host::NativeHost>().shutdown(app);
            }
        });
}
