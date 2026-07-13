import { useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Check, ExternalLink, SendHorizontal } from 'lucide-react';
import {
  adoWebBase,
  commentWorkItem,
  fetchWorkItem,
  type AdoWorkItemInfo,
} from '../lib/ado';

const TYPE_COLORS: Record<string, string> = {
  Bug: '#f54a45',
  Task: '#3370ff',
  'User Story': '#00b96b',
  Feature: '#7f3bf5',
  Epic: '#ff8800',
};

function HoverCard({
  id,
  pos,
  onEnter,
  onLeave,
}: {
  id: number;
  pos: { x: number; y: number };
  onEnter: () => void;
  onLeave: () => void;
}) {
  const [item, setItem] = useState<AdoWorkItemInfo | null | 'loading'>('loading');
  const [comment, setComment] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loaded = useRef(false);

  if (!loaded.current) {
    loaded.current = true;
    void fetchWorkItem(id).then(setItem);
  }

  const doComment = async () => {
    const text = comment.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    try {
      await commentWorkItem(id, text);
      setComment('');
      setSent(true);
      setTimeout(() => setSent(false), 2000);
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

  const left = Math.min(pos.x, window.innerWidth - 340);
  const top = Math.min(pos.y, window.innerHeight - 220);

  return createPortal(
    <div
      style={{ left, top }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      className="fixed z-50 w-[330px] rounded-xl border border-line bg-white p-4 shadow-[0_8px_24px_rgba(31,35,41,0.16)]"
    >
      {item === 'loading' ? (
        <div className="py-4 text-center text-sm text-ink-3">加载中…</div>
      ) : item === null ? (
        <div className="py-4 text-center text-sm text-ink-3">
          无法获取工作项 #{id}
          <div className="mt-1 text-xs">检查工作台连接配置或工作项是否存在</div>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ background: TYPE_COLORS[item.type] ?? '#8f959e' }}
            />
            <span className="text-xs text-ink-3">
              {item.type} #{item.id} · {item.project}
            </span>
            <a
              href={item.webUrl}
              target="_blank"
              rel="noreferrer"
              title="在 Azure DevOps 中打开"
              className="ml-auto text-ink-3 hover:text-primary"
            >
              <ExternalLink size={13} />
            </a>
          </div>
          <div className="mt-1.5 text-sm leading-snug font-medium break-words text-ink">
            {item.title}
          </div>
          <div className="mt-2 flex items-center gap-2 text-xs">
            <span className="rounded bg-primary-light px-1.5 py-0.5 text-primary">{item.state}</span>
            {item.priority != null && (
              <span className="rounded bg-fill-1 px-1.5 py-0.5 text-ink-2">P{item.priority}</span>
            )}
            {item.assignedTo && <span className="text-ink-3">负责人：{item.assignedTo}</span>}
          </div>
          <div className="mt-3 flex items-center gap-1.5 border-t border-line pt-2.5">
            <input
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="快速评论，Enter 发送"
              className="h-7 min-w-0 flex-1 rounded-md bg-fill-1 px-2 text-xs outline-none placeholder:text-ink-3"
            />
            <button
              onClick={() => void doComment()}
              disabled={!comment.trim() || sending}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary text-white transition hover:bg-primary-hover disabled:opacity-40"
            >
              {sent ? <Check size={13} /> : <SendHorizontal size={13} />}
            </button>
          </div>
          {sent && <div className="mt-1 text-xs text-success">已评论到工作项</div>}
          {error && <div className="mt-1 text-xs text-danger">{error}</div>}
        </>
      )}
    </div>,
    document.body,
  );
}

/** 消息里的 #工作项号：链接 + 悬停详情卡（含快速评论） */
export default function WorkItemLink({ id }: { id: number }) {
  const [card, setCard] = useState<{ x: number; y: number } | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const webBase = adoWebBase();

  const cancelTimers = () => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
  };

  const onEnter = (e: React.MouseEvent) => {
    cancelTimers();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openTimer.current = setTimeout(() => setCard({ x: rect.left, y: rect.bottom + 6 }), 350);
  };

  const onLeave = () => {
    cancelTimers();
    closeTimer.current = setTimeout(() => setCard(null), 250);
  };

  return (
    <>
      <a
        href={`${webBase}/_workitems/edit/${id}`}
        target="_blank"
        rel="noreferrer"
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        className="font-medium text-primary underline-offset-2 hover:underline"
      >
        #{id}
      </a>
      {card && (
        <HoverCard
          id={id}
          pos={card}
          onEnter={cancelTimers}
          onLeave={onLeave}
        />
      )}
    </>
  );
}
