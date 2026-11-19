import { tsMs } from '@rcx/rc-client';
import { collectMentionInbox } from '../lib/mentionInbox';
import { rest } from '../lib/client';
import { useAcpAgents } from '../stores/acpAgents';
import { useAuth } from '../stores/auth';
import { useButlerMemory } from '../stores/butlerMemory';
import { eventsForDate, isEventDone, useCalendar } from '../stores/calendar';
import { permalinkOf, useChat } from '../stores/chat';
import { useTodos } from '../stores/todos';
import { captureWorkLedgerAccount, useWorkLedger } from '../stores/workLedger';
import { observeWorkArtifacts } from './workArtifacts';
import type {
  ButlerMemoryCategory,
  WorkCardStage,
  WorkCardWaitState,
} from '../platform/desktopCommands';
import { stripAgentSessionMarker } from './card';
import {
  generatePersonalAssistantBrief,
  saveAssistantSnapshotDigest,
  type PersonalAssistantBriefKind,
} from './personalAssistant';
import type { DynamicToolCallResponse } from './protocol/generated/v2/DynamicToolCallResponse';
import type { DynamicToolSpec } from './protocol/generated/v2/DynamicToolSpec';
import {
  requireScheduledTaskAdapter,
  type ScheduledTaskInput,
  type ScheduledTaskPatch,
} from './scheduledTaskBridge';
import { evaluateCardCompletionGate } from './workCoordinator';
import { renderDispatchSpec } from './dispatchSpec';
import { verifyWorkCiEvidence } from './workCiEvidence';
import { executePreparedExternalAction, publishWorkReport, syncWorkAdoState } from './externalWorkActions';
import {
  buildWorkflowExecutionReport,
  distillReportToMemory,
  recordReportAsWorkEvidence,
} from './workflowReport';

const LIMIT = 20;
const MAX_CALENDAR_DAYS = 31;

export const ROCKETX_DYNAMIC_TOOLS: DynamicToolSpec[] = [
  {
    type: 'function',
    name: 'list_mentions',
    description: '列出当前 RocketX 账号尚未处理的 @我消息，返回实时服务器快照、覆盖状态和消息链接。',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: '可选 ISO 日期时间，只返回严格晚于该时间的消息。' },
        unprocessedOnly: { type: 'boolean', description: '是否只返回尚未读过的 @，默认 false。' },
      },
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'list_todos',
    description: '列出 RocketX 本地待办；默认只返回未完成项，可按关键词筛选。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '待办正文、来源会话或作者关键词。' },
        includeDone: { type: 'boolean', description: '是否包含已完成项，默认 false。' },
      },
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'list_calendar',
    description: '列出 RocketX 本地日程并展开重复事件，可按关键词和日期范围筛选。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '日程标题或描述关键词。' },
        from: { type: 'string', description: '起始日期，YYYY-MM-DD，包含当天。' },
        to: { type: 'string', description: '结束日期，YYYY-MM-DD，包含当天。' },
      },
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'list_scheduled_tasks',
    description: '列出当前设备上的 Codex 已安排任务、状态、规则和最近运行。用户询问现有安排时必须先调用。',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'create_scheduled_task',
    description: '创建并启用一个 Codex 已安排任务。先与用户确认任务内容和运行时间；rrule 必须是 RFC 5545 RRULE。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['cron', 'heartbeat'], description: 'heartbeat 回到当前会话，默认使用；只有明确要求独立项目任务时才用 cron。' },
        name: { type: 'string' },
        prompt: { type: 'string' },
        rrule: { type: 'string', description: '例如 RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0。' },
        status: { type: 'string', enum: ['ACTIVE', 'PAUSED'] },
        workspaceRoot: { type: 'string', description: 'cron 运行的本地工作区；省略则使用当前工作区。' },
        targetThreadId: { type: 'string', description: 'heartbeat 必填，目标 Codex 会话 ID。' },
        model: { type: 'string' },
        reasoningEffort: { type: 'string' },
        notificationPolicy: { type: 'string', enum: ['all_runs', 'important_updates', 'failed_runs_only'] },
        skillName: { type: 'string', description: '可选，任务必须调用的已启用 Skill 名称。' },
        pluginTemplateId: { type: 'string' },
      },
      required: ['name', 'prompt', 'rrule'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'update_scheduled_task',
    description: '修改、暂停或恢复一个已安排任务。先调用 list_scheduled_tasks 获取准确 ID；只传需要修改的字段。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        kind: { type: 'string', enum: ['cron', 'heartbeat'] },
        name: { type: 'string' },
        prompt: { type: 'string' },
        rrule: { type: 'string' },
        status: { type: 'string', enum: ['ACTIVE', 'PAUSED'] },
        workspaceRoot: { type: 'string' },
        targetThreadId: { type: 'string' },
        model: { type: 'string' },
        reasoningEffort: { type: 'string' },
        notificationPolicy: { type: 'string', enum: ['all_runs', 'important_updates', 'failed_runs_only'] },
        skillName: { type: 'string' },
        pluginTemplateId: { type: 'string' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'delete_scheduled_task',
    description: '永久删除一个已安排任务。只有用户明确要求删除时才调用。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'run_scheduled_task',
    description: '立即运行一次指定的已安排任务，并返回本次结果。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'create_work_card',
    description: '将明确目标纳入持续跟进，幂等创建同一件工作。必须明确目标和验收条件；保留消息、ADO及工作目录来源，默认遵守确认权限。重试复用requestId。',
    inputSchema: {
      type: 'object', properties: {
        requestId: { type: 'string' }, title: { type: 'string' }, goal: { type: 'string' },
        acceptance: { type: 'array', items: { type: 'string' }, minItems: 1 },
        boundaries: { type: 'array', items: { type: 'string' } },
        projectKey: { type: 'string' }, workspaceRoot: { type: 'string' },
        rid: { type: 'string' }, mid: { type: 'string' }, adoWorkItemId: { type: 'integer', minimum: 1 }, adoProject: { type: 'string' },
      }, required: ['requestId', 'title', 'goal', 'acceptance'], additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'list_work_cards',
    description: '列出统一工作看板（Unified Kanban）中的工作卡片、阶段、正交等待状态、关联会话及验收证据。',
    inputSchema: {
      type: 'object',
      properties: {
        stage: { type: 'string', enum: ['triage', 'ready', 'in_progress', 'verifying', 'done'] },
        includeDone: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'update_work_card',
    description: '更新工作卡片的阶段（stage）、正交等待状态（waitState）或下一步计划（nextStep）。若无有效验收证据则不能直接置为 done。',
    inputSchema: {
      type: 'object',
      properties: {
        todoId: { type: 'string' },
        stage: { type: 'string', enum: ['triage', 'ready', 'in_progress', 'verifying', 'done'] },
        waitState: { type: 'string', enum: ['none', 'waiting_input', 'waiting_approval', 'waiting_external', 'blocked', 'paused', 'canceled'] },
        waitReason: { type: 'string' },
        nextStep: { type: 'string' },
        goal: { type: 'string' },
        acceptance: { type: 'array', items: { type: 'string' } },
        boundaries: { type: 'array', items: { type: 'string' } },
        rework: { type: 'boolean', description: '成果修改/返工，使旧版本证据需要重新核验。' },
        expectedRequirementsVersion: { type: 'integer', minimum: 0, description: '修改目标、验收、边界或请求返工时必填，防止旧执行覆盖新要求。' },
        expectedContentVersion: { type: 'integer', minimum: 0, description: '可选成果版本比较，旧成果不能覆盖新版本。' },
      },
      required: ['todoId'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'record_work_evidence',
    description: '保存Agent对执行结果的声明记录。模型提交的kind/passed仅是声明，一律保存为agent_report且不通过验收；可信CI请用verify_work_ci_evidence。',
    inputSchema: {
      type: 'object',
      properties: {
        todoId: { type: 'string' },
        kind: { type: 'string', enum: ['test_run', 'ci_build', 'pr_status', 'diff_check', 'agent_report'] },
        title: { type: 'string' },
        summary: { type: 'string' },
        headSha: { type: 'string' },
        passed: { type: 'boolean' },
        criterionIds: { type: 'array', items: { type: 'string' }, description: '此结果明确验证的验收条件原文；缺失时仅保存记录，不贡献自动验收。' },
        requirementsVersion: { type: 'integer', minimum: 0, description: '执行时采用的要求版本，必须从工作读取后原样提交。' },
        contentVersion: { type: 'integer', minimum: 0, description: '被验证成果的版本。' },
      },
      required: ['todoId', 'kind', 'title', 'passed'],
      additionalProperties: false,
    },
  },
  {
    type: 'function', name: 'verify_work_ci_evidence',
    description: '只读核对ADO构建，确认项目、当前工作HEAD、构建定义及完成成功状态后登记可信ci_build证据。仅覆盖当前声明的CI/构建/流水线条件，不能代替业务人工验收。',
    inputSchema: { type: 'object', properties: {
      todoId: { type: 'string' }, project: { type: 'string' }, buildId: { type: 'integer', minimum: 1 },
      requirementsVersion: { type: 'integer', minimum: 0 }, contentVersion: { type: 'integer', minimum: 0 },
      criterionIds: { type: 'array', items: { type: 'string' }, minItems: 1 },
    }, required: ['todoId', 'project', 'buildId', 'requirementsVersion', 'contentVersion', 'criterionIds'], additionalProperties: false },
  },
  {
    type: 'function',
    name: 'memory_search',
    description: '检索与当前工作区或关键词相关的长期个人记忆（偏好、项目事实、工作习惯、人物上下文、阶段总结）。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索关键词。' },
        category: {
          type: 'string',
          enum: ['preference', 'project_fact', 'workflow_habit', 'person_context', 'episodic_summary'],
        },
        workspaceRoot: { type: 'string', description: '可选工作区路径筛选。' },
        limit: { type: 'number', description: '返回条数上限，默认 6。' },
      },
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'memory_save',
    description: '保存一条结构化的长期个人记忆；自动拦截密钥、令牌等敏感凭据。',
    inputSchema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['preference', 'project_fact', 'workflow_habit', 'person_context', 'episodic_summary'],
        },
        title: { type: 'string' },
        content: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        workspaceRoot: { type: 'string' },
        pinned: { type: 'boolean' },
      },
      required: ['category', 'title', 'content'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'memory_delete',
    description: '根据 ID 删除一条长期个人记忆。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'assistant_daily_brief',
    description: '汇总待办、日程、工作流进度、对外承诺与长期记忆，生成晨间简报、晚间复盘或当前聚焦摘要。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['morning_brief', 'evening_review', 'focus_digest'] },
        saveDigest: { type: 'boolean', description: '是否持久化保存到个人助理简报归档，默认 false。' },
      },
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'workflow_report_generate',
    description: '基于工作卡片或 ACP 会话生成结构化工作流执行汇报（含进度、产物、验证证据、风险与下一步建议）。',
    inputSchema: {
      type: 'object',
      properties: {
        todoId: { type: 'string' },
        sessionKey: { type: 'string' },
        recordEvidence: { type: 'boolean', description: '若提供 todoId，保存汇报来源记录；汇报不构成验收通过证据。' },
        distillMemory: { type: 'boolean', description: '是否提炼摘要保存到长期记忆。' },
      },
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'workflow_report_publish',
    description: '从指定工作的真实账本生成冻结汇报并投递到关联讨论室；保留稳定操作身份及送达回执。遵守工作现有自主权限，需审批时只登记意图，不声称已送达。',
    inputSchema: {
      type: 'object',
      properties: {
        todoId: { type: 'string' }, rid: { type: 'string' },
        operationId: { type: 'string', description: '本次汇报的稳定操作 ID；核对和重试必须复用。' },
      },
      required: ['todoId', 'rid', 'operationId'], additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'work_ado_state_sync',
    description: '按指定ADO版本及当前状态受控更新工作的关联ADO状态，写后回读。版本冲突不覆盖，结果未知不重放；不会把外部同步等同工作验收。',
    inputSchema: {
      type: 'object',
      properties: {
        todoId: { type: 'string' }, operationId: { type: 'string' },
        expectedRevision: { type: 'integer', minimum: 1 }, expectedState: { type: 'string' }, targetState: { type: 'string' },
      },
      required: ['todoId', 'operationId', 'expectedRevision', 'expectedState', 'targetState'], additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'work_external_action_continue',
    description: '核对或执行已持久化的外部动作。仅使用现有授权，不能批准待人工审批动作。ADO结果未知仅回读，汇报可显式用原消息ID续投。',
    inputSchema: {
      type: 'object', properties: { actionId: { type: 'string' }, retryReport: { type: 'boolean' } },
      required: ['actionId'], additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'acp_list_agents',
    description: '列出已注册的本地 ACP（Agent Client Protocol）代理配置与已发现的本地 CLI 候选。',
    inputSchema: {
      type: 'object',
      properties: {
        includeDisabled: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'acp_dispatch_task',
    description: '将同一工作的执行请求持久入队并立即返回，管家可继续响应。必须先纳入工作并复用requestId；确认模式等待人工批准，自主模式由后台执行。临时会话请使用ACP工作台。',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string' },
        workspaceRoot: { type: 'string' },
        prompt: { type: 'string' },
        todoId: { type: 'string' },
        requestId: { type: 'string', description: '此轮委派的稳定请求ID，重试必须复用。' },
        isolateWorktree: { type: 'boolean' },
        autonomyMode: { type: 'string', enum: ['readonly', 'confirm', 'autonomous'] },
        title: { type: 'string' },
      },
      required: ['prompt', 'todoId', 'requestId'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'acp_session_status',
    description: '查询当前 ACP 会话的运行状态、计划进度、待审批权限数及最新输出。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionKey: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
];

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  return typeof args[key] === 'boolean' ? args[key] as boolean : undefined;
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = optionalString(args, key);
  if (!value) throw new Error(`${key} 不能为空`);
  return value;
}

function scheduledTaskEnum(
  key: 'kind' | 'status' | 'notificationPolicy',
  value: string | undefined,
): string | undefined {
  if (!value) return undefined;
  const allowed = key === 'kind'
    ? ['cron', 'heartbeat']
    : key === 'status'
      ? ['ACTIVE', 'PAUSED']
      : ['all_runs', 'important_updates', 'failed_runs_only'];
  if (!allowed.includes(value)) throw new Error(`${key} 的值无效`);
  return value;
}

function scheduledTaskInput(args: Record<string, unknown>): ScheduledTaskInput {
  const kind = scheduledTaskEnum('kind', optionalString(args, 'kind')) as ScheduledTaskInput['kind'];
  const status = scheduledTaskEnum('status', optionalString(args, 'status')) as ScheduledTaskInput['status'];
  const notificationPolicy = scheduledTaskEnum(
    'notificationPolicy',
    optionalString(args, 'notificationPolicy'),
  ) as ScheduledTaskInput['notificationPolicy'];
  return {
    name: requiredString(args, 'name'),
    prompt: requiredString(args, 'prompt'),
    rrule: requiredString(args, 'rrule'),
    ...(kind ? { kind } : {}),
    ...(status ? { status } : {}),
    ...(optionalString(args, 'workspaceRoot') ? { workspaceRoot: optionalString(args, 'workspaceRoot') } : {}),
    ...(optionalString(args, 'targetThreadId') ? { targetThreadId: optionalString(args, 'targetThreadId') } : {}),
    ...(optionalString(args, 'model') ? { model: optionalString(args, 'model') } : {}),
    ...(optionalString(args, 'reasoningEffort') ? { reasoningEffort: optionalString(args, 'reasoningEffort') } : {}),
    ...(notificationPolicy ? { notificationPolicy } : {}),
    ...(optionalString(args, 'skillName') ? { skillName: optionalString(args, 'skillName') } : {}),
    ...(optionalString(args, 'pluginTemplateId') ? { pluginTemplateId: optionalString(args, 'pluginTemplateId') } : {}),
  };
}

function scheduledTaskPatch(args: Record<string, unknown>): ScheduledTaskPatch {
  const input = { ...args };
  delete input.id;
  const patch: ScheduledTaskPatch = { id: requiredString(args, 'id') };
  for (const key of [
    'kind',
    'name',
    'prompt',
    'rrule',
    'status',
    'workspaceRoot',
    'targetThreadId',
    'model',
    'reasoningEffort',
    'notificationPolicy',
    'skillName',
    'pluginTemplateId',
  ] as const) {
    const value = optionalString(input, key);
    if (!value) continue;
    const validated = key === 'kind' || key === 'status' || key === 'notificationPolicy'
      ? scheduledTaskEnum(key, value)
      : value;
    (patch as unknown as Record<string, unknown>)[key] = validated;
  }
  return patch;
}

function response(value: unknown, success = true): DynamicToolCallResponse {
  return {
    contentItems: [{ type: 'inputText', text: JSON.stringify(value) }],
    success,
  };
}

function matches(value: string, query?: string): boolean {
  return !query || value.toLocaleLowerCase().includes(query.toLocaleLowerCase());
}

function dateRange(from?: string, to?: string): string[] | undefined {
  if (!from && !to) return undefined;
  const start = from ?? to!;
  const end = to ?? from!;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    throw new Error('from 和 to 必须是 YYYY-MM-DD');
  }
  const cursor = new Date(`${start}T00:00:00`);
  const last = new Date(`${end}T00:00:00`);
  if (Number.isNaN(cursor.getTime()) || Number.isNaN(last.getTime()) || cursor > last) {
    throw new Error('日程日期范围无效');
  }
  const dates: string[] = [];
  while (cursor <= last && dates.length <= MAX_CALENDAR_DAYS) {
    dates.push(
      `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(
        cursor.getDate(),
      ).padStart(2, '0')}`,
    );
    cursor.setDate(cursor.getDate() + 1);
  }
  if (dates.length > MAX_CALENDAR_DAYS) throw new Error('日程查询范围不能超过 31 天');
  return dates;
}

async function listMentions(args: Record<string, unknown>): Promise<unknown> {
  const user = useAuth.getState().user;
  if (!user?.username) throw new Error('RocketX 尚未登录');
  const since = optionalString(args, 'since');
  const sinceAt = since ? Date.parse(since) : undefined;
  if (sinceAt !== undefined && !Number.isFinite(sinceAt)) throw new Error('since 必须是有效的 ISO 日期时间');
  const unprocessedOnly = optionalBoolean(args, 'unprocessedOnly') ?? false;
  const subscriptions = Object.values(useChat.getState().subscriptions);
  const candidates = subscriptions.filter((subscription) => (subscription.userMentions ?? 0) > 0);
  const lastSeen = new Map(candidates.map((subscription) => [subscription.rid, tsMs(subscription.ls)]));
  const result = await collectMentionInbox(
    candidates.map((subscription) => ({
      rid: subscription.rid,
      name: subscription.fname || subscription.name || subscription.rid,
      userMentions: subscription.userMentions ?? 0,
    })),
    { _id: user._id, username: user.username },
    (rid, offset, count) => rest.getMentionedMessagesPage(rid, offset, count),
  );
  const matching = result.items
    .filter(({ message }) => sinceAt === undefined || tsMs(message.ts) > sinceAt)
    .filter(({ message }) => !unprocessedOnly || tsMs(message.ts) > (lastSeen.get(message.rid) ?? 0));
  const items = matching.slice(0, LIMIT).map(({ message, roomName }) => ({
    id: message._id,
    rid: message.rid,
    roomName,
    sender: message.u.name || message.u.username,
    ts: new Date(tsMs(message.ts)).toISOString(),
    text: stripAgentSessionMarker(message.msg).slice(0, 240),
    link: permalinkOf(message.rid, message._id),
  }));
  return {
    items,
    coverage: {
      complete: result.warnings.length === 0 && matching.length <= LIMIT,
      truncated: matching.length > LIMIT,
      returned: items.length,
      limit: LIMIT,
      roomsChecked: candidates.length,
      ...(since ? { since } : {}),
    },
    warnings: result.warnings,
  };
}

function listTodos(args: Record<string, unknown>): unknown {
  const query = optionalString(args, 'query');
  const includeDone = optionalBoolean(args, 'includeDone') ?? false;
  const matching = useTodos.getState().todos
    .filter((todo) => includeDone || !todo.done)
    .filter((todo) => matches(
      `${todo.note ?? ''} ${todo.excerpt ?? ''} ${todo.title ?? ''} ${todo.roomName ?? ''} ${todo.author ?? ''}`,
      query,
    ))
    .sort((left, right) => (left.due ?? '9999-12-31').localeCompare(right.due ?? '9999-12-31'));
  const items = matching.slice(0, LIMIT)
    .map((todo) => ({
      id: todo.id,
      text: todo.note || todo.excerpt || todo.title || '待办',
      due: todo.due,
      priority: todo.priority,
      roomName: todo.roomName,
      author: todo.author,
      waitingFor: todo.waitingFor,
      committedTo: todo.committedTo,
      done: todo.done,
      link: todo.rid && todo.mid ? permalinkOf(todo.rid, todo.mid) : undefined,
    }));
  return {
    items,
    coverage: {
      complete: matching.length <= LIMIT,
      truncated: matching.length > LIMIT,
      returned: items.length,
      limit: LIMIT,
    },
  };
}

function listCalendar(args: Record<string, unknown>): unknown {
  const query = optionalString(args, 'query');
  const dates = dateRange(optionalString(args, 'from'), optionalString(args, 'to'));
  const events = useCalendar.getState().events;
  const occurrences = dates
    ? dates.flatMap((date) => eventsForDate(events, date).map((event) => ({ event, date })))
    : events.map((event) => ({ event, date: event.date }));
  const matching = occurrences
    .filter(({ event, date }) => matches(`${event.title} ${event.description ?? ''} ${date}`, query))
    .sort((left, right) => `${left.date} ${left.event.startTime ?? ''}`.localeCompare(
      `${right.date} ${right.event.startTime ?? ''}`,
    ));
  const items = matching.slice(0, LIMIT)
    .map(({ event, date }) => ({
      id: event.id,
      title: event.title,
      date,
      startTime: event.startTime,
      endTime: event.endTime,
      allDay: event.allDay,
      done: isEventDone(event, date),
      description: event.description?.slice(0, 240),
      origin: event.origin,
    }));
  return {
    items,
    coverage: {
      complete: matching.length <= LIMIT,
      truncated: matching.length > LIMIT,
      returned: items.length,
      limit: LIMIT,
    },
  };
}

export async function executeRocketxDynamicTool(params: unknown): Promise<DynamicToolCallResponse> {
  const request = record(params);
  const tool = typeof request.tool === 'string' ? request.tool : '';
  const args = record(request.arguments);
  try {
    if (tool === 'list_mentions') return response(await listMentions(args));
    if (tool === 'list_todos') return response(listTodos(args));
    if (tool === 'list_calendar') return response(listCalendar(args));
    if (tool === 'list_scheduled_tasks') return response(await requireScheduledTaskAdapter().list());
    if (tool === 'create_scheduled_task') {
      return response(await requireScheduledTaskAdapter().create(scheduledTaskInput(args)));
    }
    if (tool === 'update_scheduled_task') {
      return response(await requireScheduledTaskAdapter().update(scheduledTaskPatch(args)));
    }
    if (tool === 'delete_scheduled_task') {
      return response(await requireScheduledTaskAdapter().remove(requiredString(args, 'id')));
    }
    if (tool === 'run_scheduled_task') {
      return response(await requireScheduledTaskAdapter().run(requiredString(args, 'id')));
    }
    if (tool === 'list_work_cards') {
      const ledger = useWorkLedger.getState();
      ledger.syncWithTodos();
      const stageFilter = optionalString(args, 'stage');
      const includeDone = optionalBoolean(args, 'includeDone') ?? false;
      const cards = useWorkLedger.getState().cards
        .filter((c) => (stageFilter ? c.state.stage === stageFilter : includeDone || c.state.stage !== 'done'))
        .slice(0, LIMIT)
        .map((c) => ({
          todoId: c.id,
          title: c.title,
          goal: c.state.goal,
          stage: c.state.stage,
          waitState: c.state.waitState,
          waitReason: c.state.waitReason,
          nextStep: c.state.nextStep,
          autonomyMode: c.state.autonomyMode,
          requirementsVersion: c.state.requirementsVersion ?? 0,
          contentVersion: c.state.contentVersion ?? 0,
          acceptance: c.state.acceptance,
          visibility: c.state.visibility,
          adoWorkItemId: c.adoWorkItemId,
          sessions: ledger.sessions
            .filter((s) => s.todoId === c.id)
            .map((s) => ({ id: s.id, runtime: s.runtime, controlMode: s.controlMode, workspaceRoot: s.workspaceRoot })),
          validEvidences: ledger.evidences.filter((e) => e.todoId === c.id && e.passed && !e.stale).length,
          completionGate: evaluateCardCompletionGate(c, ledger.evidences),
        }));
      return response({ items: cards, returned: cards.length });
    }
    if (tool === 'create_work_card') {
      const assertAccount = captureWorkLedgerAccount();
      const acceptance = Array.isArray(args.acceptance) ? args.acceptance.filter((item): item is string => typeof item === 'string' && !!item.trim()).map((item) => item.trim()) : [];
      if (!acceptance.length) throw new Error('持续跟进工作必须明确至少一项验收条件');
      const adoWorkItemId = typeof args.adoWorkItemId === 'number' && Number.isInteger(args.adoWorkItemId) && args.adoWorkItemId > 0 ? args.adoWorkItemId : undefined;
      const rid = optionalString(args, 'rid'); const mid = optionalString(args, 'mid');
      const card = await useWorkLedger.getState().createCard({ requestId: requiredString(args, 'requestId'), title: requiredString(args, 'title'), goal: requiredString(args, 'goal'), acceptance,
        boundaries: Array.isArray(args.boundaries) ? args.boundaries.filter((item): item is string => typeof item === 'string' && !!item.trim()) : [],
        ownerKind: 'ai_suggested', enroll: true, source: adoWorkItemId ? 'ado' : mid ? 'message' : 'manual', rid, mid, adoWorkItemId,
        adoProject: optionalString(args, 'adoProject'), projectKey: optionalString(args, 'projectKey') ?? optionalString(args, 'adoProject') ?? null,
      });
      const ledger = useWorkLedger.getState();
      assertAccount();
      const workspaceRoot = optionalString(args, 'workspaceRoot');
      if (workspaceRoot && !ledger.links.some((link) => link.todoId === card.id && link.kind === 'kanban_card' && link.externalId === card.id)) await ledger.upsertLink({ todoId: card.id, kind: 'kanban_card', externalId: card.id, project: card.state.projectKey, repo: workspaceRoot, rid: card.rid, headSha: null, title: '工作目录', webUrl: null, stateSnapshot: 'workspace' });
      assertAccount();
      if (card.adoWorkItemId) await ledger.upsertLink({ todoId: card.id, kind: 'ado_work_item', externalId: String(card.adoWorkItemId), project: card.adoProject, repo: null, rid: card.rid, headSha: null, title: card.title, webUrl: null, stateSnapshot: null });
      assertAccount();
      if (card.rid && card.mid) await ledger.upsertLink({ todoId: card.id, kind: 'message', externalId: card.mid, project: card.state.projectKey, repo: null, rid: card.rid, headSha: null, title: '来源消息', webUrl: null, stateSnapshot: null });
      assertAccount();
      return response({ card, completionGate: evaluateCardCompletionGate(card, ledger.evidences) });
    }
    if (tool === 'update_work_card') {
      const todoId = requiredString(args, 'todoId');
      const card = useWorkLedger.getState().cards.find((item) => item.id === todoId);
      if (!card) throw new Error('指定工作不存在');
      if (optionalString(args, 'stage') === 'done') await observeWorkArtifacts(todoId);
      const scopeChange = Object.hasOwn(args, 'goal') || Object.hasOwn(args, 'acceptance') || Object.hasOwn(args, 'boundaries') || optionalBoolean(args, 'rework') === true;
      if (scopeChange && (typeof args.expectedRequirementsVersion !== 'number' || !Number.isInteger(args.expectedRequirementsVersion) || args.expectedRequirementsVersion < 0)) throw new Error('修改工作要求前必须提供预读的 expectedRequirementsVersion');
      const updated = await useWorkLedger.getState().updateCard(todoId, {
        expectedRequirementsVersion: typeof args.expectedRequirementsVersion === 'number' ? args.expectedRequirementsVersion : card.state.requirementsVersion ?? 0,
        expectedContentVersion: typeof args.expectedContentVersion === 'number' ? args.expectedContentVersion : card.state.contentVersion ?? 0,
        ...(optionalString(args, 'stage') ? { stage: optionalString(args, 'stage') as WorkCardStage } : {}),
        ...(optionalString(args, 'waitState') ? { waitState: optionalString(args, 'waitState') as WorkCardWaitState } : {}),
        ...(optionalString(args, 'waitReason') ? { waitReason: optionalString(args, 'waitReason')! } : {}),
        ...(optionalString(args, 'nextStep') ? { nextStep: optionalString(args, 'nextStep')! } : {}),
        ...(optionalString(args, 'goal') ? { goal: optionalString(args, 'goal')! } : {}),
        ...(Array.isArray(args.acceptance) ? { acceptance: args.acceptance.filter((item): item is string => typeof item === 'string' && !!item.trim()) } : {}),
        ...(Array.isArray(args.boundaries) ? { boundaries: args.boundaries.filter((item): item is string => typeof item === 'string' && !!item.trim()) } : {}),
        ...(optionalBoolean(args, 'rework') ? { rework: true } : {}),
      });
      return response({ todoId: updated.id, stage: updated.state.stage, waitState: updated.state.waitState,
        requirementsVersion: updated.state.requirementsVersion ?? 0, contentVersion: updated.state.contentVersion ?? 0,
        completionGate: evaluateCardCompletionGate(updated, useWorkLedger.getState().evidences) });
    }
    if (tool === 'record_work_evidence') {
      const todoId = requiredString(args, 'todoId');
      const claimedKind = requiredString(args, 'kind');
      if (!['test_run', 'ci_build', 'pr_status', 'diff_check', 'agent_report'].includes(claimedKind)) throw new Error('Agent 不能登记人工接受或未知证据类型');
      const title = requiredString(args, 'title');
      const claimedPassed = optionalBoolean(args, 'passed') ?? true;
      const ev = await useWorkLedger.getState().addEvidence({
        todoId,
        sessionId: null,
        kind: 'agent_report',
        title,
        summary: `Agent 声明（未独立核对）：${claimedKind} / ${claimedPassed ? '声称通过' : '声称未通过'}。${optionalString(args, 'summary') ?? ''}`,
        headSha: optionalString(args, 'headSha') ?? null,
        workspaceRoot: null,
        webUrl: null,
        passed: false,
        criterionIds: Array.isArray(args.criterionIds) ? args.criterionIds.filter((item): item is string => typeof item === 'string' && !!item.trim()) : [],
        requirementsVersion: typeof args.requirementsVersion === 'number' && Number.isInteger(args.requirementsVersion) ? args.requirementsVersion : undefined,
        contentVersion: typeof args.contentVersion === 'number' && Number.isInteger(args.contentVersion) ? args.contentVersion : undefined,
      });
      return response({ evidenceId: ev.id, todoId: ev.todoId, kind: ev.kind, passed: ev.passed, stale: ev.stale, claimedKind, claimedPassed, verification: 'agent_statement_unverified' });
    }
    if (tool === 'verify_work_ci_evidence') {
      const buildId = args.buildId;
      const requirementsVersion = args.requirementsVersion;
      const contentVersion = args.contentVersion;
      if (typeof buildId !== 'number' || !Number.isInteger(buildId) || typeof requirementsVersion !== 'number' || !Number.isInteger(requirementsVersion) || typeof contentVersion !== 'number' || !Number.isInteger(contentVersion)) throw new Error('可信 CI 核对需要准确的构建 ID 和工作版本');
      const evidence = await verifyWorkCiEvidence({ workId: requiredString(args, 'todoId'), project: requiredString(args, 'project'), buildId, requirementsVersion, contentVersion,
        criterionIds: Array.isArray(args.criterionIds) ? args.criterionIds.filter((item): item is string => typeof item === 'string') : [] });
      return response({ evidence, verification: 'ado_build_api', scope: 'ci_status_only' });
    }
    if (tool === 'memory_search') {
      const query = optionalString(args, 'query');
      const category = optionalString(args, 'category') as ButlerMemoryCategory | undefined;
      const workspaceRoot = optionalString(args, 'workspaceRoot');
      const rawLimit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? args.limit : 6;
      const entries = await useButlerMemory.getState().recallRelevantMemories({
        query,
        category,
        workspaceRoot: workspaceRoot ?? null,
        limit: rawLimit,
      });
      return response({
        paused: useButlerMemory.getState().memoryPaused,
        returned: entries.length,
        items: entries.map((m) => ({
          id: m.id,
          category: m.category,
          title: m.title,
          content: m.content,
          tags: m.tags,
          workspaceRoot: m.workspaceRoot,
          pinned: m.pinned,
          recallCount: m.recallCount,
        })),
      });
    }
    if (tool === 'memory_save') {
      const category = requiredString(args, 'category') as ButlerMemoryCategory;
      const title = requiredString(args, 'title');
      const content = requiredString(args, 'content');
      const tags = Array.isArray(args.tags)
        ? args.tags.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
        : [];
      const saved = await useButlerMemory.getState().upsertMemory({
        category,
        title,
        content,
        tags,
        workspaceRoot: optionalString(args, 'workspaceRoot') ?? null,
        pinned: optionalBoolean(args, 'pinned') ?? false,
        sourceKind: 'conversation',
      });
      return response({
        id: saved.id,
        category: saved.category,
        title: saved.title,
        pinned: saved.pinned,
      });
    }
    if (tool === 'memory_delete') {
      const id = requiredString(args, 'id');
      const deleted = await useButlerMemory.getState().deleteMemory(id);
      return response({ id, deleted });
    }
    if (tool === 'assistant_daily_brief') {
      const rawKind = optionalString(args, 'kind') ?? 'focus_digest';
      const kind: PersonalAssistantBriefKind =
        rawKind === 'morning_brief' || rawKind === 'evening_review' || rawKind === 'focus_digest'
          ? rawKind
          : 'focus_digest';
      const snapshot = generatePersonalAssistantBrief(kind);
      const saveDigest = optionalBoolean(args, 'saveDigest') ?? false;
      const saved = saveDigest ? await saveAssistantSnapshotDigest(snapshot) : null;
      return response({
        kind: snapshot.kind,
        dateKey: snapshot.dateKey,
        title: snapshot.title,
        metrics: snapshot.metrics,
        focusItems: snapshot.focusItems,
        commitments: snapshot.commitments,
        actionItems: snapshot.actionItems,
        markdown: snapshot.markdown,
        ...(saved ? { digestId: saved.id } : {}),
      });
    }
    if (tool === 'workflow_report_generate') {
      const todoId = optionalString(args, 'todoId');
      const sessionKey = optionalString(args, 'sessionKey');
      const ledger = useWorkLedger.getState();
      const acpState = useAcpAgents.getState();
      const card = todoId ? ledger.cards.find((c) => c.id === todoId) ?? null : null;
      const acpSession = sessionKey
        ? acpState.sessions[sessionKey] ?? null
        : todoId
          ? Object.values(acpState.sessions).find((s) => s.linkedTodoId === todoId) ?? null
          : null;
      const report = buildWorkflowExecutionReport({
        card,
        acpSession,
        sessions: todoId ? ledger.sessions.filter((s) => s.todoId === todoId) : [],
        evidences: todoId ? ledger.evidences.filter((e) => e.todoId === todoId) : [],
        links: todoId ? ledger.links.filter((l) => l.todoId === todoId) : [],
      });
      if (optionalBoolean(args, 'recordEvidence') && todoId) {
        await recordReportAsWorkEvidence(todoId, report);
      }
      if (optionalBoolean(args, 'distillMemory')) {
        await distillReportToMemory(report);
      }
      return response(report);
    }
    if (tool === 'workflow_report_publish') {
      const todoId = requiredString(args, 'todoId');
      const ledger = useWorkLedger.getState();
      const card = ledger.cards.find((item) => item.id === todoId);
      if (!card) throw new Error('指定工作不存在');
      const acpSession = Object.values(useAcpAgents.getState().sessions).find((session) => session.linkedTodoId === todoId) ?? null;
      const report = buildWorkflowExecutionReport({ card, acpSession, sessions: ledger.sessions, evidences: ledger.evidences, links: ledger.links });
      const action = await publishWorkReport({ workId: todoId, rid: requiredString(args, 'rid'), reportId: requiredString(args, 'operationId'), reportTitle: report.title, reportGeneratedAt: report.generatedAt, markdown: report.markdown });
      return response({ action, deliveryConfirmed: action.state === 'acknowledged' || action.state === 'completed' });
    }
    if (tool === 'work_ado_state_sync') {
      const expectedRevision = args.expectedRevision;
      if (typeof expectedRevision !== 'number' || !Number.isInteger(expectedRevision) || expectedRevision <= 0) throw new Error('expectedRevision 必须是正整数');
      const action = await syncWorkAdoState({ workId: requiredString(args, 'todoId'), operationId: requiredString(args, 'operationId'), expectedRevision, expectedState: requiredString(args, 'expectedState'), targetState: requiredString(args, 'targetState') });
      return response({ action, syncConfirmed: action.state === 'acknowledged' || action.state === 'completed' });
    }
    if (tool === 'work_external_action_continue') {
      const action = await executePreparedExternalAction(requiredString(args, 'actionId'), false, optionalBoolean(args, 'retryReport'));
      return response({ action, deliveryConfirmed: action.state === 'acknowledged' || action.state === 'completed' });
    }
    if (tool === 'acp_list_agents') {
      const includeDisabled = optionalBoolean(args, 'includeDisabled') ?? true;
      const acpState = useAcpAgents.getState();
      const agents = acpState.agents.filter((a) => includeDisabled || a.enabled);
      return response({
        agents: agents.map((a) => ({
          id: a.id,
          name: a.name,
          preset: a.preset,
          command: a.command,
          args: a.args,
          enabled: a.enabled,
          autoApproveSafeReads: a.autoApproveSafeReads,
        })),
        discovered: acpState.discovered,
        activeSessions: Object.keys(acpState.sessions).length,
      });
    }
    if (tool === 'acp_dispatch_task') {
      const prompt = requiredString(args, 'prompt');
      const todoId = requiredString(args, 'todoId');
      const requestId = requiredString(args, 'requestId');
      const agentId = optionalString(args, 'agentId');
      const ledger = useWorkLedger.getState();
      const card = ledger.cards.find((item) => item.id === todoId);
      if (!card) throw new Error('正式委派需先用 create_work_card 纳入同一件工作');
      if (!card.state.goal?.trim() || !card.state.acceptance.length) throw new Error('请先明确工作目标和验收条件');
      const workspaceRoot = optionalString(args, 'workspaceRoot') ??
        ledger.links.find((link) => link.todoId === todoId && link.kind === 'kanban_card' && link.stateSnapshot === 'workspace')?.repo ??
        ledger.sessions.find((session) => session.todoId === todoId)?.workspaceRoot ?? '';
      const acp = useAcpAgents.getState();
      const targetAgent =
        (agentId ? acp.agents.find((a) => a.id === agentId) : undefined) ??
        acp.agents.find((a) => a.enabled);
      if (!targetAgent) {
        throw new Error('尚未配置或启用本地 ACP 客户端');
      }
      if (!workspaceRoot) {
        throw new Error('请提供工作区路径 workspaceRoot');
      }
      const specText = renderDispatchSpec({ title: card.title, goal: `${card.state.goal}\n本次推进要求：${prompt}`,
        acceptance: card.state.acceptance, boundaries: card.state.boundaries, evidence: card.note ? [{ label: '工作补充说明', text: card.note }] : [] });
      const action = await ledger.prepareDispatchAction({
        idempotencyKey: JSON.stringify(['acp-dispatch', todoId, requestId]), todoId, actionKind: 'session_create',
        specJson: JSON.stringify({ specText, runtime: 'acp', acpAgentId: targetAgent.id, repoRootOverride: workspaceRoot,
          isolateWorktree: optionalBoolean(args, 'isolateWorktree') ?? false,
          requirementsVersion: card.state.requirementsVersion ?? 0, contentVersion: card.state.contentVersion ?? 0 }),
        requireConfirmation: card.state.autonomyMode !== 'autonomous',
      });
      return response({ accepted: true, todoId, actionId: action.id, state: action.state, agentId: targetAgent.id,
        workspaceRoot, message: action.state === 'awaiting_approval' ? '工作已保留，等待本轮委派授权' : '工作已持久入队，后台将按可用资源执行；尚未宣告执行完成' });
    }
    if (tool === 'acp_session_status') {
      const sessionKey = optionalString(args, 'sessionKey');
      const sessions = useAcpAgents.getState().sessions;
      if (sessionKey) {
        const s = sessions[sessionKey];
        if (!s) throw new Error(`未找到 ACP 会话 ${sessionKey}`);
        return response({
          sessionKey: s.sessionKey,
          acpSessionId: s.acpSessionId,
          agentName: s.agentName,
          status: s.status,
          mode: s.modes?.currentModeId ?? null,
          plan: s.plan,
          pendingPermissions: s.pendingPermissions.length,
          toolCalls: s.toolCalls.length,
          lastMessage: s.messages.at(-1)?.text ?? '',
        });
      }
      return response({
        sessions: Object.values(sessions).map((s) => ({
          sessionKey: s.sessionKey,
          acpSessionId: s.acpSessionId,
          agentName: s.agentName,
          title: s.title,
          status: s.status,
          workspaceRoot: s.workspaceRoot,
          linkedTodoId: s.linkedTodoId,
          pendingPermissions: s.pendingPermissions.length,
        })),
      });
    }
    throw new Error(`RocketX 不支持动态工具 ${tool || 'unknown'}`);
  } catch (error) {
    return response({
      status: 'unavailable',
      message: error instanceof Error ? error.message : String(error),
    }, false);
  }
}
