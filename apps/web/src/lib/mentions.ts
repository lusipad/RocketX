// @ 前允许中文（中文输入习惯不加空格：'你好@zhang'）
export const MENTION_RE = /(?:^|[\s一-鿿，。！？；：、])@([\w.\-]*)$/;

export function canMentionInRoom(roomType?: string): boolean {
  return roomType !== 'd';
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
  return canMentionInRoom(roomType) && !!mentionQuery?.trim();
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
