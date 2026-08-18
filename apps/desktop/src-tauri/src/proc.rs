use std::{
    collections::HashMap,
    ffi::{OsStr, OsString},
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use base64::Engine;
use minisign_verify::{PublicKey, Signature};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{Emitter, Manager};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;

const MAX_MESSAGE_BYTES: usize = 2 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES: usize = 10 * 1024 * 1024;
const MAX_ARTIFACT_BYTES: u64 = 12 * 1024 * 1024;
const MAX_WORKSPACE_CONFIG_BYTES: u64 = 1024 * 1024;
const UPDATER_PUBLIC_KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDE5MzhFNzU5Q0ZDRDQ3MTIKUldRU1I4M1BXZWM0R1owekdDWWwyV3ZwTlFuRnNwNlZOK0QwMVRUNUNFSmhSdkJBYzZsMDBaSjYK";
const BUTLER_BUNDLED_SKILLS_DIR: &str = "codex-skills";
const AZURE_DEVOPS_SERVER_HOST_ADAPTER: &str = "azure-devops-server-host-adapter.ps1";
const AZURE_DEVOPS_SERVER_STDOUT_LIMIT: usize = 1024 * 1024;
const AZURE_DEVOPS_SERVER_STDERR_LIMIT: usize = 32 * 1024;
const AZURE_DEVOPS_SERVER_BODY_LIMIT: usize = 64 * 1024;
const AZURE_DEVOPS_SERVER_TIMEOUT: Duration = Duration::from_secs(60);
const BUSINESS_MCP_AZURE_DEVOPS_SERVER_TIMEOUT: Duration = Duration::from_secs(15);
const AZURE_DEVOPS_SERVER_BASE_URL_ENV_VARS: [&str; 2] = [
    "AZURE_DEVOPS_SERVER_SEARCH_BASE_URL",
    "AZURE_DEVOPS_SERVER_TESTRESULTS_BASE_URL",
];
// 候选下限不是兼容承诺。只有跑过完整语义门禁的版本才进入 verified 列表；
// 更高版本可在轻量启动探测通过后使用，但必须向用户标记为未验证。
const CODEX_MINIMUM_CANDIDATE: &str = "0.140.0";
const CODEX_PROTOCOL_BASELINE: &str = "0.144.4";
const CODEX_VERIFIED_VERSIONS: &[&str] = &[CODEX_PROTOCOL_BASELINE];

#[derive(Clone)]
struct ManagedCodex {
    process_id: String,
    session_id: String,
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<ChildStdin>>,
    attachments_dir: PathBuf,
    workspace_root: String,
    version: String,
    runtime_source: CodexRuntimeSource,
}

#[derive(Default)]
pub struct CodexAppServerState {
    processes: Arc<Mutex<HashMap<String, ManagedCodex>>>,
    next_id: Arc<AtomicU64>,
}

#[derive(Default)]
pub struct CodexRuntimeConfig {
    manual_path: Mutex<Option<PathBuf>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexProcessInfo {
    process_id: String,
    version: String,
    runtime_workspace_root: String,
    runtime_source: CodexRuntimeSource,
    managed_skill_roots: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CodexRuntimeSource {
    Manual,
    Bundled,
    Standard,
    System,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CodexCompatibilityStatus {
    Verified,
    UntestedNewer,
    Blocked,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CodexRuntimeReasonCode {
    NotFound,
    Outdated,
    ManualPath,
    MissingAppServer,
    NotLoggedIn,
    Unavailable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CodexRuntimeCandidateOutcome {
    Selected,
    Rejected,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRuntimeCandidate {
    source: CodexRuntimeSource,
    path: String,
    version: Option<String>,
    outcome: CodexRuntimeCandidateOutcome,
    reason_code: Option<CodexRuntimeReasonCode>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRuntimeProbe {
    ready: bool,
    version: Option<String>,
    executable_path: Option<String>,
    source: Option<CodexRuntimeSource>,
    protocol_baseline: &'static str,
    minimum_candidate: &'static str,
    verified_versions: &'static [&'static str],
    compatibility_status: CodexCompatibilityStatus,
    reason_code: Option<CodexRuntimeReasonCode>,
    reason: Option<String>,
    candidates: Vec<CodexRuntimeCandidate>,
}

impl CodexRuntimeProbe {
    fn new(
        ready: bool,
        version: Option<String>,
        executable_path: Option<String>,
        source: Option<CodexRuntimeSource>,
        compatibility_status: CodexCompatibilityStatus,
        reason_code: Option<CodexRuntimeReasonCode>,
        reason: Option<String>,
        candidates: Vec<CodexRuntimeCandidate>,
    ) -> Self {
        Self {
            ready,
            version,
            executable_path,
            source,
            protocol_baseline: CODEX_PROTOCOL_BASELINE,
            minimum_candidate: CODEX_MINIMUM_CANDIDATE,
            verified_versions: CODEX_VERIFIED_VERSIONS,
            compatibility_status,
            reason_code,
            reason,
            candidates,
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexOutputEvent {
    process_id: String,
    stream: &'static str,
    line: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexExitEvent {
    process_id: String,
    code: Option<i32>,
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

#[derive(Clone)]
struct ResolvedCodex {
    program: PathBuf,
    prefix_args: Vec<OsString>,
    display_path: String,
    source: CodexRuntimeSource,
    version: String,
}

impl ResolvedCodex {
    fn command(&self) -> Command {
        let mut command = Command::new(&self.program);
        command.args(&self.prefix_args);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        command
    }
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

fn resolved_codex_path(path: &Path, source: CodexRuntimeSource) -> Result<ResolvedCodex, String> {
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("Codex 路径不可用：{error}"))?;
    // canonicalize 产生的 `\\?\` 扩展前缀会让 Node 无法加载作为入口脚本的
    // codex.js，也不适合作为子进程工作目录，统一还原成常规主机路径。
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
fn standard_codex_paths() -> Vec<PathBuf> {
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
fn standard_codex_paths() -> Vec<PathBuf> {
    Vec::new()
}

fn bundled_codex_paths(app: &tauri::AppHandle) -> Vec<PathBuf> {
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

fn system_codex_paths() -> Vec<PathBuf> {
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

fn parse_semantic_version(version: &str) -> Option<(u64, u64, u64)> {
    let core = version.split(['-', '+']).next()?;
    let mut parts = core.split('.');
    let parsed = (
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
    );
    parts.next().is_none().then_some(parsed)
}

fn classify_codex_version(version: &str) -> Result<CodexCompatibilityStatus, String> {
    let actual = parse_semantic_version(version)
        .ok_or_else(|| format!("Codex 返回了无法识别的版本 {version}"))?;
    if CODEX_VERIFIED_VERSIONS.contains(&version) {
        return Ok(CodexCompatibilityStatus::Verified);
    }
    let baseline =
        parse_semantic_version(CODEX_PROTOCOL_BASELINE).expect("Codex protocol baseline is valid");
    if actual < baseline || (actual == baseline && version.contains('-')) {
        return Ok(CodexCompatibilityStatus::Blocked);
    }
    Ok(CodexCompatibilityStatus::UntestedNewer)
}

fn unsupported_codex_version_message(version: &str) -> String {
    format!(
        "找到 Codex {version}，但低于 RocketX 所需的协议基线 \
         {CODEX_PROTOCOL_BASELINE}；请升级后重新检测"
    )
}

fn probe_display_path(path: &Path) -> String {
    path.canonicalize()
        .map(|canonical| host_path(&canonical))
        .unwrap_or_else(|_| host_path(path))
}

fn codex_runtime_candidate(
    source: CodexRuntimeSource,
    path: String,
    version: Option<String>,
    outcome: CodexRuntimeCandidateOutcome,
    reason_code: Option<CodexRuntimeReasonCode>,
) -> CodexRuntimeCandidate {
    CodexRuntimeCandidate {
        source,
        path,
        version,
        outcome,
        reason_code,
    }
}

#[derive(Clone, Debug)]
struct CodexRuntimeProbeFailure {
    source: Option<CodexRuntimeSource>,
    executable_path: Option<String>,
    version: Option<String>,
    compatibility_status: CodexCompatibilityStatus,
    reason_code: CodexRuntimeReasonCode,
    reason: String,
}

struct CodexRuntimeScan {
    resolved: Option<ResolvedCodex>,
    compatibility_status: CodexCompatibilityStatus,
    reason_code: Option<CodexRuntimeReasonCode>,
    reason: Option<String>,
    candidates: Vec<CodexRuntimeCandidate>,
}

fn codex_runtime_failure_rank(reason_code: CodexRuntimeReasonCode) -> usize {
    match reason_code {
        CodexRuntimeReasonCode::NotLoggedIn => 0,
        CodexRuntimeReasonCode::MissingAppServer => 1,
        CodexRuntimeReasonCode::Outdated => 2,
        CodexRuntimeReasonCode::Unavailable => 3,
        CodexRuntimeReasonCode::NotFound => 4,
        CodexRuntimeReasonCode::ManualPath => 5,
    }
}

fn replace_probe_failure(
    current: &Option<CodexRuntimeProbeFailure>,
    next: &CodexRuntimeProbeFailure,
) -> bool {
    current.as_ref().is_none_or(|existing| {
        codex_runtime_failure_rank(next.reason_code)
            < codex_runtime_failure_rank(existing.reason_code)
    })
}

fn codex_runtime_scan_from_candidates_with<VersionProbe, CapabilityProbe, LoginProbe>(
    manual_path: Option<&Path>,
    system_paths: &[PathBuf],
    standard_paths: &[PathBuf],
    bundled_paths: &[PathBuf],
    mut version_probe: VersionProbe,
    mut capability_probe: CapabilityProbe,
    mut login_probe: LoginProbe,
) -> CodexRuntimeScan
where
    VersionProbe: FnMut(&ResolvedCodex) -> Result<String, String>,
    CapabilityProbe: FnMut(&ResolvedCodex) -> Result<(), String>,
    LoginProbe: FnMut(&ResolvedCodex) -> Result<(), String>,
{
    let manual_mode = manual_path.is_some();
    let mut candidates = Vec::new();
    let mut best_failure = None;
    let manual_paths = manual_path.map(|path| vec![path.to_path_buf()]);
    let candidate_groups: Vec<(&[PathBuf], CodexRuntimeSource)> =
        if let Some(paths) = manual_paths.as_ref() {
            vec![(paths.as_slice(), CodexRuntimeSource::Manual)]
        } else {
            vec![
                (system_paths, CodexRuntimeSource::System),
                (standard_paths, CodexRuntimeSource::Standard),
                (bundled_paths, CodexRuntimeSource::Bundled),
            ]
        };

    for (paths, source) in candidate_groups {
        for path in paths {
            let display_path = probe_display_path(path);
            if !path.is_file() {
                candidates.push(codex_runtime_candidate(
                    source,
                    display_path.clone(),
                    None,
                    CodexRuntimeCandidateOutcome::Rejected,
                    Some(CodexRuntimeReasonCode::NotFound),
                ));
                let failure = CodexRuntimeProbeFailure {
                    source: Some(source),
                    executable_path: Some(display_path),
                    version: None,
                    compatibility_status: CodexCompatibilityStatus::Blocked,
                    reason_code: CodexRuntimeReasonCode::NotFound,
                    reason: "未检测到可用的 Codex".to_string(),
                };
                if replace_probe_failure(&best_failure, &failure) {
                    best_failure = Some(failure);
                }
                continue;
            }

            let mut resolved = match resolved_codex_path(path, source) {
                Ok(value) => value,
                Err(reason) => {
                    candidates.push(codex_runtime_candidate(
                        source,
                        display_path.clone(),
                        None,
                        CodexRuntimeCandidateOutcome::Rejected,
                        Some(CodexRuntimeReasonCode::Unavailable),
                    ));
                    let failure = CodexRuntimeProbeFailure {
                        source: Some(source),
                        executable_path: Some(display_path),
                        version: None,
                        compatibility_status: CodexCompatibilityStatus::Blocked,
                        reason_code: CodexRuntimeReasonCode::Unavailable,
                        reason,
                    };
                    if replace_probe_failure(&best_failure, &failure) {
                        best_failure = Some(failure);
                    }
                    continue;
                }
            };

            let version = match version_probe(&resolved) {
                Ok(value) => value,
                Err(reason) => {
                    candidates.push(codex_runtime_candidate(
                        source,
                        resolved.display_path.clone(),
                        None,
                        CodexRuntimeCandidateOutcome::Rejected,
                        Some(CodexRuntimeReasonCode::Unavailable),
                    ));
                    let failure = CodexRuntimeProbeFailure {
                        source: Some(source),
                        executable_path: Some(resolved.display_path.clone()),
                        version: None,
                        compatibility_status: CodexCompatibilityStatus::Blocked,
                        reason_code: CodexRuntimeReasonCode::Unavailable,
                        reason,
                    };
                    if replace_probe_failure(&best_failure, &failure) {
                        best_failure = Some(failure);
                    }
                    continue;
                }
            };
            resolved.version = version.clone();

            let compatibility_status = match classify_codex_version(&version) {
                Ok(value) => value,
                Err(reason) => {
                    candidates.push(codex_runtime_candidate(
                        source,
                        resolved.display_path.clone(),
                        Some(version.clone()),
                        CodexRuntimeCandidateOutcome::Rejected,
                        Some(CodexRuntimeReasonCode::Unavailable),
                    ));
                    let failure = CodexRuntimeProbeFailure {
                        source: Some(source),
                        executable_path: Some(resolved.display_path.clone()),
                        version: Some(version),
                        compatibility_status: CodexCompatibilityStatus::Blocked,
                        reason_code: CodexRuntimeReasonCode::Unavailable,
                        reason,
                    };
                    if replace_probe_failure(&best_failure, &failure) {
                        best_failure = Some(failure);
                    }
                    continue;
                }
            };

            if compatibility_status == CodexCompatibilityStatus::Blocked {
                let reason = unsupported_codex_version_message(&resolved.version);
                candidates.push(codex_runtime_candidate(
                    source,
                    resolved.display_path.clone(),
                    Some(resolved.version.clone()),
                    CodexRuntimeCandidateOutcome::Rejected,
                    Some(CodexRuntimeReasonCode::Outdated),
                ));
                let failure = CodexRuntimeProbeFailure {
                    source: Some(source),
                    executable_path: Some(resolved.display_path.clone()),
                    version: Some(resolved.version.clone()),
                    compatibility_status: CodexCompatibilityStatus::Blocked,
                    reason_code: CodexRuntimeReasonCode::Outdated,
                    reason,
                };
                if replace_probe_failure(&best_failure, &failure) {
                    best_failure = Some(failure);
                }
                if manual_mode {
                    let reason = format!(
                        "手动指定的 Codex 不可用：{}",
                        unsupported_codex_version_message(&resolved.version)
                    );
                    return CodexRuntimeScan {
                        resolved: Some(resolved),
                        compatibility_status: CodexCompatibilityStatus::Blocked,
                        reason_code: Some(CodexRuntimeReasonCode::ManualPath),
                        reason: Some(reason),
                        candidates,
                    };
                }
                continue;
            }

            if let Err(reason) = capability_probe(&resolved) {
                let reason = format!("Codex 缺少 app-server 能力：{reason}");
                candidates.push(codex_runtime_candidate(
                    source,
                    resolved.display_path.clone(),
                    Some(resolved.version.clone()),
                    CodexRuntimeCandidateOutcome::Rejected,
                    Some(CodexRuntimeReasonCode::MissingAppServer),
                ));
                let failure = CodexRuntimeProbeFailure {
                    source: Some(source),
                    executable_path: Some(resolved.display_path.clone()),
                    version: Some(resolved.version.clone()),
                    compatibility_status,
                    reason_code: CodexRuntimeReasonCode::MissingAppServer,
                    reason: reason.clone(),
                };
                if manual_mode {
                    return CodexRuntimeScan {
                        resolved: Some(resolved),
                        compatibility_status,
                        reason_code: Some(CodexRuntimeReasonCode::ManualPath),
                        reason: Some(format!("手动指定的 Codex 不可用：{reason}")),
                        candidates,
                    };
                }
                if replace_probe_failure(&best_failure, &failure) {
                    best_failure = Some(failure);
                }
                continue;
            }

            if let Err(reason) = login_probe(&resolved) {
                let reason = format!("Codex 尚未登录：{reason}");
                candidates.push(codex_runtime_candidate(
                    source,
                    resolved.display_path.clone(),
                    Some(resolved.version.clone()),
                    CodexRuntimeCandidateOutcome::Rejected,
                    Some(CodexRuntimeReasonCode::NotLoggedIn),
                ));
                let failure = CodexRuntimeProbeFailure {
                    source: Some(source),
                    executable_path: Some(resolved.display_path.clone()),
                    version: Some(resolved.version.clone()),
                    compatibility_status,
                    reason_code: CodexRuntimeReasonCode::NotLoggedIn,
                    reason: reason.clone(),
                };
                if manual_mode {
                    return CodexRuntimeScan {
                        resolved: Some(resolved),
                        compatibility_status,
                        reason_code: Some(CodexRuntimeReasonCode::ManualPath),
                        reason: Some(format!("手动指定的 Codex 不可用：{reason}")),
                        candidates,
                    };
                }
                if replace_probe_failure(&best_failure, &failure) {
                    best_failure = Some(failure);
                }
                continue;
            }

            candidates.push(codex_runtime_candidate(
                source,
                resolved.display_path.clone(),
                Some(resolved.version.clone()),
                CodexRuntimeCandidateOutcome::Selected,
                None,
            ));
            return CodexRuntimeScan {
                resolved: Some(resolved),
                compatibility_status,
                reason_code: None,
                reason: None,
                candidates,
            };
        }
    }

    let failure = best_failure.unwrap_or(CodexRuntimeProbeFailure {
        source: None,
        executable_path: None,
        version: None,
        compatibility_status: CodexCompatibilityStatus::Blocked,
        reason_code: CodexRuntimeReasonCode::NotFound,
        reason: "未检测到可用的 Codex".to_string(),
    });
    let reason_code = if manual_mode {
        CodexRuntimeReasonCode::ManualPath
    } else {
        failure.reason_code
    };
    let reason = if manual_mode {
        format!("手动指定的 Codex 不可用：{}", failure.reason)
    } else {
        failure.reason
    };
    let failure_path = failure.executable_path.clone();
    let failure_source = failure.source;
    let failure_version = failure.version.clone();
    CodexRuntimeScan {
        resolved: failure_path
            .clone()
            .zip(failure_source)
            .map(|(display_path, source)| ResolvedCodex {
                program: PathBuf::new(),
                prefix_args: Vec::new(),
                display_path,
                source,
                version: failure_version.clone().unwrap_or_default(),
            }),
        compatibility_status: failure.compatibility_status,
        reason_code: Some(reason_code),
        reason: Some(reason),
        candidates,
    }
}

fn codex_runtime_probe_from_candidates_with<VersionProbe, CapabilityProbe, LoginProbe>(
    manual_path: Option<&Path>,
    system_paths: &[PathBuf],
    standard_paths: &[PathBuf],
    bundled_paths: &[PathBuf],
    version_probe: VersionProbe,
    capability_probe: CapabilityProbe,
    login_probe: LoginProbe,
) -> CodexRuntimeProbe
where
    VersionProbe: FnMut(&ResolvedCodex) -> Result<String, String>,
    CapabilityProbe: FnMut(&ResolvedCodex) -> Result<(), String>,
    LoginProbe: FnMut(&ResolvedCodex) -> Result<(), String>,
{
    let scan = codex_runtime_scan_from_candidates_with(
        manual_path,
        system_paths,
        standard_paths,
        bundled_paths,
        version_probe,
        capability_probe,
        login_probe,
    );
    let (version, executable_path, source) = if let Some(resolved) = scan.resolved.as_ref() {
        (
            Some(resolved.version.clone()),
            Some(resolved.display_path.clone()),
            Some(resolved.source),
        )
    } else {
        (None, None, None)
    };
    CodexRuntimeProbe::new(
        scan.reason_code.is_none(),
        version,
        executable_path,
        source,
        scan.compatibility_status,
        scan.reason_code,
        scan.reason,
        scan.candidates,
    )
}

#[cfg(test)]
fn probe_codex_candidate<F>(
    path: &Path,
    source: CodexRuntimeSource,
    version_probe: &mut F,
) -> Result<(ResolvedCodex, CodexCompatibilityStatus), String>
where
    F: FnMut(&ResolvedCodex) -> Result<String, String>,
{
    let mut resolved = resolved_codex_path(path, source)?;
    let version = version_probe(&resolved)?;
    let status = classify_codex_version(&version)?;
    resolved.version = version;
    Ok((resolved, status))
}

#[cfg(test)]
fn probe_resolve_codex_from_candidates_with_probe<F>(
    manual_path: Option<&Path>,
    system_paths: &[PathBuf],
    standard_paths: &[PathBuf],
    bundled_paths: &[PathBuf],
    mut version_probe: F,
) -> Result<(ResolvedCodex, CodexCompatibilityStatus), String>
where
    F: FnMut(&ResolvedCodex) -> Result<String, String>,
{
    if let Some(path) = manual_path {
        return probe_codex_candidate(path, CodexRuntimeSource::Manual, &mut version_probe)
            .map_err(|reason| format!("手动指定的 Codex 不可用：{reason}"));
    }

    let mut blocked = None;
    let mut rejected = Vec::new();
    for (paths, source) in [
        (system_paths, CodexRuntimeSource::System),
        (standard_paths, CodexRuntimeSource::Standard),
        (bundled_paths, CodexRuntimeSource::Bundled),
    ] {
        for path in paths {
            if !path.is_file() {
                continue;
            }
            match probe_codex_candidate(path, source, &mut version_probe) {
                Ok((resolved, status @ CodexCompatibilityStatus::Verified))
                | Ok((resolved, status @ CodexCompatibilityStatus::UntestedNewer)) => {
                    return Ok((resolved, status));
                }
                Ok((resolved, CodexCompatibilityStatus::Blocked)) => {
                    rejected.push(unsupported_codex_version_message(&resolved.version));
                    if blocked.is_none() {
                        blocked = Some(resolved);
                    }
                }
                Err(reason) => rejected.push(reason),
            }
        }
    }
    if let Some(resolved) = blocked {
        return Ok((resolved, CodexCompatibilityStatus::Blocked));
    }
    if rejected.is_empty() {
        Err("未检测到可用的 Codex".to_string())
    } else {
        Err(rejected.join("；"))
    }
}

#[cfg(test)]
fn resolve_codex_from_candidates_with_probe<F>(
    manual_path: Option<&Path>,
    system_paths: &[PathBuf],
    standard_paths: &[PathBuf],
    bundled_paths: &[PathBuf],
    version_probe: F,
) -> Result<ResolvedCodex, String>
where
    F: FnMut(&ResolvedCodex) -> Result<String, String>,
{
    let (resolved, status) = probe_resolve_codex_from_candidates_with_probe(
        manual_path,
        system_paths,
        standard_paths,
        bundled_paths,
        version_probe,
    )?;
    if status == CodexCompatibilityStatus::Blocked {
        let reason = unsupported_codex_version_message(&resolved.version);
        return Err(if manual_path.is_some() {
            format!("手动指定的 Codex 不可用：{reason}")
        } else {
            reason
        });
    }
    Ok(resolved)
}

fn resolve_codex_from_candidates(
    manual_path: Option<&Path>,
    system_paths: &[PathBuf],
    standard_paths: &[PathBuf],
    bundled_paths: &[PathBuf],
) -> Result<ResolvedCodex, String> {
    let scan = codex_runtime_scan_from_candidates_with(
        manual_path,
        system_paths,
        standard_paths,
        bundled_paths,
        codex_cli_version,
        |resolved| codex_command_succeeds(resolved, &["app-server", "--help"]),
        |resolved| codex_command_succeeds(resolved, &["login", "status"]),
    );
    if scan.reason_code.is_none() {
        return scan
            .resolved
            .ok_or_else(|| "未检测到可用的 Codex".to_string());
    }
    Err(scan
        .reason
        .unwrap_or_else(|| "未检测到可用的 Codex".to_string()))
}

fn configured_manual_codex_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.try_state::<CodexRuntimeConfig>()
        .and_then(|state| state.manual_path.lock().ok()?.clone())
}

fn set_manual_codex_path(
    state: &CodexRuntimeConfig,
    manual_path: Option<String>,
) -> Result<(), String> {
    let path = manual_path
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if path
        .as_deref()
        .is_some_and(|value| value.len() > 4096 || value.chars().any(char::is_control))
    {
        return Err("手动 Codex 路径无效".to_string());
    }
    *state
        .manual_path
        .lock()
        .map_err(|_| "Codex 运行时设置暂不可用".to_string())? = path.map(PathBuf::from);
    Ok(())
}

fn resolve_codex(app: &tauri::AppHandle) -> Result<ResolvedCodex, String> {
    resolve_codex_from_candidates(
        configured_manual_codex_path(app).as_deref(),
        &system_codex_paths(),
        &standard_codex_paths(),
        &bundled_codex_paths(app),
    )
}

fn version_token(token: &str) -> Option<&str> {
    let token = token.strip_prefix('v').unwrap_or(token);
    if !token
        .chars()
        .next()
        .is_some_and(|value| value.is_ascii_digit())
        || !token.contains('.')
    {
        return None;
    }
    token
        .chars()
        .all(|value| value.is_ascii_alphanumeric() || matches!(value, '.' | '-' | '+'))
        .then_some(token)
}

fn parse_codex_cli_version(output: &str, require_codex_prefix: bool) -> Option<String> {
    let mut fallback = None;
    for line in output.lines() {
        let tokens: Vec<&str> = line.split_whitespace().collect();
        let Some((first, rest)) = tokens.split_first() else {
            continue;
        };
        if first.eq_ignore_ascii_case("codex-cli") || first.eq_ignore_ascii_case("codex") {
            if let Some(version) = rest.iter().copied().find_map(version_token) {
                return Some(version.to_string());
            }
        }
        if !require_codex_prefix && fallback.is_none() {
            fallback = tokens
                .iter()
                .copied()
                .find_map(version_token)
                .map(ToOwned::to_owned);
        }
    }
    fallback
}

fn output_preview(value: &str) -> String {
    const MAX_CHARS: usize = 200;
    let value = value.trim();
    if value.chars().count() <= MAX_CHARS {
        return value.to_string();
    }
    let mut preview: String = value.chars().take(MAX_CHARS).collect();
    preview.push('…');
    preview
}

fn codex_cli_version(resolved: &ResolvedCodex) -> Result<String, String> {
    let mut command = resolved.command();
    command.arg("--version");
    let output = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| format!("Codex CLI 不可用，请先安装并登录：{error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    // 只要能读出版本号就放行：npm/pnpm 等包装脚本可能追加提示行、把版本打到
    // stderr，甚至以非零码退出；可用性另由 app-server/login 探测把关。退出码
    // 非零时只认带 codex 前缀的行，避免把报错里的其他版本号当成 Codex 版本。
    let strict = !output.status.success();
    if let Some(version) =
        parse_codex_cli_version(&stdout, strict).or_else(|| parse_codex_cli_version(&stderr, true))
    {
        return Ok(version);
    }
    let mut details = vec![match output.status.code() {
        Some(code) => format!("退出码 {code}"),
        None => "进程被信号终止".to_string(),
    }];
    for (label, value) in [("stderr", stderr.trim()), ("stdout", stdout.trim())] {
        if !value.is_empty() {
            details.push(format!("{label}：{}", output_preview(value)));
        }
    }
    Err(format!("无法读取 Codex CLI 版本（{}）", details.join("；")))
}

fn codex_command_succeeds(resolved: &ResolvedCodex, args: &[&str]) -> Result<(), String> {
    let mut command = resolved.command();
    let output = command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| format!("Codex 无法启动：{error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if detail.is_empty() {
        format!("Codex {} 执行失败", args.join(" "))
    } else {
        detail
    })
}

/// 子命令的 --help 文本，用来探测当前 CLI 版本还认识哪些参数。
/// 部分包装脚本把用法打到 stderr，两路都收。
fn subcommand_help(resolved: &ResolvedCodex, subcommand: &str) -> Result<String, String> {
    let mut command = resolved.command();
    let output = command
        .args([subcommand, "--help"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| format!("Codex 无法启动：{error}"))?;
    Ok(format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    ))
}

/// 基线 0.144.4 的 app-server 需要显式 `--stdio`；后续版本把 stdio 设为默认
/// 并移除了该参数，继续传会被 clap 拒绝并立刻以退出码 2 退出（表现为
/// 「Codex app-server 已退出（2）」）。按 `--help` 是否列出该参数决定传不传。
fn app_server_args_for_help(help: &str) -> Vec<&'static str> {
    if help.contains("--stdio") {
        vec!["app-server", "--stdio"]
    } else {
        vec!["app-server"]
    }
}

fn app_server_launch_args(resolved: &ResolvedCodex) -> Result<Vec<&'static str>, String> {
    Ok(app_server_args_for_help(&subcommand_help(
        resolved,
        "app-server",
    )?))
}

#[tauri::command]
pub fn codex_runtime_probe(
    app: tauri::AppHandle,
    config: tauri::State<'_, CodexRuntimeConfig>,
    manual_path: Option<String>,
) -> CodexRuntimeProbe {
    if let Err(reason) = set_manual_codex_path(&config, manual_path) {
        return CodexRuntimeProbe::new(
            false,
            None,
            None,
            None,
            CodexCompatibilityStatus::Blocked,
            Some(CodexRuntimeReasonCode::ManualPath),
            Some(reason),
            Vec::new(),
        );
    }
    codex_runtime_probe_from_candidates_with(
        configured_manual_codex_path(&app).as_deref(),
        &system_codex_paths(),
        &standard_codex_paths(),
        &bundled_codex_paths(&app),
        codex_cli_version,
        |resolved| codex_command_succeeds(resolved, &["app-server", "--help"]),
        |resolved| codex_command_succeeds(resolved, &["login", "status"]),
    )
}

fn validate_session_id(session_id: &str) -> Result<(), String> {
    if session_id.is_empty()
        || session_id.len() > 80
        || !session_id
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || value == '-')
    {
        return Err("invalid Agent session id".to_string());
    }
    Ok(())
}

fn canonical_directory(path: &str) -> Result<PathBuf, String> {
    let resolved =
        std::fs::canonicalize(path).map_err(|error| format!("Agent 工作区不可用：{error}"))?;
    if !resolved.is_dir() {
        return Err("Agent 工作区必须是目录".to_string());
    }
    Ok(resolved)
}

fn codex_workspace_directory(
    app: &tauri::AppHandle,
    workspace_root: &str,
) -> Result<PathBuf, String> {
    if workspace_root.trim().is_empty() || workspace_root.trim() == "~" {
        let path = app
            .path()
            .app_local_data_dir()
            .map_err(|error| format!("无法定位 RocketX 本地数据目录：{error}"))?
            .join("codex-projectless");
        std::fs::create_dir_all(&path)
            .map_err(|error| format!("无法准备 Codex projectless 目录：{error}"))?;
        return canonical_directory(&path.to_string_lossy());
    }
    canonical_directory(workspace_root)
}

#[tauri::command]
pub fn codex_default_workspace(app: tauri::AppHandle) -> Result<String, String> {
    Ok(host_path(&codex_workspace_directory(&app, "")?))
}

#[tauri::command]
pub fn codex_butler_workspace(app: tauri::AppHandle) -> Result<String, String> {
    let path = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("无法定位 RocketX 本地数据目录：{error}"))?
        .join("codex-butler");
    std::fs::create_dir_all(&path).map_err(|error| format!("无法准备 Codex 管家目录：{error}"))?;
    Ok(host_path(&canonical_directory(&path.to_string_lossy())?))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAutomationSource {
    id: String,
    content: String,
}

fn validate_automation_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 80
        || !id
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || value == '-' || value == '_')
    {
        return Err("invalid Codex automation id".to_string());
    }
    Ok(())
}

fn codex_automations_root() -> Result<PathBuf, String> {
    if let Some(configured) = std::env::var_os("CODEX_HOME") {
        let configured = PathBuf::from(configured);
        if configured.is_absolute() {
            return Ok(configured.join("automations"));
        }
    }
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .ok_or_else(|| "无法定位 Codex 用户目录".to_string())?;
    Ok(home.join(".codex").join("automations"))
}

fn list_codex_automation_files(root: &Path) -> Result<Vec<CodexAutomationSource>, String> {
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut files = Vec::new();
    for entry in
        std::fs::read_dir(root).map_err(|error| format!("无法读取 Codex 已安排目录：{error}"))?
    {
        let entry = entry.map_err(|error| format!("无法读取 Codex 已安排目录项：{error}"))?;
        if !entry
            .file_type()
            .map_err(|error| format!("无法读取 Codex 已安排目录项类型：{error}"))?
            .is_dir()
        {
            continue;
        }
        let id = entry.file_name().to_string_lossy().into_owned();
        if validate_automation_id(&id).is_err() {
            continue;
        }
        let path = entry.path().join("automation.toml");
        if !path.is_file() {
            continue;
        }
        let content = std::fs::read_to_string(&path)
            .map_err(|error| format!("无法读取 Codex 已安排任务 {id}：{error}"))?;
        files.push(CodexAutomationSource { id, content });
    }
    files.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(files)
}

fn write_codex_automation_file(root: &Path, id: &str, content: &str) -> Result<(), String> {
    validate_automation_id(id)?;
    if content.is_empty() || content.len() > MAX_MESSAGE_BYTES || content.contains('\0') {
        return Err("Codex automation.toml 内容无效".to_string());
    }
    let directory = root.join(id);
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("无法准备 Codex 已安排任务目录：{error}"))?;
    std::fs::write(directory.join("automation.toml"), content)
        .map_err(|error| format!("无法写入 Codex automation.toml：{error}"))
}

fn delete_codex_automation_file(root: &Path, id: &str) -> Result<(), String> {
    validate_automation_id(id)?;
    let directory = root.join(id);
    if !directory.exists() {
        return Ok(());
    }
    std::fs::remove_dir_all(&directory)
        .map_err(|error| format!("无法删除 Codex 已安排任务：{error}"))
}

#[tauri::command]
pub fn codex_automation_list() -> Result<Vec<CodexAutomationSource>, String> {
    list_codex_automation_files(&codex_automations_root()?)
}

#[tauri::command]
pub fn codex_automation_write(id: String, content: String) -> Result<(), String> {
    write_codex_automation_file(&codex_automations_root()?, &id, &content)
}

#[tauri::command]
pub fn codex_automation_delete(id: String) -> Result<(), String> {
    delete_codex_automation_file(&codex_automations_root()?, &id)
}

#[cfg(test)]
mod codex_automation_file_tests {
    use super::{
        delete_codex_automation_file, list_codex_automation_files, validate_automation_id,
        write_codex_automation_file,
    };

    #[test]
    fn automation_file_round_trip_stays_inside_automation_root() {
        let root =
            std::env::temp_dir().join(format!("rocketx-codex-automation-{}", uuid::Uuid::new_v4()));
        let content = "id = \"test-task\"\nname = \"测试\"\n";

        write_codex_automation_file(&root, "test-task", content).unwrap();
        let files = list_codex_automation_files(&root).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].id, "test-task");
        assert_eq!(files[0].content, content);

        delete_codex_automation_file(&root, "test-task").unwrap();
        assert!(list_codex_automation_files(&root).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn automation_id_rejects_parent_paths() {
        assert!(validate_automation_id("../outside").is_err());
        assert!(validate_automation_id("folder/task").is_err());
    }
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ButlerAzureDevOpsServerReadRequest {
    #[serde(default)]
    pub(crate) method: Option<String>,
    pub(crate) collection_url: String,
    #[serde(default)]
    pub(crate) auth_mode: Option<String>,
    #[serde(default)]
    pub(crate) pat: Option<String>,
    #[serde(default)]
    pub(crate) area: Option<String>,
    pub(crate) resource: String,
    #[serde(default)]
    pub(crate) project: Option<String>,
    #[serde(default)]
    pub(crate) team: Option<String>,
    #[serde(default)]
    pub(crate) query: Option<serde_json::Map<String, serde_json::Value>>,
    #[serde(default)]
    pub(crate) body: Option<serde_json::Map<String, serde_json::Value>>,
    #[serde(default)]
    pub(crate) api_version: Option<String>,
    #[serde(default)]
    pub(crate) server_version_hint: Option<String>,
    #[serde(default)]
    pub(crate) allow_conditional_area: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ValidatedButlerAzureDevOpsServerReadRequest {
    method: &'static str,
    collection_url: String,
    auth_mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pat: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    area: Option<String>,
    resource: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    project: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    team: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    query: Option<serde_json::Map<String, serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    body: Option<serde_json::Map<String, serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    api_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    server_version_hint: Option<String>,
    allow_conditional_area: bool,
}

struct StreamCapture {
    bytes: Vec<u8>,
    truncated: bool,
}

fn contained_existing_path(root: &Path, target: &Path) -> Result<PathBuf, String> {
    let canonical_root = std::fs::canonicalize(root)
        .map_err(|error| format!("资源目录不可用 {}：{error}", root.display()))?;
    let canonical_target = std::fs::canonicalize(target)
        .map_err(|error| format!("资源路径不可用 {}：{error}", target.display()))?;
    if !canonical_target.starts_with(&canonical_root) {
        return Err("资源路径越界".to_string());
    }
    Ok(canonical_target)
}

fn bundled_codex_skill_roots(app: &tauri::AppHandle) -> Result<Vec<PathBuf>, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| format!("无法定位 RocketX Skill 资源目录：{error}"))?;
    ["codex-skills", "rocketx-core-skills"]
        .into_iter()
        .map(|directory| {
            let root = resource_dir.join(directory);
            contained_existing_path(&root, &root)
        })
        .collect()
}

fn bundled_azure_devops_server_adapter_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .resource_dir()
        .map_err(|error| format!("无法定位 RocketX Skill 资源目录：{error}"))?
        .join(BUTLER_BUNDLED_SKILLS_DIR);
    contained_existing_path(&root, &root.join(AZURE_DEVOPS_SERVER_HOST_ADAPTER))
}

#[cfg(windows)]
fn first_existing_program(
    candidates: impl IntoIterator<Item = PathBuf>,
) -> Result<PathBuf, String> {
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| {
            "未找到可用的 PowerShell 运行时；请安装 PowerShell 7，或确保 Windows PowerShell 可用。"
                .to_string()
        })
}

#[cfg(windows)]
fn windows_system_directory() -> Result<PathBuf, String> {
    use std::os::windows::ffi::OsStringExt;
    use windows::Win32::System::SystemInformation::GetSystemDirectoryW;

    let mut buffer = vec![0u16; 260];
    loop {
        let length = unsafe { GetSystemDirectoryW(Some(&mut buffer)) } as usize;
        if length == 0 {
            return Err("无法定位 Windows 系统目录".to_string());
        }
        if length < buffer.len() {
            buffer.truncate(length);
            return Ok(PathBuf::from(OsString::from_wide(&buffer)));
        }
        buffer.resize(length + 1, 0);
    }
}

#[cfg(windows)]
fn resolve_pwsh_program() -> Result<PathBuf, String> {
    first_existing_program([windows_system_directory()?
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe")])
}

#[cfg(not(windows))]
fn resolve_pwsh_program() -> Result<PathBuf, String> {
    find_program("pwsh").ok_or_else(|| "未找到可用的 pwsh 运行时。".to_string())
}

fn validate_plain_string(label: &str, value: &str, max_len: usize) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > max_len || trimmed.chars().any(char::is_control) {
        return Err(format!("{label} 无效"));
    }
    Ok(trimmed.to_string())
}

fn validate_optional_plain_string(
    label: &str,
    value: Option<String>,
    max_len: usize,
) -> Result<Option<String>, String> {
    value
        .map(|value| validate_plain_string(label, &value, max_len))
        .transpose()
}

fn validate_url(label: &str, value: String) -> Result<String, String> {
    let parsed = validate_plain_string(label, &value, 2048)?;
    let url = tauri::Url::parse(&parsed).map_err(|_| format!("{label} 无效"))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(format!("{label} 无效"));
    }
    Ok(parsed)
}

fn validate_azure_devops_server_area(area: Option<String>) -> Result<Option<String>, String> {
    let Some(area) = area else {
        return Ok(None);
    };
    let area = validate_plain_string("Azure DevOps area", &area, 32)?.to_ascii_lowercase();
    let allowed = [
        "build",
        "git",
        "release",
        "search",
        "test",
        "testplan",
        "testresults",
        "wiki",
        "wit",
        "work",
    ];
    if !allowed.contains(&area.as_str()) {
        return Err("Azure DevOps area 不受支持".to_string());
    }
    Ok(Some(area))
}

fn validate_azure_devops_server_resource(resource: &str) -> Result<String, String> {
    let resource = validate_plain_string("Azure DevOps resource", resource, 512)?;
    if resource.starts_with('/')
        || resource.ends_with('/')
        || resource.contains('\\')
        || resource.contains('?')
        || resource.contains('#')
        || resource.contains(':')
        || resource.contains("//")
        || resource
            .split('/')
            .any(|segment| segment.is_empty() || matches!(segment, "." | ".."))
        || resource.chars().any(char::is_whitespace)
    {
        return Err("Azure DevOps resource 必须是相对资源路径".to_string());
    }
    Ok(resource)
}

fn validate_azure_devops_query_value(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Null
        | serde_json::Value::Bool(_)
        | serde_json::Value::Number(_)
        | serde_json::Value::String(_) => true,
        serde_json::Value::Array(items) => items.iter().all(|item| {
            matches!(
                item,
                serde_json::Value::Null
                    | serde_json::Value::Bool(_)
                    | serde_json::Value::Number(_)
                    | serde_json::Value::String(_)
            )
        }),
        serde_json::Value::Object(_) => false,
    }
}

fn validate_azure_devops_query(
    query: Option<serde_json::Map<String, serde_json::Value>>,
) -> Result<Option<serde_json::Map<String, serde_json::Value>>, String> {
    let Some(query) = query else {
        return Ok(None);
    };
    if query.len() > 64 {
        return Err("Azure DevOps query 参数过多".to_string());
    }
    for (key, value) in &query {
        if validate_plain_string("Azure DevOps query key", key, 128).is_err()
            || !validate_azure_devops_query_value(value)
        {
            return Err("Azure DevOps query 只允许基础标量或标量数组".to_string());
        }
    }
    let encoded = serde_json::to_vec(&query)
        .map_err(|error| format!("Azure DevOps query 无法编码：{error}"))?;
    if encoded.len() > 8 * 1024 {
        return Err("Azure DevOps query 过大".to_string());
    }
    Ok(Some(query))
}

fn validate_azure_devops_body(
    body: Option<serde_json::Map<String, serde_json::Value>>,
) -> Result<Option<serde_json::Map<String, serde_json::Value>>, String> {
    let Some(body) = body else {
        return Ok(None);
    };
    let encoded = serde_json::to_vec(&body)
        .map_err(|error| format!("Azure DevOps body 无法编码：{error}"))?;
    if encoded.len() > AZURE_DEVOPS_SERVER_BODY_LIMIT {
        return Err("Azure DevOps body 过大".to_string());
    }
    Ok(Some(body))
}

fn validate_server_version_hint(value: Option<String>) -> Result<Option<String>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = validate_plain_string("Azure DevOps serverVersionHint", &value, 16)?;
    let allowed = [
        "current", "20.0", "2022.1", "2022", "2020", "2019", "2018", "2017", "2015", "legacy",
    ];
    if !allowed.contains(&value.as_str()) {
        return Err("Azure DevOps serverVersionHint 无效".to_string());
    }
    Ok(Some(value))
}

fn validate_butler_azure_devops_server_read_request(
    request: ButlerAzureDevOpsServerReadRequest,
) -> Result<ValidatedButlerAzureDevOpsServerReadRequest, String> {
    let method = request
        .method
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("GET");
    let method = if method.eq_ignore_ascii_case("GET") {
        "GET"
    } else if method.eq_ignore_ascii_case("POST") {
        "POST"
    } else {
        return Err("RocketX 只允许 Azure DevOps Server GET 或只读 POST".to_string());
    };
    let body = validate_azure_devops_body(request.body)?;
    if method == "GET" && body.is_some() {
        return Err("Azure DevOps GET 请求不接受 body".to_string());
    }
    if method == "POST" && body.is_none() {
        return Err("Azure DevOps POST 请求必须提供 body".to_string());
    }

    let collection_url = validate_url("Azure DevOps collectionUrl", request.collection_url)?;
    let pat = validate_optional_plain_string("Azure DevOps PAT", request.pat, 512)?;
    let auth_mode = request
        .auth_mode
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| pat.as_ref().map(|_| "pat".to_string()))
        .unwrap_or_else(|| "default-credentials".to_string());
    if auth_mode != "pat" && auth_mode != "default-credentials" {
        return Err("Azure DevOps authMode 无效".to_string());
    }
    if auth_mode == "pat" && pat.is_none() {
        return Err("Azure DevOps authMode=pat 时必须提供 PAT".to_string());
    }
    if auth_mode == "default-credentials" && pat.is_some() {
        return Err("Azure DevOps 默认凭据模式不接受 PAT".to_string());
    }

    Ok(ValidatedButlerAzureDevOpsServerReadRequest {
        method,
        collection_url,
        auth_mode,
        pat,
        area: validate_azure_devops_server_area(request.area)?,
        resource: validate_azure_devops_server_resource(&request.resource)?,
        project: validate_optional_plain_string("Azure DevOps project", request.project, 256)?,
        team: validate_optional_plain_string("Azure DevOps team", request.team, 256)?,
        query: validate_azure_devops_query(request.query)?,
        body,
        api_version: validate_optional_plain_string(
            "Azure DevOps apiVersion",
            request.api_version,
            64,
        )?,
        server_version_hint: validate_server_version_hint(request.server_version_hint)?,
        allow_conditional_area: request.allow_conditional_area,
    })
}

fn spawn_limited_capture<R: Read + Send + 'static>(
    mut reader: R,
    limit: usize,
) -> thread::JoinHandle<Result<StreamCapture, String>> {
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let mut truncated = false;
        let mut buffer = [0u8; 8192];
        loop {
            let count = reader
                .read(&mut buffer)
                .map_err(|error| format!("读取 PowerShell 输出失败：{error}"))?;
            if count == 0 {
                break;
            }
            if bytes.len() < limit {
                let remaining = limit - bytes.len();
                let keep = remaining.min(count);
                bytes.extend_from_slice(&buffer[..keep]);
                if keep < count {
                    truncated = true;
                }
            } else {
                truncated = true;
            }
        }
        Ok(StreamCapture { bytes, truncated })
    })
}

fn sanitize_secret(text: String, secret: Option<&str>) -> String {
    match secret {
        Some(secret) if !secret.is_empty() => text.replace(secret, "***"),
        _ => text,
    }
}

fn redact_json_secret(value: &mut serde_json::Value, secret: &str) {
    match value {
        serde_json::Value::String(text) => {
            if text.contains(secret) {
                *text = text.replace(secret, "***");
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                redact_json_secret(item, secret);
            }
        }
        serde_json::Value::Object(entries) => {
            for item in entries.values_mut() {
                redact_json_secret(item, secret);
            }
        }
        _ => {}
    }
}

fn harden_azure_devops_runner_environment(command: &mut Command) {
    for name in AZURE_DEVOPS_SERVER_BASE_URL_ENV_VARS {
        command.env_remove(name);
    }
}

fn run_butler_azure_devops_server_read_with_program_and_timeout(
    program: PathBuf,
    adapter_path: PathBuf,
    request: ValidatedButlerAzureDevOpsServerReadRequest,
    timeout: Duration,
    dry_run: bool,
) -> Result<serde_json::Value, String> {
    let mut payload = serde_json::to_value(&request)
        .map_err(|error| format!("无法编码 Azure DevOps 请求：{error}"))?;
    if dry_run {
        payload
            .as_object_mut()
            .ok_or_else(|| "Azure DevOps 请求不是对象".to_string())?
            .insert("dryRun".to_string(), serde_json::Value::Bool(true));
    }
    let payload = serde_json::to_vec(&payload)
        .map_err(|error| format!("无法编码 Azure DevOps 请求：{error}"))?;
    // Windows canonicalize 会产生 `\\?\` 设备路径；Windows PowerShell 用它执行
    // `-File` 时不会设置 `$PSScriptRoot`，适配器便无法定位同目录下的 Skill 脚本。
    let adapter_path = PathBuf::from(host_path(&adapter_path));
    let display_program = program.display().to_string();
    let mut command = hidden_command(&program);
    harden_azure_devops_runner_environment(&mut command);
    command
        .arg("-NoLogo")
        .arg("-NoProfile")
        .arg("-NonInteractive");
    #[cfg(windows)]
    command.arg("-ExecutionPolicy").arg("Bypass");
    command
        .arg("-File")
        .arg(&adapter_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error| {
        format!("无法启动 Azure DevOps Server PowerShell runner（{display_program}）：{error}")
    })?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Azure DevOps Server runner stdin 不可用".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Azure DevOps Server runner stdout 不可用".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Azure DevOps Server runner stderr 不可用".to_string())?;

    let stdout_reader = spawn_limited_capture(stdout, AZURE_DEVOPS_SERVER_STDOUT_LIMIT);
    let stderr_reader = spawn_limited_capture(stderr, AZURE_DEVOPS_SERVER_STDERR_LIMIT);
    stdin
        .write_all(&payload)
        .and_then(|_| stdin.flush())
        .map_err(|error| format!("无法写入 Azure DevOps Server runner 请求：{error}"))?;
    drop(stdin);

    let start = Instant::now();
    let status = loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("无法等待 Azure DevOps Server runner：{error}"))?
        {
            break status;
        }
        if start.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err(format!(
                "Azure DevOps Server 读取超时（{} 秒）",
                timeout.as_secs()
            ));
        }
        thread::sleep(Duration::from_millis(50));
    };

    let stdout = stdout_reader
        .join()
        .map_err(|_| "Azure DevOps Server stdout 读取线程异常".to_string())?
        .map_err(|error| error.to_string())?;
    let stderr = stderr_reader
        .join()
        .map_err(|_| "Azure DevOps Server stderr 读取线程异常".to_string())?
        .map_err(|error| error.to_string())?;

    if stdout.truncated {
        return Err("Azure DevOps Server 返回过大（超过 1 MiB）".to_string());
    }

    let stderr_text = sanitize_secret(
        String::from_utf8_lossy(&stderr.bytes).trim().to_string(),
        request.pat.as_deref(),
    );
    if !status.success() {
        if stderr_text.is_empty() {
            return Err(format!("Azure DevOps Server 读取失败：{status}"));
        }
        return Err(format!("Azure DevOps Server 读取失败：{stderr_text}"));
    }

    let stdout_text = String::from_utf8_lossy(&stdout.bytes).trim().to_string();
    if stdout_text.is_empty() {
        return Err("Azure DevOps Server runner 未返回 JSON".to_string());
    }
    let mut result = serde_json::from_str(stdout_text.trim_start_matches('\u{feff}'))
        .map_err(|error| format!("Azure DevOps Server runner 返回了无效 JSON：{error}"))?;
    if let Some(secret) = request.pat.as_deref().filter(|secret| !secret.is_empty()) {
        redact_json_secret(&mut result, secret);
    }
    Ok(result)
}

fn run_butler_azure_devops_server_read_with_program(
    program: PathBuf,
    adapter_path: PathBuf,
    request: ValidatedButlerAzureDevOpsServerReadRequest,
) -> Result<serde_json::Value, String> {
    run_butler_azure_devops_server_read_with_program_and_timeout(
        program,
        adapter_path,
        request,
        AZURE_DEVOPS_SERVER_TIMEOUT,
        false,
    )
}

fn run_butler_azure_devops_server_read(
    adapter_path: PathBuf,
    request: ValidatedButlerAzureDevOpsServerReadRequest,
) -> Result<serde_json::Value, String> {
    run_butler_azure_devops_server_read_with_program(resolve_pwsh_program()?, adapter_path, request)
}

fn standalone_azure_devops_server_adapter_path() -> Result<PathBuf, String> {
    let executable_dir = std::env::current_exe()
        .map_err(|error| format!("无法定位 RocketX 可执行文件：{error}"))?
        .parent()
        .map(PathBuf::from)
        .ok_or_else(|| "RocketX 可执行文件没有父目录".to_string())?;
    let mut roots = vec![
        executable_dir.join(BUTLER_BUNDLED_SKILLS_DIR),
        executable_dir
            .join("..")
            .join("Resources")
            .join(BUTLER_BUNDLED_SKILLS_DIR),
        executable_dir
            .join("..")
            .join("lib")
            .join("rocketx")
            .join(BUTLER_BUNDLED_SKILLS_DIR),
    ];
    if cfg!(debug_assertions) {
        roots.push(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("resources")
                .join(BUTLER_BUNDLED_SKILLS_DIR),
        );
    }
    for root in roots {
        let adapter = root.join(AZURE_DEVOPS_SERVER_HOST_ADAPTER);
        if adapter.is_file() {
            return contained_existing_path(&root, &adapter);
        }
    }
    Err("无法定位 RocketX 内置 Azure DevOps Server adapter".to_string())
}

fn run_business_azure_devops_server_read_with<RunSkill, RunWindowsAuth>(
    request: ValidatedButlerAzureDevOpsServerReadRequest,
    run_skill: RunSkill,
    run_windows_auth: RunWindowsAuth,
) -> Result<serde_json::Value, String>
where
    RunSkill: FnOnce(
        ValidatedButlerAzureDevOpsServerReadRequest,
        bool,
    ) -> Result<serde_json::Value, String>,
    RunWindowsAuth:
        FnOnce(&str, &str, Option<&str>, &str) -> Result<crate::winauth::HttpResponse, String>,
{
    if request.auth_mode != "default-credentials" {
        return run_skill(request, false);
    }

    let collection_url = request.collection_url.clone();
    let preview = run_skill(request, true)?;
    let requires_allow_write = preview
        .get("RequiresAllowWrite")
        .and_then(serde_json::Value::as_bool)
        .ok_or_else(|| "Azure DevOps Skill 预览缺少写入安全标记".to_string())?;
    if requires_allow_write {
        return Err("RocketX 业务 MCP 只允许执行 Azure DevOps 只读请求".to_string());
    }
    let method = preview
        .get("Method")
        .and_then(serde_json::Value::as_str)
        .filter(|value| matches!(*value, "GET" | "POST"))
        .ok_or_else(|| "Azure DevOps Skill 预览缺少有效 Method".to_string())?;
    let uri = preview
        .get("Uri")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "Azure DevOps Skill 预览缺少 Uri".to_string())?;
    let parsed =
        tauri::Url::parse(uri).map_err(|_| "Azure DevOps Skill 预览返回了无效 Uri".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.fragment().is_some()
    {
        return Err("Azure DevOps Skill 预览返回了无效 Uri".to_string());
    }
    let configured = tauri::Url::parse(&collection_url)
        .map_err(|_| "Azure DevOps collectionUrl 无效".to_string())?;
    let configured_path = configured.path().trim_end_matches('/');
    let preview_path = parsed.path();
    let within_collection = configured_path.is_empty()
        || preview_path == configured_path
        || preview_path
            .strip_prefix(configured_path)
            .is_some_and(|suffix| suffix.starts_with('/'));
    if parsed.scheme() != configured.scheme()
        || parsed.host_str() != configured.host_str()
        || parsed.port_or_known_default() != configured.port_or_known_default()
        || !within_collection
    {
        return Err("Azure DevOps Skill 预览越过了工作台已配置的 collection 边界".to_string());
    }
    let body = match preview.get("Body") {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::String(value)) => Some(value.as_str()),
        Some(_) => return Err("Azure DevOps Skill 预览返回了无效 Body".to_string()),
    };

    let response = run_windows_auth(uri, method, body, "application/json")
        .map_err(|error| format!("Azure DevOps Server 读取失败：{error}"))?;
    if response.body.len() > AZURE_DEVOPS_SERVER_STDOUT_LIMIT {
        return Err("Azure DevOps Server 返回过大（超过 1 MiB）".to_string());
    }
    if !(200..=299).contains(&response.status) {
        let detail = response.body.trim().chars().take(512).collect::<String>();
        let hint = match response.status {
            401 => "Windows 集成认证失败，请确认当前登录用户可访问该集合",
            403 => "当前 Windows 登录用户没有该路由的读取权限",
            404 => "该路由在当前 Azure DevOps Server 或 API 版本中不存在",
            _ => "请检查请求路由、服务状态与 API 版本",
        };
        return Err(if detail.is_empty() {
            format!("Azure DevOps Server 返回 HTTP {}：{hint}", response.status)
        } else {
            format!(
                "Azure DevOps Server 返回 HTTP {}：{hint}；响应：{detail}",
                response.status
            )
        });
    }

    let mut result = if response.body.trim().is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::from_str(&response.body)
            .map_err(|error| format!("Azure DevOps Server 返回了无效 JSON：{error}"))?
    };
    let source = serde_json::json!({ "url": uri });
    match &mut result {
        serde_json::Value::Object(value) => {
            value.insert("_rocketxSource".to_string(), source);
            Ok(result)
        }
        _ => Ok(serde_json::json!({
            "data": result,
            "_rocketxSource": source,
        })),
    }
}

pub(crate) fn business_azure_devops_server_read(
    request: ButlerAzureDevOpsServerReadRequest,
) -> Result<serde_json::Value, String> {
    let request = validate_butler_azure_devops_server_read_request(request)?;
    let program = resolve_pwsh_program()?;
    let adapter = standalone_azure_devops_server_adapter_path()?;
    run_business_azure_devops_server_read_with(
        request,
        move |request, dry_run| {
            run_butler_azure_devops_server_read_with_program_and_timeout(
                program,
                adapter,
                request,
                BUSINESS_MCP_AZURE_DEVOPS_SERVER_TIMEOUT,
                dry_run,
            )
        },
        crate::winauth::blocking_request,
    )
}

fn prepare_attachments_dir(app: &tauri::AppHandle, session_id: &str) -> Result<PathBuf, String> {
    let path = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("无法定位应用缓存目录：{error}"))?
        .join("agent-runtime")
        .join(session_id)
        .join("attachments");
    std::fs::create_dir_all(&path).map_err(|error| format!("无法准备 Agent 附件目录：{error}"))?;
    Ok(path)
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
                "codex-app-server-output",
                CodexOutputEvent {
                    process_id: process_id.clone(),
                    stream,
                    line,
                },
            );
        }
    });
}

fn monitor_child(
    app: tauri::AppHandle,
    state: Arc<Mutex<HashMap<String, ManagedCodex>>>,
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
                    let _ = std::fs::remove_dir_all(process.attachments_dir);
                }
                let _ = app.emit(
                    "codex-app-server-exit",
                    CodexExitEvent {
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

fn encode_message(message: serde_json::Value) -> Result<Vec<u8>, String> {
    if !message.is_object() {
        return Err("Codex app-server message must be a JSON object".to_string());
    }
    let mut bytes = serde_json::to_vec(&message)
        .map_err(|error| format!("failed to encode Codex message: {error}"))?;
    if bytes.len() > MAX_MESSAGE_BYTES {
        return Err("Codex app-server message exceeds 2 MiB".to_string());
    }
    bytes.push(b'\n');
    Ok(bytes)
}

struct StartedCodexProcess {
    info: CodexProcessInfo,
    process_id: String,
    child: Arc<Mutex<Child>>,
    stdout: ChildStdout,
    stderr: ChildStderr,
}

enum CodexAppServerStartResult {
    Existing(CodexProcessInfo),
    Started(StartedCodexProcess),
}

fn start_codex_app_server_blocking(
    app: tauri::AppHandle,
    processes: Arc<Mutex<HashMap<String, ManagedCodex>>>,
    next_id: Arc<AtomicU64>,
    session_id: String,
    workspace_root: String,
) -> Result<CodexAppServerStartResult, String> {
    validate_session_id(&session_id)?;
    let workspace_root = host_path(&codex_workspace_directory(&app, &workspace_root)?);
    let managed_skill_roots = bundled_codex_skill_roots(&app)?
        .into_iter()
        .map(|path| host_path(&path))
        .collect::<Vec<_>>();
    let resolved = resolve_codex(&app)?;
    let version = resolved.version.clone();
    let attachments_dir = prepare_attachments_dir(&app, &session_id)?;

    let mut processes = processes
        .lock()
        .map_err(|_| "Codex process registry is unavailable".to_string())?;
    if let Some(process) = processes
        .values()
        .find(|process| process.session_id == session_id)
    {
        return Ok(CodexAppServerStartResult::Existing(CodexProcessInfo {
            process_id: process.process_id.clone(),
            version: process.version.clone(),
            runtime_workspace_root: process.workspace_root.clone(),
            runtime_source: process.runtime_source,
            managed_skill_roots,
        }));
    }

    let launch_args = app_server_launch_args(&resolved)?;
    let mut command = resolved.command();
    command
        .args(&launch_args)
        .current_dir(&workspace_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("无法在所选本地目录启动 Codex app-server：{error}"))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Codex app-server stdin is unavailable".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Codex app-server stdout is unavailable".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Codex app-server stderr is unavailable".to_string())?;
    let process_id = format!(
        "codex-{}-{}",
        child.id(),
        next_id.fetch_add(1, Ordering::Relaxed)
    );
    let child = Arc::new(Mutex::new(child));
    let managed = ManagedCodex {
        process_id: process_id.clone(),
        session_id,
        child: Arc::clone(&child),
        stdin: Arc::new(Mutex::new(stdin)),
        attachments_dir,
        workspace_root: workspace_root.clone(),
        version: version.clone(),
        runtime_source: resolved.source,
    };
    processes.insert(process_id.clone(), managed);
    Ok(CodexAppServerStartResult::Started(StartedCodexProcess {
        info: CodexProcessInfo {
            process_id: process_id.clone(),
            version,
            runtime_workspace_root: workspace_root,
            runtime_source: resolved.source,
            managed_skill_roots,
        },
        process_id,
        child,
        stdout,
        stderr,
    }))
}

#[tauri::command]
pub async fn codex_app_server_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, CodexAppServerState>,
    session_id: String,
    workspace_root: String,
) -> Result<CodexProcessInfo, String> {
    let processes = Arc::clone(&state.processes);
    let next_id = Arc::clone(&state.next_id);
    let blocking_app = app.clone();
    let start_result = tauri::async_runtime::spawn_blocking(move || {
        start_codex_app_server_blocking(
            blocking_app,
            processes,
            next_id,
            session_id,
            workspace_root,
        )
    })
    .await
    .map_err(|error| format!("Codex app-server 启动任务失败：{error}"))??;
    match start_result {
        CodexAppServerStartResult::Existing(info) => Ok(info),
        CodexAppServerStartResult::Started(started) => {
            spawn_reader(
                app.clone(),
                started.process_id.clone(),
                "stdout",
                started.stdout,
            );
            spawn_reader(
                app.clone(),
                started.process_id.clone(),
                "stderr",
                started.stderr,
            );
            monitor_child(
                app,
                Arc::clone(&state.processes),
                started.process_id.clone(),
                started.child,
            );
            Ok(started.info)
        }
    }
}

#[tauri::command]
pub fn codex_artifact_read(
    app: tauri::AppHandle,
    workspace_root: String,
    path: String,
) -> Result<String, String> {
    let root = codex_workspace_directory(&app, &workspace_root)?;
    read_codex_artifact(&root, Path::new(path.trim()))
}

#[tauri::command]
pub fn codex_artifact_open(
    app: tauri::AppHandle,
    workspace_root: String,
    path: String,
) -> Result<(), String> {
    let root = codex_workspace_directory(&app, &workspace_root)?;
    let target = resolve_codex_artifact(&root, Path::new(path.trim()))?;
    app.opener()
        .open_path(host_path(&target), None::<&str>)
        .map_err(|error| format!("无法使用系统应用打开 Artifact：{error}"))
}

#[tauri::command]
pub fn codex_artifact_reveal(
    app: tauri::AppHandle,
    workspace_root: String,
    path: String,
) -> Result<(), String> {
    let root = codex_workspace_directory(&app, &workspace_root)?;
    let target = resolve_codex_artifact(&root, Path::new(path.trim()))?;
    app.opener()
        .reveal_item_in_dir(&target)
        .map_err(|error| format!("无法定位 Artifact：{error}"))
}

fn resolve_codex_artifact(root: &Path, target: &Path) -> Result<PathBuf, String> {
    if !target.is_absolute() {
        return Err("Artifact 路径必须是绝对路径".to_string());
    }
    let target = contained_existing_path(root, target)?;
    if !target.is_file() {
        return Err("Artifact 路径不是文件".to_string());
    }
    Ok(target)
}

fn read_codex_artifact(root: &Path, target: &Path) -> Result<String, String> {
    let target = resolve_codex_artifact(root, target)?;
    let metadata =
        std::fs::metadata(&target).map_err(|error| format!("无法读取 Artifact 元数据：{error}"))?;
    if metadata.len() > MAX_ARTIFACT_BYTES {
        return Err("Artifact 超过 12 MB，请使用系统应用打开".to_string());
    }
    let bytes = std::fs::read(&target).map_err(|error| format!("无法读取 Artifact：{error}"))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentAttachmentMetadata {
    session_id: String,
    relative_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAttachmentRuntimePath {
    path: String,
    root: String,
}

fn decode_attachment_request(bytes: &[u8]) -> Result<(AgentAttachmentMetadata, &[u8]), String> {
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

#[tauri::command]
pub fn codex_agent_attachment_write(
    state: tauri::State<'_, CodexAppServerState>,
    request: tauri::ipc::Request<'_>,
) -> Result<AgentAttachmentRuntimePath, String> {
    let raw = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes,
        _ => return Err("Agent attachment request must be binary".to_string()),
    };
    let (metadata, bytes) = decode_attachment_request(raw)?;
    validate_session_id(&metadata.session_id)?;
    if bytes.len() > MAX_ATTACHMENT_BYTES {
        return Err("Agent 单个附件不能超过 10 MB".to_string());
    }
    let relative = safe_attachment_path(&metadata.relative_path)?;
    let attachments_dir = {
        let processes = state
            .processes
            .lock()
            .map_err(|_| "Codex process registry is unavailable".to_string())?;
        processes
            .values()
            .find(|process| process.session_id == metadata.session_id)
            .map(|process| process.attachments_dir.clone())
            .ok_or_else(|| "Agent 会话未运行".to_string())?
    };
    let target = attachments_dir.join(&relative);
    let parent = target
        .parent()
        .ok_or_else(|| "invalid Agent attachment path".to_string())?;
    std::fs::create_dir_all(parent).map_err(|error| format!("无法准备 Agent 附件目录：{error}"))?;
    std::fs::write(&target, bytes).map_err(|error| format!("无法写入 Agent 附件：{error}"))?;
    Ok(AgentAttachmentRuntimePath {
        path: host_path(&target),
        root: host_path(&attachments_dir),
    })
}

#[tauri::command]
pub fn codex_app_server_write(
    state: tauri::State<'_, CodexAppServerState>,
    process_id: String,
    message: serde_json::Value,
) -> Result<(), String> {
    let bytes = encode_message(message)?;
    let stdin = {
        let processes = state
            .processes
            .lock()
            .map_err(|_| "Codex process registry is unavailable".to_string())?;
        let process = processes
            .get(&process_id)
            .ok_or_else(|| "Codex app-server process is not active".to_string())?;
        Arc::clone(&process.stdin)
    };
    let mut stdin = stdin
        .lock()
        .map_err(|_| "Codex app-server stdin is unavailable".to_string())?;
    stdin
        .write_all(&bytes)
        .and_then(|_| stdin.flush())
        .map_err(|error| format!("failed to write Codex app-server message: {error}"))
}

#[tauri::command]
pub fn codex_app_server_stop(
    state: tauri::State<'_, CodexAppServerState>,
    process_id: String,
) -> Result<(), String> {
    let process = state
        .processes
        .lock()
        .map_err(|_| "Codex process registry is unavailable".to_string())?
        .remove(&process_id)
        .ok_or_else(|| "Codex app-server process is not active".to_string())?;
    let mut child = process
        .child
        .lock()
        .map_err(|_| "Codex app-server process is unavailable".to_string())?;
    child
        .kill()
        .or_else(|error| match child.try_wait() {
            Ok(Some(_)) => Ok(()),
            _ => Err(error),
        })
        .map_err(|error| format!("failed to stop Codex app-server: {error}"))?;
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(&process.attachments_dir);
    Ok(())
}

#[tauri::command]
pub async fn butler_azure_devops_server_read(
    app: tauri::AppHandle,
    request: ButlerAzureDevOpsServerReadRequest,
) -> Result<serde_json::Value, String> {
    let request = validate_butler_azure_devops_server_read_request(request)?;
    let adapter_path = bundled_azure_devops_server_adapter_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        run_butler_azure_devops_server_read(adapter_path, request)
    })
    .await
    .map_err(|error| format!("Azure DevOps Server 任务失败：{error}"))?
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDirManifest {
    manifest: String,
    installer_path: Option<String>,
    signature: Option<String>,
    sha256: String,
    version: String,
    installer_type: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedHttpUpdateMetadata {
    rid: tauri::ResourceId,
    current_version: String,
    version: String,
    date: Option<String>,
    body: Option<String>,
    raw_json: serde_json::Value,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WindowsInstallerKind {
    Nsis,
    Msi,
}

impl WindowsInstallerKind {
    fn extension(self) -> &'static str {
        match self {
            Self::Nsis => "exe",
            Self::Msi => "msi",
        }
    }

    fn platform_key(self) -> &'static str {
        match self {
            Self::Nsis => "windows-x86_64",
            Self::Msi => "windows-x86_64-msi",
        }
    }

    fn alternate_platform_key(self) -> &'static str {
        match self {
            Self::Nsis => "windows-x86_64-msi",
            Self::Msi => "windows-x86_64",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Nsis => "NSIS",
            Self::Msi => "MSI",
        }
    }

    fn cli_value(self) -> &'static str {
        match self {
            Self::Nsis => "nsis",
            Self::Msi => "msi",
        }
    }

    fn from_cli(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "nsis" => Some(Self::Nsis),
            "msi" => Some(Self::Msi),
            _ => None,
        }
    }
}

fn installer_kind_from_bundle_type(
    bundle_type: Option<tauri::utils::config::BundleType>,
) -> Result<WindowsInstallerKind, String> {
    match bundle_type {
        Some(tauri::utils::config::BundleType::Nsis) => Ok(WindowsInstallerKind::Nsis),
        Some(tauri::utils::config::BundleType::Msi) => Ok(WindowsInstallerKind::Msi),
        Some(other) => Err(format!(
            "当前安装类型是 {other}，仅支持 NSIS / MSI 安装包自动更新"
        )),
        None => Err("无法判断当前安装类型（bundle_type 未知）；拒绝静默切换安装器".to_string()),
    }
}

fn detect_current_install_kind() -> Result<WindowsInstallerKind, String> {
    installer_kind_from_bundle_type(tauri::utils::platform::bundle_type())
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ResolvedUpdatePackage {
    package_path: PathBuf,
    signature: Option<String>,
    version: String,
    installer_kind: WindowsInstallerKind,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct UpdateHelperArgs {
    wait_pid: u32,
    base_dir: PathBuf,
    package_path: PathBuf,
    signature: Option<String>,
    sha256: String,
    target_version: String,
    relaunch_path: PathBuf,
    installer_kind: WindowsInstallerKind,
    lock_path: PathBuf,
    result_path: PathBuf,
}

struct PreparedInstaller {
    path: PathBuf,
    cleanup_dir: Option<PathBuf>,
}

struct UpdateFlowLock {
    path: PathBuf,
}

impl Drop for UpdateFlowLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UpdateResultStatus {
    Success,
    Error,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateResult {
    status: UpdateResultStatus,
    version: String,
    message: String,
}

fn decode_updater_text(value: &str, label: &str) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(value)
        .map_err(|error| format!("{label} Base64 无效：{error}"))?;
    String::from_utf8(bytes).map_err(|_| format!("{label} 不是 UTF-8 文本"))
}

fn verify_update_package(path: &Path, signature: &str) -> Result<(), String> {
    let public_key = PublicKey::decode(&decode_updater_text(UPDATER_PUBLIC_KEY, "更新公钥")?)
        .map_err(|error| format!("更新公钥无效：{error}"))?;
    let signature = Signature::decode(&decode_updater_text(signature, "更新签名")?)
        .map_err(|error| format!("更新签名无效：{error}"))?;
    let mut verifier = public_key
        .verify_stream(&signature)
        .map_err(|error| format!("无法创建更新验签器：{error}"))?;
    let mut file = std::fs::File::open(path)
        .map_err(|error| format!("读取更新包 {} 失败：{error}", path.display()))?;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| format!("读取更新包 {} 失败：{error}", path.display()))?;
        if count == 0 {
            break;
        }
        verifier.update(&buffer[..count]);
    }
    verifier
        .finalize()
        .map_err(|error| format!("更新包签名校验失败：{error}"))
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = std::fs::File::open(path)
        .map_err(|error| format!("读取更新包 {} 失败：{error}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| format!("读取更新包 {} 失败：{error}", path.display()))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn normalize_update_sha256(value: &str) -> Result<String, String> {
    let value = value.trim().to_ascii_lowercase();
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("更新包 SHA-256 无效".to_string());
    }
    Ok(value)
}

fn verify_update_package_identity(
    path: &Path,
    signature: Option<&str>,
    expected_sha256: &str,
) -> Result<(), String> {
    let expected_sha256 = normalize_update_sha256(expected_sha256)?;
    let actual_sha256 = sha256_file(path)?;
    if actual_sha256 != expected_sha256 {
        return Err("更新包 SHA-256 已变化，拒绝继续安装".to_string());
    }
    if let Some(signature) = signature {
        verify_update_package(path, signature)?;
    }
    Ok(())
}

fn normalize_update_version_text(version: &str) -> Option<String> {
    let value = version.trim().trim_start_matches(['v', 'V']);
    (!value.is_empty()).then(|| value.to_string())
}

fn resolve_update_package(
    base: &Path,
    manifest: &serde_json::Value,
) -> Result<ResolvedUpdatePackage, String> {
    let installer_kind = detect_current_install_kind()?;
    resolve_update_package_with_kind(base, manifest, installer_kind)
}

fn resolve_update_package_with_kind(
    base: &Path,
    manifest: &serde_json::Value,
    installer_kind: WindowsInstallerKind,
) -> Result<ResolvedUpdatePackage, String> {
    let version = manifest
        .get("version")
        .and_then(serde_json::Value::as_str)
        .and_then(normalize_update_version_text)
        .ok_or_else(|| "latest.json 缺少有效的 version".to_string())?;
    let platform = manifest
        .get("platforms")
        .ok_or_else(|| "latest.json 缺少 platforms".to_string())?;
    let preferred_key = installer_kind.platform_key();
    let Some(platform) = platform.get(preferred_key) else {
        if platform
            .get(installer_kind.alternate_platform_key())
            .is_some()
        {
            return Err(format!(
                "当前安装类型是 {}，但 latest.json 没有对应的 {} 安装包；拒绝静默切换安装类型",
                installer_kind.label(),
                installer_kind.label()
            ));
        }
        return Err(format!("latest.json 缺少 {preferred_key} 平台条目"));
    };
    let url = platform
        .get("url")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "Windows 更新条目缺少 url".to_string())?;
    let signature = platform
        .get("signature")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string);
    let file_name = url
        .rsplit(['/', '\\'])
        .next()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Windows 更新 URL 缺少文件名".to_string())?;
    let path = base.join(file_name);
    if !path.is_file() {
        return Err(format!("更新包不存在：{}", path.display()));
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if extension != "zip" && extension != installer_kind.extension() {
        return Err(format!(
            "{} 更新条目必须指向 .zip 或 .{} 文件，实际是 .{}",
            installer_kind.label(),
            installer_kind.extension(),
            extension
        ));
    }
    Ok(ResolvedUpdatePackage {
        package_path: path,
        signature,
        version,
        installer_kind,
    })
}

#[tauri::command]
pub async fn check_signed_http_update(
    webview: tauri::Webview,
    endpoint: String,
) -> Result<Option<SignedHttpUpdateMetadata>, String> {
    let url = tauri::Url::parse(endpoint.trim()).map_err(|_| "更新清单 URL 无效".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("更新清单必须是无凭据的 http/https URL".to_string());
    }
    let updater = webview
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|error| format!("更新源无效：{error}"))?
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|error| format!("无法创建更新检查器：{error}"))?;
    let Some(update) = updater
        .check()
        .await
        .map_err(|error| format!("检查更新失败：{error}"))?
    else {
        return Ok(None);
    };
    let metadata = SignedHttpUpdateMetadata {
        current_version: update.current_version.clone(),
        version: update.version.clone(),
        date: update.date.map(|value| value.to_string()),
        body: update.body.clone(),
        raw_json: update.raw_json.clone(),
        rid: webview.resources_table().add(update),
    };
    Ok(Some(metadata))
}

/// 共享目录更新源（issue #106）：webview 读不了 UNC/本地任意路径，
/// 由这里读 latest.json，并按清单里 Windows 平台条目的文件名在同目录
/// 找安装包。目录是用户自己在设置页填的更新源，只读不写。
#[tauri::command]
pub async fn read_update_manifest_dir(dir: String) -> Result<UpdateDirManifest, String> {
    let base = std::path::PathBuf::from(dir.trim());
    if !base.is_absolute() {
        return Err("更新目录必须是绝对路径（本地盘符或 \\\\server\\share 形式）".to_string());
    }
    let manifest_path = base.join("latest.json");
    let manifest = std::fs::read_to_string(&manifest_path)
        .map_err(|error| format!("读取 {} 失败：{error}", manifest_path.display()))?;

    let value = serde_json::from_str::<serde_json::Value>(&manifest)
        .map_err(|error| format!("latest.json 无效：{error}"))?;
    let resolved = resolve_update_package(&base, &value)?;
    let sha256 = sha256_file(&resolved.package_path)?;
    if let Some(signature) = resolved.signature.as_deref() {
        verify_update_package(&resolved.package_path, signature)?;
    }

    Ok(UpdateDirManifest {
        manifest,
        installer_path: Some(resolved.package_path.to_string_lossy().into_owned()),
        signature: resolved.signature,
        sha256,
        version: resolved.version,
        installer_type: resolved.installer_kind.cli_value().to_string(),
    })
}

fn normalize_unc_workspace_config_path(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() || trimmed.len() > 32_768 || trimmed.chars().any(char::is_control) {
        return Err("UNC 配置路径无效".to_string());
    }
    if !trimmed.starts_with(r"\\") || trimmed.starts_with(r"\\?\") || trimmed.starts_with(r"\\.\") {
        return Err("团队配置 UNC 路径必须是 \\\\server\\share\\... 形式".to_string());
    }
    if trimmed.contains('/') {
        return Err("团队配置 UNC 路径只能使用反斜杠".to_string());
    }
    let parts = trimmed
        .strip_prefix(r"\\")
        .unwrap_or_default()
        .split('\\')
        .collect::<Vec<_>>();
    if parts.len() < 3
        || parts.iter().any(|part| {
            part.is_empty()
                || *part == "."
                || *part == ".."
                || part.contains(':')
                || part.ends_with('.')
                || part.ends_with(' ')
        })
    {
        return Err("团队配置 UNC 路径不允许设备路径、盘符、空路径段或 . / .. 路径段".to_string());
    }
    let target = PathBuf::from(trimmed);
    if !target
        .extension()
        .and_then(OsStr::to_str)
        .is_some_and(|value| value.eq_ignore_ascii_case("json"))
    {
        return Err("团队配置 UNC 路径必须指向 .json 文件".to_string());
    }
    Ok(target)
}

fn read_unc_workspace_config_text(path: &str) -> Result<String, String> {
    let target = normalize_unc_workspace_config_path(path)?;
    let file =
        std::fs::File::open(&target).map_err(|error| format!("读取团队配置失败：{error}"))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("读取团队配置失败：{error}"))?;
    if !metadata.is_file() {
        return Err("团队配置 UNC 路径必须指向文件".to_string());
    }
    let mut bytes = Vec::with_capacity(8 * 1024);
    file.take(MAX_WORKSPACE_CONFIG_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("读取团队配置失败：{error}"))?;
    if bytes.len() as u64 > MAX_WORKSPACE_CONFIG_BYTES {
        return Err("团队配置文件不能超过 1 MiB".to_string());
    }
    String::from_utf8(bytes).map_err(|_| "团队配置文件必须是 UTF-8 文本".to_string())
}

#[tauri::command]
pub async fn read_workspace_config_unc(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || read_unc_workspace_config_text(&path))
        .await
        .map_err(|error| format!("团队配置读取任务失败：{error}"))?
}

fn matching_installer_paths(
    candidates: impl IntoIterator<Item = PathBuf>,
    installer_kind: WindowsInstallerKind,
) -> Result<PathBuf, String> {
    let all_installers = candidates
        .into_iter()
        .filter(|path| {
            path.is_file()
                && path
                    .extension()
                    .and_then(|value| value.to_str())
                    .map(|value| {
                        value.eq_ignore_ascii_case("exe") || value.eq_ignore_ascii_case("msi")
                    })
                    .unwrap_or(false)
        })
        .collect::<Vec<_>>();
    match all_installers.len() {
        1 => {
            let installer = all_installers.into_iter().next().unwrap();
            let extension = installer
                .extension()
                .and_then(|value| value.to_str())
                .map(str::to_ascii_lowercase)
                .unwrap_or_default();
            if extension == installer_kind.extension() {
                Ok(installer)
            } else {
                Err(format!(
                    "签名更新压缩包中的唯一安装器是 .{}，与当前 {} 类型不一致",
                    extension,
                    installer_kind.label()
                ))
            }
        }
        0 => Err("签名更新压缩包中没有安装器".to_string()),
        _ => Err("签名更新压缩包中发现多个安装器；请只保留一个正式安装器".to_string()),
    }
}

fn list_files_recursive(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in std::fs::read_dir(&directory)
            .map_err(|error| format!("读取更新临时目录失败：{error}"))?
        {
            let path = entry
                .map_err(|error| format!("读取更新临时目录失败：{error}"))?
                .path();
            if path.is_dir() {
                pending.push(path);
            } else {
                files.push(path);
            }
        }
    }
    Ok(files)
}

fn create_unique_temp_dir(label: &str) -> Result<PathBuf, String> {
    let dir = std::env::temp_dir().join(format!(
        "rocketx-{label}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    ));
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("创建临时目录 {} 失败：{error}", dir.display()))?;
    Ok(dir)
}

fn prepare_update_installer(
    package: &Path,
    installer_kind: WindowsInstallerKind,
) -> Result<PreparedInstaller, String> {
    let extension = package
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if extension == installer_kind.extension() {
        return Ok(PreparedInstaller {
            path: package.to_path_buf(),
            cleanup_dir: None,
        });
    }
    if extension == "exe" || extension == "msi" {
        return Err(format!(
            "当前安装类型需要 {}，但更新包实际提供的是 .{}",
            installer_kind.label(),
            extension
        ));
    }
    if extension != "zip" {
        return Err("更新包只支持 .zip / .exe / .msi".to_string());
    }
    let target_dir = create_unique_temp_dir("update-extract")?;
    let mut command = Command::new("powershell");
    command
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force",
        ])
        .arg(package)
        .arg(&target_dir);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let status = command
        .status()
        .map_err(|error| format!("无法启动更新解压程序：{error}"))?;
    if !status.success() {
        let _ = std::fs::remove_dir_all(&target_dir);
        return Err(format!("更新压缩包解压失败，退出码：{status}"));
    }
    match list_files_recursive(&target_dir)
        .and_then(|paths| matching_installer_paths(paths, installer_kind))
    {
        Ok(installer) => Ok(PreparedInstaller {
            path: installer,
            cleanup_dir: Some(target_dir),
        }),
        Err(error) => {
            let _ = std::fs::remove_dir_all(&target_dir);
            Err(error)
        }
    }
}

fn app_update_state_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法获取应用数据目录：{error}"))?
        .join("update-flow");
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("无法创建更新状态目录 {}：{error}", dir.display()))?;
    Ok(dir)
}

fn helper_lock_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app_update_state_dir(app)?.join("apply-update-helper.lock"))
}

fn update_result_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app_update_state_dir(app)?.join("update-result.json"))
}

fn parse_update_helper_args(args: &[String]) -> Result<UpdateHelperArgs, String> {
    let mut wait_pid = None;
    let mut base_dir = None;
    let mut package_path = None;
    let mut signature = None;
    let mut sha256 = None;
    let mut target_version = None;
    let mut relaunch_path = None;
    let mut installer_kind = None;
    let mut lock_path = None;
    let mut result_path = None;
    let mut index = 0;
    while index < args.len() {
        let key = args[index].as_str();
        let value = args
            .get(index + 1)
            .ok_or_else(|| format!("更新 helper 参数缺少 {key} 的值"))?;
        match key {
            "--wait-pid" => {
                wait_pid = Some(
                    value
                        .parse::<u32>()
                        .map_err(|_| "更新 helper 的 wait-pid 无效".to_string())?,
                )
            }
            "--base" => base_dir = Some(PathBuf::from(value)),
            "--package" => package_path = Some(PathBuf::from(value)),
            "--signature" => signature = Some(value.clone()),
            "--sha256" => sha256 = Some(value.clone()),
            "--target-version" => target_version = Some(value.clone()),
            "--relaunch" => relaunch_path = Some(PathBuf::from(value)),
            "--installer-kind" => installer_kind = WindowsInstallerKind::from_cli(value),
            "--helper-lock" => lock_path = Some(PathBuf::from(value)),
            "--result-path" => result_path = Some(PathBuf::from(value)),
            _ => return Err(format!("未知的更新 helper 参数：{key}")),
        }
        index += 2;
    }
    Ok(UpdateHelperArgs {
        wait_pid: wait_pid.ok_or_else(|| "更新 helper 缺少 wait-pid".to_string())?,
        base_dir: base_dir.ok_or_else(|| "更新 helper 缺少 base".to_string())?,
        package_path: package_path.ok_or_else(|| "更新 helper 缺少 package".to_string())?,
        signature,
        sha256: sha256.ok_or_else(|| "更新 helper 缺少 sha256".to_string())?,
        target_version: target_version
            .ok_or_else(|| "更新 helper 缺少 target-version".to_string())?,
        relaunch_path: relaunch_path.ok_or_else(|| "更新 helper 缺少 relaunch".to_string())?,
        installer_kind: installer_kind
            .ok_or_else(|| "更新 helper 缺少 installer-kind".to_string())?,
        lock_path: lock_path.ok_or_else(|| "更新 helper 缺少 helper-lock".to_string())?,
        result_path: result_path.ok_or_else(|| "更新 helper 缺少 result-path".to_string())?,
    })
}

fn acquire_update_flow_lock(path: &Path) -> Result<UpdateFlowLock, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("无法创建更新锁目录 {}：{error}", parent.display()))?;
    }
    loop {
        match std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(path)
        {
            Ok(mut file) => {
                file.write_all(std::process::id().to_string().as_bytes())
                    .map_err(|error| format!("无法写入更新锁文件：{error}"))?;
                return Ok(UpdateFlowLock {
                    path: path.to_path_buf(),
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let stale_pid = std::fs::read_to_string(path)
                    .ok()
                    .and_then(|value| value.trim().parse::<u32>().ok());
                if stale_pid.is_some_and(is_process_running) {
                    return Err("已有更新流程正在运行，请等待它完成".to_string());
                }
                std::fs::remove_file(path).map_err(|remove_error| {
                    format!(
                        "无法清理过期的更新锁文件 {}：{remove_error}",
                        path.display()
                    )
                })?;
            }
            Err(error) => {
                return Err(format!("无法创建更新锁文件 {}：{error}", path.display()));
            }
        }
    }
}

fn copy_update_helper_binary() -> Result<PathBuf, String> {
    let current_exe = std::env::current_exe()
        .map_err(|error| format!("无法定位当前 RocketX 可执行文件：{error}"))?;
    let helper_dir = create_unique_temp_dir("update-helper")?;
    let helper = helper_dir.join(
        current_exe
            .file_name()
            .ok_or_else(|| "当前 RocketX 可执行文件缺少文件名".to_string())?,
    );
    if let Err(error) = std::fs::copy(&current_exe, &helper) {
        let _ = std::fs::remove_dir_all(&helper_dir);
        return Err(format!(
            "无法复制更新 helper 到 {}：{error}",
            helper.display()
        ));
    }
    Ok(helper)
}

fn is_process_running(pid: u32) -> bool {
    let output = match Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$process = Get-Process -Id $args[0] -ErrorAction SilentlyContinue; if ($process) { 'running' }",
        ])
        .arg(pid.to_string())
        .output()
    {
        Ok(output) => output,
        Err(_) => return false,
    };
    String::from_utf8_lossy(&output.stdout).contains("running")
}

fn take_over_update_flow_lock(path: &Path) -> Result<UpdateFlowLock, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("无法创建更新锁目录 {}：{error}", parent.display()))?;
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(path)
        .map_err(|error| format!("无法接管更新锁文件 {}：{error}", path.display()))?;
    file.write_all(std::process::id().to_string().as_bytes())
        .map_err(|error| format!("无法写入更新锁文件：{error}"))?;
    Ok(UpdateFlowLock {
        path: path.to_path_buf(),
    })
}

fn wait_for_process_exit(pid: u32, timeout: Duration) -> Result<(), String> {
    let mut command = Command::new("powershell");
    command
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$process = Get-Process -Id $args[0] -ErrorAction SilentlyContinue; if ($process) { Wait-Process -Id $args[0] -Timeout $args[1] -ErrorAction Stop }",
        ])
        .arg(pid.to_string())
        .arg(timeout.as_secs().to_string());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let status = command
        .status()
        .map_err(|error| format!("无法等待 RocketX 主进程退出：{error}"))?;
    if status.success() {
        Ok(())
    } else if !is_process_running(pid) {
        Ok(())
    } else {
        Err(format!("等待 RocketX 主进程 {pid} 退出超时"))
    }
}

fn silent_install_invocation(
    installer: &Path,
    installer_kind: WindowsInstallerKind,
) -> (String, Vec<String>) {
    if installer_kind == WindowsInstallerKind::Msi {
        (
            "msiexec".to_string(),
            vec![
                "/i".to_string(),
                format!("\"{}\"", installer.to_string_lossy()),
                "/qn".to_string(),
                "/norestart".to_string(),
            ],
        )
    } else {
        (
            installer.to_string_lossy().into_owned(),
            vec!["/S".to_string(), "/UPDATE".to_string()],
        )
    }
}

fn installer_exit_code_is_success(installer_kind: WindowsInstallerKind, code: Option<i32>) -> bool {
    match installer_kind {
        WindowsInstallerKind::Nsis => code == Some(0),
        WindowsInstallerKind::Msi => matches!(code, Some(0 | 1641 | 3010)),
    }
}

fn run_silent_installer(
    installer: &Path,
    installer_kind: WindowsInstallerKind,
) -> Result<(), String> {
    let (program, args) = silent_install_invocation(installer, installer_kind);
    let mut command = Command::new("powershell");
    command
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$process = Start-Process -FilePath $args[0] -ArgumentList $args[1..($args.Length-1)] -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $process.ExitCode",
        ])
        .arg(program)
        .args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let status = command
        .status()
        .map_err(|error| format!("无法启动安装包：{error}"))?;
    let code = status.code();
    if installer_exit_code_is_success(installer_kind, code) {
        Ok(())
    } else {
        Err(format!(
            "{} 安装器退出码异常：{}",
            installer_kind.label(),
            code.unwrap_or_default()
        ))
    }
}

fn normalize_update_version(version: &str) -> Option<(u64, u64, u64)> {
    normalize_update_version_text(version).and_then(|value| parse_semantic_version(&value))
}

fn query_cli_version(path: &Path) -> Result<Option<String>, String> {
    let output = Command::new(path)
        .arg("--rocketx-version")
        .output()
        .map_err(|error| format!("无法读取安装后版本：{error}"))?;
    if !output.status.success() {
        return Ok(None);
    }
    let version = String::from_utf8_lossy(&output.stdout);
    Ok(normalize_update_version_text(&version))
}

fn wait_for_installed_version(path: &Path, target_version: &str) -> Result<(), String> {
    let expected = normalize_update_version(target_version)
        .ok_or_else(|| format!("目标版本号无效：{target_version}"))?;
    let deadline = Instant::now() + Duration::from_secs(60);
    while Instant::now() < deadline {
        if let Some(actual) =
            query_cli_version(path)?.and_then(|value| normalize_update_version(&value))
        {
            if actual == expected {
                return Ok(());
            }
        }
        thread::sleep(Duration::from_millis(500));
    }
    Err(format!(
        "安装完成后仍未观察到 {} 升级到 {}",
        path.display(),
        target_version
    ))
}

fn validate_manifest_package(
    base_dir: &Path,
    package_path: &Path,
    signature: Option<&str>,
    sha256: &str,
    expected_version: &str,
    installer_kind: WindowsInstallerKind,
) -> Result<ResolvedUpdatePackage, String> {
    let base =
        std::fs::canonicalize(base_dir).map_err(|error| format!("更新目录不可访问：{error}"))?;
    let package =
        std::fs::canonicalize(package_path).map_err(|error| format!("更新包不可访问：{error}"))?;
    if !package.starts_with(&base) {
        return Err("更新包不在配置的共享目录中".to_string());
    }
    let manifest_path = base.join("latest.json");
    let manifest = std::fs::read_to_string(&manifest_path)
        .map_err(|error| format!("读取 {} 失败：{error}", manifest_path.display()))?;
    let value = serde_json::from_str::<serde_json::Value>(&manifest)
        .map_err(|error| format!("latest.json 无效：{error}"))?;
    let resolved = resolve_update_package_with_kind(&base, &value, installer_kind)?;
    let resolved_package = std::fs::canonicalize(&resolved.package_path)
        .map_err(|error| format!("更新包不可访问：{error}"))?;
    if resolved_package != package {
        return Err("latest.json 指向的更新包已变化，拒绝继续安装".to_string());
    }
    if resolved.signature.as_deref() != signature {
        return Err("latest.json 中的更新签名已变化，拒绝继续安装".to_string());
    }
    let expected_version = normalize_update_version_text(expected_version)
        .ok_or_else(|| format!("目标版本号无效：{expected_version}"))?;
    if resolved.version != expected_version {
        return Err("latest.json 中的更新版本已变化，拒绝继续安装".to_string());
    }
    verify_update_package_identity(&resolved_package, resolved.signature.as_deref(), sha256)?;
    Ok(ResolvedUpdatePackage {
        package_path: resolved_package,
        ..resolved
    })
}

fn atomic_write_update_result(path: &Path, result: &UpdateResult) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("无法创建更新结果目录 {}：{error}", parent.display()))?;
    }
    let temp_path = path.with_extension(format!(
        "tmp-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    ));
    let content =
        serde_json::to_vec(result).map_err(|error| format!("无法序列化更新结果：{error}"))?;
    std::fs::write(&temp_path, content).map_err(|error| format!("无法写入更新结果：{error}"))?;
    if path.exists() {
        std::fs::remove_file(path).map_err(|error| format!("无法替换旧更新结果：{error}"))?;
    }
    std::fs::rename(&temp_path, path).map_err(|error| format!("无法提交更新结果：{error}"))
}

fn restart_rocketx(path: &Path) -> Result<(), String> {
    Command::new(path)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("无法重新启动 RocketX：{error}"))
}

fn stage_update_package(
    package: &Path,
    signature: Option<&str>,
    sha256: &str,
) -> Result<(PathBuf, PathBuf), String> {
    let staging_dir = create_unique_temp_dir("update-stage")?;
    let staged_package = staging_dir.join(
        package
            .file_name()
            .ok_or_else(|| "更新包路径缺少文件名".to_string())?,
    );
    let result = std::fs::copy(package, &staged_package)
        .map_err(|error| {
            format!(
                "无法复制更新包到本地暂存目录 {}：{error}",
                staged_package.display()
            )
        })
        .and_then(|_| verify_update_package_identity(&staged_package, signature, sha256));
    match result {
        Ok(()) => Ok((staged_package, staging_dir)),
        Err(error) => {
            let _ = std::fs::remove_dir_all(&staging_dir);
            Err(error)
        }
    }
}

fn run_update_helper_inner(args: &UpdateHelperArgs) -> Result<(), String> {
    wait_for_process_exit(args.wait_pid, Duration::from_secs(60))?;
    let resolved = validate_manifest_package(
        &args.base_dir,
        &args.package_path,
        args.signature.as_deref(),
        &args.sha256,
        &args.target_version,
        args.installer_kind,
    )?;
    let (staged_package, staging_dir) = stage_update_package(
        &resolved.package_path,
        resolved.signature.as_deref(),
        &args.sha256,
    )?;
    let install_result =
        prepare_update_installer(&staged_package, args.installer_kind).and_then(|prepared| {
            let result = run_silent_installer(&prepared.path, args.installer_kind);
            if let Some(cleanup_dir) = prepared.cleanup_dir.as_ref() {
                let _ = std::fs::remove_dir_all(cleanup_dir);
            }
            result
        });
    let _ = std::fs::remove_dir_all(&staging_dir);
    install_result?;
    wait_for_installed_version(&args.relaunch_path, &args.target_version)
}

fn run_update_helper(args: UpdateHelperArgs) -> Result<(), String> {
    let _lock = take_over_update_flow_lock(&args.lock_path)?;
    let mut result = match run_update_helper_inner(&args) {
        Ok(()) => UpdateResult {
            status: UpdateResultStatus::Success,
            version: args.target_version.clone(),
            message: format!("已完成 RocketX {} 更新", args.target_version),
        },
        Err(error) => UpdateResult {
            status: UpdateResultStatus::Error,
            version: args.target_version.clone(),
            message: error,
        },
    };
    let mut errors = Vec::new();
    if let Err(error) = atomic_write_update_result(&args.result_path, &result) {
        errors.push(error);
    }
    if let Err(error) = restart_rocketx(&args.relaunch_path) {
        if result.status == UpdateResultStatus::Success {
            result = UpdateResult {
                status: UpdateResultStatus::Error,
                version: args.target_version.clone(),
                message: error.clone(),
            };
            if let Err(rewrite_error) = atomic_write_update_result(&args.result_path, &result) {
                errors.push(rewrite_error);
            }
        }
        errors.push(error);
    }
    if result.status == UpdateResultStatus::Error {
        errors.insert(0, result.message.clone());
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("；"))
    }
}

pub fn maybe_run_update_helper(args: &[String]) -> Result<bool, String> {
    let Some(flag_index) = args
        .iter()
        .position(|argument| argument == "--apply-update-helper")
    else {
        return Ok(false);
    };
    let helper_args = parse_update_helper_args(&args[(flag_index + 1)..])?;
    run_update_helper(helper_args)?;
    Ok(true)
}

fn spawn_update_helper(
    helper: &Path,
    base: &Path,
    package: &Path,
    signature: Option<&str>,
    sha256: &str,
    target_version: &str,
    installer_kind: WindowsInstallerKind,
    lock_path: &Path,
    result_path: &Path,
) -> Result<(), String> {
    let current_exe = std::env::current_exe()
        .map_err(|error| format!("无法定位当前 RocketX 可执行文件：{error}"))?;
    let mut command = Command::new(&helper);
    command
        .arg("--apply-update-helper")
        .args(["--wait-pid", &std::process::id().to_string()])
        .args(["--base", &base.to_string_lossy()])
        .args(["--package", &package.to_string_lossy()])
        .args(["--sha256", sha256])
        .args(["--target-version", target_version])
        .args(["--relaunch", &current_exe.to_string_lossy()])
        .args(["--installer-kind", installer_kind.cli_value()])
        .args(["--helper-lock", &lock_path.to_string_lossy()])
        .args(["--result-path", &result_path.to_string_lossy()]);
    if let Some(signature) = signature {
        command.args(["--signature", signature]);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("无法启动更新 helper：{error}"))
}

/// 只启动配置目录里已探测的更新包；签名可选，SHA-256 固定本次探测内容。
#[tauri::command]
pub async fn launch_update_installer(
    app: tauri::AppHandle,
    dir: String,
    path: String,
    signature: Option<String>,
    sha256: String,
    expected_version: String,
    installer_type: String,
) -> Result<(), String> {
    let installer_kind = WindowsInstallerKind::from_cli(&installer_type)
        .ok_or_else(|| format!("未知的 installerType：{installer_type}"))?;
    let current_kind = detect_current_install_kind()?;
    if installer_kind != current_kind {
        return Err("前端传入的 installerType 与当前安装类型不一致".to_string());
    }
    let base = std::fs::canonicalize(PathBuf::from(dir.trim()))
        .map_err(|error| format!("更新目录不可访问：{error}"))?;
    let resolved = validate_manifest_package(
        &base,
        Path::new(path.trim()),
        signature.as_deref(),
        &sha256,
        &expected_version,
        installer_kind,
    )?;
    let lock_path = helper_lock_path(&app)?;
    let result_path = update_result_path(&app)?;
    let lock = acquire_update_flow_lock(&lock_path)?;
    let _ = std::fs::remove_file(&result_path);
    let helper = copy_update_helper_binary()?;
    let spawn_result = spawn_update_helper(
        &helper,
        &base,
        &resolved.package_path,
        resolved.signature.as_deref(),
        &sha256,
        &resolved.version,
        installer_kind,
        &lock_path,
        &result_path,
    );
    if spawn_result.is_ok() {
        std::mem::forget(lock);
    }
    spawn_result?;
    app.exit(0);
    Ok(())
}

#[tauri::command]
pub async fn take_update_result(app: tauri::AppHandle) -> Result<Option<UpdateResult>, String> {
    let path = update_result_path(&app)?;
    if !path.is_file() {
        return Ok(None);
    }
    let content = std::fs::read(&path).map_err(|error| format!("读取更新结果失败：{error}"))?;
    let result = serde_json::from_slice::<UpdateResult>(&content)
        .map_err(|error| format!("更新结果 JSON 无效：{error}"));
    std::fs::remove_file(&path).map_err(|error| format!("删除更新结果失败：{error}"))?;
    result.map(Some)
}

pub fn maybe_print_version(args: &[String]) -> bool {
    if !args.iter().any(|argument| argument == "--rocketx-version") {
        return false;
    }
    println!("{}", env!("CARGO_PKG_VERSION"));
    true
}

pub fn shutdown(app: &tauri::AppHandle) {
    let state = app.state::<CodexAppServerState>();
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
        if let Ok(mut child) = process.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[cfg(test)]
mod tests {
    #[cfg(windows)]
    use super::ResolvedCodex;
    use super::{
        app_server_args_for_help, classify_codex_version, codex_runtime_probe_from_candidates_with,
        decode_attachment_request, encode_message, host_path, installer_exit_code_is_success,
        installer_kind_from_bundle_type, matching_installer_paths,
        normalize_unc_workspace_config_path, normalize_update_version,
        normalize_update_version_text, parse_codex_cli_version, parse_semantic_version,
        parse_update_helper_args, probe_resolve_codex_from_candidates_with_probe,
        read_codex_artifact, redact_json_secret, resolve_codex_from_candidates_with_probe,
        resolve_update_package_with_kind, run_business_azure_devops_server_read_with,
        run_butler_azure_devops_server_read, safe_attachment_path, sha256_file,
        silent_install_invocation, standalone_azure_devops_server_adapter_path,
        validate_butler_azure_devops_server_read_request, validate_session_id,
        verify_update_package, verify_update_package_identity, ButlerAzureDevOpsServerReadRequest,
        CodexCompatibilityStatus, CodexProcessInfo, CodexRuntimeCandidate,
        CodexRuntimeCandidateOutcome, CodexRuntimeProbe, CodexRuntimeReasonCode,
        CodexRuntimeSource, UpdateResult, UpdateResultStatus, WindowsInstallerKind,
        AZURE_DEVOPS_SERVER_BODY_LIMIT, AZURE_DEVOPS_SERVER_HOST_ADAPTER, CODEX_MINIMUM_CANDIDATE,
        CODEX_PROTOCOL_BASELINE, CODEX_VERIFIED_VERSIONS, UPDATER_PUBLIC_KEY,
    };
    #[cfg(windows)]
    use super::{
        first_existing_program, resolve_pwsh_program,
        run_butler_azure_devops_server_read_with_program,
    };
    use base64::Engine as _;
    use serde_json::json;
    use std::ffi::OsStr;
    #[cfg(windows)]
    use std::ffi::OsString;
    use std::{
        fs,
        path::{Path, PathBuf},
        process::Command,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn unique_temp_dir(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "rocketx-proc-tests-{label}-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ))
    }

    #[test]
    fn app_server_transport_accepts_one_json_object_per_line() {
        assert_eq!(
            encode_message(json!({"method": "initialized"})).unwrap(),
            b"{\"method\":\"initialized\"}\n"
        );
        assert!(encode_message(json!(["not", "an", "object"])).is_err());
        assert!(encode_message(json!({"value": "x".repeat(2 * 1024 * 1024)})).is_err());
    }

    #[test]
    fn session_ids_are_safe_for_runtime_directories() {
        assert!(validate_session_id("session-019f6d30-797a-7f63").is_ok());
        assert!(validate_session_id("../escape").is_err());
        assert!(validate_session_id("with space").is_err());
    }

    #[test]
    fn artifact_reader_reads_only_files_inside_the_selected_workspace() {
        let root = unique_temp_dir("artifact-root");
        let outside = unique_temp_dir("artifact-outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let inside_file = root.join("wbs.html");
        let outside_file = outside.join("secret.txt");
        fs::write(&inside_file, b"<h1>WBS</h1>").unwrap();
        fs::write(&outside_file, b"outside").unwrap();

        assert_eq!(
            read_codex_artifact(&root, &inside_file).unwrap(),
            base64::engine::general_purpose::STANDARD.encode(b"<h1>WBS</h1>")
        );
        assert!(read_codex_artifact(&root, &outside_file)
            .unwrap_err()
            .contains("资源路径越界"));

        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(outside);
    }

    #[test]
    fn attachment_paths_stay_relative_and_reject_sensitive_files() {
        assert!(safe_attachment_path("message/1-build.log").is_ok());
        assert!(safe_attachment_path("../escape.txt").is_err());
        assert!(safe_attachment_path("message/.env").is_err());
        assert!(safe_attachment_path("message/credentials.json").is_err());
        assert!(safe_attachment_path("message/private.pem").is_err());
    }

    #[test]
    fn attachment_request_keeps_metadata_separate_from_raw_bytes() {
        let metadata = br#"{"sessionId":"session-1","relativePath":"message/build.log"}"#;
        let mut request = (metadata.len() as u32).to_le_bytes().to_vec();
        request.extend_from_slice(metadata);
        request.extend_from_slice(&[0, 1, 2, 255]);
        let (decoded, bytes) = decode_attachment_request(&request).unwrap();
        assert_eq!(decoded.session_id, "session-1");
        assert_eq!(decoded.relative_path, "message/build.log");
        assert_eq!(bytes, &[0, 1, 2, 255]);
        assert!(decode_attachment_request(&[0, 0, 0, 0]).is_err());
    }

    #[test]
    fn workspace_config_unc_path_only_accepts_shared_json_files() {
        assert!(
            normalize_unc_workspace_config_path(r"\\server\share\team\rcx.workspace.json").is_ok()
        );
        assert!(
            normalize_unc_workspace_config_path(r"\\server\share\team\rcx.workspace.JSON").is_ok()
        );
        assert!(normalize_unc_workspace_config_path(r"D:\team\rcx.workspace.json").is_err());
        assert!(normalize_unc_workspace_config_path(r"..\rcx.workspace.json").is_err());
        assert!(normalize_unc_workspace_config_path(r"\\.\D:\team\rcx.workspace.json").is_err());
        assert!(
            normalize_unc_workspace_config_path(r"\\?\UNC\server\share\rcx.workspace.json")
                .is_err()
        );
        assert!(
            normalize_unc_workspace_config_path(r"\\server\share\..\rcx.workspace.json").is_err()
        );
        assert!(normalize_unc_workspace_config_path(r"\\server/share/rcx.workspace.json").is_err());
        assert!(normalize_unc_workspace_config_path(r"\\server\share").is_err());
        assert!(
            normalize_unc_workspace_config_path(r"\\server\share\team\rcx.workspace.txt").is_err()
        );
    }

    #[test]
    fn shared_directory_update_accepts_unsigned_packages_for_explicit_local_trust() {
        let root = unique_temp_dir("unsigned-update");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("RocketX-update.zip"), b"zip").unwrap();
        let manifest = json!({
            "version": "0.40.2",
            "platforms": {
                "windows-x86_64": {
                    "url": "RocketX-update.zip"
                }
            }
        });
        let resolved =
            resolve_update_package_with_kind(&root, &manifest, WindowsInstallerKind::Nsis).unwrap();
        assert_eq!(resolved.signature, None);
        assert!(resolved.package_path.ends_with("RocketX-update.zip"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn shared_directory_update_rejects_package_changed_after_probe() {
        let root = unique_temp_dir("changed-update");
        fs::create_dir_all(&root).unwrap();
        let package = root.join("RocketX-update.exe");
        fs::write(&package, b"original installer").unwrap();
        let sha256 = sha256_file(&package).unwrap();

        verify_update_package_identity(&package, None, &sha256).unwrap();
        fs::write(&package, b"replaced installer").unwrap();
        let error = verify_update_package_identity(&package, None, &sha256).unwrap_err();

        assert!(error.contains("SHA-256 已变化"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn shared_directory_update_prefers_matching_installer_type() {
        let root = unique_temp_dir("matching-installer");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("RocketX_0.40.2_x64-setup.exe"), b"exe").unwrap();
        fs::write(root.join("RocketX_0.40.2_x64.msi"), b"msi").unwrap();
        let manifest = json!({
            "version": "v0.40.2",
            "platforms": {
                "windows-x86_64": {
                    "url": "RocketX_0.40.2_x64-setup.exe",
                    "signature": "sig-a"
                },
                "windows-x86_64-msi": {
                    "url": "RocketX_0.40.2_x64.msi",
                    "signature": "sig-b"
                }
            }
        });
        let nsis =
            resolve_update_package_with_kind(&root, &manifest, WindowsInstallerKind::Nsis).unwrap();
        assert!(nsis.package_path.ends_with("RocketX_0.40.2_x64-setup.exe"));
        assert_eq!(nsis.signature.as_deref(), Some("sig-a"));
        assert_eq!(nsis.version, "0.40.2");
        let msi =
            resolve_update_package_with_kind(&root, &manifest, WindowsInstallerKind::Msi).unwrap();
        assert!(msi.package_path.ends_with("RocketX_0.40.2_x64.msi"));
        assert_eq!(msi.signature.as_deref(), Some("sig-b"));
        assert_eq!(msi.installer_kind, WindowsInstallerKind::Msi);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn shared_directory_update_refuses_silent_installer_switch() {
        let root = unique_temp_dir("silent-switch");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("RocketX_0.40.2_x64.msi"), b"msi").unwrap();
        let manifest = json!({
            "version": "0.40.2",
            "platforms": {
                "windows-x86_64-msi": {
                    "url": "RocketX_0.40.2_x64.msi",
                    "signature": "sig-b"
                }
            }
        });
        let error = resolve_update_package_with_kind(&root, &manifest, WindowsInstallerKind::Nsis)
            .unwrap_err();
        assert!(error.contains("拒绝静默切换安装类型"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn bundle_type_only_accepts_nsis_and_msi() {
        assert_eq!(
            installer_kind_from_bundle_type(Some(tauri::utils::config::BundleType::Nsis)).unwrap(),
            WindowsInstallerKind::Nsis
        );
        assert_eq!(
            installer_kind_from_bundle_type(Some(tauri::utils::config::BundleType::Msi)).unwrap(),
            WindowsInstallerKind::Msi
        );
        assert!(installer_kind_from_bundle_type(None).is_err());
        assert!(
            installer_kind_from_bundle_type(Some(tauri::utils::config::BundleType::AppImage))
                .unwrap_err()
                .contains("仅支持 NSIS / MSI")
        );
    }

    #[test]
    fn zip_installer_selection_requires_exactly_one_installer_total() {
        let root = unique_temp_dir("zip-installer-selection");
        fs::create_dir_all(&root).unwrap();
        let exe = root.join("RocketX Setup.exe");
        let msi = root.join("RocketX.msi");
        fs::write(&exe, b"exe").unwrap();
        fs::write(&msi, b"msi").unwrap();

        assert!(
            matching_installer_paths(Vec::<PathBuf>::new(), WindowsInstallerKind::Nsis)
                .unwrap_err()
                .contains("没有安装器")
        );
        assert_eq!(
            matching_installer_paths(vec![exe.clone()], WindowsInstallerKind::Nsis).unwrap(),
            exe
        );
        assert!(matching_installer_paths(
            vec![exe.clone(), msi.clone()],
            WindowsInstallerKind::Nsis
        )
        .unwrap_err()
        .contains("多个安装器"));
        assert!(
            matching_installer_paths(vec![exe.clone()], WindowsInstallerKind::Msi)
                .unwrap_err()
                .contains("类型不一致")
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn silent_install_invocation_matches_windows_contract() {
        let nsis = silent_install_invocation(
            Path::new(r"C:\RocketX\RocketX Setup.exe"),
            WindowsInstallerKind::Nsis,
        );
        assert_eq!(nsis.0, r"C:\RocketX\RocketX Setup.exe");
        assert_eq!(nsis.1, vec!["/S", "/UPDATE"]);

        let msi = silent_install_invocation(
            Path::new(r"C:\RocketX\RocketX.msi"),
            WindowsInstallerKind::Msi,
        );
        assert_eq!(msi.0, "msiexec");
        assert_eq!(
            msi.1,
            vec!["/i", "\"C:\\RocketX\\RocketX.msi\"", "/qn", "/norestart"]
        );
    }

    #[test]
    fn installer_exit_codes_follow_nsis_and_msi_rules() {
        assert!(installer_exit_code_is_success(
            WindowsInstallerKind::Nsis,
            Some(0)
        ));
        assert!(!installer_exit_code_is_success(
            WindowsInstallerKind::Nsis,
            Some(3010)
        ));
        assert!(installer_exit_code_is_success(
            WindowsInstallerKind::Msi,
            Some(1641)
        ));
        assert!(installer_exit_code_is_success(
            WindowsInstallerKind::Msi,
            Some(3010)
        ));
        assert!(!installer_exit_code_is_success(
            WindowsInstallerKind::Msi,
            Some(5)
        ));
    }

    #[test]
    fn version_normalization_and_update_result_contract_are_stable() {
        assert_eq!(
            normalize_update_version_text(" v0.40.2 ").as_deref(),
            Some("0.40.2")
        );
        assert_eq!(normalize_update_version("V0.40.2"), Some((0, 40, 2)));
        assert_eq!(normalize_update_version(""), None);

        let result = serde_json::to_value(UpdateResult {
            status: UpdateResultStatus::Error,
            version: "0.40.2".to_string(),
            message: "安装失败".to_string(),
        })
        .unwrap();
        assert_eq!(result["status"], "error");
        assert_eq!(result["version"], "0.40.2");
        assert_eq!(result["message"], "安装失败");
    }

    #[test]
    fn update_helper_args_require_everything_needed_for_takeover() {
        let parsed = parse_update_helper_args(&[
            "--wait-pid".to_string(),
            "42".to_string(),
            "--base".to_string(),
            r"\\server\share\rocketx".to_string(),
            "--package".to_string(),
            r"\\server\share\rocketx\RocketX_0.40.2_x64-setup.exe".to_string(),
            "--signature".to_string(),
            "sig".to_string(),
            "--sha256".to_string(),
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".to_string(),
            "--target-version".to_string(),
            "0.40.2".to_string(),
            "--relaunch".to_string(),
            r"C:\Program Files\RocketX\RocketX.exe".to_string(),
            "--installer-kind".to_string(),
            "nsis".to_string(),
            "--helper-lock".to_string(),
            r"C:\Temp\rocketx-update-helper.lock".to_string(),
            "--result-path".to_string(),
            r"C:\Temp\update-result.json".to_string(),
        ])
        .unwrap();
        assert_eq!(parsed.wait_pid, 42);
        assert_eq!(parsed.installer_kind, WindowsInstallerKind::Nsis);
        assert_eq!(parsed.target_version, "0.40.2");
        assert_eq!(parsed.signature.as_deref(), Some("sig"));
        assert_eq!(parsed.sha256.len(), 64);
        assert_eq!(
            parsed.result_path,
            PathBuf::from(r"C:\Temp\update-result.json")
        );
    }

    #[test]
    fn shared_directory_update_rejects_malformed_signatures_before_reading_the_package() {
        let error =
            verify_update_package(Path::new("missing-package.zip"), "not-base64").unwrap_err();
        assert!(error.contains("更新签名 Base64 无效"));
    }

    #[test]
    fn shared_directory_verifier_uses_the_tauri_updater_public_key() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(
            config["plugins"]["updater"]["pubkey"].as_str(),
            Some(UPDATER_PUBLIC_KEY)
        );
    }

    #[test]
    fn codex_version_parsing_accepts_official_and_wrapped_outputs() {
        assert_eq!(
            parse_codex_cli_version("codex-cli 0.144.4\n", false).as_deref(),
            Some("0.144.4")
        );
        assert_eq!(
            parse_codex_cli_version("codex v0.150.2", false).as_deref(),
            Some("0.150.2")
        );
        assert_eq!(
            parse_codex_cli_version("npm warn deprecated something\ncodex-cli 0.144.4", false)
                .as_deref(),
            Some("0.144.4")
        );
        assert_eq!(
            parse_codex_cli_version("0.144.4", false).as_deref(),
            Some("0.144.4")
        );
        assert_eq!(parse_codex_cli_version("", false), None);
        assert_eq!(
            parse_codex_cli_version("usage: codex [options]", false),
            None
        );
    }

    #[test]
    fn codex_version_parsing_in_strict_mode_only_trusts_codex_lines() {
        assert_eq!(
            parse_codex_cli_version("codex-cli 0.144.4", true).as_deref(),
            Some("0.144.4")
        );
        assert_eq!(
            parse_codex_cli_version("Node.js v22.17.0 is required", true),
            None
        );
        assert_eq!(
            parse_codex_cli_version("Node.js v22.17.0 is required", false).as_deref(),
            Some("22.17.0")
        );
    }

    #[test]
    fn app_server_stdio_flag_follows_cli_help() {
        assert_eq!(
            app_server_args_for_help(
                "Usage: codex app-server [OPTIONS]\n      --stdio  Serve over stdio"
            ),
            vec!["app-server", "--stdio"],
        );
        // 新版 CLI 移除了 --stdio（stdio 已是默认），传了会以退出码 2 拒绝
        assert_eq!(
            app_server_args_for_help("Usage: codex app-server [OPTIONS]\n      --listen <ADDR>"),
            vec!["app-server"],
        );
    }

    #[test]
    fn host_paths_do_not_keep_windows_extended_prefixes() {
        let value = host_path(Path::new(r"\\?\C:\work\repo"));
        #[cfg(windows)]
        assert_eq!(value, r"C:\work\repo");
        #[cfg(not(windows))]
        assert_eq!(value, r"\\?\C:\work\repo");
    }

    #[test]
    fn azure_devops_read_contract_accepts_skill_read_posts_and_rejects_write_methods() {
        let valid = ButlerAzureDevOpsServerReadRequest {
            method: Some("GET".to_string()),
            collection_url: "https://ado.example.test/DefaultCollection".to_string(),
            auth_mode: Some("default-credentials".to_string()),
            pat: None,
            area: Some("git".to_string()),
            resource: "repositories".to_string(),
            project: Some("RocketX".to_string()),
            team: None,
            query: Some(serde_json::Map::from_iter([
                ("includeHidden".to_string(), json!(true)),
                ("ids".to_string(), json!(["1", "2"])),
            ])),
            body: None,
            api_version: Some("7.1-preview.1".to_string()),
            server_version_hint: Some("2022".to_string()),
            allow_conditional_area: false,
        };
        assert!(validate_butler_azure_devops_server_read_request(valid).is_ok());

        let wiql: ButlerAzureDevOpsServerReadRequest = serde_json::from_value(json!({
            "method": "POST",
            "collectionUrl": "https://ado.example.test/DefaultCollection",
            "authMode": "default-credentials",
            "area": "wit",
            "resource": "wiql",
            "project": "RocketX",
            "body": {"query": "SELECT [System.Id] FROM WorkItems"}
        }))
        .unwrap();
        let validated = validate_butler_azure_devops_server_read_request(wiql).unwrap();
        assert_eq!(validated.method, "POST");
        assert_eq!(
            serde_json::to_value(validated).unwrap()["body"]["query"],
            "SELECT [System.Id] FROM WorkItems"
        );

        let invalid_method: ButlerAzureDevOpsServerReadRequest = serde_json::from_value(json!({
            "method": "PATCH",
            "collectionUrl": "https://ado.example.test/DefaultCollection",
            "authMode": "default-credentials",
            "area": "wit",
            "resource": "workitems/42",
            "body": {"state": "Closed"}
        }))
        .unwrap();
        assert!(validate_butler_azure_devops_server_read_request(invalid_method).is_err());

        let get_with_body: ButlerAzureDevOpsServerReadRequest = serde_json::from_value(json!({
            "method": "GET",
            "collectionUrl": "https://ado.example.test/DefaultCollection",
            "authMode": "default-credentials",
            "resource": "projects",
            "body": {"query": "unexpected"}
        }))
        .unwrap();
        assert!(validate_butler_azure_devops_server_read_request(get_with_body).is_err());

        let post_without_body: ButlerAzureDevOpsServerReadRequest = serde_json::from_value(json!({
            "method": "POST",
            "collectionUrl": "https://ado.example.test/DefaultCollection",
            "authMode": "default-credentials",
            "area": "wit",
            "resource": "wiql"
        }))
        .unwrap();
        assert!(validate_butler_azure_devops_server_read_request(post_without_body).is_err());

        let oversized_body: ButlerAzureDevOpsServerReadRequest = serde_json::from_value(json!({
            "method": "POST",
            "collectionUrl": "https://ado.example.test/DefaultCollection",
            "authMode": "default-credentials",
            "area": "wit",
            "resource": "wiql",
            "body": {"query": "x".repeat(AZURE_DEVOPS_SERVER_BODY_LIMIT)}
        }))
        .unwrap();
        assert!(validate_butler_azure_devops_server_read_request(oversized_body).is_err());

        let invalid_query = ButlerAzureDevOpsServerReadRequest {
            method: Some("GET".to_string()),
            collection_url: "https://ado.example.test/DefaultCollection".to_string(),
            auth_mode: Some("default-credentials".to_string()),
            pat: None,
            area: Some("git".to_string()),
            resource: "repositories".to_string(),
            project: None,
            team: None,
            query: Some(serde_json::Map::from_iter([(
                "bad".to_string(),
                json!({ "nested": true }),
            )])),
            body: None,
            api_version: None,
            server_version_hint: None,
            allow_conditional_area: false,
        };
        assert!(validate_butler_azure_devops_server_read_request(invalid_query).is_err());

        let invalid_resource = ButlerAzureDevOpsServerReadRequest {
            method: Some("GET".to_string()),
            collection_url: "https://ado.example.test/DefaultCollection".to_string(),
            auth_mode: Some("default-credentials".to_string()),
            pat: None,
            area: Some("git".to_string()),
            resource: "../repositories".to_string(),
            project: None,
            team: None,
            query: None,
            body: None,
            api_version: None,
            server_version_hint: None,
            allow_conditional_area: false,
        };
        assert!(validate_butler_azure_devops_server_read_request(invalid_resource).is_err());
    }

    #[test]
    fn azure_devops_success_payload_redacts_pat_values() {
        let mut value = json!({
            "plain": "safe",
            "nested": {
                "echo": "prefix-top-secret-suffix",
                "items": ["top-secret", 42]
            }
        });
        redact_json_secret(&mut value, "top-secret");
        assert_eq!(value["plain"], "safe");
        assert_eq!(value["nested"]["echo"], "prefix-***-suffix");
        assert_eq!(value["nested"]["items"][0], "***");
    }

    #[test]
    fn azure_devops_host_adapter_stays_windows_powershell_compatible() {
        let adapter =
            include_str!("../resources/codex-skills/azure-devops-server-host-adapter.ps1");
        assert!(adapter.contains("$requestObject = ConvertFrom-Json -InputObject $raw"));
        assert!(adapter.contains("$request = @{}"));
        assert!(adapter.contains("$invokeParams.Body = $request.body"));
        assert!(adapter.contains("$invokeParams.DryRun = $true"));
        assert!(!adapter.contains("$invokeParams.AllowWrite"));
        assert!(!adapter.contains("-AsHashtable"));
        assert!(!adapter.contains("ConvertFrom-Json -InputObject $raw -AsHashtable -Depth 100"));
    }

    #[test]
    fn business_mcp_default_credentials_uses_skill_preview_then_native_windows_auth() {
        let request =
            validate_butler_azure_devops_server_read_request(ButlerAzureDevOpsServerReadRequest {
                method: Some("GET".to_string()),
                collection_url: "http://ado.example.test/DefaultCollection".to_string(),
                auth_mode: Some("default-credentials".to_string()),
                pat: None,
                area: None,
                resource: "projects".to_string(),
                project: None,
                team: None,
                query: Some(serde_json::Map::from_iter([("$top".to_string(), json!(1))])),
                body: None,
                api_version: Some("7.0".to_string()),
                server_version_hint: None,
                allow_conditional_area: false,
            })
            .unwrap();

        let result = run_business_azure_devops_server_read_with(
            request,
            |_, dry_run| {
                assert!(dry_run, "Skill adapter must build the authoritative request");
                Ok(json!({
                    "Method": "GET",
                    "Uri": "http://ado.example.test/DefaultCollection/_apis/projects?%24top=1&api-version=7.0",
                    "Body": null,
                    "RequiresAllowWrite": false
                }))
            },
            |url, method, body, content_type| {
                assert_eq!(url, "http://ado.example.test/DefaultCollection/_apis/projects?%24top=1&api-version=7.0");
                assert_eq!(method, "GET");
                assert_eq!(body, None);
                assert_eq!(content_type, "application/json");
                Ok(crate::winauth::HttpResponse {
                    status: 200,
                    body: r#"{"count":1,"value":[{"name":"test"}]}"#.to_string(),
                })
            },
        )
        .unwrap();

        assert_eq!(result["count"], 1);
        assert_eq!(result["value"][0]["name"], "test");
        assert_eq!(
            result["_rocketxSource"]["url"],
            "http://ado.example.test/DefaultCollection/_apis/projects?%24top=1&api-version=7.0"
        );
    }

    #[test]
    fn business_mcp_default_credentials_rejects_preview_outside_configured_collection() {
        for preview_uri in [
            "https://search.example.test/RocketX/_apis/search/workitemsearchresults?api-version=7.0",
            "https://ado.example.test/DefaultCollection-evil/RocketX/_apis/search/workitemsearchresults?api-version=7.0",
        ] {
            let request = validate_butler_azure_devops_server_read_request(
                ButlerAzureDevOpsServerReadRequest {
                    method: Some("GET".to_string()),
                    collection_url: "https://ado.example.test/DefaultCollection".to_string(),
                    auth_mode: Some("default-credentials".to_string()),
                    pat: None,
                    area: Some("search".to_string()),
                    resource: "workitemsearchresults".to_string(),
                    project: Some("RocketX".to_string()),
                    team: None,
                    query: None,
                    body: None,
                    api_version: Some("7.0".to_string()),
                    server_version_hint: None,
                    allow_conditional_area: true,
                },
            )
            .unwrap();

            let error = run_business_azure_devops_server_read_with(
                request,
                |_, dry_run| {
                    assert!(dry_run);
                    Ok(json!({
                        "Method": "GET",
                        "Uri": preview_uri,
                        "Body": null,
                        "RequiresAllowWrite": false
                    }))
                },
                |_, _, _, _| -> Result<crate::winauth::HttpResponse, String> {
                    panic!("off-collection previews must never receive Windows credentials")
                },
            )
            .unwrap_err();

            assert!(error.contains("collection"));
        }
    }

    #[test]
    fn business_mcp_pat_requests_stay_on_the_skill_adapter() {
        let request =
            validate_butler_azure_devops_server_read_request(ButlerAzureDevOpsServerReadRequest {
                method: Some("GET".to_string()),
                collection_url: "https://ado.example.test/DefaultCollection".to_string(),
                auth_mode: Some("pat".to_string()),
                pat: Some("secret".to_string()),
                area: None,
                resource: "projects".to_string(),
                project: None,
                team: None,
                query: None,
                body: None,
                api_version: Some("7.0".to_string()),
                server_version_hint: None,
                allow_conditional_area: false,
            })
            .unwrap();

        let result = run_business_azure_devops_server_read_with(
            request,
            |_, dry_run| {
                assert!(!dry_run);
                Ok(json!({"count": 1}))
            },
            |_, _, _, _| -> Result<crate::winauth::HttpResponse, String> {
                panic!("PAT requests must not enter Windows integrated auth")
            },
        )
        .unwrap();

        assert_eq!(result["count"], 1);
    }

    #[test]
    fn business_mcp_native_auth_never_executes_skill_write_previews() {
        let request =
            validate_butler_azure_devops_server_read_request(ButlerAzureDevOpsServerReadRequest {
                method: Some("POST".to_string()),
                collection_url: "http://ado.example.test/DefaultCollection".to_string(),
                auth_mode: Some("default-credentials".to_string()),
                pat: None,
                area: Some("git".to_string()),
                resource: "repositories".to_string(),
                project: Some("RocketX".to_string()),
                team: None,
                query: None,
                body: Some(serde_json::Map::from_iter([(
                    "name".to_string(),
                    json!("must-not-write"),
                )])),
                api_version: Some("7.0".to_string()),
                server_version_hint: None,
                allow_conditional_area: false,
            })
            .unwrap();

        let error = run_business_azure_devops_server_read_with(
            request,
            |_, dry_run| {
                assert!(dry_run);
                Ok(json!({
                    "Method": "POST",
                    "Uri": "http://ado.example.test/DefaultCollection/RocketX/_apis/git/repositories?api-version=7.0",
                    "Body": "{\"name\":\"must-not-write\"}",
                    "RequiresAllowWrite": true
                }))
            },
            |_, _, _, _| -> Result<crate::winauth::HttpResponse, String> {
                panic!("write previews must never reach native HTTP")
            },
        )
        .unwrap_err();

        assert!(error.contains("只读"));
    }

    #[test]
    fn azure_devops_runner_drops_ambient_alternate_host_overrides() {
        let mut command = Command::new("powershell");
        for name in super::AZURE_DEVOPS_SERVER_BASE_URL_ENV_VARS {
            command.env(name, "https://untrusted.example.test");
        }

        super::harden_azure_devops_runner_environment(&mut command);

        let removed = command
            .get_envs()
            .filter_map(|(name, value)| value.is_none().then_some(name))
            .collect::<Vec<_>>();
        for name in super::AZURE_DEVOPS_SERVER_BASE_URL_ENV_VARS {
            assert!(removed.contains(&OsStr::new(name)));
        }
    }

    #[test]
    fn standalone_business_mcp_resolves_the_bundled_azure_adapter() {
        let adapter = standalone_azure_devops_server_adapter_path().unwrap();
        assert!(adapter.is_file());
        assert_eq!(
            adapter.file_name().and_then(|value| value.to_str()),
            Some(AZURE_DEVOPS_SERVER_HOST_ADAPTER)
        );
    }

    #[cfg(windows)]
    #[test]
    fn azure_devops_runner_falls_back_to_windows_powershell_when_pwsh_is_missing() {
        let root = unique_temp_dir("pwsh-fallback");
        let powershell = root
            .join("WindowsPowerShell")
            .join("v1.0")
            .join("powershell.exe");
        fs::create_dir_all(powershell.parent().unwrap()).unwrap();
        fs::write(&powershell, b"test").unwrap();

        let resolved = first_existing_program([
            root.join("PowerShell").join("7").join("pwsh.exe"),
            powershell.clone(),
        ])
        .unwrap();
        assert_eq!(resolved, powershell);
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(windows)]
    #[test]
    fn azure_devops_runner_uses_system_powershell_instead_of_path_resolution() {
        let resolved = resolve_pwsh_program().unwrap();
        assert!(resolved
            .to_string_lossy()
            .to_ascii_lowercase()
            .ends_with("\\windowspowershell\\v1.0\\powershell.exe"));
    }

    #[cfg(windows)]
    #[test]
    fn azure_devops_runner_exercises_stdin_stdout_and_secret_redaction() {
        let root = unique_temp_dir("azure-runner");
        fs::create_dir_all(&root).unwrap();
        let adapter = root.join("adapter.ps1");
        fs::write(
            &adapter,
            r#"$ErrorActionPreference = 'Stop'
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
[ordered]@{
  method = $request.method
  collectionUrl = $request.collectionUrl
  authMode = $request.authMode
  pat = $request.pat
  resource = $request.resource
} | ConvertTo-Json -Compress
"#,
        )
        .unwrap();

        let request =
            validate_butler_azure_devops_server_read_request(ButlerAzureDevOpsServerReadRequest {
                method: Some("GET".to_string()),
                collection_url: "https://ado.example.test/DefaultCollection".to_string(),
                auth_mode: Some("pat".to_string()),
                pat: Some("top-secret".to_string()),
                area: Some("git".to_string()),
                resource: "pullrequests/42".to_string(),
                project: None,
                team: None,
                query: None,
                body: None,
                api_version: Some("6.0".to_string()),
                server_version_hint: Some("2022".to_string()),
                allow_conditional_area: false,
            })
            .unwrap();

        let result = run_butler_azure_devops_server_read(adapter, request).unwrap();
        assert_eq!(result["method"], "GET");
        assert_eq!(
            result["collectionUrl"],
            "https://ado.example.test/DefaultCollection"
        );
        assert_eq!(result["authMode"], "pat");
        assert_eq!(result["pat"], "***");
        assert_eq!(result["resource"], "pullrequests/42");
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(windows)]
    #[test]
    fn azure_devops_host_adapter_runs_under_windows_powershell() {
        let Ok(program) = resolve_pwsh_program() else {
            return;
        };

        let root = unique_temp_dir("azure-host-adapter");
        let skill_root = root.join("azure-devops-server");
        let script_root = skill_root.join("scripts");
        fs::create_dir_all(&script_root).unwrap();
        fs::copy(
            PathBuf::from("resources")
                .join("codex-skills")
                .join(AZURE_DEVOPS_SERVER_HOST_ADAPTER),
            root.join(AZURE_DEVOPS_SERVER_HOST_ADAPTER),
        )
        .unwrap();
        fs::write(
            script_root.join("Invoke-AzureDevOpsServerApi.ps1"),
            r#"[CmdletBinding()]
param(
    [string]$Method,
    [string]$Area,
    [string]$Resource,
    [hashtable]$Query,
    [object]$Body,
    [string]$CollectionUrl,
    [string]$AuthMode,
    [string]$Project,
    [string]$Team,
    [string]$Pat,
    [string]$ApiVersion,
    [string]$ServerVersionHint,
    [switch]$AllowConditionalArea
)
[ordered]@{
    method = $Method
    area = $Area
    resource = $Resource
    collectionUrl = $CollectionUrl
    authMode = $AuthMode
    project = $Project
    team = $Team
    apiVersion = $ApiVersion
    serverVersionHint = $ServerVersionHint
    allowConditionalArea = $AllowConditionalArea.IsPresent
    ids = @($Query["ids"])
    body = $Body
}
"#,
        )
        .unwrap();

        let request =
            validate_butler_azure_devops_server_read_request(ButlerAzureDevOpsServerReadRequest {
                method: Some("POST".to_string()),
                collection_url: "https://ado.example.test/DefaultCollection".to_string(),
                auth_mode: Some("default-credentials".to_string()),
                pat: None,
                area: Some("wit".to_string()),
                resource: "wiql".to_string(),
                project: Some("RocketX".to_string()),
                team: None,
                query: Some(serde_json::Map::from_iter([(
                    "ids".to_string(),
                    json!([42, 43]),
                )])),
                body: Some(serde_json::Map::from_iter([(
                    "query".to_string(),
                    json!("SELECT [System.Id] FROM WorkItems"),
                )])),
                api_version: Some("6.0".to_string()),
                server_version_hint: Some("2022".to_string()),
                allow_conditional_area: false,
            })
            .unwrap();

        let adapter = fs::canonicalize(root.join(AZURE_DEVOPS_SERVER_HOST_ADAPTER)).unwrap();
        let result =
            run_butler_azure_devops_server_read_with_program(program, adapter, request).unwrap();
        assert_eq!(result["method"], "POST");
        assert_eq!(result["resource"], "wiql");
        assert_eq!(
            result["collectionUrl"],
            "https://ado.example.test/DefaultCollection"
        );
        assert_eq!(result["authMode"], "default-credentials");
        assert_eq!(result["ids"], json!([42, 43]));
        assert_eq!(result["body"]["query"], "SELECT [System.Id] FROM WorkItems");
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(windows)]
    #[test]
    fn bundled_azure_devops_skill_blocks_non_read_post_routes() {
        let request =
            validate_butler_azure_devops_server_read_request(ButlerAzureDevOpsServerReadRequest {
                method: Some("POST".to_string()),
                collection_url: "https://ado.example.test/DefaultCollection".to_string(),
                auth_mode: Some("default-credentials".to_string()),
                pat: None,
                area: Some("git".to_string()),
                resource: "repositories".to_string(),
                project: Some("RocketX".to_string()),
                team: None,
                query: None,
                body: Some(serde_json::Map::from_iter([(
                    "name".to_string(),
                    json!("must-not-write"),
                )])),
                api_version: Some("6.0".to_string()),
                server_version_hint: Some("2022".to_string()),
                allow_conditional_area: false,
            })
            .unwrap();
        let adapter = PathBuf::from("resources")
            .join("codex-skills")
            .join(AZURE_DEVOPS_SERVER_HOST_ADAPTER);
        let error = run_butler_azure_devops_server_read(adapter, request).unwrap_err();
        assert!(error.contains("Live writes are blocked by default"));
    }

    #[test]
    fn desktop_registers_azure_devops_server_read_command() {
        assert!(
            include_str!("main.rs").contains("proc::butler_azure_devops_server_read"),
            "Tauri invoke handler must register the Azure DevOps Server read command"
        );
    }

    #[test]
    fn default_tauri_bundle_keeps_skills_but_excludes_codex_runtime() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(
            config["bundle"]["resources"]["resources/codex-skills/"].as_str(),
            Some("codex-skills/")
        );
        assert_eq!(
            config["bundle"]["resources"]["../../web/src/butler/skills/core/"].as_str(),
            Some("rocketx-core-skills/")
        );
        assert_eq!(
            config["bundle"]["resources"]["target/codex-resources/codex/"].as_str(),
            None
        );
    }

    #[test]
    fn system_codex_precedes_standard_and_bundled_candidates() {
        let root = unique_temp_dir("system-codex-priority");
        let bundled = root.join("bundled").join("codex.exe");
        let system = root.join("system").join("codex.exe");
        let standard = root.join("standard").join("codex.exe");
        for path in [&bundled, &system, &standard] {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, b"test").unwrap();
        }

        let resolved = resolve_codex_from_candidates_with_probe(
            None,
            std::slice::from_ref(&system),
            std::slice::from_ref(&standard),
            std::slice::from_ref(&bundled),
            |_| Ok("0.145.0".to_string()),
        )
        .unwrap();
        assert_eq!(resolved.source, CodexRuntimeSource::System);
        assert_eq!(resolved.version, "0.145.0");
        assert_eq!(
            PathBuf::from(resolved.display_path),
            PathBuf::from(host_path(&system.canonicalize().unwrap()))
        );

        fs::remove_file(&system).unwrap();
        let fallback = resolve_codex_from_candidates_with_probe(
            None,
            std::slice::from_ref(&system),
            std::slice::from_ref(&standard),
            std::slice::from_ref(&bundled),
            |_| Ok("0.145.0".to_string()),
        )
        .unwrap();
        assert_eq!(fallback.source, CodexRuntimeSource::Standard);
        assert_eq!(
            PathBuf::from(fallback.display_path),
            PathBuf::from(host_path(&standard.canonicalize().unwrap()))
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn manual_codex_is_exclusive_and_old_automatic_candidates_are_skipped() {
        let root = unique_temp_dir("manual-codex-priority");
        let manual = root.join("manual").join("codex.exe");
        let system = root.join("system").join("codex.exe");
        let standard = root.join("standard").join("codex.exe");
        for path in [&manual, &system, &standard] {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, b"test").unwrap();
        }

        let resolved = resolve_codex_from_candidates_with_probe(
            Some(&manual),
            std::slice::from_ref(&system),
            std::slice::from_ref(&standard),
            &[],
            |_| Ok("0.145.0".to_string()),
        )
        .unwrap();
        assert_eq!(resolved.source, CodexRuntimeSource::Manual);
        assert_eq!(
            PathBuf::from(&resolved.display_path),
            PathBuf::from(host_path(&manual.canonicalize().unwrap()))
        );

        let fallback = resolve_codex_from_candidates_with_probe(
            None,
            std::slice::from_ref(&system),
            std::slice::from_ref(&standard),
            &[],
            |candidate| {
                if candidate.display_path.contains("system") {
                    Ok("0.139.0".to_string())
                } else {
                    Ok("0.145.0".to_string())
                }
            },
        )
        .unwrap();
        assert_eq!(fallback.source, CodexRuntimeSource::Standard);
        assert_eq!(
            PathBuf::from(fallback.display_path),
            PathBuf::from(host_path(&standard.canonicalize().unwrap()))
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn runtime_probe_prefers_supported_candidate_and_keeps_blocked_candidate_details() {
        let root = unique_temp_dir("runtime-probe-codex-priority");
        let system = root.join("system").join("codex.exe");
        let standard = root.join("standard").join("codex.exe");
        for path in [&system, &standard] {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, b"test").unwrap();
        }

        let (fallback, status) = probe_resolve_codex_from_candidates_with_probe(
            None,
            std::slice::from_ref(&system),
            std::slice::from_ref(&standard),
            &[],
            |candidate| {
                if candidate.display_path.contains("system") {
                    Ok("0.140.0".to_string())
                } else {
                    Ok("0.145.0".to_string())
                }
            },
        )
        .unwrap();
        assert_eq!(status, CodexCompatibilityStatus::UntestedNewer);
        assert_eq!(
            PathBuf::from(fallback.display_path),
            PathBuf::from(host_path(&standard.canonicalize().unwrap()))
        );
        assert_eq!(fallback.version, "0.145.0");

        let (blocked, blocked_status) = probe_resolve_codex_from_candidates_with_probe(
            None,
            std::slice::from_ref(&system),
            &[],
            &[],
            |_| Ok("0.140.0".to_string()),
        )
        .unwrap();
        assert_eq!(blocked_status, CodexCompatibilityStatus::Blocked);
        assert_eq!(blocked.source, CodexRuntimeSource::System);
        assert_eq!(blocked.version, "0.140.0");
        assert_eq!(
            PathBuf::from(blocked.display_path),
            PathBuf::from(host_path(&system.canonicalize().unwrap()))
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn runtime_probe_reports_rejected_candidate_before_selected_fallback() {
        let root = unique_temp_dir("runtime-probe-candidates");
        let system = root.join("system").join("codex.exe");
        let standard = root.join("standard").join("codex.exe");
        for path in [&system, &standard] {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, b"test").unwrap();
        }

        let probe = codex_runtime_probe_from_candidates_with(
            None,
            std::slice::from_ref(&system),
            std::slice::from_ref(&standard),
            &[],
            |candidate| {
                if candidate.display_path.contains("system") {
                    Ok("0.144.1".to_string())
                } else {
                    Ok("0.144.4".to_string())
                }
            },
            |_| Ok(()),
            |_| Ok(()),
        );

        assert!(probe.ready);
        assert_eq!(probe.source, Some(CodexRuntimeSource::Standard));
        assert_eq!(probe.version.as_deref(), Some("0.144.4"));
        assert_eq!(probe.reason_code, None);
        assert_eq!(probe.candidates.len(), 2);
        assert_eq!(
            probe.candidates[0].outcome,
            CodexRuntimeCandidateOutcome::Rejected
        );
        assert_eq!(
            probe.candidates[0].reason_code,
            Some(CodexRuntimeReasonCode::Outdated)
        );
        assert_eq!(
            probe.candidates[1].outcome,
            CodexRuntimeCandidateOutcome::Selected
        );
        assert_eq!(probe.candidates[1].version.as_deref(), Some("0.144.4"));

        let manual = codex_runtime_probe_from_candidates_with(
            Some(&system),
            std::slice::from_ref(&system),
            std::slice::from_ref(&standard),
            &[],
            |_| Ok("0.144.1".to_string()),
            |_| Ok(()),
            |_| Ok(()),
        );
        assert!(!manual.ready);
        assert_eq!(manual.reason_code, Some(CodexRuntimeReasonCode::ManualPath));
        assert_eq!(manual.candidates.len(), 1);
        assert_eq!(
            manual.candidates[0].reason_code,
            Some(CodexRuntimeReasonCode::Outdated)
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn runtime_probe_skips_candidate_without_app_server() {
        let root = unique_temp_dir("runtime-probe-missing-app-server");
        let system = root.join("system").join("codex.exe");
        let standard = root.join("standard").join("codex.exe");
        for path in [&system, &standard] {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, b"test").unwrap();
        }

        let probe = codex_runtime_probe_from_candidates_with(
            None,
            std::slice::from_ref(&system),
            std::slice::from_ref(&standard),
            &[],
            |candidate| {
                if candidate.display_path.contains("system") {
                    Ok("0.144.5".to_string())
                } else {
                    Ok("0.144.4".to_string())
                }
            },
            |candidate| {
                if candidate.display_path.contains("system") {
                    Err("app-server missing".to_string())
                } else {
                    Ok(())
                }
            },
            |_| Ok(()),
        );

        assert!(probe.ready);
        assert_eq!(probe.version.as_deref(), Some("0.144.4"));
        assert_eq!(probe.candidates.len(), 2);
        assert_eq!(
            probe.candidates[0].reason_code,
            Some(CodexRuntimeReasonCode::MissingAppServer)
        );
        assert_eq!(
            probe.candidates[1].outcome,
            CodexRuntimeCandidateOutcome::Selected
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn runtime_probe_skips_candidate_with_unparseable_version() {
        let root = unique_temp_dir("runtime-probe-invalid-version");
        let system = root.join("system").join("codex.exe");
        let standard = root.join("standard").join("codex.exe");
        for path in [&system, &standard] {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, b"test").unwrap();
        }

        let probe = codex_runtime_probe_from_candidates_with(
            None,
            std::slice::from_ref(&system),
            std::slice::from_ref(&standard),
            &[],
            |candidate| {
                if candidate.display_path.contains("system") {
                    Ok("nightly".to_string())
                } else {
                    Ok("0.144.4".to_string())
                }
            },
            |_| Ok(()),
            |_| Ok(()),
        );

        assert!(probe.ready);
        assert_eq!(probe.version.as_deref(), Some("0.144.4"));
        assert_eq!(probe.candidates.len(), 2);
        assert_eq!(
            probe.candidates[0].reason_code,
            Some(CodexRuntimeReasonCode::Unavailable)
        );
        assert_eq!(
            probe.candidates[1].outcome,
            CodexRuntimeCandidateOutcome::Selected
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn runtime_probe_prefers_deeper_failure_when_no_candidate_succeeds() {
        let root = unique_temp_dir("runtime-probe-failure-priority");
        let system = root.join("system").join("codex.exe");
        let standard = root.join("standard").join("codex.exe");
        for path in [&system, &standard] {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, b"test").unwrap();
        }

        let probe = codex_runtime_probe_from_candidates_with(
            None,
            std::slice::from_ref(&system),
            std::slice::from_ref(&standard),
            &[],
            |candidate| {
                if candidate.display_path.contains("system") {
                    Ok("0.144.1".to_string())
                } else {
                    Ok("0.144.4".to_string())
                }
            },
            |_| Ok(()),
            |candidate| {
                if candidate.display_path.contains("standard") {
                    Err("not logged in".to_string())
                } else {
                    Ok(())
                }
            },
        );

        assert!(!probe.ready);
        assert_eq!(probe.reason_code, Some(CodexRuntimeReasonCode::NotLoggedIn));
        assert_eq!(probe.version.as_deref(), Some("0.144.4"));
        assert_eq!(probe.candidates.len(), 2);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn codex_version_contract_classifies_candidate_baseline_and_newer_versions() {
        assert_eq!(parse_semantic_version("0.140.0"), Some((0, 140, 0)));
        assert_eq!(parse_semantic_version("0.145.0-beta.1"), Some((0, 145, 0)));
        assert_eq!(parse_semantic_version("0.140"), None);
        assert_eq!(CODEX_MINIMUM_CANDIDATE, "0.140.0");
        assert_eq!(CODEX_PROTOCOL_BASELINE, "0.144.4");
        assert_eq!(CODEX_VERIFIED_VERSIONS, &["0.144.4"]);
        assert_eq!(
            classify_codex_version("0.139.9").unwrap(),
            CodexCompatibilityStatus::Blocked
        );
        assert_eq!(
            classify_codex_version("0.140.0").unwrap(),
            CodexCompatibilityStatus::Blocked
        );
        assert_eq!(
            classify_codex_version("0.144.4-beta.1").unwrap(),
            CodexCompatibilityStatus::Blocked
        );
        assert_eq!(
            classify_codex_version("0.144.4").unwrap(),
            CodexCompatibilityStatus::Verified
        );
        assert_eq!(
            classify_codex_version("0.144.5").unwrap(),
            CodexCompatibilityStatus::UntestedNewer
        );
        assert_eq!(
            classify_codex_version("0.145.0-beta.1").unwrap(),
            CodexCompatibilityStatus::UntestedNewer
        );
        assert!(classify_codex_version("nightly").is_err());
    }

    #[test]
    fn unsupported_version_message_only_names_protocol_baseline() {
        let message = super::unsupported_codex_version_message("0.144.1");
        assert!(message.contains("0.144.4"));
        assert!(!message.contains("0.140.0"));
    }

    #[test]
    fn codex_runtime_contract_and_sources_serialize() {
        let probe = serde_json::to_value(CodexRuntimeProbe {
            ready: true,
            version: Some("0.144.4".to_string()),
            executable_path: Some("C:\\Tools\\codex.exe".to_string()),
            source: Some(CodexRuntimeSource::Manual),
            protocol_baseline: CODEX_PROTOCOL_BASELINE,
            minimum_candidate: CODEX_MINIMUM_CANDIDATE,
            verified_versions: CODEX_VERIFIED_VERSIONS,
            compatibility_status: CodexCompatibilityStatus::Verified,
            reason_code: None,
            reason: None,
            candidates: vec![CodexRuntimeCandidate {
                source: CodexRuntimeSource::Manual,
                path: "C:\\Tools\\codex.exe".to_string(),
                version: Some("0.144.4".to_string()),
                outcome: CodexRuntimeCandidateOutcome::Selected,
                reason_code: None,
            }],
        })
        .unwrap();
        assert_eq!(probe["source"], "manual");
        assert_eq!(probe["protocolBaseline"], "0.144.4");
        assert_eq!(probe["minimumCandidate"], "0.140.0");
        assert_eq!(probe["verifiedVersions"], json!(["0.144.4"]));
        assert_eq!(probe["compatibilityStatus"], "verified");
        assert!(probe["reasonCode"].is_null());
        assert_eq!(probe["candidates"][0]["source"], "manual");
        assert_eq!(probe["candidates"][0]["outcome"], "selected");
        assert_eq!(probe["candidates"][0]["path"], "C:\\Tools\\codex.exe");
        let standard_source = serde_json::to_value(CodexRuntimeSource::Standard).unwrap();
        assert_eq!(standard_source, json!("standard"));
        let process = serde_json::to_value(CodexProcessInfo {
            process_id: "test-process".to_string(),
            version: "0.144.4".to_string(),
            runtime_workspace_root: "C:\\workspace".to_string(),
            runtime_source: CodexRuntimeSource::Standard,
            managed_skill_roots: vec!["C:\\RocketX\\skills".to_string()],
        })
        .unwrap();
        assert_eq!(process["runtimeSource"], "standard");
        assert_eq!(process["managedSkillRoots"], json!(["C:\\RocketX\\skills"]));
    }

    #[cfg(windows)]
    #[test]
    fn resolved_npm_codex_runs_the_official_node_entry_without_a_shell() {
        use std::ffi::OsStr;

        let resolved = ResolvedCodex {
            program: PathBuf::from(r"C:\Program Files\nodejs\node.exe"),
            prefix_args: vec![OsString::from(
                r"C:\Users\test\AppData\Roaming\npm\node_modules\@openai\codex\bin\codex.js",
            )],
            display_path: r"C:\Users\test\AppData\Roaming\npm\codex.cmd".to_string(),
            source: CodexRuntimeSource::System,
            version: "0.145.0".to_string(),
        };
        let command = resolved.command();
        assert_eq!(
            command.get_program(),
            OsStr::new(r"C:\Program Files\nodejs\node.exe")
        );
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            [OsStr::new(
                r"C:\Users\test\AppData\Roaming\npm\node_modules\@openai\codex\bin\codex.js",
            )]
        );
    }
}
