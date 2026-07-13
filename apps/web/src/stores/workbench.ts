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

/** ADO 账号与人名的宽松匹配（没有账号映射表，只能这样对） */
export function matchUser(account: string, unique: string, name: string): boolean {
  const q = account.trim().toLowerCase();
  if (!q) return false;
  return unique.toLowerCase() === q || name.toLowerCase() === q;
}

interface WorkbenchState {
  config: WorkbenchConfig | null;
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

export const useWorkbench = create<WorkbenchState>((set, get) => ({
  config: loadWorkbenchConfig(),
  workItems: [],
  prs: [],
  builds: [],
  loading: false,
  error: null,
  lastRefresh: null,

  setConfig: (config) => {
    saveWorkbenchConfig(config);
    // 配置变了，旧数据就作废——别让用户对着上一个服务器的工作项发呆
    set({ config, workItems: [], prs: [], builds: [], lastRefresh: null, error: null });
    void get().refresh();
  },

  refresh: async () => {
    const c = get().config;
    // 账号不是必需的：Windows 集成认证下工作项查询用 @Me 宏，服务器自己知道是谁。
    // 真正的前提是「连到哪儿」。
    if (!c) return;
    if (c.mode === 'direct' ? !c.adoBase : !c.bridge) return;
    set({ loading: true, error: null });
    try {
      if (c.mode === 'direct' && c.adoBase) {
        const { directGetWorkItems, directGetPullRequests, directGetBuilds } = await import(
          '../lib/adoDirect'
        );
        const cfg = { adoBase: c.adoBase, pat: c.pat ?? '', auth: c.auth };
        // markdown 渲染器靠它把消息里的 #123 变成工作项链接
        localStorage.setItem(ADO_WEB_KEY, c.adoBase.replace(/\/+$/, ''));
        const [workItems, prs, builds] = await Promise.all([
          directGetWorkItems(cfg, c.account),
          directGetPullRequests(cfg),
          // 构建要遍历项目，慢且容易超时，挂了不该拖垮整个面板
          directGetBuilds(cfg).catch(() => []),
        ]);
        set({
          workItems: workItems as WorkItem[],
          prs: prs as PullRequest[],
          builds: builds as Build[],
          lastRefresh: Date.now(),
        });
      } else if (c.bridge) {
        const [cfgRes, wiRes, prRes, buildRes] = await Promise.all([
          fetch(`${c.bridge}/api/ado/config`),
          fetch(`${c.bridge}/api/ado/workitems?assignedTo=${encodeURIComponent(c.account)}`),
          fetch(`${c.bridge}/api/ado/pullrequests`),
          fetch(`${c.bridge}/api/ado/builds`),
        ]);
        if (!cfgRes.ok || !wiRes.ok || !prRes.ok) {
          const bad = [cfgRes, wiRes, prRes].find((r) => !r.ok)!;
          const body = await bad.json().catch(() => ({}) as { error?: string });
          throw new Error(body.error ?? `桥接服务返回 ${bad.status}`);
        }
        const webCfg = (await cfgRes.json()) as { webBase: string };
        localStorage.setItem(ADO_WEB_KEY, webCfg.webBase);
        set({
          workItems: ((await wiRes.json()) as { items: WorkItem[] }).items,
          prs: ((await prRes.json()) as { items: PullRequest[] }).items,
          builds: buildRes.ok ? ((await buildRes.json()) as { items: Build[] }).items : [],
          lastRefresh: Date.now(),
        });
      }
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err ?? '');
      set({
        error:
          raw && raw !== 'Failed to fetch'
            ? raw
            : c.mode === 'direct'
              ? '无法连接 Azure DevOps'
              : '无法连接桥接服务',
      });
    } finally {
      set({ loading: false });
    }
  },
}));

/** 派生：待我评审的 PR（我是评审人，且不是我提的） */
export function reviewPrsOf(prs: PullRequest[], account: string): PullRequest[] {
  return prs.filter(
    (pr) =>
      pr.reviewers.some((r) => matchUser(account, r.unique, r.name)) &&
      !matchUser(account, pr.creatorUnique, pr.creator),
  );
}

/** 派生：我提的 PR —— 之前拉回来了却从没在界面上出现过 */
export function myPrsOf(prs: PullRequest[], account: string): PullRequest[] {
  return prs.filter((pr) => matchUser(account, pr.creatorUnique, pr.creator));
}

/** 我提的 PR 里，评审已经通过的（可以合了） */
export function isApproved(pr: PullRequest): boolean {
  const voted = pr.reviewers.filter((r) => r.vote !== 0);
  return voted.length > 0 && voted.every((r) => r.vote >= 5);
}
