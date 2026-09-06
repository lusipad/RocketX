import type { RcMessage, RcMessageAttachment } from '@rcx/rc-client';

/**
 * RocketX 原生值班表。
 *
 * 与看板同一套「线程事件流」模式（chat.update 改自定义附件会被服务端拒收，
 * 见 lib/kanban.ts 的说明）：频道里一条根消息（rcx-oncall-board 附件），
 * 排班的增删都是根消息话题里的回复事件（rcx-oncall 附件），面板重放聚合。
 * 官方客户端在话题里看到的是人话；「发布」往主频道发一份文本快照。
 */

export const ONCALL_BOARD_TYPE = 'rcx-oncall-board';
export const ONCALL_EVENT_TYPE = 'rcx-oncall';

export interface OncallShift {
  /** 排班 id = add 事件消息的 _id */
  id: string;
  /** 值班日期 YYYY-MM-DD */
  date: string;
  /** 班次名（早班 / 晚班 / 全天…自由文本） */
  shift: string;
  /** 值班人 username */
  username: string;
}

type OncallEvent =
  | { op: 'add'; shiftId: string; shift: OncallShift; ts: number }
  | { op: 'remove'; shiftId: string; ts: number };

export function findOncallRoot(messages: RcMessage[]): RcMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.attachments?.some((a) => a.type === ONCALL_BOARD_TYPE)) return m;
  }
  return null;
}

export function oncallEventFromMessage(m: RcMessage): OncallEvent | null {
  if (!m.tmid) return null;
  const att = m.attachments?.find((a) => a.type === ONCALL_EVENT_TYPE);
  if (!att) return null;
  const ev = att.ev as Record<string, unknown> | undefined;
  if (!ev || typeof ev !== 'object') return null;
  const ts = Date.parse(String(m.ts));
  if (
    ev.op === 'add' &&
    typeof ev.shiftId === 'string' &&
    typeof ev.date === 'string' &&
    typeof ev.shift === 'string' &&
    typeof ev.username === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(ev.date)
  ) {
    return {
      op: 'add',
      shiftId: ev.shiftId,
      shift: { id: ev.shiftId, date: ev.date, shift: ev.shift, username: ev.username },
      ts,
    };
  }
  if (ev.op === 'remove' && typeof ev.shiftId === 'string') {
    return { op: 'remove', shiftId: ev.shiftId, ts };
  }
  return null;
}

/** 重放事件流得到当前排班（按日期排序） */
export function aggregateOncall(messages: RcMessage[]): OncallShift[] {
  const events: OncallEvent[] = [];
  for (const m of messages) {
    const ev = oncallEventFromMessage(m);
    if (ev) events.push(ev);
  }
  events.sort((a, b) => a.ts - b.ts);
  const shifts = new Map<string, OncallShift>();
  for (const ev of events) {
    if (ev.op === 'add') shifts.set(ev.shiftId, ev.shift);
    else shifts.delete(ev.shiftId);
  }
  return [...shifts.values()].sort(
    (a, b) => a.date.localeCompare(b.date) || a.shift.localeCompare(b.shift),
  );
}

export function oncallEventText(ev: { op: 'add' | 'remove'; shift?: OncallShift }): string {
  if (ev.op === 'add' && ev.shift) {
    return `📅 排班：${ev.shift.date} ${ev.shift.shift} → @${ev.shift.username}`;
  }
  return '📅 取消一条排班';
}

export function oncallEventAttachment(ev: Record<string, unknown>): RcMessageAttachment {
  return { type: ONCALL_EVENT_TYPE, text: '', ev };
}

/** 发布到主频道的文本快照 */
export function oncallSummaryText(shifts: OncallShift[]): string {
  if (shifts.length === 0) return '📅 团队值班表：暂无排班';
  const lines = ['📅 团队值班表'];
  for (const s of shifts) lines.push(`${s.date} · ${s.shift} · @${s.username}`);
  return lines.join('\n');
}
