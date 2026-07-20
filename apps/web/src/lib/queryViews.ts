import {
  adoDateToLocal,
  isWorkItemDone,
  workItemStateCategory,
  type WorkItem,
  type WorkItemStateCategory,
} from '../stores/workbench';
import { todayKey } from '../stores/todos';

/**
 * 自定义查询结果的看板/WBS 视图（issue #82、#83）。
 *
 * 数据源就是 ADO 上已维护好的查询：查询定义「看什么」（范围、过滤、排序都在
 * ADO 端），这里只负责「怎么看」。不引入第二套过滤器，避免和查询语义打架。
 */

const CATEGORY_ORDER: Record<WorkItemStateCategory, number> = {
  new: 0,
  active: 1,
  resolved: 2,
  done: 3,
  other: 4,
};

export interface BoardColumn {
  state: string;
  items: WorkItem[];
}

/**
 * 看板列 = 查询结果里真实出现的状态（不硬编码流程模板），
 * 按 新建 → 进行中 → 已解决 → 完成 归类排序，同类保持首次出现的顺序。
 * 列内卡片：逾期在最前，然后按截止日、优先级、编号。
 */
export function boardColumns(items: WorkItem[], today = todayKey()): BoardColumn[] {
  const byState = new Map<string, WorkItem[]>();
  for (const item of items) {
    const column = byState.get(item.state) ?? [];
    column.push(item);
    byState.set(item.state, column);
  }
  const firstSeen = new Map([...byState.keys()].map((state, index) => [state, index]));
  return [...byState.keys()]
    .sort(
      (a, b) =>
        CATEGORY_ORDER[workItemStateCategory(a)] - CATEGORY_ORDER[workItemStateCategory(b)] ||
        firstSeen.get(a)! - firstSeen.get(b)!,
    )
    .map((state) => ({
      state,
      items: [...byState.get(state)!].sort((a, b) => boardCardRank(a, today) - boardCardRank(b, today) || a.id - b.id),
    }));
}

function boardCardRank(item: WorkItem, today: string): number {
  const due = adoDateToLocal(item.dueDate);
  if (due && due < today && !isWorkItemDone(item.state)) return 0;
  if (due) return 1;
  if (item.priority === 1) return 2;
  if (item.priority === 2) return 3;
  return 4;
}

export interface WorkItemRisk {
  /** 有截止日且已过、未完成 */
  overdue: boolean;
  /** 未完成且超过 staleDays 天没有任何更新 */
  stale: boolean;
  /** 未完成且没有负责人 */
  unassigned: boolean;
}

export interface WbsNodeStats extends Record<keyof WorkItemRisk, number> {
  /** 子树内工作项总数（含自身） */
  total: number;
  /** 子树内已完成（已解决/已关闭）数 */
  done: number;
}

export interface WbsOptions {
  /** 今天（YYYY-MM-DD），测试注入用 */
  today?: string;
  /** 停滞判定天数，默认 7 */
  staleDays?: number;
}

/** 单个工作项的风险信号（issue #83 一期：规则化，不引入 AI） */
export function workItemRisk(item: WorkItem, opts: WbsOptions = {}): WorkItemRisk {
  const today = opts.today ?? todayKey();
  const staleDays = opts.staleDays ?? 7;
  if (isWorkItemDone(item.state)) return { overdue: false, stale: false, unassigned: false };
  const due = adoDateToLocal(item.dueDate);
  const changedMs = item.changedDate ? new Date(item.changedDate).getTime() : NaN;
  const todayMs = new Date(`${today}T00:00:00`).getTime();
  return {
    overdue: !!due && due < today,
    stale: Number.isFinite(changedMs) && todayMs - changedMs > staleDays * 86400000,
    unassigned: !item.assignedTo,
  };
}

/**
 * 每个工作项的子树汇总（含自身）：进度 = done/total，风险计数用于树上标注。
 * 只在当前查询结果内组树（同 workItemTreeRows 的取舍）；父项不在结果里的当根算。
 */
export function wbsStats(items: WorkItem[], opts: WbsOptions = {}): Map<number, WbsNodeStats> {
  const byId = new Map(items.map((item) => [item.id, item]));
  const children = new Map<number, WorkItem[]>();
  for (const item of items) {
    if (item.parentId && item.parentId !== item.id && byId.has(item.parentId)) {
      const siblings = children.get(item.parentId) ?? [];
      siblings.push(item);
      children.set(item.parentId, siblings);
    }
  }

  const stats = new Map<number, WbsNodeStats>();
  const visiting = new Set<number>();
  const compute = (item: WorkItem): WbsNodeStats => {
    const cached = stats.get(item.id);
    if (cached) return cached;
    const risk = workItemRisk(item, opts);
    const own: WbsNodeStats = {
      total: 1,
      done: isWorkItemDone(item.state) ? 1 : 0,
      overdue: risk.overdue ? 1 : 0,
      stale: risk.stale ? 1 : 0,
      unassigned: risk.unassigned ? 1 : 0,
    };
    // 数据里出现环（脏 parent 指针）时按叶子处理，不无限递归
    if (visiting.has(item.id)) return own;
    visiting.add(item.id);
    for (const child of children.get(item.id) ?? []) {
      const sub = compute(child);
      own.total += sub.total;
      own.done += sub.done;
      own.overdue += sub.overdue;
      own.stale += sub.stale;
      own.unassigned += sub.unassigned;
    }
    visiting.delete(item.id);
    stats.set(item.id, own);
    return own;
  };
  for (const item of items) compute(item);
  return stats;
}

/** 整个查询结果的汇总行（WBS 顶部的整体进度与风险） */
export function wbsSummary(items: WorkItem[], opts: WbsOptions = {}): WbsNodeStats {
  const summary: WbsNodeStats = { total: 0, done: 0, overdue: 0, stale: 0, unassigned: 0 };
  for (const item of items) {
    const risk = workItemRisk(item, opts);
    summary.total += 1;
    if (isWorkItemDone(item.state)) summary.done += 1;
    if (risk.overdue) summary.overdue += 1;
    if (risk.stale) summary.stale += 1;
    if (risk.unassigned) summary.unassigned += 1;
  }
  return summary;
}
