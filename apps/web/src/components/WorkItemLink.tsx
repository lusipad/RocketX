import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
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
 * 消息里的 #工作项号：丰富内联卡片。
 * 直接展示类型、标题、状态、优先级、负责人，不再需要悬浮预览。
 * 点击在 ADO 中打开；底部可展开快速评论。
 */
export default function WorkItemLink({ id }: { id: number }) {
  const [info, setInfo] = useState<AdoWorkItemInfo | null | 'loading'>('loading');
  const [showComment, setShowComment] = useState(false);
  const [comment, setComment] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const webBase = adoWebBase();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    fetchWorkItem(id)
      .then((it) => alive && setInfo(it))
      .catch(() => alive && setInfo(null));
    return () => { alive = false; };
  }, [id]);

  const doComment = async () => {
    const text = comment.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    try {
      await commentWorkItem(id, text);
      setComment('');
      setSent(true);
      setTimeout(() => { setSent(false); setShowComment(false); }, 1500);
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

  const toggleComment = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setShowComment((v) => !v);
    if (!showComment) setTimeout(() => inputRef.current?.focus(), 50);
  };

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

  if (info === 'loading') {
    return (
      <span className="mx-0.5 inline-flex items-center gap-1 rounded-md border border-line bg-fill-1 px-2 py-1 align-middle text-xs text-primary">
        #{id} …
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
                onClick={toggleComment}
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
            <span className="mt-2 flex items-center gap-1.5 border-t border-line pt-2">
              <input
                ref={inputRef}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="评论，Enter 发送"
                className="h-6 min-w-0 flex-1 rounded bg-surface-4 px-2 text-xs outline-none placeholder:text-ink-3"
              />
              <button
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); void doComment(); }}
                disabled={!comment.trim() || sending}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-primary text-white transition hover:bg-primary-hover disabled:opacity-40"
              >
                {sent ? <Check size={11} /> : <SendHorizontal size={11} />}
              </button>
            </span>
          )}
          {sent && <span className="mt-1 block text-xs text-success">已评论</span>}
          {error && <span className="mt-1 block text-xs text-danger">{error}</span>}
        </span>
      </span>
    </span>
  );
}
