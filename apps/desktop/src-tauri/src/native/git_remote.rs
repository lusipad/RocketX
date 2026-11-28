use std::path::{Path, PathBuf};

use tauri_plugin_http::reqwest;

use crate::native::process::hidden_command;

pub(crate) fn validate_repo_segment(raw: &str, label: &str) -> Result<String, String> {
    let clean = raw.trim();
    if clean.is_empty()
        || clean == "."
        || clean == ".."
        || clean.len() > 100
        || !clean
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    {
        return Err(format!("无效的 GitHub {label}：{clean}"));
    }
    Ok(clean.to_string())
}

pub(crate) fn parse_github_remote_url(remote_url: &str) -> Option<(String, String)> {
    let trimmed = remote_url.trim();
    if trimmed.is_empty() || trimmed.contains("/_git/") {
        return None;
    }
    let cleaned = trimmed.trim_end_matches('/').trim_end_matches(".git");
    if let Some((left, right)) = cleaned.split_once(':') {
        if !left.contains("://") && left.contains('@') {
            let host = left.split('@').nth(1).unwrap_or("");
            if host.contains("github") {
                let mut parts = right.trim_start_matches('/').split('/');
                let owner = parts.next()?;
                let repo = parts.next()?;
                if parts.next().is_some() {
                    return None;
                }
                let ok_owner = validate_repo_segment(owner, "owner").ok()?;
                let ok_repo = validate_repo_segment(repo, "repo").ok()?;
                return Some((ok_owner, ok_repo));
            }
        }
    }
    let parsed = reqwest::Url::parse(cleaned).ok()?;
    let host = parsed.host_str()?.to_ascii_lowercase();
    let is_supported_host =
        host.contains("github") || matches!(host.as_str(), "127.0.0.1" | "localhost" | "::1");
    if !is_supported_host {
        return None;
    }
    let mut segments = parsed.path_segments()?.filter(|s| !s.is_empty());
    let owner = segments.next()?;
    let repo = segments.next()?;
    if segments.next().is_some() {
        return None;
    }
    let ok_owner = validate_repo_segment(owner, "owner").ok()?;
    let ok_repo = validate_repo_segment(repo, "repo").ok()?;
    Some((ok_owner, ok_repo))
}

fn run_git_trimmed(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let output = hidden_command("git")
        .current_dir(cwd)
        .args(args)
        .output()
        .map_err(|error| format!("无法执行 git 命令：{error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if !stderr.is_empty() { stderr } else { stdout };
        return Err(if detail.is_empty() {
            format!("git {:?} 退出码异常", args)
        } else {
            detail
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

pub(crate) fn read_workspace_origin_url(workspace_root: &str) -> Result<Option<String>, String> {
    let trimmed = workspace_root.trim();
    if trimmed.is_empty() {
        return Err("工作区路径不能为空".to_string());
    }
    let ws = PathBuf::from(trimmed);
    if !ws.is_dir() {
        return Err("工作区目录不存在".to_string());
    }
    let canonical_ws = ws.canonicalize().unwrap_or(ws);
    let top_raw = run_git_trimmed(&canonical_ws, &["rev-parse", "--show-toplevel"])?;
    let top_path = PathBuf::from(&top_raw);
    let canonical_top = top_path.canonicalize().unwrap_or(top_path);
    let url = run_git_trimmed(&canonical_top, &["remote", "get-url", "origin"]).unwrap_or_default();
    let remote = url.trim().to_string();
    Ok((!remote.is_empty()).then_some(remote))
}
