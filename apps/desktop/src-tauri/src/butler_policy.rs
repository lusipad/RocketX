use serde::{Deserialize, Serialize};
use std::path::Path;

const POLICY_REL_PATH: &str = ".rocketx/policy.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPolicy {
    pub version: u32,
    pub allowed_commands: Vec<String>,
    pub denied_commands: Vec<String>,
    pub allowed_paths: Vec<String>,
    pub denied_paths: Vec<String>,
    pub require_approval_for_external: bool,
    pub max_autonomy_mode: String,
    pub allow_network_tools: bool,
}

impl Default for ProjectPolicy {
    fn default() -> Self {
        Self {
            version: 1,
            allowed_commands: Vec::new(),
            denied_commands: vec![
                "rm -rf /".to_string(),
                "git push --force".to_string(),
                "git reset --hard".to_string(),
            ],
            allowed_paths: Vec::new(),
            denied_paths: vec![".env".to_string(), "**/.ssh/**".to_string()],
            require_approval_for_external: true,
            max_autonomy_mode: "confirm".to_string(),
            allow_network_tools: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PolicyDecision {
    pub verdict: String,
    pub reason: String,
    pub matched_rule: Option<String>,
}

const DESTRUCTIVE_COMMANDS: &[&str] = &[
    "rm -rf /",
    "rm -rf /*",
    "mkfs",
    "dd if=",
    ":(){ :|:& };:",
    "shutdown",
    "reboot",
    "format c:",
];

fn normalize_string_list(items: Vec<String>) -> Vec<String> {
    let mut out = Vec::new();
    for raw in items {
        let trimmed = raw.trim();
        if !trimmed.is_empty() && !out.iter().any(|existing| existing == trimmed) {
            out.push(trimmed.to_string());
        }
    }
    out
}

pub(crate) fn validate_policy(mut policy: ProjectPolicy) -> Result<ProjectPolicy, String> {
    if policy.version == 0 {
        policy.version = 1;
    }
    let autonomy = policy.max_autonomy_mode.trim().to_ascii_lowercase();
    if !matches!(autonomy.as_str(), "readonly" | "confirm" | "autonomous") {
        return Err("maxAutonomyMode 仅支持 readonly / confirm / autonomous".to_string());
    }
    policy.max_autonomy_mode = autonomy;
    policy.allowed_commands = normalize_string_list(policy.allowed_commands);
    policy.denied_commands = normalize_string_list(policy.denied_commands);
    policy.allowed_paths = normalize_string_list(policy.allowed_paths);
    policy.denied_paths = normalize_string_list(policy.denied_paths);
    Ok(policy)
}

fn rule_matches(rule: &str, target: &str) -> bool {
    let clean_rule = rule.trim().trim_matches('*').to_ascii_lowercase();
    if clean_rule.is_empty() {
        return false;
    }
    let normalized_target = target.replace('\\', "/").to_ascii_lowercase();
    normalized_target == clean_rule
        || normalized_target.starts_with(&clean_rule)
        || normalized_target.contains(&clean_rule)
}

pub(crate) fn evaluate_policy_action(
    policy: &ProjectPolicy,
    workspace_root: Option<&str>,
    action_kind: &str,
    target: &str,
) -> PolicyDecision {
    let clean_kind = action_kind.trim().to_ascii_lowercase();
    let clean_target = target.trim();

    if clean_kind.is_empty() || clean_target.is_empty() {
        return PolicyDecision {
            verdict: "deny".to_string(),
            reason: "策略检查需要提供 actionKind 和 target".to_string(),
            matched_rule: Some("invalid_arguments".to_string()),
        };
    }

    if clean_kind == "command" {
        let lower_cmd = clean_target.to_ascii_lowercase();
        for pattern in DESTRUCTIVE_COMMANDS {
            if lower_cmd.contains(pattern) {
                return PolicyDecision {
                    verdict: "deny".to_string(),
                    reason: format!("高危系统命令被内建安全基线拦截：{pattern}"),
                    matched_rule: Some((*pattern).to_string()),
                };
            }
        }
        for rule in &policy.denied_commands {
            if rule_matches(rule, clean_target) {
                return PolicyDecision {
                    verdict: "deny".to_string(),
                    reason: format!("命中拒绝命令规则：{rule}"),
                    matched_rule: Some(rule.clone()),
                };
            }
        }
        if policy.max_autonomy_mode == "readonly" {
            return PolicyDecision {
                verdict: "deny".to_string(),
                reason: "当前项目策略为只读模式 (readonly)，禁止执行命令".to_string(),
                matched_rule: Some("maxAutonomyMode=readonly".to_string()),
            };
        }
        for rule in &policy.allowed_commands {
            if rule_matches(rule, clean_target) {
                return PolicyDecision {
                    verdict: "allow".to_string(),
                    reason: format!("命中允许命令白名单：{rule}"),
                    matched_rule: Some(rule.clone()),
                };
            }
        }
        return PolicyDecision {
            verdict: if policy.max_autonomy_mode == "autonomous" {
                "allow".to_string()
            } else {
                "confirm".to_string()
            },
            reason: "未显式匹配白名单，按自治级别决定".to_string(),
            matched_rule: None,
        };
    }

    if matches!(clean_kind.as_str(), "file_read" | "file_write") {
        let target_path = Path::new(clean_target);
        if target_path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
            || clean_target.contains('\0')
        {
            return PolicyDecision {
                verdict: "deny".to_string(),
                reason: "路径安全拦截：禁止使用 .. 或越界路径".to_string(),
                matched_rule: Some("path_traversal".to_string()),
            };
        }
        if let Some(root) = workspace_root.map(str::trim).filter(|r| !r.is_empty()) {
            if crate::acp::resolve_workspace_scoped_path(root, clean_target, false).is_err() {
                return PolicyDecision {
                    verdict: "deny".to_string(),
                    reason: "路径超出工作区边界".to_string(),
                    matched_rule: Some("workspace_boundary".to_string()),
                };
            }
        }
        for rule in &policy.denied_paths {
            if rule_matches(rule, clean_target) {
                return PolicyDecision {
                    verdict: "deny".to_string(),
                    reason: format!("命中受保护路径规则：{rule}"),
                    matched_rule: Some(rule.clone()),
                };
            }
        }
        if clean_kind == "file_write" && policy.max_autonomy_mode == "readonly" {
            return PolicyDecision {
                verdict: "deny".to_string(),
                reason: "当前项目策略为只读模式 (readonly)，禁止修改文件".to_string(),
                matched_rule: Some("maxAutonomyMode=readonly".to_string()),
            };
        }
        for rule in &policy.allowed_paths {
            if rule_matches(rule, clean_target) {
                return PolicyDecision {
                    verdict: "allow".to_string(),
                    reason: format!("命中允许路径规则：{rule}"),
                    matched_rule: Some(rule.clone()),
                };
            }
        }
        if clean_kind == "file_read" {
            return PolicyDecision {
                verdict: "allow".to_string(),
                reason: "工作区内只读访问允许".to_string(),
                matched_rule: None,
            };
        }
        return PolicyDecision {
            verdict: if policy.max_autonomy_mode == "autonomous" {
                "allow".to_string()
            } else {
                "confirm".to_string()
            },
            reason: "工作区文件写入需遵循当前自治级别".to_string(),
            matched_rule: None,
        };
    }

    if clean_kind == "network" {
        if !policy.allow_network_tools {
            return PolicyDecision {
                verdict: "deny".to_string(),
                reason: "当前项目策略已禁用联网检测工具".to_string(),
                matched_rule: Some("allowNetworkTools=false".to_string()),
            };
        }
        return PolicyDecision {
            verdict: "allow".to_string(),
            reason: "项目策略允许联网检测".to_string(),
            matched_rule: None,
        };
    }

    if clean_kind == "external" {
        return PolicyDecision {
            verdict: if policy.require_approval_for_external {
                "confirm".to_string()
            } else {
                "allow".to_string()
            },
            reason: "外部副作用操作受外部审批策略约束".to_string(),
            matched_rule: Some(format!(
                "requireApprovalForExternal={}",
                policy.require_approval_for_external
            )),
        };
    }

    PolicyDecision {
        verdict: "confirm".to_string(),
        reason: "未知动作类型，默认需要人工确认".to_string(),
        matched_rule: None,
    }
}

pub(crate) fn load_project_policy(workspace_root: &str) -> Result<ProjectPolicy, String> {
    let (_, policy_path) =
        crate::acp::resolve_workspace_scoped_path(workspace_root, POLICY_REL_PATH, false)?;
    if !policy_path.is_file() {
        return Ok(ProjectPolicy::default());
    }
    let raw = std::fs::read_to_string(&policy_path)
        .map_err(|error| format!("无法读取项目策略文件：{error}"))?;
    let parsed = serde_json::from_str::<ProjectPolicy>(&raw)
        .map_err(|error| format!("项目策略 JSON 解析失败：{error}"))?;
    validate_policy(parsed)
}

pub(crate) fn save_project_policy(
    workspace_root: &str,
    policy: ProjectPolicy,
) -> Result<ProjectPolicy, String> {
    let validated = validate_policy(policy)?;
    let (_, policy_path) =
        crate::acp::resolve_workspace_scoped_path(workspace_root, POLICY_REL_PATH, false)?;
    if let Some(parent) = policy_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("无法创建 .rocketx 目录：{error}"))?;
    }
    let json = serde_json::to_string_pretty(&validated)
        .map_err(|error| format!("无法序列化项目策略：{error}"))?;
    let tmp_path = policy_path.with_extension("json.tmp");
    std::fs::write(&tmp_path, format!("{json}\n"))
        .map_err(|error| format!("无法写入策略临时文件：{error}"))?;
    std::fs::rename(&tmp_path, &policy_path)
        .map_err(|error| format!("无法原子更新策略文件：{error}"))?;
    Ok(validated)
}

#[tauri::command]
pub fn butler_policy_get(workspace_root: String) -> Result<ProjectPolicy, String> {
    if workspace_root.trim().is_empty() {
        return Ok(ProjectPolicy::default());
    }
    load_project_policy(&workspace_root)
}

#[tauri::command]
pub fn butler_policy_save(
    workspace_root: String,
    policy: ProjectPolicy,
) -> Result<ProjectPolicy, String> {
    save_project_policy(&workspace_root, policy)
}

#[tauri::command]
pub fn butler_policy_evaluate(
    workspace_root: String,
    action_kind: String,
    target: String,
) -> Result<PolicyDecision, String> {
    let trimmed_root = workspace_root.trim();
    let policy = if trimmed_root.is_empty() {
        ProjectPolicy::default()
    } else {
        load_project_policy(trimmed_root)?
    };
    Ok(evaluate_policy_action(
        &policy,
        (!trimmed_root.is_empty()).then_some(trimmed_root),
        &action_kind,
        &target,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deny_rules_override_allow_and_traversal_is_blocked() {
        let mut policy = ProjectPolicy::default();
        policy.allowed_commands = vec!["git ".to_string(), "pnpm test".to_string()];
        policy.denied_commands = vec!["git push --force".to_string()];
        policy.max_autonomy_mode = "autonomous".to_string();

        // Deny must beat broad allow
        let forced =
            evaluate_policy_action(&policy, None, "command", "git push --force origin main");
        assert_eq!(forced.verdict, "deny");

        let allowed_test = evaluate_policy_action(&policy, None, "command", "pnpm test:pure");
        assert_eq!(allowed_test.verdict, "allow");

        // Hardcoded destructive baseline cannot be bypassed
        let wiped = evaluate_policy_action(&policy, None, "command", "sudo rm -rf /");
        assert_eq!(wiped.verdict, "deny");

        // Path traversal rejected
        let escaped = evaluate_policy_action(&policy, None, "file_write", "../../etc/passwd");
        assert_eq!(escaped.verdict, "deny");

        // .env denied by default rule
        let env_write = evaluate_policy_action(&policy, None, "file_write", "apps/web/.env");
        assert_eq!(env_write.verdict, "deny");
    }

    #[test]
    fn policy_save_load_and_readonly_autonomy_roundtrip() {
        let temp = std::env::temp_dir().join(format!("rcx-policy-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp).expect("create temp workspace");
        let root_str = temp.to_string_lossy().to_string();

        let default_loaded = load_project_policy(&root_str).expect("default policy");
        assert_eq!(default_loaded.max_autonomy_mode, "confirm");

        let saved = save_project_policy(
            &root_str,
            ProjectPolicy {
                version: 1,
                allowed_commands: vec!["cargo check".to_string()],
                denied_commands: vec![],
                allowed_paths: vec!["src/".to_string()],
                denied_paths: vec![".env".to_string()],
                require_approval_for_external: true,
                max_autonomy_mode: "readonly".to_string(),
                allow_network_tools: false,
            },
        )
        .expect("save policy");
        assert_eq!(saved.max_autonomy_mode, "readonly");
        assert!(!saved.allow_network_tools);

        let reloaded = load_project_policy(&root_str).expect("reload saved policy");
        assert_eq!(reloaded, saved);

        let write_decision =
            evaluate_policy_action(&reloaded, Some(&root_str), "file_write", "src/main.rs");
        assert_eq!(write_decision.verdict, "deny");

        let net_decision =
            evaluate_policy_action(&reloaded, Some(&root_str), "network", "https://example.com");
        assert_eq!(net_decision.verdict, "deny");

        let _ = std::fs::remove_dir_all(&temp);
    }
}
