import {
  Bot,
  BriefcaseBusiness,
  CalendarDays,
  Contact,
  ExternalLink,
  Hash,
  Loader2,
  MessageSquare,
  Search,
  Send,
  SquareCheckBig,
  TerminalSquare,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import CreateWorkItemDialog from '../components/CreateWorkItemDialog';
import { fallbackAssistantCommand, isAssistantWorkCommand, type AssistantCommand } from '../lib/assistantCommand';
import { getServerBase, openExternal, realtime, rest } from '../lib/client';
import { renderMarkdown } from '../lib/markdown';
import { mergeMessageSearchResults, searchLoadedMessages, searchMessagesGlobal } from '../lib/quickSearch';
import { searchWork } from '../lib/workSearch';
import { useAuth } from '../stores/auth';
import { useCalendar } from '../stores/calendar';
import { useChat } from '../stores/chat';
import { useTodos } from '../stores/todos';
import { useUI } from '../stores/ui';
import { useWorkbench } from '../stores/workbench';
import { appendButlerLine, useButler } from '../stores/butler';

interface AssistantResult {
  id: string;
  kind: 'message' | 'conversation' | 'contact' | 'todo' | 'event' | 'workitem' | 'pr' | 'build';
  title: string;
  detail: string;
  open: () => void | Promise<void>;
}

interface WorkItemDraft {
  title: string;
  description?: string;
  workItemType?: string;
}

const QUICK_PROMPTS = [
  '搜索最近关于发布失败的消息',
  '查询我的未完成待办',
  '查询失败的构建',
  '创建工作项：修复登录失败',
];

const RESULT_META = {
  message: { label: '消息', icon: MessageSquare },
  conversation: { label: '会话', icon: Hash },
  contact: { label: '联系人', icon: Contact },
  todo: { label: '待办', icon: SquareCheckBig },
  event: { label: '日程', icon: CalendarDays },
  workitem: { label: '工作项', icon: BriefcaseBusiness },
  pr: { label: '拉取请求', icon: BriefcaseBusiness },
  build: { label: '构建', icon: BriefcaseBusiness },
} as const;

function includes(text: string, query?: string): boolean {
  return !query || text.toLocaleLowerCase().includes(query.toLocaleLowerCase());
}

function routineDaysLabel(days?: number[]): string {
  if (!days?.length) return '每天';
  return days.map((day) => `周${'日一二三四五六'[day] ?? day}`).join('、');
}

export default function AiAssistantPage() {
  const userId = useAuth((state) => state.user?._id);
  const username = useAuth((state) => state.user?.username);
  const subscriptions = useChat((state) => state.subscriptions);
  const rooms = useChat((state) => state.rooms);
  const messages = useChat((state) => state.messages);
  const activeRid = useChat((state) => state.activeRid);
  const todos = useTodos((state) => state.todos);
  const events = useCalendar((state) => state.events);
  const config = useWorkbench((state) => state.config);
  const workItems = useWorkbench((state) => state.workItems);
  const prs = useWorkbench((state) => state.prs);
  const builds = useWorkbench((state) => state.builds);
  const lastRefresh = useWorkbench((state) => state.lastRefresh);
  const refreshWorkbench = useWorkbench((state) => state.refresh);
  const lines = useButler((state) => state.lines);
  const activity = useButler((state) => state.activity);
  const butlerRunning = useButler((state) => state.running);
  const butlerError = useButler((state) => state.error);
  const askButler = useButler((state) => state.ask);
  const routineDraft = useButler((state) => state.routineDraft);
  const confirmRoutineDraft = useButler((state) => state.confirmRoutineDraft);
  const dismissRoutineDraft = useButler((state) => state.dismissRoutineDraft);
  const [input, setInput] = useState('');
  const [quickRunning, setQuickRunning] = useState(false);
  const [results, setResults] = useState<AssistantResult[]>([]);
  const [draft, setDraft] = useState<WorkItemDraft | null>(null);
  const [createDialog, setCreateDialog] = useState(false);
  const running = quickRunning || butlerRunning;

  useEffect(() => {
    if (config && !lastRefresh) void refreshWorkbench();
  }, [config, lastRefresh, refreshWorkbench]);

  const roomIds = useMemo(() => Object.keys(subscriptions), [subscriptions]);

  const openCalendar = (id: string, date: string) => {
    const calendar = useCalendar.getState();
    calendar.setCursor(date);
    calendar.setSelectedDate(date);
    calendar.setView('day');
    useUI.getState().setModule('calendar');
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-event-id="${id}"]`)?.focus());
  };

  const searchEverything = async (query: string): Promise<AssistantResult[]> => {
    const localMessages = searchLoadedMessages(query, messages, (rid) => !!subscriptions[rid]);
    const [remoteMessages, foundContacts] = await Promise.all([
      searchMessagesGlobal(
        query,
        roomIds,
        {
          provider: () => realtime.call('rocketchatSearch.getProvider'),
          global: (keyword, limit, searchAll) =>
            realtime.call(
              'rocketchatSearch.search',
              keyword,
              { uid: userId, rid: activeRid ?? roomIds[0] ?? '' },
              { limit, searchAll },
            ),
          room: (rid, keyword, offset, count) => rest.searchMessages(rid, keyword, count, offset),
        },
        undefined,
        undefined,
        { searchAll: true },
      ).catch(() => ({ messages: [], source: 'rooms' as const, page: 0, hasMore: false })),
      rest.spotlight(query).catch(() => ({ users: [], rooms: [] })),
    ]);
    const foundMessages = mergeMessageSearchResults(localMessages, remoteMessages.messages).slice(0, 12);
    const conversationResults = roomIds
      .map((rid) => ({ rid, name: subscriptions[rid]?.fname || subscriptions[rid]?.name || rooms[rid]?.name || rid }))
      .filter((room) => includes(room.name, query))
      .slice(0, 6);
    const workResults = searchWork(query, todos, events, workItems, 12);
    return [
      ...foundMessages.map<AssistantResult>((message) => ({
        id: `message:${message._id}`,
        kind: 'message',
        title: message.msg || '[附件消息]',
        detail: `${message.u.name || message.u.username} · ${subscriptions[message.rid]?.fname || subscriptions[message.rid]?.name || message.rid}`,
        open: async () => {
          useUI.getState().setModule('messages');
          await useChat.getState().jumpToMessage(message._id, message.rid);
        },
      })),
      ...conversationResults.map<AssistantResult>((room) => ({
        id: `conversation:${room.rid}`,
        kind: 'conversation',
        title: room.name,
        detail: '已加入的会话',
        open: async () => {
          useUI.getState().setModule('messages');
          await useChat.getState().openRoom(room.rid);
        },
      })),
      ...foundContacts.users
        .filter((user) => user.username !== username)
        .slice(0, 6)
        .map<AssistantResult>((user) => ({
          id: `contact:${user._id}`,
          kind: 'contact',
          title: user.name || user.username,
          detail: `@${user.username}`,
          open: async () => {
            useUI.getState().setModule('messages');
            await useChat.getState().startDM(user.username);
          },
        })),
      ...workResults.map<AssistantResult>((result) => {
        if (result.kind === 'todo') {
          return {
            id: `todo:${result.item.id}`,
            kind: 'todo',
            title: result.item.note || result.item.excerpt,
            detail: `${result.item.done ? '已完成' : '未完成'}${result.item.due ? ` · ${result.item.due}` : ''}`,
            open: async () => {
              useUI.getState().setModule('messages');
              await useChat.getState().jumpToMessage(result.item.mid, result.item.rid);
            },
          };
        }
        if (result.kind === 'event') {
          return {
            id: `event:${result.item.id}`,
            kind: 'event',
            title: result.item.title,
            detail: `${result.item.date}${result.item.startTime ? ` · ${result.item.startTime}` : ''}`,
            open: () => openCalendar(result.item.id, result.item.date),
          };
        }
        return {
          id: `workitem:${result.item.id}`,
          kind: 'workitem',
          title: `#${result.item.id} ${result.item.title}`,
          detail: `${result.item.type} · ${result.item.state} · ${result.item.project}`,
          open: () => openExternal(result.item.webUrl),
        };
      }),
    ].slice(0, 30);
  };

  const queryResults = (command: Exclude<AssistantCommand, { type: 'search' | 'create_work_item' | 'help' }>): AssistantResult[] => {
    if (command.type === 'list_todos') {
      return todos
        .filter((todo) => !todo.done && includes(`${todo.note ?? ''} ${todo.excerpt} ${todo.roomName}`, command.query))
        .slice(0, 30)
        .map((todo) => ({
          id: `todo:${todo.id}`,
          kind: 'todo',
          title: todo.note || todo.excerpt,
          detail: `${todo.roomName}${todo.due ? ` · ${todo.due}` : ''}`,
          open: async () => {
            useUI.getState().setModule('messages');
            await useChat.getState().jumpToMessage(todo.mid, todo.rid);
          },
        }));
    }
    if (command.type === 'list_calendar') {
      return events
        .filter((event) => includes(`${event.title} ${event.description ?? ''} ${event.date}`, command.query))
        .slice(0, 30)
        .map((event) => ({
          id: `event:${event.id}`,
          kind: 'event',
          title: event.title,
          detail: `${event.date}${event.startTime ? ` · ${event.startTime}` : ''}`,
          open: () => openCalendar(event.id, event.date),
        }));
    }
    if (command.type === 'list_work_items') {
      return workItems
        .filter((item) => includes(`#${item.id} ${item.title} ${item.type} ${item.state} ${item.project}`, command.query))
        .slice(0, 30)
        .map((item) => ({
          id: `workitem:${item.id}`,
          kind: 'workitem',
          title: `#${item.id} ${item.title}`,
          detail: `${item.type} · ${item.state} · ${item.project}`,
          open: () => openExternal(item.webUrl),
        }));
    }
    if (command.type === 'list_pull_requests') {
      return prs
        .filter((pr) => includes(`#${pr.id} ${pr.title} ${pr.repo} ${pr.creator}`, command.query))
        .slice(0, 30)
        .map((pr) => ({
          id: `pr:${pr.id}`,
          kind: 'pr',
          title: `#${pr.id} ${pr.title}`,
          detail: `${pr.repo} · ${pr.creator}`,
          open: () => openExternal(pr.webUrl),
        }));
    }
    return builds
      .filter((build) => (!command.failedOnly || build.result.toLocaleLowerCase() === 'failed') && includes(`${build.buildNumber} ${build.definition} ${build.project} ${build.result}`, command.query))
      .slice(0, 30)
      .map((build) => ({
        id: `build:${build.id}`,
        kind: 'build',
        title: `${build.definition} · ${build.buildNumber}`,
        detail: `${build.project} · ${build.result || build.status}`,
        open: () => openExternal(build.webUrl),
      }));
  };

  const submit = async (text = input) => {
    const value = text.trim();
    if (!value || running) return;
    setInput('');
    setDraft(null);
    setResults([]);
    if (!isAssistantWorkCommand(value)) {
      await askButler(value);
      return;
    }

    setQuickRunning(true);
    appendButlerLine('user', value);
    try {
      const command: AssistantCommand = fallbackAssistantCommand(value);
      if (command.type === 'search') {
        const next = await searchEverything(command.query);
        setResults(next);
        appendButlerLine('assistant', next.length ? `找到 ${next.length} 条相关结果。` : '没有找到相关结果，可以换个关键词。');
      } else if (command.type === 'create_work_item') {
        setDraft({ title: command.title, description: command.description, workItemType: command.workItemType });
        appendButlerLine('assistant', '已生成工作项草案。检查后点击“确认创建”，最终字段仍会在创建窗口里由你确认。');
      } else if (command.type === 'help') {
        appendButlerLine('assistant', '我可以搜索消息/会话/联系人/工作数据，查询待办、日程、工作项、PR、构建，也可以生成工作项创建草案。');
      } else {
        const next = queryResults(command);
        setResults(next);
        appendButlerLine('assistant', next.length ? `查询到 ${next.length} 条记录。` : '当前没有符合条件的记录。');
      }
    } catch (error) {
      appendButlerLine('assistant', `处理失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setQuickRunning(false);
    }
  };

  return (
    <div className="min-w-0 flex-1 overflow-y-auto bg-surface-3">
      <div className="mx-auto flex min-h-full max-w-5xl flex-col px-8 py-7">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-xl font-semibold text-ink"><Bot size={20} className="text-primary" />管家</div>
            <p className="mt-1 text-sm text-ink-3">直接告诉我你想了解什么，我会先查证据再回答。</p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button onClick={() => useUI.getState().setModule('codex')} title="执行间" aria-label="执行间" className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-hover">
              <TerminalSquare size={13} />执行间
            </button>
            <div className="rounded-full border border-line bg-surface px-3 py-1 text-xs text-ink-3">
              {config ? 'ADO 已连接' : 'ADO 未配置'} · {getServerBase() ? 'Rocket.Chat 已连接' : '当前站点'}
            </div>
          </div>
        </div>

        <div className="mt-6 flex-1 space-y-3 rounded-xl border border-line bg-surface p-5 shadow-sm">
          {lines.map((line) => (
            <div key={line.id} className={`flex gap-3 ${line.role === 'user' ? 'justify-end' : ''}`}>
              {line.role === 'assistant' ? <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary-light text-primary"><Bot size={15} /></div> : null}
              <div className={`max-w-[78%] rounded-xl px-3.5 py-2.5 text-sm leading-6 ${line.role === 'user' ? 'bg-primary text-white' : 'bg-fill-1 text-ink'}`}>
                {line.role === 'assistant' && !line.text.startsWith('📌') ? renderMarkdown(line.text) : line.text}
              </div>
            </div>
          ))}
          {butlerError ? <div className="ml-10 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">{butlerError}</div> : null}
          {activity ? <div className="flex items-center gap-2 text-sm text-ink-3"><Loader2 size={15} className="animate-spin" />{activity}</div> : running ? <div className="flex items-center gap-2 text-sm text-ink-3"><Loader2 size={15} className="animate-spin" />正在处理请求…</div> : null}

          {draft ? (
            <div className="ml-10 rounded-lg border border-primary/30 bg-primary-light/40 p-4">
              <div className="text-xs font-medium text-primary">Azure DevOps 工作项草案</div>
              <div className="mt-2 font-medium text-ink">{draft.title}</div>
              {draft.description ? <div className="mt-1 whitespace-pre-wrap text-sm text-ink-2">{draft.description}</div> : null}
              <div className="mt-3 flex items-center justify-between gap-3">
                <span className="text-xs text-ink-3">{draft.workItemType || '自动选择类型'} · 尚未创建</span>
                <button onClick={() => setCreateDialog(true)} className="rounded-md bg-primary px-3 py-1.5 text-sm text-white hover:bg-primary-hover">确认创建</button>
              </div>
            </div>
          ) : null}

          {routineDraft ? (
            <div className="ml-10 rounded-lg border border-primary/30 bg-primary-light/40 p-4">
              <div className="text-xs font-medium text-primary">例行事务草案</div>
              <div className="mt-2 font-medium text-ink">{routineDraft.name}</div>
              <div className="mt-1 text-sm text-ink-2">{routineDraft.time} · {routineDaysLabel(routineDraft.days)} · 技能：{routineDraft.skillName}</div>
              <div className="mt-3 flex items-center justify-end gap-2">
                <button onClick={dismissRoutineDraft} className="rounded-md border border-line bg-surface px-3 py-1.5 text-sm text-ink hover:bg-fill-hover">取消</button>
                <button onClick={confirmRoutineDraft} className="rounded-md bg-primary px-3 py-1.5 text-sm text-white hover:bg-primary-hover">确认启用</button>
              </div>
            </div>
          ) : null}

          {results.length ? (
            <div className="ml-10 grid gap-2 md:grid-cols-2">
              {results.map((result) => {
                const meta = RESULT_META[result.kind];
                const Icon = meta.icon;
                return (
                  <button key={result.id} onClick={() => void result.open()} className="flex min-w-0 items-start gap-3 rounded-lg border border-line bg-surface-2 p-3 text-left transition hover:border-primary/40 hover:bg-fill-hover">
                    <div className="mt-0.5 rounded bg-fill-1 p-1.5 text-primary"><Icon size={14} /></div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2"><span className="text-2xs text-ink-3">{meta.label}</span><ExternalLink size={11} className="text-ink-3" /></div>
                      <div className="mt-0.5 truncate text-sm font-medium text-ink">{result.title}</div>
                      <div className="mt-0.5 truncate text-xs text-ink-3">{result.detail}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {QUICK_PROMPTS.map((prompt) => <button key={prompt} onClick={() => void submit(prompt)} disabled={running} className="rounded-full border border-line bg-surface px-3 py-1.5 text-xs text-ink-2 hover:bg-fill-hover disabled:opacity-50">{prompt}</button>)}
        </div>
        <form onSubmit={(event) => { event.preventDefault(); void submit(); }} className="mt-3 flex items-center gap-2 rounded-xl border border-line bg-surface p-2 shadow-sm focus-within:border-primary">
          <Search size={17} className="ml-2 text-ink-3" />
          <input value={input} onChange={(event) => setInput(event.target.value)} placeholder="例如：搜索张三提到的发布问题；查询失败构建；创建一个 Bug…" className="h-10 min-w-0 flex-1 bg-transparent px-2 text-sm text-ink outline-none placeholder:text-ink-3" />
          <button type="submit" disabled={running || !input.trim()} className="flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm text-white hover:bg-primary-hover disabled:opacity-50"><Send size={14} />发送</button>
        </form>
      </div>
      {createDialog && draft ? <CreateWorkItemDialog defaultTitle={draft.title} defaultDescription={draft.description} defaultType={draft.workItemType} defaultTags="RocketX AI 助手" onClose={() => setCreateDialog(false)} /> : null}
    </div>
  );
}
