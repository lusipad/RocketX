import type { ButlerErrandRun } from './butlerErrands';
import type { StoredRoundsResult } from './butlerRoundsRunner';
import type { ButlerEventCard, Routine } from '../stores/routines';
import type { Todo } from '../stores/todos';

export type ButlerWorkspaceView =
  | 'now'
  | 'tasks'
  | 'routines'
  | 'conversation'
  | 'memory'
  | 'connections';

export interface ButlerNeedToKnow {
  id: string;
  kind: 'overdue-commitment' | 'routine-failure' | 'stale-mention';
  title: string;
  whyNow: string;
  consequence: string;
  sourceId: string;
  at: number;
}

export interface ButlerDecisionProjection {
  id: string;
  title: string;
  consequence: string;
  run: ButlerErrandRun;
}

export interface ButlerSuggestionProjection {
  id: string;
  title: string;
  whyNow: string;
  suggestedAction: string;
  sourceRef: string;
}

export type ButlerTaskProjectionState =
  | 'needs-user'
  | 'active'
  | 'waiting-external'
  | 'delivered'
  | 'failed';

export interface ButlerTaskProjection {
  id: string;
  kind: 'errand' | 'todo';
  title: string;
  state: ButlerTaskProjectionState;
  statusLabel: string;
  nextAt?: string;
  sourceLabel?: string;
  run?: ButlerErrandRun;
  todo?: Todo;
}

export interface ButlerRoutineProjection {
  id: string;
  name: string;
  enabled: boolean;
  health: 'healthy' | 'waiting-first-run' | 'failing' | 'paused';
  healthLabel: string;
  lastRunAt?: number;
  nextRunLabel: string;
  routine: Routine;
}

export interface ButlerWorkspaceModel {
  needToKnow: ButlerNeedToKnow[];
  decisions: ButlerDecisionProjection[];
  suggestions: ButlerSuggestionProjection[];
  delegations: ButlerTaskProjection[];
  personalTasks: ButlerTaskProjection[];
  routines: ButlerRoutineProjection[];
  summary: {
    watched: number;
    needsAttention: number;
    activeDelegations: number;
    routineFailures: number;
    activationNeeded: boolean;
  };
}

function dateKey(now: number): string {
  const date = new Date(now);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function todoTitle(todo: Todo): string {
  return todo.title || todo.note || todo.excerpt || '未命名任务';
}

function latestRoutineRun(routine: Routine) {
  return [...routine.runs].sort((left, right) => right.at - left.at)[0];
}

function routineScheduleLabel(routine: Routine): string {
  if (!routine.enabled) return '已暂停';
  if (routine.trigger.kind === 'interval') {
    return `每 ${routine.trigger.everyMinutes} 分钟`;
  }
  return `每天 ${routine.trigger.time}`;
}

function taskFromErrand(run: ButlerErrandRun): ButlerTaskProjection {
  const state: ButlerTaskProjectionState = run.status === 'awaiting-approval'
    ? 'needs-user'
    : run.status === 'paused'
      ? 'needs-user'
    : run.status === 'running'
      ? 'active'
      : run.status === 'replied'
        ? 'delivered'
        : 'failed';
  const statusLabel = run.status === 'awaiting-approval'
    ? '等你决定'
    : run.status === 'paused'
      ? run.error || '已暂停，等你决定是否继续'
    : run.status === 'running'
      ? run.activity || '正在处理'
      : run.status === 'replied'
        ? '已交付'
        : '没办成';
  return {
    id: `errand:${run.id}`,
    kind: 'errand',
    title: run.title,
    state,
    statusLabel,
    sourceLabel: run.workspaceName || run.roomContext?.roomName,
    run,
  };
}

function taskFromTodo(todo: Todo, today: string): ButlerTaskProjection {
  const overdue = Boolean(todo.due && todo.due < today);
  const state: ButlerTaskProjectionState = todo.waitingFor
    ? 'waiting-external'
    : 'active';
  return {
    id: `todo:${todo.id}`,
    kind: 'todo',
    title: todoTitle(todo),
    state,
    statusLabel: todo.waitingFor
      ? `在等 ${todo.waitingFor}`
      : overdue
        ? '已逾期'
        : todo.committedTo
          ? `答应给 ${todo.committedTo}`
          : '待处理',
    nextAt: todo.due,
    sourceLabel: todo.roomName,
    todo,
  };
}

export function buildButlerWorkspaceModel({
  errands,
  todos,
  routines,
  eventCards,
  rounds,
  acknowledgedNeedIds = [],
  now = Date.now(),
}: {
  errands: readonly ButlerErrandRun[];
  todos: readonly Todo[];
  routines: readonly Routine[];
  eventCards: readonly ButlerEventCard[];
  rounds: StoredRoundsResult | null;
  acknowledgedNeedIds?: readonly string[];
  now?: number;
}): ButlerWorkspaceModel {
  const today = dateKey(now);
  const visibleErrands = errands.filter((run) => !run.archivedAt);
  const openTodos = todos.filter((todo) => !todo.done);

  const decisions = visibleErrands
    .filter((run) => run.status === 'awaiting-approval')
    .map((run) => ({
      id: `decision:${run.id}`,
      title: `${run.title}需要你决定`,
      consequence: run.approvals[0]?.method
        ? `批准后将执行 ${run.approvals[0].method}`
        : '批准后管家会继续执行这件事',
      run,
    }));

  const routineNeedToKnow: ButlerNeedToKnow[] = routines.flatMap((routine) => {
    if (!routine.enabled) return [];
    const latest = latestRoutineRun(routine);
    if (!latest || latest.status !== 'error') return [];
    return [{
      id: `need:routine:${routine.id}:${latest.id}`,
      kind: 'routine-failure' as const,
      title: `${routine.name}没有完成`,
      whyNow: `最近一次运行失败于 ${new Date(latest.at).toLocaleString()}`,
      consequence: '在恢复前，这项责任没有被可靠照看。',
      sourceId: routine.id,
      at: latest.at,
    }];
  });

  const overdueCommitments: ButlerNeedToKnow[] = openTodos.flatMap((todo) => {
    if (!todo.committedTo || !todo.due || todo.due >= today) return [];
    return [{
      id: `need:todo:${todo.id}:${today}`,
      kind: 'overdue-commitment' as const,
      title: `${todoTitle(todo)}已经超过承诺时间`,
      whyNow: `原定 ${todo.due} 交付给 ${todo.committedTo}`,
      consequence: '继续不处理可能让对方失去预期。',
      sourceId: todo.id,
      at: todo.updatedAt ?? todo.createdAt,
    }];
  });

  const staleMentions: ButlerNeedToKnow[] = eventCards.map((card) => ({
    id: `need:event:${card.id}`,
    kind: 'stale-mention',
    title: card.title,
    whyNow: card.detail,
    consequence: '这条 @我 仍未得到回应。',
    sourceId: card.id,
    at: card.at,
  }));

  const acknowledged = new Set(acknowledgedNeedIds);
  const needToKnow = [...routineNeedToKnow, ...overdueCommitments, ...staleMentions]
    .filter((item) => !acknowledged.has(item.id))
    .sort((left, right) => right.at - left.at);

  const suggestions = (rounds?.result.items ?? [])
    .filter((item) => !(rounds?.snoozedRefs ?? []).includes(item.ref))
    .filter((item) => Boolean(item.suggestedAction))
    .slice(0, 3)
    .map((item) => ({
      id: `suggestion:${item.ref}`,
      title: rounds?.refTitles[item.ref] ?? '值得继续处理的事项',
      whyNow: item.why,
      suggestedAction: item.suggestedAction as string,
      sourceRef: item.ref,
    }));

  const taskOrder = (left: ButlerTaskProjection, right: ButlerTaskProjection): number => {
    const order: Record<ButlerTaskProjectionState, number> = {
      'needs-user': 0,
      active: 1,
      'waiting-external': 2,
      delivered: 3,
      failed: 4,
    };
    return order[left.state] - order[right.state];
  };
  const delegations = visibleErrands.map(taskFromErrand).sort(taskOrder);
  const personalTasks = openTodos.map((todo) => taskFromTodo(todo, today)).sort(taskOrder);

  const routineProjections = routines.map((routine): ButlerRoutineProjection => {
    const latest = latestRoutineRun(routine);
    const health = !routine.enabled
      ? 'paused'
      : !latest
        ? 'waiting-first-run'
        : latest.status === 'error'
          ? 'failing'
          : 'healthy';
    return {
      id: routine.id,
      name: routine.name,
      enabled: routine.enabled,
      health,
      healthLabel: health === 'paused'
        ? '已暂停'
        : health === 'waiting-first-run'
          ? '等待首次运行'
          : health === 'failing'
            ? '需要修复'
            : '正常',
      lastRunAt: latest?.at,
      nextRunLabel: routineScheduleLabel(routine),
      routine,
    };
  }).sort((left, right) => {
    const order = { failing: 0, 'waiting-first-run': 1, healthy: 2, paused: 3 };
    return order[left.health] - order[right.health];
  });

  const routineFailures = routineProjections.filter((routine) => routine.health === 'failing').length;
  const watched = routineProjections.filter((routine) => routine.enabled).length;
  return {
    needToKnow,
    decisions,
    suggestions,
    delegations,
    personalTasks,
    routines: routineProjections,
    summary: {
      watched,
      needsAttention: needToKnow.length + decisions.length,
      activeDelegations: delegations.filter((task) => task.state === 'active').length,
      routineFailures,
      activationNeeded: watched === 0
        && delegations.length === 0
        && personalTasks.length === 0
        && suggestions.length === 0
        && needToKnow.length === 0
        && decisions.length === 0,
    },
  };
}
