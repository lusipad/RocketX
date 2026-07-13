import { create } from 'zustand';

export interface RepeatRule {
  type: 'daily' | 'weekly' | 'monthly' | 'yearly' | 'weekday' | 'custom';
  interval: number;
  weekdays?: number[]; // 0=Sun … 6=Sat（custom 周重复用）
  endDate?: string;    // YYYY-MM-DD
  endAfter?: number;   // 重复 N 次后结束
}

export interface CalendarEvent {
  id: string;
  title: string;
  description?: string;
  date: string;       // YYYY-MM-DD
  startTime?: string;  // HH:mm
  endTime?: string;    // HH:mm
  allDay: boolean;
  color: string;
  repeat?: RepeatRule;
  reminder?: number;   // 提前 N 分钟提醒
  source: 'manual' | 'todo' | 'ado';
  sourceId?: string;
  createdAt: number;
}

export type CalendarView = 'month' | 'week' | 'day';

const KEY = 'rcx-calendar';

const COLORS = [
  '#3370ff', '#00b96b', '#7f3bf5', '#f54a45', '#ff8800',
  '#14b8a6', '#f472b6', '#8b5cf6', '#06b6d4', '#84cc16',
];

function load(): CalendarEvent[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]') as CalendarEvent[];
  } catch {
    return [];
  }
}

function persist(events: CalendarEvent[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(events));
  } catch { /* quota */ }
}

function genId(): string {
  return `ce${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

export function randomColor(): string {
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}

/** 某月的日期矩阵（6 行 7 列，包含上月尾和下月头） */
export function monthGrid(year: number, month: number): Date[] {
  const first = new Date(year, month, 1);
  const startDay = first.getDay(); // 0=Sun
  const start = new Date(year, month, 1 - startDay);
  const days: Date[] = [];
  for (let i = 0; i < 42; i++) {
    days.push(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  }
  return days;
}

/** 某周的 7 天（周日开始） */
export function weekDays(date: Date): Date[] {
  const d = new Date(date);
  d.setDate(d.getDate() - d.getDay());
  const days: Date[] = [];
  for (let i = 0; i < 7; i++) {
    days.push(new Date(d.getFullYear(), d.getMonth(), d.getDate() + i));
  }
  return days;
}

export function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function parseDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function matchesRepeat(event: CalendarEvent, targetDate: string): boolean {
  if (!event.repeat) return false;
  const origin = parseDate(event.date);
  const target = parseDate(targetDate);
  if (target < origin) return false;

  const { type, interval, weekdays, endDate, endAfter } = event.repeat;
  if (endDate && targetDate > endDate) return false;

  const diffDays = Math.round((target.getTime() - origin.getTime()) / 86400000);

  let matches = false;
  let occurrenceCount = 0;

  switch (type) {
    case 'daily':
      matches = diffDays % interval === 0;
      occurrenceCount = Math.floor(diffDays / interval);
      break;
    case 'weekday':
      matches = target.getDay() >= 1 && target.getDay() <= 5;
      break;
    case 'weekly':
      matches = diffDays % (interval * 7) === 0;
      occurrenceCount = Math.floor(diffDays / (interval * 7));
      break;
    case 'monthly': {
      const mDiff = (target.getFullYear() - origin.getFullYear()) * 12 +
        (target.getMonth() - origin.getMonth());
      matches = mDiff >= 0 && mDiff % interval === 0 && target.getDate() === origin.getDate();
      occurrenceCount = Math.floor(mDiff / interval);
      break;
    }
    case 'yearly': {
      const yDiff = target.getFullYear() - origin.getFullYear();
      matches = yDiff >= 0 && yDiff % interval === 0 &&
        target.getMonth() === origin.getMonth() && target.getDate() === origin.getDate();
      occurrenceCount = Math.floor(yDiff / interval);
      break;
    }
    case 'custom':
      if (weekdays?.length) {
        const weekNum = Math.floor(diffDays / 7);
        matches = weekNum % interval === 0 && weekdays.includes(target.getDay());
      }
      break;
  }

  if (matches && endAfter != null && occurrenceCount >= endAfter) return false;
  return matches;
}

/** 获取某天的所有事件（含重复事件展开） */
export function eventsForDate(events: CalendarEvent[], dateStr: string): CalendarEvent[] {
  return events.filter(
    (e) => e.date === dateStr || matchesRepeat(e, dateStr),
  );
}

/** 获取日期范围内的所有事件日期 → 事件映射 */
export function eventsInRange(
  events: CalendarEvent[],
  dates: Date[],
): Map<string, CalendarEvent[]> {
  const map = new Map<string, CalendarEvent[]>();
  for (const d of dates) {
    const key = dateKey(d);
    const dayEvents = eventsForDate(events, key);
    if (dayEvents.length > 0) map.set(key, dayEvents);
  }
  return map;
}

export const REPEAT_LABELS: Record<RepeatRule['type'], string> = {
  daily: '每天',
  weekly: '每周',
  monthly: '每月',
  yearly: '每年',
  weekday: '工作日',
  custom: '自定义',
};

export const DAY_NAMES = ['日', '一', '二', '三', '四', '五', '六'];

interface CalendarState {
  events: CalendarEvent[];
  view: CalendarView;
  /** 当前查看的日期（月视图=该月任意一天，周/日视图=具体日期） */
  cursor: string; // YYYY-MM-DD
  selectedDate: string | null;
  setView: (v: CalendarView) => void;
  setCursor: (d: string) => void;
  setSelectedDate: (d: string | null) => void;
  prev: () => void;
  next: () => void;
  today: () => void;
  add: (e: Omit<CalendarEvent, 'id' | 'createdAt'>) => string;
  update: (id: string, patch: Partial<Omit<CalendarEvent, 'id' | 'createdAt' | 'source' | 'sourceId'>>) => void;
  remove: (id: string) => void;
}

function todayStr(): string {
  return dateKey(new Date());
}

export const useCalendar = create<CalendarState>((set, get) => ({
  events: load(),
  view: 'month',
  cursor: todayStr(),
  selectedDate: todayStr(),

  setView: (view) => set({ view }),
  setCursor: (cursor) => set({ cursor }),
  setSelectedDate: (selectedDate) => set({ selectedDate }),

  prev: () => {
    const { view, cursor } = get();
    const d = parseDate(cursor);
    if (view === 'month') d.setMonth(d.getMonth() - 1);
    else if (view === 'week') d.setDate(d.getDate() - 7);
    else d.setDate(d.getDate() - 1);
    set({ cursor: dateKey(d) });
  },
  next: () => {
    const { view, cursor } = get();
    const d = parseDate(cursor);
    if (view === 'month') d.setMonth(d.getMonth() + 1);
    else if (view === 'week') d.setDate(d.getDate() + 7);
    else d.setDate(d.getDate() + 1);
    set({ cursor: dateKey(d) });
  },
  today: () => {
    const t = todayStr();
    set({ cursor: t, selectedDate: t });
  },

  add: (e) => {
    const id = genId();
    const events = [...get().events, { ...e, id, createdAt: Date.now() }];
    set({ events });
    persist(events);
    return id;
  },
  update: (id, patch) => {
    const events = get().events.map((e) => (e.id === id ? { ...e, ...patch } : e));
    set({ events });
    persist(events);
  },
  remove: (id) => {
    const events = get().events.filter((e) => e.id !== id);
    set({ events });
    persist(events);
  },
}));
