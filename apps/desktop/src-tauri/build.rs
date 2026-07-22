use flate2::read::GzDecoder;
use sha2::{Digest, Sha256};
use std::{
    env, fs,
    io::{self, Read},
    path::{Path, PathBuf},
};
use tar::Archive;
use zip::ZipArchive;

const MODEL_VERSION_DIR: &str = "models/ppocrv5-oar-v0.3.0";
const ORT_VERSION_DIR: &str = "onnxruntime/1.23.2";

struct FileAsset {
    url: &'static str,
    sha256: &'static str,
    file_name: &'static str,
}

struct ArchiveAsset {
    cache_key: &'static str,
    url: &'static str,
    sha256: &'static str,
    file_name: &'static str,
    entries: &'static [ArchiveEntry],
}

struct ArchiveEntry {
    archive_path: &'static str,
    output_rel_path: &'static str,
}

const MODEL_ASSETS: &[FileAsset] = &[
    FileAsset {
        url: "https://github.com/GreatV/oar-ocr/releases/download/v0.3.0/pp-ocrv5_mobile_det.onnx",
        sha256: "1eb7b4f7ab657ebd1c66d5f79bca7497f29768a2e3c15e52daecbba1a8e4a039",
        file_name: "pp-ocrv5_mobile_det.onnx",
    },
    FileAsset {
        url: "https://github.com/GreatV/oar-ocr/releases/download/v0.3.0/pp-ocrv5_mobile_rec.onnx",
        sha256: "243a0f06d826761323e9045e9b113ab2c191c3aa50565585e628300b8eda0224",
        file_name: "pp-ocrv5_mobile_rec.onnx",
    },
    FileAsset {
        url: "https://github.com/GreatV/oar-ocr/releases/download/v0.3.0/pp-lcnet_x1_0_textline_ori.onnx",
        sha256: "6b02efabbedd6be69e3de4c86b8dceed2d7329e75c12a796e6717bfb0d646950",
        file_name: "pp-lcnet_x1_0_textline_ori.onnx",
    },
    FileAsset {
        url: "https://github.com/GreatV/oar-ocr/releases/download/v0.3.0/ppocrv5_dict.txt",
        sha256: "d1979e9f794c464c0d2e0b70a7fe14dd978e9dc644c0e71f14158cdf8342af1b",
        file_name: "ppocrv5_dict.txt",
    },
];

const ORT_WINDOWS_X64: ArchiveAsset = ArchiveAsset {
    cache_key: "windows-x64",
    url: "https://github.com/microsoft/onnxruntime/releases/download/v1.23.2/onnxruntime-win-x64-1.23.2.zip",
    sha256: "0b38df9af21834e41e73d602d90db5cb06dbd1ca618948b8f1d66d607ac9f3cd",
    file_name: "onnxruntime-win-x64-1.23.2.zip",
    entries: &[
        ArchiveEntry {
            archive_path: "onnxruntime-win-x64-1.23.2/lib/onnxruntime.dll",
            output_rel_path: "onnxruntime.dll",
        },
        ArchiveEntry {
            archive_path: "onnxruntime-win-x64-1.23.2/lib/onnxruntime_providers_shared.dll",
            output_rel_path: "onnxruntime_providers_shared.dll",
        },
        ArchiveEntry {
            archive_path: "onnxruntime-win-x64-1.23.2/LICENSE",
            output_rel_path: "LICENSE",
        },
        ArchiveEntry {
            archive_path: "onnxruntime-win-x64-1.23.2/ThirdPartyNotices.txt",
            output_rel_path: "ThirdPartyNotices.txt",
        },
    ],
};

const ORT_LINUX_X64: ArchiveAsset = ArchiveAsset {
    cache_key: "linux-x64",
    url: "https://github.com/microsoft/onnxruntime/releases/download/v1.23.2/onnxruntime-linux-x64-1.23.2.tgz",
    sha256: "1fa4dcaef22f6f7d5cd81b28c2800414350c10116f5fdd46a2160082551c5f9b",
    file_name: "onnxruntime-linux-x64-1.23.2.tgz",
    entries: &[
        ArchiveEntry {
            archive_path: "onnxruntime-linux-x64-1.23.2/lib/libonnxruntime.so",
            output_rel_path: "libonnxruntime.so",
        },
        ArchiveEntry {
            archive_path: "onnxruntime-linux-x64-1.23.2/lib/libonnxruntime.so.1",
            output_rel_path: "libonnxruntime.so.1",
        },
        ArchiveEntry {
            archive_path: "onnxruntime-linux-x64-1.23.2/lib/libonnxruntime.so.1.23.2",
            output_rel_path: "libonnxruntime.so.1.23.2",
        },
        ArchiveEntry {
            archive_path: "onnxruntime-linux-x64-1.23.2/lib/libonnxruntime_providers_shared.so",
            output_rel_path: "libonnxruntime_providers_shared.so",
        },
        ArchiveEntry {
            archive_path: "onnxruntime-linux-x64-1.23.2/LICENSE",
            output_rel_path: "LICENSE",
        },
        ArchiveEntry {
            archive_path: "onnxruntime-linux-x64-1.23.2/ThirdPartyNotices.txt",
            output_rel_path: "ThirdPartyNotices.txt",
        },
    ],
};

const ORT_MACOS_UNIVERSAL2: ArchiveAsset = ArchiveAsset {
    cache_key: "macos-universal2",
    url: "https://github.com/microsoft/onnxruntime/releases/download/v1.23.2/onnxruntime-osx-universal2-1.23.2.tgz",
    sha256: "49ae8e3a66ccb18d98ad3fe7f5906b6d7887df8a5edd40f49eb2b14e20885809",
    file_name: "onnxruntime-osx-universal2-1.23.2.tgz",
    entries: &[
        ArchiveEntry {
            archive_path: "./onnxruntime-osx-universal2-1.23.2/lib/libonnxruntime.dylib",
            output_rel_path: "libonnxruntime.dylib",
        },
        ArchiveEntry {
            archive_path: "./onnxruntime-osx-universal2-1.23.2/lib/libonnxruntime.1.23.2.dylib",
            output_rel_path: "libonnxruntime.1.23.2.dylib",
        },
        ArchiveEntry {
            archive_path: "./onnxruntime-osx-universal2-1.23.2/LICENSE",
            output_rel_path: "LICENSE",
        },
        ArchiveEntry {
            archive_path: "./onnxruntime-osx-universal2-1.23.2/ThirdPartyNotices.txt",
            output_rel_path: "ThirdPartyNotices.txt",
        },
    ],
};

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=tauri.conf.json");
    println!("cargo:rerun-if-env-changed=ROCKETX_OCR_CACHE_DIR");
    println!("cargo:rerun-if-env-changed=ROCKETX_OCR_OFFLINE");

    if let Err(error) = prepare_local_ocr_resources() {
        panic!("failed to prepare local OCR resources: {error}");
    }

    tauri_build::build();
}

fn prepare_local_ocr_resources() -> Result<(), String> {
    let manifest_dir =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").map_err(|error| error.to_string())?);
    let target_dir = manifest_dir.join("target");
    let cache_root = cache_root(&manifest_dir);
    let ort_asset = select_ort_asset()?;
    let cache_partition = cache_root.join(ort_asset.cache_key);
    let download_dir = cache_partition.join("downloads");
    let resource_root = target_dir.join("ocr-resources").join("ocr");
    let offline = offline_mode();

    fs::create_dir_all(&target_dir).map_err(io_error)?;
    fs::create_dir_all(&download_dir).map_err(io_error)?;
    let _cache_lock = lock_file(&cache_partition.join("prepare.lock"))?;
    let _resource_lock = lock_file(&target_dir.join("ocr-resources.lock"))?;

    let model_dir = resource_root.join(MODEL_VERSION_DIR);
    fs::create_dir_all(&model_dir).map_err(io_error)?;
    for asset in MODEL_ASSETS {
        let cached = fetch_verified_file(
            asset.url,
            asset.sha256,
            &download_dir,
            asset.file_name,
            offline,
        )?;
        let destination = model_dir.join(asset.file_name);
        copy_if_different(&cached, &destination).map_err(io_error)?;
    }

    let runtime_dir = resource_root
        .join(ORT_VERSION_DIR)
        .join(ort_asset.cache_key);
    fs::create_dir_all(&runtime_dir).map_err(io_error)?;
    extract_runtime_archive(ort_asset, &download_dir, &runtime_dir, offline)?;

    Ok(())
}

fn lock_file(path: &Path) -> Result<fs::File, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(io_error)?;
    }
    let file = fs::OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(path)
        .map_err(io_error)?;
    file.lock()
        .map_err(|error| format!("failed to lock {}: {error}", path.display()))?;
    Ok(file)
}

fn cache_root(manifest_dir: &Path) -> PathBuf {
    match env::var("ROCKETX_OCR_CACHE_DIR") {
        Ok(value) if !value.trim().is_empty() => PathBuf::from(value),
        _ => manifest_dir.join("target").join("ocr-cache"),
    }
}

fn offline_mode() -> bool {
    matches!(
        env::var("ROCKETX_OCR_OFFLINE").ok().as_deref(),
        Some("1") | Some("true") | Some("TRUE") | Some("yes") | Some("YES")
    )
}

fn select_ort_asset() -> Result<&'static ArchiveAsset, String> {
    match (
        env::var("CARGO_CFG_TARGET_OS").ok().as_deref(),
        env::var("CARGO_CFG_TARGET_ARCH").ok().as_deref(),
    ) {
        (Some("windows"), Some("x86_64")) => Ok(&ORT_WINDOWS_X64),
        (Some("linux"), Some("x86_64")) => Ok(&ORT_LINUX_X64),
        (Some("macos"), Some("x86_64" | "aarch64")) => Ok(&ORT_MACOS_UNIVERSAL2),
        (os, arch) => Err(format!(
            "RocketX local OCR only supports the current CI desktop targets (windows/linux x64, macOS universal2); got os={os:?} arch={arch:?}"
        )),
    }
}

fn fetch_verified_file(
    url: &str,
    expected_sha256: &str,
    download_dir: &Path,
    file_name: &str,
    offline: bool,
) -> Result<PathBuf, String> {
    let destination = download_dir.join(file_name);
    if destination.is_file() {
        match verify_sha256(&destination, expected_sha256) {
            Ok(()) => return Ok(destination),
            Err(error) if offline => {
                return Err(format!(
                    "cached OCR asset verification failed in offline mode for {}: {error}",
                    destination.display()
                ));
            }
            Err(_) => {}
        }
    }
    if offline {
        return Err(format!(
            "missing cached OCR asset in offline mode: {} (expected sha256 {})",
            destination.display(),
            expected_sha256
        ));
    }
    download_verified_file(url, expected_sha256, &destination)?;
    Ok(destination)
}

fn download_file(url: &str, destination: &Path) -> Result<(), String> {
    let response = ureq::get(url)
        .call()
        .map_err(|error| format!("download failed for {url}: {error}"))?;
    let mut reader = response
        .into_body()
        .into_with_config()
        .limit(u64::MAX)
        .reader();
    let mut output = fs::File::create(destination).map_err(io_error)?;
    io::copy(&mut reader, &mut output)
        .map(|_| ())
        .map_err(|error| {
            format!(
                "failed to stream {url} into {}: {error}",
                destination.display()
            )
        })
}

fn download_verified_file(
    url: &str,
    expected_sha256: &str,
    destination: &Path,
) -> Result<(), String> {
    let temp_path = destination.with_file_name(format!(
        "{}.{}.part",
        destination
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| format!("invalid cache file name: {}", destination.display()))?,
        std::process::id(),
    ));
    if temp_path.exists() {
        fs::remove_file(&temp_path).map_err(io_error)?;
    }
    download_file(url, &temp_path)?;
    if let Err(error) = verify_sha256(&temp_path, expected_sha256) {
        let _ = fs::remove_file(&temp_path);
        return Err(error);
    }
    if destination.exists() {
        fs::remove_file(destination).map_err(io_error)?;
    }
    fs::rename(&temp_path, destination).map_err(|error| {
        let _ = fs::remove_file(&temp_path);
        io_error(error)
    })
}

fn verify_sha256(path: &Path, expected_sha256: &str) -> Result<(), String> {
    let mut file = fs::File::open(path).map_err(io_error)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(io_error)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let actual = format!("{:x}", hasher.finalize());
    if actual == expected_sha256 {
        Ok(())
    } else {
        Err(format!(
            "sha256 mismatch for {}: expected {expected_sha256}, got {actual}",
            path.display()
        ))
    }
}

fn extract_runtime_archive(
    asset: &ArchiveAsset,
    download_dir: &Path,
    runtime_dir: &Path,
    offline: bool,
) -> Result<(), String> {
    let archive_path = fetch_verified_file(
        asset.url,
        asset.sha256,
        download_dir,
        asset.file_name,
        offline,
    )?;
    if runtime_dir_complete(runtime_dir, asset.entries, asset.sha256) {
        return Ok(());
    }
    clear_directory(runtime_dir).map_err(io_error)?;
    if asset.file_name.ends_with(".zip") {
        extract_zip(&archive_path, runtime_dir, asset.entries)
    } else {
        extract_tgz(&archive_path, runtime_dir, asset.entries)
    }?;
    fs::write(
        runtime_dir.join("archive.sha256"),
        format!("{}\n", asset.sha256),
    )
    .map_err(io_error)
}

fn runtime_dir_complete(
    runtime_dir: &Path,
    entries: &[ArchiveEntry],
    expected_sha256: &str,
) -> bool {
    entries
        .iter()
        .all(|entry| runtime_dir.join(entry.output_rel_path).is_file())
        && fs::read_to_string(runtime_dir.join("archive.sha256"))
            .is_ok_and(|value| value.trim() == expected_sha256)
}

fn clear_directory(path: &Path) -> io::Result<()> {
    if path.exists() {
        fs::remove_dir_all(path)?;
    }
    fs::create_dir_all(path)
}

fn extract_zip(
    archive_path: &Path,
    runtime_dir: &Path,
    entries: &[ArchiveEntry],
) -> Result<(), String> {
    let file = fs::File::open(archive_path).map_err(io_error)?;
    let mut archive =
        ZipArchive::new(file).map_err(|error| format!("failed to read zip archive: {error}"))?;
    for entry in entries {
        let mut zipped = archive
            .by_name(entry.archive_path)
            .map_err(|error| format!("missing archive entry {}: {error}", entry.archive_path))?;
        let destination = runtime_dir.join(entry.output_rel_path);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(io_error)?;
        }
        let mut output = fs::File::create(&destination).map_err(io_error)?;
        io::copy(&mut zipped, &mut output).map_err(io_error)?;
    }
    Ok(())
}

fn extract_tgz(
    archive_path: &Path,
    runtime_dir: &Path,
    entries: &[ArchiveEntry],
) -> Result<(), String> {
    let file = fs::File::open(archive_path).map_err(io_error)?;
    let mut archive = Archive::new(GzDecoder::new(file));
    let mut remaining: Vec<&ArchiveEntry> = entries.iter().collect();
    for entry in archive.entries().map_err(io_error)? {
        let mut entry = entry.map_err(io_error)?;
        let Ok(path) = entry.path() else {
            continue;
        };
        let normalized = path.to_string_lossy().replace('\\', "/");
        let Some(index) = remaining
            .iter()
            .position(|candidate| candidate.archive_path == normalized)
        else {
            continue;
        };
        let destination = runtime_dir.join(remaining[index].output_rel_path);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(io_error)?;
        }
        entry.unpack(&destination).map_err(io_error)?;
        remaining.remove(index);
        if remaining.is_empty() {
            break;
        }
    }
    if remaining.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "missing archive entries: {}",
            remaining
                .iter()
                .map(|entry| entry.archive_path)
                .collect::<Vec<_>>()
                .join(", ")
        ))
    }
}

fn copy_if_different(source: &Path, destination: &Path) -> io::Result<()> {
    let same = destination.is_file()
        && fs::read(source).ok().as_deref() == fs::read(destination).ok().as_deref();
    if !same {
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(source, destination)?;
    }
    Ok(())
}

fn io_error(error: io::Error) -> String {
    error.to_string()
}
