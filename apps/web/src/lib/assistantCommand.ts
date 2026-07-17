import { getAiBus } from '../kernel/ai/runtime';
import { asRecord, collectStructuredObject, optionalString, requiredString } from '../kernel/ai/features/structured-output';

export type AssistantCommand =
  | { type: 'search'; query: string }
  | { type: 'list_todos'; query?: string }
  | { type: 'list_calendar'; query?: string }
  | { type: 'list_work_items'; query?: string }
  | { type: 'list_pull_requests'; query?: string }
  | { type: 'list_builds'; query?: string; failedOnly: boolean }
  | { type: 'create_work_item'; title: string; description?: string; workItemType?: string }
  | { type: 'help' };

export function parseAssistantCommand(value: unknown): AssistantCommand {
  const result = asRecord(value, 'AI 助手指令');
  const type = requiredString(result.type, '指令类型');
  if (type === 'search') return { type, query: requiredString(result.query, '搜索关键词') };
  if (type === 'create_work_item') {
    return {
      type,
      title: requiredString(result.title, '工作项标题'),
      description: optionalString(result.description, '工作项描述'),
      workItemType: optionalString(result.workItemType, '工作项类型'),
    };
  }
  if (type === 'list_builds') {
    return {
      type,
      query: optionalString(result.query, '查询条件'),
      failedOnly: result.failedOnly === true,
    };
  }
  if (type === 'help') return { type };
  if (
    type === 'list_todos' ||
    type === 'list_calendar' ||
    type === 'list_work_items' ||
    type === 'list_pull_requests'
  ) {
    return { type, query: optionalString(result.query, '查询条件') };
  }
  throw new Error(`AI 助手不支持指令：${type}`);
}

function queryAfterVerb(text: string): string {
  return text
    .replace(/^(?:请|帮我|麻烦)?\s*(?:搜索|查找|查询|查看|找一下)\s*/u, '')
    .replace(/^(?:一下|最近|全部)\s*/u, '')
    .trim();
}

/** Provider 不可用时只识别显式、安全的本地意图，不执行任何写操作。 */
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

export async function understandAssistantCommand(text: string): Promise<AssistantCommand> {
  const content = text.trim();
  if (!content) throw new Error('请输入要搜索或处理的内容');
  const result = await collectStructuredObject(getAiBus(), 'agent', {
    messages: [
      {
        role: 'system',
        content: `你是 RocketX 的意图路由器。只输出 JSON，不回答问题本身。
可用 type：search、list_todos、list_calendar、list_work_items、list_pull_requests、list_builds、create_work_item、help。
search 用于跨消息、会话、联系人、待办、日历和工作项搜索，输出 {"type":"search","query":"关键词"}。
创建 Azure DevOps 工作项输出 {"type":"create_work_item","title":"标题","description":"可选描述","workItemType":"可选类型"}。
查询列表可带 query；查询失败构建时给 list_builds 增加 "failedOnly":true。
无法判断时输出 {"type":"help"}。`,
      },
      { role: 'user', content },
    ],
    responseFormat: 'json',
    thinking: 'disabled',
    maxTokens: 400,
  });
  return parseAssistantCommand(result);
}
