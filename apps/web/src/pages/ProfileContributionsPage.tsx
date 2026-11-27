import { useEffect, useMemo } from 'react';
import {
  AlertTriangle,
  CalendarDays,
  ExternalLink,
  GitPullRequest,
  RefreshCw,
  X,
} from 'lucide-react';
import ContributionHeatmap from '../components/ContributionHeatmap';
import { useI18n, useT, type ResolvedLocale } from '../i18n';
import { formatDate, formatDateTime, formatNumber } from '../i18n/format';
import {
  type ContributionEvent,
  type ContributionSourceStatus,
} from '../lib/adoContributions';
import { useProfileContributions } from '../stores/profileContributions';
import { useWorkbench } from '../stores/workbench';

const AUTO_LOAD_DELAY_MS = 200;

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length > 1) return `${parts[0][0]}${parts.at(-1)?.[0] ?? ''}`.toUpperCase();
  return (name.trim().slice(0, 2) || '?').toUpperCase();
}

function formatContributionTime(value: string, locale: ResolvedLocale): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return formatDateTime(
    date,
    {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    },
    locale,
  );
}

function SourceWarnings({ statuses }: { statuses: ContributionSourceStatus[] }) {
  const t = useT();
  const warnings = statuses.filter((status) => status.state !== 'complete');
  if (warnings.length === 0) return null;
  return (
    <div className="space-y-2" aria-label={t('pages.contributions.coverageAria')}>
      {warnings.map((status) => (
        <div
          key={status.type}
          className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-ink-2"
        >
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
          <p>
            <span className="font-medium text-ink">
              {t(status.state === 'unavailable' ? 'pages.contributions.prUnavailableLabel' : 'pages.contributions.prPartialLabel')}
            </span>{' '}
            {status.warnings.join(t('pages.contributions.warningSeparator')) || t('pages.contributions.partialFallback')}
          </p>
        </div>
      ))}
    </div>
  );
}

function DayDetails({ day, events, onClose }: { day: string; events: ContributionEvent[]; onClose: () => void }) {
  const { t, tp, locale } = useI18n();
  const dateLabel = formatDate(
    new Date(`${day}T12:00:00`),
    {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      weekday: 'short',
    },
    locale,
  );

  return (
    <section className="rounded-xl border border-line bg-surface-3" aria-label={t('pages.contributions.dayDetailsAria', { date: dateLabel })}>
      <header className="flex items-center justify-between border-b border-line px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">{dateLabel}</h2>
          <p className="mt-0.5 text-xs text-ink-3">
            {tp(events.length, 'pages.contributions.dayActivityCountOne', 'pages.contributions.dayActivityCountOther')}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('pages.contributions.closeDayDetailsAria')}
          className="rounded-md p-1.5 text-ink-3 hover:bg-fill-hover hover:text-ink"
        >
          <X size={16} />
        </button>
      </header>
      {events.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-ink-3">{t('pages.contributions.emptyDay')}</p>
      ) : (
        <ul className="divide-y divide-line">
          {events.map((event) => {
            return (
              <li key={event.id}>
                <a
                  href={event.url}
                  target="_blank"
                  rel="noreferrer"
                  className="group flex items-start gap-3 px-4 py-3 hover:bg-fill-2 focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-primary"
                >
                  <span className="mt-0.5 rounded-md bg-primary-light p-1.5 text-primary">
                    <GitPullRequest size={15} aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="text-xs font-medium text-primary">{t('pages.contributions.prCreated')}</span>
                      <time className="text-xs text-ink-3" dateTime={event.occurredAt}>
                        {formatContributionTime(event.occurredAt, locale)}
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
  const { t, locale } = useI18n();
  const identity = useProfileContributions((state) => state.identity);
  const events = useProfileContributions((state) => state.events);
  const statuses = useProfileContributions((state) => state.statuses);
  const loading = useProfileContributions((state) => state.loading);
  const error = useProfileContributions((state) => state.error);
  const lastUpdated = useProfileContributions((state) => state.lastUpdated);
  const range = useProfileContributions((state) => state.range);
  const filters = useProfileContributions((state) => state.filters);
  const projects = useProfileContributions((state) => state.projects);
  const selectedDay = useProfileContributions((state) => state.selectedDay);
  const load = useProfileContributions((state) => state.load);
  const setRange = useProfileContributions((state) => state.setRange);
  const setFilters = useProfileContributions((state) => state.setFilters);
  const selectDay = useProfileContributions((state) => state.selectDay);
  const cancel = useProfileContributions((state) => state.cancel);
  const configRevision = useWorkbench((state) => state.configRevision);

  const filterKey = filters.project ?? '';
  useEffect(() => {
    // 合并 Debug StrictMode 双挂载与连续筛选，避免发出无法中止的重复 NTLM 请求。
    const timer = window.setTimeout(() => void load(), AUTO_LOAD_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
      cancel();
    };
  }, [cancel, configRevision, filterKey, load, range.from, range.to]);

  const selectedEvents = useMemo(
    () =>
      selectedDay
        ? events
            .filter((event) => event.day === selectedDay)
            .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
        : [],
    [events, selectedDay],
  );
  const hasIncompleteCoverage = statuses.some((status) => status.state !== 'complete');

  return (
    <main className="h-full min-w-0 flex-1 overflow-y-auto bg-surface-2" aria-label={t('pages.contributions.overviewAria')}>
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
                {identity?.displayName || t('pages.contributions.overviewTitle')}
              </h1>
              <p className="truncate text-sm text-ink-3">
                {identity?.account || t('pages.contributions.accountFallback')}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 md:text-right">
            <div>
              <p className="text-2xl font-semibold tabular-nums text-ink">{formatNumber(events.length, undefined, locale)}</p>
              <p className="text-xs text-ink-3">
                {t(hasIncompleteCoverage ? 'pages.contributions.countPartialLabel' : 'pages.contributions.countCompleteLabel')}
              </p>
            </div>
            {loading ? (
              <button
                type="button"
                onClick={cancel}
                className="h-9 rounded-md border border-line px-3 text-sm text-ink-2 hover:bg-fill-hover"
              >
                {t('pages.contributions.cancelLoading')}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void load({ force: true })}
                className="flex h-9 items-center gap-1.5 rounded-md border border-line px-3 text-sm text-ink-2 hover:bg-fill-hover"
              >
                <RefreshCw size={14} aria-hidden="true" />
                {t('common.refresh')}
              </button>
            )}
          </div>
        </header>

        <section className="grid gap-3 rounded-xl border border-line bg-surface-3 p-4 sm:grid-cols-3" aria-label={t('pages.contributions.filtersAria')}>
          <label className="text-xs font-medium text-ink-2">
            {t('pages.contributions.fromDate')}
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
            {t('pages.contributions.toDate')}
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
            {t('pages.contributions.project')}
            <select
              value={filters.project ?? ''}
              onChange={(event) => setFilters({ project: event.target.value || undefined })}
              className="mt-1 h-9 w-full rounded-md border border-line bg-surface-4 px-2 text-sm text-ink outline-none focus:border-primary"
            >
              <option value="">{t('pages.contributions.allProjects')}</option>
              {projects.map((project) => <option key={project} value={project}>{project}</option>)}
            </select>
          </label>
        </section>

        {error && (
          <div role="alert" className="rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
            {error}
          </div>
        )}
        <SourceWarnings statuses={statuses} />

        {statuses.length > 0 && (
          <section
            aria-label={t('pages.contributions.totalPrsAria')}
            className="grid grid-cols-2 gap-2 sm:grid-cols-3"
          >
            {statuses.map((status) => (
              <div key={status.type} className="rounded-lg border border-line bg-surface-3 px-3 py-2.5">
                <p className="text-lg font-semibold tabular-nums text-ink">
                  {status.state === 'complete'
                    ? formatNumber(status.count, undefined, locale)
                    : status.state === 'partial' && status.count > 0
                      ? `≥${status.count}`
                      : '—'}
                </p>
                <p className="truncate text-xs text-ink-3">{t('pages.contributions.prCreated')}</p>
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
              <span className="text-sm text-ink-2">{t('pages.contributions.loadingPrs')}</span>
            </div>
          )}
        </div>

        {!loading && !error && events.length === 0 && (
          <section className="rounded-xl border border-dashed border-line bg-surface-3 px-5 py-10 text-center">
            <CalendarDays size={28} className="mx-auto text-ink-3" aria-hidden="true" />
            <h2 className="mt-3 text-sm font-medium text-ink">{t('pages.contributions.emptyRangeTitle')}</h2>
            <p className="mt-1 text-xs text-ink-3">{t('pages.contributions.emptyRangeHint')}</p>
          </section>
        )}

        {selectedDay ? (
          <DayDetails day={selectedDay} events={selectedEvents} onClose={() => selectDay(null)} />
        ) : events.length > 0 ? (
          <p className="text-center text-xs text-ink-3">{t('pages.contributions.selectDayPrompt')}</p>
        ) : null}

        <footer className="pb-2 text-right text-xs text-ink-3">
          {lastUpdated
            ? t('pages.contributions.lastUpdated', {
                time: formatDateTime(
                  lastUpdated,
                  {
                    year: 'numeric',
                    month: 'numeric',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  },
                  locale,
                ),
              })
            : t('pages.contributions.notUpdatedYet')}
        </footer>
      </div>
    </main>
  );
}
