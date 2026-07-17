import { tsMs } from '@rcx/rc-client';
import type { ButlerTool } from '../kernel/ai/agent-loop';
import { loadButlerSkill, rememberButlerFact } from './butlerProfile';
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
import { useWorkbench } from '../stores/workbench';

const LIMIT = 20;

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
      text: message.msg.slice(0, 200),
    }));
  return JSON.stringify(rows);
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
      .filter((todo) => matches(`${todo.note ?? ''} ${todo.excerpt} ${todo.roomName} ${todo.author}`, query))
      .slice(0, LIMIT)
      .map((todo) => ({
        id: todo.id,
        roomName: todo.roomName,
        author: todo.author,
        text: todo.note || todo.excerpt,
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
      .slice(0, LIMIT)
      .map((item) => ({
        id: item.id,
        title: item.title,
        type: item.type,
        state: item.state,
        project: item.project,
        assignedTo: item.assignedTo,
        changedDate: item.changedDate,
      })),
  );
}

function listPullRequests(args: Record<string, unknown>): string {
  const query = optionalString(args, 'query');
  return JSON.stringify(
    useWorkbench.getState().prs
      .filter((pr) => matches(`#${pr.id} ${pr.title} ${pr.repo} ${pr.creator}`, query))
      .slice(0, LIMIT)
      .map((pr) => ({
        id: pr.id,
        title: pr.title,
        repo: pr.repo,
        creator: pr.creator,
        sourceBranch: pr.sourceBranch,
        targetBranch: pr.targetBranch,
        createdDate: pr.createdDate,
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
      .slice(0, LIMIT)
      .map((build) => ({
        id: build.id,
        buildNumber: build.buildNumber,
        definition: build.definition,
        project: build.project,
        status: build.status,
        result: build.result,
        requestedFor: build.requestedFor,
        finishTime: build.finishTime,
      })),
  );
}

function loadSkill(args: Record<string, unknown>): string {
  return loadButlerSkill(optionalString(args, 'name') ?? '');
}

function remember(args: Record<string, unknown>): string {
  return rememberButlerFact(optionalString(args, 'fact') ?? '');
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

export function createButlerTools(): ButlerTool[] {
  return [
    {
      name: 'search_messages',
      description: '搜索消息，可按发送人、房间、日期范围和是否有文件筛选；返回最多 20 条消息摘要。',
      parameters: searchMessagesParameters,
      execute: searchMessages,
    },
    {
      name: 'search_people_rooms',
      description: '搜索 Rocket.Chat 中的用户和房间，query 为要匹配的姓名、用户名或房间名。',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '姓名、用户名或房间名关键词。' } },
        required: ['query'],
        additionalProperties: false,
      },
      execute: searchPeopleAndRooms,
    },
    {
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
      execute: async (args) => listTodos(args),
    },
    {
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
      execute: async (args) => listCalendar(args),
    },
    {
      name: 'list_work_items',
      description: '列出已加载的 Azure DevOps 工作项，可按编号、标题、类型、状态或项目筛选。',
      parameters: queryParameters('工作项编号、标题、类型、状态或项目关键词。'),
      execute: async (args) => listWorkItems(args),
    },
    {
      name: 'list_pull_requests',
      description: '列出已加载的 Azure DevOps 拉取请求，可按编号、标题、仓库或创建者筛选。',
      parameters: queryParameters('拉取请求编号、标题、仓库或创建者关键词。'),
      execute: async (args) => listPullRequests(args),
    },
    {
      name: 'list_builds',
      description: '列出已加载的 Azure DevOps 构建，可按关键词筛选，也可只看失败构建。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '构建号、定义、项目或结果关键词。' },
          failedOnly: { type: 'boolean', description: '是否只返回失败构建，默认 false。' },
        },
        additionalProperties: false,
      },
      execute: async (args) => listBuilds(args),
    },
    {
      name: 'load_skill',
      description: '按名称加载技能的方法论正文。',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: '技能名称。' } },
        required: ['name'],
        additionalProperties: false,
      },
      execute: async (args) => loadSkill(args),
    },
    {
      name: 'remember',
      description: '当用户告诉你一个应长期记住的事实（偏好、别名、纠错、承诺）时调用；不要存储能从数据里查到的内容。',
      parameters: {
        type: 'object',
        properties: { fact: { type: 'string', description: '要长期记住的事实。' } },
        required: ['fact'],
        additionalProperties: false,
      },
      execute: async (args) => remember(args),
    },
  ];
}
