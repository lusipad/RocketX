//! Codex runtime discovery policy.
//!
//! Process spawning and Tauri commands stay in `proc.rs`; this module owns
//! the pure version/token decisions so they can be tested without an app.

use super::codex::parse_semantic_version;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Compatibility {
    Verified,
    UntestedNewer,
    Blocked,
}

pub(crate) fn classify_version(
    version: &str,
    baseline: &str,
    verified_versions: &[&str],
) -> Result<Compatibility, String> {
    let actual = parse_semantic_version(version)
        .ok_or_else(|| format!("Codex 返回了无法识别的版本 {version}"))?;
    if verified_versions.contains(&version) {
        return Ok(Compatibility::Verified);
    }
    let baseline = parse_semantic_version(baseline)
        .ok_or_else(|| format!("Codex 协议基线无效：{baseline}"))?;
    if actual < baseline || (actual == baseline && version.contains('-')) {
        return Ok(Compatibility::Blocked);
    }
    Ok(Compatibility::UntestedNewer)
}

pub(crate) fn unsupported_version_message(version: &str, baseline: &str) -> String {
    format!("找到 Codex {version}，但低于 RocketX 所需的协议基线 {baseline}；请升级后重新检测")
}

pub(crate) fn version_token(token: &str) -> Option<&str> {
    let token = token.strip_prefix('v').unwrap_or(token);
    if !token
        .chars()
        .next()
        .is_some_and(|value| value.is_ascii_digit())
        || !token.contains('.')
    {
        return None;
    }
    token
        .chars()
        .all(|value| value.is_ascii_alphanumeric() || matches!(value, '.' | '-' | '+'))
        .then_some(token)
}

pub(crate) fn parse_cli_version(output: &str, require_codex_prefix: bool) -> Option<String> {
    let mut fallback = None;
    for line in output.lines() {
        let tokens: Vec<&str> = line.split_whitespace().collect();
        let Some((first, rest)) = tokens.split_first() else {
            continue;
        };
        if first.eq_ignore_ascii_case("codex-cli") || first.eq_ignore_ascii_case("codex") {
            if let Some(version) = rest.iter().copied().find_map(version_token) {
                return Some(version.to_string());
            }
        }
        if !require_codex_prefix && fallback.is_none() {
            fallback = tokens
                .iter()
                .copied()
                .find_map(version_token)
                .map(ToOwned::to_owned);
        }
    }
    fallback
}

pub(crate) fn normalize_update_version(
    value: &str,
    normalize: impl Fn(&str) -> Option<String>,
) -> Option<(u64, u64, u64)> {
    normalize(value).and_then(|version| parse_semantic_version(&version))
}

#[cfg(test)]
mod tests {
    use super::{classify_version, normalize_update_version, parse_cli_version, Compatibility};

    #[test]
    fn classification_keeps_verified_and_blocks_old_protocols() {
        assert_eq!(
            classify_version("0.144.4", "0.144.4", &["0.144.4"]).unwrap(),
            Compatibility::Verified
        );
        assert_eq!(
            classify_version("0.143.9", "0.144.4", &["0.144.4"]).unwrap(),
            Compatibility::Blocked
        );
        assert_eq!(
            classify_version("0.145.0", "0.144.4", &["0.144.4"]).unwrap(),
            Compatibility::UntestedNewer
        );
    }

    #[test]
    fn cli_parser_requires_codex_prefix_on_error_paths() {
        assert_eq!(
            parse_cli_version("codex-cli 0.144.4", true),
            Some("0.144.4".into())
        );
        assert_eq!(parse_cli_version("warning 1.2.3", true), None);
        assert_eq!(
            parse_cli_version("version 1.2.3", false),
            Some("1.2.3".into())
        );
    }

    #[test]
    fn updater_version_normalization_is_adapter_driven() {
        assert_eq!(
            normalize_update_version("v1.2.3", |value| Some(
                value.trim_start_matches('v').to_string()
            )),
            Some((1, 2, 3))
        );
    }
}
