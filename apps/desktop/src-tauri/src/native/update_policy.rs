//! Pure installer and version policy for the signed update flow.
//!
//! File IO, Tauri updater integration, and process takeover remain in
//! `proc.rs`; this module keeps the compatibility decisions deterministic.

use std::path::Path;

use super::codex_runtime;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WindowsInstallerKind {
    Nsis,
    Msi,
}

impl WindowsInstallerKind {
    pub(crate) fn extension(self) -> &'static str {
        match self {
            Self::Nsis => "exe",
            Self::Msi => "msi",
        }
    }

    pub(crate) fn platform_key(self) -> &'static str {
        match self {
            Self::Nsis => "windows-x86_64",
            Self::Msi => "windows-x86_64-msi",
        }
    }

    pub(crate) fn alternate_platform_key(self) -> &'static str {
        match self {
            Self::Nsis => "windows-x86_64-msi",
            Self::Msi => "windows-x86_64",
        }
    }

    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Nsis => "NSIS",
            Self::Msi => "MSI",
        }
    }

    pub(crate) fn cli_value(self) -> &'static str {
        match self {
            Self::Nsis => "nsis",
            Self::Msi => "msi",
        }
    }

    pub(crate) fn from_cli(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "nsis" => Some(Self::Nsis),
            "msi" => Some(Self::Msi),
            _ => None,
        }
    }
}

pub(crate) fn silent_install_invocation(
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

pub(crate) fn installer_exit_code_is_success(
    installer_kind: WindowsInstallerKind,
    code: Option<i32>,
) -> bool {
    match installer_kind {
        WindowsInstallerKind::Nsis => code == Some(0),
        WindowsInstallerKind::Msi => matches!(code, Some(0 | 1641 | 3010)),
    }
}

pub(crate) const INSTALLER_LAUNCH_FAILURE_EXIT_CODE: i32 = 242;

pub(crate) fn summarize_installer_output(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes)
        .trim()
        .chars()
        .take(200)
        .collect()
}

pub(crate) fn silent_install_failure_message(
    installer_kind: WindowsInstallerKind,
    code: Option<i32>,
    stdout: &[u8],
    stderr: &[u8],
) -> String {
    let stderr = summarize_installer_output(stderr);
    if code == Some(INSTALLER_LAUNCH_FAILURE_EXIT_CODE) {
        let mut message = "无法启动安装程序（可能取消了管理员授权）".to_string();
        if !stderr.is_empty() {
            message.push_str(&format!("：{stderr}"));
        }
        return message;
    }
    let mut message = format!(
        "{} 安装器退出码异常：{}",
        installer_kind.label(),
        code.unwrap_or_default()
    );
    let stdout = summarize_installer_output(stdout);
    let mut details = Vec::new();
    if !stderr.is_empty() {
        details.push(format!("stderr：{stderr}"));
    }
    if !stdout.is_empty() {
        details.push(format!("stdout：{stdout}"));
    }
    if !details.is_empty() {
        message.push_str(&format!("（{}）", details.join("；")));
    }
    message
}

pub(crate) fn normalize_update_version_text(version: &str) -> Option<String> {
    let value = version.trim().trim_start_matches(['v', 'V']);
    (!value.is_empty()).then(|| value.to_string())
}

pub(crate) fn normalize_update_version(version: &str) -> Option<(u64, u64, u64)> {
    codex_runtime::normalize_update_version(version, normalize_update_version_text)
}
