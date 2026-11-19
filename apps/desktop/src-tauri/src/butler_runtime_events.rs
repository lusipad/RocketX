//! Committed native runtime facts. The cursor belongs to this account database,
//! not to Codex: native app-server notifications do not carry a replay sequence.
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::{now_millis, run_db, ButlerDb, RuntimeAccountContext};

pub(crate) fn migrate_runtime_events(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "
        CREATE TABLE IF NOT EXISTS work_runtime_events (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            todo_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            action_id TEXT,
            event_type TEXT NOT NULL,
            connection_id TEXT NOT NULL,
            connection_sequence INTEGER NOT NULL CHECK(connection_sequence > 0),
            native_thread_id TEXT NOT NULL,
            native_turn_id TEXT,
            requirements_version INTEGER NOT NULL CHECK(requirements_version >= 0),
            content_version INTEGER NOT NULL CHECK(content_version >= 0),
            payload_json TEXT NOT NULL,
            received_at INTEGER NOT NULL,
            UNIQUE(connection_id, connection_sequence)
        );
        CREATE INDEX IF NOT EXISTS idx_work_runtime_events_work
            ON work_runtime_events(todo_id, sequence);
    ",
        )
        .map_err(|error| format!("无法初始化原生运行事件：{error}"))
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeEvent {
    pub sequence: i64,
    pub todo_id: String,
    pub session_id: String,
    pub action_id: Option<String>,
    pub event_type: String,
    pub connection_id: String,
    pub connection_sequence: i64,
    pub native_thread_id: String,
    pub native_turn_id: Option<String>,
    pub requirements_version: i64,
    pub content_version: i64,
    pub payload: serde_json::Value,
    pub received_at: i64,
}

pub(crate) fn append_runtime_event(
    connection: &Connection,
    event: &RuntimeEvent,
) -> Result<RuntimeEvent, String> {
    if event.connection_sequence <= 0
        || event.requirements_version < 0
        || event.content_version < 0
        || [
            &event.todo_id,
            &event.session_id,
            &event.connection_id,
            &event.native_thread_id,
            &event.event_type,
        ]
        .iter()
        .any(|value| value.trim().is_empty())
    {
        return Err("原生事件缺少身份、接收顺序或版本".into());
    }
    let payload = serde_json::to_string(&event.payload).map_err(|error| error.to_string())?;
    if payload.len() > 2 * 1024 * 1024 {
        return Err("原生事件超过 2 MiB".into());
    }
    let existing = connection.query_row(
        "SELECT sequence,todo_id,session_id,action_id,event_type,connection_id,connection_sequence,
                native_thread_id,native_turn_id,requirements_version,content_version,payload_json,received_at
         FROM work_runtime_events WHERE connection_id=?1 AND connection_sequence=?2",
        params![event.connection_id, event.connection_sequence], row_to_event,
    ).optional().map_err(|error| error.to_string())?;
    if let Some(existing) = existing {
        let mut candidate = event.clone();
        candidate.sequence = existing.sequence;
        candidate.received_at = existing.received_at;
        return if candidate == existing {
            Ok(existing)
        } else {
            Err("同一接收顺序对应不同原生事件".into())
        };
    }
    let received_at = now_millis();
    connection.execute(
        "INSERT INTO work_runtime_events(todo_id,session_id,action_id,event_type,connection_id,
            connection_sequence,native_thread_id,native_turn_id,requirements_version,content_version,payload_json,received_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
        params![event.todo_id,event.session_id,event.action_id,event.event_type,event.connection_id,
            event.connection_sequence,event.native_thread_id,event.native_turn_id,event.requirements_version,
            event.content_version,payload,received_at],
    ).map_err(|error| format!("无法保存原生运行事件：{error}"))?;
    Ok(RuntimeEvent {
        sequence: connection.last_insert_rowid(),
        received_at,
        ..event.clone()
    })
}

fn row_to_event(row: &rusqlite::Row<'_>) -> rusqlite::Result<RuntimeEvent> {
    let payload: String = row.get(11)?;
    Ok(RuntimeEvent {
        sequence: row.get(0)?,
        todo_id: row.get(1)?,
        session_id: row.get(2)?,
        action_id: row.get(3)?,
        event_type: row.get(4)?,
        connection_id: row.get(5)?,
        connection_sequence: row.get(6)?,
        native_thread_id: row.get(7)?,
        native_turn_id: row.get(8)?,
        requirements_version: row.get(9)?,
        content_version: row.get(10)?,
        payload: serde_json::from_str(&payload).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                11,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?,
        received_at: row.get(12)?,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeEventsQuery {
    pub account: RuntimeAccountContext,
    pub todo_id: Option<String>,
    pub after_sequence: i64,
    pub limit: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEventsPage {
    pub events: Vec<RuntimeEvent>,
    pub cursor: i64,
    pub has_more: bool,
}

fn read_events(
    connection: &Connection,
    query: &RuntimeEventsQuery,
) -> Result<RuntimeEventsPage, String> {
    if query.after_sequence < 0 || query.limit == 0 || query.limit > 500 {
        return Err("事件游标必须非负，每页范围为 1–500".into());
    }
    // One read transaction freezes both the high-water mark and this page.
    connection
        .execute_batch("SAVEPOINT runtime_events_read;")
        .map_err(|error| error.to_string())?;
    let result = (|| {
        let high_water: i64 = connection
            .query_row(
                "SELECT COALESCE(MAX(sequence),0) FROM work_runtime_events",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if query.after_sequence > high_water {
            return Err("事件游标不属于当前数据库快照，请重新加载".into());
        }
        let mut statement = connection.prepare(
            "SELECT sequence,todo_id,session_id,action_id,event_type,connection_id,connection_sequence,
                    native_thread_id,native_turn_id,requirements_version,content_version,payload_json,received_at
             FROM work_runtime_events WHERE sequence>?1 AND sequence<=?2 AND (?3 IS NULL OR todo_id=?3)
             ORDER BY sequence LIMIT ?4",
        ).map_err(|error| error.to_string())?;
        let mut events = statement
            .query_map(
                params![
                    query.after_sequence,
                    high_water,
                    query.todo_id,
                    query.limit + 1
                ],
                row_to_event,
            )
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        let has_more = events.len() > query.limit as usize;
        events.truncate(query.limit as usize);
        let cursor = if has_more {
            events
                .last()
                .map_or(query.after_sequence, |event| event.sequence)
        } else {
            high_water
        };
        Ok(RuntimeEventsPage {
            events,
            cursor,
            has_more,
        })
    })();
    match result {
        Ok(page) => {
            connection
                .execute_batch("RELEASE runtime_events_read;")
                .map_err(|error| error.to_string())?;
            Ok(page)
        }
        Err(error) => {
            let _ = connection
                .execute_batch("ROLLBACK TO runtime_events_read; RELEASE runtime_events_read;");
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn butler_work_runtime_events(
    db: tauri::State<'_, ButlerDb>,
    query: RuntimeEventsQuery,
) -> Result<RuntimeEventsPage, String> {
    let connection = db.connection_for_context(&query.account)?;
    run_db(connection, move |connection| {
        read_events(connection, &query)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(connection_sequence: i64, todo_id: &str) -> RuntimeEvent {
        RuntimeEvent {
            sequence: 0,
            todo_id: todo_id.into(),
            session_id: "binding-1".into(),
            action_id: None,
            event_type: "turn/completed".into(),
            connection_id: "connection-1".into(),
            connection_sequence,
            native_thread_id: "original-thread".into(),
            native_turn_id: Some("turn-1".into()),
            requirements_version: 2,
            content_version: 1,
            payload: serde_json::json!({"status":"completed"}),
            received_at: 0,
        }
    }

    fn query(after_sequence: i64, limit: u32, todo_id: Option<&str>) -> RuntimeEventsQuery {
        RuntimeEventsQuery {
            account: RuntimeAccountContext {
                account_scope: "test".into(),
                generation: 1,
            },
            todo_id: todo_id.map(str::to_string),
            after_sequence,
            limit,
        }
    }

    #[test]
    fn runtime_events_retry_is_idempotent_but_conflicting_fact_is_rejected() {
        let connection = Connection::open_in_memory().unwrap();
        migrate_runtime_events(&connection).unwrap();
        let first = append_runtime_event(&connection, &event(1, "work-1")).unwrap();
        assert_eq!(
            append_runtime_event(&connection, &event(1, "work-1")).unwrap(),
            first
        );
        assert!(append_runtime_event(&connection, &event(1, "work-2")).is_err());
        assert_eq!(
            read_events(&connection, &query(0, 20, None))
                .unwrap()
                .events
                .len(),
            1
        );
    }

    #[test]
    fn runtime_event_cursor_paginates_account_facts_without_skipping_work() {
        let connection = Connection::open_in_memory().unwrap();
        migrate_runtime_events(&connection).unwrap();
        for (sequence, work) in [(1, "a"), (2, "b"), (3, "a"), (4, "b")] {
            append_runtime_event(&connection, &event(sequence, work)).unwrap();
        }
        let first = read_events(&connection, &query(0, 1, Some("a"))).unwrap();
        assert_eq!(first.cursor, 1);
        assert!(first.has_more);
        let second = read_events(&connection, &query(first.cursor, 1, Some("a"))).unwrap();
        assert_eq!(second.events[0].sequence, 3);
        assert_eq!(second.cursor, 4);
        assert!(!second.has_more);
        assert!(read_events(&connection, &query(5, 10, None)).is_err());
    }

    #[test]
    fn runtime_event_and_command_transaction_can_rollback_together() {
        let connection = Connection::open_in_memory().unwrap();
        migrate_runtime_events(&connection).unwrap();
        connection.execute_batch("CREATE TABLE command_test(state TEXT); INSERT INTO command_test VALUES('prepared'); SAVEPOINT command_transition;").unwrap();
        connection
            .execute("UPDATE command_test SET state='acknowledged'", [])
            .unwrap();
        append_runtime_event(&connection, &event(1, "a")).unwrap();
        connection
            .execute_batch("ROLLBACK TO command_transition; RELEASE command_transition;")
            .unwrap();
        assert!(read_events(&connection, &query(0, 10, None))
            .unwrap()
            .events
            .is_empty());
        assert_eq!(
            connection
                .query_row("SELECT state FROM command_test", [], |row| row
                    .get::<_, String>(0))
                .unwrap(),
            "prepared"
        );
    }
}
