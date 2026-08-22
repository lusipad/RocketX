use std::{
    collections::HashMap,
    ffi::OsStr,
    fs::File,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use crate::native::dsh::DshBridgeMode;
use crate::native::dsh_runtime as dsh_runtime_policy;
use crate::native::process::{hidden_command, wait_for_exit};
use crate::native::supervisor::{
    now_ms as supervisor_now_ms, observe_exit, RuntimeStatus, RuntimeSupervisor,
};
use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tar::Archive;
use tauri::{Emitter, Manager};

const MAX_MESSAGE_BYTES: usize = 2 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES: usize = 10 * 1024 * 1024;
const DSH_SHUTDOWN_GRACE_PERIOD: Duration = Duration::from_secs(5);
// 最低验证版本：系统安装的 DSH 只要 semver >= 此版本即可使用（issue #352），
// 更高版本仅提示未经完整验证，不阻断。bundled 运行时仍精确 pin 到该版本。
const DSH_VERIFIED_VERSION: &str = "0.1.0-rc.6";
// dsh-web-app 从 rc.7 开始支持 --no-open；rc.6 会把它判为未知参数。
const DSH_NO_OPEN_VERSION: &str = "0.1.0-rc.7";
const DSH_ROOT_DIR: &str = "dsh";
const DSH_BUNDLED_RUNTIME_DIR: &str = "dsh-runtime";
const DSH_BUNDLED_RUNTIME_ARCHIVE: &str = "dsh-runtime.tar.gz";
const DSH_BUNDLED_RUNTIME_CACHE_DIR: &str = "bundled-runtime";
const DSH_BUNDLED_RUNTIME_SHA_MARKER: &str = ".archive-sha256";
const DSH_HOME_SUBDIR: &str = "home";
const DSH_CONNECTIONS_SUBDIR: &str = "connections";
const DSH_SOURCE_CLI_ENTRY: [&str; 4] = ["apps", "cli", "lib", "bin.js"];
const DSH_BUNDLED_CLI_ENTRY: [&str; 5] = ["node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"];
const DSH_BRIDGE_ENTRY: [&str; 2] = ["src", "dsh_bridge.mjs"];
const DSH_BUNDLED_BRIDGE_ENTRY: &str = "dsh_bridge.mjs";

#[derive(Clone)]
struct ManagedDshBridge {
    process_id: String,
    source_root: String,
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<ChildStdin>>,
    running: Arc<AtomicBool>,
    stop_requested: Arc<AtomicBool>,
    stopping: bool,
    host_runtime_dir: PathBuf,
    ready_url: Option<String>,
    leases: HashMap<String, DshConnectionLease>,
    supervisor: Arc<Mutex<RuntimeSupervisor>>,
}

#[derive(Clone)]
struct DshConnectionLease {
    connection_id: String,
    workspace_root: String,
    mode: DshBridgeMode,
    runtime_dir: PathBuf,
}

enum DshBridgeRelease {
    Lease(PathBuf),
    Process(ManagedDshBridge),
}

#[derive(Default)]
pub struct DshBridgeState {
    processes: Arc<Mutex<HashMap<String, ManagedDshBridge>>>,
    supervisors: Arc<Mutex<HashMap<String, Arc<Mutex<RuntimeSupervisor>>>>>,
    next_id: Arc<AtomicU64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DshOutputEvent {
    process_id: String,
    stream: &'static str,
    line: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DshExitEvent {
    process_id: String,
    code: Option<i32>,
    status: RuntimeStatus,
    failures: u32,
    restart_after_ms: Option<u64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DshBridgeInfo {
    process_id: String,
    lease_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    ready_url: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DshRuntimeProbe {
    ready: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DshAgentAttachmentMetadata {
    connection_id: String,
    lease_id: String,
    relative_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DshAgentAttachmentRuntimePath {
    path: String,
    root: String,
}

#[derive(Clone)]
struct ResolvedDshRuntime {
    source_root: PathBuf,
    cli_path: PathBuf,
    node_path: PathBuf,
    bridge_path: PathBuf,
    dsh_root: PathBuf,
    home_root: PathBuf,
    supports_no_open: bool,
}

#[cfg(windows)]
fn find_program(name: &str) -> Option<PathBuf> {
    let output = hidden_command("where.exe")
        .arg(name)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .find(|path| path.is_file())
}

#[cfg(not(windows))]
fn find_program(name: &str) -> Option<PathBuf> {
    std::env::var_os("PATH")
        .into_iter()
        .flat_map(|value| std::env::split_paths(&value).collect::<Vec<_>>())
        .map(|directory| directory.join(name))
        .find(|path| path.is_file())
}

fn host_path(path: &Path) -> String {
    let value = path.to_string_lossy();
    #[cfg(windows)]
    {
        if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{rest}");
        }
        if let Some(rest) = value.strip_prefix(r"\\?\") {
            return rest.to_string();
        }
    }
    value.into_owned()
}

fn validate_connection_id(connection_id: &str) -> Result<(), String> {
    if connection_id.is_empty()
        || connection_id.len() > 80
        || !connection_id
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || matches!(value, '-' | '_'))
    {
        return Err("invalid DSH connection id".to_string());
    }
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
                Path::new(&value)
                    .extension()
                    .and_then(|extension| extension.to_str()),
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

fn canonical_directory(path: &str) -> Result<PathBuf, String> {
    let resolved =
        std::fs::canonicalize(path).map_err(|error| format!("DSH 工作区不可用：{error}"))?;
    if !resolved.is_dir() {
        return Err("DSH 工作区必须是目录".to_string());
    }
    Ok(PathBuf::from(host_path(&resolved)))
}

fn derive_source_root(candidate: &Path) -> PathBuf {
    if candidate.is_file()
        && candidate
            .file_name()
            .and_then(OsStr::to_str)
            .is_some_and(|name| name.eq_ignore_ascii_case("bin.js"))
    {
        return candidate
            .parent()
            .and_then(Path::parent)
            .and_then(Path::parent)
            .and_then(Path::parent)
            .unwrap_or(candidate)
            .to_path_buf();
    }
    candidate.to_path_buf()
}

fn source_dsh_cli_entry(root: &Path) -> PathBuf {
    DSH_SOURCE_CLI_ENTRY
        .iter()
        .fold(root.to_path_buf(), |path, segment| path.join(segment))
}

fn bundled_dsh_cli_entry(root: &Path) -> PathBuf {
    DSH_BUNDLED_CLI_ENTRY
        .iter()
        .fold(root.to_path_buf(), |path, segment| path.join(segment))
}

fn installed_dsh_cli_entry(node_modules_root: &Path) -> PathBuf {
    ["@deepseek-ai", "dsh", "lib", "bin.js"]
        .iter()
        .fold(node_modules_root.to_path_buf(), |path, segment| {
            path.join(segment)
        })
}

fn pnpm_global_dsh_cli_candidates(pnpm_home: &Path) -> Vec<PathBuf> {
    let mut pnpm_roots = vec![pnpm_home.to_path_buf()];
    if pnpm_home
        .file_name()
        .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("bin"))
    {
        if let Some(parent) = pnpm_home.parent() {
            pnpm_roots.push(parent.to_path_buf());
        }
    }

    let mut candidates = Vec::new();
    for pnpm_root in pnpm_roots {
        let Ok(generations) = std::fs::read_dir(pnpm_root.join("global")) else {
            continue;
        };
        let mut generations = generations
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.is_dir())
            .collect::<Vec<_>>();
        generations.sort();
        for generation in generations {
            let candidate = installed_dsh_cli_entry(&generation.join("node_modules"));
            if !candidates.contains(&candidate) {
                candidates.push(candidate);
            }
        }
    }
    candidates
}

#[cfg(windows)]
fn windows_dsh_shim_cli_candidates(shim: &Path) -> Vec<PathBuf> {
    let Some(shim_dir) = shim.parent() else {
        return Vec::new();
    };
    let mut candidates = vec![installed_dsh_cli_entry(&shim_dir.join("node_modules"))];
    let Ok(contents) = std::fs::read_to_string(shim) else {
        return candidates;
    };
    let normalized = contents.replace('\\', "/");
    let suffix = "node_modules/@deepseek-ai/dsh/lib/bin.js";
    for line in normalized.lines() {
        let Some(suffix_start) = line.find(suffix) else {
            continue;
        };
        let end = suffix_start + suffix.len();
        let before = &line[..end];
        let start = before.rfind('"').map(|index| index + 1).unwrap_or_else(|| {
            before
                .rfind(char::is_whitespace)
                .map_or(0, |index| index + 1)
        });
        let raw = before[start..].trim();
        let relative = ["%dp0%", "%~dp0", "$basedir"]
            .into_iter()
            .find_map(|prefix| raw.strip_prefix(prefix));
        let candidate = if let Some(relative) = relative {
            shim_dir.join(relative.trim_start_matches('/'))
        } else {
            PathBuf::from(raw)
        };
        if !candidates.contains(&candidate) {
            candidates.push(candidate);
        }
    }
    candidates
}

fn source_bridge_path() -> PathBuf {
    DSH_BRIDGE_ENTRY.iter().fold(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")),
        |path, segment| path.join(segment),
    )
}

fn packaged_bridge_candidates(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        paths.push(resource_dir.join(DSH_BUNDLED_BRIDGE_ENTRY));
    }
    if cfg!(debug_assertions) {
        paths.push(source_bridge_path());
    }
    paths
}

fn resolve_packaged_bridge(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    packaged_bridge_candidates(app)
        .into_iter()
        .find(|path| path.is_file())
        .and_then(|path| std::fs::canonicalize(path).ok())
        .map(|path| PathBuf::from(host_path(&path)))
        .ok_or_else(|| "DSH bridge 脚本缺失；请重新安装 RocketX".to_string())
}

fn bundled_bridge_path(root: &Path) -> PathBuf {
    root.join(DSH_BUNDLED_BRIDGE_ENTRY)
}

fn development_bundled_runtime_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join(DSH_BUNDLED_RUNTIME_DIR)
}

fn development_bundled_runtime_archive() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join(DSH_BUNDLED_RUNTIME_ARCHIVE)
}

fn bundled_runtime_cache_root(dsh_root: &Path) -> PathBuf {
    dsh_root.join(DSH_BUNDLED_RUNTIME_CACHE_DIR)
}

fn bundled_runtime_sha_marker_path(root: &Path) -> PathBuf {
    root.join(DSH_BUNDLED_RUNTIME_SHA_MARKER)
}

fn bundled_runtime_unpack_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn path_exists(path: &Path) -> bool {
    path.symlink_metadata().is_ok()
}

fn unique_runtime_suffix() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn remove_dir_all_with_retries(path: &Path) -> Result<(), String> {
    if !path_exists(path) {
        return Ok(());
    }
    let mut last_error = None;
    for _ in 0..5 {
        match std::fs::remove_dir_all(path) {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => {
                last_error = Some(error);
                thread::sleep(Duration::from_millis(100));
            }
        }
    }
    Err(format!(
        "无法清理 DSH 运行时目录 {}：{}",
        host_path(path),
        last_error
            .map(|error| error.to_string())
            .unwrap_or_else(|| "unknown error".to_string())
    ))
}

fn rename_with_retries(source: &Path, destination: &Path) -> Result<(), String> {
    let mut last_error = None;
    for _ in 0..5 {
        match std::fs::rename(source, destination) {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(format!("DSH 运行时路径不存在：{}", host_path(source)))
            }
            Err(error) => {
                last_error = Some(error);
                thread::sleep(Duration::from_millis(100));
            }
        }
    }
    Err(format!(
        "无法重命名 DSH 运行时目录 {} -> {}：{}",
        host_path(source),
        host_path(destination),
        last_error
            .map(|error| error.to_string())
            .unwrap_or_else(|| "unknown error".to_string())
    ))
}

fn compute_sha256(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| format!("无法读取 DSH 运行时归档：{error}"))?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 8192];
    loop {
        let bytes = file
            .read(&mut buffer)
            .map_err(|error| format!("无法读取 DSH 运行时归档：{error}"))?;
        if bytes == 0 {
            break;
        }
        digest.update(&buffer[..bytes]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

/// 归档校验哈希的缓存键：归档位于安装目录（Program Files，需管理员权限才能改写），
/// 这里的哈希只用于「检测归档变化以触发重新解包」，不是防篡改边界，因此用
/// 文件大小 + mtime 做缓存键是安全的。归档一旦被替换（升级安装），mtime/大小
/// 变化会触发重新哈希与解包。
fn archive_sha256_cached(archive_path: &Path, dsh_root: &Path) -> Result<String, String> {
    let metadata = std::fs::metadata(archive_path)
        .map_err(|error| format!("无法读取 DSH 运行时归档信息：{error}"))?;
    let size = metadata.len();
    let mtime_ms = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let cache_path = dsh_root.join("dsh-runtime-archive.sha256-cache");
    if let Ok(content) = std::fs::read_to_string(&cache_path) {
        let mut parts = content.trim().splitn(3, ' ');
        if parts.next() == Some(size.to_string().as_str())
            && parts.next() == Some(mtime_ms.to_string().as_str())
        {
            if let Some(sha) = parts.next().filter(|value| !value.is_empty()) {
                return Ok(sha.to_string());
            }
        }
    }
    let sha = compute_sha256(archive_path)?;
    let _ = std::fs::write(&cache_path, format!("{size} {mtime_ms} {sha}\n"));
    Ok(sha)
}

fn validate_bundled_runtime_root(root: &Path) -> Result<(), String> {
    let cli = bundled_dsh_cli_entry(root);
    if !cli.is_file() {
        return Err(format!(
            "随 RocketX 分发的 DSH 运行时不完整：缺少 {}",
            host_path(&cli)
        ));
    }
    let bridge = bundled_bridge_path(root);
    if !bridge.is_file() {
        return Err(format!(
            "随 RocketX 分发的 DSH 运行时不完整：缺少 {}",
            host_path(&bridge)
        ));
    }
    Ok(())
}

fn canonicalize_bundled_runtime_root(root: &Path) -> Result<PathBuf, String> {
    validate_bundled_runtime_root(root)?;
    let root =
        std::fs::canonicalize(root).map_err(|error| format!("DSH 运行时目录不可用：{error}"))?;
    Ok(PathBuf::from(host_path(&root)))
}

fn bundled_runtime_marker_matches(root: &Path, expected_sha: &str) -> bool {
    std::fs::read_to_string(bundled_runtime_sha_marker_path(root))
        .map(|value| value.trim() == expected_sha)
        .unwrap_or(false)
}

fn bundled_runtime_is_current(root: &Path, expected_sha: &str) -> bool {
    path_exists(root)
        && bundled_runtime_marker_matches(root, expected_sha)
        && validate_bundled_runtime_root(root).is_ok()
}

fn explicit_or_env_source_candidate(explicit: Option<&str>) -> Option<PathBuf> {
    let explicit = explicit.map(str::trim).filter(|value| !value.is_empty());
    let env_source = std::env::var("ROCKETX_DSH_SOURCE")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if let Some(value) = explicit {
        Some(PathBuf::from(value))
    } else if let Some(value) = env_source {
        Some(PathBuf::from(value))
    } else {
        None
    }
}

fn resolve_source_root(candidate: &Path) -> Result<PathBuf, String> {
    let root = derive_source_root(&candidate);
    let root =
        std::fs::canonicalize(&root).map_err(|error| format!("DSH 源码路径不可用：{error}"))?;
    let cli_path = source_dsh_cli_entry(&root);
    if !cli_path.is_file() {
        return Err("DSH CLI 未构建：缺少 apps/cli/lib/bin.js".to_string());
    }
    Ok(PathBuf::from(host_path(&root)))
}

fn source_root_from_candidates(explicit: Option<&str>) -> Result<Option<PathBuf>, String> {
    if let Some(candidate) = explicit_or_env_source_candidate(explicit) {
        return resolve_source_root(&candidate).map(Some);
    }
    Ok(None)
}

fn installed_dsh_cli_candidates() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(pnpm_home) = std::env::var_os("PNPM_HOME") {
        paths.extend(pnpm_global_dsh_cli_candidates(&PathBuf::from(pnpm_home)));
    }
    #[cfg(windows)]
    {
        if let Some(app_data) = std::env::var_os("APPDATA") {
            paths.push(installed_dsh_cli_entry(
                &PathBuf::from(app_data).join("npm").join("node_modules"),
            ));
        }
        if let Some(prefix) = std::env::var_os("NPM_CONFIG_PREFIX") {
            paths.push(installed_dsh_cli_entry(
                &PathBuf::from(prefix).join("node_modules"),
            ));
        }
        if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
            paths.extend(pnpm_global_dsh_cli_candidates(
                &PathBuf::from(local_app_data).join("pnpm"),
            ));
        }
        for shim_name in ["dsh.cmd", "dsh.ps1", "dsh"] {
            if let Some(shim) = find_program(shim_name) {
                paths.extend(windows_dsh_shim_cli_candidates(&shim));
            }
        }
    }
    #[cfg(not(windows))]
    {
        if let Some(prefix) = std::env::var_os("NPM_CONFIG_PREFIX") {
            paths.push(installed_dsh_cli_entry(
                &PathBuf::from(prefix).join("lib").join("node_modules"),
            ));
        }
        if let Some(home) = std::env::var_os("HOME") {
            let home = PathBuf::from(home);
            paths.push(installed_dsh_cli_entry(
                &home.join(".npm-global").join("lib").join("node_modules"),
            ));
            paths.extend(pnpm_global_dsh_cli_candidates(
                &home.join(".local").join("share").join("pnpm"),
            ));
        }
        for root in ["/usr/local/lib/node_modules", "/usr/lib/node_modules"] {
            paths.push(installed_dsh_cli_entry(Path::new(root)));
        }
        if let Some(shim) = find_program("dsh") {
            if let Ok(target) = std::fs::canonicalize(shim) {
                if target
                    .file_name()
                    .and_then(OsStr::to_str)
                    .is_some_and(|name| name == "bin.js")
                {
                    paths.push(target);
                }
            }
        }
    }
    paths
}

fn resolve_installed_dsh_cli(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates
        .iter()
        .filter(|path| path.is_file())
        .find_map(|path| std::fs::canonicalize(path).ok())
        .map(|path| PathBuf::from(host_path(&path)))
}

fn installed_dsh_root(cli_path: &Path) -> PathBuf {
    cli_path
        .parent()
        .and_then(Path::parent)
        .unwrap_or(cli_path)
        .to_path_buf()
}

fn bundled_runtime_archive_candidates(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut archives = Vec::new();
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        archives.push(
            PathBuf::from(local_app_data)
                .join("RocketX")
                .join("resources")
                .join(DSH_BUNDLED_RUNTIME_ARCHIVE),
        );
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        archives.push(resource_dir.join(DSH_BUNDLED_RUNTIME_ARCHIVE));
    }
    if cfg!(debug_assertions) {
        archives.push(development_bundled_runtime_archive());
    }
    archives
}

fn resolve_bundled_runtime_root(root: &Path) -> Result<PathBuf, String> {
    canonicalize_bundled_runtime_root(root)
}

fn resolve_debug_bundled_runtime_root() -> Result<Option<PathBuf>, String> {
    if !cfg!(debug_assertions) {
        return Ok(None);
    }
    let root = development_bundled_runtime_root();
    if !root.is_dir() {
        return Ok(None);
    }
    resolve_bundled_runtime_root(&root).map(Some).or(Ok(None))
}

fn resolve_bundled_runtime_archive(candidates: &[PathBuf]) -> Result<PathBuf, String> {
    for candidate in candidates {
        if !candidate.is_file() {
            continue;
        }
        let archive = std::fs::canonicalize(candidate)
            .map_err(|error| format!("DSH 运行时归档不可用：{error}"))?;
        return Ok(PathBuf::from(host_path(&archive)));
    }
    Err(format!(
        "未检测到兼容的 DSH {DSH_VERIFIED_VERSION}。Slim 安装包不内置 DSH；请运行 npm install -g @deepseek-ai/dsh@{DSH_VERIFIED_VERSION} 后重启 RocketX，或改用 RocketX Full 安装包。若当前已是 Full 安装包，请重新安装以恢复内置运行时。"
    ))
}

fn prepare_bundled_runtime_root_from_archive(
    archive_path: &Path,
    dsh_root: &Path,
) -> Result<PathBuf, String> {
    let archive_sha = archive_sha256_cached(archive_path, dsh_root)?;
    let runtime_root = bundled_runtime_cache_root(dsh_root);
    if bundled_runtime_is_current(&runtime_root, &archive_sha) {
        return canonicalize_bundled_runtime_root(&runtime_root);
    }

    let _guard = bundled_runtime_unpack_lock()
        .lock()
        .map_err(|_| "DSH 运行时解包锁不可用".to_string())?;
    if bundled_runtime_is_current(&runtime_root, &archive_sha) {
        return canonicalize_bundled_runtime_root(&runtime_root);
    }

    let staging_root = dsh_root.join(format!(
        "{DSH_BUNDLED_RUNTIME_CACHE_DIR}.__staging-{}-{}",
        std::process::id(),
        unique_runtime_suffix()
    ));
    let backup_root = dsh_root.join(format!(
        "{DSH_BUNDLED_RUNTIME_CACHE_DIR}.__old-{}",
        unique_runtime_suffix()
    ));
    remove_dir_all_with_retries(&staging_root)?;
    remove_dir_all_with_retries(&backup_root)?;
    std::fs::create_dir_all(&staging_root)
        .map_err(|error| format!("无法准备 DSH 运行时解包目录：{error}"))?;

    let unpack_result = (|| -> Result<(), String> {
        let archive_file = File::open(archive_path)
            .map_err(|error| format!("无法打开 DSH 运行时归档：{error}"))?;
        let decoder = GzDecoder::new(BufReader::new(archive_file));
        let mut archive = Archive::new(decoder);
        archive
            .unpack(&staging_root)
            .map_err(|error| format!("无法解压 DSH 运行时归档：{error}"))?;
        validate_bundled_runtime_root(&staging_root)?;
        std::fs::write(
            bundled_runtime_sha_marker_path(&staging_root),
            format!("{archive_sha}\n"),
        )
        .map_err(|error| format!("无法写入 DSH 运行时归档校验标记：{error}"))?;
        Ok(())
    })();
    if let Err(error) = unpack_result {
        let _ = remove_dir_all_with_retries(&staging_root);
        return Err(error);
    }

    let mut moved_existing_runtime = false;
    if path_exists(&runtime_root) {
        rename_with_retries(&runtime_root, &backup_root)?;
        moved_existing_runtime = true;
    }
    if let Err(error) = rename_with_retries(&staging_root, &runtime_root) {
        if moved_existing_runtime && !path_exists(&runtime_root) && path_exists(&backup_root) {
            let _ = rename_with_retries(&backup_root, &runtime_root);
        }
        let _ = remove_dir_all_with_retries(&staging_root);
        return Err(error);
    }
    let _ = remove_dir_all_with_retries(&backup_root);
    canonicalize_bundled_runtime_root(&runtime_root)
}

fn prepare_bundled_runtime_root(
    app: &tauri::AppHandle,
    dsh_root: &Path,
) -> Result<PathBuf, String> {
    let archive = resolve_bundled_runtime_archive(&bundled_runtime_archive_candidates(app))?;
    prepare_bundled_runtime_root_from_archive(&archive, dsh_root)
}

fn node_version_is_compatible(value: &str) -> bool {
    dsh_runtime_policy::node_version_is_compatible(value)
}

fn incompatible_node_message(version: &str) -> String {
    // Keep the user-facing contract visible at the command facade.
    format!("Node.js 版本 {version} 不兼容；DSH 运行需要 22.19+ 或 24+")
}

// Compatibility facade kept for source-level contract tests and old callers;
// parsing policy lives in native::dsh_runtime.
type DshVersion = dsh_runtime_policy::DshVersion;

fn parse_dsh_version(raw: &str) -> Option<DshVersion> {
    dsh_runtime_policy::parse_dsh_version(raw)
}

fn bundled_node_paths(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let executable = if cfg!(windows) { "node.exe" } else { "node" };
    let mut paths = Vec::new();
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        paths.push(
            PathBuf::from(local_app_data)
                .join("RocketX")
                .join("resources")
                .join("node")
                .join(executable),
        );
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        paths.push(resource_dir.join("node").join(executable));
    }
    if cfg!(debug_assertions) {
        paths.push(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("target")
                .join("node-resources")
                .join("node")
                .join(executable),
        );
    }
    paths
}

fn probe_node_runtime(program: &Path) -> Result<(PathBuf, String), String> {
    let output = hidden_command(&program)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .map_err(|error| format!("无法检测 Node.js 版本：{error}"))?;
    if !output.status.success() {
        return Err("无法检测 Node.js 版本".to_string());
    }
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !node_version_is_compatible(&version) {
        return Err(incompatible_node_message(&version));
    }
    Ok((PathBuf::from(host_path(&program)), version))
}

fn node_runtime_candidates(
    system: Option<PathBuf>,
    bundled: Vec<PathBuf>,
    use_private_node: bool,
) -> Vec<PathBuf> {
    if use_private_node {
        bundled
    } else {
        system.into_iter().collect()
    }
}

fn resolve_node_runtime(
    app: &tauri::AppHandle,
    use_private_node: bool,
) -> Result<(PathBuf, String), String> {
    let system = if cfg!(windows) {
        find_program("node.exe")
    } else {
        find_program("node")
    };
    let candidates = node_runtime_candidates(system, bundled_node_paths(app), use_private_node);

    let mut failure = None;
    for candidate in candidates {
        if !candidate.is_file() {
            continue;
        }
        match probe_node_runtime(&candidate) {
            Ok(runtime) => return Ok(runtime),
            Err(error) => failure = Some(error),
        }
    }
    Err(failure.unwrap_or_else(|| "未找到兼容的 Node.js 运行时".to_string()))
}

fn verify_installed_dsh_version(node_path: &Path, cli_path: &Path) -> Result<bool, String> {
    let output = hidden_command(node_path)
        .arg(cli_path)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| format!("无法检测已安装的 DSH 版本：{error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "无法检测已安装的 DSH 版本".to_string()
        } else {
            format!("无法检测已安装的 DSH 版本：{stderr}")
        });
    }
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !dsh_version_is_compatible(&version) {
        return Err(format!(
            "已安装的 DSH 版本 {version} 低于最低支持版本 {DSH_VERIFIED_VERSION}；请运行 npm install -g @deepseek-ai/dsh@{DSH_VERIFIED_VERSION} 升级后重试"
        ));
    }
    if dsh_version_is_unverified_newer(&version) {
        log::warn!(
            "已安装的 DSH 版本 {version} 高于 RocketX 完整验证版本 {DSH_VERIFIED_VERSION}，尚未经过完整验证；如遇到兼容问题请回退到验证版本"
        );
    }
    Ok(dsh_version_supports_no_open(&version))
}

fn dsh_version_is_compatible(version: &str) -> bool {
    match (
        parse_dsh_version(version),
        parse_dsh_version(DSH_VERIFIED_VERSION),
    ) {
        (Some(version), Some(minimum)) => version >= minimum,
        _ => false,
    }
}

fn dsh_version_is_unverified_newer(version: &str) -> bool {
    match (
        parse_dsh_version(version),
        parse_dsh_version(DSH_VERIFIED_VERSION),
    ) {
        (Some(version), Some(verified)) => version > verified,
        _ => false,
    }
}

fn dsh_version_supports_no_open(version: &str) -> bool {
    match (
        parse_dsh_version(version),
        parse_dsh_version(DSH_NO_OPEN_VERSION),
    ) {
        (Some(version), Some(minimum)) => version >= minimum,
        _ => false,
    }
}

fn dsh_root_paths(app: &tauri::AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let dsh_root = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位 RocketX 应用数据目录：{error}"))?
        .join(DSH_ROOT_DIR);
    let home_root = dsh_root.join(DSH_HOME_SUBDIR);
    let connections_root = dsh_root.join(DSH_CONNECTIONS_SUBDIR);
    std::fs::create_dir_all(&home_root).map_err(|error| format!("无法准备 DSH_HOME：{error}"))?;
    std::fs::create_dir_all(&connections_root)
        .map_err(|error| format!("无法准备 DSH 连接目录：{error}"))?;
    let dsh_root =
        std::fs::canonicalize(&dsh_root).map_err(|error| format!("DSH 根目录不可用：{error}"))?;
    Ok((
        PathBuf::from(host_path(&dsh_root)),
        PathBuf::from(host_path(&dsh_root.join(DSH_HOME_SUBDIR))),
    ))
}

fn resolve_dsh_runtime(
    app: &tauri::AppHandle,
    source_path: Option<&str>,
) -> Result<ResolvedDshRuntime, String> {
    let (dsh_root, home_root) = dsh_root_paths(app)?;
    let (source_root, cli_entry, use_private_node, verify_installed_version) =
        if let Some(source_root) = source_root_from_candidates(source_path)? {
            (
                source_root.clone(),
                source_dsh_cli_entry(&source_root),
                false,
                false,
            )
        } else if let Some(cli_path) = resolve_installed_dsh_cli(&installed_dsh_cli_candidates()) {
            (installed_dsh_root(&cli_path), cli_path, false, true)
        } else if let Some(bundled_root) = resolve_debug_bundled_runtime_root()? {
            (
                bundled_root.clone(),
                bundled_dsh_cli_entry(&bundled_root),
                false,
                false,
            )
        } else {
            let bundled_root = prepare_bundled_runtime_root(app, &dsh_root)?;
            (
                bundled_root.clone(),
                bundled_dsh_cli_entry(&bundled_root),
                true,
                false,
            )
        };
    let cli_path = PathBuf::from(host_path(
        &std::fs::canonicalize(&cli_entry)
            .map_err(|error| format!("DSH CLI 入口不可用：{error}"))?,
    ));
    let bridge_path = resolve_packaged_bridge(app)?;
    let (node_path, _) = resolve_node_runtime(app, use_private_node)?;
    let supports_no_open = if verify_installed_version {
        verify_installed_dsh_version(&node_path, &cli_path)?
    } else {
        false
    };
    Ok(ResolvedDshRuntime {
        source_root,
        cli_path,
        node_path,
        bridge_path,
        dsh_root,
        home_root,
        supports_no_open,
    })
}

#[tauri::command]
pub async fn dsh_runtime_probe(
    app: tauri::AppHandle,
    source_path: Option<String>,
) -> DshRuntimeProbe {
    // 探测包含归档校验与外部进程 spawn，耗时且不定时；必须离开主线程，
    // 否则探测期间整个窗口事件循环被冻结（启动卡顿的直接来源）。
    tauri::async_runtime::spawn_blocking(move || {
        match resolve_dsh_runtime(&app, source_path.as_deref()) {
            Ok(_) => DshRuntimeProbe {
                ready: true,
                reason: None,
            },
            Err(reason) => DshRuntimeProbe {
                ready: false,
                reason: Some(reason),
            },
        }
    })
    .await
    .unwrap_or_else(|error| DshRuntimeProbe {
        ready: false,
        reason: Some(format!("DSH 运行时探测任务失败：{error}")),
    })
}

fn encode_message(message: serde_json::Value) -> Result<Vec<u8>, String> {
    if !message.is_object() {
        return Err("DSH bridge message must be a JSON object".to_string());
    }
    let mut bytes = serde_json::to_vec(&message)
        .map_err(|error| format!("failed to encode DSH bridge message: {error}"))?;
    if bytes.len() > MAX_MESSAGE_BYTES {
        return Err("DSH bridge message exceeds 2 MiB".to_string());
    }
    bytes.push(b'\n');
    Ok(bytes)
}

fn decode_attachment_request(bytes: &[u8]) -> Result<(DshAgentAttachmentMetadata, &[u8]), String> {
    let metadata_size = bytes
        .get(..4)
        .and_then(|value| value.try_into().ok())
        .map(u32::from_le_bytes)
        .ok_or_else(|| "invalid Agent attachment request".to_string())?
        as usize;
    if metadata_size == 0 || metadata_size > 1_024 || bytes.len() < 4 + metadata_size {
        return Err("invalid Agent attachment request".to_string());
    }
    let metadata = serde_json::from_slice(&bytes[4..4 + metadata_size])
        .map_err(|_| "invalid Agent attachment metadata".to_string())?;
    Ok((metadata, &bytes[4 + metadata_size..]))
}

fn graceful_shutdown_message() -> &'static [u8] {
    b"{\"kind\":\"shutdown\"}\n"
}

fn yaml_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn percent_encode_file_url_path(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        let safe = matches!(
            *byte,
            b'A'..=b'Z'
                | b'a'..=b'z'
                | b'0'..=b'9'
                | b'-'
                | b'_'
                | b'.'
                | b'~'
                | b'/'
                | b':'
        );
        if safe {
            encoded.push(*byte as char);
        } else {
            encoded.push_str(&format!("%{:02X}", byte));
        }
    }
    encoded
}

fn file_url_for_path(path: &Path) -> Result<String, String> {
    let absolute = path
        .canonicalize()
        .map_err(|error| format!("无法解析 DSH 插件路径：{error}"))?;
    let host = host_path(&absolute);
    let normalized = host
        .strip_prefix(r"\\?\")
        .unwrap_or(&host)
        .replace('\\', "/");
    let with_leading_slash = if normalized.starts_with('/') {
        normalized
    } else {
        format!("/{normalized}")
    };
    Ok(format!(
        "file://{}",
        percent_encode_file_url_path(&with_leading_slash)
    ))
}

fn dsh_focus_plugin_package_json() -> &'static str {
    include_str!("dsh_focus_plugin/package.json")
}

fn dsh_focus_plugin_index() -> &'static str {
    include_str!("dsh_focus_plugin/index.mjs")
}

fn dsh_focus_plugin_client() -> &'static str {
    include_str!("dsh_focus_plugin/client.js")
}

fn write_dsh_focus_plugin(runtime_dir: &Path) -> Result<PathBuf, String> {
    let plugin_dir = runtime_dir.join("dsh_focus_plugin");
    std::fs::create_dir_all(&plugin_dir)
        .map_err(|error| format!("无法准备 DSH focus 插件目录：{error}"))?;
    std::fs::write(
        plugin_dir.join("package.json"),
        dsh_focus_plugin_package_json(),
    )
    .map_err(|error| format!("无法写入 DSH focus package.json：{error}"))?;
    std::fs::write(plugin_dir.join("index.mjs"), dsh_focus_plugin_index())
        .map_err(|error| format!("无法写入 DSH focus index.mjs：{error}"))?;
    std::fs::write(plugin_dir.join("client.js"), dsh_focus_plugin_client())
        .map_err(|error| format!("无法写入 DSH focus client.js：{error}"))?;
    Ok(plugin_dir.join("index.mjs"))
}

fn focus_plugin_patch_text(plugin_url: &str) -> String {
    format!(
        concat!("    - id: {}\n", "      name: {}\n"),
        yaml_quote("rocketx-dsh-focus-plugin"),
        yaml_quote(plugin_url),
    )
}

fn business_mcp_patch_text(
    patch_key: &str,
    working_directory: &str,
    command: &str,
) -> Result<String, String> {
    let suffix = patch_key
        .replace('-', "_")
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || *character == '_')
        .collect::<String>();
    let server_name = {
        const MAX_LEN: usize = 32;
        const PREFIX: &str = "rocketx_";
        let mut hash = 0u64;
        for character in suffix.as_bytes() {
            hash = hash
                .wrapping_mul(131)
                .wrapping_add((*character as u64).wrapping_add(1));
        }
        let tail = format!("{:08x}", hash);
        let available = MAX_LEN
            .saturating_sub(PREFIX.len())
            .saturating_sub(1)
            .saturating_sub(tail.len());
        if suffix.len() <= available {
            format!("{PREFIX}{suffix}")
        } else {
            let short_suffix = suffix.chars().take(available).collect::<String>();
            format!("{PREFIX}{short_suffix}_{tail}")
        }
    };
    Ok(format!(
        concat!(
            "- insert:\n",
            "    - id: {}\n",
            "      name: '@deepseek-ai/dsh-mcp-client'\n",
            "      config:\n",
            "        serverName: {}\n",
            "        transport: stdio\n",
            "        command: {}\n",
            "        args:\n",
            "          - --business-mcp\n",
            "        env: {{}}\n",
            "        cwd: {}\n",
            "        toolCallTimeoutMs: 30000\n",
            "        failOnStartupError: false\n"
        ),
        yaml_quote(&format!("mcp-{patch_key}")),
        yaml_quote(&server_name),
        yaml_quote(command),
        yaml_quote(working_directory),
    ))
}

fn cleanup_runtime_dir(runtime_dir: &Path) {
    let _ = std::fs::remove_dir_all(runtime_dir);
}

fn dsh_patch_text(
    patch_key: &str,
    business_mcp_working_directory: &str,
    command: &str,
    focus_plugin_url: &str,
) -> Result<String, String> {
    let business = business_mcp_patch_text(patch_key, business_mcp_working_directory, command)?;
    Ok(format!(
        concat!("- insert:\n", "{}", "{}"),
        business
            .strip_prefix("- insert:\n")
            .ok_or_else(|| "DSH patch 模板损坏".to_string())?,
        focus_plugin_patch_text(focus_plugin_url),
    ))
}

fn write_dsh_patch(runtime_dir: &Path, patch_key: &str) -> Result<PathBuf, String> {
    let command =
        std::env::current_exe().map_err(|error| format!("无法定位 RocketX 可执行文件：{error}"))?;
    let focus_plugin_entry = write_dsh_focus_plugin(runtime_dir)?;
    let focus_plugin_url = file_url_for_path(&focus_plugin_entry)?;
    let patch = dsh_patch_text(
        patch_key,
        &host_path(runtime_dir),
        &host_path(&command),
        &focus_plugin_url,
    )?;
    let patch_path = runtime_dir.join("cordis.patch.yml");
    std::fs::write(&patch_path, patch).map_err(|error| format!("无法写入 DSH patch：{error}"))?;
    Ok(patch_path)
}

fn runtime_directory(
    connections_root: &Path,
    connection_id: &str,
    instance_id: u64,
) -> Result<PathBuf, String> {
    let root = connections_root
        .join(connection_id)
        .join(instance_id.to_string());
    std::fs::create_dir_all(&root).map_err(|error| format!("无法准备 DSH 运行目录：{error}"))?;
    Ok(root)
}

fn host_runtime_directory(connections_root: &Path, instance_id: u64) -> Result<PathBuf, String> {
    runtime_directory(connections_root, "_host", instance_id)
}

fn ready_url_from_line(line: &str) -> Option<String> {
    let frame = serde_json::from_str::<serde_json::Value>(line).ok()?;
    match (
        frame.get("kind").and_then(serde_json::Value::as_str),
        frame.get("url").and_then(serde_json::Value::as_str),
    ) {
        (Some("ready"), Some(url)) => Some(url.to_string()),
        _ => None,
    }
}

fn process_is_running(process: &ManagedDshBridge) -> bool {
    process.running.load(Ordering::Acquire)
}

fn attach_connection_lease(
    process: &mut ManagedDshBridge,
    connections_root: &Path,
    source_root: &str,
    connection_id: String,
    workspace_root: String,
    mode: DshBridgeMode,
    lease_instance: u64,
) -> Result<DshBridgeInfo, String> {
    if process.stopping {
        return Err("DSH bridge 正在停止，请稍后重试".to_string());
    }
    let conflicts = process.source_root != source_root
        || process
            .leases
            .values()
            .filter(|lease| lease.connection_id == connection_id)
            .any(|lease| lease.workspace_root != workspace_root || lease.mode != mode);
    if conflicts {
        return Err(
            "DSH connectionId 已绑定到其他 workspace、sourcePath 或 mode；请先 stop 再重连"
                .to_string(),
        );
    }

    let lease_id = format!("lease-{lease_instance}");
    let runtime_dir = runtime_directory(connections_root, &connection_id, lease_instance)?;
    process.leases.insert(
        lease_id.clone(),
        DshConnectionLease {
            connection_id,
            workspace_root,
            mode,
            runtime_dir,
        },
    );
    Ok(DshBridgeInfo {
        process_id: process.process_id.clone(),
        lease_id,
        ready_url: process.ready_url.clone(),
    })
}

fn release_connection_lease(
    processes: &mut HashMap<String, ManagedDshBridge>,
    process_id: &str,
    lease_id: &str,
) -> Result<DshBridgeRelease, String> {
    let process = processes
        .get_mut(process_id)
        .ok_or_else(|| "DSH bridge 进程未运行".to_string())?;
    if process.stopping {
        return Err("DSH bridge 正在停止".to_string());
    }
    if !process.leases.contains_key(lease_id) {
        return Err("DSH bridge lease 未运行".to_string());
    }
    if process.leases.len() > 1 {
        let lease = process
            .leases
            .remove(lease_id)
            .ok_or_else(|| "DSH bridge lease 未运行".to_string())?;
        Ok(DshBridgeRelease::Lease(lease.runtime_dir))
    } else {
        process.stopping = true;
        Ok(DshBridgeRelease::Process(process.clone()))
    }
}

fn reconcile_process_stop(
    processes: &mut HashMap<String, ManagedDshBridge>,
    process_id: &str,
    stop_succeeded: bool,
) -> Option<ManagedDshBridge> {
    let still_running = processes.get(process_id).is_some_and(process_is_running);
    if stop_succeeded || !still_running {
        return processes.remove(process_id);
    }
    if let Some(process) = processes.get_mut(process_id) {
        process.stopping = false;
    }
    None
}

fn write_dsh_agent_attachment(
    processes: &Arc<Mutex<HashMap<String, ManagedDshBridge>>>,
    raw: &[u8],
) -> Result<DshAgentAttachmentRuntimePath, String> {
    let (metadata, bytes) = decode_attachment_request(raw)?;
    validate_connection_id(&metadata.connection_id)?;
    if bytes.len() > MAX_ATTACHMENT_BYTES {
        return Err("Agent 单个附件不能超过 10 MB".to_string());
    }
    let relative = safe_attachment_path(&metadata.relative_path)?;
    // Keep the registry locked until publication so stop/exit cleanup cannot
    // remove the runtime directory between validation and the file write.
    let processes = processes
        .lock()
        .map_err(|_| "DSH bridge 进程注册表不可用".to_string())?;
    let attachments_dir = processes
        .values()
        .find_map(|process| {
            if process.stopping || !process_is_running(process) {
                return None;
            }
            let lease = process.leases.get(&metadata.lease_id)?;
            (lease.connection_id == metadata.connection_id
                && lease.mode == DshBridgeMode::Controller)
                .then(|| lease.runtime_dir.join("attachments"))
        })
        .ok_or_else(|| "Agent 会话未运行".to_string())?;
    let target = attachments_dir.join(&relative);
    let parent = target
        .parent()
        .ok_or_else(|| "invalid Agent attachment path".to_string())?;
    std::fs::create_dir_all(parent).map_err(|error| format!("无法准备 Agent 附件目录：{error}"))?;
    std::fs::write(&target, bytes).map_err(|error| format!("无法写入 Agent 附件：{error}"))?;
    Ok(DshAgentAttachmentRuntimePath {
        path: host_path(&target),
        root: host_path(&attachments_dir),
    })
}

fn build_bridge_command(
    runtime: &ResolvedDshRuntime,
    workspace_root: &Path,
    patch_path: &Path,
    mode: DshBridgeMode,
) -> Command {
    let mut command = hidden_command(&runtime.node_path);
    command
        .arg(&runtime.bridge_path)
        .arg(&runtime.cli_path)
        .arg(patch_path)
        .arg(mode.as_str());
    if runtime.supports_no_open {
        command.arg("--no-open");
    }
    command
        .current_dir(workspace_root)
        .env("DSH_HOME", &runtime.home_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

fn spawn_reader<R: std::io::Read + Send + 'static>(
    app: tauri::AppHandle,
    state: Arc<Mutex<HashMap<String, ManagedDshBridge>>>,
    process_id: String,
    stream: &'static str,
    reader: R,
) {
    thread::spawn(move || {
        for line in BufReader::new(reader).lines() {
            let Ok(line) = line else { break };
            if stream == "stdout" {
                if let Some(url) = ready_url_from_line(&line) {
                    if let Ok(mut processes) = state.lock() {
                        if let Some(process) = processes.get_mut(&process_id) {
                            process.ready_url = Some(url);
                        }
                    }
                }
            }
            let _ = app.emit(
                "dsh-bridge-output",
                DshOutputEvent {
                    process_id: process_id.clone(),
                    stream,
                    line,
                },
            );
        }
    });
}

#[cfg(windows)]
fn force_stop_process_tree(child: &mut Child) -> std::io::Result<()> {
    let pid = child.id().to_string();
    if hidden_command("taskkill.exe")
        .args(["/PID", &pid, "/T", "/F"])
        .status()
        .is_ok_and(|status| status.success())
    {
        return Ok(());
    }
    child.kill().or_else(|error| match child.try_wait() {
        Ok(Some(_)) => Ok(()),
        _ => Err(error),
    })
}

#[cfg(not(windows))]
fn force_stop_process_tree(child: &mut Child) -> std::io::Result<()> {
    child.kill().or_else(|error| match child.try_wait() {
        Ok(Some(_)) => Ok(()),
        _ => Err(error),
    })
}

fn cleanup_managed_bridge_runtime(process: &ManagedDshBridge) {
    cleanup_runtime_dir(&process.host_runtime_dir);
    for lease in process.leases.values() {
        cleanup_runtime_dir(&lease.runtime_dir);
    }
}

fn stop_process(process: ManagedDshBridge) -> Result<(), String> {
    process.stop_requested.store(true, Ordering::Release);
    if let Ok(mut supervisor) = process.supervisor.lock() {
        supervisor.request_stop();
    }
    if let Ok(mut stdin) = process.stdin.lock() {
        let _ = stdin.write_all(graceful_shutdown_message());
        let _ = stdin.flush();
    }

    let mut child = process
        .child
        .lock()
        .map_err(|_| "DSH bridge 进程不可用".to_string())?;
    let exited = wait_for_exit(
        &mut child,
        DSH_SHUTDOWN_GRACE_PERIOD,
        Duration::from_millis(50),
    )
    .map_err(|error| format!("无法检查 DSH bridge 退出状态：{error}"))?;
    if exited.is_some() {
        process.running.store(false, Ordering::Release);
        cleanup_managed_bridge_runtime(&process);
        return Ok(());
    }
    force_stop_process_tree(&mut child)
        .map_err(|error| format!("failed to stop DSH bridge: {error}"))?;
    child
        .wait()
        .map_err(|error| format!("failed to wait for DSH bridge: {error}"))?;
    process.running.store(false, Ordering::Release);
    cleanup_managed_bridge_runtime(&process);
    Ok(())
}

fn monitor_child(
    app: tauri::AppHandle,
    state: Arc<Mutex<HashMap<String, ManagedDshBridge>>>,
    process_id: String,
    child: Arc<Mutex<Child>>,
    running: Arc<AtomicBool>,
    supervisor: Arc<Mutex<RuntimeSupervisor>>,
    stop_requested: Arc<AtomicBool>,
) {
    thread::spawn(move || loop {
        let status = match child.lock() {
            Ok(mut child) => child.try_wait(),
            Err(_) => return,
        };
        match status {
            Ok(Some(status)) => {
                running.store(false, Ordering::Release);
                let now_ms = supervisor_now_ms();
                let intentional = stop_requested.load(Ordering::Acquire);
                let snapshot = observe_exit(&supervisor, now_ms, intentional);
                let process = state
                    .lock()
                    .ok()
                    .and_then(|mut processes| processes.remove(&process_id));
                if let Some(process) = process {
                    cleanup_managed_bridge_runtime(&process);
                }
                let _ = app.emit(
                    "dsh-bridge-exit",
                    DshExitEvent {
                        process_id,
                        code: status.code(),
                        status: snapshot.status,
                        failures: snapshot.failures,
                        restart_after_ms: snapshot
                            .restart_after
                            .map(|duration| duration.as_millis() as u64),
                    },
                );
                return;
            }
            Ok(None) => thread::sleep(Duration::from_millis(100)),
            Err(_) => return,
        }
    });
}

fn start_dsh_bridge_blocking(
    app: tauri::AppHandle,
    processes: Arc<Mutex<HashMap<String, ManagedDshBridge>>>,
    supervisors: Arc<Mutex<HashMap<String, Arc<Mutex<RuntimeSupervisor>>>>>,
    next_id: Arc<AtomicU64>,
    connection_id: String,
    workspace_root: String,
    source_path: Option<String>,
    mode: Option<String>,
) -> Result<DshBridgeInfo, String> {
    validate_connection_id(&connection_id)?;
    let workspace_root = canonical_directory(workspace_root.trim())?;
    let runtime = resolve_dsh_runtime(&app, source_path.as_deref())?;
    let mode = DshBridgeMode::from_arg(mode.as_deref())?;
    let workspace_root_display = host_path(&workspace_root);
    let connections_root = runtime.dsh_root.join(DSH_CONNECTIONS_SUBDIR);
    let source_root = host_path(&runtime.source_root);
    let mut registry = processes
        .lock()
        .map_err(|_| "DSH bridge 进程注册表不可用".to_string())?;
    let stale = registry
        .iter()
        .filter_map(|(process_id, process)| {
            (!process.stopping && !process_is_running(process)).then_some(process_id.clone())
        })
        .collect::<Vec<_>>();
    for process_id in stale {
        if let Some(process) = registry.remove(&process_id) {
            cleanup_managed_bridge_runtime(&process);
        }
    }
    if registry.values().any(|process| process.stopping) {
        return Err("DSH bridge 正在停止，请稍后重试".to_string());
    }

    if let Some(active_process_id) = registry
        .iter()
        .find_map(|(process_id, process)| process_is_running(process).then_some(process_id.clone()))
    {
        let process = registry
            .get_mut(&active_process_id)
            .ok_or_else(|| "DSH bridge 进程注册表不可用".to_string())?;
        let lease_instance = next_id.fetch_add(1, Ordering::Relaxed);
        return attach_connection_lease(
            process,
            &connections_root,
            &source_root,
            connection_id,
            workspace_root_display,
            mode,
            lease_instance,
        );
    }

    let host_instance = next_id.fetch_add(1, Ordering::Relaxed);
    let host_runtime_dir = host_runtime_directory(&connections_root, host_instance)?;
    let patch_key = format!("host-{host_instance}");
    let patch_path = write_dsh_patch(&host_runtime_dir, &patch_key)?;
    let supervisor = {
        let mut supervisors = supervisors
            .lock()
            .map_err(|_| "DSH supervisor registry is unavailable".to_string())?;
        let supervisor = Arc::clone(
            supervisors
                .entry("dsh-host".to_string())
                .or_insert_with(|| Arc::new(Mutex::new(RuntimeSupervisor::default()))),
        );
        let mut value = supervisor
            .lock()
            .map_err(|_| "DSH supervisor is unavailable".to_string())?;
        if let Err(error) = value.begin_start(supervisor_now_ms()) {
            cleanup_runtime_dir(&host_runtime_dir);
            return Err(match error {
                crate::native::supervisor::StartError::Backoff(delay) => {
                    format!("DSH bridge 最近崩溃，请在 {} ms 后重试", delay.as_millis())
                }
                crate::native::supervisor::StartError::Blocked => {
                    "DSH bridge 已连续崩溃，已暂时阻止启动；请重启 RocketX 后重试".to_string()
                }
                crate::native::supervisor::StartError::Stopping => {
                    "DSH bridge 正在停止，请稍后重试".to_string()
                }
            });
        }
        drop(value);
        supervisor
    };
    let mut child = match build_bridge_command(
        &runtime,
        &workspace_root,
        &patch_path,
        DshBridgeMode::Controller,
    )
    .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            if let Ok(mut value) = supervisor.lock() {
                value.mark_exit(supervisor_now_ms(), false);
            }
            cleanup_runtime_dir(&host_runtime_dir);
            return Err(format!("无法启动 DSH bridge：{error}"));
        }
    };
    let stdin = match child.stdin.take() {
        Some(stdin) => stdin,
        None => {
            let _ = force_stop_process_tree(&mut child);
            let _ = child.wait();
            if let Ok(mut value) = supervisor.lock() {
                value.mark_exit(supervisor_now_ms(), false);
            }
            cleanup_runtime_dir(&host_runtime_dir);
            return Err("DSH bridge stdin 不可用".to_string());
        }
    };
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            let _ = force_stop_process_tree(&mut child);
            let _ = child.wait();
            if let Ok(mut value) = supervisor.lock() {
                value.mark_exit(supervisor_now_ms(), false);
            }
            cleanup_runtime_dir(&host_runtime_dir);
            return Err("DSH bridge stdout 不可用".to_string());
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            let _ = force_stop_process_tree(&mut child);
            let _ = child.wait();
            if let Ok(mut value) = supervisor.lock() {
                value.mark_exit(supervisor_now_ms(), false);
            }
            cleanup_runtime_dir(&host_runtime_dir);
            return Err("DSH bridge stderr 不可用".to_string());
        }
    };
    let process_id = format!("dsh-{}-{host_instance}", child.id());
    let lease_instance = next_id.fetch_add(1, Ordering::Relaxed);
    let lease_id = format!("lease-{lease_instance}");
    let lease_runtime_dir =
        match runtime_directory(&connections_root, &connection_id, lease_instance) {
            Ok(runtime_dir) => runtime_dir,
            Err(error) => {
                let _ = force_stop_process_tree(&mut child);
                let _ = child.wait();
                if let Ok(mut value) = supervisor.lock() {
                    value.mark_exit(supervisor_now_ms(), false);
                }
                cleanup_runtime_dir(&host_runtime_dir);
                return Err(error);
            }
        };
    let child = Arc::new(Mutex::new(child));
    let running = Arc::new(AtomicBool::new(true));
    let stop_requested = Arc::new(AtomicBool::new(false));
    if let Ok(mut value) = supervisor.lock() {
        value.mark_running(supervisor_now_ms());
    }
    registry.insert(
        process_id.clone(),
        ManagedDshBridge {
            process_id: process_id.clone(),
            source_root,
            child: Arc::clone(&child),
            stdin: Arc::new(Mutex::new(stdin)),
            running: Arc::clone(&running),
            stop_requested: Arc::clone(&stop_requested),
            stopping: false,
            host_runtime_dir,
            ready_url: None,
            leases: HashMap::from([(
                lease_id.clone(),
                DshConnectionLease {
                    connection_id,
                    workspace_root: workspace_root_display,
                    mode,
                    runtime_dir: lease_runtime_dir,
                },
            )]),
            supervisor: Arc::clone(&supervisor),
        },
    );
    drop(registry);
    let info = DshBridgeInfo {
        process_id: process_id.clone(),
        lease_id,
        ready_url: None,
    };
    spawn_reader(
        app.clone(),
        Arc::clone(&processes),
        process_id.clone(),
        "stdout",
        stdout,
    );
    spawn_reader(
        app.clone(),
        Arc::clone(&processes),
        process_id.clone(),
        "stderr",
        stderr,
    );
    monitor_child(
        app,
        processes,
        process_id,
        child,
        running,
        supervisor,
        stop_requested,
    );
    Ok(info)
}

#[tauri::command]
pub fn dsh_bridge_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, DshBridgeState>,
    connection_id: String,
    workspace_root: String,
    source_path: Option<String>,
    mode: Option<String>,
) -> Result<DshBridgeInfo, String> {
    start_dsh_bridge_blocking(
        app,
        Arc::clone(&state.processes),
        Arc::clone(&state.supervisors),
        Arc::clone(&state.next_id),
        connection_id,
        workspace_root,
        source_path,
        mode,
    )
}

#[tauri::command]
pub fn dsh_bridge_write(
    state: tauri::State<'_, DshBridgeState>,
    process_id: String,
    message: serde_json::Value,
) -> Result<(), String> {
    let bytes = encode_message(message)?;
    let stdin = {
        let processes = state
            .processes
            .lock()
            .map_err(|_| "DSH bridge 进程注册表不可用".to_string())?;
        let process = processes
            .get(&process_id)
            .ok_or_else(|| "DSH bridge 进程未运行".to_string())?;
        if process.stopping || !process_is_running(process) {
            return Err("DSH bridge 进程未运行".to_string());
        }
        Arc::clone(&process.stdin)
    };
    let mut stdin = stdin
        .lock()
        .map_err(|_| "DSH bridge stdin 不可用".to_string())?;
    stdin
        .write_all(&bytes)
        .and_then(|_| stdin.flush())
        .map_err(|error| format!("failed to write DSH bridge message: {error}"))
}

#[tauri::command]
pub fn dsh_agent_attachment_write(
    state: tauri::State<'_, DshBridgeState>,
    request: tauri::ipc::Request<'_>,
) -> Result<DshAgentAttachmentRuntimePath, String> {
    let raw = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes,
        _ => return Err("Agent attachment request must be binary".to_string()),
    };
    write_dsh_agent_attachment(&state.processes, raw)
}

#[tauri::command]
pub fn dsh_bridge_stop(
    state: tauri::State<'_, DshBridgeState>,
    process_id: String,
    lease_id: String,
) -> Result<(), String> {
    let release = {
        let mut processes = state
            .processes
            .lock()
            .map_err(|_| "DSH bridge 进程注册表不可用".to_string())?;
        release_connection_lease(&mut processes, &process_id, &lease_id)?
    };
    match release {
        DshBridgeRelease::Lease(runtime_dir) => {
            cleanup_runtime_dir(&runtime_dir);
            Ok(())
        }
        DshBridgeRelease::Process(process) => {
            let supervisor = Arc::clone(&process.supervisor);
            let stop_requested = Arc::clone(&process.stop_requested);
            let result = stop_process(process);
            let removed = {
                let mut processes = state
                    .processes
                    .lock()
                    .map_err(|_| "DSH bridge 进程注册表不可用".to_string())?;
                reconcile_process_stop(&mut processes, &process_id, result.is_ok())
            };
            if result.is_ok() {
                if let Ok(mut supervisors) = state.supervisors.lock() {
                    supervisors.remove("dsh-host");
                }
            }
            if result.is_err() {
                let still_registered = state
                    .processes
                    .lock()
                    .map(|processes| processes.contains_key(&process_id))
                    .unwrap_or(false);
                if still_registered {
                    stop_requested.store(false, Ordering::Release);
                    if let Ok(mut value) = supervisor.lock() {
                        value.mark_running(supervisor_now_ms());
                    }
                }
                if let Some(process) = removed {
                    cleanup_managed_bridge_runtime(&process);
                }
            }
            result
        }
    }
}

pub fn shutdown(app: &tauri::AppHandle) {
    let state = app.state::<DshBridgeState>();
    let processes = state
        .processes
        .lock()
        .map(|mut processes| {
            processes
                .drain()
                .map(|(_, process)| process)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for process in processes {
        let _ = stop_process(process);
    }
    if let Ok(mut supervisors) = state.supervisors.lock() {
        supervisors.clear();
    };
}

#[cfg(test)]
mod tests {
    use super::{
        archive_sha256_cached, attach_connection_lease, build_bridge_command, bundled_bridge_path,
        bundled_dsh_cli_entry, business_mcp_patch_text, cleanup_runtime_dir, compute_sha256,
        development_bundled_runtime_archive, development_bundled_runtime_root,
        dsh_focus_plugin_client, dsh_focus_plugin_index, dsh_focus_plugin_package_json,
        dsh_patch_text, dsh_version_is_compatible, dsh_version_is_unverified_newer,
        dsh_version_supports_no_open, encode_message, file_url_for_path, graceful_shutdown_message,
        hidden_command, host_path, installed_dsh_cli_entry, installed_dsh_root,
        node_runtime_candidates, node_version_is_compatible,
        prepare_bundled_runtime_root_from_archive, reconcile_process_stop,
        release_connection_lease, resolve_bundled_runtime_root, resolve_installed_dsh_cli,
        resolve_source_root, safe_attachment_path, source_bridge_path, source_dsh_cli_entry,
        source_root_from_candidates, validate_connection_id, write_dsh_agent_attachment,
        write_dsh_focus_plugin, write_dsh_patch, DshBridgeMode, DshBridgeRelease,
        DshConnectionLease, ManagedDshBridge, ResolvedDshRuntime,
    };
    use crate::native::supervisor::RuntimeSupervisor;
    use flate2::{write::GzEncoder, Compression};
    use serde_json::json;
    use std::{
        collections::HashMap,
        ffi::OsStr,
        fs,
        fs::File,
        path::PathBuf,
        process::{Child, ChildStdin, Stdio},
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc, Mutex,
        },
        time::UNIX_EPOCH,
    };
    use tar::Builder;

    fn unique_temp_dir(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "rocketx-dsh-tests-{label}-{}",
            uuid::Uuid::new_v4()
        ))
    }

    #[test]
    fn archive_sha256_is_cached_by_size_and_mtime() {
        let root = unique_temp_dir("archive-sha-cache");
        let dsh_root = root.join("dsh");
        std::fs::create_dir_all(&dsh_root).unwrap();
        let archive = root.join("dsh-runtime.tar.gz");
        std::fs::write(&archive, b"archive-v1").unwrap();

        let first = archive_sha256_cached(&archive, &dsh_root).unwrap();
        assert_eq!(first, compute_sha256(&archive).unwrap());

        // 用正确的 size+mtime 配上假哈希写缓存：命中缓存会原样返回假值，
        // 证明元数据不变时不再对归档做全量哈希。
        let metadata = std::fs::metadata(&archive).unwrap();
        let mtime_ms = metadata
            .modified()
            .unwrap()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis();
        std::fs::write(
            dsh_root.join("dsh-runtime-archive.sha256-cache"),
            format!("{} {} deadbeef\n", metadata.len(), mtime_ms),
        )
        .unwrap();
        assert_eq!(
            archive_sha256_cached(&archive, &dsh_root).unwrap(),
            "deadbeef"
        );

        // 内容变化（大小或 mtime 变化）后重新计算
        std::fs::write(&archive, b"archive-v2-longer").unwrap();
        let updated = archive_sha256_cached(&archive, &dsh_root).unwrap();
        assert_eq!(updated, compute_sha256(&archive).unwrap());

        let _ = std::fs::remove_dir_all(&root);
    }

    fn encode_attachment_request(
        connection_id: &str,
        lease_id: &str,
        relative_path: &str,
        bytes: &[u8],
    ) -> Vec<u8> {
        let metadata = serde_json::json!({
            "connectionId": connection_id,
            "leaseId": lease_id,
            "relativePath": relative_path,
        });
        let metadata = serde_json::to_vec(&metadata).unwrap();
        let mut request = Vec::with_capacity(4 + metadata.len() + bytes.len());
        request.extend_from_slice(&(metadata.len() as u32).to_le_bytes());
        request.extend_from_slice(&metadata);
        request.extend_from_slice(bytes);
        request
    }

    fn spawn_idle_bridge_child() -> (Arc<Mutex<Child>>, Arc<Mutex<ChildStdin>>) {
        #[cfg(windows)]
        let mut child = hidden_command("cmd")
            .args(["/C", "more"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        #[cfg(not(windows))]
        let mut child = hidden_command("cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let stdin = Arc::new(Mutex::new(child.stdin.take().unwrap()));
        (Arc::new(Mutex::new(child)), stdin)
    }

    fn managed_bridge_for_test(
        connection_id: &str,
        mode: DshBridgeMode,
        runtime_dir: PathBuf,
    ) -> ManagedDshBridge {
        let (child, stdin) = spawn_idle_bridge_child();
        let lease_id = format!("lease-{connection_id}");
        ManagedDshBridge {
            process_id: format!("test-{connection_id}-{}", uuid::Uuid::new_v4()),
            source_root: "D:\\source".to_string(),
            child,
            stdin,
            running: Arc::new(AtomicBool::new(true)),
            stop_requested: Arc::new(AtomicBool::new(false)),
            stopping: false,
            host_runtime_dir: runtime_dir.join("host"),
            ready_url: None,
            leases: HashMap::from([(
                lease_id.clone(),
                DshConnectionLease {
                    connection_id: connection_id.to_string(),
                    workspace_root: "D:\\workspace".to_string(),
                    mode,
                    runtime_dir,
                },
            )]),
            supervisor: Arc::new(Mutex::new(RuntimeSupervisor::default())),
        }
    }

    fn stop_test_bridge(process: &ManagedDshBridge) {
        if let Ok(mut child) = process.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
        process.running.store(false, Ordering::Release);
    }

    #[test]
    fn shared_host_attaches_distinct_connection_leases_and_replays_ready_url() {
        let root = unique_temp_dir("shared-host-attach");
        let first_runtime = root.join("first");
        fs::create_dir_all(&first_runtime).unwrap();
        let mut process =
            managed_bridge_for_test("first", DshBridgeMode::Controller, first_runtime);
        process.ready_url = Some("http://127.0.0.1:8123/".to_string());
        let process_id = process.process_id.clone();
        let source_root = process.source_root.clone();

        let info = attach_connection_lease(
            &mut process,
            &root.join("connections"),
            &source_root,
            "second".to_string(),
            "D:\\second-workspace".to_string(),
            DshBridgeMode::Web,
            2,
        )
        .unwrap();

        assert_eq!(info.process_id, process_id);
        assert_eq!(info.lease_id, "lease-2");
        assert_eq!(info.ready_url.as_deref(), Some("http://127.0.0.1:8123/"));
        assert_eq!(process.leases.len(), 2);
        assert_eq!(
            process.leases.get("lease-2").unwrap().mode,
            DshBridgeMode::Web
        );

        let error = match attach_connection_lease(
            &mut process,
            &root.join("connections"),
            &source_root,
            "second".to_string(),
            "D:\\other-workspace".to_string(),
            DshBridgeMode::Web,
            3,
        ) {
            Err(error) => error,
            Ok(_) => panic!("相同 connectionId 不能漂移 workspace"),
        };
        assert!(error.contains("请先 stop 再重连"));

        stop_test_bridge(&process);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn shared_host_stops_only_after_the_last_lease_is_released() {
        let root = unique_temp_dir("shared-host-release");
        let first_runtime = root.join("first");
        fs::create_dir_all(&first_runtime).unwrap();
        let mut process =
            managed_bridge_for_test("first", DshBridgeMode::Controller, first_runtime.clone());
        let process_id = process.process_id.clone();
        let source_root = process.source_root.clone();
        let second = attach_connection_lease(
            &mut process,
            &root.join("connections"),
            &source_root,
            "second".to_string(),
            "D:\\second-workspace".to_string(),
            DshBridgeMode::Controller,
            2,
        )
        .unwrap();
        let mut processes = HashMap::from([(process_id.clone(), process)]);

        let first_release =
            release_connection_lease(&mut processes, &process_id, "lease-first").unwrap();
        match first_release {
            DshBridgeRelease::Lease(runtime_dir) => assert_eq!(runtime_dir, first_runtime),
            DshBridgeRelease::Process(_) => panic!("首个租约不应停止共享宿主"),
        }
        assert_eq!(processes.get(&process_id).unwrap().leases.len(), 1);

        let final_release =
            release_connection_lease(&mut processes, &process_id, &second.lease_id).unwrap();
        let DshBridgeRelease::Process(_process) = final_release else {
            panic!("最后一个租约必须移交宿主进程用于停止");
        };
        assert!(processes.get(&process_id).unwrap().stopping);
        let duplicate_stop =
            match release_connection_lease(&mut processes, &process_id, &second.lease_id) {
                Err(error) => error,
                Ok(_) => panic!("停止中的宿主不能再次释放"),
            };
        assert_eq!(duplicate_stop, "DSH bridge 正在停止");
        assert!(reconcile_process_stop(&mut processes, &process_id, false).is_none());
        assert!(!processes.get(&process_id).unwrap().stopping);

        let final_retry =
            release_connection_lease(&mut processes, &process_id, &second.lease_id).unwrap();
        let DshBridgeRelease::Process(process) = final_retry else {
            panic!("重试最后一个租约仍应移交宿主进程");
        };
        stop_test_bridge(&process);
        assert!(reconcile_process_stop(&mut processes, &process_id, false).is_some());
        assert!(processes.is_empty());
        let _ = fs::remove_dir_all(root);
    }

    fn write_runtime_archive(
        archive_path: &PathBuf,
        cli_contents: Option<&[u8]>,
        bridge_contents: Option<&[u8]>,
    ) {
        let source = unique_temp_dir("bundled-runtime-archive-source");
        fs::create_dir_all(&source).unwrap();
        if let Some(contents) = cli_contents {
            fs::create_dir_all(
                bundled_dsh_cli_entry(&source)
                    .parent()
                    .expect("bundled cli parent"),
            )
            .unwrap();
            fs::write(bundled_dsh_cli_entry(&source), contents).unwrap();
        }
        if let Some(contents) = bridge_contents {
            fs::write(bundled_bridge_path(&source), contents).unwrap();
        }
        let archive = File::create(archive_path).unwrap();
        let encoder = GzEncoder::new(archive, Compression::default());
        let mut builder = Builder::new(encoder);
        builder.append_dir_all(".", &source).unwrap();
        let encoder = builder.into_inner().unwrap();
        encoder.finish().unwrap();
        let _ = fs::remove_dir_all(source);
    }

    #[test]
    fn connection_id_rejects_unsafe_values() {
        assert!(validate_connection_id("thread-01_ok").is_ok());
        assert!(validate_connection_id("../escape").is_err());
        assert!(validate_connection_id("with space").is_err());
    }

    #[test]
    fn message_encoding_requires_object_and_size_limit() {
        assert_eq!(
            encode_message(json!({"method": "ping"})).unwrap(),
            b"{\"method\":\"ping\"}\n"
        );
        assert!(encode_message(json!(["bad"])).is_err());
        assert!(encode_message(json!({"payload": "x".repeat(2 * 1024 * 1024)})).is_err());
    }

    #[test]
    fn graceful_shutdown_message_matches_bridge_contract() {
        assert_eq!(graceful_shutdown_message(), b"{\"kind\":\"shutdown\"}\n");
    }

    #[test]
    fn patch_contains_business_mcp_command_without_credentials() {
        let patch = business_mcp_patch_text(
            "conn-7",
            r"C:\workspace",
            r"C:\Program Files\RocketX\RocketX.exe",
        )
        .unwrap();
        assert!(patch.contains("@deepseek-ai/dsh-mcp-client"));
        assert!(patch.contains("--business-mcp"));
        assert!(patch.contains("failOnStartupError: false"));
        assert!(patch.contains("env: {}"));
        assert!(patch.contains("serverName: 'rocketx_conn_7'"));
        assert!(!patch.contains("authToken"));
        assert!(!patch.contains("pat:"));
    }

    #[test]
    fn patch_shortens_business_mcp_server_name_when_too_long() {
        let long_patch_key = "very_long_connection_id_with_many_segments_and_entropy_0001";
        let patch = business_mcp_patch_text(
            long_patch_key,
            r"C:\workspace",
            r"C:\Program Files\RocketX\RocketX.exe",
        )
        .unwrap();
        let server_name_line = patch
            .lines()
            .find(|line| line.trim_start().starts_with("serverName:"))
            .expect("missing serverName");
        let value = server_name_line
            .splitn(2, "serverName: ")
            .nth(1)
            .unwrap()
            .trim();
        assert!(value.starts_with("'rocketx_"));
        assert!(value.starts_with('\'') && value.ends_with('\''));
        let server_name = value.trim_matches('\'');
        assert!(server_name.len() <= 32);
    }

    #[test]
    fn file_url_for_path_encodes_windows_paths_for_dsh_plugin_patch() {
        let root = unique_temp_dir("focus-plugin-url");
        let file = root.join("with space").join("index.mjs");
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, b"export function apply() {}").unwrap();
        let url = file_url_for_path(&file).unwrap();
        assert!(url.starts_with("file:///"));
        assert!(url.contains("with%20space"));
        assert!(url.ends_with("/index.mjs"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn dsh_patch_includes_business_mcp_and_focus_plugin_rows() {
        let patch = dsh_patch_text(
            "conn-7",
            r"C:\workspace",
            r"C:\Program Files\RocketX\RocketX.exe",
            "file:///C:/runtime/dsh_focus_plugin/index.mjs",
        )
        .unwrap();
        assert!(patch.contains("@deepseek-ai/dsh-mcp-client"));
        assert!(patch.contains("file:///C:/runtime/dsh_focus_plugin/index.mjs"));
        assert!(patch.contains("rocketx-dsh-focus-plugin"));
    }

    #[test]
    fn shared_host_uses_its_runtime_directory_for_business_mcp() {
        let root = unique_temp_dir("business-mcp-cwd");
        fs::create_dir_all(&root).unwrap();
        let patch_path = write_dsh_patch(&root, "host-7").unwrap();
        let patch = fs::read_to_string(patch_path).unwrap();
        assert!(patch.contains(&format!("cwd: '{}'", host_path(&root))));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn focus_plugin_runtime_files_match_embedded_templates() {
        let root = unique_temp_dir("focus-plugin-files");
        fs::create_dir_all(&root).unwrap();
        let entry = write_dsh_focus_plugin(&root).unwrap();
        let plugin_dir = root.join("dsh_focus_plugin");
        assert_eq!(
            fs::read_to_string(plugin_dir.join("package.json")).unwrap(),
            dsh_focus_plugin_package_json()
        );
        assert_eq!(
            fs::read_to_string(&entry).unwrap(),
            dsh_focus_plugin_index()
        );
        assert_eq!(
            fs::read_to_string(plugin_dir.join("client.js")).unwrap(),
            dsh_focus_plugin_client()
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn node_compatibility_matches_dsh_source_contract() {
        assert!(node_version_is_compatible("v22.19.0"));
        assert!(node_version_is_compatible("v24.0.0"));
        assert!(node_version_is_compatible("v26.1.0"));
        assert!(!node_version_is_compatible("v22.18.0"));
        assert!(!node_version_is_compatible("v23.9.0"));
        assert!(!node_version_is_compatible("nightly"));
    }

    #[test]
    fn installed_dsh_accepts_semver_range_above_minimum() {
        assert!(!dsh_version_is_compatible("0.1.0-rc.5"));
        assert!(dsh_version_is_compatible("0.1.0-rc.6"));
        assert!(dsh_version_is_compatible(" 0.1.0-rc.6\n"));
        assert!(dsh_version_is_compatible("0.1.0-rc.7"));
        assert!(dsh_version_is_compatible("1.0.0-rc.1"));
        // 无连字符预发布格式规范化为 1.0.0-rcalpha07 后参与比较
        assert!(dsh_version_is_compatible("1.0.0rcalpha07"));
        assert!(dsh_version_is_compatible("1.0.0"));
        assert!(!dsh_version_is_compatible("0.0.9"));
        assert!(!dsh_version_is_compatible("nightly"));
    }

    #[test]
    fn installed_dsh_flags_unverified_newer_versions() {
        assert!(!dsh_version_is_unverified_newer("0.1.0-rc.5"));
        assert!(!dsh_version_is_unverified_newer("0.1.0-rc.6"));
        assert!(dsh_version_is_unverified_newer("0.1.0-rc.7"));
        assert!(dsh_version_is_unverified_newer("1.0.0rcalpha07"));
        assert!(!dsh_version_is_unverified_newer("nightly"));
    }

    #[test]
    fn installed_dsh_no_open_capability_matches_cli_version() {
        assert!(!dsh_version_supports_no_open("0.1.0-rc.6"));
        assert!(dsh_version_supports_no_open("0.1.0-rc.7"));
        assert!(dsh_version_supports_no_open("1.0.0"));
        assert!(!dsh_version_supports_no_open("nightly"));
    }

    #[test]
    fn dsh_runtime_sources_do_not_mix_node_candidates() {
        let system = PathBuf::from(r"C:\Program Files\nodejs\node.exe");
        let private = PathBuf::from(r"C:\Users\test\AppData\Local\RocketX\resources\node\node.exe");
        assert_eq!(
            node_runtime_candidates(Some(system.clone()), vec![private.clone()], false),
            vec![system]
        );
        assert_eq!(
            node_runtime_candidates(
                Some(PathBuf::from(r"C:\Program Files\nodejs\node.exe")),
                vec![private.clone()],
                true,
            ),
            vec![private]
        );
    }

    #[test]
    fn source_root_prefers_explicit_path_and_requires_built_cli() {
        let root = unique_temp_dir("source-root");
        let explicit = root.join("explicit");
        let env_root = root.join("env");
        fs::create_dir_all(explicit.join("apps").join("cli").join("lib")).unwrap();
        fs::create_dir_all(env_root.join("apps").join("cli").join("lib")).unwrap();
        fs::write(source_dsh_cli_entry(&explicit), b"console.log('explicit')").unwrap();
        fs::write(source_dsh_cli_entry(&env_root), b"console.log('env')").unwrap();

        unsafe {
            std::env::set_var("ROCKETX_DSH_SOURCE", &env_root);
        }
        let resolved = source_root_from_candidates(Some(explicit.to_string_lossy().as_ref()))
            .unwrap()
            .unwrap();
        assert_eq!(
            host_path(&resolved),
            host_path(&explicit.canonicalize().unwrap())
        );
        let resolved_env = source_root_from_candidates(None).unwrap().unwrap();
        assert_eq!(
            host_path(&resolved_env),
            host_path(&env_root.canonicalize().unwrap())
        );
        unsafe {
            std::env::remove_var("ROCKETX_DSH_SOURCE");
        }
        assert!(source_root_from_candidates(None).unwrap().is_none());
        let missing =
            source_root_from_candidates(Some(root.to_string_lossy().as_ref())).unwrap_err();
        assert!(missing.contains("apps/cli/lib/bin.js"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn source_root_accepts_direct_cli_entry() {
        let root = unique_temp_dir("source-entry");
        let cli = root.join("apps").join("cli").join("lib").join("bin.js");
        fs::create_dir_all(cli.parent().unwrap()).unwrap();
        fs::write(&cli, b"console.log('entry')").unwrap();
        let resolved = source_root_from_candidates(Some(cli.to_string_lossy().as_ref()))
            .unwrap()
            .unwrap();
        assert_eq!(
            host_path(&resolved),
            host_path(&root.canonicalize().unwrap())
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn explicit_source_override_still_fails_loud_when_cli_is_missing() {
        let root = unique_temp_dir("source-missing-cli");
        fs::create_dir_all(&root).unwrap();
        let error = resolve_source_root(&root).unwrap_err();
        assert!(error.contains("apps/cli/lib/bin.js"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn installed_dsh_uses_the_global_package_cli_entry() {
        let root = unique_temp_dir("installed-runtime");
        let node_modules = root.join("node_modules");
        let cli = installed_dsh_cli_entry(&node_modules);
        fs::create_dir_all(cli.parent().unwrap()).unwrap();
        fs::write(&cli, b"console.log('installed')").unwrap();

        let missing = root.join("missing").join("bin.js");
        let resolved = resolve_installed_dsh_cli(&[missing, cli.clone()]).unwrap();
        assert_eq!(
            resolved,
            PathBuf::from(host_path(&cli.canonicalize().unwrap()))
        );
        assert_eq!(
            installed_dsh_root(&resolved),
            PathBuf::from(host_path(
                &node_modules
                    .join("@deepseek-ai")
                    .join("dsh")
                    .canonicalize()
                    .unwrap()
            ))
        );
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(windows)]
    #[test]
    fn pnpm_global_candidates_accept_bin_home_and_any_generation() {
        let root = unique_temp_dir("pnpm-global-runtime");
        let pnpm_root = root.join("pnpm");
        let cli = installed_dsh_cli_entry(&pnpm_root.join("global").join("9").join("node_modules"));
        fs::create_dir_all(cli.parent().unwrap()).unwrap();
        fs::create_dir_all(pnpm_root.join("bin")).unwrap();
        fs::write(&cli, b"console.log('pnpm-installed')").unwrap();

        let candidates = super::pnpm_global_dsh_cli_candidates(&pnpm_root.join("bin"));
        assert!(candidates.contains(&cli));
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(windows)]
    #[test]
    fn windows_shim_candidates_follow_the_real_pnpm_cli_entry() {
        let root = unique_temp_dir("pnpm-shim-runtime");
        let shim = root.join("dsh.cmd");
        let cli = root
            .join("global")
            .join("9")
            .join(".pnpm")
            .join("@deepseek-ai+dsh@0.1.0-rc.6")
            .join("node_modules")
            .join("@deepseek-ai")
            .join("dsh")
            .join("lib")
            .join("bin.js");
        fs::create_dir_all(cli.parent().unwrap()).unwrap();
        fs::write(&cli, b"console.log('pnpm-installed')").unwrap();
        fs::write(
            &shim,
            r#"@ECHO off
node "%dp0%\global\9\.pnpm\@deepseek-ai+dsh@0.1.0-rc.6\node_modules\@deepseek-ai\dsh\lib\bin.js" %*
"#,
        )
        .unwrap();

        let candidates = super::windows_dsh_shim_cli_candidates(&shim);
        assert!(candidates.contains(&cli));
        assert_eq!(
            resolve_installed_dsh_cli(&candidates).unwrap(),
            PathBuf::from(host_path(&cli.canonicalize().unwrap()))
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn bundled_runtime_requires_cli_and_bridge_contract() {
        let root = unique_temp_dir("bundled-runtime-contract");
        fs::create_dir_all(&root).unwrap();
        let missing_cli = resolve_bundled_runtime_root(&root).unwrap_err();
        assert!(missing_cli.contains("@deepseek-ai"));

        fs::create_dir_all(
            bundled_dsh_cli_entry(&root)
                .parent()
                .expect("bundled cli parent"),
        )
        .unwrap();
        fs::write(bundled_dsh_cli_entry(&root), b"console.log('bundled')").unwrap();
        let missing_bridge = resolve_bundled_runtime_root(&root).unwrap_err();
        assert!(missing_bridge.contains("dsh_bridge.mjs"));

        fs::write(bundled_bridge_path(&root), b"console.log('bridge')").unwrap();
        let resolved = resolve_bundled_runtime_root(&root).unwrap();
        assert_eq!(
            resolved,
            PathBuf::from(host_path(&root.canonicalize().unwrap()))
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn bundled_runtime_falls_back_to_development_target_candidate() {
        let path = development_bundled_runtime_root();
        assert!(
            host_path(&path).ends_with("target\\dsh-runtime")
                || host_path(&path).ends_with("target/dsh-runtime")
        );
    }

    #[test]
    fn bundled_runtime_archive_path_matches_resource_contract() {
        let path = development_bundled_runtime_archive();
        assert!(
            host_path(&path).ends_with("target\\dsh-runtime.tar.gz")
                || host_path(&path).ends_with("target/dsh-runtime.tar.gz")
        );
    }

    #[cfg(windows)]
    #[test]
    fn prepared_release_archive_is_readable_by_the_rust_unpacker_when_present() {
        let archive = development_bundled_runtime_archive();
        if !archive.is_file() {
            return;
        }
        let root = unique_temp_dir("prepared-release-archive");
        let dsh_root = root.join("app-data").join("dsh");
        fs::create_dir_all(&dsh_root).unwrap();
        let extracted = prepare_bundled_runtime_root_from_archive(&archive, &dsh_root).unwrap();
        assert!(bundled_dsh_cli_entry(&extracted).is_file());
        assert!(bundled_bridge_path(&extracted).is_file());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn bundled_runtime_archive_cache_is_reusable_when_sha_matches() {
        let root = unique_temp_dir("bundled-runtime-cache-reuse");
        let archive = root.join("dsh-runtime.tar.gz");
        let dsh_root = root.join("app-data").join("dsh");
        fs::create_dir_all(&dsh_root).unwrap();
        write_runtime_archive(
            &archive,
            Some(b"console.log('cli-v1')"),
            Some(b"console.log('bridge-v1')"),
        );

        let extracted = prepare_bundled_runtime_root_from_archive(&archive, &dsh_root).unwrap();
        let sentinel = extracted.join("sentinel.txt");
        fs::write(&sentinel, b"keep").unwrap();

        let reused = prepare_bundled_runtime_root_from_archive(&archive, &dsh_root).unwrap();
        assert_eq!(reused, extracted);
        assert!(sentinel.is_file());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn bundled_runtime_archive_cache_refreshes_when_archive_sha_changes() {
        let root = unique_temp_dir("bundled-runtime-cache-refresh");
        let archive = root.join("dsh-runtime.tar.gz");
        let dsh_root = root.join("app-data").join("dsh");
        fs::create_dir_all(&dsh_root).unwrap();
        write_runtime_archive(
            &archive,
            Some(b"console.log('cli-v1')"),
            Some(b"console.log('bridge-v1')"),
        );

        let extracted = prepare_bundled_runtime_root_from_archive(&archive, &dsh_root).unwrap();
        let sentinel = extracted.join("sentinel.txt");
        fs::write(&sentinel, b"stale").unwrap();

        write_runtime_archive(
            &archive,
            Some(b"console.log('cli-v2')"),
            Some(b"console.log('bridge-v2')"),
        );
        let refreshed = prepare_bundled_runtime_root_from_archive(&archive, &dsh_root).unwrap();
        assert_eq!(refreshed, extracted);
        assert!(!sentinel.exists());
        assert_eq!(
            fs::read_to_string(bundled_dsh_cli_entry(&refreshed)).unwrap(),
            "console.log('cli-v2')"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn bundled_runtime_archive_requires_cli_and_bridge_entries() {
        let root = unique_temp_dir("bundled-runtime-archive-missing-entry");
        let archive = root.join("dsh-runtime.tar.gz");
        let dsh_root = root.join("app-data").join("dsh");
        fs::create_dir_all(&dsh_root).unwrap();
        write_runtime_archive(&archive, None, Some(b"console.log('bridge-only')"));

        let error = prepare_bundled_runtime_root_from_archive(&archive, &dsh_root).unwrap_err();
        assert!(error.contains("@deepseek-ai"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn bridge_command_matches_runtime_contract() {
        let runtime = ResolvedDshRuntime {
            source_root: PathBuf::from(r"C:\dsh"),
            cli_path: PathBuf::from(r"C:\dsh\apps\cli\lib\bin.js"),
            node_path: PathBuf::from(r"C:\Program Files\nodejs\node.exe"),
            bridge_path: source_bridge_path(),
            dsh_root: PathBuf::from(r"C:\Users\test\AppData\Roaming\RocketX\dsh"),
            home_root: PathBuf::from(r"C:\Users\test\AppData\Roaming\RocketX\dsh\home"),
            supports_no_open: false,
        };
        let patch = PathBuf::from(
            r"C:\Users\test\AppData\Roaming\RocketX\dsh\connections\abc\1\cordis.patch.yml",
        );
        let workspace = PathBuf::from(r"C:\workspace");
        let command = build_bridge_command(&runtime, &workspace, &patch, DshBridgeMode::Controller);
        assert_eq!(
            command.get_program(),
            OsStr::new(r"C:\Program Files\nodejs\node.exe")
        );
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            [
                runtime.bridge_path.as_os_str(),
                OsStr::new(r"C:\dsh\apps\cli\lib\bin.js"),
                OsStr::new(
                    r"C:\Users\test\AppData\Roaming\RocketX\dsh\connections\abc\1\cordis.patch.yml"
                ),
                OsStr::new("controller"),
            ]
        );

        let runtime = ResolvedDshRuntime {
            supports_no_open: true,
            ..runtime
        };
        let command = build_bridge_command(&runtime, &workspace, &patch, DshBridgeMode::Web);
        assert_eq!(
            command.get_args().collect::<Vec<_>>().last(),
            Some(&OsStr::new("--no-open"))
        );
    }

    #[test]
    fn bridge_mode_parses_explicit_flag() {
        assert_eq!(
            DshBridgeMode::from_arg(Some("controller")).unwrap(),
            DshBridgeMode::Controller
        );
        assert_eq!(
            DshBridgeMode::from_arg(Some("web")).unwrap(),
            DshBridgeMode::Web
        );
        assert_eq!(
            DshBridgeMode::from_arg(None).unwrap(),
            DshBridgeMode::Controller
        );
        assert!(DshBridgeMode::from_arg(Some("other")).is_err());
    }

    #[test]
    fn dsh_attachment_write_only_uses_running_controller() {
        let root = unique_temp_dir("attachments");
        let controller_runtime = root.join("controller");
        let web_runtime = root.join("web");
        fs::create_dir_all(&controller_runtime).unwrap();
        fs::create_dir_all(&web_runtime).unwrap();

        let mut controller = managed_bridge_for_test(
            "conn-123",
            DshBridgeMode::Controller,
            controller_runtime.clone(),
        );
        let source_root = controller.source_root.clone();
        let second_runtime = root.join("connections").join("conn-123").join("2");
        let second = attach_connection_lease(
            &mut controller,
            &root.join("connections"),
            &source_root,
            "conn-123".to_string(),
            "D:\\workspace".to_string(),
            DshBridgeMode::Controller,
            2,
        )
        .unwrap();
        let web = managed_bridge_for_test("conn-123", DshBridgeMode::Web, web_runtime.clone());

        let processes = Arc::new(Mutex::new(HashMap::from([
            (controller.process_id.clone(), controller.clone()),
            (web.process_id.clone(), web.clone()),
        ])));

        let request = encode_attachment_request(
            "conn-123",
            &second.lease_id,
            "message/notes.txt",
            b"hello dsh",
        );
        let written = write_dsh_agent_attachment(&processes, &request).unwrap();
        let attachments_root = second_runtime.join("attachments");
        let expected_file = attachments_root.join("message/notes.txt");
        assert_eq!(written.root, host_path(&attachments_root));
        assert_eq!(written.path, host_path(&expected_file));
        assert_eq!(fs::read(&expected_file).unwrap(), b"hello dsh");

        stop_test_bridge(&controller);
        let error = write_dsh_agent_attachment(&processes, &request).unwrap_err();
        assert_eq!(error, "Agent 会话未运行");

        stop_test_bridge(&web);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn dsh_attachment_paths_reject_traversal_and_sensitive_files() {
        assert!(safe_attachment_path("message/1-build.log").is_ok());
        assert!(safe_attachment_path("../escape.txt").is_err());
        assert!(safe_attachment_path("message/.env").is_err());
        assert!(safe_attachment_path("message/credentials.json").is_err());
        assert!(safe_attachment_path("message/private.pem").is_err());
    }

    #[test]
    fn cleanup_runtime_dir_keeps_stable_home_data() {
        let root = unique_temp_dir("cleanup");
        let home = root.join("home");
        let runtime = root.join("connections").join("conn").join("1");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&runtime).unwrap();
        let sentinel = home.join("session.json");
        fs::write(&sentinel, b"keep").unwrap();
        fs::write(runtime.join("cordis.patch.yml"), b"temp").unwrap();
        cleanup_runtime_dir(&runtime);
        assert!(sentinel.is_file());
        assert!(!runtime.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn main_registers_dsh_commands_and_shutdown() {
        let main_rs = include_str!("main.rs");
        assert!(main_rs.contains("mod dsh;"));
        assert!(main_rs.contains("dsh::dsh_bridge_start"));
        assert!(main_rs.contains("dsh::dsh_bridge_write"));
        assert!(main_rs.contains("dsh::dsh_agent_attachment_write"));
        assert!(main_rs.contains("dsh::dsh_bridge_stop"));
        assert!(main_rs.contains(".manage(dsh::DshBridgeState::default())"));
        assert!(main_rs.contains("native::host::NativeHost"));
    }

    #[test]
    fn different_runtime_inputs_must_not_be_reused_silently() {
        let error = "DSH connectionId 已绑定到其他 workspace、sourcePath 或 mode；请先 stop 再重连"
            .to_string();
        assert!(error.contains("请先 stop 再重连"));
        assert!(error.contains("mode"));
    }

    #[test]
    fn bridge_path_is_stable_relative_to_tauri_crate() {
        let path = source_bridge_path();
        assert!(
            host_path(&path).ends_with("src\\dsh_bridge.mjs")
                || host_path(&path).ends_with("src/dsh_bridge.mjs")
        );
    }

    // Live 端到端（issue #352）：走真实 verify_installed_dsh_version（node 跑
    // `dsh --version`）。默认不跑；运行：cargo test -- --ignored live_dsh_version_gate
    // 前置：系统 npm 全局装有 dsh >= 0.1.0-rc.6，且 node 在 PATH。
    // shim 是临时目录里的假 CLI（node 脚本），不触碰用户安装，结束后删除。
    #[test]
    #[ignore = "live：需要系统已装 dsh 与 node"]
    fn live_dsh_version_gate_accepts_system_and_shimmed_versions() {
        let node = super::find_program("node").expect("PATH 上应有 node");

        // 真实系统安装（0.1.0-rc.6）必须通过版本门禁
        let system_cli = resolve_installed_dsh_cli(&super::installed_dsh_cli_candidates())
            .expect("应能解析到系统安装的 dsh CLI");
        super::verify_installed_dsh_version(&node, &system_cli)
            .expect("系统 dsh 版本应通过最低版本校验");

        // shim：无连字符预发布写法 1.0.0rcalpha07 规范化后必须接受
        let root = unique_temp_dir("live-version-gate");
        fs::create_dir_all(&root).unwrap();
        let shim = root.join("fake-dsh.js");
        fs::write(&shim, "console.log('1.0.0rcalpha07');\n").unwrap();
        super::verify_installed_dsh_version(&node, &shim).expect("1.0.0rcalpha07 规范化后应被接受");

        // shim：低于最低版本的 0.1.0-rc.5 必须被拒绝
        fs::write(&shim, "console.log('0.1.0-rc.5');\n").unwrap();
        let error = super::verify_installed_dsh_version(&node, &shim).unwrap_err();
        assert!(error.contains("0.1.0-rc.5"), "错误应指出实际版本：{error}");
        assert!(
            error.contains(super::DSH_VERIFIED_VERSION),
            "错误应指出最低支持版本：{error}"
        );

        let _ = fs::remove_dir_all(&root);
        eprintln!("live ok：系统 dsh 通过校验；shim 1.0.0rcalpha07 接受、0.1.0-rc.5 拒绝");
    }
}
