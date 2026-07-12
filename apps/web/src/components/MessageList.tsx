import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { tsMs, type RcMessage } from '@rcx/rc-client';
import { ArrowDown } from 'lucide-react';
import { useChat } from '../stores/chat';
import { useAuth } from '../stores/auth';
import { fmtDayDivider, sameDay, systemMessageText } from '../lib/format';
import MessageItem from './MessageItem';

const GROUP_GAP_MS = 5 * 60 * 1000;

export default function MessageList({ rid }: { rid: string }) {
  const all = useChat((s) => s.messages[rid]);
  const hasMore = useChat((s) => s.hasMore[rid] ?? false);
  const loadOlder = useChat((s) => s.loadOlder);
  const scrollNonce = useChat((s) => s.scrollNonce);
  const unreadMark = useChat((s) => s.unreadMarkTs[rid]);
  const myId = useAuth((s) => s.user?._id);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const loadingOlder = useRef(false);
  // 翻页前记录的滚动锚点，DOM 更新后据此还原视口位置
  const anchor = useRef<{ h: number; t: number } | null>(null);
  const [showJump, setShowJump] = useState(false);

  // 线程回复不出现在主消息流（在话题面板里看）
  const list = useMemo(() => (all ?? []).filter((m) => !m.tmid), [all]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    stickToBottom.current = nearBottom;
    setShowJump(!nearBottom);

    if (el.scrollTop < 60 && hasMore && !loadingOlder.current) {
      loadingOlder.current = true;
      anchor.current = { h: el.scrollHeight, t: el.scrollTop };
      void loadOlder().finally(() => {
        loadingOlder.current = false;
      });
    }
  };

  // 切换会话时直达底部
  useLayoutEffect(() => {
    stickToBottom.current = true;
    setShowJump(false);
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [rid]);

  // 列表变化：翻页则还原锚点位置；在底部附近则跟随新消息
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (anchor.current) {
      el.scrollTop = el.scrollHeight - anchor.current.h + anchor.current.t;
      anchor.current = null;
    } else if (stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [list]);

  // 自己发送消息后强制滚到底部
  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      stickToBottom.current = true;
      el.scrollTop = el.scrollHeight;
    }
  }, [scrollNonce]);

  const jumpToBottom = () => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto px-6 py-4">
        {hasMore && (
          <div className="py-2 text-center text-xs text-ink-3">
            {loadingOlder.current ? '加载中…' : '向上滚动加载更早的消息'}
          </div>
        )}
        {list.length === 0 && (
          <div className="py-10 text-center text-sm text-ink-3">暂无消息，来说点什么吧</div>
        )}
        {list.map((msg, i) => {
          const prev: RcMessage | undefined = list[i - 1];
          const ms = tsMs(msg.ts);
          const newDay = !prev || !sameDay(tsMs(prev.ts), ms);

          // 「以下为新消息」：上次已读位置之后的第一条消息前显示（飞书交互）
          const unreadDivider =
            unreadMark && ms > unreadMark && (!prev || tsMs(prev.ts) <= unreadMark) ? (
              <div key={`unread-${msg._id}`} className="my-3 flex items-center gap-3">
                <div className="h-px flex-1 bg-danger/30" />
                <span className="text-xs text-danger">以下为新消息</span>
                <div className="h-px flex-1 bg-danger/30" />
              </div>
            ) : null;

          const divider = newDay ? (
            <div key={`day-${msg._id}`} className="my-4 flex items-center gap-3">
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
            !unreadDivider &&
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
      {showJump && (
        <button
          onClick={jumpToBottom}
          title="回到底部"
          className="absolute right-6 bottom-4 flex h-9 w-9 items-center justify-center rounded-full border border-line bg-white text-ink-2 shadow-[0_2px_10px_rgba(31,35,41,0.15)] transition hover:text-primary"
        >
          <ArrowDown size={17} />
        </button>
      )}
    </div>
  );
}
