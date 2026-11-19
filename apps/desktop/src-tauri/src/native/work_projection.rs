//! User-facing projection of native facts. No execution or completion authority.
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::butler_db::DispatchActionRecord;

const MESSAGE_LIMIT: usize = 200;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeWorkMessage {
    pub id: String,
    pub role: String,
    pub text: String,
    pub turn_id: Option<String>,
    pub streaming: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeWorkDecision {
    pub id: String,
    pub native_request_id: Value,
    pub method: String,
    pub native_thread_id: String,
    pub native_turn_id: String,
    pub requirements_version: i64,
    pub binding_version: i64,
    pub state: String,
    pub params: Value,
    pub created_at: i64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeWorkCapabilities {
    pub resume: bool,
    pub prompt: bool,
    pub steer: bool,
    pub interrupt: bool,
    pub answer: bool,
    pub external_live_attach: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeWorkAdmissionWait {
    pub reason: String,
    pub message: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeWorkSnapshot {
    pub protocol_version: u32,
    pub todo_id: String,
    pub session_id: String,
    pub native_thread_id: String,
    pub source_scope: String,
    pub execution_profile_id: String,
    pub binding_version: i64,
    pub connection_id: Option<String>,
    pub connection_status: String,
    pub runtime_status: String,
    pub active_turn_id: Option<String>,
    pub(crate) capabilities: NativeWorkCapabilities,
    pub(crate) messages: Vec<NativeWorkMessage>,
    pub history_truncated: bool,
    pub commands: Vec<DispatchActionRecord>,
    pub(crate) decisions: Vec<NativeWorkDecision>,
    pub cursor: i64,
    pub last_event_at: Option<i64>,
    pub error: Option<String>,
    pub runtime_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub admission_wait: Option<NativeWorkAdmissionWait>,
}

impl NativeWorkSnapshot {
    pub(crate) fn refresh_decision_status(&mut self) {
        if self.connection_status != "connected" {
            return;
        }
        let Some(turn) = &self.active_turn_id else {
            return;
        };
        let pending = self
            .decisions
            .iter()
            .filter(|decision| decision.native_turn_id == *turn && decision.state == "pending");
        let mut approval = false;
        for decision in pending {
            if decision.method == "item/tool/requestUserInput" {
                self.runtime_status = "waiting_input".into();
                return;
            }
            approval = true;
        }
        self.runtime_status = if approval {
            "waiting_approval"
        } else {
            "running"
        }
        .into();
    }

    pub(crate) fn disconnected(&mut self, reason: &str) {
        self.connection_status = "unknown".into();
        self.runtime_status = "unknown".into();
        self.admission_wait = None;
        self.error = Some(reason.chars().take(500).collect());
        self.capabilities = NativeWorkCapabilities {
            resume: true,
            ..Default::default()
        };
        for decision in &mut self.decisions {
            if decision.state == "pending" {
                decision.state = "expired".into();
            }
        }
        for message in &mut self.messages {
            message.streaming = false;
        }
    }

    pub(crate) fn load_thread(&mut self, thread: &Value) -> Result<(), String> {
        if thread.get("id").and_then(Value::as_str) != Some(&self.native_thread_id) {
            return Err("原端返回了其他会话，已拒绝替代恢复".into());
        }
        self.messages.clear();
        self.history_truncated = false;
        self.active_turn_id = None;
        for turn in thread
            .get("turns")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let turn_id = turn.get("id").and_then(Value::as_str);
            let running = turn.get("status").and_then(Value::as_str) == Some("inProgress")
                && thread.pointer("/status/type").and_then(Value::as_str) == Some("active");
            if running {
                self.active_turn_id = turn_id.map(str::to_string);
            }
            for item in turn
                .get("items")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                self.upsert_item(item, turn_id, running);
            }
        }
        self.runtime_status = if self.active_turn_id.is_some() {
            "running"
        } else {
            "idle"
        }
        .into();
        Ok(())
    }

    pub(crate) fn apply_notification(&mut self, method: &str, params: &Value) -> bool {
        if params.get("threadId").and_then(Value::as_str) != Some(&self.native_thread_id) {
            return false;
        }
        let turn_id = params
            .get("turnId")
            .and_then(Value::as_str)
            .or_else(|| params.pointer("/turn/id").and_then(Value::as_str));
        match method {
            "turn/started" => {
                let Some(turn) = turn_id else {
                    return false;
                };
                self.active_turn_id = Some(turn.into());
                self.runtime_status = "running".into();
                self.error = None;
                if let Some(items) = params.pointer("/turn/items").and_then(Value::as_array) {
                    for item in items {
                        self.upsert_item(item, Some(turn), true);
                    }
                }
            }
            "item/started" | "item/completed" => {
                let Some(item) = params.get("item") else {
                    return false;
                };
                self.upsert_item(item, turn_id, method == "item/started");
            }
            "item/agentMessage/delta" => {
                let (Some(id), Some(delta), Some(turn)) = (
                    params.get("itemId").and_then(Value::as_str),
                    params.get("delta").and_then(Value::as_str),
                    turn_id,
                ) else {
                    return false;
                };
                if let Some(message) = self
                    .messages
                    .iter_mut()
                    .find(|message| message.id == id && message.turn_id.as_deref() == Some(turn))
                {
                    if !message.streaming {
                        return false;
                    }
                    message.text.push_str(delta);
                } else {
                    self.messages.push(NativeWorkMessage {
                        id: id.into(),
                        role: "assistant".into(),
                        text: delta.into(),
                        turn_id: Some(turn.into()),
                        streaming: self.active_turn_id.as_deref() == Some(turn),
                    });
                }
            }
            "turn/completed" => {
                let Some(turn) = turn_id else {
                    return false;
                };
                if let Some(items) = params.pointer("/turn/items").and_then(Value::as_array) {
                    for item in items {
                        self.upsert_item(item, Some(turn), false);
                    }
                }
                for message in &mut self.messages {
                    if message.turn_id.as_deref() == Some(turn) {
                        message.streaming = false;
                    }
                }
                for decision in &mut self.decisions {
                    if decision.native_turn_id == turn && decision.state == "pending" {
                        decision.state = "expired".into();
                    }
                }
                if self.active_turn_id.as_deref() == Some(turn) {
                    self.active_turn_id = None;
                    self.runtime_status =
                        match params.pointer("/turn/status").and_then(Value::as_str) {
                            Some("interrupted") => "interrupted",
                            Some("completed" | "failed") => "idle",
                            _ => "unknown",
                        }
                        .into();
                    self.error = params
                        .pointer("/turn/error/message")
                        .and_then(Value::as_str)
                        .map(|value| value.chars().take(500).collect());
                }
            }
            _ => return false,
        }
        self.bound_messages();
        true
    }

    fn upsert_item(&mut self, item: &Value, turn_id: Option<&str>, streaming: bool) {
        let Some(id) = item.get("id").and_then(Value::as_str) else {
            return;
        };
        let (role, text) = match item.get("type").and_then(Value::as_str) {
            Some("agentMessage") => (
                "assistant",
                item.get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            ),
            Some("userMessage") => (
                "user",
                item.get("content")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|part| part.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("\n"),
            ),
            _ => return,
        };
        let message = NativeWorkMessage {
            id: id.into(),
            role: role.into(),
            text,
            turn_id: turn_id.map(str::to_string),
            streaming: role == "assistant" && streaming,
        };
        if let Some(existing) = self
            .messages
            .iter_mut()
            .find(|entry| entry.id == id && entry.turn_id == message.turn_id)
        {
            *existing = message;
        } else {
            self.messages.push(message);
        }
        self.bound_messages();
    }

    fn bound_messages(&mut self) {
        if self.messages.len() > MESSAGE_LIMIT {
            self.messages.drain(..self.messages.len() - MESSAGE_LIMIT);
            self.history_truncated = true;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn snapshot() -> NativeWorkSnapshot {
        NativeWorkSnapshot {
            protocol_version: 1,
            todo_id: "synthetic-work".into(),
            session_id: "synthetic-binding".into(),
            native_thread_id: "original-thread".into(),
            source_scope: "synthetic-source".into(),
            execution_profile_id: "synthetic-profile".into(),
            binding_version: 3,
            connection_id: Some("synthetic-connection".into()),
            connection_status: "connected".into(),
            runtime_status: "idle".into(),
            active_turn_id: None,
            capabilities: NativeWorkCapabilities {
                resume: false,
                prompt: true,
                steer: true,
                interrupt: true,
                answer: true,
                external_live_attach: false,
            },
            messages: Vec::new(),
            history_truncated: false,
            commands: Vec::new(),
            decisions: Vec::new(),
            cursor: 41,
            last_event_at: Some(100),
            error: None,
            runtime_version: Some("synthetic-runtime".into()),
            admission_wait: None,
        }
    }

    fn decision(id: &str, turn: &str, state: &str) -> NativeWorkDecision {
        NativeWorkDecision {
            id: id.into(),
            native_request_id: json!(id),
            method: "item/commandExecution/requestApproval".into(),
            native_thread_id: "original-thread".into(),
            native_turn_id: turn.into(),
            requirements_version: 2,
            binding_version: 3,
            state: state.into(),
            params: json!({"command":"synthetic"}),
            created_at: 10,
        }
    }

    #[test]
    fn answer_completion_preserves_a_newer_pending_decision_on_the_same_turn() {
        let mut view = snapshot();
        view.active_turn_id = Some("current-turn".into());
        view.runtime_status = "waiting_approval".into();
        view.decisions
            .push(decision("answered-first", "current-turn", "answered"));
        view.decisions.push(decision(
            "arrived-before-first-return",
            "current-turn",
            "pending",
        ));
        view.refresh_decision_status();
        assert_eq!(view.runtime_status, "waiting_approval");
        view.decisions[1].method = "item/tool/requestUserInput".into();
        view.refresh_decision_status();
        assert_eq!(view.runtime_status, "waiting_input");
        view.decisions[1].state = "answered".into();
        view.refresh_decision_status();
        assert_eq!(view.runtime_status, "running");
        view.active_turn_id = None;
        view.runtime_status = "idle".into();
        view.refresh_decision_status();
        assert_eq!(view.runtime_status, "idle");
    }

    #[test]
    fn late_answer_completion_cannot_revive_a_disconnected_turn() {
        let mut view = snapshot();
        view.active_turn_id = Some("current-turn".into());
        view.decisions
            .push(decision("writing-answer", "current-turn", "unknown"));
        view.disconnected("connection ended before answer continuation");
        view.decisions[0].state = "answered".into();
        view.refresh_decision_status();
        assert_eq!(view.connection_status, "unknown");
        assert_eq!(view.runtime_status, "unknown");
        assert!(!view.capabilities.prompt);
    }

    fn command() -> DispatchActionRecord {
        DispatchActionRecord {
            id: "synthetic-action".into(),
            idempotency_key: "native-codex:v1:synthetic-request".into(),
            todo_id: "synthetic-work".into(),
            event_id: None,
            session_id: Some("synthetic-binding".into()),
            action_kind: "session_prompt".into(),
            spec_json: "{}".into(),
            baseline_marker: None,
            state: "acknowledged".into(),
            receipt_ref: Some("synthetic-original-receipt".into()),
            error_message: None,
            created_at: 1,
            updated_at: 2,
        }
    }

    fn agent_item(id: &str, text: &str) -> Value {
        json!({"id":id,"type":"agentMessage","text":text})
    }

    fn started(turn: &str) -> Value {
        json!({"threadId":"original-thread","turn":{"id":turn,"status":"inProgress","items":[]}})
    }

    #[test]
    fn native_work_projection_wrong_thread_resume_cannot_replace_existing_facts() {
        let mut view = snapshot();
        view.load_thread(&json!({"id":"original-thread","turns":[{
            "id":"original-turn","status":"completed","items":[agent_item("original-message","原端正文")]
        }]})).unwrap();
        view.commands.push(command());
        let before = serde_json::to_value(&view).unwrap();
        assert!(view
            .load_thread(&json!({"id":"replacement-thread","turns":[{
                "id":"replacement-turn","items":[agent_item("replacement-message","不能替代")]
            }]}))
            .unwrap_err()
            .contains("替代"));
        assert_eq!(serde_json::to_value(&view).unwrap(), before);
        assert!(!view.apply_notification(
            "turn/started",
            &json!({"threadId":"replacement-thread","turn":{"id":"replacement-turn"}})
        ));
        assert_eq!(serde_json::to_value(&view).unwrap(), before);
    }

    #[test]
    fn native_work_projection_history_comes_only_from_native_message_items() {
        let mut view = snapshot();
        view.messages.push(NativeWorkMessage {
            id: "old-cache".into(),
            role: "assistant".into(),
            text: "旧缓存不能代替历史".into(),
            turn_id: None,
            streaming: false,
        });
        view.load_thread(&json!({"id":"original-thread","summary":"不能当成回复", "preview":"不能当成消息", "status":{"type":"idle"}, "turns":[{
            "id":"native-turn","status":"completed","summary":"不能当成历史正文","items":[
                {"id":"native-user","type":"userMessage","content":[{"type":"text","text":"用户第一行"},{"type":"text","text":"用户第二行"}]},
                agent_item("native-assistant","原端回复"),
                {"id":"native-tool","type":"commandExecution","text":"工具输出不能伪装成助手回复"}
            ]
        }]})).unwrap();
        assert_eq!(view.messages.len(), 2);
        assert_eq!(
            (
                &*view.messages[0].id,
                &*view.messages[0].role,
                &*view.messages[0].text
            ),
            ("native-user", "user", "用户第一行\n用户第二行")
        );
        assert_eq!(
            (
                &*view.messages[1].id,
                &*view.messages[1].role,
                &*view.messages[1].text
            ),
            ("native-assistant", "assistant", "原端回复")
        );
        assert!(
            view.messages
                .iter()
                .all(|message| message.turn_id.as_deref() == Some("native-turn")
                    && !message.streaming)
        );
    }

    #[test]
    fn native_work_projection_late_old_turn_terminal_preserves_new_active_turn() {
        let mut view = snapshot();
        assert!(view.apply_notification("turn/started", &started("old-turn")));
        assert!(view.apply_notification("turn/started", &started("new-turn")));
        view.error = Some("new-turn-context".into());
        view.decisions = vec![
            decision("old-decision", "old-turn", "pending"),
            decision("new-decision", "new-turn", "pending"),
        ];
        assert!(view.apply_notification("turn/completed", &json!({"threadId":"original-thread","turn":{
            "id":"old-turn","status":"interrupted","error":{"message":"旧错误"},"items":[agent_item("old-message","旧结果")]
        }})));
        assert_eq!(view.active_turn_id.as_deref(), Some("new-turn"));
        assert_eq!(view.runtime_status, "running");
        assert_eq!(view.error.as_deref(), Some("new-turn-context"));
        assert_eq!(view.decisions[0].state, "expired");
        assert_eq!(view.decisions[1].state, "pending");
        assert_eq!(view.messages[0].text, "旧结果");
        assert!(!view.messages[0].streaming);
    }

    #[test]
    fn native_work_projection_duplicate_completed_items_are_scoped_to_turn_and_not_duplicated() {
        let mut view = snapshot();
        let completed = json!({"threadId":"original-thread","turnId":"turn-1","item":agent_item("reused-item-id","完成正文")});
        assert!(view.apply_notification("item/completed", &completed));
        assert!(view.apply_notification("item/completed", &completed));
        let terminal = json!({"threadId":"original-thread","turn":{"id":"turn-1","status":"completed","items":[agent_item("reused-item-id","完成正文")]}});
        assert!(view.apply_notification("turn/completed", &terminal));
        assert!(view.apply_notification("turn/completed", &terminal));
        assert_eq!(view.messages.len(), 1);
        assert_eq!(view.messages[0].text, "完成正文");
        assert!(view.apply_notification("item/completed", &json!({"threadId":"original-thread","turnId":"turn-2","item":agent_item("reused-item-id","另一轮正文")})));
        assert_eq!(view.messages.len(), 2);
        assert_eq!(view.messages[0].turn_id.as_deref(), Some("turn-1"));
        assert_eq!(view.messages[1].turn_id.as_deref(), Some("turn-2"));
    }

    #[test]
    fn native_work_projection_final_text_replaces_streamed_deltas_without_double_counting() {
        let mut view = snapshot();
        view.apply_notification("turn/started", &started("turn-1"));
        view.apply_notification("item/started", &json!({"threadId":"original-thread","turnId":"turn-1","item":agent_item("message","")}));
        for delta in ["  原端", "回复 😀\n"] {
            assert!(view.apply_notification("item/agentMessage/delta", &json!({"threadId":"original-thread","turnId":"turn-1","itemId":"message","delta":delta})));
        }
        assert_eq!(view.messages.len(), 1);
        assert_eq!(view.messages[0].text, "  原端回复 😀\n");
        assert!(view.messages[0].streaming);
        assert!(view.apply_notification("item/completed", &json!({"threadId":"original-thread","turnId":"turn-1","item":agent_item("message","  原端回复 😀\n（最终）")})));
        assert_eq!(view.messages.len(), 1);
        assert_eq!(view.messages[0].text, "  原端回复 😀\n（最终）");
        assert!(!view.messages[0].streaming);
    }

    #[test]
    fn native_work_projection_late_delta_cannot_append_to_final_native_text() {
        let mut view = snapshot();
        view.apply_notification("turn/started", &started("turn-1"));
        view.apply_notification("item/agentMessage/delta", &json!({"threadId":"original-thread","turnId":"turn-1","itemId":"message","delta":"原端正文"}));
        view.apply_notification("item/completed", &json!({"threadId":"original-thread","turnId":"turn-1","item":agent_item("message","原端最终正文")}));
        let final_item = serde_json::to_value(&view).unwrap();
        let late_delta = json!({"threadId":"original-thread","turnId":"turn-1","itemId":"message","delta":"迟到或重放片段"});
        assert!(!view.apply_notification("item/agentMessage/delta", &late_delta));
        assert_eq!(serde_json::to_value(&view).unwrap(), final_item);
        view.apply_notification("turn/completed", &json!({"threadId":"original-thread","turn":{"id":"turn-1","status":"completed","items":[agent_item("message","原端最终正文")]}}));
        let final_turn = serde_json::to_value(&view).unwrap();
        assert!(!view.apply_notification("item/agentMessage/delta", &late_delta));
        assert_eq!(serde_json::to_value(&view).unwrap(), final_turn);
    }

    #[test]
    fn native_work_projection_bounds_native_history_and_live_messages_with_truncation_marker() {
        let mut view = snapshot();
        let items: Vec<Value> = (0..=MESSAGE_LIMIT)
            .map(|index| agent_item(&format!("item-{index}"), &format!("正文 {index}")))
            .collect();
        view.load_thread(&json!({"id":"original-thread","turns":[{"id":"history-turn","status":"completed","items":items}]})).unwrap();
        assert_eq!(view.messages.len(), 200);
        assert!(view.history_truncated);
        assert_eq!(view.messages.first().unwrap().id, "item-1");
        assert_eq!(view.messages.last().unwrap().id, "item-200");
        view.load_thread(&json!({"id":"original-thread","turns":[]}))
            .unwrap();
        assert!(!view.history_truncated);
        for index in 0..=MESSAGE_LIMIT {
            assert!(view.apply_notification("item/completed", &json!({"threadId":"original-thread","turnId":"live-turn","item":agent_item(&format!("live-{index}"), "原端消息")})));
        }
        assert_eq!(view.messages.len(), 200);
        assert!(view.history_truncated);
        assert_eq!(view.messages.first().unwrap().id, "live-1");
        assert_eq!(view.messages.last().unwrap().id, "live-200");
    }

    #[test]
    fn native_work_projection_disconnect_keeps_facts_but_expires_decisions_and_disables_writes() {
        let mut view = snapshot();
        view.apply_notification("turn/started", &started("turn-1"));
        view.apply_notification("item/agentMessage/delta", &json!({"threadId":"original-thread","turnId":"turn-1","itemId":"message","delta":"断线前的原端正文"}));
        view.commands.push(command());
        view.decisions = vec![
            decision("pending", "turn-1", "pending"),
            decision("answered", "turn-1", "answered"),
        ];
        let original_commands = serde_json::to_value(&view.commands).unwrap();
        let original_turn = view.active_turn_id.clone();
        view.disconnected(&"断".repeat(600));
        assert_eq!(view.native_thread_id, "original-thread");
        assert_eq!(view.active_turn_id, original_turn);
        assert_eq!(view.messages[0].text, "断线前的原端正文");
        assert!(!view.messages[0].streaming);
        assert_eq!(
            serde_json::to_value(&view.commands).unwrap(),
            original_commands
        );
        assert_eq!(view.decisions[0].state, "expired");
        assert_eq!(view.decisions[1].state, "answered");
        assert_eq!(view.cursor, 41);
        assert_eq!(view.last_event_at, Some(100));
        assert_eq!(view.connection_status, "unknown");
        assert_eq!(view.runtime_status, "unknown");
        assert_eq!(view.error.as_ref().unwrap().chars().count(), 500);
        assert_eq!(
            serde_json::to_value(&view.capabilities).unwrap(),
            json!({
                "resume":true,"prompt":false,"steer":false,"interrupt":false,"answer":false,"externalLiveAttach":false
            })
        );
    }
}
