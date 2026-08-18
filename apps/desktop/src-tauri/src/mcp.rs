use std::io::{BufRead, Write};
use std::sync::Mutex;

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::winauth;

const MCP_KEYCHAIN_SERVICE: &str = "com.lusipad.rocketx.mcp";
const MCP_KEYCHAIN_ACCOUNT: &str = "active";
pub(crate) const MCP_PROTOCOL_VERSION: &str = "2025-06-18";

pub struct McpConfigLock(pub Mutex<()>);

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct McpConfig {
    server_url: String,
    user_id: String,
    auth_token: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConfigStatus {
    enabled: bool,
    server_url: Option<String>,
    user_id: Option<String>,
    command: Option<String>,
}

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(MCP_KEYCHAIN_SERVICE, MCP_KEYCHAIN_ACCOUNT)
        .map_err(|error| format!("MCP keychain is unavailable: {error}"))
}

pub(crate) fn normalize_server_url(value: &str) -> Result<String, String> {
    let value = value.trim().trim_end_matches('/');
    if value.len() > 2048
        || value.chars().any(char::is_control)
        || !(value.starts_with("http://") || value.starts_with("https://"))
    {
        return Err("invalid Rocket.Chat server URL".to_string());
    }
    Ok(value.to_string())
}

pub(crate) fn validate_credentials(user_id: &str, auth_token: &str) -> Result<(), String> {
    if user_id.is_empty()
        || auth_token.is_empty()
        || user_id.len() > 512
        || auth_token.len() > 8192
        || user_id.chars().any(char::is_control)
        || auth_token.chars().any(char::is_control)
    {
        return Err("invalid Rocket.Chat credentials".to_string());
    }
    Ok(())
}

fn load_config() -> Result<Option<McpConfig>, String> {
    match entry()?.get_password() {
        Ok(value) => serde_json::from_str(&value)
            .map(Some)
            .map_err(|_| "saved MCP configuration is invalid".to_string()),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("failed to read MCP configuration: {error}")),
    }
}

#[tauri::command]
pub fn mcp_config_enable(
    lock: tauri::State<'_, McpConfigLock>,
    server_url: String,
    user_id: String,
    auth_token: String,
) -> Result<(), String> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "MCP keychain lock is unavailable".to_string())?;
    let config = McpConfig {
        server_url: normalize_server_url(&server_url)?,
        user_id,
        auth_token,
    };
    validate_credentials(&config.user_id, &config.auth_token)?;
    let value = serde_json::to_string(&config)
        .map_err(|error| format!("failed to encode MCP configuration: {error}"))?;
    entry()?
        .set_password(&value)
        .map_err(|error| format!("failed to save MCP configuration: {error}"))
}

#[tauri::command]
pub fn mcp_config_status(lock: tauri::State<'_, McpConfigLock>) -> Result<McpConfigStatus, String> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "MCP keychain lock is unavailable".to_string())?;
    let config = load_config()?;
    Ok(McpConfigStatus {
        enabled: config.is_some(),
        server_url: config.as_ref().map(|value| value.server_url.clone()),
        user_id: config.map(|value| value.user_id),
        command: std::env::current_exe()
            .ok()
            .map(|value| value.to_string_lossy().into_owned()),
    })
}

#[tauri::command]
pub fn mcp_config_disable(lock: tauri::State<'_, McpConfigLock>) -> Result<(), String> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "MCP keychain lock is unavailable".to_string())?;
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("failed to delete MCP configuration: {error}")),
    }
}

pub(crate) fn percent_encode(value: &str) -> String {
    value
        .bytes()
        .flat_map(|byte| {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
                vec![byte as char]
            } else {
                format!("%{byte:02X}").chars().collect()
            }
        })
        .collect()
}

fn get_json(config: &McpConfig, endpoint: &str, query: &[(&str, String)]) -> Result<Value, String> {
    let query = query
        .iter()
        .map(|(key, value)| format!("{}={}", percent_encode(key), percent_encode(value)))
        .collect::<Vec<_>>()
        .join("&");
    let url = format!(
        "{}/api/v1/{}{}{}",
        config.server_url,
        endpoint,
        if query.is_empty() { "" } else { "?" },
        query
    );
    let response =
        winauth::blocking_token_request(&url, "GET", &config.user_id, &config.auth_token, None)?;
    if !(200..300).contains(&response.status) {
        return Err(format!("Rocket.Chat returned HTTP {}", response.status));
    }
    serde_json::from_str(&response.body)
        .map_err(|error| format!("Rocket.Chat returned invalid JSON: {error}"))
}

fn tools() -> Value {
    json!({"tools": [
        {
            "name": "rocketx_list_conversations",
            "title": "List Rocket.Chat conversations",
            "description": "List conversations accessible to the configured Rocket.Chat account.",
            "inputSchema": {"type": "object", "properties": {}, "additionalProperties": false},
            "annotations": {"readOnlyHint": true, "destructiveHint": false, "openWorldHint": false}
        },
        {
            "name": "rocketx_get_thread_context",
            "title": "Read a Rocket.Chat thread",
            "description": "Read messages from one Rocket.Chat thread by its root message id.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tmid": {"type": "string", "description": "Thread root message id"},
                    "count": {"type": "integer", "minimum": 1, "maximum": 200, "default": 100}
                },
                "required": ["tmid"],
                "additionalProperties": false
            },
            "annotations": {"readOnlyHint": true, "destructiveHint": false, "openWorldHint": false}
        },
        {
            "name": "rocketx_get_room_history",
            "title": "Read Rocket.Chat room history",
            "description": "Read recent messages from an accessible room. roomType is c, p, or d.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "roomId": {"type": "string"},
                    "roomType": {"type": "string", "enum": ["c", "p", "d"]},
                    "count": {"type": "integer", "minimum": 1, "maximum": 200, "default": 50}
                },
                "required": ["roomId", "roomType"],
                "additionalProperties": false
            },
            "annotations": {"readOnlyHint": true, "destructiveHint": false, "openWorldHint": false}
        },
        {
            "name": "rocketx_read_attachment",
            "title": "Read a Rocket.Chat attachment image",
            "description": "Read the original image of an attachment by its site-relative path (the title_link or image_url starting with /file-upload/). Returns MCP image content; non-image attachments are rejected.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Site-relative attachment path, e.g. /file-upload/<fileId>/<fileName>"}
                },
                "required": ["path"],
                "additionalProperties": false
            },
            "annotations": {"readOnlyHint": true, "destructiveHint": false, "openWorldHint": false}
        }
    ]})
}

fn string_arg<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    args.get(key)
        .and_then(Value::as_str)
        .filter(|value| {
            !value.is_empty() && value.len() <= 512 && !value.chars().any(char::is_control)
        })
        .ok_or_else(|| format!("invalid {key}"))
}

fn count_arg(args: &Value, default: u64) -> Result<u64, String> {
    let count = args.get("count").and_then(Value::as_u64).unwrap_or(default);
    if (1..=200).contains(&count) {
        Ok(count)
    } else {
        Err("count must be between 1 and 200".to_string())
    }
}

/// 附件大小上限：10MB，避免把超大文件整个塞进 MCP 响应。
pub(crate) const MAX_ATTACHMENT_BYTES: usize = 10 * 1024 * 1024;

/// 校验附件路径：只允许站内 /file-upload/ 相对路径。
/// 拒绝绝对 URL（防把凭据发到外站）和目录穿越（含百分号编码与反斜杠变体，
/// 因为服务器端路由可能先解码再匹配）。
fn validate_attachment_path(path: &str) -> Result<&str, String> {
    if !path.starts_with("/file-upload/") {
        return Err("path must be a site-relative path starting with /file-upload/".to_string());
    }
    let lowered = path.to_ascii_lowercase();
    if lowered.contains("..")
        || lowered.contains("%2e")
        || path.contains('\\')
        || path
            .chars()
            .any(|c| char::is_control(c) || c.is_whitespace())
    {
        return Err("path must not contain directory traversal or control characters".to_string());
    }
    Ok(path)
}

/// 带 keychain 里的凭据下载附件原图，Content-Type 是图片时返回 MCP image content。
fn read_attachment(config: &McpConfig, args: &Value) -> Result<Value, String> {
    let path = validate_attachment_path(string_arg(args, "path")?)?;
    let url = format!("{}{}", config.server_url, path);
    let response =
        winauth::blocking_token_request_bytes(&url, &config.user_id, &config.auth_token)?;
    if !(200..300).contains(&response.status) {
        return Err(format!("Rocket.Chat returned HTTP {}", response.status));
    }
    if response.body.len() > MAX_ATTACHMENT_BYTES {
        return Err("attachment exceeds the 10 MB size limit".to_string());
    }
    let mime = response
        .content_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if !mime.starts_with("image/") {
        return Err(format!(
            "attachment is not an image (Content-Type: {})",
            if response.content_type.is_empty() {
                "unknown"
            } else {
                &response.content_type
            }
        ));
    }
    let data = base64::engine::general_purpose::STANDARD.encode(&response.body);
    Ok(json!({
        "content": [{"type": "image", "data": data, "mimeType": mime}],
        "isError": false
    }))
}

fn call_tool(name: &str, args: &Value) -> Result<Value, String> {
    let config = load_config()?
        .ok_or_else(|| "Reverse MCP is not enabled in RocketX Settings > AI Steward".to_string())?;
    let value = match name {
        "rocketx_list_conversations" => get_json(&config, "subscriptions.get", &[])?,
        "rocketx_get_thread_context" => get_json(
            &config,
            "chat.getThreadMessages",
            &[
                ("tmid", string_arg(args, "tmid")?.to_string()),
                ("count", count_arg(args, 100)?.to_string()),
            ],
        )?,
        "rocketx_get_room_history" => {
            let endpoint = match string_arg(args, "roomType")? {
                "c" => "channels.history",
                "p" => "groups.history",
                "d" => "im.history",
                _ => return Err("roomType must be c, p, or d".to_string()),
            };
            get_json(
                &config,
                endpoint,
                &[
                    ("roomId", string_arg(args, "roomId")?.to_string()),
                    ("count", count_arg(args, 50)?.to_string()),
                ],
            )?
        }
        "rocketx_read_attachment" => return read_attachment(&config, args),
        _ => return Err(format!("unknown tool: {name}")),
    };
    Ok(json!({
        "content": [{"type": "text", "text": serde_json::to_string(&value).unwrap_or_default()}],
        "structuredContent": value,
        "isError": false
    }))
}

pub(crate) fn response(id: Value, result: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

pub(crate) fn error(id: Value, code: i64, message: impl Into<String>) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message.into()}})
}

fn handle(message: Value) -> Option<Value> {
    let id = message.get("id")?.clone();
    let method = message
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match method {
        "initialize" => Some(response(
            id,
            json!({
                "protocolVersion": MCP_PROTOCOL_VERSION,
                "capabilities": {"tools": {"listChanged": false}},
                "serverInfo": {"name": "rcx-mcp", "title": "RocketX Chat Context", "version": "0.20.1"},
                "instructions": "Read-only access to chat context visible to the configured Rocket.Chat account."
            }),
        )),
        "ping" => Some(response(id, json!({}))),
        "tools/list" => Some(response(id, tools())),
        "tools/call" => {
            let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
            let name = params
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let args = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            Some(match call_tool(name, &args) {
                Ok(result) => response(id, result),
                Err(reason) => response(
                    id,
                    json!({"content": [{"type": "text", "text": reason}], "isError": true}),
                ),
            })
        }
        _ => Some(error(id, -32601, format!("Method not found: {method}"))),
    }
}

pub(crate) fn run_stdio_with_handler(
    mut handler: impl FnMut(Value) -> Option<Value>,
) -> Result<(), String> {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let line = line.map_err(|error| format!("failed to read MCP input: {error}"))?;
        let message: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(_) => {
                writeln!(stdout, "{}", error(Value::Null, -32700, "Parse error"))
                    .map_err(|write_error| write_error.to_string())?;
                stdout.flush().map_err(|error| error.to_string())?;
                continue;
            }
        };
        if let Some(value) = handler(message) {
            writeln!(stdout, "{value}").map_err(|error| error.to_string())?;
            stdout.flush().map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

pub fn run_stdio() -> Result<(), String> {
    run_stdio_with_handler(handle)
}

#[cfg(test)]
mod tests {
    use super::{handle, percent_encode, tools, validate_attachment_path};
    use serde_json::json;

    #[test]
    fn mcp_initialize_and_tools_follow_protocol_contract() {
        let initialized =
            handle(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}})).unwrap();
        assert_eq!(initialized["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(tools()["tools"].as_array().unwrap().len(), 4);
        assert_eq!(initialized["jsonrpc"], "2.0");
    }

    #[test]
    fn mcp_query_values_are_percent_encoded() {
        assert_eq!(percent_encode("a/b c"), "a%2Fb%20c");
    }

    #[test]
    fn attachment_path_accepts_site_relative_file_upload() {
        assert_eq!(
            validate_attachment_path("/file-upload/abc123/photo.png").unwrap(),
            "/file-upload/abc123/photo.png"
        );
        assert!(validate_attachment_path("/file-upload/abc123/photo.png?rc_uid=x").is_ok());
    }

    #[test]
    fn attachment_path_rejects_absolute_urls_and_other_prefixes() {
        for path in [
            "https://chat.example.com/file-upload/abc/photo.png",
            "http://evil.example.com/file-upload/abc/photo.png",
            "//evil.example.com/file-upload/abc/photo.png",
            "/api/v1/channels.history",
            "file-upload/abc/photo.png",
        ] {
            assert!(
                validate_attachment_path(path).is_err(),
                "must reject {path}"
            );
        }
    }

    #[test]
    fn attachment_path_rejects_directory_traversal_variants() {
        for path in [
            "/file-upload/../etc/passwd",
            "/file-upload/..%2fetc/passwd",
            "/file-upload/%2e%2e/etc/passwd",
            "/file-upload/%2E%2E/etc/passwd",
            "/file-upload/..\\windows\\win.ini",
            "/file-upload/abc/p\r\nhot	o.png",
        ] {
            assert!(
                validate_attachment_path(path).is_err(),
                "must reject {path}"
            );
        }
    }

    // Live 端到端（issue #347）：连接 http://127.0.0.1:3300 的真实 Rocket.Chat 8.6
    // （admin/rcxdev123），走真实 handle() → keychain → winauth 下载链路。
    // 默认不跑；运行：cargo test -- --ignored live_reverse_mcp_reads_real_attachment
    // keychain 与测试房间均由 guard 自动备份/恢复、清理；秘密不打印。
    #[test]
    #[ignore = "live：需要 127.0.0.1:3300 的 Rocket.Chat（admin/rcxdev123）"]
    fn live_reverse_mcp_reads_real_attachment() {
        use crate::live_e2e as live;
        use base64::Engine as _;

        if !live::rc_server_reachable() {
            eprintln!("跳过：127.0.0.1:3300 上没有可用的 Rocket.Chat");
            return;
        }
        let session = live::rc_login().expect("REST 登录应成功");
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis();
        let room_id = live::rc_create_channel(&session, &format!("rcx-live-mcp-{unique}"))
            .expect("channels.create 应成功");
        let _room_cleanup = live::RcRoomCleanup::new(&session, &room_id);

        let png = live::sample_png();
        let path = live::rc_upload_png(&session, &room_id, &png).expect("rooms.media 上传应成功");
        assert!(path.starts_with("/file-upload/"));

        let config = json!({
            "serverUrl": live::RC_BASE,
            "userId": session.user_id,
            "authToken": session.auth_token,
        });
        let _keychain =
            live::KeychainGuard::install("com.lusipad.rocketx.mcp", "active", &config.to_string())
                .expect("写入测试 keychain 配置应成功");

        let initialized =
            handle(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}})).unwrap();
        assert_eq!(initialized["result"]["protocolVersion"], "2025-06-18");
        let listed = handle(json!({"jsonrpc":"2.0","id":2,"method":"tools/list"})).unwrap();
        let tools = listed["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 4, "反向 MCP 应暴露 4 个只读工具");
        assert!(tools
            .iter()
            .any(|tool| tool["name"] == "rocketx_read_attachment"));

        let called = handle(json!({
            "jsonrpc":"2.0","id":3,"method":"tools/call",
            "params":{"name":"rocketx_read_attachment","arguments":{"path": path}}
        }))
        .unwrap();
        assert_eq!(
            called["result"]["isError"], false,
            "rocketx_read_attachment 不应报错"
        );
        let content = &called["result"]["content"][0];
        assert_eq!(content["type"], "image");
        assert_eq!(content["mimeType"], "image/png");
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(content["data"].as_str().unwrap())
            .expect("image content 应是合法 base64");
        assert_eq!(decoded, png, "下载字节必须与上传原图一致");

        // 负路径：站外 URL 与目录穿越必须被拒绝（真实 handle 链路）
        for bad in [
            "https://evil.example.com/file-upload/abc/photo.png",
            "/file-upload/../etc/passwd",
        ] {
            let rejected = handle(json!({
                "jsonrpc":"2.0","id":4,"method":"tools/call",
                "params":{"name":"rocketx_read_attachment","arguments":{"path": bad}}
            }))
            .unwrap();
            assert_eq!(
                rejected["result"]["isError"], true,
                "必须拒绝非法路径 {bad}"
            );
        }
        eprintln!(
            "live ok：rocketx_read_attachment 从真实服务器取回 {} 字节 PNG 且字节一致",
            decoded.len()
        );
    }

    // Live stdio 全链路（issue #347）：spawn 真实 rocketx.exe --mcp，
    // 走 stdin/stdout 的 initialize → tools/list → tools/call JSON-RPC。
    // 需要先 cargo build（target/debug/rocketx.exe 必须存在），其余前置同上。
    // 运行：cargo test -- --ignored live_reverse_mcp_stdio_roundtrip
    #[test]
    #[ignore = "live：需要 127.0.0.1:3300 的 Rocket.Chat 且已 cargo build"]
    fn live_reverse_mcp_stdio_roundtrip() {
        use crate::live_e2e as live;
        use base64::Engine as _;
        use std::io::{BufRead, BufReader, Write};
        use std::process::{Command, Stdio};

        let exe = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("debug")
            .join("rocketx.exe");
        if !exe.is_file() {
            eprintln!("跳过：{} 不存在，请先 cargo build", exe.display());
            return;
        }
        if !live::rc_server_reachable() {
            eprintln!("跳过：127.0.0.1:3300 上没有可用的 Rocket.Chat");
            return;
        }
        let session = live::rc_login().expect("REST 登录应成功");
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis();
        let room_id = live::rc_create_channel(&session, &format!("rcx-live-stdio-{unique}"))
            .expect("channels.create 应成功");
        let _room_cleanup = live::RcRoomCleanup::new(&session, &room_id);

        let png = live::sample_png();
        let path = live::rc_upload_png(&session, &room_id, &png).expect("rooms.media 上传应成功");
        let config = json!({
            "serverUrl": live::RC_BASE,
            "userId": session.user_id,
            "authToken": session.auth_token,
        });
        let _keychain =
            live::KeychainGuard::install("com.lusipad.rocketx.mcp", "active", &config.to_string())
                .expect("写入测试 keychain 配置应成功");

        let mut child = Command::new(&exe)
            .arg("--mcp")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("应能启动 rocketx.exe --mcp");
        let mut stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        let requests = [
            json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}),
            json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
            json!({"jsonrpc":"2.0","id":3,"method":"tools/call",
                   "params":{"name":"rocketx_read_attachment","arguments":{"path": path}}}),
        ];
        for request in &requests {
            writeln!(stdin, "{request}").expect("写入 MCP 请求应成功");
        }
        stdin.flush().unwrap();
        drop(stdin); // EOF 让 run_stdio 正常退出

        let mut lines = stdout.lines().map(|line| line.unwrap());
        let initialized: serde_json::Value =
            serde_json::from_str(&lines.next().expect("应有 initialize 响应")).unwrap();
        assert_eq!(initialized["result"]["protocolVersion"], "2025-06-18");
        let listed: serde_json::Value =
            serde_json::from_str(&lines.next().expect("应有 tools/list 响应")).unwrap();
        assert_eq!(
            listed["result"]["tools"].as_array().unwrap().len(),
            4,
            "stdio 链路应列出 4 个工具"
        );
        let called: serde_json::Value =
            serde_json::from_str(&lines.next().expect("应有 tools/call 响应")).unwrap();
        assert_eq!(called["result"]["isError"], false);
        let content = &called["result"]["content"][0];
        assert_eq!(content["type"], "image");
        assert_eq!(content["mimeType"], "image/png");
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(content["data"].as_str().unwrap())
            .unwrap();
        assert_eq!(decoded, png, "stdio 链路下载字节必须与上传原图一致");
        let status = child.wait().expect("应能等待 MCP 子进程退出");
        assert!(status.success(), "rocketx.exe --mcp 应正常退出：{status}");
        eprintln!(
            "live ok：exe --mcp stdio 全链路取回 {} 字节 PNG 且字节一致",
            decoded.len()
        );
    }
}
