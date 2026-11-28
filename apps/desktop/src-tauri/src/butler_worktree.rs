use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Manager;

use crate::native::process::{hidden_command, host_path};

const MANAGED_WORKTREES_DIR: &str = "worktrees";
const MAX_DIFF_FILE_BYTES: usize = 256 * 1024;
const MAX_DIFF_TOTAL_BYTES: usize = 2 * 1024 * 1024;
const CHECKPOINT_REF_PREFIX: &str = "refs/rocketx/checkpoints/";

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffFileSummary {
    pub path: String,
    pub status: String,
    pub staged: bool,
    pub unstaged: bool,
    pub additions: u32,
    pub deletions: u32,
    pub binary: bool,
    pub patch: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorkspaceDiff {
    pub workspace_root: String,
    pub repo_top_level: String,
    pub branch: Option<String>,
    pub head_sha: Option<String>,
    pub base_ref: Option<String>,
    pub compare_ref: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub total_additions: u32,
    pub total_deletions: u32,
    pub files: Vec<GitDiffFileSummary>,
    pub truncated_total: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCheckpointRecord {
    pub id: String,
    pub ref_name: String,
    pub commit_sha: String,
    pub tree_sha: String,
    pub label: String,
    pub turn_id: Option<String>,
    pub created_at: i64,
    pub changed_files: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitResult {
    pub commit_sha: String,
    pub branch: Option<String>,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitPushResult {
    pub remote: String,
    pub branch: String,
    pub output: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCreatePrResult {
    pub created: bool,
    pub url: Option<String>,
    pub fallback_compare_url: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktreeItem {
    pub path: String,
    pub head_sha: Option<String>,
    pub branch: Option<String>,
    pub bare: bool,
    pub detached: bool,
    pub locked: bool,
    pub prunable: bool,
    pub is_current: bool,
    pub is_managed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchItem {
    pub name: String,
    pub current: bool,
    pub upstream: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitSnapshot {
    pub content_fingerprint: String,
    pub workspace_root: String,
    pub repo_top_level: String,
    pub branch: Option<String>,
    pub head_sha: Option<String>,
    pub is_worktree: bool,
    pub dirty_files: Vec<String>,
    pub diff_stat: Option<String>,
    pub recent_commits: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareWorktreeInput {
    pub repo_root: String,
    pub branch_name: String,
    pub base_ref: Option<String>,
    pub slug: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedWorktreeInfo {
    pub worktree_path: String,
    pub repo_top_level: String,
    pub branch: String,
    pub head_sha: String,
    pub reused: bool,
}

fn run_git(cwd: &Path, args: &[&str]) -> Result<String, String> {
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

fn hash_git_output(cwd: &Path, args: &[&str], hasher: &mut blake3::Hasher) -> Result<(), String> {
    let mut child = hidden_command("git")
        .current_dir(cwd)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("无法读取Git内容指纹：{e}"))?;
    let output = child.stdout.take().ok_or("无法读取Git输出流")?;
    if let Err(error) = hasher.update_reader(output) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!("无法读取Git内容指纹：{error}"));
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    if !status.success() {
        return Err(format!("Git内容指纹读取失败：{status}"));
    }
    Ok(())
}

fn workspace_content_fingerprint(root: &Path, head_sha: Option<&str>) -> Result<String, String> {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"rocketx-workspace-v1\0HEAD\0");
    hasher.update(head_sha.unwrap_or("unborn").as_bytes());
    hasher.update(b"\0WORKTREE\0");
    if head_sha.is_some() {
        hash_git_output(
            root,
            &[
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--binary",
                "HEAD",
                "--",
            ],
            &mut hasher,
        )?;
        hasher.update(b"\0INDEX\0");
        hash_git_output(
            root,
            &[
                "diff",
                "--cached",
                "--no-ext-diff",
                "--no-textconv",
                "--binary",
                "HEAD",
                "--",
            ],
            &mut hasher,
        )?;
    } else {
        // An unborn repository may already contain staged files.
        hash_git_output(
            root,
            &["diff", "--no-ext-diff", "--no-textconv", "--binary", "--"],
            &mut hasher,
        )?;
        hasher.update(b"\0INDEX\0");
        hash_git_output(
            root,
            &[
                "diff",
                "--cached",
                "--no-ext-diff",
                "--no-textconv",
                "--binary",
                "--",
            ],
            &mut hasher,
        )?;
    }
    let untracked = hidden_command("git")
        .current_dir(root)
        .args(["ls-files", "--others", "--exclude-standard", "-z"])
        .output()
        .map_err(|e| format!("无法读取未跟踪文件：{e}"))?;
    if !untracked.status.success() {
        return Err("无法核对未跟踪文件".into());
    }
    let mut names = untracked
        .stdout
        .split(|byte| *byte == 0)
        .filter(|name| !name.is_empty())
        .collect::<Vec<_>>();
    names.sort_unstable();
    for name in names {
        let name_str = std::str::from_utf8(name).map_err(|_| "未跟踪文件路径不是有效UTF-8")?;
        let relative = Path::new(name_str);
        if relative.is_absolute()
            || relative
                .components()
                .any(|part| matches!(part, std::path::Component::ParentDir))
        {
            return Err("未跟踪文件路径超出工作区".into());
        }
        let path = root.join(relative);
        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|e| format!("未跟踪文件已变化，请重新核对：{e}"))?;
        let mut file_hash = blake3::Hasher::new();
        if metadata.file_type().is_symlink() {
            file_hash.update(b"symlink\0");
            file_hash.update(
                std::fs::read_link(&path)
                    .map_err(|e| e.to_string())?
                    .to_string_lossy()
                    .as_bytes(),
            );
        } else {
            let canonical = path.canonicalize().map_err(|e| e.to_string())?;
            if !canonical.starts_with(root) || !metadata.is_file() {
                return Err("未跟踪文件路径超出工作区或不可读取".into());
            }
            file_hash.update(b"file\0");
            file_hash
                .update_reader(std::fs::File::open(canonical).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        }
        hasher.update(b"\0UNTRACKED\0");
        hasher.update(&(name.len() as u64).to_le_bytes());
        hasher.update(name);
        hasher.update(file_hash.finalize().as_bytes());
    }
    Ok(hasher.finalize().to_hex().to_string())
}

fn validate_branch_name(branch: &str) -> Result<String, String> {
    let trimmed = branch.trim().trim_start_matches("refs/heads/");
    if trimmed.is_empty() || trimmed.len() > 120 {
        return Err("分支名不能为空且长度不能超过 120 字符".to_string());
    }
    if trimmed.starts_with('-')
        || trimmed.starts_with('/')
        || trimmed.ends_with('/')
        || trimmed.ends_with(".lock")
        || trimmed.contains("..")
        || trimmed.contains("//")
        || trimmed.contains("@{")
        || trimmed.contains('\\')
        || trimmed.chars().any(|c| {
            c.is_control()
                || c.is_whitespace()
                || matches!(c, '~' | '^' | ':' | '?' | '*' | '[' | '"' | '\'')
        })
    {
        return Err("分支名包含不安全的 Git 引用字符".to_string());
    }
    Ok(trimmed.to_string())
}

fn sanitize_slug(raw: &str) -> String {
    let mut slug = String::with_capacity(raw.len());
    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
            slug.push(ch.to_ascii_lowercase());
        } else if (ch == '/' || ch == '.' || ch == ' ') && !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let cleaned = slug.trim_matches('-').to_string();
    if cleaned.is_empty() {
        "worker".to_string()
    } else if cleaned.len() > 48 {
        cleaned[..48].trim_end_matches('-').to_string()
    } else {
        cleaned
    }
}

fn repo_key_hash(top_level: &Path) -> String {
    let normalized = host_path(top_level).to_lowercase();
    let mut hasher = Sha256::new();
    hasher.update(normalized.as_bytes());
    let digest = hasher.finalize();
    digest[..6]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
}

pub(crate) fn inspect_workspace_git_sync(
    workspace_root: &Path,
) -> Result<WorkspaceGitSnapshot, String> {
    if !workspace_root.is_dir() {
        return Err("工作区目录不存在".to_string());
    }
    let canonical_ws = workspace_root
        .canonicalize()
        .unwrap_or_else(|_| workspace_root.to_path_buf());
    let top_level_raw = run_git(&canonical_ws, &["rev-parse", "--show-toplevel"])?;
    let top_level_path = PathBuf::from(&top_level_raw);
    let canonical_top = top_level_path.canonicalize().unwrap_or(top_level_path);

    let git_dir = run_git(&canonical_ws, &["rev-parse", "--git-dir"]).unwrap_or_default();
    let common_dir = run_git(&canonical_ws, &["rev-parse", "--git-common-dir"]).unwrap_or_default();
    let is_worktree = !git_dir.is_empty()
        && !common_dir.is_empty()
        && Path::new(&git_dir) != Path::new(&common_dir);

    let branch = run_git(&canonical_ws, &["symbolic-ref", "--short", "-q", "HEAD"])
        .ok()
        .filter(|value| !value.is_empty());
    let head_sha = run_git(&canonical_ws, &["rev-parse", "HEAD"])
        .ok()
        .filter(|value| !value.is_empty());
    let content_fingerprint = workspace_content_fingerprint(&canonical_top, head_sha.as_deref())?;

    let porcelain = run_git(&canonical_ws, &["status", "--porcelain"]).unwrap_or_default();
    let dirty_files = porcelain
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .take(50)
        .map(str::to_string)
        .collect::<Vec<_>>();

    let diff_stat = run_git(&canonical_ws, &["diff", "--stat"])
        .ok()
        .filter(|value| !value.is_empty());

    let recent_log =
        run_git(&canonical_ws, &["log", "-n", "5", "--pretty=format:%h %s"]).unwrap_or_default();
    let recent_commits = recent_log
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();

    Ok(WorkspaceGitSnapshot {
        content_fingerprint,
        workspace_root: host_path(&canonical_ws),
        repo_top_level: host_path(&canonical_top),
        branch,
        head_sha,
        is_worktree,
        dirty_files,
        diff_stat,
        recent_commits,
    })
}

pub(crate) fn prepare_worktree_in_root(
    managed_base_dir: &Path,
    input: PrepareWorktreeInput,
) -> Result<ManagedWorktreeInfo, String> {
    let repo_path = PathBuf::from(input.repo_root.trim());
    if !repo_path.is_dir() {
        return Err("源仓库目录不存在".to_string());
    }
    let top_level_raw = run_git(&repo_path, &["rev-parse", "--show-toplevel"])?;
    let top_level = PathBuf::from(&top_level_raw)
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(&top_level_raw));

    let branch = validate_branch_name(&input.branch_name)?;
    let slug = sanitize_slug(input.slug.as_deref().unwrap_or(&branch));
    let repo_bucket = managed_base_dir.join(repo_key_hash(&top_level));
    std::fs::create_dir_all(&repo_bucket)
        .map_err(|error| format!("无法创建托管 Worktree 目录：{error}"))?;

    let target_dir = repo_bucket.join(&slug);

    // 若目标目录已是有效 worktree，直接核验并返回复用结果
    if target_dir.join(".git").exists() {
        if let Ok(head_sha) = run_git(&target_dir, &["rev-parse", "HEAD"]) {
            let canonical_target = target_dir.canonicalize().unwrap_or(target_dir);
            let active_branch = run_git(
                &canonical_target,
                &["symbolic-ref", "--short", "-q", "HEAD"],
            )
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or(branch);
            return Ok(ManagedWorktreeInfo {
                worktree_path: host_path(&canonical_target),
                repo_top_level: host_path(&top_level),
                branch: active_branch,
                head_sha,
                reused: true,
            });
        }
    }

    let _ = run_git(&top_level, &["worktree", "prune"]);

    let branch_exists = run_git(
        &top_level,
        &[
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ],
    )
    .is_ok();

    let target_str = host_path(&target_dir);
    if branch_exists {
        run_git(&top_level, &["worktree", "add", &target_str, &branch])?;
    } else {
        let base_ref = input
            .base_ref
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("HEAD");
        validate_branch_name(base_ref)?;
        run_git(
            &top_level,
            &["worktree", "add", "-b", &branch, &target_str, base_ref],
        )?;
    }

    let canonical_target = target_dir.canonicalize().unwrap_or(target_dir);
    let head_sha = run_git(&canonical_target, &["rev-parse", "HEAD"])?;

    Ok(ManagedWorktreeInfo {
        worktree_path: host_path(&canonical_target),
        repo_top_level: host_path(&top_level),
        branch,
        head_sha,
        reused: false,
    })
}

pub(crate) fn remove_worktree_in_root(
    managed_base_dir: &Path,
    repo_root: &str,
    worktree_path: &str,
) -> Result<(), String> {
    let canonical_base = managed_base_dir
        .canonicalize()
        .map_err(|_| "托管 Worktree 根目录尚未初始化".to_string())?;
    let target = PathBuf::from(worktree_path.trim())
        .canonicalize()
        .map_err(|_| "待清理的 Worktree 目录不存在".to_string())?;

    if !target.starts_with(&canonical_base) || target == canonical_base {
        return Err("安全边界拦截：仅允许移除 RocketX 托管目录下的 Git Worktree".to_string());
    }

    let repo_path = PathBuf::from(repo_root.trim());
    if !repo_path.is_dir() {
        return Err("源仓库目录不存在".to_string());
    }
    let target_str = host_path(&target);
    run_git(&repo_path, &["worktree", "remove", "--force", &target_str])?;
    let _ = run_git(&repo_path, &["worktree", "prune"]);
    Ok(())
}

#[tauri::command]
pub async fn butler_workspace_git_inspect(
    workspace_root: String,
) -> Result<WorkspaceGitSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        inspect_workspace_git_sync(Path::new(workspace_root.trim()))
    })
    .await
    .map_err(|error| format!("工作区 Git 检查任务失败：{error}"))?
}

#[tauri::command]
pub async fn butler_worktree_prepare(
    app: tauri::AppHandle,
    input: PrepareWorktreeInput,
) -> Result<ManagedWorktreeInfo, String> {
    let base_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法获取应用数据目录：{error}"))?
        .join(MANAGED_WORKTREES_DIR);
    tauri::async_runtime::spawn_blocking(move || prepare_worktree_in_root(&base_dir, input))
        .await
        .map_err(|error| format!("创建托管 Git Worktree 失败：{error}"))?
}

#[tauri::command]
pub async fn butler_worktree_remove(
    app: tauri::AppHandle,
    repo_root: String,
    worktree_path: String,
) -> Result<(), String> {
    let base_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法获取应用数据目录：{error}"))?
        .join(MANAGED_WORKTREES_DIR);
    tauri::async_runtime::spawn_blocking(move || {
        remove_worktree_in_root(&base_dir, &repo_root, &worktree_path)
    })
    .await
    .map_err(|error| format!("清理托管 Git Worktree 失败：{error}"))?
}

struct TempIndexGuard(PathBuf);
impl Drop for TempIndexGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn run_git_env_bytes(cwd: &Path, args: &[&str], envs: &[(&str, &str)]) -> Result<Vec<u8>, String> {
    let mut command = hidden_command("git");
    command.current_dir(cwd).args(args);
    for (k, v) in envs {
        command.env(k, v);
    }
    let output = command
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
    Ok(output.stdout)
}

fn run_git_env(cwd: &Path, args: &[&str], envs: &[(&str, &str)]) -> Result<String, String> {
    let bytes = run_git_env_bytes(cwd, args, envs)?;
    Ok(String::from_utf8_lossy(&bytes).trim().to_string())
}

fn resolve_git_repo_context(workspace_root: &str) -> Result<(PathBuf, PathBuf), String> {
    let trimmed = workspace_root.trim();
    if trimmed.is_empty() {
        return Err("工作区路径不能为空".to_string());
    }
    let ws = PathBuf::from(trimmed);
    if !ws.is_dir() {
        return Err("工作区目录不存在".to_string());
    }
    let canonical_ws = ws.canonicalize().unwrap_or(ws);
    let top_raw = run_git(&canonical_ws, &["rev-parse", "--show-toplevel"])?;
    let top_path = PathBuf::from(&top_raw);
    let canonical_top = top_path.canonicalize().unwrap_or(top_path);
    Ok((canonical_ws, canonical_top))
}

fn validate_git_ref_arg(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.len() > 200 {
        return Err("Git 引用名称无效".to_string());
    }
    if trimmed.starts_with('-')
        || trimmed.contains("..")
        || trimmed.contains('\0')
        || trimmed.contains("@{")
        || trimmed.contains('\\')
        || trimmed.chars().any(|c| {
            c.is_control()
                || c.is_whitespace()
                || matches!(c, '*' | '?' | '[' | '"' | '\'' | ';' | '&' | '|' | '$')
        })
    {
        return Err("Git 引用名称包含不安全字符".to_string());
    }
    Ok(trimmed.to_string())
}

fn validate_checkpoint_id(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty()
        || trimmed.len() > 96
        || !trimmed
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
    {
        return Err("检查点 ID 无效".to_string());
    }
    Ok(trimmed.to_string())
}

fn resolve_repo_relative_path(canonical_top: &Path, raw_rel: &str) -> Result<String, String> {
    let trimmed = raw_rel.trim().replace('\\', "/");
    if trimmed.is_empty() || trimmed.contains('\0') {
        return Err("文件路径不能为空".to_string());
    }
    let rel_path = Path::new(&trimmed);
    if rel_path.is_absolute() {
        return Err("仅支持仓库内相对路径".to_string());
    }
    for component in rel_path.components() {
        match component {
            Component::Normal(_) | Component::CurDir => {}
            _ => return Err("文件路径不能包含父目录或越界跳转".to_string()),
        }
    }
    let joined = canonical_top.join(rel_path);
    if let Ok(canonical_target) = joined.canonicalize() {
        if !canonical_target.starts_with(canonical_top) {
            return Err("安全拦截：目标路径超出 Git 仓库范围".to_string());
        }
    }
    Ok(trimmed)
}

fn parse_patch_path_header(header_line: &str) -> Option<String> {
    let rest = header_line.strip_prefix("diff --git ")?.trim();
    if let Some(idx) = rest.rfind(" b/") {
        return Some(unquote_git_path(&rest[idx + 3..]));
    }
    if rest.ends_with('"') {
        let mut parts = Vec::new();
        let mut chars = rest.chars().peekable();
        while let Some(&ch) = chars.peek() {
            if ch == ' ' {
                chars.next();
                continue;
            }
            if ch == '"' {
                chars.next();
                let mut buf = String::new();
                while let Some(c) = chars.next() {
                    if c == '\\' {
                        if let Some(esc) = chars.next() {
                            buf.push(esc);
                        }
                    } else if c == '"' {
                        break;
                    } else {
                        buf.push(c);
                    }
                }
                parts.push(buf);
            } else {
                let mut buf = String::new();
                while let Some(&c) = chars.peek() {
                    if c == ' ' {
                        break;
                    }
                    buf.push(c);
                    chars.next();
                }
                parts.push(buf);
            }
        }
        if let Some(last) = parts.last() {
            return Some(last.strip_prefix("b/").unwrap_or(last).to_string());
        }
    }
    None
}

fn unquote_git_path(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.starts_with('"') && trimmed.ends_with('"') && trimmed.len() >= 2 {
        let inner = &trimmed[1..trimmed.len() - 1];
        inner.replace("\\\\", "\\").replace("\\\"", "\"")
    } else {
        trimmed.to_string()
    }
}

fn split_unified_diff_sections(raw_diff: &[u8]) -> Vec<(String, String, u32, u32, bool, bool)> {
    let text = String::from_utf8_lossy(raw_diff);
    let mut sections = Vec::new();
    let mut current_lines: Vec<&str> = Vec::new();

    let flush = |lines: &[&str], out: &mut Vec<(String, String, u32, u32, bool, bool)>| {
        if lines.is_empty() {
            return;
        }
        let header = lines[0];
        let Some(path) = parse_patch_path_header(header) else {
            return;
        };
        let mut additions = 0u32;
        let mut deletions = 0u32;
        let mut binary = false;
        let mut in_hunk = false;
        for line in &lines[1..] {
            if line.starts_with("Binary files ") || *line == "GIT binary patch" {
                binary = true;
            }
            if line.starts_with("@@ ") {
                in_hunk = true;
                continue;
            }
            if in_hunk {
                if line.starts_with('+') && !line.starts_with("+++") {
                    additions = additions.saturating_add(1);
                } else if line.starts_with('-') && !line.starts_with("---") {
                    deletions = deletions.saturating_add(1);
                }
            }
        }
        let mut patch = lines.join("\n");
        let mut truncated = false;
        if binary {
            patch.clear();
        } else if patch.len() > MAX_DIFF_FILE_BYTES {
            let mut cut = MAX_DIFF_FILE_BYTES;
            while cut > 0 && !patch.is_char_boundary(cut) {
                cut -= 1;
            }
            patch.truncate(cut);
            patch.push_str("\n... (truncated)");
            truncated = true;
        }
        out.push((path, patch, additions, deletions, binary, truncated));
    };

    for line in text.lines() {
        if line.starts_with("diff --git ") {
            flush(&current_lines, &mut sections);
            current_lines.clear();
        }
        current_lines.push(line);
    }
    flush(&current_lines, &mut sections);
    sections
}

fn build_untracked_file_diff(canonical_top: &Path, rel_path: &str) -> Option<GitDiffFileSummary> {
    let joined = canonical_top.join(rel_path);
    let meta = std::fs::symlink_metadata(&joined).ok()?;
    if meta.file_type().is_symlink() || !meta.is_file() {
        return None;
    }
    let canonical_file = joined.canonicalize().ok()?;
    if !canonical_file.starts_with(canonical_top) {
        return None;
    }
    let bytes = std::fs::read(&canonical_file).ok()?;
    let sample_len = bytes.len().min(8192);
    if bytes[..sample_len].contains(&0) {
        return Some(GitDiffFileSummary {
            path: rel_path.to_string(),
            status: "?".to_string(),
            staged: false,
            unstaged: true,
            additions: 0,
            deletions: 0,
            binary: true,
            patch: String::new(),
            truncated: false,
        });
    }
    let truncated = bytes.len() > MAX_DIFF_FILE_BYTES;
    let slice = if truncated {
        &bytes[..MAX_DIFF_FILE_BYTES]
    } else {
        &bytes[..]
    };
    let text = String::from_utf8_lossy(slice);
    let lines: Vec<&str> = text.lines().collect();
    let count = lines.len() as u32;
    let mut patch = format!(
        "diff --git a/{rel_path} b/{rel_path}\nnew file mode 100644\n--- /dev/null\n+++ b/{rel_path}\n@@ -0,0 +1,{} @@",
        count.max(1)
    );
    for line in lines {
        patch.push_str("\n+");
        patch.push_str(line);
    }
    if truncated {
        patch.push_str("\n... (truncated)");
    }
    Some(GitDiffFileSummary {
        path: rel_path.to_string(),
        status: "?".to_string(),
        staged: false,
        unstaged: true,
        additions: count,
        deletions: 0,
        binary: false,
        patch,
        truncated,
    })
}

fn parse_status_map(canonical_top: &Path) -> HashMap<String, (char, char)> {
    let mut map = HashMap::new();
    let Ok(bytes) = run_git_env_bytes(
        canonical_top,
        &["status", "--porcelain=v1", "-z", "-uall"],
        &[],
    ) else {
        return map;
    };
    let mut parts = bytes.split(|b| *b == 0);
    while let Some(entry) = parts.next() {
        if entry.len() < 3 {
            continue;
        }
        let line = String::from_utf8_lossy(entry);
        let chars: Vec<char> = line.chars().collect();
        if chars.len() < 4 || chars[2] != ' ' {
            continue;
        }
        let x = chars[0];
        let y = chars[1];
        let path: String = chars[3..].iter().collect();
        if matches!(x, 'R' | 'C') {
            let _ = parts.next();
        }
        map.insert(path.replace('\\', "/"), (x, y));
    }
    map
}

fn status_code_from_pair(x: char, y: char) -> &'static str {
    if x == '?' && y == '?' {
        "?"
    } else if x == 'A' || y == 'A' {
        "A"
    } else if x == 'D' || y == 'D' {
        "D"
    } else if x == 'R' || y == 'R' {
        "R"
    } else if x == 'U' || y == 'U' {
        "U"
    } else {
        "M"
    }
}

pub(crate) fn inspect_diff_workspace_sync(
    workspace_root: &Path,
    base_ref: Option<&str>,
) -> Result<GitWorkspaceDiff, String> {
    let ws_str = host_path(workspace_root);
    let (canonical_ws, canonical_top) = resolve_git_repo_context(&ws_str)?;
    let branch = run_git(&canonical_ws, &["symbolic-ref", "--short", "-q", "HEAD"])
        .ok()
        .filter(|s| !s.is_empty());
    let head_sha = run_git(&canonical_ws, &["rev-parse", "HEAD"])
        .ok()
        .filter(|s| !s.is_empty());

    let (ahead, behind) = run_git(
        &canonical_ws,
        &["rev-list", "--left-right", "--count", "@{upstream}...HEAD"],
    )
    .ok()
    .and_then(|raw| {
        let mut nums = raw.split_whitespace();
        let b = nums.next()?.parse::<u32>().ok()?;
        let a = nums.next()?.parse::<u32>().ok()?;
        Some((a, b))
    })
    .unwrap_or((0, 0));

    let normalized_base = match base_ref.map(str::trim).filter(|s| !s.is_empty()) {
        Some(raw) => Some(validate_git_ref_arg(raw)?),
        None => None,
    };

    let status_map = parse_status_map(&canonical_top);
    let mut files = Vec::new();
    let mut seen_paths = HashSet::new();
    let mut total_bytes = 0usize;
    let mut truncated_total = false;

    let raw_diff_chunks = if let Some(ref base) = normalized_base {
        vec![run_git_env_bytes(
            &canonical_top,
            &[
                "diff",
                "--no-color",
                "--no-ext-diff",
                "--unified=3",
                base,
                "--",
            ],
            &[],
        )?]
    } else if head_sha.is_some() {
        vec![run_git_env_bytes(
            &canonical_top,
            &[
                "diff",
                "--no-color",
                "--no-ext-diff",
                "--unified=3",
                "HEAD",
                "--",
            ],
            &[],
        )?]
    } else {
        vec![
            run_git_env_bytes(
                &canonical_top,
                &[
                    "diff",
                    "--cached",
                    "--no-color",
                    "--no-ext-diff",
                    "--unified=3",
                    "--",
                ],
                &[],
            )
            .unwrap_or_default(),
            run_git_env_bytes(
                &canonical_top,
                &["diff", "--no-color", "--no-ext-diff", "--unified=3", "--"],
                &[],
            )
            .unwrap_or_default(),
        ]
    };

    for chunk in raw_diff_chunks {
        for (path, patch, additions, deletions, binary, truncated) in
            split_unified_diff_sections(&chunk)
        {
            if !seen_paths.insert(path.clone()) {
                continue;
            }
            let (x, y) = status_map.get(&path).copied().unwrap_or((' ', 'M'));
            let staged = x != ' ' && x != '?';
            let unstaged = y != ' ';
            let status = status_code_from_pair(x, y).to_string();
            let mut effective_patch = patch;
            let mut effective_truncated = truncated;
            if total_bytes + effective_patch.len() > MAX_DIFF_TOTAL_BYTES {
                truncated_total = true;
                effective_truncated = true;
                effective_patch.clear();
            } else {
                total_bytes += effective_patch.len();
            }
            files.push(GitDiffFileSummary {
                path,
                status,
                staged,
                unstaged,
                additions,
                deletions,
                binary,
                patch: effective_patch,
                truncated: effective_truncated,
            });
        }
    }

    if normalized_base.is_none() {
        let mut untracked_paths: Vec<String> = status_map
            .iter()
            .filter_map(|(path, (x, y))| (*x == '?' && *y == '?').then(|| path.clone()))
            .collect();
        untracked_paths.sort();
        for rel in untracked_paths {
            if seen_paths.contains(&rel) {
                continue;
            }
            if let Some(mut item) = build_untracked_file_diff(&canonical_top, &rel) {
                if total_bytes + item.patch.len() > MAX_DIFF_TOTAL_BYTES {
                    truncated_total = true;
                    item.truncated = true;
                    item.patch.clear();
                } else {
                    total_bytes += item.patch.len();
                }
                files.push(item);
            }
        }
    }

    files.sort_by(|a, b| a.path.cmp(&b.path));
    let total_additions = files.iter().map(|f| f.additions).sum();
    let total_deletions = files.iter().map(|f| f.deletions).sum();

    Ok(GitWorkspaceDiff {
        workspace_root: host_path(&canonical_ws),
        repo_top_level: host_path(&canonical_top),
        branch,
        head_sha,
        base_ref: normalized_base,
        compare_ref: None,
        ahead,
        behind,
        total_additions,
        total_deletions,
        files,
        truncated_total,
    })
}

fn sanitize_single_line(raw: &str, fallback: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.chars().take(160).collect()
    }
}

pub(crate) fn create_checkpoint_sync(
    workspace_root: &Path,
    label: &str,
    turn_id: Option<&str>,
) -> Result<GitCheckpointRecord, String> {
    let ws_str = host_path(workspace_root);
    let (_canonical_ws, canonical_top) = resolve_git_repo_context(&ws_str)?;
    let head_sha = run_git(&canonical_top, &["rev-parse", "HEAD"])
        .ok()
        .filter(|s| !s.is_empty());

    let tmp_index = std::env::temp_dir().join(format!("rocketx-git-idx-{}", uuid::Uuid::new_v4()));
    let _guard = TempIndexGuard(tmp_index.clone());
    let tmp_index_str = host_path(&tmp_index);
    let envs = [("GIT_INDEX_FILE", tmp_index_str.as_str())];

    if head_sha.is_some() {
        run_git_env(&canonical_top, &["read-tree", "HEAD"], &envs)?;
    }
    run_git_env(&canonical_top, &["add", "-A", "--", "."], &envs)?;
    let tree_sha = run_git_env(&canonical_top, &["write-tree"], &envs)?;

    let changed_files = if let Some(ref head) = head_sha {
        run_git(
            &canonical_top,
            &[
                "diff-tree",
                "--no-commit-id",
                "--name-only",
                "-r",
                head,
                &tree_sha,
            ],
        )
        .map(|s| s.lines().filter(|l| !l.trim().is_empty()).count() as u32)
        .unwrap_or(0)
    } else {
        run_git(&canonical_top, &["ls-tree", "-r", "--name-only", &tree_sha])
            .map(|s| s.lines().filter(|l| !l.trim().is_empty()).count() as u32)
            .unwrap_or(0)
    };

    let created_at = now_millis();
    let uuid_short = uuid::Uuid::new_v4().simple().to_string();
    let id = format!("{created_at}-{}", &uuid_short[..8]);
    let ref_name = format!("{CHECKPOINT_REF_PREFIX}{id}");
    let clean_label = sanitize_single_line(label, "Checkpoint");
    let clean_turn = turn_id
        .map(|t| sanitize_single_line(t, ""))
        .filter(|t| !t.is_empty());

    let mut message = format!(
        "rocketx-checkpoint-v1: {clean_label}\n\ncreated_at: {created_at}\nchanged_files: {changed_files}\n"
    );
    if let Some(ref turn) = clean_turn {
        message.push_str(&format!("turn: {turn}\n"));
    }

    let mut commit_args = vec!["commit-tree", tree_sha.as_str()];
    if let Some(ref head) = head_sha {
        commit_args.push("-p");
        commit_args.push(head.as_str());
    }
    commit_args.push("-m");
    commit_args.push(message.as_str());

    let author_envs = [
        ("GIT_AUTHOR_NAME", "RocketX Checkpoint"),
        ("GIT_AUTHOR_EMAIL", "checkpoint@rocketx.local"),
        ("GIT_COMMITTER_NAME", "RocketX Checkpoint"),
        ("GIT_COMMITTER_EMAIL", "checkpoint@rocketx.local"),
    ];
    let commit_sha = run_git_env(&canonical_top, &commit_args, &author_envs)?;
    run_git(&canonical_top, &["update-ref", &ref_name, &commit_sha])?;

    Ok(GitCheckpointRecord {
        id,
        ref_name,
        commit_sha,
        tree_sha,
        label: clean_label,
        turn_id: clean_turn,
        created_at,
        changed_files,
    })
}

pub(crate) fn list_checkpoints_sync(
    workspace_root: &Path,
) -> Result<Vec<GitCheckpointRecord>, String> {
    let ws_str = host_path(workspace_root);
    let (_canonical_ws, canonical_top) = resolve_git_repo_context(&ws_str)?;
    let raw = run_git(
        &canonical_top,
        &[
            "for-each-ref",
            "--sort=-creatordate",
            "--format=%(refname)%09%(objectname)%09%(tree)%09%(contents:subject)%09%(contents:body)%1e",
            "refs/rocketx/checkpoints",
        ],
    )?;
    let mut records = Vec::new();
    for entry in raw.split('\x1e') {
        let trimmed = entry.trim();
        if trimmed.is_empty() {
            continue;
        }
        let mut fields = trimmed.splitn(5, '\t');
        let Some(ref_name) = fields.next().map(str::trim) else {
            continue;
        };
        let Some(id) = ref_name.strip_prefix(CHECKPOINT_REF_PREFIX) else {
            continue;
        };
        let commit_sha = fields.next().unwrap_or_default().trim().to_string();
        let tree_sha = fields.next().unwrap_or_default().trim().to_string();
        let subject = fields.next().unwrap_or_default().trim();
        let body = fields.next().unwrap_or_default();
        let label = subject
            .strip_prefix("rocketx-checkpoint-v1:")
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("Checkpoint")
            .to_string();
        let mut turn_id = None;
        let mut created_at = 0i64;
        let mut changed_files = 0u32;
        for line in body.lines() {
            if let Some(v) = line.strip_prefix("turn:") {
                let val = v.trim();
                if !val.is_empty() {
                    turn_id = Some(val.to_string());
                }
            } else if let Some(v) = line.strip_prefix("created_at:") {
                if let Ok(ts) = v.trim().parse::<i64>() {
                    created_at = ts;
                }
            } else if let Some(v) = line.strip_prefix("changed_files:") {
                if let Ok(cnt) = v.trim().parse::<u32>() {
                    changed_files = cnt;
                }
            }
        }
        records.push(GitCheckpointRecord {
            id: id.to_string(),
            ref_name: ref_name.to_string(),
            commit_sha,
            tree_sha,
            label,
            turn_id,
            created_at,
            changed_files,
        });
    }
    records.sort_by(|a, b| {
        b.created_at
            .cmp(&a.created_at)
            .then_with(|| b.id.cmp(&a.id))
    });
    Ok(records)
}

pub(crate) fn diff_checkpoints_sync(
    workspace_root: &Path,
    from_ref: &str,
    to_ref: Option<&str>,
) -> Result<GitWorkspaceDiff, String> {
    let ws_str = host_path(workspace_root);
    let (canonical_ws, canonical_top) = resolve_git_repo_context(&ws_str)?;
    let from = validate_git_ref_arg(from_ref)?;
    let to = match to_ref.map(str::trim).filter(|s| !s.is_empty()) {
        Some(raw) => Some(validate_git_ref_arg(raw)?),
        None => None,
    };

    let diff_bytes = if let Some(ref to_r) = to {
        run_git_env_bytes(
            &canonical_top,
            &[
                "diff",
                "--no-color",
                "--no-ext-diff",
                "--unified=3",
                &from,
                to_r,
                "--",
            ],
            &[],
        )?
    } else {
        run_git_env_bytes(
            &canonical_top,
            &[
                "diff",
                "--no-color",
                "--no-ext-diff",
                "--unified=3",
                &from,
                "--",
            ],
            &[],
        )?
    };

    let mut total_bytes = 0usize;
    let mut truncated_total = false;
    let mut files = Vec::new();
    for (path, mut patch, additions, deletions, binary, mut truncated) in
        split_unified_diff_sections(&diff_bytes)
    {
        if total_bytes + patch.len() > MAX_DIFF_TOTAL_BYTES {
            truncated_total = true;
            truncated = true;
            patch.clear();
        } else {
            total_bytes += patch.len();
        }
        files.push(GitDiffFileSummary {
            path,
            status: "M".to_string(),
            staged: false,
            unstaged: false,
            additions,
            deletions,
            binary,
            patch,
            truncated,
        });
    }

    let branch = run_git(&canonical_ws, &["symbolic-ref", "--short", "-q", "HEAD"])
        .ok()
        .filter(|s| !s.is_empty());
    let head_sha = run_git(&canonical_ws, &["rev-parse", "HEAD"])
        .ok()
        .filter(|s| !s.is_empty());
    let total_additions = files.iter().map(|f| f.additions).sum();
    let total_deletions = files.iter().map(|f| f.deletions).sum();

    Ok(GitWorkspaceDiff {
        workspace_root: host_path(&canonical_ws),
        repo_top_level: host_path(&canonical_top),
        branch,
        head_sha,
        base_ref: Some(from),
        compare_ref: to,
        ahead: 0,
        behind: 0,
        total_additions,
        total_deletions,
        files,
        truncated_total,
    })
}

pub(crate) fn revert_checkpoint_sync(
    workspace_root: &Path,
    checkpoint_id: &str,
    _mode: &str,
) -> Result<GitCheckpointRecord, String> {
    let ws_str = host_path(workspace_root);
    let (_canonical_ws, canonical_top) = resolve_git_repo_context(&ws_str)?;
    let clean_id = validate_checkpoint_id(checkpoint_id)?;
    let ref_name = format!("{CHECKPOINT_REF_PREFIX}{clean_id}");
    let target_tree = run_git(
        &canonical_top,
        &["rev-parse", "--verify", &format!("{ref_name}^{{tree}}")],
    )
    .map_err(|_| format!("找不到检查点：{clean_id}"))?;

    // Always capture a reversible backup checkpoint before modifying the working tree.
    let backup = create_checkpoint_sync(
        workspace_root,
        "Auto backup before revert",
        Some("pre-revert"),
    )?;

    let target_files_raw = run_git_env_bytes(
        &canonical_top,
        &["ls-tree", "-r", "-z", "--name-only", &target_tree],
        &[],
    )?;
    let target_files: HashSet<String> = target_files_raw
        .split(|b| *b == 0)
        .filter(|s| !s.is_empty())
        .map(|s| String::from_utf8_lossy(s).to_string())
        .collect();

    let untracked_raw = run_git_env_bytes(
        &canonical_top,
        &["ls-files", "--others", "--exclude-standard", "-z"],
        &[],
    )?;
    let tracked_raw = run_git_env_bytes(&canonical_top, &["ls-files", "-z"], &[])?;

    for raw in untracked_raw
        .split(|b| *b == 0)
        .chain(tracked_raw.split(|b| *b == 0))
    {
        if raw.is_empty() {
            continue;
        }
        let rel = String::from_utf8_lossy(raw).to_string();
        if !target_files.contains(&rel) {
            if let Ok(safe_rel) = resolve_repo_relative_path(&canonical_top, &rel) {
                let candidate = canonical_top.join(&safe_rel);
                if candidate.is_file() {
                    let _ = std::fs::remove_file(&candidate);
                }
                let _ = run_git(
                    &canonical_top,
                    &["rm", "-f", "--cached", "--ignore-unmatch", "--", &safe_rel],
                );
            }
        }
    }

    if !target_files.is_empty() {
        run_git(&canonical_top, &["checkout", &target_tree, "--", "."])?;
    }
    let _ = run_git(&canonical_top, &["reset", "HEAD", "--"]);

    Ok(backup)
}

#[tauri::command]
pub async fn butler_git_diff_workspace(
    workspace_root: String,
    base_ref: Option<String>,
) -> Result<GitWorkspaceDiff, String> {
    tauri::async_runtime::spawn_blocking(move || {
        inspect_diff_workspace_sync(Path::new(workspace_root.trim()), base_ref.as_deref())
    })
    .await
    .map_err(|error| format!("Git 差异读取失败：{error}"))?
}

#[tauri::command]
pub async fn butler_git_checkpoint_create(
    workspace_root: String,
    label: String,
    turn_id: Option<String>,
) -> Result<GitCheckpointRecord, String> {
    tauri::async_runtime::spawn_blocking(move || {
        create_checkpoint_sync(Path::new(workspace_root.trim()), &label, turn_id.as_deref())
    })
    .await
    .map_err(|error| format!("创建检查点失败：{error}"))?
}

#[tauri::command]
pub async fn butler_git_checkpoint_list(
    workspace_root: String,
) -> Result<Vec<GitCheckpointRecord>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        list_checkpoints_sync(Path::new(workspace_root.trim()))
    })
    .await
    .map_err(|error| format!("读取检查点列表失败：{error}"))?
}

#[tauri::command]
pub async fn butler_git_checkpoint_diff(
    workspace_root: String,
    from_ref: String,
    to_ref: Option<String>,
) -> Result<GitWorkspaceDiff, String> {
    tauri::async_runtime::spawn_blocking(move || {
        diff_checkpoints_sync(
            Path::new(workspace_root.trim()),
            &from_ref,
            to_ref.as_deref(),
        )
    })
    .await
    .map_err(|error| format!("读取检查点差异失败：{error}"))?
}

#[tauri::command]
pub async fn butler_git_checkpoint_revert(
    workspace_root: String,
    checkpoint_id: String,
    mode: Option<String>,
) -> Result<GitCheckpointRecord, String> {
    tauri::async_runtime::spawn_blocking(move || {
        revert_checkpoint_sync(
            Path::new(workspace_root.trim()),
            &checkpoint_id,
            mode.as_deref().unwrap_or("working_tree"),
        )
    })
    .await
    .map_err(|error| format!("回滚检查点失败：{error}"))?
}

#[tauri::command]
pub async fn butler_git_stage_file(workspace_root: String, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (_ws, top) = resolve_git_repo_context(&workspace_root)?;
        if path.trim() == "*" {
            run_git(&top, &["add", "-A"])?;
            return Ok(());
        }
        let rel = resolve_repo_relative_path(&top, &path)?;
        run_git(&top, &["add", "--", &rel])?;
        Ok(())
    })
    .await
    .map_err(|error| format!("暂存文件失败：{error}"))?
}

#[tauri::command]
pub async fn butler_git_unstage_file(workspace_root: String, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (_ws, top) = resolve_git_repo_context(&workspace_root)?;
        let has_head = run_git(&top, &["rev-parse", "--verify", "HEAD"]).is_ok();
        if path.trim() == "*" {
            if has_head {
                run_git(&top, &["reset", "HEAD", "--"])?;
            } else {
                let _ = run_git(&top, &["rm", "-r", "--cached", "--ignore-unmatch", "."]);
            }
            return Ok(());
        }
        let rel = resolve_repo_relative_path(&top, &path)?;
        if has_head {
            run_git(&top, &["reset", "HEAD", "--", &rel])?;
        } else {
            run_git(
                &top,
                &["rm", "-f", "--cached", "--ignore-unmatch", "--", &rel],
            )?;
        }
        Ok(())
    })
    .await
    .map_err(|error| format!("取消暂存失败：{error}"))?
}

#[tauri::command]
pub async fn butler_git_discard_file(workspace_root: String, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (_ws, top) = resolve_git_repo_context(&workspace_root)?;
        let rel = resolve_repo_relative_path(&top, &path)?;
        let tracked = run_git(&top, &["ls-files", "--error-unmatch", "--", &rel]).is_ok();
        if tracked {
            let has_head = run_git(&top, &["rev-parse", "--verify", "HEAD"]).is_ok();
            if has_head {
                run_git(&top, &["checkout", "HEAD", "--", &rel])?;
            } else {
                let _ = run_git(&top, &["rm", "-f", "--", &rel]);
            }
        } else {
            let target = top.join(&rel);
            if target.is_file() {
                std::fs::remove_file(&target)
                    .map_err(|error| format!("无法删除未跟踪文件：{error}"))?;
            }
        }
        Ok(())
    })
    .await
    .map_err(|error| format!("放弃更改失败：{error}"))?
}

#[tauri::command]
pub async fn butler_git_commit(
    workspace_root: String,
    message: String,
    stage_all: Option<bool>,
) -> Result<GitCommitResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (_ws, top) = resolve_git_repo_context(&workspace_root)?;
        let trimmed_msg = message.trim();
        if trimmed_msg.is_empty() {
            return Err("提交说明不能为空".to_string());
        }
        if stage_all.unwrap_or(false) {
            run_git(&top, &["add", "-A"])?;
        }
        let staged = run_git(&top, &["diff", "--cached", "--name-only"])?;
        if staged.trim().is_empty() {
            return Err("没有可提交的已暂存更改".to_string());
        }
        run_git(&top, &["commit", "-m", trimmed_msg])?;
        let commit_sha = run_git(&top, &["rev-parse", "HEAD"])?;
        let branch = run_git(&top, &["symbolic-ref", "--short", "-q", "HEAD"])
            .ok()
            .filter(|s| !s.is_empty());
        let summary =
            run_git(&top, &["log", "-1", "--oneline"]).unwrap_or_else(|_| commit_sha.clone());
        Ok(GitCommitResult {
            commit_sha,
            branch,
            summary,
        })
    })
    .await
    .map_err(|error| format!("提交失败：{error}"))?
}

#[tauri::command]
pub async fn butler_git_push(
    workspace_root: String,
    remote: Option<String>,
    branch: Option<String>,
    set_upstream: Option<bool>,
) -> Result<GitPushResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (_ws, top) = resolve_git_repo_context(&workspace_root)?;
        let target_remote = match remote.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(r) => validate_git_ref_arg(r)?,
            None => "origin".to_string(),
        };
        let target_branch = match branch.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(b) => validate_branch_name(b)?,
            None => run_git(&top, &["symbolic-ref", "--short", "-q", "HEAD"])
                .map_err(|_| "当前处于游离 HEAD 状态，请先切换到分支".to_string())?,
        };
        let mut args = vec!["push"];
        if set_upstream.unwrap_or(true) {
            args.push("-u");
        }
        args.push(&target_remote);
        args.push(&target_branch);
        let output = run_git(&top, &args)?;
        Ok(GitPushResult {
            remote: target_remote,
            branch: target_branch,
            output,
        })
    })
    .await
    .map_err(|error| format!("推送失败：{error}"))?
}

pub(crate) fn read_workspace_origin_url(workspace_root: &str) -> Result<Option<String>, String> {
    let (_ws, top) = resolve_git_repo_context(workspace_root)?;
    let url = run_git(&top, &["remote", "get-url", "origin"]).unwrap_or_default();
    let trimmed = url.trim().to_string();
    Ok((!trimmed.is_empty()).then_some(trimmed))
}

fn build_compare_pr_url(remote_url: &str, base: &str, branch: &str) -> Option<String> {
    let trimmed = remote_url.trim().trim_end_matches(".git");
    if let Some(rest) = trimmed.strip_prefix("git@github.com:") {
        return Some(format!(
            "https://github.com/{rest}/compare/{base}...{branch}?expand=1"
        ));
    }
    if trimmed.starts_with("https://github.com/") || trimmed.starts_with("http://github.com/") {
        return Some(format!("{trimmed}/compare/{base}...{branch}?expand=1"));
    }
    if trimmed.contains("/_git/") {
        return Some(format!(
            "{trimmed}/pullrequestcreate?sourceRef={branch}&targetRef={base}"
        ));
    }
    None
}

#[tauri::command]
pub async fn butler_git_create_pr(
    app: tauri::AppHandle,
    workspace_root: String,
    title: String,
    body: Option<String>,
    base: Option<String>,
    draft: Option<bool>,
) -> Result<GitCreatePrResult, String> {
    let draft_flag = draft.unwrap_or(false);
    let body_text = body.unwrap_or_default();
    let body_for_cli = body_text.clone();
    let (ready, clean_title, current_branch, base_branch, remote_url, fallback_url, gh_stderr) =
        tauri::async_runtime::spawn_blocking(move || -> Result<_, String> {
            let (_ws, top) = resolve_git_repo_context(&workspace_root)?;
            let clean_title = sanitize_single_line(&title, "");
            if clean_title.is_empty() {
                return Err("PR 标题不能为空".to_string());
            }
            let current_branch = run_git(&top, &["symbolic-ref", "--short", "-q", "HEAD"])
                .unwrap_or_else(|_| "HEAD".to_string());
            let base_branch = match base.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                Some(b) => validate_branch_name(b)?,
                None => "main".to_string(),
            };
            let remote_url = run_git(&top, &["remote", "get-url", "origin"]).unwrap_or_default();
            let fallback_url = build_compare_pr_url(&remote_url, &base_branch, &current_branch);

            let mut gh_stderr: Option<String> = None;
            if let Some(gh_exe) = crate::native::dsh_discovery::find_program("gh") {
                let mut cmd = hidden_command(&gh_exe);
                cmd.current_dir(&top).args([
                    "pr",
                    "create",
                    "--title",
                    &clean_title,
                    "--body",
                    &body_for_cli,
                ]);
                if base.as_deref().is_some_and(|b| !b.trim().is_empty()) {
                    cmd.args(["--base", &base_branch]);
                }
                if draft_flag {
                    cmd.arg("--draft");
                }
                if let Ok(output) = cmd.output() {
                    if output.status.success() {
                        let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
                        return Ok((
                            Some(GitCreatePrResult {
                                created: true,
                                url: (!url.is_empty()).then_some(url),
                                fallback_compare_url: fallback_url,
                                message: "已通过 GitHub CLI 创建 Pull Request".to_string(),
                            }),
                            clean_title,
                            current_branch,
                            base_branch,
                            remote_url,
                            None,
                            None,
                        ));
                    }
                    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                    if !stderr.is_empty() {
                        gh_stderr = Some(stderr);
                    }
                }
            }

            Ok((
                None,
                clean_title,
                current_branch,
                base_branch,
                remote_url,
                fallback_url,
                gh_stderr,
            ))
        })
        .await
        .map_err(|error| format!("创建 PR 失败：{error}"))??;

    if let Some(res) = ready {
        return Ok(res);
    }

    if current_branch != "HEAD" {
        if let Some((owner, repo)) = crate::native::git_remote::parse_github_remote_url(&remote_url)
        {
            if let Ok(Some(pr_url)) = crate::github_connector::create_pull_request_via_api(
                &app,
                &owner,
                &repo,
                &clean_title,
                &body_text,
                &current_branch,
                &base_branch,
                draft_flag,
            )
            .await
            {
                return Ok(GitCreatePrResult {
                    created: true,
                    url: Some(pr_url),
                    fallback_compare_url: fallback_url,
                    message: "已通过 GitHub API 创建 Pull Request".to_string(),
                });
            }
        }
    }

    Ok(GitCreatePrResult {
        created: false,
        url: fallback_url.clone(),
        fallback_compare_url: fallback_url,
        message: gh_stderr
            .unwrap_or_else(|| "未检测到已登录的 gh CLI，已提供网页 PR 对比创建链接".to_string()),
    })
}

pub(crate) fn list_worktrees_sync(
    workspace_root: &Path,
    managed_base: Option<&Path>,
) -> Result<Vec<GitWorktreeItem>, String> {
    let ws_str = host_path(workspace_root);
    let (canonical_ws, canonical_top) = resolve_git_repo_context(&ws_str)?;
    let raw = run_git(&canonical_top, &["worktree", "list", "--porcelain"])?;
    let managed_canonical = managed_base.and_then(|p| p.canonicalize().ok());
    let current_norm = host_path(&canonical_ws).to_lowercase();
    let mut items = Vec::new();
    let mut cur: Option<GitWorktreeItem> = None;

    for line in raw.lines().chain(std::iter::once("")) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            if let Some(item) = cur.take() {
                items.push(item);
            }
            continue;
        }
        if let Some(path_raw) = trimmed.strip_prefix("worktree ") {
            let pb = PathBuf::from(path_raw.trim());
            let canon = pb.canonicalize().unwrap_or(pb);
            let path_norm = host_path(&canon);
            let is_current = path_norm.to_lowercase() == current_norm;
            let is_managed = managed_canonical
                .as_ref()
                .is_some_and(|base| canon.starts_with(base));
            cur = Some(GitWorktreeItem {
                path: path_norm,
                head_sha: None,
                branch: None,
                bare: false,
                detached: false,
                locked: false,
                prunable: false,
                is_current,
                is_managed,
            });
        } else if let Some(item) = cur.as_mut() {
            if let Some(sha) = trimmed.strip_prefix("HEAD ") {
                item.head_sha = Some(sha.trim().to_string());
            } else if let Some(b) = trimmed.strip_prefix("branch ") {
                item.branch = Some(
                    b.trim()
                        .strip_prefix("refs/heads/")
                        .unwrap_or(b.trim())
                        .to_string(),
                );
            } else if trimmed == "bare" {
                item.bare = true;
            } else if trimmed == "detached" {
                item.detached = true;
            } else if trimmed == "locked" || trimmed.starts_with("locked ") {
                item.locked = true;
            } else if trimmed == "prunable" || trimmed.starts_with("prunable ") {
                item.prunable = true;
            }
        }
    }
    Ok(items)
}

#[tauri::command]
pub async fn butler_worktree_list(
    app: tauri::AppHandle,
    workspace_root: String,
) -> Result<Vec<GitWorktreeItem>, String> {
    let base_dir = app
        .path()
        .app_data_dir()
        .ok()
        .map(|d| d.join(MANAGED_WORKTREES_DIR));
    tauri::async_runtime::spawn_blocking(move || {
        list_worktrees_sync(Path::new(workspace_root.trim()), base_dir.as_deref())
    })
    .await
    .map_err(|error| format!("读取 Worktree 列表失败：{error}"))?
}

#[tauri::command]
pub async fn butler_git_branch_list(workspace_root: String) -> Result<Vec<GitBranchItem>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (_ws, top) = resolve_git_repo_context(&workspace_root)?;
        let raw = run_git(
            &top,
            &[
                "for-each-ref",
                "--format=%(HEAD)%09%(refname:short)%09%(upstream:short)",
                "refs/heads",
            ],
        )?;
        let branches = raw
            .lines()
            .filter_map(|line| {
                let mut parts = line.split('\t');
                let head = parts.next()?.trim();
                let name = parts.next()?.trim();
                if name.is_empty() {
                    return None;
                }
                let upstream = parts
                    .next()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string);
                Some(GitBranchItem {
                    name: name.to_string(),
                    current: head == "*",
                    upstream,
                })
            })
            .collect();
        Ok(branches)
    })
    .await
    .map_err(|error| format!("读取分支列表失败：{error}"))?
}

#[tauri::command]
pub async fn butler_git_branch_checkout(
    workspace_root: String,
    branch: String,
    create: Option<bool>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (_ws, top) = resolve_git_repo_context(&workspace_root)?;
        let valid = validate_branch_name(&branch)?;
        if create.unwrap_or(false) {
            run_git(&top, &["checkout", "-b", &valid])?;
        } else {
            run_git(&top, &["checkout", &valid])?;
        }
        Ok(())
    })
    .await
    .map_err(|error| format!("切换分支失败：{error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_test_dir(prefix: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "rocketx-worktree-test-{prefix}-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).expect("create temp test dir");
        dir
    }

    #[test]
    fn prepare_inspect_and_remove_isolated_worktree_keeps_main_repo_clean() {
        let root = temp_test_dir("lifecycle");
        let repo = root.join("repo");
        let managed = root.join("managed-worktrees");
        std::fs::create_dir_all(&repo).expect("create repo dir");

        run_git(&repo, &["init"]).expect("git init");
        run_git(&repo, &["config", "user.email", "bot@rocketx.local"]).expect("git email");
        run_git(&repo, &["config", "user.name", "RocketX Bot"]).expect("git name");
        std::fs::write(repo.join("README.md"), "# hello\n").expect("write readme");
        run_git(&repo, &["add", "README.md"]).expect("git add");
        run_git(&repo, &["commit", "-m", "initial commit"]).expect("git commit");

        let created = prepare_worktree_in_root(
            &managed,
            PrepareWorktreeInput {
                repo_root: host_path(&repo),
                branch_name: "ai/400-super-agent".to_string(),
                base_ref: None,
                slug: Some("card-400".to_string()),
            },
        )
        .expect("prepare isolated worktree");
        assert!(!created.reused);
        assert_eq!(created.branch, "ai/400-super-agent");

        // 幂等重入应直接复用已有 worktree
        let reused = prepare_worktree_in_root(
            &managed,
            PrepareWorktreeInput {
                repo_root: host_path(&repo),
                branch_name: "ai/400-super-agent".to_string(),
                base_ref: None,
                slug: Some("card-400".to_string()),
            },
        )
        .expect("reuse isolated worktree");
        assert!(reused.reused);
        assert_eq!(reused.worktree_path, created.worktree_path);

        // 在隔离 Worktree 中修改文件不应污染主仓库
        let wt_path = PathBuf::from(&created.worktree_path);
        std::fs::write(wt_path.join("worker.txt"), "isolated change\n").expect("write in worktree");

        let wt_snapshot = inspect_workspace_git_sync(&wt_path).expect("inspect worktree");
        assert!(wt_snapshot.is_worktree);
        assert_eq!(wt_snapshot.branch.as_deref(), Some("ai/400-super-agent"));
        assert_eq!(wt_snapshot.dirty_files.len(), 1);

        let main_snapshot = inspect_workspace_git_sync(&repo).expect("inspect main repo");
        assert!(!main_snapshot.is_worktree);
        assert!(main_snapshot.dirty_files.is_empty());

        // 拒绝移除非托管目录（如主仓库本身）
        let reject_err =
            remove_worktree_in_root(&managed, &host_path(&repo), &host_path(&repo)).unwrap_err();
        assert!(reject_err.contains("安全边界拦截"));

        // 正常移除托管 Worktree
        remove_worktree_in_root(&managed, &host_path(&repo), &created.worktree_path)
            .expect("remove managed worktree");
        assert!(!wt_path.exists());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn content_fingerprint_changes_for_worktree_index_and_untracked_content_at_same_head() {
        let root = temp_test_dir("fingerprint");
        run_git(&root, &["init"]).unwrap();
        run_git(&root, &["config", "core.autocrlf", "false"]).unwrap();
        run_git(&root, &["config", "user.email", "bot@rocketx.local"]).unwrap();
        run_git(&root, &["config", "user.name", "RocketX Bot"]).unwrap();
        std::fs::write(root.join("tracked.txt"), "before\n").unwrap();
        run_git(&root, &["add", "tracked.txt"]).unwrap();
        run_git(&root, &["commit", "-m", "baseline"]).unwrap();
        let baseline = inspect_workspace_git_sync(&root).unwrap();
        assert_eq!(
            baseline.content_fingerprint,
            inspect_workspace_git_sync(&root)
                .unwrap()
                .content_fingerprint
        );
        std::fs::write(root.join("tracked.txt"), "after!\n").unwrap();
        let edited = inspect_workspace_git_sync(&root).unwrap();
        assert_eq!(baseline.head_sha, edited.head_sha);
        assert_ne!(baseline.content_fingerprint, edited.content_fingerprint);
        run_git(&root, &["add", "tracked.txt"]).unwrap();
        std::fs::write(root.join("tracked.txt"), "before\n").unwrap();
        let staged = inspect_workspace_git_sync(&root).unwrap();
        assert_ne!(baseline.content_fingerprint, staged.content_fingerprint);
        let artifact = root.join("调研 notes.bin");
        std::fs::write(&artifact, [0, 1, 2, 3]).unwrap();
        let untracked = inspect_workspace_git_sync(&root).unwrap();
        std::fs::write(&artifact, [0, 1, 2, 4]).unwrap();
        let replaced = inspect_workspace_git_sync(&root).unwrap();
        assert_eq!(untracked.head_sha, replaced.head_sha);
        assert_ne!(untracked.content_fingerprint, replaced.content_fingerprint);
        std::fs::remove_file(&artifact).unwrap();
        assert_eq!(
            staged.content_fingerprint,
            inspect_workspace_git_sync(&root)
                .unwrap()
                .content_fingerprint
        );
        assert!(root.starts_with(std::env::temp_dir()));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn branch_validation_blocks_unsafe_git_ref_patterns() {
        assert!(validate_branch_name("ai/400-fix-build").is_ok());
        assert!(validate_branch_name("-bad-flag").is_err());
        assert!(validate_branch_name("ai/../escape").is_err());
        assert!(validate_branch_name("branch.lock").is_err());
    }

    #[test]
    fn zero_pollution_checkpoint_captures_and_reverts_cleanly_without_touching_index() {
        let root = temp_test_dir("checkpoint");
        run_git(&root, &["init"]).unwrap();
        run_git(&root, &["config", "core.autocrlf", "false"]).unwrap();
        run_git(&root, &["config", "user.email", "bot@rocketx.local"]).unwrap();
        run_git(&root, &["config", "user.name", "RocketX Bot"]).unwrap();

        std::fs::write(root.join("app.txt"), "v1\n").unwrap();
        run_git(&root, &["add", "app.txt"]).unwrap();
        run_git(&root, &["commit", "-m", "init"]).unwrap();
        let initial_head = run_git(&root, &["rev-parse", "HEAD"]).unwrap();

        // Turn 1: modify tracked file AND create untracked file + stage nothing
        std::fs::write(root.join("app.txt"), "v2\n").unwrap();
        std::fs::write(root.join("notes.txt"), "turn 1 note\n").unwrap();

        let cp1 = create_checkpoint_sync(&root, "Turn 1 complete", Some("turn-1")).unwrap();
        assert_eq!(cp1.changed_files, 2);
        // Real HEAD & index must remain untouched!
        assert_eq!(
            run_git(&root, &["rev-parse", "HEAD"]).unwrap(),
            initial_head
        );
        assert!(run_git(&root, &["diff", "--cached", "--name-only"])
            .unwrap()
            .is_empty());

        let diff1 = inspect_diff_workspace_sync(&root, None).unwrap();
        assert_eq!(diff1.files.len(), 2);
        assert!(diff1
            .files
            .iter()
            .any(|f| f.path == "app.txt" && f.additions == 1 && f.deletions == 1));
        assert!(diff1
            .files
            .iter()
            .any(|f| f.path == "notes.txt" && f.status == "?"));

        // Turn 2: overwrite app.txt & add extra untracked file
        std::fs::write(root.join("app.txt"), "v3 broken\n").unwrap();
        std::fs::write(root.join("extra.tmp"), "temporary\n").unwrap();
        let _cp2 = create_checkpoint_sync(&root, "Turn 2", Some("turn-2")).unwrap();

        let checkpoints = list_checkpoints_sync(&root).unwrap();
        assert!(checkpoints.len() >= 2);
        assert_eq!(checkpoints[0].turn_id.as_deref(), Some("turn-2"));

        let backup = revert_checkpoint_sync(&root, &cp1.id, "working_tree").unwrap();
        assert_eq!(backup.turn_id.as_deref(), Some("pre-revert"));
        assert_eq!(
            std::fs::read_to_string(root.join("app.txt")).unwrap(),
            "v2\n"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("notes.txt")).unwrap(),
            "turn 1 note\n"
        );
        assert!(
            !root.join("extra.tmp").exists(),
            "untracked file absent from cp1 must be cleaned on revert"
        );

        let worktrees = list_worktrees_sync(&root, None).unwrap();
        assert_eq!(worktrees.len(), 1);
        assert!(worktrees[0].is_current);

        let _ = std::fs::remove_dir_all(&root);
    }
}
