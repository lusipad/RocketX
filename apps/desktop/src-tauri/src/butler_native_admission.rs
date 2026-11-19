//! Installation-wide native write reservations. This database contains ownership
//! metadata only; account work, prompts and credentials remain in account databases.
use std::{
    fs::{File, OpenOptions},
    io::{Read, Write},
    path::Path,
    time::Duration,
};

use rusqlite::{params, Connection, OpenFlags, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::native::{
    work_command::{NativeCodexIntent, NativeCommandSpec},
    work_projection::NativeWorkAdmissionWait,
};

const HOST_FILE: &str = "rocketx-native-admission.sqlite";
const EXECUTION_SLOTS: usize = 2;

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub(super) struct ReservationOwner {
    action_id: String,
    request_id: String,
    account_scope: String,
    account_generation: u64,
    session_id: String,
    binding_version: i64,
    connection_id: String,
    canonical_workspace: String,
    #[serde(default)]
    native_thread_id: String,
    #[serde(default)]
    source_scope: String,
    #[serde(default)]
    guard_version: u32,
}

impl ReservationOwner {
    pub(super) fn for_command(
        action_id: &str,
        spec: &NativeCommandSpec,
        connection_id: &str,
    ) -> Result<Self, String> {
        Ok(Self {
            action_id: action_id.into(),
            request_id: spec.request_id.clone(),
            account_scope: spec.scope.account_scope.clone(),
            account_generation: spec.scope.account_generation,
            session_id: spec.binding.session_id.clone(),
            binding_version: spec.binding.binding_version,
            connection_id: connection_id.into(),
            canonical_workspace: canonical_workspace(&spec.binding.workspace_root)?,
            native_thread_id: spec.binding.native_thread_id.clone(),
            source_scope: spec.binding.source_scope.clone(),
            guard_version: 1,
        })
    }

    fn key(&self) -> Result<String, String> {
        serde_json::to_string(self).map_err(|error| error.to_string())
    }

    fn same_command(&self, other: &Self) -> bool {
        self.account_scope == other.account_scope
            && self.action_id == other.action_id
            && self.request_id == other.request_id
            && self.session_id == other.session_id
            && self.binding_version == other.binding_version
            && self.account_generation == other.account_generation
            && self.native_thread_id == other.native_thread_id
            && self.source_scope == other.source_scope
    }

    pub(super) fn matches_command(&self, action_id: &str, spec: &NativeCommandSpec) -> bool {
        self.action_id == action_id
            && self.request_id == spec.request_id
            && self.account_scope == spec.scope.account_scope
            && self.account_generation == spec.scope.account_generation
            && self.session_id == spec.binding.session_id
            && self.binding_version == spec.binding.binding_version
            && self.native_thread_id == spec.binding.native_thread_id
            && self.source_scope == spec.binding.source_scope
    }

    pub(super) fn matches_restored_binding(
        &self,
        account: &str,
        binding: &crate::native::work_command::NativeCommandBinding,
    ) -> bool {
        self.account_scope == account
            && self.session_id == binding.session_id
            && self.native_thread_id == binding.native_thread_id
            && self.source_scope == binding.source_scope
            && self.binding_version < binding.binding_version
            && canonical_workspace(&binding.workspace_root).ok().as_deref()
                == Some(self.canonical_workspace.as_str())
    }

    pub(super) fn is_snapshot_recovery(&self) -> bool {
        self.request_id == "recovered-snapshot"
    }
}

fn guard_path(directory: &Path, connection_id: &str) -> std::path::PathBuf {
    directory.join("native-resource-owners").join(format!(
        "{:x}.lock",
        Sha256::digest(connection_id.as_bytes())
    ))
}

fn exclusive_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options.read(true).write(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(0);
    }
    options
}

/// A connection holds this native handle for its lifetime. A later empty file
/// is not proof: recovery requires versioned ownership plus the original marker.
pub(super) fn connection_guard(directory: &Path, connection_id: &str) -> Result<File, String> {
    let path = guard_path(directory, connection_id);
    std::fs::create_dir_all(path.parent().ok_or("资源归属目录无效")?)
        .map_err(|error| error.to_string())?;
    let mut file = exclusive_options()
        .create_new(true)
        .open(path)
        .map_err(|error| format!("无法保留原生连接归属：{error}"))?;
    #[cfg(not(windows))]
    file.try_lock().map_err(|error| error.to_string())?;
    file.write_all(format!("rocketx.native-owner.v1\n{connection_id}").as_bytes())
        .map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    Ok(file)
}

pub(super) fn recovery_guard(
    directory: &Path,
    owner: &ReservationOwner,
) -> Result<Option<File>, String> {
    recover_connection_guard(directory, &owner.connection_id, owner.guard_version)
}

pub(super) fn recover_connection_guard(
    directory: &Path,
    connection_id: &str,
    guard_version: u32,
) -> Result<Option<File>, String> {
    if guard_version != 1 {
        return Ok(None);
    }
    // Never create a missing lock: older runtimes did not promise to hold it.
    let mut file = exclusive_options()
        .open(guard_path(directory, connection_id))
        .map_err(|_| "原执行仍保有归属，或缺少可核实的旧归属锁；尚未释放占用")?;
    #[cfg(not(windows))]
    file.try_lock()
        .map_err(|_| "原执行仍保有归属，尚未释放占用")?;
    let mut marker = String::new();
    file.read_to_string(&mut marker)
        .map_err(|error| error.to_string())?;
    if marker != format!("rocketx.native-owner.v1\n{connection_id}") {
        return Err("旧归属锁不匹配，尚未释放占用".into());
    }
    Ok(Some(file))
}

fn canonical_workspace(directory: &str) -> Result<String, String> {
    let path =
        std::fs::canonicalize(directory).map_err(|_| "无法核实实际工作目录，尚未申请执行资源")?;
    if !path.is_dir() {
        return Err("工作目录不是文件夹，尚未申请执行资源".into());
    }
    let path = path
        .to_str()
        .ok_or("工作目录编码无法核实，尚未申请执行资源")?
        .replace('\\', "/");
    #[cfg(windows)]
    let path = path.to_lowercase();
    // canonicalize resolves junctions and symlinks; separators make component
    // boundaries explicit, so sibling `repo` and `repo-other` do not overlap.
    let trimmed = path.trim_end_matches('/');
    Ok(if trimmed.is_empty() { "/" } else { trimmed }.to_string())
}

fn overlaps(left: &str, right: &str) -> bool {
    left == "/"
        || right == "/"
        || left == right
        || left
            .strip_prefix(right)
            .is_some_and(|suffix| suffix.starts_with('/'))
        || right
            .strip_prefix(left)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

fn open(directory: &Path) -> Result<Connection, String> {
    let connection = Connection::open(directory.join(HOST_FILE))
        .map_err(|error| format!("无法打开本机执行资源登记：{error}"))?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|error| error.to_string())?;
    connection
        .execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE IF NOT EXISTS native_write_reservations (
                owner_key TEXT PRIMARY KEY,
                owner_json TEXT NOT NULL,
                native_turn TEXT,
                recovered INTEGER NOT NULL DEFAULT 0
             );",
        )
        .map_err(|error| format!("无法初始化本机执行资源登记：{error}"))?;
    Ok(connection)
}

#[derive(Debug)]
pub(super) enum Admission {
    Granted,
    Deferred(NativeWorkAdmissionWait),
}

fn owners(connection: &Connection) -> Result<Vec<ReservationOwner>, String> {
    let mut statement = connection
        .prepare("SELECT owner_json FROM native_write_reservations")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    rows.map(|row| {
        serde_json::from_str(&row.map_err(|error| error.to_string())?)
            .map_err(|_| "本机资源归属记录损坏；保留占用，等待核对".into())
    })
    .collect()
}

pub(super) fn reserve(directory: &Path, owner: &ReservationOwner) -> Result<Admission, String> {
    // Contention, damaged recovery metadata, or inaccessible Host storage must
    // pause the original prepared action rather than fail or dispatch it.
    Ok(reserve_inner(directory, owner).unwrap_or_else(|_| {
        Admission::Deferred(NativeWorkAdmissionWait {
            reason: "recovery_required".into(),
            message: "本机执行资源登记暂不可核实，保留要求并等待恢复".into(),
        })
    }))
}

fn reserve_inner(directory: &Path, owner: &ReservationOwner) -> Result<Admission, String> {
    let mut connection = open(directory)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let held = owners(&transaction)?;
    let unverified = held.iter().any(|held| held.canonical_workspace.is_empty());
    if !unverified && held.iter().any(|held| held == owner) {
        return Ok(Admission::Granted);
    }
    let recovered: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM native_write_reservations WHERE recovered=1)",
            [],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let conflicting = held
        .iter()
        .find(|held| overlaps(&held.canonical_workspace, &owner.canonical_workspace));
    let conflict_recovered = conflicting
        .map(|held| -> Result<bool, String> {
            transaction
                .query_row(
                    "SELECT recovered=1 FROM native_write_reservations WHERE owner_key=?1",
                    [held.key()?],
                    |row| row.get(0),
                )
                .map_err(|error| error.to_string())
        })
        .transpose()?
        .unwrap_or(false);
    let wait = if unverified {
        Some((
            "recovery_required",
            "本机存在尚未核实的执行归属，核对结束事实后才能开始新工作",
        ))
    } else if conflicting.is_some() {
        Some(if conflict_recovered {
            (
                "recovery_required",
                "原执行的结束事实仍待核对，核对后才能使用这个目录",
            )
        } else {
            (
                "workspace_busy",
                "工作目录仍被另一轮执行占用，释放后会自动继续",
            )
        })
    } else if held.len() >= EXECUTION_SLOTS {
        Some(if recovered {
            (
                "recovery_required",
                "本机执行名额仍被占用，部分原执行的结束事实待核对",
            )
        } else {
            (
                "execution_slots",
                "本机两项工作正在占用执行名额，空闲后会自动继续",
            )
        })
    } else {
        None
    };
    if let Some((reason, message)) = wait {
        return Ok(Admission::Deferred(NativeWorkAdmissionWait {
            reason: reason.into(),
            message: message.into(),
        }));
    }
    let key = owner.key()?;
    transaction
        .execute(
            "INSERT INTO native_write_reservations(owner_key,owner_json) VALUES(?1,?1)",
            [&key],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(Admission::Granted)
}

pub(super) fn accepted(
    directory: &Path,
    owner: &ReservationOwner,
    turn: &str,
) -> Result<(), String> {
    if turn.is_empty() {
        return Err("执行资源缺少原端轮次，保留占用等待核对".into());
    }
    let changed = open(directory)?
        .execute(
            "UPDATE native_write_reservations SET native_turn=?2
             WHERE owner_key=?1 AND (native_turn IS NULL OR native_turn=?2)",
            params![owner.key()?, turn],
        )
        .map_err(|error| error.to_string())?;
    if changed != 1 {
        return Err("执行资源归属或轮次已变化，保留占用等待核对".into());
    }
    Ok(())
}

/// Call only after durable NotSent or an explicit JSON-RPC protocol rejection,
/// before any acceptance. A late rejection cannot release an accepted turn.
pub(super) fn release_not_sent(directory: &Path, owner: &ReservationOwner) -> Result<(), String> {
    open(directory)?
        .execute(
            "DELETE FROM native_write_reservations WHERE owner_key=?1 AND native_turn IS NULL",
            [owner.key()?],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// Both owner identity and the actual native turn are compare-and-swap guards.
/// This is deliberately not a lease timeout: unknown or waiting approvals stay held.
pub(super) fn release_terminal(
    directory: &Path,
    owner: &ReservationOwner,
    turn: &str,
) -> Result<(), String> {
    open(directory)?
        .execute(
            "DELETE FROM native_write_reservations WHERE owner_key=?1 AND native_turn=?2",
            params![owner.key()?, turn],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub(super) fn session_reservations(
    directory: &Path,
    account: &str,
    session: &str,
) -> Result<Vec<ReservationOwner>, String> {
    Ok(owners(&open(directory)?)?
        .into_iter()
        .filter(|owner| owner.account_scope == account && owner.session_id == session)
        .collect())
}

pub(super) fn reserved_turn(
    directory: &Path,
    owner: &ReservationOwner,
) -> Result<Option<String>, String> {
    open(directory)?
        .query_row(
            "SELECT native_turn FROM native_write_reservations WHERE owner_key=?1",
            [owner.key()?],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())
}

impl ReservationOwner {
    pub(super) fn action_id(&self) -> &str {
        &self.action_id
    }
}

fn recover_owner(
    host: &Connection,
    owner: ReservationOwner,
    turn: Option<&str>,
) -> Result<(), String> {
    // A crash between resource reservation and account outbox claim is already
    // covered by the original row. Never replace its generation or connection.
    if owners(host)?.iter().any(|held| held.same_command(&owner)) {
        return Ok(());
    }
    host.execute(
        "INSERT OR IGNORE INTO native_write_reservations(owner_key,owner_json,native_turn,recovered)
         VALUES(?1,?1,?2,1)",
        params![owner.key()?, turn],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn freeze_database(host: &Connection, file: &str) -> Result<(), String> {
    let owner = ReservationOwner {
        action_id: format!("recovery:{file}"),
        request_id: "unverified-database".into(),
        account_scope: String::new(),
        account_generation: 0,
        session_id: file.into(),
        binding_version: 0,
        connection_id: "unverified-recovery".into(),
        canonical_workspace: String::new(),
        native_thread_id: String::new(),
        source_scope: String::new(),
        guard_version: 0,
    };
    // Freezing must not depend on parsing damaged existing ownership rows.
    let key = owner.key()?;
    host.execute("INSERT OR IGNORE INTO native_write_reservations(owner_key,owner_json,recovered) VALUES(?1,?1,1)", [&key])
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn has_table(connection: &Connection, name: &str) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
            [name],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())
}

fn recover_database(host: &Connection, path: &Path) -> Result<(), String> {
    // Never call account selection/migration here: old running owners keep their
    // original database and scope even when the foreground account changes.
    let source = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| error.to_string())?;
    source
        .busy_timeout(Duration::from_secs(5))
        .map_err(|error| error.to_string())?;
    let file = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("unknown");
    if has_table(&source, "dispatch_actions")? {
        let mut statement = source
            .prepare(
                "SELECT id,spec_json,receipt_ref FROM dispatch_actions
                      WHERE idempotency_key LIKE 'native-codex:v1:%'
                      AND state IN('dispatched','acknowledged','verifying_delivery')",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })
            .map_err(|error| error.to_string())?;
        // Prompt owners go first; unresolved steer/interrupt commands on that
        // same session must not count as additional execution slots.
        let mut commands = Vec::new();
        for row in rows {
            let (id, spec, receipt) = row.map_err(|error| error.to_string())?;
            let spec: NativeCommandSpec =
                serde_json::from_str(&spec).map_err(|_| "旧账号有无法核实的原生命令")?;
            spec.validate()?;
            commands.push((id, spec, receipt));
        }
        commands
            .sort_by_key(|(_, spec, _)| !matches!(spec.intent, NativeCodexIntent::Prompt { .. }));
        for (id, spec, receipt) in commands {
            let same_session = owners(host)?.iter().any(|held| {
                held.account_scope == spec.scope.account_scope
                    && held.session_id == spec.binding.session_id
                    && held.binding_version == spec.binding.binding_version
            });
            if same_session && !matches!(spec.intent, NativeCodexIntent::Prompt { .. }) {
                continue;
            }
            let receipt: Option<Value> = receipt
                .as_deref()
                .map(serde_json::from_str)
                .transpose()
                .map_err(|_| "旧账号有无法核实的接收回执")?;
            let turn = receipt
                .as_ref()
                .and_then(|receipt| receipt.get("nativeTurnId"))
                .and_then(Value::as_str)
                .or(spec.expected.native_turn_id.as_deref());
            let owner = ReservationOwner::for_command(&id, &spec, &format!("recovered:{file}"));
            match owner {
                Ok(mut owner) => {
                    // A reconstructed legacy action has no original lifetime
                    // handle; do not manufacture a versioned guard promise.
                    owner.guard_version = 0;
                    recover_owner(host, owner, turn)?;
                }
                Err(_) => freeze_database(host, file)?,
            }
        }
    }
    if has_table(&source, "work_runtime_snapshots")? {
        let mut statement = source
            .prepare("SELECT s.account_scope,s.workspace_root,s.binding_version,r.session_id,r.snapshot_json,
                      s.native_session_id,s.source_scope,COALESCE(s.config_snapshot_json,'{}')
                      FROM work_runtime_snapshots r JOIN work_sessions s ON s.id=r.session_id
                      WHERE s.runtime_owner='native_host'")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                ))
            })
            .map_err(|error| error.to_string())?;
        for row in rows {
            let (account, workspace, binding, session, snapshot, thread, source_scope, config) =
                row.map_err(|error| error.to_string())?;
            let snapshot: Value =
                serde_json::from_str(&snapshot).map_err(|_| "旧账号有无法核实的运行投影")?;
            let active = snapshot.get("activeTurnId").and_then(Value::as_str);
            let status = snapshot.get("runtimeStatus").and_then(Value::as_str);
            if active.is_none() && matches!(status, Some("idle" | "interrupted")) {
                continue;
            }
            if owners(host)?
                .iter()
                .any(|held| held.account_scope == account && held.session_id == session)
            {
                continue;
            }
            if snapshot.get("nativeThreadId").and_then(Value::as_str) != Some(thread.as_str())
                || snapshot.get("sourceScope").and_then(Value::as_str)
                    != Some(source_scope.as_str())
                || snapshot.get("sessionId").and_then(Value::as_str) != Some(session.as_str())
                || snapshot.get("bindingVersion").and_then(Value::as_i64) != Some(binding)
            {
                return Err("旧运行投影缺少可核实的原线程或来源".into());
            }
            let canonical_workspace = canonical_workspace(&workspace).unwrap_or_default();
            let config: Value =
                serde_json::from_str(&config).map_err(|_| "旧账号的运行归属配置无法核实")?;
            let connection_id = snapshot
                .get("connectionId")
                .and_then(Value::as_str)
                .unwrap_or("unverified-recovery");
            let guard_version = if config
                .pointer("/nativeHost/connectionId")
                .and_then(Value::as_str)
                == Some(connection_id)
                && config
                    .pointer("/nativeHost/resourceOwnerGuardVersion")
                    .and_then(Value::as_u64)
                    == Some(1)
            {
                1
            } else {
                0
            };
            recover_owner(
                host,
                ReservationOwner {
                    action_id: format!("snapshot:{file}:{session}"),
                    request_id: "recovered-snapshot".into(),
                    account_scope: account,
                    account_generation: 0,
                    session_id: session,
                    binding_version: binding,
                    connection_id: connection_id.into(),
                    canonical_workspace,
                    native_thread_id: thread,
                    source_scope,
                    guard_version,
                },
                active,
            )?;
        }
    }
    Ok(())
}

/// Union startup recovery into existing reservations. It never deletes a row,
/// infers liveness from a PID, or steals a lease after an elapsed timeout.
pub(super) fn initialize(directory: &Path) -> Result<(), String> {
    let mut host = open(directory)?;
    let transaction = host
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    for entry in std::fs::read_dir(directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name != "butler.db" && !(name.starts_with("butler-") && name.ends_with(".db")) {
            continue;
        }
        if recover_database(&transaction, &path).is_err() {
            freeze_database(&transaction, &name)?;
        }
    }
    transaction.commit().map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{
        path::PathBuf,
        sync::{Arc, Barrier},
    };

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let directory =
                std::env::temp_dir().join(format!("rocketx-admission-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&directory).unwrap();
            for name in ["a", "a/child", "a-other", "b", "c", "d", "e", "f"] {
                std::fs::create_dir_all(directory.join(name)).unwrap();
            }
            initialize(&directory).unwrap();
            Self(directory)
        }

        fn owner(&self, action: &str, workspace: &str) -> ReservationOwner {
            ReservationOwner {
                action_id: action.into(),
                request_id: format!("request-{action}"),
                account_scope: "account-a".into(),
                account_generation: 1,
                session_id: format!("session-{action}"),
                binding_version: 1,
                connection_id: format!("connection-{action}"),
                canonical_workspace: canonical_workspace(self.0.join(workspace).to_str().unwrap())
                    .unwrap(),
                native_thread_id: "fixture-thread".into(),
                source_scope: "fixture-source".into(),
                guard_version: 1,
            }
        }

        fn legacy(&self, file: &str, action: &str, state: &str, workspace: &str) -> Connection {
            let source = Connection::open(self.0.join(file)).unwrap();
            source.execute_batch("CREATE TABLE dispatch_actions(id TEXT,spec_json TEXT,receipt_ref TEXT,idempotency_key TEXT,state TEXT);
                CREATE TABLE database_account_owner(id INTEGER PRIMARY KEY,scope TEXT);
                INSERT INTO database_account_owner VALUES(1,'original-account'); PRAGMA user_version=17;").unwrap();
            let spec = json!({
                "schema":"rocketx.native-codex-command.v1","executor":"native_host",
                "requestId":format!("request-{action}"),"todoId":"work",
                "scope":{"accountScope":"original-account","accountGeneration":3,"hostDeviceId":"device"},
                "binding":{"sessionId":"binding","nativeThreadId":"thread","sourceScope":"codex:fixture",
                    "executionProfileId":"profile","workspaceRoot":self.0.join(workspace).to_str().unwrap(),"bindingVersion":2},
                "expected":{"requirementsVersion":1,"contentVersion":1,"nativeTurnId":null},
                "intent":{"kind":"prompt","text":"fixture only, must not enter Host DB"},"submittedBy":"user"
            });
            source
                .execute(
                    "INSERT INTO dispatch_actions VALUES(?1,?2,?3,?4,?5)",
                    params![
                        action,
                        spec.to_string(),
                        json!({"nativeThreadId":"thread","nativeTurnId":"original-turn"})
                            .to_string(),
                        format!("native-codex:v1:request-{action}"),
                        state
                    ],
                )
                .unwrap();
            source
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let directory = std::fs::canonicalize(&self.0).unwrap();
            let temporary = std::fs::canonicalize(std::env::temp_dir()).unwrap();
            assert_eq!(directory.parent(), Some(temporary.as_path()));
            assert!(directory
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("rocketx-admission-"));
            std::fs::remove_dir_all(directory).unwrap();
        }
    }

    fn deferred(admission: Admission, expected: &str) {
        match admission {
            Admission::Deferred(wait) => assert_eq!(wait.reason, expected),
            Admission::Granted => panic!("expected deferred admission"),
        }
    }

    #[test]
    fn native_admission_two_independent_directories_run_and_third_waits() {
        let fixture = Fixture::new();
        assert!(matches!(
            reserve(&fixture.0, &fixture.owner("one", "a")).unwrap(),
            Admission::Granted
        ));
        assert!(matches!(
            reserve(&fixture.0, &fixture.owner("two", "b")).unwrap(),
            Admission::Granted
        ));
        deferred(
            reserve(&fixture.0, &fixture.owner("three", "c")).unwrap(),
            "execution_slots",
        );
        assert_eq!(owners(&open(&fixture.0).unwrap()).unwrap().len(), 2);
    }

    #[test]
    fn native_admission_same_parent_child_exclude_writes_but_siblings_do_not() {
        let fixture = Fixture::new();
        let parent = fixture.owner("parent", "a");
        assert!(matches!(
            reserve(&fixture.0, &parent).unwrap(),
            Admission::Granted
        ));
        deferred(
            reserve(&fixture.0, &fixture.owner("same", "a")).unwrap(),
            "workspace_busy",
        );
        deferred(
            reserve(&fixture.0, &fixture.owner("child", "a/child")).unwrap(),
            "workspace_busy",
        );
        assert!(matches!(
            reserve(&fixture.0, &fixture.owner("sibling", "a-other")).unwrap(),
            Admission::Granted
        ));
        release_not_sent(&fixture.0, &parent).unwrap();
        assert!(matches!(
            reserve(&fixture.0, &fixture.owner("child", "a/child")).unwrap(),
            Admission::Granted
        ));
        deferred(reserve(&fixture.0, &parent).unwrap(), "workspace_busy");
    }

    #[test]
    fn native_admission_account_switch_does_not_release_other_account() {
        let fixture = Fixture::new();
        let a = fixture.owner("one", "a");
        reserve(&fixture.0, &a).unwrap();
        let mut b = fixture.owner("two", "a");
        b.account_scope = "account-b".into();
        b.account_generation = 9;
        deferred(reserve(&fixture.0, &b).unwrap(), "workspace_busy");
        release_not_sent(&fixture.0, &b).unwrap();
        deferred(reserve(&fixture.0, &b).unwrap(), "workspace_busy");
        assert_eq!(owners(&open(&fixture.0).unwrap()).unwrap(), vec![a]);
    }

    #[test]
    fn native_admission_old_generation_or_turn_cannot_release_new_owner() {
        let fixture = Fixture::new();
        let mut current = fixture.owner("same-action", "a");
        current.account_generation = 4;
        reserve(&fixture.0, &current).unwrap();
        accepted(&fixture.0, &current, "current-turn").unwrap();
        let mut old = current.clone();
        old.account_generation = 3;
        release_terminal(&fixture.0, &old, "current-turn").unwrap();
        release_terminal(&fixture.0, &current, "old-turn").unwrap();
        release_not_sent(&fixture.0, &current).unwrap();
        deferred(
            reserve(&fixture.0, &fixture.owner("next", "a")).unwrap(),
            "workspace_busy",
        );
        release_terminal(&fixture.0, &current, "current-turn").unwrap();
        assert!(matches!(
            reserve(&fixture.0, &fixture.owner("next", "a")).unwrap(),
            Admission::Granted
        ));
    }

    #[test]
    fn native_admission_confirmed_not_sent_releases_only_unaccepted_owner() {
        let fixture = Fixture::new();
        let owner = fixture.owner("one", "a");
        reserve(&fixture.0, &owner).unwrap();
        release_not_sent(&fixture.0, &owner).unwrap();
        assert!(owners(&open(&fixture.0).unwrap()).unwrap().is_empty());
        reserve(&fixture.0, &owner).unwrap();
        accepted(&fixture.0, &owner, "turn").unwrap();
        release_not_sent(&fixture.0, &owner).unwrap();
        assert_eq!(owners(&open(&fixture.0).unwrap()).unwrap(), vec![owner]);
    }

    #[test]
    fn native_admission_unknown_and_approval_wait_hold_resources_across_reopen() {
        let fixture = Fixture::new();
        let owner = fixture.owner("one", "a");
        reserve(&fixture.0, &owner).unwrap();
        accepted(&fixture.0, &owner, "turn-waiting-approval").unwrap();
        // Neither acceptance, disconnection, nor merely reopening Host storage
        // proves terminal ownership. There is intentionally no TTL/PID release.
        initialize(&fixture.0).unwrap();
        deferred(
            reserve(&fixture.0, &fixture.owner("other", "a")).unwrap(),
            "workspace_busy",
        );
        assert_eq!(owners(&open(&fixture.0).unwrap()).unwrap(), vec![owner]);
    }

    #[test]
    fn native_admission_restart_keeps_reservation_before_outbox_claim() {
        let fixture = Fixture::new();
        let owner = fixture.owner("reserved-before-crash", "a");
        reserve(&fixture.0, &owner).unwrap();
        initialize(&fixture.0).unwrap();
        assert!(matches!(
            reserve(&fixture.0, &owner).unwrap(),
            Admission::Granted
        ));
        let mut rebound = owner.clone();
        rebound.connection_id = "new-connection".into();
        deferred(reserve(&fixture.0, &rebound).unwrap(), "workspace_busy");
    }

    #[test]
    fn native_admission_restart_recovers_old_native_actions_readonly_across_accounts() {
        let fixture = Fixture::new();
        let a = fixture.legacy("butler.db", "old-a", "verifying_delivery", "a");
        let b = fixture.legacy("butler-other.db", "old-b", "acknowledged", "b");
        initialize(&fixture.0).unwrap();
        initialize(&fixture.0).unwrap();
        deferred(
            reserve(&fixture.0, &fixture.owner("third", "c")).unwrap(),
            "recovery_required",
        );
        assert_eq!(owners(&open(&fixture.0).unwrap()).unwrap().len(), 2);
        for source in [&a, &b] {
            assert_eq!(
                source
                    .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                    .unwrap(),
                17
            );
            assert_eq!(
                source
                    .query_row("SELECT scope FROM database_account_owner", [], |row| row
                        .get::<_, String>(
                        0
                    ))
                    .unwrap(),
                "original-account"
            );
        }
        let host = open(&fixture.0).unwrap();
        let payload: String = host
            .query_row(
                "SELECT group_concat(owner_json) FROM native_write_reservations",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!payload.contains("fixture only"));
    }

    #[test]
    fn native_admission_unreadable_old_database_or_invalid_workspace_freezes_new_writes() {
        let fixture = Fixture::new();
        std::fs::write(
            fixture.0.join("butler-corrupt.db"),
            b"not a sqlite database",
        )
        .unwrap();
        initialize(&fixture.0).unwrap();
        deferred(
            reserve(&fixture.0, &fixture.owner("next", "a")).unwrap(),
            "recovery_required",
        );
        let other = Fixture::new();
        let source = other.legacy("butler.db", "missing-cwd", "dispatched", "absent");
        drop(source);
        initialize(&other.0).unwrap();
        deferred(
            reserve(&other.0, &other.owner("next", "a")).unwrap(),
            "recovery_required",
        );
    }

    #[test]
    fn native_admission_restart_recovers_approval_snapshot_without_action_and_keeps_it_frozen() {
        let fixture = Fixture::new();
        let source = Connection::open(fixture.0.join("butler-snapshot.db")).unwrap();
        source.execute_batch("CREATE TABLE work_sessions(id TEXT,account_scope TEXT,workspace_root TEXT,binding_version INTEGER,runtime_owner TEXT,native_session_id TEXT,source_scope TEXT,config_snapshot_json TEXT);
            CREATE TABLE work_runtime_snapshots(session_id TEXT,snapshot_json TEXT);").unwrap();
        source
            .execute(
                "INSERT INTO work_sessions VALUES('old-session','old-account',?1,7,'native_host','old-thread','old-source','{}')",
                [fixture.0.join("a").to_str().unwrap()],
            )
            .unwrap();
        source.execute("INSERT INTO work_runtime_snapshots VALUES('old-session',?1)",
            [json!({"activeTurnId":"old-turn","runtimeStatus":"waiting_approval","connectionId":"old-connection","nativeThreadId":"old-thread","sourceScope":"old-source","sessionId":"old-session","bindingVersion":7}).to_string()]).unwrap();
        initialize(&fixture.0).unwrap();
        initialize(&fixture.0).unwrap();
        deferred(
            reserve(&fixture.0, &fixture.owner("same", "a")).unwrap(),
            "recovery_required",
        );
        assert!(matches!(
            reserve(&fixture.0, &fixture.owner("independent", "b")).unwrap(),
            Admission::Granted
        ));
        assert_eq!(owners(&open(&fixture.0).unwrap()).unwrap().len(), 2);
        assert_eq!(source.query_row("SELECT json_extract(snapshot_json,'$.runtimeStatus') FROM work_runtime_snapshots", [], |row| row.get::<_, String>(0)).unwrap(), "waiting_approval");
    }

    #[test]
    fn native_admission_invalid_host_metadata_defers_without_deleting_or_replacing_owner() {
        let fixture = Fixture::new();
        let host = open(&fixture.0).unwrap();
        host.execute("INSERT INTO native_write_reservations(owner_key,owner_json) VALUES('broken','invalid-json')", []).unwrap();
        let source = fixture.legacy("butler.db", "old-action", "dispatched", "a");
        initialize(&fixture.0).unwrap();
        drop(source);
        deferred(
            reserve(&fixture.0, &fixture.owner("next", "a")).unwrap(),
            "recovery_required",
        );
        assert_eq!(
            host.query_row(
                "SELECT owner_json FROM native_write_reservations WHERE owner_key='broken'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
            "invalid-json"
        );
    }

    #[test]
    fn native_admission_recovery_requires_original_versioned_lifetime_handle_and_marker() {
        let fixture = Fixture::new();
        let owner = fixture.owner("one", "a");
        let guard = connection_guard(&fixture.0, &owner.connection_id).unwrap();
        assert!(recovery_guard(&fixture.0, &owner).is_err());
        drop(guard);
        let recovered = recovery_guard(&fixture.0, &owner).unwrap().unwrap();
        drop(recovered);
        let mut legacy = owner.clone();
        legacy.guard_version = 0;
        assert!(recovery_guard(&fixture.0, &legacy).unwrap().is_none());
        let mut missing = owner.clone();
        missing.connection_id = "never-had-a-handle".into();
        assert!(recovery_guard(&fixture.0, &missing).is_err());
        assert!(!guard_path(&fixture.0, &missing.connection_id).exists());
        std::fs::write(
            guard_path(&fixture.0, &owner.connection_id),
            b"wrong-marker",
        )
        .unwrap();
        assert!(recovery_guard(&fixture.0, &owner).is_err());
    }

    #[test]
    fn native_admission_recovered_action_can_release_only_matching_original_identity_and_turn() {
        let fixture = Fixture::new();
        let source = fixture.legacy("butler.db", "old-action", "acknowledged", "a");
        initialize(&fixture.0).unwrap();
        let recovered = session_reservations(&fixture.0, "original-account", "binding").unwrap();
        assert_eq!(recovered.len(), 1);
        let spec: NativeCommandSpec = source
            .query_row("SELECT spec_json FROM dispatch_actions", [], |row| {
                row.get::<_, String>(0)
            })
            .map(|json| serde_json::from_str(&json).unwrap())
            .unwrap();
        assert!(recovered[0].matches_command("old-action", &spec));
        let mut new_generation = spec.clone();
        new_generation.scope.account_generation += 1;
        assert!(!recovered[0].matches_command("old-action", &new_generation));
        assert!(accepted(&fixture.0, &recovered[0], "different-turn").is_err());
        release_terminal(&fixture.0, &recovered[0], "different-turn").unwrap();
        assert_eq!(owners(&open(&fixture.0).unwrap()).unwrap().len(), 1);
        release_terminal(&fixture.0, &recovered[0], "original-turn").unwrap();
        assert!(owners(&open(&fixture.0).unwrap()).unwrap().is_empty());
    }

    #[test]
    fn native_admission_independent_connections_never_exceed_two_slots() {
        let fixture = Fixture::new();
        let barrier = Arc::new(Barrier::new(6));
        let mut threads = Vec::new();
        for (index, workspace) in ["a", "b", "c", "d", "e", "f"].iter().enumerate() {
            let owner = fixture.owner(&index.to_string(), workspace);
            let directory = fixture.0.clone();
            let barrier = Arc::clone(&barrier);
            threads.push(std::thread::spawn(move || {
                barrier.wait();
                matches!(reserve(&directory, &owner).unwrap(), Admission::Granted)
            }));
        }
        let admitted = threads
            .into_iter()
            .filter_map(|thread| thread.join().unwrap().then_some(()))
            .count();
        assert_eq!(admitted, 2);
        assert_eq!(owners(&open(&fixture.0).unwrap()).unwrap().len(), 2);
    }

    #[cfg(windows)]
    #[test]
    fn native_admission_windows_case_and_real_junction_share_canonical_resource() {
        use std::os::windows::process::CommandExt;
        let fixture = Fixture::new();
        let original = fixture.0.join("a");
        let alias = fixture.0.join("junction-alias");
        let result = std::process::Command::new("cmd.exe")
            .args(["/c", "mklink", "/J"])
            .arg(&alias)
            .arg(&original)
            .creation_flags(0x08000000)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "junction fixture could not be created"
        );
        assert_eq!(
            canonical_workspace(alias.to_str().unwrap()).unwrap(),
            canonical_workspace(original.to_str().unwrap()).unwrap()
        );
        assert_eq!(
            canonical_workspace(&original.to_str().unwrap().to_uppercase()).unwrap(),
            canonical_workspace(original.to_str().unwrap()).unwrap()
        );
        reserve(&fixture.0, &fixture.owner("original", "a")).unwrap();
        deferred(
            reserve(&fixture.0, &fixture.owner("alias", "junction-alias")).unwrap(),
            "workspace_busy",
        );
        std::fs::remove_dir(&alias).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn native_admission_real_symlink_alias_shares_canonical_resource() {
        let fixture = Fixture::new();
        std::os::unix::fs::symlink(fixture.0.join("a"), fixture.0.join("symlink-alias")).unwrap();
        reserve(&fixture.0, &fixture.owner("original", "a")).unwrap();
        deferred(
            reserve(&fixture.0, &fixture.owner("alias", "symlink-alias")).unwrap(),
            "workspace_busy",
        );
    }
}
