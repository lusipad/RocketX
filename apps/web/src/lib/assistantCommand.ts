export type AssistantCommand =
  | { type: 'search'; query: string }
  | { type: 'list_todos'; query?: string }
  | { type: 'list_calendar'; query?: string }
  | { type: 'list_work_items'; query?: string }
  | { type: 'list_pull_requests'; query?: string }
  | { type: 'list_builds'; query?: string; failedOnly: boolean }
  | { type: 'create_work_item'; title: string; description?: string; workItemType?: string }
  | { type: 'help' };

function queryAfterVerb(text: string): string {
  return text
    .replace(/^(?:请|帮我|麻烦)?\s*(?:搜索|查找|查询|查看|找一下)\s*/u, '')
    .replace(/^(?:一下|最近|全部)\s*/u, '')
    .trim();
}

/** 明确指令优先本地解析，不启动 Codex，也不执行任何写操作。 */
export function fallbackAssistantCommand(text: string): AssistantCommand {
  const content = text.trim();
  const workItem = /(?:创建|新建).{0,8}工作项/u.exec(content);
  if (workItem) {
    const title = content
      .slice((workItem.index ?? 0) + workItem[0].length)
      .replace(/^[：:\s-]+/u, '')
      .trim();
    return title
      ? { type: 'create_work_item', title }
      : { type: 'help' };
  }
  if (/构建/u.test(content)) {
    return { type: 'list_builds', failedOnly: /失败|failed/iu.test(content) };
  }
  if (/\b(?:pr|pull request)\b|拉取请求|合并请求/iu.test(content)) {
    return { type: 'list_pull_requests', query: queryAfterVerb(content) || undefined };
  }
  if (/工作项/u.test(content)) {
    return { type: 'list_work_items', query: queryAfterVerb(content) || undefined };
  }
  if (/待办/u.test(content)) {
    return { type: 'list_todos', query: queryAfterVerb(content) || undefined };
  }
  if (/日历|日程/u.test(content)) {
    return { type: 'list_calendar', query: queryAfterVerb(content) || undefined };
  }
  return { type: 'search', query: queryAfterVerb(content) || content };
}

export function isAssistantWorkCommand(text: string): boolean {
  return /搜索|查找|查询|查看|待办|日历|日程|工作项|构建|\b(?:pr|pull request)\b|拉取请求|合并请求/iu.test(
    text,
  );
}
