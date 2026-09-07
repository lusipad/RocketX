//! LAN identity scoping and server binding.

/// 同一台 Rocket.Chat 服务器可能以多种 URL 被访问（内网 IP / 主机名 / localhost /
/// 入口域名），LAN 作用域必须把它们归一化为「同一个服务器」，否则两台设备分别
/// 用不同地址登录时互相发现不了（issue #369：no LAN peer is online）。
/// 同时保留主机部分区分不同服务器，避免 A/B 两台服务器互相串号。
pub(crate) fn canonical_server_id(server_url: &str) -> Result<String, String> {
    let (server_url, _) = validate_scope(server_url, "fingerprint")?;
    Ok(normalize_server_url(server_url))
}

/// URL 归一化：scheme 小写、去默认端口、host 小写、去尾斜杠、去 query/fragment。
/// 不做 DNS 解析（可能阻塞/离线），只做文本级归一化；主机名与 IP 不同视为不同
/// 服务器（localhost 除外，见 `server_url_aliases`）。
fn normalize_server_url(raw: &str) -> String {
    let trimmed = raw.trim().trim_end_matches('/');
    parse_server_url(trimmed)
        .or_else(|| parse_server_url(&format!("http://{trimmed}")))
        .map(|(scheme, host, port, path)| {
            let port_suffix = match port {
                Some(p) if !((scheme == "http" && p == 80) || (scheme == "https" && p == 443)) => {
                    format!(":{p}")
                }
                _ => String::new(),
            };
            let mut path = path.trim_end_matches('/').to_string();
            if path.is_empty() {
                path = "/".to_string();
            }
            format!("{scheme}://{host}{port_suffix}{path}")
        })
        .unwrap_or_else(|| trimmed.to_lowercase())
}

/// `scheme://host[:port]/path` —— 只处理 http/https，其余返回 None。
fn parse_server_url(raw: &str) -> Option<(String, String, Option<u16>, String)> {
    let (scheme, rest) = raw.split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    if !matches!(scheme.as_str(), "http" | "https") {
        return None;
    }
    // 先把 query/fragment 从整体切掉（可能在 authority 后、无 path 时）
    let rest = rest.split(['?', '#']).next().unwrap_or(rest);
    let authority_end = rest.find('/').unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    let path = &rest[authority_end..];
    let (host, port) = split_authority(authority);
    if host.is_empty() {
        return None;
    }
    Some((scheme, host, port, path.to_string()))
}

fn split_authority(authority: &str) -> (String, Option<u16>) {
    // IPv6 字面量 [::1]:port 不拆分；普通 host:port 才拆分
    if let Some((host, port)) = authority
        .strip_prefix('[')
        .and_then(|value| value.split_once(']'))
        .map(|(host, tail)| {
            let port = tail.strip_prefix(':').and_then(|p| p.parse::<u16>().ok());
            (host.to_ascii_lowercase(), port)
        })
    {
        return (host, port);
    }
    match authority.rsplit_once(':') {
        Some((host, port)) if port.chars().all(|c| c.is_ascii_digit()) => {
            (host.to_ascii_lowercase(), port.parse::<u16>().ok())
        }
        _ => (authority.to_ascii_lowercase(), None),
    }
}

/// 同服务器 URL 的等价别名：localhost 与 127.0.0.1 视为同一主机。
fn server_url_aliases(raw: &str) -> String {
    let normalized = normalize_server_url(raw);
    let aliases = [
        normalized.clone(),
        normalized.replace("://localhost", "://127.0.0.1"),
        normalized.replace("://127.0.0.1", "://localhost"),
    ];
    aliases
        .into_iter()
        .filter(|alias| !alias.is_empty())
        .min()
        .unwrap_or(normalized)
}

/// 服务器身份指纹：同一服务器在不同接入 URL 下必须一致。
pub(crate) fn server_fingerprint(server_url: &str) -> Result<String, String> {
    let (server_url, _) = validate_scope(server_url, "fingerprint")?;
    Ok(blake3::hash(server_url_aliases(server_url).as_bytes())
        .to_hex()
        .to_string())
}

pub(crate) fn account_key(server_url: &str, user_id: &str) -> Result<String, String> {
    let (server_url, user_id) = validate_scope(server_url, user_id)?;
    let mut input = Vec::with_capacity(server_url.len() + user_id.len() + 1);
    input.extend_from_slice(server_url_aliases(server_url).as_bytes());
    input.push(0);
    input.extend_from_slice(user_id.as_bytes());
    Ok(format!("identity-{}", blake3::hash(&input).to_hex()))
}

pub(crate) fn validate_scope<'a, 'b>(
    server_url: &'a str,
    user_id: &'b str,
) -> Result<(&'a str, &'b str), String> {
    if server_url.chars().any(char::is_control) || user_id.chars().any(char::is_control) {
        return Err("LAN identity scope contains control characters".to_string());
    }
    let server_url = server_url.trim();
    let user_id = user_id.trim();
    if server_url.is_empty() || server_url.len() > 2048 {
        return Err("invalid Rocket.Chat server URL".to_string());
    }
    if user_id.is_empty() || user_id.len() > 256 {
        return Err("invalid Rocket.Chat user id".to_string());
    }
    Ok((server_url, user_id))
}

#[cfg(test)]
mod tests {
    use super::{account_key, normalize_server_url, server_fingerprint, validate_scope};

    #[test]
    fn identity_scope_rejects_controls_and_is_server_bound() {
        assert!(validate_scope("https://chat.example", "user").is_ok());
        assert!(validate_scope("https://chat.example\n", "user").is_err());
        assert_ne!(
            account_key("https://a.example", "user").unwrap(),
            account_key("https://b.example", "user").unwrap()
        );
        assert_ne!(
            server_fingerprint("https://a.example").unwrap(),
            server_fingerprint("https://b.example").unwrap()
        );
    }

    #[test]
    fn fingerprint_normalizes_url_variants_of_the_same_server() {
        let variants = [
            "http://192.168.1.10:3300",
            "http://192.168.1.10:3300/",
            "HTTP://192.168.1.10:3300",
            "http://192.168.1.10:3300?token=x",
            "http://192.168.1.10:3300/#frag",
        ];
        let first = server_fingerprint(variants[0]).unwrap();
        for variant in &variants[1..] {
            assert_eq!(
                server_fingerprint(variant).unwrap(),
                first,
                "variant: {variant}"
            );
        }
    }

    #[test]
    fn fingerprint_keeps_distinct_servers_distinct() {
        assert_ne!(
            server_fingerprint("http://192.168.1.10:3300").unwrap(),
            server_fingerprint("http://192.168.1.20:3300").unwrap()
        );
        assert_ne!(
            server_fingerprint("http://host-a:3300").unwrap(),
            server_fingerprint("http://host-b:3300").unwrap()
        );
        // scheme 不同视为不同服务器（http 与 https 是不同入口）
        assert_ne!(
            server_fingerprint("http://192.168.1.10:3300").unwrap(),
            server_fingerprint("https://192.168.1.10:3300").unwrap()
        );
    }

    #[test]
    fn normalize_strips_default_ports_and_lowercases_host() {
        assert_eq!(
            normalize_server_url("HTTP://Chat.Example:80"),
            "http://chat.example/"
        );
        assert_eq!(
            normalize_server_url("https://chat.example:443"),
            "https://chat.example/"
        );
        assert_eq!(
            normalize_server_url("http://chat.example:3300"),
            "http://chat.example:3300/"
        );
        // 无 scheme 输入按 http 处理（登录框允许）
        assert_eq!(normalize_server_url("chat.example"), "http://chat.example/");
    }

    #[test]
    fn localhost_aliases_share_fingerprint() {
        let via_localhost = server_fingerprint("http://localhost:3300").unwrap();
        let via_loopback = server_fingerprint("http://127.0.0.1:3300").unwrap();
        assert_eq!(via_localhost, via_loopback);
    }
}
