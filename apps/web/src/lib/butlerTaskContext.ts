import type { ButlerSource, ButlerSurfaceContext } from './butlerContext';

export type ButlerScenario =
  | 'find-file'
  | 'compare-pull-requests'
  | 'extract-commitments'
  | 'draft-overdue-work-item-followup'
  | 'associate-build-failure'
  | 'create-weekly-routine'
  | 'workflow'
  | 'resume-task'
  | 'general';

export type ButlerWorkflowKind = 'today' | 'watcher' | 'rounds' | 'routine' | 'workflow';

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
}

/**
 * 这些标签只服务于任务归档和用户确认后的 Skill 学习，不参与回答、追问、
 * Skill 选择或工具路由。真正的语义判断由 Codex 原生 Agent Skills 完成。
 */
const definitions: readonly ScenarioDefinition[] = [
  {
    id: 'general',
    matches: [
      /^(?=[\s\S]*(?:Azure\s*DevOps|ADO))(?=[\s\S]*(?:工作项|WI\b|work\s*items?))(?=[\s\S]*(?:未关闭|未完成|开放|打开|进行中|活跃|open))[\s\S]*$/i,
    ],
    available: ['由 azure-devops-server Skill 通过业务 MCP 实时查询工作项'],
    missing: [],
    sourcePlan: [{ tool: 'rocketx_azure_devops_server_read', kind: 'work-item', freshness: 'query-time' }],
    prohibitedActions: ['不创建、修改或关闭工作项'],
    recovery: '由 Skill 根据实际工具结果说明覆盖范围并重试。',
  },
  {
    id: 'find-file',
    matches: [/(?:找|查|搜索).*(?:文件|附件|文档|设计稿)/i, /(?:文件|附件).*(?:昨天|昨日|发送|上传)/i],
    available: ['可按发送人、日期、房间和附件条件查询消息'],
    missing: [],
    sourcePlan: [{ tool: 'search_messages', kind: 'message', freshness: 'query-time' }],
    prohibitedActions: ['不发送消息', '不修改或下载文件'],
    recovery: '保留实际命中的消息来源。',
  },
  {
    id: 'compare-pull-requests',
    matches: [/(?:比较|对比).*(?:PR|拉取请求)/i, /(?:PR|拉取请求).*(?:差异|区别)/i],
    available: ['由 pr-comparison 与 azure-devops-server Skills 通过业务 MCP 读取 PR'],
    missing: [],
    sourcePlan: [{ tool: 'rocketx_azure_devops_server_read', kind: 'pull-request', freshness: 'query-time' }],
    prohibitedActions: ['不评论、合并或修改 PR'],
    recovery: '由 Skill 固定读取快照；正文不可用时明确降级。',
  },
  {
    id: 'extract-commitments',
    matches: [/(?:提取|整理|查找).*(?:承诺|答应|跟进项)/i, /(?:群聊|消息).*(?:承诺|负责人|截止)/i],
    available: ['可查询群聊原始消息并保留来源'],
    missing: [],
    sourcePlan: [{ tool: 'list_room_messages', kind: 'message', freshness: 'query-time' }],
    prohibitedActions: ['不静默创建待办、工作项或记忆'],
    recovery: '保留原始消息证据。',
  },
  {
    id: 'draft-overdue-work-item-followup',
    matches: [/(?:逾期|过期).*(?:WI|工作项).*(?:跟进|催办|草稿)/i, /(?:跟进|催办).*(?:逾期|过期).*(?:WI|工作项)/i],
    available: ['由 azure-devops-server Skill 实时查询逾期工作项'],
    missing: [],
    sourcePlan: [{ tool: 'rocketx_azure_devops_server_read', kind: 'work-item', freshness: 'query-time' }],
    prohibitedActions: ['不发送催办消息', '不创建或修改工作项'],
    recovery: '保留工作项来源与草稿目标。',
  },
  {
    id: 'associate-build-failure',
    matches: [/(?:构建|CI).*(?:失败|红灯).*(?:提交|变更|PR|关联)/i, /(?:关联|查找).*(?:构建|CI).*(?:提交|变更)/i],
    available: ['由 azure-devops-server Skill 实时查询构建和关联变更'],
    missing: [],
    sourcePlan: [{ tool: 'rocketx_azure_devops_server_read', kind: 'build', freshness: 'query-time' }],
    prohibitedActions: ['不重试或回滚构建', '不修改代码'],
    recovery: '保留实际查询到的失败构建与变更来源。',
  },
  {
    id: 'create-weekly-routine',
    matches: [/(?:创建|安排|新增).*(?:周报|例行|定时).*(?:任务|事务)?/i, /(?:每周|周报).*(?:定时|提醒|例行)/i],
    available: ['由原生 weekly-report Skill 生成待确认的 routine 草案'],
    missing: [],
    sourcePlan: [{ tool: 'draft_routine', kind: 'session', freshness: 'persisted' }],
    prohibitedActions: ['不绕过确认直接启用例行任务'],
    recovery: '草案可取消并重新生成。',
  },
  {
    id: 'resume-task',
    matches: [/(?:继续|续跑|恢复).*(?:任务|调查|上次|昨天|会话)/i],
    available: ['可从当前 session 恢复 transcript 与最近任务态'],
    missing: [],
    sourcePlan: [{ tool: 'session-registry', kind: 'session', freshness: 'persisted' }],
    prohibitedActions: ['不跨账号、服务器或 session 猜测任务'],
    recovery: '由原生会话上下文判断应继续的任务。',
  },
];

const generalDefinition: ScenarioDefinition = {
  id: 'general',
  matches: [],
  available: ['由 Codex 原生 Agent Skills 选择适用方法'],
  missing: [],
  sourcePlan: [],
  prohibitedActions: ['不执行未经确认的写动作'],
  recovery: '保留当前 session transcript。',
};

function identifyLearningScenario(input: string): ScenarioDefinition {
  return definitions.find((definition) => definition.matches.some((pattern) => pattern.test(input))) ?? generalDefinition;
}

export function compileButlerTask(
  input: string,
  context: ButlerSurfaceContext | null | undefined,
  _previous: ButlerTaskState | null | undefined,
  now = Date.now(),
): ButlerTaskState {
  const definition = identifyLearningScenario(input);
  return {
    id: crypto.randomUUID(),
    goal: input,
    status: 'ready',
    createdAt: now,
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
        required: false,
        missing: [],
      },
      prohibitedActions: definition.prohibitedActions,
      recovery: definition.recovery,
    },
    sources: context?.sources ?? [],
  };
}

export function compileButlerWorkflowTask(
  input: {
    kind: ButlerWorkflowKind;
    goal: string;
    sources?: readonly ButlerSource[];
  },
  previous: ButlerTaskState | null | undefined,
  now = Date.now(),
): ButlerTaskState {
  const continuing = previous?.manifest.scenario === 'workflow'
    && previous.status !== 'completed';
  const sources = [...(input.sources ?? [])];
  const sourcePlan = sources.map((source) => ({
    tool: `workflow:${input.kind}`,
    kind: source.kind,
    freshness: 'loaded-snapshot' as const,
  }));
  return {
    id: continuing ? previous.id : crypto.randomUUID(),
    goal: input.goal,
    status: 'ready',
    createdAt: continuing ? previous.createdAt : now,
    updatedAt: now,
    manifest: {
      schemaVersion: 1,
      scenario: 'workflow',
      capabilityPreflight: {
        available: ['复用 Butler session、task、engine、tool runtime 与恢复合同'],
        missing: [],
      },
      sourcePlan,
      clarification: {
        required: false,
        missing: [],
      },
      prohibitedActions: ['不绕过 typed tool runtime 执行写操作', '不把主动任务混入用户对话 transcript'],
      recovery: '失败或暂停后从同一 workflow session、task state 与审批记录明确重试。',
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
    '以下仅是 RocketX 当前回合的宿主状态，不负责解释意图、选择 Skill 或规划工具：',
    JSON.stringify({
      id: task.id,
      status: task.status,
      sources: task.sources,
    }),
    '请直接理解用户原话，由 Codex 原生 Agent Skills 隐式匹配适用方法；只有用户显式输入 $skill 时才固定使用对应 Skill。缺少信息时由所选 Skill 在对话中自然追问。',
  ].join('\n');
}
