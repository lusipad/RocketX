#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DshBridgeMode {
    Controller,
    Web,
}

impl DshBridgeMode {
    pub(crate) fn from_arg(mode: Option<&str>) -> Result<Self, String> {
        match mode.map(str::trim).filter(|value| !value.is_empty()) {
            Some("controller") | None => Ok(Self::Controller),
            Some("web") => Ok(Self::Web),
            Some(other) => Err(format!("不支持的 DSH mode：{other}")),
        }
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Controller => "controller",
            Self::Web => "web",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::DshBridgeMode;

    #[test]
    fn mode_contract_accepts_controller_and_web_only() {
        assert_eq!(
            DshBridgeMode::from_arg(None).unwrap().as_str(),
            "controller"
        );
        assert_eq!(
            DshBridgeMode::from_arg(Some("web")).unwrap().as_str(),
            "web"
        );
        assert!(DshBridgeMode::from_arg(Some("other")).is_err());
    }
}
