import { useEffect, useMemo } from 'react';
import {
  AlertTriangle,
  CalendarDays,
  ClipboardList,
  ExternalLink,
  GitCommitHorizontal,
  GitPullRequest,
  MessageSquare,
  RefreshCw,
  SquareActivity,
  X,
} from 'lucide-react';
import ContributionHeatmap from '../components/ContributionHeatmap';
import {
  type ContributionEvent,
  type ContributionEventType,
  type ContributionSourceStatus,
} from '../lib/adoContributions';
import { useProfileContributions } from '../stores/profileContributions';
import { useWorkbench } from '../stores/workbench';

const EVENT_META: Record<
  ContributionEventType,
  { label: string; icon: typeof SquareActivity }
> = {
  commit: { label: '提交', icon: GitCommitHorizontal },
  'pull-request': { label: '创建 PR', icon: GitPullRequest },
  'pull-request-review': { label: 'PR 评审', icon: SquareActivity },
  'pull-request-comment': { label: 'PR 评论', icon: MessageSquare },
  'work-item': { label: '创建工作项', icon: ClipboardList },
  'work-item-comment': { label: '工作项评论', icon: MessageSquare },
};

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length > 1) return `${parts[0][0]}${parts.at(-1)?.[0] ?? ''}`.toUpperCase();
  return (name.trim().slice(0, 2) || '?').toUpperCase();
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function SourceWarnings({ statuses }: { statuses: ContributionSourceStatus[] }) {
  const warnings = statuses.filter((status) => !status.skipped && status.state !== 'complete');
  if (warnings.length === 0) return null;
  return (
    <div className="space-y-2" aria-label="数据覆盖说明">
      {warnings.map((status) => (
        <div
          key={status.type}
          className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-ink-2"
        >
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
          <p>
            <span className="font-medium text-ink">
              {EVENT_META[status.type].label}
              {status.state === 'unavailable' ? '不可用' : '仅部分覆盖'}：
            </span>{' '}
            {status.warnings.join('；') || '当前服务器或权限未能提供完整数据。'}
          </p>
        </div>
      ))}
    </div>
  );
}

function DayDetails({ day, events, onClose }: { day: string; events: ContributionEvent[]; onClose: () => void }) {
  const dateLabel = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  }).format(new Date(`${day}T12:00:00`));

  return (
    <section className="rounded-xl border border-line bg-surface-3" aria-label={`${dateLabel}的贡献明细`}>
      <header className="flex items-center justify-between border-b border-line px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">{dateLabel}</h2>
          <p className="mt-0.5 text-xs text-ink-3">{events.length} 项活动</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭日期明细"
          className="rounded-md p-1.5 text-ink-3 hover:bg-fill-hover hover:text-ink"
        >
          <X size={16} />
        </button>
      </header>
      {events.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-ink-3">这一天没有符合当前筛选的活动</p>
      ) : (
        <ul className="divide-y divide-line">
          {events.map((event) => {
            const meta = EVENT_META[event.type];
            const Icon = meta.icon;
            return (
              <li key={event.id}>
                <a
                  href={event.url}
                  target="_blank"
                  rel="noreferrer"
                  className="group flex items-start gap-3 px-4 py-3 hover:bg-fill-2 focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-primary"
                >
                  <span className="mt-0.5 rounded-md bg-primary-light p-1.5 text-primary">
                    <Icon size={15} aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="text-xs font-medium text-primary">{meta.label}</span>
                      <time className="text-xs text-ink-3" dateTime={event.occurredAt}>
                        {formatTime(event.occurredAt)}
                      </time>
                    </span>
                    <span className="mt-1 block text-sm font-medium text-ink">{event.title}</span>
                    {event.summary && (
                      <span className="mt-0.5 line-clamp-2 block text-xs text-ink-2">{event.summary}</span>
                    )}
                    <span className="mt-1 block truncate text-xs text-ink-3">
                      {event.project}
                      {event.repository ? ` / ${event.repository}` : ''}
                    </span>
                  </span>
                  <ExternalLink size={14} className="mt-1 shrink-0 text-ink-3 group-hover:text-primary" aria-hidden="true" />
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export default function ProfileContributionsPage() {
  const identity = useProfileContributions((state) => state.identity);
  const events = useProfileContributions((state) => state.events);
  const statuses = useProfileContributions((state) => state.statuses);
  const loading = useProfileContributions((state) => state.loading);
  const error = useProfileContributions((state) => state.error);
  const lastUpdated = useProfileContributions((state) => state.lastUpdated);
  const range = useProfileContributions((state) => state.range);
  const filters = useProfileContributions((state) => state.filters);
  const projects = useProfileContributions((state) => state.projects);
  const repositories = useProfileContributions((state) => state.repositories);
  const selectedDay = useProfileContributions((state) => state.selectedDay);
  const load = useProfileContributions((state) => state.load);
  const setRange = useProfileContributions((state) => state.setRange);
  const setFilters = useProfileContributions((state) => state.setFilters);
  const selectDay = useProfileContributions((state) => state.selectDay);
  const cancel = useProfileContributions((state) => state.cancel);
  const configRevision = useWorkbench((state) => state.configRevision);

  const filterKey = `${filters.project ?? ''}\0${filters.repository ?? ''}\0${filters.type ?? ''}`;
  useEffect(() => {
    // Debug 下 StrictMode 会先挂载再立即卸载；延后一个 task 可避免发出无法中止的重复 NTLM 请求。
    const timer = window.setTimeout(() => void load(), 0);
    return () => {
      window.clearTimeout(timer);
      cancel();
    };
  }, [cancel, configRevision, filterKey, load, range.from, range.to]);

  const visibleRepositories = useMemo(
    () => repositories.filter((repository) => !filters.project || repository.project === filters.project),
    [filters.project, repositories],
  );
  const selectedEvents = useMemo(
    () =>
      selectedDay
        ? events
            .filter((event) => event.day === selectedDay)
            .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
        : [],
    [events, selectedDay],
  );
  const visibleStatuses = statuses.filter((status) => !status.skipped);
  const hasIncompleteCoverage = visibleStatuses.some((status) => status.state !== 'complete');

  return (
    <main className="h-full overflow-y-auto bg-surface-2" aria-label="Azure DevOps 个人贡献">
      <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-4 px-5 py-5 lg:px-8">
        <header className="flex flex-col gap-4 rounded-xl border border-line bg-surface-3 p-5 md:flex-row md:items-center md:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            {identity?.imageUrl ? (
              <img
                src={identity.imageUrl}
                alt=""
                className="h-12 w-12 shrink-0 rounded-full bg-fill-1 object-cover"
              />
            ) : (
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-white">
                {initials(identity?.displayName || identity?.account || '')}
              </span>
            )}
            <div className="min-w-0">
              <h1 className="truncate text-lg font-semibold text-ink">
                {identity?.displayName || '个人贡献'}
              </h1>
              <p className="truncate text-sm text-ink-3">
                {identity?.account || 'Azure DevOps 个人活动'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 md:text-right">
            <div>
              <p className="text-2xl font-semibold tabular-nums text-ink">{events.length}</p>
              <p className="text-xs text-ink-3">
                {hasIncompleteCoverage ? '已读取的活动' : '当前范围内的活动'}
              </p>
            </div>
            {loading ? (
              <button
                type="button"
                onClick={cancel}
                className="h-9 rounded-md border border-line px-3 text-sm text-ink-2 hover:bg-fill-hover"
              >
                取消加载
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void load({ force: true })}
                className="flex h-9 items-center gap-1.5 rounded-md border border-line px-3 text-sm text-ink-2 hover:bg-fill-hover"
              >
                <RefreshCw size={14} aria-hidden="true" />
                刷新
              </button>
            )}
          </div>
        </header>

        <section className="grid gap-3 rounded-xl border border-line bg-surface-3 p-4 sm:grid-cols-2 lg:grid-cols-5" aria-label="贡献筛选">
          <label className="text-xs font-medium text-ink-2">
            开始日期
            <input
              type="date"
              value={range.from}
              max={range.to}
              onChange={(event) => {
                if (event.target.value) setRange({ ...range, from: event.target.value });
              }}
              className="mt-1 h-9 w-full rounded-md border border-line bg-surface-4 px-2 text-sm text-ink outline-none focus:border-primary"
            />
          </label>
          <label className="text-xs font-medium text-ink-2">
            结束日期
            <input
              type="date"
              value={range.to}
              min={range.from}
              onChange={(event) => {
                if (event.target.value) setRange({ ...range, to: event.target.value });
              }}
              className="mt-1 h-9 w-full rounded-md border border-line bg-surface-4 px-2 text-sm text-ink outline-none focus:border-primary"
            />
          </label>
          <label className="text-xs font-medium text-ink-2">
            项目
            <select
              value={filters.project ?? ''}
              onChange={(event) => setFilters({ project: event.target.value || undefined })}
              className="mt-1 h-9 w-full rounded-md border border-line bg-surface-4 px-2 text-sm text-ink outline-none focus:border-primary"
            >
              <option value="">全部项目</option>
              {projects.map((project) => <option key={project} value={project}>{project}</option>)}
            </select>
          </label>
          <label className="text-xs font-medium text-ink-2">
            仓库
            <select
              value={filters.repository ?? ''}
              onChange={(event) => setFilters({ repository: event.target.value || undefined })}
              className="mt-1 h-9 w-full rounded-md border border-line bg-surface-4 px-2 text-sm text-ink outline-none focus:border-primary"
            >
              <option value="">全部仓库</option>
              {visibleRepositories.map((repository) => (
                <option key={repository.id} value={repository.id}>
                  {filters.project ? repository.name : `${repository.project} / ${repository.name}`}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-medium text-ink-2">
            活动类型
            <select
              value={filters.type ?? ''}
              onChange={(event) => setFilters({ type: (event.target.value || undefined) as ContributionEventType | undefined })}
              className="mt-1 h-9 w-full rounded-md border border-line bg-surface-4 px-2 text-sm text-ink outline-none focus:border-primary"
            >
              <option value="">全部活动</option>
              {Object.entries(EVENT_META).map(([type, meta]) => <option key={type} value={type}>{meta.label}</option>)}
            </select>
          </label>
        </section>

        {error && (
          <div role="alert" className="rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
            {error}
          </div>
        )}
        <SourceWarnings statuses={statuses} />

        {visibleStatuses.length > 0 && (
          <section
            aria-label="各类活动总数"
            className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6"
          >
            {visibleStatuses.map((status) => (
              <div key={status.type} className="rounded-lg border border-line bg-surface-3 px-3 py-2.5">
                <p className="text-lg font-semibold tabular-nums text-ink">
                  {status.state === 'complete'
                    ? status.count
                    : status.state === 'partial' && status.count > 0
                      ? `≥${status.count}`
                      : '—'}
                </p>
                <p className="truncate text-xs text-ink-3">{EVENT_META[status.type].label}</p>
              </div>
            ))}
          </section>
        )}

        <div className="relative">
          <ContributionHeatmap
            events={events}
            range={range}
            selectedDay={selectedDay}
            onSelectDay={selectDay}
          />
          {loading && events.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-surface-3/80" role="status">
              <RefreshCw size={18} className="mr-2 animate-spin text-primary" aria-hidden="true" />
              <span className="text-sm text-ink-2">正在汇总 Azure DevOps 活动…</span>
            </div>
          )}
        </div>

        {!loading && !error && events.length === 0 && (
          <section className="rounded-xl border border-dashed border-line bg-surface-3 px-5 py-10 text-center">
            <CalendarDays size={28} className="mx-auto text-ink-3" aria-hidden="true" />
            <h2 className="mt-3 text-sm font-medium text-ink">当前范围内没有活动</h2>
            <p className="mt-1 text-xs text-ink-3">可以扩大日期范围或清除项目、仓库和活动类型筛选。</p>
          </section>
        )}

        {selectedDay ? (
          <DayDetails day={selectedDay} events={selectedEvents} onClose={() => selectDay(null)} />
        ) : events.length > 0 ? (
          <p className="text-center text-xs text-ink-3">选择热力图中的日期查看当天明细</p>
        ) : null}

        <footer className="pb-2 text-right text-xs text-ink-3">
          {lastUpdated ? `上次更新：${new Date(lastUpdated).toLocaleString('zh-CN')}` : '尚未完成更新'}
        </footer>
      </div>
    </main>
  );
}
