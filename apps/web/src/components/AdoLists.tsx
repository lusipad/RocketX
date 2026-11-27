import { useMemo, useState } from 'react';
import {
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  GitCompare,
  GitPullRequest,
  Loader2,
  MessageSquarePlus,
  MinusCircle,
  Search,
  XCircle,
  CalendarPlus,
} from 'lucide-react';
import { useI18n, useT, type MessageKey, type TranslateFn } from '../i18n';
import { compareLocaleText } from '../i18n/format';
import {
  isApproved,
  myPrsOf,
  reviewPrsOf,
  stateBadgeClass,
  VOTE_LABEL_KEYS,
  voteColor,
  type Build,
  type PullRequest,
  type WorkItem,
} from '../stores/workbench';
import { askButlerAboutPullRequests } from '../kernel/butler';
import CalendarEventDialog from './CalendarEventDialog';
import { todayKey } from '../stores/todos';
import { butlerComparePullRequestsPrompt } from '../lib/butlerPrompts';
import { fmtConvTime } from '../lib/format';
import { workItemTreeRows } from '../lib/workItemTree';
import { DEFAULT_WORK_ITEM_STATE_FILTER, useUI } from '../stores/ui';
import { runtimeFeatures } from '../lib/runtimeMode';
import { pinyinMatch, usePinyinReady } from '../lib/pinyin';
import CreateWorkItemDiscussionDialog from './CreateWorkItemDiscussionDialog';

export const TYPE_COLORS: Record<string, string> = {
  Bug: '#f54a45',
  Task: '#00b96b',
  'User Story': '#3370ff',
  'Product Backlog Item': '#3370ff',
  Requirement: '#3370ff',
  Feature: '#7f3bf5',
  Epic: '#ff8800',
  Issue: '#3370ff',
};

// 状态配色统一走 stateBadgeClass（中英文状态都认，中文 ADO 流程模板叫「活动/已解决/已关闭」）

/** 优先级：P1 最紧急，标红 */
function priorityStyle(p?: number): string {
  if (p === 1) return 'text-danger font-medium';
  if (p === 2) return 'text-warning';
  return 'text-ink-3';
}

function relTime(iso?: string): string {
  if (!iso) return '';
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? '' : fmtConvTime(ms);
}

function EmptyRow({ text }: { text: string }) {
  return <div className="py-12 text-center text-sm text-ink-3">{text}</div>;
}

/** 列表页通用的搜索框 + 计数 */
function ListHeader({
  keyword,
  onKeyword,
  placeholder,
  count,
  total,
  right,
}: {
  keyword: string;
  onKeyword: (v: string) => void;
  placeholder: string;
  count: number;
  total: number;
  right?: React.ReactNode;
}) {
  const { t, tp } = useI18n();
  return (
    <div className="flex items-center justify-between pb-3">
      <div className="flex h-9 w-80 items-center gap-2 rounded-md bg-fill-1 px-3">
        <Search size={14} className="text-ink-3" />
        <input
          value={keyword}
          onChange={(e) => onKeyword(e.target.value)}
          placeholder={placeholder}
          className="w-full bg-transparent text-sm outline-none placeholder:text-ink-3"
        />
      </div>
      <div className="flex items-center gap-3">
        {right}
        <span className="text-xs text-ink-3">
          {keyword
            ? t('workbench.list.matchedCount', { count, total })
            : tp(total, 'workbench.list.totalCountOne', 'workbench.list.totalCountOther', { count: total })}
        </span>
      </div>
    </div>
  );
}

/** 我的工作项：完整列表（类型、状态、优先级、负责人、更新时间都显示出来） */
export function WorkItemList({ items }: { items: WorkItem[] }) {
  const { t, locale } = useI18n();
  const pinyinReady = usePinyinReady();
  const features = runtimeFeatures();
  const [keyword, setKeyword] = useState('');
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set());
  const [discussionItem, setDiscussionItem] = useState<WorkItem | null>(null);
  const [calendarItem, setCalendarItem] = useState<WorkItem | null>(null);
  const state = useUI((s) => s.workItemStateFilter);
  const setState = useUI((s) => s.setWorkItemStateFilter);

  const states = useMemo(
    () => Array.from(new Set(items.map((w) => w.state))).sort((a, b) => compareLocaleText(a, b, locale)),
    [items, locale],
  );
  const stateOptions = useMemo(
    () => [
      DEFAULT_WORK_ITEM_STATE_FILTER,
      '全部',
      ...Array.from(
        new Set(
          state === DEFAULT_WORK_ITEM_STATE_FILTER || state === '全部'
            ? states
            : [state, ...states],
        ),
      ),
    ],
    [state, states],
  );

  const effectiveState = state;

  const matched = useMemo(() => {
    const q = keyword.trim().toLowerCase();
    return items.filter(
      (w) =>
        workItemMatchesFilter(w.state, effectiveState) &&
        (!q || pinyinMatch(q, w.title) || String(w.id).includes(q)),
    );
  }, [items, keyword, effectiveState, pinyinReady]);
  const filtering =
    (effectiveState !== DEFAULT_WORK_ITEM_STATE_FILTER && effectiveState !== '全部') ||
    keyword.trim() !== '';
  const rows = useMemo(
    () => workItemTreeRows(items, new Set(matched.map((item) => item.id)), collapsed, filtering),
    [items, matched, collapsed, filtering],
  );

  const toggleCollapsed = (id: number) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <>
      <ListHeader
        keyword={keyword}
        onKeyword={setKeyword}
        placeholder={t('workbench.workItemList.searchPlaceholder')}
        count={matched.length}
        total={items.length}
        right={
          <div className="relative">
            <select
              value={effectiveState}
              onChange={(e) => setState(e.target.value)}
              className="h-8 appearance-none rounded-xl border border-line bg-surface-4 pr-7 pl-3 text-xs text-ink shadow-raise outline-none focus:border-primary"
            >
              {stateOptions.map((s) => (
                <option key={s} value={s}>
                  {stateFilterLabel(s, t)}
                </option>
              ))}
            </select>
            <ChevronDown
              size={12}
              className="pointer-events-none absolute top-2.5 right-2 text-ink-3"
            />
          </div>
        }
      />

      <div className="flex-1 overflow-y-auto rounded-2xl border border-line bg-surface-4 shadow-card">
        {rows.map(({ item: w, depth, hasChildren }) => {
          const isCollapsed = collapsed.has(w.id) && !filtering;
          return (
            <div
              key={w.id}
              className="group flex items-center border-b border-line-soft transition last:border-b-0 hover:bg-surface-hover"
            >
              <span
                className="flex h-full shrink-0 items-center"
                style={{ paddingLeft: `${12 + depth * 20}px` }}
              >
                {hasChildren ? (
                  <button
                    type="button"
                    onClick={() => toggleCollapsed(w.id)}
                    className="flex h-7 w-7 items-center justify-center rounded text-ink-3 hover:bg-fill-3 hover:text-ink"
                    title={isCollapsed ? t('workbench.tree.expandChildren') : t('workbench.tree.collapseChildren')}
                    aria-label={isCollapsed
                      ? t('workbench.tree.expandWorkItemAria', { id: w.id })
                      : t('workbench.tree.collapseWorkItemAria', { id: w.id })}
                  >
                    {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                  </button>
                ) : (
                  <span className="h-7 w-7" />
                )}
              </span>
              <a
                href={w.webUrl}
                target="_blank"
                rel="noreferrer"
                className="flex min-w-0 flex-1 items-center gap-3 py-2.5 pr-4"
              >
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ background: TYPE_COLORS[w.type] ?? '#8f959e' }}
                  title={w.type}
                />
                <span className="w-14 shrink-0 text-xs text-ink-3">#{w.id}</span>
                <span className="min-w-0 flex-1 truncate text-sm text-ink">{w.title}</span>

                <span className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${stateBadgeClass(w.state)}`}>
                  {w.state}
                </span>
                {w.priority !== undefined && (
                  <span className={`w-6 shrink-0 text-xs ${priorityStyle(w.priority)}`}>
                    P{w.priority}
                  </span>
                )}
                <span className="w-24 shrink-0 truncate text-xs text-ink-3" title={w.assignedTo}>
                  {w.assignedTo ?? t('workbench.common.unassigned')}
                </span>
                <span className="w-20 shrink-0 truncate text-right text-xs text-ink-3">
                  {w.project}
                </span>
                <span className="w-16 shrink-0 text-right text-xs text-ink-3">
                  {relTime(w.changedDate)}
                </span>
                <ExternalLink size={14} className="shrink-0 text-ink-3 opacity-0 group-hover:opacity-100" />
              </a>
              {features.sharedAgent ? (
                <button
                  type="button"
                  onClick={() => setDiscussionItem(w)}
                  title={t('workbench.workItemList.createDiscussionAria', { id: w.id })}
                  aria-label={t('workbench.workItemList.createDiscussionAria', { id: w.id })}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-ink-3 opacity-60 transition hover:bg-primary-light hover:text-primary md:opacity-0 md:group-hover:opacity-100 focus:opacity-100"
                >
                  <MessageSquarePlus size={14} />
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => setCalendarItem(w)}
                title={t('workbench.workItemList.scheduleInCalendarAria', { id: w.id })}
                aria-label={t('workbench.workItemList.scheduleInCalendarAria', { id: w.id })}
                className="mr-3 flex h-8 w-8 shrink-0 items-center justify-center rounded text-ink-3 opacity-60 transition hover:bg-primary-light hover:text-primary md:opacity-0 md:group-hover:opacity-100 focus:opacity-100"
              >
                <CalendarPlus size={14} />
              </button>
            </div>
          );
        })}
        {matched.length === 0 && (
          <EmptyRow text={items.length ? t('workbench.workItemList.noMatch') : t('workbench.workItemList.empty')} />
        )}
      </div>
      {features.sharedAgent && discussionItem ? (
        <CreateWorkItemDiscussionDialog item={discussionItem} onClose={() => setDiscussionItem(null)} />
      ) : null}
      {calendarItem ? (
        <CalendarEventDialog
          defaultDate={todayKey()}
          defaultTitle={`#${calendarItem.id} ${calendarItem.title}`}
          origin={{
            kind: 'work-item',
            id: String(calendarItem.id),
            label: t('workbench.workItemList.calendarOriginLabel', { id: calendarItem.id }),
            ...(calendarItem.project ? { project: calendarItem.project } : {}),
            ...(calendarItem.webUrl ? { webUrl: calendarItem.webUrl } : {}),
          }}
          onClose={() => setCalendarItem(null)}
        />
      ) : null}
    </>
  );
}

function workItemMatchesFilter(state: string, filter: string): boolean {
  if (filter === '全部') return true;
  if (filter === DEFAULT_WORK_ITEM_STATE_FILTER) return !isDefaultHiddenState(state);
  return state === filter;
}

function stateFilterLabel(filter: string, t: TranslateFn): string {
  if (filter === DEFAULT_WORK_ITEM_STATE_FILTER) return t('workbench.workItemList.filterDefault');
  if (filter === '全部') return t('workbench.workItemList.filterAll');
  return filter;
}

function isDefaultHiddenState(state: string): boolean {
  const normalized = state.trim().toLowerCase();
  return normalized === '搁置' || normalized === '已搁置' || normalized === 'shelved' || normalized === 'on hold';
}

function PrRow({
  pr,
  onAsk,
  onCompare,
  onSchedule,
  comparing,
}: {
  pr: PullRequest;
  onAsk: (pr: PullRequest) => void;
  onCompare: (pr: PullRequest) => void;
  onSchedule: (pr: PullRequest) => void;
  comparing: boolean;
}) {
  const t = useT();
  const approved = isApproved(pr);
  const features = runtimeFeatures();
  return (
    <div className={`group flex items-center border-b border-line last:border-b-0 hover:bg-fill-2 ${
      comparing ? 'bg-primary-light/20' : ''
    }`}>
      <a
        href={pr.webUrl}
        target="_blank"
        rel="noreferrer"
        title={t('workbench.pr.openInAdoAria', { id: pr.id })}
        aria-label={t('workbench.pr.openInAdoAria', { id: pr.id })}
        className="flex min-w-0 flex-1 items-center gap-3 px-4 py-2.5 text-left"
      >
        <GitPullRequest
          size={14}
          className={`shrink-0 ${approved ? 'text-success' : 'text-[#7f3bf5]'}`}
        />
        <span className="w-12 shrink-0 text-xs text-ink-3">!{pr.id}</span>

        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-ink">{pr.title}</span>
          <span className="mt-0.5 block truncate text-xs text-ink-3">
            {pr.repo} · {pr.sourceBranch} → {pr.targetBranch} · {pr.creator}
          </span>
        </span>

        {/* 评审人投票：这是「这个 PR 现在卡在谁那儿」的唯一线索 */}
        <span className="flex w-40 shrink-0 flex-wrap justify-end gap-1">
          {pr.reviewers.slice(0, 3).map((r) => (
            <span
              key={r.unique || r.name}
              className={`text-xs ${voteColor(r.vote)}`}
              title={t('workbench.pr.reviewerVoteTitle', {
                name: r.name,
                vote: t(VOTE_LABEL_KEYS[r.vote] ?? 'workbench.vote.unknown'),
              })}
            >
              {r.name.slice(0, 4)}
              {r.vote >= 5 ? ' ✓' : r.vote <= -5 ? ' ✕' : ' ·'}
            </span>
          ))}
          {pr.reviewers.length === 0 && (
            <span className="text-xs text-ink-3">{t('workbench.pr.noReviewers')}</span>
          )}
        </span>

        <span className="w-16 shrink-0 text-right text-xs text-ink-3">
          {relTime(pr.createdDate)}
        </span>
        <ExternalLink
          size={14}
          className="shrink-0 text-ink-3 opacity-0 transition group-hover:opacity-100"
          aria-hidden="true"
        />
      </a>
      <button
        type="button"
        onClick={() => onAsk(pr)}
        disabled={!features.butler}
        title={features.butler ? t('workbench.pr.aiReviewTitle') : t('workbench.pr.aiReviewDisabledTitle')}
        aria-label={t('workbench.pr.aiReviewAria', { id: pr.id, title: pr.title })}
        className="flex h-7 shrink-0 items-center gap-1 rounded-md bg-primary-light px-2 text-xs font-medium text-primary disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Bot size={13} aria-hidden="true" />
        {t('workbench.pr.aiReviewButton')}
      </button>
      <button
        type="button"
        onClick={() => onCompare(pr)}
        title={comparing ? t('workbench.pr.deselectCompare') : t('workbench.pr.selectCompare')}
        aria-label={comparing ? t('workbench.pr.deselectCompare') : t('workbench.pr.selectCompare')}
        aria-pressed={comparing}
        className={`shrink-0 rounded-md p-1.5 hover:bg-fill-hover hover:text-ink focus:opacity-100 ${
          comparing
            ? 'text-primary'
            : 'text-ink-3 md:opacity-0 md:group-hover:opacity-100'
        }`}
      >
        <GitCompare size={14} />
      </button>
      <button
        type="button"
        onClick={() => onSchedule(pr)}
        title={t('workbench.pr.scheduleInCalendarAria', { id: pr.id })}
        aria-label={t('workbench.pr.scheduleInCalendarAria', { id: pr.id })}
        className="mr-3 shrink-0 rounded-md p-1.5 text-ink-3 hover:bg-fill-hover hover:text-ink focus:opacity-100 md:opacity-0 md:group-hover:opacity-100"
      >
        <CalendarPlus size={14} />
      </button>
    </div>
  );
}

/** 拉取请求：待我评审 / 我提的（后者以前拉了数据却根本没渲染） */
export function PullRequestList({ prs, account }: { prs: PullRequest[]; account: string }) {
  const { t, tp } = useI18n();
  const pinyinReady = usePinyinReady();
  const [keyword, setKeyword] = useState('');
  // 子 tab 提到全局 store：切到别的页面再回来不重置（issue #7/#17 同一诉求）
  const tab = useUI((s) => s.prTab);
  const setTab = useUI((s) => s.setPrTab);

  const review = useMemo(() => reviewPrsOf(prs, account), [prs, account]);
  const mine = useMemo(() => myPrsOf(prs, account), [prs, account]);
  const source = tab === 'review' ? review : mine;

  // 比较态放在 PullRequestList 而不是子列表：切「待我评审 / 我提的」时组件不卸载，
  // 于是可以跨子 tab 选两个 PR 来比较。
  const [comparing, setComparing] = useState<PullRequest[]>([]);
  const [calendarPr, setCalendarPr] = useState<PullRequest | null>(null);

  const askButler = (pr: PullRequest): void => {
    askButlerAboutPullRequests(
      [pr],
      t('workbench.pr.aiReviewPrompt', { id: pr.id }),
    );
  };

  const toggleCompare = (pr: PullRequest): void => {
    const already = comparing.some((item) => item.id === pr.id);
    if (already) {
      setComparing(comparing.filter((item) => item.id !== pr.id));
      return;
    }
    const next = [...comparing, pr];
    if (next.length < 2) {
      setComparing(next);
      return;
    }
    const [first, second] = next;
    askButlerAboutPullRequests(
      next,
      butlerComparePullRequestsPrompt(first.id, second.id),
    );
    setComparing([]);
  };

  const filtered = useMemo(() => {
    const q = keyword.trim().toLowerCase();
    if (!q) return source;
    return source.filter(
      (pr) =>
        pinyinMatch(q, pr.title, pr.repo) ||
        String(pr.id).includes(q),
    );
  }, [source, keyword, pinyinReady]);

  const approvedMineCount = useMemo(() => mine.filter(isApproved).length, [mine]);

  return (
    <>
      <div className="flex items-center gap-1 pb-3">
        {(
          [
            { key: 'review' as const, labelKey: 'workbench.pr.tab.review' as const, n: review.length },
            { key: 'mine' as const, labelKey: 'workbench.pr.tab.mine' as const, n: mine.length },
          ]
        ).map((item) => (
          <button
            key={item.key}
            onClick={() => setTab(item.key)}
            className={`flex h-8 items-center gap-1.5 rounded-md px-3 text-sm transition ${
              tab === item.key
                ? 'bg-primary-light font-medium text-primary'
                : 'text-ink-2 hover:bg-fill-hover'
            }`}
          >
            {t(item.labelKey)}
            <span className="text-xs text-ink-3">{item.n}</span>
          </button>
        ))}
      </div>

      {comparing.length === 1 && (
        <div className="mb-2 flex items-center justify-between rounded-md border border-primary/30 bg-primary-light/20 px-3 py-1.5 text-xs text-ink-2">
          <span>
            {t('workbench.pr.selectedLabel')}{' '}
            <span className="font-medium text-ink">!{comparing[0].id}</span> {comparing[0].title}
            <span className="ml-2 text-ink-3">{t('workbench.pr.selectSecondHint')}</span>
          </span>
          <button
            type="button"
            onClick={() => setComparing([])}
            className="shrink-0 px-1.5 py-0.5 text-ink-3 hover:text-ink"
          >
            {t('common.cancel')}
          </button>
        </div>
      )}

      <ListHeader
        keyword={keyword}
        onKeyword={setKeyword}
        placeholder={t('workbench.pr.searchPlaceholder')}
        count={filtered.length}
        total={source.length}
        right={
          tab === 'mine' && approvedMineCount > 0 ? (
            <span className="flex items-center gap-1 text-xs text-success">
              <CheckCircle2 size={14} />
              {tp(approvedMineCount, 'workbench.pr.approvedCountOne', 'workbench.pr.approvedCountOther', {
                count: approvedMineCount,
              })}
            </span>
          ) : undefined
        }
      />

      <div className="flex-1 overflow-y-auto rounded-2xl border border-line bg-surface-4 shadow-card">
        {filtered.map((pr) => (
          <PrRow
            key={pr.id}
            pr={pr}
            onAsk={askButler}
            onCompare={toggleCompare}
            onSchedule={setCalendarPr}
            comparing={comparing.some((item) => item.id === pr.id)}
          />
        ))}
        {filtered.length === 0 && (
          <EmptyRow
            text={
              source.length
                ? t('workbench.pr.noMatch')
                : tab === 'review'
                  ? t('workbench.pr.emptyReview')
                  : t('workbench.pr.emptyMine')
            }
          />
        )}
      </div>
      {calendarPr ? (
        <CalendarEventDialog
          defaultDate={todayKey()}
          defaultTitle={`PR #${calendarPr.id} ${calendarPr.title}`}
          origin={{
            kind: 'pull-request',
            id: String(calendarPr.id),
            label: t('workbench.pr.calendarOriginLabel', { id: calendarPr.id }),
            ...(calendarPr.webUrl ? { webUrl: calendarPr.webUrl } : {}),
          }}
          onClose={() => setCalendarPr(null)}
        />
      ) : null}
    </>
  );
}

export function BuildStatusIcon({ build, size = 15 }: { build: Build; size?: number }) {
  if (build.status === 'inProgress' || build.status === 'notStarted') {
    return <Loader2 size={size} className="shrink-0 animate-spin text-primary" />;
  }
  if (build.result === 'succeeded') {
    return <CheckCircle2 size={size} className="shrink-0 text-success" />;
  }
  if (build.result === 'failed') return <XCircle size={size} className="shrink-0 text-danger" />;
  return <MinusCircle size={size} className="shrink-0 text-ink-3" />;
}

const BUILD_RESULT_LABEL_KEYS: Record<string, MessageKey> = {
  succeeded: 'workbench.build.result.succeeded',
  failed: 'workbench.build.result.failed',
  partiallySucceeded: 'workbench.build.result.partiallySucceeded',
  canceled: 'workbench.build.result.canceled',
};

export function matchesBuildKeyword(build: Build, keyword: string): boolean {
  const q = keyword.trim();
  if (!q) return true;
  return (
    pinyinMatch(q, build.definition, build.buildNumber, build.project) ||
    String(build.pullRequestId ?? '').includes(q)
  );
}

/** 构建：完整列表（构建号、项目、触发人、结果都显示） */
export function BuildList({ builds }: { builds: Build[] }) {
  const t = useT();
  const pinyinReady = usePinyinReady();
  const [keyword, setKeyword] = useState('');
  const failedOnly = useUI((s) => s.buildsFailedOnly);
  const setFailedOnly = useUI((s) => s.setBuildsFailedOnly);

  const filtered = useMemo(() => {
    return builds.filter(
      (b) => (!failedOnly || b.result === 'failed') && matchesBuildKeyword(b, keyword),
    );
  }, [builds, keyword, failedOnly, pinyinReady]);

  const failedCount = builds.filter((b) => b.result === 'failed').length;

  return (
    <>
      <ListHeader
        keyword={keyword}
        onKeyword={setKeyword}
        placeholder={t('workbench.build.searchPlaceholder')}
        count={filtered.length}
        total={builds.length}
        right={
          failedCount > 0 ? (
            <button
              onClick={() => setFailedOnly(!failedOnly)}
              className={`flex h-8 items-center gap-1.5 rounded-xl border px-3 text-xs shadow-raise transition ${
                failedOnly
                  ? 'border-danger bg-danger/10 text-danger'
                  : 'border-line bg-surface-4 text-ink-2 hover:bg-surface-hover'
              }`}
            >
              <XCircle size={14} />
              {t('workbench.build.failedOnly', { count: failedCount })}
            </button>
          ) : undefined
        }
      />

      <div className="flex-1 overflow-y-auto rounded-2xl border border-line bg-surface-4 shadow-card">
        {filtered.length > 0 && (
          <div className="flex items-center gap-3 border-b border-line bg-surface-2/50 px-4 py-2.5 text-xs font-medium text-ink-3">
            <span className="min-w-0 flex-1 pl-5">{t('workbench.build.col.build')}</span>
            <span className="w-24 shrink-0">{t('workbench.build.col.linkedPr')}</span>
            <span className="w-16 shrink-0 text-right">{t('workbench.build.col.status')}</span>
            <span className="w-16 shrink-0 text-right">{t('workbench.build.col.time')}</span>
            <span className="w-[14px] shrink-0" aria-hidden="true" />
          </div>
        )}
        {filtered.map((b) => (
          <div
            key={`${b.project}-${b.id}`}
            className="group flex items-center gap-3 border-b border-line-soft px-4 py-3 transition last:border-b-0 hover:bg-surface-hover"
          >
            <a
              href={b.webUrl}
              target="_blank"
              rel="noreferrer"
              className="flex min-w-0 flex-1 items-center gap-3"
            >
              <BuildStatusIcon build={b} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-ink">{b.definition}</span>
                <span className="mt-0.5 block truncate text-xs text-ink-3">
                  {b.buildNumber} · {b.project}
                  {b.requestedFor ? t('workbench.build.triggeredBySuffix', { user: b.requestedFor }) : ''}
                </span>
              </span>
            </a>
            <span className="w-24 shrink-0 text-xs text-ink-2">
              {b.pullRequestId && b.pullRequestUrl ? (
                <a
                  href={b.pullRequestUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  PR #{b.pullRequestId}
                </a>
              ) : b.pullRequestId ? (
                `PR #${b.pullRequestId}`
              ) : (
                '—'
              )}
            </span>
            <span
              className={`w-16 shrink-0 text-right text-xs ${
                b.result === 'failed'
                  ? 'text-danger'
                  : b.result === 'succeeded'
                    ? 'text-success'
                    : 'text-ink-3'
              }`}
            >
              {b.status === 'inProgress' || b.status === 'notStarted'
                ? t('workbench.build.inProgress')
                : BUILD_RESULT_LABEL_KEYS[b.result]
                  ? t(BUILD_RESULT_LABEL_KEYS[b.result])
                  : b.result}
            </span>
            <span className="w-16 shrink-0 text-right text-xs text-ink-3">
              {relTime(b.finishTime || b.queueTime)}
            </span>
            <a href={b.webUrl} target="_blank" rel="noreferrer" className="shrink-0">
              <ExternalLink size={14} className="text-ink-3 opacity-0 group-hover:opacity-100" />
            </a>
          </div>
        ))}
        {filtered.length === 0 && (
          <EmptyRow text={builds.length ? t('workbench.build.noMatch') : t('workbench.build.empty')} />
        )}
      </div>
    </>
  );
}
