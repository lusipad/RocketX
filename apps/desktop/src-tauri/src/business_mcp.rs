use std::sync::Mutex;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{mcp, proc, winauth};

const ROCKET_CHAT_KEYCHAIN_SERVICE: &str = "com.lusipad.rocketx.business-mcp.rocket-chat";
const AZURE_DEVOPS_KEYCHAIN_SERVICE: &str = "com.lusipad.rocketx.business-mcp.azure-devops";
const KEYCHAIN_ACCOUNT: &str = "active";
const MAX_SEARCH_ROOMS: usize = 10;

pub struct BusinessMcpConfigLock(pub Mutex<()>);

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RocketChatConfig {
    server_url: String,
    user_id: String,
    auth_token: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AzureDevOpsConfig {
    collection_url: String,
    auth_mode: String,
    #[serde(default)]
    allow_insecure_ado_http: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pat: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BusinessMcpLaunchConfig {
    command: String,
    args: Vec<String>,
}

fn keychain_entry(service: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(service, KEYCHAIN_ACCOUNT)
        .map_err(|error| format!("业务 MCP 系统凭据库不可用：{error}"))
}

fn load_keychain<T: DeserializeOwned>(service: &str) -> Result<Option<T>, String> {
    match keychain_entry(service)?.get_password() {
        Ok(value) => serde_json::from_str(&value)
            .map(Some)
            .map_err(|_| "业务 MCP 配置已损坏".to_string()),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("无法读取业务 MCP 配置：{error}")),
    }
}

fn save_keychain<T: Serialize>(service: &str, value: &T) -> Result<(), String> {
    let encoded =
        serde_json::to_string(value).map_err(|error| format!("无法编码业务 MCP 配置：{error}"))?;
    keychain_entry(service)?
        .set_password(&encoded)
        .map_err(|error| format!("无法保存业务 MCP 配置：{error}"))
}

fn delete_keychain(service: &str) -> Result<(), String> {
    match keychain_entry(service)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("无法删除业务 MCP 配置：{error}")),
    }
}

fn normalize_collection_url(value: &str) -> Result<String, String> {
    let value = value.trim().trim_end_matches('/');
    if value.is_empty() || value.len() > 2048 || value.chars().any(char::is_control) {
        return Err("Azure DevOps collection URL 无效".to_string());
    }
    let parsed =
        tauri::Url::parse(value).map_err(|_| "Azure DevOps collection URL 无效".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err("Azure DevOps collection URL 无效".to_string());
    }
    Ok(value.to_string())
}

fn normalize_azure_auth(
    auth_mode: Option<&str>,
    pat: Option<&str>,
) -> Result<(String, Option<String>), String> {
    let pat = pat
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    if pat
        .as_deref()
        .is_some_and(|value| value.len() > 512 || value.chars().any(char::is_control))
    {
        return Err("Azure DevOps PAT 无效".to_string());
    }
    let requested = auth_mode
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(if pat.is_some() {
            "pat"
        } else {
            "default-credentials"
        });
    match requested {
        "ntlm" | "default-credentials" => Ok(("default-credentials".to_string(), None)),
        "pat" => pat
            .map(|value| ("pat".to_string(), Some(value)))
            .ok_or_else(|| "Azure DevOps PAT 模式缺少 PAT".to_string()),
        _ => Err("业务 MCP 当前只支持 Windows 默认凭据或 PAT".to_string()),
    }
}

fn validate_azure_http_consent(
    collection_url: &str,
    auth_mode: &str,
    allow_insecure_ado_http: bool,
) -> Result<(), String> {
    let parsed = tauri::Url::parse(collection_url)
        .map_err(|_| "Azure DevOps collection URL 无效".to_string())?;
    let is_loopback = parsed
        .host_str()
        .map(|host| {
            let host = host.trim_matches(['[', ']']);
            host.eq_ignore_ascii_case("localhost")
                || host
                    .parse::<std::net::IpAddr>()
                    .map(|address| address.is_loopback())
                    .unwrap_or(false)
        })
        .unwrap_or(false);
    if parsed.scheme() == "http"
        && !is_loopback
        && matches!(auth_mode, "default-credentials" | "pat")
        && !allow_insecure_ado_http
    {
        return Err(
            "HTTP 无法保护 Azure DevOps 凭据；请在设置中明确允许受信任内网 HTTP 认证".to_string(),
        );
    }
    Ok(())
}

#[tauri::command]
pub fn business_mcp_launch_config() -> Result<BusinessMcpLaunchConfig, String> {
    let command = std::env::current_exe()
        .map_err(|error| format!("无法定位 RocketX 可执行文件：{error}"))?
        .to_string_lossy()
        .into_owned();
    Ok(BusinessMcpLaunchConfig {
        command,
        args: vec!["--business-mcp".to_string()],
    })
}

#[tauri::command]
pub fn business_mcp_sync_rocket_chat(
    lock: tauri::State<'_, BusinessMcpConfigLock>,
    server_url: String,
    user_id: String,
    auth_token: String,
) -> Result<(), String> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "业务 MCP 凭据锁不可用".to_string())?;
    delete_keychain(ROCKET_CHAT_KEYCHAIN_SERVICE)?;
    let config = RocketChatConfig {
        server_url: mcp::normalize_server_url(&server_url)?,
        user_id,
        auth_token,
    };
    mcp::validate_credentials(&config.user_id, &config.auth_token)?;
    save_keychain(ROCKET_CHAT_KEYCHAIN_SERVICE, &config)
}

#[tauri::command]
pub fn business_mcp_clear_rocket_chat(
    lock: tauri::State<'_, BusinessMcpConfigLock>,
) -> Result<(), String> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "业务 MCP 凭据锁不可用".to_string())?;
    delete_keychain(ROCKET_CHAT_KEYCHAIN_SERVICE)
}

#[tauri::command]
pub fn business_mcp_sync_azure_devops(
    lock: tauri::State<'_, BusinessMcpConfigLock>,
    collection_url: String,
    auth_mode: Option<String>,
    pat: Option<String>,
    allow_insecure_ado_http: Option<bool>,
) -> Result<(), String> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "业务 MCP 凭据锁不可用".to_string())?;
    delete_keychain(AZURE_DEVOPS_KEYCHAIN_SERVICE)?;
    let collection_url = normalize_collection_url(&collection_url)?;
    let (auth_mode, pat) = normalize_azure_auth(auth_mode.as_deref(), pat.as_deref())?;
    let allow_insecure_ado_http = allow_insecure_ado_http.unwrap_or(false);
    validate_azure_http_consent(&collection_url, &auth_mode, allow_insecure_ado_http)?;
    save_keychain(
        AZURE_DEVOPS_KEYCHAIN_SERVICE,
        &AzureDevOpsConfig {
            collection_url,
            auth_mode,
            allow_insecure_ado_http,
            pat,
        },
    )
}

#[tauri::command]
pub fn business_mcp_clear_azure_devops(
    lock: tauri::State<'_, BusinessMcpConfigLock>,
) -> Result<(), String> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "业务 MCP 凭据锁不可用".to_string())?;
    delete_keychain(AZURE_DEVOPS_KEYCHAIN_SERVICE)
}

#[derive(Debug)]
struct ToolFailure {
    reason: &'static str,
    retryable: bool,
    message: String,
}

impl ToolFailure {
    fn new(reason: &'static str, retryable: bool, message: impl Into<String>) -> Self {
        Self {
            reason,
            retryable,
            message: message.into(),
        }
    }

    fn invalid(message: impl Into<String>) -> Self {
        Self::new("invalid_argument", false, message)
    }

    fn not_configured(capability: &str) -> Self {
        Self::new(
            "not_configured",
            false,
            format!("{capability} 尚未在 RocketX 中配置"),
        )
    }

    fn network(message: String) -> Self {
        let lower = message.to_ascii_lowercase();
        if lower.contains("timeout") || message.contains("超时") {
            Self::new("timeout", true, message)
        } else {
            Self::new("offline", true, message)
        }
    }

    fn azure_devops(message: String) -> Self {
        let lower = message.to_ascii_lowercase();
        if lower.contains("authorizationmanager check failed")
            || lower.contains("running scripts is disabled")
        {
            return Self::new("local_policy", false, message);
        }
        if lower.contains("timeout") || message.contains("超时") {
            return Self::new("timeout", true, message);
        }
        if lower.contains("401") || message.contains("认证失败") {
            return Self::new("auth_failed", false, message);
        }
        if lower.contains("403")
            || message.contains("无权")
            || message.contains("权限")
            || message.contains("拒绝访问")
        {
            return Self::new("forbidden", false, message);
        }
        if lower.contains("404") || message.contains("不存在") {
            return Self::new("not_found", false, message);
        }
        if message.contains("无效")
            || message.contains("不受支持")
            || message.contains("只允许")
            || message.contains("必须")
            || message.contains("不接受")
            || message.contains("参数过多")
            || message.contains("过大")
            || message.contains("相对资源路径")
        {
            return Self::invalid(message);
        }
        if message.contains("无法启动")
            || message.contains("无法连接")
            || message.contains("名称解析")
        {
            return Self::new("offline", true, message);
        }
        Self::new("remote_error", true, message)
    }

    fn result(self) -> Value {
        let structured = json!({
            "status": if self.reason == "invalid_argument" { "error" } else { "unavailable" },
            "reason": self.reason,
            "retryable": self.retryable,
            "message": self.message,
        });
        json!({
            "content": [{"type": "text", "text": structured.to_string()}],
            "structuredContent": structured,
            "isError": true
        })
    }
}

fn rocket_chat_config() -> Result<RocketChatConfig, ToolFailure> {
    load_keychain(ROCKET_CHAT_KEYCHAIN_SERVICE)
        .map_err(|message| ToolFailure::new("credential_store", true, message))?
        .ok_or_else(|| ToolFailure::not_configured("Rocket.Chat"))
}

fn azure_devops_config() -> Result<AzureDevOpsConfig, ToolFailure> {
    let config: AzureDevOpsConfig = load_keychain(AZURE_DEVOPS_KEYCHAIN_SERVICE)
        .map_err(|message| ToolFailure::new("credential_store", true, message))?
        .ok_or_else(|| ToolFailure::not_configured("Azure DevOps Server"))?;
    validate_azure_http_consent(
        &config.collection_url,
        &config.auth_mode,
        config.allow_insecure_ado_http,
    )
    .map_err(ToolFailure::invalid)?;
    Ok(config)
}

fn get_json(
    config: &RocketChatConfig,
    endpoint: &str,
    query: &[(&str, String)],
) -> Result<Value, ToolFailure> {
    let query = query
        .iter()
        .map(|(key, value)| {
            format!(
                "{}={}",
                mcp::percent_encode(key),
                mcp::percent_encode(value)
            )
        })
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
        winauth::blocking_token_request(&url, "GET", &config.user_id, &config.auth_token, None)
            .map_err(ToolFailure::network)?;
    match response.status {
        203 | 401 => Err(ToolFailure::new(
            "auth_failed",
            false,
            "Rocket.Chat 登录已失效，请重新登录 RocketX",
        )),
        200..=299 => serde_json::from_str(&response.body).map_err(|error| {
            ToolFailure::new(
                "invalid_response",
                true,
                format!("Rocket.Chat 返回了无效 JSON：{error}"),
            )
        }),
        403 => Err(ToolFailure::new(
            "forbidden",
            false,
            "当前 Rocket.Chat 账号无权读取该内容",
        )),
        status => Err(ToolFailure::new(
            "remote_error",
            true,
            format!("Rocket.Chat 返回 HTTP {status}"),
        )),
    }
}

fn tools() -> Value {
    let annotations =
        json!({"readOnlyHint": true, "destructiveHint": false, "openWorldHint": false});
    json!({"tools": [
        {
            "name": "rocketx_list_conversations",
            "title": "列出 Rocket.Chat 会话",
            "description": "列出当前 RocketX 登录账号可访问的频道、私有组和私聊。用于先解析房间 ID。",
            "inputSchema": {"type": "object", "properties": {}, "additionalProperties": false},
            "annotations": annotations
        },
        {
            "name": "rocketx_get_thread_context",
            "title": "读取 Rocket.Chat 线程",
            "description": "按根消息 ID 读取一个 Rocket.Chat 讨论线程。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tmid": {"type": "string"},
                    "count": {"type": "integer", "minimum": 1, "maximum": 200, "default": 100}
                },
                "required": ["tmid"],
                "additionalProperties": false
            },
            "annotations": annotations
        },
        {
            "name": "rocketx_get_room_history",
            "title": "读取 Rocket.Chat 房间历史",
            "description": "按房间 ID 读取频道、私有组或私聊历史；latest 可用于继续向前分页。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "roomId": {"type": "string"},
                    "roomType": {"type": "string", "enum": ["c", "p", "d"]},
                    "count": {"type": "integer", "minimum": 1, "maximum": 200, "default": 50},
                    "latest": {"type": "string", "description": "可选 ISO 时间分页游标"}
                },
                "required": ["roomId", "roomType"],
                "additionalProperties": false
            },
            "annotations": annotations
        },
        {
            "name": "rocketx_search_messages",
            "title": "搜索 Rocket.Chat 消息",
            "description": "在最多 10 个已知房间 ID 中搜索消息。先调用 rocketx_list_conversations 解析房间。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "roomIds": {
                        "type": "array",
                        "items": {"type": "string"},
                        "minItems": 1,
                        "maxItems": 10
                    },
                    "query": {"type": "string"},
                    "count": {"type": "integer", "minimum": 1, "maximum": 20, "default": 20},
                    "offset": {"type": "integer", "minimum": 0, "maximum": 10000, "default": 0}
                },
                "required": ["roomIds", "query"],
                "additionalProperties": false
            },
            "annotations": annotations
        },
        {
            "name": "rocketx_search_people_rooms",
            "title": "搜索 Rocket.Chat 人员和房间",
            "description": "按关键词搜索当前账号可见的人员与房间。",
            "inputSchema": {
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "required": ["query"],
                "additionalProperties": false
            },
            "annotations": annotations
        },
        {
            "name": "rocketx_azure_devops_server_read",
            "title": "读取 Azure DevOps Server",
            "description": "使用 RocketX Workbench 中的连接和认证执行受控只读查询，支持 GET 与 azure-devops-server Skill 白名单内的只读 POST。连接地址和凭据不由模型提供。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "method": {"type": "string", "enum": ["GET", "POST"], "default": "GET"},
                    "area": {
                        "type": "string",
                        "enum": ["build", "git", "release", "search", "test", "testplan", "testresults", "wiki", "wit", "work"]
                    },
                    "resource": {"type": "string"},
                    "project": {"type": "string"},
                    "team": {"type": "string"},
                    "query": {"type": "object"},
                    "body": {"type": "object"},
                    "apiVersion": {"type": "string"},
                    "serverVersionHint": {
                        "type": "string",
                        "enum": ["current", "20.0", "2022.1", "2022", "2020", "2019", "2018", "2017", "2015", "legacy"]
                    },
                    "allowConditionalArea": {"type": "boolean", "default": false}
                },
                "required": ["resource"],
                "additionalProperties": false
            },
            "annotations": annotations
        }
    ]})
}

fn string_arg(args: &Value, key: &str, max_len: usize) -> Result<String, ToolFailure> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| {
            !value.is_empty() && value.len() <= max_len && !value.chars().any(char::is_control)
        })
        .map(str::to_string)
        .ok_or_else(|| ToolFailure::invalid(format!("{key} 无效")))
}

fn optional_string_arg(
    args: &Value,
    key: &str,
    max_len: usize,
) -> Result<Option<String>, ToolFailure> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(_) => string_arg(args, key, max_len).map(Some),
    }
}

fn integer_arg(
    args: &Value,
    key: &str,
    default: u64,
    min: u64,
    max: u64,
) -> Result<u64, ToolFailure> {
    let value = args.get(key).and_then(Value::as_u64).unwrap_or(default);
    if (min..=max).contains(&value) {
        Ok(value)
    } else {
        Err(ToolFailure::invalid(format!("{key} 超出允许范围")))
    }
}

fn bool_arg(args: &Value, key: &str) -> Result<bool, ToolFailure> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(false),
        Some(value) => value
            .as_bool()
            .ok_or_else(|| ToolFailure::invalid(format!("{key} 必须是布尔值"))),
    }
}

fn room_ids_arg(args: &Value) -> Result<Vec<String>, ToolFailure> {
    let values = args
        .get("roomIds")
        .and_then(Value::as_array)
        .ok_or_else(|| ToolFailure::invalid("roomIds 必须是数组"))?;
    if values.is_empty() || values.len() > MAX_SEARCH_ROOMS {
        return Err(ToolFailure::invalid(format!(
            "roomIds 必须包含 1-{MAX_SEARCH_ROOMS} 个房间"
        )));
    }
    values
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::trim)
                .filter(|value| {
                    !value.is_empty() && value.len() <= 512 && !value.chars().any(char::is_control)
                })
                .map(str::to_string)
                .ok_or_else(|| ToolFailure::invalid("roomIds 包含无效房间 ID"))
        })
        .collect()
}

fn wrap_cjk_as_regex(value: &str) -> String {
    let value = value.trim();
    if value.len() >= 2 && value.starts_with('/') && value.ends_with('/') {
        return value.to_string();
    }
    let has_cjk = value.chars().any(|character| {
        matches!(
            character,
            '\u{4e00}'..='\u{9fff}' | '\u{3040}'..='\u{30ff}' | '\u{ac00}'..='\u{d7af}'
        )
    });
    if !has_cjk {
        return value.to_string();
    }
    let mut escaped = String::with_capacity(value.len() + 2);
    escaped.push('/');
    for character in value.chars() {
        if matches!(
            character,
            '.' | '*' | '+' | '?' | '^' | '$' | '{' | '}' | '(' | ')' | '|' | '[' | ']' | '\\'
        ) {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    escaped.push('/');
    escaped
}

fn with_coverage(mut value: Value, limit: u64) -> Result<Value, ToolFailure> {
    let object = value.as_object_mut().ok_or_else(|| {
        ToolFailure::new(
            "invalid_response",
            true,
            "Rocket.Chat 返回的历史记录不是对象",
        )
    })?;
    let returned = object
        .get("messages")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    object.insert(
        "coverage".to_string(),
        json!({
            "complete": returned < limit as usize,
            "truncated": returned >= limit as usize,
            "returned": returned,
            "limit": limit
        }),
    );
    Ok(value)
}

fn call_tool(name: &str, args: &Value) -> Result<Value, ToolFailure> {
    match name {
        "rocketx_list_conversations" => {
            let config = rocket_chat_config()?;
            get_json(&config, "subscriptions.get", &[])
        }
        "rocketx_get_thread_context" => {
            let config = rocket_chat_config()?;
            let count = integer_arg(args, "count", 100, 1, 200)?;
            get_json(
                &config,
                "chat.getThreadMessages",
                &[
                    ("tmid", string_arg(args, "tmid", 512)?),
                    ("count", count.to_string()),
                ],
            )
            .and_then(|value| with_coverage(value, count))
        }
        "rocketx_get_room_history" => {
            let config = rocket_chat_config()?;
            let endpoint = match string_arg(args, "roomType", 1)?.as_str() {
                "c" => "channels.history",
                "p" => "groups.history",
                "d" => "im.history",
                _ => return Err(ToolFailure::invalid("roomType 必须是 c、p 或 d")),
            };
            let count = integer_arg(args, "count", 50, 1, 200)?;
            let mut query = vec![
                ("roomId", string_arg(args, "roomId", 512)?),
                ("count", count.to_string()),
            ];
            if let Some(latest) = optional_string_arg(args, "latest", 128)? {
                query.push(("latest", latest));
            }
            get_json(&config, endpoint, &query).and_then(|value| with_coverage(value, count))
        }
        "rocketx_search_messages" => {
            let config = rocket_chat_config()?;
            let room_ids = room_ids_arg(args)?;
            let query = wrap_cjk_as_regex(&string_arg(args, "query", 512)?);
            let count = integer_arg(args, "count", 20, 1, 20)?;
            let offset = integer_arg(args, "offset", 0, 0, 10_000)?;
            let mut items = Vec::new();
            let mut warnings = Vec::new();
            let mut succeeded = 0usize;
            let mut truncated = false;
            let mut first_failure = None;
            for room_id in &room_ids {
                match get_json(
                    &config,
                    "chat.search",
                    &[
                        ("roomId", room_id.clone()),
                        ("searchText", query.clone()),
                        ("count", count.to_string()),
                        ("offset", offset.to_string()),
                    ],
                ) {
                    Ok(value) => {
                        succeeded += 1;
                        if let Some(messages) = value.get("messages").and_then(Value::as_array) {
                            truncated |= messages.len() >= count as usize;
                            items.extend(messages.iter().cloned());
                        }
                    }
                    Err(failure) => {
                        let stop = matches!(
                            failure.reason,
                            "timeout"
                                | "offline"
                                | "auth_failed"
                                | "credential_store"
                                | "not_configured"
                        );
                        warnings.push(format!("房间 {room_id} 搜索失败：{}", failure.message));
                        if first_failure.is_none() {
                            first_failure = Some(failure);
                        }
                        if stop {
                            break;
                        }
                    }
                }
            }
            if succeeded == 0 {
                return Err(first_failure.unwrap_or_else(|| {
                    ToolFailure::new("remote_error", true, "所有房间搜索均失败")
                }));
            }
            Ok(json!({
                "items": items,
                "coverage": {
                    "complete": warnings.is_empty() && !truncated,
                    "truncated": truncated,
                    "roomsRequested": room_ids.len(),
                    "roomsSearched": succeeded,
                    "returned": items.len()
                },
                "warnings": warnings
            }))
        }
        "rocketx_search_people_rooms" => {
            let config = rocket_chat_config()?;
            get_json(
                &config,
                "spotlight",
                &[("query", string_arg(args, "query", 512)?)],
            )
        }
        "rocketx_azure_devops_server_read" => {
            let config = azure_devops_config()?;
            let query = match args.get("query") {
                None | Some(Value::Null) => None,
                Some(Value::Object(query)) => Some(query.clone()),
                Some(_) => return Err(ToolFailure::invalid("query 必须是对象")),
            };
            let body = match args.get("body") {
                None | Some(Value::Null) => None,
                Some(Value::Object(body)) => Some(body.clone()),
                Some(_) => return Err(ToolFailure::invalid("body 必须是对象")),
            };
            let result =
                proc::business_azure_devops_server_read(proc::ButlerAzureDevOpsServerReadRequest {
                    method: optional_string_arg(args, "method", 8)?
                        .or_else(|| Some("GET".to_string())),
                    collection_url: config.collection_url,
                    auth_mode: Some(config.auth_mode),
                    pat: config.pat,
                    area: optional_string_arg(args, "area", 32)?,
                    resource: string_arg(args, "resource", 512)?,
                    project: optional_string_arg(args, "project", 256)?,
                    team: optional_string_arg(args, "team", 256)?,
                    query,
                    body,
                    api_version: optional_string_arg(args, "apiVersion", 64)?,
                    server_version_hint: optional_string_arg(args, "serverVersionHint", 16)?,
                    allow_conditional_area: bool_arg(args, "allowConditionalArea")?,
                })
                .map_err(ToolFailure::azure_devops)?;
            Ok(result)
        }
        _ => Err(ToolFailure::invalid(format!("未知工具：{name}"))),
    }
}

fn success(value: Value) -> Value {
    json!({
        "content": [{"type": "text", "text": value.to_string()}],
        "structuredContent": value,
        "isError": false
    })
}

fn handle(message: Value) -> Option<Value> {
    let id = message.get("id")?.clone();
    let method = message
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match method {
        "initialize" => Some(mcp::response(
            id,
            json!({
                "protocolVersion": mcp::MCP_PROTOCOL_VERSION,
                "capabilities": {"tools": {"listChanged": false}},
                "serverInfo": {
                    "name": "rocketx-business",
                    "title": "RocketX Business Tools",
                    "version": env!("CARGO_PKG_VERSION")
                },
                "instructions": "Read-only Rocket.Chat and Azure DevOps Server tools for RocketX Butler."
            }),
        )),
        "ping" => Some(mcp::response(id, json!({}))),
        "tools/list" => Some(mcp::response(id, tools())),
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
            Some(mcp::response(
                id,
                match call_tool(name, &args) {
                    Ok(value) => success(value),
                    Err(failure) => failure.result(),
                },
            ))
        }
        _ => Some(mcp::error(
            id,
            -32601,
            format!("Method not found: {method}"),
        )),
    }
}

pub fn run_stdio() -> Result<(), String> {
    mcp::run_stdio_with_handler(handle)
}

#[cfg(test)]
mod tests {
    use super::{
        handle, normalize_azure_auth, tools, validate_azure_http_consent, wrap_cjk_as_regex,
        ToolFailure,
    };
    use serde_json::json;

    #[test]
    fn business_mcp_lists_only_read_only_tools_without_loading_credentials() {
        let initialized =
            handle(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}})).unwrap();
        assert_eq!(initialized["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(
            initialized["result"]["serverInfo"]["name"],
            "rocketx-business"
        );
        let listed = tools();
        let tools = listed["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 6);
        assert!(tools.iter().all(|tool| {
            tool["annotations"]["readOnlyHint"] == true
                && tool["annotations"]["destructiveHint"] == false
        }));
        let azure = tools
            .iter()
            .find(|tool| tool["name"] == "rocketx_azure_devops_server_read")
            .unwrap();
        assert_eq!(
            azure["inputSchema"]["properties"]["method"]["enum"],
            json!(["GET", "POST"])
        );
        assert_eq!(azure["inputSchema"]["properties"]["body"]["type"], "object");
    }

    #[test]
    fn unknown_tool_returns_structured_non_retryable_error_without_credentials() {
        let response = handle(json!({
            "jsonrpc":"2.0",
            "id":2,
            "method":"tools/call",
            "params":{"name":"missing","arguments":{}}
        }))
        .unwrap();
        assert_eq!(response["result"]["isError"], true);
        assert_eq!(
            response["result"]["structuredContent"]["reason"],
            "invalid_argument"
        );
        assert_eq!(response["result"]["structuredContent"]["retryable"], false);
    }

    #[test]
    fn azure_auth_defaults_to_windows_credentials_and_keeps_pat_only_in_pat_mode() {
        assert_eq!(
            normalize_azure_auth(Some("ntlm"), Some("ignored")).unwrap(),
            ("default-credentials".to_string(), None)
        );
        assert_eq!(
            normalize_azure_auth(Some("pat"), Some("secret")).unwrap(),
            ("pat".to_string(), Some("secret".to_string()))
        );
        assert!(normalize_azure_auth(Some("pat"), None).is_err());
        assert!(normalize_azure_auth(Some("bearer"), Some("secret")).is_err());
        assert!(normalize_azure_auth(Some("none"), None).is_err());
    }

    #[test]
    fn http_ado_credentials_require_explicit_intranet_consent() {
        for loopback in [
            "http://localhost:8081/DefaultCollection",
            "http://127.0.0.1:8081/DefaultCollection",
            "http://[::1]:8081/DefaultCollection",
        ] {
            assert!(
                validate_azure_http_consent(loopback, "default-credentials", false).is_ok(),
                "本机回环地址不应要求内网 HTTP 授权：{loopback}",
            );
        }
        assert!(validate_azure_http_consent(
            "http://ado.local/DefaultCollection",
            "default-credentials",
            false,
        )
        .is_err());
        assert!(
            validate_azure_http_consent("http://ado.local/DefaultCollection", "pat", false,)
                .is_err()
        );
        assert!(validate_azure_http_consent(
            "http://ado.local/DefaultCollection",
            "default-credentials",
            true,
        )
        .is_ok());
        assert!(validate_azure_http_consent(
            "https://ado.example.test/DefaultCollection",
            "default-credentials",
            false,
        )
        .is_ok());
    }

    #[test]
    fn chinese_message_search_uses_escaped_substring_regex() {
        assert_eq!(wrap_cjk_as_regex("工作项[42]"), r"/工作项\[42\]/");
        assert_eq!(wrap_cjk_as_regex("release"), "release");
        assert_eq!(wrap_cjk_as_regex("/已有/"), "/已有/");
    }

    #[test]
    fn azure_devops_failures_distinguish_invalid_input_from_offline_and_auth() {
        assert_eq!(
            ToolFailure::azure_devops("Azure DevOps area 不受支持".to_string()).reason,
            "invalid_argument"
        );
        assert_eq!(
            ToolFailure::azure_devops("Azure DevOps Server 读取超时（15 秒）".to_string()).reason,
            "timeout"
        );
        assert_eq!(
            ToolFailure::azure_devops("服务器返回 401".to_string()).reason,
            "auth_failed"
        );
        assert_eq!(
            ToolFailure::azure_devops("无法启动 PowerShell runner".to_string()).reason,
            "offline"
        );
        assert_eq!(
            ToolFailure::azure_devops(
                "SecurityError: AuthorizationManager check failed.".to_string()
            )
            .reason,
            "local_policy"
        );
    }

    // Live 端到端（issue #309 业务 MCP）：真实连接 http://127.0.0.1:3300 的
    // Rocket.Chat 与一台 Azure DevOps Server。默认不跑；
    // 运行：cargo test -- --ignored live_business_mcp
    // 环境变量（均可选）：
    //   ADO_LIVE_URL          collection URL，默认 http://localhost:8081/DefaultCollection
    //                         （本机 on-prem，NTLM；注意 /tfs 只是虚拟目录，集合在根下）
    //   ADO_LIVE_AUTH         "ntlm"（默认；写库时映射为 default-credentials，走 WinHTTP
    //                         Windows 集成认证）或 "pat"（需同时设置 ADO_PAT，绝不打印）
    //   ADO_LIVE_API_VERSION  可选；显式指定 ADO REST api-version。不指定时改传
    //                         serverVersionHint "2015"，走 hint→api-version 的真实
    //                         映射链路（psm1 应解析为 1.0；本机 TFS 2015 只认 1.0）
    //   ADO_PROJECT           可选；若存在于该 collection 则用它做 WIQL，否则用项目列表第一项
    // keychain 两个条目都由 guard 备份/恢复。
    #[test]
    #[ignore = "live：需要 RC 127.0.0.1:3300 与可用的 Azure DevOps Server"]
    fn live_business_mcp_reads_azure_devops_and_rocket_chat() {
        use crate::live_e2e as live;

        if !live::rc_server_reachable() {
            eprintln!("跳过：127.0.0.1:3300 上没有可用的 Rocket.Chat");
            return;
        }
        let auth = std::env::var("ADO_LIVE_AUTH").unwrap_or_else(|_| "ntlm".to_string());
        let base_url = std::env::var("ADO_LIVE_URL")
            .unwrap_or_else(|_| "http://localhost:8081/DefaultCollection".to_string());
        // 显式 apiVersion 优先；不指定时用 serverVersionHint "2015"，验证 hint 映射链路。
        let version_args = match std::env::var("ADO_LIVE_API_VERSION") {
            Ok(value) => json!({"apiVersion": value}),
            Err(_) => json!({"serverVersionHint": "2015"}),
        };
        // 注意：keychain 里只能存 default-credentials/pat；"ntlm" 是设置层的写法，
        // 入库时被 normalize_azure_auth 映射为 default-credentials。
        let ado_config = match auth.as_str() {
            "ntlm" | "default-credentials" => json!({
                "collectionUrl": base_url,
                "authMode": "default-credentials",
                "allowInsecureAdoHttp": false,
            }),
            "pat" => {
                let pat =
                    std::env::var("ADO_PAT").expect("ADO_LIVE_AUTH=pat 时需要 ADO_PAT 环境变量");
                json!({
                    "collectionUrl": base_url,
                    "authMode": "pat",
                    "allowInsecureAdoHttp": false,
                    "pat": pat,
                })
            }
            other => panic!("ADO_LIVE_AUTH 只支持 ntlm/pat，收到 {other}"),
        };

        let session = live::rc_login().expect("REST 登录应成功");
        let rc_config = json!({
            "serverUrl": live::RC_BASE,
            "userId": session.user_id,
            "authToken": session.auth_token,
        });
        let _rc_guard = live::KeychainGuard::install(
            super::ROCKET_CHAT_KEYCHAIN_SERVICE,
            "active",
            &rc_config.to_string(),
        )
        .expect("写入 Rocket.Chat 测试配置应成功");
        let _ado_guard = live::KeychainGuard::install(
            super::AZURE_DEVOPS_KEYCHAIN_SERVICE,
            "active",
            &ado_config.to_string(),
        )
        .expect("写入 Azure DevOps 测试配置应成功");

        let listed = handle(json!({"jsonrpc":"2.0","id":1,"method":"tools/list"})).unwrap();
        assert_eq!(listed["result"]["tools"].as_array().unwrap().len(), 6);

        // Rocket.Chat 工具真实连通：列出会话
        let conversations = handle(json!({
            "jsonrpc":"2.0","id":2,"method":"tools/call",
            "params":{"name":"rocketx_list_conversations","arguments":{}}
        }))
        .unwrap();
        assert_eq!(
            conversations["result"]["isError"], false,
            "rocketx_list_conversations 不应报错"
        );
        assert!(
            conversations["result"]["structuredContent"]["update"].is_array(),
            "subscriptions.get 应返回 update 数组"
        );

        // Azure DevOps 工具真实连通：先列项目（集合级 GET，NTLM 走 winauth/WinHTTP）
        let mut projects_args = json!({"method":"GET","resource":"projects"});
        projects_args
            .as_object_mut()
            .unwrap()
            .extend(version_args.as_object().unwrap().clone());
        let projects = handle(json!({
            "jsonrpc":"2.0","id":3,"method":"tools/call",
            "params":{"name":"rocketx_azure_devops_server_read","arguments":projects_args}
        }))
        .unwrap();
        assert_eq!(
            projects["result"]["isError"],
            false,
            "ADO 项目列表不应报错：{}",
            projects["result"]["structuredContent"]["message"]
                .as_str()
                .unwrap_or("（无 message）")
        );
        let project_values = projects["result"]["structuredContent"]["value"]
            .as_array()
            .expect("projects 响应应包含 value 数组");
        assert!(
            !project_values.is_empty(),
            "ADO collection 应至少有一个项目"
        );
        let names: Vec<&str> = project_values
            .iter()
            .filter_map(|project| project["name"].as_str())
            .collect();
        assert_eq!(names.len(), project_values.len(), "每个项目都应有名称");

        // 选项目：优先 ADO_PROJECT（若存在），否则取列表第一项
        let wanted = std::env::var("ADO_PROJECT").unwrap_or_default();
        let project = if !wanted.is_empty() && names.contains(&wanted.as_str()) {
            wanted
        } else {
            names[0].to_string()
        };

        // WIQL 只读查询工作项（POST wit/wiql 在 adapter 白名单内）
        let wiql =
            format!("SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '{project}'");
        let mut wiql_args = json!({
            "method":"POST",
            "area":"wit",
            "resource":"wiql",
            "project": project,
            "body":{"query": wiql}
        });
        wiql_args
            .as_object_mut()
            .unwrap()
            .extend(version_args.as_object().unwrap().clone());
        let response = handle(json!({
            "jsonrpc":"2.0","id":4,"method":"tools/call",
            "params":{"name":"rocketx_azure_devops_server_read","arguments":wiql_args}
        }))
        .unwrap();
        assert_eq!(
            response["result"]["isError"],
            false,
            "ADO WIQL 查询不应报错：{}",
            response["result"]["structuredContent"]["message"]
                .as_str()
                .unwrap_or("（无 message）")
        );
        let structured = &response["result"]["structuredContent"];
        assert!(
            structured.get("workItems").is_some() || structured.get("queryType").is_some(),
            "WIQL 响应应包含 workItems/queryType"
        );
        let count = structured["workItems"]
            .as_array()
            .map(Vec::len)
            .unwrap_or(usize::from(structured.get("workItems").is_some()));
        eprintln!(
            "live ok：business MCP 列出 6 个工具，RC 会话可读；ADO（{auth} 模式）{base_url} \
             返回 {} 个项目，对 '{project}' 的 WIQL 返回 {count} 个工作项",
            names.len()
        );
    }
}
