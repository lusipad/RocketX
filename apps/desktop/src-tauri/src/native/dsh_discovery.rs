//! DSH runtime discovery and packaging paths.
//!
//! The command facade owns bridge lifecycle and IPC. This module owns the
//! deterministic search policy for source, installed, and bundled runtimes.

use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
    process::Stdio,
};

use tauri::Manager;

use super::{
    dsh_process::ResolvedDshRuntime,
    dsh_runtime::{node_version_is_compatible, parse_dsh_version},
    process::{hidden_command, host_path},
};

pub(crate) const DSH_VERIFIED_VERSION: &str = "0.1.0-rc.6";
pub(crate) const DSH_NO_OPEN_VERSION: &str = "0.1.0-rc.7";
pub(crate) const DSH_ROOT_DIR: &str = "dsh";
pub(crate) const DSH_BUNDLED_RUNTIME_DIR: &str = "dsh-runtime";
pub(crate) const DSH_BUNDLED_RUNTIME_ARCHIVE: &str = "dsh-runtime.tar.gz";
pub(crate) const DSH_BUNDLED_RUNTIME_CACHE_DIR: &str = "bundled-runtime";
pub(crate) const DSH_BUNDLED_RUNTIME_SHA_MARKER: &str = ".archive-sha256";
pub(crate) const DSH_HOME_SUBDIR: &str = "home";
pub(crate) const DSH_CONNECTIONS_SUBDIR: &str = "connections";
pub(crate) const DSH_SOURCE_CLI_ENTRY: [&str; 4] = ["apps", "cli", "lib", "bin.js"];
pub(crate) const DSH_BUNDLED_CLI_ENTRY: [&str; 5] =
    ["node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"];
pub(crate) const DSH_BRIDGE_ENTRY: [&str; 2] = ["src", "dsh_bridge.mjs"];
pub(crate) const DSH_BUNDLED_BRIDGE_ENTRY: &str = "dsh_bridge.mjs";

#[cfg(windows)]
pub(crate) fn find_program(name: &str) -> Option<PathBuf> {
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
pub(crate) fn find_program(name: &str) -> Option<PathBuf> {
    std::env::var_os("PATH")
        .into_iter()
        .flat_map(|value| std::env::split_paths(&value).collect::<Vec<_>>())
        .map(|directory| directory.join(name))
        .find(|path| path.is_file())
}

pub(crate) fn derive_source_root(candidate: &Path) -> PathBuf {
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

pub(crate) fn source_dsh_cli_entry(root: &Path) -> PathBuf {
    DSH_SOURCE_CLI_ENTRY
        .iter()
        .fold(root.to_path_buf(), |path, segment| path.join(segment))
}

pub(crate) fn bundled_dsh_cli_entry(root: &Path) -> PathBuf {
    DSH_BUNDLED_CLI_ENTRY
        .iter()
        .fold(root.to_path_buf(), |path, segment| path.join(segment))
}

pub(crate) fn installed_dsh_cli_entry(node_modules_root: &Path) -> PathBuf {
    ["@deepseek-ai", "dsh", "lib", "bin.js"]
        .iter()
        .fold(node_modules_root.to_path_buf(), |path, segment| {
            path.join(segment)
        })
}

pub(crate) fn pnpm_global_dsh_cli_candidates(pnpm_home: &Path) -> Vec<PathBuf> {
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
pub(crate) fn windows_dsh_shim_cli_candidates(shim: &Path) -> Vec<PathBuf> {
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

pub(crate) fn source_bridge_path() -> PathBuf {
    DSH_BRIDGE_ENTRY.iter().fold(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")),
        |path, segment| path.join(segment),
    )
}

pub(crate) fn packaged_bridge_candidates(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        paths.push(resource_dir.join(DSH_BUNDLED_BRIDGE_ENTRY));
    }
    if cfg!(debug_assertions) {
        paths.push(source_bridge_path());
    }
    paths
}

pub(crate) fn resolve_packaged_bridge(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    packaged_bridge_candidates(app)
        .into_iter()
        .find(|path| path.is_file())
        .and_then(|path| std::fs::canonicalize(path).ok())
        .map(|path| PathBuf::from(host_path(&path)))
        .ok_or_else(|| "DSH bridge 脚本缺失；请重新安装 RocketX".to_string())
}

pub(crate) fn bundled_bridge_path(root: &Path) -> PathBuf {
    root.join(DSH_BUNDLED_BRIDGE_ENTRY)
}

pub(crate) fn development_bundled_runtime_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join(DSH_BUNDLED_RUNTIME_DIR)
}

pub(crate) fn development_bundled_runtime_archive() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join(DSH_BUNDLED_RUNTIME_ARCHIVE)
}

pub(crate) fn bundled_runtime_cache_root(dsh_root: &Path) -> PathBuf {
    dsh_root.join(DSH_BUNDLED_RUNTIME_CACHE_DIR)
}

pub(crate) fn bundled_runtime_sha_marker_path(root: &Path) -> PathBuf {
    root.join(DSH_BUNDLED_RUNTIME_SHA_MARKER)
}

pub(crate) fn validate_bundled_runtime_root(root: &Path) -> Result<(), String> {
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

pub(crate) fn canonicalize_bundled_runtime_root(root: &Path) -> Result<PathBuf, String> {
    validate_bundled_runtime_root(root)?;
    let root =
        std::fs::canonicalize(root).map_err(|error| format!("DSH 运行时目录不可用：{error}"))?;
    Ok(PathBuf::from(host_path(&root)))
}

pub(crate) fn bundled_runtime_marker_matches(root: &Path, expected_sha: &str) -> bool {
    std::fs::read_to_string(bundled_runtime_sha_marker_path(root))
        .map(|value| value.trim() == expected_sha)
        .unwrap_or(false)
}

pub(crate) fn bundled_runtime_is_current(root: &Path, expected_sha: &str) -> bool {
    root.symlink_metadata().is_ok()
        && bundled_runtime_marker_matches(root, expected_sha)
        && validate_bundled_runtime_root(root).is_ok()
}

pub(crate) fn explicit_or_env_source_candidate(explicit: Option<&str>) -> Option<PathBuf> {
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

pub(crate) fn resolve_source_root(candidate: &Path) -> Result<PathBuf, String> {
    let root = derive_source_root(candidate);
    let root =
        std::fs::canonicalize(&root).map_err(|error| format!("DSH 源码路径不可用：{error}"))?;
    let cli_path = source_dsh_cli_entry(&root);
    if !cli_path.is_file() {
        return Err("DSH CLI 未构建：缺少 apps/cli/lib/bin.js".to_string());
    }
    Ok(PathBuf::from(host_path(&root)))
}

pub(crate) fn source_root_from_candidates(
    explicit: Option<&str>,
) -> Result<Option<PathBuf>, String> {
    if let Some(candidate) = explicit_or_env_source_candidate(explicit) {
        return resolve_source_root(&candidate).map(Some);
    }
    Ok(None)
}

pub(crate) fn installed_dsh_cli_candidates() -> Vec<PathBuf> {
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

pub(crate) fn resolve_installed_dsh_cli(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates
        .iter()
        .filter(|path| path.is_file())
        .find_map(|path| std::fs::canonicalize(path).ok())
        .map(|path| PathBuf::from(host_path(&path)))
}

pub(crate) fn installed_dsh_root(cli_path: &Path) -> PathBuf {
    cli_path
        .parent()
        .and_then(Path::parent)
        .unwrap_or(cli_path)
        .to_path_buf()
}

pub(crate) fn bundled_runtime_archive_candidates(app: &tauri::AppHandle) -> Vec<PathBuf> {
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

pub(crate) fn bundled_node_paths(app: &tauri::AppHandle) -> Vec<PathBuf> {
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

pub(crate) fn node_runtime_candidates(
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

pub(crate) fn probe_node_runtime(program: &Path) -> Result<(PathBuf, String), String> {
    let output = hidden_command(program)
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
    Ok((PathBuf::from(host_path(program)), version))
}

pub(crate) fn incompatible_node_message(version: &str) -> String {
    format!("Node.js 版本 {version} 不兼容；DSH 运行需要 22.19+ 或 24+")
}

pub(crate) fn resolve_node_runtime(
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

pub(crate) fn verify_installed_dsh_version(
    node_path: &Path,
    cli_path: &Path,
) -> Result<bool, String> {
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

pub(crate) fn dsh_version_is_compatible(version: &str) -> bool {
    match (
        parse_dsh_version(version),
        parse_dsh_version(DSH_VERIFIED_VERSION),
    ) {
        (Some(version), Some(minimum)) => version >= minimum,
        _ => false,
    }
}

pub(crate) fn dsh_version_is_unverified_newer(version: &str) -> bool {
    match (
        parse_dsh_version(version),
        parse_dsh_version(DSH_VERIFIED_VERSION),
    ) {
        (Some(version), Some(verified)) => version > verified,
        _ => false,
    }
}

pub(crate) fn dsh_version_supports_no_open(version: &str) -> bool {
    match (
        parse_dsh_version(version),
        parse_dsh_version(DSH_NO_OPEN_VERSION),
    ) {
        (Some(version), Some(minimum)) => version >= minimum,
        _ => false,
    }
}

pub(crate) fn dsh_root_paths(app: &tauri::AppHandle) -> Result<(PathBuf, PathBuf), String> {
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

pub(crate) fn resolve_dsh_runtime(
    app: &tauri::AppHandle,
    source_path: Option<&str>,
    prepare_bundled_runtime: impl Fn(&tauri::AppHandle, &Path) -> Result<PathBuf, String>,
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
            let bundled_root = prepare_bundled_runtime(app, &dsh_root)?;
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

pub(crate) fn resolve_bundled_runtime_root(root: &Path) -> Result<PathBuf, String> {
    canonicalize_bundled_runtime_root(root)
}

pub(crate) fn resolve_debug_bundled_runtime_root() -> Result<Option<PathBuf>, String> {
    if !cfg!(debug_assertions) {
        return Ok(None);
    }
    let root = development_bundled_runtime_root();
    if !root.is_dir() {
        return Ok(None);
    }
    resolve_bundled_runtime_root(&root).map(Some).or(Ok(None))
}

pub(crate) fn resolve_bundled_runtime_archive(candidates: &[PathBuf]) -> Result<PathBuf, String> {
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
