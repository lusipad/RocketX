use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Manager;

const DEFAULT_DISCOVER_LIMIT: usize = 120;
const MAX_DISCOVER_LIMIT: usize = 300;
const DEFAULT_MESSAGE_LIMIT: usize = 24;
const MAX_MESSAGE_LIMIT: usize = 100;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredLocalSession {
    pub provider: String,
    pub preset: String,
    pub native_session_id: String,
    pub title: String,
    pub preview: Option<String>,
    pub workspace_root: String,
    pub runtime_status: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub step_count: Option<i64>,
    pub source_path: Option<String>,
    #[serde(default)]
    pub source_scope: String,
    #[serde(default)]
    pub execution_profile_id: Option<String>,
}

pub(crate) fn normalized_source_scope(provider: &str, root: &Path) -> String {
    let resolved = fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let raw = resolved
        .to_string_lossy()
        .replace("\\\\?\\", "")
        .replace('\\', "/");
    let normalized = if cfg!(windows) {
        raw.to_lowercase()
    } else {
        raw
    };
    format!("{provider}:{}", normalized.trim_end_matches('/'))
}

#[derive(Clone, Debug)]
pub(crate) struct CodexSessionSource {
    pub root: PathBuf,
    pub profile_id: Option<String>,
}

pub(crate) fn default_codex_root(home: &Path) -> PathBuf {
    std::env::var_os("CODEX_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".codex"))
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeResumeAuthorization {
    pub token: String,
    pub session_id: String,
    pub source_scope: String,
    pub account_scope: String,
    pub host_device_id: String,
}

struct PendingHandoff {
    session_id: String,
    source_scope: String,
    workspace_root: PathBuf,
    profile_id: String,
    profile_fingerprint: String,
    account_scope: String,
    host_device_id: String,
    issued_at: SystemTime,
}

static HANDOFFS: LazyLock<Mutex<HashMap<String, PendingHandoff>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

// Both ACP and native app-server admission use this gate before either process registry.
// It coordinates writers in this RocketX process, not external Codex applications.
pub(crate) static NATIVE_CODEX_START_LOCK: Mutex<()> = Mutex::new(());

pub(crate) fn consume_native_handoff(
    auth: &NativeResumeAuthorization,
    profile_id: &str,
    profile_fingerprint: &str,
    source_scope: &str,
    cwd: &Path,
) -> Result<(), String> {
    let mut pending = HANDOFFS.lock().map_err(|_| "会话交接锁不可用")?;
    let entry = pending
        .remove(&auth.token)
        .ok_or("交接确认不存在、已使用或已失效，请重新明确交接")?;
    if entry.issued_at.elapsed().unwrap_or(Duration::MAX) > Duration::from_secs(90)
        || entry.session_id != auth.session_id
        || entry.source_scope != auth.source_scope
        || entry.source_scope != source_scope
        || entry.profile_id != profile_id
        || entry.profile_fingerprint != profile_fingerprint
        || entry.account_scope != auth.account_scope
        || entry.host_device_id != auth.host_device_id
        || fs::canonicalize(cwd).ok().as_ref() != Some(&entry.workspace_root)
    {
        return Err(
            "交接确认与原会话、来源、账号、设备、配置或工作目录不一致，请重新交接".to_string(),
        );
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalSessionMessage {
    pub id: String,
    pub role: String,
    pub text: String,
    pub timestamp: i64,
}

fn user_home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
}

fn normalize_epoch_ms(ts: i64) -> i64 {
    if ts > 0 && ts < 100_000_000_000 {
        ts.saturating_mul(1000)
    } else {
        ts
    }
}

fn system_time_to_ms(time: SystemTime) -> i64 {
    time.duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = year - if month <= 2 { 1 } else { 0 };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

pub(crate) fn parse_iso_to_epoch_ms(raw: &str) -> Option<i64> {
    let trimmed = raw.trim();
    if trimmed.len() < 10 {
        return None;
    }
    let bytes = trimmed.as_bytes();
    if bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let year: i64 = trimmed.get(0..4)?.parse().ok()?;
    let month: i64 = trimmed.get(5..7)?.parse().ok()?;
    let day: i64 = trimmed.get(8..10)?.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }

    let rest = trimmed.get(10..).unwrap_or("");
    let rest = rest
        .strip_prefix('T')
        .or_else(|| rest.strip_prefix(' '))
        .unwrap_or(rest);

    let (hour, minute, second, frac_ms, tz_offset_ms) = if rest.is_empty() {
        (0_i64, 0_i64, 0_i64, 0_i64, 0_i64)
    } else {
        let mut tz_idx: Option<usize> = None;
        for (idx, ch) in rest.char_indices() {
            if ch == 'Z' || ch == 'z' || (idx >= 8 && (ch == '+' || ch == '-')) {
                tz_idx = Some(idx);
                break;
            }
        }
        let (time_part, tz_part) = match tz_idx {
            Some(idx) => (&rest[..idx], &rest[idx..]),
            None => (rest, ""),
        };
        let (hms_part, frac_part) = match time_part.split_once('.') {
            Some((hms, frac)) => (hms, frac),
            None => (time_part, ""),
        };
        let mut hms_iter = hms_part.split(':');
        let hour: i64 = hms_iter.next().and_then(|v| v.parse().ok()).unwrap_or(0);
        let minute: i64 = hms_iter.next().and_then(|v| v.parse().ok()).unwrap_or(0);
        let second: i64 = hms_iter.next().and_then(|v| v.parse().ok()).unwrap_or(0);
        if !(0..=23).contains(&hour) || !(0..=59).contains(&minute) || !(0..=60).contains(&second) {
            return None;
        }
        let mut frac_ms: i64 = 0;
        let mut scale = 100_i64;
        for ch in frac_part.chars().take(3) {
            if let Some(d) = ch.to_digit(10) {
                frac_ms += i64::from(d) * scale;
                scale /= 10;
            }
        }

        let tz_offset_ms = if tz_part.is_empty() || tz_part.eq_ignore_ascii_case("z") {
            0
        } else if let Some(sign) = tz_part.chars().next().filter(|&c| c == '+' || c == '-') {
            let digits = &tz_part[1..];
            let (tz_h, tz_m) = if let Some((h, m)) = digits.split_once(':') {
                (h.parse::<i64>().unwrap_or(0), m.parse::<i64>().unwrap_or(0))
            } else if digits.len() >= 4 {
                (
                    digits[..2].parse::<i64>().unwrap_or(0),
                    digits[2..4].parse::<i64>().unwrap_or(0),
                )
            } else {
                (digits.parse::<i64>().unwrap_or(0), 0)
            };
            let abs_ms = (tz_h * 3600 + tz_m * 60) * 1000;
            if sign == '-' {
                -abs_ms
            } else {
                abs_ms
            }
        } else {
            0
        };
        (hour, minute, second, frac_ms, tz_offset_ms)
    };

    let days = days_from_civil(year, month, day);
    let secs = days * 86_400 + hour * 3600 + minute * 60 + second;
    Some(secs * 1000 + frac_ms - tz_offset_ms)
}

fn percent_decode_bytes(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (
                (bytes[i + 1] as char).to_digit(16),
                (bytes[i + 2] as char).to_digit(16),
            ) {
                out.push(((h << 4) | l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub(crate) fn decode_file_uri_or_path(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let without_uri = if let Some(rest) = trimmed.strip_prefix("file:///") {
        let decoded = percent_decode_bytes(rest);
        // If Unix path missing leading slash, check Windows drive pattern `D:/...` vs `Users/...`
        let is_windows_drive = decoded.as_bytes().get(1) == Some(&b':');
        if cfg!(windows) || is_windows_drive {
            decoded
        } else {
            format!("/{decoded}")
        }
    } else if let Some(rest) = trimmed.strip_prefix("file://") {
        percent_decode_bytes(rest)
    } else {
        trimmed.to_string()
    };

    let mut clean = without_uri;
    if let Some(stripped) = clean.strip_prefix(r"\\?\") {
        clean = stripped.to_string();
    }
    if cfg!(windows) {
        clean = clean.replace('/', "\\");
    }
    clean.trim().to_string()
}

fn clean_session_title(raw: &str, max_chars: usize) -> String {
    let mut text = raw.trim().to_string();
    if let Some(start) = text.find("<USER_REQUEST>") {
        let after = &text[start + "<USER_REQUEST>".len()..];
        let end = after.find("</USER_REQUEST>").unwrap_or(after.len());
        text = after[..end].trim().to_string();
    } else {
        text = text
            .replace("<USER_REQUEST>", " ")
            .replace("</USER_REQUEST>", " ");
    }

    let first_line = text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");

    let char_count = first_line.chars().count();
    if char_count <= max_chars {
        first_line
    } else {
        let prefix: String = first_line
            .chars()
            .take(max_chars.saturating_sub(1))
            .collect();
        format!("{prefix}…")
    }
}

fn is_system_injected_prompt(text: &str) -> bool {
    let t = text.trim_start();
    t.starts_with("# AGENTS.md")
        || t.starts_with("<INSTRUCTIONS>")
        || t.starts_with("<environment_context>")
        || t.starts_with("<permissions instructions>")
        || t.starts_with("<collaboration_mode>")
        || t.starts_with("<app-context>")
        || t.starts_with("<turn_aborted>")
}

fn open_sqlite_readonly(path: &Path) -> Result<Connection, String> {
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    match Connection::open_with_flags(path, flags) {
        Ok(conn) => {
            let _ = conn.busy_timeout(Duration::from_millis(150));
            Ok(conn)
        }
        Err(first_err) => {
            let path_str = path.to_string_lossy().replace('\\', "/");
            let uri = if path_str.starts_with('/') {
                format!("file:{path_str}?immutable=1")
            } else {
                format!("file:///{path_str}?immutable=1")
            };
            Connection::open_with_flags(uri, flags | OpenFlags::SQLITE_OPEN_URI)
                .map(|conn| {
                    let _ = conn.busy_timeout(Duration::from_millis(150));
                    conn
                })
                .map_err(|second_err| format!("{first_err}; immutable fallback: {second_err}"))
        }
    }
}

fn table_columns(conn: &Connection, table: &str) -> HashSet<String> {
    let mut cols = HashSet::new();
    let sql = format!("PRAGMA table_info({table})");
    if let Ok(mut stmt) = conn.prepare(&sql) {
        if let Ok(rows) = stmt.query_map([], |row| row.get::<_, String>(1)) {
            for col in rows.flatten() {
                cols.insert(col);
            }
        }
    }
    cols
}

fn collect_antigravity_sessions(home: &Path) -> Vec<DiscoveredLocalSession> {
    let agy_root = home.join(".gemini").join("antigravity");
    let db_path = agy_root.join("conversation_summaries.db");
    let brain_dir = agy_root.join("brain");
    let mut results = Vec::new();
    let mut seen_ids = HashSet::new();
    let fallback_cwd = decode_file_uri_or_path(&home.to_string_lossy());

    if db_path.is_file() {
        if let Ok(conn) = open_sqlite_readonly(&db_path) {
            let cols = table_columns(&conn, "conversation_summaries");
            let depth_filter = if cols.contains("nesting_depth") {
                "COALESCE(nesting_depth, 0) = 0"
            } else {
                "1 = 1"
            };
            let killed_filter = if cols.contains("killed") {
                "COALESCE(killed, 0) = 0"
            } else {
                "1 = 1"
            };
            let status_expr = if cols.contains("status") {
                "status"
            } else {
                "''"
            };
            let sql = format!(
                "SELECT conversation_id, title, preview, step_count, last_modified_time, workspace_uris, {status_expr}
                 FROM conversation_summaries
                 WHERE {depth_filter} AND {killed_filter}
                 ORDER BY last_modified_time DESC
                 LIMIT 120"
            );
            if let Ok(mut stmt) = conn.prepare(&sql) {
                let rows = stmt.query_map([], |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<i64>>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, Option<String>>(6)?,
                    ))
                });
                if let Ok(rows) = rows {
                    for row in rows.flatten() {
                        let Some(conv_id) = row.0.filter(|s| !s.trim().is_empty()) else {
                            continue;
                        };
                        let raw_title = row.1.unwrap_or_default();
                        let raw_preview = row.2.unwrap_or_default();
                        let title = clean_session_title(
                            if raw_title.trim().is_empty() {
                                &raw_preview
                            } else {
                                &raw_title
                            },
                            80,
                        );
                        if title.is_empty() {
                            continue;
                        }
                        let preview = {
                            let cleaned = clean_session_title(&raw_preview, 120);
                            if cleaned.is_empty() {
                                None
                            } else {
                                Some(cleaned)
                            }
                        };

                        let workspace_root = row
                            .5
                            .as_deref()
                            .and_then(|json| serde_json::from_str::<Vec<String>>(json).ok())
                            .and_then(|uris| {
                                uris.into_iter()
                                    .map(|u| decode_file_uri_or_path(&u))
                                    .find(|p| !p.is_empty())
                            })
                            .unwrap_or_else(|| fallback_cwd.clone());

                        let updated_at = row
                            .4
                            .as_deref()
                            .and_then(parse_iso_to_epoch_ms)
                            .unwrap_or(0);
                        if updated_at == 0 {
                            continue;
                        }
                        let status = match row.6.as_deref() {
                            Some("CASCADE_RUN_STATUS_RUNNING") => "running",
                            _ => "idle",
                        };

                        let transcript_path = brain_dir
                            .join(&conv_id)
                            .join(".system_generated")
                            .join("logs")
                            .join("transcript.jsonl");
                        let created_at = if transcript_path.is_file() {
                            read_first_line_timestamp(&transcript_path).unwrap_or(updated_at)
                        } else {
                            updated_at
                        };

                        seen_ids.insert(conv_id.clone());
                        results.push(DiscoveredLocalSession {
                            provider: "antigravity".to_string(),
                            preset: "antigravity".to_string(),
                            native_session_id: conv_id,
                            title,
                            preview,
                            workspace_root,
                            runtime_status: status.to_string(),
                            created_at,
                            updated_at,
                            step_count: row.3,
                            source_scope: "default".to_string(),
                            execution_profile_id: None,
                            source_path: transcript_path
                                .is_file()
                                .then(|| transcript_path.to_string_lossy().into_owned()),
                        });
                    }
                }
            }
        }
    }

    // Fallback or supplement: recent transcripts under brain/ not covered by SQLite
    if brain_dir.is_dir() {
        let mut fallback_candidates: Vec<(i64, String, PathBuf)> = Vec::new();
        if let Ok(entries) = fs::read_dir(&brain_dir) {
            for entry in entries.flatten() {
                let id = entry.file_name().to_string_lossy().into_owned();
                if seen_ids.contains(&id) {
                    continue;
                }
                let transcript = entry
                    .path()
                    .join(".system_generated")
                    .join("logs")
                    .join("transcript.jsonl");
                if let Ok(meta) = fs::metadata(&transcript) {
                    if meta.is_file() {
                        let mtime = meta.modified().map(system_time_to_ms).unwrap_or(0);
                        fallback_candidates.push((mtime, id, transcript));
                    }
                }
            }
        }
        fallback_candidates.sort_by(|a, b| b.0.cmp(&a.0));
        for (mtime, id, transcript) in fallback_candidates.into_iter().take(40) {
            let messages = parse_antigravity_messages(&transcript, 4);
            let title = messages
                .iter()
                .find(|m| m.role == "user")
                .map(|m| clean_session_title(&m.text, 80))
                .unwrap_or_default();
            if title.is_empty() {
                continue;
            }
            let created_at = messages.first().map(|m| m.timestamp).unwrap_or(mtime);
            results.push(DiscoveredLocalSession {
                provider: "antigravity".to_string(),
                preset: "antigravity".to_string(),
                native_session_id: id,
                title,
                preview: messages.last().map(|m| clean_session_title(&m.text, 120)),
                workspace_root: fallback_cwd.clone(),
                runtime_status: "idle".to_string(),
                created_at,
                updated_at: mtime,
                step_count: None,
                source_path: Some(transcript.to_string_lossy().into_owned()),
                source_scope: "default".to_string(),
                execution_profile_id: None,
            });
        }
    }

    results
}

fn read_first_line_timestamp(path: &Path) -> Option<i64> {
    let file = File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    if reader.read_line(&mut line).ok()? == 0 {
        return None;
    }
    let val: Value = serde_json::from_str(&line).ok()?;
    val.get("created_at")
        .or_else(|| val.get("timestamp"))
        .and_then(|v| v.as_str())
        .and_then(parse_iso_to_epoch_ms)
}

fn load_codex_session_index(codex_dir: &Path) -> HashMap<String, (String, Option<i64>)> {
    let mut map = HashMap::new();
    let index_path = codex_dir.join("session_index.jsonl");
    let Ok(file) = File::open(&index_path) else {
        return map;
    };
    let reader = BufReader::new(file);
    for line in reader.lines().map_while(Result::ok) {
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(val) = serde_json::from_str::<Value>(&line) {
            let Some(id) = val.get("id").and_then(|v| v.as_str()) else {
                continue;
            };
            let name = val
                .get("thread_name")
                .and_then(|v| v.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            let updated_at = val
                .get("updated_at")
                .and_then(|v| v.as_str())
                .and_then(parse_iso_to_epoch_ms);
            if let Some(title) = name {
                map.insert(id.to_string(), (title, updated_at));
            }
        }
    }
    map
}

fn collect_codex_sessions(home: &Path) -> Vec<DiscoveredLocalSession> {
    collect_codex_sessions_from_root(&home.join(".codex"), None)
}

pub(crate) fn collect_codex_sessions_from_root(
    codex_dir: &Path,
    profile_id: Option<&str>,
) -> Vec<DiscoveredLocalSession> {
    if !codex_dir.is_dir() {
        return Vec::new();
    }
    let index_titles = load_codex_session_index(&codex_dir);
    let mut results = Vec::new();
    let mut seen_ids = HashSet::new();

    // Find newest state_*.sqlite
    let mut state_dbs: Vec<(i64, PathBuf)> = Vec::new();
    if let Ok(entries) = fs::read_dir(&codex_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with("state_") && name.ends_with(".sqlite") {
                if let Ok(meta) = entry.metadata() {
                    let mtime = meta.modified().map(system_time_to_ms).unwrap_or(0);
                    state_dbs.push((mtime, entry.path()));
                }
            }
        }
    }
    state_dbs.sort_by(|a, b| b.0.cmp(&a.0));

    if let Some((_, db_path)) = state_dbs.first() {
        if let Ok(conn) = open_sqlite_readonly(db_path) {
            let cols = table_columns(&conn, "threads");
            let created_expr = if cols.contains("created_at_ms") {
                "COALESCE(NULLIF(created_at_ms, 0), created_at)"
            } else {
                "created_at"
            };
            let updated_expr = if cols.contains("updated_at_ms") {
                "COALESCE(NULLIF(updated_at_ms, 0), updated_at)"
            } else {
                "updated_at"
            };
            let first_msg_expr = if cols.contains("first_user_message") {
                "first_user_message"
            } else {
                "''"
            };
            let preview_expr = if cols.contains("preview") {
                "preview"
            } else {
                "''"
            };
            let name_expr = if cols.contains("name") { "name" } else { "''" };
            let rollout_expr = if cols.contains("rollout_path") {
                "rollout_path"
            } else {
                "''"
            };
            let archived_filter = if cols.contains("archived") {
                "COALESCE(archived, 0) = 0"
            } else {
                "1 = 1"
            };
            let user_event_filter = if cols.contains("has_user_event") {
                "(COALESCE(has_user_event, 1) != 0 OR LENGTH(TRIM(COALESCE(title, ''))) > 0)"
            } else {
                "1 = 1"
            };
            let sql = format!(
                "SELECT id, cwd, title, {created_expr}, {updated_expr}, {rollout_expr}, {first_msg_expr}, {preview_expr}, {name_expr}
                 FROM threads
                 WHERE {archived_filter} AND {user_event_filter}
                 ORDER BY updated_at DESC
                 LIMIT 120"
            );

            if let Ok(mut stmt) = conn.prepare(&sql) {
                let rows = stmt.query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<i64>>(3)?,
                        row.get::<_, Option<i64>>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, Option<String>>(6)?,
                        row.get::<_, Option<String>>(7)?,
                        row.get::<_, Option<String>>(8)?,
                    ))
                });
                if let Ok(rows) = rows {
                    for row in rows.flatten() {
                        let (
                            id,
                            cwd_opt,
                            title_opt,
                            created_opt,
                            updated_opt,
                            rollout_opt,
                            first_msg_opt,
                            preview_opt,
                            name_opt,
                        ) = row;
                        let workspace_root = cwd_opt
                            .as_deref()
                            .map(decode_file_uri_or_path)
                            .unwrap_or_default();
                        if workspace_root.is_empty() {
                            continue;
                        }

                        let rollout_clean = rollout_opt
                            .as_deref()
                            .map(decode_file_uri_or_path)
                            .filter(|p| !p.is_empty());

                        let indexed = index_titles.get(&id);
                        let raw_title = [
                            indexed.map(|(t, _)| t.as_str()).unwrap_or(""),
                            name_opt.as_deref().unwrap_or(""),
                            title_opt.as_deref().unwrap_or(""),
                            first_msg_opt.as_deref().unwrap_or(""),
                            preview_opt.as_deref().unwrap_or(""),
                        ]
                        .into_iter()
                        .map(|candidate| clean_session_title(candidate, 80))
                        .find(|t| !t.is_empty())
                        .unwrap_or_default();

                        if raw_title.is_empty() {
                            continue;
                        }

                        let preview = [
                            preview_opt.as_deref().unwrap_or(""),
                            first_msg_opt.as_deref().unwrap_or(""),
                        ]
                        .into_iter()
                        .map(|candidate| clean_session_title(candidate, 120))
                        .find(|p| !p.is_empty());

                        let created_at = normalize_epoch_ms(created_opt.unwrap_or(0));
                        let mut updated_at = normalize_epoch_ms(updated_opt.unwrap_or(0));
                        if let Some((_, Some(idx_ms))) = indexed {
                            updated_at = updated_at.max(*idx_ms);
                        }
                        if updated_at == 0 {
                            continue;
                        }

                        seen_ids.insert(id.clone());
                        results.push(DiscoveredLocalSession {
                            provider: "codex".to_string(),
                            preset: "codex-acp".to_string(),
                            native_session_id: id,
                            title: raw_title,
                            preview,
                            workspace_root,
                            runtime_status: "unknown".to_string(),
                            created_at: if created_at > 0 {
                                created_at
                            } else {
                                updated_at
                            },
                            updated_at,
                            step_count: None,
                            source_path: rollout_clean.filter(|p| Path::new(p).is_file()),
                            source_scope: normalized_source_scope("codex", codex_dir),
                            execution_profile_id: profile_id.map(str::to_string),
                        });
                    }
                }
            }
        }
    }

    // Supplement/fallback from recent ~/.codex/sessions/**/*.jsonl if SQLite returned empty
    if results.is_empty() {
        let sessions_dir = codex_dir.join("sessions");
        let mut jsonl_files: Vec<(i64, PathBuf)> = Vec::new();
        collect_jsonl_recursive(&sessions_dir, 4, &mut jsonl_files);
        jsonl_files.sort_by(|a, b| b.0.cmp(&a.0));
        for (mtime, path) in jsonl_files.into_iter().take(60) {
            if let Some((session_id, cwd)) = read_codex_rollout_meta(&path) {
                if seen_ids.contains(&session_id) || cwd.is_empty() {
                    continue;
                }
                let msgs = parse_codex_messages(&path, 4);
                let title = index_titles
                    .get(&session_id)
                    .map(|(t, _)| t.clone())
                    .or_else(|| {
                        msgs.iter()
                            .find(|m| m.role == "user")
                            .map(|m| clean_session_title(&m.text, 80))
                    })
                    .unwrap_or_default();
                if title.is_empty() {
                    continue;
                }
                seen_ids.insert(session_id.clone());
                results.push(DiscoveredLocalSession {
                    provider: "codex".to_string(),
                    preset: "codex-acp".to_string(),
                    native_session_id: session_id,
                    title,
                    preview: msgs.last().map(|m| clean_session_title(&m.text, 120)),
                    workspace_root: cwd,
                    runtime_status: "unknown".to_string(),
                    created_at: msgs.first().map(|m| m.timestamp).unwrap_or(mtime),
                    updated_at: mtime,
                    step_count: None,
                    source_path: Some(path.to_string_lossy().into_owned()),
                    source_scope: normalized_source_scope("codex", codex_dir),
                    execution_profile_id: profile_id.map(str::to_string),
                });
            }
        }
    }

    results
}

fn collect_jsonl_recursive(dir: &Path, max_depth: usize, out: &mut Vec<(i64, PathBuf)>) {
    if max_depth == 0 || !dir.is_dir() {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let name = entry.file_name();
            if name != "subagents" {
                collect_jsonl_recursive(&path, max_depth - 1, out);
            }
        } else if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            let mtime = entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .map(system_time_to_ms)
                .unwrap_or(0);
            out.push((mtime, path));
        }
    }
}

fn read_codex_rollout_meta(path: &Path) -> Option<(String, String)> {
    let file = File::open(path).ok()?;
    let reader = BufReader::new(file);
    for line in reader.lines().take(16).map_while(Result::ok) {
        if let Ok(val) = serde_json::from_str::<Value>(&line) {
            if val.get("type").and_then(|v| v.as_str()) == Some("session_meta") {
                if let Some(payload) = val.get("payload") {
                    let id = payload
                        .get("id")
                        .or_else(|| payload.get("session_id"))
                        .and_then(|v| v.as_str())?
                        .trim()
                        .to_string();
                    let cwd = payload
                        .get("cwd")
                        .and_then(|v| v.as_str())
                        .map(decode_file_uri_or_path)
                        .unwrap_or_default();
                    return Some((id, cwd));
                }
            }
        }
    }
    None
}

struct ClaudeHistAggregate {
    session_id: String,
    workspace_root: String,
    title: String,
    preview: String,
    created_at: i64,
    updated_at: i64,
    step_count: i64,
}

fn collect_claude_sessions(home: &Path) -> Vec<DiscoveredLocalSession> {
    let claude_dir = home.join(".claude");
    if !claude_dir.is_dir() {
        return Vec::new();
    }

    // Index existing project transcript paths by session stem `<uuid>.jsonl`
    let mut transcript_by_id: HashMap<String, (i64, PathBuf)> = HashMap::new();
    let projects_dir = claude_dir.join("projects");
    if projects_dir.is_dir() {
        if let Ok(project_entries) = fs::read_dir(&projects_dir) {
            for proj in project_entries.flatten() {
                if !proj.path().is_dir() {
                    continue;
                }
                if let Ok(files) = fs::read_dir(proj.path()) {
                    for file in files.flatten() {
                        let path = file.path();
                        if path.is_file()
                            && path.extension().and_then(|e| e.to_str()) == Some("jsonl")
                        {
                            if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                                let mtime = file
                                    .metadata()
                                    .ok()
                                    .and_then(|m| m.modified().ok())
                                    .map(system_time_to_ms)
                                    .unwrap_or(0);
                                transcript_by_id.insert(stem.to_string(), (mtime, path));
                            }
                        }
                    }
                }
            }
        }
    }

    let mut aggregated: HashMap<String, ClaudeHistAggregate> = HashMap::new();
    let history_path = claude_dir.join("history.jsonl");
    if let Ok(file) = File::open(&history_path) {
        let reader = BufReader::new(file);
        for line in reader.lines().map_while(Result::ok) {
            if line.trim().is_empty() {
                continue;
            }
            let Ok(val) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let Some(session_id) = val
                .get("sessionId")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
            else {
                continue;
            };
            let display_raw = val
                .get("display")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            let project_raw = val
                .get("project")
                .and_then(|v| v.as_str())
                .map(decode_file_uri_or_path)
                .unwrap_or_default();
            let ts = val
                .get("timestamp")
                .and_then(|v| v.as_i64())
                .map(normalize_epoch_ms)
                .unwrap_or(0);
            if ts == 0 {
                continue;
            }

            let cleaned = clean_session_title(display_raw, 80);
            let is_slash = cleaned.starts_with('/') && cleaned.split_whitespace().count() <= 2;

            let entry =
                aggregated
                    .entry(session_id.to_string())
                    .or_insert_with(|| ClaudeHistAggregate {
                        session_id: session_id.to_string(),
                        workspace_root: project_raw.clone(),
                        title: if !is_slash {
                            cleaned.clone()
                        } else {
                            String::new()
                        },
                        preview: cleaned.clone(),
                        created_at: ts,
                        updated_at: ts,
                        step_count: 0,
                    });

            if entry.workspace_root.is_empty() && !project_raw.is_empty() {
                entry.workspace_root = project_raw;
            }
            if entry.title.is_empty() && !cleaned.is_empty() && !is_slash {
                entry.title = cleaned.clone();
            }
            if !cleaned.is_empty() && ts >= entry.updated_at {
                entry.preview = clean_session_title(display_raw, 120);
            }
            entry.created_at = entry.created_at.min(ts);
            entry.updated_at = entry.updated_at.max(ts);
            entry.step_count += 1;
        }
    }

    let mut results = Vec::new();
    let mut seen_ids = HashSet::new();

    for (_, agg) in aggregated {
        if agg.workspace_root.is_empty() || (agg.title.is_empty() && agg.preview.is_empty()) {
            continue;
        }
        let title = if agg.title.is_empty() {
            agg.preview.clone()
        } else {
            agg.title
        };
        if title.is_empty() {
            continue;
        }
        let source_meta = transcript_by_id.get(&agg.session_id);
        let updated_at = source_meta
            .map(|(mtime, _)| (*mtime).max(agg.updated_at))
            .unwrap_or(agg.updated_at);
        seen_ids.insert(agg.session_id.clone());
        results.push(DiscoveredLocalSession {
            provider: "claude".to_string(),
            preset: "claude-code".to_string(),
            native_session_id: agg.session_id,
            title,
            preview: if agg.preview.is_empty() {
                None
            } else {
                Some(agg.preview)
            },
            workspace_root: agg.workspace_root,
            runtime_status: "idle".to_string(),
            created_at: agg.created_at,
            updated_at,
            step_count: Some(agg.step_count),
            source_path: source_meta.map(|(_, p)| p.to_string_lossy().into_owned()),
            source_scope: "default".to_string(),
            execution_profile_id: None,
        });
    }

    // Add recent project transcripts missing from history.jsonl
    let mut extra_files: Vec<(i64, String, PathBuf)> = transcript_by_id
        .into_iter()
        .filter(|(id, _)| !seen_ids.contains(id))
        .map(|(id, (mtime, path))| (mtime, id, path))
        .collect();
    extra_files.sort_by(|a, b| b.0.cmp(&a.0));

    for (mtime, id, path) in extra_files.into_iter().take(40) {
        if mtime == 0 {
            continue;
        }
        if let Some(session) = summarize_claude_transcript(&id, &path, mtime) {
            results.push(session);
        }
    }

    results
}

fn summarize_claude_transcript(
    fallback_id: &str,
    path: &Path,
    mtime: i64,
) -> Option<DiscoveredLocalSession> {
    let file = File::open(path).ok()?;
    let reader = BufReader::new(file);
    let mut session_id = fallback_id.to_string();
    let mut cwd = String::new();
    let mut title = String::new();
    let mut first_ts: Option<i64> = None;

    for line in reader.lines().take(60).map_while(Result::ok) {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(val) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(sid) = val.get("sessionId").and_then(|v| v.as_str()) {
            if !sid.trim().is_empty() {
                session_id = sid.trim().to_string();
            }
        }
        if cwd.is_empty() {
            if let Some(c) = val.get("cwd").and_then(|v| v.as_str()) {
                cwd = decode_file_uri_or_path(c);
            }
        }
        if first_ts.is_none() {
            first_ts = val
                .get("timestamp")
                .and_then(|v| v.as_str())
                .and_then(parse_iso_to_epoch_ms);
        }
        if title.is_empty() && val.get("type").and_then(|v| v.as_str()) == Some("user") {
            let text = extract_claude_content_text(val.pointer("/message/content"));
            let cleaned = clean_session_title(&text, 80);
            if !cleaned.is_empty() && !cleaned.starts_with("<local-command") {
                title = cleaned;
            }
        }
        if !cwd.is_empty() && !title.is_empty() {
            break;
        }
    }

    if cwd.is_empty() || title.is_empty() {
        return None;
    }

    Some(DiscoveredLocalSession {
        provider: "claude".to_string(),
        preset: "claude-code".to_string(),
        native_session_id: session_id,
        title: title.clone(),
        preview: Some(title),
        workspace_root: cwd,
        runtime_status: "idle".to_string(),
        created_at: first_ts.unwrap_or(mtime),
        updated_at: mtime,
        step_count: None,
        source_path: Some(path.to_string_lossy().into_owned()),
        source_scope: "default".to_string(),
        execution_profile_id: None,
    })
}

fn collect_pi_sessions(app_local_data_dir: Option<&Path>) -> Vec<DiscoveredLocalSession> {
    let Some(data_dir) = app_local_data_dir else {
        return Vec::new();
    };
    let index_path = data_dir
        .join("pi")
        .join("agent")
        .join("rocketx-thread-index.json");
    let Ok(raw) = fs::read_to_string(&index_path) else {
        return Vec::new();
    };
    let Ok(val) = serde_json::from_str::<Value>(&raw) else {
        return Vec::new();
    };
    let Some(threads) = val.get("threads").and_then(|v| v.as_object()) else {
        return Vec::new();
    };

    let mut results = Vec::new();
    for (key, item) in threads {
        if item.get("archived").and_then(|v| v.as_bool()) == Some(true) {
            continue;
        }
        let id = item
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or(key)
            .trim()
            .to_string();
        let cwd = item
            .get("cwd")
            .and_then(|v| v.as_str())
            .map(decode_file_uri_or_path)
            .unwrap_or_default();
        if id.is_empty() || cwd.is_empty() {
            continue;
        }
        let name = item.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let preview_raw = item.get("preview").and_then(|v| v.as_str()).unwrap_or("");
        let title = clean_session_title(
            if name.trim().is_empty() {
                preview_raw
            } else {
                name
            },
            80,
        );
        if title.is_empty() {
            continue;
        }
        let updated_at =
            normalize_epoch_ms(item.get("updatedAt").and_then(|v| v.as_i64()).unwrap_or(0));
        let created_at = normalize_epoch_ms(
            item.get("createdAt")
                .and_then(|v| v.as_i64())
                .unwrap_or(updated_at),
        );
        let session_file = item
            .get("sessionFile")
            .and_then(|v| v.as_str())
            .map(decode_file_uri_or_path)
            .filter(|p| !p.is_empty() && Path::new(p).is_file());

        results.push(DiscoveredLocalSession {
            provider: "pi".to_string(),
            preset: "pi".to_string(),
            native_session_id: id,
            title,
            preview: {
                let p = clean_session_title(preview_raw, 120);
                if p.is_empty() {
                    None
                } else {
                    Some(p)
                }
            },
            workspace_root: cwd,
            runtime_status: "idle".to_string(),
            created_at: if created_at > 0 {
                created_at
            } else {
                updated_at
            },
            updated_at,
            step_count: None,
            source_path: session_file,
            source_scope: "default".to_string(),
            execution_profile_id: None,
        });
    }
    results
}

fn discover_local_sessions_sync(
    home: Option<PathBuf>,
    app_local_data_dir: Option<PathBuf>,
    limit: usize,
) -> Vec<DiscoveredLocalSession> {
    let mut all = Vec::new();
    if let Some(home_dir) = home.as_deref() {
        all.extend(collect_antigravity_sessions(home_dir));
        all.extend(collect_codex_sessions(home_dir));
        all.extend(collect_claude_sessions(home_dir));
    }
    all.extend(collect_pi_sessions(app_local_data_dir.as_deref()));

    deduplicate_sessions(all, limit)
}

fn deduplicate_sessions(
    all: Vec<DiscoveredLocalSession>,
    limit: usize,
) -> Vec<DiscoveredLocalSession> {
    let mut deduped: HashMap<(String, String, String), DiscoveredLocalSession> = HashMap::new();
    for item in all {
        let key = (
            item.provider.clone(),
            item.source_scope.clone(),
            item.native_session_id.clone(),
        );
        match deduped.get(&key) {
            Some(prev) if prev.updated_at >= item.updated_at => {}
            _ => {
                deduped.insert(key, item);
            }
        }
    }

    let mut list: Vec<DiscoveredLocalSession> = deduped.into_values().collect();
    list.sort_by(|a, b| {
        let a_running = a.runtime_status == "running";
        let b_running = b.runtime_status == "running";
        b_running
            .cmp(&a_running)
            .then_with(|| b.updated_at.cmp(&a.updated_at))
    });
    list.truncate(limit.clamp(1, MAX_DISCOVER_LIMIT));
    list
}

fn extract_claude_content_text(content: Option<&Value>) -> String {
    let Some(val) = content else {
        return String::new();
    };
    if let Some(s) = val.as_str() {
        return s.to_string();
    }
    if let Some(arr) = val.as_array() {
        let parts: Vec<String> = arr
            .iter()
            .filter_map(|item| {
                let kind = item.get("type").and_then(|v| v.as_str()).unwrap_or("text");
                if kind == "text" || kind == "input_text" || kind == "output_text" {
                    item.get("text")
                        .and_then(|v| v.as_str())
                        .map(str::to_string)
                } else {
                    None
                }
            })
            .filter(|s| !s.trim().is_empty())
            .collect();
        return parts.join("\n");
    }
    String::new()
}

pub(crate) fn parse_antigravity_messages(path: &Path, limit: usize) -> Vec<LocalSessionMessage> {
    let Ok(file) = File::open(path) else {
        return Vec::new();
    };
    let reader = BufReader::new(file);
    let mut out = Vec::new();
    for (idx, line) in reader.lines().map_while(Result::ok).enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(val) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let step_type = val.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let ts = val
            .get("created_at")
            .and_then(|v| v.as_str())
            .and_then(parse_iso_to_epoch_ms)
            .unwrap_or(0);
        match step_type {
            "USER_INPUT" => {
                let raw = val.get("content").and_then(|v| v.as_str()).unwrap_or("");
                let cleaned = if let Some(start) = raw.find("<USER_REQUEST>") {
                    let after = &raw[start + "<USER_REQUEST>".len()..];
                    let end = after.find("</USER_REQUEST>").unwrap_or(after.len());
                    after[..end].trim().to_string()
                } else {
                    raw.trim().to_string()
                };
                if !cleaned.is_empty() {
                    out.push(LocalSessionMessage {
                        id: format!("agy-{idx}"),
                        role: "user".to_string(),
                        text: cleaned,
                        timestamp: ts,
                    });
                }
            }
            "PLANNER_RESPONSE" => {
                let content = val
                    .get("content")
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .unwrap_or("");
                if !content.is_empty() {
                    out.push(LocalSessionMessage {
                        id: format!("agy-{idx}"),
                        role: "assistant".to_string(),
                        text: content.to_string(),
                        timestamp: ts,
                    });
                }
            }
            _ => {}
        }
    }
    if out.len() > limit {
        out.drain(0..out.len() - limit);
    }
    out
}

pub(crate) fn parse_codex_messages(path: &Path, limit: usize) -> Vec<LocalSessionMessage> {
    let Ok(file) = File::open(path) else {
        return Vec::new();
    };
    let reader = BufReader::new(file);
    let mut event_msgs: Vec<LocalSessionMessage> = Vec::new();
    let mut response_msgs: Vec<LocalSessionMessage> = Vec::new();

    for (idx, line) in reader.lines().map_while(Result::ok).enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(val) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let ts = val
            .get("timestamp")
            .and_then(|v| v.as_str())
            .and_then(parse_iso_to_epoch_ms)
            .unwrap_or(0);
        let row_type = val.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let Some(payload) = val.get("payload") else {
            continue;
        };
        let payload_type = payload.get("type").and_then(|v| v.as_str()).unwrap_or("");

        if row_type == "event_msg" {
            match payload_type {
                "user_message" => {
                    if let Some(msg) = payload.get("message").and_then(|v| v.as_str()) {
                        let t = msg.trim();
                        if !t.is_empty() && !is_system_injected_prompt(t) {
                            event_msgs.push(LocalSessionMessage {
                                id: format!("codex-ev-{idx}"),
                                role: "user".to_string(),
                                text: t.to_string(),
                                timestamp: ts,
                            });
                        }
                    }
                }
                "agent_message" => {
                    if let Some(msg) = payload.get("message").and_then(|v| v.as_str()) {
                        let t = msg.trim();
                        if !t.is_empty() {
                            event_msgs.push(LocalSessionMessage {
                                id: format!("codex-ev-{idx}"),
                                role: "assistant".to_string(),
                                text: t.to_string(),
                                timestamp: ts,
                            });
                        }
                    }
                }
                _ => {}
            }
        } else if row_type == "response_item" && payload_type == "message" {
            let role = payload.get("role").and_then(|v| v.as_str()).unwrap_or("");
            if role == "user" || role == "assistant" {
                let text = extract_claude_content_text(payload.get("content"));
                let trimmed = text.trim();
                if !trimmed.is_empty() && (role != "user" || !is_system_injected_prompt(trimmed)) {
                    response_msgs.push(LocalSessionMessage {
                        id: format!("codex-resp-{idx}"),
                        role: role.to_string(),
                        text: trimmed.to_string(),
                        timestamp: ts,
                    });
                }
            }
        }
    }

    let mut chosen = if !event_msgs.is_empty() {
        event_msgs
    } else {
        response_msgs
    };
    if chosen.len() > limit {
        chosen.drain(0..chosen.len() - limit);
    }
    chosen
}

pub(crate) fn parse_claude_messages(path: &Path, limit: usize) -> Vec<LocalSessionMessage> {
    let Ok(file) = File::open(path) else {
        return Vec::new();
    };
    let reader = BufReader::new(file);
    let mut out = Vec::new();
    for (idx, line) in reader.lines().map_while(Result::ok).enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(val) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let row_type = val.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if row_type != "user" && row_type != "assistant" {
            continue;
        }
        let text = extract_claude_content_text(val.pointer("/message/content"));
        let trimmed = text.trim();
        if trimmed.is_empty() || trimmed.starts_with("<local-command") {
            continue;
        }
        let ts = val
            .get("timestamp")
            .and_then(|v| v.as_str())
            .and_then(parse_iso_to_epoch_ms)
            .unwrap_or(0);
        out.push(LocalSessionMessage {
            id: format!("claude-{idx}"),
            role: row_type.to_string(),
            text: trimmed.to_string(),
            timestamp: ts,
        });
    }
    if out.len() > limit {
        out.drain(0..out.len() - limit);
    }
    out
}

pub(crate) fn parse_pi_messages(path: &Path, limit: usize) -> Vec<LocalSessionMessage> {
    let Ok(file) = File::open(path) else {
        return Vec::new();
    };
    let reader = BufReader::new(file);
    let mut out = Vec::new();
    for (idx, line) in reader.lines().map_while(Result::ok).enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(val) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if val.get("type").and_then(|v| v.as_str()) != Some("message") {
            continue;
        }
        let role = val
            .pointer("/message/role")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if role != "user" && role != "assistant" {
            continue;
        }
        let text = extract_claude_content_text(val.pointer("/message/content"));
        let trimmed = text.trim();
        if trimmed.is_empty() {
            continue;
        }
        let ts = val
            .get("timestamp")
            .and_then(|v| v.as_str())
            .and_then(parse_iso_to_epoch_ms)
            .unwrap_or(0);
        out.push(LocalSessionMessage {
            id: format!("pi-{idx}"),
            role: role.to_string(),
            text: trimmed.to_string(),
            timestamp: ts,
        });
    }
    if out.len() > limit {
        out.drain(0..out.len() - limit);
    }
    out
}

pub(crate) fn find_transcript_for_session(
    provider: &str,
    session_id: &str,
    home: Option<&Path>,
    app_local_data_dir: Option<&Path>,
) -> Option<PathBuf> {
    let safe_id = session_id.trim();
    if safe_id.is_empty()
        || safe_id.contains('/')
        || safe_id.contains('\\')
        || safe_id.contains("..")
    {
        return None;
    }
    match provider {
        "antigravity" => home.map(|h| {
            h.join(".gemini")
                .join("antigravity")
                .join("brain")
                .join(safe_id)
                .join(".system_generated")
                .join("logs")
                .join("transcript.jsonl")
        }),
        "claude" => {
            let projects = home?.join(".claude").join("projects");
            let target_name = format!("{safe_id}.jsonl");
            let entries = fs::read_dir(projects).ok()?;
            for entry in entries.flatten() {
                let candidate = entry.path().join(&target_name);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
            None
        }
        "codex" => {
            let codex_dir = home?.join(".codex");
            let mut files = Vec::new();
            collect_jsonl_recursive(&codex_dir.join("sessions"), 4, &mut files);
            files.into_iter().map(|(_, p)| p).find(|p| {
                p.file_name()
                    .is_some_and(|n| n.to_string_lossy().contains(safe_id))
            })
        }
        "pi" => {
            let sessions_dir = app_local_data_dir?
                .join("pi")
                .join("agent")
                .join("sessions");
            let entries = fs::read_dir(sessions_dir).ok()?;
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file()
                    && path
                        .file_name()
                        .is_some_and(|n| n.to_string_lossy().contains(safe_id))
                {
                    return Some(path);
                }
            }
            None
        }
        _ => None,
    }
}

fn is_path_within_allowed_roots(
    candidate: &Path,
    home: Option<&Path>,
    app_local_data_dir: Option<&Path>,
) -> bool {
    let Ok(canonical_candidate) = fs::canonicalize(candidate) else {
        return false;
    };
    let mut allowed_roots = Vec::new();
    if let Some(h) = home {
        allowed_roots.push(h.join(".codex"));
        allowed_roots.push(h.join(".claude"));
        allowed_roots.push(h.join(".gemini").join("antigravity"));
    }
    if let Some(d) = app_local_data_dir {
        allowed_roots.push(d.join("pi"));
    }
    allowed_roots.into_iter().any(|root| {
        fs::canonicalize(root)
            .map(|canonical_root| canonical_candidate.starts_with(canonical_root))
            .unwrap_or(false)
    })
}

pub(crate) fn read_local_session_messages_sync(
    provider: &str,
    session_id: &str,
    source_path: Option<&str>,
    home: Option<PathBuf>,
    app_local_data_dir: Option<PathBuf>,
    limit: usize,
) -> Vec<LocalSessionMessage> {
    let candidate = source_path
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| PathBuf::from(decode_file_uri_or_path(s)))
        .or_else(|| {
            find_transcript_for_session(
                provider,
                session_id,
                home.as_deref(),
                app_local_data_dir.as_deref(),
            )
        });

    let Some(path) = candidate else {
        return Vec::new();
    };
    if !is_path_within_allowed_roots(&path, home.as_deref(), app_local_data_dir.as_deref()) {
        return Vec::new();
    }

    let capped = limit.clamp(1, MAX_MESSAGE_LIMIT);
    match provider {
        "antigravity" => parse_antigravity_messages(&path, capped),
        "codex" => parse_codex_messages(&path, capped),
        "claude" => parse_claude_messages(&path, capped),
        "pi" => parse_pi_messages(&path, capped),
        _ => Vec::new(),
    }
}

#[tauri::command]
pub async fn acp_local_sessions_discover(
    app: tauri::AppHandle,
    limit: Option<usize>,
) -> Result<Vec<DiscoveredLocalSession>, String> {
    let home = user_home_dir();
    let app_local_data_dir = app.path().app_local_data_dir().ok();
    let capped_limit = limit
        .unwrap_or(DEFAULT_DISCOVER_LIMIT)
        .clamp(1, MAX_DISCOVER_LIMIT);
    let sources = crate::acp::codex_session_sources(&app)?;

    tokio::task::spawn_blocking(move || {
        let mut sessions =
            discover_local_sessions_sync(home.clone(), app_local_data_dir, MAX_DISCOVER_LIMIT);
        sessions.retain(|s| s.provider != "codex");
        let mut sources = sources;
        if let Some(home) = home {
            sources.push(CodexSessionSource {
                root: default_codex_root(&home),
                profile_id: None,
            });
        }
        for source in sources {
            sessions.extend(collect_codex_sessions_from_root(
                &source.root,
                source.profile_id.as_deref(),
            ));
        }
        deduplicate_sessions(sessions, capped_limit)
    })
    .await
    .map_err(|error| format!("扫描本机会话失败：{error}"))
}

#[tauri::command]
pub async fn acp_local_session_handoff(
    app: tauri::AppHandle,
    session_id: String,
    source_scope: String,
    workspace_root: String,
    profile_id: String,
    account_scope: String,
    host_device_id: String,
) -> Result<String, String> {
    if account_scope.trim().is_empty() || host_device_id.trim().is_empty() {
        return Err("会话交接需要明确账号和设备".to_string());
    }
    let profile = crate::acp::native_codex_profile(&app, &profile_id)?;
    if profile.source_scope != source_scope {
        return Err("原会话来源与执行配置不一致，请重新扫描并选择正确配置".into());
    }
    let sessions = collect_codex_sessions_from_root(&profile.codex_home, Some(&profile_id));
    let session = sessions
        .iter()
        .find(|s| s.native_session_id == session_id)
        .ok_or("原生会话已不存在，禁止新建会话代替恢复")?;
    let cwd = fs::canonicalize(&workspace_root).map_err(|_| "原工作目录不存在")?;
    if fs::canonicalize(&session.workspace_root).ok().as_ref() != Some(&cwd) {
        return Err("恢复目录与原生会话目录不一致".to_string());
    }
    let token = uuid::Uuid::new_v4().to_string();
    let mut pending = HANDOFFS.lock().map_err(|_| "会话交接锁不可用")?;
    pending.retain(|_, p| p.issued_at.elapsed().unwrap_or(Duration::MAX) < Duration::from_secs(90));
    pending.insert(
        token.clone(),
        PendingHandoff {
            session_id,
            source_scope,
            workspace_root: cwd,
            profile_id,
            profile_fingerprint: profile.fingerprint().to_string(),
            account_scope,
            host_device_id,
            issued_at: SystemTime::now(),
        },
    );
    Ok(token)
}

#[tauri::command]
pub async fn acp_local_session_messages(
    app: tauri::AppHandle,
    provider: String,
    session_id: String,
    source_path: Option<String>,
    source_scope: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<LocalSessionMessage>, String> {
    let home = user_home_dir();
    let app_local_data_dir = app.path().app_local_data_dir().ok();
    let capped_limit = limit
        .unwrap_or(DEFAULT_MESSAGE_LIMIT)
        .clamp(1, MAX_MESSAGE_LIMIT);
    let mut codex_sources = crate::acp::codex_session_sources(&app)?;
    if let Some(ref home) = home {
        codex_sources.push(CodexSessionSource {
            root: default_codex_root(home),
            profile_id: None,
        });
    }

    tokio::task::spawn_blocking(move || {
        if provider == "codex" {
            for source in codex_sources {
                if source_scope
                    .as_deref()
                    .is_some_and(|s| s != normalized_source_scope("codex", &source.root))
                {
                    continue;
                }
                if let Some(session) =
                    collect_codex_sessions_from_root(&source.root, source.profile_id.as_deref())
                        .into_iter()
                        .find(|s| s.native_session_id == session_id)
                {
                    if let Some(path) = session.source_path {
                        let path = PathBuf::from(path);
                        if fs::canonicalize(&path)
                            .ok()
                            .zip(fs::canonicalize(&source.root).ok())
                            .is_some_and(|(p, root)| p.starts_with(root))
                        {
                            return parse_codex_messages(&path, capped_limit);
                        }
                    }
                }
            }
            return Vec::new();
        }
        read_local_session_messages_sync(
            &provider,
            &session_id,
            source_path.as_deref(),
            home,
            app_local_data_dir,
            capped_limit,
        )
    })
    .await
    .map_err(|error| format!("读取本机会话历史失败：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn distinct_codex_sources_keep_same_native_id_and_aliases_deduplicate() {
        let root = std::env::temp_dir().join(format!("rcx-codex-source-{}", uuid::Uuid::new_v4()));
        let mut found = Vec::new();
        for name in ["first", "second"] {
            let source = root.join(name);
            fs::create_dir_all(source.join("sessions")).unwrap();
            fs::write(source.join("sessions/rollout.jsonl"), format!("{}\n{}\n", r#"{"timestamp":"2026-11-15T00:00:00Z","type":"session_meta","payload":{"id":"same-id","cwd":"D:/work"}}"#, r#"{"timestamp":"2026-11-15T00:00:01Z","type":"event_msg","payload":{"type":"user_message","message":"source-specific task"}}"#)).unwrap();
            let sessions = collect_codex_sessions_from_root(&source, Some(name));
            assert_eq!(sessions.len(), 1);
            assert_eq!(sessions[0].runtime_status, "unknown");
            assert_eq!(sessions[0].execution_profile_id.as_deref(), Some(name));
            found.extend(sessions.clone());
            found.extend(collect_codex_sessions_from_root(
                &source.join("."),
                Some("alias"),
            ));
        }
        assert_eq!(deduplicate_sessions(found, 20).len(), 2);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn native_handoff_is_bound_expiring_and_single_use() {
        let root = std::env::temp_dir().join(format!("rcx-handoff-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let cwd = fs::canonicalize(&root).unwrap();
        for (wrong_account, expired, changed_profile) in [
            (false, false, false),
            (true, false, false),
            (false, true, false),
            (false, false, true),
        ] {
            let token = uuid::Uuid::new_v4().to_string();
            HANDOFFS.lock().unwrap().insert(
                token.clone(),
                PendingHandoff {
                    session_id: "session-id".into(),
                    source_scope: "source".into(),
                    workspace_root: cwd.clone(),
                    profile_id: "profile".into(),
                    profile_fingerprint: "fingerprint".into(),
                    account_scope: "account".into(),
                    host_device_id: "host".into(),
                    issued_at: if expired {
                        SystemTime::now() - Duration::from_secs(91)
                    } else {
                        SystemTime::now()
                    },
                },
            );
            let auth = NativeResumeAuthorization {
                token,
                session_id: "session-id".into(),
                source_scope: "source".into(),
                account_scope: if wrong_account { "other" } else { "account" }.into(),
                host_device_id: "host".into(),
            };
            assert_eq!(
                consume_native_handoff(
                    &auth,
                    "profile",
                    if changed_profile {
                        "edited"
                    } else {
                        "fingerprint"
                    },
                    "source",
                    &cwd
                )
                .is_ok(),
                !wrong_account && !expired && !changed_profile
            );
            assert!(
                consume_native_handoff(&auth, "profile", "fingerprint", "source", &cwd).is_err()
            );
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn native_handoff_concurrent_consumers_get_only_one_admission() {
        let root = std::env::temp_dir().join(format!("rcx-handoff-race-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let cwd = fs::canonicalize(&root).unwrap();
        let token = uuid::Uuid::new_v4().to_string();
        HANDOFFS.lock().unwrap().insert(
            token.clone(),
            PendingHandoff {
                session_id: "thread".into(),
                source_scope: "source".into(),
                workspace_root: cwd.clone(),
                profile_id: "profile".into(),
                profile_fingerprint: "snapshot".into(),
                account_scope: "account".into(),
                host_device_id: "host".into(),
                issued_at: SystemTime::now(),
            },
        );
        let auth = NativeResumeAuthorization {
            token,
            session_id: "thread".into(),
            source_scope: "source".into(),
            account_scope: "account".into(),
            host_device_id: "host".into(),
        };
        let consumers = (0..12)
            .map(|_| {
                let auth = auth.clone();
                let cwd = cwd.clone();
                std::thread::spawn(move || {
                    let _gate = NATIVE_CODEX_START_LOCK.lock().unwrap();
                    consume_native_handoff(&auth, "profile", "snapshot", "source", &cwd).is_ok()
                })
            })
            .collect::<Vec<_>>();
        assert_eq!(
            consumers
                .into_iter()
                .map(|consumer| consumer.join().unwrap())
                .filter(|accepted| *accepted)
                .count(),
            1
        );
        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn parses_iso_timestamps_and_percent_uris() {
        let z_ms = parse_iso_to_epoch_ms("2026-11-15T01:52:07.862Z").expect("iso Z");
        let plus_ms =
            parse_iso_to_epoch_ms("2026-11-15 01:52:07.862563+00:00").expect("space +00:00");
        assert_eq!(z_ms, plus_ms);

        let tz8_ms = parse_iso_to_epoch_ms("2026-11-15T09:52:07.862+08:00").expect("+08:00");
        assert_eq!(tz8_ms, z_ms);

        let decoded = decode_file_uri_or_path("file:///d%3A/Repos/rocketchatx");
        if cfg!(windows) {
            assert_eq!(decoded, r"d:\Repos\rocketchatx");
        } else {
            assert_eq!(decoded, "d:/Repos/rocketchatx");
        }
        assert_eq!(
            decode_file_uri_or_path(r"\\?\C:\Users\lus\proj"),
            decode_file_uri_or_path(r"C:\Users\lus\proj")
        );
    }

    #[test]
    fn discovers_local_sessions_from_temp_fixture_roots_and_reads_messages() {
        let root = std::env::temp_dir().join(format!("rcx-local-sess-{}", uuid::Uuid::new_v4()));
        let home = root.join("home");
        let app_data = root.join("app_data");

        // 1. Antigravity fixture
        let agy_dir = home.join(".gemini").join("antigravity");
        let agy_log = agy_dir
            .join("brain")
            .join("agy-1")
            .join(".system_generated")
            .join("logs");
        fs::create_dir_all(&agy_log).expect("create agy log dir");
        let agy_transcript = agy_log.join("transcript.jsonl");
        fs::write(
            &agy_transcript,
            concat!(
                r#"{"step_index":0,"type":"USER_INPUT","created_at":"2026-11-15T01:00:00Z","content":"<USER_REQUEST>\n实现本地会话同步\n</USER_REQUEST>\n<ADDITIONAL_METADATA>ignored</ADDITIONAL_METADATA>"}"#,
                "\n",
                r#"{"step_index":1,"type":"PLANNER_RESPONSE","created_at":"2026-11-15T01:01:00Z","content":"好的，我先检查看板代码。"}"#,
                "\n"
            ),
        )
        .expect("write agy transcript");
        {
            let conn = Connection::open(agy_dir.join("conversation_summaries.db")).expect("agy db");
            conn.execute_batch(
                "CREATE TABLE conversation_summaries (
                    conversation_id TEXT PRIMARY KEY,
                    title TEXT,
                    preview TEXT,
                    step_count INTEGER,
                    last_modified_time TEXT,
                    workspace_uris TEXT,
                    status TEXT,
                    nesting_depth INTEGER,
                    killed INTEGER
                );
                INSERT INTO conversation_summaries VALUES
                  ('agy-1', '实现本地会话同步', '好的，我先检查看板代码', 12, '2026-11-15 02:00:00.000+00:00', '[\"file:///d%3A/Repos/rocketchatx\"]', 'CASCADE_RUN_STATUS_RUNNING', 0, 0),
                  ('agy-sub', 'Hidden Subagent', 'ignore', 3, '2026-11-15 02:01:00.000+00:00', '[\"file:///d%3A/Repos/rocketchatx\"]', 'CASCADE_RUN_STATUS_IDLE', 1, 0);"
            )
            .expect("seed agy db");
        }

        // 2. Codex fixture
        let codex_dir = home.join(".codex");
        fs::create_dir_all(codex_dir.join("sessions")).expect("create codex dir");
        let codex_rollout = codex_dir.join("sessions").join("rollout-codex-1.jsonl");
        fs::write(
            &codex_rollout,
            concat!(
                r#"{"timestamp":"2026-11-15T00:00:00Z","type":"session_meta","payload":{"id":"codex-1","cwd":"\\\\?\\D:\\Repos\\rocketchatx"}}"#,
                "\n",
                r##"{"timestamp":"2026-11-15T00:00:01Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions\nignored"}]}}"##,
                "\n",
                r#"{"timestamp":"2026-11-15T00:00:02Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"修复登录边界测试"}]}}"#,
                "\n",
                r#"{"timestamp":"2026-11-15T00:00:05Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"已补齐测试并通过。"}]}}"#,
                "\n"
            ),
        )
        .expect("write codex rollout");
        {
            let conn = Connection::open(codex_dir.join("state_5.sqlite")).expect("codex db");
            conn.execute(
                "CREATE TABLE threads (
                    id TEXT PRIMARY KEY,
                    cwd TEXT,
                    title TEXT,
                    created_at INTEGER,
                    updated_at INTEGER,
                    archived INTEGER,
                    rollout_path TEXT,
                    has_user_event INTEGER
                )",
                [],
            )
            .expect("create codex threads");
            conn.execute(
                "INSERT INTO threads VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, 1)",
                rusqlite::params![
                    "codex-1",
                    r"\\?\D:\Repos\rocketchatx",
                    "修复登录边界测试",
                    1794700000_i64,
                    1794700500_i64,
                    codex_rollout.to_string_lossy().into_owned(),
                ],
            )
            .expect("insert codex thread");
        }

        // 3. Claude fixture
        let claude_dir = home.join(".claude");
        let claude_proj = claude_dir.join("projects").join("proj-a");
        fs::create_dir_all(&claude_proj).expect("create claude proj");
        let claude_jsonl = claude_proj.join("claude-1.jsonl");
        fs::write(
            &claude_jsonl,
            concat!(
                r#"{"type":"user","cwd":"D:\\Repos\\plcopen","sessionId":"claude-1","timestamp":"2026-11-14T10:00:00Z","message":{"role":"user","content":"重构 PLC 编译器"}}"#,
                "\n",
                r#"{"type":"assistant","cwd":"D:\\Repos\\plcopen","sessionId":"claude-1","timestamp":"2026-11-14T10:01:00Z","message":{"role":"assistant","content":[{"type":"text","text":"已完成 AST 拆解。"}]}}"#,
                "\n"
            ),
        )
        .expect("write claude jsonl");
        {
            let mut f = File::create(claude_dir.join("history.jsonl")).expect("claude history");
            writeln!(
                f,
                r#"{{"display":"重构 PLC 编译器","timestamp":1794650400000,"project":"D:\\Repos\\plcopen","sessionId":"claude-1"}}"#
            )
            .expect("write claude history line");
        }

        // 4. Pi fixture
        let pi_agent = app_data.join("pi").join("agent");
        fs::create_dir_all(&pi_agent).expect("create pi agent dir");
        fs::write(
            pi_agent.join("rocketx-thread-index.json"),
            r#"{"threads":{"pi-1":{"id":"pi-1","cwd":"D:\\Repos\\rocketchatx","name":"晨间简报","preview":"晨间简报生成","createdAt":1794600000,"updatedAt":1794600600,"archived":false}}}"#,
        )
        .expect("write pi thread index");

        let discovered =
            discover_local_sessions_sync(Some(home.clone()), Some(app_data.clone()), 20);
        assert_eq!(discovered.len(), 4);
        assert_eq!(discovered[0].provider, "antigravity");
        assert_eq!(discovered[0].runtime_status, "running");
        assert!(discovered
            .iter()
            .any(|s| s.provider == "codex" && s.native_session_id == "codex-1"));
        assert!(discovered
            .iter()
            .any(|s| s.provider == "claude" && s.native_session_id == "claude-1"));
        assert!(discovered
            .iter()
            .any(|s| s.provider == "pi" && s.native_session_id == "pi-1"));

        let agy_msgs = read_local_session_messages_sync(
            "antigravity",
            "agy-1",
            None,
            Some(home.clone()),
            Some(app_data.clone()),
            10,
        );
        assert_eq!(agy_msgs.len(), 2);
        assert_eq!(agy_msgs[0].role, "user");
        assert_eq!(agy_msgs[0].text, "实现本地会话同步");

        let codex_msgs = read_local_session_messages_sync(
            "codex",
            "codex-1",
            Some(&codex_rollout.to_string_lossy()),
            Some(home.clone()),
            Some(app_data.clone()),
            10,
        );
        assert_eq!(codex_msgs.len(), 2);
        assert_eq!(codex_msgs[0].text, "修复登录边界测试");

        let claude_msgs = read_local_session_messages_sync(
            "claude",
            "claude-1",
            None,
            Some(home.clone()),
            Some(app_data),
            10,
        );
        assert_eq!(claude_msgs.len(), 2);
        assert_eq!(claude_msgs[1].role, "assistant");

        let _ = fs::remove_dir_all(root);
    }
}
