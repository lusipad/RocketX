const TOOL_LABELS: Record<string, string> = {
  search_messages: '搜索消息',
  list_mentions: '查询 @我',
  search_people_rooms: '查询联系人和会话',
  list_todos: '查询待办',
  list_calendar: '查询日程',
  list_work_items: '查询工作项',
  list_pull_requests: '查询拉取请求',
  run_azure_devops_server_cli: '运行 Azure DevOps 只读 CLI',
  list_builds: '查询构建',
  recall_memory: '召回记忆',
  load_skill: '加载技能',
  remember: '记录记忆',
  revoke_memory: '撤销记忆',
  restore_memory: '恢复记忆',
  import_legacy_memory: '导入旧记忆',
  draft_routine: '生成例行事务草案',
};

/**
 * 允许显示在界面上的参数字段白名单。
 *
 * 这些字符串会常驻在过程区，脱敏是硬要求：白名单之外一律不显示。
 * `run_azure_devops_server_cli` 只显示 resource，绝不显示完整参数
 * （query 里可能有内网路径、集合地址、凭据相关字段）。
 */
const DETAIL_FIELDS: Record<string, readonly string[]> = {
  search_messages: ['query'],
  list_work_items: ['state', 'project'],
  list_pull_requests: ['project', 'repo'],
  list_builds: ['definition'],
  run_azure_devops_server_cli: ['resource'],
};

const DETAIL_LIMIT = 20;

export function butlerToolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name;
}

function parseArguments(argumentsJson: string | undefined): Record<string, unknown> | undefined {
  if (!argumentsJson) return undefined;
  try {
    const parsed: unknown = JSON.parse(argumentsJson);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 过程区一行的人话标签。
 *
 * 没有白名单内的参数时**原样返回** `butlerToolLabel(name)` —— 既有回归逐字断言
 * 「搜索消息」这类纯标签，参数摘要只是可选后缀。
 */
export function butlerStepLabel(name: string, argumentsJson?: string): string {
  const label = butlerToolLabel(name);
  const fields = DETAIL_FIELDS[name];
  if (!fields) return label;
  const args = parseArguments(argumentsJson);
  if (!args) return label;
  const parts: string[] = [];
  for (const field of fields) {
    const value = args[field];
    if (typeof value !== 'string' || !value.trim()) continue;
    const trimmed = value.trim();
    parts.push(trimmed.length > DETAIL_LIMIT ? `${trimmed.slice(0, DETAIL_LIMIT)}…` : trimmed);
  }
  return parts.length ? `${label}（${parts.join(' · ')}）` : label;
}
