import type { RcMessage, RcMessageAttachment } from '@rcx/rc-client';

/**
 * RocketX 原生投票。
 *
 * 服务器是未改造的 RC，没有应用存储可用，所以投票的共享状态全部落在消息本身：
 *   - 题目与选项存在消息附件里（type='rcx-poll'，自定义字段已验证可完整往返）；
 *   - 每个选项的票存在同一条消息的数字表情回应上（:one:..:nine:）。
 * 这样官方 RC 客户端也能看到题目文本并参与表情投票，实时计票走既有的消息更新流。
 * 旧示例应用把票存在本地 IndexedDB，互相看不见——这就是它必须被替换的原因。
 */

export interface PollPayload {
  question: string;
  /** 2-9 个选项；上限 9 是因为票用数字表情存 */
  options: string[];
  /** 允许多选 */
  multi: boolean;
  /** 创建者结束投票后为 true，结束后不能再投 */
  closed?: boolean;
}

export const POLL_ATTACHMENT_TYPE = 'rcx-poll';

/**
 * 结束投票的标记：创建者给投票消息加一把锁表情。
 *
 * 不用 chat.update 改附件里的 closed 字段——chat.update 的附件 schema 是严格校验的，
 * 自定义字段会被服务端拒收；锁表情既跨客户端可见，也走既有的回应链路。
 */
export const POLL_CLOSED_REACTION = ':lock:';

export const POLL_DIGIT_CODES = [
  ':one:',
  ':two:',
  ':three:',
  ':four:',
  ':five:',
  ':six:',
  ':seven:',
  ':eight:',
  ':nine:',
] as const;

const POLL_DIGIT_CHARS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];

export const POLL_MAX_OPTIONS = POLL_DIGIT_CODES.length;

/** 回应短名 → 键帽字符（非数字回应返回 null） */
export function digitCharOf(code: string): string | null {
  const i = POLL_DIGIT_CODES.indexOf(code as (typeof POLL_DIGIT_CODES)[number]);
  return i >= 0 ? POLL_DIGIT_CHARS[i] : null;
}

/** 选项下标 → 键帽字符（越界返回 null） */
export function digitCharAt(index: number): string | null {
  return index >= 0 && index < POLL_DIGIT_CHARS.length ? POLL_DIGIT_CHARS[index] : null;
}

/** 从消息里识别投票；不是投票消息返回 null */
export function pollFromMessage(message: RcMessage): { poll: PollPayload; attIndex: number } | null {
  const attachments = message.attachments;
  if (!attachments) return null;
  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i];
    if (att.type !== POLL_ATTACHMENT_TYPE) continue;
    const p = att.poll;
    if (
      p &&
      typeof p === 'object' &&
      typeof (p as Partial<PollPayload>).question === 'string' &&
      Array.isArray((p as Partial<PollPayload>).options) &&
      (p as Partial<PollPayload>).options!.length >= 2
    ) {
      const payload = p as Partial<PollPayload>;
      return {
        poll: {
          question: payload.question!,
          options: payload.options!.map((o) => String(o)),
          multi: !!payload.multi,
          closed: !!payload.closed,
        },
        attIndex: i,
      };
    }
  }
  return null;
}

/** 投票消息的正文（官方客户端看到的就是这段） */
export function pollText(poll: PollPayload): string {
  const lines = [`📊 投票：${poll.question}`];
  poll.options.forEach((option, i) => lines.push(`${i + 1}. ${option}`));
  lines.push(poll.multi ? '点数字表情可多选' : '点数字表情投票，每人一票');
  if (poll.closed) lines.push('—— 投票已结束 ——');
  return lines.join('\n');
}

export function pollAttachment(poll: PollPayload): RcMessageAttachment {
  return {
    type: POLL_ATTACHMENT_TYPE,
    color: '#3370ff',
    text: pollText(poll),
    poll,
  };
}

/** 投票是否已结束：附件标记或锁表情任一命中（锁表情是主通道） */
export function pollIsClosed(poll: PollPayload, message: RcMessage): boolean {
  return !!poll.closed || !!message.reactions?.[POLL_CLOSED_REACTION];
}

export interface PollTally {
  /** 每个选项的票数 */
  counts: number[];
  /** 总票数（多选时大于人数） */
  total: number;
  /** 我投过的选项下标 */
  myVotes: number[];
  /** 每个选项的投票人（悬浮可见） */
  voters: string[][];
}

/** 从消息回应里统计票数 */
export function pollTally(poll: PollPayload, message: RcMessage, myUsername?: string): PollTally {
  const counts = poll.options.map(() => 0);
  const voters: string[][] = poll.options.map(() => []);
  const myVotes: number[] = [];
  const limit = Math.min(poll.options.length, POLL_DIGIT_CODES.length);
  for (let i = 0; i < limit; i++) {
    const reaction = message.reactions?.[POLL_DIGIT_CODES[i]];
    if (!reaction) continue;
    counts[i] = reaction.usernames.length;
    voters[i] = reaction.usernames;
    if (myUsername && reaction.usernames.includes(myUsername)) myVotes.push(i);
  }
  return { counts, total: counts.reduce((a, b) => a + b, 0), myVotes, voters };
}
