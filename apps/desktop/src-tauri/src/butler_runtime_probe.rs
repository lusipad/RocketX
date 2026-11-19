//! Isolated debug acceptance probe, not a production scheduler or crash recovery service.

use std::{
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::Manager;

use super::{get_todo, now_millis, run_db, ButlerDb};

const ACCEPTANCE_ID: &str = "com.lusipad.rocketx.acceptance.autonomous20261117";
const TITLE_PREFIX: &str = "W02.04 runtime probe ";
const PROBE_KIND: &str = "rocketx-runtime-probe-v1";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProbeRecord {
    kind: String,
    probe_id: String,
    todo_id: String,
    state: String,
    accepted_at: i64,
    started_at: i64,
    work_started_at: Option<i64>,
    completed_at: Option<i64>,
    execution_count: u32,
    result: Option<String>,
}

fn validate_environment(
    identifier: &str,
    database_dir: &Path,
    app_data_dir: &Path,
) -> Result<(), String> {
    if identifier != ACCEPTANCE_ID {
        return Err("运行探针仅允许独立验收应用".into());
    }
    let database_dir = database_dir.canonicalize().map_err(|e| e.to_string())?;
    let app_data_dir = app_data_dir.canonicalize().map_err(|e| e.to_string())?;
    if database_dir != app_data_dir
        || app_data_dir.file_name().and_then(|s| s.to_str()) != Some(ACCEPTANCE_ID)
    {
        return Err("运行探针数据库必须位于该验收应用的数据目录".into());
    }
    Ok(())
}

fn save(connection: &Connection, record: &RuntimeProbeRecord) -> Result<(), String> {
    let note = serde_json::to_string(record).map_err(|e| e.to_string())?;
    let changed = connection
        .execute(
            "UPDATE todos SET note=?1,updated_at=?2 WHERE id=?3",
            params![note, now_millis(), record.todo_id],
        )
        .map_err(|e| e.to_string())?;
    if changed != 1 {
        return Err("探针对应合成待办已不存在".into());
    }
    Ok(())
}

fn read_existing(note: &str, todo_id: &str, probe_id: &str) -> Result<RuntimeProbeRecord, String> {
    let record: RuntimeProbeRecord =
        serde_json::from_str(note).map_err(|_| "探针不会覆盖已有备注")?;
    if record.kind != PROBE_KIND || record.todo_id != todo_id || record.probe_id != probe_id {
        return Err("合成待办已有其他探针或备注，不覆盖重跑".into());
    }
    Ok(record)
}

fn admit(
    connection: &Connection,
    todo_id: &str,
    probe_id: &str,
) -> Result<(RuntimeProbeRecord, bool), String> {
    if probe_id.is_empty()
        || probe_id.len() > 100
        || !probe_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err("probeId 需要 1–100 个字母、数字或短横线".into());
    }
    let todo = get_todo(connection, todo_id)?.ok_or("探针需要已存在的合成待办")?;
    if todo.source != "manual" || !todo.title.starts_with(TITLE_PREFIX) {
        return Err("探针仅处理带 W02.04 runtime probe 前缀的手工合成待办".into());
    }
    if let Some(note) = todo.note.filter(|note| !note.is_empty()) {
        return read_existing(&note, todo_id, probe_id).map(|record| (record, false));
    }
    let now = now_millis();
    let record = RuntimeProbeRecord {
        kind: PROBE_KIND.into(),
        probe_id: probe_id.into(),
        todo_id: todo_id.into(),
        state: "started".into(),
        accepted_at: now,
        started_at: now,
        work_started_at: None,
        completed_at: None,
        execution_count: 0,
        result: None,
    };
    save(connection, &record)?;
    Ok((record, true))
}

fn complete(
    connection: &Arc<Mutex<Connection>>,
    todo_id: &str,
    probe_id: &str,
) -> Result<RuntimeProbeRecord, String> {
    let connection = connection.lock().map_err(|_| "探针数据库锁不可用")?;
    let todo = get_todo(&connection, todo_id)?.ok_or("探针对应合成待办已不存在")?;
    let mut record = read_existing(todo.note.as_deref().unwrap_or(""), todo_id, probe_id)?;
    // An already started check is intentionally not retried, including after a crash.
    if record.state != "started" || record.execution_count != 0 {
        return Ok(record);
    }
    record.work_started_at = Some(now_millis());
    record.execution_count = 1;
    save(&connection, &record)?;
    let result: Result<String, _> =
        connection.query_row("PRAGMA integrity_check", [], |row| row.get(0));
    match result {
        Ok(result) => {
            record.state = if result == "ok" {
                "completed"
            } else {
                "failed"
            }
            .into();
            record.result = Some(result);
        }
        Err(error) => {
            record.state = "failed".into();
            record.result = Some(error.to_string());
        }
    }
    record.completed_at = Some(now_millis());
    save(&connection, &record)?;
    Ok(record)
}

#[tauri::command]
pub async fn butler_runtime_probe_start(
    app: tauri::AppHandle,
    db: tauri::State<'_, ButlerDb>,
    todo_id: String,
    probe_id: String,
) -> Result<RuntimeProbeRecord, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    validate_environment(&app.config().identifier, &db.directory, &app_data_dir)?;
    // Capture the admitted account's connection before awaiting or scheduling background work.
    let connection = db.connection();
    let admitted_todo = todo_id.clone();
    let admitted_probe = probe_id.clone();
    let (record, newly_started) = run_db(Arc::clone(&connection), move |connection| {
        admit(connection, &admitted_todo, &admitted_probe)
    })
    .await?;
    if newly_started {
        tauri::async_runtime::spawn_blocking(move || {
            // Give the isolated driver time to destroy/rebuild its WebView before actual DB work.
            std::thread::sleep(Duration::from_secs(8));
            if let Err(error) = complete(&connection, &todo_id, &probe_id) {
                log::warn!("isolated runtime probe failed: {error}");
            }
        });
    }
    Ok(record)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn database(title: &str) -> Connection {
        let mut connection = Connection::open_in_memory().unwrap();
        super::super::migrate(&mut connection).unwrap();
        connection
            .execute(
                "INSERT INTO todos(id,title,created_at,updated_at) VALUES('probe-todo',?1,1,1)",
                [title],
            )
            .unwrap();
        connection
    }

    #[test]
    fn rejects_production_identifier_before_accessing_paths() {
        assert!(validate_environment(
            "com.lusipad.rocketx",
            Path::new("does-not-exist"),
            Path::new("does-not-exist")
        )
        .unwrap_err()
        .contains("独立验收"));
    }

    #[test]
    fn requires_synthetic_todo_and_preserves_existing_notes() {
        let connection = database("ordinary work");
        assert!(admit(&connection, "probe-todo", "probe-1").is_err());
        connection
            .execute(
                "UPDATE todos SET title=?1,note='keep this note'",
                [format!("{TITLE_PREFIX}test")],
            )
            .unwrap();
        assert!(admit(&connection, "probe-todo", "probe-1").is_err());
        assert_eq!(
            get_todo(&connection, "probe-todo")
                .unwrap()
                .unwrap()
                .note
                .as_deref(),
            Some("keep this note")
        );
    }

    #[test]
    fn duplicate_admission_and_completion_do_not_repeat_the_check() {
        let connection = Arc::new(Mutex::new(database(&format!("{TITLE_PREFIX}test"))));
        let (first, new) = admit(&connection.lock().unwrap(), "probe-todo", "probe-1").unwrap();
        assert!(new);
        assert_eq!(first.execution_count, 0);
        let (duplicate, new) = admit(&connection.lock().unwrap(), "probe-todo", "probe-1").unwrap();
        assert!(!new);
        assert_eq!(duplicate.accepted_at, first.accepted_at);
        assert!(admit(&connection.lock().unwrap(), "probe-todo", "another-id").is_err());
        let result = complete(&connection, "probe-todo", "probe-1").unwrap();
        assert_eq!(result.state, "completed");
        assert_eq!(result.result.as_deref(), Some("ok"));
        assert_eq!(result.execution_count, 1);
        assert!(result.completed_at >= result.work_started_at);
        let repeated = complete(&connection, "probe-todo", "probe-1").unwrap();
        assert_eq!(repeated.completed_at, result.completed_at);
        assert_eq!(repeated.execution_count, 1);
        assert!(
            !admit(&connection.lock().unwrap(), "probe-todo", "probe-1")
                .unwrap()
                .1
        );
    }

    #[test]
    fn captured_connection_keeps_late_result_in_the_original_account() {
        let old = Arc::new(Mutex::new(database(&format!("{TITLE_PREFIX}old"))));
        let new = Arc::new(Mutex::new(database(&format!("{TITLE_PREFIX}new"))));
        let db = ButlerDb {
            current: Mutex::new(Arc::clone(&old)),
            selection: Mutex::new(super::super::RuntimeAccountSelection::default()),
            directory: std::path::PathBuf::new(),
        };
        let admitted = db.connection();
        admit(&admitted.lock().unwrap(), "probe-todo", "probe-1").unwrap();
        *db.current.lock().unwrap() = Arc::clone(&new);
        complete(&admitted, "probe-todo", "probe-1").unwrap();
        assert!(get_todo(&old.lock().unwrap(), "probe-todo")
            .unwrap()
            .unwrap()
            .note
            .unwrap()
            .contains("completed"));
        assert!(get_todo(&new.lock().unwrap(), "probe-todo")
            .unwrap()
            .unwrap()
            .note
            .is_none());
    }
}
