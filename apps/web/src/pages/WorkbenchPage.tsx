import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bookmark,
  Calendar,
  LayoutList,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  ExternalLink,
  GitPullRequest,
  ListTree,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Settings,
  SquareActivity,
  SquareKanban,
  Trash2,
  Wrench,
  XCircle,
} from 'lucide-react';
import { useI18n, useT, type MessageKey } from '../i18n';
import { myPrsOf, reviewPrsOf, useWorkbench, type WorkItem } from '../stores/workbench';
import { BuildList, PullRequestList, WorkItemList } from '../components/AdoLists';
import CreateWorkItemDiscussionDialog from '../components/CreateWorkItemDiscussionDialog';
import { WorkItemBoard, WorkItemWbs } from '../components/QueryViews';
import { useUI } from '../stores/ui';
import { useAuth } from '../stores/auth';
import { useChat } from '../stores/chat';
import { useTodos, todayKey, type Todo } from '../stores/todos';
import { buildQueue, queueSummary, type QueueItem } from '../lib/queue';
import { useCalendar, eventsForDate } from '../stores/calendar';
import { useFavorites, SIZE_SPAN, SIZE_LABEL_KEYS, normalizeFavoriteUrl, randomFavColor, type Favorite, type FavSize } from '../stores/favorites';
import {
  beginCustomQueryLoad,
  customQueryConnectionScope,
  createCustomQueryLoadState,
  finishCustomQueryLoad,
  isCurrentCustomQueryLoad,
  rejectCustomQueryLoad,
  removeCustomQueryLoad,
  resolveCustomQueryLoad,
  useCustomQueries,
  parseQueryUrl,
  queriesForScope,
  shouldFetchCustomQuery,
  type ParsedCustomQuery,
} from '../stores/customQueries';
import { fmtConvTime } from '../lib/format';
import { totalUnread } from '../lib/unread';
import { toast } from '../stores/toast';
import { SkeletonRows } from '../components/Skeleton';
import { ConfirmDialog, useDialogBehavior } from '../components/Dialog';
import { settleScopedResult } from '../lib/scopedResult';
import { runtimeFeatures } from '../lib/runtimeMode';

/** 工作台内部视图：概览（仪表盘）+ ADO 个人工作视图 */
type AdoTab = 'overview' | 'workitems' | 'contributions' | 'prs' | 'builds';

const ProfileContributionsPage = lazy(() => import('./ProfileContributionsPage'));

/** 自定义查询结果的展示方式（issue #82/#83）：查询定范围，视图定看法 */
type QueryViewMode = 'list' | 'board' | 'wbs';

const QUERY_VIEWS_KEY = 'rcx-query-views-v1';

const QUERY_VIEW_OPTIONS: { key: QueryViewMode; labelKey: MessageKey; icon: typeof LayoutList }[] = [
  { key: 'list', labelKey: 'workbench.queryView.list', icon: LayoutList },
  { key: 'board', labelKey: 'workbench.queryView.board', icon: SquareKanban },
  { key: 'wbs', labelKey: 'workbench.queryView.wbs', icon: ListTree },
];

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
        className="w-20 shrink-0 truncate text-xs"
        style={{ color: item.color }}
        title={item.label}
      >
        {item.label}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm text-ink">{item.title}</span>
      {item.meta && (
        <span className="max-w-[40%] shrink-0 truncate text-xs text-ink-3">{item.meta}</span>
      )}
      {item.href ? (
        <ExternalLink size={14} className="shrink-0 text-ink-3 opacity-0 group-hover:opacity-100" />
      ) : (
        <ChevronRight size={14} className="shrink-0 text-ink-3 opacity-0 group-hover:opacity-100" />
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
  adoBase,
  onClose,
  onSave,
}: {
  adoBase: string;
  onClose: () => void;
  onSave: (name: string, query: ParsedCustomQuery) => void;
}) {
  const t = useT();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const parsed = url.trim() ? parseQueryUrl(url.trim(), adoBase) : null;
  const dialogRef = useDialogBehavior(onClose);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('workbench.customQueryDialog.title')}
        tabIndex={-1}
        className="w-[440px] rounded-xl bg-surface-4 shadow-raise shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-line px-5 py-3">
          <span className="text-base font-semibold text-ink">{t('workbench.customQueryDialog.title')}</span>
          <button
            onClick={onClose}
            className="text-ink-3 hover:text-ink"
            title={t('common.close')}
            aria-label={t('workbench.customQueryDialog.closeAria')}
          >
            <XCircle size={16} />
          </button>
        </header>
        <div className="space-y-4 p-5">
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-2">{t('workbench.customQueryDialog.nameLabel')}</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('workbench.customQueryDialog.namePlaceholder')}
              autoFocus
              className="h-9 w-full rounded-md border border-line bg-surface-3 px-3 text-sm text-ink outline-none focus:border-primary"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-2">
              {t('workbench.customQueryDialog.urlLabel')}
            </label>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={t('workbench.customQueryDialog.urlPlaceholder')}
              className="h-9 w-full rounded-md border border-line bg-surface-3 px-3 text-sm text-ink outline-none focus:border-primary"
            />
            <p className="mt-1.5 text-xs text-ink-3">
              {t('workbench.customQueryDialog.urlHint')}
            </p>
            {url.trim() && !parsed && (
              <p className="mt-1 text-xs text-danger">{t('workbench.customQueryDialog.invalidUrl')}</p>
            )}
            {parsed && (
              <p className="mt-1 text-xs text-success">
                {t('workbench.customQueryDialog.parsedQuery', {
                  id: parsed.queryId.slice(0, 8),
                  projectPart: parsed.project ? ` (${parsed.project})` : '',
                })}
              </p>
            )}
          </div>
        </div>
        <footer className="flex justify-end gap-2 border-t border-line px-5 py-3">
          <button
            onClick={onClose}
            className="h-8 rounded-md border border-line px-4 text-sm text-ink-2 hover:bg-fill-hover"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={() => {
              if (name.trim() && parsed) onSave(name.trim(), parsed);
            }}
            disabled={!name.trim() || !parsed}
            className="h-8 rounded-md bg-primary px-4 text-sm text-white hover:bg-primary-hover disabled:opacity-50"
          >
            {t('common.add')}
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
  const t = useT();
  const add = useFavorites((s) => s.add);
  const update = useFavorites((s) => s.update);
  const [title, setTitle] = useState(existing?.title ?? '');
  const [url, setUrl] = useState(existing?.url ?? '');
  const [icon, setIcon] = useState(existing?.icon ?? '');
  const [color, setColor] = useState(existing?.color ?? randomFavColor());
  const [size, setSize] = useState<FavSize>(existing?.size ?? 'small');
  const dialogTitle = existing ? t('workbench.favoriteDialog.editTitle') : t('workbench.favoriteDialog.addTitle');
  const dialogRef = useDialogBehavior(onClose);
  const normalizedUrl = normalizeFavoriteUrl(url);
  const urlInvalid = !!url.trim() && !normalizedUrl;

  const handleSave = () => {
    if (!title.trim() || !normalizedUrl) return;
    const data = { title: title.trim(), url: normalizedUrl, icon: icon || undefined, color, size };
    if (existing) {
      update(existing.id, data);
      toast.success(t('workbench.toast.updated'));
    } else {
      add(data);
      toast.success(t('workbench.toast.added'));
    }
    onClose();
  };

  const COLORS = [
    '#3370ff', '#00b96b', '#7f3bf5', '#f54a45', '#ff8800',
    '#14b8a6', '#f472b6', '#8b5cf6', '#06b6d4', '#84cc16',
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={dialogTitle}
        tabIndex={-1}
        className="w-[400px] rounded-xl bg-surface-4 shadow-raise shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-line px-5 py-3">
          <span className="text-base font-semibold text-ink">{dialogTitle}</span>
          <button onClick={onClose} className="text-ink-3 hover:text-ink" title={t('common.close')} aria-label={t('workbench.favoriteDialog.closeAria')}><XCircle size={16} /></button>
        </header>
        <div className="space-y-4 p-5">
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-2">{t('workbench.favoriteDialog.titleLabel')}</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('workbench.favoriteDialog.titlePlaceholder')}
              autoFocus
              className="h-9 w-full rounded-md border border-line bg-surface-3 px-3 text-sm text-ink outline-none focus:border-primary"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-2">{t('workbench.favoriteDialog.urlLabel')}</label>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://..."
              className="h-9 w-full rounded-md border border-line bg-surface-3 px-3 text-sm text-ink outline-none focus:border-primary"
            />
            {urlInvalid && <p className="mt-1 text-xs text-danger">{t('workbench.favoriteDialog.invalidUrl')}</p>}
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-2">{t('workbench.favoriteDialog.iconLabel')}</label>
            <input
              value={icon}
              onChange={(e) => setIcon(e.target.value)}
              placeholder="📌"
              maxLength={4}
              className="h-9 w-16 rounded-md border border-line bg-surface-3 px-3 text-center text-sm outline-none focus:border-primary"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-ink-2">{t('workbench.favoriteDialog.colorLabel')}</label>
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
            <label className="mb-1.5 block text-xs font-medium text-ink-2">{t('workbench.favoriteDialog.sizeLabel')}</label>
            <div className="flex gap-2">
              {(['small', 'medium', 'large'] as FavSize[]).map((s) => (
                <button
                  key={s}
                  onClick={() => setSize(s)}
                  className={`h-8 flex-1 rounded-md border text-xs transition ${
                    size === s ? 'border-primary bg-primary/5 text-primary' : 'border-line text-ink-2 hover:bg-fill-hover'
                  }`}
                >
                  {t(SIZE_LABEL_KEYS[s])}
                </button>
              ))}
            </div>
          </div>
        </div>
        <footer className="flex justify-end gap-2 border-t border-line px-5 py-3">
          <button onClick={onClose} className="h-8 rounded-md border border-line px-4 text-sm text-ink-2 hover:bg-fill-hover">{t('common.cancel')}</button>
          <button
            onClick={handleSave}
            disabled={!title.trim() || !normalizedUrl}
            className="h-8 rounded-md bg-primary px-4 text-sm text-white hover:bg-primary-hover disabled:opacity-50"
          >
            {existing ? t('common.save') : t('common.add')}
          </button>
        </footer>
      </div>
    </div>
  );
}

// ---------- Main ----------

export default function WorkbenchPage() {
  const { t, tp, locale } = useI18n();
  const features = runtimeFeatures();
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
  const configRevision = useWorkbench((s) => s.configRevision);
  const workItems = useWorkbench((s) => s.workItems);
  const prs = useWorkbench((s) => s.prs);
  const builds = useWorkbench((s) => s.builds);
  const loading = useWorkbench((s) => s.loading);
  const adoError = useWorkbench((s) => s.error);
  const lastRefresh = useWorkbench((s) => s.lastRefresh);
  const refresh = useWorkbench((s) => s.refresh);

  const allCustomQueries = useCustomQueries((s) => s.queries);
  const addQuery = useCustomQueries((s) => s.add);
  const removeQuery = useCustomQueries((s) => s.remove);
  const claimLegacyQueries = useCustomQueries((s) => s.claimLegacy);
  const [queryDialog, setQueryDialog] = useState(false);
  const [discussionItem, setDiscussionItem] = useState<WorkItem | null>(null);

  // 每个查询记住自己的视图（列表/看板/WBS）——同一个查询通常固定一种看法（issue #82/#83）
  const [queryViews, setQueryViews] = useState<Record<string, QueryViewMode>>(() => {
    try {
      return JSON.parse(localStorage.getItem(QUERY_VIEWS_KEY) ?? '{}') as Record<string, QueryViewMode>;
    } catch {
      return {};
    }
  });
  const setQueryView = useCallback((queryId: string, view: QueryViewMode) => {
    setQueryViews((current) => {
      const next = { ...current, [queryId]: view };
      try {
        localStorage.setItem(QUERY_VIEWS_KEY, JSON.stringify(next));
      } catch {
        /* 存储满时只影响下次默认视图 */
      }
      return next;
    });
  }, []);

  const queryConnectionScope = customQueryConnectionScope(config);
  const queryAdoBase = config?.adoBase ?? '';
  const customQueries = useMemo(
    () => queriesForScope(allCustomQueries, queryConnectionScope, queryAdoBase),
    [allCustomQueries, queryAdoBase, queryConnectionScope],
  );

  const activeQueryId = tab.startsWith('query:') ? tab.slice(6) : null;
  const activeQuery = customQueries.find((q) => q.id === activeQueryId);
  const canUseCustomQueries = !!config?.adoBase;
  const queryScope = `${queryConnectionScope}\0${configRevision}`;
  const [queryState, setQueryState] = useState(() =>
    createCustomQueryLoadState<WorkItem[]>(queryScope),
  );
  const queryStateRef = useRef(queryState);
  const visibleQueryState = useMemo(
    () =>
      queryState.scope === queryScope
        ? queryState
        : createCustomQueryLoadState<WorkItem[]>(queryScope),
    [queryScope, queryState],
  );

  const updateQueryState = useCallback(
    (update: (current: typeof queryState) => typeof queryState) => {
      const next = update(queryStateRef.current);
      queryStateRef.current = next;
      setQueryState(next);
    },
    [],
  );

  // 看板拖拽改状态：先确认再写 ADO（issue #82 二期）
  const [pendingMove, setPendingMove] = useState<{
    queryId: string;
    item: WorkItem;
    toState: string;
  } | null>(null);
  const applyMove = useCallback(async () => {
    const move = pendingMove;
    if (!move) return;
    const cfg = useWorkbench.getState().config;
    if (!cfg?.adoBase) return;
    try {
      const { directUpdateWorkItemState } = await import('../lib/adoDirect');
      const updated = await directUpdateWorkItemState(
        { adoBase: cfg.adoBase, pat: cfg.pat ?? '', auth: cfg.auth },
        move.item.id,
        move.toState,
      );
      updateQueryState((current) => ({
        ...current,
        cache: {
          ...current.cache,
          [move.queryId]: (current.cache[move.queryId] ?? []).map((w) =>
            w.id === updated.id ? updated : w,
          ),
        },
      }));
      toast.success(t('workbench.board.stateChangedToast', {
        id: move.item.id,
        state: move.toState,
      }));
    } catch (err) {
      toast.error(err, t('workbench.board.stateChangeFailed'));
    }
  }, [pendingMove, t, updateQueryState]);

  useEffect(() => {
    if (queryConnectionScope && queryAdoBase) {
      claimLegacyQueries(queryConnectionScope, queryAdoBase);
    }
  }, [claimLegacyQueries, queryAdoBase, queryConnectionScope]);

  useEffect(() => {
    if (queryStateRef.current.scope === queryScope) return;
    const next = createCustomQueryLoadState<WorkItem[]>(queryScope);
    queryStateRef.current = next;
    setQueryState(next);
  }, [queryScope]);

  useEffect(() => {
    if (activeQueryId && (!canUseCustomQueries || !activeQuery)) setTab('overview');
  }, [activeQuery, activeQueryId, canUseCustomQueries, setTab]);

  const fetchQuery = useCallback(
    async (q: typeof customQueries[0], force = false) => {
      if (!config?.adoBase) return;
      const scope = `${customQueryConnectionScope(config)}\0${configRevision}`;
      const started = beginCustomQueryLoad(queryStateRef.current, scope, q.id, force);
      if (!started) return;
      queryStateRef.current = started.state;
      setQueryState(started.state);
      const revision = started.revision;
      await settleScopedResult(
        async () => {
          const { directRunSavedQuery } = await import('../lib/adoDirect');
          const cfg = { adoBase: config.adoBase!, pat: config.pat ?? '', auth: config.auth };
          return directRunSavedQuery(cfg, q.queryId, q.project);
        },
        {
          success: (items) =>
            updateQueryState((current) =>
              resolveCustomQueryLoad(
                current,
                scope,
                q.id,
                revision,
                items as WorkItem[],
              ),
            ),
          error: (err) =>
            updateQueryState((current) =>
              rejectCustomQueryLoad(
                current,
                scope,
                q.id,
                revision,
                err instanceof Error ? err.message : String(err),
              ),
            ),
          complete: () =>
            updateQueryState((current) =>
              finishCustomQueryLoad(current, scope, q.id, revision),
            ),
        },
        () =>
          isCurrentCustomQueryLoad(queryStateRef.current, scope, q.id, revision) &&
          `${customQueryConnectionScope(useWorkbench.getState().config)}\0${
            useWorkbench.getState().configRevision
          }` === scope,
      );
    },
    [config, configRevision, updateQueryState],
  );

  useEffect(() => {
    if (activeQuery && shouldFetchCustomQuery(activeQuery.id, visibleQueryState)) {
      void fetchQuery(activeQuery);
    }
  }, [activeQuery, fetchQuery, visibleQueryState]);

  const [favDialog, setFavDialog] = useState<{ existing?: Favorite } | null>(null);

  const today = todayKey();
  const now = new Date();
  const hour = now.getHours();
  const greeting = hour < 6
    ? t('workbench.greeting.lateNight')
    : hour < 12
      ? t('workbench.greeting.morning')
      : hour < 18
        ? t('workbench.greeting.afternoon')
        : t('workbench.greeting.evening');

  const unreadTotal = useMemo(() => totalUnread(subscriptions), [subscriptions]);
  const todayEvents = useMemo(() => eventsForDate(calendarEvents, today), [calendarEvents, today]);

  const account = config?.account ?? '';
  // 「工作台是否可用」取决于连没连上服务器，而不是用户填没填账号 ——
  // Windows 集成认证下账号是服务器识别的，用户根本不用填
  const connected = !!config?.adoBase;
  // 标题上显示身份：没识别到账号就别硬凑一个空字符串出来
  const adoTitle = account ? `Azure DevOps · ${account}` : 'Azure DevOps';
  useEffect(() => {
    if (!connected && tab !== 'overview') setTab('overview');
  }, [connected, setTab, tab]);

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
    if (tab === 'contributions') return;
    if (!lastRefresh && !triedRef.current) {
      triedRef.current = true;
      void refresh();
    }
  }, [connected, lastRefresh, refresh, tab]);

  const reviewPrs = useMemo(() => reviewPrsOf(prs, account), [prs, account]);
  const myPrs = useMemo(() => myPrsOf(prs, account), [prs, account]);
  const failedBuilds = useMemo(() => builds.filter((b) => b.result === 'failed').length, [builds]);

  /** 首页的核心：把待办、工作项、PR、构建合成一条按紧急度排序的队列 */
  const queue = useMemo(
    () => buildQueue({ todos, workItems, prs, builds, events: calendarEvents, account, today }),
    [todos, workItems, prs, builds, calendarEvents, account, today, locale],
  );

  /** 待办点击：回到它来自的那条消息，上下文才是最重要的；手动待办没有来源，去待办模块 */
  const openTodoSource = async (todo: Todo) => {
    if (!todo.rid || !todo.mid) {
      setModule('todos');
      return;
    }
    setModule('messages');
    await openRoom(todo.rid);
    await jumpToMessage(todo.mid, todo.rid);
  };

  // ADO 未配置时不显示个人工作视图——点进去只有空页，没意义
  const tabs: {
    key: AdoTab;
    labelKey: MessageKey;
    icon: typeof CircleDot;
    badge?: number;
    danger?: boolean;
  }[] = [
      { key: 'overview', labelKey: 'workbench.tab.overview', icon: LayoutList },
      ...(connected
        ? [
            { key: 'workitems' as const, labelKey: 'workbench.tab.workItems' as const, icon: CircleDot, badge: workItems.length },
            { key: 'contributions' as const, labelKey: 'workbench.tab.contributions' as const, icon: SquareActivity },
            { key: 'prs' as const, labelKey: 'workbench.tab.pullRequests' as const, icon: GitPullRequest, badge: reviewPrs.length },
            {
              key: 'builds' as const,
              labelKey: 'workbench.tab.builds' as const,
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
        <span className="text-xs text-ink-3">{t('workbench.updatedAt', { time: fmtConvTime(lastRefresh) })}</span>
      )}
      <button
        onClick={() => void refresh()}
        disabled={loading}
        className="flex h-8 items-center gap-1.5 rounded-md border border-line px-3 text-xs text-ink-2 transition hover:bg-fill-hover disabled:opacity-50"
      >
        <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        {t('common.refresh')}
      </button>
    </div>
  );

  const activeTabItem = tabs.find((item) => item.key === tab);
  const displayName = user?.name || user?.username || '';

  return (
    <div className="flex min-w-0 flex-1">
      <aside className="flex w-[196px] shrink-0 flex-col border-r border-line bg-surface-2 p-3">
        <div className="px-2.5 py-2 text-base font-semibold text-ink">{t('workbench.title')}</div>
        <div className="flex flex-col gap-0.5">
          {tabs.map(({ key, labelKey, icon: Icon, badge, danger }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              aria-current={tab === key ? 'page' : undefined}
              className={`flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-sm transition ${
                tab === key
                  ? 'bg-surface-4 font-medium text-ink shadow-raise ring-1 ring-line/80'
                  : 'text-ink-2 hover:bg-fill-hover hover:text-ink'
              }`}
            >
              <Icon size={16} className={tab === key ? 'text-primary' : ''} />
              <span className="min-w-0 truncate">{t(labelKey)}</span>
              {badge ? (
                <span
                  className={`ml-auto rounded-full px-1.5 py-0.5 text-2xs font-medium ${
                    danger ? 'bg-danger/10 text-danger' : 'bg-fill-1 text-ink-3'
                  }`}
                >
                  {badge}
                </span>
              ) : null}
            </button>
          ))}
        </div>

        {canUseCustomQueries && customQueries.length > 0 && (
          <>
            <div className="mt-4 mb-1.5 px-2.5 text-xs font-medium text-ink-3">{t('workbench.sidebar.customQueries')}</div>
            <div className="flex flex-col gap-0.5">
            {customQueries.map((q) => (
              <div key={q.id} className="group relative">
                <button
                  onClick={() => setTab(`query:${q.id}`)}
                  className={`flex w-full items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-sm transition ${
                    tab === `query:${q.id}`
                      ? 'bg-surface-4 font-medium text-ink shadow-raise ring-1 ring-line/80'
                      : 'text-ink-2 hover:bg-fill-hover hover:text-ink'
                  }`}
                >
                  <Search size={14} />
                  <span className="min-w-0 flex-1 truncate text-left">{q.name}</span>
                  {visibleQueryState.cache[q.id] && (
                    <span className="text-xs text-ink-3">
                      {visibleQueryState.cache[q.id].length}
                    </span>
                  )}
                </button>
                <button
                  onClick={() => {
                    removeQuery(q.id);
                    updateQueryState((current) => removeCustomQueryLoad(current, q.id));
                    if (tab === `query:${q.id}`) setTab('overview');
                    toast.success(t('workbench.toast.deleted'));
                  }}
                  title={t('common.delete')}
                  aria-label={t('common.delete')}
                  className="absolute top-1 right-1 hidden h-5 w-5 items-center justify-center rounded text-ink-3 hover:text-danger group-hover:flex"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
            </div>
          </>
        )}

        {canUseCustomQueries && (
          <button
            onClick={() => setQueryDialog(true)}
            className="mt-2 flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-ink-3 transition hover:bg-fill-hover hover:text-primary"
          >
            <Plus size={14} />
            {t('workbench.sidebar.addQuery')}
          </button>
        )}

        <button
          onClick={() => setModule('settings')}
          className="mt-auto flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-ink-3 transition hover:bg-fill-hover hover:text-ink"
        >
          <Settings size={14} />
          {connected ? t('workbench.sidebar.settings') : t('workbench.sidebar.connectAdo')}
        </button>
      </aside>

      {connected && tab === 'contributions' ? (
        <Suspense
          fallback={(
            <main className="min-w-0 flex-1 bg-surface-2 p-5">
              <SkeletonRows rows={8} />
            </main>
          )}
        >
          <ProfileContributionsPage />
        </Suspense>
      ) : connected && tab !== 'overview' ? (
        <main className="flex min-w-0 flex-1 flex-col bg-surface-3">
          <div className="rcx-glass-header flex h-14 shrink-0 items-center justify-between border-b border-line px-6">
            <span className="text-base font-semibold text-ink">
              {activeQuery ? activeQuery.name : (activeTabItem ? t(activeTabItem.labelKey) : undefined)}
              <span className="ml-2 text-xs font-normal text-ink-3">
                {adoTitle}
              </span>
            </span>
            {activeQuery ? (
              <div className="flex items-center gap-2">
                <div className="flex h-8 items-center rounded-xl border border-line bg-surface-2 p-0.5">
                  {QUERY_VIEW_OPTIONS.map(({ key, labelKey, icon: Icon }) => {
                    const label = t(labelKey);
                    const active = (queryViews[activeQuery.id] ?? 'list') === key;
                    return (
                      <button
                        key={key}
                        onClick={() => setQueryView(activeQuery.id, key)}
                        className={`flex h-7 items-center gap-1 rounded-lg px-2.5 text-xs transition ${
                          active
                            ? 'bg-surface-4 font-medium text-ink shadow-raise'
                            : 'text-ink-3 hover:text-ink'
                        }`}
                        title={t('workbench.queryView.tooltip', { label })}
                      >
                        <Icon size={14} />
                        {label}
                      </button>
                    );
                  })}
                </div>
                <button
                  onClick={() => void fetchQuery(activeQuery, true)}
                  disabled={visibleQueryState.loading[activeQuery.id] !== undefined}
                  className="flex h-8 items-center gap-1.5 rounded-md border border-line px-3 text-xs text-ink-2 transition hover:bg-fill-hover disabled:opacity-50"
                >
                  <RefreshCw
                    size={14}
                    className={
                      visibleQueryState.loading[activeQuery.id] !== undefined
                        ? 'animate-spin'
                        : ''
                    }
                  />
                  {t('common.refresh')}
                </button>
                <a
                  href={activeQuery.url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex h-8 items-center gap-1.5 rounded-md border border-line px-3 text-xs text-ink-2 transition hover:bg-fill-hover"
                >
                  <ExternalLink size={14} />
                  {t('workbench.customQuery.openInAdo')}
                </a>
              </div>
            ) : (
              refreshBar
            )}
          </div>
          <div className="flex min-h-0 flex-1 flex-col p-6">
          {activeQuery ? (
            visibleQueryState.loading[activeQuery.id] !== undefined &&
            !visibleQueryState.cache[activeQuery.id] ? (
              <SkeletonRows rows={8} />
            ) : visibleQueryState.errors[activeQuery.id] &&
              !visibleQueryState.cache[activeQuery.id] ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2">
                <XCircle size={28} className="text-danger" />
                <div className="max-w-md text-center text-sm text-danger">
                  {visibleQueryState.errors[activeQuery.id]}
                </div>
                <button
                  onClick={() => void fetchQuery(activeQuery, true)}
                  className="mt-1 h-8 rounded-md bg-primary px-4 text-sm text-white hover:bg-primary-hover"
                >
                  {t('common.retry')}
                </button>
              </div>
            ) : (queryViews[activeQuery.id] ?? 'list') === 'board' ? (
              <WorkItemBoard
                items={visibleQueryState.cache[activeQuery.id] ?? []}
                onMove={(item, toState) =>
                  setPendingMove({ queryId: activeQuery.id, item, toState })
                }
                onAssignToAi={
                  features.sharedAgent ? (item) => setDiscussionItem(item) : undefined
                }
              />
            ) : (queryViews[activeQuery.id] ?? 'list') === 'wbs' ? (
              <WorkItemWbs items={visibleQueryState.cache[activeQuery.id] ?? []} />
            ) : (
              <WorkItemList items={visibleQueryState.cache[activeQuery.id] ?? []} />
            )
          ) : adoError ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2">
              <XCircle size={28} className="text-danger" />
              <div className="text-sm text-danger">{adoError}</div>
              <button
                onClick={() => void refresh()}
                className="mt-1 h-8 rounded-md bg-primary px-4 text-sm text-white hover:bg-primary-hover"
              >
                {t('common.retry')}
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
          </div>
        </main>
      ) : (
        <main className="flex min-w-0 flex-1 overflow-hidden bg-surface-3">
          {/* -------- 主区：待处理队列 -------- */}
          <div className="flex min-w-0 flex-1 flex-col overflow-y-auto px-7 py-6">
            <header className="flex shrink-0 items-start justify-between pb-5">
              <div>
                <h1 className="text-xl font-bold text-ink">
                  {displayName
                    ? t('workbench.overview.greetingNamed', { greeting, name: displayName })
                    : greeting}
                </h1>
                <p className="mt-1 text-sm text-ink-3">
                  {queueSummary(queue)}
                  {unreadTotal > 0 && (
                    <button
                      onClick={() => setModule('messages')}
                      className="ml-2 text-primary hover:underline"
                    >
                      {tp(unreadTotal, 'workbench.overview.unreadMessagesOne', 'workbench.overview.unreadMessagesOther', {
                        count: unreadTotal,
                      })}
                    </button>
                  )}
                </p>
              </div>
              {refreshBar}
            </header>

            {connected && adoError && (
              <div className="mb-4 flex items-center gap-2 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">
                <XCircle size={14} className="shrink-0" />
                <span className="min-w-0 flex-1">{t('workbench.overview.adoErrorPrefix', { error: adoError })}</span>
                <button onClick={() => void refresh()} className="shrink-0 hover:underline">
                  {t('common.retry')}
                </button>
              </div>
            )}

            {connected && (
              <div className="mb-5 grid shrink-0 grid-cols-2 gap-3 lg:grid-cols-4">
                <div className="rounded-2xl border border-line bg-surface-4 px-4 py-3 shadow-raise">
                  <div className="text-xs text-ink-3">{t('workbench.overview.card.pendingQueue')}</div>
                  <div className="mt-1 text-lg font-semibold text-ink">{queue.length}</div>
                </div>
                <button
                  type="button"
                  onClick={() => setTab('workitems')}
                  className="rounded-2xl border border-line bg-surface-4 px-4 py-3 text-left shadow-raise transition hover:border-primary/40 hover:shadow-card"
                >
                  <div className="text-xs text-ink-3">{t('workbench.overview.card.workItems')}</div>
                  <div className="mt-1 text-lg font-semibold text-ink">{workItems.length}</div>
                </button>
                <button
                  type="button"
                  onClick={() => setTab('prs')}
                  className="rounded-2xl border border-line bg-surface-4 px-4 py-3 text-left shadow-raise transition hover:border-primary/40 hover:shadow-card"
                >
                  <div className="text-xs text-ink-3">{t('workbench.overview.card.pullRequests')}</div>
                  <div className="mt-1 text-lg font-semibold text-ink">{reviewPrs.length + myPrs.length}</div>
                </button>
                <button
                  type="button"
                  onClick={() => setTab('builds')}
                  className="rounded-2xl border border-line bg-surface-4 px-4 py-3 text-left shadow-raise transition hover:border-primary/40 hover:shadow-card"
                >
                  <div className="text-xs text-ink-3">{t('workbench.overview.card.builds')}</div>
                  <div className="mt-1 text-lg font-semibold text-ink">{builds.length}</div>
                </button>
              </div>
            )}

            {connected && loading && !lastRefresh ? (
              <SkeletonRows rows={6} />
            ) : queue.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center text-center">
                <div className="flex flex-col items-center gap-2.5 rounded-2xl border border-line-soft bg-surface-2/60 px-10 py-8 shadow-raise">
                  <CheckCircle2 size={32} className="text-success" />
                  <div className="text-sm font-medium text-ink-2">{t('workbench.overview.emptyQueueTitle')}</div>
                  <div className="max-w-sm text-xs leading-relaxed text-ink-3">
                    {t('workbench.overview.emptyQueueDesc')}
                  </div>
                </div>
              </div>
            ) : (
              <div className="overflow-hidden rounded-2xl border border-line bg-surface-4 shadow-card">
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
                  {t('workbench.overview.footerWorkItems', { count: workItems.length })}
                </button>
                <button onClick={() => setTab('prs')} className="hover:text-primary">
                  {t('workbench.overview.footerPullRequests', { count: reviewPrs.length + myPrs.length })}
                </button>
                <button onClick={() => setTab('builds')} className="hover:text-primary">
                  {t('workbench.overview.footerBuilds', { count: builds.length })}
                </button>
              </div>
            ) : (
              <button
                onClick={() => setModule('settings')}
                className="mt-4 flex shrink-0 items-center justify-center gap-2 rounded-lg border border-dashed border-line py-3 text-xs text-ink-3 transition hover:border-primary hover:text-primary"
              >
                <Wrench size={14} />
                {t('workbench.overview.connectAdoBanner')}
              </button>
            )}
          </div>

          {/* -------- 右栏：日程 + 收藏 -------- */}
          <aside className="flex w-[288px] shrink-0 flex-col gap-5 overflow-y-auto border-l border-line bg-surface-2/50 px-4 py-6">
            <section>
              <div className="flex items-center justify-between pb-2">
                <div className="flex items-center gap-2">
                  <Calendar size={14} className="text-primary" />
                  <span className="text-sm font-semibold text-ink">{t('workbench.overview.todaySchedule')}</span>
                </div>
                <button
                  onClick={() => setModule('calendar')}
                  className="flex items-center gap-0.5 text-xs text-ink-3 transition hover:text-primary"
                >
                  {t('workbench.overview.calendarLink')}
                  <ChevronRight size={12} />
                </button>
              </div>
              {todayEvents.length === 0 ? (
                <div className="py-2 text-xs text-ink-3">{t('workbench.overview.noEventsToday')}</div>
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
                        <span className="block text-xs text-ink-3">
                          {e.allDay
                            ? t('workbench.overview.allDay')
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
                  <Bookmark size={14} className="text-primary" />
                  <span className="text-sm font-semibold text-ink">{t('workbench.overview.favorites')}</span>
                </div>
                <button
                  onClick={() => setFavDialog({})}
                  className="flex h-6 w-6 items-center justify-center rounded text-ink-3 transition hover:bg-fill-hover hover:text-primary"
                  title={t('workbench.favoriteDialog.addTitle')}
                >
                  <Plus size={14} />
                </button>
              </div>

              {favorites.length === 0 ? (
                <button
                  onClick={() => setFavDialog({})}
                  className="w-full rounded-lg border border-dashed border-line py-3 text-xs text-ink-3 transition hover:border-primary hover:text-primary"
                >
                  {t('workbench.overview.addFavoritePrompt')}
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
                      <span className="w-full truncate text-center text-xs text-ink">
                        {fav.title}
                      </span>

                      <div className="absolute top-1 right-1 flex gap-0.5 opacity-0 transition group-hover:opacity-100">
                        <button
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setFavDialog({ existing: fav });
                          }}
                          title={t('common.edit')}
                          aria-label={t('common.edit')}
                          className="flex h-5 w-5 items-center justify-center rounded bg-surface-4/80 text-ink-3 hover:text-primary"
                        >
                          <Pencil size={12} />
                        </button>
                        <button
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            removeFav(fav.id);
                            toast.success(t('workbench.toast.deleted'));
                          }}
                          title={t('common.delete')}
                          aria-label={t('common.delete')}
                          className="flex h-5 w-5 items-center justify-center rounded bg-surface-4/80 text-ink-3 hover:text-danger"
                        >
                          <Trash2 size={12} />
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
      {pendingMove && (
        <ConfirmDialog
          title={t('workbench.board.confirmMoveTitle')}
          danger={false}
          message={t('workbench.board.confirmMoveMessage', {
            id: pendingMove.item.id,
            title: pendingMove.item.title,
            from: pendingMove.item.state,
            to: pendingMove.toState,
          })}
          confirmLabel={t('workbench.board.confirmMoveButton')}
          onConfirm={() => void applyMove()}
          onClose={() => setPendingMove(null)}
        />
      )}
      {queryDialog && (
        <QueryDialog
          adoBase={queryAdoBase}
          onClose={() => setQueryDialog(false)}
          onSave={(name, parsed) => {
            const id = addQuery(
              queryConnectionScope,
              name,
              parsed.url,
              parsed.queryId,
              parsed.project,
            );
            setQueryDialog(false);
            setTab(`query:${id}`);
            toast.success(t('workbench.toast.queryAdded'));
          }}
        />
      )}
      {discussionItem && (
        <CreateWorkItemDiscussionDialog item={discussionItem} onClose={() => setDiscussionItem(null)} />
      )}
    </div>
  );
}
