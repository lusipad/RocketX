use rusqlite::{params, params_from_iter, types::Value, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::{now_millis, run_db, ButlerDb};

const SCHEMA_MEMORY_TABLES: &str = "
    CREATE TABLE IF NOT EXISTS butler_memories (
        id TEXT PRIMARY KEY,
        account_scope TEXT NOT NULL,
        category TEXT NOT NULL CHECK (category IN (
            'preference',
            'project_fact',
            'workflow_habit',
            'person_context',
            'episodic_summary'
        )),
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        tags_json TEXT NOT NULL DEFAULT '[]',
        workspace_root TEXT,
        source_kind TEXT NOT NULL DEFAULT 'manual' CHECK (source_kind IN (
            'manual',
            'conversation',
            'workflow_report',
            'assistant_review'
        )),
        source_ref TEXT,
        pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
        confidence REAL NOT NULL DEFAULT 1.0,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        recall_count INTEGER NOT NULL DEFAULT 0 CHECK (recall_count >= 0),
        last_recalled_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_butler_memories_scope
        ON butler_memories(account_scope, enabled, pinned DESC, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_butler_memories_workspace
        ON butler_memories(account_scope, workspace_root);

    CREATE TABLE IF NOT EXISTS butler_assistant_digests (
        id TEXT PRIMARY KEY,
        account_scope TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN (
            'morning_brief',
            'evening_review',
            'workflow_report',
            'focus_digest'
        )),
        date_key TEXT NOT NULL,
        title TEXT NOT NULL,
        summary_md TEXT NOT NULL,
        metrics_json TEXT NOT NULL DEFAULT '{}',
        action_items_json TEXT NOT NULL DEFAULT '[]',
        related_todo_id TEXT,
        related_session_id TEXT,
        created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_butler_digests_scope
        ON butler_assistant_digests(account_scope, kind, created_at DESC);
";

const MEMORY_COLUMNS: &str = "id, account_scope, category, title, content, tags_json, workspace_root, source_kind, source_ref, pinned, confidence, enabled, recall_count, last_recalled_at, created_at, updated_at, superseded_by, expires_at";
const DIGEST_COLUMNS: &str = "id, account_scope, kind, date_key, title, summary_md, metrics_json, action_items_json, related_todo_id, related_session_id, created_at";

pub(crate) fn migrate_memory(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(SCHEMA_MEMORY_TABLES)
        .map_err(|error| format!("无法初始化管家长期记忆表：{error}"))?;
    let mut stmt = connection
        .prepare("PRAGMA table_info(butler_memories)")
        .map_err(|e| e.to_string())?;
    let columns = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    for (column, sql) in [
        (
            "superseded_by",
            "ALTER TABLE butler_memories ADD COLUMN superseded_by TEXT",
        ),
        (
            "expires_at",
            "ALTER TABLE butler_memories ADD COLUMN expires_at INTEGER",
        ),
    ] {
        if !columns.iter().any(|c| c == column) {
            connection.execute(sql, []).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ButlerMemoryEntry {
    pub id: String,
    pub account_scope: String,
    pub category: String,
    pub title: String,
    pub content: String,
    pub tags: Vec<String>,
    pub workspace_root: Option<String>,
    pub source_kind: String,
    pub source_ref: Option<String>,
    pub pinned: bool,
    pub confidence: f64,
    pub enabled: bool,
    pub recall_count: i64,
    pub last_recalled_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
    pub superseded_by: Option<String>,
    pub expires_at: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ButlerMemoryUpsertInput {
    pub id: Option<String>,
    pub account_scope: String,
    pub category: String,
    pub title: String,
    pub content: String,
    pub tags: Option<Vec<String>>,
    pub workspace_root: Option<String>,
    pub source_kind: Option<String>,
    pub source_ref: Option<String>,
    pub pinned: Option<bool>,
    pub confidence: Option<f64>,
    pub enabled: Option<bool>,
    pub supersedes_id: Option<String>,
    pub expires_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ButlerAssistantDigest {
    pub id: String,
    pub account_scope: String,
    pub kind: String,
    pub date_key: String,
    pub title: String,
    pub summary_md: String,
    pub metrics_json: String,
    pub action_items_json: String,
    pub related_todo_id: Option<String>,
    pub related_session_id: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ButlerAssistantDigestInput {
    pub id: Option<String>,
    pub account_scope: String,
    pub kind: String,
    pub date_key: String,
    pub title: String,
    pub summary_md: String,
    pub metrics_json: Option<String>,
    pub action_items_json: Option<String>,
    pub related_todo_id: Option<String>,
    pub related_session_id: Option<String>,
}

fn is_token_boundary(prev: Option<u8>) -> bool {
    match prev {
        None => true,
        Some(b) => !(b.is_ascii_alphanumeric() || b == b'_'),
    }
}

fn has_prefixed_secret(
    text: &str,
    prefix: &str,
    min_tail_len: usize,
    is_valid_char: fn(u8) -> bool,
) -> bool {
    let bytes = text.as_bytes();
    let prefix_bytes = prefix.as_bytes();
    if bytes.len() < prefix_bytes.len() + min_tail_len {
        return false;
    }
    let mut i = 0;
    while i + prefix_bytes.len() + min_tail_len <= bytes.len() {
        let prev = if i == 0 { None } else { Some(bytes[i - 1]) };
        if is_token_boundary(prev) && &bytes[i..i + prefix_bytes.len()] == prefix_bytes {
            let tail = &bytes[i + prefix_bytes.len()..];
            let count = tail.iter().take_while(|&&b| is_valid_char(b)).count();
            if count >= min_tail_len {
                return true;
            }
        }
        i += 1;
    }
    false
}

fn is_token_char_dash(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'-'
}

fn is_token_char_underscore(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

fn is_aws_key_char(b: u8) -> bool {
    b.is_ascii_uppercase() || b.is_ascii_digit()
}

fn is_bearer_token_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'~' | b'+' | b'/' | b'-' | b'=')
}

pub fn contains_sensitive_secret(text: &str) -> bool {
    if text.trim().is_empty() {
        return false;
    }
    if text.contains("PRIVATE KEY") || text.to_ascii_uppercase().contains("-----BEGIN PRIVATE KEY")
    {
        return true;
    }
    if has_prefixed_secret(text, "sk-", 10, is_token_char_dash)
        || has_prefixed_secret(text, "ghp_", 10, is_token_char_underscore)
        || has_prefixed_secret(text, "gho_", 10, is_token_char_underscore)
        || has_prefixed_secret(text, "ghu_", 10, is_token_char_underscore)
        || has_prefixed_secret(text, "ghs_", 10, is_token_char_underscore)
        || has_prefixed_secret(text, "ghr_", 10, is_token_char_underscore)
        || has_prefixed_secret(text, "github_pat_", 10, is_token_char_underscore)
        || has_prefixed_secret(text, "glpat-", 10, is_token_char_dash)
        || has_prefixed_secret(text, "xoxb-", 10, is_token_char_dash)
        || has_prefixed_secret(text, "xoxp-", 10, is_token_char_dash)
        || has_prefixed_secret(text, "xoxa-", 10, is_token_char_dash)
        || has_prefixed_secret(text, "xoxr-", 10, is_token_char_dash)
        || has_prefixed_secret(text, "npm_", 12, is_token_char_underscore)
        || has_prefixed_secret(text, "AKIA", 16, is_aws_key_char)
        || has_prefixed_secret(text, "AIza", 20, is_token_char_dash)
    {
        return true;
    }

    // Check case-insensitive "Bearer <token>" with at least 10 token characters.
    let lower = text.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let needle = b"bearer ";
    let mut idx = 0;
    while idx + needle.len() + 10 <= bytes.len() {
        let prev = if idx == 0 { None } else { Some(bytes[idx - 1]) };
        if is_token_boundary(prev) && &bytes[idx..idx + needle.len()] == needle {
            let mut cursor = idx + needle.len();
            while cursor < bytes.len() && bytes[cursor] == b' ' {
                cursor += 1;
            }
            let count = bytes[cursor..]
                .iter()
                .take_while(|&&b| is_bearer_token_char(b))
                .count();
            if count >= 10 {
                return true;
            }
        }
        idx += 1;
    }

    false
}

pub(crate) fn validate_account_scope(scope: &str) -> Result<String, String> {
    let trimmed = scope.trim();
    if trimmed.is_empty() {
        return Err("accountScope 不能为空".to_string());
    }
    Ok(trimmed.to_string())
}

fn validate_memory_category(category: &str) -> Result<(), String> {
    if matches!(
        category,
        "preference" | "project_fact" | "workflow_habit" | "person_context" | "episodic_summary"
    ) {
        Ok(())
    } else {
        Err("无效的长期记忆分类".to_string())
    }
}

fn validate_memory_source_kind(source_kind: &str) -> Result<(), String> {
    if matches!(
        source_kind,
        "manual" | "conversation" | "workflow_report" | "assistant_review"
    ) {
        Ok(())
    } else {
        Err("无效的记忆来源类型".to_string())
    }
}

fn validate_digest_kind(kind: &str) -> Result<(), String> {
    if matches!(
        kind,
        "morning_brief" | "evening_review" | "workflow_report" | "focus_digest"
    ) {
        Ok(())
    } else {
        Err("无效的助理摘要类型".to_string())
    }
}

fn escape_like_pattern(raw: &str) -> String {
    let mut escaped = String::with_capacity(raw.len());
    for ch in raw.chars() {
        match ch {
            '\\' | '%' | '_' => {
                escaped.push('\\');
                escaped.push(ch);
            }
            _ => escaped.push(ch),
        }
    }
    escaped
}

fn normalize_optional_trimmed(value: Option<String>) -> Option<String> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
}

fn row_to_memory(row: &rusqlite::Row<'_>) -> rusqlite::Result<ButlerMemoryEntry> {
    let tags_raw: String = row.get(5)?;
    let tags = serde_json::from_str::<Vec<String>>(&tags_raw).unwrap_or_default();
    Ok(ButlerMemoryEntry {
        id: row.get(0)?,
        account_scope: row.get(1)?,
        category: row.get(2)?,
        title: row.get(3)?,
        content: row.get(4)?,
        tags,
        workspace_root: row.get(6)?,
        source_kind: row.get(7)?,
        source_ref: row.get(8)?,
        pinned: row.get::<_, i64>(9)? != 0,
        confidence: row.get(10)?,
        enabled: row.get::<_, i64>(11)? != 0,
        recall_count: row.get(12)?,
        last_recalled_at: row.get(13)?,
        created_at: row.get(14)?,
        updated_at: row.get(15)?,
        superseded_by: row.get(16)?,
        expires_at: row.get(17)?,
    })
}

fn row_to_digest(row: &rusqlite::Row<'_>) -> rusqlite::Result<ButlerAssistantDigest> {
    Ok(ButlerAssistantDigest {
        id: row.get(0)?,
        account_scope: row.get(1)?,
        kind: row.get(2)?,
        date_key: row.get(3)?,
        title: row.get(4)?,
        summary_md: row.get(5)?,
        metrics_json: row.get(6)?,
        action_items_json: row.get(7)?,
        related_todo_id: row.get(8)?,
        related_session_id: row.get(9)?,
        created_at: row.get(10)?,
    })
}

pub(crate) fn list_memories(
    connection: &Connection,
    account_scope: &str,
    category: Option<String>,
    workspace_root: Option<String>,
    query: Option<String>,
    enabled_only: Option<bool>,
) -> Result<Vec<ButlerMemoryEntry>, String> {
    let scope = validate_account_scope(&account_scope)?;
    let mut conditions = vec!["account_scope = ?".to_string()];
    let mut values = vec![Value::Text(scope)];

    if let Some(cat) = normalize_optional_trimmed(category) {
        validate_memory_category(&cat)?;
        conditions.push("category = ?".to_string());
        values.push(Value::Text(cat));
    }
    if let Some(ws) = normalize_optional_trimmed(workspace_root) {
        conditions.push("workspace_root = ?".to_string());
        values.push(Value::Text(ws));
    }
    if enabled_only.unwrap_or(false) {
        conditions.push(
            "enabled = 1 AND superseded_by IS NULL AND (expires_at IS NULL OR expires_at > ?)"
                .to_string(),
        );
        values.push(Value::Integer(now_millis()));
    }
    if let Some(q) = normalize_optional_trimmed(query) {
        let pattern = format!("%{}%", escape_like_pattern(&q.to_lowercase()));
        conditions.push(
            "(LOWER(title) LIKE ? ESCAPE '\\' OR LOWER(content) LIKE ? ESCAPE '\\' OR LOWER(tags_json) LIKE ? ESCAPE '\\')"
                .to_string(),
        );
        values.push(Value::Text(pattern.clone()));
        values.push(Value::Text(pattern.clone()));
        values.push(Value::Text(pattern));
    }

    let sql = format!(
        "SELECT {MEMORY_COLUMNS} FROM butler_memories WHERE {} ORDER BY pinned DESC, updated_at DESC, created_at DESC",
        conditions.join(" AND ")
    );
    let mut stmt = connection
        .prepare(&sql)
        .map_err(|error| format!("无法准备长期记忆查询：{error}"))?;
    let rows = stmt
        .query_map(params_from_iter(values.iter()), row_to_memory)
        .map_err(|error| format!("无法查询长期记忆列表：{error}"))?;
    rows.map(|row| row.map_err(|error| format!("无法读取长期记忆记录：{error}")))
        .collect()
}

pub(crate) fn upsert_memory(
    connection: &Connection,
    input: ButlerMemoryUpsertInput,
) -> Result<ButlerMemoryEntry, String> {
    let tx = connection
        .unchecked_transaction()
        .map_err(|e| e.to_string())?;
    let supersedes_id = normalize_optional_trimmed(input.supersedes_id.clone());
    if let Some(ref old_id) = supersedes_id {
        if input.id.as_ref() == Some(old_id) {
            return Err("纠正必须创建新的记忆版本".to_string());
        }
        let scope = validate_account_scope(&input.account_scope)?;
        let eligible: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM butler_memories WHERE id = ?1 AND account_scope = ?2 AND superseded_by IS NULL)",
            params![old_id, scope], |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        if !eligible {
            return Err("待纠正记忆不存在、已纠正或账号不匹配".to_string());
        }
    }
    let entry = upsert_memory_inner(&tx, input)?;
    if let Some(old_id) = supersedes_id {
        tx.execute("UPDATE butler_memories SET enabled = 0, superseded_by = ?1, updated_at = ?2 WHERE id = ?3 AND account_scope = ?4", params![entry.id, entry.updated_at, old_id, entry.account_scope]).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(entry)
}

fn upsert_memory_inner(
    connection: &Connection,
    input: ButlerMemoryUpsertInput,
) -> Result<ButlerMemoryEntry, String> {
    let scope = validate_account_scope(&input.account_scope)?;
    let category = input.category.trim().to_string();
    validate_memory_category(&category)?;

    let title = input.title.trim().to_string();
    if title.is_empty() {
        return Err("记忆标题不能为空".to_string());
    }
    let content = input.content.trim().to_string();
    if content.is_empty() {
        return Err("记忆内容不能为空".to_string());
    }

    let tags = input
        .tags
        .unwrap_or_default()
        .into_iter()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .collect::<Vec<_>>();

    if contains_sensitive_secret(&title)
        || contains_sensitive_secret(&content)
        || tags.iter().any(|t| contains_sensitive_secret(t))
    {
        return Err(
            "记忆内容包含敏感密钥或凭据（如 API Key、Token 或私钥），已拦截保存".to_string(),
        );
    }

    let source_kind = input
        .source_kind
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or("manual")
        .to_string();
    validate_memory_source_kind(&source_kind)?;

    let workspace_root = normalize_optional_trimmed(input.workspace_root);
    let source_ref = normalize_optional_trimmed(input.source_ref);
    let tags_json =
        serde_json::to_string(&tags).map_err(|error| format!("无法序列化记忆标签：{error}"))?;
    let now = now_millis();

    let requested_id = normalize_optional_trimmed(input.id);
    if let Some(ref id) = requested_id {
        let existing = connection
            .query_row(
                &format!("SELECT {MEMORY_COLUMNS} FROM butler_memories WHERE id = ?1"),
                params![id],
                row_to_memory,
            )
            .optional()
            .map_err(|error| format!("无法检查已有长期记忆：{error}"))?;
        if let Some(current) = existing {
            if current.account_scope != scope {
                return Err("账号作用域不匹配，禁止跨作用域修改记忆".to_string());
            }
            if current.superseded_by.is_some() {
                return Err("记忆已纠正，请修改当前有效版本".to_string());
            }
            let pinned = input.pinned.unwrap_or(current.pinned);
            let enabled = input.enabled.unwrap_or(current.enabled);
            let confidence = input
                .confidence
                .unwrap_or(current.confidence)
                .clamp(0.0, 1.0);
            connection
                .execute(
                    "UPDATE butler_memories SET
                        category = ?2, title = ?3, content = ?4, tags_json = ?5,
                        workspace_root = ?6, source_kind = ?7, source_ref = ?8,
                        pinned = ?9, confidence = ?10, enabled = ?11, updated_at = ?12, expires_at = ?14
                     WHERE id = ?1 AND account_scope = ?13",
                    params![
                        id,
                        category,
                        title,
                        content,
                        tags_json,
                        workspace_root,
                        source_kind,
                        source_ref,
                        i64::from(pinned),
                        confidence,
                        i64::from(enabled),
                        now,
                        scope,
                        input.expires_at.or(current.expires_at),
                    ],
                )
                .map_err(|error| format!("无法更新长期记忆：{error}"))?;
            return Ok(ButlerMemoryEntry {
                id: id.clone(),
                account_scope: scope,
                category,
                title,
                content,
                tags,
                workspace_root,
                source_kind,
                source_ref,
                pinned,
                confidence,
                enabled,
                recall_count: current.recall_count,
                last_recalled_at: current.last_recalled_at,
                created_at: current.created_at,
                updated_at: now,
                superseded_by: None,
                expires_at: input.expires_at.or(current.expires_at),
            });
        }
    }

    let entry = ButlerMemoryEntry {
        id: requested_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        account_scope: scope,
        category,
        title,
        content,
        tags,
        workspace_root,
        source_kind: source_kind.clone(),
        source_ref,
        pinned: input.pinned.unwrap_or(false),
        confidence: if source_kind == "workflow_report" {
            input.confidence.unwrap_or(0.5).clamp(0.0, 0.5)
        } else {
            input.confidence.unwrap_or(1.0).clamp(0.0, 1.0)
        },
        enabled: source_kind != "workflow_report" && input.enabled.unwrap_or(true),
        recall_count: 0,
        last_recalled_at: None,
        created_at: now,
        updated_at: now,
        superseded_by: None,
        expires_at: input.expires_at,
    };

    connection
        .execute(
            "INSERT INTO butler_memories (
                id, account_scope, category, title, content, tags_json,
                workspace_root, source_kind, source_ref, pinned, confidence,
                enabled, recall_count, last_recalled_at, created_at, updated_at, superseded_by, expires_at
             ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6,
                ?7, ?8, ?9, ?10, ?11,
                ?12, ?13, ?14, ?15, ?16, ?17, ?18
             )",
            params![
                entry.id,
                entry.account_scope,
                entry.category,
                entry.title,
                entry.content,
                tags_json,
                entry.workspace_root,
                entry.source_kind,
                entry.source_ref,
                i64::from(entry.pinned),
                entry.confidence,
                i64::from(entry.enabled),
                entry.recall_count,
                entry.last_recalled_at,
                entry.created_at,
                entry.updated_at,
                entry.superseded_by,
                entry.expires_at,
            ],
        )
        .map_err(|error| format!("无法保存长期记忆：{error}"))?;

    Ok(entry)
}

pub(crate) fn delete_memory(
    connection: &Connection,
    id: &str,
    account_scope: &str,
) -> Result<bool, String> {
    let trimmed = id.trim();
    if trimmed.is_empty() {
        return Ok(false);
    }
    let scope = validate_account_scope(account_scope)?;
    let changed = connection
        .execute(
            "DELETE FROM butler_memories WHERE id = ?1 AND account_scope = ?2",
            params![trimmed, scope],
        )
        .map_err(|error| format!("无法删除长期记忆：{error}"))?;
    Ok(changed > 0)
}

pub(crate) fn mark_memories_recalled(
    connection: &mut Connection,
    ids: Vec<String>,
    account_scope: &str,
) -> Result<u64, String> {
    let scope = validate_account_scope(account_scope)?;
    let mut unique = Vec::new();
    for raw in ids {
        let trimmed = raw.trim();
        if !trimmed.is_empty() && !unique.iter().any(|existing: &String| existing == trimmed) {
            unique.push(trimmed.to_string());
        }
    }
    if unique.is_empty() {
        return Ok(0);
    }
    let now = now_millis();
    let tx = connection
        .transaction()
        .map_err(|error| format!("无法开始记忆召回更新事务：{error}"))?;
    let mut updated = 0u64;
    for id in unique {
        let changed = tx
            .execute(
                "UPDATE butler_memories
                 SET recall_count = recall_count + 1, last_recalled_at = ?2
                 WHERE id = ?1 AND account_scope = ?3",
                params![id, now, scope],
            )
            .map_err(|error| format!("无法更新记忆召回次数：{error}"))?;
        updated += changed as u64;
    }
    tx.commit()
        .map_err(|error| format!("无法提交记忆召回更新事务：{error}"))?;
    Ok(updated)
}

pub(crate) fn clear_memory_scope(
    connection: &Connection,
    account_scope: &str,
) -> Result<u64, String> {
    let scope = validate_account_scope(account_scope)?;
    let changed = connection
        .execute(
            "DELETE FROM butler_memories WHERE account_scope = ?1",
            params![scope],
        )
        .map_err(|error| format!("无法清空作用域长期记忆：{error}"))?;
    Ok(changed as u64)
}

pub(crate) fn list_assistant_digests(
    connection: &Connection,
    account_scope: &str,
    kind: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<ButlerAssistantDigest>, String> {
    let scope = validate_account_scope(account_scope)?;
    let mut conditions = vec!["account_scope = ?".to_string()];
    let mut values = vec![Value::Text(scope)];

    if let Some(k) = normalize_optional_trimmed(kind) {
        validate_digest_kind(&k)?;
        conditions.push("kind = ?".to_string());
        values.push(Value::Text(k));
    }

    let mut sql = format!(
        "SELECT {DIGEST_COLUMNS} FROM butler_assistant_digests WHERE {} ORDER BY created_at DESC",
        conditions.join(" AND ")
    );
    if let Some(lim) = limit {
        sql.push_str(" LIMIT ?");
        values.push(Value::Integer(i64::from(lim.min(500))));
    }

    let mut stmt = connection
        .prepare(&sql)
        .map_err(|error| format!("无法准备助理摘要查询：{error}"))?;
    let rows = stmt
        .query_map(params_from_iter(values.iter()), row_to_digest)
        .map_err(|error| format!("无法查询助理摘要列表：{error}"))?;
    rows.map(|row| row.map_err(|error| format!("无法读取助理摘要记录：{error}")))
        .collect()
}

pub(crate) fn save_assistant_digest(
    connection: &Connection,
    input: ButlerAssistantDigestInput,
) -> Result<ButlerAssistantDigest, String> {
    let scope = validate_account_scope(&input.account_scope)?;
    let kind = input.kind.trim().to_string();
    validate_digest_kind(&kind)?;

    let date_key = input.date_key.trim().to_string();
    if date_key.is_empty() {
        return Err("摘要 dateKey 不能为空".to_string());
    }
    let title = input.title.trim().to_string();
    if title.is_empty() {
        return Err("摘要标题不能为空".to_string());
    }
    let summary_md = input.summary_md.trim().to_string();
    if summary_md.is_empty() {
        return Err("摘要正文不能为空".to_string());
    }
    if contains_sensitive_secret(&title) || contains_sensitive_secret(&summary_md) {
        return Err("摘要内容包含敏感密钥或凭据，已拦截保存".to_string());
    }

    let metrics_json = input
        .metrics_json
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or("{}")
        .to_string();
    serde_json::from_str::<serde_json::Value>(&metrics_json)
        .map_err(|error| format!("metricsJson 必须是合法 JSON：{error}"))?;

    let action_items_json = input
        .action_items_json
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or("[]")
        .to_string();
    serde_json::from_str::<serde_json::Value>(&action_items_json)
        .map_err(|error| format!("actionItemsJson 必须是合法 JSON：{error}"))?;

    let digest = ButlerAssistantDigest {
        id: normalize_optional_trimmed(input.id)
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        account_scope: scope,
        kind,
        date_key,
        title,
        summary_md,
        metrics_json,
        action_items_json,
        related_todo_id: normalize_optional_trimmed(input.related_todo_id),
        related_session_id: normalize_optional_trimmed(input.related_session_id),
        created_at: now_millis(),
    };

    connection
        .execute(
            "INSERT INTO butler_assistant_digests (
                id, account_scope, kind, date_key, title, summary_md,
                metrics_json, action_items_json, related_todo_id, related_session_id, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT(id) DO UPDATE SET
                kind = excluded.kind,
                date_key = excluded.date_key,
                title = excluded.title,
                summary_md = excluded.summary_md,
                metrics_json = excluded.metrics_json,
                action_items_json = excluded.action_items_json,
                related_todo_id = excluded.related_todo_id,
                related_session_id = excluded.related_session_id",
            params![
                digest.id,
                digest.account_scope,
                digest.kind,
                digest.date_key,
                digest.title,
                digest.summary_md,
                digest.metrics_json,
                digest.action_items_json,
                digest.related_todo_id,
                digest.related_session_id,
                digest.created_at,
            ],
        )
        .map_err(|error| format!("无法保存助理摘要：{error}"))?;

    Ok(digest)
}

pub(crate) fn delete_assistant_digest(
    connection: &Connection,
    id: &str,
    account_scope: &str,
) -> Result<bool, String> {
    let trimmed = id.trim();
    if trimmed.is_empty() {
        return Ok(false);
    }
    let scope = validate_account_scope(account_scope)?;
    let changed = connection
        .execute(
            "DELETE FROM butler_assistant_digests WHERE id = ?1 AND account_scope = ?2",
            params![trimmed, scope],
        )
        .map_err(|error| format!("无法删除助理摘要：{error}"))?;
    Ok(changed > 0)
}

pub(crate) fn resolve_verified_account_scope(
    db: &ButlerDb,
    provided: Option<&str>,
) -> Result<String, String> {
    let active = db
        .runtime_account_context()
        .ok()
        .map(|ctx| ctx.account_scope);
    let requested = provided
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    match (active, requested) {
        (Some(active_scope), Some(req_scope)) if active_scope != req_scope => {
            Err("记忆操作作用域与当前已激活账号不一致".to_string())
        }
        (Some(active_scope), _) => Ok(active_scope),
        (None, Some(req_scope)) => Ok(req_scope),
        (None, None) => Err("账号数据库尚未就绪，缺少记忆作用域".to_string()),
    }
}

#[tauri::command]
pub async fn butler_memory_list(
    db: tauri::State<'_, ButlerDb>,
    account_scope: String,
    category: Option<String>,
    workspace_root: Option<String>,
    query: Option<String>,
    enabled_only: Option<bool>,
) -> Result<Vec<ButlerMemoryEntry>, String> {
    let scope = resolve_verified_account_scope(&db, Some(&account_scope))?;
    run_db(db.ready_connection()?, move |connection| {
        list_memories(
            connection,
            &scope,
            category,
            workspace_root,
            query,
            enabled_only,
        )
    })
    .await
}

#[tauri::command]
pub async fn butler_memory_upsert(
    db: tauri::State<'_, ButlerDb>,
    input: ButlerMemoryUpsertInput,
) -> Result<ButlerMemoryEntry, String> {
    let scope = resolve_verified_account_scope(&db, Some(&input.account_scope))?;
    let mut scoped_input = input;
    scoped_input.account_scope = scope;
    run_db(db.ready_connection()?, move |connection| {
        upsert_memory(connection, scoped_input)
    })
    .await
}

#[tauri::command]
pub async fn butler_memory_delete(
    db: tauri::State<'_, ButlerDb>,
    id: String,
    account_scope: Option<String>,
) -> Result<bool, String> {
    let scope = resolve_verified_account_scope(&db, account_scope.as_deref())?;
    run_db(db.ready_connection()?, move |connection| {
        delete_memory(connection, &id, &scope)
    })
    .await
}

#[tauri::command]
pub async fn butler_memory_mark_recalled(
    db: tauri::State<'_, ButlerDb>,
    ids: Vec<String>,
    account_scope: Option<String>,
) -> Result<u64, String> {
    let scope = resolve_verified_account_scope(&db, account_scope.as_deref())?;
    run_db(db.ready_connection()?, move |connection| {
        mark_memories_recalled(connection, ids, &scope)
    })
    .await
}

#[tauri::command]
pub async fn butler_memory_clear_scope(
    db: tauri::State<'_, ButlerDb>,
    account_scope: String,
) -> Result<u64, String> {
    let scope = resolve_verified_account_scope(&db, Some(&account_scope))?;
    run_db(db.ready_connection()?, move |connection| {
        clear_memory_scope(connection, &scope)
    })
    .await
}

#[tauri::command]
pub async fn butler_assistant_digest_list(
    db: tauri::State<'_, ButlerDb>,
    account_scope: String,
    kind: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<ButlerAssistantDigest>, String> {
    let scope = resolve_verified_account_scope(&db, Some(&account_scope))?;
    run_db(db.ready_connection()?, move |connection| {
        list_assistant_digests(connection, &scope, kind, limit)
    })
    .await
}

#[tauri::command]
pub async fn butler_assistant_digest_save(
    db: tauri::State<'_, ButlerDb>,
    input: ButlerAssistantDigestInput,
) -> Result<ButlerAssistantDigest, String> {
    let scope = resolve_verified_account_scope(&db, Some(&input.account_scope))?;
    let mut scoped_input = input;
    scoped_input.account_scope = scope;
    run_db(db.ready_connection()?, move |connection| {
        save_assistant_digest(connection, scoped_input)
    })
    .await
}

#[tauri::command]
pub async fn butler_assistant_digest_delete(
    db: tauri::State<'_, ButlerDb>,
    id: String,
    account_scope: Option<String>,
) -> Result<bool, String> {
    let scope = resolve_verified_account_scope(&db, account_scope.as_deref())?;
    run_db(db.ready_connection()?, move |connection| {
        delete_assistant_digest(connection, &id, &scope)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::super::migrate;
    use super::*;

    fn setup_db() -> Connection {
        let mut connection = Connection::open_in_memory().expect("open memory db");
        migrate(&mut connection).expect("migrate butler db");
        connection
    }

    #[test]
    fn corrections_are_atomic_scoped_and_expiration_excludes_default_recall() {
        let db = setup_db();
        migrate_memory(&db).unwrap(); // Existing installations can rerun the migration.
        let make = |id: &str, scope: &str, supersedes: Option<&str>, expires: Option<i64>| {
            serde_json::from_value::<ButlerMemoryUpsertInput>(serde_json::json!({
                "id": id, "accountScope": scope, "category": "project_fact", "title": "测试", "content": "当前项目约定",
                "sourceKind": "manual", "sourceRef": "thread:source", "supersedesId": supersedes, "expiresAt": expires,
            })).unwrap()
        };
        upsert_memory(&db, make("old", "alice", None, None)).unwrap();
        assert!(upsert_memory(&db, make("wrong", "bob", Some("old"), None)).is_err());
        assert!(list_memories(&db, "bob", None, None, None, None)
            .unwrap()
            .is_empty());
        let saved = upsert_memory(&db, make("new", "alice", Some("old"), None)).unwrap();
        assert_eq!(saved.source_ref.as_deref(), Some("thread:source"));
        let active = list_memories(&db, "alice", None, None, None, Some(true)).unwrap();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].id, "new");
        let all = list_memories(&db, "alice", None, None, None, None).unwrap();
        assert_eq!(
            all.iter()
                .find(|e| e.id == "old")
                .unwrap()
                .superseded_by
                .as_deref(),
            Some("new")
        );
        assert!(upsert_memory(&db, make("old", "alice", None, None)).is_err());
        upsert_memory(&db, make("new", "alice", None, Some(1))).unwrap();
        assert!(list_memories(&db, "alice", None, None, None, Some(true))
            .unwrap()
            .is_empty());
        let mut report = make("report", "alice", None, None);
        report.source_kind = Some("workflow_report".into());
        report.enabled = Some(true);
        report.confidence = Some(1.0);
        let pending = upsert_memory(&db, report).unwrap();
        assert!(!pending.enabled);
        assert_eq!(pending.confidence, 0.5);
    }

    #[test]
    fn secret_filter_blocks_tokens_and_private_keys_without_false_positives() {
        assert!(contains_sensitive_secret(
            "OPENAI_API_KEY=sk-1234567890abcdef"
        ));
        assert!(contains_sensitive_secret(
            "token ghp_abcdefghijklmnopqrstuvwxyz"
        ));
        assert!(contains_sensitive_secret(
            "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload"
        ));
        assert!(contains_sensitive_secret(
            "-----BEGIN RSA PRIVATE KEY-----\nMIIE..."
        ));
        assert!(contains_sensitive_secret("AKIAIOSFODNN7EXAMPLE"));

        assert!(!contains_sensitive_secret("喜欢先跑 cargo test 再提交 PR"));
        assert!(!contains_sensitive_secret(
            "在 apps/desktop 目录运行 pnpm check:architecture"
        ));
        assert!(!contains_sensitive_secret(
            "讨论 task-management 与 disk-cache 设计"
        ));
    }

    #[test]
    fn memory_crud_scope_isolation_and_recall_tracking() {
        let mut connection = setup_db();

        // Secret content is rejected
        let secret_err = upsert_memory(
            &connection,
            ButlerMemoryUpsertInput {
                id: None,
                account_scope: "server-a:alice".to_string(),
                category: "preference".to_string(),
                title: "API Key".to_string(),
                content: "use sk-1234567890abcdef for tests".to_string(),
                tags: None,
                workspace_root: None,
                source_kind: None,
                source_ref: None,
                pinned: None,
                confidence: None,
                enabled: None,
                supersedes_id: None,
                expires_at: None,
            },
        )
        .unwrap_err();
        assert!(secret_err.contains("敏感密钥"));

        // Create memories in two scopes
        let m1 = upsert_memory(
            &connection,
            ButlerMemoryUpsertInput {
                id: None,
                account_scope: "server-a:alice".to_string(),
                category: "project_fact".to_string(),
                title: "Rust 测试命令".to_string(),
                content: "后端修改后必须执行 cargo test 验证".to_string(),
                tags: Some(vec!["rust".to_string(), "testing".to_string()]),
                workspace_root: Some("D:/Repos/rocketchatx".to_string()),
                source_kind: Some("manual".to_string()),
                source_ref: None,
                pinned: Some(true),
                confidence: Some(0.95),
                enabled: Some(true),
                supersedes_id: None,
                expires_at: None,
            },
        )
        .expect("insert m1");
        assert_eq!(m1.recall_count, 0);

        let m2 = upsert_memory(
            &connection,
            ButlerMemoryUpsertInput {
                id: None,
                account_scope: "server-b:bob".to_string(),
                category: "preference".to_string(),
                title: "Bob 偏好".to_string(),
                content: "使用简洁中文汇报".to_string(),
                tags: None,
                workspace_root: None,
                source_kind: None,
                source_ref: None,
                pinned: Some(false),
                confidence: None,
                enabled: Some(true),
                supersedes_id: None,
                expires_at: None,
            },
        )
        .expect("insert m2");

        // Scope isolation
        let alice_list = list_memories(
            &connection,
            "server-a:alice",
            None,
            None,
            Some("cargo".to_string()),
            Some(true),
        )
        .expect("list alice");
        assert_eq!(alice_list.len(), 1);
        assert_eq!(alice_list[0].id, m1.id);

        // Cross-scope update is rejected
        let cross_err = upsert_memory(
            &connection,
            ButlerMemoryUpsertInput {
                id: Some(m1.id.clone()),
                account_scope: "server-b:bob".to_string(),
                category: "project_fact".to_string(),
                title: "Tampered".to_string(),
                content: "Should fail".to_string(),
                tags: None,
                workspace_root: None,
                source_kind: None,
                source_ref: None,
                pinned: None,
                confidence: None,
                enabled: None,
                supersedes_id: None,
                expires_at: None,
            },
        )
        .unwrap_err();
        assert!(cross_err.contains("作用域"));

        // Recall count increment
        let updated_count = mark_memories_recalled(
            &mut connection,
            vec![m1.id.clone(), m1.id.clone()],
            "server-a:alice",
        )
        .expect("mark recalled");
        assert_eq!(updated_count, 1);
        assert_eq!(
            mark_memories_recalled(&mut connection, vec![m1.id.clone()], "server-b:bob")
                .expect("cross-scope recall denied"),
            0
        );

        let after_recall = list_memories(&connection, "server-a:alice", None, None, None, None)
            .expect("list after recall");
        assert_eq!(after_recall[0].recall_count, 1);
        assert!(after_recall[0].last_recalled_at.is_some());

        // Clear scope only removes target scope
        let cleared = clear_memory_scope(&connection, "server-a:alice").expect("clear alice");
        assert_eq!(cleared, 1);
        assert!(
            list_memories(&connection, "server-a:alice", None, None, None, None)
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            list_memories(&connection, "server-b:bob", None, None, None, None)
                .unwrap()
                .len(),
            1
        );
        assert!(!delete_memory(&connection, &m2.id, "server-a:alice").unwrap());
        assert!(delete_memory(&connection, &m2.id, "server-b:bob").unwrap());
    }

    #[test]
    fn assistant_digest_persistence_and_deletion() {
        let connection = setup_db();

        let saved = save_assistant_digest(
            &connection,
            ButlerAssistantDigestInput {
                id: None,
                account_scope: "server-a:alice".to_string(),
                kind: "morning_brief".to_string(),
                date_key: "2026-11-13".to_string(),
                title: "今日晨报".to_string(),
                summary_md: "## 重点待办\n- 完成 ACP 后端".to_string(),
                metrics_json: Some(r#"{"openTodos":3,"overdue":0}"#.to_string()),
                action_items_json: Some(r#"[{"label":"跑 cargo test"}]"#.to_string()),
                related_todo_id: None,
                related_session_id: None,
            },
        )
        .expect("save digest");

        let list = list_assistant_digests(
            &connection,
            "server-a:alice",
            Some("morning_brief".to_string()),
            Some(10),
        )
        .expect("list digests");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, saved.id);
        assert_eq!(list[0].date_key, "2026-11-13");

        assert!(
            list_assistant_digests(&connection, "server-b:bob", None, None)
                .unwrap()
                .is_empty()
        );
        assert!(!delete_assistant_digest(&connection, &saved.id, "server-b:bob").unwrap());
        assert!(delete_assistant_digest(&connection, &saved.id, "server-a:alice").unwrap());
        assert!(!delete_assistant_digest(&connection, &saved.id, "server-a:alice").unwrap());
    }
}
