use flate2::read::GzDecoder;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{self, BufReader, Seek},
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::Manager;

static UNPACK: Mutex<()> = Mutex::new(());

pub(super) fn node(root: &Path) -> PathBuf {
    let arch = if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x64"
    };
    root.join("bin")
        .join(arch)
        .join(if cfg!(windows) { "node.exe" } else { "node" })
}

fn complete(root: &Path) -> bool {
    root.join(".installed").is_file()
        && node(root).is_file()
        && root
            .join("node_modules/@earendil-works/pi-coding-agent/dist/index.js")
            .is_file()
}

/// The signed app supplies the digest. Never activate a partially copied or unpacked update.
fn materialize(resources: &Path, cache: &Path) -> Result<PathBuf, String> {
    let expected =
        fs::read_to_string(resources.join("runtime.sha256")).map_err(|e| e.to_string())?;
    let expected = expected.trim();
    if expected.len() != 64 || !expected.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Pi 安装资源的 SHA256 无效".into());
    }
    let root = cache.join(expected);
    if complete(&root) {
        return Ok(root);
    }
    let _guard = UNPACK.lock().map_err(|_| "Pi 解包锁不可用")?;
    if complete(&root) {
        return Ok(root);
    }
    let archive = resources.join("runtime.tar.gz");
    let file = File::open(&archive).map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(file);
    let mut hash = Sha256::new();
    io::copy(&mut reader, &mut hash).map_err(|e| e.to_string())?;
    if format!("{:x}", hash.finalize()) != expected {
        return Err("Pi 安装资源校验失败，请重新安装 RocketX".into());
    }
    reader.rewind().map_err(|e| e.to_string())?;
    // Different builds (and a running previous version) keep independent immutable roots.
    fs::create_dir_all(cache).map_err(|e| e.to_string())?;
    let staging = cache.join(format!(".install-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&staging).map_err(|e| e.to_string())?;
    let install = (|| -> Result<(), String> {
        tar::Archive::new(GzDecoder::new(reader))
            .unpack(&staging)
            .map_err(|e| format!("Pi 解包失败：{e}"))?;
        fs::write(staging.join(".installed"), expected).map_err(|e| e.to_string())?;
        if !complete(&staging) {
            return Err("Pi 安装资源缺少 SDK 或本机架构的 Node".into());
        }
        if complete(&root) {
            return Ok(());
        }
        if root.is_dir() {
            fs::remove_dir_all(&root).map_err(|e| e.to_string())?;
        }
        if let Err(error) = fs::rename(&staging, &root) {
            if !complete(&root) {
                return Err(error.to_string());
            }
        }
        Ok(())
    })();
    if staging.exists() {
        let _ = fs::remove_dir_all(staging);
    }
    install.map(|()| root)
}

pub(super) fn installed(app: &tauri::AppHandle) -> Result<Option<PathBuf>, String> {
    let resources = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("pi-runtime/generated");
    if !resources.is_dir() {
        return Ok(None);
    }
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("pi-runtime");
    materialize(&resources, &cache).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_verified_complete_archives_activate_and_cache() {
        let temp =
            std::env::temp_dir().join(format!("rocketx-pi-archive-{}", uuid::Uuid::new_v4()));
        let cache = temp.join("cache");
        let payload = temp.join("payload");
        let node_file = node(&payload);
        fs::create_dir_all(node_file.parent().unwrap()).unwrap();
        fs::write(node_file, b"test node").unwrap();
        let sdk = payload.join("node_modules/@earendil-works/pi-coding-agent/dist");
        fs::create_dir_all(&sdk).unwrap();
        fs::write(sdk.join("index.js"), b"test sdk").unwrap();
        let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(
            Vec::new(),
            flate2::Compression::fast(),
        ));
        builder.append_dir_all(".", &payload).unwrap();
        let bytes = builder.into_inner().unwrap().finish().unwrap();
        let sha = format!("{:x}", Sha256::digest(&bytes));
        fs::write(temp.join("runtime.tar.gz"), &bytes).unwrap();
        fs::write(temp.join("runtime.sha256"), "0".repeat(64)).unwrap();
        assert!(materialize(&temp, &cache).is_err());
        assert!(!cache.exists());
        fs::write(temp.join("runtime.sha256"), &sha).unwrap();
        let installed = materialize(&temp, &cache).unwrap();
        assert_eq!(installed, cache.join(sha));
        assert!(complete(&installed));
        fs::remove_file(temp.join("runtime.tar.gz")).unwrap();
        assert_eq!(materialize(&temp, &cache).unwrap(), installed);
        fs::remove_dir_all(temp).unwrap();
    }
}
