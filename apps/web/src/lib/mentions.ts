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
