import { useLayoutEffect, useRef } from 'react';

/** 距底部多近算「在底部」：小于这个值时新内容到达会继续贴底跟随 */
const NEAR_BOTTOM_PX = 48;

/**
 * 滚动容器贴底跟随（issue #90 的通用形态）：挂载时停在最新内容，新内容
 * 到达时若本就在底部附近则继续跟随；用户滚上去阅读历史时不打扰，滚回
 * 底部附近自动恢复。ref/onScroll 挂到滚动容器上，deps 传会追加内容的依赖；
 * 需要强制回底（如用户自己发了消息）时把 stickToBottom.current 置 true。
 */
export function useStickToBottom(deps: readonly unknown[]) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  // useLayoutEffect 在绘制前定位，避免先看到旧位置再跳一下
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && stickToBottom.current) element.scrollTop = element.scrollHeight;
  }, deps);

  const onScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    stickToBottom.current =
      element.scrollHeight - element.scrollTop - element.clientHeight < NEAR_BOTTOM_PX;
  };

  return { scrollRef, onScroll, stickToBottom };
}
