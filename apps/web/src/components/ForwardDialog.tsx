import { useMemo, useState } from 'react';
import type { RcMessage } from '@rcx/rc-client';
import { Check, Search } from 'lucide-react';
import { buildConversations, stripQuotePrefix, useChat } from '../stores/chat';
import { humanError } from '../stores/toast';
import Avatar from './Avatar';
import Dialog from './Dialog';

/** 转发弹窗：搜索 + 多选会话 + 发送。单条传 message，多条传 messages（可合并/逐条） */
export default function ForwardDialog({
  message,
  messages,
  onClose,
}: {
  message?: RcMessage;
  messages?: RcMessage[];
  onClose: () => void;
}) {
  const subscriptions = useChat((s) => s.subscriptions);
  const rooms = useChat((s) => s.rooms);
  const forwardMessage = useChat((s) => s.forwardMessage);
  const forwardMessages = useChat((s) => s.forwardMessages);
  const [keyword, setKeyword] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 归一：多条模式用 msgs，单条模式包成一条的数组
  const msgs = messages ?? (message ? [message] : []);
  const multi = msgs.length > 1;

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

  const doForward = async (merge: boolean) => {
    if (selected.size === 0 || sending || msgs.length === 0) return;
    setSending(true);
    setError(null);
    try {
      if (multi) await forwardMessages(msgs, [...selected], merge);
      else await forwardMessage(msgs[0], [...selected]);
      onClose();
    } catch (err) {
      setError(humanError(err, '转发失败'));
      setSending(false);
    }
  };

  const preview = multi
    ? `[聊天记录] 共 ${msgs.length} 条消息`
    : stripQuotePrefix(msgs[0]?.msg ?? '') || '[卡片消息]';

  return (
    <Dialog
      title="转发到"
      width={440}
      onClose={onClose}
      footer={
        <>
          <button
            onClick={onClose}
            className="h-8 rounded-md border border-line px-4 text-sm text-ink-2 transition hover:bg-fill-hover"
          >
            取消
          </button>
          {multi && (
            <button
              onClick={() => void doForward(false)}
              disabled={selected.size === 0 || sending}
              className="h-8 rounded-md border border-line px-4 text-sm text-ink-2 transition hover:bg-fill-hover disabled:cursor-not-allowed disabled:opacity-40"
            >
              逐条转发
            </button>
          )}
          <button
            onClick={() => void doForward(true)}
            disabled={selected.size === 0 || sending}
            className="h-8 rounded-md bg-primary px-4 text-sm text-white transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            {sending
              ? '发送中…'
              : multi
                ? `合并转发${selected.size > 0 ? `（${selected.size}）` : ''}`
                : `发送${selected.size > 0 ? `（${selected.size}）` : ''}`}
          </button>
        </>
      }
    >
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

      <div className="min-h-40 px-2">
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

      <div className="mx-5 mt-2 truncate rounded-md bg-fill-1 px-3 py-2 text-xs text-ink-2">
        {preview}
      </div>
      {error && <div className="px-5 pt-1 text-xs text-danger">{error}</div>}
    </Dialog>
  );
}
