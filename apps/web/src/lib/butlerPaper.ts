import { visibleButlerErrands, type ButlerErrandRun } from './butlerErrands';
import type { StoredRoundsResult } from './butlerRoundsRunner';

export interface ButlerPaperErrandSections {
  approvals: ButlerErrandRun[];
  active: ButlerErrandRun[];
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

export function butlerBriefForDate(
  brief: StoredRoundsResult | null,
  key: string,
): StoredRoundsResult | null {
  return brief && timestampDateKey(brief.generatedAt) === key ? brief : null;
}

export function shouldExpandButlerConversation(rounds: number): boolean {
  return rounds > 2;
}
