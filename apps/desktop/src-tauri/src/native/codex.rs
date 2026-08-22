/// Parse the semantic version shape shared by Codex runtime and updater
/// compatibility checks. Pre-release/build suffixes are intentionally ignored.
pub(crate) fn parse_semantic_version(version: &str) -> Option<(u64, u64, u64)> {
    let core = version.split(['-', '+']).next()?;
    let mut parts = core.split('.');
    let parsed = (
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
    );
    parts.next().is_none().then_some(parsed)
}

#[cfg(test)]
mod tests {
    use super::parse_semantic_version;

    #[test]
    fn accepts_core_and_suffixes_but_requires_three_components() {
        assert_eq!(parse_semantic_version("0.144.4"), Some((0, 144, 4)));
        assert_eq!(parse_semantic_version("0.145.0-beta.1"), Some((0, 145, 0)));
        assert_eq!(parse_semantic_version("0.144"), None);
    }
}
