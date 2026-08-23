//! Stable Codex runtime contracts shared by the Tauri facade and adapters.
//!
//! These types describe probe results and process metadata only.  Discovery,
//! spawning, and Tauri command handlers stay outside this module so the
//! contract can be tested without an application handle.

use std::{path::PathBuf, sync::Mutex};

use serde::Serialize;

// These values are part of the probe response contract consumed by the web
// runtime store. Keep them in the contract module so command glue cannot
// accidentally advertise a different compatibility policy.
pub(crate) const CODEX_MINIMUM_CANDIDATE: &str = "0.140.0";
pub(crate) const CODEX_PROTOCOL_BASELINE: &str = "0.144.4";
pub(crate) const CODEX_VERIFIED_VERSIONS: &[&str] = &[CODEX_PROTOCOL_BASELINE];

#[derive(Default)]
pub struct CodexRuntimeConfig {
    pub(crate) manual_path: Mutex<Option<PathBuf>>,
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
    pub(crate) source: CodexRuntimeSource,
    pub(crate) path: String,
    pub(crate) version: Option<String>,
    pub(crate) outcome: CodexRuntimeCandidateOutcome,
    pub(crate) reason_code: Option<CodexRuntimeReasonCode>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRuntimeProbe {
    pub(crate) ready: bool,
    pub(crate) version: Option<String>,
    pub(crate) executable_path: Option<String>,
    pub(crate) source: Option<CodexRuntimeSource>,
    pub(crate) protocol_baseline: &'static str,
    pub(crate) minimum_candidate: &'static str,
    pub(crate) verified_versions: &'static [&'static str],
    pub(crate) compatibility_status: CodexCompatibilityStatus,
    pub(crate) reason_code: Option<CodexRuntimeReasonCode>,
    pub(crate) reason: Option<String>,
    pub(crate) candidates: Vec<CodexRuntimeCandidate>,
}

impl CodexRuntimeProbe {
    pub(crate) fn new(
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexProcessInfo {
    pub(crate) process_id: String,
    pub(crate) version: String,
    pub(crate) runtime_workspace_root: String,
    pub(crate) runtime_source: CodexRuntimeSource,
    pub(crate) managed_skill_roots: Vec<String>,
}
