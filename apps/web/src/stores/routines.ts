import { tsMs } from '@rcx/rc-client';
import { create } from 'zustand';
import type { AgentLoopEvent } from '../kernel/ai/agent-loop';
import { butlerArchiveStorage } from '../lib/butlerArchive';
import { codexBrainAvailability } from '../lib/butlerBrain';
import {
  extractButlerSources,
  mergeButlerSources,
  type ButlerSource,
} from '../lib/butlerContext';
import {
  findButlerAbilityTemplate,
  type ButlerAbilityTemplate,
  type ButlerAbilityTemplateId,
  type RoutinePrecheck,
} from '../lib/butlerAbilityTemplates';
import {
  canUseNativeButlerSkill,
  isButlerSkillEnabled,
  loadButlerSkill,
  type ButlerProfileStorage,
} from '../lib/butlerProfile';
import { shouldRunRoutine } from '../lib/routinePrecheck';
import { checkWatchers, type ButlerEventCard, type ButlerWatcherSnapshot } from '../lib/butlerWatchers';
import { friendlyButlerCodexError, runButlerCodexEphemeral } from './butlerCodex';
import { pauseButlerWorkflowTask, runButlerWorkflowTask } from './butler';
import { useChat } from './chat';
import { useAuth } from './auth';
import { getServerBase } from '../lib/client';
import { buildButlerLightweightMemoryContext } from '../lib/butlerMemoryContext';

const ROUTINES_KEY = 'rcx-butler-v1:routines';
const WATCHER_KEYS_KEY = 'rcx-butler-v1:routine-seen';
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

// 默认类型参数保留旧 UI/调用方的静态兼容；引擎边界显式传 RoutineTrigger 做严格校验。
export interface Routine<TTrigger extends RoutineTrigger = any> {
  id: string;
  name: string;
  trigger: TTrigger;
  skillName?: string;
  prompt?: string;
  templateId?: ButlerAbilityTemplateId;
  precheck?: RoutinePrecheck;
  params?: { rooms?: string[] };
  delivery: 'today';
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
    options?: { triggerReason?: string; onAdmitted?: () => void },
  ) => Promise<void>;
  tick: (now?: number) => Promise<void>;
}

let routineStorage: ButlerProfileStorage = butlerArchiveStorage;
let routineCodexRunner: typeof runButlerCodexEphemeral = runButlerCodexEphemeral;
let routineNow = () => Date.now();
let scheduler: ReturnType<typeof setInterval> | undefined;

export function setRoutineStorage(storage: ButlerProfileStorage): () => void {
  const previous = routineStorage;
  routineStorage = storage;
  return () => {
    routineStorage = previous;
  };
}

export function setRoutineCodexRunner(runner: typeof runButlerCodexEphemeral): () => void {
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
    delivery: 'today',
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
  const routine = value as Partial<Routine>;
  const trigger = normalizeTrigger(routine.trigger);
  if (
    typeof routine.id !== 'string' ||
    typeof routine.name !== 'string' ||
    !trigger ||
    (typeof routine.skillName !== 'string' && typeof routine.prompt !== 'string') ||
    routine.delivery !== 'today' ||
    typeof routine.enabled !== 'boolean' ||
    typeof routine.createdAt !== 'number' ||
    !Array.isArray(routine.runs)
  ) return undefined;
  const template = routine.templateId
    ? findButlerAbilityTemplate(routine.templateId)
    : routine.id === 'builtin-morning-brief'
      ? findButlerAbilityTemplate('morning-brief')
      : routine.id === 'builtin-evening-review'
        ? findButlerAbilityTemplate('evening-review')
        : undefined;
  const normalized = {
    ...routine,
    trigger,
    runs: routine.runs.slice(0, RUN_LIMIT),
    ...(template && !routine.templateId ? { templateId: template.id } : {}),
    ...(template?.skillName && !routine.skillName && !routine.prompt
      ? { skillName: template.skillName }
      : {}),
    ...(template && !routine.precheck ? { precheck: template.precheck } : {}),
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
  const templateSkillName = template?.skillName;
  const migrated = templateSkillName
    && template?.id === 'room-digest'
    && !routine.skillName
    && typeof routine.prompt === 'string'
    && currentVersion === 1
    ? { ...normalized, skillName: templateSkillName, prompt: undefined }
    : normalized;
  return {
    ...migrated,
    updatedAt: routine.updatedAt ?? routine.createdAt,
    contractVersion: currentVersion,
    versions: versions.length
      ? versions
      : [routineVersion(migrated, currentVersion, routine.createdAt, '从旧版本迁移')],
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

async function recordWatcherWorkflow(events: readonly ReturnType<typeof checkWatchers>[number][]): Promise<void> {
  if (!events.length) return;
  const sources = mergeButlerSources(events.map((event) => ({
    kind: 'room',
    id: event.rid,
    rid: event.rid,
    label: event.title.replace(/^@我未回应：/, '').replace(/（\d+小时前）$/, ''),
  })));
  await runButlerWorkflowTask({
    key: 'watcher:mentions',
    kind: 'watcher',
    goal: '检查 Today 中长期未回应的 @我 提醒',
    triggerReason: 'watcher',
    context: {
      kind: 'surface',
      label: 'Today',
      detail: '只记录达到提醒阈值且尚未处理的 @我 房间。',
      sources,
    },
    sources,
    execute: async () => ({
      value: undefined,
      summary: `发现 ${events.length} 个需要处理的 @我 房间。`,
      sources,
    }),
  });
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
    const stored = Array.isArray(saved)
      ? saved
      : saved && typeof saved === 'object' && Array.isArray((saved as PersistedRoutines).routines)
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
    if (enabled && target?.skillName && !isButlerSkillEnabled(target.skillName)) return;
    const routines = get().routines.map((routine) => routine.id === id ? { ...routine, enabled } : routine);
    set({ routines });
    persist(routines, get().eventCards, get().seenKeys, get().unloadedTemplateIds);
    if (!enabled) {
      void pauseButlerWorkflowTask(`routine:${id}`, '用户停用例行事务').catch(() => undefined);
    }
  },

  loadTemplate: (templateId, params) => {
    const existing = get().routines.find((routine) => routine.templateId === templateId);
    if (existing) return existing;
    const template = findButlerAbilityTemplate(templateId);
    if (!template) return undefined;
    if (!isButlerSkillEnabled(template.skillName)) return undefined;
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
    void pauseButlerWorkflowTask(`routine:${id}`, '用户卸载例行事务').catch(() => undefined);
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
    if (!routine) return;
    const at = routineNow();
    if (routine.skillName && !isButlerSkillEnabled(routine.skillName)) {
      if (options?.triggerReason === 'schedule') return;
      const run: RoutineRun = {
        id: crypto.randomUUID(),
        at,
        status: 'error',
        text: `技能「${routine.skillName}」已停用或已卸载，请先到“技能中心”重新启用。`,
      };
      let routines: Routine[] = [];
      set((state) => {
        routines = state.routines.map((item) => item.id === id
          ? { ...item, runs: [run, ...item.runs].slice(0, RUN_LIMIT) }
          : item);
        return { routines };
      });
      persist(routines, get().eventCards, get().seenKeys, get().unloadedTemplateIds);
      return;
    }
    const precheckPassed = shouldRunRoutine(routine, at);
    if (!precheckPassed && options?.triggerReason === 'schedule') return;
    if (get().runningIds.includes(id)) return;
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
      return;
    }
    set((state) => ({ runningIds: [...state.runningIds, id] }));
    let admitted = false;
    let run: RoutineRun;
    try {
      const result = await runButlerWorkflowTask({
        key: `routine:${routine.id}`,
        kind: 'routine',
        goal: `运行 Today 例行事务：${routine.name}`,
        triggerReason: options?.triggerReason?.trim() || 'manual',
        context: {
          kind: 'surface',
          label: 'Today',
          detail: `例行事务“${routine.name}”按已装载的方法运行，结果投递到 Today。`,
          sources: [],
        },
        execute: async ({ signal, toolRuntimeContext }) => {
          admitted = true;
          options?.onAdmitted?.();
          let sources: ButlerSource[] = [];
          const toolNames = new Map<string, string>();
          const onEvent = (event: AgentLoopEvent) => {
            if (event.type === 'tool-call') {
              toolNames.set(event.toolCall.id, event.toolCall.name);
            } else if (event.type === 'tool-result') {
              sources = mergeButlerSources(
                sources,
                extractButlerSources(toolNames.get(event.toolCallId), event.content),
              );
            }
          };
          const runtimeContext = (toolCall: { id: string }) => toolRuntimeContext(toolCall.id, sources);
          const availability = codexBrainAvailability();
          if (!availability.available) throw new Error(availability.reason ?? 'Codex 暂不可用');
          const previousSuccessfulRunAt = routine.runs
            .filter((item) => item.status === 'ok')
            .reduce((latest, item) => Math.max(latest, item.at), 0);
          const taskText = [
            `执行 Today 例行事务“${routine.name}”，直接输出结果。`,
            ...(previousSuccessfulRunAt > 0
              ? [`该例行事务上次成功运行时间：${new Date(previousSuccessfulRunAt).toISOString()}。`]
              : ['这是该例行事务首次成功运行前的检查。']),
            ...(routine.params?.rooms?.length
              ? [`只处理这些房间：${routine.params.rooms.join('、')}。`]
              : []),
          ].join('\n');
          const user = useAuth.getState().user;
          const memoryContext = buildButlerLightweightMemoryContext(
            taskText,
            user?._id
              ? { server: getServerBase() || 'same-origin', account: user._id }
              : undefined,
          );
          const value = routine.prompt
            ? await routineCodexRunner({
              text: `${taskText}\n\n请按以下自定义方法执行：\n\n${routine.prompt}`,
              taskContext: memoryContext || undefined,
              now: at,
              signal,
              onEvent,
              toolRuntimeContext: runtimeContext,
            })
            : routine.skillName && canUseNativeButlerSkill(routine.skillName)
            ? await routineCodexRunner({
              text: taskText,
              skillName: routine.skillName,
              taskContext: memoryContext || undefined,
              now: at,
              signal,
              onEvent,
              toolRuntimeContext: runtimeContext,
            })
            : await routineCodexRunner({
              text: `${taskText}\n\n请按以下方法论执行并直接输出结果：\n\n${loadButlerSkill(routine.skillName ?? '')}`,
              taskContext: memoryContext || undefined,
              now: at,
              signal,
              onEvent,
              toolRuntimeContext: runtimeContext,
            });
          return {
            value,
            summary: `例行事务“${routine.name}”已完成并投递到 Today。`,
            sources,
          };
        },
      });
      run = { id: crypto.randomUUID(), at, status: 'ok', text: result.text };
    } catch (error) {
      run = {
        id: crypto.randomUUID(),
        at,
        status: 'error',
        text: friendlyButlerCodexError(error),
      };
    }
    if (!admitted && options?.triggerReason === 'schedule') {
      set((state) => ({
        runningIds: state.runningIds.filter((runningId) => runningId !== id),
      }));
      return;
    }
    let routines: Routine[] = [];
    set((state) => {
      routines = state.routines.map((item) => item.id === id
        ? { ...item, runs: [run, ...item.runs].slice(0, RUN_LIMIT) }
        : item);
      return { routines, runningIds: state.runningIds.filter((runningId) => runningId !== id) };
    });
    persist(routines, get().eventCards, get().seenKeys, get().unloadedTemplateIds);
  },

  tick: async (now = routineNow()) => {
    const watched = checkWatchers(watcherSnapshot(get().seenKeys), now);
    const workflowRecorded = watched.length === 0
      || await recordWatcherWorkflow(watched).then(() => true).catch(() => false);
    const retainedCards = get().eventCards.filter((card) => card.kind === 'mention-stale');
    if (watched.length > 0 || retainedCards.length !== get().eventCards.length) {
      const watchedCards = watched.map(({ dedupeKey: _dedupeKey, ...card }) => card);
      const watchedIds = new Set(watchedCards.map((card) => card.id));
      const eventCards = [
        ...watchedCards,
        ...retainedCards.filter((card) => !watchedIds.has(card.id)),
      ].slice(0, EVENT_CARD_LIMIT);
      const seenKeys = workflowRecorded
        ? [...new Set([...get().seenKeys, ...watched.map((card) => card.dedupeKey)])]
        : get().seenKeys;
      set({ eventCards, seenKeys });
      persist(get().routines, eventCards, seenKeys, get().unloadedTemplateIds);
    }
    const due = dueRoutines(get().routines, now).filter(
      (routine) => !routine.skillName || isButlerSkillEnabled(routine.skillName),
    );
    const firedIds = new Set<string>();
    await Promise.all(due.map((routine) => get().runNow(routine.id, {
      triggerReason: 'schedule',
      onAdmitted: () => firedIds.add(routine.id),
    })));
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
