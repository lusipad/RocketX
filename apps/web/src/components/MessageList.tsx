import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { tsMs, type RcMessage } from '@rcx/rc-client';
import { ArrowDown, Copy, Download, Share2, Star, Trash2 } from 'lucide-react';
import { useChat } from '../stores/chat';
import { usePrefs } from '../stores/prefs';
import { useAuth } from '../stores/auth';
import { fmtDayDivider, sameDay, systemMessageText, useDayTick } from '../lib/format';
import { toast } from '../stores/toast';
import MessageItem from './MessageItem';
import DiscussionCard from './DiscussionCard';
import ForwardDialog from './ForwardDialog';
import { SkeletonList } from './Skeleton';
import { messagesToMarkdown } from '../lib/messageOutput';
import { saveTextFile } from '../lib/exportText';

const GROUP_GAP_MS = 5 * 60 * 1000;
const NEAR_BOTTOM_PX = 120;

export function shouldShowUnreadDivider({
  unreadMark,
  messageTs,
  previousMessageTs,
  hasMore,
}: {
  unreadMark: number | undefined;
  messageTs: number;
  previousMessageTs: number | undefined;
  hasMore: boolean;
}): boolean {
  if (!unreadMark || messageTs <= unreadMark) return false;
  // 还有更早分页时，当前页首条之前的消息未知，不能把它冒充成精确未读边界。
  return previousMessageTs !== undefined ? previousMessageTs <= unreadMark : !hasMore;
}

export function initialMessageScrollTop({
  historyLoaded,
  didInitialScroll,
  scrollHeight,
}: {
  historyLoaded: boolean;
  didInitialScroll: boolean;
  scrollHeight: number;
}): number | undefined {
  return historyLoaded && !didInitialScroll ? scrollHeight : undefined;
}

export default function MessageList({ rid }: { rid: string }) {
  // 跨过零点后「今天/昨天」分割线要跟着变
  useDayTick();
  const all = useChat((s) => s.messages[rid]);
  const historyLoaded = useChat((s) => s.historyLoaded[rid] ?? false);
  const hasMore = useChat((s) => s.hasMore[rid] ?? false);
  const loadOlder = useChat((s) => s.loadOlder);
  const scrollNonce = useChat((s) => s.scrollNonce);
  const unreadMark = useChat((s) => s.unreadMarkTs[rid]);
  const showThreadsInMain = usePrefs((s) => s.prefs.showThreadsInMainChannel);
  const myId = useAuth((s) => s.user?._id);
  // 多选合并转发（issue #16）
  const selectMode = useChat((s) => s.selectMode);
  const selectedMids = useChat((s) => s.selectedMids);
  const exitSelectMode = useChat((s) => s.exitSelectMode);
  const deleteMessage = useChat((s) => s.deleteMessage);
  const toggleStar = useChat((s) => s.toggleStar);
  const [forwardOpen, setForwardOpen] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  /** 翻页前的可见消息位置；只在请求完成后消费，实时消息不能提前把它清掉。 */
  const anchor = useRef<{
    height: number;
    messageId?: string;
    messageTop?: number;
    settled: boolean;
  } | null>(null);
  const [anchorTick, setAnchorTick] = useState(0);
  /** 已经为本会话执行过首次贴底（只做一次，之后正常跟随） */
  const didInitialScroll = useRef(false);

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
      const viewportTop = el.getBoundingClientRect().top;
      const visible = [...el.querySelectorAll<HTMLElement>('[data-message-id]')].find(
        (node) => node.getBoundingClientRect().bottom >= viewportTop,
      );
      anchor.current = {
        height: el.scrollHeight,
        messageId: visible?.dataset.messageId,
        messageTop: visible?.offsetTop,
        settled: false,
      };
      void loadOlder()
        .then(() => {
          // Zustand 已先写入旧消息；下一帧再让 layout effect 读取更新后的 DOM。
          requestAnimationFrame(() => {
            if (!anchor.current) return;
            anchor.current.settled = true;
            setAnchorTick((tick) => tick + 1);
          });
        })
        .catch((err: unknown) => {
          anchor.current = null;
          toast.error(err, '加载更早消息失败');
        })
        .finally(() => setLoadingOlder(false));
    }
  };

  // 切换会话：重置状态
  useLayoutEffect(() => {
    stickToBottom.current = true;
    didInitialScroll.current = false;
    setShowJump(false);
    setNewCount(0);
    anchor.current = null;
  }, [rid]);

  // 列表变化：翻页还原锚点 / 未读定位 / 跟随底部
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || list.length === 0) return;

    // 1) 向上翻页：基于当前 scrollTop 增加新内容高度，避免加载期间用户继续
    //    滚动后又被旧的绝对位置拉回去（issue #19-3）。
    const pendingAnchor = anchor.current;
    if (pendingAnchor?.settled) {
      const sameMessage = pendingAnchor.messageId
        ? [...el.querySelectorAll<HTMLElement>('[data-message-id]')].find(
            (node) => node.dataset.messageId === pendingAnchor.messageId,
          )
        : undefined;
      const delta =
        sameMessage && pendingAnchor.messageTop !== undefined
          ? sameMessage.offsetTop - pendingAnchor.messageTop
          : el.scrollHeight - pendingAnchor.height;
      // 加到「用户此刻的位置」上：请求期间继续滚动也不会被拉回旧绝对位置；
      // 用同一条消息的 offset 差值又能排除底部新消息造成的高度变化。
      el.scrollTop += delta;
      anchor.current = null;
      return;
    }

    // 2) 首次打开会话默认贴底；未读分割线只作视觉提示，不改变初始位置（issue #26）。
    const initialScrollTop = initialMessageScrollTop({
      historyLoaded,
      didInitialScroll: didInitialScroll.current,
      scrollHeight: el.scrollHeight,
    });
    if (initialScrollTop !== undefined) {
      didInitialScroll.current = true;
      el.scrollTop = initialScrollTop;
      stickToBottom.current = true;
      setShowJump(false);
      setNewCount(0);
      return;
    }

    // 3) 常规：在底部附近则跟随
    if (stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [list, historyLoaded, anchorTick]);

  // 不在底部时来了新消息 → 计数（用于「N 条新消息」浮条）
  const prevLen = useRef(0);
  useEffect(() => {
    const added = list.length - prevLen.current;
    prevLen.current = list.length;
    if (added > 0 && !stickToBottom.current && didInitialScroll.current) {
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
   *
   * 依赖必须带 historyLoaded：首次打开会话时渲染的是骨架屏（scrollRef 为 null），
   * 此时 effect 早退；等 historyLoaded 翻 true、真容器才挂出来。只依赖 [rid] 的话
   * rid 没变、effect 不重跑，观察器永远挂不上，带图会话就停在半空不到底（issue #8）。
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
  }, [rid, historyLoaded]);

  useEffect(() => {
    if (!selectMode || forwardOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') exitSelectMode();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [exitSelectMode, forwardOpen, selectMode]);

  // 首次加载：骨架屏，避免闪一下「暂无消息」
  if (!historyLoaded && list.length === 0) {
    return (
      <div className="min-h-0 flex-1 overflow-hidden px-4 py-4">
        <SkeletonList rows={6} avatar={36} />
      </div>
    );
  }

  const selectedMessages = list.filter((m) => selectedMids.has(m._id));
  const copySelected = async () => {
    await navigator.clipboard.writeText(messagesToMarkdown(selectedMessages));
    toast.success(`已复制 ${selectedMessages.length} 条消息`);
  };
  const exportSelected = async () => {
    const saved = await saveTextFile(
      messagesToMarkdown(selectedMessages),
      `RocketX-消息导出-${new Date().toISOString().slice(0, 10)}.md`,
    );
    if (saved) toast.success(`已导出 ${selectedMessages.length} 条消息`);
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* 多选操作栏（issue #16 合并转发） */}
      {selectMode && (
        <div className="flex shrink-0 items-center justify-between border-b border-line bg-fill-1 px-4 py-2">
          <span className="text-sm text-ink-2">
            已选 {selectedMids.size} 条
            <span className="ml-2 text-xs text-ink-3">Esc 取消</span>
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void copySelected().catch((err) => toast.error(err, '复制失败'))}
              disabled={selectedMids.size === 0}
              className="flex h-7 items-center gap-1 rounded-md border border-line px-2.5 text-xs text-ink-2 transition hover:bg-fill-hover disabled:opacity-40"
            >
              <Copy size={13} />
              复制
            </button>
            <button
              onClick={() => setForwardOpen(true)}
              disabled={selectedMids.size === 0}
              className="flex h-7 items-center gap-1 rounded-md bg-primary px-3 text-xs text-white transition hover:bg-primary-hover disabled:opacity-40"
            >
              <Share2 size={13} />
              转发
            </button>
            <button
              onClick={() => void exportSelected().catch((err) => toast.error(err, '导出失败'))}
              disabled={selectedMids.size === 0}
              className="flex h-7 items-center gap-1 rounded-md border border-line px-2.5 text-xs text-ink-2 transition hover:bg-fill-hover disabled:opacity-40"
            >
              <Download size={13} />
              导出
            </button>
            <button
              onClick={() => {
                for (const m of selectedMessages) toggleStar(m);
                toast.success(`已标记 ${selectedMessages.length} 条消息`);
                exitSelectMode();
              }}
              disabled={selectedMids.size === 0}
              className="h-7 rounded-md border border-line px-2.5 text-xs text-ink-2 transition hover:bg-fill-hover disabled:opacity-40"
              title="批量收藏"
            >
              <Star size={14} />
            </button>
            <button
              onClick={() => {
                if (!confirm(`确定删除 ${selectedMids.size} 条消息吗？`)) return;
                for (const mid of selectedMids) deleteMessage(mid);
                exitSelectMode();
              }}
              disabled={selectedMids.size === 0}
              className="h-7 rounded-md border border-line px-2.5 text-xs text-danger transition hover:bg-danger/10 disabled:opacity-40"
              title="批量删除"
            >
              <Trash2 size={14} />
            </button>
            <button
              onClick={exitSelectMode}
              className="h-7 rounded-md border border-line px-3 text-xs text-ink-2 transition hover:bg-fill-hover"
            >
              取消
            </button>
          </div>
        </div>
      )}
      {/* overflow-anchor 关掉：翻页/贴底的滚动补偿全由我们自己做，
          浏览器原生锚定再插一脚就是双重补偿，表现为滚动时突然回跳 */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto px-6 py-4 [overflow-anchor:none]"
      >
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
            const isUnreadStart = shouldShowUnreadDivider({
              unreadMark,
              messageTs: ms,
              previousMessageTs: prev ? tsMs(prev.ts) : undefined,
              hasMore,
            });

            const unreadDivider = isUnreadStart ? (
              <div className="my-3 flex items-center gap-3">
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

            // 建讨论：RC 在父频道留的是一张可点的卡片，不是一行灰字
            if (msg.t === 'discussion-created' && msg.drid) {
              return (
                <div key={msg._id}>
                  {divider}
                  {unreadDivider}
                  <DiscussionCard message={msg} />
                </div>
              );
            }

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

      {forwardOpen && (
        <ForwardDialog
          messages={selectedMessages}
          onClose={() => {
            setForwardOpen(false);
            exitSelectMode();
          }}
        />
      )}
    </div>
  );
}
