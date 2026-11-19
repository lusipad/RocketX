use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

const MAX_AUDIO_BYTES: usize = 960_000;
const MAX_TEXT_CHARS: usize = 1_000;
#[cfg(windows)]
const HELPER: &str = include_str!("local_voice.ps1");
#[cfg(windows)]
static ACTIVE_HELPER: Mutex<()> = Mutex::new(());

struct VoiceRequest {
    id: String,
    canceled: Arc<AtomicBool>,
}

struct VoiceRequests {
    active: Option<VoiceRequest>,
    recent_cancellations: std::collections::VecDeque<String>,
}

static VOICE_REQUESTS: Mutex<VoiceRequests> = Mutex::new(VoiceRequests {
    active: None,
    recent_cancellations: std::collections::VecDeque::new(),
});

struct VoiceRequestGuard(VoiceRequest);

impl VoiceRequestGuard {
    fn begin(request_id: Option<String>) -> Result<Self, String> {
        let id = request_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        validate_request_id(&id)?;
        let mut requests = VOICE_REQUESTS
            .lock()
            .map_err(|_| "本地语音状态不可用。".to_string())?;
        // A cancel IPC can overtake an async invoke before its worker starts.
        if requests.recent_cancellations.contains(&id) {
            return Err("LOCAL_VOICE_CANCELED: 本地语音已取消。".to_string());
        }
        if requests.active.is_some() {
            return Err("LOCAL_VOICE_BUSY: 本地语音正在处理另一段音频。".to_string());
        }
        let canceled = Arc::new(AtomicBool::new(false));
        requests.active = Some(VoiceRequest {
            id: id.clone(),
            canceled: canceled.clone(),
        });
        Ok(Self(VoiceRequest { id, canceled }))
    }
}

impl Drop for VoiceRequestGuard {
    fn drop(&mut self) {
        if let Ok(mut requests) = VOICE_REQUESTS.lock() {
            if requests
                .active
                .as_ref()
                .is_some_and(|request| Arc::ptr_eq(&request.canceled, &self.0.canceled))
            {
                requests.active = None;
            }
        }
    }
}

fn validate_request_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b':'))
    {
        return Err("LOCAL_VOICE_INVALID: 无效的语音请求编号。".to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn local_voice_cancel(request_id: String) -> Result<bool, String> {
    validate_request_id(&request_id)?;
    let mut requests = VOICE_REQUESTS
        .lock()
        .map_err(|_| "本地语音状态不可用。".to_string())?;
    if !requests.recent_cancellations.contains(&request_id) {
        requests.recent_cancellations.push_back(request_id.clone());
        if requests.recent_cancellations.len() > 64 {
            requests.recent_cancellations.pop_front();
        }
    }
    if let Some(request) = requests
        .active
        .as_ref()
        .filter(|request| request.id == request_id)
    {
        request.canceled.store(true, Ordering::Release);
        return Ok(true);
    }
    Ok(false)
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalVoiceEngine {
    pub id: String,
    pub name: String,
    pub language: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalVoiceCapabilities {
    pub available: bool,
    pub platform: String,
    pub recognizers: Vec<LocalVoiceEngine>,
    pub voices: Vec<LocalVoiceEngine>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalVoiceTranscript {
    pub text: String,
    pub language: String,
    pub confidence: Option<f64>,
    pub duration_ms: u32,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalVoiceAudio {
    pub audio_base64: String,
    pub mime_type: String,
    pub language: String,
}

fn language(value: Option<String>) -> Result<String, String> {
    let value = value.unwrap_or_else(|| "zh-CN".to_string());
    if value.is_empty()
        || value.len() > 35
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err("LOCAL_VOICE_INVALID: 无效的语音语言。".to_string());
    }
    Ok(value)
}

fn validate_text(text: &str) -> Result<(), String> {
    if text.trim().is_empty()
        || text.chars().count() > MAX_TEXT_CHARS
        || text
            .chars()
            .any(|c| c.is_control() && c != '\n' && c != '\r' && c != '\t')
    {
        return Err(format!(
            "LOCAL_VOICE_LIMIT: 朗读文本必须为 1–{MAX_TEXT_CHARS} 个字符。"
        ));
    }
    Ok(())
}

fn u16_at(bytes: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes([bytes[offset], bytes[offset + 1]])
}

fn u32_at(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
}

/// Accept only complete 16 kHz mono PCM16 WAV clips of at most 30 seconds.
/// This check runs before spawning an engine; arbitrary file paths are never accepted.
fn validate_wave(bytes: &[u8]) -> Result<u32, String> {
    let invalid = || "LOCAL_VOICE_INVALID: 需要完整的 16 kHz 单声道 PCM16 WAV 音频。".to_string();
    if bytes.len() < 44
        || bytes.len() > MAX_AUDIO_BYTES + 4096
        || &bytes[..4] != b"RIFF"
        || &bytes[8..12] != b"WAVE"
        || u32_at(bytes, 4) as usize + 8 != bytes.len()
    {
        return Err(invalid());
    }
    let mut offset = 12usize;
    let mut format_seen = false;
    let mut audio_bytes = None;
    while offset < bytes.len() {
        if bytes.len() - offset < 8 {
            return Err(invalid());
        }
        let size = u32_at(bytes, offset + 4) as usize;
        let body = offset + 8;
        let end = body.checked_add(size).ok_or_else(invalid)?;
        if end > bytes.len() {
            return Err(invalid());
        }
        match &bytes[offset..offset + 4] {
            b"fmt " => {
                if format_seen
                    || size < 16
                    || u16_at(bytes, body) != 1
                    || u16_at(bytes, body + 2) != 1
                    || u32_at(bytes, body + 4) != 16_000
                    || u32_at(bytes, body + 8) != 32_000
                    || u16_at(bytes, body + 12) != 2
                    || u16_at(bytes, body + 14) != 16
                {
                    return Err(invalid());
                }
                format_seen = true;
            }
            b"data" => {
                if audio_bytes.is_some() || size == 0 || size % 2 != 0 || size > MAX_AUDIO_BYTES {
                    return Err(
                        "LOCAL_VOICE_LIMIT: 每段录音必须为 0–30 秒且不超过 960 KB。".to_string()
                    );
                }
                audio_bytes = Some(size);
            }
            _ => {}
        }
        offset = end.checked_add(size % 2).ok_or_else(invalid)?;
        if offset > bytes.len() {
            return Err(invalid());
        }
    }
    if !format_seen {
        return Err(invalid());
    }
    let size = audio_bytes.ok_or_else(invalid)?;
    Ok((size as u32 * 1000) / 32_000)
}

#[cfg(windows)]
fn run_helper(request: Value, canceled: Option<&AtomicBool>) -> Result<Value, String> {
    let _guard = ACTIVE_HELPER
        .try_lock()
        .map_err(|_| "LOCAL_VOICE_BUSY: 本地语音正在处理另一段音频。".to_string())?;
    run_helper_process(
        request,
        HELPER,
        std::time::Duration::from_secs(35),
        canceled,
    )
}

#[cfg(windows)]
fn run_helper_process(
    request: Value,
    script: &str,
    timeout: std::time::Duration,
    cancel: Option<&AtomicBool>,
) -> Result<Value, String> {
    use crate::native::process::{hidden_command, kill_and_wait};
    use std::io::{Read, Write};
    use std::process::Stdio;
    use std::time::{Duration, Instant};

    if cancel.is_some_and(|flag| flag.load(Ordering::Acquire)) {
        return Err("LOCAL_VOICE_CANCELED: 本地语音已取消。".to_string());
    }

    let script: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    // The command contains only our embedded script. User text/audio is JSON on
    // stdin, never command syntax, an executable path, SSML, or a temporary file.
    let powershell = std::env::var_os("SystemRoot")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from(r"C:\Windows"))
        .join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
    let mut child = hidden_command(powershell)
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            &STANDARD.encode(script),
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "LOCAL_VOICE_UNSUPPORTED: Windows 离线语音运行时不可用。".to_string())?;
    let mut input = child.stdin.take().unwrap();
    let output = child.stdout.take().unwrap();
    let payload = serde_json::to_vec(&request).map_err(|e| e.to_string())?;
    let writer = std::thread::spawn(move || input.write_all(&payload));
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        output
            .take(5_200_001)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
    });
    let deadline = Instant::now() + timeout;
    let mut canceled = false;
    let status = loop {
        if cancel.is_some_and(|flag| flag.load(Ordering::Acquire)) {
            canceled = true;
            break Ok(None);
        }
        match child.try_wait() {
            Ok(Some(status)) => break Ok(Some(status)),
            Err(error) => break Err(error),
            Ok(None) => {}
        }
        if Instant::now() >= deadline {
            break Ok(None);
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let timed_out = !matches!(status, Ok(Some(_)));
    if timed_out {
        let _ = kill_and_wait(&mut child);
    }
    let written = writer
        .join()
        .map_err(|_| "本地语音输入失败。".to_string())?;
    let bytes = reader
        .join()
        .map_err(|_| "本地语音输出失败。".to_string())?
        .map_err(|_| "本地语音输出读取失败。".to_string())?;
    if canceled {
        return Err("LOCAL_VOICE_CANCELED: 本地语音已取消并释放进程。".to_string());
    }
    if timed_out {
        return Err("LOCAL_VOICE_TIMEOUT: 本地语音处理超时，已停止语音进程。".to_string());
    }
    written.map_err(|_| "LOCAL_VOICE_UNSUPPORTED: 本地语音运行时无法接收音频。".to_string())?;
    if bytes.len() > 5_200_000 {
        return Err("LOCAL_VOICE_LIMIT: 本地语音输出过大。".to_string());
    }
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "LOCAL_VOICE_UNSUPPORTED: 本地语音运行时没有返回有效结果。".to_string())?;
    if let Some(error) = value.get("error").and_then(Value::as_str) {
        let message = error.chars().take(500).collect::<String>();
        if message.starts_with("LOCAL_VOICE_") {
            return Err(message);
        }
        return Err(format!("LOCAL_VOICE_ENGINE: {}", message));
    }
    if !status.unwrap().unwrap().success() {
        return Err("LOCAL_VOICE_ENGINE: 本地语音运行时异常退出。".to_string());
    }
    Ok(value)
}

#[cfg(not(windows))]
fn run_helper(_request: Value, _canceled: Option<&AtomicBool>) -> Result<Value, String> {
    Err("LOCAL_VOICE_UNSUPPORTED: 当前平台没有内置的本地语音适配器。".to_string())
}

fn probe_blocking(canceled: Option<&AtomicBool>) -> Result<LocalVoiceCapabilities, String> {
    let result = run_helper(json!({ "operation": "probe" }), canceled)
        .and_then(|value| serde_json::from_value(value).map_err(|e| e.to_string()));
    match result {
        Ok(capabilities) => Ok(capabilities),
        Err(reason)
            if reason.starts_with("LOCAL_VOICE_CANCELED")
                || reason.starts_with("LOCAL_VOICE_BUSY") =>
        {
            Err(reason)
        }
        Err(reason) => Ok(LocalVoiceCapabilities {
            available: false,
            platform: std::env::consts::OS.to_string(),
            recognizers: vec![],
            voices: vec![],
            reason: Some(reason),
        }),
    }
}

fn transcribe_blocking(
    audio_base64: String,
    requested_language: Option<String>,
    canceled: Option<&AtomicBool>,
) -> Result<LocalVoiceTranscript, String> {
    if audio_base64.len() > (MAX_AUDIO_BYTES + 4096).div_ceil(3) * 4 {
        return Err("LOCAL_VOICE_LIMIT: 每段录音最多 30 秒。".to_string());
    }
    let bytes = STANDARD
        .decode(&audio_base64)
        .map_err(|_| "LOCAL_VOICE_INVALID: 无效的 WAV 编码。".to_string())?;
    let duration_ms = validate_wave(&bytes)?;
    let language = language(requested_language)?;
    let value = run_helper(
        json!({ "operation": "transcribe", "audioBase64": audio_base64, "language": language, "durationMs": duration_ms }),
        canceled,
    )?;
    serde_json::from_value(value).map_err(|_| "LOCAL_VOICE_ENGINE: 无效的转写结果。".to_string())
}

fn synthesize_blocking(
    text: String,
    requested_language: Option<String>,
    voice_id: Option<String>,
    canceled: Option<&AtomicBool>,
) -> Result<LocalVoiceAudio, String> {
    validate_text(&text)?;
    let language = language(requested_language)?;
    if voice_id
        .as_ref()
        .is_some_and(|value| value.len() > 256 || value.chars().any(char::is_control))
    {
        return Err("LOCAL_VOICE_INVALID: 无效的本地朗读声音。".to_string());
    }
    let value = run_helper(
        json!({ "operation": "synthesize", "text": text, "language": language, "voiceId": voice_id }),
        canceled,
    )?;
    serde_json::from_value(value).map_err(|_| "LOCAL_VOICE_ENGINE: 无效的合成音频。".to_string())
}

#[tauri::command]
pub async fn local_voice_probe(
    request_id: Option<String>,
) -> Result<LocalVoiceCapabilities, String> {
    let request = VoiceRequestGuard::begin(request_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let result = probe_blocking(Some(&request.0.canceled));
        drop(request);
        result
    })
    .await
    .map_err(|_| "本地语音探测任务失败。".to_string())?
}

#[tauri::command]
pub async fn local_voice_transcribe(
    audio_base64: String,
    language: Option<String>,
    request_id: Option<String>,
) -> Result<LocalVoiceTranscript, String> {
    let request = VoiceRequestGuard::begin(request_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let result = transcribe_blocking(audio_base64, language, Some(&request.0.canceled));
        drop(request);
        result
    })
    .await
    .map_err(|_| "本地语音转写任务失败。".to_string())?
}

#[tauri::command]
pub async fn local_voice_synthesize(
    text: String,
    language: Option<String>,
    voice_id: Option<String>,
    request_id: Option<String>,
) -> Result<LocalVoiceAudio, String> {
    let request = VoiceRequestGuard::begin(request_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let result = synthesize_blocking(text, language, voice_id, Some(&request.0.canceled));
        drop(request);
        result
    })
    .await
    .map_err(|_| "本地语音合成任务失败。".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wave(sample_bytes: usize) -> Vec<u8> {
        let mut bytes = Vec::from(*b"RIFF");
        bytes.extend_from_slice(&(36u32 + sample_bytes as u32).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&16_000u32.to_le_bytes());
        bytes.extend_from_slice(&32_000u32.to_le_bytes());
        bytes.extend_from_slice(&2u16.to_le_bytes());
        bytes.extend_from_slice(&16u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&(sample_bytes as u32).to_le_bytes());
        bytes.resize(44 + sample_bytes, 0);
        bytes
    }

    #[test]
    fn bounded_pcm_wave_is_accepted() {
        assert_eq!(validate_wave(&wave(32_000)).unwrap(), 1000);
        assert_eq!(validate_wave(&wave(MAX_AUDIO_BYTES)).unwrap(), 30_000);
    }

    #[test]
    fn malformed_compressed_truncated_and_long_audio_is_rejected() {
        assert!(validate_wave(&[]).is_err());
        assert!(validate_wave(&wave(0)).is_err());
        let bytes = wave(32_000);
        assert!(validate_wave(&bytes[..bytes.len() - 1]).is_err());
        for offset in [20, 22, 24, 28, 32, 34] {
            let mut malformed = bytes.clone();
            malformed[offset] = 99;
            assert!(validate_wave(&malformed).is_err(), "field {offset}");
        }
        assert!(validate_wave(&wave(MAX_AUDIO_BYTES + 2)).is_err());
        let mut malformed = bytes;
        malformed[40..44].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(validate_wave(&malformed).is_err());
    }

    #[test]
    fn text_language_and_voice_limits_are_checked_before_any_engine() {
        assert!(validate_text("你好，世界。\n继续工作。").is_ok());
        assert!(validate_text(" ").is_err());
        assert!(validate_text(&"你".repeat(MAX_TEXT_CHARS + 1)).is_err());
        assert!(validate_text("不能包含\0字符").is_err());
        assert_eq!(language(None).unwrap(), "zh-CN");
        assert!(language(Some("zh-CN; calc.exe".to_string())).is_err());
        assert!(synthesize_blocking("你好".into(), None, Some("bad\nvoice".into()), None).is_err());
        assert!(transcribe_blocking("a".repeat(1_300_000), None, None).is_err());
        assert!(transcribe_blocking("not base64!".into(), None, None).is_err());
        assert!(validate_request_id("wrong; command").is_err());
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "starts bounded hidden local PowerShell processes, no audio devices"]
    fn local_voice_process_timeout_failure_and_output_limit_are_bounded() {
        use std::time::{Duration, Instant};

        let started = Instant::now();
        let timeout = run_helper_process(
            json!({ "audioBase64": "x".repeat(1_300_000) }),
            "Start-Sleep -Seconds 20",
            Duration::from_millis(150),
            None,
        );
        assert!(timeout.unwrap_err().contains("LOCAL_VOICE_TIMEOUT"));
        assert!(started.elapsed() < Duration::from_secs(5));
        let failed = run_helper_process(json!({}), "[Console]::In.ReadToEnd() > $null; [Console]::Write('{\"error\":\"fixture engine failure\"}'); exit 1", Duration::from_secs(5), None);
        assert!(failed.unwrap_err().contains("fixture engine failure"));
        let invalid = run_helper_process(
            json!({}),
            "[Console]::In.ReadToEnd() > $null; [Console]::Write('invalid result')",
            Duration::from_secs(5),
            None,
        );
        assert!(invalid.unwrap_err().contains("LOCAL_VOICE_UNSUPPORTED"));
        let too_large = run_helper_process(
            json!({}),
            "[Console]::In.ReadToEnd() > $null; [Console]::Write(('x' * 5200001))",
            Duration::from_secs(5),
            None,
        );
        assert!(too_large.unwrap_err().contains("LOCAL_VOICE_LIMIT"));
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "starts and cancels a hidden local PowerShell process, no audio devices"]
    fn cancel_only_reaps_its_own_voice_request_and_does_not_cancel_the_next() {
        use std::time::{Duration, Instant};

        assert!(!local_voice_cancel("voice-cancel-before-invoke".into()).unwrap());
        assert!(VoiceRequestGuard::begin(Some("voice-cancel-before-invoke".into())).is_err());
        let request = VoiceRequestGuard::begin(Some("voice-cancel-fixture".into())).unwrap();
        assert!(VoiceRequestGuard::begin(Some("voice-other".into())).is_err());
        assert!(!local_voice_cancel("wrong-id".into()).unwrap());
        assert!(!request.0.canceled.load(Ordering::Acquire));
        let canceled = request.0.canceled.clone();
        let started = Instant::now();
        let running = std::thread::spawn(move || {
            run_helper_process(
                json!({ "audioBase64": "x".repeat(1_300_000) }),
                "Start-Sleep -Seconds 20",
                Duration::from_secs(10),
                Some(&canceled),
            )
        });
        std::thread::sleep(Duration::from_millis(250));
        assert!(local_voice_cancel("voice-cancel-fixture".into()).unwrap());
        assert!(running
            .join()
            .unwrap()
            .unwrap_err()
            .contains("LOCAL_VOICE_CANCELED"));
        assert!(started.elapsed() < Duration::from_secs(5));
        drop(request);
        let next = VoiceRequestGuard::begin(Some("voice-next-fixture".into())).unwrap();
        assert!(!local_voice_cancel("voice-cancel-fixture".into()).unwrap());
        assert!(!next.0.canceled.load(Ordering::Acquire));
        assert!(local_voice_cancel("voice-next-fixture".into()).unwrap());
        let canceled_before_spawn = run_helper_process(
            json!({}),
            "Start-Sleep -Seconds 20",
            Duration::from_secs(10),
            Some(&next.0.canceled),
        );
        assert!(canceled_before_spawn
            .unwrap_err()
            .contains("LOCAL_VOICE_CANCELED"));
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "starts and cancels a hidden local probe, then probes installed engines without audio devices"]
    fn closing_a_hung_probe_releases_it_and_allows_the_next_probe() {
        use std::time::{Duration, Instant};

        let request = VoiceRequestGuard::begin(Some("voice-probe-hung".into())).unwrap();
        let canceled = request.0.canceled.clone();
        let started = Instant::now();
        let running = std::thread::spawn(move || {
            let _process_guard = ACTIVE_HELPER.try_lock().unwrap();
            let result = run_helper_process(
                json!({ "operation": "probe" }),
                "Start-Sleep -Seconds 20",
                Duration::from_secs(10),
                Some(&canceled),
            );
            drop(request);
            result
        });
        std::thread::sleep(Duration::from_millis(250));
        assert!(!local_voice_cancel("voice-probe-wrong-id".into()).unwrap());
        assert!(local_voice_cancel("voice-probe-hung".into()).unwrap());
        assert!(running
            .join()
            .unwrap()
            .unwrap_err()
            .contains("LOCAL_VOICE_CANCELED"));
        assert!(started.elapsed() < Duration::from_secs(5));

        let next = VoiceRequestGuard::begin(Some("voice-probe-next".into())).unwrap();
        assert!(!local_voice_cancel("voice-probe-hung".into()).unwrap());
        let capabilities = probe_blocking(Some(&next.0.canceled)).unwrap();
        assert!(capabilities.available, "{capabilities:?}");
        assert!(!next.0.canceled.load(Ordering::Acquire));
        assert!(local_voice_cancel("voice-probe-next".into()).unwrap());
        let canceled_before_spawn = probe_blocking(Some(&next.0.canceled));
        assert!(canceled_before_spawn
            .unwrap_err()
            .contains("LOCAL_VOICE_CANCELED"));
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "requires installed Windows local speech engines; never opens audio devices"]
    fn local_tts_to_asr_round_trip_without_microphone_or_playback() {
        let capabilities = probe_blocking(None).unwrap();
        assert!(
            capabilities
                .recognizers
                .iter()
                .any(|engine| engine.language == "zh-CN"),
            "{capabilities:?}"
        );
        let generated =
            synthesize_blocking("你好，请继续完成今天的工作。".into(), None, None, None).unwrap();
        let bytes = STANDARD.decode(&generated.audio_base64).unwrap();
        assert!(validate_wave(&bytes).unwrap() > 0);
        let transcript = transcribe_blocking(generated.audio_base64.clone(), None, None).unwrap();
        assert!(!transcript.text.trim().is_empty(), "{transcript:?}");
        assert_eq!(transcript.language, "zh-CN");
        assert!(transcript.duration_ms <= 30_000);
        let unsupported_language =
            transcribe_blocking(generated.audio_base64, Some("xx-XX".into()), None);
        assert!(unsupported_language
            .unwrap_err()
            .contains("LOCAL_VOICE_UNSUPPORTED"));
        let unsupported_voice = synthesize_blocking(
            "你好".into(),
            None,
            Some("not-an-installed-voice".into()),
            None,
        );
        assert!(unsupported_voice
            .unwrap_err()
            .contains("LOCAL_VOICE_UNSUPPORTED"));
        println!("local CPU TTS → ASR: {transcript:?}");
    }
}
