//! Codex process ownership and lifecycle state.
//!
//! The Tauri facade still owns command registration, while this module owns
//! the shared state and event payloads used by the process adapter.  Keeping
//! these records together prevents lifecycle code from reaching into the
//! runtime discovery policy.

use std::{
    collections::HashMap,
    path::PathBuf,
    process::{Child, ChildStdin},
    sync::{atomic::AtomicBool, Arc, Mutex},
};

use super::{
    codex_contract::*,
    supervisor::{RuntimeStatus, RuntimeSupervisor},
};

#[derive(Clone)]
pub(crate) struct ManagedCodex {
    pub(crate) process_id: String,
    pub(crate) session_id: String,
    pub(crate) child: Arc<Mutex<Child>>,
    pub(crate) stdin: Arc<Mutex<ChildStdin>>,
    pub(crate) attachments_dir: PathBuf,
    pub(crate) workspace_root: String,
    pub(crate) version: String,
    pub(crate) runtime_source: CodexRuntimeSource,
    pub(crate) supervisor: Arc<Mutex<RuntimeSupervisor>>,
    pub(crate) stopping: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct CodexAppServerState {
    pub(crate) processes: Arc<Mutex<HashMap<String, ManagedCodex>>>,
    pub(crate) supervisors: Arc<Mutex<HashMap<String, Arc<Mutex<RuntimeSupervisor>>>>>,
    pub(crate) next_id: Arc<std::sync::atomic::AtomicU64>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexOutputEvent {
    pub(crate) process_id: String,
    pub(crate) stream: &'static str,
    pub(crate) line: String,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexExitEvent {
    pub(crate) process_id: String,
    pub(crate) code: Option<i32>,
    pub(crate) status: RuntimeStatus,
    pub(crate) failures: u32,
    pub(crate) restart_after_ms: Option<u64>,
}

#[derive(Clone)]
pub(crate) struct ResolvedCodex {
    pub(crate) program: PathBuf,
    pub(crate) prefix_args: Vec<std::ffi::OsString>,
    pub(crate) display_path: String,
    pub(crate) source: CodexRuntimeSource,
    pub(crate) version: String,
}

impl ResolvedCodex {
    pub(crate) fn command(&self) -> std::process::Command {
        let mut command = std::process::Command::new(&self.program);
        command.args(&self.prefix_args);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        command
    }
}
