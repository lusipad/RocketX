//! Validates one answer against its original server request. No state or persistence.

use serde_json::{json, Map, Value};

const MAX_ANSWER_CHARS: usize = 8192;
const MAX_ANSWER_BYTES: usize = 64 * 1024;

pub(crate) fn supported_decision_method(method: &str) -> bool {
    matches!(
        method,
        "item/commandExecution/requestApproval"
            | "item/fileChange/requestApproval"
            | "item/tool/requestUserInput"
            | "item/permissions/requestApproval"
    )
}

fn exact_object<'a>(value: &'a Value, fields: &[&str]) -> Result<&'a Map<String, Value>, String> {
    let object = value.as_object().ok_or("答复必须是对象")?;
    if object.len() != fields.len() || fields.iter().any(|field| !object.contains_key(*field)) {
        return Err("答复存在额外字段或缺少必需字段".into());
    }
    Ok(object)
}

fn allowed_decision(params: &Value, decision: &str) -> Result<(), String> {
    if let Some(available) = params.get("availableDecisions") {
        let available = available.as_array().ok_or("原请求的可用决定格式无效")?;
        if !available
            .iter()
            .any(|choice| choice.as_str() == Some(decision))
        {
            return Err("该决定不在原请求允许的选项中".into());
        }
    }
    Ok(())
}

pub(crate) fn answer_for_request(
    method: &str,
    params: &Value,
    answer: &Value,
) -> Result<Value, String> {
    if !supported_decision_method(method) {
        return Err("尚不支持该原生请求类型".into());
    }
    if !params.is_object() {
        return Err("原请求参数格式无效".into());
    }
    if serde_json::to_vec(answer)
        .map_err(|_| "无法编码答复")?
        .len()
        > MAX_ANSWER_BYTES
    {
        return Err("答复超过 64 KiB 限制".into());
    }
    match method {
        "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
            let object = exact_object(answer, &["decision"])?;
            let decision = object["decision"].as_str().ok_or("审批决定格式无效")?;
            if !matches!(decision, "accept" | "decline" | "cancel") {
                return Err("审批仅支持本次接受、拒绝或取消".into());
            }
            allowed_decision(params, decision)?;
            Ok(answer.clone())
        }
        "item/tool/requestUserInput" => {
            let questions = params
                .get("questions")
                .and_then(Value::as_array)
                .filter(|questions| !questions.is_empty())
                .ok_or("原请求缺少有效问题")?;
            let object = exact_object(answer, &["answers"])?;
            let answers = object["answers"].as_object().ok_or("问题答复格式无效")?;
            let mut ids = std::collections::HashSet::new();
            for question in questions {
                let id = question
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|id| !id.trim().is_empty())
                    .ok_or("原问题缺少有效标识")?;
                if !ids.insert(id) {
                    return Err("原问题标识重复，无法确认答复对应关系".into());
                }
                let entry = answers.get(id).ok_or("答复缺少原问题标识")?;
                let entry = exact_object(entry, &["answers"])?;
                let texts = entry["answers"]
                    .as_array()
                    .filter(|texts| !texts.is_empty())
                    .ok_or("每个问题至少需要一项文本答复")?;
                for text in texts {
                    let text = text.as_str().ok_or("问题答复必须是文本")?;
                    if text.trim().is_empty() || text.chars().count() > MAX_ANSWER_CHARS {
                        return Err("单项答复不能为空且不得超过 8192 个字符".into());
                    }
                }
            }
            if answers.len() != ids.len() {
                return Err("答复包含不属于原请求的问题标识".into());
            }
            Ok(answer.clone())
        }
        "item/permissions/requestApproval" => {
            if answer.get("decision").is_some() {
                let object = exact_object(answer, &["decision"])?;
                let decision = object["decision"].as_str().ok_or("权限拒绝决定格式无效")?;
                if !matches!(decision, "decline" | "cancel") {
                    return Err("权限请求目前仅支持拒绝".into());
                }
                allowed_decision(params, decision)?;
            } else {
                let object = exact_object(answer, &["permissions", "scope"])?;
                if object["scope"].as_str() != Some("turn")
                    || !object["permissions"].as_object().is_some_and(Map::is_empty)
                {
                    return Err("权限答复只允许本轮空权限，禁止授权或会话级范围".into());
                }
                if allowed_decision(params, "decline").is_err() {
                    allowed_decision(params, "cancel")?;
                }
            }
            Ok(json!({"permissions": {}, "scope": "turn"}))
        }
        _ => unreachable!("supported methods are handled above"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const APPROVAL: &str = "item/commandExecution/requestApproval";
    const INPUT: &str = "item/tool/requestUserInput";
    const PERMISSIONS: &str = "item/permissions/requestApproval";

    #[test]
    fn decision_methods_are_explicit_and_unsupported_requests_return_error() {
        for method in [
            APPROVAL,
            "item/fileChange/requestApproval",
            INPUT,
            PERMISSIONS,
        ] {
            assert!(supported_decision_method(method));
        }
        for method in [
            "item/tool/call",
            "execCommandApproval",
            "requestApproval",
            "",
        ] {
            assert!(!supported_decision_method(method));
            assert!(answer_for_request(method, &json!({}), &json!({})).is_err());
        }
    }

    #[test]
    fn approvals_reject_session_grants_and_extra_or_stale_body_fields() {
        for method in [APPROVAL, "item/fileChange/requestApproval"] {
            for decision in ["accept", "decline", "cancel"] {
                let answer = json!({"decision":decision});
                assert_eq!(
                    answer_for_request(method, &json!({}), &answer).unwrap(),
                    answer
                );
            }
            for answer in [
                json!({"decision":"acceptForSession"}),
                json!({"decision":"accept", "permissions":{"network":true}}),
                json!({"decision":"accept", "requestId":"old-request"}),
                json!({"decision":"accept", "scope":"session"}),
                json!({"decision":{"acceptWithExecpolicyAmendment":[]}}),
                json!("accept"),
                json!({}),
            ] {
                assert!(answer_for_request(method, &json!({}), &answer).is_err());
            }
        }
    }

    #[test]
    fn approvals_cannot_expand_original_available_decisions() {
        let params = json!({"availableDecisions":["decline","cancel"]});
        assert!(answer_for_request(APPROVAL, &params, &json!({"decision":"accept"})).is_err());
        assert!(answer_for_request(APPROVAL, &params, &json!({"decision":"decline"})).is_ok());
        for available in [
            json!([]),
            json!(null),
            json!("accept"),
            json!([{"decision":"accept"}]),
        ] {
            assert!(answer_for_request(
                APPROVAL,
                &json!({"availableDecisions":available}),
                &json!({"decision":"accept"})
            )
            .is_err());
        }
    }

    #[test]
    fn approval_without_decline_requires_explicit_cancel_not_a_policy_amendment() {
        let params = json!({"availableDecisions":["accept",{
            "acceptWithExecpolicyAmendment":{"execpolicy_amendment":["synthetic-command"]}
        },"cancel"]});
        assert_eq!(
            answer_for_request(APPROVAL, &params, &json!({"decision":"cancel"})).unwrap(),
            json!({"decision":"cancel"})
        );
        assert!(answer_for_request(APPROVAL, &params, &json!({"decision":"decline"})).is_err());
        assert!(answer_for_request(APPROVAL, &params, &json!({"decision":{"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["synthetic-command"]}}})).is_err());
    }

    #[test]
    fn user_input_requires_exact_original_question_ids_and_fields() {
        let params = json!({"questions":[{"id":"first"},{"id":"second"}]});
        for answer in [
            json!({"answers":{"first":{"answers":["a"]}}}),
            json!({"answers":{"first":{"answers":["a"]},"second":{"answers":["b"]},"old":{"answers":["c"]}}}),
            json!({"answers":{"old-first":{"answers":["a"]},"second":{"answers":["b"]}}}),
            json!({"answers":{"first":{"answers":["a"],"secret":true},"second":{"answers":["b"]}}}),
            json!({"answers":{"first":{"answers":[]},"second":{"answers":["b"]}}}),
            json!({"answers":{"first":{"answers":["  \n "]},"second":{"answers":["b"]}}}),
            json!({"answers":{"first":{"answers":[1]},"second":{"answers":["b"]}}}),
            json!({"answers":{"first":{"answers":["a"]},"second":{"answers":["b"]}},"questions":[]}),
        ] {
            assert!(answer_for_request(INPUT, &params, &answer).is_err());
        }
        let duplicate = json!({"questions":[{"id":"first"},{"id":"first"}]});
        assert!(answer_for_request(
            INPUT,
            &duplicate,
            &json!({"answers":{"first":{"answers":["a"]}}})
        )
        .is_err());
    }

    #[test]
    fn user_input_preserves_original_text_including_spaces_and_unicode() {
        let params = json!({"questions":[{"id":"secret","isSecret":true},{"id":"note"}]});
        let answer = json!({"answers":{
            "secret":{"answers":["  synthetic-only  "]},
            "note":{"answers":[" 保留中文与空格\n第二行 ","第二项"]}
        }});
        assert_eq!(answer_for_request(INPUT, &params, &answer).unwrap(), answer);
    }

    #[test]
    fn user_input_enforces_character_and_complete_wire_byte_limits() {
        let params = json!({"questions":[{"id":"q"}]});
        let answer = |texts: Vec<String>| json!({"answers":{"q":{"answers":texts}}});
        assert!(
            answer_for_request(INPUT, &params, &answer(vec!["中".repeat(MAX_ANSWER_CHARS)]))
                .is_ok()
        );
        assert!(answer_for_request(
            INPUT,
            &params,
            &answer(vec!["中".repeat(MAX_ANSWER_CHARS + 1)])
        )
        .is_err());
        assert!(answer_for_request(
            INPUT,
            &params,
            &answer(vec!["x".repeat(MAX_ANSWER_CHARS); 7])
        )
        .is_ok());
        assert!(answer_for_request(
            INPUT,
            &params,
            &answer(vec!["x".repeat(MAX_ANSWER_CHARS); 8])
        )
        .is_err());
    }

    #[test]
    fn permission_requests_only_normalize_to_turn_scoped_empty_permissions() {
        let denial = json!({"permissions":{},"scope":"turn"});
        for answer in [
            denial.clone(),
            json!({"decision":"decline"}),
            json!({"decision":"cancel"}),
        ] {
            assert_eq!(
                answer_for_request(PERMISSIONS, &json!({}), &answer).unwrap(),
                denial
            );
        }
        for answer in [
            json!({"decision":"accept"}),
            json!({"decision":"acceptForSession"}),
            json!({"permissions":{},"scope":"session"}),
            json!({"permissions":{"network":true},"scope":"turn"}),
            json!({"permissions":{"filesystem":{"read":[]}},"scope":"turn"}),
            json!({"permissions":{},"scope":"turn","grant":true}),
            json!({"decision":"decline","permissions":{}}),
        ] {
            assert!(answer_for_request(PERMISSIONS, &json!({}), &answer).is_err());
        }
        assert!(answer_for_request(
            PERMISSIONS,
            &json!({"availableDecisions":["accept"]}),
            &denial
        )
        .is_err());
    }
}
