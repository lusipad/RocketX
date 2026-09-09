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

/// 服务器自报身份（Rocket.Chat 的 `uniqueID` 公开设置）的哈希域，
/// 与接入 URL 归一化的兜底值分属不同前缀，避免两种算法意外相等。
const SERVER_ID_DOMAIN: &str = "rcx-lan-server-id\0";
const MAX_SERVER_ID_LEN: usize = 256;

/// 服务器自报的身份可用时才允许充当指纹：非空、无控制字符、长度合规。
fn usable_server_id(server_id: Option<&str>) -> Option<&str> {
    let value = server_id?.trim();
    if value.is_empty() || value.len() > MAX_SERVER_ID_LEN || value.chars().any(char::is_control) {
        return None;
    }
    Some(value)
}

/// 指纹的权威输入是「服务器是谁」，不是「客户端怎么连」。
///
/// issue #369：指纹原先只由接入 URL 决定，两台设备一边填 IP、一边填主机名登录
/// 同一台 Rocket.Chat，算出的指纹不同，公告在 `record_peer` 就被静默丢掉，界面
/// 只提示「对方当前不可用 P2P 直传」。改用服务器自报的 `uniqueID` 后，IP /
/// 主机名 / HTTP / HTTPS 入口得到同一个指纹，不同服务器仍天然不同，也不需要
/// DNS 解析。读不到 `uniqueID`（旧版本、网络失败）时退回原来的 URL 归一化。
///
/// 注意这个值同时是握手 transcript 的绑定字段（见 `lan_protocol`），
/// 因此只能有一个权威值：按两套指纹分别放行发现，会得到「能发现、但签名永远
/// 验不过」的连接。
pub(crate) fn server_fingerprint_for(
    server_url: &str,
    server_id: Option<&str>,
) -> Result<String, String> {
    let (server_url, _) = validate_scope(server_url, "fingerprint")?;
    match usable_server_id(server_id) {
        Some(id) => Ok(blake3::hash(format!("{SERVER_ID_DOMAIN}{id}").as_bytes())
            .to_hex()
            .to_string()),
        None => server_fingerprint(server_url),
    }
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
    use super::{
        account_key, normalize_server_url, server_fingerprint, server_fingerprint_for,
        validate_scope,
    };

    #[test]
    fn server_id_makes_every_entry_url_agree_on_one_server() {
        // issue #369 的真正根因：指纹原先由「客户端怎么连」决定，两台机器一边用
        // IP、一边用主机名登录同一台服务器就永远发现不了对方。改由服务器自报的
        // uniqueID 决定后，入口地址不再影响身份。
        let unique_id = "2cfa8f73-0198-4d12-99d0-9cbdd50f21dc";
        let entries = [
            "http://192.168.1.10:3300",
            "http://myserver:3300",
            "http://chat.corp",
            "https://chat.corp",
            "https://chat.corp/rocketchat",
        ];
        let first = server_fingerprint_for(entries[0], Some(unique_id)).unwrap();
        for entry in &entries[1..] {
            assert_eq!(
                server_fingerprint_for(entry, Some(unique_id)).unwrap(),
                first,
                "entry: {entry}"
            );
        }
    }

    #[test]
    fn different_servers_still_get_different_fingerprints() {
        let a =
            server_fingerprint_for("http://192.168.1.10:3300", Some("server-a-unique")).unwrap();
        let b =
            server_fingerprint_for("http://192.168.1.10:3300", Some("server-b-unique")).unwrap();
        assert_ne!(a, b, "不同 uniqueID 的服务器不能撞车");
        // 服务器身份指纹与「接入 URL 归一化」的兜底值也必须不同，
        // 否则新旧算法会在某些输入上意外相等。
        assert_ne!(a, server_fingerprint("http://192.168.1.10:3300").unwrap());
    }

    #[test]
    fn missing_or_unusable_server_id_falls_back_to_url_normalisation() {
        let fallback = server_fingerprint("http://192.168.1.10:3300").unwrap();
        for server_id in [None, Some(""), Some("   "), Some("bad\nid")] {
            assert_eq!(
                server_fingerprint_for("http://192.168.1.10:3300", server_id).unwrap(),
                fallback,
                "server_id: {server_id:?}"
            );
        }
        // 超长值同样退回兜底，不进哈希。
        let long = "x".repeat(257);
        assert_eq!(
            server_fingerprint_for("http://192.168.1.10:3300", Some(&long)).unwrap(),
            fallback
        );
    }

    #[test]
    fn server_id_fingerprint_ignores_surrounding_whitespace() {
        assert_eq!(
            server_fingerprint_for("http://a.example", Some(" unique-id ")).unwrap(),
            server_fingerprint_for("http://b.example", Some("unique-id")).unwrap()
        );
    }

    #[test]
    fn server_id_does_not_bypass_scope_validation() {
        assert!(server_fingerprint_for("https://chat.example\n", Some("unique-id")).is_err());
        assert!(server_fingerprint_for("", Some("unique-id")).is_err());
    }

    #[test]
    fn account_key_stays_bound_to_the_entry_url() {
        // 设备身份的钥匙串作用域不跟着指纹改：改了会让已有设备身份全部失联。
        assert_ne!(
            account_key("http://192.168.1.10:3300", "user").unwrap(),
            account_key("http://myserver:3300", "user").unwrap()
        );
    }

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
