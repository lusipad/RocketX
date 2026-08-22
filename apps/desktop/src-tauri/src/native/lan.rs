use std::path::{Path, PathBuf};

pub(crate) fn safe_file_name(value: &str) -> Result<String, String> {
    if value.is_empty() || value.len() > 255 || value.chars().any(char::is_control) {
        return Err("LAN file name is invalid".to_string());
    }
    let name = Path::new(value)
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "LAN file name is invalid".to_string())?;
    if name != value || matches!(name, "." | "..") {
        return Err("LAN file name is invalid".to_string());
    }
    Ok(name.to_string())
}

pub(crate) fn transfer_paths(root: &Path, transfer_id: &str) -> (PathBuf, PathBuf) {
    (
        root.join(format!("{transfer_id}.part")),
        root.join(format!("{transfer_id}.json")),
    )
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{safe_file_name, transfer_paths};

    #[test]
    fn transfer_paths_are_scoped_to_the_runtime_root() {
        let (part, manifest) = transfer_paths(Path::new("root"), "abc");
        assert_eq!(part, Path::new("root/abc.part"));
        assert_eq!(manifest, Path::new("root/abc.json"));
    }

    #[test]
    fn file_names_cannot_escape_the_transfer_root() {
        assert!(safe_file_name("../payload.bin").is_err());
        assert_eq!(safe_file_name("payload.bin").unwrap(), "payload.bin");
    }
}
