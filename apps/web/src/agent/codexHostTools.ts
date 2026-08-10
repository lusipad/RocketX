import { tsMs } from '@rcx/rc-client';
import { collectMentionInbox } from '../lib/mentionInbox';
import { rest } from '../lib/client';
import { useAuth } from '../stores/auth';
import { eventsForDate, isEventDone, useCalendar } from '../stores/calendar';
import { permalinkOf, useChat } from '../stores/chat';
import { useTodos } from '../stores/todos';
import { stripAgentSessionMarker } from './card';
import type { DynamicToolCallResponse } from './protocol/generated/v2/DynamicToolCallResponse';
import type { DynamicToolSpec } from './protocol/generated/v2/DynamicToolSpec';
import {
  requireScheduledTaskAdapter,
  type ScheduledTaskInput,
  type ScheduledTaskPatch,
} from './scheduledTaskBridge';

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
    throw new Error(`RocketX 不支持动态工具 ${tool || 'unknown'}`);
  } catch (error) {
    return response({
      status: 'unavailable',
      message: error instanceof Error ? error.message : String(error),
    }, false);
  }
}
