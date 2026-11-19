//! Data contracts only. Capability declarations do not establish a live controller.

use serde::{Deserialize, Serialize};

pub const NATIVE_CODEX_COMMAND_SCHEMA: &str = "rocketx.native-codex-command.v1";
pub const NATIVE_COMMAND_EXECUTOR: &str = "native_host";
pub const MAX_COMMAND_TEXT_BYTES: usize = 256 * 1024;
pub const MAX_COMMAND_JSON_BYTES: usize = 512 * 1024;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum NativeCodexIntent {
    Resume {},
    Prompt { text: String },
    Steer { text: String },
    Interrupt {},
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NativeCommandKind {
    Resume,
    Prompt,
    Steer,
    Interrupt,
}

impl NativeCodexIntent {
    pub fn kind(&self) -> NativeCommandKind {
        match self {
            Self::Resume { .. } => NativeCommandKind::Resume,
            Self::Prompt { .. } => NativeCommandKind::Prompt,
            Self::Steer { .. } => NativeCommandKind::Steer,
            Self::Interrupt { .. } => NativeCommandKind::Interrupt,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CommandSubmitter {
    User,
    Butler,
    Automation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeCommandInput {
    pub request_id: String,
    pub todo_id: String,
    pub session_id: String,
    pub expected_requirements_version: i64,
    pub expected_content_version: i64,
    pub expected_binding_version: i64,
    pub native_turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub queue_after_turn: bool,
    pub intent: NativeCodexIntent,
    pub submitted_by: CommandSubmitter,
}

impl RuntimeCommandInput {
    pub fn validate(&self) -> Result<(), String> {
        validate_identifier(&self.request_id, "requestId", 256)?;
        validate_identifier(&self.todo_id, "todoId", 256)?;
        validate_identifier(&self.session_id, "sessionId", 512)?;
        validate_version(
            self.expected_requirements_version,
            "expectedRequirementsVersion",
        )?;
        validate_version(self.expected_content_version, "expectedContentVersion")?;
        validate_version(self.expected_binding_version, "expectedBindingVersion")?;
        validate_intent(&self.intent, self.native_turn_id.as_deref())?;
        validate_queue(&self.intent, self.queue_after_turn)?;
        validate_json_size(self)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeCommandScope {
    pub account_scope: String,
    pub account_generation: u64,
    pub host_device_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeCommandBinding {
    pub session_id: String,
    pub native_thread_id: String,
    pub source_scope: String,
    pub execution_profile_id: String,
    pub workspace_root: String,
    pub binding_version: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeCommandExpected {
    pub requirements_version: i64,
    pub content_version: i64,
    pub native_turn_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeCommandSpec {
    pub schema: String,
    pub executor: String,
    pub request_id: String,
    pub todo_id: String,
    pub scope: NativeCommandScope,
    pub binding: NativeCommandBinding,
    pub expected: NativeCommandExpected,
    #[serde(default, skip_serializing_if = "is_false")]
    pub queue_after_turn: bool,
    pub intent: NativeCodexIntent,
    pub submitted_by: CommandSubmitter,
}

impl NativeCommandSpec {
    /// The caller supplies the captured native account and inspected binding.
    pub fn freeze(
        input: RuntimeCommandInput,
        scope: NativeCommandScope,
        binding: NativeCommandBinding,
    ) -> Result<Self, String> {
        input.validate()?;
        if input.session_id != binding.session_id
            || input.expected_binding_version != binding.binding_version
        {
            return Err("会话绑定或绑定版本已变化".to_string());
        }
        let spec = Self {
            schema: NATIVE_CODEX_COMMAND_SCHEMA.to_string(),
            executor: NATIVE_COMMAND_EXECUTOR.to_string(),
            request_id: input.request_id,
            todo_id: input.todo_id,
            scope,
            binding,
            expected: NativeCommandExpected {
                requirements_version: input.expected_requirements_version,
                content_version: input.expected_content_version,
                native_turn_id: input.native_turn_id,
            },
            queue_after_turn: input.queue_after_turn,
            intent: input.intent,
            submitted_by: input.submitted_by,
        };
        spec.validate()?;
        Ok(spec)
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.schema != NATIVE_CODEX_COMMAND_SCHEMA || self.executor != NATIVE_COMMAND_EXECUTOR {
            return Err("不支持的原生命令合同或执行者".to_string());
        }
        validate_identifier(&self.request_id, "requestId", 256)?;
        validate_identifier(&self.todo_id, "todoId", 256)?;
        validate_identifier(&self.scope.account_scope, "accountScope", 2048)?;
        validate_identifier(&self.scope.host_device_id, "hostDeviceId", 256)?;
        if self.scope.account_generation > MAX_SAFE_INTEGER {
            return Err("accountGeneration 超出合同整数范围".to_string());
        }
        validate_identifier(&self.binding.session_id, "sessionId", 512)?;
        validate_identifier(&self.binding.native_thread_id, "nativeThreadId", 512)?;
        validate_identifier(&self.binding.source_scope, "sourceScope", 4096)?;
        validate_identifier(
            &self.binding.execution_profile_id,
            "executionProfileId",
            256,
        )?;
        validate_identifier(&self.binding.workspace_root, "workspaceRoot", 32768)?;
        validate_version(self.binding.binding_version, "bindingVersion")?;
        validate_version(self.expected.requirements_version, "requirementsVersion")?;
        validate_version(self.expected.content_version, "contentVersion")?;
        validate_intent(&self.intent, self.expected.native_turn_id.as_deref())?;
        validate_queue(&self.intent, self.queue_after_turn)?;
        validate_json_size(self)
    }
}

/// An ownership guard, not a validation or authorization result.
pub fn is_native_command_spec(spec_json: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(spec_json)
        .ok()
        .is_some_and(|value| {
            value.get("schema").and_then(|v| v.as_str()) == Some(NATIVE_CODEX_COMMAND_SCHEMA)
                && value.get("executor").and_then(|v| v.as_str()) == Some(NATIVE_COMMAND_EXECUTOR)
        })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeCommandState {
    AwaitingApproval,
    Prepared,
    Dispatched,
    VerifyingDelivery,
    Acknowledged,
    Completed,
    Failed,
    Canceled,
}

impl RuntimeCommandState {
    /// Allowed edges still require matching native facts and CAS at the write boundary.
    pub fn can_transition_to(self, next: Self) -> bool {
        use RuntimeCommandState::*;
        self == next
            || matches!(
                (self, next),
                (AwaitingApproval, Prepared | Canceled)
                    | (Prepared, Dispatched | Failed | Canceled)
                    | (
                        Dispatched,
                        Acknowledged | Completed | Failed | VerifyingDelivery
                    )
                    | (Acknowledged, Completed | Failed | VerifyingDelivery)
                    | (VerifyingDelivery, Acknowledged | Completed | Failed)
            )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionControlAccess {
    Record,
    Resumable,
    ManagedLive,
    ExternalAttach,
}

impl SessionControlAccess {
    /// Intersects inspected access with explicitly verified methods; it performs no handshake.
    pub fn available_intents(self, verified: &[NativeCommandKind]) -> Vec<NativeCommandKind> {
        verified
            .iter()
            .copied()
            .filter(|kind| match self {
                Self::Record => false,
                Self::Resumable => *kind == NativeCommandKind::Resume,
                Self::ManagedLive | Self::ExternalAttach => *kind != NativeCommandKind::Resume,
            })
            .fold(Vec::new(), |mut result, kind| {
                if !result.contains(&kind) {
                    result.push(kind);
                }
                result
            })
    }
}

fn validate_identifier(value: &str, field: &str, limit: usize) -> Result<(), String> {
    if value.is_empty()
        || value.starts_with(contract_whitespace)
        || value.ends_with(contract_whitespace)
        || value.len() > limit
        || value.chars().any(char::is_control)
    {
        return Err(format!(
            "{field} 必须为非空、无首尾空白及控制字符且不超过 {limit} 字节的值"
        ));
    }
    Ok(())
}

fn validate_version(value: i64, field: &str) -> Result<(), String> {
    if value < 0 || value as u64 > MAX_SAFE_INTEGER {
        return Err(format!("{field} 必须为合同范围内的非负整数"));
    }
    Ok(())
}

fn validate_intent(intent: &NativeCodexIntent, native_turn_id: Option<&str>) -> Result<(), String> {
    match intent {
        NativeCodexIntent::Prompt { text } | NativeCodexIntent::Steer { text } => {
            if text.chars().all(contract_whitespace) || text.len() > MAX_COMMAND_TEXT_BYTES {
                return Err("指令正文不能为空或超过 256 KiB".to_string());
            }
        }
        _ => {}
    }
    match intent {
        NativeCodexIntent::Steer { .. } | NativeCodexIntent::Interrupt { .. } => {
            validate_identifier(
                native_turn_id.ok_or("该动作必须指定原生轮次")?,
                "nativeTurnId",
                512,
            )
        }
        _ if native_turn_id.is_some() => Err("恢复及新轮次指令不得携带旧轮次 ID".to_string()),
        _ => Ok(()),
    }
}

fn contract_whitespace(value: char) -> bool {
    value.is_whitespace() || value == '\u{feff}'
}

fn is_false(value: &bool) -> bool {
    !value
}

fn validate_queue(intent: &NativeCodexIntent, queue_after_turn: bool) -> Result<(), String> {
    if queue_after_turn && !matches!(intent, NativeCodexIntent::Prompt { .. }) {
        return Err("只有新轮次指令可以排队".into());
    }
    Ok(())
}

fn validate_json_size(value: &impl Serialize) -> Result<(), String> {
    let encoded = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    if encoded.len() > MAX_COMMAND_JSON_BYTES {
        return Err("原生命令超过 512 KiB".to_string());
    }
    Ok(())
}

// Shared by Rust tests and the TypeScript parity regression; synthetic identifiers only.
#[cfg(test)]
const CONTRACT_FIXTURE_JSON: &str = r#"{
  "input":{"requestId":"request-1","todoId":"existing-work","sessionId":"codex:binding-1","expectedRequirementsVersion":2,"expectedContentVersion":3,"expectedBindingVersion":4,"nativeTurnId":"turn-1","intent":{"kind":"steer","text":"  保留我的空白\n继续调查  "},"submittedBy":"user"},
  "scope":{"accountScope":"test-account","accountGeneration":5,"hostDeviceId":"test-device"},
  "binding":{"sessionId":"codex:binding-1","nativeThreadId":"original-thread","sourceScope":"codex:test-home","executionProfileId":"test-profile","workspaceRoot":"D:/test/workspace","bindingVersion":4},
  "inputCases":[
    {"valid":true,"patch":{"intent":{"kind":"resume"},"nativeTurnId":null}},
    {"valid":true,"patch":{"intent":{"kind":"prompt","text":"  用户正文\n  "},"nativeTurnId":null}},
    {"valid":true,"patch":{"intent":{"kind":"interrupt"}}},
    {"valid":true,"patch":{"intent":{"kind":"prompt","text":"排队继续"},"nativeTurnId":null,"queueAfterTurn":true}},
    {"valid":true,"patch":{"queueAfterTurn":false}},
    {"valid":false,"patch":{"queueAfterTurn":true}},
    {"valid":false,"patch":{"queueAfterTurn":"true"}},
    {"valid":false,"patch":{"requestId":" padded"}},
    {"valid":false,"patch":{"expectedRequirementsVersion":-1}},
    {"valid":false,"patch":{"expectedContentVersion":0.5}},
    {"valid":false,"patch":{"expectedBindingVersion":9007199254740992}},
    {"valid":false,"patch":{"nativeTurnId":null}},
    {"valid":false,"patch":{"intent":{"kind":"prompt","text":"继续"}}},
    {"valid":false,"patch":{"intent":{"kind":"steer","text":"\u0085\ufeff"}}},
    {"valid":false,"patch":{"intent":{"kind":"resume","text":"unexpected"},"nativeTurnId":null}},
    {"valid":false,"patch":{"intent":{"kind":"interrupt","extra":true}}},
    {"valid":false,"patch":{"intent":{"kind":"answer"}}},
    {"valid":false,"patch":{"submittedBy":"external_material"}},
    {"valid":false,"patch":{"controlMode":"controllable"}}
  ],
  "access":{"record":[],"resumable":["resume"],"managed_live":["prompt","steer","interrupt"],"external_attach":["prompt","steer","interrupt"]},
  "transitions":{"awaiting_approval":["awaiting_approval","prepared","canceled"],"prepared":["prepared","dispatched","failed","canceled"],"dispatched":["dispatched","acknowledged","completed","failed","verifying_delivery"],"verifying_delivery":["verifying_delivery","acknowledged","completed","failed"],"acknowledged":["acknowledged","completed","failed","verifying_delivery"],"completed":["completed"],"failed":["failed"],"canceled":["canceled"]}
}"#;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn fixture() -> Value {
        serde_json::from_str(CONTRACT_FIXTURE_JSON).unwrap()
    }

    #[test]
    fn contract_fixture_freezes_identity_and_preserves_text() {
        let fixture = fixture();
        let input: RuntimeCommandInput = serde_json::from_value(fixture["input"].clone()).unwrap();
        let spec = NativeCommandSpec::freeze(
            input.clone(),
            serde_json::from_value(fixture["scope"].clone()).unwrap(),
            serde_json::from_value(fixture["binding"].clone()).unwrap(),
        )
        .unwrap();
        assert_eq!(spec.intent, input.intent);
        assert_eq!(spec.binding.native_thread_id, "original-thread");
        let encoded = serde_json::to_string(&spec).unwrap();
        assert!(is_native_command_spec(&encoded));
        assert_eq!(
            serde_json::from_str::<NativeCommandSpec>(&encoded).unwrap(),
            spec
        );
        let mut wrong_binding = spec.binding.clone();
        wrong_binding.binding_version += 1;
        assert!(NativeCommandSpec::freeze(input, spec.scope, wrong_binding).is_err());
    }

    #[test]
    fn command_contract_rejects_ambiguous_or_unbounded_input() {
        let fixture = fixture();
        let valid = fixture["input"].clone();
        for case in fixture["inputCases"].as_array().unwrap() {
            let mut candidate = valid.clone();
            candidate
                .as_object_mut()
                .unwrap()
                .extend(case["patch"].as_object().unwrap().clone());
            let accepted = serde_json::from_value::<RuntimeCommandInput>(candidate)
                .is_ok_and(|input| input.validate().is_ok());
            assert_eq!(accepted, case["valid"].as_bool().unwrap(), "{case}");
        }
        for (key, value) in [
            ("requestId", json!(" ")),
            ("requestId", json!("a".repeat(257))),
            ("expectedRequirementsVersion", json!(-1)),
            ("expectedContentVersion", json!(9_007_199_254_740_992_u64)),
            ("expectedBindingVersion", json!(-1)),
            ("nativeTurnId", Value::Null),
            ("intent", json!({"kind":"steer","text":"  \n"})),
            (
                "intent",
                json!({"kind":"steer","text":"中".repeat(MAX_COMMAND_TEXT_BYTES / 3 + 1)}),
            ),
        ] {
            let mut invalid = valid.clone();
            invalid[key] = value;
            let input: RuntimeCommandInput = serde_json::from_value(invalid).unwrap();
            assert!(input.validate().is_err(), "accepted invalid {key}");
        }
        for invalid in [
            json!({"kind":"answer"}),
            json!({"kind":"resume","text":"must not be ignored"}),
            json!({"kind":"interrupt","extra":true}),
        ] {
            assert!(serde_json::from_value::<NativeCodexIntent>(invalid).is_err());
        }
        let mut unknown = valid;
        unknown["controlMode"] = json!("controllable");
        assert!(serde_json::from_value::<RuntimeCommandInput>(unknown).is_err());
    }

    #[test]
    fn command_queue_defaults_are_wire_compatible_and_only_prompts_can_queue() {
        let fixture = fixture();
        let input: RuntimeCommandInput = serde_json::from_value(fixture["input"].clone()).unwrap();
        assert!(!input.queue_after_turn);
        assert!(serde_json::to_value(&input)
            .unwrap()
            .get("queueAfterTurn")
            .is_none());
        let mut spec = NativeCommandSpec::freeze(
            input,
            serde_json::from_value(fixture["scope"].clone()).unwrap(),
            serde_json::from_value(fixture["binding"].clone()).unwrap(),
        )
        .unwrap();
        assert!(serde_json::to_value(&spec)
            .unwrap()
            .get("queueAfterTurn")
            .is_none());
        spec.queue_after_turn = true;
        assert!(spec.validate().is_err());
        spec.intent = NativeCodexIntent::Prompt {
            text: "next".into(),
        };
        spec.expected.native_turn_id = None;
        spec.validate().unwrap();
        assert_eq!(serde_json::to_value(&spec).unwrap()["queueAfterTurn"], true);
    }

    #[test]
    fn command_state_and_access_match_shared_fixture() {
        let fixture = fixture();
        let kinds = [
            NativeCommandKind::Resume,
            NativeCommandKind::Prompt,
            NativeCommandKind::Steer,
            NativeCommandKind::Interrupt,
        ];
        for (mode, expected) in fixture["access"].as_object().unwrap() {
            let access: SessionControlAccess = serde_json::from_value(json!(mode)).unwrap();
            assert_eq!(
                serde_json::to_value(access.available_intents(&kinds)).unwrap(),
                *expected
            );
            assert!(access.available_intents(&[]).is_empty());
        }
        for (from, expected) in fixture["transitions"].as_object().unwrap() {
            let state: RuntimeCommandState = serde_json::from_value(json!(from)).unwrap();
            for next in fixture["transitions"].as_object().unwrap().keys() {
                let next_state = serde_json::from_value(json!(next)).unwrap();
                assert_eq!(
                    state.can_transition_to(next_state),
                    expected.as_array().unwrap().contains(&json!(next)),
                    "{from} -> {next}"
                );
            }
        }
    }
}
