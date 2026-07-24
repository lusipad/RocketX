import { create } from 'zustand';
import {
  ADO_WEB_KEY,
  loadWorkbenchConfig,
  saveWorkbenchConfig,
  type WorkbenchConfig,
} from '../lib/ado';

/**
 * 工作台（Azure DevOps）的配置与数据。
 *
 * 之前 config 是 WorkbenchPage 里的 `useState(loadWorkbenchConfig)` —— 只在挂载时读一次，
 * 在设置页改完配置切回工作台，面板还在用旧的。放进 store 后设置页一保存，所有页面立刻跟着变。
 *
 * ADO 数据也放这里：概览、工作项列表、PR 列表、构建列表都要用同一份，
 * 各自去拉会打出好几倍的请求。
 */

export interface WorkItem {
  id: number;
  /** 当前工作项的父项 ID；父项不在当前查询结果中时仍保留此值 */
  parentId?: number;
  title: string;
  type: string;
  state: string;
  priority?: number;
  project: string;
  assignedTo?: string;
  changedDate?: string;
  /** 截止日期（ISO 时间串）。ADO 各流程模板字段名不同，取到哪个算哪个 */
  dueDate?: string;
  webUrl: string;
}

export interface Reviewer {
  name: string;
  unique: string;
  /** ADO 投票：10=批准 5=有建议地批准 0=未投 -5=等待作者 -10=拒绝 */
  vote: number;
  isRequired?: boolean;
  isContainer?: boolean;
}

export interface PullRequest {
  id: number;
  title: string;
  repo: string;
  project?: string;
  creator: string;
  creatorUnique: string;
  reviewers: Reviewer[];
  sourceBranch: string;
  targetBranch: string;
  createdDate?: string;
  webUrl: string;
  /** 服务端按 GUID 判定的与我的关系 */
  rel?: 'mine' | 'review' | 'both';
}

export interface Build {
  id: number;
  buildNumber: string;
  definition: string;
  project: string;
  status: string;
  result: string;
  requestedFor: string;
  queueTime: string;
  finishTime: string;
  webUrl: string;
}

/**
 * ADO 的日期字段（ISO 时间串）→ 本地日历日期（YYYY-MM-DD）。
 *
 * **不能直接 slice(0, 10)**：那切出来的是 UTC 日期。中国是 UTC+8，凌晨 0-8 点之间
 * UTC 还停在前一天 —— 一个「今天到期」的工作项会被判成「已逾期」，而用户明明还有一整天。
 * 必须先转成本地时间再取日期。
 */
export function adoDateToLocal(iso?: string): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

/** ADO 的投票值 → 人话 */
export const VOTE_LABELS: Record<number, string> = {
  10: '已批准',
  5: '有建议地批准',
  0: '未投票',
  [-5]: '等待作者',
  [-10]: '已拒绝',
};

export function voteColor(vote: number): string {
  if (vote >= 5) return 'text-success';
  if (vote === 0) return 'text-ink-3';
  return 'text-danger';
}

/**
 * ADO 账号与人名的宽松匹配（没有账号映射表，只能这样对）。
 *
 * account 可能是 `DOMAIN\lus`、`lus@corp.com`、显示名或裸账号名，而 PR 的
 * uniqueName/displayName 常是另一种形态，三者互不相同。之前用全等匹配，只要格式
 * 不一致「我提的 PR」就全空（issue #12）。这里去掉 DOMAIN\ 前缀和 @domain 后缀，
 * 用裸账号名再比一次。
 */
function bareName(s: string): string {
  let t = s.trim().toLowerCase();
  const bs = t.lastIndexOf('\\');
  if (bs >= 0) t = t.slice(bs + 1);
  const at = t.indexOf('@');
  if (at >= 0) t = t.slice(0, at);
  return t;
}

export function matchUser(account: string, unique: string, name: string): boolean {
  const q = account.trim().toLowerCase();
  if (!q) return false;
  if (unique.toLowerCase() === q || name.toLowerCase() === q) return true;
  const qb = bareName(account);
  return !!qb && (bareName(unique) === qb || bareName(name) === qb);
}

interface WorkbenchState {
  config: WorkbenchConfig | null;
  /** 用户保存配置时递增；供依赖配置的异步缓存隔离，不包含 PAT 原文。 */
  configRevision: number;
  workItems: WorkItem[];
  prs: PullRequest[];
  builds: Build[];
  loading: boolean;
  error: string | null;
  /** 上次成功刷新的时间戳，用来显示「x 分钟前更新」 */
  lastRefresh: number | null;

  setConfig: (config: WorkbenchConfig) => void;
  refresh: () => Promise<void>;
}

let refreshRevision = 0;

function connectionKey(config: WorkbenchConfig | null): string {
  if (!config) return '';
  return `ado\0${config.adoBase?.trim().replace(/\/+$/, '') ?? ''}\0${config.auth ?? ''}`;
}

export const useWorkbench = create<WorkbenchState>((set, get) => ({
  config: loadWorkbenchConfig(),
  configRevision: 0,
  workItems: [],
  prs: [],
  builds: [],
  loading: false,
  error: null,
  lastRefresh: null,

  setConfig: (config) => {
    const nextConfig: WorkbenchConfig = {
      adoBase: config.adoBase?.trim().replace(/\/+$/, '') || undefined,
      pat: config.pat?.trim() || undefined,
      auth: config.auth,
      account: config.account.trim(),
    };
    const connectionChanged = connectionKey(get().config) !== connectionKey(nextConfig);
    const configRevision = get().configRevision + 1;
    saveWorkbenchConfig(nextConfig);
    refreshRevision++;
    if (connectionChanged) localStorage.removeItem(ADO_WEB_KEY);
    // 配置变了，旧数据就作废——别让用户对着上一个服务器的工作项发呆
    set({
      config: nextConfig,
      configRevision,
      workItems: [],
      prs: [],
      builds: [],
      loading: false,
      lastRefresh: null,
      error: null,
    });
    void get().refresh();
  },

  refresh: async () => {
    const revision = ++refreshRevision;
    const c = get().config;
    const key = connectionKey(c);
    const isCurrent = () =>
      refreshRevision === revision && connectionKey(get().config) === key;
    // 账号不是必需的：Windows 集成认证下工作项查询用 @Me 宏，服务器自己知道是谁。
    // 真正的前提是「连到哪儿」。
    if (!c?.adoBase) {
      if (isCurrent()) set({ loading: false });
      return;
    }
    set({ loading: true, error: null });
    try {
      const { directGetWorkItems, directGetPullRequests, directGetBuilds, directGetIdentity } =
        await import('../lib/adoDirect');
      if (!isCurrent()) return;
      const cfg = { adoBase: c.adoBase, pat: c.pat ?? '', auth: c.auth };
      // 账号为空(NTLM 集成认证的常态：什么都不用填)时自动探测回填——
      // 工作项走 @Me 不受影响，但 PR 是前端按账号过滤的，账号空着
      // 「待我评审/我提的」就永远是空的（issue #12）
      if (!c.account) {
        try {
          const who = await directGetIdentity(cfg);
          if (!isCurrent()) return;
          if (who.account) {
            const current = get().config;
            if (current && !current.account) {
              const next = { ...current, account: who.account };
              saveWorkbenchConfig(next);
              set({ config: next });
            }
          }
        } catch {
          /* 探测失败不拦刷新，PR 过滤退化为空，其余照常 */
        }
      }
      if (!isCurrent()) return;
      const [workItems, prs, builds] = await Promise.all([
        // 恒用 @Me（传空）：显式账号字符串和 ADO identity 格式对不上会漏工作项。
        // account 只用于 PR 的前端过滤，不进 WIQL
        directGetWorkItems(cfg, ''),
        directGetPullRequests(cfg),
        // 构建要遍历项目，慢且容易超时，挂了不该拖垮整个面板
        directGetBuilds(cfg).catch(() => []),
      ]);
      if (!isCurrent()) return;
      // markdown 渲染器靠它把消息里的 #123 变成工作项链接
      localStorage.setItem(ADO_WEB_KEY, c.adoBase.replace(/\/+$/, ''));
      set({
        workItems: workItems as WorkItem[],
        prs: prs as PullRequest[],
        builds: builds as Build[],
        lastRefresh: Date.now(),
      });
    } catch (err) {
      if (!isCurrent()) return;
      const raw = err instanceof Error ? err.message : String(err ?? '');
      set({
        error:
          raw && raw !== 'Failed to fetch'
            ? raw
            : '无法连接 Azure DevOps',
      });
    } finally {
      if (isCurrent()) set({ loading: false });
    }
  },
}));

/** 派生：待我评审的 PR。 */
export function reviewPrsOf(prs: PullRequest[], account: string): PullRequest[] {
  return prs.filter((pr) =>
    pr.rel
      ? pr.rel === 'review'
      : pr.reviewers.some((r) => matchUser(account, r.unique, r.name)) &&
        !matchUser(account, pr.creatorUnique, pr.creator),
  );
}

/** 派生：我提的 PR */
export function myPrsOf(prs: PullRequest[], account: string): PullRequest[] {
  return prs.filter((pr) =>
    pr.rel ? pr.rel === 'mine' || pr.rel === 'both' : matchUser(account, pr.creatorUnique, pr.creator),
  );
}

/** 我提的 PR 里，评审已经通过的（可以合了） */
export function isApproved(pr: PullRequest): boolean {
  const voted = pr.reviewers.filter((r) => r.vote !== 0);
  return voted.length > 0 && voted.every((r) => r.vote >= 5);
}

/**
 * 工作项状态归类。**必须中英文都认**：Azure DevOps Server 的中文流程模板里
 * 状态就叫「活动 / 已解决 / 已关闭」，只认英文的话所有状态判断（逾期排除、
 * 配色区分、划线）在中文环境全部失效——这正是「已解决工作项没有区分」的根因。
 */
export type WorkItemStateCategory = 'new' | 'active' | 'resolved' | 'done' | 'other';

const STATE_CATEGORY: Record<string, WorkItemStateCategory> = {
  // 新建/待办
  new: 'new', 'to do': 'new', proposed: 'new', open: 'new', approved: 'new',
  新建: 'new', 待办: 'new', 已建议: 'new', 待处理: 'new', 已批准: 'new',
  // 进行中
  active: 'active', 'in progress': 'active', doing: 'active', committed: 'active',
  活动: 'active', 进行中: 'active', 正在进行: 'active', 处理中: 'active', 已提交: 'active',
  // 已解决/评审中
  resolved: 'resolved', 'in review': 'resolved',
  已解决: 'resolved', 评审中: 'resolved', 已修复: 'resolved',
  // 已关闭/完成
  closed: 'done', done: 'done', completed: 'done', removed: 'done',
  已关闭: 'done', 已完成: 'done', 已删除: 'done', 已移除: 'done', 关闭: 'done', 完成: 'done',
};

export function workItemStateCategory(state: string): WorkItemStateCategory {
  return STATE_CATEGORY[state.trim().toLowerCase()] ?? 'other';
}

/** 工作项是否已完成（已解决/已关闭/已移除）——已完成的不算逾期，也不进待处理队列 */
export function isWorkItemDone(state: string): boolean {
  const c = workItemStateCategory(state);
  return c === 'resolved' || c === 'done';
}

/** 状态徽标配色（列表/悬停卡/内联卡片共用一份，语义按归类走） */
export function stateBadgeClass(state: string): string {
  switch (workItemStateCategory(state)) {
    case 'active':
      return 'bg-primary-light text-primary';
    case 'resolved':
      return 'bg-warning/15 text-warning';
    case 'done':
      return 'bg-success/15 text-success';
    default:
      return 'bg-fill-2 text-ink-2';
  }
}
