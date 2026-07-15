import { useMemo, useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  GitPullRequest,
  Loader2,
  MinusCircle,
  Search,
  XCircle,
} from 'lucide-react';
import {
  isApproved,
  myPrsOf,
  reviewPrsOf,
  stateBadgeClass,
  VOTE_LABELS,
  voteColor,
  type Build,
  type PullRequest,
  type WorkItem,
} from '../stores/workbench';
import { fmtConvTime } from '../lib/format';
import { useUI } from '../stores/ui';

export const TYPE_COLORS: Record<string, string> = {
  Bug: '#f54a45',
  Task: '#3370ff',
  'User Story': '#00b96b',
  Feature: '#7f3bf5',
  Epic: '#ff8800',
  Issue: '#ff8800',
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
  return (
    <div className="flex items-center justify-between pb-3">
      <div className="flex h-9 w-80 items-center gap-2 rounded-md bg-fill-1 px-3">
        <Search size={15} className="text-ink-3" />
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
          {keyword ? `匹配 ${count} / ${total}` : `共 ${total} 项`}
        </span>
      </div>
    </div>
  );
}

/** 我的工作项：完整列表（类型、状态、优先级、负责人、更新时间都显示出来） */
export function WorkItemList({ items }: { items: WorkItem[] }) {
  const [keyword, setKeyword] = useState('');
  const state = useUI((s) => s.workItemStateFilter);
  const setState = useUI((s) => s.setWorkItemStateFilter);

  const states = useMemo(
    () => ['全部', ...Array.from(new Set(items.map((w) => w.state))).sort()],
    [items],
  );

  const effectiveState = states.includes(state) ? state : '全部';

  const filtered = useMemo(() => {
    const q = keyword.trim().toLowerCase();
    return items.filter(
      (w) =>
        (effectiveState === '全部' || w.state === effectiveState) &&
        (!q || w.title.toLowerCase().includes(q) || String(w.id).includes(q)),
    );
  }, [items, keyword, effectiveState]);

  return (
    <>
      <ListHeader
        keyword={keyword}
        onKeyword={setKeyword}
        placeholder="搜索标题或 #编号"
        count={filtered.length}
        total={items.length}
        right={
          <div className="relative">
            <select
              value={effectiveState}
              onChange={(e) => setState(e.target.value)}
              className="h-8 appearance-none rounded-md border border-line bg-surface-4 pr-7 pl-2.5 text-xs text-ink outline-none focus:border-primary"
            >
              {states.map((s) => (
                <option key={s} value={s}>
                  {s === '全部' ? '全部状态' : s}
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

      <div className="flex-1 overflow-y-auto rounded-lg border border-line bg-surface-4">
        {filtered.map((w) => (
          <a
            key={w.id}
            href={w.webUrl}
            target="_blank"
            rel="noreferrer"
            className="group flex items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0 hover:bg-fill-2"
          >
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ background: TYPE_COLORS[w.type] ?? '#8f959e' }}
              title={w.type}
            />
            <span className="w-14 shrink-0 text-xs text-ink-3">#{w.id}</span>
            <span className="min-w-0 flex-1 truncate text-sm text-ink">{w.title}</span>

            <span className={`shrink-0 rounded px-1.5 py-0.5 text-2xs ${stateBadgeClass(w.state)}`}>
              {w.state}
            </span>
            {w.priority !== undefined && (
              <span className={`w-6 shrink-0 text-2xs ${priorityStyle(w.priority)}`}>
                P{w.priority}
              </span>
            )}
            <span className="w-24 shrink-0 truncate text-2xs text-ink-3" title={w.assignedTo}>
              {w.assignedTo ?? '未分配'}
            </span>
            <span className="w-20 shrink-0 truncate text-right text-2xs text-ink-3">
              {w.project}
            </span>
            <span className="w-16 shrink-0 text-right text-2xs text-ink-3">
              {relTime(w.changedDate)}
            </span>
            <ExternalLink size={13} className="shrink-0 text-ink-3 opacity-0 group-hover:opacity-100" />
          </a>
        ))}
        {filtered.length === 0 && (
          <EmptyRow text={items.length ? '没有匹配的工作项' : '当前没有分配给你的未关闭工作项'} />
        )}
      </div>
    </>
  );
}

function PrRow({ pr }: { pr: PullRequest }) {
  const approved = isApproved(pr);
  return (
    <a
      href={pr.webUrl}
      target="_blank"
      rel="noreferrer"
      className="group flex items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0 hover:bg-fill-2"
    >
      <GitPullRequest
        size={15}
        className={`shrink-0 ${approved ? 'text-success' : 'text-[#7f3bf5]'}`}
      />
      <span className="w-12 shrink-0 text-xs text-ink-3">!{pr.id}</span>

      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-ink">{pr.title}</span>
        <span className="mt-0.5 block truncate text-2xs text-ink-3">
          {pr.repo} · {pr.sourceBranch} → {pr.targetBranch} · {pr.creator}
        </span>
      </span>

      {/* 评审人投票：这是「这个 PR 现在卡在谁那儿」的唯一线索 */}
      <span className="flex w-40 shrink-0 flex-wrap justify-end gap-1">
        {pr.reviewers.slice(0, 3).map((r) => (
          <span
            key={r.unique || r.name}
            className={`text-2xs ${voteColor(r.vote)}`}
            title={`${r.name}：${VOTE_LABELS[r.vote] ?? '未知'}`}
          >
            {r.name.slice(0, 4)}
            {r.vote >= 5 ? ' ✓' : r.vote <= -5 ? ' ✕' : ' ·'}
          </span>
        ))}
        {pr.reviewers.length === 0 && <span className="text-2xs text-ink-3">无评审人</span>}
      </span>

      <span className="w-16 shrink-0 text-right text-2xs text-ink-3">
        {relTime(pr.createdDate)}
      </span>
      <ExternalLink size={13} className="shrink-0 text-ink-3 opacity-0 group-hover:opacity-100" />
    </a>
  );
}

/** 拉取请求：待我评审 / 我提的（后者以前拉了数据却根本没渲染） */
export function PullRequestList({ prs, account }: { prs: PullRequest[]; account: string }) {
  const [keyword, setKeyword] = useState('');
  // 子 tab 提到全局 store：切到别的页面再回来不重置（issue #7/#17 同一诉求）
  const tab = useUI((s) => s.prTab);
  const setTab = useUI((s) => s.setPrTab);

  const review = useMemo(() => reviewPrsOf(prs, account), [prs, account]);
  const mine = useMemo(() => myPrsOf(prs, account), [prs, account]);
  const source = tab === 'review' ? review : mine;

  const filtered = useMemo(() => {
    const q = keyword.trim().toLowerCase();
    if (!q) return source;
    return source.filter(
      (pr) =>
        pr.title.toLowerCase().includes(q) ||
        pr.repo.toLowerCase().includes(q) ||
        String(pr.id).includes(q),
    );
  }, [source, keyword]);

  return (
    <>
      <div className="flex items-center gap-1 pb-3">
        {(
          [
            { key: 'review' as const, label: '待我评审', n: review.length },
            { key: 'mine' as const, label: '我提的', n: mine.length },
          ]
        ).map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex h-8 items-center gap-1.5 rounded-md px-3 text-sm transition ${
              tab === t.key
                ? 'bg-primary-light font-medium text-primary'
                : 'text-ink-2 hover:bg-fill-hover'
            }`}
          >
            {t.label}
            <span className="text-xs text-ink-3">{t.n}</span>
          </button>
        ))}
      </div>

      <ListHeader
        keyword={keyword}
        onKeyword={setKeyword}
        placeholder="搜索标题、仓库或 !编号"
        count={filtered.length}
        total={source.length}
        right={
          tab === 'mine' && mine.some(isApproved) ? (
            <span className="flex items-center gap-1 text-xs text-success">
              <CheckCircle2 size={13} />
              {mine.filter(isApproved).length} 个已通过评审
            </span>
          ) : undefined
        }
      />

      <div className="flex-1 overflow-y-auto rounded-lg border border-line bg-surface-4">
        {filtered.map((pr) => (
          <PrRow key={pr.id} pr={pr} />
        ))}
        {filtered.length === 0 && (
          <EmptyRow
            text={
              source.length
                ? '没有匹配的 PR'
                : tab === 'review'
                  ? '没有等你评审的 PR'
                  : '你没有进行中的 PR'
            }
          />
        )}
      </div>
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

const BUILD_RESULT_LABELS: Record<string, string> = {
  succeeded: '成功',
  failed: '失败',
  partiallySucceeded: '部分成功',
  canceled: '已取消',
};

/** 构建：完整列表（构建号、项目、触发人、结果都显示） */
export function BuildList({ builds }: { builds: Build[] }) {
  const [keyword, setKeyword] = useState('');
  const failedOnly = useUI((s) => s.buildsFailedOnly);
  const setFailedOnly = useUI((s) => s.setBuildsFailedOnly);

  const filtered = useMemo(() => {
    const q = keyword.trim().toLowerCase();
    return builds.filter(
      (b) =>
        (!failedOnly || b.result === 'failed') &&
        (!q ||
          b.definition.toLowerCase().includes(q) ||
          b.buildNumber?.toLowerCase().includes(q) ||
          b.project.toLowerCase().includes(q)),
    );
  }, [builds, keyword, failedOnly]);

  const failedCount = builds.filter((b) => b.result === 'failed').length;

  return (
    <>
      <ListHeader
        keyword={keyword}
        onKeyword={setKeyword}
        placeholder="搜索流水线、构建号或项目"
        count={filtered.length}
        total={builds.length}
        right={
          failedCount > 0 ? (
            <button
              onClick={() => setFailedOnly(!failedOnly)}
              className={`flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs transition ${
                failedOnly
                  ? 'border-danger bg-danger/10 text-danger'
                  : 'border-line text-ink-2 hover:bg-fill-hover'
              }`}
            >
              <XCircle size={13} />
              只看失败（{failedCount}）
            </button>
          ) : undefined
        }
      />

      <div className="flex-1 overflow-y-auto rounded-lg border border-line bg-surface-4">
        {filtered.map((b) => (
          <a
            key={`${b.project}-${b.id}`}
            href={b.webUrl}
            target="_blank"
            rel="noreferrer"
            className="group flex items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0 hover:bg-fill-2"
          >
            <BuildStatusIcon build={b} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-ink">{b.definition}</span>
              <span className="mt-0.5 block truncate text-2xs text-ink-3">
                {b.buildNumber} · {b.project}
                {b.requestedFor ? ` · ${b.requestedFor} 触发` : ''}
              </span>
            </span>
            <span
              className={`shrink-0 text-2xs ${
                b.result === 'failed'
                  ? 'text-danger'
                  : b.result === 'succeeded'
                    ? 'text-success'
                    : 'text-ink-3'
              }`}
            >
              {b.status === 'inProgress' || b.status === 'notStarted'
                ? '进行中'
                : (BUILD_RESULT_LABELS[b.result] ?? b.result)}
            </span>
            <span className="w-16 shrink-0 text-right text-2xs text-ink-3">
              {relTime(b.finishTime || b.queueTime)}
            </span>
            <ExternalLink size={13} className="shrink-0 text-ink-3 opacity-0 group-hover:opacity-100" />
          </a>
        ))}
        {filtered.length === 0 && (
          <EmptyRow text={builds.length ? '没有匹配的构建' : '你最近没有发起过构建'} />
        )}
      </div>
    </>
  );
}
