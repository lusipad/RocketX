use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::{params, params_from_iter, types::Value, Connection, OptionalExtension};
use serde::{Deserialize, Deserializer, Serialize};

const SCHEMA_VERSION: i64 = 1;
const TODO_COLUMNS: &str = "id, source, rid, mid, ado_work_item_id, ado_project, title, note, room_name, author, done, priority, due, created_at, done_at, updated_at, committed_to, waiting_for";
const SCHEMA_V1: &str = "
    CREATE TABLE IF NOT EXISTS todos (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'message', 'ado')),
        rid TEXT,
        mid TEXT,
        ado_work_item_id INTEGER,
        ado_project TEXT,
        title TEXT NOT NULL,
        note TEXT,
        room_name TEXT,
        author TEXT,
        done INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
        priority INTEGER NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 4),
        due TEXT CHECK (
            due IS NULL OR due GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
        ),
        created_at INTEGER NOT NULL,
        done_at INTEGER,
        updated_at INTEGER NOT NULL,
        committed_to TEXT,
        waiting_for TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_todos_done ON todos(done);
    CREATE INDEX IF NOT EXISTS idx_todos_due ON todos(due) WHERE due IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_todos_source ON todos(source);
    CREATE INDEX IF NOT EXISTS idx_todos_ado_work_item_id
        ON todos(ado_work_item_id) WHERE ado_work_item_id IS NOT NULL;
";

pub struct ButlerDb(Arc<Mutex<Connection>>);

impl ButlerDb {
    fn connection(&self) -> Arc<Mutex<Connection>> {
        Arc::clone(&self.0)
    }
}

pub fn init_db(app_data_dir: PathBuf) -> Result<ButlerDb, String> {
    std::fs::create_dir_all(&app_data_dir)
        .map_err(|error| format!("无法创建应用数据目录：{error}"))?;
    let mut connection = Connection::open(app_data_dir.join("butler.db"))
        .map_err(|error| format!("无法打开管家数据库：{error}"))?;
    connection
        .execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")
        .map_err(|error| format!("无法配置管家数据库：{error}"))?;
    migrate(&mut connection)?;
    Ok(ButlerDb(Arc::new(Mutex::new(connection))))
}

fn migrate(connection: &mut Connection) -> Result<(), String> {
    let version = connection
        .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
        .map_err(|error| format!("无法读取管家数据库版本：{error}"))?;
    if version > SCHEMA_VERSION {
        return Err(format!(
            "管家数据库版本 {version} 高于当前支持版本 {SCHEMA_VERSION}"
        ));
    }
    if version == 0 {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("无法开始管家数据库迁移：{error}"))?;
        transaction
            .execute_batch(SCHEMA_V1)
            .map_err(|error| format!("无法创建管家待办表：{error}"))?;
        transaction
            .pragma_update(None, "user_version", SCHEMA_VERSION)
            .map_err(|error| format!("无法更新管家数据库版本：{error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("无法提交管家数据库迁移：{error}"))?;
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Todo {
    pub id: String,
    pub source: String,
    pub rid: Option<String>,
    pub mid: Option<String>,
    pub ado_work_item_id: Option<i64>,
    pub ado_project: Option<String>,
    pub title: String,
    pub note: Option<String>,
    pub room_name: Option<String>,
    pub author: Option<String>,
    pub done: bool,
    pub priority: i32,
    pub due: Option<String>,
    pub created_at: i64,
    pub done_at: Option<i64>,
    pub updated_at: i64,
    pub committed_to: Option<String>,
    pub waiting_for: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewTodo {
    pub source: Option<String>,
    pub rid: Option<String>,
    pub mid: Option<String>,
    pub ado_work_item_id: Option<i64>,
    pub ado_project: Option<String>,
    pub title: String,
    pub note: Option<String>,
    pub room_name: Option<String>,
    pub author: Option<String>,
    pub done: Option<bool>,
    pub priority: Option<i32>,
    pub due: Option<String>,
    pub done_at: Option<i64>,
    pub committed_to: Option<String>,
    pub waiting_for: Option<String>,
}

fn deserialize_optional_nullable<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoPatch {
    pub source: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_nullable")]
    pub rid: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_optional_nullable")]
    pub mid: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_optional_nullable")]
    pub ado_work_item_id: Option<Option<i64>>,
    #[serde(default, deserialize_with = "deserialize_optional_nullable")]
    pub ado_project: Option<Option<String>>,
    pub title: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_nullable")]
    pub note: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_optional_nullable")]
    pub room_name: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_optional_nullable")]
    pub author: Option<Option<String>>,
    pub done: Option<bool>,
    pub priority: Option<i32>,
    #[serde(default, deserialize_with = "deserialize_optional_nullable")]
    pub due: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_optional_nullable")]
    pub done_at: Option<Option<i64>>,
    #[serde(default, deserialize_with = "deserialize_optional_nullable")]
    pub committed_to: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_optional_nullable")]
    pub waiting_for: Option<Option<String>>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoFilter {
    pub done: Option<bool>,
    pub source: Option<String>,
    pub due_before: Option<String>,
    pub due_after: Option<String>,
    pub has_commitment: Option<bool>,
    pub limit: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyTodo {
    id: String,
    rid: Option<String>,
    mid: Option<String>,
    room_name: Option<String>,
    excerpt: Option<String>,
    author: Option<String>,
    note: Option<String>,
    due: Option<String>,
    done: bool,
    created_at: i64,
    done_at: Option<i64>,
}

async fn run_db<T, F>(connection: Arc<Mutex<Connection>>, operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&mut Connection) -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let mut connection = connection
            .lock()
            .map_err(|_| "管家数据库锁不可用".to_string())?;
        operation(&mut connection)
    })
    .await
    .map_err(|error| format!("管家数据库任务失败：{error}"))?
}

#[tauri::command]
pub async fn butler_todo_add(
    db: tauri::State<'_, ButlerDb>,
    todo: NewTodo,
) -> Result<Todo, String> {
    run_db(db.connection(), move |connection| {
        add_todo(connection, todo)
    })
    .await
}

#[tauri::command]
pub async fn butler_todo_update(
    db: tauri::State<'_, ButlerDb>,
    id: String,
    patch: TodoPatch,
) -> Result<Todo, String> {
    run_db(db.connection(), move |connection| {
        update_todo(connection, &id, patch)
    })
    .await
}

#[tauri::command]
pub async fn butler_todo_delete(db: tauri::State<'_, ButlerDb>, id: String) -> Result<(), String> {
    run_db(db.connection(), move |connection| {
        connection
            .execute("DELETE FROM todos WHERE id = ?1", params![id])
            .map_err(|error| format!("无法删除待办：{error}"))?;
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn butler_todo_get(
    db: tauri::State<'_, ButlerDb>,
    id: String,
) -> Result<Option<Todo>, String> {
    run_db(db.connection(), move |connection| get_todo(connection, &id)).await
}

#[tauri::command]
pub async fn butler_todo_list(
    db: tauri::State<'_, ButlerDb>,
    filter: TodoFilter,
) -> Result<Vec<Todo>, String> {
    run_db(db.connection(), move |connection| {
        list_todos(connection, filter)
    })
    .await
}

#[tauri::command]
pub async fn butler_todo_overdue(
    db: tauri::State<'_, ButlerDb>,
    today: String,
) -> Result<Vec<Todo>, String> {
    run_db(db.connection(), move |connection| {
        validate_date(&today)?;
        let mut statement = connection
            .prepare(&format!(
                "SELECT {TODO_COLUMNS} FROM todos \
                 WHERE done = 0 AND due IS NOT NULL AND due < ?1 \
                 ORDER BY due ASC, created_at DESC"
            ))
            .map_err(|error| format!("无法准备逾期待办查询：{error}"))?;
        let todos = collect_todos(
            statement
                .query_map(params![today], row_to_todo)
                .map_err(|error| format!("无法查询逾期待办：{error}"))?,
        );
        todos
    })
    .await
}

#[tauri::command]
pub async fn butler_todo_migrate_from_json(
    db: tauri::State<'_, ButlerDb>,
    json: String,
) -> Result<u32, String> {
    run_db(db.connection(), move |connection| {
        migrate_from_json(connection, &json)
    })
    .await
}

fn add_todo(connection: &Connection, todo: NewTodo) -> Result<Todo, String> {
    let now = now_millis();
    let source = todo.source.unwrap_or_else(|| "manual".to_string());
    let done = todo.done.unwrap_or(false);
    let priority = todo.priority.unwrap_or(3);
    let done_at = if done {
        Some(todo.done_at.unwrap_or(now))
    } else {
        todo.done_at
    };
    validate_source(&source)?;
    validate_title(&todo.title)?;
    validate_priority(priority)?;
    validate_optional_date(todo.due.as_deref())?;

    let result = Todo {
        id: uuid::Uuid::new_v4().to_string(),
        source,
        rid: todo.rid,
        mid: todo.mid,
        ado_work_item_id: todo.ado_work_item_id,
        ado_project: todo.ado_project,
        title: todo.title,
        note: todo.note,
        room_name: todo.room_name,
        author: todo.author,
        done,
        priority,
        due: todo.due,
        created_at: now,
        done_at,
        updated_at: now,
        committed_to: todo.committed_to,
        waiting_for: todo.waiting_for,
    };
    insert_todo(connection, &result, "无法新增待办")?;
    Ok(result)
}

fn update_todo(connection: &Connection, id: &str, patch: TodoPatch) -> Result<Todo, String> {
    let mut todo = get_todo(connection, id)?.ok_or_else(|| "待办不存在".to_string())?;
    let done_at_was_supplied = patch.done_at.is_some();

    if let Some(value) = patch.source {
        todo.source = value;
    }
    if let Some(value) = patch.rid {
        todo.rid = value;
    }
    if let Some(value) = patch.mid {
        todo.mid = value;
    }
    if let Some(value) = patch.ado_work_item_id {
        todo.ado_work_item_id = value;
    }
    if let Some(value) = patch.ado_project {
        todo.ado_project = value;
    }
    if let Some(value) = patch.title {
        todo.title = value;
    }
    if let Some(value) = patch.note {
        todo.note = value;
    }
    if let Some(value) = patch.room_name {
        todo.room_name = value;
    }
    if let Some(value) = patch.author {
        todo.author = value;
    }
    if let Some(value) = patch.priority {
        todo.priority = value;
    }
    if let Some(value) = patch.due {
        todo.due = value;
    }
    if let Some(value) = patch.committed_to {
        todo.committed_to = value;
    }
    if let Some(value) = patch.waiting_for {
        todo.waiting_for = value;
    }
    if let Some(done) = patch.done {
        todo.done = done;
        if !done_at_was_supplied {
            todo.done_at = done.then(now_millis);
        }
    }
    if let Some(done_at) = patch.done_at {
        todo.done_at = done_at;
    }
    todo.updated_at = now_millis();

    validate_source(&todo.source)?;
    validate_title(&todo.title)?;
    validate_priority(todo.priority)?;
    validate_optional_date(todo.due.as_deref())?;

    connection
        .execute(
            "UPDATE todos SET
                source = ?2, rid = ?3, mid = ?4, ado_work_item_id = ?5,
                ado_project = ?6, title = ?7, note = ?8, room_name = ?9,
                author = ?10, done = ?11, priority = ?12, due = ?13,
                done_at = ?14, updated_at = ?15, committed_to = ?16,
                waiting_for = ?17
             WHERE id = ?1",
            params![
                todo.id,
                todo.source,
                todo.rid,
                todo.mid,
                todo.ado_work_item_id,
                todo.ado_project,
                todo.title,
                todo.note,
                todo.room_name,
                todo.author,
                i64::from(todo.done),
                todo.priority,
                todo.due,
                todo.done_at,
                todo.updated_at,
                todo.committed_to,
                todo.waiting_for,
            ],
        )
        .map_err(|error| format!("无法更新待办：{error}"))?;
    Ok(todo)
}

fn get_todo(connection: &Connection, id: &str) -> Result<Option<Todo>, String> {
    connection
        .query_row(
            &format!("SELECT {TODO_COLUMNS} FROM todos WHERE id = ?1"),
            params![id],
            row_to_todo,
        )
        .optional()
        .map_err(|error| format!("无法读取待办：{error}"))
}

fn list_todos(connection: &Connection, filter: TodoFilter) -> Result<Vec<Todo>, String> {
    if let Some(source) = filter.source.as_deref() {
        validate_source(source)?;
    }
    validate_optional_date(filter.due_before.as_deref())?;
    validate_optional_date(filter.due_after.as_deref())?;

    let mut conditions = Vec::new();
    let mut values = Vec::new();
    if let Some(done) = filter.done {
        conditions.push("done = ?".to_string());
        values.push(Value::Integer(i64::from(done)));
    }
    if let Some(source) = filter.source {
        conditions.push("source = ?".to_string());
        values.push(Value::Text(source));
    }
    if let Some(due_before) = filter.due_before {
        conditions.push("due IS NOT NULL AND due <= ?".to_string());
        values.push(Value::Text(due_before));
    }
    if let Some(due_after) = filter.due_after {
        conditions.push("due IS NOT NULL AND due >= ?".to_string());
        values.push(Value::Text(due_after));
    }
    if let Some(has_commitment) = filter.has_commitment {
        let expression = "(NULLIF(TRIM(committed_to), '') IS NOT NULL OR \
                          NULLIF(TRIM(waiting_for), '') IS NOT NULL)";
        conditions.push(if has_commitment {
            expression.to_string()
        } else {
            format!("NOT {expression}")
        });
    }

    let mut sql = format!("SELECT {TODO_COLUMNS} FROM todos");
    if !conditions.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&conditions.join(" AND "));
    }
    sql.push_str(" ORDER BY done ASC, priority ASC, created_at DESC");
    if let Some(limit) = filter.limit {
        sql.push_str(" LIMIT ?");
        values.push(Value::Integer(i64::from(limit)));
    }

    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| format!("无法准备待办列表查询：{error}"))?;
    let todos = collect_todos(
        statement
            .query_map(params_from_iter(values.iter()), row_to_todo)
            .map_err(|error| format!("无法查询待办列表：{error}"))?,
    );
    todos
}

fn collect_todos(
    rows: rusqlite::MappedRows<'_, impl FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<Todo>>,
) -> Result<Vec<Todo>, String> {
    rows.map(|row| row.map_err(|error| format!("无法读取待办记录：{error}")))
        .collect()
}

fn migrate_from_json(connection: &mut Connection, json: &str) -> Result<u32, String> {
    let legacy: Vec<LegacyTodo> =
        serde_json::from_str(json).map_err(|error| format!("无法解析旧待办数据：{error}"))?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("无法开始旧待办迁移：{error}"))?;
    let mut imported = 0;

    for item in legacy {
        validate_optional_date(item.due.as_deref())?;
        let title = item
            .excerpt
            .clone()
            .or_else(|| item.note.clone())
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "待办".to_string());
        let source = if item.mid.is_some() {
            "message"
        } else {
            "manual"
        };
        let updated_at = item.done_at.unwrap_or(item.created_at).max(item.created_at);
        let changed = transaction
            .execute(
                "INSERT OR IGNORE INTO todos (
                    id, source, rid, mid, title, note, room_name, author, done,
                    priority, due, created_at, done_at, updated_at
                 ) VALUES (
                    ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 3, ?10, ?11, ?12, ?13
                 )",
                params![
                    item.id,
                    source,
                    item.rid,
                    item.mid,
                    title,
                    item.note,
                    item.room_name,
                    item.author,
                    i64::from(item.done),
                    item.due,
                    item.created_at,
                    item.done_at,
                    updated_at,
                ],
            )
            .map_err(|error| format!("无法导入旧待办：{error}"))?;
        imported += changed as u32;
    }
    transaction
        .commit()
        .map_err(|error| format!("无法提交旧待办迁移：{error}"))?;
    Ok(imported)
}

fn insert_todo(connection: &Connection, todo: &Todo, context: &str) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO todos (
                id, source, rid, mid, ado_work_item_id, ado_project, title, note,
                room_name, author, done, priority, due, created_at, done_at,
                updated_at, committed_to, waiting_for
             ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
                ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18
             )",
            params![
                todo.id,
                todo.source,
                todo.rid,
                todo.mid,
                todo.ado_work_item_id,
                todo.ado_project,
                todo.title,
                todo.note,
                todo.room_name,
                todo.author,
                i64::from(todo.done),
                todo.priority,
                todo.due,
                todo.created_at,
                todo.done_at,
                todo.updated_at,
                todo.committed_to,
                todo.waiting_for,
            ],
        )
        .map_err(|error| format!("{context}：{error}"))?;
    Ok(())
}

fn row_to_todo(row: &rusqlite::Row<'_>) -> rusqlite::Result<Todo> {
    Ok(Todo {
        id: row.get(0)?,
        source: row.get(1)?,
        rid: row.get(2)?,
        mid: row.get(3)?,
        ado_work_item_id: row.get(4)?,
        ado_project: row.get(5)?,
        title: row.get(6)?,
        note: row.get(7)?,
        room_name: row.get(8)?,
        author: row.get(9)?,
        done: row.get::<_, i64>(10)? != 0,
        priority: row.get(11)?,
        due: row.get(12)?,
        created_at: row.get(13)?,
        done_at: row.get(14)?,
        updated_at: row.get(15)?,
        committed_to: row.get(16)?,
        waiting_for: row.get(17)?,
    })
}

fn validate_source(source: &str) -> Result<(), String> {
    if matches!(source, "manual" | "message" | "ado") {
        Ok(())
    } else {
        Err("待办来源必须是 manual、message 或 ado".to_string())
    }
}

fn validate_title(title: &str) -> Result<(), String> {
    if title.trim().is_empty() {
        Err("待办标题不能为空".to_string())
    } else {
        Ok(())
    }
}

fn validate_priority(priority: i32) -> Result<(), String> {
    if (1..=4).contains(&priority) {
        Ok(())
    } else {
        Err("待办优先级必须在 1 到 4 之间".to_string())
    }
}

fn validate_optional_date(value: Option<&str>) -> Result<(), String> {
    if let Some(value) = value {
        validate_date(value)?;
    }
    Ok(())
}

fn validate_date(value: &str) -> Result<(), String> {
    let bytes = value.as_bytes();
    if bytes.len() != 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes
            .iter()
            .enumerate()
            .any(|(index, byte)| index != 4 && index != 7 && !byte.is_ascii_digit())
    {
        return Err("日期必须使用 YYYY-MM-DD 格式".to_string());
    }
    let year = value[0..4].parse::<u32>().unwrap_or(0);
    let month = value[5..7].parse::<u32>().unwrap_or(0);
    let day = value[8..10].parse::<u32>().unwrap_or(0);
    let leap = year.is_multiple_of(400) || (year.is_multiple_of(4) && !year.is_multiple_of(100));
    let max_day = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => 0,
    };
    if year == 0 || day == 0 || day > max_day {
        return Err("日期必须是有效的 YYYY-MM-DD".to_string());
    }
    Ok(())
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
