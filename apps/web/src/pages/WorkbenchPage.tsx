import { useCallback, useEffect, useState } from 'react';
import {
  CircleDot,
  ExternalLink,
  GitPullRequest,
  LayoutGrid,
  RefreshCw,
  Settings,
  UserCheck,
} from 'lucide-react';

const CONFIG_KEY = 'rcx-workbench';
/** markdown 渲染器用它把消息里的 #123 链接到 ADO 工作项 */
export const ADO_WEB_KEY = 'rcx-ado-web';

interface WorkbenchConfig {
  bridge: string;
  account: string;
}

interface WorkItem {
  id: number;
  title: string;
  type: string;
  state: string;
  priority?: number;
  project: string;
  webUrl: string;
}

interface PullRequest {
  id: number;
  title: string;
  repo: string;
  creator: string;
  creatorUnique: string;
  reviewers: { name: string; unique: string; vote: number }[];
  sourceBranch: string;
  targetBranch: string;
  webUrl: string;
}

function loadConfig(): WorkbenchConfig | null {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    return raw ? (JSON.parse(raw) as WorkbenchConfig) : null;
  } catch {
    return null;
  }
}

const TYPE_COLORS: Record<string, string> = {
  Bug: '#f54a45',
  Task: '#3370ff',
  'User Story': '#00b96b',
  Feature: '#7f3bf5',
  Epic: '#ff8800',
};

function matchUser(account: string, unique: string, name: string): boolean {
  const q = account.toLowerCase();
  return unique.toLowerCase() === q || name.toLowerCase() === q;
}

function ConfigCard({
  initial,
  onSaved,
}: {
  initial: WorkbenchConfig | null;
  onSaved: (c: WorkbenchConfig) => void;
}) {
  const [bridge, setBridge] = useState(initial?.bridge ?? 'http://localhost:8377');
  const [account, setAccount] = useState(initial?.account ?? '');

  return (
    <div className="mx-auto mt-16 w-[440px] rounded-xl border border-line bg-white p-6">
      <div className="mb-1 flex items-center gap-2 text-[15px] font-semibold text-ink">
        <LayoutGrid size={18} className="text-primary" />
        连接 Azure DevOps
      </div>
      <div className="mb-5 text-xs leading-relaxed text-ink-3">
        工作台通过 ado-bridge 服务查询 Azure DevOps Server 2022
        （PAT 保存在桥接服务端，客户端不接触凭据）。
      </div>
      <label className="mb-1.5 block text-sm text-ink-2">桥接服务地址</label>
      <input
        value={bridge}
        onChange={(e) => setBridge(e.target.value)}
        placeholder="http://localhost:8377"
        className="mb-4 h-10 w-full rounded-md border border-line px-3 text-sm outline-none transition focus:border-primary"
      />
      <label className="mb-1.5 block text-sm text-ink-2">我的 ADO 账号（邮箱或域账号）</label>
      <input
        value={account}
        onChange={(e) => setAccount(e.target.value)}
        placeholder="user@example.com 或 DOMAIN\\user"
        className="mb-5 h-10 w-full rounded-md border border-line px-3 text-sm outline-none transition focus:border-primary"
      />
      <button
        disabled={!bridge.trim() || !account.trim()}
        onClick={() => {
          const config = { bridge: bridge.trim().replace(/\/+$/, ''), account: account.trim() };
          localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
          onSaved(config);
        }}
        className="h-10 w-full rounded-md bg-primary text-sm font-medium text-white transition hover:bg-primary-hover disabled:opacity-40"
      >
        保存并连接
      </button>
    </div>
  );
}

function WorkItemRow({ item }: { item: WorkItem }) {
  return (
    <a
      href={item.webUrl}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-2.5 border-b border-line px-4 py-2.5 transition last:border-b-0 hover:bg-fill-2"
    >
      <span
        className="h-2.5 w-2.5 shrink-0 rounded-full"
        style={{ background: TYPE_COLORS[item.type] ?? '#8f959e' }}
        title={item.type}
      />
      <span className="shrink-0 text-xs text-ink-3">#{item.id}</span>
      <span className="min-w-0 flex-1 truncate text-sm text-ink">{item.title}</span>
      {item.priority != null && (
        <span className="shrink-0 rounded bg-fill-1 px-1.5 py-0.5 text-[11px] text-ink-2">
          P{item.priority}
        </span>
      )}
      <span className="shrink-0 rounded bg-primary-light px-1.5 py-0.5 text-[11px] text-primary">
        {item.state}
      </span>
    </a>
  );
}

function PullRequestRow({ pr, account }: { pr: PullRequest; account: string }) {
  const myVote = pr.reviewers.find((r) => matchUser(account, r.unique, r.name))?.vote ?? 0;
  return (
    <a
      href={pr.webUrl}
      target="_blank"
      rel="noreferrer"
      className="block border-b border-line px-4 py-2.5 transition last:border-b-0 hover:bg-fill-2"
    >
      <div className="flex items-center gap-2">
        <GitPullRequest size={14} className="shrink-0 text-[#7f3bf5]" />
        <span className="shrink-0 text-xs text-ink-3">!{pr.id}</span>
        <span className="min-w-0 flex-1 truncate text-sm text-ink">{pr.title}</span>
        {myVote === 10 && (
          <span className="shrink-0 rounded bg-[#e8f7ea] px-1.5 py-0.5 text-[11px] text-success">
            已批准
          </span>
        )}
        {myVote === -10 && (
          <span className="shrink-0 rounded bg-[#feeceb] px-1.5 py-0.5 text-[11px] text-danger">
            已拒绝
          </span>
        )}
      </div>
      <div className="mt-1 truncate pl-6 text-xs text-ink-3">
        {pr.repo} · {pr.sourceBranch} → {pr.targetBranch} · {pr.creator}
      </div>
    </a>
  );
}

function Panel({
  icon: Icon,
  title,
  count,
  children,
}: {
  icon: typeof CircleDot;
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section className="flex min-h-0 flex-col rounded-xl border border-line bg-white">
      <header className="flex items-center gap-2 border-b border-line px-4 py-3">
        <Icon size={16} className="text-primary" />
        <span className="text-sm font-semibold text-ink">{title}</span>
        <span className="text-xs text-ink-3">{count}</span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </section>
  );
}

/** 工作台：Azure DevOps Server 2022 面板 */
export default function WorkbenchPage() {
  const [config, setConfig] = useState<WorkbenchConfig | null>(loadConfig);
  const [editing, setEditing] = useState(false);
  const [workItems, setWorkItems] = useState<WorkItem[]>([]);
  const [prs, setPrs] = useState<PullRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (c: WorkbenchConfig) => {
    setLoading(true);
    setError(null);
    try {
      const [cfgRes, wiRes, prRes] = await Promise.all([
        fetch(`${c.bridge}/api/ado/config`),
        fetch(`${c.bridge}/api/ado/workitems?assignedTo=${encodeURIComponent(c.account)}`),
        fetch(`${c.bridge}/api/ado/pullrequests`),
      ]);
      if (!cfgRes.ok || !wiRes.ok || !prRes.ok) {
        const bad = [cfgRes, wiRes, prRes].find((r) => !r.ok)!;
        const body = await bad.json().catch(() => ({}) as { error?: string });
        throw new Error(body.error ?? `桥接服务返回 ${bad.status}`);
      }
      const cfg = (await cfgRes.json()) as { webBase: string };
      localStorage.setItem(ADO_WEB_KEY, cfg.webBase);
      setWorkItems(((await wiRes.json()) as { items: WorkItem[] }).items);
      setPrs(((await prRes.json()) as { items: PullRequest[] }).items);
    } catch (err) {
      setError(
        err instanceof Error && err.message !== 'Failed to fetch'
          ? err.message
          : '无法连接桥接服务，请确认 ado-bridge 已启动且地址正确',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (config) void refresh(config);
  }, [config, refresh]);

  if (!config || editing) {
    return (
      <main className="flex-1 overflow-y-auto bg-fill-2">
        <ConfigCard
          initial={config}
          onSaved={(c) => {
            setConfig(c);
            setEditing(false);
          }}
        />
      </main>
    );
  }

  const reviewPrs = prs.filter(
    (pr) =>
      pr.reviewers.some((r) => matchUser(config.account, r.unique, r.name)) &&
      !matchUser(config.account, pr.creatorUnique, pr.creator),
  );
  const myPrs = prs.filter((pr) => matchUser(config.account, pr.creatorUnique, pr.creator));

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-fill-2">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-line bg-white px-5">
        <div className="flex items-center gap-2">
          <span className="text-[15px] font-semibold text-ink">工作台</span>
          <span className="text-xs text-ink-3">Azure DevOps · {config.account}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            title="刷新"
            onClick={() => void refresh(config)}
            className="flex h-8 w-8 items-center justify-center rounded-md text-ink-2 transition hover:bg-fill-hover"
          >
            <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
          </button>
          <button
            title="设置"
            onClick={() => setEditing(true)}
            className="flex h-8 w-8 items-center justify-center rounded-md text-ink-2 transition hover:bg-fill-hover"
          >
            <Settings size={15} />
          </button>
        </div>
      </header>

      {error && (
        <div className="mx-5 mt-4 rounded-lg border border-danger/30 bg-[#feeceb] px-4 py-3 text-sm text-danger">
          {error}
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-2 gap-4 p-5">
        <Panel icon={CircleDot} title="我的工作项" count={workItems.length}>
          {loading && workItems.length === 0 ? (
            <div className="py-10 text-center text-sm text-ink-3">加载中…</div>
          ) : workItems.length === 0 ? (
            <div className="py-10 text-center text-sm text-ink-3">没有分配给你的未关闭工作项 🎉</div>
          ) : (
            workItems.map((w) => <WorkItemRow key={w.id} item={w} />)
          )}
        </Panel>

        <div className="grid min-h-0 grid-rows-2 gap-4">
          <Panel icon={UserCheck} title="待我评审" count={reviewPrs.length}>
            {reviewPrs.length === 0 ? (
              <div className="py-8 text-center text-sm text-ink-3">暂无待评审的 PR</div>
            ) : (
              reviewPrs.map((pr) => <PullRequestRow key={pr.id} pr={pr} account={config.account} />)
            )}
          </Panel>
          <Panel icon={GitPullRequest} title="我创建的 PR" count={myPrs.length}>
            {myPrs.length === 0 ? (
              <div className="py-8 text-center text-sm text-ink-3">暂无进行中的 PR</div>
            ) : (
              myPrs.map((pr) => <PullRequestRow key={pr.id} pr={pr} account={config.account} />)
            )}
          </Panel>
        </div>
      </div>

      <div className="px-5 pb-3 text-center text-xs text-ink-3">
        <ExternalLink size={11} className="mr-1 inline" />
        点击条目跳转 Azure DevOps · 消息里的 #工作项号 也会自动链接
      </div>
    </main>
  );
}
