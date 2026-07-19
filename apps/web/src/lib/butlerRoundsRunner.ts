import { create } from 'zustand';
import {
  isRoundsResult,
  serializeButlerRoundsInput,
  type RoundsInput,
  type RoundsResult,
} from '../kernel/ai/features/butler-rounds';
import { useTodos, todayKey } from '../stores/todos';
import { useWorkbench } from '../stores/workbench';
import { ledgerFromTodos } from './butlerLedger';
import { fetchIterationEndDate } from './butlerPoller';
import { runRoundsWithBrain } from './butlerRoundsBrain';

const LAST_ROUNDS_AT_KEY = 'rcx-butler-v1:rounds-last-at';
const LAST_RESULT_KEY = 'rcx-butler-v1:rounds-last-result';

export interface StoredRoundsResult {
  result: RoundsResult;
  generatedAt: string;
  checkedCount: number;
  refTitles: Record<string, string>;
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
      !parsed.refTitles ||
      typeof parsed.refTitles !== 'object' ||
      Array.isArray(parsed.refTitles) ||
      Object.values(parsed.refTitles).some((title) => typeof title !== 'string')
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
  return {
    ledger: ledgerFromTodos(todos, todayKey(now)),
    todos,
    workItems,
    pullRequests,
    builds,
    iterationEndDate: await fetchIterationEndDate(workItems),
    localTime: localIsoTimestamp(now),
    lastRoundsAt: useButlerRoundsRunner.getState().lastRoundsAt,
  };
}

let activeRun: Promise<void> | null = null;

function resultDisplaySnapshot(input: RoundsInput): Pick<StoredRoundsResult, 'checkedCount' | 'refTitles'> {
  const snapshot = serializeButlerRoundsInput(input);
  const refTitles: Record<string, string> = {};
  for (const entry of snapshot.ledger) refTitles[entry.ref] = entry.title;
  for (const todo of snapshot.todos) refTitles[todo.ref] = todo.title;
  for (const item of snapshot.workItems) refTitles[item.ref] = `#${item.id} ${item.title}`;
  for (const pr of snapshot.pullRequests) refTitles[pr.ref] = `PR #${pr.id} ${pr.title}`;
  for (const build of snapshot.builds) refTitles[build.ref] = `${build.definition} · ${build.project}`;
  return {
    checkedCount: snapshot.ledger.length
      + snapshot.todos.length
      + snapshot.workItems.length
      + snapshot.pullRequests.length
      + snapshot.builds.length,
    refTitles,
  };
}

export function runButlerRoundsNow(now = new Date()): Promise<void> {
  if (activeRun) return activeRun;
  const task = (async () => {
    useButlerRoundsRunner.setState({ running: true, error: null });
    try {
      const input = await collectButlerRoundsInput(now);
      const result = await runRoundsWithBrain(input);
      const stored = {
        result,
        generatedAt: now.toISOString(),
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

export function runDailyButlerRoundsIfNeeded(now = new Date()): Promise<void> {
  const lastResultAt = useButlerRoundsRunner.getState().lastResult?.generatedAt;
  if (lastResultAt && todayKey(new Date(lastResultAt)) === todayKey(now)) {
    return Promise.resolve();
  }
  return runButlerRoundsNow(now);
}
