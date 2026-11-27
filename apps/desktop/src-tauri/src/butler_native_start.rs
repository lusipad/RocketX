//! Durable, user-requested creation of an empty Codex thread. This is a creation
//! receipt alongside the existing outbox, not another execution scheduler.
use super::*;
use serde::{Deserialize, Serialize};
use std::{fs::File, sync::Weak};

#[path = "butler_native_start_validation.rs"]
mod validation;

const START_SCHEMA: &str = "rocketx.native-work-start.v1";
const NOT_STARTED: &str = "rocketx.native-start.not-started.v1:";

pub(super) fn migrate_native_starts(connection: &Connection) -> Result<(), String> {
    connection.execute_batch("CREATE TABLE IF NOT EXISTS work_native_starts (
        request_id TEXT PRIMARY KEY,
        todo_id TEXT NOT NULL UNIQUE,
        spec_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN('prepared','dispatched','not_sent','unknown','thread_created','bound')),
        owner_id TEXT NOT NULL,
        process_id TEXT,
        process_stopped INTEGER NOT NULL DEFAULT 1,
        native_thread_id TEXT,
        error_message TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );").map_err(|error| format!("无法初始化原生工作启动记录：{error}"))
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeWorkStartInput {
    pub account: RuntimeAccountContext,
    pub todo_id: String,
    pub request_id: String,
    pub workspace_root: String,
    pub execution_profile_id: String,
    pub expected_requirements_version: i64,
    pub expected_content_version: i64,
    pub host_device_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StartSpec {
    schema: String,
    request_id: String,
    todo_id: String,
    account: RuntimeAccountContext,
    session_id: String,
    host_device_id: String,
    workspace_root: String,
    execution_profile_id: String,
    profile_fingerprint: String,
    source_scope: String,
    requirements_version: i64,
    content_version: i64,
    title: String,
    goal: String,
}

#[derive(Clone)]
struct StartRecord {
    spec: StartSpec,
    state: String,
    owner_id: String,
    process_id: Option<String>,
    process_stopped: bool,
    native_thread_id: Option<String>,
    error: Option<String>,
}

fn read_start(connection: &Connection, todo_id: &str) -> Result<Option<StartRecord>, String> {
    let row: Option<(String,String,String,Option<String>,Option<String>,Option<String>,bool)> = connection.query_row(
        "SELECT spec_json,state,owner_id,process_id,native_thread_id,error_message,process_stopped FROM work_native_starts WHERE todo_id=?1",
        [todo_id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?)),
    ).optional().map_err(|error| error.to_string())?;
    row.map(
        |(spec, state, owner_id, process_id, native_thread_id, error, process_stopped)| {
            let spec: StartSpec = serde_json::from_str(&spec)
                .map_err(|_| "工作启动归属记录损坏，不能重新创建线程")?;
            if spec.schema != START_SCHEMA || spec.todo_id != todo_id {
                return Err("工作启动身份不一致，不能重新创建线程".into());
            }
            Ok(StartRecord {
                spec,
                state,
                owner_id,
                process_id,
                process_stopped,
                native_thread_id,
                error,
            })
        },
    )
    .transpose()
}

fn validate_input(input: &NativeWorkStartInput) -> Result<(), String> {
    for (value, label, max) in [
        (&input.request_id, "requestId", 256),
        (&input.todo_id, "todoId", 256),
        (&input.host_device_id, "hostDeviceId", 256),
        (&input.execution_profile_id, "executionProfileId", 256),
    ] {
        if value.trim().is_empty() || value.len() > max || value.chars().any(char::is_control) {
            return Err(format!("{label}无效"));
        }
    }
    if input.expected_requirements_version < 0 || input.expected_content_version < 0 {
        return Err("工作版本无效".into());
    }
    Ok(())
}

fn identity(record: &StartRecord, input: &NativeWorkStartInput) -> Result<(), String> {
    if record.spec.request_id != input.request_id
        || record.spec.account.account_scope != input.account.account_scope
    {
        return Err("这项工作已有另一条启动归属；不会新建线程替代原请求".into());
    }
    Ok(())
}

fn replay_identity(record: &StartRecord, input: &NativeWorkStartInput) -> Result<(), String> {
    identity(record, input)?;
    if record.spec.execution_profile_id != input.execution_profile_id
        || record.spec.host_device_id != input.host_device_id
        || record.spec.requirements_version != input.expected_requirements_version
        || record.spec.content_version != input.expected_content_version
        || std::fs::canonicalize(&input.workspace_root)
            .ok()
            .filter(|path| path.is_dir())
            != std::fs::canonicalize(&record.spec.workspace_root)
                .ok()
                .filter(|path| path.is_dir())
        || std::fs::canonicalize(&input.workspace_root).is_err()
    {
        return Err(
            "同一启动请求的目录、执行配置、设备或要求版本已变化；原运行不代表新参数已生效".into(),
        );
    }
    Ok(())
}

fn pending_error(record: &StartRecord) -> String {
    format!(
        "原生工作创建结果仍待核对；不会重复创建。请求 {}{}{}",
        record.spec.request_id,
        record
            .native_thread_id
            .as_ref()
            .map(|thread| format!("，原线程 {thread}"))
            .unwrap_or_default(),
        record
            .error
            .as_ref()
            .map(|error| format!("：{error}"))
            .unwrap_or_default()
    )
}

struct StartLease {
    record: StartRecord,
    owner_guard: Option<File>,
    _previous_guard: Option<File>,
}

fn reserve_start(
    connection: &Connection,
    directory: &Path,
    mut spec: StartSpec,
) -> Result<StartLease, String> {
    connection
        .execute_batch("SAVEPOINT native_start_reserve;")
        .map_err(|error| error.to_string())?;
    let result = (|| {
        let prior = read_start(connection, &spec.todo_id)?;
        let mut previous_guard = None;
        if let Some(prior) = &prior {
            if prior.spec.request_id != spec.request_id
                || prior.spec.account.account_scope != spec.account.account_scope
            {
                return Err("工作或请求的启动身份已变化".into());
            }
            if !matches!(
                prior.state.as_str(),
                "prepared" | "not_sent" | "thread_created"
            ) {
                return Err(pending_error(prior));
            }
            previous_guard =
                butler_native_admission::recover_connection_guard(directory, &prior.owner_id, 1)?;
            if previous_guard.is_none() {
                return Err("旧启动归属无法核实，尚未允许重新创建".into());
            }
            spec.session_id = prior.spec.session_id.clone();
            if prior.native_thread_id.is_some() {
                let mut comparable = spec.clone();
                comparable.account = prior.spec.account.clone();
                if comparable != prior.spec {
                    return Err("原线程已经创建，目录、配置或要求不能改写为另一个新线程".into());
                }
                spec = prior.spec.clone();
            }
        }
        let owner_id = uuid::Uuid::new_v4().to_string();
        let owner_guard = butler_native_admission::connection_guard(directory, &owner_id)?;
        let now = now_millis();
        let thread = prior
            .as_ref()
            .and_then(|prior| prior.native_thread_id.clone());
        let state = if thread.is_some() {
            "thread_created"
        } else {
            "prepared"
        };
        let process_id = prior.as_ref().and_then(|prior| prior.process_id.clone());
        connection.execute("INSERT INTO work_native_starts(request_id,todo_id,spec_json,state,owner_id,process_id,native_thread_id,created_at,updated_at)
            VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?8)
            ON CONFLICT(todo_id) DO UPDATE SET spec_json=excluded.spec_json,state=excluded.state,owner_id=excluded.owner_id,error_message=NULL,updated_at=excluded.updated_at",
            params![spec.request_id,spec.todo_id,serde_json::to_string(&spec).map_err(|error|error.to_string())?,state,owner_id,process_id,thread,now])
            .map_err(|error|error.to_string())?;
        let process_stopped = prior.as_ref().map_or(true, |prior| prior.process_stopped);
        Ok(StartLease {
            record: StartRecord {
                spec,
                state: state.into(),
                owner_id,
                process_id,
                process_stopped,
                native_thread_id: thread,
                error: None,
            },
            owner_guard: Some(owner_guard),
            _previous_guard: previous_guard,
        })
    })();
    match result {
        Ok(lease) => {
            connection
                .execute_batch("RELEASE native_start_reserve;")
                .map_err(|error| error.to_string())?;
            Ok(lease)
        }
        Err(error) => {
            let _ = connection
                .execute_batch("ROLLBACK TO native_start_reserve; RELEASE native_start_reserve;");
            Err(error)
        }
    }
}

fn claim_creation(connection: &Connection, record: &StartRecord) -> Result<(), String> {
    let changed=connection.execute("UPDATE work_native_starts SET state='dispatched',updated_at=?3 WHERE request_id=?1 AND owner_id=?2 AND state='prepared' AND native_thread_id IS NULL",
        params![record.spec.request_id,record.owner_id,now_millis()]).map_err(|error|error.to_string())?;
    if changed != 1 {
        return Err("原生创建请求已被认领，不能重复 thread/start".into());
    }
    Ok(())
}

fn record_created(
    connection: &Connection,
    record: &StartRecord,
    thread_id: &str,
) -> Result<(), String> {
    let changed=connection.execute("UPDATE work_native_starts SET state='thread_created',native_thread_id=?3,updated_at=?4 WHERE request_id=?1 AND owner_id=?2 AND state='dispatched' AND native_thread_id IS NULL",
        params![record.spec.request_id,record.owner_id,thread_id,now_millis()]).map_err(|error|error.to_string())?;
    if changed != 1 {
        return Err("原端已经返回线程，但创建回执归属无法持久核实；不会重新创建".into());
    }
    Ok(())
}

fn failure(
    connection: &Connection,
    record: &StartRecord,
    known_not_sent: bool,
    error: &str,
    stopped: bool,
) -> Result<(), String> {
    connection.execute("UPDATE work_native_starts SET state=CASE WHEN native_thread_id IS NOT NULL THEN state WHEN state='prepared' OR ?3=1 THEN 'not_sent' ELSE 'unknown' END,
        error_message=?4,process_stopped=?5,updated_at=?6 WHERE request_id=?1 AND owner_id=?2 AND state!='bound'",
        params![record.spec.request_id,record.owner_id,known_not_sent,error.chars().take(1000).collect::<String>(),stopped,now_millis()]).map_err(|error|error.to_string())?;
    Ok(())
}

fn can_correct(
    connection: &Connection,
    directory: &Path,
    input: &NativeWorkStartInput,
) -> Result<bool, String> {
    let existing = read_start(connection, &input.todo_id)?;
    if let Some(record) = existing {
        identity(&record, input)?;
        if record.state != "not_sent" || record.native_thread_id.is_some() {
            return Ok(false);
        }
        let stopped: bool = connection
            .query_row(
                "SELECT process_stopped=1 FROM work_native_starts WHERE todo_id=?1",
                [&input.todo_id],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if !stopped {
            return Ok(false);
        }
        if butler_native_admission::recover_connection_guard(directory, &record.owner_id, 1)
            .is_err()
        {
            return Ok(false);
        }
    }
    let reserved:bool=connection.query_row("SELECT EXISTS(SELECT 1 FROM work_sessions WHERE todo_id=?1)
        OR EXISTS(SELECT 1 FROM dispatch_actions WHERE todo_id=?1 AND idempotency_key LIKE 'native-codex:v1:%')",
        [&input.todo_id],|row|row.get(0)).map_err(|error|error.to_string())?;
    Ok(!reserved)
}

fn created_thread_id(result: &Value) -> Result<&str, String> {
    result
        .pointer("/thread/id")
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty() && id.len() <= 512)
        .ok_or_else(|| "原端创建结果缺少可核对线程 ID，不会重复创建".into())
}

fn validate_empty_thread(spec: &StartSpec, thread: &Value) -> Result<(), String> {
    validate_resumed_workspace(&spec.workspace_root, thread)?;
    if thread.pointer("/status/type").and_then(Value::as_str) != Some("idle")
        || thread.get("ephemeral").and_then(Value::as_bool) != Some(false)
        || !thread
            .get("turns")
            .and_then(Value::as_array)
            .is_some_and(|turns| turns.is_empty())
        || thread
            .get("forkedFromId")
            .is_some_and(|value| !value.is_null())
        || thread
            .get("parentThreadId")
            .is_some_and(|value| !value.is_null())
    {
        return Err("新工作的线程并非空白，已保留创建记录并拒绝混入旧上下文".into());
    }
    Ok(())
}

#[derive(Default)]
struct StartEvents {
    owner: Option<Weak<NativeConnection>>,
    pending: Vec<InboundMessage>,
}

fn first_binding(
    connection: &Connection,
    record: &StartRecord,
    thread: &Value,
    metadata: &Value,
) -> Result<Binding, String> {
    let spec = &record.spec;
    let thread_id = thread
        .get("id")
        .and_then(Value::as_str)
        .ok_or("原端线程 ID 缺失")?;
    let config = json!({"provider":"codex","executionProfileId":spec.execution_profile_id,"sourceScope":spec.source_scope,
        "nativeStart":{"schema":START_SCHEMA,"requestId":spec.request_id,"firstPromptRequestId":spec.request_id},
        "nativeHost":metadata});
    connection.execute("INSERT INTO work_sessions(id,todo_id,visibility,runtime,origin,native_session_id,source_scope,title,workspace_root,account_scope,
        control_endpoint,control_mode,control_reason,host_device_id,runtime_status,binding_version,runtime_owner,config_snapshot_json,last_verified_at,created_at,updated_at)
        VALUES(?1,?2,'private','codex','butler',?3,?4,?5,?6,?7,?8,'controllable','native_host_owned',?9,'idle',1,'native_host',?10,?11,?11,?11)",
        params![spec.session_id,spec.todo_id,thread_id,spec.source_scope,spec.title,spec.workspace_root,spec.account.account_scope,
            format!("native-codex://{}",record.owner_id),spec.host_device_id,config.to_string(),now_millis()]).map_err(|error|error.to_string())?;
    binding(connection, &spec.session_id, &spec.account.account_scope)
}

fn persist_new_work(
    connection: &Connection,
    record: &StartRecord,
    thread: &Value,
    metadata: &Value,
) -> Result<Binding, String> {
    if connection.is_autocommit() {
        return Err("新工作绑定与首条要求必须在同一事务中持久保存".into());
    }
    let spec = &record.spec;
    let work = validation::validate_new_work(
        connection,
        &spec.todo_id,
        &spec.workspace_root,
        spec.requirements_version,
        spec.content_version,
    )?;
    if work.goal != spec.goal || work.workspace_root != spec.workspace_root {
        return Err("工作目标或目录已经变化，保留原线程且不发送目标".into());
    }
    validate_empty_thread(spec, thread)?;
    let binding = first_binding(connection, record, thread, metadata)?;
    prepare_native_command(
        connection,
        &spec.account,
        spec.host_device_id.clone(),
        binding.binding.clone(),
        RuntimeCommandInput {
            request_id: spec.request_id.clone(),
            todo_id: spec.todo_id.clone(),
            session_id: binding.binding.session_id.clone(),
            expected_requirements_version: spec.requirements_version,
            expected_content_version: spec.content_version,
            expected_binding_version: 1,
            native_turn_id: None,
            queue_after_turn: false,
            intent: NativeCodexIntent::Prompt {
                text: spec.goal.clone(),
            },
            submitted_by: CommandSubmitter::User,
        },
    )?;
    let changed=connection.execute("UPDATE work_native_starts SET state='bound',updated_at=?3 WHERE request_id=?1 AND owner_id=?2 AND state='thread_created' AND native_thread_id=?4",
        params![spec.request_id,record.owner_id,now_millis(),thread.get("id").and_then(Value::as_str)]).map_err(|error|error.to_string())?;
    if changed != 1 {
        return Err("原线程创建归属已变化，尚未开始目标执行".into());
    }
    Ok(binding)
}

fn bound_snapshot(
    admitted: &Arc<Mutex<Connection>>,
    runtime: &NativeWorkRuntime,
    input: &NativeWorkStartInput,
    record: &StartRecord,
) -> Result<NativeWorkSnapshot, String> {
    replay_identity(record, input)?;
    let native = runtime
        .connections
        .lock()
        .map_err(|_| "原生工作注册表不可用")?
        .get(&connection_key(&input.account, &record.spec.session_id))
        .cloned();
    let connection = admitted.lock().map_err(|_| "账号数据库不可用")?;
    let current = binding(
        &connection,
        &record.spec.session_id,
        &input.account.account_scope,
    )?;
    if current.binding.native_thread_id != record.native_thread_id.as_deref().unwrap_or("")
        || current.todo_id != input.todo_id
        || current.binding.execution_profile_id != record.spec.execution_profile_id
        || current.binding.source_scope != record.spec.source_scope
        || current.host_device_id != record.spec.host_device_id
    {
        return Err("原创建线程的绑定已经变化，不会新建替代线程".into());
    }
    if let Some(native) = native {
        if current.binding.binding_version == native.binding.binding.binding_version {
            let mut view = native
                .core
                .lock()
                .map_err(|_| "原生投影不可用")?
                .view
                .clone();
            view.commands = actions(&connection, &record.spec.session_id)?;
            return Ok(view);
        }
    }
    let mut view = stored_snapshot(&connection, &current)?;
    view.disconnected("这项工作已有原生线程；请恢复原会话核对，不会重新创建或重发首轮要求");
    Ok(view)
}

#[tauri::command]
pub async fn butler_native_work_start(
    app: tauri::AppHandle,
    db: tauri::State<'_, ButlerDb>,
    runtime: tauri::State<'_, NativeWorkRuntime>,
    input: NativeWorkStartInput,
) -> Result<NativeWorkSnapshot, String> {
    let result = start(&app, &db, &runtime, &input).await;
    match result {
        Ok(view) => Ok(view),
        Err(error) => {
            let safe = db
                .with_runtime_account_context(&input.account, || {
                    let admitted = db.connection();
                    let connection = admitted.lock().map_err(|_| "账号数据库不可用")?;
                    connection
                        .execute_batch("SAVEPOINT native_start_correction;")
                        .map_err(|error| error.to_string())?;
                    let check = can_correct(&connection, &db.directory, &input);
                    let release = connection
                        .execute_batch("RELEASE native_start_correction;")
                        .map_err(|error| error.to_string());
                    release?;
                    check
                })
                .unwrap_or(false);
            Err(if safe {
                format!("{NOT_STARTED}{error}")
            } else {
                error
            })
        }
    }
}

async fn start(
    app: &tauri::AppHandle,
    db: &ButlerDb,
    runtime: &NativeWorkRuntime,
    input: &NativeWorkStartInput,
) -> Result<NativeWorkSnapshot, String> {
    let admitted = db.connection_for_context(&input.account)?;
    validate_input(input)?;
    let previous = {
        let connection = admitted.lock().map_err(|_| "账号数据库不可用")?;
        read_start(&connection, &input.todo_id)?
    };
    if let Some(record) = previous {
        identity(&record, input)?;
        if record.state == "bound" {
            return bound_snapshot(&admitted, runtime, input, &record);
        }
        if matches!(record.state.as_str(), "dispatched" | "unknown") {
            return Err(pending_error(&record));
        }
    }
    let profile = crate::acp::native_codex_profile(app, &input.execution_profile_id)?;
    let fingerprint = profile.fingerprint().to_string();
    let mut lease = db.with_runtime_account_context(&input.account, || {
        let connection = admitted.lock().map_err(|_| "账号数据库不可用")?;
        let work = validation::validate_new_work(
            &connection,
            &input.todo_id,
            &input.workspace_root,
            input.expected_requirements_version,
            input.expected_content_version,
        )?;
        if work.goal.len() > crate::native::work_command::MAX_COMMAND_TEXT_BYTES {
            return Err("工作目标超过原生命令大小限制".into());
        }
        reserve_start(
            &connection,
            &db.directory,
            StartSpec {
                schema: START_SCHEMA.into(),
                request_id: input.request_id.clone(),
                todo_id: input.todo_id.clone(),
                account: input.account.clone(),
                session_id: uuid::Uuid::new_v4().to_string(),
                host_device_id: input.host_device_id.clone(),
                workspace_root: work.workspace_root,
                execution_profile_id: input.execution_profile_id.clone(),
                profile_fingerprint: fingerprint.clone(),
                source_scope: profile.source_scope.clone(),
                requirements_version: input.expected_requirements_version,
                content_version: input.expected_content_version,
                title: work.title,
                goal: work.goal,
            },
        )
    })?;
    let events = Arc::new(Mutex::new(StartEvents::default()));
    let mut process_id = None;
    let mut previous_stopped = lease.record.process_stopped;
    let mut known_not_sent = false;
    let outcome = async {
        if let Some(previous) = &lease.record.process_id {
            if crate::proc::stop_native_codex_if_registered(app, previous)? {
                previous_stopped = true;
            }
        }
        let sink = Arc::clone(&events);
        let handle = crate::proc::open_fresh_native_codex(
            app.clone(),
            format!("native-work-start-{}", lease.record.owner_id),
            lease.record.spec.workspace_root.clone(),
            profile,
            move |event| {
                let target = if let Ok(mut state) = sink.lock() {
                    if let Some(owner) = state.owner.as_ref().and_then(Weak::upgrade) {
                        Some(owner)
                    } else {
                        state.pending.push(event.clone());
                        None
                    }
                } else {
                    None
                };
                if let Some(owner) = target {
                    owner.receive(event);
                }
            },
        )
        .await?;
        process_id = Some(handle.info.process_id.clone());
        {
            let connection = admitted.lock().map_err(|_| "账号数据库不可用")?;
            connection.execute("UPDATE work_native_starts SET process_id=?3,process_stopped=0,updated_at=?4 WHERE request_id=?1 AND owner_id=?2",
                    params![input.request_id,lease.record.owner_id,handle.info.process_id,now_millis()]).map_err(|error|error.to_string())?;
        }
        if !crate::native::codex_contract::is_supported_codex_version(&handle.info.version) {
            return Err("所选 Codex 版本低于受管写控制基线（0.144.4），尚未创建线程".into());
        }
        let rpc = Arc::clone(&handle.rpc);
        tauri::async_runtime::spawn_blocking(move||->Result<(),String>{
                rpc.request("initialize",json!({"clientInfo":{"name":"rocketx_native_work","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":true}}),Duration::from_secs(20)).map_err(|error|error.to_string())?;
                rpc.notify("initialized",json!({})).map_err(|error|error.to_string())
            }).await.map_err(|error|error.to_string())??;
        let current_profile =
            crate::acp::native_codex_profile(app, &lease.record.spec.execution_profile_id)?;
        if current_profile.fingerprint() != lease.record.spec.profile_fingerprint {
            return Err("执行配置已变化，尚未开始新工作".into());
        }
        let rpc = Arc::clone(&handle.rpc);
        let spec = lease.record.spec.clone();
        let prior_thread = lease.record.native_thread_id.clone();
        if prior_thread.is_none() {
            db.with_runtime_account_context(&input.account, || {
                let connection = admitted.lock().map_err(|_| "账号数据库不可用")?;
                validation::validate_new_work(
                    &connection,
                    &input.todo_id,
                    &input.workspace_root,
                    input.expected_requirements_version,
                    input.expected_content_version,
                )?;
                claim_creation(&connection, &lease.record)
            })?;
        }
        let created = tauri::async_runtime::spawn_blocking(move || {
            if let Some(thread) = prior_thread {
                rpc.request(
                    "thread/resume",
                    json!({"threadId":thread,"cwd":spec.workspace_root}),
                    Duration::from_secs(30),
                )
            } else {
                // Omitted sandbox/approval/model options inherit the verified
                // profile. No seed turn or relaxed execution setting is used.
                rpc.request(
                    "thread/start",
                    json!({"cwd":spec.workspace_root,"ephemeral":false}),
                    Duration::from_secs(30),
                )
            }
        })
        .await
        .map_err(|error| error.to_string())?;
        let created = match created {
            Ok(created) => created,
            Err(error) => {
                known_not_sent = matches!(&error, RpcFailure::NotSent { .. })
                    || matches!(&error,RpcFailure::Rejected{error} if matches!(error.get("code").and_then(Value::as_i64),Some(-32600|-32601|-32602)));
                if lease.record.native_thread_id.is_some() {
                    return Err(format!("原线程已创建，第一条要求尚未确认，当前无法恢复；已保留原 ID，不会新建替代线程：{error}"));
                }
                return Err(error.to_string());
            }
        };
        let thread_id = created_thread_id(&created)?.to_string();
        if lease.record.native_thread_id.is_none() {
            // Preserve the real ID before account selection, policy validation,
            // binding, or prompt persistence can fail after the RPC succeeded.
            let connection = admitted.lock().map_err(|_| "原账号数据库不可用")?;
            record_created(&connection, &lease.record, &thread_id)?;
            lease.record.native_thread_id = Some(thread_id.clone());
            lease.record.state = "thread_created".into();
        } else if lease.record.native_thread_id.as_deref() != Some(thread_id.as_str()) {
            return Err("原端恢复了其他线程，保留原创建记录且不发送目标".into());
        }
        crate::proc::bind_fresh_native_codex(
            app,
            &handle.info.process_id,
            &lease.record.spec.source_scope,
            &thread_id,
        )?;
        let thread = created.get("thread").ok_or("原端未返回线程")?;
        if let Err(error) = validate_empty_thread(&lease.record.spec, thread) {
            let connection = admitted.lock().map_err(|_| "原账号数据库不可用")?;
            connection.execute("UPDATE work_native_starts SET state='unknown',error_message=?3,updated_at=?4 WHERE request_id=?1 AND owner_id=?2",
                    params![input.request_id,lease.record.owner_id,error,now_millis()]).map_err(|error|error.to_string())?;
            return Err(error);
        }
        let current_profile =
            crate::acp::native_codex_profile(app, &lease.record.spec.execution_profile_id)?;
        if current_profile.fingerprint() != lease.record.spec.profile_fingerprint {
            return Err("创建后的原配置已变化，保留原线程且不发送目标".into());
        }
        let native=db.with_runtime_account_context(&input.account,||{
                let mut connections=runtime.connections.lock().map_err(|_|"原生工作注册表不可用")?;
                let connection=admitted.lock().map_err(|_|"账号数据库不可用")?;
                connection.execute_batch("SAVEPOINT native_start_bind;").map_err(|error|error.to_string())?;
                let bound=(||{
                    let metadata=json!({"schema":"rocketx.native-codex-binding.v1","owner":"native_host","bindingVersion":1,
                        "connectionId":lease.record.owner_id,"resourceOwnerGuardVersion":1,"runtimeVersion":handle.info.version,
                        "executableFingerprint":handle.executable_fingerprint,"fingerprintScope":handle.executable_fingerprint_scope,
                        "resolvedExecutablePath":handle.resolved_executable_path,"verificationScope":"native-control-v1"});
                    let binding=persist_new_work(&connection,&lease.record,thread,&metadata)?;
                    let mut view=blank_snapshot(&binding);view.connection_id=Some(lease.record.owner_id.clone());
                    view.connection_status="connected".into();view.runtime_version=Some(handle.info.version.clone());view.load_thread(thread)?;
                    view.capabilities=NativeWorkCapabilities{resume:false,prompt:true,steer:true,interrupt:true,answer:true,external_live_attach:false};
                    let native=Arc::new(NativeConnection{app:app.clone(),account_scope:input.account.account_scope.clone(),db:Arc::clone(&admitted),binding,
                        core:Mutex::new(Core{view,terminals:HashMap::new()}),rpc:OnceLock::new(),process_id:OnceLock::new(),resume_action_id:OnceLock::new(),closed:AtomicBool::new(false),
                        worker_handle:Mutex::new(None),sequence:AtomicI64::new(1),profile_fingerprint:fingerprint.clone(),resource_directory:db.directory.clone(),
                        _resource_owner_guard:lease.owner_guard.take().ok_or("启动归属锁缺失")?});
                    native.rpc.set(Arc::clone(&handle.rpc)).map_err(|_|"原生连接已注册")?;
                    native.process_id.set(handle.info.process_id.clone()).map_err(|_|"原生进程已注册")?;
                    let event=native.event("thread/created",created.clone(),None,None)?;append_runtime_event(&connection,&event)?;
                    native.persist(&connection,&mut *native.core.lock().map_err(|_|"原生投影不可用")?)?;
                    Ok(native)
                })();
                match bound {
                    Ok(native)=>{connection.execute_batch("RELEASE native_start_bind;").map_err(|error|error.to_string())?;
                        connections.insert(connection_key(&input.account,&native.binding.binding.session_id),Arc::clone(&native));Ok(native)}
                    Err(error)=>{let _=connection.execute_batch("ROLLBACK TO native_start_bind; RELEASE native_start_bind;");Err(error)}
                }
            })?;
        let pending = {
            let mut state = events.lock().map_err(|_| "原生启动事件不可用")?;
            state.owner = Some(Arc::downgrade(&native));
            std::mem::take(&mut state.pending)
        };
        for event in pending {
            native.receive(event);
        }
        if !native.closed.load(Ordering::Acquire) {
            let worker = Arc::clone(&native);
            let handle = thread::spawn(move || worker.run());
            if let Ok(mut slot) = native.worker_handle.lock() {
                *slot = Some(handle);
            }
        }
        let view = native
            .core
            .lock()
            .map_err(|_| "原生投影不可用")?
            .view
            .clone();
        native.notify(view.cursor);
        Ok(view)
    }.await;
    if let Err(error) = &outcome {
        let stopped = match process_id.as_deref() {
            Some(process) => {
                crate::proc::stop_native_codex_if_registered(app, process).unwrap_or(false)
            }
            None => previous_stopped,
        };
        if let Ok(connection) = admitted.lock() {
            let _ = failure(&connection, &lease.record, known_not_sent, error, stopped);
        }
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        directory: PathBuf,
        connection: Connection,
        spec: StartSpec,
    }
    impl Fixture {
        fn new() -> Self {
            let directory =
                std::env::temp_dir().join(format!("rocketx-native-start-{}", uuid::Uuid::new_v4()));
            let workspace = directory.join("workspace");
            std::fs::create_dir_all(&workspace).unwrap();
            let root =
                crate::native::process::host_path(&std::fs::canonicalize(&workspace).unwrap());
            let mut connection = Connection::open_in_memory().unwrap();
            super::super::super::migrate(&mut connection).unwrap();
            connection.execute_batch("INSERT INTO todos(id,title,created_at,updated_at) VALUES('task','Fresh project',1,1);
                INSERT INTO work_card_states(todo_id,goal,updated_at)VALUES('task','Investigate this new project',1);
                INSERT INTO work_links(id,todo_id,kind,external_id,repo,state_snapshot,last_verified_at,created_at)
                VALUES('directory','task','kanban_card','task','temporary','workspace',1,1);").unwrap();
            connection
                .execute("UPDATE work_links SET repo=?1", [&root])
                .unwrap();
            let spec = StartSpec {
                schema: START_SCHEMA.into(),
                request_id: "native-start:task".into(),
                todo_id: "task".into(),
                account: RuntimeAccountContext {
                    account_scope: "local-user@local".into(),
                    generation: 1,
                },
                session_id: "new-binding".into(),
                host_device_id: "device".into(),
                workspace_root: root,
                execution_profile_id: "fresh-profile".into(),
                profile_fingerprint: "fingerprint".into(),
                source_scope: "codex:synthetic-new-home".into(),
                requirements_version: 0,
                content_version: 0,
                title: "Fresh project".into(),
                goal: "Investigate this new project".into(),
            };
            Self {
                directory,
                connection,
                spec,
            }
        }
        fn input(&self) -> NativeWorkStartInput {
            NativeWorkStartInput {
                account: self.spec.account.clone(),
                todo_id: self.spec.todo_id.clone(),
                request_id: self.spec.request_id.clone(),
                workspace_root: self.spec.workspace_root.clone(),
                execution_profile_id: self.spec.execution_profile_id.clone(),
                expected_requirements_version: 0,
                expected_content_version: 0,
                host_device_id: self.spec.host_device_id.clone(),
            }
        }
        fn thread(&self) -> Value {
            json!({"id":"actual-new-thread","cwd":self.spec.workspace_root,"status":{"type":"idle"},"turns":[],"ephemeral":false,"forkedFromId":null,"parentThreadId":null})
        }
        fn reserve(&self) -> StartLease {
            reserve_start(&self.connection, &self.directory, self.spec.clone()).unwrap()
        }
        fn created(&self, lease: &StartLease) {
            claim_creation(&self.connection, &lease.record).unwrap();
            record_created(&self.connection, &lease.record, "actual-new-thread").unwrap();
        }
        fn count(&self, table: &str) -> i64 {
            self.connection
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap()
        }
        fn bind(&self, record: &StartRecord, thread: &Value) -> Result<Binding, String> {
            self.connection
                .execute_batch("SAVEPOINT fixture_bind;")
                .unwrap();
            let result = persist_new_work(
                &self.connection,
                record,
                thread,
                &json!({"schema":"rocketx.native-codex-binding.v1","owner":"native_host","bindingVersion":1}),
            );
            if result.is_ok() {
                self.connection
                    .execute_batch("RELEASE fixture_bind;")
                    .unwrap();
            } else {
                self.connection
                    .execute_batch("ROLLBACK TO fixture_bind; RELEASE fixture_bind;")
                    .unwrap();
            }
            result
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let directory = std::fs::canonicalize(&self.directory).unwrap();
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
                .starts_with("rocketx-native-start-"));
            std::fs::remove_dir_all(directory).unwrap();
        }
    }

    #[test]
    fn native_start_first_goal_is_atomic_user_outbox_without_seed_or_enrollment_budget() {
        let fixture = Fixture::new();
        let lease = fixture.reserve();
        fixture.created(&lease);
        assert_eq!(fixture.count("work_sessions"), 0);
        assert_eq!(fixture.count("dispatch_actions"), 0);
        fixture
            .connection
            .execute_batch("SAVEPOINT simulate_commit_failure;")
            .unwrap();
        persist_new_work(
            &fixture.connection,
            &lease.record,
            &fixture.thread(),
            &json!({}),
        )
        .unwrap();
        fixture
            .connection
            .execute_batch("ROLLBACK TO simulate_commit_failure; RELEASE simulate_commit_failure;")
            .unwrap();
        assert_eq!(fixture.count("work_sessions"), 0);
        assert_eq!(fixture.count("dispatch_actions"), 0);
        assert_eq!(
            read_start(&fixture.connection, "task")
                .unwrap()
                .unwrap()
                .native_thread_id
                .as_deref(),
            Some("actual-new-thread")
        );
        let binding = fixture.bind(&lease.record, &fixture.thread()).unwrap();
        assert_eq!(binding.binding.native_thread_id, "actual-new-thread");
        assert_eq!(binding.binding.workspace_root, fixture.spec.workspace_root);
        let commands = actions(&fixture.connection, "new-binding").unwrap();
        assert_eq!(commands.len(), 1);
        let spec = read_native_command_spec(&commands[0]).unwrap();
        assert_eq!(spec.request_id, fixture.spec.request_id);
        assert_eq!(
            spec.intent,
            NativeCodexIntent::Prompt {
                text: fixture.spec.goal.clone()
            }
        );
        assert_eq!(spec.submitted_by, CommandSubmitter::User);
        assert_eq!(commands[0].state, "prepared");
        claim_native_command(&fixture.connection, &commands[0].id).unwrap();
        let (version, budget): (i64, i64) = fixture
            .connection
            .query_row(
                "SELECT requirements_version,auto_turns_used FROM work_card_states",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!((version, budget), (0, 0));
        assert!(fixture.bind(&lease.record, &fixture.thread()).is_err());
        assert_eq!(fixture.count("dispatch_actions"), 1);
        assert!(!can_correct(&fixture.connection, &fixture.directory, &fixture.input()).unwrap());
        drop(lease);
    }

    #[test]
    fn native_start_prepared_owner_fence_prevents_duplicate_creation_and_old_claim() {
        let fixture = Fixture::new();
        let lease = fixture.reserve();
        let old = lease.record.clone();
        assert!(reserve_start(
            &fixture.connection,
            &fixture.directory,
            fixture.spec.clone()
        )
        .is_err());
        drop(lease);
        let mut changed = fixture.spec.clone();
        changed.profile_fingerprint = "corrected-before-any-thread".into();
        let next = reserve_start(&fixture.connection, &fixture.directory, changed).unwrap();
        assert_ne!(next.record.owner_id, old.owner_id);
        assert!(claim_creation(&fixture.connection, &old).is_err());
        claim_creation(&fixture.connection, &next.record).unwrap();
        assert!(claim_creation(&fixture.connection, &next.record).is_err());
        drop(next);
    }

    #[test]
    fn native_start_unknown_keeps_frozen_identity_and_never_claims_thread_start_twice() {
        let fixture = Fixture::new();
        let lease = fixture.reserve();
        claim_creation(&fixture.connection, &lease.record).unwrap();
        failure(
            &fixture.connection,
            &lease.record,
            false,
            "RPC outcome unknown",
            true,
        )
        .unwrap();
        drop(lease);
        let mut changed = fixture.spec.clone();
        changed.execution_profile_id = "different-profile".into();
        assert!(reserve_start(&fixture.connection, &fixture.directory, changed).is_err());
        let record = read_start(&fixture.connection, "task").unwrap().unwrap();
        assert_eq!(record.state, "unknown");
        assert_eq!(record.spec, fixture.spec);
        assert!(!can_correct(&fixture.connection, &fixture.directory, &fixture.input()).unwrap());
        assert_eq!(fixture.count("work_sessions"), 0);
        assert_eq!(fixture.count("dispatch_actions"), 0);
    }

    #[test]
    fn native_start_actual_thread_survives_failure_and_only_known_id_can_be_resumed() {
        let fixture = Fixture::new();
        let lease = fixture.reserve();
        fixture.created(&lease);
        failure(
            &fixture.connection,
            &lease.record,
            false,
            "account switched after receipt",
            true,
        )
        .unwrap();
        drop(lease);
        let mut changed = fixture.spec.clone();
        changed.execution_profile_id = "different-profile".into();
        assert!(reserve_start(&fixture.connection, &fixture.directory, changed).is_err());
        let next = fixture.reserve();
        assert_eq!(next.record.state, "thread_created");
        assert_eq!(
            next.record.native_thread_id.as_deref(),
            Some("actual-new-thread")
        );
        assert!(claim_creation(&fixture.connection, &next.record).is_err());
        failure(
            &fixture.connection,
            &next.record,
            true,
            "no rollout found for known original ID",
            true,
        )
        .unwrap();
        drop(next);
        let record = read_start(&fixture.connection, "task").unwrap().unwrap();
        assert_eq!(
            record.native_thread_id.as_deref(),
            Some("actual-new-thread")
        );
        assert!(!can_correct(&fixture.connection, &fixture.directory, &fixture.input()).unwrap());
    }

    #[test]
    fn native_start_confirmed_not_sent_allows_corrected_configuration_after_owner_release() {
        let fixture = Fixture::new();
        let lease = fixture.reserve();
        claim_creation(&fixture.connection, &lease.record).unwrap();
        failure(
            &fixture.connection,
            &lease.record,
            true,
            "explicit not sent",
            true,
        )
        .unwrap();
        assert!(!can_correct(&fixture.connection, &fixture.directory, &fixture.input()).unwrap());
        drop(lease);
        assert!(can_correct(&fixture.connection, &fixture.directory, &fixture.input()).unwrap());
        let mut changed = fixture.spec.clone();
        changed.execution_profile_id = "corrected-profile".into();
        let next = reserve_start(&fixture.connection, &fixture.directory, changed).unwrap();
        assert_eq!(next.record.spec.execution_profile_id, "corrected-profile");
        drop(next);
    }

    #[test]
    fn native_start_requires_explicit_idle_empty_persisted_thread_before_goal() {
        let fixture = Fixture::new();
        let lease = fixture.reserve();
        fixture.created(&lease);
        let mut invalid = Vec::new();
        for (field, value) in [
            ("status", json!(null)),
            ("status", json!({"type":"systemError"})),
            ("status", json!({"type":"active"})),
            ("turns", json!(null)),
            ("turns", json!({})),
            ("turns", json!([{"id":"old"}])),
            ("ephemeral", json!(true)),
            ("ephemeral", json!(null)),
            ("forkedFromId", json!("old-thread")),
        ] {
            let mut thread = fixture.thread();
            thread[field] = value;
            invalid.push(thread);
        }
        let mut missing = fixture.thread();
        missing.as_object_mut().unwrap().remove("turns");
        invalid.push(missing);
        for thread in invalid {
            assert!(fixture.bind(&lease.record, &thread).is_err());
            assert_eq!(fixture.count("work_sessions"), 0);
            assert_eq!(fixture.count("dispatch_actions"), 0);
        }
        drop(lease);
    }

    #[test]
    fn native_start_deleted_work_keeps_tombstone_but_never_resurrects_card_or_sends_goal() {
        let fixture = Fixture::new();
        let lease = fixture.reserve();
        fixture.created(&lease);
        fixture
            .connection
            .execute("DELETE FROM todos WHERE id='task'", [])
            .unwrap();
        assert_eq!(fixture.count("todos"), 0);
        assert_eq!(fixture.count("work_native_starts"), 1);
        assert!(fixture.bind(&lease.record, &fixture.thread()).is_err());
        assert_eq!(fixture.count("work_sessions"), 0);
        assert_eq!(fixture.count("dispatch_actions"), 0);
        drop(lease);
    }

    #[test]
    fn native_start_bound_replay_allows_generation_refresh_but_rejects_changed_input() {
        let fixture = Fixture::new();
        let lease = fixture.reserve();
        fixture.created(&lease);
        fixture.bind(&lease.record, &fixture.thread()).unwrap();
        let record = read_start(&fixture.connection, "task").unwrap().unwrap();
        let mut input = fixture.input();
        input.account.generation += 1;
        replay_identity(&record, &input).unwrap();
        for field in [
            "profile",
            "device",
            "requirements",
            "content",
            "scope",
            "request",
            "workspace",
        ] {
            let mut changed = input.clone();
            match field {
                "profile" => changed.execution_profile_id = "another".into(),
                "device" => changed.host_device_id = "another".into(),
                "requirements" => changed.expected_requirements_version += 1,
                "content" => changed.expected_content_version += 1,
                "scope" => changed.account.account_scope = "other@account".into(),
                "request" => changed.request_id = "another".into(),
                _ => changed.workspace_root = fixture.directory.to_str().unwrap().into(),
            }
            assert!(replay_identity(&record, &changed).is_err(), "{field}");
        }
        drop(lease);
    }
}
