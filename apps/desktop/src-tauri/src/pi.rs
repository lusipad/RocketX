use std::{
    collections::{HashMap, HashSet},
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};
use tauri_plugin_http::reqwest;

#[path = "pi_bundle.rs"]
mod bundle;

use crate::native::{
    codex_contract::{CodexProcessInfo, CodexRuntimeSource},
    dsh_discovery::find_program,
    process::{hidden_command, host_path, kill_and_wait},
};
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiAttachmentRuntimePath {
    pub path: String,
    pub root: String,
}

const MAX_MESSAGE_BYTES: usize = 2 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES: usize = 10 * 1024 * 1024;
const PI_CONFIG_FILENAME: &str = "rocketx-pi-config.json";
const PI_BRIDGE_FILENAME: &str = "pi_app_server.mjs";
const PI_VERIFIED_VERSION: &str = "1.5.0";

pub struct PiAppServerState {
    processes: Arc<Mutex<HashMap<String, Arc<ManagedPiProcess>>>>,
    next_id: AtomicU64,
}

impl Default for PiAppServerState {
    fn default() -> Self {
        Self {
            processes: Arc::new(Mutex::new(HashMap::new())),
            next_id: AtomicU64::new(1),
        }
    }
}

struct ManagedPiProcess {
    session_id: String,
    workspace_root: String,
    version: String,
    runtime_source: CodexRuntimeSource,
    managed_skill_roots: Vec<String>,
    attachments_dir: PathBuf,
    config_fingerprint: Mutex<String>,
    manual_path: Mutex<Option<String>>,
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<ChildStdin>>,
    stopping: Arc<AtomicBool>,
    recent_stderr: Arc<Mutex<Vec<String>>>,
}

pub(crate) fn compute_pi_runtime_fingerprint(
    config: &PiConfigRecord,
    mcp_secrets: &HashMap<String, HashMap<String, String>>,
) -> String {
    let mut server_keys: Vec<(&String, &HashMap<String, String>)> = mcp_secrets.iter().collect();
    server_keys.sort_by(|a, b| a.0.cmp(b.0));
    let canonical_secrets: Vec<(String, Vec<(String, String)>)> = server_keys
        .into_iter()
        .map(|(srv, env)| {
            let mut pairs: Vec<(String, String)> =
                env.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
            pairs.sort_by(|a, b| a.0.cmp(&b.0));
            (srv.clone(), pairs)
        })
        .collect();
    let secrets_json = serde_json::to_string(&canonical_secrets).unwrap_or_default();
    format!(
        "{}|{}|{}|{}|{}|{}|{}",
        config.provider,
        config.api_protocol,
        config.base_url,
        config.api_key.trim(),
        config.default_model,
        config.manual_path.as_deref().unwrap_or(""),
        secrets_json
    )
}

pub(crate) fn broadcast_pi_runtime_reload(app: &tauri::AppHandle) {
    let Some(state) = app.try_state::<PiAppServerState>() else {
        return;
    };
    let Ok(config_path) = pi_config_path(app) else {
        return;
    };
    let config = load_pi_config_effective(&config_path);
    let mcp_secrets = app
        .path()
        .app_data_dir()
        .ok()
        .map(|dir| crate::mcp_registry::load_enabled_secret_envs(&dir))
        .unwrap_or_default();
    let next_fingerprint = compute_pi_runtime_fingerprint(&config, &mcp_secrets);

    let notification = serde_json::json!({
        "method": "rocketx/runtimeConfigUpdated",
        "params": {
            "apiKey": config.api_key.trim(),
            "mcpSecrets": mcp_secrets,
        }
    });
    let Ok(payload_bytes) = encode_json_line(notification) else {
        return;
    };

    let snapshot: Vec<(String, Arc<ManagedPiProcess>)> = {
        let Ok(mut map) = state.processes.lock() else {
            return;
        };
        map.retain(|_, proc| {
            proc.child
                .lock()
                .ok()
                .and_then(|mut c| c.try_wait().ok())
                .is_some_and(|s| s.is_none())
        });
        map.iter()
            .map(|(id, p)| (id.clone(), Arc::clone(p)))
            .collect()
    };

    for (process_id, proc) in snapshot {
        let manual_changed = proc
            .manual_path
            .lock()
            .ok()
            .is_some_and(|guard| *guard != config.manual_path);
        let notify_ok = !manual_changed
            && proc.stdin.lock().ok().is_some_and(|mut stdin| {
                stdin
                    .write_all(&payload_bytes)
                    .and_then(|_| stdin.flush())
                    .is_ok()
            });

        if notify_ok {
            if let Ok(mut fp) = proc.config_fingerprint.lock() {
                *fp = next_fingerprint.clone();
            }
        } else {
            if let Ok(mut map) = state.processes.lock() {
                map.remove(&process_id);
            }
            proc.stopping.store(true, Ordering::Release);
            if let Ok(mut child) = proc.child.lock() {
                let _ = kill_and_wait(&mut child);
            }
            let _ = std::fs::remove_dir_all(&proc.attachments_dir);
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PiOutputEvent {
    process_id: String,
    stream: &'static str,
    line: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiExitEvent {
    pub process_id: String,
    pub code: Option<i32>,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiConfigRecord {
    #[serde(default = "default_pi_provider")]
    pub provider: String,
    #[serde(default = "default_pi_api_protocol")]
    pub api_protocol: String,
    #[serde(default = "default_pi_base_url")]
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default = "default_pi_model")]
    pub default_model: String,
    #[serde(default)]
    pub extra_models: Vec<String>,
    #[serde(default)]
    pub manual_path: Option<String>,
}

impl Default for PiConfigRecord {
    fn default() -> Self {
        Self {
            provider: default_pi_provider(),
            api_protocol: default_pi_api_protocol(),
            base_url: default_pi_base_url(),
            api_key: String::new(),
            default_model: default_pi_model(),
            extra_models: Vec::new(),
            manual_path: None,
        }
    }
}

fn default_pi_provider() -> String {
    "deepseek".to_string()
}

fn default_pi_api_protocol() -> String {
    "auto".to_string()
}

fn default_pi_base_url() -> String {
    "https://api.deepseek.com/v1".to_string()
}

fn default_pi_model() -> String {
    "deepseek-v4-flash".to_string()
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiConfigWriteInput {
    pub provider: Option<String>,
    pub api_protocol: Option<String>,
    pub base_url: Option<String>,
    /// `None` preserves existing key; `Some("")` clears key; `Some(v)` updates key.
    pub api_key: Option<String>,
    pub default_model: Option<String>,
    pub extra_models: Option<Vec<String>>,
    pub manual_path: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiConfigView {
    pub provider: String,
    pub api_protocol: String,
    pub base_url: String,
    pub has_api_key: bool,
    pub api_key_hint: Option<String>,
    pub default_model: String,
    pub extra_models: Vec<String>,
    pub manual_path: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiRuntimeProbe {
    pub ready: bool,
    pub version: Option<String>,
    pub node_path: Option<String>,
    pub node_version: Option<String>,
    pub package_path: Option<String>,
    pub source: Option<CodexRuntimeSource>,
    pub configured_provider: String,
    pub default_model: String,
    pub has_credentials: bool,
    pub reason: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentAttachmentMetadata {
    session_id: String,
    relative_path: String,
}

fn normalize_pi_provider(raw: &str) -> &'static str {
    match raw.trim() {
        "deepseek" => "deepseek",
        "custom-openai" => "custom-openai",
        "ollama" => "ollama",
        "openai" => "openai",
        "anthropic" => "anthropic",
        "openrouter" => "openrouter",
        "google" => "google",
        _ => "deepseek",
    }
}

fn normalize_pi_api_protocol(raw: &str) -> &'static str {
    match raw.trim() {
        "openai-responses" => "openai-responses",
        "openai-completions" => "openai-completions",
        "anthropic-messages" => "anthropic-messages",
        "google-generative-ai" => "google-generative-ai",
        "azure-openai-responses" => "azure-openai-responses",
        "mistral-conversations" => "mistral-conversations",
        "bedrock-converse-stream" => "bedrock-converse-stream",
        _ => "auto",
    }
}

fn default_base_url_for_provider(provider: &str) -> &'static str {
    match provider {
        "custom-openai" => "http://127.0.0.1:8000/v1",
        "ollama" => "http://127.0.0.1:11434/v1",
        "openai" => "https://api.openai.com/v1",
        "anthropic" => "https://api.anthropic.com",
        "openrouter" => "https://openrouter.ai/api/v1",
        "google" => "https://generativelanguage.googleapis.com/v1beta/openai",
        _ => "https://api.deepseek.com/v1",
    }
}

fn default_model_for_provider(provider: &str) -> &'static str {
    match provider {
        "custom-openai" => "deepseek-v4-flash",
        "ollama" => "qwen3-coder",
        "openai" => "gpt-6.1-sol",
        "anthropic" => "claude-sonnet-5.5",
        "openrouter" => "deepseek/deepseek-v4-flash",
        "google" => "gemini-4-argon",
        _ => "deepseek-v4-flash",
    }
}

fn provider_allows_keyless(provider: &str) -> bool {
    matches!(provider, "ollama" | "custom-openai")
}

fn mask_api_key(key: &str) -> Option<String> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return None;
    }
    let chars: Vec<char> = trimmed.chars().collect();
    if chars.len() <= 8 {
        return Some("••••••••".to_string());
    }
    let prefix: String = chars[..4].iter().collect();
    let suffix: String = chars[chars.len() - 4..].iter().collect();
    Some(format!("{prefix}••••{suffix}"))
}

fn pi_data_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("无法定位 RocketX 本地数据目录：{error}"))?
        .join("pi");
    std::fs::create_dir_all(&root).map_err(|error| format!("无法准备 Pi 数据目录：{error}"))?;
    Ok(root)
}

const PI_KEYRING_SERVICE: &str = "com.lusipad.rocketx.pi-provider";

fn pi_config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(pi_data_root(app)?.join(PI_CONFIG_FILENAME))
}

fn pi_keyring_entry(provider: &str) -> Result<keyring::Entry, String> {
    let service = crate::credential_scope::service_name(PI_KEYRING_SERVICE)?;
    let normalized = normalize_pi_provider(provider);
    keyring::Entry::new(&service, normalized)
        .map_err(|error| format!("无法初始化 Pi 凭据保险库：{error}"))
}

fn read_pi_provider_key(provider: &str) -> Result<Option<String>, String> {
    let entry = pi_keyring_entry(provider)?;
    match entry.get_password() {
        Ok(secret) => {
            let trimmed = secret.trim().to_string();
            Ok((!trimmed.is_empty()).then_some(trimmed))
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("无法读取系统密钥链中的 Pi API Key：{error}")),
    }
}

fn delete_pi_provider_key(provider: &str) -> Result<(), String> {
    let entry = pi_keyring_entry(provider)?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("无法清除系统密钥链中的 Pi API Key：{error}")),
    }
}

fn save_pi_provider_key(provider: &str, api_key: &str) -> Result<(), String> {
    let trimmed = api_key.trim();
    if trimmed.is_empty() {
        return delete_pi_provider_key(provider);
    }
    let entry = pi_keyring_entry(provider)?;
    entry
        .set_password(trimmed)
        .map_err(|error| format!("无法将 Pi API Key 保存到系统密钥链：{error}"))
}

fn read_pi_config_from_file(path: &Path) -> PiConfigRecord {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return PiConfigRecord::default();
    };
    let Ok(mut parsed) = serde_json::from_str::<PiConfigRecord>(&raw) else {
        return PiConfigRecord::default();
    };
    parsed.provider = normalize_pi_provider(&parsed.provider).to_string();
    parsed.api_protocol = normalize_pi_api_protocol(&parsed.api_protocol).to_string();
    if parsed.base_url.trim().is_empty() {
        parsed.base_url = default_base_url_for_provider(&parsed.provider).to_string();
    }
    if parsed.default_model.trim().is_empty() {
        parsed.default_model = default_model_for_provider(&parsed.provider).to_string();
    }
    parsed
}

fn write_pi_config_to_file(path: &Path, record: &PiConfigRecord) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("无法创建 Pi 配置目录：{error}"))?;
    }
    let bytes = serde_json::to_vec_pretty(record)
        .map_err(|error| format!("无法序列化 Pi 配置：{error}"))?;
    std::fs::write(path, bytes).map_err(|error| format!("无法保存 Pi 配置：{error}"))
}

fn load_pi_config_effective(path: &Path) -> PiConfigRecord {
    let mut record = read_pi_config_from_file(path);
    let legacy_key = record.api_key.trim().to_string();
    if !legacy_key.is_empty() {
        if save_pi_provider_key(&record.provider, &legacy_key).is_ok() {
            let mut scrubbed = record.clone();
            scrubbed.api_key.clear();
            let _ = write_pi_config_to_file(path, &scrubbed);
        }
        record.api_key = legacy_key;
        return record;
    }
    if let Ok(Some(secret)) = read_pi_provider_key(&record.provider) {
        record.api_key = secret;
    }
    record
}

fn save_pi_config_effective(path: &Path, record: &PiConfigRecord) -> Result<(), String> {
    save_pi_provider_key(&record.provider, &record.api_key)?;
    let mut scrubbed = record.clone();
    scrubbed.api_key.clear();
    write_pi_config_to_file(path, &scrubbed)
}

fn is_usable_legacy_secret(value: &str) -> bool {
    let trimmed = value.trim();
    trimmed.len() >= 8
        && trimmed != "UNCONFIGURED_API_KEY"
        && trimmed != "rocketx-local-keyless"
        && !trimmed.starts_with("sk-...")
}

fn infer_provider_from_base_url(base_url: &str, default_provider: &str) -> &'static str {
    let lower = base_url.trim().to_ascii_lowercase();
    if lower.is_empty() {
        return normalize_pi_provider(default_provider);
    }
    if lower.contains("deepseek") {
        "deepseek"
    } else if lower.contains("openrouter.ai") {
        "openrouter"
    } else if lower.contains("anthropic.com") {
        "anthropic"
    } else if lower.contains("api.openai.com") {
        "openai"
    } else if lower.contains("generativelanguage.googleapis.com") {
        "google"
    } else {
        "custom-openai"
    }
}

fn find_json_string<'a>(value: &'a serde_json::Value, keys: &[&str]) -> Option<String> {
    if let Some(obj) = value.as_object() {
        for key in keys {
            if let Some(found) = obj.get(*key).and_then(|v| v.as_str()) {
                let trimmed = found.trim();
                if !trimmed.is_empty() {
                    return Some(trimmed.to_string());
                }
            }
        }
        for child in obj.values() {
            if let Some(found) = find_json_string(child, keys) {
                return Some(found);
            }
        }
    }
    None
}

fn strip_toml_or_yaml_scalar(raw: &str) -> String {
    let trimmed = raw.trim();
    let unquoted = if (trimmed.starts_with('"') && trimmed.ends_with('"') && trimmed.len() >= 2)
        || (trimmed.starts_with('\'') && trimmed.ends_with('\'') && trimmed.len() >= 2)
    {
        &trimmed[1..trimmed.len() - 1]
    } else {
        trimmed.split('#').next().unwrap_or(trimmed).trim()
    };
    unquoted.trim().to_string()
}

fn extract_key_value_from_lines(content: &str, sep: char, keys: &[&str]) -> Option<String> {
    for line in content.lines() {
        let trimmed = line.trim().trim_start_matches('-').trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let Some((lhs, rhs)) = trimmed.split_once(sep) else {
            continue;
        };
        let lhs_key = strip_toml_or_yaml_scalar(lhs);
        if keys.iter().any(|k| k.eq_ignore_ascii_case(&lhs_key)) {
            let val = strip_toml_or_yaml_scalar(rhs);
            if !val.is_empty() {
                return Some(val);
            }
        }
    }
    None
}

fn parse_legacy_dsh_dir(dir: &Path) -> Option<PiConfigRecord> {
    let mut api_key: Option<String> = None;
    let mut base_url: Option<String> = None;
    let mut model: Option<String> = None;
    let mut provider_hint: Option<String> = None;

    for filename in ["config.json", "settings.json", "auth.json"] {
        let path = dir.join(filename);
        let Ok(raw) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };
        if api_key.is_none() {
            api_key = find_json_string(
                &json,
                &["apiKey", "api_key", "DEEPSEEK_API_KEY", "OPENAI_API_KEY"],
            )
            .filter(|v| is_usable_legacy_secret(v));
        }
        if base_url.is_none() {
            base_url = find_json_string(&json, &["baseUrl", "base_url", "apiBase"]);
        }
        if model.is_none() {
            model = find_json_string(&json, &["defaultModel", "model"]);
        }
        if provider_hint.is_none() {
            provider_hint = find_json_string(&json, &["provider"]);
        }
    }

    for filename in ["config.yaml", "config.yml"] {
        let path = dir.join(filename);
        let Ok(raw) = std::fs::read_to_string(&path) else {
            continue;
        };
        if api_key.is_none() {
            api_key = extract_key_value_from_lines(
                &raw,
                ':',
                &["apiKey", "api_key", "DEEPSEEK_API_KEY", "OPENAI_API_KEY"],
            )
            .filter(|v| is_usable_legacy_secret(v));
        }
        if base_url.is_none() {
            base_url = extract_key_value_from_lines(&raw, ':', &["baseUrl", "base_url", "apiBase"]);
        }
        if model.is_none() {
            model = extract_key_value_from_lines(&raw, ':', &["defaultModel", "model"]);
        }
        if provider_hint.is_none() {
            provider_hint = extract_key_value_from_lines(&raw, ':', &["provider"]);
        }
    }

    let key = api_key?;
    let base = base_url.unwrap_or_default();
    let provider =
        infer_provider_from_base_url(&base, provider_hint.as_deref().unwrap_or("deepseek"));
    let resolved_base = if base.trim().is_empty() {
        default_base_url_for_provider(provider).to_string()
    } else {
        base.trim().trim_end_matches('/').to_string()
    };
    let resolved_model = model
        .filter(|m| !m.trim().is_empty())
        .unwrap_or_else(|| default_model_for_provider(provider).to_string());

    Some(PiConfigRecord {
        provider: provider.to_string(),
        api_protocol: "auto".to_string(),
        base_url: resolved_base,
        api_key: key,
        default_model: resolved_model,
        extra_models: Vec::new(),
        manual_path: None,
    })
}

fn parse_legacy_codex_dir(dir: &Path) -> Option<PiConfigRecord> {
    let auth_raw = std::fs::read_to_string(dir.join("auth.json")).ok()?;
    let auth_json = serde_json::from_str::<serde_json::Value>(&auth_raw).ok()?;
    let key = find_json_string(&auth_json, &["OPENAI_API_KEY", "apiKey", "api_key"])
        .filter(|v| is_usable_legacy_secret(v))?;

    let config_toml = std::fs::read_to_string(dir.join("config.toml")).unwrap_or_default();
    let base_url = extract_key_value_from_lines(&config_toml, '=', &["base_url", "baseUrl"])
        .unwrap_or_default();
    let model = extract_key_value_from_lines(&config_toml, '=', &["model"]);

    let provider = infer_provider_from_base_url(&base_url, "openai");
    let resolved_base = if base_url.trim().is_empty() {
        default_base_url_for_provider(provider).to_string()
    } else {
        base_url.trim().trim_end_matches('/').to_string()
    };
    let resolved_model = model
        .filter(|m| !m.trim().is_empty())
        .unwrap_or_else(|| default_model_for_provider(provider).to_string());

    Some(PiConfigRecord {
        provider: provider.to_string(),
        api_protocol: "auto".to_string(),
        base_url: resolved_base,
        api_key: key,
        default_model: resolved_model,
        extra_models: Vec::new(),
        manual_path: None,
    })
}

pub(crate) fn discover_legacy_pi_config_from_dirs(
    dsh_dirs: &[PathBuf],
    codex_dirs: &[PathBuf],
) -> Option<PiConfigRecord> {
    for dir in dsh_dirs {
        if let Some(found) = parse_legacy_dsh_dir(dir) {
            return Some(found);
        }
    }
    for dir in codex_dirs {
        if let Some(found) = parse_legacy_codex_dir(dir) {
            return Some(found);
        }
    }
    None
}

fn user_home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

fn ensure_legacy_pi_config_migrated(app: &tauri::AppHandle, pi_config_file: &Path) {
    if pi_config_file.is_file() {
        return;
    }
    if read_pi_provider_key("deepseek").ok().flatten().is_some()
        || read_pi_provider_key("openai").ok().flatten().is_some()
    {
        return;
    }

    let mut dsh_dirs = Vec::new();
    if let Ok(app_data) = app.path().app_data_dir() {
        dsh_dirs.push(app_data.join("dsh").join("home"));
    }
    if let Ok(local_data) = app.path().app_local_data_dir() {
        dsh_dirs.push(local_data.join("dsh").join("home"));
    }
    if let Some(home) = user_home_dir() {
        dsh_dirs.push(home.join(".dsh"));
    }

    let mut codex_dirs = Vec::new();
    if let Some(codex_home) = std::env::var_os("CODEX_HOME") {
        if !codex_home.is_empty() {
            codex_dirs.push(PathBuf::from(codex_home));
        }
    }
    if let Some(home) = user_home_dir() {
        codex_dirs.push(home.join(".codex"));
    }

    if let Some(imported) = discover_legacy_pi_config_from_dirs(&dsh_dirs, &codex_dirs) {
        let _ = save_pi_config_effective(pi_config_file, &imported);
    }
}

fn config_to_view(record: &PiConfigRecord) -> PiConfigView {
    let hint = mask_api_key(&record.api_key);
    PiConfigView {
        provider: record.provider.clone(),
        api_protocol: normalize_pi_api_protocol(&record.api_protocol).to_string(),
        base_url: record.base_url.clone(),
        has_api_key: hint.is_some(),
        api_key_hint: hint,
        default_model: record.default_model.clone(),
        extra_models: record.extra_models.clone(),
        manual_path: record.manual_path.clone(),
    }
}

#[tauri::command]
pub fn pi_config_read(app: tauri::AppHandle) -> Result<PiConfigView, String> {
    let path = pi_config_path(&app)?;
    ensure_legacy_pi_config_migrated(&app, &path);
    Ok(config_to_view(&load_pi_config_effective(&path)))
}

#[tauri::command]
pub fn pi_config_write(
    app: tauri::AppHandle,
    input: PiConfigWriteInput,
) -> Result<PiConfigView, String> {
    let path = pi_config_path(&app)?;
    let mut current = load_pi_config_effective(&path);
    let mut provider_changed = false;

    if let Some(provider) = input.provider {
        let normalized = normalize_pi_provider(&provider).to_string();
        provider_changed = normalized != current.provider;
        current.provider = normalized;
        if provider_changed && input.base_url.is_none() {
            current.base_url = default_base_url_for_provider(&current.provider).to_string();
        }
        if provider_changed && input.default_model.is_none() {
            current.default_model = default_model_for_provider(&current.provider).to_string();
        }
    }

    if let Some(api_protocol) = input.api_protocol {
        current.api_protocol = normalize_pi_api_protocol(&api_protocol).to_string();
    } else if provider_changed {
        current.api_protocol = default_pi_api_protocol();
    }

    if provider_changed && input.api_key.is_none() {
        current.api_key = read_pi_provider_key(&current.provider)
            .ok()
            .flatten()
            .unwrap_or_default();
    }

    if let Some(base_url) = input.base_url {
        let trimmed = base_url.trim().trim_end_matches('/').to_string();
        current.base_url = if trimmed.is_empty() {
            default_base_url_for_provider(&current.provider).to_string()
        } else {
            if trimmed.len() > 2048 || trimmed.chars().any(char::is_control) {
                return Err("Pi 模型网关地址无效".to_string());
            }
            trimmed
        };
    }

    if let Some(api_key) = input.api_key {
        let trimmed = api_key.trim().to_string();
        if trimmed.len() > 4096 || trimmed.chars().any(char::is_control) {
            return Err("API Key 格式无效".to_string());
        }
        current.api_key = trimmed;
    }

    if let Some(default_model) = input.default_model {
        let trimmed = default_model.trim().to_string();
        current.default_model = if trimmed.is_empty() {
            default_model_for_provider(&current.provider).to_string()
        } else {
            if trimmed.len() > 256 || trimmed.chars().any(char::is_control) {
                return Err("默认模型名称无效".to_string());
            }
            trimmed
        };
    }

    if let Some(extra_models) = input.extra_models {
        current.extra_models = extra_models
            .into_iter()
            .map(|item| item.trim().to_string())
            .filter(|item| {
                !item.is_empty() && item.len() <= 256 && !item.chars().any(char::is_control)
            })
            .take(32)
            .collect();
    }

    if let Some(manual_path) = input.manual_path {
        let trimmed = manual_path.trim().to_string();
        if trimmed.is_empty() {
            current.manual_path = None;
        } else if trimmed.len() > 4096 || trimmed.chars().any(char::is_control) {
            return Err("手动 Pi 路径无效".to_string());
        } else {
            current.manual_path = Some(trimmed);
        }
    }

    save_pi_config_effective(&path, &current)?;
    broadcast_pi_runtime_reload(&app);
    Ok(config_to_view(&current))
}

fn parse_node_version_compatible(raw: &str) -> Option<(String, bool)> {
    let trimmed = raw.trim().trim_start_matches('v');
    let mut parts = trimmed.split('.');
    let major: u32 = parts.next()?.parse().ok()?;
    let minor: u32 = parts.next()?.parse().ok()?;
    let patch_part = parts.next().unwrap_or("0");
    let patch_digits: String = patch_part
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    let patch: u32 = patch_digits.parse().unwrap_or(0);
    let compatible = major > 22 || (major == 22 && minor >= 19);
    Some((format!("{major}.{minor}.{patch}"), compatible))
}

fn node_candidate_paths() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    #[cfg(windows)]
    {
        if let Some(found) = find_program("node.exe") {
            candidates.push(found);
        }
        if let Some(pf) = std::env::var_os("ProgramFiles") {
            candidates.push(PathBuf::from(pf).join("nodejs").join("node.exe"));
        }
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            candidates.push(
                PathBuf::from(&local)
                    .join("Programs")
                    .join("nodejs")
                    .join("node.exe"),
            );
            candidates.push(
                PathBuf::from(&local)
                    .join("Volta")
                    .join("bin")
                    .join("node.exe"),
            );
        }
        if let Some(nvm) = std::env::var_os("NVM_SYMLINK") {
            candidates.push(PathBuf::from(nvm).join("node.exe"));
        }
    }
    #[cfg(not(windows))]
    {
        if let Some(found) = find_program("node") {
            candidates.push(found);
        }
        candidates.push(PathBuf::from("/usr/local/bin/node"));
        candidates.push(PathBuf::from("/opt/homebrew/bin/node"));
        candidates.push(PathBuf::from("/usr/bin/node"));
    }
    candidates
}

fn resolve_node_executable(app: &tauri::AppHandle) -> Result<(PathBuf, String), String> {
    let mut incompatible_version = None;
    let candidates = match bundle::installed(app)? {
        Some(root) => vec![bundle::node(&root)],
        None => node_candidate_paths(),
    };
    for candidate in candidates {
        if !candidate.is_file() {
            continue;
        }
        let Ok(output) = hidden_command(&candidate)
            .arg("--version")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
        else {
            continue;
        };
        if !output.status.success() {
            continue;
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        if let Some((version, compatible)) = parse_node_version_compatible(&stdout) {
            if compatible {
                return Ok((candidate, version));
            }
            incompatible_version = Some(version);
        }
    }
    if let Some(version) = incompatible_version {
        Err(format!(
            "本机 Node.js 版本过低（当前 v{version}，Pi 需要 Node.js >= 22.19.0）"
        ))
    } else {
        Err("未检测到 Node.js（>= 22.19.0）；请安装 Node.js 22 LTS 或更高版本".to_string())
    }
}

fn normalize_pi_package_candidate(candidate: &Path) -> Option<(PathBuf, String)> {
    let direct_candidates = [
        candidate.to_path_buf(),
        candidate
            .join("node_modules")
            .join("@earendil-works")
            .join("pi-coding-agent"),
        candidate.join("@earendil-works").join("pi-coding-agent"),
    ];
    for pkg_dir in direct_candidates {
        let entry = pkg_dir.join("dist").join("index.js");
        let pkg_json = pkg_dir.join("package.json");
        if !entry.is_file() || !pkg_json.is_file() {
            continue;
        }
        let version = std::fs::read_to_string(&pkg_json)
            .ok()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
            .and_then(|json| {
                json.get("version")
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
            })
            .unwrap_or_else(|| PI_VERIFIED_VERSION.to_string());
        if let Ok(canonical) = std::fs::canonicalize(&pkg_dir) {
            return Some((PathBuf::from(host_path(&canonical)), version));
        }
        return Some((pkg_dir, version));
    }
    None
}

fn collect_pi_package_candidates(
    app: &tauri::AppHandle,
    manual_path: Option<&str>,
) -> Vec<(PathBuf, CodexRuntimeSource)> {
    let mut candidates = Vec::new();
    let explicit = manual_path
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var("ROCKETX_PI_RUNTIME")
                .ok()
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
                .map(PathBuf::from)
        });
    if let Some(manual) = explicit {
        candidates.push((manual, CodexRuntimeSource::Manual));
        return candidates;
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push((resource_dir.join("pi-runtime"), CodexRuntimeSource::Bundled));
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        candidates.push((
            PathBuf::from(&local)
                .join("RocketX")
                .join("resources")
                .join("pi-runtime"),
            CodexRuntimeSource::Bundled,
        ));
    }

    // Local build / workspace candidates (supports both `tauri dev` and `target/release/rocketx.exe`)
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            candidates.push((exe_dir.join("pi-runtime"), CodexRuntimeSource::Bundled));
            // exe_dir = apps/desktop/src-tauri/target/release -> ../../../.. = repo root
            let mut ancestor = Some(exe_dir);
            for _ in 0..6 {
                if let Some(dir) = ancestor {
                    let repo_pi = dir.join("apps").join("pi-runtime");
                    if repo_pi.is_dir() {
                        candidates.push((repo_pi, CodexRuntimeSource::Bundled));
                    }
                    let staged_pi = dir.join("pi-runtime");
                    if staged_pi.is_dir() {
                        candidates.push((staged_pi, CodexRuntimeSource::Bundled));
                    }
                    ancestor = dir.parent();
                }
            }
        }
    }

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    candidates.push((
        manifest_dir.join("target").join("pi-runtime"),
        CodexRuntimeSource::Bundled,
    ));
    if let Some(repo_root) = manifest_dir
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
    {
        candidates.push((
            repo_root.join("apps").join("pi-runtime"),
            CodexRuntimeSource::Bundled,
        ));
    }

    // Global npm / pnpm installations
    #[cfg(windows)]
    {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            candidates.push((
                PathBuf::from(appdata).join("npm").join("node_modules"),
                CodexRuntimeSource::Standard,
            ));
        }
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            let pnpm_global = PathBuf::from(local).join("pnpm").join("global");
            if let Ok(entries) = std::fs::read_dir(pnpm_global) {
                for entry in entries.flatten() {
                    candidates.push((
                        entry.path().join("node_modules"),
                        CodexRuntimeSource::Standard,
                    ));
                }
            }
        }
    }
    if let Some(pnpm_home) = std::env::var_os("PNPM_HOME") {
        let pnpm_global = PathBuf::from(pnpm_home).join("global");
        if let Ok(entries) = std::fs::read_dir(pnpm_global) {
            for entry in entries.flatten() {
                candidates.push((
                    entry.path().join("node_modules"),
                    CodexRuntimeSource::Standard,
                ));
            }
        }
    }

    candidates
}

fn resolve_pi_package(
    app: &tauri::AppHandle,
    manual_path: Option<&str>,
) -> Result<(PathBuf, String, CodexRuntimeSource), String> {
    let has_override = manual_path.is_some_and(|v| !v.trim().is_empty())
        || std::env::var("ROCKETX_PI_RUNTIME").is_ok_and(|v| !v.trim().is_empty());
    if !has_override {
        if let Some(root) = bundle::installed(app)? {
            return normalize_pi_package_candidate(&root)
                .map(|(dir, version)| (dir, version, CodexRuntimeSource::Bundled))
                .ok_or_else(|| "随 RocketX 安装的 Pi SDK 不完整".into());
        }
    }
    let candidates = collect_pi_package_candidates(app, manual_path);
    for (candidate, source) in candidates {
        if let Some((resolved, version)) = normalize_pi_package_candidate(&candidate) {
            return Ok((resolved, version, source));
        }
    }
    if manual_path.is_some_and(|v| !v.trim().is_empty()) {
        Err("手动指定的 Pi 运行时路径不可用（未找到 @earendil-works/pi-coding-agent）".to_string())
    } else {
        Err("未找到内建或全局安装的 @earendil-works/pi-coding-agent 运行时".to_string())
    }
}

fn resolve_pi_bridge_script(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join(PI_BRIDGE_FILENAME));
        candidates.push(resource_dir.join("pi-runtime").join(PI_BRIDGE_FILENAME));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            candidates.push(exe_dir.join(PI_BRIDGE_FILENAME));
            let mut ancestor = Some(exe_dir);
            for _ in 0..6 {
                if let Some(dir) = ancestor {
                    candidates.push(
                        dir.join("apps")
                            .join("desktop")
                            .join("src-tauri")
                            .join("src")
                            .join(PI_BRIDGE_FILENAME),
                    );
                    candidates.push(dir.join("src").join(PI_BRIDGE_FILENAME));
                    ancestor = dir.parent();
                }
            }
        }
    }
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("src")
            .join(PI_BRIDGE_FILENAME),
    );
    for candidate in candidates {
        if candidate.is_file() {
            let canonical = std::fs::canonicalize(&candidate).unwrap_or(candidate);
            return Ok(PathBuf::from(host_path(&canonical)));
        }
    }
    Err("Pi App-Server 桥接脚本缺失；请重新构建或重新安装 RocketX".to_string())
}

fn resolve_pi_skill_roots(app: &tauri::AppHandle) -> Result<Vec<String>, String> {
    let mut found = Vec::new();
    let mut push_if_dir = |candidate: PathBuf| {
        if candidate.is_dir() {
            if let Ok(canonical) = std::fs::canonicalize(&candidate) {
                let host = host_path(&canonical);
                if !found.contains(&host) {
                    found.push(host);
                }
            }
        }
    };

    if let Ok(resource_dir) = app.path().resource_dir() {
        push_if_dir(resource_dir.join("codex-skills"));
        push_if_dir(resource_dir.join("rocketx-core-skills"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            push_if_dir(exe_dir.join("codex-skills"));
            push_if_dir(exe_dir.join("rocketx-core-skills"));
            let mut ancestor = Some(exe_dir);
            for _ in 0..6 {
                if let Some(dir) = ancestor {
                    push_if_dir(
                        dir.join("apps")
                            .join("desktop")
                            .join("src-tauri")
                            .join("resources")
                            .join("codex-skills"),
                    );
                    push_if_dir(
                        dir.join("apps")
                            .join("web")
                            .join("src")
                            .join("butler")
                            .join("skills")
                            .join("core"),
                    );
                    ancestor = dir.parent();
                }
            }
        }
    }
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    push_if_dir(manifest_dir.join("resources").join("codex-skills"));
    if let Some(repo_root) = manifest_dir
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
    {
        push_if_dir(
            repo_root
                .join("apps")
                .join("web")
                .join("src")
                .join("butler")
                .join("skills")
                .join("core"),
        );
    }

    // Always include user/Dream-evolved skills under app local data so Pi loads them natively.
    let user_skills = pi_data_root(app)?.join("user-skills");
    std::fs::create_dir_all(&user_skills)
        .map_err(|error| format!("无法准备 Pi 用户 Skill 目录：{error}"))?;
    push_if_dir(user_skills);

    if found.is_empty() {
        // Create an empty fallback skill root under Pi data dir so AppServerController contract holds.
        let fallback = pi_data_root(app)?.join("skills");
        std::fs::create_dir_all(&fallback)
            .map_err(|error| format!("无法准备 Pi 默认 Skill 目录：{error}"))?;
        let canonical = std::fs::canonicalize(&fallback).unwrap_or(fallback);
        found.push(host_path(&canonical));
    }

    Ok(found)
}

fn has_effective_credentials(config: &PiConfigRecord) -> bool {
    if !config.api_key.trim().is_empty() || provider_allows_keyless(&config.provider) {
        return true;
    }
    match config.provider.as_str() {
        "deepseek" => std::env::var_os("DEEPSEEK_API_KEY").is_some(),
        "openai" => std::env::var_os("OPENAI_API_KEY").is_some(),
        "anthropic" => std::env::var_os("ANTHROPIC_API_KEY").is_some(),
        "openrouter" => std::env::var_os("OPENROUTER_API_KEY").is_some(),
        "google" => {
            std::env::var_os("GEMINI_API_KEY").is_some()
                || std::env::var_os("GOOGLE_API_KEY").is_some()
        }
        _ => false,
    }
}

fn probe_pi_runtime_blocking(
    app: &tauri::AppHandle,
    manual_override: Option<String>,
) -> PiRuntimeProbe {
    let config = pi_config_path(app)
        .map(|p| {
            ensure_legacy_pi_config_migrated(app, &p);
            load_pi_config_effective(&p)
        })
        .unwrap_or_default();
    let effective_manual = manual_override
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .or(config.manual_path.as_deref());
    let has_credentials = has_effective_credentials(&config);

    let (node_path, node_version) = match resolve_node_executable(app) {
        Ok((p, v)) => (host_path(&p), v),
        Err(reason) => {
            return PiRuntimeProbe {
                ready: false,
                version: None,
                node_path: None,
                node_version: None,
                package_path: None,
                source: None,
                configured_provider: config.provider,
                default_model: config.default_model,
                has_credentials,
                reason: Some(reason),
            };
        }
    };

    if let Err(reason) = resolve_pi_bridge_script(app) {
        return PiRuntimeProbe {
            ready: false,
            version: None,
            node_path: Some(node_path),
            node_version: Some(node_version),
            package_path: None,
            source: None,
            configured_provider: config.provider,
            default_model: config.default_model,
            has_credentials,
            reason: Some(reason),
        };
    }

    match resolve_pi_package(app, effective_manual) {
        Ok((pkg_dir, version, source)) => PiRuntimeProbe {
            ready: true,
            version: Some(version),
            node_path: Some(node_path),
            node_version: Some(node_version),
            package_path: Some(host_path(&pkg_dir)),
            source: Some(source),
            configured_provider: config.provider,
            default_model: config.default_model,
            has_credentials,
            reason: if has_credentials {
                None
            } else {
                Some("Pi 运行时已就绪；首次对话前请在「设置 → AI → Pi」填写 API Key 或选择免密本地模型".to_string())
            },
        },
        Err(reason) => PiRuntimeProbe {
            ready: false,
            version: None,
            node_path: Some(node_path),
            node_version: Some(node_version),
            package_path: None,
            source: None,
            configured_provider: config.provider,
            default_model: config.default_model,
            has_credentials,
            reason: Some(reason),
        },
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct NormalizedEndpointHint {
    normalized_base_url: String,
    preferred_protocol: &'static str,
    candidate_protocols: Vec<&'static str>,
    normalized_note: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ProbeOutcome {
    Verified,
    SupportedNeedsAuthOrModel,
    Unsupported,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiEndpointProbeInput {
    pub base_url: String,
    pub api_key: Option<String>,
    pub provider: Option<String>,
    pub api_protocol: Option<String>,
    pub preferred_model: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiProtocolProbeDetail {
    pub protocol: String,
    pub status: String,
    pub http_status: Option<u16>,
    pub message: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiEndpointProbeResult {
    pub ok: bool,
    pub normalized_base_url: String,
    pub detected_protocol: String,
    pub supported_protocols: Vec<String>,
    pub probe_details: Vec<PiProtocolProbeDetail>,
    pub discovered_models: Vec<String>,
    pub suggested_model: Option<String>,
    pub latency_ms: u64,
    pub summary: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiLocalGatewayCandidate {
    pub id: String,
    pub label: String,
    pub base_url: String,
    pub protocol: String,
    pub models: Vec<String>,
    pub latency_ms: u64,
}

fn is_azure_openai_host(lower_url: &str) -> bool {
    lower_url.contains(".openai.azure.com")
        || lower_url.contains(".cognitiveservices.azure.com")
        || lower_url.contains(".ai.azure.com")
}

fn strip_case_insensitive_suffix(value: &str, suffix: &str) -> Option<String> {
    let trimmed = value.trim().trim_end_matches('/');
    let lower = trimmed.to_ascii_lowercase();
    if lower.ends_with(suffix) {
        let cut = trimmed.len() - suffix.len();
        Some(trimmed[..cut].trim_end_matches('/').to_string())
    } else {
        None
    }
}

fn normalize_endpoint_input(
    raw_base_url: &str,
    api_key: &str,
    provider_hint: Option<&str>,
) -> NormalizedEndpointHint {
    let trimmed_key = api_key.trim();
    let provider = provider_hint
        .map(normalize_pi_provider)
        .unwrap_or("custom-openai");
    let raw_trimmed = raw_base_url.trim().trim_end_matches('/');
    let mut url = if raw_trimmed.is_empty() {
        default_base_url_for_provider(provider).to_string()
    } else {
        raw_trimmed.to_string()
    };
    let mut note: Option<String> = None;
    let mut preferred: Option<&'static str> = None;

    if let Some(stripped) = strip_case_insensitive_suffix(&url, "/responses") {
        url = stripped;
        preferred = Some(if is_azure_openai_host(&url.to_ascii_lowercase()) {
            "azure-openai-responses"
        } else {
            "openai-responses"
        });
        note = Some("已自动移除尾部 /responses 路径".to_string());
    } else if let Some(stripped) = strip_case_insensitive_suffix(&url, "/chat/completions") {
        url = stripped;
        preferred = Some("openai-completions");
        note = Some("已自动移除尾部 /chat/completions 路径".to_string());
    } else if let Some(stripped) = strip_case_insensitive_suffix(&url, "/v1/messages") {
        url = stripped;
        preferred = Some("anthropic-messages");
        note = Some("已自动移除尾部 /v1/messages 路径".to_string());
    } else if let Some(stripped) = strip_case_insensitive_suffix(&url, "/messages") {
        url = stripped;
        preferred = Some("anthropic-messages");
        note = Some("已自动移除尾部 /messages 路径".to_string());
    }

    let lower = url.to_ascii_lowercase();
    if is_azure_openai_host(&lower) {
        if let Ok(mut parsed) = reqwest::Url::parse(&url) {
            let path = parsed.path().trim_end_matches('/');
            if path.is_empty() || path == "/openai" {
                parsed.set_path("/openai/v1");
            }
            parsed.set_query(None);
            url = parsed.to_string().trim_end_matches('/').to_string();
        }
        preferred.get_or_insert("azure-openai-responses");
    } else if lower.contains("generativelanguage.googleapis.com") {
        if lower.contains("/openai") {
            preferred.get_or_insert("openai-completions");
        } else {
            if !lower.contains("/v1beta") && !lower.contains("/v1alpha") && !lower.ends_with("/v1")
            {
                url = format!("{url}/v1beta");
            }
            preferred.get_or_insert("google-generative-ai");
        }
    } else if lower.contains("api.anthropic.com") || trimmed_key.starts_with("sk-ant-") {
        if lower.contains("api.anthropic.com") {
            if let Some(root) = strip_case_insensitive_suffix(&url, "/v1") {
                url = root;
            }
        }
        preferred.get_or_insert("anthropic-messages");
    } else if lower.contains("api.openai.com") {
        preferred.get_or_insert("openai-responses");
    } else if lower.contains("api.mistral.ai") {
        preferred.get_or_insert("mistral-conversations");
    } else if trimmed_key.starts_with("AIza") {
        preferred.get_or_insert("google-generative-ai");
    } else if lower.contains(":11434") || provider == "ollama" {
        preferred.get_or_insert("openai-completions");
    }

    let resolved_preferred = preferred.unwrap_or(match provider {
        "openai" => "openai-responses",
        "anthropic" => "anthropic-messages",
        _ => "openai-responses",
    });

    let mut candidates = Vec::new();
    let push_unique = |list: &mut Vec<&'static str>, item: &'static str| {
        if !list.contains(&item) {
            list.push(item);
        }
    };
    push_unique(&mut candidates, resolved_preferred);
    for proto in [
        "openai-responses",
        "openai-completions",
        "anthropic-messages",
        "google-generative-ai",
    ] {
        push_unique(&mut candidates, proto);
    }
    if is_azure_openai_host(&url.to_ascii_lowercase()) {
        push_unique(&mut candidates, "azure-openai-responses");
    }

    NormalizedEndpointHint {
        normalized_base_url: url,
        preferred_protocol: resolved_preferred,
        candidate_protocols: candidates,
        normalized_note: note,
    }
}

fn looks_like_route_or_html_error(body_lower: &str) -> bool {
    body_lower.contains("<html")
        || body_lower.contains("<!doctype html")
        || body_lower.contains("404 page not found")
        || body_lower.contains("cannot post ")
        || body_lower.contains("cannot get ")
        || body_lower.contains("route not found")
        || body_lower.contains("unknown path")
        || body_lower.contains("unsupported endpoint")
        || body_lower.contains("no route matches")
        || body_lower.contains("does not exist")
        || body_lower.contains("not implemented")
        || body_lower.contains("invalid url")
}

fn classify_probe_http_response(_protocol: &str, status: u16, body: &str) -> ProbeOutcome {
    let lower = body.trim().to_ascii_lowercase();
    let looks_html_or_route = looks_like_route_or_html_error(&lower);
    match status {
        200..=299 => {
            if looks_html_or_route {
                ProbeOutcome::Unsupported
            } else {
                ProbeOutcome::Verified
            }
        }
        401 | 403 => {
            if looks_html_or_route {
                ProbeOutcome::Unsupported
            } else {
                ProbeOutcome::SupportedNeedsAuthOrModel
            }
        }
        400 | 422 => {
            if looks_html_or_route
                || lower.contains("404")
                || lower.contains("not found") && !lower.contains("model")
            {
                ProbeOutcome::Unsupported
            } else {
                ProbeOutcome::SupportedNeedsAuthOrModel
            }
        }
        _ => ProbeOutcome::Unsupported,
    }
}

fn build_probe_http_client(timeout_ms: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_millis(timeout_ms))
        .build()
        .map_err(|error| format!("无法初始化探测 HTTP 客户端：{error}"))
}

fn extract_models_from_json(payload: &serde_json::Value) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let mut push = |raw: &str| {
        let clean = raw.trim().strip_prefix("models/").unwrap_or(raw.trim());
        if !clean.is_empty() && seen.insert(clean.to_string()) {
            out.push(clean.to_string());
        }
    };

    if let Some(arr) = payload.get("data").and_then(|v| v.as_array()) {
        for item in arr {
            if let Some(id) = item.get("id").and_then(|v| v.as_str()) {
                push(id);
            }
        }
    }
    if let Some(arr) = payload.get("models").and_then(|v| v.as_array()) {
        for item in arr {
            if let Some(name) = item
                .get("name")
                .or_else(|| item.get("id"))
                .or_else(|| item.get("model"))
                .and_then(|v| v.as_str())
            {
                push(name);
            }
        }
    }
    out.truncate(60);
    out
}

fn url_origin(raw_url: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(raw_url).ok()?;
    let host = parsed.host_str()?;
    let port = parsed.port().map(|p| format!(":{p}")).unwrap_or_default();
    Some(format!("{}://{}{}", parsed.scheme(), host, port))
}

fn ensure_openai_v1_base(base: &str) -> String {
    let trimmed = base.trim_end_matches('/');
    if trimmed.to_ascii_lowercase().ends_with("/v1") {
        trimmed.to_string()
    } else {
        format!("{trimmed}/v1")
    }
}

fn derive_gemini_base(base: &str) -> String {
    let trimmed = base.trim_end_matches('/');
    let lower = trimmed.to_ascii_lowercase();
    if let Some(stripped) = strip_case_insensitive_suffix(trimmed, "/openai") {
        stripped
    } else if lower.contains("/v1beta") || lower.contains("/v1alpha") || lower.ends_with("/v1") {
        trimmed.to_string()
    } else {
        format!("{trimmed}/v1beta")
    }
}

async fn try_fetch_models_json(
    client: &reqwest::Client,
    url: &str,
    headers: &[(&'static str, String)],
) -> Vec<String> {
    let mut req = client.get(url);
    for (k, v) in headers {
        req = req.header(*k, v);
    }
    let Ok(resp) = req.send().await else {
        return Vec::new();
    };
    if !resp.status().is_success() {
        return Vec::new();
    }
    let Ok(json) = resp.json::<serde_json::Value>().await else {
        return Vec::new();
    };
    extract_models_from_json(&json)
}

async fn discover_models_for_endpoint(
    client: &reqwest::Client,
    base_url: &str,
    api_key: &str,
    preferred_protocol: &str,
) -> (Vec<String>, Option<String>) {
    let mut discovered = Vec::new();
    let mut upgraded_base: Option<String> = None;
    let bearer_headers: Vec<(&'static str, String)> = if !api_key.is_empty() {
        vec![("authorization", format!("Bearer {api_key}"))]
    } else {
        Vec::new()
    };

    if preferred_protocol == "google-generative-ai"
        || base_url
            .to_ascii_lowercase()
            .contains("generativelanguage.googleapis.com")
    {
        let gemini_base = derive_gemini_base(base_url);
        let gemini_headers: Vec<(&'static str, String)> = if !api_key.is_empty() {
            vec![("x-goog-api-key", api_key.to_string())]
        } else {
            Vec::new()
        };
        discovered.extend(
            try_fetch_models_json(client, &format!("{gemini_base}/models"), &gemini_headers).await,
        );
    }

    if discovered.is_empty()
        && (preferred_protocol == "anthropic-messages"
            || base_url.to_ascii_lowercase().contains("anthropic.com"))
    {
        let root = strip_case_insensitive_suffix(base_url, "/v1")
            .unwrap_or_else(|| base_url.trim_end_matches('/').to_string());
        let mut anthropic_headers = vec![("anthropic-version", "2023-06-01".to_string())];
        if !api_key.is_empty() {
            anthropic_headers.push(("x-api-key", api_key.to_string()));
        }
        discovered.extend(
            try_fetch_models_json(client, &format!("{root}/v1/models"), &anthropic_headers).await,
        );
    }

    if discovered.is_empty() {
        let direct =
            try_fetch_models_json(client, &format!("{base_url}/models"), &bearer_headers).await;
        if !direct.is_empty() {
            discovered.extend(direct);
        } else if !base_url.to_ascii_lowercase().ends_with("/v1")
            && !is_azure_openai_host(&base_url.to_ascii_lowercase())
        {
            let v1_base = ensure_openai_v1_base(base_url);
            let via_v1 =
                try_fetch_models_json(client, &format!("{v1_base}/models"), &bearer_headers).await;
            if !via_v1.is_empty() {
                discovered.extend(via_v1);
                upgraded_base = Some(v1_base);
            }
        }
    }

    if discovered.is_empty() {
        if let Some(origin) = url_origin(base_url) {
            discovered
                .extend(try_fetch_models_json(client, &format!("{origin}/api/tags"), &[]).await);
        }
    }

    let mut seen = HashSet::new();
    discovered.retain(|item| seen.insert(item.clone()));
    discovered.truncate(60);
    (discovered, upgraded_base)
}

async fn send_protocol_probe(
    client: &reqwest::Client,
    base_url: &str,
    protocol: &'static str,
    api_key: &str,
    probe_model: &str,
) -> (PiProtocolProbeDetail, Option<String>) {
    let mut upgraded_base: Option<String> = None;

    let (status, body) = match protocol {
        "openai-responses" => {
            let mut resp_url = format!("{base_url}/responses");
            let payload = serde_json::json!({
                "model": probe_model,
                "input": "ping",
                "max_output_tokens": 16,
                "stream": false
            });
            let mut req = client.post(&resp_url).json(&payload);
            if !api_key.is_empty() {
                req = req.header("authorization", format!("Bearer {api_key}"));
            }
            match req.send().await {
                Ok(mut r) => {
                    let code = r.status().as_u16();
                    let text = r.text().await.unwrap_or_default();
                    if (code == 404 || code == 405)
                        && !base_url.to_ascii_lowercase().ends_with("/v1")
                    {
                        let v1_base = ensure_openai_v1_base(base_url);
                        let v1_url = format!("{v1_base}/responses");
                        let mut v1_req = client.post(&v1_url).json(&payload);
                        if !api_key.is_empty() {
                            v1_req = v1_req.header("authorization", format!("Bearer {api_key}"));
                        }
                        if let Ok(r2) = v1_req.send().await {
                            let code2 = r2.status().as_u16();
                            let text2 = r2.text().await.unwrap_or_default();
                            if !matches!(
                                classify_probe_http_response(protocol, code2, &text2),
                                ProbeOutcome::Unsupported
                            ) {
                                upgraded_base = Some(v1_base);
                                resp_url = v1_url;
                                let _ = resp_url;
                                (Ok(code2), text2)
                            } else {
                                (Ok(code), text)
                            }
                        } else {
                            (Ok(code), text)
                        }
                    } else {
                        (Ok(code), text)
                    }
                }
                Err(err) => (Err(err.to_string()), String::new()),
            }
        }
        "openai-completions" => {
            let payload = serde_json::json!({
                "model": probe_model,
                "messages": [{ "role": "user", "content": "ping" }],
                "max_tokens": 1,
                "stream": false
            });
            let mut req = client
                .post(format!("{base_url}/chat/completions"))
                .json(&payload);
            if !api_key.is_empty() {
                req = req.header("authorization", format!("Bearer {api_key}"));
            }
            match req.send().await {
                Ok(r) => {
                    let code = r.status().as_u16();
                    let text = r.text().await.unwrap_or_default();
                    if (code == 404 || code == 405)
                        && !base_url.to_ascii_lowercase().ends_with("/v1")
                    {
                        let v1_base = ensure_openai_v1_base(base_url);
                        let mut v1_req = client
                            .post(format!("{v1_base}/chat/completions"))
                            .json(&payload);
                        if !api_key.is_empty() {
                            v1_req = v1_req.header("authorization", format!("Bearer {api_key}"));
                        }
                        if let Ok(r2) = v1_req.send().await {
                            let code2 = r2.status().as_u16();
                            let text2 = r2.text().await.unwrap_or_default();
                            if !matches!(
                                classify_probe_http_response(protocol, code2, &text2),
                                ProbeOutcome::Unsupported
                            ) {
                                upgraded_base = Some(v1_base);
                                (Ok(code2), text2)
                            } else {
                                (Ok(code), text)
                            }
                        } else {
                            (Ok(code), text)
                        }
                    } else {
                        (Ok(code), text)
                    }
                }
                Err(err) => (Err(err.to_string()), String::new()),
            }
        }
        "anthropic-messages" => {
            let root = strip_case_insensitive_suffix(base_url, "/v1")
                .unwrap_or_else(|| base_url.trim_end_matches('/').to_string());
            let payload = serde_json::json!({
                "model": probe_model,
                "max_tokens": 1,
                "messages": [{ "role": "user", "content": "ping" }]
            });
            let mut req = client
                .post(format!("{root}/v1/messages"))
                .header("anthropic-version", "2023-06-01")
                .json(&payload);
            if !api_key.is_empty() {
                req = req.header("x-api-key", api_key);
            }
            match req.send().await {
                Ok(r) => {
                    let code = r.status().as_u16();
                    let text = r.text().await.unwrap_or_default();
                    (Ok(code), text)
                }
                Err(err) => (Err(err.to_string()), String::new()),
            }
        }
        "google-generative-ai" => {
            let gemini_base = derive_gemini_base(base_url);
            let mut req = client.get(format!("{gemini_base}/models"));
            if !api_key.is_empty() {
                req = req.header("x-goog-api-key", api_key);
            }
            match req.send().await {
                Ok(r) => {
                    let code = r.status().as_u16();
                    let text = r.text().await.unwrap_or_default();
                    (Ok(code), text)
                }
                Err(err) => (Err(err.to_string()), String::new()),
            }
        }
        "azure-openai-responses" => {
            let payload = serde_json::json!({
                "model": probe_model,
                "input": "ping",
                "max_output_tokens": 16,
                "stream": false
            });
            let azure_base = if base_url.to_ascii_lowercase().contains("/openai/v1") {
                base_url.to_string()
            } else {
                format!("{}/openai/v1", base_url.trim_end_matches('/'))
            };
            let mut req = client
                .post(format!("{azure_base}/responses?api-version=v1"))
                .json(&payload);
            if !api_key.is_empty() {
                req = req.header("api-key", api_key);
            }
            match req.send().await {
                Ok(r) => {
                    let code = r.status().as_u16();
                    let text = r.text().await.unwrap_or_default();
                    (Ok(code), text)
                }
                Err(err) => (Err(err.to_string()), String::new()),
            }
        }
        _ => (Err("protocol probe skipped".to_string()), String::new()),
    };

    let detail = match status {
        Ok(code) => {
            let outcome = classify_probe_http_response(protocol, code, &body);
            let status_label = match outcome {
                ProbeOutcome::Verified => "verified",
                ProbeOutcome::SupportedNeedsAuthOrModel => "detected",
                ProbeOutcome::Unsupported => "unsupported",
            };
            PiProtocolProbeDetail {
                protocol: protocol.to_string(),
                status: status_label.to_string(),
                http_status: Some(code),
                message: None,
            }
        }
        Err(msg) => PiProtocolProbeDetail {
            protocol: protocol.to_string(),
            status: "error".to_string(),
            http_status: None,
            message: Some(msg),
        },
    };
    (detail, upgraded_base)
}

#[tauri::command]
pub async fn pi_endpoint_probe(
    app: tauri::AppHandle,
    input: PiEndpointProbeInput,
) -> Result<PiEndpointProbeResult, String> {
    let started = Instant::now();
    let raw_key = input.api_key.as_deref().map(str::trim).unwrap_or("");
    let effective_key = if !raw_key.is_empty() {
        raw_key.to_string()
    } else if let Ok(cfg_path) = pi_config_path(&app) {
        load_pi_config_effective(&cfg_path).api_key
    } else {
        String::new()
    };

    let mut hint =
        normalize_endpoint_input(&input.base_url, &effective_key, input.provider.as_deref());

    if hint.normalized_base_url.len() > 2048
        || hint.normalized_base_url.chars().any(char::is_control)
    {
        return Err("模型网关地址无效".to_string());
    }
    let parsed_url = reqwest::Url::parse(&hint.normalized_base_url)
        .map_err(|error| format!("模型网关地址格式无效：{error}"))?;
    if !matches!(parsed_url.scheme(), "http" | "https") || parsed_url.host_str().is_none() {
        return Err("仅支持 http:// 或 https:// 模型网关地址".to_string());
    }

    let explicit_protocol = input
        .api_protocol
        .as_deref()
        .map(normalize_pi_api_protocol)
        .filter(|proto| *proto != "auto");
    if let Some(proto) = explicit_protocol {
        hint.candidate_protocols.retain(|item| *item != proto);
        hint.candidate_protocols.insert(0, proto);
    }

    let client = build_probe_http_client(3200)?;
    let (discovered_models, v1_upgrade) = discover_models_for_endpoint(
        &client,
        &hint.normalized_base_url,
        &effective_key,
        explicit_protocol.unwrap_or(hint.preferred_protocol),
    )
    .await;
    if let Some(upgraded) = v1_upgrade {
        hint.normalized_base_url = upgraded;
    }

    let probe_model = input
        .preferred_model
        .as_deref()
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .map(ToString::to_string)
        .or_else(|| discovered_models.first().cloned())
        .unwrap_or_else(
            || match explicit_protocol.unwrap_or(hint.preferred_protocol) {
                "anthropic-messages" => "claude-3-5-haiku-latest".to_string(),
                "google-generative-ai" => "gemini-2.0-flash".to_string(),
                _ => "gpt-4o-mini".to_string(),
            },
        );

    let probe_responses = send_protocol_probe(
        &client,
        &hint.normalized_base_url,
        "openai-responses",
        &effective_key,
        &probe_model,
    );
    let probe_completions = send_protocol_probe(
        &client,
        &hint.normalized_base_url,
        "openai-completions",
        &effective_key,
        &probe_model,
    );
    let probe_anthropic = send_protocol_probe(
        &client,
        &hint.normalized_base_url,
        "anthropic-messages",
        &effective_key,
        &probe_model,
    );
    let probe_google = send_protocol_probe(
        &client,
        &hint.normalized_base_url,
        "google-generative-ai",
        &effective_key,
        &probe_model,
    );

    let ((r_resp, u_resp), (r_comp, u_comp), (r_anth, _), (r_goog, _)) = tokio::join!(
        probe_responses,
        probe_completions,
        probe_anthropic,
        probe_google
    );

    if let Some(upgraded) = u_resp.or(u_comp) {
        hint.normalized_base_url = upgraded;
    }

    let mut details = vec![r_resp, r_comp, r_anth, r_goog];
    if hint.candidate_protocols.contains(&"azure-openai-responses") {
        let (r_azure, _) = send_protocol_probe(
            &client,
            &hint.normalized_base_url,
            "azure-openai-responses",
            &effective_key,
            &probe_model,
        )
        .await;
        details.push(r_azure);
    }

    // Reorder details cleanly so candidate preference order is preserved.
    let mut ordered_details = Vec::new();
    for proto in &hint.candidate_protocols {
        if let Some(pos) = details.iter().position(|d| d.protocol == *proto) {
            ordered_details.push(details.remove(pos));
        }
    }
    ordered_details.extend(details);

    let mut supported_protocols = Vec::new();
    for detail in &ordered_details {
        if detail.status == "verified" {
            supported_protocols.push(detail.protocol.clone());
        }
    }
    for detail in &ordered_details {
        if detail.status == "detected" && !supported_protocols.contains(&detail.protocol) {
            supported_protocols.push(detail.protocol.clone());
        }
    }

    let detected_protocol = ordered_details
        .iter()
        .find(|d| d.status == "verified")
        .or_else(|| ordered_details.iter().find(|d| d.status == "detected"))
        .map(|d| d.protocol.clone())
        .unwrap_or_else(|| {
            explicit_protocol
                .unwrap_or(hint.preferred_protocol)
                .to_string()
        });

    let ok = !supported_protocols.is_empty() || !discovered_models.is_empty();
    let suggested_model = discovered_models.first().cloned();
    let latency_ms = started.elapsed().as_millis() as u64;

    let mut summary_parts = Vec::new();
    if let Some(note) = hint.normalized_note {
        summary_parts.push(note);
    }
    if ok {
        summary_parts.push(format!("已识别协议：{detected_protocol}"));
        if !discovered_models.is_empty() {
            summary_parts.push(format!("发现 {} 个模型", discovered_models.len()));
        }
    } else {
        summary_parts.push("未探测到可用协议，请检查地址或密钥".to_string());
    }

    Ok(PiEndpointProbeResult {
        ok,
        normalized_base_url: hint.normalized_base_url,
        detected_protocol,
        supported_protocols,
        probe_details: ordered_details,
        discovered_models,
        suggested_model,
        latency_ms,
        summary: summary_parts.join(" · "),
    })
}

async fn scan_single_local_gateway(
    client: &reqwest::Client,
    id: &'static str,
    label: &'static str,
    base_url: &'static str,
    is_ollama: bool,
    check_responses: bool,
) -> Option<PiLocalGatewayCandidate> {
    let started = Instant::now();
    let models = if is_ollama {
        let origin = base_url.trim_end_matches("/v1");
        let resp = client.get(format!("{origin}/api/tags")).send().await.ok()?;
        if !resp.status().is_success() {
            return None;
        }
        let json = resp.json::<serde_json::Value>().await.ok()?;
        extract_models_from_json(&json)
    } else {
        let resp = client.get(format!("{base_url}/models")).send().await.ok()?;
        let status = resp.status().as_u16();
        if status >= 500 || status == 404 {
            return None;
        }
        let json = resp.json::<serde_json::Value>().await.unwrap_or_default();
        extract_models_from_json(&json)
    };

    let mut protocol = "openai-completions".to_string();
    if check_responses {
        if let Ok(resp) = client
            .post(format!("{base_url}/responses"))
            .json(&serde_json::json!({ "model": models.first().cloned().unwrap_or_else(|| "gpt-4o-mini".to_string()), "input": "ping", "max_output_tokens": 16, "stream": false }))
            .send()
            .await
        {
            let code = resp.status().as_u16();
            let text = resp.text().await.unwrap_or_default();
            if !matches!(
                classify_probe_http_response("openai-responses", code, &text),
                ProbeOutcome::Unsupported
            ) {
                protocol = "openai-responses".to_string();
            }
        }
    }

    Some(PiLocalGatewayCandidate {
        id: id.to_string(),
        label: label.to_string(),
        base_url: base_url.to_string(),
        protocol,
        models,
        latency_ms: started.elapsed().as_millis() as u64,
    })
}

#[tauri::command]
pub async fn pi_local_gateways_scan() -> Result<Vec<PiLocalGatewayCandidate>, String> {
    let client = build_probe_http_client(700)?;
    let (magpie, ollama, lmstudio, vllm, litellm) = tokio::join!(
        scan_single_local_gateway(
            &client,
            "magpie",
            "Magpie",
            "http://127.0.0.1:3425/v1",
            false,
            true
        ),
        scan_single_local_gateway(
            &client,
            "ollama",
            "Ollama",
            "http://127.0.0.1:11434/v1",
            true,
            false
        ),
        scan_single_local_gateway(
            &client,
            "lmstudio",
            "LM Studio",
            "http://127.0.0.1:1234/v1",
            false,
            false
        ),
        scan_single_local_gateway(
            &client,
            "vllm",
            "vLLM / LocalAI",
            "http://127.0.0.1:8000/v1",
            false,
            false
        ),
        scan_single_local_gateway(
            &client,
            "litellm",
            "LiteLLM",
            "http://127.0.0.1:4000/v1",
            false,
            true
        ),
    );
    Ok([magpie, ollama, lmstudio, vllm, litellm]
        .into_iter()
        .flatten()
        .collect())
}

#[tauri::command]
pub async fn pi_runtime_probe(
    app: tauri::AppHandle,
    manual_path: Option<String>,
) -> PiRuntimeProbe {
    tauri::async_runtime::spawn_blocking(move || probe_pi_runtime_blocking(&app, manual_path))
        .await
        .unwrap_or_else(|error| PiRuntimeProbe {
            ready: false,
            version: None,
            node_path: None,
            node_version: None,
            package_path: None,
            source: None,
            configured_provider: default_pi_provider(),
            default_model: default_pi_model(),
            has_credentials: false,
            reason: Some(format!("Pi 运行时探测任务失败：{error}")),
        })
}

fn validate_session_id(session_id: &str) -> Result<(), String> {
    if session_id.is_empty()
        || session_id.len() > 80
        || !session_id
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || value == '-')
    {
        return Err("invalid Pi session id".to_string());
    }
    Ok(())
}

fn resolve_pi_workspace_directory(
    app: &tauri::AppHandle,
    workspace_root: &str,
) -> Result<PathBuf, String> {
    let trimmed = workspace_root.trim();
    let target = if trimmed.is_empty() || trimmed == "~" {
        let dir = app
            .path()
            .app_local_data_dir()
            .map_err(|error| format!("无法定位 RocketX 本地数据目录：{error}"))?
            .join("codex-butler");
        std::fs::create_dir_all(&dir)
            .map_err(|error| format!("无法准备 Pi 默认管家工作区：{error}"))?;
        dir
    } else {
        PathBuf::from(trimmed)
    };
    let canonical =
        std::fs::canonicalize(&target).map_err(|error| format!("Pi 工作区不可用：{error}"))?;
    if !canonical.is_dir() {
        return Err("Pi 工作区必须是目录".to_string());
    }
    Ok(PathBuf::from(host_path(&canonical)))
}

fn encode_json_line(message: serde_json::Value) -> Result<Vec<u8>, String> {
    if !message.is_object() {
        return Err("Pi app-server message must be a JSON object".to_string());
    }
    let mut encoded = serde_json::to_vec(&message)
        .map_err(|error| format!("invalid Pi app-server JSON: {error}"))?;
    if encoded.len() > MAX_MESSAGE_BYTES {
        return Err("Pi app-server message exceeds 2 MB limit".to_string());
    }
    encoded.push(b'\n');
    Ok(encoded)
}

fn spawn_pi_stream_reader<R: std::io::Read + Send + 'static>(
    app: tauri::AppHandle,
    process_id: String,
    stream: &'static str,
    reader: R,
    recent_stderr: Option<Arc<Mutex<Vec<String>>>>,
) {
    thread::spawn(move || {
        for line in BufReader::new(reader).lines().map_while(Result::ok) {
            if line.len() <= MAX_MESSAGE_BYTES {
                if stream == "stderr" {
                    if let Some(ref buffer) = recent_stderr {
                        if let Ok(mut guard) = buffer.lock() {
                            if guard.len() >= 30 {
                                guard.remove(0);
                            }
                            guard.push(line.clone());
                        }
                    }
                }
                let _ = app.emit(
                    "pi-app-server-output",
                    PiOutputEvent {
                        process_id: process_id.clone(),
                        stream,
                        line,
                    },
                );
            }
        }
    });
}

fn monitor_pi_child(
    app: tauri::AppHandle,
    processes: Arc<Mutex<HashMap<String, Arc<ManagedPiProcess>>>>,
    process_id: String,
    child: Arc<Mutex<Child>>,
    stopping: Arc<AtomicBool>,
    recent_stderr: Arc<Mutex<Vec<String>>>,
) {
    thread::spawn(move || loop {
        let exited = {
            let Ok(mut guard) = child.lock() else {
                break;
            };
            match guard.try_wait() {
                Ok(Some(status)) => Some(status.code()),
                Ok(None) => None,
                Err(_) => Some(None),
            }
        };
        if let Some(code) = exited {
            if let Ok(mut map) = processes.lock() {
                if let Some(removed) = map.remove(&process_id) {
                    let _ = std::fs::remove_dir_all(&removed.attachments_dir);
                }
            }
            if !stopping.load(Ordering::Acquire) {
                let reason = if code != Some(0) {
                    let lines = recent_stderr
                        .lock()
                        .ok()
                        .map(|b| b.clone())
                        .unwrap_or_default();
                    let trimmed = lines.join("\n").trim().to_string();
                    if !trimmed.is_empty() {
                        Some(trimmed)
                    } else {
                        None
                    }
                } else {
                    None
                };
                let _ = app.emit(
                    "pi-app-server-exit",
                    PiExitEvent {
                        process_id,
                        code,
                        reason,
                    },
                );
            }
            break;
        }
        thread::sleep(std::time::Duration::from_millis(60));
    });
}

#[tauri::command]
pub async fn pi_app_server_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, PiAppServerState>,
    session_id: String,
    workspace_root: String,
) -> Result<CodexProcessInfo, String> {
    validate_session_id(&session_id)?;
    let processes = Arc::clone(&state.processes);
    let process_num = state.next_id.fetch_add(1, Ordering::Relaxed);
    let start_app = app.clone();

    let (process_id, managed, stdout, stderr) = tauri::async_runtime::spawn_blocking(move || {
        let resolved_workspace = resolve_pi_workspace_directory(&start_app, &workspace_root)?;
        let workspace_str = host_path(&resolved_workspace);

        let config_path = pi_config_path(&start_app)?;
        if !config_path.exists() {
            write_pi_config_to_file(&config_path, &PiConfigRecord::default())?;
        }
        let config = load_pi_config_effective(&config_path);
        let mcp_secrets = start_app
            .path()
            .app_data_dir()
            .ok()
            .map(|dir| crate::mcp_registry::load_enabled_secret_envs(&dir))
            .unwrap_or_default();
        let fingerprint = compute_pi_runtime_fingerprint(&config, &mcp_secrets);

        // Reuse existing active process if session_id + workspace_root + manual_path match
        let mut stale_to_remove: Option<(String, Arc<ManagedPiProcess>)> = None;
        if let Ok(mut map) = processes.lock() {
            map.retain(|_, proc| {
                proc.child
                    .lock()
                    .ok()
                    .and_then(|mut c| c.try_wait().ok())
                    .is_some_and(|s| s.is_none())
            });
            for (existing_id, proc) in map.iter() {
                if proc.session_id == session_id && proc.workspace_root == workspace_str {
                    let manual_same = proc
                        .manual_path
                        .lock()
                        .ok()
                        .is_some_and(|g| *g == config.manual_path);
                    if manual_same {
                        let fp_same = proc
                            .config_fingerprint
                            .lock()
                            .ok()
                            .is_some_and(|g| *g == fingerprint);
                        if !fp_same {
                            let notification = serde_json::json!({
                                "method": "rocketx/runtimeConfigUpdated",
                                "params": {
                                    "apiKey": config.api_key.trim(),
                                    "mcpSecrets": mcp_secrets,
                                }
                            });
                            if let Ok(bytes) = encode_json_line(notification) {
                                if let Ok(mut stdin) = proc.stdin.lock() {
                                    let _ = stdin.write_all(&bytes).and_then(|_| stdin.flush());
                                }
                            }
                            if let Ok(mut g) = proc.config_fingerprint.lock() {
                                *g = fingerprint.clone();
                            }
                        }
                        return Ok((existing_id.clone(), Arc::clone(proc), None, None));
                    }
                    stale_to_remove = Some((existing_id.clone(), Arc::clone(proc)));
                    break;
                }
            }
            if let Some((ref stale_id, _)) = stale_to_remove {
                map.remove(stale_id);
            }
        }
        if let Some((_, stale_proc)) = stale_to_remove {
            stale_proc.stopping.store(true, Ordering::Release);
            if let Ok(mut child) = stale_proc.child.lock() {
                let _ = kill_and_wait(&mut child);
            }
            let _ = std::fs::remove_dir_all(&stale_proc.attachments_dir);
        }

        let (node_exe, _) = resolve_node_executable(&start_app)?;
        let (pkg_dir, version, runtime_source) =
            resolve_pi_package(&start_app, config.manual_path.as_deref())?;
        let bridge_script = resolve_pi_bridge_script(&start_app)?;
        let managed_skill_roots = resolve_pi_skill_roots(&start_app)?;
        let pi_root = pi_data_root(&start_app)?;
        let agent_dir = pi_root.join("agent");
        let attachments_dir = pi_root
            .join("attachments")
            .join(format!("pi-{process_num}"));
        std::fs::create_dir_all(&agent_dir)
            .map_err(|error| format!("无法准备 Pi Agent 目录：{error}"))?;
        std::fs::create_dir_all(&attachments_dir)
            .map_err(|error| format!("无法准备 Pi 附件目录：{error}"))?;

        let mut command = hidden_command(&node_exe);
        command
            .arg(&bridge_script)
            .arg("--pi-package-dir")
            .arg(&pkg_dir)
            .arg("--agent-dir")
            .arg(&agent_dir)
            .arg("--config-file")
            .arg(&config_path)
            .arg("--workspace-root")
            .arg(&resolved_workspace)
            .current_dir(&resolved_workspace)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if !config.api_key.trim().is_empty() {
            command.env("ROCKETX_PI_API_KEY", config.api_key.trim());
        }
        if !mcp_secrets.is_empty() {
            if let Ok(serialized) = serde_json::to_string(&mcp_secrets) {
                command.env("ROCKETX_PI_MCP_SECRETS", serialized);
            }
        }

        let mut child = command
            .spawn()
            .map_err(|error| format!("启动 Pi App-Server 失败：{error}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Pi App-Server stdin 不可用".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Pi App-Server stdout 不可用".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "Pi App-Server stderr 不可用".to_string())?;

        let process_id = format!("pi-proc-{process_num}");
        let recent_stderr = Arc::new(Mutex::new(Vec::new()));
        let managed = Arc::new(ManagedPiProcess {
            session_id,
            workspace_root: workspace_str,
            version,
            runtime_source,
            managed_skill_roots,
            attachments_dir,
            config_fingerprint: Mutex::new(fingerprint),
            manual_path: Mutex::new(config.manual_path.clone()),
            child: Arc::new(Mutex::new(child)),
            stdin: Arc::new(Mutex::new(stdin)),
            stopping: Arc::new(AtomicBool::new(false)),
            recent_stderr,
        });

        processes
            .lock()
            .map_err(|_| "Pi 进程注册表不可用".to_string())?
            .insert(process_id.clone(), Arc::clone(&managed));

        Ok::<_, String>((process_id, managed, Some(stdout), Some(stderr)))
    })
    .await
    .map_err(|error| format!("Pi App-Server 启动任务失败：{error}"))??;

    if let (Some(stdout), Some(stderr)) = (stdout, stderr) {
        spawn_pi_stream_reader(app.clone(), process_id.clone(), "stdout", stdout, None);
        spawn_pi_stream_reader(
            app.clone(),
            process_id.clone(),
            "stderr",
            stderr,
            Some(Arc::clone(&managed.recent_stderr)),
        );
        monitor_pi_child(
            app,
            Arc::clone(&state.processes),
            process_id.clone(),
            Arc::clone(&managed.child),
            Arc::clone(&managed.stopping),
            Arc::clone(&managed.recent_stderr),
        );
    }

    Ok(CodexProcessInfo {
        process_id,
        version: managed.version.clone(),
        runtime_workspace_root: managed.workspace_root.clone(),
        runtime_source: managed.runtime_source,
        managed_skill_roots: managed.managed_skill_roots.clone(),
    })
}

#[tauri::command]
pub fn pi_app_server_write(
    state: tauri::State<'_, PiAppServerState>,
    process_id: String,
    message: serde_json::Value,
) -> Result<(), String> {
    let bytes = encode_json_line(message)?;
    let stdin = {
        let processes = state
            .processes
            .lock()
            .map_err(|_| "Pi 进程注册表不可用".to_string())?;
        let process = processes
            .get(&process_id)
            .ok_or_else(|| "Pi App-Server 进程未运行".to_string())?;
        Arc::clone(&process.stdin)
    };
    let mut stdin = stdin
        .lock()
        .map_err(|_| "Pi App-Server stdin 不可用".to_string())?;
    stdin
        .write_all(&bytes)
        .and_then(|_| stdin.flush())
        .map_err(|error| format!("向 Pi App-Server 发送消息失败：{error}"))
}

#[tauri::command]
pub fn pi_app_server_stop(
    state: tauri::State<'_, PiAppServerState>,
    process_id: String,
) -> Result<(), String> {
    let process = state
        .processes
        .lock()
        .map_err(|_| "Pi 进程注册表不可用".to_string())?
        .remove(&process_id);
    let Some(process) = process else {
        return Ok(());
    };
    process.stopping.store(true, Ordering::Release);
    if let Ok(mut child) = process.child.lock() {
        let _ = kill_and_wait(&mut child);
    }
    let _ = std::fs::remove_dir_all(&process.attachments_dir);
    Ok(())
}

fn safe_attachment_path(relative_path: &str) -> Result<PathBuf, String> {
    if relative_path.is_empty() || relative_path.len() > 300 {
        return Err("invalid Agent attachment path".to_string());
    }
    let path = Path::new(relative_path);
    if !path
        .components()
        .all(|component| matches!(component, std::path::Component::Normal(_)))
    {
        return Err("invalid Agent attachment path".to_string());
    }
    let sensitive = path.components().any(|component| {
        let value = component.as_os_str().to_string_lossy().to_ascii_lowercase();
        value == ".env"
            || value.starts_with(".env.")
            || value == "auth.json"
            || matches!(
                value.as_str(),
                "id_rsa" | "id_dsa" | "id_ecdsa" | "id_ed25519"
            )
            || matches!(
                Path::new(&value).extension().and_then(|ext| ext.to_str()),
                Some("pem" | "key" | "p12" | "pfx")
            )
            || value.starts_with("credentials.")
            || value.starts_with("secret.")
            || value.starts_with("secrets.")
    });
    if sensitive {
        return Err("敏感文件不能加入 Agent 上下文".to_string());
    }
    Ok(path.to_path_buf())
}

fn resolve_pi_attachments_dir<'a, I>(entries: I, session_id: &str) -> Result<PathBuf, String>
where
    I: IntoIterator<Item = (&'a str, &'a PathBuf)>,
{
    entries
        .into_iter()
        .find(|(proc_session_id, _)| *proc_session_id == session_id)
        .map(|(_, dir)| dir.clone())
        .ok_or_else(|| "找不到对应的运行中 Pi 会话".to_string())
}

#[tauri::command]
pub fn pi_agent_attachment_write(
    state: tauri::State<'_, PiAppServerState>,
    request: tauri::ipc::Request<'_>,
) -> Result<PiAttachmentRuntimePath, String> {
    let raw = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes,
        _ => return Err("Agent attachment request must be binary".to_string()),
    };
    let metadata_size =
        raw.get(..4)
            .and_then(|value| value.try_into().ok())
            .map(u32::from_le_bytes)
            .ok_or_else(|| "invalid Agent attachment request".to_string())? as usize;
    if metadata_size == 0 || metadata_size > 1_024 || raw.len() < 4 + metadata_size {
        return Err("invalid Agent attachment request".to_string());
    }
    let metadata: AgentAttachmentMetadata = serde_json::from_slice(&raw[4..4 + metadata_size])
        .map_err(|_| "invalid Agent attachment metadata".to_string())?;
    let bytes = &raw[4 + metadata_size..];
    validate_session_id(&metadata.session_id)?;
    if bytes.len() > MAX_ATTACHMENT_BYTES {
        return Err("Agent 单个附件不能超过 10 MB".to_string());
    }
    let relative = safe_attachment_path(&metadata.relative_path)?;
    let attachments_dir = {
        let processes = state
            .processes
            .lock()
            .map_err(|_| "Pi 进程注册表不可用".to_string())?;
        resolve_pi_attachments_dir(
            processes
                .values()
                .map(|proc| (proc.session_id.as_str(), &proc.attachments_dir)),
            &metadata.session_id,
        )?
    };
    let target = attachments_dir.join(&relative);
    let parent = target
        .parent()
        .ok_or_else(|| "invalid Agent attachment path".to_string())?;
    std::fs::create_dir_all(parent).map_err(|error| format!("无法准备 Pi 附件目录：{error}"))?;
    std::fs::write(&target, bytes).map_err(|error| format!("无法写入 Pi 附件：{error}"))?;
    Ok(PiAttachmentRuntimePath {
        path: host_path(&target),
        root: host_path(&attachments_dir),
    })
}

pub(crate) fn active_pi_child_pids(app: &tauri::AppHandle) -> Vec<u32> {
    let Some(state) = app.try_state::<PiAppServerState>() else {
        return Vec::new();
    };
    let Ok(procs) = state.processes.lock() else {
        return Vec::new();
    };
    procs
        .values()
        .filter_map(|proc| {
            let mut child = proc.child.lock().ok()?;
            child
                .try_wait()
                .ok()
                .flatten()
                .is_none()
                .then_some(child.id())
        })
        .collect()
}

pub fn shutdown_all_pi_processes(app: &tauri::AppHandle) {
    let Some(state) = app.try_state::<PiAppServerState>() else {
        return;
    };
    let drained: Vec<Arc<ManagedPiProcess>> = state
        .processes
        .lock()
        .map(|mut map| map.drain().map(|(_, v)| v).collect())
        .unwrap_or_default();
    for proc in drained {
        proc.stopping.store(true, Ordering::Release);
        if let Ok(mut child) = proc.child.lock() {
            let _ = kill_and_wait(&mut child);
        }
        let _ = std::fs::remove_dir_all(&proc.attachments_dir);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_version_compatibility_enforces_pi_minimum() {
        assert_eq!(
            parse_node_version_compatible("v25.8.1\n"),
            Some(("25.8.1".to_string(), true))
        );
        assert_eq!(
            parse_node_version_compatible("v22.19.0"),
            Some(("22.19.0".to_string(), true))
        );
        assert_eq!(
            parse_node_version_compatible("v22.18.0"),
            Some(("22.18.0".to_string(), false))
        );
        assert_eq!(
            parse_node_version_compatible("v20.11.1"),
            Some(("20.11.1".to_string(), false))
        );
    }

    #[test]
    fn api_key_masking_never_leaks_middle_characters() {
        assert_eq!(mask_api_key(""), None);
        assert_eq!(mask_api_key("short"), Some("••••••••".to_string()));
        assert_eq!(
            mask_api_key("sk-abcdef1234567890wxyz"),
            Some("sk-a••••wxyz".to_string())
        );
    }

    #[test]
    fn pi_config_roundtrip_normalizes_defaults() {
        let temp = std::env::temp_dir().join(format!("rcx-pi-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp);
        std::fs::create_dir_all(&temp).unwrap();
        let cfg_path = temp.join("config.json");

        let mut record = PiConfigRecord {
            provider: "ollama".to_string(),
            api_protocol: "auto".to_string(),
            base_url: String::new(),
            api_key: String::new(),
            default_model: String::new(),
            extra_models: vec!["qwen2.5:14b".to_string()],
            manual_path: None,
        };
        record.base_url = default_base_url_for_provider(&record.provider).to_string();
        record.default_model = default_model_for_provider(&record.provider).to_string();
        write_pi_config_to_file(&cfg_path, &record).unwrap();

        let loaded = read_pi_config_from_file(&cfg_path);
        assert_eq!(loaded.provider, "ollama");
        assert_eq!(loaded.api_protocol, "auto");
        assert_eq!(loaded.base_url, "http://127.0.0.1:11434/v1");
        assert_eq!(loaded.default_model, "qwen3-coder");
        assert!(has_effective_credentials(&loaded));

        let google_defaults = PiConfigRecord {
            provider: "google".to_string(),
            api_protocol: "google-generative-ai".to_string(),
            base_url: default_base_url_for_provider("google").to_string(),
            api_key: String::new(),
            default_model: default_model_for_provider("google").to_string(),
            extra_models: Vec::new(),
            manual_path: None,
        };
        assert_eq!(google_defaults.default_model, "gemini-4-argon");
        assert_eq!(
            normalize_pi_api_protocol("openai-responses"),
            "openai-responses"
        );
        assert_eq!(normalize_pi_api_protocol("unknown-proto"), "auto");
        assert_eq!(default_model_for_provider("deepseek"), "deepseek-v4-flash");
        assert_eq!(default_model_for_provider("anthropic"), "claude-sonnet-5.5");
        assert_eq!(default_model_for_provider("openai"), "gpt-6.1-sol");

        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn endpoint_normalization_and_probe_classification_work_like_magpie() {
        let resp_hint = normalize_endpoint_input(
            "https://proxy.example.com/v1/responses/",
            "",
            Some("custom-openai"),
        );
        assert_eq!(
            resp_hint.normalized_base_url,
            "https://proxy.example.com/v1"
        );
        assert_eq!(resp_hint.preferred_protocol, "openai-responses");

        let chat_hint = normalize_endpoint_input(
            "https://proxy.example.com/v1/chat/completions",
            "",
            Some("custom-openai"),
        );
        assert_eq!(
            chat_hint.normalized_base_url,
            "https://proxy.example.com/v1"
        );
        assert_eq!(chat_hint.preferred_protocol, "openai-completions");

        let anth_hint =
            normalize_endpoint_input("https://api.anthropic.com/v1/messages", "sk-ant-123", None);
        assert_eq!(anth_hint.normalized_base_url, "https://api.anthropic.com");
        assert_eq!(anth_hint.preferred_protocol, "anthropic-messages");

        let gemini_native = normalize_endpoint_input(
            "https://generativelanguage.googleapis.com",
            "AIzaSy-test",
            None,
        );
        assert_eq!(
            gemini_native.normalized_base_url,
            "https://generativelanguage.googleapis.com/v1beta"
        );
        assert_eq!(gemini_native.preferred_protocol, "google-generative-ai");

        let azure_hint = normalize_endpoint_input("https://my-res.openai.azure.com", "", None);
        assert_eq!(
            azure_hint.normalized_base_url,
            "https://my-res.openai.azure.com/openai/v1"
        );
        assert_eq!(azure_hint.preferred_protocol, "azure-openai-responses");

        assert_eq!(
            classify_probe_http_response("openai-responses", 200, "{\"id\":\"resp_1\"}"),
            ProbeOutcome::Verified
        );
        assert_eq!(
            classify_probe_http_response(
                "openai-responses",
                200,
                "<!doctype html><html>Login</html>"
            ),
            ProbeOutcome::Unsupported
        );
        assert_eq!(
            classify_probe_http_response(
                "openai-responses",
                400,
                "{\"error\":{\"message\":\"Invalid model\"}}"
            ),
            ProbeOutcome::SupportedNeedsAuthOrModel
        );
        assert_eq!(
            classify_probe_http_response("openai-responses", 404, "{\"error\":\"not found\"}"),
            ProbeOutcome::Unsupported
        );
    }

    #[test]
    fn workspace_pi_package_is_discoverable() {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let repo_root = manifest_dir
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .parent()
            .unwrap();
        let workspace_pi = repo_root.join("apps").join("pi-runtime");
        let resolved = normalize_pi_package_candidate(&workspace_pi);
        assert!(
            resolved.is_some(),
            "expected workspace apps/pi-runtime to resolve"
        );
        let (_, version) = resolved.unwrap();
        assert_eq!(version, "1.5.0");
    }

    #[test]
    fn runtime_fingerprint_changes_with_protocol_key_or_mcp_secrets() {
        let mut cfg = PiConfigRecord::default();
        let mut secrets = HashMap::new();
        let base_fp = compute_pi_runtime_fingerprint(&cfg, &secrets);

        cfg.api_protocol = "openai-responses".to_string();
        let proto_fp = compute_pi_runtime_fingerprint(&cfg, &secrets);
        assert_ne!(base_fp, proto_fp);

        cfg.api_key = "sk-test-new".to_string();
        let key_fp = compute_pi_runtime_fingerprint(&cfg, &secrets);
        assert_ne!(proto_fp, key_fp);

        let mut srv = HashMap::new();
        srv.insert("API_TOKEN".to_string(), "tok_1".to_string());
        secrets.insert("github".to_string(), srv);
        let mcp_fp = compute_pi_runtime_fingerprint(&cfg, &secrets);
        assert_ne!(key_fp, mcp_fp);
    }

    #[test]
    fn pi_attachment_dir_requires_matching_session_id() {
        let dir_a = PathBuf::from("session-a");
        let dir_b = PathBuf::from("session-b");
        let entries = vec![("sess-a", &dir_a), ("sess-b", &dir_b)];
        assert_eq!(
            resolve_pi_attachments_dir(entries.clone(), "sess-b").unwrap(),
            dir_b
        );
        let err = resolve_pi_attachments_dir(entries, "missing-session").unwrap_err();
        assert!(err.contains("找不到对应的运行中 Pi 会话"));
    }

    #[test]
    fn legacy_dsh_and_codex_configs_import_cleanly() {
        let temp =
            std::env::temp_dir().join(format!("rcx-pi-legacy-migrate-{}", uuid::Uuid::new_v4()));
        let dsh_dir = temp.join("dsh");
        let codex_dir = temp.join("codex");
        std::fs::create_dir_all(&dsh_dir).unwrap();
        std::fs::create_dir_all(&codex_dir).unwrap();

        std::fs::write(
            dsh_dir.join("config.yaml"),
            "provider: deepseek\napiKey: \"sk-legacy-dsh-1234567890\"\nbaseUrl: \"https://proxy.example.com/v1\"\nmodel: \"deepseek-v4-flash\"\n",
        )
        .unwrap();
        let imported_dsh =
            discover_legacy_pi_config_from_dirs(&[dsh_dir.clone()], &[codex_dir.clone()])
                .expect("expected legacy dsh config to be discovered");
        assert_eq!(imported_dsh.provider, "custom-openai");
        assert_eq!(imported_dsh.api_key, "sk-legacy-dsh-1234567890");
        assert_eq!(imported_dsh.base_url, "https://proxy.example.com/v1");
        assert_eq!(imported_dsh.default_model, "deepseek-v4-flash");

        std::fs::remove_dir_all(&dsh_dir).unwrap();
        std::fs::write(
            codex_dir.join("auth.json"),
            r#"{"OPENAI_API_KEY":"sk-codex-legacy-98765432"}"#,
        )
        .unwrap();
        std::fs::write(
            codex_dir.join("config.toml"),
            "model = \"gpt-6.1-sol\"\nbase_url = \"https://api.openai.com/v1\"\n",
        )
        .unwrap();
        let imported_codex =
            discover_legacy_pi_config_from_dirs(&[dsh_dir], &[codex_dir]).expect("expected codex");
        assert_eq!(imported_codex.provider, "openai");
        assert_eq!(imported_codex.api_key, "sk-codex-legacy-98765432");
        assert_eq!(imported_codex.default_model, "gpt-6.1-sol");

        let _ = std::fs::remove_dir_all(&temp);
    }
}
