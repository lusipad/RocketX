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
  date: string;        // YYYY-MM-DD
  startTime?: string;  // HH:mm
  endTime?: string;    // HH:mm
  allDay: boolean;
  color: string;
  repeat?: RepeatRule;
  /**
   * 日历只做「记录 + 看得见」，不做提醒。
   * 之前有个 reminder 字段，能在弹窗里设「提前 15 分钟提醒」、也存进了数据 ——
   * 但全仓库没有任何代码去触发它。一个永远不会响的提醒，比没有提醒更糟。
   * 与其半吊子地实现通知，不如老实承认这是个记事本。
   */
  source: 'manual';
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

/** 周起始日：0=周日，1=周一。国内习惯周一，默认周一。 */
export type WeekStart = 0 | 1;
export const WEEK_START: WeekStart = 1;

/** date 所在周的第一天（按 WEEK_START） */
export function startOfWeek(date: Date, weekStart: WeekStart = WEEK_START): Date {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const shift = (d.getDay() - weekStart + 7) % 7;
  d.setDate(d.getDate() - shift);
  return d;
}

/**
 * 某月的日期矩阵。
 * 行数按需要计算（5 或 6 行），不再恒定 42 格 —— 有些月份会白白多出一整行灰色的下月日期。
 */
export function monthGrid(year: number, month: number, weekStart: WeekStart = WEEK_START): Date[] {
  const first = new Date(year, month, 1);
  const start = startOfWeek(first, weekStart);
  const lastOfMonth = new Date(year, month + 1, 0);
  const end = startOfWeek(lastOfMonth, weekStart);
  end.setDate(end.getDate() + 6);

  const days: Date[] = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    days.push(new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate()));
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

/** 某周的 7 天 */
export function weekDays(date: Date, weekStart: WeekStart = WEEK_START): Date[] {
  const d = startOfWeek(date, weekStart);
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

/**
 * 重复日程是否落在 targetDate 上。
 *
 * 这里原来有四个实打实的错误，都是「看起来能跑、边界上全错」的类型：
 *
 * 1. weekday / custom 从不给 occurrenceCount 赋值，于是「重复 N 次后结束」永远
 *    不成立 —— 设了「工作日重复，5 次后结束」，它会无限重复下去。
 * 2. monthly 的 31 号、yearly 的 2/29，在没有该日期的月份/年份里被静默吞掉，
 *    但次数仍按「月份差 / 年份差」计算 —— 用户要 3 次，实际只拿到 2 次。
 * 3. custom 的「隔 N 周」锚定在原始日期上（floor(diffDays/7)），不是自然周。
 *    周三创建的「每两周的周一和周五」，会把周五和「下周一」算成同一期。
 * 4. custom 一个星期几都不选时，规则静默失效，保存后变成一个普通的不重复事件，
 *    没有任何提示。
 *
 * 现在的做法：先算出「这是第几次发生」（occurrence），再判断是否命中和是否超次。
 * 次数按**实际发生**计数，不按月份/年份差。
 */
function matchesRepeat(event: CalendarEvent, targetDate: string): boolean {
  if (!event.repeat) return false;
  const origin = parseDate(event.date);
  const target = parseDate(targetDate);
  if (target < origin) return false;

  const { type, interval, weekdays, endDate, endAfter } = event.repeat;
  if (endDate && targetDate > endDate) return false;

  const step = Math.max(1, interval || 1);
  const diffDays = Math.round((target.getTime() - origin.getTime()) / 86400000);

  let matches = false;
  /** 这是第几次发生（原始日期算第 0 次）；-1 表示不适用 */
  let occurrence = -1;

  switch (type) {
    case 'daily':
      matches = diffDays % step === 0;
      occurrence = diffDays / step;
      break;

    case 'weekly':
      matches = diffDays % (step * 7) === 0;
      occurrence = diffDays / (step * 7);
      break;

    case 'weekday': {
      // 工作日重复：周一到周五。原始日期若是周末，那天不该出现
      // （eventsForDate 里的 `e.date === dateStr ||` 会短路，所以要在这里挡掉）
      const dow = target.getDay();
      matches = dow >= 1 && dow <= 5;
      if (matches) {
        // 实际发生次数 = origin 到 target 之间有多少个工作日（含 target，不含 origin 之前）
        occurrence = countWeekdaysBetween(origin, target) - 1;
      }
      break;
    }

    case 'monthly': {
      const mDiff =
        (target.getFullYear() - origin.getFullYear()) * 12 +
        (target.getMonth() - origin.getMonth());
      if (mDiff >= 0 && mDiff % step === 0) {
        // 31 号遇到只有 30 天的月份：回退到当月最后一天（RFC 5545 与各家日历的通行做法），
        // 而不是整月跳过
        const day = clampDayOfMonth(target.getFullYear(), target.getMonth(), origin.getDate());
        matches = target.getDate() === day;
      }
      if (matches) occurrence = mDiff / step;
      break;
    }

    case 'yearly': {
      const yDiff = target.getFullYear() - origin.getFullYear();
      if (yDiff >= 0 && yDiff % step === 0 && target.getMonth() === origin.getMonth()) {
        // 2/29 遇到平年：回退到 2/28
        const day = clampDayOfMonth(target.getFullYear(), target.getMonth(), origin.getDate());
        matches = target.getDate() === day;
      }
      if (matches) occurrence = yDiff / step;
      break;
    }

    case 'custom': {
      // 一个星期几都没选 = 规则无效，当作不重复（保存时会拦住，这里兜底）
      if (!weekdays?.length) return false;
      // 按**自然周**算周差，而不是「距原始日期的滚动 7 天」
      const originWeek = startOfWeek(origin).getTime();
      const targetWeek = startOfWeek(target).getTime();
      const weekDiff = Math.round((targetWeek - originWeek) / (7 * 86400000));
      matches = weekDiff % step === 0 && weekdays.includes(target.getDay());
      if (matches) {
        // 每一期发生 weekdays.length 次；本期内按星期几排序确定是第几次
        const sorted = [...weekdays].sort((a, b) => a - b);
        const idxInWeek = sorted.indexOf(target.getDay());
        occurrence = (weekDiff / step) * sorted.length + idxInWeek;
        // 原始日期那一周里，早于原始日期的那些星期几不算发生过
        if (weekDiff === 0) {
          const originIdx = sorted.findIndex((d) => d >= origin.getDay());
          occurrence -= originIdx < 0 ? 0 : originIdx;
        }
      }
      break;
    }
  }

  if (!matches) return false;
  if (endAfter != null && occurrence >= 0 && occurrence >= endAfter) return false;
  return true;
}

/** 某年某月里，把 day 限制到该月实际存在的日期（31 → 2 月变 28/29） */
function clampDayOfMonth(year: number, month: number, day: number): number {
  const lastDay = new Date(year, month + 1, 0).getDate();
  return Math.min(day, lastDay);
}

/** [from, to] 之间的工作日数量（含两端） */
function countWeekdaysBetween(from: Date, to: Date): number {
  let n = 0;
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  while (d <= to) {
    const dow = d.getDay();
    if (dow >= 1 && dow <= 5) n++;
    d.setDate(d.getDate() + 1);
  }
  return n;
}

/** 获取某天的所有事件（含重复事件展开） */
export function eventsForDate(events: CalendarEvent[], dateStr: string): CalendarEvent[] {
  return events.filter((e) => {
    // 有重复规则时，原始日期也必须由规则说了算 ——
    // 否则「周六创建的工作日重复事件」会让那个周六孤零零地冒出来一次
    if (e.repeat) return matchesRepeat(e, dateStr);
    return e.date === dateStr;
  });
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

/** 星期名，索引 = Date.getDay() */
export const DAY_NAMES = ['日', '一', '二', '三', '四', '五', '六'];

/** 表头用的星期名，按 WEEK_START 排列（周一起始 → 一 二 三 四 五 六 日） */
export const WEEK_HEADERS = Array.from(
  { length: 7 },
  (_, i) => DAY_NAMES[(i + WEEK_START) % 7],
);

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
  update: (id: string, patch: Partial<Omit<CalendarEvent, 'id' | 'createdAt'>>) => void;
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

  setView: (view) => {
    // 切到日视图时，让 selectedDate 与 cursor 对齐，避免两套日期打架
    if (view === 'day') set({ view, selectedDate: get().cursor });
    else set({ view });
  },
  setCursor: (cursor) => set({ cursor }),
  setSelectedDate: (selectedDate) => set({ selectedDate }),

  /**
   * 翻页。
   *
   * 日视图必须连 selectedDate 一起翻 —— 之前只改 cursor，而日视图的列表读的是
   * selectedDate：点「下一天」标题日期在变，下面的日程纹丝不动。一个视图里两套日期真相。
   */
  prev: () => {
    const { view, cursor } = get();
    const d = parseDate(cursor);
    if (view === 'month') d.setMonth(d.getMonth() - 1);
    else if (view === 'week') d.setDate(d.getDate() - 7);
    else d.setDate(d.getDate() - 1);
    const next = dateKey(d);
    set(view === 'day' ? { cursor: next, selectedDate: next } : { cursor: next });
  },
  next: () => {
    const { view, cursor } = get();
    const d = parseDate(cursor);
    if (view === 'month') d.setMonth(d.getMonth() + 1);
    else if (view === 'week') d.setDate(d.getDate() + 7);
    else d.setDate(d.getDate() + 1);
    const next = dateKey(d);
    set(view === 'day' ? { cursor: next, selectedDate: next } : { cursor: next });
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
