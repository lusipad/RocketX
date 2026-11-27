use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};

use super::migrate;

fn open(path: &Path) -> Result<Connection, String> {
    let mut connection = Connection::open(path).map_err(|e| format!("无法打开账号数据库：{e}"))?;
    connection
        .execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")
        .map_err(|e| format!("无法配置账号数据库：{e}"))?;
    migrate(&mut connection)?;
    Ok(connection)
}

pub(super) fn validate_account_scope(scope: &str) -> Result<(), String> {
    if scope.trim().is_empty() || scope.len() > 2048 {
        return Err("账号数据库需要明确的账号及服务器作用域".into());
    }
    Ok(())
}

pub(super) fn open_account_database(directory: &Path, scope: &str) -> Result<Connection, String> {
    validate_account_scope(scope)?;
    let scoped_path = directory.join(format!("butler-{:x}.db", Sha256::digest(scope.as_bytes())));
    let mut legacy = open(&directory.join("butler.db"))?;
    legacy
        .execute_batch("CREATE TABLE IF NOT EXISTS database_account_owner (id INTEGER PRIMARY KEY CHECK(id = 1), scope TEXT NOT NULL);")
        .map_err(|e| format!("无法读取数据库归属：{e}"))?;
    let transaction = legacy
        .transaction()
        .map_err(|e| format!("无法核对数据库归属：{e}"))?;
    let owner: Option<String> = transaction
        .query_row(
            "SELECT scope FROM database_account_owner WHERE id = 1",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| format!("无法读取数据库归属：{e}"))?;
    // A running native owner keeps the original connection after account changes.
    // Its local database cannot be reassigned to a different account underneath it.
    let native_owned: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM work_sessions WHERE runtime_owner='native_host')",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("无法核对本地运行归属：{error}"))?;
    let has_start_table: bool=transaction.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='work_native_starts')",[],|row|row.get(0))
        .map_err(|error|format!("无法核对原生创建记录：{error}"))?;
    let native_start_owned = has_start_table
        && transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM work_native_starts)",
                [],
                |row| row.get::<_, bool>(0),
            )
            .map_err(|error| format!("无法核对原生创建归属：{error}"))?;
    let use_legacy = owner.as_deref() == Some(scope)
        || owner.is_none()
        || (owner.as_deref() == Some("local-user@local")
            && !native_owned
            && !native_start_owned
            && scope != "local-user@local"
            && !scoped_path.exists());
    if use_legacy {
        transaction
            .execute("INSERT INTO database_account_owner (id, scope) VALUES (1, ?1) ON CONFLICT(id) DO UPDATE SET scope = excluded.scope", params![scope])
            .map_err(|e| format!("无法记录数据库归属：{e}"))?;
    }
    transaction
        .commit()
        .map_err(|e| format!("无法保存数据库归属：{e}"))?;
    if use_legacy {
        Ok(legacy)
    } else {
        open(&scoped_path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_native_start_without_session_keeps_original_local_account_database() {
        let directory =
            std::env::temp_dir().join(format!("rocketx-start-account-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let local = open_account_database(&directory, "local-user@local").unwrap();
        local.execute("INSERT INTO work_native_starts(request_id,todo_id,spec_json,state,owner_id,process_stopped,created_at,updated_at)
            VALUES('native-start:original','original','{}','unknown','owner',0,1,1)",[]).unwrap();
        let other = open_account_database(&directory, "user@server").unwrap();
        assert_eq!(
            other
                .query_row("SELECT count(*) FROM work_native_starts", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            local
                .query_row("SELECT scope FROM database_account_owner", [], |row| row
                    .get::<_, String>(
                    0
                ))
                .unwrap(),
            "local-user@local"
        );
        drop((local, other));
        let absolute = directory.canonicalize().unwrap();
        assert_eq!(
            absolute.parent(),
            Some(std::env::temp_dir().canonicalize().unwrap().as_path())
        );
        assert!(absolute
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("rocketx-start-account-"));
        std::fs::remove_dir_all(absolute).unwrap();
    }

    #[test]
    fn accounts_keep_original_ids_and_do_not_share_work_or_actions() {
        let directory =
            std::env::temp_dir().join(format!("rocketx-account-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let a = open_account_database(&directory, "alice@https://chat-a").unwrap();
        a.execute_batch(
            "CREATE TABLE account_test(id TEXT); INSERT INTO account_test VALUES('original-work');",
        )
        .unwrap();
        let b = open_account_database(&directory, "alice@https://chat-b").unwrap();
        assert_eq!(
            b.query_row(
                "SELECT count(*) FROM sqlite_master WHERE name = 'account_test'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        let a_again = open_account_database(&directory, "alice@https://chat-a").unwrap();
        assert_eq!(
            a_again
                .query_row("SELECT id FROM account_test", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "original-work"
        );
        // In-flight operations retain the original admitted connection after a switch.
        a.execute(
            "INSERT INTO account_test VALUES('late-original-result')",
            [],
        )
        .unwrap();
        assert_eq!(
            a_again
                .query_row("SELECT count(*) FROM account_test", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            2
        );
        drop((a, b, a_again));
        assert_eq!(directory.parent(), Some(std::env::temp_dir().as_path()));
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn local_data_is_claimed_once_and_cannot_reappear_in_another_account() {
        let directory =
            std::env::temp_dir().join(format!("rocketx-local-account-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let local = open_account_database(&directory, "local-user@local").unwrap();
        local
            .execute_batch(
                "CREATE TABLE local_test(id TEXT); INSERT INTO local_test VALUES('local-work');",
            )
            .unwrap();
        let a = open_account_database(&directory, "alice@https://chat").unwrap();
        assert_eq!(
            a.query_row("SELECT id FROM local_test", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "local-work"
        );
        let b = open_account_database(&directory, "bob@https://chat").unwrap();
        let local_again = open_account_database(&directory, "local-user@local").unwrap();
        for connection in [&b, &local_again] {
            assert_eq!(
                connection
                    .query_row(
                        "SELECT count(*) FROM sqlite_master WHERE name = 'local_test'",
                        [],
                        |r| r.get::<_, i64>(0)
                    )
                    .unwrap(),
                0
            );
        }
        drop((local, a, b, local_again));
        assert_eq!(directory.parent(), Some(std::env::temp_dir().as_path()));
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn queued_database_work_retains_its_admitted_account_connection() {
        let directory =
            std::env::temp_dir().join(format!("rocketx-account-switch-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let db = super::super::init_db(directory.clone()).unwrap();
        *db.current.lock().unwrap() = std::sync::Arc::new(std::sync::Mutex::new(
            open_account_database(&directory, "alice@chat").unwrap(),
        ));
        let admitted = db.connection();
        *db.current.lock().unwrap() = std::sync::Arc::new(std::sync::Mutex::new(
            open_account_database(&directory, "bob@chat").unwrap(),
        ));
        admitted.lock().unwrap().execute_batch("CREATE TABLE late_result(id TEXT); INSERT INTO late_result VALUES('alice-result');").unwrap();
        assert_eq!(
            db.connection()
                .lock()
                .unwrap()
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE name = 'late_result'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        assert_eq!(
            open_account_database(&directory, "alice@chat")
                .unwrap()
                .query_row("SELECT id FROM late_result", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "alice-result"
        );
        drop((admitted, db));
        assert_eq!(directory.parent(), Some(std::env::temp_dir().as_path()));
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn native_owned_local_database_cannot_be_claimed_by_login() {
        let directory =
            std::env::temp_dir().join(format!("rocketx-native-account-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let local = open_account_database(&directory, "local-user@local").unwrap();
        // Ownership alone reserves the database; no real process or credential is needed.
        local.execute_batch("INSERT INTO work_sessions(id,runtime,native_session_id,source_scope,workspace_root,title,control_mode,runtime_status,last_verified_at,created_at,updated_at,runtime_owner)
            VALUES('owned','codex','original','fixture','fixture','fixture','readonly','unknown',1,1,1,'native_host');
            CREATE TABLE local_native_result(value TEXT); INSERT INTO local_native_result VALUES('original');").unwrap();
        let remote = open_account_database(&directory, "alice@chat").unwrap();
        assert_eq!(
            remote
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE name='local_native_result'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        let local_again = open_account_database(&directory, "local-user@local").unwrap();
        assert_eq!(
            local_again
                .query_row("SELECT value FROM local_native_result", [], |row| row
                    .get::<_, String>(0))
                .unwrap(),
            "original"
        );
        drop((local, remote, local_again));
        assert_eq!(directory.parent(), Some(std::env::temp_dir().as_path()));
        std::fs::remove_dir_all(directory).unwrap();
    }
}
