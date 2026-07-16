use tauri::Manager;

const MAX_EXPORT_LOG_BYTES: usize = 1_000_000;

fn tail_utf8_lossy(bytes: &[u8]) -> String {
    let start = bytes.len().saturating_sub(MAX_EXPORT_LOG_BYTES);
    String::from_utf8_lossy(&bytes[start..]).into_owned()
}

#[tauri::command]
pub fn collect_diagnostic_logs(app: tauri::AppHandle) -> Result<String, String> {
    let path = app
        .path()
        .app_log_dir()
        .map_err(|err| err.to_string())?
        .join("rocketx.log");

    match std::fs::read(path) {
        Ok(bytes) => Ok(tail_utf8_lossy(&bytes)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(err) => Err(err.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::{tail_utf8_lossy, MAX_EXPORT_LOG_BYTES};

    #[test]
    fn export_keeps_only_the_latest_bounded_log_bytes() {
        let mut input = vec![b'a'; MAX_EXPORT_LOG_BYTES + 3];
        input.extend_from_slice(b"tail");
        let output = tail_utf8_lossy(&input);
        assert_eq!(output.len(), MAX_EXPORT_LOG_BYTES);
        assert!(output.ends_with("tail"));
    }
}
