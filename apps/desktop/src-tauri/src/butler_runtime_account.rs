use std::sync::{Arc, Mutex};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use super::ButlerDb;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeAccountContext {
    pub account_scope: String,
    pub generation: u64,
}

#[derive(Default)]
pub(super) struct RuntimeAccountSelection {
    generation: u64,
    account_scope: Option<String>,
    ready: bool,
}

impl RuntimeAccountSelection {
    fn matches(&self, context: &RuntimeAccountContext) -> bool {
        self.generation == context.generation
            && self.account_scope.as_deref() == Some(context.account_scope.as_str())
    }
}

impl ButlerDb {
    pub(super) fn begin_account_selection(
        &self,
        account_scope: String,
    ) -> Result<RuntimeAccountContext, String> {
        super::butler_account::validate_account_scope(&account_scope)?;
        let mut selection = self.selection.lock().map_err(|_| "无法读取账号选择状态")?;
        selection.generation = selection
            .generation
            .checked_add(1)
            .ok_or("账号选择代际已耗尽")?;
        selection.account_scope = Some(account_scope.clone());
        selection.ready = false;
        Ok(RuntimeAccountContext {
            account_scope,
            generation: selection.generation,
        })
    }

    pub(super) fn complete_account_selection(
        &self,
        context: &RuntimeAccountContext,
        connection: Connection,
    ) -> Result<RuntimeAccountContext, String> {
        let mut selection = self.selection.lock().map_err(|_| "无法读取账号选择状态")?;
        if !selection.matches(context) {
            return Err("账号已切换，旧数据库选择已取消".into());
        }
        *self.current.lock().map_err(|_| "无法切换账号数据库")? = Arc::new(Mutex::new(connection));
        selection.ready = true;
        Ok(context.clone())
    }

    pub fn runtime_account_context(&self) -> Result<RuntimeAccountContext, String> {
        let selection = self.selection.lock().map_err(|_| "无法读取账号选择状态")?;
        if !selection.ready {
            return Err("账号数据库尚未就绪".into());
        }
        Ok(RuntimeAccountContext {
            account_scope: selection
                .account_scope
                .clone()
                .ok_or("账号数据库尚未选择")?,
            generation: selection.generation,
        })
    }

    pub fn connection_for_context(
        &self,
        context: &RuntimeAccountContext,
    ) -> Result<Arc<Mutex<Connection>>, String> {
        let selection = self.selection.lock().map_err(|_| "无法读取账号选择状态")?;
        if !selection.ready || !selection.matches(context) {
            return Err("账号已切换或数据库尚未就绪，旧操作已取消".into());
        }
        // Selection and connection capture share the same lock as publication.
        // An admitted operation keeps this Arc even when another account is selected.
        Ok(Arc::clone(
            &*self.current.lock().map_err(|_| "无法读取账号数据库")?,
        ))
    }

    /// Keep account selection and the durable claim in one admission boundary.
    /// The operation may use an already captured DB Arc, but must not select an
    /// account or recursively acquire this selection lock.
    pub(crate) fn with_runtime_account_context<T>(
        &self,
        context: &RuntimeAccountContext,
        operation: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let selection = self.selection.lock().map_err(|_| "无法读取账号选择状态")?;
        if !selection.ready || !selection.matches(context) {
            return Err("账号已切换，尚未认领的原操作已停止派发".into());
        }
        let result = operation();
        drop(selection);
        result
    }
}

#[tauri::command]
pub fn butler_runtime_account_context(
    db: tauri::State<'_, ButlerDb>,
) -> Result<RuntimeAccountContext, String> {
    db.runtime_account_context()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{path::PathBuf, sync::mpsc};

    fn database() -> ButlerDb {
        ButlerDb {
            current: Mutex::new(Arc::new(Mutex::new(Connection::open_in_memory().unwrap()))),
            selection: Mutex::new(RuntimeAccountSelection::default()),
            directory: PathBuf::new(),
        }
    }

    fn marked_connection(marker: &str) -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch("CREATE TABLE owner(marker TEXT);")
            .unwrap();
        connection
            .execute("INSERT INTO owner VALUES(?1)", [marker])
            .unwrap();
        connection
    }

    #[test]
    fn runtime_account_context_requires_selected_ready_database() {
        let db = database();
        assert!(db.runtime_account_context().is_err());
        let a = db.begin_account_selection("A@chat".into()).unwrap();
        assert_eq!(a.generation, 1);
        assert!(db.runtime_account_context().is_err());
        assert!(db.connection_for_context(&a).is_err());
        assert_eq!(
            db.complete_account_selection(&a, marked_connection("A"))
                .unwrap(),
            a
        );
        assert_eq!(db.runtime_account_context().unwrap(), a);
        assert!(db.connection_for_context(&a).is_ok());
    }

    #[test]
    fn runtime_account_claim_holds_selection_until_admitted_operation_finishes() {
        let db = Arc::new(database());
        let a = db.begin_account_selection("A@chat".into()).unwrap();
        db.complete_account_selection(&a, marked_connection("A"))
            .unwrap();
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let claim_db = Arc::clone(&db);
        let old = a.clone();
        let claim = std::thread::spawn(move || {
            claim_db.with_runtime_account_context(&old, || {
                entered_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                Ok(())
            })
        });
        entered_rx.recv().unwrap();
        assert!(db.selection.try_lock().is_err());
        release_tx.send(()).unwrap();
        claim.join().unwrap().unwrap();
        db.begin_account_selection("B@chat".into()).unwrap();
        let called = std::cell::Cell::new(false);
        assert!(db
            .with_runtime_account_context(&a, || {
                called.set(true);
                Ok(())
            })
            .is_err());
        assert!(!called.get());
    }

    #[test]
    fn runtime_account_slow_a_cannot_replace_ready_b() {
        let db = Arc::new(database());
        let a = db.begin_account_selection("A@chat".into()).unwrap();
        let (release_a, wait_for_b) = mpsc::channel();
        let slow_db = Arc::clone(&db);
        let slow_a = std::thread::spawn(move || {
            let connection = marked_connection("A");
            wait_for_b.recv().unwrap();
            slow_db.complete_account_selection(&a, connection)
        });
        let b = db.begin_account_selection("B@chat".into()).unwrap();
        db.complete_account_selection(&b, marked_connection("B"))
            .unwrap();
        release_a.send(()).unwrap();
        assert!(slow_a.join().unwrap().unwrap_err().contains("旧数据库选择"));
        assert_eq!(db.runtime_account_context().unwrap(), b);
        assert_eq!(
            db.connection_for_context(&b)
                .unwrap()
                .lock()
                .unwrap()
                .query_row("SELECT marker FROM owner", [], |row| row
                    .get::<_, String>(0))
                .unwrap(),
            "B"
        );
    }

    #[test]
    fn runtime_account_reselection_invalidates_old_context_before_open_completes() {
        let db = database();
        let old = db.begin_account_selection("A@chat".into()).unwrap();
        db.complete_account_selection(&old, marked_connection("old"))
            .unwrap();
        let next = db.begin_account_selection("A@chat".into()).unwrap();
        assert!(next.generation > old.generation);
        assert!(db.connection_for_context(&old).is_err());
        assert!(db.runtime_account_context().is_err());
        db.complete_account_selection(&next, marked_connection("new"))
            .unwrap();
        assert!(db.connection_for_context(&old).is_err());
        let wrong_scope = RuntimeAccountContext {
            account_scope: "B@chat".into(),
            ..next.clone()
        };
        assert!(db.connection_for_context(&wrong_scope).is_err());
        assert!(db.connection_for_context(&next).is_ok());
    }

    #[test]
    fn runtime_account_admitted_connection_keeps_late_result_in_original_database() {
        let db = database();
        let a = db.begin_account_selection("A@chat".into()).unwrap();
        db.complete_account_selection(&a, marked_connection("A"))
            .unwrap();
        let admitted = db.connection_for_context(&a).unwrap();
        let b = db.begin_account_selection("B@chat".into()).unwrap();
        db.complete_account_selection(&b, marked_connection("B"))
            .unwrap();
        admitted
            .lock()
            .unwrap()
            .execute_batch(
                "CREATE TABLE late_result(value TEXT); INSERT INTO late_result VALUES('A-result');",
            )
            .unwrap();
        assert_eq!(
            admitted
                .lock()
                .unwrap()
                .query_row("SELECT value FROM late_result", [], |row| row
                    .get::<_, String>(0))
                .unwrap(),
            "A-result"
        );
        assert_eq!(
            db.connection_for_context(&b)
                .unwrap()
                .lock()
                .unwrap()
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE name = 'late_result'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        assert!(db.connection_for_context(&a).is_err());
    }
}
