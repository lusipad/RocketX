import { useEffect, useState } from 'react';
import {
  CheckCircle2,
  ExternalLink,
  GitPullRequest,
  Loader2,
  MinusCircle,
  XCircle,
} from 'lucide-react';
import {
  fetchBuild,
  fetchPullRequest,
  type AdoBuildInfo,
  type AdoPullRequestInfo,
  type AdoUrlEntity,
} from '../lib/ado';

type RichAdoEntity = Exclude<AdoUrlEntity, { kind: 'workitem' }>;

export function pullRequestReviewSummary(item: AdoPullRequestInfo) {
  const voted = item.reviewers.filter((reviewer) => reviewer.vote !== 0).length;
  const approved = item.reviewers.filter((reviewer) => reviewer.vote >= 5).length;
  const rejected = item.reviewers.filter((reviewer) => reviewer.vote <= -10).length;
  const requiredGroups = item.reviewers
    .filter((reviewer) => reviewer.isRequired && reviewer.isContainer)
    .map((reviewer) => reviewer.name);
  return { voted, approved, rejected, total: item.reviewers.length, requiredGroups };
}

function BuildIcon({ build, size = 14 }: { build: AdoBuildInfo; size?: number }) {
  if (build.status === 'inProgress' || build.status === 'notStarted') {
    return <Loader2 size={size} className="shrink-0 animate-spin text-primary" />;
  }
  if (build.result === 'succeeded') {
    return <CheckCircle2 size={size} className="shrink-0 text-success" />;
  }
  if (build.result === 'failed') return <XCircle size={size} className="shrink-0 text-danger" />;
  return <MinusCircle size={size} className="shrink-0 text-ink-3" />;
}

function buildResult(build: AdoBuildInfo): string {
  if (build.status === 'inProgress' || build.status === 'notStarted') return '进行中';
  return ({
    succeeded: '成功',
    failed: '失败',
    partiallySucceeded: '部分成功',
    canceled: '已取消',
  } as Record<string, string>)[build.result] ?? build.result;
}

function PlainLink({ entity }: { entity: RichAdoEntity }) {
  return (
    <a
      href={entity.href}
      target="_blank"
      rel="noreferrer"
      className="break-all text-primary underline-offset-2 hover:underline"
    >
      {entity.href}
    </a>
  );
}

function Loading({ entity, variant }: { entity: RichAdoEntity; variant: 'card' | 'chip' }) {
  const label = entity.kind === 'pullrequest' ? `PR !${entity.id}` : `构建 #${entity.id}`;
  if (variant === 'chip') {
    return (
      <span className="mx-0.5 inline-flex items-center gap-1 rounded-md border border-line bg-fill-1 px-2 py-1 align-middle text-xs text-primary">
        {label} …
      </span>
    );
  }
  return (
    <span className="my-1 inline-block w-full max-w-sm align-middle">
      <span className="flex animate-pulse flex-col rounded-lg border border-line bg-fill-1">
        <span className="block h-1 rounded-t-lg bg-line" />
        <span className="px-3 py-2 text-xs text-ink-3">{label} 加载中…</span>
      </span>
    </span>
  );
}

function PullRequestLink({
  item,
  variant,
}: {
  item: AdoPullRequestInfo;
  variant: 'card' | 'chip';
}) {
  const review = pullRequestReviewSummary(item);
  if (variant === 'chip') {
    return (
      <a
        href={item.webUrl}
        target="_blank"
        rel="noreferrer"
        className="mx-0.5 inline-flex max-w-xs items-center gap-1.5 rounded-md border border-line bg-fill-1 px-2 py-1 align-middle text-xs no-underline transition hover:border-primary"
      >
        <GitPullRequest size={13} className="shrink-0 text-[#7f3bf5]" />
        <span className="shrink-0 text-ink-3">!{item.id}</span>
        <span className="truncate text-ink">{item.title}</span>
      </a>
    );
  }
  return (
    <span className="my-1 inline-block w-full max-w-lg align-middle">
      <span className="flex flex-col rounded-lg border border-line bg-fill-1 transition hover:border-primary">
        <span className="block h-1 rounded-t-lg bg-[#7f3bf5]" />
        <span className="px-3 pb-2 pt-1.5">
          <span className="flex items-center gap-1.5 text-xs text-ink-3">
            <GitPullRequest size={13} className="text-[#7f3bf5]" />
            <span>PR !{item.id}</span>
            <span>·</span>
            <span className="truncate">{item.project}/{item.repo}</span>
            <a href={item.webUrl} target="_blank" rel="noreferrer" className="ml-auto">
              <ExternalLink size={12} />
            </a>
          </span>
          <a
            href={item.webUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-1 block text-sm font-medium leading-snug text-ink no-underline hover:underline"
          >
            {item.title}
          </a>
          <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-3">
            <span className="truncate">{item.sourceBranch} → {item.targetBranch}</span>
            <span>发起人 {item.creator || '未知'}</span>
            <span className={review.approved === review.total && review.total > 0 ? 'text-success' : ''}>
              {review.total > 0 ? `${review.voted}/${review.total} 已审核` : '尚未指定评审人'}
            </span>
            {review.rejected > 0 && <span className="text-danger">{review.rejected} 人拒绝</span>}
          </span>
          {review.requiredGroups.length > 0 && (
            <span className="mt-1.5 flex flex-wrap items-center gap-1 text-xs text-ink-3">
              <span>必审组</span>
              {review.requiredGroups.map((group) => (
                <span key={group} className="rounded bg-fill-2 px-1.5 py-0.5 text-ink-2">
                  {group}
                </span>
              ))}
            </span>
          )}
        </span>
      </span>
    </span>
  );
}

function BuildLink({ item, variant }: { item: AdoBuildInfo; variant: 'card' | 'chip' }) {
  const result = buildResult(item);
  if (variant === 'chip') {
    return (
      <a
        href={item.webUrl}
        target="_blank"
        rel="noreferrer"
        className="mx-0.5 inline-flex max-w-xs items-center gap-1.5 rounded-md border border-line bg-fill-1 px-2 py-1 align-middle text-xs no-underline transition hover:border-primary"
      >
        <BuildIcon build={item} size={13} />
        <span className="shrink-0 text-ink-3">{item.buildNumber}</span>
        <span className="truncate text-ink">{item.definition}</span>
      </a>
    );
  }
  return (
    <span className="my-1 inline-block w-full max-w-sm align-middle">
      <span className="flex flex-col rounded-lg border border-line bg-fill-1 transition hover:border-primary">
        <span className="block h-1 rounded-t-lg bg-primary" />
        <span className="px-3 pb-2 pt-1.5">
          <span className="flex items-center gap-1.5 text-xs text-ink-3">
            <BuildIcon build={item} size={13} />
            <span>构建 {item.buildNumber}</span>
            <span>·</span>
            <span className="truncate">{item.project}</span>
            <a href={item.webUrl} target="_blank" rel="noreferrer" className="ml-auto">
              <ExternalLink size={12} />
            </a>
          </span>
          <a
            href={item.webUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-1 block text-sm font-medium leading-snug text-ink no-underline hover:underline"
          >
            {item.definition}
          </a>
          <span className="mt-1.5 flex items-center gap-2 text-xs text-ink-3">
            <span>{result}</span>
            {item.requestedFor && <span>{item.requestedFor} 触发</span>}
          </span>
        </span>
      </span>
    </span>
  );
}

export default function AdoEntityLink({
  entity,
  variant,
}: {
  entity: RichAdoEntity;
  variant: 'card' | 'chip';
}) {
  const [item, setItem] = useState<AdoPullRequestInfo | AdoBuildInfo | null | 'loading'>('loading');

  useEffect(() => {
    let alive = true;
    setItem('loading');
    const load = entity.kind === 'pullrequest'
      ? fetchPullRequest(entity.id)
      : fetchBuild(entity.project, entity.id);
    void load.then((value) => alive && setItem(value)).catch(() => alive && setItem(null));
    return () => { alive = false; };
  }, [entity.kind, entity.id, entity.kind === 'build' ? entity.project : '']);

  if (item === null) return <PlainLink entity={entity} />;
  if (item === 'loading') return <Loading entity={entity} variant={variant} />;
  return entity.kind === 'pullrequest'
    ? <PullRequestLink item={item as AdoPullRequestInfo} variant={variant} />
    : <BuildLink item={item as AdoBuildInfo} variant={variant} />;
}
