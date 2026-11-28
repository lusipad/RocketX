use std::{
    collections::{HashMap, HashSet},
    io::{BufRead, BufReader, Read, Write},
    path::{Component, Path, PathBuf},
    process::{Child, ChildStdin, Command, ExitStatus, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Condvar, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{Emitter, Manager};

use crate::native::{
    dsh_discovery::find_program,
    process::{
        hidden_command, host_path, kill_and_wait, kill_owned_tree_and_wait, wait_for_exit,
        OWNED_TREE_STOP_TIMEOUT,
    },
};

const ACP_DIR_NAME: &str = "acp";
const ACP_AGENTS_FILENAME: &str = "rocketx-acp-agents.json";
const ACP_BRIDGE_FILENAME: &str = "acp_bridge.mjs";
const ACP_BRIDGE_SCRIPT: &str = include_str!("acp_bridge.mjs");
const ACP_BRIDGE_ARG_PREFIX: &str = "--rocketx-acp-bridge=";
const MAX_ACP_LINE_BYTES: usize = 2 * 1024 * 1024;
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
const DEFAULT_TERMINAL_OUTPUT_BYTES: usize = 1024 * 1024;
const MAX_TERMINAL_OUTPUT_BYTES: usize = 8 * 1024 * 1024;

static REGISTRY_LOCK: Mutex<()> = Mutex::new(());
static BRIDGE_SYNC_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AcpAgentProfileRecord {
    id: String,
    name: String,
    preset: String,
    command: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    env: HashMap<String, String>,
    #[serde(default = "default_true")]
    enabled: bool,
    #[serde(default = "default_true")]
    auto_approve_safe_reads: bool,
    #[serde(default)]
    description: Option<String>,
    created_at: i64,
    updated_at: i64,
}

// Contains environment secrets. Keep this Rust-only and never derive Debug/Serialize.
pub(crate) struct NativeCodexProfile {
    pub(crate) profile_id: String,
    pub(crate) program: PathBuf,
    pub(crate) args: Vec<String>,
    pub(crate) env: HashMap<String, String>,
    pub(crate) codex_home: PathBuf,
    pub(crate) source_scope: String,
    fingerprint: String,
}

impl NativeCodexProfile {
    pub(crate) fn fingerprint(&self) -> &str {
        &self.fingerprint
    }
}

fn default_true() -> bool {
    true
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpAgentProfileView {
    pub id: String,
    pub name: String,
    pub preset: String,
    pub command: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub env_keys: Vec<String>,
    pub enabled: bool,
    pub auto_approve_safe_reads: bool,
    pub description: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub source_scope: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpAgentUpsertInput {
    pub id: Option<String>,
    pub name: String,
    pub preset: Option<String>,
    pub command: String,
    pub args: Option<Vec<String>>,
    pub cwd: Option<String>,
    /// Write-only secret map: non-empty values insert/update, empty values remove the key.
    /// When `None`, existing environment secrets are preserved.
    pub env: Option<HashMap<String, String>>,
    pub clear_env_keys: Option<Vec<String>>,
    pub enabled: Option<bool>,
    pub auto_approve_safe_reads: Option<bool>,
    pub description: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpDiscoveredCandidate {
    pub preset: String,
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub resolved_path: String,
    pub version: Option<String>,
    pub already_registered: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpAgentProbeResult {
    pub agent_id: String,
    pub ready: bool,
    pub resolved_path: Option<String>,
    pub version: Option<String>,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpProcessInfo {
    pub process_id: String,
    pub agent_id: String,
    pub agent_name: String,
    pub workspace_root: String,
    pub started_at: i64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AcpAgentOutputEvent {
    process_id: String,
    agent_id: String,
    stream: &'static str,
    line: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AcpAgentExitEvent {
    process_id: String,
    agent_id: String,
    code: Option<i32>,
    reason: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpTerminalExitStatus {
    pub exit_code: Option<i32>,
    pub signal: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpTerminalOutputSnapshot {
    pub output: String,
    pub truncated: bool,
    pub exit_status: Option<AcpTerminalExitStatus>,
}

struct ManagedAcpProcess {
    native_session_key: Option<(String, String)>,
    native_tree_stopped: AtomicBool,
    process_id: String,
    agent_id: String,
    agent_name: String,
    workspace_root: String,
    started_at: i64,
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<ChildStdin>>,
    stopping: Arc<AtomicBool>,
    exit_emitted: Arc<AtomicBool>,
    recent_stderr: Arc<Mutex<Vec<String>>>,
}

struct TerminalBuffer {
    bytes: Vec<u8>,
    byte_limit: usize,
    truncated: bool,
    exit_status: Option<AcpTerminalExitStatus>,
}

impl TerminalBuffer {
    fn new(byte_limit: usize) -> Self {
        Self {
            bytes: Vec::new(),
            byte_limit,
            truncated: false,
            exit_status: None,
        }
    }

    fn append(&mut self, chunk: &[u8]) {
        if chunk.is_empty() {
            return;
        }
        if self.byte_limit == 0 {
            self.truncated = true;
            return;
        }
        if chunk.len() >= self.byte_limit {
            let start = chunk.len() - self.byte_limit;
            self.bytes.clear();
            self.bytes.extend_from_slice(&chunk[start..]);
            self.truncated = true;
            return;
        }
        if self.bytes.len() + chunk.len() > self.byte_limit {
            let overflow = self.bytes.len() + chunk.len() - self.byte_limit;
            self.bytes.drain(..overflow);
            self.truncated = true;
        }
        self.bytes.extend_from_slice(chunk);
    }

    fn output_string(&self) -> String {
        let mut slice = self.bytes.as_slice();
        if self.truncated {
            // Skip up to 3 leading UTF-8 continuation bytes after head truncation.
            let mut skip = 0;
            while skip < 3 && skip < slice.len() && (slice[skip] & 0b1100_0000) == 0b1000_0000 {
                skip += 1;
            }
            slice = &slice[skip..];
        }
        String::from_utf8_lossy(slice).into_owned()
    }
}

struct ManagedAcpTerminal {
    child: Arc<Mutex<Child>>,
    stdin: Option<Arc<Mutex<ChildStdin>>>,
    sync: Arc<(Mutex<TerminalBuffer>, Condvar)>,
}

pub struct AcpSupervisorState {
    processes: Arc<Mutex<HashMap<String, Arc<ManagedAcpProcess>>>>,
    terminals: Arc<Mutex<HashMap<String, Arc<ManagedAcpTerminal>>>>,
    next_id: AtomicU64,
}

impl Default for AcpSupervisorState {
    fn default() -> Self {
        Self {
            processes: Arc::new(Mutex::new(HashMap::new())),
            terminals: Arc::new(Mutex::new(HashMap::new())),
            next_id: AtomicU64::new(1),
        }
    }
}

#[derive(Clone, Copy)]
struct PresetCandidateSpec {
    name: &'static str,
    command: &'static str,
    args: &'static [&'static str],
}

#[derive(Clone, Copy)]
struct PresetFamily {
    preset: &'static str,
    candidates: &'static [PresetCandidateSpec],
}

const KNOWN_ACP_PRESETS: &[PresetFamily] = &[
    PresetFamily {
        preset: "codex-acp",
        candidates: &[
            PresetCandidateSpec {
                name: "Codex CLI (ACP)",
                command: "codex-acp",
                args: &[],
            },
            PresetCandidateSpec {
                name: "OpenAI Codex CLI",
                command: "codex",
                args: &["--rocketx-acp-bridge=codex"],
            },
        ],
    },
    PresetFamily {
        preset: "antigravity",
        candidates: &[
            PresetCandidateSpec {
                name: "Google Antigravity (ACP)",
                command: "agy",
                args: &["acp"],
            },
            PresetCandidateSpec {
                name: "Google Antigravity",
                command: "language_server",
                args: &["--rocketx-acp-bridge=antigravity"],
            },
            PresetCandidateSpec {
                name: "Google Antigravity",
                command: "agentapi",
                args: &["--rocketx-acp-bridge=antigravity"],
            },
            PresetCandidateSpec {
                name: "Antigravity IDE",
                command: "antigravity-ide",
                args: &["--rocketx-acp-bridge=antigravity"],
            },
        ],
    },
    PresetFamily {
        preset: "claude-code",
        candidates: &[
            PresetCandidateSpec {
                name: "Claude Code (ACP)",
                command: "claude-code-acp",
                args: &[],
            },
            PresetCandidateSpec {
                name: "Claude Code",
                command: "claude",
                args: &["--rocketx-acp-bridge=claude"],
            },
        ],
    },
    PresetFamily {
        preset: "kimi-cli",
        candidates: &[PresetCandidateSpec {
            name: "Kimi Code (ACP)",
            command: "kimi",
            args: &["acp"],
        }],
    },
    PresetFamily {
        preset: "copilot-cli",
        candidates: &[PresetCandidateSpec {
            name: "GitHub Copilot (ACP)",
            command: "copilot",
            args: &["--acp"],
        }],
    },
    PresetFamily {
        preset: "gemini-cli",
        candidates: &[PresetCandidateSpec {
            name: "Gemini CLI (ACP)",
            command: "gemini",
            args: &["--experimental-acp"],
        }],
    },
    PresetFamily {
        preset: "opencode",
        candidates: &[PresetCandidateSpec {
            name: "OpenCode (ACP)",
            command: "opencode",
            args: &["acp"],
        }],
    },
    PresetFamily {
        preset: "goose",
        candidates: &[PresetCandidateSpec {
            name: "Goose (ACP)",
            command: "goose",
            args: &["acp"],
        }],
    },
    PresetFamily {
        preset: "qwen-code",
        candidates: &[PresetCandidateSpec {
            name: "Qwen Code (ACP)",
            command: "qwen",
            args: &["--acp"],
        }],
    },
    PresetFamily {
        preset: "dsh",
        candidates: &[PresetCandidateSpec {
            name: "DeepSeek Harness",
            command: "dsh",
            args: &["--rocketx-acp-bridge=dsh"],
        }],
    },
];

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn acp_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("无法定位 RocketX 本地数据目录：{error}"))?
        .join(ACP_DIR_NAME);
    Ok(dir)
}

fn acp_agents_file_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(acp_data_dir(app)?.join(ACP_AGENTS_FILENAME))
}

fn read_profiles_from_path(path: &Path) -> Result<Vec<AcpAgentProfileRecord>, String> {
    match std::fs::read_to_string(path) {
        Ok(raw) => {
            if raw.trim().is_empty() {
                return Ok(Vec::new());
            }
            serde_json::from_str::<Vec<AcpAgentProfileRecord>>(&raw)
                .map_err(|error| format!("无法解析 ACP Agent 配置文件：{error}"))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(format!("无法读取 ACP Agent 配置文件：{error}")),
    }
}

fn write_profiles_to_path(path: &Path, profiles: &[AcpAgentProfileRecord]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("无法创建 ACP 配置目录：{error}"))?;
    }
    let payload = serde_json::to_string_pretty(profiles)
        .map_err(|error| format!("无法序列化 ACP Agent 配置：{error}"))?;
    std::fs::write(path, payload).map_err(|error| format!("无法保存 ACP Agent 配置：{error}"))
}

fn profile_to_view(record: &AcpAgentProfileRecord) -> AcpAgentProfileView {
    let mut env_keys = record.env.keys().cloned().collect::<Vec<_>>();
    env_keys.sort();
    AcpAgentProfileView {
        source_scope: codex_profile_root(record)
            .map(|root| crate::local_sessions::normalized_source_scope("codex", &root)),
        id: record.id.clone(),
        name: record.name.clone(),
        preset: record.preset.clone(),
        command: record.command.clone(),
        args: record.args.clone(),
        cwd: record.cwd.clone(),
        env_keys,
        enabled: record.enabled,
        auto_approve_safe_reads: record.auto_approve_safe_reads,
        description: record.description.clone(),
        created_at: record.created_at,
        updated_at: record.updated_at,
    }
}

fn codex_profile_root(record: &AcpAgentProfileRecord) -> Option<PathBuf> {
    if record.preset != "codex-acp"
        && !extract_bridge_adapter(&record.args).is_some_and(|(adapter, _)| adapter == "codex")
    {
        return None;
    }
    let root = record
        .env
        .get("CODEX_HOME")
        .filter(|v| !v.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("CODEX_HOME")
                .filter(|v| !v.is_empty())
                .map(PathBuf::from)
        })
        .or_else(|| {
            std::env::var_os("USERPROFILE")
                .or_else(|| std::env::var_os("HOME"))
                .map(|v| PathBuf::from(v).join(".codex"))
        })?;
    Some(if root.is_absolute() {
        root
    } else {
        std::env::current_dir().ok()?.join(root)
    })
}

fn codex_profile_fingerprint(
    record: &AcpAgentProfileRecord,
    root: &Path,
    program: &Path,
) -> String {
    let env = record
        .env
        .iter()
        .collect::<std::collections::BTreeMap<_, _>>();
    let payload = serde_json::to_vec(&(
        &record.id,
        &record.preset,
        &record.command,
        &record.args,
        &record.cwd,
        env,
        record.enabled,
        record.updated_at,
        root,
        program,
    ))
    .expect("profile launch fields are serializable");
    format!("{:x}", Sha256::digest(payload))
}

fn native_codex_profile_record(
    record: &AcpAgentProfileRecord,
) -> Result<NativeCodexProfile, String> {
    if !record.enabled {
        return Err("Codex 执行配置已被禁用".into());
    }
    let (adapter, args) = extract_bridge_adapter(&record.args)
        .ok_or("原生控制需要原配置使用 Codex CLI 内置桥接，不能替换其他 ACP 程序")?;
    if adapter != "codex" {
        return Err("原生 Codex 会话禁止交给其他执行器".into());
    }
    let codex_home = codex_profile_root(record).ok_or("无法定位原 Codex 配置目录")?;
    let program = resolve_acp_executable(&record.command)
        .ok_or("原 Codex 执行配置的程序不存在，禁止替换为其他运行时")?;
    let fingerprint = codex_profile_fingerprint(record, &codex_home, &program);
    Ok(NativeCodexProfile {
        profile_id: record.id.clone(),
        program,
        args,
        env: record.env.clone(),
        source_scope: crate::local_sessions::normalized_source_scope("codex", &codex_home),
        fingerprint,
        codex_home,
    })
}

pub(crate) fn native_codex_profile(
    app: &tauri::AppHandle,
    profile_id: &str,
) -> Result<NativeCodexProfile, String> {
    let _guard = REGISTRY_LOCK.lock().map_err(|_| "ACP 配置锁不可用")?;
    let record = read_profiles_from_path(&acp_agents_file_path(app)?)?
        .into_iter()
        .find(|profile| profile.id == profile_id)
        .ok_or("原 Codex 执行配置不存在")?;
    native_codex_profile_record(&record)
}

pub(crate) fn verify_native_codex_profile(
    app: &tauri::AppHandle,
    profile: &NativeCodexProfile,
) -> Result<(), String> {
    let current = native_codex_profile(app, &profile.profile_id)?;
    if current.fingerprint != profile.fingerprint || current.program != profile.program {
        return Err("原 Codex 执行配置已变化，请重新交接".into());
    }
    Ok(())
}

pub(crate) fn assert_no_live_native_writer(
    app: &tauri::AppHandle,
    key: &(String, String),
) -> Result<(), String> {
    let state = app.state::<AcpSupervisorState>();
    let processes = state.processes.lock().map_err(|_| "ACP 进程注册表不可用")?;
    assert_no_native_writer_in_processes(&processes, key)
}

fn assert_no_native_writer_in_processes(
    processes: &HashMap<String, Arc<ManagedAcpProcess>>,
    key: &(String, String),
) -> Result<(), String> {
    for process in processes
        .values()
        .filter(|process| process.native_session_key.as_ref() == Some(key))
    {
        let status = process
            .child
            .lock()
            .map_err(|_| "ACP 进程状态不可用")?
            .try_wait()
            .map_err(|_| "无法确认原生会话写入进程状态")?;
        if status.is_none() {
            return Err("该原生会话已由 ACP 接管，请先停止现有执行".into());
        }
        if !process.native_tree_stopped.load(Ordering::Acquire) {
            return Err(
                "原 ACP 父进程已退出，后代进程状态尚未核对；请在原客户端核对，暂不能再次接管"
                    .into(),
            );
        }
    }
    Ok(())
}

pub(crate) fn codex_session_sources(
    app: &tauri::AppHandle,
) -> Result<Vec<crate::local_sessions::CodexSessionSource>, String> {
    let _guard = REGISTRY_LOCK.lock().map_err(|_| "ACP 配置锁不可用")?;
    let records = read_profiles_from_path(&acp_agents_file_path(app)?)?;
    Ok(records
        .iter()
        .filter(|r| r.enabled)
        .filter_map(|r| {
            codex_profile_root(r).map(|root| crate::local_sessions::CodexSessionSource {
                root,
                profile_id: Some(r.id.clone()),
            })
        })
        .collect())
}

fn upsert_profile_at_path(
    path: &Path,
    input: AcpAgentUpsertInput,
) -> Result<AcpAgentProfileView, String> {
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err("ACP Agent 名称不能为空".to_string());
    }
    let command = input.command.trim().to_string();
    if command.is_empty() {
        return Err("ACP Agent 启动命令不能为空".to_string());
    }
    let preset = input
        .preset
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or("custom")
        .to_string();
    let args = input
        .args
        .unwrap_or_default()
        .into_iter()
        .map(|a| a.trim().to_string())
        .filter(|a| !a.is_empty())
        .collect::<Vec<_>>();
    let cwd = input
        .cwd
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string);
    let description = input
        .description
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string);

    let mut profiles = read_profiles_from_path(path)?;
    let now = now_millis();

    let requested_id = input
        .id
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string);

    let existing_index = requested_id
        .as_ref()
        .and_then(|target_id| profiles.iter().position(|p| &p.id == target_id));

    let record = if let Some(index) = existing_index {
        let mut existing = profiles[index].clone();
        existing.name = name;
        existing.preset = preset;
        existing.command = command;
        existing.args = args;
        existing.cwd = cwd;
        if let Some(clear_keys) = input.clear_env_keys {
            for key in clear_keys {
                existing.env.remove(key.trim());
            }
        }
        if let Some(env_patch) = input.env {
            merge_env_secrets(&mut existing.env, env_patch)?;
        }
        if let Some(enabled) = input.enabled {
            existing.enabled = enabled;
        }
        if let Some(auto_approve) = input.auto_approve_safe_reads {
            existing.auto_approve_safe_reads = auto_approve;
        }
        existing.description = description;
        existing.updated_at = now;
        profiles[index] = existing.clone();
        existing
    } else {
        let mut env = HashMap::new();
        if let Some(env_patch) = input.env {
            merge_env_secrets(&mut env, env_patch)?;
        }
        let created = AcpAgentProfileRecord {
            id: requested_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            name,
            preset,
            command,
            args,
            cwd,
            env,
            enabled: input.enabled.unwrap_or(true),
            auto_approve_safe_reads: input.auto_approve_safe_reads.unwrap_or(true),
            description,
            created_at: now,
            updated_at: now,
        };
        profiles.push(created.clone());
        created
    };

    write_profiles_to_path(path, &profiles)?;
    Ok(profile_to_view(&record))
}

fn merge_env_secrets(
    target: &mut HashMap<String, String>,
    patch: HashMap<String, String>,
) -> Result<(), String> {
    for (raw_key, value) in patch {
        let key = raw_key.trim();
        if key.is_empty() || key.contains('=') || key.contains('\0') {
            return Err(format!("无效的环境变量名：{raw_key}"));
        }
        if value.is_empty() {
            target.remove(key);
        } else {
            target.insert(key.to_string(), value);
        }
    }
    Ok(())
}

fn delete_profile_at_path(path: &Path, agent_id: &str) -> Result<bool, String> {
    let mut profiles = read_profiles_from_path(path)?;
    let before = profiles.len();
    profiles.retain(|profile| profile.id != agent_id);
    if profiles.len() == before {
        return Ok(false);
    }
    write_profiles_to_path(path, &profiles)?;
    Ok(true)
}

fn ensure_acp_bridge_script(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("src")
            .join(ACP_BRIDGE_FILENAME);
        if dev_path.is_file() {
            return Ok(dev_path);
        }
    }

    let target_dir = acp_data_dir(app)?;
    let target_path = target_dir.join(ACP_BRIDGE_FILENAME);
    let _guard = BRIDGE_SYNC_LOCK
        .lock()
        .map_err(|_| "ACP 桥接脚本锁不可用".to_string())?;
    std::fs::create_dir_all(&target_dir).map_err(|error| format!("创建 ACP 目录失败：{error}"))?;
    let expected = ACP_BRIDGE_SCRIPT.as_bytes();
    let up_to_date = std::fs::read(&target_path)
        .map(|existing| existing == expected)
        .unwrap_or(false);
    if !up_to_date {
        std::fs::write(&target_path, expected)
            .map_err(|error| format!("写入 ACP 桥接脚本失败：{error}"))?;
    }
    Ok(target_path)
}

pub(crate) fn well_known_agent_search_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let mut seen = HashSet::new();
    let mut push_dir = |path: PathBuf| {
        if !path.as_os_str().is_empty() && seen.insert(path.clone()) {
            dirs.push(path);
        }
    };

    #[cfg(windows)]
    {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            push_dir(PathBuf::from(appdata).join("npm"));
        }
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            let local_root = PathBuf::from(local);
            push_dir(
                local_root
                    .join("Programs")
                    .join("Antigravity")
                    .join("resources")
                    .join("bin"),
            );
            push_dir(
                local_root
                    .join("Programs")
                    .join("Antigravity IDE")
                    .join("bin"),
            );
            push_dir(local_root.join("Programs").join("nodejs"));
            push_dir(local_root.join("Volta").join("bin"));
            push_dir(local_root.join("Microsoft").join("WinGet").join("Links"));
        }
        if let Some(profile) = std::env::var_os("USERPROFILE") {
            let home = PathBuf::from(profile);
            push_dir(home.join(".kimi-code").join("bin"));
            push_dir(home.join(".kimi").join("bin"));
            push_dir(home.join(".gemini").join("antigravity").join("bin"));
            push_dir(home.join(".local").join("bin"));
            push_dir(home.join(".cargo").join("bin"));
            push_dir(home.join(".bun").join("bin"));
            push_dir(home.join("scoop").join("shims"));
        }
        if let Some(pf) = std::env::var_os("ProgramFiles") {
            push_dir(PathBuf::from(pf).join("nodejs"));
        }
        if let Some(pf86) = std::env::var_os("ProgramFiles(x86)") {
            push_dir(PathBuf::from(pf86).join("nodejs"));
        }
        if let Some(nvm) = std::env::var_os("NVM_SYMLINK") {
            push_dir(PathBuf::from(nvm));
        }
    }

    #[cfg(not(windows))]
    {
        if let Some(home) = std::env::var_os("HOME") {
            let home_dir = PathBuf::from(home);
            for rel in [
                ".local/bin",
                ".npm-global/bin",
                ".cargo/bin",
                ".kimi/bin",
                ".kimi-code/bin",
                ".bun/bin",
                ".volta/bin",
                ".nvm/current/bin",
            ] {
                push_dir(home_dir.join(rel));
            }
        }
        for sys in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
            push_dir(PathBuf::from(sys));
        }
    }

    dirs
}

#[cfg(windows)]
fn is_windows_runnable_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| {
            matches!(
                ext.to_ascii_lowercase().as_str(),
                "exe" | "cmd" | "bat" | "com"
            )
        })
        .unwrap_or(false)
}

#[cfg(windows)]
fn is_windows_batch_script(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| matches!(ext.to_ascii_lowercase().as_str(), "cmd" | "bat"))
        .unwrap_or(false)
}

#[cfg(windows)]
fn append_extension(path: &Path, ext: &str) -> PathBuf {
    let mut raw = path.as_os_str().to_os_string();
    raw.push(".");
    raw.push(ext);
    PathBuf::from(raw)
}

fn resolve_direct_executable(candidate: &Path) -> Option<PathBuf> {
    #[cfg(windows)]
    {
        if is_windows_runnable_extension(candidate) {
            if candidate.is_file() {
                return Some(candidate.to_path_buf());
            }
            return None;
        }
        // On Windows, npm and other CLIs install an extensionless /bin/sh shim alongside
        // `.cmd`/`.bat`/`.exe`. Never return the extensionless shim (CreateProcess fails
        // with os error 193).
        for ext in ["exe", "cmd", "bat"] {
            let with_ext = append_extension(candidate, ext);
            if with_ext.is_file() {
                return Some(with_ext);
            }
        }
        None
    }

    #[cfg(not(windows))]
    {
        if candidate.is_file() {
            Some(candidate.to_path_buf())
        } else {
            None
        }
    }
}

pub(crate) fn resolve_executable_in_dirs(command: &str, dirs: &[PathBuf]) -> Option<PathBuf> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return None;
    }
    let path = Path::new(trimmed);
    if path.is_absolute() || trimmed.contains('/') || trimmed.contains('\\') {
        return resolve_direct_executable(path);
    }

    if let Some(found) = find_program(trimmed) {
        if let Some(resolved) = resolve_direct_executable(&found) {
            return Some(resolved);
        }
    }

    for dir in dirs {
        if !dir.is_dir() {
            continue;
        }
        if let Some(resolved) = resolve_direct_executable(&dir.join(trimmed)) {
            return Some(resolved);
        }
    }

    None
}

fn resolve_acp_executable(command: &str) -> Option<PathBuf> {
    resolve_executable_in_dirs(command, &well_known_agent_search_dirs())
}

fn resolve_node_executable() -> Option<PathBuf> {
    resolve_acp_executable("node")
}

pub(crate) fn extract_bridge_adapter(args: &[String]) -> Option<(String, Vec<String>)> {
    let mut adapter: Option<String> = None;
    let mut remaining = Vec::with_capacity(args.len());
    for arg in args {
        if adapter.is_none() {
            if let Some(raw_adapter) = arg.strip_prefix(ACP_BRIDGE_ARG_PREFIX) {
                let cleaned = raw_adapter.trim();
                if !cleaned.is_empty() {
                    adapter = Some(cleaned.to_string());
                    continue;
                }
            }
        }
        remaining.push(arg.clone());
    }
    adapter.map(|name| (name, remaining))
}

#[cfg(windows)]
fn quote_windows_cmd_token(token: &str, force_quotes: bool) -> String {
    let needs_quotes = force_quotes
        || token.is_empty()
        || token.chars().any(|ch| {
            ch.is_whitespace() || matches!(ch, '"' | '&' | '|' | '<' | '>' | '^' | '(' | ')')
        });
    if !needs_quotes {
        return token.to_string();
    }
    let escaped = token.replace('"', "\\\"");
    format!("\"{escaped}\"")
}

fn build_command_for_program(program: &Path, args: &[String]) -> Command {
    #[cfg(windows)]
    {
        if is_windows_batch_script(program) {
            let comspec =
                std::env::var_os("ComSpec").unwrap_or_else(|| std::ffi::OsString::from("cmd.exe"));
            let mut command = hidden_command(comspec);
            let mut inner = quote_windows_cmd_token(&host_path(program), true);
            for arg in args {
                inner.push(' ');
                inner.push_str(&quote_windows_cmd_token(arg, false));
            }
            command
                .arg("/d")
                .arg("/s")
                .arg("/c")
                .raw_arg(format!("\"{inner}\""));
            return command;
        }
    }

    let mut command = hidden_command(program);
    command.args(args);
    command
}

fn read_version_file(version_path: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(version_path).ok()?;
    let line = raw.lines().map(str::trim).find(|line| !line.is_empty())?;
    if line.len() > 64 {
        return None;
    }
    if line.to_ascii_lowercase().starts_with("antigravity") {
        Some(line.to_string())
    } else {
        Some(format!("Antigravity {line}"))
    }
}

pub(crate) fn read_antigravity_version_for_binary(program: &Path) -> Option<String> {
    let mut current = program.parent();
    for _ in 0..4 {
        let dir = current?;
        let candidate = dir.join("version");
        if candidate.is_file() {
            if let Some(version) = read_version_file(&candidate) {
                return Some(version);
            }
        }
        current = dir.parent();
    }

    #[cfg(windows)]
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let fallback = PathBuf::from(local)
            .join("Programs")
            .join("Antigravity")
            .join("version");
        if fallback.is_file() {
            return read_version_file(&fallback);
        }
    }

    None
}

fn probe_program_version(program: &Path, timeout: Duration) -> Option<String> {
    let args = vec![String::from("--version")];
    let mut command = build_command_for_program(program, &args);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().ok()?;
    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();

    let stdout_handle = stdout_pipe.map(|mut pipe| {
        thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = pipe.read_to_end(&mut buf);
            buf
        })
    });
    let stderr_handle = stderr_pipe.map(|mut pipe| {
        thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = pipe.read_to_end(&mut buf);
            buf
        })
    });

    let exited = wait_for_exit(&mut child, timeout, Duration::from_millis(20))
        .ok()
        .flatten();
    if exited.is_none() {
        let _ = kill_and_wait(&mut child);
        return None;
    }

    let stdout_bytes = stdout_handle
        .and_then(|h| h.join().ok())
        .unwrap_or_default();
    let stderr_bytes = stderr_handle
        .and_then(|h| h.join().ok())
        .unwrap_or_default();

    let primary = String::from_utf8_lossy(&stdout_bytes);
    let fallback = String::from_utf8_lossy(&stderr_bytes);
    primary
        .lines()
        .chain(fallback.lines())
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| line.chars().take(120).collect())
}

fn probe_agent_version(program: &Path, command_hint: &str, timeout: Duration) -> Option<String> {
    let hint_lower = command_hint.trim().to_ascii_lowercase();
    let stem_lower = program
        .file_stem()
        .and_then(|s| s.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    let is_antigravity_server = hint_lower == "language_server"
        || hint_lower == "agentapi"
        || stem_lower == "language_server"
        || stem_lower == "agentapi";

    if is_antigravity_server {
        return read_antigravity_version_for_binary(program);
    }

    probe_program_version(program, timeout).or_else(|| {
        let path_lower = program.to_string_lossy().to_ascii_lowercase();
        if path_lower.contains("antigravity") {
            read_antigravity_version_for_binary(program)
        } else {
            None
        }
    })
}

fn probe_antigravity_connection(mut command: Command) -> Result<(), String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|_| "无法启动 Antigravity 连接检查".to_string())?;
    let stdout = child.stdout.take().map(|mut pipe| {
        thread::spawn(move || {
            let mut bytes = Vec::new();
            let _ = pipe.read_to_end(&mut bytes);
            bytes
        })
    });
    let stderr = child.stderr.take().map(|mut pipe| {
        thread::spawn(move || {
            let mut bytes = Vec::new();
            let _ = pipe.read_to_end(&mut bytes);
            bytes
        })
    });
    let status = wait_for_exit(
        &mut child,
        Duration::from_secs(15),
        Duration::from_millis(20),
    )
    .ok()
    .flatten();
    let Some(status) = status else {
        let _ = kill_and_wait(&mut child);
        return Err("Antigravity 连接检查超时，请确认原应用仍在运行".to_string());
    };
    let output = stdout.and_then(|h| h.join().ok()).unwrap_or_default();
    let diagnostic = stderr.and_then(|h| h.join().ok()).unwrap_or_default();
    if status.success()
        && serde_json::from_slice::<serde_json::Value>(&output)
            .ok()
            .and_then(|value| value.get("ready").and_then(|ready| ready.as_bool()))
            == Some(true)
    {
        return Ok(());
    }
    let reason = String::from_utf8_lossy(&diagnostic).trim().to_string();
    Err(if reason.is_empty() {
        "尚未连接 Antigravity 的执行服务，历史记录仍可查看".to_string()
    } else {
        reason.chars().take(600).collect()
    })
}

fn validate_acp_line(line: &str) -> Result<Vec<u8>, String> {
    let normalized = line.trim_end_matches(['\r', '\n']);
    if normalized.is_empty() {
        return Err("ACP 消息行不能为空".to_string());
    }
    if normalized.contains('\n') || normalized.contains('\r') {
        return Err("ACP NDJSON 消息不能包含内部换行符".to_string());
    }
    if normalized.len() > MAX_ACP_LINE_BYTES {
        return Err("ACP 消息超过 2 MB 上限".to_string());
    }
    let mut bytes = normalized.as_bytes().to_vec();
    bytes.push(b'\n');
    Ok(bytes)
}

pub(crate) fn resolve_workspace_scoped_path(
    workspace_root: &str,
    raw_path: &str,
    must_exist: bool,
) -> Result<(PathBuf, PathBuf), String> {
    let trimmed_root = workspace_root.trim();
    if trimmed_root.is_empty() {
        return Err("ACP 工作区路径不能为空".to_string());
    }
    let canonical_root = std::fs::canonicalize(trimmed_root)
        .map_err(|error| format!("ACP 工作区不可用：{error}"))?;
    if !canonical_root.is_dir() {
        return Err("ACP 工作区必须是目录".to_string());
    }
    if canonical_root.parent().is_none() {
        return Err("ACP 工作区不能是文件系统根目录".to_string());
    }

    let trimmed_path = raw_path.trim();
    if trimmed_path.is_empty() || trimmed_path.contains('\0') {
        return Err("ACP 文件路径无效".to_string());
    }
    let input_path = Path::new(trimmed_path);
    if input_path
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("ACP 路径安全拦截：禁止使用 .. 越界路径".to_string());
    }

    let candidate = if input_path.is_absolute() {
        input_path.to_path_buf()
    } else {
        canonical_root.join(input_path)
    };

    if must_exist || std::fs::symlink_metadata(&candidate).is_ok() {
        let canonical_target = std::fs::canonicalize(&candidate)
            .map_err(|error| format!("无法访问目标路径：{error}"))?;
        if !canonical_target.starts_with(&canonical_root) {
            return Err("ACP 路径安全拦截：目标路径超出工作区范围".to_string());
        }
        return Ok((canonical_root, canonical_target));
    }

    let mut tail = Vec::new();
    let mut cursor = candidate.as_path();
    while std::fs::symlink_metadata(cursor).is_err() {
        let Some(file_name) = cursor.file_name() else {
            return Err("ACP 目标路径无有效父目录".to_string());
        };
        tail.push(file_name.to_os_string());
        let Some(parent) = cursor.parent() else {
            return Err("ACP 目标路径无有效父目录".to_string());
        };
        cursor = parent;
    }

    let canonical_ancestor =
        std::fs::canonicalize(cursor).map_err(|error| format!("无法解析父目录：{error}"))?;
    if !canonical_ancestor.starts_with(&canonical_root) {
        return Err("ACP 路径安全拦截：目标路径超出工作区范围".to_string());
    }

    let mut safe_target = canonical_ancestor;
    for segment in tail.into_iter().rev() {
        safe_target.push(segment);
    }
    Ok((canonical_root, safe_target))
}

fn spawn_acp_stream_reader<R: Read + Send + 'static>(
    app: tauri::AppHandle,
    process_id: String,
    agent_id: String,
    stream: &'static str,
    reader: R,
    recent_stderr: Option<Arc<Mutex<Vec<String>>>>,
) {
    thread::spawn(move || {
        let mut buf_reader = BufReader::new(reader);
        let mut raw_line = Vec::new();
        loop {
            raw_line.clear();
            match buf_reader.read_until(b'\n', &mut raw_line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    while raw_line.last().is_some_and(|b| *b == b'\n' || *b == b'\r') {
                        raw_line.pop();
                    }
                    if raw_line.len() > MAX_ACP_LINE_BYTES {
                        continue;
                    }
                    let line = String::from_utf8_lossy(&raw_line).into_owned();
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
                        "acp-agent-output",
                        AcpAgentOutputEvent {
                            process_id: process_id.clone(),
                            agent_id: agent_id.clone(),
                            stream,
                            line,
                        },
                    );
                }
            }
        }
    });
}

fn monitor_acp_child(
    app: tauri::AppHandle,
    processes: Arc<Mutex<HashMap<String, Arc<ManagedAcpProcess>>>>,
    managed: Arc<ManagedAcpProcess>,
) {
    thread::spawn(move || loop {
        let exited = {
            let Ok(mut guard) = managed.child.lock() else {
                break;
            };
            match guard.try_wait() {
                Ok(Some(status)) => Some(status.code()),
                Ok(None) => None,
                Err(_) => None,
            }
        };
        if let Some(code) = exited {
            let tree_unknown = managed.native_session_key.is_some()
                && !managed.native_tree_stopped.load(Ordering::Acquire);
            if tree_unknown && managed.stopping.load(Ordering::Acquire) {
                thread::sleep(Duration::from_millis(50));
                continue;
            }
            if !tree_unknown {
                if let Ok(mut map) = processes.lock() {
                    map.remove(&managed.process_id);
                }
            }
            if !managed.exit_emitted.swap(true, Ordering::AcqRel) {
                let reason = if tree_unknown {
                    Some("原 ACP 父进程已退出，尚未确认其后代进程结束；保留会话写入身份，需在原客户端核对".to_string())
                } else if managed.stopping.load(Ordering::Acquire) {
                    Some("stopped".to_string())
                } else if code != Some(0) {
                    let lines = managed
                        .recent_stderr
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
                    "acp-agent-exit",
                    AcpAgentExitEvent {
                        process_id: managed.process_id.clone(),
                        agent_id: managed.agent_id.clone(),
                        code,
                        reason,
                    },
                );
            }
            break;
        }
        thread::sleep(Duration::from_millis(50));
    });
}

#[cfg(unix)]
fn exit_signal_name(status: &ExitStatus) -> Option<String> {
    use std::os::unix::process::ExitStatusExt;
    status.signal().map(|sig| sig.to_string())
}

#[cfg(not(unix))]
fn exit_signal_name(_status: &ExitStatus) -> Option<String> {
    None
}

fn spawn_terminal_stream_reader<R: Read + Send + 'static>(
    reader: R,
    sync: Arc<(Mutex<TerminalBuffer>, Condvar)>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if let Ok(mut guard) = sync.0.lock() {
                        guard.append(&buf[..n]);
                    }
                }
            }
        }
    })
}

#[tauri::command]
pub async fn acp_agent_list(app: tauri::AppHandle) -> Result<Vec<AcpAgentProfileView>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = REGISTRY_LOCK
            .lock()
            .map_err(|_| "ACP 配置锁不可用".to_string())?;
        let path = acp_agents_file_path(&app)?;
        let profiles = read_profiles_from_path(&path)?;
        Ok(profiles.iter().map(profile_to_view).collect())
    })
    .await
    .map_err(|error| format!("读取 ACP Agent 列表失败：{error}"))?
}

#[tauri::command]
pub async fn acp_agent_discover(
    app: tauri::AppHandle,
) -> Result<Vec<AcpDiscoveredCandidate>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let registered = {
            let _guard = REGISTRY_LOCK
                .lock()
                .map_err(|_| "ACP 配置锁不可用".to_string())?;
            let path = acp_agents_file_path(&app)?;
            read_profiles_from_path(&path)?
        };

        let search_dirs = well_known_agent_search_dirs();
        let candidates = thread::scope(|scope| {
            let handles = KNOWN_ACP_PRESETS
                .iter()
                .map(|family| {
                    let registered_ref = &registered;
                    let search_dirs_ref = &search_dirs;
                    scope.spawn(move || {
                        for candidate in family.candidates {
                            let Some(program_path) =
                                resolve_executable_in_dirs(candidate.command, search_dirs_ref)
                            else {
                                continue;
                            };
                            let resolved_path = host_path(&program_path);
                            let version = probe_agent_version(
                                &program_path,
                                candidate.command,
                                PROBE_TIMEOUT,
                            );
                            let already_registered = registered_ref.iter().any(|profile| {
                                profile.preset == family.preset
                                    || profile.command == candidate.command
                                    || profile.command == resolved_path
                            });
                            return Some(AcpDiscoveredCandidate {
                                preset: family.preset.to_string(),
                                name: candidate.name.to_string(),
                                command: candidate.command.to_string(),
                                args: candidate.args.iter().map(|s| (*s).to_string()).collect(),
                                resolved_path,
                                version,
                                already_registered,
                            });
                        }
                        None
                    })
                })
                .collect::<Vec<_>>();

            handles
                .into_iter()
                .filter_map(|handle| handle.join().ok().flatten())
                .collect::<Vec<_>>()
        });
        Ok(candidates)
    })
    .await
    .map_err(|error| format!("发现本地 ACP Agent 失败：{error}"))?
}

#[tauri::command]
pub async fn acp_agent_upsert(
    app: tauri::AppHandle,
    input: AcpAgentUpsertInput,
) -> Result<AcpAgentProfileView, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = REGISTRY_LOCK
            .lock()
            .map_err(|_| "ACP 配置锁不可用".to_string())?;
        let path = acp_agents_file_path(&app)?;
        upsert_profile_at_path(&path, input)
    })
    .await
    .map_err(|error| format!("保存 ACP Agent 失败：{error}"))?
}

#[tauri::command]
pub async fn acp_agent_delete(app: tauri::AppHandle, agent_id: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = REGISTRY_LOCK
            .lock()
            .map_err(|_| "ACP 配置锁不可用".to_string())?;
        let path = acp_agents_file_path(&app)?;
        delete_profile_at_path(&path, agent_id.trim())
    })
    .await
    .map_err(|error| format!("删除 ACP Agent 失败：{error}"))?
}

#[tauri::command]
pub async fn acp_agent_probe(
    app: tauri::AppHandle,
    agent_id: String,
) -> Result<AcpAgentProbeResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let profiles = {
            let _guard = REGISTRY_LOCK
                .lock()
                .map_err(|_| "ACP 配置锁不可用".to_string())?;
            let path = acp_agents_file_path(&app)?;
            read_profiles_from_path(&path)?
        };
        let Some(profile) = profiles.into_iter().find(|p| p.id == agent_id) else {
            return Err("ACP Agent 配置不存在".to_string());
        };
        if !profile.enabled {
            return Ok(AcpAgentProbeResult {
                agent_id: profile.id,
                ready: false,
                resolved_path: None,
                version: None,
                reason: Some("该 ACP Agent 已被禁用".to_string()),
            });
        }
        let Some(resolved) = resolve_acp_executable(&profile.command) else {
            return Ok(AcpAgentProbeResult {
                agent_id: profile.id,
                ready: false,
                resolved_path: None,
                version: None,
                reason: Some(format!("未找到可执行命令：{}", profile.command)),
            });
        };
        let resolved_host = host_path(&resolved);
        let version = probe_agent_version(&resolved, &profile.command, PROBE_TIMEOUT);
        if let Some((adapter, _)) = extract_bridge_adapter(&profile.args) {
            let Some(node) = resolve_node_executable() else {
                return Ok(AcpAgentProbeResult {
                    agent_id: profile.id,
                    ready: false,
                    resolved_path: Some(resolved_host),
                    version,
                    reason: Some(
                        "运行 ACP 桥接适配器需要本地 Node.js，但未找到 node 可执行文件".to_string(),
                    ),
                });
            };
            if adapter == "antigravity" {
                let bridge = ensure_acp_bridge_script(&app)?;
                let mut command = hidden_command(host_path(&node));
                command
                    .arg(host_path(&bridge))
                    .args(["--adapter", "antigravity", "--bin"])
                    .arg(&resolved_host)
                    .arg("--probe")
                    .envs(&profile.env);
                if let Err(reason) = probe_antigravity_connection(command) {
                    return Ok(AcpAgentProbeResult {
                        agent_id: profile.id,
                        ready: false,
                        resolved_path: Some(resolved_host),
                        version,
                        reason: Some(reason),
                    });
                }
            }
        }
        Ok(AcpAgentProbeResult {
            agent_id: profile.id,
            ready: true,
            resolved_path: Some(resolved_host),
            version,
            reason: None,
        })
    })
    .await
    .map_err(|error| format!("探测 ACP Agent 失败：{error}"))?
}

#[tauri::command]
pub async fn acp_process_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, AcpSupervisorState>,
    agent_id: String,
    workspace_root: String,
    native_resume: Option<crate::local_sessions::NativeResumeAuthorization>,
) -> Result<AcpProcessInfo, String> {
    let processes = Arc::clone(&state.processes);
    let process_num = state.next_id.fetch_add(1, Ordering::Relaxed);
    let start_app = app.clone();

    let (managed, stdout, stderr) = tauri::async_runtime::spawn_blocking(move || {
        let profile = {
            let _guard = REGISTRY_LOCK
                .lock()
                .map_err(|_| "ACP 配置锁不可用".to_string())?;
            let path = acp_agents_file_path(&start_app)?;
            read_profiles_from_path(&path)?
                .into_iter()
                .find(|p| p.id == agent_id)
                .ok_or_else(|| "ACP Agent 配置不存在".to_string())?
        };
        if !profile.enabled {
            return Err("ACP Agent 已被禁用，无法启动".to_string());
        }

        let _native_start_gate = native_resume
            .as_ref()
            .map(|_| {
                crate::local_sessions::NATIVE_CODEX_START_LOCK
                    .lock()
                    .map_err(|_| "原生 Codex 启动锁不可用")
            })
            .transpose()?;

        let canonical_workspace = std::fs::canonicalize(workspace_root.trim())
            .map_err(|error| format!("ACP 工作区不可用：{error}"))?;
        if !canonical_workspace.is_dir() {
            return Err("ACP 工作区必须是目录".to_string());
        }
        let workspace_host = host_path(&canonical_workspace);

        let effective_cwd = if native_resume.is_some() {
            workspace_host.clone()
        } else if let Some(ref custom_cwd) = profile.cwd {
            let canonical_cwd = std::fs::canonicalize(custom_cwd.trim())
                .map_err(|error| format!("ACP Agent 工作目录不可用：{error}"))?;
            if !canonical_cwd.is_dir() {
                return Err("ACP Agent 工作目录必须是目录".to_string());
            }
            host_path(&canonical_cwd)
        } else {
            workspace_host.clone()
        };

        let resolved_program = resolve_acp_executable(&profile.command)
            .ok_or_else(|| format!("未找到 ACP Agent 可执行命令：{}", profile.command))?;
        let program_host = host_path(&resolved_program);

        if let Some(ref auth) = native_resume {
            crate::external_bridge::assert_no_external_cli_writer(&start_app, &auth.session_id)?;
            let root =
                codex_profile_root(&profile).ok_or("原生交接仅支持已配置的 Codex CLI 桥接")?;
            let scope = crate::local_sessions::normalized_source_scope("codex", &root);
            let key = (auth.source_scope.clone(), auth.session_id.clone());
            assert_no_live_native_writer(&start_app, &key)?;
            crate::proc::assert_no_live_native_writer(&start_app, &key)?;
            let fingerprint = codex_profile_fingerprint(&profile, &root, &resolved_program);
            if native_codex_profile(&start_app, &profile.id)?.fingerprint() != fingerprint {
                return Err("原 Codex 执行配置已变化，请重新交接".into());
            }
            crate::local_sessions::consume_native_handoff(
                auth,
                &profile.id,
                &fingerprint,
                &scope,
                &canonical_workspace,
            )?;
        }

        let mut command = if let Some((adapter, extra_args)) = extract_bridge_adapter(&profile.args)
        {
            let node_path = resolve_node_executable().ok_or_else(|| {
                "运行 ACP 桥接适配器需要本地 Node.js，但未找到 node 可执行文件".to_string()
            })?;
            let bridge_path = ensure_acp_bridge_script(&start_app)?;
            let mut bridge_cmd = hidden_command(host_path(&node_path));
            bridge_cmd
                .arg(host_path(&bridge_path))
                .arg("--adapter")
                .arg(&adapter)
                .arg("--bin")
                .arg(&program_host)
                .arg("--cwd")
                .arg(&effective_cwd);
            if let Some(ref auth) = native_resume {
                if adapter != "codex" {
                    return Err("原生 Codex 会话禁止交给其他执行器".to_string());
                }
                bridge_cmd.arg("--resume-session").arg(&auth.session_id);
            }
            if !extra_args.is_empty() {
                bridge_cmd.arg("--").args(&extra_args);
            }
            bridge_cmd
        } else {
            build_command_for_program(&resolved_program, &profile.args)
        };
        command
            .current_dir(&effective_cwd)
            .envs(&profile.env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(root) = codex_profile_root(&profile) {
            command.env("CODEX_HOME", root);
        }

        // Claim the native writer before spawning; two windows/profiles cannot resume it concurrently.
        let native_session_key = native_resume
            .as_ref()
            .map(|auth| (auth.source_scope.clone(), auth.session_id.clone()));
        let mut registered = processes
            .lock()
            .map_err(|_| "ACP 进程注册表不可用".to_string())?;
        let mut child = command
            .spawn()
            .map_err(|error| format!("启动 ACP Agent 进程失败：{error}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "ACP Agent stdin 不可用".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "ACP Agent stdout 不可用".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "ACP Agent stderr 不可用".to_string())?;

        let process_id = format!("acp-proc-{process_num}");
        let started_at = now_millis();
        let managed = Arc::new(ManagedAcpProcess {
            native_session_key,
            native_tree_stopped: AtomicBool::new(false),
            process_id: process_id.clone(),
            agent_id: profile.id,
            agent_name: profile.name,
            workspace_root: workspace_host,
            started_at,
            child: Arc::new(Mutex::new(child)),
            stdin: Arc::new(Mutex::new(stdin)),
            stopping: Arc::new(AtomicBool::new(false)),
            exit_emitted: Arc::new(AtomicBool::new(false)),
            recent_stderr: Arc::new(Mutex::new(Vec::new())),
        });

        registered.insert(process_id, Arc::clone(&managed));

        Ok::<_, String>((managed, stdout, stderr))
    })
    .await
    .map_err(|error| format!("启动 ACP Agent 任务失败：{error}"))??;

    spawn_acp_stream_reader(
        app.clone(),
        managed.process_id.clone(),
        managed.agent_id.clone(),
        "stdout",
        stdout,
        None,
    );
    spawn_acp_stream_reader(
        app.clone(),
        managed.process_id.clone(),
        managed.agent_id.clone(),
        "stderr",
        stderr,
        Some(Arc::clone(&managed.recent_stderr)),
    );
    monitor_acp_child(app, Arc::clone(&state.processes), Arc::clone(&managed));

    Ok(AcpProcessInfo {
        process_id: managed.process_id.clone(),
        agent_id: managed.agent_id.clone(),
        agent_name: managed.agent_name.clone(),
        workspace_root: managed.workspace_root.clone(),
        started_at: managed.started_at,
    })
}

#[tauri::command]
pub fn acp_process_write(
    state: tauri::State<'_, AcpSupervisorState>,
    process_id: String,
    line: String,
) -> Result<(), String> {
    let bytes = validate_acp_line(&line)?;
    let stdin = {
        let processes = state
            .processes
            .lock()
            .map_err(|_| "ACP 进程注册表不可用".to_string())?;
        let proc = processes
            .get(&process_id)
            .ok_or_else(|| "ACP Agent 进程未运行".to_string())?;
        Arc::clone(&proc.stdin)
    };
    let mut stdin = stdin
        .lock()
        .map_err(|_| "ACP Agent stdin 不可用".to_string())?;
    stdin
        .write_all(&bytes)
        .and_then(|_| stdin.flush())
        .map_err(|error| format!("向 ACP Agent 发送消息失败：{error}"))
}

#[tauri::command]
pub fn acp_process_stop(
    state: tauri::State<'_, AcpSupervisorState>,
    process_id: String,
) -> Result<(), String> {
    let _start_gate = crate::local_sessions::NATIVE_CODEX_START_LOCK
        .lock()
        .map_err(|_| "原生 Codex 启动锁不可用")?;
    let proc = state
        .processes
        .lock()
        .map_err(|_| "ACP 进程注册表不可用".to_string())?
        .get(&process_id)
        .cloned();
    let Some(proc) = proc else {
        return Ok(());
    };
    proc.stopping.store(true, Ordering::Release);
    let mut child = proc.child.lock().map_err(|_| "ACP 进程状态不可用")?;
    let stopped = if proc.native_session_key.is_some() {
        kill_owned_tree_and_wait(&mut child, OWNED_TREE_STOP_TIMEOUT)
    } else {
        kill_and_wait(&mut child)
    };
    if stopped.is_err() {
        proc.stopping.store(false, Ordering::Release);
        return Err("尚未确认 ACP 执行进程树已结束，保留会话写入身份；请在原客户端核对".into());
    }
    proc.native_tree_stopped.store(true, Ordering::Release);
    drop(child);
    state
        .processes
        .lock()
        .map_err(|_| "ACP 进程注册表不可用")?
        .remove(&process_id);
    Ok(())
}

#[tauri::command]
pub fn acp_process_list(
    state: tauri::State<'_, AcpSupervisorState>,
) -> Result<Vec<AcpProcessInfo>, String> {
    let mut processes = state
        .processes
        .lock()
        .map_err(|_| "ACP 进程注册表不可用".to_string())?;
    processes.retain(|_, proc| {
        if proc.native_session_key.is_some() && !proc.native_tree_stopped.load(Ordering::Acquire) {
            return true;
        }
        proc.child
            .lock()
            .ok()
            .and_then(|mut c| c.try_wait().ok())
            .map(|status| status.is_none())
            .unwrap_or(true)
    });
    let mut list = processes
        .values()
        .map(|proc| AcpProcessInfo {
            process_id: proc.process_id.clone(),
            agent_id: proc.agent_id.clone(),
            agent_name: proc.agent_name.clone(),
            workspace_root: proc.workspace_root.clone(),
            started_at: proc.started_at,
        })
        .collect::<Vec<_>>();
    list.sort_by_key(|item| item.started_at);
    Ok(list)
}

#[tauri::command]
pub fn acp_fs_read_text_file(
    workspace_root: String,
    path: String,
    line: Option<u32>,
    limit: Option<u32>,
) -> Result<String, String> {
    let (_root, target) = resolve_workspace_scoped_path(&workspace_root, &path, true)?;
    if !target.is_file() {
        return Err("ACP 读取目标必须是文件".to_string());
    }
    let content =
        std::fs::read_to_string(&target).map_err(|error| format!("读取文件失败：{error}"))?;
    if line.is_none() && limit.is_none() {
        return Ok(content);
    }
    let start_index = line.unwrap_or(1).saturating_sub(1) as usize;
    let take_count = limit.unwrap_or(u32::MAX) as usize;
    let sliced = content
        .lines()
        .skip(start_index)
        .take(take_count)
        .collect::<Vec<_>>()
        .join("\n");
    Ok(sliced)
}

#[tauri::command]
pub fn acp_fs_write_text_file(
    workspace_root: String,
    path: String,
    content: String,
) -> Result<(), String> {
    let (_root, target) = resolve_workspace_scoped_path(&workspace_root, &path, false)?;
    if target.is_dir() {
        return Err("ACP 写入目标不能是目录".to_string());
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("创建目标父目录失败：{error}"))?;
    }
    std::fs::write(&target, content.as_bytes()).map_err(|error| format!("写入文件失败：{error}"))
}

#[tauri::command]
pub async fn acp_terminal_create(
    state: tauri::State<'_, AcpSupervisorState>,
    workspace_root: String,
    command: String,
    args: Option<Vec<String>>,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
    output_byte_limit: Option<usize>,
) -> Result<String, String> {
    let terminals = Arc::clone(&state.terminals);
    let term_num = state.next_id.fetch_add(1, Ordering::Relaxed);

    tauri::async_runtime::spawn_blocking(move || {
        let trimmed_cmd = command.trim();
        if trimmed_cmd.is_empty() {
            return Err("终端命令不能为空".to_string());
        }
        let requested_cwd = cwd
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .unwrap_or(".");
        let (_root, resolved_cwd) =
            resolve_workspace_scoped_path(&workspace_root, requested_cwd, true)?;
        if !resolved_cwd.is_dir() {
            return Err("终端工作目录必须是目录".to_string());
        }
        let cwd_host = host_path(&resolved_cwd);

        let effective_cmd = resolve_acp_executable(trimmed_cmd)
            .or_else(|| {
                let candidate = Path::new(trimmed_cmd);
                if candidate.is_relative() {
                    resolve_direct_executable(&resolved_cwd.join(candidate))
                } else {
                    None
                }
            })
            .unwrap_or_else(|| PathBuf::from(trimmed_cmd));

        let arg_list = args.unwrap_or_default();
        let mut cmd = build_command_for_program(&effective_cmd, &arg_list);
        cmd.current_dir(&cwd_host)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(env_map) = env {
            for (k, v) in env_map {
                let key = k.trim();
                if !key.is_empty() && !key.contains('=') && !key.contains('\0') {
                    cmd.env(key, v);
                }
            }
        }

        let mut child = cmd
            .spawn()
            .map_err(|error| format!("启动工作区终端命令失败：{error}"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "终端 stdout 不可用".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "终端 stderr 不可用".to_string())?;

        let limit = output_byte_limit
            .unwrap_or(DEFAULT_TERMINAL_OUTPUT_BYTES)
            .min(MAX_TERMINAL_OUTPUT_BYTES);
        let sync = Arc::new((Mutex::new(TerminalBuffer::new(limit)), Condvar::new()));
        let stdout_handle = spawn_terminal_stream_reader(stdout, Arc::clone(&sync));
        let stderr_handle = spawn_terminal_stream_reader(stderr, Arc::clone(&sync));

        let child_arc = Arc::new(Mutex::new(child));
        let managed = Arc::new(ManagedAcpTerminal {
            child: Arc::clone(&child_arc),
            stdin: None,
            sync: Arc::clone(&sync),
        });

        let terminal_id = format!("acp-term-{term_num}");
        terminals
            .lock()
            .map_err(|_| "ACP 终端注册表不可用".to_string())?
            .insert(terminal_id.clone(), managed);

        thread::spawn(move || loop {
            let exited = {
                let Ok(mut guard) = child_arc.lock() else {
                    break;
                };
                match guard.try_wait() {
                    Ok(Some(status)) => Some(AcpTerminalExitStatus {
                        exit_code: status.code(),
                        signal: exit_signal_name(&status),
                    }),
                    Ok(None) => None,
                    Err(_) => Some(AcpTerminalExitStatus {
                        exit_code: None,
                        signal: None,
                    }),
                }
            };
            if let Some(status) = exited {
                let _ = stdout_handle.join();
                let _ = stderr_handle.join();
                if let Ok(mut buffer) = sync.0.lock() {
                    buffer.exit_status = Some(status);
                }
                sync.1.notify_all();
                break;
            }
            thread::sleep(Duration::from_millis(30));
        });

        Ok(terminal_id)
    })
    .await
    .map_err(|error| format!("创建 ACP 终端失败：{error}"))?
}

#[tauri::command]
pub fn acp_terminal_output(
    state: tauri::State<'_, AcpSupervisorState>,
    terminal_id: String,
) -> Result<AcpTerminalOutputSnapshot, String> {
    let terminal = {
        let terminals = state
            .terminals
            .lock()
            .map_err(|_| "ACP 终端注册表不可用".to_string())?;
        terminals
            .get(&terminal_id)
            .cloned()
            .ok_or_else(|| "ACP 终端不存在或已释放".to_string())?
    };
    let buffer = terminal
        .sync
        .0
        .lock()
        .map_err(|_| "ACP 终端缓冲区不可用".to_string())?;
    Ok(AcpTerminalOutputSnapshot {
        output: buffer.output_string(),
        truncated: buffer.truncated,
        exit_status: buffer.exit_status.clone(),
    })
}

#[tauri::command]
pub async fn acp_terminal_wait_for_exit(
    state: tauri::State<'_, AcpSupervisorState>,
    terminal_id: String,
    timeout_ms: Option<u64>,
) -> Result<AcpTerminalExitStatus, String> {
    let terminal = {
        let terminals = state
            .terminals
            .lock()
            .map_err(|_| "ACP 终端注册表不可用".to_string())?;
        terminals
            .get(&terminal_id)
            .cloned()
            .ok_or_else(|| "ACP 终端不存在或已释放".to_string())?
    };

    tauri::async_runtime::spawn_blocking(move || {
        let (lock, cvar) = &*terminal.sync;
        let mut guard = lock
            .lock()
            .map_err(|_| "ACP 终端状态锁不可用".to_string())?;
        if let Some(status) = guard.exit_status.clone() {
            return Ok(status);
        }
        let deadline = timeout_ms.map(|ms| Instant::now() + Duration::from_millis(ms));
        loop {
            if let Some(status) = guard.exit_status.clone() {
                return Ok(status);
            }
            match deadline {
                Some(limit) => {
                    let now = Instant::now();
                    if now >= limit {
                        return Err("等待终端命令退出超时".to_string());
                    }
                    let (next_guard, wait_result) = cvar
                        .wait_timeout(guard, limit - now)
                        .map_err(|_| "ACP 终端等待条件变量失败".to_string())?;
                    guard = next_guard;
                    if let Some(status) = guard.exit_status.clone() {
                        return Ok(status);
                    }
                    if wait_result.timed_out() {
                        return Err("等待终端命令退出超时".to_string());
                    }
                }
                None => {
                    guard = cvar
                        .wait(guard)
                        .map_err(|_| "ACP 终端等待条件变量失败".to_string())?;
                }
            }
        }
    })
    .await
    .map_err(|error| format!("等待终端退出任务失败：{error}"))?
}

#[tauri::command]
pub fn acp_terminal_kill(
    state: tauri::State<'_, AcpSupervisorState>,
    terminal_id: String,
) -> Result<(), String> {
    let terminal = {
        let terminals = state
            .terminals
            .lock()
            .map_err(|_| "ACP 终端注册表不可用".to_string())?;
        terminals
            .get(&terminal_id)
            .cloned()
            .ok_or_else(|| "ACP 终端不存在或已释放".to_string())?
    };
    if let Ok(mut child) = terminal.child.lock() {
        if child.try_wait().ok().flatten().is_none() {
            let _ = kill_owned_tree_and_wait(&mut child, OWNED_TREE_STOP_TIMEOUT)
                .or_else(|_| kill_and_wait(&mut child));
        }
    }
    Ok(())
}

#[tauri::command]
pub fn acp_terminal_release(
    state: tauri::State<'_, AcpSupervisorState>,
    terminal_id: String,
) -> Result<(), String> {
    let terminal = state
        .terminals
        .lock()
        .map_err(|_| "ACP 终端注册表不可用".to_string())?
        .remove(&terminal_id);
    if let Some(terminal) = terminal {
        if let Ok(mut child) = terminal.child.lock() {
            if child.try_wait().ok().flatten().is_none() {
                let _ = kill_owned_tree_and_wait(&mut child, OWNED_TREE_STOP_TIMEOUT)
                    .or_else(|_| kill_and_wait(&mut child));
            }
        }
    }
    Ok(())
}

pub fn shutdown_all_acp_processes(app: &tauri::AppHandle) {
    let Some(state) = app.try_state::<AcpSupervisorState>() else {
        return;
    };
    let Ok(_start_gate) = crate::local_sessions::NATIVE_CODEX_START_LOCK.lock() else {
        return;
    };
    let drained_procs: Vec<Arc<ManagedAcpProcess>> = state
        .processes
        .lock()
        .map(|map| map.values().cloned().collect())
        .unwrap_or_default();
    for proc in drained_procs {
        proc.stopping.store(true, Ordering::Release);
        if let Ok(mut child) = proc.child.lock() {
            let stopped = if proc.native_session_key.is_some() {
                kill_owned_tree_and_wait(&mut child, OWNED_TREE_STOP_TIMEOUT)
            } else {
                kill_and_wait(&mut child)
            };
            if stopped.is_ok() {
                proc.native_tree_stopped.store(true, Ordering::Release);
                drop(child);
                if let Ok(mut processes) = state.processes.lock() {
                    processes.remove(&proc.process_id);
                }
            } else {
                proc.stopping.store(false, Ordering::Release);
            }
        }
    }

    let drained_terms: Vec<Arc<ManagedAcpTerminal>> = state
        .terminals
        .lock()
        .map(|mut map| map.drain().map(|(_, v)| v).collect())
        .unwrap_or_default();
    for term in drained_terms {
        if let Ok(mut child) = term.child.lock() {
            if child.try_wait().ok().flatten().is_none() {
                let _ = kill_owned_tree_and_wait(&mut child, OWNED_TREE_STOP_TIMEOUT)
                    .or_else(|_| kill_and_wait(&mut child));
            }
        }
    }
}

pub(crate) fn active_acp_child_pids(app: &tauri::AppHandle) -> Vec<u32> {
    let Some(state) = app.try_state::<AcpSupervisorState>() else {
        return Vec::new();
    };
    let mut pids = Vec::new();
    if let Ok(procs) = state.processes.lock() {
        for proc in procs.values() {
            if let Ok(mut child) = proc.child.lock() {
                if child.try_wait().ok().flatten().is_none() {
                    pids.push(child.id());
                }
            }
        }
    }
    if let Ok(terms) = state.terminals.lock() {
        for term in terms.values() {
            if let Ok(mut child) = term.child.lock() {
                if child.try_wait().ok().flatten().is_none() {
                    pids.push(child.id());
                }
            }
        }
    }
    pids
}

pub(crate) fn pick_interactive_shell(
    requested: Option<&str>,
) -> Result<(PathBuf, Vec<String>), String> {
    if let Some(raw) = requested.map(str::trim).filter(|s| !s.is_empty()) {
        let lower = raw.to_ascii_lowercase();
        let allowed = matches!(
            lower.as_str(),
            "pwsh" | "powershell" | "powershell.exe" | "cmd" | "cmd.exe" | "bash" | "sh" | "zsh"
        );
        if !allowed {
            return Err("不支持的交互式终端 Shell".to_string());
        }
        let resolved = find_program(raw).unwrap_or_else(|| PathBuf::from(raw));
        let args = if lower.contains("pwsh") || lower.contains("powershell") {
            vec![
                "-NoLogo".to_string(),
                "-NoExit".to_string(),
                "-Command".to_string(),
                "-".to_string(),
            ]
        } else if lower.contains("cmd") {
            vec!["/Q".to_string()]
        } else {
            Vec::new()
        };
        return Ok((resolved, args));
    }

    #[cfg(windows)]
    {
        if let Some(pwsh) = find_program("pwsh.exe").or_else(|| find_program("pwsh")) {
            return Ok((
                pwsh,
                vec![
                    "-NoLogo".to_string(),
                    "-NoExit".to_string(),
                    "-Command".to_string(),
                    "-".to_string(),
                ],
            ));
        }
        if let Some(ps) = find_program("powershell.exe") {
            return Ok((
                ps,
                vec![
                    "-NoLogo".to_string(),
                    "-NoExit".to_string(),
                    "-Command".to_string(),
                    "-".to_string(),
                ],
            ));
        }
        let cmd = find_program("cmd.exe").unwrap_or_else(|| PathBuf::from("cmd.exe"));
        Ok((cmd, vec!["/Q".to_string()]))
    }

    #[cfg(not(windows))]
    {
        let fallback_env = std::env::var("SHELL")
            .ok()
            .filter(|s| s.ends_with("/bash") || s.ends_with("/zsh") || s.ends_with("/sh"));
        if let Some(shell_path) = fallback_env.map(PathBuf::from).filter(|p| p.is_file()) {
            return Ok((shell_path, Vec::new()));
        }
        if let Some(bash) = find_program("bash") {
            return Ok((bash, Vec::new()));
        }
        Ok((
            find_program("sh").unwrap_or_else(|| PathBuf::from("/bin/sh")),
            Vec::new(),
        ))
    }
}

#[tauri::command]
pub async fn butler_terminal_start(
    state: tauri::State<'_, AcpSupervisorState>,
    workspace_root: String,
    shell: Option<String>,
    cwd: Option<String>,
) -> Result<String, String> {
    let terminals = Arc::clone(&state.terminals);
    let term_num = state.next_id.fetch_add(1, Ordering::Relaxed);

    tauri::async_runtime::spawn_blocking(move || {
        let requested_cwd = cwd
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .unwrap_or(".");
        let (_root, resolved_cwd) =
            resolve_workspace_scoped_path(&workspace_root, requested_cwd, true)?;
        if !resolved_cwd.is_dir() {
            return Err("终端工作目录必须是目录".to_string());
        }
        let cwd_host = host_path(&resolved_cwd);
        let (shell_exe, shell_args) = pick_interactive_shell(shell.as_deref())?;
        let mut cmd = build_command_for_program(&shell_exe, &shell_args);
        cmd.current_dir(&cwd_host)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|error| format!("启动集成终端失败：{error}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "终端 stdin 不可用".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "终端 stdout 不可用".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "终端 stderr 不可用".to_string())?;

        let sync = Arc::new((
            Mutex::new(TerminalBuffer::new(DEFAULT_TERMINAL_OUTPUT_BYTES)),
            Condvar::new(),
        ));
        let stdout_handle = spawn_terminal_stream_reader(stdout, Arc::clone(&sync));
        let stderr_handle = spawn_terminal_stream_reader(stderr, Arc::clone(&sync));

        let child_arc = Arc::new(Mutex::new(child));
        let managed = Arc::new(ManagedAcpTerminal {
            child: Arc::clone(&child_arc),
            stdin: Some(Arc::new(Mutex::new(stdin))),
            sync: Arc::clone(&sync),
        });

        let terminal_id = format!("butler-term-{term_num}");
        terminals
            .lock()
            .map_err(|_| "集成终端注册表不可用".to_string())?
            .insert(terminal_id.clone(), managed);

        thread::spawn(move || loop {
            let exited = {
                let Ok(mut guard) = child_arc.lock() else {
                    break;
                };
                match guard.try_wait() {
                    Ok(Some(status)) => Some(AcpTerminalExitStatus {
                        exit_code: status.code(),
                        signal: exit_signal_name(&status),
                    }),
                    Ok(None) => None,
                    Err(_) => Some(AcpTerminalExitStatus {
                        exit_code: None,
                        signal: None,
                    }),
                }
            };
            if let Some(status) = exited {
                let _ = stdout_handle.join();
                let _ = stderr_handle.join();
                if let Ok(mut buffer) = sync.0.lock() {
                    buffer.exit_status = Some(status);
                }
                sync.1.notify_all();
                break;
            }
            thread::sleep(Duration::from_millis(30));
        });

        Ok(terminal_id)
    })
    .await
    .map_err(|error| format!("启动集成终端失败：{error}"))?
}

#[tauri::command]
pub fn butler_terminal_write(
    state: tauri::State<'_, AcpSupervisorState>,
    terminal_id: String,
    data: String,
) -> Result<(), String> {
    let terminal = {
        let terminals = state
            .terminals
            .lock()
            .map_err(|_| "集成终端注册表不可用".to_string())?;
        terminals
            .get(&terminal_id)
            .cloned()
            .ok_or_else(|| "集成终端不存在或已关闭".to_string())?
    };
    let stdin = terminal
        .stdin
        .as_ref()
        .ok_or_else(|| "该终端不支持交互输入".to_string())?;
    let mut writer = stdin.lock().map_err(|_| "终端输入流不可用".to_string())?;
    writer
        .write_all(data.as_bytes())
        .and_then(|_| writer.flush())
        .map_err(|error| format!("写入终端命令失败：{error}"))
}

#[tauri::command]
pub fn butler_terminal_output(
    state: tauri::State<'_, AcpSupervisorState>,
    terminal_id: String,
) -> Result<AcpTerminalOutputSnapshot, String> {
    acp_terminal_output(state, terminal_id)
}

#[tauri::command]
pub fn butler_terminal_kill(
    state: tauri::State<'_, AcpSupervisorState>,
    terminal_id: String,
) -> Result<(), String> {
    acp_terminal_kill(state, terminal_id)
}

#[tauri::command]
pub fn butler_terminal_release(
    state: tauri::State<'_, AcpSupervisorState>,
    terminal_id: String,
) -> Result<(), String> {
    acp_terminal_release(state, terminal_id)
}

fn score_workspace_file_match(rel: &str, query_lower: &str) -> Option<i32> {
    if query_lower.is_empty() {
        return Some(0);
    }
    let rel_lower = rel.to_ascii_lowercase();
    let basename = rel_lower.rsplit('/').next().unwrap_or(&rel_lower);
    if basename == query_lower {
        return Some(500);
    }
    if basename.starts_with(query_lower) {
        return Some(400);
    }
    if basename.contains(query_lower) {
        return Some(300);
    }
    if rel_lower.contains(query_lower) {
        return Some(200);
    }
    let mut q_chars = query_lower.chars().peekable();
    for ch in rel_lower.chars() {
        if q_chars.peek() == Some(&ch) {
            q_chars.next();
            if q_chars.peek().is_none() {
                return Some(100);
            }
        }
    }
    None
}

pub(crate) fn list_workspace_files_sync(
    workspace_root: &str,
    query: Option<&str>,
    limit: Option<usize>,
) -> Result<Vec<String>, String> {
    let (canonical_root, _) = resolve_workspace_scoped_path(workspace_root, ".", true)?;
    let max_results = limit.unwrap_or(80).clamp(1, 200);
    let query_lower = query.unwrap_or("").trim().to_ascii_lowercase();

    let mut stack: Vec<(PathBuf, usize)> = vec![(canonical_root.clone(), 0)];
    let mut collected: Vec<(i32, String)> = Vec::new();
    let mut visited = 0usize;
    const MAX_VISITED: usize = 4_000;
    const MAX_DEPTH: usize = 8;

    while let Some((dir, depth)) = stack.pop() {
        if visited >= MAX_VISITED {
            break;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            if visited >= MAX_VISITED {
                break;
            }
            visited += 1;
            let file_name = entry.file_name();
            let name = file_name.to_string_lossy();
            if matches!(
                name.as_ref(),
                ".git"
                    | "node_modules"
                    | "target"
                    | "dist"
                    | ".next"
                    | ".turbo"
                    | "build"
                    | "out"
                    | ".venv"
                    | "__pycache__"
            ) {
                continue;
            }
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_symlink() {
                continue;
            }
            let entry_path = entry.path();
            if file_type.is_dir() {
                if depth < MAX_DEPTH {
                    stack.push((entry_path, depth + 1));
                }
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            let Ok(rel_path) = entry_path.strip_prefix(&canonical_root) else {
                continue;
            };
            let rel_str = rel_path.to_string_lossy().replace('\\', "/");
            if let Some(score) = score_workspace_file_match(&rel_str, &query_lower) {
                collected.push((score, rel_str));
            }
        }
    }

    collected.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| a.1.len().cmp(&b.1.len()))
            .then_with(|| a.1.cmp(&b.1))
    });
    Ok(collected
        .into_iter()
        .take(max_results)
        .map(|(_, path)| path)
        .collect())
}

#[tauri::command]
pub async fn butler_workspace_list_files(
    workspace_root: String,
    query: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        list_workspace_files_sync(&workspace_root, query.as_deref(), limit.map(|v| v as usize))
    })
    .await
    .map_err(|error| format!("扫描工作区文件失败：{error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_test_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "rcx-acp-test-{}-{}-{}",
            name,
            std::process::id(),
            now_millis()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn native_writer_tombstone_blocks_retake_after_unexpected_parent_exit() {
        #[cfg(windows)]
        let mut command = {
            let mut command = hidden_command("cmd.exe");
            command.args(["/C", "exit 0"]);
            command
        };
        #[cfg(not(windows))]
        let mut command = {
            let mut command = hidden_command("sh");
            command.args(["-c", "exit 0"]);
            command
        };
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        child.wait().unwrap();
        let key = ("fixture-source".to_string(), "fixture-thread".to_string());
        let process = Arc::new(ManagedAcpProcess {
            native_session_key: Some(key.clone()),
            native_tree_stopped: AtomicBool::new(false),
            process_id: "fixture".into(),
            agent_id: "fixture".into(),
            agent_name: "fixture".into(),
            workspace_root: "fixture".into(),
            started_at: 0,
            child: Arc::new(Mutex::new(child)),
            stdin: Arc::new(Mutex::new(stdin)),
            stopping: Arc::new(AtomicBool::new(false)),
            exit_emitted: Arc::new(AtomicBool::new(false)),
            recent_stderr: Arc::new(Mutex::new(Vec::new())),
        });
        let processes = HashMap::from([("fixture".into(), Arc::clone(&process))]);
        assert!(assert_no_native_writer_in_processes(&processes, &key)
            .unwrap_err()
            .contains("后代"));
        assert!(assert_no_native_writer_in_processes(
            &processes,
            &("other-source".into(), "fixture-thread".into())
        )
        .is_ok());
        process.native_tree_stopped.store(true, Ordering::Release);
        assert!(assert_no_native_writer_in_processes(&processes, &key).is_ok());
    }

    #[test]
    fn native_profile_preserves_launch_configuration_and_fingerprint_tracks_edits() {
        let root = temp_test_dir("native-profile");
        let program = root.join(if cfg!(windows) { "codex.exe" } else { "codex" });
        std::fs::write(&program, b"synthetic executable; never launched").unwrap();
        let mut record: AcpAgentProfileRecord = serde_json::from_value(serde_json::json!({
            "id":"fixture-profile", "name":"Fixture", "preset":"codex-acp",
            "command": program.to_string_lossy(),
            "args":["--rocketx-acp-bridge=codex","--profile","fixture","-c","model=fixture"],
            "cwd": root.to_string_lossy(),
            "env":{"CODEX_HOME":root.to_string_lossy(),"FIXTURE_TOKEN":"synthetic-only"},
            "enabled":true,"createdAt":1,"updatedAt":2
        }))
        .unwrap();
        let profile = native_codex_profile_record(&record).unwrap();
        assert_eq!(
            profile.args,
            ["--profile", "fixture", "-c", "model=fixture"]
        );
        assert_eq!(profile.env, record.env);
        assert_eq!(profile.codex_home, root);
        let fingerprint = profile.fingerprint().to_string();
        let mut reversed = record.env.clone().into_iter().collect::<Vec<_>>();
        reversed.reverse();
        record.env = reversed.into_iter().collect();
        assert_eq!(
            native_codex_profile_record(&record).unwrap().fingerprint(),
            fingerprint
        );
        for change in 0..4 {
            let mut edited = record.clone();
            match change {
                0 => {
                    edited
                        .env
                        .insert("FIXTURE_TOKEN".into(), "different-synthetic".into());
                }
                1 => edited.args.push("--enable=fixture".into()),
                2 => edited.cwd = Some("different-workspace".into()),
                _ => edited.updated_at += 1,
            };
            assert_ne!(
                native_codex_profile_record(&edited).unwrap().fingerprint(),
                fingerprint
            );
        }
        record.args = vec!["--rocketx-acp-bridge=claude".into()];
        assert!(native_codex_profile_record(&record).is_err());
        std::fs::remove_file(program).unwrap();
        std::fs::remove_dir(root).unwrap();
    }

    #[test]
    fn profile_views_mask_secret_env_values_and_preserve_unmodified_secrets() {
        let dir = temp_test_dir("secrets");
        let file = dir.join("agents.json");

        let mut env = HashMap::new();
        env.insert(
            "ANTHROPIC_API_KEY".to_string(),
            "sk-ant-secret-123".to_string(),
        );
        env.insert("GITHUB_TOKEN".to_string(), "ghp_secret_456".to_string());

        let created = upsert_profile_at_path(
            &file,
            AcpAgentUpsertInput {
                id: Some("claude-1".to_string()),
                name: "Claude ACP".to_string(),
                preset: Some("claude-code".to_string()),
                command: "claude-code-acp".to_string(),
                args: Some(vec!["--stdio".to_string()]),
                cwd: None,
                env: Some(env),
                clear_env_keys: None,
                enabled: Some(true),
                auto_approve_safe_reads: Some(true),
                description: Some("Local Claude ACP".to_string()),
            },
        )
        .expect("create profile");

        assert_eq!(
            created.env_keys,
            vec!["ANTHROPIC_API_KEY".to_string(), "GITHUB_TOKEN".to_string()]
        );
        let serialized_view = serde_json::to_string(&created).unwrap();
        assert!(!serialized_view.contains("sk-ant-secret-123"));
        assert!(!serialized_view.contains("ghp_secret_456"));

        // Editing name/args with env: None preserves stored secret values.
        let updated = upsert_profile_at_path(
            &file,
            AcpAgentUpsertInput {
                id: Some("claude-1".to_string()),
                name: "Claude ACP Renamed".to_string(),
                preset: Some("claude-code".to_string()),
                command: "claude-code-acp".to_string(),
                args: None,
                cwd: None,
                env: None,
                clear_env_keys: None,
                enabled: Some(true),
                auto_approve_safe_reads: Some(false),
                description: None,
            },
        )
        .expect("update profile");
        assert_eq!(
            updated.env_keys,
            vec!["ANTHROPIC_API_KEY".to_string(), "GITHUB_TOKEN".to_string()]
        );

        let raw_records = read_profiles_from_path(&file).unwrap();
        assert_eq!(
            raw_records[0]
                .env
                .get("ANTHROPIC_API_KEY")
                .map(String::as_str),
            Some("sk-ant-secret-123")
        );

        // Clearing a secret via empty value removes only that key.
        let mut clear_patch = HashMap::new();
        clear_patch.insert("GITHUB_TOKEN".to_string(), String::new());
        let after_clear = upsert_profile_at_path(
            &file,
            AcpAgentUpsertInput {
                id: Some("claude-1".to_string()),
                name: "Claude ACP Renamed".to_string(),
                preset: Some("claude-code".to_string()),
                command: "claude-code-acp".to_string(),
                args: None,
                cwd: None,
                env: Some(clear_patch),
                clear_env_keys: None,
                enabled: Some(true),
                auto_approve_safe_reads: Some(false),
                description: None,
            },
        )
        .expect("clear one key");
        assert_eq!(after_clear.env_keys, vec!["ANTHROPIC_API_KEY".to_string()]);

        assert!(delete_profile_at_path(&file, "claude-1").unwrap());
        assert!(!delete_profile_at_path(&file, "claude-1").unwrap());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn workspace_scoped_fs_enforces_containment_and_rejects_parent_escapes() {
        let root = temp_test_dir("fs-scope");
        let workspace = root.join("workspace");
        let outside = root.join("outside");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.txt"), "top-secret").unwrap();

        let ws_str = workspace.to_string_lossy().to_string();

        // Valid relative write + line-sliced read
        acp_fs_write_text_file(
            ws_str.clone(),
            "nested/hello.txt".to_string(),
            "line1\nline2\nline3\nline4".to_string(),
        )
        .expect("write inside workspace");

        let full =
            acp_fs_read_text_file(ws_str.clone(), "nested/hello.txt".to_string(), None, None)
                .expect("read full file");
        assert_eq!(full, "line1\nline2\nline3\nline4");

        let sliced = acp_fs_read_text_file(
            ws_str.clone(),
            "nested/hello.txt".to_string(),
            Some(2),
            Some(2),
        )
        .expect("read sliced lines");
        assert_eq!(sliced, "line2\nline3");

        // Reject .. escape attempts for both read and write
        assert!(acp_fs_read_text_file(
            ws_str.clone(),
            "../outside/secret.txt".to_string(),
            None,
            None
        )
        .is_err());
        assert!(acp_fs_read_text_file(
            ws_str.clone(),
            "nested/../../outside/secret.txt".to_string(),
            None,
            None
        )
        .is_err());
        assert!(acp_fs_write_text_file(
            ws_str.clone(),
            "../outside/pwn.txt".to_string(),
            "x".to_string()
        )
        .is_err());

        // Reject absolute path outside workspace
        let outside_abs = outside.join("secret.txt").to_string_lossy().to_string();
        assert!(acp_fs_read_text_file(ws_str.clone(), outside_abs.clone(), None, None).is_err());
        assert!(acp_fs_write_text_file(ws_str, outside_abs, "x".to_string()).is_err());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn line_validation_and_terminal_ring_buffer_handle_limits() {
        assert_eq!(
            validate_acp_line(r#"{"jsonrpc":"2.0","id":1}"#).unwrap(),
            b"{\"jsonrpc\":\"2.0\",\"id\":1}\n"
        );
        assert!(validate_acp_line("").is_err());
        assert!(validate_acp_line("a\nb").is_err());
        let oversized = "x".repeat(MAX_ACP_LINE_BYTES + 1);
        assert!(validate_acp_line(&oversized).is_err());

        let mut buf = TerminalBuffer::new(5);
        buf.append(b"abc");
        assert!(!buf.truncated);
        assert_eq!(buf.output_string(), "abc");
        buf.append(b"defg");
        assert!(buf.truncated);
        assert_eq!(buf.output_string(), "cdefg");
    }

    #[test]
    fn probe_program_version_never_hangs_on_slow_binary() {
        assert!(resolve_acp_executable("definitely-nonexistent-acp-binary-xyz-999").is_none());

        #[cfg(windows)]
        let (program, args) = (Path::new("cmd.exe"), ["/C", "ping 127.0.0.1 -n 10 > nul"]);
        #[cfg(not(windows))]
        let (program, args) = (Path::new("sh"), ["-c", "sleep 10"]);

        let start = Instant::now();
        let mut child = hidden_command(program)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn slow process");
        let exited = wait_for_exit(
            &mut child,
            Duration::from_millis(80),
            Duration::from_millis(10),
        )
        .expect("wait_for_exit");
        assert!(exited.is_none());
        let status = kill_and_wait(&mut child).expect("kill_and_wait");
        assert!(!status.success());
        assert!(start.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn antigravity_probe_requires_explicit_success_and_preserves_connection_reason() {
        let node = resolve_node_executable().expect("Node is required for ACP bridge tests");
        for (script, expected) in [
            ("process.stdout.write(JSON.stringify({ready:true}))", true),
            ("process.stdout.write(JSON.stringify({ready:false}))", false),
            ("process.stdout.write('installed')", false),
            (
                "process.stdout.write(JSON.stringify({ready:true}));process.exitCode=1",
                false,
            ),
        ] {
            let mut command = hidden_command(host_path(&node));
            command.args(["-e", script]);
            assert_eq!(probe_antigravity_connection(command).is_ok(), expected);
        }
        let mut command = hidden_command(host_path(&node));
        command.args([
            "-e",
            "process.stderr.write('Antigravity connection unavailable');process.exitCode=1",
        ]);
        assert_eq!(
            probe_antigravity_connection(command).unwrap_err(),
            "Antigravity connection unavailable"
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_shim_resolution_prefers_cmd_over_extensionless_file() {
        let root = temp_test_dir("win-shim");
        let bin_dir = root.join("npm");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let shim_no_ext = bin_dir.join("codex");
        let cmd_shim = bin_dir.join("codex.cmd");
        std::fs::write(&shim_no_ext, "#!/bin/sh\necho shim\n").unwrap();
        std::fs::write(&cmd_shim, "@echo off\r\necho 0.165.0\r\n").unwrap();

        // Direct path to extensionless shim upgrades to .cmd sibling instead of failing CreateProcess
        let direct_resolved = resolve_executable_in_dirs(
            &shim_no_ext.to_string_lossy(),
            std::slice::from_ref(&bin_dir),
        )
        .expect("upgrade extensionless shim to .cmd");
        assert_eq!(direct_resolved, cmd_shim);

        // Directory scan skips extensionless file and picks .cmd
        let scanned =
            resolve_executable_in_dirs("codex-only-dir-check", std::slice::from_ref(&bin_dir));
        assert!(scanned.is_none());
        std::fs::write(bin_dir.join("codex-only-dir-check"), "#!/bin/sh\n").unwrap();
        assert!(
            resolve_executable_in_dirs("codex-only-dir-check", std::slice::from_ref(&bin_dir))
                .is_none()
        );

        let only_cmd = bin_dir.join("customcli.cmd");
        std::fs::write(bin_dir.join("customcli"), "#!/bin/sh\n").unwrap();
        std::fs::write(&only_cmd, "@echo off\r\necho ok\r\n").unwrap();
        assert_eq!(
            resolve_executable_in_dirs("customcli", std::slice::from_ref(&bin_dir)).unwrap(),
            only_cmd
        );

        let exe_and_cmd = bin_dir.join("dualcli.exe");
        std::fs::write(&exe_and_cmd, "mz").unwrap();
        std::fs::write(bin_dir.join("dualcli.cmd"), "@echo off\r\n").unwrap();
        assert_eq!(
            resolve_executable_in_dirs("dualcli", std::slice::from_ref(&bin_dir)).unwrap(),
            exe_and_cmd
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn well_known_agent_search_dirs_includes_expected_locations() {
        let dirs = well_known_agent_search_dirs();
        assert!(!dirs.is_empty());
        let joined = dirs
            .iter()
            .map(|p| p.to_string_lossy().to_ascii_lowercase())
            .collect::<Vec<_>>();
        #[cfg(windows)]
        {
            if std::env::var_os("APPDATA").is_some() {
                assert!(joined.iter().any(|p| p.ends_with("\\npm")));
            }
            if std::env::var_os("LOCALAPPDATA").is_some() {
                assert!(joined.iter().any(|p| p.contains("antigravity")));
            }
        }
        #[cfg(not(windows))]
        {
            assert!(joined
                .iter()
                .any(|p| p.ends_with("/usr/local/bin") || p.ends_with("/.local/bin")));
        }
    }

    #[test]
    fn read_antigravity_version_reads_ancestor_version_file() {
        let root = temp_test_dir("ag-ver");
        let ag_root = root.join("Programs").join("Antigravity");
        let bin_dir = ag_root.join("resources").join("bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        std::fs::write(ag_root.join("version"), "44.9.1\n").unwrap();
        let fake_bin = bin_dir.join("language_server.exe");
        std::fs::write(&fake_bin, "").unwrap();

        let version = read_antigravity_version_for_binary(&fake_bin);
        assert_eq!(version.as_deref(), Some("Antigravity 44.9.1"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn extract_bridge_adapter_parses_bridge_flag_and_extra_args() {
        let args = vec![
            "--model".to_string(),
            "gpt-5".to_string(),
            "--rocketx-acp-bridge=codex".to_string(),
            "--sandbox".to_string(),
            "workspace-write".to_string(),
        ];
        let parsed = extract_bridge_adapter(&args).expect("bridge adapter detected");
        assert_eq!(parsed.0, "codex");
        assert_eq!(
            parsed.1,
            vec![
                "--model".to_string(),
                "gpt-5".to_string(),
                "--sandbox".to_string(),
                "workspace-write".to_string(),
            ]
        );

        let native = vec!["acp".to_string()];
        assert!(extract_bridge_adapter(&native).is_none());

        let blank_adapter = vec!["--rocketx-acp-bridge=   ".to_string()];
        assert!(extract_bridge_adapter(&blank_adapter).is_none());
    }

    #[test]
    fn resolve_workspace_scoped_path_rejects_filesystem_root() {
        #[cfg(windows)]
        let root = std::env::var("SystemDrive")
            .map(|drive| format!("{drive}\\"))
            .unwrap_or_else(|_| "C:\\".to_string());
        #[cfg(not(windows))]
        let root = "/".to_string();

        let err = resolve_workspace_scoped_path(&root, "README.md", false).unwrap_err();
        assert!(err.contains("根目录"));
    }

    #[test]
    fn list_workspace_files_skips_vendor_dirs_and_ranks_matches() {
        let root = temp_test_dir("list-files");
        std::fs::create_dir_all(root.join("src").join("components")).unwrap();
        std::fs::create_dir_all(root.join("node_modules").join("pkg")).unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(
            root.join("src")
                .join("components")
                .join("ButlerTerminal.tsx"),
            "",
        )
        .unwrap();
        std::fs::write(root.join("src").join("main.ts"), "").unwrap();
        std::fs::write(
            root.join("node_modules")
                .join("pkg")
                .join("ButlerTerminal.tsx"),
            "",
        )
        .unwrap();
        std::fs::write(root.join(".git").join("HEAD"), "").unwrap();

        let all = list_workspace_files_sync(&host_path(&root), None, None).unwrap();
        assert!(all.contains(&"src/components/ButlerTerminal.tsx".to_string()));
        assert!(all.contains(&"src/main.ts".to_string()));
        assert!(!all
            .iter()
            .any(|p| p.contains("node_modules") || p.contains(".git")));

        let matched =
            list_workspace_files_sync(&host_path(&root), Some("ButlerTerm"), Some(10)).unwrap();
        assert_eq!(
            matched,
            vec!["src/components/ButlerTerminal.tsx".to_string()]
        );

        let _ = std::fs::remove_dir_all(&root);
    }
}
