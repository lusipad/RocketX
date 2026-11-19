//! Codex executable discovery and path normalization.
//!
//! Candidate probing remains in `proc.rs`; this module only answers where a
//! runtime may live and how a candidate is represented as a child command.

use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
    process::Stdio,
};

use tauri::Manager;

use super::{
    codex_contract::CodexRuntimeSource,
    codex_process::ResolvedCodex,
    process::{hidden_command, host_path},
};

#[cfg(windows)]
pub(crate) fn find_program(name: &str) -> Option<PathBuf> {
    let output = hidden_command("where.exe")
        .arg(name)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .find(|path| path.is_file())
}

#[cfg(not(windows))]
pub(crate) fn find_program(name: &str) -> Option<PathBuf> {
    std::env::var_os("PATH")
        .into_iter()
        .flat_map(|value| std::env::split_paths(&value).collect::<Vec<_>>())
        .map(|directory| directory.join(name))
        .find(|path| path.is_file())
}

pub(crate) fn resolved_codex_path(
    path: &Path,
    source: CodexRuntimeSource,
) -> Result<ResolvedCodex, String> {
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("Codex 路径不可用：{error}"))?;
    let canonical = PathBuf::from(host_path(&canonical));
    if !canonical.is_file() {
        return Err("Codex 路径不是文件".to_string());
    }
    let name = canonical
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    if name != "codex.exe" && name != "codex.cmd" && name != "codex" {
        return Err("请选择 codex.exe 或 codex.cmd".to_string());
    }
    #[cfg(windows)]
    if name == "codex.cmd" {
        let entry = canonical
            .parent()
            .unwrap_or_else(|| Path::new(""))
            .join("node_modules")
            .join("@openai")
            .join("codex")
            .join("bin")
            .join("codex.js");
        if !entry.is_file() {
            return Err("codex.cmd 缺少对应的 @openai/codex 安装文件".to_string());
        }
        let node = canonical
            .parent()
            .map(|parent| parent.join("node.exe"))
            .filter(|candidate| candidate.is_file())
            .or_else(|| find_program("node.exe"))
            .ok_or_else(|| "未检测到 Node.js，无法运行 codex.cmd".to_string())?;
        return Ok(ResolvedCodex {
            program: node,
            prefix_args: vec![entry.into_os_string()],
            display_path: canonical.to_string_lossy().into_owned(),
            source,
            version: String::new(),
        });
    }
    Ok(ResolvedCodex {
        program: canonical.clone(),
        prefix_args: Vec::new(),
        display_path: canonical.to_string_lossy().into_owned(),
        source,
        version: String::new(),
    })
}

/// Native ownership must target the real CLI, not a Node wrapper that can outlive its parent.
pub(crate) fn resolved_native_codex_path(
    path: &Path,
    source: CodexRuntimeSource,
) -> Result<ResolvedCodex, String> {
    #[cfg(windows)]
    if path
        .extension()
        .and_then(OsStr::to_str)
        .is_some_and(|extension| extension.eq_ignore_ascii_case("cmd"))
    {
        let shim = path
            .canonicalize()
            .map_err(|_| "原 Codex wrapper 路径不可用")?;
        let root = official_windows_codex_package(&shim)?;
        let (triple, package, cpu) = match std::env::consts::ARCH {
            "x86_64" => ("x86_64-pc-windows-msvc", "codex-win32-x64", "x64"),
            "aarch64" => ("aarch64-pc-windows-msvc", "codex-win32-arm64", "arm64"),
            _ => return Err("当前 Windows 架构尚不支持原生 Codex wrapper 接管".into()),
        };
        let manifest = read_codex_manifest(&root.join("package.json"))?;
        if manifest.get("name").and_then(serde_json::Value::as_str) != Some("@openai/codex")
            || manifest
                .pointer("/bin/codex")
                .and_then(serde_json::Value::as_str)
                != Some("bin/codex.js")
            || !root.join("bin/codex.js").is_file()
        {
            return Err("无法确认原 wrapper 对应的官方 Codex 包，请直接选择 codex.exe".into());
        }
        let mut vendor_root = root.join("vendor");
        for ancestor in root
            .ancestors()
            .filter(|ancestor| ancestor.file_name() != Some(OsStr::new("node_modules")))
        {
            let platform = ancestor.join("node_modules/@openai").join(package);
            if platform.join("package.json").is_file() {
                let platform_manifest = read_codex_manifest(&platform.join("package.json"))?;
                let valid_platform = platform_manifest
                    .get("os")
                    .and_then(serde_json::Value::as_array)
                    .is_some_and(|values| {
                        values.iter().any(|value| value.as_str() == Some("win32"))
                    })
                    && platform_manifest
                        .get("cpu")
                        .and_then(serde_json::Value::as_array)
                        .is_some_and(|values| {
                            values.iter().any(|value| value.as_str() == Some(cpu))
                        });
                if !valid_platform {
                    return Err("原 Codex 平台包不匹配，禁止改用其他安装".into());
                }
                vendor_root = platform.join("vendor");
                break;
            }
        }
        let binary = vendor_root.join(triple).join("bin/codex.exe");
        if !binary.is_file() {
            return Err(
                "无法确认原 wrapper 的直接 Codex 程序，请直接选择 codex.exe；禁止由 Node 间接接管"
                    .into(),
            );
        }
        return resolved_codex_path(&binary, source);
    }
    resolved_codex_path(path, source)
}

#[cfg(windows)]
fn read_codex_manifest(path: &Path) -> Result<serde_json::Value, String> {
    if std::fs::metadata(path)
        .map_err(|_| "无法读取原 Codex 包元数据")?
        .len()
        > 64 * 1024
    {
        return Err("原 Codex 包元数据过大".into());
    }
    serde_json::from_slice(&std::fs::read(path).map_err(|_| "无法读取原 Codex 包元数据")?)
        .map_err(|_| "原 Codex 包元数据无效".into())
}

#[cfg(windows)]
const NPM_CODEX_SHIM: &str = r#"@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0
IF EXIST "%dp0%\node.exe" (
SET "_prog=%dp0%\node.exe"
) ELSE (
SET "_prog=node"
SET PATHEXT=%PATHEXT:;.JS;=;%
)
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\node_modules\@openai\codex\bin\codex.js" %*"#;

#[cfg(windows)]
fn official_windows_codex_package(shim: &Path) -> Result<PathBuf, String> {
    if std::fs::metadata(shim)
        .map_err(|_| "无法读取原 Codex wrapper")?
        .len()
        > 32 * 1024
    {
        return Err("原 Codex wrapper 过大，无法确认其启动方式".into());
    }
    let body = std::fs::read_to_string(shim).map_err(|_| "原 Codex wrapper 不是有效文本")?;
    let lines = body
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_ascii_lowercase)
        .collect::<Vec<_>>();
    let npm_lines = NPM_CODEX_SHIM
        .lines()
        .map(str::to_ascii_lowercase)
        .collect::<Vec<_>>();
    let parent = shim.parent().ok_or("原 Codex wrapper 没有父目录")?;
    let package = if lines == npm_lines {
        parent.join("node_modules/@openai/codex")
    } else {
        let pnpm = [
            (0, "@setlocal"),
            (1, "@if not defined node_path ("),
            (3, ") else ("),
            (5, ")"),
            (6, "@if exist \"%~dp0\\node.exe\" ("),
            (
                7,
                "\"%~dp0\\node.exe\"  \"%~dp0\\..\\@openai\\codex\\bin\\codex.js\" %*",
            ),
            (8, ") else ("),
            (9, "@set pathext=%pathext:;.js;=;%"),
            (10, "node  \"%~dp0\\..\\@openai\\codex\\bin\\codex.js\" %*"),
            (11, ")"),
        ];
        let node_path_line = |line: &str| {
            line.strip_prefix("@set \"node_path=")
                .and_then(|value| value.strip_suffix('"'))
                .is_some_and(|value| !value.contains(['"', '&', '|', '<', '>']))
        };
        if lines.len() != 12
            || pnpm
                .iter()
                .any(|(index, expected)| lines.get(*index).map(String::as_str) != Some(*expected))
            || !node_path_line(&lines[2])
            || !node_path_line(&lines[4])
        {
            return Err("原 Codex wrapper 含未识别启动逻辑，请直接选择 codex.exe，禁止丢弃 wrapper 参数接管".into());
        }
        parent.join("../@openai/codex")
    };
    package
        .canonicalize()
        .map_err(|_| "原 Codex wrapper 的包目录不存在".to_string())
}

#[cfg(windows)]
pub(crate) fn standard_codex_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(app_data) = std::env::var_os("APPDATA") {
        paths.push(PathBuf::from(app_data).join("npm").join("codex.cmd"));
    }
    if let Some(user_profile) = std::env::var_os("USERPROFILE") {
        paths.push(
            PathBuf::from(user_profile)
                .join("Codex")
                .join("_internal")
                .join("app")
                .join("resources")
                .join("codex.exe"),
        );
    }
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        let local = PathBuf::from(local_app_data);
        paths.push(
            local
                .join("Programs")
                .join("Codex")
                .join("resources")
                .join("codex.exe"),
        );
        paths.push(local.join("Codex").join("resources").join("codex.exe"));
        paths.push(local.join("Codex").join("codex.exe"));
    }
    paths
}

#[cfg(not(windows))]
pub(crate) fn standard_codex_paths() -> Vec<PathBuf> {
    Vec::new()
}

pub(crate) fn bundled_codex_paths(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let executable = if cfg!(windows) { "codex.exe" } else { "codex" };
    let mut paths = Vec::new();
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        paths.push(
            PathBuf::from(local_app_data)
                .join("RocketX")
                .join("resources")
                .join("codex")
                .join("bin")
                .join(executable),
        );
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        paths.push(resource_dir.join("codex").join("bin").join(executable));
    }
    paths.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("codex-resources")
            .join("codex")
            .join("bin")
            .join(executable),
    );
    paths
}

pub(crate) fn system_codex_paths() -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        ["codex.cmd", "codex.exe"]
            .into_iter()
            .filter_map(find_program)
            .collect()
    }
    #[cfg(not(windows))]
    {
        find_program("codex").into_iter().collect()
    }
}

#[cfg(all(test, windows))]
mod native_wrapper_tests {
    use super::*;

    fn fixture_root() -> PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "rocketx-native-wrapper-{}-{stamp}",
            std::process::id()
        ));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn create_package(root: &Path) -> PathBuf {
        std::fs::create_dir_all(root.join("bin")).unwrap();
        std::fs::write(
            root.join("package.json"),
            r#"{"name":"@openai/codex","bin":{"codex":"bin/codex.js"}}"#,
        )
        .unwrap();
        std::fs::write(root.join("bin/codex.js"), "synthetic entry; never executed").unwrap();
        let triple = if std::env::consts::ARCH == "aarch64" {
            "aarch64-pc-windows-msvc"
        } else {
            "x86_64-pc-windows-msvc"
        };
        let binary = root.join("vendor").join(triple).join("bin/codex.exe");
        std::fs::create_dir_all(binary.parent().unwrap()).unwrap();
        std::fs::write(&binary, b"synthetic binary; never executed").unwrap();
        binary
    }

    fn create_platform_package(package: &Path) -> PathBuf {
        let (platform, cpu) = if std::env::consts::ARCH == "aarch64" {
            ("codex-win32-arm64", "arm64")
        } else {
            ("codex-win32-x64", "x64")
        };
        let platform_root = package.join("node_modules/@openai").join(platform);
        let binary = create_package(&platform_root);
        std::fs::write(
            platform_root.join("package.json"),
            serde_json::json!({"name":"@openai/codex","os":["win32"],"cpu":[cpu]}).to_string(),
        )
        .unwrap();
        binary
    }

    fn remove_fixture(root: PathBuf) {
        let canonical = root.canonicalize().unwrap();
        assert!(canonical.starts_with(std::env::temp_dir().canonicalize().unwrap()));
        assert!(canonical
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("rocketx-native-wrapper-"));
        std::fs::remove_dir_all(canonical).unwrap();
    }

    #[test]
    fn native_npm_wrapper_targets_its_platform_binary_and_never_falls_back_to_node() {
        let root = fixture_root();
        let shim = root.join("codex.cmd");
        std::fs::write(&shim, NPM_CODEX_SHIM).unwrap();
        let package = root.join("node_modules/@openai/codex");
        let fallback = create_package(&package);
        // Supply the nearest platform dependency; ambient ancestor packages must not influence fixtures.
        let platform_binary = create_platform_package(&package);
        let resolved = resolved_native_codex_path(&shim, CodexRuntimeSource::Manual).unwrap();
        assert_eq!(
            resolved.program,
            PathBuf::from(host_path(&platform_binary.canonicalize().unwrap()))
        );
        assert_ne!(
            resolved.program,
            PathBuf::from(host_path(&fallback.canonicalize().unwrap()))
        );
        assert!(resolved.prefix_args.is_empty());
        std::fs::remove_file(platform_binary).unwrap();
        assert!(resolved_native_codex_path(&shim, CodexRuntimeSource::Manual).is_err());
        std::fs::write(
            &shim,
            format!("{NPM_CODEX_SHIM}\necho extra-wrapper-action"),
        )
        .unwrap();
        assert!(resolved_native_codex_path(&shim, CodexRuntimeSource::Manual).is_err());
        remove_fixture(root);
    }

    #[test]
    fn native_pnpm_wrapper_uses_original_package_and_rejects_added_arguments() {
        let root = fixture_root();
        let bin = root.join("node_modules/.bin");
        std::fs::create_dir_all(&bin).unwrap();
        let shim = bin.join("codex.CMD");
        let body = r#"@SETLOCAL
@IF NOT DEFINED NODE_PATH (
  @SET "NODE_PATH=C:\synthetic\node_modules"
) ELSE (
  @SET "NODE_PATH=C:\synthetic\node_modules;%NODE_PATH%"
)
@IF EXIST "%~dp0\node.exe" (
  "%~dp0\node.exe"  "%~dp0\..\@openai\codex\bin\codex.js" %*
) ELSE (
  @SET PATHEXT=%PATHEXT:;.JS;=;%
  node  "%~dp0\..\@openai\codex\bin\codex.js" %*
)
"#;
        std::fs::write(&shim, body).unwrap();
        let package = root.join("node_modules/@openai/codex");
        create_package(&package);
        let binary = create_platform_package(&package);
        let resolved = resolved_native_codex_path(&shim, CodexRuntimeSource::Manual).unwrap();
        assert_eq!(
            resolved.program,
            PathBuf::from(host_path(&binary.canonicalize().unwrap()))
        );
        assert!(resolved.prefix_args.is_empty());
        std::fs::write(&shim, body.replace(" %*", " --profile=unapproved %*")).unwrap();
        assert!(resolved_native_codex_path(&shim, CodexRuntimeSource::Manual).is_err());
        remove_fixture(root);
    }
}
