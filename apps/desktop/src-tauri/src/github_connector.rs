use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::Manager;
use tauri_plugin_http::reqwest;

const GITHUB_CONFIG_FILE: &str = "butler_github_config.json";
const GITHUB_KEYRING_SERVICE: &str = "com.lusipad.rocketx.github";
const GITHUB_KEYRING_ACCOUNT: &str = "pat";
const DEFAULT_GITHUB_API_BASE: &str = "https://api.github.com";
const MAX_PR_DIFF_BYTES: usize = 200 * 1024;
const MAX_ISSUE_BODY_BYTES: usize = 64 * 1024;
const MAX_ISSUE_COMMENT_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitHubConfigFile {
    api_base_url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubConnectorStatus {
    pub configured: bool,
    pub api_base_url: String,
    pub has_token: bool,
    pub token_hint: Option<String>,
    pub gh_cli_available: bool,
    pub gh_cli_authenticated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubRepoIdentity {
    pub owner: String,
    pub repo: String,
    pub remote_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubIssueComment {
    pub id: u64,
    pub author: String,
    pub body: String,
    pub created_at: String,
    pub updated_at: String,
    pub html_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubIssueDetail {
    pub owner: String,
    pub repo: String,
    pub number: u64,
    pub title: String,
    pub body: String,
    pub body_truncated: bool,
    pub state: String,
    pub author: String,
    pub labels: Vec<String>,
    pub assignees: Vec<String>,
    pub html_url: String,
    pub created_at: String,
    pub updated_at: String,
    pub comments: Vec<GitHubIssueComment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubPullSummary {
    pub number: u64,
    pub title: String,
    pub state: String,
    pub author: String,
    pub head_ref: String,
    pub base_ref: String,
    pub draft: bool,
    pub html_url: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubIssueSummary {
    pub number: u64,
    pub title: String,
    pub state: String,
    pub author: String,
    pub labels: Vec<String>,
    pub html_url: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubPrDiffResult {
    pub owner: String,
    pub repo: String,
    pub number: u64,
    pub diff: String,
    pub truncated: bool,
}

fn config_path(data_dir: &Path) -> PathBuf {
    data_dir.join(GITHUB_CONFIG_FILE)
}

pub(crate) fn normalize_github_api_base(raw: Option<&str>) -> Result<String, String> {
    let trimmed = raw
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_GITHUB_API_BASE);
    if trimmed.chars().any(char::is_control) || trimmed.len() > 512 {
        return Err("GitHub API 地址无效".to_string());
    }
    let parsed = reqwest::Url::parse(trimmed)
        .map_err(|error| format!("GitHub API 地址格式无效：{error}"))?;
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("GitHub API 地址不能内嵌凭据".to_string());
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err("GitHub API 地址不能包含 query 或 fragment".to_string());
    }
    let host = parsed.host_str().unwrap_or("");
    let is_loopback = matches!(host, "127.0.0.1" | "localhost" | "::1" | "[::1]");
    match parsed.scheme() {
        "https" => {}
        "http" if is_loopback => {}
        _ => {
            return Err("GitHub 连接器仅允许 HTTPS（或本地回环 http）地址".to_string());
        }
    }
    Ok(trimmed.trim_end_matches('/').to_string())
}

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

fn keyring_entry() -> Result<keyring::Entry, String> {
    let service = crate::credential_scope::service_name(GITHUB_KEYRING_SERVICE)?;
    keyring::Entry::new(&service, GITHUB_KEYRING_ACCOUNT)
        .map_err(|error| format!("GitHub 凭据库不可用：{error}"))
}

fn read_token() -> Result<Option<String>, String> {
    match keyring_entry()?.get_password() {
        Ok(val) if !val.trim().is_empty() => Ok(Some(val)),
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("无法读取 GitHub Token：{error}")),
    }
}

fn token_hint(token: &str) -> String {
    let len = token.chars().count();
    if len <= 8 {
        "****".to_string()
    } else {
        let prefix: String = token.chars().take(4).collect();
        let suffix: String = token.chars().skip(len - 4).collect();
        format!("{prefix}…{suffix}")
    }
}

fn load_api_base(data_dir: &Path) -> String {
    let path = config_path(data_dir);
    let Ok(raw) = std::fs::read_to_string(path) else {
        return DEFAULT_GITHUB_API_BASE.to_string();
    };
    let Ok(parsed) = serde_json::from_str::<GitHubConfigFile>(&raw) else {
        return DEFAULT_GITHUB_API_BASE.to_string();
    };
    normalize_github_api_base(Some(&parsed.api_base_url))
        .unwrap_or_else(|_| DEFAULT_GITHUB_API_BASE.to_string())
}

fn save_api_base(data_dir: &Path, api_base: &str) -> Result<(), String> {
    std::fs::create_dir_all(data_dir).map_err(|error| format!("无法创建应用数据目录：{error}"))?;
    let path = config_path(data_dir);
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_string_pretty(&GitHubConfigFile {
        api_base_url: api_base.to_string(),
    })
    .map_err(|error| format!("无法序列化 GitHub 配置：{error}"))?;
    std::fs::write(&tmp, format!("{json}\n"))
        .map_err(|error| format!("无法写入 GitHub 配置：{error}"))?;
    std::fs::rename(&tmp, &path).map_err(|error| format!("无法保存 GitHub 配置：{error}"))?;
    Ok(())
}

fn gh_cli_available() -> bool {
    crate::native::process::hidden_command("gh")
        .arg("--version")
        .output()
        .is_ok_and(|o| o.status.success())
}

fn read_gh_cli_token() -> Option<String> {
    let output = crate::native::process::hidden_command("gh")
        .args(["auth", "token"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if token.is_empty() || token.chars().any(char::is_control) {
        return None;
    }
    Some(token)
}

fn resolve_effective_token() -> Result<Option<String>, String> {
    if let Some(tok) = read_token()? {
        return Ok(Some(tok));
    }
    Ok(read_gh_cli_token())
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

fn build_client(token: Option<&str>) -> Result<reqwest::Client, String> {
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        reqwest::header::USER_AGENT,
        reqwest::header::HeaderValue::from_static("RocketX-Butler/0.44"),
    );
    headers.insert(
        reqwest::header::ACCEPT,
        reqwest::header::HeaderValue::from_static("application/vnd.github+json"),
    );
    if let Some(tok) = token {
        let header_val = reqwest::header::HeaderValue::from_str(&format!("Bearer {tok}"))
            .map_err(|_| "GitHub Token 包含非法头部字符".to_string())?;
        headers.insert(reqwest::header::AUTHORIZATION, header_val);
    }
    reqwest::Client::builder()
        .default_headers(headers)
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|error| format!("无法初始化 HTTP 客户端：{error}"))
}

fn truncate_utf8_bytes(input: &str, max_bytes: usize) -> (String, bool) {
    if input.len() <= max_bytes {
        return (input.to_string(), false);
    }
    let mut end = max_bytes;
    while end > 0 && !input.is_char_boundary(end) {
        end -= 1;
    }
    (input[..end].to_string(), true)
}

#[tauri::command]
pub fn butler_github_status(app: tauri::AppHandle) -> Result<GitHubConnectorStatus, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let api_base_url = load_api_base(&data_dir);
    let token = read_token().ok().flatten();
    let gh_avail = gh_cli_available();
    let gh_auth = if gh_avail {
        read_gh_cli_token().is_some()
    } else {
        false
    };
    Ok(GitHubConnectorStatus {
        configured: token.is_some() || gh_auth,
        api_base_url,
        has_token: token.is_some(),
        token_hint: token.as_deref().map(token_hint),
        gh_cli_available: gh_avail,
        gh_cli_authenticated: gh_auth,
    })
}

#[tauri::command]
pub fn butler_github_save_config(
    app: tauri::AppHandle,
    api_base_url: Option<String>,
    token: Option<String>,
) -> Result<GitHubConnectorStatus, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let normalized_url = normalize_github_api_base(api_base_url.as_deref())?;
    save_api_base(&data_dir, &normalized_url)?;

    if let Some(tok) = token {
        let clean = tok.trim();
        if clean.is_empty() || clean.chars().any(char::is_control) {
            return Err("GitHub PAT 不能为空或包含控制字符".to_string());
        }
        keyring_entry()?
            .set_password(clean)
            .map_err(|error| format!("无法写入 GitHub PAT 到系统凭据库：{error}"))?;
    }

    butler_github_status(app)
}

#[tauri::command]
pub fn butler_github_clear_config(app: tauri::AppHandle) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    match keyring_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(error) => return Err(format!("无法清除 GitHub PAT：{error}")),
    }
    let path = config_path(&data_dir);
    if path.is_file() {
        let _ = std::fs::remove_file(path);
    }
    Ok(())
}

#[tauri::command]
pub async fn butler_github_test_connection(
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let api_base = load_api_base(&data_dir);
    let token = resolve_effective_token()?
        .ok_or_else(|| "尚未配置 GitHub Token（也未检测到已登录的 gh CLI）".to_string())?;
    let client = build_client(Some(&token))?;
    let resp = client
        .get(format!("{api_base}/user"))
        .send()
        .await
        .map_err(|error| format!("连接 GitHub 失败：{error}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("GitHub 认证失败（HTTP {status}）"));
    }
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|error| format!("解析 GitHub 用户信息失败：{error}"))?;
    Ok(serde_json::json!({
        "ok": true,
        "login": body.get("login").and_then(|v| v.as_str()).unwrap_or(""),
        "name": body.get("name").and_then(|v| v.as_str()).unwrap_or(""),
        "apiBaseUrl": api_base,
    }))
}

#[tauri::command]
pub async fn butler_github_list_prs(
    app: tauri::AppHandle,
    owner: String,
    repo: String,
    state: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<GitHubPullSummary>, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let api_base = load_api_base(&data_dir);
    let owner = validate_repo_segment(&owner, "owner")?;
    let repo = validate_repo_segment(&repo, "repo")?;
    let pr_state = match state.as_deref().map(str::trim) {
        Some("closed") => "closed",
        Some("all") => "all",
        _ => "open",
    };
    let per_page = limit.unwrap_or(20).clamp(1, 50);
    let token = resolve_effective_token().ok().flatten();
    let client = build_client(token.as_deref())?;

    let resp = client
        .get(format!(
            "{api_base}/repos/{owner}/{repo}/pulls?state={pr_state}&per_page={per_page}"
        ))
        .send()
        .await
        .map_err(|error| format!("查询 GitHub PR 失败：{error}"))?;
    if !resp.status().is_success() {
        return Err(format!("GitHub PR 请求失败（HTTP {}）", resp.status()));
    }
    let items: Vec<serde_json::Value> = resp
        .json()
        .await
        .map_err(|error| format!("解析 PR 列表失败：{error}"))?;
    Ok(items
        .into_iter()
        .map(|item| GitHubPullSummary {
            number: item.get("number").and_then(|v| v.as_u64()).unwrap_or(0),
            title: item
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            state: item
                .get("state")
                .and_then(|v| v.as_str())
                .unwrap_or("open")
                .to_string(),
            author: item
                .get("user")
                .and_then(|u| u.get("login"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            head_ref: item
                .get("head")
                .and_then(|h| h.get("ref"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            base_ref: item
                .get("base")
                .and_then(|b| b.get("ref"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            draft: item.get("draft").and_then(|v| v.as_bool()).unwrap_or(false),
            html_url: item
                .get("html_url")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            updated_at: item
                .get("updated_at")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        })
        .collect())
}

#[tauri::command]
pub async fn butler_github_list_issues(
    app: tauri::AppHandle,
    owner: String,
    repo: String,
    state: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<GitHubIssueSummary>, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let api_base = load_api_base(&data_dir);
    let owner = validate_repo_segment(&owner, "owner")?;
    let repo = validate_repo_segment(&repo, "repo")?;
    let issue_state = match state.as_deref().map(str::trim) {
        Some("closed") => "closed",
        Some("all") => "all",
        _ => "open",
    };
    let per_page = limit.unwrap_or(20).clamp(1, 50);
    let token = resolve_effective_token().ok().flatten();
    let client = build_client(token.as_deref())?;

    let resp = client
        .get(format!(
            "{api_base}/repos/{owner}/{repo}/issues?state={issue_state}&per_page={per_page}"
        ))
        .send()
        .await
        .map_err(|error| format!("查询 GitHub Issue 失败：{error}"))?;
    if !resp.status().is_success() {
        return Err(format!("GitHub Issue 请求失败（HTTP {}）", resp.status()));
    }
    let items: Vec<serde_json::Value> = resp
        .json()
        .await
        .map_err(|error| format!("解析 Issue 列表失败：{error}"))?;
    Ok(items
        .into_iter()
        .filter(|item| item.get("pull_request").is_none())
        .map(|item| GitHubIssueSummary {
            number: item.get("number").and_then(|v| v.as_u64()).unwrap_or(0),
            title: item
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            state: item
                .get("state")
                .and_then(|v| v.as_str())
                .unwrap_or("open")
                .to_string(),
            author: item
                .get("user")
                .and_then(|u| u.get("login"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            labels: item
                .get("labels")
                .and_then(|l| l.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|x| x.get("name").and_then(|n| n.as_str()).map(str::to_string))
                        .collect()
                })
                .unwrap_or_default(),
            html_url: item
                .get("html_url")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            updated_at: item
                .get("updated_at")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        })
        .collect())
}

#[tauri::command]
pub async fn butler_github_get_pr_diff(
    app: tauri::AppHandle,
    owner: String,
    repo: String,
    number: u64,
) -> Result<GitHubPrDiffResult, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let api_base = load_api_base(&data_dir);
    let owner = validate_repo_segment(&owner, "owner")?;
    let repo = validate_repo_segment(&repo, "repo")?;
    let token = resolve_effective_token().ok().flatten();
    let client = build_client(token.as_deref())?;

    let resp = client
        .get(format!("{api_base}/repos/{owner}/{repo}/pulls/{number}"))
        .header(reqwest::header::ACCEPT, "application/vnd.github.v3.diff")
        .send()
        .await
        .map_err(|error| format!("读取 PR diff 失败：{error}"))?;
    if !resp.status().is_success() {
        return Err(format!("读取 PR diff 失败（HTTP {}）", resp.status()));
    }
    let raw = resp
        .text()
        .await
        .map_err(|error| format!("读取 PR diff 文本失败：{error}"))?;
    let (diff, truncated) = truncate_utf8_bytes(&raw, MAX_PR_DIFF_BYTES);
    Ok(GitHubPrDiffResult {
        owner,
        repo,
        number,
        diff,
        truncated,
    })
}

#[tauri::command]
pub async fn butler_github_create_comment(
    app: tauri::AppHandle,
    owner: String,
    repo: String,
    number: u64,
    body: String,
) -> Result<serde_json::Value, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let api_base = load_api_base(&data_dir);
    let owner = validate_repo_segment(&owner, "owner")?;
    let repo = validate_repo_segment(&repo, "repo")?;
    let clean_body = body.trim();
    if clean_body.is_empty() {
        return Err("评论内容不能为空".to_string());
    }
    let token = resolve_effective_token()?
        .ok_or_else(|| "发表评论需要配置 GitHub PAT 或登录 gh CLI".to_string())?;
    let client = build_client(Some(&token))?;

    let resp = client
        .post(format!(
            "{api_base}/repos/{owner}/{repo}/issues/{number}/comments"
        ))
        .json(&serde_json::json!({ "body": clean_body }))
        .send()
        .await
        .map_err(|error| format!("发表 GitHub 评论失败：{error}"))?;
    if !resp.status().is_success() {
        return Err(format!("发表 GitHub 评论失败（HTTP {}）", resp.status()));
    }
    resp.json()
        .await
        .map_err(|error| format!("解析评论响应失败：{error}"))
}

#[tauri::command]
pub async fn butler_github_detect_workspace_repo(
    workspace_root: String,
) -> Result<Option<GitHubRepoIdentity>, String> {
    let trimmed = workspace_root.trim().to_string();
    if trimmed.is_empty() {
        return Ok(None);
    }
    tauri::async_runtime::spawn_blocking(move || {
        let Ok(Some(remote_url)) = crate::butler_worktree::read_workspace_origin_url(&trimmed)
        else {
            return Ok(None);
        };
        let Some((owner, repo)) = parse_github_remote_url(&remote_url) else {
            return Ok(None);
        };
        Ok(Some(GitHubRepoIdentity {
            owner,
            repo,
            remote_url,
        }))
    })
    .await
    .map_err(|error| format!("检测工作区 GitHub 仓库失败：{error}"))?
}

#[tauri::command]
pub async fn butler_github_get_issue_detail(
    app: tauri::AppHandle,
    owner: String,
    repo: String,
    number: u64,
    comment_limit: Option<u32>,
) -> Result<GitHubIssueDetail, String> {
    if number == 0 {
        return Err("Issue 编号必须为正整数".to_string());
    }
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let api_base = load_api_base(&data_dir);
    let owner = validate_repo_segment(&owner, "owner")?;
    let repo = validate_repo_segment(&repo, "repo")?;
    let per_page = comment_limit.unwrap_or(20).clamp(1, 50);
    let token = resolve_effective_token().ok().flatten();
    let client = build_client(token.as_deref())?;

    let issue_resp = client
        .get(format!("{api_base}/repos/{owner}/{repo}/issues/{number}"))
        .send()
        .await
        .map_err(|error| format!("查询 GitHub Issue 详情失败：{error}"))?;
    if !issue_resp.status().is_success() {
        return Err(format!(
            "读取 GitHub Issue #{number} 失败（HTTP {}）",
            issue_resp.status()
        ));
    }
    let item: serde_json::Value = issue_resp
        .json()
        .await
        .map_err(|error| format!("解析 Issue 详情失败：{error}"))?;
    if item.get("pull_request").is_some() {
        return Err(format!("#{number} 是 Pull Request 而非 Issue"));
    }

    let raw_body = item.get("body").and_then(|v| v.as_str()).unwrap_or("");
    let (body, body_truncated) = truncate_utf8_bytes(raw_body, MAX_ISSUE_BODY_BYTES);

    let comments_resp = client
        .get(format!(
            "{api_base}/repos/{owner}/{repo}/issues/{number}/comments?per_page={per_page}"
        ))
        .send()
        .await
        .map_err(|error| format!("查询 GitHub Issue 评论失败：{error}"))?;
    let comments = if comments_resp.status().is_success() {
        let raw_comments: Vec<serde_json::Value> = comments_resp
            .json()
            .await
            .map_err(|error| format!("解析 Issue 评论失败：{error}"))?;
        raw_comments
            .into_iter()
            .map(|c| {
                let raw_c_body = c.get("body").and_then(|v| v.as_str()).unwrap_or("");
                let (c_body, _) = truncate_utf8_bytes(raw_c_body, MAX_ISSUE_COMMENT_BYTES);
                GitHubIssueComment {
                    id: c.get("id").and_then(|v| v.as_u64()).unwrap_or(0),
                    author: c
                        .get("user")
                        .and_then(|u| u.get("login"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    body: c_body,
                    created_at: c
                        .get("created_at")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    updated_at: c
                        .get("updated_at")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    html_url: c
                        .get("html_url")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                }
            })
            .collect()
    } else {
        Vec::new()
    };

    Ok(GitHubIssueDetail {
        owner,
        repo,
        number: item
            .get("number")
            .and_then(|v| v.as_u64())
            .unwrap_or(number),
        title: item
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        body,
        body_truncated,
        state: item
            .get("state")
            .and_then(|v| v.as_str())
            .unwrap_or("open")
            .to_string(),
        author: item
            .get("user")
            .and_then(|u| u.get("login"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        labels: item
            .get("labels")
            .and_then(|l| l.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|x| x.get("name").and_then(|n| n.as_str()).map(str::to_string))
                    .collect()
            })
            .unwrap_or_default(),
        assignees: item
            .get("assignees")
            .and_then(|l| l.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|x| x.get("login").and_then(|n| n.as_str()).map(str::to_string))
                    .collect()
            })
            .unwrap_or_default(),
        html_url: item
            .get("html_url")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        created_at: item
            .get("created_at")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        updated_at: item
            .get("updated_at")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        comments,
    })
}

pub(crate) async fn create_pull_request_via_api(
    app: &tauri::AppHandle,
    owner: &str,
    repo: &str,
    title: &str,
    body: &str,
    head: &str,
    base: &str,
    draft: bool,
) -> Result<Option<String>, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let api_base = load_api_base(&data_dir);
    let owner = validate_repo_segment(owner, "owner")?;
    let repo = validate_repo_segment(repo, "repo")?;
    let Some(token) = resolve_effective_token()? else {
        return Ok(None);
    };
    let client = build_client(Some(&token))?;
    let resp = client
        .post(format!("{api_base}/repos/{owner}/{repo}/pulls"))
        .json(&serde_json::json!({
            "title": title,
            "body": body,
            "head": head,
            "base": base,
            "draft": draft,
        }))
        .send()
        .await
        .map_err(|error| format!("通过 GitHub API 创建 PR 失败：{error}"))?;
    if !resp.status().is_success() {
        return Err(format!("GitHub API 创建 PR 失败（HTTP {}）", resp.status()));
    }
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|error| format!("解析 PR 创建响应失败：{error}"))?;
    Ok(json
        .get("html_url")
        .and_then(|v| v.as_str())
        .map(str::to_string))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_github_urls_and_repo_segments() {
        assert_eq!(
            normalize_github_api_base(None).unwrap(),
            "https://api.github.com"
        );
        assert_eq!(
            normalize_github_api_base(Some("http://127.0.0.1:8080/api/v3/")).unwrap(),
            "http://127.0.0.1:8080/api/v3"
        );
        assert!(normalize_github_api_base(Some("http://github.com/api")).is_err());
        assert!(normalize_github_api_base(Some("https://user:pass@api.github.com")).is_err());
        assert!(validate_repo_segment("../evil", "repo").is_err());
        assert!(validate_repo_segment("rocketchatx", "repo").is_ok());
    }

    #[test]
    fn truncates_large_diffs_safely_on_utf8_boundaries() {
        let long = "a".repeat(MAX_PR_DIFF_BYTES + 128);
        let (out, truncated) = truncate_utf8_bytes(&long, MAX_PR_DIFF_BYTES);
        assert!(truncated);
        assert_eq!(out.len(), MAX_PR_DIFF_BYTES);
    }

    #[test]
    fn parses_github_remote_urls_for_https_ssh_and_local_hosts() {
        assert_eq!(
            parse_github_remote_url("https://github.com/lusipad/RocketX.git"),
            Some(("lusipad".to_string(), "RocketX".to_string()))
        );
        assert_eq!(
            parse_github_remote_url("git@github.com:lusipad/RocketX.git"),
            Some(("lusipad".to_string(), "RocketX".to_string()))
        );
        assert_eq!(
            parse_github_remote_url("ssh://git@github.com/lusipad/RocketX"),
            Some(("lusipad".to_string(), "RocketX".to_string()))
        );
        assert_eq!(
            parse_github_remote_url("http://127.0.0.1:18080/acme/price-utils.git"),
            Some(("acme".to_string(), "price-utils".to_string()))
        );
        assert_eq!(
            parse_github_remote_url("https://dev.azure.com/org/proj/_git/RocketX"),
            None
        );
    }
}
