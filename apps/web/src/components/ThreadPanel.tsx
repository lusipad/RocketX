import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { tsMs } from '@rcx/rc-client';
import { AtSign, Bell, BellOff, Bot, SendHorizontal, Smile } from 'lucide-react';
import { useChat } from '../stores/chat';
import { useAuth } from '../stores/auth';
import { usePrefs } from '../stores/prefs';
import { composerCommands, dispatchInput } from '../kernel/dispatch';
import MessageItem from './MessageItem';
import PanelShell from './PanelShell';
import EmojiPicker from './EmojiPicker';
import { shouldInsertNewline, shouldSendMessage } from '../lib/sendKeys';
import {
  canMentionInRoom,
  insertMentionAtCursor,
  mentionQueryAtCursor,
} from '../lib/mentions';
import { matchSharedAiMention, resolveSharedAiMentionTarget } from '../lib/aiMention';
import { runtimeFeatures } from '../lib/runtimeMode';
import { useSharedAgent } from '../stores/sharedAgent';

const SUPPORTS_FIELD_SIZING =
  typeof CSS !== 'undefined' && !!CSS.supports?.('field-sizing', 'content');

/** 右侧话题（线程）面板：根消息 + 全部回复 + 回复框（表情/自动滚动/发送方式跟随偏好） */
export default function ThreadPanel() {
  const rid = useChat((s) => s.activeRid);
  const roomType = useChat((s) => (s.activeRid ? s.subscriptions[s.activeRid]?.t : undefined));
  const rootId = useChat((s) => (s.rightPanel?.kind === 'thread' ? s.rightPanel.mid : null));
  const all = useChat((s) => (s.activeRid ? s.messages[s.activeRid] : undefined));
  const send = useChat((s) => s.send);
  const toggleThreadFollow = useChat((s) => s.toggleThreadFollow);
  const runSlash = useChat((s) => s.runSlash);
  const emitTyping = useChat((s) => s.emitTyping);
  const myId = useAuth((s) => s.user?._id);
  const sendOnEnter = usePrefs((s) => s.prefs.sendOnEnter);
  const prefsLoaded = usePrefs((s) => s.loaded);
  const canMention = canMentionInRoom(roomType);
  const sharedAiStatus = useSharedAgent((s) => {
    if (!rid || !rootId || !runtimeFeatures().ai) return null;
    return resolveSharedAiMentionTarget(rid, rootId, s.sessions, s.remoteCards)?.status ?? null;
  });

  const [text, setText] = useState('');
  const [picker, setPicker] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [followLoading, setFollowLoading] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const root = useMemo(() => all?.find((m) => m._id === rootId), [all, rootId]);
  const replies = useMemo(
    () => (all ?? []).filter((m) => m.tmid === rootId).sort((a, b) => tsMs(a.ts) - tsMs(b.ts)),
    [all, rootId],
  );
  const following = !!myId && !!root && (
    root.replies?.includes(myId) || (!root.tcount && root.u._id === myId)
  );
  const showSharedAiMention = canMention && !!sharedAiStatus && matchSharedAiMention(mentionQuery);

  // 切换话题时清空草稿并聚焦
  useEffect(() => {
    setText('');
    setPicker(false);
    setMentionQuery(null);
    textareaRef.current?.focus();
  }, [rootId]);

  // 新回复进来自动滚到底
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [replies.length]);

  const autoResize = () => {
    if (SUPPORTS_FIELD_SIZING) return;
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

    // 话题里也得认斜杠命令 —— 不然在话题里打 `/kick @张三`，它会原样广播成一条文本。
    // 这里没有补全面板（主输入框才有），但拦截是必须的。
    const commands = composerCommands(useChat.getState().slashCommands);
    const dispatched = await dispatchInput(value, { rid, runSlash, commands }, rootId);
    if (dispatched.handled) {
      if (dispatched.accepted) setText('');
      return;
    }

    setText('');
    await send(value, { rid, tmid: rootId });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!e.nativeEvent.isComposing && showSharedAiMention) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        insertSharedAiMention();
        return;
      }
      if (e.key === 'Escape') {
        setMentionQuery(null);
        return;
      }
    }
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    // 偏好未加载完先沿用产品默认值，避免首屏短暂变成 Ctrl+Enter 发送（issue #122）
    const effectiveMode = prefsLoaded ? sendOnEnter : 'normal';
    if (shouldInsertNewline(effectiveMode, e)) {
      e.preventDefault();
      insertText('\n');
      return;
    }
    if (shouldSendMessage(effectiveMode, e)) {
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

  function insertSharedAiMention() {
    const el = textareaRef.current;
    const cursor = el?.selectionStart ?? text.length;
    const inserted = insertMentionAtCursor(text, cursor, 'ai');
    setText(inserted.value);
    setMentionQuery(null);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(inserted.cursor, inserted.cursor);
    });
  }

  return (
    <PanelShell
      title={
        <span>话题</span>
      }
    >
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3">
        {root && (
          <div className="mb-3 flex items-center justify-between gap-3 rounded-md border border-line bg-surface-2 px-3 py-2">
            <div className="min-w-0">
              <div className="text-sm font-medium text-ink">
                {following ? '已关注讨论串' : '未关注讨论串'}
              </div>
              <div className="text-xs text-ink-3">只有关注后，普通新回复才会提醒你</div>
            </div>
            <button
              type="button"
              disabled={!myId || followLoading}
              aria-label={following ? '取消关注讨论串' : '关注讨论串'}
              title={following ? '关闭此讨论串提醒' : '接收此讨论串的新回复提醒'}
              onClick={() => {
                setFollowLoading(true);
                void toggleThreadFollow(rootId, !following).finally(() => setFollowLoading(false));
              }}
              className="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-line px-2.5 text-xs text-ink-2 transition hover:bg-fill-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
            >
              {following ? <BellOff size={14} /> : <Bell size={14} />}
              {following ? '关闭提醒' : '关注'}
            </button>
          </div>
        )}
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
        {showSharedAiMention && (
          <div
            id="thread-mention-list"
            role="listbox"
            aria-label="提及共享 AI"
            className="absolute bottom-full left-3 z-30 mb-1 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg bg-surface-4 py-1 shadow-pop"
          >
            <button
              id="thread-mention-option-ai"
              role="option"
              aria-selected="true"
              onMouseDown={(e) => {
                e.preventDefault();
                insertSharedAiMention();
              }}
              className="flex w-full items-center gap-2 bg-primary-light px-3 py-1.5 text-left text-sm"
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-primary-light text-primary">
                <Bot size={14} />
              </span>
              <span className="font-medium text-ink">AI 托管</span>
              <span className="min-w-0 truncate text-xs text-ink-3">@ai</span>
              <span className="ml-auto shrink-0 rounded bg-fill-1 px-1.5 py-0.5 text-xs text-ink-3">
                {sharedAiStatus === 'interrupted' ? '话题共享 · 已中断' : '话题共享'}
              </span>
            </button>
          </div>
        )}
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
          {canMention && (
            <button
              title="提及成员"
              onClick={() => {
                insertText('@');
                setMentionQuery('');
              }}
              className="flex h-7 w-7 items-center justify-center rounded text-ink-2 transition hover:bg-fill-hover hover:text-ink"
            >
              <AtSign size={16} />
            </button>
          )}
        </div>
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              emitTyping();
              setMentionQuery(mentionQueryAtCursor(e.target.value, e.target.selectionStart, roomType));
            }}
            onKeyDown={onKeyDown}
            onClick={(e) => {
              const target = e.target as HTMLTextAreaElement;
              setMentionQuery(mentionQueryAtCursor(text, target.selectionStart, roomType));
            }}
            aria-autocomplete="list"
            aria-controls={showSharedAiMention ? 'thread-mention-list' : undefined}
            aria-expanded={showSharedAiMention}
            aria-activedescendant={showSharedAiMention ? 'thread-mention-option-ai' : undefined}
            rows={1}
            placeholder={
              sendOnEnter === 'alternative'
                ? '回复话题，Ctrl + Enter 发送，Enter 换行'
                : '回复话题，Enter 发送，Alt + Enter 换行'
            }
            className="max-h-32 min-h-9 flex-1 resize-none overflow-y-auto rounded-md border border-line px-3 py-2 text-sm leading-relaxed outline-none transition [field-sizing:content] focus:border-primary"
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
