import { create } from 'zustand';
import {
  isRoundsResult,
  serializeButlerRoundsInput,
  suppressMutedRoundItems,
  type RoundsInput,
  type RoundsResult,
} from '../kernel/ai/features/butler-rounds';
import { useTodos, todayKey } from '../stores/todos';
import { useWorkbench } from '../stores/workbench';
import { runButlerWorkflowTask } from '../stores/butler';
import { mergeButlerSources, type ButlerSource } from './butlerContext';
import { ledgerFromTodos } from './butlerLedger';
import { addMute, listMutes, type ButlerMute } from './butlerMutes';
import {
  collectRecentSentMessages,
  type RecentSentMessage,
} from './butlerOutbox';
import { fetchIterationEndDate } from './butlerPoller';
import { runRoundsWithBrain } from './butlerRoundsBrain';
import {
  createVisibilityRoundHandler,
  maybeEveningRound,
  maybeWakeRound,
  type ButlerRoundTriggerRuntime,
} from './butlerRoundsTriggers';

const LAST_ROUNDS_AT_KEY = 'rcx-butler-v1:rounds-last-at';
const LAST_RESULT_KEY = 'rcx-butler-v1:rounds-last-result';

export interface StoredRoundsResult {
  result: RoundsResult;
  generatedAt: string;
  checkedCount: number;
  refTitles: Record<string, string>;
  refMessages?: Record<string, RecentSentMessage>;
  refPeople?: Record<string, string>;
  refRids?: Record<string, string>;
  snoozedRefs?: string[];
  triggerReason?: string;
}

interface ButlerRoundsRunnerState {
  lastRoundsAt: string | null;
  lastResult: StoredRoundsResult | null;
  running: boolean;
  error: string | null;
}

function browserStorage(): Storage | undefined {
  return typeof localStorage === 'undefined' ? undefined : localStorage;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.values(value).every((item) => typeof item === 'string');
}

function isRecentMessageRecord(value: unknown): value is Record<string, RecentSentMessage> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value).every(([ref, item]) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const message = item as Record<string, unknown>;
    return ref.startsWith('msg:')
      && message.ref === ref
      && typeof message.rid === 'string'
      && typeof message.roomName === 'string'
      && typeof message.peer === 'string'
      && typeof message.text === 'string'
      && typeof message.at === 'string';
  });
}

function loadLastResult(): StoredRoundsResult | null {
  try {
    const raw = browserStorage()?.getItem(LAST_RESULT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredRoundsResult;
    if (
      !parsed ||
      typeof parsed.generatedAt !== 'string' ||
      Number.isNaN(new Date(parsed.generatedAt).getTime()) ||
      !isRoundsResult(parsed.result) ||
      !Number.isInteger(parsed.checkedCount) ||
      parsed.checkedCount < 0 ||
      !isStringRecord(parsed.refTitles)
      || (parsed.refMessages !== undefined && !isRecentMessageRecord(parsed.refMessages))
      || (parsed.refPeople !== undefined && !isStringRecord(parsed.refPeople))
      || (parsed.refRids !== undefined && !isStringRecord(parsed.refRids))
      || (parsed.snoozedRefs !== undefined && (
        !Array.isArray(parsed.snoozedRefs)
        || parsed.snoozedRefs.some((ref) => typeof ref !== 'string')
      ))
      || (parsed.triggerReason !== undefined && (
        typeof parsed.triggerReason !== 'string' || !parsed.triggerReason.trim()
      ))
    ) return null;
    return parsed;
  } catch {
    return null;
  }
}

function persistResult(stored: StoredRoundsResult): void {
  try {
    const storage = browserStorage();
    storage?.setItem(LAST_RESULT_KEY, JSON.stringify(stored));
    storage?.setItem(LAST_ROUNDS_AT_KEY, stored.generatedAt);
  } catch {
    // 存储失败不该让一轮已经生成的结果消失。
  }
}

function localIsoTimestamp(now: Date): string {
  const offset = -now.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const absoluteOffset = Math.abs(offset);
  const date = todayKey(now);
  const time = [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((value) => String(value).padStart(2, '0'))
    .join(':');
  const zone = `${sign}${String(Math.floor(absoluteOffset / 60)).padStart(2, '0')}:${String(absoluteOffset % 60).padStart(2, '0')}`;
  return `${date}T${time}${zone}`;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/Codex 大脑/g, 'Codex 模式')
    .replace(/API 大脑/g, 'API 模式')
    .replace(/大脑/g, '运行模式')
    .replace(/巡视|台账|对账|传感器/g, '内容')
    .replace(/ephemeral/gi, '临时会话');
}

export const useButlerRoundsRunner = create<ButlerRoundsRunnerState>(() => ({
  lastRoundsAt: null,
  lastResult: null,
  running: false,
  error: null,
}));

const initialResult = loadLastResult();
useButlerRoundsRunner.setState({
  lastRoundsAt: initialResult?.generatedAt ?? null,
  lastResult: initialResult,
});

export async function collectButlerRoundsInput(now = new Date()): Promise<RoundsInput> {
  await useWorkbench.getState().refresh();
  const { workItems, prs: pullRequests, builds } = useWorkbench.getState();
  const { todos } = useTodos.getState();
  const lastRoundsAt = useButlerRoundsRunner.getState().lastRoundsAt;
  return {
    ledger: ledgerFromTodos(todos, todayKey(now)),
    todos,
    workItems,
    pullRequests,
    builds,
    iterationEndDate: await fetchIterationEndDate(workItems),
    localTime: localIsoTimestamp(now),
    lastRoundsAt,
    mutes: listMutes(),
    recentSentMessages: collectRecentSentMessages(lastRoundsAt, { now: () => now.getTime() }),
  };
}

let activeRun: Promise<void> | null = null;

function resultDisplaySnapshot(
  input: RoundsInput,
): Pick<StoredRoundsResult, 'checkedCount' | 'refTitles' | 'refMessages' | 'refPeople' | 'refRids'> {
  const snapshot = serializeButlerRoundsInput(input);
  const refTitles: Record<string, string> = {};
  const refMessages: Record<string, RecentSentMessage> = {};
  const refPeople: Record<string, string> = {};
  const refRids: Record<string, string> = {};
  const todosById = new Map(input.todos.map((todo) => [todo.id, todo]));
  for (const entry of snapshot.ledger) refTitles[entry.ref] = entry.title;
  for (const todo of snapshot.todos) refTitles[todo.ref] = todo.title;
  for (const item of snapshot.workItems) refTitles[item.ref] = `#${item.id} ${item.title}`;
  for (const pr of snapshot.pullRequests) refTitles[pr.ref] = `PR #${pr.id} ${pr.title}`;
  for (const build of snapshot.builds) refTitles[build.ref] = `${build.definition} · ${build.project}`;
  for (const entry of snapshot.ledger) {
    refPeople[entry.ref] = entry.who;
    const rid = todosById.get(entry.todoId)?.rid;
    if (rid) refRids[entry.ref] = rid;
  }
  for (const todo of snapshot.todos) {
    const who = todo.committedTo ?? todo.waitingFor;
    if (who) refPeople[todo.ref] = who;
    const rid = todosById.get(todo.id)?.rid;
    if (rid) refRids[todo.ref] = rid;
  }
  for (const item of snapshot.workItems) {
    if (item.assignedTo) refPeople[item.ref] = item.assignedTo;
  }
  for (const pr of snapshot.pullRequests) refPeople[pr.ref] = pr.creator;
  for (const message of snapshot.recentSentMessages) {
    refTitles[message.ref] = message.text;
    refMessages[message.ref] = message;
    refPeople[message.ref] = message.peer;
    refRids[message.ref] = message.rid;
  }
  return {
    checkedCount: snapshot.ledger.length
      + snapshot.todos.length
      + snapshot.workItems.length
      + snapshot.pullRequests.length
      + snapshot.builds.length
      + snapshot.recentSentMessages.length,
    refTitles,
    refMessages,
    refPeople,
    refRids,
  };
}

export function butlerRoundsSources(input: RoundsInput, refs?: readonly string[]): ButlerSource[] {
  const snapshot = serializeButlerRoundsInput(input);
  const sources = new Map<string, ButlerSource>();
  const todos = new Map(input.todos.map((todo) => [todo.id, todo]));
  const workItems = new Map(input.workItems.map((item) => [item.id, item]));
  const pullRequests = new Map(input.pullRequests.map((item) => [item.id, item]));
  const builds = new Map(input.builds.map((item) => [item.id, item]));

  for (const item of snapshot.todos) {
    const todo = todos.get(item.id);
    sources.set(item.ref, {
      kind: 'todo',
      id: item.id,
      label: item.title,
      ...(todo?.rid ? { rid: todo.rid } : {}),
      ...(todo?.mid ? { mid: todo.mid } : {}),
      ...(todo?.adoProject ? { project: todo.adoProject } : {}),
    });
  }
  for (const item of snapshot.ledger) {
    const todoSource = sources.get(`todo:${item.todoId}`);
    if (todoSource) sources.set(item.ref, todoSource);
  }
  for (const item of snapshot.workItems) {
    const workItem = workItems.get(item.id);
    sources.set(item.ref, {
      kind: 'work-item',
      id: String(item.id),
      label: `#${item.id} ${item.title}`,
      project: item.project,
      ...(workItem?.webUrl ? { webUrl: workItem.webUrl } : {}),
    });
  }
  for (const item of snapshot.pullRequests) {
    const pullRequest = pullRequests.get(item.id);
    sources.set(item.ref, {
      kind: 'pull-request',
      id: String(item.id),
      label: `PR #${item.id} ${item.title}`,
      ...(pullRequest?.project || item.repo ? { project: pullRequest?.project ?? item.repo } : {}),
      ...(pullRequest?.webUrl ? { webUrl: pullRequest.webUrl } : {}),
    });
  }
  for (const item of snapshot.builds) {
    const build = builds.get(item.id);
    sources.set(item.ref, {
      kind: 'build',
      id: `${item.definition}|${item.project}`,
      label: `构建 ${item.buildNumber}`,
      project: item.project,
      ...(build?.webUrl ? { webUrl: build.webUrl } : {}),
    });
  }
  for (const message of snapshot.recentSentMessages) {
    const id = message.ref.slice('msg:'.length);
    sources.set(message.ref, {
      kind: 'message',
      id,
      mid: id,
      rid: message.rid,
      label: `${message.roomName}：${message.text}`,
    });
  }

  const orderedRefs = refs ?? [
    ...snapshot.todos.map((item) => item.ref),
    ...snapshot.workItems.map((item) => item.ref),
    ...snapshot.pullRequests.map((item) => item.ref),
    ...snapshot.builds.map((item) => item.ref),
    ...snapshot.recentSentMessages.map((item) => item.ref),
  ];
  return mergeButlerSources(orderedRefs.flatMap((ref) => {
    const source = sources.get(ref);
    return source ? [source] : [];
  }));
}

export function runButlerRoundsNow(now = new Date(), triggerReason?: string): Promise<void> {
  if (activeRun) return activeRun;
  const task = (async () => {
    useButlerRoundsRunner.setState({ running: true, error: null });
    try {
      const input = await collectButlerRoundsInput(now);
      const contextSources = butlerRoundsSources(input);
      const reason = triggerReason?.trim() || 'manual';
      const result = await runButlerWorkflowTask({
        key: 'rounds:today',
        kind: 'rounds',
        goal: '生成 Today 主动简报',
        triggerReason: reason,
        context: {
          kind: 'surface',
          label: 'Today',
          detail: '主动简报只保留最多三条必须提醒的事项、原因和建议动作。',
          sources: contextSources,
        },
        sources: [],
        execute: async () => {
          const value = await runRoundsWithBrain(input);
          const sources = butlerRoundsSources(input, value.items.map((item) => item.ref));
          return {
            value,
            summary: [value.headline, value.summary].filter(Boolean).join('：'),
            sources,
          };
        },
      });
      const stored = {
        result,
        generatedAt: now.toISOString(),
        triggerReason: reason,
        ...resultDisplaySnapshot(input),
      } satisfies StoredRoundsResult;
      persistResult(stored);
      useButlerRoundsRunner.setState({
        lastRoundsAt: stored.generatedAt,
        lastResult: stored,
        error: null,
      });
    } catch (error) {
      // 上一轮仍然有参考价值，失败只增加一行错误，不清空结果。
      useButlerRoundsRunner.setState({ error: errorMessage(error) });
    } finally {
      useButlerRoundsRunner.setState({ running: false });
    }
  })();
  activeRun = task.finally(() => {
    activeRun = null;
  });
  return activeRun;
}

export function muteButlerRoundsItem(title: string): ButlerMute | null {
  const mute = addMute(title);
  if (!mute) return null;
  const current = useButlerRoundsRunner.getState().lastResult;
  if (!current) return mute;
  const result = suppressMutedRoundItems(current.result, current.refTitles, listMutes());
  if (result === current.result) return mute;
  const stored = { ...current, result };
  persistResult(stored);
  useButlerRoundsRunner.setState({ lastResult: stored });
  return mute;
}

export function visibleButlerRoundItems(stored: StoredRoundsResult | null | undefined): RoundsResult['items'] {
  if (!stored) return [];
  const snoozed = new Set(stored.snoozedRefs ?? []);
  return stored.result.items.filter((item) => !snoozed.has(item.ref));
}

export function snoozeButlerRoundsItem(ref: string): boolean {
  const current = useButlerRoundsRunner.getState().lastResult;
  if (!current || !current.result.items.some((item) => item.ref === ref)) return false;
  const snoozedRefs = [...new Set([...(current.snoozedRefs ?? []), ref])];
  const stored = { ...current, snoozedRefs };
  persistResult(stored);
  useButlerRoundsRunner.setState({ lastResult: stored });
  return true;
}

function triggerStorage(): Storage | undefined {
  return browserStorage();
}

function triggerRuntime(storage: Storage): ButlerRoundTriggerRuntime {
  return {
    storage,
    getState: () => {
      const state = useButlerRoundsRunner.getState();
      return { running: state.running, lastRoundsAt: state.lastRoundsAt };
    },
    run: (now, reason) => runButlerRoundsNow(now, reason),
  };
}

export function maybeEveningButlerRound(now = new Date()): Promise<boolean> {
  const storage = triggerStorage();
  return storage ? maybeEveningRound(now, triggerRuntime(storage)) : Promise.resolve(false);
}

export function maybeWakeButlerRound(reason: string, now = new Date()): Promise<boolean> {
  const storage = triggerStorage();
  return storage ? maybeWakeRound(reason, now, triggerRuntime(storage)) : Promise.resolve(false);
}

let visibilityCleanup: (() => void) | null = null;

export function startButlerRoundsTriggers(): void {
  if (visibilityCleanup || typeof document === 'undefined') return;
  const storage = triggerStorage();
  if (!storage) return;
  const handleVisibility = createVisibilityRoundHandler(triggerRuntime(storage));
  const listener = () => void handleVisibility(document.visibilityState, new Date());
  document.addEventListener('visibilitychange', listener);
  visibilityCleanup = () => {
    document.removeEventListener('visibilitychange', listener);
    visibilityCleanup = null;
  };
}

export function stopButlerRoundsTriggers(): void {
  visibilityCleanup?.();
}

export function runDailyButlerRoundsIfNeeded(now = new Date()): Promise<void> {
  const lastResultAt = useButlerRoundsRunner.getState().lastResult?.generatedAt;
  if (lastResultAt && todayKey(new Date(lastResultAt)) === todayKey(now)) {
    return Promise.resolve();
  }
  return runButlerRoundsNow(now, 'daily');
}
