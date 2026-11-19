use std::sync::OnceLock;

const PRODUCTION_IDENTIFIER: &str = "com.lusipad.rocketx";
static APPLICATION_IDENTIFIER: OnceLock<String> = OnceLock::new();

pub(crate) fn set_application_identifier(identifier: &str) -> Result<(), String> {
    if identifier.is_empty()
        || identifier
            .chars()
            .any(|value| value.is_control() || value == ':')
    {
        return Err("application credential identifier is invalid".to_string());
    }
    match APPLICATION_IDENTIFIER.set(identifier.to_string()) {
        Ok(()) => Ok(()),
        Err(value) if APPLICATION_IDENTIFIER.get() == Some(&value) => Ok(()),
        Err(_) => Err("application credential identifier is already initialized".to_string()),
    }
}

pub(crate) fn service_name(original: &str) -> Result<String, String> {
    scoped_service_name(APPLICATION_IDENTIFIER.get().map(String::as_str), original)
}

fn scoped_service_name(identifier: Option<&str>, original: &str) -> Result<String, String> {
    match identifier {
        Some(PRODUCTION_IDENTIFIER) => Ok(original.to_string()),
        Some(identifier) => Ok(format!("{identifier}:{original}")),
        None => Err("application credential identifier is not initialized".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn production_identifier_preserves_existing_service_names() {
        for service in [
            "com.lusipad.rocketx.agent-bot",
            "com.lusipad.rocketx.business-mcp.rocket-chat",
            "com.lusipad.rocketx.business-mcp.azure-devops",
            "com.lusipad.rocketx.mcp",
            "com.lusipad.rocketx.lan",
        ] {
            assert_eq!(
                scoped_service_name(Some(PRODUCTION_IDENTIFIER), service).unwrap(),
                service
            );
        }
    }

    #[test]
    fn separate_instances_do_not_share_credential_services() {
        let service = "com.lusipad.rocketx.mcp";
        let first = scoped_service_name(Some("com.lusipad.rocketx.test-a"), service).unwrap();
        let second = scoped_service_name(Some("com.lusipad.rocketx.test-b"), service).unwrap();
        assert_eq!(first, format!("com.lusipad.rocketx.test-a:{service}"));
        assert_ne!(first, second);
        assert_ne!(first, service);
        assert_ne!(second, service);
    }

    #[test]
    fn separate_services_in_one_instance_remain_separate() {
        let identifier = Some("com.lusipad.rocketx.test");
        assert_ne!(
            scoped_service_name(identifier, "com.lusipad.rocketx.mcp").unwrap(),
            scoped_service_name(identifier, "com.lusipad.rocketx.agent-bot").unwrap(),
        );
    }

    #[test]
    fn uninitialized_scope_never_falls_back_to_production() {
        assert!(scoped_service_name(None, "com.lusipad.rocketx.mcp").is_err());
    }
}
