import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { tsMs, type RcMessage } from '@rcx/rc-client';
import { ArrowDown } from 'lucide-react';
import { useChat } from '../stores/chat';
import { usePrefs } from '../stores/prefs';
import { useAuth } from '../stores/auth';
import { fmtDayDivider, sameDay, systemMessageText } from '../lib/format';
import MessageItem from './MessageItem';
import { SkeletonList } from './Skeleton';

const GROUP_GAP_MS = 5 * 60 * 1000;
const NEAR_BOTTOM_PX = 120;

export default function MessageList({ rid }: { rid: string }) {
  const all = useChat((s) => s.messages[rid]);
  const historyLoaded = useChat((s) => s.historyLoaded[rid] ?? false);
  const hasMore = useChat((s) => s.hasMore[rid] ?? false);
  const loadOlder = useChat((s) => s.loadOlder);
  const scrollNonce = useChat((s) => s.scrollNonce);
  const unreadMark = useChat((s) => s.unreadMarkTs[rid]);
  const showThreadsInMain = usePrefs((s) => s.prefs.showThreadsInMainChannel ?? false);
  const myId = useAuth((s) => s.user?._id);

  const scrollRef = useRef<HTMLDivElement>(null);
  const unreadRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const anchor = useRef<{ h: number; t: number } | null>(null);
  /** 已经为本会话定位过未读分割线（只做一次，之后正常跟随） */
  const didLocateUnread = useRef(false);

  const [loadingOlder, setLoadingOlder] = useState(false);
  const [showJump, setShowJump] = useState(false);
  /** 在上面看历史时新到的消息数 */
  const [newCount, setNewCount] = useState(0);

  // 线程回复默认不进主消息流（可在设置里打开）
  const list = useMemo(
    () => (all ?? []).filter((m) => showThreadsInMain || !m.tmid),
    [all, showThreadsInMain],
  );

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    stickToBottom.current = true;
    setShowJump(false);
    setNewCount(0);
  }, []);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    stickToBottom.current = nearBottom;
    setShowJump(!nearBottom);
    if (nearBottom) setNewCount(0);

    if (el.scrollTop < 60 && hasMore && !loadingOlder) {
      setLoadingOlder(true);
      anchor.current = { h: el.scrollHeight, t: el.scrollTop };
      void loadOlder().finally(() => setLoadingOlder(false));
    }
  };

  // 切换会话：重置状态
  useLayoutEffect(() => {
    stickToBottom.current = true;
    didLocateUnread.current = false;
    setShowJump(false);
    setNewCount(0);
    anchor.current = null;
  }, [rid]);

  // 列表变化：翻页还原锚点 / 未读定位 / 跟随底部
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || list.length === 0) return;

    // 1) 向上翻页：保持视口位置不跳
    if (anchor.current) {
      el.scrollTop = el.scrollHeight - anchor.current.h + anchor.current.t;
      anchor.current = null;
      return;
    }

    // 2) 首次加载且有未读：停在「以下为新消息」处（飞书行为），而不是冲到底
    if (!didLocateUnread.current && historyLoaded) {
      didLocateUnread.current = true;
      const marker = unreadRef.current;
      if (marker) {
        marker.scrollIntoView({ block: 'center' });
        stickToBottom.current = false;
        setShowJump(true);
        return;
      }
    }

    // 3) 常规：在底部附近则跟随
    if (stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [list, historyLoaded]);

  // 不在底部时来了新消息 → 计数（用于「N 条新消息」浮条）
  const prevLen = useRef(0);
  useEffect(() => {
    const added = list.length - prevLen.current;
    prevLen.current = list.length;
    if (added > 0 && !stickToBottom.current && didLocateUnread.current) {
      setNewCount((n) => n + added);
    }
  }, [list.length]);

  // 自己发消息后强制到底
  useEffect(() => {
    if (scrollNonce > 0) scrollToBottom();
  }, [scrollNonce, scrollToBottom]);

  /**
   * 图片/附件是异步加载的，撑开高度发生在渲染之后。
   * 监听容器尺寸变化，在贴底状态下补偿滚动，否则会「停在半空」。
   */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (stickToBottom.current) el.scrollTop = el.scrollHeight;
    });
    // 观察内容容器（第一个子元素）的高度变化
    const content = el.firstElementChild;
    if (content) ro.observe(content);
    return () => ro.disconnect();
  }, [rid]);

  // 首次加载：骨架屏，避免闪一下「暂无消息」
  if (!historyLoaded && list.length === 0) {
    return (
      <div className="min-h-0 flex-1 overflow-hidden px-4 py-4">
        <SkeletonList rows={6} avatar={36} />
      </div>
    );
  }

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto px-6 py-4">
        <div>
          {hasMore && (
            <div className="py-2 text-center text-xs text-ink-3">
              {loadingOlder ? '正在加载更早的消息…' : '向上滚动加载更早的消息'}
            </div>
          )}
          {list.length === 0 && (
            <div className="py-10 text-center text-sm text-ink-3">暂无消息，来说点什么吧</div>
          )}
          {list.map((msg, i) => {
            const prev: RcMessage | undefined = list[i - 1];
            const ms = tsMs(msg.ts);
            const newDay = !prev || !sameDay(tsMs(prev.ts), ms);

            // 「以下为新消息」：上次已读之后的第一条消息前
            const isUnreadStart =
              !!unreadMark && ms > unreadMark && (!prev || tsMs(prev.ts) <= unreadMark);

            const unreadDivider = isUnreadStart ? (
              <div ref={unreadRef} className="my-3 flex items-center gap-3">
                <div className="h-px flex-1 bg-danger/30" />
                <span className="text-xs text-danger">以下为新消息</span>
                <div className="h-px flex-1 bg-danger/30" />
              </div>
            ) : null;

            const divider = newDay ? (
              <div className="my-4 flex items-center gap-3">
                <div className="h-px flex-1 bg-line" />
                <span className="text-xs text-ink-3">{fmtDayDivider(ms)}</span>
                <div className="h-px flex-1 bg-line" />
              </div>
            ) : null;

            if (msg.t) {
              return (
                <div key={msg._id}>
                  {divider}
                  {unreadDivider}
                  <div className="my-2 text-center text-xs text-ink-3">
                    {systemMessageText(msg.t, msg.u?.name || msg.u?.username || '', msg.msg)}
                  </div>
                </div>
              );
            }

            const grouped =
              !newDay &&
              !isUnreadStart &&
              !!prev &&
              !prev.t &&
              prev.u._id === msg.u._id &&
              ms - tsMs(prev.ts) < GROUP_GAP_MS;

            return (
              <div key={msg._id}>
                {divider}
                {unreadDivider}
                <MessageItem message={msg} mine={msg.u._id === myId} grouped={grouped} />
              </div>
            );
          })}
        </div>
      </div>

      {/* 回到底部 / N 条新消息（飞书式浮条） */}
      {showJump && (
        <button
          onClick={() => scrollToBottom(true)}
          className={`absolute right-6 bottom-4 flex items-center gap-1.5 rounded-full border border-line bg-surface-4 shadow-[0_2px_10px_rgba(0,0,0,0.15)] transition hover:border-primary ${
            newCount > 0 ? 'h-8 px-3 text-primary' : 'h-9 w-9 justify-center text-ink-2'
          }`}
          title="回到底部"
        >
          <ArrowDown size={16} />
          {newCount > 0 && (
            <span className="text-xs font-medium">{newCount} 条新消息</span>
          )}
        </button>
      )}
    </div>
  );
}
