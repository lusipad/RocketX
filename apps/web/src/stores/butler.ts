import { create } from 'zustand';
import { runAgentLoop, type AgentLoopEvent } from '../kernel/ai/agent-loop';
import type { AiMessage } from '../kernel/ai/provider';
import { codexBrainAvailability, getButlerBrain } from '../lib/butlerBrain';
import { buildButlerSystemPrompt, butlerCurrentTimeLine, friendlyButlerError } from '../lib/butlerProfile';
import { createButlerTools, setRoutineDraftHandler, type ButlerRoutineDraft } from '../lib/butlerTools';
import { askButlerCodex, friendlyButlerCodexError } from './butlerCodex';
import { useRoutines } from './routines';

const HISTORY_LIMIT = 40;

export { DEFAULT_PERSONA as BUTLER_SYSTEM_PROMPT } from '../lib/butlerProfile';

export interface ButlerLine {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}

export interface ButlerRoomContext {
  rid: string;
  roomName: string;
}

export interface ButlerState {
  lines: ButlerLine[];
  activity: string | null;
  history: AiMessage[];
  running: boolean;
  error: string | null;
  routineDraft: ButlerRoutineDraft | null;
  ask: (text: string, context?: ButlerRoomContext) => Promise<void>;
  setRoutineDraft: (draft: ButlerRoutineDraft) => void;
  confirmRoutineDraft: () => void;
  dismissRoutineDraft: () => void;
  reset: () => void;
}

type ButlerLoopRunner = typeof runAgentLoop;
type ButlerCodexRunner = typeof askButlerCodex;

let loopRunner: ButlerLoopRunner = runAgentLoop;
let codexRunner: ButlerCodexRunner = askButlerCodex;
let butlerNow = () => Date.now();

const toolLabels: Record<string, string> = {
  search_messages: '搜索消息',
  search_people_rooms: '查询联系人和会话',
  list_todos: '查询待办',
  list_calendar: '查询日程',
  list_work_items: '查询工作项',
  list_pull_requests: '查询拉取请求',
  list_builds: '查询构建',
  load_skill: '加载技能',
  remember: '记录记忆',
  draft_routine: '生成例行事务草案',
};

function line(role: ButlerLine['role'], text: string): ButlerLine {
  return { id: crypto.randomUUID(), role, text };
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
  history: [],
  running: false,
  error: null,
  routineDraft: null,

  ask: async (text, context) => {
    const content = text.trim();
    if (!content || get().running) return;

    const brain = getButlerBrain();
    const history = brain === 'api'
      ? trimButlerHistory([...get().history, { role: 'user', content }])
      : get().history;
    set((state) => ({
      lines: [...state.lines, line('user', content)],
      activity: null,
      ...(brain === 'api' ? { history } : {}),
      running: true,
      error: null,
    }));

    let assistantLineId: string | undefined;
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
              : [...state.lines, { id, role: 'assistant', text: event.content }],
          };
        });
        return;
      }
      if (event.type === 'tool-call') {
        toolCallNames.set(event.toolCall.id, event.toolCall.name);
        set({ activity: activityFor(event) });
        return;
      }
      if (event.type === 'tool-result') {
        const toolName = toolCallNames.get(event.toolCallId);
        set((state) => ({
          activity: null,
          lines: toolName === 'remember'
            ? [...state.lines, line('assistant', `📌 ${event.content}`)]
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
          context,
          now: butlerNow(),
          onEvent,
        });
        set((state) => ({
          lines: result.text
            ? assistantLineId
              ? state.lines.map((item) => item.id === assistantLineId ? { ...item, text: result.text } : item)
              : [...state.lines, line('assistant', result.text)]
            : state.lines,
          activity: null,
          running: false,
        }));
        return;
      }
      const system = `${buildButlerSystemPrompt()}\n\n${butlerCurrentTimeLine(butlerNow())}${
        context
          ? `\n用户当前所在房间：${context.roomName}\n查询本房间消息时优先用 search_messages 的 roomName 参数限定范围`
          : ''
      }`;
      const result = await loopRunner({
        messages: [{ role: 'system', content: system }, ...history],
        tools: createButlerTools(),
        onEvent,
      });
      const nextHistory = trimButlerHistory([
        ...result.messages.filter((message) => message.role !== 'system'),
        { role: 'assistant', content: result.text },
      ]);
      set((state) => ({
        lines: result.text
          ? assistantLineId
            ? state.lines.map((item) => item.id === assistantLineId ? { ...item, text: result.text } : item)
            : [...state.lines, line('assistant', result.text)]
          : state.lines,
        activity: null,
        history: nextHistory,
        running: false,
      }));
    } catch (error) {
      const message = brain === 'codex'
        ? `${friendlyButlerCodexError(error).replace(/[。.]$/, '')}。可在设置页切换为 API 大脑。`
        : friendlyButlerError(error);
      set({ activity: null, running: false, error: message });
    }
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
    history: [],
    running: false,
    error: null,
    routineDraft: null,
  }),
}));

setRoutineDraftHandler((draft) => useButler.getState().setRoutineDraft(draft));
