import { tsMs } from '@rcx/rc-client';
import { create } from 'zustand';
import { runAgentLoop } from '../kernel/ai/agent-loop';
import { butlerArchiveStorage } from '../lib/butlerArchive';
import { codexBrainAvailability, getButlerBrain } from '../lib/butlerBrain';
import { butlerCurrentTimeLine, buildButlerSystemPrompt, friendlyButlerError, loadButlerSkill, type ButlerProfileStorage } from '../lib/butlerProfile';
import { createButlerTools } from '../lib/butlerTools';
import { checkWatchers, type ButlerEventCard, type ButlerWatcherSnapshot } from '../lib/butlerWatchers';
import { useAuth } from './auth';
import { friendlyButlerCodexError, runButlerCodexEphemeral } from './butlerCodex';
import { useChat } from './chat';
import { useWorkbench } from './workbench';

const ROUTINES_KEY = 'rcx-butler-v1:routines';
const WATCHER_KEYS_KEY = 'rcx-butler-v1:routine-seen';
const RUN_LIMIT = 10;
const EVENT_CARD_LIMIT = 30;

export interface RoutineTrigger {
  kind: 'daily';
  time: string;
  days?: number[];
}

export interface RoutineRun {
  id: string;
  at: number;
  status: 'ok' | 'error';
  text: string;
}

export interface Routine {
  id: string;
  name: string;
  trigger: RoutineTrigger;
  skillName: string;
  delivery: 'today';
  enabled: boolean;
  createdAt: number;
  lastFiredDate?: string;
  runs: RoutineRun[];
}

interface PersistedRoutines {
  routines: Routine[];
  eventCards: ButlerEventCard[];
}

interface RoutineState {
  routines: Routine[];
  eventCards: ButlerEventCard[];
  seenKeys: string[];
  runningIds: string[];
  hydrated: boolean;
  hydrate: () => void;
  setEnabled: (id: string, enabled: boolean) => void;
  addRoutine: (routine: Routine) => void;
  removeRoutine: (id: string) => void;
  dismissCard: (id: string) => void;
  runNow: (id: string) => Promise<void>;
  tick: (now?: number) => void;
}

let routineStorage: ButlerProfileStorage = butlerArchiveStorage;
let routineRunner: typeof runAgentLoop = runAgentLoop;
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

export function setRoutineLoopRunner(runner: typeof runAgentLoop): () => void {
  const previous = routineRunner;
  routineRunner = runner;
  return () => {
    routineRunner = previous;
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

export function dueRoutines(routines: readonly Routine[], now: number): Routine[] {
  const date = new Date(now);
  const today = localDate(now);
  const minutes = date.getHours() * 60 + date.getMinutes();
  return routines.filter((routine) => {
    const at = triggerMinutes(routine.trigger.time);
    return routine.enabled &&
      routine.trigger.kind === 'daily' &&
      at !== undefined &&
      minutes >= at &&
      (!routine.trigger.days?.length || routine.trigger.days.includes(date.getDay())) &&
      routine.lastFiredDate !== today;
  });
}

function builtinRoutines(createdAt: number): Routine[] {
  return [
    {
      id: 'builtin-morning-brief',
      name: '晨报',
      trigger: { kind: 'daily', time: '08:30' },
      skillName: 'morning-brief',
      delivery: 'today',
      enabled: false,
      createdAt,
      runs: [],
    },
    {
      id: 'builtin-evening-review',
      name: '晚间回顾',
      trigger: { kind: 'daily', time: '18:30' },
      skillName: 'evening-review',
      delivery: 'today',
      enabled: false,
      createdAt,
      runs: [],
    },
  ];
}

function isRoutine(value: unknown): value is Routine {
  if (!value || typeof value !== 'object') return false;
  const routine = value as Routine;
  return typeof routine.id === 'string' && typeof routine.name === 'string' &&
    !!routine.trigger && routine.trigger.kind === 'daily' && typeof routine.trigger.time === 'string' &&
    typeof routine.skillName === 'string' && routine.delivery === 'today' &&
    typeof routine.enabled === 'boolean' && typeof routine.createdAt === 'number' && Array.isArray(routine.runs);
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

function ensureBuiltins(routines: Routine[], now: number): Routine[] {
  const saved = new Map(routines.map((routine) => [routine.id, routine]));
  for (const builtin of builtinRoutines(now)) {
    if (!saved.has(builtin.id)) saved.set(builtin.id, builtin);
  }
  return [...saved.values()];
}

function persist(routines: Routine[], eventCards: ButlerEventCard[], seenKeys: string[]): void {
  routineStorage.set(ROUTINES_KEY, JSON.stringify({ routines, eventCards } satisfies PersistedRoutines));
  routineStorage.set(WATCHER_KEYS_KEY, JSON.stringify(seenKeys));
}

function watcherSnapshot(seenKeys: string[]): ButlerWatcherSnapshot {
  const chat = useChat.getState();
  const user = useAuth.getState().user;
  return {
    builds: useWorkbench.getState().builds,
    workItems: useWorkbench.getState().workItems,
    subscriptions: Object.values(chat.subscriptions).map((subscription) => {
      const room = chat.rooms[subscription.rid];
      return {
        rid: subscription.rid,
        name: subscription.fname || subscription.name || room?.fname || room?.name || subscription.rid,
        userMentions: subscription.userMentions ?? 0,
        lastMessageAt: Math.max(tsMs(room?.lm), tsMs(room?.lastMessage?.ts)),
      };
    }),
    user: user ? { username: user.username, name: user.name } : undefined,
    seenKeys,
  };
}

export const useRoutines = create<RoutineState>((set, get) => ({
  routines: [],
  eventCards: [],
  seenKeys: [],
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
    const seen = readJson(WATCHER_KEYS_KEY);
    const routines = ensureBuiltins(stored.filter(isRoutine), routineNow());
    const seenKeys = Array.isArray(seen) ? seen.filter((key): key is string => typeof key === 'string') : [];
    set({ routines, eventCards: cards.slice(0, EVENT_CARD_LIMIT), seenKeys, hydrated: true });
    persist(routines, cards.slice(0, EVENT_CARD_LIMIT), seenKeys);
  },

  setEnabled: (id, enabled) => {
    const routines = get().routines.map((routine) => routine.id === id ? { ...routine, enabled } : routine);
    set({ routines });
    persist(routines, get().eventCards, get().seenKeys);
  },

  addRoutine: (routine) => {
    const normalized = { ...routine, runs: routine.runs.slice(0, RUN_LIMIT) };
    const routines = [normalized, ...get().routines.filter((item) => item.id !== normalized.id)];
    set({ routines });
    persist(routines, get().eventCards, get().seenKeys);
  },

  removeRoutine: (id) => {
    if (id === 'builtin-morning-brief' || id === 'builtin-evening-review') return;
    const routines = get().routines.filter((routine) => routine.id !== id);
    set({ routines });
    persist(routines, get().eventCards, get().seenKeys);
  },

  dismissCard: (id) => {
    const eventCards = get().eventCards.filter((card) => card.id !== id);
    set({ eventCards });
    persist(get().routines, eventCards, get().seenKeys);
  },

  runNow: async (id) => {
    const routine = get().routines.find((item) => item.id === id);
    if (!routine || get().runningIds.includes(id)) return;
    set((state) => ({ runningIds: [...state.runningIds, id] }));
    const at = routineNow();
    const brain = getButlerBrain();
    let run: RoutineRun;
    try {
      let result: { text: string };
      if (brain === 'codex') {
        const availability = codexBrainAvailability();
        if (!availability.available) throw new Error(availability.reason ?? 'Codex 大脑暂不可用');
        result = await routineCodexRunner({
          text: `请按以下方法论执行并直接输出结果：\n\n${loadButlerSkill(routine.skillName)}`,
          now: at,
        });
      } else {
        result = await routineRunner({
          messages: [
            { role: 'system', content: `${buildButlerSystemPrompt()}\n\n${butlerCurrentTimeLine(at)}` },
            { role: 'user', content: `请按以下方法论执行并直接输出结果：\n\n${loadButlerSkill(routine.skillName)}` },
          ],
          tools: createButlerTools(),
          maxRounds: 6,
        });
      }
      run = { id: crypto.randomUUID(), at, status: 'ok', text: result.text };
    } catch (error) {
      run = {
        id: crypto.randomUUID(),
        at,
        status: 'error',
        text: brain === 'codex' ? friendlyButlerCodexError(error) : friendlyButlerError(error),
      };
    }
    let routines: Routine[] = [];
    set((state) => {
      routines = state.routines.map((item) => item.id === id
        ? { ...item, runs: [run, ...item.runs].slice(0, RUN_LIMIT) }
        : item);
      return { routines, runningIds: state.runningIds.filter((runningId) => runningId !== id) };
    });
    persist(routines, get().eventCards, get().seenKeys);
  },

  tick: (now = routineNow()) => {
    const watched = checkWatchers(watcherSnapshot(get().seenKeys), now);
    if (watched.length > 0) {
      const eventCards = [
        ...watched.map(({ dedupeKey: _dedupeKey, ...card }) => card),
        ...get().eventCards,
      ].slice(0, EVENT_CARD_LIMIT);
      const seenKeys = [...new Set([...get().seenKeys, ...watched.map((card) => card.dedupeKey)])];
      set({ eventCards, seenKeys });
      persist(get().routines, eventCards, seenKeys);
    }
    const due = dueRoutines(get().routines, now);
    if (due.length > 0) {
      const today = localDate(now);
      const routines = get().routines.map((routine) => due.some((item) => item.id === routine.id)
        ? { ...routine, lastFiredDate: today }
        : routine);
      set({ routines });
      persist(routines, get().eventCards, get().seenKeys);
    }
    for (const routine of due) void get().runNow(routine.id);
  },
}));

export function startRoutineScheduler(): void {
  if (scheduler) return;
  useRoutines.getState().hydrate();
  useRoutines.getState().tick();
  scheduler = setInterval(() => useRoutines.getState().tick(), 60_000);
}

export type { ButlerEventCard } from '../lib/butlerWatchers';
