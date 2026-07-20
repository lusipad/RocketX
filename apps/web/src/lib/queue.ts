import { eventsForDate, isEventDone, type CalendarEvent } from '../stores/calendar';
import { dueLabel, isOverdue, todayKey, type Todo } from '../stores/todos';
import {
  adoDateToLocal,
  isApproved,
  isWorkItemDone,
  matchUser,
  type Build,
  type PullRequest,
  type WorkItem,
} from '../stores/workbench';
import { latestBuildsByDefinitionProject } from './butlerBuilds';

/**
 * 工作台首页的「待处理队列」。
 *
 * 工作台以前是个仪表盘：四个统计卡、日程、待办、ADO 各占一块，各自为政。
 * 结果是屏幕上全是 0 和「暂无」，唯一有数据的 ADO 反而被挤到最下面。
 *
 * 现在换成一条队列：不管这件事来自 ADO、待办还是构建，只要「需要你处理」，
 * 就按紧急程度排在一起。空的类别不出现，不占位。
 */

export type QueueKind =
  | 'overdue-todo'
  | 'failed-build'
  | 'review-pr'
  | 'today-todo'
  | 'urgent-workitem'
  | 'approved-pr'
  | 'workitem'
  /** 已过截止日期的工作项 */
  | 'overdue-workitem'
  | 'todo'
  /** 今天的日程 */
  | 'event';

export interface QueueItem {
  key: string;
  kind: QueueKind;
  /** 越小越紧急，排序用 */
  urgency: number;
  /** 左侧的类别标签 */
  label: string;
  title: string;
  /** 右侧的补充信息（项目 / 仓库 / 会话名） */
  meta?: string;
  /** 圆点颜色 */
  color: string;
  /** 外链（ADO 的工作项 / PR / 构建） */
  href?: string;
  /** 待办：点了跳回原消息 */
  todo?: Todo;
  /** 日程：点了跳到日历 */
  event?: CalendarEvent;
}

const DANGER = '#f54a45';
const PURPLE = '#7f3bf5';
const WARNING = '#ff8800';
const PRIMARY = '#3370ff';
const MUTED = '#8f959e';
const SUCCESS = '#00b96b';

export interface QueueInput {
  todos: Todo[];
  workItems: WorkItem[];
  prs: PullRequest[];
  builds: Build[];
  /** 今天的日程也是「今天要处理的事」—— 之前它被单独扔在右栏，不进队列 */
  events: CalendarEvent[];
  /** ADO 账号，用来区分「待我评审」和「我提的」 */
  account: string;
  today?: string;
}

/**
 * 紧急度分档（数字即排序权重）：
 *  0 逾期待办 / 逾期工作项 —— 已经欠账了。一个逾期的 P3 比一个没有截止日期的 P1
 *                            更该现在处理，所以截止日期压过优先级
 *  1 构建失败      —— 主干红着，谁看见谁管
 *  2 今天的日程    —— 有具体时间点，错过就没了
 *  3 待我评审 PR   —— 别人被我卡着
 *  4 今天到期待办
 *  5 高优工作项    —— P1 且在进行中
 *  6 我提的 PR 已通过评审 —— 可以合了，就差我点一下
 *  7 其他工作项
 *  8 其他待办
 */
export function buildQueue(input: QueueInput): QueueItem[] {
  const today = input.today ?? todayKey();
  const items: QueueItem[] = [];

  for (const t of input.todos) {
    if (t.done) continue;
    const title = t.note || t.excerpt || '（无描述）';
    if (isOverdue(t, today)) {
      items.push({
        key: `todo-${t.id}`,
        kind: 'overdue-todo',
        urgency: 0,
        label: '逾期',
        title,
        meta: t.roomName,
        color: DANGER,
        todo: t,
      });
    } else if (t.due === today) {
      items.push({
        key: `todo-${t.id}`,
        kind: 'today-todo',
        urgency: 4,
        label: '今天到期',
        title,
        meta: t.roomName,
        color: WARNING,
        todo: t,
      });
    } else {
      items.push({
        key: `todo-${t.id}`,
        kind: 'todo',
        urgency: 8,
        label: '待办',
        title,
        meta: t.roomName,
        color: MUTED,
        todo: t,
      });
    }
  }

  // 今天的日程（含重复日程展开）；标记完成的不再占队列
  for (const e of eventsForDate(input.events, today)) {
    if (isEventDone(e, today)) continue;
    items.push({
      key: `event-${e.id}-${today}`,
      kind: 'event',
      urgency: 2,
      label: e.allDay ? '今天' : (e.startTime ?? '今天'),
      title: e.title,
      meta: e.allDay
        ? '全天'
        : e.endTime
          ? `${e.startTime} - ${e.endTime}`
          : undefined,
      color: e.color,
      event: e,
    });
  }

  for (const b of latestBuildsByDefinitionProject(input.builds)) {
    if (b.result !== 'failed') continue;
    items.push({
      key: `build-${b.project}-${b.id}`,
      kind: 'failed-build',
      urgency: 1,
      label: '构建失败',
      title: b.definition,
      meta: `${b.buildNumber} · ${b.project}`,
      color: DANGER,
      href: b.webUrl,
    });
  }

  for (const pr of input.prs) {
    const mine = pr.rel
      ? pr.rel === 'mine' || pr.rel === 'both'
      : matchUser(input.account, pr.creatorUnique, pr.creator);
    const iReview = pr.rel
      ? pr.rel === 'review' || pr.rel === 'both'
      : pr.reviewers.some((r) => matchUser(input.account, r.unique, r.name));

    if (!mine && iReview) {
      items.push({
        key: `pr-${pr.id}`,
        kind: 'review-pr',
        urgency: 3,
        label: '待我评审',
        title: pr.title,
        meta: `!${pr.id} · ${pr.repo}`,
        color: PURPLE,
        href: pr.webUrl,
      });
    } else if (mine && isApproved(pr)) {
      // 评审都过了还挂着 —— 这是等我去合，属于「该我动手」
      items.push({
        key: `pr-${pr.id}`,
        kind: 'approved-pr',
        urgency: 6,
        label: '已通过评审',
        title: pr.title,
        meta: `!${pr.id} · ${pr.repo}`,
        color: SUCCESS,
        href: pr.webUrl,
      });
    }
  }

  for (const w of input.workItems) {
    if (isWorkItemDone(w.state)) continue;
    const due = adoDateToLocal(w.dueDate);
    const overdue = !!due && due < today;
    const dueToday = due === today;
    const urgent = w.priority === 1;

    // 有截止日期的工作项要按「还剩多久」排，而不是一律按优先级。
    // 一个逾期的 P3 比一个没有截止日期的 P1 更该现在处理。
    const urgency = overdue ? 0 : dueToday ? 4 : urgent ? 5 : 7;
    const kind: QueueKind = overdue
      ? 'overdue-workitem'
      : urgent
        ? 'urgent-workitem'
        : 'workitem';

    items.push({
      key: `wi-${w.id}`,
      kind,
      urgency,
      label: overdue
        ? '逾期'
        : dueToday
          ? '今天到期'
          : urgent
            ? `${w.type} P1`
            : w.type,
      title: w.title,
      meta: [`#${w.id}`, w.state, due ? dueLabel(due, today) : null]
        .filter(Boolean)
        .join(' · '),
      color: overdue ? DANGER : dueToday ? WARNING : urgent ? DANGER : PRIMARY,
      href: w.webUrl,
    });
  }

  // 同一档内保持各自来源的原有顺序（工作项已按更新时间倒序，待办按截止日）
  return items.sort((a, b) => a.urgency - b.urgency);
}

/** 顶部那句话：「3 项待处理 · 1 项逾期」 */
export function queueSummary(items: QueueItem[]): string {
  if (items.length === 0) return '今天没有待处理的事';
  const overdue = items.filter(
    (i) =>
      i.kind === 'overdue-todo' || i.kind === 'overdue-workitem' || i.kind === 'failed-build',
  ).length;
  const base = `${items.length} 项待处理`;
  return overdue > 0 ? `${base} · ${overdue} 项需要立刻处理` : base;
}
