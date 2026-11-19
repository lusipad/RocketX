use std::path::Path;

use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
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
    let legacy_path = directory.join("butler.db");
    if !legacy_path
        .try_exists()
        .map_err(|error| error.to_string())?
    {
        return select_home_database(directory, scope);
    }

    // v0.44.18 used one database for every account. Keep it read-only until
    // the database itself identifies an owner. Browser sign-in history is not row ownership.
    let legacy = Connection::open_with_flags(&legacy_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("无法核对旧待办库：{error}"))?;
    let has_owner: bool = legacy.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='database_account_owner')",
        [], |row| row.get(0),
    ).map_err(|error| error.to_string())?;
    if has_owner {
        let owner: Option<String> = legacy
            .query_row(
                "SELECT scope FROM database_account_owner WHERE id=1",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if let Some(owner) = owner {
            drop(legacy);
            return if owner == scope {
                open(&legacy_path)
            } else {
                select_home_database(directory, scope)
            };
        }
    }
    let mut selected = select_home_database(directory, scope)?;
    restore_owned_todos(&legacy, &mut selected, scope)?;
    Ok(selected)
}

fn restore_owned_todos(
    legacy: &Connection,
    selected: &mut Connection,
    scope: &str,
) -> Result<(), String> {
    let Some((user, server)) = scope.split_once('@') else {
        return Ok(());
    };
    if scope == "local-user@local"
        || user.is_empty()
        || server.is_empty()
        || user == "legacy-unassigned"
        || server == "legacy-unassigned"
    {
        return Ok(());
    }
    let version: i64 = legacy
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if !(1..=super::MAX_COMPATIBLE_SCHEMA_VERSION).contains(&version) {
        return Ok(());
    }
    let has_row_owners: bool = legacy.query_row(
        "SELECT COUNT(*)=2 FROM pragma_table_info('todos') WHERE name IN ('user_id','server_id')",
        [], |row| row.get(0),
    ).map_err(|error| error.to_string())?;
    if !has_row_owners {
        return Ok(());
    }

    let sql = format!(
        "SELECT {} FROM todos WHERE user_id=?1 AND server_id=?2",
        super::TODO_COLUMNS
    );
    let mut statement = legacy.prepare(&sql).map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![user, server], super::row_to_todo)
        .map_err(|error| error.to_string())?;
    let transaction = selected
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    transaction
        .execute_batch("CREATE TABLE IF NOT EXISTS restored_legacy_todos(id TEXT PRIMARY KEY)")
        .map_err(|error| error.to_string())?;
    for row in rows {
        let todo = row.map_err(|error| error.to_string())?;
        let fresh = transaction
            .execute(
                "INSERT OR IGNORE INTO restored_legacy_todos(id) VALUES (?1)",
                [&todo.id],
            )
            .map_err(|error| error.to_string())?;
        if fresh != 0 && super::get_todo(&transaction, &todo.id)?.is_none() {
            super::insert_todo(&transaction, &todo, "无法恢复旧账号待办")?;
        }
    }
    transaction.commit().map_err(|error| error.to_string())
}

fn select_home_database(directory: &Path, scope: &str) -> Result<Connection, String> {
    let scoped_path = directory.join(format!("butler-{:x}.db", Sha256::digest(scope.as_bytes())));
    let mut home = open(&directory.join("butler-home.db"))?;
    home
        .execute_batch("CREATE TABLE IF NOT EXISTS database_account_owner (id INTEGER PRIMARY KEY CHECK(id = 1), scope TEXT NOT NULL);")
        .map_err(|e| format!("无法读取数据库归属：{e}"))?;
    let transaction = home
        .transaction_with_behavior(TransactionBehavior::Immediate)
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
    let use_home = owner.as_deref() == Some(scope)
        || (owner.is_none() && !scoped_path.exists())
        || (owner.as_deref() == Some("local-user@local")
            && !native_owned
            && !native_start_owned
            && scope != "local-user@local"
            && !scoped_path.exists());
    if use_home {
        transaction
            .execute("INSERT INTO database_account_owner (id, scope) VALUES (1, ?1) ON CONFLICT(id) DO UPDATE SET scope = excluded.scope", params![scope])
            .map_err(|e| format!("无法记录数据库归属：{e}"))?;
    }
    transaction
        .commit()
        .map_err(|e| format!("无法保存数据库归属：{e}"))?;
    if use_home {
        Ok(home)
    } else {
        open(&scoped_path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upgrade_preserves_unassigned_v1_todos_and_separates_new_work() {
        let directory =
            std::env::temp_dir().join(format!("rocketx-v1-account-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("butler.db");
        let legacy = Connection::open(&path).unwrap();
        legacy.execute_batch(super::super::SCHEMA_V1).unwrap();
        legacy.execute_batch("PRAGMA user_version=1; INSERT INTO todos(id,title,created_at,updated_at) VALUES('old','fixture',1,1)").unwrap();
        drop(legacy);
        let original = std::fs::read(&path).unwrap();
        let db = super::super::init_db(directory.clone()).unwrap();
        assert!(
            super::super::get_todo(&db.connection().lock().unwrap(), "old")
                .unwrap()
                .is_none()
        );
        for scope in [
            "local-user@local",
            "A@https://chat",
            "B@https://chat",
            "A@https://chat",
        ] {
            let active = open_account_database(&directory, scope).unwrap();
            assert!(super::super::get_todo(&active, "old").unwrap().is_none());
        }
        drop(db);
        assert_eq!(std::fs::read(&path).unwrap(), original);
        assert_eq!(directory.parent(), Some(std::env::temp_dir().as_path()));
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn existing_database_owner_keeps_the_original_v1_database() {
        let directory =
            std::env::temp_dir().join(format!("rocketx-marked-v1-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("butler.db");
        let legacy = Connection::open(&path).unwrap();
        legacy.execute_batch(super::super::SCHEMA_V1).unwrap();
        legacy
            .execute_batch(
                "PRAGMA user_version=1;
            CREATE TABLE database_account_owner(id INTEGER PRIMARY KEY,scope TEXT NOT NULL);
            INSERT INTO database_account_owner VALUES(1,'A@chat');
            INSERT INTO todos(id,title,created_at,updated_at) VALUES('known','fixture',1,2)",
            )
            .unwrap();
        drop(legacy);
        for scope in [
            "local-user@local",
            "B@chat",
            "A@chat",
            "A@elsewhere",
            "A@chat",
        ] {
            let active = open_account_database(&directory, scope).unwrap();
            assert_eq!(
                super::super::get_todo(&active, "known").unwrap().is_some(),
                scope == "A@chat"
            );
        }
        assert_eq!(directory.parent(), Some(std::env::temp_dir().as_path()));
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn upgrade_restores_only_explicitly_owned_rows_and_never_resurrects_deletions() {
        let directory =
            std::env::temp_dir().join(format!("rocketx-v2-account-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let legacy = Connection::open(directory.join("butler.db")).unwrap();
        legacy.execute_batch(super::super::SCHEMA_V1).unwrap();
        legacy.execute_batch("PRAGMA user_version=2;
            ALTER TABLE todos ADD COLUMN server_id TEXT NOT NULL DEFAULT 'legacy-unassigned';
            ALTER TABLE todos ADD COLUMN user_id TEXT NOT NULL DEFAULT 'legacy-unassigned';
            INSERT INTO todos(id,title,created_at,updated_at,user_id,server_id) VALUES
            ('tagged','mine',1,2,'A','https://chat'),('other','other server',1,2,'A','https://elsewhere'),
            ('other-user','other user',1,2,'B','https://chat'),
            ('none','unknown',1,2,'legacy-unassigned','legacy-unassigned')").unwrap();
        drop(legacy);
        let local = open_account_database(&directory, "local-user@local").unwrap();
        assert!(super::super::get_todo(&local, "tagged").unwrap().is_none());
        drop(local);
        let a = open_account_database(&directory, "A@https://chat").unwrap();
        assert_eq!(
            super::super::get_todo(&a, "tagged")
                .unwrap()
                .unwrap()
                .updated_at,
            2
        );
        assert!(super::super::get_todo(&a, "other").unwrap().is_none());
        assert!(super::super::get_todo(&a, "other-user").unwrap().is_none());
        assert!(super::super::get_todo(&a, "none").unwrap().is_none());
        a.execute("DELETE FROM todos WHERE id='tagged'", [])
            .unwrap();
        drop(a);
        let again = open_account_database(&directory, "A@https://chat").unwrap();
        assert!(super::super::get_todo(&again, "tagged").unwrap().is_none());
        drop(again);
        let b = open_account_database(&directory, "A@https://elsewhere").unwrap();
        assert!(super::super::get_todo(&b, "other").unwrap().is_some());
        assert!(super::super::get_todo(&b, "tagged").unwrap().is_none());
        drop(b);
        assert_eq!(directory.parent(), Some(std::env::temp_dir().as_path()));
        std::fs::remove_dir_all(directory).unwrap();
    }

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
