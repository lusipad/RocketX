//! Native command admission and receipts share the existing dispatch outbox.
//! Only a native adapter may call these functions; they are not raw IPC setters.
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use super::{
    butler_ledger::{get_dispatch_action_by_key, row_to_dispatch_action},
    butler_runtime_events::append_runtime_event,
    now_millis, DispatchActionRecord, RuntimeAccountContext, RuntimeEvent,
};
use crate::native::work_command::{
    CommandSubmitter, NativeCodexIntent, NativeCommandBinding, NativeCommandScope,
    NativeCommandSpec, RuntimeCommandInput, RuntimeCommandState,
};

const COMMAND_COLUMNS: &str = "id,idempotency_key,todo_id,event_id,session_id,action_kind,spec_json,baseline_marker,state,receipt_ref,error_message,created_at,updated_at";

fn transaction<T>(
    connection: &Connection,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    connection
        .execute_batch("SAVEPOINT native_work_command;")
        .map_err(|error| error.to_string())?;
    match operation() {
        Ok(value) => {
            connection
                .execute_batch("RELEASE native_work_command;")
                .map_err(|error| error.to_string())?;
            Ok(value)
        }
        Err(error) => {
            let _ = connection
                .execute_batch("ROLLBACK TO native_work_command; RELEASE native_work_command;");
            Err(error)
        }
    }
}

pub(crate) fn read_native_command(
    connection: &Connection,
    id: &str,
) -> Result<DispatchActionRecord, String> {
    connection
        .query_row(
            &format!("SELECT {COMMAND_COLUMNS} FROM dispatch_actions WHERE id=?1"),
            [id],
            row_to_dispatch_action,
        )
        .map_err(|error| format!("无法读取原生命令：{error}"))
}

pub(crate) fn read_native_command_spec(
    record: &DispatchActionRecord,
) -> Result<NativeCommandSpec, String> {
    let spec: NativeCommandSpec =
        serde_json::from_str(&record.spec_json).map_err(|_| "原生命令合同无效")?;
    spec.validate()?;
    Ok(spec)
}

/// Pending commands are read in admission order; terminal actions never re-enter dispatch.
pub(crate) fn list_native_session_commands(
    connection: &Connection,
    session_id: &str,
) -> Result<Vec<DispatchActionRecord>, String> {
    let mut statement = connection.prepare(&format!(
        "SELECT {COMMAND_COLUMNS} FROM dispatch_actions WHERE session_id=?1
         AND idempotency_key LIKE 'native-codex:v1:%'
         AND state IN ('prepared','dispatched','verifying_delivery','acknowledged') ORDER BY created_at,rowid"
    )).map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([session_id], row_to_dispatch_action)
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

/// The actor owns account/binding admission and the enclosing cancellation event.
pub(crate) fn cancel_queued_native_command(
    connection: &Connection,
    session_id: &str,
    request_id: &str,
) -> Result<DispatchActionRecord, String> {
    let key = format!("native-codex:v1:{request_id}");
    let record = get_dispatch_action_by_key(connection, &key)?.ok_or("排队指令不存在")?;
    let spec = read_native_command_spec(&record)?;
    if spec.request_id != request_id
        || spec.binding.session_id != session_id
        || record.session_id.as_deref() != Some(session_id)
        || record.action_kind != "session_prompt"
        || !matches!(spec.intent, NativeCodexIntent::Prompt { .. })
        || !spec.queue_after_turn
    {
        return Err("只能移除当前会话中尚未发送的排队指令".into());
    }
    let changed = connection
        .execute(
            "UPDATE dispatch_actions SET state='canceled',updated_at=?2
         WHERE id=?1 AND state='prepared' AND session_id=?3 AND spec_json=?4",
            params![record.id, now_millis(), session_id, record.spec_json],
        )
        .map_err(|error| error.to_string())?;
    if changed != 1 {
        return Err("排队指令已被认领或结束，不能移除".into());
    }
    read_native_command(connection, &record.id)
}

fn verify_current_binding(connection: &Connection, spec: &NativeCommandSpec) -> Result<(), String> {
    let identity: (
        String,
        String,
        String,
        String,
        String,
        i64,
        String,
        Option<String>,
    ) = connection
        .query_row(
            "SELECT COALESCE(todo_id,''),native_session_id,source_scope,workspace_root,
                COALESCE(account_scope,''),binding_version,runtime_owner,host_device_id
         FROM work_sessions WHERE id=?1",
            [&spec.binding.session_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                ))
            },
        )
        .map_err(|_| "原生会话绑定不存在")?;
    if identity.0 != spec.todo_id
        || identity.1 != spec.binding.native_thread_id
        || identity.2 != spec.binding.source_scope
        || identity.3 != spec.binding.workspace_root
        || identity.4 != spec.scope.account_scope
        || identity.5 != spec.binding.binding_version
        || identity.6 != "native_host"
        || identity.7.as_deref() != Some(&spec.scope.host_device_id)
    {
        return Err("会话身份、来源、账号、设备或绑定版本已变化".into());
    }
    let profile: Option<String> = connection.query_row(
        "SELECT json_extract(config_snapshot_json,'$.executionProfileId') FROM work_sessions WHERE id=?1",
        [&spec.binding.session_id], |row| row.get(0),
    ).map_err(|_| "无法核对原生执行配置")?;
    if profile.as_deref() != Some(&spec.binding.execution_profile_id) {
        return Err("原生执行配置已变化".into());
    }
    Ok(())
}

fn verify_work(connection: &Connection, spec: &NativeCommandSpec) -> Result<(), String> {
    let work: (i64,i64,String,String,i64,i64,i64) = connection.query_row(
        "SELECT requirements_version,content_version,wait_state,autonomy_mode,max_auto_turns,auto_turns_used,consecutive_failures
         FROM work_card_states WHERE todo_id=?1", [&spec.todo_id],
        |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?)),
    ).map_err(|_| "工作不存在或尚未建立要求版本")?;
    if work.0 != spec.expected.requirements_version || work.1 != spec.expected.content_version {
        return Err("工作要求或成果版本已变化，请核对后重新提交".into());
    }
    if matches!(
        spec.intent,
        NativeCodexIntent::Prompt { .. } | NativeCodexIntent::Steer { .. }
    ) && (matches!(work.2.as_str(), "paused" | "canceled") || work.3 == "readonly")
    {
        return Err("当前工作已暂停、取消或只读，不能开始新的执行".into());
    }
    if matches!(
        spec.intent,
        NativeCodexIntent::Prompt { .. } | NativeCodexIntent::Steer { .. }
    ) && spec.submitted_by != CommandSubmitter::User
        && (work.3 != "autonomous" || work.5 >= work.4 || work.6 >= 2)
    {
        return Err("自动推进未授权或预算已耗尽".into());
    }
    Ok(())
}

/// `binding` is inspected by the native connection owner, never supplied by UI.
pub(crate) fn prepare_native_command(
    connection: &Connection,
    account: &RuntimeAccountContext,
    host_device_id: String,
    binding: NativeCommandBinding,
    input: RuntimeCommandInput,
) -> Result<DispatchActionRecord, String> {
    input.validate()?;
    let key = format!("native-codex:v1:{}", input.request_id);
    transaction(connection, || {
        if let Some(existing) = get_dispatch_action_by_key(connection, &key)? {
            let frozen = read_native_command_spec(&existing)?;
            let original_input = RuntimeCommandInput {
                request_id: frozen.request_id.clone(),
                todo_id: frozen.todo_id.clone(),
                session_id: frozen.binding.session_id.clone(),
                expected_requirements_version: frozen.expected.requirements_version,
                expected_content_version: frozen.expected.content_version,
                expected_binding_version: frozen.binding.binding_version,
                native_turn_id: frozen.expected.native_turn_id.clone(),
                queue_after_turn: frozen.queue_after_turn,
                intent: frozen.intent.clone(),
                submitted_by: frozen.submitted_by,
            };
            if original_input != input
                || frozen.scope.account_scope != account.account_scope
                || frozen.scope.host_device_id != host_device_id
            {
                return Err("相同 requestId 对应不同原生命令".into());
            }
            return Ok(existing);
        }
        let spec = NativeCommandSpec::freeze(
            input,
            NativeCommandScope {
                account_scope: account.account_scope.clone(),
                account_generation: account.generation,
                host_device_id,
            },
            binding,
        )?;
        let action_kind = match spec.intent {
            NativeCodexIntent::Resume { .. } => "session_resume",
            NativeCodexIntent::Prompt { .. } => "session_prompt",
            NativeCodexIntent::Steer { .. } => "session_steer",
            NativeCodexIntent::Interrupt { .. } => "session_interrupt",
        };
        verify_current_binding(connection, &spec)?;
        verify_work(connection, &spec)?;
        if matches!(spec.intent, NativeCodexIntent::Prompt { .. }) && !spec.queue_after_turn {
            let status: String = connection
                .query_row(
                    "SELECT runtime_status FROM work_sessions WHERE id=?1",
                    [&spec.binding.session_id],
                    |row| row.get(0),
                )
                .map_err(|error| error.to_string())?;
            if !matches!(status.as_str(), "idle" | "interrupted") {
                return Err("这项工作还在执行，请追加到本轮或排队到下一轮".into());
            }
        }
        let now = now_millis();
        let id = uuid::Uuid::new_v4().to_string();
        connection.execute(
            "INSERT INTO dispatch_actions(id,idempotency_key,todo_id,session_id,action_kind,spec_json,state,created_at,updated_at)
             VALUES(?1,?2,?3,?4,?5,?6,'prepared',?7,?7)",
            params![id,key,spec.todo_id,spec.binding.session_id,action_kind,serde_json::to_string(&spec).map_err(|error| error.to_string())?,now],
        ).map_err(|error| format!("无法保存原生命令：{error}"))?;
        read_native_command(connection, &id)
    })
}

/// Sending ownership is committed before the adapter may write a single byte.
pub(crate) fn claim_native_command(
    connection: &Connection,
    id: &str,
) -> Result<DispatchActionRecord, String> {
    transaction(connection, || {
        let record = read_native_command(connection, id)?;
        let spec = read_native_command_spec(&record)?;
        if record.state != "prepared" {
            return Err("命令已经被认领或结果尚待核对，不能重复发送".into());
        }
        verify_current_binding(connection, &spec)?;
        verify_work(connection, &spec)?;
        let current: (String, Option<String>) = connection
            .query_row(
                "SELECT runtime_status,last_turn_id FROM work_sessions WHERE id=?1",
                [&spec.binding.session_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|error| error.to_string())?;
        match &spec.intent {
            NativeCodexIntent::Prompt { .. }
                if !matches!(current.0.as_str(), "idle" | "interrupted") =>
            {
                return Err("这项工作还在执行，不能开始第二轮".into())
            }
            NativeCodexIntent::Steer { .. }
                if current.0 != "running" || current.1 != spec.expected.native_turn_id =>
            {
                return Err("活动轮次已经变化，不能向旧轮次追加要求".into())
            }
            NativeCodexIntent::Interrupt { .. }
                if !matches!(
                    current.0.as_str(),
                    "running" | "waiting_input" | "waiting_approval"
                ) || current.1 != spec.expected.native_turn_id =>
            {
                return Err("活动轮次已经变化，不能中断旧轮次".into())
            }
            _ => {}
        }
        let other_sending: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM dispatch_actions WHERE session_id=?1 AND id!=?2 AND state IN('dispatched','verifying_delivery'))",
            params![spec.binding.session_id,id], |row| row.get(0),
        ).map_err(|error| error.to_string())?;
        // Restoring the original thread is needed to reconcile unknown delivery;
        // stopping a verified active turn also starts no new execution.
        let verified_stop = matches!(spec.intent, NativeCodexIntent::Interrupt { .. })
            && matches!(
                current.0.as_str(),
                "running" | "waiting_input" | "waiting_approval"
            )
            && current.1 == spec.expected.native_turn_id;
        if other_sending
            && !matches!(spec.intent, NativeCodexIntent::Resume { .. })
            && !verified_stop
        {
            return Err("原会话有尚未确认的投递，先核对后才能继续".into());
        }
        let changed = connection.execute(
            "UPDATE dispatch_actions SET state='dispatched',updated_at=?2 WHERE id=?1 AND state='prepared'", params![id,now_millis()],
        ).map_err(|error| error.to_string())?;
        if changed != 1 {
            return Err("命令已由其他执行者认领".into());
        }
        if spec.submitted_by != CommandSubmitter::User
            && matches!(
                spec.intent,
                NativeCodexIntent::Prompt { .. } | NativeCodexIntent::Steer { .. }
            )
        {
            connection.execute("UPDATE work_card_states SET auto_turns_used=auto_turns_used+1 WHERE todo_id=?1", [&spec.todo_id])
                .map_err(|error| error.to_string())?;
        }
        read_native_command(connection, id)
    })
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativeTurnReceipt {
    native_thread_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    native_turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    terminal_status: Option<String>,
}

/// Receipts and source events commit atomically. An RPC ack never proves a turn ended.
pub(crate) fn apply_native_receipt(
    connection: &Connection,
    id: &str,
    next: RuntimeCommandState,
    event: &RuntimeEvent,
) -> Result<DispatchActionRecord, String> {
    if !matches!(
        next,
        RuntimeCommandState::Acknowledged
            | RuntimeCommandState::Completed
            | RuntimeCommandState::Failed
            | RuntimeCommandState::VerifyingDelivery
    ) {
        return Err("回执不能准备、认领或重新发送命令".into());
    }
    transaction(connection, || {
        let record = read_native_command(connection, id)?;
        let spec = read_native_command_spec(&record)?;
        if event.action_id.as_deref() != Some(id)
            || event.todo_id != spec.todo_id
            || event.session_id != spec.binding.session_id
            || event.native_thread_id != spec.binding.native_thread_id
            || event.requirements_version != spec.expected.requirements_version
            || event.content_version != spec.expected.content_version
        {
            return Err("原生回执不属于该工作、命令或版本".into());
        }
        let current: RuntimeCommandState = serde_json::from_value(serde_json::json!(record.state))
            .map_err(|_| "原生命令状态无效")?;
        if !current.can_transition_to(next) {
            return Err("原生命令状态不能倒退或重新派发".into());
        }
        let turn = event
            .native_turn_id
            .as_deref()
            .filter(|value| !value.trim().is_empty());
        let previous: Option<NativeTurnReceipt> = record
            .receipt_ref
            .as_deref()
            .map(serde_json::from_str)
            .transpose()
            .map_err(|_| "原生接收回执无效")?;
        if let Some(turn) = turn {
            if spec
                .expected
                .native_turn_id
                .as_deref()
                .is_some_and(|expected| expected != turn)
                || previous.as_ref().is_some_and(|receipt| {
                    receipt.native_thread_id != event.native_thread_id
                        || receipt.native_turn_id.as_deref() != Some(turn)
                })
            {
                return Err("原生回执对应的活动轮次已经变化".into());
            }
        }
        let terminal = event.event_type == "turn/completed";
        let terminal_status = event
            .payload
            .pointer("/turn/status")
            .and_then(|value| value.as_str());
        if event
            .payload
            .get("threadId")
            .and_then(|value| value.as_str())
            .is_some_and(|thread| thread != event.native_thread_id)
            || ["/turn/id", "/turnId"].iter().any(|path| {
                event
                    .payload
                    .pointer(path)
                    .and_then(|value| value.as_str())
                    .is_some_and(|payload_turn| Some(payload_turn) != turn)
            })
        {
            return Err("原端回执正文与关联的线程或轮次不一致".into());
        }
        if terminal
            && (turn.is_none()
                || event
                    .payload
                    .get("threadId")
                    .and_then(|value| value.as_str())
                    != Some(event.native_thread_id.as_str())
                || event
                    .payload
                    .pointer("/turn/id")
                    .and_then(|value| value.as_str())
                    != turn)
        {
            return Err("结束事件正文与关联的原生线程或轮次不一致".into());
        }
        let resume = matches!(spec.intent, NativeCodexIntent::Resume { .. });
        let interrupt = matches!(spec.intent, NativeCodexIntent::Interrupt { .. });
        let resumed = event.event_type == "thread/resumed"
            && event
                .payload
                .pointer("/thread/id")
                .and_then(|value| value.as_str())
                == Some(event.native_thread_id.as_str())
            && turn.is_none();
        let accepted_method = match spec.intent {
            NativeCodexIntent::Resume { .. } => "thread/resumed",
            NativeCodexIntent::Prompt { .. } => "turn/start:accepted",
            NativeCodexIntent::Steer { .. } => "turn/steer:accepted",
            NativeCodexIntent::Interrupt { .. } => "turn/interrupt:accepted",
        };
        let mut receipt = record.receipt_ref.clone();
        if next == RuntimeCommandState::Acknowledged {
            if event.event_type != accepted_method
                || (resume && !resumed)
                || (!resume && turn.is_none())
            {
                return Err("缺少原端接收回执".into());
            }
        }
        if next == RuntimeCommandState::Completed {
            if resume {
                if !resumed {
                    return Err("恢复必须由同一原生线程的 thread/resumed 事实完成".into());
                }
            } else {
                let expected_terminal = terminal
                    && if interrupt {
                        matches!(
                            terminal_status,
                            Some("completed" | "failed" | "interrupted")
                        )
                    } else {
                        terminal_status == Some("completed")
                    };
                if !expected_terminal {
                    return Err("缺少原端正常完成事实".into());
                }
                if !interrupt && previous.is_none() {
                    return Err("尚未核对原端接收轮次，不能完成该命令".into());
                }
            }
        }
        if next == RuntimeCommandState::Failed {
            let not_sent = event.event_type == "rpc/notSent"
                && event
                    .payload
                    .get("writeAttempted")
                    .and_then(|value| value.as_bool())
                    == Some(false);
            let rejected = event.event_type == "rpc/rejected"
                && matches!(
                    event
                        .payload
                        .pointer("/error/code")
                        .and_then(|value| value.as_i64()),
                    Some(-32600 | -32601 | -32602)
                );
            let failed_turn = !resume
                && !interrupt
                && terminal
                && matches!(terminal_status, Some("failed" | "interrupted"));
            if !not_sent && !rejected && !failed_turn {
                return Err("投递结果不确定，必须保留待核对状态，不能当作明确失败".into());
            }
            if failed_turn && previous.is_none() {
                return Err("尚未核对原端接收轮次".into());
            }
        }
        if matches!(
            next,
            RuntimeCommandState::Acknowledged | RuntimeCommandState::Completed
        ) || (next == RuntimeCommandState::Failed && terminal)
        {
            receipt = Some(
                serde_json::to_string(&NativeTurnReceipt {
                    native_thread_id: event.native_thread_id.clone(),
                    native_turn_id: turn.map(str::to_owned),
                    terminal_status: if terminal {
                        terminal_status.map(str::to_owned)
                    } else {
                        None
                    },
                })
                .map_err(|error| error.to_string())?,
            );
        }
        let event = append_runtime_event(connection, event)?;
        let next_name = serde_json::to_value(next).map_err(|error| error.to_string())?;
        let next_name = next_name.as_str().ok_or("原生命令状态无效")?;
        let changed = connection.execute(
            "UPDATE dispatch_actions SET state=?2,receipt_ref=?3,updated_at=?4 WHERE id=?1 AND state=?5",
            params![id,next_name,receipt,now_millis(),record.state],
        ).map_err(|error| error.to_string())?;
        if changed != 1 {
            return Err("命令回执已由其他执行者更新".into());
        }
        // Late facts remain on the original action; they cannot advance a rebound session.
        if current != next && verify_current_binding(connection, &spec).is_ok() && !resume {
            let status = match next {
                RuntimeCommandState::Acknowledged if !interrupt => Some("running"),
                RuntimeCommandState::Completed | RuntimeCommandState::Failed if terminal => {
                    Some(if terminal_status == Some("interrupted") {
                        "interrupted"
                    } else {
                        "idle"
                    })
                }
                RuntimeCommandState::VerifyingDelivery => Some("unknown"),
                _ => None,
            };
            if let Some(status) = status {
                connection.execute(
                    "UPDATE work_sessions SET runtime_status=?2,last_turn_id=COALESCE(?3,last_turn_id),last_event_seq=?4,last_verified_at=?5
                     WHERE id=?1 AND (?6=1 OR last_turn_id=?3)",
                    params![spec.binding.session_id,status,event.native_turn_id,event.sequence,now_millis(),
                        (next == RuntimeCommandState::Acknowledged && !interrupt)
                        || (next == RuntimeCommandState::VerifyingDelivery && record.receipt_ref.is_none())],
                ).map_err(|error| error.to_string())?;
            }
        }
        read_native_command(connection, id)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn database() -> Connection {
        let mut connection = Connection::open_in_memory().unwrap();
        super::super::migrate(&mut connection).unwrap();
        connection.execute_batch("
            INSERT INTO todos(id,title,created_at,updated_at) VALUES('original-work','work',1,1);
            INSERT INTO work_card_states(todo_id,requirements_version,content_version,autonomy_mode,updated_at)
                VALUES('original-work',2,3,'autonomous',1);
            INSERT INTO work_sessions(id,todo_id,runtime,native_session_id,source_scope,workspace_root,account_scope,
                control_mode,host_device_id,config_snapshot_json,last_verified_at,created_at,updated_at,binding_version,runtime_owner,runtime_status)
                VALUES('binding','original-work','codex','original-thread','codex:source','C:/work','account',
                    'controllable','device','{\"executionProfileId\":\"profile\"}',1,1,1,1,'native_host','idle');
        ").unwrap();
        connection
    }

    fn input() -> RuntimeCommandInput {
        RuntimeCommandInput {
            request_id: "request-1".into(),
            todo_id: "original-work".into(),
            session_id: "binding".into(),
            expected_requirements_version: 2,
            expected_content_version: 3,
            expected_binding_version: 1,
            native_turn_id: None,
            queue_after_turn: false,
            intent: NativeCodexIntent::Prompt {
                text: "do the work".into(),
            },
            submitted_by: CommandSubmitter::Automation,
        }
    }

    fn prepare(
        connection: &Connection,
        input: RuntimeCommandInput,
    ) -> Result<DispatchActionRecord, String> {
        prepare_native_command(
            connection,
            &RuntimeAccountContext {
                account_scope: "account".into(),
                generation: 1,
            },
            "device".into(),
            NativeCommandBinding {
                session_id: "binding".into(),
                native_thread_id: "original-thread".into(),
                source_scope: "codex:source".into(),
                execution_profile_id: "profile".into(),
                workspace_root: "C:/work".into(),
                binding_version: 1,
            },
            input,
        )
    }

    fn receipt(
        action: &DispatchActionRecord,
        sequence: i64,
        event_type: &str,
        turn: &str,
    ) -> RuntimeEvent {
        RuntimeEvent {
            sequence: 0,
            todo_id: "original-work".into(),
            session_id: "binding".into(),
            action_id: Some(action.id.clone()),
            event_type: event_type.into(),
            connection_id: "native-connection".into(),
            connection_sequence: sequence,
            native_thread_id: "original-thread".into(),
            native_turn_id: Some(turn.into()),
            requirements_version: 2,
            content_version: 3,
            payload: serde_json::json!({"threadId":"original-thread","turn":{"id":turn,"status":"completed"}}),
            received_at: 0,
        }
    }

    #[test]
    fn native_work_command_freezes_original_identity_and_rejects_conflicting_retry() {
        let connection = database();
        let first = prepare(&connection, input()).unwrap();
        assert_eq!(prepare(&connection, input()).unwrap().id, first.id);
        let mut changed = input();
        changed.intent = NativeCodexIntent::Prompt {
            text: "different".into(),
        };
        assert!(prepare(&connection, changed)
            .unwrap_err()
            .contains("requestId"));
        connection
            .execute("UPDATE work_sessions SET source_scope='another-source'", [])
            .unwrap();
        assert!(claim_native_command(&connection, &first.id)
            .unwrap_err()
            .contains("身份"));
        assert_eq!(
            read_native_command(&connection, &first.id).unwrap().state,
            "prepared"
        );
    }

    #[test]
    fn native_work_command_only_one_claim_spends_budget_and_unknown_never_resends() {
        let connection = database();
        let action = prepare(&connection, input()).unwrap();
        assert_eq!(
            claim_native_command(&connection, &action.id).unwrap().state,
            "dispatched"
        );
        assert!(claim_native_command(&connection, &action.id).is_err());
        assert_eq!(
            connection
                .query_row("SELECT auto_turns_used FROM work_card_states", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            1
        );
        let mut event = receipt(&action, 1, "runtime/disconnected", "turn-1");
        event.native_turn_id = None;
        event.payload = serde_json::json!({"reason":"synthetic disconnect before receipt"});
        assert!(
            apply_native_receipt(&connection, &action.id, RuntimeCommandState::Failed, &event)
                .is_err()
        );
        let mut second = input();
        second.request_id = "request-2".into();
        let second = prepare(&connection, second).unwrap();
        assert!(claim_native_command(&connection, &second.id).is_err());
        apply_native_receipt(
            &connection,
            &action.id,
            RuntimeCommandState::VerifyingDelivery,
            &event,
        )
        .unwrap();
        assert!(claim_native_command(&connection, &action.id).is_err());
        assert_eq!(
            read_native_command(&connection, &action.id).unwrap().state,
            "verifying_delivery"
        );
        assert!(claim_native_command(&connection, &second.id).is_err());
    }

    #[test]
    fn native_work_command_acceptance_is_not_completion_and_wrong_turn_cannot_finish() {
        let connection = database();
        let action = prepare(&connection, input()).unwrap();
        claim_native_command(&connection, &action.id).unwrap();
        assert_eq!(
            apply_native_receipt(
                &connection,
                &action.id,
                RuntimeCommandState::Acknowledged,
                &receipt(&action, 1, "turn/start:accepted", "turn-1")
            )
            .unwrap()
            .state,
            "acknowledged"
        );
        assert!(apply_native_receipt(
            &connection,
            &action.id,
            RuntimeCommandState::Completed,
            &receipt(&action, 2, "turn/completed", "turn-wrong")
        )
        .is_err());
        let done = receipt(&action, 2, "turn/completed", "turn-1");
        assert_eq!(
            apply_native_receipt(
                &connection,
                &action.id,
                RuntimeCommandState::Completed,
                &done
            )
            .unwrap()
            .state,
            "completed"
        );
        connection
            .execute(
                "UPDATE work_sessions SET runtime_status='running',last_turn_id='new-turn'",
                [],
            )
            .unwrap();
        apply_native_receipt(
            &connection,
            &action.id,
            RuntimeCommandState::Completed,
            &done,
        )
        .unwrap();
        assert_eq!(
            connection
                .query_row("SELECT runtime_status FROM work_sessions", [], |row| row
                    .get::<_, String>(
                    0
                ))
                .unwrap(),
            "running"
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM work_runtime_events", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            2
        );
    }

    #[test]
    fn native_work_command_stale_versions_and_paused_work_reject_before_send() {
        for sql in [
            "UPDATE work_card_states SET requirements_version=3",
            "UPDATE work_card_states SET wait_state='paused'",
        ] {
            let connection = database();
            let action = prepare(&connection, input()).unwrap();
            connection.execute(sql, []).unwrap();
            assert!(claim_native_command(&connection, &action.id).is_err());
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
    }

    #[test]
    fn native_work_command_event_failure_rolls_back_receipt_and_projection() {
        let connection = database();
        let action = prepare(&connection, input()).unwrap();
        claim_native_command(&connection, &action.id).unwrap();
        connection.execute_batch("CREATE TRIGGER fail_runtime_event BEFORE INSERT ON work_runtime_events BEGIN SELECT RAISE(ABORT,'injected'); END;").unwrap();
        assert!(apply_native_receipt(
            &connection,
            &action.id,
            RuntimeCommandState::Acknowledged,
            &receipt(&action, 1, "turn/start:accepted", "turn-1")
        )
        .is_err());
        assert_eq!(
            read_native_command(&connection, &action.id).unwrap().state,
            "dispatched"
        );
        assert_eq!(
            connection
                .query_row("SELECT runtime_status FROM work_sessions", [], |row| row
                    .get::<_, String>(
                    0
                ))
                .unwrap(),
            "idle"
        );
    }

    #[test]
    fn native_work_command_retry_keeps_frozen_generation_and_binding_after_reconnect() {
        let connection = database();
        let action = prepare(&connection, input()).unwrap();
        let frozen = read_native_command_spec(&action).unwrap();
        connection
            .execute(
                "UPDATE work_sessions SET binding_version=2,source_scope='reconnected-source'",
                [],
            )
            .unwrap();
        let mut binding = frozen.binding.clone();
        binding.binding_version = 2;
        binding.source_scope = "reconnected-source".into();
        let retried = prepare_native_command(
            &connection,
            &RuntimeAccountContext {
                account_scope: "account".into(),
                generation: 99,
            },
            "device".into(),
            binding.clone(),
            input(),
        )
        .unwrap();
        assert_eq!(retried.id, action.id);
        assert_eq!(retried.spec_json, action.spec_json);
        assert_eq!(
            read_native_command_spec(&retried)
                .unwrap()
                .scope
                .account_generation,
            1
        );
        assert!(claim_native_command(&connection, &action.id).is_err());
        for changed in [
            RuntimeCommandInput {
                expected_binding_version: 2,
                ..input()
            },
            RuntimeCommandInput {
                expected_content_version: 4,
                ..input()
            },
            RuntimeCommandInput {
                todo_id: "another-work".into(),
                ..input()
            },
            RuntimeCommandInput {
                queue_after_turn: true,
                ..input()
            },
        ] {
            assert!(prepare_native_command(
                &connection,
                &RuntimeAccountContext {
                    account_scope: "account".into(),
                    generation: 99
                },
                "device".into(),
                binding.clone(),
                changed
            )
            .unwrap_err()
            .contains("requestId"));
        }
    }

    #[test]
    fn native_work_command_queue_persists_until_original_session_is_idle() {
        let connection = database();
        let first = prepare(&connection, input()).unwrap();
        claim_native_command(&connection, &first.id).unwrap();
        apply_native_receipt(
            &connection,
            &first.id,
            RuntimeCommandState::Acknowledged,
            &receipt(&first, 1, "turn/start:accepted", "turn-1"),
        )
        .unwrap();
        let next_input = RuntimeCommandInput {
            request_id: "queued".into(),
            queue_after_turn: true,
            ..input()
        };
        let queued = prepare(&connection, next_input.clone()).unwrap();
        assert!(read_native_command_spec(&queued).unwrap().queue_after_turn);
        assert_eq!(prepare(&connection, next_input).unwrap().id, queued.id);
        assert!(prepare(
            &connection,
            RuntimeCommandInput {
                request_id: "immediate".into(),
                ..input()
            }
        )
        .is_err());
        assert!(claim_native_command(&connection, &queued.id).is_err());
        assert_eq!(
            list_native_session_commands(&connection, "binding")
                .unwrap()
                .len(),
            2
        );
        apply_native_receipt(
            &connection,
            &first.id,
            RuntimeCommandState::Completed,
            &receipt(&first, 2, "turn/completed", "turn-1"),
        )
        .unwrap();
        assert_eq!(
            list_native_session_commands(&connection, "binding").unwrap()[0].id,
            queued.id
        );
        assert_eq!(
            claim_native_command(&connection, &queued.id).unwrap().state,
            "dispatched"
        );
        assert!(claim_native_command(&connection, &queued.id).is_err());
    }

    #[test]
    fn native_work_command_resume_requires_same_thread_fact_without_turn_or_budget() {
        let connection = database();
        let action = prepare(
            &connection,
            RuntimeCommandInput {
                intent: NativeCodexIntent::Resume {},
                ..input()
            },
        )
        .unwrap();
        assert_eq!(action.action_kind, "session_resume");
        claim_native_command(&connection, &action.id).unwrap();
        let mut event = receipt(&action, 1, "thread/resumed", "unused");
        event.native_turn_id = None;
        event.payload = serde_json::json!({"thread":{"id":"wrong-thread"}});
        assert!(apply_native_receipt(
            &connection,
            &action.id,
            RuntimeCommandState::Completed,
            &event
        )
        .is_err());
        event.payload =
            serde_json::json!({"thread":{"id":"original-thread","status":{"type":"idle"}}});
        let done = apply_native_receipt(
            &connection,
            &action.id,
            RuntimeCommandState::Completed,
            &event,
        )
        .unwrap();
        assert_eq!(done.state, "completed");
        assert!(
            serde_json::from_str::<serde_json::Value>(done.receipt_ref.as_ref().unwrap())
                .unwrap()
                .get("nativeTurnId")
                .is_none()
        );
        assert_eq!(
            connection
                .query_row("SELECT auto_turns_used FROM work_card_states", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            0
        );
        assert!(apply_native_receipt(
            &connection,
            &action.id,
            RuntimeCommandState::Acknowledged,
            &event
        )
        .is_err());
    }

    #[test]
    fn native_work_command_interrupt_ack_is_not_completion_and_keeps_terminal_fact() {
        for terminal_status in ["completed", "failed", "interrupted"] {
            let connection = database();
            connection
                .execute(
                    "UPDATE work_sessions SET runtime_status='running',last_turn_id='turn-1'",
                    [],
                )
                .unwrap();
            connection
                .execute("UPDATE work_card_states SET wait_state='paused'", [])
                .unwrap();
            let action = prepare(
                &connection,
                RuntimeCommandInput {
                    intent: NativeCodexIntent::Interrupt {},
                    native_turn_id: Some("turn-1".into()),
                    ..input()
                },
            )
            .unwrap();
            assert_eq!(action.action_kind, "session_interrupt");
            claim_native_command(&connection, &action.id).unwrap();
            let ack = receipt(&action, 1, "turn/interrupt:accepted", "turn-1");
            assert!(apply_native_receipt(
                &connection,
                &action.id,
                RuntimeCommandState::Completed,
                &ack
            )
            .is_err());
            let acknowledged = apply_native_receipt(
                &connection,
                &action.id,
                RuntimeCommandState::Acknowledged,
                &ack,
            )
            .unwrap();
            assert_eq!(acknowledged.state, "acknowledged");
            let mut done = receipt(&action, 2, "turn/completed", "turn-1");
            done.payload["turn"]["status"] = serde_json::json!(terminal_status);
            let completed = apply_native_receipt(
                &connection,
                &action.id,
                RuntimeCommandState::Completed,
                &done,
            )
            .unwrap();
            assert_eq!(completed.state, "completed");
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(completed.receipt_ref.as_ref().unwrap())
                    .unwrap()["terminalStatus"],
                terminal_status
            );
            assert_eq!(
                connection
                    .query_row("SELECT auto_turns_used FROM work_card_states", [], |row| {
                        row.get::<_, i64>(0)
                    })
                    .unwrap(),
                0
            );
            assert!(apply_native_receipt(
                &connection,
                &action.id,
                RuntimeCommandState::Acknowledged,
                &ack
            )
            .is_err());
        }
    }

    #[test]
    fn native_work_command_interrupt_can_receive_terminal_before_rpc_ack() {
        let connection = database();
        connection
            .execute(
                "UPDATE work_sessions SET runtime_status='running',last_turn_id='turn-1'",
                [],
            )
            .unwrap();
        let action = prepare(
            &connection,
            RuntimeCommandInput {
                intent: NativeCodexIntent::Interrupt {},
                native_turn_id: Some("turn-1".into()),
                ..input()
            },
        )
        .unwrap();
        claim_native_command(&connection, &action.id).unwrap();
        let mut done = receipt(&action, 1, "turn/completed", "turn-1");
        done.payload["turn"]["status"] = serde_json::json!("interrupted");
        assert_eq!(
            apply_native_receipt(
                &connection,
                &action.id,
                RuntimeCommandState::Completed,
                &done
            )
            .unwrap()
            .state,
            "completed"
        );
        assert!(apply_native_receipt(
            &connection,
            &action.id,
            RuntimeCommandState::Acknowledged,
            &receipt(&action, 2, "turn/interrupt:accepted", "turn-1")
        )
        .is_err());
    }

    #[test]
    fn native_work_command_interrupted_prompt_is_failed_and_late_fact_cannot_rebind() {
        let connection = database();
        let action = prepare(&connection, input()).unwrap();
        claim_native_command(&connection, &action.id).unwrap();
        apply_native_receipt(
            &connection,
            &action.id,
            RuntimeCommandState::Acknowledged,
            &receipt(&action, 1, "turn/start:accepted", "turn-1"),
        )
        .unwrap();
        connection.execute("UPDATE work_sessions SET binding_version=2,runtime_status='running',last_turn_id='turn-new'", []).unwrap();
        let mut done = receipt(&action, 2, "turn/completed", "turn-1");
        done.payload["turn"]["status"] = serde_json::json!("interrupted");
        assert!(apply_native_receipt(
            &connection,
            &action.id,
            RuntimeCommandState::Completed,
            &done
        )
        .is_err());
        assert_eq!(
            apply_native_receipt(&connection, &action.id, RuntimeCommandState::Failed, &done)
                .unwrap()
                .state,
            "failed"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT runtime_status,last_turn_id FROM work_sessions",
                    [],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                )
                .unwrap(),
            ("running".into(), "turn-new".into())
        );
    }

    #[test]
    fn native_work_command_rejects_ack_payload_from_wrong_thread_or_turn() {
        let connection = database();
        let action = prepare(&connection, input()).unwrap();
        claim_native_command(&connection, &action.id).unwrap();
        for (path, wrong) in [("threadId", "another-thread"), ("turnId", "another-turn")] {
            let mut event = receipt(&action, 1, "turn/start:accepted", "turn-1");
            event.payload[path] = serde_json::json!(wrong);
            assert!(apply_native_receipt(
                &connection,
                &action.id,
                RuntimeCommandState::Acknowledged,
                &event
            )
            .is_err());
            assert_eq!(
                read_native_command(&connection, &action.id).unwrap().state,
                "dispatched"
            );
        }
    }

    #[test]
    fn native_work_command_can_start_new_prompt_after_confirmed_interrupt() {
        let connection = database();
        connection
            .execute(
                "UPDATE work_sessions SET runtime_status='running',last_turn_id='turn-1'",
                [],
            )
            .unwrap();
        let stop = prepare(
            &connection,
            RuntimeCommandInput {
                intent: NativeCodexIntent::Interrupt {},
                native_turn_id: Some("turn-1".into()),
                ..input()
            },
        )
        .unwrap();
        claim_native_command(&connection, &stop.id).unwrap();
        let mut stopped = receipt(&stop, 1, "turn/completed", "turn-1");
        stopped.payload["turn"]["status"] = serde_json::json!("interrupted");
        apply_native_receipt(
            &connection,
            &stop.id,
            RuntimeCommandState::Completed,
            &stopped,
        )
        .unwrap();
        assert_eq!(
            connection
                .query_row("SELECT runtime_status FROM work_sessions", [], |row| row
                    .get::<_, String>(
                    0
                ))
                .unwrap(),
            "interrupted"
        );
        let next = prepare(
            &connection,
            RuntimeCommandInput {
                request_id: "after-stop".into(),
                ..input()
            },
        )
        .unwrap();
        assert_eq!(
            claim_native_command(&connection, &next.id).unwrap().state,
            "dispatched"
        );
    }

    #[test]
    fn native_work_command_cancels_only_unclaimed_queued_prompt_in_target_session() {
        let connection = database();
        let queued = prepare(
            &connection,
            RuntimeCommandInput {
                queue_after_turn: true,
                ..input()
            },
        )
        .unwrap();
        assert!(cancel_queued_native_command(&connection, "wrong-session", "request-1").is_err());
        connection
            .execute_batch("SAVEPOINT cancellation_with_event;")
            .unwrap();
        assert_eq!(
            cancel_queued_native_command(&connection, "binding", "request-1")
                .unwrap()
                .state,
            "canceled"
        );
        connection
            .execute_batch("ROLLBACK TO cancellation_with_event; RELEASE cancellation_with_event;")
            .unwrap();
        assert_eq!(
            read_native_command(&connection, &queued.id).unwrap().state,
            "prepared"
        );
        assert_eq!(
            cancel_queued_native_command(&connection, "binding", "request-1")
                .unwrap()
                .state,
            "canceled"
        );
        assert!(cancel_queued_native_command(&connection, "binding", "request-1").is_err());
        assert!(claim_native_command(&connection, &queued.id).is_err());
        assert!(list_native_session_commands(&connection, "binding")
            .unwrap()
            .is_empty());

        let immediate = prepare(
            &connection,
            RuntimeCommandInput {
                request_id: "immediate".into(),
                ..input()
            },
        )
        .unwrap();
        assert!(cancel_queued_native_command(&connection, "binding", "immediate").is_err());
        let claimed = prepare(
            &connection,
            RuntimeCommandInput {
                request_id: "claimed".into(),
                queue_after_turn: true,
                ..input()
            },
        )
        .unwrap();
        claim_native_command(&connection, &claimed.id).unwrap();
        assert!(cancel_queued_native_command(&connection, "binding", "claimed").is_err());
        assert_eq!(
            read_native_command(&connection, &immediate.id)
                .unwrap()
                .state,
            "prepared"
        );
        let resume = prepare(
            &connection,
            RuntimeCommandInput {
                request_id: "resume".into(),
                intent: NativeCodexIntent::Resume {},
                ..input()
            },
        )
        .unwrap();
        assert!(cancel_queued_native_command(&connection, "binding", "resume").is_err());
        assert_eq!(
            read_native_command(&connection, &resume.id).unwrap().state,
            "prepared"
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM work_runtime_events", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn native_work_command_pending_list_keeps_queue_and_controls_admission_order() {
        let connection = database();
        let mut expected = Vec::new();
        for (request, intent, queued, turn) in [
            (
                "queued-1",
                NativeCodexIntent::Prompt {
                    text: "first".into(),
                },
                true,
                None,
            ),
            (
                "stop",
                NativeCodexIntent::Interrupt {},
                false,
                Some("turn-1".into()),
            ),
            (
                "queued-2",
                NativeCodexIntent::Prompt {
                    text: "second".into(),
                },
                true,
                None,
            ),
        ] {
            let action = prepare(
                &connection,
                RuntimeCommandInput {
                    request_id: request.into(),
                    intent,
                    queue_after_turn: queued,
                    native_turn_id: turn,
                    ..input()
                },
            )
            .unwrap();
            expected.push(action.id);
        }
        connection
            .execute("UPDATE dispatch_actions SET created_at=1", [])
            .unwrap();
        assert_eq!(
            list_native_session_commands(&connection, "binding")
                .unwrap()
                .into_iter()
                .map(|record| record.id)
                .collect::<Vec<_>>(),
            expected
        );
    }

    #[test]
    fn native_work_command_unknown_blocks_execution_but_allows_resume_without_resolving_old_action()
    {
        let connection = database();
        let unknown = prepare(&connection, input()).unwrap();
        claim_native_command(&connection, &unknown.id).unwrap();
        let mut disconnected = receipt(&unknown, 1, "runtime/disconnected", "unused");
        disconnected.native_turn_id = None;
        disconnected.payload = serde_json::json!({"reason":"test disconnected"});
        apply_native_receipt(
            &connection,
            &unknown.id,
            RuntimeCommandState::VerifyingDelivery,
            &disconnected,
        )
        .unwrap();
        for (request, intent, status, turn) in [
            (
                "next-prompt",
                NativeCodexIntent::Prompt {
                    text: "next".into(),
                },
                "idle",
                None,
            ),
            (
                "steer",
                NativeCodexIntent::Steer {
                    text: "more".into(),
                },
                "running",
                Some("turn-1".into()),
            ),
        ] {
            connection
                .execute(
                    "UPDATE work_sessions SET runtime_status=?1,last_turn_id='turn-1'",
                    [status],
                )
                .unwrap();
            let action = prepare(
                &connection,
                RuntimeCommandInput {
                    request_id: request.into(),
                    intent,
                    native_turn_id: turn,
                    ..input()
                },
            )
            .unwrap();
            assert!(claim_native_command(&connection, &action.id)
                .unwrap_err()
                .contains("尚未确认"));
        }
        for (request_id, status, turn) in [
            ("wrong-stop", "running", "wrong-turn"),
            ("idle-stop", "idle", "turn-1"),
        ] {
            connection
                .execute(
                    "UPDATE work_sessions SET runtime_status=?1,last_turn_id='turn-1'",
                    [status],
                )
                .unwrap();
            let action = prepare(
                &connection,
                RuntimeCommandInput {
                    request_id: request_id.into(),
                    intent: NativeCodexIntent::Interrupt {},
                    native_turn_id: Some(turn.into()),
                    ..input()
                },
            )
            .unwrap();
            assert!(claim_native_command(&connection, &action.id)
                .unwrap_err()
                .contains("活动轮次"));
        }
        connection
            .execute("UPDATE work_sessions SET runtime_status='unknown'", [])
            .unwrap();
        let original = read_native_command(&connection, &unknown.id).unwrap();
        let resume = prepare(
            &connection,
            RuntimeCommandInput {
                request_id: "restore".into(),
                intent: NativeCodexIntent::Resume {},
                ..input()
            },
        )
        .unwrap();
        assert_eq!(
            claim_native_command(&connection, &resume.id).unwrap().state,
            "dispatched"
        );
        let mut resumed = receipt(&resume, 2, "thread/resumed", "unused");
        resumed.native_turn_id = None;
        resumed.payload =
            serde_json::json!({"thread":{"id":"original-thread","status":{"type":"idle"}}});
        apply_native_receipt(
            &connection,
            &resume.id,
            RuntimeCommandState::Completed,
            &resumed,
        )
        .unwrap();
        let still_unknown = read_native_command(&connection, &unknown.id).unwrap();
        assert_eq!(still_unknown.state, "verifying_delivery");
        assert_eq!(still_unknown.spec_json, original.spec_json);
        assert_eq!(still_unknown.receipt_ref, original.receipt_ref);
        assert_eq!(still_unknown.updated_at, original.updated_at);
        assert_eq!(
            connection
                .query_row("SELECT runtime_status FROM work_sessions", [], |row| row
                    .get::<_, String>(
                    0
                ))
                .unwrap(),
            "unknown"
        );
    }

    #[test]
    fn native_work_command_resume_can_load_paused_canceled_or_readonly_work() {
        for policy in [
            "UPDATE work_card_states SET wait_state='paused'",
            "UPDATE work_card_states SET wait_state='canceled'",
            "UPDATE work_card_states SET autonomy_mode='readonly'",
        ] {
            let connection = database();
            connection.execute(policy, []).unwrap();
            let action = prepare(
                &connection,
                RuntimeCommandInput {
                    intent: NativeCodexIntent::Resume {},
                    ..input()
                },
            )
            .unwrap();
            assert_eq!(
                claim_native_command(&connection, &action.id).unwrap().state,
                "dispatched"
            );
            assert!(prepare(
                &connection,
                RuntimeCommandInput {
                    request_id: "execute".into(),
                    ..input()
                }
            )
            .is_err());
            assert_eq!(
                connection
                    .query_row("SELECT auto_turns_used FROM work_card_states", [], |row| {
                        row.get::<_, i64>(0)
                    })
                    .unwrap(),
                0
            );
        }
    }

    #[test]
    fn native_work_command_unknown_steer_still_allows_verified_stop_without_resending() {
        for active_status in ["running", "waiting_input", "waiting_approval"] {
            let connection = database();
            let prompt = prepare(&connection, input()).unwrap();
            claim_native_command(&connection, &prompt.id).unwrap();
            apply_native_receipt(
                &connection,
                &prompt.id,
                RuntimeCommandState::Acknowledged,
                &receipt(&prompt, 1, "turn/start:accepted", "turn-1"),
            )
            .unwrap();
            let steer = prepare(
                &connection,
                RuntimeCommandInput {
                    request_id: "steer-unknown".into(),
                    intent: NativeCodexIntent::Steer {
                        text: "more".into(),
                    },
                    native_turn_id: Some("turn-1".into()),
                    ..input()
                },
            )
            .unwrap();
            claim_native_command(&connection, &steer.id).unwrap();
            let mut rejected = receipt(&steer, 2, "rpc/rejected", "turn-1");
            rejected.payload =
                serde_json::json!({"error":{"code":-32603,"message":"internal error"}});
            assert!(apply_native_receipt(
                &connection,
                &steer.id,
                RuntimeCommandState::Failed,
                &rejected
            )
            .is_err());
            apply_native_receipt(
                &connection,
                &steer.id,
                RuntimeCommandState::VerifyingDelivery,
                &rejected,
            )
            .unwrap();
            // The live actor retains the native active-turn fact after this RPC error.
            connection
                .execute(
                    "UPDATE work_sessions SET runtime_status=?1,last_turn_id='turn-1'",
                    [active_status],
                )
                .unwrap();
            let stop = prepare(
                &connection,
                RuntimeCommandInput {
                    request_id: "stop".into(),
                    intent: NativeCodexIntent::Interrupt {},
                    native_turn_id: Some("turn-1".into()),
                    ..input()
                },
            )
            .unwrap();
            claim_native_command(&connection, &stop.id).unwrap();
            let ack = receipt(&stop, 3, "turn/interrupt:accepted", "turn-1");
            assert!(apply_native_receipt(
                &connection,
                &stop.id,
                RuntimeCommandState::Completed,
                &ack
            )
            .is_err());
            assert_eq!(
                apply_native_receipt(
                    &connection,
                    &stop.id,
                    RuntimeCommandState::Acknowledged,
                    &ack
                )
                .unwrap()
                .state,
                "acknowledged"
            );
            assert!(apply_native_receipt(
                &connection,
                &stop.id,
                RuntimeCommandState::Completed,
                &receipt(&stop, 4, "turn/completed", "wrong-turn")
            )
            .is_err());
            let mut done = receipt(&stop, 4, "turn/completed", "turn-1");
            done.payload["turn"]["status"] = serde_json::json!("interrupted");
            assert_eq!(
                apply_native_receipt(&connection, &stop.id, RuntimeCommandState::Completed, &done)
                    .unwrap()
                    .state,
                "completed"
            );
            let still_unknown = read_native_command(&connection, &steer.id).unwrap();
            assert_eq!(still_unknown.state, "verifying_delivery");
            assert!(still_unknown.receipt_ref.is_none());
            assert!(claim_native_command(&connection, &steer.id).is_err());
            let next = prepare(
                &connection,
                RuntimeCommandInput {
                    request_id: "after-stop".into(),
                    ..input()
                },
            )
            .unwrap();
            assert!(claim_native_command(&connection, &next.id)
                .unwrap_err()
                .contains("尚未确认"));
        }
    }
}
