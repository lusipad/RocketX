import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { tsMs } from '@rcx/rc-client';
import { AtSign, SendHorizontal, Smile } from 'lucide-react';
import { useChat } from '../stores/chat';
import { useAuth } from '../stores/auth';
import { usePrefs } from '../stores/prefs';
import MessageItem from './MessageItem';
import PanelShell from './PanelShell';
import EmojiPicker from './EmojiPicker';

/** 右侧话题（线程）面板：根消息 + 全部回复 + 回复框（表情/自动滚动/发送方式跟随偏好） */
export default function ThreadPanel() {
  const rid = useChat((s) => s.activeRid);
  const rootId = useChat((s) => (s.rightPanel?.kind === 'thread' ? s.rightPanel.mid : null));
  const all = useChat((s) => (s.activeRid ? s.messages[s.activeRid] : undefined));
  const send = useChat((s) => s.send);
  const emitTyping = useChat((s) => s.emitTyping);
  const myId = useAuth((s) => s.user?._id);
  const sendOnEnter = usePrefs((s) => s.prefs.sendOnEnter ?? 'normal');

  const [text, setText] = useState('');
  const [picker, setPicker] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const root = useMemo(() => all?.find((m) => m._id === rootId), [all, rootId]);
  const replies = useMemo(
    () => (all ?? []).filter((m) => m.tmid === rootId).sort((a, b) => tsMs(a.ts) - tsMs(b.ts)),
    [all, rootId],
  );

  // 切换话题时清空草稿并聚焦
  useEffect(() => {
    setText('');
    setPicker(false);
    textareaRef.current?.focus();
  }, [rootId]);

  // 新回复进来自动滚到底
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [replies.length]);

  const autoResize = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  };
  useEffect(autoResize, [text]);

  if (!rid || !rootId) return null;

  const doSend = async () => {
    const value = text.trim();
    if (!value) return;
    setText('');
    await send(value, { tmid: rootId });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    const shouldSend =
      sendOnEnter === 'alternative'
        ? e.ctrlKey || e.metaKey
        : !e.shiftKey && !e.ctrlKey && !e.metaKey;
    if (shouldSend) {
      e.preventDefault();
      void doSend();
    }
  };

  const insertText = (s: string) => {
    const el = textareaRef.current;
    const cursor = el?.selectionStart ?? text.length;
    const next = text.slice(0, cursor) + s + text.slice(cursor);
    setText(next);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(cursor + s.length, cursor + s.length);
    });
  };

  return (
    <PanelShell title="话题">
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3">
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

      <div className="relative shrink-0 border-t border-line p-3">
        {picker && (
          <EmojiPicker
            onPick={(e) => {
              insertText(e.char);
              setPicker(false);
            }}
            onClose={() => setPicker(false)}
            className="absolute bottom-full left-3 mb-1 shadow-lg"
          />
        )}
        <div className="flex items-center gap-1 pb-1.5">
          <button
            title="表情"
            onClick={() => setPicker((v) => !v)}
            className="flex h-7 w-7 items-center justify-center rounded text-ink-2 transition hover:bg-fill-hover hover:text-ink"
          >
            <Smile size={16} />
          </button>
          <button
            title="提及成员"
            onClick={() => insertText('@')}
            className="flex h-7 w-7 items-center justify-center rounded text-ink-2 transition hover:bg-fill-hover hover:text-ink"
          >
            <AtSign size={16} />
          </button>
        </div>
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              emitTyping();
              requestAnimationFrame(autoResize);
            }}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder={
              sendOnEnter === 'alternative'
                ? '回复话题，Ctrl + Enter 发送，Enter 换行'
                : '回复话题，Enter 发送，Shift + Enter 换行'
            }
            className="max-h-32 min-h-9 flex-1 resize-none overflow-y-auto rounded-md border border-line px-3 py-2 text-sm leading-relaxed outline-none transition focus:border-primary"
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
