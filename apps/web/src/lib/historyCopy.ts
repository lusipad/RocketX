import type { RcMessage } from '@rcx/rc-client';

/**
 * 「把聊天记录复制到另一个会话」的档位。
 *
 * 为什么是复制而不是搬移：Rocket.Chat 没有搬迁消息的接口，只能重新发送。所以新
 * 会话里看到的是**转发出来的副本**（带指向原消息的引用），原会话一条不少。
 */
export const COPY_LIMITS = [
  { key: 'recent', value: 30, label: '最近 30 条' },
  { key: 'medium', value: 100, label: '最近 100 条' },
  { key: 'all', value: 0, label: '全部（最多 2000 条）' },
] as const;

export type CopyLimitKey = (typeof COPY_LIMITS)[number]['key'];

/** `all` 的硬上限：不做无界拉取，否则一个几年的会话会把界面和服务端都拖住。 */
export const COPY_ALL_CAP = 2000;

/** 单页拉取条数（Rocket.Chat 历史接口的 count）。 */
export const COPY_PAGE_SIZE = 100;

/** 每发一条之间的间隔：实测单条约 75ms，留出余量避免触发限流。 */
export const COPY_SEND_INTERVAL_MS = 60;

export function limitForKey(key: CopyLimitKey): number {
  return COPY_LIMITS.find((item) => item.key === key)?.value ?? 30;
}

/**
 * 从服务端返回的一页里取「最新的 limit 条」。
 *
 * `getHistory` 已经按时间正序返回，所以取尾部就是最近的消息；`limit <= 0` 表示不限
 * （由 `COPY_ALL_CAP` 在上层兜住）。
 */
export function selectRecent(messages: RcMessage[], limit: number): RcMessage[] {
  const sorted = [...messages].sort((left, right) => tsOf(left) - tsOf(right));
  if (limit <= 0) return sorted;
  return sorted.slice(-limit);
}

function tsOf(message: RcMessage): number {
  const value = message.ts;
  if (typeof value === 'string') return Date.parse(value) || 0;
  if (value instanceof Date) return value.getTime();
  return Number(value) || 0;
}

/** 不会去复制的消息：系统消息、已删除、没有正文也没有附件的空消息。 */
export function isCopyableMessage(message: RcMessage): boolean {
  if (message.t) return false;
  if (!message.u?.username) return false;
  const text = (message.msg ?? '').trim();
  const hasAttachment = (message.attachments ?? []).length > 0;
  return text.length > 0 || hasAttachment;
}
