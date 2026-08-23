//! DSH bridge process state and command payloads.

use std::{
    collections::HashMap,
    path::PathBuf,
    process::{Child, ChildStdin},
    sync::{
        atomic::{AtomicBool, AtomicU64},
        Arc, Mutex,
    },
};

use serde::{Deserialize, Serialize};

use super::{
    dsh::DshBridgeMode,
    supervisor::{RuntimeStatus, RuntimeSupervisor},
};

#[derive(Clone)]
pub(crate) struct ManagedDshBridge {
    pub(crate) process_id: String,
    pub(crate) source_root: String,
    pub(crate) child: Arc<Mutex<Child>>,
    pub(crate) stdin: Arc<Mutex<ChildStdin>>,
    pub(crate) running: Arc<AtomicBool>,
    pub(crate) stop_requested: Arc<AtomicBool>,
    pub(crate) stopping: bool,
    pub(crate) host_runtime_dir: PathBuf,
    pub(crate) ready_url: Option<String>,
    pub(crate) leases: HashMap<String, DshConnectionLease>,
    pub(crate) supervisor: Arc<Mutex<RuntimeSupervisor>>,
}

#[derive(Clone)]
pub(crate) struct DshConnectionLease {
    pub(crate) connection_id: String,
    pub(crate) workspace_root: String,
    pub(crate) mode: DshBridgeMode,
    pub(crate) runtime_dir: PathBuf,
}

pub(crate) enum DshBridgeRelease {
    Lease(PathBuf),
    Process(ManagedDshBridge),
}

#[derive(Default)]
pub struct DshBridgeState {
    pub(crate) processes: Arc<Mutex<HashMap<String, ManagedDshBridge>>>,
    pub(crate) supervisors: Arc<Mutex<HashMap<String, Arc<Mutex<RuntimeSupervisor>>>>>,
    pub(crate) next_id: Arc<AtomicU64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DshOutputEvent {
    pub(crate) process_id: String,
    pub(crate) stream: &'static str,
    pub(crate) line: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DshExitEvent {
    pub(crate) process_id: String,
    pub(crate) code: Option<i32>,
    pub(crate) status: RuntimeStatus,
    pub(crate) failures: u32,
    pub(crate) restart_after_ms: Option<u64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DshBridgeInfo {
    pub(crate) process_id: String,
    pub(crate) lease_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) ready_url: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DshRuntimeProbe {
    pub(crate) ready: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) reason: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DshAgentAttachmentMetadata {
    pub(crate) connection_id: String,
    pub(crate) lease_id: String,
    pub(crate) relative_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DshAgentAttachmentRuntimePath {
    pub(crate) path: String,
    pub(crate) root: String,
}

#[derive(Clone)]
pub(crate) struct ResolvedDshRuntime {
    pub(crate) source_root: PathBuf,
    pub(crate) cli_path: PathBuf,
    pub(crate) node_path: PathBuf,
    pub(crate) bridge_path: PathBuf,
    pub(crate) dsh_root: PathBuf,
    pub(crate) home_root: PathBuf,
    pub(crate) supports_no_open: bool,
}
