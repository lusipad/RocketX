//! One native owner for a bound Codex work session. UI polling is a projection,
//! never the executor. Credentials remain in the native profile/child process.
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicI64, Ordering},
        Arc, Mutex, OnceLock,
    },
    thread,
    time::Duration,
};
use tauri::{Emitter, Manager};

use super::{
    butler_ledger::row_to_dispatch_action,
    butler_native_admission::{self, Admission, ReservationOwner},
    butler_runtime_events::append_runtime_event,
    butler_work_commands::{
        apply_native_receipt, claim_native_command, list_native_session_commands,
        prepare_native_command, read_native_command, read_native_command_spec,
    },
    now_millis, ButlerDb, DispatchActionRecord, RuntimeAccountContext, RuntimeEvent,
};
use crate::{
    local_sessions::NativeResumeAuthorization,
    native::{
        codex_rpc::{InboundMessage, NativeCodexRpc, RpcFailure},
        work_command::{
            CommandSubmitter, NativeCodexIntent, NativeCommandBinding, NativeCommandSpec,
            RuntimeCommandInput, RuntimeCommandState,
        },
        work_decision::{answer_for_request, supported_decision_method},
        work_projection::{
            NativeWorkAdmissionWait, NativeWorkCapabilities, NativeWorkDecision, NativeWorkSnapshot,
        },
    },
};

const ACTION_COLUMNS: &str = "id,idempotency_key,todo_id,event_id,session_id,action_kind,spec_json,baseline_marker,state,receipt_ref,error_message,created_at,updated_at";

#[path = "butler_native_start.rs"]
mod native_start;
pub use native_start::*;

pub(crate) fn migrate_native_runtime(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS work_runtime_snapshots (
        session_id TEXT PRIMARY KEY REFERENCES work_sessions(id) ON DELETE CASCADE,
        snapshot_json TEXT NOT NULL, updated_at INTEGER NOT NULL
    );",
        )
        .map_err(|error| format!("无法初始化原生工作投影：{error}"))?;
    native_start::migrate_native_starts(connection)
}

#[derive(Default)]
pub struct NativeWorkRuntime {
    connections: Mutex<HashMap<String, Arc<NativeConnection>>>,
}

#[derive(Clone)]
struct Binding {
    todo_id: String,
    binding: NativeCommandBinding,
    host_device_id: String,
    requirements_version: i64,
    content_version: i64,
    config: Value,
    owner: String,
}

fn binding(
    connection: &Connection,
    session_id: &str,
    account_scope: &str,
) -> Result<Binding, String> {
    let (todo_id,native_thread_id,source_scope,workspace_root,scope,device,config,version,owner,runtime,requirements,content):
        (String,String,String,String,String,String,String,i64,String,String,i64,i64) = connection.query_row(
        "SELECT s.todo_id,s.native_session_id,s.source_scope,s.workspace_root,COALESCE(s.account_scope,''),
         COALESCE(s.host_device_id,''),COALESCE(s.config_snapshot_json,'{}'),s.binding_version,s.runtime_owner,s.runtime,
         w.requirements_version,w.content_version FROM work_sessions s JOIN work_card_states w ON w.todo_id=s.todo_id WHERE s.id=?1",
        [session_id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?,row.get(7)?,row.get(8)?,row.get(9)?,row.get(10)?,row.get(11)?)),
    ).map_err(|_| "这条会话尚未关联有效工作")?;
    let config: Value = serde_json::from_str(&config).map_err(|_| "原会话配置记录损坏")?;
    if scope != account_scope || device.is_empty() {
        return Err("原会话不属于当前账号或缺少设备身份".into());
    }
    if runtime != "codex" && config.get("provider").and_then(Value::as_str) != Some("codex") {
        return Err("这条会话不是原生 Codex 来源".into());
    }
    let profile = config
        .get("executionProfileId")
        .or_else(|| config.get("agentId"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or("原会话没有可核实的执行配置，请重新扫描来源")?
        .to_string();
    Ok(Binding {
        todo_id,
        binding: NativeCommandBinding {
            session_id: session_id.into(),
            native_thread_id,
            source_scope,
            execution_profile_id: profile,
            workspace_root,
            binding_version: version,
        },
        host_device_id: device,
        requirements_version: requirements,
        content_version: content,
        config,
        owner,
    })
}

fn actions(connection: &Connection, session_id: &str) -> Result<Vec<DispatchActionRecord>, String> {
    let mut statement = connection.prepare(&format!("SELECT {ACTION_COLUMNS} FROM dispatch_actions WHERE session_id=?1 AND idempotency_key LIKE 'native-codex:v1:%' ORDER BY created_at DESC,id DESC LIMIT 100"))
        .map_err(|error| error.to_string())?;
    let mut result = statement
        .query_map([session_id], row_to_dispatch_action)
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    result.reverse();
    Ok(result)
}

fn run_spec_for_event(
    connection: &Connection,
    session_id: &str,
    turn: &str,
) -> Result<Option<NativeCommandSpec>, String> {
    let mut pending_prompt = None;
    let mut statement = connection.prepare(&format!("SELECT {ACTION_COLUMNS} FROM dispatch_actions WHERE session_id=?1 AND idempotency_key LIKE 'native-codex:v1:%' ORDER BY created_at DESC,rowid DESC"))
        .map_err(|error| error.to_string())?;
    let records = statement
        .query_map([session_id], row_to_dispatch_action)
        .map_err(|error| error.to_string())?;
    for action in records {
        let action = action.map_err(|error| error.to_string())?;
        let spec = read_native_command_spec(&action)?;
        if !matches!(
            spec.intent,
            NativeCodexIntent::Prompt { .. } | NativeCodexIntent::Steer { .. }
        ) {
            continue;
        }
        let accepted_turn = action
            .receipt_ref
            .as_deref()
            .and_then(|receipt| serde_json::from_str::<Value>(receipt).ok())
            .and_then(|receipt| {
                receipt
                    .get("nativeTurnId")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            });
        if accepted_turn.as_deref() == Some(turn) {
            return Ok(Some(spec));
        }
        if pending_prompt.is_none()
            && accepted_turn.is_none()
            && matches!(action.state.as_str(), "dispatched" | "verifying_delivery")
            && matches!(spec.intent, NativeCodexIntent::Prompt { .. })
        {
            pending_prompt = Some(spec);
        }
    }
    Ok(pending_prompt)
}

fn blank_snapshot(binding: &Binding) -> NativeWorkSnapshot {
    NativeWorkSnapshot {
        protocol_version: 1,
        todo_id: binding.todo_id.clone(),
        session_id: binding.binding.session_id.clone(),
        native_thread_id: binding.binding.native_thread_id.clone(),
        source_scope: binding.binding.source_scope.clone(),
        execution_profile_id: binding.binding.execution_profile_id.clone(),
        binding_version: binding.binding.binding_version,
        connection_id: None,
        connection_status: "disconnected".into(),
        runtime_status: "unknown".into(),
        active_turn_id: None,
        capabilities: NativeWorkCapabilities {
            resume: true,
            ..Default::default()
        },
        messages: vec![],
        history_truncated: false,
        commands: vec![],
        decisions: vec![],
        cursor: 0,
        last_event_at: None,
        error: None,
        runtime_version: None,
        admission_wait: None,
    }
}

#[derive(Clone)]
struct Core {
    view: NativeWorkSnapshot,
    terminals: HashMap<String, Value>,
}

impl Core {
    fn prune_terminals(&mut self, newest_turn: &str, pending: &[DispatchActionRecord]) {
        if self.terminals.len() <= 20 {
            return;
        }
        let mut keep = vec![newest_turn.to_string()];
        for action in pending {
            if let Ok(spec) = read_native_command_spec(action) {
                keep.extend(spec.expected.native_turn_id);
            }
            if let Some(turn) = action
                .receipt_ref
                .as_deref()
                .and_then(|receipt| serde_json::from_str::<Value>(receipt).ok())
                .and_then(|receipt| {
                    receipt
                        .get("nativeTurnId")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
            {
                keep.push(turn);
            }
        }
        self.terminals.retain(|turn, _| keep.contains(turn));
    }
}

fn validate_resumed_workspace(expected: &str, thread: &Value) -> Result<(), String> {
    let actual = thread
        .get("cwd")
        .and_then(Value::as_str)
        .ok_or("原端恢复缺少工作目录，尚未开放控制")?;
    let expected = std::fs::canonicalize(expected).map_err(|_| "授权工作目录已不存在")?;
    if std::fs::canonicalize(actual).ok().as_ref() != Some(&expected) {
        return Err("原端恢复的工作目录与交接授权不同，已拒绝开放控制".into());
    }
    Ok(())
}

struct NativeConnection {
    app: tauri::AppHandle,
    account_scope: String,
    db: Arc<Mutex<Connection>>,
    binding: Binding,
    core: Mutex<Core>,
    rpc: OnceLock<Arc<NativeCodexRpc>>,
    process_id: OnceLock<String>,
    resume_action_id: OnceLock<String>,
    closed: AtomicBool,
    sequence: AtomicI64,
    profile_fingerprint: String,
    resource_directory: PathBuf,
    _resource_owner_guard: std::fs::File,
}

impl NativeConnection {
    fn event(
        &self,
        event_type: &str,
        payload: Value,
        turn_id: Option<String>,
        action: Option<&DispatchActionRecord>,
    ) -> Result<RuntimeEvent, String> {
        let spec = action.map(read_native_command_spec).transpose()?;
        Ok(RuntimeEvent {
            sequence: 0,
            todo_id: self.binding.todo_id.clone(),
            session_id: self.binding.binding.session_id.clone(),
            action_id: action.map(|action| action.id.clone()),
            event_type: event_type.into(),
            connection_id: self
                .core
                .lock()
                .map_err(|_| "原生投影不可用")?
                .view
                .connection_id
                .clone()
                .ok_or("原生连接身份缺失")?,
            connection_sequence: self.sequence.fetch_add(1, Ordering::Relaxed),
            native_thread_id: self.binding.binding.native_thread_id.clone(),
            native_turn_id: turn_id,
            requirements_version: spec
                .as_ref()
                .map_or(self.binding.requirements_version, |spec| {
                    spec.expected.requirements_version
                }),
            content_version: spec.as_ref().map_or(self.binding.content_version, |spec| {
                spec.expected.content_version
            }),
            payload,
            received_at: 0,
        })
    }

    fn persist(&self, connection: &Connection, core: &mut Core) -> Result<(), String> {
        core.view.commands = actions(connection, &self.binding.binding.session_id)?;
        core.view.cursor = connection
            .query_row(
                "SELECT COALESCE(MAX(sequence),0) FROM work_runtime_events",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        persist_snapshot(connection, &self.binding, &core.view)
    }

    fn notify(&self, cursor: i64) {
        let _ = self.app.emit("native-work-updated",json!({"accountScope":self.account_scope,"todoId":self.binding.todo_id,"sessionId":self.binding.binding.session_id,"cursor":cursor}));
    }
}

fn persist_snapshot(
    connection: &Connection,
    binding: &Binding,
    view: &NativeWorkSnapshot,
) -> Result<(), String> {
    connection.execute("INSERT INTO work_runtime_snapshots(session_id,snapshot_json,updated_at)
          SELECT ?1,?2,?3 WHERE EXISTS(SELECT 1 FROM work_sessions WHERE id=?1 AND runtime_owner='native_host' AND binding_version=?4)
          ON CONFLICT(session_id) DO UPDATE SET snapshot_json=excluded.snapshot_json,updated_at=excluded.updated_at",
            params![binding.binding.session_id,serde_json::to_string(view).map_err(|error| error.to_string())?,now_millis(),binding.binding.binding_version]).map_err(|error| error.to_string())?;
    connection.execute("UPDATE work_sessions SET runtime_status=?2,last_turn_id=COALESCE(?3,last_turn_id),last_event_seq=?4,last_verified_at=?5
            WHERE id=?1 AND runtime_owner='native_host' AND binding_version=?6",
            params![binding.binding.session_id,view.runtime_status,view.active_turn_id,view.cursor,now_millis(),binding.binding.binding_version])
            .map_err(|error| error.to_string())?;
    Ok(())
}

fn claim_with_resources(
    connection: &Connection,
    directory: &Path,
    action_id: &str,
    owner: Option<&ReservationOwner>,
) -> Result<Option<NativeWorkAdmissionWait>, String> {
    if let Some(owner) = owner {
        if let Admission::Deferred(wait) = butler_native_admission::reserve(directory, owner)? {
            return Ok(Some(wait));
        }
    }
    if let Err(error) = claim_native_command(connection, action_id) {
        // A failed CAS is not evidence that another dispatcher did not send.
        // Only an action still unclaimed is safe to release.
        if read_native_command(connection, action_id)?.state == "prepared" {
            if let Some(owner) = owner {
                butler_native_admission::release_not_sent(directory, owner)?;
            }
        }
        return Err(error);
    }
    Ok(None)
}

fn release_settled_resources(
    connection: &Connection,
    directory: &Path,
    account: &str,
    session: &str,
) -> Result<(), String> {
    if !connection.is_autocommit() {
        return Err("原端结束事实尚未持久提交，保留执行资源".into());
    }
    for owner in butler_native_admission::session_reservations(directory, account, session)? {
        // Snapshot-only entries require the explicit cold recovery path.
        // Old connection owners can be released only when
        // the original immutable action records a verified terminal turn.
        let Ok(action) = read_native_command(connection, owner.action_id()) else {
            continue;
        };
        let spec = read_native_command_spec(&action)?;
        if !owner.matches_command(&action.id, &spec) {
            continue;
        }
        if !matches!(action.state.as_str(), "completed" | "failed") {
            continue;
        }
        let definitively_unaccepted: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM work_runtime_events WHERE action_id=?1
             AND native_thread_id=?2 AND requirements_version=?3 AND content_version=?4
             AND ((event_type='rpc/notSent' AND json_extract(payload_json,'$.writeAttempted')=0)
                  OR (event_type='rpc/rejected' AND json_extract(payload_json,'$.error.code') IN(-32600,-32601,-32602))))",
            params![action.id,spec.binding.native_thread_id,spec.expected.requirements_version,spec.expected.content_version],
            |row| row.get(0),
        ).map_err(|error| error.to_string())?;
        if action.state == "failed" && definitively_unaccepted {
            butler_native_admission::release_not_sent(directory, &owner)?;
            continue;
        }
        if action.state == "completed" && matches!(spec.intent, NativeCodexIntent::Resume { .. }) {
            let verified_resume: bool = connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM work_runtime_events WHERE action_id=?1 AND event_type='thread/resumed'
                 AND native_thread_id=?2 AND json_extract(payload_json,'$.thread.id')=?2
                 AND json_extract(payload_json,'$.thread.status.type')='idle')",
                params![action.id,spec.binding.native_thread_id], |row| row.get(0),
            ).map_err(|error| error.to_string())?;
            if verified_resume {
                butler_native_admission::release_not_sent(directory, &owner)?;
                continue;
            }
        }
        let Some(receipt) = action
            .receipt_ref
            .as_deref()
            .and_then(|receipt| serde_json::from_str::<Value>(receipt).ok())
        else {
            continue;
        };
        if receipt.get("nativeThreadId").and_then(Value::as_str)
            != Some(spec.binding.native_thread_id.as_str())
        {
            continue;
        }
        if !matches!(
            receipt.get("terminalStatus").and_then(Value::as_str),
            Some("completed" | "failed" | "interrupted")
        ) {
            continue;
        }
        let Some(turn) = receipt.get("nativeTurnId").and_then(Value::as_str) else {
            continue;
        };
        butler_native_admission::accepted(directory, &owner, turn)?;
        butler_native_admission::release_terminal(directory, &owner, turn)?;
    }
    Ok(())
}

struct ColdResourceRecovery {
    owner: ReservationOwner,
    action: Option<DispatchActionRecord>,
    turn: Option<String>,
    _old_owner_guard: Option<std::fs::File>,
}

fn prepare_cold_resource_recovery(
    connection: &Connection,
    directory: &Path,
    account: &str,
    binding: &NativeCommandBinding,
    restored_thread: &Value,
) -> Result<Vec<ColdResourceRecovery>, String> {
    if restored_thread.get("id").and_then(Value::as_str) != Some(&binding.native_thread_id) {
        return Err("恢复资源的原线程身份不一致".into());
    }
    validate_resumed_workspace(&binding.workspace_root, restored_thread)?;
    // Missing/unknown status is not an idle proof. This runs only after the
    // existing explicit cold handoff, never as a periodic timeout cleanup.
    if restored_thread
        .pointer("/status/type")
        .and_then(Value::as_str)
        != Some("idle")
    {
        return Ok(Vec::new());
    }
    if restored_thread
        .get("turns")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .any(|turn| turn.get("status").and_then(Value::as_str) == Some("inProgress"))
    {
        return Ok(Vec::new());
    }
    let mut result = Vec::new();
    for owner in
        butler_native_admission::session_reservations(directory, account, &binding.session_id)?
    {
        if !owner.matches_restored_binding(account, binding) {
            continue;
        }
        if let Ok(action) = read_native_command(connection, owner.action_id()) {
            let spec = read_native_command_spec(&action)?;
            if action.state == "prepared"
                && action.receipt_ref.is_none()
                && matches!(spec.intent, NativeCodexIntent::Prompt { .. })
                && owner.matches_command(&action.id, &spec)
            {
                if let Some(guard) = butler_native_admission::recovery_guard(directory, &owner)? {
                    result.push(ColdResourceRecovery {
                        owner,
                        action: Some(action),
                        turn: None,
                        _old_owner_guard: Some(guard),
                    });
                }
            }
        } else if owner.is_snapshot_recovery() {
            // Historical T being terminal does not exclude Q already claimed
            // by the old dispatcher but not yet written to RPC. The new binding
            // fences future old claims; existing claims still need reconciliation.
            let unresolved_writer: bool = connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM dispatch_actions WHERE session_id=?1
                 AND idempotency_key LIKE 'native-codex:v1:%' AND action_kind IN('session_prompt','session_steer','session_interrupt')
                 AND state IN('dispatched','acknowledged','verifying_delivery'))",
                [&binding.session_id], |row| row.get(0),
            ).map_err(|error| error.to_string())?;
            if unresolved_writer {
                continue;
            }
            let turn = butler_native_admission::reserved_turn(directory, &owner)?;
            if let Some(turn) = &turn {
                let terminal = restored_thread
                    .get("turns")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .any(|record| {
                        record.get("id").and_then(Value::as_str) == Some(turn)
                            && matches!(
                                record.get("status").and_then(Value::as_str),
                                Some("completed" | "failed" | "interrupted")
                            )
                    });
                if !terminal {
                    continue;
                }
                // Exact terminal turn evidence can reconcile a legacy snapshot;
                // a versioned owner must additionally yield its lifetime handle.
                let guard = butler_native_admission::recovery_guard(directory, &owner)?;
                result.push(ColdResourceRecovery {
                    owner,
                    action: None,
                    turn: Some(turn.clone()),
                    _old_owner_guard: guard,
                });
            } else {
                if let Some(guard) = butler_native_admission::recovery_guard(directory, &owner)? {
                    result.push(ColdResourceRecovery {
                        owner,
                        action: None,
                        turn: None,
                        _old_owner_guard: Some(guard),
                    });
                }
            }
        }
    }
    Ok(result)
}

fn persist_cold_resource_recovery(
    connection: &Connection,
    current: &Binding,
    connection_id: &str,
    sequence: &AtomicI64,
    recovery: &[ColdResourceRecovery],
) -> Result<(), String> {
    for recovered in recovery {
        let spec = recovered
            .action
            .as_ref()
            .map(read_native_command_spec)
            .transpose()?;
        let event = RuntimeEvent {
            sequence: 0,
            todo_id: current.todo_id.clone(),
            session_id: current.binding.session_id.clone(),
            action_id: recovered.action.as_ref().map(|action| action.id.clone()),
            event_type: if recovered.action.is_some() {
                "rpc/notSent"
            } else {
                "runtime/resourceReconciled"
            }
            .into(),
            connection_id: connection_id.into(),
            connection_sequence: sequence.fetch_add(1, Ordering::Relaxed),
            native_thread_id: current.binding.native_thread_id.clone(),
            native_turn_id: recovered.turn.clone(),
            requirements_version: spec.as_ref().map_or(current.requirements_version, |spec| {
                spec.expected.requirements_version
            }),
            content_version: spec.as_ref().map_or(current.content_version, |spec| {
                spec.expected.content_version
            }),
            payload: if recovered.action.is_some() {
                json!({"writeAttempted":false,"reason":"已核实旧归属释放，原线程冷恢复为空闲；原未认领指令没有发送",
                    "reservationActionId":recovered.owner.action_id()})
            } else {
                json!({"reason":"原线程冷恢复完成，原占用结束事实已核实",
                    "reservationActionId":recovered.owner.action_id(),"verifiedNativeTurnId":recovered.turn})
            },
            received_at: 0,
        };
        if let Some(action) = &recovered.action {
            apply_native_receipt(connection, &action.id, RuntimeCommandState::Failed, &event)?;
        } else {
            append_runtime_event(connection, &event)?;
        }
    }
    Ok(())
}

fn release_cold_resources(
    connection: &Connection,
    directory: &Path,
    recovery: &[ColdResourceRecovery],
) -> Result<(), String> {
    if !connection.is_autocommit() {
        return Err("恢复核对事实尚未提交，保留执行资源".into());
    }
    for recovered in recovery {
        if let Some(turn) = &recovered.turn {
            butler_native_admission::release_terminal(directory, &recovered.owner, turn)?;
        } else {
            butler_native_admission::release_not_sent(directory, &recovered.owner)?;
        }
    }
    Ok(())
}

impl NativeConnection {
    fn set_admission_wait(&self, wait: Option<NativeWorkAdmissionWait>) -> Result<(), String> {
        let connection = self.db.lock().map_err(|_| "原生账号数据库不可用")?;
        let mut core = self.core.lock().map_err(|_| "原生投影不可用")?;
        if core.view.admission_wait == wait {
            return Ok(());
        }
        core.view.admission_wait = wait;
        self.persist(&connection, &mut core)?;
        let cursor = core.view.cursor;
        drop(core);
        drop(connection);
        self.notify(cursor);
        Ok(())
    }

    // The caller must have committed the enclosing account transaction first.
    // Host release failure leaves a conservative reservation, never a free slot.
    fn release_settled_reservations(&self, connection: &Connection) -> Result<(), String> {
        release_settled_resources(
            connection,
            &self.resource_directory,
            &self.account_scope,
            &self.binding.binding.session_id,
        )
    }

    fn finish_known_turns(&self, connection: &Connection, core: &Core) -> Result<(), String> {
        for action in list_native_session_commands(connection, &self.binding.binding.session_id)? {
            if action.state == "prepared" {
                continue;
            }
            let spec = read_native_command_spec(&action)?;
            let turn = action
                .receipt_ref
                .as_deref()
                .and_then(|value| serde_json::from_str::<Value>(value).ok())
                .and_then(|value| {
                    value
                        .get("nativeTurnId")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .or(spec.expected.native_turn_id.clone());
            let Some(params) = turn.as_ref().and_then(|turn| core.terminals.get(turn)) else {
                continue;
            };
            let interrupted_command = matches!(spec.intent, NativeCodexIntent::Interrupt { .. });
            if !interrupted_command && action.receipt_ref.is_none() {
                continue;
            }
            let next = if interrupted_command
                || params.pointer("/turn/status").and_then(Value::as_str) == Some("completed")
            {
                RuntimeCommandState::Completed
            } else {
                RuntimeCommandState::Failed
            };
            // Create without taking core's mutex: callers already hold the projection lock.
            let event = RuntimeEvent {
                sequence: 0,
                todo_id: spec.todo_id.clone(),
                session_id: spec.binding.session_id.clone(),
                action_id: Some(action.id.clone()),
                event_type: "turn/completed".into(),
                connection_id: core.view.connection_id.clone().ok_or("原生连接身份缺失")?,
                connection_sequence: self.sequence.fetch_add(1, Ordering::Relaxed),
                native_thread_id: spec.binding.native_thread_id.clone(),
                native_turn_id: turn,
                requirements_version: spec.expected.requirements_version,
                content_version: spec.expected.content_version,
                payload: params.clone(),
                received_at: 0,
            };
            apply_native_receipt(connection, &action.id, next, &event)?;
        }
        Ok(())
    }

    fn receive(&self, inbound: InboundMessage) {
        let disconnected = matches!(&inbound, InboundMessage::Disconnected { .. });
        let publish_work_update = match &inbound {
            InboundMessage::Notification { method, .. } => {
                matches!(method.as_str(), "turn/started" | "turn/completed")
            }
            _ => true,
        };
        if self.closed.load(Ordering::Acquire) && !disconnected {
            return;
        }
        let result = (|| -> Result<i64, String> {
            let (method, payload, turn) = match &inbound {
                InboundMessage::Notification { method, params } => {
                    if params.get("threadId").and_then(Value::as_str)
                        != Some(&self.binding.binding.native_thread_id)
                    {
                        return Ok(0);
                    }
                    (
                        method.clone(),
                        params.clone(),
                        params
                            .get("turnId")
                            .and_then(Value::as_str)
                            .or_else(|| params.pointer("/turn/id").and_then(Value::as_str))
                            .map(str::to_string),
                    )
                }
                InboundMessage::ServerRequest { id, method, params } => {
                    if params.get("threadId").and_then(Value::as_str)
                        != Some(&self.binding.binding.native_thread_id)
                        || !supported_decision_method(method)
                    {
                        if let Some(rpc) = self.rpc.get() {
                            rpc.reject(id, -32601, "RocketX 原生工作后台暂不支持此请求")
                                .map_err(|error| error.to_string())?;
                        }
                        return Ok(0);
                    }
                    (
                        method.clone(),
                        params.clone(),
                        params
                            .get("turnId")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                    )
                }
                InboundMessage::Disconnected { reason } => (
                    "runtime/disconnected".into(),
                    json!({"reason":reason}),
                    None,
                ),
            };
            let mut event = self.event(&method, payload.clone(), turn.clone(), None)?;
            let terminal_fact = method == "turn/completed";
            let connection = self.db.lock().map_err(|_| "原生账号数据库不可用")?;
            if let Some(turn) = &turn {
                if let Some(spec) =
                    run_spec_for_event(&connection, &self.binding.binding.session_id, turn)?
                {
                    event.requirements_version = spec.expected.requirements_version;
                    event.content_version = spec.expected.content_version;
                }
            }
            let mut core = self.core.lock().map_err(|_| "原生工作投影不可用")?;
            let original = core.clone();
            connection
                .execute_batch("SAVEPOINT native_work_fact;")
                .map_err(|error| error.to_string())?;
            let result = (|| -> Result<(), String> {
                append_runtime_event(&connection, &event)?;
                core.view.last_event_at = Some(now_millis());
                match &inbound {
                    InboundMessage::Notification { .. } => {
                        core.view.apply_notification(&method, &payload);
                        if method == "turn/completed" {
                            if let Some(turn) = &turn {
                                core.terminals.insert(turn.clone(), payload);
                            }
                        }
                        self.finish_known_turns(&connection, &core)?;
                        if method == "turn/completed" {
                            if let Some(turn) = &turn {
                                let pending = list_native_session_commands(
                                    &connection,
                                    &self.binding.binding.session_id,
                                )?;
                                core.prune_terminals(turn, &pending);
                            }
                        }
                    }
                    InboundMessage::ServerRequest { id, .. } => {
                        let turn = turn.ok_or("原生问题缺少轮次身份")?;
                        let requirements = list_native_session_commands(
                            &connection,
                            &self.binding.binding.session_id,
                        )?
                        .into_iter()
                        .rev()
                        .find_map(|action| {
                            if !matches!(action.state.as_str(), "dispatched" | "acknowledged") {
                                return None;
                            }
                            let spec = read_native_command_spec(&action).ok()?;
                            if !matches!(
                                spec.intent,
                                NativeCodexIntent::Prompt { .. } | NativeCodexIntent::Steer { .. }
                            ) {
                                return None;
                            }
                            let accepted = action
                                .receipt_ref
                                .as_deref()
                                .and_then(|value| serde_json::from_str::<Value>(value).ok())
                                .and_then(|value| {
                                    value
                                        .get("nativeTurnId")
                                        .and_then(Value::as_str)
                                        .map(str::to_string)
                                });
                            if accepted.as_deref() == Some(turn.as_str())
                                || (action.state == "dispatched"
                                    && accepted.is_none()
                                    && matches!(spec.intent, NativeCodexIntent::Prompt { .. }))
                            {
                                Some(spec.expected.requirements_version)
                            } else {
                                None
                            }
                        })
                        .ok_or("原生问题没有已接纳的本工作运行，不能扩大为当前要求的授权")?;
                        core.view.decisions.push(NativeWorkDecision {
                            id: uuid::Uuid::new_v4().to_string(),
                            native_request_id: id.clone(),
                            method,
                            native_thread_id: self.binding.binding.native_thread_id.clone(),
                            native_turn_id: turn.clone(),
                            requirements_version: requirements,
                            binding_version: self.binding.binding.binding_version,
                            state: "pending".into(),
                            params: payload,
                            created_at: now_millis(),
                        });
                        core.view.active_turn_id = Some(turn);
                        core.view.runtime_status = if matches!(
                            core.view
                                .decisions
                                .last()
                                .map(|decision| decision.method.as_str()),
                            Some("item/tool/requestUserInput")
                        ) {
                            "waiting_input"
                        } else {
                            "waiting_approval"
                        }
                        .into();
                    }
                    InboundMessage::Disconnected { reason } => {
                        self.closed.store(true, Ordering::Release);
                        core.view.disconnected(reason);
                        for action in list_native_session_commands(
                            &connection,
                            &self.binding.binding.session_id,
                        )? {
                            if !matches!(action.state.as_str(), "dispatched" | "acknowledged") {
                                continue;
                            }
                            let spec = read_native_command_spec(&action)?;
                            let mut unknown = event.clone();
                            unknown.action_id = Some(action.id.clone());
                            unknown.requirements_version = spec.expected.requirements_version;
                            unknown.content_version = spec.expected.content_version;
                            unknown.connection_sequence =
                                self.sequence.fetch_add(1, Ordering::Relaxed);
                            unknown.native_turn_id = spec.expected.native_turn_id;
                            apply_native_receipt(
                                &connection,
                                &action.id,
                                RuntimeCommandState::VerifyingDelivery,
                                &unknown,
                            )?;
                        }
                    }
                }
                self.persist(&connection, &mut core)
            })();
            match result {
                Ok(()) => {
                    connection
                        .execute_batch("RELEASE native_work_fact;")
                        .map_err(|error| error.to_string())?;
                    if terminal_fact {
                        self.release_settled_reservations(&connection)?;
                    }
                    Ok(core.view.cursor)
                }
                Err(error) => {
                    let _ = connection
                        .execute_batch("ROLLBACK TO native_work_fact; RELEASE native_work_fact;");
                    *core = original;
                    Err(error)
                }
            }
        })();
        match result {
            Ok(cursor) if cursor > 0 && publish_work_update => self.notify(cursor),
            Ok(_) => {}
            Err(error) => {
                self.closed.store(true, Ordering::Release);
                if let Ok(mut core) = self.core.lock() {
                    core.view
                        .disconnected(&format!("无法保存原生工作事实：{error}"));
                }
                if let Some(rpc) = self.rpc.get() {
                    rpc.disconnect("无法保存原生工作事实，已停止新派发");
                }
            }
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeWorkSnapshotInput {
    account: RuntimeAccountContext,
    session_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeWorkResumeInput {
    account: RuntimeAccountContext,
    session_id: String,
    todo_id: String,
    expected_requirements_version: i64,
    expected_content_version: i64,
    expected_binding_version: i64,
    authorization: NativeResumeAuthorization,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeWorkSubmitInput {
    account: RuntimeAccountContext,
    command: RuntimeCommandInput,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeWorkAnswerInput {
    account: RuntimeAccountContext,
    session_id: String,
    decision_id: String,
    expected_binding_version: i64,
    expected_requirements_version: i64,
    native_turn_id: String,
    answer: Value,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeWorkCancelQueuedInput {
    account: RuntimeAccountContext,
    session_id: String,
    request_id: String,
}

fn connection_key(account: &RuntimeAccountContext, session_id: &str) -> String {
    format!("{}\0{session_id}", account.account_scope)
}

fn stored_snapshot(
    connection: &Connection,
    binding: &Binding,
) -> Result<NativeWorkSnapshot, String> {
    let stored: Option<String> = connection
        .query_row(
            "SELECT snapshot_json FROM work_runtime_snapshots WHERE session_id=?1",
            [&binding.binding.session_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let mut view = match stored {
        Some(stored) => serde_json::from_str::<NativeWorkSnapshot>(&stored)
            .map_err(|_| "原生工作快照损坏，不能以空状态替代")?,
        None => blank_snapshot(binding),
    };
    if view.protocol_version != 1
        || view.session_id != binding.binding.session_id
        || view.native_thread_id != binding.binding.native_thread_id
        || view.todo_id != binding.todo_id
        || view.source_scope != binding.binding.source_scope
        || view.execution_profile_id != binding.binding.execution_profile_id
    {
        return Err("原生快照与当前工作身份不兼容".into());
    }
    view.binding_version = binding.binding.binding_version;
    view.commands = actions(connection, &binding.binding.session_id)?;
    view.cursor = connection
        .query_row(
            "SELECT COALESCE(MAX(sequence),0) FROM work_runtime_events",
            [],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    Ok(view)
}

#[tauri::command]
pub async fn butler_native_work_snapshot(
    app: tauri::AppHandle,
    db: tauri::State<'_, ButlerDb>,
    runtime: tauri::State<'_, NativeWorkRuntime>,
    input: NativeWorkSnapshotInput,
) -> Result<NativeWorkSnapshot, String> {
    let admitted = db.connection_for_context(&input.account)?;
    let native = runtime
        .connections
        .lock()
        .map_err(|_| "原生工作注册表不可用")?
        .get(&connection_key(&input.account, &input.session_id))
        .cloned();
    if let Some(native) = native {
        let connection = admitted.lock().map_err(|_| "账号数据库不可用")?;
        let current = binding(&connection, &input.session_id, &input.account.account_scope)?;
        if current.binding.binding_version == native.binding.binding.binding_version {
            let mut view = native
                .core
                .lock()
                .map_err(|_| "原生投影不可用")?
                .view
                .clone();
            view.commands = actions(&connection, &input.session_id)?;
            return Ok(view);
        }
    }
    let connection = admitted.lock().map_err(|_| "账号数据库不可用")?;
    let current = binding(&connection, &input.session_id, &input.account.account_scope)?;
    let mut view = stored_snapshot(&connection, &current)?;
    if matches!(view.connection_status.as_str(), "connected" | "connecting") {
        view.disconnected("后台连接已结束；上次投递结果需核对，不会自动重发");
        connection.execute("UPDATE work_sessions SET runtime_status='unknown' WHERE id=?1 AND runtime_owner='native_host'",[&input.session_id]).map_err(|error|error.to_string())?;
    }
    view.capabilities.resume =
        crate::acp::native_codex_profile(&app, &current.binding.execution_profile_id).is_ok();
    Ok(view)
}

fn claim_binding(
    connection: &Connection,
    current: &Binding,
    expected: i64,
) -> Result<Binding, String> {
    let mut claimed = current.clone();
    claimed.binding.binding_version = expected.checked_add(1).ok_or("绑定版本已耗尽")?;
    claimed.owner = "native_host".into();
    claimed
        .config
        .as_object_mut()
        .ok_or("原会话配置不是对象")?
        .insert(
            "executionProfileId".into(),
            json!(claimed.binding.execution_profile_id),
        );
    claimed.config.as_object_mut().ok_or("原会话配置不是对象")?.insert("nativeHost".into(),json!({"schema":"rocketx.native-codex-binding.v1","owner":"native_host","bindingVersion":claimed.binding.binding_version}));
    let changed=connection.execute("UPDATE work_sessions SET runtime_owner='native_host',binding_version=?2,config_snapshot_json=?3,
        control_mode='readonly',control_reason='native_connecting',control_endpoint=NULL,runtime_status='unknown' WHERE id=?1 AND binding_version=?4",
        params![current.binding.session_id,claimed.binding.binding_version,claimed.config.to_string(),expected]).map_err(|error|error.to_string())?;
    if changed != 1 {
        return Err("原会话绑定已经变化，请刷新后再交接".into());
    }
    Ok(claimed)
}

#[tauri::command]
pub async fn butler_native_work_resume(
    app: tauri::AppHandle,
    db: tauri::State<'_, ButlerDb>,
    runtime: tauri::State<'_, NativeWorkRuntime>,
    input: NativeWorkResumeInput,
) -> Result<NativeWorkSnapshot, String> {
    let admitted = db.connection_for_context(&input.account)?;
    let key = connection_key(&input.account, &input.session_id);
    let current = {
        let connection = admitted.lock().map_err(|_| "账号数据库不可用")?;
        binding(&connection, &input.session_id, &input.account.account_scope)?
    };
    if current.todo_id != input.todo_id
        || current.requirements_version != input.expected_requirements_version
        || current.content_version != input.expected_content_version
        || current.binding.binding_version != input.expected_binding_version
    {
        return Err("工作要求或会话绑定已变化，请刷新后再交接".into());
    }
    if input.authorization.account_scope != input.account.account_scope
        || input.authorization.host_device_id != current.host_device_id
        || input.authorization.session_id != current.binding.native_thread_id
        || input.authorization.source_scope != current.binding.source_scope
    {
        return Err("交接授权与原工作、账号、设备或来源不一致".into());
    }
    let profile = crate::acp::native_codex_profile(&app, &current.binding.execution_profile_id)?;
    if profile.source_scope != current.binding.source_scope {
        return Err("执行配置已指向其他来源，不能恢复原会话".into());
    }
    let profile_fingerprint = profile.fingerprint().to_string();
    let native = {
        let mut connections = runtime
            .connections
            .lock()
            .map_err(|_| "原生工作注册表不可用")?;
        if let Some(existing) = connections.get(&key) {
            if !existing.closed.load(Ordering::Acquire) {
                return Ok(existing
                    .core
                    .lock()
                    .map_err(|_| "原生投影不可用")?
                    .view
                    .clone());
            }
        }
        let connection = admitted.lock().map_err(|_| "账号数据库不可用")?;
        connection
            .execute_batch("SAVEPOINT native_work_admit;")
            .map_err(|error| error.to_string())?;
        let admission = (|| -> Result<Arc<NativeConnection>, String> {
            let claimed = claim_binding(&connection, &current, input.expected_binding_version)?;
            let mut view = stored_snapshot(&connection, &current)?;
            view.binding_version = claimed.binding.binding_version;
            view.connection_id = Some(uuid::Uuid::new_v4().to_string());
            view.connection_status = "connecting".into();
            view.runtime_status = "unknown".into();
            view.capabilities = NativeWorkCapabilities::default();
            view.error = None;
            view.admission_wait = None;
            for decision in &mut view.decisions {
                if decision.state == "pending" {
                    decision.state = "expired".into();
                }
            }
            let resource_owner_guard = butler_native_admission::connection_guard(
                &db.directory,
                view.connection_id.as_deref().ok_or("连接身份缺失")?,
            )?;
            let native = Arc::new(NativeConnection {
                app: app.clone(),
                account_scope: input.account.account_scope.clone(),
                db: Arc::clone(&admitted),
                binding: claimed,
                core: Mutex::new(Core {
                    view,
                    terminals: HashMap::new(),
                }),
                rpc: OnceLock::new(),
                process_id: OnceLock::new(),
                resume_action_id: OnceLock::new(),
                closed: AtomicBool::new(false),
                sequence: AtomicI64::new(1),
                profile_fingerprint,
                resource_directory: db.directory.clone(),
                _resource_owner_guard: resource_owner_guard,
            });
            let connection_id = native
                .core
                .lock()
                .map_err(|_| "原生投影不可用")?
                .view
                .connection_id
                .clone()
                .ok_or("连接身份缺失")?;
            let action = prepare_native_command(
                &connection,
                &input.account,
                native.binding.host_device_id.clone(),
                native.binding.binding.clone(),
                RuntimeCommandInput {
                    request_id: format!("resume-{connection_id}"),
                    todo_id: native.binding.todo_id.clone(),
                    session_id: native.binding.binding.session_id.clone(),
                    expected_requirements_version: native.binding.requirements_version,
                    expected_content_version: native.binding.content_version,
                    expected_binding_version: native.binding.binding.binding_version,
                    native_turn_id: None,
                    queue_after_turn: false,
                    intent: NativeCodexIntent::Resume {},
                    submitted_by: CommandSubmitter::User,
                },
            )?;
            claim_native_command(&connection, &action.id)?;
            native
                .resume_action_id
                .set(action.id)
                .map_err(|_| "恢复命令已登记")?;
            native.persist(
                &connection,
                &mut *native.core.lock().map_err(|_| "原生投影不可用")?,
            )?;
            Ok(native)
        })();
        let native = match admission {
            Ok(native) => {
                connection
                    .execute_batch("RELEASE native_work_admit;")
                    .map_err(|error| error.to_string())?;
                native
            }
            Err(error) => {
                let _ = connection
                    .execute_batch("ROLLBACK TO native_work_admit; RELEASE native_work_admit;");
                return Err(error);
            }
        };
        connections.insert(key, Arc::clone(&native));
        native
    };
    let weak = Arc::downgrade(&native);
    let started=async {
        db.connection_for_context(&input.account)?;
        let handle=crate::proc::open_native_codex(app.clone(),format!("native-work-{}",uuid::Uuid::new_v4()),native.binding.binding.workspace_root.clone(),profile,input.authorization,
            move|inbound|{if let Some(native)=weak.upgrade(){native.receive(inbound);}}).await?;
        native.process_id.set(handle.info.process_id.clone()).map_err(|_|"原生进程已注册")?;
        native.rpc.set(Arc::clone(&handle.rpc)).map_err(|_|"原生连接已注册")?;
        db.connection_for_context(&input.account)?;
        let rpc=Arc::clone(&handle.rpc);let workspace=native.binding.binding.workspace_root.clone();let thread_id=native.binding.binding.native_thread_id.clone();
        let resumed=tauri::async_runtime::spawn_blocking(move||->Result<Value,String>{
            rpc.request("initialize",json!({"clientInfo":{"name":"rocketx_native_work","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":true}}),Duration::from_secs(20)).map_err(|error|error.to_string())?;
            rpc.notify("initialized",json!({})).map_err(|error|error.to_string())?;
            rpc.request("thread/resume",json!({"threadId":thread_id,"cwd":workspace}),Duration::from_secs(30)).map_err(|error|error.to_string())
        }).await.map_err(|error|error.to_string())??;
        let resumed_thread=resumed.get("thread").ok_or("原端恢复没有返回会话")?;
        if resumed_thread.get("id").and_then(Value::as_str)!=Some(&native.binding.binding.native_thread_id){return Err("原端返回了另一条会话，已拒绝替代恢复".into());}
        validate_resumed_workspace(&native.binding.binding.workspace_root,resumed_thread)?;
        if resumed_thread.pointer("/status/type").and_then(Value::as_str)==Some("active") {return Err("原端仍有活动执行；首版仅支持停止原端后交接，不支持抢占实时会话".into());}
        let connection=native.db.lock().map_err(|_|"原生账号数据库不可用")?;
        let mut core=native.core.lock().map_err(|_|"原生投影不可用")?;
        core.view.load_thread(resumed_thread)?;
        for turn in resumed_thread.get("turns").and_then(Value::as_array).into_iter().flatten() {
            if let (Some(id),Some(status))=(turn.get("id").and_then(Value::as_str),turn.get("status").and_then(Value::as_str)) {
                if matches!(status,"completed"|"failed"|"interrupted") {core.terminals.insert(id.into(),json!({"threadId":native.binding.binding.native_thread_id,"turn":turn}));}
            }
        }
        let control_verified=matches!(handle.info.version.as_str(),"0.144.4"|"0.165.0");
        core.view.runtime_version=Some(handle.info.version.clone());core.view.connection_status="connected".into();
        core.view.capabilities=NativeWorkCapabilities {resume:false,prompt:control_verified,steer:control_verified,interrupt:control_verified,answer:control_verified,external_live_attach:false};
        if !control_verified {core.view.error=Some(format!("Codex {} 尚未验证写控制；已载入原记录，暂不开放发送",handle.info.version));}
        let recovered_resources=prepare_cold_resource_recovery(&connection,&native.resource_directory,&native.account_scope,&native.binding.binding,resumed_thread)?;
        connection.execute_batch("SAVEPOINT native_work_resume;").map_err(|error|error.to_string())?;
        let result=(||->Result<(),String>{
            let action=read_native_command(&connection,native.resume_action_id.get().ok_or("恢复命令尚未登记")?)?;
            let event=RuntimeEvent {sequence:0,todo_id:native.binding.todo_id.clone(),session_id:native.binding.binding.session_id.clone(),action_id:Some(action.id.clone()),event_type:"thread/resumed".into(),
                connection_id:core.view.connection_id.clone().ok_or("连接身份缺失")?,connection_sequence:native.sequence.fetch_add(1,Ordering::Relaxed),native_thread_id:native.binding.binding.native_thread_id.clone(),native_turn_id:None,
                requirements_version:native.binding.requirements_version,content_version:native.binding.content_version,payload:resumed.clone(),received_at:0};
            apply_native_receipt(&connection,&action.id,RuntimeCommandState::Completed,&event)?;
            for pending in list_native_session_commands(&connection,&native.binding.binding.session_id)? {
                let spec=read_native_command_spec(&pending)?;
                if matches!(spec.intent,NativeCodexIntent::Resume {..}) && matches!(pending.state.as_str(),"dispatched"|"acknowledged"|"verifying_delivery") {
                    let mut reconciled=event.clone();reconciled.action_id=Some(pending.id.clone());reconciled.requirements_version=spec.expected.requirements_version;
                    reconciled.content_version=spec.expected.content_version;reconciled.connection_sequence=native.sequence.fetch_add(1,Ordering::Relaxed);
                    apply_native_receipt(&connection,&pending.id,RuntimeCommandState::Completed,&reconciled)?;
                }
            }
            native.finish_known_turns(&connection,&core)?;
            persist_cold_resource_recovery(&connection,&native.binding,core.view.connection_id.as_deref().ok_or("连接身份缺失")?,&native.sequence,&recovered_resources)?;
            let metadata=json!({"schema":"rocketx.native-codex-binding.v1","owner":"native_host","bindingVersion":native.binding.binding.binding_version,
                "connectionId":core.view.connection_id,"resourceOwnerGuardVersion":1,
                "runtimeVersion":handle.info.version,"executableFingerprint":handle.executable_fingerprint,"fingerprintScope":handle.executable_fingerprint_scope,"resolvedExecutablePath":handle.resolved_executable_path,"verificationScope":"native-control-v1"});
            connection.execute("UPDATE work_sessions SET config_snapshot_json=json_set(config_snapshot_json,'$.nativeHost',json(?2)),control_mode=?3,
                control_reason='native_host_owned',control_endpoint=?4 WHERE id=?1 AND runtime_owner='native_host' AND binding_version=?5",
                params![native.binding.binding.session_id,metadata.to_string(),if control_verified{"controllable"}else{"readonly"},format!("native-codex://{}",core.view.connection_id.as_deref().unwrap_or_default()),native.binding.binding.binding_version]).map_err(|error|error.to_string())?;
            native.persist(&connection,&mut core)
        })();
        match result {Ok(())=>connection.execute_batch("RELEASE native_work_resume;").map_err(|error|error.to_string())?,Err(error)=>{let _=connection.execute_batch("ROLLBACK TO native_work_resume; RELEASE native_work_resume;");return Err(error);}}
        release_cold_resources(&connection,&native.resource_directory,&recovered_resources)?;
        native.release_settled_reservations(&connection)?;
        Ok::<(),String>(())
    }.await;
    if let Err(error) = started {
        native.closed.store(true, Ordering::Release);
        let stopped = match native.process_id.get() {
            Some(process) => crate::proc::stop_native_codex(&app, process).is_ok(),
            None => true,
        };
        let event = native
            .resume_action_id
            .get()
            .and_then(|id| {
                native
                    .db
                    .lock()
                    .ok()
                    .and_then(|connection| read_native_command(&connection, id).ok())
            })
            .and_then(|action| {
                native
                    .event(
                        if native.process_id.get().is_none() {
                            "rpc/notSent"
                        } else {
                            "runtime/disconnected"
                        },
                        json!({"writeAttempted":false,"reason":error}),
                        None,
                        Some(&action),
                    )
                    .ok()
                    .map(|event| (action, event))
            });
        if let Ok(connection) = native.db.lock() {
            if let Ok(mut core) = native.core.lock() {
                if let Some((action, event)) = event {
                    if matches!(action.state.as_str(), "dispatched" | "acknowledged") {
                        let next = if native.process_id.get().is_none() {
                            RuntimeCommandState::Failed
                        } else {
                            RuntimeCommandState::VerifyingDelivery
                        };
                        let _ = apply_native_receipt(&connection, &action.id, next, &event);
                    }
                }
                core.view.disconnected(&error);
                let _ = native.persist(&connection, &mut core);
                if stopped && current.owner == "legacy" {
                    let _=connection.execute("UPDATE work_sessions SET runtime_owner='legacy',config_snapshot_json=?2,control_mode='readonly',control_reason='native_resume_failed',
                        control_endpoint=NULL,runtime_status='unknown' WHERE id=?1 AND binding_version=?3 AND runtime_owner='native_host'",
                        params![current.binding.session_id,current.config.to_string(),native.binding.binding.binding_version]);
                }
            }
        }
        return Err(error);
    }
    let worker = Arc::clone(&native);
    thread::spawn(move || worker.run());
    let view = native
        .core
        .lock()
        .map_err(|_| "原生投影不可用")?
        .view
        .clone();
    native.notify(view.cursor);
    Ok(view)
}

impl NativeConnection {
    fn profile_current(&self) -> Result<(), String> {
        let current = crate::acp::native_codex_profile(
            &self.app,
            &self.binding.binding.execution_profile_id,
        )?;
        if current.source_scope != self.binding.binding.source_scope
            || current.fingerprint() != self.profile_fingerprint
        {
            return Err("执行配置已变化，已停止新派发；请停止当前轮次并重新交接".into());
        }
        Ok(())
    }

    fn fail_before_write(&self, action: &DispatchActionRecord, reason: &str) -> Result<(), String> {
        let event = self.event(
            "rpc/notSent",
            json!({"writeAttempted":false,"reason":reason}),
            None,
            Some(action),
        )?;
        let connection = self.db.lock().map_err(|_| "原生账号数据库不可用")?;
        let mut core = self.core.lock().map_err(|_| "原生投影不可用")?;
        apply_native_receipt(&connection, &action.id, RuntimeCommandState::Failed, &event)?;
        core.view.error = Some(reason.into());
        self.persist(&connection, &mut core)?;
        let cursor = core.view.cursor;
        drop(core);
        drop(connection);
        self.notify(cursor);
        Ok(())
    }

    fn execute(&self, action: DispatchActionRecord) -> Result<(), String> {
        let spec = read_native_command_spec(&action)?;
        let interrupt = matches!(spec.intent, NativeCodexIntent::Interrupt { .. });
        if !interrupt {
            if let Err(error) = self.profile_current() {
                return self.fail_before_write(&action, &error);
            }
        }
        let accounts = self.app.state::<ButlerDb>();
        let account = accounts.runtime_account_context()?;
        if account.account_scope != self.account_scope {
            return Err("账号已切换，原排队意图保留，尚未派发".into());
        }
        let owner = if matches!(spec.intent, NativeCodexIntent::Prompt { .. }) {
            let connection_id = self
                .core
                .lock()
                .map_err(|_| "原生投影不可用")?
                .view
                .connection_id
                .clone()
                .ok_or("原生连接身份缺失")?;
            match ReservationOwner::for_command(&action.id, &spec, &connection_id) {
                Ok(owner) => Some(owner),
                Err(reason) => return self.fail_before_write(&action, &reason),
            }
        } else {
            None
        };
        let claim = accounts.with_runtime_account_context(&account, || {
            let connection = self.db.lock().map_err(|_| "原生账号数据库不可用")?;
            claim_with_resources(
                &connection,
                &self.resource_directory,
                &action.id,
                owner.as_ref(),
            )
        });
        let wait = match claim {
            Ok(wait) => wait,
            Err(error) => {
                // Losing account admission is a pause, not a failed queued intent.
                if accounts
                    .runtime_account_context()
                    .as_ref()
                    .is_ok_and(|current| current == &account)
                {
                    let still_prepared = self
                        .db
                        .lock()
                        .map_err(|_| "原生账号数据库不可用")?
                        .query_row(
                            "SELECT state='prepared' FROM dispatch_actions WHERE id=?1",
                            [&action.id],
                            |row| row.get::<_, bool>(0),
                        )
                        .map_err(|error| error.to_string())?;
                    if still_prepared {
                        return self.fail_before_write(&action, &error);
                    }
                }
                return Err(error);
            }
        };
        if let Some(wait) = wait {
            self.set_admission_wait(Some(wait))?;
            return Ok(());
        }
        self.set_admission_wait(None)?;
        let rpc = self.rpc.get().ok_or("原生连接尚未建立")?;
        let (method, params) = match &spec.intent {
            NativeCodexIntent::Prompt { text } => (
                "turn/start",
                json!({"threadId":spec.binding.native_thread_id,"cwd":spec.binding.workspace_root,
                "input":[{"type":"text","text":text,"text_elements":[]}]}),
            ),
            NativeCodexIntent::Steer { text } => (
                "turn/steer",
                json!({"threadId":spec.binding.native_thread_id,"expectedTurnId":spec.expected.native_turn_id,
                "input":[{"type":"text","text":text,"text_elements":[]}]}),
            ),
            NativeCodexIntent::Interrupt { .. } => (
                "turn/interrupt",
                json!({"threadId":spec.binding.native_thread_id,"turnId":spec.expected.native_turn_id}),
            ),
            NativeCodexIntent::Resume { .. } => {
                return Err("恢复命令只能通过明确的原会话交接执行".into())
            }
        };
        let result = rpc.request(method, params, Duration::from_secs(30));
        let (next, event) = match result {
            Ok(result) => {
                let turn = if interrupt {
                    spec.expected.native_turn_id.clone()
                } else {
                    result
                        .pointer("/turn/id")
                        .or_else(|| result.get("turnId"))
                        .and_then(Value::as_str)
                        .map(str::to_string)
                };
                let Some(turn) = turn else {
                    let event = self.event(
                        "rpc/invalidReceipt",
                        json!({"method":method,"reason":"原端没有返回可核对轮次"}),
                        None,
                        Some(&action),
                    )?;
                    let connection = self.db.lock().map_err(|_| "原生账号数据库不可用")?;
                    let mut core = self.core.lock().map_err(|_| "原生投影不可用")?;
                    apply_native_receipt(
                        &connection,
                        &action.id,
                        RuntimeCommandState::VerifyingDelivery,
                        &event,
                    )?;
                    core.view.error = Some("原端接收身份不明确，正在等待核对；不会重发".into());
                    self.persist(&connection, &mut core)?;
                    return Ok(());
                };
                (
                    RuntimeCommandState::Acknowledged,
                    self.event(
                        &format!("{method}:accepted"),
                        result,
                        Some(turn),
                        Some(&action),
                    )?,
                )
            }
            Err(RpcFailure::NotSent { reason }) => (
                RuntimeCommandState::Failed,
                self.event(
                    "rpc/notSent",
                    json!({"writeAttempted":false,"reason":reason}),
                    spec.expected.native_turn_id.clone(),
                    Some(&action),
                )?,
            ),
            Err(RpcFailure::Rejected { error }) => {
                let next = if matches!(
                    error.get("code").and_then(Value::as_i64),
                    Some(-32600 | -32601 | -32602)
                ) {
                    RuntimeCommandState::Failed
                } else {
                    RuntimeCommandState::VerifyingDelivery
                };
                (
                    next,
                    self.event(
                        "rpc/rejected",
                        json!({"error":error}),
                        spec.expected.native_turn_id.clone(),
                        Some(&action),
                    )?,
                )
            }
            Err(RpcFailure::Unknown { reason }) => (
                RuntimeCommandState::VerifyingDelivery,
                self.event(
                    "rpc/timeout",
                    json!({"reason":reason}),
                    spec.expected.native_turn_id.clone(),
                    Some(&action),
                )?,
            ),
        };
        let connection = self.db.lock().map_err(|_| "原生账号数据库不可用")?;
        let mut core = self.core.lock().map_err(|_| "原生投影不可用")?;
        let current = read_native_command(&connection, &action.id)?;
        // A terminal event can arrive before the RPC waiter is scheduled.
        if !matches!(current.state.as_str(), "completed" | "failed" | "canceled") {
            if !(current.state == "verifying_delivery"
                && next == RuntimeCommandState::VerifyingDelivery)
            {
                apply_native_receipt(&connection, &action.id, next, &event)?;
            }
            if next == RuntimeCommandState::Acknowledged {
                if let (Some(owner), Some(turn)) = (&owner, event.native_turn_id.as_deref()) {
                    butler_native_admission::accepted(&self.resource_directory, owner, turn)?;
                }
            }
            if next == RuntimeCommandState::Acknowledged
                && !interrupt
                && core.view.active_turn_id.is_none()
            {
                core.view.active_turn_id = event.native_turn_id.clone();
                core.view.runtime_status = "running".into();
            }
            self.finish_known_turns(&connection, &core)?;
            // Preserve the terminal projection when a late acceptance arrived.
            if let Some(terminal) = event
                .native_turn_id
                .as_ref()
                .and_then(|turn| core.terminals.get(turn))
                .cloned()
            {
                core.view.apply_notification("turn/completed", &terminal);
            }
        }
        self.persist(&connection, &mut core)?;
        self.release_settled_reservations(&connection)?;
        let cursor = core.view.cursor;
        drop(core);
        drop(connection);
        self.notify(cursor);
        Ok(())
    }

    fn run(self: Arc<Self>) {
        while !self.closed.load(Ordering::Acquire) {
            thread::sleep(Duration::from_millis(100));
            let selected = self.app.state::<ButlerDb>().runtime_account_context();
            if !matches!(selected,Ok(ref account) if account.account_scope==self.account_scope) {
                continue;
            }
            let result = (|| -> Result<Option<DispatchActionRecord>, String> {
                let connection = self.db.lock().map_err(|_| "原生账号数据库不可用")?;
                let core = self.core.lock().map_err(|_| "原生投影不可用")?;
                if core.view.connection_status != "connected" {
                    return Ok(None);
                }
                let paused:bool=connection.query_row("SELECT wait_state IN('paused','canceled') FROM work_card_states WHERE todo_id=?1",[&self.binding.todo_id],|row|row.get(0)).map_err(|error|error.to_string())?;
                let pending =
                    list_native_session_commands(&connection, &self.binding.binding.session_id)?;
                let mut prepared = pending
                    .into_iter()
                    .filter(|action| action.state == "prepared")
                    .collect::<Vec<_>>();
                prepared.sort_by_key(|action| {
                    if action.action_kind == "session_interrupt" {
                        0
                    } else {
                        1
                    }
                });
                for action in prepared {
                    let spec = read_native_command_spec(&action)?;
                    let allowed = match spec.intent {
                        NativeCodexIntent::Interrupt { .. } => core.view.active_turn_id.is_some(),
                        NativeCodexIntent::Steer { .. } => {
                            !paused && core.view.runtime_status == "running"
                        }
                        NativeCodexIntent::Prompt { .. } => {
                            !paused
                                && matches!(
                                    core.view.runtime_status.as_str(),
                                    "idle" | "interrupted"
                                )
                        }
                        NativeCodexIntent::Resume { .. } => false,
                    };
                    if allowed {
                        return Ok(Some(action));
                    }
                }
                Ok(None)
            })();
            match result {
                Ok(Some(action)) => {
                    if let Err(error) = self.execute(action) {
                        if let Ok(mut core) = self.core.lock() {
                            core.view.error = Some(error);
                        }
                    }
                }
                Ok(None) => {
                    let _ = self.set_admission_wait(None);
                }
                Err(error) => {
                    if let Some(rpc) = self.rpc.get() {
                        rpc.disconnect(&format!("无法读取持久命令：{error}"));
                    }
                    break;
                }
            }
        }
    }
}

fn active_connection(
    runtime: &NativeWorkRuntime,
    account: &RuntimeAccountContext,
    session_id: &str,
) -> Result<Arc<NativeConnection>, String> {
    let native = runtime
        .connections
        .lock()
        .map_err(|_| "原生工作注册表不可用")?
        .get(&connection_key(account, session_id))
        .cloned()
        .ok_or("原生后台尚未连接，请先交接原会话")?;
    if native.closed.load(Ordering::Acquire) {
        return Err("原生连接已中断；先核对上次结果并恢复原会话，不会自动重发".into());
    }
    Ok(native)
}

#[tauri::command]
pub async fn butler_native_work_submit(
    db: tauri::State<'_, ButlerDb>,
    runtime: tauri::State<'_, NativeWorkRuntime>,
    input: NativeWorkSubmitInput,
) -> Result<DispatchActionRecord, String> {
    db.connection_for_context(&input.account)?;
    if input.command.submitted_by != CommandSubmitter::User
        || matches!(input.command.intent, NativeCodexIntent::Resume { .. })
    {
        return Err("该界面入口只接纳用户对当前工作的发送、调整和停止意图".into());
    }
    let native = active_connection(&runtime, &input.account, &input.command.session_id)?;
    if input.command.todo_id != native.binding.todo_id {
        return Err("输入对象已经变化，未发送到其他工作".into());
    }
    let allowed = {
        let core = native.core.lock().map_err(|_| "原生投影不可用")?;
        match &input.command.intent {
            NativeCodexIntent::Prompt { .. } => core.view.capabilities.prompt,
            NativeCodexIntent::Steer { .. } => core.view.capabilities.steer,
            NativeCodexIntent::Interrupt { .. } => core.view.capabilities.interrupt,
            _ => false,
        }
    };
    if !allowed {
        return Err("当前原生连接没有经过验证的对应控制能力".into());
    }
    if !matches!(input.command.intent, NativeCodexIntent::Interrupt { .. }) {
        native.profile_current()?;
    }
    // Recheck immediately before admitting. Earlier responses still use this
    // connection's original account database even after the UI changes account.
    db.connection_for_context(&input.account)?;
    let connection = native.db.lock().map_err(|_| "原生账号数据库不可用")?;
    let action = prepare_native_command(
        &connection,
        &input.account,
        native.binding.host_device_id.clone(),
        native.binding.binding.clone(),
        input.command,
    )?;
    let mut core = native.core.lock().map_err(|_| "原生投影不可用")?;
    native.persist(&connection, &mut core)?;
    let cursor = core.view.cursor;
    drop(core);
    drop(connection);
    native.notify(cursor);
    Ok(action)
}

#[tauri::command]
pub async fn butler_native_work_cancel_queued(
    db: tauri::State<'_, ButlerDb>,
    runtime: tauri::State<'_, NativeWorkRuntime>,
    input: NativeWorkCancelQueuedInput,
) -> Result<DispatchActionRecord, String> {
    let admitted = db.connection_for_context(&input.account)?;
    let native = runtime
        .connections
        .lock()
        .map_err(|_| "原生工作注册表不可用")?
        .get(&connection_key(&input.account, &input.session_id))
        .cloned();
    let connection = admitted.lock().map_err(|_| "账号数据库不可用")?;
    let current = binding(&connection, &input.session_id, &input.account.account_scope)?;
    if current.owner != "native_host" {
        return Err("这条排队记录不由原生后台管理".into());
    }
    connection
        .execute_batch("SAVEPOINT native_queue_cancel;")
        .map_err(|error| error.to_string())?;
    let result = (|| {
        let action = super::butler_work_commands::cancel_queued_native_command(
            &connection,
            &input.session_id,
            &input.request_id,
        )?;
        let spec = read_native_command_spec(&action)?;
        let event = RuntimeEvent {
            sequence: 0,
            todo_id: current.todo_id.clone(),
            session_id: input.session_id.clone(),
            action_id: Some(action.id.clone()),
            event_type: "command/queueCanceled".into(),
            connection_id: format!("local-command:{}", uuid::Uuid::new_v4()),
            connection_sequence: 1,
            native_thread_id: current.binding.native_thread_id.clone(),
            native_turn_id: None,
            requirements_version: spec.expected.requirements_version,
            content_version: spec.expected.content_version,
            payload: json!({"requestId": input.request_id}),
            received_at: 0,
        };
        let event = append_runtime_event(&connection, &event)?;
        let mut view = stored_snapshot(&connection, &current)?;
        view.cursor = event.sequence;
        persist_snapshot(&connection, &current, &view)?;
        Ok((action, view))
    })();
    match result {
        Ok((action, view)) => {
            connection
                .execute_batch("RELEASE native_queue_cancel;")
                .map_err(|error| error.to_string())?;
            if let Some(native) = native.filter(|native| {
                native.binding.binding.binding_version == current.binding.binding_version
            }) {
                if let Ok(mut core) = native.core.lock() {
                    core.view.commands = view.commands;
                    core.view.cursor = view.cursor;
                }
                native.notify(view.cursor);
            }
            Ok(action)
        }
        Err(error) => {
            let _ = connection
                .execute_batch("ROLLBACK TO native_queue_cancel; RELEASE native_queue_cancel;");
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn butler_native_work_answer(
    db: tauri::State<'_, ButlerDb>,
    runtime: tauri::State<'_, NativeWorkRuntime>,
    input: NativeWorkAnswerInput,
) -> Result<NativeWorkSnapshot, String> {
    db.connection_for_context(&input.account)?;
    let native = active_connection(&runtime, &input.account, &input.session_id)?;
    native.profile_current()?;
    let rpc = Arc::clone(native.rpc.get().ok_or("原生连接尚未建立")?);
    let (request_id, answer) = {
        let connection = native.db.lock().map_err(|_| "原生账号数据库不可用")?;
        let mut core = native.core.lock().map_err(|_| "原生投影不可用")?;
        let current = binding(&connection, &input.session_id, &input.account.account_scope)?;
        let active_turn = core.view.active_turn_id.clone();
        let decision = core
            .view
            .decisions
            .iter_mut()
            .find(|decision| decision.id == input.decision_id)
            .ok_or("原问题已不存在")?;
        if decision.state != "pending"
            || decision.native_turn_id != input.native_turn_id
            || active_turn.as_deref() != Some(&input.native_turn_id)
            || decision.binding_version != input.expected_binding_version
            || current.binding.binding_version != decision.binding_version
            || decision.requirements_version != input.expected_requirements_version
            || current.requirements_version != decision.requirements_version
        {
            return Err("原问题、轮次或要求已经变化，旧答案不会影响当前工作".into());
        }
        let answer = answer_for_request(&decision.method, &decision.params, &input.answer)?;
        let id = decision.native_request_id.clone();
        // Reserve before I/O. A response can never be replayed after an
        // uncertain write or application restart.
        decision.state = "unknown".into();
        native.persist(&connection, &mut core)?;
        (id, answer)
    };
    if let Err(error) = db.connection_for_context(&input.account) {
        let connection = native.db.lock().map_err(|_| "原生账号数据库不可用")?;
        let mut core = native.core.lock().map_err(|_| "原生投影不可用")?;
        if let Some(decision) = core
            .view
            .decisions
            .iter_mut()
            .find(|decision| decision.id == input.decision_id)
        {
            if decision.state == "unknown" {
                decision.state = "pending".into();
            }
        }
        native.persist(&connection, &mut core)?;
        return Err(error);
    }
    let result = tauri::async_runtime::spawn_blocking(move || rpc.respond(&request_id, answer))
        .await
        .map_err(|error| error.to_string())?;
    let connection = native.db.lock().map_err(|_| "原生账号数据库不可用")?;
    let mut core = native.core.lock().map_err(|_| "原生投影不可用")?;
    if let Some(decision) = core
        .view
        .decisions
        .iter_mut()
        .find(|decision| decision.id == input.decision_id)
    {
        match &result {
            Ok(()) => decision.state = "answered".into(),
            Err(RpcFailure::NotSent { .. }) => decision.state = "pending".into(),
            Err(_) => decision.state = "unknown".into(),
        }
    }
    if result.is_ok() {
        core.view.refresh_decision_status();
    }
    native.persist(&connection, &mut core)?;
    let view = core.view.clone();
    drop(core);
    drop(connection);
    native.notify(view.cursor);
    result.map_err(|error| error.to_string())?;
    Ok(view)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn database() -> Connection {
        let mut connection = Connection::open_in_memory().unwrap();
        super::super::migrate(&mut connection).unwrap();
        connection.execute_batch(r#"
            INSERT INTO todos(id,title,created_at,updated_at) VALUES('existing-work','synthetic work',1,1);
            INSERT INTO work_card_states(todo_id,requirements_version,content_version,autonomy_mode,updated_at)
                VALUES('existing-work',2,3,'confirm',1);
            INSERT INTO work_sessions(id,todo_id,runtime,native_session_id,source_scope,workspace_root,account_scope,
                control_mode,host_device_id,config_snapshot_json,last_verified_at,created_at,updated_at,binding_version,runtime_owner)
                VALUES('existing-binding','existing-work','acp','original-thread','synthetic-source','C:/synthetic-work','synthetic-account',
                    'resumable','synthetic-device','{"provider":"codex","agentId":"original-profile","unrelated":"keep"}',1,1,1,2,'legacy');
        "#).unwrap();
        connection
    }

    fn current_binding(connection: &Connection) -> Binding {
        binding(connection, "existing-binding", "synthetic-account").unwrap()
    }

    fn claimed_binding(connection: &Connection) -> Binding {
        let current = current_binding(connection);
        claim_binding(connection, &current, current.binding.binding_version).unwrap()
    }

    fn snapshot_json(connection: &Connection) -> String {
        connection.query_row("SELECT snapshot_json FROM work_runtime_snapshots WHERE session_id='existing-binding'", [], |row| row.get(0)).unwrap()
    }

    fn resource_fixture() -> (
        PathBuf,
        Connection,
        Binding,
        DispatchActionRecord,
        ReservationOwner,
    ) {
        let directory =
            std::env::temp_dir().join(format!("rocketx-runtime-recovery-{}", uuid::Uuid::new_v4()));
        let workspace = directory.join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        butler_native_admission::initialize(&directory).unwrap();
        let connection = database();
        connection
            .execute(
                "UPDATE work_sessions SET workspace_root=?1",
                [workspace.to_str().unwrap()],
            )
            .unwrap();
        let current = claimed_binding(&connection);
        connection
            .execute("UPDATE work_sessions SET runtime_status='idle'", [])
            .unwrap();
        let action = prepare_native_command(
            &connection,
            &RuntimeAccountContext {
                account_scope: "synthetic-account".into(),
                generation: 1,
            },
            current.host_device_id.clone(),
            current.binding.clone(),
            RuntimeCommandInput {
                request_id: "recovery-request".into(),
                todo_id: current.todo_id.clone(),
                session_id: current.binding.session_id.clone(),
                expected_requirements_version: 2,
                expected_content_version: 3,
                expected_binding_version: 3,
                native_turn_id: None,
                queue_after_turn: false,
                intent: NativeCodexIntent::Prompt {
                    text: "fixture only".into(),
                },
                submitted_by: CommandSubmitter::User,
            },
        )
        .unwrap();
        let owner = ReservationOwner::for_command(
            &action.id,
            &read_native_command_spec(&action).unwrap(),
            "original-resource-connection",
        )
        .unwrap();
        (directory, connection, current, action, owner)
    }

    fn remove_resource_fixture(directory: PathBuf) {
        let directory = std::fs::canonicalize(directory).unwrap();
        assert_eq!(
            directory.parent(),
            Some(
                std::fs::canonicalize(std::env::temp_dir())
                    .unwrap()
                    .as_path()
            )
        );
        assert!(directory
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("rocketx-runtime-"));
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn native_runtime_resource_cold_resume_releases_preclaim_crash_only_after_owner_fenced_and_fact_committed(
    ) {
        let (directory, connection, current, action, owner) = resource_fixture();
        let guard =
            butler_native_admission::connection_guard(&directory, "original-resource-connection")
                .unwrap();
        butler_native_admission::reserve(&directory, &owner).unwrap();
        let resumed = claim_binding(&connection, &current, 3).unwrap();
        let thread = json!({"id":"original-thread","cwd":current.binding.workspace_root,"status":{"type":"idle"},"turns":[]});
        assert!(prepare_cold_resource_recovery(
            &connection,
            &directory,
            "synthetic-account",
            &resumed.binding,
            &thread
        )
        .is_err());
        drop(guard);
        let recovery = prepare_cold_resource_recovery(
            &connection,
            &directory,
            "synthetic-account",
            &resumed.binding,
            &thread,
        )
        .unwrap();
        assert_eq!(recovery.len(), 1);
        connection
            .execute_batch("SAVEPOINT recovery_fixture;")
            .unwrap();
        persist_cold_resource_recovery(
            &connection,
            &resumed,
            "recovered-connection",
            &AtomicI64::new(1),
            &recovery,
        )
        .unwrap();
        assert!(release_cold_resources(&connection, &directory, &recovery).is_err());
        connection
            .execute_batch("RELEASE recovery_fixture;")
            .unwrap();
        assert_eq!(
            read_native_command(&connection, &action.id).unwrap().state,
            "failed"
        );
        release_cold_resources(&connection, &directory, &recovery).unwrap();
        assert!(butler_native_admission::session_reservations(
            &directory,
            "synthetic-account",
            "existing-binding"
        )
        .unwrap()
        .is_empty());
        drop((recovery, connection));
        remove_resource_fixture(directory);
    }

    #[test]
    fn native_runtime_resource_explicit_rejection_releases_but_unknown_rejection_stays_reserved() {
        for (code, next, kept) in [
            (-32600, RuntimeCommandState::Failed, false),
            (-32601, RuntimeCommandState::Failed, false),
            (-32602, RuntimeCommandState::Failed, false),
            (-32000, RuntimeCommandState::VerifyingDelivery, true),
        ] {
            let (directory, connection, _, action, owner) = resource_fixture();
            assert!(
                claim_with_resources(&connection, &directory, &action.id, Some(&owner))
                    .unwrap()
                    .is_none()
            );
            let mut event = native_runtime_event(
                &action,
                1,
                "rpc/rejected",
                "unused",
                json!({"error":{"code":code,"message":"fixture"}}),
            );
            event.native_turn_id = None;
            apply_native_receipt(&connection, &action.id, next, &event).unwrap();
            release_settled_resources(
                &connection,
                &directory,
                "synthetic-account",
                "existing-binding",
            )
            .unwrap();
            assert_eq!(
                !butler_native_admission::session_reservations(
                    &directory,
                    "synthetic-account",
                    "existing-binding"
                )
                .unwrap()
                .is_empty(),
                kept
            );
            drop(connection);
            remove_resource_fixture(directory);
        }
    }

    #[test]
    fn native_runtime_resource_snapshot_recovery_requires_exact_terminal_or_versioned_idle_owner() {
        for (versioned, with_turn, can_release) in [
            (true, true, true),
            (false, true, true),
            (true, false, true),
            (false, false, false),
        ] {
            let (directory, connection, current, _, _) = resource_fixture();
            let guard = if versioned {
                Some(
                    butler_native_admission::connection_guard(
                        &directory,
                        "original-resource-connection",
                    )
                    .unwrap(),
                )
            } else {
                None
            };
            let mut view = blank_snapshot(&current);
            view.connection_id = Some("original-resource-connection".into());
            view.runtime_status = "unknown".into();
            view.active_turn_id = with_turn.then(|| "snapshot-turn".into());
            persist_snapshot(&connection, &current, &view).unwrap();
            if versioned {
                connection.execute("UPDATE work_sessions SET config_snapshot_json=json_set(config_snapshot_json,'$.nativeHost',json(?1))",
                    [json!({"connectionId":"original-resource-connection","resourceOwnerGuardVersion":1}).to_string()]).unwrap();
            }
            connection
                .execute(
                    "VACUUM INTO ?1",
                    [directory.join("butler-snapshot.db").to_str().unwrap()],
                )
                .unwrap();
            butler_native_admission::initialize(&directory).unwrap();
            let resumed = claim_binding(&connection, &current, 3).unwrap();
            let mut thread = json!({"id":"original-thread","cwd":current.binding.workspace_root,"status":{"type":"idle"},
                "turns":[{"id":"different-turn","status":"completed"}]});
            if with_turn {
                assert!(prepare_cold_resource_recovery(
                    &connection,
                    &directory,
                    "synthetic-account",
                    &resumed.binding,
                    &thread
                )
                .unwrap()
                .is_empty());
                thread["turns"] = json!([{"id":"snapshot-turn","status":"completed"}]);
            }
            if versioned {
                assert!(prepare_cold_resource_recovery(
                    &connection,
                    &directory,
                    "synthetic-account",
                    &resumed.binding,
                    &thread
                )
                .is_err());
            }
            drop(guard);
            let recovery = prepare_cold_resource_recovery(
                &connection,
                &directory,
                "synthetic-account",
                &resumed.binding,
                &thread,
            )
            .unwrap();
            assert_eq!(!recovery.is_empty(), can_release);
            connection
                .execute_batch("SAVEPOINT snapshot_recovery_fixture;")
                .unwrap();
            persist_cold_resource_recovery(
                &connection,
                &resumed,
                "new-connection",
                &AtomicI64::new(1),
                &recovery,
            )
            .unwrap();
            connection
                .execute_batch("RELEASE snapshot_recovery_fixture;")
                .unwrap();
            release_cold_resources(&connection, &directory, &recovery).unwrap();
            assert_eq!(
                butler_native_admission::session_reservations(
                    &directory,
                    "synthetic-account",
                    "existing-binding"
                )
                .unwrap()
                .is_empty(),
                can_release
            );
            drop((recovery, connection));
            remove_resource_fixture(directory);
        }
    }

    #[test]
    fn native_runtime_resource_snapshot_terminal_does_not_release_next_claimed_unsent_writer() {
        let (directory, connection, current, next_action, _) = resource_fixture();
        let mut old_view = blank_snapshot(&current);
        old_view.connection_id = Some("legacy-snapshot-connection".into());
        old_view.runtime_status = "unknown".into();
        old_view.active_turn_id = Some("historical-turn".into());
        persist_snapshot(&connection, &current, &old_view).unwrap();
        connection
            .execute(
                "VACUUM INTO ?1",
                [directory.join("butler-snapshot.db").to_str().unwrap()],
            )
            .unwrap();
        butler_native_admission::initialize(&directory).unwrap();
        // Old dispatcher receives T's end and claims Q before the new binding
        // fence. Its RPC write can still occur after this idle read.
        connection
            .execute(
                "UPDATE work_sessions SET runtime_status='idle',last_turn_id=NULL",
                [],
            )
            .unwrap();
        claim_native_command(&connection, &next_action.id).unwrap();
        let resumed = claim_binding(&connection, &current, 3).unwrap();
        let thread = json!({"id":"original-thread","cwd":current.binding.workspace_root,
            "status":{"type":"idle"},"turns":[{"id":"historical-turn","status":"completed"}]});
        let recovery = prepare_cold_resource_recovery(
            &connection,
            &directory,
            "synthetic-account",
            &resumed.binding,
            &thread,
        )
        .unwrap();
        assert!(recovery.is_empty());
        let next_action = read_native_command(&connection, &next_action.id).unwrap();
        assert_eq!(next_action.state, "dispatched");
        assert!(next_action.receipt_ref.is_none());
        assert_eq!(
            butler_native_admission::session_reservations(
                &directory,
                "synthetic-account",
                "existing-binding"
            )
            .unwrap()
            .len(),
            1
        );
        drop((recovery, connection));
        remove_resource_fixture(directory);
    }

    #[test]
    fn native_runtime_resource_old_resume_reservation_needs_same_thread_idle_fact_to_release() {
        for (status, kept) in [("idle", false), ("systemError", true)] {
            let (directory, connection, current, _, _) = resource_fixture();
            let resume = prepare_native_command(
                &connection,
                &RuntimeAccountContext {
                    account_scope: "synthetic-account".into(),
                    generation: 1,
                },
                current.host_device_id.clone(),
                current.binding.clone(),
                RuntimeCommandInput {
                    request_id: "old-resume".into(),
                    todo_id: current.todo_id.clone(),
                    session_id: current.binding.session_id.clone(),
                    expected_requirements_version: 2,
                    expected_content_version: 3,
                    expected_binding_version: 3,
                    native_turn_id: None,
                    queue_after_turn: false,
                    intent: NativeCodexIntent::Resume {},
                    submitted_by: CommandSubmitter::User,
                },
            )
            .unwrap();
            let owner = ReservationOwner::for_command(
                &resume.id,
                &read_native_command_spec(&resume).unwrap(),
                "legacy-resume-resource",
            )
            .unwrap();
            butler_native_admission::reserve(&directory, &owner).unwrap();
            claim_native_command(&connection, &resume.id).unwrap();
            let mut event = native_runtime_event(
                &resume,
                1,
                "thread/resumed",
                "unused",
                json!({"thread":{"id":"original-thread","status":{"type":status}}}),
            );
            event.native_turn_id = None;
            apply_native_receipt(
                &connection,
                &resume.id,
                RuntimeCommandState::Completed,
                &event,
            )
            .unwrap();
            release_settled_resources(
                &connection,
                &directory,
                "synthetic-account",
                "existing-binding",
            )
            .unwrap();
            assert_eq!(
                !butler_native_admission::session_reservations(
                    &directory,
                    "synthetic-account",
                    "existing-binding"
                )
                .unwrap()
                .is_empty(),
                kept
            );
            drop(connection);
            remove_resource_fixture(directory);
        }
    }

    #[test]
    fn native_runtime_resource_defer_keeps_original_action_prepared_and_stop_bypasses_full_slots() {
        let directory = std::env::temp_dir().join(format!(
            "rocketx-runtime-resources-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&directory).unwrap();
        butler_native_admission::initialize(&directory).unwrap();
        let mut prepared = Vec::new();
        for index in 0..3 {
            let workspace = directory.join(index.to_string());
            std::fs::create_dir(&workspace).unwrap();
            let connection = database();
            connection
                .execute(
                    "UPDATE work_sessions SET workspace_root=?1",
                    [workspace.to_str().unwrap()],
                )
                .unwrap();
            let current = claimed_binding(&connection);
            connection
                .execute("UPDATE work_sessions SET runtime_status='idle'", [])
                .unwrap();
            let action = prepare_native_command(
                &connection,
                &RuntimeAccountContext {
                    account_scope: "synthetic-account".into(),
                    generation: 1,
                },
                current.host_device_id.clone(),
                current.binding.clone(),
                RuntimeCommandInput {
                    request_id: format!("resource-{index}"),
                    todo_id: current.todo_id.clone(),
                    session_id: current.binding.session_id.clone(),
                    expected_requirements_version: 2,
                    expected_content_version: 3,
                    expected_binding_version: 3,
                    native_turn_id: None,
                    queue_after_turn: false,
                    intent: NativeCodexIntent::Prompt {
                        text: "fixture".into(),
                    },
                    submitted_by: CommandSubmitter::User,
                },
            )
            .unwrap();
            let spec = read_native_command_spec(&action).unwrap();
            let owner =
                ReservationOwner::for_command(&action.id, &spec, &format!("connection-{index}"))
                    .unwrap();
            let admission =
                claim_with_resources(&connection, &directory, &action.id, Some(&owner)).unwrap();
            if index < 2 {
                assert!(admission.is_none());
                assert_eq!(
                    read_native_command(&connection, &action.id).unwrap().state,
                    "dispatched"
                );
            } else {
                assert_eq!(admission.unwrap().reason, "execution_slots");
                assert_eq!(
                    read_native_command(&connection, &action.id).unwrap().state,
                    "prepared"
                );
                assert_eq!(
                    connection
                        .query_row("SELECT auto_turns_used FROM work_card_states", [], |row| {
                            row.get::<_, i64>(0)
                        })
                        .unwrap(),
                    0
                );
            }
            prepared.push((connection, current, action, owner));
        }
        let (connection, current, action, _) = &prepared[0];
        apply_native_receipt(
            connection,
            &action.id,
            RuntimeCommandState::Acknowledged,
            &native_runtime_event(
                action,
                1,
                "turn/start:accepted",
                "active-turn",
                json!({"threadId":"original-thread","turn":{"id":"active-turn"}}),
            ),
        )
        .unwrap();
        let stop = prepare_native_command(
            connection,
            &RuntimeAccountContext {
                account_scope: "synthetic-account".into(),
                generation: 1,
            },
            current.host_device_id.clone(),
            current.binding.clone(),
            RuntimeCommandInput {
                request_id: "stop-at-capacity".into(),
                todo_id: current.todo_id.clone(),
                session_id: current.binding.session_id.clone(),
                expected_requirements_version: 2,
                expected_content_version: 3,
                expected_binding_version: 3,
                native_turn_id: Some("active-turn".into()),
                queue_after_turn: false,
                intent: NativeCodexIntent::Interrupt {},
                submitted_by: CommandSubmitter::User,
            },
        )
        .unwrap();
        assert!(claim_with_resources(connection, &directory, &stop.id, None)
            .unwrap()
            .is_none());
        assert_eq!(
            read_native_command(connection, &stop.id).unwrap().state,
            "dispatched"
        );
        drop(prepared);
        let absolute = std::fs::canonicalize(&directory).unwrap();
        assert_eq!(
            absolute.parent(),
            Some(
                std::fs::canonicalize(std::env::temp_dir())
                    .unwrap()
                    .as_path()
            )
        );
        std::fs::remove_dir_all(absolute).unwrap();
    }

    #[test]
    fn native_runtime_binding_normalizes_legacy_agent_profile_and_preserves_work_session_runtime() {
        let connection = database();
        let current = current_binding(&connection);
        assert_eq!(current.binding.execution_profile_id, "original-profile");
        assert!(current.config.get("executionProfileId").is_none());
        let claimed = claim_binding(&connection, &current, 2).unwrap();
        assert_eq!(claimed.config["executionProfileId"], "original-profile");
        assert_eq!(claimed.config["agentId"], "original-profile");
        assert_eq!(claimed.config["unrelated"], "keep");
        assert_eq!(claimed.config["nativeHost"]["bindingVersion"], 3);
        let (id,todo_id,runtime,thread,config): (String,String,String,String,String) = connection.query_row(
            "SELECT id,todo_id,runtime,native_session_id,config_snapshot_json FROM work_sessions", [],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?))).unwrap();
        assert_eq!(
            (id, todo_id, runtime, thread),
            (
                "existing-binding".into(),
                "existing-work".into(),
                "acp".into(),
                "original-thread".into()
            )
        );
        assert_eq!(
            serde_json::from_str::<Value>(&config).unwrap()["executionProfileId"],
            "original-profile"
        );
        assert_eq!(current_binding(&connection).owner, "native_host");
        assert_eq!(current_binding(&connection).binding.binding_version, 3);
    }

    #[test]
    fn native_runtime_binding_claim_cas_rejects_stale_owner_without_rewriting_config() {
        let connection = database();
        let original = current_binding(&connection);
        claim_binding(&connection, &original, 2).unwrap();
        let before: (i64, String, String) = connection
            .query_row(
                "SELECT binding_version,runtime_owner,config_snapshot_json FROM work_sessions",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert!(claim_binding(&connection, &original, 2).is_err());
        let after: (i64, String, String) = connection
            .query_row(
                "SELECT binding_version,runtime_owner,config_snapshot_json FROM work_sessions",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(after, before);
        let latest = current_binding(&connection);
        assert_eq!(
            claim_binding(&connection, &latest, 3)
                .unwrap()
                .binding
                .binding_version,
            4
        );
    }

    #[test]
    fn native_runtime_snapshot_fences_late_old_binding_writes() {
        let connection = database();
        let old = claimed_binding(&connection);
        let mut old_view = blank_snapshot(&old);
        old_view.cursor = 10;
        old_view.runtime_status = "running".into();
        old_view.active_turn_id = Some("old-turn".into());
        persist_snapshot(&connection, &old, &old_view).unwrap();
        let new = claim_binding(&connection, &old, 3).unwrap();
        let mut new_view = blank_snapshot(&new);
        new_view.cursor = 20;
        new_view.runtime_status = "running".into();
        new_view.active_turn_id = Some("new-turn".into());
        new_view.error = Some("new binding owns this snapshot".into());
        persist_snapshot(&connection, &new, &new_view).unwrap();
        let expected = snapshot_json(&connection);
        old_view.cursor = 999;
        old_view.runtime_status = "interrupted".into();
        old_view.error = Some("late old result".into());
        persist_snapshot(&connection, &old, &old_view).unwrap();
        assert_eq!(snapshot_json(&connection), expected);
        let state: (i64,String,String,i64) = connection.query_row(
            "SELECT binding_version,runtime_status,last_turn_id,last_event_seq FROM work_sessions", [],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))).unwrap();
        assert_eq!(state, (4, "running".into(), "new-turn".into(), 20));
    }

    #[test]
    fn native_runtime_binding_rejects_wrong_account_device_source_or_corrupt_config() {
        let connection = database();
        assert!(binding(&connection, "existing-binding", "another-account").is_err());
        assert!(binding(&connection, "missing-binding", "synthetic-account").is_err());
        for sql in [
            "UPDATE work_sessions SET host_device_id=NULL",
            "UPDATE work_sessions SET config_snapshot_json='{\"provider\":\"claude\",\"agentId\":\"profile\"}'",
            "UPDATE work_sessions SET config_snapshot_json='{'",
            "UPDATE work_sessions SET config_snapshot_json='{\"provider\":\"codex\"}'",
        ] {
            let connection = database();
            connection.execute(sql, []).unwrap();
            assert!(binding(&connection, "existing-binding", "synthetic-account").is_err(), "{sql}");
            assert_eq!(connection.query_row("SELECT binding_version FROM work_sessions", [], |row| row.get::<_,i64>(0)).unwrap(), 2);
        }
    }

    #[test]
    fn native_runtime_stored_snapshot_rejects_corruption_and_mismatched_identity() {
        let connection = database();
        let current = claimed_binding(&connection);
        let empty = stored_snapshot(&connection, &current).unwrap();
        assert_eq!(empty.native_thread_id, "original-thread");
        assert!(empty.messages.is_empty());
        for (field, value) in [
            ("protocolVersion", json!(2)),
            ("sessionId", json!("other-binding")),
            ("nativeThreadId", json!("other-thread")),
            ("todoId", json!("other-work")),
            ("sourceScope", json!("other-source")),
            ("executionProfileId", json!("other-profile")),
        ] {
            let mut wrong = serde_json::to_value(blank_snapshot(&current)).unwrap();
            wrong[field] = value;
            connection.execute("INSERT INTO work_runtime_snapshots(session_id,snapshot_json,updated_at) VALUES('existing-binding',?1,1) ON CONFLICT(session_id) DO UPDATE SET snapshot_json=excluded.snapshot_json", [wrong.to_string()]).unwrap();
            assert!(
                stored_snapshot(&connection, &current).is_err(),
                "accepted mismatched {field}"
            );
        }
        connection
            .execute("UPDATE work_runtime_snapshots SET snapshot_json='{'", [])
            .unwrap();
        assert!(stored_snapshot(&connection, &current)
            .unwrap_err()
            .contains("损坏"));
    }

    #[test]
    fn native_runtime_stored_snapshot_preserves_native_history_and_reads_current_ledger_cursor() {
        let connection = database();
        let current = claimed_binding(&connection);
        let mut view = blank_snapshot(&current);
        view.load_thread(&json!({"id":"original-thread","turns":[{"id":"native-history-turn","status":"completed","items":[{
            "id":"native-history-message","type":"agentMessage","text":"原端历史正文"
        }]}]})).unwrap();
        view.cursor = 999;
        persist_snapshot(&connection, &current, &view).unwrap();
        let action = prepare_native_command(
            &connection,
            &RuntimeAccountContext {
                account_scope: "synthetic-account".into(),
                generation: 1,
            },
            current.host_device_id.clone(),
            current.binding.clone(),
            RuntimeCommandInput {
                request_id: "synthetic-resume".into(),
                todo_id: current.todo_id.clone(),
                session_id: current.binding.session_id.clone(),
                expected_requirements_version: 2,
                expected_content_version: 3,
                expected_binding_version: 3,
                native_turn_id: None,
                queue_after_turn: false,
                intent: NativeCodexIntent::Resume {},
                submitted_by: CommandSubmitter::User,
            },
        )
        .unwrap();
        let event = append_runtime_event(
            &connection,
            &RuntimeEvent {
                sequence: 0,
                todo_id: current.todo_id.clone(),
                session_id: current.binding.session_id.clone(),
                action_id: Some(action.id.clone()),
                event_type: "thread/resumed".into(),
                connection_id: "synthetic-connection".into(),
                connection_sequence: 1,
                native_thread_id: "original-thread".into(),
                native_turn_id: None,
                requirements_version: 2,
                content_version: 3,
                payload: json!({"thread":{"id":"original-thread"}}),
                received_at: 0,
            },
        )
        .unwrap();
        let loaded = stored_snapshot(&connection, &current).unwrap();
        assert_eq!(loaded.messages.len(), 1);
        assert_eq!(loaded.messages[0].id, "native-history-message");
        assert_eq!(loaded.messages[0].text, "原端历史正文");
        assert_eq!(
            loaded.messages[0].turn_id.as_deref(),
            Some("native-history-turn")
        );
        assert_eq!(loaded.commands.len(), 1);
        assert_eq!(loaded.commands[0].id, action.id);
        assert_eq!(loaded.commands[0].state, "prepared");
        assert_eq!(loaded.cursor, event.sequence);
        assert_ne!(loaded.cursor, 999);
        assert_eq!(loaded.binding_version, 3);
    }

    fn native_runtime_event(
        action: &DispatchActionRecord,
        sequence: i64,
        method: &str,
        turn: &str,
        payload: Value,
    ) -> RuntimeEvent {
        let spec = read_native_command_spec(action).unwrap();
        RuntimeEvent {
            sequence: 0,
            todo_id: spec.todo_id,
            session_id: spec.binding.session_id,
            action_id: Some(action.id.clone()),
            event_type: method.into(),
            connection_id: "synthetic-connection".into(),
            connection_sequence: sequence,
            native_thread_id: spec.binding.native_thread_id,
            native_turn_id: Some(turn.into()),
            requirements_version: spec.expected.requirements_version,
            content_version: spec.expected.content_version,
            payload,
            received_at: 0,
        }
    }

    #[test]
    fn native_runtime_terminal_pruning_keeps_pre_ack_current_turn_and_other_unresolved_receipts() {
        let connection = database();
        let current = claimed_binding(&connection);
        let prepare = |request: &str, intent: NativeCodexIntent, turn: Option<&str>| {
            prepare_native_command(
                &connection,
                &RuntimeAccountContext {
                    account_scope: "synthetic-account".into(),
                    generation: 1,
                },
                current.host_device_id.clone(),
                current.binding.clone(),
                RuntimeCommandInput {
                    request_id: request.into(),
                    todo_id: current.todo_id.clone(),
                    session_id: current.binding.session_id.clone(),
                    expected_requirements_version: 2,
                    expected_content_version: 3,
                    expected_binding_version: 3,
                    native_turn_id: turn.map(str::to_string),
                    queue_after_turn: false,
                    intent,
                    submitted_by: CommandSubmitter::User,
                },
            )
            .unwrap()
        };
        connection
            .execute("UPDATE work_sessions SET runtime_status='idle'", [])
            .unwrap();
        let peer = prepare(
            "unresolved-peer",
            NativeCodexIntent::Prompt {
                text: "earlier turn".into(),
            },
            None,
        );
        claim_native_command(&connection, &peer.id).unwrap();
        apply_native_receipt(
            &connection,
            &peer.id,
            RuntimeCommandState::Acknowledged,
            &native_runtime_event(
                &peer,
                1,
                "turn/start:accepted",
                "peer-turn",
                json!({"turn":{"id":"peer-turn"}}),
            ),
        )
        .unwrap();
        // An imported native idle state can arrive before the old receipt is reconciled.
        connection
            .execute("UPDATE work_sessions SET runtime_status='idle'", [])
            .unwrap();
        let prompt = prepare(
            "current-prompt",
            NativeCodexIntent::Prompt {
                text: "current turn".into(),
            },
            None,
        );
        claim_native_command(&connection, &prompt.id).unwrap();
        let expected_turn = prepare(
            "pending-steer",
            NativeCodexIntent::Steer {
                text: "pending".into(),
            },
            Some("expected-turn"),
        );
        let mut core = Core {
            view: blank_snapshot(&current),
            terminals: HashMap::new(),
        };
        for index in 0..30 {
            let turn = format!("imported-history-{index}");
            core.terminals.insert(turn.clone(), json!({"threadId":"original-thread","turn":{"id":turn,"status":"completed","items":[]}}));
        }
        for turn in ["peer-turn", "expected-turn", "current-turn"] {
            core.terminals.insert(turn.into(), json!({"threadId":"original-thread","turn":{"id":turn,"status":"completed","items":[]}}));
        }
        core.view.apply_notification(
            "turn/started",
            &json!({"threadId":"original-thread","turn":{"id":"current-turn"}}),
        );
        core.view
            .apply_notification("turn/completed", &core.terminals["current-turn"]);
        assert!(core.view.active_turn_id.is_none());
        let pending =
            list_native_session_commands(&connection, &current.binding.session_id).unwrap();
        core.prune_terminals("current-turn", &pending);
        assert!(core.terminals.contains_key("current-turn"));
        assert!(core.terminals.contains_key("peer-turn"));
        assert!(core.terminals.contains_key("expected-turn"));
        assert_eq!(core.terminals.len(), 3);
        assert_eq!(
            read_native_command(&connection, &prompt.id).unwrap().state,
            "dispatched"
        );
        apply_native_receipt(
            &connection,
            &prompt.id,
            RuntimeCommandState::Acknowledged,
            &native_runtime_event(
                &prompt,
                2,
                "turn/start:accepted",
                "current-turn",
                json!({"turn":{"id":"current-turn"}}),
            ),
        )
        .unwrap();
        let cached_terminal = core.terminals.get("current-turn").unwrap().clone();
        let completed = apply_native_receipt(
            &connection,
            &prompt.id,
            RuntimeCommandState::Completed,
            &native_runtime_event(
                &prompt,
                3,
                "turn/completed",
                "current-turn",
                cached_terminal,
            ),
        )
        .unwrap();
        assert_eq!(completed.state, "completed");
        let peer_receipt = read_native_command(&connection, &peer.id).unwrap();
        assert_eq!(peer_receipt.state, "acknowledged");
        assert_eq!(
            serde_json::from_str::<Value>(peer_receipt.receipt_ref.as_ref().unwrap()).unwrap()
                ["nativeTurnId"],
            "peer-turn"
        );
        assert_eq!(
            read_native_command(&connection, &expected_turn.id)
                .unwrap()
                .state,
            "prepared"
        );
    }

    #[test]
    fn native_runtime_resumed_workspace_requires_existing_matching_canonical_directory() {
        let directory = std::env::current_dir().unwrap();
        let expected = directory.canonicalize().unwrap();
        let same_directory = directory.join(".");
        validate_resumed_workspace(
            expected.to_str().unwrap(),
            &json!({"cwd":same_directory.to_str().unwrap()}),
        )
        .unwrap();
        assert!(validate_resumed_workspace(expected.to_str().unwrap(), &json!({})).is_err());
        let different = directory.parent().unwrap();
        assert_ne!(different.canonicalize().unwrap(), expected);
        assert!(validate_resumed_workspace(
            expected.to_str().unwrap(),
            &json!({"cwd":different.to_str().unwrap()})
        )
        .is_err());
        let nonexistent = directory.join(format!(
            "rocketx-nonexistent-workspace-{}",
            uuid::Uuid::new_v4()
        ));
        assert!(!nonexistent.exists());
        assert!(validate_resumed_workspace(
            expected.to_str().unwrap(),
            &json!({"cwd":nonexistent.to_str().unwrap()})
        )
        .is_err());
        assert!(validate_resumed_workspace(
            nonexistent.to_str().unwrap(),
            &json!({"cwd":directory.to_str().unwrap()})
        )
        .is_err());
    }

    #[test]
    fn native_runtime_event_versions_follow_the_original_turn_after_requirements_change() {
        let connection = database();
        let current = claimed_binding(&connection);
        connection
            .execute("UPDATE work_sessions SET runtime_status='idle'", [])
            .unwrap();
        let prepare = |id: &str, requirements: i64, content: i64| {
            prepare_native_command(
                &connection,
                &RuntimeAccountContext {
                    account_scope: "synthetic-account".into(),
                    generation: 1,
                },
                current.host_device_id.clone(),
                current.binding.clone(),
                RuntimeCommandInput {
                    request_id: id.into(),
                    todo_id: current.todo_id.clone(),
                    session_id: current.binding.session_id.clone(),
                    expected_requirements_version: requirements,
                    expected_content_version: content,
                    expected_binding_version: 3,
                    native_turn_id: None,
                    queue_after_turn: false,
                    intent: NativeCodexIntent::Prompt { text: id.into() },
                    submitted_by: CommandSubmitter::User,
                },
            )
            .unwrap()
        };
        let old = prepare("old-version", 2, 3);
        claim_native_command(&connection, &old.id).unwrap();
        apply_native_receipt(
            &connection,
            &old.id,
            RuntimeCommandState::Acknowledged,
            &native_runtime_event(
                &old,
                1,
                "turn/start:accepted",
                "old-turn",
                json!({"turn":{"id":"old-turn"}}),
            ),
        )
        .unwrap();
        apply_native_receipt(
            &connection,
            &old.id,
            RuntimeCommandState::Completed,
            &native_runtime_event(
                &old,
                2,
                "turn/completed",
                "old-turn",
                json!({"threadId":"original-thread","turn":{"id":"old-turn","status":"completed"}}),
            ),
        )
        .unwrap();
        connection
            .execute(
                "UPDATE work_card_states SET requirements_version=3,content_version=4",
                [],
            )
            .unwrap();
        let new = prepare("new-version", 3, 4);
        assert!(
            run_spec_for_event(&connection, &current.binding.session_id, "new-turn")
                .unwrap()
                .is_none()
        );
        claim_native_command(&connection, &new.id).unwrap();
        // A late old-turn notification wins over the new, not-yet-acknowledged prompt.
        let old_spec = run_spec_for_event(&connection, &current.binding.session_id, "old-turn")
            .unwrap()
            .unwrap();
        assert_eq!(
            (
                old_spec.expected.requirements_version,
                old_spec.expected.content_version
            ),
            (2, 3)
        );
        let new_spec = run_spec_for_event(&connection, &current.binding.session_id, "new-turn")
            .unwrap()
            .unwrap();
        assert_eq!(
            (
                new_spec.expected.requirements_version,
                new_spec.expected.content_version
            ),
            (3, 4)
        );
        apply_native_receipt(
            &connection,
            &new.id,
            RuntimeCommandState::Acknowledged,
            &native_runtime_event(
                &new,
                3,
                "turn/start:accepted",
                "new-turn",
                json!({"turn":{"id":"new-turn"}}),
            ),
        )
        .unwrap();
        let accepted = run_spec_for_event(&connection, &current.binding.session_id, "new-turn")
            .unwrap()
            .unwrap();
        assert_eq!(
            (
                accepted.expected.requirements_version,
                accepted.expected.content_version
            ),
            (3, 4)
        );
    }
}
