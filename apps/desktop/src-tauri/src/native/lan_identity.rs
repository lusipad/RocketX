//! LAN identity scoping and server binding.

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

pub(crate) fn server_fingerprint(server_url: &str) -> Result<String, String> {
    let (server_url, _) = validate_scope(server_url, "fingerprint")?;
    Ok(blake3::hash(server_url.as_bytes()).to_hex().to_string())
}

pub(crate) fn account_key(server_url: &str, user_id: &str) -> Result<String, String> {
    let (server_url, user_id) = validate_scope(server_url, user_id)?;
    let mut input = Vec::with_capacity(server_url.len() + user_id.len() + 1);
    input.extend_from_slice(server_url.as_bytes());
    input.push(0);
    input.extend_from_slice(user_id.as_bytes());
    Ok(format!("identity-{}", blake3::hash(&input).to_hex()))
}

#[cfg(test)]
mod tests {
    use super::{account_key, server_fingerprint, validate_scope};

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
}
