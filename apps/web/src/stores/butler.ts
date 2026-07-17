import { create } from 'zustand';
import { runAgentLoop, type AgentLoopEvent } from '../kernel/ai/agent-loop';
import type { AiMessage } from '../kernel/ai/provider';
import { createButlerTools } from '../lib/butlerTools';

const HISTORY_LIMIT = 40;
const PROVIDER_ERROR = '尚未配置 AI Provider，可在设置页添加；快速搜索与查询不受影响。';

export const BUTLER_SYSTEM_PROMPT = `你是 RocketX 管家，服务于 GTD 与注意力保护。

默认回答简洁，先查证据再回答。找不到时明确说没找到，并给出下一步建议。涉及人名、时间等模糊指代时先用工具查询；出现多个候选时列出证据，请用户二选一。绝不编造数据。

你可以查询消息、联系人与会话、待办、日程、工作项、拉取请求和构建。`;

export interface ButlerLine {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}

export interface ButlerState {
  lines: ButlerLine[];
  activity: string | null;
  history: AiMessage[];
  running: boolean;
  error: string | null;
  ask: (text: string) => Promise<void>;
  reset: () => void;
}

type ButlerLoopRunner = typeof runAgentLoop;

let loopRunner: ButlerLoopRunner = runAgentLoop;

const toolLabels: Record<string, string> = {
  search_messages: '搜索消息',
  search_people_rooms: '查询联系人和会话',
  list_todos: '查询待办',
  list_calendar: '查询日程',
  list_work_items: '查询工作项',
  list_pull_requests: '查询拉取请求',
  list_builds: '查询构建',
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

function friendlyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/unconfigured|尚未配置路由|Provider 不存在/iu.test(message)) return PROVIDER_ERROR;
  return '管家暂时无法回答，请稍后重试。';
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

export function appendButlerLine(role: ButlerLine['role'], text: string): void {
  useButler.setState((state) => ({ lines: [...state.lines, line(role, text)] }));
}

export const useButler = create<ButlerState>((set, get) => ({
  lines: welcomeLines(),
  activity: null,
  history: [],
  running: false,
  error: null,

  ask: async (text) => {
    const content = text.trim();
    if (!content || get().running) return;

    const history = trimButlerHistory([...get().history, { role: 'user', content }]);
    set((state) => ({
      lines: [...state.lines, line('user', content)],
      activity: null,
      history,
      running: true,
      error: null,
    }));

    let assistantLineId: string | undefined;
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
        set({ activity: activityFor(event) });
        return;
      }
      if (event.type === 'tool-result') set({ activity: null });
    };

    try {
      const result = await loopRunner({
        messages: [{ role: 'system', content: BUTLER_SYSTEM_PROMPT }, ...history],
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
      set({ activity: null, running: false, error: friendlyError(error) });
    }
  },

  reset: () => set({
    lines: welcomeLines(),
    activity: null,
    history: [],
    running: false,
    error: null,
  }),
}));
