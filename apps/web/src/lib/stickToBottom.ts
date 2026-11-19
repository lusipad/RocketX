import { useLayoutEffect, useRef } from 'react';

/** 距底部多近算「在底部」：小于这个值时新内容到达会继续贴底跟随 */
const NEAR_BOTTOM_PX = 48;
const POSITION_PREFIX = 'rcx-reading-position-v1:';

interface ReadingPosition { top: number; follow: boolean }

function readPosition(key: string | undefined): ReadingPosition {
  if (key) {
    try {
      const saved = JSON.parse(sessionStorage.getItem(POSITION_PREFIX + key) ?? 'null');
      if (saved && Number.isFinite(saved.top) && saved.top >= 0 && typeof saved.follow === 'boolean') {
        return saved;
      }
    } catch { /* 存储不可用时仍可阅读与滚动。 */ }
  }
  return { top: 0, follow: true };
}

function savePosition(key: string | undefined, position: ReadingPosition) {
  if (!key) return;
  try { sessionStorage.setItem(POSITION_PREFIX + key, JSON.stringify(position)); } catch { /* ignore */ }
}

/**
 * 滚动容器贴底跟随（issue #90 的通用形态）：挂载时停在最新内容，新内容
 * 到达时若本就在底部附近则继续跟随；用户滚上去阅读历史时不打扰，滚回
 * 底部附近自动恢复。ref/onScroll 挂到滚动容器上，deps 传会追加内容的依赖；
 * 需要强制回底（如用户自己发了消息）时把 stickToBottom.current 置 true。
 */
export function useStickToBottom(deps: readonly unknown[], contextKey?: string) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const activeKey = useRef<string>();
  const position = useRef<ReadingPosition>({ top: 0, follow: true });
  const restoringTop = useRef<number | null>(null);
  const programmaticTop = useRef<number | null>(null);

  // useLayoutEffect 在绘制前定位，避免先看到旧位置再跳一下
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    if (activeKey.current !== contextKey) {
      savePosition(activeKey.current, position.current);
      activeKey.current = contextKey;
      position.current = readPosition(contextKey);
      stickToBottom.current = position.current.follow;
      restoringTop.current = position.current.follow ? null : position.current.top;
    }
    if (stickToBottom.current) restoringTop.current = null;
    if (stickToBottom.current || restoringTop.current !== null) {
      const maxTop = Math.max(0, element.scrollHeight - element.clientHeight);
      const target = stickToBottom.current ? maxTop : Math.min(restoringTop.current!, maxTop);
      if (element.scrollTop !== target) {
        programmaticTop.current = target;
        element.scrollTop = target;
      }
      // 历史还在加载时保留目标位置，下一次内容到达后继续恢复。
      if (restoringTop.current !== null && maxTop >= restoringTop.current) restoringTop.current = null;
    }
    if (restoringTop.current === null) position.current = { top: element.scrollTop, follow: stickToBottom.current };
    savePosition(activeKey.current, position.current);
  }, [contextKey, ...deps]);

  useLayoutEffect(() => () => savePosition(activeKey.current, position.current), []);

  const onScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    if (programmaticTop.current === element.scrollTop) {
      programmaticTop.current = null;
      return;
    }
    programmaticTop.current = null;
    restoringTop.current = null;
    stickToBottom.current =
      element.scrollHeight - element.scrollTop - element.clientHeight < NEAR_BOTTOM_PX;
    position.current = { top: element.scrollTop, follow: stickToBottom.current };
    savePosition(activeKey.current, position.current);
  };

  return { scrollRef, onScroll, stickToBottom };
}
