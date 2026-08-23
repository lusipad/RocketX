//! Codex executable discovery and path normalization.
//!
//! Candidate probing remains in `proc.rs`; this module only answers where a
//! runtime may live and how a candidate is represented as a child command.

use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
    process::Stdio,
};

use tauri::Manager;

use super::{
    codex_contract::CodexRuntimeSource,
    codex_process::ResolvedCodex,
    process::{hidden_command, host_path},
};

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

pub(crate) fn resolved_codex_path(
    path: &Path,
    source: CodexRuntimeSource,
) -> Result<ResolvedCodex, String> {
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("Codex 路径不可用：{error}"))?;
    let canonical = PathBuf::from(host_path(&canonical));
    if !canonical.is_file() {
        return Err("Codex 路径不是文件".to_string());
    }
    let name = canonical
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    if name != "codex.exe" && name != "codex.cmd" && name != "codex" {
        return Err("请选择 codex.exe 或 codex.cmd".to_string());
    }
    #[cfg(windows)]
    if name == "codex.cmd" {
        let entry = canonical
            .parent()
            .unwrap_or_else(|| Path::new(""))
            .join("node_modules")
            .join("@openai")
            .join("codex")
            .join("bin")
            .join("codex.js");
        if !entry.is_file() {
            return Err("codex.cmd 缺少对应的 @openai/codex 安装文件".to_string());
        }
        let node = canonical
            .parent()
            .map(|parent| parent.join("node.exe"))
            .filter(|candidate| candidate.is_file())
            .or_else(|| find_program("node.exe"))
            .ok_or_else(|| "未检测到 Node.js，无法运行 codex.cmd".to_string())?;
        return Ok(ResolvedCodex {
            program: node,
            prefix_args: vec![entry.into_os_string()],
            display_path: canonical.to_string_lossy().into_owned(),
            source,
            version: String::new(),
        });
    }
    Ok(ResolvedCodex {
        program: canonical.clone(),
        prefix_args: Vec::new(),
        display_path: canonical.to_string_lossy().into_owned(),
        source,
        version: String::new(),
    })
}

#[cfg(windows)]
pub(crate) fn standard_codex_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(app_data) = std::env::var_os("APPDATA") {
        paths.push(PathBuf::from(app_data).join("npm").join("codex.cmd"));
    }
    if let Some(user_profile) = std::env::var_os("USERPROFILE") {
        paths.push(
            PathBuf::from(user_profile)
                .join("Codex")
                .join("_internal")
                .join("app")
                .join("resources")
                .join("codex.exe"),
        );
    }
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        let local = PathBuf::from(local_app_data);
        paths.push(
            local
                .join("Programs")
                .join("Codex")
                .join("resources")
                .join("codex.exe"),
        );
        paths.push(local.join("Codex").join("resources").join("codex.exe"));
        paths.push(local.join("Codex").join("codex.exe"));
    }
    paths
}

#[cfg(not(windows))]
pub(crate) fn standard_codex_paths() -> Vec<PathBuf> {
    Vec::new()
}

pub(crate) fn bundled_codex_paths(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let executable = if cfg!(windows) { "codex.exe" } else { "codex" };
    let mut paths = Vec::new();
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        paths.push(
            PathBuf::from(local_app_data)
                .join("RocketX")
                .join("resources")
                .join("codex")
                .join("bin")
                .join(executable),
        );
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        paths.push(resource_dir.join("codex").join("bin").join(executable));
    }
    paths.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("codex-resources")
            .join("codex")
            .join("bin")
            .join(executable),
    );
    paths
}

pub(crate) fn system_codex_paths() -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        ["codex.cmd", "codex.exe"]
            .into_iter()
            .filter_map(find_program)
            .collect()
    }
    #[cfg(not(windows))]
    {
        find_program("codex").into_iter().collect()
    }
}
