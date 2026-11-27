use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::{
    deserialize_optional_nullable, get_todo, now_millis, run_db, update_todo, ButlerDb, Todo,
    TodoFilter, TodoPatch,
};

const SCHEMA_LEDGER_TABLES: &str = "
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS work_card_states (
        todo_id TEXT PRIMARY KEY REFERENCES todos(id) ON DELETE CASCADE,
        visibility TEXT NOT NULL DEFAULT 'private'
            CHECK (visibility IN ('private', 'room_shared')),
        stage TEXT NOT NULL DEFAULT 'ready'
            CHECK (stage IN ('triage', 'ready', 'in_progress', 'verifying', 'done')),
        wait_state TEXT NOT NULL DEFAULT 'none'
            CHECK (wait_state IN (
                'none',
                'waiting_input',
                'waiting_approval',
                'waiting_external',
                'blocked',
                'paused',
                'canceled'
            )),
        wait_reason TEXT,
        goal TEXT,
        owner_kind TEXT NOT NULL DEFAULT 'human'
            CHECK (owner_kind IN ('human', 'ai_suggested', 'ai_dispatched')),
        project_key TEXT,
        environment_id TEXT,
        acceptance_json TEXT NOT NULL DEFAULT '[]',
        boundaries_json TEXT NOT NULL DEFAULT '[]',
        depends_on_json TEXT NOT NULL DEFAULT '[]',
        next_step TEXT,
        next_check_at INTEGER,
        last_verified_at INTEGER,
        autonomy_mode TEXT NOT NULL DEFAULT 'confirm'
            CHECK (autonomy_mode IN ('readonly', 'confirm', 'autonomous')),
        max_auto_turns INTEGER NOT NULL DEFAULT 3 CHECK (max_auto_turns BETWEEN 1 AND 20),
        auto_turns_used INTEGER NOT NULL DEFAULT 0 CHECK (auto_turns_used >= 0),
        consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
        revoked_at INTEGER,
        requirements_version INTEGER NOT NULL DEFAULT 0,
        content_version INTEGER NOT NULL DEFAULT 0,
        deadline_at INTEGER,
        updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_work_card_states_stage ON work_card_states(stage);
    CREATE INDEX IF NOT EXISTS idx_work_card_states_wait ON work_card_states(wait_state);

    CREATE TABLE IF NOT EXISTS work_creation_requests (
        request_id TEXT PRIMARY KEY,
        todo_id TEXT NOT NULL REFERENCES todos(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS work_links (
        id TEXT PRIMARY KEY,
        todo_id TEXT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN (
            'message',
            'discussion',
            'kanban_card',
            'ado_work_item',
            'ado_pr',
            'ci_build',
            'git_branch'
        )),
        external_id TEXT NOT NULL,
        project TEXT,
        repo TEXT,
        rid TEXT,
        head_sha TEXT,
        title TEXT,
        web_url TEXT,
        state_snapshot TEXT,
        last_verified_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(todo_id, kind, external_id)
    );
    CREATE INDEX IF NOT EXISTS idx_work_links_lookup ON work_links(kind, external_id);
    CREATE INDEX IF NOT EXISTS idx_work_links_todo ON work_links(todo_id);

    CREATE TABLE IF NOT EXISTS work_sessions (
        id TEXT PRIMARY KEY,
        todo_id TEXT REFERENCES todos(id) ON DELETE SET NULL,
        visibility TEXT NOT NULL DEFAULT 'private'
            CHECK (visibility IN ('private', 'room_shared')),
        runtime TEXT NOT NULL CHECK (runtime IN ('codex', 'deepseek', 'pi', 'acp')),
        origin TEXT NOT NULL DEFAULT 'butler'
            CHECK (origin IN ('butler', 'shared_room', 'scheduled', 'external_discovered')),
        native_session_id TEXT NOT NULL,
        source_scope TEXT NOT NULL DEFAULT 'default',
        title TEXT,
        workspace_root TEXT NOT NULL,
        environment_id TEXT,
        account_scope TEXT,
        control_endpoint TEXT,
        control_mode TEXT NOT NULL CHECK (control_mode IN ('readonly', 'resumable', 'controllable')),
        control_reason TEXT,
        host_device_id TEXT,
        writer_lease_owner TEXT,
        writer_lease_expires_at INTEGER,
        runtime_status TEXT NOT NULL DEFAULT 'unknown'
            CHECK (runtime_status IN (
                'running',
                'waiting_approval',
                'waiting_input',
                'idle',
                'interrupted',
                'ended',
                'unknown'
            )),
        binding_version INTEGER NOT NULL DEFAULT 0,
        runtime_owner TEXT NOT NULL DEFAULT 'legacy',
        config_snapshot_json TEXT,
        last_event_seq INTEGER,
        last_turn_id TEXT,
        last_verified_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(runtime, native_session_id, host_device_id, source_scope, account_scope)
    );
    CREATE INDEX IF NOT EXISTS idx_work_sessions_todo ON work_sessions(todo_id);
    CREATE INDEX IF NOT EXISTS idx_work_sessions_workspace ON work_sessions(workspace_root);

    CREATE TABLE IF NOT EXISTS work_evidences (
        id TEXT PRIMARY KEY,
        todo_id TEXT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
        session_id TEXT REFERENCES work_sessions(id) ON DELETE SET NULL,
        kind TEXT NOT NULL CHECK (kind IN (
            'test_run',
            'ci_build',
            'pull_request',
            'git_commit',
            'agent_report',
            'manual_note',
            'manual_ack'
        )),
        title TEXT NOT NULL,
        summary TEXT,
        head_sha TEXT,
        workspace_root TEXT,
        web_url TEXT,
        passed INTEGER NOT NULL CHECK (passed IN (0, 1)),
        stale INTEGER NOT NULL DEFAULT 0 CHECK (stale IN (0, 1)),
        stale_reason TEXT,
        criterion_ids_json TEXT NOT NULL DEFAULT '[]',
        requirements_version INTEGER NOT NULL DEFAULT 0,
        content_version INTEGER NOT NULL DEFAULT 0,
        accepted_by TEXT,
        acceptance_scope_json TEXT NOT NULL DEFAULT '[]',
        verified_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_work_evidences_todo ON work_evidences(todo_id, stale);

    CREATE TABLE IF NOT EXISTS external_events (
        id TEXT PRIMARY KEY,
        dedupe_key TEXT NOT NULL UNIQUE,
        source TEXT NOT NULL CHECK (source IN ('ado_webhook', 'ado_poll', 'rc_message', 'local_watcher')),
        event_type TEXT NOT NULL,
        resource_key TEXT NOT NULL,
        resource_version INTEGER NOT NULL,
        project TEXT,
        repo TEXT,
        branch TEXT,
        commit_sha TEXT,
        work_item_id INTEGER,
        pr_id INTEGER,
        build_id INTEGER,
        rid TEXT,
        todo_id TEXT REFERENCES todos(id) ON DELETE SET NULL,
        correlation_tier TEXT NOT NULL DEFAULT 'unmatched'
            CHECK (correlation_tier IN ('exact', 'heuristic', 'unmatched')),
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'received'
            CHECK (status IN (
                'received',
                'superseded',
                'correlated',
                'verified_stale',
                'pending_approval',
                'dispatched',
                'done',
                'failed'
            )),
        status_detail TEXT,
        occurred_at INTEGER NOT NULL,
        processed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_external_events_status ON external_events(status, occurred_at);
    CREATE INDEX IF NOT EXISTS idx_external_events_resource ON external_events(resource_key, resource_version DESC);

    CREATE TABLE IF NOT EXISTS dispatch_actions (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        todo_id TEXT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
        event_id TEXT REFERENCES external_events(id) ON DELETE SET NULL,
        session_id TEXT REFERENCES work_sessions(id) ON DELETE SET NULL,
        action_kind TEXT NOT NULL CHECK (action_kind IN (
            'session_create',
            'session_prompt',
            'session_steer',
            'session_resume',
            'session_interrupt',
            'ado_comment',
            'ado_state_write',
            'rc_report'
        )),
        spec_json TEXT NOT NULL,
        baseline_marker TEXT,
        state TEXT NOT NULL CHECK (state IN (
            'awaiting_approval',
            'prepared',
            'dispatched',
            'verifying_delivery',
            'acknowledged',
            'completed',
            'failed',
            'canceled'
        )),
        receipt_ref TEXT,
        error_message TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dispatch_actions_todo ON dispatch_actions(todo_id, state);
";

pub(crate) fn migrate_ledger(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(SCHEMA_LEDGER_TABLES)
        .map_err(|error| format!("无法初始化统一工作账本表：{error}"))?;
    migrate_acceptance_contract(connection)?;
    migrate_session_identity(connection)?;
    migrate_session_host_ownership(connection)?;
    migrate_native_dispatch_kinds(connection)?;
    Ok(())
}

fn migrate_native_dispatch_kinds(connection: &Connection) -> Result<(), String> {
    let definition: String = connection
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='dispatch_actions'",
            [],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if definition.contains("'session_resume'") && definition.contains("'session_interrupt'") {
        return Ok(());
    }
    // This outbox has no inbound ledger FK. Copy without renaming its old table so
    // outgoing references retain their original targets and IDs remain unchanged.
    connection
        .execute_batch("SAVEPOINT native_dispatch_kinds;")
        .map_err(|error| error.to_string())?;
    let result = (|| {
        let start = SCHEMA_LEDGER_TABLES
            .find("CREATE TABLE IF NOT EXISTS dispatch_actions (")
            .ok_or("派发账本表定义不存在")?;
        let definition = &SCHEMA_LEDGER_TABLES[start..];
        let end = definition.find("\n    );").ok_or("派发账本表定义不完整")? + 7;
        let definition = definition[..end].replace(
            "IF NOT EXISTS dispatch_actions",
            "dispatch_actions_native_new",
        );
        connection.execute_batch(&format!("{definition};
            INSERT INTO dispatch_actions_native_new (id,idempotency_key,todo_id,event_id,session_id,action_kind,spec_json,baseline_marker,state,receipt_ref,error_message,created_at,updated_at)
                SELECT id,idempotency_key,todo_id,event_id,session_id,action_kind,spec_json,baseline_marker,state,receipt_ref,error_message,created_at,updated_at FROM dispatch_actions;
            DROP TABLE dispatch_actions;
            ALTER TABLE dispatch_actions_native_new RENAME TO dispatch_actions;
            CREATE INDEX idx_dispatch_actions_todo ON dispatch_actions(todo_id,state);
            RELEASE native_dispatch_kinds;"))
            .map_err(|error| format!("无法迁移原生恢复与中断动作：{error}"))
    })();
    if result.is_err() {
        let _ = connection
            .execute_batch("ROLLBACK TO native_dispatch_kinds; RELEASE native_dispatch_kinds;");
    }
    result
}

fn table_has_column(connection: &Connection, table: &str, column: &str) -> Result<bool, String> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|e| e.to_string())?;
    let columns = statement
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(|e| e.to_string())?;
    for name in columns {
        if name.map_err(|e| e.to_string())? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

// Build replacement tables without renaming the original: SQLite must retain FK targets.
fn rebuild_ledger_table(
    connection: &Connection,
    table: &str,
    old_columns: &str,
) -> Result<(), String> {
    let start = SCHEMA_LEDGER_TABLES
        .find(&format!("CREATE TABLE IF NOT EXISTS {table} ("))
        .ok_or("账本表定义不存在")?;
    let definition = &SCHEMA_LEDGER_TABLES[start..];
    let end = definition.find("\n    );").ok_or("账本表定义不完整")? + 7;
    let create = definition[..end].replace(
        &format!("IF NOT EXISTS {table}"),
        &format!("{table}_contract_new"),
    );
    connection
        .execute_batch("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;")
        .map_err(|e| e.to_string())?;
    let result = connection.execute_batch(&format!("{create}; INSERT INTO {table}_contract_new ({old_columns}) SELECT {old_columns} FROM {table}; DROP TABLE {table}; ALTER TABLE {table}_contract_new RENAME TO {table}; COMMIT;"));
    if result.is_err() {
        let _ = connection.execute_batch("ROLLBACK;");
    }
    connection
        .execute_batch("PRAGMA foreign_keys = ON;")
        .map_err(|e| e.to_string())?;
    result.map_err(|e| format!("无法迁移{table}：{e}"))
}

fn migrate_acceptance_contract(connection: &Connection) -> Result<(), String> {
    if !table_has_column(connection, "work_card_states", "deadline_at")? {
        connection
            .execute_batch("ALTER TABLE work_card_states ADD COLUMN deadline_at INTEGER;")
            .map_err(|e| e.to_string())?;
    }
    if !table_has_column(connection, "work_card_states", "requirements_version")? {
        let result=connection.execute_batch("SAVEPOINT acceptance_contract;
          ALTER TABLE work_card_states ADD COLUMN requirements_version INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE work_card_states ADD COLUMN content_version INTEGER NOT NULL DEFAULT 0;
          UPDATE work_card_states SET requirements_version = 1 WHERE acceptance_json != '[]' OR owner_kind != 'human';
          UPDATE work_card_states SET stage='verifying' WHERE requirements_version>0 AND stage='done';
          UPDATE todos SET done=0,done_at=NULL WHERE id IN(SELECT todo_id FROM work_card_states WHERE requirements_version>0 AND stage='verifying');
          RELEASE acceptance_contract;");
        if let Err(error) = result {
            let _ = connection
                .execute_batch("ROLLBACK TO acceptance_contract; RELEASE acceptance_contract;");
            return Err(format!("无法升级工作验收合同：{error}"));
        }
    }
    if !table_has_column(connection, "work_evidences", "criterion_ids_json")? {
        rebuild_ledger_table(connection, "work_evidences", "id,todo_id,session_id,kind,title,summary,head_sha,workspace_root,web_url,passed,stale,stale_reason,verified_at,created_at")?;
        // Historical manual_ack includes normalised Agent reports; none has verified human provenance.
        connection
            .execute_batch(
                "UPDATE work_evidences SET stale=1,stale_reason='acceptance_contract_migrated';",
            )
            .map_err(|e| e.to_string())?;
    }
    connection
        .execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_work_evidences_todo ON work_evidences(todo_id,stale);",
        )
        .map_err(|e| e.to_string())
}

fn migrate_session_identity(connection: &Connection) -> Result<(), String> {
    if !table_has_column(connection, "work_sessions", "source_scope")? {
        rebuild_ledger_table(connection, "work_sessions", "id,todo_id,visibility,runtime,origin,native_session_id,title,workspace_root,environment_id,account_scope,control_endpoint,control_mode,control_reason,host_device_id,writer_lease_owner,writer_lease_expires_at,runtime_status,config_snapshot_json,last_event_seq,last_turn_id,last_verified_at,created_at,updated_at")?;
    }
    connection.execute_batch("CREATE UNIQUE INDEX IF NOT EXISTS idx_work_sessions_identity ON work_sessions(runtime,native_session_id,COALESCE(host_device_id,''),source_scope,COALESCE(account_scope,''));
      CREATE INDEX IF NOT EXISTS idx_work_sessions_todo ON work_sessions(todo_id);
      CREATE INDEX IF NOT EXISTS idx_work_sessions_workspace ON work_sessions(workspace_root);").map_err(|e| e.to_string())
}

fn migrate_session_host_ownership(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch("SAVEPOINT session_host_ownership;")
        .map_err(|error| format!("无法开始迁移会话运行所有权：{error}"))?;
    let result = (|| {
        if !table_has_column(connection, "work_sessions", "binding_version")? {
            connection
                .execute_batch("ALTER TABLE work_sessions ADD COLUMN binding_version INTEGER NOT NULL DEFAULT 0;")
                .map_err(|error| format!("无法迁移会话绑定版本：{error}"))?;
        }
        if !table_has_column(connection, "work_sessions", "runtime_owner")? {
            connection
                .execute_batch("ALTER TABLE work_sessions ADD COLUMN runtime_owner TEXT NOT NULL DEFAULT 'legacy';")
                .map_err(|error| format!("无法迁移会话运行所有权：{error}"))?;
        }
        connection
            .execute_batch("RELEASE session_host_ownership;")
            .map_err(|error| format!("无法提交会话运行所有权迁移：{error}"))
    })();
    if result.is_err() {
        let _ = connection
            .execute_batch("ROLLBACK TO session_host_ownership; RELEASE session_host_ownership;");
    }
    result
}

pub(crate) fn sync_card_state_on_todo_write(
    connection: &Connection,
    todo: &Todo,
) -> Result<(), String> {
    let existing = get_work_card_state(connection, &todo.id)?;
    let now = now_millis();
    match existing {
        None => {
            let stage = if todo.done { "done" } else { "ready" };
            let (wait_state, wait_reason) = if !todo.done
                && todo
                    .waiting_for
                    .as_deref()
                    .is_some_and(|value| !value.trim().is_empty())
            {
                ("waiting_external", todo.waiting_for.clone())
            } else {
                ("none", None)
            };
            let visibility = if todo.source == "ado" {
                "room_shared"
            } else {
                "private"
            };
            connection
                .execute(
                    "INSERT INTO work_card_states (
                        todo_id, visibility, stage, wait_state, wait_reason, project_key,
                        last_verified_at, updated_at
                    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    params![
                        todo.id,
                        visibility,
                        stage,
                        wait_state,
                        wait_reason,
                        todo.ado_project,
                        now,
                        now
                    ],
                )
                .map_err(|error| format!("无法初始化工作卡片状态：{error}"))?;
        }
        Some(state) => {
            if state.requirements_version > 0
                || !state.acceptance.is_empty()
                || state.owner_kind != "human"
            {
                // Compatibility writes (todo.done/ADO refresh) cannot own managed completion or waits.
                connection.execute("UPDATE todos SET done=?2,done_at=CASE WHEN ?2=0 THEN NULL ELSE done_at END WHERE id=?1", params![todo.id, i64::from(state.stage == "done")]).map_err(|e| e.to_string())?;
                return Ok(());
            }
            let next_stage = if todo.done {
                "done".to_string()
            } else if state.stage == "done" {
                "ready".to_string()
            } else {
                state.stage
            };
            let (next_wait_state, next_wait_reason) = if todo.done {
                ("none".to_string(), None)
            } else if let Some(waiting) = todo
                .waiting_for
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                if state.wait_state == "none" {
                    ("waiting_external".to_string(), Some(waiting.to_string()))
                } else {
                    (state.wait_state, state.wait_reason)
                }
            } else if state.wait_state == "waiting_external" {
                ("none".to_string(), None)
            } else {
                (state.wait_state, state.wait_reason)
            };
            connection
                .execute(
                    "UPDATE work_card_states
                     SET stage = ?2, wait_state = ?3, wait_reason = ?4, updated_at = ?5
                     WHERE todo_id = ?1",
                    params![todo.id, next_stage, next_wait_state, next_wait_reason, now],
                )
                .map_err(|error| format!("无法同步工作卡片状态：{error}"))?;
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkCardState {
    pub todo_id: String,
    pub requirements_version: i64,
    pub content_version: i64,
    pub deadline_at: Option<i64>,
    pub visibility: String,
    pub stage: String,
    pub wait_state: String,
    pub wait_reason: Option<String>,
    pub goal: Option<String>,
    pub owner_kind: String,
    pub project_key: Option<String>,
    pub environment_id: Option<String>,
    pub acceptance: Vec<String>,
    pub boundaries: Vec<String>,
    pub depends_on: Vec<String>,
    pub next_step: Option<String>,
    pub next_check_at: Option<i64>,
    pub last_verified_at: Option<i64>,
    pub autonomy_mode: String,
    pub max_auto_turns: i32,
    pub auto_turns_used: i32,
    pub consecutive_failures: i32,
    pub revoked_at: Option<i64>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkCard {
    #[serde(flatten)]
    pub todo: Todo,
    pub state: WorkCardState,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateWorkCardInput {
    pub request_id: Option<String>,
    pub source: Option<String>,
    pub rid: Option<String>,
    pub mid: Option<String>,
    pub ado_work_item_id: Option<i64>,
    pub ado_project: Option<String>,
    pub project_key: Option<String>,
    pub title: String,
    pub note: Option<String>,
    pub priority: Option<i32>,
    pub stage: Option<String>,
    pub goal: Option<String>,
    pub next_step: Option<String>,
    pub owner_kind: Option<String>,
    pub autonomy_mode: Option<String>,
    pub visibility: Option<String>,
    pub acceptance: Option<Vec<String>>,
    pub boundaries: Option<Vec<String>>,
    pub enroll: Option<bool>,
}

pub(crate) fn create_work_card(
    connection: &Connection,
    input: CreateWorkCardInput,
) -> Result<WorkCard, String> {
    connection
        .execute_batch("SAVEPOINT work_card_create;")
        .map_err(|e| e.to_string())?;
    let result = (|| {
        let request_id = input
            .request_id
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty());
        if let Some(request) = request_id {
            let existing: Option<String> = connection
                .query_row(
                    "SELECT todo_id FROM work_creation_requests WHERE request_id=?1",
                    params![request],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            if let Some(id) = existing {
                let todo = get_todo(connection, &id)?.ok_or("创建请求对应工作不存在")?;
                let state =
                    get_work_card_state(connection, &id)?.ok_or("创建请求对应工作状态不存在")?;
                return Ok(WorkCard { todo, state });
            }
        }
        let title = input.title.trim();
        if title.is_empty() {
            return Err("工作标题不能为空".to_string());
        }
        let todo = super::add_todo(
            connection,
            super::NewTodo {
                source: input.source.or(Some("manual".into())),
                rid: input.rid,
                mid: input.mid,
                ado_work_item_id: input.ado_work_item_id,
                ado_project: input.ado_project,
                title: title.to_string(),
                note: input.note,
                room_name: None,
                author: None,
                done: Some(false),
                priority: input.priority,
                due: None,
                done_at: None,
                committed_to: None,
                waiting_for: None,
            },
        )?;
        let card =
            update_work_card(
                connection,
                &todo.id,
                WorkCardPatch {
                    stage: input.stage,
                    goal: Some(input.goal),
                    next_step: Some(input.next_step),
                    owner_kind: input.owner_kind,
                    autonomy_mode: input.autonomy_mode,
                    visibility: input.visibility,
                    enroll: Some(input.enroll.unwrap_or_else(|| {
                        input.acceptance.as_ref().is_some_and(|a| !a.is_empty())
                    })),
                    acceptance: input.acceptance,
                    boundaries: input.boundaries,
                    project_key: input.project_key.map(Some),
                    ..WorkCardPatch::default()
                },
            )?;
        if let Some(request) = request_id {
            connection
                .execute(
                    "INSERT INTO work_creation_requests(request_id,todo_id)VALUES(?1,?2)",
                    params![request, card.todo.id],
                )
                .map_err(|e| e.to_string())?;
        }
        Ok(card)
    })();
    match result {
        Ok(card) => {
            connection
                .execute_batch("RELEASE work_card_create;")
                .map_err(|e| e.to_string())?;
            Ok(card)
        }
        Err(error) => {
            let _ =
                connection.execute_batch("ROLLBACK TO work_card_create; RELEASE work_card_create;");
            Err(error)
        }
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkCardPatch {
    pub expected_requirements_version: Option<i64>,
    pub expected_content_version: Option<i64>,
    #[serde(default, deserialize_with = "deserialize_optional_nullable")]
    pub deadline_at: Option<Option<i64>>,
    pub enroll: Option<bool>,
    pub rework: Option<bool>,
    pub human_acceptance: Option<HumanAcceptance>,
    pub title: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_nullable")]
    pub note: Option<Option<String>>,
    pub priority: Option<i32>,
    #[serde(default, deserialize_with = "deserialize_optional_nullable")]
    pub due: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_optional_nullable")]
    pub committed_to: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_optional_nullable")]
    pub waiting_for: Option<Option<String>>,
    pub visibility: Option<String>,
    pub stage: Option<String>,
    pub wait_state: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_nullable")]
    pub wait_reason: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_optional_nullable")]
    pub goal: Option<Option<String>>,
    pub owner_kind: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_nullable")]
    pub project_key: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_optional_nullable")]
    pub environment_id: Option<Option<String>>,
    pub acceptance: Option<Vec<String>>,
    pub boundaries: Option<Vec<String>>,
    pub depends_on: Option<Vec<String>>,
    #[serde(default, deserialize_with = "deserialize_optional_nullable")]
    pub next_step: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_optional_nullable")]
    pub next_check_at: Option<Option<i64>>,
    #[serde(default, deserialize_with = "deserialize_optional_nullable")]
    pub last_verified_at: Option<Option<i64>>,
    pub autonomy_mode: Option<String>,
    pub max_auto_turns: Option<i32>,
    pub auto_turns_used: Option<i32>,
    pub consecutive_failures: Option<i32>,
    #[serde(default, deserialize_with = "deserialize_optional_nullable")]
    pub revoked_at: Option<Option<i64>>,
    /// 旧布尔字段只用于读取旧请求，已不能绕过显式人工接受。
    #[allow(dead_code)]
    pub human_confirmed_done: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HumanAcceptance {
    pub actor_id: String,
    pub criterion_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkLink {
    pub id: String,
    pub todo_id: String,
    pub kind: String,
    pub external_id: String,
    pub project: Option<String>,
    pub repo: Option<String>,
    pub rid: Option<String>,
    pub head_sha: Option<String>,
    pub title: Option<String>,
    pub web_url: Option<String>,
    pub state_snapshot: Option<String>,
    pub last_verified_at: i64,
    pub created_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertWorkLinkInput {
    pub todo_id: String,
    pub kind: String,
    pub external_id: String,
    pub project: Option<String>,
    pub repo: Option<String>,
    pub rid: Option<String>,
    pub head_sha: Option<String>,
    pub title: Option<String>,
    pub web_url: Option<String>,
    pub state_snapshot: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkSessionRecord {
    pub id: String,
    pub todo_id: Option<String>,
    pub visibility: String,
    pub runtime: String,
    pub origin: String,
    pub native_session_id: String,
    pub source_scope: String,
    pub title: Option<String>,
    pub workspace_root: String,
    pub environment_id: Option<String>,
    pub account_scope: Option<String>,
    pub control_endpoint: Option<String>,
    pub control_mode: String,
    pub control_reason: Option<String>,
    pub host_device_id: Option<String>,
    pub writer_lease_owner: Option<String>,
    pub writer_lease_expires_at: Option<i64>,
    pub runtime_status: String,
    pub config_snapshot_json: Option<String>,
    pub last_event_seq: Option<i64>,
    pub last_turn_id: Option<String>,
    pub last_verified_at: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertWorkSessionInput {
    pub todo_id: Option<String>,
    #[serde(default)]
    pub clear_todo_id: Option<bool>,
    pub visibility: Option<String>,
    pub runtime: String,
    pub origin: Option<String>,
    pub native_session_id: String,
    pub source_scope: Option<String>,
    pub title: Option<String>,
    pub workspace_root: String,
    pub environment_id: Option<String>,
    pub account_scope: Option<String>,
    pub control_endpoint: Option<String>,
    pub control_mode: String,
    pub control_reason: Option<String>,
    pub host_device_id: Option<String>,
    pub writer_lease_owner: Option<String>,
    pub writer_lease_expires_at: Option<i64>,
    pub runtime_status: Option<String>,
    pub config_snapshot_json: Option<String>,
    pub last_event_seq: Option<i64>,
    pub last_turn_id: Option<String>,
    #[serde(default)]
    pub created_at: Option<i64>,
    #[serde(default)]
    pub updated_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkEvidence {
    pub id: String,
    pub todo_id: String,
    pub session_id: Option<String>,
    pub kind: String,
    pub title: String,
    pub summary: Option<String>,
    pub head_sha: Option<String>,
    pub workspace_root: Option<String>,
    pub web_url: Option<String>,
    pub passed: bool,
    pub stale: bool,
    pub stale_reason: Option<String>,
    pub verified_at: i64,
    pub created_at: i64,
    pub criterion_ids: Vec<String>,
    pub requirements_version: i64,
    pub content_version: i64,
    pub accepted_by: Option<String>,
    pub acceptance_scope: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewWorkEvidenceInput {
    pub todo_id: String,
    pub session_id: Option<String>,
    pub kind: String,
    pub title: String,
    pub summary: Option<String>,
    pub head_sha: Option<String>,
    pub workspace_root: Option<String>,
    pub web_url: Option<String>,
    pub passed: bool,
    #[serde(default)]
    pub criterion_ids: Vec<String>,
    pub requirements_version: Option<i64>,
    pub content_version: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalEventRecord {
    pub id: String,
    pub dedupe_key: String,
    pub source: String,
    pub event_type: String,
    pub resource_key: String,
    pub resource_version: i64,
    pub project: Option<String>,
    pub repo: Option<String>,
    pub branch: Option<String>,
    pub commit_sha: Option<String>,
    pub work_item_id: Option<i64>,
    pub pr_id: Option<i64>,
    pub build_id: Option<i64>,
    pub rid: Option<String>,
    pub todo_id: Option<String>,
    pub correlation_tier: String,
    pub payload_json: String,
    pub status: String,
    pub status_detail: Option<String>,
    pub occurred_at: i64,
    pub processed_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestExternalEventInput {
    pub dedupe_key: String,
    pub source: String,
    pub event_type: String,
    pub resource_key: String,
    pub resource_version: i64,
    pub project: Option<String>,
    pub repo: Option<String>,
    pub branch: Option<String>,
    pub commit_sha: Option<String>,
    pub work_item_id: Option<i64>,
    pub pr_id: Option<i64>,
    pub build_id: Option<i64>,
    pub rid: Option<String>,
    pub payload_json: Option<String>,
    pub occurred_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestExternalEventResult {
    pub duplicate: bool,
    pub event: ExternalEventRecord,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchActionRecord {
    pub id: String,
    pub idempotency_key: String,
    pub todo_id: String,
    pub event_id: Option<String>,
    pub session_id: Option<String>,
    pub action_kind: String,
    pub spec_json: String,
    pub baseline_marker: Option<String>,
    pub state: String,
    pub receipt_ref: Option<String>,
    pub error_message: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareDispatchActionInput {
    pub idempotency_key: String,
    pub todo_id: String,
    pub event_id: Option<String>,
    pub session_id: Option<String>,
    pub action_kind: String,
    pub spec_json: String,
    pub baseline_marker: Option<String>,
    pub require_confirmation: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransitionDispatchActionInput {
    pub id: String,
    pub state: String,
    pub receipt_ref: Option<String>,
    pub error_message: Option<String>,
    pub expected_state: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkLedgerSnapshot {
    pub cards: Vec<WorkCard>,
    pub links: Vec<WorkLink>,
    pub sessions: Vec<WorkSessionRecord>,
    pub evidences: Vec<WorkEvidence>,
    pub events: Vec<ExternalEventRecord>,
    pub actions: Vec<DispatchActionRecord>,
}

fn parse_string_vec(raw: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(raw).unwrap_or_default()
}

fn encode_string_vec(items: &[String]) -> String {
    let cleaned: Vec<String> = items
        .iter()
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .collect();
    serde_json::to_string(&cleaned).unwrap_or_else(|_| "[]".to_string())
}

fn default_card_state_for_todo(todo: &Todo) -> WorkCardState {
    let stage = if todo.done { "done" } else { "ready" }.to_string();
    let (wait_state, wait_reason) = if !todo.done
        && todo
            .waiting_for
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
    {
        ("waiting_external".to_string(), todo.waiting_for.clone())
    } else {
        ("none".to_string(), None)
    };
    let visibility = if todo.source == "ado" {
        "room_shared"
    } else {
        "private"
    }
    .to_string();
    WorkCardState {
        todo_id: todo.id.clone(),
        requirements_version: 0,
        content_version: 0,
        deadline_at: None,
        visibility,
        stage,
        wait_state,
        wait_reason,
        goal: None,
        owner_kind: "human".to_string(),
        project_key: todo.ado_project.clone(),
        environment_id: None,
        acceptance: Vec::new(),
        boundaries: Vec::new(),
        depends_on: Vec::new(),
        next_step: None,
        next_check_at: None,
        last_verified_at: Some(todo.updated_at),
        autonomy_mode: "confirm".to_string(),
        max_auto_turns: 3,
        auto_turns_used: 0,
        consecutive_failures: 0,
        revoked_at: None,
        updated_at: todo.updated_at,
    }
}

fn row_to_card_state(row: &rusqlite::Row<'_>) -> rusqlite::Result<WorkCardState> {
    let acceptance_raw: String = row.get(9)?;
    let boundaries_raw: String = row.get(10)?;
    let depends_raw: String = row.get(11)?;
    Ok(WorkCardState {
        todo_id: row.get(0)?,
        visibility: row.get(1)?,
        stage: row.get(2)?,
        wait_state: row.get(3)?,
        wait_reason: row.get(4)?,
        goal: row.get(5)?,
        owner_kind: row.get(6)?,
        project_key: row.get(7)?,
        environment_id: row.get(8)?,
        acceptance: parse_string_vec(&acceptance_raw),
        boundaries: parse_string_vec(&boundaries_raw),
        depends_on: parse_string_vec(&depends_raw),
        next_step: row.get(12)?,
        next_check_at: row.get(13)?,
        last_verified_at: row.get(14)?,
        autonomy_mode: row.get(15)?,
        max_auto_turns: row.get(16)?,
        auto_turns_used: row.get(17)?,
        consecutive_failures: row.get(18)?,
        revoked_at: row.get(19)?,
        updated_at: row.get(20)?,
        requirements_version: row.get(21)?,
        content_version: row.get(22)?,
        deadline_at: row.get(23)?,
    })
}

fn get_work_card_state(
    connection: &Connection,
    todo_id: &str,
) -> Result<Option<WorkCardState>, String> {
    connection
        .query_row(
            "SELECT
                todo_id, visibility, stage, wait_state, wait_reason, goal,
                owner_kind, project_key, environment_id, acceptance_json,
                boundaries_json, depends_on_json, next_step, next_check_at,
                last_verified_at, autonomy_mode, max_auto_turns,
                auto_turns_used, consecutive_failures, revoked_at, updated_at, requirements_version, content_version, deadline_at
             FROM work_card_states
             WHERE todo_id = ?1",
            params![todo_id],
            row_to_card_state,
        )
        .optional()
        .map_err(|error| format!("无法读取工作卡片状态：{error}"))
}

fn validate_visibility(value: &str) -> Result<(), String> {
    if matches!(value, "private" | "room_shared") {
        Ok(())
    } else {
        Err("可见性必须是 private 或 room_shared".to_string())
    }
}

fn validate_stage(value: &str) -> Result<(), String> {
    if matches!(
        value,
        "triage" | "ready" | "in_progress" | "verifying" | "done"
    ) {
        Ok(())
    } else {
        Err("卡片阶段必须是 triage、ready、in_progress、verifying 或 done".to_string())
    }
}

fn validate_wait_state(value: &str) -> Result<(), String> {
    if matches!(
        value,
        "none"
            | "waiting_input"
            | "waiting_approval"
            | "waiting_external"
            | "blocked"
            | "paused"
            | "canceled"
    ) {
        Ok(())
    } else {
        Err("等待状态无效".to_string())
    }
}

fn validate_owner_kind(value: &str) -> Result<(), String> {
    if matches!(value, "human" | "ai_suggested" | "ai_dispatched") {
        Ok(())
    } else {
        Err("负责人类型必须是 human、ai_suggested 或 ai_dispatched".to_string())
    }
}

fn validate_autonomy_mode(value: &str) -> Result<(), String> {
    if matches!(value, "readonly" | "confirm" | "autonomous") {
        Ok(())
    } else {
        Err("自主模式必须是 readonly、confirm 或 autonomous".to_string())
    }
}

fn has_valid_evidence(
    connection: &Connection,
    state: &WorkCardState,
    human: Option<&HumanAcceptance>,
) -> Result<bool, String> {
    if state.goal.as_deref().unwrap_or("").trim().is_empty()
        || state.acceptance.is_empty()
        || state.wait_state != "none"
    {
        return Ok(false);
    }
    let mut statement = connection.prepare("SELECT criterion_ids_json,kind,accepted_by,acceptance_scope_json FROM work_evidences WHERE todo_id=?1 AND passed=1 AND stale=0 AND requirements_version=?2 AND content_version=?3 AND kind NOT IN ('agent_report','manual_note')").map_err(|e| e.to_string())?;
    let records = statement
        .query_map(
            params![
                state.todo_id,
                state.requirements_version,
                state.content_version
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(state.acceptance.iter().all(|criterion| {
        human.is_some_and(|h| h.criterion_ids.contains(criterion))
            || records.iter().any(|(ids, kind, actor, scope)| {
                parse_string_vec(ids).contains(criterion)
                    && (kind != "manual_ack"
                        || (actor.as_deref().is_some_and(|a| !a.trim().is_empty())
                            && parse_string_vec(scope).contains(criterion)))
            })
    }))
}

fn invalidate_evidences(
    connection: &Connection,
    todo_id: &str,
    reason: &str,
    except_head_sha: Option<&str>,
) -> Result<usize, String> {
    let changed = match except_head_sha {
        Some(head_sha) => connection
            .execute(
                "UPDATE work_evidences
                 SET stale = 1, stale_reason = ?2
                 WHERE todo_id = ?1 AND stale = 0 AND head_sha IS NOT NULL AND head_sha != ?3",
                params![todo_id, reason, head_sha],
            )
            .map_err(|error| format!("无法标记过期证据：{error}"))?,
        None => connection
            .execute(
                "UPDATE work_evidences
                 SET stale = 1, stale_reason = ?2
                 WHERE todo_id = ?1 AND stale = 0",
                params![todo_id, reason],
            )
            .map_err(|error| format!("无法标记过期证据：{error}"))?,
    };
    Ok(changed)
}

pub(crate) fn update_work_card(
    connection: &Connection,
    todo_id: &str,
    patch: WorkCardPatch,
) -> Result<WorkCard, String> {
    connection
        .execute_batch("SAVEPOINT work_card_update;")
        .map_err(|e| e.to_string())?;
    let result = update_work_card_inner(connection, todo_id, patch);
    match result {
        Ok(card) => {
            connection
                .execute_batch("RELEASE work_card_update;")
                .map_err(|e| e.to_string())?;
            Ok(card)
        }
        Err(error) => {
            let _ =
                connection.execute_batch("ROLLBACK TO work_card_update; RELEASE work_card_update;");
            Err(error)
        }
    }
}

fn update_work_card_inner(
    connection: &Connection,
    todo_id: &str,
    patch: WorkCardPatch,
) -> Result<WorkCard, String> {
    let current_todo =
        get_todo(connection, todo_id)?.ok_or_else(|| "工作卡片不存在".to_string())?;
    sync_card_state_on_todo_write(connection, &current_todo)?;
    let mut state = get_work_card_state(connection, todo_id)?
        .unwrap_or_else(|| default_card_state_for_todo(&current_todo));
    if patch.human_acceptance.is_some()
        && (patch.expected_requirements_version.is_none()
            || patch.expected_content_version.is_none())
    {
        return Err("人工接受必须绑定已审阅的要求和成果版本".to_string());
    }
    if patch
        .expected_requirements_version
        .is_some_and(|v| v != state.requirements_version)
        || patch
            .expected_content_version
            .is_some_and(|v| v != state.content_version)
    {
        return Err("工作要求或成果已更新，请重新读取当前版本".to_string());
    }

    let scope_changed = patch
        .acceptance
        .as_ref()
        .is_some_and(|next| next != &state.acceptance)
        || patch
            .boundaries
            .as_ref()
            .is_some_and(|next| next != &state.boundaries)
        || patch.goal.as_ref().is_some_and(|next| next != &state.goal)
        || patch
            .note
            .as_ref()
            .is_some_and(|next| next != &current_todo.note);
    let previous_stage = state.stage.clone();
    if let Some(deadline) = patch.deadline_at {
        state.deadline_at = deadline;
    }
    let stage_explicit = patch.stage.is_some();

    if let Some(value) = patch.visibility {
        validate_visibility(&value)?;
        state.visibility = value;
    }
    if let Some(value) = patch.stage {
        validate_stage(&value)?;
        state.stage = value;
    }
    if let Some(value) = patch.wait_state {
        validate_wait_state(&value)?;
        state.wait_state = value;
    }
    if let Some(value) = patch.wait_reason {
        state.wait_reason = value;
    }
    if let Some(value) = patch.goal {
        state.goal = value;
    }
    if let Some(value) = patch.owner_kind {
        validate_owner_kind(&value)?;
        state.owner_kind = value;
    }
    if let Some(value) = patch.project_key {
        state.project_key = value;
    }
    if let Some(value) = patch.environment_id {
        state.environment_id = value;
    }
    if let Some(value) = patch.acceptance {
        state.acceptance = value;
    }
    if let Some(value) = patch.boundaries {
        state.boundaries = value;
    }
    if let Some(value) = patch.depends_on {
        state.depends_on = value;
    }
    if let Some(value) = patch.next_step {
        state.next_step = value;
    }
    if let Some(value) = patch.next_check_at {
        state.next_check_at = value;
    }
    if let Some(value) = patch.last_verified_at {
        state.last_verified_at = value;
    }
    if let Some(value) = patch.autonomy_mode {
        validate_autonomy_mode(&value)?;
        if value != "autonomous" && state.autonomy_mode == "autonomous" {
            state.revoked_at = Some(now_millis());
        }
        state.autonomy_mode = value;
    }
    if let Some(value) = patch.max_auto_turns {
        if !(1..=20).contains(&value) {
            return Err("最大自动推进轮次必须在 1 到 20 之间".to_string());
        }
        state.max_auto_turns = value;
    }
    if let Some(value) = patch.auto_turns_used {
        if value < 0 {
            return Err("已使用轮次不能为负数".to_string());
        }
        state.auto_turns_used = value;
    }
    if let Some(value) = patch.consecutive_failures {
        if value < 0 {
            return Err("连续失败次数不能为负数".to_string());
        }
        state.consecutive_failures = value;
    }
    if let Some(value) = patch.revoked_at {
        state.revoked_at = value;
    }

    if state.wait_state == "paused" && state.revoked_at.is_none() {
        state.revoked_at = Some(now_millis());
    }

    let followed = state.requirements_version > 0
        || patch.enroll == Some(true)
        || !state.acceptance.is_empty()
        || state.owner_kind != "human";
    if followed {
        if state.goal.as_deref().unwrap_or("").trim().is_empty()
            || state.acceptance.is_empty()
            || state.acceptance.iter().any(|c| c.trim().is_empty())
        {
            return Err("纳入跟进的工作必须明确目标和非空验收条件".to_string());
        }
        state.requirements_version = (state.requirements_version + i64::from(scope_changed)).max(1);
    }
    if patch.rework == Some(true) {
        state.content_version += 1;
    }
    if !stage_explicit {
        if patch.rework == Some(true) {
            state.stage = "in_progress".to_string();
        } else if scope_changed && previous_stage == "done" {
            state.stage = "verifying".to_string();
        }
    }
    if let Some(human) = patch.human_acceptance.as_ref() {
        if human.actor_id.trim().is_empty()
            || human.criterion_ids.is_empty()
            || human
                .criterion_ids
                .iter()
                .any(|c| !state.acceptance.contains(c))
        {
            return Err("人工接受需要明确身份和当前验收范围".to_string());
        }
    }

    // 验收门禁：有明确验收条件或为 AI 派发任务时，进入 done 必须具备非过期证据或人工显式确认
    if state.stage == "done"
        && followed
        && !has_valid_evidence(connection, &state, patch.human_acceptance.as_ref())?
    {
        return Err(
            "完成前需逐项具备当前版本有效（未过期）验收证据，或记录带身份和范围的人工接受，并解决等待事项"
                .to_string(),
        );
    }

    let now = now_millis();
    if scope_changed || patch.rework == Some(true) {
        invalidate_evidences(
            connection,
            todo_id,
            if patch.rework == Some(true) {
                "rework_requested"
            } else {
                "task_scope_updated"
            },
            None,
        )?;
    }
    if let Some(human) = patch.human_acceptance.as_ref() {
        connection.execute("INSERT INTO work_evidences(id,todo_id,kind,title,passed,stale,verified_at,created_at,criterion_ids_json,requirements_version,content_version,accepted_by,acceptance_scope_json) VALUES(?1,?2,'manual_ack','人工接受验收结果',1,0,?3,?3,?4,?5,?6,?7,?4)", params![uuid::Uuid::new_v4().to_string(),todo_id,now,encode_string_vec(&human.criterion_ids),state.requirements_version,state.content_version,human.actor_id.trim()]).map_err(|e| e.to_string())?;
    }
    state.updated_at = now;
    if state.last_verified_at.is_none() {
        state.last_verified_at = Some(now);
    }

    connection
        .execute(
            "UPDATE work_card_states SET
                visibility = ?2,
                stage = ?3,
                wait_state = ?4,
                wait_reason = ?5,
                goal = ?6,
                owner_kind = ?7,
                project_key = ?8,
                environment_id = ?9,
                acceptance_json = ?10,
                boundaries_json = ?11,
                depends_on_json = ?12,
                next_step = ?13,
                next_check_at = ?14,
                last_verified_at = ?15,
                autonomy_mode = ?16,
                max_auto_turns = ?17,
                auto_turns_used = ?18,
                consecutive_failures = ?19,
                revoked_at = ?20,
                updated_at = ?21,
                requirements_version = ?22,
                content_version = ?23,
                deadline_at = ?24
             WHERE todo_id = ?1",
            params![
                todo_id,
                state.visibility,
                state.stage,
                state.wait_state,
                state.wait_reason,
                state.goal,
                state.owner_kind,
                state.project_key,
                state.environment_id,
                encode_string_vec(&state.acceptance),
                encode_string_vec(&state.boundaries),
                encode_string_vec(&state.depends_on),
                state.next_step,
                state.next_check_at,
                state.last_verified_at,
                state.autonomy_mode,
                state.max_auto_turns,
                state.auto_turns_used,
                state.consecutive_failures,
                state.revoked_at,
                state.updated_at,
                state.requirements_version,
                state.content_version,
                state.deadline_at,
            ],
        )
        .map_err(|error| format!("无法更新工作卡片状态：{error}"))?;

    let target_done = state.stage == "done";
    let todo_patch = TodoPatch {
        title: patch.title,
        note: patch.note,
        priority: patch.priority,
        due: patch.due,
        committed_to: patch.committed_to,
        waiting_for: patch.waiting_for,
        done: Some(target_done),
        ..TodoPatch::default()
    };
    let updated_todo = update_todo(connection, todo_id, todo_patch)?;
    let final_state = get_work_card_state(connection, todo_id)?
        .unwrap_or_else(|| default_card_state_for_todo(&updated_todo));

    Ok(WorkCard {
        todo: updated_todo,
        state: final_state,
    })
}

pub(crate) fn upsert_work_link(
    connection: &Connection,
    input: UpsertWorkLinkInput,
) -> Result<WorkLink, String> {
    connection
        .execute_batch("SAVEPOINT work_link_upsert;")
        .map_err(|e| e.to_string())?;
    match upsert_work_link_inner(connection, input) {
        Ok(link) => {
            connection
                .execute_batch("RELEASE work_link_upsert;")
                .map_err(|e| e.to_string())?;
            Ok(link)
        }
        Err(error) => {
            let _ =
                connection.execute_batch("ROLLBACK TO work_link_upsert; RELEASE work_link_upsert;");
            Err(error)
        }
    }
}

fn upsert_work_link_inner(
    connection: &Connection,
    input: UpsertWorkLinkInput,
) -> Result<WorkLink, String> {
    if !matches!(
        input.kind.as_str(),
        "message"
            | "discussion"
            | "kanban_card"
            | "ado_work_item"
            | "ado_pr"
            | "ci_build"
            | "git_branch"
    ) {
        return Err("关联类型无效".to_string());
    }
    let external_id = input.external_id.trim();
    if external_id.is_empty() {
        return Err("关联外部 ID 不能为空".to_string());
    }
    let todo = get_todo(connection, &input.todo_id)?
        .ok_or_else(|| "关联的目标工作卡片不存在".to_string())?;
    sync_card_state_on_todo_write(connection, &todo)?;

    let now = now_millis();
    let existing: Option<(String, Option<String>, i64, Option<String>)> = connection
        .query_row(
            "SELECT id, head_sha, created_at, state_snapshot FROM work_links
             WHERE todo_id = ?1 AND kind = ?2 AND external_id = ?3",
            params![input.todo_id, input.kind, external_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(|error| format!("无法查询工作关联：{error}"))?;

    let (id, previous_sha, created_at, previous_snapshot) =
        existing.unwrap_or_else(|| (uuid::Uuid::new_v4().to_string(), None, now, None));

    // 当 PR 或分支的 HEAD SHA 发生变化时，使该卡片上旧 SHA 的验收证据自动过期
    let head_changed = input
        .head_sha
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .is_some_and(|new_sha| {
            previous_sha
                .as_deref()
                .is_some_and(|old| !old.is_empty() && old != new_sha)
        });
    let observed_workspace = input.kind == "git_branch"
        && external_id.starts_with("workspace:")
        && input
            .state_snapshot
            .as_deref()
            .is_some_and(|s| s.starts_with("content:"));
    let content_changed = if observed_workspace && previous_snapshot != input.state_snapshot {
        previous_snapshot.is_some()
            || connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM work_evidences WHERE todo_id=?1 AND stale=0)",
                    params![input.todo_id],
                    |row| row.get::<_, bool>(0),
                )
                .map_err(|e| e.to_string())?
    } else {
        false
    };
    if head_changed || content_changed {
        invalidate_evidences(
            connection,
            &input.todo_id,
            if content_changed {
                "workspace_content_changed"
            } else {
                "head_sha_changed"
            },
            None,
        )?;
        connection
            .execute(
                "UPDATE work_card_states
                         SET stage = CASE WHEN stage = 'done' THEN 'verifying' ELSE stage END,
                             content_version = content_version + 1, updated_at = ?2
                         WHERE todo_id = ?1",
                params![input.todo_id, now],
            )
            .map_err(|error| format!("无法回退过期证据卡片阶段：{error}"))?;
        connection
            .execute(
                "UPDATE todos
                         SET done = 0, done_at = NULL, updated_at = ?2
                         WHERE id = ?1 AND done = 1",
                params![input.todo_id, now],
            )
            .map_err(|error| format!("无法回退过期证据待办完成态：{error}"))?;
    }

    let link = WorkLink {
        id: id.clone(),
        todo_id: input.todo_id,
        kind: input.kind,
        external_id: external_id.to_string(),
        project: input.project,
        repo: input.repo,
        rid: input.rid,
        head_sha: input.head_sha,
        title: input.title,
        web_url: input.web_url,
        state_snapshot: input.state_snapshot,
        last_verified_at: now,
        created_at,
    };

    connection
        .execute(
            "INSERT INTO work_links (
                id, todo_id, kind, external_id, project, repo, rid,
                head_sha, title, web_url, state_snapshot, last_verified_at, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
             ON CONFLICT(todo_id, kind, external_id) DO UPDATE SET
                project = excluded.project,
                repo = excluded.repo,
                rid = excluded.rid,
                head_sha = COALESCE(excluded.head_sha, work_links.head_sha),
                title = COALESCE(excluded.title, work_links.title),
                web_url = COALESCE(excluded.web_url, work_links.web_url),
                state_snapshot = COALESCE(excluded.state_snapshot, work_links.state_snapshot),
                last_verified_at = excluded.last_verified_at",
            params![
                link.id,
                link.todo_id,
                link.kind,
                link.external_id,
                link.project,
                link.repo,
                link.rid,
                link.head_sha,
                link.title,
                link.web_url,
                link.state_snapshot,
                link.last_verified_at,
                link.created_at,
            ],
        )
        .map_err(|error| format!("无法保存工作关联：{error}"))?;

    Ok(link)
}

fn normalize_session_runtime(raw: &str) -> Result<String, String> {
    match raw.trim() {
        "codex" => Ok("codex".to_string()),
        "deepseek" | "dsh" => Ok("deepseek".to_string()),
        "pi" => Ok("pi".to_string()),
        "acp" => Ok("acp".to_string()),
        _ => Err("会话 Runtime 必须是 codex、deepseek、pi 或 acp".to_string()),
    }
}

fn normalize_session_origin(raw: &str) -> Result<String, String> {
    match raw.trim() {
        "butler" | "rocketx_managed" => Ok("butler".to_string()),
        "shared_room" => Ok("shared_room".to_string()),
        "scheduled" => Ok("scheduled".to_string()),
        "external_discovered" | "native_cli" | "native_desktop" => {
            Ok("external_discovered".to_string())
        }
        _ => Err("会话来源无效".to_string()),
    }
}

fn normalize_session_runtime_status(raw: &str) -> Result<String, String> {
    match raw.trim() {
        "running" => Ok("running".to_string()),
        "waiting_approval" => Ok("waiting_approval".to_string()),
        "waiting_input" => Ok("waiting_input".to_string()),
        "idle" => Ok("idle".to_string()),
        "interrupted" | "error" => Ok("interrupted".to_string()),
        "ended" | "stopped" => Ok("ended".to_string()),
        "unknown" => Ok("unknown".to_string()),
        _ => Err("会话运行状态无效".to_string()),
    }
}

fn normalize_work_evidence_kind(raw: &str) -> Result<String, String> {
    match raw.trim() {
        "test_run" => Ok("test_run".to_string()),
        "ci_build" => Ok("ci_build".to_string()),
        "pull_request" | "pr_status" => Ok("pull_request".to_string()),
        "git_commit" | "diff_check" => Ok("git_commit".to_string()),
        "manual_ack" | "manual_note" | "agent_report" => Ok(raw.trim().to_string()),
        _ => Err("验收证据类型无效".to_string()),
    }
}

pub(crate) fn upsert_work_session(
    connection: &Connection,
    input: UpsertWorkSessionInput,
) -> Result<WorkSessionRecord, String> {
    let runtime = normalize_session_runtime(&input.runtime)?;
    let origin = match input.origin.as_deref() {
        Some(raw) => normalize_session_origin(raw)?,
        None => "butler".to_string(),
    };
    if !matches!(
        input.control_mode.as_str(),
        "readonly" | "resumable" | "controllable"
    ) {
        return Err("控制模式必须是 readonly、resumable 或 controllable".to_string());
    }
    let visibility = input.visibility.unwrap_or_else(|| {
        if origin == "shared_room" {
            "room_shared".to_string()
        } else {
            "private".to_string()
        }
    });
    validate_visibility(&visibility)?;

    let runtime_status = match input.runtime_status.as_deref() {
        Some(raw) => normalize_session_runtime_status(raw)?,
        None => "unknown".to_string(),
    };
    let native_session_id = input.native_session_id.trim();
    if native_session_id.is_empty() {
        return Err("原生会话 ID 不能为空".to_string());
    }
    let workspace_root = input.workspace_root.trim();
    if workspace_root.is_empty() {
        return Err("工作区路径不能为空".to_string());
    }

    // 守护规则：被其他 writer 占用或远端租约持有的会话绝不能误标为可控制
    let effective_control_mode = if matches!(
        input.control_reason.as_deref(),
        Some(
            "active_external_writer"
                | "remote_device_lease"
                | "workspace_missing"
                | "corrupt_or_partial_log"
        )
    ) {
        "readonly".to_string()
    } else {
        input.control_mode
    };

    let now = now_millis();
    let source_scope = input
        .source_scope
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or("default")
        .to_string();
    let existing_meta: Option<(String, i64, Option<String>, Option<String>, String)> = connection
        .query_row(
            "SELECT id, created_at, todo_id, config_snapshot_json, runtime_owner
             FROM work_sessions
             WHERE runtime = ?1 AND native_session_id = ?2 AND (source_scope=?3 OR source_scope='default') AND COALESCE(host_device_id,'')=?4 AND COALESCE(account_scope,'')=?5 ORDER BY (source_scope=?3) DESC LIMIT 1",
            params![runtime, native_session_id, source_scope, input.host_device_id.as_deref().unwrap_or(""),input.account_scope.as_deref().unwrap_or("")],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?,row.get(3)?,row.get(4)?)),
        )
        .optional()
        .map_err(|error| format!("无法查询已有会话记录：{error}"))?;
    if existing_meta
        .as_ref()
        .is_some_and(|meta| meta.4 == "native_host")
    {
        return Err("此会话由 NativeHost 管理，旧会话接口不能覆盖其绑定或运行状态".to_string());
    }

    let (existing_id, existing_created_at, existing_todo_id, existing_config_snapshot_json) =
        match existing_meta {
            Some((id, created, todo, cfg, _)) => (Some(id), Some(created), todo, cfg),
            None => (None, None, None, None),
        };
    let id = if let Some(id) = existing_id {
        id
    } else {
        let legacy_id = format!("{runtime}:{native_session_id}");
        let taken = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM work_sessions WHERE id=?1)",
                params![legacy_id],
                |row| row.get::<_, bool>(0),
            )
            .map_err(|e| e.to_string())?;
        if taken {
            format!("{runtime}:{}", uuid::Uuid::new_v4())
        } else {
            legacy_id
        }
    };

    let effective_todo_id = if input.clear_todo_id.unwrap_or(false) {
        None
    } else {
        input
            .todo_id
            .filter(|value| !value.trim().is_empty())
            .or(existing_todo_id)
    };
    let effective_config_snapshot_json =
        input.config_snapshot_json.or(existing_config_snapshot_json);
    let created_at = existing_created_at.or(input.created_at).unwrap_or(now);
    let updated_at = input.updated_at.unwrap_or(now);

    let record = WorkSessionRecord {
        id: id.clone(),
        todo_id: effective_todo_id,
        visibility,
        runtime,
        origin,
        native_session_id: native_session_id.to_string(),
        source_scope,
        title: input.title,
        workspace_root: workspace_root.to_string(),
        environment_id: input.environment_id,
        account_scope: input.account_scope,
        control_endpoint: input.control_endpoint,
        control_mode: effective_control_mode,
        control_reason: input.control_reason,
        host_device_id: input.host_device_id,
        writer_lease_owner: input.writer_lease_owner,
        writer_lease_expires_at: input.writer_lease_expires_at,
        runtime_status,
        config_snapshot_json: effective_config_snapshot_json,
        last_event_seq: input.last_event_seq,
        last_turn_id: input.last_turn_id,
        last_verified_at: now,
        created_at,
        updated_at,
    };

    let changed = connection
        .execute(
            "INSERT INTO work_sessions (
                id, todo_id, visibility, runtime, origin, native_session_id, title,
                workspace_root, environment_id, account_scope, control_endpoint,
                control_mode, control_reason, host_device_id, writer_lease_owner,
                writer_lease_expires_at, runtime_status, config_snapshot_json,
                last_event_seq, last_turn_id, last_verified_at, created_at, updated_at, source_scope
             ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7,
                ?8, ?9, ?10, ?11,
                ?12, ?13, ?14, ?15,
                ?16, ?17, ?18,
                ?19, ?20, ?21, ?22, ?23, ?24
             )
             ON CONFLICT(id) DO UPDATE SET
                source_scope = excluded.source_scope,
                todo_id = excluded.todo_id,
                visibility = excluded.visibility,
                origin = excluded.origin,
                title = COALESCE(excluded.title, work_sessions.title),
                workspace_root = excluded.workspace_root,
                environment_id = COALESCE(excluded.environment_id, work_sessions.environment_id),
                account_scope = COALESCE(excluded.account_scope, work_sessions.account_scope),
                control_endpoint = excluded.control_endpoint,
                control_mode = excluded.control_mode,
                control_reason = excluded.control_reason,
                host_device_id = COALESCE(excluded.host_device_id, work_sessions.host_device_id),
                writer_lease_owner = excluded.writer_lease_owner,
                writer_lease_expires_at = excluded.writer_lease_expires_at,
                runtime_status = excluded.runtime_status,
                config_snapshot_json = excluded.config_snapshot_json,
                last_event_seq = COALESCE(excluded.last_event_seq, work_sessions.last_event_seq),
                last_turn_id = COALESCE(excluded.last_turn_id, work_sessions.last_turn_id),
                last_verified_at = excluded.last_verified_at,
                updated_at = excluded.updated_at
             WHERE work_sessions.runtime_owner != 'native_host'",
            params![
                record.id,
                record.todo_id,
                record.visibility,
                record.runtime,
                record.origin,
                record.native_session_id,
                record.title,
                record.workspace_root,
                record.environment_id,
                record.account_scope,
                record.control_endpoint,
                record.control_mode,
                record.control_reason,
                record.host_device_id,
                record.writer_lease_owner,
                record.writer_lease_expires_at,
                record.runtime_status,
                record.config_snapshot_json,
                record.last_event_seq,
                record.last_turn_id,
                record.last_verified_at,
                record.created_at,
                record.updated_at,
                record.source_scope,
            ],
        )
        .map_err(|error| format!("无法保存工作会话：{error}"))?;
    if changed == 0 {
        return Err("此会话已由 NativeHost 接管，旧会话接口不能覆盖其绑定或运行状态".to_string());
    }

    // 当受管会话处于等待审批/输入时，自动把关联卡片的等待状态冒泡到卡片上
    if let Some(todo_id) = record.todo_id.as_deref() {
        let bubbled_wait = match record.runtime_status.as_str() {
            "waiting_approval" => Some(("waiting_approval", "会话正在等待审批")),
            "waiting_input" => Some(("waiting_input", "会话正在等待补充输入")),
            _ => None,
        };
        if let Some((wait_state, reason)) = bubbled_wait {
            connection
                .execute(
                    "UPDATE work_card_states
                     SET wait_state = CASE WHEN wait_state = 'paused' THEN wait_state ELSE ?2 END,
                         wait_reason = CASE WHEN wait_state = 'paused' THEN wait_reason ELSE COALESCE(wait_reason, ?3) END,
                         last_verified_at = ?4,
                         updated_at = ?4
                     WHERE todo_id = ?1",
                    params![todo_id, wait_state, reason, now],
                )
                .map_err(|error| format!("无法同步会话等待状态到卡片：{error}"))?;
        }
    }

    Ok(record)
}

pub(crate) fn add_work_evidence(
    connection: &Connection,
    input: NewWorkEvidenceInput,
) -> Result<WorkEvidence, String> {
    let kind = normalize_work_evidence_kind(&input.kind)?;
    if kind == "manual_ack" {
        return Err("人工接受请使用显式验收操作".to_string());
    }
    if input.title.trim().is_empty() {
        return Err("验收证据标题不能为空".to_string());
    }
    let todo = get_todo(connection, &input.todo_id)?
        .ok_or_else(|| "验收证据关联的工作卡片不存在".to_string())?;
    sync_card_state_on_todo_write(connection, &todo)?;

    let state = get_work_card_state(connection, &input.todo_id)?.ok_or("工作状态不存在")?;
    if let Some(session_id) = input.session_id.as_ref() {
        let session_todo: Option<String> = connection
            .query_row(
                "SELECT todo_id FROM work_sessions WHERE id=?1",
                params![session_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .flatten();
        if session_todo.as_deref() != Some(input.todo_id.as_str()) {
            return Err("证据会话不属于当前工作".to_string());
        }
    }
    let version_current = input.requirements_version == Some(state.requirements_version)
        && input.content_version == Some(state.content_version);

    let now = now_millis();
    let evidence = WorkEvidence {
        id: uuid::Uuid::new_v4().to_string(),
        todo_id: input.todo_id.clone(),
        session_id: input.session_id,
        kind,
        title: input.title.trim().to_string(),
        summary: input.summary,
        head_sha: input.head_sha,
        workspace_root: input.workspace_root,
        web_url: input.web_url,
        passed: input.passed,
        stale: !version_current,
        stale_reason: if version_current {
            None
        } else {
            Some("evidence_version_mismatch".to_string())
        },
        verified_at: now,
        created_at: now,
        criterion_ids: input.criterion_ids,
        requirements_version: input.requirements_version.unwrap_or(0),
        content_version: input.content_version.unwrap_or(0),
        accepted_by: None,
        acceptance_scope: vec![],
    };

    connection
        .execute(
            "INSERT INTO work_evidences (
                id, todo_id, session_id, kind, title, summary, head_sha,
                workspace_root, web_url, passed, stale, stale_reason, verified_at, created_at,
                criterion_ids_json,requirements_version,content_version,accepted_by,acceptance_scope_json
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?13, ?14, ?11, ?12,?15,?16,?17,NULL,'[]')",
            params![
                evidence.id,
                evidence.todo_id,
                evidence.session_id,
                evidence.kind,
                evidence.title,
                evidence.summary,
                evidence.head_sha,
                evidence.workspace_root,
                evidence.web_url,
                i64::from(evidence.passed),
                evidence.verified_at,
                evidence.created_at,
                i64::from(evidence.stale),
                evidence.stale_reason,
                encode_string_vec(&evidence.criterion_ids),
                evidence.requirements_version,
                evidence.content_version,
            ],
        )
        .map_err(|error| format!("无法写入验收证据：{error}"))?;

    connection
        .execute(
            "UPDATE work_card_states
             SET last_verified_at = ?2, updated_at = ?2
             WHERE todo_id = ?1",
            params![input.todo_id, now],
        )
        .map_err(|error| format!("无法更新卡片核实时间：{error}"))?;

    Ok(evidence)
}

fn correlate_event_to_todo(
    connection: &Connection,
    input: &IngestExternalEventInput,
) -> Result<(Option<String>, &'static str), String> {
    // 1. 强确定性匹配：commit_sha / pr_id / build_id / work_item_id / branch / rid
    if let Some(sha) = input
        .commit_sha
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        if let Some(todo_id) = connection
            .query_row(
                "SELECT todo_id FROM work_links WHERE head_sha = ?1 ORDER BY last_verified_at DESC LIMIT 1",
                params![sha],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| format!("关联 commit_sha 失败：{e}"))?
        {
            return Ok((Some(todo_id), "exact"));
        }
    }

    if let Some(pr_id) = input.pr_id {
        if let Some(todo_id) = connection
            .query_row(
                "SELECT todo_id FROM work_links
                 WHERE kind = 'ado_pr' AND external_id = ?1
                 ORDER BY last_verified_at DESC LIMIT 1",
                params![pr_id.to_string()],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| format!("关联 pr_id 失败：{e}"))?
        {
            return Ok((Some(todo_id), "exact"));
        }
    }

    if let Some(work_item_id) = input.work_item_id {
        if let Some(todo_id) = connection
            .query_row(
                "SELECT todo_id FROM work_links
                 WHERE kind = 'ado_work_item' AND external_id = ?1
                 ORDER BY last_verified_at DESC LIMIT 1",
                params![work_item_id.to_string()],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| format!("关联 work_links.ado_work_item 失败：{e}"))?
        {
            return Ok((Some(todo_id), "exact"));
        }
        if let Some(todo_id) = connection
            .query_row(
                "SELECT id FROM todos WHERE ado_work_item_id = ?1 ORDER BY updated_at DESC LIMIT 1",
                params![work_item_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| format!("关联 todos.ado_work_item_id 失败：{e}"))?
        {
            return Ok((Some(todo_id), "exact"));
        }
    }

    if let Some(branch) = input
        .branch
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let short_branch = branch.strip_prefix("refs/heads/").unwrap_or(branch);
        if let Some(todo_id) = connection
            .query_row(
                "SELECT todo_id FROM work_links
                 WHERE kind = 'git_branch' AND (external_id = ?1 OR external_id = ?2)
                 ORDER BY last_verified_at DESC LIMIT 1",
                params![branch, short_branch],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| format!("关联 git_branch 失败：{e}"))?
        {
            return Ok((Some(todo_id), "exact"));
        }
    }

    if let Some(rid) = input
        .rid
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        if let Some(todo_id) = connection
            .query_row(
                "SELECT todo_id FROM work_links
                 WHERE rid = ?1 OR (kind = 'discussion' AND external_id = ?1)
                 ORDER BY last_verified_at DESC LIMIT 1",
                params![rid],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| format!("关联 rid 失败：{e}"))?
        {
            return Ok((Some(todo_id), "exact"));
        }
    }

    // 2. 弱启发式候选：同 repo 或同 project 下唯一的执行中任务（仅标记为 heuristic，不触发自动派发）
    if let Some(project) = input
        .project
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        if let Some(todo_id) = connection
            .query_row(
                "SELECT todo_id FROM work_card_states
                 WHERE LOWER(project_key) = LOWER(?1) AND stage IN ('in_progress', 'verifying')
                 ORDER BY updated_at DESC LIMIT 1",
                params![project],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| format!("启发式关联 project 失败：{e}"))?
        {
            return Ok((Some(todo_id), "heuristic"));
        }
    }

    Ok((None, "unmatched"))
}

pub(crate) fn ingest_external_event(
    connection: &Connection,
    input: IngestExternalEventInput,
) -> Result<IngestExternalEventResult, String> {
    if !matches!(
        input.source.as_str(),
        "ado_webhook" | "ado_poll" | "rc_message" | "local_watcher"
    ) {
        return Err("外部事件来源无效".to_string());
    }
    let dedupe_key = input.dedupe_key.trim();
    if dedupe_key.is_empty() {
        return Err("外部事件 dedupeKey 不能为空".to_string());
    }
    let resource_key = input.resource_key.trim();
    if resource_key.is_empty() {
        return Err("外部事件 resourceKey 不能为空".to_string());
    }

    if let Some(existing) = get_external_event_by_dedupe(connection, dedupe_key)? {
        return Ok(IngestExternalEventResult {
            duplicate: true,
            event: existing,
        });
    }

    let now = now_millis();
    let occurred_at = input.occurred_at.unwrap_or(now);

    // 乱序检查：同一 resource_key 如果已经处理过更高 resource_version 的事件，则当前事件直接置为 superseded
    let latest_version: Option<i64> = connection
        .query_row(
            "SELECT MAX(resource_version) FROM external_events WHERE resource_key = ?1",
            params![resource_key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("无法查询外部事件资源水位线：{error}"))?
        .flatten();

    let (todo_id, correlation_tier) = correlate_event_to_todo(connection, &input)?;

    let (status, status_detail) =
        if latest_version.is_some_and(|max_v| input.resource_version < max_v) {
            (
                "superseded".to_string(),
                Some("收到乱序的旧版本事件，已被更新的状态覆盖".to_string()),
            )
        } else if let Some(ref matched_todo_id) = todo_id {
            let card_state = get_work_card_state(connection, matched_todo_id)?;
            if let Some(ref state) = card_state {
                if state.wait_state == "paused"
                    || state
                        .revoked_at
                        .is_some_and(|revoked_at| occurred_at <= revoked_at)
                {
                    (
                        "verified_stale".to_string(),
                        Some("目标任务已暂停或撤权，旧事件仅归档不触发派发".to_string()),
                    )
                } else {
                    ("correlated".to_string(), None)
                }
            } else {
                ("correlated".to_string(), None)
            }
        } else {
            ("received".to_string(), None)
        };

    // 如果关联到了具体卡片且携带了新的 PR HEAD SHA，触发旧证据失效
    if status == "correlated" {
        if let (Some(ref matched_todo_id), Some(pr_id), Some(sha)) = (
            &todo_id,
            input.pr_id,
            input.commit_sha.as_deref().filter(|s| !s.trim().is_empty()),
        ) {
            let _ = upsert_work_link(
                connection,
                UpsertWorkLinkInput {
                    todo_id: matched_todo_id.clone(),
                    kind: "ado_pr".to_string(),
                    external_id: pr_id.to_string(),
                    project: input.project.clone(),
                    repo: input.repo.clone(),
                    rid: input.rid.clone(),
                    head_sha: Some(sha.to_string()),
                    title: None,
                    web_url: None,
                    state_snapshot: Some(input.event_type.clone()),
                },
            );
        }
    }

    let record = ExternalEventRecord {
        id: uuid::Uuid::new_v4().to_string(),
        dedupe_key: dedupe_key.to_string(),
        source: input.source,
        event_type: input.event_type,
        resource_key: resource_key.to_string(),
        resource_version: input.resource_version,
        project: input.project,
        repo: input.repo,
        branch: input.branch,
        commit_sha: input.commit_sha,
        work_item_id: input.work_item_id,
        pr_id: input.pr_id,
        build_id: input.build_id,
        rid: input.rid,
        todo_id,
        correlation_tier: correlation_tier.to_string(),
        payload_json: input.payload_json.unwrap_or_else(|| "{}".to_string()),
        status: status.clone(),
        status_detail,
        occurred_at,
        processed_at: (status != "received").then_some(now),
    };

    connection
        .execute(
            "INSERT INTO external_events (
                id, dedupe_key, source, event_type, resource_key, resource_version,
                project, repo, branch, commit_sha, work_item_id, pr_id, build_id,
                rid, todo_id, correlation_tier, payload_json, status, status_detail,
                occurred_at, processed_at
             ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6,
                ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                ?14, ?15, ?16, ?17, ?18, ?19,
                ?20, ?21
             )",
            params![
                record.id,
                record.dedupe_key,
                record.source,
                record.event_type,
                record.resource_key,
                record.resource_version,
                record.project,
                record.repo,
                record.branch,
                record.commit_sha,
                record.work_item_id,
                record.pr_id,
                record.build_id,
                record.rid,
                record.todo_id,
                record.correlation_tier,
                record.payload_json,
                record.status,
                record.status_detail,
                record.occurred_at,
                record.processed_at,
            ],
        )
        .map_err(|error| format!("无法写入外部事件收件箱：{error}"))?;

    Ok(IngestExternalEventResult {
        duplicate: false,
        event: record,
    })
}

fn get_external_event_by_dedupe(
    connection: &Connection,
    dedupe_key: &str,
) -> Result<Option<ExternalEventRecord>, String> {
    connection
        .query_row(
            "SELECT
                id, dedupe_key, source, event_type, resource_key, resource_version,
                project, repo, branch, commit_sha, work_item_id, pr_id, build_id,
                rid, todo_id, correlation_tier, payload_json, status, status_detail,
                occurred_at, processed_at
             FROM external_events
             WHERE dedupe_key = ?1",
            params![dedupe_key],
            row_to_external_event,
        )
        .optional()
        .map_err(|error| format!("无法查询外部事件：{error}"))
}

fn row_to_external_event(row: &rusqlite::Row<'_>) -> rusqlite::Result<ExternalEventRecord> {
    Ok(ExternalEventRecord {
        id: row.get(0)?,
        dedupe_key: row.get(1)?,
        source: row.get(2)?,
        event_type: row.get(3)?,
        resource_key: row.get(4)?,
        resource_version: row.get(5)?,
        project: row.get(6)?,
        repo: row.get(7)?,
        branch: row.get(8)?,
        commit_sha: row.get(9)?,
        work_item_id: row.get(10)?,
        pr_id: row.get(11)?,
        build_id: row.get(12)?,
        rid: row.get(13)?,
        todo_id: row.get(14)?,
        correlation_tier: row.get(15)?,
        payload_json: row.get(16)?,
        status: row.get(17)?,
        status_detail: row.get(18)?,
        occurred_at: row.get(19)?,
        processed_at: row.get(20)?,
    })
}

fn is_native_host_dispatch_spec(spec_json: &str) -> bool {
    crate::native::work_command::is_native_command_spec(spec_json)
        || serde_json::from_str::<serde_json::Value>(spec_json)
            .ok()
            .is_some_and(|spec| {
                spec.get("executor").and_then(|value| value.as_str()) == Some("native_host")
                    || ["schema", "namespace"].iter().any(|field| {
                        spec.get(field)
                            .and_then(|value| value.as_str())
                            .is_some_and(|value| {
                                value.starts_with("rocketx.native")
                                    || value == "native"
                                    || value == "native_host"
                            })
                    })
            })
}

pub(crate) fn prepare_dispatch_action(
    connection: &Connection,
    input: PrepareDispatchActionInput,
) -> Result<DispatchActionRecord, String> {
    connection
        .execute_batch("SAVEPOINT dispatch_action_prepare;")
        .map_err(|error| format!("无法开始记录派发动作：{error}"))?;
    let result = prepare_dispatch_action_inner(connection, input).and_then(|record| {
        connection
            .execute_batch("RELEASE dispatch_action_prepare;")
            .map_err(|error| format!("无法提交派发动作：{error}"))?;
        Ok(record)
    });
    if result.is_err() {
        let _ = connection
            .execute_batch("ROLLBACK TO dispatch_action_prepare; RELEASE dispatch_action_prepare;");
    }
    result
}

fn prepare_dispatch_action_inner(
    connection: &Connection,
    mut input: PrepareDispatchActionInput,
) -> Result<DispatchActionRecord, String> {
    if !matches!(
        input.action_kind.as_str(),
        "session_create"
            | "session_prompt"
            | "session_steer"
            | "ado_comment"
            | "ado_state_write"
            | "rc_report"
    ) {
        return Err("派发动作类型无效".to_string());
    }
    let key = input.idempotency_key.trim();
    if key.is_empty() {
        return Err("派发动作 idempotencyKey 不能为空".to_string());
    }
    if key.starts_with("native-codex:v1:") || is_native_host_dispatch_spec(&input.spec_json) {
        return Err("原生命令由 NativeHost 接口独占管理，旧派发接口不能准备此动作".to_string());
    }

    // 幂等键只能重试同一冻结意图；当前卡片版本变化不应改变原请求的系统补充值。
    if let Some(existing) = get_dispatch_action_by_key(connection, key)? {
        if is_native_host_dispatch_spec(&existing.spec_json) {
            return Err("原生命令由 NativeHost 接口独占管理，旧派发接口不能复用此动作".to_string());
        }
        let same_spec = if input.spec_json == existing.spec_json {
            true
        } else if let (Ok(mut requested), Ok(frozen)) = (
            serde_json::from_str::<serde_json::Value>(&input.spec_json),
            serde_json::from_str::<serde_json::Value>(&existing.spec_json),
        ) {
            if matches!(
                input.action_kind.as_str(),
                "session_create" | "session_prompt" | "session_steer"
            ) {
                if let (Some(fields), Some(frozen_fields)) =
                    (requested.as_object_mut(), frozen.as_object())
                {
                    for version in ["requirementsVersion", "contentVersion"] {
                        if let Some(value) = frozen_fields.get(version) {
                            fields.entry(version).or_insert_with(|| value.clone());
                        }
                    }
                }
            }
            requested == frozen
        } else {
            false
        };
        if input.todo_id != existing.todo_id
            || input.event_id != existing.event_id
            || input.session_id != existing.session_id
            || input.action_kind != existing.action_kind
            || input.baseline_marker != existing.baseline_marker
            || !same_spec
        {
            return Err("派发动作幂等键已被不同的工作、目标或冻结规格使用".to_string());
        }
        if let Some(session_id) = existing.session_id.as_deref() {
            let host_owned: bool = connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM work_sessions WHERE id=?1 AND runtime_owner='native_host')",
                    params![session_id],
                    |row| row.get(0),
                )
                .map_err(|error| format!("无法校验目标会话所有权：{error}"))?;
            if host_owned {
                return Err("目标会话已由 NativeHost 接管，旧派发接口不能重试指令".to_string());
            }
        }
        return Ok(existing);
    }

    let todo = get_todo(connection, &input.todo_id)?
        .ok_or_else(|| "派发动作关联的工作卡片不存在".to_string())?;
    sync_card_state_on_todo_write(connection, &todo)?;
    let card_state = get_work_card_state(connection, &input.todo_id)?
        .unwrap_or_else(|| default_card_state_for_todo(&todo));
    if matches!(
        input.action_kind.as_str(),
        "session_create" | "session_prompt" | "session_steer"
    ) {
        let mut spec: serde_json::Value =
            serde_json::from_str(&input.spec_json).map_err(|e| format!("派发规格无效：{e}"))?;
        let fields = spec.as_object_mut().ok_or("派发规格必须为对象")?;
        fields
            .entry("requirementsVersion")
            .or_insert(serde_json::json!(card_state.requirements_version));
        fields
            .entry("contentVersion")
            .or_insert(serde_json::json!(card_state.content_version));
        input.spec_json = spec.to_string();
    }

    if card_state.wait_state == "paused" || card_state.wait_state == "canceled" {
        return Err("当前工作卡片处于已暂停或已取消状态，拒绝派发新动作".to_string());
    }
    if card_state.autonomy_mode == "readonly" {
        return Err("当前工作卡片处于只读模式，不允许派发执行动作".to_string());
    }

    if let Some(ref session_id) = input.session_id {
        let session: Option<(String, String, String)> = connection
            .query_row(
                "SELECT control_mode, visibility, runtime_owner FROM work_sessions WHERE id = ?1",
                params![session_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|error| format!("无法校验目标会话控制权：{error}"))?;
        if let Some((control_mode, session_visibility, runtime_owner)) = session {
            if runtime_owner == "native_host" {
                return Err("目标会话由 NativeHost 管理，旧派发接口不能发送指令".to_string());
            }
            if control_mode == "readonly" {
                return Err(
                    "目标会话为只读状态（可能被外部 writer 或其他设备占用），禁止直接发送指令"
                        .to_string(),
                );
            }
            if card_state.visibility == "private" && session_visibility == "room_shared" {
                return Err("隐私安全拦截：私人任务内容不得自动派发到团队共享会话".to_string());
            }
        }
    }

    let require_confirmation = input
        .require_confirmation
        .unwrap_or(card_state.autonomy_mode != "autonomous");
    let agent_action = matches!(
        input.action_kind.as_str(),
        "session_create" | "session_prompt" | "session_steer"
    );

    if agent_action
        && !require_confirmation
        && card_state.auto_turns_used >= card_state.max_auto_turns
    {
        return Err(format!(
            "已达到单卡自动推进轮次预算上限（{}/{}），需人工确认后再继续",
            card_state.auto_turns_used, card_state.max_auto_turns
        ));
    }
    if agent_action && !require_confirmation && card_state.consecutive_failures >= 2 {
        return Err("已达到连续失败上限，需人工检查后继续".to_string());
    }

    let now = now_millis();
    let initial_state = if require_confirmation {
        "awaiting_approval"
    } else {
        "prepared"
    };

    let record = DispatchActionRecord {
        id: uuid::Uuid::new_v4().to_string(),
        idempotency_key: key.to_string(),
        todo_id: input.todo_id.clone(),
        event_id: input.event_id,
        session_id: input.session_id,
        action_kind: input.action_kind,
        spec_json: input.spec_json,
        baseline_marker: input.baseline_marker,
        state: initial_state.to_string(),
        receipt_ref: None,
        error_message: None,
        created_at: now,
        updated_at: now,
    };

    connection
        .execute(
            "INSERT INTO dispatch_actions (
                id, idempotency_key, todo_id, event_id, session_id, action_kind,
                spec_json, baseline_marker, state, receipt_ref, error_message,
                created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, NULL, ?10, ?11)",
            params![
                record.id,
                record.idempotency_key,
                record.todo_id,
                record.event_id,
                record.session_id,
                record.action_kind,
                record.spec_json,
                record.baseline_marker,
                record.state,
                record.created_at,
                record.updated_at,
            ],
        )
        .map_err(|error| format!("无法记录派发动作：{error}"))?;

    if agent_action && !require_confirmation {
        connection
            .execute(
                "UPDATE work_card_states
                 SET auto_turns_used = auto_turns_used + 1,
                     stage = CASE WHEN stage = 'ready' THEN 'in_progress' ELSE stage END,
                     updated_at = ?2
                 WHERE todo_id = ?1",
                params![input.todo_id, now],
            )
            .map_err(|error| format!("无法累计自动推进预算：{error}"))?;
    }

    Ok(record)
}

pub(crate) fn transition_dispatch_action(
    connection: &Connection,
    input: TransitionDispatchActionInput,
) -> Result<DispatchActionRecord, String> {
    if !matches!(
        input.state.as_str(),
        "awaiting_approval"
            | "prepared"
            | "dispatched"
            | "verifying_delivery"
            | "acknowledged"
            | "completed"
            | "failed"
            | "canceled"
    ) {
        return Err("派发动作目标状态无效".to_string());
    }
    let existing: (String, String, String, Option<String>) = connection
        .query_row(
            "SELECT action.idempotency_key, action.spec_json, action.action_kind, session.runtime_owner
             FROM dispatch_actions AS action
             LEFT JOIN work_sessions AS session ON session.id = action.session_id
             WHERE action.id = ?1",
            params![input.id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(|error| format!("无法校验派发动作所有权：{error}"))?
        .ok_or("派发动作不存在或已被其他执行者更新")?;
    if existing.0.trim().starts_with("native-codex:v1:")
        || is_native_host_dispatch_spec(&existing.1)
    {
        return Err("原生命令由 NativeHost 接口独占管理，旧派发接口不能变更其状态".to_string());
    }
    if matches!(
        existing.2.as_str(),
        "session_create" | "session_prompt" | "session_steer"
    ) && existing.3.as_deref() == Some("native_host")
    {
        return Err("目标会话已由 NativeHost 接管，旧派发接口不能推进执行动作".to_string());
    }
    let now = now_millis();
    let changed = connection
        .execute(
            "UPDATE dispatch_actions
             SET state = ?2,
                 receipt_ref = COALESCE(?3, receipt_ref),
                 error_message = ?4,
                 updated_at = ?5
             WHERE id = ?1 AND (?6 IS NULL OR state=?6)
               AND spec_json = ?7 AND idempotency_key = ?8
               AND (action_kind NOT IN ('session_create', 'session_prompt', 'session_steer')
                    OR NOT EXISTS (
                        SELECT 1 FROM work_sessions
                        WHERE work_sessions.id = dispatch_actions.session_id
                          AND work_sessions.runtime_owner = 'native_host'
                    ))",
            params![
                input.id,
                input.state,
                input.receipt_ref,
                input.error_message,
                now,
                input.expected_state,
                existing.1,
                existing.0,
            ],
        )
        .map_err(|error| format!("无法更新派发动作状态：{error}"))?;
    if changed == 0 {
        return Err("派发动作不存在或已被其他执行者更新".to_string());
    }
    connection
        .query_row(
            "SELECT
                id, idempotency_key, todo_id, event_id, session_id, action_kind,
                spec_json, baseline_marker, state, receipt_ref, error_message,
                created_at, updated_at
             FROM dispatch_actions
             WHERE id = ?1",
            params![input.id],
            row_to_dispatch_action,
        )
        .map_err(|error| format!("无法读取更新后的派发动作：{error}"))
}

pub(crate) fn get_dispatch_action_by_key(
    connection: &Connection,
    key: &str,
) -> Result<Option<DispatchActionRecord>, String> {
    connection
        .query_row(
            "SELECT
                id, idempotency_key, todo_id, event_id, session_id, action_kind,
                spec_json, baseline_marker, state, receipt_ref, error_message,
                created_at, updated_at
             FROM dispatch_actions
             WHERE idempotency_key = ?1",
            params![key],
            row_to_dispatch_action,
        )
        .optional()
        .map_err(|error| format!("无法查询派发动作：{error}"))
}

pub(crate) fn row_to_dispatch_action(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<DispatchActionRecord> {
    Ok(DispatchActionRecord {
        id: row.get(0)?,
        idempotency_key: row.get(1)?,
        todo_id: row.get(2)?,
        event_id: row.get(3)?,
        session_id: row.get(4)?,
        action_kind: row.get(5)?,
        spec_json: row.get(6)?,
        baseline_marker: row.get(7)?,
        state: row.get(8)?,
        receipt_ref: row.get(9)?,
        error_message: row.get(10)?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
    })
}

pub(crate) fn read_work_ledger_snapshot(
    connection: &Connection,
) -> Result<WorkLedgerSnapshot, String> {
    let todos = super::list_todos(connection, TodoFilter::default())?;
    let mut cards = Vec::with_capacity(todos.len());
    for mut todo in todos {
        sync_card_state_on_todo_write(connection, &todo)?;
        let state = get_work_card_state(connection, &todo.id)?
            .unwrap_or_else(|| default_card_state_for_todo(&todo));
        if state.requirements_version > 0 {
            todo.done = state.stage == "done";
            if !todo.done {
                todo.done_at = None;
            }
        }
        cards.push(WorkCard { todo, state });
    }

    let mut link_stmt = connection
        .prepare(
            "SELECT
                id, todo_id, kind, external_id, project, repo, rid,
                head_sha, title, web_url, state_snapshot, last_verified_at, created_at
             FROM work_links
             ORDER BY last_verified_at DESC",
        )
        .map_err(|error| format!("无法准备关联查询：{error}"))?;
    let links = link_stmt
        .query_map([], |row| {
            Ok(WorkLink {
                id: row.get(0)?,
                todo_id: row.get(1)?,
                kind: row.get(2)?,
                external_id: row.get(3)?,
                project: row.get(4)?,
                repo: row.get(5)?,
                rid: row.get(6)?,
                head_sha: row.get(7)?,
                title: row.get(8)?,
                web_url: row.get(9)?,
                state_snapshot: row.get(10)?,
                last_verified_at: row.get(11)?,
                created_at: row.get(12)?,
            })
        })
        .map_err(|error| format!("无法查询工作关联：{error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("无法读取工作关联记录：{error}"))?;

    let mut session_stmt = connection
        .prepare(
            "SELECT
                id, todo_id, visibility, runtime, origin, native_session_id, title,
                workspace_root, environment_id, account_scope, control_endpoint,
                control_mode, control_reason, host_device_id, writer_lease_owner,
                writer_lease_expires_at, runtime_status, config_snapshot_json,
                last_event_seq, last_turn_id, last_verified_at, created_at, updated_at, source_scope
             FROM work_sessions
             ORDER BY updated_at DESC",
        )
        .map_err(|error| format!("无法准备会话查询：{error}"))?;
    let sessions = session_stmt
        .query_map([], |row| {
            Ok(WorkSessionRecord {
                id: row.get(0)?,
                todo_id: row.get(1)?,
                visibility: row.get(2)?,
                runtime: row.get(3)?,
                origin: row.get(4)?,
                native_session_id: row.get(5)?,
                title: row.get(6)?,
                workspace_root: row.get(7)?,
                environment_id: row.get(8)?,
                account_scope: row.get(9)?,
                control_endpoint: row.get(10)?,
                control_mode: row.get(11)?,
                control_reason: row.get(12)?,
                host_device_id: row.get(13)?,
                writer_lease_owner: row.get(14)?,
                writer_lease_expires_at: row.get(15)?,
                runtime_status: row.get(16)?,
                config_snapshot_json: row.get(17)?,
                last_event_seq: row.get(18)?,
                last_turn_id: row.get(19)?,
                last_verified_at: row.get(20)?,
                created_at: row.get(21)?,
                updated_at: row.get(22)?,
                source_scope: row.get(23)?,
            })
        })
        .map_err(|error| format!("无法查询工作会话：{error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("无法读取工作会话记录：{error}"))?;

    let mut evidence_stmt = connection
        .prepare(
            "SELECT
                id, todo_id, session_id, kind, title, summary, head_sha,
                workspace_root, web_url, passed, stale, stale_reason, verified_at, created_at,
                criterion_ids_json,requirements_version,content_version,accepted_by,acceptance_scope_json
             FROM work_evidences
             ORDER BY created_at DESC",
        )
        .map_err(|error| format!("无法准备证据查询：{error}"))?;
    let evidences = evidence_stmt
        .query_map([], |row| {
            Ok(WorkEvidence {
                id: row.get(0)?,
                todo_id: row.get(1)?,
                session_id: row.get(2)?,
                kind: row.get(3)?,
                title: row.get(4)?,
                summary: row.get(5)?,
                head_sha: row.get(6)?,
                workspace_root: row.get(7)?,
                web_url: row.get(8)?,
                passed: row.get::<_, i64>(9)? != 0,
                stale: row.get::<_, i64>(10)? != 0,
                stale_reason: row.get(11)?,
                verified_at: row.get(12)?,
                created_at: row.get(13)?,
                criterion_ids: parse_string_vec(&row.get::<_, String>(14)?),
                requirements_version: row.get(15)?,
                content_version: row.get(16)?,
                accepted_by: row.get(17)?,
                acceptance_scope: parse_string_vec(&row.get::<_, String>(18)?),
            })
        })
        .map_err(|error| format!("无法查询验收证据：{error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("无法读取验收证据记录：{error}"))?;

    let mut event_stmt = connection
        .prepare(
            "SELECT
                id, dedupe_key, source, event_type, resource_key, resource_version,
                project, repo, branch, commit_sha, work_item_id, pr_id, build_id,
                rid, todo_id, correlation_tier, payload_json, status, status_detail,
                occurred_at, processed_at
             FROM external_events
             ORDER BY occurred_at DESC
             LIMIT 200",
        )
        .map_err(|error| format!("无法准备外部事件查询：{error}"))?;
    let events = event_stmt
        .query_map([], row_to_external_event)
        .map_err(|error| format!("无法查询外部事件列表：{error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("无法读取外部事件记录：{error}"))?;

    let mut action_stmt = connection
        .prepare(
            "SELECT
                id, idempotency_key, todo_id, event_id, session_id, action_kind,
                spec_json, baseline_marker, state, receipt_ref, error_message,
                created_at, updated_at
             FROM dispatch_actions
             ORDER BY updated_at DESC
             LIMIT 200",
        )
        .map_err(|error| format!("无法准备派发动作查询：{error}"))?;
    let actions = action_stmt
        .query_map([], row_to_dispatch_action)
        .map_err(|error| format!("无法查询派发动作列表：{error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("无法读取派发动作记录：{error}"))?;

    Ok(WorkLedgerSnapshot {
        cards,
        links,
        sessions,
        evidences,
        events,
        actions,
    })
}

#[tauri::command]
pub async fn butler_work_ledger_snapshot(
    db: tauri::State<'_, ButlerDb>,
) -> Result<WorkLedgerSnapshot, String> {
    run_db(db.ready_connection()?, |connection| {
        read_work_ledger_snapshot(connection)
    })
    .await
}

#[tauri::command]
pub async fn butler_work_card_update(
    db: tauri::State<'_, ButlerDb>,
    id: String,
    patch: WorkCardPatch,
) -> Result<WorkCard, String> {
    run_db(db.ready_connection()?, move |connection| {
        update_work_card(connection, &id, patch)
    })
    .await
}

#[tauri::command]
pub async fn butler_work_card_create(
    db: tauri::State<'_, ButlerDb>,
    input: CreateWorkCardInput,
) -> Result<WorkCard, String> {
    run_db(db.ready_connection()?, move |connection| {
        create_work_card(connection, input)
    })
    .await
}

#[tauri::command]
pub async fn butler_work_link_upsert(
    db: tauri::State<'_, ButlerDb>,
    link: UpsertWorkLinkInput,
) -> Result<WorkLink, String> {
    run_db(db.ready_connection()?, move |connection| {
        upsert_work_link(connection, link)
    })
    .await
}

#[tauri::command]
pub async fn butler_work_session_upsert(
    db: tauri::State<'_, ButlerDb>,
    session: UpsertWorkSessionInput,
) -> Result<WorkSessionRecord, String> {
    run_db(db.ready_connection()?, move |connection| {
        upsert_work_session(connection, session)
    })
    .await
}

#[tauri::command]
pub async fn butler_work_evidence_add(
    db: tauri::State<'_, ButlerDb>,
    evidence: NewWorkEvidenceInput,
) -> Result<WorkEvidence, String> {
    run_db(db.ready_connection()?, move |connection| {
        add_work_evidence(connection, evidence)
    })
    .await
}

#[tauri::command]
pub async fn butler_external_event_ingest(
    db: tauri::State<'_, ButlerDb>,
    event: IngestExternalEventInput,
) -> Result<IngestExternalEventResult, String> {
    run_db(db.ready_connection()?, move |connection| {
        ingest_external_event(connection, event)
    })
    .await
}

#[tauri::command]
pub async fn butler_dispatch_action_prepare(
    db: tauri::State<'_, ButlerDb>,
    action: PrepareDispatchActionInput,
) -> Result<DispatchActionRecord, String> {
    run_db(db.ready_connection()?, move |connection| {
        prepare_dispatch_action(connection, action)
    })
    .await
}

#[tauri::command]
pub async fn butler_dispatch_action_transition(
    db: tauri::State<'_, ButlerDb>,
    transition: TransitionDispatchActionInput,
) -> Result<DispatchActionRecord, String> {
    run_db(db.ready_connection()?, move |connection| {
        transition_dispatch_action(connection, transition)
    })
    .await
}

#[cfg(test)]
mod ledger_tests {
    use super::*;
    use crate::butler_db::{add_todo, migrate, NewTodo};

    fn setup_db() -> Connection {
        let mut connection =
            Connection::open_in_memory().expect("open in-memory SQLite for work ledger");
        migrate(&mut connection).expect("migrate Butler + Ledger tables");
        connection
    }

    fn create_sample_card(connection: &Connection, title: &str, work_item_id: Option<i64>) -> Todo {
        add_todo(
            connection,
            NewTodo {
                source: Some(
                    if work_item_id.is_some() {
                        "ado"
                    } else {
                        "manual"
                    }
                    .to_string(),
                ),
                rid: None,
                mid: None,
                ado_work_item_id: work_item_id,
                ado_project: Some("RocketX".to_string()),
                title: title.to_string(),
                note: Some("跟进 CI 与 PR 状态".to_string()),
                room_name: None,
                author: None,
                done: Some(false),
                priority: Some(2),
                due: Some("2026-11-10".to_string()),
                done_at: None,
                committed_to: None,
                waiting_for: None,
            },
        )
        .expect("create sample todo")
    }

    fn legacy_native_dispatch_db() -> Connection {
        let connection = setup_db();
        connection
            .execute_batch("PRAGMA foreign_keys=ON; DROP TABLE dispatch_actions;")
            .unwrap();
        let start = SCHEMA_LEDGER_TABLES
            .find("CREATE TABLE IF NOT EXISTS dispatch_actions (")
            .unwrap();
        let definition = &SCHEMA_LEDGER_TABLES[start..];
        let end = definition.find("\n    );").unwrap() + 7;
        let legacy = definition[..end]
            .replace("            'session_resume',\n", "")
            .replace("            'session_interrupt',\n", "");
        connection.execute_batch(&format!("{legacy}; CREATE INDEX idx_dispatch_actions_todo ON dispatch_actions(todo_id,state);
            INSERT INTO todos(id,title,created_at,updated_at) VALUES('migration-work','migration',1,1);
            INSERT INTO work_sessions(id,todo_id,runtime,native_session_id,workspace_root,control_mode,last_verified_at,created_at,updated_at)
                VALUES('migration-binding','migration-work','codex','migration-thread','C:/work','resumable',1,1,1);
            INSERT INTO dispatch_actions(id,idempotency_key,todo_id,session_id,action_kind,spec_json,state,receipt_ref,created_at,updated_at)
                VALUES('original-action','original-key','migration-work','migration-binding','session_prompt','{{}}','acknowledged','original-receipt',1,2);")).unwrap();
        connection
    }

    #[test]
    fn native_dispatch_kinds_migration_preserves_ids_receipts_and_foreign_keys() {
        let connection = legacy_native_dispatch_db();
        migrate_native_dispatch_kinds(&connection).unwrap();
        migrate_native_dispatch_kinds(&connection).unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT id,receipt_ref,state,session_id FROM dispatch_actions",
                    [],
                    |row| Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?
                    ))
                )
                .unwrap(),
            (
                "original-action".into(),
                "original-receipt".into(),
                "acknowledged".into(),
                "migration-binding".into()
            )
        );
        for kind in ["session_resume", "session_interrupt"] {
            connection.execute("INSERT INTO dispatch_actions(id,idempotency_key,todo_id,session_id,action_kind,spec_json,state,created_at,updated_at) VALUES(?1,?1,'migration-work','migration-binding',?1,'{}','prepared',3,3)", [kind]).unwrap();
        }
        let violations: i64 = connection
            .query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(violations, 0);
        connection
            .execute("DELETE FROM work_sessions WHERE id='migration-binding'", [])
            .unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT count(*) FROM dispatch_actions WHERE session_id IS NULL",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            3
        );
        connection
            .execute("DELETE FROM todos WHERE id='migration-work'", [])
            .unwrap();
        assert_eq!(
            connection
                .query_row("SELECT count(*) FROM dispatch_actions", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn native_dispatch_kinds_migration_respects_outer_transaction_and_rolls_back_failure() {
        let connection = legacy_native_dispatch_db();
        connection.execute_batch("BEGIN;").unwrap();
        migrate_native_dispatch_kinds(&connection).unwrap();
        assert!(!connection.is_autocommit());
        connection.execute_batch("ROLLBACK;").unwrap();
        assert!(connection
            .execute(
                "UPDATE dispatch_actions SET action_kind='session_resume'",
                []
            )
            .is_err());
        connection
            .execute_batch("CREATE TABLE dispatch_actions_native_new(conflict TEXT);")
            .unwrap();
        assert!(migrate_native_dispatch_kinds(&connection).is_err());
        assert!(connection.is_autocommit());
        assert_eq!(
            connection
                .query_row("SELECT id FROM dispatch_actions", [], |row| row
                    .get::<_, String>(0))
                .unwrap(),
            "original-action"
        );
        connection
            .execute_batch("DROP TABLE dispatch_actions_native_new;")
            .unwrap();
        migrate_native_dispatch_kinds(&connection).unwrap();
    }

    #[test]
    fn followed_work_rejects_legacy_completion_and_preserves_identity_on_rework() {
        let connection = setup_db();
        let todo = create_sample_card(&connection, "跟进同一件工作", None);
        let card = update_work_card(&connection,&todo.id, serde_json::from_value(serde_json::json!({"enroll":true,"goal":"交付修复","acceptance":["测试通过","人工审阅"],"waitState":"waiting_input"})).unwrap()).unwrap();
        update_todo(
            &connection,
            &todo.id,
            TodoPatch {
                done: Some(true),
                ..TodoPatch::default()
            },
        )
        .unwrap();
        let snapshot = read_work_ledger_snapshot(&connection).unwrap();
        assert!(!snapshot.cards[0].todo.done);
        assert_eq!(snapshot.cards[0].state.wait_state, "waiting_input");
        assert!(update_work_card(
            &connection,
            &todo.id,
            WorkCardPatch {
                stage: Some("done".into()),
                human_confirmed_done: Some(true),
                ..WorkCardPatch::default()
            }
        )
        .is_err());
        assert!(add_work_evidence(
            &connection,
            NewWorkEvidenceInput {
                todo_id: todo.id.clone(),
                kind: "manual_ack".into(),
                title: "伪造人工确认".into(),
                passed: true,
                ..NewWorkEvidenceInput::default()
            }
        )
        .is_err());
        let accepting = || serde_json::json!({"stage":"done","waitState":"none","humanAcceptance":{"actorId":"server:alice","criterionIds":["测试通过","人工审阅"]}});
        assert!(update_work_card(
            &connection,
            &todo.id,
            serde_json::from_value(accepting()).unwrap()
        )
        .unwrap_err()
        .contains("已审阅"));
        let mut stale = accepting();
        stale["expectedRequirementsVersion"] = serde_json::json!(0);
        stale["expectedContentVersion"] = serde_json::json!(0);
        assert!(update_work_card(
            &connection,
            &todo.id,
            serde_json::from_value(stale).unwrap()
        )
        .unwrap_err()
        .contains("当前版本"));
        let mut current = accepting();
        current["expectedRequirementsVersion"] = serde_json::json!(card.state.requirements_version);
        current["expectedContentVersion"] = serde_json::json!(card.state.content_version);
        let done = update_work_card(
            &connection,
            &todo.id,
            serde_json::from_value(current).unwrap(),
        )
        .unwrap();
        assert!(done.todo.done);
        let ev = read_work_ledger_snapshot(&connection)
            .unwrap()
            .evidences
            .remove(0);
        assert_eq!(ev.accepted_by.as_deref(), Some("server:alice"));
        assert_eq!(ev.requirements_version, card.state.requirements_version);
        let rework = update_work_card(
            &connection,
            &todo.id,
            WorkCardPatch {
                rework: Some(true),
                ..WorkCardPatch::default()
            },
        )
        .unwrap();
        assert_eq!(rework.todo.id, todo.id);
        assert_eq!(rework.state.stage, "in_progress");
        assert_eq!(rework.state.content_version, done.state.content_version + 1);
        assert!(read_work_ledger_snapshot(&connection).unwrap().evidences[0].stale);
        assert!(update_work_card(
            &connection,
            &todo.id,
            WorkCardPatch {
                stage: Some("done".into()),
                ..WorkCardPatch::default()
            }
        )
        .is_err());
    }

    #[test]
    fn native_identity_separates_sources_and_upgrades_legacy_without_breaking_references() {
        let connection = setup_db();
        let todo = create_sample_card(&connection, "保留原会话关联", None);
        let session = |scope: Option<&str>| UpsertWorkSessionInput {
            runtime: "codex".into(),
            native_session_id: "same-native-id".into(),
            source_scope: scope.map(str::to_string),
            host_device_id: Some("host".into()),
            account_scope: Some("alice".into()),
            workspace_root: "D:/Repos/work".into(),
            control_mode: "readonly".into(),
            todo_id: Some(todo.id.clone()),
            ..UpsertWorkSessionInput::default()
        };
        let legacy = upsert_work_session(&connection, session(None)).unwrap();
        let upgraded = upsert_work_session(&connection, session(Some("codex:C:/data/a"))).unwrap();
        assert_eq!(legacy.id, upgraded.id);
        let second = upsert_work_session(&connection, session(Some("codex:C:/data/b"))).unwrap();
        assert_ne!(upgraded.id, second.id);
        assert_eq!(upgraded.todo_id, Some(todo.id.clone()));
        migrate_ledger(&connection).unwrap();
        assert_eq!(
            read_work_ledger_snapshot(&connection)
                .unwrap()
                .sessions
                .len(),
            2
        );
        assert_eq!(
            upsert_work_session(&connection, session(Some("codex:C:/data/a")))
                .unwrap()
                .id,
            upgraded.id
        );
    }

    #[test]
    fn workspace_fingerprint_invalidates_current_acceptance_without_a_head_change() {
        let connection = setup_db();
        let todo = create_sample_card(&connection, "未提交修改使验收失效", None);
        update_work_card(
            &connection,
            &todo.id,
            serde_json::from_value(
                serde_json::json!({"enroll":true,"goal":"修复并验证","acceptance":["测试通过"]}),
            )
            .unwrap(),
        )
        .unwrap();
        let observe = |fingerprint: &str| {
            upsert_work_link(
                &connection,
                UpsertWorkLinkInput {
                    todo_id: todo.id.clone(),
                    kind: "git_branch".into(),
                    external_id: "workspace:d:/repos/work".into(),
                    state_snapshot: Some(format!("content:{fingerprint}")),
                    head_sha: Some("same-head".into()),
                    project: None,
                    repo: None,
                    rid: None,
                    title: Some("main".into()),
                    web_url: None,
                },
            )
        };
        observe("baseline").unwrap();
        let reviewed = get_work_card_state(&connection, &todo.id).unwrap().unwrap();
        update_work_card(&connection,&todo.id,serde_json::from_value(serde_json::json!({"stage":"done","expectedRequirementsVersion":reviewed.requirements_version,"expectedContentVersion":reviewed.content_version,"humanAcceptance":{"actorId":"alice","criterionIds":["测试通过"]}})).unwrap()).unwrap();
        observe("baseline").unwrap();
        assert_eq!(
            get_work_card_state(&connection, &todo.id)
                .unwrap()
                .unwrap()
                .stage,
            "done"
        );
        observe("edited-by-another-client").unwrap();
        let snapshot = read_work_ledger_snapshot(&connection).unwrap();
        assert_eq!(
            snapshot.cards[0].state.content_version,
            reviewed.content_version + 1
        );
        assert_eq!(snapshot.cards[0].state.stage, "verifying");
        assert!(!snapshot.cards[0].todo.done);
        assert!(snapshot.evidences[0].stale);
        assert_eq!(
            snapshot.evidences[0].stale_reason.as_deref(),
            Some("workspace_content_changed")
        );
    }

    #[test]
    fn external_deliveries_do_not_consume_agent_turn_budget() {
        let connection = setup_db();
        let todo = create_sample_card(&connection, "默认预算完整交付", None);
        update_work_card(&connection,&todo.id,serde_json::from_value(serde_json::json!({"enroll":true,"goal":"修复并汇报","acceptance":["通过测试"],"autonomyMode":"autonomous","maxAutoTurns":3})).unwrap()).unwrap();
        let prepare = |key: &str, kind: &str| {
            prepare_dispatch_action(
                &connection,
                PrepareDispatchActionInput {
                    idempotency_key: key.into(),
                    todo_id: todo.id.clone(),
                    action_kind: kind.into(),
                    spec_json: "{}".into(),
                    event_id: None,
                    session_id: None,
                    baseline_marker: None,
                    require_confirmation: Some(false),
                },
            )
        };
        for turn in 0..3 {
            prepare(&format!("turn-{turn}"), "session_create").unwrap();
        }
        assert_eq!(prepare("ado", "ado_state_write").unwrap().state, "prepared");
        assert_eq!(prepare("report", "rc_report").unwrap().state, "prepared");
        assert_eq!(
            get_work_card_state(&connection, &todo.id)
                .unwrap()
                .unwrap()
                .auto_turns_used,
            3
        );
        assert!(prepare("fourth", "session_create")
            .unwrap_err()
            .contains("预算"));
    }

    #[test]
    fn dispatch_action_idempotency_rejects_changed_frozen_intent() {
        let connection = setup_db();
        let todo = create_sample_card(&connection, "冻结派发意图", None);
        let other_todo = create_sample_card(&connection, "另一项工作", None);
        let session = |native_id: &str| {
            upsert_work_session(
                &connection,
                UpsertWorkSessionInput {
                    todo_id: Some(todo.id.clone()),
                    runtime: "codex".into(),
                    native_session_id: native_id.into(),
                    workspace_root: "D:/Repos/rocketchatx".into(),
                    control_endpoint: Some("owned-probe".into()),
                    control_mode: "controllable".into(),
                    control_reason: Some("owned_live_controller".into()),
                    ..UpsertWorkSessionInput::default()
                },
            )
            .unwrap()
        };
        let first_session = session("frozen-intent-1");
        let other_session = session("frozen-intent-2");
        let make = || PrepareDispatchActionInput {
            idempotency_key: "frozen-intent".into(),
            todo_id: todo.id.clone(),
            event_id: None,
            session_id: Some(first_session.id.clone()),
            action_kind: "session_prompt".into(),
            spec_json: r#"{"prompt":"修复登录","options":{"verify":true}}"#.into(),
            baseline_marker: Some("turn-1".into()),
            require_confirmation: Some(true),
        };
        let original = prepare_dispatch_action(&connection, make()).unwrap();
        for field in [
            "todo",
            "session",
            "kind",
            "spec",
            "event",
            "baseline",
            "requirements",
            "content",
        ] {
            let mut changed = make();
            match field {
                "todo" => changed.todo_id = other_todo.id.clone(),
                "session" => changed.session_id = Some(other_session.id.clone()),
                "kind" => changed.action_kind = "session_steer".into(),
                "spec" => {
                    changed.spec_json = r#"{"prompt":"删除登录","options":{"verify":true}}"#.into()
                }
                "event" => changed.event_id = Some("different-event".into()),
                "baseline" => changed.baseline_marker = Some("turn-2".into()),
                "requirements" => changed.spec_json =
                    r#"{"prompt":"修复登录","options":{"verify":true},"requirementsVersion":99}"#
                        .into(),
                "content" => {
                    changed.spec_json =
                        r#"{"prompt":"修复登录","options":{"verify":true},"contentVersion":99}"#
                            .into()
                }
                _ => unreachable!(),
            }
            assert!(
                prepare_dispatch_action(&connection, changed)
                    .unwrap_err()
                    .contains("幂等键"),
                "changed {field} must not reuse the action"
            );
        }
        let snapshot = read_work_ledger_snapshot(&connection).unwrap();
        assert_eq!(snapshot.actions.len(), 1);
        assert_eq!(snapshot.actions[0].id, original.id);
        assert_eq!(
            get_work_card_state(&connection, &todo.id)
                .unwrap()
                .unwrap()
                .auto_turns_used,
            0
        );
    }

    #[test]
    fn dispatch_action_idempotent_retry_uses_original_frozen_versions() {
        let connection = setup_db();
        let todo = create_sample_card(&connection, "重试同一派发", None);
        update_work_card(
            &connection,
            &todo.id,
            WorkCardPatch {
                autonomy_mode: Some("autonomous".into()),
                max_auto_turns: Some(1),
                ..WorkCardPatch::default()
            },
        )
        .unwrap();
        let make = || PrepareDispatchActionInput {
            idempotency_key: "retry-original".into(),
            todo_id: todo.id.clone(),
            event_id: None,
            session_id: None,
            action_kind: "session_create".into(),
            spec_json: r#"{"prompt":"修复登录","options":{"verify":true}}"#.into(),
            baseline_marker: None,
            require_confirmation: Some(false),
        };
        let original = prepare_dispatch_action(&connection, make()).unwrap();
        transition_dispatch_action(
            &connection,
            TransitionDispatchActionInput {
                id: original.id.clone(),
                state: "completed".into(),
                receipt_ref: None,
                error_message: None,
                expected_state: Some("prepared".into()),
            },
        )
        .unwrap();
        connection.execute("UPDATE work_card_states SET requirements_version=requirements_version+1, content_version=content_version+1 WHERE todo_id=?1", params![todo.id]).unwrap();
        let retry = prepare_dispatch_action(&connection, make()).unwrap();
        assert_eq!(retry.id, original.id);
        assert_eq!(retry.state, "completed");
        assert_eq!(retry.spec_json, original.spec_json);
        let mut reordered = make();
        reordered.spec_json =
            "{ \"options\": { \"verify\": true }, \"prompt\": \"修复登录\" }".into();
        assert_eq!(
            prepare_dispatch_action(&connection, reordered).unwrap().id,
            original.id
        );
        let mut explicit_frozen = make();
        explicit_frozen.spec_json = original.spec_json;
        assert_eq!(
            prepare_dispatch_action(&connection, explicit_frozen)
                .unwrap()
                .id,
            original.id
        );
        assert_eq!(
            read_work_ledger_snapshot(&connection)
                .unwrap()
                .actions
                .len(),
            1
        );
        assert_eq!(
            get_work_card_state(&connection, &todo.id)
                .unwrap()
                .unwrap()
                .auto_turns_used,
            1
        );
    }

    #[test]
    fn dispatch_action_budget_update_failure_rolls_back_prepare_inside_outer_transaction() {
        let connection = setup_db();
        let todo = create_sample_card(&connection, "预算写入故障回滚", None);
        update_work_card(
            &connection,
            &todo.id,
            WorkCardPatch {
                autonomy_mode: Some("autonomous".into()),
                max_auto_turns: Some(1),
                ..WorkCardPatch::default()
            },
        )
        .unwrap();
        let before = get_work_card_state(&connection, &todo.id).unwrap().unwrap();
        connection.execute_batch("BEGIN;
            CREATE TRIGGER reject_auto_turn_budget AFTER UPDATE OF auto_turns_used ON work_card_states
            WHEN NEW.auto_turns_used > OLD.auto_turns_used
            BEGIN SELECT RAISE(ABORT, 'injected budget failure'); END;").unwrap();
        let make = || PrepareDispatchActionInput {
            idempotency_key: "rollback-budget".into(),
            todo_id: todo.id.clone(),
            event_id: None,
            session_id: None,
            action_kind: "session_create".into(),
            spec_json: "{}".into(),
            baseline_marker: None,
            require_confirmation: Some(false),
        };
        assert!(prepare_dispatch_action(&connection, make())
            .unwrap_err()
            .contains("injected budget failure"));
        assert!(
            !connection.is_autocommit(),
            "prepare must preserve the caller's transaction"
        );
        assert!(get_dispatch_action_by_key(&connection, "rollback-budget")
            .unwrap()
            .is_none());
        let after = get_work_card_state(&connection, &todo.id).unwrap().unwrap();
        assert_eq!(after.auto_turns_used, before.auto_turns_used);
        assert_eq!(after.stage, before.stage);
        assert_eq!(after.updated_at, before.updated_at);
        connection
            .execute_batch("DROP TRIGGER reject_auto_turn_budget;")
            .unwrap();
        let prepared = prepare_dispatch_action(&connection, make()).unwrap();
        assert_eq!(prepared.state, "prepared");
        assert_eq!(
            get_work_card_state(&connection, &todo.id)
                .unwrap()
                .unwrap()
                .auto_turns_used,
            1
        );
        connection.execute_batch("ROLLBACK;").unwrap();
        assert!(get_dispatch_action_by_key(&connection, "rollback-budget")
            .unwrap()
            .is_none());
        assert_eq!(
            get_work_card_state(&connection, &todo.id)
                .unwrap()
                .unwrap()
                .auto_turns_used,
            0
        );
    }

    #[test]
    fn native_host_session_ownership_migration_is_repeatable_and_keeps_outer_transaction() {
        let connection = setup_db();
        connection.execute("INSERT INTO work_sessions(id,runtime,native_session_id,workspace_root,control_mode,last_verified_at,created_at,updated_at) VALUES('migration-session','codex','migration-thread','D:/Repos/rocketchatx','resumable',1,1,1)", []).unwrap();
        connection
            .execute_batch(
                "ALTER TABLE work_sessions DROP COLUMN binding_version;
            ALTER TABLE work_sessions DROP COLUMN runtime_owner;
            BEGIN;",
            )
            .unwrap();
        migrate_session_host_ownership(&connection).unwrap();
        migrate_session_host_ownership(&connection).unwrap();
        assert!(!connection.is_autocommit());
        assert_eq!(connection.query_row("SELECT binding_version,runtime_owner FROM work_sessions WHERE id='migration-session'", [], |row| Ok((row.get::<_,i64>(0)?,row.get::<_,String>(1)?))).unwrap(), (0, "legacy".into()));
        connection.execute_batch("ROLLBACK;").unwrap();
        assert!(!table_has_column(&connection, "work_sessions", "binding_version").unwrap());
        assert!(!table_has_column(&connection, "work_sessions", "runtime_owner").unwrap());
        migrate_ledger(&connection).unwrap();
        connection.execute("UPDATE work_sessions SET binding_version=7,runtime_owner='native_host' WHERE id='migration-session'", []).unwrap();
        migrate_ledger(&connection).unwrap();
        assert_eq!(connection.query_row("SELECT binding_version,runtime_owner FROM work_sessions WHERE id='migration-session'", [], |row| Ok((row.get::<_,i64>(0)?,row.get::<_,String>(1)?))).unwrap(), (7, "native_host".into()));
    }

    #[test]
    fn native_host_session_ownership_migration_rolls_back_partial_schema_failure() {
        let connection = setup_db();
        // A synthetic incompatible generated column makes the second ALTER fail after the first succeeds.
        connection.execute_batch("ALTER TABLE work_sessions DROP COLUMN binding_version;
            ALTER TABLE work_sessions DROP COLUMN runtime_owner;
            ALTER TABLE work_sessions ADD COLUMN runtime_owner TEXT GENERATED ALWAYS AS ('legacy') VIRTUAL;").unwrap();
        assert!(migrate_session_host_ownership(&connection)
            .unwrap_err()
            .contains("会话运行所有权"));
        assert!(!table_has_column(&connection, "work_sessions", "binding_version").unwrap());
        assert!(
            connection.is_autocommit(),
            "failed migration must release its savepoint"
        );
        connection
            .execute_batch("ALTER TABLE work_sessions DROP COLUMN runtime_owner;")
            .unwrap();
        migrate_session_host_ownership(&connection).unwrap();
        assert!(table_has_column(&connection, "work_sessions", "binding_version").unwrap());
        assert!(table_has_column(&connection, "work_sessions", "runtime_owner").unwrap());
    }

    #[test]
    fn native_host_owned_commands_reject_legacy_prepare_and_transition() {
        let connection = setup_db();
        let todo = create_sample_card(&connection, "原生命令不得被旧接口抢占", None);
        let specs = [
            r#"{"schema":"rocketx.native-codex-command.v1","executor":"native_host"}"#,
            r#"{"schema":"malicious-schema","executor":"native_host"}"#,
            r#"{"schema":"rocketx.native-codex-command.v99"}"#,
            r#"{"namespace":"rocketx.native"}"#,
            r#"{"namespace":"native_host"}"#,
            "{}",
        ];
        for (index, spec) in specs.iter().enumerate() {
            let key = if index == specs.len() - 1 {
                "native-codex:v1:reserved".into()
            } else {
                format!("host-owned-{index}")
            };
            let make = || PrepareDispatchActionInput {
                idempotency_key: key.clone(),
                todo_id: todo.id.clone(),
                event_id: None,
                session_id: None,
                action_kind: "session_prompt".into(),
                spec_json: spec.to_string(),
                baseline_marker: None,
                require_confirmation: Some(false),
            };
            assert!(prepare_dispatch_action(&connection, make())
                .unwrap_err()
                .contains("NativeHost"));
            assert!(get_dispatch_action_by_key(&connection, &key)
                .unwrap()
                .is_none());
            let id = format!("host-action-{index}");
            connection.execute("INSERT INTO dispatch_actions(id,idempotency_key,todo_id,action_kind,spec_json,state,created_at,updated_at) VALUES(?1,?2,?3,'session_prompt',?4,'prepared',1,1)", params![id,key,todo.id,spec]).unwrap();
            assert!(prepare_dispatch_action(&connection, make())
                .unwrap_err()
                .contains("NativeHost"));
            let mut disguised = make();
            disguised.spec_json = "{}".into();
            assert!(prepare_dispatch_action(&connection, disguised)
                .unwrap_err()
                .contains("NativeHost"));
            assert!(transition_dispatch_action(
                &connection,
                TransitionDispatchActionInput {
                    id: id.clone(),
                    state: "completed".into(),
                    receipt_ref: Some("forged-receipt".into()),
                    error_message: Some("forged-error".into()),
                    expected_state: Some("prepared".into()),
                }
            )
            .unwrap_err()
            .contains("NativeHost"));
            let preserved = get_dispatch_action_by_key(&connection, &key)
                .unwrap()
                .unwrap();
            assert_eq!(preserved.state, "prepared");
            assert_eq!(preserved.updated_at, 1);
            assert!(preserved.receipt_ref.is_none());
            assert!(preserved.error_message.is_none());
        }
        assert_eq!(
            get_work_card_state(&connection, &todo.id)
                .unwrap()
                .unwrap()
                .auto_turns_used,
            0
        );
        let benign = prepare_dispatch_action(
            &connection,
            PrepareDispatchActionInput {
                idempotency_key: "legacy-safe-text".into(),
                todo_id: todo.id,
                event_id: None,
                session_id: None,
                action_kind: "session_prompt".into(),
                spec_json:
                    r#"{"specText":"explain native_host and rocketx.native-codex-command.v1"}"#
                        .into(),
                baseline_marker: None,
                require_confirmation: Some(true),
            },
        )
        .unwrap();
        assert_eq!(benign.state, "awaiting_approval");
    }

    #[test]
    fn native_host_owned_sessions_reject_legacy_binding_and_state_overwrite() {
        let connection = setup_db();
        let todo = create_sample_card(&connection, "Host 会话绑定", None);
        let make = || UpsertWorkSessionInput {
            todo_id: Some(todo.id.clone()),
            runtime: "codex".into(),
            native_session_id: "owned-thread".into(),
            workspace_root: "D:/Repos/rocketchatx".into(),
            source_scope: Some("owned-source".into()),
            account_scope: Some("test-account".into()),
            host_device_id: Some("test-host".into()),
            control_mode: "resumable".into(),
            runtime_status: Some("idle".into()),
            ..UpsertWorkSessionInput::default()
        };
        let session = upsert_work_session(&connection, make()).unwrap();
        let legacy_prepare = || PrepareDispatchActionInput {
            idempotency_key: "legacy-before-host-takeover".into(),
            todo_id: todo.id.clone(),
            event_id: None,
            session_id: Some(session.id.clone()),
            action_kind: "session_prompt".into(),
            spec_json: "{}".into(),
            baseline_marker: None,
            require_confirmation: Some(true),
        };
        let legacy_action = prepare_dispatch_action(&connection, legacy_prepare()).unwrap();
        connection.execute("UPDATE work_sessions SET runtime_owner='native_host',binding_version=4,control_endpoint='native:owned',control_mode='controllable',runtime_status='running',last_turn_id='original-turn',updated_at=1 WHERE id=?1", params![session.id]).unwrap();
        let mut overwrite = make();
        overwrite.clear_todo_id = Some(true);
        overwrite.workspace_root = "C:/unrelated".into();
        overwrite.runtime_status = Some("waiting_approval".into());
        assert!(upsert_work_session(&connection, overwrite)
            .unwrap_err()
            .contains("NativeHost"));
        let preserved = connection.query_row("SELECT todo_id,workspace_root,control_endpoint,control_mode,runtime_status,last_turn_id,binding_version,runtime_owner,updated_at FROM work_sessions WHERE id=?1", params![session.id], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?,row.get::<_,String>(4)?,row.get::<_,String>(5)?,row.get::<_,i64>(6)?,row.get::<_,String>(7)?,row.get::<_,i64>(8)?))).unwrap();
        assert_eq!(
            preserved,
            (
                todo.id.clone(),
                "D:/Repos/rocketchatx".into(),
                "native:owned".into(),
                "controllable".into(),
                "running".into(),
                "original-turn".into(),
                4,
                "native_host".into(),
                1
            )
        );
        assert_eq!(
            get_work_card_state(&connection, &todo.id)
                .unwrap()
                .unwrap()
                .wait_state,
            "none"
        );
        assert!(prepare_dispatch_action(&connection, legacy_prepare())
            .unwrap_err()
            .contains("NativeHost"));
        assert!(prepare_dispatch_action(
            &connection,
            PrepareDispatchActionInput {
                idempotency_key: "legacy-owned-target".into(),
                todo_id: todo.id.clone(),
                event_id: None,
                session_id: Some(session.id),
                action_kind: "session_prompt".into(),
                spec_json: "{}".into(),
                baseline_marker: None,
                require_confirmation: Some(true),
            }
        )
        .unwrap_err()
        .contains("NativeHost"));
        let actions = read_work_ledger_snapshot(&connection).unwrap().actions;
        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0].id, legacy_action.id);
        assert_eq!(actions[0].state, "awaiting_approval");
    }

    #[test]
    fn native_host_session_takeover_blocks_legacy_execution_transitions_but_preserves_delivery_receipts(
    ) {
        let connection = setup_db();
        let todo = create_sample_card(&connection, "接管后停止旧派发", None);
        let session = upsert_work_session(
            &connection,
            UpsertWorkSessionInput {
                todo_id: Some(todo.id.clone()),
                runtime: "codex".into(),
                native_session_id: "transition-takeover-thread".into(),
                workspace_root: "D:/Repos/rocketchatx".into(),
                control_mode: "resumable".into(),
                ..UpsertWorkSessionInput::default()
            },
        )
        .unwrap();
        let prepare = |kind: &str| {
            prepare_dispatch_action(
                &connection,
                PrepareDispatchActionInput {
                    idempotency_key: format!("before-takeover-{kind}"),
                    todo_id: todo.id.clone(),
                    event_id: None,
                    session_id: Some(session.id.clone()),
                    action_kind: kind.into(),
                    spec_json: "{}".into(),
                    baseline_marker: None,
                    require_confirmation: Some(false),
                },
            )
            .unwrap()
        };
        let execution_actions: Vec<_> = ["session_create", "session_prompt", "session_steer"]
            .into_iter()
            .map(|kind| prepare(kind))
            .collect();
        let external_actions: Vec<_> = ["ado_comment", "ado_state_write", "rc_report"]
            .into_iter()
            .map(|kind| prepare(kind))
            .collect();
        connection.execute("UPDATE work_sessions SET runtime_owner='native_host',binding_version=1 WHERE id=?1", params![session.id]).unwrap();
        for action in execution_actions {
            assert_eq!(action.state, "prepared");
            for next_state in [
                "dispatched",
                "verifying_delivery",
                "acknowledged",
                "completed",
            ] {
                assert!(transition_dispatch_action(
                    &connection,
                    TransitionDispatchActionInput {
                        id: action.id.clone(),
                        state: next_state.into(),
                        receipt_ref: Some("must-not-record".into()),
                        error_message: None,
                        expected_state: Some("prepared".into()),
                    }
                )
                .unwrap_err()
                .contains("NativeHost"));
            }
            let unchanged = get_dispatch_action_by_key(&connection, &action.idempotency_key)
                .unwrap()
                .unwrap();
            assert_eq!(unchanged.state, "prepared");
            assert_eq!(unchanged.updated_at, action.updated_at);
            assert!(unchanged.receipt_ref.is_none());
        }
        for action in external_actions {
            let delivered = transition_dispatch_action(
                &connection,
                TransitionDispatchActionInput {
                    id: action.id,
                    state: "acknowledged".into(),
                    receipt_ref: Some("external-delivery-receipt".into()),
                    error_message: None,
                    expected_state: Some("prepared".into()),
                },
            )
            .unwrap();
            assert_eq!(delivered.state, "acknowledged");
            assert_eq!(
                delivered.receipt_ref.as_deref(),
                Some("external-delivery-receipt")
            );
        }
    }

    #[test]
    fn native_host_session_takeover_at_sql_write_boundary_blocks_legacy_upsert() {
        let connection = setup_db();
        let make = || UpsertWorkSessionInput {
            runtime: "codex".into(),
            native_session_id: "takeover-thread".into(),
            workspace_root: "D:/Repos/rocketchatx".into(),
            control_mode: "resumable".into(),
            runtime_status: Some("idle".into()),
            ..UpsertWorkSessionInput::default()
        };
        let session = upsert_work_session(&connection, make()).unwrap();
        // Claim after the function's initial ownership read, before ON CONFLICT can overwrite the row.
        connection.execute_batch("CREATE TRIGGER host_takes_over_before_legacy_write BEFORE INSERT ON work_sessions
            WHEN NEW.native_session_id='takeover-thread'
            BEGIN UPDATE work_sessions SET runtime_owner='native_host',binding_version=8 WHERE id=NEW.id; END;").unwrap();
        let mut stale = make();
        stale.workspace_root = "C:/stale-workspace".into();
        stale.control_mode = "readonly".into();
        assert!(upsert_work_session(&connection, stale)
            .unwrap_err()
            .contains("NativeHost"));
        let preserved = connection.query_row("SELECT workspace_root,control_mode,binding_version,runtime_owner FROM work_sessions WHERE id=?1", params![session.id], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,i64>(2)?,row.get::<_,String>(3)?))).unwrap();
        assert_eq!(
            preserved,
            (
                "D:/Repos/rocketchatx".into(),
                "resumable".into(),
                8,
                "native_host".into()
            )
        );
    }

    #[test]
    fn acceptance_migration_retains_history_and_reopens_unproven_managed_completion() {
        let connection = setup_db();
        let ordinary = create_sample_card(&connection, "普通已完成待办", None);
        let followed = create_sample_card(&connection, "旧跟进工作", None);
        connection
            .execute(
                "UPDATE todos SET done=1 WHERE id IN(?1,?2)",
                params![ordinary.id, followed.id],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE work_card_states SET stage='done' WHERE todo_id=?1",
                params![ordinary.id],
            )
            .unwrap();
        connection.execute("UPDATE work_card_states SET acceptance_json='[\"通过测试\"]',stage='done' WHERE todo_id=?1",params![followed.id]).unwrap();
        connection.execute("INSERT INTO work_evidences(id,todo_id,kind,title,passed,verified_at,created_at) VALUES('historic-report',?1,'manual_ack','旧归一汇报',1,1,1)",params![followed.id]).unwrap();
        connection
            .execute_batch(
                "ALTER TABLE work_card_states DROP COLUMN requirements_version;
            ALTER TABLE work_card_states DROP COLUMN content_version;
            ALTER TABLE work_card_states DROP COLUMN deadline_at;
            ALTER TABLE work_evidences DROP COLUMN criterion_ids_json;
            ALTER TABLE work_evidences DROP COLUMN requirements_version;
            ALTER TABLE work_evidences DROP COLUMN content_version;
            ALTER TABLE work_evidences DROP COLUMN accepted_by;
            ALTER TABLE work_evidences DROP COLUMN acceptance_scope_json;",
            )
            .unwrap();
        migrate_ledger(&connection).unwrap();
        migrate_ledger(&connection).unwrap();
        let snapshot = read_work_ledger_snapshot(&connection).unwrap();
        let ordinary = snapshot
            .cards
            .iter()
            .find(|c| c.todo.id == ordinary.id)
            .unwrap();
        assert!(ordinary.todo.done);
        let work = snapshot
            .cards
            .iter()
            .find(|c| c.todo.id == followed.id)
            .unwrap();
        assert!(!work.todo.done);
        assert_eq!(work.state.stage, "verifying");
        assert_eq!(work.state.requirements_version, 1);
        assert_eq!(snapshot.evidences[0].id, "historic-report");
        assert!(snapshot.evidences[0].stale);
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| r
                    .get::<_, i64>(
                    0
                ))
                .unwrap(),
            0
        );
    }

    #[test]
    fn work_creation_request_is_atomic_and_cas_only_allows_one_dispatch_owner() {
        let connection = setup_db();
        let make = || {
            serde_json::from_value::<CreateWorkCardInput>(serde_json::json!({"requestId":"message:123","source":"ado","adoWorkItemId":42,"adoProject":"RocketX","projectKey":"RocketX","title":"修复42","goal":"修复并验证42","acceptance":["通过单测"],"enroll":true})).unwrap()
        };
        let first = create_work_card(&connection, make()).unwrap();
        let second = create_work_card(&connection, make()).unwrap();
        assert_eq!(first.todo.id, second.todo.id);
        assert_eq!(first.todo.ado_work_item_id, Some(42));
        assert_eq!(first.state.project_key.as_deref(), Some("RocketX"));
        let failed: CreateWorkCardInput = serde_json::from_value(
            serde_json::json!({"requestId":"bad-request","title":"缺少验收","enroll":true}),
        )
        .unwrap();
        assert!(create_work_card(&connection, failed).is_err());
        assert_eq!(
            read_work_ledger_snapshot(&connection).unwrap().cards.len(),
            1
        );
        let action = prepare_dispatch_action(
            &connection,
            PrepareDispatchActionInput {
                idempotency_key: "claim".into(),
                todo_id: first.todo.id,
                event_id: None,
                session_id: None,
                action_kind: "session_create".into(),
                spec_json: "{}".into(),
                baseline_marker: None,
                require_confirmation: Some(true),
            },
        )
        .unwrap();
        let frozen: serde_json::Value = serde_json::from_str(&action.spec_json).unwrap();
        assert_eq!(frozen["requirementsVersion"], 1);
        let claim = || {
            serde_json::from_value::<TransitionDispatchActionInput>(serde_json::json!({"id":action.id,"state":"dispatched","expectedState":"awaiting_approval"})).unwrap()
        };
        assert_eq!(
            transition_dispatch_action(&connection, claim())
                .unwrap()
                .state,
            "dispatched"
        );
        assert!(transition_dispatch_action(&connection, claim()).is_err());
    }

    #[test]
    fn ledger_enforces_acceptance_evidence_and_invalidates_on_head_sha_or_scope_change() {
        let connection = setup_db();
        let todo = create_sample_card(&connection, "修复 DSH 桥接超时", Some(400));

        // 1. 设置验收条件并推进到 verifying
        let card = update_work_card(
            &connection,
            &todo.id,
            WorkCardPatch {
                stage: Some("verifying".to_string()),
                owner_kind: Some("ai_dispatched".to_string()),
                goal: Some(Some("修复桥接并完成验证".to_string())),
                acceptance: Some(vec!["单测通过".to_string(), "CI 构建成功".to_string()]),
                ..WorkCardPatch::default()
            },
        )
        .expect("set acceptance criteria");
        assert_eq!(card.state.stage, "verifying");

        // 2. 无有效证据时直接标为 done 应被拦截
        let err = update_work_card(
            &connection,
            &todo.id,
            WorkCardPatch {
                stage: Some("done".to_string()),
                ..WorkCardPatch::default()
            },
        )
        .unwrap_err();
        assert!(err.contains("有效（未过期）验收证据"));

        // 3. 关联 PR (head_sha = sha-1) 并添加通过的证据后，允许进入 done
        upsert_work_link(
            &connection,
            UpsertWorkLinkInput {
                todo_id: todo.id.clone(),
                kind: "ado_pr".to_string(),
                external_id: "88".to_string(),
                project: Some("RocketX".to_string()),
                repo: Some("rocketchatx".to_string()),
                rid: None,
                head_sha: Some("sha-1".to_string()),
                title: Some("PR #88".to_string()),
                web_url: None,
                state_snapshot: Some("active".to_string()),
            },
        )
        .expect("link PR #88 at sha-1");

        add_work_evidence(
            &connection,
            NewWorkEvidenceInput {
                todo_id: todo.id.clone(),
                session_id: None,
                kind: "ci_build".to_string(),
                title: "Build #1001 green".to_string(),
                summary: Some("All 42 tests passed".to_string()),
                head_sha: Some("sha-1".to_string()),
                workspace_root: Some("D:/Repos/rocketchatx".to_string()),
                web_url: None,
                passed: true,
                criterion_ids: vec!["单测通过".to_string(), "CI 构建成功".to_string()],
                requirements_version: Some(card.state.requirements_version),
                content_version: Some(card.state.content_version),
            },
        )
        .expect("add passing evidence for sha-1");

        let done_card = update_work_card(
            &connection,
            &todo.id,
            WorkCardPatch {
                stage: Some("done".to_string()),
                ..WorkCardPatch::default()
            },
        )
        .expect("transition to done with valid evidence");
        assert!(done_card.todo.done);
        assert_eq!(done_card.state.stage, "done");

        // 4. 当 PR HEAD 推进到 sha-2 时，sha-1 的证据自动标为 stale，卡片自动回退到 verifying
        upsert_work_link(
            &connection,
            UpsertWorkLinkInput {
                todo_id: todo.id.clone(),
                kind: "ado_pr".to_string(),
                external_id: "88".to_string(),
                project: Some("RocketX".to_string()),
                repo: Some("rocketchatx".to_string()),
                rid: None,
                head_sha: Some("sha-2".to_string()),
                title: Some("PR #88".to_string()),
                web_url: None,
                state_snapshot: Some("active".to_string()),
            },
        )
        .expect("update PR #88 to sha-2");

        let snapshot = read_work_ledger_snapshot(&connection).expect("read snapshot");
        assert!(snapshot.evidences[0].stale);
        assert_eq!(
            snapshot.evidences[0].stale_reason.as_deref(),
            Some("head_sha_changed")
        );
        assert_eq!(snapshot.cards[0].state.stage, "verifying");
    }

    #[test]
    fn event_inbox_dedupes_suppresses_out_of_order_and_respects_pause_revocation() {
        let connection = setup_db();
        let todo = create_sample_card(&connection, "处理 ADO 构建反馈", Some(292));

        upsert_work_link(
            &connection,
            UpsertWorkLinkInput {
                todo_id: todo.id.clone(),
                kind: "git_branch".to_string(),
                external_id: "ai/292-fix-build".to_string(),
                project: Some("RocketX".to_string()),
                repo: Some("rocketchatx".to_string()),
                rid: None,
                head_sha: Some("abc111".to_string()),
                title: None,
                web_url: None,
                state_snapshot: None,
            },
        )
        .expect("link branch");

        // 1. 正常接收 version = 200 的事件并精确关联到卡片
        let first = ingest_external_event(
            &connection,
            IngestExternalEventInput {
                dedupe_key: "ado:build:200".to_string(),
                source: "ado_webhook".to_string(),
                event_type: "build.complete".to_string(),
                resource_key: "pipeline:RocketX/ci:ai/292-fix-build".to_string(),
                resource_version: 200,
                project: Some("RocketX".to_string()),
                repo: Some("rocketchatx".to_string()),
                branch: Some("refs/heads/ai/292-fix-build".to_string()),
                commit_sha: Some("abc111".to_string()),
                work_item_id: None,
                pr_id: None,
                build_id: Some(200),
                rid: None,
                payload_json: Some(r#"{"result":"failed"}"#.to_string()),
                occurred_at: Some(1_000),
            },
        )
        .expect("ingest first event");
        assert!(!first.duplicate);
        assert_eq!(first.event.status, "correlated");
        assert_eq!(first.event.correlation_tier, "exact");
        assert_eq!(first.event.todo_id.as_deref(), Some(todo.id.as_str()));

        // 2. 重复投递相同 dedupe_key 不会产生第二条事件
        let dup = ingest_external_event(
            &connection,
            IngestExternalEventInput {
                dedupe_key: "ado:build:200".to_string(),
                source: "ado_webhook".to_string(),
                event_type: "build.complete".to_string(),
                resource_key: "pipeline:RocketX/ci:ai/292-fix-build".to_string(),
                resource_version: 200,
                project: None,
                repo: None,
                branch: None,
                commit_sha: None,
                work_item_id: None,
                pr_id: None,
                build_id: Some(200),
                rid: None,
                payload_json: None,
                occurred_at: Some(1_000),
            },
        )
        .expect("ingest duplicate event");
        assert!(dup.duplicate);
        assert_eq!(dup.event.id, first.event.id);

        // 3. 乱序到达的旧事件 (version = 150 < 200) 自动标为 superseded
        let older = ingest_external_event(
            &connection,
            IngestExternalEventInput {
                dedupe_key: "ado:build:150".to_string(),
                source: "ado_webhook".to_string(),
                event_type: "build.complete".to_string(),
                resource_key: "pipeline:RocketX/ci:ai/292-fix-build".to_string(),
                resource_version: 150,
                project: Some("RocketX".to_string()),
                repo: Some("rocketchatx".to_string()),
                branch: Some("refs/heads/ai/292-fix-build".to_string()),
                commit_sha: None,
                work_item_id: None,
                pr_id: None,
                build_id: Some(150),
                rid: None,
                payload_json: None,
                occurred_at: Some(900),
            },
        )
        .expect("ingest out-of-order event");
        assert_eq!(older.event.status, "superseded");

        // 4. 用户暂停卡片后，即使到达新事件也只标为 verified_stale，不进入可派发状态
        update_work_card(
            &connection,
            &todo.id,
            WorkCardPatch {
                wait_state: Some("paused".to_string()),
                revoked_at: Some(Some(2_000)),
                ..WorkCardPatch::default()
            },
        )
        .expect("pause card");

        let after_pause = ingest_external_event(
            &connection,
            IngestExternalEventInput {
                dedupe_key: "ado:build:201".to_string(),
                source: "ado_webhook".to_string(),
                event_type: "build.complete".to_string(),
                resource_key: "pipeline:RocketX/ci:ai/292-fix-build".to_string(),
                resource_version: 201,
                project: Some("RocketX".to_string()),
                repo: Some("rocketchatx".to_string()),
                branch: Some("refs/heads/ai/292-fix-build".to_string()),
                commit_sha: None,
                work_item_id: None,
                pr_id: None,
                build_id: Some(201),
                rid: None,
                payload_json: None,
                occurred_at: Some(1_500),
            },
        )
        .expect("ingest event after pause");
        assert_eq!(after_pause.event.status, "verified_stale");
    }

    #[test]
    fn session_and_dispatch_action_guards_prevent_readonly_or_private_leak_and_enforce_budget() {
        let connection = setup_db();
        let private_todo = create_sample_card(&connection, "个人私密复盘任务", None);

        // 外部 writer 占用的会话强制降级为 readonly
        let external_session = upsert_work_session(
            &connection,
            UpsertWorkSessionInput {
                todo_id: Some(private_todo.id.clone()),
                visibility: Some("private".to_string()),
                runtime: "codex".to_string(),
                origin: Some("external_discovered".to_string()),
                native_session_id: "thread-ext-1".to_string(),
                title: Some("终端运行中的 Codex".to_string()),
                workspace_root: "D:/Repos/rocketchatx".to_string(),
                environment_id: None,
                account_scope: None,
                control_endpoint: None,
                control_mode: "controllable".to_string(),
                control_reason: Some("active_external_writer".to_string()),
                host_device_id: None,
                writer_lease_owner: Some("external-cli".to_string()),
                writer_lease_expires_at: None,
                runtime_status: Some("running".to_string()),
                config_snapshot_json: None,
                last_event_seq: Some(12),
                last_turn_id: None,
                ..UpsertWorkSessionInput::default()
            },
        )
        .expect("upsert external session");
        assert_eq!(external_session.control_mode, "readonly");

        // 向只读会话派发指令必须被拒绝
        let readonly_err = prepare_dispatch_action(
            &connection,
            PrepareDispatchActionInput {
                idempotency_key: "act-readonly-1".to_string(),
                todo_id: private_todo.id.clone(),
                event_id: None,
                session_id: Some(external_session.id.clone()),
                action_kind: "session_prompt".to_string(),
                spec_json: "{}".to_string(),
                baseline_marker: Some("12".to_string()),
                require_confirmation: Some(true),
            },
        )
        .unwrap_err();
        assert!(readonly_err.contains("只读状态"));

        // 团队共享会话不能接收 private 卡片的派发
        let shared_session = upsert_work_session(
            &connection,
            UpsertWorkSessionInput {
                todo_id: None,
                visibility: Some("room_shared".to_string()),
                runtime: "deepseek".to_string(),
                origin: Some("shared_room".to_string()),
                native_session_id: "dsh-room-1".to_string(),
                title: Some("群聊共享 DSH".to_string()),
                workspace_root: "D:/Repos/rocketchatx".to_string(),
                environment_id: None,
                account_scope: None,
                control_endpoint: Some("butler".to_string()),
                control_mode: "controllable".to_string(),
                control_reason: Some("owned_live_controller".to_string()),
                host_device_id: None,
                writer_lease_owner: None,
                writer_lease_expires_at: None,
                runtime_status: Some("idle".to_string()),
                config_snapshot_json: None,
                last_event_seq: Some(5),
                last_turn_id: None,
                ..UpsertWorkSessionInput::default()
            },
        )
        .expect("upsert shared session");

        let privacy_err = prepare_dispatch_action(
            &connection,
            PrepareDispatchActionInput {
                idempotency_key: "act-privacy-1".to_string(),
                todo_id: private_todo.id.clone(),
                event_id: None,
                session_id: Some(shared_session.id),
                action_kind: "session_prompt".to_string(),
                spec_json: "{}".to_string(),
                baseline_marker: Some("5".to_string()),
                require_confirmation: Some(true),
            },
        )
        .unwrap_err();
        assert!(privacy_err.contains("隐私安全拦截"));

        // 受控自主模式下验证幂等与预算上限 (max_auto_turns = 1)
        let owned_private_session = upsert_work_session(
            &connection,
            UpsertWorkSessionInput {
                todo_id: Some(private_todo.id.clone()),
                visibility: Some("private".to_string()),
                runtime: "deepseek".to_string(),
                origin: Some("butler".to_string()),
                native_session_id: "dsh-private-1".to_string(),
                title: Some("个人受管 DSH".to_string()),
                workspace_root: "D:/Repos/rocketchatx".to_string(),
                environment_id: None,
                account_scope: None,
                control_endpoint: Some("butler".to_string()),
                control_mode: "controllable".to_string(),
                control_reason: Some("owned_live_controller".to_string()),
                host_device_id: None,
                writer_lease_owner: None,
                writer_lease_expires_at: None,
                runtime_status: Some("idle".to_string()),
                config_snapshot_json: None,
                last_event_seq: Some(10),
                last_turn_id: None,
                ..UpsertWorkSessionInput::default()
            },
        )
        .expect("upsert owned private session");

        update_work_card(
            &connection,
            &private_todo.id,
            WorkCardPatch {
                autonomy_mode: Some("autonomous".to_string()),
                max_auto_turns: Some(1),
                ..WorkCardPatch::default()
            },
        )
        .expect("enable autonomous with budget 1");

        let prepared = prepare_dispatch_action(
            &connection,
            PrepareDispatchActionInput {
                idempotency_key: "act-auto-1".to_string(),
                todo_id: private_todo.id.clone(),
                event_id: None,
                session_id: Some(owned_private_session.id.clone()),
                action_kind: "session_prompt".to_string(),
                spec_json: r#"{"title":"自动修复"}"#.to_string(),
                baseline_marker: Some("10".to_string()),
                require_confirmation: Some(false),
            },
        )
        .expect("prepare first auto turn");
        assert_eq!(prepared.state, "prepared");

        // 相同 idempotency_key 幂等返回同一条记录
        let idempotent = prepare_dispatch_action(
            &connection,
            PrepareDispatchActionInput {
                idempotency_key: "act-auto-1".to_string(),
                todo_id: private_todo.id.clone(),
                event_id: None,
                session_id: Some(owned_private_session.id.clone()),
                action_kind: "session_prompt".to_string(),
                spec_json: r#"{"title":"自动修复"}"#.to_string(),
                baseline_marker: Some("10".to_string()),
                require_confirmation: Some(false),
            },
        )
        .expect("idempotent prepare");
        assert_eq!(idempotent.id, prepared.id);

        // 超过 max_auto_turns = 1 的第二个新自动动作应被拦截
        let budget_err = prepare_dispatch_action(
            &connection,
            PrepareDispatchActionInput {
                idempotency_key: "act-auto-2".to_string(),
                todo_id: private_todo.id.clone(),
                event_id: None,
                session_id: Some(owned_private_session.id),
                action_kind: "session_prompt".to_string(),
                spec_json: r#"{"title":"第二次自动修复"}"#.to_string(),
                baseline_marker: Some("11".to_string()),
                require_confirmation: Some(false),
            },
        )
        .unwrap_err();
        assert!(budget_err.contains("预算上限"));
    }

    #[test]
    fn acp_runtime_session_upsert_and_legacy_migration_preserve_rows() {
        let mut connection = Connection::open_in_memory().expect("open in-memory db");
        super::super::migrate(&mut connection).expect("initial migrate");

        // Simulate legacy table with only codex/deepseek/pi runtime constraint.
        connection
            .execute_batch(
                "PRAGMA foreign_keys = OFF;
                 DROP TABLE work_sessions;
                 CREATE TABLE work_sessions (
                     id TEXT PRIMARY KEY,
                     todo_id TEXT REFERENCES todos(id) ON DELETE SET NULL,
                     visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'room_shared')),
                     runtime TEXT NOT NULL CHECK (runtime IN ('codex', 'deepseek', 'pi')),
                     origin TEXT NOT NULL DEFAULT 'butler' CHECK (origin IN ('butler', 'shared_room', 'scheduled', 'external_discovered')),
                     native_session_id TEXT NOT NULL,
                     title TEXT,
                     workspace_root TEXT NOT NULL,
                     environment_id TEXT,
                     account_scope TEXT,
                     control_endpoint TEXT,
                     control_mode TEXT NOT NULL CHECK (control_mode IN ('readonly', 'resumable', 'controllable')),
                     control_reason TEXT,
                     host_device_id TEXT,
                     writer_lease_owner TEXT,
                     writer_lease_expires_at INTEGER,
                     runtime_status TEXT NOT NULL DEFAULT 'unknown' CHECK (runtime_status IN ('running', 'waiting_approval', 'waiting_input', 'idle', 'interrupted', 'ended', 'unknown')),
                     config_snapshot_json TEXT,
                     last_event_seq INTEGER,
                     last_turn_id TEXT,
                     last_verified_at INTEGER NOT NULL,
                     created_at INTEGER NOT NULL,
                     updated_at INTEGER NOT NULL,
                     UNIQUE(runtime, native_session_id)
                 );
                 PRAGMA foreign_keys = ON;",
            )
            .expect("create legacy work_sessions table");

        connection.execute("INSERT INTO work_sessions(id,runtime,native_session_id,workspace_root,control_mode,last_verified_at,created_at,updated_at) VALUES('pi:pi-legacy-1','pi','pi-legacy-1','D:/Repos/rocketchatx','controllable',1,1,1)",[]).expect("insert legacy pi row");

        let linked_todo = create_sample_card(&connection, "迁移保留证据与派发引用", None);
        connection
            .execute(
                "UPDATE work_sessions SET todo_id=?1 WHERE id='pi:pi-legacy-1'",
                params![linked_todo.id],
            )
            .unwrap();
        add_work_evidence(
            &connection,
            NewWorkEvidenceInput {
                todo_id: linked_todo.id.clone(),
                session_id: Some("pi:pi-legacy-1".into()),
                kind: "test_run".into(),
                title: "原会话验证".into(),
                passed: true,
                requirements_version: Some(0),
                content_version: Some(0),
                ..NewWorkEvidenceInput::default()
            },
        )
        .unwrap();
        migrate_session_host_ownership(&connection)
            .expect("prepare ownership columns for dispatch fixture");
        prepare_dispatch_action(
            &connection,
            PrepareDispatchActionInput {
                idempotency_key: "legacy-action".into(),
                todo_id: linked_todo.id,
                session_id: Some("pi:pi-legacy-1".into()),
                event_id: None,
                action_kind: "session_prompt".into(),
                spec_json: "{}".into(),
                baseline_marker: None,
                require_confirmation: Some(true),
            },
        )
        .unwrap();

        migrate_ledger(&connection).expect("upgrade legacy table to support acp");

        let acp_session = upsert_work_session(
            &connection,
            UpsertWorkSessionInput {
                todo_id: None,
                visibility: Some("private".to_string()),
                runtime: "acp".to_string(),
                origin: Some("butler".to_string()),
                native_session_id: "acp-sess-1".to_string(),
                title: Some("Claude Code ACP".to_string()),
                workspace_root: "D:/Repos/rocketchatx".to_string(),
                environment_id: None,
                account_scope: Some("server-a:alice".to_string()),
                control_endpoint: Some("acp-proc-1".to_string()),
                control_mode: "controllable".to_string(),
                control_reason: Some("owned_live_controller".to_string()),
                host_device_id: None,
                writer_lease_owner: None,
                writer_lease_expires_at: None,
                runtime_status: Some("running".to_string()),
                config_snapshot_json: None,
                last_event_seq: None,
                last_turn_id: None,
                ..UpsertWorkSessionInput::default()
            },
        )
        .expect("upsert acp session");
        assert_eq!(acp_session.id, "acp:acp-sess-1");
        assert_eq!(acp_session.runtime, "acp");

        let snapshot = read_work_ledger_snapshot(&connection).expect("read snapshot");
        assert!(snapshot
            .sessions
            .iter()
            .any(|s| s.id == "pi:pi-legacy-1" && s.source_scope == "default"));
        assert!(snapshot.sessions.iter().any(|s| s.id == acp_session.id));
        assert_eq!(
            snapshot.evidences[0].session_id.as_deref(),
            Some("pi:pi-legacy-1")
        );
        assert_eq!(
            snapshot.actions[0].session_id.as_deref(),
            Some("pi:pi-legacy-1")
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| r
                    .get::<_, i64>(
                    0
                ))
                .unwrap(),
            0
        );
    }

    #[test]
    fn frontend_session_aliases_clear_todo_and_timestamps_persist() {
        let connection = setup_db();
        let card = create_sample_card(&connection, "本地原生会话关联测试", None);

        let managed = upsert_work_session(
            &connection,
            UpsertWorkSessionInput {
                todo_id: Some(card.id.clone()),
                visibility: Some("private".to_string()),
                runtime: "acp".to_string(),
                origin: Some("rocketx_managed".to_string()),
                native_session_id: "alias-acp-1".to_string(),
                title: Some("Antigravity 会话".to_string()),
                workspace_root: "D:/Repos/rocketchatx".to_string(),
                control_mode: "resumable".to_string(),
                runtime_status: Some("stopped".to_string()),
                created_at: Some(1_700_000_000_000),
                updated_at: Some(1_700_000_123_000),
                ..UpsertWorkSessionInput::default()
            },
        )
        .expect("upsert rocketx_managed/stopped aliases");
        assert_eq!(managed.origin, "butler");
        assert_eq!(managed.runtime_status, "ended");
        assert_eq!(managed.created_at, 1_700_000_000_000);
        assert_eq!(managed.updated_at, 1_700_000_123_000);
        assert_eq!(managed.todo_id.as_deref(), Some(card.id.as_str()));

        // Omitting todo_id preserves existing binding; passing clear_todo_id removes it.
        let preserved = upsert_work_session(
            &connection,
            UpsertWorkSessionInput {
                todo_id: None,
                visibility: Some("private".to_string()),
                runtime: "acp".to_string(),
                origin: Some("native_desktop".to_string()),
                native_session_id: "alias-acp-1".to_string(),
                title: Some("Antigravity 会话".to_string()),
                workspace_root: "D:/Repos/rocketchatx".to_string(),
                control_mode: "resumable".to_string(),
                runtime_status: Some("error".to_string()),
                ..UpsertWorkSessionInput::default()
            },
        )
        .expect("preserve todo_id on update");
        assert_eq!(preserved.origin, "external_discovered");
        assert_eq!(preserved.runtime_status, "interrupted");
        assert_eq!(preserved.todo_id.as_deref(), Some(card.id.as_str()));

        let cleared = upsert_work_session(
            &connection,
            UpsertWorkSessionInput {
                todo_id: None,
                clear_todo_id: Some(true),
                visibility: Some("private".to_string()),
                runtime: "acp".to_string(),
                origin: Some("native_cli".to_string()),
                native_session_id: "alias-acp-1".to_string(),
                title: None,
                workspace_root: "D:/Repos/rocketchatx".to_string(),
                control_mode: "resumable".to_string(),
                runtime_status: Some("idle".to_string()),
                ..UpsertWorkSessionInput::default()
            },
        )
        .expect("clear todo_id");
        assert_eq!(cleared.todo_id, None);
        assert_eq!(cleared.origin, "external_discovered");

        let ev = add_work_evidence(
            &connection,
            NewWorkEvidenceInput {
                todo_id: card.id.clone(),
                session_id: None,
                kind: "manual_note".to_string(),
                title: "人工确认".to_string(),
                summary: None,
                head_sha: None,
                workspace_root: None,
                web_url: None,
                passed: true,
                ..NewWorkEvidenceInput::default()
            },
        )
        .expect("manual_note alias");
        assert_eq!(ev.kind, "manual_note");
    }
}
