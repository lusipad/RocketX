import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Bookmark,
  Calendar,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Clock,
  ExternalLink,
  GitPullRequest,
  LayoutGrid,
  ListTodo,
  Loader2,
  MinusCircle,
  Pencil,
  Plus,
  RefreshCw,
  Settings,
  Star,
  Trash2,
  UserCheck,
  Wrench,
  XCircle,
} from 'lucide-react';
import { ADO_WEB_KEY, loadWorkbenchConfig, type WorkbenchConfig } from '../lib/ado';
import { useUI } from '../stores/ui';
import { useAuth } from '../stores/auth';
import { useChat } from '../stores/chat';
import { useTodos, todayKey, isOverdue, dueLabel } from '../stores/todos';
import { useCalendar, eventsForDate, DAY_NAMES } from '../stores/calendar';
import { useFavorites, SIZE_SPAN, SIZE_LABELS, randomFavColor, type Favorite, type FavSize } from '../stores/favorites';
import { fmtConvTime } from '../lib/format';
import { toast } from '../stores/toast';
import { SkeletonRows } from '../components/Skeleton';

// ---------- ADO types ----------
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

interface Build {
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

// ---------- Sub-components ----------

function StatCard({
  icon: Icon,
  label,
  value,
  color,
  onClick,
}: {
  icon: typeof ListTodo;
  label: string;
  value: number;
  color: string;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex flex-1 items-center gap-3 rounded-xl border border-line bg-surface-4 p-4 transition hover:shadow-sm"
    >
      <div
        className="flex h-10 w-10 items-center justify-center rounded-lg"
        style={{ background: `${color}18` }}
      >
        <Icon size={20} style={{ color }} />
      </div>
      <div className="text-left">
        <div className="text-xl font-bold text-ink">{value}</div>
        <div className="text-xs text-ink-3">{label}</div>
      </div>
    </button>
  );
}

function SectionHeader({
  icon: Icon,
  title,
  action,
  onAction,
}: {
  icon: typeof ListTodo;
  title: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <div className="flex items-center justify-between pb-2">
      <div className="flex items-center gap-2">
        <Icon size={16} className="text-primary" />
        <span className="text-sm font-semibold text-ink">{title}</span>
      </div>
      {action && onAction && (
        <button
          onClick={onAction}
          className="flex items-center gap-0.5 text-xs text-ink-3 transition hover:text-primary"
        >
          {action}
          <ChevronRight size={12} />
        </button>
      )}
    </div>
  );
}

function BuildStatus({ build }: { build: Build }) {
  if (build.status === 'inProgress' || build.status === 'notStarted') {
    return <Loader2 size={14} className="animate-spin text-primary" />;
  }
  if (build.result === 'succeeded') return <CheckCircle2 size={14} className="text-success" />;
  if (build.result === 'failed') return <XCircle size={14} className="text-danger" />;
  return <MinusCircle size={14} className="text-ink-3" />;
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
  const user = useAuth((s) => s.user);
  const subscriptions = useChat((s) => s.subscriptions);
  const todos = useTodos((s) => s.todos);
  const calendarEvents = useCalendar((s) => s.events);
  const setSelectedDate = useCalendar((s) => s.setSelectedDate);
  const setCursor = useCalendar((s) => s.setCursor);
  const favorites = useFavorites((s) => s.items);
  const removeFav = useFavorites((s) => s.remove);

  const [config] = useState<WorkbenchConfig | null>(loadWorkbenchConfig);
  const [workItems, setWorkItems] = useState<WorkItem[]>([]);
  const [prs, setPrs] = useState<PullRequest[]>([]);
  const [builds, setBuilds] = useState<Build[]>([]);
  const [loading, setLoading] = useState(false);
  const [adoError, setAdoError] = useState<string | null>(null);
  const [favDialog, setFavDialog] = useState<{ existing?: Favorite } | null>(null);
  const [editingFav, setEditingFav] = useState<string | null>(null);

  const today = todayKey();
  const now = new Date();
  const hour = now.getHours();
  const greeting = hour < 6 ? '夜深了' : hour < 12 ? '上午好' : hour < 18 ? '下午好' : '晚上好';

  // Stats
  const unreadTotal = useMemo(
    () =>
      Object.values(subscriptions).reduce(
        (n, s) => n + (s.disableNotifications ? 0 : s.unread || 0),
        0,
      ),
    [subscriptions],
  );
  const todoOpen = useMemo(() => todos.filter((t) => !t.done).length, [todos]);
  const todoOverdue = useMemo(() => todos.filter((t) => isOverdue(t, today)).length, [todos, today]);
  const todayEvents = useMemo(() => eventsForDate(calendarEvents, today), [calendarEvents, today]);

  // ADO
  const refresh = useCallback(async (c: WorkbenchConfig) => {
    setLoading(true);
    setAdoError(null);
    try {
      if (c.mode === 'direct' && c.adoBase) {
        const { directGetWorkItems, directGetPullRequests, directGetBuilds } = await import(
          '../lib/adoDirect'
        );
        const cfg = { adoBase: c.adoBase, pat: c.pat ?? '', auth: c.auth };
        localStorage.setItem(ADO_WEB_KEY, c.adoBase.replace(/\/+$/, ''));
        const [wi, prList, buildList] = await Promise.all([
          directGetWorkItems(cfg, c.account),
          directGetPullRequests(cfg),
          directGetBuilds(cfg).catch(() => []),
        ]);
        setWorkItems(wi as WorkItem[]);
        setPrs(prList as PullRequest[]);
        setBuilds(buildList as Build[]);
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
        const cfg = (await cfgRes.json()) as { webBase: string };
        localStorage.setItem(ADO_WEB_KEY, cfg.webBase);
        setWorkItems(((await wiRes.json()) as { items: WorkItem[] }).items);
        setPrs(((await prRes.json()) as { items: PullRequest[] }).items);
        setBuilds(buildRes.ok ? ((await buildRes.json()) as { items: Build[] }).items : []);
      }
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err ?? '');
      setAdoError(
        raw && raw !== 'Failed to fetch'
          ? raw
          : c.mode === 'direct'
            ? '无法连接 Azure DevOps'
            : '无法连接桥接服务',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (config?.account) void refresh(config);
  }, [config, refresh]);

  const reviewPrs = prs.filter(
    (pr) =>
      config &&
      pr.reviewers.some((r) => matchUser(config.account, r.unique, r.name)) &&
      !matchUser(config.account, pr.creatorUnique, pr.creator),
  );

  const upcomingTodos = useMemo(
    () =>
      todos
        .filter((t) => !t.done)
        .sort((a, b) => {
          if (a.due && b.due) return a.due.localeCompare(b.due);
          if (a.due) return -1;
          if (b.due) return 1;
          return b.createdAt - a.createdAt;
        })
        .slice(0, 5),
    [todos],
  );

  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-y-auto bg-fill-2">
      {/* 顶部问候 + 日期 */}
      <header className="shrink-0 border-b border-line bg-surface-4 px-8 py-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-ink">
              {greeting}，{user?.name || user?.username || ''}
            </h1>
            <p className="mt-1 text-sm text-ink-3">
              {now.getFullYear()} 年 {now.getMonth() + 1} 月 {now.getDate()} 日 · 周{DAY_NAMES[now.getDay()]}
              {todayEvents.length > 0 && ` · 今天有 ${todayEvents.length} 项日程`}
            </p>
          </div>
          <div className="flex gap-2">
            {config?.account && (
              <button
                onClick={() => void (config && refresh(config))}
                disabled={loading}
                className="flex h-8 items-center gap-1.5 rounded-md border border-line px-3 text-xs text-ink-2 transition hover:bg-fill-hover disabled:opacity-50"
              >
                <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
                刷新
              </button>
            )}
            <button
              onClick={() => setModule('settings')}
              className="flex h-8 w-8 items-center justify-center rounded-md text-ink-2 transition hover:bg-fill-hover"
            >
              <Settings size={15} />
            </button>
          </div>
        </div>
      </header>

      <div className="flex-1 p-6 space-y-6">
        {/* 统计卡片 */}
        <div className="flex gap-4">
          <StatCard
            icon={ListTodo}
            label="待办事项"
            value={todoOpen}
            color="#3370ff"
            onClick={() => setModule('todos')}
          />
          <StatCard
            icon={AlertTriangle}
            label="已逾期"
            value={todoOverdue}
            color="#f54a45"
            onClick={() => setModule('todos')}
          />
          <StatCard
            icon={Calendar}
            label="今日日程"
            value={todayEvents.length}
            color="#7f3bf5"
            onClick={() => setModule('calendar')}
          />
          <StatCard
            icon={Star}
            label="未读消息"
            value={unreadTotal}
            color="#ff8800"
            onClick={() => setModule('messages')}
          />
        </div>

        <div className="grid grid-cols-3 gap-5">
          {/* -------- 左列：日程 + 待办 -------- */}
          <div className="col-span-2 space-y-5">
            {/* 今日日程 */}
            <section className="rounded-xl border border-line bg-surface-4 p-4">
              <SectionHeader
                icon={Calendar}
                title="今日日程"
                action="查看日历"
                onAction={() => setModule('calendar')}
              />
              {todayEvents.length === 0 ? (
                <div className="py-6 text-center text-xs text-ink-3">今天暂无日程安排</div>
              ) : (
                <div className="space-y-1">
                  {todayEvents.map((e) => (
                    <button
                      key={e.id}
                      onClick={() => {
                        setSelectedDate(today);
                        setCursor(today);
                        setModule('calendar');
                      }}
                      className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition hover:bg-fill-hover"
                    >
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: e.color }} />
                      <span className="flex-1 truncate text-sm text-ink">{e.title}</span>
                      {!e.allDay && e.startTime && (
                        <span className="flex items-center gap-1 text-xs text-ink-3">
                          <Clock size={11} /> {e.startTime}
                          {e.endTime ? `–${e.endTime}` : ''}
                        </span>
                      )}
                      {e.allDay && <span className="text-xs text-ink-3">全天</span>}
                    </button>
                  ))}
                </div>
              )}
            </section>

            {/* 待办事项 */}
            <section className="rounded-xl border border-line bg-surface-4 p-4">
              <SectionHeader
                icon={ListTodo}
                title="待办事项"
                action="查看全部"
                onAction={() => setModule('todos')}
              />
              {upcomingTodos.length === 0 ? (
                <div className="py-6 text-center text-xs text-ink-3">没有待办事项</div>
              ) : (
                <div className="space-y-1">
                  {upcomingTodos.map((t) => (
                    <div
                      key={t.id}
                      className="flex items-center gap-2.5 rounded-lg px-3 py-2 transition hover:bg-fill-hover"
                    >
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{
                          background: isOverdue(t, today) ? '#f54a45' : '#3370ff',
                        }}
                      />
                      <span className="min-w-0 flex-1 truncate text-sm text-ink">
                        {t.note || t.excerpt || '（无文字内容）'}
                      </span>
                      {t.due && (
                        <span
                          className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] ${
                            isOverdue(t, today)
                              ? 'bg-danger/10 text-danger'
                              : t.due === today
                                ? 'bg-warning/10 text-warning'
                                : 'bg-fill-2 text-ink-3'
                          }`}
                        >
                          {dueLabel(t.due)}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* ADO 工作台 */}
            {config?.account && (
              <section className="rounded-xl border border-line bg-surface-4 p-4">
                <SectionHeader
                  icon={Wrench}
                  title={`Azure DevOps · ${config.account}`}
                />
                {adoError ? (
                  <div className="flex items-center gap-2 py-4 text-xs text-danger">
                    <XCircle size={14} />
                    {adoError}
                    <button
                      onClick={() => void refresh(config)}
                      className="ml-2 text-primary hover:underline"
                    >
                      重试
                    </button>
                  </div>
                ) : loading ? (
                  <SkeletonRows rows={3} />
                ) : (
                  <div className="grid grid-cols-2 gap-4 pt-1">
                    {/* 工作项 */}
                    <div>
                      <div className="flex items-center gap-1.5 pb-2">
                        <CircleDot size={13} className="text-primary" />
                        <span className="text-xs font-medium text-ink-2">
                          我的工作项 ({workItems.length})
                        </span>
                      </div>
                      {workItems.slice(0, 5).map((w) => (
                        <a
                          key={w.id}
                          href={w.webUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="flex items-center gap-2 rounded-md px-2 py-1.5 transition hover:bg-fill-hover"
                        >
                          <span
                            className="h-2 w-2 shrink-0 rounded-full"
                            style={{ background: TYPE_COLORS[w.type] ?? '#8f959e' }}
                          />
                          <span className="shrink-0 text-[11px] text-ink-3">#{w.id}</span>
                          <span className="min-w-0 flex-1 truncate text-xs text-ink">{w.title}</span>
                        </a>
                      ))}
                      {workItems.length > 5 && (
                        <div className="pt-1 text-center text-[11px] text-ink-3">
                          还有 {workItems.length - 5} 项
                        </div>
                      )}
                      {workItems.length === 0 && (
                        <div className="py-4 text-center text-xs text-ink-3">无工作项</div>
                      )}
                    </div>

                    {/* PR + 构建 */}
                    <div>
                      <div className="flex items-center gap-1.5 pb-2">
                        <GitPullRequest size={13} className="text-[#7f3bf5]" />
                        <span className="text-xs font-medium text-ink-2">
                          待评审 PR ({reviewPrs.length})
                        </span>
                      </div>
                      {reviewPrs.slice(0, 3).map((pr) => (
                        <a
                          key={pr.id}
                          href={pr.webUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="flex items-center gap-2 rounded-md px-2 py-1.5 transition hover:bg-fill-hover"
                        >
                          <span className="shrink-0 text-[11px] text-ink-3">!{pr.id}</span>
                          <span className="min-w-0 flex-1 truncate text-xs text-ink">
                            {pr.title}
                          </span>
                        </a>
                      ))}
                      {reviewPrs.length === 0 && (
                        <div className="py-3 text-center text-xs text-ink-3">暂无待评审</div>
                      )}

                      {builds.length > 0 && (
                        <>
                          <div className="mt-3 flex items-center gap-1.5 pb-2">
                            <Wrench size={13} className="text-ink-2" />
                            <span className="text-xs font-medium text-ink-2">最近构建</span>
                          </div>
                          {builds.slice(0, 3).map((b) => (
                            <a
                              key={`${b.project}-${b.id}`}
                              href={b.webUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="flex items-center gap-2 rounded-md px-2 py-1.5 transition hover:bg-fill-hover"
                            >
                              <BuildStatus build={b} />
                              <span className="min-w-0 flex-1 truncate text-xs text-ink">
                                {b.definition}
                              </span>
                              <span className="shrink-0 text-[10px] text-ink-3">
                                {b.finishTime ? fmtConvTime(new Date(b.finishTime).getTime()) : '进行中'}
                              </span>
                            </a>
                          ))}
                        </>
                      )}
                    </div>
                  </div>
                )}
              </section>
            )}

            {!config?.account && (
              <section className="rounded-xl border border-line bg-surface-4 p-4">
                <SectionHeader icon={Wrench} title="Azure DevOps" />
                <div className="flex flex-col items-center gap-2 py-6">
                  <div className="text-xs text-ink-3">连接后可查看工作项、PR 和构建</div>
                  <button
                    onClick={() => setModule('settings')}
                    className="h-7 rounded-md bg-primary px-3 text-xs text-white hover:bg-primary-hover"
                  >
                    前往设置
                  </button>
                </div>
              </section>
            )}
          </div>

          {/* -------- 右列：收藏夹 -------- */}
          <div className="space-y-5">
            <section className="rounded-xl border border-line bg-surface-4 p-4">
              <div className="flex items-center justify-between pb-3">
                <div className="flex items-center gap-2">
                  <Bookmark size={16} className="text-primary" />
                  <span className="text-sm font-semibold text-ink">收藏夹</span>
                </div>
                <button
                  onClick={() => setFavDialog({})}
                  className="flex h-6 w-6 items-center justify-center rounded text-ink-3 transition hover:bg-fill-hover hover:text-primary"
                >
                  <Plus size={14} />
                </button>
              </div>

              {favorites.length === 0 ? (
                <div className="flex flex-col items-center gap-2 py-8 text-center">
                  <Bookmark size={28} className="text-ink-3" />
                  <div className="text-xs text-ink-3">
                    收藏常用链接，快速访问
                  </div>
                  <button
                    onClick={() => setFavDialog({})}
                    className="text-xs text-primary hover:underline"
                  >
                    添加收藏
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-3 gap-2">
                  {favorites.map((fav) => (
                    <a
                      key={fav.id}
                      href={fav.url}
                      target="_blank"
                      rel="noreferrer"
                      className={`group relative flex flex-col items-center justify-center gap-1.5 rounded-lg border border-line p-3 transition hover:shadow-sm hover:border-primary/30 ${SIZE_SPAN[fav.size]}`}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setEditingFav(editingFav === fav.id ? null : fav.id);
                      }}
                    >
                      <div
                        className="flex h-9 w-9 items-center justify-center rounded-lg text-lg"
                        style={{ background: `${fav.color}18` }}
                      >
                        {fav.icon || (
                          <ExternalLink size={16} style={{ color: fav.color }} />
                        )}
                      </div>
                      <span className="w-full truncate text-center text-[11px] text-ink">
                        {fav.title}
                      </span>

                      {/* hover actions */}
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

            {/* 快捷入口 */}
            <section className="rounded-xl border border-line bg-surface-4 p-4">
              <SectionHeader icon={LayoutGrid} title="快捷入口" />
              <div className="grid grid-cols-3 gap-2">
                {[
                  { label: '消息', icon: Star, color: '#3370ff', module: 'messages' as const },
                  { label: '待办', icon: ListTodo, color: '#00b96b', module: 'todos' as const },
                  { label: '通讯录', icon: UserCheck, color: '#7f3bf5', module: 'contacts' as const },
                  { label: '日历', icon: Calendar, color: '#ff8800', module: 'calendar' as const },
                  { label: '设置', icon: Settings, color: '#8f959e', module: 'settings' as const },
                ].map(({ label, icon: Icon, color, module }) => (
                  <button
                    key={module}
                    onClick={() => setModule(module)}
                    className="flex flex-col items-center gap-1.5 rounded-lg p-3 transition hover:bg-fill-hover"
                  >
                    <div
                      className="flex h-9 w-9 items-center justify-center rounded-lg"
                      style={{ background: `${color}18` }}
                    >
                      <Icon size={18} style={{ color }} />
                    </div>
                    <span className="text-[11px] text-ink-2">{label}</span>
                  </button>
                ))}
              </div>
            </section>
          </div>
        </div>
      </div>

      {favDialog && (
        <FavoriteDialog existing={favDialog.existing} onClose={() => setFavDialog(null)} />
      )}
    </main>
  );
}
