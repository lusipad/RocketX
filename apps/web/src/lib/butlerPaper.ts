import { visibleButlerErrands, type ButlerErrandRun } from './butlerErrands';
import {
  readButlerRoundsResultForDate,
  type StoredRoundsResult,
} from './butlerRoundsRunner';
import type { Todo } from '../stores/todos';

export interface ButlerPaperErrandSections {
  approvals: ButlerErrandRun[];
  active: ButlerErrandRun[];
}

export interface ButlerPaperViewModel {
  dateKey: string;
  isToday: boolean;
  errands: ButlerPaperErrandSections;
  todos: Todo[];
  archived: ButlerErrandRun[];
  brief: StoredRoundsResult | null;
}

export function butlerPaperDateKey(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function dateFromKey(key: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) return new Date(Number.NaN);
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
}

export function shiftButlerPaperDate(key: string, days: number): string {
  const date = dateFromKey(key);
  if (Number.isNaN(date.getTime())) return key;
  date.setDate(date.getDate() + days);
  return butlerPaperDateKey(date);
}

export function formatButlerPaperDate(key: string): string {
  const date = dateFromKey(key);
  if (Number.isNaN(date.getTime())) return key;
  return `${date.getMonth() + 1}月${date.getDate()}日 周${'日一二三四五六'[date.getDay()]}`;
}

function timestampDateKey(value: string | number): string | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : butlerPaperDateKey(date);
}

export function partitionButlerPaperErrands(
  runs: readonly ButlerErrandRun[],
): ButlerPaperErrandSections {
  const visible = visibleButlerErrands(runs);
  return {
    approvals: visible.filter((run) => run.status === 'awaiting-approval'),
    active: visible.filter((run) => run.status !== 'awaiting-approval'),
  };
}

export function archivedButlerErrandsForDate(
  runs: readonly ButlerErrandRun[],
  key: string,
): ButlerErrandRun[] {
  return [...runs]
    .filter((run) => run.archivedAt && timestampDateKey(run.archivedAt) === key)
    .sort((left, right) => (right.archivedAt ?? 0) - (left.archivedAt ?? 0));
}

export function visibleButlerTodos(todos: readonly Todo[]): Todo[] {
  return [...todos]
    .filter((todo) => !todo.done)
    .sort((left, right) => {
      if (left.due && right.due) {
        const byDue = left.due.localeCompare(right.due);
        if (byDue !== 0) return byDue;
      } else if (left.due) {
        return -1;
      } else if (right.due) {
        return 1;
      }
      return right.createdAt - left.createdAt;
    });
}

export function buildButlerPaperViewModel({
  dateKey,
  todayKey,
  runs,
  todos,
  brief,
}: {
  dateKey: string;
  todayKey: string;
  runs: readonly ButlerErrandRun[];
  todos: readonly Todo[];
  brief: StoredRoundsResult | null;
}): ButlerPaperViewModel {
  const isToday = dateKey === todayKey;
  return {
    dateKey,
    isToday,
    errands: isToday
      ? partitionButlerPaperErrands(runs)
      : { approvals: [], active: [] },
    todos: isToday ? visibleButlerTodos(todos) : [],
    archived: isToday ? [] : archivedButlerErrandsForDate(runs, dateKey),
    brief,
  };
}

export function butlerBriefForDate(
  brief: StoredRoundsResult | null,
  key: string,
): StoredRoundsResult | null {
  if (brief && timestampDateKey(brief.generatedAt) === key) return brief;
  return readButlerRoundsResultForDate(key);
}

export function shouldExpandButlerConversation(rounds: number): boolean {
  return rounds > 2;
}
