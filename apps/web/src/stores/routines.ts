import { tsMs } from '@rcx/rc-client';
import { create } from 'zustand';
import { t } from '../i18n';
import { desktopNotify } from '../lib/notify';
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
import { isTauriRuntime } from '../lib/client';
import { inspectNativeWorkspaceGit } from '../platform/desktopCommands';
import { useCodexWorkspace } from './codexWorkspace';
import { useWorkLedger } from './workLedger';
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

export type EventRoutineType =
  | 'rc_mention'
  | 'ado_assigned'
  | 'git_dirty_reminder'
  | 'work_card_blocked';

export interface EventRoutineTrigger {
  kind: 'event';
  eventType: EventRoutineType;
  filter?: string;
}

export interface RoutineQuietHours {
  start: string;
  end: string;
}

export interface RoutineNotificationDecision {
  shouldNotifyDesktop: boolean;
  shouldDigest: boolean;
  requiresRoomConfirmation: boolean;
  reason: string;
}

export type RoutineTrigger = DailyRoutineTrigger | IntervalRoutineTrigger | EventRoutineTrigger;
export type RoutineKind = 'cron' | 'heartbeat';

export interface RoutineRun {
  id: string;
  at: number;
  status: 'ok' | 'error';
  text: string;
  threadId?: string;
  triggerReason?: 'manual' | 'schedule' | 'event';
  readAt?: number;
  archived?: boolean;
}

export interface ReusableWorkMethod {
  sourceWorkId: string;
  accountScope: string;
  projectKey: string | null;
  inputs: string;
  steps: string;
  acceptance: string[];
  failureHandling: string;
  boundaries: string[];
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
  quietHours?: RoutineQuietHours;
  notifyRoomId?: string;
  nativeTarget?: string;
  enabled: boolean;
  createdAt: number;
  updatedAt?: number;
  contractVersion?: number;
  versions?: RoutineVersion[];
  lastFiredDate?: string;
  runs: RoutineRun[];
  workTemplate?: ReusableWorkMethod;
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
      | 'quietHours'
      | 'notifyRoomId'
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
    options?: { triggerReason?: 'manual' | 'schedule' | 'event' | string },
  ) => Promise<boolean>;
  dryRunRoutine: (id: string, now?: number) => {
    found: boolean;
    wouldRun: boolean;
    triggerKind: 'daily' | 'interval' | 'event' | 'rrule' | 'none';
    notificationPreview: RoutineNotificationDecision;
    promptPreview: string;
    reason: string;
  };
  triggerEventRoutines: (
    eventType: EventRoutineType,
    payload?: { text?: string; source?: string },
  ) => Promise<number>;
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
    if (routine.trigger?.kind === 'event') return false;
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
  if (
    trigger.kind === 'event'
    && (
      (trigger as { eventType?: unknown }).eventType === 'rc_mention'
      || (trigger as { eventType?: unknown }).eventType === 'ado_assigned'
      || (trigger as { eventType?: unknown }).eventType === 'git_dirty_reminder'
      || (trigger as { eventType?: unknown }).eventType === 'work_card_blocked'
    )
  ) {
    const rawFilter = (trigger as { filter?: unknown }).filter;
    const filter = typeof rawFilter === 'string' && rawFilter.trim() ? rawFilter.trim() : undefined;
    return {
      kind: 'event',
      eventType: (trigger as { eventType: EventRoutineType }).eventType,
      ...(filter ? { filter } : {}),
    };
  }
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
  if (!trigger || trigger.kind === 'event') return undefined;
  if (!trigger) return undefined;
  return trigger.kind === 'daily'
    ? dailyTriggerToRrule(trigger.time, trigger.days)
    : intervalTriggerToRrule(trigger.everyMinutes, trigger.window);
}

function parseHhMmMinutes(value: string): number | null {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

export function isWithinQuietHours(quietHours: RoutineQuietHours | undefined, nowDate: Date = new Date()): boolean {
  if (!quietHours) return false;
  const start = parseHhMmMinutes(quietHours.start);
  const end = parseHhMmMinutes(quietHours.end);
  if (start === null || end === null || start === end) return false;
  const current = nowDate.getHours() * 60 + nowDate.getMinutes();
  return start < end ? (current >= start && current < end) : (current >= start || current < end);
}

const IMPORTANT_UPDATE_RE = /(?:urgent|blocker|blocked|failed|error|alert|overdue|critical|审批|阻塞|失败|告警|紧急|异常)/iu;

export function evaluateNotificationPolicy(
  routine: Pick<Routine, 'notificationPolicy' | 'quietHours' | 'notifyRoomId'>,
  run: Pick<RoutineRun, 'status' | 'text'>,
  nowDate: Date = new Date(),
): RoutineNotificationDecision {
  const policy = routine.notificationPolicy ?? 'all_runs';
  const requiresRoomConfirmation = Boolean(routine.notifyRoomId?.trim());
  if (policy === 'silent') {
    return { shouldNotifyDesktop: false, shouldDigest: false, requiresRoomConfirmation, reason: 'silent' };
  }
  if (policy === 'digest_only') {
    return { shouldNotifyDesktop: false, shouldDigest: true, requiresRoomConfirmation, reason: 'digest_only' };
  }
  if (isWithinQuietHours(routine.quietHours, nowDate)) {
    return { shouldNotifyDesktop: false, shouldDigest: true, requiresRoomConfirmation, reason: 'quiet_hours' };
  }
  if (policy === 'failed_runs_only') {
    const notify = run.status === 'error';
    return { shouldNotifyDesktop: notify, shouldDigest: notify, requiresRoomConfirmation, reason: notify ? 'failed_run' : 'suppressed_ok_run' };
  }
  if (policy === 'important_updates') {
    const important = run.status === 'error' || IMPORTANT_UPDATE_RE.test(run.text);
    return { shouldNotifyDesktop: important, shouldDigest: important, requiresRoomConfirmation, reason: important ? 'important_update' : 'routine_no_urgent_signal' };
  }
  return { shouldNotifyDesktop: true, shouldDigest: true, requiresRoomConfirmation, reason: 'all_runs' };
}

function cloneTrigger(trigger: RoutineTrigger): RoutineTrigger {
  if (trigger.kind === 'event') {
    return {
      kind: 'event',
      eventType: trigger.eventType,
      ...(trigger.filter ? { filter: trigger.filter } : {}),
    };
  }
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
  routine.versions = [routineVersion(routine, 1, createdAt, t('agent.routines.verCreateRoutine'))];
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
    (!rrule && !routine.workTemplate) ||
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
    ...(routine.workTemplate ? { enabled: false } : {}),
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
      : [routineVersion(normalized, currentVersion, routine.createdAt, t('agent.routines.verCreateScheduled'))],
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
    throw new Error(t('agent.routines.workspaceRequired'));
  }
  const prompt = routine.prompt?.trim()
    || (routine.skillName ? `$${routine.skillName}\n${t('agent.routines.skillFallbackPrompt', { name: routine.name })}` : '');
  if (!prompt) throw new Error(t('agent.routines.emptyPrompt'));
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
    ? t('agent.routines.noNewMentions')
    : t('agent.routines.noNewMessages');
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
      const routines = [...get().routines.filter((routine) => routine.workTemplate), ...definitions.map((definition) => routineFromAutomation(definition, cached.get(definition.id)))];
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
    if (!routine) throw new Error(t('agent.routines.notFound', { id }));
    if (routine.workTemplate) throw new Error(t('agent.routines.workMethodNoAuto'));
    if (routine.trigger?.kind === 'event') return;
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
    if (get().routines.some((routine) => routine.id === id && routine.workTemplate)) return;
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
    if (enabled && target?.workTemplate) throw new Error(t('agent.routines.workMethodUseWorkbench'));
    if (enabled && target?.skillName && knownSkillDisabled(target.skillName)) return;
    const routines = get().routines.map((routine) => routine.id === id ? { ...routine, enabled } : routine);
    set({ routines });
    persist(routines, get().eventCards, get().seenKeys, get().unloadedTemplateIds);
    if (!enabled) {
      pruneScheduledRoutine(id);
      routineAbortControllers.get(id)?.abort(new Error(t('agent.routines.userDisabled')));
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
    routineAbortControllers.get(id)?.abort(new Error(t('agent.routines.userDeleted')));
  },

  addRoutine: (routine) => {
    if (routine.trigger?.kind === 'interval' && !validIntervalMinutes(routine.trigger.everyMinutes)) {
      throw new RangeError(t('agent.routines.minInterval', { min: MIN_INTERVAL_MINUTES }));
    }
    const trigger = normalizeTrigger(routine.trigger);
    if (routine.trigger && !trigger) throw new RangeError(t('agent.routines.invalidSchedule'));
    const rrule = (routine.workTemplate || trigger?.kind === 'event')
      ? undefined
      : normalizeRrule(routine.rrule ?? rruleFromTrigger(trigger) ?? '');
    if (routine.kind === 'heartbeat' && !routine.targetThreadId?.trim()) {
      throw new Error(t('agent.routines.targetSessionRequired'));
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
        : [routineVersion(base, currentVersion, base.createdAt, t('agent.routines.verCreateRoutine'))],
    };
    const routines = [normalized, ...get().routines.filter((item) => item.id !== normalized.id)];
    set({ routines });
    persist(routines, get().eventCards, get().seenKeys, get().unloadedTemplateIds);
  },

  updateContract: (id, patch, reason = t('agent.routines.defaultAdjustReason')) => {
    const at = routineNow();
    const routines = get().routines.map((routine) => {
      if (routine.id !== id) return routine;
      const hasTriggerPatch = Object.prototype.hasOwnProperty.call(patch, 'trigger');
      const trigger = hasTriggerPatch ? normalizeTrigger(patch.trigger) : routine.trigger;
      if (hasTriggerPatch && patch.trigger && !trigger) throw new RangeError(t('agent.routines.invalidSchedule'));
      const rrule = trigger?.kind === 'event' ? undefined : normalizeRrule(
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
        throw new Error(t('agent.routines.targetSessionRequired'));
      }
      const version = (routine.contractVersion ?? routine.versions?.at(-1)?.version ?? 1) + 1;
      return {
        ...next,
        updatedAt: at,
        contractVersion: version,
        versions: [
          ...(routine.versions ?? [routineVersion(routine, 1, routine.createdAt, t('agent.routines.migratedVersion'))]),
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
    }, t('agent.routines.rollbackVersion', { version }));
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
    if (routine.workTemplate) throw new Error(t('agent.routines.workMethodCreateWorkFirst'));
    const at = routineNow();
    if (!useAuth.getState().user?._id) {
      const run: RoutineRun = {
        id: crypto.randomUUID(),
        at,
        status: 'error',
        text: t('agent.routines.loginRequired'),
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
        text: t('agent.routines.skillDisabledOrMissing', { name: routine.skillName }),
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
        t('agent.routines.execPromptTitle', { name: routine.name }),
        ...(previousSuccessfulRunAt > 0
          ? [t('agent.routines.lastSuccessAt', { iso: new Date(previousSuccessfulRunAt).toISOString() })]
          : [t('agent.routines.firstCheck')]),
        ...(routine.params?.rooms?.length
          ? [t('agent.routines.onlyRooms', { rooms: routine.params.rooms.join(t('agent.common.listSep')) })]
          : []),
        ...(routine.prompt ? ['', t('agent.routines.customReqHeading'), routine.prompt] : []),
      ].join('\n');
      const result = await routineCodexRunner({
        workspaceRoot: routine.workspaceRoot || workspace.workspaceRoot,
        text: taskText,
        name: t('agent.routines.automationName', { name: routine.name }),
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
        triggerReason: options?.triggerReason === 'schedule' ? 'schedule' : options?.triggerReason === 'event' ? 'event' : 'manual',
      };
    } catch (error) {
      run = {
        id: crypto.randomUUID(),
        at,
        status: 'error',
        text: error instanceof Error ? error.message : String(error),
        triggerReason: options?.triggerReason === 'schedule' ? 'schedule' : options?.triggerReason === 'event' ? 'event' : 'manual',
      };
    } finally {
      routineAbortControllers.delete(id);
    }
    let routines: Routine[] = [];
    set((state) => {
      routines = state.routines.map((item) => item.id === id
        ? { ...item, runs: [run, ...item.runs].slice(0, RUN_LIMIT) }
        : item);
      queueMicrotask(() => {
        const decision = evaluateNotificationPolicy(routine, run, new Date(at));
        if (decision.shouldNotifyDesktop) {
          void desktopNotify({
            title: routine.name,
            body: run.text.slice(0, 160),
            tag: `routine:${routine.id}`,
          }).catch(() => {});
        }
      });
      return { routines, runningIds: state.runningIds.filter((runningId) => runningId !== id) };
    });
    persist(routines, get().eventCards, get().seenKeys, get().unloadedTemplateIds);
    return true;
  },

  dryRunRoutine: (id, now = routineNow()) => {
    const routine = get().routines.find((item) => item.id === id);
    if (!routine) {
      return {
        found: false,
        wouldRun: false,
        triggerKind: 'none',
        notificationPreview: {
          shouldNotifyDesktop: false,
          shouldDigest: false,
          requiresRoomConfirmation: false,
          reason: 'not_found',
        },
        promptPreview: '',
        reason: 'not_found',
      };
    }
    const precheckPassed = shouldRunRoutine(routine, now);
    const triggerKind = routine.trigger?.kind ?? (routine.rrule ? 'rrule' : 'none');
    const promptPreview = [
      ...(routine.skillName ? [`$${routine.skillName}`] : []),
      routine.prompt || '',
    ].filter(Boolean).join('\n');
    const notificationPreview = evaluateNotificationPolicy(
      routine,
      { status: 'ok', text: promptPreview || routine.name },
      new Date(now),
    );
    return {
      found: true,
      wouldRun: routine.enabled && precheckPassed,
      triggerKind,
      notificationPreview,
      promptPreview,
      reason: !routine.enabled ? 'paused' : !precheckPassed ? 'precheck_skipped' : 'ready',
    };
  },

  triggerEventRoutines: async (eventType, payload) => {
    const candidates = get().routines.filter((routine) => {
      if (!routine.enabled || routine.workTemplate) return false;
      if (routine.trigger?.kind !== 'event') return false;
      if (routine.trigger.eventType !== eventType) return false;
      const filter = routine.trigger.filter?.trim().toLowerCase();
      if (!filter) return true;
      return (payload?.text ?? '').toLowerCase().includes(filter);
    });
    let launched = 0;
    for (const candidate of candidates) {
      const ran = await get().runNow(candidate.id, { triggerReason: 'event' });
      if (ran) launched += 1;
    }
    return launched;
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
    if (watched.length > 0) {
      void get().triggerEventRoutines('rc_mention', {
        text: watched.map((w) => `${w.title} ${w.detail}`).join('\n'),
        source: 'watcher',
      }).catch(() => {});
    }
    const activeEventRoutines = get().routines.filter(
      (routine) => routine.enabled && !routine.workTemplate && routine.trigger?.kind === 'event',
    );
    if (activeEventRoutines.some((routine) => routine.trigger?.kind === 'event' && routine.trigger.eventType === 'work_card_blocked')) {
      const blockedCards = useWorkLedger.getState().cards.filter(
        (card) => card.state.waitState === 'blocked' && card.state.stage !== 'done',
      );
      const seenSet = new Set(get().seenKeys);
      const freshBlocked = blockedCards.filter(
        (card) => !seenSet.has(`event:work_card_blocked:${card.id}:${card.updatedAt}`),
      );
      if (freshBlocked.length > 0) {
        const nextSeen = [
          ...get().seenKeys,
          ...freshBlocked.map((card) => `event:work_card_blocked:${card.id}:${card.updatedAt}`),
        ].slice(-500);
        set({ seenKeys: nextSeen });
        persist(get().routines, get().eventCards, nextSeen, get().unloadedTemplateIds);
        void get().triggerEventRoutines('work_card_blocked', {
          text: freshBlocked.map((card) => `${card.title} ${card.state.waitReason ?? ''}`).join('\n'),
          source: 'work_ledger',
        }).catch(() => {});
      }
    }
    if (
      isTauriRuntime()
      && activeEventRoutines.some((routine) => routine.trigger?.kind === 'event' && routine.trigger.eventType === 'git_dirty_reminder')
    ) {
      const wsRoot = useCodexWorkspace.getState().workspaceRoot?.trim();
      if (wsRoot) {
        void inspectNativeWorkspaceGit(wsRoot).then((snap) => {
          if (!snap.dirtyFiles.length) return;
          const gitKey = `event:git_dirty:${localDate(now)}:${wsRoot}:${snap.dirtyFiles.length}`;
          if (get().seenKeys.includes(gitKey)) return;
          const nextSeen = [...get().seenKeys, gitKey].slice(-500);
          set({ seenKeys: nextSeen });
          persist(get().routines, get().eventCards, nextSeen, get().unloadedTemplateIds);
          return get().triggerEventRoutines('git_dirty_reminder', {
            text: `${snap.branch ?? 'HEAD'} (${snap.dirtyFiles.length}): ${snap.dirtyFiles.slice(0, 5).join(', ')}`,
            source: 'git',
          });
        }).catch(() => {});
      }
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
    return { tasks: useRoutines.getState().routines.filter((routine) => !routine.workTemplate).map(scheduledTaskSnapshot) };
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
    if (!routine.name || !routine.prompt) throw new Error(t('agent.routines.nameAndPromptRequired'));
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
    const current = state.routines.find((routine) => routine.id === input.id && !routine.workTemplate);
    if (!current) throw new Error(t('agent.routines.notFound', { id: input.id }));
    const patch = routinePatch(input);
    if (Object.keys(patch).length > 0) state.updateContract(input.id, patch, t('agent.routines.updatedByCodex'));
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
    const current = state.routines.find((routine) => routine.id === id && !routine.workTemplate);
    if (!current) throw new Error(t('agent.routines.notFound', { id }));
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
      throw new Error(t('agent.routines.notFound', { id }));
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
