import { tsMs } from '@rcx/rc-client';
import {
  defineButlerTool,
  type ButlerTool,
  type ButlerToolPreflight,
  type ButlerToolRuntimeContext,
} from './butlerToolRuntime';
import {
  listButlerQuarantinedLegacyMemory,
  listSkills,
  loadButlerSkill,
  readButlerActiveMemoryV2RawJson,
  writeButlerActiveMemoryV2RawJson,
} from './butlerProfile';
import {
  BUTLER_MEMORY_SCHEMA_VERSION,
  importLegacyButlerMemory,
  normalizeButlerMemoryScope,
  parseButlerMemoryState,
  recallButlerMemory,
  rememberButlerMemory,
  restoreButlerMemory,
  revokeButlerMemory,
  serializeButlerMemoryState,
  type ButlerMemoryKind,
  type ButlerMemoryProvenance,
  type ButlerMemoryRecord,
  type ButlerMemoryScope,
  type ButlerMemoryState,
} from './butlerMemory';
import { realtime, rest } from './client';
import {
  mergeMessageSearchResults,
  searchLoadedMessages,
  searchMessagesGlobal,
} from './quickSearch';
import { useAuth } from '../stores/auth';
import { useCalendar } from '../stores/calendar';
import { useChat } from '../stores/chat';
import { useTodos } from '../stores/todos';
import { myPrsOf, reviewPrsOf, useWorkbench } from '../stores/workbench';
import { useRoutines } from '../stores/routines';
import { stripAgentSessionMarker } from '../agent/card';

const LIMIT = 20;
const WORK_LIMIT = 100;

export interface ButlerRoutineDraft {
  checkpointId: string;
  name: string;
  time: string;
  days?: number[];
  skillName: string;
}

export interface ButlerMentionSnapshot {
  id: string;
  rid: string;
  roomName: string;
  sender: string;
  ts: string;
  text: string;
  processed: boolean;
}

let mentionProvider: () => ButlerMentionSnapshot[] = () => [];

export function setButlerMentionProvider(provider: () => ButlerMentionSnapshot[]): () => void {
  const previous = mentionProvider;
  mentionProvider = provider;
  return () => {
    mentionProvider = previous;
  };
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  return typeof args[key] === 'boolean' ? args[key] : undefined;
}

function matches(value: string, query: string | undefined): boolean {
  return !query || value.toLocaleLowerCase().includes(query.toLocaleLowerCase());
}

function localDate(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function roomNameFor(rid: string): string {
  const chat = useChat.getState();
  return chat.subscriptions[rid]?.fname || chat.subscriptions[rid]?.name || chat.rooms[rid]?.fname || chat.rooms[rid]?.name || rid;
}

async function searchMessages(args: Record<string, unknown>): Promise<string> {
  const query = optionalString(args, 'query');
  const from = optionalString(args, 'from');
  const roomName = optionalString(args, 'roomName');
  const since = optionalString(args, 'since');
  const until = optionalString(args, 'until');
  const hasFile = optionalBoolean(args, 'hasFile');
  const chat = useChat.getState();
  const roomIds = Object.keys(chat.subscriptions);
  const localMessages = query
    ? searchLoadedMessages(query, chat.messages, (rid) => !!chat.subscriptions[rid])
    : mergeMessageSearchResults(...Object.values(chat.messages));
  const remoteMessages = query
    ? await searchMessagesGlobal(
        query,
        roomIds,
        {
          provider: () => realtime.call('rocketchatSearch.getProvider'),
          global: (keyword, limit, searchAll) =>
            realtime.call(
              'rocketchatSearch.search',
              keyword,
              { uid: useAuth.getState().user?._id, rid: chat.activeRid ?? roomIds[0] ?? '' },
              { limit, searchAll },
            ),
          room: (rid, keyword, offset, count) => rest.searchMessages(rid, keyword, count, offset),
        },
        undefined,
        undefined,
        { searchAll: true },
      ).then((result) => result.messages).catch(() => [])
    : [];
  const rows = mergeMessageSearchResults(localMessages, remoteMessages)
    .filter((message) => {
      const timestamp = tsMs(message.ts);
      const date = localDate(timestamp);
      const sender = `${message.u.username} ${message.u.name ?? ''}`;
      return (
        matches(sender, from) &&
        matches(roomNameFor(message.rid), roomName) &&
        (!since || date >= since) &&
        (!until || date <= until) &&
        (hasFile === undefined || !!message.file === hasFile)
      );
    })
    .slice(0, LIMIT)
    .map((message) => ({
      _id: message._id,
      rid: message.rid,
      roomName: roomNameFor(message.rid),
      sender: message.u.name || message.u.username,
      ts: new Date(tsMs(message.ts)).toISOString(),
      text: stripAgentSessionMarker(message.msg).slice(0, 200),
    }));
  return JSON.stringify(rows);
}

function listMentions(): string {
  return JSON.stringify(mentionProvider().slice(0, LIMIT));
}

async function searchPeopleAndRooms(args: Record<string, unknown>): Promise<string> {
  const query = optionalString(args, 'query') ?? '';
  const found = await rest.spotlight(query);
  return JSON.stringify({
    users: found.users.slice(0, LIMIT).map((user) => ({
      id: user._id,
      username: user.username,
      name: user.name || user.username,
      status: user.status,
    })),
    rooms: found.rooms.slice(0, LIMIT).map((room) => ({
      id: room._id,
      name: room.fname || room.name || room._id,
      type: room.t,
    })),
  });
}

function listTodos(args: Record<string, unknown>): string {
  const query = optionalString(args, 'query');
  const includeDone = optionalBoolean(args, 'includeDone') ?? false;
  return JSON.stringify(
    useTodos.getState().todos
      .filter((todo) => includeDone || !todo.done)
      .filter((todo) =>
        matches(
          `${todo.note ?? ''} ${todo.excerpt ?? ''} ${todo.title ?? ''} ${todo.roomName ?? ''} ${todo.author ?? ''}`,
          query,
        ),
      )
      .slice(0, LIMIT)
      .map((todo) => ({
        id: todo.id,
        roomName: todo.roomName,
        author: todo.author,
        text: todo.note || todo.excerpt || todo.title,
        due: todo.due,
        done: todo.done,
      })),
  );
}

function listCalendar(args: Record<string, unknown>): string {
  const query = optionalString(args, 'query');
  const from = optionalString(args, 'from');
  const to = optionalString(args, 'to');
  return JSON.stringify(
    useCalendar.getState().events
      .filter((event) => matches(`${event.title} ${event.description ?? ''} ${event.date}`, query))
      .filter((event) => (!from || event.date >= from) && (!to || event.date <= to))
      .slice(0, LIMIT)
      .map((event) => ({
        id: event.id,
        title: event.title,
        date: event.date,
        startTime: event.startTime,
        endTime: event.endTime,
        description: event.description?.slice(0, 200),
      })),
  );
}

function listWorkItems(args: Record<string, unknown>): string {
  const query = optionalString(args, 'query');
  return JSON.stringify(
    useWorkbench.getState().workItems
      .filter((item) => matches(`#${item.id} ${item.title} ${item.type} ${item.state} ${item.project}`, query))
      .slice(0, WORK_LIMIT)
      .map((item) => ({
        id: item.id,
        title: item.title,
        type: item.type,
        state: item.state,
        project: item.project,
        assignedTo: item.assignedTo,
        priority: item.priority,
        dueDate: item.dueDate,
        changedDate: item.changedDate,
        webUrl: item.webUrl,
      })),
  );
}

function listPullRequests(args: Record<string, unknown>): string {
  const query = optionalString(args, 'query');
  const workbench = useWorkbench.getState();
  const account = workbench.config?.account ?? '';
  const reviewIds = new Set(reviewPrsOf(workbench.prs, account).map((pr) => pr.id));
  const mineIds = new Set(myPrsOf(workbench.prs, account).map((pr) => pr.id));
  return JSON.stringify(
    workbench.prs
      .filter((pr) => reviewIds.has(pr.id) || mineIds.has(pr.id))
      .filter((pr) => matches(`#${pr.id} ${pr.title} ${pr.repo} ${pr.creator}`, query))
      .slice(0, WORK_LIMIT)
      .map((pr) => ({
        id: pr.id,
        title: pr.title,
        repo: pr.repo,
        creator: pr.creator,
        sourceBranch: pr.sourceBranch,
        targetBranch: pr.targetBranch,
        createdDate: pr.createdDate,
        relation: reviewIds.has(pr.id) && mineIds.has(pr.id)
          ? 'both'
          : reviewIds.has(pr.id) ? 'review' : 'mine',
        project: pr.project,
        webUrl: pr.webUrl,
      })),
  );
}

function listBuilds(args: Record<string, unknown>): string {
  const query = optionalString(args, 'query');
  const failedOnly = optionalBoolean(args, 'failedOnly') ?? false;
  return JSON.stringify(
    useWorkbench.getState().builds
      .filter((build) => !failedOnly || build.result.toLocaleLowerCase() === 'failed')
      .filter((build) => matches(`${build.buildNumber} ${build.definition} ${build.project} ${build.result}`, query))
      .slice(0, WORK_LIMIT)
      .map((build) => ({
        id: build.id,
        buildNumber: build.buildNumber,
        definition: build.definition,
        project: build.project,
        status: build.status,
        result: build.result,
        requestedFor: build.requestedFor,
        finishTime: build.finishTime,
        webUrl: build.webUrl,
      })),
  );
}

function loadSkill(args: Record<string, unknown>): string {
  return loadButlerSkill(optionalString(args, 'name') ?? '');
}

type ButlerMemoryScopeLevel = 'account' | 'project' | 'room';

interface CapturedMemoryArgs extends Record<string, unknown> {
  trustedScope: ButlerMemoryScope;
  capturedProvenance: ButlerMemoryProvenance;
  capturedAt: number;
  expiresAtTimestamp?: number;
}

const MEMORY_KINDS = new Set<ButlerMemoryKind>(['alias', 'preference', 'commitment']);
const MEMORY_SCOPE_LEVELS = new Set<ButlerMemoryScopeLevel>(['account', 'project', 'room']);

function memoryKind(args: Record<string, unknown>): ButlerMemoryKind {
  const kind = optionalString(args, 'kind') as ButlerMemoryKind | undefined;
  if (!kind || !MEMORY_KINDS.has(kind)) throw new Error('记忆 kind 必须是 alias、preference 或 commitment。');
  return kind;
}

function memoryScopeLevel(args: Record<string, unknown>): ButlerMemoryScopeLevel {
  const level = optionalString(args, 'scope') as ButlerMemoryScopeLevel | undefined;
  if (!level || !MEMORY_SCOPE_LEVELS.has(level)) throw new Error('记忆 scope 必须是 account、project 或 room。');
  return level;
}

function trustedMemoryScope(
  context: ButlerToolRuntimeContext,
  level: ButlerMemoryScopeLevel,
): ButlerMemoryScope {
  const scope = context.scope;
  if (!scope?.server?.trim() || !scope.account?.trim()) {
    throw new Error('当前没有可验证的 Rocket.Chat server/account 上下文，不能访问长期记忆。');
  }
  if (level === 'project' && !scope.project?.trim()) {
    throw new Error('当前上下文没有唯一 project，不能使用 project 级记忆。');
  }
  if (level === 'room' && !scope.room?.trim()) {
    throw new Error('当前上下文没有 room，不能使用 room 级记忆。');
  }
  return normalizeButlerMemoryScope({
    server: scope.server,
    account: scope.account,
    ...(level === 'project' ? { project: scope.project! } : {}),
    ...(level === 'room' ? { room: scope.room! } : {}),
  });
}

function memoryProvenance(context: ButlerToolRuntimeContext): ButlerMemoryProvenance {
  const sources = (context.sources ?? []).slice(0, 8);
  const sourceRefs = sources.map((source) => [
    `${source.kind}:${source.id}`,
    source.rid ? `rid=${source.rid}` : '',
    source.project ? `project=${source.project}` : '',
  ].filter(Boolean).join('@'));
  return {
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    ...(context.taskId ? { taskId: context.taskId } : {}),
    ...(context.callId ? { callId: context.callId } : {}),
    butlerSource: sourceRefs.join(',') || 'butler:user-confirmed',
    summary: sourceRefs.length
      ? `来自当前 Butler 任务的 ${sourceRefs.length} 个可信来源引用`
      : '用户在当前 Butler 会话中直接确认',
  };
}

function captureMemoryArgs(
  args: Record<string, unknown>,
  context: ButlerToolRuntimeContext,
): CapturedMemoryArgs {
  const level = memoryScopeLevel(args);
  const capturedAt = context.now?.() ?? Date.now();
  const expiresAt = optionalString(args, 'expiresAt');
  const expiresAtTimestamp = expiresAt ? Date.parse(expiresAt) : undefined;
  if (expiresAt && !Number.isFinite(expiresAtTimestamp)) {
    throw new Error('expiresAt 必须是有效的 ISO 日期时间。');
  }
  if (expiresAtTimestamp !== undefined && expiresAtTimestamp <= capturedAt) {
    throw new Error('expiresAt 必须晚于当前时间。');
  }
  return {
    ...args,
    trustedScope: trustedMemoryScope(context, level),
    capturedProvenance: memoryProvenance(context),
    capturedAt,
    ...(expiresAtTimestamp === undefined ? {} : { expiresAtTimestamp }),
  };
}

function capturedMemoryArgs(args: Record<string, unknown>): CapturedMemoryArgs {
  const captured = args as Partial<CapturedMemoryArgs>;
  if (!captured.trustedScope || !captured.capturedProvenance || !Number.isFinite(captured.capturedAt)) {
    throw new Error('记忆工具缺少可信 scope/provenance 快照。');
  }
  return captured as CapturedMemoryArgs;
}

function memoryApprovalTimestamp(
  captured: CapturedMemoryArgs,
  context: ButlerToolRuntimeContext,
): number {
  const approvedAt = context.now?.() ?? Date.now();
  if (captured.expiresAtTimestamp !== undefined && captured.expiresAtTimestamp <= approvedAt) {
    throw new Error('expiresAt 已在审批前到期，请重新提交记忆。');
  }
  return approvedAt;
}

function loadMemoryState(): ButlerMemoryState {
  return parseButlerMemoryState(readButlerActiveMemoryV2RawJson() ?? '');
}

function saveMemoryState(state: ButlerMemoryState): void {
  writeButlerActiveMemoryV2RawJson(serializeButlerMemoryState(state));
}

function scopeLabel(scope: ButlerMemoryScope): string {
  if (scope.room) return `room:${scope.room}${scope.project ? ` / project:${scope.project}` : ''}`;
  if (scope.project) return `project:${scope.project}`;
  return `account:${scope.account} @ ${scope.server}`;
}

function isoTimestamp(value: number | null | undefined): string | null {
  return value == null ? null : new Date(value).toISOString();
}

function memoryRecordView(record: ButlerMemoryRecord): Record<string, unknown> {
  return {
    id: record.id,
    kind: record.kind,
    status: record.status,
    scope: record.scope,
    subject: record.subject,
    value: record.value,
    ...(record.due ? { due: record.due } : {}),
    confidence: record.confidence,
    createdAt: isoTimestamp(record.createdAt),
    confirmedAt: isoTimestamp(record.confirmedAt),
    expiresAt: isoTimestamp(record.expiresAt),
    provenance: record.provenance,
    supersedes: record.supersedes,
    ...(record.supersededBy ? { supersededBy: record.supersededBy } : {}),
    ...(record.revokedAt ? { revokedAt: isoTimestamp(record.revokedAt) } : {}),
    ...(record.restoredFrom ? { restoredFrom: record.restoredFrom } : {}),
  };
}

function recallMemory(args: Record<string, unknown>): string {
  const captured = capturedMemoryArgs(args);
  const includeHistory = optionalBoolean(args, 'includeHistory') ?? false;
  const limitValue = args.limit;
  const limit = typeof limitValue === 'number' && Number.isFinite(limitValue)
    ? Math.max(1, Math.min(100, Math.trunc(limitValue)))
    : LIMIT;
  const kindValue = optionalString(args, 'kind');
  const kind = kindValue ? memoryKind(args) : undefined;
  const active = recallButlerMemory(loadMemoryState(), captured.trustedScope, {
    query: optionalString(args, 'query'),
    limit,
    now: captured.capturedAt,
    ...(kind ? { kind } : {}),
    includeHistory,
  }).map(memoryRecordView);
  const legacy = optionalBoolean(args, 'includeLegacy')
    ? listButlerQuarantinedLegacyMemory().slice(0, limit).map((entry) => ({
        id: entry.id,
        status: 'quarantined',
        confidence: 'legacy-unverified',
        text: entry.text,
        at: isoTimestamp(entry.at),
      }))
    : [];
  return JSON.stringify({
    schemaVersion: BUTLER_MEMORY_SCHEMA_VERSION,
    scope: captured.trustedScope,
    records: active,
    ...(legacy.length ? { quarantinedLegacy: legacy } : {}),
  });
}

function writeInput(
  args: Record<string, unknown>,
  checkpointId?: string,
  writeAt?: number,
) {
  const captured = capturedMemoryArgs(args);
  const confirmedAt = writeAt ?? captured.capturedAt;
  return {
    kind: memoryKind(args),
    scope: captured.trustedScope,
    subject: optionalString(args, 'subject') ?? '',
    value: optionalString(args, 'value') ?? '',
    ...(optionalString(args, 'due') ? { due: optionalString(args, 'due') } : {}),
    provenance: {
      ...captured.capturedProvenance,
      ...(checkpointId ? { checkpointId } : {}),
    },
    createdAt: confirmedAt,
    confirmedAt,
    expiresAt: captured.expiresAtTimestamp ?? null,
  };
}

function rememberPreflight(args: Record<string, unknown>): ButlerToolPreflight {
  const captured = capturedMemoryArgs(args);
  const result = rememberButlerMemory(
    loadMemoryState(),
    writeInput(args),
    { now: captured.capturedAt, createId: () => '__memory-preview__' },
  );
  const action = result.created
    ? result.record.supersedes.length
      ? `更新并替代 ${result.record.supersedes.length} 条冲突记忆`
      : '写入长期记忆'
    : '确认已存在的相同记忆';
  return {
    allowed: true,
    preview: `${action}（${scopeLabel(captured.trustedScope)}）：${result.record.kind} · ${result.record.subject} = ${result.record.value}`,
  };
}

function scopedRecord(args: Record<string, unknown>): ButlerMemoryRecord | undefined {
  const captured = capturedMemoryArgs(args);
  const state = loadMemoryState();
  const id = optionalString(args, 'id');
  if (!id) return undefined;
  return recallButlerMemory(state, captured.trustedScope, {
    includeHistory: true,
    limit: Math.max(1, state.records.length),
    now: captured.capturedAt,
  }).find((record) => record.id === id);
}

function revokePreflight(args: Record<string, unknown>): ButlerToolPreflight {
  const record = scopedRecord(args);
  if (!record) return { allowed: false, reason: '当前 scope 内未找到该记忆。' };
  if (record.status !== 'active') return { allowed: false, reason: `该记忆当前状态为 ${record.status}，不能撤销。` };
  return {
    allowed: true,
    preview: `撤销长期记忆（${scopeLabel(record.scope)}）：${record.kind} · ${record.subject} = ${record.value}`,
  };
}

function restorePreflight(args: Record<string, unknown>): ButlerToolPreflight {
  const record = scopedRecord(args);
  if (!record) return { allowed: false, reason: '当前 scope 内未找到该记忆。' };
  if (record.status === 'active') return { allowed: false, reason: '该记忆仍处于 active，无需恢复。' };
  return {
    allowed: true,
    preview: `恢复长期记忆（${scopeLabel(record.scope)}）：${record.kind} · ${record.subject} = ${record.value}`,
  };
}

function quarantinedLegacy(args: Record<string, unknown>) {
  const legacyId = optionalString(args, 'legacyId');
  return listButlerQuarantinedLegacyMemory().find((entry) => entry.id === legacyId);
}

function importLegacyPreflight(args: Record<string, unknown>): ButlerToolPreflight {
  const captured = capturedMemoryArgs(args);
  const legacy = quarantinedLegacy(args);
  if (!legacy) return { allowed: false, reason: '隔离区中未找到该 legacy 记忆。' };
  const results = importLegacyButlerMemory(loadMemoryState(), [legacy], {
    now: captured.capturedAt,
    createId: () => '__legacy-preview__',
    mapLegacy: () => ({
      scope: captured.trustedScope,
      kind: memoryKind(args),
      subject: optionalString(args, 'subject') ?? '',
      value: optionalString(args, 'value') ?? '',
      ...(optionalString(args, 'due') ? { due: optionalString(args, 'due') } : {}),
      provenance: {
        ...captured.capturedProvenance,
        butlerSource: `legacy-v1:${legacy.id}`,
        summary: `用户显式导入隔离记忆 ${legacy.id}`,
      },
      expiresAt: captured.expiresAtTimestamp ?? null,
    }),
  });
  const record = results.at(-1)?.record;
  if (!record) return { allowed: false, reason: 'legacy 记忆内容无效，不能导入。' };
  return {
    allowed: true,
    preview: `显式导入隔离记忆（${scopeLabel(record.scope)}，legacy-unverified）：${record.kind} · ${record.subject} = ${record.value}`,
  };
}

function validTime(time: string): boolean {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  return !!match && Number(match[1]) < 24 && Number(match[2]) < 60;
}

function routinePreflight(args: Record<string, unknown>): ButlerToolPreflight {
  const name = optionalString(args, 'name');
  const time = optionalString(args, 'time');
  const skillName = optionalString(args, 'skillName');
  if (!name) return { allowed: false, reason: '例行事务名称不能为空。' };
  if (!time || !validTime(time)) return { allowed: false, reason: '时间格式无效，请使用 HH:mm。' };
  if (!skillName || !listSkills().some((skill) => skill.name === skillName)) {
    return { allowed: false, reason: `未找到技能：${skillName ?? '（未填写）'}。` };
  }
  const days = args.days;
  if (days !== undefined && (!Array.isArray(days) || days.some((day) => !Number.isInteger(day) || day < 0 || day > 6))) {
    return { allowed: false, reason: '星期必须是 0 到 6 的数字数组。' };
  }
  const dayLabel = Array.isArray(days) && days.length
    ? days.map((day) => `周${'日一二三四五六'[Number(day)]}`).join('、')
    : '每天';
  return {
    allowed: true,
    preview: `创建并启用例行事务「${name}」：${time} · ${dayLabel} · 技能 ${skillName}`,
  };
}

const searchMessagesParameters: Record<string, unknown> = {
  type: 'object',
  properties: {
    query: { type: 'string', description: '消息关键词；省略时仅筛选本地已加载消息。' },
    from: { type: 'string', description: '发送人用户名或显示名的子串。' },
    roomName: { type: 'string', description: '房间名称的子串。' },
    since: { type: 'string', description: '起始日期，YYYY-MM-DD，包含当天。' },
    until: { type: 'string', description: '结束日期，YYYY-MM-DD，包含当天。' },
    hasFile: { type: 'boolean', description: 'true 仅含文件消息；false 仅不含文件消息。' },
  },
  additionalProperties: false,
};

function queryParameters(description: string): Record<string, unknown> {
  return {
    type: 'object',
    properties: { query: { type: 'string', description } },
    additionalProperties: false,
  };
}

const memoryScopeParameter = {
  type: 'string',
  enum: ['account', 'project', 'room'],
  description: '显式记忆范围。server/account 始终由 RocketX 可信上下文提供；project/room 也只能取当前上下文。',
};

const memoryKindParameter = {
  type: 'string',
  enum: ['alias', 'preference', 'commitment'],
  description: '长期记忆类型：别名、偏好或已确认承诺。',
};

const memoryWriteProperties = {
  kind: memoryKindParameter,
  scope: memoryScopeParameter,
  subject: { type: 'string', description: '稳定的记忆主题或冲突键，例如 reply-style 或 u:zhangsan。' },
  value: { type: 'string', description: '要保存的值；不得包含可查询的动态工作状态。' },
  due: { type: 'string', description: '仅 commitment 可用的到期描述。' },
  expiresAt: { type: 'string', description: '可选 ISO 日期时间；到期后默认不再召回。' },
};

export function createButlerTools(): ButlerTool[] {
  return [
    defineButlerTool({
      name: 'search_messages',
      description: '搜索消息，可按发送人、房间、日期范围和是否有文件筛选；返回最多 20 条消息摘要。',
      parameters: searchMessagesParameters,
      effect: 'read',
      capability: 'rocket-chat.messages.read',
      execute: searchMessages,
    }),
    defineButlerTool({
      name: 'list_mentions',
      description: '列出当前 @我 收件箱中的消息及是否已处理；返回最多 20 条。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      effect: 'read',
      capability: 'rocket-chat.messages.read',
      execute: async () => listMentions(),
    }),
    defineButlerTool({
      name: 'search_people_rooms',
      description: '搜索 Rocket.Chat 中的用户和房间，query 为要匹配的姓名、用户名或房间名。',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '姓名、用户名或房间名关键词。' } },
        required: ['query'],
        additionalProperties: false,
      },
      effect: 'read',
      capability: 'rocket-chat.directory.read',
      execute: searchPeopleAndRooms,
    }),
    defineButlerTool({
      name: 'list_todos',
      description: '列出本地待办；默认只返回未完成项，可按关键词筛选或包含已完成项。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '待办正文、房间或作者关键词。' },
          includeDone: { type: 'boolean', description: '是否包含已完成待办，默认 false。' },
        },
        additionalProperties: false,
      },
      effect: 'read',
      capability: 'todos.read',
      execute: async (args) => listTodos(args),
    }),
    defineButlerTool({
      name: 'list_calendar',
      description: '列出本地日程，可按关键词和 YYYY-MM-DD 日期范围筛选。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '日程标题或描述关键词。' },
          from: { type: 'string', description: '起始日期，YYYY-MM-DD，包含当天。' },
          to: { type: 'string', description: '结束日期，YYYY-MM-DD，包含当天。' },
        },
        additionalProperties: false,
      },
      effect: 'read',
      capability: 'calendar.read',
      execute: async (args) => listCalendar(args),
    }),
    defineButlerTool({
      name: 'list_work_items',
      description: '列出已加载的 Azure DevOps 工作项，可按编号、标题、类型、状态或项目筛选；返回最多 100 条。',
      parameters: queryParameters('工作项编号、标题、类型、状态或项目关键词。'),
      effect: 'read',
      capability: 'ado.work-items.read',
      execute: async (args) => listWorkItems(args),
    }),
    defineButlerTool({
      name: 'list_pull_requests',
      description: '列出已加载的待我评审或我提的 Azure DevOps 拉取请求，可按编号、标题、仓库或创建者筛选；返回最多 100 条。',
      parameters: queryParameters('拉取请求编号、标题、仓库或创建者关键词。'),
      effect: 'read',
      capability: 'ado.pull-requests.read',
      execute: async (args) => listPullRequests(args),
    }),
    defineButlerTool({
      name: 'list_builds',
      description: '列出已加载的 Azure DevOps 构建，可按关键词筛选，也可只看失败构建；返回最多 100 条。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '构建号、定义、项目或结果关键词。' },
          failedOnly: { type: 'boolean', description: '是否只返回失败构建，默认 false。' },
        },
        additionalProperties: false,
      },
      effect: 'read',
      capability: 'ado.builds.read',
      execute: async (args) => listBuilds(args),
    }),
    defineButlerTool({
      name: 'recall_memory',
      description: '在当前可信 server/account 下按显式 scope 召回 alias、偏好和已确认承诺；不会跨账号或 sibling project/room。',
      parameters: {
        type: 'object',
        properties: {
          scope: memoryScopeParameter,
          query: { type: 'string', description: '主题、值或承诺到期描述的关键词；省略时返回该 scope 的最近记忆。' },
          kind: memoryKindParameter,
          limit: { type: 'integer', description: '最多返回多少条，默认 20，最大 100。' },
          includeHistory: { type: 'boolean', description: '是否显式包含 superseded/revoked/已过期历史，默认 false。' },
          includeLegacy: { type: 'boolean', description: '是否显式查看尚未导入的 v1 隔离区，默认 false。' },
        },
        required: ['scope'],
        additionalProperties: false,
      },
      effect: 'read',
      capability: 'memory.read',
      capture: captureMemoryArgs,
      execute: async (args) => recallMemory(args),
    }),
    defineButlerTool({
      name: 'load_skill',
      description: '按名称加载技能的方法论正文。',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: '技能名称。' } },
        required: ['name'],
        additionalProperties: false,
      },
      effect: 'read',
      capability: 'skills.read',
      execute: async (args) => loadSkill(args),
    }),
    defineButlerTool({
      name: 'remember',
      description: '为 alias、偏好或已确认承诺生成 scoped v2 长期记忆草案；必须等用户在 RocketX 中确认后才写入。',
      parameters: {
        type: 'object',
        properties: memoryWriteProperties,
        required: ['kind', 'scope', 'subject', 'value'],
        additionalProperties: false,
      },
      effect: 'write',
      capability: 'memory.write',
      capture: captureMemoryArgs,
      idempotencyKey: (args) => {
        const captured = capturedMemoryArgs(args);
        return JSON.stringify({
          schemaVersion: BUTLER_MEMORY_SCHEMA_VERSION,
          action: 'remember',
          kind: memoryKind(args),
          scope: captured.trustedScope,
          subject: optionalString(args, 'subject')?.toLocaleLowerCase() ?? '',
          value: optionalString(args, 'value') ?? '',
          due: optionalString(args, 'due') ?? null,
          expiresAt: captured.expiresAtTimestamp ?? null,
        });
      },
      preflight: rememberPreflight,
      execute: async (args, { checkpoint, context }) => {
        const captured = capturedMemoryArgs(args);
        const approvedAt = memoryApprovalTimestamp(captured, context);
        const result = rememberButlerMemory(
          loadMemoryState(),
          writeInput(args, checkpoint.id, approvedAt),
          { now: approvedAt },
        );
        if (result.created) saveMemoryState(result.state);
        return result.created
          ? `已记录 ${result.record.kind} 记忆（${scopeLabel(captured.trustedScope)}）：${result.record.subject} = ${result.record.value}`
          : `相同 ${result.record.kind} 记忆已存在（${scopeLabel(captured.trustedScope)}）：${result.record.subject} = ${result.record.value}`;
      },
    }),
    defineButlerTool({
      name: 'revoke_memory',
      description: '生成撤销 scoped 长期记忆的草案；只改变状态，不硬删除记录。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '要撤销的 v2 记忆 id。' },
          scope: memoryScopeParameter,
        },
        required: ['id', 'scope'],
        additionalProperties: false,
      },
      effect: 'write',
      capability: 'memory.write',
      capture: captureMemoryArgs,
      idempotencyKey: (args) => JSON.stringify({
        schemaVersion: BUTLER_MEMORY_SCHEMA_VERSION,
        action: 'revoke',
        scope: capturedMemoryArgs(args).trustedScope,
        id: optionalString(args, 'id') ?? '',
      }),
      preflight: revokePreflight,
      execute: async (args, { context }) => {
        const state = loadMemoryState();
        const id = optionalString(args, 'id') ?? '';
        const target = scopedRecord(args);
        if (!target) throw new Error('当前 scope 内未找到该记忆。');
        const result = revokeButlerMemory(state, id, { now: context.now?.() ?? Date.now() });
        if (!result || result.record.status !== 'revoked') throw new Error('该记忆不能撤销。');
        saveMemoryState(result.state);
        return `已撤销 ${result.record.kind} 记忆（${scopeLabel(result.record.scope)}）：${result.record.subject}`;
      },
    }),
    defineButlerTool({
      name: 'restore_memory',
      description: '生成恢复 superseded/revoked scoped 长期记忆的草案；恢复会新建 active 记录并保留历史。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '要恢复的历史 v2 记忆 id。' },
          scope: memoryScopeParameter,
        },
        required: ['id', 'scope'],
        additionalProperties: false,
      },
      effect: 'write',
      capability: 'memory.write',
      capture: captureMemoryArgs,
      idempotencyKey: (args) => JSON.stringify({
        schemaVersion: BUTLER_MEMORY_SCHEMA_VERSION,
        action: 'restore',
        scope: capturedMemoryArgs(args).trustedScope,
        id: optionalString(args, 'id') ?? '',
      }),
      preflight: restorePreflight,
      execute: async (args, { checkpoint, context }) => {
        const state = loadMemoryState();
        const target = scopedRecord(args);
        if (!target) throw new Error('当前 scope 内未找到该记忆。');
        const captured = capturedMemoryArgs(args);
        const result = restoreButlerMemory(state, target.id, {
          now: context.now?.() ?? Date.now(),
          provenance: {
            ...captured.capturedProvenance,
            checkpointId: checkpoint.id,
          },
        });
        saveMemoryState(result.state);
        return `已恢复 ${result.record.kind} 记忆（${scopeLabel(result.record.scope)}）：${result.record.subject} = ${result.record.value}`;
      },
    }),
    defineButlerTool({
      name: 'import_legacy_memory',
      description: '把一条显式选择的 v1 隔离记忆映射成 scoped v2 记录；导入后仍标记 legacy-unverified。',
      parameters: {
        type: 'object',
        properties: {
          legacyId: { type: 'string', description: 'recall_memory(includeLegacy=true) 返回的隔离记忆 id。' },
          ...memoryWriteProperties,
        },
        required: ['legacyId', 'kind', 'scope', 'subject', 'value'],
        additionalProperties: false,
      },
      effect: 'write',
      capability: 'memory.write',
      capture: captureMemoryArgs,
      idempotencyKey: (args) => JSON.stringify({
        schemaVersion: BUTLER_MEMORY_SCHEMA_VERSION,
        action: 'import-legacy',
        legacyId: optionalString(args, 'legacyId') ?? '',
        kind: memoryKind(args),
        scope: capturedMemoryArgs(args).trustedScope,
        subject: optionalString(args, 'subject')?.toLocaleLowerCase() ?? '',
        value: optionalString(args, 'value') ?? '',
        due: optionalString(args, 'due') ?? null,
        expiresAt: capturedMemoryArgs(args).expiresAtTimestamp ?? null,
      }),
      preflight: importLegacyPreflight,
      execute: async (args, { checkpoint, context }) => {
        const legacy = quarantinedLegacy(args);
        if (!legacy) throw new Error('隔离区中未找到该 legacy 记忆。');
        const captured = capturedMemoryArgs(args);
        const approvedAt = memoryApprovalTimestamp(captured, context);
        const results = importLegacyButlerMemory(loadMemoryState(), [legacy], {
          now: approvedAt,
          mapLegacy: () => ({
            scope: captured.trustedScope,
            kind: memoryKind(args),
            subject: optionalString(args, 'subject') ?? '',
            value: optionalString(args, 'value') ?? '',
            ...(optionalString(args, 'due') ? { due: optionalString(args, 'due') } : {}),
            provenance: {
              ...captured.capturedProvenance,
              checkpointId: checkpoint.id,
              butlerSource: `legacy-v1:${legacy.id}`,
              summary: `用户显式导入隔离记忆 ${legacy.id}`,
            },
            expiresAt: captured.expiresAtTimestamp ?? null,
          }),
        });
        const result = results.at(-1);
        if (!result) throw new Error('legacy 记忆内容无效，不能导入。');
        if (result.created) saveMemoryState(result.state);
        return result.created
          ? `已导入 legacy-unverified 记忆（${scopeLabel(result.record.scope)}）：${result.record.subject} = ${result.record.value}`
          : `相同 legacy-unverified 记忆已存在（${scopeLabel(result.record.scope)}）：${result.record.subject} = ${result.record.value}`;
      },
    }),
    defineButlerTool({
      name: 'draft_routine',
      description: '用户要求定期、每天或每周做某事时调用；只生成可见审批草案，用户确认后才创建并启用。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '例行事务名称。' },
          time: { type: 'string', description: '触发时间，HH:mm。' },
          days: { type: 'array', items: { type: 'number' }, description: '星期数组，0 为周日到 6 为周六；省略表示每天。' },
          skillName: { type: 'string', description: '要执行的已注册技能名称。' },
        },
        required: ['name', 'time', 'skillName'],
        additionalProperties: false,
      },
      effect: 'write',
      capability: 'routines.write',
      preflight: routinePreflight,
      execute: async (args, { checkpoint, context }) => {
        const name = optionalString(args, 'name')!;
        const time = optionalString(args, 'time')!;
        const skillName = optionalString(args, 'skillName')!;
        useRoutines.getState().addRoutine({
          id: checkpoint.id,
          name,
          trigger: { kind: 'daily', time, days: args.days as number[] | undefined },
          skillName,
          delivery: 'today',
          enabled: true,
          createdAt: context.now?.() ?? Date.now(),
          runs: [],
        });
        return `已创建并启用例行事务：${name}`;
      },
    }),
  ];
}
