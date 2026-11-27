use super::butler_memory::{
    contains_sensitive_secret, resolve_verified_account_scope, validate_account_scope,
};
use super::{run_db, ButlerDb};
use rusqlite::{params, params_from_iter, types::Value, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

const SKILL_COLUMNS: &str = "
    id, account_scope, slug, name, description, category,
    instructions_md, triggers_json, allowed_tools_json, approval_policy,
    workspace_root, enabled, pinned, run_count, last_run_at,
    created_at, updated_at
";

pub(crate) fn migrate_skills(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "
            CREATE TABLE IF NOT EXISTS butler_skills (
                id TEXT PRIMARY KEY,
                account_scope TEXT NOT NULL,
                slug TEXT NOT NULL,
                name TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                category TEXT NOT NULL DEFAULT 'general',
                instructions_md TEXT NOT NULL,
                triggers_json TEXT NOT NULL DEFAULT '[]',
                allowed_tools_json TEXT NOT NULL DEFAULT '[]',
                approval_policy TEXT NOT NULL DEFAULT 'confirm_write',
                workspace_root TEXT,
                enabled INTEGER NOT NULL DEFAULT 1,
                pinned INTEGER NOT NULL DEFAULT 0,
                run_count INTEGER NOT NULL DEFAULT 0,
                last_run_at INTEGER,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_butler_skills_scope_enabled
                ON butler_skills(account_scope, enabled, pinned);

            CREATE UNIQUE INDEX IF NOT EXISTS idx_butler_skills_scope_slug
                ON butler_skills(account_scope, slug);
            ",
        )
        .map_err(|error| format!("无法初始化管家技能库表：{error}"))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ButlerSkillEntry {
    pub id: String,
    pub account_scope: String,
    pub slug: String,
    pub name: String,
    pub description: String,
    pub category: String,
    pub instructions_md: String,
    pub triggers: Vec<String>,
    pub allowed_tools: Vec<String>,
    pub approval_policy: String,
    pub workspace_root: Option<String>,
    pub enabled: bool,
    pub pinned: bool,
    pub run_count: i64,
    pub last_run_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ButlerSkillUpsertInput {
    pub id: Option<String>,
    pub account_scope: String,
    pub slug: Option<String>,
    pub name: String,
    pub description: Option<String>,
    pub category: Option<String>,
    pub instructions_md: String,
    pub triggers: Option<Vec<String>>,
    pub allowed_tools: Option<Vec<String>>,
    pub approval_policy: Option<String>,
    pub workspace_root: Option<String>,
    pub enabled: Option<bool>,
    pub pinned: Option<bool>,
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

fn normalize_optional_trimmed(value: Option<String>) -> Option<String> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
}

fn normalize_string_list(items: Option<Vec<String>>) -> Vec<String> {
    let mut out = Vec::new();
    for raw in items.unwrap_or_default() {
        let trimmed = raw.trim();
        if !trimmed.is_empty() && !out.iter().any(|existing| existing == trimmed) {
            out.push(trimmed.to_string());
        }
    }
    out
}

fn validate_approval_policy(policy: &str) -> Result<(), String> {
    if matches!(policy, "auto" | "confirm_write" | "confirm_all") {
        Ok(())
    } else {
        Err("无效的技能审批策略（仅支持 auto / confirm_write / confirm_all）".to_string())
    }
}

fn sanitize_slug_chars(raw: &str) -> String {
    let mut slug = String::with_capacity(raw.len().min(64));
    let mut prev_dash = false;
    for ch in raw.chars() {
        let lower = ch.to_ascii_lowercase();
        if lower.is_ascii_lowercase() || lower.is_ascii_digit() || lower == '_' {
            slug.push(lower);
            prev_dash = false;
        } else if (lower == '-' || lower.is_whitespace() || lower == '.' || lower == '/')
            && !prev_dash
            && !slug.is_empty()
        {
            slug.push('-');
            prev_dash = true;
        }
        if slug.len() >= 64 {
            break;
        }
    }
    slug.trim_matches(['-', '_']).chars().take(64).collect()
}

pub(crate) fn normalize_skill_slug(raw_slug: Option<&str>, name: &str) -> Result<String, String> {
    if let Some(explicit) = raw_slug.map(str::trim).filter(|s| !s.is_empty()) {
        let trimmed = explicit.trim_start_matches('/').to_ascii_lowercase();
        if trimmed.is_empty()
            || trimmed.len() > 64
            || !trimmed
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
        {
            return Err("技能标识 slug 仅允许 1-64 个小写字母、数字、连字符或下划线".to_string());
        }
        return Ok(trimmed);
    }
    let derived = sanitize_slug_chars(name);
    if !derived.is_empty() {
        return Ok(derived);
    }
    let short_id = uuid::Uuid::new_v4().simple().to_string();
    Ok(format!("skill-{}", &short_id[..8]))
}

fn row_to_skill(row: &rusqlite::Row<'_>) -> rusqlite::Result<ButlerSkillEntry> {
    let triggers_raw: String = row.get(7)?;
    let tools_raw: String = row.get(8)?;
    let triggers = serde_json::from_str::<Vec<String>>(&triggers_raw).unwrap_or_default();
    let allowed_tools = serde_json::from_str::<Vec<String>>(&tools_raw).unwrap_or_default();
    Ok(ButlerSkillEntry {
        id: row.get(0)?,
        account_scope: row.get(1)?,
        slug: row.get(2)?,
        name: row.get(3)?,
        description: row.get(4)?,
        category: row.get(5)?,
        instructions_md: row.get(6)?,
        triggers,
        allowed_tools,
        approval_policy: row.get(9)?,
        workspace_root: row.get(10)?,
        enabled: row.get::<_, i64>(11)? != 0,
        pinned: row.get::<_, i64>(12)? != 0,
        run_count: row.get(13)?,
        last_run_at: row.get(14)?,
        created_at: row.get(15)?,
        updated_at: row.get(16)?,
    })
}

pub(crate) fn list_skills(
    connection: &Connection,
    account_scope: &str,
    workspace_root: Option<String>,
    include_disabled: Option<bool>,
) -> Result<Vec<ButlerSkillEntry>, String> {
    let scope = validate_account_scope(account_scope)?;
    let mut conditions = vec!["account_scope = ?".to_string()];
    let mut values = vec![Value::Text(scope)];

    if !include_disabled.unwrap_or(true) {
        conditions.push("enabled = 1".to_string());
    }
    if let Some(root) = normalize_optional_trimmed(workspace_root) {
        conditions.push("(workspace_root IS NULL OR workspace_root = ?)".to_string());
        values.push(Value::Text(root));
    }

    let sql = format!(
        "SELECT {SKILL_COLUMNS} FROM butler_skills
         WHERE {}
         ORDER BY pinned DESC, updated_at DESC, name COLLATE NOCASE ASC",
        conditions.join(" AND ")
    );
    let mut stmt = connection
        .prepare(&sql)
        .map_err(|error| format!("无法准备技能列表查询：{error}"))?;
    let rows = stmt
        .query_map(params_from_iter(values.iter()), row_to_skill)
        .map_err(|error| format!("无法查询技能列表：{error}"))?;
    rows.map(|row| row.map_err(|error| format!("无法读取技能记录：{error}")))
        .collect()
}

pub(crate) fn get_skill(
    connection: &Connection,
    id: &str,
    account_scope: &str,
) -> Result<Option<ButlerSkillEntry>, String> {
    let scope = validate_account_scope(account_scope)?;
    let trimmed_id = id.trim();
    if trimmed_id.is_empty() {
        return Ok(None);
    }
    let sql =
        format!("SELECT {SKILL_COLUMNS} FROM butler_skills WHERE id = ?1 AND account_scope = ?2");
    connection
        .query_row(&sql, params![trimmed_id, scope], row_to_skill)
        .optional()
        .map_err(|error| format!("无法读取技能详情：{error}"))
}

pub(crate) fn upsert_skill(
    connection: &Connection,
    input: ButlerSkillUpsertInput,
) -> Result<ButlerSkillEntry, String> {
    let scope = validate_account_scope(&input.account_scope)?;
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err("技能名称不能为空".to_string());
    }
    let description = input.description.unwrap_or_default().trim().to_string();
    let category = input
        .category
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("general")
        .to_string();
    let instructions_md = input.instructions_md.trim().to_string();
    if instructions_md.is_empty() {
        return Err("技能指令不能为空".to_string());
    }
    if contains_sensitive_secret(&name)
        || contains_sensitive_secret(&description)
        || contains_sensitive_secret(&instructions_md)
    {
        return Err("技能内容包含敏感密钥或凭据，已拦截保存".to_string());
    }

    let slug = normalize_skill_slug(input.slug.as_deref(), &name)?;
    let approval_policy = input
        .approval_policy
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("confirm_write")
        .to_string();
    validate_approval_policy(&approval_policy)?;

    let triggers = normalize_string_list(input.triggers);
    let allowed_tools = normalize_string_list(input.allowed_tools);
    let triggers_json = serde_json::to_string(&triggers)
        .map_err(|error| format!("无法序列化技能触发词：{error}"))?;
    let allowed_tools_json = serde_json::to_string(&allowed_tools)
        .map_err(|error| format!("无法序列化技能工具白名单：{error}"))?;
    let workspace_root = normalize_optional_trimmed(input.workspace_root);
    let now = now_millis();

    let requested_id = normalize_optional_trimmed(input.id);
    if let Some(ref existing_id) = requested_id {
        if let Some(current) = get_skill(connection, existing_id, &scope)? {
            let enabled = input.enabled.unwrap_or(current.enabled);
            let pinned = input.pinned.unwrap_or(current.pinned);
            connection
                .execute(
                    "UPDATE butler_skills
                     SET slug = ?3, name = ?4, description = ?5, category = ?6,
                         instructions_md = ?7, triggers_json = ?8, allowed_tools_json = ?9,
                         approval_policy = ?10, workspace_root = ?11, enabled = ?12,
                         pinned = ?13, updated_at = ?14
                     WHERE id = ?1 AND account_scope = ?2",
                    params![
                        existing_id,
                        scope,
                        slug,
                        name,
                        description,
                        category,
                        instructions_md,
                        triggers_json,
                        allowed_tools_json,
                        approval_policy,
                        workspace_root,
                        i64::from(enabled),
                        i64::from(pinned),
                        now,
                    ],
                )
                .map_err(|error| format!("无法更新技能：{error}"))?;
            return Ok(ButlerSkillEntry {
                id: existing_id.clone(),
                account_scope: scope,
                slug,
                name,
                description,
                category,
                instructions_md,
                triggers,
                allowed_tools,
                approval_policy,
                workspace_root,
                enabled,
                pinned,
                run_count: current.run_count,
                last_run_at: current.last_run_at,
                created_at: current.created_at,
                updated_at: now,
            });
        }
    }

    // If inserting or re-importing by matching (account_scope, slug) without id, update that row.
    let existing_by_slug: Option<ButlerSkillEntry> = if requested_id.is_none() {
        let sql = format!(
            "SELECT {SKILL_COLUMNS} FROM butler_skills WHERE account_scope = ?1 AND slug = ?2"
        );
        connection
            .query_row(&sql, params![scope, slug], row_to_skill)
            .optional()
            .map_err(|error| format!("无法检查重名技能标识：{error}"))?
    } else {
        None
    };

    if let Some(current) = existing_by_slug {
        let enabled = input.enabled.unwrap_or(current.enabled);
        let pinned = input.pinned.unwrap_or(current.pinned);
        connection
            .execute(
                "UPDATE butler_skills
                 SET name = ?3, description = ?4, category = ?5,
                     instructions_md = ?6, triggers_json = ?7, allowed_tools_json = ?8,
                     approval_policy = ?9, workspace_root = ?10, enabled = ?11,
                     pinned = ?12, updated_at = ?13
                 WHERE id = ?1 AND account_scope = ?2",
                params![
                    current.id,
                    scope,
                    name,
                    description,
                    category,
                    instructions_md,
                    triggers_json,
                    allowed_tools_json,
                    approval_policy,
                    workspace_root,
                    i64::from(enabled),
                    i64::from(pinned),
                    now,
                ],
            )
            .map_err(|error| format!("无法覆盖更新技能：{error}"))?;
        return Ok(ButlerSkillEntry {
            id: current.id,
            account_scope: scope,
            slug,
            name,
            description,
            category,
            instructions_md,
            triggers,
            allowed_tools,
            approval_policy,
            workspace_root,
            enabled,
            pinned,
            run_count: current.run_count,
            last_run_at: current.last_run_at,
            created_at: current.created_at,
            updated_at: now,
        });
    }

    let entry = ButlerSkillEntry {
        id: requested_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        account_scope: scope,
        slug,
        name,
        description,
        category,
        instructions_md,
        triggers,
        allowed_tools,
        approval_policy,
        workspace_root,
        enabled: input.enabled.unwrap_or(true),
        pinned: input.pinned.unwrap_or(false),
        run_count: 0,
        last_run_at: None,
        created_at: now,
        updated_at: now,
    };

    connection
        .execute(
            "INSERT INTO butler_skills (
                id, account_scope, slug, name, description, category,
                instructions_md, triggers_json, allowed_tools_json, approval_policy,
                workspace_root, enabled, pinned, run_count, last_run_at,
                created_at, updated_at
             ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6,
                ?7, ?8, ?9, ?10,
                ?11, ?12, ?13, ?14, ?15,
                ?16, ?17
             )",
            params![
                entry.id,
                entry.account_scope,
                entry.slug,
                entry.name,
                entry.description,
                entry.category,
                entry.instructions_md,
                triggers_json,
                allowed_tools_json,
                entry.approval_policy,
                entry.workspace_root,
                i64::from(entry.enabled),
                i64::from(entry.pinned),
                entry.run_count,
                entry.last_run_at,
                entry.created_at,
                entry.updated_at,
            ],
        )
        .map_err(|error| format!("无法保存技能：{error}"))?;

    Ok(entry)
}

pub(crate) fn delete_skill(
    connection: &Connection,
    id: &str,
    account_scope: &str,
) -> Result<bool, String> {
    let scope = validate_account_scope(account_scope)?;
    let trimmed = id.trim();
    if trimmed.is_empty() {
        return Ok(false);
    }
    let changed = connection
        .execute(
            "DELETE FROM butler_skills WHERE id = ?1 AND account_scope = ?2",
            params![trimmed, scope],
        )
        .map_err(|error| format!("无法删除技能：{error}"))?;
    Ok(changed > 0)
}

pub(crate) fn record_skill_run(
    connection: &Connection,
    id: &str,
    account_scope: &str,
) -> Result<ButlerSkillEntry, String> {
    let scope = validate_account_scope(account_scope)?;
    let trimmed = id.trim();
    if trimmed.is_empty() {
        return Err("技能 id 不能为空".to_string());
    }
    let now = now_millis();
    let changed = connection
        .execute(
            "UPDATE butler_skills
             SET run_count = run_count + 1, last_run_at = ?3
             WHERE id = ?1 AND account_scope = ?2",
            params![trimmed, scope, now],
        )
        .map_err(|error| format!("无法记录技能运行次数：{error}"))?;
    if changed == 0 {
        return Err("目标技能不存在或不属于当前账号作用域".to_string());
    }
    get_skill(connection, trimmed, &scope)?.ok_or_else(|| "目标技能不存在".to_string())
}

fn unquote_yaml_scalar(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.len() >= 2
        && ((trimmed.starts_with('"') && trimmed.ends_with('"'))
            || (trimmed.starts_with('\'') && trimmed.ends_with('\'')))
    {
        return trimmed[1..trimmed.len() - 1].to_string();
    }
    trimmed.to_string()
}

fn parse_frontmatter_list(raw: &str) -> Vec<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    if trimmed.starts_with('[') && trimmed.ends_with(']') {
        if let Ok(parsed) = serde_json::from_str::<Vec<String>>(trimmed) {
            return normalize_string_list(Some(parsed));
        }
        let inner = &trimmed[1..trimmed.len() - 1];
        return normalize_string_list(Some(
            inner
                .split(',')
                .map(unquote_yaml_scalar)
                .collect::<Vec<_>>(),
        ));
    }
    normalize_string_list(Some(
        trimmed
            .split(',')
            .map(unquote_yaml_scalar)
            .collect::<Vec<_>>(),
    ))
}

pub(crate) fn import_skill_markdown(
    connection: &Connection,
    account_scope: &str,
    markdown: &str,
    workspace_root: Option<String>,
) -> Result<ButlerSkillEntry, String> {
    let normalized = markdown.replace("\r\n", "\n");
    let trimmed = normalized.trim();
    if trimmed.is_empty() {
        return Err("导入的 Markdown 技能内容不能为空".to_string());
    }

    let mut name: Option<String> = None;
    let mut slug: Option<String> = None;
    let mut description: Option<String> = None;
    let mut category: Option<String> = None;
    let mut approval_policy: Option<String> = None;
    let mut triggers: Option<Vec<String>> = None;
    let mut allowed_tools: Option<Vec<String>> = None;
    let mut body = trimmed.to_string();

    if let Some(after_open) = trimmed.strip_prefix("---\n") {
        if let Some(close_idx) = after_open.find("\n---") {
            let frontmatter = &after_open[..close_idx];
            let rest = &after_open[close_idx + 4..];
            body = rest.trim().to_string();
            for line in frontmatter.lines() {
                let line = line.trim();
                if line.is_empty() || line.starts_with('#') {
                    continue;
                }
                if let Some((key_raw, value_raw)) = line.split_once(':') {
                    let key = key_raw.trim();
                    let val = value_raw.trim();
                    match key {
                        "name" | "title" => name = Some(unquote_yaml_scalar(val)),
                        "slug" | "id" => slug = Some(unquote_yaml_scalar(val)),
                        "description" => description = Some(unquote_yaml_scalar(val)),
                        "category" => category = Some(unquote_yaml_scalar(val)),
                        "approvalPolicy" | "approval_policy" => {
                            approval_policy = Some(unquote_yaml_scalar(val));
                        }
                        "triggers" => triggers = Some(parse_frontmatter_list(val)),
                        "allowedTools" | "allowed_tools" => {
                            allowed_tools = Some(parse_frontmatter_list(val));
                        }
                        _ => {}
                    }
                }
            }
        }
    }

    if name.as_deref().unwrap_or("").trim().is_empty() {
        // Infer heading if `# Name` starts the markdown body.
        if let Some(first_line) = body.lines().next() {
            if let Some(heading) = first_line.strip_prefix("# ") {
                name = Some(heading.trim().to_string());
            }
        }
    }

    upsert_skill(
        connection,
        ButlerSkillUpsertInput {
            id: None,
            account_scope: account_scope.to_string(),
            slug,
            name: name.unwrap_or_else(|| "Imported Skill".to_string()),
            description,
            category,
            instructions_md: body,
            triggers,
            allowed_tools,
            approval_policy,
            workspace_root,
            enabled: Some(true),
            pinned: Some(false),
        },
    )
}

pub(crate) fn export_skill_markdown(
    connection: &Connection,
    id: &str,
    account_scope: &str,
) -> Result<String, String> {
    let skill = get_skill(connection, id, account_scope)?
        .ok_or_else(|| "目标技能不存在或不属于当前账号作用域".to_string())?;
    let triggers_json = serde_json::to_string(&skill.triggers).unwrap_or_else(|_| "[]".to_string());
    let tools_json =
        serde_json::to_string(&skill.allowed_tools).unwrap_or_else(|_| "[]".to_string());
    Ok(format!(
        "---\nname: {}\nslug: {}\ndescription: {}\ncategory: {}\napprovalPolicy: {}\ntriggers: {}\nallowedTools: {}\n---\n\n{}\n",
        serde_json::to_string(&skill.name).unwrap_or_else(|_| skill.name.clone()),
        serde_json::to_string(&skill.slug).unwrap_or_else(|_| skill.slug.clone()),
        serde_json::to_string(&skill.description).unwrap_or_else(|_| skill.description.clone()),
        serde_json::to_string(&skill.category).unwrap_or_else(|_| skill.category.clone()),
        serde_json::to_string(&skill.approval_policy)
            .unwrap_or_else(|_| skill.approval_policy.clone()),
        triggers_json,
        tools_json,
        skill.instructions_md.trim()
    ))
}

fn pi_user_skills_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .app_local_data_dir()
        .ok()
        .map(|dir| dir.join("pi").join("user-skills"))
}

fn is_safe_skill_slug_dir(slug: &str) -> bool {
    !slug.is_empty()
        && slug.len() <= 64
        && slug
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

pub(crate) fn sync_account_skills_to_dir(
    connection: &Connection,
    account_scope: &str,
    target_dir: &Path,
) -> Result<usize, String> {
    std::fs::create_dir_all(target_dir)
        .map_err(|error| format!("无法准备 Pi 技能同步目录：{error}"))?;
    let enabled_skills = list_skills(connection, account_scope, None, Some(false))?;
    let mut active_slugs = HashSet::new();
    let mut written = 0usize;

    for skill in enabled_skills {
        if !is_safe_skill_slug_dir(&skill.slug) {
            continue;
        }
        active_slugs.insert(skill.slug.clone());
        let skill_dir = target_dir.join(&skill.slug);
        std::fs::create_dir_all(&skill_dir)
            .map_err(|error| format!("无法创建技能目录：{error}"))?;
        let raw_desc = if skill.description.trim().is_empty() {
            skill.name.trim()
        } else {
            skill.description.trim()
        };
        let single_line_desc: String = raw_desc
            .chars()
            .map(|c| if c == '\r' || c == '\n' { ' ' } else { c })
            .collect();
        let desc_json = serde_json::to_string(&single_line_desc)
            .unwrap_or_else(|_| "\"RocketX Skill\"".to_string());
        let markdown = format!(
            "---\nname: {}\ndescription: {}\n---\n\n{}\n",
            skill.slug,
            desc_json,
            skill.instructions_md.trim()
        );
        let skill_md_path = skill_dir.join("SKILL.md");
        let existing_md = std::fs::read_to_string(&skill_md_path).ok();
        if existing_md.as_deref() != Some(markdown.as_str()) {
            std::fs::write(&skill_md_path, markdown)
                .map_err(|error| format!("无法写入技能文件：{error}"))?;
            written += 1;
        }
    }

    if let Ok(entries) = std::fs::read_dir(target_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let Some(dir_name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if !active_slugs.contains(dir_name) {
                let _ = std::fs::remove_dir_all(&path);
            }
        }
    }

    Ok(written)
}

#[tauri::command]
pub async fn butler_skill_list(
    app: tauri::AppHandle,
    db: tauri::State<'_, ButlerDb>,
    account_scope: String,
    workspace_root: Option<String>,
    include_disabled: Option<bool>,
) -> Result<Vec<ButlerSkillEntry>, String> {
    let scope = resolve_verified_account_scope(&db, Some(&account_scope))?;
    let sync_dir = pi_user_skills_dir(&app);
    run_db(db.ready_connection()?, move |connection| {
        if let Some(ref dir) = sync_dir {
            let _ = sync_account_skills_to_dir(connection, &scope, dir);
        }
        list_skills(connection, &scope, workspace_root, include_disabled)
    })
    .await
}

#[tauri::command]
pub async fn butler_skill_upsert(
    app: tauri::AppHandle,
    db: tauri::State<'_, ButlerDb>,
    input: ButlerSkillUpsertInput,
) -> Result<ButlerSkillEntry, String> {
    let scope = resolve_verified_account_scope(&db, Some(&input.account_scope))?;
    let sync_dir = pi_user_skills_dir(&app);
    let mut scoped = input;
    scoped.account_scope = scope.clone();
    run_db(db.ready_connection()?, move |connection| {
        let saved = upsert_skill(connection, scoped)?;
        if let Some(ref dir) = sync_dir {
            let _ = sync_account_skills_to_dir(connection, &scope, dir);
        }
        Ok(saved)
    })
    .await
}

#[tauri::command]
pub async fn butler_skill_delete(
    app: tauri::AppHandle,
    db: tauri::State<'_, ButlerDb>,
    id: String,
    account_scope: Option<String>,
) -> Result<bool, String> {
    let scope = resolve_verified_account_scope(&db, account_scope.as_deref())?;
    let sync_dir = pi_user_skills_dir(&app);
    run_db(db.ready_connection()?, move |connection| {
        let deleted = delete_skill(connection, &id, &scope)?;
        if deleted {
            if let Some(ref dir) = sync_dir {
                let _ = sync_account_skills_to_dir(connection, &scope, dir);
            }
        }
        Ok(deleted)
    })
    .await
}

#[tauri::command]
pub async fn butler_skill_record_run(
    db: tauri::State<'_, ButlerDb>,
    id: String,
    account_scope: Option<String>,
) -> Result<ButlerSkillEntry, String> {
    let scope = resolve_verified_account_scope(&db, account_scope.as_deref())?;
    run_db(db.ready_connection()?, move |connection| {
        record_skill_run(connection, &id, &scope)
    })
    .await
}

#[tauri::command]
pub async fn butler_skill_import_markdown(
    app: tauri::AppHandle,
    db: tauri::State<'_, ButlerDb>,
    account_scope: String,
    markdown: String,
    workspace_root: Option<String>,
) -> Result<ButlerSkillEntry, String> {
    let scope = resolve_verified_account_scope(&db, Some(&account_scope))?;
    let sync_dir = pi_user_skills_dir(&app);
    run_db(db.ready_connection()?, move |connection| {
        let saved = import_skill_markdown(connection, &scope, &markdown, workspace_root)?;
        if let Some(ref dir) = sync_dir {
            let _ = sync_account_skills_to_dir(connection, &scope, dir);
        }
        Ok(saved)
    })
    .await
}

#[tauri::command]
pub async fn butler_skill_export_markdown(
    db: tauri::State<'_, ButlerDb>,
    id: String,
    account_scope: Option<String>,
) -> Result<String, String> {
    let scope = resolve_verified_account_scope(&db, account_scope.as_deref())?;
    run_db(db.ready_connection()?, move |connection| {
        export_skill_markdown(connection, &id, &scope)
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
    fn skill_crud_scoping_validation_and_markdown_roundtrip() {
        let db = setup_db();
        let created = upsert_skill(
            &db,
            ButlerSkillUpsertInput {
                id: None,
                account_scope: "alice".to_string(),
                slug: Some("pr-review".to_string()),
                name: "PR Code Review".to_string(),
                description: Some("Inspect diffs for risks and missing tests".to_string()),
                category: Some("code".to_string()),
                instructions_md: "Review staged or PR diffs carefully.".to_string(),
                triggers: Some(vec!["review".to_string(), "pr".to_string()]),
                allowed_tools: Some(vec!["git_diff".to_string(), "read_file".to_string()]),
                approval_policy: Some("confirm_write".to_string()),
                workspace_root: Some("d:/repo".to_string()),
                enabled: Some(true),
                pinned: Some(true),
            },
        )
        .expect("create skill");
        assert_eq!(created.slug, "pr-review");
        assert_eq!(created.run_count, 0);

        // Account isolation
        assert!(list_skills(&db, "bob", None, None).unwrap().is_empty());
        assert_eq!(
            list_skills(&db, "alice", Some("d:/repo".to_string()), Some(false))
                .unwrap()
                .len(),
            1
        );

        // Secret rejection
        let secret_err = upsert_skill(
            &db,
            ButlerSkillUpsertInput {
                id: None,
                account_scope: "alice".to_string(),
                slug: Some("bad-secret".to_string()),
                name: "Bad Skill".to_string(),
                description: None,
                category: None,
                instructions_md: "Use key sk-abcdefghijklmnopqrstuvwxyz123456".to_string(),
                triggers: None,
                allowed_tools: None,
                approval_policy: None,
                workspace_root: None,
                enabled: None,
                pinned: None,
            },
        );
        assert!(secret_err.is_err());

        // Invalid approvalPolicy rejection
        let policy_err = upsert_skill(
            &db,
            ButlerSkillUpsertInput {
                id: None,
                account_scope: "alice".to_string(),
                slug: Some("bad-policy".to_string()),
                name: "Bad Policy".to_string(),
                description: None,
                category: None,
                instructions_md: "Check logs".to_string(),
                triggers: None,
                allowed_tools: None,
                approval_policy: Some("yolo_admin".to_string()),
                workspace_root: None,
                enabled: None,
                pinned: None,
            },
        );
        assert!(policy_err.is_err());

        // Record run increments counter and sets timestamp
        let ran = record_skill_run(&db, &created.id, "alice").expect("record run");
        assert_eq!(ran.run_count, 1);
        assert!(ran.last_run_at.is_some());

        // Export & import markdown roundtrip into bob's scope
        let exported = export_skill_markdown(&db, &created.id, "alice").expect("export md");
        assert!(exported.contains("slug: \"pr-review\""));
        let imported = import_skill_markdown(&db, "bob", &exported, None).expect("import md");
        assert_eq!(imported.slug, "pr-review");
        assert_eq!(imported.name, "PR Code Review");
        assert_eq!(imported.triggers, vec!["review", "pr"]);
        assert_eq!(imported.allowed_tools, vec!["git_diff", "read_file"]);
        assert_eq!(imported.approval_policy, "confirm_write");

        // Delete scoped
        assert!(!delete_skill(&db, &created.id, "bob").unwrap());
        assert!(delete_skill(&db, &created.id, "alice").unwrap());
        assert!(list_skills(&db, "alice", None, None).unwrap().is_empty());
    }

    #[test]
    fn materializes_enabled_skills_and_prunes_disabled_or_deleted_dirs() {
        let db = setup_db();
        let temp_dir =
            std::env::temp_dir().join(format!("rcx-skill-sync-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_dir);

        let enabled = upsert_skill(
            &db,
            ButlerSkillUpsertInput {
                id: None,
                account_scope: "alice".to_string(),
                slug: Some("dream-verify".to_string()),
                name: "Dream Verify".to_string(),
                description: Some("Verify tests\nautomatically".to_string()),
                category: Some("code".to_string()),
                instructions_md: "Run tests cleanly.".to_string(),
                triggers: None,
                allowed_tools: None,
                approval_policy: Some("confirm_write".to_string()),
                workspace_root: None,
                enabled: Some(true),
                pinned: Some(false),
            },
        )
        .expect("create enabled skill");

        let _disabled = upsert_skill(
            &db,
            ButlerSkillUpsertInput {
                id: None,
                account_scope: "alice".to_string(),
                slug: Some("disabled-skill".to_string()),
                name: "Disabled Skill".to_string(),
                description: None,
                category: None,
                instructions_md: "Should not sync.".to_string(),
                triggers: None,
                allowed_tools: None,
                approval_policy: None,
                workspace_root: None,
                enabled: Some(false),
                pinned: Some(false),
            },
        )
        .expect("create disabled skill");

        std::fs::create_dir_all(temp_dir.join("stale-skill")).unwrap();
        std::fs::write(temp_dir.join("stale-skill").join("SKILL.md"), "stale").unwrap();

        let count = sync_account_skills_to_dir(&db, "alice", &temp_dir).expect("sync skills");
        assert_eq!(count, 1);

        // Re-running with identical instructions is a no-op write (returns 0 rewritten).
        let second_count =
            sync_account_skills_to_dir(&db, "alice", &temp_dir).expect("re-sync skills");
        assert_eq!(second_count, 0);

        let synced_md =
            std::fs::read_to_string(temp_dir.join(&enabled.slug).join("SKILL.md")).unwrap();
        assert!(synced_md.contains("name: dream-verify"));
        assert!(synced_md.contains("description: \"Verify tests automatically\""));
        assert!(synced_md.contains("Run tests cleanly."));
        assert!(!temp_dir.join("disabled-skill").exists());
        assert!(!temp_dir.join("stale-skill").exists());

        let _ = std::fs::remove_dir_all(&temp_dir);
    }
}
