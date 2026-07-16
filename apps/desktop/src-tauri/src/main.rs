// 阻止 Windows release 版本弹出控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod diagnostics;
mod winauth;

#[cfg(windows)]
use tauri::Emitter;
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind, WEBVIEW_TARGET};

const MAIN_TRAY_ID: &str = "main";

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
) -> Result<(), String> {
    let rid = rid.trim().to_string();
    if rid.is_empty() || rid.len() > 256 || rid.chars().any(char::is_control) {
        return Err("invalid notification room id".to_string());
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
                let _ = app.emit("notification-open-room", NotificationRoomPayload { rid });
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
) -> Result<(), String> {
    Err("clickable notifications are only available on Windows".to_string())
}

#[tauri::command]
fn set_tray_icon_normal(app: tauri::AppHandle, normal: bool) -> Result<(), String> {
    let tray = app
        .tray_by_id(MAIN_TRAY_ID)
        .ok_or_else(|| "main tray icon is not available".to_string())?;
    let icon = if normal {
        app.default_window_icon()
            .cloned()
            .ok_or_else(|| "default window icon is not available".to_string())?
    } else {
        // 保留透明的 32x32 占位图，而不是隐藏托盘对象；闪烁间隙仍可点击。
        Image::new_owned(vec![0; 32 * 32 * 4], 32, 32)
    };
    tray.set_icon(Some(icon)).map_err(|err| err.to_string())
}

fn main() {
    tauri::Builder::default()
        // 必须最先注册：第二次启动立即退出，并把已存在的主窗口带回前台。
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app);
        }))
        // Windows 集成认证（NTLM/Negotiate）：域内 ADO Server 的默认认证方式，
        // webview 和 reqwest 都做不到「用当前登录用户的凭据」，只能走 WinHTTP
        .invoke_handler(tauri::generate_handler![
            diagnostics::collect_diagnostic_logs,
            winauth::win_auth_request,
            set_tray_icon_normal,
            show_main_window,
            show_message_notification
        ])
        // HTTP 走 Rust 通道，绕开 webview CORS——连接任意 Rocket.Chat 服务器
        // 都不需要服务端开启 API_Enable_CORS
        .plugin(tauri_plugin_http::init())
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
        .run(tauri::generate_context!())
        .expect("error while running RocketX");
}
