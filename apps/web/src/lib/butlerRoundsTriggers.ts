import { latestBuildsByDefinitionProject, type ButlerBuildIdentity } from './butlerBuilds';
import type { WorkItem } from '../stores/workbench';

export const EVENING_ROUND_DATE_KEY = 'rcx-butler-v1:rounds-evening-date';
export const POLLER_BASELINE_KEY = 'rcx-butler-v1:poller-baseline';
export const WAKE_ROUND_AT_KEY = 'rcx-butler-v1:rounds-wake-at';

const ROUND_COOLDOWN_MS = 10 * 60 * 1000;
const AWAY_TRIGGER_MS = 2 * 60 * 60 * 1000;
const WAKE_LIMIT_MS = 60 * 60 * 1000;

export interface ButlerRoundTriggerStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ButlerRoundTriggerRuntime {
  storage: ButlerRoundTriggerStorage;
  getState(): { running: boolean; lastRoundsAt: string | null };
  run(now: Date, reason: string): Promise<void>;
}

interface PollerBaseline {
  wiIds: number[];
  buildResults: Record<string, string>;
}

interface BaselineBuild extends ButlerBuildIdentity {
  result: string;
}

function dateKey(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function canTriggerRound(now: Date, runtime: ButlerRoundTriggerRuntime): boolean {
  const state = runtime.getState();
  if (state.running) return false;
  if (!state.lastRoundsAt) return true;
  const last = Date.parse(state.lastRoundsAt);
  return !Number.isFinite(last) || now.getTime() - last >= ROUND_COOLDOWN_MS;
}

export async function maybeEveningRound(
  now: Date,
  runtime: ButlerRoundTriggerRuntime,
): Promise<boolean> {
  if (now.getHours() < 18) return false;
  const today = dateKey(now);
  if (runtime.storage.getItem(EVENING_ROUND_DATE_KEY) === today) return false;
  if (!canTriggerRound(now, runtime)) return false;
  runtime.storage.setItem(EVENING_ROUND_DATE_KEY, today);
  await runtime.run(now, '18 点后的第一次收尾');
  return true;
}

export function createVisibilityRoundHandler(runtime: ButlerRoundTriggerRuntime) {
  let hiddenAt: number | null = null;
  return async (visibility: 'hidden' | 'visible', now: Date): Promise<boolean> => {
    if (visibility === 'hidden') {
      hiddenAt = now.getTime();
      return false;
    }

    const awayMs = hiddenAt === null ? 0 : now.getTime() - hiddenAt;
    hiddenAt = null;
    if (awayMs > AWAY_TRIGGER_MS && canTriggerRound(now, runtime)) {
      await runtime.run(now, '离开超过 2 小时后回来');
      return true;
    }
    return maybeEveningRound(now, runtime);
  };
}

function buildKey(build: ButlerBuildIdentity): string {
  return `${build.definition}\0${build.project ?? ''}`;
}

function currentBaseline(
  workItems: readonly WorkItem[],
  builds: readonly BaselineBuild[],
): PollerBaseline {
  return {
    wiIds: [...new Set(workItems.map((item) => item.id))].sort((left, right) => left - right),
    buildResults: Object.fromEntries(
      latestBuildsByDefinitionProject(builds).map((build) => [buildKey(build), build.result]),
    ),
  };
}

function loadBaseline(storage: ButlerRoundTriggerStorage): PollerBaseline | null {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(POLLER_BASELINE_KEY) ?? 'null');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const baseline = parsed as Record<string, unknown>;
    if (!Array.isArray(baseline.wiIds) || baseline.wiIds.some((id) => !Number.isInteger(id))) {
      return null;
    }
    if (!baseline.buildResults || typeof baseline.buildResults !== 'object' || Array.isArray(baseline.buildResults)) {
      return null;
    }
    if (Object.values(baseline.buildResults).some((result) => typeof result !== 'string')) {
      return null;
    }
    return baseline as unknown as PollerBaseline;
  } catch {
    return null;
  }
}

export function evaluatePollerWake(
  workItems: readonly WorkItem[],
  builds: readonly BaselineBuild[],
  storage: ButlerRoundTriggerStorage,
): string | null {
  const previous = loadBaseline(storage);
  const current = currentBaseline(workItems, builds);
  storage.setItem(POLLER_BASELINE_KEY, JSON.stringify(current));
  if (!previous) return null;

  const knownIds = new Set(previous.wiIds);
  const newIds = current.wiIds.filter((id) => !knownIds.has(id));
  const failedBuilds = Object.entries(current.buildResults)
    .filter(([key, result]) => (
      result.toLocaleLowerCase() === 'failed'
      && previous.buildResults[key] !== undefined
      && previous.buildResults[key].toLocaleLowerCase() !== 'failed'
    ))
    .map(([key]) => {
      const [definition, project] = key.split('\0');
      return project ? `${definition}（${project}）` : definition;
    });

  const reasons: string[] = [];
  if (newIds.length) reasons.push(`发现新指派工作项 ${newIds.map((id) => `#${id}`).join('、')}`);
  if (failedBuilds.length) reasons.push(`发现流水线 ${failedBuilds.join('、')} 转红`);
  return reasons.length ? reasons.join('；') : null;
}

export async function maybeWakeRound(
  reason: string,
  now: Date,
  runtime: ButlerRoundTriggerRuntime,
): Promise<boolean> {
  if (!reason.trim()) return false;
  const lastWakeAt = Number(runtime.storage.getItem(WAKE_ROUND_AT_KEY));
  if (Number.isFinite(lastWakeAt) && lastWakeAt > 0 && now.getTime() - lastWakeAt < WAKE_LIMIT_MS) {
    return false;
  }
  if (!canTriggerRound(now, runtime)) return false;
  runtime.storage.setItem(WAKE_ROUND_AT_KEY, String(now.getTime()));
  await runtime.run(now, reason);
  return true;
}
