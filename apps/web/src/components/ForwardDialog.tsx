import { useMemo, useState } from 'react';
import type { RcMessage } from '@rcx/rc-client';
import { Check, Search, X } from 'lucide-react';
import { buildConversations, useChat } from '../stores/chat';
import Avatar from './Avatar';

/** 飞书式转发弹窗：搜索 + 多选会话 + 发送 */
export default function ForwardDialog({
  message,
  onClose,
}: {
  message: RcMessage;
  onClose: () => void;
}) {
  const subscriptions = useChat((s) => s.subscriptions);
  const rooms = useChat((s) => s.rooms);
  const forwardMessage = useChat((s) => s.forwardMessage);
  const [keyword, setKeyword] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const conversations = useMemo(
    () => buildConversations(subscriptions, rooms),
    [subscriptions, rooms],
  );
  const filtered = useMemo(
    () =>
      keyword
        ? conversations.filter((c) => c.name.toLowerCase().includes(keyword.toLowerCase()))
        : conversations,
    [conversations, keyword],
  );

  const toggle = (rid: string) => {
    const next = new Set(selected);
    if (next.has(rid)) next.delete(rid);
    else next.add(rid);
    setSelected(next);
  };

  const doForward = async () => {
    if (selected.size === 0 || sending) return;
    setSending(true);
    setError(null);
    try {
      await forwardMessage(message, [...selected]);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '转发失败，请重试');
      setSending(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[70vh] w-[440px] flex-col rounded-xl bg-surface-4 shadow-2xl">
        <header className="flex items-center justify-between px-5 pt-4 pb-2">
          <span className="text-[15px] font-semibold text-ink">转发到</span>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded text-ink-2 hover:bg-fill-hover"
          >
            <X size={16} />
          </button>
        </header>

        <div className="px-5 pb-2">
          <div className="flex h-8 items-center gap-2 rounded-md bg-fill-1 px-2.5">
            <Search size={14} className="text-ink-3" />
            <input
              autoFocus
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="搜索会话"
              className="w-full bg-transparent text-sm outline-none placeholder:text-ink-3"
            />
          </div>
        </div>

        <div className="min-h-40 flex-1 overflow-y-auto px-2">
          {filtered.map((c) => {
            const checked = selected.has(c.rid);
            return (
              <button
                key={c.rid}
                onClick={() => toggle(c.rid)}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-fill-hover"
              >
                <span
                  className={`flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full border transition ${
                    checked ? 'border-primary bg-primary text-white' : 'border-line bg-surface-4'
                  }`}
                >
                  {checked && <Check size={12} strokeWidth={3} />}
                </span>
                <Avatar name={c.name} username={c.avatarUsername} size={32} />
                <span className="truncate text-sm text-ink">{c.name}</span>
              </button>
            );
          })}
          {filtered.length === 0 && (
            <div className="py-8 text-center text-sm text-ink-3">未找到匹配的会话</div>
          )}
        </div>

        {/* 被转发内容预览 */}
        <div className="mx-5 my-2 truncate rounded-md bg-fill-1 px-3 py-2 text-xs text-ink-2">
          {message.msg || '[卡片消息]'}
        </div>
        {error && <div className="px-5 pb-1 text-xs text-danger">{error}</div>}

        <footer className="flex items-center justify-end gap-2 px-5 pb-4">
          <button
            onClick={onClose}
            className="h-8 rounded-md border border-line px-4 text-sm text-ink-2 transition hover:bg-fill-hover"
          >
            取消
          </button>
          <button
            onClick={() => void doForward()}
            disabled={selected.size === 0 || sending}
            className="h-8 rounded-md bg-primary px-4 text-sm text-white transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            {sending ? '发送中…' : `发送${selected.size > 0 ? `（${selected.size}）` : ''}`}
          </button>
        </footer>
      </div>
    </div>
  );
}
