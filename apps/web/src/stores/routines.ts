import { tsMs } from '@rcx/rc-client';
import { create } from 'zustand';
import { runCodexAutomation, type CodexAutomationOptions } from '../agent/codexAutomation';
import {
  registerScheduledTaskAdapter,
  type ScheduledTaskInput,
  type ScheduledTaskPatch,
  type ScheduledTaskNotificationPolicy,
} from '../agent/scheduledTaskBridge';
import {
  findButlerAbilityTemplate,
  type ButlerAbilityTemplate,
  type ButlerAbilityTemplateId,
  type RoutinePrecheck,
} from '../lib/butlerAbilityTemplates';
import { shouldRunRoutine } from '../lib/routinePrecheck';
import {
  dailyTriggerToRrule,
  describeRrule,
  intervalTriggerToRrule,
  isRruleDue,
  normalizeRrule,
} from '../lib/codexSchedule';
import {
  codexAutomationFilesAvailable,
  deleteCodexAutomationFile,
  readCodexAutomationFiles,
  writeCodexAutomationFile,
  type CodexAutomationDefinition,
} from '../lib/codexAutomationFiles';
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
  window?: {
    start: string;
    end: string;
  };
}

export type RoutineTrigger = DailyRoutineTrigger | IntervalRoutineTrigger;
export type RoutineKind = 'cron' | 'heartbeat';

export interface RoutineRun {
  id: string;
  at: number;
  status: 'ok' | 'error';
  text: string;
  threadId?: string;
  triggerReason?: 'manual' | 'schedule';
  readAt?: number;
  archived?: boolean;
}

export interface RoutineVersion {
  version: number;
  at: number;
  reason: string;
  name: string;
  trigger?: RoutineTrigger;
  rrule?: string;
  skillName?: string;
  prompt?: string;
  params?: { rooms?: string[] };
}

export interface Routine<TTrigger extends RoutineTrigger = RoutineTrigger> {
  id: string;
  name: string;
  trigger?: TTrigger;
  rrule?: string;
  kind?: RoutineKind;
  skillName?: string;
  skillPath?: string;
  pluginTemplateId?: string;
  prompt?: string;
  templateId?: ButlerAbilityTemplateId;
  precheck?: RoutinePrecheck;
  params?: { rooms?: string[] };
  workspaceRoot?: string;
  targetThreadId?: string;
  model?: string;
  reasoningEffort?: string;
  notificationPolicy?: ScheduledTaskNotificationPolicy;
  nativeTarget?: string;
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
  scheduledActiveId?: string;
  scheduledQueuedIds: string[];
  hydrated: boolean;
  nativeStatus: 'idle' | 'loading' | 'ready' | 'error';
  nativeError?: string;
  hydrate: () => void;
  hydrateNative: () => Promise<void>;
  syncNative: (id: string, rollback?: Routine | null) => Promise<void>;
  deleteNative: (id: string) => Promise<void>;
  setEnabled: (id: string, enabled: boolean) => void;
  loadTemplate: (
    templateId: string,
    params?: { rooms?: string[] },
  ) => Routine | undefined;
  unloadRoutine: (id: string) => void;
  addRoutine: (routine: Routine) => void;
  updateContract: (
    id: string,
    patch: Partial<Pick<Routine,
      | 'name'
      | 'trigger'
      | 'rrule'
      | 'kind'
      | 'skillName'
      | 'skillPath'
      | 'pluginTemplateId'
      | 'prompt'
      | 'params'
      | 'workspaceRoot'
      | 'targetThreadId'
      | 'model'
      | 'reasoningEffort'
      | 'notificationPolicy'
    >>,
    reason?: string,
  ) => void;
  rollbackContract: (id: string, version: number) => void;
  removeRoutine: (id: string) => void;
  markRunRead: (routineId: string, runId: string, read: boolean) => void;
  setRunArchived: (routineId: string, runId: string, archived: boolean) => void;
  archiveRuns: (routineId?: string) => void;
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
let routineCodexRunner: (
  options: CodexAutomationOptions,
) => Promise<{ text: string; threadId?: string }> = runCodexAutomation;
let routineNow = () => Date.now();
let scheduler: ReturnType<typeof setInterval> | undefined;
let schedulerStartupTimer: ReturnType<typeof setTimeout> | undefined;
let scheduledDrainPromise: Promise<void> | undefined;
const routineAbortControllers = new Map<string, AbortController>();
const scheduledDailyCursors = new Map<string, string>();

export function setRoutineStorage(storage: RoutineStorage): () => void {
  const previous = routineStorage;
  routineStorage = storage;
  return () => {
    routineStorage = previous;
  };
}

export function setRoutineCodexRunner(
  runner: (options: CodexAutomationOptions) => Promise<{ text: string; threadId?: string }>,
): () => void {
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

export function resetRoutineSchedulerForTests(): void {
  if (schedulerStartupTimer) clearTimeout(schedulerStartupTimer);
  if (scheduler) clearInterval(scheduler);
  schedulerStartupTimer = undefined;
  scheduler = undefined;
  scheduledDrainPromise = undefined;
  scheduledDailyCursors.clear();
  useRoutines.setState({ scheduledActiveId: undefined, scheduledQueuedIds: [] });
}

function localDate(now: number): string {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function dueRoutines(
  routines: readonly Routine<RoutineTrigger>[],
  now: number,
): Routine<RoutineTrigger>[] {
  return routines.filter((routine) => {
    if (!routine.enabled) return false;
    if (routine.trigger?.kind === 'daily' && routine.lastFiredDate === localDate(now)) return false;
    const rrule = routine.rrule ?? rruleFromTrigger(routine.trigger);
    if (!rrule) return false;
    const lastRunAt = routine.runs.reduce((latest, run) => Math.max(latest, run.at), 0);
    return isRruleDue(rrule, now, lastRunAt || undefined);
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
    window?: unknown;
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
    if (trigger.window == null) return { kind: 'interval', everyMinutes: trigger.everyMinutes };
    if (typeof trigger.window !== 'object') return undefined;
    const window = trigger.window as { start?: unknown; end?: unknown };
    if (typeof window.start !== 'string' || typeof window.end !== 'string') return undefined;
    try {
      intervalTriggerToRrule(trigger.everyMinutes, { start: window.start, end: window.end });
    } catch {
      return undefined;
    }
    return {
      kind: 'interval',
      everyMinutes: trigger.everyMinutes,
      window: { start: window.start, end: window.end },
    };
  }
  return undefined;
}

function rruleFromTrigger(trigger: RoutineTrigger | undefined): string | undefined {
  if (!trigger) return undefined;
  return trigger.kind === 'daily'
    ? dailyTriggerToRrule(trigger.time, trigger.days)
    : intervalTriggerToRrule(trigger.everyMinutes, trigger.window);
}

function cloneTrigger(trigger: RoutineTrigger): RoutineTrigger {
  return trigger.kind === 'daily'
    ? { kind: 'daily', time: trigger.time, ...(trigger.days ? { days: [...trigger.days] } : {}) }
    : {
        kind: 'interval',
        everyMinutes: trigger.everyMinutes,
        ...(trigger.window ? { window: { ...trigger.window } } : {}),
      };
}

function routineVersion(
  routine: Pick<Routine, 'name' | 'trigger' | 'rrule' | 'skillName' | 'prompt' | 'params'>,
  version: number,
  at: number,
  reason: string,
): RoutineVersion {
  return {
    version,
    at,
    reason,
    name: routine.name,
    ...(routine.trigger ? { trigger: cloneTrigger(routine.trigger) } : {}),
    ...(routine.rrule ? { rrule: routine.rrule } : {}),
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
    rrule: rruleFromTrigger(template.defaultTrigger),
    kind: 'cron',
    ...(template.skillName ? { skillName: template.skillName } : {}),
    ...(template.prompt ? { prompt: template.prompt } : {}),
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
  let rrule: string | undefined;
  try {
    rrule = typeof routine.rrule === 'string'
      ? normalizeRrule(routine.rrule)
      : rruleFromTrigger(trigger);
  } catch {
    return undefined;
  }
  if (
    typeof routine.id !== 'string' ||
    typeof routine.name !== 'string' ||
    !rrule ||
    (typeof routine.skillName !== 'string' && typeof routine.prompt !== 'string') ||
    typeof routine.enabled !== 'boolean' ||
    typeof routine.createdAt !== 'number' ||
    !Array.isArray(routine.runs)
  ) return undefined;
  const normalized = {
    ...routine,
    ...(trigger ? { trigger } : {}),
    rrule,
    kind: routine.kind === 'heartbeat' ? 'heartbeat' : 'cron',
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
      let versionRrule: string | undefined;
      try {
        versionRrule = typeof version.rrule === 'string'
          ? normalizeRrule(version.rrule)
          : rruleFromTrigger(versionTrigger);
      } catch {
        return [];
      }
      if (!versionRrule) return [];
      return [{
        ...version,
        ...(versionTrigger ? { trigger: versionTrigger } : {}),
        rrule: versionRrule,
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

function mergeBuiltinDuplicates(routines: Routine[]): Routine[] {
  let merged = [...routines];
  for (const templateId of ['morning-brief', 'evening-review'] as const) {
    const canonicalId = templateRoutineId(templateId)!;
    const matches = merged.filter(
      (routine) => routine.id === canonicalId || routine.templateId === templateId,
    );
    if (matches.length === 0) continue;
    if (matches.length === 1 && matches[0].id === canonicalId) continue;

    const preferred = [...matches].sort((left, right) => {
      if (left.enabled !== right.enabled) return left.enabled ? -1 : 1;
      return (right.updatedAt ?? right.createdAt) - (left.updatedAt ?? left.createdAt);
    })[0];
    const runsById = new Map<string, RoutineRun>();
    for (const candidate of matches) {
      for (const run of candidate.runs) {
        const current = runsById.get(run.id);
        if (!current || run.at > current.at) runsById.set(run.id, run);
      }
    }
    const combined: Routine = {
      ...preferred,
      id: canonicalId,
      templateId,
      createdAt: Math.min(...matches.map((routine) => routine.createdAt)),
      updatedAt: Math.max(...matches.map((routine) => routine.updatedAt ?? routine.createdAt)),
      runs: [...runsById.values()].sort((left, right) => right.at - left.at).slice(0, RUN_LIMIT),
    };
    const firstIndex = merged.findIndex((routine) => matches.includes(routine));
    merged = merged.filter((routine) => !matches.includes(routine));
    merged.splice(firstIndex, 0, combined);
  }
  return merged;
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

function automationTimestamp(value: number | string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : routineNow();
}

function routineFromAutomation(
  definition: CodexAutomationDefinition,
  cached?: Routine,
): Routine {
  const createdAt = automationTimestamp(definition.createdAt);
  return {
    ...(cached ?? {}),
    id: definition.id,
    kind: definition.kind === 'heartbeat' ? 'heartbeat' : 'cron',
    name: definition.name,
    prompt: definition.prompt,
    rrule: normalizeRrule(definition.rrule),
    workspaceRoot: definition.cwds[0] ?? cached?.workspaceRoot,
    targetThreadId: definition.targetThreadId ?? cached?.targetThreadId,
    model: definition.model,
    reasoningEffort: definition.reasoningEffort,
    nativeTarget: definition.target,
    enabled: definition.status === 'ACTIVE',
    createdAt,
    updatedAt: automationTimestamp(definition.updatedAt),
    runs: cached?.runs ?? [],
  };
}

function automationFromRoutine(routine: Routine): CodexAutomationDefinition {
  const workspace = useCodexWorkspace.getState();
  const workspaceRoot = routine.workspaceRoot === '~'
    ? workspace.defaultWorkspaceRoot
    : routine.workspaceRoot || workspace.workspaceRoot;
  if (routine.kind !== 'heartbeat' && !workspaceRoot) {
    throw new Error('已安排任务必须选择 Codex 工作区');
  }
  const prompt = routine.prompt?.trim()
    || (routine.skillName ? `$${routine.skillName}\n执行已安排任务“${routine.name}”。` : '');
  if (!prompt) throw new Error('已安排任务说明不能为空');
  return {
    version: 1,
    id: routine.id,
    kind: routine.kind ?? 'cron',
    name: routine.name,
    prompt,
    status: routine.enabled ? 'ACTIVE' : 'PAUSED',
    rrule: normalizeRrule(routine.rrule ?? rruleFromTrigger(routine.trigger) ?? ''),
    cwds: workspaceRoot ? [workspaceRoot] : [],
    executionEnvironment: 'local',
    createdAt: routine.createdAt,
    updatedAt: routine.updatedAt ?? routine.createdAt,
    ...(routine.model ? { model: routine.model } : {}),
    ...(routine.reasoningEffort ? { reasoningEffort: routine.reasoningEffort } : {}),
    ...(routine.nativeTarget ? { target: routine.nativeTarget } : {}),
    ...(routine.kind === 'heartbeat' && routine.targetThreadId
      ? { targetThreadId: routine.targetThreadId }
      : {}),
  };
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

function pruneScheduledRoutine(id: string): void {
  scheduledDailyCursors.delete(id);
  useRoutines.setState((state) => ({
    scheduledActiveId: state.scheduledActiveId === id ? undefined : state.scheduledActiveId,
    scheduledQueuedIds: state.scheduledQueuedIds.filter((queuedId) => queuedId !== id),
  }));
}

function markScheduledRoutineFired(id: string): void {
  const cursor = scheduledDailyCursors.get(id);
  scheduledDailyCursors.delete(id);
  if (!cursor) return;
  const state = useRoutines.getState();
  const routine = state.routines.find((item) => item.id === id);
  if (!routine || routine.trigger?.kind !== 'daily' || routine.lastFiredDate === cursor) return;
  const routines = state.routines.map((item) => item.id === id ? { ...item, lastFiredDate: cursor } : item);
  useRoutines.setState({ routines });
  persist(routines, state.eventCards, state.seenKeys, state.unloadedTemplateIds);
}

function enqueueScheduledRoutines(routines: readonly Routine[], now: number): boolean {
  if (routines.length === 0) return false;
  const state = useRoutines.getState();
  const knownIds = new Set([
    ...state.runningIds,
    ...state.scheduledQueuedIds,
    ...(state.scheduledActiveId ? [state.scheduledActiveId] : []),
  ]);
  const dueDate = localDate(now);
  const queuedIds = [...state.scheduledQueuedIds];
  let accepted = false;
  for (const routine of routines) {
    if (knownIds.has(routine.id)) continue;
    knownIds.add(routine.id);
    queuedIds.push(routine.id);
    scheduledDailyCursors.set(routine.id, dueDate);
    accepted = true;
  }
  if (!accepted) return false;
  useRoutines.setState({ scheduledQueuedIds: queuedIds });
  return true;
}

async function drainScheduledRoutines(): Promise<void> {
  if (scheduledDrainPromise) return scheduledDrainPromise;
  scheduledDrainPromise = (async () => {
    while (true) {
      const state = useRoutines.getState();
      if (state.scheduledActiveId || state.scheduledQueuedIds.length === 0) return;
      const [nextId, ...rest] = state.scheduledQueuedIds;
      useRoutines.setState({ scheduledActiveId: nextId, scheduledQueuedIds: rest });
      let admitted = false;
      try {
        admitted = await useRoutines.getState().runNow(nextId, { triggerReason: 'schedule' });
      } catch {
        admitted = false;
      } finally {
        if (admitted) markScheduledRoutineFired(nextId);
        else scheduledDailyCursors.delete(nextId);
        useRoutines.setState((current) => ({
          scheduledActiveId: current.scheduledActiveId === nextId ? undefined : current.scheduledActiveId,
        }));
      }
    }
  })().finally(() => {
    scheduledDrainPromise = undefined;
    const state = useRoutines.getState();
    if (!state.scheduledActiveId && state.scheduledQueuedIds.length > 0) void drainScheduledRoutines();
  });
  return scheduledDrainPromise;
}

export const useRoutines = create<RoutineState>((set, get) => ({
  routines: [],
  eventCards: [],
  seenKeys: [],
  unloadedTemplateIds: [],
  runningIds: [],
  scheduledActiveId: undefined,
  scheduledQueuedIds: [],
  hydrated: false,
  nativeStatus: 'idle',
  nativeError: undefined,

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
    const routines = mergeBuiltinDuplicates(
      stored.map(normalizeRoutine).filter((routine): routine is Routine => !!routine),
    );
    const seenKeys = Array.isArray(seen) ? seen.filter((key): key is string => typeof key === 'string') : [];
    const activeCards = cards
      .filter((card) => card.kind === 'mention-stale')
      .slice(0, EVENT_CARD_LIMIT);
    set({ routines, eventCards: activeCards, seenKeys, unloadedTemplateIds, hydrated: true });
    persist(routines, activeCards, seenKeys, unloadedTemplateIds);
  },

  hydrateNative: async () => {
    if (!codexAutomationFilesAvailable()) return;
    set({ nativeStatus: 'loading', nativeError: undefined });
    try {
      const definitions = await readCodexAutomationFiles();
      const cached = new Map(get().routines.map((routine) => [routine.id, routine]));
      const routines = definitions.map((definition) => routineFromAutomation(definition, cached.get(definition.id)));
      set({ routines, hydrated: true, nativeStatus: 'ready', nativeError: undefined });
      persist(routines, get().eventCards, get().seenKeys, get().unloadedTemplateIds);
    } catch (error) {
      const nativeError = error instanceof Error ? error.message : String(error);
      set({ nativeStatus: 'error', nativeError });
      throw error;
    }
  },

  syncNative: async (id, rollback) => {
    if (!codexAutomationFilesAvailable()) return;
    const routine = get().routines.find((item) => item.id === id);
    if (!routine) throw new Error(`没有找到已安排任务 ${id}`);
    try {
      await writeCodexAutomationFile(automationFromRoutine(routine));
      set({ nativeStatus: 'ready', nativeError: undefined });
    } catch (error) {
      const nativeError = error instanceof Error ? error.message : String(error);
      if (rollback !== undefined) {
        const current = get().routines;
        const routines = rollback === null
          ? current.filter((item) => item.id !== id)
          : current.some((item) => item.id === id)
            ? current.map((item) => item.id === id ? rollback : item)
            : [rollback, ...current];
        set({ routines, nativeStatus: 'error', nativeError });
        persist(routines, get().eventCards, get().seenKeys, get().unloadedTemplateIds);
      } else {
        set({ nativeStatus: 'error', nativeError });
      }
      throw error;
    }
  },

  deleteNative: async (id) => {
    if (!codexAutomationFilesAvailable()) return;
    try {
      await deleteCodexAutomationFile(id);
      set({ nativeStatus: 'ready', nativeError: undefined });
    } catch (error) {
      const nativeError = error instanceof Error ? error.message : String(error);
      set({ nativeStatus: 'error', nativeError });
      throw error;
    }
  },

  setEnabled: (id, enabled) => {
    const target = get().routines.find((routine) => routine.id === id);
    if (enabled && target?.skillName && knownSkillDisabled(target.skillName)) return;
    const routines = get().routines.map((routine) => routine.id === id ? { ...routine, enabled } : routine);
    set({ routines });
    persist(routines, get().eventCards, get().seenKeys, get().unloadedTemplateIds);
    if (!enabled) {
      pruneScheduledRoutine(id);
      routineAbortControllers.get(id)?.abort(new Error('用户停用已安排任务'));
    }
  },

  loadTemplate: (templateId, params) => {
    const existing = get().routines.find((routine) => routine.templateId === templateId);
    if (existing) return existing;
    const template = findButlerAbilityTemplate(templateId);
    if (!template) return undefined;
    if (template.skillName && knownSkillDisabled(template.skillName)) return undefined;
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
    pruneScheduledRoutine(id);
    routineAbortControllers.get(id)?.abort(new Error('用户删除已安排任务'));
  },

  addRoutine: (routine) => {
    if (routine.trigger?.kind === 'interval' && !validIntervalMinutes(routine.trigger.everyMinutes)) {
      throw new RangeError(`interval 不能低于 ${MIN_INTERVAL_MINUTES} 分钟`);
    }
    const trigger = normalizeTrigger(routine.trigger);
    if (routine.trigger && !trigger) throw new RangeError('运行计划无效');
    const rrule = normalizeRrule(routine.rrule ?? rruleFromTrigger(trigger) ?? '');
    if (routine.kind === 'heartbeat' && !routine.targetThreadId?.trim()) {
      throw new Error('回到现有会话的任务必须选择目标会话');
    }
    const base = {
      ...routine,
      ...(trigger ? { trigger } : {}),
      rrule,
      kind: routine.kind ?? 'cron',
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
      const hasTriggerPatch = Object.prototype.hasOwnProperty.call(patch, 'trigger');
      const trigger = hasTriggerPatch ? normalizeTrigger(patch.trigger) : routine.trigger;
      if (hasTriggerPatch && patch.trigger && !trigger) throw new RangeError('运行计划无效');
      const rrule = normalizeRrule(
        patch.rrule
          ?? (hasTriggerPatch ? rruleFromTrigger(trigger) : undefined)
          ?? routine.rrule
          ?? rruleFromTrigger(trigger)
          ?? '',
      );
      const next: Routine = {
        ...routine,
        ...patch,
        trigger,
        rrule,
        ...(patch.params?.rooms ? { params: { rooms: [...patch.params.rooms] } } : {}),
      };
      if (next.kind === 'heartbeat' && !next.targetThreadId?.trim()) {
        throw new Error('回到现有会话的任务必须选择目标会话');
      }
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
      rrule: target.rrule,
      skillName: target.skillName,
      prompt: target.prompt,
      params: target.params,
    }, `回退到 v${version}`);
  },

  removeRoutine: (id) => {
    get().unloadRoutine(id);
  },

  markRunRead: (routineId, runId, read) => {
    const at = routineNow();
    const routines = get().routines.map((routine) => routine.id === routineId
      ? {
          ...routine,
          runs: routine.runs.map((run) => run.id === runId
            ? { ...run, ...(read ? { readAt: at } : { readAt: undefined }) }
            : run),
        }
      : routine);
    set({ routines });
    persist(routines, get().eventCards, get().seenKeys, get().unloadedTemplateIds);
  },

  setRunArchived: (routineId, runId, archived) => {
    const routines = get().routines.map((routine) => routine.id === routineId
      ? {
          ...routine,
          runs: routine.runs.map((run) => run.id === runId ? { ...run, archived } : run),
        }
      : routine);
    set({ routines });
    persist(routines, get().eventCards, get().seenKeys, get().unloadedTemplateIds);
  },

  archiveRuns: (routineId) => {
    const routines = get().routines.map((routine) => (
      routineId && routine.id !== routineId
        ? routine
        : {
            ...routine,
            runs: routine.runs.map((run) => run.archived ? run : { ...run, archived: true }),
          }
    ));
    set({ routines });
    persist(routines, get().eventCards, get().seenKeys, get().unloadedTemplateIds);
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
        workspaceRoot: routine.workspaceRoot || workspace.workspaceRoot,
        text: taskText,
        name: `自动化 · ${routine.name}`,
        model: routine.model || workspace.selectedModel || undefined,
        effort: routine.reasoningEffort ?? workspace.selectedEffort,
        permissionPreset: workspace.permissionPreset,
        skillName: routine.skillName,
        targetThreadId: routine.kind === 'heartbeat' ? routine.targetThreadId : undefined,
        signal: abortController.signal,
      });
      run = {
        id: crypto.randomUUID(),
        at,
        status: 'ok',
        text: result.text,
        ...(result.threadId ? { threadId: result.threadId } : {}),
        triggerReason: options?.triggerReason === 'schedule' ? 'schedule' : 'manual',
      };
    } catch (error) {
      run = {
        id: crypto.randomUUID(),
        at,
        status: 'error',
        text: error instanceof Error ? error.message : String(error),
        triggerReason: options?.triggerReason === 'schedule' ? 'schedule' : 'manual',
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
    enqueueScheduledRoutines(due, now);
    if (scheduledDrainPromise || useRoutines.getState().scheduledQueuedIds.length > 0) {
      await drainScheduledRoutines();
    }
  },
}));

function scheduledTaskSnapshot(routine: Routine): unknown {
  return {
    id: routine.id,
    kind: routine.kind ?? 'cron',
    name: routine.name,
    prompt: routine.prompt ?? '',
    status: routine.enabled ? 'ACTIVE' : 'PAUSED',
    rrule: routine.rrule ?? rruleFromTrigger(routine.trigger),
    schedule: routine.rrule ? describeRrule(routine.rrule) : undefined,
    workspaceRoot: routine.workspaceRoot,
    targetThreadId: routine.targetThreadId,
    model: routine.model,
    reasoningEffort: routine.reasoningEffort,
    notificationPolicy: routine.notificationPolicy,
    skillName: routine.skillName,
    pluginTemplateId: routine.pluginTemplateId,
    latestRun: routine.runs.find((run) => !run.archived),
  };
}

function routinePatch(input: ScheduledTaskPatch): Parameters<RoutineState['updateContract']>[1] {
  return {
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.name ? { name: input.name.trim() } : {}),
    ...(input.prompt ? { prompt: input.prompt.trim() } : {}),
    ...(input.rrule ? { rrule: normalizeRrule(input.rrule) } : {}),
    ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot.trim() } : {}),
    ...(input.targetThreadId ? { targetThreadId: input.targetThreadId.trim() } : {}),
    ...(input.model ? { model: input.model.trim() } : {}),
    ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort.trim() } : {}),
    ...(input.notificationPolicy ? { notificationPolicy: input.notificationPolicy } : {}),
    ...(input.skillName ? { skillName: input.skillName.trim() } : {}),
    ...(input.pluginTemplateId ? { pluginTemplateId: input.pluginTemplateId.trim() } : {}),
  };
}

registerScheduledTaskAdapter({
  list: async () => {
    const state = useRoutines.getState();
    if (!state.hydrated) state.hydrate();
    await useRoutines.getState().hydrateNative();
    return { tasks: useRoutines.getState().routines.map(scheduledTaskSnapshot) };
  },
  create: async (input: ScheduledTaskInput) => {
    let state = useRoutines.getState();
    if (!state.hydrated) state.hydrate();
    await useRoutines.getState().hydrateNative();
    state = useRoutines.getState();
    const now = routineNow();
    const workspace = useCodexWorkspace.getState();
    const kind = input.kind ?? (workspace.activeThreadId ? 'heartbeat' : 'cron');
    const targetThreadId = input.targetThreadId?.trim() || (kind === 'heartbeat' ? workspace.activeThreadId : undefined);
    const routine: Routine = {
      id: crypto.randomUUID(),
      kind,
      name: input.name.trim(),
      prompt: input.prompt.trim(),
      rrule: normalizeRrule(input.rrule),
      enabled: input.status !== 'PAUSED',
      workspaceRoot: input.workspaceRoot?.trim() || workspace.workspaceRoot,
      ...(targetThreadId ? { targetThreadId } : {}),
      ...(input.model?.trim() ? { model: input.model.trim() } : {}),
      ...(input.reasoningEffort?.trim() ? { reasoningEffort: input.reasoningEffort.trim() } : {}),
      ...(input.notificationPolicy ? { notificationPolicy: input.notificationPolicy } : {}),
      ...(input.skillName?.trim() ? { skillName: input.skillName.trim() } : {}),
      ...(input.pluginTemplateId?.trim() ? { pluginTemplateId: input.pluginTemplateId.trim() } : {}),
      createdAt: now,
      updatedAt: now,
      runs: [],
    };
    if (!routine.name || !routine.prompt) throw new Error('任务名称和说明不能为空');
    state.addRoutine(routine);
    await useRoutines.getState().syncNative(routine.id, null);
    return { status: 'created', task: scheduledTaskSnapshot(routine) };
  },
  update: async (input: ScheduledTaskPatch) => {
    let state = useRoutines.getState();
    if (!state.hydrated) {
      state.hydrate();
      state = useRoutines.getState();
    }
    await state.hydrateNative();
    state = useRoutines.getState();
    const current = state.routines.find((routine) => routine.id === input.id);
    if (!current) throw new Error(`没有找到已安排任务 ${input.id}`);
    const patch = routinePatch(input);
    if (Object.keys(patch).length > 0) state.updateContract(input.id, patch, '由 Codex 更新');
    if (input.status) state.setEnabled(input.id, input.status === 'ACTIVE');
    await useRoutines.getState().syncNative(input.id, current);
    const updated = useRoutines.getState().routines.find((routine) => routine.id === input.id)!;
    return { status: 'updated', task: scheduledTaskSnapshot(updated) };
  },
  remove: async (id) => {
    let state = useRoutines.getState();
    if (!state.hydrated) {
      state.hydrate();
      state = useRoutines.getState();
    }
    await state.hydrateNative();
    state = useRoutines.getState();
    const current = state.routines.find((routine) => routine.id === id);
    if (!current) throw new Error(`没有找到已安排任务 ${id}`);
    await state.deleteNative(id);
    state.removeRoutine(id);
    return { status: 'deleted', id };
  },
  run: async (id) => {
    let state = useRoutines.getState();
    if (!state.hydrated) {
      state.hydrate();
      state = useRoutines.getState();
    }
    if (!state.routines.some((routine) => routine.id === id)) {
      throw new Error(`没有找到已安排任务 ${id}`);
    }
    const admitted = await state.runNow(id, { triggerReason: 'manual' });
    const updated = useRoutines.getState().routines.find((routine) => routine.id === id)!;
    return {
      status: admitted ? 'completed' : 'not_started',
      task: scheduledTaskSnapshot(updated),
      run: updated.runs[0],
    };
  },
});

export function startRoutineScheduler(): void {
  if (scheduler || schedulerStartupTimer) return;
  const state = useRoutines.getState();
  state.hydrate();
  schedulerStartupTimer = setTimeout(() => {
    schedulerStartupTimer = undefined;
    void state.hydrateNative().catch(() => undefined).then(() => useRoutines.getState().tick());
  }, 0);
  scheduler = setInterval(() => void useRoutines.getState().tick(), 60_000);
}

export type { ButlerEventCard } from '../lib/butlerWatchers';
