import { tsMs } from '@rcx/rc-client';
import { create } from 'zustand';
import { runCodexAutomation, type CodexAutomationOptions } from '../agent/codexAutomation';
import {
  findButlerAbilityTemplate,
  type ButlerAbilityTemplate,
  type ButlerAbilityTemplateId,
  type RoutinePrecheck,
} from '../lib/butlerAbilityTemplates';
import { shouldRunRoutine } from '../lib/routinePrecheck';
import { checkWatchers, type ButlerEventCard, type ButlerWatcherSnapshot } from '../lib/butlerWatchers';
import { useChat } from './chat';
import { useCodexWorkspace } from './codexWorkspace';
import { useAuth } from './auth';

const ROUTINES_KEY = 'rcx-codex-automations-v1:routines';
const WATCHER_KEYS_KEY = 'rcx-codex-automations-v1:watcher-seen';
const RUN_LIMIT = 10;
const EVENT_CARD_LIMIT = 30;

// 防止“每分钟盯一次”烧穿用户额度；高频本地预检也统一受这条硬下限约束。
export const MIN_INTERVAL_MINUTES = 15;

export interface DailyRoutineTrigger {
  kind: 'daily';
  time: string;
  days?: number[];
}

export interface IntervalRoutineTrigger {
  kind: 'interval';
  everyMinutes: number;
}

export type RoutineTrigger = DailyRoutineTrigger | IntervalRoutineTrigger;

export interface RoutineRun {
  id: string;
  at: number;
  status: 'ok' | 'error';
  text: string;
}

export interface RoutineVersion {
  version: number;
  at: number;
  reason: string;
  name: string;
  trigger: RoutineTrigger;
  skillName?: string;
  prompt?: string;
  params?: { rooms?: string[] };
}

export interface Routine<TTrigger extends RoutineTrigger = RoutineTrigger> {
  id: string;
  name: string;
  trigger: TTrigger;
  skillName?: string;
  prompt?: string;
  templateId?: ButlerAbilityTemplateId;
  precheck?: RoutinePrecheck;
  params?: { rooms?: string[] };
  enabled: boolean;
  createdAt: number;
  updatedAt?: number;
  contractVersion?: number;
  versions?: RoutineVersion[];
  lastFiredDate?: string;
  runs: RoutineRun[];
}

interface PersistedRoutines {
  routines: Routine[];
  eventCards: ButlerEventCard[];
  unloadedTemplateIds?: ButlerAbilityTemplateId[];
}

interface RoutineState {
  routines: Routine[];
  eventCards: ButlerEventCard[];
  seenKeys: string[];
  unloadedTemplateIds: ButlerAbilityTemplateId[];
  runningIds: string[];
  hydrated: boolean;
  hydrate: () => void;
  setEnabled: (id: string, enabled: boolean) => void;
  loadTemplate: (
    templateId: string,
    params?: { rooms?: string[] },
  ) => Routine | undefined;
  unloadRoutine: (id: string) => void;
  addRoutine: (routine: Routine) => void;
  updateContract: (
    id: string,
    patch: Partial<Pick<Routine, 'name' | 'trigger' | 'skillName' | 'prompt' | 'params'>>,
    reason?: string,
  ) => void;
  rollbackContract: (id: string, version: number) => void;
  removeRoutine: (id: string) => void;
  dismissCard: (id: string) => void;
  runNow: (
    id: string,
    options?: { triggerReason?: string },
  ) => Promise<boolean>;
  tick: (now?: number) => Promise<void>;
}

export interface RoutineStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

const browserRoutineStorage: RoutineStorage = {
  get: (key) => typeof localStorage === 'undefined' || typeof localStorage.getItem !== 'function'
    ? null
    : localStorage.getItem(key),
  set: (key, value) => {
    if (typeof localStorage !== 'undefined' && typeof localStorage.setItem === 'function') {
      localStorage.setItem(key, value);
    }
  },
};

let routineStorage: RoutineStorage = browserRoutineStorage;
let routineCodexRunner: (options: CodexAutomationOptions) => Promise<{ text: string }> = runCodexAutomation;
let routineNow = () => Date.now();
let scheduler: ReturnType<typeof setInterval> | undefined;
const routineAbortControllers = new Map<string, AbortController>();

export function setRoutineStorage(storage: RoutineStorage): () => void {
  const previous = routineStorage;
  routineStorage = storage;
  return () => {
    routineStorage = previous;
  };
}

export function setRoutineCodexRunner(runner: (options: CodexAutomationOptions) => Promise<{ text: string }>): () => void {
  const previous = routineCodexRunner;
  routineCodexRunner = runner;
  return () => {
    routineCodexRunner = previous;
  };
}

export function setRoutineNowProvider(provider: () => number): () => void {
  const previous = routineNow;
  routineNow = provider;
  return () => {
    routineNow = previous;
  };
}

function localDate(now: number): string {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function triggerMinutes(time: string): number | undefined {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) return undefined;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : undefined;
}

export function dueRoutines(
  routines: readonly Routine<RoutineTrigger>[],
  now: number,
): Routine<RoutineTrigger>[] {
  const date = new Date(now);
  const today = localDate(now);
  const minutes = date.getHours() * 60 + date.getMinutes();
  return routines.filter((routine) => {
    if (!routine.enabled) return false;
    if (routine.trigger.kind === 'interval') {
      if (!validIntervalMinutes(routine.trigger.everyMinutes)) return false;
      const lastRunAt = routine.runs.reduce((latest, run) => Math.max(latest, run.at), 0);
      return lastRunAt === 0 ||
        now - lastRunAt >= routine.trigger.everyMinutes * 60_000;
    }
    const at = triggerMinutes(routine.trigger.time);
    return at !== undefined &&
      minutes >= at &&
      (!routine.trigger.days?.length || routine.trigger.days.includes(date.getDay())) &&
      routine.lastFiredDate !== today;
  });
}

function validIntervalMinutes(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= MIN_INTERVAL_MINUTES;
}

function normalizeTrigger(value: unknown): RoutineTrigger | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const trigger = value as {
    kind?: unknown;
    time?: unknown;
    days?: unknown;
    everyMinutes?: unknown;
  };
  if (trigger.kind === 'daily' && typeof trigger.time === 'string') {
    return {
      kind: 'daily',
      time: trigger.time,
      ...(Array.isArray(trigger.days)
        ? { days: trigger.days.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6) }
        : {}),
    };
  }
  if (trigger.kind === 'interval' && validIntervalMinutes(trigger.everyMinutes)) {
    return { kind: 'interval', everyMinutes: trigger.everyMinutes };
  }
  return undefined;
}

function cloneTrigger(trigger: RoutineTrigger): RoutineTrigger {
  return trigger.kind === 'daily'
    ? { kind: 'daily', time: trigger.time, ...(trigger.days ? { days: [...trigger.days] } : {}) }
    : { kind: 'interval', everyMinutes: trigger.everyMinutes };
}

function routineVersion(
  routine: Pick<Routine, 'name' | 'trigger' | 'skillName' | 'prompt' | 'params'>,
  version: number,
  at: number,
  reason: string,
): RoutineVersion {
  return {
    version,
    at,
    reason,
    name: routine.name,
    trigger: cloneTrigger(routine.trigger),
    ...(routine.skillName ? { skillName: routine.skillName } : {}),
    ...(routine.prompt ? { prompt: routine.prompt } : {}),
    ...(routine.params?.rooms ? { params: { rooms: [...routine.params.rooms] } } : {}),
  };
}

function templateRoutineId(templateId: ButlerAbilityTemplateId): string | undefined {
  if (templateId === 'morning-brief') return 'builtin-morning-brief';
  if (templateId === 'evening-review') return 'builtin-evening-review';
  return undefined;
}

function routineFromTemplate(
  template: ButlerAbilityTemplate,
  createdAt: number,
  params?: { rooms?: string[] },
  options?: { id?: string; enabled?: boolean },
): Routine | undefined {
  const rooms = params?.rooms?.map((room) => room.trim()).filter(Boolean);
  if (template.params === 'rooms' && !rooms?.length) return undefined;
  const routine: Routine = {
    id: options?.id ?? `routine-${template.id}-${crypto.randomUUID()}`,
    name: template.title,
    trigger: cloneTrigger(template.defaultTrigger),
    skillName: template.skillName,
    templateId: template.id,
    precheck: template.precheck,
    ...(rooms ? { params: { rooms: [...rooms] } } : {}),
    enabled: options?.enabled ?? true,
    createdAt,
    updatedAt: createdAt,
    contractVersion: 1,
    runs: [],
  };
  routine.versions = [routineVersion(routine, 1, createdAt, '创建例行照看')];
  return routine;
}

function normalizeRoutine(value: unknown): Routine | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const routine = { ...value } as Partial<Routine> & { delivery?: unknown };
  delete routine.delivery;
  const trigger = normalizeTrigger(routine.trigger);
  if (
    typeof routine.id !== 'string' ||
    typeof routine.name !== 'string' ||
    !trigger ||
    (typeof routine.skillName !== 'string' && typeof routine.prompt !== 'string') ||
    typeof routine.enabled !== 'boolean' ||
    typeof routine.createdAt !== 'number' ||
    !Array.isArray(routine.runs)
  ) return undefined;
  const normalized = {
    ...routine,
    trigger,
    runs: routine.runs.slice(0, RUN_LIMIT),
    ...(routine.params?.rooms ? { params: { rooms: [...routine.params.rooms] } } : {}),
  } as Routine;
  const versions = Array.isArray(routine.versions)
    ? routine.versions.flatMap((version) => {
      if (
        !version
        || typeof version.version !== 'number'
        || typeof version.at !== 'number'
        || typeof version.reason !== 'string'
        || typeof version.name !== 'string'
      ) return [];
      const versionTrigger = normalizeTrigger(version.trigger);
      if (!versionTrigger) return [];
      return [{
        ...version,
        trigger: versionTrigger,
        ...(version.params?.rooms ? { params: { rooms: [...version.params.rooms] } } : {}),
      }];
    }).slice(-20)
    : [];
  const currentVersion = Math.max(1, routine.contractVersion ?? versions.at(-1)?.version ?? 1);
  return {
    ...normalized,
    updatedAt: routine.updatedAt ?? routine.createdAt,
    contractVersion: currentVersion,
    versions: versions.length
      ? versions
      : [routineVersion(normalized, currentVersion, routine.createdAt, '创建已安排任务')],
  };
}

function readJson(key: string): unknown {
  const raw = routineStorage.get(key);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function ensureBuiltins(
  routines: Routine[],
  now: number,
  unloadedTemplateIds: readonly ButlerAbilityTemplateId[],
): Routine[] {
  const saved = new Map(routines.map((routine) => [routine.id, routine]));
  for (const templateId of ['morning-brief', 'evening-review'] as const) {
    if (unloadedTemplateIds.includes(templateId)) continue;
    const template = findButlerAbilityTemplate(templateId);
    const id = templateRoutineId(templateId);
    if (!template || !id || saved.has(id)) continue;
    const builtin = routineFromTemplate(template, now, undefined, { id, enabled: false });
    if (builtin) saved.set(id, builtin);
  }
  return [...saved.values()];
}

function persist(
  routines: Routine[],
  eventCards: ButlerEventCard[],
  seenKeys: string[],
  unloadedTemplateIds: ButlerAbilityTemplateId[],
): void {
  routineStorage.set(ROUTINES_KEY, JSON.stringify({
    routines,
    eventCards,
    unloadedTemplateIds,
  } satisfies PersistedRoutines));
  routineStorage.set(WATCHER_KEYS_KEY, JSON.stringify(seenKeys));
}

function watcherSnapshot(seenKeys: string[]): ButlerWatcherSnapshot {
  const chat = useChat.getState();
  return {
    subscriptions: Object.values(chat.subscriptions).map((subscription) => {
      const room = chat.rooms[subscription.rid];
      return {
        rid: subscription.rid,
        name: subscription.fname || subscription.name || room?.fname || room?.name || subscription.rid,
        userMentions: subscription.userMentions ?? 0,
        lastMessageAt: Math.max(tsMs(room?.lm), tsMs(room?.lastMessage?.ts)),
      };
    }),
    seenKeys,
  };
}

function emptyPrecheckResult(routine: Routine): string {
  return routine.precheck === 'new-mentions'
    ? '当前没有新的 @ 需要整理。'
    : '选定房间从上次整理后没有新消息。';
}

function knownSkillDisabled(skillName: string): boolean {
  const skill = useCodexWorkspace.getState().skills.find((item) => item.name === skillName);
  return skill?.enabled === false;
}

export const useRoutines = create<RoutineState>((set, get) => ({
  routines: [],
  eventCards: [],
  seenKeys: [],
  unloadedTemplateIds: [],
  runningIds: [],
  hydrated: false,

  hydrate: () => {
    const saved = readJson(ROUTINES_KEY);
    const stored = saved && typeof saved === 'object' && Array.isArray((saved as PersistedRoutines).routines)
      ? (saved as PersistedRoutines).routines
      : [];
    const cards = saved && typeof saved === 'object' && Array.isArray((saved as PersistedRoutines).eventCards)
      ? (saved as PersistedRoutines).eventCards as ButlerEventCard[]
      : [];
    const unloadedTemplateIds = saved && typeof saved === 'object' &&
      Array.isArray((saved as PersistedRoutines).unloadedTemplateIds)
      ? (saved as PersistedRoutines).unloadedTemplateIds!.filter(
        (id): id is ButlerAbilityTemplateId =>
          typeof id === 'string' && !!findButlerAbilityTemplate(id),
      )
      : [];
    const seen = readJson(WATCHER_KEYS_KEY);
    const routines = ensureBuiltins(
      stored.map(normalizeRoutine).filter((routine): routine is Routine => !!routine),
      routineNow(),
      unloadedTemplateIds,
    );
    const seenKeys = Array.isArray(seen) ? seen.filter((key): key is string => typeof key === 'string') : [];
    const activeCards = cards
      .filter((card) => card.kind === 'mention-stale')
      .slice(0, EVENT_CARD_LIMIT);
    set({ routines, eventCards: activeCards, seenKeys, unloadedTemplateIds, hydrated: true });
    persist(routines, activeCards, seenKeys, unloadedTemplateIds);
  },

  setEnabled: (id, enabled) => {
    const target = get().routines.find((routine) => routine.id === id);
    if (enabled && target?.skillName && knownSkillDisabled(target.skillName)) return;
    const routines = get().routines.map((routine) => routine.id === id ? { ...routine, enabled } : routine);
    set({ routines });
    persist(routines, get().eventCards, get().seenKeys, get().unloadedTemplateIds);
    if (!enabled) routineAbortControllers.get(id)?.abort(new Error('用户停用已安排任务'));
  },

  loadTemplate: (templateId, params) => {
    const existing = get().routines.find((routine) => routine.templateId === templateId);
    if (existing) return existing;
    const template = findButlerAbilityTemplate(templateId);
    if (!template) return undefined;
    if (knownSkillDisabled(template.skillName)) return undefined;
    const routine = routineFromTemplate(template, routineNow(), params);
    if (!routine) return undefined;
    const routines = [routine, ...get().routines];
    const unloadedTemplateIds = get().unloadedTemplateIds.filter((id) => id !== template.id);
    set({ routines, unloadedTemplateIds });
    persist(routines, get().eventCards, get().seenKeys, unloadedTemplateIds);
    return routine;
  },

  unloadRoutine: (id) => {
    const removed = get().routines.find((routine) => routine.id === id);
    if (!removed) return;
    const routines = get().routines.filter((routine) => routine.id !== id);
    const unloadedTemplateIds = removed.templateId
      ? [...new Set([...get().unloadedTemplateIds, removed.templateId])]
      : get().unloadedTemplateIds;
    set({ routines, unloadedTemplateIds });
    persist(routines, get().eventCards, get().seenKeys, unloadedTemplateIds);
    routineAbortControllers.get(id)?.abort(new Error('用户删除已安排任务'));
  },

  addRoutine: (routine) => {
    const trigger = normalizeTrigger(routine.trigger);
    if (!trigger) throw new RangeError(`interval 不能低于 ${MIN_INTERVAL_MINUTES} 分钟`);
    const base = {
      ...routine,
      trigger,
      runs: routine.runs.slice(0, RUN_LIMIT),
      ...(routine.params?.rooms ? { params: { rooms: [...routine.params.rooms] } } : {}),
    };
    const currentVersion = Math.max(1, base.contractVersion ?? 1);
    const normalized: Routine = {
      ...base,
      updatedAt: base.updatedAt ?? base.createdAt,
      contractVersion: currentVersion,
      versions: base.versions?.length
        ? base.versions.slice(-20)
        : [routineVersion(base, currentVersion, base.createdAt, '创建例行照看')],
    };
    const routines = [normalized, ...get().routines.filter((item) => item.id !== normalized.id)];
    set({ routines });
    persist(routines, get().eventCards, get().seenKeys, get().unloadedTemplateIds);
  },

  updateContract: (id, patch, reason = '与管家调整') => {
    const at = routineNow();
    const routines = get().routines.map((routine) => {
      if (routine.id !== id) return routine;
      const trigger = patch.trigger ? normalizeTrigger(patch.trigger) : routine.trigger;
      if (!trigger) throw new RangeError(`interval 不能低于 ${MIN_INTERVAL_MINUTES} 分钟`);
      const next: Routine = {
        ...routine,
        ...patch,
        trigger,
        ...(patch.params?.rooms ? { params: { rooms: [...patch.params.rooms] } } : {}),
      };
      const version = (routine.contractVersion ?? routine.versions?.at(-1)?.version ?? 1) + 1;
      return {
        ...next,
        updatedAt: at,
        contractVersion: version,
        versions: [
          ...(routine.versions ?? [routineVersion(routine, 1, routine.createdAt, '从旧版本迁移')]),
          routineVersion(next, version, at, reason),
        ].slice(-20),
      };
    });
    set({ routines });
    persist(routines, get().eventCards, get().seenKeys, get().unloadedTemplateIds);
  },

  rollbackContract: (id, version) => {
    const routine = get().routines.find((item) => item.id === id);
    const target = routine?.versions?.find((candidate) => candidate.version === version);
    if (!routine || !target) return;
    get().updateContract(id, {
      name: target.name,
      trigger: target.trigger,
      skillName: target.skillName,
      prompt: target.prompt,
      params: target.params,
    }, `回退到 v${version}`);
  },

  removeRoutine: (id) => {
    get().unloadRoutine(id);
  },

  dismissCard: (id) => {
    const eventCards = get().eventCards.filter((card) => card.id !== id);
    set({ eventCards });
    persist(get().routines, eventCards, get().seenKeys, get().unloadedTemplateIds);
  },

  runNow: async (id, options) => {
    const routine = get().routines.find((item) => item.id === id);
    if (!routine) return false;
    const at = routineNow();
    if (!useAuth.getState().user?._id) {
      const run: RoutineRun = {
        id: crypto.randomUUID(),
        at,
        status: 'error',
        text: '登录后才能运行已安排任务。',
      };
      const routines = get().routines.map((item) => item.id === id
        ? { ...item, runs: [run, ...item.runs].slice(0, RUN_LIMIT) }
        : item);
      set({ routines });
      persist(routines, get().eventCards, get().seenKeys, get().unloadedTemplateIds);
      return true;
    }
    if (routine.skillName && knownSkillDisabled(routine.skillName)) {
      const run: RoutineRun = {
        id: crypto.randomUUID(),
        at,
        status: 'error',
        text: `Skill「${routine.skillName}」已停用或已卸载，请先到“插件”重新启用。`,
      };
      let routines: Routine[] = [];
      set((state) => {
        routines = state.routines.map((item) => item.id === id
          ? { ...item, runs: [run, ...item.runs].slice(0, RUN_LIMIT) }
          : item);
        return { routines };
      });
      persist(routines, get().eventCards, get().seenKeys, get().unloadedTemplateIds);
      return true;
    }
    const precheckPassed = shouldRunRoutine(routine, at);
    if (!precheckPassed && options?.triggerReason === 'schedule') return false;
    if (get().runningIds.includes(id)) return false;
    if (!precheckPassed) {
      const run: RoutineRun = {
        id: crypto.randomUUID(),
        at,
        status: 'ok',
        text: emptyPrecheckResult(routine),
      };
      let routines: Routine[] = [];
      set((state) => {
        routines = state.routines.map((item) => item.id === id
          ? { ...item, runs: [run, ...item.runs].slice(0, RUN_LIMIT) }
          : item);
        return { routines };
      });
      persist(routines, get().eventCards, get().seenKeys, get().unloadedTemplateIds);
      return true;
    }
    set((state) => ({ runningIds: [...state.runningIds, id] }));
    const abortController = new AbortController();
    routineAbortControllers.set(id, abortController);
    let run: RoutineRun;
    try {
      const workspace = useCodexWorkspace.getState();
      const previousSuccessfulRunAt = routine.runs
        .filter((item) => item.status === 'ok')
        .reduce((latest, item) => Math.max(latest, item.at), 0);
      const taskText = [
        ...(routine.skillName ? [`$${routine.skillName}`] : []),
        `执行已安排任务“${routine.name}”，直接输出结果。`,
        ...(previousSuccessfulRunAt > 0
          ? [`该任务上次成功运行时间：${new Date(previousSuccessfulRunAt).toISOString()}。`]
          : ['这是该任务首次成功运行前的检查。']),
        ...(routine.params?.rooms?.length
          ? [`只处理这些房间：${routine.params.rooms.join('、')}。`]
          : []),
        ...(routine.prompt ? ['', '请按以下自定义要求执行：', routine.prompt] : []),
      ].join('\n');
      const result = await routineCodexRunner({
        workspaceRoot: workspace.workspaceRoot,
        text: taskText,
        name: `自动化 · ${routine.name}`,
        model: workspace.selectedModel || undefined,
        effort: workspace.selectedEffort,
        skillName: routine.skillName,
        signal: abortController.signal,
      });
      run = { id: crypto.randomUUID(), at, status: 'ok', text: result.text };
    } catch (error) {
      run = {
        id: crypto.randomUUID(),
        at,
        status: 'error',
        text: error instanceof Error ? error.message : String(error),
      };
    } finally {
      routineAbortControllers.delete(id);
    }
    let routines: Routine[] = [];
    set((state) => {
      routines = state.routines.map((item) => item.id === id
        ? { ...item, runs: [run, ...item.runs].slice(0, RUN_LIMIT) }
        : item);
      return { routines, runningIds: state.runningIds.filter((runningId) => runningId !== id) };
    });
    persist(routines, get().eventCards, get().seenKeys, get().unloadedTemplateIds);
    return true;
  },

  tick: async (now = routineNow()) => {
    const watched = checkWatchers(watcherSnapshot(get().seenKeys), now);
    const retainedCards = get().eventCards.filter((card) => card.kind === 'mention-stale');
    if (watched.length > 0 || retainedCards.length !== get().eventCards.length) {
      const watchedCards = watched.map(({ dedupeKey: _dedupeKey, ...card }) => card);
      const watchedIds = new Set(watchedCards.map((card) => card.id));
      const eventCards = [
        ...watchedCards,
        ...retainedCards.filter((card) => !watchedIds.has(card.id)),
      ].slice(0, EVENT_CARD_LIMIT);
      const seenKeys = [...new Set([...get().seenKeys, ...watched.map((card) => card.dedupeKey)])];
      set({ eventCards, seenKeys });
      persist(get().routines, eventCards, seenKeys, get().unloadedTemplateIds);
    }
    const due = dueRoutines(get().routines, now);
    const firedIds = new Set<string>();
    await Promise.all(due.map(async (routine) => {
      if (await get().runNow(routine.id, { triggerReason: 'schedule' })) firedIds.add(routine.id);
    }));
    if (firedIds.size > 0) {
      const today = localDate(now);
      const routines = get().routines.map((routine) => firedIds.has(routine.id)
        ? routine.trigger.kind === 'daily'
          ? { ...routine, lastFiredDate: today }
          : routine
        : routine);
      set({ routines });
      persist(routines, get().eventCards, get().seenKeys, get().unloadedTemplateIds);
    }
  },
}));

export function startRoutineScheduler(): void {
  if (scheduler) return;
  useRoutines.getState().hydrate();
  void useRoutines.getState().tick();
  scheduler = setInterval(() => void useRoutines.getState().tick(), 60_000);
}

export type { ButlerEventCard } from '../lib/butlerWatchers';
