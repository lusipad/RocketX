import type { ButlerScenario, ButlerTaskState } from '../../../lib/butlerTaskContext';
import { butlerToolLabel } from '../../../lib/butlerToolLabels';
import type { ButlerStep } from '../../../stores/butler';

export type ButlerSkillDraftMode = 'auto' | 'explicit';
export type ButlerSkillDraftEffect = 'read' | 'draft';
export type ButlerSkillDraftStatus = 'draft';
export type ButlerSkillDraftFailureReason =
  | 'task-not-completed'
  | 'general-requires-explicit'
  | 'missing-session-id'
  | 'missing-line-ids';

export interface ButlerSkillDraft {
  id: string;
  proposalId?: string;
  name: string;
  title: string;
  description: string;
  mode: ButlerSkillDraftMode;
  status: ButlerSkillDraftStatus;
  conversationHidden?: boolean;
  createdAt: number;
  whenToUse: string[];
  procedure: string[];
  reads: string[];
  produces: string[];
  confirmations: string[];
  pitfalls: string[];
  verification: string[];
  effect: ButlerSkillDraftEffect;
  source: {
    sessionId: string;
    lineIds: string[];
    scenario: ButlerScenario;
  };
}

export interface BuildButlerSkillDraftInput {
  taskState: ButlerTaskState;
  sessionId: string;
  lineIds: readonly string[];
  steps: readonly ButlerStep[];
  mode?: ButlerSkillDraftMode;
  now?: number;
}

export type ButlerSkillDraftBuildResult =
  | { ok: true; draft: ButlerSkillDraft }
  | { ok: false; reason: ButlerSkillDraftFailureReason; message: string };

interface DraftScenarioTemplate {
  name: string;
  title: string;
  description: string;
  whenToUse: string[];
  procedure: string[];
  produces: string[];
  confirmations: string[];
  pitfalls: string[];
  verification: string[];
  effect: ButlerSkillDraftEffect;
}

const sourceKindLabels = {
  room: '房间上下文',
  message: '消息与聊天记录',
  todo: '待办',
  calendar: '日程',
  'work-item': '工作项',
  'pull-request': '拉取请求',
  build: '构建',
  session: '当前会话',
} as const;

const freshnessLabels = {
  'query-time': '实时读取',
  'loaded-snapshot': '读取当前快照',
  persisted: '读取持久化资料',
} as const;

const scenarioTemplates: Record<ButlerScenario, DraftScenarioTemplate> = {
  'find-file': {
    name: 'find-file-workflow',
    title: '定位共享文件',
    description: '按发送人、日期和房间范围定位共享文件，不直接修改或下载文件。',
    whenToUse: [
      '需要在聊天记录里找回别人发过的文件、附件或设计稿时使用。',
    ],
    procedure: [
      '先收紧发送人、日期和房间范围，避免全量盲搜。',
      '按已确认范围查询相关消息，再从命中的附件里定位目标文件。',
      '只返回定位结果和来源，不替用户下载、转发或修改文件。',
    ],
    produces: [
      '给出可核对的文件定位结果和来源线索，不直接下载、转发或修改文件。',
    ],
    confirmations: [
      '如果后续要转发、下载或改动文件，需要另行确认。',
    ],
    pitfalls: [
      '发送人或日期不清时先补范围，不要靠猜测放大搜索。',
      '只根据实际命中的消息与附件下结论，不把模糊描述当成文件事实。',
    ],
    verification: [
      '核对返回的文件是否与发送人、日期和房间条件一致。',
      '确认每个定位结果都能回到实际命中的消息或附件来源。',
    ],
    effect: 'read',
  },
  'compare-pull-requests': {
    name: 'compare-pull-requests-workflow',
    title: '比较 PR',
    description: '按固定读取顺序比较两个 PR 的范围、差异和风险，不直接评论、合并或修改 PR。',
    whenToUse: [
      '需要比较两个 PR 的差异、影响范围或发布风险时使用。',
    ],
    procedure: [
      '先锁定要比较的两个 PR，并确认比较口径一致。',
      '分别读取两个 PR 的固定快照、变更和必要文件。',
      '按范围、风险和结论口径输出对比结果，不直接评论、合并或修改 PR。',
    ],
    produces: [
      '输出可审阅的差异结论和风险说明，不直接评论、合并或修改 PR。',
    ],
    confirmations: [
      '如果后续要评论、合并、批准或改状态，必须另行确认。',
    ],
    pitfalls: [
      '正文受限或关键文件缺失时要明确降级，不要假装比较完整。',
      '不要把局部改动直接放大成整体风险结论。',
    ],
    verification: [
      '抽查两个 PR 的标题、状态、关键文件和结论是否一致。',
      '确认每条风险判断都能回到实际读取结果。',
    ],
    effect: 'read',
  },
  'extract-commitments': {
    name: 'extract-commitments-workflow',
    title: '提取承诺',
    description: '从群聊或频道消息中提取可核对的承诺清单，不自动创建待办或记忆。',
    whenToUse: [
      '需要从聊天记录里整理谁答应了什么、何时兑现时使用。',
    ],
    procedure: [
      '先确认群聊范围和时间范围，再读取相关消息。',
      '只把第一人称明确认领的可交付事项记为承诺。',
      '输出明确承诺和需要补确认的疑似项，不自动创建待办、工作项或记忆。',
    ],
    produces: [
      '产出可核对的承诺清单和疑似项，不自动创建待办、工作项或记忆。',
    ],
    confirmations: [
      '如果后续要写入待办、工作项或长期记忆，需要另行确认。',
    ],
    pitfalls: [
      '转述、假设句、疑问句和引用旧消息都不算承诺。',
      '覆盖不完整或消息被截断时必须说明局限。',
    ],
    verification: [
      '逐条核对发言人、承诺内容和期限是否都能回到原始消息来源。',
      '确认没有把模糊表态误记成明确承诺。',
    ],
    effect: 'read',
  },
  'draft-overdue-work-item-followup': {
    name: 'overdue-work-item-followup-draft',
    title: '起草逾期工作项跟进',
    description: '读取逾期工作项并生成待确认跟进草稿，不直接发送消息或修改工作项。',
    whenToUse: [
      '需要为逾期工作项整理跟进口径或催办草稿时使用。',
    ],
    procedure: [
      '先读取逾期工作项的标题、状态和负责人等必要信息。',
      '按统一口径整理需要跟进的对象、原因和下一步。',
      '只生成待确认草稿，不直接发送消息或修改工作项。',
    ],
    produces: [
      '生成可编辑的跟进草稿，不直接发送消息或修改工作项。',
    ],
    confirmations: [
      '发送草稿、改工作项状态或补充负责人前必须再次确认。',
    ],
    pitfalls: [
      '负责人、状态或截止信息缺失时要先标出缺口，不要补写。',
      '不要把草稿当成已经发送的结果。',
    ],
    verification: [
      '核对每条草稿内容是否都来自实际工作项字段。',
      '确认草稿仍然保留待确认边界，没有宣称已发送或已修改。',
    ],
    effect: 'draft',
  },
  'associate-build-failure': {
    name: 'associate-build-failure-workflow',
    title: '关联构建失败',
    description: '读取失败构建与可见变更线索，整理关联结论，不重试构建也不修改代码。',
    whenToUse: [
      '需要判断一次失败构建可能和哪些提交、变更或 PR 相关时使用。',
    ],
    procedure: [
      '先锁定失败构建编号，再读取构建元数据和可见上下文。',
      '根据实际可见的构建信息整理关联线索与未覆盖缺口。',
      '只输出关联结论和不确定项，不重试构建也不修改代码。',
    ],
    produces: [
      '输出失败构建的关联结论和证据缺口，不重试构建也不修改代码。',
    ],
    confirmations: [
      '如果后续要重试构建、回滚或改代码，必须另行确认。',
    ],
    pitfalls: [
      '当前能力读不到完整变更集时要明确说明边界。',
      '不要把时间接近误判成因果关系。',
    ],
    verification: [
      '核对构建编号、状态和关联线索是否都来自实际读取结果。',
      '确认所有不确定项都被明确标出，没有冒充根因。',
    ],
    effect: 'read',
  },
  'create-weekly-routine': {
    name: 'create-weekly-routine-draft',
    title: '起草每周例行任务',
    description: '基于既有 Skill 和时间要求生成例行任务草案，不绕过确认直接启用。',
    whenToUse: [
      '需要把固定节奏的工作整理成每周例行任务时使用。',
    ],
    procedure: [
      '先确认执行星期、时间和要复用的 Skill。',
      '根据既有 Skill 生成例行任务草案，并检查调度信息是否完整。',
      '只生成待确认草案，不直接启用或持久化例行任务。',
    ],
    produces: [
      '生成可编辑的例行任务草案，不直接启用或持久化例行任务。',
    ],
    confirmations: [
      '启用、保存或改动调度前必须再次确认。',
    ],
    pitfalls: [
      '星期或时间缺失时先补条件，不要擅自代填。',
      '不要把草案误说成已经开始执行的例行任务。',
    ],
    verification: [
      '核对星期、时间和 Skill 名称是否与草案一致。',
      '确认草案仍处于待确认状态，没有被自动启用。',
    ],
    effect: 'draft',
  },
  'workflow': {
    name: 'workflow-reuse-draft',
    title: '沉淀工作流做法',
    description: '把已经跑通的工作流整理成可复用方法，只保留稳定步骤与边界，不自动扩大权限。',
    whenToUse: [
      '当同类工作流已经稳定跑通，且希望沉淀成可复用做法时使用。',
    ],
    procedure: [
      '先收敛这次工作流的目标、边界和可信来源。',
      '把已经验证过的稳定步骤整理成可重复执行的顺序。',
      '只保留当前任务已证明的能力边界，不自动扩大为写操作。',
    ],
    produces: [
      '产出可复用的方法说明，不自动执行额外写动作。',
    ],
    confirmations: [
      '任何超出当前流程边界的写动作，都必须另行确认。',
    ],
    pitfalls: [
      '不要把一次偶然成功的步骤写成通用保证。',
      '没有证据支持的步骤、权限或结果不要补进草稿。',
    ],
    verification: [
      '确认每一步都来自已完成流程的稳定证据，而不是原始聊天复述。',
      '确认草稿只覆盖已验证边界，没有静默扩大权限。',
    ],
    effect: 'read',
  },
  'resume-task': {
    name: 'resume-task-workflow',
    title: '恢复任务上下文',
    description: '按 session 和最近任务态恢复调查上下文，不跨账号或会话猜测目标。',
    whenToUse: [
      '需要继续昨天或上次停下来的调查、分析或执行任务时使用。',
    ],
    procedure: [
      '先确认要恢复的是哪一个 session 和任务态。',
      '读取最近的 transcript、任务状态和恢复线索，再继续处理。',
      '只在当前可信 session 范围内恢复，不跨账号或会话猜测上下文。',
    ],
    produces: [
      '给出明确的恢复上下文和下一步，不跨会话猜测任务内容。',
    ],
    confirmations: [
      '如果后续要切换账号、跨工作区或执行写动作，需要另行确认。',
    ],
    pitfalls: [
      '当前会话没有可恢复任务时要先补目标，不要强行续跑。',
      '不要把旧结论原样复述成新的已验证结果。',
    ],
    verification: [
      '核对恢复到的 session、任务态和下一步是否一致。',
      '确认恢复内容来自已保存状态，而不是原始聊天猜测。',
    ],
    effect: 'read',
  },
  general: {
    name: 'general-workflow-draft',
    title: '通用工作做法',
    description: '把一次显式指定要沉淀的方法整理成通用草稿，只保留已验证边界，不复制原始聊天正文。',
    whenToUse: [
      '只有用户明确要求“把这套做法保存为 Skill”时才使用。',
    ],
    procedure: [
      '先确认这次要沉淀的是哪一种工作做法，而不是完整聊天内容。',
      '把已验证的稳定步骤、读取范围和确认边界整理成可编辑草稿。',
      '没有证据支持的步骤、权限或输出不要补写。',
    ],
    produces: [
      '生成待人工补充与确认的通用草稿，不复制原始聊天正文，也不自动写入外部系统。',
    ],
    confirmations: [
      '任何写动作、发送动作或落库动作都必须另行确认。',
    ],
    pitfalls: [
      '通用场景最容易把一次性对话错当成稳定方法，证据不足时要保持保守。',
      '不要把原始聊天用语、隐私信息或临时上下文写进草稿。',
    ],
    verification: [
      '确认草稿只保留稳定步骤和边界，没有复制原始聊天正文。',
      '确认任何输出承诺都没有超过当前任务实际证明的能力。',
    ],
    effect: 'read',
  },
};

function failure(
  reason: ButlerSkillDraftFailureReason,
  message: string,
): ButlerSkillDraftBuildResult {
  return { ok: false, reason, message };
}

function normalizeText(value: string | undefined): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function normalizeLineIds(lineIds: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of lineIds) {
    const normalized = normalizeText(candidate);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function normalizeStepLabel(value: string | undefined): string {
  return normalizeText(value).split(/[（(]/u, 1)[0]?.trim() ?? '';
}

function normalizeStepLabels(steps: readonly ButlerStep[]): string[] {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const step of steps) {
    if (step.status !== 'done') continue;
    const label = normalizeStepLabel(step.label);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    labels.push(label);
    if (labels.length >= 6) break;
  }
  return labels;
}

function observedProcedure(steps: readonly ButlerStep[]): string[] {
  return normalizeStepLabels(steps).map((label) => `按已验证流程执行「${label}」。`);
}

function readableToolLabel(tool: string): string {
  if (tool === 'session-registry') return '读取当前会话记录';
  if (tool.startsWith('workflow:')) return '读取当前流程来源';
  const label = butlerToolLabel(tool);
  return label === tool ? '读取已声明来源' : label;
}

function renderReadLine(taskState: ButlerTaskState): string[] {
  const lines = taskState.manifest.sourcePlan.map((source) => {
    const freshness = freshnessLabels[source.freshness];
    const kind = sourceKindLabels[source.kind];
    return `${freshness}${kind}（${readableToolLabel(source.tool)}）。`;
  });
  return lines.length > 0
    ? lines
    : ['只读取当前任务已经声明的结构化来源，不猜测额外上下文。'];
}

function effectGuard(effect: ButlerSkillDraftEffect): string {
  return effect === 'draft'
    ? '只生成草稿或待确认提案，不直接发送、启用或落库。'
    : '只输出只读结论或整理结果，不直接修改外部系统。';
}

function verificationGuard(steps: readonly ButlerStep[]): string[] {
  const labels = normalizeStepLabels(steps);
  if (labels.length === 0) {
    return ['回看最终结论时，确认每个判断都能回到真实读取结果。'];
  }
  return [`回看最终结论时，逐项核对这些已验证步骤：${labels.join('、')}。`];
}

function buildProcedure(
  template: DraftScenarioTemplate,
  steps: readonly ButlerStep[],
): string[] {
  const observed = observedProcedure(steps);
  return observed.length > 0
    ? [template.procedure[0], ...observed, ...template.procedure.slice(1)]
    : [...template.procedure];
}

function buildConfirmations(template: DraftScenarioTemplate): string[] {
  return [
    ...template.confirmations,
    template.effect === 'draft'
      ? '草稿真正发送、保存、启用或落库前必须再次确认。'
      : '任何写动作都不在这份 Skill 内，需要时必须重新确认。',
  ];
}

function buildPitfalls(taskState: ButlerTaskState, template: DraftScenarioTemplate): string[] {
  const missing = taskState.manifest.capabilityPreflight.missing
    .map((item) => normalizeText(item))
    .filter(Boolean);
  return missing.length > 0
    ? [...template.pitfalls, `当前能力不覆盖：${missing.join('；')}。`]
    : [...template.pitfalls];
}

function buildVerification(
  taskState: ButlerTaskState,
  template: DraftScenarioTemplate,
  steps: readonly ButlerStep[],
): string[] {
  const verification = [...template.verification, ...verificationGuard(steps)];
  const recovery = normalizeText(taskState.manifest.recovery);
  return recovery ? [...verification, `如果证据不足或范围变化，按这个恢复边界重跑：${recovery}`] : verification;
}

export function buildButlerSkillDraft(
  input: BuildButlerSkillDraftInput,
): ButlerSkillDraftBuildResult {
  if (input.taskState.status !== 'completed') {
    return failure('task-not-completed', '只有已完成任务才能沉淀为 Skill 草稿。');
  }
  const sessionId = normalizeText(input.sessionId);
  if (!sessionId) {
    return failure('missing-session-id', 'Skill 草稿必须绑定来源 sessionId。');
  }
  const lineIds = normalizeLineIds(input.lineIds);
  if (lineIds.length === 0) {
    return failure('missing-line-ids', 'Skill 草稿必须保留至少一个来源 lineId。');
  }
  const mode = input.mode ?? 'auto';
  const scenario = input.taskState.manifest.scenario;
  if (scenario === 'general' && mode !== 'explicit') {
    return failure('general-requires-explicit', 'general 场景只能在用户显式要求时生成 Skill 草稿。');
  }

  const template = scenarioTemplates[scenario];
  const createdAt = input.now ?? input.taskState.updatedAt;
  return {
    ok: true,
    draft: {
      id: `skill-draft:${input.taskState.id}`,
      name: template.name,
      title: template.title,
      description: template.description,
      mode,
      status: 'draft',
      createdAt,
      whenToUse: [...template.whenToUse],
      procedure: buildProcedure(template, input.steps),
      reads: renderReadLine(input.taskState),
      produces: [...template.produces, effectGuard(template.effect)],
      confirmations: buildConfirmations(template),
      pitfalls: buildPitfalls(input.taskState, template),
      verification: buildVerification(input.taskState, template, input.steps),
      effect: template.effect,
      source: {
        sessionId,
        lineIds,
        scenario,
      },
    },
  };
}

function renderSection(title: string, lines: readonly string[], ordered = false): string[] {
  return [
    `## ${title}`,
    '',
    ...(ordered
      ? lines.map((line, index) => `${index + 1}. ${line}`)
      : lines.map((line) => `- ${line}`)),
    '',
  ];
}

export function renderButlerSkillDraftMarkdown(draft: ButlerSkillDraft): string {
  return [
    draft.title,
    '',
    draft.description,
    '',
    ...renderSection('何时使用', draft.whenToUse),
    ...renderSection('做法步骤', draft.procedure, true),
    ...renderSection('读取范围', draft.reads),
    ...renderSection('会产生什么', draft.produces),
    ...renderSection('需要确认', draft.confirmations),
    ...renderSection('易错点', draft.pitfalls),
    ...renderSection('如何验证', draft.verification),
  ].join('\n').trim();
}
