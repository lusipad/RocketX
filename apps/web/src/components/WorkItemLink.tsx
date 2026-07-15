import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Check, ExternalLink, MessageSquare, SendHorizontal } from 'lucide-react';
import {
  adoWebBase,
  commentWorkItem,
  fetchWorkItem,
  type AdoWorkItemInfo,
} from '../lib/ado';
import { isWorkItemDone, stateBadgeClass } from '../stores/workbench';

const TYPE_COLORS: Record<string, string> = {
  Bug: '#f54a45',
  Task: '#3370ff',
  'User Story': '#00b96b',
  Feature: '#7f3bf5',
  Epic: '#ff8800',
};

/**
 * 消息里的 #工作项号，两种形态（issue：文字中的 #号 要悬浮卡片）：
 * - variant='card'：富内联卡片，直接铺开类型/标题/状态/负责人。
 *   整条消息就只有工作项引用时用它——内容本身就是「一张卡片」。
 * - variant='chip'：紧凑行内块（色点 + #号 + 标题 + 状态），不打断行文；
 *   悬停出完整详情卡（含快速评论），点击在 ADO 中打开。
 * 形态由 markdown 渲染层判断（lib/markdown.tsx 的 isPureWorkItemText）。
 */

/** 快速评论输入行：内联卡片与悬浮卡共用（消息气泡里要合法嵌套，只能用 span） */
function QuickComment({
  id,
  autoFocus = false,
  inputBg = 'bg-surface-4',
  onSent,
}: {
  id: number;
  autoFocus?: boolean;
  inputBg?: string;
  onSent?: () => void;
}) {
  const [comment, setComment] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const doComment = async () => {
    const text = comment.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    try {
      await commentWorkItem(id, text);
      setComment('');
      setSent(true);
      setTimeout(() => {
        setSent(false);
        onSent?.();
      }, 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : '评论失败');
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void doComment();
    }
  };

  return (
    <>
      <span className="flex items-center gap-1.5">
        <input
          autoFocus={autoFocus}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="评论，Enter 发送"
          className={`h-6 min-w-0 flex-1 rounded px-2 text-xs outline-none placeholder:text-ink-3 ${inputBg}`}
        />
        <button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            void doComment();
          }}
          disabled={!comment.trim() || sending}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-primary text-white transition hover:bg-primary-hover disabled:opacity-40"
        >
          {sent ? <Check size={11} /> : <SendHorizontal size={11} />}
        </button>
      </span>
      {sent && <span className="mt-1 block text-xs text-success">已评论</span>}
      {error && <span className="mt-1 block text-xs text-danger">{error}</span>}
    </>
  );
}

/** 悬浮详情卡：portal 到 body，避开消息气泡的裁剪与 <p> 嵌套限制 */
function HoverCard({
  id,
  info,
  pos,
  onEnter,
  onLeave,
}: {
  id: number;
  info: AdoWorkItemInfo | 'loading';
  pos: { x: number; y: number };
  onEnter: () => void;
  onLeave: () => void;
}) {
  const left = Math.min(pos.x, window.innerWidth - 340);
  const top = Math.min(pos.y, window.innerHeight - 230);

  return createPortal(
    <div
      style={{ left, top }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      className="fixed z-50 w-[330px] rounded-xl border border-line bg-surface-4 p-4 shadow-[0_8px_24px_rgba(31,35,41,0.16)]"
    >
      {info === 'loading' ? (
        <div className="py-4 text-center text-sm text-ink-3">加载中…</div>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ background: TYPE_COLORS[info.type] ?? '#8f959e' }}
            />
            <span className="text-xs text-ink-3">
              {info.type} #{info.id} · {info.project}
            </span>
            <a
              href={info.webUrl}
              target="_blank"
              rel="noreferrer"
              title="在 Azure DevOps 中打开"
              className="ml-auto text-ink-3 hover:text-primary"
            >
              <ExternalLink size={13} />
            </a>
          </div>
          <div
            className={`mt-1.5 text-sm leading-snug font-medium break-words ${
              isWorkItemDone(info.state) ? 'text-ink-3 line-through' : 'text-ink'
            }`}
          >
            {info.title}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <span className={`rounded px-1.5 py-0.5 ${stateBadgeClass(info.state)}`}>
              {info.state}
            </span>
            {info.priority != null && (
              <span className="rounded bg-fill-1 px-1.5 py-0.5 text-ink-2">P{info.priority}</span>
            )}
            {info.assignedTo && <span className="text-ink-3">负责人：{info.assignedTo}</span>}
          </div>
          <div className="mt-3 border-t border-line pt-2.5">
            <QuickComment id={id} inputBg="bg-fill-1" />
          </div>
        </>
      )}
    </div>,
    document.body,
  );
}

/** 紧凑行内块：不打断行文，悬停 350ms 出详情卡，移开 250ms 收起（可移入卡片） */
function ChipLink({ id, info }: { id: number; info: AdoWorkItemInfo | 'loading' }) {
  const [card, setCard] = useState<{ x: number; y: number } | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const webBase = adoWebBase();

  const cancelTimers = () => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
  };
  useEffect(() => cancelTimers, []);

  const onEnter = (e: React.MouseEvent) => {
    cancelTimers();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openTimer.current = setTimeout(() => setCard({ x: rect.left, y: rect.bottom + 6 }), 350);
  };
  const onLeave = () => {
    cancelTimers();
    closeTimer.current = setTimeout(() => setCard(null), 250);
  };

  const href = info === 'loading' ? `${webBase}/_workitems/edit/${id}` : info.webUrl;

  return (
    <>
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        className="mx-0.5 inline-flex max-w-[20rem] items-center gap-1.5 rounded-md border border-line bg-fill-1 px-1.5 py-0.5 align-middle text-xs no-underline transition hover:border-primary"
      >
        {info === 'loading' ? (
          <span className="text-primary">#{id} …</span>
        ) : (
          <>
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: TYPE_COLORS[info.type] ?? '#8f959e' }}
              title={info.type}
            />
            <span className="shrink-0 text-ink-3">#{id}</span>
            <span
              className={`min-w-0 truncate ${
                isWorkItemDone(info.state) ? 'text-ink-3 line-through' : 'text-ink'
              }`}
            >
              {info.title}
            </span>
            <span className={`shrink-0 rounded px-1 ${stateBadgeClass(info.state)}`}>
              {info.state}
            </span>
          </>
        )}
      </a>
      {card && <HoverCard id={id} info={info} pos={card} onEnter={cancelTimers} onLeave={onLeave} />}
    </>
  );
}

export default function WorkItemLink({
  id,
  variant = 'card',
}: {
  id: number;
  variant?: 'card' | 'chip';
}) {
  const [info, setInfo] = useState<AdoWorkItemInfo | null | 'loading'>('loading');
  const [showComment, setShowComment] = useState(false);
  const webBase = adoWebBase();

  useEffect(() => {
    let alive = true;
    fetchWorkItem(id)
      .then((it) => alive && setInfo(it))
      .catch(() => alive && setInfo(null));
    return () => { alive = false; };
  }, [id]);

  // 拉不到详情（没配 ADO / 网络失败 / 工作项不存在）：退回朴素 #号链接
  if (info === null) {
    return (
      <a
        href={`${webBase}/_workitems/edit/${id}`}
        target="_blank"
        rel="noreferrer"
        className="font-medium text-primary underline-offset-2 hover:underline"
      >
        #{id}
      </a>
    );
  }

  // 夹在文字里的引用：紧凑行内块 + 悬浮详情卡
  if (variant === 'chip') {
    return <ChipLink id={id} info={info} />;
  }

  if (info === 'loading') {
    // 配置了 ADO 时大概率会展开成卡片：占位就按卡片尺寸画骨架，
    // 否则加载完成的一瞬间消息列表会被撑开、滚动位置跟着跳（issue #19-3）。
    // 没配置时 fetchWorkItem 立即返回 null，保持小号占位避免闪一下大骨架。
    if (!webBase) {
      return (
        <span className="mx-0.5 inline-flex items-center gap-1 rounded-md border border-line bg-fill-1 px-2 py-1 align-middle text-xs text-primary">
          #{id} …
        </span>
      );
    }
    return (
      <span className="my-1 inline-block w-full max-w-sm align-middle">
        <span className="flex animate-pulse flex-col rounded-lg border border-line bg-fill-1">
          <span className="block h-1 rounded-t-lg bg-line" />
          <span className="px-3 pt-1.5 pb-2">
            <span className="block text-xs text-ink-3">#{id} 加载中…</span>
            <span className="mt-1 block h-4 w-44 max-w-full rounded bg-fill-2" />
            <span className="mt-1.5 block h-[18px] w-24 rounded bg-fill-2" />
          </span>
        </span>
      </span>
    );
  }

  const done = isWorkItemDone(info.state);

  return (
    <span className="my-1 inline-block max-w-sm align-middle">
      <span className="flex flex-col rounded-lg border border-line bg-fill-1 transition hover:border-primary">
        {/* 顶部：类型色条 */}
        <span
          className="block h-1 rounded-t-lg"
          style={{ background: TYPE_COLORS[info.type] ?? '#8f959e' }}
        />
        <span className="px-3 pb-2 pt-1.5">
          {/* 第一行：类型 + #号 + 外链 + 评论按钮 */}
          <span className="flex items-center gap-1.5 text-xs text-ink-3">
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: TYPE_COLORS[info.type] ?? '#8f959e' }}
            />
            <span>{info.type} #{id}</span>
            <span className="mx-0.5">·</span>
            <span>{info.project}</span>
            <span className="ml-auto flex items-center gap-1">
              <button
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setShowComment((v) => !v);
                }}
                title="快速评论"
                className="text-ink-3 transition hover:text-primary"
              >
                <MessageSquare size={12} />
              </button>
              <a
                href={info.webUrl}
                target="_blank"
                rel="noreferrer"
                title="在 Azure DevOps 中打开"
                className="text-ink-3 transition hover:text-primary"
                onClick={(e) => e.stopPropagation()}
              >
                <ExternalLink size={12} />
              </a>
            </span>
          </span>
          {/* 标题 */}
          <a
            href={info.webUrl}
            target="_blank"
            rel="noreferrer"
            className={`mt-1 block text-sm leading-snug font-medium no-underline hover:underline ${
              done ? 'text-ink-3 line-through' : 'text-ink'
            }`}
          >
            {info.title}
          </a>
          {/* 状态 + 优先级 + 负责人 */}
          <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <span className={`rounded px-1.5 py-px ${stateBadgeClass(info.state)}`}>{info.state}</span>
            {info.priority != null && (
              <span className="rounded bg-surface-4 px-1.5 py-px text-ink-2">P{info.priority}</span>
            )}
            {info.assignedTo && (
              <span className="text-ink-3">{info.assignedTo}</span>
            )}
          </span>
          {/* 快速评论（展开） */}
          {showComment && (
            <span className="mt-2 block border-t border-line pt-2">
              <QuickComment id={id} autoFocus onSent={() => setShowComment(false)} />
            </span>
          )}
        </span>
      </span>
    </span>
  );
}
