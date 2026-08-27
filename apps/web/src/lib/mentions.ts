// @ 前允许中文（中文输入习惯不加空格：'你好@zhang'）
export const MENTION_RE = /(?:^|[\s一-鿿，。！？；：、])@([\w.\-]*)$/;

// issue #251 曾刻意排除 DM（当时一对一参与者已确定，@ 被视为多余）；
// issue #353 重新放开：DM 的成员拉取（im.members）与消息内 @ 高亮均已可用，
// 对所有房型返回 true。
export function canMentionInRoom(_roomType?: string): boolean {
  return true;
}

export function mentionQueryAtCursor(
  value: string,
  cursor: number,
  roomType?: string,
): string | null {
  if (!canMentionInRoom(roomType)) return null;
  return MENTION_RE.exec(value.slice(0, cursor))?.[1] ?? null;
}

export function shouldSearchMentionDirectory(
  mentionQuery: string | null,
  _roomType?: string,
): boolean {
  // 私聊也允许 @ 不在会话里的人。DM 拉不了人（RC 对 t='d' 的邀请会另建新会话），
  // 所以目录搜到的人只插入提及文本、不走发送前邀请，对方不会收到 @ 提醒；
  // 候选 UI 用「不在会话中」标识，与群聊的「非群成员」（会邀请）区分。
  return !!mentionQuery?.trim();
}

export function insertMentionAtCursor(
  value: string,
  cursor: number,
  username: string,
): { value: string; cursor: number } {
  const before = value.slice(0, cursor).replace(MENTION_RE, (full) =>
    full.startsWith('@') ? `@${username} ` : `${full[0]}@${username} `,
  );
  return {
    value: before + value.slice(cursor),
    cursor: before.length,
  };
}
