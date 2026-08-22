//! DSH runtime discovery and version policy.

pub(crate) const MIN_NODE_22_MINOR: u64 = 19;

pub(crate) fn parse_node_version(value: &str) -> Option<(u64, u64, u64)> {
    let version = value.trim().trim_start_matches('v');
    let core = version.split(['-', '+']).next()?;
    let mut parts = core.split('.');
    let parsed = (
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
    );
    parts.next().is_none().then_some(parsed)
}

pub(crate) fn node_version_is_compatible(value: &str) -> bool {
    match parse_node_version(value) {
        Some((22, minor, _)) => minor >= MIN_NODE_22_MINOR,
        Some((major, _, _)) => major >= 24,
        None => false,
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct DshVersion {
    major: u64,
    minor: u64,
    patch: u64,
    prerelease: Vec<DshPrereleasePart>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum DshPrereleasePart {
    Numeric(u64),
    Text(String),
}

impl Ord for DshVersion {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        (self.major, self.minor, self.patch)
            .cmp(&(other.major, other.minor, other.patch))
            .then_with(|| compare_prerelease(&self.prerelease, &other.prerelease))
    }
}

impl PartialOrd for DshVersion {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for DshPrereleasePart {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        use std::cmp::Ordering as CmpOrdering;
        match (self, other) {
            (Self::Numeric(a), Self::Numeric(b)) => a.cmp(b),
            (Self::Numeric(_), Self::Text(_)) => CmpOrdering::Less,
            (Self::Text(_), Self::Numeric(_)) => CmpOrdering::Greater,
            (Self::Text(a), Self::Text(b)) => a.cmp(b),
        }
    }
}

impl PartialOrd for DshPrereleasePart {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

fn compare_prerelease(
    left: &[DshPrereleasePart],
    right: &[DshPrereleasePart],
) -> std::cmp::Ordering {
    use std::cmp::Ordering as CmpOrdering;
    match (left.is_empty(), right.is_empty()) {
        (true, true) => CmpOrdering::Equal,
        (true, false) => CmpOrdering::Greater,
        (false, true) => CmpOrdering::Less,
        (false, false) => left.cmp(right),
    }
}

pub(crate) fn parse_dsh_version(raw: &str) -> Option<DshVersion> {
    let text = raw.trim();
    let text = text.strip_prefix(['v', 'V']).unwrap_or(text);
    let text = text.split('+').next().unwrap_or(text);
    let (core, prerelease) = match text.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => {
            let core_len = text
                .char_indices()
                .take_while(|(_, ch)| ch.is_ascii_digit() || *ch == '.')
                .map(|(index, ch)| index + ch.len_utf8())
                .last()
                .unwrap_or(0);
            let (core, rest) = text.split_at(core_len);
            (core, if rest.is_empty() { None } else { Some(rest) })
        }
    };
    let mut core_parts = core.split('.');
    let major = core_parts.next()?.parse().ok()?;
    let minor = core_parts.next()?.parse().ok()?;
    let patch = core_parts.next()?.parse().ok()?;
    if core_parts.next().is_some() {
        return None;
    }
    let prerelease = prerelease
        .filter(|pre| !pre.is_empty())
        .map(|pre| {
            pre.split('.')
                .map(|part| match part.parse::<u64>() {
                    Ok(number) => DshPrereleasePart::Numeric(number),
                    Err(_) => DshPrereleasePart::Text(part.to_string()),
                })
                .collect()
        })
        .unwrap_or_default();
    Some(DshVersion {
        major,
        minor,
        patch,
        prerelease,
    })
}

#[cfg(test)]
mod tests {
    use super::{node_version_is_compatible, parse_node_version};

    #[test]
    fn accepts_supported_node_lines_and_rejects_old_versions() {
        assert_eq!(parse_node_version("v22.19.0"), Some((22, 19, 0)));
        assert!(node_version_is_compatible("22.19.1"));
        assert!(node_version_is_compatible("24.0.0"));
        assert!(!node_version_is_compatible("22.18.0"));
        assert!(!node_version_is_compatible("not-node"));
    }
}
