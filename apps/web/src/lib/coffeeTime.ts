import { todayKey } from '../stores/todos';

const CONFIG_KEY = 'rcx-coffee-time';
const STATE_KEY = 'rcx-coffee-time-state';

export interface CoffeeTimeConfig {
  enabled: boolean;
  /** 每天触发的时间点列表，HH:MM 24 小时制 */
  times: string[];
}

interface CoffeeTimeState {
  /** 今天已经触发过的时间点 */
  shownTimes: Record<string, string[]>;
}

export const DEFAULT_TIMES = ['09:00', '19:00'];
const DEFAULT_CONFIG: CoffeeTimeConfig = { enabled: true, times: DEFAULT_TIMES };

export function loadCoffeeConfig(): CoffeeTimeConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return DEFAULT_CONFIG;
    const parsed = JSON.parse(raw) as Partial<CoffeeTimeConfig>;
    // 兼容旧版单时间点格式
    if ('time' in parsed && !('times' in parsed)) {
      const t = (parsed as { time: unknown }).time;
      return { enabled: parsed.enabled ?? true, times: typeof t === 'string' ? [t] : DEFAULT_TIMES };
    }
    const times = Array.isArray(parsed.times) ? parsed.times.filter((t): t is string => typeof t === 'string' && /^\d{2}:\d{2}$/.test(t)) : DEFAULT_TIMES;
    return { enabled: parsed.enabled ?? true, times: times.length > 0 ? times : DEFAULT_TIMES };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function saveCoffeeConfig(config: CoffeeTimeConfig): void {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
}

function loadState(): CoffeeTimeState {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (!raw) return { shownTimes: {} };
    const parsed = JSON.parse(raw) as { shownTimes?: unknown };
    const shownTimes = (parsed.shownTimes && typeof parsed.shownTimes === 'object' && !Array.isArray(parsed.shownTimes))
      ? parsed.shownTimes as Record<string, unknown>
      : {};
    const validated: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(shownTimes)) {
      if (Array.isArray(v)) validated[k] = v.filter((x): x is string => typeof x === 'string');
    }
    return { shownTimes: validated };
  } catch {
    return { shownTimes: {} };
  }
}

function saveState(state: CoffeeTimeState): void {
  localStorage.setItem(STATE_KEY, JSON.stringify(state));
}

function shownTimesToday(): string[] {
  const state = loadState();
  return state.shownTimes[todayKey()] ?? [];
}

function markTimeShown(time: string): void {
  const state = loadState();
  const today = todayKey();
  const todayShown = state.shownTimes[today] ?? [];
  if (!todayShown.includes(time)) {
    todayShown.push(time);
  }
  // 只保留今天的记录，清理旧日期
  state.shownTimes = { [today]: todayShown };
  saveState(state);
}

export function wasCoffeeTimeShownToday(): boolean {
  return shownTimesToday().length > 0;
}

/**
 * 返回现在应该触发的时间点列表（可能有多个——错过了好几个时段后才打开客户端）。
 * 已触发过的不再重复。
 */
export function pendingCoffeeTimes(now = new Date()): string[] {
  const config = loadCoffeeConfig();
  if (!config.enabled || config.times.length === 0) return [];

  const shown = shownTimesToday();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  return config.times
    .filter((t) => {
      if (shown.includes(t)) return false;
      const [h, m] = t.split(':').map(Number);
      return nowMinutes >= h * 60 + m;
    })
    .sort();
}

// ─── 调度器 ───

let timer: ReturnType<typeof setInterval> | null = null;
let onTrigger: ((missed: number) => void) | null = null;

function tick(): void {
  const pending = pendingCoffeeTimes();
  if (pending.length === 0) return;

  for (const time of pending) {
    markTimeShown(time);
  }
  onTrigger?.(pending.length);
}

/**
 * 启动咖啡时间调度器。
 * @param callback 触发时执行，参数为本次触发包含的时间点数量（>1 说明有错过的）
 */
export function startCoffeeScheduler(callback: (missed: number) => void): void {
  if (timer) return;
  onTrigger = callback;
  tick();
  timer = setInterval(tick, 60_000);
}

export function stopCoffeeScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  onTrigger = null;
}
