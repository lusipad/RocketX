import { useMemo, useState, type KeyboardEvent } from 'react';
import { tsMs } from '@rcx/rc-client';
import { SendHorizontal } from 'lucide-react';
import { useChat } from '../stores/chat';
import { useAuth } from '../stores/auth';
import MessageItem from './MessageItem';
import PanelShell from './PanelShell';

/** 右侧话题（线程）面板：根消息 + 全部回复 + 快捷回复框 */
export default function ThreadPanel() {
  const rid = useChat((s) => s.activeRid);
  const rootId = useChat((s) => (s.rightPanel?.kind === 'thread' ? s.rightPanel.mid : null));
  const all = useChat((s) => (s.activeRid ? s.messages[s.activeRid] : undefined));
  const send = useChat((s) => s.send);
  const myId = useAuth((s) => s.user?._id);
  const [text, setText] = useState('');

  const root = useMemo(() => all?.find((m) => m._id === rootId), [all, rootId]);
  const replies = useMemo(
    () =>
      (all ?? [])
        .filter((m) => m.tmid === rootId)
        .sort((a, b) => tsMs(a.ts) - tsMs(b.ts)),
    [all, rootId],
  );

  if (!rid || !rootId) return null;

  const doSend = async () => {
    const value = text.trim();
    if (!value) return;
    setText('');
    await send(value, rootId);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void doSend();
    }
  };

  return (
    <PanelShell title="话题">
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {root ? (
          <>
            <MessageItem message={root} mine={root.u._id === myId} grouped={false} inThread />
            <div className="my-3 flex items-center gap-2">
              <div className="h-px flex-1 bg-line" />
              <span className="text-xs text-ink-3">
                {replies.length > 0 ? `${replies.length} 条回复` : '暂无回复'}
              </span>
              <div className="h-px flex-1 bg-line" />
            </div>
            {replies.map((msg, i) => {
              const prev = replies[i - 1];
              const grouped =
                !!prev && prev.u._id === msg.u._id && tsMs(msg.ts) - tsMs(prev.ts) < 5 * 60 * 1000;
              return (
                <MessageItem
                  key={msg._id}
                  message={msg}
                  mine={msg.u._id === myId}
                  grouped={grouped}
                  inThread
                />
              );
            })}
          </>
        ) : (
          <div className="py-10 text-center text-sm text-ink-3">话题加载中…</div>
        )}
      </div>

      <div className="shrink-0 border-t border-line p-3">
        <div className="flex items-end gap-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            rows={Math.min(4, Math.max(1, text.split('\n').length))}
            placeholder="回复话题…"
            className="max-h-28 flex-1 resize-none rounded-md border border-line px-3 py-2 text-sm leading-relaxed outline-none transition focus:border-primary"
          />
          <button
            onClick={() => void doSend()}
            disabled={!text.trim()}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary text-white transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            <SendHorizontal size={16} />
          </button>
        </div>
      </div>
    </PanelShell>
  );
}
