/**
 * 管家承诺日期安全网。
 *
 * 这里只保留不需要判断力的日期算术；其他当前状态交给大脑决定是否值得说。
 */

import { todayKey, type Todo } from '../stores/todos';

// ─── 事件类型 ───

export type ButlerAlertLevel = 'immediate';

export interface ButlerAlert {
  id: string;
  level: ButlerAlertLevel;
  kind: ButlerAlertKind;
  title: string;
  detail: string;
  at: number;
  ctx?: AlertContext;
}

export interface AlertContext {
  name?: string;
  dueRelation?: 'today' | 'overdue';
  subjectType?: 'commitment';
}

export type ButlerAlertKind =
  | 'commitment-due'
  | 'commitment-overdue';

// ─── 规则输入 ───

export interface RuleInput {
  todos: Todo[];
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
    }
  }

  return alerts;
}
