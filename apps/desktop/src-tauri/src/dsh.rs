use std::{
    collections::HashMap,
    ffi::OsStr,
    fs::File,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use flate2::read::GzDecoder;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tar::Archive;
use tauri::{Emitter, Manager};

const MAX_MESSAGE_BYTES: usize = 2 * 1024 * 1024;
const MIN_NODE_22_MINOR: u64 = 19;
const DSH_SHUTDOWN_GRACE_PERIOD: Duration = Duration::from_secs(5);
const DSH_VERIFIED_VERSION: &str = "0.1.0-rc.6";
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
    connection_id: String,
    workspace_root: String,
    source_root: String,
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<ChildStdin>>,
    runtime_dir: PathBuf,
}

#[derive(Default)]
pub struct DshBridgeState {
    processes: Arc<Mutex<HashMap<String, ManagedDshBridge>>>,
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
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DshBridgeInfo {
    process_id: String,
}

#[derive(Clone)]
struct ResolvedDshRuntime {
    source_root: PathBuf,
    cli_path: PathBuf,
    node_path: PathBuf,
    bridge_path: PathBuf,
    dsh_root: PathBuf,
    home_root: PathBuf,
}

fn hidden_command(program: impl AsRef<OsStr>) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
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

fn canonical_directory(path: &str) -> Result<PathBuf, String> {
    let resolved =
        std::fs::canonicalize(path).map_err(|error| format!("DSH 工作区不可用：{error}"))?;
    if !resolved.is_dir() {
        return Err("DSH 工作区必须是目录".to_string());
    }
    Ok(PathBuf::from(host_path(&resolved)))
}

fn debug_sibling_dsh_root() -> Option<PathBuf> {
    if !cfg!(debug_assertions) {
        return None;
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(4)
        .map(|path| path.join("deepseek-harness"))
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
    let Some(candidate) = debug_sibling_dsh_root() else {
        return Ok(None);
    };
    let root = derive_source_root(&candidate);
    if !source_dsh_cli_entry(&root).is_file() {
        return Ok(None);
    }
    resolve_source_root(&candidate).map(Some)
}

fn installed_dsh_cli_candidates() -> Vec<PathBuf> {
    let mut paths = Vec::new();
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
        if let Some(pnpm_home) = std::env::var_os("PNPM_HOME") {
            for generation in ["5", "6"] {
                paths.push(installed_dsh_cli_entry(
                    &PathBuf::from(&pnpm_home)
                        .join("global")
                        .join(generation)
                        .join("node_modules"),
                ));
            }
        }
        for shim_name in ["dsh.cmd", "dsh.ps1", "dsh"] {
            if let Some(shim) = find_program(shim_name) {
                if let Some(prefix) = shim.parent() {
                    paths.push(installed_dsh_cli_entry(&prefix.join("node_modules")));
                }
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
            paths.push(installed_dsh_cli_entry(
                &PathBuf::from(home)
                    .join(".npm-global")
                    .join("lib")
                    .join("node_modules"),
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
    Err("未找到随 RocketX 分发的 DSH 运行时归档；请先运行 pnpm prepare:dsh-runtime，并确认 dsh-runtime.tar.gz 资源已随安装包分发".to_string())
}

fn prepare_bundled_runtime_root_from_archive(
    archive_path: &Path,
    dsh_root: &Path,
) -> Result<PathBuf, String> {
    let archive_sha = compute_sha256(archive_path)?;
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

fn parse_node_version(value: &str) -> Option<(u64, u64, u64)> {
    let version = value.trim().trim_start_matches('v');
    let core = version.split(['-', '+']).next()?;
    let mut parts = core.split('.');
    let parsed = (
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
    );
    parts.next().is_none().then_some(parsed)
}

fn node_version_is_compatible(value: &str) -> bool {
    match parse_node_version(value) {
        Some((22, minor, _)) => minor >= MIN_NODE_22_MINOR,
        Some((major, _, _)) => major >= 24,
        None => false,
    }
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
        return Err(format!(
            "Node.js 版本 {version} 不兼容；DSH 运行需要 22.19+ 或 24+"
        ));
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

fn verify_installed_dsh_version(node_path: &Path, cli_path: &Path) -> Result<(), String> {
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
            "已安装的 DSH 版本 {version} 不兼容；RocketX 当前验证版本为 {DSH_VERIFIED_VERSION}"
        ));
    }
    Ok(())
}

fn dsh_version_is_compatible(version: &str) -> bool {
    version.trim() == DSH_VERIFIED_VERSION
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
    if verify_installed_version {
        verify_installed_dsh_version(&node_path, &cli_path)?;
    }
    Ok(ResolvedDshRuntime {
        source_root,
        cli_path,
        node_path,
        bridge_path,
        dsh_root,
        home_root,
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

fn graceful_shutdown_message() -> &'static [u8] {
    b"{\"kind\":\"shutdown\"}\n"
}

fn yaml_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn business_mcp_patch_text(
    patch_key: &str,
    workspace_root: &str,
    command: &str,
) -> Result<String, String> {
    let suffix = patch_key
        .replace('-', "_")
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || *character == '_')
        .collect::<String>();
    let server_name = format!("rocketx_{suffix}");
    if server_name.len() > 32 {
        return Err("DSH MCP server name exceeds 32 characters".to_string());
    }
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
        yaml_quote(workspace_root),
    ))
}

fn cleanup_runtime_dir(runtime_dir: &Path) {
    let _ = std::fs::remove_dir_all(runtime_dir);
}

fn write_business_mcp_patch(
    runtime_dir: &Path,
    patch_key: &str,
    workspace_root: &str,
) -> Result<PathBuf, String> {
    let command =
        std::env::current_exe().map_err(|error| format!("无法定位 RocketX 可执行文件：{error}"))?;
    let patch = business_mcp_patch_text(patch_key, workspace_root, &host_path(&command))?;
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

fn process_is_running(process: &ManagedDshBridge) -> bool {
    process
        .child
        .lock()
        .map(|mut child| matches!(child.try_wait(), Ok(None)))
        .unwrap_or(false)
}

fn build_bridge_command(
    runtime: &ResolvedDshRuntime,
    workspace_root: &Path,
    patch_path: &Path,
) -> Command {
    let mut command = hidden_command(&runtime.node_path);
    command
        .arg(&runtime.bridge_path)
        .arg(&runtime.cli_path)
        .arg(patch_path)
        .current_dir(workspace_root)
        .env("DSH_HOME", &runtime.home_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

fn spawn_reader<R: std::io::Read + Send + 'static>(
    app: tauri::AppHandle,
    process_id: String,
    stream: &'static str,
    reader: R,
) {
    thread::spawn(move || {
        for line in BufReader::new(reader).lines() {
            let Ok(line) = line else { break };
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

fn stop_process(process: ManagedDshBridge) -> Result<(), String> {
    if let Ok(mut stdin) = process.stdin.lock() {
        let _ = stdin.write_all(graceful_shutdown_message());
        let _ = stdin.flush();
    }

    let deadline = Instant::now() + DSH_SHUTDOWN_GRACE_PERIOD;
    loop {
        let status = process
            .child
            .lock()
            .map_err(|_| "DSH bridge 进程不可用".to_string())?
            .try_wait()
            .map_err(|error| format!("无法检查 DSH bridge 退出状态：{error}"))?;
        if status.is_some() {
            cleanup_runtime_dir(&process.runtime_dir);
            return Ok(());
        }
        if Instant::now() >= deadline {
            break;
        }
        thread::sleep(Duration::from_millis(50));
    }

    let mut child = process
        .child
        .lock()
        .map_err(|_| "DSH bridge 进程不可用".to_string())?;
    force_stop_process_tree(&mut child)
        .map_err(|error| format!("failed to stop DSH bridge: {error}"))?;
    let _ = child.wait();
    cleanup_runtime_dir(&process.runtime_dir);
    Ok(())
}

fn monitor_child(
    app: tauri::AppHandle,
    state: Arc<Mutex<HashMap<String, ManagedDshBridge>>>,
    process_id: String,
    child: Arc<Mutex<Child>>,
) {
    thread::spawn(move || loop {
        let status = match child.lock() {
            Ok(mut child) => child.try_wait(),
            Err(_) => return,
        };
        match status {
            Ok(Some(status)) => {
                let process = state
                    .lock()
                    .ok()
                    .and_then(|mut processes| processes.remove(&process_id));
                if let Some(process) = process {
                    cleanup_runtime_dir(&process.runtime_dir);
                }
                let _ = app.emit(
                    "dsh-bridge-exit",
                    DshExitEvent {
                        process_id,
                        code: status.code(),
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
    next_id: Arc<AtomicU64>,
    connection_id: String,
    workspace_root: String,
    source_path: Option<String>,
) -> Result<DshBridgeInfo, String> {
    validate_connection_id(&connection_id)?;
    let workspace_root = canonical_directory(workspace_root.trim())?;
    let runtime = resolve_dsh_runtime(&app, source_path.as_deref())?;
    let workspace_root_display = host_path(&workspace_root);

    let existing = {
        let mut processes = processes
            .lock()
            .map_err(|_| "DSH bridge 进程注册表不可用".to_string())?;
        let existing_id = processes
            .values()
            .find(|process| process.connection_id == connection_id)
            .map(|process| process.process_id.clone());
        if let Some(process_id) = existing_id {
            if let Some(process) = processes.get(&process_id) {
                if process_is_running(process)
                    && (process.workspace_root != workspace_root_display
                        || process.source_root != host_path(&runtime.source_root))
                {
                    return Err(
                        "DSH connectionId 已绑定到其他 workspace 或 sourcePath；请先 stop 再重连"
                            .to_string(),
                    );
                }
            }
            processes.remove(&process_id)
        } else {
            None
        }
    };
    if let Some(existing) = existing {
        stop_process(existing)?;
    }

    let instance_id = next_id.fetch_add(1, Ordering::Relaxed);
    let connections_root = runtime.dsh_root.join(DSH_CONNECTIONS_SUBDIR);
    let runtime_dir = runtime_directory(&connections_root, &connection_id, instance_id)?;
    let patch_key = format!("{connection_id}-{instance_id}");
    let patch_path = write_business_mcp_patch(&runtime_dir, &patch_key, &workspace_root_display)?;
    let mut child = build_bridge_command(&runtime, &workspace_root, &patch_path)
        .spawn()
        .map_err(|error| format!("无法启动 DSH bridge：{error}"))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "DSH bridge stdin 不可用".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "DSH bridge stdout 不可用".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "DSH bridge stderr 不可用".to_string())?;
    let process_id = format!("dsh-{}-{instance_id}", child.id());
    let child = Arc::new(Mutex::new(child));
    let managed = ManagedDshBridge {
        process_id: process_id.clone(),
        connection_id: connection_id.clone(),
        workspace_root: workspace_root_display.clone(),
        source_root: host_path(&runtime.source_root),
        child: Arc::clone(&child),
        stdin: Arc::new(Mutex::new(stdin)),
        runtime_dir: runtime_dir.clone(),
    };
    let info = DshBridgeInfo {
        process_id: process_id.clone(),
    };
    processes
        .lock()
        .map_err(|_| "DSH bridge 进程注册表不可用".to_string())?
        .insert(process_id.clone(), managed);
    spawn_reader(app.clone(), process_id.clone(), "stdout", stdout);
    spawn_reader(app.clone(), process_id.clone(), "stderr", stderr);
    monitor_child(app, processes, process_id, child);
    Ok(info)
}

#[tauri::command]
pub fn dsh_bridge_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, DshBridgeState>,
    connection_id: String,
    workspace_root: String,
    source_path: Option<String>,
) -> Result<DshBridgeInfo, String> {
    start_dsh_bridge_blocking(
        app,
        Arc::clone(&state.processes),
        Arc::clone(&state.next_id),
        connection_id,
        workspace_root,
        source_path,
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
pub fn dsh_bridge_stop(
    state: tauri::State<'_, DshBridgeState>,
    process_id: String,
) -> Result<(), String> {
    let process = state
        .processes
        .lock()
        .map_err(|_| "DSH bridge 进程注册表不可用".to_string())?
        .remove(&process_id)
        .ok_or_else(|| "DSH bridge 进程未运行".to_string())?;
    stop_process(process)
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
}

#[cfg(test)]
mod tests {
    use super::{
        build_bridge_command, bundled_bridge_path, bundled_dsh_cli_entry, business_mcp_patch_text,
        cleanup_runtime_dir, debug_sibling_dsh_root, development_bundled_runtime_archive,
        development_bundled_runtime_root, dsh_version_is_compatible, encode_message,
        graceful_shutdown_message, host_path, installed_dsh_cli_entry, installed_dsh_root,
        node_runtime_candidates, node_version_is_compatible,
        prepare_bundled_runtime_root_from_archive, resolve_bundled_runtime_root,
        resolve_installed_dsh_cli, resolve_source_root, source_bridge_path, source_dsh_cli_entry,
        source_root_from_candidates, validate_connection_id, ResolvedDshRuntime,
    };
    use flate2::{write::GzEncoder, Compression};
    use serde_json::json;
    use std::{ffi::OsStr, fs, fs::File, path::PathBuf};
    use tar::Builder;

    fn unique_temp_dir(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "rocketx-dsh-tests-{label}-{}",
            uuid::Uuid::new_v4()
        ))
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
    fn node_compatibility_matches_dsh_source_contract() {
        assert!(node_version_is_compatible("v22.19.0"));
        assert!(node_version_is_compatible("v24.0.0"));
        assert!(node_version_is_compatible("v26.1.0"));
        assert!(!node_version_is_compatible("v22.18.0"));
        assert!(!node_version_is_compatible("v23.9.0"));
        assert!(!node_version_is_compatible("nightly"));
    }

    #[test]
    fn installed_dsh_requires_the_verified_version() {
        assert!(dsh_version_is_compatible("0.1.0-rc.6"));
        assert!(dsh_version_is_compatible(" 0.1.0-rc.6\n"));
        assert!(!dsh_version_is_compatible("0.1.0-rc.5"));
        assert!(!dsh_version_is_compatible("0.1.0-rc.7"));
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
        };
        let patch = PathBuf::from(
            r"C:\Users\test\AppData\Roaming\RocketX\dsh\connections\abc\1\cordis.patch.yml",
        );
        let workspace = PathBuf::from(r"C:\workspace");
        let command = build_bridge_command(&runtime, &workspace, &patch);
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
            ]
        );
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
        assert!(main_rs.contains("dsh::dsh_bridge_stop"));
        assert!(main_rs.contains(".manage(dsh::DshBridgeState::default())"));
        assert!(main_rs.contains("dsh::shutdown(app);"));
    }

    #[test]
    fn different_runtime_inputs_must_not_be_reused_silently() {
        let error =
            "DSH connectionId 已绑定到其他 workspace 或 sourcePath；请先 stop 再重连".to_string();
        assert!(error.contains("请先 stop 再重连"));
    }

    #[test]
    fn bridge_path_is_stable_relative_to_tauri_crate() {
        let path = source_bridge_path();
        assert!(
            host_path(&path).ends_with("src\\dsh_bridge.mjs")
                || host_path(&path).ends_with("src/dsh_bridge.mjs")
        );
    }

    #[test]
    fn debug_sibling_root_points_to_repo_sibling_not_nested_under_rocketchatx() {
        let path = debug_sibling_dsh_root().expect("debug tests should resolve sibling DSH repo");
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let repository = manifest.ancestors().nth(3).expect("repository root");
        assert_eq!(
            path,
            repository
                .parent()
                .expect("repository parent")
                .join("deepseek-harness")
        );
        assert!(!path.starts_with(repository));
    }
}
