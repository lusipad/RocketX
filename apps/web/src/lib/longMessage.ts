/**
 * 超长消息折叠的阈值，按「超过 N 屏」预估：
 * 视口高度按比例折算成行数（正文 text-sm + leading-relaxed ≈ 23px/行），
 * 再按气泡每行约 40 个字符折算字符数——屏幕越大阈值越宽松，
 * 小窗也不会把普通消息误折叠（下限 8 行）。
 * 折叠后只显示预览，点「展开全部」看全文；折叠开关与时机都在 设置 → 消息 里。
 */

/** 折叠时机：消息超过多少屏才折叠（默认半屏） */
export type LongMessageFoldAt = 'half' | 'one' | 'two';

const FOLD_SCREENS: Record<LongMessageFoldAt, number> = { half: 0.5, one: 1, two: 2 };
const LINE_HEIGHT_PX = 23;
const CHARS_PER_LINE = 40;
const MIN_LINES = 8;

/** 指定折叠时机下大约能放下的行数 */
export function longMessageLineLimit(
  viewportHeight: number,
  foldAt: LongMessageFoldAt = 'half',
): number {
  return Math.max(MIN_LINES, Math.floor((viewportHeight * FOLD_SCREENS[foldAt]) / LINE_HEIGHT_PX));
}

/** 指定折叠时机下大约能放下的字符数 */
export function longMessageCharLimit(
  viewportHeight: number,
  foldAt: LongMessageFoldAt = 'half',
): number {
  return longMessageLineLimit(viewportHeight, foldAt) * CHARS_PER_LINE;
}

export function isLongMessage(
  text: string,
  viewportHeight: number,
  foldAt: LongMessageFoldAt = 'half',
): boolean {
  if (text.length > longMessageCharLimit(viewportHeight, foldAt)) return true;
  const lineLimit = longMessageLineLimit(viewportHeight, foldAt);
  // 行数不可能超过字符数，短文本直接省掉逐字符扫描
  if (text.length <= lineLimit) return false;
  let lines = 1;
  for (const ch of text) {
    if (ch === '\n' && ++lines > lineLimit) return true;
  }
  return false;
}
