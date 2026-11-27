import { t } from '../i18n';
import type {
  ButlerAssistantDigest,
  ButlerMemoryEntry,
} from '../platform/desktopCommands';
import { useAcpAgents } from '../stores/acpAgents';
import { isMemoryCurrent, isMemoryInWorkspace, useButlerMemory } from '../stores/butlerMemory';
import { dateKey as formatDateKey, eventsForDate, isEventDone, useCalendar } from '../stores/calendar';
import { useTodos } from '../stores/todos';
import { useWorkLedger } from '../stores/workLedger';

export type PersonalAssistantBriefKind =
  | 'morning_brief'
  | 'evening_review'
  | 'focus_digest';

export interface PersonalAssistantMetrics {
  openTodos: number;
  overdueTodos: number;
  dueTodayTodos: number;
  completedTodayTodos: number;
  todayEvents: number;
  completedTodayEvents: number;
  activeWorkflows: number;
  waitingApprovalCount: number;
  blockedCount: number;
  acpActiveSessions: number;
  memoryCount: number;
}

export interface PersonalAssistantFocusItem {
  id: string;
  title: string;
  reason: string;
  priority: number;
  due?: string | null;
  stage?: string;
}

export interface PersonalAssistantCommitment {
  todoId: string;
  title: string;
  direction: 'committed_to' | 'waiting_for';
  person: string;
  due?: string | null;
}

export interface PersonalAssistantScheduleItem {
  id: string;
  title: string;
  startTime?: string;
  endTime?: string;
  allDay: boolean;
  done: boolean;
}

export interface PersonalAssistantWorkflowItem {
  id: string;
  title: string;
  runtime: string;
  status: string;
  workspaceRoot?: string;
  pendingApprovals?: number;
}

export interface PersonalAssistantSnapshot {
  kind: PersonalAssistantBriefKind;
  dateKey: string;
  title: string;
  generatedAt: number;
  metrics: PersonalAssistantMetrics;
  focusItems: PersonalAssistantFocusItem[];
  commitments: PersonalAssistantCommitment[];
  schedule: PersonalAssistantScheduleItem[];
  activeWorkflows: PersonalAssistantWorkflowItem[];
  relevantMemories: ButlerMemoryEntry[];
  actionItems: string[];
  markdown: string;
}

function kindTitle(kind: PersonalAssistantBriefKind, dateKey: string): string {
  switch (kind) {
    case 'morning_brief':
      return t('agent.assistant.morningBriefTitle', { dateKey });
    case 'evening_review':
      return t('agent.assistant.eveningReviewTitle', { dateKey });
    case 'focus_digest':
    default:
      return t('agent.assistant.focusDigestTitle', { dateKey });
  }
}

export function generatePersonalAssistantBrief(
  kind: PersonalAssistantBriefKind,
  now: Date = new Date(),
  workspaceRoot?: string | null,
): PersonalAssistantSnapshot {
  const today = formatDateKey(now);
  const startOfDayMs = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const endOfDayMs = startOfDayMs + 24 * 60 * 60 * 1000;

  const todos = useTodos.getState().todos;
  const calendarEvents = useCalendar.getState().events;
  const ledger = useWorkLedger.getState();
  const acpState = useAcpAgents.getState();
  const memoryState = useButlerMemory.getState();

  const openTodos = todos.filter((t) => !t.done);
  const overdueTodos = openTodos.filter((t) => Boolean(t.due && t.due < today));
  const dueTodayTodos = openTodos.filter((t) => t.due === today);
  const completedTodayTodos = todos.filter(
    (t) => t.done && t.doneAt != null && t.doneAt >= startOfDayMs && t.doneAt < endOfDayMs,
  );

  const todayCalendar = eventsForDate(calendarEvents, today).sort((a, b) =>
    (a.startTime ?? '').localeCompare(b.startTime ?? ''),
  );
  const schedule: PersonalAssistantScheduleItem[] = todayCalendar.map((ev) => ({
    id: ev.id,
    title: ev.title,
    startTime: ev.startTime,
    endTime: ev.endTime,
    allDay: ev.allDay,
    done: isEventDone(ev, today),
  }));
  const completedTodayEvents = schedule.filter((s) => s.done).length;

  const cardById = new Map(ledger.cards.map((c) => [c.id, c]));
  const waitingApprovalCards = ledger.cards.filter(
    (c) => !c.done && c.state.waitState === 'waiting_approval',
  );
  const blockedCards = ledger.cards.filter(
    (c) => !c.done && c.state.waitState === 'blocked',
  );

  const acpSessionsList = Object.values(acpState.sessions);
  const acpActiveSessions = acpSessionsList.filter(
    (s) => s.status !== 'stopped' && s.status !== 'error',
  );
  const acpWaitingApprovalCount = acpSessionsList.reduce(
    (sum, s) => sum + s.pendingPermissions.length,
    0,
  );

  const activeWorkflows: PersonalAssistantWorkflowItem[] = [];
  for (const s of acpActiveSessions) {
    activeWorkflows.push({
      id: s.sessionKey,
      title: s.title,
      runtime: `acp:${s.preset}`,
      status: s.status,
      workspaceRoot: s.workspaceRoot,
      pendingApprovals: s.pendingPermissions.length,
    });
  }
  for (const s of ledger.sessions) {
    if (s.runtime === 'acp') continue;
    if (s.runtimeStatus === 'running' || s.runtimeStatus === 'waiting_approval') {
      activeWorkflows.push({
        id: s.id,
        title: s.title || s.nativeSessionId,
        runtime: s.runtime,
        status: s.runtimeStatus,
        workspaceRoot: s.workspaceRoot,
      });
    }
  }

  const commitments: PersonalAssistantCommitment[] = [];
  for (const todo of openTodos) {
    const label = todo.title || todo.note || todo.excerpt || t('agent.assistant.unnamedTodo');
    if (todo.committedTo?.trim()) {
      commitments.push({
        todoId: todo.id,
        title: label,
        direction: 'committed_to',
        person: todo.committedTo.trim(),
        due: todo.due ?? null,
      });
    }
    if (todo.waitingFor?.trim()) {
      commitments.push({
        todoId: todo.id,
        title: label,
        direction: 'waiting_for',
        person: todo.waitingFor.trim(),
        due: todo.due ?? null,
      });
    }
  }

  const focusCandidates: Array<{ score: number; item: PersonalAssistantFocusItem }> = [];
  for (const todo of openTodos) {
    const card = cardById.get(todo.id);
    const title = todo.title || todo.note || todo.excerpt || t('agent.assistant.unnamedTodo');
    const priority = todo.priority ?? 3;
    let score = (6 - Math.min(5, Math.max(1, priority))) * 15;
    const reasons: string[] = [];

    if (todo.due && todo.due < today) {
      score += 45;
      reasons.push(t('agent.assistant.reason.overdue', { due: todo.due ?? '' }));
    } else if (todo.due === today) {
      score += 35;
      reasons.push(t('agent.assistant.reason.dueToday'));
    }
    if (card?.state.waitState === 'waiting_approval') {
      score += 40;
      reasons.push(t('agent.assistant.reason.waitingApproval'));
    } else if (card?.state.waitState === 'blocked') {
      score += 30;
      reasons.push(t('agent.assistant.reason.blocked'));
    } else if (card?.state.stage === 'verifying') {
      score += 25;
      reasons.push(t('agent.assistant.reason.verifying'));
    } else if (card?.state.stage === 'in_progress') {
      score += 20;
      reasons.push(t('agent.assistant.reason.inProgress'));
    }
    if (todo.committedTo?.trim()) {
      score += 15;
      reasons.push(t('agent.assistant.reason.committedTo', { person: todo.committedTo.trim() }));
    }
    if (reasons.length === 0) {
      reasons.push(t('agent.assistant.reason.priority', { priority }));
    }

    focusCandidates.push({
      score,
      item: {
        id: todo.id,
        title,
        reason: reasons.join(' · '),
        priority,
        due: todo.due ?? null,
        stage: card?.state.stage,
      },
    });
  }

  const focusItems = focusCandidates
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map((entry) => entry.item);

  const relevantMemories = memoryState.memoryPaused
    ? []
    : memoryState.memories
        .filter((m) => m.accountScope === memoryState.accountScope && isMemoryCurrent(m, now.getTime()) && isMemoryInWorkspace(m, workspaceRoot))
        .sort(
          (a, b) =>
            Number(b.pinned) - Number(a.pinned) ||
            b.confidence - a.confidence ||
            b.updatedAt - a.updatedAt,
        )
        .slice(0, 5);

  const metrics: PersonalAssistantMetrics = {
    openTodos: openTodos.length,
    overdueTodos: overdueTodos.length,
    dueTodayTodos: dueTodayTodos.length,
    completedTodayTodos: completedTodayTodos.length,
    todayEvents: schedule.length,
    completedTodayEvents,
    activeWorkflows: activeWorkflows.length,
    waitingApprovalCount: waitingApprovalCards.length + acpWaitingApprovalCount,
    blockedCount: blockedCards.length,
    acpActiveSessions: acpActiveSessions.length,
    memoryCount: memoryState.memories.filter((m) => m.accountScope === memoryState.accountScope && isMemoryCurrent(m, now.getTime())).length,
  };

  const actionItems: string[] = [];
  if (metrics.waitingApprovalCount > 0) {
    actionItems.push(t('agent.assistant.action.approvals', { count: metrics.waitingApprovalCount }));
  }
  if (overdueTodos.length > 0) {
    actionItems.push(t('agent.assistant.action.overdue', { count: overdueTodos.length }));
  }
  if (kind === 'morning_brief' && dueTodayTodos.length > 0) {
    actionItems.push(t('agent.assistant.action.dueToday', { count: dueTodayTodos.length }));
  }
  if (kind === 'evening_review') {
    actionItems.push(
      t('agent.assistant.action.eveningSummary', { todos: completedTodayTodos.length, events: completedTodayEvents }),
    );
  }
  if (commitments.some((c) => c.direction === 'waiting_for')) {
    const waitingCount = commitments.filter((c) => c.direction === 'waiting_for').length;
    actionItems.push(t('agent.assistant.action.waitingFor', { count: waitingCount }));
  }
  if (actionItems.length === 0) {
    actionItems.push(t('agent.assistant.action.steady'));
  }

  const title = kindTitle(kind, today);
  const mdLines: string[] = [
    `# ${title}`,
    '',
    t('agent.assistant.md.metricsHeading'),
    t('agent.assistant.md.todosLine', { open: metrics.openTodos, overdue: metrics.overdueTodos, dueToday: metrics.dueTodayTodos, completedToday: metrics.completedTodayTodos }),
    t('agent.assistant.md.eventsLine', { total: metrics.todayEvents, completed: metrics.completedTodayEvents }),
    t('agent.assistant.md.workflowsLine', { active: metrics.activeWorkflows, acp: metrics.acpActiveSessions, approvals: metrics.waitingApprovalCount, blocked: metrics.blockedCount }),
    '',
    t('agent.assistant.md.focusHeading'),
    ...(focusItems.length > 0
      ? focusItems.map((item) => `- **${item.title}** — ${item.reason}`)
      : [t('agent.assistant.md.focusEmpty')]),
    '',
    t('agent.assistant.md.commitmentsHeading'),
    ...(commitments.length > 0
      ? commitments.map((c) => {
          const duePart = c.due ? t('agent.assistant.md.duePart', { due: c.due }) : '';
          return c.direction === 'committed_to'
            ? t('agent.assistant.md.committedLine', { person: c.person, title: c.title, duePart })
            : t('agent.assistant.md.waitingForLine', { person: c.person, title: c.title, duePart });
        })
      : [t('agent.assistant.md.commitmentsEmpty')]),
    '',
    t('agent.assistant.md.scheduleHeading'),
    ...(schedule.length > 0
      ? schedule.map((ev) => {
          const time = ev.allDay ? t('agent.assistant.md.allDay') : [ev.startTime, ev.endTime].filter(Boolean).join('-') || t('agent.assistant.md.unscheduled');
          return `- [${ev.done ? 'x' : ' '}] ${time} · ${ev.title}`;
        })
      : [t('agent.assistant.md.scheduleEmpty')]),
    '',
    t('agent.assistant.md.workflowsHeading'),
    ...(activeWorkflows.length > 0
      ? activeWorkflows.map(
          (w) =>
            t('agent.assistant.md.workflowLine', {
              runtime: w.runtime,
              title: w.title,
              status: w.status,
              approvalsPart: w.pendingApprovals ? t('agent.assistant.md.workflowPendingApprovals', { count: w.pendingApprovals }) : '',
            }),
        )
      : [t('agent.assistant.md.workflowsEmpty')]),
    '',
    t('agent.assistant.md.actionsHeading'),
    ...actionItems.map((item) => `- ${item}`),
  ];

  return {
    kind,
    dateKey: today,
    title,
    generatedAt: now.getTime(),
    metrics,
    focusItems,
    commitments,
    schedule,
    activeWorkflows,
    relevantMemories,
    actionItems,
    markdown: mdLines.join('\n'),
  };
}

export function buildAssistantAiSynthesisPrompt(
  snapshot: PersonalAssistantSnapshot,
): string {
  const memoryLines =
    snapshot.relevantMemories.length > 0
      ? snapshot.relevantMemories
          .map((m) => `- (${m.category}) ${m.title}: ${m.content}`)
          .join('\n')
      : t('agent.assistant.synth.noMemories');

  return [
    t('agent.assistant.synth.intro', { title: snapshot.title }),
    '',
    snapshot.markdown,
    '',
    t('agent.assistant.synth.memoriesHeading'),
    memoryLines,
    '',
    t('agent.assistant.synth.reqsTitle'),
    t('agent.assistant.synth.req1'),
    t('agent.assistant.synth.req2'),
    t('agent.assistant.synth.req3'),
  ].join('\n');
}

export async function saveAssistantSnapshotDigest(
  snapshot: PersonalAssistantSnapshot,
): Promise<ButlerAssistantDigest> {
  return useButlerMemory.getState().saveDigest({
    kind: snapshot.kind,
    dateKey: snapshot.dateKey,
    title: snapshot.title,
    summaryMd: snapshot.markdown,
    metricsJson: JSON.stringify(snapshot.metrics),
    actionItemsJson: JSON.stringify(snapshot.actionItems),
  });
}
