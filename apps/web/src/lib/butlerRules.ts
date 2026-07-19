/**
 * 管家规则引擎。
 *
 * 判断逻辑：「如果我不说，你大概率会漏，且漏了有实际后果」→ 触发；否则静默。
 * 规则只依赖结构化数据（ADO 字段 + 待办池 + 时间），不调 AI。
 */

import { todayKey, isOverdue, type Todo } from '../stores/todos';
import type { WorkItem, PullRequest, Build } from '../stores/workbench';

// ─── 事件类型 ───

export type ButlerAlertLevel = 'immediate' | 'coffee' | 'silent';

export interface ButlerAlert {
  id: string;
  level: ButlerAlertLevel;
  kind: ButlerAlertKind;
  title: string;
  detail: string;
  at: number;
  /** 结构化上下文——表达层直接使用，不再解析 title */
  ctx?: AlertContext;
}

export interface AlertContext {
  name?: string;
  dueRelation?: 'today' | 'tomorrow' | 'overdue' | 'later';
  daysLeft?: number;
  count?: number;
  hours?: number;
  priority?: number;
  subjectType?: 'commitment' | 'todo' | 'workitem';
}

export type ButlerAlertKind =
  | 'commitment-due'
  | 'commitment-overdue'
  | 'iteration-pressure'
  | 'new-high-priority'
  | 'build-failed'
  | 'review-timeout'
  | 'mention-stale'
  | 'workitem-assigned';

// ─── 规则输入 ───

export interface RuleInput {
  todos: Todo[];
  workItems: WorkItem[];
  pullRequests: PullRequest[];
  builds: Build[];
  adoAccount: string;
  /** 当前迭代结束日期 YYYY-MM-DD，null = 无迭代信息 */
  iterationEndDate: string | null;
  /** 上次轮询完成时间；null 表示首次启动，不做增量提醒 */
  lastPollAt?: number | null;
  /** 上一轮已经触发过的 alert id（用于去重） */
  seenAlertIds: ReadonlySet<string>;
  now?: number;
}

// ─── 规则执行 ───

export function evaluateRules(input: RuleInput): ButlerAlert[] {
  const now = input.now ?? Date.now();
  const today = todayKey(new Date(now));
  const alerts: ButlerAlert[] = [];

  // 1. 承诺到期 / 逾期
  for (const todo of input.todos) {
    if (todo.done || !todo.due) continue;
    if (!todo.committedTo && !todo.waitingFor) continue;

    const id = `commitment:${todo.id}:${todo.due}`;
    if (input.seenAlertIds.has(id)) continue;

    const name = todo.title || todo.note || '待办';
    if (todo.due < today) {
      alerts.push({
        id,
        level: 'immediate',
        kind: 'commitment-overdue',
        title: `承诺已逾期：${name}`,
        detail: todo.committedTo
          ? `你答应 ${todo.committedTo} 的，截止 ${todo.due}`
          : `你在等 ${todo.waitingFor} 回复，已超时`,
        at: now,
        ctx: { name, dueRelation: 'overdue', subjectType: 'commitment' },
      });
    } else if (todo.due === today) {
      alerts.push({
        id,
        level: 'immediate',
        kind: 'commitment-due',
        title: `承诺今天到期：${name}`,
        detail: todo.committedTo
          ? `答应 ${todo.committedTo} 的`
          : `在等 ${todo.waitingFor}`,
        at: now,
        ctx: { name, dueRelation: 'today', subjectType: 'commitment' },
      });
    } else {
      const dueDateMs = new Date(`${todo.due}T00:00:00`).getTime();
      const todayMs = new Date(`${today}T00:00:00`).getTime();
      const daysLeft = Math.round((dueDateMs - todayMs) / 86400000);
      if (daysLeft === 1) {
        alerts.push({
          id,
          level: 'coffee',
          kind: 'commitment-due',
          title: `承诺明天到期：${name}`,
          detail: todo.committedTo
            ? `答应 ${todo.committedTo} 的`
            : `在等 ${todo.waitingFor}`,
          at: now,
          ctx: { name, dueRelation: 'tomorrow', daysLeft: 1, subjectType: 'commitment' },
        });
      }
    }
  }

  // 2. 迭代压力：迭代剩余 ≤ 2 天且有未完成项
  if (input.iterationEndDate) {
    const endMs = new Date(`${input.iterationEndDate}T00:00:00`).getTime();
    const todayMs = new Date(`${today}T00:00:00`).getTime();
    const daysLeft = Math.round((endMs - todayMs) / 86400000);

    if (daysLeft >= 0 && daysLeft <= 2) {
      const myIncomplete = input.workItems.filter(
        (wi) => !isWorkItemDone(wi.state),
      );
      if (myIncomplete.length > 0) {
        const id = `iteration-pressure:${input.iterationEndDate}`;
        if (!input.seenAlertIds.has(id)) {
          const when = daysLeft === 0 ? '今天' : daysLeft === 1 ? '明天' : `${daysLeft} 天后`;
          alerts.push({
            id,
            level: daysLeft === 0 ? 'immediate' : 'coffee',
            kind: 'iteration-pressure',
            title: `迭代${when}结束，${myIncomplete.length} 项未完成`,
            detail: myIncomplete
              .slice(0, 3)
              .map((wi) => `#${wi.id} ${wi.title}`)
              .join('、'),
            at: now,
            ctx: {
              count: myIncomplete.length,
              daysLeft,
              dueRelation: daysLeft === 0 ? 'today' : daysLeft === 1 ? 'tomorrow' : 'later',
            },
          });
        }
      }
    }
  }

  // 3. 新高优先级工作项（Created/Changed 在上次轮询后，Priority <= 2）
  for (const wi of input.workItems) {
    if (isWorkItemDone(wi.state)) continue;
    const priority = wi.priority ?? 4;
    if (priority > 2) continue;
    if (input.lastPollAt == null || !wi.changedDate) continue;
    const changedMs = new Date(wi.changedDate).getTime();
    if (!Number.isFinite(changedMs) || changedMs <= input.lastPollAt) continue;
    const id = `high-priority:${wi.id}:${wi.changedDate}`;
    if (input.seenAlertIds.has(id)) continue;
    alerts.push({
      id,
      level: priority <= 1 ? 'immediate' : 'coffee',
      kind: 'new-high-priority',
      title: `高优先级工作项：#${wi.id} ${wi.title}`,
      detail: `P${priority} · ${wi.project} · ${wi.state}`,
      at: now,
      ctx: { name: `#${wi.id} ${wi.title}`, priority, subjectType: 'workitem' },
    });
  }

  // 4. 构建失败
  for (const build of input.builds) {
    if (build.result.toLocaleLowerCase() !== 'failed') continue;
    const id = `build-failed:${build.id}`;
    if (input.seenAlertIds.has(id)) continue;
    alerts.push({
      id,
      level: 'immediate',
      kind: 'build-failed',
      title: `构建失败：${build.definition} #${build.buildNumber}`,
      detail: build.project,
      at: now,
      ctx: { name: `${build.definition} #${build.buildNumber}` },
    });
  }

  // 5. Review 请求超时（>24h）
  for (const pr of input.pullRequests) {
    if (!pr.createdDate) continue;
    const isReviewForMe =
      pr.reviewers?.some(
        (r) =>
          r.unique?.toLocaleLowerCase() === input.adoAccount.toLocaleLowerCase() &&
          r.vote === 0,
      ) ?? false;
    if (!isReviewForMe) continue;

    const createdMs = new Date(pr.createdDate).getTime();
    const ageHours = (now - createdMs) / (60 * 60 * 1000);
    if (ageHours < 24) continue;

    const id = `review-timeout:${pr.id}`;
    if (input.seenAlertIds.has(id)) continue;
    alerts.push({
      id,
      level: 'coffee',
      kind: 'review-timeout',
      title: `PR 等待你 review 超过 ${Math.floor(ageHours)}h`,
      detail: `#${pr.id} ${pr.title} · ${pr.repo}`,
      at: now,
      ctx: { name: `#${pr.id} ${pr.title}`, hours: Math.floor(ageHours) },
    });
  }

  // 6. 普通待办逾期（非承诺类的，降低优先级）
  for (const todo of input.todos) {
    if (todo.done || !todo.due) continue;
    if (todo.committedTo || todo.waitingFor) continue; // 承诺类已在规则1处理
    if (!isOverdue(todo, today)) continue;

    const id = `todo-overdue:${todo.id}:${today}`;
    if (input.seenAlertIds.has(id)) continue;
    const todoName = todo.title || todo.note || '待办';
    alerts.push({
      id,
      level: 'coffee',
      kind: 'commitment-overdue',
      title: `待办已逾期：${todoName}`,
      detail: `截止 ${todo.due}`,
      at: now,
      ctx: { name: todoName, dueRelation: 'overdue', subjectType: 'todo' },
    });
  }

  return alerts;
}

export function isWorkItemDone(state: string): boolean {
  const lower = state.toLocaleLowerCase();
  return [
    'closed', 'done', 'removed', 'resolved', 'completed',
    '已关闭', '已完成', '已删除', '已移除', '已解决', '完成', '关闭', '已修复',
  ].includes(lower);
}
