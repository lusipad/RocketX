use std::{
    collections::HashMap,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

const DEFAULT_PTY_RING_BYTES: usize = 128 * 1024;
const DEFAULT_PTY_COLS: u16 = 100;
const DEFAULT_PTY_ROWS: u16 = 28;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyOutputEvent {
    pub terminal_id: String,
    pub data: String,
    pub seq: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyExitEvent {
    pub terminal_id: String,
    pub exit_code: Option<i32>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyStartInput {
    pub workspace_root: String,
    pub cwd: Option<String>,
    pub shell: Option<String>,
    pub command: Option<String>,
    pub args: Option<Vec<String>>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtySnapshot {
    pub buffered_output: String,
    pub exited: bool,
    pub exit_code: Option<i32>,
    pub cwd: String,
}

pub(crate) struct PtyRingBuffer {
    bytes: Vec<u8>,
    limit: usize,
    truncated: bool,
}

impl PtyRingBuffer {
    pub(crate) fn new(limit: usize) -> Self {
        Self {
            bytes: Vec::new(),
            limit,
            truncated: false,
        }
    }

    pub(crate) fn push(&mut self, chunk: &[u8]) {
        if chunk.is_empty() || self.limit == 0 {
            if self.limit == 0 && !chunk.is_empty() {
                self.truncated = true;
            }
            return;
        }
        if chunk.len() >= self.limit {
            self.bytes.clear();
            self.bytes
                .extend_from_slice(&chunk[chunk.len() - self.limit..]);
            self.truncated = true;
            return;
        }
        if self.bytes.len() + chunk.len() > self.limit {
            let overflow = self.bytes.len() + chunk.len() - self.limit;
            self.bytes.drain(..overflow);
            self.truncated = true;
        }
        self.bytes.extend_from_slice(chunk);
    }

    pub(crate) fn snapshot_string(&self) -> String {
        let mut slice = self.bytes.as_slice();
        if self.truncated {
            let mut skip = 0;
            while skip < 3 && skip < slice.len() && (slice[skip] & 0b1100_0000) == 0b1000_0000 {
                skip += 1;
            }
            slice = &slice[skip..];
        }
        String::from_utf8_lossy(slice).into_owned()
    }
}

struct ManagedPtySession {
    cwd_canonical: PathBuf,
    pid: Option<u32>,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    ring: Arc<Mutex<PtyRingBuffer>>,
    exited: Arc<AtomicBool>,
    exit_code: Arc<Mutex<Option<i32>>>,
}

pub struct PtyManagerState {
    sessions: Arc<Mutex<HashMap<String, Arc<ManagedPtySession>>>>,
    next_id: AtomicU64,
}

impl Default for PtyManagerState {
    fn default() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            next_id: AtomicU64::new(1),
        }
    }
}

fn drain_valid_utf8_chunks(pending: &mut Vec<u8>) -> String {
    let mut out = String::new();
    loop {
        match std::str::from_utf8(pending) {
            Ok(valid) => {
                out.push_str(valid);
                pending.clear();
                break;
            }
            Err(err) => {
                let valid_up_to = err.valid_up_to();
                if valid_up_to > 0 {
                    if let Ok(prefix) = std::str::from_utf8(&pending[..valid_up_to]) {
                        out.push_str(prefix);
                    }
                    pending.drain(..valid_up_to);
                }
                match err.error_len() {
                    Some(invalid_len) => {
                        out.push('\u{FFFD}');
                        pending.drain(..invalid_len);
                    }
                    None => break, // Wait for remaining bytes of multi-byte char
                }
            }
        }
    }
    out
}

fn is_allowed_pty_command(raw: &str) -> bool {
    let lower = Path::new(raw.trim())
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "claude"
            | "claude.exe"
            | "claude.cmd"
            | "codex"
            | "codex.exe"
            | "codex.cmd"
            | "pi"
            | "pi.exe"
            | "pi.cmd"
            | "pwsh"
            | "pwsh.exe"
            | "powershell"
            | "powershell.exe"
            | "cmd"
            | "cmd.exe"
            | "bash"
            | "sh"
            | "zsh"
    )
}

fn resolve_pty_command_and_args(
    shell: Option<&str>,
    command: Option<&str>,
    extra_args: Option<&[String]>,
) -> Result<(PathBuf, Vec<String>), String> {
    if let Some(raw_cmd) = command.map(str::trim).filter(|s| !s.is_empty()) {
        if !is_allowed_pty_command(raw_cmd) {
            return Err(format!(
                "不允许在内置 PTY 中直接启动未受信任命令：{raw_cmd}"
            ));
        }
        let args = extra_args.unwrap_or(&[]).to_vec();
        let lower = raw_cmd.to_ascii_lowercase();
        if matches!(
            lower.as_str(),
            "pwsh"
                | "pwsh.exe"
                | "powershell"
                | "powershell.exe"
                | "cmd"
                | "cmd.exe"
                | "bash"
                | "sh"
                | "zsh"
        ) {
            let (shell_exe, mut shell_args) = crate::acp::pick_interactive_shell(Some(raw_cmd))?;
            shell_args.extend(args);
            return Ok((shell_exe, shell_args));
        }
        let resolved = crate::native::dsh_discovery::find_program(raw_cmd)
            .or_else(|| {
                #[cfg(windows)]
                {
                    crate::native::dsh_discovery::find_program(&format!("{raw_cmd}.exe")).or_else(
                        || crate::native::dsh_discovery::find_program(&format!("{raw_cmd}.cmd")),
                    )
                }
                #[cfg(not(windows))]
                {
                    None
                }
            })
            .ok_or_else(|| format!("未找到本机命令：{raw_cmd}"))?;
        return Ok((resolved, args));
    }

    let (shell_exe, shell_args) = crate::acp::pick_interactive_shell(shell)?;
    Ok((shell_exe, shell_args))
}

fn build_pty_command(program: &Path, args: &[String], cwd: &Path) -> CommandBuilder {
    #[cfg(windows)]
    let (launch_exe, launch_args) = {
        let is_batch = program
            .extension()
            .and_then(|s| s.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"));
        if is_batch {
            let mut wrapped = vec!["/C".to_string(), crate::native::process::host_path(program)];
            wrapped.extend(args.iter().cloned());
            (PathBuf::from("cmd.exe"), wrapped)
        } else {
            (program.to_path_buf(), args.to_vec())
        }
    };
    #[cfg(not(windows))]
    let (launch_exe, launch_args) = (program.to_path_buf(), args.to_vec());

    let mut builder = CommandBuilder::new(launch_exe);
    builder.args(launch_args);
    builder.cwd(cwd);
    builder.env("TERM", "xterm-256color");
    builder.env("COLORTERM", "truecolor");
    builder.env("TERM_PROGRAM", "RocketX");
    builder
}

pub(crate) fn cwd_matches_target_workspace(session_cwd: &Path, target_workspace: &Path) -> bool {
    let canonical_target = target_workspace
        .canonicalize()
        .unwrap_or_else(|_| target_workspace.to_path_buf());
    session_cwd == canonical_target || session_cwd.starts_with(&canonical_target)
}

pub(crate) fn has_live_pty_in_workspace(app: &tauri::AppHandle, workspace_path: &Path) -> bool {
    let Some(state) = app.try_state::<PtyManagerState>() else {
        return false;
    };
    let sessions: Vec<Arc<ManagedPtySession>> = state
        .sessions
        .lock()
        .map(|map| map.values().cloned().collect())
        .unwrap_or_default();
    sessions.into_iter().any(|sess| {
        !sess.exited.load(Ordering::Acquire)
            && cwd_matches_target_workspace(&sess.cwd_canonical, workspace_path)
    })
}

pub(crate) fn active_pty_pids(app: &tauri::AppHandle) -> Vec<u32> {
    let Some(state) = app.try_state::<PtyManagerState>() else {
        return Vec::new();
    };
    state
        .sessions
        .lock()
        .map(|map| {
            map.values()
                .filter(|sess| !sess.exited.load(Ordering::Acquire))
                .filter_map(|sess| sess.pid)
                .collect()
        })
        .unwrap_or_default()
}

pub fn shutdown_all_pty_sessions(app: &tauri::AppHandle) {
    let Some(state) = app.try_state::<PtyManagerState>() else {
        return;
    };
    let drained: Vec<Arc<ManagedPtySession>> = state
        .sessions
        .lock()
        .map(|mut map| map.drain().map(|(_, s)| s).collect())
        .unwrap_or_default();
    for sess in drained {
        sess.exited.store(true, Ordering::Release);
        if let Ok(mut killer) = sess.killer.lock() {
            let _ = killer.kill();
        }
        if let Ok(mut writer) = sess.writer.lock() {
            let _ = writer.take();
        }
        if let Ok(mut master) = sess.master.lock() {
            let _ = master.take();
        }
    }
}

#[tauri::command]
pub async fn butler_pty_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, PtyManagerState>,
    input: PtyStartInput,
) -> Result<String, String> {
    let sessions = Arc::clone(&state.sessions);
    let term_num = state.next_id.fetch_add(1, Ordering::Relaxed);
    let app_handle = app.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let requested_cwd = input
            .cwd
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .unwrap_or(".");
        let (_root, resolved_cwd) =
            crate::acp::resolve_workspace_scoped_path(&input.workspace_root, requested_cwd, true)?;
        if !resolved_cwd.is_dir() {
            return Err("PTY 工作目录必须是目录".to_string());
        }
        let canonical_cwd = resolved_cwd.canonicalize().unwrap_or(resolved_cwd);

        let cols = input.cols.unwrap_or(DEFAULT_PTY_COLS).clamp(20, 400);
        let rows = input.rows.unwrap_or(DEFAULT_PTY_ROWS).clamp(5, 200);

        let (program, args) = resolve_pty_command_and_args(
            input.shell.as_deref(),
            input.command.as_deref(),
            input.args.as_deref(),
        )?;

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| format!("创建原生 PTY 失败：{error}"))?;

        let cmd = build_pty_command(&program, &args, &canonical_cwd);
        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|error| format!("在 PTY 中启动命令失败：{error}"))?;
        drop(pair.slave);

        let pid = child.process_id();
        let killer = child.clone_killer();
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| format!("获取 PTY 写入流失败：{error}"))?;
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| format!("获取 PTY 读取流失败：{error}"))?;

        let terminal_id = format!("butler-pty-{term_num}");
        let ring = Arc::new(Mutex::new(PtyRingBuffer::new(DEFAULT_PTY_RING_BYTES)));
        let exited = Arc::new(AtomicBool::new(false));
        let exit_code = Arc::new(Mutex::new(None));

        let managed = Arc::new(ManagedPtySession {
            cwd_canonical: canonical_cwd,
            pid,
            master: Mutex::new(Some(pair.master)),
            writer: Mutex::new(Some(writer)),
            killer: Mutex::new(killer),
            ring: Arc::clone(&ring),
            exited: Arc::clone(&exited),
            exit_code: Arc::clone(&exit_code),
        });

        sessions
            .lock()
            .map_err(|_| "PTY 会话注册表不可用".to_string())?
            .insert(terminal_id.clone(), Arc::clone(&managed));

        // Wait for process exit in a dedicated watcher without holding any killer mutex, then
        // drop writer/master so Windows ConPTY closes pseudo-console pipes and sends EOF to reader.
        let waiter_session = Arc::clone(&managed);
        let waiter_exit_code = Arc::clone(&exit_code);
        let waiter_handle = thread::spawn(move || {
            let code = child.wait().ok().map(|status| status.exit_code() as i32);
            if let Ok(mut guard) = waiter_exit_code.lock() {
                *guard = code;
            }
            if let Ok(mut writer_guard) = waiter_session.writer.lock() {
                let _ = writer_guard.take();
            }
            if let Ok(mut master_guard) = waiter_session.master.lock() {
                let _ = master_guard.take();
            }
            code
        });

        let reader_id = terminal_id.clone();
        thread::spawn(move || {
            let mut buf = [0u8; 4096];
            let mut pending = Vec::new();
            let mut seq: u64 = 0;

            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let slice = &buf[..n];
                        if let Ok(mut guard) = ring.lock() {
                            guard.push(slice);
                        }
                        pending.extend_from_slice(slice);
                        let chunk_str = drain_valid_utf8_chunks(&mut pending);
                        if !chunk_str.is_empty() {
                            seq = seq.saturating_add(1);
                            let _ = app_handle.emit(
                                "butler-pty-output",
                                PtyOutputEvent {
                                    terminal_id: reader_id.clone(),
                                    data: chunk_str,
                                    seq,
                                },
                            );
                        }
                    }
                    Err(_) => break,
                }
            }

            if !pending.is_empty() {
                let tail = String::from_utf8_lossy(&pending).into_owned();
                seq = seq.saturating_add(1);
                let _ = app_handle.emit(
                    "butler-pty-output",
                    PtyOutputEvent {
                        terminal_id: reader_id.clone(),
                        data: tail,
                        seq,
                    },
                );
            }

            let code = waiter_handle
                .join()
                .ok()
                .flatten()
                .or_else(|| exit_code.lock().ok().and_then(|g| *g));
            exited.store(true, Ordering::Release);
            let _ = app_handle.emit(
                "butler-pty-exit",
                PtyExitEvent {
                    terminal_id: reader_id,
                    exit_code: code,
                },
            );
        });

        Ok(terminal_id)
    })
    .await
    .map_err(|error| format!("启动 PTY 任务失败：{error}"))?
}

#[tauri::command]
pub fn butler_pty_write(
    state: tauri::State<'_, PtyManagerState>,
    terminal_id: String,
    data: String,
) -> Result<(), String> {
    let sess = state
        .sessions
        .lock()
        .map_err(|_| "PTY 注册表不可用".to_string())?
        .get(&terminal_id)
        .cloned()
        .ok_or_else(|| "PTY 会话不存在或已关闭".to_string())?;
    let mut writer_guard = sess
        .writer
        .lock()
        .map_err(|_| "PTY 写入流锁定失败".to_string())?;
    let Some(writer) = writer_guard.as_mut() else {
        return Err("PTY 会话已结束".to_string());
    };
    writer
        .write_all(data.as_bytes())
        .and_then(|_| writer.flush())
        .map_err(|error| format!("写入 PTY 失败：{error}"))
}

#[tauri::command]
pub fn butler_pty_resize(
    state: tauri::State<'_, PtyManagerState>,
    terminal_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sess = state
        .sessions
        .lock()
        .map_err(|_| "PTY 注册表不可用".to_string())?
        .get(&terminal_id)
        .cloned()
        .ok_or_else(|| "PTY 会话不存在或已关闭".to_string())?;
    let master_guard = sess
        .master
        .lock()
        .map_err(|_| "PTY 主控锁定失败".to_string())?;
    let Some(master) = master_guard.as_ref() else {
        return Ok(());
    };
    master
        .resize(PtySize {
            rows: rows.clamp(5, 200),
            cols: cols.clamp(20, 400),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("调整 PTY 窗口大小失败：{error}"))
}

#[tauri::command]
pub fn butler_pty_snapshot(
    state: tauri::State<'_, PtyManagerState>,
    terminal_id: String,
) -> Result<PtySnapshot, String> {
    let sess = state
        .sessions
        .lock()
        .map_err(|_| "PTY 注册表不可用".to_string())?
        .get(&terminal_id)
        .cloned()
        .ok_or_else(|| "PTY 会话不存在或已关闭".to_string())?;
    let buffered_output = sess
        .ring
        .lock()
        .map(|ring| ring.snapshot_string())
        .unwrap_or_default();
    let exit_code = sess.exit_code.lock().ok().and_then(|g| *g);
    Ok(PtySnapshot {
        buffered_output,
        exited: sess.exited.load(Ordering::Acquire),
        exit_code,
        cwd: crate::native::process::host_path(&sess.cwd_canonical),
    })
}

#[tauri::command]
pub async fn butler_pty_kill(
    state: tauri::State<'_, PtyManagerState>,
    terminal_id: String,
) -> Result<(), String> {
    let sess = state
        .sessions
        .lock()
        .map_err(|_| "PTY 注册表不可用".to_string())?
        .remove(&terminal_id);
    let Some(sess) = sess else {
        return Ok(());
    };
    tauri::async_runtime::spawn_blocking(move || {
        sess.exited.store(true, Ordering::Release);
        if let Ok(mut killer) = sess.killer.lock() {
            let _ = killer.kill();
        }
        if let Ok(mut writer) = sess.writer.lock() {
            let _ = writer.take();
        }
        if let Ok(mut master) = sess.master.lock() {
            let _ = master.take();
        }
    })
    .await
    .map_err(|error| format!("关闭 PTY 会话失败：{error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_buffer_caps_bytes_and_skips_split_utf8_prefix() {
        let mut ring = PtyRingBuffer::new(5);
        ring.push("你好".as_bytes()); // 6 bytes
        let text = ring.snapshot_string();
        assert!(!text.contains('\u{FFFD}'));
        assert_eq!(text, "好");
    }

    #[test]
    fn command_allowlist_blocks_arbitrary_binaries() {
        assert!(is_allowed_pty_command("claude"));
        assert!(is_allowed_pty_command("codex.exe"));
        assert!(is_allowed_pty_command("pwsh"));
        assert!(!is_allowed_pty_command("rm"));
        assert!(!is_allowed_pty_command("curl"));
    }

    #[test]
    fn workspace_match_respects_directory_boundary() {
        let base = std::env::temp_dir().join("rcx-pty-ws-test");
        let child = base.join("sub");
        let _ = std::fs::create_dir_all(&child);
        let canonical_base = base.canonicalize().unwrap_or(base.clone());
        let canonical_child = child.canonicalize().unwrap_or(child.clone());
        assert!(cwd_matches_target_workspace(
            &canonical_base,
            &canonical_base
        ));
        assert!(cwd_matches_target_workspace(
            &canonical_child,
            &canonical_base
        ));
        assert!(!cwd_matches_target_workspace(
            Path::new("C:/Windows"),
            &canonical_base
        ));
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn live_pty_executes_command_and_captures_output() {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");
        let mut cmd = if cfg!(windows) {
            let mut b = CommandBuilder::new("cmd.exe");
            b.args(["/C", "echo", "ROCKETX_PTY_OK"]);
            b
        } else {
            let mut b = CommandBuilder::new("sh");
            b.args(["-c", "echo ROCKETX_PTY_OK"]);
            b
        };
        cmd.cwd(std::env::temp_dir());
        let mut child = pair.slave.spawn_command(cmd).expect("spawn");
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().expect("reader");
        let reader_handle = thread::spawn(move || {
            let mut captured = Vec::new();
            let _ = reader.read_to_end(&mut captured);
            captured
        });
        let status = child.wait().expect("wait");
        assert_eq!(status.exit_code(), 0);
        // Dropping master closes Windows ConPTY pseudo-console so the reader receives EOF.
        drop(pair.master);
        let captured = reader_handle.join().expect("join pty reader");
        let output = String::from_utf8_lossy(&captured);
        assert!(
            output.contains("ROCKETX_PTY_OK"),
            "unexpected pty output: {output}"
        );
    }
}
