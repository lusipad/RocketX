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
      return `晨间个人简报 (${dateKey})`;
    case 'evening_review':
      return `晚间复盘与收尾 (${dateKey})`;
    case 'focus_digest':
    default:
      return `当前聚焦摘要 (${dateKey})`;
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
    const label = todo.title || todo.note || todo.excerpt || '未命名待办';
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
    const title = todo.title || todo.note || todo.excerpt || '未命名待办';
    const priority = todo.priority ?? 3;
    let score = (6 - Math.min(5, Math.max(1, priority))) * 15;
    const reasons: string[] = [];

    if (todo.due && todo.due < today) {
      score += 45;
      reasons.push(`已逾期（截止 ${todo.due}）`);
    } else if (todo.due === today) {
      score += 35;
      reasons.push('今日截止');
    }
    if (card?.state.waitState === 'waiting_approval') {
      score += 40;
      reasons.push('待审批确认');
    } else if (card?.state.waitState === 'blocked') {
      score += 30;
      reasons.push('当前受阻');
    } else if (card?.state.stage === 'verifying') {
      score += 25;
      reasons.push('待完成核验');
    } else if (card?.state.stage === 'in_progress') {
      score += 20;
      reasons.push('进行中');
    }
    if (todo.committedTo?.trim()) {
      score += 15;
      reasons.push(`已承诺 ${todo.committedTo.trim()}`);
    }
    if (reasons.length === 0) {
      reasons.push(`优先级 P${priority}`);
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
    actionItems.push(`优先处理 ${metrics.waitingApprovalCount} 项待审批操作，解除工作流等待`);
  }
  if (overdueTodos.length > 0) {
    actionItems.push(`清点并重新排期 ${overdueTodos.length} 项已逾期待办`);
  }
  if (kind === 'morning_brief' && dueTodayTodos.length > 0) {
    actionItems.push(`锁定今日到期的 ${dueTodayTodos.length} 项关键交付并推进首轮执行`);
  }
  if (kind === 'evening_review') {
    actionItems.push(
      `回顾今日已完成 ${completedTodayTodos.length} 项待办与 ${completedTodayEvents} 项日程，将关键结论沉淀至长期记忆`,
    );
  }
  if (commitments.some((c) => c.direction === 'waiting_for')) {
    const waitingCount = commitments.filter((c) => c.direction === 'waiting_for').length;
    actionItems.push(`跟进 ${waitingCount} 项等待他人回复的承诺事项`);
  }
  if (actionItems.length === 0) {
    actionItems.push('当前节奏平稳，可按聚焦列表顺序推进下一项高优先级任务');
  }

  const title = kindTitle(kind, today);
  const mdLines: string[] = [
    `# ${title}`,
    '',
    '## 核心指标概览',
    `- 未完成待办：**${metrics.openTodos}**（逾期 **${metrics.overdueTodos}** / 今日截止 **${metrics.dueTodayTodos}** / 今日已完成 **${metrics.completedTodayTodos}**）`,
    `- 今日日程：**${metrics.todayEvents}** 项（已完成 **${metrics.completedTodayEvents}**）`,
    `- 活跃工作流：**${metrics.activeWorkflows}**（ACP 会话 **${metrics.acpActiveSessions}** / 待审批 **${metrics.waitingApprovalCount}** / 受阻 **${metrics.blockedCount}**）`,
    '',
    '## 重点聚焦事项',
    ...(focusItems.length > 0
      ? focusItems.map((item) => `- **${item.title}** — ${item.reason}`)
      : ['- 暂无未完成焦点任务']),
    '',
    '## 承诺与协同跟进',
    ...(commitments.length > 0
      ? commitments.map((c) =>
          c.direction === 'committed_to'
            ? `- [我承诺 -> ${c.person}] ${c.title}${c.due ? `（截止 ${c.due}）` : ''}`
            : `- [等待回复 <- ${c.person}] ${c.title}${c.due ? `（截止 ${c.due}）` : ''}`,
        )
      : ['- 暂无记录在案的对外承诺或等待事项']),
    '',
    '## 今日日程安排',
    ...(schedule.length > 0
      ? schedule.map((ev) => {
          const time = ev.allDay ? '全天' : [ev.startTime, ev.endTime].filter(Boolean).join('-') || '未定时间';
          return `- [${ev.done ? 'x' : ' '}] ${time} · ${ev.title}`;
        })
      : ['- 今日暂无日程安排']),
    '',
    '## 活跃工作流与会话',
    ...(activeWorkflows.length > 0
      ? activeWorkflows.map(
          (w) =>
            `- \`${w.runtime}\` **${w.title}**（状态：${w.status}${w.pendingApprovals ? `，待审批 ${w.pendingApprovals} 项` : ''}）`,
        )
      : ['- 当前没有运行中的后台或 ACP 工作流']),
    '',
    '## 下一步行动建议',
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
      : '- （暂无已召回的长期记忆）';

  return [
    `请作为我的个人工作助理，基于以下实时本地工作快照为我生成一份精炼、可执行的「${snapshot.title}」深度分析与行动排序：`,
    '',
    snapshot.markdown,
    '',
    '## 相关长期记忆与工作习惯',
    memoryLines,
    '',
    '输出要求：',
    '1. 指出今天最容易被忽略但影响最大的 1-2 个风险或承诺缺口；',
    '2. 给出按时间段/优先级排列的具体执行顺序；',
    '3. 如需我确认或交给本地 ACP Agent / 管家派工执行的事项，明确列出可直接派发的子任务建议。',
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
