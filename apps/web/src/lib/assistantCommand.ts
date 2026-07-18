export type AssistantCommand =
  | { type: 'search'; query: string }
  | { type: 'list_todos'; query?: string }
  | { type: 'list_calendar'; query?: string }
  | { type: 'list_work_items'; query?: string }
  | { type: 'list_pull_requests'; query?: string }
  | { type: 'list_builds'; query?: string; failedOnly: boolean }
  | { type: 'create_work_item'; title: string; description?: string; workItemType?: string }
  | { type: 'help' };

/** 祈使句开头（可带 请/帮我/麻烦 前缀）才算明确指令 */
const COMMAND_VERB = /^(?:请|麻烦|帮我)?\s*(?:搜索|查找|查询|查看|找一下|列出|列一下)/u;
const CREATE_WORK_ITEM = /^(?:请|麻烦|帮我)?\s*(?:创建|新建).{0,8}工作项/u;
/** 只敲了类型名（「PR」「我的待办」「失败的构建」）也算明确指令 */
const BARE_TYPE =
  /^(?:我的|全部|所有)?\s*(?:失败的?\s*)?(?:prs?|pull\s*requests?|拉取请求|合并请求|工作项|待办(?:事项)?|日程|日历|构建)\s*(?:列表|清单)?$/iu;
/** 疑问、闲聊语气：交给 AI 理解，不做正则拆解（issue #89） */
const CONVERSATIONAL =
  /[?？]|哪些|什么|多少|怎么|怎样|如何|为什么|为啥|有没有|是不是|能不能|可不可以|需要我|要我|还有|吗/u;

function queryAfterVerb(text: string): string {
  return text
    .replace(/^(?:请|帮我|麻烦)?\s*(?:搜索|查找|查询|查看|找一下|列出|列一下)\s*/u, '')
    .replace(/^(?:一下|最近|全部)\s*/u, '')
    .trim();
}

/** 列表查询的口水词：类型名和这些词都不是筛选关键词 */
const LIST_FILLER = /我的|全部|所有|最近|当前|现在|一下|列表|清单|情况|记录|还有|剩余|剩下/gu;

/** 去掉类型名和口水词，剩下的才用来过滤；全是口水词就不过滤（issue #89） */
function listQuery(content: string, ...patterns: RegExp[]): string | undefined {
  let query = queryAfterVerb(content);
  for (const pattern of patterns) query = query.replace(pattern, ' ');
  query = query.replace(LIST_FILLER, ' ');
  const words = query.split(/[\s：:，,。.！!？?]+/u).filter((word) => word && word !== '的');
  return words.join(' ') || undefined;
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
  if (/\b(?:prs?|pull\s*requests?)\b|拉取请求|合并请求/iu.test(content)) {
    return {
      type: 'list_pull_requests',
      query: listQuery(
        content,
        /\b(?:prs?|pull\s*requests?)\b|拉取请求|合并请求/giu,
        /待我(?:评审|审查|处理)|我提的|待评审|待处理/gu,
      ),
    };
  }
  if (/工作项/u.test(content)) {
    return { type: 'list_work_items', query: listQuery(content, /工作项/gu) };
  }
  if (/待办/u.test(content)) {
    return { type: 'list_todos', query: listQuery(content, /待办(?:事项)?/gu, /未完成|没完成|未办/gu) };
  }
  if (/日历|日程/u.test(content)) {
    return { type: 'list_calendar', query: listQuery(content, /日历|日程/gu) };
  }
  return { type: 'search', query: queryAfterVerb(content) || content };
}

/**
 * 只有明确的祈使指令走本地快速路径；「再帮我看看还有哪些需要我处理的PR」这类
 * 自然语言疑问句交给 AI 理解和回答，不做正则拆解（issue #89）。
 */
export function isAssistantWorkCommand(text: string): boolean {
  const content = text.trim();
  if (CONVERSATIONAL.test(content)) return false;
  return COMMAND_VERB.test(content) || CREATE_WORK_ITEM.test(content) || BARE_TYPE.test(content);
}
