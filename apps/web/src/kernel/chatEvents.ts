import type { RcMessage } from '@rcx/rc-client';
import type { KernelChatEventState } from './host';

/**
 * 当前房间消息事件的差分。
 *
 * store 的 messages 数组是不可变更新：新消息 = 尾部新增；表情回应/编辑 =
 * 同一条消息对象引用被替换。reactions 就在更新里——应用的实时计票靠它。
 */
export interface ChatEventDiff {
  /** 新出现的消息（尾部追加的那条） */
  received?: RcMessage;
  /** 内容被替换的已有消息（回应变化、编辑等），按列表位置从新到旧，最多 20 条 */
  updated: RcMessage[];
}

const UPDATED_LIMIT = 20;

export function diffChatMessages(
  state: KernelChatEventState,
  previous: KernelChatEventState,
): ChatEventDiff {
  const rid = state.activeRid;
  // 切换会话时第一眼看到的是历史，不是「新消息」——room.changed 已单独通知
  if (!rid || rid !== previous.activeRid || state.messages[rid] === previous.messages[rid]) {
    return { updated: [] };
  }
  const list = state.messages[rid] ?? [];
  const previousList = previous.messages[rid] ?? [];

  const diff: ChatEventDiff = { updated: [] };
  const latest = list.at(-1);
  const previousLatest = previousList.at(-1);
  if (latest && latest._id !== previousLatest?._id) diff.received = latest;

  const previousById = new Map(previousList.map((m) => [m._id, m]));
  for (let i = list.length - 1; i >= 0 && diff.updated.length < UPDATED_LIMIT; i--) {
    const message = list[i];
    const before = previousById.get(message._id);
    // 新消息已在 received 里报过，不算更新
    if (!before || before === message || diff.received?._id === message._id) continue;
    diff.updated.push(message);
  }
  return diff;
}
