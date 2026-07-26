/** 右侧面板打开期间给会话列表预留的临时宽度。 */
export const COMPACT_CONVERSATION_WIDTH = 232;

/**
 * 拖动中的宽度优先；其余情况下仅由右侧面板触发的临时状态收窄，
 * 不改变用户已持久化的偏好。
 */
export function effectiveConversationWidth(
  userWidth: number,
  narrowed: boolean,
  dragWidth: number | null,
  maxWidth: number,
): number {
  const settledWidth = narrowed
    ? Math.min(userWidth, COMPACT_CONVERSATION_WIDTH)
    : userWidth;
  return Math.min(dragWidth ?? settledWidth, maxWidth);
}
