import type { ButlerSource, ButlerSurfaceContext } from './butlerContext';

export type ButlerScenario =
  | 'find-file'
  | 'compare-pull-requests'
  | 'extract-commitments'
  | 'draft-overdue-work-item-followup'
  | 'associate-build-failure'
  | 'create-weekly-routine'
  | 'resume-task'
  | 'general';

export type ButlerTaskStatus =
  | 'awaiting-clarification'
  | 'ready'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed';

export interface ButlerManifestSource {
  tool: string;
  kind: ButlerSource['kind'] | 'session';
  freshness: 'query-time' | 'loaded-snapshot' | 'persisted';
}

export interface ButlerScenarioManifest {
  schemaVersion: 1;
  scenario: ButlerScenario;
  capabilityPreflight: {
    available: string[];
    missing: string[];
  };
  sourcePlan: ButlerManifestSource[];
  clarification: {
    required: boolean;
    missing: string[];
    question?: string;
  };
  prohibitedActions: string[];
  recovery: string;
}

export interface ButlerTaskState {
  id: string;
  goal: string;
  status: ButlerTaskStatus;
  createdAt: number;
  updatedAt: number;
  manifest: ButlerScenarioManifest;
  sources: ButlerSource[];
  error?: string;
}

interface ScenarioDefinition {
  id: ButlerScenario;
  matches: RegExp[];
  available: string[];
  missing: string[];
  sourcePlan: ButlerManifestSource[];
  prohibitedActions: string[];
  recovery: string;
  clarification?: (
    input: string,
    context?: ButlerSurfaceContext | null,
    previous?: ButlerTaskState | null,
  ) => {
    missing: string[];
    question?: string;
  };
}

function sourceCount(context: ButlerSurfaceContext | null | undefined, kind: ButlerSource['kind']): number {
  return context?.sources.filter((source) => source.kind === kind).length ?? 0;
}

function prIds(input: string): string[] {
  return [...input.matchAll(/(?:\bPR\s*#?|#)(\d+)\b/gi)].map((match) => match[1]);
}

const definitions: readonly ScenarioDefinition[] = [
  {
    id: 'find-file',
    matches: [/(?:找|查|搜索).*(?:文件|附件|文档|设计稿)/i, /(?:文件|附件).*(?:昨天|昨日|发送|上传)/i],
    available: ['可按发送人、日期、房间和附件条件查询消息'],
    missing: ['别名解析与文件内容检索尚不在本阶段范围'],
    sourcePlan: [{ tool: 'search_messages', kind: 'message', freshness: 'query-time' }],
    prohibitedActions: ['不发送消息', '不修改或下载文件'],
    recovery: '保留筛选条件与来源，可在同一 session 补充发送人或日期后重查。',
    clarification: (input) => {
      const hasDate = /(?:昨天|昨日|\d{4}-\d{2}-\d{2})/.test(input);
      const hasPerson = /(?:昨天|昨日)\s*[^，。,.\s]{2,12}?(?:发的|上传的)/.test(input)
        || /(?:发送人|来自)[:：]?\s*[^，。,.\s]{2,20}/.test(input);
      const missing = [!hasPerson && '发送人', !hasDate && '日期'].filter(Boolean) as string[];
      return { missing, question: missing.length ? `请补充${missing.join('和')}。` : undefined };
    },
  },
  {
    id: 'compare-pull-requests',
    matches: [/(?:比较|对比).*(?:PR|拉取请求)/i, /(?:PR|拉取请求).*(?:差异|区别)/i],
    available: ['可查询已加载的 PR 元数据并保留候选来源'],
    missing: ['PR diff 与代码内容读取能力不可用'],
    sourcePlan: [{ tool: 'list_pull_requests', kind: 'pull-request', freshness: 'loaded-snapshot' }],
    prohibitedActions: ['不评论、合并或修改 PR'],
    recovery: '保留候选 PR；补齐两个编号后可继续只读比较，能力不足时明确停止。',
    clarification: (input, context) => {
      const count = new Set([...prIds(input), ...(context?.sources.filter((source) => source.kind === 'pull-request').map((source) => source.id) ?? [])]).size;
      return count >= 2 ? { missing: [] } : { missing: ['两个 PR 编号'], question: '请给出要比较的两个 PR 编号。' };
    },
  },
  {
    id: 'extract-commitments',
    matches: [/(?:提取|整理|查找).*(?:承诺|答应|跟进项)/i, /(?:群聊|消息).*(?:承诺|负责人|截止)/i],
    available: ['可查询群聊原始消息并把证据挂到任务来源'],
    missing: ['自动写入待办或长期记忆不在本阶段范围'],
    sourcePlan: [{ tool: 'search_messages', kind: 'message', freshness: 'query-time' }],
    prohibitedActions: ['不静默创建待办、工作项或记忆'],
    recovery: '保留原始消息证据；补充群聊或时间范围后重新提取。',
    clarification: (input, context) => {
      const hasRoom = context?.kind === 'room' || /(?:在|从).{1,20}(?:群|房间)/.test(input);
      return hasRoom ? { missing: [] } : { missing: ['群聊范围'], question: '要从哪个群聊提取承诺？' };
    },
  },
  {
    id: 'draft-overdue-work-item-followup',
    matches: [/(?:逾期|过期).*(?:WI|工作项).*(?:跟进|催办|草稿)/i, /(?:跟进|催办).*(?:逾期|过期).*(?:WI|工作项)/i],
    available: ['可查询逾期工作项并生成只读跟进上下文'],
    missing: ['发送草稿与修改工作项需要后续审批运行时'],
    sourcePlan: [{ tool: 'list_work_items', kind: 'work-item', freshness: 'loaded-snapshot' }],
    prohibitedActions: ['不发送催办消息', '不创建或修改工作项'],
    recovery: '保留工作项来源与草稿目标；用户可补充对象和口径后重新生成。',
  },
  {
    id: 'associate-build-failure',
    matches: [/(?:构建|CI).*(?:失败|红灯).*(?:提交|变更|PR|关联)/i, /(?:关联|查找).*(?:构建|CI).*(?:提交|变更)/i],
    available: ['可查询失败构建元数据并保留构建来源'],
    missing: ['构建变更集与提交详情读取能力不可用'],
    sourcePlan: [{ tool: 'list_builds', kind: 'build', freshness: 'loaded-snapshot' }],
    prohibitedActions: ['不重试或回滚构建', '不修改代码'],
    recovery: '保留失败构建；补齐构建编号后重查，缺少变更能力时明确说明边界。',
    clarification: (input, context) => {
      const hasBuild = /(?:构建|build)\s*#?[\w.-]*\d[\w.-]*/i.test(input) || sourceCount(context, 'build') > 0;
      return hasBuild ? { missing: [] } : { missing: ['构建编号'], question: '请给出要关联的失败构建编号。' };
    },
  },
  {
    id: 'create-weekly-routine',
    matches: [/(?:创建|安排|新增).*(?:周报|例行|定时).*(?:任务|事务)?/i, /(?:每周|周报).*(?:定时|提醒|例行)/i],
    available: ['可加载 weekly-report 技能并生成待确认的 routine 草案'],
    missing: [],
    sourcePlan: [
      { tool: 'load_skill', kind: 'session', freshness: 'persisted' },
      { tool: 'draft_routine', kind: 'session', freshness: 'persisted' },
    ],
    prohibitedActions: ['不绕过确认直接启用例行任务'],
    recovery: '草案可取消并重新生成；确认后的 routine 走既有持久化。',
    clarification: (input) => {
      const missing = [!/(?:[01]?\d|2[0-3]):[0-5]\d/.test(input) && '执行时间', !/周[一二三四五六日天]/.test(input) && '星期'].filter(Boolean) as string[];
      return { missing, question: missing.length ? `请补充周报的${missing.join('和')}。` : undefined };
    },
  },
  {
    id: 'resume-task',
    matches: [/(?:继续|续跑|恢复).*(?:任务|调查|上次|昨天|会话)/i],
    available: ['可从当前 session 恢复 transcript 与最近任务态'],
    missing: [],
    sourcePlan: [{ tool: 'session-registry', kind: 'session', freshness: 'persisted' }],
    prohibitedActions: ['不跨账号、服务器或 session 猜测任务'],
    recovery: '任务态随 session 持久化；失败或暂停后可从记录的恢复状态继续。',
    clarification: (_input, _context, previous) => previous
      ? { missing: [] }
      : { missing: ['要恢复的任务'], question: '当前会话没有可恢复的任务，请说明要继续哪项调查。' },
  },
];

const generalDefinition: ScenarioDefinition = {
  id: 'general',
  matches: [],
  available: ['可使用当前工作面和只读工具查证'],
  missing: [],
  sourcePlan: [],
  prohibitedActions: ['不执行未经确认的写动作'],
  recovery: '保留当前 session transcript；可补充目标后重新编译任务上下文。',
};

function identify(input: string): ScenarioDefinition {
  return definitions.find((definition) => definition.matches.some((pattern) => pattern.test(input))) ?? generalDefinition;
}

function startsNewTask(input: string): boolean {
  return /^(?:新任务|另一个任务|开始新任务)(?:\s*[:：]\s*|\s+|$)/u.test(input.trim());
}

export function compileButlerTask(
  input: string,
  context: ButlerSurfaceContext | null | undefined,
  previous: ButlerTaskState | null | undefined,
  now = Date.now(),
): ButlerTaskState {
  const identified = identify(input);
  const continuing = !startsNewTask(input) && previous?.status === 'awaiting-clarification' &&
    (identified.id === 'general' || identified.id === previous.manifest.scenario);
  const definition = continuing
    ? definitions.find((candidate) => candidate.id === previous.manifest.scenario) ?? identified
    : identified;
  const goal = continuing ? `${previous.goal}\n补充：${input}` : input;
  const clarification = definition.clarification?.(goal, context, previous) ?? { missing: [] };
  const sources = context?.sources ?? [];
  return {
    id: continuing ? previous.id : crypto.randomUUID(),
    goal,
    status: clarification.missing.length ? 'awaiting-clarification' : 'ready',
    createdAt: continuing ? previous.createdAt : now,
    updatedAt: now,
    manifest: {
      schemaVersion: 1,
      scenario: definition.id,
      capabilityPreflight: {
        available: definition.available,
        missing: definition.missing,
      },
      sourcePlan: definition.sourcePlan,
      clarification: {
        required: clarification.missing.length > 0,
        missing: clarification.missing,
        ...(clarification.question ? { question: clarification.question } : {}),
      },
      prohibitedActions: definition.prohibitedActions,
      recovery: definition.recovery,
    },
    sources,
  };
}

export function updateButlerTask(
  task: ButlerTaskState,
  patch: Partial<Pick<ButlerTaskState, 'status' | 'sources' | 'error'>>,
  now = Date.now(),
): ButlerTaskState {
  const { error: _oldError, ...base } = task;
  return { ...base, ...patch, updatedAt: now, ...(patch.error ? { error: patch.error } : {}) };
}

export function butlerTaskPrompt(task: ButlerTaskState): string {
  return [
    '当前任务合同（由代码侧编译，不得绕过）：',
    JSON.stringify({
      id: task.id,
      goal: task.goal,
      status: task.status,
      manifest: task.manifest,
      sources: task.sources,
    }),
    '先遵守能力预检与禁止动作；只引用实际工具结果，缺信息时按 clarification 提最少问题。',
  ].join('\n');
}
