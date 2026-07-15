import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bookmark,
  Calendar,
  LayoutList,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  ExternalLink,
  GitPullRequest,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Trash2,
  Wrench,
  XCircle,
} from 'lucide-react';
import { myPrsOf, reviewPrsOf, useWorkbench, type WorkItem } from '../stores/workbench';
import { BuildList, PullRequestList, WorkItemList } from '../components/AdoLists';
import { useUI } from '../stores/ui';
import { useAuth } from '../stores/auth';
import { useChat } from '../stores/chat';
import { useTodos, todayKey, type Todo } from '../stores/todos';
import { buildQueue, queueSummary, type QueueItem } from '../lib/queue';
import { useCalendar, eventsForDate } from '../stores/calendar';
import { useFavorites, SIZE_SPAN, SIZE_LABELS, randomFavColor, type Favorite, type FavSize } from '../stores/favorites';
import { useCustomQueries, parseQueryUrl } from '../stores/customQueries';
import { fmtConvTime } from '../lib/format';
import { toast } from '../stores/toast';
import { SkeletonRows } from '../components/Skeleton';

/** 工作台内部视图：概览（仪表盘）+ 三个 ADO 完整列表 */
type AdoTab = 'overview' | 'workitems' | 'prs' | 'builds';

/**
 * 待处理队列的一行。
 * 不管这件事来自 ADO 还是聊天里的待办，长得都一样 —— 用户关心的是「要做什么」，
 * 不是「它从哪个系统来」。
 */
function QueueRow({
  item,
  onOpenTodo,
  onOpenCalendar,
}: {
  item: QueueItem;
  onOpenTodo: (todo: Todo) => void;
  onOpenCalendar: () => void;
}) {
  const inner = (
    <>
      <span
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ background: item.color }}
      />
      <span
        className="w-20 shrink-0 truncate text-2xs"
        style={{ color: item.color }}
        title={item.label}
      >
        {item.label}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm text-ink">{item.title}</span>
      {item.meta && (
        <span className="max-w-[40%] shrink-0 truncate text-2xs text-ink-3">{item.meta}</span>
      )}
      {item.href ? (
        <ExternalLink size={13} className="shrink-0 text-ink-3 opacity-0 group-hover:opacity-100" />
      ) : (
        <ChevronRight size={13} className="shrink-0 text-ink-3 opacity-0 group-hover:opacity-100" />
      )}
    </>
  );

  const cls =
    'group flex w-full items-center gap-2.5 border-b border-line px-4 py-2.5 text-left transition last:border-b-0 hover:bg-fill-2';

  return item.href ? (
    <a href={item.href} target="_blank" rel="noreferrer" className={cls}>
      {inner}
    </a>
  ) : (
    <button
      onClick={() => {
        if (item.todo) onOpenTodo(item.todo);
        else if (item.event) onOpenCalendar();
      }}
      className={cls}
    >
      {inner}
    </button>
  );
}

// ---------- Custom Query Dialog ----------
function QueryDialog({
  onClose,
  onSave,
}: {
  onClose: () => void;
  onSave: (name: string, url: string) => void;
}) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const parsed = url.trim() ? parseQueryUrl(url.trim()) : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="w-[440px] rounded-xl border border-line bg-surface-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-line px-5 py-3">
          <span className="text-[15px] font-semibold text-ink">添加自定义查询</span>
          <button onClick={onClose} className="text-ink-3 hover:text-ink">
            <XCircle size={16} />
          </button>
        </header>
        <div className="space-y-4 p-5">
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-2">查询名称</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例：本迭代待办、我的 Bug"
              autoFocus
              className="h-9 w-full rounded-md border border-line bg-surface-3 px-3 text-sm text-ink outline-none focus:border-primary"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-2">
              ADO 查询链接
            </label>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="粘贴浏览器地址栏里的查询页面链接"
              className="h-9 w-full rounded-md border border-line bg-surface-3 px-3 text-sm text-ink outline-none focus:border-primary"
            />
            <p className="mt-1.5 text-2xs text-ink-3">
              在 Azure DevOps 打开一个已存查询，复制浏览器地址栏的链接粘贴到这里
            </p>
            {url.trim() && !parsed && (
              <p className="mt-1 text-2xs text-danger">无法从链接中解析出查询 ID</p>
            )}
            {parsed && (
              <p className="mt-1 text-2xs text-success">
                已识别查询 {parsed.queryId.slice(0, 8)}…
                {parsed.project ? ` (${parsed.project})` : ''}
              </p>
            )}
          </div>
        </div>
        <footer className="flex justify-end gap-2 border-t border-line px-5 py-3">
          <button
            onClick={onClose}
            className="h-8 rounded-md border border-line px-4 text-sm text-ink-2 hover:bg-fill-hover"
          >
            取消
          </button>
          <button
            onClick={() => {
              if (name.trim() && parsed) onSave(name.trim(), url.trim());
            }}
            disabled={!name.trim() || !parsed}
            className="h-8 rounded-md bg-primary px-4 text-sm text-white hover:bg-primary-hover disabled:opacity-50"
          >
            添加
          </button>
        </footer>
      </div>
    </div>
  );
}

// ---------- Favorites Dialog ----------
function FavoriteDialog({
  existing,
  onClose,
}: {
  existing?: Favorite;
  onClose: () => void;
}) {
  const add = useFavorites((s) => s.add);
  const update = useFavorites((s) => s.update);
  const [title, setTitle] = useState(existing?.title ?? '');
  const [url, setUrl] = useState(existing?.url ?? '');
  const [icon, setIcon] = useState(existing?.icon ?? '');
  const [color, setColor] = useState(existing?.color ?? randomFavColor());
  const [size, setSize] = useState<FavSize>(existing?.size ?? 'small');

  const handleSave = () => {
    if (!title.trim() || !url.trim()) return;
    const data = { title: title.trim(), url: url.trim(), icon: icon || undefined, color, size };
    if (existing) {
      update(existing.id, data);
      toast.success('已更新');
    } else {
      add(data);
      toast.success('已添加');
    }
    onClose();
  };

  const COLORS = [
    '#3370ff', '#00b96b', '#7f3bf5', '#f54a45', '#ff8800',
    '#14b8a6', '#f472b6', '#8b5cf6', '#06b6d4', '#84cc16',
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="w-[400px] rounded-xl border border-line bg-surface-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between border-b border-line px-5 py-3">
          <span className="text-[15px] font-semibold text-ink">{existing ? '编辑收藏' : '添加收藏'}</span>
          <button onClick={onClose} className="text-ink-3 hover:text-ink"><XCircle size={16} /></button>
        </header>
        <div className="space-y-4 p-5">
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-2">标题</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="例：Jira、GitLab"
              autoFocus
              className="h-9 w-full rounded-md border border-line bg-surface-3 px-3 text-sm text-ink outline-none focus:border-primary"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-2">链接</label>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://..."
              className="h-9 w-full rounded-md border border-line bg-surface-3 px-3 text-sm text-ink outline-none focus:border-primary"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-2">图标（emoji，可选）</label>
            <input
              value={icon}
              onChange={(e) => setIcon(e.target.value)}
              placeholder="📌"
              maxLength={4}
              className="h-9 w-16 rounded-md border border-line bg-surface-3 px-3 text-center text-sm outline-none focus:border-primary"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-ink-2">颜色</label>
            <div className="flex gap-2">
              {COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => setColor(c)}
                  className={`h-5 w-5 rounded-full transition ${color === c ? 'ring-2 ring-offset-2 ring-primary' : 'hover:scale-110'}`}
                  style={{ background: c }}
                />
              ))}
            </div>
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-ink-2">卡片大小</label>
            <div className="flex gap-2">
              {(['small', 'medium', 'large'] as FavSize[]).map((s) => (
                <button
                  key={s}
                  onClick={() => setSize(s)}
                  className={`h-8 flex-1 rounded-md border text-xs transition ${
                    size === s ? 'border-primary bg-primary/5 text-primary' : 'border-line text-ink-2 hover:bg-fill-hover'
                  }`}
                >
                  {SIZE_LABELS[s]}
                </button>
              ))}
            </div>
          </div>
        </div>
        <footer className="flex justify-end gap-2 border-t border-line px-5 py-3">
          <button onClick={onClose} className="h-8 rounded-md border border-line px-4 text-sm text-ink-2 hover:bg-fill-hover">取消</button>
          <button
            onClick={handleSave}
            disabled={!title.trim() || !url.trim()}
            className="h-8 rounded-md bg-primary px-4 text-sm text-white hover:bg-primary-hover disabled:opacity-50"
          >
            {existing ? '保存' : '添加'}
          </button>
        </footer>
      </div>
    </div>
  );
}

// ---------- Main ----------

export default function WorkbenchPage() {
  const setModule = useUI((s) => s.setModule);
  const tab = useUI((s) => s.workbenchTab);
  const setTab = useUI((s) => s.setWorkbenchTab);
  const user = useAuth((s) => s.user);
  const subscriptions = useChat((s) => s.subscriptions);
  const openRoom = useChat((s) => s.openRoom);
  const jumpToMessage = useChat((s) => s.jumpToMessage);
  const todos = useTodos((s) => s.todos);
  const calendarEvents = useCalendar((s) => s.events);
  const setSelectedDate = useCalendar((s) => s.setSelectedDate);
  const setCursor = useCalendar((s) => s.setCursor);
  const favorites = useFavorites((s) => s.items);
  const removeFav = useFavorites((s) => s.remove);

  // config 与 ADO 数据都来自 store：设置页一保存这里立刻跟着变，
  // 各个 tab 也共用同一份数据，不会各拉各的
  const config = useWorkbench((s) => s.config);
  const workItems = useWorkbench((s) => s.workItems);
  const prs = useWorkbench((s) => s.prs);
  const builds = useWorkbench((s) => s.builds);
  const loading = useWorkbench((s) => s.loading);
  const adoError = useWorkbench((s) => s.error);
  const lastRefresh = useWorkbench((s) => s.lastRefresh);
  const refresh = useWorkbench((s) => s.refresh);

  const customQueries = useCustomQueries((s) => s.queries);
  const addQuery = useCustomQueries((s) => s.add);
  const removeQuery = useCustomQueries((s) => s.remove);
  const [queryDialog, setQueryDialog] = useState(false);
  const [queryCache, setQueryCache] = useState<Record<string, WorkItem[]>>({});
  const [queryLoading, setQueryLoading] = useState<string | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);

  const activeQueryId = tab.startsWith('query:') ? tab.slice(6) : null;
  const activeQuery = customQueries.find((q) => q.id === activeQueryId);

  const fetchQuery = useCallback(
    async (q: typeof customQueries[0], force = false) => {
      if (!config || config.mode !== 'direct' || !config.adoBase) return;
      if (!force && queryCache[q.id]) return;
      setQueryLoading(q.id);
      setQueryError(null);
      try {
        const { directRunSavedQuery } = await import('../lib/adoDirect');
        const cfg = { adoBase: config.adoBase, pat: config.pat ?? '', auth: config.auth };
        const items = await directRunSavedQuery(cfg, q.queryId, q.project);
        setQueryCache((prev) => ({ ...prev, [q.id]: items as WorkItem[] }));
      } catch (err) {
        setQueryError(err instanceof Error ? err.message : String(err));
      } finally {
        setQueryLoading(null);
      }
    },
    [config, queryCache],
  );

  useEffect(() => {
    if (activeQuery && !queryCache[activeQuery.id] && queryLoading !== activeQuery.id) {
      void fetchQuery(activeQuery);
    }
  }, [activeQuery, queryCache, queryLoading, fetchQuery]);

  const [favDialog, setFavDialog] = useState<{ existing?: Favorite } | null>(null);

  const today = todayKey();
  const now = new Date();
  const hour = now.getHours();
  const greeting = hour < 6 ? '夜深了' : hour < 12 ? '上午好' : hour < 18 ? '下午好' : '晚上好';

  const unreadTotal = useMemo(
    () =>
      Object.values(subscriptions).reduce(
        (n, s) => n + (s.disableNotifications ? 0 : s.unread || 0),
        0,
      ),
    [subscriptions],
  );
  const todayEvents = useMemo(() => eventsForDate(calendarEvents, today), [calendarEvents, today]);

  const account = config?.account ?? '';
  // 「工作台是否可用」取决于连没连上服务器，而不是用户填没填账号 ——
  // Windows 集成认证下账号是服务器识别的，用户根本不用填
  const connected = !!(config && (config.mode === 'direct' ? config.adoBase : config.bridge));
  // 标题上显示身份：没识别到账号就别硬凑一个空字符串出来
  const adoTitle = account ? `Azure DevOps · ${account}` : 'Azure DevOps';

  // 进入工作台时拉一次；已有数据就不重复拉（切 tab 不该每次都打服务器）。
  // triedRef 是死循环护栏：refresh 失败时只置 error 不置 lastRefresh，若把 loading
  // 放进依赖，loading:true→false 会让条件再次成立，ADO 连不上时每秒重发几十次。
  // 用 ref 记住「本次连接已尝试过」，失败也不再自动重试；断线重连（connected 归 false
  // 再变 true）时重置，允许再试一次。
  const triedRef = useRef(false);
  useEffect(() => {
    if (!connected) {
      triedRef.current = false;
      return;
    }
    if (!lastRefresh && !triedRef.current) {
      triedRef.current = true;
      void refresh();
    }
  }, [connected, lastRefresh, refresh]);

  const reviewPrs = useMemo(() => reviewPrsOf(prs, account), [prs, account]);
  const myPrs = useMemo(() => myPrsOf(prs, account), [prs, account]);
  const failedBuilds = useMemo(() => builds.filter((b) => b.result === 'failed').length, [builds]);

  /** 首页的核心：把待办、工作项、PR、构建合成一条按紧急度排序的队列 */
  const queue = useMemo(
    () => buildQueue({ todos, workItems, prs, builds, events: calendarEvents, account, today }),
    [todos, workItems, prs, builds, calendarEvents, account, today],
  );

  /** 待办点击：回到它来自的那条消息，上下文才是最重要的 */
  const openTodoSource = async (todo: Todo) => {
    setModule('messages');
    await openRoom(todo.rid);
    await jumpToMessage(todo.mid, todo.rid);
  };

  // ADO 未配置时不显示工作项/PR/构建这些 tab——点进去只有空页，没意义
  const tabs: {
    key: AdoTab;
    label: string;
    icon: typeof CircleDot;
    badge?: number;
    danger?: boolean;
  }[] = [
      { key: 'overview', label: '概览', icon: LayoutList },
      ...(connected
        ? [
            { key: 'workitems' as const, label: '我的工作项', icon: CircleDot, badge: workItems.length },
            { key: 'prs' as const, label: '拉取请求', icon: GitPullRequest, badge: reviewPrs.length },
            {
              key: 'builds' as const,
              label: '构建',
              icon: Wrench,
              badge: failedBuilds || undefined,
              danger: failedBuilds > 0,
            },
          ]
        : []),
    ];

  const refreshBar = connected && (
    <div className="flex items-center gap-2">
      {lastRefresh && !loading && (
        <span className="text-xs text-ink-3">{fmtConvTime(lastRefresh)} 更新</span>
      )}
      <button
        onClick={() => void refresh()}
        disabled={loading}
        className="flex h-8 items-center gap-1.5 rounded-md border border-line px-3 text-xs text-ink-2 transition hover:bg-fill-hover disabled:opacity-50"
      >
        <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
        刷新
      </button>
    </div>
  );

  return (
    <div className="flex min-w-0 flex-1">
      <aside className="flex w-[180px] shrink-0 flex-col border-r border-line bg-fill-2 p-3">
        <div className="px-2 py-1.5 text-[15px] font-semibold text-ink">工作台</div>
        {tabs.map(({ key, label, icon: Icon, badge, danger }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`mt-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition ${
              tab === key ? 'bg-primary-light text-primary' : 'text-ink-2 hover:bg-fill-hover'
            }`}
          >
            <Icon size={16} />
            <span className="min-w-0 truncate">{label}</span>
            {badge ? (
              <span
                className={`ml-auto text-xs ${danger ? 'font-medium text-danger' : 'text-ink-3'}`}
              >
                {badge}
              </span>
            ) : null}
          </button>
        ))}

        {connected && customQueries.length > 0 && (
          <>
            <div className="mt-4 mb-1 px-2 text-2xs font-medium text-ink-3">自定义查询</div>
            {customQueries.map((q) => (
              <div key={q.id} className="group relative">
                <button
                  onClick={() => setTab(`query:${q.id}`)}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition ${
                    tab === `query:${q.id}` ? 'bg-primary-light text-primary' : 'text-ink-2 hover:bg-fill-hover'
                  }`}
                >
                  <Search size={14} />
                  <span className="min-w-0 flex-1 truncate text-left">{q.name}</span>
                  {queryCache[q.id] && (
                    <span className="text-xs text-ink-3">{queryCache[q.id].length}</span>
                  )}
                </button>
                <button
                  onClick={() => {
                    removeQuery(q.id);
                    setQueryCache((prev) => {
                      const next = { ...prev };
                      delete next[q.id];
                      return next;
                    });
                    if (tab === `query:${q.id}`) setTab('overview');
                    toast.success('已删除');
                  }}
                  className="absolute top-1 right-1 hidden h-5 w-5 items-center justify-center rounded text-ink-3 hover:text-danger group-hover:flex"
                >
                  <Trash2 size={11} />
                </button>
              </div>
            ))}
          </>
        )}

        {connected && (
          <button
            onClick={() => setQueryDialog(true)}
            className="mt-2 flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-ink-3 transition hover:bg-fill-hover hover:text-primary"
          >
            <Plus size={14} />
            添加查询
          </button>
        )}

        <button
          onClick={() => setModule('settings')}
          className="mt-auto flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-ink-3 transition hover:bg-fill-hover hover:text-ink"
        >
          <Settings size={14} />
          {connected ? '工作台设置' : '连接 Azure DevOps'}
        </button>
      </aside>

      {tab !== 'overview' ? (
        <main className="flex min-w-0 flex-1 flex-col bg-surface-3 p-5">
          <div className="flex items-center justify-between pb-3">
            <span className="text-[15px] font-semibold text-ink">
              {activeQuery ? activeQuery.name : tabs.find((t) => t.key === tab)?.label}
              <span className="ml-2 text-xs font-normal text-ink-3">
                {adoTitle}
              </span>
            </span>
            {activeQuery ? (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => void fetchQuery(activeQuery, true)}
                  disabled={queryLoading === activeQuery.id}
                  className="flex h-8 items-center gap-1.5 rounded-md border border-line px-3 text-xs text-ink-2 transition hover:bg-fill-hover disabled:opacity-50"
                >
                  <RefreshCw size={13} className={queryLoading === activeQuery.id ? 'animate-spin' : ''} />
                  刷新
                </button>
                <a
                  href={activeQuery.url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex h-8 items-center gap-1.5 rounded-md border border-line px-3 text-xs text-ink-2 transition hover:bg-fill-hover"
                >
                  <ExternalLink size={13} />
                  在 ADO 中打开
                </a>
              </div>
            ) : (
              refreshBar
            )}
          </div>

          {activeQuery ? (
            queryLoading === activeQuery.id && !queryCache[activeQuery.id] ? (
              <SkeletonRows rows={8} />
            ) : queryError && !queryCache[activeQuery.id] ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2">
                <XCircle size={28} className="text-danger" />
                <div className="max-w-md text-center text-sm text-danger">{queryError}</div>
                <button
                  onClick={() => void fetchQuery(activeQuery, true)}
                  className="mt-1 h-8 rounded-md bg-primary px-4 text-sm text-white hover:bg-primary-hover"
                >
                  重试
                </button>
              </div>
            ) : (
              <WorkItemList items={queryCache[activeQuery.id] ?? []} />
            )
          ) : adoError ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2">
              <XCircle size={28} className="text-danger" />
              <div className="text-sm text-danger">{adoError}</div>
              <button
                onClick={() => void refresh()}
                className="mt-1 h-8 rounded-md bg-primary px-4 text-sm text-white hover:bg-primary-hover"
              >
                重试
              </button>
            </div>
          ) : loading && !lastRefresh ? (
            <SkeletonRows rows={8} />
          ) : tab === 'workitems' ? (
            <WorkItemList items={workItems} />
          ) : tab === 'prs' ? (
            <PullRequestList prs={prs} account={account} />
          ) : (
            <BuildList builds={builds} />
          )}
        </main>
      ) : (
        <main className="flex min-w-0 flex-1 overflow-hidden bg-fill-2">
          {/* -------- 主区：待处理队列 -------- */}
          <div className="flex min-w-0 flex-1 flex-col overflow-y-auto px-7 py-6">
            <header className="flex shrink-0 items-start justify-between pb-5">
              <div>
                <h1 className="text-xl font-bold text-ink">
                  {greeting}，{user?.name || user?.username || ''}
                </h1>
                <p className="mt-1 text-sm text-ink-3">
                  {queueSummary(queue)}
                  {unreadTotal > 0 && (
                    <button
                      onClick={() => setModule('messages')}
                      className="ml-2 text-primary hover:underline"
                    >
                      · {unreadTotal} 条未读消息
                    </button>
                  )}
                </p>
              </div>
              {refreshBar}
            </header>

            {adoError && (
              <div className="mb-4 flex items-center gap-2 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">
                <XCircle size={14} className="shrink-0" />
                <span className="min-w-0 flex-1">Azure DevOps：{adoError}</span>
                <button onClick={() => void refresh()} className="shrink-0 hover:underline">
                  重试
                </button>
              </div>
            )}

            {loading && !lastRefresh ? (
              <SkeletonRows rows={6} />
            ) : queue.length === 0 ? (
              /* 无事可做时只占一行，不用一整屏的空卡片去证明「这里是空的」 */
              <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
                <CheckCircle2 size={32} className="text-success" />
                <div className="text-sm text-ink-2">今天没有待处理的事</div>
                <div className="max-w-sm text-xs leading-relaxed text-ink-3">
                  这里会汇总：逾期与今天到期的待办、失败的构建、等你评审的 PR、
                  分配给你的工作项。在聊天消息上右键「标记为待办」也会出现在这里。
                </div>
              </div>
            ) : (
              <div className="overflow-hidden rounded-xl border border-line bg-surface-4">
                {queue.map((item) => (
                  <QueueRow
                    key={item.key}
                    item={item}
                    onOpenTodo={openTodoSource}
                    onOpenCalendar={() => setModule('calendar')}
                  />
                ))}
              </div>
            )}

            {/* 已配置 ADO 时给出完整列表的入口；没配就引导去连 */}
            {connected ? (
              <div className="flex shrink-0 items-center gap-4 pt-4 text-xs text-ink-3">
                <span>{adoTitle}</span>
                <button onClick={() => setTab('workitems')} className="hover:text-primary">
                  工作项 {workItems.length}
                </button>
                <button onClick={() => setTab('prs')} className="hover:text-primary">
                  拉取请求 {reviewPrs.length + myPrs.length}
                </button>
                <button onClick={() => setTab('builds')} className="hover:text-primary">
                  构建 {builds.length}
                </button>
              </div>
            ) : (
              <button
                onClick={() => setModule('settings')}
                className="mt-4 flex shrink-0 items-center justify-center gap-2 rounded-lg border border-dashed border-line py-3 text-xs text-ink-3 transition hover:border-primary hover:text-primary"
              >
                <Wrench size={13} />
                连接 Azure DevOps，把工作项、PR、构建也汇总到这里
              </button>
            )}
          </div>

          {/* -------- 右栏：日程 + 收藏 -------- */}
          <aside className="flex w-[280px] shrink-0 flex-col gap-5 overflow-y-auto border-l border-line bg-surface-4 px-4 py-6">
            <section>
              <div className="flex items-center justify-between pb-2">
                <div className="flex items-center gap-2">
                  <Calendar size={15} className="text-primary" />
                  <span className="text-sm font-semibold text-ink">今日日程</span>
                </div>
                <button
                  onClick={() => setModule('calendar')}
                  className="flex items-center gap-0.5 text-2xs text-ink-3 transition hover:text-primary"
                >
                  日历
                  <ChevronRight size={11} />
                </button>
              </div>
              {todayEvents.length === 0 ? (
                <div className="py-2 text-xs text-ink-3">今天没有安排</div>
              ) : (
                <div className="space-y-1.5">
                  {todayEvents.map((e) => (
                    <button
                      key={e.id}
                      onClick={() => {
                        setSelectedDate(today);
                        setCursor(today);
                        setModule('calendar');
                      }}
                      className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition hover:bg-fill-hover"
                    >
                      <span
                        className="mt-1 h-2 w-2 shrink-0 rounded-full"
                        style={{ background: e.color }}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs text-ink">{e.title}</span>
                        <span className="block text-2xs text-ink-3">
                          {e.allDay
                            ? '全天'
                            : `${e.startTime ?? ''}${e.endTime ? ` - ${e.endTime}` : ''}`}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </section>

            <section className="border-t border-line pt-4">
              <div className="flex items-center justify-between pb-2">
                <div className="flex items-center gap-2">
                  <Bookmark size={15} className="text-primary" />
                  <span className="text-sm font-semibold text-ink">收藏夹</span>
                </div>
                <button
                  onClick={() => setFavDialog({})}
                  className="flex h-6 w-6 items-center justify-center rounded text-ink-3 transition hover:bg-fill-hover hover:text-primary"
                  title="添加收藏"
                >
                  <Plus size={14} />
                </button>
              </div>

              {favorites.length === 0 ? (
                <button
                  onClick={() => setFavDialog({})}
                  className="w-full rounded-lg border border-dashed border-line py-3 text-xs text-ink-3 transition hover:border-primary hover:text-primary"
                >
                  收藏常用链接
                </button>
              ) : (
                <div className="grid grid-cols-3 gap-2">
                  {favorites.map((fav) => (
                    <a
                      key={fav.id}
                      href={fav.url}
                      target="_blank"
                      rel="noreferrer"
                      className={`group relative flex flex-col items-center justify-center gap-1.5 rounded-lg border border-line p-2.5 transition hover:border-primary/30 hover:shadow-sm ${SIZE_SPAN[fav.size]}`}
                    >
                      <div
                        className="flex h-8 w-8 items-center justify-center rounded-lg text-base"
                        style={{ background: `${fav.color}18` }}
                      >
                        {fav.icon || <ExternalLink size={14} style={{ color: fav.color }} />}
                      </div>
                      <span className="w-full truncate text-center text-2xs text-ink">
                        {fav.title}
                      </span>

                      <div className="absolute top-1 right-1 flex gap-0.5 opacity-0 transition group-hover:opacity-100">
                        <button
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setFavDialog({ existing: fav });
                          }}
                          className="flex h-5 w-5 items-center justify-center rounded bg-surface-4/80 text-ink-3 hover:text-primary"
                        >
                          <Pencil size={10} />
                        </button>
                        <button
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            removeFav(fav.id);
                            toast.success('已删除');
                          }}
                          className="flex h-5 w-5 items-center justify-center rounded bg-surface-4/80 text-ink-3 hover:text-danger"
                        >
                          <Trash2 size={10} />
                        </button>
                      </div>
                    </a>
                  ))}
                </div>
              )}
            </section>
          </aside>
        </main>
      )}

      {favDialog && (
        <FavoriteDialog existing={favDialog.existing} onClose={() => setFavDialog(null)} />
      )}
      {queryDialog && (
        <QueryDialog
          onClose={() => setQueryDialog(false)}
          onSave={(name, url) => {
            const parsed = parseQueryUrl(url);
            if (!parsed) return;
            const id = addQuery(name, url, parsed.queryId, parsed.project);
            setQueryDialog(false);
            setTab(`query:${id}`);
            toast.success('查询已添加');
          }}
        />
      )}
    </div>
  );
}
