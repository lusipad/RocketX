// 阻止 Windows release 版本弹出控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        // HTTP 走 Rust 通道，绕开 webview CORS——连接任意 Rocket.Chat 服务器
        // 都不需要服务端开启 API_Enable_CORS
        .plugin(tauri_plugin_http::init())
        // 外部链接用系统默认浏览器打开（webview 里 target="_blank" 无效）
        .plugin(tauri_plugin_opener::init())
        // 下载文件：webview 忽略 blob URL 上的 download 属性，
        // 必须用原生「另存为」对话框 + 文件写入
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .run(tauri::generate_context!())
        .expect("error while running RocketX");
}
