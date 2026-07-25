export const BUTLER_TURN_TIMINGS_KEY = 'rcx-butler-v1:turn-timings';

const MAX_TIMINGS = 200;

export interface ButlerToolRoundtrip {
  tool: string;
  ms: number;
}

export interface ButlerTurnTiming {
  at: string;
  threadSetupMs: number;
  resumeMode?: string;
  firstTokenMs?: number;
  toolRoundtrips: ButlerToolRoundtrip[];
  totalMs: number;
  outcome: 'completed' | 'failed';
}

export interface ButlerTurnTimingHandle {
  markFirstToken(): void;
  addToolRoundtrip(tool: string, ms: number): void;
  end(outcome: ButlerTurnTiming['outcome']): void;
}

export interface ButlerTimingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function browserStorage(): ButlerTimingsStorage | undefined {
  return typeof localStorage === 'undefined' ? undefined : localStorage;
}

function validRoundtrip(value: unknown): value is ButlerToolRoundtrip {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.tool === 'string' && typeof entry.ms === 'number' && Number.isFinite(entry.ms);
}

function validTiming(value: unknown): value is ButlerTurnTiming {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.at === 'string'
    && typeof entry.threadSetupMs === 'number'
    && Number.isFinite(entry.threadSetupMs)
    && (entry.resumeMode === undefined || typeof entry.resumeMode === 'string')
    && (entry.firstTokenMs === undefined || (typeof entry.firstTokenMs === 'number' && Number.isFinite(entry.firstTokenMs)))
    && Array.isArray(entry.toolRoundtrips)
    && entry.toolRoundtrips.every(validRoundtrip)
    && typeof entry.totalMs === 'number'
    && Number.isFinite(entry.totalMs)
    && (entry.outcome === 'completed' || entry.outcome === 'failed');
}

export function listButlerTurnTimings(
  storage: ButlerTimingsStorage | undefined = browserStorage(),
): ButlerTurnTiming[] {
  if (!storage) return [];
  try {
    const parsed: unknown = JSON.parse(storage.getItem(BUTLER_TURN_TIMINGS_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(validTiming).slice(-MAX_TIMINGS);
  } catch {
    return [];
  }
}

function appendTiming(timing: ButlerTurnTiming, storage: ButlerTimingsStorage | undefined): void {
  if (!storage) return;
  try {
    storage.setItem(
      BUTLER_TURN_TIMINGS_KEY,
      JSON.stringify([...listButlerTurnTimings(storage), timing].slice(-MAX_TIMINGS)),
    );
  } catch {
    // 计时是诊断手段，存储失败不得影响问答本身。
  }
}

let activeHandle: ButlerTurnTimingHandle | undefined;

/**
 * 开始记录一轮交互问答的分段耗时。单并发（常驻线程一次一轮）；
 * ephemeral/workflow 线路不打点，避免并发污染交互轮的数据。
 */
export function beginButlerTurnTiming(
  info: { threadSetupMs: number; resumeMode?: string },
  storage: ButlerTimingsStorage | undefined = browserStorage(),
  now: () => number = Date.now,
): ButlerTurnTimingHandle {
  const startedAt = now();
  let firstTokenMs: number | undefined;
  const toolRoundtrips: ButlerToolRoundtrip[] = [];
  let done = false;
  const handle: ButlerTurnTimingHandle = {
    markFirstToken: () => {
      if (firstTokenMs === undefined) firstTokenMs = now() - startedAt;
    },
    addToolRoundtrip: (tool, ms) => {
      if (!done) toolRoundtrips.push({ tool, ms });
    },
    end: (outcome) => {
      if (done) return;
      done = true;
      if (activeHandle === handle) activeHandle = undefined;
      appendTiming({
        at: new Date(startedAt).toISOString(),
        threadSetupMs: info.threadSetupMs,
        ...(info.resumeMode ? { resumeMode: info.resumeMode } : {}),
        ...(firstTokenMs === undefined ? {} : { firstTokenMs }),
        toolRoundtrips,
        totalMs: now() - startedAt,
        outcome,
      }, storage);
    },
  };
  activeHandle = handle;
  return handle;
}

/** 记入当前进行中的交互轮；没有进行中的轮时静默丢弃。 */
export function addButlerToolRoundtrip(tool: string, ms: number): void {
  activeHandle?.addToolRoundtrip(tool, ms);
}

function percentile(sorted: readonly number[], q: number): number | undefined {
  if (sorted.length === 0) return undefined;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index];
}

export interface ButlerTimingsSummary {
  count: number;
  completed: number;
  p50TotalMs?: number;
  p95TotalMs?: number;
  p50FirstTokenMs?: number;
  p95FirstTokenMs?: number;
  p50ToolRoundtripMs?: number;
  p95ToolRoundtripMs?: number;
  avgToolCallsPerTurn?: number;
}

export function butlerTimingsSummary(
  timings: readonly ButlerTurnTiming[] = listButlerTurnTimings(),
): ButlerTimingsSummary {
  const completed = timings.filter((timing) => timing.outcome === 'completed');
  const totals = completed.map((timing) => timing.totalMs).sort((a, b) => a - b);
  const firstTokens = completed
    .map((timing) => timing.firstTokenMs)
    .filter((value): value is number => value !== undefined)
    .sort((a, b) => a - b);
  const roundtrips = timings
    .flatMap((timing) => timing.toolRoundtrips.map((entry) => entry.ms))
    .sort((a, b) => a - b);
  const summary: ButlerTimingsSummary = { count: timings.length, completed: completed.length };
  const assign = (key: keyof ButlerTimingsSummary, value: number | undefined) => {
    if (value !== undefined) (summary[key] as number) = value;
  };
  assign('p50TotalMs', percentile(totals, 0.5));
  assign('p95TotalMs', percentile(totals, 0.95));
  assign('p50FirstTokenMs', percentile(firstTokens, 0.5));
  assign('p95FirstTokenMs', percentile(firstTokens, 0.95));
  assign('p50ToolRoundtripMs', percentile(roundtrips, 0.5));
  assign('p95ToolRoundtripMs', percentile(roundtrips, 0.95));
  if (completed.length > 0) {
    summary.avgToolCallsPerTurn = Math.round(
      (completed.reduce((sum, timing) => sum + timing.toolRoundtrips.length, 0) / completed.length) * 10,
    ) / 10;
  }
  return summary;
}

declare global {
  interface Window {
    __butlerTimings?: () => { recent: ButlerTurnTiming[]; summary: ButlerTimingsSummary };
  }
}

if (typeof window !== 'undefined') {
  window.__butlerTimings = () => {
    const timings = listButlerTurnTimings();
    return { recent: timings.slice(-20), summary: butlerTimingsSummary(timings) };
  };
}
