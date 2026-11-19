use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension};

use crate::native::process::host_path;

#[derive(Debug)]
pub(super) struct VerifiedNewWork {
    pub title: String,
    pub goal: String,
    pub workspace_root: String,
}

fn project_directory(value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value);
    if !path.is_absolute() {
        return Err("请为这项工作选择完整的项目目录".into());
    }
    let resolved = path
        .canonicalize()
        .map_err(|_| "项目目录不存在或无法访问，请重新选择目录")?;
    if !resolved.is_dir() {
        return Err("工作位置必须是目录".into());
    }
    Ok(resolved)
}

// Called before thread/start and again before committing its first prompt.
pub(super) fn validate_new_work(
    connection: &Connection,
    todo_id: &str,
    workspace_root: &str,
    expected_requirements_version: i64,
    expected_content_version: i64,
) -> Result<VerifiedNewWork, String> {
    let (title, goal, requirements, content, writable, has_session) = connection
        .query_row(
            "SELECT t.title, coalesce(w.goal,''), w.requirements_version, w.content_version,
                    (t.done=0 AND w.visibility='private' AND w.autonomy_mode!='readonly'
                     AND w.wait_state='none' AND w.stage IN ('ready','triage')),
                    EXISTS(SELECT 1 FROM work_sessions s WHERE s.todo_id=t.id)
             FROM todos t JOIN work_card_states w ON w.todo_id=t.id WHERE t.id=?1",
            [todo_id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, bool>(4)?,
                    r.get::<_, bool>(5)?,
                ))
            },
        )
        .optional()
        .map_err(|e| format!("无法核对工作：{e}"))?
        .ok_or("当前账号下找不到这项工作")?;
    if requirements < 0
        || content < 0
        || requirements != expected_requirements_version
        || content != expected_content_version
    {
        return Err("工作要求或内容已变化，请重新打开工作后再开始".into());
    }
    if !writable || goal.trim().is_empty() {
        return Err("只有目标明确、待开始且可写的个人工作才能开始调查".into());
    }
    if has_session {
        return Err("这项工作已有关联会话，请在原工作中继续".into());
    }

    let requested = project_directory(workspace_root)?;
    let mut links = connection.prepare(
        "SELECT repo FROM work_links WHERE todo_id=?1 AND kind='kanban_card' AND state_snapshot='workspace'",
    ).map_err(|e| e.to_string())?;
    let mut rows = links.query([todo_id]).map_err(|e| e.to_string())?;
    let mut matched = false;
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let repo: Option<String> = row.get(0).map_err(|e| e.to_string())?;
        if project_directory(repo.as_deref().unwrap_or(""))? != requested {
            return Err("所选项目与这项工作保存的目录不一致，请先核对工作位置".into());
        }
        matched = true;
    }
    if !matched {
        return Err("这项工作尚未保存项目目录".into());
    }
    Ok(VerifiedNewWork {
        title,
        goal,
        workspace_root: host_path(&requested),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    fn fixture() -> (Connection, String) {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(crate::butler_db::SCHEMA_V1).unwrap();
        crate::butler_db::butler_ledger::migrate_ledger(&db).unwrap();
        db.execute_batch("INSERT INTO todos (id,title,created_at,updated_at) VALUES ('task','新项目',1,1);
            INSERT INTO work_card_states(todo_id,goal,updated_at) VALUES ('task','逐项调查并记录结果',1);").unwrap();
        let root = host_path(&std::env::temp_dir().canonicalize().unwrap());
        bind(&db, "original", &root);
        (db, root)
    }

    fn bind(db: &Connection, id: &str, root: &str) {
        db.execute("INSERT INTO work_links(id,todo_id,kind,external_id,repo,state_snapshot,last_verified_at,created_at)
                    VALUES (?1,'task','kanban_card',?1,?2,'workspace',1,1)", params![id, root]).unwrap();
    }

    #[test]
    fn native_start_validation_zero_version_user_work_reuses_exact_bound_directory_and_goal() {
        let (db, root) = fixture();
        let alias = Path::new(&root).join(".");
        bind(&db, "same-directory", alias.to_str().unwrap());
        let work = validate_new_work(&db, "task", &root, 0, 0).unwrap();
        assert_eq!(work.workspace_root, root);
        assert_eq!(work.goal, "逐项调查并记录结果");
        assert_eq!(work.title, "新项目");
        assert!(validate_new_work(&db, "task", &root, 1, 0).is_err());
        assert!(validate_new_work(&db, "task", &root, 0, -1).is_err());
    }

    #[test]
    fn native_start_validation_refuses_missing_ambiguous_and_unbound_directories() {
        let (db, root) = fixture();
        assert!(validate_new_work(&db, "task", ".", 0, 0).is_err());
        let nonexistent = Path::new(&root).join(uuid::Uuid::new_v4().to_string());
        assert!(validate_new_work(&db, "task", nonexistent.to_str().unwrap(), 0, 0).is_err());
        let different = Path::new(&root).parent().unwrap().to_str().unwrap();
        assert!(validate_new_work(&db, "task", different, 0, 0).is_err());
        bind(&db, "conflicting-directory", different);
        assert!(validate_new_work(&db, "task", &root, 0, 0).is_err());
        db.execute("DELETE FROM work_links", []).unwrap();
        assert!(validate_new_work(&db, "task", &root, 0, 0).is_err());
    }

    #[test]
    fn native_start_validation_rejects_already_owned_or_unwritable_work() {
        for change in [
            "stage='done'",
            "wait_state='paused'",
            "wait_state='waiting_approval'",
            "autonomy_mode='readonly'",
            "visibility='room_shared'",
            "goal=' '",
        ] {
            let (db, root) = fixture();
            db.execute(&format!("UPDATE work_card_states SET {change}"), [])
                .unwrap();
            assert!(
                validate_new_work(&db, "task", &root, 0, 0).is_err(),
                "{change}"
            );
        }
        let (db, root) = fixture();
        db.execute("UPDATE todos SET done=1", []).unwrap();
        assert!(validate_new_work(&db, "task", &root, 0, 0).is_err());
        db.execute("UPDATE todos SET done=0", []).unwrap();
        db.execute("INSERT INTO work_sessions(id,todo_id,runtime,native_session_id,workspace_root,
                    control_mode,last_verified_at,created_at,updated_at) VALUES ('s','task','codex','original',?1,'readonly',1,1,1)", [&root]).unwrap();
        assert!(validate_new_work(&db, "task", &root, 0, 0).is_err());
    }
}
