use std::io::{BufRead, Write};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::winauth;

const MCP_KEYCHAIN_SERVICE: &str = "com.lusipad.rocketx.mcp";
const MCP_KEYCHAIN_ACCOUNT: &str = "active";
const MCP_PROTOCOL_VERSION: &str = "2025-06-18";

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

fn normalize_server_url(value: &str) -> Result<String, String> {
    let value = value.trim().trim_end_matches('/');
    if value.len() > 2048
        || value.chars().any(char::is_control)
        || !(value.starts_with("http://") || value.starts_with("https://"))
    {
        return Err("invalid Rocket.Chat server URL".to_string());
    }
    Ok(value.to_string())
}

fn validate_credentials(user_id: &str, auth_token: &str) -> Result<(), String> {
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

fn percent_encode(value: &str) -> String {
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
        _ => return Err(format!("unknown tool: {name}")),
    };
    Ok(json!({
        "content": [{"type": "text", "text": serde_json::to_string(&value).unwrap_or_default()}],
        "structuredContent": value,
        "isError": false
    }))
}

fn response(id: Value, result: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

fn error(id: Value, code: i64, message: impl Into<String>) -> Value {
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
                "serverInfo": {"name": "rcx-mcp", "title": "RocketX Chat Context", "version": "0.19.0"},
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

pub fn run_stdio() -> Result<(), String> {
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
        if let Some(value) = handle(message) {
            writeln!(stdout, "{value}").map_err(|error| error.to_string())?;
            stdout.flush().map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{handle, percent_encode, tools};
    use serde_json::json;

    #[test]
    fn mcp_initialize_and_tools_follow_protocol_contract() {
        let initialized =
            handle(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}})).unwrap();
        assert_eq!(initialized["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(tools()["tools"].as_array().unwrap().len(), 3);
        assert_eq!(initialized["jsonrpc"], "2.0");
    }

    #[test]
    fn mcp_query_values_are_percent_encoded() {
        assert_eq!(percent_encode("a/b c"), "a%2Fb%20c");
    }
}
