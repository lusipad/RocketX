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
import {
  butlerTaskPrompt,
  compileButlerTask,
  updateButlerTask,
  type ButlerTaskState,
} from '../lib/butlerTaskContext';
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
const APP_ID = 'builtin:butler';
const SESSION_REGISTRY_VERSION = 1;
const SESSION_REGISTRY_PREFIX = 'session-registry:';
const DEFAULT_SESSION_ID = 'default';
const DEFAULT_SESSION_TITLE = '默认对话';

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

export interface ButlerSessionSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface ButlerState {
  lines: ButlerLine[];
  sessions: ButlerSessionSummary[];
  activeSessionId: string;
  activity: string | null;
  /** 本轮（或上一轮）的执行步骤，新提问时清空 */
  steps: ButlerStep[];
  history: AiMessage[];
  running: boolean;
  error: string | null;
  routineDraft: ButlerRoutineDraft | null;
  context: ButlerSurfaceContext | null;
  actionDraft: ButlerActionDraft | null;
  taskState: ButlerTaskState | null;
  ask: (text: string, context?: ButlerAskContext) => Promise<void>;
  setContext: (context: ButlerSurfaceContext | null) => void;
  proposeAction: (kind: ButlerActionKind, sourceLineId: string) => void;
  updateAction: (patch: Partial<Pick<ButlerActionDraft, 'title' | 'text' | 'rid' | 'committedTo' | 'due'>>) => void;
  dismissAction: () => void;
  completeAction: (message: string) => void;
  /** 停止当前回答：保留已生成内容，不当错误处理 */
  stop: () => Promise<void>;
  /** 新对话：保留当前 session 并创建一个独立 session。 */
  newConversation: () => Promise<void>;
  switchSession: (sessionId: string) => Promise<void>;
  renameSession: (sessionId: string, title: string) => Promise<void>;
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

interface PersistedButlerSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  lines: ButlerLine[];
  history: AiMessage[];
  codexThread?: { threadId: string; promptHash: string };
  taskState?: ButlerTaskState;
}

interface PersistedButlerSessionRegistry {
  schemaVersion: typeof SESSION_REGISTRY_VERSION;
  activeSessionId: string;
  sessions: PersistedButlerSession[];
}

type ButlerLoopRunner = typeof runAgentLoop;
type ButlerCodexRunner = typeof askButlerCodex;

let loopRunner: ButlerLoopRunner = runAgentLoop;
let codexRunner: ButlerCodexRunner = askButlerCodex;
let butlerNow = () => Date.now();

let persistScope = '';
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistInFlight: Promise<void> = Promise.resolve();
let sessionRegistry: PersistedButlerSessionRegistry | null = null;
let suppressPersistence = false;
let sessionDirty = false;
let hydrateGeneration = 0;
let hydrateInFlight: { scope: string; promise: Promise<void> } | null = null;
/** 当前 API 大脑回合的中止控制器（Codex 大脑走 turn/interrupt） */
let currentAbort: AbortController | undefined;
let currentTurnFinished: Promise<void> | null = null;

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

function registryKey(scope: string): string {
  return `${SESSION_REGISTRY_PREFIX}${scope}`;
}

function sessionSummaries(registry: PersistedButlerSessionRegistry): ButlerSessionSummary[] {
  return registry.sessions
    .map(({ id, title, createdAt, updatedAt }) => ({ id, title, createdAt, updatedAt }))
    .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt);
}

function normalizeRegistry(
  stored: PersistedButlerSessionRegistry | undefined,
): PersistedButlerSessionRegistry | undefined {
  if (stored?.schemaVersion !== SESSION_REGISTRY_VERSION || !Array.isArray(stored.sessions)) return undefined;
  const seen = new Set<string>();
  const sessions: PersistedButlerSession[] = [];
  for (const candidate of stored.sessions) {
    if (!candidate || typeof candidate.id !== 'string' || !candidate.id || seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    const updatedAt = Number.isFinite(candidate.updatedAt) ? candidate.updatedAt : butlerNow();
    const createdAt = Number.isFinite(candidate.createdAt) ? candidate.createdAt : updatedAt;
    const codexThread = candidate.codexThread;
    sessions.push({
      id: candidate.id,
      title: typeof candidate.title === 'string' && candidate.title.trim()
        ? candidate.title.trim()
        : DEFAULT_SESSION_TITLE,
      createdAt,
      updatedAt,
      lines: Array.isArray(candidate.lines) && candidate.lines.length
        ? candidate.lines.slice(-LINES_LIMIT)
        : welcomeLines(),
      history: trimButlerHistory(Array.isArray(candidate.history) ? candidate.history : []),
      ...(codexThread?.threadId && codexThread.promptHash ? { codexThread } : {}),
      ...(candidate.taskState?.manifest?.schemaVersion === 1 ? { taskState: candidate.taskState } : {}),
    });
  }
  if (!sessions.length) return undefined;
  const activeSessionId = sessions.some((session) => session.id === stored.activeSessionId)
    ? stored.activeSessionId
    : sessions[0].id;
  return { schemaVersion: SESSION_REGISTRY_VERSION, activeSessionId, sessions };
}

function defaultSession(legacy?: PersistedButler): PersistedButlerSession {
  const updatedAt = legacy?.lastAt != null && Number.isFinite(legacy.lastAt) ? legacy.lastAt : butlerNow();
  const codexThread = legacy?.codexThread;
  return {
    id: DEFAULT_SESSION_ID,
    title: DEFAULT_SESSION_TITLE,
    createdAt: updatedAt,
    updatedAt,
    lines: legacy?.lines?.length ? legacy.lines.slice(-LINES_LIMIT) : welcomeLines(),
    history: trimButlerHistory(legacy?.history ?? []),
    ...(codexThread?.threadId && codexThread.promptHash ? { codexThread } : {}),
  };
}

function legacyRecord(session: PersistedButlerSession): PersistedButler {
  return {
    lines: session.lines.slice(-LINES_LIMIT),
    history: trimButlerHistory(session.history),
    lastAt: session.updatedAt,
    ...(session.codexThread ? { codexThread: session.codexThread } : {}),
  };
}

function activeSession(registry: PersistedButlerSessionRegistry): PersistedButlerSession {
  return registry.sessions.find((session) => session.id === registry.activeSessionId) ?? registry.sessions[0];
}

function captureActiveSession(
  registry: PersistedButlerSessionRegistry,
  touchActivity: boolean,
): PersistedButlerSessionRegistry {
  const current = activeSession(registry);
  const { codexThread: _previousCodexThread, ...base } = current;
  const state = useButler.getState();
  const codexThread = residentCodexThreadSnapshot();
  const captured: PersistedButlerSession = {
    ...base,
    updatedAt: touchActivity ? butlerNow() : current.updatedAt,
    lines: state.lines.slice(-LINES_LIMIT),
    history: trimButlerHistory(state.history),
    ...(codexThread ? { codexThread } : {}),
    ...(state.taskState ? { taskState: state.taskState } : {}),
  };
  return {
    ...registry,
    sessions: registry.sessions.map((session) => session.id === captured.id ? captured : session),
  };
}

function queueRegistryWrite(scope: string, registry: PersistedButlerSessionRegistry): Promise<void> {
  const task = persistInFlight.catch(() => undefined).then(async () => {
    const appData = await butlerAppData();
    await appData.set<PersistedButlerSessionRegistry>(APP_ID, registryKey(scope), registry);
    await appData.set<PersistedButler>(APP_ID, scope, legacyRecord(activeSession(registry)));
  });
  persistInFlight = task;
  return task;
}

async function persistButler(touchActivity = sessionDirty): Promise<void> {
  if (!persistScope || !sessionRegistry) return;
  const scope = persistScope;
  const registry = captureActiveSession(sessionRegistry, touchActivity);
  sessionRegistry = registry;
  sessionDirty = false;
  useButler.setState({ sessions: sessionSummaries(registry) });
  await queueRegistryWrite(scope, registry);
}

/** 对话变更后防抖落盘；未 hydrate（不知道账号范围）前不写 */
function schedulePersist(): void {
  if (!persistScope || suppressPersistence) return;
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
  hydrateGeneration += 1;
  persistScope = '';
  sessionRegistry = null;
  suppressPersistence = false;
  sessionDirty = false;
  hydrateInFlight = null;
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

function applyActiveSession(registry: PersistedButlerSessionRegistry): void {
  const session = activeSession(registry);
  sessionDirty = false;
  suppressPersistence = true;
  try {
    useButler.setState({
      lines: session.lines.length ? session.lines.slice(-LINES_LIMIT) : welcomeLines(),
      sessions: sessionSummaries(registry),
      activeSessionId: session.id,
      activity: null,
      steps: [],
      history: trimButlerHistory(session.history),
      running: false,
      error: null,
      routineDraft: null,
      actionDraft: null,
      taskState: session.taskState ?? null,
    });
  } finally {
    suppressPersistence = false;
  }
  if (session.codexThread) {
    hydrateResidentCodexThread(session.codexThread.threadId, session.codexThread.promptHash);
  }
}

export const useButler = create<ButlerState>((set, get) => ({
  lines: welcomeLines(),
  sessions: [],
  activeSessionId: '',
  activity: null,
  steps: [],
  history: [],
  running: false,
  error: null,
  routineDraft: null,
  context: null,
  actionDraft: null,
  taskState: null,

  hydrate: async () => {
    const user = useAuth.getState().user;
    if (!user) return;
    const scope = `${getServerBase() || 'same-origin'}:${user._id}`;
    if (persistScope === scope && sessionRegistry) return;
    if (hydrateInFlight?.scope === scope) {
      await hydrateInFlight.promise;
      return;
    }

    const task = (async () => {
      const generation = ++hydrateGeneration;
      const firstHydrate = persistScope === '';
      const previousScope = persistScope;
      const startedState = get();
      const startedConversation = firstHydrate && startedState.lines.some((item) => item.role === 'user');
      const startedCodexThread = residentCodexThreadSnapshot();

      // scope 变更前先同步旧状态并等待已有写入，避免防抖回调把旧状态写进新账号/服务器。
      if (previousScope && sessionRegistry && get().running) await get().stop();
      if (previousScope && sessionRegistry) await flushButlerPersist();
      if (generation !== hydrateGeneration) return;
      persistScope = '';
      sessionRegistry = null;
      await discardResidentCodexThread();
      if (generation !== hydrateGeneration) return;

      const appData = await butlerAppData();
      const [storedRegistry, legacy] = await Promise.all([
        appData
          .get<PersistedButlerSessionRegistry>(APP_ID, registryKey(scope))
          .catch(() => undefined),
        appData.get<PersistedButler>(APP_ID, scope).catch(() => undefined),
      ]);
      if (generation !== hydrateGeneration) return;

      const existingRegistry = normalizeRegistry(storedRegistry);
      let registry: PersistedButlerSessionRegistry = existingRegistry ?? {
        schemaVersion: SESSION_REGISTRY_VERSION,
        activeSessionId: DEFAULT_SESSION_ID,
        sessions: [defaultSession(legacy)],
      };

      // 首次 hydrate 前用户已经开聊时保留当前内容；若另有旧记录，则作为独立 session 并存。
      if (startedConversation) {
        const hasStoredConversation = Boolean(existingRegistry || legacy);
        const id = hasStoredConversation ? crypto.randomUUID() : DEFAULT_SESSION_ID;
        const now = butlerNow();
        const startedSession: PersistedButlerSession = {
          id,
          title: hasStoredConversation ? '当前对话' : DEFAULT_SESSION_TITLE,
          createdAt: now,
          updatedAt: now,
          lines: startedState.lines.slice(-LINES_LIMIT),
          history: trimButlerHistory(startedState.history),
          ...(startedCodexThread ? { codexThread: startedCodexThread } : {}),
        };
        registry = {
          schemaVersion: SESSION_REGISTRY_VERSION,
          activeSessionId: id,
          sessions: hasStoredConversation ? [...registry.sessions, startedSession] : [startedSession],
        };
      }

      persistScope = scope;
      sessionRegistry = registry;
      applyActiveSession(registry);
      if (!existingRegistry || startedConversation) {
        await queueRegistryWrite(scope, registry).catch(() => undefined);
      }
    })();
    hydrateInFlight = { scope, promise: task };
    try {
      await task;
    } finally {
      if (hydrateInFlight?.promise === task) hydrateInFlight = null;
    }
  },

  ask: async (text, context) => {
    const content = text.trim();
    if (!content || get().running) return;
    await get().hydrate();
    if (get().running) return;

    const turnContext = context ? normalizeContext(context) : get().context;
    const compiledTask = compileButlerTask(content, turnContext, get().taskState, butlerNow());
    if (compiledTask.status === 'awaiting-clarification') {
      set((state) => ({
        lines: [
          ...state.lines,
          line('user', content),
          line('assistant', compiledTask.manifest.clarification.question ?? '请补充完成这项任务所需的信息。'),
        ],
        steps: [],
        error: null,
        taskState: compiledTask,
        ...(context && 'kind' in context ? { context: turnContext } : {}),
      }));
      return;
    }
    const brain = getButlerBrain();
    const abort = brain === 'api' ? new AbortController() : undefined;
    currentAbort = abort;
    const history = brain === 'api'
      ? trimButlerHistory([...get().history, { role: 'user', content }])
      : get().history;
    let finishTurn: (() => void) | undefined;
    const turnFinished = new Promise<void>((resolve) => {
      finishTurn = resolve;
    });
    currentTurnFinished = turnFinished;
    set((state) => ({
      lines: [...state.lines, line('user', content)],
      activity: null,
      steps: [],
      ...(brain === 'api' ? { history } : {}),
      running: true,
      error: null,
      ...(context && 'kind' in context ? { context: turnContext } : {}),
      taskState: updateButlerTask(compiledTask, { status: 'running' }, butlerNow()),
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
          taskState: state.taskState
            ? updateButlerTask(state.taskState, { sources: turnSources }, butlerNow())
            : null,
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
          taskContext: butlerTaskPrompt(compiledTask),
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
          taskState: state.taskState
            ? updateButlerTask(state.taskState, { status: 'completed', sources: turnSources }, butlerNow())
            : null,
        }));
        return;
      }
      const system = `${buildButlerSystemPrompt()}\n\n${butlerCurrentTimeLine(butlerNow())}\n${butlerTaskPrompt(compiledTask)}${
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
        taskState: state.taskState
          ? updateButlerTask(state.taskState, { status: 'completed', sources: turnSources }, butlerNow())
          : null,
      }));
    } catch (error) {
      // 用户主动停止不是错误：保留已生成的内容，安静收尾
      if (abort?.signal.aborted) {
        set((state) => ({
          activity: null,
          running: false,
          taskState: state.taskState
            ? updateButlerTask(state.taskState, { status: 'paused' }, butlerNow())
            : null,
        }));
        return;
      }
      const message = brain === 'codex'
        ? `${friendlyButlerCodexError(error).replace(/[。.]$/, '')}。可在设置页切换为 API 大脑。`
        : friendlyButlerError(error);
      set((state) => ({
        activity: null,
        running: false,
        error: message,
        taskState: state.taskState
          ? updateButlerTask(state.taskState, { status: 'failed', error: message }, butlerNow())
          : null,
      }));
    } finally {
      if (currentAbort === abort) currentAbort = undefined;
      if (currentTurnFinished === turnFinished) currentTurnFinished = null;
      finishTurn?.();
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
    const turnFinished = currentTurnFinished;
    if (getButlerBrain() === 'codex') {
      // 服务端中断本轮并就地完成，ask 会沿正常路径收尾
      await stopButlerCodexTurn();
    } else {
      currentAbort?.abort(new Error('已停止'));
    }
    set({ activity: null });
    if (turnFinished) await turnFinished;
  },

  newConversation: async () => {
    await get().hydrate();
    if (get().running) await get().stop();
    if (!sessionRegistry || !persistScope) return;
    const actionDraft = get().actionDraft;
    if (actionDraft) {
      await auditButlerAction(actionDraft.kind, 'cancelled', actionDraft).catch(() => undefined);
    }

    await flushButlerPersist();
    const scope = persistScope;
    const currentRegistry = sessionRegistry;
    await discardResidentCodexThread();
    const now = butlerNow();
    const nextSession: PersistedButlerSession = {
      id: crypto.randomUUID(),
      title: '新对话',
      createdAt: now,
      updatedAt: now,
      lines: welcomeLines(),
      history: [],
    };
    const nextRegistry: PersistedButlerSessionRegistry = {
      ...currentRegistry,
      activeSessionId: nextSession.id,
      sessions: [...currentRegistry.sessions, nextSession],
    };
    sessionRegistry = nextRegistry;
    applyActiveSession(nextRegistry);
    await queueRegistryWrite(scope, nextRegistry);
  },

  switchSession: async (sessionId) => {
    const targetId = sessionId.trim();
    if (!targetId) return;
    await get().hydrate();
    if (!sessionRegistry || !persistScope || sessionRegistry.activeSessionId === targetId) return;
    if (!sessionRegistry.sessions.some((session) => session.id === targetId)) return;
    if (get().running) await get().stop();
    const actionDraft = get().actionDraft;
    if (actionDraft) {
      await auditButlerAction(actionDraft.kind, 'cancelled', actionDraft).catch(() => undefined);
    }

    await flushButlerPersist();
    if (!sessionRegistry || !sessionRegistry.sessions.some((session) => session.id === targetId)) return;
    const scope = persistScope;
    const nextRegistry: PersistedButlerSessionRegistry = {
      ...sessionRegistry,
      activeSessionId: targetId,
    };
    await discardResidentCodexThread();
    sessionRegistry = nextRegistry;
    applyActiveSession(nextRegistry);
    await queueRegistryWrite(scope, nextRegistry);
  },

  renameSession: async (sessionId, title) => {
    const nextTitle = title.trim();
    if (!sessionId || !nextTitle) return;
    await get().hydrate();
    if (!sessionRegistry || !persistScope) return;
    const target = sessionRegistry.sessions.find((session) => session.id === sessionId);
    if (!target || target.title === nextTitle) return;

    await flushButlerPersist();
    if (!sessionRegistry) return;
    const scope = persistScope;
    const nextRegistry: PersistedButlerSessionRegistry = {
      ...sessionRegistry,
      sessions: sessionRegistry.sessions.map((session) => session.id === sessionId
        ? { ...session, title: nextTitle, updatedAt: butlerNow() }
        : session),
    };
    sessionRegistry = nextRegistry;
    sessionDirty = false;
    set({ sessions: sessionSummaries(nextRegistry) });
    await queueRegistryWrite(scope, nextRegistry);
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
    sessions: [],
    activeSessionId: '',
    activity: null,
    steps: [],
    history: [],
    running: false,
    error: null,
    routineDraft: null,
    context: null,
    actionDraft: null,
    taskState: null,
  }),
}));

setRoutineDraftHandler((draft) => useButler.getState().setRoutineDraft(draft));

// 当前已 hydrate 的 session 发生 transcript 或任务态变化时更新活动时间并防抖落盘。
useButler.subscribe((state, previous) => {
  if (state.lines === previous.lines && state.history === previous.history && state.taskState === previous.taskState) return;
  if (suppressPersistence || !persistScope || !sessionRegistry) return;
  sessionDirty = true;
  schedulePersist();
});
