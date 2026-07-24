use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::winauth;

const SERVICE: &str = "com.lusipad.rocketx.agent-bot";
const ACCOUNT: &str = "active";

pub struct AgentBotLock(pub Mutex<()>);

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentBotConfig {
    server_url: String,
    user_id: String,
    username: String,
    auth_token: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentBotStatus {
    enabled: bool,
    server_url: Option<String>,
    user_id: Option<String>,
    username: Option<String>,
}

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, ACCOUNT)
        .map_err(|error| format!("Agent bot keychain is unavailable: {error}"))
}

fn valid_plain(value: &str, max: usize) -> bool {
    !value.is_empty() && value.len() <= max && !value.chars().any(char::is_control)
}

fn server_matches(configured: &str, current: &str) -> bool {
    configured == current
}

fn chat_message_body(rid: String, tmid: Option<String>, text: String) -> Result<String, String> {
    let mut message = json!({"rid": rid, "msg": text});
    if let Some(tmid) = tmid {
        message["tmid"] = json!(tmid);
    }
    serde_json::to_string(&json!({ "message": message }))
        .map_err(|error| format!("failed to encode Agent bot message: {error}"))
}

fn load() -> Result<Option<AgentBotConfig>, String> {
    match entry()?.get_password() {
        Ok(value) => serde_json::from_str(&value)
            .map(Some)
            .map_err(|_| "saved Agent bot configuration is invalid".to_string()),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("failed to read Agent bot configuration: {error}")),
    }
}

#[tauri::command]
pub fn agent_bot_config_set(
    lock: tauri::State<'_, AgentBotLock>,
    server_url: String,
    user_id: String,
    username: String,
    auth_token: String,
) -> Result<(), String> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "Agent bot keychain lock is unavailable".to_string())?;
    let server_url = server_url.trim().trim_end_matches('/').to_string();
    if !(server_url.starts_with("http://") || server_url.starts_with("https://"))
        || !valid_plain(&server_url, 2048)
        || !valid_plain(&user_id, 512)
        || !valid_plain(&username, 512)
        || !valid_plain(&auth_token, 8192)
    {
        return Err("invalid Agent bot configuration".to_string());
    }
    let value = serde_json::to_string(&AgentBotConfig {
        server_url,
        user_id,
        username,
        auth_token,
    })
    .map_err(|error| format!("failed to encode Agent bot configuration: {error}"))?;
    entry()?
        .set_password(&value)
        .map_err(|error| format!("failed to save Agent bot configuration: {error}"))
}

#[tauri::command]
pub fn agent_bot_config_status(
    lock: tauri::State<'_, AgentBotLock>,
) -> Result<AgentBotStatus, String> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "Agent bot keychain lock is unavailable".to_string())?;
    let config = load()?;
    Ok(AgentBotStatus {
        enabled: config.is_some(),
        server_url: config.as_ref().map(|value| value.server_url.clone()),
        user_id: config.as_ref().map(|value| value.user_id.clone()),
        username: config.map(|value| value.username),
    })
}

#[tauri::command]
pub fn agent_bot_config_delete(lock: tauri::State<'_, AgentBotLock>) -> Result<(), String> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "Agent bot keychain lock is unavailable".to_string())?;
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("failed to delete Agent bot configuration: {error}")),
    }
}

#[tauri::command]
pub async fn agent_bot_send(
    server_url: String,
    rid: String,
    tmid: Option<String>,
    text: String,
) -> Result<Option<Value>, String> {
    let server_url = server_url.trim().trim_end_matches('/').to_string();
    if !(server_url.starts_with("http://") || server_url.starts_with("https://"))
        || !valid_plain(&server_url, 2048)
        || !valid_plain(&rid, 512)
        || tmid
            .as_deref()
            .is_some_and(|value| !valid_plain(value, 512))
        || text.is_empty()
        || text.len() > 100_000
    {
        return Err("invalid Agent bot message".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let Some(config) = load()? else {
            return Ok(None);
        };
        if !server_matches(&config.server_url, &server_url) {
            return Err("Agent bot is configured for a different Rocket.Chat server".to_string());
        }
        let body = chat_message_body(rid, tmid, text)?;
        let response = winauth::blocking_token_request(
            &format!("{}/api/v1/chat.sendMessage", config.server_url),
            "POST",
            &config.user_id,
            &config.auth_token,
            Some(&body),
        )?;
        if !(200..300).contains(&response.status) {
            return Err(format!("Agent bot returned HTTP {}", response.status));
        }
        serde_json::from_str(&response.body)
            .map(Some)
            .map_err(|error| format!("Agent bot returned invalid JSON: {error}"))
    })
    .await
    .map_err(|error| format!("Agent bot task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::{chat_message_body, server_matches};

    #[test]
    fn bot_credentials_only_match_the_active_server() {
        assert!(server_matches(
            "https://chat.example",
            "https://chat.example"
        ));
        assert!(!server_matches(
            "https://chat.example",
            "https://other.example"
        ));
    }

    #[test]
    fn bot_can_send_to_a_room_or_a_message_thread() {
        let room = chat_message_body("room".into(), None, "hello".into()).unwrap();
        let thread = chat_message_body("room".into(), Some("root".into()), "hello".into()).unwrap();
        assert!(!room.contains("tmid"));
        assert!(thread.contains("\"tmid\":\"root\""));
    }
}
