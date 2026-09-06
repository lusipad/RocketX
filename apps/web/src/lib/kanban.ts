import type { RcMessage, RcMessageAttachment } from '@rcx/rc-client';
import { stripAgentSessionMarker } from '../agent/card';
import { stripQuotePrefix } from './messageText';

/**
 * RocketX 原生消息看板。
 *
 * 服务器是未改造的 RC：chat.update 对附件做严格 schema 校验（自定义字段会被拒收，
 * 投票功能实测过），所以「编辑一条看板状态消息」这条路走不通。看板改用**线程事件流**：
 *   - 每个频道一块看板，看板的「根消息」带 rcx-kanban-board 附件；
 *   - 所有卡片操作（新建/移动/删除）都是根消息话题里的回复，带 rcx-kanban 附件；
 *   - 面板把事件按时间重放，聚合出每张卡片的当前列。
 * 这样状态对全员共享、实时（既有消息流）、可审计（事件都在话题里），
 * 官方客户端看到的是一条条人话（「把卡片「xx」移到 进行中」），主频道也不会被刷屏。
 */

export const KANBAN_EVENT_TYPE = 'rcx-kanban';
export const KANBAN_BOARD_TYPE = 'rcx-kanban-board';

export const KANBAN_COLUMNS = [
  { key: 'todo', name: '待办' },
  { key: 'doing', name: '进行中' },
  { key: 'done', name: '已完成' },
] as const;

export type KanbanColumn = (typeof KANBAN_COLUMNS)[number]['key'];

export function isKanbanColumn(v: unknown): v is KanbanColumn {
  return v === 'todo' || v === 'doing' || v === 'done';
}

export function kanbanColumnName(key: KanbanColumn): string {
  return KANBAN_COLUMNS.find((c) => c.key === key)?.name ?? key;
}

export interface KanbanCard {
  /** 卡片 id = 创建事件那条消息的 _id */
  id: string;
  title: string;
  column: KanbanColumn;
  by: string;
  ts: number;
  /** 收纳自某条消息时记下原文链接 */
  sourceMid?: string;
}

type KanbanEvent =
  | { op: 'create'; cardId: string; title: string; column: KanbanColumn; by: string; ts: number; sourceMid?: string }
  | { op: 'move'; cardId: string; column: KanbanColumn; ts: number }
  | { op: 'remove'; cardId: string; ts: number };

/** 找频道的看板根消息（一个频道一块看板） */
export function findBoardRoot(messages: RcMessage[]): RcMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.attachments?.some((a) => a.type === KANBAN_BOARD_TYPE)) return m;
  }
  return null;
}

/** 从话题回复里解析看板事件；非事件消息返回 null */
export function kanbanEventFromMessage(m: RcMessage): KanbanEvent | null {
  if (!m.tmid) return null;
  const att = m.attachments?.find((a) => a.type === KANBAN_EVENT_TYPE);
  if (!att) return null;
  const ev = att.ev as Record<string, unknown> | undefined;
  if (!ev || typeof ev !== 'object') return null;
  const ts = Date.parse(String(m.ts));
  if (ev.op === 'create' && typeof ev.cardId === 'string' && typeof ev.title === 'string' && isKanbanColumn(ev.column)) {
    return {
      op: 'create',
      cardId: ev.cardId,
      title: ev.title,
      column: ev.column,
      by: m.u.username,
      ts,
      ...(typeof ev.sourceMid === 'string' ? { sourceMid: ev.sourceMid } : {}),
    };
  }
  if (ev.op === 'move' && typeof ev.cardId === 'string' && isKanbanColumn(ev.column)) {
    return { op: 'move', cardId: ev.cardId, column: ev.column, ts };
  }
  if (ev.op === 'remove' && typeof ev.cardId === 'string') {
    return { op: 'remove', cardId: ev.cardId, ts };
  }
  return null;
}

/** 重放事件流得到当前卡片列表（按创建时间排序） */
export function aggregateBoard(messages: RcMessage[]): KanbanCard[] {
  const events: KanbanEvent[] = [];
  for (const m of messages) {
    const ev = kanbanEventFromMessage(m);
    if (ev) events.push(ev);
  }
  events.sort((a, b) => a.ts - b.ts);
  const cards = new Map<string, KanbanCard>();
  for (const ev of events) {
    if (ev.op === 'create') {
      cards.set(ev.cardId, {
        id: ev.cardId,
        title: ev.title,
        column: ev.column,
        by: ev.by,
        ts: ev.ts,
        ...(ev.sourceMid ? { sourceMid: ev.sourceMid } : {}),
      });
    } else if (ev.op === 'move') {
      const card = cards.get(ev.cardId);
      if (card) card.column = ev.column;
    } else {
      cards.delete(ev.cardId);
    }
  }
  return [...cards.values()].sort((a, b) => a.ts - b.ts);
}

/** 事件消息的正文（官方客户端在话题里看到的人话） */
export function kanbanEventText(ev: { op: 'create' | 'move' | 'remove'; title?: string; column?: KanbanColumn }): string {
  if (ev.op === 'create') return `📋 新建看板卡片「${ev.title ?? ''}」`;
  if (ev.op === 'move') {
    const name = KANBAN_COLUMNS.find((c) => c.key === ev.column)?.name ?? '';
    return `📋 把卡片「${ev.title ?? ''}」移到 ${name}`;
  }
  return `📋 删除看板卡片「${ev.title ?? ''}」`;
}

export function kanbanEventAttachment(ev: Record<string, unknown>): RcMessageAttachment {
  return { type: KANBAN_EVENT_TYPE, text: '', ev };
}

/** 消息文本 → 卡片标题（收纳消息用）：去引用前缀与代理标记，压到 80 字 */
export function cardTitleFromMessage(m: RcMessage): string {
  const text = stripQuotePrefix(stripAgentSessionMarker(m.msg ?? '')).trim();
  const compact = text.replace(/\s+/g, ' ');
  return compact ? (compact.length > 80 ? `${compact.slice(0, 79)}…` : compact) : '（无文字消息）';
}
