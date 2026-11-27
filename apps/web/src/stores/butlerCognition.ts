import { create } from 'zustand';
import {
  executeButlerDreamCycle,
  type ButlerDreamJournalEntry,
} from '../agent/butlerDream';
import { t } from '../i18n';
import { desktopNotify } from '../lib/notify';
import { resolveButlerAccountScope, useButlerMemory } from './butlerMemory';
import { useButlerSkills } from './butlerSkills';
import { useCodexWorkspace } from './codexWorkspace';
import { usePrefs } from './prefs';
import { useUI } from './ui';

export function shouldFireProactiveDesktopNotification(input: {
  desktopNotifications?: string;
  muteFocusedConversations?: boolean;
  isWindowFocused: boolean;
  isViewingButler: boolean;
}): boolean {
  if (input.desktopNotifications === 'none') return false;
  if (input.muteFocusedConversations !== false && input.isWindowFocused && input.isViewingButler) {
    return false;
  }
  return true;
}

export type { ButlerDreamJournalEntry };

export type ButlerObservationSource =
  | 'chat'
  | 'acp'
  | 'work_ledger'
  | 'watchpoint'
  | 'user'
  | 'system';

export type ButlerObservationSalience = 'low' | 'normal' | 'high';

export interface ButlerObservationRef {
  rid?: string;
  mid?: string;
  todoId?: string;
  sessionKey?: string;
  actionId?: string;
  watchpointId?: string;
}

export interface ButlerObservationEvent {
  id: string;
  dedupeKey?: string;
  at: number;
  source: ButlerObservationSource;
  kind: string;
  salience: ButlerObservationSalience;
  summary: string;
  ref?: ButlerObservationRef;
  consumedAt?: number;
}

export type ButlerWatchpointCondition =
  | { kind: 'after_timestamp'; wakeAt: number }
  | { kind: 'acp_session_settle'; sessionKey: string }
  | { kind: 'room_activity'; rid: string; contains?: string }
  | { kind: 'work_card_change'; todoId: string };

export interface ButlerWatchpoint {
  id: string;
  reason: string;
  condition: ButlerWatchpointCondition;
  createdAt: number;
  expiresAt: number;
  status: 'armed' | 'fired' | 'cancelled' | 'expired';
  firedAt?: number;
}

export type ButlerInsightLevel = 'silent_log' | 'inbox' | 'interrupt';
export type ButlerInsightKind = 'decision' | 'progress' | 'risk' | 'draft';
export type ButlerInsightStatus = 'unread' | 'acknowledged' | 'dismissed' | 'acted';

export interface ButlerInsightAction {
  label: string;
  prompt?: string;
  sessionKey?: string;
  actionId?: string;
}

export interface ButlerProactiveInsight {
  id: string;
  createdAt: number;
  level: ButlerInsightLevel;
  kind: ButlerInsightKind;
  title: string;
  summary: string;
  suggestedActions?: ButlerInsightAction[];
  ref?: ButlerObservationRef;
  status: ButlerInsightStatus;
  userFeedback?: 'accepted' | 'dismissed';
}

export interface AmbientRunnerInput {
  workspaceRoot: string;
  text: string;
  name: string;
  signal?: AbortSignal;
}

export type AmbientAutomationRunner = (
  input: AmbientRunnerInput,
) => Promise<{ text: string; threadId?: string }>;

const STORAGE_PREFIX = 'rcx-butler-cognition:v1:';
const MAX_OBSERVATIONS = 150;
const MAX_WATCHPOINTS = 40;
const MAX_INSIGHTS = 60;
const MAX_DREAM_JOURNAL = 30;
const AUTO_WAKE_COOLDOWN_MS = 90_000;
const WATCHPOINT_WAKE_COOLDOWN_MS = 15_000;
const MAX_DAILY_AUTO_WAKES = 24;
const DREAM_IDLE_MS = 15 * 60_000;

let ambientRunner: AmbientAutomationRunner = async (input) => {
  const { runCodexAutomation } = await import('../agent/codexAutomation');
  return runCodexAutomation({
    workspaceRoot: input.workspaceRoot,
    text: input.text,
    name: input.name,
    permissionPreset: 'auto',
    signal: input.signal,
  });
};

export function setButlerCognitionRunner(runner: AmbientAutomationRunner): () => void {
  const previous = ambientRunner;
  ambientRunner = runner;
  return () => {
    ambientRunner = previous;
  };
}

export function getButlerCognitionRunner(): AmbientAutomationRunner {
  return ambientRunner;
}

export function localDateKey(now: number = Date.now()): string {
  const d = new Date(now);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function storageKey(scope: string): string {
  return `${STORAGE_PREFIX}${scope || 'default'}`;
}

interface PersistedCognition {
  ambientEnabled: boolean;
  dreamEnabled: boolean;
  lastUserActivityAt: number;
  lastUserChannel: 'chat' | 'butler' | null;
  lastAmbientWakeAt: number;
  autoWakeTimestamps: number[];
  lastDreamDate: string | null;
  observations: ButlerObservationEvent[];
  watchpoints: ButlerWatchpoint[];
  insights: ButlerProactiveInsight[];
  dreamJournal: ButlerDreamJournalEntry[];
}

function readPersisted(scope: string): Partial<PersistedCognition> {
  try {
    if (typeof localStorage === 'undefined') return {};
    const raw = localStorage.getItem(storageKey(scope));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<PersistedCognition>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writePersisted(scope: string, state: PersistedCognition): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(storageKey(scope), JSON.stringify(state));
  } catch {
    /* ignore storage quota failures */
  }
}

function trimObservations(list: ButlerObservationEvent[]): ButlerObservationEvent[] {
  return list.slice(0, MAX_OBSERVATIONS);
}

function trimWatchpoints(list: ButlerWatchpoint[]): ButlerWatchpoint[] {
  return list.slice(0, MAX_WATCHPOINTS);
}

function trimInsights(list: ButlerProactiveInsight[]): ButlerProactiveInsight[] {
  return list.slice(0, MAX_INSIGHTS);
}

function trimJournal(list: ButlerDreamJournalEntry[]): ButlerDreamJournalEntry[] {
  return list.slice(0, MAX_DREAM_JOURNAL);
}

function matchWatchpoint(
  wp: ButlerWatchpoint,
  obs: ButlerObservationEvent,
): boolean {
  if (wp.status !== 'armed') return false;
  const cond = wp.condition;
  if (cond.kind === 'acp_session_settle') {
    return Boolean(
      obs.ref?.sessionKey
        && obs.ref.sessionKey === cond.sessionKey
        && (obs.kind === 'acp_turn_completed'
          || obs.kind === 'acp_waiting_approval'
          || obs.kind === 'acp_error'
          || obs.kind === 'acp_stopped'),
    );
  }
  if (cond.kind === 'room_activity') {
    if (!obs.ref?.rid || obs.ref.rid !== cond.rid) return false;
    if (!cond.contains?.trim()) return true;
    return obs.summary.toLowerCase().includes(cond.contains.trim().toLowerCase());
  }
  if (cond.kind === 'work_card_change') {
    return Boolean(obs.ref?.todoId && obs.ref.todoId === cond.todoId);
  }
  return false;
}

export function buildAmbientCognitionPrompt(state: {
  now: number;
  trigger: 'pulse' | 'manual';
  lastUserActivityAt: number;
  observations: readonly ButlerObservationEvent[];
  watchpoints: readonly ButlerWatchpoint[];
  insights: readonly ButlerProactiveInsight[];
}): string {
  const unconsumed = state.observations.filter((o) => !o.consumedAt).slice(0, 25);
  const armed = state.watchpoints.filter((w) => w.status === 'armed').slice(0, 12);
  const recentFeedback = state.insights.filter((i) => i.userFeedback).slice(0, 15);
  const acceptedCount = recentFeedback.filter((i) => i.userFeedback === 'accepted').length;
  const dismissedItems = recentFeedback.filter((i) => i.userFeedback === 'dismissed');

  return [
    '[Butler Ambient Cognition Cycle]',
    `Trigger: ${state.trigger} | Current time: ${new Date(state.now).toISOString()}`,
    `Last user outbound activity: ${state.lastUserActivityAt > 0 ? new Date(state.lastUserActivityAt).toISOString() : 'not recorded yet'}`,
    '',
    'Unconsumed environmental observations (newest first):',
    ...(unconsumed.length > 0
      ? unconsumed.map(
          (obs) =>
            `- [${obs.salience}] (${obs.source}/${obs.kind}) ${new Date(obs.at).toISOString()} — ${obs.summary}${obs.ref ? ` | ref=${JSON.stringify(obs.ref)}` : ''}`,
        )
      : ['- (none — manual ambient check requested)']),
    '',
    'Armed self-scheduled watchpoints:',
    ...(armed.length > 0
      ? armed.map((w) => `- ${w.id}: ${w.reason} (${JSON.stringify(w.condition)})`)
      : ['- (none)']),
    '',
    `Attention Gate Calibration: accepted=${acceptedCount}, dismissed=${dismissedItems.length}`,
    ...(dismissedItems.length > 0
      ? [`  Recently dismissed by user: ${dismissedItems.slice(0, 4).map((d) => `"${d.title}"`).join(', ')}`]
      : []),
    '',
    'Instructions:',
    '1. You are RocketX Chief-of-Staff running silently in the background. You have full orthogonal tools (`read_activity_stream`, `read_room_messages`, `acp_inspect_session`, `acp_steer_session`, `list_work_cards`, `list_todos`, `list_mentions`, `watchpoint_manage`, `memory_search`, `memory_save`, `surface_proactive_insight`, `skill_evolve`).',
    '2. Triage the observations carefully. Inspect sub-agent outputs, permission requests, or room context if needed before disturbing the user.',
    '3. Keep background housekeeping invisible: save durable facts/preferences via `memory_save`, set future `watchpoint_manage` wakeups for running agents or delayed checks, or steer autonomous sub-agents silently.',
    '4. ONLY call `surface_proactive_insight` (level=`inbox` or `interrupt`) when the user genuinely needs to make a decision, review a critical risk/blocker, or receive a synthesized update since their last activity. Avoid duplicate or low-value interruptions.',
    '5. If no user attention is needed right now, respond concisely with NOOP.',
  ].join('\n');
}

export interface IngestObservationInput {
  dedupeKey?: string;
  at?: number;
  source: ButlerObservationSource;
  kind: string;
  salience?: ButlerObservationSalience;
  summary: string;
  ref?: ButlerObservationRef;
}

export interface AddWatchpointInput {
  reason: string;
  condition: ButlerWatchpointCondition;
  ttlMs?: number;
}

export interface SurfaceInsightInput {
  level: ButlerInsightLevel;
  kind?: ButlerInsightKind;
  title: string;
  summary: string;
  suggestedActions?: ButlerInsightAction[];
  ref?: ButlerObservationRef;
}

interface ButlerCognitionState extends PersistedCognition {
  accountScope: string;
  hydrated: boolean;
  ambientRunning: boolean;
  dreamRunning: boolean;
  lastError: string | null;
  hydrate: (force?: boolean) => void;
  setAmbientEnabled: (enabled: boolean) => void;
  setDreamEnabled: (enabled: boolean) => void;
  recordUserActivity: (at?: number, channel?: 'chat' | 'butler') => void;
  ingestObservation: (input: IngestObservationInput) => ButlerObservationEvent | null;
  addWatchpoint: (input: AddWatchpointInput) => ButlerWatchpoint;
  cancelWatchpoint: (id: string) => boolean;
  pruneExpiredWatchpoints: (now?: number) => number;
  surfaceInsight: (input: SurfaceInsightInput) => ButlerProactiveInsight;
  markInsightFeedback: (id: string, status: Exclude<ButlerInsightStatus, 'unread'>) => void;
  evaluatePulse: (now?: number) => Promise<boolean>;
  runAmbientTurn: (trigger: 'pulse' | 'manual', now?: number) => Promise<{ ran: boolean; output: string }>;
  maybeRunDailyDream: (now?: number) => Promise<boolean>;
  runDreamNow: (now?: number, trigger?: 'auto' | 'manual') => Promise<ButlerDreamJournalEntry>;
  appendDreamJournal: (entry: ButlerDreamJournalEntry) => void;
  rollbackDreamEntry: (entryId: string) => Promise<{ restoredMemories: number; restoredSkills: number }>;
}

function snapshotPersisted(state: ButlerCognitionState): PersistedCognition {
  return {
    ambientEnabled: state.ambientEnabled,
    dreamEnabled: state.dreamEnabled,
    lastUserActivityAt: state.lastUserActivityAt,
    lastUserChannel: state.lastUserChannel,
    lastAmbientWakeAt: state.lastAmbientWakeAt,
    autoWakeTimestamps: state.autoWakeTimestamps,
    lastDreamDate: state.lastDreamDate,
    observations: state.observations,
    watchpoints: state.watchpoints,
    insights: state.insights,
    dreamJournal: state.dreamJournal,
  };
}

function resolveWorkspaceForBackgroundRun(): string {
  const ws = useCodexWorkspace.getState();
  return (
    ws.workspaceRoot?.trim()
    || ws.butlerWorkspaceRoot?.trim()
    || ws.defaultWorkspaceRoot?.trim()
    || 'd:/Repos/rocketchatx'
  );
}

export const useButlerCognition = create<ButlerCognitionState>((set, get) => ({
  accountScope: 'default',
  hydrated: false,
  ambientEnabled: true,
  dreamEnabled: true,
  lastUserActivityAt: 0,
  lastUserChannel: null,
  lastAmbientWakeAt: 0,
  autoWakeTimestamps: [],
  lastDreamDate: null,
  observations: [],
  watchpoints: [],
  insights: [],
  dreamJournal: [],
  ambientRunning: false,
  dreamRunning: false,
  lastError: null,

  hydrate: (force = false) => {
    const scope = resolveButlerAccountScope();
    if (!force && get().hydrated && get().accountScope === scope) return;
    const saved = readPersisted(scope);
    set({
      accountScope: scope,
      hydrated: true,
      ambientEnabled: saved.ambientEnabled ?? true,
      dreamEnabled: saved.dreamEnabled ?? true,
      lastUserActivityAt: typeof saved.lastUserActivityAt === 'number' ? saved.lastUserActivityAt : 0,
      lastUserChannel: saved.lastUserChannel ?? null,
      lastAmbientWakeAt: typeof saved.lastAmbientWakeAt === 'number' ? saved.lastAmbientWakeAt : 0,
      autoWakeTimestamps: Array.isArray(saved.autoWakeTimestamps) ? saved.autoWakeTimestamps : [],
      lastDreamDate: typeof saved.lastDreamDate === 'string' ? saved.lastDreamDate : null,
      observations: Array.isArray(saved.observations) ? trimObservations(saved.observations) : [],
      watchpoints: Array.isArray(saved.watchpoints) ? trimWatchpoints(saved.watchpoints) : [],
      insights: Array.isArray(saved.insights) ? trimInsights(saved.insights) : [],
      dreamJournal: Array.isArray(saved.dreamJournal) ? trimJournal(saved.dreamJournal) : [],
      lastError: null,
    });
  },

  setAmbientEnabled: (enabled) => {
    get().hydrate();
    set({ ambientEnabled: enabled });
    writePersisted(get().accountScope, snapshotPersisted(get()));
  },

  setDreamEnabled: (enabled) => {
    get().hydrate();
    set({ dreamEnabled: enabled });
    writePersisted(get().accountScope, snapshotPersisted(get()));
  },

  recordUserActivity: (at = Date.now(), channel = 'butler') => {
    get().hydrate();
    const prev = get().lastUserActivityAt;
    if (at <= prev) return;
    set({ lastUserActivityAt: at, lastUserChannel: channel });
    writePersisted(get().accountScope, snapshotPersisted(get()));
  },

  ingestObservation: (input) => {
    get().hydrate();
    const cleanSummary = input.summary.trim();
    if (!cleanSummary) return null;
    const state = get();
    if (input.dedupeKey && state.observations.some((o) => o.dedupeKey === input.dedupeKey)) {
      return null;
    }
    const at = input.at ?? Date.now();
    const obs: ButlerObservationEvent = {
      id: `obs-${crypto.randomUUID()}`,
      ...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}),
      at,
      source: input.source,
      kind: input.kind,
      salience: input.salience ?? 'normal',
      summary: cleanSummary.slice(0, 500),
      ...(input.ref ? { ref: input.ref } : {}),
    };

    const firedObservations: ButlerObservationEvent[] = [];
    const nextWatchpoints = state.watchpoints.map((wp) => {
      if (!matchWatchpoint(wp, obs)) return wp;
      firedObservations.push({
        id: `obs-${crypto.randomUUID()}`,
        at,
        source: 'watchpoint',
        kind: 'watchpoint_fired',
        salience: 'high',
        summary: `${wp.reason} — ${obs.summary}`.slice(0, 500),
        ref: { ...(obs.ref ?? {}), watchpointId: wp.id },
      });
      return { ...wp, status: 'fired' as const, firedAt: at };
    });

    const observations = trimObservations([
      ...firedObservations,
      obs,
      ...state.observations,
    ]);
    set({ observations, watchpoints: nextWatchpoints });
    writePersisted(state.accountScope, snapshotPersisted(get()));
    return obs;
  },

  addWatchpoint: (input) => {
    get().hydrate();
    const now = Date.now();
    const ttlMs = Math.max(60_000, Math.min(input.ttlMs ?? 24 * 60 * 60_000, 7 * 24 * 60 * 60_000));
    const wp: ButlerWatchpoint = {
      id: `wp-${crypto.randomUUID().slice(0, 8)}`,
      reason: input.reason.trim(),
      condition: input.condition,
      createdAt: now,
      expiresAt: now + ttlMs,
      status: 'armed',
    };
    const watchpoints = trimWatchpoints([wp, ...get().watchpoints]);
    set({ watchpoints });
    writePersisted(get().accountScope, snapshotPersisted(get()));
    return wp;
  },

  cancelWatchpoint: (id) => {
    get().hydrate();
    let changed = false;
    const watchpoints = get().watchpoints.map((wp) => {
      if (wp.id !== id || wp.status !== 'armed') return wp;
      changed = true;
      return { ...wp, status: 'cancelled' as const };
    });
    if (changed) {
      set({ watchpoints });
      writePersisted(get().accountScope, snapshotPersisted(get()));
    }
    return changed;
  },

  pruneExpiredWatchpoints: (now = Date.now()) => {
    get().hydrate();
    let pruned = 0;
    const kept: ButlerWatchpoint[] = [];
    for (const wp of get().watchpoints) {
      if (wp.status === 'armed' && wp.expiresAt <= now) {
        pruned += 1;
        kept.push({ ...wp, status: 'expired' });
        continue;
      }
      if (wp.status !== 'armed' && now - wp.createdAt > 7 * 24 * 60 * 60_000) {
        pruned += 1;
        continue;
      }
      kept.push(wp);
    }
    if (pruned > 0) {
      set({ watchpoints: kept });
      writePersisted(get().accountScope, snapshotPersisted(get()));
    }
    return pruned;
  },

  surfaceInsight: (input) => {
    get().hydrate();
    const now = Date.now();
    const level: ButlerInsightLevel = input.level ?? 'inbox';
    const insight: ButlerProactiveInsight = {
      id: `ins-${crypto.randomUUID()}`,
      createdAt: now,
      level,
      kind: input.kind ?? 'decision',
      title: input.title.trim().slice(0, 140),
      summary: input.summary.trim().slice(0, 1200),
      ...(input.suggestedActions?.length ? { suggestedActions: input.suggestedActions } : {}),
      ...(input.ref ? { ref: input.ref } : {}),
      status: level === 'silent_log' ? 'acknowledged' : 'unread',
    };
    const insights = trimInsights([insight, ...get().insights]);
    set({ insights });
    writePersisted(get().accountScope, snapshotPersisted(get()));

    if (level === 'interrupt') {
      const prefs = usePrefs.getState().prefs;
      const isWindowFocused = typeof document !== 'undefined' && typeof document.hasFocus === 'function'
        ? document.hasFocus()
        : false;
      const isViewingButler = useUI.getState().module === 'butler-view';
      if (shouldFireProactiveDesktopNotification({
        desktopNotifications: prefs.desktopNotifications,
        muteFocusedConversations: prefs.muteFocusedConversations,
        isWindowFocused,
        isViewingButler,
      })) {
        void desktopNotify({
          title: insight.title,
          body: insight.summary.slice(0, 160),
          tag: `butler-insight:${insight.id}`,
        }).catch(() => undefined);
      }
    }
    return insight;
  },

  markInsightFeedback: (id, status) => {
    get().hydrate();
    const userFeedback: 'accepted' | 'dismissed' = status === 'dismissed' ? 'dismissed' : 'accepted';
    const insights = get().insights.map((item) =>
      item.id === id ? { ...item, status, userFeedback } : item,
    );
    set({ insights });
    writePersisted(get().accountScope, snapshotPersisted(get()));
  },

  evaluatePulse: async (now = Date.now()) => {
    get().hydrate();
    const state = get();

    // 1. Fire any due time-based watchpoints & expire stale ones.
    let wpChanged = false;
    const dueObservations: ButlerObservationEvent[] = [];
    const nextWatchpoints = state.watchpoints.map((wp) => {
      if (wp.status !== 'armed') return wp;
      if (wp.condition.kind === 'after_timestamp' && wp.condition.wakeAt <= now) {
        wpChanged = true;
        dueObservations.push({
          id: `obs-${crypto.randomUUID()}`,
          at: now,
          source: 'watchpoint',
          kind: 'watchpoint_fired',
          salience: 'high',
          summary: wp.reason,
          ref: { watchpointId: wp.id },
        });
        return { ...wp, status: 'fired' as const, firedAt: now };
      }
      if (wp.expiresAt <= now) {
        wpChanged = true;
        return { ...wp, status: 'expired' as const };
      }
      return wp;
    });

    if (wpChanged) {
      set({
        watchpoints: nextWatchpoints,
        observations: trimObservations([...dueObservations, ...get().observations]),
      });
      writePersisted(get().accountScope, snapshotPersisted(get()));
    }

    const latest = get();
    if (!latest.ambientEnabled || latest.ambientRunning || useButlerMemory.getState().memoryPaused) {
      return false;
    }
    // Foreground yield: never contend for provider concurrency/quota while user is actively chatting with Butler.
    const fgStatus = useCodexWorkspace.getState().status;
    if (fgStatus === 'running' || fgStatus === 'waiting-input') {
      return false;
    }

    const unconsumed = latest.observations.filter((o) => !o.consumedAt);
    const hasWatchpoint = unconsumed.some((o) => o.kind === 'watchpoint_fired');
    const hasHigh = unconsumed.some((o) => o.salience === 'high');
    const normalCount = unconsumed.filter((o) => o.salience === 'normal').length;

    if (!hasHigh && normalCount < 3) return false;

    const cooldownMs = hasWatchpoint ? WATCHPOINT_WAKE_COOLDOWN_MS : AUTO_WAKE_COOLDOWN_MS;
    if (now - latest.lastAmbientWakeAt < cooldownMs) return false;

    const cutoff24h = now - 24 * 60 * 60_000;
    const recentAutoWakes = latest.autoWakeTimestamps.filter((ts) => ts >= cutoff24h);
    if (recentAutoWakes.length >= MAX_DAILY_AUTO_WAKES) return false;

    const res = await get().runAmbientTurn('pulse', now);
    return res.ran;
  },

  runAmbientTurn: async (trigger, now = Date.now()) => {
    get().hydrate();
    if (get().ambientRunning) {
      return { ran: false, output: '' };
    }
    const workspaceRoot = resolveWorkspaceForBackgroundRun();
    if (!workspaceRoot) {
      return { ran: false, output: '' };
    }
    const before = get();
    const prompt = buildAmbientCognitionPrompt({
      now,
      trigger,
      lastUserActivityAt: before.lastUserActivityAt,
      observations: before.observations,
      watchpoints: before.watchpoints,
      insights: before.insights,
    });

    const cutoff24h = now - 24 * 60 * 60_000;
    const nextWakes = trigger === 'pulse'
      ? [...before.autoWakeTimestamps.filter((ts) => ts >= cutoff24h), now]
      : before.autoWakeTimestamps;

    const consumedObs = before.observations.map((obs) =>
      !obs.consumedAt && obs.at <= now ? { ...obs, consumedAt: now } : obs,
    );
    set({
      ambientRunning: true,
      lastAmbientWakeAt: now,
      autoWakeTimestamps: nextWakes,
      observations: consumedObs,
      lastError: null,
    });
    writePersisted(get().accountScope, snapshotPersisted(get()));

    try {
      const result = await ambientRunner({
        workspaceRoot,
        text: prompt,
        name: trigger === 'pulse'
          ? t('agent.cognition.ambientRunName')
          : t('agent.cognition.manualRunName'),
      });
      set({ ambientRunning: false, lastError: null });
      return { ran: true, output: result.text };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ ambientRunning: false, lastError: message });
      return { ran: false, output: message };
    }
  },

  maybeRunDailyDream: async (now = Date.now()) => {
    get().hydrate();
    const state = get();
    if (!state.dreamEnabled || state.dreamRunning || state.ambientRunning) return false;
    if (useButlerMemory.getState().memoryPaused) return false;
    const todayKey = localDateKey(now);
    if (state.lastDreamDate === todayKey) return false;
    if (state.lastUserActivityAt > 0 && now - state.lastUserActivityAt < DREAM_IDLE_MS) {
      return false;
    }
    const hasMaterial =
      state.observations.length > 0
      || state.insights.length > 0
      || useButlerMemory.getState().memories.length > 0;
    if (!hasMaterial) return false;
    await get().runDreamNow(now, 'auto');
    return true;
  },

  runDreamNow: async (now = Date.now(), trigger = 'manual') => {
    get().hydrate();
    if (get().dreamRunning && get().dreamJournal[0]) {
      return get().dreamJournal[0];
    }
    set({ dreamRunning: true, lastError: null });
    try {
      const current = get();
      const entry = await executeButlerDreamCycle({
        now,
        trigger,
        runner: ambientRunner,
        observations: current.observations,
        insights: current.insights,
        pruneExpiredWatchpoints: (ts) => get().pruneExpiredWatchpoints(ts),
      });
      get().appendDreamJournal(entry);
      set({ dreamRunning: false, lastError: null });
      return entry;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      set({ dreamRunning: false, lastError: msg });
      throw error;
    }
  },

  appendDreamJournal: (entry) => {
    get().hydrate();
    const nextJournal = trimJournal([
      entry,
      ...get().dreamJournal.filter((item) => item.id !== entry.id),
    ]);
    set({
      lastDreamDate: entry.dateKey,
      dreamJournal: nextJournal,
    });
    writePersisted(get().accountScope, snapshotPersisted(get()));
  },

  rollbackDreamEntry: async (entryId) => {
    get().hydrate();
    const entry = get().dreamJournal.find((item) => item.id === entryId);
    if (!entry || entry.rolledBackAt) {
      return { restoredMemories: 0, restoredSkills: 0 };
    }

    const memStore = useButlerMemory.getState();
    const skillStore = useButlerSkills.getState();
    let restoredMemories = 0;
    let restoredSkills = 0;

    for (const artifact of entry.memoryArtifacts ?? []) {
      try {
        if (artifact.action === 'created') {
          const deleted = await memStore.deleteMemory(artifact.id);
          if (deleted) restoredMemories += 1;
        } else if (artifact.action === 'updated' && artifact.previousContent !== undefined) {
          await memStore.correctMemory(artifact.id, {
            content: artifact.previousContent,
            ...(artifact.previousTags ? { tags: artifact.previousTags } : {}),
          });
          restoredMemories += 1;
        } else if (artifact.action === 'expired' && artifact.previousEntry) {
          const prev = artifact.previousEntry;
          await memStore.upsertMemory({
            category: prev.category,
            title: prev.title,
            content: prev.content,
            tags: prev.tags,
            workspaceRoot: prev.workspaceRoot,
            sourceKind: prev.sourceKind,
            sourceRef: prev.sourceRef,
            pinned: prev.pinned,
            confidence: prev.confidence,
            enabled: true,
            expiresAt: prev.expiresAt,
          });
          restoredMemories += 1;
        }
      } catch {
        // Best-effort rollback per artifact
      }
    }

    for (const snap of entry.skillSnapshots ?? []) {
      try {
        if (!snap.existedBefore) {
          await skillStore.deleteSkill(snap.currentSkillId);
          restoredSkills += 1;
        } else if (snap.previousSkill) {
          await skillStore.upsertSkill(snap.previousSkill);
          restoredSkills += 1;
        }
      } catch {
        // Best-effort rollback per skill
      }
    }

    const updatedJournal = get().dreamJournal.map((item) =>
      item.id === entryId ? { ...item, rolledBackAt: Date.now() } : item,
    );
    set({ dreamJournal: updatedJournal });
    writePersisted(get().accountScope, snapshotPersisted(get()));
    return { restoredMemories, restoredSkills };
  },
}));
