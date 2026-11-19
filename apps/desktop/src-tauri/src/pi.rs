use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
};

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

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
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<ChildStdin>>,
    stopping: Arc<AtomicBool>,
    recent_stderr: Arc<Mutex<Vec<String>>>,
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

fn pi_config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(pi_data_root(app)?.join(PI_CONFIG_FILENAME))
}

fn read_pi_config_from_file(path: &Path) -> PiConfigRecord {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return PiConfigRecord::default();
    };
    let Ok(mut parsed) = serde_json::from_str::<PiConfigRecord>(&raw) else {
        return PiConfigRecord::default();
    };
    parsed.provider = normalize_pi_provider(&parsed.provider).to_string();
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

fn config_to_view(record: &PiConfigRecord) -> PiConfigView {
    let hint = mask_api_key(&record.api_key);
    PiConfigView {
        provider: record.provider.clone(),
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
    Ok(config_to_view(&read_pi_config_from_file(&path)))
}

#[tauri::command]
pub fn pi_config_write(
    app: tauri::AppHandle,
    input: PiConfigWriteInput,
) -> Result<PiConfigView, String> {
    let path = pi_config_path(&app)?;
    let mut current = read_pi_config_from_file(&path);

    if let Some(provider) = input.provider {
        let normalized = normalize_pi_provider(&provider).to_string();
        let provider_changed = normalized != current.provider;
        current.provider = normalized;
        if provider_changed && input.base_url.is_none() {
            current.base_url = default_base_url_for_provider(&current.provider).to_string();
        }
        if provider_changed && input.default_model.is_none() {
            current.default_model = default_model_for_provider(&current.provider).to_string();
        }
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

    write_pi_config_to_file(&path, &current)?;
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

    #[cfg(debug_assertions)]
    {
        // Source and development staging directories must not mask missing installed resources.
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
    #[cfg(debug_assertions)]
    {
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
    }
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
        .map(|p| read_pi_config_from_file(&p))
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

        // Reuse existing active process if session_id + workspace_root match
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
                    return Ok((existing_id.clone(), Arc::clone(proc), None, None));
                }
            }
        }

        let config_path = pi_config_path(&start_app)?;
        if !config_path.exists() {
            write_pi_config_to_file(&config_path, &PiConfigRecord::default())?;
        }
        let config = read_pi_config_from_file(&config_path);
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
        processes
            .values()
            .find(|proc| proc.session_id == metadata.session_id)
            .or_else(|| processes.values().next())
            .map(|proc| proc.attachments_dir.clone())
            .ok_or_else(|| "Pi 会话未运行".to_string())?
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
        assert_eq!(loaded.base_url, "http://127.0.0.1:11434/v1");
        assert_eq!(loaded.default_model, "qwen3-coder");
        assert!(has_effective_credentials(&loaded));

        let google_defaults = PiConfigRecord {
            provider: "google".to_string(),
            base_url: default_base_url_for_provider("google").to_string(),
            api_key: String::new(),
            default_model: default_model_for_provider("google").to_string(),
            extra_models: Vec::new(),
            manual_path: None,
        };
        assert_eq!(google_defaults.default_model, "gemini-4-argon");
        assert_eq!(default_model_for_provider("deepseek"), "deepseek-v4-flash");
        assert_eq!(default_model_for_provider("anthropic"), "claude-sonnet-5.5");
        assert_eq!(default_model_for_provider("openai"), "gpt-6.1-sol");

        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn standalone_pi_package_is_discoverable() {
        let root = std::env::temp_dir().join(format!("rocketx-pi-test-{}", uuid::Uuid::new_v4()));
        let pkg = root.join("node_modules/@earendil-works/pi-coding-agent");
        std::fs::create_dir_all(pkg.join("dist")).unwrap();
        std::fs::write(pkg.join("dist/index.js"), "").unwrap();
        std::fs::write(pkg.join("package.json"), r#"{"version":"1.5.0"}"#).unwrap();
        let (_, version) = normalize_pi_package_candidate(&root).unwrap();
        std::fs::remove_dir_all(root).unwrap();
        assert_eq!(version, "1.5.0");
    }
}
