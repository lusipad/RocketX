use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::Manager;

const REGISTRY_FILE: &str = "butler_mcp_servers.json";
const MCP_REGISTRY_KEYRING_SERVICE: &str = "com.lusipad.rocketx.mcp-server";

pub struct McpRegistryLock(pub Mutex<()>);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct McpServerRecord {
    pub id: String,
    pub name: String,
    pub transport: String,
    pub command: String,
    pub args: Vec<String>,
    pub public_env: HashMap<String, String>,
    pub secret_env_keys: Vec<String>,
    pub enabled: bool,
    pub scope: String,
    pub workspace_root: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerView {
    pub id: String,
    pub name: String,
    pub transport: String,
    pub command: String,
    pub args: Vec<String>,
    pub public_env: HashMap<String, String>,
    pub secret_env_keys: Vec<String>,
    pub has_secrets: bool,
    pub enabled: bool,
    pub scope: String,
    pub workspace_root: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpLaunchConfigItem {
    pub id: String,
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerUpsertInput {
    pub id: Option<String>,
    pub name: String,
    pub command: String,
    pub args: Option<Vec<String>>,
    pub public_env: Option<HashMap<String, String>>,
    pub secret_env: Option<HashMap<String, String>>,
    pub clear_secret_keys: Option<Vec<String>>,
    pub enabled: Option<bool>,
    pub scope: Option<String>,
    pub workspace_root: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpHealthCheckResult {
    pub ok: bool,
    pub latency_ms: u64,
    pub tool_count: usize,
    pub tools: Vec<String>,
    pub error: Option<String>,
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

fn registry_path(data_dir: &Path) -> PathBuf {
    data_dir.join(REGISTRY_FILE)
}

fn keyring_entry(server_id: &str, env_key: &str) -> Result<keyring::Entry, String> {
    let service = crate::credential_scope::service_name(MCP_REGISTRY_KEYRING_SERVICE)?;
    let account = format!("{server_id}:{env_key}");
    keyring::Entry::new(&service, &account).map_err(|error| format!("MCP 凭据库不可用：{error}"))
}

fn save_secret_env(server_id: &str, key: &str, value: &str) -> Result<(), String> {
    keyring_entry(server_id, key)?
        .set_password(value)
        .map_err(|error| format!("无法保存 MCP 密钥 {key}：{error}"))
}

fn read_secret_env(server_id: &str, key: &str) -> Option<String> {
    let entry = keyring_entry(server_id, key).ok()?;
    entry.get_password().ok()
}

fn delete_secret_env(server_id: &str, key: &str) {
    if let Ok(entry) = keyring_entry(server_id, key) {
        let _ = entry.delete_credential();
    }
}

fn validate_server_id(raw: &str) -> Result<String, String> {
    let clean = raw.trim().to_ascii_lowercase();
    if clean.is_empty()
        || clean.len() > 64
        || !clean
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
    {
        return Err("MCP server id 仅支持 1-64 个小写字母、数字、连字符或下划线".to_string());
    }
    Ok(clean)
}

fn derive_server_id(explicit: Option<&str>, name: &str) -> Result<String, String> {
    if let Some(raw) = explicit.map(str::trim).filter(|s| !s.is_empty()) {
        return validate_server_id(raw);
    }
    let mut slug = String::new();
    let mut prev_dash = false;
    for ch in name.chars() {
        let low = ch.to_ascii_lowercase();
        if low.is_ascii_lowercase() || low.is_ascii_digit() || low == '_' {
            slug.push(low);
            prev_dash = false;
        } else if !prev_dash && !slug.is_empty() {
            slug.push('-');
            prev_dash = true;
        }
        if slug.len() >= 48 {
            break;
        }
    }
    let trimmed = slug.trim_matches(['-', '_']);
    if !trimmed.is_empty() {
        Ok(trimmed.to_string())
    } else {
        let suffix = uuid::Uuid::new_v4().simple().to_string();
        Ok(format!("mcp-{}", &suffix[..8]))
    }
}

pub(crate) fn load_registry_from_dir(data_dir: &Path) -> Result<Vec<McpServerRecord>, String> {
    let path = registry_path(data_dir);
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let raw =
        std::fs::read_to_string(&path).map_err(|error| format!("无法读取 MCP 注册表：{error}"))?;
    if raw.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str::<Vec<McpServerRecord>>(&raw)
        .map_err(|error| format!("MCP 注册表文件损坏：{error}"))
}

pub(crate) fn save_registry_to_dir(
    data_dir: &Path,
    records: &[McpServerRecord],
) -> Result<(), String> {
    std::fs::create_dir_all(data_dir).map_err(|error| format!("无法创建应用数据目录：{error}"))?;
    let path = registry_path(data_dir);
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_string_pretty(records)
        .map_err(|error| format!("无法序列化 MCP 注册表：{error}"))?;
    std::fs::write(&tmp, format!("{json}\n"))
        .map_err(|error| format!("无法写入 MCP 注册表临时文件：{error}"))?;
    std::fs::rename(&tmp, &path).map_err(|error| format!("无法原子更新 MCP 注册表：{error}"))?;
    Ok(())
}

fn to_view(record: &McpServerRecord) -> McpServerView {
    McpServerView {
        id: record.id.clone(),
        name: record.name.clone(),
        transport: record.transport.clone(),
        command: record.command.clone(),
        args: record.args.clone(),
        public_env: record.public_env.clone(),
        secret_env_keys: record.secret_env_keys.clone(),
        has_secrets: !record.secret_env_keys.is_empty(),
        enabled: record.enabled,
        scope: record.scope.clone(),
        workspace_root: record.workspace_root.clone(),
        created_at: record.created_at,
        updated_at: record.updated_at,
    }
}

pub(crate) fn upsert_server_in_dir(
    data_dir: &Path,
    input: McpServerUpsertInput,
    use_keyring: bool,
) -> Result<McpServerView, String> {
    let name = input.name.trim().to_string();
    let command = input.command.trim().to_string();
    if name.is_empty() || command.is_empty() {
        return Err("MCP 服务名称与启动命令不能为空".to_string());
    }
    if command.chars().any(char::is_control) || name.chars().any(char::is_control) {
        return Err("MCP 名称或命令包含非法控制字符".to_string());
    }

    let id = derive_server_id(input.id.as_deref(), &name)?;
    let scope = match input.scope.as_deref().map(str::trim) {
        Some("workspace") => "workspace".to_string(),
        _ => "global".to_string(),
    };
    let workspace_root = input
        .workspace_root
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let args: Vec<String> = input
        .args
        .unwrap_or_default()
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && !s.chars().any(char::is_control))
        .collect();
    let public_env: HashMap<String, String> = input
        .public_env
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(k, v)| {
            let ck = k.trim().to_string();
            if ck.is_empty() || ck.chars().any(char::is_control) || v.chars().any(char::is_control)
            {
                None
            } else {
                Some((ck, v))
            }
        })
        .collect();

    let mut records = load_registry_from_dir(data_dir)?;
    let existing_idx = records.iter().position(|r| r.id == id);
    let mut secret_keys = existing_idx
        .map(|idx| records[idx].secret_env_keys.clone())
        .unwrap_or_default();

    for key in input.clear_secret_keys.unwrap_or_default() {
        let ck = key.trim();
        if !ck.is_empty() {
            secret_keys.retain(|existing| existing != ck);
            if use_keyring {
                delete_secret_env(&id, ck);
            }
        }
    }

    if let Some(secrets) = input.secret_env {
        for (raw_k, raw_v) in secrets {
            let key = raw_k.trim().to_string();
            if key.is_empty() || key.chars().any(char::is_control) {
                continue;
            }
            if raw_v.is_empty() {
                continue;
            }
            if use_keyring {
                save_secret_env(&id, &key, &raw_v)?;
            }
            if !secret_keys.iter().any(|k| k == &key) {
                secret_keys.push(key);
            }
        }
    }

    let now = now_millis();
    let record = match existing_idx {
        Some(idx) => {
            let existing = &records[idx];
            McpServerRecord {
                id: id.clone(),
                name,
                transport: "stdio".to_string(),
                command,
                args,
                public_env,
                secret_env_keys: secret_keys,
                enabled: input.enabled.unwrap_or(existing.enabled),
                scope,
                workspace_root,
                created_at: existing.created_at,
                updated_at: now,
            }
        }
        None => McpServerRecord {
            id: id.clone(),
            name,
            transport: "stdio".to_string(),
            command,
            args,
            public_env,
            secret_env_keys: secret_keys,
            enabled: input.enabled.unwrap_or(true),
            scope,
            workspace_root,
            created_at: now,
            updated_at: now,
        },
    };

    if let Some(idx) = existing_idx {
        records[idx] = record.clone();
    } else {
        records.push(record.clone());
    }
    save_registry_to_dir(data_dir, &records)?;
    Ok(to_view(&record))
}

pub(crate) fn delete_server_in_dir(
    data_dir: &Path,
    id: &str,
    use_keyring: bool,
) -> Result<bool, String> {
    let clean_id = validate_server_id(id)?;
    let mut records = load_registry_from_dir(data_dir)?;
    let Some(idx) = records.iter().position(|r| r.id == clean_id) else {
        return Ok(false);
    };
    let removed = records.remove(idx);
    if use_keyring {
        for key in &removed.secret_env_keys {
            delete_secret_env(&clean_id, key);
        }
    }
    save_registry_to_dir(data_dir, &records)?;
    Ok(true)
}

fn spawn_stdio_command(
    command: &str,
    args: &[String],
    env: &HashMap<String, String>,
) -> Result<std::process::Child, String> {
    #[cfg(windows)]
    let mut cmd = {
        let lower = command.to_ascii_lowercase();
        if lower.ends_with(".cmd")
            || lower.ends_with(".bat")
            || lower == "npx"
            || lower == "npm"
            || lower == "pnpm"
        {
            let comspec = std::env::var_os("ComSpec").unwrap_or_else(|| "cmd.exe".into());
            let mut c = crate::native::process::hidden_command(comspec);
            c.arg("/d").arg("/s").arg("/c").arg(command).args(args);
            c
        } else {
            let mut c = crate::native::process::hidden_command(command);
            c.args(args);
            c
        }
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = crate::native::process::hidden_command(command);
        c.args(args);
        c
    };

    cmd.envs(env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    cmd.spawn()
        .map_err(|error| format!("无法启动 MCP 进程 ({command})：{error}"))
}

pub(crate) fn health_check_stdio(
    command: &str,
    args: &[String],
    env: &HashMap<String, String>,
    timeout_ms: u64,
) -> McpHealthCheckResult {
    let started = Instant::now();
    let mut child = match spawn_stdio_command(command, args, env) {
        Ok(c) => c,
        Err(error) => {
            return McpHealthCheckResult {
                ok: false,
                latency_ms: started.elapsed().as_millis() as u64,
                tool_count: 0,
                tools: Vec::new(),
                error: Some(error),
            };
        }
    };

    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let (tx, rx) = std::sync::mpsc::channel::<serde_json::Value>();

    if let Some(out) = stdout {
        std::thread::spawn(move || {
            let reader = BufReader::new(out);
            for line in reader.lines().map_while(Result::ok) {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(trimmed) {
                    if tx.send(val).is_err() {
                        break;
                    }
                }
            }
        });
    }

    if let Some(mut writer) = stdin {
        let init_msg = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": { "name": "rocketx-health", "version": "1.0.0" }
            }
        });
        let notif = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized",
            "params": {}
        });
        let list_tools = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/list",
            "params": {}
        });
        let payload = format!("{init_msg}\n{notif}\n{list_tools}\n");
        let _ = writer.write_all(payload.as_bytes());
        let _ = writer.flush();
    }

    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    let mut discovered_tools: Vec<String> = Vec::new();
    let mut ok = false;
    let mut err_msg: Option<String> = None;

    while Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(remaining.min(Duration::from_millis(250))) {
            Ok(msg) => {
                if msg.get("id").and_then(|v| v.as_i64()) == Some(2) {
                    if let Some(error_obj) = msg.get("error") {
                        err_msg = Some(error_obj.to_string());
                        break;
                    }
                    if let Some(arr) = msg
                        .get("result")
                        .and_then(|r| r.get("tools"))
                        .and_then(|t| t.as_array())
                    {
                        for item in arr {
                            if let Some(name) = item.get("name").and_then(|n| n.as_str()) {
                                discovered_tools.push(name.to_string());
                            }
                        }
                    }
                    ok = true;
                    break;
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    if !ok && err_msg.is_none() {
        err_msg = Some("MCP 握手或 tools/list 响应超时".to_string());
    }

    let _ =
        crate::native::process::kill_owned_tree_and_wait(&mut child, Duration::from_millis(600))
            .or_else(|_| child.wait());

    McpHealthCheckResult {
        ok,
        latency_ms: started.elapsed().as_millis() as u64,
        tool_count: discovered_tools.len(),
        tools: discovered_tools,
        error: err_msg,
    }
}

pub(crate) fn load_enabled_secret_envs(
    data_dir: &Path,
) -> HashMap<String, HashMap<String, String>> {
    let Ok(records) = load_registry_from_dir(data_dir) else {
        return HashMap::new();
    };
    let mut result = HashMap::new();
    for record in records {
        if !record.enabled || record.secret_env_keys.is_empty() {
            continue;
        }
        let mut secrets = HashMap::new();
        for key in &record.secret_env_keys {
            if let Some(secret) = read_secret_env(&record.id, key) {
                secrets.insert(key.clone(), secret);
            }
        }
        if !secrets.is_empty() {
            result.insert(record.id, secrets);
        }
    }
    result
}

#[tauri::command]
pub fn butler_mcp_list(
    app: tauri::AppHandle,
    lock: tauri::State<'_, McpRegistryLock>,
    workspace_root: Option<String>,
) -> Result<Vec<McpServerView>, String> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "MCP 注册表锁不可用".to_string())?;
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let filter_root = workspace_root
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let records = load_registry_from_dir(&data_dir)?;
    Ok(records
        .iter()
        .filter(|r| {
            r.scope == "global"
                || filter_root.is_some_and(|root| r.workspace_root.as_deref() == Some(root))
                || filter_root.is_none()
        })
        .map(to_view)
        .collect())
}

#[tauri::command]
pub fn butler_mcp_upsert(
    app: tauri::AppHandle,
    lock: tauri::State<'_, McpRegistryLock>,
    input: McpServerUpsertInput,
) -> Result<McpServerView, String> {
    let saved = {
        let _guard = lock
            .0
            .lock()
            .map_err(|_| "MCP 注册表锁不可用".to_string())?;
        let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        upsert_server_in_dir(&data_dir, input, true)?
    };
    crate::pi::broadcast_pi_runtime_reload(&app);
    Ok(saved)
}

#[tauri::command]
pub fn butler_mcp_delete(
    app: tauri::AppHandle,
    lock: tauri::State<'_, McpRegistryLock>,
    id: String,
) -> Result<bool, String> {
    let deleted = {
        let _guard = lock
            .0
            .lock()
            .map_err(|_| "MCP 注册表锁不可用".to_string())?;
        let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        delete_server_in_dir(&data_dir, &id, true)?
    };
    if deleted {
        crate::pi::broadcast_pi_runtime_reload(&app);
    }
    Ok(deleted)
}

#[tauri::command]
pub async fn butler_mcp_health_check(
    app: tauri::AppHandle,
    lock: tauri::State<'_, McpRegistryLock>,
    id: String,
) -> Result<McpHealthCheckResult, String> {
    let (command, args, merged_env) = {
        let _guard = lock
            .0
            .lock()
            .map_err(|_| "MCP 注册表锁不可用".to_string())?;
        let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        let clean_id = validate_server_id(&id)?;
        let records = load_registry_from_dir(&data_dir)?;
        let record = records
            .into_iter()
            .find(|r| r.id == clean_id)
            .ok_or_else(|| "目标 MCP 服务不存在".to_string())?;
        let mut env = record.public_env.clone();
        for key in &record.secret_env_keys {
            if let Some(secret) = read_secret_env(&clean_id, key) {
                env.insert(key.clone(), secret);
            }
        }
        (record.command, record.args, env)
    };
    tauri::async_runtime::spawn_blocking(move || {
        health_check_stdio(&command, &args, &merged_env, 4_000)
    })
    .await
    .map_err(|error| format!("MCP 健康检查任务失败：{error}"))
}

#[tauri::command]
pub fn butler_mcp_launch_configs(
    app: tauri::AppHandle,
    lock: tauri::State<'_, McpRegistryLock>,
    workspace_root: Option<String>,
) -> Result<Vec<McpLaunchConfigItem>, String> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "MCP 注册表锁不可用".to_string())?;
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let filter_root = workspace_root
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let records = load_registry_from_dir(&data_dir)?;
    Ok(records
        .into_iter()
        .filter(|r| {
            r.enabled
                && (r.scope == "global"
                    || filter_root.is_some_and(|root| r.workspace_root.as_deref() == Some(root)))
        })
        .map(|r| {
            // Note: secret env values remain in keyring / server-side resolution only, never leaked to JS JSON.
            McpLaunchConfigItem {
                id: r.id,
                name: r.name,
                command: r.command,
                args: r.args,
                env: r.public_env,
            }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_crud_masks_secrets_on_disk() {
        let temp = std::env::temp_dir().join(format!("rcx-mcp-reg-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp).expect("create temp dir");

        let mut public_env = HashMap::new();
        public_env.insert("LOG_LEVEL".to_string(), "info".to_string());
        let mut secret_env = HashMap::new();
        secret_env.insert("API_TOKEN".to_string(), "top-secret-token-123".to_string());

        let saved = upsert_server_in_dir(
            &temp,
            McpServerUpsertInput {
                id: Some("docs-mcp".to_string()),
                name: "Docs MCP".to_string(),
                command: "node".to_string(),
                args: Some(vec!["server.js".to_string()]),
                public_env: Some(public_env),
                secret_env: Some(secret_env),
                clear_secret_keys: None,
                enabled: Some(true),
                scope: Some("global".to_string()),
                workspace_root: None,
            },
            false,
        )
        .expect("upsert server");

        assert_eq!(saved.id, "docs-mcp");
        assert!(saved.has_secrets);
        assert_eq!(saved.secret_env_keys, vec!["API_TOKEN"]);

        // Ensure disk JSON never writes secret plaintext
        let disk_raw = std::fs::read_to_string(registry_path(&temp)).expect("read registry json");
        assert!(!disk_raw.contains("top-secret-token-123"));
        assert!(disk_raw.contains("LOG_LEVEL"));

        assert!(delete_server_in_dir(&temp, "docs-mcp", false).expect("delete server"));
        assert!(load_registry_from_dir(&temp).unwrap().is_empty());
        assert!(load_enabled_secret_envs(&temp).is_empty());

        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn health_check_discovers_tools_from_stdio_mcp_server() {
        let node_ok = crate::native::process::hidden_command("node")
            .arg("--version")
            .output()
            .is_ok_and(|o| o.status.success());
        if !node_ok {
            return;
        }
        let script = r#"
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: {} } }) + '\n');
  } else if (msg.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'ping_repo' }] } }) + '\n');
  }
});
"#;
        let result = health_check_stdio(
            "node",
            &["-e".to_string(), script.to_string()],
            &HashMap::new(),
            3_000,
        );
        assert!(
            result.ok,
            "expected ok health check, got {:?}",
            result.error
        );
        assert_eq!(result.tool_count, 1);
        assert_eq!(result.tools, vec!["ping_repo"]);
    }
}
