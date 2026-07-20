import { create } from 'zustand';
import { runAgentLoop, type AgentLoopEvent } from '../kernel/ai/agent-loop';
import type { AiMessage } from '../kernel/ai/provider';
import { getServerBase } from '../lib/client';
import { codexBrainAvailability, getButlerBrain } from '../lib/butlerBrain';
import {
  butlerContextPrompt,
  extractButlerSources,
  mergeButlerSources,
  type ButlerSource,
  type ButlerSurfaceContext,
} from '../lib/butlerContext';
import { buildButlerSystemPrompt, butlerCurrentTimeLine, friendlyButlerError } from '../lib/butlerProfile';
import { createButlerTools, setRoutineDraftHandler, type ButlerRoutineDraft } from '../lib/butlerTools';
import {
  auditButlerAction,
  createButlerActionDraft,
  type ButlerActionDraft,
  type ButlerActionKind,
} from '../lib/butlerActions';
import { useAuth } from './auth';
import {
  askButlerCodex,
  discardResidentCodexThread,
  friendlyButlerCodexError,
  hydrateResidentCodexThread,
  residentCodexThreadSnapshot,
  stopButlerCodexTurn,
} from './butlerCodex';
import { useRoutines } from './routines';

const HISTORY_LIMIT = 40;
/** 持久化的展示行上限：超出裁旧，避免本地存储无限增长 */
const LINES_LIMIT = 200;
/** 过期不续：超过这个时长没有对话活动，恢复时只回看不续上下文，防止上下文腐烂 */
const CONTEXT_FRESH_MS = 3 * 24 * 60 * 60 * 1000;
const STALE_HINT = '📌 距上次对话已久，已开启全新上下文；以上历史仅供回看。';
const APP_ID = 'builtin:butler';

export { DEFAULT_PERSONA as BUTLER_SYSTEM_PROMPT } from '../lib/butlerProfile';

export interface ButlerLine {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  sources?: ButlerSource[];
}

/** 本轮的一个执行步骤（工具调用），给「过程」展示用 */
export interface ButlerStep {
  id: string;
  label: string;
  status: 'running' | 'done' | 'failed';
  at: number;
}

export interface ButlerRoomContext {
  rid: string;
  roomName: string;
}

export type ButlerAskContext = ButlerRoomContext | ButlerSurfaceContext;

export interface ButlerState {
  lines: ButlerLine[];
  activity: string | null;
  /** 本轮（或上一轮）的执行步骤，新提问时清空 */
  steps: ButlerStep[];
  history: AiMessage[];
  running: boolean;
  error: string | null;
  routineDraft: ButlerRoutineDraft | null;
  context: ButlerSurfaceContext | null;
  actionDraft: ButlerActionDraft | null;
  ask: (text: string, context?: ButlerAskContext) => Promise<void>;
  setContext: (context: ButlerSurfaceContext | null) => void;
  proposeAction: (kind: ButlerActionKind, sourceLineId: string) => void;
  updateAction: (patch: Partial<Pick<ButlerActionDraft, 'title' | 'text' | 'rid' | 'committedTo' | 'due'>>) => void;
  dismissAction: () => void;
  completeAction: (message: string) => void;
  /** 停止当前回答：保留已生成内容，不当错误处理 */
  stop: () => Promise<void>;
  /** 新对话：清空对话与持久化记录，丢弃 Codex 常驻线程，从全新上下文开始 */
  newConversation: () => Promise<void>;
  hydrate: () => Promise<void>;
  setRoutineDraft: (draft: ButlerRoutineDraft) => void;
  confirmRoutineDraft: () => void;
  dismissRoutineDraft: () => void;
  reset: () => void;
}

/** 按服务器+账号隔离保存的管家对话记录。 */
interface PersistedButler {
  lines: ButlerLine[];
  history: AiMessage[];
  codexThread?: { threadId: string; promptHash: string };
  /** 最后一次对话活动时间，恢复时判断上下文是否过期 */
  lastAt?: number;
}

type ButlerLoopRunner = typeof runAgentLoop;
type ButlerCodexRunner = typeof askButlerCodex;

let loopRunner: ButlerLoopRunner = runAgentLoop;
let codexRunner: ButlerCodexRunner = askButlerCodex;
let butlerNow = () => Date.now();

let persistScope = '';
let persistTimer: ReturnType<typeof setTimeout> | null = null;
/** 当前 API 大脑回合的中止控制器（Codex 大脑走 turn/interrupt） */
let currentAbort: AbortController | undefined;

interface ButlerAppData {
  get<T>(appId: string, key: string): Promise<T | undefined>;
  set<T>(appId: string, key: string, value: T): Promise<void>;
}

let appDataOverride: ButlerAppData | null = null;

async function butlerAppData(): Promise<ButlerAppData> {
  if (appDataOverride) return appDataOverride;
  return (await import('../kernel/store')).kernelStore.appData;
}

/** 测试用：注入内存版持久化后端（kernelStore 依赖 IndexedDB） */
export function setButlerPersistence(store: ButlerAppData): () => void {
  const previous = appDataOverride;
  appDataOverride = store;
  return () => {
    appDataOverride = previous;
  };
}

async function persistButler(): Promise<void> {
  if (!persistScope) return;
  const { lines, history } = useButler.getState();
  const codexThread = residentCodexThreadSnapshot();
  await (await butlerAppData()).set<PersistedButler>(APP_ID, persistScope, {
    lines: lines.slice(-LINES_LIMIT),
    history,
    lastAt: butlerNow(),
    ...(codexThread ? { codexThread } : {}),
  });
}

/** 对话变更后防抖落盘；未 hydrate（不知道账号范围）前不写 */
function schedulePersist(): void {
  if (!persistScope) return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persistButler().catch(() => undefined);
  }, 500);
}

/** 测试用：立即落盘，绕过防抖 */
export async function flushButlerPersist(): Promise<void> {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  await persistButler();
}

/** 测试用：清除已记录的持久化范围，模拟应用重启 */
export function resetButlerPersistenceForTests(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  persistScope = '';
}

const toolLabels: Record<string, string> = {
  search_messages: '搜索消息',
  list_mentions: '查询 @我',
  search_people_rooms: '查询联系人和会话',
  list_todos: '查询待办',
  list_calendar: '查询日程',
  list_work_items: '查询工作项',
  list_pull_requests: '查询拉取请求',
  list_builds: '查询构建',
  recall_memory: '召回记忆',
  load_skill: '加载技能',
  remember: '记录记忆',
  draft_routine: '生成例行事务草案',
};

function line(role: ButlerLine['role'], text: string): ButlerLine {
  return { id: crypto.randomUUID(), role, text };
}

function normalizeContext(context: ButlerAskContext): ButlerSurfaceContext {
  if ('kind' in context) return context;
  return {
    kind: 'room',
    label: context.roomName,
    detail: '当前 Rocket.Chat 房间',
    sources: [{ kind: 'room', id: context.rid, rid: context.rid, label: context.roomName }],
  };
}

function welcomeLines(): ButlerLine[] {
  return [line('assistant', '我是你的管家。消息、待办、日程、工作项都可以直接问我。')];
}

function activityFor(event: AgentLoopEvent): string | null {
  if (event.type === 'tool-call') return `正在调用 ${toolLabels[event.toolCall.name] ?? event.toolCall.name}…`;
  return null;
}

export function trimButlerHistory(history: AiMessage[]): AiMessage[] {
  if (history.length <= HISTORY_LIMIT) return history;
  let start = history.length - HISTORY_LIMIT;
  while (history[start]?.role === 'tool') start += 1;
  return history.slice(start);
}

export function setButlerLoopRunner(runner: ButlerLoopRunner): () => void {
  const previous = loopRunner;
  loopRunner = runner;
  return () => {
    loopRunner = previous;
  };
}

export function setButlerCodexRunner(runner: ButlerCodexRunner): () => void {
  const previous = codexRunner;
  codexRunner = runner;
  return () => {
    codexRunner = previous;
  };
}

export function setButlerNowProvider(provider: () => number): () => void {
  const previous = butlerNow;
  butlerNow = provider;
  return () => {
    butlerNow = previous;
  };
}

export function appendButlerLine(role: ButlerLine['role'], text: string): void {
  useButler.setState((state) => ({ lines: [...state.lines, line(role, text)] }));
}

export const useButler = create<ButlerState>((set, get) => ({
  lines: welcomeLines(),
  activity: null,
  steps: [],
  history: [],
  running: false,
  error: null,
  routineDraft: null,
  context: null,
  actionDraft: null,

  hydrate: async () => {
    const user = useAuth.getState().user;
    if (!user) return;
    const scope = `${getServerBase() || 'same-origin'}:${user._id}`;
    if (persistScope === scope) return;
    const firstHydrate = persistScope === '';
    persistScope = scope;
    const stored = await (await butlerAppData())
      .get<PersistedButler>(APP_ID, scope)
      .catch(() => undefined);
    // 首次注水时用户可能已经开始新对话，不覆盖；切换账号则总是切到该账号的记录
    if (firstHydrate && get().lines.some((line) => line.role === 'user')) return;
    const storedLines = stored?.lines?.length ? stored.lines.slice(-LINES_LIMIT) : welcomeLines();
    // 过期不续：久未对话时旧记录仅供回看，模型上下文从头开始，防止上下文腐烂
    const fresh = stored?.lastAt != null && butlerNow() - stored.lastAt <= CONTEXT_FRESH_MS;
    const hadConversation = storedLines.some((item) => item.role === 'user');
    const staleHintNeeded =
      !fresh && hadConversation && storedLines.at(-1)?.text !== STALE_HINT;
    set({
      lines: staleHintNeeded ? [...storedLines, line('assistant', STALE_HINT)] : storedLines,
      history: fresh ? trimButlerHistory(stored?.history ?? []) : [],
    });
    if (fresh && stored?.codexThread) {
      hydrateResidentCodexThread(stored.codexThread.threadId, stored.codexThread.promptHash);
    }
  },

  ask: async (text, context) => {
    const content = text.trim();
    if (!content || get().running) return;

    const turnContext = context ? normalizeContext(context) : get().context;
    const brain = getButlerBrain();
    const abort = brain === 'api' ? new AbortController() : undefined;
    currentAbort = abort;
    const history = brain === 'api'
      ? trimButlerHistory([...get().history, { role: 'user', content }])
      : get().history;
    set((state) => ({
      lines: [...state.lines, line('user', content)],
      activity: null,
      steps: [],
      ...(brain === 'api' ? { history } : {}),
      running: true,
      error: null,
      ...(context && 'kind' in context ? { context: turnContext } : {}),
    }));

    let assistantLineId: string | undefined;
    let turnSources = turnContext?.sources ?? [];
    const toolCallNames = new Map<string, string>();
    const onEvent = (event: AgentLoopEvent) => {
      if (event.type === 'content') {
        const id = assistantLineId ?? crypto.randomUUID();
        assistantLineId ??= id;
        set((state) => {
          const current = state.lines.find((item) => item.id === id);
          return {
            lines: current
              ? state.lines.map((item) => item.id === id ? { ...item, text: `${item.text}${event.content}` } : item)
              : [...state.lines, { id, role: 'assistant', text: event.content, ...(turnSources.length ? { sources: turnSources } : {}) }],
          };
        });
        return;
      }
      if (event.type === 'tool-call') {
        toolCallNames.set(event.toolCall.id, event.toolCall.name);
        const label = toolLabels[event.toolCall.name] ?? event.toolCall.name;
        set((state) => ({
          activity: activityFor(event),
          steps: [...state.steps, { id: event.toolCall.id, label, status: 'running' as const, at: butlerNow() }],
        }));
        return;
      }
      if (event.type === 'tool-result') {
        const toolName = toolCallNames.get(event.toolCallId);
        turnSources = mergeButlerSources(turnSources, extractButlerSources(toolName, event.content));
        const failed = /^工具(?:调用|执行)失败/.test(event.content);
        set((state) => ({
          activity: null,
          steps: state.steps.map((step) =>
            step.id === event.toolCallId ? { ...step, status: failed ? 'failed' as const : 'done' as const } : step,
          ),
          lines: toolName === 'remember'
            ? [...state.lines, line('assistant', `📌 ${event.content}`)]
            : assistantLineId
              ? state.lines.map((item) => item.id === assistantLineId
                ? { ...item, ...(turnSources.length ? { sources: turnSources } : {}) }
                : item)
              : state.lines,
        }));
      }
    };

    try {
      if (brain === 'codex') {
        const availability = codexBrainAvailability();
        if (!availability.available) throw new Error(availability.reason ?? 'Codex 大脑暂不可用');
        const result = await codexRunner({
          text: content,
          context: turnContext ?? undefined,
          now: butlerNow(),
          onEvent,
        });
        set((state) => ({
          lines: result.text
            ? assistantLineId
              ? state.lines.map((item) => item.id === assistantLineId ? { ...item, text: result.text, ...(turnSources.length ? { sources: turnSources } : {}) } : item)
              : [...state.lines, { ...line('assistant', result.text), ...(turnSources.length ? { sources: turnSources } : {}) }]
            : state.lines,
          activity: null,
          running: false,
        }));
        return;
      }
      const system = `${buildButlerSystemPrompt()}\n\n${butlerCurrentTimeLine(butlerNow())}${
        turnContext
          ? `\n${butlerContextPrompt(turnContext)}`
          : ''
      }`;
      const result = await loopRunner({
        messages: [{ role: 'system', content: system }, ...history],
        tools: createButlerTools(),
        signal: abort?.signal,
        onEvent,
      });
      const nextHistory = trimButlerHistory([
        ...result.messages.filter((message) => message.role !== 'system'),
        { role: 'assistant', content: result.text },
      ]);
      set((state) => ({
        lines: result.text
          ? assistantLineId
            ? state.lines.map((item) => item.id === assistantLineId ? { ...item, text: result.text, ...(turnSources.length ? { sources: turnSources } : {}) } : item)
            : [...state.lines, { ...line('assistant', result.text), ...(turnSources.length ? { sources: turnSources } : {}) }]
          : state.lines,
        activity: null,
        history: nextHistory,
        running: false,
      }));
    } catch (error) {
      // 用户主动停止不是错误：保留已生成的内容，安静收尾
      if (abort?.signal.aborted) {
        set({ activity: null, running: false });
        return;
      }
      const message = brain === 'codex'
        ? `${friendlyButlerCodexError(error).replace(/[。.]$/, '')}。可在设置页切换为 API 大脑。`
        : friendlyButlerError(error);
      set({ activity: null, running: false, error: message });
    } finally {
      if (currentAbort === abort) currentAbort = undefined;
    }
  },

  setContext: (context) => set({ context }),

  proposeAction: (kind, sourceLineId) => {
    const source = get().lines.find((item) => item.id === sourceLineId && item.role === 'assistant');
    if (!source) return;
    const previous = get().actionDraft;
    if (previous) void auditButlerAction(previous.kind, 'cancelled', previous).catch(() => undefined);
    const actionDraft = createButlerActionDraft(kind, source, get().context);
    set({ actionDraft });
    void auditButlerAction(kind, 'proposed', actionDraft).catch(() => undefined);
  },

  updateAction: (patch) => set((state) => ({
    actionDraft: state.actionDraft ? { ...state.actionDraft, ...patch } : null,
  })),

  dismissAction: () => {
    const draft = get().actionDraft;
    if (!draft) return;
    set({ actionDraft: null });
    void auditButlerAction(draft.kind, 'cancelled', draft).catch(() => undefined);
  },

  completeAction: (message) => {
    const draft = get().actionDraft;
    if (!draft) return;
    set((state) => ({
      actionDraft: null,
      lines: [...state.lines, {
        ...line('assistant', `✅ ${message}`),
        ...(draft.sources.length ? { sources: draft.sources } : {}),
      }],
    }));
  },

  stop: async () => {
    if (!get().running) return;
    if (getButlerBrain() === 'codex') {
      // 服务端中断本轮并就地完成，ask 会沿正常路径收尾
      await stopButlerCodexTurn();
    } else {
      currentAbort?.abort(new Error('已停止'));
    }
    set({ activity: null });
  },

  newConversation: async () => {
    if (get().running) await get().stop();
    const actionDraft = get().actionDraft;
    if (actionDraft) {
      await auditButlerAction(actionDraft.kind, 'cancelled', actionDraft).catch(() => undefined);
    }
    await discardResidentCodexThread();
    set({
      lines: welcomeLines(),
      activity: null,
      steps: [],
      history: [],
      running: false,
      error: null,
      routineDraft: null,
      actionDraft: null,
    });
    // 立即把清空后的状态落盘，别让旧记录在下次启动时诈尸
    await flushButlerPersist();
  },

  setRoutineDraft: (routineDraft) => set({ routineDraft }),

  confirmRoutineDraft: () => {
    const draft = get().routineDraft;
    if (!draft) return;
    useRoutines.getState().addRoutine({
      id: crypto.randomUUID(),
      name: draft.name,
      trigger: { kind: 'daily', time: draft.time, days: draft.days },
      skillName: draft.skillName,
      delivery: 'today',
      enabled: true,
      createdAt: butlerNow(),
      runs: [],
    });
    set({ routineDraft: null });
  },

  dismissRoutineDraft: () => set({ routineDraft: null }),

  reset: () => set({
    lines: welcomeLines(),
    activity: null,
    steps: [],
    history: [],
    running: false,
    error: null,
    routineDraft: null,
    context: null,
    actionDraft: null,
  }),
}));

setRoutineDraftHandler((draft) => useButler.getState().setRoutineDraft(draft));

// 对话行或模型历史变化即防抖落盘；reset 会把欢迎语落盘，等价于清空记录
useButler.subscribe((state, previous) => {
  if (state.lines === previous.lines && state.history === previous.history) return;
  schedulePersist();
});
