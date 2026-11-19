use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Manager;

use crate::native::process::{hidden_command, host_path};

const MANAGED_WORKTREES_DIR: &str = "worktrees";

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
}
