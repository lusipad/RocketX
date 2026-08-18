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
  roomType?: string,
): boolean {
  // DM 不能拉新人进群，目录搜索（找群外的人）无意义，保持关闭
  return roomType !== 'd' && !!mentionQuery?.trim();
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
