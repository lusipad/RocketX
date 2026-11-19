import { create } from 'zustand';
import {
  correlateExternalEvent,
  evaluateCardCompletionGate,
  evaluateEventDispatchDecision,
  isFollowedWork,
  reconcilePendingDispatchActions,
  verifyExternalEventAgainstLiveState,
  type DispatchDecision,
  type ExternalEventInput,
  type LiveStateVerificationOptions,
  type ReconcileActionOutcome,
} from '../agent/workCoordinator';
import {
  createNativeWorkCard,
  addNativeWorkEvidence,
  ingestNativeExternalEvent,
  prepareNativeDispatchAction,
  readNativeWorkLedgerSnapshot,
  transitionNativeDispatchAction,
  updateNativeWorkCard,
  upsertNativeWorkLink,
  upsertNativeWorkSession,
  type DispatchActionKind,
  type DispatchActionState,
  type ExternalEventStatus,
  type NativeDispatchActionRecord,
  type NativeExternalEventRecord,
  type NativeWorkCard,
  type NativeWorkCardState,
  type NativeWorkEvidence,
  type NativeWorkLedgerSnapshot,
  type NativeWorkLink,
  type NativeWorkSessionRecord,
  type WorkCardAutonomyMode,
  type WorkCardOwnerKind,
  type WorkCardStage,
  type WorkCardVisibility,
  type WorkCardWaitState,
  type WorkSessionRuntime,
} from '../platform/desktopCommands';

export type { WorkSessionRuntime };
import { isTauri } from '../lib/http';
import { getLocalDataSchema, writeLocalData } from '../lib/localDataContract';
import { isNativeHostAction, isNativeHostSession, isNativeHostWork, NATIVE_HOST_CONTROL_REASON } from '../lib/nativeWorkOwnership';
import { useTodos, type Todo } from './todos';

const STORAGE_KEY = 'rc_work_ledger_v1';
let accountGeneration = 0;
let activeAccountScope: string | null = null;
let accountReady = !isTauri;
let hydrateRequestSequence = 0;

function accountOwner(): string | null {
  try { return localStorage.getItem('rcx-owner'); } catch { return null; }
}

/** Bind before selecting the native DB; late replies may not publish into the new account. */
export function beginWorkLedgerAccount(scope: string): () => void {
  const generation = ++accountGeneration;
  hydrateRequestSequence += 1;
  accountReady = false;
  if (activeAccountScope !== scope) {
    const fallback = loadFallbackLedger();
    useWorkLedger.setState({
      cards: isTauri ? [] : buildCardsFromTodosAndStates(useTodos.getState().todos, fallback.states),
      links: isTauri ? [] : fallback.links, sessions: isTauri ? [] : fallback.sessions,
      evidences: isTauri ? [] : fallback.evidences, events: isTauri ? [] : fallback.events,
      actions: isTauri ? [] : fallback.actions, hydrated: !isTauri, loading: false, lastError: null,
    });
  } else {
    useWorkLedger.setState({ loading: false, lastError: null });
  }
  activeAccountScope = scope;
  return () => {
    if (generation !== accountGeneration) throw new Error('账号已切换，未激活旧工作数据库');
    accountReady = true;
  };
}

export function captureWorkLedgerAccount(): () => void {
  const generation = accountGeneration;
  const owner = accountOwner();
  const assertCurrent = () => {
    if (!accountReady || generation !== accountGeneration || owner !== accountOwner()
      || (activeAccountScope && owner && activeAccountScope !== owner)) {
      throw new Error('账号或工作数据库已切换，原操作未发布到当前账号');
    }
  };
  assertCurrent();
  return assertCurrent;
}

export interface WorkCardPatchInput {
  expectedRequirementsVersion?: number;
  expectedContentVersion?: number;
  title?: string;
  note?: string | null;
  priority?: number;
  due?: string | null;
  committedTo?: string | null;
  waitingFor?: string | null;
  visibility?: WorkCardVisibility;
  stage?: WorkCardStage;
  waitState?: WorkCardWaitState;
  waitReason?: string | null;
  goal?: string | null;
  ownerKind?: WorkCardOwnerKind;
  projectKey?: string | null;
  environmentId?: string | null;
  acceptance?: string[];
  boundaries?: string[];
  dependsOn?: string[];
  nextStep?: string | null;
  nextCheckAt?: number | null;
  deadlineAt?: number | null;
  lastVerifiedAt?: number | null;
  autonomyMode?: WorkCardAutonomyMode;
  maxAutoTurns?: number;
  autoTurnsUsed?: number;
  consecutiveFailures?: number;
  revokedAt?: number | null;
  humanConfirmedDone?: boolean;
  enroll?: boolean;
  rework?: boolean;
  humanAcceptance?: { actorId: string; criterionIds: string[] };
}

export interface CreateWorkCardInput {
  requestId?: string;
  title: string;
  note?: string;
  priority?: 1 | 2 | 3 | 4;
  stage?: WorkCardStage;
  goal?: string | null;
  nextStep?: string | null;
  ownerKind?: WorkCardOwnerKind;
  autonomyMode?: WorkCardAutonomyMode;
  visibility?: WorkCardVisibility;
  acceptance?: string[];
  boundaries?: string[];
  enroll?: boolean;
  source?: 'manual' | 'message' | 'ado';
  rid?: string;
  mid?: string;
  adoWorkItemId?: number;
  adoProject?: string;
  projectKey?: string | null;
}

export type UpsertWorkSessionInput = Omit<
  NativeWorkSessionRecord,
  'id' | 'lastVerifiedAt' | 'createdAt' | 'updatedAt'
> & {
  clearTodoId?: boolean;
  createdAt?: number;
  updatedAt?: number;
};

function defaultStateForTodo(todo: Todo): NativeWorkCardState {
  const now = todo.updatedAt ?? todo.createdAt ?? Date.now();
  return {
    todoId: todo.id,
    requirementsVersion: 0,
    contentVersion: 0,
    visibility: todo.source === 'ado' ? 'room_shared' : 'private',
    stage: todo.done ? 'done' : 'ready',
    waitState: !todo.done && todo.waitingFor?.trim() ? 'waiting_external' : 'none',
    waitReason: !todo.done && todo.waitingFor?.trim() ? todo.waitingFor.trim() : null,
    goal: null,
    ownerKind: 'human',
    projectKey: todo.adoProject ?? null,
    environmentId: null,
    acceptance: [],
    boundaries: [],
    dependsOn: [],
    nextStep: null,
    nextCheckAt: null,
    lastVerifiedAt: now,
    autonomyMode: 'confirm',
    maxAutoTurns: 3,
    autoTurnsUsed: 0,
    consecutiveFailures: 0,
    revokedAt: null,
    updatedAt: now,
  };
}

function todoToNativeCard(
  todo: Todo,
  existingState?: NativeWorkCardState,
): NativeWorkCard {
  const baseState = existingState ?? defaultStateForTodo(todo);
  const followed = (baseState.requirementsVersion ?? 0) > 0 || baseState.acceptance.length > 0 || baseState.ownerKind !== 'human';
  const stage: WorkCardStage = followed
    ? baseState.stage === 'done' && !baseState.requirementsVersion ? 'verifying' : baseState.stage
    : todo.done
    ? 'done'
    : baseState.stage === 'done'
      ? 'ready'
      : baseState.stage;
  const waitState: WorkCardWaitState = followed ? baseState.waitState : todo.done
    ? 'none'
    : baseState.waitState === 'none' && todo.waitingFor?.trim()
      ? 'waiting_external'
      : baseState.waitState;
  const waitReason =
    waitState === 'waiting_external'
      ? baseState.waitReason ?? todo.waitingFor ?? null
      : baseState.waitReason;

  return {
    id: todo.id,
    source: todo.source ?? (todo.mid ? 'message' : 'manual'),
    rid: todo.rid ?? null,
    mid: todo.mid ?? null,
    adoWorkItemId: todo.adoWorkItemId ?? null,
    adoProject: todo.adoProject ?? null,
    title: todo.title || todo.excerpt || todo.note || '待办',
    note: todo.note ?? null,
    roomName: todo.roomName ?? null,
    author: todo.author ?? null,
    done: followed ? stage === 'done' : todo.done,
    priority: todo.priority ?? 3,
    due: todo.due ?? null,
    createdAt: todo.createdAt,
    doneAt: followed && stage !== 'done' ? null : todo.doneAt ?? null,
    updatedAt: todo.updatedAt ?? todo.createdAt,
    committedTo: todo.committedTo ?? null,
    waitingFor: todo.waitingFor ?? null,
    state: {
      ...baseState,
      requirementsVersion: baseState.requirementsVersion ?? (followed ? 1 : 0),
      contentVersion: baseState.contentVersion ?? 0,
      stage,
      waitState,
      waitReason,
    },
  };
}

interface PersistedFallbackLedger {
  states: Record<string, NativeWorkCardState>;
  links: NativeWorkLink[];
  sessions: NativeWorkSessionRecord[];
  evidences: NativeWorkEvidence[];
  events: NativeExternalEventRecord[];
  actions: NativeDispatchActionRecord[];
}

function loadFallbackLedger(): PersistedFallbackLedger {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {
        states: {},
        links: [],
        sessions: [],
        evidences: [],
        events: [],
        actions: [],
      };
    }
    const parsed = JSON.parse(raw) as Partial<PersistedFallbackLedger>;
    return {
      states: parsed.states ?? {},
      links: parsed.links ?? [],
      sessions: parsed.sessions ?? [],
      evidences: parsed.evidences ?? [],
      events: parsed.events ?? [],
      actions: parsed.actions ?? [],
    };
  } catch {
    return {
      states: {},
      links: [],
      sessions: [],
      evidences: [],
      events: [],
      actions: [],
    };
  }
}

function saveFallbackLedger(snapshot: {
  cards: NativeWorkCard[];
  links: NativeWorkLink[];
  sessions: NativeWorkSessionRecord[];
  evidences: NativeWorkEvidence[];
  events: NativeExternalEventRecord[];
  actions: NativeDispatchActionRecord[];
}, required = false) {
  try {
    const states: Record<string, NativeWorkCardState> = {};
    for (const card of snapshot.cards) {
      states[card.id] = card.state;
    }
    const payload: PersistedFallbackLedger = {
      states,
      links: snapshot.links,
      sessions: snapshot.sessions,
      evidences: snapshot.evidences,
      events: snapshot.events,
      actions: snapshot.actions,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    if (required) throw new Error('工作记录未能持久保存，请释放本机存储后重试');
  }
}

function buildCardsFromTodosAndStates(
  todos: Todo[],
  statesMap: Record<string, NativeWorkCardState>,
): NativeWorkCard[] {
  return todos.map((todo) => todoToNativeCard(todo, statesMap[todo.id]));
}

export interface WorkLedgerState extends NativeWorkLedgerSnapshot {
  hydrated: boolean;
  loading: boolean;
  lastError: string | null;
  hydrate: () => Promise<void>;
  syncWithTodos: () => void;
  createCard: (input: CreateWorkCardInput) => Promise<NativeWorkCard>;
  updateCard: (todoId: string, patch: WorkCardPatchInput) => Promise<NativeWorkCard>;
  acceptWork: (todoId: string, acceptance: { actorId: string; criterionIds: string[]; requirementsVersion: number; contentVersion: number }) => Promise<NativeWorkCard>;
  moveCardStage: (
    todoId: string,
    stage: WorkCardStage,
    options?: { humanConfirmedDone?: boolean },
  ) => Promise<{ ok: boolean; error?: string; card?: NativeWorkCard }>;
  setCardWaitState: (
    todoId: string,
    waitState: WorkCardWaitState,
    waitReason?: string | null,
  ) => Promise<NativeWorkCard>;
  pauseCardAutomation: (todoId: string, reason?: string) => Promise<NativeWorkCard>;
  resumeCardAutomation: (todoId: string) => Promise<NativeWorkCard>;
  upsertLink: (
    input: Omit<NativeWorkLink, 'id' | 'lastVerifiedAt' | 'createdAt'>,
  ) => Promise<NativeWorkLink>;
  upsertSession: (
    input: UpsertWorkSessionInput,
  ) => Promise<NativeWorkSessionRecord>;
  addEvidence: (
    input: Omit<
      NativeWorkEvidence,
      'id' | 'stale' | 'staleReason' | 'verifiedAt' | 'createdAt'
    >,
  ) => Promise<NativeWorkEvidence>;
  ingestExternalEvent: (
    input: ExternalEventInput,
    options?: LiveStateVerificationOptions,
  ) => Promise<{
    duplicate: boolean;
    event: NativeExternalEventRecord;
    decision: DispatchDecision;
  }>;
  prepareDispatchAction: (input: {
    idempotencyKey: string;
    todoId: string;
    eventId?: string | null;
    sessionId?: string | null;
    actionKind: DispatchActionKind;
    specJson: string;
    baselineMarker?: string | null;
    requireConfirmation?: boolean;
  }) => Promise<NativeDispatchActionRecord>;
  transitionDispatchAction: (input: {
    id: string;
    state: DispatchActionState;
    expectedState?: DispatchActionState;
    receiptRef?: string | null;
    errorMessage?: string | null;
  }) => Promise<NativeDispatchActionRecord>;
  reconcileStartupActions: () => Promise<ReconcileActionOutcome[]>;
}

const initialFallback = loadFallbackLedger();

export const useWorkLedger = create<WorkLedgerState>((set, get) => ({
  cards: buildCardsFromTodosAndStates(useTodos.getState().todos, initialFallback.states),
  links: initialFallback.links,
  sessions: initialFallback.sessions,
  evidences: initialFallback.evidences,
  events: initialFallback.events,
  actions: initialFallback.actions,
  hydrated: !isTauri,
  loading: false,
  lastError: null,

  hydrate: async () => {
    const assertAccount = captureWorkLedgerAccount();
    const requestSequence = ++hydrateRequestSequence;
    if (!isTauri) {
      get().syncWithTodos();
      if (requestSequence === hydrateRequestSequence) set({ hydrated: true, loading: false });
      return;
    }
    set({ loading: true, lastError: null });
    try {
      const snapshot = await readNativeWorkLedgerSnapshot();
      assertAccount();
      if (requestSequence !== hydrateRequestSequence) return;
      set({
        ...snapshot,
        hydrated: true,
        loading: false,
        lastError: null,
      });
    } catch (error) {
      assertAccount();
      if (requestSequence !== hydrateRequestSequence) return;
      const message = error instanceof Error ? error.message : String(error);
      get().syncWithTodos();
      set({ hydrated: true, loading: false, lastError: message });
    }
  },

  syncWithTodos: () => {
    captureWorkLedgerAccount();
    const todos = useTodos.getState().todos;
    const current = get();
    const stateMap: Record<string, NativeWorkCardState> = {};
    for (const card of current.cards) {
      stateMap[card.id] = card.state;
    }
    const nextCards = buildCardsFromTodosAndStates(todos, stateMap);
    set({ cards: nextCards });
    if (!isTauri) {
      saveFallbackLedger({ ...current, cards: nextCards });
    }
  },

  createCard: async (input) => {
    const assertAccount = captureWorkLedgerAccount();
    const followed = input.enroll || Boolean(input.acceptance?.length) || Boolean(input.ownerKind && input.ownerKind !== 'human');
    if (followed && (!input.goal?.trim() || !input.acceptance?.length || input.acceptance.some((criterion) => !criterion.trim()))) {
      throw new Error('纳入跟进的工作必须明确目标和非空验收条件');
    }
    const title = input.title.trim() || '未命名任务';
    const note = input.note?.trim() || undefined;
    const priority = input.priority ?? 1;
    const patch: WorkCardPatchInput = {
      stage: input.stage ?? 'ready',
      goal: input.goal ?? null,
      nextStep: input.nextStep ?? null,
      ownerKind: input.ownerKind ?? 'human',
      autonomyMode: input.autonomyMode ?? 'confirm',
      visibility: input.visibility ?? 'private',
      acceptance: input.acceptance,
      boundaries: input.boundaries,
      enroll: input.enroll ?? Boolean(input.acceptance?.length),
      projectKey: input.projectKey ?? input.adoProject ?? null,
    };

    if (isTauri) {
      const requestId = input.requestId?.trim()
        ? JSON.stringify([localStorage.getItem('rcx-owner') ?? 'local', input.requestId.trim()]) : undefined;
      const updatedCard = await createNativeWorkCard({ ...input, requestId, title, note, priority });
      assertAccount();
      const savedTodo = updatedCard;
      useTodos.setState((state) => {
        if (state.todos.some((t) => t.id === savedTodo.id)) {
          return state;
        }
        return {
          todos: [
            {
              id: savedTodo.id,
              source: savedTodo.source,
              title: savedTodo.title,
              note: savedTodo.note ?? undefined,
              done: savedTodo.done,
              priority: savedTodo.priority,
              createdAt: savedTodo.createdAt,
              updatedAt: savedTodo.updatedAt,
              rid: savedTodo.rid ?? undefined,
              mid: savedTodo.mid ?? undefined,
              adoWorkItemId: savedTodo.adoWorkItemId ?? undefined,
              adoProject: savedTodo.adoProject ?? undefined,
            },
            ...state.todos,
          ],
        };
      });
      set((state) => ({
        cards: [updatedCard, ...state.cards.filter((c) => c.id !== updatedCard.id)],
        lastError: null,
      }));
      return updatedCard;
    }

    if (input.requestId?.trim()) {
      const scope = localStorage.getItem('rcx-owner') ?? 'local';
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([scope, input.requestId.trim()])));
      assertAccount();
      const todoId = `work-${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
      const existing = get().cards.find((card) => card.id === todoId);
      if (existing && (existing.state.requirementsVersion ?? 0) > 0) return existing;
      const todos = useTodos.getState().todos;
      if (!todos.some((todo) => todo.id === todoId)) {
        const todo: Todo = { id: todoId, source: input.source ?? 'manual', title, note, priority,
          rid: input.rid, mid: input.mid, adoWorkItemId: input.adoWorkItemId, adoProject: input.adoProject,
          done: false, createdAt: Date.now(), updatedAt: Date.now() };
        const nextTodos = [todo, ...todos];
        writeLocalData('rcx-todos', getLocalDataSchema('todo').version, nextTodos);
        useTodos.setState({ todos: nextTodos });
      }
      get().syncWithTodos();
      const card = await get().updateCard(todoId, patch);
      assertAccount();
      saveFallbackLedger(get(), true);
      return card;
    }
    const todoId = useTodos.getState().add({
      title,
      note,
      priority,
      source: input.source, rid: input.rid, mid: input.mid, adoWorkItemId: input.adoWorkItemId, adoProject: input.adoProject,
    });
    get().syncWithTodos();
    return get().updateCard(todoId, patch);
  },

  updateCard: async (todoId, patch) => {
    const assertAccount = captureWorkLedgerAccount();
    if (patch.humanAcceptance && (patch.expectedRequirementsVersion === undefined || patch.expectedContentVersion === undefined)) throw new Error('人工接受需要用户已审阅的要求与成果版本');
    if (isTauri) {
      const updated = await updateNativeWorkCard(todoId, patch as Record<string, unknown>);
      assertAccount();
      set((state) => {
        const exists = state.cards.some((c) => c.id === todoId);
        const cards = exists
          ? state.cards.map((c) => (c.id === todoId ? updated : c))
          : [updated, ...state.cards];
        return { cards, lastError: null };
      });
      return updated;
    }

    const current = get();
    const card = current.cards.find((c) => c.id === todoId);
    if (!card) {
      throw new Error('工作卡片不存在');
    }
    if ((patch.expectedRequirementsVersion !== undefined && patch.expectedRequirementsVersion !== (card.state.requirementsVersion ?? 0)) ||
      (patch.expectedContentVersion !== undefined && patch.expectedContentVersion !== (card.state.contentVersion ?? 0))) {
      throw new Error('工作要求或成果已更新，请重新读取当前版本');
    }

    const scopeChanged =
      (patch.acceptance !== undefined &&
        JSON.stringify(patch.acceptance) !== JSON.stringify(card.state.acceptance)) ||
      (patch.boundaries !== undefined &&
        JSON.stringify(patch.boundaries) !== JSON.stringify(card.state.boundaries)) ||
      (patch.goal !== undefined && patch.goal !== card.state.goal) ||
      (patch.note !== undefined && patch.note !== card.note);

    const acceptance = patch.acceptance ?? card.state.acceptance;
    const goal = patch.goal !== undefined ? patch.goal : card.state.goal;
    const followed = patch.enroll === true || isFollowedWork(card) || Boolean(acceptance.length);
    if (followed && (!goal?.trim() || !acceptance.length || acceptance.some((c) => !c.trim()))) {
      throw new Error('纳入跟进的工作必须明确目标和非空验收条件');
    }
    const requirementsVersion = followed
      ? Math.max(1, (card.state.requirementsVersion ?? 0) + (scopeChanged ? 1 : 0)) : 0;
    const contentVersion = (card.state.contentVersion ?? 0) + (patch.rework ? 1 : 0);

    let nextEvidences = current.evidences;
    if (scopeChanged || patch.rework) {
      nextEvidences = current.evidences.map((ev) =>
        ev.todoId === todoId && !ev.stale
          ? { ...ev, stale: true, staleReason: patch.rework ? 'rework_requested' : 'scope_changed' }
          : ev,
      );
    }

    const nextStage = patch.stage ?? (patch.rework ? 'in_progress' : scopeChanged && card.state.stage === 'done' ? 'verifying' : card.state.stage);
    if (patch.humanAcceptance) {
      const actor = patch.humanAcceptance.actorId.trim();
      const scope = [...new Set(patch.humanAcceptance.criterionIds)];
      if (!actor || !scope.length || scope.some((c) => !acceptance.includes(c))) throw new Error('人工接受需要明确身份和当前验收范围');
      const now = Date.now();
      nextEvidences = [{ id: crypto.randomUUID(), todoId, sessionId: null, kind: 'manual_ack',
        title: '人工接受验收结果', summary: null, headSha: null, workspaceRoot: null, webUrl: null,
        passed: true, stale: false, staleReason: null, verifiedAt: now, createdAt: now,
        requirementsVersion, contentVersion, criterionIds: scope, acceptedBy: actor, acceptanceScope: scope }, ...nextEvidences];
    }
    if (nextStage === 'done') {
      const gate = evaluateCardCompletionGate(
        { ...card, state: { ...card.state, goal, acceptance, requirementsVersion, contentVersion, waitState: patch.waitState ?? card.state.waitState } },
        nextEvidences,
        Boolean(patch.humanConfirmedDone),
      );
      if (!gate.canMarkDone) {
        throw new Error(gate.reason);
      }
    }

    const now = Date.now();
    const nextWaitState = patch.waitState ?? card.state.waitState;
    const nextRevokedAt =
      patch.revokedAt !== undefined
        ? patch.revokedAt
        : nextWaitState === 'paused' || nextWaitState === 'canceled'
          ? now
          : card.state.revokedAt;

    const nextState: NativeWorkCardState = {
      ...card.state,
      requirementsVersion,
      contentVersion,
      deadlineAt: patch.deadlineAt !== undefined ? patch.deadlineAt : card.state.deadlineAt,
      visibility: patch.visibility ?? card.state.visibility,
      stage: nextStage,
      waitState: nextWaitState,
      waitReason: patch.waitReason !== undefined ? patch.waitReason : card.state.waitReason,
      goal: patch.goal !== undefined ? patch.goal : card.state.goal,
      ownerKind: patch.ownerKind ?? card.state.ownerKind,
      projectKey: patch.projectKey !== undefined ? patch.projectKey : card.state.projectKey,
      environmentId:
        patch.environmentId !== undefined ? patch.environmentId : card.state.environmentId,
      acceptance: patch.acceptance ?? card.state.acceptance,
      boundaries: patch.boundaries ?? card.state.boundaries,
      dependsOn: patch.dependsOn ?? card.state.dependsOn,
      nextStep: patch.nextStep !== undefined ? patch.nextStep : card.state.nextStep,
      nextCheckAt:
        patch.nextCheckAt !== undefined ? patch.nextCheckAt : card.state.nextCheckAt,
      lastVerifiedAt:
        patch.lastVerifiedAt !== undefined ? patch.lastVerifiedAt : card.state.lastVerifiedAt,
      autonomyMode: patch.autonomyMode ?? card.state.autonomyMode,
      maxAutoTurns: patch.maxAutoTurns ?? card.state.maxAutoTurns,
      autoTurnsUsed: patch.autoTurnsUsed ?? card.state.autoTurnsUsed,
      consecutiveFailures:
        patch.consecutiveFailures ?? card.state.consecutiveFailures,
      revokedAt: nextRevokedAt,
      updatedAt: now,
    };

    const targetDone = nextStage === 'done';

    const updatedCard: NativeWorkCard = {
      ...card,
      title: patch.title ?? card.title,
      note: patch.note !== undefined ? patch.note : card.note,
      priority: patch.priority ?? card.priority,
      due: patch.due !== undefined ? patch.due : card.due,
      done: targetDone,
      doneAt: targetDone ? card.doneAt ?? now : null,
      updatedAt: now,
      state: nextState,
    };

    const nextCards = current.cards.map((c) => (c.id === todoId ? updatedCard : c));
    saveFallbackLedger({ ...current, cards: nextCards, evidences: nextEvidences }, true);
    if (card.done !== targetDone) useTodos.getState().toggle(todoId);
    if (patch.note !== undefined || patch.due !== undefined || patch.committedTo !== undefined || patch.waitingFor !== undefined) {
      useTodos.getState().update(todoId, {
        ...(patch.note !== undefined ? { note: patch.note ?? undefined } : {}),
        ...(patch.due !== undefined ? { due: patch.due ?? undefined } : {}),
        ...(patch.committedTo !== undefined ? { committedTo: patch.committedTo ?? undefined } : {}),
        ...(patch.waitingFor !== undefined ? { waitingFor: patch.waitingFor ?? undefined } : {}),
      });
    }
    set({ cards: nextCards, evidences: nextEvidences, lastError: null });
    return updatedCard;
  },

  acceptWork: async (todoId, acceptance) => {
    const assertAccount = captureWorkLedgerAccount();
    const card = await get().updateCard(todoId, { humanAcceptance: { actorId: acceptance.actorId, criterionIds: acceptance.criterionIds }, stage: 'done',
      expectedRequirementsVersion: acceptance.requirementsVersion, expectedContentVersion: acceptance.contentVersion });
    assertAccount();
    if (isTauri) await get().hydrate();
    assertAccount();
    return card;
  },

  moveCardStage: async (todoId, stage, options) => {
    const assertAccount = captureWorkLedgerAccount();
    try {
      const card = await get().updateCard(todoId, {
        stage,
        humanConfirmedDone: options?.humanConfirmedDone,
      });
      assertAccount();
      return { ok: true, card };
    } catch (error) {
      assertAccount();
      const message = error instanceof Error ? error.message : String(error);
      set({ lastError: message });
      return { ok: false, error: message };
    }
  },

  setCardWaitState: async (todoId, waitState, waitReason = null) => {
    return get().updateCard(todoId, { waitState, waitReason });
  },

  pauseCardAutomation: async (todoId, reason = '用户手动暂停自动跟进') => {
    const now = Date.now();
    return get().updateCard(todoId, {
      waitState: 'paused',
      waitReason: reason,
      revokedAt: now,
    });
  },

  resumeCardAutomation: async (todoId) => {
    return get().updateCard(todoId, {
      waitState: 'none',
      waitReason: null,
      consecutiveFailures: 0,
    });
  },

  upsertLink: async (input) => {
    const assertAccount = captureWorkLedgerAccount();
    if (isTauri) {
      const link = await upsertNativeWorkLink(input as unknown as Record<string, unknown>);
      assertAccount();
      await get().hydrate();
      assertAccount();
      return link;
    }

    const now = Date.now();
    const current = get();
    const existingIndex = current.links.findIndex(
      (l) =>
        l.todoId === input.todoId &&
        l.kind === input.kind &&
        l.externalId === input.externalId,
    );
    const previousSha =
      existingIndex >= 0 ? current.links[existingIndex].headSha : null;
    const link: NativeWorkLink = {
      id: existingIndex >= 0 ? current.links[existingIndex].id : crypto.randomUUID(),
      ...input,
      lastVerifiedAt: now,
      createdAt: existingIndex >= 0 ? current.links[existingIndex].createdAt : now,
    };

    const nextLinks =
      existingIndex >= 0
        ? current.links.map((item, idx) => (idx === existingIndex ? link : item))
        : [link, ...current.links];

    let nextEvidences = current.evidences;
    let nextCards = current.cards;

    const contentObservation = input.kind === 'git_branch' && input.externalId.startsWith('workspace:') && input.stateSnapshot?.startsWith('content:');
    const contentChanged = contentObservation && (
      existingIndex >= 0 ? current.links[existingIndex].stateSnapshot !== input.stateSnapshot
        : current.evidences.some((evidence) => evidence.todoId === input.todoId && !evidence.stale)
    );
    if (contentChanged || (input.headSha && previousSha && previousSha !== input.headSha)) {
      nextEvidences = current.evidences.map((ev) => {
        if (
          ev.todoId === input.todoId &&
          !ev.stale
        ) {
          return { ...ev, stale: true, staleReason: contentChanged ? 'workspace_content_changed' : 'head_sha_changed' };
        }
        return ev;
      });
        nextCards = current.cards.map((card) =>
          card.id === input.todoId
            ? {
                ...card,
                done: false,
                doneAt: null,
                state: { ...card.state, contentVersion: (card.state.contentVersion ?? 0) + 1,
                  stage: card.state.stage === 'done' ? 'verifying' : card.state.stage, updatedAt: now },
              }
            : card,
        );
    }

    set({ links: nextLinks, evidences: nextEvidences, cards: nextCards });
    saveFallbackLedger({
      ...current,
      links: nextLinks,
      evidences: nextEvidences,
      cards: nextCards,
    });
    return link;
  },

  upsertSession: async (input) => {
    const assertAccount = captureWorkLedgerAccount();
    const nativeExisting = get().sessions.find((session) => isNativeHostSession(session)
      && session.runtime === input.runtime && session.nativeSessionId === input.nativeSessionId
      && (session.sourceScope?.trim() || 'default') === (input.sourceScope?.trim() || 'default')
      && (session.hostDeviceId ?? '') === (input.hostDeviceId ?? '') && (session.accountScope ?? '') === (input.accountScope ?? ''));
    if (nativeExisting || isNativeHostSession(input)) throw new Error(NATIVE_HOST_CONTROL_REASON);
    if (isTauri) {
      const session = await upsertNativeWorkSession(
        input as unknown as Record<string, unknown>,
      );
      assertAccount();
      set((state) => {
        const exists = state.sessions.some((s) => s.id === session.id);
        const sessions = exists
          ? state.sessions.map((s) => (s.id === session.id ? session : s))
          : [session, ...state.sessions];
        sessions.sort((a, b) => b.updatedAt - a.updatedAt);
        return { sessions };
      });
      return session;
    }

    const current = get();
    let existingIndex = current.sessions.findIndex(
      (s) =>
        s.runtime === input.runtime && s.nativeSessionId === input.nativeSessionId &&
        (s.sourceScope?.trim() || 'default') === (input.sourceScope?.trim() || 'default') &&
        (s.hostDeviceId ?? '') === (input.hostDeviceId ?? '') && (s.accountScope ?? '') === (input.accountScope ?? ''),
    );
    if (existingIndex < 0 && input.sourceScope && input.sourceScope !== 'default') {
      existingIndex = current.sessions.findIndex((s) => s.runtime === input.runtime && s.nativeSessionId === input.nativeSessionId &&
        (s.sourceScope?.trim() || 'default') === 'default' && (s.hostDeviceId ?? '') === (input.hostDeviceId ?? '') && (s.accountScope ?? '') === (input.accountScope ?? ''));
    }
    const existing = existingIndex >= 0 ? current.sessions[existingIndex] : undefined;
    const {
      clearTodoId,
      createdAt: inputCreatedAt,
      updatedAt: inputUpdatedAt,
      ...sessionFields
    } = input;
    const effectiveTodoId = clearTodoId
      ? null
      : (sessionFields.todoId ?? existing?.todoId ?? null);

    if (effectiveTodoId) {
      const card = current.cards.find((c) => c.id === effectiveTodoId);
      if (card?.state.visibility === 'private' && sessionFields.visibility === 'room_shared') {
        throw new Error('隐私边界拦截：私密工作卡片不得绑定到房间共享会话');
      }
    }
    const now = Date.now();
    const record: NativeWorkSessionRecord = {
      id: existing ? existing.id : crypto.randomUUID(),
      ...sessionFields,
      sourceScope: sessionFields.sourceScope?.trim() || 'default',
      todoId: effectiveTodoId,
      configSnapshotJson:
        sessionFields.configSnapshotJson ?? existing?.configSnapshotJson ?? null,
      lastVerifiedAt: now,
      createdAt: existing ? existing.createdAt : (inputCreatedAt ?? now),
      updatedAt: inputUpdatedAt ?? now,
    };
    const nextSessions = (
      existingIndex >= 0
        ? current.sessions.map((s, idx) => (idx === existingIndex ? record : s))
        : [record, ...current.sessions]
    ).sort((a, b) => b.updatedAt - a.updatedAt);
    set({ sessions: nextSessions });
    saveFallbackLedger({ ...current, sessions: nextSessions });
    return record;
  },

  addEvidence: async (input) => {
    const assertAccount = captureWorkLedgerAccount();
    if (input.kind === 'manual_ack') throw new Error('人工接受请使用显式验收操作');
    if (isTauri) {
      const evidence = await addNativeWorkEvidence(
        input as unknown as Record<string, unknown>,
      );
      assertAccount();
      await get().hydrate();
      assertAccount();
      return evidence;
    }

    const now = Date.now();
    const current = get();
    const card = current.cards.find((c) => c.id === input.todoId);
    if (!card) throw new Error('证据关联的工作不存在');
    if (input.sessionId && !current.sessions.some((s) => s.id === input.sessionId && s.todoId === input.todoId)) throw new Error('证据会话不属于当前工作');
    const versionCurrent = input.requirementsVersion === (card.state.requirementsVersion ?? 0) && input.contentVersion === (card.state.contentVersion ?? 0);
    const evidence: NativeWorkEvidence = {
      id: crypto.randomUUID(),
      ...input,
      stale: !versionCurrent,
      staleReason: versionCurrent ? null : 'evidence_version_mismatch',
      acceptedBy: null,
      acceptanceScope: [],
      verifiedAt: now,
      createdAt: now,
    };
    const nextEvidences = [evidence, ...current.evidences];
    saveFallbackLedger({ ...current, evidences: nextEvidences }, true);
    set({ evidences: nextEvidences });
    return evidence;
  },

  ingestExternalEvent: async (input, options = {}) => {
    const assertAccount = captureWorkLedgerAccount();
    let eventRecord: NativeExternalEventRecord;
    let duplicate = false;

    if (isTauri) {
      const res = await ingestNativeExternalEvent(
        input as unknown as Record<string, unknown>,
      );
      assertAccount();
      eventRecord = res.event;
      duplicate = res.duplicate;
      await get().hydrate();
      assertAccount();
    } else {
      const current = get();
      const existing = current.events.find(
        (ev) => ev.dedupeKey === input.dedupeKey,
      );
      if (existing) {
        eventRecord = existing;
        duplicate = true;
      } else {
        const maxVer = current.events
          .filter((ev) => ev.resourceKey === input.resourceKey)
          .reduce((max, ev) => Math.max(max, ev.resourceVersion), -1);
        const match = correlateExternalEvent(input, current.cards, current.links);
        const card = match.todoId
          ? current.cards.find((c) => c.id === match.todoId) ?? null
          : null;
        const occurredAt = input.occurredAt ?? Date.now();

        let status: ExternalEventStatus = 'received';
        let statusDetail: string | null = match.reason;

        if (maxVer > input.resourceVersion) {
          status = 'superseded';
          statusDetail = `乱序旧事件已抑制（当前最高版本 ${maxVer} > ${input.resourceVersion}）`;
        } else if (card) {
          if (
            (card.state.revokedAt != null && occurredAt <= card.state.revokedAt) ||
            card.state.waitState === 'paused' ||
            card.state.waitState === 'canceled'
          ) {
            status = 'verified_stale';
            statusDetail = '事件早于卡片暂停/撤销水位线或卡片处于暂停态，已忽略';
          } else if (match.tier === 'heuristic') {
            status = 'pending_approval';
          } else if (
            card.state.autonomyMode === 'autonomous' &&
            card.state.autoTurnsUsed < card.state.maxAutoTurns &&
            card.state.consecutiveFailures < 2
          ) {
            status = 'correlated';
          } else {
            status = 'pending_approval';
          }
        }

        eventRecord = {
          id: crypto.randomUUID(),
          dedupeKey: input.dedupeKey,
          source: input.source,
          eventType: input.eventType,
          resourceKey: input.resourceKey,
          resourceVersion: input.resourceVersion,
          project: input.project ?? null,
          repo: input.repo ?? null,
          branch: input.branch ?? null,
          commitSha: input.commitSha ?? null,
          workItemId: input.workItemId ?? null,
          prId: input.prId ?? null,
          buildId: input.buildId ?? null,
          rid: input.rid ?? null,
          todoId: match.todoId,
          correlationTier: match.tier,
          payloadJson: input.payloadJson ?? '{}',
          status,
          statusDetail,
          occurredAt,
          processedAt: status === 'superseded' || status === 'verified_stale' ? Date.now() : null,
        };
        const nextEvents = [eventRecord, ...current.events];
        set({ events: nextEvents });
        saveFallbackLedger({ ...current, events: nextEvents });
      }
    }

    const latestState = get();
    const card = eventRecord.todoId
      ? latestState.cards.find((c) => c.id === eventRecord.todoId) ?? null
      : null;
    const verification = card
      ? verifyExternalEventAgainstLiveState(eventRecord, card, options)
      : { stale: false, reason: '未绑定卡片' };

    const decision = evaluateEventDispatchDecision(
      eventRecord,
      card,
      latestState.sessions,
      verification,
    );

    return { duplicate, event: eventRecord, decision };
  },

  prepareDispatchAction: async (input) => {
    const assertAccount = captureWorkLedgerAccount();
    if (isNativeHostAction(input) || (input.actionKind.startsWith('session_') && (isNativeHostWork(input.todoId, get().sessions)
      || get().sessions.some((session) => session.id === input.sessionId && isNativeHostSession(session))))) {
      throw new Error(NATIVE_HOST_CONTROL_REASON);
    }
    if (isTauri) {
      const record = await prepareNativeDispatchAction(
        input as unknown as Record<string, unknown>,
      );
      assertAccount();
      await get().hydrate();
      assertAccount();
      return record;
    }

    const current = get();
    const existing = current.actions.find(
      (a) => a.idempotencyKey === input.idempotencyKey,
    );
    if (existing) {
      return existing;
    }

    const card = current.cards.find((c) => c.id === input.todoId);
    if (!card) {
      throw new Error('目标工作卡片不存在');
    }
    let specJson = input.specJson;
    if (['session_create', 'session_prompt', 'session_steer'].includes(input.actionKind)) {
      const spec = JSON.parse(specJson) as Record<string, unknown>;
      if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('派发规格必须为对象');
      specJson = JSON.stringify({ requirementsVersion: card.state.requirementsVersion ?? 0,
        contentVersion: card.state.contentVersion ?? 0, ...spec });
    }
    if (card.state.waitState === 'paused' || card.state.waitState === 'canceled') {
      throw new Error('卡片已暂停或取消，拒绝派发动作');
    }
    if (card.state.autonomyMode === 'readonly') throw new Error('当前工作只读，不允许派发执行动作');

    if (input.sessionId) {
      const session = current.sessions.find((s) => s.id === input.sessionId);
      if (!session) {
        throw new Error('目标会话不存在');
      }
      if (card.state.visibility === 'private' && session.visibility === 'room_shared') {
        throw new Error('隐私边界拦截：私密卡片不得向房间共享会话派发任务');
      }
      if (
        session.controlMode === 'readonly' &&
        (input.actionKind === 'session_prompt' || input.actionKind === 'session_steer')
      ) {
        throw new Error('会话处于只读模式（可能被其他终端占用），拒绝直接注入指令');
      }
    }

    const agentAction = ['session_create', 'session_prompt', 'session_steer'].includes(input.actionKind);
    const requireConfirmation =
      input.requireConfirmation ??
      (card.state.autonomyMode !== 'autonomous' ||
        (agentAction && (card.state.autoTurnsUsed >= card.state.maxAutoTurns || card.state.consecutiveFailures >= 2)));
    if (agentAction && !requireConfirmation && (card.state.autoTurnsUsed >= card.state.maxAutoTurns || card.state.consecutiveFailures >= 2)) {
      throw new Error('已达到自动推进预算或连续失败上限，需人工检查后继续');
    }

    const now = Date.now();
    const record: NativeDispatchActionRecord = {
      id: crypto.randomUUID(),
      idempotencyKey: input.idempotencyKey,
      todoId: input.todoId,
      eventId: input.eventId ?? null,
      sessionId: input.sessionId ?? null,
      actionKind: input.actionKind,
      specJson,
      baselineMarker: input.baselineMarker ?? null,
      state: requireConfirmation ? 'awaiting_approval' : 'prepared',
      receiptRef: null,
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
    };

    const nextActions = [record, ...current.actions];
    const nextCards = agentAction && !requireConfirmation
      ? current.cards.map((c) =>
          c.id === input.todoId
            ? {
                ...c,
                state: {
                  ...c.state,
                  autoTurnsUsed: c.state.autoTurnsUsed + 1,
                  stage: c.state.stage === 'ready' ? 'in_progress' : c.state.stage,
                  updatedAt: now,
                },
              }
            : c,
        )
      : current.cards;

    saveFallbackLedger({ ...current, actions: nextActions, cards: nextCards }, true);
    set({ actions: nextActions, cards: nextCards });
    return record;
  },

  transitionDispatchAction: async (input) => {
    const assertAccount = captureWorkLedgerAccount();
    const targetAction = get().actions.find((action) => action.id === input.id);
    if (targetAction && (isNativeHostAction(targetAction)
      || (targetAction.actionKind.startsWith('session_') && (isNativeHostWork(targetAction.todoId, get().sessions)
        || get().sessions.some((session) => session.id === targetAction.sessionId && isNativeHostSession(session)))))) {
      throw new Error(NATIVE_HOST_CONTROL_REASON);
    }
    if (isTauri) {
      const record = await transitionNativeDispatchAction(
        input as unknown as Record<string, unknown>,
      );
      assertAccount();
      await get().hydrate();
      assertAccount();
      return record;
    }

    const current = get();
    const target = current.actions.find((a) => a.id === input.id);
    if (!target) {
      throw new Error('派发动作不存在');
    }
    if (input.expectedState && target.state !== input.expectedState) throw new Error('派发动作已被其他执行者更新，请重新核对');
    const now = Date.now();
    const updated: NativeDispatchActionRecord = {
      ...target,
      state: input.state,
      receiptRef: input.receiptRef ?? target.receiptRef,
      errorMessage: input.errorMessage ?? null,
      updatedAt: now,
    };
    const nextActions = current.actions.map((a) =>
      a.id === input.id ? updated : a,
    );
    saveFallbackLedger({ ...current, actions: nextActions }, true);
    set({ actions: nextActions });
    return updated;
  },

  reconcileStartupActions: async () => {
    const assertAccount = captureWorkLedgerAccount();
    const current = get();
    const outcomes = reconcilePendingDispatchActions(
      current.actions.filter((action) => !isNativeHostAction(action)
        && !isNativeHostWork(action.todoId, current.sessions)
        && !current.sessions.some((session) => session.id === action.sessionId && isNativeHostSession(session))),
      current.sessions,
    );
    for (const outcome of outcomes) {
      await get().transitionDispatchAction({
        id: outcome.actionId,
        state: outcome.nextState,
        receiptRef: outcome.receiptRef ?? null,
        errorMessage: outcome.nextState === 'failed' ? outcome.reason : null,
      });
      assertAccount();
    }
    return outcomes;
  },
}));
